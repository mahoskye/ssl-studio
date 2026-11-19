// Where the cursor has been, so that "back" and "forward" can go there
// again: a file opened, a definition jumped to, a search result followed.
// A place is kept when the cursor lands in another file or far from where it
// was; moving about within a few lines only moves the place it is at. No DOM
// and no app state.

export type Place = { path: string; line: number; column: number };

/** The places in the order they were visited, and which one the cursor is at now (-1 with none). */
export type Trail = { readonly places: readonly Place[]; readonly at: number };

export const NO_TRAIL: Trail = { places: [], at: -1 };

/** As many places as are kept: the oldest are let go. */
export const TRAIL_LENGTH = 50;
/** Fewer lines than this from the last place is still the same place. */
export const FAR = 10;

const near = (a: Place, b: Place, far: number) => a.path === b.path && Math.abs(a.line - b.line) < far;

/**
 * The trail after the cursor came to rest at `place`. Near the place it is
 * at, that place moves with it. Anywhere else is a new place after it, and
 * what lay ahead (places gone back from) is dropped: the way forward is now
 * this one.
 */
export function visited(trail: Trail, place: Place, far = FAR): Trail {
	const here = trail.places[trail.at];
	if (here && near(here, place, far)) {
		if (here.line === place.line && here.column === place.column) return trail;
		return { places: trail.places.map((each, index) => (index === trail.at ? place : each)), at: trail.at };
	}
	const places = [...trail.places.slice(0, trail.at + 1), place].slice(-TRAIL_LENGTH);
	return { places, at: places.length - 1 };
}

export const canGoBack = (trail: Trail) => trail.at > 0;
export const canGoForward = (trail: Trail) => trail.at >= 0 && trail.at < trail.places.length - 1;

/** One place back or forward: the trail there and the place to show, or null at either end. */
export function stepTrail(trail: Trail, by: 1 | -1): { trail: Trail; place: Place } | null {
	const place = trail.places[trail.at + by];
	return place && trail.at >= 0 ? { trail: { places: trail.places, at: trail.at + by }, place } : null;
}

/** The trail without two neighbours that are the same place: left behind when a place between them goes. */
function settled(places: Place[], at: number): Trail {
	const out: Place[] = [];
	let now = -1;
	places.forEach((place, index) => {
		const last = out[out.length - 1];
		if (!last || last.path !== place.path || last.line !== place.line) out.push(place);
		if (index <= at) now = out.length - 1;
	});
	return { places: out, at: now };
}

/** The trail after a file or folder was renamed: its places are in the file under its new name. */
export function trailRenamed(trail: Trail, rename: (path: string) => string): Trail {
	return { places: trail.places.map((place) => ({ ...place, path: rename(place.path) })), at: trail.at };
}

/** The trail without the places in files that are gone. The cursor stays at the last place before those it lost. */
export function trailWithout(trail: Trail, gone: (path: string) => boolean): Trail {
	let at = -1;
	const kept: Place[] = [];
	trail.places.forEach((place, index) => {
		if (gone(place.path)) return;
		kept.push(place);
		if (index <= trail.at) at = kept.length - 1;
	});
	// With nothing kept before it, the first of what is left is where it is.
	return settled(kept, kept.length && at < 0 ? 0 : at);
}
