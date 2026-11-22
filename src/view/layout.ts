// How the window's space is shared between the sidebars, editor area and bottom
// panel: pure math, so every rule can be tested directly.
//
// Baseline: VS Code's workbench sizing (ADR 0020):
// - Minimum widths: Left 170px, Right 170px, Editor 220px; Bottom min height 80px,
//   Editor min height 80px.
// - No arbitrary fixed maximum caps: a panel can grow as far as the editor has
//   room above its 220px minimum.
// - Resizing one sidebar shrinks or grows only the editor area and NEVER resizes
//   the opposite sidebar.
// - Dragging a panel below half its minimum snaps it closed (preserving its prior
//   width for when it is reopened).

/** The least width the editors keep (VS Code EditorPart minimum). */
export const CENTER_MIN = 220;
/** The least height the editors keep above the bottom panel. */
export const EDITOR_MIN_HEIGHT = 80;
/** The least height the bottom panel keeps. */
export const BOTTOM_MIN = 80;
/** The activity bar's width at 100% UI scale. */
export const ACTIVITY = 44;
/** Minimum widths of the left and right side panels (VS Code baseline). */
export const LEFT_MIN = 170;
export const RIGHT_MIN = 170;
/** Dragging below this fraction of a panel's minimum size snaps it closed. */
export const SNAP_RATIO = 0.5;

export type LayoutChrome = {
	activity?: number;
	gap?: number;
	splitter?: number;
};

/** Horizontal chrome taken by the activity bar, outer margin and visible splitters. */
export function horizontalChrome(hasLeft: boolean, hasRight: boolean, chrome?: LayoutChrome): number {
	const activity = chrome?.activity ?? ACTIVITY;
	const gap = chrome?.gap ?? 0;
	const splitter = chrome?.splitter ?? 0;
	return activity + gap + (hasLeft ? splitter : 0) + (hasRight ? splitter : 0);
}

/** Whether the window has enough width to host both side panels beside the editor. */
export function canFitBothPanels(window: number, chrome?: LayoutChrome): boolean {
	return window - horizontalChrome(true, true, chrome) >= CENTER_MIN + LEFT_MIN + RIGHT_MIN;
}

/** Fit requested side widths into the available room (window minus chrome and CENTER_MIN). */
function share(room: number, left: number, right: number): { left: number; right: number } | null {
	if (left <= 0 && right <= 0) return { left: 0, right: 0 };
	const floorRoom = Math.floor(room);
	if (left > 0 && right <= 0) {
		if (floorRoom < LEFT_MIN) return null;
		return { left: Math.max(LEFT_MIN, Math.min(Math.round(left), floorRoom)), right: 0 };
	}
	if (left <= 0 && right > 0) {
		if (floorRoom < RIGHT_MIN) return null;
		return { left: 0, right: Math.max(RIGHT_MIN, Math.min(Math.round(right), floorRoom)) };
	}
	if (floorRoom < LEFT_MIN + RIGHT_MIN) return null;
	let l = Math.max(LEFT_MIN, Math.round(left));
	let r = Math.max(RIGHT_MIN, Math.round(right));
	if (l + r <= floorRoom) return { left: l, right: r };
	// Window is narrower than left + right + CENTER_MIN: trim proportionally from each panel's slack above its minimum.
	const excess = l + r - floorRoom;
	const lSlack = l - LEFT_MIN;
	const rSlack = r - RIGHT_MIN;
	const totalSlack = lSlack + rSlack;
	const lCut = totalSlack > 0 ? Math.round((excess * lSlack) / totalSlack) : 0;
	const rCut = excess - lCut;
	l = Math.max(LEFT_MIN, l - lCut);
	r = Math.max(RIGHT_MIN, r - rCut);
	if (l + r > floorRoom) {
		const over = l + r - floorRoom;
		if (l - LEFT_MIN >= over) l -= over;
		else r -= over;
	}
	return { left: l, right: r };
}

/**
 * Side panel widths that fit the window. Saved widths are kept untouched whenever
 * both panels plus CENTER_MIN fit; the editor absorbs extra space first. Only when
 * the window is narrower than left + right + CENTER_MIN do the side panels shrink
 * proportionally toward their minimums. With room for only one of two, `prefer` stays.
 */
export function fitPanels(
	window: number,
	left: number,
	right: number,
	prefer: "left" | "right" = "left",
	chrome?: LayoutChrome,
): { left: number; right: number } {
	const room = (hasLeft: boolean, hasRight: boolean) => Math.max(0, window - horizontalChrome(hasLeft, hasRight, chrome) - CENTER_MIN);
	const both = () => share(room(left > 0, right > 0), left, right);
	const leftAlone = () => (left > 0 ? share(room(true, false), left, 0) : null);
	const rightAlone = () => (right > 0 ? share(room(false, true), 0, right) : null);
	return both() ?? (prefer === "right" ? (rightAlone() ?? leftAlone()) : (leftAlone() ?? rightAlone())) ?? { left: 0, right: 0 };
}

export type HorizontalDragResult = {
	left: number;
	right: number;
	collapsed: boolean;
};

/**
 * Sash drag math for the left or right sidebar, computed from the drag-start
 * snapshot so overshooting a limit never drifts. Expanding or shrinking one
 * sidebar trades width strictly with the editor area (down to CENTER_MIN) and
 * never resizes the opposite sidebar.
 *
 * `delta` is pointer movement along X (`currentX - startX`):
 * - For `side === "left"`: positive expands left, negative shrinks left.
 * - For `side === "right"`: negative expands right, positive shrinks right.
 */
export function dragHorizontalPanel(
	side: "left" | "right",
	startLeft: number,
	startRight: number,
	usable: number,
	delta: number,
	allowSnap = true,
): HorizontalDragResult {
	const grow = Math.round(side === "left" ? delta : -delta);
	const ownStart = Math.round(side === "left" ? startLeft : startRight);
	const ownMin = side === "left" ? LEFT_MIN : RIGHT_MIN;
	const otherStart = Math.round(side === "left" ? startRight : startLeft);
	const floorUsable = Math.floor(usable);
	const startCenter = Math.max(0, floorUsable - ownStart - otherStart);

	if (grow < 0) {
		const target = ownStart + grow;
		if (allowSnap && target < ownMin * SNAP_RATIO) {
			return { left: Math.round(startLeft), right: Math.round(startRight), collapsed: true };
		}
		const nextOwn = Math.max(ownMin, target);
		return side === "left" ? { left: nextOwn, right: otherStart, collapsed: false } : { left: otherStart, right: nextOwn, collapsed: false };
	}

	// Expanding: take space strictly from the editor down to CENTER_MIN; never alter the opposite sidebar.
	const fromCenter = Math.min(grow, Math.max(0, startCenter - CENTER_MIN));
	const nextOwn = ownStart + fromCenter;
	return side === "left" ? { left: nextOwn, right: otherStart, collapsed: false } : { left: otherStart, right: nextOwn, collapsed: false };
}

export type BottomDragResult = {
	height: number;
	collapsed: boolean;
	maximized: boolean;
};

/**
 * VS Code SplitView drag math for the bottom panel sash (`delta = currentY - startY`).
 * - Negative delta (dragging up) grows the bottom panel up to `centerHeight - splitterHeight - EDITOR_MIN_HEIGHT`;
 *   dragging past half of `EDITOR_MIN_HEIGHT` snaps the panel to fill the entire center pane (`maximized: true`).
 * - Dragging down from maximized past that threshold restores the editor cleanly;
 *   dragging below half of `BOTTOM_MIN` snaps the bottom panel closed (`collapsed: true`).
 */
export function dragBottomPanel(
	startHeight: number,
	centerHeight: number,
	splitterHeight: number,
	delta: number,
	allowSnap = true,
	wasMaximized = false,
): BottomDragResult {
	const fullHeight = Math.max(BOTTOM_MIN, Math.floor(centerHeight - splitterHeight));
	const maxNormal = Math.max(BOTTOM_MIN, Math.floor(centerHeight - splitterHeight - EDITOR_MIN_HEIGHT));
	const grow = Math.round(-delta);
	const start = wasMaximized ? fullHeight : Math.round(startHeight);
	const target = start + grow;

	if (grow < 0 && allowSnap && target < BOTTOM_MIN * SNAP_RATIO) {
		return { height: Math.round(startHeight), collapsed: true, maximized: false };
	}

	if (allowSnap) {
		const remainingEditor = fullHeight - target;
		if (remainingEditor < EDITOR_MIN_HEIGHT * SNAP_RATIO) {
			return { height: fullHeight, collapsed: false, maximized: true };
		}
		return { height: Math.max(BOTTOM_MIN, Math.min(maxNormal, target)), collapsed: false, maximized: false };
	}

	// Keyboard resizing: stepping up at maxNormal maximizes; stepping down from maximized restores to maxNormal.
	if (wasMaximized && grow < 0) {
		return { height: maxNormal, collapsed: false, maximized: false };
	}
	if (!wasMaximized && grow > 0 && start >= maxNormal) {
		return { height: fullHeight, collapsed: false, maximized: true };
	}
	return { height: Math.max(BOTTOM_MIN, Math.min(maxNormal, target)), collapsed: false, maximized: wasMaximized };
}

/**
 * The panel a side shows: the one it was showing, for as long as that is
 * docked there; else the first that is; null when none is. A side never
 * shows a panel that is docked on the other one.
 */
export const dockedView = <T extends string>(shown: T, docked: readonly T[]): T | null => (docked.includes(shown) ? shown : (docked[0] ?? null));

/**
 * The sides that are open and were given no room in the window. Each is
 * said for itself: with room for neither, both are crowded out, and
 * neither is taken for showing.
 */
export const crowdedSides = (open: { left: boolean; right: boolean }, fit: { left: number; right: number }): { left: boolean; right: boolean } => ({ left: open.left && !fit.left, right: open.right && !fit.right });
