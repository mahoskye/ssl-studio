// The rule for tables in documentation (ADR 0008), as numbers and one check.
// The rendered view uses the numbers to decide which columns never wrap; the
// tests use the check on the documents this repository writes.
import { marked } from "marked";

/** A table has at most this many columns. */
export const MAX_COLUMNS = 4;
/** A heading is a word or two. */
export const MAX_HEADING = 16;
/** A short value: a name, a code, a number, a date. Every column but the last holds these. */
export const MAX_SHORT = 20;
/** The last column may hold a phrase or one sentence. */
export const MAX_TEXT = 100;

export type TableFinding = { line: number; message: string };

/** The entities a document is likely to write. Any other name still shows as one character: see `shownEntities`. */
const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "\u2013",
	mdash: "\u2014",
	hellip: "\u2026",
	larr: "\u2190",
	rarr: "\u2192",
	le: "\u2264",
	ge: "\u2265",
	ne: "\u2260",
	times: "\u00d7",
	deg: "\u00b0",
	micro: "\u00b5",
	plusmn: "\u00b1",
	copy: "\u00a9",
	reg: "\u00ae",
	trade: "\u2122",
	middot: "\u00b7",
	bull: "\u2022",
};

/**
 * A run of text with its entities as the reader sees them: `&amp;` is one character, not five. A name that is
 * not in the list above cannot be looked up without the browser's table of two thousand, so it is shown as one
 * stand-in character: right for the length of every real entity, and short only for a made-up `&name;`.
 */
const shownEntities = (text: string) =>
	text.replace(/&(?:#(\d{1,7})|#[Xx]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (_whole, dec?: string, hex?: string, name?: string) => {
		if (name !== undefined) return ENTITIES[name] ?? "\ufffd";
		const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
		return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
	});

/** A link by name, which the lexer does not know: `[[Target]]` shows its target, `[[Target|Alias]]` its alias. */
const NAMED_LINK = /!?\[\[(?:[^[\]|]+\\?\|([^\]]+)|([^\]]+))\]\]/g;
/** Marked words, which the lexer does not know either: `==words==` shows the words (as markdownHtml.ts reads them). */
const MARKED = /==([^\n=](?:[^\n]*?[^\n=])?)==/g;

/**
 * A stretch of plain text as the rendered page shows it: a link by name as its words, marked words without their
 * `==`. The page makes both of its text only, after the Markdown is read, so this is asked for text only: never
 * for code. A link by name is taken first, as the page takes it: `==` on either side of one marks nothing.
 */
function shownRun(run: string): string {
	const marks = (text: string) => text.replace(MARKED, "$1");
	let out = "";
	let at = 0;
	for (const link of run.matchAll(NAMED_LINK)) {
		out += marks(run.slice(at, link.index)) + (link[1] ?? link[2]);
		at = link.index + link[0].length;
	}
	return out + marks(run.slice(at));
}

/** What the reader sees of a run of inline Markdown, as the renderer's own reading of it (its tokens) says. */
function shownText(tokens: readonly any[]): string {
	let out = "";
	// The text since the last element, which the page shows in one piece: see `shownRun`.
	let run = "";
	const close = (next = "") => {
		out += shownRun(run) + next;
		run = "";
	};
	for (const token of tokens) {
		// A character written with a backslash before it is text like the text around it.
		if (token.type === "escape") run += String(token.text ?? "");
		// Code is shown as written: its underscores, stars, entities and brackets are all characters on the page.
		else if (token.type === "codespan") close(String(token.text ?? ""));
		// A tag is not seen; a line break parts two words.
		else if (token.type === "html") close(/^<br\b/i.test(String(token.raw ?? "")) ? " " : "");
		else if (token.type === "br") close(" ");
		// Emphasis, a link and an image count as what they hold: the words, the label, the alternative text.
		else if (Array.isArray(token.tokens) && token.tokens.length > 0) close(shownText(token.tokens));
		else run += shownEntities(String(token.text ?? token.raw ?? ""));
	}
	close();
	return out;
}

/**
 * What a cell shows, without its Markdown: `code`, [links](there), [[Target|Alias]] and ==marked words== count as
 * their visible text. The Markdown is read by the renderer's own lexer and not by removing every `*`, `_`, `~` and
 * backtick: that made `SAMPLE_DUE_DATE_OVERRIDE` four characters shorter than it reads, so a name too long for a
 * short column passed, and left `&amp;` as five characters, so a value that fits was reported. What the lexer does
 * not know (a link by name, marked words) is taken from the text it found, not from the Markdown before it is
 * read: taken first, a link by name written as code (`[[Target|Alias]]` between backticks, which shows every
 * character) was measured as its alias, and `==x==` was measured with its four marks.
 */
export const cellText = (markdown: string) => inOneLine(shownText(marked.Lexer.lexInline(markdown)));

const inOneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * A cell of a table the lexer has read, as it shows: from the tokens the lexer already made of it, so a document
 * of many cells is not read twice.
 */
const tableCellText = (cell: any) => (Array.isArray(cell?.tokens) ? inOneLine(shownText(cell.tokens)) : cellText(String(cell?.text ?? "")));

const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** How many characters a reader counts in a shown text: an emoji or an accented letter built of several code units is one. */
export function shownLength(text: string): number {
	if (/^[\x20-\x7e]*$/.test(text)) return text.length;
	if (!graphemes) return [...text].length;
	let count = 0;
	for (const _ of graphemes.segment(text)) count++;
	return count;
}

/** Where each table breaks the rule. Lines are 1-based and point at the table's heading row. */
export function checkTables(markdown: string): TableFinding[] {
	// marked.lexer normalizes token.raw to LF, so normalize CRLF before locating line offsets.
	const plain = markdown.replace(/\r\n/g, "\n");
	const findings: TableFinding[] = [];
	let offset = 0;
	// Where the top-level block being walked ends: a table inside it (in a quote, in a list) is looked for before that.
	let blockEnd = plain.length;
	const walk = (tokens: any[], isTopLevel = false) => {
		for (const token of tokens) {
			let tokenStart = -1;
			if (isTopLevel && typeof token.raw === "string" && token.raw.length > 0) {
				tokenStart = plain.indexOf(token.raw, offset);
				blockEnd = tokenStart >= 0 ? tokenStart + token.raw.length : plain.length;
			}
			if (token.type === "table") {
				let at = tokenStart >= 0 ? tokenStart : plain.indexOf(token.raw, offset);
				// A table in a quote has lost the `> ` of its lines in `token.raw`, and is not in the document as that
				// text. Looked for anywhere after the last table, it was found in a table further down that reads the
				// same, and the two were reported on each other's lines. It is its own block's, and looked for there.
				if (at >= 0 && at + token.raw.length <= blockEnd) {
					offset = at + token.raw.length;
				} else {
					at = -1;
					// Inside blockquotes/lists, `marked` strips `> ` / leading indent from `token.raw`.
					const firstLine = String(token.raw ?? "").split("\n")[0]?.trim() ?? "";
					if (firstLine) {
						let pos = offset;
						for (const rawLine of plain.slice(offset, blockEnd).split("\n")) {
							const stripped = rawLine.replace(/^(?:[ \t]*>[ \t]*)+/, "").trim();
							if (stripped === firstLine) {
								at = pos;
								offset = pos + rawLine.length + 1;
								break;
							}
							pos += rawLine.length + 1;
						}
					}
				}
				check(token, plain.slice(0, Math.max(at, 0)).split("\n").length);
				continue;
			}
			if (isTopLevel && token.type === "code") {
				if (tokenStart >= 0) offset = tokenStart + token.raw.length;
				continue;
			}
			if (Array.isArray(token.tokens)) walk(token.tokens, false);
			if (Array.isArray(token.items)) walk(token.items, false);
			if (isTopLevel && tokenStart >= 0) {
				offset = Math.max(offset, tokenStart + token.raw.length);
			}
		}
	};
	const check = (table: any, line: number) => {
		const say = (message: string) => findings.push({ line, message });
		const heads: string[] = table.header.map((h: any) => tableCellText(h));
		const last = heads.length - 1;
		if (heads.length > MAX_COLUMNS) say(`A table has at most ${MAX_COLUMNS} columns; this one has ${heads.length}.`);
		heads.forEach((head, i) => {
			const name = head || `column ${i + 1}`;
			if (!head) say(`Column ${i + 1} has no heading.`);
			if (shownLength(head) > MAX_HEADING) say(`The heading "${head}" is ${shownLength(head)} characters; a heading has at most ${MAX_HEADING}.`);
			const longest = Math.max(0, ...table.rows.map((row: any) => shownLength(tableCellText(row[i]))));
			if (i < last && longest > MAX_SHORT) say(`"${name}" holds a value of ${longest} characters; only the last column holds text, and the others at most ${MAX_SHORT}.`);
			if (i === last && longest > MAX_TEXT) say(`"${name}" holds ${longest} characters in one cell; a cell has at most ${MAX_TEXT}.`);
		});
	};
	walk(marked.lexer(plain), true);
	return findings;
}

/** A heading's anchor, as a link to it is usually written: "## What is here" is #what-is-here. */
export const headingAnchor = (text: string) =>
	text
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s+/g, "-");
