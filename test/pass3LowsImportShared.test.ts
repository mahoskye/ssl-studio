// The low findings of the pass 3 audit in Word import, the line diff behind the margin marks, the SQL schema reader
// and the script that puts the language server under vendor/. Each test runs the code it names. Nothing here goes to
// the network: the download of the script is given as a function, and `fetch` itself throws while those tests run.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { marked } from "marked";
import * as bundle from "../scripts/bundle-lsp";
import { parseDocxToMarkdown } from "../src/bun/docx";
import * as tools from "../src/bun/tools";
import { lineChanges } from "../src/shared/lineDiff";
import { extractQueriedTablesFromSql, extractSqlObjects, parseCreateTables, schemaMarkdownToSql, sqlTablesToMarkdown } from "../src/shared/sqlSchema";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p3l8-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string) => {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const posix = process.platform !== "win32";

/** A zip of these files, each deflated: enough of one for the reader. */
function zip(entries: { name: string; data: string }[]): Uint8Array {
	const enc = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = enc.encode(entry.name);
		const raw = enc.encode(entry.data);
		const packed = new Uint8Array(deflateRawSync(raw));
		const local = new Uint8Array(30 + name.length + packed.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(8, 8, true);
		lv.setUint32(18, packed.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		local.set(packed, 30 + name.length);
		locals.push(local);
		const central = new Uint8Array(46 + name.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, 8, true);
		cv.setUint32(20, packed.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		central.set(name, 46);
		centrals.push(central);
		offset += local.length;
	}
	const size = centrals.reduce((sum, part) => sum + part.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, size, true);
	ev.setUint32(16, offset, true);
	return Buffer.concat([...locals, ...centrals, end]);
}

const W =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml"';
type Files = { name: string; data: string }[];
const documentXml = (body: string) => `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
/** A document whose XML stops where `xml` does: no closing tags after it. */
const cutShort = (xml: string) => `<?xml version="1.0"?><w:document ${W}>${xml}`;
const only = (data: string): Files => [{ name: "word/document.xml", data }];
const relationships = (items: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text: string, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${inner}</w:p>`;
/** The Markdown of a document with this body. */
const read = (body: string, more: Files = []) => parseDocxToMarkdown(zip([...only(documentXml(body)), ...more]), "Sample.docx");
/** The Markdown of one paragraph that says `text`. */
const readText = (text: string) => read(para(run(xml(text)))).markdown;

// ---------------------------------------------------------------------------------------------------------------
// 1. A small file that held the backend for tens of seconds
// ---------------------------------------------------------------------------------------------------------------

/** As long as any of the documents below may take. Each took the old reader from 4 to more than 30 seconds. */
const WITHIN_MS = 2000;
const said = para("<w:r><w:t>still read</w:t></w:r>");

const hostile: { name: string; files: () => Files; gives: string | RegExp }[] = [
	{ name: "16,000 text tags in one run that nothing closes", files: () => only(documentXml(`<w:p><w:r>${"<w:t>x".repeat(16000)}</w:r></w:p>${said}`)), gives: "still read" },
	{
		name: "a choice inside a choice, 5,000 deep",
		files: () => only(documentXml("<mc:AlternateContent><mc:Choice>".repeat(5000) + said + "</mc:Choice></mc:AlternateContent>".repeat(5000))),
		gives: "still read",
	},
	{ name: "5,000 choices that nothing closes", files: () => only(documentXml("<mc:AlternateContent><mc:Choice>".repeat(5000) + said)), gives: "still read" },
	{ name: "40,000 body tags and no closing one", files: () => only(cutShort("<w:body>".repeat(40000) + said)), gives: "still read" },
	{ name: "a text of 100,000 spaces", files: () => only(documentXml(para(run(`${" ".repeat(100000)}still read`)))), gives: "still read" },
	{ name: "8,000 comment references cut short", files: () => only(cutShort(`<w:body>${said}<w:p><w:r>${"<w:commentReference ".repeat(8000)}`)), gives: "still read" },
	{ name: "run properties of 24,000 bold tags cut short", files: () => only(cutShort(`<w:body>${said}<w:p><w:r><w:rPr>${"<w:b ".repeat(24000)}`)), gives: "still read" },
	{
		name: "a relationships file of 24,000 tags cut short",
		files: () => [...only(documentXml(said)), { name: "word/_rels/document.xml.rels", data: "<Relationship ".repeat(24000) }],
		gives: "still read",
	},
	{
		name: "8,000 styles, each based on the next, under 8,000 paragraphs",
		files: () => [
			...only(documentXml(Array.from({ length: 8000 }, (_, i) => para(`<w:r><w:t>p${i}</w:t></w:r>`, `<w:pStyle w:val="S${i}"/>`)).join(""))),
			{
				name: "word/styles.xml",
				data: `<w:styles ${W}>${Array.from({ length: 8000 }, (_, i) => `<w:style w:type="paragraph" w:styleId="S${i}"><w:name w:val="s${i}"/><w:basedOn w:val="S${i + 1}"/></w:style>`).join("")}</w:styles>`,
			},
		],
		gives: /^p0\n\np1\n\np2\n/,
	},
	{
		name: "16,000 numbered lists of one item at the second level",
		files: () => [
			...only(documentXml(Array.from({ length: 16000 }, (_, i) => para("<w:r><w:t>item</w:t></w:r>", `<w:numPr><w:ilvl w:val="1"/><w:numId w:val="${i + 1}"/></w:numPr>`)).join(""))),
			{
				name: "word/numbering.xml",
				data: `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>${Array.from({ length: 16000 }, (_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="0"/></w:num>`).join("")}</w:numbering>`,
			},
		],
		gives: /^1\. item\n  1\. item\n  1\. item\n/,
	},
	{
		name: "8,000 list levels under 8,000 lists",
		files: () => [
			...only(documentXml(said)),
			{
				name: "word/numbering.xml",
				data: `<w:numbering ${W}><w:abstractNum w:abstractNumId="0">${Array.from({ length: 8000 }, (_, i) => `<w:lvl w:ilvl="${i}"/>`).join("")}</w:abstractNum>${Array.from({ length: 8000 }, (_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="0"/></w:num>`).join("")}</w:numbering>`,
			},
		],
		gives: "still read",
	},
];

describe("1. a small Word file made to be slow is read in the time its length takes", () => {
	for (const shape of hostile) {
		test(
			shape.name,
			() => {
				const bytes = zip(shape.files());
				const started = performance.now();
				const { markdown } = parseDocxToMarkdown(bytes, "Hostile.docx");
				expect(performance.now() - started).toBeLessThan(WITHIN_MS);
				if (typeof shape.gives === "string") expect(markdown).toBe(shape.gives);
				else expect(markdown).toMatch(shape.gives);
			},
			30_000,
		);
	}

	test(
		"links and tracked changes nested without end are refused at once, by the file's name",
		() => {
			for (const tag of ["w:hyperlink", "w:ins", "w:del"]) {
				const open8000 = documentXml(`${said}<w:p>${`<${tag}>`.repeat(8000)}<w:r><w:t>deep</w:t></w:r></w:p>`);
				const closed8000 = documentXml(`${said}<w:p>${`<${tag}>`.repeat(8000)}<w:r><w:t>deep</w:t></w:r>${`</${tag}>`.repeat(8000)}</w:p>`);
				for (const data of [open8000, closed8000]) {
					const started = performance.now();
					expect(() => parseDocxToMarkdown(zip(only(data)), "Hostile.docx")).toThrow("Hostile.docx cannot be read here: links and tracked changes in it are nested more than 100 deep.");
					expect(performance.now() - started).toBeLessThan(WITHIN_MS);
				}
			}
			// A hundred deep is still read. No document Word writes comes near it.
			const deep = (levels: number) => read(para(`${"<w:ins>".repeat(levels)}<w:r><w:t>kept</w:t></w:r>${"</w:ins>".repeat(levels)}`)).markdown;
			expect(deep(3)).toBe("======kept======");
			expect(deep(100)).toBe(`${"==".repeat(100)}kept${"==".repeat(100)}`);
			expect(() => deep(101)).toThrow(/Sample\.docx cannot be read here/);
		},
		30_000,
	);

	// Its width was asked for in one call with an argument a row, which is more than a call takes: "Maximum call
	// stack size exceeded", from a file of 34 KiB.
	test("a table of 700,000 rows is a table", () => {
		const rows = 700_000;
		const { markdown } = read(`<w:tbl>${"<w:tr><w:tc/></w:tr>".repeat(rows)}</w:tbl>`);
		expect(markdown.split("\n").length).toBe(rows + 1);
		expect(markdown.startsWith("|  |\n| --- |\n|  |")).toBe(true);
	}, 60_000);

	// What the old reader made of this document, to the character: its text has none of the signs that are now
	// written with a backslash, so nothing about it may have changed.
	test("an ordinary document reads as it did", () => {
		const listed = (numId: number, level: number) => `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`;
		const body = [
			para(run("Stability study of batch 12"), `<w:pStyle w:val="Title"/>`),
			para(run("Scope"), `<w:pStyle w:val="Kapitel"/>`),
			para(
				run("Samples are kept at ") +
					run("25 degrees", "<w:b/>") +
					run(" and read ") +
					run("weekly", "<w:i/>") +
					run(" with ") +
					run("ReadPlate", `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>`) +
					run(", never ") +
					run("monthly", "<w:strike/>") +
					run(" (") +
					run("see the plan", `<w:highlight w:val="yellow"/>`) +
					run(").") +
					`<w:r><w:footnoteReference w:id="2"/></w:r>`,
			),
			para(run("Steps"), `<w:pStyle w:val="Unterkapitel"/>`),
			para(run("Weigh the sample"), listed(1, 0)),
			para(run("Dissolve it"), listed(1, 0)),
			para(run("in water"), listed(2, 1)),
			para(run("or in buffer"), listed(2, 1)),
			para(run("Read the plate"), listed(1, 0)),
			para(
				run("The method is in ") +
					`<w:hyperlink r:id="rId1"><w:r><w:t>the method sheet</w:t></w:r></w:hyperlink>` +
					run(" and at ") +
					`<w:hyperlink r:id="rId2"><w:r><w:t>https://docs.example/methods/plate</w:t></w:r></w:hyperlink>` +
					run("."),
			),
			`<w:tbl><w:tblPr/><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc>${para(run("Week", "<w:b/>"))}</w:tc><w:tc>${para(run("Result", "<w:b/>"))}</w:tc></w:tr><w:tr><w:tc>${para(run("1"))}</w:tc><w:tc>${para(run("98.2"))}${para(run("within limits"))}</w:tc></w:tr><w:tr><w:tc>${para(run("2"))}</w:tc></w:tr></w:tbl>`,
			para(
				run("The limit was ") +
					`<w:del w:id="5" w:author="Reviewer"><w:r><w:delText>95</w:delText></w:r></w:del>` +
					`<w:ins w:id="6" w:author="Reviewer"><w:r><w:t>97</w:t></w:r></w:ins>` +
					run(" percent") +
					`<w:commentRangeStart w:id="0"/>` +
					run(" for all batches") +
					`<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>` +
					run("."),
			),
			para(
				`<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><a:blip r:embed="rId3"/></w:drawing></mc:Choice><mc:Fallback><w:pict><v:imagedata r:id="rId4"/></w:pict></mc:Fallback></mc:AlternateContent></w:r>` +
					`<w:r><w:t>First line</w:t><w:br/><w:t>second line</w:t><w:tab/><w:t>after a tab</w:t><w:t/></w:r>` +
					`<w:r><w:pict><v:imagedata r:id="rId4"/></w:pict></w:r>`,
			),
			para(run("Acid &amp; base, both")),
			para(run("• a point made by hand")),
			`<w:sectPr/>`,
		].join("");
		const parsed = read(body, [
			{
				name: "word/_rels/document.xml.rels",
				data: relationships(
					`<Relationship Id="rId1" Type="h" Target="docs/method.md" TargetMode="External"/><Relationship Id="rId2" Type="h" Target="https://docs.example/methods/plate" TargetMode="External"/><Relationship Id="rId3" Type="i" Target="media/image1.png"/><Relationship Id="rId4" Type="i" Target="media/old/image1.png"/>`,
				),
			},
			{
				name: "word/styles.xml",
				data: `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Kapitel"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Unterkapitel"><w:name w:val="Unterkapitel"/><w:basedOn w:val="Stufe3"/></w:style><w:style w:type="paragraph" w:styleId="Stufe3"><w:name w:val="Stufe 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style></w:styles>`,
			},
			{
				name: "word/numbering.xml",
				data: `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
			},
			{
				name: "word/footnotes.xml",
				data: `<w:footnotes ${W}><w:footnote w:type="separator" w:id="0"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Plan 7, section 3.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
			},
			{ name: "word/comments.xml", data: `<w:comments ${W}><w:comment w:id="0" w:author="Quality" w:date="2026-03-04T09:00:00Z"><w:p><w:r><w:t>Which batches?</w:t></w:r></w:p></w:comment></w:comments>` },
			{ name: "word/media/image1.png", data: "PNG one" },
			{ name: "word/media/old/image1.png", data: "PNG two" },
		]);
		expect(parsed.markdown).toBe(
			[
				"# Stability study of batch 12",
				"",
				"## Scope",
				"",
				"Samples are kept at **25 degrees** and read *weekly* with `ReadPlate`, never ~~monthly~~ (==see the plan==).[^2]",
				"",
				"### Steps",
				"",
				"1. Weigh the sample",
				"2. Dissolve it",
				"  - in water",
				"  - or in buffer",
				"3. Read the plate",
				"",
				"The method is in [the method sheet](docs/method.md) and at <https://docs.example/methods/plate>.",
				"",
				"| Week | Result |",
				"| --- | --- |",
				"| 1 | 98.2<br>within limits |",
				"| 2 |  |",
				"",
				"The limit was ~~95~~==97== percent for all batches[^comment-0].",
				"",
				"{{DOCX_IMG:image1.png}}First line",
				"second line\tafter a tab{{DOCX_IMG:image1-2.png}}",
				"",
				"Acid & base, both",
				"",
				"- a point made by hand",
				"",
				"[^2]: Plan 7, section 3.",
				"[^comment-0]: [QA Comment — Quality, 2026-03-04]: Which batches?",
			].join("\n"),
		);
		expect(parsed.images.map((image) => [image.name, new TextDecoder().decode(image.bytes)])).toEqual([
			["image1.png", "PNG one"],
			["image1-2.png", "PNG two"],
		]);
		expect(parsed.warnings).toEqual(["Imported document contained unaccepted Word Track Changes — marked with ==ins== / ~~del~~ for review.", "Imported 1 Word QA review comment(s) as footnotes."]);
	});

	test("which of two versions of a drawing is kept, and where a block that nothing closes ends, is as it was", () => {
		const choice = (text: string) => `<mc:Choice>${para(run(text))}</mc:Choice>`;
		const fallback = (text: string) => `<mc:Fallback>${para(run(text))}</mc:Fallback>`;
		const alt = (inner: string) => `<mc:AlternateContent>${inner}</mc:AlternateContent>`;
		// The first choice, whatever stands before it; without one the first fallback; neither, nothing.
		expect(read(alt(fallback("old") + choice("new") + choice("newer"))).markdown).toBe("new");
		expect(read(alt(fallback("old") + fallback("older"))).markdown).toBe("old");
		expect(read(`${para(run("before"))}${alt(para(run("neither")))}${para(run("after"))}`).markdown).toBe("before\n\nafter");
		// A block in the choice of a block, and one in a fallback that is not taken.
		expect(read(alt(`<mc:Choice>${para(run("outer"))}${alt(fallback("inner old") + choice("inner new"))}</mc:Choice>${fallback(alt(choice("never")))}`)).markdown).toBe("outer\n\ninner new");
		// Another prefix is another element: its choice is not this block's.
		expect(read(alt(`<x:Choice>${para(run("theirs"))}</x:Choice>${fallback("ours")}`)).markdown).toBe("ours");
		// Nothing closes the block: it runs to the end, and what follows its choice is lost with it, as before.
		expect(read(`${para(run("before"))}<mc:AlternateContent>${choice("kept")}${para(run("lost"))}`).markdown).toBe("before\n\nkept");
		// A block that closes itself is nothing.
		expect(read(`${para(run("a"))}<mc:AlternateContent/>${para(run("b"))}`).markdown).toBe("a\n\nb");
	});

	test("text in a run, a font for code and the flags of a run are found as they were where a tag is cut short", () => {
		// A `<w:t/>` that closes itself takes nothing; one that nothing closes is no text, and what follows it is still read.
		expect(read(para("<w:r><w:t>one</w:t><w:t/><w:br/><w:t>two</w:t></w:r>")).markdown).toBe("one\ntwo");
		expect(read(para("<w:r><w:t>one</w:t><w:delText>never closed<w:tab/><w:t>two</w:t></w:r>")).markdown).toBe("one\ttwo");
		// Text before run properties that the end of the file cuts off inside a font tag: still set as code.
		expect(parseDocxToMarkdown(zip(only(cutShort(`<w:body><w:p><w:r><w:t>GetSample</w:t><w:rPr><w:rFonts w:ascii="Consolas"`)))).markdown).toBe("`GetSample`");
		expect(read(para(run("on", "<w:b/>") + run(" off", `<w:b w:val="0"/>`) + run(" other", "<w:bCs/>") + run(" spaced", "<w:b />") + run(" slanted", `<w:i w:val='true'/>`))).markdown).toBe("**on** off other **spaced** *slanted*");
		// The body is what stands between the first opening and the last closing tag.
		expect(parseDocxToMarkdown(zip(only(`<w:document><w:body>${para(run("in"))}</w:body>${para(run("between"))}</w:body>${para(run("out"))}</w:document>`))).markdown).toBe("in\n\nbetween");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. What a document says is text, and what it carries is a picture or nothing
// ---------------------------------------------------------------------------------------------------------------

describe("2. Word import: document text is written as text", () => {
	test("signs that Markdown reads as markup carry a backslash, and no others do", () => {
		const cases: [string, string][] = [
			// Left as they are written.
			["The limit is 5 mg/kg at pH = 7.2 (n = 3), a < b and b > a.", "The limit is 5 mg/kg at pH = 7.2 (n = 3), a < b and b > a."],
			["SAMPLE_ID and run_no_2 in C:\\Temp\\new", "SAMPLE_ID and run_no_2 in C:\\Temp\\new"],
			["C# and #12, 50% & more, 3 + 4 - 1", "C# and #12, 50% & more, 3 + 4 - 1"],
			["See https://docs.example/a_b?x=1&y=2. Also www.docs.example.", "See https://docs.example/a_b?x=1&y=2. Also www.docs.example."],
			// Emphasis, code, strikethrough, math, highlight.
			["5 * 10 and *not slanted* and **not bold**", "5 \\* 10 and \\*not slanted\\* and \\*\\*not bold\\*\\*"],
			["_draft_ and __init__", "\\_draft\\_ and \\_\\_init\\_\\_"],
			["`ticks` and ~about~ and ~~struck~~", "\\`ticks\\` and \\~about\\~ and \\~\\~struck\\~\\~"],
			["$5 and $10, a==b==c", "\\$5 and \\$10, a\\=\\=b\\=\\=c"],
			// Links, embeds, notes, HTML.
			["[x](y) and [[Page]] and ![[shot.png]] and [^1]", "\\[x\\](y) and \\[\\[Page\\]\\] and !\\[\\[shot.png\\]\\] and \\[^1\\]"],
			["<b>bold</b> <!-- gone --> <script>", "\\<b>bold\\</b> \\<!-- gone --> \\<script>"],
			["<lab@docs.example> and <7@docs.example> but <5 and < 7", "\\<lab@docs.example> and \\<7@docs.example> but <5 and < 7"],
			["&#42; and &#x2A;", "&\\#42; and &\\#x2A;"],
			["#tag and (#other)", "\\#tag and (\\#other)"],
			// A backslash that would itself be read as an escape.
			["\\*literal\\* and a\\", "\\\\\\*literal\\\\\\* and a\\\\"],
			// An address is not touched; where a backslash would go into it, it stands in angle brackets.
			["at https://docs.example/_private/*x* here", "at <https://docs.example/_private/*x>\\* here"],
			["https://docs.example/a<b>", "<https://docs.example/a>\\<b>"],
			["www.docs.example/_a", "www\\.docs.example/\\_a"],
			// A backslash that stood before such an address would take the angle bracket for its own.
			["see \\https://docs.example/*x*", "see \\\\<https://docs.example/*x>\\*"],
		];
		for (const [text, markdown] of cases) expect([text, readText(text)]).toEqual([text, markdown]);
	});

	test("what a sign means at the start of a line only", () => {
		const cases: [string, string][] = [
			["# not a heading", "\\# not a heading"],
			["###### nor this", "\\###### nor this"],
			["> not a quote", "\\> not a quote"],
			["- not a list", "\\- not a list"],
			["+ nor this", "\\+ nor this"],
			["1. First point, numbered by hand", "1\\. First point, numbered by hand"],
			["12) twelfth", "12\\) twelfth"],
			["| a | b |", "\\| a | b |"],
			["---", "\\---"],
			["=", "\\="],
			[":--- | ---:", ":\\--- | ---:"],
			// Not at a start, or not followed by a space: left alone.
			["-5 to +5, 1.5 and 2.", "-5 to +5, 1.5 and 2."],
			["a - b # c > d", "a - b # c > d"],
		];
		for (const [text, markdown] of cases) expect([text, readText(text)]).toEqual([text, markdown]);
		// Each line of a paragraph with line breaks in it.
		expect(read(para("<w:r><w:t>Title</w:t><w:br/><w:t>===</w:t><w:br/><w:t>a | b</w:t><w:br/><w:t>--- | ---</w:t><w:br/><w:t>- x</w:t></w:r>")).markdown).toBe("Title\n\\=\\=\\=\na | b\n\\--- | ---\n\\- x");
		// A heading's own line stands after its `#`: "1. Scope" needs nothing, a `#` that would close the heading does.
		expect(read(para(run("1. Scope"), `<w:outlineLvl w:val="1"/>`)).markdown).toBe("## 1. Scope");
		expect(read(para(run("Method C #"), `<w:outlineLvl w:val="0"/>`)).markdown).toBe("# Method C \\#");
		expect(read(para(run("C#"), `<w:outlineLvl w:val="0"/>`)).markdown).toBe("# C#");
		// The text of a list item starts a line of its own; so does what follows a bullet typed by hand.
		const numbering = { name: "word/numbering.xml", data: `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>` };
		expect(read(para(run("# x"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`), [numbering]).markdown).toBe("- \\# x");
		expect(readText("• 1. one")).toBe("- 1\\. one");
	});

	test("in a table a pipe stays in its cell, a backslash before it too, and nothing starts a list", () => {
		const cell = (text: string) => `<w:tc>${para(run(xml(text)))}</w:tc>`;
		const { markdown } = read(`<w:tbl><w:tr>${cell("a|b")}${cell("x\\|y")}</w:tr><w:tr>${cell("1. one")}${cell("# two *")}</w:tr></w:tbl>`);
		expect(markdown).toBe("| a\\|b | x\\\\\\|y |\n| --- | --- |\n| 1. one | # two \\* |");
		const html = marked.parse(markdown, { gfm: true }) as string;
		expect([...html.matchAll(/<t[hd]>(.*?)<\/t[hd]>/g)].map((m) => m[1])).toEqual(["a|b", "x\\|y", "1. one", "# two *"]);
		// An address in angle brackets ends before a backslash: in a cell, `\|` inside the brackets would be read as a pipe.
		const withAddress = read(`<w:tbl><w:tr>${cell("https://docs.example/a*b\\|c")}</w:tr></w:tbl>`).markdown;
		expect(withAddress).toBe("| <https://docs.example/a*b>\\\\\\|c |\n| --- |");
		expect((marked.parse(withAddress, { gfm: true }) as string).replace(/<[^>]+>/g, "").trim()).toBe("https://docs.example/a*b\\|c");
	});

	// Pass 4, M2: the pipes of a cell were found by counting the backslashes before each, begun again at every
	// backslash of a run: a cell of 40,000 backslashes (a 470-byte file) took 6.3 s, and the backend is one thread.
	test("a cell of backslashes is read in one pass, and comes out as it did", () => {
		const cell = (text: string) => `<w:tc>${para(run(xml(text)))}</w:tc>`;
		const long = "\\".repeat(40_000);
		const started = performance.now();
		const { markdown } = read(`<w:tbl><w:tr>${cell(long)}${cell("b")}</w:tr></w:tbl>`);
		const took = performance.now() - started;
		// Each backslash of the text is written as two, and no pipe is among them.
		expect(markdown).toBe(`| ${"\\".repeat(80_000)} | b |\n| --- | --- |`);
		// Milliseconds now; the limit is far above that for a slow machine, and far under what it took.
		expect(took).toBeLessThan(3000);
		// Pipes with none, one, two and three backslashes before them, and a backslash at the cell's end: as before.
		const mixed = read(`<w:tbl><w:tr>${cell("a|b")}${cell("a\\|b")}${cell("a\\\\|b|")}${cell("a\\\\\\|b")}${cell("end\\")}</w:tr></w:tbl>`).markdown;
		expect(mixed.split("\n")[0]).toBe("| a\\|b | a\\\\\\|b | a\\\\\\\\\\|b\\| | a\\\\\\\\\\\\\\|b | end\\\\ |");
		const html = marked.parse(mixed, { gfm: true }) as string;
		expect([...html.matchAll(/<t[hd]>(.*?)<\/t[hd]>/g)].map((m) => m[1])).toEqual(["a|b", "a\\|b", "a\\\\|b|", "a\\\\\\|b", "end\\"]);
	});

	test("the text of a link cannot end the link, and a link's own address is kept in angle brackets", () => {
		const rels = {
			name: "word/_rels/document.xml.rels",
			data: relationships(
				`<Relationship Id="rId1" Target="https://docs.example/" TargetMode="External"/><Relationship Id="rId2" Target="https://docs.example/_a_/*b*" TargetMode="External"/><Relationship Id="rId3" Target="javascript:alert(1)" TargetMode="External"/>`,
			),
		};
		const link = (id: string, text: string) => `<w:hyperlink r:id="${id}">${run(xml(text))}</w:hyperlink>`;
		expect(read(para(link("rId1", "l3](javascript:alert(2)) [x")), [rels]).markdown).toBe("[l3\\](javascript:alert(2)) \\[x](https://docs.example/)");
		expect(read(para(link("rId1", "https://docs.example/")), [rels]).markdown).toBe("<https://docs.example/>");
		expect(read(para(link("rId2", "https://docs.example/_a_/*b*")), [rels]).markdown).toBe("<https://docs.example/_a_/*b*>");
		expect(read(para(link("rId1", "www.docs.example/_a")), [rels]).markdown).toBe("[www.docs.example/\\_a](https://docs.example/)");
		// A link that is not to the web or to mail is its text.
		expect(read(para(link("rId3", "*click*")), [rels]).markdown).toBe("\\*click\\*");
		const html = marked.parse(read(para(link("rId1", "l3](javascript:alert(2)) [x")), [rels]).markdown) as string;
		expect(html.trim()).toBe('<p><a href="https://docs.example/">l3](javascript:alert(2)) [x</a></p>');
	});

	test("the number of a note cannot close its brackets, and who wrote a comment is text", () => {
		const parsed = read(para(`${run("See")}<w:r><w:footnoteReference w:id="1](https://docs.example/x) ["/></w:r><w:r><w:commentReference w:id="7"/></w:r>`), [
			{ name: "word/footnotes.xml", data: `<w:footnotes ${W}><w:footnote w:id="1](https://docs.example/x) ["><w:p><w:r><w:t># not a heading</w:t></w:r></w:p></w:footnote></w:footnotes>` },
			{ name: "word/comments.xml", data: `<w:comments ${W}><w:comment w:id="7" w:author="*Quality*&#10;[lab]" w:date="2026-03-04T09:00:00Z"><w:p><w:r><w:t>- why?</w:t></w:r></w:p></w:comment></w:comments>` },
		]);
		expect(parsed.markdown).toBe(
			["See[^1-https-docs-example-x-][^comment-7]", "", "[^1-https-docs-example-x-]: \\# not a heading", "[^comment-7]: [QA Comment — \\*Quality\\* \\[lab\\], 2026-03-04]: \\- why?"].join("\n"),
		);
	});

	test("text in a code font is code as it stands", () => {
		expect(read(para(run("a*b_c [x](y) <b>", `<w:rFonts w:ascii="Consolas"/>`))).markdown).toBe("`a*b_c [x](y) <b>`");
	});

	// Random text of signs through the reader and then through the renderer the preview uses: what comes out is the
	// text and nothing else. (An `&lt;` written out is still shown as `<`: left out here, and said in the report.)
	test("a thousand texts of signs come back from the renderer as their text", () => {
		let seed = 4242;
		const rnd = (n: number) => {
			seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
			return seed % n;
		};
		const bits = ["*", "**", "_", "__", "`", "[", "]", "(", ")", "<", ">", "#", "# ", "## ", "-", "- ", "+ ", "1. ", "2) ", "|", "~", "~~", "=", "==", "$", "\\", "!", "![", "[x](y)", "[[w]]", "<b>", "</b>", "<!--", "<https://docs.example>", "https://docs.example/a_b", "[^1]", "[a]: b", "---", "***", "===", ":--", "> ", "word", "a_b", "x", " ", " ", "7", "3.", "A", "#tag", "C#", "&", "{", "}", ".", ",", ":", "é", "_x_", "*y*", "`z`", "| a | b |", "\\*", "\\\\", "<br>", "www.docs.example", "$x$", "==h==", "~~s~~"];
		const text = () => {
			let out = "";
			for (let i = 1 + rnd(7); i > 0; i--) out += bits[rnd(bits.length)];
			return out.replace(/\s+/g, " ").trim();
		};
		const unhtml = (html: string) => html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
		const wrong: string[] = [];
		const check = (body: string, expected: string, allowed: RegExp) => {
			const { markdown } = read(body);
			const html = marked.parse(markdown, { gfm: true }) as string;
			// An address written out is made a link by the renderer: that is the text still.
			const tags = [...html.matchAll(/<\/?([a-z0-9]+)[^>]*>/g)].map((m) => m[1]!).filter((tag) => tag !== "a" && !allowed.test(tag));
			const shown = unhtml(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, "");
			if (tags.length || shown !== expected.replace(/\s+/g, "")) wrong.push(JSON.stringify({ expected, markdown, html }));
		};
		let texts = 0;
		for (let i = 0; texts < 1000; i++) {
			const t = text();
			const u = text();
			if (!t || !u || /&[#A-Za-z0-9]+;/.test(t + u)) continue;
			texts++;
			if (i % 4 === 0) check(para(run(xml(t))), t, /^p$/);
			else if (i % 4 === 1) check(para(`<w:r><w:t xml:space="preserve">${xml(t)}</w:t><w:br/><w:t xml:space="preserve">${xml(u)}</w:t></w:r>`), t + u, /^(p|br)$/);
			else if (i % 4 === 2) check(`<w:tbl><w:tr><w:tc>${para(run(xml(t)))}</w:tc><w:tc>${para(run(xml(u), "<w:i/>"))}</w:tc></w:tr></w:tbl>`, t + u, /^(table|thead|tr|th|em)$/);
			else check(para(run(xml(t)), `<w:outlineLvl w:val="1"/>`) + para(run(xml(`• ${u}`))), t + u, /^(h2|ul|li)$/);
		}
		expect(wrong.slice(0, 3)).toEqual([]);
	});
});

describe("2. Word import: only pictures the app shows are taken out of a document", () => {
	const blip = (id: string) => `<w:r><w:drawing><a:blip r:embed="${id}"/></w:drawing></w:r>`;
	const media = (): Files => [
		{
			name: "word/_rels/document.xml.rels",
			data: relationships(
				`<Relationship Id="rId1" Target="media/image1.png"/><Relationship Id="rId2" Target="media/image1.html"/><Relationship Id="rId3" Target="media/x.svg"/><Relationship Id="rId4" Target="media/Photo 2.JPG"/><Relationship Id="rId5" Target="media/chart.emf"/><Relationship Id="rId6" Target="media/plain"/>`,
			),
		},
		{ name: "word/media/image1.png", data: "PNG" },
		{ name: "word/media/image1.html", data: "<script>alert(1)</script>" },
		{ name: "word/media/x.svg", data: `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>` },
		{ name: "word/media/Photo 2.JPG", data: "JPG" },
		{ name: "word/media/chart.emf", data: "EMF" },
		{ name: "word/media/plain", data: "?" },
	];
	const body = para(run("Before ") + ["rId1", "rId2", "rId3", "rId4", "rId5", "rId6", "rId2"].map(blip).join("") + run(" after"));

	test("the reader gives the pictures, under names of plain characters, and says what it left", () => {
		const parsed = read(body, media());
		expect(parsed.images.map((image) => image.name)).toEqual(["image1.png", "Photo-2.JPG"]);
		expect(parsed.markdown).toBe("Before {{DOCX_IMG:image1.png}}{{DOCX_IMG:Photo-2.JPG}} after");
		expect(parsed.warnings).toEqual(["Left out 4 embedded file(s) that are not pictures SSL Studio shows: image1.html, x.svg, chart.emf, plain."]);
	});

	test("more than five are counted, not all named", () => {
		const ids = Array.from({ length: 8 }, (_, i) => `rId${i + 1}`);
		const parsed = read(para(ids.map(blip).join("")), [
			{ name: "word/_rels/document.xml.rels", data: relationships(ids.map((id, i) => `<Relationship Id="${id}" Target="media/part${i}.bin"/>`).join("")) },
			...ids.map((_, i) => ({ name: `word/media/part${i}.bin`, data: "x" })),
		]);
		expect(parsed.images).toEqual([]);
		expect(parsed.markdown).toBe("");
		expect(parsed.warnings).toEqual(["Left out 8 embedded file(s) that are not pictures SSL Studio shows: part0.bin, part1.bin, part2.bin, part3.bin, part4.bin and 3 more."]);
	});

	test("through the importer nothing but the pictures is written, and the warning comes back", async () => {
		const { createBackend } = await import("../src/bun/backend");
		const ws = fresh("media");
		mkdirSync(join(ws, "docs"));
		const backend = createBackend({ app: "test", kind: "app", emit: () => {}, pick: async () => null, trash: async () => {}, quit: () => {} }, ws);
		await backend.ready;
		try {
			const bytes = zip([...only(documentXml(body)), ...media()]);
			const result = await backend.api.importDocxBytes({ fileName: "Hostile.docx", base64: Buffer.from(bytes).toString("base64"), destDir: join(ws, "docs") });
			expect(readdirSync(join(ws, "docs")).sort()).toEqual(["Hostile.md", "attachments"]);
			expect(readdirSync(join(ws, "docs", "attachments")).sort()).toEqual(["Hostile-Photo-2.JPG", "Hostile-image1.png"]);
			expect(readFileSync(result.path, "utf8")).toBe("Before ![[Hostile-image1.png]]![[Hostile-Photo-2.JPG]] after\n");
			expect(result.warnings).toEqual(["Left out 4 embedded file(s) that are not pictures SSL Studio shows: image1.html, x.svg, chart.emf, plain."]);
		} finally {
			backend.dispose();
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The margin marks of two edits far apart
// ---------------------------------------------------------------------------------------------------------------

describe("3. the lines that differ, in a text too long for a table", () => {
	const file = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i + 1}`);

	test("two one-line edits 5,000 lines apart are two marks of one line", () => {
		const before = file(12000);
		const after = before.slice();
		after[2999] = "edited here";
		after[7999] = "and here";
		const started = performance.now();
		expect(lineChanges(before, after)).toEqual([
			{ kind: "modified", line: 3000, endLine: 3000 },
			{ kind: "modified", line: 8000, endLine: 8000 },
		]);
		expect(performance.now() - started).toBeLessThan(500);
	});

	test("lines put in, taken out and changed far from one another, each where it is", () => {
		const before = file(30000);
		const after = before.slice();
		after.splice(25000, 3); // lines 25001 to 25003 taken out
		after[12000] = "changed";
		after.splice(4000, 0, "new one", "new two"); // new lines 4001 and 4002
		expect(lineChanges(before, after)).toEqual([
			{ kind: "added", line: 4001, endLine: 4002 },
			{ kind: "modified", line: 12003, endLine: 12003 },
			{ kind: "removed", line: 25002, endLine: 25002 },
		]);
	});

	test("in a text of one line said over and over, the marks are on the lines that changed and nowhere else", () => {
		const before = new Array<string>(12000).fill("END;");
		const after = before.slice();
		after[2999] = "RETURN;";
		after[7999] = "BREAK;";
		const marked = new Set<number>();
		for (const change of lineChanges(before, after)) if (change.kind !== "removed") for (let line = change.line; line <= change.endLine; line++) marked.add(line);
		expect([...marked]).toEqual([3000, 8000]);
	});

	test("the budget is the work done either way: within it the changes are found, beyond it the middle is one block", () => {
		const before = Array.from({ length: 40 }, (_, i) => `l${i}`);
		const after = before.slice();
		after[4] = "x";
		after[34] = "y";
		// Between the first and the last change lie 31 lines: a table of 32 x 32 cells, too many for a budget of 60.
		expect(lineChanges(before, after, 60)).toEqual([
			{ kind: "modified", line: 5, endLine: 5 },
			{ kind: "modified", line: 35, endLine: 35 },
		]);
		expect(lineChanges(before, after, 20)).toEqual([{ kind: "modified", line: 5, endLine: 35 }]);
		// Enough for the table: the table's own answer, as before.
		expect(lineChanges(before, after, 2000)).toEqual(lineChanges(before, after, 60));
	});

	test("what is left unmarked is as much of the two texts as they share, for texts and budgets of every size", () => {
		let seed = 99;
		const rnd = (n: number) => {
			seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
			return seed % n;
		};
		const shared = (a: string[], b: string[]) => {
			const width = b.length + 1;
			const table = new Uint32Array((a.length + 1) * width);
			for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
			return table[0]!;
		};
		const inOrder = (part: string[], whole: string[]) => {
			let at = 0;
			for (const line of whole) if (at < part.length && part[at] === line) at++;
			return at === part.length;
		};
		let exact = 0;
		let oneBlock = 0;
		for (let n = 0; n < 4000; n++) {
			const alphabet = ["a", "b", "c", "d", "e", "", "f", "g"].slice(0, 2 + rnd(7));
			const before = Array.from({ length: rnd(40) }, () => alphabet[rnd(alphabet.length)]!);
			const after = before.slice();
			for (let edits = rnd(8); edits > 0; edits--) {
				const at = rnd(after.length + 1);
				const kind = rnd(3);
				if (kind === 0) after.splice(at, 0, alphabet[rnd(alphabet.length)]!);
				else if (after.length && kind === 1) after.splice(Math.min(at, after.length - 1), 1);
				else if (after.length) after[Math.min(at, after.length - 1)] = alphabet[rnd(alphabet.length)]!;
			}
			const changes = lineChanges(before, after, [1, 6, 12, 40, 200, 1000][rnd(6)]!);
			const marked = new Set<number>();
			let last = -1;
			for (const change of changes) {
				expect(change.line).toBeGreaterThanOrEqual(change.kind === "removed" ? 0 : 1);
				expect(change.endLine).toBeLessThanOrEqual(after.length);
				expect(change.line).toBeGreaterThanOrEqual(last);
				last = change.endLine;
				if (change.kind !== "removed") for (let line = change.line; line <= change.endLine; line++) marked.add(line);
			}
			const kept = after.filter((_, index) => !marked.has(index + 1));
			expect(inOrder(kept, before)).toBe(true);
			if (kept.length === shared(before, after)) exact++;
			else {
				// Fewer than could be kept only where the budget ran out, and then as one block.
				expect(changes.length).toBe(1);
				oneBlock++;
			}
		}
		expect(exact).toBeGreaterThan(2000);
		expect(oneBlock).toBeGreaterThan(500);
	});

	test("the worst case stays small: two texts with nothing in common are one block after a bounded search", () => {
		const before = Array.from({ length: 20000 }, (_, i) => `old ${i}`);
		const after = Array.from({ length: 20000 }, (_, i) => `new ${i}`);
		const started = performance.now();
		expect(lineChanges(before, after)).toEqual([{ kind: "modified", line: 1, endLine: 20000 }]);
		expect(performance.now() - started).toBeLessThan(1500);
		// And a long file with many small edits is still found, where the table would have had ten thousand million cells.
		const long = Array.from({ length: 100000 }, (_, i) => `row ${i % 977}`);
		const edited = long.slice();
		for (let i = 0; i < 200; i++) edited[i * 499 + 7] = `edit ${i}`;
		const again = performance.now();
		const changes = lineChanges(long, edited);
		expect(performance.now() - again).toBeLessThan(1500);
		expect(changes.length).toBe(200);
		expect(changes.every((change) => change.kind === "modified" && change.line === change.endLine)).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Names with letters outside A to Z in a schema
// ---------------------------------------------------------------------------------------------------------------

describe("4. CREATE TABLE with names in letters of any script", () => {
	const shape = (sql: string, options?: { includeStandaloneAlter?: boolean }) =>
		parseCreateTables(sql, options).map((table) => ({
			table: table.tableName,
			columns: table.columns.map((column) => `${column.name} ${column.type}${column.constraints ? ` ${column.constraints}` : ""}`),
			...(table.foreignKeys ? { foreignKeys: table.foreignKeys.map((fk) => `${fk.column} -> ${fk.refTable}(${fk.refColumn ?? ""})`) } : {}),
			...(table.indexes ? { indexes: table.indexes.map((index) => `${index.name}(${index.columns.join(", ")})`) } : {}),
		}));

	test("a table and its columns are read where they were left out without a word", () => {
		expect(shape("CREATE TABLE Prüfung (Größe INT, Länge DECIMAL(10,2) NOT NULL, Ñame NVARCHAR(10) DEFAULT N'é;');")).toEqual([
			{ table: "Prüfung", columns: ["Größe INT", "Länge DECIMAL(10,2) NOT NULL", "Ñame NVARCHAR(10) DEFAULT N'é;'"] },
		]);
		expect(shape("CREATE TABLE Таблица1 (Колонка٣ INT, 表 INT, 列_2 INT);")).toEqual([{ table: "Таблица1", columns: ["Колонка٣ INT", "表 INT", "列_2 INT"] }]);
		// The same name written with its marks apart (as some editors save it) is one name, not one cut at the mark.
		expect(shape("CREATE TABLE Pru\u0308fung (Gro\u0308ße INT)")[0]!.table.normalize("NFC")).toBe("Prüfung");
	});

	test("with a schema, keys, an index, later changes and a comment", () => {
		const sql = [
			"CREATE TABLE dbo.Prüfung (Größe INT NOT NULL, Länge INT, CONSTRAINT PK_Prüfung PRIMARY KEY (Größe));",
			"CREATE TABLE Messung (Id INT PRIMARY KEY, Prüf INT REFERENCES dbo.Prüfung (Größe), Gerät INT, CONSTRAINT FK_Gerät FOREIGN KEY (Gerät) REFERENCES Geräte (Nr));",
			"ALTER TABLE Messung ADD Bemerkung_Ä NVARCHAR(50) NULL;",
			"ALTER TABLE Messung ALTER COLUMN Gerät BIGINT NOT NULL;",
			"ALTER TABLE Messung DROP COLUMN Id;",
			"CREATE UNIQUE INDEX IX_Länge ON dbo.Prüfung (Länge DESC, Größe);",
			"COMMENT ON COLUMN Messung.Prüf IS 'die Prüfung';",
		].join("\n");
		const tables = parseCreateTables(sql);
		expect(shape(sql)).toEqual([
			{ table: "Prüfung", columns: ["Größe INT NOT NULL PRIMARY KEY", "Länge INT"], indexes: ["IX_Länge(Länge, Größe)"] },
			{ table: "Messung", columns: ["Prüf INT REFERENCES dbo.Prüfung (Größe)", "Gerät BIGINT NOT NULL", "Bemerkung_Ä NVARCHAR(50) NULL"], foreignKeys: ["Prüf -> Prüfung(Größe)", "Gerät -> Geräte(Nr)"] },
		]);
		expect(tables[1]!.columns[0]!.comment).toBe("die Prüfung");
		expect(shape("ALTER TABLE Übersicht ADD Zähler INT;", { includeStandaloneAlter: true })).toEqual([{ table: "Übersicht", columns: ["Zähler INT"] }]);
	});

	test("names in brackets, quotes and backticks are read as before, and so are plain ones", () => {
		expect(shape('CREATE TABLE [dbo].[Prüf Tabelle] ([Größe (mm)] INT, "Länge" INT, `ß` INT, a#b INT, c$d INT, _e INT);')).toEqual([
			{ table: "Prüf Tabelle", columns: ["Größe (mm) INT", "Länge INT", "ß INT", "a#b INT", "c$d INT", "_e INT"] },
		]);
		expect(shape("CREATE TABLE T (ID INT NOT NULL PRIMARY KEY, NAME VARCHAR(50) NULL, P INT REFERENCES P(ID));")).toEqual([
			{ table: "T", columns: ["ID INT NOT NULL PRIMARY KEY", "NAME VARCHAR(50) NULL", "P INT REFERENCES P(ID)"], foreignKeys: ["P -> P(ID)"] },
		]);
	});

	test("what is not schema is still left out: temporary tables, variables, and what is no letter", () => {
		expect(shape("CREATE TABLE #tmp (a INT);\nCREATE TABLE ##global (b INT);")).toEqual([]);
		// `²` and a dash are not letters: such a column is not one SQL Server or Oracle would take either.
		expect(shape("CREATE TABLE T (x² INT, a–b INT, ok INT)")).toEqual([{ table: "T", columns: ["ok INT"] }]);
	});

	test("the other readers of SQL take the same names", () => {
		expect(extractSqlObjects("CREATE TABLE Prüfung (Größe INT);\nCREATE VIEW Übersicht AS SELECT 1;\nCREATE TABLE #tmp (a INT);")).toEqual([
			{ name: "Prüfung", bareName: "Prüfung", kind: "table" },
			{ name: "Übersicht", bareName: "Übersicht", kind: "view" },
		]);
		expect(extractQueriedTablesFromSql("SELECT p.Größe FROM Prüfung p JOIN dbo.Messung m ON m.Prüf = p.Größe;\nSELECT * FROM emp@remote_db;\nSELECT * FROM #tmp;\nINSERT INTO @t SELECT 1 FROM Übersicht").map((hit) => hit.object)).toEqual([
			"Prüfung",
			"Messung",
			"emp",
			"Übersicht",
		]);
	});

	test("a schema page written from such tables, and SQL written back from the page, keep the names", () => {
		const sql = "CREATE TABLE Prüfung (Größe INT NOT NULL PRIMARY KEY);\nCREATE TABLE Messung (Id INT PRIMARY KEY, Prüf INT REFERENCES Prüfung (Größe));";
		const page = sqlTablesToMarkdown(parseCreateTables(sql));
		expect(page).toContain("## Prüfung");
		expect(page).toContain("| `Größe` | `INT` |");
		const back = schemaMarkdownToSql(page)!;
		expect(back.tables).toEqual(["Prüfung", "Messung"]);
		expect(back.sql).toContain("CREATE TABLE Prüfung (");
		expect(back.sql).toContain("REFERENCES Prüfung (Größe)");
		expect(shape(back.sql).map((table) => table.table)).toEqual(["Prüfung", "Messung"]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 5. The language server under vendor/
// ---------------------------------------------------------------------------------------------------------------

describe("5. bundle-lsp: the binary and its licence files arrive together or not at all", () => {
	const PIN = tools.LSP_PIN;
	/** No test here may reach the network: anything that tries fails. */
	const withoutNetwork = async <T>(work: () => Promise<T>): Promise<T> => {
		const real = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error("a test went to the network");
		}) as unknown as typeof fetch;
		try {
			return await work();
		} finally {
			globalThis.fetch = real;
		}
	};
	const listing = (dir: string) =>
		readdirSync(dir)
			.sort()
			.map((name) => `${name}=${readFileSync(join(dir, name), "utf8")}`);
	const executable = (path: string) => !posix || (statSync(path).mode & 0o111) !== 0;
	const vendorWith = (name: string, files: Record<string, string>) => {
		const dir = fresh(name);
		for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
		return dir;
	};
	const versions = (table: Record<string, string>) => async (path: string) => table[path];

	test("a vendored binary of another version is replaced from where the pinned one is", async () => {
		const vendorDir = vendorWith("stale-vendor", { "starlims-lsp": "OLD BINARY", "STARLIMS-LSP-LICENSE": "old licence", "THIRD-PARTY-NOTICES.md": "old notices" });
		const elsewhere = vendorWith("stale-elsewhere", { "starlims-lsp": "PINNED BINARY" });
		const repoDir = vendorWith("stale-repo", { LICENSE: "licence", "THIRD-PARTY-NOTICES.md": "notices" });
		const target = join(vendorDir, "starlims-lsp");
		chmodSync(target, 0o644);
		const asked: string[] = [];
		const result = await withoutNetwork(() =>
			bundle.bundleLsp({
				vendorDir,
				repoDir,
				platform: "linux",
				// The search for a language server looks in vendor/ first, and finds the old one.
				findLocal: async () => ({ ok: true, version: "0.30.0", path: target, message: "old" }),
				candidates: () => [target, join(base, "nowhere", "starlims-lsp"), join(elsewhere, "starlims-lsp")],
				getVersion: async (path) => {
					asked.push(path);
					return versions({ [target]: "0.30.0", [join(elsewhere, "starlims-lsp")]: PIN })(path);
				},
			}),
		);
		expect(result).toEqual({ target, action: "copied" });
		expect(listing(vendorDir)).toEqual(["STARLIMS-LSP-LICENSE=licence", "THIRD-PARTY-NOTICES.md=notices", "starlims-lsp=PINNED BINARY"]);
		expect(executable(target)).toBe(true);
		// vendor/'s own copy is asked once, for whether it will do, and not again among the other places.
		expect(asked).toEqual([target, join(base, "nowhere", "starlims-lsp"), join(elsewhere, "starlims-lsp")]);
	});

	test("with the pinned version nowhere, it says what it found and leaves vendor/ as it was", async () => {
		const vendorDir = vendorWith("none-vendor", { "starlims-lsp": "OLD BINARY", "STARLIMS-LSP-LICENSE": "old licence", "THIRD-PARTY-NOTICES.md": "old notices" });
		const target = join(vendorDir, "starlims-lsp");
		await expect(
			withoutNetwork(() =>
				bundle.bundleLsp({
					vendorDir,
					repoDir: fresh("none-repo"),
					platform: "linux",
					findLocal: async () => ({ ok: true, version: "0.30.0", path: target }),
					candidates: () => [target, join(base, "other", "starlims-lsp")],
					getVersion: async () => "0.30.0",
				}),
			),
		).rejects.toThrow(`No local starlims-lsp ${PIN} (found: 0.30.0). Use --download.`);
		expect(listing(vendorDir)).toEqual(["STARLIMS-LSP-LICENSE=old licence", "THIRD-PARTY-NOTICES.md=old notices", "starlims-lsp=OLD BINARY"]);
	});

	test("vendor/'s own pinned binary will do when only its licence files are wanting, whatever else is found first", async () => {
		const vendorDir = vendorWith("own-vendor", { "starlims-lsp": "PINNED BINARY" });
		const repoDir = vendorWith("own-repo", { LICENSE: "licence", "THIRD-PARTY-NOTICES.md": "notices" });
		const target = join(vendorDir, "starlims-lsp");
		chmodSync(target, 0o644);
		const result = await withoutNetwork(() =>
			bundle.bundleLsp({
				vendorDir,
				repoDir,
				platform: "linux",
				findLocal: async () => ({ ok: true, version: "dev", path: join(base, "a-developer-build") }),
				candidates: () => [],
				getVersion: versions({ [target]: PIN }),
			}),
		);
		expect(result.action).toBe("copied");
		expect(listing(vendorDir)).toEqual(["STARLIMS-LSP-LICENSE=licence", "THIRD-PARTY-NOTICES.md=notices", "starlims-lsp=PINNED BINARY"]);
		expect(executable(target)).toBe(true);
	});

	test("a local copy whose licence files cannot be found is not put in place", async () => {
		const vendorDir = fresh("nolicence-vendor");
		const elsewhere = vendorWith("nolicence-elsewhere", { "starlims-lsp": "PINNED BINARY" });
		await expect(
			withoutNetwork(() =>
				bundle.bundleLsp({
					vendorDir,
					repoDir: fresh("nolicence-repo"),
					platform: "linux",
					findLocal: async () => ({ ok: true, version: PIN, path: join(elsewhere, "starlims-lsp") }),
					getVersion: async () => undefined,
				}),
			),
		).rejects.toThrow(/Missing required .*STARLIMS-LSP-LICENSE.*THIRD-PARTY-NOTICES\.md/);
		expect(readdirSync(vendorDir)).toEqual([]);
	});

	test("a download puts the three files in place together, the binary ready to run", async () => {
		const vendorDir = vendorWith("download-vendor", { "starlims-lsp": "OLD BINARY" });
		const fetched: string[] = [];
		const result = await withoutNetwork(() =>
			bundle.bundleLsp({
				vendorDir,
				download: true,
				platform: "linux",
				arch: "x64",
				fetchTo: async (url, path) => {
					fetched.push(url);
					// Nothing is where it goes until all of it has arrived.
					expect(listing(vendorDir).filter((entry) => !entry.includes(".new="))).toEqual(["starlims-lsp=OLD BINARY"]);
					writeFileSync(path, url.endsWith("/LICENSE") ? "licence" : url.endsWith("NOTICES.md") ? "notices" : "NEW BINARY");
				},
			}),
		);
		expect(result).toEqual({ target: join(vendorDir, "starlims-lsp"), action: "downloaded" });
		expect(fetched).toEqual([
			`https://github.com/mahoskye/starlims-lsp/releases/download/v${PIN}/starlims-lsp-linux-amd64`,
			`https://github.com/mahoskye/starlims-lsp/releases/download/v${PIN}/THIRD-PARTY-NOTICES.md`,
			`https://raw.githubusercontent.com/mahoskye/starlims-lsp/v${PIN}/LICENSE`,
		]);
		expect(listing(vendorDir)).toEqual(["STARLIMS-LSP-LICENSE=licence", "THIRD-PARTY-NOTICES.md=notices", "starlims-lsp=NEW BINARY"]);
		expect(executable(result.target)).toBe(true);
	});

	test("a download that breaks off leaves vendor/ as it was: the old files whole, or nothing", async () => {
		for (const failAt of [1, 2, 3]) {
			for (const had of [{}, { "starlims-lsp": "OLD BINARY", "STARLIMS-LSP-LICENSE": "old licence", "THIRD-PARTY-NOTICES.md": "old notices" }] as Record<string, string>[]) {
				const vendorDir = vendorWith(`broken-${failAt}-${Object.keys(had).length}`, had);
				if (had["starlims-lsp"]) chmodSync(join(vendorDir, "starlims-lsp"), 0o755);
				const before = listing(vendorDir);
				let calls = 0;
				await expect(
					withoutNetwork(() =>
						bundle.bundleLsp({
							vendorDir,
							download: true,
							platform: "linux",
							fetchTo: async (url, path) => {
								if (++calls === failAt) {
									// Part of it had arrived when the connection went.
									writeFileSync(path, "PART");
									throw new Error(`${url}: 503`);
								}
								writeFileSync(path, "WHOLE");
							},
						}),
					),
				).rejects.toThrow(/: 503$/);
				expect(listing(vendorDir)).toEqual(before);
				if (had["starlims-lsp"]) expect(executable(join(vendorDir, "starlims-lsp"))).toBe(true);
			}
		}
	});

	test("an answer with nothing in it is not a file", async () => {
		const vendorDir = fresh("empty-download");
		await expect(
			withoutNetwork(() =>
				bundle.bundleLsp({
					vendorDir,
					download: true,
					platform: "linux",
					fetchTo: async (url, path) => writeFileSync(path, url.endsWith("NOTICES.md") ? "" : "x"),
				}),
			),
		).rejects.toThrow(/Nothing arrived for .*THIRD-PARTY-NOTICES\.md/);
		expect(readdirSync(vendorDir)).toEqual([]);
	});
});

describe("5. tools: what cannot be started is not a language server", () => {
	test("a file without its execute bit, a folder and a name that is not there cannot be started", () => {
		const dir = fresh("runnable");
		const program = join(dir, "starlims-lsp");
		writeFileSync(program, "#!/bin/sh\necho ok\n");
		chmodSync(program, 0o644);
		expect(tools.runnable(program, "linux")).toBe(!posix);
		// Windows has no such bit: a file is enough there.
		expect(tools.runnable(program, "win32")).toBe(true);
		chmodSync(program, 0o755);
		expect(tools.runnable(program, "linux")).toBe(true);
		expect(tools.runnable(dir, "linux")).toBe(false);
		expect(tools.runnable(dir, "win32")).toBe(false);
		expect(tools.runnable(join(dir, "missing"), "linux")).toBe(false);
	});

	test.skipIf(!posix)("the search passes over one that says the right version but cannot be started", async () => {
		const dir = fresh("find");
		const program = join(dir, "starlims-lsp");
		writeFileSync(program, `#!/bin/sh\necho "starlims-lsp version ${tools.LSP_PIN}"\n`);
		chmodSync(program, 0o644);
		expect((await tools.findLsp(program)).path).not.toBe(program);
		chmodSync(program, 0o755);
		expect(await tools.findLsp(program)).toEqual({ ok: true, version: tools.LSP_PIN, path: program, message: undefined });
	});

	test("the commands of the earlier rounds are built as they were", () => {
		expect(tools.lspCommand("/opt/tools/starlims-lsp", ["--version"], "linux")).toEqual(["/opt/tools/starlims-lsp", "--version"]);
		expect(tools.lspCommand("C:\\Tools\\starlims-lsp.cmd", ["--version"], "win32")).toEqual(["cmd.exe", "/d", "/s", "/c", "C:\\Tools\\starlims-lsp.cmd", "--version"]);
		const spaced = tools.shimCommand("C:\\Program Files\\tool\\opencode.cmd", ["--version"]);
		expect(spaced).toEqual(["cmd.exe", "/d", "/s", "/c", '""C:\\Program Files\\tool\\opencode.cmd" --version"']);
		expect(tools.verbatim(spaced, "win32")).toBe(true);
		expect(tools.verbatim(spaced, "linux")).toBe(false);
		expect(tools.opencodeCommand(["--version"]).at(-1)).toBe("--version");
	});
});
