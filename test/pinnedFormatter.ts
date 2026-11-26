// The pinned language server's formatter, for the tests that rest on its answers: asked for real, over its
// standard streams. `pinnedServer` is null where that server is not on this machine, and such tests skip.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LSP_PIN } from "../src/bun/tools";
import { applyTextEdits } from "../src/view/lsp/edits";

export function pinnedServer(): string | null {
	const suffix = process.platform === "win32" ? ".exe" : "";
	for (const path of [process.env.STARLIMS_LSP, join(import.meta.dir, "..", "vendor", `starlims-lsp${suffix}`)]) {
		if (!path || !existsSync(path)) continue;
		try {
			if (/starlims-lsp version (\S+)/.exec(Bun.spawnSync([path, "--version"]).stdout.toString())?.[1] === LSP_PIN) return path;
		} catch {
			// Not a program this system can start.
		}
	}
	return null;
}

/** The language server over its standard streams, asked to format one text at a time. */
export function formatter(path: string) {
	const child = spawn(path, ["--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
	let buffer = Buffer.alloc(0);
	let next = 0;
	const waiting = new Map<number, (message: any) => void>();
	const send = (message: object) => {
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
		child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
	};
	child.stdout.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const head = buffer.indexOf("\r\n\r\n");
			if (head < 0) return;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, head).toString())?.[1]);
			if (buffer.length < head + 4 + length) return;
			const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString());
			buffer = buffer.subarray(head + 4 + length);
			if (message.id !== undefined && message.method) send({ id: message.id, result: null });
			else if (message.id !== undefined) waiting.get(message.id)?.(message);
		}
	});
	const request = (method: string, params: object) =>
		new Promise<any>((done, failed) => {
			const id = ++next;
			const timer = setTimeout(() => failed(new Error(`the language server did not answer ${method}`)), 15_000);
			waiting.set(id, (message) => {
				clearTimeout(timer);
				waiting.delete(id);
				if (message.error) failed(new Error(JSON.stringify(message.error)));
				else done(message.result);
			});
			send({ id, method, params });
		});
	let count = 0;
	const started = request("initialize", { processId: null, rootUri: "file:///ws", capabilities: {} }).then(() => send({ method: "initialized", params: {} }));
	return {
		/** As `LspSession.formatText` does it: the text opened under a name of its own, formatted, closed. */
		async format(text: string, ending = ".ssl"): Promise<string> {
			await started;
			const uri = `file:///ws/.ssl-studio/format-${++count}${ending}`;
			send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "ssl", version: 1, text } } });
			const edits = (await request("textDocument/formatting", { textDocument: { uri }, options: { tabSize: 4, insertSpaces: false } })) ?? [];
			send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
			return applyTextEdits(text, edits);
		},
		/** What the server read as SSL in a text of the given name: its `ssl/lexicalTokens`. */
		async lexical(text: string, ending = ".ssl"): Promise<{ kind: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }[]> {
			await started;
			const uri = `file:///ws/.ssl-studio/lexical-${++count}${ending}`;
			send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "ssl", version: 1, text } } });
			const answer = await request("ssl/lexicalTokens", { textDocument: { uri } });
			send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
			return answer?.tokens ?? [];
		},
		stop: () => void child.kill(),
	};
}
