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

/**
 * The expression for a search. A whole word is one with no letter, digit or
 * underscore beside its own first and last letters: "Due" is not found in
 * "DueDate" nor in "Is_Due". What begins or ends with a mark (":RETURN") is
 * whole on that side wherever it stands. Throws what the expression's own
 * reader throws when it cannot be read.
 */
export function searchPattern(query: string, options: SearchOptions = {}): RegExp {
	const source = options.regex ? query : literal(query);
	const whole = options.wholeWord ? `${STARTS}(?:${source})${ENDS}` : source;
	return new RegExp(whole, `g${options.caseSensitive ? "" : "i"}${options.wholeWord ? "u" : ""}`);
}
