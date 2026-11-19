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
