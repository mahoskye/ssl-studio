import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docAudit, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { checkCodeCitations, findCodeCitations, reanchorCitation } from "../src/shared/codeCitations";
import { deleteCsvColumn, parseCsv } from "../src/shared/csv";
import { docChecks } from "../src/shared/docChecks";
import {
	assembleDeploymentManifestCsv,
	assembleDeploymentManifestMarkdown,
	evaluateTicketReadiness,
	markdownToJira,
} from "../src/shared/docExport";
import { ownLinkEdits } from "../src/shared/docLinks";
import { frontMatter, frontMatterInnerSpan, quoteYamlScalar, withFrontMatter } from "../src/shared/frontMatter";
import type { DocFile } from "../src/shared/protocol";
import { extractSchemaPreview, findSchemaDocForIdentifier, referencedSchemaTables } from "../src/shared/schemaIndex";
import { extractSqlObjects, parseCreateTables } from "../src/shared/sqlSchema";
import { extractTags, isLikelyHexColorTag } from "../src/shared/tags";
import { stripRawTemplateFrontmatter } from "../src/shared/templater";
import { classifyTicketEntries } from "../src/shared/ticketBundle";
import {
	codeMatchesRef,
	cut,
	descendantTickets,
	docsGoverningFile,
	MAX_WORK_PROMPT_CHARS,
	ticketsForFile,
	workFor,
	workText,
} from "../src/shared/workContext";

const tmpRoot = mkdtempSync(join(tmpdir(), "ssl-studio-round3-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("Wave 1 P0 fixes — bundles, co-moved links, cut(), context cap", () => {
	test("archive/README.md and sprint-12/README.md never hijack grouping folders as one ticket bundle", () => {
		const res = classifyTicketEntries([
			{ path: "/ws/docs/tickets/archive/README.md", rel: "archive/README.md", size: 50 },
			{ path: "/ws/docs/tickets/archive/DEMO-101.md", rel: "archive/DEMO-101.md", size: 100, frontTicket: "DEMO-101" },
			{ path: "/ws/docs/tickets/archive/DEMO-102.md", rel: "archive/DEMO-102.md", size: 100, frontTicket: "DEMO-102" },
			{ path: "/ws/docs/tickets/sprint-12/README.md", rel: "sprint-12/README.md", size: 40 },
			{ path: "/ws/docs/tickets/sprint-12/DEMO-103.md", rel: "sprint-12/DEMO-103.md", size: 120, frontTicket: "DEMO-103" },
		]);
		expect(res.filter((r) => r.entry.frontTicket).map((r) => r.entry.frontTicket).sort()).toEqual([
			"DEMO-101",
			"DEMO-102",
			"DEMO-103",
		]);
		expect(res.every((r) => !r.folderRel)).toBe(true);
	});

	test("ownLinkEdits with co-moved pairs keeps intra-bundle links intact on Layout 1 rename and Layout 2 archive", () => {
		// Layout 1 rename: folder /ws/docs/tickets/TEMP-1 -> /ws/docs/tickets/LIMS-456 AND doc TEMP-1.md -> LIMS-456.md
		const l1Text = "See [notes](notes.md) and [spec](../../specs/s1.md).\n";
		const l1Edits = ownLinkEdits(
			l1Text,
			"/ws/docs/tickets/TEMP-1/TEMP-1.md",
			"/ws/docs/tickets/LIMS-456/LIMS-456.md",
			[
				{ from: "/ws/docs/tickets/TEMP-1/TEMP-1.md", to: "/ws/docs/tickets/LIMS-456/LIMS-456.md" },
				{ from: "/ws/docs/tickets/TEMP-1", to: "/ws/docs/tickets/LIMS-456" },
			],
		);
		// Intra-bundle link `notes.md` stays `notes.md` (not rewritten to `../TEMP-1/notes.md`), and `../../specs/s1.md` is unchanged!
		expect(l1Edits).toEqual([]);

		// Layout 2 archive: DEMO-103.md -> archive/DEMO-103.md AND sibling DEMO-103/ -> archive/DEMO-103/
		const l2Text = "Fixture [sql](DEMO-103/sample.sql) and [spec](../specs/due.md).\n";
		const l2Edits = ownLinkEdits(
			l2Text,
			"/ws/docs/tickets/DEMO-103.md",
			"/ws/docs/tickets/archive/DEMO-103.md",
			[
				{ from: "/ws/docs/tickets/DEMO-103.md", to: "/ws/docs/tickets/archive/DEMO-103.md" },
				{ from: "/ws/docs/tickets/DEMO-103", to: "/ws/docs/tickets/archive/DEMO-103" },
			],
		);
		// `DEMO-103/sample.sql` stays valid inside `archive/`! Only `../specs/due.md` moves to `../../specs/due.md`.
		expect(l2Edits).toHaveLength(1);
		expect(l2Edits[0]!.href).toBe("../specs/due.md");
		expect(l2Edits[0]!.instead).toBe("../../specs/due.md");
	});

	test("cut() hard-caps spaceless minified JSON/XML/HL7 and workText enforces MAX_WORK_PROMPT_CHARS", async () => {
		const minified = "A".repeat(20_000);
		const clipped = cut(minified, 100);
		expect(clipped.length).toBeLessThan(130);
		expect(clipped.startsWith("A".repeat(100))).toBe(true);

		const ticket: DocFile = {
			path: "/ws/docs/tickets/DEMO-1.md",
			name: "DEMO-1.md",
			group: "tickets",
			exists: true,
			ticket: "DEMO-1",
			title: "Big ticket",
			status: "in progress",
		};
		const specs: DocFile[] = Array.from({ length: 12 }, (_, i) => ({
			path: `/ws/docs/specs/s${i}.md`,
			name: `s${i}.md`,
			group: "specs",
			exists: true,
			tickets: ["DEMO-1"],
			title: `Spec ${i}`,
		}));
		const work = workFor([ticket, ...specs], "DEMO-1")!;
		const txt = await workText(work, async () => `# Heading\n\n${"word ".repeat(1500)}`);
		expect(txt.length).toBeLessThanOrEqual(MAX_WORK_PROMPT_CHARS + 30);
	});
});

describe("Wave 2 fixes — YAML, SQL DDL, CSV, Jira export, readiness, citations, tags, Templater, docChecks", () => {
	test("frontMatter preserves leading <!-- template: ... --> comments, quotes risky scalars, and keeps [[wikilink]] as scalar", () => {
		expect(quoteYamlScalar("Fix: colon & #hash")).toBe('"Fix: colon & #hash"');
		expect(quoteYamlScalar("[[DEMO-101]]")).toBe('"[[DEMO-101]]"');
		expect(quoteYamlScalar("[a, b]")).toBe('"[a, b]"');
		expect(quoteYamlScalar("plain value")).toBe("plain value");

		const tpl = "<!-- template: name=Demo; description=Test -->\n---\ntitle: Sample\nref: [[DEMO-101]]\n---\n\n# Body\n";
		const fm = frontMatter(tpl);
		expect(fm.values.title).toBe("Sample");
		expect(fm.values.ref).toBe("[[DEMO-101]]");
		expect(Array.isArray(fm.values.ref)).toBe(false);
		expect(fm.body.trim()).toBe("# Body");

		const span = frontMatterInnerSpan(tpl);
		expect(span).not.toBeNull();
		expect(span!.inner).toContain("title: Sample");

		const updated = withFrontMatter(tpl, "status", "ready: now")!;
		expect(updated.startsWith("<!-- template: name=Demo; description=Test -->\n---\n")).toBe(true);
		expect(frontMatter(updated).values.status).toBe("ready: now");
	});

	test("sqlSchema handles Oracle ALTER TABLE ADD (...), T-SQL GO blocks, #Temp skips, and dotted identifiers", () => {
		const sql = `
CREATE TABLE #TEMP_WORK (ID INT);
CREATE TABLE [dbo].[My.Table] (
  ID INT NOT NULL,
  CODE VARCHAR(20)
);
GO
ALTER TABLE [dbo].[My.Table] ADD STATUS VARCHAR(15) NOT NULL;
GO
CREATE TABLE ORDERS (
  ORDNO VARCHAR2(20) NOT NULL
);
ALTER TABLE ORDERS ADD (
  AMOUNT NUMBER(10, 2) NOT NULL,
  NOTE VARCHAR2(200)
);
`;
		const tables = parseCreateTables(sql);
		expect(tables.map((t) => t.tableName)).toEqual(["My.Table", "ORDERS"]);
		const myTable = tables[0]!;
		expect(myTable.columns.map((c) => c.name)).toEqual(["ID", "CODE", "STATUS"]);
		const orders = tables[1]!;
		expect(orders.columns.map((c) => c.name)).toEqual(["ORDNO", "AMOUNT", "NOTE"]);
		expect(orders.columns[1]!.type).toContain("NUMBER(10, 2)");

		const objs = extractSqlObjects(sql);
		expect(objs.some((o) => o.bareName.startsWith("#"))).toBe(false);
		expect(objs.some((o) => o.bareName === "My.Table")).toBe(true);
	});

	test("CSV TSV detection ignores quoted commas in header and deleteCsvColumn preserves ragged 1-cell rows", () => {
		const tsv = '"Name, Full"\tStatus\tNotes\nDueDate\tverified\tok\n';
		const parsed = parseCsv(tsv);
		expect(parsed.delimiter).toBe("\t");
		expect(parsed.header.map((c) => c.text)).toEqual(["Name, Full", "Status", "Notes"]);

		const ragged = "a,b\n1\n2,3\n";
		const deleted = deleteCsvColumn(ragged, parseCsv(ragged), 0)!;
		const reparsed = parseCsv(deleted);
		expect(reparsed.rows).toHaveLength(2);
		expect(reparsed.rows[0]![0]!.text).toBe("");
		expect(reparsed.rows[1]![0]!.text).toBe("3");
	});

	test("markdownToJira preserves SQL asterisks, double backticks, wiki images, fenced info args, and mixed nested lists", () => {
		const md = [
			"<!-- internal comment -->",
			"Run ``a `b` c`` and SELECT * FROM t WHERE a * b.",
			"![[flow.png|400]]",
			"```sql title=query",
			"SELECT * FROM DEMO_HOLIDAYS;",
			"```",
			"- Outer",
			"  1. Inner numbered",
			"    - Deep bullet",
		].join("\n");
		const jira = markdownToJira(md);
		expect(jira).not.toContain("internal comment");
		expect(jira).toContain("{{a `b` c}}");
		expect(jira).toContain("SELECT * FROM t WHERE a * b.");
		expect(jira).toContain("!flow.png!");
		expect(jira).toContain("{code:sql}\nSELECT * FROM DEMO_HOLIDAYS;\n{code}");
		expect(jira).toContain("* Outer\n*# Inner numbered\n*#* Deep bullet");
	});

	test("codeCitations handles #L10-20 shorthand, skips inline backticks and non-code fences, and matches 40-line prefix", async () => {
		const srcLines = Array.from({ length: 50 }, (_, i) => `line_${i + 1}();`);
		const docText = [
			"Inline example `[code](src/a.ssl#L1-L2)` should not be scanned.",
			"",
			"[snippet](src/a.ssl#L1-45)",
			"",
			"```ssl",
			...srcLines.slice(0, 40),
			"```",
			"",
			"[moved](src/a.ssl#L2-3)",
			"",
			"```ssl",
			"line_10();",
			"line_11();",
			"```",
		].join("\n");
		const cites = findCodeCitations(docText);
		expect(cites).toHaveLength(2);
		expect(cites[0]!.href).toBe("src/a.ssl#L1-45");
		expect(cites[1]!.href).toBe("src/a.ssl#L2-3");

		const issues = await checkCodeCitations("/ws/docs/note.md", docText, "/ws", async (p) =>
			p.endsWith("a.ssl") ? srcLines.join("\n") : null,
		);
		// First citation matches via 40-line prefix -> NO false drift; second drifted to L10-L11!
		expect(issues).toHaveLength(1);
		expect(issues[0]!.reanchor).toEqual({ from: 10, to: 11 });
		const reanchored = reanchorCitation(docText, issues[0]!.citation, 10, 11);
		expect(reanchored).toContain("[moved](src/a.ssl#L10-L11)");
	});

	test("tags preserve STARLIMS terms #cab, #dba, #cda while ignoring CSS hex colors and wikilink anchors", () => {
		expect(isLikelyHexColorTag("cab")).toBe(false);
		expect(isLikelyHexColorTag("dba")).toBe(false);
		expect(isLikelyHexColorTag("cda")).toBe(false);
		expect(isLikelyHexColorTag("fff")).toBe(true);
		expect(isLikelyHexColorTag("ff00aa")).toBe(true);

		const md = "---\ntags: [cab, dba, cda, release]\n---\n\nSee [[Guide#Section]] and <!-- #hidden --> #cab color #fff.\n";
		const tags = extractTags(md);
		expect(tags).toEqual(["cab", "dba", "cda", "release"]);
	});

	test("Templater stripRawTemplateFrontmatter preserves <%* multi-statement execution blocks", () => {
		const raw = "---\ntitle: T\n---\n<%* let a = 1; let b = 2; %>\nHello <% a %>\n";
		const stripped = stripRawTemplateFrontmatter(raw);
		expect(stripped.startsWith("<%* let a = 1; let b = 2; %>")).toBe(true);
	});

	test("docChecks reports asymmetric superseded-by and orphan .plan.json files", () => {
		const files: DocFile[] = [
			{
				path: "/ws/docs/knowledge/decisions/0001-old.md",
				name: "0001-old.md",
				group: "knowledge",
				kind: "decisions",
				exists: true,
				status: "superseded",
				supersededBy: ["0002-new"],
			},
			{
				path: "/ws/docs/knowledge/decisions/0002-new.md",
				name: "0002-new.md",
				group: "knowledge",
				kind: "decisions",
				exists: true,
				status: "decided",
			},
			{
				path: "/ws/docs/tickets/T-1.md",
				name: "T-1.md",
				group: "tickets",
				exists: true,
				ticket: "T-1",
				status: "in progress",
			},
			{
				path: "/ws/design/Orphan.plan.json",
				name: "Orphan.plan.json",
				group: "plans",
				exists: true,
				title: "Orphan plan",
			},
		];
		const findings = docChecks(files);
		expect(findings.some((f) => f.text.includes("superseded by") && f.text.includes("0002-new"))).toBe(true);
		expect(findings.some((f) => f.text.includes("Orphan.plan.json") && f.text.includes("no ticket"))).toBe(true);
	});
});

describe("Wave 3 features — Schema bridge, recursive epics, deployment manifest, workContext, docAudit", () => {
	test("schemaIndex locates table docs, extracts inline column preview, and finds referenced tables in SSL/SQL", () => {
		const schemaDoc: DocFile = {
			path: "/ws/schema/database/DEMO_HOLIDAYS.md",
			name: "DEMO_HOLIDAYS.md",
			group: "schema",
			kind: "database",
			exists: true,
			title: "DEMO_HOLIDAYS",
			source: "schema/database/demo_holidays.sql",
		};
		expect(findSchemaDocForIdentifier("DEMO_HOLIDAYS", [schemaDoc])).toBe(schemaDoc);
		expect(findSchemaDocForIdentifier("dbo.DEMO_HOLIDAYS", [schemaDoc])).toBe(schemaDoc);

		const md = "---\ntitle: DEMO_HOLIDAYS\n---\n\n# DEMO_HOLIDAYS\n\nHoliday calendar by site.\n\n| Column | Type | Meaning |\n| --- | --- | --- |\n| SITE_ID | VARCHAR(20) | Site key |\n| HOLIDAY_DT | DATE | Holiday date |\n";
		const prev = extractSchemaPreview(schemaDoc, md);
		expect(prev).toContain("Holiday calendar");
		expect(prev).toContain("HOLIDAY_DT");

		const ssl = 'SQLExecute("SELECT HOLIDAY_DT FROM dbo.DEMO_HOLIDAYS WHERE SITE_ID = ?SITE?");';
		expect(referencedSchemaTables(ssl, [schemaDoc])).toEqual([schemaDoc]);
	});

	test("workContext handles descendantTickets, 3-part Cat.Script.Proc, extensionless paths, ticketsForFile, and files.csv suppression", () => {
		const epic: DocFile = { path: "/ws/docs/tickets/E-1.md", name: "E-1.md", group: "tickets", exists: true, ticket: "E-1", title: "Epic", status: "in progress" };
		const story: DocFile = { path: "/ws/docs/tickets/E-2.md", name: "E-2.md", group: "tickets", exists: true, ticket: "E-2", parent: "E-1", title: "Story", status: "in progress" };
		const task: DocFile = { path: "/ws/docs/tickets/E-3.md", name: "E-3.md", group: "tickets", exists: true, ticket: "E-3", parent: "E-2", title: "Task", status: "done" };
		expect(descendantTickets([epic, story, task], "E-1").map((d) => d.ticket)).toEqual(["E-2", "E-3"]);

		// 3-part Cat.Script.Proc & extensionless slash path without cross-folder false positives
		expect(codeMatchesRef("/ws/src/DueDates/SetSampleDueDates.ssl", "DueDates.SetSampleDueDates.CalcDue", "/ws")).toBe(true);
		expect(codeMatchesRef("/ws/src/DueDates/SetSampleDueDates.ssl", "DueDates/SetSampleDueDates", "/ws")).toBe(true);
		expect(codeMatchesRef("/ws/src/Other/SetSampleDueDates.ssl", "DueDates/SetSampleDueDates", "/ws")).toBe(false);

		const filesManifest: DocFile = {
			path: "/ws/docs/registries/files.csv",
			name: "files.csv",
			group: "registries",
			exists: true,
			codeRefs: ["src/DueDates/SetSampleDueDates.ssl"],
		};
		// Sole files.csv entry does not trigger noisy "1 doc" badge on untouched scripts
		expect(docsGoverningFile([filesManifest], "/ws/src/DueDates/SetSampleDueDates.ssl", "/ws")).toEqual([]);

		const t1: DocFile = { path: "/ws/docs/tickets/DEMO-101.md", name: "DEMO-101.md", group: "tickets", exists: true, ticket: "DEMO-101", codeRefs: ["SetSampleDueDates.ssl"] };
		const t2: DocFile = { path: "/ws/docs/tickets/DEMO-102.md", name: "DEMO-102.md", group: "tickets", exists: true, ticket: "DEMO-102", codeRefs: ["SetSampleDueDates.ssl"] };
		expect(ticketsForFile([t1, t2], "/ws/src/DueDates/SetSampleDueDates.ssl", "/ws")).toEqual(["DEMO-101", "DEMO-102"]);
	});

	test("evaluateTicketReadiness handles recursive epics, dropped sub-tickets, blockers, and statusless registries; deployment manifest formats Markdown & CSV", () => {
		const files: DocFile[] = [
			{
				path: "/ws/docs/tickets/EP-1.md",
				name: "EP-1.md",
				group: "tickets",
				exists: true,
				ticket: "EP-1",
				title: "Due Dates Epic",
				status: "in progress",
				blockedBy: ["DEP-9"],
			},
			{ path: "/ws/docs/tickets/DEP-9.md", name: "DEP-9.md", group: "tickets", exists: true, ticket: "DEP-9", title: "Prerequisite", status: "open" },
			{ path: "/ws/docs/tickets/EP-2.md", name: "EP-2.md", group: "tickets", exists: true, ticket: "EP-2", parent: "EP-1", title: "Child", status: "done" },
			{ path: "/ws/docs/tickets/EP-3.md", name: "EP-3.md", group: "tickets", exists: true, ticket: "EP-3", parent: "EP-2", title: "Grandchild", status: "in progress" },
			{ path: "/ws/docs/tickets/EP-4.md", name: "EP-4.md", group: "tickets", exists: true, ticket: "EP-4", parent: "EP-1", title: "Dropped", status: "dropped" },
			{
				path: "/ws/docs/registries/settings.csv",
				name: "settings.csv",
				group: "registries",
				exists: true,
				tickets: ["EP-1"],
				forTickets: [{ key: "EP-1", rows: 2 }],
			},
		];
		const rep = evaluateTicketReadiness(files, "EP-1")!;
		expect(rep.ready).toBe(false);
		expect(rep.checks.find((c) => c.label === "Sub-tickets")?.detail).toContain("1 of 2 still open (EP-3)");
		expect(rep.checks.find((c) => c.label === "Blockers")?.detail).toContain("DEP-9");
		expect(rep.checks.find((c) => c.label === "Registry rows")?.level).toBe("note");

		const manifestInput = {
			projectName: "Due Dates",
			generatedOn: "2026-11-23",
			ticketKey: "EP-1",
			ticketTitle: "Due Dates Epic",
			status: "in progress",
			scopeTickets: [
				{ key: "EP-1", title: "Due Dates Epic", status: "in progress" },
				{ key: "EP-2", title: "Child", status: "done" },
			],
			scripts: [{ ref: "src/SetSampleDueDates.ssl", kind: "SSL Script", ticket: "EP-1" }],
			sqlArtifacts: [{ path: "schema/database/demo_holidays.sql", kind: "DDL source", source: "DEMO_HOLIDAYS" }],
			registries: [{ title: "Settings", headers: ["name", "status", "ticket"], rows: [["DUE_DAYS", "verified", "EP-1"]] }],
			readiness: rep,
		};
		const md = assembleDeploymentManifestMarkdown(manifestInput);
		expect(md).toContain("# Deployment Manifest — EP-1: Due Dates Epic");
		expect(md).toContain("src/SetSampleDueDates.ssl");
		expect(md).toContain("schema/database/demo_holidays.sql");
		expect(md).toContain("| Stage | Target | Verified By | Sign-Off |");
		expect(md).toContain("| PROD | Production |");

		const csv = assembleDeploymentManifestCsv(manifestInput);
		expect(csv).toContain("Category,Artifact,Ticket,Status,Notes");
		expect(csv).toContain("SSL Script,src/SetSampleDueDates.ssl,EP-1,planned");
		expect(csv).toContain("Registry: Settings,DUE_DAYS,EP-1,verified");
	});

	test("backend docAudit detects unused attachments, open tasks, broken #heading anchors, YAML issues, and ADR 0008 table issues", async () => {
		const root = join(tmpRoot, "audit-ws");
		mkdirSync(join(root, "docs", "attachments"), { recursive: true });
		mkdirSync(join(root, "docs", "tickets", "T-1", "attachments"), { recursive: true });
		mkdirSync(join(root, "schema", "database"), { recursive: true });

		writeFileSync(join(root, "docs", "attachments", "used.png"), "PNG");
		writeFileSync(join(root, "docs", "attachments", "orphan.png"), "PNG");
		writeFileSync(join(root, "docs", "tickets", "T-1", "attachments", "bundle-orphan.png"), "PNG");

		writeFileSync(
			join(root, "docs", "tickets", "T-1", "T-1.md"),
			[
				"---",
				"ticket: T-1",
				"status: in progress",
				"---",
				"",
				"# T-1: Audit test",
				"",
				"![Used](../../attachments/used.png)",
				"See [missing section](#no-such-heading).",
				"",
				"- [ ] First open task",
				"- [x] Completed task",
				"",
				"| A | B | C | D | E |",
				"| --- | --- | --- | --- | --- |",
				"| 1 | 2 | 3 | 4 | 5 |",
				"",
			].join("\n"),
		);
		// Schema table with 5 columns should be excluded from ADR 0008 table warnings
		writeFileSync(
			join(root, "schema", "database", "BIG.md"),
			"# BIG\n\n| Col1 | Col2 | Col3 | Col4 | Col5 |\n| --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 |\n",
		);
		// Unclosed YAML frontmatter
		writeFileSync(join(root, "docs", "broken-yaml.md"), "---\ntitle: Oops\n# Forgot closing fence\n");

		const ws = new WorkspaceFiles(root);
		const project = await readProject(root);
		const res = await docAudit(ws, project);

		expect(res.unusedAttachments.some((p) => p.endsWith("orphan.png"))).toBe(true);
		expect(res.unusedAttachments.some((p) => p.endsWith("bundle-orphan.png"))).toBe(true);
		expect(res.unusedAttachments.some((p) => p.endsWith("used.png"))).toBe(false);

		expect(res.openTasks).toHaveLength(1);
		expect(res.openTasks[0]!.ticket).toBe("T-1");
		expect(res.openTasks[0]!.text).toBe("First open task");

		expect(res.issues.some((i) => i.kind === "anchor" && i.message.includes("no-such-heading"))).toBe(true);
		expect(res.issues.some((i) => i.kind === "yaml" && i.path.endsWith("broken-yaml.md"))).toBe(true);
		expect(res.issues.some((i) => i.kind === "table" && i.path.endsWith("T-1.md"))).toBe(true);
		expect(res.issues.some((i) => i.kind === "table" && i.path.endsWith("BIG.md"))).toBe(false);
	});
});
