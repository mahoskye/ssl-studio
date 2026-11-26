// What starlims-lsp says of a script's text, and what the IDE does with it. The IDE reads no SSL of its own
// (ADR 0003): where a comment or a string is and which word is a keyword come from the server's
// `ssl/lexicalTokens` (shape version 1, since 0.32.0), and what kind of name a word is from its semantic tokens.
// Nothing here reads SSL: it only places the server's ranges in the text they were read from.

import { extractCommentSpans } from "./editorDocHelpers";

export type LexPosition = { line: number; character: number };
export type LexRange = { start: LexPosition; end: LexPosition };
/** One token of `ssl/lexicalTokens`: `comment`, `string`, `keyword`, `text` (a region's body) or `codeBlock`. A kind not known here is left alone. */
export type LexToken = { kind: string; range: LexRange };
/** One semantic token, with the names its legend gives its type and modifiers. */
export type NameToken = { line: number; character: number; length: number; type: string; modifiers: string[] };
/** What the server said of one text. A part is null where it could not say: no server, an older one, or a text that changed while it was asked. */
export type SslFacts = { lexical: LexToken[] | null; names: NameToken[] | null };

export const NO_FACTS: SslFacts = { lexical: null, names: null };

/** Where each line of a text starts. A line ends at `\r\n`, `\n` or a lone `\r`, as the protocol counts them. */
export function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 13) {
			if (text.charCodeAt(i + 1) === 10) i++;
			starts.push(i + 1);
		} else if (ch === 10) starts.push(i + 1);
	}
	return starts;
}

/** The place in the text of a position of the server's, kept inside the text: a position past a line's end is the line's end. */
export function offsetAt(text: string, starts: readonly number[], position: LexPosition): number {
	if (position.line < 0) return 0;
	if (position.line >= starts.length) return text.length;
	const start = starts[position.line]!;
	const next = position.line + 1 < starts.length ? starts[position.line + 1]! : text.length;
	return Math.min(start + Math.max(0, position.character), next);
}

/**
 * The text with every token of the kinds named written over with spaces: comments, unless told otherwise. It is
 * as long as it was and its lines end where they did, so a place in it is the same place in the text.
 */
export function withoutTokens(text: string, tokens: readonly LexToken[], kinds: readonly string[] = ["comment"]): string {
	const starts = lineStarts(text);
	let out = "";
	let at = 0;
	for (const token of tokens) {
		if (!kinds.includes(token.kind)) continue;
		const from = Math.max(at, offsetAt(text, starts, token.range.start));
		const to = Math.max(from, offsetAt(text, starts, token.range.end));
		out += text.slice(at, from) + text.slice(from, to).replace(/[^\r\n]/g, " ");
		at = to;
	}
	return out + text.slice(at);
}

/** The text with these spans of each of its lines written over with spaces: what a reader of another language's comments found. */
export function withoutSpans(text: string, spansOf: (lines: readonly string[]) => readonly { from: number; to: number }[][] | null): string {
	const parts = text.split(/(\r\n|\n|\r)/);
	const lines = parts.filter((_, i) => i % 2 === 0);
	const spans = spansOf(lines);
	if (!spans) return text;
	let out = "";
	for (let i = 0; i < parts.length; i++) {
		if (i % 2) {
			out += parts[i];
			continue;
		}
		let line = parts[i]!;
		for (const span of spans[i / 2] ?? []) {
			const from = Math.max(0, Math.min(span.from, line.length));
			const to = Math.max(from, Math.min(span.to, line.length));
			line = line.slice(0, from) + " ".repeat(to - from) + line.slice(to);
		}
		out += line;
	}
	return out;
}

const SQL_LANGUAGES = new Set(["sql", "pgsql", "mysql"]);

/**
 * A text with its comments written over with spaces, for looking up the names in it. SSL's comments are the
 * server's (`lexical`); where it could not say, the ones `sslComments` gives, which is the grammar highlighting
 * reads, and where that gives none either the text as it is. SQL's are found by a walk over its own two kinds of
 * comment. Any other text has none.
 *
 * One reader used to do this for every language at once, and guessed for each `/*` whether SQL or SSL had opened
 * it. It ended an SSL comment at a `*\/` where one came later, and honoured a backslash in a string, neither of
 * which SSL does.
 */
export function withoutComments(
	text: string,
	language: string,
	lexical: readonly LexToken[] | null | undefined,
	sslComments: (lines: readonly string[]) => readonly { from: number; to: number }[][] | null = () => null,
): string {
	if (language === "ssl") return lexical ? withoutTokens(text, lexical) : withoutSpans(text, sslComments);
	if (SQL_LANGUAGES.has(language)) return withoutSpans(text, extractCommentSpans);
	return text;
}

const before = (a: LexPosition, b: LexPosition) => a.line < b.line || (a.line === b.line && a.character < b.character);

/** The token a place lies in: from its first character up to, not at, its end. The server's tokens are in the order of the text and do not overlap. */
export function tokenAt(tokens: readonly LexToken[], line: number, character: number): LexToken | undefined {
	const place = { line, character };
	let low = 0;
	let high = tokens.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const token = tokens[mid]!;
		if (before(place, token.range.start)) high = mid - 1;
		else if (!before(place, token.range.end)) low = mid + 1;
		else return token;
	}
	return undefined;
}

/** The server's semantic tokens with their names, from the five numbers a token is sent as. */
export function decodeNameTokens(data: readonly number[], legend: { tokenTypes: readonly string[]; tokenModifiers: readonly string[] }): NameToken[] {
	const out: NameToken[] = [];
	let line = 0;
	let character = 0;
	for (let i = 0; i + 4 < data.length; i += 5) {
		line += data[i]!;
		character = data[i] ? data[i + 1]! : character + data[i + 1]!;
		const bits = data[i + 4]!;
		out.push({
			line,
			character,
			length: data[i + 2]!,
			type: legend.tokenTypes[data[i + 3]!] ?? "",
			modifiers: legend.tokenModifiers.filter((_, bit) => bit < 32 && (bits & (1 << bit)) !== 0),
		});
	}
	return out;
}

/** The names of one line, for a text that is asked about line by line. */
export function namesByLine(names: readonly NameToken[]): Map<number, NameToken[]> {
	const out = new Map<number, NameToken[]>();
	for (const name of names) {
		const list = out.get(name.line);
		if (list) list.push(name);
		else out.set(name.line, [name]);
	}
	return out;
}

/**
 * Whether a word is the language's own where it stands, and so not the name of a table: a keyword (`:IF`), a member
 * after a `:` (`oRule:Status`), or a name its statement declares (`:DECLARE`, `:PARAMETERS`, `:PUBLIC`,
 * `:PROCEDURE`, `:CLASS`, `:LABEL`). `line` and `character` are the word's first character, both from 0.
 *
 * This was read off the line by hand: a `:` before the word, or a line that began with a declaring keyword. That
 * took `:DECLARE` inside a comment or a string for a declaration, and knew nothing of a declaration that runs over
 * lines. Where the server said nothing (`NO_FACTS`), nothing is known and the answer is no.
 */
export function isSslOwnWord(facts: SslFacts, line: number, character: number, lineNames?: readonly NameToken[]): boolean {
	if (facts.lexical && tokenAt(facts.lexical, line, character)?.kind === "keyword") return true;
	for (const name of lineNames ?? facts.names ?? []) {
		if (name.line !== line || character < name.character || character >= name.character + name.length) continue;
		return name.modifiers.includes("declaration") || name.type === "property" || name.type === "method";
	}
	return false;
}
