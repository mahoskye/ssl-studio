import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { markdownToDocx } from "../src/bun/docx";
import { formatDocument } from "../src/bun/format";
import { docAudit, fileManifest, listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { adfToMarkdown } from "../src/shared/adf";
import { checkCodeCitations, refreshCitationExcerpt } from "../src/shared/codeCitations";
import { parseCsv } from "../src/shared/csv";
import { docChecks } from "../src/shared/docChecks";
import { assembleTicketPacketMarkdown, buildPrintableHtml, demoteMarkdownHeadings, evaluateTicketReadiness, inlineExportStyles, markdownToJira, transformMarkdownFootnotes } from "../src/shared/docExport";
import { frontPaths, rewriteHeadingReferences } from "../src/shared/docLinks";
import { cellText, checkTables } from "../src/shared/docTables";
import { addToFrontMatterList, frontMatter, quoteYamlScalar, removeFromFrontMatterList, replaceInFrontMatterList, stripEmptyFrontMatter } from "../src/shared/frontMatter";
import { CHANGED, mergeManifest } from "../src/shared/manifest";
import { documentHeadings } from "../src/shared/markdownEdit";
import { namedLinksIn, namePlaces } from "../src/shared/namedLinks";
import type { DocFile } from "../src/shared/protocol";
import { extractSchemaColumns, findSchemaDocForIdentifier, schemaDocKeys } from "../src/shared/schemaIndex";
import { extractSqlObjects, mergeSqlTablesIntoMarkdown, parseCreateTables } from "../src/shared/sqlSchema";
import { tagSearchPattern } from "../src/shared/tags";
import { DEFAULT_TEMPLATES, renderTemplate, stripRawTemplateFrontmatter } from "../src/shared/templater";
import { htmlToMarkdown, ticketsFromJson, ticketsFromTable } from "../src/shared/ticketImport";
import { wikiToMarkdown } from "../src/shared/wikiMarkup";
import { scriptsForTicket, workFor, workText } from "../src/shared/workContext";
import { isArchivedTicket, workList } from "../src/shared/workList";

describe("Round 4 Wave 1 — Data integrity, CRLF & frontmatter fixes", () => {
	test("documentHeadings and checkTables compute exact line numbers on Windows CRLF files", () => {
		const crlf = [
			"---",
			"title: CRLF Spec",
			"---",
			"",
			"# Intro",
			"",
			"```sql",
			"# comment inside fence",
			"SELECT 1;",
			"```",
			"",
			"## After Fence",
			"",
			"| Col1 | Col2 | Col3 | Col4 | Col5 |",
			"| --- | --- | --- | --- | --- |",
			"| a | b | c | d | e |",
			"",
		].join("\r\n");

		const headings = documentHeadings(crlf);
		expect(headings.map((h) => [h.text, h.line])).toEqual([
			["Intro", 5],
			["After Fence", 12],
		]);

		const findings = checkTables(crlf);
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0]!.line).toBe(14);
	});

	test("cellText unwraps wikilink aliases for ADR 0008 table width checks", () => {
		expect(cellText("[[docs/specs/DueDateCalculation\\|Due Dates]]")).toBe("Due Dates");
		expect(cellText("[[DEMO-101]]")).toBe("DEMO-101");
		const md = "| Spec | Notes |\n| --- | --- |\n| [[docs/specs/VeryLongSpecificationFileName\\|Due Dates]] | Short note |\n";
		expect(checkTables(md)).toEqual([]);
	});

	test("frontMatter helpers handle template headers, embedded quotes, 1-item YAML lists, and empty fences", () => {
		// Embedded double quotes get safely re-escaped
		const quoted = quoteYamlScalar('"Urgent" bug "fix"');
		expect(JSON.parse(quoted)).toBe('"Urgent" bug "fix"');

		// Template header on line 0 with multi-line YAML list
		const tplDoc = '<!-- template: name="Spec" -->\n---\ntitle: Test\ntags:\n  - alpha\n---\n\n# Body\n';
		const added = addToFrontMatterList(tplDoc, "tags", "beta");
		expect(added).not.toBeNull();
		expect(frontMatter(added!).values.tags).toEqual(["alpha", "beta"]);
		const removed = removeFromFrontMatterList(added!, "tags", "alpha");
		expect(frontMatter(removed!).values.tags).toEqual(["beta"]);

		// 1-item YAML list preserves key position and bullet list style on replaceInFrontMatterList
		const oneItem = "---\ntitle: Doc\ntags:\n  - legacy\nstatus: open\n---\n\n# Body\n";
		const renamed = replaceInFrontMatterList(oneItem, "tags", "legacy", "retired")!;
		expect(renamed).toBe("---\ntitle: Doc\ntags:\n  - retired\nstatus: open\n---\n\n# Body\n");

		// stripEmptyFrontMatter cleans empty fences while preserving body
		expect(stripEmptyFrontMatter("---\n---\n\n# Heading\n")).toBe("# Heading\n");
		expect(stripEmptyFrontMatter("---\ntitle: Keep\n---\n\n# Heading\n")).toBe("---\ntitle: Keep\n---\n\n# Heading\n");
	});

	test("frontPaths includes workspace source: paths and ignores http(s) URLs", () => {
		const md = "---\nsource: schema/database/demo.sql\nspecs: [docs/specs/A.md]\n---\n";
		expect(frontPaths(md).map((p) => p.value)).toEqual(["schema/database/demo.sql", "docs/specs/A.md"]);
		const urlMd = "---\nsource: https://tickets.example.test/browse/LIMS-1\n---\n";
		expect(frontPaths(urlMd)).toEqual([]);
	});

	test("mergeManifest flags changedAfterDone and transitions status only when opt-in requested (ADR 0009)", () => {
		const before = "path,kind,bytes,lines,sha256,status,note\nsrc/A.ssl,script,10,2,oldsha,verified,Checked\n";
		const dry = mergeManifest(before, [{ path: "src/A.ssl", kind: "script", bytes: 12, lines: 3, sha256: "newsha" }]);
		expect(dry.changedAfterDone).toEqual(["src/A.ssl"]);
		expect(dry.text).toContain("newsha,verified,Checked");

		const marked = mergeManifest(before, [{ path: "src/A.ssl", kind: "script", bytes: 12, lines: 3, sha256: "newsha" }], { markChangedAfterDone: true });
		expect(marked.text).toContain(`newsha,${CHANGED},Checked`);
	});

	test("ticketsFromJson ignores prose customfield_* strings and ticketsFromTable parses directional blocks + ADO HTML + AC", () => {
		const jira = ticketsFromJson({
			key: "LIMS-105",
			fields: {
				summary: "Sample due dates",
				customfield_10042: "LIMS workflow notes for QA",
				customfield_10014: "LIMS-100",
			},
		});
		expect(jira.tickets[0]!.parent).toBe("LIMS-100");

		const proseOnly = ticketsFromJson({
			key: "LIMS-105",
			fields: {
				summary: "Sample due dates",
				customfield_10042: "LIMS workflow notes for QA",
			},
		});
		expect(proseOnly.tickets[0]!.parent).toBeUndefined();

		const adoCsv = [
			"Work Item ID,Title,State,Description,Acceptance Criteria,Outward issue link (Blocks),Inward issue link (Blocks)",
			'42,Turnaround calc,Active,"<div><p>Compute <b>rush</b> days.</p><ul><li>Skip holidays</li></ul></div>","<div><p>All tests pass</p></div>",43,41',
		].join("\n");
		const ado = ticketsFromTable(parseCsv(adoCsv));
		expect(ado.tickets[0]!.description).toContain("Compute **rush** days.");
		expect(ado.tickets[0]!.description).toContain("- Skip holidays");
		expect(ado.tickets[0]!.acceptanceCriteria).toBe("All tests pass");
		expect(ado.tickets[0]!.blocks).toEqual(["43"]);
		expect(ado.tickets[0]!.blockedBy).toEqual(["41"]);
		expect(htmlToMarkdown("<pre><code>SELECT 1;</code></pre>")).toContain("```\nSELECT 1;\n```");
	});

	test("wikiMarkup and ADF convert panels into callouts and handle mixed lists", () => {
		expect(wikiToMarkdown("{panel:title=CAB Note}\n* Parent\n*# Nested step\n{panel}")).toContain("> [!note] CAB Note\n> - Parent\n>   1. Nested step");
		expect(
			adfToMarkdown({
				type: "doc",
				content: [{ type: "panel", attrs: { panelType: "warning" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Check holiday calendar." }] }] }],
			}),
		).toBe("> [!warning]\n> Check holiday calendar.");
	});
});

describe("Round 4 Waves 2 & 3 — Exports, SQL/Schema, Citations, Templater, Refactor & DOCX", () => {
	test("namedLinksIn skips ![[embeds]], namePlaces tags embed:true, and markdownToJira handles embeds/comments/callout lists", () => {
		expect(namedLinksIn("See [[Spec]] and ![[Spec#Rules]]")).toHaveLength(1);
		const places = namePlaces("See [[Spec]] and ![[diagram.png]]");
		expect(places.map((p) => [p.name, Boolean(p.embed)])).toEqual([
			["Spec", false],
			["diagram.png", true],
		]);

		const md = [
			"<!--",
			"multi-line comment",
			"-->",
			"![[diagram.png|400]] and ![[Spec#Rules]]",
			"",
			"> [!tip] Action",
			"> - [ ] Verify schema",
			"> - [x] Run tests",
			"",
			"```xfd",
			"<Form/>",
			"```",
		].join("\n");
		const jira = markdownToJira(md);
		expect(jira).not.toContain("multi-line comment");
		expect(jira).toContain("!diagram.png!");
		expect(jira).toContain("Spec › Rules");
		expect(jira).not.toContain("!Spec!");
		expect(jira).toContain("{panel:title=Action}\n* (-) Verify schema\n* (/) Run tests\n{panel}");
		expect(jira).toContain("{code:xml}\n<Form/>\n{code}");
	});

	test("docExport handles tone-ok CSS, footnotes, inlineExportStyles, heading demotion, and Epic readiness rollups", () => {
		const html = buildPrintableHtml("Doc", '<div class="md-callout tone-ok"><p>Good</p></div>');
		expect(html).toContain(".md-callout.tone-ok");

		const withFn = transformMarkdownFootnotes("Rule applies[^1].\n\n[^1]: Per ISO 17025.", "html");
		expect(withFn).toContain('class="md-fn-ref"');
		expect(withFn).toContain('class="md-footnotes"');
		expect(inlineExportStyles('<div class="md-callout tone-ok"><table><th>A</th><td>1</td></table></div>')).toContain("border-collapse:collapse");

		expect(demoteMarkdownHeadings("## Top\n\n### Sub\n\n```md\n# Code\n```", 4)).toBe("#### Top\n\n##### Sub\n\n```md\n# Code\n```");

		const packet = assembleTicketPacketMarkdown({
			projectName: "Demo",
			generatedOn: "2026-11-23",
			ticketKey: "LIMS-1",
			ticketTitle: "Test",
			ticketBody: "# LIMS-1\n\n## Scope\n\nDetails.",
			specs: [{ title: "Spec A", body: "# Spec A\n\n## Rules\n\nRule 1." }],
			plans: [],
			decisions: [],
			questions: [],
			registries: [],
			ticketFiles: [],
		});
		expect(packet).toContain("### Scope");
		expect(packet).toContain("#### Rules");

		// Epic readiness catches missing external blockers and sub-ticket open questions / missingSource
		const files: DocFile[] = [
			{ group: "tickets", name: "EP-1.md", path: "/ws/docs/tickets/EP-1.md", exists: true, ticket: "EP-1", title: "Epic", status: "in progress", blockedBy: ["EXT-99"] },
			{ group: "tickets", name: "EP-2.md", path: "/ws/docs/tickets/EP-2.md", exists: true, ticket: "EP-2", title: "Child", status: "done", parent: "EP-1" },
			{ group: "knowledge", kind: "questions", name: "questions/q1.md", path: "/ws/docs/knowledge/questions/q1.md", exists: true, title: "Q1", status: "open", tickets: ["EP-2"] },
			{ group: "schema", kind: "database", name: "database/T.md", path: "/ws/schema/database/T.md", exists: true, title: "T", tickets: ["EP-2"], missingSource: "schema/database/T.sql" },
		];
		const rep = evaluateTicketReadiness(files, "EP-1")!;
		expect(rep.ready).toBe(false);
		expect(rep.checks.find((c) => c.label === "Blockers")?.detail).toContain("EXT-99 (not in workspace)");
		expect(rep.checks.find((c) => c.label === "Open questions")?.ok).toBe(false);
	});

	test("sqlSchema handles bracketed identifiers, standalone ALTER migrations, and non-destructive Markdown sync", () => {
		const sql = `
			CREATE TABLE dbo.[Order Items] (
				[Item, ID] INT NOT NULL,
				[Price (USD)] DECIMAL(10,2) DEFAULT 0
			);
			ALTER TABLE dbo.FOLDERS ADD RUSH_FLAG VARCHAR(1) DEFAULT 'N';
			CREATE SYNONYM dbo.SYN_FOLDERS FOR dbo.FOLDERS;
		`;
		const objs = extractSqlObjects(sql, { includeAlter: true });
		expect(objs.map((o) => [o.bareName, o.kind, o.action ?? "create"])).toEqual([
			["Order Items", "table", "create"],
			["SYN_FOLDERS", "synonym", "create"],
			["FOLDERS", "table", "alter"],
		]);

		const tables = parseCreateTables(sql, { includeStandaloneAlter: true });
		expect(tables.find((t) => t.tableName === "Order Items")?.columns.map((c) => c.name)).toEqual(["Item, ID", "Price (USD)"]);
		expect(tables.find((t) => t.tableName === "FOLDERS")?.columns.map((c) => c.name)).toEqual(["RUSH_FLAG"]);

		const existingMd = [
			"---",
			"source: schema/database/folders.sql",
			"---",
			"",
			"## FOLDERS",
			"",
			"| Column | Type | Constraints | Notes |",
			"| --- | --- | --- | --- |",
			"| `FOLDERNO` | `VARCHAR(20)` | PRIMARY KEY | Keep this engineer note |",
			"",
		].join("\n");
		const merged = mergeSqlTablesIntoMarkdown(existingMd, [{ tableName: "FOLDERS", columns: [{ name: "FOLDERNO", type: "VARCHAR(30)", constraints: "PRIMARY KEY" }, { name: "RUSH_FLAG", type: "VARCHAR(1)", constraints: "" }] }]);
		expect(merged.addedColumns).toBe(1);
		expect(merged.updatedColumns).toBe(1);
		expect(merged.text).toContain("Keep this engineer note");
		expect(merged.text).toContain("`RUSH_FLAG`");
	});

	test("schemaIndex indexes multi-table schemaObjects and extracts column definitions", () => {
		const doc: DocFile = {
			group: "schema",
			kind: "database",
			name: "database/lims_core.sql",
			path: "/ws/schema/database/lims_core.sql",
			exists: true,
			schemaObjects: ["dbo.FOLDERS", "FOLDERS", "ORDERS"],
		};
		expect(schemaDocKeys(doc)).toContain("folders");
		expect(findSchemaDocForIdentifier("ORDERS", [doc])).toBe(doc);

		const mdDoc: DocFile = { group: "schema", kind: "database", name: "database/DEMO_SAMPLES.md", path: "/ws/schema/database/DEMO_SAMPLES.md", exists: true, title: "DEMO_SAMPLES" };
		const cols = extractSchemaColumns(mdDoc, "# DEMO_SAMPLES\n\n| Column | Type | Null | Notes |\n| --- | --- | --- | --- |\n| `SAMPLE_ID` | varchar(20) | no | Primary key |\n");
		expect(cols).toEqual([{ table: "DEMO_SAMPLES", name: "SAMPLE_ID", type: "varchar(20)", constraints: "no", notes: "Primary key", docPath: mdDoc.path }]);
	});

	test("rewriteHeadingReferences updates Markdown anchors and wikilink/embed heading fragments cleanly", () => {
		const md = [
			"---",
			"title: Spec",
			"---",
			"See [here](#old-title), [there](spec.md#old-title), [[Spec#Old Title|Alias]], and ![[Spec#Old Title]].",
			"`#old-title` and `[[Spec#Old Title]]` in code stay untouched.",
		].join("\n");
		const res = rewriteHeadingReferences(md, {
			isSameDoc: true,
			matchesDocHref: (p) => p === "spec.md",
			matchesWikiTarget: (n) => n === "Spec",
			oldHeading: "Old Title",
			oldAnchor: "old-title",
			newHeading: "New Title",
			newAnchor: "new-title",
		});
		expect(res.count).toBe(4);
		expect(res.text).toContain("[here](#new-title)");
		expect(res.text).toContain("[there](spec.md#new-title)");
		expect(res.text).toContain("[[Spec#New Title|Alias]]");
		expect(res.text).toContain("![[Spec#New Title]]");
		expect(res.text).toContain("`#old-title`");
	});

	test("codeCitations preserves >40-line spans on re-anchor and refreshCitationExcerpt updates drifted snippets", async () => {
		const targetLines = Array.from({ length: 70 }, (_, i) => `Line ${i + 1};`);
		const shiftedTarget = ["// added 1", "// added 2", "// added 3", ...targetLines].join("\n");
		const excerpt40 = targetLines.slice(0, 40).join("\n");
		const doc = `See [A.ssl, lines 1 to 55](src/A.ssl#L1-L55)\n\n\`\`\`ssl\n${excerpt40}\n\`\`\`\n`;
		const issues = await checkCodeCitations("/ws/doc.md", doc, "/ws", async () => shiftedTarget);
		expect(issues).toHaveLength(1);
		expect(issues[0]!.reanchor).toEqual({ from: 4, to: 58 });

		const driftedDoc = "See [A.ssl](src/A.ssl#L1-L2)\n\n```ssl\nold 1\nold 2\n```\n";
		const refreshed = refreshCitationExcerpt(driftedDoc, { line: 1, href: "src/A.ssl#L1-L2", file: "src/A.ssl", from: 1, to: 2, snippet: "old 1\nold 2" }, "new 1\nnew 2\nnew 3\n");
		expect(refreshed).toBe("See [A.ssl](src/A.ssl#L1-L2)\n\n```ssl\nnew 1\nnew 2\n```\n");
	});

	test("Templater handles <%-* exec tags, existingKeys partial stripping, and YAML title quoting", async () => {
		const stripped = stripRawTemplateFrontmatter("---\n<%-* let k = 'LIMS-1' -%>\ntitle: <% k %>\n---\nBody <% k %>\n");
		expect(stripped).toContain("<%-* let k = 'LIMS-1' -%>");

		const partial = stripRawTemplateFrontmatter("---\ntitle: <% tp.system.prompt('Skip') %>\nstatus: draft\n---\nBody\n", new Set(["title"]));
		expect(partial).not.toContain("Skip");
		expect(partial).toContain("status: draft");

		const res = await renderTemplate(DEFAULT_TEMPLATES.find((t) => t.id === "investigation")!.content, {
			title: "QC #14 outlier: check",
			fileName: "qc.md",
			relativePath: "docs/qc.md",
			folder: "docs",
			projectName: "Demo",
			ticket: "LIMS-1",
		});
		expect(frontMatter(res.text).values.title).toBe("QC #14 outlier: check");
	});

	test("workContext includes plans & decision bodies, scriptsForTicket rolls up Epics, workList partitions archive, and docChecks flags superseded issues", async () => {
		const files: DocFile[] = [
			{ group: "tickets", name: "EP-1.md", path: "/ws/docs/tickets/EP-1.md", exists: true, ticket: "EP-1", title: "Epic", status: "in progress" },
			{ group: "tickets", name: "EP-2.md", path: "/ws/docs/tickets/EP-2.md", exists: true, ticket: "EP-2", title: "Child", status: "open", parent: "EP-1", codeRefs: ["src/Child.ssl"] },
			{ group: "tickets", name: "archive/OLD-1.md", path: "/ws/docs/tickets/archive/OLD-1.md", exists: true, ticket: "OLD-1", title: "Archived", status: "open" },
			{ group: "plans", name: "Flow.plan.json", path: "/ws/design/Flow.plan.json", exists: true, tickets: ["EP-1"] },
			{ group: "knowledge", kind: "decisions", name: "decisions/0001.md", path: "/ws/docs/knowledge/decisions/0001.md", exists: true, title: "Use views", status: "superseded", tickets: ["EP-1"], supersedes: ["0002"] },
			{ group: "knowledge", kind: "decisions", name: "decisions/0002.md", path: "/ws/docs/knowledge/decisions/0002.md", exists: true, title: "Use procs", status: "proposed", tickets: ["EP-1"], supersedes: ["0001"] },
		];
		expect(isArchivedTicket(files[2]!)).toBe(true);
		const wl = workList(files, "/ws", { sort: "key" });
		expect(wl.rows.some((r) => r.file.ticket === "OLD-1")).toBe(false);
		expect(wl.archived.map((r) => r.file.ticket)).toEqual(["OLD-1"]);

		expect(scriptsForTicket(files, "EP-1", { includeDescendants: true })).toContain("src/Child.ssl");

		const work = workFor(files, "EP-1")!;
		expect(work.plans).toHaveLength(1);
		const txt = await workText(work, async (p) => {
			if (p.endsWith("Flow.plan.json")) return JSON.stringify({ title: "Due Flow", goal: "Compute dates", targets: [{ script: "src/A.ssl" }], nodes: [{ label: "Load holidays" }] });
			if (p.endsWith("0002.md")) return "# Use procs\n\n## Decision\n\nUse stored procedures for bulk updates.\n";
			return "# Epic\n\nGoal.";
		});
		expect(txt).toContain("PLANS:");
		expect(txt).toContain("Load holidays");
		expect(txt).toContain("Use stored procedures for bulk updates.");

		const checks = docChecks(files);
		expect(checks.some((c) => c.text.includes("marked superseded but does not list superseded-by"))).toBe(true);
		expect(checks.some((c) => c.text.includes("circular supersedes chain"))).toBe(true);
		expect(tagSearchPattern("#due-dates")).toContain("due-dates");
	});

	test("markdownToDocx produces a valid PKZIP OpenXML archive containing styled WordprocessingML", () => {
		const bytes = markdownToDocx({
			title: "LIMS-101 Release Packet",
			subtitle: "Due Dates · 2026-11-23",
			markdown: [
				"---",
				"ticket: LIMS-101",
				"---",
				"# Overview",
				"",
				"> [!warning] Rollback",
				"> Back up `DEMO_SAMPLES` first.",
				"",
				"| Column | Type |",
				"| --- | --- |",
				"| `SAMPLE_ID` | `VARCHAR(20)` |",
				"",
				"- [x] Approved",
				"- [ ] Promoted",
			].join("\n"),
		});
		// PK\x03\x04 ZIP magic header
		expect(bytes[0]).toBe(0x50);
		expect(bytes[1]).toBe(0x4b);
		expect(bytes[2]).toBe(0x03);
		expect(bytes[3]).toBe(0x04);

		// Parse local ZIP entries and verify `word/document.xml` inflates cleanly with expected content.
		const entries = new Map<string, string>();
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let pos = 0;
		const dec = new TextDecoder();
		while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
			const compSize = view.getUint32(pos + 18, true);
			const nameLen = view.getUint16(pos + 26, true);
			const extraLen = view.getUint16(pos + 28, true);
			const name = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
			const dataStart = pos + 30 + nameLen + extraLen;
			const inflated = inflateRawSync(bytes.subarray(dataStart, dataStart + compSize));
			entries.set(name, dec.decode(inflated));
			pos = dataStart + compSize;
		}
		expect([...entries.keys()].sort()).toEqual([
			"[Content_Types].xml",
			"_rels/.rels",
			"docProps/core.xml",
			"word/_rels/document.xml.rels",
			"word/document.xml",
			"word/footer1.xml",
			"word/header1.xml",
			"word/styles.xml",
		]);
		const docXml = entries.get("word/document.xml")!;
		expect(docXml).toContain("LIMS-101 Release Packet");
		expect(docXml).toContain("Rollback");
		expect(docXml).toContain("SAMPLE_ID");
		expect(docXml).toContain("☑ Approved");
		expect(docXml).toContain("☐ Promoted");
	});

	test("backend listDocs, fileManifest, formatDocument, and docAudit enforce Round 4 invariants", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-r4-"));
		try {
			mkdirSync(join(dir, ".ssl-studio"), { recursive: true });
			mkdirSync(join(dir, "docs", "exports"), { recursive: true });
			mkdirSync(join(dir, "docs", "_templates"), { recursive: true });
			mkdirSync(join(dir, "docs", "tickets", "LIMS-1", "attachments"), { recursive: true });
			mkdirSync(join(dir, "docs", "tickets", "LIMS-1", "samples"), { recursive: true });
			mkdirSync(join(dir, "docs", "tickets", "archive", "LIMS-0", "attachments"), { recursive: true });
			mkdirSync(join(dir, "src"), { recursive: true });

			writeFileSync(join(dir, ".ssl-studio", "project.toml"), 'name = "Test"\n');
			writeFileSync(join(dir, "src", "Rule.ssl"), "line1;\nline2;\nline3;\n");
			writeFileSync(join(dir, "docs", "exports", "LIMS-1-packet.md"), "# Packet\n\n- [ ] Export task\n");
			writeFileSync(join(dir, "docs", "_templates", "custom.md"), '<!-- template: name="Custom" -->\n\n---\ntitle: <% tp.file.title %>\n---\n# Hi\n');
			writeFileSync(join(dir, "docs", "tickets", "LIMS-1", "samples", "q.sql"), "SELECT 1;\n");
			writeFileSync(join(dir, "docs", "tickets", "LIMS-1", "attachments", "shot.png"), new Uint8Array([137, 80, 78, 71]));
			writeFileSync(join(dir, "docs", "tickets", "archive", "LIMS-0", "attachments", "shot.png"), new Uint8Array([137, 80, 78, 71]));
			writeFileSync(
				join(dir, "docs", "tickets", "LIMS-1", "LIMS-1.md"),
				[
					"---",
					"ticket: LIMS-1",
					"tags: # inline comment",
					"  - due-dates",
					"summary: |",
					"  - bullet inside block scalar",
					"---",
					"",
					"# LIMS-1",
					"",
					"![used](attachments/shot.png)",
					"![[samples/q.sql]]",
					"![[missing-img.png]]",
					"See [Rule.ssl](../../../src/Rule.ssl#l10-l12)",
				].join("\n"),
			);

			const ws = new WorkspaceFiles(dir);
			const proj = await readProject(dir);
			const docs = await listDocs(ws, proj, { templatesFolder: "docs/_templates" });
			// exports/ and custom templatesFolder are excluded from Docs
			expect(docs.some((d) => d.path.includes("LIMS-1-packet.md"))).toBe(false);
			expect(docs.some((d) => d.path.includes("custom.md"))).toBe(false);

			const t1 = docs.find((d) => d.ticket === "LIMS-1")!;
			// Valid companion transclusion is NOT flagged broken; missing image embed IS flagged broken
			expect(t1.broken?.some((b) => b.href.includes("samples/q.sql"))).toBe(false);
			expect(t1.broken?.some((b) => b.href.includes("missing-img.png"))).toBe(true);

			const audit = await docAudit(ws, proj, undefined, { templatesFolder: "docs/_templates" });
			// Explicit path `attachments/shot.png` must NOT mask archived duplicate `shot.png`
			expect(audit.unusedAttachments.some((p) => p.includes("LIMS-0"))).toBe(true);
			// YAML inline comment and block scalar bullet must NOT produce false YAML errors
			expect(audit.issues.filter((i) => i.kind === "yaml")).toEqual([]);
			// Lowercase `#l10-l12` citation out of range IS caught by backend docAudit
			expect(audit.citationIssues?.length).toBe(1);
			expect(audit.issues.some((i) => i.kind === "citation")).toBe(true);

			// Dirty buffer overlay updates audit immediately without touching disk
			const cleanOverlay = await docAudit(ws, proj, undefined, {
				templatesFolder: "docs/_templates",
				dirtyBuffers: { [t1.path]: "---\nticket: LIMS-1\n---\n\n# Clean\n" },
			});
			expect(cleanOverlay.citationIssues?.length ?? 0).toBe(0);

			// Prettier blank-line template guard preserves YAML frontmatter
			const fmt = await formatDocument({ path: join(dir, "docs", "_templates", "custom.md"), languageId: "markdown", text: '<!-- template: name="Custom" -->\n\n---\ntitle: Hello\n---\n\n# Hi\n' }, dir);
			expect(fmt.ok).toBe(true);
			if (fmt.ok) expect(fmt.text).toContain("<!-- template: name=\"Custom\" -->\n---\ntitle: Hello\n---");

			// fileManifest excludes doc sub-areas when project.docs === "."
			const manifest = await fileManifest(ws, { ...proj, docs: "." });
			expect(manifest.some((f) => f.path.startsWith("tickets/") || f.path.startsWith("exports/"))).toBe(false);
			expect(manifest.some((f) => f.path === "src/Rule.ssl")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
