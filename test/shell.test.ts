// The window's own small rules: what a tab says, how the width is shared,
// where a link to a heading goes, and how a menu steps through its items.
import { describe, expect, test } from "bun:test";
import { headingAnchor } from "../src/shared/docTables";
import { tabLabels } from "../src/view/editor/tabs";
import { BOTTOM_MIN, canFitBothPanels, CENTER_MIN, crowdedSides, dockedView, dragBottomPanel, dragHorizontalPanel, fitPanels, LEFT_MIN, RIGHT_MIN } from "../src/view/layout";
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

	test("floating untitled buffers display their bare name without a path prefix", () => {
		const labels = tabLabels(["untitled:Untitled-1", `${root}/src/A.ssl`, "untitled:Untitled-2"], root);
		expect(labels.get("untitled:Untitled-1")).toBe("Untitled-1");
		expect(labels.get("untitled:Untitled-2")).toBe("Untitled-2");
		expect(labels.get(`${root}/src/A.ssl`)).toBe("A.ssl");
	});
});

describe("side panels fit the window (VS Code SplitView baseline)", () => {
	const editors = (window: number, fit: { left: number; right: number }) => window - 44 - fit.left - fit.right;

	test("both panels keep their requested widths whenever the editor has at least 220px", () => {
		expect(fitPanels(1600, 260, 360)).toEqual({ left: 260, right: 360 });
		// At 1024px (44 activity + 260 left + 360 right = 664 -> 360px editor >= 220): neither sidebar shrinks.
		expect(fitPanels(1024, 260, 360)).toEqual({ left: 260, right: 360 });
		// Even at 900px (260 + 360 = 620 -> 236px editor >= 220): both keep full width.
		expect(fitPanels(900, 260, 360)).toEqual({ left: 260, right: 360 });
	});

	test("expanding one sidebar does not affect the other while the editor stays >= 220px", () => {
		// At 1280px (usable 1236, room for sidebars 1016): expanding left from 260 to 656 leaves right untouched at 360.
		expect(fitPanels(1280, 500, 360)).toEqual({ left: 500, right: 360 });
		expect(fitPanels(1280, 656, 360)).toEqual({ left: 656, right: 360 });
		// Symmetrically, expanding right leaves left untouched at 260.
		expect(fitPanels(1280, 260, 756)).toEqual({ left: 260, right: 756 });
	});

	test("no arbitrary 700/800px cap: a single sidebar can grow up to window - chrome - 220px", () => {
		expect(fitPanels(1920, 1200, 0)).toEqual({ left: 1200, right: 0 });
		expect(fitPanels(1920, 0, 1400)).toEqual({ left: 0, right: 1400 });
		expect(fitPanels(1920, 2000, 0)).toEqual({ left: 1920 - 44 - CENTER_MIN, right: 0 });
	});

	test("a narrower window trims both sidebars proportionally toward 170px while keeping editor at 220px", () => {
		// At 800px: room = 800 - 44 - 220 = 536. Requested 260 + 360 = 620 (excess 84).
		const fit = fitPanels(800, 260, 360);
		expect(fit.left + fit.right).toBe(536);
		expect(editors(800, fit)).toBe(CENTER_MIN);
		expect(fit.left).toBeGreaterThanOrEqual(LEFT_MIN);
		expect(fit.right).toBeGreaterThanOrEqual(RIGHT_MIN);
		// Right had more slack above 170 (190 vs 90), so it gave slightly more than left.
		expect(fit.left).toBeLessThan(260);
		expect(fit.right).toBeLessThan(360);
	});

	test("a panel that would be too narrow to use is not shown", () => {
		// At 600px: room = 600 - 44 - 220 = 336 < 170 + 170 (340), so only one panel fits.
		expect(canFitBothPanels(600)).toBe(false);
		expect(fitPanels(600, 260, 360)).toEqual({ left: 260, right: 0 });
		expect(fitPanels(400, 0, 360)).toEqual({ left: 0, right: 0 });
		expect(fitPanels(380, 700, 800)).toEqual({ left: 0, right: 0 });
	});

	test("with room for one of two, the panel asked for last is the one shown", () => {
		expect(fitPanels(600, 260, 360, "right")).toEqual({ left: 0, right: 336 });
		expect(fitPanels(600, 260, 360, "left")).toEqual({ left: 260, right: 0 });
		// With room for both, the preference changes nothing.
		expect(fitPanels(1100, 260, 360, "right")).toEqual(fitPanels(1100, 260, 360, "left"));
	});

	test("a panel is never narrower than 170px, and the editors never below 220px", () => {
		for (let window = 300; window <= 2400; window += 37) {
			const fit = fitPanels(window, 1100, 900);
			expect(fit.left === 0 || fit.left >= LEFT_MIN).toBe(true);
			expect(fit.right === 0 || fit.right >= RIGHT_MIN).toBe(true);
			if (fit.left || fit.right) expect(editors(window, fit)).toBeGreaterThanOrEqual(CENTER_MIN);
		}
	});
});

describe("sash dragging (VS Code SplitView)", () => {
	test("expanding left shrinks only the editor and leaves right untouched down to 220px", () => {
		// usable 1200: left 260, center 580, right 360 -> 360px of editor slack above 220.
		expect(dragHorizontalPanel("left", 260, 360, 1200, 200)).toEqual({ left: 460, right: 360, collapsed: false });
		expect(dragHorizontalPanel("left", 260, 360, 1200, 360)).toEqual({ left: 620, right: 360, collapsed: false });
	});

	test("expanding right shrinks only the editor and leaves left untouched down to 220px", () => {
		// Negative delta drags right sash left (expands right).
		expect(dragHorizontalPanel("right", 260, 360, 1200, -200)).toEqual({ left: 260, right: 560, collapsed: false });
		expect(dragHorizontalPanel("right", 260, 360, 1200, -360)).toEqual({ left: 260, right: 720, collapsed: false });
	});

	test("dragging past editor 220px stops at editor 220px and never affects the opposite sidebar", () => {
		// usable 1200: left 260, center 580, right 360 -> 360px editor slack -> left stops at 620, right stays 360.
		expect(dragHorizontalPanel("left", 260, 360, 1200, 460)).toEqual({ left: 620, right: 360, collapsed: false });
		expect(dragHorizontalPanel("left", 260, 360, 1200, 999)).toEqual({ left: 620, right: 360, collapsed: false });
		// Reversing from overshoot does not drift and still leaves right at 360.
		expect(dragHorizontalPanel("left", 260, 360, 1200, 300)).toEqual({ left: 560, right: 360, collapsed: false });
		// Symmetrically for right sash: right stops at 720, left stays 260.
		expect(dragHorizontalPanel("right", 260, 360, 1200, -450)).toEqual({ left: 260, right: 720, collapsed: false });
		expect(dragHorizontalPanel("right", 260, 360, 1200, -999)).toEqual({ left: 260, right: 720, collapsed: false });
	});

	test("with opposite sidebar closed, a sidebar expands all the way to usable - 220px", () => {
		expect(dragHorizontalPanel("left", 260, 0, 1800, 1300)).toEqual({ left: 1560, right: 0, collapsed: false });
		expect(dragHorizontalPanel("left", 260, 0, 1800, 2000)).toEqual({ left: 1580, right: 0, collapsed: false });
		expect(dragHorizontalPanel("right", 0, 360, 1800, -2000)).toEqual({ left: 0, right: 1580, collapsed: false });
	});

	test("shrinking stops at 170px and snaps closed below half minimum on pointer drag, never on keyboard", () => {
		expect(dragHorizontalPanel("left", 260, 360, 1200, -90)).toEqual({ left: 170, right: 360, collapsed: false });
		// Between 85 and 170: stays clamped at 170 (dead zone before snap-close).
		expect(dragHorizontalPanel("left", 260, 360, 1200, -150)).toEqual({ left: 170, right: 360, collapsed: false });
		// Below 85: snaps closed, preserving start widths.
		expect(dragHorizontalPanel("left", 260, 360, 1200, -180)).toEqual({ left: 260, right: 360, collapsed: true });
		// Keyboard step (allowSnap = false) clamps cleanly at 170 without collapsing.
		expect(dragHorizontalPanel("left", 180, 360, 1200, -120, false)).toEqual({ left: 170, right: 360, collapsed: false });
		// Same for right sidebar (positive delta shrinks right).
		expect(dragHorizontalPanel("right", 260, 360, 1200, 280)).toEqual({ left: 260, right: 360, collapsed: true });
	});

	test("bottom panel expands without a 600px cap, snap-maximizes to fill center, and snaps closed below half minimum", () => {
		// centerHeight = 1005, splitterHeight = 5 -> fullHeight = 1000, maxNormal = 920.
		expect(dragBottomPanel(200, 1005, 5, -700)).toEqual({ height: 900, collapsed: false, maximized: false });
		// Dead zone between 920 and 960 (remaining editor 80..40): holds at 920 before snapping maximized.
		expect(dragBottomPanel(200, 1005, 5, -750)).toEqual({ height: 920, collapsed: false, maximized: false });
		// Past remaining editor < 40px: snaps maximized to fill the center pane.
		expect(dragBottomPanel(200, 1005, 5, -770)).toEqual({ height: 1000, collapsed: false, maximized: true });
		// Dragging back down from maximized restores cleanly once remaining editor >= 40px.
		expect(dragBottomPanel(200, 1005, 5, 20, true, true)).toEqual({ height: 1000, collapsed: false, maximized: true });
		expect(dragBottomPanel(200, 1005, 5, 50, true, true)).toEqual({ height: 920, collapsed: false, maximized: false });
		expect(dragBottomPanel(200, 1005, 5, 600, true, true)).toEqual({ height: 400, collapsed: false, maximized: false });
		// Shrinking below half of BOTTOM_MIN snaps closed, preserving saved start height.
		expect(dragBottomPanel(200, 1005, 5, 140)).toEqual({ height: BOTTOM_MIN, collapsed: false, maximized: false });
		expect(dragBottomPanel(200, 1005, 5, 170)).toEqual({ height: 200, collapsed: true, maximized: false });
		// Keyboard steps never snap-close, and stepping up at maxNormal maximizes cleanly.
		expect(dragBottomPanel(200, 1005, 5, 170, false)).toEqual({ height: BOTTOM_MIN, collapsed: false, maximized: false });
		expect(dragBottomPanel(920, 1005, 5, -16, false, false)).toEqual({ height: 1000, collapsed: false, maximized: true });
		expect(dragBottomPanel(200, 1005, 5, 16, false, true)).toEqual({ height: 920, collapsed: false, maximized: false });
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

describe("the panel a side shows", () => {
	test("is the one it was showing, while that is docked there", () => {
		expect(dockedView("search", ["explorer", "search", "git"])).toBe("search");
	});

	test("gives way to the first docked there when it was moved to the other side", () => {
		// The Agent was moved left and shown there; "Reset the layout" sent it home to the right.
		expect(dockedView("agent", ["explorer", "docs", "git"])).toBe("explorer");
		// The right side starts on a panel whose home is the left.
		expect(dockedView("health", ["agent"])).toBe("agent");
	});

	test("is none when no panel is docked on the side", () => {
		expect(dockedView("agent", [])).toBeNull();
	});
});

describe("the sides the window has no room for", () => {
	test("a side that is open and was given no width is crowded out; one that is shut is not", () => {
		expect(crowdedSides({ left: true, right: true }, fitPanels(600, 260, 360))).toEqual({ left: false, right: true });
		expect(crowdedSides({ left: true, right: false }, { left: 260, right: 0 })).toEqual({ left: false, right: false });
	});

	test("with room for neither, both are crowded out: neither is taken for showing", () => {
		// Too narrow for either panel beside the editors (< 44 + 220 + 170 = 434).
		const fit = fitPanels(400, 260, 360);
		expect(fit).toEqual({ left: 0, right: 0 });
		expect(crowdedSides({ left: true, right: true }, fit)).toEqual({ left: true, right: true });
	});
});
