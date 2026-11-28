// A format changes the layout of code and never what it says (ADR 0045): the code samples of a Markdown document
// keep the spaces at their lines' ends, and SQL keeps its two-character operators and its bound names, with an
// Oracle package formatted as Oracle's whatever dialect is chosen.
import { describe, expect, test } from "bun:test";
import { formatDocument } from "../src/bun/format";
import { keepCodeBlockSpaces } from "../src/shared/fencedFormat";
import { linesInFile, sqlDialectFor, sqlTokenLost } from "../src/shared/format";

const format = async (path: string, text: string, languageId: string, sqlDialect?: "tsql" | "plsql") => {
	const result = await formatDocument({ path, text, languageId, tabSize: 4, insertSpaces: false, printWidth: 90, sqlDialect });
	return result;
};

describe("a Markdown document's code samples keep the spaces at their lines' ends", () => {
	test("the formatter's trimming is put back, line by line, where nothing else of the line changed", () => {
		const before = "# A\n\n```ssl\ns := \"x   \n   y\";\n```\n\n```diff\n a\n \n-b\n```\n";
		const trimmed = "# A\n\n```ssl\ns := \"x\n   y\";\n```\n\n```diff\n a\n\n-b\n```\n";
		expect(keepCodeBlockSpaces(before, trimmed)).toBe(before);
		// In a list, under its new indentation; in a quote, after its ">".
		const listed = "- one\n\n   ```md\n   first  \n   ```\n";
		expect(keepCodeBlockSpaces(listed, "- one\n\n  ```md\n  first\n  ```\n")).toBe("- one\n\n  ```md\n  first  \n  ```\n");
		const quoted = "> ```md\n> line  \n>  \n> ```\n";
		expect(keepCodeBlockSpaces(quoted, "> ```md\n> line\n>\n> ```\n")).toBe("> ```md\n> line  \n>  \n> ```\n");
		// CRLF stays CRLF.
		expect(keepCodeBlockSpaces("```\r\na  \r\n```\r\n", "```\r\na\r\n```\r\n")).toBe("```\r\na  \r\n```\r\n");
	});

	test("a block the formatter changed otherwise, or blocks that no longer pair up, are left as printed", () => {
		expect(keepCodeBlockSpaces("```\na  \nb\n```\n", "```\na\nB\n```\n")).toBe("```\na\nB\n```\n");
		expect(keepCodeBlockSpaces("```\na  \n```\n", "```\na\nb\n```\n")).toBe("```\na\nb\n```\n");
		expect(keepCodeBlockSpaces("```\na  \n```\n\n```\nb\n```\n", "```\na\n```\n")).toBe("```\na\n```\n");
		expect(keepCodeBlockSpaces("no code  \n", "no code\n")).toBe("no code\n");
	});

	test("an indented code block keeps them too, in a list as well", async () => {
		const text = "# Notes\n\nSome prose.\n\n    indented  \n    code  \n\n*  item\n\n       in a list  \n";
		const first = await format("notes.md", text, "markdown");
		if (!first.ok) throw new Error(first.error);
		expect(first.text).toContain("    indented  \n    code  \n");
		expect(first.text).toContain("- item");
		expect(first.text).toMatch(/in a list {2}\n/);
		expect(await format("notes.md", first.text, "markdown")).toMatchObject({ ok: true, changed: false });
	});

	test("\"Format document\" lays the prose out and leaves the code as written, the second time too", async () => {
		const text = "# Note\n\n*  a list item\n\n```ssl\ns := \"x   \n   y\";\n```\n";
		const first = await format("note.md", text, "markdown");
		if (!first.ok) throw new Error(first.error);
		expect(first.text).toContain("- a list item");
		expect(first.text).toContain("```ssl\ns := \"x   \n   y\";\n```");
		const second = await format("note.md", first.text, "markdown");
		expect(second).toMatchObject({ ok: true, changed: false });
	});
});

describe("SQL keeps what a reader of another dialect would cut up", () => {
	test("an operator of two characters, or a bound name, that is not there after the format is the one lost", () => {
		expect(sqlTokenLost("v_due := SYSDATE;", "v_due: = SYSDATE;")).toBe(":=");
		expect(sqlTokenLost("id = :nId;", "id =: nId;")).toBe(":nId");
		expect(sqlTokenLost("a<>1 and b>=2", "a <> 1\nAND b >= 2")).toBeNull();
		expect(sqlTokenLost("x = :a and y = :a", "x = :a\nAND y = : a")).toBe(":a");
		expect(sqlTokenLost("select 'a:b' from t", "SELECT\n\t'a:b'\nFROM\n\tt")).toBeNull();
	});

	test("an Oracle package or PL/SQL script is formatted as Oracle's, whatever dialect is chosen", async () => {
		expect(sqlDialectFor("due.pkb", "tsql")).toBe("plsql");
		expect(sqlDialectFor("due.PKS", "sql")).toBe("plsql");
		expect(sqlDialectFor("run.pls", "mysql")).toBe("plsql");
		expect(sqlDialectFor("query.sql", "tsql")).toBe("tsql");
		const body = "CREATE OR REPLACE PACKAGE BODY due AS\n  PROCEDURE plan(p_days IN NUMBER) IS\n    v_due DATE;\n  BEGIN\n    v_due := SYSDATE + p_days;\n    UPDATE t SET d = v_due WHERE id = :nId;\n  END;\nEND due;\n";
		const result = await format("due.pkb", body, "sql", "tsql");
		if (!result.ok) throw new Error(result.error);
		expect(result.text).toContain("v_due := SYSDATE + p_days;");
		expect(result.text).toContain("id = :nId;");
	});

	test("a format that would cut one up changes nothing and says which, and what to choose", async () => {
		const text = "UPDATE t SET a = :nVal WHERE id = :nId;\n";
		const result = await format("update.sql", text, "sql", "tsql");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("formatting it as SQL Server (T-SQL) would break up “:nVal”, so nothing was changed. If it is written for another database, choose that one under SQL dialect in Settings.");
		// In the dialect it is written in it formats.
		const oracle = await format("update.sql", text, "sql", "plsql");
		expect(oracle).toMatchObject({ ok: true });
		// And T-SQL that is T-SQL is formatted as before.
		const plain = await format("query.sql", "select a from t where x<>1\n", "sql", "tsql");
		expect(plain).toMatchObject({ ok: true, text: "SELECT\n\ta\nFROM\n\tt\nWHERE\n\tx <> 1\n" });
	});
});

describe("an error in a data source's SQL names the line of the file", () => {
	test("the lines above the SQL are counted in", () => {
		expect(linesInFile('Parse error: Unexpected "(" at line 2 column 18.', 2)).toBe('Parse error: Unexpected "(" at line 4 column 18.');
		expect(linesInFile("Unexpected end at line 1, and again at line 3", 5)).toBe("Unexpected end at line 6, and again at line 8");
		expect(linesInFile("at line 2", 0)).toBe("at line 2");
	});
});
