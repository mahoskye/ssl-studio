import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createBackend, type Host } from "../src/bun/backend";
import { markdownToDocx } from "../src/bun/docx";
import { Git } from "../src/bun/git";
import { DOC_LIMIT, docsTruncated, linksTo, listDocs, namesIn, readProject, SCHEMA_DOC_LIMIT } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { docChecks, orphanDocChecks, staleDocChecks } from "../src/shared/docChecks";
import { ownLinkEdits, withLinkFiles } from "../src/shared/docLinks";
import { withNames } from "../src/shared/namedLinks";
import { summarizePlanForPrompt } from "../src/shared/planSummary";
import { statusChoices } from "../src/shared/projectDocs";
import type { DocFile } from "../src/shared/protocol";
import {
	extractQueriedTablesFromSql,
	mergeSqlTablesIntoMarkdown,
	parseCreateTables,
	sqlTablesToMarkdown,
} from "../src/shared/sqlSchema";
import { docLinkedTickets, pathMatchesRef, ticketWork, workFor, workText } from "../src/shared/workContext";
import { workList } from "../src/shared/workList";

// 1x1 transparent PNG
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("Wave 1.8 — Canonical summarizePlanForPrompt & workContext integration", () => {
	test("reads real .plan.json schema (n.text, string & object targets, unanswered decisions, tests, built)", () => {
		const raw = JSON.stringify({
			version: 1,
			title: "Set sample due dates",
			ticket: "DEMO-101",
			goal: "Assign due dates to waiting samples skipping lab holidays.",
			targets: ["src/DueDates/SetSampleDueDates.ssl", { script: "src/DueDates/SaveDueDates.ssl", procedures: ["WriteDueDates"] }],
			nodes: [
				{ id: "n1", kind: "start", text: "Run with no parameters" },
				{ id: "n2", kind: "call", text: "Load lab holidays", ref: "DueDates.Holidays.Load", docs: ["docs/specs/Holidays.md"] },
				{ id: "n3", kind: "step", label: "Legacy label fallback" },
			],
			decisions: [
				{ question: "Should rush samples count Saturday?", answer: "Yes, per QA signoff." },
				{ question: "What is the max lookahead window?", answer: "" },
				{ question: "How should missing turnaround be logged?" },
			],
			openQuestions: ["Legacy open question"],
			tests: [
				{ id: "T1", title: "Skips Sunday", given: "Friday receipt", expect: "Monday due date" },
			],
			built: {
				units: [
					{ name: "ApplyDueDates", script: "src/DueDates/SetSampleDueDates.ssl" },
					{ name: "WriteDueDates", script: "src/DueDates/SaveDueDates.ssl" },
				],
				tests: { script: "tests/TestDueDates.ssl" },
			},
		});

		const summary = summarizePlanForPrompt(raw)!;
		expect(summary).toContain("Title: Set sample due dates");
		expect(summary).toContain("Ticket: DEMO-101");
		expect(summary).toContain("Goal: Assign due dates to waiting samples skipping lab holidays.");
		expect(summary).toContain("Targets: src/DueDates/SetSampleDueDates.ssl; src/DueDates/SaveDueDates.ssl (WriteDueDates)");
		expect(summary).toContain("Built scripts: src/DueDates/SetSampleDueDates.ssl; src/DueDates/SaveDueDates.ssl");
		expect(summary).toContain("Test script: tests/TestDueDates.ssl");
		expect(summary).toContain("[call] Load lab holidays (DueDates.Holidays.Load) [docs: docs/specs/Holidays.md]");
		expect(summary).toContain("[step] Legacy label fallback");
		expect(summary).toContain("Linked docs: docs/specs/Holidays.md");
		// Only unanswered decisions + legacy openQuestions appear; answered decision is excluded.
		expect(summary).toContain("What is the max lookahead window?");
		expect(summary).toContain("How should missing turnaround be logged?");
		expect(summary).toContain("Legacy open question");
		expect(summary).not.toContain("Should rush samples count Saturday?");
		expect(summary).toContain("T1: Skips Sunday (given: Friday receipt) => Monday due date");

		expect(summarizePlanForPrompt("not valid json")).toBeNull();
		expect(summarizePlanForPrompt("{}")).toBeNull();
	});

	test("workText uses summarizePlanForPrompt including real n.text and unanswered decisions", async () => {
		const files: DocFile[] = [
			{ path: "/ws/docs/tickets/LIMS-5.md", name: "LIMS-5.md", group: "tickets", exists: true, ticket: "LIMS-5", title: "Due calc", status: "in progress" },
			{ path: "/ws/design/Calc.plan.json", name: "Calc.plan.json", group: "plans", exists: true, tickets: ["LIMS-5"] },
		];
		const work = workFor(files, "LIMS-5")!;
		const txt = await workText(work, async (p) => {
			if (p.endsWith("Calc.plan.json")) {
				return JSON.stringify({
					version: 1,
					title: "Due Calc",
					targets: ["src/Calc.ssl"],
					nodes: [{ id: "n1", kind: "step", text: "Compute turnaround" }],
					decisions: [
						{ question: "Timezone for cutoff?", answer: "" },
						{ question: "Already settled?", answer: "Yes" },
					],
				});
			}
			return "# LIMS-5\n\nImplement calc.";
		});
		expect(txt).toContain("Compute turnaround");
		expect(txt).toContain("Timezone for cutoff?");
		expect(txt).not.toContain("Already settled?");
	});
});

describe("Wave 1.4 — SQL DDL enhancements, markDropped option, and .ds SQL precision", () => {
	test("parses SSMS WITH CHECK / WITH NOCHECK FKs, RENAME COLUMN, and Oracle COMMENT ON COLUMN", () => {
		const sql = `
CREATE TABLE [dbo].[FOLDERS] (
	[FOLDERNO] [varchar](20) NOT NULL PRIMARY KEY
);
CREATE TABLE [dbo].[SAMPLES] (
	[SAMPLE_ID] [varchar](20) NOT NULL PRIMARY KEY,
	[FOLDER_REF] [varchar](20) NOT NULL,
	[PRIORITY] [varchar](10)
);
ALTER TABLE [dbo].[SAMPLES] WITH CHECK ADD CONSTRAINT [FK_SAMPLES_FOLDERS] FOREIGN KEY([FOLDER_REF]) REFERENCES [dbo].[FOLDERS] ([FOLDERNO]);
ALTER TABLE [dbo].[SAMPLES] WITH NOCHECK ADD CONSTRAINT [FK_SAMPLES_TESTS] FOREIGN KEY([PRIORITY]) REFERENCES [dbo].[PRIORITIES] ([CODE]);
COMMENT ON COLUMN dbo.SAMPLES.FOLDER_REF IS 'Parent folder identifier';
ALTER TABLE [dbo].[SAMPLES] RENAME COLUMN [FOLDER_REF] TO [FOLDERNO];
COMMENT ON COLUMN SAMPLES.PRIORITY IS 'NORMAL or ''RUSH'' priority';
`;
		const tables = parseCreateTables(sql);
		const samples = tables.find((t) => t.tableName === "SAMPLES")!;
		expect(samples.columns.map((c) => c.name)).toEqual(["SAMPLE_ID", "FOLDERNO", "PRIORITY"]);
		expect(samples.columns.find((c) => c.name === "FOLDERNO")?.comment).toBe("Parent folder identifier");
		expect(samples.columns.find((c) => c.name === "PRIORITY")?.comment).toBe("NORMAL or 'RUSH' priority");
		expect(samples.foreignKeys).toEqual([
			{ column: "FOLDERNO", refTable: "FOLDERS", refColumn: "FOLDERNO" },
			{ column: "PRIORITY", refTable: "PRIORITIES", refColumn: "CODE" },
		]);

		// sqlTablesToMarkdown seeds Notes from COMMENT ON COLUMN
		const generated = sqlTablesToMarkdown([samples]);
		expect(generated).toContain("| `FOLDERNO` | `varchar(20)` | NOT NULL | Parent folder identifier |");
		expect(generated).toContain("| `PRIORITY` | `varchar(10)` | — | NORMAL or 'RUSH' priority |");

		// mergeSqlTablesIntoMarkdown seeds empty Notes without overwriting user notes
		const existingMd = [
			"## SAMPLES",
			"",
			"| Column | Type | Constraints | Notes |",
			"| --- | --- | --- | --- |",
			"| `SAMPLE_ID` | `varchar(20)` | NOT NULL PRIMARY KEY | Custom PK note |",
			"| `FOLDERNO` | `varchar(20)` | NOT NULL |  |",
			"| `PRIORITY` | `varchar(10)` | — | Hand-authored priority rules |",
			"| `OLD_LEGACY` | `int` | — | Kept for history |",
		].join("\n");

		const keepAsIs = mergeSqlTablesIntoMarkdown(existingMd, [samples], undefined, { markDropped: false });
		expect(keepAsIs.text).toContain("| `FOLDERNO` | `varchar(20)` | NOT NULL | Parent folder identifier |");
		expect(keepAsIs.text).toContain("| `PRIORITY` | `varchar(10)` | — | Hand-authored priority rules |");
		expect(keepAsIs.text).toContain("| `OLD_LEGACY` | `int` | — | Kept for history |");
		expect(keepAsIs.text).not.toContain("[deprecated / dropped in SQL]");
		expect(keepAsIs.droppedColumns).toBe(0);

		const defaultMerge = mergeSqlTablesIntoMarkdown(existingMd, [samples]);
		expect(defaultMerge.text).toContain("Kept for history [deprecated / dropped in SQL]");
		expect(defaultMerge.droppedColumns).toBe(1);
	});

	test("stops English error/log strings in .ds from producing false tables and detects RunSQL/LSelect/LimSelect/SQLExecuteEx", () => {
		const ds1 = [
			":PARAMETERS sId := '';",
			'sErr := "Failed reading from config";',
			'sLog := "Update status failed";',
			'sMsg := "Could not join strings cleanly";',
			':RETURN RunSQL("SELECT f.FOLDERNO FROM FOLDERS f, SAMPLES s, RESULTS r WHERE s.FOLDERNO = f.FOLDERNO AND r.SAMPLE_ID = s.SAMPLE_ID");',
		].join("\n");
		expect(extractQueriedTablesFromSql(ds1).map((r) => r.object)).toEqual(["FOLDERS", "SAMPLES", "RESULTS"]);

		const ds2 = 'aRows := LSelect("SELECT * FROM CALIB_ITEMS WHERE ACTIVE = 1");';
		expect(extractQueriedTablesFromSql(ds2).map((r) => r.object)).toEqual(["CALIB_ITEMS"]);

		const ds3 = 'aRows := LimSelect("SELECT * FROM LAB_SITES");';
		expect(extractQueriedTablesFromSql(ds3).map((r) => r.object)).toEqual(["LAB_SITES"]);

		const ds4 = 'SQLExecuteEx("DELETE STALE_QUEUE WHERE CREATED_ON < ?dCut?");';
		expect(extractQueriedTablesFromSql(ds4).map((r) => r.object)).toEqual(["STALE_QUEUE"]);
	});

	test("handles ANSI-89 comma joins, DELETE without FROM, and excludes T-SQL UPDATE/DELETE FROM aliases", () => {
		const sql = `
SELECT f.ID, s.ID, r.VAL
FROM dbo.FOLDERS f WITH (NOLOCK), dbo.SAMPLES AS s, RESULTS r
WHERE s.FID = f.ID AND r.SID = s.ID;

UPDATE smp
SET smp.STATUS = 'DONE'
FROM dbo.SAMPLES smp
JOIN dbo.BATCHES b ON b.ID = smp.BATCH_ID
WHERE b.CLOSED = 1;

DELETE arch
FROM dbo.ARCHIVE_ITEMS arch
WHERE arch.EXPIRED = 1;

DELETE DIRECT_TEMP_LOG WHERE AGE > 30;
`;
		const objects = extractQueriedTablesFromSql(sql).map((r) => r.object);
		expect(objects).toEqual(["FOLDERS", "SAMPLES", "RESULTS", "BATCHES", "ARCHIVE_ITEMS", "DIRECT_TEMP_LOG"]);
		expect(objects).not.toContain("smp");
		expect(objects).not.toContain("arch");
	});
});

describe("Wave 1.5 & 3.1/3.5 — Relative ../ resolution, frontmatter rebasing, governance & fix descriptors", () => {
	test("ownLinkEdits rebases relative YAML frontPaths when moving a Markdown file to another folder", () => {
		const md = [
			"---",
			"ticket: LIMS-1",
			"specs: [../specs/Due.md, design/RootRelative.spec.md]",
			"source: ../sql/samples.sql",
			"---",
			"",
			"See [Spec](../specs/Due.md).",
		].join("\n");
		const edits = ownLinkEdits(md, "/ws/docs/tickets/LIMS-1.md", "/ws/docs/tickets/archive/LIMS-1.md");
		const applied = withLinkFiles(md, edits);
		expect(applied.done).toBe(3);
		expect(applied.text).toContain("specs: [../../specs/Due.md, design/RootRelative.spec.md]");
		expect(applied.text).toContain("source: ../../sql/samples.sql");
		expect(applied.text).toContain("[Spec](../../specs/Due.md)");

		// Moving into the target's own folder preserves explicit `./` prefix so it remains doc-relative
		const md2 = "---\nsource: ../sql/samples.sql\n---\n# Samples\n";
		const edits2 = ownLinkEdits(md2, "/ws/schema/database/SAMPLES.md", "/ws/schema/sql/SAMPLES.md");
		expect(withLinkFiles(md2, edits2).text).toContain("source: ./samples.sql");
	});

	test("workContext, workList, and docChecks resolve ../ relative specs & plans without false orphans", () => {
		const files: DocFile[] = [
			{
				path: "/ws/docs/tickets/LIMS-9.md",
				name: "LIMS-9.md",
				group: "tickets",
				exists: true,
				ticket: "LIMS-9",
				title: "Relative refs",
				status: "in progress",
				specs: ["../specs/Foo.md"],
				plans: ["../../design/Foo.plan.json"],
			},
			{ path: "/ws/docs/specs/Foo.md", name: "Foo.md", group: "specs", exists: true, title: "Foo Spec" },
			{ path: "/ws/design/Foo.plan.json", name: "Foo.plan.json", group: "plans", exists: true, heading: "Foo Plan" },
			{ path: "/ws/docs/tickets/INDEX.md", name: "INDEX.md", group: "tickets", exists: true, catalog: { stale: false } },
			{ path: "/ws/docs/specs/INDEX.md", name: "INDEX.md", group: "specs", exists: true, catalog: { stale: false } },
		];

		expect(pathMatchesRef("/ws/docs/specs/Foo.md", "../specs/Foo.md", "/ws/docs/tickets/LIMS-9.md")).toBe(true);
		const work = workFor(files, "LIMS-9")!;
		expect(work.specs.map((s) => s.name)).toEqual(["Foo.md"]);
		expect(work.plans?.map((p) => p.name)).toEqual(["Foo.plan.json"]);
		expect(ticketWork(files, "LIMS-9").map((g) => g.kind)).toEqual(["plan", "spec"]);
		expect(docLinkedTickets(files, "/ws/docs/specs/Foo.md").map((e) => e.key)).toEqual(["LIMS-9"]);

		const wl = workList(files, "/ws");
		expect(wl.loose).toEqual([]);
		expect(wl.rows.map((r) => [r.kind, r.file.name])).toEqual([
			["ticket", "LIMS-9.md"],
			["plan", "Foo.plan.json"],
			["spec", "Foo.md"],
		]);

		const checks = docChecks(files);
		expect(checks.some((c) => c.text.includes("Spec has no linked ticket"))).toBe(false);
		expect(checks.some((c) => c.text.includes("plan has no ticket linked"))).toBe(false);

		const schemaDocs: DocFile[] = [
			{ path: "/ws/schema/database/T.md", name: "database/T.md", group: "schema", kind: "database", exists: true, source: "../sql/t.sql" },
			{ path: "/ws/schema/sql/t.sql", name: "sql/t.sql", group: "schema", kind: "sql", exists: true },
		];
		const orphans = orphanDocChecks(schemaDocs, new Set(), { root: "/ws" });
		expect(orphans.some((o) => o.path.endsWith("t.sql"))).toBe(false);
	});

	test("statusChoices includes approved for specs & controlled reference docs; staleDocChecks uses frontmatter dates & review-due; docChecks emits structured fix descriptors", () => {
		expect(statusChoices({ group: "specs" })).toContain("approved");
		expect(statusChoices({ group: "knowledge", kind: "reference" })).toContain("approved");
		expect(statusChoices({ group: "docs", docKind: "test-run" })).toContain("approved");

		const now = Date.UTC(2026, 10, 23, 12, 0, 0); // 2026-11-23
		const docs: DocFile[] = [
			// Fresh mtime (simulating git clone today), but asked 2 years ago!
			{
				path: "/ws/docs/knowledge/questions/q-cloned.md",
				name: "questions/q-cloned.md",
				group: "knowledge",
				kind: "questions",
				exists: true,
				title: "Legacy cutoff?",
				status: "open",
				asked: "2024-06-01",
				mtime: now,
			},
			// Review past due -> warn
			{
				path: "/ws/docs/knowledge/reference/sop-overdue.md",
				name: "reference/sop-overdue.md",
				group: "knowledge",
				kind: "reference",
				exists: true,
				title: "Overdue SOP",
				status: "approved",
				version: "2.0",
				approvedBy: "QA",
				approvedDate: "2025-11-01",
				reviewDue: "2026-11-10",
				mtime: now,
			},
			// Review due within 30 days -> note
			{
				path: "/ws/docs/knowledge/reference/sop-soon.md",
				name: "reference/sop-soon.md",
				group: "knowledge",
				kind: "reference",
				exists: true,
				title: "Upcoming SOP",
				status: "approved",
				version: "1.0",
				approvedBy: "QA",
				approvedDate: "2025-12-01",
				reviewDue: "2026-12-10",
				mtime: now,
			},
			// Missing approval metadata -> fix: record-approval
			{
				path: "/ws/docs/specs/unapproved.md",
				name: "unapproved.md",
				group: "specs",
				exists: true,
				title: "Controlled Spec",
				version: "1.0",
				mtime: now,
			},
		];

		const stale = staleDocChecks(docs, now);
		expect(stale.some((s) => s.path.endsWith("q-cloned.md") && s.message.includes("Open question untouched"))).toBe(true);
		expect(stale.find((s) => s.path.endsWith("sop-overdue.md"))).toMatchObject({ level: "warn" });
		expect(stale.find((s) => s.path.endsWith("sop-soon.md"))).toMatchObject({ level: "note" });
		expect(stale.find((s) => s.path.endsWith("unapproved.md"))?.fix).toEqual({
			kind: "record-approval",
			path: "/ws/docs/specs/unapproved.md",
		});

		// Asymmetric ADR & broken wikilink fix descriptors
		const adrFiles: DocFile[] = [
			{
				path: "/ws/docs/knowledge/decisions/0001-old.md",
				name: "decisions/0001-old.md",
				group: "knowledge",
				kind: "decisions",
				exists: true,
				status: "accepted",
			},
			{
				path: "/ws/docs/knowledge/decisions/0002-new.md",
				name: "decisions/0002-new.md",
				group: "knowledge",
				kind: "decisions",
				exists: true,
				status: "accepted",
				supersedes: ["0001-old"],
				broken: [{ href: "[[Due-soon-repot]]", line: 8, column: 6, instead: "Due-soon-report" }],
			},
			{ path: "/ws/docs/knowledge/INDEX.md", name: "INDEX.md", group: "knowledge", exists: true, catalog: { stale: false } },
		];
		const checks = docChecks(adrFiles);
		const adrCheck = checks.find((c) => c.fix?.kind === "reciprocal-adr");
		expect(adrCheck?.fix).toEqual({
			kind: "reciprocal-adr",
			path: "/ws/docs/knowledge/decisions/0001-old.md",
			field: "superseded-by",
			value: "0002-new",
		});
		const wikiCheck = checks.find((c) => c.fix?.kind === "mend-wikilinks");
		expect(wikiCheck?.fix).toEqual({
			kind: "mend-wikilinks",
			mends: [{ line: 8, column: 6, name: "Due-soon-repot", href: "[[Due-soon-repot]]", instead: "Due-soon-report" }],
		});
	});
});

describe("Wave 1.5 & 1.7 — project.ts exports skip, unified linksTo, 1 MB reads, deterministic caps & wikilink mends", () => {
	test("linksTo/namesIn skip exports/, scan plans/registries/code comments with kind tags, and listDocs reads >64KB + suggests wikilink mends", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-r6-proj-"));
		try {
			mkdirSync(join(dir, ".ssl-studio"), { recursive: true });
			mkdirSync(join(dir, "docs", "specs"), { recursive: true });
			mkdirSync(join(dir, "docs", "registries"), { recursive: true });
			mkdirSync(join(dir, "docs", "exports", "2026-11-23"), { recursive: true });
			mkdirSync(join(dir, "docs", "test-runs"), { recursive: true });
			mkdirSync(join(dir, "design"), { recursive: true });
			mkdirSync(join(dir, "schema", "database"), { recursive: true });
			mkdirSync(join(dir, "src"), { recursive: true });
			mkdirSync(join(dir, "tests"), { recursive: true });

			writeFileSync(join(dir, ".ssl-studio", "project.toml"), 'name = "R6Demo"\n');
			writeFileSync(join(dir, "src", "Calc.ssl"), "/* Spec: docs/specs/Due-soon-report.md;\nsLiteral := \"docs/specs/Due-soon-report.md\";\n:RETURN 1;\n");
			writeFileSync(join(dir, "docs", "specs", "Due-soon-report.md"), "---\ntitle: Due Soon Report\neffective-date: 2026-11-01\nreview-due: 2027-11-01\n---\n# Due Soon Report\n");
			writeFileSync(
				join(dir, "docs", "test-runs", "TR-01.md"),
				"---\ntitle: OQ Run 01\nphase: OQ\nasked: 2026-11-10\ndate: 2026-11-12\n---\n# OQ Run 01\n\nSee [[Due-soon-repot]] and [[DEMO-999]].\n",
			);
			// Frozen export snapshot MUST be skipped by linksTo and namesIn
			writeFileSync(
				join(dir, "docs", "exports", "2026-11-23", "snapshot.md"),
				"[Report](../../specs/Due-soon-report.md) [[Due-soon-report]]\n",
			);
			writeFileSync(
				join(dir, "docs", "registries", "files.csv"),
				"path,kind,status\nsrc/Calc.ssl,script,verified\ndocs/specs/Due-soon-report.md,document,verified\n",
			);
			writeFileSync(
				join(dir, "design", "Calc.plan.json"),
				JSON.stringify(
					{
						version: 1,
						title: "Calc Plan",
						targets: ["src/Calc.ssl"],
						scripts: ["src/Calc.ssl"],
						testScripts: ["tests/TestCalc.ssl"],
						groups: [],
						nodes: [{ id: "n1", kind: "step", text: "Run", docs: ["docs/specs/Due-soon-report.md"] }],
						edges: [],
						built: {
							units: [{ name: "Main", script: "src/Calc.ssl" }],
							tests: { script: "tests/TestCalc.ssl" },
						},
					},
					null,
					2,
				),
			);

			// >64 KB SQL schema file (table defined past 70 KB!)
			const paddingComment = `-- ${"x".repeat(100)}\n`.repeat(720);
			writeFileSync(
				join(dir, "schema", "database", "large.sql"),
				`${paddingComment}CREATE TABLE dbo.LATE_TABLE_PAST_64K (ID INT PRIMARY KEY);\n`,
			);
			// >64 KB Markdown doc (task & link defined past 70 KB!)
			const mdPadding = `${"Filler prose paragraph. ".repeat(5)}\n\n`.repeat(650);
			writeFileSync(
				join(dir, "docs", "specs", "LargeSpec.md"),
				`---\ntitle: Large Spec\n---\n# Large Spec\n\n${mdPadding}- [ ] Deep task past 64KB\n\n[MissingDeep](../specs/NoSuchDeep.md)\n`,
			);

			const ws = new WorkspaceFiles(dir);
			const proj = await readProject(dir);

			// linksTo for src/Calc.ssl finds plan (targets, scripts, built.units[].script) and registry (files.csv)
			const calcLinks = await linksTo(ws, join(dir, "src", "Calc.ssl"));
			expect(calcLinks.filter((l) => l.kind === "plan").length).toBeGreaterThanOrEqual(3);
			expect(calcLinks.some((l) => l.kind === "registry" && l.path.endsWith("files.csv"))).toBe(true);

			// linksTo for tests/TestCalc.ssl finds built.tests.script & testScripts in plan
			const testLinks = await linksTo(ws, join(dir, "tests", "TestCalc.ssl"));
			expect(testLinks.filter((l) => l.kind === "plan").length).toBe(2);

			// linksTo for docs/specs/Due-soon-report.md finds code comment (ignoring runtime string!), plan, registry, and SKIPS exports/
			const specLinks = await linksTo(ws, join(dir, "docs", "specs", "Due-soon-report.md"));
			expect(specLinks.some((l) => l.path.includes("exports"))).toBe(false);
			expect(specLinks.filter((l) => l.kind === "code")).toHaveLength(1);
			expect(specLinks.find((l) => l.kind === "code")?.line).toBe(1);
			expect(specLinks.some((l) => l.kind === "registry")).toBe(true);
			expect(specLinks.some((l) => l.kind === "plan")).toBe(true);

			// namesIn skips exports/
			const allNames = await namesIn(ws);
			expect(allNames.some((n) => n.path.includes("exports"))).toBe(false);

			// listDocs reads >64KB SQL & Markdown, parses governance/test-run fields, and suggests wikilink mends
			const docs = await listDocs(ws, proj);
			const largeSql = docs.find((d) => d.name.endsWith("large.sql"))!;
			expect(largeSql.schemaObjects).toContain("LATE_TABLE_PAST_64K");

			const largeSpec = docs.find((d) => d.name === "LargeSpec.md")!;
			expect(largeSpec.tasks).toEqual({ done: 0, total: 1 });
			expect(largeSpec.broken?.some((b) => b.href.includes("NoSuchDeep.md"))).toBe(true);

			const reportDoc = docs.find((d) => d.name === "Due-soon-report.md")!;
			expect(reportDoc.effectiveDate).toBe("2026-11-01");
			expect(reportDoc.reviewDue).toBe("2027-11-01");

			const testRun = docs.find((d) => d.name.endsWith("TR-01.md"))!;
			expect(testRun.docKind).toBe("test-run");
			expect(testRun.asked).toBe("2026-11-10");
			expect(testRun.date).toBe("2026-11-12");
			const typoWiki = testRun.broken?.find((b) => b.href === "[[Due-soon-repot]]");
			expect(typoWiki?.instead).toBe("Due-soon-report");
			// Applying the mend with `withNames` cleanly fixes the wikilink
			const trText = readFileSync(testRun.path, "utf8");
			const mended = withNames(trText, [{ line: typoWiki!.line, column: typoWiki!.column, name: "Due-soon-repot", instead: typoWiki!.instead! }]);
			expect(mended.done).toBe(1);
			expect(mended.text).toContain("[[Due-soon-report]]");
			// Ticket key DEMO-999 must NOT get a bogus fuzzy suggestion
			expect(testRun.broken?.find((b) => b.href === "[[DEMO-999]]")?.instead).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("deterministic under() cap keeps numeric-sorted prefix, raises schema/ cap to 2000, and docsTruncated reports exact total", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-r6-cap-"));
		try {
			mkdirSync(join(dir, ".ssl-studio"), { recursive: true });
			mkdirSync(join(dir, "docs", "specs"), { recursive: true });
			mkdirSync(join(dir, "schema", "database"), { recursive: true });
			writeFileSync(join(dir, ".ssl-studio", "project.toml"), 'name = "CapDemo"\n');

			for (let i = 1; i <= DOC_LIMIT + 5; i++) {
				writeFileSync(join(dir, "docs", "specs", `s-${i}.md`), `# S ${i}\n`);
			}
			// 510 schema files must NOT truncate because SCHEMA_DOC_LIMIT = 2000
			for (let i = 1; i <= 510; i++) {
				writeFileSync(join(dir, "schema", "database", `T_${i}.sql`), `CREATE TABLE T_${i} (ID INT);\n`);
			}

			const ws = new WorkspaceFiles(dir);
			const proj = await readProject(dir);
			expect(SCHEMA_DOC_LIMIT).toBe(2000);

			const trunc = docsTruncated(ws, proj);
			expect(trunc).toEqual([{ folder: "docs/specs", limit: 500, total: 505 }]);

			const docs = await listDocs(ws, proj);
			const specs = docs.filter((d) => d.group === "specs");
			expect(specs).toHaveLength(500);
			expect(specs[0]!.name).toBe("s-1.md");
			expect(specs[1]!.name).toBe("s-2.md");
			expect(specs[499]!.name).toBe("s-500.md");

			const schemas = docs.filter((d) => d.group === "schema");
			expect(schemas).toHaveLength(510);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Wave 1.1 — Safe document imports (conflict modes, image dedup, Windows-1252 HTML & inline data URLs)", () => {
	test("importDocFile and importDocxBytes handle prompt/copy/overwrite, deduplicate images, and extract HTML data URLs", async () => {
		const wsDir = mkdtempSync(join(tmpdir(), "ssl-studio-r6-imp-ws-"));
		const srcDir = mkdtempSync(join(tmpdir(), "ssl-studio-r6-imp-src-"));
		const host: Host = {
			emit: () => {},
			pick: async () => null,
			trash: async () => {},
			app: "test",
			kind: "app",
			quit: () => {},
		};
		const backend = createBackend(host, wsDir);
		await backend.ready;
		try {
			const destDir = join(wsDir, "docs", "notes");
			const attachDir = join(wsDir, "docs", "attachments");
			mkdirSync(destDir, { recursive: true });
			mkdirSync(attachDir, { recursive: true });

			// 1. Windows-1252 HTML with inline base64 PNG data URL
			const htmlPath = join(srcDir, "LabReport.html");
			const win1252Prefix = Buffer.from("<h1>Caf", "ascii");
			const eAcute = Buffer.from([0xe9]); // Windows-1252 'é'
			const htmlRest = Buffer.from(
				` Report</h1><p><img alt="Chart" src="data:image/png;base64,${TINY_PNG_B64}"></p>`,
				"ascii",
			);
			writeFileSync(htmlPath, Buffer.concat([win1252Prefix, eAcute, htmlRest]));

			const firstHtml = (await backend.api.importDocFile({ sourcePath: htmlPath, destDir, attachmentsDir: attachDir }))!;
			expect(firstHtml.kind).toBe("html");
			expect(firstHtml.path).toBe(join(destDir, "LabReport.md"));
			expect(firstHtml.images).toHaveLength(1);
			expect(existsSync(firstHtml.images[0]!)).toBe(true);
			const md1 = readFileSync(firstHtml.path, "utf8");
			expect(md1).toContain("Café Report");
			expect(md1).toContain(`![Chart](../attachments/${basename(firstHtml.images[0]!)})`);
			expect(md1).not.toContain("data:image/png");

			// 2. Conflict prompt returns conflict: true without overwriting or extracting duplicate images
			const prompted = (await backend.api.importDocFile({
				sourcePath: htmlPath,
				destDir,
				attachmentsDir: attachDir,
				onConflict: "prompt",
			}))!;
			expect(prompted).toMatchObject({ conflict: true, existingPath: firstHtml.path, kind: "html", images: [] });

			// 3. Default onConflict ("copy") reserves -2 filename AND deduplicates image filename (-2)
			const copied = (await backend.api.importDocFile({ sourcePath: htmlPath, destDir, attachmentsDir: attachDir }))!;
			expect(copied.path).toBe(join(destDir, "LabReport-2.md"));
			expect(copied.images[0]).not.toBe(firstHtml.images[0]);
			expect(basename(copied.images[0]!)).toMatch(/-2\.png$/);

			// 4. Overwrite snapshots previous content in local history first
			writeFileSync(firstHtml.path, "# Original Hand Edits\n");
			const overwritten = (await backend.api.importDocFile({
				sourcePath: htmlPath,
				destDir,
				attachmentsDir: attachDir,
				onConflict: "overwrite",
			}))!;
			expect(overwritten.path).toBe(firstHtml.path);
			const snaps = await backend.api.history(firstHtml.path);
			expect(snaps.length).toBeGreaterThanOrEqual(1);
			const snapText = await backend.api.snapshot(firstHtml.path, snaps[0]!.id);
			expect(snapText).toBe("# Original Hand Edits\n");

			// 5. importDocxBytes defaults to "copy" (never silently clobbers) & deduplicates embedded images
			const pngFile = join(wsDir, "docs", "attachments", "seed.png");
			writeFileSync(pngFile, Buffer.from(TINY_PNG_B64, "base64"));
			const docxBytes = markdownToDocx({
				title: "Packet",
				markdown: "# Packet\n\n![Seed](seed.png)\n",
				baseDir: attachDir,
				workspaceRoot: wsDir,
			});
			const b64 = Buffer.from(docxBytes).toString("base64");
			const d1 = await backend.api.importDocxBytes({ fileName: "Packet.docx", base64: b64, destDir, attachmentsDir: attachDir });
			const d2 = await backend.api.importDocxBytes({ fileName: "Packet.docx", base64: b64, destDir, attachmentsDir: attachDir });
			expect(d1.path).toBe(join(destDir, "Packet.md"));
			expect(d2.path).toBe(join(destDir, "Packet-2.md"));
			if (d1.images.length && d2.images.length) {
				expect(d2.images[0]).not.toBe(d1.images[0]);
			}
		} finally {
			backend.dispose();
			rmSync(wsDir, { recursive: true, force: true });
			rmSync(srcDir, { recursive: true, force: true });
		}
	});
});

const hasGit = Bun.spawnSync(["git", "--version"]).exitCode === 0;
const gitCfgDir = mkdtempSync(join(tmpdir(), "ssl-studio-r6-gitcfg-"));
const gitCfg = join(gitCfgDir, "config");
writeFileSync(gitCfg, "");
const gitIdentity = {
	GIT_AUTHOR_NAME: "Lab Dev",
	GIT_AUTHOR_EMAIL: "lab@example.test",
	GIT_COMMITTER_NAME: "Lab Dev",
	GIT_COMMITTER_EMAIL: "lab@example.test",
	GIT_CONFIG_GLOBAL: gitCfg,
	GIT_CONFIG_NOSYSTEM: "1",
};
const prevGitEnv = Object.fromEntries(Object.keys(gitIdentity).map((k) => [k, process.env[k]]));
beforeAll(() => void Object.assign(process.env, gitIdentity));
afterAll(() => {
	for (const [k, v] of Object.entries(prevGitEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(gitCfgDir, { recursive: true, force: true });
});

describe.skipIf(!hasGit)("Wave 4.4 — Git blameLine, branches, checkout & stash", () => {
	test("supports single-line blame with ticket extraction, local branches, checkout, and stash push/list/pop", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-r6-git-"));
		const runGit = (...args: string[]) => {
			const res = Bun.spawnSync(["git", "-C", root, ...args], { env: { ...process.env, ...gitIdentity } });
			if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
		};
		try {
			runGit("init", "-q");
			runGit("symbolic-ref", "HEAD", "refs/heads/main");
			runGit("config", "core.autocrlf", "false");
			runGit("config", "commit.gpgsign", "false");

			const file = join(root, "Rule.ssl");
			writeFileSync(file, ":DECLARE nDays := 5;\n:RETURN nDays;\n");
			const git = new Git(root);
			await git.stage([file]);
			await git.commit("LIMS-42: Add default turnaround rule");

			// Blame line 1
			const blame = await git.blameLine(file, 1);
			expect(blame).not.toBeNull();
			expect(blame!.shortSha).toHaveLength(7);
			expect(blame!.author).toBe("Lab Dev");
			expect(blame!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(blame!.summary).toBe("LIMS-42: Add default turnaround rule");
			expect(blame!.ticket).toBe("LIMS-42");

			// Branches & checkout
			runGit("branch", "feature/lims-42");
			const br1 = (await git.branches())!;
			expect(br1.current).toBe("main");
			expect(br1.branches.map((b) => b.name)).toContain("feature/lims-42");

			const badCo = await git.checkout("--detach");
			expect(badCo.ok).toBe(false);
			const missingCo = await git.checkout("no-such-branch");
			expect(missingCo.ok).toBe(false);

			const goodCo = await git.checkout("feature/lims-42");
			expect(goodCo.ok).toBe(true);
			expect((await git.branches())!.current).toBe("feature/lims-42");

			// Stash push / list / pop
			expect((await git.stash("push")).ok).toBe(false); // clean tree
			writeFileSync(file, ":DECLARE nDays := 10;\n:RETURN nDays;\n");
			const pushed = await git.stash("push", "WIP turnaround");
			expect(pushed.ok).toBe(true);
			expect(readFileSync(file, "utf8")).toContain("nDays := 5");

			const listed = await git.stash("list");
			expect(listed.ok).toBe(true);
			expect(listed.entries?.length).toBe(1);
			expect(listed.entries?.[0]?.message).toContain("WIP turnaround");

			const popped = await git.stash("pop");
			expect(popped.ok).toBe(true);
			expect(readFileSync(file, "utf8")).toContain("nDays := 10");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
