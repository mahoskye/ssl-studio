// What a search looks for, as the expression that finds it: the words as
// typed or as a regular expression, in any case or the case given, anywhere
// or as a whole word. The search across files and the replace across files
// find the same places because they are given the same expression.

export type SearchOptions = { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean };

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
