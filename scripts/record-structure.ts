// Records the language server's document symbols and folding ranges for the
// fixtures into test/data, so blocks-mode tests run without the server.
//
//   STARLIMS_LSP=... bun scripts/record-structure.ts
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createFrameReader, frame } from "../src/bun/frames";
import { findLsp, lspCommand, verbatim } from "../src/bun/tools";

const compareCodepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const toPosixRelative = (base: string, path: string): string => relative(base, path).split("\\").join("/");

export function collectSslFiles(rootDir: string): string[] {
	const walk = (dir: string): string[] => {
		const found: string[] = [];
		for (const name of readdirSync(dir).sort(compareCodepoint)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (name.startsWith(".")) continue;
				found.push(...walk(full));
			} else if (name.endsWith(".ssl")) {
				found.push(full);
			}
		}
		return found;
	};
	return walk(rootDir).sort((a, b) => compareCodepoint(toPosixRelative(rootDir, a), toPosixRelative(rootDir, b)));
}

export async function recordStructure(opts: { rootDir?: string; lspCommand?: string[]; lspVersion?: string } = {}) {
	const root = opts.rootDir ?? join(import.meta.dir, "../fixtures/workspace");
	let cmd = opts.lspCommand;
	let version = opts.lspVersion;
	if (!cmd) {
		const lsp = await findLsp();
		if (!lsp.path) throw new Error(lsp.message);
		cmd = lspCommand(lsp.path, ["--stdio"]);
		version = lsp.version;
	}
	const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", windowsVerbatimArguments: verbatim(cmd) });
	const pending = new Map<number, { resolve: (v: any) => void; reject: (err: Error) => void }>();
	let closing = false;
	let exitedError: Error | null = null;
	const rejectAll = (err: Error) => {
		for (const entry of pending.values()) entry.reject(err);
		pending.clear();
	};
	const read = createFrameReader((body) => {
		const m = JSON.parse(body);
		if (m.id === undefined) return;
		const entry = pending.get(m.id);
		if (!entry) return;
		pending.delete(m.id);
		if (m.error) {
			const detail = typeof m.error === "object" && m.error !== null && "message" in m.error ? String(m.error.message) : JSON.stringify(m.error);
			entry.reject(new Error(`LSP error (${m.error?.code ?? "unknown"}): ${detail}`));
		} else {
			entry.resolve(m.result);
		}
	});
	void (async () => {
		try {
			for await (const chunk of proc.stdout) read(chunk);
		} catch (err) {
			if (!closing) {
				exitedError = err instanceof Error ? err : new Error(String(err));
				rejectAll(exitedError);
			}
		}
	})();
	void proc.exited.then((code) => {
		if (closing) return;
		exitedError = new Error(`starlims-lsp exited unexpectedly with code ${code}`);
		rejectAll(exitedError);
	});
	let id = 0;
	const request = (method: string, params: unknown) =>
		new Promise<any>((resolve, reject) => {
			if (exitedError) {
				reject(exitedError);
				return;
			}
			const reqId = ++id;
			pending.set(reqId, { resolve, reject });
			try {
				proc.stdin.write(frame(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params })));
			} catch (err) {
				pending.delete(reqId);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	const notify = (method: string, params: unknown) => proc.stdin.write(frame(JSON.stringify({ jsonrpc: "2.0", method, params })));

	try {
		await request("initialize", {
			processId: null,
			rootUri: pathToFileURL(root).href,
			capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
		});
		notify("initialized", {});
		const out: Record<string, unknown> = {};
		for (const path of collectSslFiles(root)) {
			const uri = pathToFileURL(path).href;
			const text = await Bun.file(path).text();
			notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text } });
			out[toPosixRelative(root, path)] = {
				text,
				symbols: await request("textDocument/documentSymbol", { textDocument: { uri } }),
				folds: await request("textDocument/foldingRange", { textDocument: { uri } }),
			};
		}
		return { server: version, files: out };
	} finally {
		closing = true;
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	}
}

if (import.meta.main) {
	const data = await recordStructure();
	await Bun.write(join(import.meta.dir, "../test/data/structure.json"), JSON.stringify(data, null, 1));
	console.log(`recorded ${Object.keys(data.files).length} files with starlims-lsp ${data.server}`);
}
