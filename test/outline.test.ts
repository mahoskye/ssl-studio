import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { hasOutline, outline, type OutlineItem } from "../src/shared/outline";

const tree = (items: OutlineItem[], depth = 0): string[] => items.flatMap((item) => [`${"  ".repeat(depth)}${item.name} ${item.line}-${item.endLine}`, ...tree(item.children, depth + 1)]);

describe("a document's outline", () => {
	test("Markdown: its headings, each holding those under it, and none from a code fence or the front matter", () => {
		const text = ["---", "title: T", "# not a heading", "---", "", "# One", "", "text", "## Two *bold* [link](x.md)", "", "```sh", "# a comment in code", "```", "### Three ##", "## Four", "# Five"].join("\n");
		expect(tree(outline("markdown", text))).toEqual(["One 6-15", "  Two bold link 9-14", "    Three 14-14", "  Four 15-15", "Five 16-16"]);
		expect(outline("markdown", "no headings here")).toEqual([]);
	});

	test("TOML: its tables with their keys, the keys before any table, and nothing from inside a long string or array", () => {
		const text = ['name = "x"', "", "[project]", 'name = "Due dates" # said once', "folders = [", '  "docs",', '  "key = not one",', "]", 'about = """', "key = not one either", '"""', "", "[[agent.models]]", "id = 1"].join("\n");
		expect(tree(outline("toml", text))).toEqual(["name 1-1", "project 3-12", "  name 4-4", "  folders 5-5", "  about 9-9", "agent.models 13-14", "  id 14-14"]);
		expect(outline("toml", text)[2]!.detail).toBe("one of a list");
	});

	test("INI: its sections and keys, with either sign", () => {
		expect(tree(outline("ini", "; note\n[db]\nhost=local\nport: 1521\n[app]\nname = x\n"))).toEqual(["db 2-4", "  host 3-3", "  port 4-4", "app 5-7", "  name 6-6"]);
	});

	test("JSON: the keys of its object, and of the objects those hold, with where each ends", () => {
		const text = ['{', '  "version": 1,', '  "nodes": [', '    { "id": "n1", "text": "a: b" }', "  ],", '  "built": {', '    "at": "x",', '    "units": { "deep": 1 }', "  },", '  "last": true', "}"].join("\n");
		expect(tree(outline("json", text))).toEqual(["version 2-2", "nodes 3-5", "built 6-9", "  at 7-7", "  units 8-8", "last 10-10"]);
		// Text that is not yet JSON gives what can be read of it, and never throws.
		expect(tree(outline("json", '{ "a": { "b": [1, 2'))).toEqual(["a 1-1", "  b 1-1"]);
		expect(outline("json", "[1, 2, 3]")).toEqual([]);
	});

	test("SQL: its statements, named by what they do and to what; a semicolon in a string or a comment ends nothing", () => {
		const text = ["-- the tables; and the rows", "CREATE TABLE DEMO_SAMPLES (", "  SAMPLE_ID VARCHAR(20)", ");", "", "/* one; two */", "INSERT INTO DEMO_SAMPLES (SAMPLE_ID) VALUES ('a;b');", "create unique index IX_DUE on DEMO_SAMPLES (DUE_ON);", "UPDATE dbo.DEMO_SAMPLES SET DUE_ON = NULL;", "DELETE FROM [DEMO OUTAGES];", "SELECT SAMPLE_ID", "FROM DEMO_SAMPLES", "WHERE DUE_ON IS NULL", "", "GRANT SELECT ON X TO Y;"].join("\n");
		expect(tree(outline("sql", text))).toEqual([
			"CREATE TABLE DEMO_SAMPLES 2-4",
			"INSERT INTO DEMO_SAMPLES 7-7",
			"CREATE INDEX IX_DUE 8-8",
			"UPDATE dbo.DEMO_SAMPLES 9-9",
			"DELETE FROM [DEMO OUTAGES] 10-10",
			"SELECT from DEMO_SAMPLES 11-15",
		]);
		expect(tree(outline("sql", "SELECT 1"))).toEqual(["SELECT 1 1-1"]);
	});

	test("YAML: the keys at its left edge", () => {
		expect(tree(outline("yaml", "name: x\nsteps:\n  - run: a\n  - run: b\n# note\n'on': push\n"))).toEqual(["name 1-1", "steps 2-5", "on 6-7"]);
	});

	test("the demo's own files have outlines, and SSL is not read here", async () => {
		const demo = join(import.meta.dir, "..", "examples", "due-dates");
		const names = async (language: string, ...path: string[]) => outline(language, await Bun.file(join(demo, ...path)).text()).map((item) => item.name);
		expect(await names("toml", ".ssl-studio", "project.toml")).toContain("project");
		expect((await names("sql", "schema", "database", "DEMO_SAMPLES.sql")).some((name) => name.startsWith("CREATE TABLE DEMO_"))).toBe(true);
		expect(await names("markdown", "docs", "tickets", "DEMO-103", "DEMO-103.md")).toEqual(["DEMO-103: A report of the samples due soon"]);
		expect(await names("json", "design", "SetSampleDueDates.plan.json")).toContain("nodes");
		expect(hasOutline("ssl")).toBe(false);
		expect(outline("ssl", ":PROCEDURE A;\n:ENDPROC;")).toEqual([]);
		expect(hasOutline("markdown")).toBe(true);
	});
});

import { tomlProblem } from "../src/bun/project";

describe("a TOML document that cannot be read", () => {
	test("what reads has nothing wrong with it, and an empty document is not yet a problem", () => {
		expect(tomlProblem('[project]\nname = "Due dates"\nfolders = ["docs", "schema"]\n')).toBeNull();
		expect(tomlProblem("")).toBeNull();
		expect(tomlProblem("  \n")).toBeNull();
	});

	test("the first thing wrong is said in plain words, with its line", () => {
		expect(tomlProblem("a = 1\nb = \n")).toEqual({ message: "The file ends in the middle of a value: something is not finished or not closed.", line: 2, column: 5 });
		expect(tomlProblem('a = "unclosed\n')).toMatchObject({ message: "This string is not closed.", line: 1 });
		expect(tomlProblem("a = 1\na = 2\n")).toMatchObject({ message: "a is set twice.", line: 2 });
		expect(tomlProblem("a = 1 2\n")).toMatchObject({ message: "A key is followed by = and a value, one to a line.", line: 1 });
		const open = tomlProblem("[x\na=1");
		expect(open).not.toBeNull();
		expect(open!.line).toBeGreaterThanOrEqual(1);
		expect(open!.line).toBeLessThanOrEqual(2);
	});

	test("the demo's own settings read", async () => {
		expect(tomlProblem(await Bun.file(join(import.meta.dir, "..", "examples", "due-dates", ".ssl-studio", "project.toml")).text())).toBeNull();
	});
});

import { createdObjects } from "../src/shared/outline";
import { formatJson } from "../src/shared/jsonFormat";
import { statusChoices } from "../src/shared/projectDocs";

describe("the database objects a schema's SQL creates", () => {
	test("each table, view, procedure and sequence once, and no index", () => {
		const text = "CREATE TABLE DEMO_SAMPLES (ID INT);\nCREATE UNIQUE INDEX IX ON DEMO_SAMPLES (ID);\ncreate or replace view dbo.[Due Soon] as select 1;\nCREATE SEQUENCE SEQ_SAMPLE;\nCREATE TABLE demo_samples (ID INT);\nINSERT INTO DEMO_SAMPLES VALUES (1);\nCREATE PROCEDURE SetDue AS BEGIN SELECT 1 END;";
		expect(createdObjects(text)).toEqual([
			{ object: "DEMO_SAMPLES", kind: "table" },
			{ object: "dbo.Due Soon", kind: "view" },
			{ object: "SEQ_SAMPLE", kind: "sequence" },
			{ object: "SetDue", kind: "procedure" },
		]);
	});

	test("the demo's schema gives its four tables (excluding indexes)", async () => {
		const dbDir = join(import.meta.dir, "..", "examples", "due-dates", "schema", "database");
		const all = (
			await Promise.all(
				["DEMO_INSTRUMENTS.sql", "DEMO_SAMPLES.sql", "DEMO_HOLIDAYS.sql", "DEMO_OUTAGES.sql"].map((f) => Bun.file(join(dbDir, f)).text()),
			)
		).join("\n");
		expect(createdObjects(all)).toEqual([
			{ object: "DEMO_INSTRUMENTS", kind: "table" },
			{ object: "DEMO_SAMPLES", kind: "table" },
			{ object: "DEMO_HOLIDAYS", kind: "table" },
			{ object: "DEMO_OUTAGES", kind: "table" },
		]);
	});
});

describe("a JSON document laid out afresh", () => {
	test("one value to a line, by its depth, and what is empty stays on its line", () => {
		expect(formatJson('{"a":1,"b":[true,null,{"c":"x"}],"d":{},"e":[ ]}')).toBe('{\n\t"a": 1,\n\t"b": [\n\t\ttrue,\n\t\tnull,\n\t\t{\n\t\t\t"c": "x"\n\t\t}\n\t],\n\t"d": {},\n\t"e": []\n}\n');
		expect(formatJson('{ "a" : 1 }', "  ")).toBe('{\n  "a": 1\n}\n');
		expect(formatJson('"alone"')).toBe('"alone"\n');
	});

	test("every string and number is written exactly as it was", () => {
		const text = '{"n":12345678901234567890.10,"e":1E+5,"s":"a, b: {c} [d] \\" \\\\","u":"\\u00e9","dup":1,"dup":2}';
		const formatted = formatJson(text)!;
		for (const piece of ["12345678901234567890.10", "1E+5", '"a, b: {c} [d] \\" \\\\"', '"\\u00e9"']) expect(formatted).toContain(piece);
		expect(formatted.match(/"dup"/g)).toHaveLength(2);
		expect(JSON.parse(formatted)).toEqual(JSON.parse(text));
	});

	test("laid out twice it is the same, its line ends are kept, and what is not JSON is left alone", () => {
		const once = formatJson('{"a":[1,2,{"b":null}]}')!;
		expect(formatJson(once)).toBe(once);
		expect(formatJson('{\r\n"a":1}')).toBe('{\r\n\t"a": 1\r\n}\r\n');
		expect(formatJson('{"a":1,}')).toBeNull();
		expect(formatJson("")).toBeNull();
	});
});

describe("the states a document is chosen to be in", () => {
	test("follow what kind of document it is", () => {
		expect(statusChoices({ group: "tickets" })).toEqual(["open", "in progress", "done", "blocked", "dropped"]);
		expect(statusChoices({ group: "knowledge", kind: "questions" })).toEqual(["open", "answered"]);
		expect(statusChoices({ group: "knowledge", kind: "decisions" })).toContain("accepted");
		expect(statusChoices({ group: "specs" })[0]).toBe("draft");
		expect(statusChoices(undefined)).toEqual(["draft", "in progress", "done"]);
	});
});

import { parseCsv, rowSpan } from "../src/shared/csv";
import { docMatches } from "../src/shared/projectDocs";

describe("taking a row out of a table", () => {
	const without = (text: string, row: number) => {
		const span = rowSpan(text, parseCsv(text), row)!;
		return text.slice(0, span.start) + text.slice(span.end);
	};

	test("its line goes, and nothing else changes", () => {
		const text = "name,status\na,found\nb,done\nc,found\n";
		expect(without(text, 0)).toBe("name,status\nb,done\nc,found\n");
		expect(without(text, 1)).toBe("name,status\na,found\nc,found\n");
		expect(without(text, 2)).toBe("name,status\na,found\nb,done\n");
	});

	test("the last row of a file with no line end at its end takes the line end before it", () => {
		expect(without("name,status\na,found\nb,done", 1)).toBe("name,status\na,found");
		expect(without("name,status\r\na,found\r\nb,done", 1)).toBe("name,status\r\na,found");
		expect(without("name,status\r\na,found\r\nb,done\r\n", 0)).toBe("name,status\r\nb,done\r\n");
	});

	test("a row whose cell runs over several lines goes whole, and a row that is not there is nothing", () => {
		expect(without('name,note\na,"one\ntwo"\nb,x\n', 0)).toBe("name,note\nb,x\n");
		expect(rowSpan("name\na\n", parseCsv("name\na\n"), 5)).toBeNull();
	});
});

describe("a document a filter is looking for", () => {
	const file = { name: "Which-holidays.md", title: "Which holidays does each site keep?", status: "open", summary: "The holidays table has no site.", tickets: ["DEMO-101"], kind: "questions" };

	test("has every word typed, in its title, state, key, kind or what it is about", () => {
		expect(docMatches(file, "")).toBe(true);
		expect(docMatches(file, "  ")).toBe(true);
		expect(docMatches(file, "holiday")).toBe(true);
		expect(docMatches(file, "OPEN holiday")).toBe(true);
		expect(docMatches(file, "demo-101 question")).toBe(true);
		expect(docMatches(file, "open rush")).toBe(false);
		expect(docMatches({ name: "DEMO-103.md", ticket: "DEMO-103", title: "A report" }, "103")).toBe(true);
	});
});
