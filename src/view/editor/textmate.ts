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
import { DOCUMENT_POSTFIXES, DOCUMENT_SCOPES } from "./languages";

// vscode-textmate 9's encoded token attributes (not exported by the package).
const TOKEN_TYPE = (m: number) => (m & 0x00000300) >>> 8;
const FONT_STYLE = (m: number) => (m & 0x00007800) >>> 11;
const FOREGROUND = (m: number) => (m & 0x00ff8000) >>> 15;
export const COMMENT_TOKEN = 1;
const STRING_TOKEN = 2;
/** The words the editor reads a token's standard type from, after the token's own type: a theme rule matches the part before. */
const STANDARD: Record<number, string> = { [COMMENT_TOKEN]: ".comment", [STRING_TOKEN]: ".string", 3: ".regex" };

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

// The other languages' tokens take their colours from the same theme matching: a grammar of one
// word for each scope they map to is tokenized, and what the theme gives each word is its colour.
const PROBE = "source.studio-probe";
const PROBE_SCOPES = [...new Set(Object.values(DOCUMENT_SCOPES))];
const PROBE_LINE = PROBE_SCOPES.map((_, i) => `S${i}`).join(" ");
let probe: IGrammar;
const FONT_STYLES = (style: number) => [style & 1 && "italic", style & 2 && "bold", style & 4 && "underline", style & 8 && "strikethrough"].filter(Boolean).join(" ");

export async function loadGrammar() {
	await oniguruma.loadWASM({ data: await (await fetch("./onig.wasm")).arrayBuffer() });
	registry = new Registry({
		onigLib: Promise.resolve({
			createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
			createOnigString: (text) => new oniguruma.OnigString(text),
		}),
		loadGrammar: async (scope) => {
			if (scope === "source.ssl") return fetch("./grammar/ssl.tmLanguage.json").then((r) => r.json());
			if (scope === PROBE) return { scopeName: PROBE, patterns: PROBE_SCOPES.map((name, i) => ({ match: `\\bS${i}\\b`, name })) } as any;
			return null;
		},
	});
	grammar = (await registry.loadGrammar("source.ssl"))!;
	probe = (await registry.loadGrammar(PROBE))!;
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
	// The documents' tokens: each takes the colour and style the theme gives its scope.
	const probed = probe.tokenizeLine2(PROBE_LINE, INITIAL);
	const styleOf = new Map<string, number>();
	for (let i = 0; i < probed.tokens.length; i += 2) {
		const end = i + 2 < probed.tokens.length ? probed.tokens[i + 2]! : PROBE_LINE.length;
		const word = /^S(\d+)$/.exec(PROBE_LINE.slice(probed.tokens[i]!, end).trim());
		if (word) styleOf.set(PROBE_SCOPES[Number(word[1])]!, probed.tokens[i + 1]!);
	}
	for (const [token, scope] of Object.entries(DOCUMENT_SCOPES)) {
		const m = styleOf.get(scope);
		const color = m === undefined ? undefined : colors[FOREGROUND(m)];
		if (!color) continue;
		const rule = { foreground: color.replace("#", ""), fontStyle: FONT_STYLES(FONT_STYLE(m!)) };
		rules.push({ token, ...rule });
		// And once for each language: the editor's own themes have rules such as "string.sql", which would win over "string".
		for (const postfix of DOCUMENT_POSTFIXES) if (!token.endsWith(`.${postfix}`)) rules.push({ token: `${token}.${postfix}`, ...rule });
	}
	// Re-registering makes Monaco tokenize every model again with the new map.
	monaco.languages.setTokensProvider("ssl", {
		getInitialState: () => new State(INITIAL),
		tokenize(line, state: State) {
			const result = grammar.tokenizeLine2(line, state.stack, 500);
			const tokens: monaco.languages.IToken[] = [];
			for (let i = 0; i < result.tokens.length; i += 2) {
				const m = result.tokens[i + 1]!;
				// The colour is the token's type as the theme sees it; what follows it says, to the editor, that the
				// token is a comment or a string, so that a bracket in one is text and not a bracket to pair and colour.
				tokens.push({ startIndex: result.tokens[i]!, scopes: `c${FOREGROUND(m)}.${FONT_STYLE(m)}${STANDARD[TOKEN_TYPE(m)] ?? ""}` });
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

/** The text without comments or whitespace: equal before and after means only comments and layout changed. */
export function codeOnly(text: string): string {
	let stack = INITIAL;
	let out = "";
	for (const line of text.split(/\r?\n/)) {
		const result = grammar.tokenizeLine2(line, stack, 500);
		stack = result.ruleStack;
		for (let i = 0; i < result.tokens.length; i += 2) {
			if (TOKEN_TYPE(result.tokens[i + 1]!) === COMMENT_TOKEN) continue;
			const end = i + 2 < result.tokens.length ? result.tokens[i + 2]! : line.length;
			const token = line.slice(result.tokens[i]!, end);
			out += TOKEN_TYPE(result.tokens[i + 1]!) === STRING_TOKEN ? token : token.replace(/\s+/g, "");
		}
	}
	return out;
}
