// What a search looks for, as the expression that finds it: the words as
// typed or as a regular expression, in any case or the case given, anywhere
// or as a whole word. The search across files and the replace across files
// find the same places because they are given the same expression.

/** As many results as a search gives back. With this many there may be more, and a replace would not know of them. */
export const SEARCH_LIMIT = 2000;
/** Maximum characters kept per search hit excerpt. */
export const SEARCH_LINE_WINDOW = 400;

export type SearchOptions = {
	regex?: boolean;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	/** The files to look in, as a list of patterns (src/shared/fileGlob.ts); every file, when empty. */
	include?: string;
	/** The files to leave out, as a list of patterns. */
	exclude?: string;
	/** Explicit workspace-relative normalized path allowlist (matched verbatim, avoiding glob/comma splitting). */
	paths?: string[];
	/** Safe Docs guard for replace: skips YAML frontmatter keys, Markdown link targets, and invalid .plan.json edits. */
	safeDocs?: boolean;
	/** Per-file 1-based allowed line numbers for partial-line replace (keyed by path). */
	linesByPath?: Record<string, number[]>;
};

/**
 * Windows a long line to at most `maxLen` characters around a 1-based `column` so matches
 * near or beyond `maxLen` remain visible in search excerpts.
 */
export function excerptForMatch(
	line: string,
	column1Based: number,
	length = 0,
	maxLen = SEARCH_LINE_WINDOW,
	lead = 100,
): { text: string; textOffset: number } {
	if (line.length <= maxLen) return { text: line, textOffset: 0 };
	const matchStart = Math.max(0, column1Based - 1);
	const matchEnd = matchStart + Math.max(1, length);
	if (matchEnd <= maxLen - 40) return { text: line.slice(0, maxLen), textOffset: 0 };
	const offset = Math.max(0, Math.min(matchStart - lead, line.length - maxLen));
	return { text: line.slice(offset, offset + maxLen), textOffset: offset };
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const WORD = "[\\p{L}\\p{N}_]";
/** Where a whole word may start: before a letter that has none before it, or before a mark. */
const STARTS = `(?:(?<!${WORD})(?=${WORD})|(?!${WORD}))`;
/** Where a whole word may end: after a letter that has none after it, or after a mark. */
const ENDS = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD}))`;
/** The same two places with the plain letters only, for an expression that cannot be read the Unicode way. */
const PLAIN = "[A-Za-z0-9_]";
const PLAIN_STARTS = `(?:(?<!${PLAIN})(?=${PLAIN})|(?!${PLAIN}))`;
const PLAIN_ENDS = `(?:(?<=${PLAIN})(?!${PLAIN})|(?<!${PLAIN}))`;

/**
 * The expression for a search. A whole word is one with no letter, digit or
 * underscore beside its own first and last letters: "Due" is not found in
 * "DueDate" nor in "Is_Due". What begins or ends with a mark (":RETURN") is
 * whole on that side wherever it stands. Throws what the expression's own
 * reader throws when it cannot be read.
 *
 * Knowing every alphabet's letters needs the stricter, Unicode way of
 * reading an expression, which refuses some that are otherwise fine ("a\-b",
 * "a{"). Such an expression is not refused for asking for whole words: it is
 * read the way it reads without, and a word's edge is then a plain letter's.
 */
export function searchPattern(query: string, options: SearchOptions = {}): RegExp {
	const source = options.regex ? query : literal(query);
	const flags = `g${options.caseSensitive ? "" : "i"}`;
	if (!options.wholeWord) return new RegExp(source, flags);
	try {
		return new RegExp(`${STARTS}(?:${source})${ENDS}`, `${flags}u`);
	} catch (strict) {
		if (!options.regex) throw strict;
		// What cannot be read either way is the expression's own fault, and says so as it would without whole words.
		new RegExp(source, flags);
		return new RegExp(`${PLAIN_STARTS}(?:${source})${PLAIN_ENDS}`, flags);
	}
}

/**
 * What one match becomes. For words as typed, the replacement as typed. For
 * a regular expression, the replacement with its marks filled in from the
 * match: "$1" to "$99" the groups, "$<name>" a named group, "$&" the whole
 * match, "$$" a dollar. A group the expression does not have is left as it
 * was written.
 */
export function replacementFor(match: RegExpExecArray, replacement: string, regex: boolean): string {
	if (!regex) return replacement;
	return replacement.replace(/\$(?:(\$)|(&)|<([^>]+)>|(\d{1,2}))/g, (written, dollar, whole, name, digits: string | undefined) => {
		if (dollar) return "$";
		if (whole) return match[0];
		if (name !== undefined) return match.groups && name in match.groups ? (match.groups[name] ?? "") : written;
		// "$12" is group 12 where there is one, else group 1 and a "2".
		const two = Number(digits);
		if (two >= 1 && two < match.length) return match[two] ?? "";
		const one = Number(digits![0]);
		return digits!.length === 2 && one >= 1 && one < match.length ? (match[one] ?? "") + digits![1] : written;
	});
}

/** Every match on one line, left to right, with what it becomes. The same walk a search makes. */
export function matchesOn(
	line: string,
	pattern: RegExp,
	replacement: string,
	regex: boolean,
	maxMatches = Infinity,
): { column: number; length: number; becomes: string }[] {
	const out: { column: number; length: number; becomes: string }[] = [];
	if (maxMatches <= 0) return out;
	pattern.lastIndex = 0;
	let match: RegExpExecArray | null;
	while (out.length < maxMatches && (match = pattern.exec(line))) {
		out.push({ column: match.index + 1, length: match[0].length, becomes: replacementFor(match, replacement, regex) });
		// After a match of nothing the walk steps on by a whole character. A character outside the first plane is
		// two units of the string: one step would land between its halves, to split it in two or never get past it.
		if (!match[0].length) pattern.lastIndex = match.index + ((line.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1);
	}
	return out;
}

/**
 * A text with every match replaced, and how many there were. Matches are
 * looked for a line at a time, as the search looks for them, so what is
 * replaced is what was found; the line ends stay as they are.
 */
export function replaceIn(text: string, query: string, replacement: string, options: SearchOptions = {}): { text: string; count: number } {
	const pattern = searchPattern(query, options);
	let count = 0;
	// The lines and what ends each of them, turn about: only the lines are searched.
	const parts = text.split(/(\r?\n)/);
	for (let at = 0; at < parts.length; at += 2) {
		const line = parts[at]!;
		const found = matchesOn(line, pattern, replacement, Boolean(options.regex));
		if (!found.length) continue;
		count += found.length;
		let out = "";
		let from = 0;
		for (const each of found) {
			out += line.slice(from, each.column - 1) + each.becomes;
			from = each.column - 1 + each.length;
		}
		parts[at] = out + line.slice(from);
	}
	return { text: parts.join(""), count };
}
