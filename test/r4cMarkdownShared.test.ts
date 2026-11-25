import { describe, expect, test } from "bun:test";
import {
	fileLinks,
	frontPaths,
	linkLeads,
	ownLinkEdits,
	rewriteHeadingReferences,
	withLinkFile,
	withLinkFiles,
} from "../src/shared/docLinks";
import {
	addToFrontMatterList,
	formatFrontMatterInnerReplacement,
	frontMatter,
	frontMatterInnerSpan,
	quoteYamlScalar,
	removeFromFrontMatterList,
	replaceInFrontMatterList,
	summaryOf,
	titleOf,
	withFrontMatter,
} from "../src/shared/frontMatter";
import { closedHtmlCommentSpans, isStandaloneHtmlComment } from "../src/shared/htmlComments";
import { decodeHtmlEntities, htmlToMarkdown, looksLikeRichHtml } from "../src/shared/htmlToMarkdown";
import { parseListLine } from "../src/shared/listIndent";
import {
	documentHeadings,
	findHeadingLine,
	markdownStats,
	parseImageExpression,
	smartListBackspace,
	smartListIndent,
	toggleCheckboxLine,
	toggleInlineWrap,
	upsertTocBlock,
	withImageWidth,
} from "../src/shared/markdownEdit";
import {
	cellRangeInLine,
	cellValueForEdit,
	locateTableCell,
	serializeTableCell,
	splitTableRow,
} from "../src/shared/markdownTables";
import { isInside, relativeTo } from "../src/shared/paths";

const applyEdit = (text: string, edit: ReturnType<typeof toggleInlineWrap>) =>
	text.slice(0, edit.changeFrom) + edit.insert + text.slice(edit.changeTo);

describe("Round 4C — paths.ts containment & traversal hardening", () => {
	test("isInside collapses . and .. segments so path traversal returns false", () => {
		expect(isInside("/repo", "/repo/../../etc/passwd")).toBe(false);
		expect(isInside("/repo", "/repo/sub/../../etc/passwd")).toBe(false);
		expect(isInside("/repo", "/repo/..")).toBe(false);
		expect(isInside("/repo", "/repo/a/./b/../c.md")).toBe(true);
		expect(isInside("/repo", "/repo/.")).toBe(true);
		expect(isInside("/repo/sub/..", "/repo/file.md")).toBe(true);
		expect(isInside("C:\\Work\\Scripts", "C:\\Work\\Scripts\\..\\..\\Windows\\System32")).toBe(false);
		expect(isInside("C:\\Work\\Scripts", "c:/work/scripts/./sub/../x.ssl")).toBe(true);
		expect(isInside("", "/etc/passwd")).toBe(false);
		expect(isInside("/", "/etc/passwd")).toBe(true);
		expect(relativeTo("/repo", "/repo/../../etc/passwd")).toBe("/repo/../../etc/passwd");
	});
});

describe("Round 4C — htmlComments.ts linear scanner & prose protection", () => {
	test("rejects prose sandwiched between HTML comments and leading newlines", () => {
		expect(isStandaloneHtmlComment("<!-- a --> PROSE <!-- b -->")).toBe(false);
		expect(isStandaloneHtmlComment("<!-- a -->\nPROSE\n<!-- b -->")).toBe(false);
		expect(isStandaloneHtmlComment("\n<!-- a -->")).toBe(false);
		expect(isStandaloneHtmlComment("  \t<!-- a -->\r\n<!-- b -->  \n")).toBe(true);
	});

	test("handles adversarial repeated comments in linear time (no ReDoS)", () => {
		const payload = "<!---->".repeat(100) + "x";
		const t0 = performance.now();
		expect(isStandaloneHtmlComment(payload)).toBe(false);
		expect(performance.now() - t0).toBeLessThan(5);

		const unclosed = "<!--".repeat(2000);
		const t1 = performance.now();
		expect(closedHtmlCommentSpans(unclosed)).toEqual([]);
		expect(performance.now() - t1).toBeLessThan(20);
	});
});

describe("Round 4C — htmlToMarkdown.ts safety, nesting, and single-pass decoding", () => {
	test("decodeHtmlEntities guards out-of-range code points and prototype properties", () => {
		expect(decodeHtmlEntities("&#9999999;")).toBe("&#9999999;");
		expect(decodeHtmlEntities("&#x110000;")).toBe("&#x110000;");
		expect(decodeHtmlEntities("&#0;")).toBe("&#0;");
		expect(decodeHtmlEntities("&constructor;")).toBe("&constructor;");
		expect(decodeHtmlEntities("&toString;")).toBe("&toString;");
		expect(decodeHtmlEntities("&__proto__;")).toBe("&__proto__;");
		expect(decodeHtmlEntities("&#x1F600;")).toBe("😀");
	});

	test("rejects javascript:, vbscript:, and data: URLs on both <a> and <img> even with entity/control-char obfuscation", () => {
		expect(htmlToMarkdown('<a href="javascript:alert(1)">Click</a>')).toBe("Click");
		expect(htmlToMarkdown('<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;:alert(1)">Click</a>')).toBe("Click");
		expect(htmlToMarkdown('<a href="  java&#x09;script:alert(1)">Click</a>')).toBe("Click");
		expect(htmlToMarkdown('<a href="vbscript:msgbox(1)">Run</a>')).toBe("Run");
		expect(htmlToMarkdown('<a href="data:text/html,<script>alert(1)</script>">Payload</a>')).toBe("Payload");
		expect(htmlToMarkdown('<img src="javascript:alert(1)" alt="Diagram">')).toBe("[Image: Diagram]");
		expect(htmlToMarkdown('<img src="  &#x6a;avascript:alert(1)">')).toBe("");
		expect(htmlToMarkdown('<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="Icon">')).toBe("[Image: Icon]");
		expect(htmlToMarkdown('<a href="https://example.com/doc">Doc</a>')).toBe("[Doc](https://example.com/doc)");
		expect(htmlToMarkdown('<img src="assets/diagram.png" alt="Flow">')).toBe("![Flow](assets/diagram.png)");
	});

	test("preserves nested lists, blockquotes, and details via balanced tag matching", () => {
		expect(htmlToMarkdown("<ul><li>A<ul><li>B</li></ul></li><li>C</li></ul>")).toBe("- A\n  - B\n- C");
		expect(htmlToMarkdown("<ol><li>First<ol><li>Sub 1</li><li>Sub 2</li></ol></li><li>Second</li></ol>")).toBe(
			"1. First\n  1. Sub 1\n  2. Sub 2\n2. Second",
		);
		expect(htmlToMarkdown("<ul><li>A<ul><li>B<ul><li>C</li></ul></li><li>D</li></ul></li><li>E</li></ul>")).toBe(
			"- A\n  - B\n    - C\n  - D\n- E",
		);
		const bq = htmlToMarkdown("<blockquote><p>Outer</p><blockquote><p>Inner</p></blockquote><p>After</p></blockquote>");
		expect(bq).toContain("> Outer");
		expect(bq).toContain("> > Inner");
		expect(bq).toContain("> After");

		const det = htmlToMarkdown(
			"<details><summary>Outer</summary><p>Intro</p><details><summary>Inner</summary><p>Body</p></details><p>Outro</p></details>",
		);
		expect(det).toContain("<summary>Outer</summary>");
		expect(det).toContain("Intro");
		expect(det).toContain("<summary>Inner</summary>");
		expect(det).toContain("Body");
		expect(det).toContain("Outro");
	});

	test("strips </script > and </style > with whitespace before >", () => {
		expect(htmlToMarkdown("<p>Safe</p><script>alert(1)</script ><style>body{color:red}</style \t>")).toBe("Safe");
		expect(looksLikeRichHtml("<style><b>ignored</b></style ><script><strong>no</strong></script ><div>plain</div>")).toBe(false);
	});

	test("does not double-decode HTML entities or strip decoded tags across recursive inline passes", () => {
		expect(htmlToMarkdown("<strong>&lt;div&gt;</strong>")).toBe("**<div>**");
		expect(htmlToMarkdown("<p>&amp;lt;b&amp;gt;</p>")).toBe("&lt;b&gt;");
		expect(htmlToMarkdown("<strong>&amp;lt;b&amp;gt;</strong>")).toBe("**&lt;b&gt;**");
		expect(htmlToMarkdown("<strong><em>&lt;span&gt;</em></strong>")).toBe("***<span>***");
		expect(htmlToMarkdown('<a href="https://example.com">https://example.com</a>')).toBe("<https://example.com>");
		expect(htmlToMarkdown('<strong><a href="https://example.com">Spec</a></strong>')).toBe("**[Spec](https://example.com)**");
	});
});

describe("Round 4C — markdownTables.ts GFM §4.10 pipes, backslash parity, and borderless ranges", () => {
	test("serializeTableCell escapes every unescaped pipe including inside backticks and respects backslash parity", () => {
		expect(serializeTableCell("`a | b`")).toBe("`a \\| b`");
		expect(serializeTableCell("Line 1\nLine 2 | `a | b`")).toBe("Line 1<br>Line 2 \\| `a \\| b`");
		expect(cellValueForEdit(serializeTableCell("Line 1\nLine 2 | `a | b`"))).toBe("Line 1\nLine 2 | `a | b`");
		// Even backslashes before `|` -> pipe is unescaped and must be escaped.
		expect(serializeTableCell("a\\\\|b")).toBe("a\\\\\\|b");
		// Odd backslash before `|` -> already escaped.
		expect(serializeTableCell("a\\|b")).toBe("a\\|b");
	});

	test("splitTableRow, locateTableCell, and cellRangeInLine honor GFM §4.10 pipe rules and borderless rows", () => {
		expect(splitTableRow("| `a \\| b` | x \\| y | plain |")).toEqual(["`a \\| b`", "x \\| y", "plain"]);
		expect(splitTableRow("| `unclosed | col2 |")).toEqual(["`unclosed", "col2"]);
		expect(splitTableRow("| \\`escaped | col2 |")).toEqual(["\\`escaped", "col2"]);
		expect(splitTableRow("| a\\\\| b |")).toEqual(["a\\\\", "b"]);
		expect(splitTableRow("| a\\\\\\| b |")).toEqual(["a\\\\\\| b"]);
		expect(splitTableRow("| a \\|")).toEqual(["a \\|"]);

		const bordered = "| Alpha | `a \\| b` | `unclosed | End |";
		expect(locateTableCell(bordered, 3, 4)).toBe(0);
		expect(locateTableCell(bordered, 15, 4)).toBe(1);
		expect(locateTableCell(bordered, 24, 4)).toBe(2);
		expect(locateTableCell(bordered, 35, 4)).toBe(3);

		const borderless = "Col1 | Col2 | Col3";
		expect(splitTableRow(borderless)).toEqual(["Col1", "Col2", "Col3"]);
		expect(locateTableCell(borderless, 2, 3)).toBe(0);
		expect(locateTableCell(borderless, 8, 3)).toBe(1);
		expect(locateTableCell(borderless, 15, 3)).toBe(2);

		const r0 = cellRangeInLine(borderless, 0);
		const r1 = cellRangeInLine(borderless, 1);
		const r2 = cellRangeInLine(borderless, 2);
		expect(borderless.slice(r0.from, r0.to)).toBe("Col1");
		expect(borderless.slice(r1.from, r1.to)).toBe("Col2");
		expect(borderless.slice(r2.from, r2.to)).toBe("Col3");

		const quotedBorderless = "> Left | Right";
		const q0 = cellRangeInLine(quotedBorderless, 0, "> ");
		const q1 = cellRangeInLine(quotedBorderless, 1, "> ");
		expect(quotedBorderless.slice(q0.from, q0.to)).toBe("Left");
		expect(quotedBorderless.slice(q1.from, q1.to)).toBe("Right");
	});
});

describe("Round 4C — frontMatter.ts YAML round-trip, BOM/template insertion, unclosed fences, and code skipping", () => {
	test("quoteYamlScalar quotes leading #, bracketed scalars, and quoted strings cleanly", () => {
		for (const raw of ["#1234", "[Draft] and [Final]", "[v1, v2]", '"Quoted"', "'Single'"]) {
			const quoted = quoteYamlScalar(raw);
			expect(quoted.startsWith('"')).toBe(true);
			const doc = withFrontMatter("# Body\n", "title", raw)!;
			expect(frontMatter(doc).values.title).toBe(raw);
		}
	});

	test("withFrontMatter returns null on unclosed --- and inserts after BOM and <!-- template --> comments", () => {
		expect(withFrontMatter("---\ntitle: broken\n# never closed\n", "status", "open")).toBeNull();

		const bomDoc = "\uFEFF# Heading\n";
		const withBom = withFrontMatter(bomDoc, "status", "open")!;
		expect(withBom.startsWith("\uFEFF---\nstatus: open\n---\n\n# Heading\n")).toBe(true);
		expect(frontMatter(withBom).values.status).toBe("open");

		const tplDoc = '<!-- template: name="Spec" -->\n# Heading\n';
		const withTpl = withFrontMatter(tplDoc, "status", "draft")!;
		expect(withTpl).toBe('<!-- template: name="Spec" -->\n---\nstatus: draft\n---\n\n# Heading\n');
		expect(frontMatter(withTpl).values.status).toBe("draft");

		const bomTpl = '\uFEFF<!-- template: name="Spec" -->\n\n# Heading\n';
		const withBomTpl = withFrontMatter(bomTpl, "status", "draft")!;
		expect(withBomTpl).toBe('\uFEFF<!-- template: name="Spec" -->\n---\nstatus: draft\n---\n\n# Heading\n');
	});

	test("list mutators do not split a single quoted scalar containing a comma", () => {
		const doc = '---\nspecs: "docs/v1,2.md"\n---\n\n# Body\n';
		expect(addToFrontMatterList(doc, "specs", "docs/v1,2.md")).toBe(doc);

		const added = addToFrontMatterList(doc, "specs", "docs/v3.md")!;
		expect(frontMatter(added).values.specs).toEqual(["docs/v1,2.md", "docs/v3.md"]);

		const replaced = replaceInFrontMatterList(doc, "specs", "docs/v1,2.md", "docs/v4,5.md")!;
		expect(frontMatter(replaced).values.specs).toBe("docs/v4,5.md");
		expect(addToFrontMatterList(replaced, "specs", "docs/v6.md")).toContain('["docs/v4,5.md", docs/v6.md]');

		const removed = removeFromFrontMatterList(doc, "specs", "docs/v1,2.md")!;
		expect(frontMatter(removed).values.specs).toBeUndefined();
	});

	test("formatFrontMatterInnerReplacement preserves trailing newlines when pressing Enter in YAML editor", () => {
		const lf = "---\nticket: DEMO-1\n---\n\n# Body\n";
		const span = frontMatterInnerSpan(lf)!;
		const afterEnter = lf.slice(0, span.start) + formatFrontMatterInnerReplacement("ticket: DEMO-1\n", span.eol) + lf.slice(span.end);
		expect(afterEnter).toBe("---\nticket: DEMO-1\n\n---\n\n# Body\n");
		expect(frontMatterInnerSpan(afterEnter)?.inner).toBe("ticket: DEMO-1\n");

		const crlf = "---\r\nticket: DEMO-1\r\n---\r\n# Body\r\n";
		const cSpan = frontMatterInnerSpan(crlf)!;
		const cAfter = crlf.slice(0, cSpan.start) + formatFrontMatterInnerReplacement("ticket: DEMO-1\n", cSpan.eol) + crlf.slice(cSpan.end);
		expect(cAfter).toBe("---\r\nticket: DEMO-1\r\n\r\n---\r\n# Body\r\n");
		expect(frontMatterInnerSpan(cAfter)?.inner).toBe("ticket: DEMO-1\n");
	});

	test("titleOf and summaryOf skip fenced code blocks including comments and blank-line splits", () => {
		const md = [
			"```bash",
			"# Install deps",
			"bun install",
			"",
			"echo second block inside fence",
			"```",
			"",
			"# Real Title",
			"",
			"Actual summary sentence. More details.",
		].join("\n");
		expect(titleOf(md)).toBe("Real Title");
		expect(summaryOf(md)).toBe("Actual summary sentence.");

		expect(titleOf("```sh\n# Only comment\n```\n")).toBe("");
		expect(summaryOf("# Title\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n")).toBe("");
	});
});

describe("Round 4C — docLinks.ts traversal, label safety, heading rewrites, comments, escapes, and Windows moves", () => {
	test("linkLeads blocks leading-slash traversal outside workspace root", () => {
		expect(linkLeads("/../../../etc/passwd", "/repo/docs/a.md", "/repo")).toBeNull();
		expect(linkLeads("/docs/../../etc/passwd", "/repo/docs/a.md", "/repo")).toBeNull();
		expect(linkLeads("/docs/specs/Due.md", "/repo/docs/a.md", "/repo")).toEqual({ file: "/repo/docs/specs/Due.md" });
	});

	test("withLinkFile without column never clobbers link labels or prose", () => {
		expect(withLinkFile("[old.md](old.md)\n", 1, "old.md", "new.md")).toBe("[old.md](new.md)\n");
		expect(withLinkFile("old.md is at [old.md](old.md)\n", 1, "old.md", "new.md")).toBe("old.md is at [old.md](new.md)\n");
		expect(withLinkFile("[old.md](other.md)\n", 1, "old.md", "new.md")).toBeNull();
		expect(withLinkFile("See [[old.md|old.md]]\n", 1, "old.md", "new.md")).toBe("See [[new.md|old.md]]\n");
	});

	test("rewriteHeadingReferences handles CommonMark code spans, inline triple backticks, parens, angle brackets, and titles", () => {
		const md = [
			"````inline```` and [first](#old-head)",
			"```inline``` and [second](#old-head)",
			"Code ``x ` [skip](#old-head)`` and [real](#old-head)",
			'Links: [paren](foo_(bar).md#old-head), [angle](<my file.md#old-head>), [titled](spec.md#old-head "Title"), [atitled](<my file.md#old-head> \'Sub\'), [same](#old-head (Note)).',
		].join("\n");
		const res = rewriteHeadingReferences(md, {
			isSameDoc: true,
			matchesDocHref: (p) => p === "foo_(bar).md" || p === "my file.md" || p === "spec.md",
			matchesWikiTarget: () => false,
			oldHeading: "Old Head",
			oldAnchor: "old-head",
			newHeading: "New Head",
			newAnchor: "new-head",
		});
		expect(res.count).toBe(8);
		expect(res.text).toContain("[first](#new-head)");
		expect(res.text).toContain("[second](#new-head)");
		expect(res.text).toContain("``x ` [skip](#old-head)`` and [real](#new-head)");
		expect(res.text).toContain("[paren](foo_(bar).md#new-head)");
		expect(res.text).toContain("[angle](<my file.md#new-head>)");
		expect(res.text).toContain('[titled](spec.md#new-head "Title")');
		expect(res.text).toContain("[atitled](<my file.md#new-head> 'Sub')");
		expect(res.text).toContain("[same](#new-head (Note))");
	});

	test("frontPaths strips outside-quote YAML comments while keeping # inside quotes and names", () => {
		const md = [
			"---",
			"specs: [docs/a.md, \"docs/Issue #12.md\"] # trailing list comment",
			"plan: docs/C#.md # inline comment",
			"plans: # key comment",
			"  - docs/p1.plan.json # item comment",
			"---",
			"",
			"Body",
		].join("\n");
		expect(frontPaths(md).map((p) => p.value)).toEqual([
			"docs/a.md",
			"docs/Issue #12.md",
			"docs/C#.md",
			"docs/p1.plan.json",
		]);
	});

	test("fileLinks locates raw backslash-escaped destinations via hrefWritten", () => {
		const md = "See [spec](foo\\(1\\).md) and `[fake](foo\\(1\\).md)`.\n";
		const links = fileLinks(md);
		expect(links).toEqual([{ href: "foo\\(1\\).md", file: "foo(1).md", line: 1, column: 11 }]);
		const updated = withLinkFile(md, links[0]!.line, links[0]!.href, "bar(1).md", links[0]!.column);
		expect(updated).toBe("See [spec](bar%281%29.md) and `[fake](foo\\(1\\).md)`.\n");
	});

	test("ownLinkEdits trims trailing slashes and normalizes Windows slashes/casing on folder moves", () => {
		const md = "See [sibling](sub/B.md) and [outside](../../specs/S.md).\n";
		// Trailing slash on m.from must never drop `/` when joining m.to + suffix.
		const posixEdits = ownLinkEdits(md, "/ws/docs/old/A.md", "/ws/docs/archive/old/A.md", {
			from: "/ws/docs/old/",
			to: "/ws/docs/archive/old",
		});
		expect(posixEdits.map((e) => [e.href, e.instead])).toEqual([["../../specs/S.md", "../../../specs/S.md"]]);

		// Mixed-case Windows paths and mixed `/` vs `\` separators.
		const winEdits = ownLinkEdits(md, "c:/ws/docs/old/A.md", "c:/ws/docs/archive/old/A.md", {
			from: "C:\\WS\\Docs\\Old\\",
			to: "C:\\WS\\Docs\\Archive\\Old\\",
		});
		expect(winEdits.map((e) => [e.href, e.instead])).toEqual([["../../specs/S.md", "../../../specs/S.md"]]);
		const applied = withLinkFiles(md, winEdits);
		expect(applied.text).toBe("See [sibling](sub/B.md) and [outside](../../../specs/S.md).\n");
	});
});

describe("Round 4C — listIndent.ts & markdownEdit.ts ReDoS, checkboxes, headings, TOC, wraps, images, and fences", () => {
	test("linear blockquote scanning prevents ReDoS on 50 nested quotes", () => {
		const evil = "> ".repeat(50) + "plain";
		const t0 = performance.now();
		expect(parseListLine(evil)).toBeNull();
		expect(toggleCheckboxLine(evil)).toBe(`${"> ".repeat(50)}- [ ] plain`);
		expect(smartListIndent(evil, "indent")).toBeNull();
		expect(smartListBackspace(evil, evil.length)).toBeNull();
		expect(performance.now() - t0).toBeLessThan(20);
	});

	test("- [x](url) is never misclassified or mutated as a task checkbox", () => {
		const line = "- [x](https://example.com)";
		const info = parseListLine(line);
		expect(info).not.toBeNull();
		expect(info!.kind).toBe("bullet");
		expect(info!.bracketOffset).toBeUndefined();
		expect(toggleCheckboxLine(line)).toBe("- [ ] [x](https://example.com)");
	});

	test("listIndent recognizes blockquoted horizontal rules as rules, not bullets", () => {
		expect(parseListLine("> - - -")).toBeNull();
		expect(parseListLine("> > * * *")).toBeNull();
		expect(parseListLine("> ---")).toBeNull();
		expect(parseListLine("> - Real bullet")?.kind).toBe("bullet");
	});

	test("documentHeadings preserves trailing # in C# and strips Markdown syntax before computing anchors", () => {
		const md = ["## Using C#", "## Using F# ##", "## See [Spec](spec.md) and **bold**"].join("\n");
		expect(documentHeadings(md)).toEqual([
			{ level: 2, text: "Using C#", anchor: "using-c", line: 1 },
			{ level: 2, text: "Using F#", anchor: "using-f", line: 2 },
			{ level: 2, text: "See [Spec](spec.md) and **bold**", anchor: "see-spec-and-bold", line: 3 },
		]);
		expect(findHeadingLine(md, "see-spec-and-bold")).toBe(3);
		expect(findHeadingLine(md, "See Spec and bold")).toBe(3);
	});

	test("upsertTocBlock ignores <!-- toc --> examples inside fenced code blocks and inline prose", () => {
		const md = [
			"# Guide",
			"",
			"Write `<!-- toc -->` and `<!-- /toc -->` to place a TOC:",
			"",
			"```md",
			"<!-- toc -->",
			"<!-- /toc -->",
			"```",
			"",
			"## Setup",
			"",
			"## Usage",
		].join("\n");
		const res = upsertTocBlock(md);
		expect(res.updated).toBe(true);
		// Code example stays verbatim and a real TOC is inserted after H1.
		expect(res.text).toContain("```md\n<!-- toc -->\n<!-- /toc -->\n```");
		expect(res.text).toContain("# Guide\n\n<!-- toc -->\n\n- [Setup](#setup)\n- [Usage](#usage)\n\n<!-- /toc -->");
	});

	test("toggleInlineWrap unwraps ***word*** with * cleanly and never corrupts **a** and **b**", () => {
		expect(applyEdit("***word***", toggleInlineWrap("***word***", 0, 10, "*"))).toBe("**word**");
		expect(applyEdit("***word***", toggleInlineWrap("***word***", 3, 7, "*"))).toBe("**word**");
		expect(applyEdit("**word**", toggleInlineWrap("**word**", 0, 8, "*"))).toBe("***word***");

		const multiOuter = applyEdit("**a** and **b**", toggleInlineWrap("**a** and **b**", 0, 15, "**"));
		expect(multiOuter).not.toBe("a** and **b");
		const multiInner = applyEdit("**a** and **b**", toggleInlineWrap("**a** and **b**", 2, 13, "**"));
		expect(multiInner).not.toBe("a** and **b");
	});

	test("parseImageExpression and withImageWidth handle parenthesized URLs, angle brackets, and image titles", () => {
		expect(parseImageExpression("![Fig](fig_(1).png)")).toMatchObject({ src: "fig_(1).png", alt: "Fig", kind: "md" });
		expect(withImageWidth("![Fig](fig_(1).png)", 300)).toBe("![Fig|300](fig_(1).png)");

		expect(parseImageExpression("![Fig](<my fig.png>)")).toMatchObject({ src: "my fig.png", alt: "Fig", kind: "md" });
		expect(withImageWidth("![Fig](<my fig.png>)", 300)).toBe("![Fig|300](<my fig.png>)");

		expect(parseImageExpression('![Fig](fig.png "Fig 1")')).toMatchObject({ src: "fig.png", alt: "Fig", title: "Fig 1", kind: "md" });
		expect(withImageWidth('![Fig](fig.png "Fig 1")', 300)).toBe('![Fig|300](fig.png "Fig 1")');
		expect(withImageWidth('![Fig|300](fig.png "Fig 1")', null)).toBe('![Fig](fig.png "Fig 1")');

		expect(withImageWidth('![Fig](<my fig (1).png> "Fig 1")', 420)).toBe('![Fig|420](<my fig (1).png> "Fig 1")');
	});

	test("markdownStats rejects backticks in backtick-fence info strings so inline triple-backtick code never opens a phantom fence", () => {
		const md = ["```inline``` is a code span", "", "- [x] First task", "- [ ] Second task"].join("\n");
		const stats = markdownStats(md);
		expect(stats.tasksDone).toBe(1);
		expect(stats.tasksTotal).toBe(2);
		expect(stats.words).toBeGreaterThanOrEqual(8);
	});
});
