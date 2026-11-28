import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceFiles } from "../src/bun/workspace";
import { TEXT, contrast } from "../src/shared/contrast";
import { replaceSafeInText } from "../src/shared/menuBar";
import { allOklchThemes } from "../src/shared/oklchTheme";
import {
	applyPreserveCase,
	becomesFound,
	replaceIn,
	replaceSearched,
	searchPattern,
	textMark,
} from "../src/shared/searchPattern";
import { ICON } from "../src/view/icons";
import {
	buildSearchTree,
	collectTreeFolderKeys,
	formatPlaceTrail,
	splitResultPath,
	stepResultKey,
	type SearchFileGroup,
} from "../src/view/panels/searchLines";
import dark from "../src/view/themes/studio-dark.json";
import light from "../src/view/themes/studio-light.json";

const read = (rel: string) => readFileSync(resolve(import.meta.dir, "..", rel), "utf8").replace(/\r\n/g, "\n");

function parseHex(h: string): [number, number, number] {
	return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function toHex([r, g, b]: [number, number, number]): string {
	return (
		"#" +
		[r, g, b]
			.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
			.join("")
	);
}
function mixSrgb(fg: string, pct: number, bg: string): string {
	const a = parseHex(fg);
	const b = parseHex(bg);
	const p = pct / 100;
	return toHex([a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), a[2] * p + b[2] * (1 - p)]);
}

describe("VS Code Search panel — filename-first path splitting & trail formatting", () => {
	test("splitResultPath separates filename from parent folder across separators", () => {
		expect(splitResultPath("AGENTS.md")).toEqual({ name: "AGENTS.md", dir: "" });
		expect(splitResultPath("Untitled-1")).toEqual({ name: "Untitled-1", dir: "" });
		expect(splitResultPath("src/DueDates/SetSampleDueDates.ssl")).toEqual({
			name: "SetSampleDueDates.ssl",
			dir: "src/DueDates",
		});
		expect(splitResultPath("docs\\tickets\\DEMO-101\\DEMO-101.md")).toEqual({
			name: "DEMO-101.md",
			dir: "docs/tickets/DEMO-101",
		});
		expect(splitResultPath("/src/DueDates/DueRules.ssl/")).toEqual({
			name: "DueRules.ssl",
			dir: "src/DueDates",
		});
	});

	test("formatPlaceTrail drops redundant H1 doc title when deeper Markdown headings exist", () => {
		expect(formatPlaceTrail([])).toBe("");
		expect(formatPlaceTrail(["Instructions for agents working on Due dates"], { dropRootTitle: true })).toBe(
			"Instructions for agents working on Due dates",
		);
		expect(
			formatPlaceTrail(["Instructions for agents working on Due dates", "Where things live"], { dropRootTitle: true }),
		).toBe("Where things live");
		expect(
			formatPlaceTrail(["Doc Title", "Validation", "Edge cases"], { dropRootTitle: true }),
		).toBe("Validation › Edge cases");
		// Without dropRootTitle (e.g., SSL region › procedure), every segment is preserved.
		expect(formatPlaceTrail(["Counting forward", "AddWorkingDays"])).toBe("Counting forward › AddWorkingDays");
	});
});

describe("VS Code Search panel — compacted folder tree & F4 stepping", () => {
	const makeFile = (relPath: string, matchCount: number): SearchFileGroup => ({
		path: `/ws/${relPath}`,
		relPath,
		matchCount,
		lines: Array.from({ length: matchCount }, (_, i) => ({
			path: `/ws/${relPath}`,
			line: i + 1,
			text: `line ${i + 1}`,
			matches: [{ column: 1, length: 4 }],
		})),
	});

	test("buildSearchTree compacts single-child folder chains, sorts folders before files, and rolls up counts", () => {
		const tree = buildSearchTree([
			makeFile("AGENTS.md", 10),
			makeFile("src/DueDates/WorkCalendar.ssl", 4),
			makeFile("src/DueDates/DueRules.ssl", 8),
			makeFile("docs/tickets/DEMO-101/DEMO-101.md", 3),
			makeFile("docs/specs/due-dates.md", 2),
		]);

		// Top level: folders (`docs`, compacted `src/DueDates`) before root file (`AGENTS.md`).
		expect(tree.map((n) => [n.kind, n.name])).toEqual([
			["folder", "docs"],
			["folder", "src/DueDates"],
			["file", "AGENTS.md"],
		]);

		const docsNode = tree[0]!;
		expect(docsNode.kind).toBe("folder");
		if (docsNode.kind === "folder") {
			expect(docsNode.matchCount).toBe(5);
			expect(docsNode.fileCount).toBe(2);
			expect(docsNode.children.map((c) => [c.kind, c.name])).toEqual([
				["folder", "specs"],
				["folder", "tickets/DEMO-101"],
			]);
		}

		const srcNode = tree[1]!;
		expect(srcNode.kind).toBe("folder");
		if (srcNode.kind === "folder") {
			expect(srcNode.relDir).toBe("src/DueDates");
			expect(srcNode.matchCount).toBe(12);
			expect(srcNode.fileCount).toBe(2);
			expect(srcNode.filePaths).toEqual(["/ws/src/DueDates/DueRules.ssl", "/ws/src/DueDates/WorkCalendar.ssl"]);
			expect(srcNode.children.map((c) => c.name)).toEqual(["DueRules.ssl", "WorkCalendar.ssl"]);
		}

		expect(collectTreeFolderKeys(tree)).toEqual([
			"dir:docs",
			"dir:docs/specs",
			"dir:docs/tickets/DEMO-101",
			"dir:src/DueDates",
		]);
	});

	test("stepResultKey wraps cleanly forward (F4) and backward (Shift+F4)", () => {
		const keys = ["a.ssl:1", "a.ssl:5", "b.ssl:2"];
		expect(stepResultKey([], null, 1)).toBeNull();
		expect(stepResultKey(keys, null, 1)).toBe("a.ssl:1");
		expect(stepResultKey(keys, null, -1)).toBe("b.ssl:2");
		expect(stepResultKey(keys, "a.ssl:1", 1)).toBe("a.ssl:5");
		expect(stepResultKey(keys, "b.ssl:2", 1)).toBe("a.ssl:1");
		expect(stepResultKey(keys, "a.ssl:1", -1)).toBe("b.ssl:2");
		expect(stepResultKey(keys, "dismissed.ssl:9", 1)).toBe("a.ssl:1");
		expect(stepResultKey(keys, "dismissed.ssl:9", -1)).toBe("b.ssl:2");
	});
});

describe("VS Code Search panel — WCAG AA contrast across all 27 built-in themes", () => {
	test("active inline toggles, error banner, and match/diff highlights pass WCAG AA (>= 4.5:1)", () => {
		const allThemes = [
			...allOklchThemes().map((t) => ({ name: t.name, s: t.studio })),
			...(
				[
					["Classic Dark", dark],
					["Classic Light", light],
				] as const
			).map(([name, t]) => ({
				name,
				s: {
					sideBg: t.colors["sideBar.background"]!,
					inputBg: t.colors["input.background"]!,
					strongFg: t.colors["tab.activeForeground"]!,
					accent: t.colors["focusBorder"]!,
					buttonBg: t.colors["button.background"]!,
					buttonFg: t.colors["button.foreground"]!,
					ok: t.colors["testing.iconPassed"]!,
					error: t.colors["editorError.foreground"]!,
				},
			})),
		];
		expect(allThemes.length).toBe(27);

		for (const { name, s } of allThemes) {
			// Active inline toggle inside input box: solid buttonBg/buttonFg matching VS Code active inputOption.
			expect(contrast(s.buttonFg, s.buttonBg), `${name} inline toggle on`).toBeGreaterThanOrEqual(TEXT);
			// Search error banner: 12% error over sideBg.
			expect(contrast(s.strongFg, mixSrgb(s.error, 12, s.sideBg)), `${name} search error banner`).toBeGreaterThanOrEqual(TEXT);
			// Match highlight, replace deletion, replace insertion over sideBg.
			expect(contrast(s.strongFg, mixSrgb(s.accent, 22, s.sideBg)), `${name} search mark`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.error, 18, s.sideBg)), `${name} search del`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.ok, 20, s.sideBg)), `${name} search ins`).toBeGreaterThanOrEqual(TEXT);
		}
	});
});

describe("VS Code Search panel — Preserve Case (AB) & Use Excludes (exclude) backend", () => {
	test("applyPreserveCase mirrors lower, UPPER, Title, PascalCase, camelCase, and delimited segments", () => {
		expect(applyPreserveCase("duedate", "TargetDate")).toBe("targetdate");
		expect(applyPreserveCase("DUEDATE", "targetDate")).toBe("TARGETDATE");
		expect(applyPreserveCase("DueDate", "targetDate")).toBe("TargetDate");
		expect(applyPreserveCase("dueDate", "TargetDate")).toBe("targetDate");
		expect(applyPreserveCase("Due", "target")).toBe("Target");
		expect(applyPreserveCase("Due", "TARGET")).toBe("Target");
		expect(applyPreserveCase("Due", "targetDate")).toBe("TargetDate");
		expect(applyPreserveCase("DUE_DATE", "target_date")).toBe("TARGET_DATE");
		expect(applyPreserveCase("Due_Date", "target_date")).toBe("Target_Date");
		expect(applyPreserveCase("due-date", "Target-Date")).toBe("target-date");
		expect(applyPreserveCase("Due-Date", "target-date")).toBe("Target-Date");
		expect(applyPreserveCase("123", "Target")).toBe("Target");
		expect(applyPreserveCase("DueDate", "")).toBe("");
	});

	test("preserveCase flows cleanly through becomesFound, replaceSearched, replaceIn, and replaceSafeInText", () => {
		const sample = "DueDate := dueDate + DUEDATE + duedate;";
		const replaced = replaceIn(sample, "duedate", "targetDate", { preserveCase: true });
		expect(replaced).toEqual({ text: "TargetDate := targetDate + TARGETDATE + targetdate;", count: 4 });

		// becomesFound handles non-regex preserveCase without running a regex in the renderer.
		expect(becomesFound(sample, 0, { column: 1, length: 7 }, "targetDate", false, true)).toBe("TargetDate");
		expect(becomesFound(sample, 0, { column: 12, length: 7 }, "targetDate", false, true)).toBe("targetDate");
		expect(becomesFound(sample, 0, { column: 22, length: 7 }, "targetDate", false, true)).toBe("TARGETDATE");

		// replaceSearched honors preserveCase on exact hits.
		const mark = textMark(sample);
		const res = replaceSearched(
			sample,
			mark,
			[
				{ line: 1, column: 1, length: 7 },
				{ line: 1, column: 22, length: 7 },
			],
			"targetDate",
			false,
			{ preserveCase: true },
		);
		expect(res?.text).toBe("TargetDate := dueDate + TARGETDATE + duedate;");

		// replaceSafeInText preserves case while still protecting Markdown link targets.
		const md = "See DueDate and [link](DueDate.md) and DUEDATE.\n";
		const safe = replaceSafeInText(md, searchPattern("duedate", {}), "targetDate", false, {
			isMarkdown: true,
			safeDocs: true,
			preserveCase: true,
		});
		expect(safe.text).toBe("See TargetDate and [link](DueDate.md) and TARGETDATE.\n");
		expect(safe.count).toBe(2);
		expect(safe.skippedProtected).toBe(1);
	});

	test("WorkspaceFiles.searchScan respects default excludes + .gitignore when useExcludes is true, and includes them (except .git) when false", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-search-excludes-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			mkdirSync(join(dir, "dist"), { recursive: true });
			mkdirSync(join(dir, "generated"), { recursive: true });
			mkdirSync(join(dir, ".git"), { recursive: true });
			writeFileSync(join(dir, ".gitignore"), "# ignore build outputs\n*.bak\ngenerated/\n!keep.bak\n");
			writeFileSync(join(dir, "src", "Rule.ssl"), "DueDate := 1;\n");
			writeFileSync(join(dir, "dist", "Bundle.ssl"), "DueDate := 2;\n");
			writeFileSync(join(dir, "generated", "Auto.ssl"), "DueDate := 3;\n");
			writeFileSync(join(dir, "old.bak"), "DueDate := 4;\n");
			writeFileSync(join(dir, "keep.bak"), "DueDate := 5;\n");
			writeFileSync(join(dir, ".git", "HEAD"), "DueDate := 6;\n");

			const ws = new WorkspaceFiles(dir);
			const withExcludes = await ws.searchScan("DueDate", {});
			expect(withExcludes.hits.map((h) => h.path.slice(dir.length + 1)).sort()).toEqual(["keep.bak", "src/Rule.ssl"]);

			const withoutExcludes = await ws.searchScan("DueDate", { useExcludes: false });
			expect(withoutExcludes.hits.map((h) => h.path.slice(dir.length + 1)).sort()).toEqual([
				"dist/Bundle.ssl",
				"generated/Auto.ssl",
				"keep.bak",
				"old.bak",
				"src/Rule.ssl",
			]);

			// WorkspaceFiles.replaced forwards preserveCase to both SSL and Safe-Docs Markdown paths.
			const sslPath = join(dir, "src", "Rule.ssl");
			writeFileSync(sslPath, "DueDate := DUEDATE + duedate;\n");
			const rep = await ws.replaced(sslPath, "duedate", "targetDate", { preserveCase: true });
			expect(rep?.after).toBe("TargetDate := TARGETDATE + targetdate;\n");
			expect(rep?.count).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("VS Code Search panel — icons, layout, commands & shortcuts wiring", () => {
	test("VS Code Search Codicons are registered in icons.ts", () => {
		for (const name of ["case-sensitive", "whole-word", "regex", "preserve-case", "exclude", "replace", "replace-all", "clear-all", "book"] as const) {
			expect(ICON[name]).toBeTruthy();
		}
	});

	test("Search.tsx matches VS Code layout: clean Search/Replace, AB preserve-case, single replace-all, same-line files-to-include + ellipsis, exclude toggle, and ADR 0050 funnel menu", () => {
		const src = read("src/view/panels/Search.tsx");
		expect(src).toContain('icon="case-sensitive"');
		expect(src).toContain('icon="whole-word"');
		expect(src).toContain('icon="regex"');
		expect(src).toContain('icon="preserve-case"');
		expect(src).toContain('icon="exclude"');
		expect(src).toContain('icon="clear-all"');
		expect(src).toContain('name="replace-all"');
		expect(src).toContain('name="replace"');
		expect(src).toContain('icon="book"');
		expect(src).toContain('spellcheck="false"');
		expect(src).toContain('role="tree"');
		expect(src).toContain('role="treeitem"');
		expect(src).toContain("chooseFromMenu(");
		expect(src).toContain("files to include");
		expect(src).toContain("files to exclude");
		expect(src).toContain("search-field-head");
		expect(src).toContain("search-details-seam");
		expect(src).toContain('"filter-filled" : "filter"');
		expect(src).toContain("search-progress-bar");
		expect(src).toContain("Restore {dismissedHitCount()}");
		// No always-visible scope pill bar, safe-docs checkbox row, or idle hint paragraph cluttering the widget.
		expect(src).not.toContain('class="search-scopes"');
		expect(src).not.toContain('class="search-safe-row"');
		expect(src).not.toContain('class="search-idle-hint"');
	});

	test("commands.ts wires selection-seeded Ctrl+Shift+F, F4/Shift+F4 navigation, and Ctrl+Alt+Enter guard in Search", () => {
		const src = read("src/view/commands.ts");
		expect(src).toContain("selectedSearchSeed");
		expect(src).toContain("search.focusSearch(seed)");
		expect(src).toContain("search.showReplace(seed)");
		expect(src).toContain('"search-next-match"');
		expect(src).toContain('"search-prev-match"');
		expect(src).toContain('f4: "search-next-match"');
		expect(src).toContain('"shift+f4": "search-prev-match"');
		expect(src).toContain('id === "open-link" && targetEl?.closest(\'[data-panel="search"]\')');
	});
});
