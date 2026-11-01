// The Electrobun host for the m0-editor page: everything over Electrobun RPC.
import { Electroview } from "electrobun/view";
import { LspClient } from "../../../m0-editor/web/lsp";
import { run } from "../../../m0-editor/web/selfcheck";
import type { StudioRPC } from "../shared/rpc";

const listeners: ((text: string) => void)[] = [];
const rpc = Electroview.defineRPC<StudioRPC>({
  maxRequestTime: 10_000,
  handlers: { messages: { lspReceive: (text) => listeners.forEach((listener) => listener(text)) } },
});
new Electroview({ rpc });

// RPC cost by payload size, round trip, median of five: LSP replies for a
// large script are hundreds of kilobytes.
async function echoTimings() {
  const result: Record<string, number> = {};
  for (const kb of [1, 100, 1000]) {
    const text = "x".repeat(kb * 1024);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      await rpc.request.echo(text);
      samples.push(performance.now() - started);
    }
    result[`${kb}KB`] = Math.round(samples.sort((a, b) => a - b)[2]);
  }
  return result;
}

run({
  engine: "electrobun-webkitgtk",
  file: () => rpc.request.workspaceFile(),
  big: () => rpc.request.workspaceBig(),
  report: async (report) => rpc.request.report({ ...report, rpcEchoMs: await echoTimings() }),
  lsp: async () =>
    new LspClient({ send: (text) => rpc.send.lspSend(text), onMessage: (handler) => listeners.push(handler) }),
});
