// A ticket's key written in prose ("this waits on DEMO-101") is a way to
// that ticket: on a document's page it is a link, with what the ticket is in
// its tooltip. Only the keys of tickets the project has are linked: a word
// that merely looks like a key leads nowhere, and is left as a word.

export type Mention = {
	/** Where the key starts and ends in the text. */
	from: number;
	to: number;
	/** The ticket's key as the project writes it, whatever case the prose used. */
	key: string;
};

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A key that can be told from an ordinary word or number: it has a letter and a digit, or a mark between its parts. */
const distinct = (key: string) => /[A-Za-z]/.test(key) && (/\d/.test(key) || /[-_./]/.test(key));

/**
 * The places a text names one of the project's tickets. A key made of
 * digits alone ("12") is one only as "#12": a number in a sentence is a
 * number. A key that is part of a longer word, a path or a longer key is not
 * a mention.
 */
export function ticketMentions(text: string, keys: readonly string[]): Mention[] {
	const words = keys.filter(distinct);
	const numbers = keys.filter((key) => /^\d+$/.test(key));
	if (!words.length && !numbers.length) return [];
	// The longest first: of "DEMO-10" and "DEMO-101", the one that is written.
	const either = [...words.map(escaped), ...numbers.map((key) => `#${key}`)].sort((a, b) => b.length - a.length).join("|");
	const pattern = new RegExp(`(^|[^\\w./\\\\#-])(${either})(?![\\w-]|[./\\\\]\\w)`, "gi");
	const known = new Map(keys.map((key) => [key.toLowerCase(), key]));
	const found: Mention[] = [];
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const written = match[2]!;
		const from = match.index + match[1]!.length;
		const key = known.get(written.replace(/^#/, "").toLowerCase()) ?? known.get(written.toLowerCase());
		if (key) found.push({ from, to: from + written.length, key });
		// The character after a mention may open the next one.
		pattern.lastIndex = from + written.length;
	}
	return found;
}
