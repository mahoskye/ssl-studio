// The messages between the Bun process and the editor page. LSP traffic is
// one JSON-RPC message per Electrobun message, unframed.
import type { RPCSchema } from "electrobun/view";

export type StudioRPC = {
  bun: RPCSchema<{
    requests: {
      workspaceFile: { params: void; response: { uri: string; text: string } };
      workspaceBig: { params: void; response: string | null };
      report: { params: object; response: void };
      echo: { params: string; response: string };
    };
    messages: { lspSend: string };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: { lspReceive: string };
  }>;
};
