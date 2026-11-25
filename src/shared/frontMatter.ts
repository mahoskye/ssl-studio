// The few lines of "key: value" a project's Markdown may open with, between
// two lines of three dashes: which ticket a spec is for, what state a decision
// is in. Only what those lines need is read: a value, a list on one line or as
// dashes under the key, a comment. Anything else in the block is passed over.
import { fenced } from "./catalog";

export type FrontMatter = {
	values: Record<string, string | string[]>;
	/** How many lines the block takes, its two fences included; 0 when there is none. */
	lines: number;
	/** The text after the block. */
	body: string;
};

/** A value as it was meant: a double-quoted one with its escapes undone (it is written as JSON writes a string), a single-quoted one with a doubled quote as one. */
const unquote = (value: string) => {
	const v = value.trim();
	if (v.length >= 2 && v[0] === '"' && v.at(-1) === '"') {
		try {
			const read: unknown = JSON.parse(v);
			if (typeof read === "string") return read;
		} catch {
			// Not written as JSON writes it: what is between the quotes, as it stands.
		}
		return v.slice(1, -1);
	}
	return v.length >= 2 && v[0] === "'" && v.at(-1) === "'" ? v.slice(1, -1).replace(/''/g, "'") : v;
};

/** A list written on one line, `[a, "b, c", d]`: split at the commas outside quotes. */
function inlineList(inner: string): string[] {
	const items: string[] = [];
	let item = "";
	let quote = "";
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i]!;
		if (quote) {
			if (quote === '"' && ch === "\\" && i + 1 < inner.length) {
				item += ch + inner[++i]!;
				continue;
			}
			if (quote === "'" && ch === "'" && inner[i + 1] === "'") {
				item += "''";
				i++;
				continue;
			}
			if (ch === quote) quote = "";
			item += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			item += ch;
		} else if (ch === ",") {
			items.push(item);
			item = "";
		} else item += ch;
	}
	items.push(item);
	return items.map(unquote).filter(Boolean);
}

/** Strips a YAML inline comment (` # ...`) outside quotes on an unquoted or quoted scalar value. */
function stripInlineComment(raw: string): string {
	let quote = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (quote) {
			if (quote === '"' && ch === "\\" && i + 1 < raw.length) {
				i++;
				continue;
			}
			if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) {
			return raw.slice(0, i).trim();
		}
	}
	return raw.trim();
}

const TEMPLATE_HEADER_RE = /^\s*<!--\s*template\b[\s\S]*?-->\s*$/i;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quotes a YAML scalar value when it contains characters that would corrupt unquoted YAML (`#`, `: `, `[...]`, quotes, leading/trailing spaces). */
export function quoteYamlScalar(value: string): string {
	const v = value.trim();
	if (!v) return '""';
	if (/^[#[\]{},!&*?|>'\"%@`-]|:\s|:$|\s#|[\r\n"]/.test(v)) return JSON.stringify(v);
	return v;
}

function leadingTemplateLines(lines: readonly string[]): number {
	let idx = 0;
	while (idx < lines.length && TEMPLATE_HEADER_RE.test(lines[idx]!.replace(/^\uFEFF/, ""))) idx++;
	return idx;
}

export function frontMatter(text: string): FrontMatter {
	const none = { values: {}, lines: 0, body: text };
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	const start = leadingTemplateLines(lines);
	if (lines[start]?.trim() !== "---") return none;
	const end = lines.findIndex((line, i) => i > start && /^(---|\.\.\.)\s*$/.test(line));
	if (end < 0) return none;
	const values: Record<string, string | string[]> = {};
	let listKey = "";
	for (const line of lines.slice(start + 1, end)) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && listKey) {
			(values[listKey] as string[]).push(unquote(stripInlineComment(item[1]!)));
			continue;
		}
		const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!pair) continue;
		const key = pair[1]!.toLowerCase();
		const value = stripInlineComment(pair[2]!);
		listKey = "";
		if (!value) {
			values[key] = [];
			listKey = key;
		} else if (value.startsWith("[") && value.endsWith("]") && !value.startsWith("[[")) values[key] = inlineList(value.slice(1, -1));
		else values[key] = unquote(value);
	}
	// A key with nothing under it was not a list after all.
	for (const [key, value] of Object.entries(values)) if (Array.isArray(value) && !value.length) values[key] = "";
	return { values, lines: end + 1, body: lines.slice(end + 1).join("\n") };
}

/** A value as one string: a list's items joined. */
export const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(", ") : (value ?? "")).trim();
/** A value as a list: one value is a list of one, and "a, b" is two. */
export const many = (value: string | string[] | undefined) => (Array.isArray(value) ? value : (value ?? "").split(",")).map((v) => v.trim()).filter(Boolean);

/**
 * Markdown as the words it says: a link as its text, emphasis without its
 * marks. An underscore or an asterisk inside a word is part of the word:
 * `DUE_SOON_AT` is a name, not emphasis.
 */
export function plainMarkdown(markdown: string): string {
	// A character written with a backslash before it is that character, and no mark: it is set aside while the marks are taken off.
	const kept: string[] = [];
	let text = markdown.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, character: string) => `\uE000${kept.push(character) - 1}\uE001`);
	text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`+([^`]*)`+/g, "$1").replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1");
	// Bold inside italic, or the other way round, takes two passes.
	for (let pass = 0; pass < 3; pass++) {
		const before = text;
		text = text.replace(/(^|[^\w*])(\*\*|\*)(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3").replace(/(^|[^\w])(__|_)(?=\S)(.+?)(?<=\S)\2(?![\w])/g, "$1$3");
		if (text === before) break;
	}
	return text
		.replace(/\uE000(\d+)\uE001/g, (_, index: string) => kept[Number(index)] ?? "")
		.replace(/\s+/g, " ")
		.trim();
}
const plain = plainMarkdown;

/** A heading line: its level and its words. Closing hashes are a mark only after a space: "Using C#" ends in a sharp. */
export const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;

/** Replaces fenced code blocks with blank-line separators so headings/code inside fences are skipped. */
function withoutFenced(body: string): string {
	const normalized = body.replace(/\r\n/g, "\n");
	const ranges = fenced(normalized);
	if (!ranges.length) return normalized;
	let out = "";
	let at = 0;
	for (const [from, to] of ranges) {
		out += normalized.slice(at, from);
		out += "\n\n";
		at = to;
	}
	out += normalized.slice(at);
	return out;
}

/** A document's title: what its front matter says, or its first heading. */
export function titleOf(text: string): string {
	const { values, body } = frontMatter(text);
	const named = one(values.title);
	if (named) return named;
	const heading = withoutFenced(body)
		.split("\n")
		.map((line) => HEADING.exec(line))
		.find(Boolean);
	return heading ? plain(heading[2]!) : "";
}

/** The longest a one-line summary is. */
export const SUMMARY_MAX = 140;

/** What a document is about, in one line: its front matter's summary, or the first sentence of its first paragraph. */
export function summaryOf(text: string): string {
	const { values, body } = frontMatter(text);
	const said = one(values.summary);
	if (said) return said;
	const paragraph = withoutFenced(body)
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.find((block) => block && !/^(#|```|~~~|\||<!--|[-*+]\s|\d+\.\s|>|---)/.test(block));
	if (!paragraph) return "";
	const flat = plain(paragraph);
	const sentence = /^(.*?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
	if (sentence.length <= SUMMARY_MAX) return sentence;
	// Cut at a word's end where there is one; a single long word is cut where the room ends.
	const space = sentence.lastIndexOf(" ", SUMMARY_MAX - 1);
	// Not through the middle of a character that takes two units: half of one is no character.
	return `${sentence.slice(0, space > 0 ? space : SUMMARY_MAX - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

/** True when `raw` is a single complete double-quoted or single-quoted YAML scalar literal. */
function isSingleQuotedScalar(raw: string): boolean {
	const v = raw.trim();
	if (v.length < 2) return false;
	if (v[0] === '"' && v.at(-1) === '"') {
		for (let i = 1; i < v.length - 1; i++) {
			if (v[i] === "\\") {
				i++;
				continue;
			}
			if (v[i] === '"') return false;
		}
		return true;
	}
	if (v[0] === "'" && v.at(-1) === "'") {
		for (let i = 1; i < v.length - 1; i++) {
			if (v[i] === "'") {
				if (v[i + 1] === "'") {
					i++;
					continue;
				}
				return false;
			}
		}
		return true;
	}
	return false;
}

/** Reads a frontmatter list key without splitting a single quoted scalar that contains a comma. */
function readFrontMatterListValues(text: string, key: string): string[] {
	const fm = frontMatter(text);
	const val = fm.values[key.toLowerCase()];
	if (val === undefined) return [];
	if (Array.isArray(val)) return val.map((v) => v.trim()).filter(Boolean);
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	const openIdx = leadingTemplateLines(lines);
	const close = lines[openIdx]?.trim() === "---" ? lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line)) : -1;
	if (close >= 0) {
		const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*:`, "i");
		const at = lines.findLastIndex((line, i) => i > openIdx && i < close && keyRe.test(line));
		if (at >= 0) {
			const colon = lines[at]!.indexOf(":");
			const rawVal = stripInlineComment(lines[at]!.slice(colon + 1));
			if (isSingleQuotedScalar(rawVal)) {
				const trimmed = val.trim();
				return trimmed ? [trimmed] : [];
			}
		}
	}
	return many(val);
}

const quoteListItem = (v: string) => (/[:#[\]{},&*?|>!'"%@`\r\n]|^-|^\s|\s$/.test(v) ? JSON.stringify(v) : v);

/**
 * How far a key's value runs: the index of its last line, the key's own line
 * when the value is all on it. A value goes on under its key as dashes, as
 * more-indented lines (a block scalar, a nested map, a scalar that wraps) or
 * as a flow list or map whose bracket closes on a later line. Blank and
 * comment lines between two of its lines are part of it; ones after its last
 * line are not. `dashes` says the value is a plain list, one `- item` to a
 * line and all at one indent: the only shape over several lines that is
 * edited a line at a time. A writer that changed the key's line alone would
 * leave the rest of any other shape behind as broken YAML.
 */
function valueExtent(lines: readonly { text: string }[], at: number, close: number): { end: number; dashes: boolean } {
	const keyLine = lines[at]!.text;
	const value = keyLine.slice(keyLine.indexOf(":") + 1);
	const empty = /^\s*(?:#.*)?$/.test(value);
	// Under a block scalar's mark every more-indented line is its text, one that starts with a hash too.
	const block = /^\s*[|>][-+0-9]*\s*(?:#.*)?$/.test(value);
	// A flow list or map left open on the key's line runs to the line that closes it: its items are indented, and
	// the closing bracket (or a comment) may stand at the margin. Brackets that do not close that way say nothing
	// (an unquoted title may open with one), and the value is then read as far as its indented lines go.
	let flowEnd = -1;
	if (/^\s*[[{]/.test(value)) {
		let depth = 0;
		let quote = "";
		// A quote mark opens a quoted item only where an item starts: the one in `it's` is a letter of its word.
		let opening = true;
		scan: for (let j = at; j < close; j++) {
			const text = j === at ? value : lines[j]!.text;
			if (j > at && /^[^\s\]}#]/.test(text)) break;
			for (let i = 0; i < text.length; i++) {
				const ch = text[i]!;
				if (quote) {
					if (quote === '"' && ch === "\\") i++;
					else if (ch === quote) quote = "";
					continue;
				}
				if (/\s/.test(ch)) continue;
				if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]!))) break;
				const starts = opening;
				opening = ch === "[" || ch === "{" || ch === "," || ch === ":";
				if ((ch === '"' || ch === "'") && starts) quote = ch;
				else if (ch === "[" || ch === "{") depth++;
				else if ((ch === "]" || ch === "}") && --depth <= 0) {
					flowEnd = j;
					break scan;
				}
			}
		}
	}
	let end = at;
	let dashes = empty;
	let indent: string | null = null;
	for (let j = at + 1; j < close; j++) {
		const text = lines[j]!.text;
		if (j <= flowEnd) {
			end = j;
			dashes = false;
			continue;
		}
		const trimmed = text.trim();
		if (!trimmed) continue;
		const indented = /^\s/.test(text);
		if (trimmed.startsWith("#") && !(block && indented)) continue;
		const dash = /^(\s*)-\s+/.exec(text);
		if (!indented && !(empty && /^-(?:\s|$)/.test(text))) break;
		end = j;
		if (!dash || (indent !== null && dash[1] !== indent)) dashes = false;
		else indent = dash[1]!;
	}
	return { end, dashes: dashes && end > at };
}

function writeFrontMatterRaw(text: string, key: string, serializedVal: string): string | null {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	// Each line with where it is in the text: only the one line is rewritten, so every other line keeps its own end.
	const lines: { text: string; start: number; end: number }[] = [];
	for (let at = 0; at <= text.length; ) {
		const stop = text.indexOf("\n", at);
		const end = stop < 0 ? text.length : stop;
		lines.push({ text: text.slice(at, end).replace(/\r$/, ""), start: at, end: text[end - 1] === "\r" ? end - 1 : end });
		if (stop < 0) break;
		at = stop + 1;
	}
	const openIdx = leadingTemplateLines(lines.map((l) => l.text));
	const fencedOpen = lines[openIdx]?.text.replace(/^\uFEFF/, "").trim() === "---";
	const close = fencedOpen ? lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line.text)) : -1;
	if (close < 0) {
		// Never prepend a second broken frontmatter block when an opening `---` was never closed.
		if (fencedOpen) return null;
		const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
		const afterBom = bom ? text.slice(1) : text;
		let insertAt = 0;
		let pos = 0;
		while (pos < afterBom.length) {
			const nl = afterBom.indexOf("\n", pos);
			const lineEnd = nl < 0 ? afterBom.length : nl;
			const rawLine = afterBom.slice(pos, lineEnd).replace(/\r$/, "");
			if (!TEMPLATE_HEADER_RE.test(rawLine)) break;
			insertAt = nl < 0 ? afterBom.length : nl + 1;
			pos = insertAt;
		}
		const block = `---${eol}${key}: ${serializedVal}${eol}---`;
		if (insertAt > 0) {
			const prefix = afterBom.slice(0, insertAt);
			const prefixWithEol = prefix.endsWith("\n") ? prefix : `${prefix}${eol}`;
			const rest = afterBom.slice(insertAt).replace(/^(?:\r?\n)+/, "");
			return `${bom}${prefixWithEol}${block}${rest ? `${eol}${eol}${rest}` : eol}`;
		}
		return `${bom}${block}${eol}${eol}${afterBom}`;
	}
	// The last line that sets the key is the one that is read, so it is the one that is written.
	const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*:`, "i");
	const at = lines.findLastIndex((line, i) => i > openIdx && i < close && keyRe.test(line.text));
	if (at < 0) return `${text.slice(0, lines[close]!.start)}${key}: ${serializedVal}${eol}${text.slice(lines[close]!.start)}`;
	// A value that goes on under its key's line (dashes, a block scalar, a nested map, a flow list closed on a later
	// line) is the person's layout, and a new value on the key's line would leave its other lines behind: not set here.
	if (valueExtent(lines, at, close).end > at) return null;
	return `${text.slice(0, lines[at]!.start)}${lines[at]!.text.slice(0, lines[at]!.text.indexOf(":"))}: ${serializedVal}${text.slice(lines[at]!.end)}`;
}

/**
 * The text with one value of its front matter set: the key's own line is
 * changed where it has one, and added at the block's end where it has not.
 * A document with no front matter gets a block. Nothing else is touched, and
 * the file's own line ends are kept. A value that goes on under its key's
 * line (a list as dashes, a block scalar, a nested map, a flow list closed on
 * a later line) is left alone: null says it could not be set.
 */
export function withFrontMatter(text: string, key: string, value: string): string | null {
	return writeFrontMatterRaw(text, key, quoteYamlScalar(value));
}

/**
 * Adds `item` to a front matter list key (e.g. `specs: [a, b]`, `plans: [...]`, `related: [...]`).
 * Supports BOTH inline arrays (`key: [a, b]`) AND multi-line YAML bullet lists (`key:\n  - a`),
 * preserving the author's list style. If `item` is already present (case-insensitive), returns `text` unchanged.
 * Any other value over several lines (a flow list broken across lines, a block scalar, a nested map, dash items
 * that run on) is left alone: null says the item could not be added.
 */
export function addToFrontMatterList(text: string, key: string, item: string): string | null {
	const wanted = item.trim();
	if (!wanted) return text;
	const existing = readFrontMatterListValues(text, key);
	if (existing.some((v) => v.toLowerCase() === wanted.toLowerCase())) return text;
	const formatted = `[${[...existing, wanted].map(quoteListItem).join(", ")}]`;
	const inline = writeFrontMatterRaw(text, key, formatted);
	if (inline !== null) return inline;

	// Multi-line YAML bullet list: append a new `- <item>` with the same indentation after the last bullet item.
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines: { text: string; start: number; end: number }[] = [];
	for (let at = 0; at <= text.length; ) {
		const stop = text.indexOf("\n", at);
		const end = stop < 0 ? text.length : stop;
		lines.push({ text: text.slice(at, end).replace(/\r$/, ""), start: at, end: text[end - 1] === "\r" ? end - 1 : end });
		if (stop < 0) break;
		at = stop + 1;
	}
	const openIdx = leadingTemplateLines(lines.map((l) => l.text));
	const close = lines[openIdx]?.text.replace(/^\uFEFF/, "").trim() === "---" ? lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line.text)) : -1;
	if (close < 0) return null;
	const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*:`, "i");
	const at = lines.findLastIndex((line, i) => i > openIdx && i < close && keyRe.test(line.text));
	if (at < 0) return null;
	// Only a plain dash list takes one more dash: any other value over several lines is left for the person to edit.
	const extent = valueExtent(lines, at, close);
	if (!extent.dashes) return null;
	// The new item stands where the others do: a list written at the margin has its dashes there, and an indented
	// dash under one of them would be read as more of that item's text.
	const lastItem = extent.end;
	const indent = /^(\s*)-/.exec(lines[lastItem]!.text)?.[1] ?? "  ";
	const insertAt = lines[lastItem]!.end;
	return `${text.slice(0, insertAt)}${eol}${indent}- ${quoteListItem(wanted)}${text.slice(insertAt)}`;
}

/**
 * Removes `item` (case-insensitive) from a front matter list or scalar key.
 * If the key becomes empty, removes the key line(s) cleanly. Null when the value runs over several lines and is
 * not a plain dash list: it cannot be edited a line at a time.
 */
export function removeFromFrontMatterList(text: string, key: string, item: string): string | null {
	const target = item.trim().toLowerCase();
	if (!target) return text;
	const fm = frontMatter(text);
	if (fm.lines < 2) return text;
	const existing = readFrontMatterListValues(text, key);
	const kept = existing.filter((v) => v.toLowerCase() !== target);
	if (kept.length === existing.length) return text;

	const lines: { text: string; start: number; end: number; lineEnd: number }[] = [];
	for (let at = 0; at <= text.length; ) {
		const stop = text.indexOf("\n", at);
		const end = stop < 0 ? text.length : stop;
		lines.push({
			text: text.slice(at, end).replace(/\r$/, ""),
			start: at,
			end: text[end - 1] === "\r" ? end - 1 : end,
			lineEnd: stop < 0 ? text.length : stop + 1,
		});
		if (stop < 0) break;
		at = stop + 1;
	}
	const openIdx = leadingTemplateLines(lines.map((l) => l.text));
	const close = lines[openIdx]?.text.replace(/^\uFEFF/, "").trim() === "---" ? lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line.text)) : -1;
	if (close < 0) return null;
	const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*:`, "i");
	const at = lines.findLastIndex((line, i) => i > openIdx && i < close && keyRe.test(line.text));
	if (at < 0) return text;

	// A plain dash list loses the item's own line. Any other value over several lines is not edited here: taking
	// the key's line out of it would leave its other lines under the key before.
	const extent = valueExtent(lines, at, close);
	if (extent.end > at && !extent.dashes) return null;
	const isMulti = extent.dashes;
	const listEnd = extent.end;
	if (isMulti) {
		if (!kept.length) return `${text.slice(0, lines[at]!.start)}${text.slice(lines[listEnd]!.lineEnd)}`;
		const toRemove: { start: number; end: number }[] = [];
		for (let j = at + 1; j <= listEnd; j++) {
			const m = /^\s*-\s+(.*)$/.exec(lines[j]!.text);
			if (m && unquote(stripInlineComment(m[1]!)).toLowerCase() === target) {
				toRemove.push({ start: lines[j]!.start, end: lines[j]!.lineEnd });
			}
		}
		if (!toRemove.length) return text;
		let out = text;
		for (let k = toRemove.length - 1; k >= 0; k--) {
			out = `${out.slice(0, toRemove[k]!.start)}${out.slice(toRemove[k]!.end)}`;
		}
		return out;
	}
	if (!kept.length) return `${text.slice(0, lines[at]!.start)}${text.slice(lines[at]!.lineEnd)}`;
	const rawVal = lines[at]!.text.slice(lines[at]!.text.indexOf(":") + 1).trim();
	const nextVal = rawVal.startsWith("[") || kept.length > 1 ? `[${kept.map(quoteListItem).join(", ")}]` : quoteListItem(kept[0]!);
	return `${text.slice(0, lines[at]!.start)}${lines[at]!.text.slice(0, lines[at]!.text.indexOf(":"))}: ${nextVal}${text.slice(lines[at]!.end)}`;
}

/**
 * Replaces `oldItem` (case-insensitive) with `newItem` inside a scalar, inline list,
 * or multi-line YAML bullet list while preserving key position, YAML list style, and all other entries verbatim.
 * Null when the value runs over several lines and is not a plain dash list.
 */
export function replaceInFrontMatterList(text: string, key: string, oldItem: string, newItem: string): string | null {
	const target = oldItem.trim().toLowerCase();
	const next = newItem.trim();
	if (!target || !next) return text;
	const vals = readFrontMatterListValues(text, key);
	if (!vals.some((v) => v.toLowerCase() === target)) return text;

	// Scan the frontmatter block directly so we can replace in place without reordering keys or flattening 1-item YAML lists.
	const lines: { text: string; start: number; end: number }[] = [];
	for (let at = 0; at <= text.length; ) {
		const stop = text.indexOf("\n", at);
		const end = stop < 0 ? text.length : stop;
		lines.push({
			text: text.slice(at, end).replace(/\r$/, ""),
			start: at,
			end: text[end - 1] === "\r" ? end - 1 : end,
		});
		if (stop < 0) break;
		at = stop + 1;
	}
	const openIdx = leadingTemplateLines(lines.map((l) => l.text));
	const close = lines[openIdx]?.text.replace(/^\uFEFF/, "").trim() === "---" ? lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line.text)) : -1;
	if (close < 0) return null;
	const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*:`, "i");
	const at = lines.findLastIndex((line, i) => i > openIdx && i < close && keyRe.test(line.text));
	if (at < 0) return text;

	// A plain dash list has the item's own line rewritten; any other value over several lines is not edited here.
	const extent = valueExtent(lines, at, close);
	if (extent.end > at && !extent.dashes) return null;
	const isMulti = extent.dashes;
	const listEnd = extent.end;
	if (isMulti) {
		const edits: { start: number; end: number; rep: string }[] = [];
		// The new item is in the list already only when another line holds it: a change of an item's case alone
		// finds the item itself, and dropping its line for that would lose it.
		const alreadyHasNew = vals.some((v) => v.toLowerCase() === next.toLowerCase() && v.toLowerCase() !== target);
		for (let j = at + 1; j <= listEnd; j++) {
			const m = /^(\s*-\s+)(.*)$/.exec(lines[j]!.text);
			if (m && unquote(stripInlineComment(m[2]!)).toLowerCase() === target) {
				if (alreadyHasNew) {
					const nextLineEnd = j + 1 < lines.length ? lines[j + 1]!.start : text.length;
					edits.push({ start: lines[j]!.start, end: nextLineEnd, rep: "" });
				} else {
					edits.push({ start: lines[j]!.start, end: lines[j]!.end, rep: `${m[1]}${quoteListItem(next)}` });
				}
			}
		}
		if (!edits.length) return text;
		let out = text;
		for (let k = edits.length - 1; k >= 0; k--) {
			out = `${out.slice(0, edits[k]!.start)}${edits[k]!.rep}${out.slice(edits[k]!.end)}`;
		}
		return out;
	}

	// Scalar or inline array: preserve inline-array brackets when originally written as `[...]`.
	const rawVal = lines[at]!.text.slice(lines[at]!.text.indexOf(":") + 1).trim();
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const v of vals) {
		const out = v.toLowerCase() === target ? next : v;
		if (!seen.has(out.toLowerCase())) {
			seen.add(out.toLowerCase());
			deduped.push(out);
		}
	}
	const formatted = rawVal.startsWith("[") || deduped.length > 1 ? `[${deduped.map(quoteListItem).join(", ")}]` : quoteListItem(deduped[0]!);
	return `${text.slice(0, lines[at]!.start)}${lines[at]!.text.slice(0, lines[at]!.text.indexOf(":"))}: ${formatted}${text.slice(lines[at]!.end)}`;
}

/**
 * Removes a front matter key and the whole of its value (dash items, a block
 * scalar's lines, a nested map, a flow list closed on a later line) from the
 * YAML block, then strips the fences if the block becomes empty.
 */
export function removeFrontMatterKey(text: string, key: string): string {
	const lines: { text: string; start: number; lineEnd: number }[] = [];
	for (let at = 0; at <= text.length; ) {
		const stop = text.indexOf("\n", at);
		const end = stop < 0 ? text.length : stop;
		lines.push({
			text: text.slice(at, end).replace(/\r$/, ""),
			start: at,
			lineEnd: stop < 0 ? text.length : stop + 1,
		});
		if (stop < 0) break;
		at = stop + 1;
	}
	const openIdx = leadingTemplateLines(lines.map((l) => l.text));
	if (lines[openIdx]?.text.replace(/^\uFEFF/, "").trim() !== "---") return text;
	const close = lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line.text));
	if (close < 0) return text;
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const keyRe = new RegExp(`^${escaped}\\s*:`, "i");
	const ranges: [number, number][] = [];
	for (let i = openIdx + 1; i < close; i++) {
		if (!keyRe.test(lines[i]!.text)) continue;
		// The whole value goes with its key: lines of a block scalar or a nested map left behind would be read as
		// more of the key before.
		const endIdx = valueExtent(lines, i, close).end;
		ranges.push([lines[i]!.start, lines[endIdx]!.lineEnd]);
		i = endIdx;
	}
	if (!ranges.length) return text;
	let out = text;
	for (let r = ranges.length - 1; r >= 0; r--) {
		const [start, end] = ranges[r]!;
		out = `${out.slice(0, start)}${out.slice(end)}`;
	}
	return stripEmptyFrontMatter(out);
}

/**
 * Removes an empty YAML front matter block (`---\n---`) left behind when the last
 * property is deleted, keeping any template header comment and body intact.
 */
export function stripEmptyFrontMatter(text: string): string {
	const lines: { text: string; start: number; lineEnd: number }[] = [];
	for (let at = 0; at <= text.length; ) {
		const stop = text.indexOf("\n", at);
		const end = stop < 0 ? text.length : stop;
		lines.push({
			text: text.slice(at, end).replace(/\r$/, ""),
			start: at,
			lineEnd: stop < 0 ? text.length : stop + 1,
		});
		if (stop < 0) break;
		at = stop + 1;
	}
	const openIdx = leadingTemplateLines(lines.map((l) => l.text));
	if (lines[openIdx]?.text.replace(/^\uFEFF/, "").trim() !== "---") return text;
	const close = lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line.text));
	if (close < 0) return text;
	for (let j = openIdx + 1; j < close; j++) {
		if (lines[j]!.text.trim()) return text;
	}
	let cutTo = lines[close]!.lineEnd;
	while (cutTo < text.length && (text[cutTo] === "\r" || text[cutTo] === "\n")) {
		cutTo += text[cutTo] === "\r" && text[cutTo + 1] === "\n" ? 2 : 1;
	}
	return `${text.slice(0, lines[openIdx]!.start)}${text.slice(cutTo)}`;
}

/** Where the body starts in the text: after the front matter's lines. */
export function bodyOffset(text: string): number {
	let at = 0;
	for (let line = frontMatter(text).lines; line > 0; line--) {
		const end = text.indexOf("\n", at);
		if (end < 0) return text.length;
		at = end + 1;
	}
	return at;
}

/**
 * Character span `[start, end)` of the raw YAML content strictly *inside* the
 * opening and closing `---` fences, plus its normalized LF `inner` text and
 * the file's `eol`. Returns `null` when the document has no closed front matter.
 */
export function frontMatterInnerSpan(text: string): { start: number; end: number; inner: string; eol: "\r\n" | "\n" } | null {
	const fm = frontMatter(text);
	if (fm.lines < 2) return null;
	const eol: "\r\n" | "\n" = text.includes("\r\n") ? "\r\n" : "\n";
	const openLine = leadingTemplateLines(text.split(/\r?\n/)) + 1;
	let at = 0;
	let start = -1;
	let end = -1;
	for (let lineNum = 1; lineNum <= fm.lines; lineNum++) {
		if (lineNum === openLine + 1) start = at;
		if (lineNum === fm.lines) {
			end = at;
			break;
		}
		const nl = text.indexOf("\n", at);
		if (nl < 0) return null;
		at = nl + 1;
	}
	if (start < 0 || end < start) return null;
	const raw = text.slice(start, end);
	// Strip the single trailing line break immediately preceding the closing fence.
	const inner = raw.replace(/\r?\n$/, "").replace(/\r\n/g, "\n");
	return { start, end, inner, eol };
}

/**
 * Formats edited inner YAML text (LF-normalized from a textarea) into the exact
 * replacement slice for `frontMatterInnerSpan(text)`, preserving the file's EOL
 * and keeping the opening/closing `---` fences intact even when empty.
 */
export function formatFrontMatterInnerReplacement(nextInner: string, eol: "\r\n" | "\n"): string {
	const normalized = nextInner.replace(/\r\n/g, "\n").replace(/\n/g, eol);
	return normalized ? `${normalized}${eol}` : "";
}
