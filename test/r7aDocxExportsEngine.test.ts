import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createBackend, type Host } from "../src/bun/backend";
import { markdownToDocx, parseDocxToMarkdown } from "../src/bun/docx";
import { docAudit, linksTo, listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { adfToMarkdown } from "../src/shared/adf";
import { CATALOG_START, withCatalog } from "../src/shared/catalog";
import { checkCodeCitations, findCodeCitations, reanchorCitation, refreshCitationExcerpt } from "../src/shared/codeCitations";
import { parseCsv } from "../src/shared/csv";
import { docChecks } from "../src/shared/docChecks";
import {
	assembleDeploymentRunbook,
	assembleReleaseNotesMarkdown,
	assembleTestExecutionProtocol,
	buildPrintableHtml,
	buildRtmRows,
	evaluateTicketReadiness,
	markdownToJira,
	parseTestRunDocument,
	transformMarkdownFootnotes,
	type TestRunSummary,
} from "../src/shared/docExport";
import { cellText, checkTables } from "../src/shared/docTables";
import { frontMatter } from "../src/shared/frontMatter";
import { ticketTemplate } from "../src/shared/projectDocs";
import type { DocFile } from "../src/shared/protocol";
import { extractTags } from "../src/shared/tags";
import { tasks, toggleTask } from "../src/shared/tasks";
import { ticketsFromJson, ticketsFromTable } from "../src/shared/ticketImport";
import { wikiToMarkdown } from "../src/shared/wikiMarkup";

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

describe("R7A.1 — DOCX security, crash resistance, XML 1.0 validity & fidelity", () => {
	test("rejects ZIP bomb >32 MB via maxOutputLength and blocks overlapping/duplicate localOffset entries", () => {
		// 1. Single 36 MB bomb compressed to ~36 KB
		const bombRaw = new Uint8Array(36 * 1024 * 1024);
		const bombZip = packZip([{ name: "word/document.xml", data: bombRaw }]);
		expect(bombZip.length).toBeLessThan(100 * 1024);
		// The document's text is not read, so there is no document: said, not read as an empty one.
		expect(() => parseDocxToMarkdown(bombZip)).toThrow(/not a Word document that can be read/);

		// 2. Duplicate/overlapping localOffset central directory entries: only the first entry at offset 0 is extracted
		const enc = new TextEncoder();
		const validDoc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Safe</w:t></w:r></w:p></w:body></w:document>`;
		const rawDoc = enc.encode(validDoc);
		const compDoc = new Uint8Array(deflateRawSync(rawDoc));
		const name1 = enc.encode("word/first.bin");
		const name2 = enc.encode("word/document.xml");

		const local = new Uint8Array(30 + name1.length + compDoc.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(8, 8, true);
		lv.setUint32(18, compDoc.length, true);
		lv.setUint32(22, rawDoc.length, true);
		lv.setUint16(26, name1.length, true);
		local.set(name1, 30);
		local.set(compDoc, 30 + name1.length);

		const makeCd = (nameBytes: Uint8Array, localOff: number) => {
			const cd = new Uint8Array(46 + nameBytes.length);
			const cv = new DataView(cd.buffer);
			cv.setUint32(0, 0x02014b50, true);
			cv.setUint16(10, 8, true);
			cv.setUint32(20, compDoc.length, true);
			cv.setUint32(24, rawDoc.length, true);
			cv.setUint16(28, nameBytes.length, true);
			cv.setUint32(42, localOff, true);
			cd.set(nameBytes, 46);
			return cd;
		};
		const cd1 = makeCd(name1, 0);
		const cd2 = makeCd(name2, 0); // duplicate localOffset!
		const eocd = new Uint8Array(22);
		const ev = new DataView(eocd.buffer);
		ev.setUint32(0, 0x06054b50, true);
		ev.setUint16(8, 2, true);
		ev.setUint16(10, 2, true);
		ev.setUint32(12, cd1.length + cd2.length, true);
		ev.setUint32(16, local.length, true);

		const overlapZip = new Uint8Array(local.length + cd1.length + cd2.length + eocd.length);
		overlapZip.set(local, 0);
		overlapZip.set(cd1, local.length);
		overlapZip.set(cd2, local.length + cd1.length);
		overlapZip.set(eocd, local.length + cd1.length + cd2.length);

		// word/document.xml reused localOffset 0 -> rejected!
		expect(() => parseDocxToMarkdown(overlapZip)).toThrow(/not a Word document that can be read/);

		// 3. Truncated fallback scan (no EOCD, nameLen exceeds buffer) doesn't crash
		const trunc = new Uint8Array(34);
		const tv = new DataView(trunc.buffer);
		tv.setUint32(0, 0x04034b50, true);
		tv.setUint16(26, 500, true); // nameLen > remaining bytes
		expect(() => parseDocxToMarkdown(trunc, "Cut.docx")).toThrow(/^Cut\.docx is not a Word document that can be read/);

		// 4. Cumulative >64 MB across 3 x 25 MB entries caps extraction safely without OOM
		const chunk25 = new Uint8Array(25 * 1024 * 1024);
		const multiBomb = packZip([
			{ name: "word/media/big1.bin", data: chunk25 },
			{ name: "word/media/big2.bin", data: chunk25 },
			{ name: "word/media/big3.bin", data: chunk25 },
			{ name: "word/document.xml", data: validDoc },
		]);
		// 50 MB extracted from big1+big2, big3 rejected (would exceed 64 MB), document.xml fits in remaining 14 MB!
		expect(parseDocxToMarkdown(multiBomb).markdown).toBe("Safe");
	});

	test("strips illegal XML 1.0 control chars and lone UTF-16 surrogates, keeps valid emoji, emits <w:tblGrid>, and avoids duplicate <w:ind>", () => {
		const md = [
			"# Clean \u0000\u0007\u000B\u000C\u001F\uFFFE\uFFFF\uD800X\uDC00 Title 😀",
			"",
			"<!-- inline comment --> Keep this trailing prose!",
			"",
			"Following paragraph survives.",
			"",
			"> - Quoted bullet",
			"> 1. Quoted ordered",
			"> - [x] Quoted task",
			"",
			"| Col A | Col B |",
			"| --- | --- |",
			"| Val 1 | Val 2 |",
		].join("\n");

		const docx = markdownToDocx({
			title: "Control\u0000Test",
			markdown: md,
			headerFooter: false,
		});
		const entries = unpackZip(docx);
		const docXml = new TextDecoder().decode(entries.get("word/document.xml")!);
		const coreXml = new TextDecoder().decode(entries.get("docProps/core.xml")!);

		// Illegal XML 1.0 chars and lone surrogates stripped; valid emoji preserved
		expect(docXml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/);
		expect(docXml).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		expect(docXml).toContain("Clean X Title 😀");
		expect(coreXml).toContain("<dc:title>ControlTest</dc:title>");

		// Single-line HTML comment with trailing prose keeps trailing prose AND rest of doc
		expect(docXml).toContain("Keep this trailing prose!");
		expect(docXml).toContain("Following paragraph survives.");

		// <w:tblGrid> emitted on tables
		expect(docXml).toContain("<w:tblGrid><w:gridCol w:w=");

		// No paragraph contains duplicate <w:ind> elements (even inside blockquoted lists)
		for (const pPrMatch of docXml.matchAll(/<w:pPr>([\s\S]*?)<\/w:pPr>/g)) {
			const indCount = pPrMatch[1]!.match(/<w:ind\b/g)?.length ?? 0;
			expect(indCount).toBeLessThanOrEqual(1);
		}
	});

	test("reader guards xmlUnesc RangeError, clamps w:ilvl, handles self-closing <w:t/>, strips unsafe links, keeps ordered list counters across nested bullets, disambiguates colliding images, and widens code fences", () => {
		const pngA = makePngBytes(16, 16);
		const pngB = makePngBytes(32, 32);

		const stylesXml = `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="WildIndent">
    <w:name w:val="WildIndent"/>
    <w:pPr><w:numPr><w:ilvl w:val="999999999"/><w:numId w:val="2"/></w:numPr></w:pPr>
  </w:style>
</w:styles>`;

		const numberingXml = `<?xml version="1.0"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="2">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`;

		const docRelsXml = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rJs" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
  <Relationship Id="rVb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="vbscript:msgbox(1)" TargetMode="External"/>
  <Relationship Id="rData" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="data:text/html,&lt;script&gt;" TargetMode="External"/>
  <Relationship Id="rSafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/doc (1)&lt;x&gt;" TargetMode="External"/>
  <Relationship Id="rImgA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a/pic.png"/>
  <Relationship Id="rImgB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/b/pic.png"/>
</Relationships>`;

		const docXml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<w:body>
  <w:p><w:r><w:t/><w:br/><w:t>AfterEmpty &#x110000; &#xD800; &#65;</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="999999999"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Deep clamped</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="WildIndent"/></w:pPr><w:r><w:t>Style clamped</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First step</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested bullet</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second step</w:t></w:r></w:p>
  <w:p>
    <w:hyperlink r:id="rJs"><w:r><w:t>BadJS</w:t></w:r></w:hyperlink>
    <w:r><w:t xml:space="preserve"> </w:t></w:r>
    <w:hyperlink r:id="rVb"><w:r><w:t>BadVB</w:t></w:r></w:hyperlink>
    <w:r><w:t xml:space="preserve"> </w:t></w:r>
    <w:hyperlink r:id="rData"><w:r><w:t>BadData</w:t></w:r></w:hyperlink>
    <w:r><w:t xml:space="preserve"> </w:t></w:r>
    <w:hyperlink r:id="rSafe"><w:r><w:t>SafeLink</w:t></w:r></w:hyperlink>
  </w:p>
  <w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr><w:t>a\`\`b</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr><w:t>\`edge\`</w:t></w:r></w:p>
  <w:p><w:r><a:blip r:embed="rImgA"/></w:r><w:r><a:blip r:embed="rImgB"/></w:r></w:p>
</w:body>
</w:document>`;

		const zip = packZip([
			{ name: "word/document.xml", data: docXml },
			{ name: "word/styles.xml", data: stylesXml },
			{ name: "word/numbering.xml", data: numberingXml },
			{ name: "word/_rels/document.xml.rels", data: docRelsXml },
			{ name: "word/media/a/pic.png", data: pngA },
			{ name: "word/media/b/pic.png", data: pngB },
		]);

		const parsed = parseDocxToMarkdown(zip);
		// Self-closing <w:t/> didn't swallow <w:br/> or next <w:t>, and invalid entities didn't crash
		// The `#` after `&` carries a backslash: written out, `&#x41;` would be read by Markdown as a letter (pass 3, low 19).
		expect(parsed.markdown).toContain("AfterEmpty &\\#x110000; &\\#xD800; A");
		expect(parsed.markdown).not.toContain("<w:br/>");

		// w:ilvl clamped to 8 (16 spaces)
		expect(parsed.markdown).toContain(`${"  ".repeat(8)}- Deep clamped`);
		expect(parsed.markdown).toContain(`${"  ".repeat(8)}- Style clamped`);

		// Outer ordered counter intact across nested bullet sub-list!
		expect(parsed.markdown).toContain("1. First step\n  - Nested bullet\n2. Second step");

		// Unsafe link protocols rejected; safe link percent-encoded
		expect(parsed.markdown).not.toContain("javascript:");
		expect(parsed.markdown).not.toContain("vbscript:");
		expect(parsed.markdown).not.toContain("data:text/html");
		expect(parsed.markdown).toContain("BadJS BadVB BadData [SafeLink](https://example.test/doc%20%281%29%3Cx%3E)");

		// Dynamic backtick fences for inline code containing backticks
		expect(parsed.markdown).toContain("```a``b```");
		expect(parsed.markdown).toContain("`` `edge` ``");

		// Colliding image basenames disambiguated with distinct payloads
		expect(parsed.images).toHaveLength(2);
		expect(parsed.images.map((i) => i.name)).toEqual(["pic.png", "pic-2.png"]);
		expect(parsed.images[0]!.bytes).toEqual(pngA);
		expect(parsed.images[1]!.bytes).toEqual(pngB);
		expect(parsed.markdown).toContain("{{DOCX_IMG:pic.png}}{{DOCX_IMG:pic-2.png}}");
	});
});

describe("R7A.2 — project.ts security containment, ENOTDIR, inode cache stamp, P2-23 & backend conflict sourcePath", () => {
	test("blocks schema drift path traversal and symlink escapes, prevents listDocs existence oracles, handles ENOTDIR, and enforces inode cache stamps", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-r7a-ws-"));
		const outside = mkdtempSync(join(tmpdir(), "ssl-studio-r7a-out-"));
		try {
			mkdirSync(join(root, ".ssl-studio"), { recursive: true });
			mkdirSync(join(root, "docs", "tickets"), { recursive: true });
			mkdirSync(join(root, "docs", "specs"), { recursive: true });
			mkdirSync(join(root, "schema", "database"), { recursive: true });
			mkdirSync(join(root, "design"), { recursive: true });
			mkdirSync(join(root, "src"), { recursive: true });

			writeFileSync(join(root, ".ssl-studio", "project.toml"), 'name = "SecDemo"\n');
			writeFileSync(join(outside, "secret.sql"), "CREATE TABLE SECRET_TBL (ID INT, LEAKED_COL VARCHAR(20));\n");
			writeFileSync(join(outside, "exists.md"), "# Secret outside file\n");
			writeFileSync(join(outside, "outside.png"), makePngBytes(4, 4));
			symlinkSync(join(outside, "secret.sql"), join(root, "schema", "database", "link-secret.sql"));

			// Schema docs attempting traversal AND symlink escape
			const relEscape = `../../../${outside.split("/").pop()}/secret.sql`;
			writeFileSync(
				join(root, "schema", "database", "ESCAPE.md"),
				`---\nsource: ${relEscape}\n---\n# SECRET_TBL\n\n| Column | Type | Null | Notes |\n| --- | --- | --- | --- |\n| \`ID\` | int | no | id |\n`,
			);
			writeFileSync(
				join(root, "schema", "database", "SYMLINK.md"),
				`---\nsource: schema/database/link-secret.sql\n---\n# SECRET_TBL\n\n| Column | Type | Null | Notes |\n| --- | --- | --- | --- |\n| \`ID\` | int | no | id |\n`,
			);

			// Real spec inside workspace for #anchor stripping test + double-backtick anchor test
			writeFileSync(
				join(root, "docs", "specs", "RealSpec.md"),
				"---\ntitle: Real Spec\n---\n# Real Spec\n\n## Rules\n\nExamples: ``[not a link](#ghost)`` and ``[[RealSpec#Ghost]]``.\n",
			);

			// Ticket with: valid #anchor spec ref, escaping existing file, escaping missing file, escaping image/file embeds
			const outName = outside.split("/").pop()!;
			writeFileSync(
				join(root, "docs", "tickets", "SEC-1.md"),
				[
					"---",
					"ticket: SEC-1",
					"title: Security test",
					`specs: [docs/specs/RealSpec.md#rules, ../../../${outName}/exists.md, ../../../${outName}/does-not-exist.md]`,
					"---",
					"# SEC-1",
					"",
					`![[../../../${outName}/outside.png]]`,
					`![[../../../${outName}/missing.png]]`,
					`![[../../../${outName}/secret.sql]]`,
					`![[../../../${outName}/missing.sql]]`,
				].join("\n"),
			);

			// Plain doc in docs/ with source + missingSource preserved
			writeFileSync(
				join(root, "docs", "Runbook.md"),
				"---\ntitle: Ops Runbook\nsource: schema/database/missing-ddl.sql\n---\n# Ops Runbook\n",
			);

			// Plan JSON with JSON-escaped forward slash (`\/`) and unmatched synthetic target
			writeFileSync(join(root, "src", "Calc.ssl"), ":RETURN 1;\n");
			writeFileSync(
				join(root, "design", "Esc.plan.json"),
				'{\n  "version": 1,\n  "targets": ["src\\/Calc.ssl"]\n}\n',
			);

			const ws = new WorkspaceFiles(root);
			const proj = await readProject(root);
			const docs = await listDocs(ws, proj);
			const audit = await docAudit(ws, proj);

			// P0-2: Zero schema drift leaked from outside workspace (neither via `..` nor symlink)
			expect(audit.schemaDrift).toEqual([]);
			expect(audit.issues.filter((i) => i.kind === "schema-drift")).toEqual([]);

			// P0-2 + P2-23: Ticket specs with #anchor passes; both existing & missing outside paths are treated identically (missing)
			const ticket = docs.find((d) => d.ticket === "SEC-1")!;
			expect(ticket.missing).toEqual([`../../../${outName}/exists.md`, `../../../${outName}/does-not-exist.md`]);
			// Both existing & missing outside embeds reported broken identically (no existence oracle)
			const brokenHrefs = (ticket.broken ?? []).map((b) => b.href);
			expect(brokenHrefs).toContain(`![[../../../${outName}/outside.png]]`);
			expect(brokenHrefs).toContain(`![[../../../${outName}/missing.png]]`);
			expect(brokenHrefs).toContain(`![[../../../${outName}/secret.sql]]`);
			expect(brokenHrefs).toContain(`![[../../../${outName}/missing.sql]]`);

			// P2-23: group "docs" preserves source and missingSource
			const runbook = docs.find((d) => d.group === "docs" && d.name === "Runbook.md")!;
			expect(runbook.source).toBe("schema/database/missing-ddl.sql");
			expect(runbook.missingSource).toBe("schema/database/missing-ddl.sql");

			// P2-23: double-backtick inline code does not trigger false anchor issues
			expect(audit.issues.filter((i) => i.kind === "anchor")).toEqual([]);

			// P2-23: linksTo handles JSON-escaped `\/` cleanly with exact line/column
			const planLinks = await linksTo(ws, join(root, "src", "Calc.ssl"));
			expect(planLinks).toHaveLength(1);
			expect(planLinks[0]).toMatchObject({ kind: "plan", line: 3, href: "src\\/Calc.ssl" });

			// P1-16: same size & forced identical mtime via atomic rename (different inode!) busts cache
			const cacheFile = join(root, "docs", "specs", "CacheTest.md");
			const fixedTime = new Date(1700000000000);
			writeFileSync(cacheFile, "---\ntitle: Alpha\n---\n# Alpha\n");
			utimesSync(cacheFile, fixedTime, fixedTime);
			const firstDocs = await listDocs(ws, proj);
			expect(firstDocs.find((d) => d.name === "CacheTest.md")?.title).toBe("Alpha");

			const tmpReplace = join(root, "docs", "specs", ".CacheTest.tmp");
			writeFileSync(tmpReplace, "---\ntitle: Bravo\n---\n# Bravo\n"); // exact same byte length (28 bytes)
			utimesSync(tmpReplace, fixedTime, fixedTime);
			renameSync(tmpReplace, cacheFile); // new inode!
			const secondDocs = await listDocs(ws, proj);
			expect(secondDocs.find((d) => d.name === "CacheTest.md")?.title).toBe("Bravo");

			// P1-12: ENOTDIR when project.docs points to a file instead of a directory
			writeFileSync(join(root, "not-a-dir.txt"), "hello\n");
			const fileDocsProj = { ...proj, docs: "not-a-dir.txt" };
			const noCrash = await listDocs(ws, fileDocsProj);
			expect(Array.isArray(noCrash)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("importDocFile conflict response includes sourcePath", async () => {
		const wsDir = mkdtempSync(join(tmpdir(), "ssl-studio-r7a-imp-ws-"));
		const srcDir = mkdtempSync(join(tmpdir(), "ssl-studio-r7a-imp-src-"));
		const host: Host = { emit: () => {}, pick: async () => null, trash: async () => {}, app: "test", kind: "app", quit: () => {} };
		const backend = createBackend(host, wsDir);
		await backend.ready;
		try {
			const destDir = join(wsDir, "docs");
			mkdirSync(destDir, { recursive: true });
			const src = join(srcDir, "Spec.md");
			writeFileSync(src, "# Spec\n");
			writeFileSync(join(destDir, "Spec.md"), "# Existing\n");

			const res = (await backend.api.importDocFile({ sourcePath: src, destDir, onConflict: "prompt" }))!;
			expect(res.conflict).toBe(true);
			expect(res.existingPath).toBe(join(destDir, "Spec.md"));
			expect(res.sourcePath).toBe(src);
		} finally {
			backend.dispose();
			rmSync(wsDir, { recursive: true, force: true });
			rmSync(srcDir, { recursive: true, force: true });
		}
	});
});

describe("R7A.3 — docExport repairs (HTML comments, GxP test aggregation, CSS/YAML injection, runbook DDL, Jira, footnotes, release notes)", () => {
	test("P0-5 & P1-15: markdownToJira preserves trailing prose after comments, keeps blockquote ---, handles double-backtick table pipes, balanced link parens, formatted labels, code braces, and panel title escapes", () => {
		const md = [
			"<!-- lead note --> Keep this prose!",
			"",
			"Next paragraph intact.",
			"",
			"> ---",
			"> key: keep inside quote",
			"> ---",
			"",
			"> [!warning] Rollback | Step }",
			"> ---",
			"> item: still here",
			"> ---",
			"",
			"| Expr | Notes |",
			"| --- | --- |",
			"| ``a | b`` | See [**Bold** *Spec*](https://example.test/Page_(v2)) and `{k: v}` |",
		].join("\n");

		const jira = markdownToJira(md);
		expect(jira).toContain("Keep this prose!");
		expect(jira).toContain("Next paragraph intact.");
		// Blockquote and callout did NOT strip `--- ... ---` as YAML frontmatter
		expect(jira).toContain("key: keep inside quote");
		expect(jira).toContain("item: still here");
		// Callout title escaped `|` and `}`
		expect(jira).toContain("{panel:title=Rollback \\| Step \\}}");
		// Double-backtick pipe did NOT split table cell; balanced parens & formatted label preserved; braces escaped in {{...}}
		expect(jira).toContain("|{{a \\| b}}|See [*Bold* _Spec_|https://example.test/Page_(v2)] and {{\\{k: v\\}}}|");
	});

	test("P1-6: summarizeTicketTestRuns groups by (phase, environment), prefers HEAD SHA, and requires ALL phases to be fresh PASS", () => {
		const docs: DocFile[] = [
			{
				group: "tickets",
				name: "GXP-1.md",
				path: "/ws/docs/tickets/GXP-1.md",
				exists: true,
				ticket: "GXP-1",
				title: "Validated Calc",
				status: "done",
			},
		];
		const mkRun = (overrides: Partial<TestRunSummary>): TestRunSummary => ({
			path: "/ws/docs/test-runs/run.md",
			ticket: "GXP-1",
			phase: "OQ",
			environment: "QA",
			gitSha: "aaaa1111bbbb2222",
			executedBy: "QA",
			executedDate: "2026-11-24",
			result: "pass",
			cases: [],
			...overrides,
		});

		// 1. Old fail superseded by newer pass on HEAD SHA -> PASS
		const superseded = evaluateTicketReadiness(docs, "GXP-1", {
			currentGitSha: "aaaa1111bbbb2222",
			testRuns: [
				mkRun({ phase: "OQ", executedDate: "2026-11-20", gitSha: "0000old", result: "fail", path: "/old.md" }),
				mkRun({ phase: "OQ", executedDate: "2026-11-24", gitSha: "aaaa1111bbbb2222", result: "pass", path: "/new.md" }),
			],
		})!;
		expect(superseded.ready).toBe(true);
		expect(superseded.checks.find((c) => c.label === "Validation runs")?.ok).toBe(true);

		// 2. IQ fresh PASS + OQ stale PASS -> NOT ready (STALE!)
		const mixedStale = evaluateTicketReadiness(docs, "GXP-1", {
			currentGitSha: "aaaa1111bbbb2222",
			testRuns: [
				mkRun({ phase: "IQ", gitSha: "aaaa1111bbbb2222", result: "pass" }),
				mkRun({ phase: "OQ", gitSha: "deadbeef00001111", result: "pass" }),
			],
		})!;
		expect(mixedStale.ready).toBe(false);
		expect(mixedStale.checks.find((c) => c.label === "Validation runs")?.level).toBe("warn");
		const rtmStale = buildRtmRows({ docs, currentGitSha: "aaaa1111bbbb2222", testRuns: [mkRun({ phase: "IQ", result: "pass" }), mkRun({ phase: "OQ", gitSha: "deadbeef", result: "pass" })] });
		expect(rtmStale[0]!.validationStatus).toBe("OQ STALE");
		expect(rtmStale[0]!.validationStale).toBe(true);

		// 3. IQ fresh PASS + OQ fresh PARTIAL -> NOT ready (PARTIAL!)
		const mixedPartial = evaluateTicketReadiness(docs, "GXP-1", {
			currentGitSha: "aaaa1111bbbb2222",
			testRuns: [
				mkRun({ phase: "IQ", result: "pass" }),
				mkRun({ phase: "OQ", result: "partial" }),
			],
		})!;
		expect(mixedPartial.ready).toBe(false);
		const rtmPartial = buildRtmRows({ docs, currentGitSha: "aaaa1111bbbb2222", testRuns: [mkRun({ phase: "IQ", result: "pass" }), mkRun({ phase: "OQ", result: "partial" })] });
		expect(rtmPartial[0]!.validationStatus).toBe("OQ PARTIAL");

		// 4. IQ fresh PASS + OQ fresh PASS -> ALL fresh PASS -> READY!
		const allPass = evaluateTicketReadiness(docs, "GXP-1", {
			currentGitSha: "aaaa1111bbbb2222",
			testRuns: [
				mkRun({ phase: "IQ", result: "pass" }),
				mkRun({ phase: "OQ", result: "pass" }),
			],
		})!;
		expect(allPass.ready).toBe(true);
		const rtmPass = buildRtmRows({ docs, currentGitSha: "aaaa1111bbbb2222", testRuns: [mkRun({ phase: "IQ", result: "pass" }), mkRun({ phase: "OQ", result: "pass" })] });
		expect(rtmPass[0]!.validationStatus).toBe("IQ/OQ PASS");

		// 5. Same (phase, env): current HEAD SHA preferred over stale SHA even with older date
		const headPreferred = evaluateTicketReadiness(docs, "GXP-1", {
			currentGitSha: "aaaa1111bbbb2222",
			testRuns: [
				mkRun({ phase: "OQ", executedDate: "2026-11-24", gitSha: "deadbeef", result: "fail" }),
				mkRun({ phase: "OQ", executedDate: "2026-11-23", gitSha: "aaaa1111bbbb2222", result: "pass" }),
			],
		})!;
		expect(headPreferred.ready).toBe(true);
	});

	test("P1-8 & P1-11: escapeCssString blocks \\r/\\f/NUL injection and assembleTestExecutionProtocol quotes YAML scalars", () => {
		const html = buildPrintableHtml("Title\r\f\u0000} body{display:none}", "<p>ok</p>", undefined, undefined, {
			status: "draft\r\f\u0000",
		});
		const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
		expect(styleBlock).not.toContain("\u0000");
		expect(styleBlock).not.toContain("\f");
		expect(styleBlock).not.toContain("\r");
		expect(styleBlock).toContain('content: "Title } body{display:none}";');
		expect(styleBlock).toContain('content: "draft ";');

		const protocol = assembleTestExecutionProtocol({
			ticketKey: "LIMS-7\nresult: pass",
			phase: "OQ",
			environment: "QA: Lab #2\nresult: pass",
			executedBy: "Tester: A\nstatus: approved",
			executedDate: "2026-11-24\nfoo: bar",
			changeControl: "CR-1: #9\napproved: true",
		});
		const parsed = parseTestRunDocument("docs/test-runs/LIMS-7.md", protocol)!;
		// Injected `result: pass` did NOT override real `result: partial`!
		expect(parsed.result).toBe("partial");
		expect(parsed.environment).toBe("QA: Lab #2 result: pass");
		expect(parsed.executedBy).toBe("Tester: A status: approved");
	});

	test("P1-14, P2-17, P2-20: runbook keeps multi-DDL per table without drops/dupes, footnotes match encoded IDs & deduplicate fnrefs, release notes deduplicate counts", () => {
		// P1-14: multiple SQL DDL scripts targeting one schema-prefixed table
		const runbook = assembleDeploymentRunbook({
			sqlTables: [
				{ name: "dbo.ORDERS", dependsOn: ["dbo.CLIENTS"], path: "schema/01_orders.sql" },
				{ name: "dbo.CLIENTS", path: "schema/00_clients.sql" },
			],
			sqlArtifacts: [
				{ path: "./schema/01_orders.sql", kind: "DDL", source: "ORDERS" }, // dup of dep.path
				{ path: "schema/02_orders_alter.sql", kind: "DDL", source: "ORDERS" }, // bare name -> matches dbo.ORDERS!
				{ path: "schema/03_orders_idx.sql", kind: "DDL", source: "dbo.ORDERS" },
			],
		});
		expect(runbook.match(/01_orders\.sql/g)?.length).toBe(1);
		expect(runbook).toContain("Apply table DDL `dbo.ORDERS` (`schema/02_orders_alter.sql`).");
		expect(runbook).toContain("Apply table DDL `dbo.ORDERS` (`schema/03_orders_idx.sql`).");
		expect(runbook.indexOf("00_clients.sql")).toBeLessThan(runbook.indexOf("01_orders.sql"));
		expect(runbook.indexOf("01_orders.sql")).toBeLessThan(runbook.indexOf("02_orders_alter.sql"));

		// P2-17: consistent encoded IDs and unique repeated fnref IDs
		const fnHtml = transformMarkdownFootnotes("First[^a/b] and again[^a/b].\n\n[^a/b]: Note text.\n", "html");
		expect(fnHtml).toContain('href="#fn-a%2Fb" id="fnref-a%2Fb"');
		expect(fnHtml).toContain('href="#fn-a%2Fb" id="fnref-a%2Fb-2"');
		expect(fnHtml).toContain('<li id="fn-a%2Fb">Note text. <a href="#fnref-a%2Fb"');

		// P2-20: release notes deduplicate SQL paths, registry rows, registry names, and omit empty registries
		const notes = assembleReleaseNotesMarkdown({
			projectName: "LabCore",
			releaseName: "v3.1",
			generatedOn: "2026-11-24",
			tickets: [{ key: "LIMS-1", title: "Demo", type: "Story", status: "done" }],
			scripts: [],
			sqlArtifacts: [
				{ path: "./schema/orders.sql", kind: "DDL", source: "ORDERS" },
				{ path: "schema\\orders.sql", kind: "DDL", source: "ORDERS" },
			],
			registries: [
				{ title: "Settings", headers: ["name", "status"], rows: [["K1", "done"], ["k1", "DONE"]] },
				{ title: "Settings", headers: ["name", "status"], rows: [["K2", "done"]] },
				{ title: "EmptyReg", headers: ["name"], rows: [] },
			],
		});
		expect(notes).toContain("1 SQL/schema artifact included");
		expect(notes).toContain("2 tracked registry changes across Settings.");
		expect(notes).not.toContain("EmptyReg");
	});
});

describe("R7A.4 — ADF and wikiMarkup security and edge-case repairs", () => {
	test("adf.ts guards invalid dates, rejects unsafe link/card protocols, preserves nested-table inCell, handles empty tableRow, and escapes expand titles", () => {
		const doc = {
			type: "doc",
			version: 1,
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "date", attrs: { timestamp: "99999999999999999" } },
						{ type: "text", text: "safe ", marks: [{ type: "link", attrs: { href: "https://example.test/a (b)<c>" } }] },
						{ type: "text", text: "badJs", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
						{ type: "text", text: " " },
						{ type: "inlineCard", attrs: { url: "javascript:alert(2)" } },
						{ type: "inlineCard", attrs: { url: "https://example.test/card (1)><b>" } },
					],
				},
				{ type: "table", content: [{ type: "tableRow", content: [] }] },
				{
					type: "table",
					content: [
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									content: [
										{
											type: "table",
											content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }] }] }],
										},
										{ type: "paragraph", content: [{ type: "text", text: "a|b", marks: [{ type: "code" }] }] },
									],
								},
							],
						},
					],
				},
				{ type: "expand", attrs: { title: "Title <script>*x*</script>" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] },
			],
		};
		const md = adfToMarkdown(doc);
		expect(md).not.toContain("javascript:");
		expect(md).toContain("[safe](https://example.test/a%20%28b%29%3Cc%3E)");
		expect(md).toContain("badJs");
		expect(md).toContain("<https://example.test/card%20%281%29%3E%3Cb%3E>");
		// Empty tableRow produces no empty "|  |" table
		expect(md).not.toContain("|  |");
		// After nested table, outer cell's code mark STILL uses <code> with &#124; (inCell restored!)
		expect(md).toContain("<code>a&#124;b</code>");
		// Expand title escaped
		expect(md).toContain("**Title &lt;script>\\*x\\*&lt;/script>**");
	});

	test("wikiMarkup.ts rejects unsafe protocols, percent-encodes safe URLs, and escapes panel/code titles", () => {
		const input = [
			"[Click|javascript:alert(1)] [VB|vbscript:x] [Data|data:text/html,<b>x</b>]",
			"[Safe|https://example.test/a (b)<c>]",
			"[https://example.test/x><b>y</b>]",
			"{panel:title=Note <script>*bad*</script>}",
			"Inside panel",
			"{panel}",
			"{code:title=Run *all* <tag>|language=sql}",
			"SELECT 1;",
			"{code}",
		].join("\n");
		const md = wikiToMarkdown(input);
		expect(md).not.toContain("javascript:");
		expect(md).not.toContain("vbscript:");
		expect(md).not.toContain("data:text/html");
		expect(md).toContain("Click VB Data");
		expect(md).toContain("[Safe](https://example.test/a%20%28b%29%3Cc%3E)");
		expect(md).toContain("<https://example.test/x%3E%3Cb%3Ey%3C/b%3E>");
		expect(md).toContain("> [!note] Note &lt;script>\\*bad\\*&lt;/script>");
		expect(md).toContain("**Run \\*all\\* &lt;tag>**");
	});
});

describe("R7A.5 — codeCitations, docTables, tasks, ticketImport/projectDocs, catalog, docChecks & tags repairs", () => {
	test("codeCitations detects drift under unchanged first 2 lines, adjusts leading-blank locateSnippet, avoids $ replacement bugs, and widens fences", async () => {
		const doc = [
			"See [Rule.ssl, lines 2 to 5](src/$dir/Rule.ssl#L2-L5):",
			"",
			"```ssl",
			"line1();",
			"line2();",
			"line3_old();",
			"line4();",
			"```",
		].join("\n");
		const modifiedTarget = ["hdr();", "line1();", "line2();", "line3_NEW();", "line4();"].join("\n");
		const issues = await checkCodeCitations("/ws/spec.md", doc, "/ws", async () => modifiedTarget);
		expect(issues).toHaveLength(1);
		expect(issues[0]!.kind).toBe("drifted");

		// Leading-blank offset when snippet shifted down
		const docBlank = ["[Rule](src/Rule.ssl#L1-L4)", "", "```ssl", "", "anchorA();", "anchorB();", "oldEnd();", "```"].join("\n");
		const shiftedTarget = ["pad1();", "pad2();", "", "anchorA();", "anchorB();", "newEnd();"].join("\n");
		const shiftedIssues = await checkCodeCitations("/ws/spec.md", docBlank, "/ws", async () => shiftedTarget);
		expect(shiftedIssues[0]!.kind).toBe("shifted");
		expect(shiftedIssues[0]!.reanchor).toEqual({ from: 3, to: 6 });

		// reanchorCitation preserves literal `$&` in file path
		const [cit] = findCodeCitations("See [file, lines 2 to 5](src/$&dir/Rule.ssl#L2-L5)");
		expect(reanchorCitation("See [file, lines 2 to 5](src/$&dir/Rule.ssl#L2-L5)", cit!, 10, 12)).toBe(
			"See [file, lines 10 to 12](src/$&dir/Rule.ssl#L10-L12)",
		);

		// refreshCitationExcerpt widens fence when live excerpt contains ``` and rejects mixed `~` delimiter
		const [citRefresh] = findCodeCitations(doc);
		const targetWithBackticks = ["hdr", "line1", "```embedded```", "line3", "line4"].join("\n");
		const refreshed = refreshCitationExcerpt(doc, citRefresh!, targetWithBackticks)!;
		expect(refreshed).toContain("````ssl\nline1\n```embedded```\nline3\nline4\n````");
		const mixedFenceDoc = "See [Rule](src/Rule.ssl#L1-L2)\n\n`~`ssl\na\n`~`\n";
		expect(refreshCitationExcerpt(mixedFenceDoc, { line: 1, href: "src/Rule.ssl#L1-L2", file: "src/Rule.ssl", from: 1, to: 2 }, "x\ny")).toBeNull();
	});

	test("docTables tracks duplicate tables after code fences, finds blockquoted table lines, and handles balanced link parens in cellText", () => {
		expect(cellText("[Wiki](https://en.wikipedia.org/wiki/Sample_(lab))")).toBe("Wiki");
		const md = [
			"```md",
			"| A | B | C | D | E |",
			"| --- | --- | --- | --- | --- |",
			"| 1 | 2 | 3 | 4 | 5 |",
			"```",
			"",
			"| A | B | C | D | E |",
			"| --- | --- | --- | --- | --- |",
			"| 1 | 2 | 3 | 4 | 5 |",
			"",
			"| A | B | C | D | E |",
			"| --- | --- | --- | --- | --- |",
			"| 1 | 2 | 3 | 4 | 5 |",
			"",
			"> | A | B | C | D | E |",
			"> | --- | --- | --- | --- | --- |",
			"> | 1 | 2 | 3 | 4 | 5 |",
		].join("\n");
		const findings = checkTables(md);
		expect(findings.map((f) => f.line)).toEqual([7, 11, 15]);
	});

	test("tasks.ts ignores checkboxes inside fenced blocks nested in blockquotes and list items", () => {
		const md = [
			"# Checklist",
			"",
			"> ```md",
			"> - [ ] deploy",
			"> ```",
			"",
			"- Parent item",
			"",
			"  ```md",
			"  - [ ] deploy",
			"  ```",
			"",
			"- [ ] deploy",
		].join("\n");
		const found = tasks(md);
		expect(found).toHaveLength(1);
		expect(found[0]!.line).toBe(13);
		const toggled = toggleTask(md, 0)!;
		expect(toggled.split("\n")[3]).toBe("> - [ ] deploy");
		expect(toggled.split("\n")[9]).toBe("  - [ ] deploy");
		expect(toggled.split("\n")[12]).toBe("- [x] deploy");
	});

	test("projectDocs & ticketImport safely quote/reject malicious source URLs", () => {
		const tpl = ticketTemplate({ key: "LIMS-9", title: "Safe", source: "https://example.test/9\nstatus: done" });
		const fm = frontMatter(tpl).values;
		expect(fm.status).toBe("open");
		expect(fm.source).toBe("https://example.test/9 status: done");

		const csv = 'ID,Title,URL\n1,One,"https://example.test/1\nstatus: done"\n2,Two,"https://example.test/2\u0000x"\n3,Three,"https://example.test/3"\n';
		const fromCsv = ticketsFromTable(parseCsv(csv));
		expect(fromCsv.tickets.map((t) => t.source)).toEqual([undefined, undefined, "https://example.test/3"]);

		const fromJson = ticketsFromJson([
			{ number: 1, title: "Injected", html_url: "https://example.test/1\nevil: true" },
			{ key: "LAB-2", self: "https://example.test/a\nb/rest/api/2/issue/2", fields: { summary: "Injected self" } },
			{ number: 3, title: "Clean", html_url: "  https://example.test/3\r\n" },
		]);
		expect(fromJson.tickets.map((t) => t.source)).toEqual([undefined, undefined, "https://example.test/3"]);
	});

	test("catalog.ts withCatalog writes one list when closing marker is missing, and keeps an old entry it cannot tell from a person's line below it", () => {
		const broken = `# Docs\n\n${CATALOG_START}\n\n- [With \\[brackets\\]](a.md): open.\n\nMy own notes.\n`;
		const fixed = withCatalog(broken, [{ path: "b.md", title: "New" }]);
		// Once taken out as "the old list"; a bullet that links to a document is also what a person writes (pass 3, low 5).
		expect(fixed.split(CATALOG_START).length).toBe(2);
		expect(fixed.indexOf("With \\[brackets\\]")).toBeGreaterThan(fixed.indexOf("<!-- /catalog -->"));
		expect(fixed).toContain("- [New](b.md)");
		expect(fixed).toContain("My own notes.");
	});

	test("docChecks reports self-loops in blocks/blocked-by and supersedes/superseded-by", () => {
		const files: DocFile[] = [
			{ group: "tickets", name: "INDEX.md", path: "/ws/docs/tickets/INDEX.md", exists: true, catalog: { stale: false } },
			{ group: "knowledge", name: "INDEX.md", path: "/ws/docs/knowledge/INDEX.md", exists: true, catalog: { stale: false } },
			{ group: "tickets", name: "SELF-1.md", path: "/ws/docs/tickets/SELF-1.md", exists: true, ticket: "SELF-1", status: "open", blocks: ["SELF-1"] },
			{
				group: "knowledge",
				kind: "decisions",
				name: "decisions/0001-self.md",
				path: "/ws/docs/knowledge/decisions/0001-self.md",
				exists: true,
				title: "Self ADR",
				status: "accepted",
				supersedes: ["0001-self"],
			},
		];
		const checks = docChecks(files);
		expect(checks.some((c) => c.level === "warn" && c.text.includes("SELF-1 → SELF-1"))).toBe(true);
		expect(checks.some((c) => c.level === "warn" && c.text.includes("Self ADR → Self ADR"))).toBe(true);
		expect(checks.some((c) => c.fix?.kind === "reciprocal-adr")).toBe(false);
	});

	test("tags.ts strips multi-line HTML comments without stripping tags after code-fence/inline-code comments", () => {
		const md = [
			"<!--",
			"Draft note with #hidden-tag",
			"and #also-hidden",
			"-->",
			"Visible #real-tag here.",
			"",
			"```html",
			"<!--",
			"```",
			"",
			"Keep #after-fence and `<!--` then #after-inline and `-->`.",
		].join("\n");
		expect(extractTags(md)).toEqual(["real-tag", "after-fence", "after-inline"]);
	});
});
