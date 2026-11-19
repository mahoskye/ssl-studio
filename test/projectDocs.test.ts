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

	test("is the same catalog whichever line ends the file has, and is written in the file's own", () => {
		const items = [{ path: "a.md", title: "A", status: "done" }, { path: "b.md", title: "B" }];
		const dos = withCatalog("# T\n\nMine.\n", items).replace(/\n/g, "\r\n");
		expect(catalogStale(dos, items)).toBe(false);
		expect(catalogStale(dos, items.slice(0, 1))).toBe(true);
		const again = withCatalog(dos, [...items, { path: "c.md", title: "C" }]);
		expect(again).toContain("- [B](b.md)\r\n- [C](c.md)\r\n\r\n<!-- /catalog -->");
		expect(again.replace(/\r\n/g, "")).not.toContain("\n");
		expect(withCatalog("# T\r\n", items)).toBe(`# T\r\n\r\n${CATALOG_START}\r\n\r\n- [A](a.md): done.\r\n- [B](b.md)\r\n\r\n${CATALOG_END}\r\n`);
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
import { ticketAtHand, workFor, workLabel, workText } from "../src/shared/workContext";

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

	test("what its documents need from someone is one open question, and nothing is wrong", async () => {
		const checks = docChecks(await listed());
		expect(checks.map((check) => [check.level, check.text])).toEqual([["note", "1 question is open: Which holidays does each site keep?"]]);
		expect(checksSummary(checks)).toBe("1 to know");
	});

	test("the work a ticket is: its spec, the tickets around it, what is not known and what was decided", async () => {
		const docs = await listed();
		const work = workFor(docs, "demo-103")!;
		expect(workLabel(work)).toBe("DEMO-103, 1 spec, 1 related ticket, 1 open question, 2 decisions");
		expect(workLabel(work, { specs: false })).toBe("DEMO-103, 1 related ticket, 1 open question, 2 decisions");
		const text = await workText(work, (path) => Bun.file(path).text());
		expect(text).toStartWith("THE WORK THIS IS FOR, from the project's own documents:\nTICKET DEMO-103: A report of the samples due soon (in progress)\n");
		expect(text).toContain("## What done looks like");
		expect(text).not.toContain("ticket: DEMO-103");
		expect(text).toContain("RELATED TICKETS:\n- DEMO-101: Give every waiting sample a due date (done).");
		expect(text).toContain("SPEC The report of samples due soon (in progress):");
		expect(text).toContain("QUESTIONS NOBODY HAS ANSWERED YET (do not guess the answer; say what depends on it):\n- Which holidays does each site keep? (open).");
		expect(text).toContain("DECISIONS ALREADY MADE (keep to them):\n- A walk looks at most 730 days ahead (accepted).");
		expect(await workText(work, (path) => Bun.file(path).text(), { specs: false })).not.toContain("SPEC ");
		// A question that was answered for the ticket comes with its answer.
		const rush = await workText(workFor(docs, "DEMO-102")!, (path) => Bun.file(path).text());
		expect(rush).toMatch(/QUESTIONS THAT WERE ANSWERED:\n- Does rush work count Sunday\? Answer: \S/);
		expect(workFor(docs, "DEMO-999")).toBeNull();
	});

	test("a spec the planner wrote is for the ticket its plan names", async () => {
		expect((await listed()).find((d) => d.name.endsWith("SetSampleDueDates.spec.md"))?.tickets).toEqual(["DEMO-101"]);
	});

	test("the ticket at hand is the open document's, or the one ticket under way", async () => {
		const docs = await listed();
		const at = (name: string) => docs.find((d) => d.name.endsWith(name))!.path;
		expect(ticketAtHand(docs, at("DEMO-102.md"))).toBe("DEMO-102");
		expect(ticketAtHand(docs, at("Does-rush-work-count-Sunday.md"))).toBe("DEMO-102");
		expect(ticketAtHand(docs, at("SetSampleDueDates.spec.md"))).toBe("DEMO-101");
		// A script says nothing of a ticket: the one that is under way.
		expect(ticketAtHand(docs, join(root, "src", "DueDates", "DueRule.ssl"))).toBe("DEMO-103");
		expect(ticketAtHand(docs)).toBe("DEMO-103");
		expect(ticketAtHand(docs.map((d) => (d.ticket === "DEMO-102" ? { ...d, status: "in progress" } : d)))).toBe("");
		expect(ticketAtHand([])).toBe("");
	});

	test("the file manifest is of the project's work, not of the documents about it", async () => {
		const files = await fileManifest(new WorkspaceFiles(root), await readProject(root));
		expect(files.some((f) => f.path === "src/DueDates/DueRule.ssl" && f.kind === "script" && f.sha256.length === 64)).toBe(true);
		expect(files.some((f) => f.path.startsWith("docs/") || f.path.startsWith("design/") || f.path.startsWith(".ssl-studio/") || !f.path.includes("/"))).toBe(false);
	});
});

import { checksSummary, docChecks } from "../src/shared/docChecks";
import { localDay } from "../src/shared/dates";
import { isPrompt, PROMPTS, snippetTemplate } from "../src/shared/projectDocs";
import type { DocFile } from "../src/shared/protocol";

describe("what the working documents need", () => {
	const file = (group: DocFile["group"], name: string, more: Partial<DocFile> = {}): DocFile => ({ path: `/p/docs/${group}/${name}`, name, group, exists: true, ...more });
	const texts = (files: DocFile[]) => docChecks(files).map((check) => check.text);

	test("nothing, when there is nothing amiss", () => {
		expect(docChecks([])).toEqual([]);
		expect(checksSummary([])).toBe("");
		expect(texts([file("tickets", "A-1.md", { ticket: "A-1", status: "open" }), file("tickets", "INDEX.md", { catalog: { stale: false } })])).toEqual([]);
	});

	test("a catalog out of date, and a folder with documents and no catalog, can both be put right", () => {
		const checks = docChecks([file("tickets", "A-1.md", { ticket: "A-1" }), file("tickets", "INDEX.md", { catalog: { stale: true } }), file("knowledge", "decisions/0001-x.md", { kind: "decisions" })]);
		expect(checks.map((check) => [check.level, check.text, check.fix?.kind])).toEqual([
			["warn", "The catalog of tickets/ is out of date.", "catalogs"],
			["note", "knowledge/ has no catalog (INDEX.md).", "catalogs"],
		]);
		// One update writes every catalog, so several are one thing to do.
		expect(texts([file("tickets", "INDEX.md", { catalog: { stale: true } }), file("specs", "INDEX.md", { catalog: { stale: true } }), file("registries", "INDEX.md", { catalog: { stale: true } })])).toEqual(["The catalogs of tickets/, specs/ and registries/ are out of date."]);
		// The planner's specs are beside their plans: with no specs folder there is no catalog to miss.
		expect(texts([file("specs", "design/A.spec.md")])).toEqual([]);
	});

	test("a registry that does not read as a table, and a spec that is not where its ticket says, are wrong", () => {
		const checks = docChecks([file("registries", "settings.csv", { problems: ["Row 3 has 4 cells, and the first row names 5."] }), file("tickets", "A-1.md", { ticket: "A-1", missing: ["design/Gone.spec.md"] }), file("tickets", "INDEX.md", { catalog: { stale: false } }), file("registries", "INDEX.md", { catalog: { stale: false } })]);
		expect(checks.map((check) => check.level)).toEqual(["warn", "warn"]);
		expect(checks.map((check) => check.text)).toEqual(["Application settings: Row 3 has 4 cells, and the first row names 5.", "A-1 names a spec that is not there: design/Gone.spec.md"]);
		expect(checksSummary(checks)).toBe("2 to fix");
	});

	test("a ticket that is named and not there can be started, and is said once", () => {
		const catalog = file("tickets", "INDEX.md", { catalog: { stale: false } });
		const checks = docChecks([catalog, file("tickets", "A-1.md", { ticket: "A-1", title: "First", tickets: ["A-2", "a-1"] }), file("specs", "S.md", { tickets: ["a-2", "A-1"] }), file("specs", "INDEX.md", { catalog: { stale: false } })]);
		expect(checks).toEqual([{ level: "note", text: "A-2 is not among the tickets; A-1 names it.", path: "/p/docs/tickets/A-1.md", fix: { kind: "ticket", key: "A-2", related: "A-1" } }]);
		expect(frontMatter(ticketTemplate({ key: "A-2", title: "Second", related: ["A-1"] })).values.related).toEqual(["A-1"]);
	});

	test("a finished ticket whose spec is not, a document still its template, and the open questions are worth knowing", () => {
		const catalogs = [file("tickets", "INDEX.md", { catalog: { stale: false } }), file("specs", "INDEX.md", { catalog: { stale: false } }), file("knowledge", "INDEX.md", { catalog: { stale: false } })];
		const got = texts([
			...catalogs,
			file("tickets", "A-1.md", { ticket: "A-1", status: "Done" }),
			file("specs", "S.md", { title: "The thing", status: "draft", tickets: ["A-1"] }),
			file("specs", "T.md", { title: "Another", status: "done", tickets: ["A-1"] }),
			file("knowledge", "decisions/0001-x.md", { kind: "decisions", title: "Use CSV", untouched: true }),
			file("knowledge", "questions/a.md", { kind: "questions", title: "Who owns it?", status: "open" }),
			file("knowledge", "questions/b.md", { kind: "questions", title: "When?", status: "open" }),
			file("knowledge", "questions/c.md", { kind: "questions", title: "Why?", status: "answered" }),
		]);
		expect(got).toEqual(["Not written yet: Use CSV", "A-1 is Done; its spec is draft: The thing", "2 questions are open."]);
	});
});

describe("a new document's own words", () => {
	test("the line a template starts with is known for what it is", () => {
		expect(isPrompt(summaryOf(ticketTemplate({ key: "A-1", title: "T" })))).toBe(true);
		expect(isPrompt(summaryOf(specTemplate({ title: "T" })))).toBe(true);
		expect(isPrompt(summaryOf(decisionTemplate({ title: "T", date: "2026-11-18" })))).toBe(true);
		expect(isPrompt(summaryOf(questionTemplate({ title: "T", date: "2026-11-18" })))).toBe(true);
		expect(snippetTemplate({ title: "T", language: "sql" })).toContain(`-- ${PROMPTS.sql}`);
		expect(isPrompt("The rule in words.")).toBe(false);
		expect(isPrompt(undefined)).toBe(false);
	});

	test("a day is the day it is here, not in UTC", () => {
		expect(localDay(new Date(2026, 10, 18, 23, 52))).toBe("2026-11-18");
		expect(localDay(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
	});
});

import { newPlan, parsePlan, printPlan } from "../src/view/plan/model";
import { planHash, refinePrompt } from "../src/view/plan/assist";

describe("a plan's ticket", () => {
	test("is written with its title, read back, and does not make the plan a different plan", () => {
		const plain = newPlan("Release a sample");
		const plan = { ...plain, ticket: "LIMS-7" };
		const text = printPlan(plan);
		expect(text.indexOf('"ticket": "LIMS-7"')).toBeLessThan(text.indexOf('"nodes"'));
		expect(parsePlan(text).plan?.ticket).toBe("LIMS-7");
		expect(planHash(plan)).toBe(planHash(plain));
	});

	test("the work it is for goes to the planner with what else it is told", () => {
		expect(refinePrompt(newPlan("x"), "SURVEY", "THE WORK THIS IS FOR:\nTICKET LIMS-7")).toEndWith("SURVEY\n\nTHE WORK THIS IS FOR:\nTICKET LIMS-7");
	});
});

import { withFrontMatter } from "../src/shared/frontMatter";
import { importSummary, ticketsFromJson, ticketsFromTable } from "../src/shared/ticketImport";

describe("tickets from a ticket system's export", () => {
	// Invented, in the shape such an export has: a column for each kind of link, some of them twice, and people.
	const exported = [
		"Summary,Issue key,Issue id,Issue Type,Status,Assignee,Reporter,Description,Outward issue link (Relates),Outward issue link (Relates),Inward issue link (Blocks),Parent key",
		'A report of the samples due soon,DEMO-103,10003,Story,In Progress,Someone,Someone Else,"Each morning the lab wants a list.',
		"",
		'It is sorted, ""soonest first"".",DEMO-101,DEMO-102,,DEMO-100',
		"Rush samples count Saturday,demo-102,10002,Bug,Done,,,,DEMO-101,,DEMO-103,",
		",DEMO-999,10999,Task,Open,,,No title: not a ticket,,,,",
	].join("\r\n");

	test("a table gives each row with a key and a title, its links and its parent, and no people", () => {
		const { tickets, skipped, problem } = ticketsFromTable(parseCsv(exported));
		expect(problem).toBeUndefined();
		expect(skipped).toBe(1);
		expect(tickets).toEqual([
			{ key: "DEMO-103", title: "A report of the samples due soon", status: "In Progress", type: "Story", source: undefined, parent: "DEMO-100", related: ["DEMO-101", "DEMO-102"], description: 'Each morning the lab wants a list.\n\nIt is sorted, "soonest first".' },
			{ key: "DEMO-102", title: "Rush samples count Saturday", status: "Done", type: "Bug", source: undefined, parent: undefined, related: ["DEMO-101", "DEMO-103"], description: "" },
		]);
		expect(JSON.stringify(tickets)).not.toContain("Someone");
	});

	test("a table of work items is read by the names it uses, and one with no key or title column says so", () => {
		const { tickets } = ticketsFromTable(parseCsv("ID,Work Item Type,Title,State,URL\n41,Task,Check the holidays,To Do,https://tickets.example.test/41\n"));
		expect(tickets).toEqual([{ key: "41", title: "Check the holidays", status: "To Do", type: "Task", source: "https://tickets.example.test/41", parent: undefined, related: [], description: "" }]);
		expect(ticketsFromTable(parseCsv("name,value\na,b\n")).problem).toBe("It has no column for a ticket's key (Issue key, Key, ID).");
		expect(ticketsFromTable(parseCsv("key,value\na,b\n")).problem).toBe("It has no column for a ticket's title (Summary, Title).");
	});

	test("what an API returns is read: one issue, a list, or a list under issues, with a description that is a tree", () => {
		const issue = {
			key: "DEMO-103",
			fields: {
				summary: "A report of the samples due soon",
				status: { name: "In Progress" },
				issuetype: { name: "Story" },
				assignee: { displayName: "Someone" },
				parent: { key: "DEMO-100" },
				issuelinks: [{ outwardIssue: { key: "DEMO-101" } }, { inwardIssue: { key: "DEMO-102" } }, { outwardIssue: { key: "DEMO-103" } }],
				description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Each morning the lab wants a list." }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "soonest first" }] }] }] }] },
			},
		};
		const expected = { key: "DEMO-103", title: "A report of the samples due soon", status: "In Progress", type: "Story", source: undefined, parent: "DEMO-100", related: ["DEMO-101", "DEMO-102"], description: "Each morning the lab wants a list.\n\n- soonest first" };
		expect(ticketsFromJson(issue).tickets).toEqual([expected]);
		expect(ticketsFromJson([issue]).tickets).toEqual([expected]);
		expect(ticketsFromJson({ issues: [issue, { key: "DEMO-1" }] })).toEqual({ tickets: [expected], skipped: 1 });
		expect(ticketsFromJson({ key: "A-1", summary: "Plain", status: "open", description: "As text." }).tickets[0]).toMatchObject({ key: "A-1", title: "Plain", status: "open", description: "As text." });
		expect(ticketsFromJson("nothing").problem).toBeDefined();
	});

	test("an imported ticket's file says what the ticket system said, and its own words are what was asked", () => {
		const [ticket] = ticketsFromTable(parseCsv(exported)).tickets;
		const text = ticketTemplate(ticket!);
		expect(frontMatter(text).values).toEqual({ ticket: "DEMO-103", title: "A report of the samples due soon", type: "Story", status: "In Progress", parent: "DEMO-100", related: ["DEMO-101", "DEMO-102"] });
		expect(text).toContain('## What is asked\n\nEach morning the lab wants a list.\n\nIt is sorted, "soonest first".\n\n## What done looks like');
		expect(summaryOf(text)).toBe("Each morning the lab wants a list.");
		expect(toneOf("In Progress")).toBe("active");
	});

	test("one value of a document's front matter is set, and nothing else in it changes", () => {
		const text = "---\nticket: A-1\nstatus: open\nrelated:\n  - A-2\n---\n\n# A-1\n\nMine.\n";
		expect(withFrontMatter(text, "status", "Done")).toBe(text.replace("status: open", "status: Done"));
		expect(withFrontMatter(text, "type", "Bug")).toBe(text.replace("  - A-2\n---", "  - A-2\ntype: Bug\n---"));
		expect(withFrontMatter(text, "related", "[A-3]")).toBeNull();
		expect(withFrontMatter("# Plain\n", "status", "open")).toBe("---\nstatus: open\n---\n\n# Plain\n");
		const dos = text.replace(/\n/g, "\r\n");
		expect(withFrontMatter(dos, "status", "Done")).toBe(dos.replace("status: open", "status: Done"));
	});

	test("what an import came to is said in a sentence", () => {
		expect(importSummary({ made: 2, updated: 1, same: 3, skipped: 0 })).toBe("6 tickets: 2 new, 1 updated, 3 as they were.");
		expect(importSummary({ made: 1, updated: 0, same: 0, skipped: 2 })).toBe("1 ticket: 1 new. 2 without a key or a title were passed over.");
		expect(importSummary({ made: 0, updated: 0, same: 0, skipped: 1 })).toBe("No tickets: 1 row has no key or no title.");
		expect(importSummary({ made: 0, updated: 0, same: 0, skipped: 0 })).toBe("No tickets there.");
	});
});
