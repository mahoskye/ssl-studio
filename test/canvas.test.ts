import { describe, expect, test } from "bun:test";
import { canvasMeasure, estimateWidth, fitView, legibleScale, LEGIBLE_PX, nearest, recall, remember, reveal, zoomAt } from "../src/view/graph/canvas";

describe("fit", () => {
	const floor = legibleScale(13);
	test("the floor keeps 13px words at about 11px, and never enlarges", () => {
		expect(13 * floor).toBeCloseTo(LEGIBLE_PX);
		expect(legibleScale(10)).toBe(1);
	});
	test("a small chart is shown at full size, centred across, from the top", () => {
		expect(fitView({ width: 300, height: 200 }, { width: 900, height: 600 }, { floor })).toEqual({ x: 300, y: 20, scale: 1 });
	});
	test("a chart a little too large is shrunk to fit whole", () => {
		const v = fitView({ width: 1000, height: 400 }, { width: 900, height: 600 }, { floor });
		expect(v.scale).toBeCloseTo(0.86);
		expect(v.x).toBeCloseTo(20);
		expect(1000 * v.scale + 2 * 20).toBeLessThanOrEqual(900 + 1e-9);
	});
	test("a tall chart is not shrunk past legible: it starts at the top and is panned", () => {
		// The demo plan's 14 nodes: fitting it whole would draw its words at 5px.
		const chart = { width: 617, height: 1360 };
		const box = { width: 900, height: 600 };
		const v = fitView(chart, box, { floor });
		expect((box.height - 40) / chart.height).toBeLessThan(0.45);
		expect(v.scale).toBe(floor);
		expect(13 * v.scale).toBeGreaterThanOrEqual(LEGIBLE_PX - 1e-9);
		expect(v.y).toBe(20);
		expect(v.x).toBeCloseTo((900 - 617 * floor) / 2);
	});
	test("an anchor is kept in sight, without showing space past the chart's end", () => {
		const chart = { width: 600, height: 2000 };
		const box = { width: 900, height: 600 };
		const middle = fitView(chart, box, { floor: 1, anchor: { x: 300, y: 1000 } });
		expect(middle.y).toBe(300 - 1000);
		const end = fitView(chart, box, { floor: 1, anchor: { x: 300, y: 1990 } });
		expect(end.y).toBe(600 - 20 - 2000);
		const start = fitView(chart, box, { floor: 1, anchor: { x: 300, y: 10 } });
		expect(start.y).toBe(20);
	});
	test("a view with no size yet does not divide by nothing", () => {
		const v = fitView({ width: 0, height: 0 }, { width: 0, height: 0 }, { floor });
		expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
		expect(v.scale).toBe(floor);
	});
});

describe("zoom", () => {
	const under = (v: { x: number; y: number; scale: number }, p: { x: number; y: number }) => ({ x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale });
	test("what is under the pointer stays under it", () => {
		const before = { x: 20, y: 35, scale: 0.8 };
		const pointer = { x: 412, y: 268 };
		const after = zoomAt(before, pointer, 1.1, 0.2, 2.5);
		expect(after.scale).toBeCloseTo(0.88);
		expect(under(after, pointer).x).toBeCloseTo(under(before, pointer).x);
		expect(under(after, pointer).y).toBeCloseTo(under(before, pointer).y);
	});
	test("at its limit the view does not creep", () => {
		const at = { x: 20, y: 35, scale: 2.5 };
		expect(zoomAt(at, { x: 400, y: 300 }, 1.1, 0.2, 2.5)).toEqual(at);
		expect(zoomAt({ ...at, scale: 0.2 }, { x: 400, y: 300 }, 0.9, 0.2, 2.5).scale).toBe(0.2);
	});
	test("a reset to 100% is a zoom by the inverse", () => {
		expect(zoomAt({ x: 0, y: 0, scale: 0.4 }, { x: 0, y: 0 }, 1 / 0.4, 0.15, 3).scale).toBeCloseTo(1);
	});
});

describe("reveal", () => {
	const box = { width: 800, height: 600 };
	test("leaves a view alone when the rectangle is in sight", () => {
		const v = { x: 0, y: 0, scale: 1 };
		expect(reveal(v, { x: 100, y: 100, width: 190, height: 40 }, box)).toBe(v);
	});
	test("pans as little as it takes", () => {
		expect(reveal({ x: 0, y: 0, scale: 1 }, { x: 100, y: 700, width: 190, height: 40 }, box)).toEqual({ x: 0, y: 600 - 24 - 740, scale: 1 });
		expect(reveal({ x: -500, y: 0, scale: 1 }, { x: 100, y: 100, width: 190, height: 40 }, box)).toEqual({ x: 24 - 100, y: 0, scale: 1 });
	});
	test("counts the zoom", () => {
		expect(reveal({ x: 0, y: 0, scale: 2 }, { x: 100, y: 350, width: 100, height: 40 }, box).y).toBe(600 - 24 - 780);
	});
	test("a rectangle larger than the view shows its start", () => {
		expect(reveal({ x: 0, y: 0, scale: 1 }, { x: 50, y: 0, width: 2000, height: 40 }, box).x).toBe(24 - 50);
	});
});

describe("the arrow keys", () => {
	const at = (id: string, x: number, y: number) => ({ id, x, y, width: 100, height: 40 });
	const here = at("here", 200, 200);
	test("one straight ahead beats a nearer one off to the side", () => {
		const ahead = at("ahead", 200, 400);
		const aside = at("aside", 330, 300);
		expect(nearest([here, ahead, aside], here, 0, 1)?.id).toBe("ahead");
		expect(nearest([here, ahead, aside], here, 1, 0)?.id).toBe("aside");
	});
	test("nothing that way is no move", () => {
		expect(nearest([here, at("below", 200, 400)], here, 0, -1)).toBeUndefined();
		expect(nearest([here], here, 1, 0)).toBeUndefined();
	});
});

describe("the width of text", () => {
	test("an estimate knows wide letters from narrow, and grows with the type", () => {
		expect(estimateWidth("WWWW", 13)).toBeGreaterThan(estimateWidth("illi", 13) * 2);
		expect(estimateWidth("Release", 26)).toBeCloseTo(estimateWidth("Release", 13) * 2);
		expect(estimateWidth("", 13)).toBe(0);
	});
	test("an estimate errs on the wide side of a common face", () => {
		// 13px system sans runs to about 6.3px a letter in ordinary words.
		const text = "Read the samples that have no due date";
		expect(estimateWidth(text, 13)).toBeGreaterThan(text.length * 6.3);
		expect(estimateWidth(text, 13)).toBeLessThan(text.length * 8);
	});
	test("with no canvas to measure with, the estimate is used", () => {
		const measure = canvasMeasure("13px system-ui, sans-serif", 13);
		expect(measure("Check the id")).toBe(estimateWidth("Check the id", 13));
		expect(measure("")).toBe(0);
	});
});

test("a choice is remembered where there is storage, and does no harm where there is none", () => {
	expect(() => remember("test.choice", "open")).not.toThrow();
	expect([null, "open"]).toContain(recall("test.choice"));
	expect(recall("test.never-set")).toBeNull();
});

import { roundedPath, splinePath } from "../src/view/graph/canvas";

describe("lines as they are drawn", () => {
	test("a corner is rounded, by no more than half of its shorter stretch", () => {
		expect(roundedPath([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }], 8)).toBe("M0,0 L32,0 Q40,0 40,8 L40,40");
		// A stretch of 6 leaves room for a corner of 3.
		expect(roundedPath([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 6 }], 8)).toBe("M0,0 L37,0 Q40,0 40,3 L40,6");
	});

	test("a straight line, and no line, are left as they are", () => {
		expect(roundedPath([{ x: 0, y: 0 }, { x: 10, y: 20 }])).toBe("M0,0 L10,20");
		expect(roundedPath([{ x: 5, y: 5 }])).toBe("");
		// Two points on the same spot leave no room for a corner.
		expect(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 9, y: 0 }])).toBe("M0,0 L0,0 L9,0");
	});

	test("a spline's control points come in threes after its start", () => {
		const p = (x: number, y: number) => ({ x, y });
		expect(splinePath([p(0, 0), p(10, 0), p(20, 10), p(30, 10)])).toBe("M0,0 C10,0 20,10 30,10");
		expect(splinePath([p(0, 0), p(1, 1), p(2, 2), p(3, 3), p(4, 4), p(5, 5), p(6, 6)])).toBe("M0,0 C1,1 2,2 3,3 C4,4 5,5 6,6");
		// What does not come in threes is joined straight.
		expect(splinePath([p(0, 0), p(9, 9)])).toBe("M0,0 L9,9");
		expect(splinePath([p(0, 0), p(1, 1), p(2, 2), p(3, 3), p(4, 4)])).toBe("M0,0 C1,1 2,2 3,3 L4,4");
	});
});

import { splinePoint } from "../src/view/graph/canvas";

test("a point a given length along a spline, and its end when it is shorter", () => {
	const p = (x: number, y: number) => ({ x, y });
	// Handles on the line itself: the curve is the straight line from 0 to 30.
	const straight = [p(0, 0), p(10, 0), p(20, 0), p(30, 0)];
	expect(splinePoint(straight, 12).x).toBeCloseTo(12, 5);
	expect(splinePoint(straight, 12).y).toBeCloseTo(0, 5);
	expect(splinePoint(straight, 99)).toEqual(p(30, 0));
	expect(splinePoint([p(0, 0), p(0, 40)], 10)).toEqual(p(0, 10));
	expect(splinePoint([], 10)).toEqual(p(0, 0));
	// A curve: the point is on it, the asked length from the start as the curve runs.
	const curve = [p(0, 0), p(40, 0), p(40, 40), p(80, 40)];
	const at = splinePoint(curve, 30, 64);
	expect(at.x).toBeGreaterThan(20);
	expect(at.y).toBeGreaterThan(0);
	expect(at.y).toBeLessThan(20);
});

import { centredOn, mapScale, outOfSight, seen } from "../src/view/graph/canvas";

describe("the map of a picture larger than its view", () => {
	const box = { width: 400, height: 300 };
	test("the part in view is the view turned inside out", () => {
		expect(seen({ x: 20, y: 20, scale: 1 }, box)).toEqual({ x: -20, y: -20, width: 400, height: 300 });
		expect(seen({ x: -200, y: -100, scale: 0.5 }, box)).toEqual({ x: 400, y: 200, width: 800, height: 600 });
	});
	test("a point is brought to the middle at the scale the view has", () => {
		const view = centredOn({ x: 0, y: 0, scale: 0.5 }, { x: 1000, y: 800 }, box);
		expect(view).toEqual({ x: -300, y: -250, scale: 0.5 });
		const part = seen(view, box);
		expect([part.x + part.width / 2, part.y + part.height / 2]).toEqual([1000, 800]);
	});
	test("a map is worth its room only while some of the picture is out of sight", () => {
		const content = { width: 300, height: 200 };
		expect(outOfSight(content, { x: 20, y: 20, scale: 1 }, box)).toBe(false);
		expect(outOfSight(content, { x: -50, y: 20, scale: 1 }, box)).toBe(true);
		expect(outOfSight({ width: 900, height: 200 }, { x: 20, y: 20, scale: 1 }, box)).toBe(true);
		expect(outOfSight(content, { x: 20, y: 20, scale: 2 }, box)).toBe(true);
	});
	test("the map's scale fits the picture into its largest size", () => {
		expect(mapScale({ width: 2000, height: 700 }, { width: 200, height: 140 })).toBe(0.1);
		expect(mapScale({ width: 400, height: 1400 }, { width: 200, height: 140 })).toBe(0.1);
		expect(mapScale({ width: 0, height: 0 }, { width: 200, height: 140 })).toBe(140);
	});
});

import { fitShare } from "../src/view/graph/canvas";

test("how much of a picture a fitted view shows", () => {
	const box = { width: 1040, height: 540 };
	expect(fitShare({ width: 500, height: 300 }, box)).toBe(1);
	expect(fitShare({ width: 2000, height: 300 }, box)).toBe(0.5);
	expect(fitShare({ width: 500, height: 1000 }, box)).toBe(0.5);
	// Wide and short against narrower and taller: the second shows more of itself.
	expect(fitShare({ width: 1100, height: 700 }, box)).toBeGreaterThan(fitShare({ width: 1900, height: 560 }, box));
	expect(fitShare({ width: 0, height: 0 }, box)).toBe(1);
});

import { pictureName } from "../src/view/graph/canvas";

test("a picture's file is named for what it is of", () => {
	expect(pictureName("Set sample due dates")).toBe("Set-sample-due-dates.svg");
	expect(pictureName("  Due dates: step 2/3  ")).toBe("Due-dates-step-2-3.svg");
	expect(pictureName("???")).toBe("picture.svg");
	expect(pictureName("")).toBe("picture.svg");
});

import { clearOf, mapArea, MAP_INSET } from "../src/view/graph/canvas";

describe("keeping something clear of the map", () => {
	const box = { width: 1000, height: 600 };
	test("the map sits in the bottom right corner, at the size it is drawn", () => {
		// 2000 by 700 fits 200 by 140 at one tenth.
		expect(mapArea({ width: 2000, height: 700 }, box)).toEqual({ x: 1000 - MAP_INSET - 200, y: 600 - MAP_INSET - 70, width: 200, height: 70 });
	});
	const avoid = { x: 800, y: 500, width: 192, height: 92 };
	const view = { x: 0, y: 0, scale: 1 };
	test("what is not under it is left where it is", () => {
		expect(clearOf(view, { x: 100, y: 100, width: 150, height: 40 }, avoid)).toBe(view);
		expect(clearOf(view, { x: 600, y: 520, width: 150, height: 40 }, avoid)).toBe(view);
	});
	test("what is under it is moved up, just clear", () => {
		const moved = clearOf(view, { x: 820, y: 520, width: 150, height: 40 }, avoid);
		expect(moved).toEqual({ x: 0, y: -(560 - 500 + 12), scale: 1 });
		// Its bottom is now the margin above the map.
		expect(520 + 40 + moved.y).toBe(500 - 12);
	});
	test("when up would put its top out of sight it goes left, and failing that stays", () => {
		const low = { x: 0, y: 0, width: 1000, height: 60 };
		// The view is only as tall as the map's top allows: a tall node cannot go up.
		const tall = { x: 820, y: 10, width: 150, height: 560 };
		expect(clearOf(view, tall, avoid)).toEqual({ x: -(970 - 800 + 12), y: 0, scale: 1 });
		expect(clearOf(view, { x: 0, y: 10, width: 990, height: 560 }, avoid)).toBe(view);
		expect(low.width).toBe(1000);
	});
});

import { clearLabels } from "../src/view/graph/canvas";

describe("names over a picture seen from far off", () => {
	const label = (item: string, x: number, y: number, weight: number, width = 100, height = 20) => ({ item, x, y, width, height, weight });

	test("names that are clear of each other are all shown", () => {
		expect(clearLabels([label("a", 0, 0, 1), label("b", 200, 0, 1), label("c", 0, 50, 1)]).map((l) => l.item)).toEqual(["a", "b", "c"]);
	});

	test("of two that would lie over each other, the weightier is shown", () => {
		expect(clearLabels([label("small", 50, 5, 1), label("large", 0, 0, 9)]).map((l) => l.item)).toEqual(["large"]);
	});

	test("a name that only the hidden one was in the way of is shown", () => {
		// b overlaps a and c; a and c are clear of each other.
		expect(clearLabels([label("a", 0, 0, 3), label("b", 90, 0, 1), label("c", 180, 0, 2)]).map((l) => l.item).sort()).toEqual(["a", "c"]);
	});

	test("the gap asked for is kept between names", () => {
		const pair = [label("a", 0, 0, 2), label("b", 104, 0, 1)];
		expect(clearLabels(pair).length).toBe(2);
		expect(clearLabels(pair, 8).map((l) => l.item)).toEqual(["a"]);
	});

	test("equals keep the order they were given in", () => {
		expect(clearLabels([label("first", 0, 0, 1), label("second", 10, 0, 1)]).map((l) => l.item)).toEqual(["first"]);
	});
});

