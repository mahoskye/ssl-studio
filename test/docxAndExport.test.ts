import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { markdownToDocx, parseDocxToMarkdown } from "../src/bun/docx";
import { parseCsv } from "../src/shared/csv";
import {
	assembleDeploymentManifestCsv,
	assembleDeploymentManifestMarkdown,
	assembleReleaseBundleMarkdown,
	assembleReleaseNotesMarkdown,
	assembleRtmCsv,
	assembleRtmMarkdown,
	assembleTicketPacketMarkdown,
	buildPrintableHtml,
	buildRtmRows,
	evaluateTicketReadiness,
	extractExportMeta,
	markdownToJira,
	renderFrontMatterSummaryHtml,
} from "../src/shared/docExport";
import { checkTables } from "../src/shared/docTables";
import { htmlToMarkdown, looksLikeRichHtml, tsvToMarkdownTable } from "../src/shared/htmlToMarkdown";
import type { DocFile } from "../src/shared/protocol";
import { ticketsFromJson, ticketsFromTable } from "../src/shared/ticketImport";

/** Builds minimal valid PNG bytes carrying exact `width` x `height` in its IHDR chunk. */
function makePngBytes(width: number, height: number): Uint8Array {
	const buf = new Uint8Array(33);
	// PNG signature
	buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const dv = new DataView(buf.buffer);
	dv.setUint32(8, 13, false); // IHDR length
	buf.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
	dv.setUint32(16, width, false);
	dv.setUint32(20, height, false);
	buf[24] = 8; // bit depth
	buf[25] = 2; // color type RGB
	return buf;
}

/** Unpacks all ZIP entries from `.docx` bytes via local headers for assertions. */
function unpackZip(bytes: Uint8Array): Map<string, Uint8Array> {
	const entries = new Map<string, Uint8Array>();
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const dec = new TextDecoder();
	let pos = 0;
	while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
		const method = view.getUint16(pos + 8, true);
		const compSize = view.getUint32(pos + 18, true);
		const nameLen = view.getUint16(pos + 26, true);
		const extraLen = view.getUint16(pos + 28, true);
		const name = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
		const dataStart = pos + 30 + nameLen + extraLen;
		const slice = bytes.subarray(dataStart, dataStart + compSize);
		entries.set(name, method === 8 ? new Uint8Array(inflateRawSync(slice)) : new Uint8Array(slice));
		pos = dataStart + compSize;
	}
	return entries;
}

describe("DOCX writer fidelity (images, Mermaid PNGs, hyperlinks, footnotes, metadata, parser fixes)", () => {
	test("embeds local PNG images, Mermaid PNGs, hyperlinks, metadata table, footnotes, and fixes parser bugs", () => {
		const ws = mkdtempSync(join(tmpdir(), "ssl-studio-docx-"));
		const outside = mkdtempSync(join(tmpdir(), "ssl-studio-docx-outside-"));
		try {
			mkdirSync(join(ws, "docs", "attachments"), { recursive: true });
			mkdirSync(join(ws, "docs", "specs"), { recursive: true });
			const shotBytes = makePngBytes(800, 400); // 2:1 aspect ratio
			writeFileSync(join(ws, "docs", "attachments", "shot.png"), shotBytes);
			writeFileSync(join(outside, "secret.png"), makePngBytes(100, 100));

			const mermaidPng = Buffer.from(makePngBytes(1200, 600)).toString("base64"); // wider than page -> clamped!
			const md = [
				"---",
				"ticket: LIMS-204",
				"status: approved",
				"version: 1.2",
				"owner: Lab Ops",
				"approved-by: QA Lead",
				"approved-date: 2026-11-23",
				"release: v2.4",
				"---",
				"",
				"# Due Date Workflow",
				"",
				"Visit [STARLIMS Docs](https://example.test/docs) or email <mailto:qa@example.test>[^iso].",
				"",
				"Formatting: ==critical==, _italic_, __bold__, ***bold-italic***, and keep `SAMPLE_ID_NUM` and DEMO_SAMPLE_ID unitalicized.",
				"",
				"![[shot.png|300]]",
				"![[missing-shot.png|400]]",
				`![escape](${join("..", "..", "..", outside.split("/").pop()!, "secret.png")})`,
				"",
				"```mermaid",
				"flowchart LR",
				"  A[Login] --> B[Verify]",
				"```",
				"",
				"> Plain blockquote line without a blue Note box.",
				"",
				"> [!warning] Rollback Steps",
				"> - Export XFD backup",
				"> - Run reverse DDL",
				"> ```sql",
				"> DROP VIEW dbo.V_TEMP;",
				"> ```",
				"",
				"| Expression | Meaning |",
				"| --- | --- |",
				"| `a | b` | Bitwise OR inside backticks |",
				"",
				"[^iso]: Per ISO/IEC 17025 clause 7.11.",
			].join("\n");

			const bytes = markdownToDocx({
				title: "Due Date Workflow",
				subtitle: "Lab Project · 2026-11-23",
				markdown: md,
				baseDir: join(ws, "docs", "specs"),
				workspaceRoot: ws,
				mermaidPngs: { "mermaid-0": mermaidPng },
			});

			// Valid PKZIP header
			expect(bytes[0]).toBe(0x50);
			expect(bytes[1]).toBe(0x4b);

			const dec = new TextDecoder();
			const entries = unpackZip(bytes);
			const docXml = dec.decode(entries.get("word/document.xml")!);
			const relsXml = dec.decode(entries.get("word/_rels/document.xml.rels")!);
			const typesXml = dec.decode(entries.get("[Content_Types].xml")!);

			// Embedded images packed in word/media/ and registered in ContentTypes + rels (outside workspace blocked!)
			expect(entries.has("word/media/image1.png")).toBe(true);
			expect(entries.has("word/media/image2.png")).toBe(true);
			expect(entries.has("word/media/image3.png")).toBe(false);
			expect(typesXml).toContain('Extension="png" ContentType="image/png"');
			expect(relsXml).toContain('Target="media/image1.png"');
			expect(relsXml).toContain('Target="media/image2.png"');

			// Aspect-preserving EMU for 800x400 image with `|300` -> cx=300*9525=2857500, cy=1428750
			expect(docXml).toContain("<w:drawing><wp:inline");
			expect(docXml).toContain('cx="2857500" cy="1428750"');
			// 1200x600 Mermaid diagram clamped to page width 5943600 x 2971800
			expect(docXml).toContain('cx="5943600" cy="2971800"');
			expect(docXml).not.toContain("flowchart LR");

			// `![[missing-shot.png|400]]` NEVER turns into literal "400"
			expect(docXml).toContain("[Image: missing-shot.png]");
			expect(docXml).not.toContain(">400<");

			// Real clickable hyperlinks with TargetMode="External"
			expect(relsXml).toContain('Target="https://example.test/docs" TargetMode="External"');
			expect(relsXml).toContain('Target="mailto:qa@example.test" TargetMode="External"');
			expect(docXml).toContain("<w:hyperlink r:id=");
			expect(docXml).toContain("STARLIMS Docs");

			// Ordinary blockquote does NOT render as blue "Note" callout; warning callout keeps nested bullets + SQL
			expect(docXml).toContain("Plain blockquote line without a blue Note box.");
			expect(docXml).not.toContain(">Note<");
			expect(docXml).toContain("Rollback Steps");
			expect(docXml).toContain("Export XFD backup");
			expect(docXml).toContain("DROP VIEW dbo.V_TEMP;");

			// Pipe table with `a | b` stays a 2-column row (no spurious 3rd cell!)
			expect(docXml).toContain("a | b");
			expect(docXml).toContain("Bitwise OR inside backticks");

			// Highlight, _italic_, __bold__, ***bold-italic***, and safe identifier underscores
			expect(docXml).toContain('<w:highlight w:val="yellow"/>');
			expect(docXml).toContain("<w:i/></w:rPr><w:t xml:space=\"preserve\">italic</w:t>");
			expect(docXml).toContain("<w:b/></w:rPr><w:t xml:space=\"preserve\">bold</w:t>");
			expect(docXml).toContain("<w:b/><w:i/></w:rPr><w:t xml:space=\"preserve\">bold-italic</w:t>");
			expect(docXml).toContain("DEMO_SAMPLE_ID");

			// Metadata table + footnotes
			expect(docXml).toContain("Approved by");
			expect(docXml).toContain("QA Lead");
			expect(docXml).toContain("v2.4");
			expect(docXml).toContain('<w:vertAlign w:val="superscript"/>');
			expect(docXml).toContain("Footnotes");
			expect(docXml).toContain("Per ISO/IEC 17025 clause 7.11.");
		} finally {
			rmSync(ws, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("DOCX pure-TS reader round-trip", () => {
	test("parses headings, bold/italic, hyperlinks, GFM tables, lists, and embedded images back to Markdown", () => {
		const ws = mkdtempSync(join(tmpdir(), "ssl-studio-docx-rt-"));
		try {
			const png = makePngBytes(120, 80);
			writeFileSync(join(ws, "diagram.png"), png);

			const original = [
				"# System Overview",
				"",
				"## Architecture",
				"",
				"Uses **strong** text, _emphasis_, and [Portal](https://lims.example.test/portal).",
				"",
				"![Architecture](diagram.png)",
				"",
				"- First requirement",
				"- Second requirement",
				"",
				"| Column | Type |",
				"| --- | --- |",
				"| SAMPLE_ID | VARCHAR(20) |",
				"| STATUS | VARCHAR(10) |",
			].join("\n");

			const bytes = markdownToDocx({
				title: "System Overview",
				markdown: original,
				baseDir: ws,
				workspaceRoot: ws,
			});

			const parsed = parseDocxToMarkdown(bytes);
			expect(parsed.markdown).toContain("# System Overview");
			expect(parsed.markdown).toContain("## Architecture");
			expect(parsed.markdown).toContain("**strong**");
			expect(parsed.markdown).toContain("*emphasis*");
			expect(parsed.markdown).toContain("[Portal](https://lims.example.test/portal)");
			expect(parsed.markdown).toContain("- First requirement");
			expect(parsed.markdown).toContain("- Second requirement");
			expect(parsed.markdown).toContain("| Column | Type |");
			expect(parsed.markdown).toContain("| --- | --- |");
			expect(parsed.markdown).toContain("| SAMPLE_ID | VARCHAR(20) |");
			expect(parsed.markdown).toContain("{{DOCX_IMG:image1.png}}");
			expect(parsed.images).toHaveLength(1);
			expect(parsed.images[0]!.name).toBe("image1.png");
			expect(parsed.images[0]!.bytes).toEqual(png);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	test("parses native Word <w:numPr> lists, Title style, and multi-run formatted paragraphs", () => {
		const docXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Legacy SOP</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Top bullet</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Nested </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r></w:p>
</w:body>
</w:document>`;
		// Build a minimal valid ZIP containing word/document.xml using central directory.
		const enc = new TextEncoder();
		const nameBytes = enc.encode("word/document.xml");
		const raw = enc.encode(docXml);
		const comp = new Uint8Array(deflateRawSync(raw));
		const local = new Uint8Array(30 + nameBytes.length + comp.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(8, 8, true);
		lv.setUint32(18, comp.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		local.set(comp, 30 + nameBytes.length);

		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, 8, true);
		cv.setUint32(20, comp.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint32(42, 0, true);
		central.set(nameBytes, 46);

		const eocd = new Uint8Array(22);
		const ev = new DataView(eocd.buffer);
		ev.setUint32(0, 0x06054b50, true);
		ev.setUint16(8, 1, true);
		ev.setUint16(10, 1, true);
		ev.setUint32(12, central.length, true);
		ev.setUint32(16, local.length, true);

		const zip = new Uint8Array(local.length + central.length + eocd.length);
		zip.set(local, 0);
		zip.set(central, local.length);
		zip.set(eocd, local.length + central.length);

		const parsed = parseDocxToMarkdown(zip);
		expect(parsed.markdown).toBe("# Legacy SOP\n\n- Top bullet\n  - **Nested bold**");
		expect(parsed.images).toEqual([]);
	});
});

describe("htmlToMarkdown and tsvToMarkdownTable", () => {
	test("converts rich HTML (headings, tables, nested lists, code, links, mark, blockquote) cleanly", () => {
		const html = `
			<html><body>
				<h2>Release Notes</h2>
				<p>Updated <strong>due dates</strong> with <mark>rush</mark> support and <a href="https://example.test/spec">Spec</a>.</p>
				<ul>
					<li>Parent item
						<ol><li>Sub step 1</li><li>Sub step 2</li></ol>
					</li>
				</ul>
				<table>
					<tr><th>Key</th><th>Value</th></tr>
					<tr><td>DAYS</td><td><code>3 | 5</code></td></tr>
				</table>
				<pre><code class="language-sql">SELECT * FROM FOLDERS;</code></pre>
			</body></html>
		`;
		expect(looksLikeRichHtml(html)).toBe(true);
		const md = htmlToMarkdown(html);
		expect(md).toContain("## Release Notes");
		expect(md).toContain("**due dates**");
		expect(md).toContain("==rush==");
		expect(md).toContain("[Spec](https://example.test/spec)");
		expect(md).toContain("- Parent item");
		expect(md).toContain("  1. Sub step 1");
		expect(md).toContain("| Key | Value |");
		expect(md).toContain("`3 \\| 5`");
		expect(md).toContain("```sql\nSELECT * FROM FOLDERS;\n```");
	});

	test("converts tabular TSV into GFM tables while rejecting tab-indented code", () => {
		const tsv = "Column\tType\tNotes\nSAMPLE_ID\tVARCHAR(20)\tPrimary | key\nSTATUS\tVARCHAR(10)\tActive\n";
		const table = tsvToMarkdownTable(tsv);
		expect(table).toBe(
			[
				"| Column | Type | Notes |",
				"| --- | --- | --- |",
				"| SAMPLE_ID | VARCHAR(20) | Primary \\| key |",
				"| STATUS | VARCHAR(10) | Active |",
			].join("\n"),
		);
		expect(tsvToMarkdownTable("\tconst a = 1;\n\tconst b = 2;\n")).toBeNull();
	});
});

describe("docExport — KaTeX HTML, Jira fixes, Governance/Test Readiness, Release Bundles, & RTM", () => {
	test("buildPrintableHtml embeds KaTeX print CSS and frontmatter metadata summary card", () => {
		const meta = extractExportMeta("---\nticket: LIMS-101\nstatus: approved\napproved-by: QA Lead\napproved-date: 2026-11-23\nrelease: v2.4\n---\n\n# Body\n");
		expect(meta).toMatchObject({ Ticket: "LIMS-101", Status: "approved", "Approved by": "QA Lead", Release: "v2.4" });
		const metaHtml = renderFrontMatterSummaryHtml(meta);
		expect(metaHtml).toContain("doc-meta-card");
		expect(metaHtml).toContain("QA Lead");

		const html = buildPrintableHtml("Formula Spec", '<span class="katex"><span class="katex-mathml">x</span><span class="katex-html">x</span></span>', "Lab", metaHtml);
		expect(html).toContain(".katex .katex-mathml");
		expect(html).toContain("clip: rect(1px, 1px, 1px, 1px)");
		expect(html).toContain(".katex .mfrac .frac-line");
		expect(html).toContain(".doc-meta-card");
		expect(html).toContain("QA Lead");
	});

	test("markdownToJira strips folder paths from attachments, formats [[Target#Heading]], and maps mermaid to {code:none}", () => {
		const md = [
			"![Screen](../attachments/due-screen.png)",
			"![[docs/attachments/flow.png|400]]",
			"See [[DueSpec#Holiday Rules]] and [[#Overview]] and [[DueSpec#Holiday Rules|Rules]].",
			"",
			"```mermaid",
			"graph TD",
			"  A --> B",
			"```",
		].join("\n");
		const jira = markdownToJira(md);
		expect(jira).toContain("!due-screen.png!");
		expect(jira).not.toContain("!../attachments/due-screen.png!");
		expect(jira).toContain("!flow.png!");
		expect(jira).not.toContain("docs/attachments/flow.png");
		expect(jira).toContain("DueSpec — Holiday Rules");
		expect(jira).toContain("and Overview and Rules");
		expect(jira).toContain("{code:none}\ngraph TD\n  A --> B\n{code}");
		expect(jira).not.toContain("{code:mermaid}");
	});

	test("evaluateTicketReadiness checks controlled approvals & test coverage, and manifest CSV stamps owning sub-tickets", () => {
		const docs: DocFile[] = [
			{
				group: "tickets",
				name: "EP-10.md",
				path: "/ws/docs/tickets/EP-10.md",
				exists: true,
				ticket: "EP-10",
				title: "GxP Turnaround",
				status: "done",
				release: "v2.4",
				priority: "High",
				gxpImpact: "direct",
				changeControl: "CAB-2026-44",
				tasks: { done: 2, total: 2 },
			},
			{
				group: "tickets",
				name: "EP-11.md",
				path: "/ws/docs/tickets/EP-11.md",
				exists: true,
				ticket: "EP-11",
				parent: "EP-10",
				title: "Holiday Table",
				status: "done",
			},
			{
				group: "plans",
				name: "CalcDue.plan.json",
				path: "/ws/design/CalcDue.plan.json",
				exists: true,
				heading: "Calc Due Plan",
				tickets: ["EP-10"],
				codeRefs: ["src/CalcDue.ssl"],
				testScripts: ["tests/CalcDue.test.ssl"],
				planTests: [{ name: "Skips weekend", given: "Friday login", expect: "Monday due date" }],
			},
		];

		// Missing approvedBy on direct-GxP ticket triggers warn
		const unapproved = evaluateTicketReadiness(docs, "EP-10")!;
		expect(unapproved.ready).toBe(false);
		expect(unapproved.checks.find((c) => c.label === "Controlled approval")?.level).toBe("warn");
		expect(unapproved.checks.find((c) => c.label === "Test coverage")?.ok).toBe(true);
		expect(unapproved.checks.find((c) => c.label === "Test coverage")?.detail).toContain("1 test script, 1 plan test case");

		// Adding formal approval passes the gate
		docs[0]!.approvedBy = "QA Director";
		docs[0]!.approvedDate = "2026-11-23";
		const approved = evaluateTicketReadiness(docs, "EP-10")!;
		expect(approved.ready).toBe(true);
		expect(approved.checks.find((c) => c.label === "Controlled approval")?.level).toBe("pass");

		// Ticket Packet & Deployment Manifest include tests, HEAD SHA, CAB ID, checksums, and per-subticket CSV stamping
		const packet = assembleTicketPacketMarkdown({
			projectName: "LabCore",
			generatedOn: "2026-11-23",
			ticketKey: "EP-10",
			ticketTitle: "GxP Turnaround",
			status: "done",
			release: "v2.4",
			approvedBy: "QA Director",
			approvedDate: "2026-11-23",
			changeControl: "CAB-2026-44",
			ticketBody: "# EP-10\n\nDetails.",
			specs: [],
			plans: [{ name: "CalcDue.plan.json", title: "Calc Due Plan", scripts: ["src/CalcDue.ssl"], testScripts: ["tests/CalcDue.test.ssl"], planTests: [{ name: "Skips weekend", expect: "Monday" }] }],
			decisions: [],
			questions: [],
			registries: [],
			ticketFiles: [],
		});
		expect(packet).toContain("## Test Coverage & Verification");
		expect(packet).toContain("`tests/CalcDue.test.ssl`");
		expect(packet).toContain("Skips weekend");
		expect(packet).toContain("CAB-2026-44");

		const manifestInput = {
			projectName: "LabCore",
			generatedOn: "2026-11-23",
			ticketKey: "EP-10",
			ticketTitle: "GxP Turnaround",
			headSha: "abcdef1234567890",
			changeControl: "CAB-2026-44",
			targetEnvironment: "QA -> PROD",
			scopeTickets: [
				{ key: "EP-10", title: "GxP Turnaround", status: "done" },
				{ key: "EP-11", title: "Holiday Table", status: "done" },
			],
			scripts: [{ ref: "src/CalcDue.ssl", kind: "SSL Script", ticket: "EP-10" }],
			testScripts: [{ ref: "tests/CalcDue.test.ssl", ticket: "EP-10" }],
			sqlArtifacts: [{ path: "schema/database/holidays.sql", kind: "DDL source", source: "DEMO_HOLIDAYS", ticket: "EP-11" }],
			registries: [{ title: "Database", headers: ["object", "status", "ticket"], rows: [["DEMO_HOLIDAYS", "verified", "EP-11"]] }],
			checksums: [{ path: "src/CalcDue.ssl", sha256: "0123456789abcdef0123456789abcdef" }],
		};
		const manifestMd = assembleDeploymentManifestMarkdown(manifestInput);
		expect(manifestMd).toContain("HEAD Commit SHA");
		expect(manifestMd).toContain("abcdef1234567890");
		expect(manifestMd).toContain("CAB-2026-44");
		expect(manifestMd).toContain("QA -> PROD");
		expect(manifestMd).toContain("## Artifact Checksums");
		expect(manifestMd).toContain("tests/CalcDue.test.ssl");

		const manifestCsv = assembleDeploymentManifestCsv(manifestInput);
		expect(manifestCsv).toContain("DDL source,schema/database/holidays.sql,EP-11,planned,DEMO_HOLIDAYS");
		expect(manifestCsv).toContain("Test Script,tests/CalcDue.test.ssl,EP-10,planned");
		expect(manifestCsv).toContain("Registry: Database,DEMO_HOLIDAYS,EP-11,verified");
	});

	test("assembleReleaseBundleMarkdown deduplicates artifacts and assembleReleaseNotesMarkdown groups changes", () => {
		const input = {
			projectName: "LabCore",
			releaseName: "v2.4",
			generatedOn: "2026-11-23",
			headSha: "998877665544",
			gitRange: { from: "v2.3", to: "HEAD" },
			tickets: [
				{ key: "LIMS-10", title: "Holiday calendar", type: "Story", status: "done", priority: "High", summary: "Skip regional holidays" },
				{ key: "LIMS-11", title: "Fix leap-year calc", type: "Bug", status: "done", priority: "Critical" },
			],
			scripts: [
				{ ref: "src/DueDates.ssl", kind: "SSL Script", ticket: "LIMS-10" },
				{ ref: "src/DueDates.ssl", kind: "SSL Script", ticket: "LIMS-11" },
			],
			testScripts: [
				{ ref: "tests/DueDates.test.ssl", ticket: "LIMS-10" },
				{ ref: "tests/DueDates.test.ssl", ticket: "LIMS-11" },
			],
			sqlArtifacts: [
				{ path: "schema/holidays.sql", kind: "DDL", source: "HOLIDAYS", ticket: "LIMS-10" },
				{ path: "schema/holidays.sql", kind: "DDL", source: "HOLIDAYS", ticket: "LIMS-11" },
			],
			registries: [
				{ title: "Settings", headers: ["name", "status"], rows: [["DUE_DAYS", "verified"], ["DUE_DAYS", "verified"]] },
			],
			rollbackNotes: [
				{ ticket: "LIMS-10", body: "Restore backup package." },
				{ ticket: "LIMS-11", body: "Restore   backup package." },
			],
			commits: [{ sha: "998877665544", shortSha: "9988776", author: "Dev", subject: "LIMS-10 Add holiday table" }],
		};

		const bundle = assembleReleaseBundleMarkdown(input);
		expect(bundle).toContain("# Release Bundle — v2.4");
		expect(bundle).toContain("LIMS-10, LIMS-11");
		// Deduplicated to a single row for DueDates.ssl and DUE_DAYS and rollback note
		expect(bundle.match(/`src\/DueDates\.ssl`/g)?.length).toBe(1);
		expect(bundle.match(/`tests\/DueDates\.test\.ssl`/g)?.length).toBe(1);
		expect(bundle.match(/`schema\/holidays\.sql`/g)?.length).toBe(1);
		expect(bundle.match(/DUE_DAYS/g)?.length).toBe(1);
		expect(bundle.match(/Restore/g)?.length).toBe(1);
		expect(bundle).toContain("## Git Commits in Range");
		expect(bundle).toContain("9988776");

		const notes = assembleReleaseNotesMarkdown(input);
		expect(notes).toContain("# Release Notes — v2.4");
		expect(notes).toContain("## Features & Enhancements");
		expect(notes).toContain("## Bug Fixes");
		expect(notes).toContain("**LIMS-10**: Holiday calendar");
		expect(notes).toContain("**LIMS-11**: Fix leap-year calc");
		expect(notes).toContain("## Commit Highlights (`v2.3..HEAD`)");
	});

	test("buildRtmRows, assembleRtmCsv, and assembleRtmMarkdown trace full lifecycle cleanly", () => {
		const docs: DocFile[] = [
			{
				group: "tickets",
				name: "LIMS-1.md",
				path: "/ws/docs/tickets/LIMS-1.md",
				exists: true,
				ticket: "LIMS-1",
				title: "Sample Intake",
				status: "done",
				release: "v2.4",
				priority: "High",
				tasks: { done: 3, total: 3 },
				approvedBy: "QA Lead",
				approvedDate: "2026-11-23",
				changeControl: "CAB-12",
			},
			{
				group: "specs",
				name: "intake.md",
				path: "/ws/docs/specs/intake.md",
				exists: true,
				title: "Intake Spec",
				tickets: ["LIMS-1"],
				codeRefs: ["src/Intake.ssl"],
			},
			{
				group: "plans",
				name: "Intake.plan.json",
				path: "/ws/design/Intake.plan.json",
				exists: true,
				heading: "Intake Flow",
				tickets: ["LIMS-1"],
				codeRefs: ["src/Intake.ssl"],
				testScripts: ["tests/Intake.test.ssl"],
				planTests: [{ name: "Validates barcode" }],
			},
			{
				group: "knowledge",
				kind: "decisions",
				name: "decisions/0001-barcode.md",
				path: "/ws/docs/knowledge/decisions/0001-barcode.md",
				exists: true,
				title: "Use Code-128",
				tickets: ["LIMS-1"],
			},
			{
				group: "registries",
				name: "settings.csv",
				path: "/ws/docs/registries/settings.csv",
				exists: true,
				tickets: ["LIMS-1"],
				forTickets: [{ key: "LIMS-1", rows: 2, done: 2 }],
			},
		];

		const rows = buildRtmRows(docs, undefined, "1122334455667788");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			ticket: "LIMS-1",
			acceptanceCriteria: "3/3",
			specs: ["Intake Spec"],
			plans: ["Intake Flow"],
			codeScripts: ["src/Intake.ssl"],
			testScripts: ["tests/Intake.test.ssl"],
			planTests: ["Validates barcode"],
			decisions: ["Use Code-128"],
			registries: ["Application settings (2/2)"],
			approval: "QA Lead (2026-11-23)",
			changeControl: "CAB-12",
			headSha: "112233445566",
		});

		const csv = assembleRtmCsv(rows);
		expect(csv).toContain("Ticket,Title,Status,Release,Priority,Acceptance Criteria,Specs,Plans,Code Scripts,Test Scripts,Business Tests,Decisions,Registries,Approval,Change Control,Git SHA");
		expect(csv).toContain("LIMS-1,Sample Intake,done,v2.4,High,3/3,Intake Spec,Intake Flow,src/Intake.ssl,tests/Intake.test.ssl,Validates barcode,Use Code-128,Application settings (2/2),QA Lead (2026-11-23),CAB-12,112233445566");

		const md = assembleRtmMarkdown(rows, "LabCore");
		expect(md).toContain("# Requirements Traceability Matrix — LabCore");
		expect(md).toContain("### LIMS-1: Sample Intake");
		expect(md).toContain("Validates barcode");
		// Every table in RTM Markdown must respect ADR 0008!
		expect(checkTables(md)).toEqual([]);
	});
});

describe("ticketImport metadata preservation (release, priority, tags)", () => {
	test("ticketsFromTable preserves Fix Version/s, Sprint, Iteration Path, Priority, and Labels/Tags/Components", () => {
		const csv = [
			"Issue key,Summary,Status,Priority,Fix Version/s,Sprint,Labels,Labels,Component/s,Description",
			'LIMS-50,Rush intake,Open,High,v2.4,Sprint 12,gxp,due-dates,Intake Core,"h2. Scope\n\nHandle rush samples."',
			'LIMS-51,Fallback sprint,Open,Medium,,"com.atlassian.greenhopper.service.sprint.Sprint@1[id=9,name=Sprint 14,state=ACTIVE]",urgent,,,Plain text.',
		].join("\n");
		const res = ticketsFromTable(parseCsv(csv));
		expect(res.tickets).toHaveLength(2);
		expect(res.tickets[0]!.release).toBe("v2.4");
		expect(res.tickets[0]!.priority).toBe("High");
		expect(res.tickets[0]!.tags).toEqual(["gxp", "due-dates", "Intake-Core"]);
		expect(res.tickets[1]!.release).toBe("Sprint 14");
		expect(res.tickets[1]!.priority).toBe("Medium");
		expect(res.tickets[1]!.tags).toEqual(["urgent"]);

		const adoCsv = [
			"Work Item ID,Title,State,Priority,Iteration Path,Tags,Description",
			'701,Audit log,Active,1,LabCore\\R2026.11,"iso17025; audit","<div><table><tr><th>Col</th><th>Val</th></tr><tr><td>A</td><td>1</td></tr></table></div>"',
		].join("\n");
		const ado = ticketsFromTable(parseCsv(adoCsv));
		expect(ado.tickets[0]!.release).toBe("LabCore\\R2026.11");
		expect(ado.tickets[0]!.priority).toBe("1");
		expect(ado.tickets[0]!.tags).toEqual(["iso17025", "audit"]);
		expect(ado.tickets[0]!.description).toContain("| Col | Val |");
	});

	test("ticketsFromJson preserves fixVersions/milestone, priority, and labels/components", () => {
		const jiraJson = {
			issues: [
				{
					key: "LIMS-88",
					fields: {
						summary: "Instrument bridge",
						status: { name: "In Progress" },
						priority: { name: "Major" },
						fixVersions: [{ name: "v3.0" }],
						labels: ["hl7", "bridge"],
						components: [{ name: "Interfaces" }],
						description: "Bridge notes.",
					},
				},
			],
		};
		const jira = ticketsFromJson(jiraJson);
		expect(jira.tickets[0]!.release).toBe("v3.0");
		expect(jira.tickets[0]!.priority).toBe("Major");
		expect(jira.tickets[0]!.tags).toEqual(["hl7", "bridge", "Interfaces"]);

		const ghJson = [
			{
				number: 42,
				title: "Add export tests",
				state: "OPEN",
				milestone: { title: "M5" },
				labels: [{ name: "testing" }, { name: "docs" }],
				body: "Details.",
			},
		];
		const gh = ticketsFromJson(ghJson);
		expect(gh.tickets[0]!.release).toBe("M5");
		expect(gh.tickets[0]!.tags).toEqual(["testing", "docs"]);
	});
});
