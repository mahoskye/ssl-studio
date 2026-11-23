// The few lines of "key: value" a project's Markdown may open with, between
// two lines of three dashes: which ticket a spec is for, what state a decision
// is in. Only what those lines need is read: a value, a list on one line or as
// dashes under the key, a comment. Anything else in the block is passed over.

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

/** Quotes a YAML scalar value when it contains characters that would corrupt unquoted YAML (`#`, `: `, `[...]`, quotes, leading/trailing spaces). */
export function quoteYamlScalar(value: string): string {
	const v = value.trim();
	if (!v) return '""';
	// Already cleanly double-quoted (valid JSON string) or single-quoted (no unescaped internal ') stays as written.
	if (v.startsWith('"') && v.endsWith('"')) {
		try {
			if (typeof JSON.parse(v) === "string") return v;
		} catch {
			// Fall through and properly escape embedded quotes.
		}
	}
	if (v.startsWith("'") && v.endsWith("'") && v.length >= 2 && !v.slice(1, -1).replace(/''/g, "").includes("'")) return v;
	if (v.startsWith("[") && v.endsWith("]") && !v.startsWith("[[")) return v;
	if (/^[[{!&*?|>'%@`-]|:\s|:$|\s#|^\s|\s$|[\r\n"]/.test(v)) return JSON.stringify(v);
	return v;
}

export function frontMatter(text: string): FrontMatter {
	const none = { values: {}, lines: 0, body: text };
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	const start = TEMPLATE_HEADER_RE.test(lines[0] ?? "") ? 1 : 0;
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

/** A document's title: what its front matter says, or its first heading. */
export function titleOf(text: string): string {
	const { values, body } = frontMatter(text);
	const heading = body.split(/\r?\n/).map((line) => HEADING.exec(line)).find(Boolean);
	return one(values.title) || (heading ? plain(heading[2]!) : "");
}

/** The longest a one-line summary is. */
export const SUMMARY_MAX = 140;

/** What a document is about, in one line: its front matter's summary, or the first sentence of its first paragraph. */
export function summaryOf(text: string): string {
	const { values, body } = frontMatter(text);
	const said = one(values.summary);
	if (said) return said;
	const paragraph = body
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

/**
 * The text with one value of its front matter set: the key's own line is
 * changed where it has one, and added at the block's end where it has not.
 * A document with no front matter gets a block. Nothing else is touched, and
 * the file's own line ends are kept. A value that is a list under its key is
 * left alone: null says it could not be set.
 */
export function withFrontMatter(text: string, key: string, value: string): string | null {
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
	const openIdx = TEMPLATE_HEADER_RE.test(lines[0]?.text.replace(/^﻿/, "") ?? "") ? 1 : 0;
	const fenced = lines[openIdx]?.text.replace(/^﻿/, "").trim() === "---";
	const close = fenced ? lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line.text)) : -1;
	const safeVal = quoteYamlScalar(value);
	if (close < 0) return `---${eol}${key}: ${safeVal}${eol}---${eol}${eol}${text}`;
	// The last line that sets the key is the one that is read, so it is the one that is written.
	const at = lines.findLastIndex((line, i) => i > openIdx && i < close && new RegExp(`^${key}\\s*:`, "i").test(line.text));
	if (at < 0) return `${text.slice(0, lines[close]!.start)}${key}: ${safeVal}${eol}${text.slice(lines[close]!.start)}`;
	// A list written as dashes under the key is the person's layout: skip blank/comment lines when checking.
	if (/:\s*(?:#.*)?$/.test(lines[at]!.text)) {
		for (let j = at + 1; j < close; j++) {
			const next = lines[j]!.text.trim();
			if (!next || next.startsWith("#")) continue;
			if (/^-\s+/.test(next)) return null;
			break;
		}
	}
	return `${text.slice(0, lines[at]!.start)}${lines[at]!.text.slice(0, lines[at]!.text.indexOf(":"))}: ${safeVal}${text.slice(lines[at]!.end)}`;
}

/**
 * Adds `item` to a front matter list key (e.g. `specs: [a, b]`, `plans: [...]`, `related: [...]`).
 * Supports BOTH inline arrays (`key: [a, b]`) AND multi-line YAML bullet lists (`key:\n  - a`),
 * preserving the author's list style. If `item` is already present (case-insensitive), returns `text` unchanged.
 */
export function addToFrontMatterList(text: string, key: string, item: string): string | null {
	const wanted = item.trim();
	if (!wanted) return text;
	const existing = many(frontMatter(text).values[key.toLowerCase()]);
	if (existing.some((v) => v.toLowerCase() === wanted.toLowerCase())) return text;
	const quote = (v: string) => (/[:#[\]{},&*?|>!'"%@`]|^\s|\s$/.test(v) ? JSON.stringify(v) : v);
	const formatted = `[${[...existing, wanted].map(quote).join(", ")}]`;
	const inline = withFrontMatter(text, key, formatted);
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
	const openIdx = TEMPLATE_HEADER_RE.test(lines[0]?.text.replace(/^﻿/, "") ?? "") ? 1 : 0;
	const close = lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line.text));
	if (close < 0) return null;
	const at = lines.findLastIndex((line, i) => i > openIdx && i < close && new RegExp(`^${key}\\s*:`, "i").test(line.text));
	if (at < 0) return null;
	let lastItem = at;
	let indent = "  ";
	for (let j = at + 1; j < close; j++) {
		const t = lines[j]!.text;
		if (!t.trim() || t.trim().startsWith("#")) continue;
		const m = /^(\s*)-\s+/.exec(t);
		if (m) {
			indent = m[1] || "  ";
			lastItem = j;
		} else break;
	}
	const insertAt = lines[lastItem]!.end;
	return `${text.slice(0, insertAt)}${eol}${indent}- ${quote(wanted)}${text.slice(insertAt)}`;
}

/**
 * Removes `item` (case-insensitive) from a front matter list or scalar key.
 * If the key becomes empty, removes the key line(s) cleanly.
 */
export function removeFromFrontMatterList(text: string, key: string, item: string): string | null {
	const target = item.trim().toLowerCase();
	if (!target) return text;
	const fm = frontMatter(text);
	if (fm.lines < 2) return text;
	const existing = many(fm.values[key.toLowerCase()]);
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
	const openIdx = TEMPLATE_HEADER_RE.test(lines[0]?.text.replace(/^﻿/, "") ?? "") ? 1 : 0;
	const close = lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line.text));
	if (close < 0) return null;
	const at = lines.findLastIndex((line, i) => i > openIdx && i < close && new RegExp(`^${key}\\s*:`, "i").test(line.text));
	if (at < 0) return text;

	// Check if multi-line bullet list
	let isMulti = false;
	let listEnd = at;
	if (/:\s*(?:#.*)?$/.test(lines[at]!.text)) {
		for (let j = at + 1; j < close; j++) {
			const t = lines[j]!.text.trim();
			if (!t || t.startsWith("#")) continue;
			if (/^-\s+/.test(t)) {
				isMulti = true;
				listEnd = j;
			} else break;
		}
	}
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
	const quote = (v: string) => (/[:#[\]{},&*?|>!'"%@`]|^\s|\s$/.test(v) ? JSON.stringify(v) : v);
	const rawVal = lines[at]!.text.slice(lines[at]!.text.indexOf(":") + 1).trim();
	const nextVal = rawVal.startsWith("[") || kept.length > 1 ? `[${kept.map(quote).join(", ")}]` : quote(kept[0]!);
	return `${text.slice(0, lines[at]!.start)}${lines[at]!.text.slice(0, lines[at]!.text.indexOf(":"))}: ${nextVal}${text.slice(lines[at]!.end)}`;
}

/**
 * Replaces `oldItem` (case-insensitive) with `newItem` inside a scalar, inline list,
 * or multi-line YAML bullet list while preserving key position, YAML list style, and all other entries verbatim.
 */
export function replaceInFrontMatterList(text: string, key: string, oldItem: string, newItem: string): string | null {
	const target = oldItem.trim().toLowerCase();
	const next = newItem.trim();
	if (!target || !next) return text;
	const vals = many(frontMatter(text).values[key.toLowerCase()]);
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
	const openIdx = TEMPLATE_HEADER_RE.test(lines[0]?.text.replace(/^﻿/, "") ?? "") ? 1 : 0;
	const close = lines[openIdx]?.text.replace(/^﻿/, "").trim() === "---" ? lines.findIndex((line, i) => i > openIdx && /^(---|\.\.\.)\s*$/.test(line.text)) : -1;
	if (close < 0) return null;
	const at = lines.findLastIndex((line, i) => i > openIdx && i < close && new RegExp(`^${key}\\s*:`, "i").test(line.text));
	if (at < 0) return text;

	const quote = (v: string) => (/[:#[\]{},&*?|>!'"%@`]|^\s|\s$/.test(v) ? JSON.stringify(v) : v);

	// Check multi-line YAML bullet list
	let isMulti = false;
	let listEnd = at;
	if (/:\s*(?:#.*)?$/.test(lines[at]!.text)) {
		for (let j = at + 1; j < close; j++) {
			const t = lines[j]!.text.trim();
			if (!t || t.startsWith("#")) continue;
			if (/^-\s+/.test(t)) {
				isMulti = true;
				listEnd = j;
			} else break;
		}
	}
	if (isMulti) {
		const edits: { start: number; end: number; rep: string }[] = [];
		const alreadyHasNew = vals.some((v) => v.toLowerCase() === next.toLowerCase());
		for (let j = at + 1; j <= listEnd; j++) {
			const m = /^(\s*-\s+)(.*)$/.exec(lines[j]!.text);
			if (m && unquote(stripInlineComment(m[2]!)).toLowerCase() === target) {
				if (alreadyHasNew) {
					const nextLineEnd = j + 1 < lines.length ? lines[j + 1]!.start : text.length;
					edits.push({ start: lines[j]!.start, end: nextLineEnd, rep: "" });
				} else {
					edits.push({ start: lines[j]!.start, end: lines[j]!.end, rep: `${m[1]}${quote(next)}` });
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
	const formatted = rawVal.startsWith("[") || deduped.length > 1 ? `[${deduped.map(quote).join(", ")}]` : quoteYamlScalar(deduped[0]!);
	return `${text.slice(0, lines[at]!.start)}${lines[at]!.text.slice(0, lines[at]!.text.indexOf(":"))}: ${formatted}${text.slice(lines[at]!.end)}`;
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
	const openIdx = TEMPLATE_HEADER_RE.test(lines[0]?.text.replace(/^﻿/, "") ?? "") ? 1 : 0;
	if (lines[openIdx]?.text.replace(/^﻿/, "").trim() !== "---") return text;
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
	const firstLineEnd = text.indexOf("\n");
	const firstLine = (firstLineEnd < 0 ? text : text.slice(0, firstLineEnd)).replace(/\r$/, "").replace(/^﻿/, "");
	const openLine = TEMPLATE_HEADER_RE.test(firstLine) ? 2 : 1;
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
	if (!normalized) return "";
	return normalized.endsWith(eol) ? normalized : `${normalized}${eol}`;
}
