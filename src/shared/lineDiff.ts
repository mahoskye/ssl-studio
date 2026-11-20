// Which lines of a text differ from an earlier text of it, for the marks in
// an editor's margin: lines that are new, lines that were changed, and
// places where lines were taken out. A longest-common-subsequence diff over
// whole lines. No DOM.

export type LineChange = {
	kind: "added" | "modified" | "removed";
	/** The first line marked, from 1. For "removed": the line after which lines are gone (0 before the first line). */
	line: number;
	/** The last line marked. For "removed" the same as `line`. */
	endLine: number;
};

/** As many cells of the diff's table as are worked out; beyond this the middle of the text is one changed block. */
const MAX_CELLS = 4_000_000;

/** The changes that turn `before` into `after`, in the order of `after`'s lines. */
export function lineChanges(before: readonly string[], after: readonly string[], maxCells = MAX_CELLS): LineChange[] {
	let head = 0;
	while (head < before.length && head < after.length && before[head] === after[head]) head++;
	let tail = 0;
	while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
	const a = before.slice(head, before.length - tail);
	const b = after.slice(head, after.length - tail);
	const out: LineChange[] = [];
	/** `gone` lines of the earlier text and `came` lines of this one, ending before line `next` (0-based) of this one. */
	const block = (gone: number, came: number, next: number) => {
		if (came && gone) out.push({ kind: "modified", line: next - came + 1, endLine: next });
		else if (came) out.push({ kind: "added", line: next - came + 1, endLine: next });
		else if (gone) out.push({ kind: "removed", line: next, endLine: next });
	};
	if (!a.length || !b.length || a.length * b.length > maxCells) {
		block(a.length, b.length, head + b.length);
		return out;
	}
	// The table from the end, so that walking it forward takes the earliest match.
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
	}
	let i = 0;
	let j = 0;
	let gone = 0;
	let came = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			block(gone, came, head + j);
			gone = came = 0;
			i++;
			j++;
		} else if (j < b.length && (i === a.length || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) {
			came++;
			j++;
		} else {
			gone++;
			i++;
		}
	}
	block(gone, came, head + b.length);
	return out;
}
