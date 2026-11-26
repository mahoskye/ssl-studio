import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkTables } from "../src/shared/docTables";
import type { DocFile } from "../src/shared/protocol";
import {
	extractSchemaColumns,
	extractSchemaPreview,
	filterSchemaUsageGroups,
	findSchemaDocForIdentifier,
	groupSchemaUsages,
	referencedSchemaTables,
	schemaDocKeys,
} from "../src/shared/schemaIndex";
import { withoutTokens } from "../src/shared/lexicalTokens";
import { schemaList, schemaRowTitle } from "../src/shared/schemaList";
import {
	diffSqlAgainstSchemaMarkdown,
	extractQueriedTablesFromSql,
	extractSqlObjects,
	generateMermaidErDiagram,
	mergeSqlTablesIntoMarkdown,
	parseCreateTables,
	schemaMarkdownToSql,
	sqlTablesToMarkdown,
} from "../src/shared/sqlSchema";

describe("R5C P0-1 — Composite PKs & Composite FKs round-trip", () => {
	test("parses, formats, diffs, and regenerates composite PKs and composite FKs with ON DELETE cleanly", () => {
		const sql = `
CREATE TABLE ORDERS (
    TENANT_ID VARCHAR(20) NOT NULL,
    ORDER_ID  VARCHAR(20) NOT NULL,
    CONSTRAINT PK_ORDERS PRIMARY KEY (TENANT_ID, ORDER_ID)
);

CREATE TABLE ORDER_ITEMS (
    TENANT_ID VARCHAR(20) NOT NULL,
    ORDER_ID  VARCHAR(20) NOT NULL,
    LINE_NO   INT NOT NULL,
    QTY       INT NOT NULL,
    CONSTRAINT PK_ORDER_ITEMS PRIMARY KEY (TENANT_ID, ORDER_ID, LINE_NO),
    CONSTRAINT FK_ITEMS_ORDERS FOREIGN KEY (TENANT_ID, ORDER_ID)
        REFERENCES ORDERS (TENANT_ID, ORDER_ID) ON DELETE CASCADE
);
`;
		const tables = parseCreateTables(sql);
		expect(tables).toHaveLength(2);
		const items = tables[1]!;
		expect(items.foreignKeys).toEqual([
			{
				column: "TENANT_ID, ORDER_ID",
				columns: ["TENANT_ID", "ORDER_ID"],
				refTable: "ORDERS",
				refColumn: "TENANT_ID, ORDER_ID",
				refColumns: ["TENANT_ID", "ORDER_ID"],
				onDelete: "CASCADE",
			},
		]);

		const md = sqlTablesToMarkdown(tables);
		expect(checkTables(md)).toEqual([]);
		expect(md).toContain("| `TENANT_ID`, `ORDER_ID` | `ORDERS` | `TENANT_ID`, `ORDER_ID` | ON DELETE CASCADE |");

		const regenerated = schemaMarkdownToSql(md);
		expect(regenerated).not.toBeNull();
		// Composite PKs emit a single table-level PK constraint and strip inline PRIMARY KEY
		expect(regenerated!.sql).toContain("CONSTRAINT PK_ORDERS PRIMARY KEY (TENANT_ID, ORDER_ID)");
		expect(regenerated!.sql).toContain("CONSTRAINT PK_ORDER_ITEMS PRIMARY KEY (TENANT_ID, ORDER_ID, LINE_NO)");
		expect(regenerated!.sql).not.toMatch(/TENANT_ID\s+VARCHAR\(20\)\s+[^\n]*PRIMARY KEY/);
		// Composite FK emits one table-level FOREIGN KEY with ON DELETE CASCADE
		expect(regenerated!.sql).toContain(
			"CONSTRAINT FK_ORDER_ITEMS_TENANT_ID_ORDER_ID FOREIGN KEY (TENANT_ID, ORDER_ID) REFERENCES ORDERS (TENANT_ID, ORDER_ID) ON DELETE CASCADE",
		);
		expect(diffSqlAgainstSchemaMarkdown(regenerated!.sql, md)).toEqual([]);
		expect(diffSqlAgainstSchemaMarkdown(sql, md)).toEqual([]);
	});

	test("keeps single-column FK shape backward-compatible without columns/refColumns arrays", () => {
		const [tbl] = parseCreateTables(
			"CREATE TABLE CHILD (ID INT PRIMARY KEY, PARENT_ID INT REFERENCES PARENT(ID));",
		);
		expect(tbl!.foreignKeys).toEqual([{ column: "PARENT_ID", refTable: "PARENT", refColumn: "ID" }]);
	});
});

describe("R5C P0-2 — mergeSqlTablesIntoMarkdown data-loss & layout safety", () => {
	test("preserves 3-column layouts (Column/Field/Name + Type + Notes) without erasing Notes", () => {
		const md = [
			"---",
			"# ## ORDERS",
			"title: ORDERS",
			"---",
			"",
			"## ORDERS",
			"",
			"Example inside fence must never be touched:",
			"```markdown",
			"## ORDERS",
			"| Column | Type | Notes |",
			"| --- | --- | --- |",
			"| `FAKE_COL` | `INT` | Fenced note |",
			"```",
			"",
			"| Field | Type | Notes |",
			"| --- | --- | --- |",
			"| `ORDNO` | `VARCHAR(10)` | Hand-written order key |",
			"| `LEGACY` | `INT` | Kept for audits |",
			"",
		].join("\n");

		const tables = parseCreateTables(
			"CREATE TABLE ORDERS (ORDNO VARCHAR(20) NOT NULL PRIMARY KEY, STATUS VARCHAR(15));",
		);
		const merged = mergeSqlTablesIntoMarkdown(md, tables);
		expect(merged.addedColumns).toBe(1);
		expect(merged.updatedColumns).toBe(1);
		expect(merged.droppedColumns).toBe(1);
		// Fenced example untouched
		expect(merged.text).toContain("| `FAKE_COL` | `INT` | Fenced note |");
		// 3-column layout preserved (no 4th column injected) and hand-written notes kept!
		expect(merged.text).toContain("| `ORDNO` | `VARCHAR(20)` | Hand-written order key |");
		expect(merged.text).toContain("| `STATUS` | `VARCHAR(15)` |  |");
		expect(merged.text).toContain("| `LEGACY` | `INT` | Kept for audits [deprecated / dropped in SQL] |");
		expect(merged.text).not.toMatch(/\| `ORDNO` \|[^|\n]*\|[^|\n]*\|[^|\n]*\|/);
	});

	test("matches Name header, respects parenthetical heading scope boundaries, preserves non-default FK/Index layouts, PK in Null col, and subsection prose", () => {
		const md = [
			"## ORDERS (Header records)",
			"",
			"| Name | Type | Null | Notes |",
			"| --- | --- | --- | --- |",
			"| `ORDNO` | varchar(20) | PK | Order identifier |",
			"| `CLIENT_ID` | int | yes | Owner client |",
			"",
			"## Foreign keys",
			"",
			"Hand-written note explaining legacy FK rationale.",
			"",
			"| Column | References | Notes |",
			"| --- | --- | --- |",
			"| `CLIENT_ID` | `CLIENTS(ID)` | Keep this FK note |",
			"",
			"## Indexes",
			"",
			"Hand-written index tuning note.",
			"",
			"| Name | Unique | Columns | Notes |",
			"| --- | --- | --- | --- |",
			"| `IX_ORD_CLIENT` | no | `CLIENT_ID` | Speeds client lookup |",
			"",
			"## ORDER_ITEMS (Line items)",
			"",
			"| Column | Type | Constraints | Notes |",
			"| --- | --- | --- | --- |",
			"| `ITEM_ID` | `INT` | PRIMARY KEY | Line item id |",
			"",
			"## Foreign keys",
			"",
			"| Column | Target table | Target column |",
			"| --- | --- | --- |",
			"| `ITEM_ID` | `ORDERS` | `ORDNO` |",
			"",
		].join("\n");

		// 1. Sync ORDERS keeping FKs/indexes -> preserves PK in Null col, 3-col FK References layout, 4-col Index Notes layout, and never bleeds into ORDER_ITEMS
		const ordersWithFk = parseCreateTables(`
CREATE TABLE ORDERS (
    ORDNO VARCHAR(20) NOT NULL PRIMARY KEY,
    CLIENT_ID INT,
    CONSTRAINT FK_ORD_CLI FOREIGN KEY (CLIENT_ID) REFERENCES CLIENTS (ID)
);
CREATE INDEX IX_ORD_CLIENT ON ORDERS (CLIENT_ID, ORDNO);
`);
		const synced1 = mergeSqlTablesIntoMarkdown(md, ordersWithFk);
		expect(synced1.text).toContain("| `ORDNO` | varchar(20) | PK | Order identifier |");
		expect(synced1.text).toContain("| `CLIENT_ID` | `CLIENTS(ID)` | Keep this FK note |");
		expect(synced1.text).toContain("| `IX_ORD_CLIENT` | no | `CLIENT_ID`, `ORDNO` | Speeds client lookup |");
		// ORDER_ITEMS section untouched
		expect(synced1.text).toContain("## ORDER_ITEMS (Line items)");
		expect(synced1.text).toContain("| `ITEM_ID` | `ORDERS` | `ORDNO` |");

		// 2. Drop FKs and Indexes from ORDERS -> removes stale tables ONLY, preserving hand-written prose!
		const ordersNoFkNoIx = parseCreateTables(`
CREATE TABLE ORDERS (
    ORDNO VARCHAR(20) NOT NULL PRIMARY KEY,
    CLIENT_ID INT
);
`);
		const synced2 = mergeSqlTablesIntoMarkdown(synced1.text, ordersNoFkNoIx);
		expect(synced2.text).toContain("Hand-written note explaining legacy FK rationale.");
		expect(synced2.text).toContain("Hand-written index tuning note.");
		expect(synced2.text).not.toContain("| `CLIENT_ID` | `CLIENTS(ID)`");
		expect(synced2.text).not.toContain("| `IX_ORD_CLIENT` |");
		// ORDER_ITEMS FK still completely intact
		expect(synced2.text).toContain("| `ITEM_ID` | `ORDERS` | `ORDNO` |");
	});

	test("skips tilde fences (~~~) in mergeSqlTablesIntoMarkdown", () => {
		const md = [
			"# DEMO",
			"",
			"~~~md",
			"## DEMO",
			"| Column | Type | Notes |",
			"| --- | --- | --- |",
			"| `IGNORE_ME` | `INT` | Tilde fenced |",
			"~~~",
			"",
			"| Column | Type | Notes |",
			"| --- | --- | --- |",
			"| `ID` | `INT` | Real |",
		].join("\n");
		const res = mergeSqlTablesIntoMarkdown(md, parseCreateTables("CREATE TABLE DEMO (ID INT, CODE VARCHAR(10));"));
		expect(res.text).toContain("| `IGNORE_ME` | `INT` | Tilde fenced |");
		expect(res.text).toContain("| `CODE` | `VARCHAR(10)` |  |");
	});
});

describe("R5C P0-3 — sanitizeSql quoting & nested comments", () => {
	test("handles Oracle Q-quotes, PG dollar quotes, nested block comments, and backtick identifiers", () => {
		const sql = `
/* outer comment /* nested comment */ CREATE TABLE FAKE_NESTED (X INT); */
CREATE PROCEDURE sp_demo AS BEGIN
    EXECUTE IMMEDIATE q'[CREATE TABLE FAKE_Q1 (X INT)]';
    EXECUTE IMMEDIATE Q'(CREATE TABLE FAKE_Q2 (X INT))';
    EXECUTE IMMEDIATE q'!CREATE TABLE FAKE_Q3 (X INT)!';
END;
CREATE FUNCTION pg_fn() RETURNS void AS $body$
    CREATE TABLE FAKE_DOLLAR (X INT);
$body$ LANGUAGE sql;
CREATE FUNCTION pg_fn2() RETURNS void AS $$
    CREATE TABLE FAKE_DOLLAR2 (X INT);
$$ LANGUAGE sql;
CREATE TABLE \`my_db\`.\`order_items\` (
    \`item, id\` INT NOT NULL PRIMARY KEY,
    \`note\` VARCHAR(50) DEFAULT q'(a, b)',
    \`tag\` TEXT DEFAULT $t$x, (y)$t$
);
`;
		const objs = extractSqlObjects(sql);
		expect(objs.map((o) => o.bareName)).toEqual(["sp_demo", "pg_fn", "pg_fn2", "order_items"]);

		const tables = parseCreateTables(sql);
		expect(tables).toHaveLength(1);
		expect(tables[0]!.tableName).toBe("order_items");
		expect(tables[0]!.columns.map((c) => c.name)).toEqual(["item, id", "note", "tag"]);
		expect(tables[0]!.columns[1]!.constraints).toBe("DEFAULT q'(a, b)'");
		expect(tables[0]!.columns[2]!.constraints).toBe("DEFAULT $t$x, (y)$t$");
	});
});

describe("R5C P0-4 & P1-4 — extractQueriedTablesFromSql", () => {
	test("handles SSL string concat with unclosed quotes, + CRLF +, + Chr(13) +, and + var + without swallowing later queries", () => {
		const ssl = [
			':PARAMETERS sCode := "", sId := "";',
			'sSql1 := "SELECT * FROM ORDERS WHERE CODE = \'" + sCode + "\'" + CRLF +',
			'         "JOIN SAMPLES ON SAMPLES.ORDNO = ORDERS.ORDNO " + Chr(13) + Chr(10) +',
			'         "WHERE ORDERS.SITE = \'" + Trim(sSite) + "\'";',
			'sSql2 := "SELECT * FROM PARTIAL_TBL WHERE X = \'" + sId;',
			'sSql3 := "SELECT * FROM AFTER_UNCLOSED WHERE ACTIVE = 1";',
			':RETURN SQLExecute(sSql1);',
		].join("\n");

		const refs = extractQueriedTablesFromSql(ssl);
		expect(refs.map((r) => r.object)).toEqual(["ORDERS", "SAMPLES", "PARTIAL_TBL", "AFTER_UNCLOSED"]);
	});

	test("runs looksLikeSslDs only on comment-stripped text and skips SSL mode when top-level SQL exists", () => {
		const sqlWithSslMentionInComment = `
-- :PARAMETERS x := 1;
/* Invoked via SQLExecute("SELECT * FROM FAKE_IN_COMMENT") */
SELECT * FROM REAL_ORDERS;
`;
		expect(extractQueriedTablesFromSql(sqlWithSslMentionInComment).map((r) => r.object)).toEqual(["REAL_ORDERS"]);

		const sqlWithTopLevelAndProc = `
SELECT * FROM REAL_A;
EXEC RunSQL('SELECT * FROM FAKE_STRING');
SELECT * FROM REAL_B;
`;
		expect(extractQueriedTablesFromSql(sqlWithTopLevelAndProc).map((r) => r.object)).toEqual(["REAL_A", "REAL_B"]);
	});

	test("skips PL/SQL SELECT/RETURNING INTO, REVOKE FROM, nested TRIM/EXTRACT, UPDATE STATISTICS, FOR UPDATE OF; captures MERGE/TOP/ONLY/derived comma joins", () => {
		const sql = `
SELECT col1, TRIM(CHAR(10) FROM COALESCE(s.NAME, '')) AS nm, EXTRACT(DAY FROM CAST(s.DT AS DATE)) AS d
INTO v_col1, v_nm, v_d
FROM ONLY dbo.SAMPLES s;

INSERT TOP (10) INTO AUDIT_ENTRIES (MSG) VALUES ('ok') RETURNING ID INTO v_new_id;
INSERT TOP (5) QUICK_LOG (MSG) VALUES ('hi');

MERGE INTO TARGET_BATCHES t
USING SOURCE_BATCHES s ON t.ID = s.ID
WHEN MATCHED THEN UPDATE SET t.STATUS = s.STATUS;

MERGE ALT_TARGET t
USING ALT_SOURCE s ON t.ID = s.ID
WHEN MATCHED THEN DELETE;

UPDATE TOP (25) PERCENT dbo.PRIORITY_QUEUE SET STATE = 'READY';
UPDATE STATISTICS dbo.PRIORITY_QUEUE;
SELECT * FROM LOCKED_TBL FOR UPDATE OF STATUS;
REVOKE SELECT ON LOCKED_TBL FROM app_role;

SELECT * FROM (SELECT 1 AS x FROM INNER_SUB) sub, COMMA_AFTER_DERIVED c;

UPDATE [u alias]
SET [Price (USD)] = 10
FROM dbo.[Line Items] [u alias]
WHERE [u alias].[Select Item] = 1;
`;
		const objs = extractQueriedTablesFromSql(sql).map((r) => r.object);
		expect(objs).toEqual([
			"SAMPLES",
			"AUDIT_ENTRIES",
			"QUICK_LOG",
			"TARGET_BATCHES",
			"SOURCE_BATCHES",
			"ALT_TARGET",
			"ALT_SOURCE",
			"PRIORITY_QUEUE",
			"LOCKED_TBL",
			"INNER_SUB",
			"COMMA_AFTER_DERIVED",
			"Line Items",
		]);
		expect(objs).not.toContain("v_col1");
		expect(objs).not.toContain("v_new_id");
		expect(objs).not.toContain("app_role");
		expect(objs).not.toContain("STATISTICS");
		expect(objs).not.toContain("OF");
		expect(objs).not.toContain("u alias");
	});
});

describe("R5C P0-5 — generateMermaidErDiagram Mermaid 12 safety", () => {
	test("quotes reserved entity names, escapes PK/FK/UK attributes, prefixes digit types, masks default strings, collapses multi-col FKs, and parses cleanly in Mermaid 12", async () => {
		const sql = `
CREATE TABLE CLASS (
    A INT NOT NULL,
    B INT NOT NULL,
    CONSTRAINT PK_CLASS PRIMARY KEY (A, B)
);
CREATE TABLE END (
    PK INT NOT NULL PRIMARY KEY,
    FK INT DEFAULT 'PRIMARY KEY UNIQUE REFERENCES FAKE(ID)',
    UK VARCHAR(20) UNIQUE,
    GEO [2D_POINT],
    A INT NOT NULL,
    B INT NOT NULL,
    CONSTRAINT FK_END_CLASS FOREIGN KEY (A, B) REFERENCES CLASS (A, B)
);
CREATE TABLE STYLE (
    ID INT PRIMARY KEY,
    ONE_ID INT REFERENCES ONE(ID),
    MANY_ID INT REFERENCES MANY(ID),
    TO_ID INT REFERENCES TO(ID)
);
`;
		const diagram = generateMermaidErDiagram(parseCreateTables(sql));
		expect(diagram).toContain('    "CLASS" {');
		expect(diagram).toContain('    "END" {');
		expect(diagram).toContain('    "STYLE" {');
		expect(diagram).toContain("        INT `PK` PK");
		// Default literal `'PRIMARY KEY UNIQUE REFERENCES FAKE(ID)'` must NOT trigger PK/FK/UK badges!
		expect(diagram).toContain("        INT `FK`\n");
		expect(diagram).toContain("        VARCHAR(20) `UK` UK");
		expect(diagram).toContain("        T_2D_POINT GEO");
		// Composite FK collapsed into ONE labeled edge
		const classToEndEdges = diagram.split("\n").filter((l) => l.includes('"CLASS" ||--o{ "END"'));
		expect(classToEndEdges).toHaveLength(1);
		expect(classToEndEdges[0]).toBe('    "CLASS" ||--o{ "END" : "A, B"');
		expect(diagram).toContain('    "ONE" ||--o{ "STYLE"');
		expect(diagram).toContain('    "MANY" ||--o{ "STYLE"');
		expect(diagram).toContain('    "TO" ||--o{ "STYLE"');

		// Verify Mermaid 12's actual ER parser accepts the generated diagram with zero syntax errors.
		const erBody = diagram.replace(/^```mermaid\n/, "").replace(/\n```$/, "");
		const mermaidChunkDir = join(import.meta.dir, "..", "node_modules", "mermaid", "dist", "chunks", "mermaid.core");
		const [erChunk] = [...new Bun.Glob("erDiagram-*.mjs").scanSync({ cwd: mermaidChunkDir })];
		expect(erChunk).toBeDefined();
		const chunkPath: string = join(mermaidChunkDir, erChunk!);
		const mod: any = await import(chunkPath);
		mod.diagram.db.clear();
		const parser = new mod.diagram.parser.Parser();
		parser.yy = mod.diagram.db;
		expect(() => parser.parse(`${erBody}\n`)).not.toThrow();
		// Thirty seconds, not the five a test has by default. Nearly all of this test's time is Mermaid's parser being
		// read from disk, which takes a third of a second once the files have been read before and took over five
		// in the Windows test VM straight after it had started (2026-11-25): the test timed out with nothing wrong.
	}, 30_000);
});

describe("R5C P1-1 — parseColumnClause edge cases", () => {
	test("keeps KEY/INDEX columns while skipping table-level INDEX/EXCLUDE/LIKE; handles NATIONAL, INTERVAL, PG arrays, nested computed, GENERATED, and SQLite typeless", () => {
		const sql = `
CREATE TABLE COMPLEX_COLS (
    KEY VARCHAR(50) NOT NULL,
    INDEX VARCHAR(20),
    PRICE_KEY NUMBER(10, 2),
    NAT_NAME NATIONAL CHARACTER VARYING(100) NOT NULL,
    CHAR_SEM VARCHAR2(20) CHAR NOT NULL,
    CHAR_SET VARCHAR(20) CHARACTER SET utf8mb4 NOT NULL,
    SPAN INTERVAL DAY(2) TO SECOND(6),
    TAGS TEXT[] NOT NULL,
    FULL_NM AS (COALESCE(NAT_NAME, '') + ' ' + CHAR_SEM) PERSISTED,
    TOTAL AS PRICE_KEY * 2 PERSISTED,
    GEN_VAL VARCHAR(100) GENERATED ALWAYS AS (NAT_NAME || TAGS[1]) STORED,
    F NOT NULL,
    G,
    INDEX ix_key (KEY),
    INDEX ix_nc NONCLUSTERED (INDEX),
    KEY (PRICE_KEY),
    EXCLUDE USING gist (SPAN WITH &&),
    LIKE BASE_TEMPLATE INCLUDING ALL
);
`;
		const [tbl] = parseCreateTables(sql);
		expect(tbl!.columns.map((c) => c.name)).toEqual([
			"KEY",
			"INDEX",
			"PRICE_KEY",
			"NAT_NAME",
			"CHAR_SEM",
			"CHAR_SET",
			"SPAN",
			"TAGS",
			"FULL_NM",
			"TOTAL",
			"GEN_VAL",
			"F",
			"G",
		]);
		const byName = new Map(tbl!.columns.map((c) => [c.name, c]));
		expect(byName.get("KEY")).toEqual({ name: "KEY", type: "VARCHAR(50)", constraints: "NOT NULL" });
		expect(byName.get("INDEX")).toEqual({ name: "INDEX", type: "VARCHAR(20)", constraints: "" });
		expect(byName.get("NAT_NAME")).toEqual({ name: "NAT_NAME", type: "NATIONAL CHARACTER VARYING(100)", constraints: "NOT NULL" });
		expect(byName.get("CHAR_SEM")).toEqual({ name: "CHAR_SEM", type: "VARCHAR2(20) CHAR", constraints: "NOT NULL" });
		expect(byName.get("CHAR_SET")!.type).toBe("VARCHAR(20)");
		expect(byName.get("SPAN")!.type).toBe("INTERVAL DAY(2) TO SECOND(6)");
		expect(byName.get("TAGS")).toEqual({ name: "TAGS", type: "TEXT[]", constraints: "NOT NULL" });
		expect(byName.get("FULL_NM")).toEqual({
			name: "FULL_NM",
			type: "COMPUTED",
			constraints: "AS (COALESCE(NAT_NAME, '') + ' ' + CHAR_SEM) PERSISTED",
		});
		expect(byName.get("TOTAL")).toEqual({ name: "TOTAL", type: "COMPUTED", constraints: "AS PRICE_KEY * 2 PERSISTED" });
		expect(byName.get("GEN_VAL")!.type).toBe("VARCHAR(100)");
		expect(byName.get("GEN_VAL")!.constraints).toContain("GENERATED ALWAYS AS");
		expect(byName.get("F")).toEqual({ name: "F", type: "", constraints: "NOT NULL" });
		expect(byName.get("G")).toEqual({ name: "G", type: "", constraints: "" });
	});
});

describe("R5C P1-2 — Source-order DROP/recreate, ALTER TABLE, indexes, comments & extractSqlObjects", () => {
	test("processes DROP TABLE/recreate, DROP INDEX, chained PG ALTERs, T-SQL ADD DEFAULT rejection, PG SET DEFAULT/SET DATA TYPE, expression indexes, and spaced COMMENT ON COLUMN", () => {
		const sql = `
GRANT CREATE TABLE TO app_user;
REVOKE ALTER PROCEDURE FROM dev_role;
DENY CREATE VIEW TO guest_role;

CREATE TABLE dbo.REBUILT (OLD_COL INT PRIMARY KEY);
CREATE INDEX IX_OLD ON dbo.REBUILT (OLD_COL);
DROP TABLE IF EXISTS dbo.REBUILT;

CREATE TABLE dbo.REBUILT (
    ID INT NOT NULL PRIMARY KEY,
    EMAIL VARCHAR(80) NOT NULL,
    STATUS VARCHAR(10) NOT NULL DEFAULT 'NEW'
);
ALTER TABLE IF EXISTS dbo.REBUILT
    ADD COLUMN CODE VARCHAR(20) NOT NULL,
    ADD COLUMN TEMP_A INT,
    ADD COLUMN TEMP_B INT;
ALTER TABLE dbo.REBUILT ADD DEFAULT 'NEW' FOR STATUS;
ALTER TABLE dbo.REBUILT ADD [DROP FLAG] BIT;
ALTER TABLE IF EXISTS dbo.REBUILT DROP COLUMN TEMP_A, DROP COLUMN IF EXISTS TEMP_B;
ALTER TABLE dbo.REBUILT ALTER COLUMN STATUS SET DEFAULT 'OPEN';
ALTER TABLE dbo.REBUILT ALTER COLUMN STATUS DROP DEFAULT;
ALTER TABLE dbo.REBUILT ALTER COLUMN EMAIL SET DATA TYPE VARCHAR(160);
ALTER TABLE dbo.REBUILT MODIFY ID NUMBER(12);

CREATE INDEX CONCURRENTLY IX_REBUILT_EMAIL ON dbo.REBUILT USING btree (LOWER(EMAIL) DESC);
CREATE NONCLUSTERED COLUMNSTORE INDEX IX_REBUILT_CS ON dbo.REBUILT (ID, STATUS);
CREATE INDEX IX_GONE ON dbo.REBUILT (CODE);
DROP INDEX IF EXISTS IX_GONE ON dbo.REBUILT;

CREATE TABLE dbo."Order Items" (
    "Item, ID" INT PRIMARY KEY
);
COMMENT ON COLUMN dbo."Order Items"."Item, ID" IS 'Line item identifier';
`;
		const objs = extractSqlObjects(sql, { includeIndexes: true, includeAlter: true });
		expect(objs.some((o) => o.bareName.toUpperCase() === "TO" || o.bareName.toUpperCase() === "FROM")).toBe(false);
		expect(objs.some((o) => o.kind === "index" && o.bareName === "IX_REBUILT_EMAIL")).toBe(true);
		expect(objs.some((o) => o.kind === "index" && o.bareName === "IX_REBUILT_CS")).toBe(true);

		const tables = parseCreateTables(sql);
		expect(tables.map((t) => t.tableName)).toEqual(["REBUILT", "Order Items"]);

		const rebuilt = tables[0]!;
		expect(rebuilt.columns.map((c) => c.name)).toEqual(["ID", "EMAIL", "STATUS", "CODE", "DROP FLAG"]);
		// PG SET DATA TYPE preserved NOT NULL on EMAIL
		expect(rebuilt.columns.find((c) => c.name === "EMAIL")).toEqual({
			name: "EMAIL",
			type: "VARCHAR(160)",
			constraints: "NOT NULL",
		});
		// Oracle MODIFY preserved NOT NULL + PRIMARY KEY on ID
		const idCol = rebuilt.columns.find((c) => c.name === "ID")!;
		expect(idCol.type).toBe("NUMBER(12)");
		expect(idCol.constraints).toContain("NOT NULL");
		expect(idCol.constraints).toContain("PRIMARY KEY");
		// SET DEFAULT / DROP DEFAULT preserved type VARCHAR(10) and NOT NULL on STATUS
		expect(rebuilt.columns.find((c) => c.name === "STATUS")).toEqual({
			name: "STATUS",
			type: "VARCHAR(10)",
			constraints: "NOT NULL",
		});
		// Expression index preserved intact and dropped index removed
		expect(rebuilt.indexes).toEqual([
			{ name: "IX_REBUILT_EMAIL", columns: ["LOWER(EMAIL)"] },
			{ name: "IX_REBUILT_CS", columns: ["ID", "STATUS"] },
		]);

		// Spaced/quoted table + column COMMENT ON COLUMN attached accurately
		const orderItems = tables[1]!;
		expect(orderItems.columns[0]!.comment).toBe("Line item identifier");
	});
});

describe("R5C P1-3 & P2-1 — Markdown parsing, schemaMarkdownToSql, diffSqlAgainstSchemaMarkdown, ADR 0008, and projectDocs guard", () => {
	test("unescapes \\|, strips FK -> and commas in constraints, handles dbo.CUSTOMERS without misparsing, skips Name|Value tables, compares PK separately with CHECK/quotes masked, and produces ADR-0008-clean Markdown", () => {
		const md = [
			"# DEMO_ORDERS",
			"",
			"Metadata table (must NOT be parsed as SQL schema):",
			"",
			"| Name | Value |",
			"| --- | --- |",
			"| Owner | Lab Ops |",
			"",
			"| Column | Type | Constraints | Notes |",
			"| --- | --- | --- | --- |",
			"| `ORDNO` | `VARCHAR(20)` | PK, NOT NULL | Order key |",
			"| `CUST_ID` | `INT` | NOT NULL, FK -> dbo.CUSTOMERS | Customer ref |",
			"| `EXPR` | `VARCHAR(40)` | CHECK (EXPR \\|\\| '' <> 'NOT NULL') | Pipe expression |",
			"",
		].join("\n");

		const gen = schemaMarkdownToSql(md)!;
		expect(gen.tables).toEqual(["DEMO_ORDERS"]);
		expect(gen.sql).not.toContain("Owner");
		expect(gen.sql).toContain("PRIMARY KEY NOT NULL");
		expect(gen.sql).not.toContain("FK ->");
		expect(gen.sql).not.toContain("REFERENCES dbo (CUSTOMERS)");
		expect(gen.sql).toContain("REFERENCES dbo.CUSTOMERS");
		expect(gen.sql).toContain("CHECK (EXPR || '' <> 'NOT NULL')");

		// Schema prefix normalization in fkKey: SQL with `REFERENCES CUSTOMERS (CUST_ID)` matches Markdown `dbo.CUSTOMERS`
		const sqlSame = `
CREATE TABLE DEMO_ORDERS (
    ORDNO VARCHAR(20) NOT NULL PRIMARY KEY,
    CUST_ID INT NOT NULL REFERENCES CUSTOMERS (CUST_ID),
    EXPR VARCHAR(40) DEFAULT 'NOT NULL' CHECK (EXPR IS NOT NULL)
);
`;
		expect(diffSqlAgainstSchemaMarkdown(sqlSame, md)).toEqual([]);

		// Dropping PK while keeping NOT NULL IS detected as drift!
		const sqlDroppedPk = `
CREATE TABLE DEMO_ORDERS (
    ORDNO VARCHAR(20) NOT NULL,
    CUST_ID INT NOT NULL REFERENCES CUSTOMERS (CUST_ID),
    EXPR VARCHAR(40)
);
`;
		const pkDrift = diffSqlAgainstSchemaMarkdown(sqlDroppedPk, md);
		expect(pkDrift).toHaveLength(1);
		expect(pkDrift[0]!.modified).toContain("ORDNO");

		// ADR 0008 compliance on sqlTablesToMarkdown with verbose constraints, long types, and >100-char comments
		const verboseSql = `
CREATE TABLE AUDIT_EVENTS (
    EVENT_ID INT NOT NULL PRIMARY KEY,
    CREATED_AT TIMESTAMP(6) WITH LOCAL TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    LABEL NATIONAL CHARACTER VARYING(120) NOT NULL CHECK (LABEL IN ('OPEN', 'CLOSED', 'PENDING', 'ARCHIVED'))
);
COMMENT ON COLUMN AUDIT_EVENTS.LABEL IS '${"Detailed audit description ".repeat(6)}';
`;
		const verboseMd = sqlTablesToMarkdown(parseCreateTables(verboseSql), "schema/database/audit.sql");
		expect(checkTables(verboseMd)).toEqual([]);
		expect(diffSqlAgainstSchemaMarkdown(verboseSql, verboseMd)).toEqual([]);
	});

	test("projectDocs.ts filters FK: and INDEX: entries before prompting for dropped columns", () => {
		const src = readFileSync(join(import.meta.dir, "..", "src", "view", "projectDocs.ts"), "utf8");
		expect(src).toMatch(/!\s*\/\^\(\?:FK\|INDEX\): \//);
	});
});

describe("R5C P0-6, P1-5 & P2-3 — schemaIndex & schemaList repairs", () => {
	test("referencedSchemaTables runs in <50ms on 300 docs x 50KB, avoids $/\# boundary collisions, handles 2-char tables vs stop words, and searches the text as it is given", () => {
		const docs: DocFile[] = [
			{ path: "/ws/schema/database/ORDERS.md", name: "database/ORDERS.md", group: "schema", kind: "database", exists: true, title: "ORDERS" },
			{ path: "/ws/schema/database/QC.md", name: "database/QC.md", group: "schema", kind: "database", exists: true, title: "QC" },
			{ path: "/ws/schema/database/IF.md", name: "database/IF.md", group: "schema", kind: "database", exists: true, title: "IF" },
			{ path: "/ws/schema/database/ID.md", name: "database/ID.md", group: "schema", kind: "database", exists: true, title: "ID" },
			{ path: "/ws/schema/database/COMMENTED_ONLY.md", name: "database/COMMENTED_ONLY.md", group: "schema", kind: "database", exists: true, title: "COMMENTED_ONLY" },
			...Array.from({ length: 295 }, (_, i) => ({
				path: `/ws/schema/database/TBL_${i}.md`,
				name: `database/TBL_${i}.md`,
				group: "schema" as const,
				kind: "database",
				exists: true,
				title: `TBL_${i}`,
			})),
		];
		const padding = `sNote := "a line of padding";\nnCount := nCount + 1;\nsMore := "and another line";\nSELECT ORDERS$1, ORDERS#2, if, to, in, on, as, or, by, is, of, at, no, do, go, id FROM DUMMY_WORK;\n`.repeat(300);
		const bigCode = `${padding}\nSQLExecute("SELECT * FROM dbo.QC JOIN [dbo].[TBL_250] ON 1=1");\n`;
		expect(bigCode.length).toBeGreaterThan(50_000);

		const t0 = performance.now();
		const hits = referencedSchemaTables(bigCode, docs);
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(50);
		expect(hits.map((d) => d.title)).toEqual(["QC", "TBL_250"]);
		// ORDERS$1 / ORDERS#2 must NOT match ORDERS; stop words IF/ID excluded
		expect(hits.some((d) => d.title === "ORDERS")).toBe(false);
		expect(hits.some((d) => d.title === "COMMENTED_ONLY")).toBe(false);
		expect(hits.some((d) => d.title === "IF" || d.title === "ID")).toBe(false);

		// It reads no comments of its own (ADR 0003): a name in one counts until the caller has taken the comments
		// out, with the language server's word for where SSL's are (test/lexicalTokens.test.ts).
		const noted = `/* COMMENTED_ONLY is read here;\nnCount := 1;\n`;
		expect(referencedSchemaTables(noted, docs).map((d) => d.title)).toEqual(["COMMENTED_ONLY"]);
		const comment = { kind: "comment", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 31 } } };
		expect(referencedSchemaTables(withoutTokens(noted, [comment]), docs)).toEqual([]);
	});

	test("classifyUsageCategory keeps GetLatest.ssl, ApproveTest.ssl, AssignTests.ssl in Scripts while classifying true test files under Tests", () => {
		const groups = groupSchemaUsages(
			[
				{ path: "/ws/src/GetLatest.ssl", rel: "src\\GetLatest.ssl", line: 10, text: "" },
				{ path: "/ws/src/GetLatest.ssl", rel: "src\\GetLatest.ssl", line: 10, text: "SELECT * FROM ORDERS" },
				{ path: "/ws/src/ApproveTest.ssl", rel: "src/ApproveTest.ssl", line: 5, text: "UPDATE ORDERS SET OK = 1" },
				{ path: "/ws/src/AssignTests.ssl", rel: "src/AssignTests.ssl", line: 8, text: "FROM ORDERS" },
				{ path: "/ws/src/Orders_test.ssl", rel: "src/Orders_test.ssl", line: 2, text: "FROM ORDERS" },
				{ path: "/ws/src/Orders.spec.ts", rel: "src/Orders.spec.ts", line: 3, text: "ORDERS" },
			],
			[
				{ path: "/ws/docs/registries/database.csv", title: "Database", fileName: "database.csv", rel: "docs\\registries\\database.csv" },
				{ path: "/ws/docs/registries/database.csv", title: "Database", fileName: "database.csv", rel: "docs\\registries\\database.csv" },
			],
		);

		const scripts = groups.find((g) => g.id === "scripts")!;
		expect(scripts.items.map((i) => i.name)).toEqual(["ApproveTest.ssl", "AssignTests.ssl", "GetLatest.ssl"]);
		// Empty cached line snippet replaced when non-empty hit arrived
		expect(scripts.items.find((i) => i.name === "GetLatest.ssl")!.hits[0]!.text).toBe("SELECT * FROM ORDERS");

		const tests = groups.find((g) => g.id === "tests")!;
		expect(tests.items.map((i) => i.name).sort()).toEqual(["Orders.spec.ts", "Orders_test.ssl"]);

		// Registries deduplicated by canonical path and `\` normalized to `/`
		const regs = groups.find((g) => g.id === "registries")!;
		expect(regs.items).toHaveLength(1);
		expect(regs.items[0]!.rel).toBe("docs/registries/database.csv");

		// Backslash query filter normalized
		const filtered = filterSchemaUsageGroups(groups, "docs\\registries");
		expect(filtered.map((g) => g.id)).toEqual(["registries"]);
	});

	test("schemaDocKeys, findSchemaDocForIdentifier ([dbo].[ORDERS]), extractSchemaColumns, and extractSchemaPreview", () => {
		const readmeDoc: DocFile = { path: "/ws/schema/database/README.md", name: "database/README.md", group: "schema", kind: "database", exists: true, title: "Database" };
		const jsonDoc: DocFile = { path: "/ws/schema/interfaces/orders.json", name: "interfaces/orders.json", group: "schema", kind: "interfaces", exists: true };
		const salesOrders: DocFile = { path: "/ws/schema/database/sales.ORDERS.md", name: "database/sales.ORDERS.md", group: "schema", kind: "database", exists: true };
		const dboOrdersSql: DocFile = { path: "/ws/schema/database/dbo.ORDERS.sql", name: "database/dbo.ORDERS.sql", group: "schema", kind: "database", exists: true };

		expect(schemaDocKeys(readmeDoc)).toEqual([]);
		expect(schemaDocKeys(jsonDoc)).toEqual([]);
		expect(schemaDocKeys(dboOrdersSql)).toEqual(["dbo.orders", "orders"]);

		// `[dbo].[ORDERS]` strips brackets per segment and prefers exact `dbo.orders` over `sales.ORDERS.md` bare fallback
		expect(findSchemaDocForIdentifier("[dbo].[ORDERS]", [salesOrders, dboOrdersSql])).toBe(dboOrdersSql);
		// Bare `ORDERS` falls back to Markdown (`sales.ORDERS.md`) over SQL
		expect(findSchemaDocForIdentifier("ORDERS", [dboOrdersSql, salesOrders])).toBe(salesOrders);

		// extractSchemaColumns passes SQL COMMENT ON COLUMN, skips fences, deprecated rows, and FK/Index tables
		const sqlCols = extractSchemaColumns(
			dboOrdersSql,
			"CREATE TABLE dbo.ORDERS (ID INT PRIMARY KEY);\nCOMMENT ON COLUMN dbo.ORDERS.ID IS 'Order primary key';",
		);
		expect(sqlCols[0]!.notes).toBe("Order primary key");

		const mdCols = extractSchemaColumns(
			salesOrders,
			[
				"# ORDERS",
				"",
				"```md",
				"| Column | Type | Notes |",
				"| --- | --- | --- |",
				"| `FENCED` | `INT` | Ignore |",
				"```",
				"",
				"| Column | Type | Constraints | Notes |",
				"| --- | --- | --- | --- |",
				"| `ID` | `INT` | PRIMARY KEY | Live col |",
				"| `OLD` | `INT` | — | Gone [deprecated / dropped in SQL] |",
				"",
				"| Index name | Fields | Uniqueness |",
				"| --- | --- | --- |",
				"| `IX_ID` | `ID` | unique |",
			].join("\n"),
		);
		expect(mdCols.map((c) => c.name)).toEqual(["ID"]);

		// extractSchemaPreview counts ONLY contiguous `|` rows of first table and supports standalone ALTER SQL
		const previewMd = [
			"# BIG",
			"",
			"| Column | Type | Notes |",
			"| --- | --- | --- |",
			"| `C1` | `INT` | 1 |",
			"| `C2` | `INT` | 2 |",
			"| `C3` | `INT` | 3 |",
			"| `C4` | `INT` | 4 |",
			"",
			"## Foreign keys",
			"",
			"| Column | Target table | Target column |",
			"| --- | --- | --- |",
			"| `C1` | `P` | `ID` |",
			"| `C2` | `P` | `ID` |",
		].join("\n");
		const prev = extractSchemaPreview(salesOrders, previewMd, 2);
		expect(prev).toContain("(2 more rows)");
		expect(prev).not.toContain("(6 more rows)");

		const alterPrev = extractSchemaPreview(dboOrdersSql, "ALTER TABLE dbo.ORDERS ADD RUSH_FLAG BIT NOT NULL;");
		expect(alterPrev).toContain("RUSH_FLAG");
	});

	test("schemaList derives each part.folder from its own files, trims whitespace titles, and sorts case variants deterministically", () => {
		const f1: DocFile = { path: "/p/schema/interfaces/ERP/a.md", name: "interfaces/ERP/a.md", group: "schema", kind: "interfaces", exists: true, title: "   " };
		const f2: DocFile = { path: "/p/schema/Interfaces/Lab/b.md", name: "Interfaces/Lab/b.md", group: "schema", kind: "interfaces", exists: true, title: " Lab Feed " };
		const f3: DocFile = { path: "/p/schema/interfaces/erp/c.md", name: "interfaces/erp/c.md", group: "schema", kind: "interfaces", exists: true };

		expect(schemaRowTitle(f1, 2)).toBe("a.md");
		expect(schemaRowTitle(f2, 2)).toBe("Lab Feed");

		const listA = schemaList([f1, f2, f3]);
		const listB = schemaList([f3, f2, f1]);
		const ifcA = listA.kinds.find((k) => k.id === "interfaces")!;
		const ifcB = listB.kinds.find((k) => k.id === "interfaces")!;
		expect(ifcA.parts.find((p) => p.name === "Lab")!.folder).toBe("Interfaces/Lab");
		expect(ifcA.parts.find((p) => p.name === "ERP")!.folder).toBe("interfaces/ERP");
		expect(ifcA.parts.map((p) => p.name)).toEqual(ifcB.parts.map((p) => p.name));
	});
});
