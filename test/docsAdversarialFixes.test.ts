import { describe, expect, test } from "bun:test";
import {
	addCsvColumn,
	csvDuplicateKeys,
	deleteCsvColumn,
	deleteCsvRows,
	parseClipboardGrid,
	parseCsv,
	renameCsvColumn,
	sortCsvRows,
	tableToMarkdown,
	tableToTsv,
} from "../src/shared/csv";
import { checkCodeCitations, findCodeCitations, reanchorCitation } from "../src/shared/codeCitations";
import { docChecks } from "../src/shared/docChecks";
import { assembleTicketPacketMarkdown, buildPrintableHtml, evaluateTicketReadiness, markdownToJira } from "../src/shared/docExport";
import { ownLinkEdits } from "../src/shared/docLinks";
import { addToFrontMatterList, frontMatter, removeFromFrontMatterList, replaceInFrontMatterList } from "../src/shared/frontMatter";
import { generateToc, markdownStats, upsertTocBlock } from "../src/shared/markdownEdit";
import type { DocFile } from "../src/shared/protocol";
import { extractSqlObjects, parseCreateTables, sqlTablesToMarkdown } from "../src/shared/sqlSchema";
import { extractTags, workspaceTags } from "../src/shared/tags";
import { parseTemplateFile, renderTemplate, stripRawTemplateFrontmatter } from "../src/shared/templater";
import { classifyTicketEntries } from "../src/shared/ticketBundle";
import { codeMatchesRef, docsGoverningFile, scriptsForTicket, ticketForFile, ticketWork, workFor, workLabel, workText } from "../src/shared/workContext";

describe("frontMatter upgrades (multi-line lists, removal, quotes, comments)", () => {
	test("adds and removes items cleanly from multi-line YAML bullet lists", () => {
		const md = "---\nticket: DEMO-101\nrelated:\n  - DEMO-102\n  - DEMO-103\n---\n\n# Title\n";
		const added = addToFrontMatterList(md, "related", "DEMO-104");
		expect(added).toContain("  - DEMO-104");
		const dup = addToFrontMatterList(added!, "related", "DEMO-102");
		expect(dup).toBe(added);

		const removed = removeFromFrontMatterList(added!, "related", "DEMO-103");
		expect(removed).not.toContain("DEMO-103");
		expect(removed).toContain("  - DEMO-102");
		expect(removed).toContain("  - DEMO-104");
	});

	test("handles escaped quotes inside inline YAML lists and strips inline comments", () => {
		const md = '---\ntitle: Sample Due Dates # trailing note\ntags: ["alpha, beta", "quote \\"here\\""]\n---\n\nBody\n';
		const fm = frontMatter(md);
		expect(fm.values.title).toBe("Sample Due Dates");
		expect(fm.values.tags).toEqual(["alpha, beta", 'quote "here"']);
	});
});

describe("ticketBundle grouping folders and depth-2 bundles", () => {
	test("does not hijack archive/ or sprint folders as a single ticket bundle", () => {
		const res = classifyTicketEntries([
			{ path: "/ws/docs/tickets/archive/DEMO-101.md", rel: "archive/DEMO-101.md", size: 100, frontTicket: "DEMO-101" },
			{ path: "/ws/docs/tickets/archive/DEMO-102.md", rel: "archive/DEMO-102.md", size: 100, frontTicket: "DEMO-102" },
			{ path: "/ws/docs/tickets/sprint-12/DEMO-103.md", rel: "sprint-12/DEMO-103.md", size: 100, frontTicket: "DEMO-103" },
		]);
		expect(res).toHaveLength(3);
		expect(res.every((r) => !r.folderRel)).toBe(true);
	});

	test("recognizes standard and depth-2 ticket bundle folders", () => {
		const res = classifyTicketEntries([
			{ path: "/ws/docs/tickets/DEMO-103/DEMO-103.md", rel: "DEMO-103/DEMO-103.md", size: 100, frontTicket: "DEMO-103" },
			{ path: "/ws/docs/tickets/DEMO-103/notes.md", rel: "DEMO-103/notes.md", size: 50 },
			{ path: "/ws/docs/tickets/sprint-12/LIMS-9/LIMS-9.md", rel: "sprint-12/LIMS-9/LIMS-9.md", size: 100, frontTicket: "LIMS-9" },
			{ path: "/ws/docs/tickets/sprint-12/LIMS-9/sample.sql", rel: "sprint-12/LIMS-9/sample.sql", size: 40 },
		]);
		expect(res).toHaveLength(2);
		const d103 = res.find((r) => r.entry.frontTicket === "DEMO-103")!;
		expect(d103.folderRel).toBe("DEMO-103");
		expect(d103.fileCount).toBe(1);
		const l9 = res.find((r) => r.entry.frontTicket === "LIMS-9")!;
		expect(l9.folderRel).toBe("sprint-12/LIMS-9");
		expect(l9.fileCount).toBe(1);
	});
});

describe("CSV BOM, semicolon delimiter, structural edits, and exports", () => {
	test("skips UTF-8 BOM without shifting cell offsets and detects semicolon delimiter", () => {
		const raw = "\uFEFFname;status;ticket\nDueDate;verified;DEMO-101\n";
		const table = parseCsv(raw);
		expect(table.delimiter).toBe(";");
		expect(table.header.map((c) => c.text)).toEqual(["name", "status", "ticket"]);
		expect(raw.slice(table.header[0]!.start, table.header[0]!.end)).toBe("name");
		expect(raw.slice(table.rows[0]![0]!.start, table.rows[0]![0]!.end)).toBe("DueDate");
	});

	test("adds, renames, deletes columns and sorts rows verbatim", () => {
		const raw = 'name,status\n"B, quoted",open\nA,done\n';
		const t1 = parseCsv(raw);
		const added = addCsvColumn(raw, t1, "ticket", "DEMO-1")!;
		expect(added).toBe('name,status,ticket\n"B, quoted",open,DEMO-1\nA,done,DEMO-1\n');

		const t2 = parseCsv(added);
		const renamed = renameCsvColumn(added, t2, 2, "key")!;
		expect(renamed.startsWith("name,status,key\n")).toBe(true);

		const t3 = parseCsv(renamed);
		const sorted = sortCsvRows(renamed, t3, [1, 0])!;
		expect(sorted).toBe('name,status,key\nA,done,DEMO-1\n"B, quoted",open,DEMO-1\n');

		const t4 = parseCsv(sorted);
		const deleted = deleteCsvColumn(sorted, t4, 1)!;
		expect(deleted).toBe('name,key\nA,DEMO-1\n"B, quoted",DEMO-1\n');
	});

	test("exports TSV/Markdown, deletes non-overlapping rows without trailing newline, detects duplicate keys, and parses quoted multiline clipboard grids", () => {
		expect(tableToTsv(["A", "B"], [["1", "two"]])).toBe("A\tB\n1\ttwo");
		expect(tableToMarkdown(["A", "B"], [["x|y", "line1\nline2"]])).toContain("| x\\|y | line1<br>line2 |");
		expect(parseClipboardGrid('a\t"hello\nworld"\nc\td\n')).toEqual([
			["a", "hello\nworld"],
			["c", "d"],
		]);
		expect(parseClipboardGrid('"Single\nMultiline Cell"')).toEqual([["Single\nMultiline Cell"]]);

		// Deleting last two rows on a no-trailing-newline CSV must never produce overlapping ranges.
		const noEol = "a,b\n1,2\n3,4";
		const deleted = deleteCsvRows(noEol, parseCsv(noEol), [0, 1])!;
		expect(parseCsv(deleted).rows).toEqual([]);
		expect(deleted.trim()).toBe("a,b");

		const dupCsv = "name,status\nAlpha,open\nBeta,done\nalpha,verified\n";
		expect(csvDuplicateKeys(parseCsv(dupCsv), 0)).toEqual([{ key: "Alpha", rows: [0, 2] }]);
	});
});

describe("SQL DDL schema extraction and Markdown generation", () => {
	const ddl = `
-- Sample table DDL with SSMS brackets, string comments, 3-part names, Oracle SEQUENCE, CREATE OR ALTER
CREATE TABLE [MyDB].[dbo].[DUE_DATE_RULES] (
	[RULE_ID] [int] NOT NULL PRIMARY KEY,
	[SITE_CODE] [varchar](32) NOT NULL DEFAULT '-- none --',
	DAYS_ALLOWED NUMBER(5,0) DEFAULT 5,
	[KEY] [nvarchar](50) NULL,
	FULL_LABEL AS (SITE_CODE + '-R'),
	PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo)
);
ALTER TABLE dbo.DUE_DATE_RULES ADD EXTRA_FLAG BIT DEFAULT 0;
CREATE OR REPLACE FORCE VIEW V_ACTIVE_RULES AS SELECT * FROM DUE_DATE_RULES;
CREATE OR ALTER PROCEDURE dbo.sp_CalcDueDates AS BEGIN EXEC('CREATE TABLE FAKE_INNER (X INT)'); SELECT 1 END;
CREATE SEQUENCE dbo.SEQ_RULES START WITH 1;
`;

	test("extracts SQL objects and CREATE TABLE columns accurately across T-SQL and Oracle", () => {
		const objs = extractSqlObjects(ddl);
		expect(objs).toEqual([
			{ name: "dbo.DUE_DATE_RULES", bareName: "DUE_DATE_RULES", kind: "table" },
			{ name: "V_ACTIVE_RULES", bareName: "V_ACTIVE_RULES", kind: "view" },
			{ name: "dbo.sp_CalcDueDates", bareName: "sp_CalcDueDates", kind: "procedure" },
			{ name: "dbo.SEQ_RULES", bareName: "SEQ_RULES", kind: "sequence" },
		]);
		const tables = parseCreateTables(ddl);
		expect(tables).toHaveLength(1);
		expect(tables[0]!.tableName).toBe("DUE_DATE_RULES");
		expect(tables[0]!.columns.map((c) => c.name)).toEqual(["RULE_ID", "SITE_CODE", "DAYS_ALLOWED", "KEY", "FULL_LABEL", "EXTRA_FLAG"]);
		const md = sqlTablesToMarkdown(tables, "schema/database/due_date_rules.sql");
		expect(md).toContain("| `RULE_ID` | `int` | NOT NULL PRIMARY KEY |  |");
		expect(md).toContain("| `SITE_CODE` | `varchar(32)` | NOT NULL DEFAULT '-- none --' |  |");
	});
});

describe("docChecks structural & health diagnostics", () => {
	const base = (over: Partial<DocFile>): DocFile => ({
		group: "tickets",
		name: "T.md",
		path: "/ws/docs/tickets/T.md",
		exists: true,
		...over,
	});

	test("detects duplicate ticket keys, parent cycles, done tickets with open work, and orphaned specs", () => {
		const files: DocFile[] = [
			base({ name: "LIMS-1.md", path: "/ws/docs/tickets/LIMS-1.md", ticket: "LIMS-1", status: "done", parent: "LIMS-2" }),
			base({ name: "LIMS-1-dup.md", path: "/ws/docs/tickets/LIMS-1-dup.md", ticket: "LIMS-1", status: "open" }),
			base({ name: "LIMS-2.md", path: "/ws/docs/tickets/LIMS-2.md", ticket: "LIMS-2", status: "in progress", parent: "LIMS-1" }),
			base({
				group: "knowledge",
				kind: "questions",
				name: "q.md",
				path: "/ws/docs/knowledge/questions/q.md",
				status: "open",
				tickets: ["LIMS-1"],
			}),
			base({
				group: "specs",
				name: "orphan.md",
				path: "/ws/docs/specs/orphan.md",
				status: "draft",
			}),
		];
		const notes = docChecks(files);
		expect(notes.some((n) => n.text.includes("Duplicate ticket key LIMS-1"))).toBe(true);
		expect(notes.some((n) => n.text.includes("circular parent chain"))).toBe(true);
		expect(notes.some((n) => n.text.includes("is done") && n.text.includes("sub-ticket"))).toBe(true);
		expect(notes.some((n) => n.text.includes("Spec has no linked ticket"))).toBe(true);
	});
});

describe("docExport (Jira markup, printable HTML, ticket packet)", () => {
	test("converts Markdown with callouts, tables, wikilinks, and code blocks to Jira markup", () => {
		const md = [
			"---",
			"title: Spec",
			"---",
			"# Overview",
			"",
			"See [[DEMO-101|Ticket 101]] and **bold** `code`.",
			"",
			"> [!warning] Watch out",
			"> Check holidays.",
			"",
			"| Col A | Col B |",
			"| --- | --- |",
			"| 1 | 2 |",
			"",
			"```sql",
			"SELECT 1;",
			"```",
		].join("\n");
		const jira = markdownToJira(md);
		expect(jira).toContain("h1. Overview");
		expect(jira).toContain("See Ticket 101 and *bold* {{code}}.");
		expect(jira).toContain("{panel:title=Watch out}\nCheck holidays.\n{panel}");
		expect(jira).toContain("||Col A||Col B||\n|1|2|");
		expect(jira).toContain("{code:sql}\nSELECT 1;\n{code}");
	});

	test("builds standalone printable HTML and complete ticket release packet Markdown", () => {
		const html = buildPrintableHtml("My <Spec>", "<p>Hello</p>", "Due Dates");
		expect(html).toContain("<title>My &lt;Spec&gt;</title>");
		expect(html).toContain("@media print");

		const packet = assembleTicketPacketMarkdown({
			projectName: "Due Dates",
			generatedOn: "2026-11-22",
			ticketKey: "DEMO-103",
			ticketTitle: "Due soon report",
			status: "in progress",
			ticketBody: "---\nticket: DEMO-103\n---\n\n# DEMO-103\n\nNeeds daily digest.",
			specs: [{ title: "Due soon spec", status: "draft", body: "# Spec\n\nQuery details." }],
			plans: [{ name: "DueSoon.plan.json", title: "Due soon flow" }],
			decisions: [{ title: "Use SQL view", status: "accepted", body: "Faster queries." }],
			questions: [{ title: "Timezone?", status: "answered", body: "UTC." }],
			registries: [{ title: "Settings", headers: ["Name", "Status"], rows: [["DAYS", "done"]] }],
			ticketFiles: [{ rel: "samples/query.sql" }],
		});
		expect(packet).toContain("# DEMO-103: Due soon report");
		expect(packet).toContain("## Specifications");
		expect(packet).toContain("## Affected Registry Items");
		expect(packet).toContain("`samples/query.sql`");
	});
});

describe("Templater upgrades (selection, variables, blank-line resilience)", () => {
	test("supports tp.file.selection(), let variable reuse, and raw frontmatter stripping", async () => {
		const tpl = '<% let owner = tp.system.prompt("Owner") %>Owner: <% owner %> (again: <%= owner %>)\nSelected: <% tp.file.selection() %>';
		let calls = 0;
		const res = await renderTemplate(tpl, {
			title: "Note",
			fileName: "Note.md",
			relativePath: "docs/Note.md",
			folder: "docs",
			projectName: "Demo",
			selection: "Selected text",
			prompt: async () => {
				calls++;
				return "Alex";
			},
		});
		expect(calls).toBe(1);
		expect(res.text).toBe("Owner: Alex (again: Alex)\nSelected: Selected text");

		const withFm = "---\ntitle: <% tp.system.prompt('Skip me') %>\n---\n\n# Body\n";
		expect(stripRawTemplateFrontmatter(withFm)).toBe("# Body\n");

		const parsed = parseTemplateFile('<!-- template: name="T" fileName="{{ticket}}.md" -->\n\n\n---\nstatus: open\n---\n# Hi\n', "T", "t", "/t.md");
		expect(parsed.fileName).toBe("{{ticket}}.md");
		expect(parsed.content.startsWith("---\n")).toBe(true);
	});
});

describe("workContext UI separation and opt-in Agent extras", () => {
	test("ticketWork shows proposed ADRs and sub-tickets; workText includes parentEpic and opt-in extras", async () => {
		const files: DocFile[] = [
			{ group: "tickets", name: "E-1.md", path: "/ws/docs/tickets/E-1.md", exists: true, ticket: "E-1", title: "Epic", status: "in progress" },
			{ group: "tickets", name: "T-2.md", path: "/ws/docs/tickets/T-2.md", exists: true, ticket: "T-2", title: "Task", status: "in progress", parent: "E-1" },
			{ group: "tickets", name: "T-3.md", path: "/ws/docs/tickets/T-3.md", exists: true, ticket: "T-3", title: "Sub", status: "open", parent: "T-2" },
			{ group: "knowledge", kind: "decisions", name: "0001.md", path: "/ws/docs/knowledge/decisions/0001.md", exists: true, title: "Proposed ADR", status: "proposed", tickets: ["T-2"] },
			{ group: "schema", kind: "database", name: "database/USERS.md", path: "/ws/schema/database/USERS.md", exists: true, title: "USERS" },
			{ group: "registries", name: "settings.csv", path: "/ws/docs/registries/settings.csv", exists: true, tickets: ["T-2"] },
			{ group: "project", name: "STATE.md", path: "/ws/STATE.md", exists: true, title: "State" },
		];
		const ui = ticketWork(files, "T-2");
		expect(ui.find((g) => g.kind === "decision")?.files).toHaveLength(1);
		expect(ui.find((g) => g.kind === "subticket")?.files).toHaveLength(1);

		const work = workFor(files, "T-2")!;
		expect(work.parentEpic?.ticket).toBe("E-1");
		const label = workLabel(work, { includeSchema: true, includeRegistries: true, includeState: true });
		expect(label).toContain("schema");
		expect(label).toContain("STATE.md");

		const contents: Record<string, string> = {
			"/ws/docs/tickets/E-1.md": "# Epic\n\nEpic goal.",
			"/ws/docs/tickets/T-2.md": "# Task\n\nTask goal.",
			"/ws/docs/registries/settings.csv": "name,ticket,status\nKEY1,T-2,open\nKEY2,OTHER,done\n",
			"/ws/STATE.md": "# State\n\nAll green.",
		};
		const text = await workText(work, async (p) => contents[p] ?? null, {
			includeSchema: true,
			includeRegistries: true,
			includeState: true,
		});
		expect(text).toContain("PARENT EPIC E-1");
		expect(text).toContain("PROJECT STATE (STATE.md):");
		expect(text).toContain("PROJECT SCHEMA (summary):");
		expect(text).toContain("KEY1 | T-2 | open");
		expect(text).not.toContain("KEY2");
	});
});

describe("Wave A–C adversarial review v2 fixes & features", () => {
	test("folder-move ownLinkEdits keeps intra-bundle relative links untouched while rewriting outside links", () => {
		const md = "See [sample](samples/query.sql) and [spec](../../specs/S.md) and ![shot](attachments/a.png).\n";
		const edits = ownLinkEdits(md, "/ws/docs/tickets/T-1/T-1.md", "/ws/docs/tickets/archive/T-1/T-1.md", {
			from: "/ws/docs/tickets/T-1",
			to: "/ws/docs/tickets/archive/T-1",
		});
		expect(edits.map((e) => e.href)).toEqual(["../../specs/S.md"]);
		expect(edits[0]!.instead).toBe("../../../specs/S.md");
	});

	test("replaceInFrontMatterList updates scalar and list entries in place without mangling other keys", () => {
		const md = "---\nticket: OLD-1\nrelated: [OLD-1, KEEP-2]\n---\n\n# Body\n";
		const replaced = replaceInFrontMatterList(md, "related", "OLD-1", "NEW-1");
		expect(frontMatter(replaced!).values.related).toEqual(["KEEP-2", "NEW-1"]);
		expect(frontMatter(replaced!).values.ticket).toBe("OLD-1");
	});

	test("unified Code <-> Docs index resolves governing plans, specs, tickets, registries, and script-specific tickets", () => {
		const files: DocFile[] = [
			{
				group: "tickets",
				name: "DEMO-101.md",
				path: "/ws/docs/tickets/DEMO-101.md",
				exists: true,
				ticket: "DEMO-101",
				title: "Due dates",
				status: "done",
				specs: ["design/SetSampleDueDates.spec.md"],
			},
			{
				group: "tickets",
				name: "DEMO-103.md",
				path: "/ws/docs/tickets/DEMO-103.md",
				exists: true,
				ticket: "DEMO-103",
				title: "Unrelated active ticket",
				status: "in progress",
			},
			{
				group: "plans",
				name: "SetSampleDueDates.plan.json",
				path: "/ws/design/SetSampleDueDates.plan.json",
				exists: true,
				heading: "Set sample due dates",
				tickets: ["DEMO-101"],
				codeRefs: ["src/DueDates/SetSampleDueDates.ssl", "src/DueDates/SaveDueDates.ssl"],
			},
			{
				group: "specs",
				name: "design/SetSampleDueDates.spec.md",
				path: "/ws/design/SetSampleDueDates.spec.md",
				exists: true,
				title: "Set sample due dates",
				tickets: ["DEMO-101"],
				codeRefs: ["src/DueDates/SetSampleDueDates.ssl"],
			},
			{
				group: "registries",
				name: "database.csv",
				path: "/ws/docs/registries/database.csv",
				exists: true,
				codeRefs: ["SetSampleDueDates", "SaveDueDates"],
			},
			{
				group: "registries",
				name: "settings.csv",
				path: "/ws/docs/registries/settings.csv",
				exists: true,
				tickets: ["DEMO-101"],
				codeRefs: ["DueDates.DueDateConstants"],
				ticketCodeRefs: { "demo-101": ["DueDates.DueDateConstants"] },
			},
			{
				group: "project",
				name: "src/INDEX.md",
				path: "/ws/src/INDEX.md",
				exists: true,
				catalog: { stale: false, area: "code" },
			},
		];

		expect(codeMatchesRef("/ws/src/DueDates/DueDateConstants.ssl", "DueDates.DueDateConstants", "/ws")).toBe(true);
		expect(codeMatchesRef("/ws/src/DueDates/SetSampleDueDates.ssl", "SetSampleDueDates", "/ws")).toBe(true);
		expect(codeMatchesRef("/ws/src/OtherSetSampleDueDates.ssl", "SetSampleDueDates", "/ws")).toBe(false);

		const gov = docsGoverningFile(files, "/ws/src/DueDates/SetSampleDueDates.ssl", "/ws", [
			{ path: "/ws/src/INDEX.md", line: 10 },
		]);
		const names = gov.map((g) => g.file.name);
		expect(names).toContain("SetSampleDueDates.plan.json");
		expect(names).toContain("design/SetSampleDueDates.spec.md");
		expect(names).toContain("DEMO-101.md");
		expect(names).toContain("database.csv");
		expect(names).not.toContain("src/INDEX.md"); // Demoted when real governing docs exist!

		// Script-specific ticket resolution never falls back to unrelated active DEMO-103.
		expect(ticketForFile(files, "/ws/src/DueDates/SetSampleDueDates.ssl", "/ws")).toBe("DEMO-101");
		expect(ticketForFile(files, "/ws/src/Legacy/Unlinked.ssl", "/ws")).toBe("");

		const scripts = scriptsForTicket(files, "DEMO-101");
		expect(scripts).toContain("src/DueDates/SetSampleDueDates.ssl");
		expect(scripts).toContain("DueDates.DueDateConstants");
	});

	test("markdownToJira handles italics vs bold, escaped pipes, 4-space nested lists, tasks, and highlights", () => {
		const md = [
			"Use *italic* and **bold** and ***both*** and ==mark==.",
			"",
			"- [ ] Open task",
			"    - [x] Nested done task",
			"",
			"| Expr | Note |",
			"| --- | --- |",
			"| `a || b` | A \\| B |",
		].join("\n");
		const jira = markdownToJira(md);
		expect(jira).toContain("Use _italic_ and *bold* and *_both_* and {color:#b45309}*mark*{color}.");
		expect(jira).toContain("* (-) Open task");
		expect(jira).toContain("** (/) Nested done task");
		expect(jira).toContain("|{{a || b}}|A | B|");
	});

	test("evaluateTicketReadiness evaluates checklists, open questions, registry rows, and Git status", () => {
		const files: DocFile[] = [
			{
				group: "tickets",
				name: "T-1.md",
				path: "/ws/docs/tickets/T-1.md",
				exists: true,
				ticket: "T-1",
				title: "Ship report",
				status: "in progress",
				tasks: { done: 1, total: 2 },
			},
			{
				group: "registries",
				name: "settings.csv",
				path: "/ws/docs/registries/settings.csv",
				exists: true,
				tickets: ["T-1"],
				forTickets: [{ key: "T-1", rows: 3, done: 1 }],
			},
		];
		const rep = evaluateTicketReadiness(files, "T-1", { gitFiles: [{ path: "/ws/docs/tickets/T-1.md" }], root: "/ws" })!;
		expect(rep.ready).toBe(false);
		expect(rep.checks.some((c) => c.label === "Acceptance checklist" && !c.ok)).toBe(true);
		expect(rep.checks.some((c) => c.label === "Registry rows" && !c.ok)).toBe(true);
		expect(rep.checks.some((c) => c.label === "Working tree" && c.level === "note")).toBe(true);

		const packet = assembleTicketPacketMarkdown({
			projectName: "Demo",
			generatedOn: "2026-11-23",
			ticketKey: "T-1",
			ticketTitle: "Ship report",
			ticketBody: "Details",
			specs: [],
			plans: [{ name: "P.plan.json", title: "Flow", status: "draft", scripts: ["src/A.ssl"] }],
			decisions: [],
			questions: [],
			registries: [],
			ticketFiles: [{ rel: "a.sql" }],
			totalTicketFiles: 40,
			readiness: rep,
		});
		expect(packet).toContain("## Release Readiness Gate");
		expect(packet).toContain("src/A.ssl");
		expect(packet).toContain("… and 39 more files inside this ticket folder");
	});

	test("extractTags & workspaceTags ignore hex colors, code fences, and link anchors", () => {
		const md = [
			"---",
			'tags: [starlims/due-dates, "#Migration"]',
			"---",
			"# Heading #not-a-tag",
			"",
			"Track #release-2026 and [link](doc.md#section) and color #ff00aa.",
			"",
			"```css",
			".x { color: #abc; }",
			"/* #inside-fence */",
			"```",
		].join("\n");
		const tags = extractTags(md);
		expect(tags).toEqual(["starlims/due-dates", "Migration", "release-2026"]);
		const buckets = workspaceTags([
			{ group: "tickets", name: "A.md", path: "/ws/A.md", exists: true, tags },
			{ group: "specs", name: "B.md", path: "/ws/B.md", exists: true, tags: ["migration"] },
		]);
		expect(buckets[0]).toMatchObject({ tag: "Migration", count: 2 });
	});

	test("codeCitations detects shifted/out-of-range #L10-L20 citations and re-anchors cleanly", async () => {
		const md = [
			"# Decision",
			"",
			"See [SetSampleDueDates.ssl, lines 2 to 3](../../src/SetSampleDueDates.ssl#L2-L3):",
			"",
			"```ssl",
			":PROCEDURE Foo;",
			"\t:RETURN 1;",
			"```",
		].join("\n");
		const citations = findCodeCitations(md);
		expect(citations).toHaveLength(1);
		expect(citations[0]!.from).toBe(2);
		expect(citations[0]!.to).toBe(3);

		const diskCode = "// header\n// moved down\n// comment\n// comment2\n:PROCEDURE Foo;\n\t:RETURN 1;\n:ENDPROC;\n";
		const issues = await checkCodeCitations("/ws/docs/decisions/0001.md", md, "/ws", async () => diskCode);
		expect(issues).toHaveLength(1);
		expect(issues[0]!.kind).toBe("shifted");
		expect(issues[0]!.reanchor).toEqual({ from: 5, to: 6 });

		const updated = reanchorCitation(md, issues[0]!.citation, 5, 6);
		expect(updated).toContain("lines 5 to 6");
		expect(updated).toContain("SetSampleDueDates.ssl#L5-L6");
	});

	test("TOC generator, upsertTocBlock, and markdownStats work cleanly", () => {
		const md = "---\ntitle: Guide\n---\n\n# Guide\n\n## Setup\n\n- [x] Done\n- [ ] Todo\n\n### Details\n\nHello world.\n";
		expect(generateToc(md)).toBe("- [Setup](#setup)\n  - [Details](#details)");
		const inserted = upsertTocBlock(md);
		expect(inserted.updated).toBe(true);
		expect(inserted.text).toContain("<!-- toc -->\n- [Setup](#setup)\n  - [Details](#details)\n<!-- /toc -->");
		const stats = markdownStats(md);
		expect(stats.tasksDone).toBe(1);
		expect(stats.tasksTotal).toBe(2);
		expect(stats.words).toBeGreaterThan(5);
	});

	test("docChecks catches circular blocks, missing source, and asymmetric supersedes", () => {
		const files: DocFile[] = [
			{ group: "tickets", name: "INDEX.md", path: "/ws/docs/tickets/INDEX.md", exists: true, catalog: { stale: false } },
			{ group: "tickets", name: "A-1.md", path: "/ws/docs/tickets/A-1.md", exists: true, ticket: "A-1", blocks: ["A-2"] },
			{ group: "tickets", name: "A-2.md", path: "/ws/docs/tickets/A-2.md", exists: true, ticket: "A-2", blocks: ["A-1"] },
			{ group: "schema", name: "INDEX.md", path: "/ws/schema/INDEX.md", exists: true, catalog: { stale: false } },
			{ group: "schema", kind: "database", name: "database/T.md", path: "/ws/schema/database/T.md", exists: true, missingSource: "schema/database/gone.sql" },
			{ group: "knowledge", name: "INDEX.md", path: "/ws/docs/knowledge/INDEX.md", exists: true, catalog: { stale: false } },
			{ group: "knowledge", kind: "decisions", name: "decisions/0001-old.md", path: "/ws/docs/knowledge/decisions/0001-old.md", exists: true, title: "Old" },
			{ group: "knowledge", kind: "decisions", name: "decisions/0002-new.md", path: "/ws/docs/knowledge/decisions/0002-new.md", exists: true, title: "New", supersedes: ["0001-old"] },
		];
		const checks = docChecks(files);
		expect(checks.some((c) => c.text.includes("circular blocks/blocked-by"))).toBe(true);
		expect(checks.some((c) => c.text.includes("source file that is not there"))).toBe(true);
		expect(checks.some((c) => c.text.includes("does not list superseded-by back"))).toBe(true);
	});

	test("Templater handles trailing semicolons, <%* exec blocks, literal lets, arg variable resolution, and frontmatter let preservation", async () => {
		const shared = new Map<string, string>();
		const tpl = '<%* let env = "PROD"; %>\nEnv: <% env; %>\nArg: <% tp.system.prompt("Check", env); %>';
		const rendered = await renderTemplate(
			tpl,
			{
				title: "Deploy",
				fileName: "Deploy.md",
				relativePath: "docs/Deploy.md",
				folder: "docs",
				projectName: "Demo",
				prompt: async (_label, def) => `got-${def}`,
			},
			shared,
		);
		expect(rendered.text.trim()).toBe("Env: PROD\nArg: got-PROD");
		expect(shared.get("env")).toBe("PROD");

		const fmWithLet = "---\nticket: <% let k = tp.system.prompt('Key') %><% k %>\n---\n\n# Work for <% k %>\n";
		const stripped = stripRawTemplateFrontmatter(fmWithLet);
		expect(stripped).toContain("let k = tp.system.prompt('Key')");
		expect(stripped).toContain("# Work for <% k %>");
	});
});
