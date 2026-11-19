// The window's own small rules: what a tab says, how the width is shared,
// where a link to a heading goes, and how a menu steps through its items.
import { describe, expect, test } from "bun:test";
import { headingAnchor } from "../src/shared/docTables";
import { tabLabels } from "../src/view/editor/tabs";
import { fitPanels } from "../src/view/layout";
import { DEFAULT_SETTINGS, defaultLayout } from "../src/shared/protocol";

describe("tab labels", () => {
	const root = "/work/due-dates";

	test("a name that is open once is shown as it is", () => {
		expect([...tabLabels([`${root}/src/A.ssl`, `${root}/README.md`], root).values()]).toEqual(["A.ssl", "README.md"]);
	});

	test("the same name twice says which folder each is in", () => {
		const labels = tabLabels([`${root}/README.md`, `${root}/docs/README.md`, `${root}/schema/README.md`], root);
		expect([...labels.values()]).toEqual(["README.md · due-dates", "README.md · docs", "README.md · schema"]);
	});

	test("a deep folder shows its last two parts", () => {
		const labels = tabLabels([`${root}/a/b/c/X.ssl`, `${root}/d/X.ssl`], root);
		expect(labels.get(`${root}/a/b/c/X.ssl`)).toBe("X.ssl · b/c");
	});
});

describe("side panels fit the window", () => {
	const editors = (window: number, fit: { left: number; right: number }) => window - 44 - fit.left - fit.right;

	test("a wide window gives both what they asked for", () => {
		expect(fitPanels(1600, 260, 360)).toEqual({ left: 260, right: 360 });
	});

	test("the editors keep their room before the right panel does", () => {
		// 1100 - 44 (activity bar) - 480 (editors) leaves 576: 260 for the left, 316 for the right.
		expect(fitPanels(1100, 260, 360)).toEqual({ left: 260, right: 316 });
	});

	test("a smaller window takes room from the editors, down to their least, before a panel gets too narrow", () => {
		// At 900 the wanted 480 would leave the right panel 116. With the editors at 360 it gets 236.
		expect(fitPanels(900, 260, 360)).toEqual({ left: 260, right: 236 });
		expect(editors(900, fitPanels(900, 260, 360))).toBe(360);
	});

	test("then the left panel gives way to the right", () => {
		expect(fitPanels(800, 260, 360)).toEqual({ left: 176, right: 220 });
	});

	test("a panel that would be too narrow to use is not shown", () => {
		expect(fitPanels(700, 260, 360)).toEqual({ left: 260, right: 0 });
		expect(fitPanels(500, 0, 360)).toEqual({ left: 0, right: 0 });
		expect(fitPanels(380, 700, 800)).toEqual({ left: 0, right: 0 });
	});

	test("with room for one of two, the panel asked for last is the one shown", () => {
		expect(fitPanels(700, 260, 360, "right")).toEqual({ left: 0, right: 296 });
		expect(fitPanels(700, 260, 360, "left")).toEqual({ left: 260, right: 0 });
		// With room for both, the preference changes nothing.
		expect(fitPanels(1100, 260, 360, "right")).toEqual(fitPanels(1100, 260, 360, "left"));
		// The preferred one cannot fit at all: the other still may.
		expect(fitPanels(610, 180, 800, "right")).toEqual({ left: 180, right: 0 });
	});

	test("a panel is never narrower than it can be used at, and the editors never below their least", () => {
		for (let window = 300; window <= 2000; window += 37) {
			const fit = fitPanels(window, 700, 800);
			expect(fit.left === 0 || fit.left >= 160).toBe(true);
			expect(fit.right === 0 || fit.right >= 220).toBe(true);
			if (fit.left || fit.right) expect(editors(window, fit)).toBeGreaterThanOrEqual(360);
		}
	});
});

describe("heading anchors", () => {
	test("as a link to a heading is written", () => {
		expect(headingAnchor("What is here")).toBe("what-is-here");
		expect(headingAnchor("S-1002: an outage and a weekend")).toBe("s-1002-an-outage-and-a-weekend");
		expect(headingAnchor("  How it's enforced, and why  ")).toBe("how-its-enforced-and-why");
	});
});

describe("the layout a folder first opens with", () => {
	test("is what the default settings hold", () => {
		expect(defaultLayout()).toEqual(DEFAULT_SETTINGS.layout);
	});

	test("is made anew each time: changing one that was handed out does not change the next", () => {
		const first = defaultLayout();
		first.right = true;
		first.leftWidth = 500;
		expect(defaultLayout()).toEqual({ left: true, right: false, bottom: true, leftWidth: 260, rightWidth: 360, bottomHeight: 200 });
		expect(defaultLayout()).not.toBe(defaultLayout());
	});
});
