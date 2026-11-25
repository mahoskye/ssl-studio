// Pure DOM-free HTML -> Markdown and Excel/TSV -> Markdown table converters.
// Used by CM6 smart clipboard paste, Azure DevOps ticket import, and HTML/Confluence doc import.

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
 */
function literal(text: string, kept?: ReadonlySet<number>, inLabel = false): string {
	if (!/[\\*`~[\]_<&]/.test(text)) return text;
	const word = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
	let out = "";
	for (let at = 0; at < text.length; at++) {
		const ch = text[at]!;
		const next = text[at + 1];
		if (inLabel && (ch === "[" || ch === "]")) out += ch === "[" ? "&#91;" : "&#93;";
		else if (ch === "\\" || ch === "*" || ch === "`" || ch === "~" || ch === "[" || ch === "]") out += `\\${ch}`;
		else if (ch === "_" && !(word(text[at - 1]) && word(next))) out += "\\_";
		else if (ch === "<" && next !== undefined && /[A-Za-z/!?\x00]/.test(next)) out += "&lt;";
		else if (ch === "&" && !kept?.has(at) && /^&(?:(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);|#?[0-9A-Za-z]*\x00)/.test(text.slice(at, at + 40))) out += "&amp;";
		else out += ch;
	}
	return out;
}

/**
 * Words set down with nothing of their own around them (a link that is not kept as a link is its words alone),
 * closed at their end against what comes after them: a "<" or the start of a named character that ends them would
 * be finished by the text that follows. "&lt;" then a link with no address around "script" then "&gt;" came out
 * as a script tag.
 */
const bare = (md: string) => md.replace(/<$/, "&lt;").replace(/&(#?[0-9A-Za-z]*)$/, "&amp;$1");

/** What a page shows of this HTML, as Markdown words: the tags gone, the references read, the marks written as themselves. */
function words(html: string, inLabel = false): string {
	const read = readEntities(html.replace(/<[^>]+>/g, ""));
	return literal(read.text, read.kept, inLabel);
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
function address(raw: string): { said: string; written: string } | null {
	const read = readEntities(raw.trim());
	if (!isSafeUrl(read.text)) return null;
	// A browser drops the space and control characters at either end of an address, and the tabs and line ends inside it.
	let from = 0;
	let to = read.text.length;
	while (from < to && read.text.charCodeAt(from) <= 0x20) from++;
	while (to > from && read.text.charCodeAt(to - 1) <= 0x20) to--;
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
	return { said: literal(read.text.slice(from, to), kept, true), written };
}

/** An attribute's value as the words of a picture, on one line. */
function attrWords(tag: string, name: string): string {
	const read = readEntities(rawAttr(tag, name));
	return literal(read.text, read.kept, true).replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
	return decodeHtmlEntities(html.replace(/<[^>]+>/g, ""));
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

/** True when an HTML clipboard fragment carries real semantic formatting worth converting. */
export function looksLikeRichHtml(html: string): boolean {
	if (!html || html.length < 6) return false;
	// Exclude plain VS Code / Monaco / editor HTML wrappers that only emit styled <div><span> lines.
	const stripped = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<meta[^>]*>/gi, "");
	return /<(h[1-6]|table|ul|ol|li|a\s+[^>]*href|strong|b\b|em|i\b|code|pre|blockquote|img\s+[^>]*src|del|s\b|hr|details)\b/i.test(stripped);
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
	const tagRe = new RegExp(`<(\\/?)(${tagNames.join("|")})(?=[\\s>/])([^>]*)>`, "gi");
	let out = "";
	let cursor = 0;
	let rootTag: string | null = null;
	let rootAttrs = "";
	let rootStart = 0;
	let innerStart = 0;
	let depth = 0;

	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(html)) !== null) {
		const isClose = m[1] === "/";
		const tag = m[2]!.toLowerCase();
		const attrs = m[3] ?? "";
		const isSelfClose = !isClose && /\/\s*$/.test(attrs);

		if (rootTag === null) {
			if (isClose) continue;
			if (isSelfClose) {
				out += html.slice(cursor, m.index) + replacer(tag, attrs, "");
				cursor = m.index + m[0].length;
				continue;
			}
			rootTag = tag;
			rootAttrs = attrs;
			rootStart = m.index;
			innerStart = m.index + m[0].length;
			depth = 1;
		} else if (tag === rootTag) {
			if (isClose) {
				depth--;
				if (depth === 0) {
					out += html.slice(cursor, rootStart) + replacer(rootTag, rootAttrs, html.slice(innerStart, m.index));
					cursor = m.index + m[0].length;
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

function convertTable(tableHtml: string): string {
	const rows: { cells: string[]; isHeader: boolean }[] = [];
	const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
	let trMatch: RegExpExecArray | null;
	while ((trMatch = trRe.exec(tableHtml)) !== null) {
		const rowBody = trMatch[1] ?? "";
		const cells: string[] = [];
		let thCount = 0;
		const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
		let cellMatch: RegExpExecArray | null;
		while ((cellMatch = cellRe.exec(rowBody)) !== null) {
			if (cellMatch[1]!.toLowerCase() === "th") thCount++;
			const inner = convertInline(cellMatch[2] ?? "");
			cells.push(escapePipeCell(inner));
		}
		if (cells.length) rows.push({ cells, isHeader: thCount === cells.length });
	}
	if (!rows.length) return "";
	const width = Math.max(...rows.map((r) => r.cells.length));
	const pad = (cells: string[]) => {
		const out = cells.slice();
		while (out.length < width) out.push("");
		return `| ${out.join(" | ")} |`;
	};
	const header = rows[0]!.cells;
	const sep = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
	const body = rows.slice(1).map((r) => pad(r.cells));
	return `\n\n${pad(header)}\n${sep}${body.length ? `\n${body.join("\n")}` : ""}\n\n`;
}

function convertInlineInner(html: string, slots: string[], inLabel = false): string {
	let s = html;
	const stash = (value: string) => {
		if (!value) return "";
		const idx = slots.push(value) - 1;
		return `\x00INL${idx}\x00`;
	};
	// Line breaks
	s = s.replace(/<br\s*\/?>/gi, "\n");
	// Inline code first so inner tags/asterisks stay untouched
	s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, inner: string) => {
		return stash(codeSpan(stripTags(inner).replace(/\r\n?/g, "\n").replace(/\n/g, " ")));
	});
	// Images (quote-aware tag match so `>` inside quoted attrs cannot truncate tag; reject dangerous URL schemes)
	s = s.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
		const src = address(rawAttr(tag, "src"));
		const alt = attrWords(tag, "alt");
		return stash(src ? `![${alt}](${src.written})` : alt ? `[Image: ${alt}]` : "");
	});
	// Links (quote-aware attrs; reject dangerous URL schemes)
	s = s.replace(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
		const href = address(rawAttr(`<a ${attrs}>`, "href"));
		const label = convertInlineInner(inner, slots, true).replace(/\s+/g, " ").trim();
		if (!href) return stash(bare(label));
		// An address between "<" and ">" is a link only where Markdown knows it for an address; any other would be read as a tag.
		const alone = AUTOLINK_RE.test(href.written) ? `<${href.written}>` : "";
		if (!label) return stash(alone || bare(href.said));
		if (label === href.said && alone) return stash(alone);
		return stash(`[${label}](${href.written})`);
	});
	// Emphasis, bold, strike, mark
	s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => {
		const t = convertInlineInner(inner, slots, inLabel).trim();
		return t ? stash(`**${t}**`) : "";
	});
	s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => {
		const t = convertInlineInner(inner, slots, inLabel).trim();
		return t ? stash(`*${t}*`) : "";
	});
	s = s.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => {
		const t = convertInlineInner(inner, slots, inLabel).trim();
		return t ? stash(`~~${t}~~`) : "";
	});
	s = s.replace(/<mark\b[^>]*>([\s\S]*?)<\/mark\s*>/gi, (_m, inner: string) => {
		const t = convertInlineInner(inner, slots, inLabel).trim();
		return t ? stash(`==${t}==`) : "";
	});
	// Task checkboxes
	s = s.replace(/<input\b[^>]*type=["']?checkbox["']?[^>]*>/gi, (tag) => stash(/\bchecked\b/i.test(tag) ? "[x] " : "[ ] "));
	// Remaining tags, and then the words: what the page showed, with nothing in it for Markdown to read as a mark.
	return words(s, inLabel);
}

function convertInline(html: string): string {
	const slots: string[] = [];
	let s = convertInlineInner(html, slots);
	for (let pass = 0; pass < 32 && s.includes("\x00INL"); pass++) {
		s = s.replace(/\x00INL(\d+)\x00/g, (_m, idx: string) => slots[Number(idx)] ?? "");
	}
	return s;
}

function convertList(listHtml: string, ordered: boolean, depth = 0): string {
	const indent = "  ".repeat(depth);
	const out: string[] = [];
	let itemIdx = 1;

	const emitItem = (rawItem: string) => {
		const nestedBlocks: string[] = [];
		const strippedItem = replaceBalancedTags(rawItem, ["ul", "ol"], (tag, _attrs, inner) => {
			nestedBlocks.push(convertList(inner, tag === "ol", depth + 1));
			return "";
		});
		const text = convertInline(strippedItem)
			.replace(/\s*\n\s*/g, " ")
			.replace(/\s{2,}/g, " ")
			.trim();
		const marker = ordered ? `${itemIdx++}. ` : "- ";
		if (text) out.push(`${indent}${marker}${plainLine(text)}`);
		for (const nb of nestedBlocks) {
			if (nb.trim()) out.push(nb);
		}
	};

	// Match top-level <li> elements inside this list by tracking nested <li> depth.
	const liRe = /<(\/?)li(?=[\s>/])[^>]*>/gi;
	let nest = 0;
	let itemStart = -1;
	let m: RegExpExecArray | null;
	while ((m = liRe.exec(listHtml)) !== null) {
		const isClose = m[1] === "/";
		if (!isClose) {
			if (nest === 0) itemStart = m.index + m[0].length;
			nest++;
		} else if (nest > 0) {
			nest--;
			if (nest === 0 && itemStart >= 0) {
				emitItem(listHtml.slice(itemStart, m.index));
				itemStart = -1;
			}
		}
	}
	if (nest > 0 && itemStart >= 0) {
		emitItem(listHtml.slice(itemStart));
	}
	return out.join("\n");
}

let blockSlotSeq = 0;

function htmlToMarkdownInner(html: string): string {
	if (!html) return "";
	let s = html
		.replace(/\r\n?/g, "\n")
		.replace(/<!--StartFragment-->|<!--EndFragment-->/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|head|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, "");

	// Extract full HTML body when present
	const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(s);
	if (bodyMatch) s = bodyMatch[1]!;

	const callId = ++blockSlotSeq;
	const slots: string[] = [];
	const stash = (md: string) => {
		const idx = slots.push(md) - 1;
		return `\n\n\x00B${callId}_${idx}\x00\n\n`;
	};
	const slotRe = new RegExp(`\\x00B${callId}_(\\d+)\\x00`, "g");
	const restore = (text: string) => text.replace(slotRe, (_m, idx: string) => slots[Number(idx)] ?? "");

	// Preformatted code blocks first
	s = s.replace(/<pre\b[^>]*>\s*(?:<code\b([^>]*)>)?([\s\S]*?)(?:<\/code\s*>)?\s*<\/pre\s*>/gi, (_m, codeAttrs: string | undefined, inner: string) => {
		const cls = codeAttrs ? attrOf(`<code ${codeAttrs}>`, "class") : "";
		const langMatch = /\b(?:language|lang)-([a-z0-9_+-]+)\b/i.exec(cls);
		const lang = langMatch?.[1]?.toLowerCase() ?? "";
		const body = stripTags(inner).replace(/^\n+|\n+$/g, "");
		// A fence longer than any line of backticks in the code: a line of three inside it would have ended the block there.
		const fence = "`".repeat(1 + Array.from(body.matchAll(/^[ \t]*(`+)/gm)).reduce((most, m) => Math.max(most, m[1]!.length), 2));
		return stash(`${fence}${lang}\n${body}\n${fence}`);
	});

	// Tables
	s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (tbl) => stash(convertTable(tbl).trim()));

	// Details/summary (balanced tag matching so nested <details> preserve outer content)
	s = replaceBalancedTags(s, ["details"], (_tag, _attrs, inner) => {
		const firstNested = /<details(?=[\s>/])/i.exec(inner)?.index ?? inner.length;
		const headSlice = inner.slice(0, firstNested);
		const sumMatch = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(headSlice);
		// The summary stands inside a tag, where Markdown is not read: it is written as the page's words, in HTML.
		const summary = (sumMatch && htmlWords(sumMatch[1]!)) || "Details";
		const withoutSummary = sumMatch ? inner.slice(0, sumMatch.index) + inner.slice(sumMatch.index + sumMatch[0].length) : inner;
		const body = restore(htmlToMarkdownInner(withoutSummary)).trim();
		return stash(`<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`);
	});

	// Blockquotes & Confluence/Jira info/warning panels (balanced tag matching for nested blockquotes)
	s = replaceBalancedTags(s, ["blockquote"], (_tag, _attrs, inner) => {
		const body = restore(htmlToMarkdownInner(inner)).trim();
		if (!body) return "";
		const quoted = body
			.split("\n")
			.map((l) => (l.trim() ? `> ${l}` : ">"))
			.join("\n");
		return stash(quoted);
	});

	// Lists (outermost ul/ol with balanced tag matching so nested lists keep every item)
	s = replaceBalancedTags(s, ["ul", "ol"], (tag, _attrs, inner) => {
		const rendered = restore(convertList(inner, tag === "ol", 0));
		return rendered ? stash(rendered) : "";
	});

	// Headings
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, lvl: string, inner: string) => {
		// A "#" that ends a heading would be taken for the heading's own closing mark.
		const title = convertInline(inner)
			.replace(/\s+/g, " ")
			.trim()
			.replace(/#+$/, (end) => end.replace(/#/g, "\\#"));
		return title ? stash(`${"#".repeat(Number(lvl))} ${title}`) : "";
	});

	// Horizontal rules
	s = s.replace(/<hr\b[^>]*\/?>/gi, () => stash("---"));

	// Paragraphs & block divs
	s = s.replace(/<\/(p|div|section|article|header|footer|aside|main)\s*>/gi, "\n\n");
	s = s.replace(/<(p|div|section|article|header|footer|aside|main)\b[^>]*>/gi, "\n");

	// Convert remaining inline markup
	s = convertInline(s);

	// What is left is paragraphs (the blocks are still set aside). Space before a line's first word is nothing on a
	// page, and four of them here would make it code; a mark a line begins with is written as itself.
	s = s
		.split("\n")
		.map((l) => plainLine(l.replace(/^[ \t]+/, "")))
		.join("\n");

	// Restore stashed blocks
	s = restore(s);

	// Normalize blank lines and trailing whitespace
	return s
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/g, ""))
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
	return htmlToMarkdownInner(html.replace(/\x00/g, ""));
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
