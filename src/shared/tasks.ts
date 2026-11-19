import { frontMatter } from "./frontMatter";

// The items of a Markdown task list: "- [ ] the list has every sample". A
// ticket's "what done looks like" and a spec's "how it is checked" are lists
// of these, ticked as the work is done. Read from the text, and ticked by
// changing the one character between the brackets (ADR 0002).

export type Task = {
	/** Where the mark is in the text: the character between the brackets. */
	offset: number;
	/** Its line, from 1. */
	line: number;
	done: boolean;
	text: string;
};

// An item has words after its box: "- [ ]" alone is a bullet that holds brackets, as the renderer has it too.
const ITEM = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]\s+(\S.*)$/;

/** The task items in a document, in order. None from a code fence or the front matter. */
export function tasks(text: string): Task[] {
	const found: Task[] = [];
	const skipped = frontMatter(text).lines;
	let fence = "";
	let offset = 0;
	const lines = text.split("\n");
	for (let at = 0; at < lines.length; at++) {
		const raw = lines[at]!;
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const fenced = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (at >= skipped && fenced) {
			if (!fence) fence = fenced[1]!;
			else if (fenced[1]![0] === fence[0] && fenced[1]!.length >= fence.length && !fenced[2]!.trim()) fence = "";
		} else if (at >= skipped && !fence) {
			const item = ITEM.exec(line);
			if (item) found.push({ offset: offset + item[1]!.length, line: at + 1, done: item[2] !== " ", text: item[3]!.trim() });
		}
		offset += raw.length + 1;
	}
	return found;
}

/** How many of a document's tasks are done; null when it has none. */
export function taskTally(text: string): { done: number; total: number } | null {
	const all = tasks(text);
	return all.length ? { done: all.filter((task) => task.done).length, total: all.length } : null;
}

/** The text with its nth task ticked, or unticked: one character changed. Null when there is no such task. */
export function toggleTask(text: string, index: number): string | null {
	const task = tasks(text)[index];
	if (!task) return null;
	return `${text.slice(0, task.offset)}${task.done ? " " : "x"}${text.slice(task.offset + 1)}`;
}
