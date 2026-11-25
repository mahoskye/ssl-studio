// Turning the formatter's whole-range edits into small ones, and finding
// the lines a save changed, so format on save touches only those.

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

/** A text edit as the language server sends it: a range of lines and UTF-16 columns, and what replaces it. */
export type TextEdit = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };

/**
 * A text with the server's edits applied, for text that is in no editor. The
 * edits are the server's own (a formatting's), so they do not overlap; they are
 * applied from the last to the first, so an earlier one does not move a later.
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
	const placed = edits.map((e) => ({ from: offset(e.range.start), to: offset(e.range.end), text: e.newText })).sort((a, b) => b.from - a.from || b.to - a.to);
	let out = text;
	for (const e of placed) out = out.slice(0, e.from) + e.text + out.slice(e.to);
	return out;
}
