// Records the language server's document symbols and folding ranges for the
// fixtures into test/data, so blocks-mode tests run without the server.
//
//   STARLIMS_LSP=... bun scripts/record-structure.ts
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createFrameReader, frame } from "../src/bun/frames";
import { findLsp } from "../src/bun/tools";

const root = join(import.meta.dir, "../fixtures/workspace");
const lsp = await findLsp();
if (!lsp.path) throw new Error(lsp.message);
const proc = Bun.spawn([lsp.path, "--stdio"], { stdin: "pipe", stdout: "pipe" });
const pending = new Map<number, (v: any) => void>();
const read = createFrameReader((body) => {
	const m = JSON.parse(body);
	if (m.id !== undefined && pending.has(m.id)) (pending.get(m.id)!(m.result), pending.delete(m.id));
});
(async () => {
	for await (const chunk of proc.stdout) read(chunk);
})();
let id = 0;
const request = (method: string, params: unknown) =>
	new Promise<any>((resolve) => {
		pending.set(++id, resolve);
		proc.stdin.write(frame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
	});
const notify = (method: string, params: unknown) => proc.stdin.write(frame(JSON.stringify({ jsonrpc: "2.0", method, params })));

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ssl") ? [join(dir, f)] : []));
await request("initialize", { processId: null, rootUri: `file://${root}`, capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } } });
notify("initialized", {});
const out: Record<string, unknown> = {};
for (const path of files(root)) {
	const uri = `file://${path}`;
	const text = await Bun.file(path).text();
	notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text } });
	out[relative(root, path)] = {
		text,
		symbols: await request("textDocument/documentSymbol", { textDocument: { uri } }),
		folds: await request("textDocument/foldingRange", { textDocument: { uri } }),
	};
}
await Bun.write(join(import.meta.dir, "../test/data/structure.json"), JSON.stringify({ server: lsp.version, files: out }, null, 1));
proc.kill();
console.log(`recorded ${Object.keys(out).length} files with starlims-lsp ${lsp.version}`);
