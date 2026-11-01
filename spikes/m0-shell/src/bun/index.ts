// M0 window spike: the editor page from spikes/m0-editor inside an Electrobun
// window, with starlims-lsp spawned here and bridged over Electrobun's RPC
// instead of a WebSocket server.
//
//   SPIKE_FILE=... BIG=... AUTOQUIT=1 hutch run start
import { BrowserView, BrowserWindow, Utils } from "electrobun/main";
import type { Subprocess } from "bun";
import type { StudioRPC } from "../shared/rpc";

const LSP =
  process.env.STARLIMS_LSP ??
  `${process.env.HOME}/dev/starlims-projects/ssl-style-guide/ssl-mcp-server/bin/lsp/starlims-lsp-linux-amd64`;
const spikes = process.env.SPIKES_DIR ?? `${process.env.HOME}/dev/starlims-projects/ssl-studio/spikes`;
const file = process.env.SPIKE_FILE ?? `${spikes}/m0-lsp/fixtures/Regions.ssl`;

let lsp: Subprocess<"pipe", "pipe", "inherit"> | undefined;

function startLsp() {
  lsp = Bun.spawn([LSP, "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  pump(lsp);
}

async function pump(process: Subprocess<"pipe", "pipe", "inherit">) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdout) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())![1]);
      if (buffer.length < headerEnd + 4 + length) break;
      rpc.send.lspReceive(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.subarray(headerEnd + 4 + length);
    }
  }
}

const rpc = BrowserView.defineRPC<StudioRPC>({
  maxRequestTime: 10_000,
  handlers: {
    requests: {
      workspaceFile: async () => ({ uri: `file://${file}`, text: await Bun.file(file).text() }),
      // A large local script for timing only; reports carry numbers, never its text.
      workspaceBig: async () => (process.env.BIG ? Bun.file(process.env.BIG).text() : null),
      echo: (text: string) => text,
      report: async (report: any) => {
        console.log("REPORT", JSON.stringify(report));
        await Bun.write(`${spikes}/m0-shell/reports/${report.engine}.json`, JSON.stringify(report, null, 2));
        if (process.env.AUTOQUIT) setTimeout(() => Utils.quit(), 500);
      },
    },
    messages: {
      lspSend: (text) => {
        if (!lsp) startLsp();
        const body = String(text);
        lsp!.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      },
    },
  },
});

new BrowserWindow({
  title: "SSL Studio spike",
  url: "views://mainview/index.html",
  rpc,
  frame: { width: 1200, height: 800, x: 120, y: 80 },
});

process.on("exit", () => lsp?.kill());
console.log(`window spike editing ${file}`);
