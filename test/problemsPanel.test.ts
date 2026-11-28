import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, TEXT } from "../src/shared/contrast";
import { allOklchThemes } from "../src/shared/oklchTheme";
import dark from "../src/view/themes/studio-dark.json";
import light from "../src/view/themes/studio-light.json";
import type { Diagnostic } from "../src/view/lsp/session";
import {
	buildProblemTableRows,
	DEFAULT_SEVERITY_FILTER,
	defaultProjectProblemsOpen,
	diagnosticMatchesQuery,
	formatScopedProblemsTooltip,
	isProjectProblemsOpen,
	isSeverityFiltered,
	nextTableSort,
	partitionProblems,
	severityAllowed,
	sortFileDiagnostics,
	tallyDiagnostics,
} from "../src/view/panels/problemsModel";

const repoRead = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

function mixSrgb(fgHex: string, pct: number, bgHex: string): string {
	const parse = (h: string) => {
		const c = h.replace("#", "");
		return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)] as const;
	};
	const [r1, g1, b1] = parse(fgHex);
	const [r2, g2, b2] = parse(bgHex);
	const w = pct / 100;
	const ch = (a: number, b: number) => Math.round(a * w + b * (1 - w)).toString(16).padStart(2, "0");
	return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

const mkDiag = (uri: string, severity: 1 | 2 | 3 | 4, line: number, message: string, code?: string): Diagnostic => ({
	uri,
	line,
	column: 1,
	endLine: line,
	endColumn: 10,
	severity,
	message,
	code,
});

describe("Problems panel — Current File priority, Project ordering, and smart collapse", () => {
	test("partitionProblems promotes the active file separately from project files and sorts diagnostics worst-first", () => {
		const activeUri = "file:///ws/src/DueRule.ssl";
		const warnUri = "file:///ws/src/DueRules.ssl";
		const errUri = "file:///ws/src/WorkCalendar.ssl";
		const openInfoUri = "file:///ws/docs/ActiveNote.md";
		const closedInfoUri = "file:///ws/docs/Orphan.md";

		const result = partitionProblems({
			entries: [
				{ uri: closedInfoUri, path: "/ws/docs/Orphan.md", canonPath: "/ws/docs/orphan.md", list: [mkDiag(closedInfoUri, 3, 1, "Unreferenced doc", "orphan-doc")] },
				{ uri: openInfoUri, path: "/ws/docs/ActiveNote.md", canonPath: "/ws/docs/activenote.md", list: [mkDiag(openInfoUri, 3, 4, "Wide table", "doc-table")] },
				{
					uri: activeUri,
					path: "/ws/src/DueRule.ssl",
					canonPath: "/ws/src/duerule.ssl",
					list: [
						mkDiag(activeUri, 2, 20, "Unused var", "unused"),
						mkDiag(activeUri, 1, 12, "Undefined var", "undef"),
						mkDiag(activeUri, 2, 8, "Shadowed var", "shadow"),
					],
				},
				{ uri: warnUri, path: "/ws/src/DueRules.ssl", canonPath: "/ws/src/duerules.ssl", list: [mkDiag(warnUri, 2, 5, "Missing return", "ret")] },
				{ uri: errUri, path: "/ws/src/WorkCalendar.ssl", canonPath: "/ws/src/workcalendar.ssl", list: [mkDiag(errUri, 1, 9, "Syntax error", "syntax")] },
			],
			activePath: "/ws/src/DueRule.ssl",
			activeCanonPath: "/ws/src/duerule.ssl",
			openCanonPaths: new Set(["/ws/src/duerule.ssl", "/ws/docs/activenote.md"]),
			displayPath: (g) => g.path.replace("/ws/", ""),
		});

		expect(result.activeFile?.uri).toBe(activeUri);
		expect(result.projectFiles.some((f) => f.uri === activeUri)).toBe(false);
		expect(result.activeFile?.list.map((d) => `${d.severity}:${d.line}`)).toEqual(["1:12", "2:8", "2:20"]);
		expect(result.activeTally).toEqual({ errors: 1, warnings: 2, other: 0, total: 3 });

		expect(result.projectFiles.map((f) => f.path)).toEqual([
			"/ws/src/WorkCalendar.ssl",
			"/ws/src/DueRules.ssl",
			"/ws/docs/ActiveNote.md",
			"/ws/docs/Orphan.md",
		]);
		expect(result.projectTally).toEqual({ errors: 1, warnings: 1, other: 2, total: 4 });
		expect(result.totalTally).toEqual({ errors: 2, warnings: 3, other: 2, total: 7 });
	});

	test("defaultProjectProblemsOpen folds info-only project files while active file is open, and surfaces them when active file is collapsed", () => {
		const activeUri = "file:///ws/src/DueRule.ssl";
		const orphanUri = "file:///ws/docs/Orphan.md";

		const activeUrgentOnlyNotesInProject = partitionProblems({
			entries: [
				{ uri: activeUri, path: "/ws/src/DueRule.ssl", canonPath: "/ws/src/duerule.ssl", list: [mkDiag(activeUri, 1, 10, "Error")] },
				{ uri: orphanUri, path: "/ws/docs/Orphan.md", canonPath: "/ws/docs/orphan.md", list: [mkDiag(orphanUri, 3, 1, "Orphan note")] },
			],
			activePath: "/ws/src/DueRule.ssl",
			activeCanonPath: "/ws/src/duerule.ssl",
			openCanonPaths: new Set(["/ws/src/duerule.ssl"]),
			displayPath: (g) => g.path,
		});
		// Current file open -> Project info-only stays folded
		expect(defaultProjectProblemsOpen(activeUrgentOnlyNotesInProject, true)).toBe(false);
		// Current file collapsed -> Project automatically surfaces!
		expect(defaultProjectProblemsOpen(activeUrgentOnlyNotesInProject, false)).toBe(true);
		expect(isProjectProblemsOpen(activeUrgentOnlyNotesInProject, null, false, false)).toBe(true);
		// Explicit user override still wins
		expect(isProjectProblemsOpen(activeUrgentOnlyNotesInProject, false, true, false)).toBe(false);
		expect(isProjectProblemsOpen(activeUrgentOnlyNotesInProject, true, false, true)).toBe(true);

		const activeClean = partitionProblems({
			entries: [
				{ uri: orphanUri, path: "/ws/docs/Orphan.md", canonPath: "/ws/docs/orphan.md", list: [mkDiag(orphanUri, 3, 1, "Orphan note")] },
			],
			activePath: "/ws/src/DueRule.ssl",
			activeCanonPath: "/ws/src/duerule.ssl",
			openCanonPaths: new Set(["/ws/src/duerule.ssl"]),
			displayPath: (g) => g.path,
		});
		expect(activeClean.activeFile).toBeNull();
		expect(defaultProjectProblemsOpen(activeClean, true)).toBe(true);
	});

	test("buildProblemTableRows promotes active file first in priority mode and supports column sort cycling", () => {
		const activeUri = "file:///ws/src/DueRule.ssl";
		const otherUri = "file:///ws/src/Alpha.ssl";
		const partition = partitionProblems({
			entries: [
				{ uri: otherUri, path: "/ws/src/Alpha.ssl", canonPath: "/ws/src/alpha.ssl", list: [mkDiag(otherUri, 1, 4, "Alpha error", "a_code")] },
				{ uri: activeUri, path: "/ws/src/DueRule.ssl", canonPath: "/ws/src/duerule.ssl", list: [mkDiag(activeUri, 2, 10, "Zeta warn", "z_code")] },
			],
			activePath: "/ws/src/DueRule.ssl",
			activeCanonPath: "/ws/src/duerule.ssl",
			openCanonPaths: new Set(["/ws/src/duerule.ssl"]),
			displayPath: (g) => g.path.replace("/ws/", ""),
		});

		const baseOpts = {
			activeOnly: false,
			displayPath: (g: { path: string }) => g.path.replace("/ws/", ""),
			fileName: (g: { path: string }) => g.path.split("/").pop()!,
		};

		// Default priority mode promotes Current File rows ahead of Project rows
		const priorityRows = buildProblemTableRows(partition, { ...baseOpts, sort: { key: "priority", dir: "asc" } });
		expect(priorityRows.map((r) => `${r.fileName}:${r.isCurrent}`)).toEqual(["DueRule.ssl:true", "Alpha.ssl:false"]);

		// Active-file-only hides Project rows completely
		const activeOnlyRows = buildProblemTableRows(partition, { ...baseOpts, activeOnly: true, sort: { key: "priority", dir: "asc" } });
		expect(activeOnlyRows.map((r) => r.fileName)).toEqual(["DueRule.ssl"]);

		// Explicit sort by code ascending & descending
		const s1 = nextTableSort({ key: "priority", dir: "asc" }, "code");
		expect(s1).toEqual({ key: "code", dir: "asc" });
		const ascRows = buildProblemTableRows(partition, { ...baseOpts, sort: s1 });
		expect(ascRows.map((r) => r.diagnostic.code)).toEqual(["a_code", "z_code"]);

		const s2 = nextTableSort(s1, "code");
		expect(s2).toEqual({ key: "code", dir: "desc" });
		const descRows = buildProblemTableRows(partition, { ...baseOpts, sort: s2 });
		expect(descRows.map((r) => r.diagnostic.code)).toEqual(["z_code", "a_code"]);

		// Third click returns to default priority (Current File first)
		expect(nextTableSort(s2, "code")).toEqual({ key: "priority", dir: "asc" });
	});

	test("severity filters, query matching, sorting, and scoped tooltip formatting work cleanly", () => {
		expect(isSeverityFiltered(DEFAULT_SEVERITY_FILTER)).toBe(false);
		const noInfo = { errors: true, warnings: true, info: false };
		expect(isSeverityFiltered(noInfo)).toBe(true);
		expect(severityAllowed(1, noInfo)).toBe(true);
		expect(severityAllowed(2, noInfo)).toBe(true);
		expect(severityAllowed(3, noInfo)).toBe(false);
		expect(severityAllowed(4, noInfo)).toBe(false);

		const d = mkDiag("file:///ws/src/DueRule.ssl", 2, 14, "Unused variable sTmp", "unused_local");
		expect(diagnosticMatchesQuery(d, "src/DueRule.ssl", "unused duerule")).toBe(true);
		expect(diagnosticMatchesQuery(d, "src/DueRule.ssl", "syntax")).toBe(false);

		expect(sortFileDiagnostics([mkDiag("u", 3, 1, "c"), mkDiag("u", 1, 5, "a"), mkDiag("u", 1, 2, "b")]).map((x) => x.message)).toEqual(["b", "a", "c"]);

		expect(
			formatScopedProblemsTooltip(
				"DueRule.ssl",
				tallyDiagnostics([{ severity: 1 }, { severity: 2 }]),
				tallyDiagnostics([{ severity: 3 }, { severity: 3 }]),
			),
		).toBe("Current file (DueRule.ssl): 1 error, 1 warning · Other project files: 2 notes");

		expect(
			formatScopedProblemsTooltip(null, tallyDiagnostics([]), tallyDiagnostics([{ severity: 2 }])),
		).toBe("Project: 1 warning");
	});
});

describe("Problems panel — 27-theme WCAG AA contrast and wiring invariants", () => {
	test("all Problems pills, Current tag, divider, and table surfaces meet WCAG AA (>= 4.5:1) across all 27 themes", () => {
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
					panelBg: t.colors["panel.background"] ?? t.colors["sideBar.background"]!,
					fg: t.colors["sideBar.foreground"]!,
					strongFg: t.colors["tab.activeForeground"]!,
					accent: t.colors["focusBorder"]!,
					warning: t.colors["editorWarning.foreground"]!,
					error: t.colors["editorError.foreground"]!,
					ok: t.colors["testing.iconPassed"]!,
				},
			})),
		];
		expect(allThemes.length).toBe(27);

		for (const { name, s } of allThemes) {
			expect(contrast(s.strongFg, mixSrgb(s.accent, 18, s.panelBg)), `${name} active-file tab badge`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.accent, 16, s.panelBg)), `${name} Current pill`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.error, 16, s.panelBg)), `${name} error active badge`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.warning, 16, s.panelBg)), `${name} warning active badge`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.fg, 2.5, s.panelBg)), `${name} Other project files divider`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.fg, s.panelBg), `${name} table row text`).toBeGreaterThanOrEqual(TEXT);
		}
	});

	test("Problems.tsx, App.tsx, and StatusBar.tsx wire single-bar actions, collapsible active file, and Tree/Table toggle", () => {
		const probSrc = repoRead("src/view/panels/Problems.tsx");
		expect(probSrc).toContain('data-problems-zone="current"');
		expect(probSrc).toContain('data-problems-zone="project"');
		expect(probSrc).toContain('data-problems-view-toggle="true"');
		expect(probSrc).toContain('data-problems-view="table"');
		expect(probSrc).toContain("export function ProblemsHeaderActions()");
		expect(probSrc).toContain("setCurrentCollapsed((v) => !v)");
		expect(probSrc).toContain("<FilterBox");
		expect(probSrc).toContain("export const scopedCounts");

		const appSrc = repoRead("src/view/App.tsx");
		expect(appSrc).toContain("<ProblemsHeaderActions />");
		expect(appSrc).toContain("scopedCounts");
		expect(appSrc).toContain("formatScopedProblemsTooltip");

		const sbSrc = repoRead("src/view/StatusBar.tsx");
		expect(sbSrc).toContain("scopedCounts");
		expect(sbSrc).toContain("formatScopedProblemsTooltip");
	});
});
