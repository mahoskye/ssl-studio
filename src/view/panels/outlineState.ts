// Pure state machine for context-aware auto-activating side panels:
// - Document outline ("objects"): defaults active on the right whenever an outlineable
//   file (SSL, Markdown, JSON, SQL, TOML, YAML, INI — NOT plan files) is open.
// - Plan palette ("palette"): defaults active on its docked side (left by default)
//   whenever a Plan chart is open.
// Both remember whether the user left them active or inactive across tab switches and
// reloads, and restore whatever the side was showing beforehand when leaving that context.
import type { PanelId } from "../state";

export type SideSnapshot = {
	open: boolean;
	view: PanelId | null;
};

export type OutlineMemory = {
	/** Whether the panel should automatically show when its context is active. Defaults to true. */
	active: boolean;
	/** What the panel's side was showing right before this panel took over. */
	before: SideSnapshot | null;
};

export type OutlineEffect = {
	memory: OutlineMemory;
	/** When non-null, apply this open/view update to the panel's side. */
	apply: { open?: boolean; view?: PanelId } | null;
};

export const outlineKey = (root: string) => `outline.active:${root}`;
export const planPaletteKey = (root: string) => `plan.palette.active:${root}`;

/** Parse persisted value: defaults to active (true) when unset. */
export const parseOutlineActive = (stored: string | null): boolean => stored !== "off";
export const formatOutlineActive = (active: boolean): "on" | "off" => (active ? "on" : "off");

/**
 * Generalized context transition for an auto-activating side panel (`panelId`):
 * - Becoming active while `memory.active` is true opens `panelId` on its side
 *   (unless `skipAutoOpen` is true, e.g. right-side panel in narrow single-sidebar mode)
 *   and snapshots what that side was showing beforehand.
 * - Leaving context never flips `memory.active`; if the side is currently showing
 *   `panelId`, it restores `memory.before` (or closes the side if nothing else was
 *   previously open there), falling back to `fallback` so the side's view stays valid.
 */
export function transitionPanelAvailability(
	panelId: PanelId,
	available: boolean,
	current: SideSnapshot,
	memory: OutlineMemory,
	fallback: PanelId | null,
	isValidRestore: (id: PanelId) => boolean,
	skipAutoOpen: boolean,
	closeWhenNoBefore = true,
): OutlineEffect {
	if (available) {
		if (!memory.active || skipAutoOpen) return { memory, apply: null };
		if (current.open && current.view === panelId) return { memory, apply: null };
		const before = current.view === panelId ? memory.before : { open: current.open, view: current.view };
		return {
			memory: { active: true, before },
			apply: { open: true, view: panelId },
		};
	}

	// Leaving context: preserve `memory.active` untouched.
	if (current.view !== panelId) {
		return { memory: { active: memory.active, before: null }, apply: null };
	}

	const prev = memory.before;
	const restoreView = prev?.view && prev.view !== panelId && isValidRestore(prev.view) ? prev.view : fallback;
	if (prev) {
		return {
			memory: { active: memory.active, before: null },
			apply: {
				open: prev.open && restoreView !== null,
				...(restoreView ? { view: restoreView } : {}),
			},
		};
	}

	// No prior snapshot (e.g. reloaded directly onto this context, then left it):
	// close the side when `closeWhenNoBefore` is true (e.g. right-side outline), or fall back
	// to the side's default view (e.g. Explorer on the left) without slamming the sidebar shut.
	return {
		memory: { active: memory.active, before: null },
		apply: {
			open: closeWhenNoBefore ? false : current.open && restoreView !== null,
			...(restoreView ? { view: restoreView } : {}),
		},
	};
}

/** Convenience wrapper for Document outline ("objects"). */
export function transitionOutlineAvailability(
	available: boolean,
	current: SideSnapshot,
	memory: OutlineMemory,
	fallback: PanelId | null,
	isValidRestore: (id: PanelId) => boolean,
	narrowRight: boolean,
): OutlineEffect {
	return transitionPanelAvailability("objects", available, current, memory, fallback, isValidRestore, narrowRight);
}

/**
 * Observe a user-initiated change on the panel's side while the panel's context IS active.
 * Updates `memory.active` to reflect whether the panel is currently active.
 */
export function observeOutlineState(isPanelActive: boolean, memory: OutlineMemory): OutlineMemory {
	return {
		active: isPanelActive,
		before: isPanelActive ? memory.before : null,
	};
}
