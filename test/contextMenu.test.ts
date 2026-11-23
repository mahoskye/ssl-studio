import { describe, expect, test } from "bun:test";
import {
	menuItemValues,
	normalizeMenuEntries,
	placeAnchoredMenu,
	placeMenu,
	placeSubmenu,
	shouldUseQuickPick,
	submenuOrInline,
	type RowMenuEntry,
} from "../src/shared/contextMenu";
import { IMPORT_TICKETS, NEW_FOLDER, NEW_SPEC, NEW_TICKET, sectionMenuEntries, SHOW_FOLDER } from "../src/shared/docSections";
import { GIT_ACTIONS, rowMenuEntries } from "../src/shared/gitStatus";
import { docMatches, projectDocLabel } from "../src/shared/projectDocs";

describe("context menu normalization and submenus", () => {
	test("strips leading, trailing, and duplicate adjacent separators", () => {
		const raw: RowMenuEntry[] = ["separator", "separator", "Open", "separator", "separator", "Rename", "separator"];
		const out = normalizeMenuEntries(raw);
		expect(out).toEqual([
			{ kind: "item", label: "Open", value: "Open" },
			"separator",
			{ kind: "item", label: "Rename", value: "Rename" },
		]);
	});

	test("prunes empty submenus and cleans up orphaned separators around them", () => {
		const raw: RowMenuEntry[] = [
			"Open",
			"separator",
			{ label: "Empty", children: ["separator"] },
			"separator",
			{
				label: "Export",
				children: ["separator", { label: "HTML…", value: "html" }, "separator", "separator", { label: "Markdown…", value: "md" }, "separator"],
			},
			"separator",
			{ label: "Delete", value: "del", danger: true, keys: "Del" },
		];
		const out = normalizeMenuEntries(raw);
		expect(out).toEqual([
			{ kind: "item", label: "Open", value: "Open" },
			"separator",
			{
				kind: "submenu",
				label: "Export",
				children: [
					{ kind: "item", label: "HTML…", value: "html", keys: undefined, danger: undefined, disabled: undefined, checked: undefined },
					"separator",
					{ kind: "item", label: "Markdown…", value: "md", keys: undefined, danger: undefined, disabled: undefined, checked: undefined },
				],
				danger: undefined,
			},
			"separator",
			{ kind: "item", label: "Delete", value: "del", keys: "Del", danger: true, disabled: undefined, checked: undefined },
		]);
		expect(menuItemValues(raw)).toEqual(["Open", "html", "md", "del"]);
	});

	test("submenuOrInline collapses single-item groups inline and wraps multi-item groups", () => {
		expect(submenuOrInline("Empty", ["separator"])).toEqual([]);
		expect(submenuOrInline("Copy path", ["Copy name"])).toEqual([
			{ label: "Copy name", value: "Copy name", keys: undefined, danger: undefined, disabled: undefined, checked: undefined },
		]);
		const multi = submenuOrInline("Copy path", ["Copy path", "Copy name"]);
		expect(multi).toEqual([{ label: "Copy path", children: ["Copy path", "Copy name"] }]);
	});
});

describe("viewport placement for root menus and submenus", () => {
	test("clamps root menu inside the viewport with margin", () => {
		const placed = placeMenu({ x: 1380, y: 850 }, { width: 220, height: 300 }, { width: 1440, height: 900 });
		expect(placed.left).toBe(1440 - 220 - 8);
		expect(placed.top).toBe(900 - 300 - 8);
		expect(placed.maxHeight).toBe(900 - 16);
	});

	test("places submenu to the right when room exists and flips left near the right edge", () => {
		const right = placeSubmenu(
			{ left: 100, right: 300, top: 200, bottom: 228 },
			{ width: 200, height: 150 },
			{ width: 1440, height: 900 },
		);
		expect(right.side).toBe("right");
		expect(right.left).toBe(296);
		expect(right.top).toBe(195);

		const flipped = placeSubmenu(
			{ left: 700, right: 880, top: 780, bottom: 808 },
			{ width: 200, height: 220 },
			{ width: 900, height: 800 },
		);
		expect(flipped.side).toBe("left");
		expect(flipped.left).toBe(700 + 4 - 200);
		expect(flipped.top).toBe(800 - 220 - 8);
	});

	test("never places submenu off the left edge on ultra-narrow viewports", () => {
		const tight = placeSubmenu(
			{ left: 60, right: 240, top: 100, bottom: 128 },
			{ width: 220, height: 120 },
			{ width: 280, height: 600 },
		);
		expect(tight.left).toBeGreaterThanOrEqual(8);
		expect(tight.left + 220).toBeLessThanOrEqual(280 - 8);
	});
});

describe("sectioned Docs heading and Git row context menus", () => {
	test("sectionMenuEntries groups creation, maintenance, and folder navigation with separators", () => {
		const work = normalizeMenuEntries(sectionMenuEntries("work", { archiveAllDone: "Archive all done tickets…" }));
		expect(work.map((e) => (e === "separator" ? "---" : e.label))).toEqual([
			NEW_TICKET,
			NEW_SPEC,
			"---",
			IMPORT_TICKETS,
			"---",
			"Archive all done tickets…",
			"---",
			NEW_FOLDER,
			SHOW_FOLDER,
		]);
	});

	test("rowMenuEntries groups Git actions into inspect, index, path submenu, and danger discard", () => {
		const mod = normalizeMenuEntries(rowMenuEntries({ path: "/w/src/a.ssl", staged: null, unstaged: "modified" }, false, true));
		expect(mod.map((e) => (e === "separator" ? "---" : e.kind === "submenu" ? `${e.label} >` : e.label))).toEqual([
			GIT_ACTIONS.show,
			GIT_ACTIONS.open,
			"---",
			GIT_ACTIONS.stage,
			"---",
			"Copy path >",
			GIT_ACTIONS.showInExplorer,
			"---",
			GIT_ACTIONS.discard,
		]);
		const last = mod.at(-1);
		expect(last !== "separator" && last?.kind === "item" && last.danger).toBe(true);

		const del = normalizeMenuEntries(rowMenuEntries({ path: "/w/src/gone.ssl", staged: "deleted", unstaged: null }, true, true));
		expect(del.map((e) => (e === "separator" ? "---" : e.kind === "submenu" ? `${e.label} >` : e.label))).toEqual([
			GIT_ACTIONS.show,
			"---",
			GIT_ACTIONS.unstage,
			"---",
			"Copy path >",
		]);
	});
});

describe("anchored menu flipping and VS Code QuickPick selection threshold (ADR 0032)", () => {
	test("opens below anchor when there is room and flips above near bottom of viewport", () => {
		const below = placeAnchoredMenu(
			{ left: 120, right: 200, top: 60, bottom: 88 },
			{ width: 240, height: 220 },
			{ width: 1440, height: 900 },
		);
		expect(below.direction).toBe("down");
		expect(below.top).toBe(92);
		expect(below.top + 220).toBeLessThanOrEqual(900 - 8);

		// Bottom-right Agent Prompts button scenario: ~40px left below anchor, ample space above.
		const above = placeAnchoredMenu(
			{ left: 1180, right: 1260, top: 830, bottom: 858 },
			{ width: 280, height: 260 },
			{ width: 1440, height: 900 },
		);
		expect(above.direction).toBe("up");
		expect(above.top).toBe(830 - 4 - 260);
		expect(above.top).toBeGreaterThanOrEqual(8);
		expect(above.left + 280).toBeLessThanOrEqual(1440 - 8);
		expect(above.left).toBeGreaterThanOrEqual(8);
	});

	test("clamps anchored menu horizontally and caps maxHeight on compact viewports", () => {
		// Aligns flush with anchor right edge (890 - 300 = 590) and flips up within margin.
		const aligned = placeAnchoredMenu(
			{ left: 820, right: 890, top: 750, bottom: 778 },
			{ width: 300, height: 900 },
			{ width: 900, height: 800 },
		);
		expect(aligned.direction).toBe("up");
		expect(aligned.left).toBe(590);
		expect(aligned.top).toBe(8);
		expect(aligned.maxHeight).toBeLessThanOrEqual(750 - 4 - 8);

		// Clamps when anchor extends past right margin (898 - 300 = 598 > 592).
		const clamped = placeAnchoredMenu(
			{ left: 830, right: 898, top: 750, bottom: 778 },
			{ width: 300, height: 200 },
			{ width: 900, height: 800 },
		);
		expect(clamped.left).toBe(900 - 300 - 8);
		expect(clamped.left + 300).toBeLessThanOrEqual(900 - 8);
	});

	test("keeps compact confirmations modal and routes larger or rich lists to QuickPick", () => {
		expect(shouldUseQuickPick(["Delete"])).toBe(false);
		expect(shouldUseQuickPick(["Save", "Don't save"])).toBe(false);
		expect(shouldUseQuickPick(["Replace", "Append", "Skip"])).toBe(false);
		expect(shouldUseQuickPick(["One", "Two", "Three", "Four"])).toBe(true);
		expect(
			shouldUseQuickPick(["Option A", "Option B"], {
				"Option A": "First description",
				"Option B": "Second description",
			}),
		).toBe(true);
		expect(shouldUseQuickPick(["DEMO-101: Add due dates and overdue notices (in progress)", "Clear"])).toBe(true);
	});
});

describe("Docs Project section friendly names (ADR 0032)", () => {
	test("maps all six curated Project documents to standard friendly labels + quiet filenames", () => {
		expect(projectDocLabel({ name: "README.md", group: "project" })).toEqual({ label: "Project Overview", fileMeta: "README.md" });
		expect(projectDocLabel({ name: "readme.md", group: "project" })).toEqual({ label: "Project Overview", fileMeta: "readme.md" });
		expect(projectDocLabel({ name: "AGENTS.md", group: "project" })).toEqual({ label: "Agent Instructions", fileMeta: "AGENTS.md" });
		expect(projectDocLabel({ name: "project.toml", group: "project" })).toEqual({ label: "Project Settings", fileMeta: "project.toml" });
		expect(projectDocLabel({ name: "STATE.md", group: "project" })).toEqual({ label: "Project State", fileMeta: "STATE.md" });
		expect(projectDocLabel({ name: "src/INDEX.md", group: "project", catalog: { stale: false, area: "code" } })).toEqual({
			label: "Deployment",
			fileMeta: "src/INDEX.md",
		});
		expect(projectDocLabel({ name: "tests/INDEX.md", group: "project", catalog: { stale: false, area: "tests" } })).toEqual({
			label: "Tests",
			fileMeta: "tests/INDEX.md",
		});
		expect(projectDocLabel({ name: "README.md", group: "docs" })).toBeNull();
	});

	test("docMatches finds Project documents by either friendly label or filename", () => {
		const settings = { name: "project.toml", group: "project" as const };
		const deploy = { name: "src/INDEX.md", group: "project" as const, catalog: { stale: false, area: "code" as const } };
		const stateDoc = { name: "STATE.md", group: "project" as const, title: "Where Due dates stands" };
		expect(docMatches(settings, "settings")).toBe(true);
		expect(docMatches(settings, "project.toml")).toBe(true);
		expect(docMatches(deploy, "deployment")).toBe(true);
		expect(docMatches(deploy, "src/index")).toBe(true);
		expect(docMatches(stateDoc, "project state")).toBe(true);
		expect(docMatches(stateDoc, "state.md")).toBe(true);
	});
});
