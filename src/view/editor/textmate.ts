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

/** Expands 3/4-digit shorthand hex colors (#RGB / #RGBA) to 6-digit hex and validates RRGGBB for Monaco theme rules. */
export function normalizeMonacoHex(color: string | undefined): string | undefined {
	if (!color) return undefined;
	const hex = color.trim().replace(/^#/, "");
	let normalized: string;
	if (/^[0-9a-f]{3,4}$/i.test(hex)) {
		normalized = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
	} else if (/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(hex)) {
		normalized = hex.slice(0, 6);
	} else {
		return undefined;
	}
	return /^[0-9a-f]{6}$/i.test(normalized) ? normalized : undefined;
}

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
		const foreground = normalizeMonacoHex(color);
		if (!foreground) return;
		for (let style = 0; style < 16; style++) {
			const fontStyle = FONT_STYLES(style);
			rules.push({ token: `c${id}.${style}`, foreground, fontStyle });
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
		const foreground = normalizeMonacoHex(m === undefined ? undefined : colors[FOREGROUND(m)]);
		if (!foreground) continue;
		const rule = { foreground, fontStyle: FONT_STYLES(FONT_STYLE(m!)) };
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

/**
 * The text without comments, normalized so token boundaries stay distinct:
 * equal before and after means only comments and layout changed.
 * Returns null before `loadGrammar()` completes.
 */
export function codeOnly(text: string, targetGrammar: IGrammar | undefined = grammar): string | null {
	if (!targetGrammar) return null;
	let stack = INITIAL;
	const pieces: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const result = targetGrammar.tokenizeLine2(line, stack, 500);
		stack = result.ruleStack;
		for (let i = 0; i < result.tokens.length; i += 2) {
			const type = TOKEN_TYPE(result.tokens[i + 1]!);
			if (type === COMMENT_TOKEN) continue;
			const end = i + 2 < result.tokens.length ? result.tokens[i + 2]! : line.length;
			const token = line.slice(result.tokens[i]!, end);
			if (type === STRING_TOKEN) {
				pieces.push(token);
			} else {
				for (const part of token.split(/\s+/)) {
					if (part) pieces.push(part);
				}
			}
		}
	}
	return pieces.join(" ");
}

/**
 * Comment character spans per line derived strictly from the canonical SSL
 * TextMate grammar (ADR 0003). Returns null before `loadGrammar()` completes.
 */
export function sslCommentSpans(
	lines: readonly string[],
	targetGrammar: IGrammar | undefined = grammar,
): { from: number; to: number }[][] | null {
	if (!targetGrammar) return null;
	let stack = INITIAL;
	const out: { from: number; to: number }[][] = [];
	for (const line of lines) {
		const result = targetGrammar.tokenizeLine2(line, stack, 500);
		stack = result.ruleStack;
		const spans: { from: number; to: number }[] = [];
		for (let i = 0; i < result.tokens.length; i += 2) {
			if (TOKEN_TYPE(result.tokens[i + 1]!) !== COMMENT_TOKEN) continue;
			const from = result.tokens[i]!;
			const to = i + 2 < result.tokens.length ? result.tokens[i + 2]! : line.length;
			if (to <= from) continue;
			const prev = spans.at(-1);
			if (prev && prev.to === from) prev.to = to;
			else spans.push({ from, to });
		}
		out.push(spans);
	}
	return out;
}
