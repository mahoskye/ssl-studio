// A data source is SQL or SSL, and is read as one or the other (shared/sqlDataSource.ts, ADR 0038): by what the
// language server says it read as SSL, and by what stands below that. The rule on its own, and then with the
// pinned server's own tokens, since it is the server's word the rule rests on.
import { afterAll, describe, expect, test } from "bun:test";
import { LSP_PIN } from "../src/bun/tools";
import { canFormatNonSsl, isSqlLanguage } from "../src/shared/format";
import { splitAtLine, sqlBodyStart } from "../src/shared/sqlDataSource";
import type { LexToken } from "../src/shared/lexicalTokens";
import { formatter, pinnedServer } from "./pinnedFormatter";

const token = (kind: string, line: number, endLine = line, endCharacter = 5): LexToken => ({ kind, range: { start: { line, character: 0 }, end: { line: endLine, character: endCharacter } } });

describe("sqlBodyStart: where a data source's SQL starts, if it is SQL", () => {
	test("SQL from the first line, with or without the server's word", () => {
		const sql = "SELECT s.SAMPLE_ID\nFROM DEMO_SAMPLES s\n";
		expect(sqlBodyStart(sql, null)).toBe(0);
		expect(sqlBodyStart(sql, [])).toBe(0);
		expect(sqlBodyStart("\n\n  with x as (select 1)\nselect * from x", [])).toBe(2);
		expect(sqlBodyStart("(SELECT 1) UNION (SELECT 2)", null)).toBe(0);
		expect(sqlBodyStart("EXEC dbo.OpenSamples @dFrom", null)).toBe(0);
	});

	test("SQL's own comments above the statement are part of the SQL", () => {
		expect(sqlBodyStart("-- open samples\n-- soonest first\nSELECT 1\n", null)).toBe(0);
		expect(sqlBodyStart("/* open samples */\nSELECT 1\n", null)).toBe(0);
		expect(sqlBodyStart("/* open\n   samples */ SELECT 1\n", null)).toBe(0);
		// A banner closed with `*/;` is closed: the `;` is no statement.
		expect(sqlBodyStart("/* open samples */;\nSELECT 1\n", null)).toBe(0);
	});

	test("directives above the SQL: the SQL starts below the last thing the server read as SSL", () => {
		const text = ':PARAMETERS dFrom;\n:DSN := "DATABASE";\n\nSELECT 1\nFROM T\n';
		// Without the server there is no saying what the first lines are, and they are not SQL.
		expect(sqlBodyStart(text, null)).toBeNull();
		expect(sqlBodyStart(text, [token("keyword", 0), token("keyword", 1), token("string", 1)])).toBe(3);
		// A banner in SQL's form above the directives is the server's to leave out; the SQL still starts below them.
		expect(sqlBodyStart("/* Open samples */\n:PARAMETERS dFrom;\nSELECT 1\n", [token("keyword", 1)])).toBe(2);
	});

	test("an SSL data source is not SQL, however much SQL its strings hold", () => {
		const ssl = ':DECLARE aRows;\naRows := SQLExecute("\n    SELECT HOLIDAY_ON\n    FROM DEMO_HOLIDAYS\n");\n:RETURN aRows;\n';
		// The server read to the last line: nothing stands below what it read.
		expect(sqlBodyStart(ssl, [token("keyword", 0), token("string", 1, 4, 2), token("keyword", 5)])).toBeNull();
		// With no server, its first line is no SQL statement.
		expect(sqlBodyStart(ssl, null)).toBeNull();
		// A string still open runs to the end of the text, the SELECT inside it with it.
		expect(sqlBodyStart(':RETURN SQLExecute("\n    SELECT 1\n', [token("keyword", 0), token("string", 0, 2, 0)])).toBeNull();
	});

	test("an SSL comment is not SQL's: it is never closed with `*/`", () => {
		expect(sqlBodyStart("/* DATA SOURCE: Holidays (SSL);\n:DECLARE aRows;\n", null)).toBeNull();
		expect(sqlBodyStart("/* a note;\nSELECT 1\n", null)).toBeNull();
	});

	test("a name that is spelt like an SQL word, given a value or called, opens no SQL", () => {
		expect(sqlBodyStart("Update := 1;\n", null)).toBeNull();
		expect(sqlBodyStart("Set(nA, 1);\n", null)).toBeNull();
		expect(sqlBodyStart("Selection := 1;\n", null)).toBeNull();
		expect(sqlBodyStart("ExecFunction(\"A.B\");\n", null)).toBeNull();
	});

	test("nothing written, or comments alone, is not SQL yet", () => {
		expect(sqlBodyStart("", null)).toBeNull();
		expect(sqlBodyStart("\n  \n", [])).toBeNull();
		expect(sqlBodyStart("-- nothing yet\n", [])).toBeNull();
		expect(sqlBodyStart("/* nothing yet */\n", [])).toBeNull();
	});

	test("a token that ends at the start of a line ended on the line before", () => {
		// A comment over lines 0 to 1 whose range ends at the start of line 2: the SQL may start on line 2.
		expect(sqlBodyStart("/* a\n   note;\nSELECT 1\n", [token("comment", 0, 2, 0)])).toBe(2);
	});
});

describe("an SQL data source is formatted as SQL, below its directives", () => {
	test("the text in two at the line its SQL starts on, line ends kept", () => {
		expect(splitAtLine(":PARAMETERS a;\r\n\r\nSELECT 1\r\nFROM T\r\n", 2)).toEqual({ above: ":PARAMETERS a;\r\n\r\n", body: "SELECT 1\r\nFROM T\r\n" });
		expect(splitAtLine("SELECT 1\n", 0)).toEqual({ above: "", body: "SELECT 1\n" });
		expect(splitAtLine("a\nb", 9)).toEqual({ above: "a\n", body: "b" });
	});

	test("a data source shown as SQL is the SQL formatter's; one shown as SSL never is, and a script never is", () => {
		expect(canFormatNonSsl("sql", "src/Orders/OpenSamples.ds")).toBe(true);
		expect(canFormatNonSsl("pgsql", "src/Orders/OpenSamples.ds.txt")).toBe(true);
		expect(canFormatNonSsl("ssl", "src/Orders/OpenSamples.ds")).toBe(false);
		// Shown in some other mode by hand, it is still not for that mode's formatter.
		expect(canFormatNonSsl("javascript", "src/Orders/OpenSamples.ds")).toBe(false);
		expect(canFormatNonSsl("sql", "src/Orders/Save.ssl")).toBe(false);
		expect(canFormatNonSsl("sql", "src/Orders/Save.srvscr.txt")).toBe(false);
		expect(isSqlLanguage("mysql")).toBe(true);
		expect(isSqlLanguage("ssl")).toBe(false);
	});
});

const server = pinnedServer();

describe.skipIf(!server)(`starlims-lsp ${LSP_PIN}: each shape of data source, read by what the server says it read`, () => {
	const lsp = server ? formatter(server) : null;
	afterAll(() => lsp?.stop());
	const read = async (text: string) => sqlBodyStart(text, await lsp!.lexical(text, ".ds"));

	test("SQL data sources: plain, with SQL comments, with directives, with a banner above directives", async () => {
		expect(await read("SELECT s.SAMPLE_ID, s.DUE_ON\nFROM DEMO_SAMPLES s\nWHERE s.STATUS = 'Open'\n")).toBe(0);
		expect(await read("-- samples that are open\nSELECT 1\nFROM T\n")).toBe(0);
		expect(await read(':PARAMETERS dFrom, nDays := 3;\n:DSN := "DATABASE";\nSELECT s.SAMPLE_ID\nFROM DEMO_SAMPLES s\nWHERE s.DUE_ON < @dFrom\n')).toBe(2);
		expect(await read("/* DATA SOURCE: Open samples */\n:PARAMETERS dFrom;\nSELECT 1 FROM T WHERE A = @dFrom\n")).toBe(2);
	});

	test("SSL data sources: with a banner, without one, and returning a query written over lines", async () => {
		expect(await read('/* DATA SOURCE: Holidays (SSL);\n:DECLARE aRows;\naRows := SQLExecute("\n    SELECT HOLIDAY_ON\n    FROM DEMO_HOLIDAYS\n");\n:RETURN aRows;\n')).toBeNull();
		expect(await read(':PARAMETERS nDays;\n:DECLARE aRows;\naRows := SQLExecute("SELECT 1");\n:RETURN aRows;\n')).toBeNull();
		expect(await read(':PARAMETERS nDays;\n:RETURN SQLExecute("\n    SELECT 1\n    FROM T\n");\n')).toBeNull();
	});

	test("a data source with nothing but a comment in it is not SQL yet", async () => {
		expect(await read("/* nothing yet */\n")).toBeNull();
	});

	test("the example project's own data sources are read as what their banners say they are", async () => {
		const { readFileSync, readdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const folder = join(import.meta.dir, "../examples/due-dates/src/DueDates");
		const sources = readdirSync(folder).filter((name) => name.endsWith(".ds"));
		expect(sources.length).toBeGreaterThan(0);
		for (const name of sources) {
			const text = readFileSync(join(folder, name), "utf8");
			const saysSql = /DATA SOURCE: \w+ \(SQL\)/.test(text);
			expect([name, (await read(text)) !== null]).toEqual([name, saysSql]);
		}
	});
});
