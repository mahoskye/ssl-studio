// What an independent review of the working-documents code found (2026-11-19), each as the case that showed it.
import { describe, expect, test } from "bun:test";
import { catalogStale, withCatalog, CATALOG_END, CATALOG_START } from "../src/shared/catalog";
import { frontMatter, summaryOf, SUMMARY_MAX, titleOf } from "../src/shared/frontMatter";
import { jsonProblem } from "../src/shared/jsonCheck";
import { mergeManifest } from "../src/shared/manifest";
import { createdObjects, outline } from "../src/shared/outline";
import { relativePath } from "../src/shared/paths";
import { catalogItems, snippetTemplate, ticketTemplate } from "../src/shared/projectDocs";
import type { DocFile } from "../src/shared/protocol";
import { ticketsFromJson } from "../src/shared/ticketImport";
import { workList } from "../src/shared/workList";

describe("names with underscores, sharps and quotes", () => {
	test("an underscore or an asterisk inside a word is part of the word", () => {
		expect(titleOf("# Read DUE_SOON_AT from APP_SETTINGS")).toBe("Read DUE_SOON_AT from APP_SETTINGS");
		expect(summaryOf("# T\n\nThe job reads ORDER_ITEMS and SAMPLE_RESULTS nightly.")).toBe("The job reads ORDER_ITEMS and SAMPLE_RESULTS nightly.");
		expect(titleOf("# A *bold* move, and _really_ `code` with 2*3*4")).toBe("A bold move, and really code with 2*3*4");
		expect(outline("markdown", "# Read DUE_SOON_AT\n## __init__ and _private_ notes").map((item) => [item.name, item.children.map((c) => c.name)])).toEqual([["Read DUE_SOON_AT", ["init and private notes"]]]);
	});

	test("a heading that ends in a sharp keeps it, and closing hashes after a space are a mark", () => {
		expect(titleOf("# Using C#")).toBe("Using C#");
		expect(titleOf("# Closed ##")).toBe("Closed");
		expect(outline("markdown", "## Using F#")[0]!.name).toBe("Using F#");
	});

	test("a title with quotes or a backslash reads back as it was written", () => {
		for (const title of ['Label says "Due": wrong', "Export to C:\\temp fails", "It's fine: really", "plain"]) {
			expect(frontMatter(ticketTemplate({ key: "A-1", title })).values.title).toBe(title);
		}
		expect(frontMatter("---\ntitle: 'It''s here'\n---\n").values.title).toBe("It's here");
	});

	test("a summary that is one long word is cut where the room ends", () => {
		const summary = summaryOf(`# T\n\n${"x".repeat(200)}`);
		expect(summary.length).toBe(SUMMARY_MAX);
		expect(summary.endsWith("…")).toBe(true);
	});
});

describe("a catalog whose markers are not one clean pair", () => {
	const items = [{ path: "A.md", title: "A" }, { path: "B.md", title: "B" }];

	test("with its end marker gone, the list is written afresh once and what follows it stays", () => {
		const text = "# Tickets\n\n<!-- catalog -->\n\n- [A](A.md)\n\nMY NOTES: keep this paragraph.\n";
		const once = withCatalog(text, items);
		expect(once).toContain("MY NOTES: keep this paragraph.");
		expect(once.split(CATALOG_START).length).toBe(2);
		expect(once.split(CATALOG_END).length).toBe(2);
		expect(catalogStale(once, items)).toBe(false);
		const twice = withCatalog(once, [...items, { path: "C.md", title: "C" }]);
		expect(twice).toContain("MY NOTES: keep this paragraph.");
		expect(twice).toContain("- [C](C.md)");
	});

	test("a marker named in a sentence is not a marker", () => {
		const text = `# Tickets\n\nThe list is between \`${CATALOG_START}\` and its end marker.\n\nImportant prose.\n\n${CATALOG_START}\n\n- [A](A.md)\n\n${CATALOG_END}\n`;
		const after = withCatalog(text, items);
		expect(after).toContain("Important prose.");
		expect(after).toContain(`between \`${CATALOG_START}\` and its end marker.`);
		expect(after).toContain("- [B](B.md)");
		expect(catalogStale(after, items)).toBe(false);
	});

	test("a note kept beside the registries is listed as a document, not as a table of none", () => {
		const note: DocFile = { path: "/p/docs/registries/notes.md", name: "notes.md", group: "registries", exists: true, title: "How these are kept", status: "draft" };
		expect(catalogItems("registries", [note], "/p/docs")).toEqual([{ path: "notes.md", title: "How these are kept", status: "draft", summary: undefined }]);
	});
});

describe("a schema written for SQL Server or Oracle", () => {
	test("batches ended by GO or a slash are statements, and how a thing is made is not what it is", () => {
		const text = "CREATE TABLE dbo.A (ID INT)\nGO\nCREATE TABLE dbo.B (ID INT)\ngo\nCREATE OR ALTER PROCEDURE dbo.P AS SELECT 1\nGO\nCREATE OR REPLACE FORCE VIEW V AS SELECT 1 FROM DUAL;\nCREATE MATERIALIZED VIEW MV AS SELECT 1 FROM DUAL;\nCREATE OR REPLACE EDITIONABLE TRIGGER TRG BEFORE INSERT ON A\nBEGIN NULL; END;\n/\n";
		expect(createdObjects(text)).toEqual([
			{ object: "dbo.A", kind: "table" },
			{ object: "dbo.B", kind: "table" },
			{ object: "dbo.P", kind: "procedure" },
			{ object: "V", kind: "view" },
			{ object: "MV", kind: "view" },
			{ object: "TRG", kind: "trigger" },
		]);
		expect(outline("sql", "SELECT 1\nGO\nSELECT 2\nGO\n").map((item) => [item.line, item.endLine])).toEqual([[1, 1], [3, 3]]);
	});
});

describe("smaller things the readers got wrong", () => {
	test("a fence is closed only by its own mark with nothing after it", () => {
		const text = ["# One", "```", "```python", "# not a heading", "```", "## Two"].join("\n");
		expect(outline("markdown", text).map((item) => [item.name, item.children.map((c) => c.name)])).toEqual([["One", ["Two"]]]);
	});

	test("three quotes in a TOML comment open nothing", () => {
		expect(outline("toml", 'c = "x" # """\n[t]\nk = 1\n').map((item) => item.name)).toEqual(["c", "t"]);
	});

	test("a document nested deeper than the reader can follow is not called unreadable", () => {
		expect(jsonProblem("[".repeat(50_000) + "]".repeat(50_000))).toBeNull();
	});

	test("an SSL snippet's title cannot end its own comment", () => {
		expect(snippetTemplate({ title: "Count; then save", language: "ssl" }).split("\n")[0]).toBe("/* Count, then save");
	});

	test("a ticket system that numbers its tickets is read", () => {
		expect(ticketsFromJson([{ id: 4711, title: "Numeric id" }, { number: 12, title: "By number" }]).tickets.map((t) => t.key)).toEqual(["4711", "12"]);
	});

	test("the way from a folder to a file does not depend on the case of a drive's letter", () => {
		expect(relativePath("C:\\p\\docs\\knowledge\\questions", "c:\\p\\src\\a.ssl")).toBe("../../../src/a.ssl");
		expect(relativePath("/p/Docs", "/p/docs/a.md")).toBe("../docs/a.md");
	});
});

describe("a file manifest written again", () => {
	const file = (path: string, sha: string) => ({ path, kind: "script", bytes: 1, lines: 1, sha256: sha });

	test("a file renamed only in the case of its letters keeps its row, its status and its note", () => {
		const before = "path,kind,bytes,lines,sha256,status,note\nsrc/Old.ssl,script,1,1,aa,migrated,checked by hand\n";
		const change = mergeManifest(before, [file("src/old.ssl", "aa")]);
		expect(change.text).toBe("path,kind,bytes,lines,sha256,status,note\nsrc/old.ssl,script,1,1,aa,migrated,checked by hand\n");
		expect([change.added, change.gone, change.same]).toEqual([0, 0, 1]);
	});

	test("a cell beyond the columns is kept, and the file's line ends are", () => {
		expect(mergeManifest("path,kind,bytes,lines,sha256,status,note\nsrc/A.ssl,script,1,1,aa,found,n,EXTRA\n", [file("src/A.ssl", "aa")]).text).toContain("found,n,EXTRA");
		const dos = "path,kind,bytes,lines,sha256,status,note\r\nsrc/A.ssl,script,1,1,aa,found,\r\n";
		expect(mergeManifest(dos, [file("src/A.ssl", "aa")]).text).toBe(dos);
	});
});

describe("tickets that name each other as parent", () => {
	test("the ring is listed at the top, and what is under it stays under it", () => {
		const ticket = (key: string, parent?: string): DocFile => ({ path: `/p/docs/tickets/${key}.md`, name: `${key}.md`, group: "tickets", exists: true, ticket: key, status: "open", parent });
		const rows = workList([ticket("A", "B"), ticket("B", "A"), ticket("C", "A"), ticket("D", "C")], "/p").rows.map((row) => `${"  ".repeat(row.depth)}${row.file.ticket}`);
		expect(rows).toEqual(["A", "  C", "    D", "B"]);
	});
});

import { progress, progressShort } from "../src/shared/projectDocs";

describe("how far a registry is, in the room there is", () => {
	test("in words, and in as few characters as say the same", () => {
		const counted = { rows: 11, tally: { total: 11, by: [["migrated", 4], ["found", 3], ["verified", 3], ["", 1]] as [string, number][] } };
		expect(progress(counted)).toBe("7 of 11 done");
		expect(progressShort(counted)).toBe("7/11");
		expect(progress({ rows: 12 })).toBe("12 rows");
		expect(progressShort({ rows: 12 })).toBe("12");
	});
});

// A second review (2026-11-19), of the fixes above and of what was added after them.
import { marked } from "marked";
import { docChecks } from "../src/shared/docChecks";
import { withFrontMatter, plainMarkdown } from "../src/shared/frontMatter";
import { frontValue } from "../src/shared/projectDocs";
import { taskTally, tasks, toggleTask } from "../src/shared/tasks";

describe("second review: a catalog never takes a person's words", () => {
	test("with its end marker gone, a heading and bullets of the person's own are not taken for the list", () => {
		const text = "# Tickets\n\n<!-- catalog -->\n\n## Conventions\n\n- one ticket to a file\n- keys in capitals\n\nWritten by hand.\n";
		const after = withCatalog(text, []);
		for (const kept of ["## Conventions", "- one ticket to a file", "- keys in capitals", "Written by hand."]) expect(after).toContain(kept);
		expect(after.split(CATALOG_START).length).toBe(2);
		expect(withCatalog(after, [])).toBe(after);
	});

	test("markers shown as an example in a code fence are not the catalog's", () => {
		const text = `# Tickets\n\nIt looks like this:\n\n\`\`\`\n${CATALOG_START}\n- x\n${CATALOG_END}\n\`\`\`\n\n${CATALOG_START}\n\n- [Old](Old.md)\n\n${CATALOG_END}\n`;
		const after = withCatalog(text, [{ path: "A.md", title: "A" }]);
		expect(after).toContain(`\`\`\`\n${CATALOG_START}\n- x\n${CATALOG_END}\n\`\`\``);
		expect(after).toContain(`${CATALOG_START}\n\n- [A](A.md)\n\n${CATALOG_END}\n`);
		expect(after).not.toContain("[Old](Old.md)");
		expect(catalogStale(after, [{ path: "A.md", title: "A" }])).toBe(false);
	});

	test("the folder's own catalog is the one checked, not one a person keeps deeper in", () => {
		const file = (name: string, stale: boolean): DocFile => ({ path: `/p/docs/knowledge/${name}`, name, group: "knowledge", exists: true, catalog: { stale } });
		expect(docChecks([file("decisions/INDEX.md", false), file("INDEX.md", true)]).map((check) => check.text)).toEqual(["The catalog of knowledge/ is out of date."]);
	});
});

describe("second review: the boxes on the page are the items in the text", () => {
	const boxes = (text: string) => (marked.parse(frontMatter(text).body, { async: false, gfm: true }) as string).match(/<input[^>]*>/g)?.length ?? 0;
	const documents = [
		"<!--\n- [ ] dropped: prints in colour\n-->\n\n- [ ] the list has every sample\n- - [x] the count is right\n",
		"- [ ] \n  the list has every sample\n- [ ] second\n",
		"- [x] a\n\n<!--\n- [ ] dropped\n-->\n",
		"```sql``` is the tag.\n\n- [x] a\n- [ ] b\n",
		"- [ ] one\r\n  - [x] child\r\n> - [ ] quoted\r\n1. [X] numbered\r\n",
		"    - [ ] indented code\n\n- [ ] real\n",
		"- [ ] same\n\n```\n- [ ] same\n```\n\n- [ ] same\n",
		"---\ntitle: T\nnote: - [ ] not one\n---\n\n# T\n\n- [ ] first\n- [ ]\n- plain\n",
		"> ```\n> - [ ] in a quoted fence\n> ```\n\n- [x] after\n",
	];

	test("there are as many items as boxes, in every case", () => {
		for (const text of documents) expect([text, tasks(text).length]).toEqual([text, boxes(text)]);
	});

	test("ticking the first box changes the first item shown, never a line the page does not show", () => {
		const hidden = documents[0]!;
		expect(tasks(hidden).map((task) => task.text)).toEqual(["the list has every sample", "the count is right"]);
		expect(toggleTask(hidden, 0)).toBe(hidden.replace("- [ ] the list has every sample", "- [x] the list has every sample"));
		expect(toggleTask(hidden, 1)).toBe(hidden.replace("- - [x] the count", "- - [ ] the count"));
		expect(taskTally(documents[2]!)).toEqual({ done: 1, total: 1 });
		const twice = documents[6]!;
		expect(toggleTask(twice, 1)).toBe("- [ ] same\n\n```\n- [ ] same\n```\n\n- [x] same\n");
		const dos = documents[4]!;
		expect(toggleTask(dos, 2)).toBe(dos.replace("> - [ ] quoted", "> - [x] quoted"));
	});
});

describe("second review: front matter is written where it is read", () => {
	test("only the one line changes, so mixed line ends stay as they were", () => {
		expect(withFrontMatter("---\nstatus: open\n---\nline1\r\nline2\n", "status", "done")).toBe("---\nstatus: done\n---\nline1\r\nline2\n");
		expect(withFrontMatter("---\r\nticket: A-1\r\n---\r\nbody\n", "status", "open")).toBe("---\r\nticket: A-1\r\nstatus: open\r\n---\r\nbody\n");
	});

	test("a key written twice is set where it is read: at its last line", () => {
		const after = withFrontMatter("---\nstatus: a\nstatus: b\n---\n", "status", "done")!;
		expect(after).toBe("---\nstatus: a\nstatus: done\n---\n");
		expect(frontMatter(after).values.status).toBe("done");
	});

	test("a value with a line end in it is written on its one line", () => {
		expect(frontValue("In\nProgress")).toBe("In Progress");
		expect(frontMatter(ticketTemplate({ key: "A-1", title: "T", status: "In\r\nProgress" })).values.status).toBe("In Progress");
	});

	test("a character written with a backslash is itself, and bold inside italic comes off whole", () => {
		expect(plainMarkdown("\\*literal\\* and \\_this\\_")).toBe("*literal* and _this_");
		expect(plainMarkdown("***both*** and __*nested*__")).toBe("both and nested");
		expect(plainMarkdown("call(*args, **kwargs) and a * b * c")).toBe("call(*args, **kwargs) and a * b * c");
	});

	test("a summary is not cut through the middle of a character", () => {
		const summary = summaryOf(`# T\n\n${"x".repeat(138)}😀😀 y`);
		expect(/[\uD800-\uDBFF]…$/.test(summary)).toBe(false);
		expect(summary.endsWith("…")).toBe(true);
	});
});

describe("second review: batches, fences and strings", () => {
	test("GO ends a batch alone, with a count, or with a comment; a word that starts with it does not", () => {
		expect(createdObjects("CREATE TABLE a (x int)\nGO 5\nCREATE TABLE b (y int)\n  go -- next\nCREATE TABLE c (z int)\nGO\n").map((made) => made.object)).toEqual(["a", "b", "c"]);
		expect(outline("sql", "SELECT x FROM t WHERE\nGO          then more text\n = 1;").length).toBe(1);
	});

	test("a slash alone divides inside a statement and ends a batch between statements", () => {
		expect(outline("sql", "SELECT total\n/\ncount FROM t;").length).toBe(1);
		expect(outline("sql", "CREATE TABLE a (x int);\n/\nCREATE TABLE b (y int);\n/\n").map((item) => item.name)).toEqual(["CREATE TABLE a", "CREATE TABLE b"]);
	});

	test("a span of code that opens a line is not a fence, and escaped quotes do not end a TOML string", () => {
		expect(outline("markdown", "```sql``` is a tag\n\n# Real heading\n").map((item) => item.name)).toEqual(["Real heading"]);
		expect(outline("toml", 'a = """\n\\"""\nstill = 1\n"""\nb = 2\n').map((item) => item.name)).toEqual(["a", "b"]);
	});
});

describe("second review: the manifest and the import", () => {
	test("two rows that differ only in case do not both become the one file", () => {
		const before = "path,kind,bytes,lines,sha256,status,note\nsrc/A.ssl,script,1,1,aa,migrated,first\nsrc/a.SSL,script,1,1,aa,found,second\n";
		const change = mergeManifest(before, [{ path: "src/a.ssl", kind: "script", bytes: 1, lines: 1, sha256: "aa" }]);
		const paths = change.text.trim().split("\n").slice(1).map((line) => line.split(",")[0]);
		expect(paths.filter((path) => path === "src/a.ssl").length).toBe(1);
		expect(change.text).toContain("src/a.ssl,script,1,1,aa,migrated,first");
		expect(change.text).toContain("gone,second");
	});

	test("the ticket system's own numbers are not taken for tickets in what an API returns either", () => {
		const [ticket] = ticketsFromJson({ key: "DEMO-103", fields: { summary: "S", parent: { id: 10002 }, issuelinks: [{ outwardIssue: { id: 10005 } }, { inwardIssue: { key: "DEMO-101" } }] } }).tickets;
		expect([ticket!.parent, ticket!.related]).toEqual([undefined, ["DEMO-101"]]);
	});
});
