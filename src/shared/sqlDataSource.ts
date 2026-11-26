// Whether a data source is SQL, and where its SQL starts (ADR 0038).
//
// A data source (`.ds`) is either SSL or SQL, and one of SQL may open with a few SSL directives
// (`:PARAMETERS …;`, `:DSN := …;`). Which it is, the language server knows, and it says so by what it reports: its
// lexical tokens are what it read as SSL, and of an SQL data source it reads nothing, or the header alone.
//
// So the IDE reads no SSL here either. What stands below the last thing the server read as SSL is looked at as
// SQL, which is the IDE's own to read: if it opens with an SQL statement, the data source is SQL from there on.
// Without the server's word, only a file that is SQL from its first line is taken for SQL.
import { lineStarts, type LexToken } from "./lexicalTokens";

/**
 * A line an SQL statement opens on: one of the words such a statement begins with, alone or in brackets. Not
 * where the word is given a value or called, which is a name in some other language that happens to be spelt so.
 */
const OPENS_SQL = /^\s*\(*\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|CALL|DECLARE|BEGIN|SET)\b(?!\s*(?::=|\())/i;

/** The lines of a text, split as the protocol counts them. */
function linesOf(text: string): string[] {
	const starts = lineStarts(text);
	return starts.map((start, i) => text.slice(start, i + 1 < starts.length ? starts[i + 1] : text.length).replace(/[\r\n]+$/, ""));
}

/**
 * The line (from 0) a data source's SQL starts on, its own leading comments included, or null where the data
 * source is not SQL. `lexical` is the server's `ssl/lexicalTokens` for this text, null where it could not say.
 */
export function sqlBodyStart(text: string, lexical: readonly LexToken[] | null): number | null {
	const lines = linesOf(text);
	// Below the last line the server read anything on as SSL. A token that ends at the start of a line ended on
	// the line before it.
	let from = 0;
	for (const { range } of lexical ?? []) {
		const last = range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
		from = Math.max(from, last + 1);
	}
	let start: number | null = null;
	for (let line = from; line < lines.length; line++) {
		let rest = lines[line]!;
		if (!rest.trim()) continue;
		start ??= line;
		// SQL's own comments before its first statement: to the end of the line, or closed with `*/`. One that is
		// never closed is no SQL comment (SSL's are not closed that way), and what follows it is not read as SQL.
		for (;;) {
			rest = rest.trimStart();
			if (rest.startsWith("--")) rest = "";
			else if (rest.startsWith("/*")) {
				let close = rest.indexOf("*/", 2);
				while (close < 0 && ++line < lines.length) {
					rest = lines[line]!;
					close = rest.indexOf("*/");
				}
				if (close < 0) return null;
				// A banner is often closed `*/;`. The `;` is not SQL's, but it is no statement either.
				rest = rest.slice(close + 2).replace(/^\s*;/, "");
			} else break;
			if (!rest) break;
		}
		if (!rest.trim()) continue;
		return OPENS_SQL.test(rest) ? start : null;
	}
	return null;
}

/** A data source's text in two: what stands above its SQL (as it is, line ends and all) and the SQL. */
export function splitAtLine(text: string, line: number): { above: string; body: string } {
	const starts = lineStarts(text);
	const at = starts[Math.min(line, starts.length - 1)] ?? text.length;
	return { above: text.slice(0, at), body: text.slice(at) };
}
