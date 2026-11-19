// The tabs that were open in a folder, kept so that the folder opens next time
// as it was left. Only which files and which one was in front: unsaved text is
// not kept here (closing asks about it, ADR 0009).

export type TabGroup = { tabs: string[]; active: string | null };
export type TabSession = { groups: TabGroup[]; activeGroup: number };

/** Where a folder's tabs are kept, among the choices a view remembers. */
export const tabsKey = (root: string) => `tabs:${root}`;

export function packTabs(groups: readonly TabGroup[], activeGroup: number): string {
	return JSON.stringify({ groups: groups.map((g) => ({ tabs: [...g.tabs], active: g.active })), activeGroup });
}

/**
 * What was kept, read with suspicion: storage can hold anything. A tab that is
 * not a path, a second copy of one, and an active tab that is not among the
 * group's tabs are dropped; nothing usable gives null.
 */
export function unpackTabs(text: string | null | undefined): TabSession | null {
	if (!text) return null;
	let raw: any;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || !Array.isArray(raw.groups)) return null;
	const groups: TabGroup[] = raw.groups
		.filter((g: any) => g && Array.isArray(g.tabs))
		.map((g: any) => {
			const tabs = [...new Set<string>(g.tabs.filter((t: unknown) => typeof t === "string" && t))];
			return { tabs, active: typeof g.active === "string" && tabs.includes(g.active) ? g.active : (tabs[tabs.length - 1] ?? null) };
		});
	// A group with nothing in it is kept only as the first: an empty editor area.
	const kept = groups.filter((g, i) => i === 0 || g.tabs.length);
	if (!kept.some((g) => g.tabs.length)) return null;
	const wanted = Number.isInteger(raw.activeGroup) ? raw.activeGroup : 0;
	return { groups: kept, activeGroup: Math.min(Math.max(0, wanted), kept.length - 1) };
}

// --- the panels a folder was left with ----------------------------------------------------

/** Which side panel and which bottom panel were showing. */
export type ViewSession = { left?: string; bottom?: string };

/** Where a folder's panels are kept, among the choices a view remembers. */
export const viewsKey = (root: string) => `views:${root}`;

export const packViews = (left: string, bottom: string): string => JSON.stringify({ left, bottom });

/** What was kept, read with suspicion: only a panel that is one of those there are comes back. */
export function unpackViews(text: string | null | undefined, lefts: readonly string[], bottoms: readonly string[]): ViewSession {
	if (!text) return {};
	try {
		const raw = JSON.parse(text);
		return { ...(lefts.includes(raw?.left) ? { left: raw.left } : {}), ...(bottoms.includes(raw?.bottom) ? { bottom: raw.bottom } : {}) };
	} catch {
		return {};
	}
}
