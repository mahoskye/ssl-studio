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
