// The browser-tab host: everything over HTTP and a WebSocket to server.ts.
import { LspClient } from "./lsp";
import { run } from "./selfcheck";

run({
  engine: new URLSearchParams(location.search).get("engine") ?? "unknown",
  file: () => fetch("/workspace/file").then((r) => r.json()),
  big: async () => {
    const response = await fetch("/workspace/big");
    return response.ok ? response.text() : null;
  },
  report: async (report) => {
    await fetch("/report", { method: "POST", body: JSON.stringify(report) });
  },
  lsp: () => LspClient.connect(`ws://${location.host}/lsp`),
});
