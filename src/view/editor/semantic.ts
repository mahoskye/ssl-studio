// Semantic tokens: the server colours the names a grammar cannot tell apart
// (starlims-lsp's feature.semantic_tokens), the grammar keeps the rest.
//
// VS Code's rules, so a VS Code theme colours as it does there: a theme opts in
// with `semanticHighlighting`, `semanticTokenColors` comes first, then the
// TextMate scopes VS Code maps each token to. A token no rule colours is
// dropped, because Monaco would paint it in the default colour over the
// grammar's; the server's "no token means the grammar's colour stands" holds.

type Style = { foreground?: string; fontStyle?: string };
type ThemeIn = {
	semanticHighlighting?: boolean;
	semanticTokenColors?: Record<string, string | { foreground?: string; fontStyle?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean }>;
	tokenColors?: { scope?: string | string[]; settings: { foreground?: string; fontStyle?: string } }[];
};
export type Legend = { tokenTypes: string[]; tokenModifiers: string[] };

/** What Monaco is told. A server's indices are translated to these, so rule names are known. */
export const LEGEND: Legend = {
	tokenTypes: ["function", "method", "parameter", "variable", "property", "class"],
	tokenModifiers: ["declaration", "defaultLibrary", "readonly", "public", "unknown"],
};

// VS Code's default mapping from semantic tokens to TextMate scopes.
const SCOPES: Record<string, string[]> = {
	function: ["entity.name.function", "support.function"],
	"function.defaultLibrary": ["support.function"],
	method: ["entity.name.function.member", "support.function"],
	"method.defaultLibrary": ["support.function"],
	parameter: ["variable.parameter"],
	variable: ["variable.other.readwrite", "entity.name.variable"],
	"variable.readonly": ["variable.other.constant"],
	"variable.defaultLibrary": ["support.variable"],
	property: ["variable.other.property"],
	"property.readonly": ["variable.other.constant.property"],
	class: ["entity.name.type.class"],
	"class.defaultLibrary": ["support.class"],
};

/** The name Monaco looks a token up by: the type, then its modifiers in legend order. */
const tokenName = (type: string, modifierBits: number) => [type, ...LEGEND.tokenModifiers.filter((_, i) => modifierBits & (1 << i))].join(".");

function fromScopes(theme: ThemeIn, scopes: string[]): Style | null {
	for (const scope of scopes) {
		let best: Style | null = null;
		let length = -1;
		for (const entry of theme.tokenColors ?? []) {
			const list = typeof entry.scope === "string" ? entry.scope.split(",") : (entry.scope ?? []);
			for (const raw of list) {
				const selector = raw.trim();
				// Later entries win a tie, as in TextMate. Descendant selectors do not apply to a lone scope.
				if (selector && !selector.includes(" ") && (scope === selector || scope.startsWith(`${selector}.`)) && selector.length >= length && (entry.settings.foreground || entry.settings.fontStyle !== undefined)) {
					best = { foreground: entry.settings.foreground, fontStyle: entry.settings.fontStyle };
					length = selector.length;
				}
			}
		}
		if (best) return best;
	}
	return null;
}

function fromSemanticColors(theme: ThemeIn, type: string, modifiers: string[]): Style | null {
	let best: Style | null = null;
	let score = -1;
	for (const [selector, value] of Object.entries(theme.semanticTokenColors ?? {})) {
		const [selectorType, ...selectorModifiers] = selector.split(".");
		if ((selectorType !== type && selectorType !== "*") || !selectorModifiers.every((m) => modifiers.includes(m))) continue;
		const points = selectorModifiers.length * 2 + (selectorType === type ? 1 : 0);
		if (points < score) continue;
		score = points;
		if (typeof value === "string") best = { foreground: value };
		else {
			const flags = (["bold", "italic", "underline", "strikethrough"] as const).filter((f) => value[f]);
			best = { foreground: value.foreground, fontStyle: value.fontStyle ?? (flags.length ? flags.join(" ") : undefined) };
		}
	}
	return best;
}

/** The style of one token under a theme, or null when the grammar's colour should stand. */
export function tokenStyle(theme: ThemeIn, type: string, modifiers: string[]): Style | null {
	const explicit = fromSemanticColors(theme, type, modifiers);
	if (explicit) return explicit;
	for (const modifier of ["readonly", "defaultLibrary"]) {
		const scopes = modifiers.includes(modifier) ? SCOPES[`${type}.${modifier}`] : undefined;
		const style = scopes && fromScopes(theme, scopes);
		if (style) return style;
	}
	return fromScopes(theme, SCOPES[type] ?? []);
}

const monacoColor = (color: string) => {
	const hex = color.replace("#", "");
	return (hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex).slice(0, 6);
};

let styled = new Set<string>();
const listeners = new Set<() => void>();

/** Fires when a theme change alters which tokens are coloured. */
export const onSemanticThemeChange = (listener: () => void) => {
	listeners.add(listener);
	return { dispose: () => void listeners.delete(listener) };
};
export const refreshSemanticTokens = () => listeners.forEach((listener) => listener());

/** Monaco theme rules for a theme's coloured tokens, which also become the set tokens are kept by. */
export function semanticRules(theme: ThemeIn): { token: string; foreground?: string; fontStyle: string }[] {
	const rules: { token: string; foreground?: string; fontStyle: string }[] = [];
	styled = new Set();
	if (theme.semanticHighlighting) {
		for (const type of LEGEND.tokenTypes) {
			for (let bits = 0; bits < 1 << LEGEND.tokenModifiers.length; bits++) {
				const style = tokenStyle(theme, type, LEGEND.tokenModifiers.filter((_, i) => bits & (1 << i)));
				if (!style) continue;
				const token = tokenName(type, bits);
				styled.add(token);
				rules.push({ token, foreground: style.foreground && monacoColor(style.foreground), fontStyle: style.fontStyle ?? "" });
			}
		}
	}
	return rules;
}

/**
 * The server's tokens for Monaco: indices moved to LEGEND, and tokens no theme
 * rule colours dropped. Both change the five-integer relative encoding, so the
 * positions are rebuilt. A type or modifier a later server adds is ignored.
 */
export function translateTokens(data: number[], from: Legend, keep: (name: string) => boolean = (name) => styled.has(name)): Uint32Array {
	const out: number[] = [];
	let line = 0;
	let char = 0;
	let lastLine = 0;
	let lastChar = 0;
	for (let i = 0; i + 4 < data.length; i += 5) {
		line += data[i]!;
		char = data[i] ? data[i + 1]! : char + data[i + 1]!;
		const type = LEGEND.tokenTypes.indexOf(from.tokenTypes[data[i + 3]!] ?? "");
		if (type < 0) continue;
		let bits = 0;
		from.tokenModifiers.forEach((name, index) => {
			const known = LEGEND.tokenModifiers.indexOf(name);
			if (known >= 0 && data[i + 4]! & (1 << index)) bits |= 1 << known;
		});
		if (!keep(tokenName(LEGEND.tokenTypes[type]!, bits))) continue;
		out.push(line - lastLine, line === lastLine ? char - lastChar : char, data[i + 2]!, type, bits);
		lastLine = line;
		lastChar = char;
	}
	return Uint32Array.from(out);
}
