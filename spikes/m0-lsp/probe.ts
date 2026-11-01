// M0 spike: can Bun drive starlims-lsp over stdio, and what does the server
// give an IDE today? Run: bun spikes/m0-lsp/probe.ts [fixture.ssl]
import { spawn } from "bun";
import { resolve } from "node:path";

const LSP =
  process.env.STARLIMS_LSP ??
  `${process.env.HOME}/dev/starlims-projects/ssl-style-guide/ssl-mcp-server/bin/lsp/starlims-lsp-linux-amd64`;
const fixture = resolve(process.argv[2] ?? `${import.meta.dir}/fixtures/Regions.ssl`);
const uri = `file://${fixture}`;
const text = await Bun.file(fixture).text();

const server = spawn([LSP, "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; started: number; method: string }>();
const notifications: { method: string; params: any }[] = [];

function send(message: object) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, { resolve, started: performance.now(), method }));
}

const timings: Record<string, number> = {};

// Reads Content-Length framed messages off the server's stdout.
(async () => {
  let buffer = Buffer.alloc(0);
  for await (const chunk of server.stdout) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())![1]);
      if (buffer.length < headerEnd + 4 + length) break;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.subarray(headerEnd + 4 + length);
      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        timings[waiter.method] = Math.round((performance.now() - waiter.started) * 10) / 10;
        waiter.resolve(message.error ? { error: message.error } : message.result);
      } else if (message.method) {
        if (message.id !== undefined) send({ id: message.id, result: null }); // server→client requests
        else notifications.push(message);
      }
    }
  }
})();

const init = await request("initialize", {
  processId: process.pid,
  rootUri: `file://${resolve(fixture, "..")}`,
  capabilities: {
    textDocument: {
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      foldingRange: { lineFoldingOnly: false },
    },
  },
});
send({ method: "initialized", params: {} });
send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "ssl", version: 1, text } } });

const doc = { textDocument: { uri } };
const line = (needle: string) => text.split("\n").findIndex((l) => l.includes(needle));
const symbols = await request("textDocument/documentSymbol", doc);
const folds = await request("textDocument/foldingRange", doc);
const formatting = await request("textDocument/formatting", { ...doc, options: { tabSize: 4, insertSpaces: true } });
const hover = await request("textDocument/hover", { ...doc, position: { line: line("Empty(sSampleId)"), character: 5 } });
const completion = await request("textDocument/completion", { ...doc, position: { line: line(":RETURN sLabel"), character: 1 } });
const definition = await request("textDocument/definition", { ...doc, position: { line: line("sLabel :="), character: 6 } });
const rangeFormatting = await request("textDocument/rangeFormatting", {
  ...doc,
  range: { start: { line: line(":PROCEDURE IsUsableId"), character: 0 }, end: { line: line(":ENDPROC"), character: 9 } },
  options: { tabSize: 4, insertSpaces: true },
});
await Bun.sleep(300); // let diagnostics arrive

function outline(items: any[], depth = 0): string[] {
  return items.flatMap((s) => [
    `${"  ".repeat(depth)}${s.name} (kind ${s.kind}) lines ${s.range.start.line + 1}-${s.range.end.line + 1}`,
    ...outline(s.children ?? [], depth + 1),
  ]);
}

const caps = init.capabilities;
console.log(JSON.stringify({
  server: init.serverInfo,
  capabilities: Object.keys(caps).sort(),
  customCommands: caps.executeCommandProvider?.commands ?? [],
  semanticTokens: Boolean(caps.semanticTokensProvider),
  outline: process.env.QUIET ? `${outline(symbols).length} symbols` : outline(symbols),
  folds: process.env.QUIET ? `${folds.length} folds` : folds.map((f: any) => `${f.startLine + 1}-${f.endLine + 1}${f.kind ? ` ${f.kind}` : ""}`),
  formattingEdits: formatting?.map((e: any) => `lines ${e.range.start.line + 1}-${e.range.end.line + 1}, ${e.newText.length} chars`),
  rangeFormattingEdits: rangeFormatting?.map?.((e: any) => `lines ${e.range.start.line + 1}-${e.range.end.line + 1}, ${e.newText.length} chars`) ?? rangeFormatting,
  documentChars: text.length,
  hover: process.env.QUIET ? Boolean(hover) : JSON.stringify(hover?.contents ?? hover).slice(0, 160),
  completionItems: (completion?.items ?? completion)?.length,
  definition: process.env.QUIET ? Boolean(definition) : definition,
  diagnostics: process.env.QUIET ? notifications.filter((n) => n.method === "textDocument/publishDiagnostics").reduce((n, d) => n + d.params.diagnostics.length, 0) : notifications
    .filter((n) => n.method === "textDocument/publishDiagnostics")
    .flatMap((n) => n.params.diagnostics.map((d: any) => `${d.range.start.line + 1}: ${d.code} ${d.message}`)),
  timingsMs: timings,
}, null, 2));

await request("shutdown", null);
send({ method: "exit" });
