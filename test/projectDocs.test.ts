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

	test("a parent or a link given as the ticket system's own number is not taken for a ticket, and a field of its own is read by its name", () => {
		const { tickets } = ticketsFromTable(parseCsv("Issue key,Summary,Parent,Custom field (Epic Link),Outward issue link (Relates)\nDEMO-5,Five,10002,DEMO-1,\"DEMO-2, 10003\"\nDEMO-6,Six,10002,,\n"));
		// A parent that is only a number nobody could find falls through to the epic the ticket is linked to.
		expect(tickets.map((t) => [t.key, t.parent, t.related])).toEqual([["DEMO-5", "DEMO-1", ["DEMO-2"]], ["DEMO-6", undefined, []]]);
		const epic = ticketsFromTable(parseCsv("Issue key,Summary,Custom field (Epic Link)\nDEMO-5,Five,DEMO-1\n")).tickets[0]!;
		expect(epic.parent).toBe("DEMO-1");
		// Where tickets are numbers, a number is a ticket.
		expect(ticketsFromTable(parseCsv("ID,Title,Parent\n41,Check,40\n")).tickets[0]!.parent).toBe("40");
		expect(ticketsFromJson({ key: "A-1", fields: { summary: "S", "sub-tasks": [{ outwardIssue: { key: "A-2" } }], subtasks: [{ key: "A-3" }] } }).tickets[0]!.related).toEqual(["A-3", "A-2"]);
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

import { jsonProblem } from "../src/shared/jsonCheck";

describe("a JSON document that cannot be read", () => {
	const at = (text: string) => {
		const problem = jsonProblem(text);
		return problem && [text.slice(problem.offset, problem.offset + problem.length), problem.message];
	};

	test("what JSON.parse reads has nothing wrong with it, and an empty document is not yet a problem", () => {
		for (const text of ['{"a": [1, -2.5e3, true, null, "x\\n\\u00e9"], "b": {}}', "[]", ' "alone" ', "0", '{"a":{"b":[{"c":[]}]}}']) {
			expect(() => JSON.parse(text)).not.toThrow();
			expect(jsonProblem(text)).toBeNull();
		}
		expect(jsonProblem("")).toBeNull();
		expect(jsonProblem("  \n")).toBeNull();
	});

	test("the first thing wrong is said, where it is", () => {
		expect(at('{"a": 1,}')).toEqual(["}", "A comma is followed by another name, not by }."]);
		expect(at("[1, 2,]")).toEqual(["]", "A comma is followed by another value, not by ]."]);
		expect(at('{"a" 1}')).toEqual(["1", "A colon is expected after the name."]);
		expect(at('{"a": 1 "b": 2}')).toEqual(['"', "A comma or } is expected here."]);
		expect(at("{a: 1}")).toEqual(["a", "A name in double quotes is expected here."]);
		expect(at("{'a': 1}")).toEqual(["'", "A name is written in double quotes."]);
		expect(at('{"a": yes}')).toEqual(["yes", "yes is not a value: a string is in double quotes, and the only bare words are true, false and null."]);
		expect(at('{"a": 01}')).toEqual(["01", "01 is not a number as JSON writes one."]);
		expect(at('{"a": "x\ny"}')?.[1]).toBe("This string is not closed before the line ends.");
		expect(at('// note\n{"a": 1}')).toEqual(["//", "JSON has no comments."]);
		expect(at('{"a": [1, 2')).toEqual(["[", "This [ is never closed."]);
		expect(at('{"a": 1} {"b": 2}')?.[1]).toBe("The document ends here: there is more after its one value.");
		expect(at('{"a": "\\q"}')).toEqual(["\\q", "\\q is not an escape JSON knows."]);
	});

	test("it agrees with JSON.parse on whether a document can be read", () => {
		for (const text of ['{"a":}', "[,]", '{"a":1,,"b":2}', "nul", '"', "{", "]", '{"a":1}}', "1 2", "-", "1.", '{"\\u12G4":1}', "\t1\t", '["a\tb"]']) {
			let reads = true;
			try {
				JSON.parse(text);
			} catch {
				reads = false;
			}
			expect([text, jsonProblem(text) === null]).toEqual([text, reads]);
		}
	});
});

import { REGISTRIES } from "../src/shared/projectDocs";

describe("the registries a project is offered", () => {
	test("each has a file of its own, columns, and a status to say how far a row has come", () => {
		expect(new Set(REGISTRIES.map((r) => r.file)).size).toBe(REGISTRIES.length);
		expect(REGISTRIES.map((r) => r.id)).toEqual(["settings", "files", "database", "interfaces", "jobs", "reports", "roles"]);
		for (const registry of REGISTRIES) {
			expect(registry.columns).toContain("status");
			expect(registry.about.length).toBeGreaterThan(20);
		}
	});

	test("a plan that names a ticket not in the folder is said, like a spec that does", () => {
		const checks = docChecks([{ path: "/p/design/A.plan.json", name: "A.plan.json", group: "plans", exists: true, tickets: ["LIMS-9"] }]);
		expect(checks.map((check) => check.text)).toEqual(["LIMS-9 is not among the tickets; A.plan.json names it."]);
	});
});

import { CODE_LINES_KEPT, codeSection, linkedLines } from "../src/shared/projectDocs";
import { ticketWork } from "../src/shared/workContext";

describe("a question or a decision about code", () => {
	const code = { file: "src/Due Dates/DueRule.ssl", link: "../../../src/Due Dates/DueRule.ssl", from: 12, to: 14, text: ":IF nDays > 730;\r\n\t:RETURN NIL;\r\n:ENDIF;\r\n", language: "ssl", date: "2026-11-18" };

	test("says where the code is, with a link to its lines, and keeps the lines as they were", () => {
		expect(codeSection(code)).toBe("\n## In the code\n\n[src/Due Dates/DueRule.ssl, lines 12 to 14](../../../src/Due%20Dates/DueRule.ssl#L12-L14), as it was on 2026-11-18:\n\n```ssl\n:IF nDays > 730;\n\t:RETURN NIL;\n:ENDIF;\n```\n");
		expect(codeSection({ ...code, from: 12, to: 12, text: ":RETURN NIL;" })).toContain("[src/Due Dates/DueRule.ssl, line 12](../../../src/Due%20Dates/DueRule.ssl#L12), as it was");
	});

	test("code that holds a fence of its own cannot close the one around it, and a long piece is cut and says so", () => {
		expect(codeSection({ ...code, text: "a\n```\nb", language: "" })).toContain("\n````\na\n```\nb\n````\n");
		const long = codeSection({ ...code, text: Array.from({ length: CODE_LINES_KEPT + 5 }, (_, i) => `line ${i + 1};`).join("\n") });
		expect(long).toContain(`line ${CODE_LINES_KEPT};\n\`\`\`\n\nThe first ${CODE_LINES_KEPT} of ${CODE_LINES_KEPT + 5} lines.\n`);
		expect(long).not.toContain(`line ${CODE_LINES_KEPT + 1};`);
	});

	test("it is found again by the document's own reading: a title, a summary, and what it is for", () => {
		const text = questionTemplate({ title: "Why 730 days?", date: "2026-11-18", ticket: "DEMO-101" }) + codeSection(code);
		expect(titleOf(text)).toBe("Why 730 days?");
		expect(frontMatter(text).values.ticket).toBe("DEMO-101");
	});

	test("a link to lines says which", () => {
		expect(linkedLines("../src/A.ssl#L12")).toEqual({ line: 12 });
		expect(linkedLines("../src/A.ssl#L12-L18")).toEqual({ line: 12, endLine: 18 });
		expect(linkedLines("../src/A.ssl#L12-18")).toEqual({ line: 12, endLine: 18 });
		expect(linkedLines("../src/A.ssl#L18-L12")).toEqual({ line: 18 });
		expect(linkedLines("../src/A.ssl#heading")).toBeNull();
		expect(linkedLines("../src/A.ssl")).toBeNull();
	});
});

describe("a ticket's own page", () => {
	const root = join(import.meta.dir, "..", "examples", "due-dates");
	const listed = async () => listDocs(new WorkspaceFiles(root), await readProject(root));

	test("lists what is tied to the ticket, a kind at a time, and leaves out the kinds it has none of", async () => {
		const docs = await listed();
		const first = ticketWork(docs, "DEMO-101");
		expect(first.map((group) => [group.name, group.files.map((file) => file.title || file.name)])).toEqual([
			["Plans", ["SetSampleDueDates.plan.json"]],
			["Specs", ["Set sample due dates"]],
			["Related tickets", ["Rush samples count Saturday as a working day", "A report of the samples due soon"]],
			["Open questions", ["Which holidays does each site keep?"]],
			["Decisions", ["A walk looks at most 730 days ahead", "Planning and saving are two scripts"]],
			// The settings registry says which ticket carries each row.
			["To carry across", ["settings.csv"]],
		]);
		// A decision made for another ticket stands, and is not this ticket's work.
		expect(ticketWork(docs, "DEMO-103").map((group) => group.name)).toEqual(["Specs", "Related tickets", "To carry across"]);
		expect(ticketWork(docs, "DEMO-102").map((group) => group.name)).toContain("Answered");
		expect(ticketWork(docs, "DEMO-999")).toEqual([]);
	});
});

import { checksNames, nameQuery, namesOf, outsideDocuments, usesSummary } from "../src/shared/registryCheck";

describe("a registry's names against the project's files", () => {
	test("the names are what the rows have in their first column, once each, the short ones left out", () => {
		expect(namesOf(parseCsv("name,value\nMaxWalkDays,730\n ab ,1\nmaxwalkdays,again\nDUE_SOON,x\n,empty\n"))).toEqual(["MaxWalkDays", "DUE_SOON"]);
	});

	test("a name is looked for as a whole word, and what would mean something else to a search is taken as written", () => {
		expect(new RegExp(nameQuery("DUE_SOON"), "i").test("x := DUE_SOON;")).toBe(true);
		expect(new RegExp(nameQuery("DUE_SOON"), "i").test("x := DUE_SOON_AT;")).toBe(false);
		expect(new RegExp(nameQuery("DueDates.Holidays"), "i").test('RunDS("duedates.holidays")')).toBe(true);
		expect(new RegExp(nameQuery("DueDates.Holidays"), "i").test("DueDatesXHolidays")).toBe(false);
		expect(new RegExp(nameQuery("a+b (c)"), "i").test("is a+b (c) here")).toBe(true);
	});

	test("a file counts when it is outside the documents, the plans and the IDE's own folder", () => {
		const apart = ["docs", "design", ".ssl-studio"];
		expect(outsideDocuments("src/DueDates/DueRule.ssl", apart)).toBe(true);
		expect(outsideDocuments("docs/registries/settings.csv", apart)).toBe(false);
		expect(outsideDocuments("Docs/knowledge/snippets/a.sql", apart)).toBe(false);
		expect(outsideDocuments("design/A.spec.md", apart)).toBe(false);
		expect(outsideDocuments("docsite/index.md", apart)).toBe(true);
		expect(outsideDocuments("src/a.ssl", [".", ""])).toBe(true);
	});

	test("a list of files is not checked by name, and a check is said in a sentence", () => {
		expect(checksNames(parseCsv("path,kind\nsrc/a.ssl,script\n"))).toBe(false);
		expect(checksNames(parseCsv("name,value\nA,1\n"))).toBe(true);
		expect(checksNames(parseCsv("name,value\n"))).toBe(false);
		expect(usesSummary(new Map())).toBe("No names to look for.");
		expect(usesSummary(new Map([["a", 2], ["b", 1]]))).toBe("All 2 are named outside the documents.");
		expect(usesSummary(new Map([["a", 2], ["b", 0]]))).toBe("1 of 2 is named nowhere outside the documents.");
		expect(usesSummary(new Map([["a", 0], ["b", 0], ["c", 1]]))).toBe("2 of 3 are named nowhere outside the documents.");
	});
});

import { FINISHED_SHOWN, workList } from "../src/shared/workList";

describe("the Work list", () => {
	const ticket = (key: string, status: string, more: Partial<DocFile> = {}): DocFile => ({ path: `/p/docs/tickets/${key}.md`, name: `${key}.md`, group: "tickets", exists: true, ticket: key, status, ...more });
	const shown = (files: DocFile[], all = false) => workList(files, "/p", { all }).rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "ticket" ? row.file.ticket : `${row.kind}:${row.file.name}`}`);

	test("what is under way comes first, then what waits, then what is finished, each in the folder's own order", () => {
		expect(shown([ticket("A-1", "Done"), ticket("A-2", "To Do"), ticket("A-3", "In Progress"), ticket("A-4", "open"), ticket("A-5", "Won't Do"), ticket("A-6", "in review")])).toEqual(["A-3", "A-6", "A-2", "A-4", "A-1", "A-5"]);
	});

	test("a ticket is under its parent, with its plans and specs under it, and a parent with work under way counts as under way", () => {
		const files: DocFile[] = [
			ticket("A-1", "open"),
			ticket("A-2", "open", { specs: ["design/Two.spec.md"] }),
			ticket("A-3", "in progress", { parent: "a-2" }),
			ticket("A-4", "done", { parent: "A-2" }),
			ticket("A-5", "open", { parent: "A-99" }),
			{ path: "/p/design/Two.spec.md", name: "design/Two.spec.md", group: "specs", exists: true },
			{ path: "/p/docs/specs/Three.md", name: "Three.md", group: "specs", exists: true, tickets: ["A-3"] },
			{ path: "/p/design/Three.plan.json", name: "Three.plan.json", group: "plans", exists: true, tickets: ["A-3"] },
			{ path: "/p/docs/specs/Alone.md", name: "Alone.md", group: "specs", exists: true },
			{ path: "/p/docs/tickets/INDEX.md", name: "INDEX.md", group: "tickets", exists: true },
		];
		expect(shown(files)).toEqual(["A-2", "  spec:design/Two.spec.md", "  A-3", "    plan:Three.plan.json", "    spec:Three.md", "  A-4", "A-1", "A-5"]);
		expect(workList(files, "/p").loose.map((spec) => spec.name)).toEqual(["Alone.md"]);
	});

	test("finished tickets beyond a few fold away behind a count, with what is under them, until they are asked for", () => {
		const done = Array.from({ length: FINISHED_SHOWN + 2 }, (_, i) => ticket(`D-${i + 1}`, "done"));
		const files = [ticket("A-1", "open"), ...done, ticket("D-9", "closed", { parent: "D-1" })];
		expect(shown(files)).toEqual(["A-1"]);
		expect(workList(files, "/p").folded).toBe(FINISHED_SHOWN + 2);
		expect(shown(files, true)).toEqual(["A-1", "D-1", "  D-9", "D-2", "D-3", "D-4", "D-5"]);
		expect(workList(files, "/p", { all: true }).folded).toBe(0);
		// A few finished tickets are just listed.
		expect(shown([ticket("A-1", "open"), ...done.slice(0, FINISHED_SHOWN)])).toEqual(["A-1", "D-1", "D-2", "D-3"]);
	});

	test("tickets that name each other as parent are both listed, once", () => {
		expect(shown([ticket("A-1", "open", { parent: "A-2" }), ticket("A-2", "open", { parent: "A-1" })]).sort()).toEqual(["A-1", "A-2"]);
	});

	test("the demo's tickets list as they did: the one under way first", async () => {
		const root = join(import.meta.dir, "..", "examples", "due-dates");
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		expect(workList(docs, root).rows.filter((row) => row.kind === "ticket").map((row) => row.file.ticket)).toEqual(["DEMO-103", "DEMO-101", "DEMO-102"]);
		expect(workList(docs, root).folded).toBe(0);
	});
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("a spec the planner wrote", () => {
	test("is called what its plan is called when it has no heading of its own, and is for its plan's ticket", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-spec-"));
		try {
			mkdirSync(join(root, "design"));
			writeFileSync(join(root, "design", "Mark late.plan.json"), JSON.stringify({ version: 1, title: "Mark late", ticket: "LIMS-7", groups: [], nodes: [], edges: [] }));
			writeFileSync(join(root, "design", "Mark late.spec.md"), "**Prior art:** none.\n\n## Units\n\n```json\n[]\n```\n");
			writeFileSync(join(root, "design", "Named.plan.json"), JSON.stringify({ version: 1, title: "A plan", groups: [], nodes: [], edges: [] }));
			writeFileSync(join(root, "design", "Named.spec.md"), "# Its own name\n\n## Units\n");
			const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
			const specs = docs.filter((d) => d.group === "specs");
			expect(specs.map((d) => [d.title, d.tickets])).toEqual([["Mark late", ["LIMS-7"]], ["Its own name", undefined]]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
