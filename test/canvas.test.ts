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
