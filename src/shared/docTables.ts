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

/** What the reader sees of a run of inline Markdown, as the renderer's own reading of it (its tokens) says. */
function shownText(tokens: readonly any[]): string {
	let out = "";
	for (const token of tokens) {
		// Code is shown as written: its underscores, stars and entities are all characters on the page.
		if (token.type === "codespan" || token.type === "escape") out += String(token.text ?? "");
		// A tag is not seen; a line break parts two words.
		else if (token.type === "html") out += /^<br\b/i.test(String(token.raw ?? "")) ? " " : "";
		else if (token.type === "br") out += " ";
		// Emphasis, a link and an image count as what they hold: the words, the label, the alternative text.
		else if (Array.isArray(token.tokens) && token.tokens.length > 0) out += shownText(token.tokens);
		else out += shownEntities(String(token.text ?? token.raw ?? ""));
	}
	return out;
}

/**
 * What a cell shows, without its Markdown: `code`, [links](there), and [[Target|Alias]] count as their visible text.
 * The Markdown is read by the renderer's own lexer and not by removing every `*`, `_`, `~` and backtick: that made
 * `SAMPLE_DUE_DATE_OVERRIDE` four characters shorter than it reads, so a name too long for a short column passed,
 * and left `&amp;` as five characters, so a value that fits was reported.
 */
export const cellText = (markdown: string) =>
	inOneLine(
		shownText(
			marked.Lexer.lexInline(
				markdown
					.replace(/!?\[\[[^[\]|]+\\?\|([^\]]+)\]\]/g, "$1")
					.replace(/!?\[\[([^\]]+)\]\]/g, "$1"),
			),
		),
	);

const inOneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * A cell of a table the lexer has read, as it shows: from the tokens the lexer already made of it, so a document
 * of many cells is not read twice. A cell with a wikilink in it is read anew, the link taken as its words first:
 * `[[Target|Alias]]` is this application's, and the lexer does not know it.
 */
const tableCellText = (cell: any) => (Array.isArray(cell?.tokens) && !String(cell.text ?? "").includes("[[") ? inOneLine(shownText(cell.tokens)) : cellText(String(cell?.text ?? "")));

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
	const walk = (tokens: any[], isTopLevel = false) => {
		for (const token of tokens) {
			let tokenStart = -1;
			if (isTopLevel && typeof token.raw === "string" && token.raw.length > 0) {
				tokenStart = plain.indexOf(token.raw, offset);
			}
			if (token.type === "table") {
				let at = tokenStart >= 0 ? tokenStart : plain.indexOf(token.raw, offset);
				if (at >= 0) {
					offset = at + token.raw.length;
				} else {
					// Inside blockquotes/lists, `marked` strips `> ` / leading indent from `token.raw`.
					const firstLine = String(token.raw ?? "").split("\n")[0]?.trim() ?? "";
					if (firstLine) {
						let pos = offset;
						for (const rawLine of plain.slice(offset).split("\n")) {
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
