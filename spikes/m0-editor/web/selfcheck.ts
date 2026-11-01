// M0 editor spike: Monaco + TextMate grammar + VS Code theme + starlims-lsp,
// and a rough Objects panel. After loading it checks itself and reports to
// its host, so the same page can be compared across engines and shells.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { attach, type LspClient } from "./lsp";
import { importVsCodeTheme, loadGrammar, registerHighlighting } from "./textmate";
import theme from "../themes/spike-dark.json";
import { INITIAL } from "vscode-textmate";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// What the page needs from whatever serves it: a browser tab talking HTTP
// (main.ts) or the Electrobun window talking RPC (spikes/m0-shell).
export type Host = {
  engine: string;
  file(): Promise<{ uri: string; text: string }>;
  big(): Promise<string | null>;
  report(report: object): Promise<void>;
  lsp(): Promise<LspClient>;
};

const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason?.message ?? e.reason)));

const timings: Record<string, number> = {};
async function timed<T>(name: string, work: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  const result = await work();
  timings[name] = Math.round(performance.now() - started);
  return result;
}

const SYMBOL_ICONS: Record<number, string> = { 2: "▣", 11: "ƒ", 12: "ƒ", 13: "·" };

function renderObjects(symbols: monaco.languages.DocumentSymbol[], editor: monaco.editor.IStandaloneCodeEditor) {
  const panel = document.getElementById("objects")!;
  panel.replaceChildren();
  const add = (s: monaco.languages.DocumentSymbol, depth: number) => {
    const row = document.createElement("button");
    row.className = `object kind-${s.kind}`;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const lines = s.range.endLineNumber - s.range.startLineNumber + 1;
    row.textContent = `${SYMBOL_ICONS[s.kind] ?? "•"} ${s.name}`;
    row.title = `${lines} lines`;
    row.onclick = () => {
      editor.revealRangeAtTop(s.range);
      editor.setSelection(s.selectionRange);
      editor.focus();
    };
    panel.append(row);
    s.children?.forEach((c) => add(c, depth + 1));
  };
  symbols.forEach((s) => add(s, 0));
}

async function main(host: Host) {
  const engine = host.engine;
  const grammar = await timed("grammarLoad", loadGrammar);
  registerHighlighting(grammar);
  const themeRules = importVsCodeTheme("spike-dark", theme as any);

  const { uri, text } = await host.file();
  const model = monaco.editor.createModel(text, "ssl", monaco.Uri.parse(uri));
  const editor = await timed("editorCreate", () =>
    monaco.editor.create(document.getElementById("editor")!, {
      model,
      theme: "spike-dark",
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 13,
    }),
  );

  const client = await host.lsp();
  const session = await timed("lspAttach", () => attach(client, model, uri.replace(/\/[^/]+$/, "")));
  const symbols = await timed("documentSymbols", session.documentSymbols);
  renderObjects(symbols, editor);
  model.onDidChangeContent(debounce(async () => renderObjects(await session.documentSymbols(), editor), 300));

  // Self-checks.
  await new Promise((r) => setTimeout(r, 500));
  const tokenClasses = new Set(
    [...document.querySelectorAll(".view-lines span span[class*='mtk']")].map((e) => e.className),
  );
  const lineOf = (needle: string) => model.getLinesContent().findIndex((l) => l.includes(needle)) + 1;
  const completion = await timed("completion", () =>
    client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: lineOf(":RETURN sLabel") - 1, character: 1 },
    }),
  );
  const hover = await timed("hover", () =>
    client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: lineOf("Empty(sSampleId)") - 1, character: 5 },
    }),
  );
  const formatEdits = await timed("format", async () => {
    const before = model.getValue();
    await editor.getAction("editor.action.formatDocument")!.run();
    return { changed: model.getValue() !== before, undoable: model.canUndo() };
  });
  const diagnostics = await Promise.race([session.diagnostics, new Promise((r) => setTimeout(() => r("none in 3s"), 3000))]);

  let bigFile: Record<string, number> | string = "not requested";
  const bigText = await host.big();
  if (bigText !== null) {
    const lines = bigText.split("\n");
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    // Tokenizing the whole file is pure JS work: a fair engine comparison.
    await timed("bigTokenizeAll", () => {
      let stack: any = INITIAL;
      for (const line of lines) stack = grammar.tokenizeLine(line, stack).ruleStack;
    });
    const bigModel = monaco.editor.createModel(bigText, "ssl", monaco.Uri.parse("inmemory://big.ssl"));
    await timed("bigSetModel", () => editor.setModel(bigModel));
    await timed("bigFirstFrame", frame);
    await timed("bigScroll30Frames", async () => {
      for (let i = 0; i < 30; i++) {
        editor.setScrollTop(i * 4000);
        await frame();
      }
    });
    bigFile = { lines: lines.length, scrollFrameMs: Math.round(timings.bigScroll30Frames / 30) };
    editor.setModel(model);
    bigModel.dispose();
  }

  const report = {
    engine,
    visibility: document.visibilityState,
    userAgent: navigator.userAgent,
    server: session.server,
    themeRules,
    distinctTokenClasses: tokenClasses.size,
    objects: symbols.length,
    completionItems: (completion?.items ?? completion)?.length,
    hover: Boolean(hover),
    format: formatEdits,
    diagnostics,
    folding: editor.getContribution("editor.contrib.folding") ? "contrib present" : "missing",
    workerOk: !errors.some((e) => /worker/i.test(e)),
    bigFile,
    timingsMs: timings,
    lspRoundTripsMs: client.timings,
    errors,
  };
  document.getElementById("status")!.textContent = `self-check: ${errors.length ? errors.length + " errors" : "ok"}`;
  await host.report(report);
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function run(host: Host) {
  main(host).catch(async (e) => {
    errors.push(String(e?.stack ?? e));
    document.getElementById("status")!.textContent = `failed: ${e?.message ?? e}`;
    await host.report({ engine: `${host.engine}-failed`, errors });
  });
}
