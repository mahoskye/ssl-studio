import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docAudit, linksTo, listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { docChecks, findDuplicateHeadings, orphanDocChecks, staleDocChecks } from "../src/shared/docChecks";
import type { DocFile } from "../src/shared/protocol";
import { findUndocumentedSqlRefs } from "../src/shared/schemaIndex";
import {
	diffSqlAgainstSchemaMarkdown,
	extractQueriedTablesFromSql,
	generateMermaidErDiagram,
	mergeSqlTablesIntoMarkdown,
	parseCreateTables,
} from "../src/shared/sqlSchema";
import { docsGoverningFile, scriptsForTicket, ticketsForFile, ticketWork } from "../src/shared/workContext";

describe("SQL DDL parsing: ALTER DROP/ALTER/MODIFY and FOREIGN KEYs", () => {
	test("applies ALTER TABLE DROP COLUMN, T-SQL ALTER COLUMN, Oracle MODIFY, and inline/table FKs in order", () => {
		const sql = `
CREATE TABLE dbo.FOLDERS (
    FOLDERNO VARCHAR(20) NOT NULL PRIMARY KEY,
    STATUS VARCHAR(10) NOT NULL,
    LEGACY_COL VARCHAR(50),
    TEMP_FLAG CHAR(1)
);

CREATE TABLE dbo.ORDERS (
    ORDNO VARCHAR(20) NOT NULL,
    FOLDERNO VARCHAR(20) NOT NULL REFERENCES dbo.FOLDERS(FOLDERNO),
    TESTCODE VARCHAR(30),
    AMOUNT NUMBER(10, 2),
    CONSTRAINT PK_ORDERS PRIMARY KEY (ORDNO),
    CONSTRAINT FK_ORDERS_TEST FOREIGN KEY (TESTCODE) REFERENCES dbo.TESTS(TESTCODE)
);

-- T-SQL column alteration and drop (must ignore DROP CONSTRAINT)
ALTER TABLE dbo.FOLDERS ALTER COLUMN STATUS VARCHAR(25) NULL;
ALTER TABLE dbo.FOLDERS DROP CONSTRAINT DF_FOLDERS_STATUS;
ALTER TABLE dbo.FOLDERS DROP COLUMN LEGACY_COL;
ALTER TABLE dbo.FOLDERS DROP COLUMN IF EXISTS TEMP_FLAG;
ALTER TABLE dbo.FOLDERS ADD PRIORITY VARCHAR(10) NOT NULL;

-- Oracle parenthesized and standalone MODIFY, plus Oracle DROP (col)
ALTER TABLE dbo.ORDERS MODIFY (
    AMOUNT NUMBER(14, 4) NOT NULL,
    TESTCODE VARCHAR2(40)
);
ALTER TABLE dbo.ORDERS MODIFY ORDNO VARCHAR2(30) NOT NULL;
ALTER TABLE dbo.ORDERS ADD CLIENT_ID INT;
ALTER TABLE dbo.ORDERS ADD CONSTRAINT FK_ORD_CLIENT FOREIGN KEY (CLIENT_ID) REFERENCES dbo.CLIENTS(ID);
`;
		const tables = parseCreateTables(sql);
		expect(tables.map((t) => t.tableName)).toEqual(["FOLDERS", "ORDERS"]);

		const folders = tables[0]!;
		expect(folders.columns.map((c) => c.name)).toEqual(["FOLDERNO", "STATUS", "PRIORITY"]);
		const statusCol = folders.columns.find((c) => c.name === "STATUS")!;
		expect(statusCol.type).toBe("VARCHAR(25)");
		expect(statusCol.constraints).toBe("NULL");

		const orders = tables[1]!;
		expect(orders.columns.find((c) => c.name === "AMOUNT")?.type).toBe("NUMBER(14, 4)");
		expect(orders.columns.find((c) => c.name === "AMOUNT")?.constraints).toBe("NOT NULL");
		expect(orders.columns.find((c) => c.name === "TESTCODE")?.type).toBe("VARCHAR2(40)");
		expect(orders.columns.find((c) => c.name === "ORDNO")?.type).toBe("VARCHAR2(30)");
		expect(orders.foreignKeys).toEqual([
			{ column: "FOLDERNO", refTable: "FOLDERS", refColumn: "FOLDERNO" },
			{ column: "TESTCODE", refTable: "TESTS", refColumn: "TESTCODE" },
			{ column: "CLIENT_ID", refTable: "CLIENTS", refColumn: "ID" },
		]);
	});

	test("drops FK entries when their column is dropped via Oracle DROP (col)", () => {
		const sql = `
CREATE TABLE ITEMS (
    ID INT PRIMARY KEY,
    PARENT_ID INT REFERENCES PARENTS(ID),
    NOTE VARCHAR2(50)
);
ALTER TABLE ITEMS DROP (PARENT_ID);
`;
		const [items] = parseCreateTables(sql);
		expect(items!.columns.map((c) => c.name)).toEqual(["ID", "NOTE"]);
		expect(items!.foreignKeys).toBeUndefined();
	});
});

describe("Schema drift diff, non-destructive merge, and Mermaid ER generation", () => {
	test("diffSqlAgainstSchemaMarkdown reports added, modified, and dropped columns, and clears after merge sync", () => {
		const sql = `
CREATE TABLE DEMO_SAMPLES (
    SAMPLE_ID VARCHAR(20) NOT NULL PRIMARY KEY,
    PRIORITY VARCHAR(20) NOT NULL,
    DUE_ON DATE,
    RUSH_FLAG CHAR(1) NOT NULL
);
ALTER TABLE DEMO_SAMPLES DROP COLUMN DUE_ON;
`;
		const schemaMd = [
			"---",
			"title: DEMO_SAMPLES",
			"source: schema/database/demo.sql",
			"---",
			"",
			"## DEMO_SAMPLES",
			"",
			"| Column | Type | Constraints | Notes |",
			"| --- | --- | --- | --- |",
			"| `SAMPLE_ID` | `VARCHAR(20)` | NOT NULL PRIMARY KEY | Primary key |",
			"| `PRIORITY` | `VARCHAR(10)` | NOT NULL | Hand-written priority note |",
			"| `DUE_ON` | `DATE` | — | Legacy calculated date |",
			"",
		].join("\n");

		const drift = diffSqlAgainstSchemaMarkdown(sql, schemaMd);
		expect(drift).toEqual([
			{
				table: "DEMO_SAMPLES",
				added: ["RUSH_FLAG"],
				modified: ["PRIORITY"],
				dropped: ["DUE_ON"],
			},
		]);

		const tables = parseCreateTables(sql);
		const merged = mergeSqlTablesIntoMarkdown(schemaMd, tables, "schema/database/demo.sql");
		expect(merged.addedColumns).toBe(1);
		expect(merged.updatedColumns).toBe(1);
		expect(merged.droppedColumns).toBe(1);
		expect(merged.text).toContain("Hand-written priority note");
		expect(merged.text).toContain("Legacy calculated date [deprecated / dropped in SQL]");
		expect(merged.text).toContain("`RUSH_FLAG`");

		// Re-running drift check after merge reports zero drift because dropped row is acknowledged
		expect(diffSqlAgainstSchemaMarkdown(sql, merged.text)).toEqual([]);
		// Re-running merge is idempotent (droppedColumns = 0)
		const second = mergeSqlTablesIntoMarkdown(merged.text, tables, "schema/database/demo.sql");
		expect(second.droppedColumns).toBe(0);
		expect(second.text).toBe(merged.text);
	});

	test("generateMermaidErDiagram emits entities, PK/FK flags, sanitized types, and FK edges", () => {
		const sql = `
CREATE TABLE FOLDERS (
    FOLDERNO VARCHAR(20) NOT NULL PRIMARY KEY,
    AMOUNT NUMBER(10, 2)
);
CREATE TABLE ORDERS (
    ORDNO VARCHAR(20) NOT NULL PRIMARY KEY,
    FOLDERNO VARCHAR(20) NOT NULL REFERENCES FOLDERS(FOLDERNO),
    SAMPLE_CODE VARCHAR(30) UNIQUE
);
`;
		const er = generateMermaidErDiagram(parseCreateTables(sql));
		expect(er).toContain("```mermaid");
		expect(er).toContain("erDiagram");
		expect(er).toContain("VARCHAR(20) FOLDERNO PK");
		expect(er).toContain("NUMBER(10_2) AMOUNT");
		expect(er).toContain("VARCHAR(20) FOLDERNO FK");
		expect(er).toContain("VARCHAR(30) SAMPLE_CODE UK");
		expect(er).toContain('FOLDERS ||--o{ ORDERS : "FOLDERNO"');
	});
});

describe("SQL / .ds queried table extraction and undocumented table detection", () => {
	test("extractQueriedTablesFromSql extracts FROM/JOIN/INTO/UPDATE and skips CTEs, #temp, comments, keywords, and sys tables", () => {
		const sql = `
-- Comment mentioning FROM FAKE_COMMENT_TABLE
/* Block comment JOIN FAKE_BLOCK_TABLE */
WITH active_folders AS (
    SELECT FOLDERNO FROM dbo.FOLDERS
),
rush_summary AS (
    SELECT FOLDERNO FROM active_folders
)
SELECT f.FOLDERNO, EXTRACT(DAY FROM f.CREATED_ON) AS d
FROM rush_summary r
JOIN dbo.ORDERS o ON o.FOLDERNO = r.FOLDERNO
LEFT JOIN #TEMP_BATCHES tb ON tb.ID = o.ORDNO
JOIN sys.tables st ON st.name = o.ORDNO
WHERE EXISTS (SELECT 1 FROM DUAL)
FOR UPDATE;

INSERT INTO AUDIT_LOG (MSG) VALUES ('FROM NOT_A_TABLE');
UPDATE DEMO_SAMPLES SET PRIORITY = 'RUSH' WHERE SAMPLE_ID = 'S-1';
`;
		const refs = extractQueriedTablesFromSql(sql);
		expect(refs.map((r) => r.object)).toEqual(["FOLDERS", "ORDERS", "AUDIT_LOG", "DEMO_SAMPLES"]);
		expect(refs.find((r) => r.object === "FOLDERS")?.line).toBe(5);
		expect(refs.find((r) => r.object === "ORDERS")?.line).toBe(12);
		expect(refs.find((r) => r.object === "AUDIT_LOG")?.line).toBe(18);
		expect(refs.find((r) => r.object === "DEMO_SAMPLES")?.line).toBe(19);
	});

	test("extractQueriedTablesFromSql handles STARLIMS SSL .ds Data Sources without false hits in /* ... ; comments", () => {
		const ds = [
			"/* =========================================================================;",
			"/* PURPOSE: Pull samples from a date window and join with legacy notes;",
			"/* =========================================================================;",
			":PARAMETERS dFrom := NIL;",
			':RETURN SQLExecute("',
			"    SELECT s.SAMPLE_ID, l.NOTE",
			"    FROM DEMO_SAMPLES s",
			"    JOIN LEGACY_SAMPLE_NOTES l ON l.SAMPLE_ID = s.SAMPLE_ID",
			"    WHERE s.DUE_ON >= ?dFrom?",
			'");',
		].join("\n");

		const refs = extractQueriedTablesFromSql(ds);
		expect(refs).toEqual([
			{ object: "DEMO_SAMPLES", line: 7 },
			{ object: "LEGACY_SAMPLE_NOTES", line: 8 },
		]);

		const undoc = findUndocumentedSqlRefs(
			[{ path: "/ws/src/DueDates/SamplesDueSoon.ds", text: ds }],
			new Set(["dbo.DEMO_SAMPLES"]),
		);
		expect(undoc).toEqual([
			{ path: "/ws/src/DueDates/SamplesDueSoon.ds", line: 8, object: "LEGACY_SAMPLE_NOTES", kind: "table" },
		]);
	});
});

describe("Duplicate headings, orphan docs, stale hygiene checks, and workContext test linking", () => {
	test("findDuplicateHeadings flags duplicates outside fences and frontmatter on LF and CRLF", () => {
		const md = [
			"---",
			"title: Spec",
			"---",
			"# Overview",
			"",
			"## Rules",
			"",
			"```md",
			"## Rules",
			"```",
			"",
			"## Details",
			"",
			"### Rules",
		].join("\r\n");

		expect(findDuplicateHeadings(md)).toEqual([{ heading: "Rules", line: 14, firstLine: 6 }]);
	});

	test("orphanDocChecks flags unreferenced knowledge, schema, and docs files while skipping linked/reserved docs", () => {
		const files: DocFile[] = [
			{ path: "/ws/README.md", name: "README.md", group: "project", exists: true },
			{ path: "/ws/docs/STATE.md", name: "STATE.md", group: "project", exists: true },
			{ path: "/ws/docs/knowledge/INDEX.md", name: "INDEX.md", group: "knowledge", exists: true, catalog: { stale: false } },
			{ path: "/ws/docs/knowledge/reference/orphan-note.md", name: "reference/orphan-note.md", group: "knowledge", kind: "reference", exists: true, title: "Orphan Note" },
			{ path: "/ws/docs/knowledge/reference/linked-note.md", name: "reference/linked-note.md", group: "knowledge", kind: "reference", exists: true, title: "Linked Note" },
			{ path: "/ws/docs/knowledge/decisions/0001-linked.md", name: "decisions/0001-linked.md", group: "knowledge", kind: "decisions", exists: true, tickets: ["T-1"] },
			{ path: "/ws/schema/database/ORPHAN_TBL.md", name: "database/ORPHAN_TBL.md", group: "schema", kind: "database", exists: true, title: "ORPHAN_TBL" },
			{ path: "/ws/docs/stray-guide.md", name: "stray-guide.md", group: "docs", exists: true, heading: "Stray Guide" },
			{ path: "/ws/docs/knowledge/reference/archive/old.md", name: "reference/archive/old.md", group: "knowledge", kind: "reference", exists: true },
		];

		const incoming = new Set(["/ws/docs/knowledge/reference/linked-note.md"]);
		const orphans = orphanDocChecks(files, incoming, { root: "/ws" });
		expect(orphans.map((o) => o.path)).toEqual([
			"/ws/docs/knowledge/reference/orphan-note.md",
			"/ws/schema/database/ORPHAN_TBL.md",
			"/ws/docs/stray-guide.md",
		]);
		expect(orphans.every((o) => o.kind === "orphan" && o.level === "note")).toBe(true);

		// Calling docChecks without incomingLinks preserves backwards-compatible behavior
		expect(docChecks(files).some((c) => c.text.includes("Unreferenced"))).toBe(false);
		// Passing incomingLinks enables orphan checks in docChecks as well
		expect(docChecks(files, undefined, { incomingLinks: incoming, root: "/ws" }).some((c) => c.text.includes("Orphan Note"))).toBe(true);
	});

	test("staleDocChecks flags aged templates (>7d), old open questions (>30d), stale STATE.md (>14d), and unapproved controlled docs", () => {
		const DAY = 24 * 60 * 60 * 1000;
		const now = Date.UTC(2026, 10, 23, 12, 0, 0);
		const docs: DocFile[] = [
			{ path: "/ws/docs/specs/fresh-tpl.md", name: "fresh-tpl.md", group: "specs", exists: true, untouched: true, mtime: now - 3 * DAY },
			{ path: "/ws/docs/specs/old-tpl.md", name: "old-tpl.md", group: "specs", exists: true, title: "Old Spec", untouched: true, mtime: now - 10 * DAY },
			{ path: "/ws/docs/knowledge/questions/q-old.md", name: "questions/q-old.md", group: "knowledge", kind: "questions", exists: true, title: "Cutoff time?", status: "open", mtime: now - 35 * DAY },
			{ path: "/ws/docs/knowledge/questions/q-done.md", name: "questions/q-done.md", group: "knowledge", kind: "questions", exists: true, title: "Answered", status: "answered", mtime: now - 60 * DAY },
			{ path: "/ws/docs/STATE.md", name: "STATE.md", group: "project", exists: true, mtime: now - 20 * DAY },
			{ path: "/ws/docs/specs/gxp-unapproved.md", name: "gxp-unapproved.md", group: "specs", exists: true, title: "GxP Spec", version: "1.0", gxpImpact: "high", mtime: now - 1 * DAY },
			{ path: "/ws/docs/specs/gxp-approved.md", name: "gxp-approved.md", group: "specs", exists: true, title: "Approved Spec", version: "1.0", approvedBy: "QA Lead", approvedDate: "2026-11-20", mtime: now - 1 * DAY },
		];

		const stale = staleDocChecks(docs, now);
		expect(stale.map((s) => s.path)).toEqual([
			"/ws/docs/specs/old-tpl.md",
			"/ws/docs/knowledge/questions/q-old.md",
			"/ws/docs/STATE.md",
			"/ws/docs/specs/gxp-unapproved.md",
		]);
		expect(stale.every((s) => s.kind === "stale" && s.level === "note")).toBe(true);
		expect(stale[3]!.message).toContain("approved-by and approved-date");
	});

	test("workContext surfaces plan testScripts & planTests in ticketWork and resolves tests/*.ssl in docsGoverningFile", () => {
		const files: DocFile[] = [
			{ path: "/ws/README.md", name: "README.md", group: "project", exists: true },
			{ path: "/ws/docs/tickets/LIMS-42.md", name: "LIMS-42.md", group: "tickets", exists: true, ticket: "LIMS-42", title: "Rush due dates", status: "in progress" },
			{
				path: "/ws/design/DueDates.plan.json",
				name: "DueDates.plan.json",
				group: "plans",
				exists: true,
				tickets: ["LIMS-42"],
				codeRefs: ["src/DueDates/SetDue.ssl"],
				testScripts: ["tests/TestDueDates.ssl"],
				planTests: [
					{ name: "Skips weekend", given: "Friday receipt", expect: "Monday due date" },
					{ name: "Skips holiday", given: "Lab closed", expect: "Next business day" },
				],
			},
			{ path: "/ws/design/DueDates.spec.md", name: "design/DueDates.spec.md", group: "specs", exists: true, tickets: ["LIMS-42"] },
		];

		const groups = ticketWork(files, "LIMS-42");
		const testGroup = groups.find((g) => g.kind === "test");
		expect(testGroup).toBeDefined();
		expect(testGroup!.name).toBe("Tests");
		expect(testGroup!.files[0]!.path).toBe("/ws/tests/TestDueDates.ssl");
		expect(testGroup!.items[0]!.reason).toContain("2 cases");

		const gov = docsGoverningFile(files, "/ws/tests/TestDueDates.ssl", "/ws");
		expect(gov.map((g) => [g.file.group, g.reason])).toEqual([
			["plans", "plan test script"],
			["specs", "paired spec"],
			["tickets", "governing ticket"],
		]);
		expect(ticketsForFile(files, "/ws/tests/TestDueDates.ssl", "/ws")).toEqual(["LIMS-42"]);
		expect(scriptsForTicket(files, "LIMS-42")).toContain("tests/TestDueDates.ssl");
	});
});

describe("Backend project.ts integration: metadata, plan linksTo, schema drift, undocumented refs, and truncation", () => {
	test("listDocs, linksTo, and docAudit extract Round 5 metadata, plan links, drift, duplicate headings, and undocumented SQL refs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-r5-"));
		try {
			mkdirSync(join(dir, ".ssl-studio"), { recursive: true });
			mkdirSync(join(dir, "docs", "tickets"), { recursive: true });
			mkdirSync(join(dir, "docs", "specs"), { recursive: true });
			mkdirSync(join(dir, "docs", "registries"), { recursive: true });
			mkdirSync(join(dir, "schema", "database"), { recursive: true });
			mkdirSync(join(dir, "design"), { recursive: true });
			mkdirSync(join(dir, "src"), { recursive: true });
			mkdirSync(join(dir, "tests"), { recursive: true });

			writeFileSync(join(dir, ".ssl-studio", "project.toml"), 'name = "Round5Demo"\n');
			writeFileSync(
				join(dir, "docs", "tickets", "LIMS-10.md"),
				[
					"---",
					"ticket: LIMS-10",
					"title: Validate calibration",
					"status: in progress",
					"release: R2026.12",
					"priority: high",
					"owner: Lab Eng",
					"reviewer: QA Lead",
					"version: 1.0",
					"change-control: CR-2026-09",
					"gxp-impact: high",
					"---",
					"",
					"# LIMS-10: Validate calibration",
					"",
					"## Acceptance",
					"",
					"Check [Spec](../specs/Calib.md).",
					"",
					"## Acceptance",
					"",
					"Duplicate heading above.",
				].join("\n"),
			);
			writeFileSync(join(dir, "docs", "specs", "Calib.md"), "---\nticket: LIMS-10\n---\n\n# Calibration Spec\n");
			writeFileSync(join(dir, "docs", "STATE.md"), "# State\n\nOld status.\n");
			const oldTime = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000);
			utimesSync(join(dir, "docs", "STATE.md"), oldTime, oldTime);

			writeFileSync(
				join(dir, "schema", "database", "demo.sql"),
				[
					"CREATE TABLE CALIB_RUNS (",
					"  RUN_ID INT PRIMARY KEY,",
					"  STATUS VARCHAR(30) NOT NULL,",
					"  CREATED_AT DATE",
					");",
					"ALTER TABLE CALIB_RUNS DROP COLUMN CREATED_AT;",
				].join("\n"),
			);
			writeFileSync(
				join(dir, "schema", "database", "CALIB_RUNS.md"),
				[
					"---",
					"title: CALIB_RUNS",
					"source: schema/database/demo.sql",
					"---",
					"",
					"## CALIB_RUNS",
					"",
					"| Column | Type | Constraints | Notes |",
					"| --- | --- | --- | --- |",
					"| `RUN_ID` | `INT` | PRIMARY KEY | Key |",
					"| `STATUS` | `VARCHAR(10)` | NOT NULL | Status |",
					"| `CREATED_AT` | `DATE` | — | Timestamp |",
				].join("\n"),
			);
			writeFileSync(join(dir, "docs", "registries", "database.csv"), "object,kind,status\nKNOWN_FROM_REG,table,verified\n");
			writeFileSync(
				join(dir, "src", "LoadCalib.ds"),
				[
					"/* Data source for calibration runs;",
					":PARAMETERS nId := 0;",
					':RETURN SQLExecute("SELECT * FROM CALIB_RUNS JOIN KNOWN_FROM_REG ON 1=1 JOIN MYSTERY_TABLE ON 1=1");',
				].join("\n"),
			);
			writeFileSync(
				join(dir, "design", "Calib.plan.json"),
				JSON.stringify(
					{
						version: 1,
						title: "Calibration Flow",
						ticket: "LIMS-10",
						targets: ["src/LoadCalib.ds"],
						groups: [],
						nodes: [{ id: "n1", kind: "step", text: "Check rules", docs: ["docs/specs/Calib.md"] }],
						edges: [],
						tests: [{ id: "t1", title: "Rejects expired calibration", given: "Expired date", expect: "Error returned" }],
						built: { units: [], nodes: {}, tests: { script: "tests/TestCalib.ssl", hash: "abc" } },
					},
					null,
					2,
				),
			);

			const ws = new WorkspaceFiles(dir);
			const proj = await readProject(dir);
			const docs = await listDocs(ws, proj);

			const t10 = docs.find((d) => d.ticket === "LIMS-10")!;
			expect(t10.release).toBe("R2026.12");
			expect(t10.priority).toBe("high");
			expect(t10.owner).toBe("Lab Eng");
			expect(t10.reviewer).toBe("QA Lead");
			expect(t10.version).toBe("1.0");
			expect(t10.changeControl).toBe("CR-2026-09");
			expect(t10.gxpImpact).toBe("high");
			expect(typeof t10.mtime).toBe("number");
			expect(t10.headings?.map((h) => h.text)).toEqual(["LIMS-10: Validate calibration", "Acceptance", "Acceptance"]);

			const plan = docs.find((d) => d.group === "plans" && d.name === "Calib.plan.json")!;
			expect(plan.testScripts).toEqual(["tests/TestCalib.ssl"]);
			expect(plan.planTests).toEqual([{ name: "Rejects expired calibration", given: "Expired date", expect: "Error returned" }]);
			expect(plan.nodeDocs).toEqual(["src/LoadCalib.ds", "docs/specs/Calib.md"]);

			// linksTo finds .plan.json references (both targets and node.docs) with exact line/column
			const specLinks = await linksTo(ws, join(dir, "docs", "specs", "Calib.md"));
			const planLink = specLinks.find((l) => l.path.endsWith("Calib.plan.json"));
			expect(planLink).toBeDefined();
			expect(planLink!.href).toBe("docs/specs/Calib.md");
			expect(planLink!.line).toBeGreaterThan(1);
			expect(planLink!.column).toBeGreaterThan(0);

			const audit = await docAudit(ws, proj);
			expect(audit.schemaDrift).toEqual([
				{
					schemaPath: join(dir, "schema", "database", "CALIB_RUNS.md"),
					sqlPath: join(dir, "schema", "database", "demo.sql"),
					table: "CALIB_RUNS",
					added: [],
					modified: ["STATUS"],
					dropped: ["CREATED_AT"],
				},
			]);
			expect(audit.issues.some((i) => i.kind === "schema-drift")).toBe(true);
			expect(audit.issues.some((i) => i.kind === "duplicate-heading" && i.path === t10.path)).toBe(true);
			expect(audit.issues.some((i) => i.kind === "stale" && i.path.endsWith("STATE.md"))).toBe(true);
			expect(audit.issues.some((i) => i.kind === "stale" && i.path === t10.path && i.message.includes("approved-by"))).toBe(true);
			expect(audit.undocumentedRefs).toEqual([
				{ path: join(dir, "src", "LoadCalib.ds"), line: 3, object: "MYSTERY_TABLE", kind: "table" },
			]);
			expect(audit.truncatedFolders).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("docAudit reports truncatedFolders when a documentation folder exceeds DOC_LIMIT (500)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-trunc-"));
		try {
			mkdirSync(join(dir, ".ssl-studio"), { recursive: true });
			mkdirSync(join(dir, "docs", "specs"), { recursive: true });
			writeFileSync(join(dir, ".ssl-studio", "project.toml"), 'name = "TruncDemo"\n');
			for (let i = 0; i < 502; i++) {
				writeFileSync(join(dir, "docs", "specs", `spec-${String(i).padStart(4, "0")}.md`), `# Spec ${i}\n`);
			}
			const ws = new WorkspaceFiles(dir);
			const proj = await readProject(dir);
			const audit = await docAudit(ws, proj);
			expect(audit.truncatedFolders).toEqual([{ folder: "docs/specs", limit: 500 }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
