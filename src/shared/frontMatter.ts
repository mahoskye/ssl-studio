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

const unquote = (value: string) => {
	const v = value.trim();
	return v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")) ? v.slice(1, -1) : v;
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

const plain = (markdown: string) =>
	markdown
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`~]+/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** A document's title: what its front matter says, or its first heading. */
export function titleOf(text: string): string {
	const { values, body } = frontMatter(text);
	const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body);
	return one(values.title) || (heading ? plain(heading[1]!) : "");
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
	return sentence.length <= SUMMARY_MAX ? sentence : `${sentence.slice(0, sentence.lastIndexOf(" ", SUMMARY_MAX - 1))}…`;
}
