import { marked, type Token, type Tokens } from "marked";
import { bodyOffset } from "./frontMatter";

// The items of a Markdown task list: "- [ ] the list has every sample". A
// ticket's "what done looks like" and a spec's "how it is checked" are lists
// of these, ticked as the work is done.
//
// Which lines are task items is the renderer's to say, not this file's: the
// rendered page shows a box for each, and the nth box must be the nth item
// here. So the items are read with the renderer's own lexer, and each is then
// found in the text, to be ticked by changing the one character between its
// brackets (ADR 0002). An item that cannot be found in the text is still
// counted, and cannot be ticked from the page.

export type Task = {
	/** Where the mark is in the text: the character between the brackets. -1 when the item could not be placed in the text. */
	offset: number;
	/** Its line, from 1; 0 when it could not be placed. */
	line: number;
	done: boolean;
	text: string;
};

/** A line that may be a task item, read loosely: the renderer decides which of these are. */
const ITEM = /^(\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)+\[)([ xX])\](?:[ \t]+(.*))?$/;

/** The task items in a document, in the order the rendered page shows their boxes. */
export function tasks(text: string): Task[] {
	const start = bodyOffset(text);
	const body = text.slice(start);
	if (!/\[[ xX]\]/.test(body)) return [];
	// The lexer reads line ends as plain ones: the text is read that way too, and each place is taken back to the original.
	const plain = body.replace(/\r\n/g, "\n");
	const original = (at: number) => {
		let shift = 0;
		for (let i = body.indexOf("\r\n"); i >= 0 && i - shift < at; i = body.indexOf("\r\n", i + 2)) shift++;
		return start + at + shift;
	};

	// What the renderer takes for a task item, in the order it draws them.
	const read: { done: boolean; first: string; text: string }[] = [];
	const walk = (tokens: Token[] | undefined) => {
		for (const token of tokens ?? []) {
			if (token.type === "list") {
				for (const item of (token as Tokens.List).items) {
					if (item.task) {
						const lines = item.text.split("\n").map((line) => line.trim());
						read.push({ done: Boolean(item.checked), first: lines[0] ?? "", text: lines.find(Boolean) ?? "" });
					}
					walk(item.tokens);
				}
			} else if ("tokens" in token && token.tokens) walk(token.tokens);
		}
	};
	const tokens = marked.lexer(plain, { gfm: true });
	walk(tokens);
	if (!read.length) return [];

	// Code and raw HTML at the top of the document hold no items, whatever their lines look like.
	const closed: [number, number][] = [];
	let at = 0;
	for (const token of tokens) {
		if (token.type === "code" || token.type === "html") closed.push([at, at + token.raw.length]);
		at += token.raw.length;
	}
	const candidates: { offset: number; done: boolean; text: string; line: number }[] = [];
	let offset = 0;
	const lines = plain.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const item = closed.some(([from, to]) => offset >= from && offset < to) ? null : ITEM.exec(line);
		if (item) candidates.push({ offset: offset + item[1]!.length, done: item[2] !== " ", text: (item[3] ?? "").trim(), line: index });
		offset += line.length + 1;
	}

	// Each item is the next line that says what it says: the same words, in the same state.
	const before = text.slice(0, start).split("\n").length - 1;
	let next = 0;
	return read.map((item) => {
		const found = candidates.findIndex((candidate, index) => index >= next && candidate.done === item.done && candidate.text === item.first);
		if (found < 0) return { offset: -1, line: 0, done: item.done, text: item.text };
		next = found + 1;
		return { offset: original(candidates[found]!.offset), line: before + candidates[found]!.line + 1, done: item.done, text: item.text };
	});
}

/** How many of a document's tasks are done; null when it has none. */
export function taskTally(text: string): { done: number; total: number } | null {
	const all = tasks(text);
	return all.length ? { done: all.filter((task) => task.done).length, total: all.length } : null;
}

/** The text with its nth task ticked, or unticked: one character changed. Null when there is no such task, or it could not be placed in the text. */
export function toggleTask(text: string, index: number): string | null {
	const task = tasks(text)[index];
	if (!task || task.offset < 0 || !/[ xX]/.test(text[task.offset] ?? "")) return null;
	return `${text.slice(0, task.offset)}${task.done ? " " : "x"}${text.slice(task.offset + 1)}`;
}
