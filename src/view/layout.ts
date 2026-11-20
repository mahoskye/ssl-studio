// How the window's width is shared out: pure, so it can be tested.

/** The room the editors get when the window has it to give. */
export const CENTER_WANTED = 480;
/** The least room the editors keep, whatever the side panels ask for. */
export const CENTER_MIN = 360;
/** The activity bar's width. */
export const ACTIVITY = 44;
/** Narrower than this, a side panel cannot be used. */
export const LEFT_MIN = 160;
export const RIGHT_MIN = 220;

/** One try at a given width for the editors: null when a panel would be too narrow to use. */
function share(room: number, left: number, right: number): { left: number; right: number } | null {
	let l = Math.min(left, room);
	let r = Math.min(right, Math.max(0, room - l));
	if (right > 0 && r < RIGHT_MIN) {
		// The left panel gives what it can spare.
		const give = Math.min(RIGHT_MIN - r, Math.max(0, l - LEFT_MIN));
		l -= give;
		r += give;
	}
	return (left > 0 && l < LEFT_MIN) || (right > 0 && r < RIGHT_MIN) ? null : { left: l, right: r };
}

/**
 * Side panel widths that fit the window. The saved widths are what the user
 * chose and are not changed. A window too small for them gives the editors
 * their room first; the panels shrink, the left one giving way to the right,
 * and a panel that would be too narrow to use is not shown at all. With room
 * for only one of two, `prefer` stays: the one the user asked for last.
 */
export function fitPanels(window: number, left: number, right: number, prefer: "left" | "right" = "left"): { left: number; right: number } {
	const room = (center: number) => Math.max(0, window - ACTIVITY - center);
	const leftAlone = () => share(room(CENTER_MIN), left, 0);
	const rightAlone = () => share(room(CENTER_MIN), 0, right);
	return (
		share(room(CENTER_WANTED), left, right) ??
		share(room(CENTER_MIN), left, right) ??
		// Not both: the preferred panel alone, then the other alone, then neither.
		(prefer === "right" ? (rightAlone() ?? leftAlone()) : (leftAlone() ?? rightAlone())) ?? { left: 0, right: 0 }
	);
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
