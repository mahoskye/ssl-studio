import { describe, expect, test } from "bun:test";
import { canGoBack, canGoForward, NO_TRAIL, stepTrail, TRAIL_LENGTH, trailRenamed, trailWithout, visited, type Place, type Trail } from "../src/shared/navHistory";

const at = (path: string, line: number, column = 1): Place => ({ path, line, column });
const walk = (...places: Place[]): Trail => places.reduce((trail, place) => visited(trail, place), NO_TRAIL);

describe("the places the cursor has been", () => {
	test("the first place is where it is", () => {
		expect(walk(at("a", 1))).toEqual({ places: [at("a", 1)], at: 0 });
	});

	test("a few lines away is the same place, moved", () => {
		expect(walk(at("a", 1), at("a", 5, 3))).toEqual({ places: [at("a", 5, 3)], at: 0 });
	});

	test("staying where it is changes nothing", () => {
		const trail = walk(at("a", 1));
		expect(visited(trail, at("a", 1))).toBe(trail);
	});

	test("far away in the same file is another place", () => {
		expect(walk(at("a", 1), at("a", 40)).places).toEqual([at("a", 1), at("a", 40)]);
	});

	test("another file is another place, however near the line", () => {
		expect(walk(at("a", 1), at("b", 2)).places).toEqual([at("a", 1), at("b", 2)]);
	});

	test("small steps do not add up to a place: each is measured from where the place now is", () => {
		// 1 → 8 → 15 → 22: no step is far, so there is still one place, and it is the last line.
		expect(walk(at("a", 1), at("a", 8), at("a", 15), at("a", 22)).places).toEqual([at("a", 22)]);
	});

	test("only so many are kept, the newest", () => {
		let trail = NO_TRAIL;
		for (let i = 0; i < TRAIL_LENGTH + 5; i++) trail = visited(trail, at(`f${i}`, 1));
		expect(trail.places.length).toBe(TRAIL_LENGTH);
		expect(trail.places[0]).toEqual(at("f5", 1));
		expect(trail.at).toBe(TRAIL_LENGTH - 1);
	});
});

describe("back and forward", () => {
	const trail = walk(at("a", 1), at("b", 1), at("c", 1));

	test("back goes to the place before, and forward returns", () => {
		const back = stepTrail(trail, -1)!;
		expect(back.place).toEqual(at("b", 1));
		expect(stepTrail(back.trail, 1)!.place).toEqual(at("c", 1));
	});

	test("there is no back from the first place and no forward from the last", () => {
		expect(stepTrail(trail, 1)).toBeNull();
		expect(stepTrail(walk(at("a", 1)), -1)).toBeNull();
		expect(stepTrail(NO_TRAIL, -1)).toBeNull();
		expect(stepTrail(NO_TRAIL, 1)).toBeNull();
		expect(canGoBack(NO_TRAIL)).toBe(false);
		expect(canGoForward(NO_TRAIL)).toBe(false);
		expect(canGoBack(trail)).toBe(true);
		expect(canGoForward(trail)).toBe(false);
		expect(canGoForward(stepTrail(trail, -1)!.trail)).toBe(true);
	});

	test("arriving where back led is not a new place", () => {
		const back = stepTrail(trail, -1)!;
		expect(visited(back.trail, back.place)).toBe(back.trail);
	});

	test("going somewhere new after going back drops the way forward", () => {
		const back = stepTrail(stepTrail(trail, -1)!.trail, -1)!;
		const next = visited(back.trail, at("d", 1));
		expect(next).toEqual({ places: [at("a", 1), at("d", 1)], at: 1 });
	});

	test("moving a little after going back keeps the way forward", () => {
		const back = stepTrail(trail, -1)!;
		const moved = visited(back.trail, at("b", 3));
		expect(moved.places).toEqual([at("a", 1), at("b", 3), at("c", 1)]);
		expect(canGoForward(moved)).toBe(true);
	});
});

describe("when files change under the trail", () => {
	const trail = stepTrail(walk(at("a", 1), at("b", 1), at("a", 50), at("c", 1)), -1)!.trail;

	test("a renamed file's places go with it", () => {
		const renamed = trailRenamed(trail, (path) => (path === "a" ? "z" : path));
		expect(renamed.places.map((place) => place.path)).toEqual(["z", "b", "z", "c"]);
		expect(renamed.at).toBe(trail.at);
	});

	test("a removed file's places go, and the cursor stays at what is left before it", () => {
		const without = trailWithout(trail, (path) => path === "a");
		expect(without.places).toEqual([at("b", 1), at("c", 1)]);
		expect(without.at).toBe(0);
	});

	test("neighbours left the same place by a removal are one place", () => {
		const twice = walk(at("a", 1), at("b", 1), at("a", 1));
		expect(trailWithout(twice, (path) => path === "b")).toEqual({ places: [at("a", 1)], at: 0 });
	});

	test("with every place gone there is no trail", () => {
		expect(trailWithout(trail, () => true)).toEqual({ places: [], at: -1 });
	});

	test("with only later places left, the cursor is at the first of them", () => {
		const early = stepTrail(stepTrail(walk(at("a", 1), at("b", 1), at("c", 1)), -1)!.trail, -1)!.trail;
		expect(trailWithout(early, (path) => path === "a")).toEqual({ places: [at("b", 1), at("c", 1)], at: 0 });
	});

	test("panel and screen view switches are distinct stops on the same file", () => {
		const onPalette: Place = { path: "a", line: 1, column: 1, view: "editors|palette:assistant" };
		const onAgent: Place = { path: "a", line: 1, column: 1, view: "editors|agent" };
		const onWelcome: Place = { path: "", line: 1, column: 1, view: "welcome|" };
		const t = walk(onPalette, onAgent, onWelcome);
		expect(t.places).toEqual([onPalette, onAgent, onWelcome]);
		const back1 = stepTrail(t, -1)!;
		expect(back1.place).toEqual(onAgent);
		const back2 = stepTrail(back1.trail, -1)!;
		expect(back2.place).toEqual(onPalette);
		// File removal does not drop screen-only stops with empty path.
		expect(trailWithout(t, (p) => p === "a").places).toEqual([onWelcome]);
	});
});
