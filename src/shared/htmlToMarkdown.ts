// Pure DOM-free HTML -> Markdown and Excel/TSV -> Markdown table converters.
// Used by CM6 smart clipboard paste, Azure DevOps ticket import, and HTML/Confluence doc import.

import { addressAndRest } from "./markdownText";

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	hellip: "…",
	bull: "•",
	copy: "©",
	reg: "®",
	trade: "™",
	// Every name for a character of plain ASCII. An address is judged by its ASCII (its scheme, its colon), so a
	// name left unread here hid one: "javascript&colon;alert(1)" was let through, and Markdown read the name back.
	tab: "\t",
	newline: "\n",
	excl: "!",
	num: "#",
	dollar: "$",
	percnt: "%",
	lpar: "(",
	rpar: ")",
	ast: "*",
	midast: "*",
	plus: "+",
	comma: ",",
	period: ".",
	sol: "/",
	colon: ":",
	semi: ";",
	equals: "=",
	quest: "?",
	commat: "@",
	lsqb: "[",
	lbrack: "[",
	bsol: "\\",
	rsqb: "]",
	rbrack: "]",
	hat: "^",
	lowbar: "_",
	underbar: "_",
	grave: "`",
	diacriticalgrave: "`",
	lcub: "{",
	lbrace: "{",
	verbar: "|",
	vert: "|",
	verticalline: "|",
	rcub: "}",
	rbrace: "}",
	nonbreakingspace: " ",
};

/** A character written by number, with or without its ";" (a page reads both), or by a name that ends in ";". */
const ENTITY_RE = /&(#x[0-9a-f]+;?|#\d+;?|[a-z][a-z0-9]*;)/gi;

/** The character a reference stands for, or null where this does not read it (a name it does not know, a number that is no character). */
function entityChar(code: string): string | null {
	const lower = code.toLowerCase().replace(/;$/, "");
	if (Object.hasOwn(ENTITIES, lower)) return ENTITIES[lower]!;
	if (!lower.startsWith("#")) return null;
	const n = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
	return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : null;
}

export function decodeHtmlEntities(input: string): string {
	return input.replace(ENTITY_RE, (m, code: string) => entityChar(code) ?? m);
}

/**
 * Text with its references read, and where in it stands the "&" of each one left as written. Those are left for
 * Markdown, which reads the same names a page does: "&eacute;" shows as the letter either way. Every other "&" in
 * the text is a character the page showed, and is told apart from them by this.
 */
function readEntities(input: string): { text: string; kept: Set<number> } {
	const kept = new Set<number>();
	let text = "";
	let last = 0;
	for (const m of input.matchAll(ENTITY_RE)) {
		text += input.slice(last, m.index);
		const ch = entityChar(m[1]!);
		if (ch === null) kept.add(text.length);
		text += ch ?? m[0];
		last = m.index + m[0].length;
	}
	return { text: text + input.slice(last), kept };
}

/**
 * Words as Markdown reads them back: a character that would be taken for a mark is written as itself. The rule is
 * the one `literal` in adf.ts has: a backslash, a star, a backtick, a tilde and a square bracket always; an
 * underscore at a word's edge; a "<" that would open a tag, and an "&" that would open a named character, as the
 * characters they are. Text read from a page used to be written as it stood, so a page that showed
 * "&lt;DataSource&gt;" or "&lt;script&gt;" became a file with that tag in it. `kept` is from `readEntities`.
 *
 * In a link's words and a picture's (`inLabel`) a square bracket is written by its number, not with a backslash:
 * marked takes the backslash off the brackets of a link's words before it reads them, and would read "\[x\](y)"
 * there as a link of its own.
 *
 * The text may end where something set aside begins (a "\x00" stands there until it is put back: bold words, or
 * the words of a link not kept as one). A "<" or an "&" right before that is written as the character it is too,
 * since what is put back may begin with the letters that would make a tag or a named character of it.
 *
 * `open` says that the text itself ends so: something is written right after its last word (the "**" of bold
 * text). See `openAddresses` for what that asks of an address.
 */
function literal(text: string, kept?: ReadonlySet<number>, inLabel = false, open = false): string {
	const addresses = openAddresses(text, open, inLabel);
	if (!addresses && !/[\\*`~[\]_<&]/.test(text)) return text;
	const word = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
	let out = "";
	for (let at = 0; at < text.length; at++) {
		const ch = text[at]!;
		const next = text[at + 1];
		const address = addresses?.get(at);
		if (address) {
			out += `<${text.slice(at, at + address)}>`;
			at += address - 1;
			continue;
		}
		if (address === 0) out += "\\";
		if (inLabel && (ch === "[" || ch === "]")) out += ch === "[" ? "&#91;" : "&#93;";
		else if (ch === "\\" || ch === "*" || ch === "`" || ch === "~" || ch === "[" || ch === "]") out += `\\${ch}`;
		else if (ch === "_" && !(word(text[at - 1]) && word(next))) out += "\\_";
		else if (ch === "<" && next !== undefined && /[A-Za-z/!?\x00]/.test(next)) out += "&lt;";
		else if (ch === "&" && !kept?.has(at) && /^&(?:(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);|#?[0-9A-Za-z]*\x00)/.test(text.slice(at, at + 40))) out += "&amp;";
		else out += ch;
	}
	return out;
}

const BARE_ADDRESS_RE = /(?:https?|ftp)(?=:\/\/)|www(?=\.)/gi;
const HAS_ADDRESS_RE = /(?:https?|ftp):\/\/|www\./i;

/**
 * The addresses in `text` that have something written right after them, with no space between: where each begins
 * and how long it is, or 0 for the place of the ":" or "." that makes an address of it. Null where there is none.
 *
 * A reader of Markdown takes "https://…", "ftp://…" and "www.…" in running text for a link and reads on to the
 * next space, through whatever stands there. Inline code right after an address ("see https://x.test/a" and then
 * `<code>`) lost its opening backtick to the address, was no code any more, and what the page showed as code
 * ("<img onerror=…>") was a tag in the file. So such an address is closed before what follows it: written between
 * "<" and ">" where it is an address and nothing else, and otherwise with a backslash in it, which leaves its
 * characters as they are and makes no link of them (in the page it was text, not a link). In a link's own words
 * always with the backslash: a link holds no link.
 */
function openAddresses(text: string, open: boolean, inLabel: boolean): Map<number, number> | null {
	if (!/:\/\/|www\./i.test(text)) return null;
	let found: Map<number, number> | null = null;
	// Word by word, so that no stretch is read once for each address in it.
	for (const run of text.matchAll(/[^\s\x00]+/g)) {
		const end = run.index + run[0].length;
		if (!(end < text.length ? text[end] === "\x00" : open)) continue;
		found ??= new Map();
		if (!inLabel && /^https?:\/\/[A-Za-z0-9\-._~:/?#@!$'()+,;=%]+$/.test(run[0])) {
			found.set(run.index, addressAndRest(run[0])[0].length);
			continue;
		}
		for (const m of run[0].matchAll(BARE_ADDRESS_RE)) found.set(run.index + m.index + m[0].length, 0);
	}
	return found?.size ? found : null;
}

/**
 * Words set down with nothing of their own around them (a link that is not kept as a link is its words alone),
 * closed at their end against what comes after them: a "<" or the start of a named character that ends them would
 * be finished by the text that follows. "&lt;" then a link with no address around "script" then "&gt;" came out
 * as a script tag.
 */
const bare = (md: string) => md.replace(/<$/, "&lt;").replace(/&(#?[0-9A-Za-z]*)$/, "&amp;$1");

// ---- Tags, found without reading any stretch of the page twice ----
//
// Each pass of the converter used to be one pattern of the kind `<x\b[^>]*>([\s\S]*?)<\/x\s*>`. Where the page has no
// ">" or no "</x>" left, such a pattern reads on from every "<x" to the end of the page and finds nothing: a page
// of a hundred thousand "<img " or "<pre>" took the square of its length (7 s for 100 KB, over a minute for 400 KB),
// and the backend, which has one thread, answered no save in that time. The readers below find what those patterns
// found, and stop for good the first time the rest of the page is known to hold no end for them.

/** `html` without its tags: what `/<[^>]+>/g` took out. */
function untagged(html: string): string {
	let lt = html.indexOf("<");
	if (lt < 0) return html;
	let out = "";
	let from = 0;
	while (lt >= 0) {
		const gt = html.indexOf(">", lt + 1);
		// No ">" is left: nothing from here on is a tag.
		if (gt < 0) break;
		// "<>" holds nothing and is no tag.
		if (gt > lt + 1) {
			out += html.slice(from, lt);
			from = gt + 1;
		}
		lt = html.indexOf("<", gt + 1);
	}
	return from ? out + html.slice(from) : html;
}

/** `text` without the spaces and tabs it ends with. `/[ \t]+$/` reads a run of them in the middle of a line once for each of them. */
function endTrimmed(text: string, drop: (code: number) => boolean = (code) => code === 0x20 || code === 0x09): string {
	let end = text.length;
	while (end > 0 && drop(text.charCodeAt(end - 1))) end--;
	return end === text.length ? text : text.slice(0, end);
}

/**
 * Every opening tag that `open` finds the name of (a pattern with the "g" flag, such as `/<hr\b/gi`), up to its
 * first ">": what `<hr\b[^>]*>` found. `write` gives what stands in its place, or null to leave the tag as it is.
 */
function replaceOpenTags(html: string, open: RegExp, write: (tag: string, from: number) => string | null): string {
	let out = "";
	let last = 0;
	let at = 0;
	for (;;) {
		open.lastIndex = at;
		const m = open.exec(html);
		if (!m) break;
		at = m.index + m[0].length;
		const gt = html.indexOf(">", at);
		if (gt < 0) break;
		const put = write(html.slice(m.index, gt + 1), m.index);
		if (put === null) continue;
		out += html.slice(last, m.index) + put;
		last = at = gt + 1;
	}
	return last ? out + html.slice(last) : html;
}

/** Every `<name …>` in `html`, for a caller outside this file: where it stands and its text. */
export function* openTags(html: string, name: string): Generator<{ index: number; tag: string }> {
	const open = new RegExp(`<${name}\\b`, "gi");
	let m: RegExpExecArray | null;
	while ((m = open.exec(html)) !== null) {
		const gt = html.indexOf(">", open.lastIndex);
		if (gt < 0) return;
		yield { index: m.index, tag: html.slice(m.index, gt + 1) };
		open.lastIndex = gt + 1;
	}
}

/** The tags one pass looks for: where one of them opens, and for each name where it closes. */
interface TagSet {
	open: RegExp;
	close: Map<string, RegExp>;
	/** True where the opening tag is its name alone and what follows is read as its content (`<script\b[\s\S]*?…`). */
	bare: boolean;
}

/** `tail` is what a closing tag has after its name: "\\s*>" for `</b >`, ">" where only `</tr>` closes. */
function tagSet(names: string[], tail = "\\s*>", bare = false): TagSet {
	return { open: new RegExp(`<(${names.join("|")})\\b`, "gi"), close: new Map(names.map((name) => [name, new RegExp(`<\\/${name}${tail}`, "gi")])), bare };
}

/**
 * Every `<name …>…</name>` of `tags` in `html`, from the first to the last, none inside another: what
 * `<(names)\b[^>]*>([\s\S]*?)<\/\1\s*>` found. `visit` gets the name in small letters, what the opening tag holds
 * after its name, what stands between the two tags, and where the whole begins and ends. With `first`, the first only.
 *
 * A name with no closing tag in the rest of the page is looked for no more (the pattern read to the end of the page
 * for every one of its opening tags), and nothing is looked for once no ">" is left.
 */
function eachEnclosed(html: string, tags: TagSet, visit: (name: string, attrs: string, inner: string, from: number, to: number) => void, first = false): void {
	let at = 0;
	let unclosed: Set<string> | null = null;
	for (;;) {
		// Set each time round: `visit` may read other text with the same patterns.
		tags.open.lastIndex = at;
		const m = tags.open.exec(html);
		if (!m) return;
		at = m.index + m[0].length;
		const name = m[1]!.toLowerCase();
		if (unclosed?.has(name)) continue;
		const gt = tags.bare ? at - 1 : html.indexOf(">", at);
		if (gt < 0) return;
		const close = tags.close.get(name);
		if (!close) continue;
		close.lastIndex = gt + 1;
		const end = close.exec(html);
		if (!end) {
			unclosed ??= new Set();
			unclosed.add(name);
			if (unclosed.size === tags.close.size) return;
			continue;
		}
		const from = m.index;
		const attrs = tags.bare ? "" : html.slice(at, gt);
		at = end.index + end[0].length;
		visit(name, attrs, html.slice(gt + 1, end.index), from, at);
		if (first) return;
	}
}

/** The first `<name …>…</name>` of `tags` in `html` (see `eachEnclosed`), or null. */
function firstEnclosed(html: string, tags: TagSet): { inner: string; from: number; to: number } | null {
	let found: { inner: string; from: number; to: number } | null = null;
	eachEnclosed(html, tags, (_name, _attrs, inner, from, to) => void (found = { inner, from, to }), true);
	return found;
}

/** `html` with every `<name …>…</name>` of `tags` written by `write` (see `eachEnclosed`). */
function replaceEnclosed(html: string, tags: TagSet, write: (name: string, attrs: string, inner: string, from: number, to: number) => string): string {
	let out = "";
	let last = 0;
	eachEnclosed(html, tags, (name, attrs, inner, from, to) => {
		out += html.slice(last, from) + write(name, attrs, inner, from, to);
		last = to;
	});
	return last ? out + html.slice(last) : html;
}

const QUOTE_OR_END_RE = /[>"']/g;

/**
 * Where the tag ends that is read from `from` with its quoted values honoured (one may hold a ">"): the place of its
 * ">", or -1 where a quote is never closed or no ">" comes. What `(?:[^>"']|"[^"]*"|'[^']*')*>` matched.
 */
function quotedTagEnd(html: string, from: number): number {
	let at = from;
	for (;;) {
		QUOTE_OR_END_RE.lastIndex = at;
		const m = QUOTE_OR_END_RE.exec(html);
		if (!m) return -1;
		if (m[0] === ">") return m.index;
		const closed = html.indexOf(m[0], m.index + 1);
		if (closed < 0) return -1;
		at = closed + 1;
	}
}

/**
 * For every place in `html`, whether a tag read from there (`quotedTagEnd`) comes to its ">". Made once, from the
 * end backwards, when a first tag is found to have no end: each tag after it used to be read to the end of the page
 * to learn the same.
 */
function tagsThatEnd(html: string): Uint8Array {
	const ends = new Uint8Array(html.length + 1);
	let double = -1;
	let single = -1;
	for (let at = html.length - 1; at >= 0; at--) {
		const code = html.charCodeAt(at);
		if (code === 0x3e) ends[at] = 1;
		else if (code === 0x22) {
			ends[at] = double < 0 ? 0 : ends[double + 1]!;
			double = at;
		} else if (code === 0x27) {
			ends[at] = single < 0 ? 0 : ends[single + 1]!;
			single = at;
		} else ends[at] = ends[at + 1]!;
	}
	return ends;
}

/**
 * `html` with every tag that `open` finds the name of written by `write`, the tag read with its quoted values
 * honoured; with `close`, the tag, what follows it and the first closing tag after it, as
 * `<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>` matched. `write` gets the opening tag whole, what it holds
 * after its name, and what stands before the closing tag.
 */
function replaceQuotedTags(html: string, open: RegExp, close: RegExp | null, write: (tag: string, attrs: string, inner: string) => string): string {
	let out = "";
	let last = 0;
	let at = 0;
	let ends: Uint8Array | null = null;
	// No closing tag stands at or after this place.
	let noClose = html.length + 1;
	for (;;) {
		open.lastIndex = at;
		const m = open.exec(html);
		if (!m) break;
		at = m.index + m[0].length;
		if (ends && !ends[at]) continue;
		const gt = quotedTagEnd(html, at);
		if (gt < 0) {
			ends = tagsThatEnd(html);
			continue;
		}
		let to = gt + 1;
		let inner = "";
		if (close) {
			// A tag inside a quoted value of another may end before that one does, so an earlier tag without a closing
			// tag does not settle it for this one. What it does settle is where no closing tag is left.
			if (to >= noClose) continue;
			close.lastIndex = to;
			const end = close.exec(html);
			if (!end) {
				noClose = to;
				continue;
			}
			inner = html.slice(to, end.index);
			to = end.index + end[0].length;
		}
		out += html.slice(last, m.index) + write(html.slice(m.index, gt + 1), html.slice(at, gt), inner);
		last = at = to;
	}
	return last ? out + html.slice(last) : html;
}

/** What a page shows of this HTML, as Markdown words: the tags gone, the references read, the marks written as themselves. */
function words(html: string, inLabel = false, open = false): string {
	const read = readEntities(untagged(html));
	// Where something is written right after these words, the space they end with is dropped first (every caller
	// drops it afterwards): what counts is their last word.
	return literal(open ? read.text.trimEnd() : read.text, read.kept, inLabel, open);
}

/**
 * A line that would read as a heading, a list, a quotation, a rule or a table's second row, and is none: the mark
 * it begins with is written as itself (`plain` in adf.ts). A paragraph that began with "#", "1." or "-" became one.
 */
function plainLine(line: string): string {
	const out = line.replace(/^(\s*)(#{1,6}(?=\s|$)|>|[-+](?=\s|$))/, "$1\\$2").replace(/^(\s*\d+)([.)])(?=\s|$)/, "$1\\$2");
	// A line of dashes or of "=" alone makes a heading of the line above it, however few they are, or a rule (with
	// spaces between them too); with colons or pipes among the dashes it makes a table of the line above.
	return /^\s*[-=|:][-=|: \t]*$/.test(out) && /[-=]/.test(out) ? out.replace(/[-=|:]/, "\\$&") : out;
}

const DANGEROUS_URL_SCHEME_RE = /^(?:javascript|vbscript|data):/i;

function isSafeUrl(url: string): boolean {
	if (!url) return false;
	const cleaned = url.replace(/[\u0000-\u0020]+/g, "");
	return !DANGEROUS_URL_SCHEME_RE.test(cleaned);
}

/** An address that Markdown reads as a link when it stands alone between "<" and ">". */
const AUTOLINK_RE = /^(?:https?:\/\/|mailto:)[^\s<>]*$/i;

/**
 * An address read from an attribute: as words (`said`, for a link whose words are its address) and as Markdown
 * writes it between a link's round brackets (`written`), or null where it is none to keep. Its references are all
 * read before its scheme is judged. What would end the address early or be read again is written as an escape: a
 * space, a round or angle bracket, a double quote and a backslash by their numbers, and an "&" that Markdown would
 * take for a named character as "&amp;". "http://x/a)b" used to end at its ")".
 */
function address(raw: string): { said: string; alone: string; written: string } | null {
	const read = readEntities(raw.trim());
	if (!isSafeUrl(read.text)) return null;
	// A browser drops the space and control characters at either end of an address, and the tabs and line ends inside it.
	// A "\x00" is none of the page's (those are taken out before anything is read): it is one end of what stands in
	// for something set aside. Dropped here it left the other end behind, and a "\x00" in the Markdown.
	const edge = (at: number) => read.text.charCodeAt(at) <= 0x20 && read.text.charCodeAt(at) !== 0;
	let from = 0;
	let to = read.text.length;
	while (from < to && edge(from)) from++;
	while (to > from && edge(to - 1)) to--;
	let written = "";
	for (let at = from; at < to; at++) {
		const ch = read.text[at]!;
		const code = ch.charCodeAt(0);
		if (code < 0x20) continue;
		if (code === 0x7f || /[\s()<>"\\]/.test(ch)) written += code < 0x80 ? `%${code.toString(16).toUpperCase().padStart(2, "0")}` : encodeURIComponent(ch);
		else if (ch === "&" && !read.kept.has(at) && /^&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/.test(read.text.slice(at, at + 40))) written += "&amp;";
		else written += ch;
	}
	// Judged once more as it is written: nothing taken out above may have made a scheme of what was none.
	if (!written || !isSafeUrl(written)) return null;
	const kept = new Set([...read.kept].filter((at) => at >= from && at < to).map((at) => at - from));
	// `alone` is the address as words with nothing of a link around them: closed against what is written after them
	// (see `openAddresses`).
	return { said: literal(read.text.slice(from, to), kept, true), alone: literal(read.text.slice(from, to), kept, true, true), written };
}

/**
 * An address from a document of another kind (a link in a Word file), as Markdown writes it between a link's round
 * brackets, or null where it is none to keep: the same reading and the same refusals as for a page's own links.
 */
export function linkAddress(raw: string): string | null {
	return address(raw)?.written ?? null;
}

/** An attribute's value as the words of a picture, on one line. `open`: the words are not closed by a "](" after them. */
function attrWords(tag: string, name: string, open: boolean): string {
	const read = readEntities(rawAttr(tag, name));
	return literal(read.text.trimEnd(), read.kept, true, open).replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
	return decodeHtmlEntities(untagged(html));
}

/** Text between backticks enough to hold it: one more than its longest run of them, and room where it begins or ends with one. */
function codeSpan(text: string): string {
	if (!text) return "";
	const fence = "`".repeat(1 + Array.from(text.matchAll(/`+/g)).reduce((most, m) => Math.max(most, m[0].length), 0));
	const room = /^`|`$/.test(text) ? " " : "";
	return `${fence}${room}${text}${room}${fence}`;
}

/** What a page shows of this HTML, written as HTML again: for the places where Markdown is not read (inside a tag of its own). */
function htmlWords(html: string): string {
	return stripTags(html).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\s+/g, " ").trim();
}

function escapePipeCell(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\n+/g, "<br>")
		.replace(/\|/g, "\\|")
		.trim();
}

function rawAttr(tag: string, name: string): string {
	const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, "i");
	const m = re.exec(tag);
	return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

function attrOf(tag: string, name: string): string {
	return decodeHtmlEntities(rawAttr(tag, name));
}

/** `html` without its comments: what `/<!--[\s\S]*?-->/g` took out. */
function uncommented(html: string): string {
	let open = html.indexOf("<!--");
	if (open < 0) return html;
	let out = "";
	let from = 0;
	while (open >= 0) {
		const close = html.indexOf("-->", open + 4);
		if (close < 0) break;
		out += html.slice(from, open);
		from = close + 3;
		open = html.indexOf("<!--", from);
	}
	return from ? out + html.slice(from) : html;
}

/**
 * True where a tag that `open` finds (its name and one space, such as `/<a\s/gi`) has `attr` in it before its ">":
 * what `<a\s+[^>]*href\b` found. The next `attr` and the next ">" are each looked for once for the stretch they
 * settle, not once for every tag before them.
 */
function hasTagWith(html: string, open: RegExp, attr: RegExp): boolean {
	let at = 0;
	let found = -1;
	let gt = -1;
	for (;;) {
		open.lastIndex = at;
		const m = open.exec(html);
		if (!m) return false;
		at = m.index + m[0].length;
		if (found < at) {
			attr.lastIndex = at;
			const next = attr.exec(html);
			if (!next) return false;
			found = next.index;
		}
		if (gt < at) {
			gt = html.indexOf(">", at);
			if (gt < 0) gt = html.length;
		}
		if (found < gt) return true;
	}
}

const PASTE_HIDDEN = tagSet(["style", "script"], "\\s*>", true);

/** True when an HTML clipboard fragment carries real semantic formatting worth converting. */
export function looksLikeRichHtml(html: string): boolean {
	if (!html || html.length < 6) return false;
	// Exclude plain VS Code / Monaco / editor HTML wrappers that only emit styled <div><span> lines.
	const stripped = replaceOpenTags(
		replaceEnclosed(uncommented(html), PASTE_HIDDEN, () => ""),
		/<meta/gi,
		() => "",
	);
	if (/<(h[1-6]|table|ul|ol|li|strong|b\b|em|i\b|code|pre|blockquote|del|s\b|hr|details)\b/i.test(stripped)) return true;
	// A link with an address and a picture with a source. As one pattern (`a\s+[^>]*href`), each "<a " of a page
	// with no ">" was read to the end of the page.
	return hasTagWith(stripped, /<a\s/gi, /href\b/gi) || hasTagWith(stripped, /<img\s/gi, /src\b/gi);
}

/**
 * Replaces outermost balanced `<tag ...>...</tag>` blocks for any tag in `tagNames`
 * (case-insensitive) in a single linear pass, preserving arbitrarily nested same-name tags
 * and tolerating optional whitespace before `>` in closing tags (`</tag >`).
 */
function replaceBalancedTags(
	html: string,
	tagNames: readonly string[],
	replacer: (tag: string, attrs: string, inner: string) => string,
): string {
	// The tag's name only; its ">" is looked for from there. With `([^>]*)>` in the pattern, every "<ul " of a page
	// with no ">" left was read to the end of the page.
	const tagRe = new RegExp(`<(\\/?)(${tagNames.join("|")})(?=[\\s>/])`, "gi");
	let out = "";
	let cursor = 0;
	let rootTag: string | null = null;
	let rootAttrs = "";
	let rootStart = 0;
	let innerStart = 0;
	let depth = 0;
	let at = 0;

	for (;;) {
		// Set each time round: `replacer` may read other text for the same tags.
		tagRe.lastIndex = at;
		const m = tagRe.exec(html);
		if (!m) break;
		const gt = html.indexOf(">", m.index + m[0].length);
		if (gt < 0) break;
		at = gt + 1;
		const isClose = m[1] === "/";
		const tag = m[2]!.toLowerCase();
		const attrs = html.slice(m.index + m[0].length, gt);
		const isSelfClose = !isClose && /\/\s*$/.test(attrs);

		if (rootTag === null) {
			if (isClose) continue;
			if (isSelfClose) {
				out += html.slice(cursor, m.index) + replacer(tag, attrs, "");
				cursor = at;
				continue;
			}
			rootTag = tag;
			rootAttrs = attrs;
			rootStart = m.index;
			innerStart = at;
			depth = 1;
		} else if (tag === rootTag) {
			if (isClose) {
				depth--;
				if (depth === 0) {
					out += html.slice(cursor, rootStart) + replacer(rootTag, rootAttrs, html.slice(innerStart, m.index));
					cursor = at;
					rootTag = null;
				}
			} else if (!isSelfClose) {
				depth++;
			}
		}
	}
	if (cursor === 0) return html;
	return out + html.slice(cursor);
}

/**
 * A block set aside while the text around it is read: a "\x00B<part>_<n>\x00" stands in its place until it is put
 * back. Every part of one call shares the one set (a quotation and the body of a details block are read as parts
 * of their own), so that each can tell what a stand-in it meets stands for.
 */
interface Held {
	/** The block as Markdown, as it stands on lines of its own. */
	md: string;
	/** A code block's own text and its language. How it is written depends on where it lands, so both are kept. */
	code?: string;
	lang?: string;
	/**
	 * True for a code block and for every block with the code of one in it. Such a block is only ever written on
	 * lines of its own, after an empty line. It used to be put back wherever its stand-in had come to stand: in the
	 * middle of a list item's line, where the opening fence was then no fence and the closing one opened a block
	 * that took the rest of the document, or inside another block set aside, where it was never put back at all.
	 *
	 * True for a details block too, and for every block with one in it. It is written as HTML, and what follows a
	 * "</details>" on its line, or on the lines under it up to the next empty one, is read as HTML with it. Put
	 * back inside a link's words or bold text, it had the rest of the paragraph on that line: inline code there that
	 * showed "<img onerror=…>" as code was that tag in the file.
	 */
	apart: boolean;
}

const HELD_START = "\x00B";
const HELD_RE = /\x00B(\d+_\d+)\x00/g;
/** The blocks the call in hand has set aside, by "<part>_<n>". */
let held = new Map<string, Held>();
/** True once the call in hand has set a block aside that stands apart. Until then no text is searched for one. */
let anyApart = false;
/** Moves each time a block that stands apart is written into text: a block built while it moved has code in it. */
let apartPut = 0;

/** A block set aside that was found in a text: what stands in for it there, and the block. */
interface Apart {
	standIn: string;
	slot: Held;
}

/**
 * `text` cut at the blocks in it that stand apart: the text between them, and those blocks. One part where there is
 * none. With `also` it is cut at every other block whose name begins so as well: "<part>_" for all that one part
 * set aside, "" for every block there is.
 */
function apartParts(text: string, also: string | null = null): (string | Apart)[] {
	if ((also === null && !anyApart) || !text.includes(HELD_START)) return [text];
	const parts: (string | Apart)[] = [];
	let from = 0;
	for (const m of text.matchAll(HELD_RE)) {
		const slot = held.get(m[1]!);
		if (!slot || !(slot.apart || (also !== null && m[1]!.startsWith(also)))) continue;
		parts.push(text.slice(from, m.index), { standIn: m[0], slot });
		from = m.index + m[0].length;
	}
	parts.push(text.slice(from));
	return parts;
}

/** True where a block that stands apart is set aside in `text`. */
function holdsApart(text: string): boolean {
	if (!anyApart || !text.includes(HELD_START)) return false;
	for (const m of text.matchAll(HELD_RE)) {
		if (held.get(m[1]!)?.apart) return true;
	}
	return false;
}

/**
 * Code between fences. At the top of a document the fence is longer than any line of backticks in the code: a line
 * of three inside it would have ended the block there. `inside` is for a block each of whose lines gets a mark or
 * an indent (a quotation, a list item): the fence is longer than any run of backticks at all, and a carriage return
 * that the page wrote by its number ends a line as it does for Markdown, where it left the rest of its line with no
 * mark before it, and so outside the quotation and its fence.
 */
function fencedCode(code: string, lang: string, inside: boolean): string {
	const body = inside ? code.replace(/\r\n?/g, "\n") : code;
	const longest = Array.from(body.matchAll(inside ? /`+/g : /^[ \t]*(`+)/gm)).reduce((most, m) => Math.max(most, (m[1] ?? m[0]).length), 2);
	const fence = "`".repeat(1 + longest);
	return `${fence}${lang}\n${body}\n${fence}`;
}

/** A block set aside with every block set aside in it put back, however deep: as it is when it must stand complete. */
function whole(slot: Held): string {
	if (slot.code !== undefined) return fencedCode(slot.code, slot.lang ?? "", true);
	if (!slot.md.includes(HELD_START)) return slot.md;
	return slot.md.replace(HELD_RE, (_m, key: string) => {
		const inner = held.get(key);
		return inner ? whole(inner) : "";
	});
}

/**
 * `text` with every block that stands apart put back whole, whichever part of the call set it aside. For text whose
 * lines each get a mark next: a code block from further out was put back after the marks were written, so that
 * only its first line had one (a quotation in a quotation gave "> > ```" and then the code under a single ">").
 * With `all`, every block still set aside is put back, not only those that stand apart.
 */
function settle(text: string, all = false): string {
	if ((!all && !anyApart) || !text.includes(HELD_START)) return text;
	return text.replace(HELD_RE, (m, key: string) => {
		const slot = held.get(key);
		if (!slot) return all ? "" : m;
		if (!slot.apart && !all) return m;
		if (slot.apart) apartPut++;
		return whole(slot);
	});
}

/** A block set aside as words on one line: for where neither a block nor code can stand (a picture's words, a summary). */
function blockWords(slot: Held): string {
	return (slot.code ?? whole(slot)).replace(/\s+/g, " ").trim();
}

/**
 * `text` as inline code for a cell of a table: cut after every backslash that stands before a "|", each piece as
 * inline code of its own, to be joined by the "|".
 *
 * A "|" ends the cell, in code too, unless a backslash is written before it, which the table takes away again. A
 * backslash of the code's own before a "|" made "\\|" of the two: a backslash, and the end of the cell in the
 * middle of the code, whose other half was then read as Markdown and as HTML.
 */
function cellSpans(text: string): string[] {
	const spans: string[] = [];
	let from = 0;
	for (const m of text.matchAll(/\\\|/g)) {
		spans.push(codeSpan(text.slice(from, m.index + 1)));
		from = m.index + 2;
	}
	spans.push(codeSpan(text.slice(from)));
	return spans;
}

/**
 * True while the words of a table cell are read. Inline code in a cell is cut at "\\|" as a code block there is
 * (`cellSpans`). Written whole, it ends the cell in its middle: what came after the "|" was then read as Markdown
 * and as HTML in the next cell, and a page that showed "<img onerror=…>" as code gave a file with that tag in it.
 * This was first done only for a cell with a code block in it, where the backtick left over took the code block's
 * first backtick for its other end; it is the same in every cell.
 */
let inCell = false;

/**
 * A code block as one cell of a table holds it: every line as inline code, the lines parted by "<br>". A row is
 * one line, so the cell can hold no fenced block.
 */
function cellCode(code: string): string {
	const lines = code.split(/\r\n?|\n/).map((line) =>
		cellSpans(line.trimEnd())
			.map((span) => span.replace(/\|/g, "\\|"))
			.join("\\|"),
	);
	let first = 0;
	let last = lines.length;
	while (first < last && !lines[first]) first++;
	while (last > first && !lines[last - 1]) last--;
	return lines.slice(first, last).join("<br>");
}

const ROW_TAGS = tagSet(["tr"], ">");
const CELL_TAGS = tagSet(["th", "td"], ">");

/**
 * A table as Markdown, and what of it cannot be written in one: `outside` has the stand-ins of the blocks with
 * code that stood in the table but in none of the cells read here (a caption, a cell never closed). What else
 * stands there is left out, as it always was; code is not. `code` says that a cell holds code from a code block.
 */
function convertTable(tableHtml: string): { md: string; outside: string[]; code: boolean } {
	const rows: { cells: string[]; isHeader: boolean }[] = [];
	const watch = tableHtml.includes(HELD_START);
	let loose = "";
	let rowEnd = 0;
	let code = false;
	eachEnclosed(tableHtml, ROW_TAGS, (_tr, _trAttrs, rowBody, rowFrom, rowTo) => {
		const cells: string[] = [];
		let thCount = 0;
		let cellEnd = 0;
		if (watch) loose += tableHtml.slice(rowEnd, rowFrom);
		rowEnd = rowTo;
		eachEnclosed(rowBody, CELL_TAGS, (name, _attrs, cell, cellFrom, cellTo) => {
			if (name === "th") thCount++;
			if (watch) loose += rowBody.slice(cellEnd, cellFrom);
			cellEnd = cellTo;
			inCell = true;
			let inner: string;
			try {
				inner = convertInline(cell);
			} finally {
				inCell = false;
			}
			if (apartParts(inner).length === 1) {
				cells.push(escapePipeCell(inner));
				return;
			}
			// A code block in a cell: the cell's own words and the code, each on a line of the cell. What stood in for
			// the code was left in the cell, never put back, and a "\x00" went into the Markdown in place of the code.
			// Whatever else is set aside in such a cell is written on the cell's one line too: put back later, as
			// lines of its own, it would end the row before the code.
			code = true;
			const shown = apartParts(inner, "").map((part) => (typeof part === "string" ? escapePipeCell(part.trim()) : part.slot.code !== undefined ? cellCode(part.slot.code) : escapePipeCell(whole(part.slot))));
			cells.push(shown.filter(Boolean).join("<br>"));
		});
		if (watch) loose += rowBody.slice(cellEnd);
		if (cells.length) rows.push({ cells, isHeader: thCount === cells.length });
	});
	const outside: string[] = [];
	if (watch) {
		for (const part of apartParts(loose + tableHtml.slice(rowEnd))) {
			if (typeof part !== "string") outside.push(part.standIn);
		}
	}
	if (!rows.length) return { md: "", outside, code };
	const width = Math.max(...rows.map((r) => r.cells.length));
	const pad = (cells: string[]) => {
		const out = cells.slice();
		while (out.length < width) out.push("");
		return `| ${out.join(" | ")} |`;
	};
	const header = rows[0]!.cells;
	const sep = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
	const body = rows.slice(1).map((r) => pad(r.cells));
	return { md: `\n\n${pad(header)}\n${sep}${body.length ? `\n${body.join("\n")}` : ""}\n\n`, outside, code };
}

const CODE_TAGS = tagSet(["code"]);
const BOLD_TAGS = tagSet(["strong", "b"]);
const ITALIC_TAGS = tagSet(["em", "i"]);
const STRUCK_TAGS = tagSet(["del", "s", "strike"]);
const MARK_TAGS = tagSet(["mark"]);

/** `open`: these are the words of a mark, and the mark's own sign is written right after them (see `literal`). */
function convertInlineInner(html: string, slots: string[], inLabel = false, open = false): string {
	let s = html;
	const stash = (value: string) => {
		if (!value) return "";
		const idx = slots.push(value) - 1;
		return `\x00INL${idx}\x00`;
	};
	// A mark (bold, a link, inline code) holds words. A block that stands apart cannot be written inside one, so
	// the mark ends before such a block and begins again after it, and the block is left between the two on lines
	// of its own. "<a><pre>" used to give "[```" with the code under it, outside any fence. `cut` tells the writer
	// that it has a piece of what the mark held, not all of it.
	const around = (inner: string, write: (piece: string, cut: boolean) => string) => {
		const parts = apartParts(inner);
		if (parts.length === 1) return write(inner, false);
		return parts.map((part) => (typeof part !== "string" ? `\n\n${part.standIn}\n\n` : part.trim() ? write(part.trim(), true) : "")).join("");
	};
	const within = (sign: string) => (piece: string) => {
		const t = convertInlineInner(piece, slots, inLabel, true).trim();
		return t ? stash(`${sign}${t}${sign}`) : "";
	};
	// A picture with no source is written "[Image: its words]" and a checkbox "[x] ", and both are set aside before
	// it is known that they stand among a link's words. There their brackets are written by their numbers, as every
	// bracket of a link's words is: the editor's reader takes "[Image: x]" inside "[…](address)" for a link of its
	// own, has no link around it then, and reads the address as running text that takes the inline code after it
	// along.
	const inLink = (label: string, depth = 0) => {
		if (depth > 32 || !label.includes("\x00INL")) return;
		for (const m of label.matchAll(/\x00INL(\d+)\x00/g)) {
			const at = Number(m[1]);
			const value = slots[at] ?? "";
			if ((value.startsWith("[Image: ") && value.endsWith("]")) || value === "[x] " || value === "[ ] ") slots[at] = `&#91;${value.slice(1, value.lastIndexOf("]"))}&#93;${value.slice(value.lastIndexOf("]") + 1)}`;
			else inLink(value, depth + 1);
		}
	};
	const holdsCode = (text: string) => {
		if (!text.includes("\x00INL")) return false;
		for (const m of text.matchAll(/\x00INL(\d+)\x00/g)) if (slots[Number(m[1])]?.startsWith(CODE_SLOT)) return true;
		return false;
	};
	// Line breaks
	s = s.replace(/<br\s*\/?>/gi, "\n");
	// Inline code first so inner tags/asterisks stay untouched
	// Set aside as its text, not yet between backticks: how many it needs and where it must be cut is known only
	// when what stands beside it is (see `convertInline`).
	s = replaceEnclosed(s, CODE_TAGS, (_name, _attrs, inner) =>
		around(inner, (piece) => {
			const text = stripTags(piece).replace(/\r\n?/g, "\n").replace(/\n/g, " ");
			return text ? stash(CODE_SLOT + text) : "";
		}),
	);
	// Images (quote-aware tag match so `>` inside quoted attrs cannot truncate tag; reject dangerous URL schemes)
	s = replaceQuotedTags(s, /<img\b/gi, null, (tag) => {
		const src = address(rawAttr(tag, "src"));
		// A picture's words are one line and hold no block: one that stands apart is written there as its words.
		const alt = apartParts(attrWords(tag, "alt", !src))
			.map((part) => (typeof part === "string" ? part : literal(blockWords(part.slot), undefined, true, !src)))
			.join("");
		return stash(src ? `![${alt}](${src.written})` : alt ? `[Image: ${alt}]` : "");
	});
	// Links (quote-aware attrs; reject dangerous URL schemes)
	s = replaceQuotedTags(s, /<a\b/gi, /<\/a\s*>/gi, (_tag, attrs, inner) => {
		const href = address(rawAttr(`<a ${attrs}>`, "href"));
		return around(inner, (piece, cut) => {
			// The words of a link end at its "](", so an address that ends them has nothing written right after it. Not
			// so the words of a link with no address, and not words with code in them: marked makes no link of
			// "[words](address)" where the code has a backtick of its own, and reads the words as running text.
			// (Inline code is set aside by now: it is known by what stands in for it.)
			const label = convertInlineInner(piece, slots, true, !href || holdsCode(piece)).replace(/\s+/g, " ").trim();
			if (!href) return stash(bare(label));
			// An address between "<" and ">" is a link only where Markdown knows it for an address; any other would be read as a tag.
			const alone = AUTOLINK_RE.test(href.written) ? `<${href.written}>` : "";
			// A link with no words is written as its address, but not a piece of one beside a code block that has none.
			if (!label) return cut ? "" : stash(alone || bare(href.alone));
			if (label === href.said && alone) return stash(alone);
			inLink(label);
			return stash(`[${label}](${href.written})`);
		});
	});
	// Emphasis, bold, strike, mark
	s = replaceEnclosed(s, BOLD_TAGS, (_name, _attrs, inner) => around(inner, within("**")));
	s = replaceEnclosed(s, ITALIC_TAGS, (_name, _attrs, inner) => around(inner, within("*")));
	s = replaceEnclosed(s, STRUCK_TAGS, (_name, _attrs, inner) => around(inner, within("~~")));
	s = replaceEnclosed(s, MARK_TAGS, (_name, _attrs, inner) => around(inner, within("==")));
	// Task checkboxes
	s = replaceOpenTags(s, /<input\b/gi, (tag) => (/type=["']?checkbox/i.test(tag) ? stash(/\bchecked\b/i.test(tag) ? "[x] " : "[ ] ") : null));
	// Remaining tags, and then the words: what the page showed, with nothing in it for Markdown to read as a mark.
	return words(s, inLabel, open);
}

/** What the text of inline code begins with where it is set aside (a "\x00" is in no text of the page's). */
const CODE_SLOT = "\x00C";

function convertInline(html: string): string {
	const slots: string[] = [];
	let s = convertInlineInner(html, slots);
	// The marks first (bold, links, pictures), inline code last, when it is known what each piece of it stands beside.
	for (let pass = 0, more = s.includes("\x00INL"); more && pass < 32; pass++) {
		more = false;
		s = s.replace(/\x00INL(\d+)\x00/g, (m, idx: string) => {
			const value = slots[Number(idx)] ?? "";
			if (value.startsWith(CODE_SLOT)) return m;
			more = true;
			return value;
		});
	}
	if (!s.includes("\x00INL")) return s;
	// The address of a link or a picture that has inline code after it with no space between is written between
	// "<" and ">". Where a reader does not make a link of "[words](address)" (see `inLink`, and the note at the
	// link's words), it reads the address as running text, on to the next space: through the backtick that opens
	// the code. Between "<" and ">" it ends there.
	if (s.includes("](") && HAS_ADDRESS_RE.test(s)) {
		s = s.replace(/\S+/g, (word) => {
			const code = word.lastIndexOf("\x00INL");
			if (code < 0 || !word.includes("](")) return word;
			return word.slice(0, code).replace(/\]\(([^()\s<>\x00]*)\)/g, (link, to: string) => (HAS_ADDRESS_RE.test(to) ? `](<${to}>)` : link)) + word.slice(code);
		});
	}
	// Inline code is written between backticks, and backticks that touch run together:
	// - two pieces side by side ("<code>a</code><code>b</code>") were written "`a``b`", which is no code at all, and
	//   what the second showed as code ("<img onerror=…>") was a tag in the file. They are one piece of code;
	// - a backtick of the text right before a piece is written by its number: after "\`" the editor's reader takes
	//   the next backtick for more of the same run, not for the start of code.
	// In a table cell the code is cut at "\|" (see `inCell`); the "|" between the pieces is written as every "|" of
	// the cell is, once the cell's words are whole.
	const span = (text: string) => (inCell ? cellSpans(text).join("|") : codeSpan(text));
	return s.replace(/(\\`)?((?:\x00INL\d+\x00)+)/g, (_m, tick: string | undefined, run: string) => {
		let out = "";
		let code = "";
		let first = true;
		const put = (text: string, isCode: boolean) => {
			if (!text) return;
			out += first && tick ? (isCode ? "&#96;" : tick) : "";
			out += text;
			first = false;
		};
		for (const m of run.matchAll(/\x00INL(\d+)\x00/g)) {
			const value = slots[Number(m[1])] ?? "";
			if (value.startsWith(CODE_SLOT)) {
				code += value.slice(CODE_SLOT.length);
				continue;
			}
			// A mark left unread (they are read to a depth of 32) stays as it was.
			put(span(code), true);
			code = "";
			put(m[0], false);
		}
		put(span(code), true);
		return first && tick ? tick : out;
	});
}

/**
 * A list as Markdown, each of its lines after `indent`.
 *
 * `blocks` is for a list with a block set aside in it: a code block, a details block, a table, a quotation. (It was
 * first for a list with code only. Without code, a details block was still written in the middle of its item's
 * line, and its "</details>" took the items below for HTML: inline code in them that showed "<script>" as code was
 * a script tag in the file.) Such a list is written so that every block of an item is read as a block of that item,
 * where a list of words alone is written as it always was:
 * - every block set aside in an item is a block of the item, not only those that stand apart. One left in the
 *   middle of the item's line (a details block, a table) is read with the lines under it as one HTML block or one
 *   paragraph, and the items below with them;
 * - a nested list is indented as far as its item's text is, not by two spaces whatever the marker: under "1. " two
 *   spaces make the nested items items of the outer list, and what is nested deeper still text of theirs. A code
 *   block there stood four spaces in under nothing and was shown as code with its fences in it.
 */
function convertList(listHtml: string, ordered: boolean, indent = "", blocks = false, depth = 1): string {
	const out: string[] = [];
	let itemIdx = 1;
	// An empty line is due before what the list writes next: a block of an item stands above.
	let gap = false;
	const put = (lines: string) => {
		if (gap) out.push("");
		gap = false;
		out.push(lines);
	};
	/**
	 * A block set aside, as a block of the list: its first line after `first`, the others indented by `pad`.
	 *
	 * An empty line goes before it, always. With one, the block is code however the lines above are read: a fenced
	 * block where its indent is that of an item's text, an indented one should it stand deeper. Without one, a block
	 * under a line that is not read as an item would be more of that line's paragraph, and its code text.
	 */
	const putBlock = (slot: Held, first: string, pad: string): boolean => {
		const text = whole(slot);
		// A block with nothing in it (a table without rows) writes no line. Written as an empty one, it took the item's
		// marker with it, and the item's words stood under it as a paragraph of no list.
		if (!text.trim()) return false;
		apartPut++;
		if (out.length || indent) out.push("");
		out.push(
			text
				.split("\n")
				.map((line, at) => (line ? `${at ? pad : first}${line}` : ""))
				.join("\n"),
		);
		gap = true;
		return true;
	};

	const emitItem = (rawItem: string) => {
		const nested: { html: string; ordered: boolean }[] = [];
		// At the deepest level that is written (`DEEPEST`), the lists of an item are no lists of their own: their
		// items are words of this item, each parted from the next.
		const strippedItem =
			depth >= DEEPEST
				? replaceOpenTags(rawItem, /<\/?(?:ul|ol|li)(?=[\s>/])/gi, () => "\n")
				: replaceBalancedTags(rawItem, ["ul", "ol"], (tag, _attrs, inner) => {
						nested.push({ html: inner, ordered: tag === "ol" });
						return "";
					});
		// A run of space with a line end in it, or of two and more, is one space. (As two patterns, `\s*\n\s*` and then
		// `\s{2,}`, the first read a long run with no line end in it once for each of its characters.)
		const oneLine = (text: string) => text.replace(/\s+/g, (run) => (run.length > 1 || run === "\n" ? " " : run)).trim();
		// The item's words are one line. A code block in the item is a block of the item: on lines of its own under
		// the words, indented as far as the item's text is, so that it stays in the item and the list goes on after
		// it. Its fence used to follow the words on their line ("1. Run the query: ```"), where it is no fence.
		const parts = apartParts(convertInline(strippedItem), blocks ? "" : null);
		const marker = ordered ? `${itemIdx++}. ` : "- ";
		// What the item's next line begins with: its marker, once, and after that the indent of its text.
		let lead = `${indent}${marker}`;
		const pad = " ".repeat(lead.length);
		for (const part of parts) {
			if (typeof part !== "string") {
				if (putBlock(part.slot, lead, pad)) lead = pad;
				continue;
			}
			const text = oneLine(part);
			if (!text) continue;
			put(`${lead}${plainLine(text)}`);
			lead = pad;
		}
		// An item that wrote no line of its own has no text for its lists to stand under: they take its place.
		const under = !blocks ? `${indent}  ` : lead === pad ? pad : indent;
		for (const list of nested) {
			const nb = convertList(list.html, list.ordered, under, blocks, depth + 1);
			if (nb.trim()) put(nb);
		}
	};
	// What stands in a list between its items is in no item and is left out, as it always was. A block with code
	// in it is not: it is written where it stood, at the indent of the list.
	const between = (from: number, to: number) => {
		if (!anyApart) return;
		for (const part of apartParts(listHtml.slice(from, to))) {
			if (typeof part !== "string") putBlock(part.slot, indent, indent);
		}
	};

	// Match top-level <li> elements inside this list by tracking nested <li> depth.
	const liRe = /<(\/?)li(?=[\s>/])/gi;
	let nest = 0;
	let itemStart = -1;
	let itemEnd = 0;
	let at = 0;
	for (;;) {
		// Set each time round: an item's own lists are read with a pattern of their own, but nothing is left to chance.
		liRe.lastIndex = at;
		const m = liRe.exec(listHtml);
		if (!m) break;
		const gt = listHtml.indexOf(">", m.index + m[0].length);
		if (gt < 0) break;
		at = gt + 1;
		const isClose = m[1] === "/";
		if (!isClose) {
			if (nest === 0) {
				between(itemEnd, m.index);
				itemStart = at;
			}
			nest++;
		} else if (nest > 0) {
			nest--;
			if (nest === 0 && itemStart >= 0) {
				emitItem(listHtml.slice(itemStart, m.index));
				itemStart = -1;
				itemEnd = at;
			}
		}
	}
	if (nest > 0 && itemStart >= 0) {
		emitItem(listHtml.slice(itemStart));
	} else {
		between(itemEnd, listHtml.length);
	}
	return out.join("\n");
}

let blockSlotSeq = 0;

const HIDDEN_TAGS = tagSet(["script", "style", "head", "noscript", "svg"], "\\s*>", true);
const BODY_TAGS = tagSet(["body"]);
const TABLE_TAGS = tagSet(["table"]);
const SUMMARY_TAGS = tagSet(["summary"]);
const HEADING_TAGS = tagSet(["h1", "h2", "h3", "h4", "h5", "h6"]);

const PRE_OPEN_RE = /<pre\b/gi;
const PRE_CLOSE_RE = /<\/pre\s*>/gi;
const CODE_OPEN_RE = /<code\b/iy;
const SPACE_RE = /\s/;

/**
 * `html` with every `<pre>` block written by `write`, which gets the block's text and, where the block opens with a
 * `<code …>`, what that tag holds after its name. The block is what
 * `<pre\b[^>]*>\s*(?:<code\b([^>]*)>)?([\s\S]*?)(?:<\/code\s*>)?\s*<\/pre\s*>` matched; as that one pattern, every
 * `<pre>` of a page with no `</pre>` left was read to the end of the page, twice.
 */
function replacePre(html: string, write: (codeAttrs: string | undefined, inner: string) => string): string {
	let out = "";
	let last = 0;
	let at = 0;
	for (;;) {
		PRE_OPEN_RE.lastIndex = at;
		const m = PRE_OPEN_RE.exec(html);
		if (!m) break;
		at = m.index + m[0].length;
		const gt = html.indexOf(">", at);
		if (gt < 0) break;
		// The space after the opening tag is no part of the block's text.
		let start = gt + 1;
		while (start < html.length && SPACE_RE.test(html[start]!)) start++;
		// A `<code …>` that stands there is the block's own, where a `</pre>` follows it. Where none does, it is read
		// as text of the block, and the `</pre>` may be found in it ("<pre><code</pre>").
		let codeAttrs: string | undefined;
		let end: RegExpExecArray | null = null;
		CODE_OPEN_RE.lastIndex = start;
		if (CODE_OPEN_RE.test(html)) {
			const codeGt = html.indexOf(">", start + 5);
			if (codeGt >= 0) {
				PRE_CLOSE_RE.lastIndex = codeGt + 1;
				end = PRE_CLOSE_RE.exec(html);
				if (end) {
					codeAttrs = html.slice(start + 5, codeGt);
					start = codeGt + 1;
				}
			}
		}
		if (!end) {
			PRE_CLOSE_RE.lastIndex = start;
			end = PRE_CLOSE_RE.exec(html);
			// No `</pre>` is left for this block, and so none for any block after it.
			if (!end) break;
		}
		// The text ends before the space that stands before `</pre>`, and before a `</code>` that stands before that.
		let stop = end.index;
		while (stop > start && SPACE_RE.test(html[stop - 1]!)) stop--;
		if (stop > start && html[stop - 1] === ">") {
			let name = stop - 1;
			while (name > start && SPACE_RE.test(html[name - 1]!)) name--;
			if (name - 6 >= start && html.slice(name - 6, name).toLowerCase() === "</code") stop = name - 6;
		}
		out += html.slice(last, m.index) + write(codeAttrs, html.slice(start, stop));
		last = at = end.index + end[0].length;
	}
	return last ? out + html.slice(last) : html;
}

/**
 * How deep quotations, details blocks and lists are written inside one another. Each is read as a part of its own
 * within the one around it, so the work is the page's length times its depth, and so is what is written (every
 * line of a quotation has a mark for each quotation around it). A page of ten thousand `<blockquote>` in one another
 * ended in a RangeError, the stack used up, and three thousand lists in one another took forty seconds.
 *
 * What stands deeper than this is kept as words and loses its form: a quotation or a details block becomes
 * paragraphs of the one around it, and the items of a list become words on the line of the item they stand in. A
 * code block in it is still a code block. No page written by hand comes near this depth.
 */
const DEEPEST = 32;

/** `top` is the document itself; without it, what a quotation or a details block holds, `depth` of them deep. */
function htmlToMarkdownInner(html: string, top = false, depth = 0): string {
	if (!html) return "";
	let s = replaceEnclosed(uncommented(html.replace(/\r\n?/g, "\n").replace(/<!--StartFragment-->|<!--EndFragment-->/gi, "")), HIDDEN_TAGS, () => "");

	// Extract full HTML body when present
	const bodyMatch = firstEnclosed(s, BODY_TAGS);
	if (bodyMatch) s = bodyMatch.inner;

	const callId = ++blockSlotSeq;
	const own = `${callId}_`;
	let count = 0;
	const stash = (md: string, apart = false, code?: { text: string; lang: string }) => {
		const key = `${own}${count++}`;
		if (apart) anyApart = true;
		// A block that still has the stand-in of one that stands apart in it (the body of a details block is put
		// back further out) stands apart itself.
		held.set(key, { md, apart: apart || holdsApart(md), code: code?.text, lang: code?.lang });
		return `\n\n\x00B${key}\x00\n\n`;
	};
	const slotRe = new RegExp(`\\x00B(${callId}_\\d+)\\x00`, "g");
	// Puts back the blocks this part set aside, where their stand-ins are in `text`. Nothing this part sets aside
	// may keep such a stand-in in it: they are put back in one pass, and what is put back is not read again (a
	// table kept the stand-in of the code in its cell, a heading that of anything in it). `asRead` is for a code
	// block at the top of the document, which is written as it always was.
	const restore = (text: string, asRead = false) =>
		text.replace(slotRe, (_m, key: string) => {
			const slot = held.get(key);
			if (!slot) return "";
			if (slot.apart) apartPut++;
			return slot.code === undefined || asRead ? slot.md : whole(slot);
		});

	// Preformatted code blocks first
	s = replacePre(s, (codeAttrs, inner) => {
		const cls = codeAttrs ? attrOf(`<code ${codeAttrs}>`, "class") : "";
		const langMatch = /\b(?:language|lang)-([a-z0-9_+-]+)\b/i.exec(cls);
		const lang = langMatch?.[1]?.toLowerCase() ?? "";
		// Without the line ends at its two ends. (`/^\n+|\n+$/g` read a run of them in the middle once for each of them.)
		const text = stripTags(inner);
		let lead = 0;
		while (text.charCodeAt(lead) === 0x0a) lead++;
		const body = endTrimmed(text.slice(lead), (code) => code === 0x0a);
		return stash(fencedCode(body, lang, false), true, { text: body, lang });
	});

	// Tables
	const withTables = s;
	s = replaceEnclosed(s, TABLE_TAGS, (_name, _attrs, _inner, from, to) => {
		const table = convertTable(withTables.slice(from, to));
		const md = table.md.trim();
		// Code that stood in the table outside its cells comes before it. A table of which nothing else is left is
		// then not set aside as an empty block: inside struck text that came out as "~~~~", which is a fence.
		const before = table.outside.map((standIn) => `\n\n${standIn}\n\n`).join("");
		return md || !before ? before + stash(md, table.code) : before;
	});

	// Details/summary (balanced tag matching so nested <details> preserve outer content)
	const deep = depth >= DEEPEST;
	// Deeper than `DEEPEST`, the tags of a quotation, a details block and a list part paragraphs and are nothing more.
	if (deep) s = replaceOpenTags(s, /<\/?(?:details|summary|blockquote|ul|ol|li)(?=[\s>/])/gi, () => "\n\n");
	s = deep ? s : replaceBalancedTags(s, ["details"], (_tag, _attrs, inner) => {
		const firstNested = /<details(?=[\s>/])/i.exec(inner)?.index ?? inner.length;
		const headSlice = inner.slice(0, firstNested);
		const sumMatch = firstEnclosed(headSlice, SUMMARY_TAGS);
		// The summary stands inside a tag, where Markdown is not read: it is written as the page's words, in HTML.
		// A code block in it is written so too, as its words. Any other block set aside in it (a table) cannot stand
		// in one line of HTML and comes first in the body. Both were left in the summary as their stand-ins and never
		// put back.
		let first = "";
		const said = (text: string) => {
			// Every block, whichever part of the call set it aside: one from further out (a table in the summary of a
			// details block in a quotation) was left in the summary's line too.
			const parts = apartParts(text, "");
			if (parts.length === 1) return text;
			return parts
				.map((part) => {
					if (typeof part === "string") return part;
					if (part.slot.code === undefined) {
						first += `\n\n${part.standIn}\n\n`;
						return " ";
					}
					return blockWords(part.slot).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
				})
				.join("")
				.replace(/\s+/g, " ")
				.trim();
		};
		const summary = (sumMatch && said(htmlWords(sumMatch.inner))) || "Details";
		const withoutSummary = sumMatch ? inner.slice(0, sumMatch.from) + inner.slice(sumMatch.to) : inner;
		const body = restore(first + htmlToMarkdownInner(withoutSummary, false, depth + 1)).trim();
		return stash(`<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`, true);
	});

	// Blockquotes & Confluence/Jira info/warning panels (balanced tag matching for nested blockquotes)
	s = deep ? s : replaceBalancedTags(s, ["blockquote"], (_tag, _attrs, inner) => {
		const before = apartPut;
		// Every block in a quotation is put back before its lines get their marks. One put back after (a details block
		// or a table from further out: only its first line then has the mark) closes the quotation early, and its
		// "</details>" went on to take what stood below it for HTML: inline code there too, which is why this is no
		// longer done only for a quotation with a code block in it.
		const body = settle(restore(htmlToMarkdownInner(inner, false, depth + 1)), true).trim();
		if (!body) return "";
		const quoted = body
			.split("\n")
			.map((l) => (l.trim() ? `> ${l}` : ">"))
			.join("\n");
		return stash(quoted, apartPut !== before);
	});

	// Lists (outermost ul/ol with balanced tag matching so nested lists keep every item)
	s = deep ? s : replaceBalancedTags(s, ["ul", "ol"], (tag, _attrs, inner) => {
		const before = apartPut;
		const rendered = restore(convertList(inner, tag === "ol", "", inner.includes(HELD_START), depth + 1));
		return rendered ? stash(rendered, apartPut !== before) : "";
	});

	// Headings
	s = replaceEnclosed(s, HEADING_TAGS, (name, _attrs, inner) => {
		const lvl = name.slice(1);
		// A heading is one line. A code block in it is written as inline code on that line; any other block set aside
		// in it (a table, a list) comes after the heading. Both were left in the heading as their stand-ins and never
		// put back.
		let code = false;
		let after = "";
		const line = convertInline(inner);
		// Every block, whichever part of the call set it aside. One from further out (a details block or a table in a
		// heading in a quotation) used to be put back on the heading's line later, and what stood behind its
		// "</details>" there was read as HTML.
		const said = apartParts(line, "")
			.map((part) => {
				if (typeof part === "string") return part;
				if (part.slot.code === undefined) {
					after += `\n\n${part.standIn}\n\n`;
					return " ";
				}
				code = true;
				return ` ${codeSpan(part.slot.code.replace(/\s+/g, " ").trim())} `;
			})
			.join("");
		// A "#" that ends a heading would be taken for the heading's own closing mark. (Counted from the end: `/#+$/`
		// read a run of them in the middle of the heading once for each of them.)
		const joined = said.replace(/\s+/g, " ").trim();
		const kept = endTrimmed(joined, (code) => code === 0x23);
		const title = kept + "\\#".repeat(joined.length - kept.length);
		return (title ? stash(`${"#".repeat(Number(lvl))} ${title}`, code) : "") + after;
	});

	// Horizontal rules
	s = replaceOpenTags(s, /<hr\b/gi, () => stash("---"));

	// Paragraphs & block divs
	s = s.replace(/<\/(p|div|section|article|header|footer|aside|main)\s*>/gi, "\n\n");
	s = replaceOpenTags(s, /<(?:p|div|section|article|header|footer|aside|main)\b/gi, () => "\n");

	// Convert remaining inline markup
	s = convertInline(s);

	// What is left is paragraphs (the blocks are still set aside). Space before a line's first word is nothing on a
	// page, and four of them here would make it code; a mark a line begins with is written as itself.
	s = s
		.split("\n")
		.map((l) => plainLine(l.replace(/^[ \t]+/, "")))
		.join("\n");

	// Restore stashed blocks
	s = restore(s, top);

	// Normalize blank lines and trailing whitespace
	return s
		.split("\n")
		.map((l) => endTrimmed(l))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Converts HTML (clipboard fragments, Confluence/Azure DevOps exports, or standalone HTML docs)
 * into clean GitHub-Flavored Markdown. Pure, dependency-free, safe on untrusted markup.
 */
export function htmlToMarkdown(html: string): string {
	if (!html) return "";
	held = new Map();
	anyApart = false;
	apartPut = 0;
	try {
		// The page's own "\x00" are taken out first, so that nothing in it can pass for the stand-in of a block set aside.
		const md = htmlToMarkdownInner(html.replace(/\x00/g, ""), true);
		if (!md.includes("\x00")) return md;
		// No stand-in is left by the rules above. Were one left all the same, the file it is saved in would read as
		// binary and open in no editor: so what it stands for is put back here, and no "\x00" leaves in any case.
		return settle(md, true).replace(/\x00/g, "");
	} finally {
		held = new Map();
	}
}

/**
 * Converts multi-row tab-separated clipboard text (e.g. copied from Excel or TableView)
 * into a clean GitHub-Flavored Markdown table. Returns null when text does not look like TSV.
 */
export function tsvToMarkdownTable(text: string): string | null {
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	if (!normalized || !normalized.includes("\t") || !normalized.includes("\n")) return null;
	const lines = normalized.split("\n").filter((l) => l.length > 0);
	if (lines.length < 2) return null;
	const rows = lines.map((line) => line.split("\t"));
	const colCount = rows[0]!.length;
	if (colCount < 2) return null;
	// Require consistent column count across at least 75% of rows (and never single-column prose with leading tab indents).
	const matching = rows.filter((r) => r.length === colCount).length;
	if (matching / rows.length < 0.75) return null;
	if (rows.every((r) => r[0] === "")) return null; // tab-indented code block, not TSV!

	const padRow = (cells: string[]) => {
		const out = cells.slice(0, colCount).map((c) => escapePipeCell(c));
		while (out.length < colCount) out.push("");
		return `| ${out.join(" | ")} |`;
	};
	const header = padRow(rows[0]!);
	const sep = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
	const body = rows.slice(1).map(padRow);
	return [header, sep, ...body].join("\n");
}
