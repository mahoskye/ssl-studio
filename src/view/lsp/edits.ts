// Turning the formatter's whole-range edits into small ones, and finding
// the lines a save changed, so format on save touches only those.
import { alignLines, LINE_CAME, LINE_SAME } from "../../shared/lineDiff";

export type LineEdit = { startLine: number; endLine: number; lines: string[] };

/**
 * Trims a replacement of `oldLines` by `newLines` to the changed middle.
 * Lines are 0-based; endLine is inclusive. Null when nothing changed.
 */
export function trimEdit(oldLines: string[], newLines: string[]): LineEdit | null {
	let head = 0;
	while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
	if (head === oldLines.length && head === newLines.length) return null;
	let tail = 0;
	while (
		tail < oldLines.length - head &&
		tail < newLines.length - head &&
		oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
	)
		tail++;
	return { startLine: head, endLine: oldLines.length - 1 - tail, lines: newLines.slice(head, newLines.length - tail) };
}

/**
 * The size, in characters, up to which a document is formatted whole to take some of its lines from (a save's
 * changed lines, a selection). The server formats a script of this size in a few tenths of a second; a larger one
 * is asked for its ranges alone.
 */
export const FORMAT_WHOLE_UP_TO = 400_000;

/**
 * The lines a selection covers, 0-based and inclusive, as Format Selection takes them: every line it touches, but
 * not the line it ends at the very start of. An empty selection is its own line.
 */
export function selectedLines(range: { startLineNumber: number; endLineNumber: number; endColumn: number }): [number, number][] {
	const last = range.endLineNumber > range.startLineNumber && range.endColumn === 1 ? range.endLineNumber - 1 : range.endLineNumber;
	return [[range.startLineNumber - 1, last - 1]];
}

/**
 * The ranges of `after` (0-based, inclusive line pairs) that differ from
 * `before`, by a longest-common-subsequence diff over lines. Big files fall
 * back to the single trimmed range between the first and last change.
 */
export function changedRanges(before: string[], after: string[], maxCells = 4_000_000): [number, number][] {
	const trimmed = trimEdit(before, after);
	if (!trimmed) return [];
	const head = trimmed.startLine;
	const a = before.slice(head, trimmed.endLine + 1);
	const b = trimmed.lines;
	if (!b.length) return [[Math.max(0, head - 1), Math.max(0, head - 1)]];
	if (a.length * b.length > maxCells) return [[head, head + b.length - 1]];
	// LCS table, from the end, so walking forward is greedy.
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
	const ranges: [number, number][] = [];
	let i = 0;
	let j = 0;
	let start = -1;
	const close = (end: number) => {
		if (start >= 0) {
			if (end < start) {
				const at = Math.max(0, head + end);
				ranges.push([at, at]);
			} else {
				ranges.push([head + start, head + end]);
			}
		}
		start = -1;
	};
	while (j < b.length) {
		if (i < a.length && a[i] === b[j]) {
			close(j - 1);
			i++;
			j++;
		} else if (i < a.length && table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
			i++; // a deleted line: mark the line now at its place
			if (start < 0) start = j;
		} else {
			if (start < 0) start = j;
			j++;
		}
	}
	close(b.length - 1);
	// Lines deleted after the last kept line: mark the line before them.
	if (i < a.length) ranges.push([head + b.length - 1, head + b.length - 1]);
	return merge(ranges);
}

function merge(ranges: [number, number][]): [number, number][] {
	const sorted = ranges.filter(([s, e]) => e >= s).sort((x, y) => x[0] - y[0]);
	const result: [number, number][] = [];
	for (const range of sorted) {
		const last = result.at(-1);
		if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
		else result.push([...range]);
	}
	return result;
}

/** The first of the two UTF-16 units of a character outside the basic plane (an emoji, say). */
const opensPair = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

/**
 * The smallest single replacement turning `before` into `after`, by offsets into `before`.
 *
 * It never starts or ends between the two units of one character. The texts are compared unit by unit, and 🔴 and
 * 🟢 have the same first unit: a status changed from one to the other gave a replacement that started inside the
 * pair. The editor will not cut a pair, so it widened the range to take the first unit in, the new text still held
 * only the second, and half a character was left in the document. So what is the same stops short of a first
 * unit, at either end, in either text.
 */
export function minimalReplace(before: string, after: string): { start: number; end: number; text: string } | null {
	if (before === after) return null;
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	while (start > 0 && opensPair(before.charCodeAt(start - 1))) start--;
	let tail = 0;
	while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
	while (tail > 0 && (opensPair(before.charCodeAt(before.length - tail - 1)) || opensPair(after.charCodeAt(after.length - tail - 1)))) tail--;
	return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}

const SURROGATE = /[\ud800-\udfff]/;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * How many of the characters that stand just before the word being completed a completion's text repeats.
 *
 * A server that names no range for its text leaves the range to the editor, which takes the word at the cursor.
 * A text that opens with punctuation the word does not hold was then put in after that punctuation: ":WHILE"
 * taken for a typed ":wh" left "::WHILE". The count says how far back the replaced range must reach so that
 * what was typed is replaced and not repeated.
 *
 * Only punctuation counts, since letters and digits are the word itself, and the rule is the same for any
 * language: this knows nothing of what the punctuation means. In a snippet, `$` and `\` open a placeholder or
 * an escape and are not text.
 */
export function typedLead(before: string, insert: string, snippet = false): number {
	let lead = 0;
	while (lead < insert.length) {
		const ch = insert[lead]!;
		if (/\s/.test(ch) || WORD_CHARACTER.test(ch) || SURROGATE.test(ch) || (snippet && (ch === "$" || ch === "\\"))) break;
		lead++;
	}
	for (let count = Math.min(lead, before.length); count > 0; count--) if (before.endsWith(insert.slice(0, count))) return count;
	return 0;
}

/**
 * A change within a block of lines: the range it replaces, in lines and UTF-16 columns from 0 within the block,
 * and the text put there, its lines joined by "\n".
 */
export type SmallEdit = { startLine: number; startColumn: number; endLine: number; endColumn: number; text: string };

/** What a formatter leaves of a line whatever it does to it: its text without the spacing and the letter case. */
const lineKey = (line: string) => line.replace(/\s+/g, "").toLowerCase();

/** The pairs (i, j) of a longest common subsequence of two sequences of lengths `n` and `m`, in order. */
function commonPairs(n: number, m: number, same: (i: number, j: number) => boolean): [number, number][] {
	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			table[i * width + j] = same(i, j) ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
	const pairs: [number, number][] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (same(i, j)) pairs.push([i++, j++]);
		else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
		else j++;
	}
	return pairs;
}

/** One line turned into another by changing only the characters that differ. */
function withinLine(line: number, before: string, after: string, maxCells: number): SmallEdit[] {
	if (before === after) return [];
	// Compared unit by unit, a character of two units could be cut in half (see `minimalReplace`), and a very
	// long line would cost a large table: such a line is changed in one piece.
	if (SURROGATE.test(before) || SURROGATE.test(after) || before.length * after.length > maxCells) {
		const one = minimalReplace(before, after)!;
		return [{ startLine: line, startColumn: one.start, endLine: line, endColumn: one.end, text: one.text }];
	}
	const edits: SmallEdit[] = [];
	let i = 0;
	let j = 0;
	for (const [keptI, keptJ] of [...commonPairs(before.length, after.length, (a, b) => before[a] === after[b]), [before.length, after.length] as [number, number]]) {
		if (keptI > i || keptJ > j) edits.push({ startLine: line, startColumn: i, endLine: line, endColumn: keptI, text: after.slice(j, keptJ) });
		i = keptI + 1;
		j = keptJ + 1;
	}
	return edits;
}

/**
 * The smallest edits that turn the block `oldLines` into `newLines`, for a formatter's change: a line the
 * formatter kept (the same text but for spacing and letter case) is changed only where its characters differ,
 * and only lines it added, took out or rewrote are replaced whole.
 *
 * One edit over the whole block makes the same text, but an editor's cursor inside a replaced range has nowhere
 * to stay: it is put at the range's edge. Format on save replaced the whole procedure, so the cursor left the
 * line being typed on every save. With these edits it stays on its line, and at its place in it.
 *
 * Both blocks hold at least one line. No two edits touch: where they would, they are one edit, so the order of
 * two edits at one position is never asked of the editor. A block too large for the table is one edit.
 */
export function smallEdits(oldLines: readonly string[], newLines: readonly string[], maxCells = 1_000_000, maxLineCells = 40_000): SmallEdit[] {
	const n = oldLines.length;
	const m = newLines.length;
	if (!n) return [];
	const whole = (): SmallEdit[] => [{ startLine: 0, startColumn: 0, endLine: n - 1, endColumn: oldLines[n - 1]!.length, text: newLines.join("\n") }];
	if (!m || n * m > maxCells) return whole();
	const oldKeys = oldLines.map(lineKey);
	const newKeys = newLines.map(lineKey);
	const edits: SmallEdit[] = [];
	let i = 0;
	let j = 0;
	for (const [keptI, keptJ] of [...commonPairs(n, m, (a, b) => oldKeys[a] === newKeys[b]), [n, m] as [number, number]]) {
		const gone = keptI - i;
		const came = newLines.slice(j, keptJ).join("\n");
		if (gone && keptJ > j) {
			edits.push({ startLine: i, startColumn: 0, endLine: keptI - 1, endColumn: oldLines[keptI - 1]!.length, text: came });
		} else if (gone) {
			// Lines taken out: with the line end after them, or at the block's end with the one before them.
			if (keptI < n) edits.push({ startLine: i, startColumn: 0, endLine: keptI, endColumn: 0, text: "" });
			else edits.push({ startLine: i - 1, startColumn: oldLines[i - 1]!.length, endLine: n - 1, endColumn: oldLines[n - 1]!.length, text: "" });
		} else if (keptJ > j) {
			// Lines added: before the line they come before, or at the block's end after its last line.
			if (i < n) edits.push({ startLine: i, startColumn: 0, endLine: i, endColumn: 0, text: `${came}\n` });
			else edits.push({ startLine: n - 1, startColumn: oldLines[n - 1]!.length, endLine: n - 1, endColumn: oldLines[n - 1]!.length, text: `\n${came}` });
		}
		if (keptI < n) edits.push(...withinLine(keptI, oldLines[keptI]!, newLines[keptJ]!, maxLineCells));
		i = keptI + 1;
		j = keptJ + 1;
	}
	const joined: SmallEdit[] = [];
	for (const edit of edits) {
		const last = joined.at(-1);
		if (last && last.endLine === edit.startLine && last.endColumn === edit.startColumn) {
			last.endLine = edit.endLine;
			last.endColumn = edit.endColumn;
			last.text += edit.text;
		} else joined.push({ ...edit });
	}
	return joined;
}

/** Some lines of a text, and the lines a format of the whole text has in their place. `start` is the first line, from 0. */
export type FormattedPart = { start: number; oldLines: string[]; newLines: string[] };

/**
 * For each range of lines (from 0, both ends included), the lines the formatter's text of the whole document has
 * in their place: what a format of the document would make of those lines, and of no others.
 *
 * Format on save formats the lines that changed, and asked the server to format those ranges. A range format
 * leaves out what the server does to a whole document only (the letter case of built-in functions, the blank
 * lines between blocks), so a file saved "formatted" changed again under "Format document". Taken from a format
 * of the whole document, the changed lines are as that command leaves them.
 *
 * The two texts are set side by side by their lines without spacing and letter case, which is all a formatter
 * changes in a line it keeps. Lines the formatter added just before a range or just after it (a blank line
 * between two procedures) go with the range. Null where the texts differ in too many lines to set side by side.
 */
export function formattedParts(oldLines: readonly string[], newLines: readonly string[], ranges: readonly [number, number][], budget?: number): FormattedPart[] | null {
	const n = oldLines.length;
	const ops = alignLines(oldLines.map(lineKey), newLines.map(lineKey), budget);
	if (!ops) return null;
	// For each line of the text as it is: how many of the formatter's lines stand before it once the lines added
	// before it are counted (`reach`), and how many before those are (`lead`).
	const lead = new Uint32Array(n + 1);
	const reach = new Uint32Array(n + 1);
	let i = 0;
	let j = 0;
	for (const op of ops) {
		if (op === LINE_CAME) {
			j++;
			continue;
		}
		reach[i] = j;
		if (op === LINE_SAME) j++;
		lead[++i] = j;
	}
	reach[n] = newLines.length;
	// Two ranges that touch would both take the lines added between them: they are one range.
	const merged: [number, number][] = [];
	for (const [start, end] of [...ranges].map(([s, e]): [number, number] => [Math.max(0, s), Math.min(n - 1, e)]).filter(([s, e]) => e >= s).sort((x, y) => x[0] - y[0])) {
		const last = merged.at(-1);
		if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged.map(([start, end]) => ({ start, oldLines: oldLines.slice(start, end + 1), newLines: newLines.slice(lead[start]!, reach[end + 1]!) }));
}

/** A text edit as the language server sends it: a range of lines and UTF-16 columns, and what replaces it. */
export type TextEdit = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };

/**
 * A text with the server's edits applied, for text that is in no editor. The
 * edits are the server's own (a formatting's), so they do not overlap; they are
 * applied from the last to the first, so an earlier one does not move a later.
 *
 * Several edits at one position come out in the order the server listed them: the first listed stands first in
 * the text, as the protocol says of inserts at one position. Going from the last to the first, that is the later
 * listed applied first. Left to the sort, two inserts at one position were applied as listed, and so came out
 * reversed. An insert where a replacement starts stands before the replacement, whichever was listed first.
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	const offset = (at: { line: number; character: number }) => {
		const line = Math.max(0, at.line);
		if (line >= starts.length) return text.length;
		let end: number;
		if (line + 1 < starts.length) {
			end = starts[line + 1]! - 1;
			if (end > starts[line]! && text[end - 1] === "\r") end--;
		} else {
			end = text.length;
		}
		return Math.min(starts[line]! + Math.max(0, at.character), end);
	};
	const placed = edits
		.map((e, listed) => ({ from: offset(e.range.start), to: offset(e.range.end), text: e.newText, listed }))
		.sort((a, b) => b.from - a.from || b.to - a.to || b.listed - a.listed);
	let out = text;
	for (const e of placed) out = out.slice(0, e.from) + e.text + out.slice(e.to);
	return out;
}
