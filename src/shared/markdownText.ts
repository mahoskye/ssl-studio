// Words on their way into Markdown, for the readers that turn a ticket's
// description into it: what in them is the address of a page, which is
// written as an address and not as words.

/** An address in running text: from its scheme to the next space or angle bracket. */
export const ADDRESS = /https?:\/\/[^\s<>]+/g;

/**
 * An address as it stands in a sentence, apart from the marks the sentence
 * put after it: "see http://x.test/a." names "http://x.test/a". A closing
 * bracket belongs to the address only when the address opened one.
 */
export function addressAndRest(found: string): [address: string, rest: string] {
	let end = found.length;
	while (end > 0) {
		const ch = found[end - 1]!;
		const opened = ch === ")" && found.slice(0, end - 1).split("(").length > found.slice(0, end - 1).split(")").length;
		if (/[.,;:!?'"\]]/.test(ch) || (ch === ")" && !opened)) end--;
		else break;
	}
	return [found.slice(0, end), found.slice(end)];
}

/**
 * Text with each address in it written as an address ("<http://…>"), where
 * no mark in it can be taken for Markdown's, and everything else passed
 * through `words`.
 */
export function withAddresses(text: string, words: (plain: string) => string): string {
	let out = "";
	let at = 0;
	for (const found of text.matchAll(ADDRESS)) {
		const [address, rest] = addressAndRest(found[0]);
		out += `${words(text.slice(at, found.index))}<${address}>${words(rest)}`;
		at = found.index + found[0].length;
	}
	return out + words(text.slice(at));
}

/** The start of a list's item: what leads it (a quote's marks, its indent), its sign, the space after, and a task's box. */
const ITEM = /^((?:[ \t]*>)*[ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\](?:[ \t]+|$))?/;
/** A rule drawn across the page reads like an item whose words are more of its sign: "- - -", "* * *". */
const RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * What Enter does on a line of a list, with the cursor `cursor` characters
 * into it, as a notebook does it:
 *
 * - after an item's words, the next line starts the next item: the same
 *   sign, the next number, a task's box empty (`start` is what the new line
 *   begins with);
 * - on an item with no words, the list ends: the line is cut back to its
 *   first `keep` characters, which is what a quote it is in needs.
 *
 * Null where Enter is only Enter: not an item, or the cursor still in its sign.
 */
export function listEnter(line: string, cursor: number): { start: string } | { keep: number } | null {
	const found = ITEM.exec(line);
	if (!found || RULE.test(line)) return null;
	const [whole, lead = "", sign = "", gap = "", box = ""] = found;
	if (cursor < whole.length) return null;
	if (!line.slice(whole.length).trim()) return { keep: /^(?:[ \t]*>[ \t]?)*/.exec(lead)![0].length };
	const number = /^(\d+)([.)])$/.exec(sign);
	const next = number ? `${Number(number[1]) + 1}${number[2]}` : sign;
	return { start: `${lead}${next}${gap}${box ? `[ ]${box.slice(3)}` : ""}` };
}
