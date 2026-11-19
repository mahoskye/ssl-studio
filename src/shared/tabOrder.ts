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
