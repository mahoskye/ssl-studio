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

	// Code and raw HTML — both top-level and nested inside blockquotes/lists — hold no task items.
	const closed: [number, number][] = [];
	const markNestedRaw = (raw: string, boundStart: number, boundEnd: number): number => {
		if (!raw) return boundStart;
		const direct = plain.indexOf(raw, boundStart);
		if (direct >= 0 && direct + raw.length <= boundEnd) {
			closed.push([direct, direct + raw.length]);
			return direct + raw.length;
		}
		// Inside blockquotes, `marked` strips leading `> ` prefixes from nested `code`/`html` raw text.
		const rawLines = raw.replace(/\n$/, "").split("\n").map((l) => l.trim());
		const firstNonEmpty = rawLines.find(Boolean);
		if (!firstNonEmpty) return boundStart;
		const slice = plain.slice(boundStart, boundEnd);
		const sliceLines = slice.split("\n");
		let pos = boundStart;
		for (let i = 0; i < sliceLines.length; i++) {
			const stripped = sliceLines[i]!.replace(/^(?:[ \t]*>[ \t]*)+/, "").trim();
			if (stripped === rawLines[0] || (!rawLines[0] && stripped === firstNonEmpty)) {
				let matched = true;
				let endPos = pos;
				for (let j = 0; j < rawLines.length; j++) {
					if (i + j >= sliceLines.length) {
						matched = false;
						break;
					}
					const cand = sliceLines[i + j]!.replace(/^(?:[ \t]*>[ \t]*)+/, "").trim();
					if (cand !== rawLines[j]) {
						matched = false;
						break;
					}
					endPos += sliceLines[i + j]!.length + 1;
				}
				if (matched) {
					closed.push([pos, Math.min(boundEnd, endPos)]);
					return Math.min(boundEnd, endPos);
				}
			}
			pos += sliceLines[i]!.length + 1;
		}
		return boundStart;
	};
	const collectClosed = (toks: Token[] | undefined, boundStart: number, boundEnd: number, isTopLevel: boolean) => {
		let cursor = boundStart;
		for (const token of toks ?? []) {
			const raw = token.raw ?? "";
			let tokStart = cursor;
			let tokEnd = Math.min(boundEnd, cursor + raw.length);
			if (!isTopLevel && raw) {
				const found = plain.indexOf(raw, cursor);
				if (found >= 0 && found + raw.length <= boundEnd) {
					tokStart = found;
					tokEnd = found + raw.length;
				}
			}
			if (token.type === "code" || token.type === "html") {
				if (isTopLevel) {
					closed.push([tokStart, tokEnd]);
					cursor = tokEnd;
				} else {
					cursor = Math.max(cursor, markNestedRaw(raw, cursor, boundEnd));
				}
				continue;
			}
			if (token.type === "list") {
				let itemCursor = tokStart;
				for (const item of (token as Tokens.List).items) {
					const itemRaw = item.raw ?? "";
					const itemAt = itemRaw ? plain.indexOf(itemRaw, itemCursor) : -1;
					const iStart = itemAt >= 0 && itemAt < boundEnd ? itemAt : itemCursor;
					const iEnd = itemAt >= 0 ? Math.min(boundEnd, itemAt + itemRaw.length) : tokEnd;
					collectClosed(item.tokens, iStart, iEnd, false);
					if (itemAt >= 0) itemCursor = iEnd;
				}
			} else if ("tokens" in token && token.tokens) {
				collectClosed(token.tokens, tokStart, isTopLevel ? tokEnd : boundEnd, false);
			}
			if (isTopLevel) cursor = tokEnd;
		}
	};
	collectClosed(tokens, 0, plain.length, true);

	const candidates: { offset: number; done: boolean; text: string; line: number }[] = [];
	let offset = 0;
	let nestedFence: { quoteDepth: number; ch: string; len: number } | null = null;
	const lines = plain.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const alreadyClosed = closed.some(([from, to]) => offset >= from && offset < to);
		// Also track fenced code blocks nested inside blockquotes/lists directly so checkboxes in nested fences are never matched.
		const bqMatch = /^([ \t]*(?:>[ \t]*)*)/.exec(line)!;
		const quoteDepth = (bqMatch[1]!.match(/>/g)?.length ?? 0);
		const rest = line.slice(bqMatch[1]!.length);
		let inNestedFence = false;
		if (nestedFence) {
			if (quoteDepth < nestedFence.quoteDepth) {
				nestedFence = null;
			} else {
				inNestedFence = true;
				if (new RegExp(`^[ \\t]*${nestedFence.ch}{${nestedFence.len},}[ \\t]*$`).test(rest)) {
					nestedFence = null;
				}
			}
		}
		if (!inNestedFence && !alreadyClosed) {
			const open = /^(`{3,}|~{3,})(.*)$/.exec(rest);
			if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
				nestedFence = { quoteDepth, ch: open[1]![0]!, len: open[1]!.length };
				inNestedFence = true;
			}
		}
		const item = alreadyClosed || inNestedFence ? null : ITEM.exec(line);
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
