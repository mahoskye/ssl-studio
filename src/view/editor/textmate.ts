// SSL highlighting from the formatter extension's TextMate grammar, coloured
// by the active theme with vscode-textmate's own theme matching, so VS Code
// themes (descendant selectors included) colour exactly as in VS Code.
//
// Each token's Monaco type is its resolved style, `c<colour id>.<font style>`,
// and the Monaco theme gets one rule per colour id from the registry's
// colour map. Changing theme rebuilds both.
import * as oniguruma from "vscode-oniguruma";
import { INITIAL, Registry, type IGrammar, type IRawTheme, type StateStack } from "vscode-textmate";
import { monaco } from "./monaco";

// vscode-textmate 9's encoded token attributes (not exported by the package).
const TOKEN_TYPE = (m: number) => (m & 0x00000300) >>> 8;
const FONT_STYLE = (m: number) => (m & 0x00007800) >>> 11;
const FOREGROUND = (m: number) => (m & 0x00ff8000) >>> 15;
export const COMMENT_TOKEN = 1;

class State implements monaco.languages.IState {
	constructor(readonly stack: StateStack) {}
	clone() {
		return new State(this.stack);
	}
	equals(other: monaco.languages.IState) {
		return other instanceof State && other.stack.equals(this.stack);
	}
}

let registry: Registry;
let grammar: IGrammar;

export async function loadGrammar() {
	await oniguruma.loadWASM({ data: await (await fetch("./onig.wasm")).arrayBuffer() });
	registry = new Registry({
		onigLib: Promise.resolve({
			createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
			createOnigString: (text) => new oniguruma.OnigString(text),
		}),
		loadGrammar: async (scope) => (scope === "source.ssl" ? fetch("./grammar/ssl.tmLanguage.json").then((r) => r.json()) : null),
	});
	grammar = (await registry.loadGrammar("source.ssl"))!;
	return grammar;
}

/** Applies a theme's token colours; returns Monaco rules for `defineTheme`. */
export function applyTokenTheme(theme: IRawTheme): monaco.editor.ITokenThemeRule[] {
	registry.setTheme(theme);
	const colors = registry.getColorMap();
	const rules: monaco.editor.ITokenThemeRule[] = [];
	colors.forEach((color, id) => {
		if (!color) return;
		for (let style = 0; style < 16; style++) {
			const fontStyle = [style & 1 && "italic", style & 2 && "bold", style & 4 && "underline", style & 8 && "strikethrough"]
				.filter(Boolean)
				.join(" ");
			rules.push({ token: `c${id}.${style}`, foreground: color.replace("#", ""), fontStyle });
		}
	});
	// Re-registering makes Monaco tokenize every model again with the new map.
	monaco.languages.setTokensProvider("ssl", {
		getInitialState: () => new State(INITIAL),
		tokenize(line, state: State) {
			const result = grammar.tokenizeLine2(line, state.stack, 500);
			const tokens: monaco.languages.IToken[] = [];
			for (let i = 0; i < result.tokens.length; i += 2) {
				const m = result.tokens[i + 1]!;
				tokens.push({ startIndex: result.tokens[i]!, scopes: `c${FOREGROUND(m)}.${FONT_STYLE(m)}` });
			}
			return { tokens, endState: new State(result.ruleStack) };
		},
	});
	return rules;
}

/**
 * Size facts for the meter (program decision 0006), from the grammar alone:
 * code lines are lines with a non-blank token the grammar does not mark as a
 * comment; the banner is the run of comment and blank lines the file opens with.
 */
export function measure(text: string): { codeLines: number; bannerLines: string[] } {
	let stack = INITIAL;
	let codeLines = 0;
	let bannerEnd = -1;
	const lines = text.split(/\r?\n/);
	lines.forEach((line, index) => {
		const result = grammar.tokenizeLine2(line, stack, 500);
		stack = result.ruleStack;
		for (let i = 0; i < result.tokens.length; i += 2) {
			const start = result.tokens[i]!;
			const end = i + 2 < result.tokens.length ? result.tokens[i + 2]! : line.length;
			if (TOKEN_TYPE(result.tokens[i + 1]!) !== COMMENT_TOKEN && line.slice(start, end).trim()) {
				codeLines++;
				if (bannerEnd < 0) bannerEnd = index;
				break;
			}
		}
	});
	return { codeLines, bannerLines: lines.slice(0, bannerEnd < 0 ? lines.length : bannerEnd) };
}
