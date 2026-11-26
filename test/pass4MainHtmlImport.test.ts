// Two main findings of the pass 4 audit in pasted and imported HTML (H3, P4): a code block that stands inside
// something else (a table cell, a heading, a list item, a quotation, a link). Each test hands a page to
// `htmlToMarkdown`, as a paste, a dropped file and a ticket import do, and reads the Markdown back with the two
// readers the app has: marked (the rendered views) and lezer (the editor's own tree).
import { describe, expect, test } from "bun:test";
import { GFM, parser as lezerParser } from "@lezer/markdown";
import { marked, type Token } from "marked";
import { looksBinary } from "../src/shared/fileKind";
import { htmlToMarkdown } from "../src/shared/htmlToMarkdown";

const lezer = lezerParser.configure(GFM);
const render = (md: string) => (marked.parse(md, { async: false, gfm: true }) as string).replace(/\n/g, "");
const one = (text: string) => text.replace(/\s+/g, " ").trim();

/** Every piece of HTML that marked finds in the Markdown, block or inline, however deep. */
function htmlOfMarked(tokens: Token[], out: string[] = []): string[] {
	for (const token of tokens as any[]) {
		if (token.type === "html") out.push(token.raw);
		if (token.tokens) htmlOfMarked(token.tokens, out);
		if (token.items) htmlOfMarked(token.items, out);
		for (const cell of token.header ?? []) htmlOfMarked(cell.tokens, out);
		for (const row of token.rows ?? []) for (const cell of row) htmlOfMarked(cell.tokens, out);
	}
	return out;
}

/**
 * Every piece of HTML that lezer finds, and the names of the blocks at the top of the document with their text.
 *
 * One thing is set right here. lezer keeps an HTML block that stands in a quotation open over the quotation's empty
 * lines (it asks whether the whole line is empty, ">" and all), where CommonMark and marked end it there. The app
 * does not draw from that node, so what counts is the block as CommonMark has it: up to the first such line.
 */
function readByLezer(md: string): { html: string[]; top: { name: string; text: string }[] } {
	const tree = lezer.parse(md);
	const html: string[] = [];
	const cursor = tree.cursor();
	do {
		if (/^(HTMLBlock|HTMLTag|Comment|CommentBlock|ProcessingInstruction|ProcessingInstructionBlock)$/.test(cursor.name)) html.push(md.slice(cursor.from, cursor.to).split(/\n[ \t>]*(?=\n|$)/)[0]!);
	} while (cursor.next());
	const top: { name: string; text: string }[] = [];
	for (let node = tree.topNode.firstChild; node; node = node.nextSibling) top.push({ name: node.name, text: md.slice(node.from, node.to) });
	return { html, top };
}

describe("H3. a code block inside a table cell, a heading or a summary is kept, and no NUL is written", () => {
	test("a table from a wiki page with a code sample in a cell: the code is there, and the file is text", () => {
		// What Chromium puts on the clipboard for such a selection (the auditor's page, with SSL written for this test).
		const html = `<meta charset='utf-8'><table><thead><tr><th>Step</th><th>Script</th></tr></thead><tbody>
<tr><td>1</td><td><div class="code panel"><pre class="syntaxhighlighter-pre">:PROCEDURE SetDue;\n:PARAMETERS nOrder;\n:RETURN LimsNow();</pre></div></td></tr>
<tr><td>2</td><td>Run it</td></tr></tbody></table>`;
		const md = htmlToMarkdown(html);
		expect(md).toBe("| Step | Script |\n| --- | --- |\n| 1 | `:PROCEDURE SetDue;`<br>`:PARAMETERS nOrder;`<br>`:RETURN LimsNow();` |\n| 2 | Run it |");
		expect(md).not.toContain("\x00");
		// The backend takes a file with a NUL in its first bytes for a binary one, and no editor opens it then.
		expect(looksBinary(new TextEncoder().encode(`---\ntitle: Notes\n---\n\n# Notes\n\n${md}\n`))).toBe(false);
		expect(render(md)).toContain("<td><code>:PROCEDURE SetDue;</code><br><code>:PARAMETERS nOrder;</code><br><code>:RETURN LimsNow();</code></td>");
	});

	test("the cell's own words stay around the code; a pipe, a backslash before one, backticks and an empty line in the code are kept", () => {
		const md = htmlToMarkdown("<table><tr><th>Step</th><th>Script <pre>x</pre></th></tr><tr><td>Run: <pre>a | b\nc \\| d\n\n  e `` f</pre> done</td><td>2</td></tr></table>");
		expect(md).toBe("| Step | Script<br>`x` |\n| --- | --- |\n| Run:<br>`a \\| b`<br>`c \\`\\|` d`<br><br>```  e `` f```<br>done | 2 |");
		// Two cells in each row still, and the code as the page had it.
		expect(render(md)).toBe("<table><thead><tr><th>Step</th><th>Script<br><code>x</code></th></tr></thead><tbody><tr><td>Run:<br><code>a | b</code><br><code>c \\</code>|<code> d</code><br><br><code>  e `` f</code><br>done</td><td>2</td></tr></tbody></table>");
	});

	test("inline code beside a code block in one cell cannot cut the cell and lay the code block's text open", () => {
		const md = htmlToMarkdown("<table><tr><td>Use <code>a\\|b</code> or <pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre></td></tr></table>");
		expect(render(md)).toBe("<table><thead><tr><th>Use <code>a\\</code>|<code>b</code> or<br><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></th></tr></thead></table>");
		expect(htmlOfMarked(marked.lexer(md)).filter((html) => html !== "<br>")).toEqual([]);
		expect(readByLezer(md).html.filter((html) => html !== "<br>")).toEqual([]);
	});

	test("a code block in a heading is inline code on the heading's line, at every level", () => {
		expect(htmlToMarkdown("<h2>Title <pre>x = 1\ny = 2</pre></h2><p>after</p>")).toBe("## Title `x = 1 y = 2`\n\nafter");
		expect(htmlToMarkdown("<h1><pre>a ` b</pre></h1><h6>Six <pre>z</pre> #</h6>")).toBe("# ``a ` b``\n\n###### Six `z` \\#");
		for (let level = 1; level <= 6; level++) {
			const md = htmlToMarkdown(`<h${level}>Call <pre>&lt;b&gt;GetOrders()&lt;/b&gt;</pre></h${level}><p>after</p>`);
			expect(render(md)).toBe(`<h${level}>Call <code>&lt;b&gt;GetOrders()&lt;/b&gt;</code></h${level}><p>after</p>`);
		}
	});

	test("any other block in a heading comes after the heading: none is left as a NUL mark in it", () => {
		const md = htmlToMarkdown("<h2>T <table><tr><td>a</td><td>b</td></tr></table></h2><h3>L <ul><li>x</li></ul></h3><h4>Q <blockquote>q</blockquote></h4><h5><details><summary>s</summary>d</details></h5><p>after</p>");
		expect(md).toBe("## T\n\n| a | b |\n| --- | --- |\n\n### L\n\n- x\n\n#### Q\n\n> q\n\n<details>\n<summary>s</summary>\n\nd\n\n</details>\n\nafter");
		expect(htmlToMarkdown("<h2>T <blockquote><pre>c</pre></blockquote> end</h2><p>after</p>")).toBe("## T end\n\n> ```\n> c\n> ```\n\nafter");
	});

	test("a code block in a summary is its words there; a table in one comes first in the body", () => {
		expect(htmlToMarkdown("<details><summary>Show <pre>code &lt;x&gt;\nline 2</pre></summary><p>body</p></details>")).toBe("<details>\n<summary>Show code &lt;x&gt; line 2</summary>\n\nbody\n\n</details>");
		expect(htmlToMarkdown("<details><summary>S <table><tr><td>a</td><td><pre>c</pre></td></tr></table></summary><p>body</p></details>")).toBe("<details>\n<summary>S</summary>\n\n| a | `c` |\n| --- | --- |\n\nbody\n\n</details>");
	});

	test("a code block several things deep comes back, in the form the innermost of them can hold", () => {
		const md = htmlToMarkdown("<ul><li>Step<details><summary>More</summary><blockquote><table><tr><td><pre>X &lt;b&gt;</pre></td></tr></table></blockquote></details></li><li>next</li></ul>");
		expect(md).toBe("- Step\n\n  <details>\n  <summary>More</summary>\n\n  > | `X <b>` |\n  > | --- |\n\n  </details>\n\n- next");
		expect(render(md)).toBe("<ul><li><p>Step</p><details><summary>More</summary><blockquote><table><thead><tr><th><code>X &lt;b&gt;</code></th></tr></thead></table></blockquote></details></li><li><p>next</p></li></ul>");
	});

	test("code that stands in a table outside its cells (a caption, a cell never closed) is kept, before the table", () => {
		expect(htmlToMarkdown("<table><caption><pre>cap</pre></caption><tr><td>a<td><pre>open</pre></tr><tr><td>b</td></tr></table>")).toBe("```\ncap\n```\n\n```\nopen\n```\n\n| b |\n| --- |");
		// Nothing but the code is left of this table. In struck text the empty rest of it must not come out as "~~~~".
		expect(htmlToMarkdown("<p><del>old <table><tr><td>a<td><pre>c</pre></tr></table> gone</del></p><h2>After</h2>")).toBe("~~old~~\n\n```\nc\n```\n\n~~gone~~\n\n## After");
	});

	test("NUL characters and look-alikes of the marks in the page are no marks, and do not break the putting back", () => {
		const md = htmlToMarkdown("<p>\x00B1_0\x00 and B1_0 and \x00INL0\x00</p><pre>\x00B1_0\x00 real</pre><table><tr><td><pre>cell</pre> \x00B1_1\x00</td></tr></table>");
		expect(md).toBe("B1_0 and B1_0 and INL0\n\n```\nB1_0 real\n```\n\n| `cell`<br>B1_1 |\n| --- |");
		// A mark that came to stand in an address lost one of its two ends there, and the other went out as a NUL.
		expect(htmlToMarkdown('<p><a href="<pre>c</pre>y"></a> <a href="<code>x</code>y"></a></p>')).toBe("```\nc\n```\n\ny `x`y");
		expect(htmlToMarkdown('<ul><li><img src="a.png" alt="x <pre>code</pre> y"> after</li></ul><p>end</p>')).toBe("- ![x code y](a.png) after\n\nend");
	});
});

describe("P4. a code block inside a list item, a quotation or a link is a fenced block on lines of its own", () => {
	test("numbered steps with a code sample: the code is part of its step, the list goes on, and what follows is still read", () => {
		const html = `<ol><li><p>Run the query:</p><div class="highlight"><pre>SELECT * FROM ORDERS\nWHERE STATUS = 'Open'</pre></div></li><li>Then check the result</li></ol><p>After the list.</p><h2>Next section</h2><p>More text.</p>`;
		const md = htmlToMarkdown(html);
		expect(md).toBe("1. Run the query:\n\n   ```\n   SELECT * FROM ORDERS\n   WHERE STATUS = 'Open'\n   ```\n\n2. Then check the result\n\nAfter the list.\n\n## Next section\n\nMore text.");
		expect(render(md)).toBe("<ol><li><p>Run the query:</p><pre><code>SELECT * FROM ORDERS\nWHERE STATUS = &#39;Open&#39;\n</code></pre></li><li><p>Then check the result</p></li></ol><p>After the list.</p><h2>Next section</h2><p>More text.</p>".replace(/\n/g, ""));
		// The editor's tree: one list, then the paragraph and the heading that the outline needs.
		expect(readByLezer(md).top.map((node) => node.name)).toEqual(["OrderedList", "Paragraph", "ATXHeading2", "Paragraph"]);
	});

	test("an item that begins with code, words after the code, and a marker ten items in", () => {
		const md = htmlToMarkdown('<ul><li><pre><code class="language-ssl">:RETURN 1;</code></pre></li><li>Run: <pre>a\n\nb</pre> then more</li><li>last</li></ul><h2>H</h2>');
		expect(md).toBe("- ```ssl\n  :RETURN 1;\n  ```\n\n- Run:\n\n  ```\n  a\n\n  b\n  ```\n\n  then more\n- last\n\n## H");
		expect(render(md)).toBe('<ul><li><pre><code class="language-ssl">:RETURN 1;</code></pre></li><li><p>Run:</p><pre><code>a\n\nb\n</code></pre><p>then more</p></li><li><p>last</p></li></ul><h2>H</h2>'.replace(/\n/g, ""));
		const ten = htmlToMarkdown(`<ol>${"<li>x</li>".repeat(9)}<li>ten <pre>c</pre> end</li></ol>`);
		expect(ten.split("\n").slice(9).join("\n")).toBe("10. ten\n\n    ```\n    c\n    ```\n\n    end");
	});

	test("in a nested list the code stays in its own item, under a numbered item too", () => {
		const md = htmlToMarkdown("<ol><li>a<ol><li>b<ul><li>c <pre>code</pre></li></ul></li></ol></li><li>d</li></ol><p>after</p>");
		expect(md).toBe("1. a\n   1. b\n      - c\n\n        ```\n        code\n        ```\n2. d\n\nafter");
		expect(render(md)).toBe("<ol><li>a<ol><li>b<ul><li><p>c</p><pre><code>code</code></pre></li></ul></li></ol></li><li>d</li></ol><p>after</p>");
		// An item with nothing of its own but a list: the list takes its place, and the code is still in an item.
		expect(htmlToMarkdown("<ul><li><ul><li><pre>only</pre></li></ul></li></ul>")).toBe("- ```\n  only\n  ```");
	});

	test("a list with code in it writes every block of an item as a block of that item", () => {
		const md = htmlToMarkdown("<ul><li>t <table><tr><td>a</td><td>b</td></tr></table> u</li><li>v <pre>c</pre></li></ul><p>after</p>");
		expect(md).toBe("- t\n\n  | a | b |\n  | --- | --- |\n\n  u\n- v\n\n  ```\n  c\n  ```\n\nafter");
		const deep = htmlToMarkdown("<ul><li>t <details><summary>s</summary><pre>c</pre></details> u</li><li>v <blockquote><pre>q</pre></blockquote></li></ul><p>after</p>");
		expect(deep).toBe("- t\n\n  <details>\n  <summary>s</summary>\n\n  ```\n  c\n  ```\n\n  </details>\n\n  u\n- v\n\n  > ```\n  > q\n  > ```\n\nafter");
		expect(render(deep)).toBe("<ul><li><p>t</p><details><summary>s</summary><pre><code>c</code></pre></details><p>u</p></li><li><p>v</p><blockquote><pre><code>q</code></pre></blockquote></li></ul><p>after</p>");
	});

	test("code that stands in a list between two items is kept where it stood", () => {
		expect(htmlToMarkdown("<ul><li>a</li><pre>between</pre><li>b</li></ul><p>after</p>")).toBe("- a\n\n```\nbetween\n```\n\n- b\n\nafter");
	});

	test("in a quotation every line of the code has the mark, in a quotation inside a quotation too", () => {
		expect(htmlToMarkdown("<blockquote><p>q</p><pre>a\nb</pre></blockquote>")).toBe("> q\n>\n> ```\n> a\n> b\n> ```");
		const md = htmlToMarkdown("<blockquote><blockquote><pre>a\n&lt;script&gt;alert(1)&lt;/script&gt;</pre></blockquote><p>outer</p></blockquote><p>after</p>");
		expect(md).toBe("> > ```\n> > a\n> > <script>alert(1)</script>\n> > ```\n>\n> outer\n\nafter");
		expect(render(md)).toBe("<blockquote><blockquote><pre><code>a\n&lt;script&gt;alert(1)&lt;/script&gt;\n</code></pre></blockquote><p>outer</p></blockquote><p>after</p>".replace(/\n/g, ""));
		// A details block beside the code in the inner quotation has the marks on all of its lines as well.
		expect(htmlToMarkdown("<blockquote><blockquote><details><summary>s</summary>x</details><pre>c</pre></blockquote></blockquote>")).toBe("> > <details>\n> > <summary>s</summary>\n> >\n> > x\n> >\n> > </details>\n> >\n> > ```\n> > c\n> > ```");
	});

	test("inside a list item or a quotation the fence is longer than any run of backticks in the code", () => {
		expect(htmlToMarkdown("<blockquote><pre>a ``` b</pre></blockquote>")).toBe("> ````\n> a ``` b\n> ````");
		expect(htmlToMarkdown("<ul><li>x <pre>say ````` five\n```</pre></li></ul>")).toBe("- x\n\n  ``````\n  say ````` five\n  ```\n  ``````");
	});

	test("a carriage return written by its number cannot take a line of quoted code out of its fence", () => {
		const md = htmlToMarkdown("<blockquote><pre>x&#13;&lt;script&gt;alert(1)&lt;/script&gt;</pre></blockquote><ul><li><pre>a&#13;&#10;b&#13;c</pre></li></ul>");
		expect(md).toBe("> ```\n> x\n> <script>alert(1)</script>\n> ```\n\n- ```\n  a\n  b\n  c\n  ```");
		expect(htmlOfMarked(marked.lexer(md))).toEqual([]);
	});

	test("a link or bold around a code block ends before the block and begins again after it", () => {
		const script = htmlToMarkdown('<a href="https://x.test/"><pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre></a><h2>H</h2>');
		expect(script).toBe("```\n<script>alert(1)</script>\n```\n\n## H");
		expect(htmlOfMarked(marked.lexer(script))).toEqual([]);
		expect(readByLezer(script).html).toEqual([]);
		expect(htmlToMarkdown('<p><a href="https://x.test/">see <pre>code</pre> here</a></p>')).toBe("[see](https://x.test/)\n\n```\ncode\n```\n\n[here](https://x.test/)");
		expect(htmlToMarkdown("<p><b>bold <pre>code</pre> more</b> <i><pre>i</pre></i> <code>a <pre>c</pre> b</code></p><p>after</p>")).toBe("**bold**\n\n```\ncode\n```\n\n**more**\n\n```\ni\n```\n\n`a`\n\n```\nc\n```\n\n`b`\n\nafter");
	});

	test("a code block in a definition list is a block of its own", () => {
		expect(htmlToMarkdown("<dl><dt>Term</dt><dd>Def <pre>code</pre> more</dd></dl><p>after</p>")).toBe("TermDef\n\n```\ncode\n```\n\nmore\nafter");
	});
});

describe("what was right before is written as it was", () => {
	test("pages with no code block inside another thing give the Markdown they always gave, byte for byte", () => {
		// Each second text is what the converter of 6bf5b41 gives for the first: the common shapes, pinned. (The wide
		// comparison, old converter against new over generated pages, was run once when this was fixed.)
		const pages: [string, string][] = [
			['<pre><code class="language-sql">SELECT 1;</code></pre>', "```sql\nSELECT 1;\n```"],
			["<p>Before</p><pre>a ``` b\n````\nc</pre><p>After</p>", "Before\n\n`````\na ``` b\n````\nc\n`````\n\nAfter"],
			['<div class="highlight"><pre>x &lt;y&gt;\n\n\n\nz  </pre></div><p>After</p>', "```\nx <y>\n\nz\n```\n\nAfter"],
			["<pre>x&#13;y</pre>", "```\nx\ry\n```"],
			["<ul><li>A<ul><li>B</li></ul></li><li>C</li></ul>", "- A\n  - B\n- C"],
			["<ol><li>First<ol><li>Sub 1</li><li>Sub 2</li></ol></li><li>Second</li></ol>", "1. First\n  1. Sub 1\n  2. Sub 2\n2. Second"],
			["<blockquote><p>q</p><blockquote><p>inner</p></blockquote></blockquote>", "> q\n>\n> > inner"],
			["<details><summary>S <b>b</b></summary><p>x</p><pre>y</pre></details>", "<details>\n<summary>S b</summary>\n\nx\n\n```\ny\n```\n\n</details>"],
			["<table><tr><th>K</th><th>V</th></tr><tr><td>a | b</td><td><code>3 | 5</code></td></tr></table>", "| K | V |\n| --- | --- |\n| a \\| b | `3 \\| 5` |"],
			["<h2>Title <code>x</code> #</h2>", "## Title `x` \\#"],
			['<p><b>bold <i>it</i></b> <a href="https://x.test/">l</a> <img src="a.png" alt="p"></p>', "**bold *it*** [l](https://x.test/) ![p](a.png)"],
		];
		for (const [html, md] of pages) expect({ html, md: htmlToMarkdown(html) }).toEqual({ html, md });
	});
});

// ---- Many pages ----

function seeded(seed: number) {
	let state = seed >>> 0;
	const next = () => ((state = (state * 1664525 + 1013904223) >>> 0), state / 2 ** 32);
	return { next, int: (below: number) => Math.floor(next() * below), pick: <T>(from: readonly T[]) => from[Math.floor(next() * from.length)]! };
}
type Rng = ReturnType<typeof seeded>;

/** A piece of code the page holds: its lines as the page shows them, and whether it stands in a summary. */
interface Code {
	id: number;
	lines: string[];
	inSummary: boolean;
}
interface Page {
	r: Rng;
	/** The code blocks (<pre>) written so far. */
	blocks: Code[];
	/** The pieces of inline code (<code>) written so far; they are only followed on a calm page. */
	spans: Code[];
	summary: boolean;
	/** Tags left open or never opened. */
	broken: boolean;
	/**
	 * A page on which inline code can be followed as well as code blocks. It has none of the shapes that the converter
	 * has always written so that inline code beside them can come out wrong, whether or not a code block is near.
	 * They are no part of the two findings and are left as they were:
	 * - a details block anywhere; a quotation or a table in a list item, a quotation in a quotation (in a list
	 *   without code blocks these are written in the middle of the item's line, and what is put back into a quotation
	 *   in a quotation has the quotation's mark on its first line only);
	 * - a table caption, and a closing tag with a space in it (such a caption or cell is left out).
	 * For the two shapes of inline code itself see `span`.
	 */
	calm: boolean;
}

/** Text as a page writes it: the characters HTML keeps for itself as references, by name or by number. */
const written = (r: Rng, text: string) =>
	text.replace(/[&<>]/g, (ch) => (r.next() < 0.3 ? `&#${ch.charCodeAt(0)};` : r.next() < 0.2 ? `&#x${ch.charCodeAt(0).toString(16)};` : ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as Record<string, string>)[ch]!));

const WORDS = ["Run the query", "then", "Sample", "x1", "a", "B1_0", "INL0", "snake_case", "50%", "C#", "*", "**b**", "`", "[x](y)", "# ", "- ", "> ", "|", "1. ", "&copy;", "<DataSource>", '<script>alert("w")</script>', "</details>", "\\", "~~~", "```", "---", "===", "<!-- x -->"];
const words = (p: Page) => written(p.r, Array.from({ length: 1 + p.r.int(3) }, () => p.r.pick(WORDS)).join(p.r.pick([" ", " ", "  ", "\n"])));

/** What code is made of here: marks of Markdown, of tables and of HTML, fences, look-alikes of the converter's own marks. */
const codeBits = (tagName: string) => ["x = 1", ":RETURN 1;", "SELECT * FROM T", "a | b", "a \\| b", "\\|", "||", "\\", "`", "``", "```", "````", "`````", "~~~", `<${tagName}>`, `<script>alert("${tagName}")</script>`, "</details>", "<details>", "<!-- c -->", "-->", "&amp;", "&lt;", "# h", "- l", "> q", "| t |", "|---|", "[l](u)", "*x*", "$&", "$1", "B1_0", "INL0", "</pre", "<br>", "1. n", "    ", "\t", "==="];

function pre(p: Page): string {
	const id = p.blocks.length;
	const bits = codeBits(`k${id}`);
	const lines = Array.from({ length: 1 + p.r.int(4) }, (_x, at) => (at > 0 && p.r.next() < 0.12 ? "" : `${p.r.next() < 0.15 ? p.r.pick(["  ", "    ", "\t", "```", "> ", "# "]) : ""}K${id}L${at} ${Array.from({ length: p.r.int(4) }, () => p.r.pick(bits)).join(" ")}`.trimEnd()));
	// On a broken page a summary may be left open and end where a later one does: any code may then stand in it.
	p.blocks.push({ id, lines, inSummary: p.summary || p.broken });
	// A line of the code ends with a line feed, or with a carriage return that the page wrote by its number.
	const lineEnd = () => (p.r.next() < 0.08 ? "&#13;" : p.r.next() < 0.05 ? "&#13;&#10;" : "\n");
	let body = lines.map((line) => written(p.r, line)).reduce((all, line, at) => (at ? all + lineEnd() + line : line), "");
	const roll = p.r.next();
	if (roll < 0.15) body = body.replace(/K(\d+)L/g, '<span class="k">K$1L</span>');
	if (roll < 0.4) return `<pre>${body}</pre>`;
	if (roll < 0.7) return `<pre><code class="language-${p.r.pick(["ssl", "sql", "c++"])}">${body}</code></pre>`;
	if (roll < 0.85) return `<div class="highlight"><pre class="x">${body}</pre></div>`;
	return `<pre>\n${body}\n\n</pre>`;
}

/**
 * Inline code with backticks and the rest in it. It stands between two full stops, so that its backticks never
 * touch a backtick of the text or of other inline code, and it has no backslash before a "|". Both are shapes the
 * converter has always written wrongly for inline code, whether or not a code block is near: two pieces of inline
 * code side by side run their backticks together, and "\|" in a table cell ends the cell inside the code. The
 * space before the first full stop keeps the address of a link before it from running on into the code.
 */
function span(p: Page): string {
	const id = p.spans.length;
	const text = `C${id}L0 ${Array.from({ length: p.r.int(4) }, () => p.r.pick(codeBits(`c${id}`))).join(" ")}`.replace(/\\\|/g, "\\ |").trim();
	p.spans.push({ id, lines: [text], inSummary: p.summary });
	return ` .<code>${written(p.r, text)}</code>. `;
}

function tag(p: Page, name: string, inner: string, attrs = ""): string {
	const open = `<${p.r.next() < 0.05 ? name.toUpperCase() : name}${attrs}${p.r.next() < 0.05 ? ' class="x y"' : ""}>`;
	if (p.broken && p.r.next() < 0.07) return open + inner;
	if (p.broken && p.r.next() < 0.03) return `${inner}</${name}>`;
	return `${open}${inner}</${name}${p.r.next() < 0.03 && !p.calm ? " " : ""}>`;
}

// One name for struck text: "<del><s>x</s></del>" has always been written "~~~~x~~~~", which is a fence.
const MARKS = ["b", "strong", "i", "em", "del", "mark", "span", "u"];
const URLS = ["https://x.test/a", "docs/x.md", "#frag", "javascript:alert(1)", "mailto:a@b.test", "", "x y"];

function inline(p: Page, depth: number): string {
	let out = "";
	for (let n = 1 + p.r.int(3); n > 0; n--) {
		const roll = p.r.next();
		if (depth <= 0 || roll < 0.38) out += words(p);
		else if (roll < 0.52) out += tag(p, p.r.pick(MARKS), inline(p, depth - 1));
		else if (roll < 0.62) out += span(p);
		else if (roll < 0.7) out += tag(p, "a", inline(p, depth - 1), p.r.next() < 0.85 ? ` href="${p.r.pick(URLS)}"` : ' name="x"');
		else if (roll < 0.74) out += `<img src="${p.r.pick(URLS)}" alt="pic ${p.r.int(9)}">`;
		else if (roll < 0.78) out += "<br>";
		else out += pre(p);
	}
	return out;
}

function block(p: Page, depth: number, inList = false, inQuote = false): string {
	const roll = p.r.next();
	if (depth <= 0 || roll < 0.18) return tag(p, p.r.pick(["p", "p", "div"]), inline(p, 2));
	if (roll < 0.3) return pre(p);
	if (roll < 0.4) return tag(p, `h${1 + p.r.int(5)}`, p.r.next() < 0.8 || p.calm ? inline(p, 2) : blocks(p, depth - 1, inList, inQuote));
	if (roll < 0.6) {
		const items = Array.from({ length: 1 + p.r.int(3) }, () => tag(p, "li", p.r.next() < 0.5 ? inline(p, 2) : (p.r.next() < 0.7 ? inline(p, 1) : "") + blocks(p, depth - 1, true, inQuote) + (p.r.next() < 0.3 ? inline(p, 1) : "")));
		const first = p.r.next() < 0.08 ? pre(p) : "";
		return tag(p, p.r.pick(["ul", "ol"]), first + items.reduce((all, item) => all + (p.r.next() < 0.06 ? pre(p) : p.r.next() < 0.3 ? "\n" : "") + item));
	}
	if (roll < 0.7 && !(p.calm && (inList || inQuote))) return tag(p, "blockquote", blocks(p, depth - 1, inList, true));
	if (roll < 0.78 && !p.calm) {
		const was = p.summary;
		p.summary = true;
		const summary = p.r.next() < 0.85 ? tag(p, "summary", p.r.next() < 0.8 ? inline(p, 1) : blocks(p, depth - 1)) : "";
		p.summary = was;
		return tag(p, "details", summary + blocks(p, depth - 1, inList, inQuote));
	}
	if (roll < 0.9 && !(p.calm && inList)) {
		const cell = () => (p.r.next() < 0.7 || p.calm ? inline(p, 2) : blocks(p, depth - 1));
		const rows = Array.from({ length: 1 + p.r.int(3) }, (_x, at) => tag(p, "tr", Array.from({ length: 1 + p.r.int(3) }, () => tag(p, at === 0 && p.r.next() < 0.7 ? "th" : "td", cell())).join("")));
		return tag(p, "table", (p.r.next() < 0.1 && !p.calm ? tag(p, "caption", inline(p, 1)) : "") + (p.r.next() < 0.05 ? pre(p) : "") + rows.join(""));
	}
	if (roll < 0.95) return `<dl><dt>${inline(p, 1)}</dt><dd>${blocks(p, depth - 1, inList, inQuote)}</dd></dl>`;
	return tag(p, "div", blocks(p, depth - 1, inList, inQuote));
}

function blocks(p: Page, depth: number, inList = false, inQuote = false): string {
	return Array.from({ length: 1 + p.r.int(3) }, () => block(p, depth, inList, inQuote)).join(p.r.next() < 0.3 ? "\n" : "");
}

const decoded = (text: string) => text.replace(/&(lt|gt|amp|quot|#39);/g, (_m, name: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'" } as Record<string, string>)[name]!);
/** What a rendered page shows, as one line of text. */
const shown = (html: string) => one(decoded(html.replace(/<[^>]+>/g, "")));

/**
 * What is wrong with the Markdown made of one page, in the terms of the two findings:
 * - a NUL in it;
 * - a line of a code block that the rendered page does not show (so: lost, or read as markup);
 * - text of a code block inside a piece of HTML, for marked or for lezer. Code in a summary stands inside the
 *   summary's HTML by design, as words: there only a tag of the code that is a tag again counts;
 * - the heading and the paragraph after everything are no heading and no paragraph at the top of the document.
 * `html` ends with `<h6>ZH</h6><p>ZP</p>`. `codes` is the code to look for, under the letter its words begin with.
 */
function wrong(html: string, codes: Record<string, Code[]>): string[] {
	const md = htmlToMarkdown(html);
	if (md.includes("\x00")) return ["a NUL in the Markdown"];
	const found: string[] = [];
	const tokens = marked.lexer(md, { gfm: true });
	const page = shown(marked.parser(tokens) as string);
	const byMarked = htmlOfMarked(tokens);
	const byLezer = readByLezer(md);
	for (const [prefix, code] of Object.entries(codes).flatMap(([letter, list]) => list.map((item) => [letter, item] as const))) {
		const name = `${prefix.toLowerCase()}${code.id}`;
		const lost = code.lines.flatMap((line) => line.split(/\r\n?|\n/)).find((line) => one(line) && !page.includes(one(line)));
		if (lost !== undefined) found.push(`not shown: ${JSON.stringify(lost)}`);
		for (const [reader, pieces] of [["marked", byMarked], ["lezer", byLezer.html]] as const) {
			const live = pieces.find((piece) => piece.includes(`<${name}>`) || piece.includes(`<script>alert("${name}")`));
			const inside = pieces.find((piece) => new RegExp(`${prefix}${code.id}L\\d`).test(piece));
			if (live !== undefined) found.push(`${reader} reads code as HTML: ${JSON.stringify(live)}`);
			else if (inside !== undefined && !code.inSummary) found.push(`${reader} has code text in HTML: ${JSON.stringify(inside)}`);
		}
	}
	if (!tokens.some((token: any) => token.type === "heading" && token.depth === 6 && token.text.includes("ZH"))) found.push("marked: the heading after is no heading");
	if (!tokens.some((token: any) => token.type === "paragraph" && token.text.includes("ZP"))) found.push("marked: the paragraph after is no paragraph");
	if (!byLezer.top.some((node) => node.name === "ATXHeading6" && node.text.includes("ZH"))) found.push("lezer: the heading after is no heading");
	if (!byLezer.top.some((node) => node.name === "Paragraph" && node.text.includes("ZP"))) found.push("lezer: the paragraph after is no paragraph");
	return found.length ? [...found, `page: ${JSON.stringify(html)}`, `markdown: ${JSON.stringify(md)}`] : [];
}

describe("many hostile pages with code blocks everywhere", () => {
	test("deep and broken pages: no NUL, every code block shown as code and nowhere as HTML, the end of the page still read", () => {
		const r = seeded(4);
		let blocksSeen = 0;
		for (let round = 0; round < 3000; round++) {
			const p: Page = { r, blocks: [], spans: [], summary: false, broken: r.next() < 0.5, calm: false };
			const base = `${blocks(p, 1 + r.int(4))}<h6>ZH</h6><p>ZP</p>`;
			// NUL characters anywhere in the page, inside its tags too: they are no part of it.
			const html = r.next() < 0.2 ? base.replace(/[\s\S]/g, (ch) => (r.next() < 0.02 ? `\x00${ch}` : ch)) : base;
			blocksSeen += p.blocks.length;
			expect(wrong(html, { K: p.blocks })).toEqual([]);
		}
		expect(blocksSeen).toBeGreaterThan(10000);
	}, 120_000);

	test("calm pages: inline code with backticks, pipes and tags in it is shown as code too, beside the code blocks", () => {
		const r = seeded(9);
		let spansSeen = 0;
		for (let round = 0; round < 2500; round++) {
			const p: Page = { r, blocks: [], spans: [], summary: false, broken: false, calm: true };
			const html = `${blocks(p, 1 + r.int(3))}<h6>ZH</h6><p>ZP</p>`;
			spansSeen += p.spans.length;
			expect(wrong(html, { K: p.blocks, C: p.spans })).toEqual([]);
		}
		expect(spansSeen).toBeGreaterThan(2000);
	}, 120_000);

	test("anything at all (tag soup, NUL characters, look-alikes of the marks, <pre> in attributes): no NUL comes out, nothing throws", () => {
		const r = seeded(77);
		const SOUP = ["<", ">", "</", "<pre>", "</pre>", "<pre", "<code>", "</code>", "<table>", "</table>", "<tr>", "</tr>", "<td>", "</td>", "<th>", "</th>", "<li>", "</li>", "<ul>", "</ul>", "<ol>", "</ol>", "<blockquote>", "</blockquote>", "<details>", "</details>", "<summary>", "</summary>", "<h1>", "</h1>", "<h3>", "</h3>", '<a href="', "<a href=x>", "</a>", "<b>", "</b>", "<i>", "</i>", "<del>", "</del>", "<mark>", "</mark>", '<img alt="', "<img src=x alt='", '">', "'>", '"', "'", "\x00", "\x00B", "\x00B1_0\x00", "\x00INL0\x00", "B1_0", "_0\x00", "INL", "`", "```", "|", "\\", "\n", "\n\n", " ", "x", "code", "&lt;", "&#0;", "&#13;", "&", "<br>", "<hr>", "<!--", "-->", "<script>", "</script>", "<body>", "</body>", "=", "\t"];
		for (let round = 0; round < 12000; round++) {
			const html = Array.from({ length: 2 + r.int(60) }, () => r.pick(SOUP)).join("");
			expect({ html, nul: htmlToMarkdown(html).includes("\x00") }).toEqual({ html, nul: false });
		}
	}, 120_000);
});
