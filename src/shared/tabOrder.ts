// The order tabs were last used in, for going to the one used before this
// one (Ctrl+Tab): most recent first. No view and no state: a list in, a list
// out.

/** The order with this tab used now: first, and once. */
export function used(order: readonly string[], path: string): string[] {
	return [path, ...order.filter((other) => other !== path)];
}

/** The order with only the tabs that are still open, and any open tab it did not know put last. */
export function ofOpen(order: readonly string[], open: readonly string[]): string[] {
	return [...order.filter((path) => open.includes(path)), ...open.filter((path) => !order.includes(path))];
}

/**
 * The tab to show when stepping through the order: `step` places from the
 * tab at `at`, round and round. With one tab or none there is nowhere to go.
 */
export function stepped(order: readonly string[], at: number, step: number): { path: string; at: number } | null {
	if (order.length < 2) return null;
	const next = (((at + step) % order.length) + order.length) % order.length;
	return { path: order[next]!, at: next };
}

/**
 * Whether a walk through the tabs (Ctrl held, Tab pressed again and again)
 * still stands: every tab of it is still open, and the one it stopped at is
 * the one showing. A tab closed or shown some other way meanwhile ends the
 * walk, and the next step starts a new one from what is showing now.
 */
export function walkHolds(order: readonly string[], at: number, open: readonly string[], showing: string | null): boolean {
	return order[at] === showing && order.every((path) => open.includes(path));
}

// --- pinned tabs, and closing many at once ---------------------------------------------------

/**
 * A group's tabs with one pinned or let go. Pinned tabs stand first, in the
 * order they were pinned; a tab let go stands first among the others.
 */
export function withPin(tabs: readonly string[], pinned: readonly string[], path: string, pin: boolean): { tabs: string[]; pinned: string[] } {
	if (!tabs.includes(path)) return { tabs: [...tabs], pinned: pinned.filter((p) => tabs.includes(p)) };
	const pins = pin ? [...pinned.filter((p) => p !== path && tabs.includes(p)), path] : pinned.filter((p) => p !== path && tabs.includes(p));
	const rest = tabs.filter((tab) => !pins.includes(tab) && tab !== path);
	return { tabs: pin ? [...pins, ...rest] : [...pins, path, ...rest], pinned: pins };
}

/** The tabs "close others" closes: every one but the tab kept and the pinned. */
export function othersOf(tabs: readonly string[], pinned: readonly string[], keep: string | null): string[] {
	return tabs.filter((tab) => tab !== keep && !pinned.includes(tab));
}

/** The tabs "close to the right" closes: those after the tab, the pinned left alone. */
export function rightOf(tabs: readonly string[], pinned: readonly string[], path: string): string[] {
	const at = tabs.indexOf(path);
	return at < 0 ? [] : tabs.slice(at + 1).filter((tab) => !pinned.includes(tab));
}

// --- tabs moved by hand --------------------------------------------------------------------

/**
 * A group's tabs with one put before another, or last when `before` is null
 * or is not there. The pinned stay first: a pinned tab dropped among the
 * others stands last of the pinned, and another dropped among the pinned
 * stands first of the others.
 */
export function placed(tabs: readonly string[], pinned: readonly string[], path: string, before: string | null): string[] {
	const rest = tabs.filter((tab) => tab !== path);
	const pins = rest.filter((tab) => pinned.includes(tab)).length;
	const asked = before !== null && before !== path && rest.includes(before) ? rest.indexOf(before) : before === path ? tabs.indexOf(path) : rest.length;
	const at = pinned.includes(path) ? Math.min(asked, pins) : Math.max(asked, pins);
	return [...rest.slice(0, at), path, ...rest.slice(at)];
}

/**
 * The tab a dragged one would stand before if it were let go now, null for
 * last: where the mark is drawn, which is where it lands and not always
 * where the pointer is (the pinned stay first). `path` need not be in the
 * row yet: a tab from another group comes in not pinned.
 */
export function landsBefore(tabs: readonly string[], pinned: readonly string[], path: string, before: string | null): string | null {
	const row = placed(tabs.includes(path) ? tabs : [...tabs, path], tabs.includes(path) ? pinned : pinned.filter((tab) => tab !== path), path, before);
	return row[row.indexOf(path) + 1] ?? null;
}

/** A row of tabs: what a group of editors keeps. */
export type TabRow = { tabs: string[]; active: string | null; pinned?: string[] };

/**
 * The groups after a tab was dragged from one to another, to stand before
 * `before` there (last, with null). In the group it came to it is the tab
 * shown, and not pinned; the group it left shows the tab that was beside it.
 * A group left with no tabs goes, unless it is the only one. `active` is
 * where the group it came to now is.
 */
export function movedAcross<G extends TabRow>(groups: readonly G[], path: string, from: number, to: number, before: string | null): { groups: G[]; active: number } {
	const source = groups[from];
	const target = groups[to];
	if (!source || !target || !source.tabs.includes(path)) return { groups: [...groups], active: Math.min(Math.max(from, 0), Math.max(groups.length - 1, 0)) };
	if (from === to) return { groups: groups.map((g, i) => (i === from ? { ...g, tabs: placed(g.tabs, g.pinned ?? [], path, before) } : g)), active: from };
	const at = source.tabs.indexOf(path);
	const left = source.tabs.filter((tab) => tab !== path);
	const pins = (source.pinned ?? []).filter((tab) => tab !== path);
	const next = groups.map((g, i): G => {
		if (i === from) return { ...g, tabs: left, active: g.active === path ? (left[Math.min(at, left.length - 1)] ?? null) : g.active, ...(g.pinned ? { pinned: pins } : {}) };
		// A file the group already shows is not shown twice: its tab there comes to the front where it stands.
		if (i === to) return { ...g, tabs: g.tabs.includes(path) ? [...g.tabs] : placed([...g.tabs, path], g.pinned ?? [], path, before), active: path };
		return g;
	});
	if (left.length || next.length < 2) return { groups: next, active: to };
	return { groups: next.filter((_, i) => i !== from), active: to > from ? to - 1 : to };
}
