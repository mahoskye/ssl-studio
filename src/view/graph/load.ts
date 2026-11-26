// Collects graph mode's input from the language server, a few requests at a time.
import { monaco } from "../editor/monaco";
import { session } from "../lsp/session";
import { backend } from "../backend";
import { assemble, fromCallGraph, procId, type CallIn, type Graph, type ProcIn, type ScriptIn } from "./model";

const PROCEDURE = new Set([monaco.languages.SymbolKind.Function, monaco.languages.SymbolKind.Method]);
const MAX_PROCEDURES = 3000;

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) {
		throw signal.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" });
	}
}

/** A JSON-RPC error from a running server affects one item; transport/session disconnects must propagate. */
const isServerItemError = (err: unknown) => Boolean(err && typeof err === "object" && typeof (err as { code?: unknown }).code === "number");

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>, signal?: AbortSignal) {
	let next = 0;
	let failed = false;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length && !failed && !signal?.aborted) {
				try {
					await work(items[next++]!);
				} catch (err) {
					failed = true;
					throw err;
				}
			}
		}),
	);
}

export async function loadGraph(progress: (done: number, total: number) => void, signal?: AbortSignal): Promise<Graph & { truncated: boolean }> {
	throwIfAborted(signal);
	await session.waitReady();
	throwIfAborted(signal);
	if (session.supports("ssl/callGraph")) {
		// One request (L2): data sources, :INCLUDEs and unresolved targets too.
		progress(0, 1);
		const result = await session.request("ssl/callGraph", {});
		throwIfAborted(signal);
		progress(1, 1);
		const toPath = (uri: string) => monaco.Uri.parse(uri).fsPath;
		const scratch = (path: string) => /[\\/]\.ssl-studio[\\/]/.test(path);
		const scriptPaths = (result?.nodes ?? []).filter((n: any) => n.kind === "script" && n.location?.uri).map((n: any) => toPath(n.location.uri)).filter((path: string) => !scratch(path));
		const sizes = new Map(Object.entries(await backend.sizes(scriptPaths).catch(() => ({}))));
		throwIfAborted(signal);
		// Calls and class relations alike are the server's (L2, L4): nothing of a file is read here.
		const graph = fromCallGraph({ nodes: result?.nodes ?? [], edges: result?.edges ?? [] }, toPath, sizes, scratch);
		// While the server is still indexing, calls into unindexed files show as unresolved.
		return { ...graph, truncated: Boolean(result?.indexing) };
	}
	const symbols = await session.workspaceSymbols("");
	throwIfAborted(signal);
	const uris = [...new Set(symbols.filter((s) => s.kind === 12 || s.kind === 6).map((s) => s.location.uri))];
	const scripts: ScriptIn[] = [];
	const targets: { uri: string; id: string; line: number; character: number }[] = [];
	await pool(
		uris,
		6,
		async (uri) => {
			if (signal?.aborted) return;
			const model = await session.ensureModel(uri);
			if (!model || signal?.aborted) return;
			const path = model.uri.fsPath;
			const procedures: ProcIn[] = [];
			const walk = (list: monaco.languages.DocumentSymbol[], region?: string) => {
				for (const s of list) {
					if (s.kind === monaco.languages.SymbolKind.Namespace) walk(s.children ?? [], s.name);
					else if (PROCEDURE.has(s.kind)) {
						procedures.push({ name: s.name, region, startLine: s.range.startLineNumber - 1, endLine: s.range.endLineNumber - 1 });
						targets.push({ uri, id: procId(path, s.name), line: s.selectionRange.startLineNumber - 1, character: s.selectionRange.startColumn - 1 });
					} else walk(s.children ?? [], region);
				}
			};
			const docSymbols = await session.documentSymbols(model).catch((err) => {
				if (isServerItemError(err)) return [];
				throw err;
			});
			// The file may have gone while the server was asked, and its model with it.
			if (model.isDisposed() || signal?.aborted) return;
			walk(docSymbols);
			scripts.push({ path, bytes: new TextEncoder().encode(model.getValue()).length, procedures });
		},
		signal,
	);
	throwIfAborted(signal);
	const truncated = targets.length > MAX_PROCEDURES;
	const calls: CallIn[] = [];
	let done = 0;
	await pool(
		targets.slice(0, MAX_PROCEDURES),
		8,
		async (t) => {
			if (signal?.aborted) return;
			const refs = (await session
				.request("textDocument/references", { textDocument: { uri: t.uri }, position: { line: t.line, character: t.character }, context: { includeDeclaration: false } })
				.catch((err) => {
					if (isServerItemError(err)) return [];
					throw err;
				})) as { uri: string; range: { start: { line: number } } }[];
			if (signal?.aborted) return;
			for (const r of refs ?? []) calls.push({ callee: t.id, path: monaco.Uri.parse(r.uri).fsPath, line: r.range.start.line });
			progress(++done, Math.min(targets.length, MAX_PROCEDURES));
		},
		signal,
	);
	throwIfAborted(signal);
	scripts.sort((a, b) => a.path.localeCompare(b.path));
	return { ...assemble(scripts, calls), truncated };
}
