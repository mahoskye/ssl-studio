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
	for (const ch of inner) {
		if (quote) {
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

export function frontMatter(text: string): FrontMatter {
	const none = { values: {}, lines: 0, body: text };
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return none;
	const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
	if (end < 0) return none;
	const values: Record<string, string | string[]> = {};
	let listKey = "";
	for (const line of lines.slice(1, end)) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && listKey) {
			(values[listKey] as string[]).push(unquote(item[1]!));
			continue;
		}
		const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!pair) continue;
		const key = pair[1]!.toLowerCase();
		const value = pair[2]!.trim();
		listKey = "";
		if (!value) {
			values[key] = [];
			listKey = key;
		} else if (value.startsWith("[") && value.endsWith("]")) values[key] = inlineList(value.slice(1, -1));
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
export const plainMarkdown = (markdown: string) =>
	markdown
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`+([^`]*)`+/g, "$1")
		.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
		.replace(/(^|[^\w*])(\*\*|\*)(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3")
		.replace(/(^|[^\w])(__|_)(?=\S)(.+?)(?<=\S)\2(?![\w])/g, "$1$3")
		.replace(/\s+/g, " ")
		.trim();
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
	return `${sentence.slice(0, space > 0 ? space : SUMMARY_MAX - 1)}…`;
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
	const lines = text.split(/\r?\n/);
	const fenced = lines[0]?.replace(/^﻿/, "").trim() === "---";
	const end = fenced ? lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line)) : -1;
	if (end < 0) return `---${eol}${key}: ${value}${eol}---${eol}${eol}${text}`;
	const at = lines.findIndex((line, i) => i > 0 && i < end && new RegExp(`^${key}\\s*:`, "i").test(line));
	if (at < 0) lines.splice(end, 0, `${key}: ${value}`);
	else {
		// A list written as dashes under the key is the person's layout: not rewritten here.
		if (/:\s*$/.test(lines[at]!) && /^\s*-\s+/.test(lines[at + 1] ?? "")) return null;
		lines[at] = `${lines[at]!.slice(0, lines[at]!.indexOf(":"))}: ${value}`;
	}
	return lines.join(eol);
}
