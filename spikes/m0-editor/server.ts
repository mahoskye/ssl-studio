// M0 spike: serves the editor page and bridges each WebSocket to its own
// starlims-lsp --stdio process. In the app, Electrobun's RPC replaces the
// WebSocket; nothing else changes.
//
//   bunx vite build && bun server.ts [workspace-file.ssl]
import { resolve } from "node:path";
import type { ServerWebSocket, Subprocess } from "bun";

const LSP =
  process.env.STARLIMS_LSP ??
  `${process.env.HOME}/dev/starlims-projects/ssl-style-guide/ssl-mcp-server/bin/lsp/starlims-lsp-linux-amd64`;
const file = resolve(process.argv[2] ?? `${import.meta.dir}/../m0-lsp/fixtures/Regions.ssl`);
const dist = `${import.meta.dir}/dist`;
const port = Number(process.env.PORT ?? 5180);

type Socket = ServerWebSocket<{ lsp?: Subprocess<"pipe", "pipe", "inherit"> }>;

function frame(body: string) {
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

async function pump(ws: Socket, lsp: Subprocess<"pipe", "pipe", "inherit">) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of lsp.stdout) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())![1]);
      if (buffer.length < headerEnd + 4 + length) break;
      ws.send(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.subarray(headerEnd + 4 + length);
    }
  }
}

Bun.serve<{ lsp?: Subprocess<"pipe", "pipe", "inherit"> }>({
  hostname: "127.0.0.1",
  port,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/lsp") {
      return server.upgrade(req, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/workspace/file") {
      return Response.json({ uri: `file://${file}`, text: await Bun.file(file).text() });
    }
    if (url.pathname === "/workspace/big") {
      // A large local script for timing only; reports carry numbers, never its text.
      return process.env.BIG ? new Response(Bun.file(process.env.BIG)) : new Response("unset", { status: 404 });
    }
    if (url.pathname === "/report" && req.method === "POST") {
      const report = await req.json();
      console.log("REPORT", JSON.stringify(report));
      await Bun.write(`${import.meta.dir}/reports/${report.engine}.json`, JSON.stringify(report, null, 2));
      return new Response("ok");
    }
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const asset = Bun.file(dist + path);
    return (await asset.exists()) ? new Response(asset) : new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws: Socket) {
      const lsp = Bun.spawn([LSP, "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
      ws.data.lsp = lsp;
      pump(ws, lsp);
    },
    message(ws: Socket, message) {
      ws.data.lsp?.stdin.write(frame(String(message)));
    },
    close(ws: Socket) {
      ws.data.lsp?.kill();
    },
  },
});

console.log(`editor spike on http://localhost:${port}/ editing ${file}`);
