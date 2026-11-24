import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { markdownToDocx, parseDocxToMarkdown } from "../src/bun/docx";
import { parseCsv } from "../src/shared/csv";
import {
	assembleDeploymentManifestMarkdown,
	assembleDeploymentRunbook,
	assembleReleaseBundleCsv,
	assembleReleaseBundleMarkdown,
	assembleRtmCsv,
	assembleRtmMarkdown,
	assembleTestExecutionProtocol,
	assembleTicketPacketMarkdown,
	buildPrintableHtml,
	buildRtmRows,
	detectChecksumDrift,
	evaluateTicketReadiness,
	isTestRunStale,
	orderSqlTablesTopologically,
	parseTestRunDocument,
	transformMarkdownFootnotes,
	type TestRunSummary,
} from "../src/shared/docExport";
import { checkTables } from "../src/shared/docTables";
import type { DocFile } from "../src/shared/protocol";
import { DEFAULT_TEMPLATES, renderTemplate } from "../src/shared/templater";

/** Builds minimal valid PNG bytes carrying exact `width` x `height` in its IHDR chunk. */
function makePngBytes(width: number, height: number): Uint8Array {
	const buf = new Uint8Array(33);
	buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const dv = new DataView(buf.buffer);
	dv.setUint32(8, 13, false);
	buf.set([0x49, 0x48, 0x44, 0x52], 12);
	dv.setUint32(16, width, false);
	dv.setUint32(20, height, false);
	buf[24] = 8;
	buf[25] = 2;
	return buf;
}

/** Packs arbitrary files into a valid PKZIP archive with Central Directory + EOCD for reader tests. */
function packZip(entries: { name: string; data: Uint8Array | string }[]): Uint8Array {
	const enc = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = enc.encode(entry.name);
		const raw = typeof entry.data === "string" ? enc.encode(entry.data) : entry.data;
		const comp = new Uint8Array(deflateRawSync(raw));

		const local = new Uint8Array(30 + nameBytes.length + comp.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true);
		lv.setUint16(8, 8, true);
		lv.setUint32(18, comp.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		local.set(comp, 30 + nameBytes.length);
		locals.push(local);

		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 8, true);
		cv.setUint32(20, comp.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		centrals.push(central);
		offset += local.length;
	}

	const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);

	const out = new Uint8Array(offset + centralSize + eocd.length);
	let pos = 0;
	for (const b of locals) (out.set(b, pos), (pos += b.length));
	for (const b of centrals) (out.set(b, pos), (pos += b.length));
	out.set(eocd, pos);
	return out;
}

/** Unpacks all ZIP entries from `.docx` bytes via local headers. */
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

describe("Wave 1.3 & 3.4 — Print/PDF Multi-Page Table Pagination, @page Chrome, and HTML Footnotes", () => {
	test("buildPrintableHtml allows multi-page table pagination, repeats thead, keeps tr intact, and emits @page running headers/footers", () => {
		const html = buildPrintableHtml(
			"GxP Schema Spec",
			"<table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>A</td></tr></tbody></table>",
			"LabCore · 2026-11-24",
			undefined,
			{
				title: "GxP Schema Spec",
				version: "2.1",
				status: "approved",
				"change-control": "CAB-2026-99",
			},
		);

		// Multi-page tables MUST NOT carry break-inside: avoid on `table`
		expect(html).not.toMatch(/\btable\s*\{[^}]*break-inside:\s*avoid/);
		expect(html).not.toMatch(/pre,\s*blockquote,\s*table/);

		// Header groups repeat across pages and rows avoid mid-row splits
		expect(html).toContain("thead { display: table-header-group; }");
		expect(html).toContain("tr { break-inside: avoid; page-break-inside: avoid; }");

		// Controlled-document @page margins & running headers/footers
		expect(html).toContain("@page {");
		expect(html).toContain("@top-left {");
		expect(html).toContain('content: "GxP Schema Spec";');
		expect(html).toContain("@top-right {");
		expect(html).toContain("v2.1 · approved · CAB-2026-99");
		expect(html).toContain("@bottom-right {");
		expect(html).toContain('content: "Page " counter(page) " of " counter(pages);');
	});

	test("buildPrintableHtml safely escapes hostile characters in @page CSS strings", () => {
		const html = buildPrintableHtml('Bad"</style><script>alert(1)</script>', "<p>Ok</p>", undefined, undefined, {
			status: 'draft";</style>',
		});
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("\\3c /style\\3e");
	});

	test("transformMarkdownFootnotes skips inline backtick code spans and renders safe inline Markdown inside HTML footnotes", () => {
		const md = [
			"Write `[^1]` or ``code `[^1]` sample`` to reference a footnote[^1], and another[^xss].",
			"",
			"[^1]: See [ISO 17025](https://example.test/iso), run `DEMO_CALC`, and note **critical** *rules* with `SAMPLE_ID_NUM`.",
			"[^xss]: Ignore [bad](javascript:alert(1)) and <script>alert(2)</script> safely.",
		].join("\n");

		const out = transformMarkdownFootnotes(md, "html");
		// Code spans stay intact verbatim
		expect(out).toContain("Write `[^1]` or ``code `[^1]` sample``");
		// Real reference is converted
		expect(out).toContain('footnote<sup class="md-fn-ref"><a href="#fn-1" id="fnref-1">1</a></sup>');
		// Inline Markdown inside HTML footnote definitions is rendered cleanly
		expect(out).toContain('<a href="https://example.test/iso" target="_blank" rel="noopener noreferrer">ISO 17025</a>');
		expect(out).toContain("<code>DEMO_CALC</code>");
		expect(out).toContain("<strong>critical</strong>");
		expect(out).toContain("<em>rules</em>");
		expect(out).toContain("<code>SAMPLE_ID_NUM</code>");
		// XSS payloads neutralized
		expect(out).not.toContain("javascript:alert");
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
	});
});

describe("Wave 1.6 & 3.4 — DOCX Writer Fidelity & Controlled-Document Chrome", () => {
	test("protects inline/display math from italic parsing, emits header1/footer1/core.xml/TOC/cantSplit, and resolves custom folders + rasterizedImages", () => {
		const ws = mkdtempSync(join(tmpdir(), "ssl-studio-r6-docx-"));
		try {
			mkdirSync(join(ws, "custom-media"), { recursive: true });
			mkdirSync(join(ws, "kb", "specs"), { recursive: true });
			writeFileSync(join(ws, "custom-media", "badge.png"), makePngBytes(200, 100));

			const rasterSvgPng = Buffer.from(makePngBytes(320, 160)).toString("base64");
			const md = [
				"---",
				"ticket: LIMS-601",
				"version: 1.4",
				"status: approved",
				"owner: QA Engineering",
				"change-control: CAB-2026-77",
				"tags: [gxp, validation]",
				"date: 2026-11-24",
				"---",
				"",
				"# Calibration Formula",
				"",
				"Compute $a * b + c * d$ and keep $x_1 + y_2$ crisp; budget is $100 and $200.",
				"",
				"$$",
				"E = m * c^2 + k_1 * k_2",
				"$$",
				"",
				"![Badge](badge.png)",
				"![Flow SVG](diagrams/flow.svg)",
				"![Unrasterized WebP](diagrams/raw-chart.webp)",
				"",
				"| Param | Value |",
				"| --- | --- |",
				"| Factor | 1.25 |",
			].join("\n");

			const bytes = markdownToDocx({
				title: "Calibration Formula",
				subtitle: "LabCore · 2026-11-24",
				markdown: md,
				baseDir: join(ws, "kb", "specs"),
				workspaceRoot: ws,
				attachmentsFolder: "custom-media",
				docsFolder: "kb",
				rasterizedImages: { "diagrams/flow.svg": `data:image/png;base64,${rasterSvgPng}` },
				toc: true,
				headerFooter: true,
			});

			const dec = new TextDecoder();
			const entries = unpackZip(bytes);
			const docXml = dec.decode(entries.get("word/document.xml")!);
			const relsXml = dec.decode(entries.get("word/_rels/document.xml.rels")!);
			const rootRelsXml = dec.decode(entries.get("_rels/.rels")!);
			const typesXml = dec.decode(entries.get("[Content_Types].xml")!);
			const headerXml = dec.decode(entries.get("word/header1.xml")!);
			const footerXml = dec.decode(entries.get("word/footer1.xml")!);
			const coreXml = dec.decode(entries.get("docProps/core.xml")!);
			const settingsXml = dec.decode(entries.get("word/settings.xml")!);

			// Inline & display math protected from `*`/`_` italic parsing!
			expect(docXml).toContain("a * b + c * d");
			expect(docXml).toContain("x_1 + y_2");
			expect(docXml).toContain("E = m * c^2 + k_1 * k_2");
			expect(docXml).toContain("budget is $100 and $200.");
			// Display math paragraph is centered monospace
			expect(docXml).toContain('<w:jc w:val="center"/>');
			// Ensure no italic run wraps `a * b + c * d` or `b + c`
			expect(docXml).not.toContain("<w:i/></w:rPr><w:t xml:space=\"preserve\"> b + c ");

			// Custom attachmentsFolder PNG + rasterized SVG embedded; unrasterized WebP gets clean styled callout box
			expect(entries.has("word/media/image1.png")).toBe(true);
			expect(entries.has("word/media/image2.png")).toBe(true);
			expect(entries.has("word/media/image3.png")).toBe(false);
			expect(docXml).toContain("Image (WEBP): Unrasterized WebP");
			expect(docXml).not.toContain("[Image: Unrasterized WebP]");

			// Controlled-document header1.xml & footer1.xml with native PAGE of NUMPAGES fields
			expect(headerXml).toContain("Calibration Formula");
			expect(headerXml).toContain("v1.4 · approved · CAB-2026-77");
			expect(footerXml).toContain("Generated 2026-11-24");
			expect(footerXml).toContain(" PAGE ");
			expect(footerXml).toContain(" NUMPAGES ");
			expect(docXml).toContain('<w:headerReference w:type="default"');
			expect(docXml).toContain('<w:footerReference w:type="default"');
			expect(relsXml).toContain('Target="header1.xml"');
			expect(relsXml).toContain('Target="footer1.xml"');
			expect(typesXml).toContain('PartName="/word/header1.xml"');
			expect(typesXml).toContain('PartName="/word/footer1.xml"');

			// docProps/core.xml metadata
			expect(coreXml).toContain("<dc:title>Calibration Formula</dc:title>");
			expect(coreXml).toContain("<dc:creator>QA Engineering</dc:creator>");
			expect(coreXml).toContain("<cp:keywords>");
			expect(coreXml).toContain("LIMS-601");
			expect(coreXml).toContain("<dcterms:created");
			expect(rootRelsXml).toContain('Target="docProps/core.xml"');
			expect(typesXml).toContain('PartName="/docProps/core.xml"');

			// Every table row has `<w:cantSplit/>`
			expect(docXml).toContain("<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>");
			expect(docXml).toContain("<w:trPr><w:cantSplit/></w:trPr>");

			// TOC field + word/settings.xml auto-update
			expect(docXml).toContain('TOC \\o "1-3" \\h \\z \\u');
			expect(settingsXml).toContain('<w:updateFields w:val="true"/>');
			expect(relsXml).toContain('Target="settings.xml"');
			expect(typesXml).toContain('PartName="/word/settings.xml"');
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	test("headerFooter: false omits header1.xml and footer1.xml cleanly", () => {
		const bytes = markdownToDocx({
			title: "Minimal Doc",
			markdown: "# Hello\n\nPlain body.",
			headerFooter: false,
		});
		const entries = unpackZip(bytes);
		expect(entries.has("word/header1.xml")).toBe(false);
		expect(entries.has("word/footer1.xml")).toBe(false);
		expect(entries.has("docProps/core.xml")).toBe(true);
	});
});

describe("Wave 1.6 — DOCX Reader Fidelity (numbering, outlineLvl, footnotes, VML, AlternateContent, Track Changes, Comments)", () => {
	test("parses numbering.xml ordered/bullet lists, styles.xml outlineLvl headings, footnotes.xml, VML images, AlternateContent without duplication, Track Changes, and QA comments", () => {
		const png = makePngBytes(64, 64);

		const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="CustomSection">
    <w:name w:val="Section Head"/>
    <w:pPr><w:outlineLvl w:val="1"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="SubSectionInherited">
    <w:name w:val="Sub Section"/>
    <w:basedOn w:val="CustomSection"/>
  </w:style>
</w:styles>`;

		const numberingXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="10">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="20">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num>
</w:numbering>`;

		const footnotesXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t> Per 21 CFR Part 11.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;

		const commentsXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="QA Reviewer" w:date="2026-11-24T10:00:00Z">
    <w:p><w:r><w:t>Verify audit log timestamp format.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;

		const docRelsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/legacy.png"/>
</Relationships>`;

		const docXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:v="urn:schemas-microsoft-com:vml">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="CustomSection"/></w:pPr><w:r><w:t>Validation Scope</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="SubSectionInherited"/></w:pPr><w:r><w:t>Inherited Heading</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Step one</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Sub step a</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Step two</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Bullet item</w:t></w:r></w:p>
  <w:p>
    <w:r><w:t>Electronic records apply</w:t></w:r>
    <w:r><w:footnoteReference w:id="1"/></w:r>
    <w:r><w:t> with </w:t></w:r>
    <w:ins w:id="1" w:author="Dev"><w:r><w:t>new rule</w:t></w:r></w:ins>
    <w:del w:id="2" w:author="Dev"><w:r><w:delText>old rule</w:delText></w:r></w:del>
    <w:r><w:commentReference w:id="7"/></w:r>
  </w:p>
  <w:p>
    <mc:AlternateContent>
      <mc:Choice Requires="wps"><w:r><w:t>Unique diagram caption</w:t></w:r></mc:Choice>
      <mc:Fallback><w:r><w:t>Unique diagram caption</w:t></w:r></mc:Fallback>
    </mc:AlternateContent>
  </w:p>
  <w:p><w:r><w:pict><v:shape><v:imagedata r:id="rIdImg1"/></v:shape></w:pict></w:r></w:p>
</w:body>
</w:document>`;

		const zip = packZip([
			{ name: "word/document.xml", data: docXml },
			{ name: "word/styles.xml", data: stylesXml },
			{ name: "word/numbering.xml", data: numberingXml },
			{ name: "word/footnotes.xml", data: footnotesXml },
			{ name: "word/comments.xml", data: commentsXml },
			{ name: "word/_rels/document.xml.rels", data: docRelsXml },
			{ name: "word/media/legacy.png", data: png },
		]);

		const parsed = parseDocxToMarkdown(zip);

		// Custom & inherited outlineLvl heading styles -> ##
		expect(parsed.markdown).toContain("## Validation Scope");
		expect(parsed.markdown).toContain("## Inherited Heading");

		// Ordered numbering.xml list vs bullet list
		expect(parsed.markdown).toContain("1. Step one");
		expect(parsed.markdown).toContain("  1. Sub step a");
		expect(parsed.markdown).toContain("2. Step two");
		expect(parsed.markdown).toContain("- Bullet item");

		// Footnote reference + definition (separator skipped!)
		expect(parsed.markdown).toContain("Electronic records apply[^1]");
		expect(parsed.markdown).toContain("[^1]: Per 21 CFR Part 11.");
		expect(parsed.markdown).not.toContain("[^-1]");

		// Track changes preserved visibly (never silently accepted or dropped)
		expect(parsed.markdown).toContain("==new rule==");
		expect(parsed.markdown).toContain("~~old rule~~");

		// QA comments imported as footnotes
		expect(parsed.markdown).toContain("[^comment-7]");
		expect(parsed.markdown).toContain("[^comment-7]: [QA Comment — QA Reviewer, 2026-11-24]: Verify audit log timestamp format.");

		// AlternateContent Choice kept once (Fallback skipped, zero duplication!)
		expect(parsed.markdown.match(/Unique diagram caption/g)?.length).toBe(1);

		// Legacy VML `<v:imagedata>` extracted cleanly
		expect(parsed.markdown).toContain("{{DOCX_IMG:legacy.png}}");
		expect(parsed.images).toHaveLength(1);
		expect(parsed.images[0]!.bytes).toEqual(png);

		// Warnings surfaced
		expect(parsed.warnings).toEqual([
			"Imported document contained unaccepted Word Track Changes — marked with ==ins== / ~~del~~ for review.",
			"Imported 1 Word QA review comment(s) as footnotes.",
		]);
	});
});

describe("Wave 3.2 — IQ/OQ/PQ Validation Test Execution Evidence, Template, Readiness, Packet & RTM", () => {
	test("built-in Validation Test Run (IQ/OQ/PQ) template renders cleanly and keeps ADR 0008", async () => {
		const tpl = DEFAULT_TEMPLATES.find((t) => t.name === "Validation Test Run (IQ/OQ/PQ)");
		expect(tpl).toBeDefined();
		const res = await renderTemplate(tpl!.content, {
			title: "LIMS-401 OQ Run",
			fileName: "LIMS-401-OQ.md",
			relativePath: "docs/tests/LIMS-401-OQ.md",
			folder: "docs/tests",
			projectName: "LabCore",
			ticket: "LIMS-401",
			now: new Date(2026, 10, 24),
		});
		expect(res.cancelled).toBe(false);
		expect(res.text).not.toContain("<%");
		expect(checkTables(res.text)).toEqual([]);
		const parsed = parseTestRunDocument("docs/tests/LIMS-401-OQ.md", res.text);
		expect(parsed).not.toBeNull();
		expect(parsed!.ticket).toBe("LIMS-401");
		expect(parsed!.phase).toBe("OQ");
		expect(parsed!.cases).toHaveLength(2);
	});

	test("assembleTestExecutionProtocol generates ADR-0008-compliant protocol and round-trips through parseTestRunDocument", () => {
		const protocol = assembleTestExecutionProtocol({
			ticketKey: "LIMS-401",
			ticketTitle: "Rush Turnaround Rule",
			phase: "OQ",
			environment: "QA",
			gitSha: "aaaa1111bbbb2222cccc3333",
			executedBy: "QA Analyst",
			executedDate: "2026-11-24",
			projectName: "LabCore",
			planTests: [{ name: "Skips weekend", given: "Friday login", expect: "Monday due date" }],
			checklistItems: ["- [ ] Audit trail captures due date override"],
			testScripts: ["tests/CalcDue.test.ssl"],
			changeControl: "CAB-2026-88",
		});

		expect(checkTables(protocol)).toEqual([]);
		expect(protocol).toContain("phase: OQ");
		expect(protocol).toContain("environment: QA");
		expect(protocol).toContain("git-sha: aaaa1111bbbb2222cccc3333");
		expect(protocol).toContain("tests/CalcDue.test.ssl");

		// Simulate QA completing execution in the generated doc
		const executed = protocol
			.replace("result: partial", "result: pass")
			.replace(/\| pending \|/g, "| pass |");
		const parsed = parseTestRunDocument("docs/tests/LIMS-401-OQ.md", executed)!;
		expect(parsed).toMatchObject({
			path: "docs/tests/LIMS-401-OQ.md",
			ticket: "LIMS-401",
			phase: "OQ",
			environment: "QA",
			gitSha: "aaaa1111bbbb2222cccc3333",
			executedBy: "QA Analyst",
			executedDate: "2026-11-24",
			result: "pass",
		});
		expect(parsed.cases).toHaveLength(3);
		expect(parsed.cases[0]!.caseId).toBe("TC-01");
		expect(parsed.cases[0]!.result).toBe("pass");
		expect(parsed.cases[2]!.caseId).toBe("TS-01");

		// Non-test-run doc returns null
		expect(parseTestRunDocument("docs/notes.md", "# Meeting Notes\n\nNothing here.\n")).toBeNull();
	});

	test("detects stale SHA and integrates Pass/Fail/Stale-SHA status into Readiness Gate, Ticket Packet, and RTM (ADR 0008)", () => {
		const docs: DocFile[] = [
			{
				group: "tickets",
				name: "LIMS-401.md",
				path: "/ws/docs/tickets/LIMS-401.md",
				exists: true,
				ticket: "LIMS-401",
				title: "Rush Turnaround Rule",
				status: "done",
				release: "v2.5",
				priority: "High",
				tasks: { done: 2, total: 2 },
				approvedBy: "QA Lead",
				approvedDate: "2026-11-24",
				changeControl: "CAB-2026-88",
			},
			{
				group: "plans",
				name: "CalcDue.plan.json",
				path: "/ws/design/CalcDue.plan.json",
				exists: true,
				heading: "Calc Due Flow",
				tickets: ["LIMS-401"],
				codeRefs: ["src/CalcDue.ssl"],
				testScripts: ["tests/CalcDue.test.ssl"],
				planTests: [{ name: "Skips weekend" }],
			},
		];

		const run: TestRunSummary = {
			path: "/ws/docs/tests/LIMS-401-OQ.md",
			ticket: "LIMS-401",
			phase: "OQ",
			environment: "QA",
			gitSha: "1111aaaa2222bbbb",
			executedBy: "QA Analyst",
			executedDate: "2026-11-24",
			result: "pass",
			cases: [{ caseId: "TC-01", result: "pass", evidence: "shot-1.png", notes: "Verified Monday due date" }],
		};

		// Fresh SHA check
		expect(isTestRunStale(run, "1111aaaa2222bbbbcccc")).toBe(false);
		expect(isTestRunStale(run, "9999ffff8888eeee")).toBe(true);

		const freshReady = evaluateTicketReadiness(docs, "LIMS-401", {
			testRuns: [run],
			currentGitSha: "1111aaaa2222bbbbcccc",
		})!;
		expect(freshReady.ready).toBe(true);
		expect(freshReady.checks.find((c) => c.label === "Validation runs")?.ok).toBe(true);

		const staleReady = evaluateTicketReadiness(docs, "LIMS-401", {
			testRuns: [run],
			currentGitSha: "9999ffff8888eeee",
		})!;
		expect(staleReady.ready).toBe(false);
		const staleCheck = staleReady.checks.find((c) => c.label === "Validation runs")!;
		expect(staleCheck.level).toBe("warn");
		expect(staleCheck.detail).toContain("stale SHA");

		// Ticket Packet Validation Evidence section (ADR 0008 compliant)
		const packet = assembleTicketPacketMarkdown({
			projectName: "LabCore",
			generatedOn: "2026-11-24",
			ticketKey: "LIMS-401",
			ticketTitle: "Rush Turnaround Rule",
			status: "done",
			ticketBody: "# LIMS-401\n\nDetails.",
			specs: [],
			plans: [],
			decisions: [],
			questions: [],
			registries: [],
			ticketFiles: [],
			readiness: staleReady,
			testRuns: [run],
			currentGitSha: "9999ffff8888eeee",
		});
		expect(packet).toContain("## Validation Evidence");
		expect(packet).toContain("OQ STALE");
		expect(packet).toContain("PASS (STALE)");
		expect(packet).toContain("shot-1.png");
		expect(checkTables(packet)).toEqual([]);

		// RTM integration via RtmInput object (stale SHA)
		const rtmRows = buildRtmRows({
			docs,
			headSha: "9999ffff8888eeee",
			testRuns: [run],
			currentGitSha: "9999ffff8888eeee",
		});
		expect(rtmRows[0]!.validationStatus).toBe("OQ STALE");
		expect(rtmRows[0]!.validationStale).toBe(true);

		const rtmMd = assembleRtmMarkdown(rtmRows, "LabCore");
		expect(rtmMd).toContain("| Ticket | Status | Validation | Title |");
		expect(rtmMd).toContain("OQ STALE");
		expect(rtmMd).toContain("[STALE SHA]");
		expect(checkTables(rtmMd)).toEqual([]);

		const rtmCsv = assembleRtmCsv(rtmRows);
		expect(rtmCsv).toContain("Validation Status,Validation Runs");
		expect(rtmCsv).toContain("OQ STALE");
	});
});

describe("Wave 3.3 — Ordered STARLIMS Deployment Runbook, FK Topological Sort, Checksum Drift & Release Bundle Parity", () => {
	test("orderSqlTablesTopologically orders parent tables before child tables deterministically and handles cycles gracefully", () => {
		const ordered = orderSqlTablesTopologically([
			{ name: "dbo.RESULTS", dependsOn: ["dbo.SAMPLES", "TEST_METHODS"] },
			{ name: "dbo.SAMPLES", dependsOn: ["CLIENTS", "EXTERNAL_MASTER"] },
			{ name: "dbo.CLIENTS" },
			{ name: "dbo.TEST_METHODS", dependsOn: ["dbo.TEST_METHODS"] }, // self-FK ignored
		]);
		expect(ordered.indexOf("dbo.CLIENTS")).toBeLessThan(ordered.indexOf("dbo.SAMPLES"));
		expect(ordered.indexOf("dbo.SAMPLES")).toBeLessThan(ordered.indexOf("dbo.RESULTS"));
		expect(ordered.indexOf("dbo.TEST_METHODS")).toBeLessThan(ordered.indexOf("dbo.RESULTS"));
		// Lexicographical Kahn priority queue: CLIENTS frees SAMPLES, then SAMPLES < TEST_METHODS, then RESULTS
		expect(ordered).toEqual(["dbo.CLIENTS", "dbo.SAMPLES", "dbo.TEST_METHODS", "dbo.RESULTS"]);

		// Cycle safety: never throws, drops no tables, deterministic order
		const cyclic = orderSqlTablesTopologically([
			{ name: "NODE_B", dependsOn: ["NODE_A"] },
			{ name: "NODE_A", dependsOn: ["NODE_B"] },
			{ name: "ROOT_T" },
		]);
		expect(cyclic).toHaveLength(3);
		expect(cyclic[0]).toBe("ROOT_T");
		expect(new Set(cyclic)).toEqual(new Set(["ROOT_T", "NODE_A", "NODE_B"]));
	});

	test("assembleDeploymentRunbook enforces STARLIMS promotion order and surfaces verified SHA-256 checksum drift", () => {
		const drifts = detectChecksumDrift(
			[
				{ path: "src/CalcDue.ssl", sha256: "aaaa111122223333", status: "verified" },
				{ path: "src/DraftOnly.ssl", sha256: "bbbb444455556666", status: "draft" },
				{ path: "src/Unchanged.ssl", sha256: "cccc777788889999", status: "verified" },
			],
			[
				{ path: "src/CalcDue.ssl", sha256: "deadbeef00001111" },
				{ path: "src/DraftOnly.ssl", sha256: "9999888877776666" },
				{ path: "src/Unchanged.ssl", sha256: "cccc7777888899990000" },
			],
		);
		expect(drifts).toHaveLength(1);
		expect(drifts[0]!.path).toBe("src/CalcDue.ssl");

		const runbook = assembleDeploymentRunbook({
			sqlTables: [
				{ name: "ORDERS", dependsOn: ["CLIENTS"], path: "schema/orders.sql" },
				{ name: "CLIENTS", path: "schema/clients.sql" },
			],
			sqlArtifacts: [
				{ path: "schema/v_orders.sql", kind: "View", source: "V_ACTIVE_ORDERS" },
				{ path: "schema/sp_close.sql", kind: "Procedure", source: "SP_CLOSE_ORDER" },
			],
			scripts: [
				{ ref: "forms/Intake.xfd", kind: "XFD Form", ticket: "LIMS-1" },
				{ ref: "ds/GetOrders.ds", kind: "Data Source", ticket: "LIMS-1" },
				{ ref: "src/CalcDue.ssl", kind: "SSL Script", ticket: "LIMS-1" },
				{ ref: "src/Helper.srvscr", kind: "SSL Script", ticket: "LIMS-1" },
			],
			testScripts: [{ ref: "tests/CalcDue.test.ssl", ticket: "LIMS-1" }],
			planTests: [{ name: "Skips weekend", expect: "Monday" }],
			registries: [
				{ title: "Scheduled jobs", headers: ["job", "runs", "calls", "status"], rows: [["NIGHTLY_DUE", "02:00", "CalcDue", "verified"]] },
				{ title: "Application settings", headers: ["name", "value", "where", "status"], rows: [["DUE_DAYS", "5", "System", "verified"]] },
				{ title: "Roles and access", headers: ["role", "may do", "status"], rows: [["LAB_SUPERVISOR", "Approve rush", "verified"]] },
				{ title: "Reports and labels", headers: ["report", "kind", "used by", "status"], rows: [["COA_REPORT", "Crystal", "Release", "verified"]] },
				{ title: "Interfaces", headers: ["interface", "direction", "how", "status"], rows: [["HL7_OUT", "outbound", "TCP", "verified"]] },
				{
					title: "File manifest",
					headers: ["path", "kind", "bytes", "lines", "sha256", "status", "note"],
					rows: [["src/CalcDue.ssl", "ssl", "120", "10", "aaaa111122223333", "verified", ""]],
				},
			],
			checksums: [{ path: "src/CalcDue.ssl", sha256: "deadbeef00001111" }],
		});

		expect(checkTables(runbook)).toEqual([]);
		expect(runbook).toContain("> [!warning] Checksum Drift Detected");
		expect(runbook).toContain("`aaaa11112222`");
		expect(runbook).toContain("`deadbeef0000`");

		// Verify strict STARLIMS promotion ordering across sections & inside sections
		const idxPause = runbook.indexOf("Pause scheduled job `NIGHTLY_DUE`");
		const idxClients = runbook.indexOf("Apply table DDL `CLIENTS`");
		const idxOrders = runbook.indexOf("Apply table DDL `ORDERS`");
		const idxView = runbook.indexOf("Apply View `V_ACTIVE_ORDERS`");
		const idxProc = runbook.indexOf("Apply Procedure `SP_CLOSE_ORDER`");
		const idxSetting = runbook.indexOf("Apply setting `DUE_DAYS`");
		const idxRole = runbook.indexOf("Update role `LAB_SUPERVISOR`");
		const idxSsl = runbook.indexOf("Import SSL Script `src/CalcDue.ssl`");
		const idxSrvscr = runbook.indexOf("Import SSL Script `src/Helper.srvscr`");
		const idxDs = runbook.indexOf("Import Data Source `ds/GetOrders.ds`");
		const idxXfd = runbook.indexOf("Import XFD Form `forms/Intake.xfd`");
		const idxReport = runbook.indexOf("Deploy report/label `COA_REPORT`");
		const idxResume = runbook.indexOf("Resume scheduled job `NIGHTLY_DUE`");
		const idxIface = runbook.indexOf("Enable & verify interface `HL7_OUT`");
		const idxTest = runbook.indexOf("Execute test script `tests/CalcDue.test.ssl`");

		expect(idxPause).toBeGreaterThan(-1);
		expect(idxPause).toBeLessThan(idxClients);
		expect(idxClients).toBeLessThan(idxOrders);
		expect(idxOrders).toBeLessThan(idxView);
		expect(idxView).toBeLessThan(idxProc);
		expect(idxProc).toBeLessThan(idxSetting);
		expect(idxSetting).toBeLessThan(idxRole);
		expect(idxRole).toBeLessThan(idxSsl);
		expect(idxSsl).toBeLessThan(idxDs);
		expect(idxSrvscr).toBeLessThan(idxDs);
		expect(idxDs).toBeLessThan(idxXfd);
		expect(idxXfd).toBeLessThan(idxReport);
		expect(idxReport).toBeLessThan(idxResume);
		expect(idxResume).toBeLessThan(idxIface);
		expect(idxIface).toBeLessThan(idxTest);
	});

	test("Deployment Manifest integrates runbook and Release Bundle has full parity (checksums, planTests, runbook) + CAB CSV export", () => {
		const manifest = assembleDeploymentManifestMarkdown({
			projectName: "LabCore",
			generatedOn: "2026-11-24",
			ticketKey: "LIMS-500",
			ticketTitle: "Order Pipeline",
			scopeTickets: [{ key: "LIMS-500", title: "Order Pipeline", status: "done" }],
			scripts: [{ ref: "src/Pipeline.ssl", kind: "SSL Script", ticket: "LIMS-500" }],
			sqlArtifacts: [],
			registries: [],
			runbook: { sqlTables: [{ name: "ORDERS", dependsOn: ["CLIENTS"] }, { name: "CLIENTS" }] },
		});
		expect(manifest).toContain("## Deployment Execution Runbook");
		expect(manifest.indexOf("`CLIENTS`")).toBeLessThan(manifest.indexOf("`ORDERS`"));
		expect(checkTables(manifest)).toEqual([]);

		const bundleInput = {
			projectName: "LabCore",
			releaseName: "v3.0",
			generatedOn: "2026-11-24",
			headSha: "1234567890abcdef",
			targetEnvironment: "QA -> PROD",
			tickets: [
				{ key: "LIMS-500", title: "Order Pipeline", status: "done", priority: "High" },
				{ key: "LIMS-501", title: "Label Print", status: "done", priority: "Medium" },
			],
			scripts: [
				{ ref: "src/Pipeline.ssl", kind: "SSL Script", ticket: "LIMS-500" },
				{ ref: "src/Pipeline.ssl", kind: "SSL Script", ticket: "LIMS-501" },
				{ ref: "forms/Orders.xfd", kind: "XFD Form", ticket: "LIMS-500" },
			],
			testScripts: [{ ref: "tests/Pipeline.test.ssl", ticket: "LIMS-500" }],
			planTests: [
				{ name: "Routes rush order", plan: "Pipeline", expect: "Flagged RUSH", ticket: "LIMS-500" },
				{ name: "Routes rush order", plan: "Pipeline", expect: "Flagged RUSH", ticket: "LIMS-500" },
			],
			sqlArtifacts: [{ path: "schema/orders.sql", kind: "Table", source: "ORDERS", ticket: "LIMS-500" }],
			registries: [{ title: "Application settings", headers: ["name", "status", "ticket"], rows: [["RUSH_MODE", "verified", "LIMS-500"]] }],
			checksums: [
				{ path: "src/Pipeline.ssl", sha256: "abcdef0123456789abcdef0123456789" },
				{ path: "src/Pipeline.ssl", sha256: "abcdef0123456789abcdef0123456789" },
			],
			runbook: true,
		};

		const bundleMd = assembleReleaseBundleMarkdown(bundleInput);
		expect(bundleMd).toContain("## Artifact Checksums");
		expect(bundleMd).toContain("### Business Test Cases");
		expect(bundleMd).toContain("## Deployment Execution Runbook");
		expect(bundleMd.match(/Routes rush order/g)?.length).toBe(2); // once in Business Test Cases, once in Runbook step 6
		expect(bundleMd.match(/`abcdef0123456789`/g)?.length).toBe(1);
		expect(checkTables(bundleMd)).toEqual([]);

		const bundleCsv = assembleReleaseBundleCsv(bundleInput);
		const parsedCsv = parseCsv(bundleCsv);
		expect(parsedCsv.header.map((c) => c.text)).toEqual(["Release", "Category", "Artifact", "Tickets", "Status", "SHA-256", "Notes"]);
		const csvRows = parsedCsv.rows.map((r) => r.map((c) => c.text));
		const pipelineRow = csvRows.find((r) => r[2] === "src/Pipeline.ssl")!;
		expect(pipelineRow).toBeDefined();
		expect(pipelineRow[0]).toBe("v3.0");
		expect(pipelineRow[3]).toBe("LIMS-500; LIMS-501");
		expect(pipelineRow[5]).toBe("abcdef0123456789abcdef0123456789");
		expect(csvRows.some((r) => r[1] === "Business Test" && r[2] === "Routes rush order")).toBe(true);
		expect(csvRows.some((r) => r[1] === "Registry: Application settings" && r[2] === "RUSH_MODE")).toBe(true);
	});
});
