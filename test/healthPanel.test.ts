import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flush } from "solid-js";
import { contrast, TEXT } from "../src/shared/contrast";
import { allOklchThemes } from "../src/shared/oklchTheme";
import dark from "../src/view/themes/studio-dark.json";
import light from "../src/view/themes/studio-light.json";
import {
	classifyHealthFile,
	countProjectFileAttention,
	defaultProjectSectionOpen,
	healthScopeReq,
	isProjectSectionOpen,
	requestHealthScope,
	sliceActiveFileHealth,
	summarizeProjectHealth,
	worstSizeAlert,
	type ProjectSectionCounts,
} from "../src/view/panels/healthModel";

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

const canon = (p: string) => p.replace(/\\/g, "/").toLowerCase();

const emptyCounts: ProjectSectionCounts = {
	truncated: 0,
	drift: 0,
	workTotal: 0,
	workWarnings: 0,
	citationsTotal: 0,
	citationWarnings: 0,
	docIssuesTotal: 0,
	docIssueWarnings: 0,
	tasks: 0,
	undoc: 0,
	orphans: 0,
	registries: 0,
	projectFilesTotal: 4,
	projectFilesAttention: 0,
};

describe("Health panel — active file classification and scoped slicing", () => {
	test("classifyHealthFile identifies SSL, Markdown, SQL/DS, CSV/TSV registries, other, and empty", () => {
		expect(classifyHealthFile(null)).toBe("none");
		expect(classifyHealthFile(undefined)).toBe("none");
		expect(classifyHealthFile("/ws/src/DueRule.ssl")).toBe("ssl");
		expect(classifyHealthFile("/ws/src/NoExt", { hasSslSize: true })).toBe("ssl");
		expect(classifyHealthFile("/ws/docs/tickets/LIMS-1.md")).toBe("markdown");
		expect(classifyHealthFile("/ws/docs/Notes.MARKDOWN")).toBe("markdown");
		expect(classifyHealthFile("/ws/src/Holidays.ds")).toBe("sql");
		expect(classifyHealthFile("/ws/sql/orders.sql")).toBe("sql");
		expect(classifyHealthFile("/ws/docs/registries/database.csv")).toBe("registry");
		expect(classifyHealthFile("/ws/docs/registries/fields.tsv")).toBe("registry");
		expect(classifyHealthFile("/ws/project.toml")).toBe("other");
	});

	test("sliceActiveFileHealth isolates issues belonging only to the active SSL script (including incoming citations)", () => {
		const slice = sliceActiveFileHealth({
			path: "/ws/src/DueRule.ssl",
			canonicalize: canon,
			hasSslSize: true,
			isRegistry: false,
			sizeAlert: "near",
			findingsCount: 3,
			findingErrors: 0,
			findingWarnings: 2,
			checks: [
				{ level: "warn", text: "Unrelated doc check", path: "/ws/docs/Other.md" },
			],
			docIssues: [
				{ path: "/ws/docs/Other.md", line: 4, kind: "orphan", level: "note", message: "Unreferenced doc" },
			],
			citations: [
				{
					docPath: "/ws/docs/specs/DueSpec.md",
					docLine: 12,
					targetPath: "/ws/src/DueRule.ssl",
					citation: { href: "../../src/DueRule.ssl#L10-L20", file: "../../src/DueRule.ssl", from: 10, to: 20, line: 12 },
					kind: "drifted",
					level: "warn",
					text: "DueSpec.md L12 drifted against DueRule.ssl",
				},
				{
					docPath: "/ws/docs/specs/OtherSpec.md",
					docLine: 5,
					targetPath: "/ws/src/Other.ssl",
					citation: { href: "../../src/Other.ssl#L1", file: "../../src/Other.ssl", from: 1, to: 1, line: 5 },
					kind: "drifted",
					level: "warn",
					text: "OtherSpec.md drifted",
				},
			],
			schemaDrift: [],
			undocRefs: [],
			openTasks: [
				{ path: "/ws/docs/tickets/LIMS-1.md", name: "LIMS-1.md", group: "tickets", line: 8, offset: 42, text: "Check barcode" },
			],
		});

		expect(slice.kind).toBe("ssl");
		expect(slice.checks).toHaveLength(0);
		expect(slice.docIssues).toHaveLength(0);
		expect(slice.openTasks).toHaveLength(0);
		expect(slice.citations).toHaveLength(1);
		expect(slice.citations[0]!.targetPath).toBe("/ws/src/DueRule.ssl");
		expect(slice.warnings).toBe(4); // 2 LSP warnings + 1 size near + 1 citation warn
		expect(slice.notes).toBe(1); // 1 remaining non-error/non-warn finding
		expect(slice.tone).toBe("warn");
		expect(slice.statusLabel).toBe("Near limit · 4 warnings");
		expect(slice.badgeCount).toBe(4);
		expect(slice.clean).toBe(false);
	});

	test("sliceActiveFileHealth isolates Markdown checks, doc issues, outgoing citations, schema drift, and open tasks", () => {
		const slice = sliceActiveFileHealth({
			path: "/ws/schema/database/ORDERS.md",
			canonicalize: canon,
			hasSslSize: false,
			isRegistry: false,
			sizeAlert: "ok",
			findingsCount: 0,
			findingErrors: 0,
			findingWarnings: 0,
			checks: [
				{ level: "warn", text: "Broken link in ORDERS.md", path: "/ws/schema/database/ORDERS.md" },
				{ level: "warn", text: "Broken link elsewhere", path: "/ws/docs/specs/Other.md" },
			],
			docIssues: [
				{ path: "/ws/schema/database/ORDERS.md", line: 10, kind: "table", level: "note", message: "Wide table" },
				{ path: "/ws/docs/specs/Other.md", line: 1, kind: "orphan", level: "note", message: "Orphan" },
			],
			citations: [
				{
					docPath: "/ws/schema/database/ORDERS.md",
					docLine: 22,
					targetPath: "/ws/src/Orders.ssl",
					citation: { href: "../../src/Orders.ssl#L5", file: "../../src/Orders.ssl", from: 5, to: 5, line: 22 },
					kind: "out-of-range",
					level: "warn",
					text: "Out of range",
				},
			],
			schemaDrift: [
				{ table: "ORDERS", schemaPath: "/ws/schema/database/ORDERS.md", sqlPath: "/ws/sql/orders.sql", added: ["COL_X"], modified: [], dropped: [] },
				{ table: "OTHER", schemaPath: "/ws/schema/database/OTHER.md", sqlPath: "/ws/sql/other.sql", added: ["Y"], modified: [], dropped: [] },
			],
			undocRefs: [],
			openTasks: [
				{ path: "/ws/schema/database/ORDERS.md", name: "ORDERS.md", group: "schema", line: 15, offset: 90, text: "Document COL_X" },
				{ path: "/ws/docs/tickets/LIMS-2.md", name: "LIMS-2.md", group: "tickets", line: 4, offset: 15, text: "Unrelated task" },
			],
		});

		expect(slice.kind).toBe("markdown");
		expect(slice.checks).toHaveLength(1);
		expect(slice.docIssues).toHaveLength(1);
		expect(slice.citations).toHaveLength(1);
		expect(slice.schemaDrift).toHaveLength(1);
		expect(slice.openTasks).toHaveLength(1);
		expect(slice.warnings).toBe(3); // 1 check warn + 1 citation warn + 1 schema drift
		expect(slice.notes).toBe(1);
		expect(slice.tone).toBe("warn");
		expect(slice.badgeCount).toBe(3);
	});

	test("sliceActiveFileHealth isolates SQL/DS schema drift and undocumented refs and reports clean when empty", () => {
		const dirtySql = sliceActiveFileHealth({
			path: "/ws/src/Holidays.ds",
			canonicalize: canon,
			hasSslSize: false,
			isRegistry: false,
			sizeAlert: "ok",
			findingsCount: 0,
			findingErrors: 0,
			findingWarnings: 0,
			checks: [],
			docIssues: [],
			citations: [],
			schemaDrift: [
				{ table: "HOLIDAYS", schemaPath: "/ws/schema/database/HOLIDAYS.md", sqlPath: "/ws/src/Holidays.ds", added: ["REGION"], modified: [], dropped: [] },
			],
			undocRefs: [
				{ object: "LEGACY_CAL", kind: "table", path: "/ws/src/Holidays.ds", line: 9 },
				{ object: "OTHER_TBL", kind: "table", path: "/ws/src/Outages.ds", line: 3 },
			],
			openTasks: [],
		});
		expect(dirtySql.kind).toBe("sql");
		expect(dirtySql.schemaDrift).toHaveLength(1);
		expect(dirtySql.undocRefs).toHaveLength(1);
		expect(dirtySql.undocRefs[0]!.object).toBe("LEGACY_CAL");

		const cleanMd = sliceActiveFileHealth({
			path: "/ws/docs/Clean.md",
			canonicalize: canon,
			hasSslSize: false,
			isRegistry: false,
			sizeAlert: "ok",
			findingsCount: 0,
			findingErrors: 0,
			findingWarnings: 0,
			checks: [],
			docIssues: [],
			citations: [],
			schemaDrift: [],
			undocRefs: [],
			openTasks: [],
		});
		expect(cleanMd.clean).toBe(true);
		expect(cleanMd.tone).toBe("ok");
		expect(cleanMd.statusLabel).toBe("Healthy");
		expect(cleanMd.badgeCount).toBe(0);
	});

	test("worstSizeAlert escalates over > near > ok", () => {
		expect(worstSizeAlert(["ok", "ok", "ok"])).toBe("ok");
		expect(worstSizeAlert(["ok", "near", "ok"])).toBe("near");
		expect(worstSizeAlert(["near", "over", "ok"])).toBe("over");
	});
});

describe("Health panel — Project summary and calm default accordion state", () => {
	test("collapses noisy informational sections and all-written project files by default, keeping warnings visible", () => {
		const noisyProject: ProjectSectionCounts = {
			...emptyCounts,
			drift: 1,
			workTotal: 3,
			workWarnings: 1,
			docIssuesTotal: 14,
			docIssueWarnings: 0, // info-only orphan notes
			tasks: 12,
			undoc: 8,
			orphans: 5,
			registries: 2,
			projectFilesTotal: 4,
			projectFilesAttention: 0, // all written
		};

		const summary = summarizeProjectHealth(noisyProject);
		expect(summary.warnings).toBe(2); // 1 drift + 1 work warn
		expect(summary.tasks).toBe(12);
		expect(summary.notes).toBe(2 + 14 + 8 + 5);
		expect(summary.clean).toBe(false);

		// High-signal warnings stay open by default
		expect(defaultProjectSectionOpen("drift", noisyProject)).toBe(true);
		expect(defaultProjectSectionOpen("work", noisyProject)).toBe(true);
		// Noisy info-only sections & completed setup files start collapsed
		expect(defaultProjectSectionOpen("docIssues", noisyProject)).toBe(false);
		expect(defaultProjectSectionOpen("tasks", noisyProject)).toBe(false);
		expect(defaultProjectSectionOpen("undoc", noisyProject)).toBe(false);
		expect(defaultProjectSectionOpen("orphans", noisyProject)).toBe(false);
		expect(defaultProjectSectionOpen("registries", noisyProject)).toBe(false);
		expect(defaultProjectSectionOpen("projectFiles", noisyProject)).toBe(false);

		// Active filter auto-expands collapsed sections so search results are never hidden
		expect(isProjectSectionOpen("docIssues", noisyProject, {}, true)).toBe(true);
		expect(isProjectSectionOpen("tasks", noisyProject, {}, true)).toBe(true);
		// Explicit user collapse overrides even when filtering
		expect(isProjectSectionOpen("tasks", noisyProject, { tasks: false }, true)).toBe(false);
		expect(isProjectSectionOpen("tasks", noisyProject, { tasks: true }, false)).toBe(true);
	});

	test("auto-expands Project files when any file is missing or untouched template, and Document checks when warnings exist", () => {
		const needsSetup: ProjectSectionCounts = {
			...emptyCounts,
			docIssuesTotal: 4,
			docIssueWarnings: 1,
			projectFilesAttention: countProjectFileAttention([
				{ exists: true, untouched: false },
				{ exists: true, untouched: true },
				{ exists: false },
			]),
		};
		expect(needsSetup.projectFilesAttention).toBe(2);
		expect(defaultProjectSectionOpen("projectFiles", needsSetup)).toBe(true);
		expect(defaultProjectSectionOpen("docIssues", needsSetup)).toBe(true);
	});

	test("requestHealthScope emits monotonic scope requests for shell navigation", () => {
		requestHealthScope("file");
		flush();
		const first = healthScopeReq();
		expect(first?.scope).toBe("file");
		requestHealthScope("project");
		flush();
		const second = healthScopeReq();
		expect(second?.scope).toBe("project");
		expect(second!.seq).toBeGreaterThan(first!.seq);
	});
});

describe("Health panel — 27-theme WCAG AA contrast and wiring invariants", () => {
	test("all Health badges, status pills, overview pills, and hover action chips meet WCAG AA (>= 4.5:1) across all 27 themes", () => {
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
					panelBg: t.colors["panel.background"] ?? t.colors["sideBar.background"]!,
					fg: t.colors["sideBar.foreground"]!,
					strongFg: t.colors["tab.activeForeground"]!,
					warning: t.colors["editorWarning.foreground"]!,
					error: t.colors["editorError.foreground"]!,
					ok: t.colors["testing.iconPassed"]!,
				},
			})),
		];
		expect(allThemes.length).toBe(27);

		for (const { name, s } of allThemes) {
			expect(contrast(s.strongFg, mixSrgb(s.warning, 16, s.sideBg)), `${name} warn pill/badge`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.error, 16, s.sideBg)), `${name} error pill/badge`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.ok, 15, s.sideBg)), `${name} ok pill/badge`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.fg, mixSrgb(s.fg, 8, s.sideBg)), `${name} muted badge`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.fg, 2.5, s.sideBg)), `${name} file header & clean card`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.fg, s.panelBg), `${name} hover action button`).toBeGreaterThanOrEqual(TEXT);
		}
	});

	test("Health tabs and shell entry points route to Current File vs Project cleanly", () => {
		const healthSrc = repoRead("src/view/panels/Health.tsx");
		expect(healthSrc).toContain('role="tablist"');
		expect(healthSrc).toContain('data-health-tab="file"');
		expect(healthSrc).toContain('data-health-tab="project"');
		expect(healthSrc).toContain("health-row-acts");

		const statusSrc = repoRead("src/view/StatusBar.tsx");
		expect(statusSrc).toContain('requestHealthScope("file")');

		const editorSrc = repoRead("src/view/editor/EditorGroup.tsx");
		expect(editorSrc).toContain('requestHealthScope("file")');
		expect(editorSrc).toContain('requestHealthScope("project")');

		const selftestSrc = repoRead("src/view/selftestDocs.ts");
		expect(selftestSrc).toContain('requestHealthScope("project")');
	});
});
