// Which lines of a text differ from an earlier text of it, for the marks in
// an editor's margin: lines that are new, lines that were changed, and
// places where lines were taken out. A longest-common-subsequence diff over
// whole lines: by a table where the texts are small enough for one, and by
// the number of lines that differ where they are not. No DOM.

export type LineChange = {
	kind: "added" | "modified" | "removed";
	/** The first line marked, from 1. For "removed": the line after which lines are gone (0 before the first line). */
	line: number;
	/** The last line marked. For "removed" the same as `line`. */
	endLine: number;
};

/**
 * As many cells of the diff's table as are worked out. A stretch too long for a table of that size is compared by
 * its differences instead (`fewChanges`), in as many steps at most; only when that is not enough either is the
 * middle of the text one changed block.
 */
const MAX_CELLS = 4_000_000;

const SAME = 0;
const GONE = 1;
const CAME = 2;

/**
 * The lines of `a` and `b` in order, each SAME, GONE (in `a` alone) or CAME (in `b` alone), with as few GONE and
 * CAME as can be: Myers' search, whose cost grows with the number of lines that differ and not with the product of
 * the lengths. Two edits five thousand lines apart are found in a few thousand steps, where the table would have
 * 25 million cells; for want of it, everything between two such edits was marked as changed. Null when the answer
 * takes more than `budget` steps, which is also the most this keeps (four bytes a step).
 */
function fewChanges(a: readonly string[], b: readonly string[], budget: number): Uint8Array | null {
	const n = a.length;
	const m = b.length;
	// At least as many lines differ as one text is longer than the other, and d differences cost d + 1 steps.
	if ((n - m) ** 2 / 2 > budget) return null;
	const most = Math.min(n + m, Math.ceil(Math.sqrt(2 * budget)) + 1);
	// How far along `a` each diagonal (x - y) has come; -1 where none has. The start is put where the first step finds it.
	const reach = new Int32Array(2 * most + 3).fill(-1);
	const mid = most + 1;
	reach[mid + 1] = 0;
	/** After each number of differences, the reach of its diagonals (-d, -d + 2, … d), to find the way back by. */
	const trace: Int32Array[] = [];
	let steps = 0;
	let found = -1;
	for (let d = 0; d <= most && found < 0; d++) {
		steps += d + 1;
		if (steps > budget) return null;
		const row = new Int32Array(d + 1).fill(-1);
		for (let k = -d; k <= d; k += 2) {
			if (k < -m || k > n) continue;
			const down = reach[mid + k + 1]!;
			const right = reach[mid + k - 1]!;
			const downOk = down >= 0 && down - k <= m;
			const rightOk = right >= 0 && right < n;
			if (!downOk && !rightOk) continue;
			let x = downOk && (!rightOk || down > right) ? down : right + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
				steps++;
			}
			row[(k + d) >> 1] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
		if (steps > budget) return null;
		// The row is of the diagonals of this step alone: those of the step before are read above, and stay as they were.
		for (let k = -d; k <= d; k += 2) reach[mid + k] = row[(k + d) >> 1]!;
		trace.push(row);
	}
	if (found < 0) return null;
	// The way back from the two ends, written from the end of the list.
	const ops = new Uint8Array(n + m);
	let at = ops.length;
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const k = x - y;
		const before = trace[d - 1]!;
		const reached = (diagonal: number) => (diagonal < 1 - d || diagonal > d - 1 ? -1 : before[(diagonal + d - 1) >> 1]!);
		const down = reached(k + 1);
		const right = reached(k - 1);
		const downOk = down >= 0 && down - k <= m;
		const rightOk = right >= 0 && right < n;
		const cameDown = downOk && (!rightOk || down > right);
		const from = cameDown ? down : right + 1;
		for (; x > from; x--, y--) ops[--at] = SAME;
		ops[--at] = cameDown ? CAME : GONE;
		if (cameDown) y--;
		else x--;
	}
	for (; x > 0; x--) ops[--at] = SAME;
	return ops.subarray(at);
}

/** One line of an alignment: in both texts, in the earlier one alone, or in the later one alone. */
export const LINE_SAME = SAME;
export const LINE_GONE = GONE;
export const LINE_CAME = CAME;

/**
 * Two lists of lines set side by side: for each line in order, whether it is in both (`LINE_SAME`), in `a`
 * alone (`LINE_GONE`) or in `b` alone (`LINE_CAME`), with as few of the last two as can be. The cost grows with
 * the number of lines that differ, so two long texts that differ in a few places are cheap. Null where it would
 * take more than `budget` steps.
 */
export function alignLines(a: readonly string[], b: readonly string[], budget = MAX_CELLS): Uint8Array | null {
	return fewChanges(a, b, budget);
}

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
	if (!a.length || !b.length) {
		block(a.length, b.length, head + b.length);
		return out;
	}
	if ((a.length + 1) * (b.length + 1) > maxCells) {
		const ops = fewChanges(a, b, maxCells);
		if (!ops) {
			block(a.length, b.length, head + b.length);
			return out;
		}
		let j = 0;
		let gone = 0;
		let came = 0;
		for (const op of ops) {
			if (op === GONE) {
				gone++;
				continue;
			}
			if (op === SAME) {
				block(gone, came, head + j);
				gone = came = 0;
			} else {
				came++;
			}
			j++;
		}
		block(gone, came, head + b.length);
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
