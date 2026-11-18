// Which row the keyboard lands on, in a list or a tree. Pure arithmetic, so
// it can be tested; Rows.tsx applies it to the rows on screen.

export type MoveKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";
const MOVE_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);
export const isMoveKey = (key: string): key is MoveKey => MOVE_KEYS.has(key);

/**
 * The row a movement key lands on, or -1 in an empty list. `current` is -1
 * when no row has focus yet: Down then starts at the top and Up at the bottom.
 * A list stops at its ends; a menu (`wrap`) goes round.
 */
export function moveIndex(count: number, current: number, key: MoveKey, options: { page?: number; wrap?: boolean } = {}): number {
	if (count <= 0) return -1;
	const last = count - 1;
	if (key === "Home") return 0;
	if (key === "End") return last;
	const back = key === "ArrowUp" || key === "PageUp";
	if (current < 0 || current > last) return back ? last : 0;
	const size = key === "PageDown" || key === "PageUp" ? Math.max(1, options.page ?? 10) : 1;
	const next = current + (back ? -size : size);
	if (options.wrap && size === 1) return next < 0 ? last : next > last ? 0 : next;
	return Math.max(0, Math.min(last, next));
}

/** A tree row as the keyboard sees it. `expanded` is undefined for a row with nothing under it. */
export type TreeRow = { level: number; expanded?: boolean };

/**
 * What Left or Right does on a tree row. Right opens a closed row, then steps
 * to its first child. Left closes an open row, then steps to its parent.
 */
export function treeStep(rows: TreeRow[], current: number, key: "ArrowLeft" | "ArrowRight"): { toggle: boolean; index: number } {
	const row = rows[current];
	const stay = { toggle: false, index: current };
	if (!row) return stay;
	if (key === "ArrowRight") {
		if (row.expanded === false) return { toggle: true, index: current };
		const child = rows[current + 1];
		return row.expanded && child && child.level > row.level ? { toggle: false, index: current + 1 } : stay;
	}
	if (row.expanded) return { toggle: true, index: current };
	for (let i = current - 1; i >= 0; i--) if (rows[i]!.level < row.level) return { toggle: false, index: i };
	return stay;
}

/**
 * The row typed letters land on: the next one whose label starts with them,
 * going round. One letter, or the same letter again, steps through the rows
 * that start with it. -1 when no row does.
 */
export function typeAhead(labels: string[], current: number, typed: string): number {
	const want = typed.toLowerCase();
	if (!want || !labels.length) return -1;
	const same = [...want].every((c) => c === want[0]);
	const prefix = same ? want[0]! : want;
	const start = same ? current + 1 : Math.max(0, current);
	for (let step = 0; step < labels.length; step++) {
		const at = (start + step) % labels.length;
		if (labels[at]!.trim().toLowerCase().startsWith(prefix)) return at;
	}
	return -1;
}

/**
 * The one row Tab stops on: the one that held the stop before, else the
 * selected row, else the first. -1 in an empty list.
 */
export function stopIndex(rows: { key: string; selected: boolean }[], stopKey: string | null): number {
	if (!rows.length) return -1;
	const kept = stopKey ? rows.findIndex((r) => r.key === stopKey) : -1;
	if (kept >= 0) return kept;
	return Math.max(0, rows.findIndex((r) => r.selected));
}

/**
 * Where focus goes when the focused row was redrawn or removed: the row with
 * the same key, else the row now at the same place, else the last. -1 in an
 * empty list.
 */
export function restoreIndex(keys: string[], key: string, index: number): number {
	if (!keys.length) return -1;
	const same = key ? keys.indexOf(key) : -1;
	return same >= 0 ? same : Math.max(0, Math.min(index, keys.length - 1));
}

/** One step round a ring of `count` things, either way. From outside the ring (-1), forward lands on the first and backward on the last. */
export function ringStep(index: number, step: 1 | -1, count: number): number {
	if (count <= 0) return -1;
	if (index < 0 || index >= count) return step === 1 ? 0 : count - 1;
	return (index + step + count) % count;
}
