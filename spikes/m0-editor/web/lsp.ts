// A thin LSP client over a message transport, wired straight into Monaco's
// provider API. monaco-languageclient 11 needs the whole VS Code workbench
// API; this is what the IDE needs instead, and nothing about SSL is in it.
import * as monaco from "monaco-editor";

// One JSON-RPC message per call, without LSP's Content-Length framing.
export type LspTransport = {
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
};

type Pending = { resolve: (value: any) => void; reject: (error: any) => void };

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, (params: any) => void>();
  readonly timings: Record<string, number[]> = {};

  constructor(private transport: LspTransport) {
    transport.onMessage((text) => {
      const message = JSON.parse(text);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        message.error ? waiter.reject(message.error) : waiter.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        this.send({ id: message.id, result: null });
      } else if (message.method) {
        this.handlers.get(message.method)?.(message.params);
      }
    });
  }

  static connect(url: string): Promise<LspClient> {
    const socket = new WebSocket(url);
    const transport: LspTransport = {
      send: (text) => socket.send(text),
      onMessage: (handler) => socket.addEventListener("message", (event) => handler(event.data)),
    };
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(new LspClient(transport)));
      socket.addEventListener("error", reject);
    });
  }

  private send(message: object) {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  async request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const started = performance.now();
    this.send({ id, method, params });
    const result = await new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    (this.timings[method] ??= []).push(Math.round(performance.now() - started));
    return result;
  }

  on(method: string, handler: (params: any) => void) {
    this.handlers.set(method, handler);
  }
}

const toRange = (r: any) =>
  new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const toPosition = (p: monaco.Position) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const severity = [0, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];

// The formatter returns one edit replacing the whole range. Applying that
// moves markers and the cursor; trimming to the changed lines keeps them.
function minimalEdit(model: monaco.editor.ITextModel, range: monaco.Range, newText: string) {
  const oldLines = model.getValueInRange(range).split("\n");
  const newLines = newText.split("\n");
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++;
  if (head === oldLines.length && head === newLines.length) return [];
  const startLine = range.startLineNumber + head;
  const endLine = range.startLineNumber + oldLines.length - 1 - tail;
  const replaced = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
  return [{ range: replaced, text: newLines.slice(head, newLines.length - tail).join("\n") }];
}

export async function attach(client: LspClient, model: monaco.editor.ITextModel, rootUri: string) {
  const uri = model.uri.toString();
  const initialize = await client.request("initialize", {
    processId: null,
    rootUri,
    capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
  });
  client.notify("initialized", {});
  let version = 1;
  client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version, text: model.getValue() } });
  model.onDidChangeContent(() => {
    client.notify("textDocument/didChange", {
      textDocument: { uri, version: ++version },
      contentChanges: [{ text: model.getValue() }],
    });
  });

  const diagnostics = new Promise<number>((resolve) => {
    client.on("textDocument/publishDiagnostics", (params) => {
      if (params.uri !== uri) return;
      monaco.editor.setModelMarkers(model, "starlims-lsp", params.diagnostics.map((d: any) => ({
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        message: d.message,
        code: d.code,
        severity: severity[d.severity ?? 1],
        source: d.source,
      })));
      resolve(params.diagnostics.length);
    });
  });

  const doc = { textDocument: { uri } };
  monaco.languages.registerCompletionItemProvider("ssl", {
    triggerCharacters: [":", "."],
    async provideCompletionItems(m, position) {
      const word = m.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const result = await client.request("textDocument/completion", { ...doc, position: toPosition(position) });
      const items = (result?.items ?? result ?? []) as any[];
      return {
        suggestions: items.map((item) => ({
          label: item.label,
          kind: (item.kind ?? 1) - 1, // LSP kinds start at 1; Monaco's at 0 (close enough for a spike)
          detail: item.detail,
          documentation: item.documentation?.value ?? item.documentation,
          insertText: item.insertText ?? item.label,
          insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range,
        })),
      };
    },
  });
  monaco.languages.registerHoverProvider("ssl", {
    async provideHover(_m, position) {
      const hover = await client.request("textDocument/hover", { ...doc, position: toPosition(position) });
      if (!hover) return null;
      const value = typeof hover.contents === "string" ? hover.contents : hover.contents.value;
      return { contents: [{ value }], range: hover.range && toRange(hover.range) };
    },
  });
  monaco.languages.registerDefinitionProvider("ssl", {
    async provideDefinition(_m, position) {
      const result = await client.request("textDocument/definition", { ...doc, position: toPosition(position) });
      return (Array.isArray(result) ? result : result ? [result] : []).map((l: any) => ({
        uri: monaco.Uri.parse(l.uri),
        range: toRange(l.range),
      }));
    },
  });
  monaco.languages.registerFoldingRangeProvider("ssl", {
    async provideFoldingRanges() {
      const folds = (await client.request("textDocument/foldingRange", doc)) ?? [];
      return folds.map((f: any) => ({ start: f.startLine + 1, end: f.endLine + 1 }));
    },
  });
  monaco.languages.registerDocumentFormattingEditProvider("ssl", {
    async provideDocumentFormattingEdits(m, options) {
      const edits = (await client.request("textDocument/formatting", {
        ...doc,
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      })) ?? [];
      return edits.flatMap((e: any) => minimalEdit(m, toRange(e.range), e.newText));
    },
  });
  monaco.languages.registerDocumentSymbolProvider("ssl", {
    async provideDocumentSymbols() {
      return documentSymbols();
    },
  });

  async function documentSymbols() {
    const convert = (s: any): monaco.languages.DocumentSymbol => ({
      name: s.name,
      detail: s.detail ?? "",
      kind: s.kind - 1,
      tags: [],
      range: toRange(s.range),
      selectionRange: toRange(s.selectionRange),
      children: (s.children ?? []).map(convert),
    });
    return ((await client.request("textDocument/documentSymbol", doc)) ?? []).map(convert);
  }

  return { server: initialize.serverInfo, diagnostics, documentSymbols };
}
