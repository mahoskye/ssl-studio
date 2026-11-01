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
		if (start >= 0) ranges.push([head + start, head + end]);
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
