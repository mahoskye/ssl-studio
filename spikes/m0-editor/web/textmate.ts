// Highlighting from the formatter extension's TextMate grammar, coloured by
// a VS Code theme file.
//
// Spike shortcut: each token takes its innermost scope as its Monaco token
// type, and theme scopes become Monaco rules, which match by dotted prefix.
// That covers simple selectors ("keyword.control") but not descendant ones
// ("source.ssl string"). The app should use tokenizeLine2's encoded tokens
// with the registry's colour map instead.
import * as monaco from "monaco-editor";
import * as oniguruma from "vscode-oniguruma";
import { INITIAL, Registry, type IGrammar, type StateStack } from "vscode-textmate";

class TextMateState implements monaco.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone() {
    return new TextMateState(this.stack);
  }
  equals(other: monaco.languages.IState) {
    return other instanceof TextMateState && other.stack.equals(this.stack);
  }
}

export async function loadGrammar(): Promise<IGrammar> {
  const wasm = await fetch("./onig.wasm").then((r) => r.arrayBuffer());
  await oniguruma.loadWASM(wasm);
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (text) => new oniguruma.OnigString(text),
    }),
    loadGrammar: async (scopeName) =>
      scopeName === "source.ssl" ? await fetch("./grammar/ssl.tmLanguage.json").then((r) => r.json()) : null,
  });
  const grammar = await registry.loadGrammar("source.ssl");
  if (!grammar) throw new Error("grammar source.ssl did not load");
  return grammar;
}

export function registerHighlighting(grammar: IGrammar) {
  monaco.languages.register({ id: "ssl", extensions: [".ssl", ".srvscr"] });
  monaco.languages.setTokensProvider("ssl", {
    getInitialState: () => new TextMateState(INITIAL),
    tokenize(line, state: TextMateState) {
      const result = grammar.tokenizeLine(line, state.stack);
      return {
        endState: new TextMateState(result.ruleStack),
        tokens: result.tokens.map((t) => ({ startIndex: t.startIndex, scopes: t.scopes[t.scopes.length - 1] })),
      };
    },
  });
}

type VsCodeTheme = {
  name: string;
  type: "dark" | "light";
  colors: Record<string, string>;
  tokenColors: { scope?: string | string[]; settings: { foreground?: string; fontStyle?: string } }[];
};

export function importVsCodeTheme(id: string, theme: VsCodeTheme) {
  const rules = theme.tokenColors.flatMap(({ scope, settings }) =>
    [scope ?? ""].flat().flatMap((s) => s.split(",")).map((s) => ({
      token: s.trim(),
      foreground: settings.foreground?.replace("#", ""),
      fontStyle: settings.fontStyle,
    })),
  );
  monaco.editor.defineTheme(id, {
    base: theme.type === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules,
    colors: theme.colors,
  });
  return rules.length;
}
