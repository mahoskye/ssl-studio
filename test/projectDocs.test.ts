import { describe, expect, test } from "bun:test";
import { catalogBlock, catalogLine, catalogList, catalogStale, withCatalog, CATALOG_END, CATALOG_START } from "../src/shared/catalog";
import { columnOf, csvCell, csvRow, parseCsv, tally } from "../src/shared/csv";
import { frontMatter, many, one, summaryOf, titleOf } from "../src/shared/frontMatter";
import { catalogTemplate, decisionTemplate, questionTemplate, slug, specTemplate, ticketKey, ticketTemplate, toneOf } from "../src/shared/projectDocs";

describe("front matter", () => {
	test("values, a list on one line and a list as dashes are read", () => {
		const text = `---\nticket: LIMS-12\ntitle: "Due dates: the rule"\nrelated: [LIMS-10, "LIMS-11"]\nspecs:\n  - design/A.spec.md\n  - docs/specs/b.md\n# a comment\nstatus: in progress\n---\n# Heading\n\nBody.`;
		const { values, lines, body } = frontMatter(text);
		expect(values).toEqual({ ticket: "LIMS-12", title: "Due dates: the rule", related: ["LIMS-10", "LIMS-11"], specs: ["design/A.spec.md", "docs/specs/b.md"], status: "in progress" });
		expect(lines).toBe(10);
		expect(body).toBe("# Heading\n\nBody.");
	});

	test("a document with none, or with a block that never closes, is all body", () => {
		expect(frontMatter("# Title\n\ntext")).toEqual({ values: {}, lines: 0, body: "# Title\n\ntext" });
		expect(frontMatter("---\ntitle: x\n# no end").lines).toBe(0);
		expect(frontMatter("text\n---\ntitle: x\n---").values).toEqual({});
	});

	test("keys are read whatever their case, and a key with nothing is empty", () => {
		expect(frontMatter("---\nStatus: Done\nrelated:\n---\n").values).toEqual({ status: "Done", related: "" });
	});

	test("one value or a list, as asked", () => {
		expect(one(["a", "b"])).toBe("a, b");
		expect(many("LIMS-1, LIMS-2")).toEqual(["LIMS-1", "LIMS-2"]);
		expect(many(undefined)).toEqual([]);
	});

	test("a title is the front matter's, or the first heading", () => {
		expect(titleOf("---\ntitle: Said\n---\n# Heading")).toBe("Said");
		expect(titleOf("intro\n\n## The `first` heading ##\n")).toBe("The first heading");
		expect(titleOf("no heading")).toBe("");
	});

	test("a summary is the front matter's, or the first sentence of the first paragraph", () => {
		expect(summaryOf("---\nsummary: Said so.\n---\ntext")).toBe("Said so.");
		expect(summaryOf("# Title\n\nThe **first** sentence. The second.\n\nMore.")).toBe("The first sentence.");
		expect(summaryOf("# Title\n\n- a list\n\n| a | b |\n\nThen [a link](x.md) here")).toBe("Then a link here");
		expect(summaryOf("# Only a title")).toBe("");
		expect(summaryOf(`x\n\n${"word ".repeat(60)}`).length).toBeLessThanOrEqual(140);
	});
});

describe("a table of values", () => {
	test("is read with each cell's place in the text", () => {
		const text = 'name,value,status\nA,"1, 2",done\nB,"say ""hi""",\n';
		const table = parseCsv(text);
		expect(table.header.map((c) => c.text)).toEqual(["name", "value", "status"]);
		expect(table.rows.map((r) => r.map((c) => c.text))).toEqual([
			["A", "1, 2", "done"],
			["B", 'say "hi"', ""],
		]);
		const cell = table.rows[0]![1]!;
		expect(text.slice(cell.start, cell.end)).toBe('"1, 2"');
		expect(table.problems).toEqual([]);
	});

	test("tabs separate when the first row has tabs and no commas; blank lines are passed over", () => {
		const table = parseCsv("a\tb\r\n\r\n1\t2\r\n");
		expect(table.delimiter).toBe("\t");
		expect(table.rows.map((r) => r.map((c) => c.text))).toEqual([["1", "2"]]);
	});

	test("what is wrong with it is said in words", () => {
		expect(parseCsv("").problems).toEqual(["It has no first row to name its columns."]);
		const table = parseCsv("a,,A\n1,2\n1,2,3,4\n1,2,3\n");
		expect(table.problems).toEqual(["1 column has no name.", "More than one column is named A.", "2 rows have more or fewer cells than there are columns."]);
	});

	test("a value is quoted only when it must be", () => {
		expect(csvCell("plain")).toBe("plain");
		expect(csvCell("a,b")).toBe('"a,b"');
		expect(csvCell('say "hi"')).toBe('"say ""hi"""');
		expect(csvCell(" padded")).toBe('" padded"');
		expect(csvCell("a,b", "\t")).toBe("a,b");
		expect(csvRow(["a", "b,c"])).toBe('a,"b,c"');
	});

	test("what is written is read back the same", () => {
		const values = ["a,b", 'q"q', "line\nbreak", "", " x "];
		expect(parseCsv(`${csvRow(["h1", "h2", "h3", "h4", "h5"])}\n${csvRow(values)}\n`).rows[0]!.map((c) => c.text)).toEqual(values);
	});

	test("a status column is tallied, whatever its case, most first", () => {
		const table = parseCsv("name,Status\na,done\nb,Done\nc,\nd,open\n");
		expect(columnOf(table, "status")).toBe(1);
		expect(tally(table)).toEqual({ total: 4, by: [["done", 2], ["", 1], ["open", 1]] });
		expect(tally(parseCsv("name\na\n"))).toBeNull();
	});
});

describe("a catalog", () => {
	const items = [
		{ path: "LIMS-2.md", title: "LIMS-2: Second", status: "open" },
		{ path: "LIMS-10.md", title: "LIMS-10: Tenth", status: "done", summary: "What it is about" },
	];

	test("has a line for each document: its title as a link, its status, what it is about", () => {
		expect(catalogLine(items[1]!)).toBe("- [LIMS-10: Tenth](LIMS-10.md): done. What it is about.");
		expect(catalogLine({ path: "a b/c.md", title: "With [brackets]" })).toBe("- [With \\[brackets\\]](a%20b/c.md)");
	});

	test("lists by path, numbers in their order, and under sections where there are any", () => {
		expect(catalogList(items).split("\n").map((l) => l.slice(3, 9))).toEqual(["LIMS-2", "LIMS-1"]);
		const sectioned = catalogList([
			{ path: "questions/q.md", title: "Q", section: "Questions" },
			{ path: "decisions/d.md", title: "D", section: "Decisions" },
		]);
		expect(sectioned).toBe("### Questions\n\n- [Q](questions/q.md)\n\n### Decisions\n\n- [D](decisions/d.md)");
		expect(catalogList([])).toBe("Nothing here yet.");
	});

	test("is written between its markers, and the rest of the file is left as it is", () => {
		const before = `# Tickets\n\nMine.\n\n${CATALOG_START}\nold\n${CATALOG_END}\n\nAfter.\n`;
		const after = withCatalog(before, items);
		expect(after.startsWith("# Tickets\n\nMine.\n\n")).toBe(true);
		expect(after.endsWith("\n\nAfter.\n")).toBe(true);
		expect(catalogBlock(after)!.inner).toBe(catalogList(items));
		expect(withCatalog(after, items)).toBe(after);
	});

	test("a file with no markers gets the list at its end", () => {
		const after = withCatalog("# Notes\n", items);
		expect(after.startsWith("# Notes\n\n<!-- catalog -->")).toBe(true);
		expect(catalogStale(after, items)).toBe(false);
	});

	test("is out of date when a document is added, retitled or in another state", () => {
		const text = withCatalog("", items);
		expect(catalogStale(text, items)).toBe(false);
		expect(catalogStale(text, [...items, { path: "LIMS-3.md", title: "New" }])).toBe(true);
		expect(catalogStale(text, [{ ...items[0]!, status: "done" }, items[1]!])).toBe(true);
		expect(catalogStale("# no markers", items)).toBe(true);
	});
});

describe("what a project's documents start as", () => {
	test("a ticket has its key, title and state in its front matter", () => {
		const { values } = frontMatter(ticketTemplate({ key: "LIMS-123", title: "Due dates: skip holidays", source: "https://example.test/LIMS-123" }));
		expect(values).toEqual({ ticket: "LIMS-123", title: "Due dates: skip holidays", source: "https://example.test/LIMS-123", status: "open", related: "" });
	});

	test("a spec, a decision and a question say what they are for and what state they are in", () => {
		expect(frontMatter(specTemplate({ title: "Set due dates", ticket: "LIMS-123" })).values).toEqual({ title: "Set due dates", ticket: "LIMS-123", status: "draft" });
		expect(frontMatter(decisionTemplate({ title: "Use CSV", date: "2026-11-19" })).values).toEqual({ title: "Use CSV", status: "proposed", date: "2026-11-19" });
		expect(frontMatter(questionTemplate({ title: "Who owns it?", date: "2026-11-19" })).values.status).toBe("open");
	});

	test("a catalog starts with an empty list between its markers", () => {
		const text = catalogTemplate("knowledge");
		expect(catalogBlock(text)!.inner).toBe("Nothing here yet.");
		expect(catalogStale(text, [])).toBe(false);
	});

	test("a file name is made from a title, and a ticket's key is tidied", () => {
		expect(slug("Use CSV for the registries!")).toBe("Use-CSV-for-the-registries");
		expect(slug("  Länge & more  ")).toBe("Lange-more");
		expect(slug("...")).toBe("");
		expect(ticketKey(" lims 123 ")).toBe("LIMS-123");
		expect(ticketKey("PROJ-9/../x")).toBe("PROJ-9X");
	});

	test("a status comes to done, under way, waiting or set aside", () => {
		expect(toneOf("Done")).toBe("done");
		expect(toneOf("in progress")).toBe("active");
		expect(toneOf("open")).toBe("waiting");
		expect(toneOf("")).toBe("waiting");
		expect(toneOf("superseded")).toBe("off");
		expect(toneOf("something of ours")).toBe("active");
	});
});

import { FOUND, GONE, manifestSummary, mergeManifest } from "../src/shared/manifest";

describe("a file manifest", () => {
	const file = (path: string, sha256: string, bytes = 10) => ({ path, kind: "script", bytes, lines: 2, sha256 });

	test("starts with a row for each file, found", () => {
		const { text, added } = mergeManifest(null, [file("src/A.ssl", "aa"), file("src/B.ssl", "bb")]);
		expect(text).toBe("path,kind,bytes,lines,sha256,status,note\nsrc/A.ssl,script,10,2,aa,found,\nsrc/B.ssl,script,10,2,bb,found,\n");
		expect(added).toBe(2);
	});

	test("written again, it keeps the status and the note, and a column of the person's own", () => {
		const before = "path,owner,kind,bytes,lines,sha256,status,note\nsrc/A.ssl,Ana,script,10,2,aa,migrated,\"checked, twice\"\n";
		const change = mergeManifest(before, [file("src/A.ssl", "aa")]);
		expect(change.text).toBe(before);
		expect(change).toMatchObject({ added: 0, changed: 0, gone: 0, same: 1 });
	});

	test("says what is new, what has changed and what has gone", () => {
		const before = "path,kind,bytes,lines,sha256,status,note\nsrc/A.ssl,script,10,2,aa,migrated,\nsrc/Old.ssl,script,10,2,oo,verified,keep this\n";
		const change = mergeManifest(before, [file("src/A.ssl", "a2", 12), file("src/New.ssl", "nn")]);
		expect(change).toMatchObject({ added: 1, changed: 1, gone: 1, same: 0 });
		const rows = change.text.trim().split("\n");
		expect(rows[1]).toBe("src/A.ssl,script,12,2,a2,migrated,");
		expect(rows[2]).toBe(`src/Old.ssl,script,10,2,oo,${GONE},keep this`);
		expect(rows[3]).toBe(`src/New.ssl,script,10,2,nn,${FOUND},`);
		expect(manifestSummary(change)).toBe("File manifest: 2 files; 1 new, 1 changed, 1 gone.");
	});

	test("a file that had gone and is back is found again, and is not counted as gone twice", () => {
		const before = "path,kind,bytes,lines,sha256,status,note\nsrc/A.ssl,script,10,2,aa,gone,\nsrc/B.ssl,script,10,2,bb,gone,\n";
		const change = mergeManifest(before, [file("src/A.ssl", "aa")]);
		expect(change.text.split("\n")[1]).toBe("src/A.ssl,script,10,2,aa,found,");
		expect(change.gone).toBe(0);
		expect(manifestSummary(mergeManifest(change.text, [file("src/A.ssl", "aa")]))).toBe("File manifest: 1 file, none changed.");
	});

	test("a table with other columns gets the ones it needs", () => {
		const change = mergeManifest("path,status\nsrc/A.ssl,migrated\n", [file("src/A.ssl", "aa")]);
		expect(change.text).toBe("path,status,kind,bytes,lines,sha256\nsrc/A.ssl,migrated,script,10,2,aa\n");
	});
});

import { join } from "node:path";
import { fileManifest, listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { catalogItems } from "../src/shared/projectDocs";

describe("the demo project's working documents", () => {
	const root = join(import.meta.dir, "..", "examples", "due-dates");
	const listed = async () => listDocs(new WorkspaceFiles(root), await readProject(root));

	test("its tickets are listed with their keys, states and the tickets they are related to", async () => {
		const tickets = (await listed()).filter((d) => d.group === "tickets" && !d.catalog);
		expect(tickets.map((t) => [t.ticket, t.status])).toEqual([["DEMO-101", "done"], ["DEMO-102", "done"], ["DEMO-103", "in progress"]]);
		expect(tickets[0]).toMatchObject({ title: "Give every waiting sample a due date", tickets: ["DEMO-102", "DEMO-103"], specs: ["design/SetSampleDueDates.spec.md"] });
	});

	test("a spec the planner wrote beside a plan is a spec, and is not listed with the plans", async () => {
		const docs = await listed();
		expect(docs.filter((d) => d.group === "specs" && !d.catalog).map((d) => d.name.split("\\").join("/"))).toEqual(["Due-soon-report.md", "design/SetSampleDueDates.spec.md"]);
		expect(docs.filter((d) => d.group === "plans").map((d) => d.name)).toEqual(["SetSampleDueDates.plan.json"]);
		expect(docs.find((d) => d.name === "Due-soon-report.md")).toMatchObject({ tickets: ["DEMO-103"], status: "in progress" });
	});

	test("the knowledge base says what kind each thing is, and a snippet is titled by its first comment", async () => {
		const knowledge = (await listed()).filter((d) => d.group === "knowledge" && !d.catalog);
		expect([...new Set(knowledge.map((d) => d.kind))]).toEqual(["decisions", "questions", "reference", "snippets"]);
		expect(knowledge.find((d) => d.name.endsWith("Samples-with-no-due-date.sql"))).toMatchObject({ title: "Samples with no due date", summary: "The samples the due-date job will look at next. Read only." });
	});

	test("a registry says how many rows it has and how far they are", async () => {
		const settings = (await listed()).find((d) => d.group === "registries" && d.name === "settings.csv")!;
		expect(settings.rows).toBe(10);
		expect(settings.tally).toEqual({ total: 10, by: [["migrated", 4], ["found", 3], ["verified", 3]] });
		expect(settings.problems).toBeUndefined();
	});

	test("every catalog says what its folder holds, and the documents outside those folders are still Docs", async () => {
		const docs = await listed();
		expect(docs.filter((d) => d.catalog).map((d) => [d.group, d.catalog!.stale])).toEqual([["tickets", false], ["specs", false], ["knowledge", false], ["registries", false]]);
		expect(docs.filter((d) => d.group === "docs").map((d) => d.name)).toEqual(["Decisions.md", "README.md", "Worked-examples.md"]);
		expect(docs.find((d) => d.name === "STATE.md")?.group).toBe("project");
		expect(catalogItems("tickets", docs, join(root, "docs")).map((item) => item.title)[0]).toBe("DEMO-101: Give every waiting sample a due date");
	});

	test("the file manifest is of the project's work, not of the documents about it", async () => {
		const files = await fileManifest(new WorkspaceFiles(root), await readProject(root));
		expect(files.some((f) => f.path === "src/DueDates/DueRule.ssl" && f.kind === "script" && f.sha256.length === 64)).toBe(true);
		expect(files.some((f) => f.path.startsWith("docs/") || f.path.startsWith("design/") || f.path.startsWith(".ssl-studio/") || !f.path.includes("/"))).toBe(false);
	});
});
