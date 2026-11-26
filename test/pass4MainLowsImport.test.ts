// Low findings of the pass 4 audit that were on main already, in the three importers: a page (HTML), a ticket (the
// tree of nodes a Jira description is) and a Word file (B11-8, B5-5, B11-9, B11-12), and the three shapes the last
// round left in which text that a page showed as inline code was live HTML in the Markdown. Each test hands the
// importer what a paste, a dropped file or a ticket import hands it, and reads the Markdown back with the two
// readers the app has: marked (the rendered views) and lezer (the editor's own tree).
import { afterAll, describe, expect, test } from "bun:test";
import { GFM, parser as lezerParser } from "@lezer/markdown";
import { marked, type Token } from "marked";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createBackend, type Host } from "../src/bun/backend";
import { parseDocxToMarkdown } from "../src/bun/docx";
import { adfToMarkdown } from "../src/shared/adf";
import { htmlToMarkdown, looksLikeRichHtml } from "../src/shared/htmlToMarkdown";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p4m-import-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

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

/** The HTML that either reader finds in the Markdown, a line break in a table cell apart. */
const htmlIn = (md: string) => [...htmlOfMarked(marked.lexer(md, { gfm: true })), ...readByLezer(md).html].filter((piece) => piece.trim() !== "<br>");

/** How long `work` takes, in milliseconds. */
const timed = (work: () => unknown) => {
	const from = performance.now();
	work();
	return performance.now() - from;
};

// ---- B11-8 ----

const filled = (piece: string, size: number) => piece.repeat(Math.ceil(size / piece.length));
/**
 * Pages made of one thing over and over. Each of the first group took the square of its length before: the page has
 * no ">" or no closing tag left, and every tag in it was read to the end of the page to learn so. The second group
 * is long runs of one character where a pattern looked for the run's end from each character of it.
 */
const FLOODS: [name: string, page: (size: number) => string][] = [
	["<img ", (size) => filled("<img ", size)],
	["<a ", (size) => filled("<a ", size)],
	["<td", (size) => filled("<td", size)],
	["<!--", (size) => filled("<!--", size)],
	["&", (size) => filled("&", size)],
	["<pre>", (size) => filled("<pre>", size)],
	["<div> in <div>", (size) => `${"<div>".repeat(size / 11)}x${"</div>".repeat(size / 11)}`],
	["<", (size) => filled("<", size)],
	["<hr", (size) => filled("<hr", size)],
	["<p ", (size) => filled("<p ", size)],
	["<script>", (size) => filled("<script>", size)],
	["<body>", (size) => filled("<body>", size)],
	["<b>", (size) => filled("<b>", size)],
	["<code>", (size) => filled("<code>", size)],
	["<h1>", (size) => filled("<h1>", size)],
	["<table>", (size) => filled("<table>", size)],
	["<ul ", (size) => filled("<ul ", size)],
	["<li ", (size) => `<ul>${filled("<li ", size)}`],
	["<summary>", (size) => `<details>${filled("<summary>", size)}</details>`],
	["<input type=checkbox", (size) => filled("<input type=checkbox", size)],
	['<a href="', (size) => filled('<a href="', size)],
	['<img alt="', (size) => filled('<img alt="', size)],
	['<img "a" then a quote', (size) => `${filled('<img "a" ', size)}">`],
	['<a> in a quoted value', (size) => `<a title="${filled("<a>", size)}">`],
	["<a href=x>y", (size) => filled("<a href=x>y", size)],
	["</b ", (size) => `<b>${filled("</b ", size)}`],
	["<pre><code", (size) => filled("<pre><code", size)],
	["<pre> and space", (size) => filled("<pre>   \n", size)],
	["line ends in <pre>", (size) => `<pre>a${"\n".repeat(size)}x</pre>`],
	["spaces in <li>", (size) => `<ul><li>a${" ".repeat(size)}x</li></ul>`],
	["spaces in <td>", (size) => `<table><tr><td>a${" ".repeat(size)}x</td></tr></table>`],
	["spaces in <code>", (size) => `<p><code>a${" ".repeat(size)}x</code></p>`],
	["# in <h1>", (size) => `<h1>${"#".repeat(size)}x</h1>`],
	["<b> in <b>", (size) => `${"<b>".repeat(size / 7)}x${"</b>".repeat(size / 7)}`],
];

describe("B11-8. a page is read in time that grows with its length and not with its square", () => {
	test("100 KB of one tag that is never closed, or of one character, is read in well under a second", () => {
		// Before: 5.5 s for "<img ", 7.3 s for "<a ", 3.7 s for "<!--", 2.6 s for "<pre>"; now some ten milliseconds each.
		for (const [name, page] of FLOODS) {
			const html = page(100_000);
			const ms = timed(() => htmlToMarkdown(html));
			expect({ page: name, overASecond: ms > 1000 }).toEqual({ page: name, overASecond: false });
		}
	}, 300_000);

	test("the check a paste makes of its HTML is as quick", () => {
		for (const [name, page] of [...FLOODS, ["<a  no href", (size: number) => filled("<a  ", size)], ["<img  no src", (size: number) => filled("<img  ", size)], ["<meta", (size: number) => filled("<meta", size)]] as typeof FLOODS) {
			const html = page(100_000);
			const ms = timed(() => looksLikeRichHtml(html));
			expect({ page: name, overASecond: ms > 1000 }).toEqual({ page: name, overASecond: false });
		}
		// And it answers as it did.
		expect(looksLikeRichHtml('<div><span style="color:red">x</span></div>')).toBe(false);
		expect(looksLikeRichHtml("<!-- <b>x</b> --><style>b{}</style><meta name='<b>'>plain")).toBe(false);
		expect(looksLikeRichHtml('<p>see <a class="x" href="docs/a.md">a</a></p>')).toBe(true);
		expect(looksLikeRichHtml("<a name=x>anchor</a> <img alt=x>")).toBe(false);
		expect(looksLikeRichHtml('<a name=x>anchor</a> then <img alt="p" src="p.png">')).toBe(true);
		expect(looksLikeRichHtml("<a\nhref")).toBe(true);
		expect(looksLikeRichHtml("<a >href")).toBe(false);
	}, 300_000);

	test("the readers that took the patterns' place find what the patterns found", () => {
		// Each second text is what the converter of 6bf5b41 gives for the first (the wide comparison, old converter
		// against new over generated pages, was run when this was changed: no page differed).
		const pages: [string, string][] = [
			["<pre><code</pre>", "```\n<code\n```"],
			["<pre>  <code class='lang-ssl'>:RETURN 1;</code >  </pre >x", "```ssl\n:RETURN 1;\n```\n\nx"],
			["<pre>a</code></pre><pre><code>b</pre>", "```\na\n```\n\n```\nb\n```"],
			["<b>x</b >y<strong>z</b></strong>", "**x**y**z**"],
			['<a title="<a>x</a>" href="u">w</a>', "[w](u)"],
			['<a title="<a>x</a>">', ""],
			["<>a<<b>>c", "<>a>c"],
			["<img alt='a > b' src=p.png><img alt=\"x", '![a > b](p.png)&lt;img alt="x'],
			["<input type=text><input class=a type='checkbox' checked> done", "[x]  done"],
			["<!--><b>x</b>--><i>y</i><!-- z", "*y*&lt;!-- z"],
			["<script</script>a<style>b</style >c<svg>d", "acd"],
			["<table><tr><td>a</td><td>b</td ></tr><tr><th>c</tr></table>", "| a |\n| --- |"],
			["<h2>a</h2 ><h3>b</h2></h3>", "## a\n\n### b"],
			["<ul><li>a<li>b</li></li><li/>c</ul>", "- ab\n- c"],
			["<details><summary>s</summary >d</details ><hr/><hr x>", "<details>\n<summary>s</summary>\n\nd\n\n</details>\n\n---\n\n---"],
			["<p>a</p ><div x>b</div><br/><br >c<br\n>d", "a\n\nb\n\nc\nd"],
			["<body><p>in</p></body >out<body>", "in"],
			["<h1>t ##</h1><h2>#</h2>", "# t \\#\\#\n\n## \\#"],
			["<ul><li>a   \n\n  b\tc</li></ul>", "- a b\tc"],
		];
		for (const [html, md] of pages) expect({ html, md: htmlToMarkdown(html) }).toEqual({ html, md });
	});

	test("an import of such a page does not hold up a save: the backend answers within the second", async () => {
		const root = join(base, "ws-flood");
		mkdirSync(join(root, "docs"), { recursive: true });
		const source = join(base, "flood.html");
		writeFileSync(source, filled("<img ", 200_000));
		const host: Host = { app: "test", kind: "app", emit: () => {}, pick: async () => null, trash: async () => {}, quit: () => {} };
		const backend = createBackend(host, root);
		try {
			await backend.ready;
			const from = performance.now();
			// A save asked for while the import runs gets its turn when the import lets go of the one thread there is.
			let savedAfter = 0;
			const saved = new Promise<void>((done) => setTimeout(() => void backend.api.write(join(root, "a.ssl"), ":RETURN 1;\n").then(() => ((savedAfter = performance.now() - from), done())), 5));
			const imported = await backend.api.importDocFile({ sourcePath: source, destDir: join(root, "docs") });
			await saved;
			expect(imported?.kind).toBe("html");
			expect(readFileSync(join(root, "a.ssl"), "utf8")).toBe(":RETURN 1;\n");
			// Before: 12 s for these 200 KB, and the save waited for all of it.
			expect(savedAfter).toBeLessThan(2000);
		} finally {
			backend.dispose();
		}
	}, 120_000);
});

describe("B11-8. a page of things inside one another without end neither throws nor hangs", () => {
	const nest = (open: (level: number) => string, close: string, depth: number, core: string) => Array.from({ length: depth }, (_x, at) => open(at + 1)).join("") + core + close.repeat(depth);

	test("ten thousand quotations, details blocks or lists in one another are read in seconds", () => {
		// Before: a RangeError for each of these (the stack used up), after 16 to 27 seconds.
		for (const [name, html] of [
			["quotations", nest(() => "<blockquote>", "</blockquote>", 10_000, "x")],
			["details blocks", nest(() => "<details>", "</details>", 10_000, "x")],
			["lists", nest(() => "<ul><li>", "</li></ul>", 10_000, "x")],
			["all three", nest((level) => (level % 3 === 0 ? "<details><summary>s</summary>" : level % 3 === 1 ? "<blockquote>" : "<ol><li>"), "", 9_000, "x") + "</li></ol></blockquote></details>".repeat(3_000)],
		] as const) {
			let md = "";
			const ms = timed(() => (md = htmlToMarkdown(`${html}<p>after</p>`)));
			expect({ name, read: md.includes("x") && md.endsWith("after"), slow: ms > 5000 }).toEqual({ name, read: true, slow: false });
		}
	}, 300_000);

	test("what stands deeper than 32 keeps its words and loses its form; a code block there is still a code block", () => {
		const lists = htmlToMarkdown(`${nest((level) => `<ul><li>L${level} `, "</li></ul>", 34, "<pre>code</pre>")}<p>after</p>`).split("\n");
		// The item at level 32 holds the words of the items under it on its line, and their code as a block of its own.
		expect(lists.slice(31)).toEqual([`${"  ".repeat(31)}- L32 L33 L34`, "", `${"  ".repeat(32)}\`\`\``, `${"  ".repeat(32)}code`, `${"  ".repeat(32)}\`\`\``, "", "after"]);
		expect(lists.slice(0, 3)).toEqual(["- L1", "  - L2", "    - L3"]);

		const quotes = htmlToMarkdown(`${nest((level) => `<blockquote><p>Q${level}</p>`, "</blockquote>", 34, "<ul><li>item</li></ul><pre>code</pre>")}<p>after</p>`).split("\n");
		const marks = "> ".repeat(32);
		// The quotations at 33 and 34 are paragraphs of the one at 32, and the list in them is a paragraph too.
		expect(quotes.slice(62)).toEqual([`${marks}Q32`, marks.trimEnd(), `${marks}Q33`, marks.trimEnd(), `${marks}Q34`, marks.trimEnd(), `${marks}item`, marks.trimEnd(), `${marks}\`\`\``, `${marks}code`, `${marks}\`\`\``, "", "after"]);

		const details = htmlToMarkdown(nest((level) => `<details><summary>S${level}</summary><p>D${level}</p>`, "</details>", 34, ""));
		expect(details.split("<details>").length - 1).toBe(32);
		expect(details).toContain("<summary>S32</summary>\n\nD32\n\nS33\n\nD33\n\nS34\n\nD34\n\n</details>");
		// A page 32 deep is written as it always was.
		expect(htmlToMarkdown(nest((level) => `<ul><li>L${level}`, "</li></ul>", 32, "")).split("\n")[31]).toBe(`${"  ".repeat(31)}- L32`);
	});
});

// ---- Inline code that was live HTML ----

describe("inline code is code wherever it stands, and never HTML", () => {
	const img = "&lt;img src=x onerror=alert(1)&gt;";

	test("a backslash before a pipe in the inline code of a table cell does not end the cell in the code", () => {
		const md = htmlToMarkdown(`<table><tr><th>a</th><th>b</th></tr><tr><td><code>x\\|${img}</code></td></tr></table>`);
		expect(md).toBe("| a | b |\n| --- | --- |\n| `x\\`\\|`<img src=x onerror=alert(1)>` |  |");
		expect(render(md)).toBe("<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><code>x\\</code>|<code>&lt;img src=x onerror=alert(1)&gt;</code></td><td></td></tr></tbody></table>");
		expect(htmlIn(md)).toEqual([]);
		// Without a backslash before a pipe, a cell's code is written as it always was.
		expect(htmlToMarkdown("<table><tr><td><code>3 | 5</code> and <code>a\\b</code></td></tr></table>")).toBe("| `3 \\| 5` and `a\\b` |\n| --- |");
	});

	test("two pieces of inline code side by side are one piece, and their backticks do not run together", () => {
		const md = htmlToMarkdown(`<p><code>a</code><code>${img}\`\`</code></p>`);
		expect(md).toBe("``` a<img src=x onerror=alert(1)>`` ```");
		expect(render(md)).toBe("<p><code>a&lt;img src=x onerror=alert(1)&gt;``</code></p>");
		expect(htmlIn(md)).toEqual([]);
		// With nothing but tags between them too; with a space between them they stay two.
		expect(htmlToMarkdown("<p><code>a</code><span><code>b</code></span><b></b><code>c</code> <code>d</code></p>")).toBe("`abc` `d`");
		expect(htmlToMarkdown("<ul><li><code>a</code><code>`b</code></li></ul><h2><code>x</code><code>y</code></h2>")).toBe("- ``a`b``\n\n## `xy`");
	});

	test("a backtick of the text right before inline code is written by its number", () => {
		const md = htmlToMarkdown("<p>`<code>&lt;b&gt;</code> and &#96;<code>&lt;script&gt;alert(1)&lt;/script&gt;`</code></p>");
		expect(md).toBe("&#96;`<b>` and &#96;`` <script>alert(1)</script>` ``");
		expect(render(md)).toBe("<p>`<code>&lt;b&gt;</code> and `<code>&lt;script&gt;alert(1)&lt;/script&gt;`</code></p>");
		expect(htmlIn(md)).toEqual([]);
		// A backtick after the code, and one that touches no code, are written as they always were.
		expect(htmlToMarkdown("<p><code>x</code>` and ` alone</p>")).toBe("`x`\\` and \\` alone");
	});

	test("a details block, a table and a quotation in a list item are blocks of that item, and the items after it are still items", () => {
		const md = htmlToMarkdown("<ul><li>a <details><summary>s</summary>x</details></li><li><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></li></ul><p>after</p>");
		expect(md).toBe("- a\n\n  <details>\n  <summary>s</summary>\n\n  x\n\n  </details>\n\n- `<script>alert(1)</script>`\n\nafter");
		expect(render(md)).toBe("<ul><li><p>a</p><details><summary>s</summary><p>x</p></details></li><li><p><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></p></li></ul><p>after</p>");
		expect(htmlIn(md).filter((piece) => /script/.test(piece))).toEqual([]);

		const table = htmlToMarkdown("<ol><li>a <table><tr><td>t</td><td>u</td></tr></table> b<ol><li>c</li></ol></li><li>d <blockquote>q</blockquote></li></ol>");
		expect(table).toBe("1. a\n\n   | t | u |\n   | --- | --- |\n\n   b\n   1. c\n2. d\n\n   > q");
		expect(render(table)).toBe("<ol><li><p>a</p><table><thead><tr><th>t</th><th>u</th></tr></thead></table><p>b</p><ol><li>c</li></ol></li><li><p>d</p><blockquote><p>q</p></blockquote></li></ol>");
		// A table without rows writes nothing, and does not take the item's marker with it.
		expect(htmlToMarkdown("<ul><li><table></table>text</li><li>next</li></ul>")).toBe("- text\n- next");
		// A list of words alone is written as it always was, under a numbered item too.
		expect(htmlToMarkdown("<ol><li>First<ol><li>Sub 1</li></ol></li><li>Second</li></ol>")).toBe("1. First\n  1. Sub 1\n2. Second");
	});

	test("a details block stands on lines of its own inside a link, bold text and a heading, and between two items", () => {
		const code = `<code>${img}</code>`;
		for (const html of [
			`<p><a href="docs/x.md">t <details><summary>s</summary>x</details></a> ${code}</p>`,
			`<p><b>t <details><summary>s</summary>x</details></b> ${code}</p>`,
			`<blockquote><h2>T <details><summary>s</summary>x</details> ${code}</h2></blockquote>`,
			`<blockquote><blockquote><details><summary>s</summary>x</details><p>${code}</p></blockquote></blockquote>`,
			`<details><summary>S</summary><blockquote><details><summary>T <table><tr><td>${code}</td></tr></table></summary>b</details></blockquote></details>`,
		]) {
			const md = htmlToMarkdown(html);
			expect({ html, live: htmlIn(md).filter((piece) => piece.includes("onerror")) }).toEqual({ html, live: [] });
			expect({ html, shown: render(md).includes("<code>&lt;img src=x onerror=alert(1)&gt;</code>") }).toEqual({ html, shown: true });
		}
		expect(htmlToMarkdown('<p><a href="docs/x.md">t <details><summary>s</summary>x</details></a> after</p>')).toBe("[t](docs/x.md)\n\n<details>\n<summary>s</summary>\n\nx\n\n</details>\n\nafter");
		expect(htmlToMarkdown("<ul><li>a</li><details><summary>s</summary>x</details><li>b</li></ul>")).toBe("- a\n\n<details>\n<summary>s</summary>\n\nx\n\n</details>\n\n- b");
		// A table in a quotation in a quotation has the marks on all of its lines.
		expect(htmlToMarkdown("<blockquote><blockquote><table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table></blockquote></blockquote>")).toBe("> > | a | b |\n> > | --- | --- |\n> > | 1 | 2 |");
		// A link around a heading is written as it always was.
		expect(htmlToMarkdown('<a href="docs/x.md"><h2>Title</h2></a>')).toBe("[## Title](docs/x.md)");
	});

	test("an address right before inline code does not take the code's backtick with it", () => {
		const code = `<code>${img}</code>`;
		const pages: [string, string][] = [
			[`<p>see https://x.test/a${code}</p>`, "see <https://x.test/a>`<img src=x onerror=alert(1)>`"],
			[`<p>see (https://x.test/a).${code} www.x.test/a${code} ftp://x.test/f${code}</p>`, "see (https\\://x.test/a).`<img src=x onerror=alert(1)>` www\\.x.test/a`<img src=x onerror=alert(1)>` ftp\\://x.test/f`<img src=x onerror=alert(1)>`"],
			[`<p><b>see https://x.test/a. </b>${code}</p>`, "**see <https://x.test/a>.**`<img src=x onerror=alert(1)>`"],
			[`<p><a>https://x.test/a</a>${code}</p>`, "https\\://x.test/a`<img src=x onerror=alert(1)>`"],
			[`<p><img alt="https://x.test/a">${code}</p>`, "[Image: https\\://x.test/a]`<img src=x onerror=alert(1)>`"],
			[`<p><a href="https://y.test/">t <code>a\`b</code> https://x.test/a</a>${code}</p>`, "[t ``a`b`` https\\://x.test/a](<https://y.test/>)`<img src=x onerror=alert(1)>`"],
			[`<p><a href="https://y.test/"><input type="checkbox"> <img alt="pic"></a>${code}</p>`, "[&#91; &#93;  &#91;Image: pic&#93;](<https://y.test/>)`<img src=x onerror=alert(1)>`"],
		];
		for (const [html, md] of pages) {
			expect({ html, md: htmlToMarkdown(html) }).toEqual({ html, md });
			expect({ html, live: htmlIn(md) }).toEqual({ html, live: [] });
			expect({ html, shown: render(md).includes("<code>&lt;img src=x onerror=alert(1)&gt;</code>") }).toEqual({ html, shown: true });
		}
		// An address with a space or the end of its block after it is written as it always was, and so is a link's.
		const same: [string, string][] = [
			["<p>See https://x.test/a</p><ul><li>www.x.test</li></ul>", "See https://x.test/a\n\n- www.x.test"],
			["<p>https://x.test/a <b>bold</b> and <i>it</i> ftp://x.test/f</p>", "https://x.test/a **bold** and *it* ftp://x.test/f"],
			['<p><a href="https://x.test/a">https://x.test/a</a> <a href="https://y.test/">https://x.test/a</a> <code>c</code></p>', "<https://x.test/a> [https://x.test/a](https://y.test/) `c`"],
			['<p><a href="https://y.test/">words</a> <img src="https://x.test/p.png" alt="p"> <code>c</code></p>', "[words](https://y.test/) ![p](https://x.test/p.png) `c`"],
			['<ul><li><a name="t"><input type="checkbox" checked> Done</a></li></ul>', "- [x] Done"],
		];
		for (const [html, md] of same) expect({ html, md: htmlToMarkdown(html) }).toEqual({ html, md });
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
	/** The pieces of inline code (<code>) written so far. */
	spans: Code[];
	summary: boolean;
	/** Tags left open or never opened. */
	broken: boolean;
	/** How often a code block is written where one may stand (the rest are words): 0 for a page with none. */
	blocksEvery: number;
	/**
	 * A page with none of the shapes on which the converter may leave a piece of inline code out (a table caption, a
	 * closing tag with a space in it, a block inside a heading): on it every piece of inline code must be shown.
	 * On any other page a piece may be lost with what holds it; what is asked of every page is that none is HTML.
	 */
	calm: boolean;
}

/** Text as a page writes it: the characters HTML keeps for itself as references, by name or by number. */
const written = (r: Rng, text: string) =>
	text.replace(/[&<>]/g, (ch) => (r.next() < 0.3 ? `&#${ch.charCodeAt(0)};` : r.next() < 0.2 ? `&#x${ch.charCodeAt(0).toString(16)};` : ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as Record<string, string>)[ch]!));

// With addresses among them, as a page has them in its text: a reader of Markdown makes a link of each and reads on.
const WORDS = ["see https://x.test/a", "www.x.test/a", "(ftp://x.test/f).", "HTTPS://X.test", "https://x.test/?a=1&amp;b=2", "Run the query", "then", "Sample", "x1", "a", "B1_0", "INL0", "snake_case", "50%", "C#", "*", "**b**", "`", "[x](y)", "# ", "- ", "> ", "|", "1. ", "&copy;", "<DataSource>", '<script>alert("w")</script>', "</details>", "\\", "~~~", "```", "---", "===", "<!-- x -->"];
const words = (p: Page) => written(p.r, Array.from({ length: 1 + p.r.int(3) }, () => p.r.pick(WORDS)).join(p.r.pick([" ", " ", "  ", "\n"])));

/** What code is made of here: marks of Markdown, of tables and of HTML, fences, look-alikes of the converter's own marks. */
const codeBits = (tagName: string) => ["x = 1", ":RETURN 1;", "SELECT * FROM T", "a | b", "a \\| b", "\\|", "||", "\\", "`", "``", "```", "````", "`````", "~~~", `<${tagName}>`, `<script>alert("${tagName}")</script>`, "</details>", "<details>", "<!-- c -->", "-->", "&amp;", "&lt;", "# h", "- l", "> q", "| t |", "|---|", "[l](u)", "*x*", "$&", "$1", "B1_0", "INL0", "</pre", "<br>", "1. n", "    ", "\t", "==="];

function pre(p: Page): string {
	if (p.r.next() >= p.blocksEvery) return words(p);
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
 * Inline code with backticks, pipes, a backslash before a pipe, and tags in it. It stands where a page may put it:
 * right beside other inline code, right after a backtick of the text or an address, or with space around it.
 */
function span(p: Page): string {
	const id = p.spans.length;
	const text = `C${id}L0 ${Array.from({ length: p.r.int(4) }, () => p.r.pick(codeBits(`c${id}`))).join(" ")}`.trim();
	p.spans.push({ id, lines: [text], inSummary: p.summary || p.broken });
	const before = p.r.next();
	const after = p.r.next();
	return `${before < 0.2 ? "`" : before < 0.3 ? "&#96;" : before < 0.6 ? " " : ""}<code>${written(p.r, text)}</code>${after < 0.5 ? " " : after < 0.6 ? "`" : ""}`;
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
	if (roll < 0.7) return tag(p, "blockquote", blocks(p, depth - 1, inList, true));
	if (roll < 0.78) {
		const was = p.summary;
		p.summary = true;
		const summary = p.r.next() < 0.85 ? tag(p, "summary", p.r.next() < 0.8 ? inline(p, 1) : blocks(p, depth - 1)) : "";
		p.summary = was;
		return tag(p, "details", summary + blocks(p, depth - 1, inList, inQuote));
	}
	if (roll < 0.9) {
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
 * What is wrong with the Markdown made of one page:
 * - a NUL in it;
 * - a line of code that the rendered page does not show (so: lost, or read as markup). Asked of the code under the
 *   letters in `mustShow` only;
 * - text of code inside a piece of HTML, for marked or for lezer. Code in a summary stands inside the summary's
 *   HTML by design, as words: there only a tag of the code that is a tag again counts;
 * - the heading and the paragraph after everything are no heading and no paragraph at the top of the document.
 * `html` ends with `<h6>ZH</h6><p>ZP</p>`. `codes` is the code to look for, under the letter its words begin with.
 */
function wrong(html: string, codes: Record<string, Code[]>, mustShow = "KC"): string[] {
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
		if (lost !== undefined && mustShow.includes(prefix)) found.push(`not shown: ${JSON.stringify(lost)}`);
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

describe("many pages, with inline code everywhere", () => {
	const page = (r: Rng, kind: { calm: boolean; blocksEvery: number }): Page => ({ r, blocks: [], spans: [], summary: false, broken: !kind.calm && r.next() < 0.5, ...kind });

	test("deep and broken pages: no code, block or inline, is HTML for either reader, and the end of the page is still read", () => {
		// Half of the pages have code blocks wherever one may stand, the others few or none: a list with no code block
		// in it was written another way, and inline code on such a page was what the old test did not follow.
		const r = seeded(21);
		let spansSeen = 0;
		for (let round = 0; round < 3000; round++) {
			const p = page(r, { calm: false, blocksEvery: round % 2 ? 1 : r.pick([0, 0, 0.1, 0.5]) });
			const html = `${blocks(p, 1 + r.int(4))}<h6>ZH</h6><p>ZP</p>`;
			spansSeen += p.spans.length;
			// On a broken page a piece of inline code may be lost with the tag that held it: it must not be HTML.
			expect(wrong(html, { K: p.blocks, C: p.spans }, "K")).toEqual([]);
		}
		expect(spansSeen).toBeGreaterThan(8000);
	}, 300_000);

	test("well-formed pages: every piece of inline code is shown as code too, beside other code, backticks, addresses and blocks", () => {
		const r = seeded(22);
		let spansSeen = 0;
		for (let round = 0; round < 2500; round++) {
			const p = page(r, { calm: true, blocksEvery: round % 2 ? 1 : 0 });
			const html = `${blocks(p, 1 + r.int(3))}<h6>ZH</h6><p>ZP</p>`;
			spansSeen += p.spans.length;
			expect(wrong(html, { K: p.blocks, C: p.spans })).toEqual([]);
		}
		expect(spansSeen).toBeGreaterThan(4000);
	}, 300_000);
});

// ---- B5-5 ----

describe("B5-5. the text of a ticket is text: nothing of it is a heading, code, a table or HTML unless a node said so", () => {
	const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
	const para = (...content: unknown[]) => ({ type: "paragraph", content });
	const text = (words: string, ...marks: string[]) => ({ type: "text", text: words, marks: marks.map((type) => ({ type })) });
	const linked = (words: string, href: string, ...marks: string[]) => ({ type: "text", text: words, marks: [...marks.map((type) => ({ type })), { type: "link", attrs: { href } }] });
	const br = { type: "hardBreak" };
	const task = (...content: unknown[]) => ({ type: "taskList", content: [{ type: "taskItem", attrs: { state: "TODO" }, content }] });
	const div = '<div style="position:fixed;inset:0">x</div>';

	test("text marked as code that holds an empty line is code, a line at a time, and no HTML", () => {
		const md = adfToMarkdown(doc(para(text(`a\n\n${div}`, "code"))));
		expect(md).toBe(`\`a\`  \n\`${div}\``);
		expect(render(md)).toBe('<p><code>a</code><br><code>&lt;div style=&quot;position:fixed;inset:0&quot;&gt;x&lt;/div&gt;</code></p>');
		expect(htmlIn(md)).toEqual([]);
		// With a carriage return for the line end, in a link, and in a list.
		expect(adfToMarkdown(doc(para(text(`a\r\n\r\n${div}\r`, "code"))))).toBe(`\`a\`  \n\`${div}\``);
		expect(adfToMarkdown(doc(para(linked("x\n\ny", "https://docs.example/a", "code"))))).toBe("[`x`  \n`y`](https://docs.example/a)");
		expect(adfToMarkdown(doc({ type: "bulletList", content: [{ type: "listItem", content: [para(text("# a\n\n# b", "code"))] }] }))).toBe("- `# a`  \n  `# b`");
		// Code on one line is written as it always was.
		expect(adfToMarkdown(doc(para(text("a`b", "code"), text(" and "), text("`edge", "code"))))).toBe("``a`b`` and `` `edge ``");
	});

	test("the second line of a task item stands under the first, and is no heading, list or quotation", () => {
		const md = adfToMarkdown(doc(task(text("one"), br, text("# big heading"), br, text("- item"), br, text("> quote"))));
		expect(md).toBe("- [ ] one  \n  \\# big heading  \n  \\- item  \n  \\> quote");
		expect(render(md)).toBe('<ul><li><input disabled="" type="checkbox"> one<br># big heading<br>- item<br>&gt; quote</li></ul>');
		const tree = readByLezer(md);
		expect(tree.top.map((node) => node.name)).toEqual(["BulletList"]);
		// One line is written as it always was.
		expect(adfToMarkdown(doc(task(text("Asked the lab"))))).toBe("- [ ] Asked the lab");
	});

	test("words of a node of no known kind are a paragraph's: a line of them that begins with # is no heading", () => {
		expect(adfToMarkdown(doc({ type: "noteBlock", content: [text("a"), br, text("# b")] }))).toBe("a  \n\\# b");
		expect(adfToMarkdown(doc({ type: "noteBlock", text: "a\n\n# b\n\n    <b>c" }))).toBe("a  \n  \n\\# b  \n  \n&lt;b>c");
	});

	test("a carriage return in a code block inside a quotation does not put the rest of its line outside the block", () => {
		const md = adfToMarkdown(doc({ type: "blockquote", content: [{ type: "codeBlock", content: [text("x\r<script>alert(1)</script>\r\ny")] }] }));
		expect(md).toBe("> ```\n> x\n> <script>alert(1)</script>\n> y\n> ```");
		expect(htmlIn(md)).toEqual([]);
	});

	test("space before a line, a line of dashes and pipes, and an address before code make nothing of the text", () => {
		// Four spaces after an empty line made code of the line, where "&lt;div>" is shown as written.
		const indented = adfToMarkdown(doc(para(text(`x\n\n    ${div}`))));
		expect(indented).toBe('x  \n  \n&lt;div style="position:fixed;inset:0">x&lt;/div>');
		expect(render(indented)).toBe('<p>x  </p><p>&lt;div style=&quot;position:fixed;inset:0&quot;&gt;x&lt;/div&gt;</p>');
		// "a|b" and "-|-" under it are a table for Markdown.
		const table = adfToMarkdown(doc(para(text("a|b"), br, text("-|-"), br, text("c|d"))));
		expect(table).toBe("a|b  \n\\-|-  \nc|d");
		expect(readByLezer(table).top.map((node) => node.name)).toEqual(["Paragraph"]);
		// An address in running text is read on to the next space: through the backtick of the code after it.
		for (const node of [para(text("see www.docs.example/a"), text(div, "code")), para({ type: "status", attrs: { text: "see https://docs.example/a" } }, text(div, "code")), para(text("HTTPS://docs.example/a"), text(div, "code")), para(linked("a\n\nb", "https://docs.example/a"), text(div, "code")), para(text("`"), text(div, "code")), para(text("a", "code"), text(`${div}\``, "code", "strong"))]) {
			const md = adfToMarkdown(doc(node));
			expect({ md, live: htmlIn(md) }).toEqual({ md, live: [] });
			expect({ md, shown: render(md).includes("&lt;div style=&quot;position:fixed;inset:0&quot;&gt;x&lt;/div&gt;") }).toEqual({ md, shown: true });
		}
		expect(adfToMarkdown(doc(para(text("see www.docs.example/a"), text("x", "code"))))).toBe("see www\\.docs.example/a`x`");
		expect(adfToMarkdown(doc(para(text("`"), text("x", "code"), text("y", "code", "strong"))))).toBe("&#96;`xy`");
		expect(adfToMarkdown(doc(para(linked("a\n\nb", "https://docs.example/a"), text("x", "code"))))).toBe("[a  \nb](<https://docs.example/a>)`x`");
	});

	test("many tickets whose text holds every mark of Markdown and HTML: only what the nodes say is structure", () => {
		// The trees have paragraphs, lists, task lists and quotations and nothing else: so a heading, a code block, a
		// table, a rule or a piece of HTML in the Markdown came from the text.
		const BITS = ["word", "Sample 12", "# big", "## h", "- item", "+ x", "1. one", "2) two", "> quote", "---", "===", "- - -", "***", "___", "```", "~~~", "    four", "\tx", "a|b", "-|-", "|---|", ":-:|:-", "| a | b |", div, "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "</details>", "<!-- c -->", "<b>", "&lt;", "&amp;", "`", "``", "\\", "\\|", "*x*", "_y_", "[l](javascript:alert(1))", "![p](x)", "[^1]: note", "[ref]: http://x.test", "\n", "\n\n", "\r", "\r\n", "\r\n\r\n", " ", "  ", "$&", "==m==", "#tag", "<https://x.test>", "https://x.test/a", "www.x.test/a", "ftp://x.test/f"];
		const r = seeded(31);
		let items = 0;
		let quotes = 0;
		const words = () => {
			const t = `T ${Array.from({ length: 1 + r.int(4) }, () => r.pick(BITS)).join(r.pick(["", " ", " ", "\n"]))}`;
			const marks = r.next() < 0.3 ? [{ type: "code" }] : r.next() < 0.3 ? [{ type: r.pick(["strong", "em", "strike"]) }] : r.next() < 0.1 ? [{ type: "link", attrs: { href: r.pick(["https://x.test/a", "javascript:alert(1)", "x y"]) } }] : [];
			return { type: "text", text: t, marks };
		};
		// Every line of words has words in it: an item with none is an empty item, which is no matter of the text.
		const line = () => [words(), ...Array.from({ length: r.int(4) }, () => (r.next() < 0.2 ? br : r.next() < 0.05 ? { type: r.pick(["mention", "status", "emoji"]), attrs: { text: `M ${r.pick(BITS)}` } } : words()))];
		const block = (depth: number): unknown => {
			const roll = r.next();
			if (depth <= 0 || roll < 0.45) return para(...line());
			if (roll < 0.6) return { type: "bulletList", content: Array.from({ length: 1 + r.int(3) }, () => (items++, { type: "listItem", content: Array.from({ length: 1 + r.int(2) }, () => block(depth - 1)) })) };
			if (roll < 0.7) return { type: "orderedList", content: Array.from({ length: 1 + r.int(3) }, () => (items++, { type: "listItem", content: [block(depth - 1)] })) };
			if (roll < 0.85) return { type: "taskList", content: Array.from({ length: 1 + r.int(3) }, () => (items++, { type: "taskItem", attrs: { state: r.pick(["TODO", "DONE"]) }, content: line() })) };
			if (roll < 0.93) return quotes++, { type: r.pick(["blockquote", "panel"]), content: Array.from({ length: 1 + r.int(2) }, () => block(depth - 1)) };
			return { type: "noteBlock", content: r.next() < 0.5 ? line() : [block(depth - 1)] };
		};
		const count = (tokens: Token[], seen: Record<string, number> = {}, html: string[] = []) => {
			for (const token of tokens as any[]) {
				seen[token.type] = (seen[token.type] ?? 0) + 1;
				if (token.type === "html") html.push(token.raw);
				if (token.type === "list") {
					seen.items = (seen.items ?? 0) + token.items.length;
					for (const item of token.items) count(item.tokens, seen, html);
				} else if (token.tokens) count(token.tokens, seen, html);
			}
			return { seen, html };
		};
		// The tags the importer writes itself, for marks that stars cannot say.
		const own = /^<\/?(?:strong|em|del|code|br)>$/;
		for (let round = 0; round < 2500; round++) {
			items = 0;
			quotes = 0;
			const tree = doc(...Array.from({ length: 1 + r.int(3) }, () => block(2)));
			const md = adfToMarkdown(tree);
			const { seen, html } = count(marked.lexer(md, { gfm: true }));
			const byLezer = readByLezer(md);
			const names = new Set<string>();
			const cursor = lezer.parse(md).cursor();
			do names.add(cursor.name);
			while (cursor.next());
			const found = [
				...["heading", "code", "table", "hr"].filter((kind) => seen[kind]).map((kind) => `marked: a ${kind}`),
				...html.filter((piece) => !own.test(piece.trim())).map((piece) => `marked: HTML ${piece}`),
				...byLezer.html.filter((piece) => !own.test(piece.trim())).map((piece) => `lezer: HTML ${piece}`),
				...["ATXHeading1", "ATXHeading2", "SetextHeading1", "SetextHeading2", "FencedCode", "CodeBlock", "Table", "HorizontalRule", "HTMLBlock", "CommentBlock"].filter((name) => names.has(name)).map((name) => `lezer: ${name}`),
				...((seen.items ?? 0) === items ? [] : [`marked: ${seen.items ?? 0} items for ${items}`]),
				...((seen.blockquote ?? 0) === quotes ? [] : [`marked: ${seen.blockquote ?? 0} quotations for ${quotes}`]),
			];
			expect(found.length ? [...found, `ticket: ${JSON.stringify(tree)}`, `markdown: ${JSON.stringify(md)}`] : []).toEqual([]);
		}
	}, 300_000);
});

// ---- Word files ----

const crcTable = Array.from({ length: 256 }, (_x, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
	let c = 0xffffffff;
	for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
/** An archive as Word writes one: each entry packed, then the directory of them all, then the record that ends it. */
function zip(entries: { name: string; data: string | Uint8Array }[]): Uint8Array {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	const directory: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
		const packed = new Uint8Array(deflateRawSync(raw));
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(8, 8, true);
		lv.setUint32(14, crc32(raw), true);
		lv.setUint32(18, packed.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		const listed = new Uint8Array(46 + name.length);
		const cv = new DataView(listed.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(10, 8, true);
		cv.setUint32(16, crc32(raw), true);
		cv.setUint32(20, packed.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		listed.set(name, 46);
		parts.push(local, packed);
		directory.push(listed);
		offset += local.length + packed.length;
	}
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, directory.reduce((sum, part) => sum + part.length, 0), true);
	ev.setUint32(16, offset, true);
	const all = [...parts, ...directory, end];
	const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of all) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wordDocument = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}</w:body></w:document>`;
const relationships = (items: { id: string; target: string; type?: string }[]) =>
	`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map((item) => `<Relationship Id="${item.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${item.type ?? "hyperlink"}" Target="${xml(item.target)}"${item.type ? "" : ' TargetMode="External"'}/>`).join("")}</Relationships>`;

describe("B11-9. a link in a Word file is judged as a link in a page is: after its character references are read", () => {
	const link = (id: string, words: string) => `<w:p><w:hyperlink r:id="${id}"><w:r><w:t>${xml(words)}</w:t></w:r></w:hyperlink></w:p>`;
	/** The Markdown of a document with one link to each address, a paragraph each. */
	const imported = (targets: string[]) =>
		parseDocxToMarkdown(zip([{ name: "word/document.xml", data: wordDocument(targets.map((_target, at) => link(`rId${at}`, `L${at}`)).join("")) }, { name: "word/_rels/document.xml.rels", data: relationships(targets.map((target, at) => ({ id: `rId${at}`, target }))) }]), "Links.docx").markdown.split(/\n+/);

	// Every spelling of a scheme that runs something: a name or a number for one of its characters, with the ";" and
	// without it, a tab or a line end inside it, any case, space before it.
	const REFUSED = [
		"javascript:alert(1)",
		"javascript&colon;alert(1)",
		"JaVaScRiPt&colon;alert(1)",
		"&#106;avascript:alert(1)",
		"&#x6A;avascript:alert(1)",
		"java&#115;cript&#58;alert(1)",
		"javascript&#58alert(1)",
		"javascript&#x3A%0Aalert(1)",
		"javascript&#x3A;alert(1)",
		"jav&Tab;ascript:alert(1)",
		"jav&NewLine;ascript:alert(1)",
		"jav\tascript:alert(1)",
		"java\nscript:alert(1)",
		"  javascript:alert(1)",
		"&#32;&#9;javascript:alert(1)",
		"vbscript:msgbox(1)",
		"VBScript&colon;msgbox(1)",
		"data:text/html,x",
		"data&colon;text/html,x",
		"DATA:image/png;base64,AAAA",
	];

	test("no spelling of javascript:, vbscript: or data: is written as a link", () => {
		const lines = imported(REFUSED);
		for (const [at, target] of REFUSED.entries()) {
			expect({ target, line: lines[at] }).toEqual({ target, line: `L${at}` });
			// What a renderer makes of the line has no link in it.
			expect({ target, html: render(lines[at]!) }).toEqual({ target, html: `<p>L${at}</p>` });
		}
	});

	test("the page importer decides each of them the same way", () => {
		for (const target of REFUSED) {
			const md = htmlToMarkdown(`<p><a href="${target.replace(/"/g, "&quot;")}">words</a></p>`);
			expect({ target, md }).toEqual({ target, md: "words" });
		}
	});

	test("an address that is kept is written so that Markdown reads it back as it was judged", () => {
		const kept: [string, string][] = [
			["https://docs.example/a?x=1&y=2", "[L0](https://docs.example/a?x=1&y=2)"],
			["https://docs.example/a (b)", "[L1](https://docs.example/a%20%28b%29)"],
			["docs/x.md", "[L2](docs/x.md)"],
			["mailto:lab@docs.example", "[L3](mailto:lab@docs.example)"],
			// Markdown reads a character's name in an address as the character, so it is read here too, and written as
			// what it was read as. A name with no ";" is none.
			["docs/a&copy=1&lt;b", "[L4](docs/a&copy=1%3Cb)"],
			["docs/R&amp;D.md", "[L5](docs/R&D.md)"],
			// A Word file's links are held to more than a page's: these two a page keeps.
			["file:///srv/share/x", "L6"],
			["//docs.example/x", "L7"],
		];
		const lines = imported(kept.map(([target]) => target));
		for (const [at, [target, line]] of kept.entries()) expect({ target, line: lines[at] }).toEqual({ target, line });
		expect(render(lines[5]!)).toBe('<p><a href="docs/R&amp;D.md">L5</a></p>');
	});
});

describe("B11-12. a Word file that was cut short says so", () => {
	const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));
	const body = `<w:p><w:r><w:t>Before the picture.</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip r:embed="rImg"/></w:drawing></w:r></w:p><w:p><w:hyperlink r:id="rLink"><w:r><w:t>the guide</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:t>After.</w:t></w:r></w:p>`;
	const whole = zip([
		{ name: "[Content_Types].xml", data: "<Types/>" },
		{ name: "word/document.xml", data: wordDocument(body) },
		{ name: "word/_rels/document.xml.rels", data: relationships([{ id: "rImg", target: "media/image1.png", type: "image" }, { id: "rLink", target: "https://docs.example/guide" }]) },
		{ name: "word/media/image1.png", data: png },
	]);
	const at = (text: string, from = 0) => Buffer.from(whole).indexOf(text, from);
	const DAMAGED = /^This Word file is damaged: it was cut short, or part of it cannot be read\. What could be read was imported\./;

	test("a whole file imports with its picture and its link, and no word of damage", () => {
		const read = parseDocxToMarkdown(whole, "Guide.docx");
		expect(read.markdown).toBe("Before the picture.\n\n{{DOCX_IMG:image1.png}}\n\n[the guide](https://docs.example/guide)\n\nAfter.");
		expect(read.images.map((image) => image.name)).toEqual(["image1.png"]);
		expect(read.warnings).toBeUndefined();
	});

	test("a file that ends early is imported as far as it goes, and the first thing said is that it is damaged", () => {
		const directory = Buffer.from(whole).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
		const cuts: [string, Uint8Array, string, number][] = [
			["its last ten bytes gone", whole.subarray(0, whole.length - 10), "Before the picture.\n\n{{DOCX_IMG:image1.png}}\n\n[the guide](https://docs.example/guide)\n\nAfter.", 1],
			["cut in its directory", whole.subarray(0, directory + 60), "Before the picture.\n\n{{DOCX_IMG:image1.png}}\n\n[the guide](https://docs.example/guide)\n\nAfter.", 1],
			["cut in the picture", whole.subarray(0, at("word/media/") + 40), "Before the picture.\n\n[the guide](https://docs.example/guide)\n\nAfter.", 0],
			["cut before the part that holds the links", whole.subarray(0, at("word/_rels/") - 30), "Before the picture.\n\nthe guide\n\nAfter.", 0],
		];
		for (const [name, bytes, markdown, images] of cuts) {
			const read = parseDocxToMarkdown(bytes, "Guide.docx");
			expect({ name, markdown: read.markdown, images: read.images.length }).toEqual({ name, markdown, images });
			expect({ name, said: DAMAGED.test(read.warnings?.[0] ?? "") }).toEqual({ name, said: true });
		}
	});

	test("so is a file whose directory names a part that is not there, or one that does not unpack", () => {
		// The middle of the file lost and its end kept: the picture's entry is overwritten, the directory still names it.
		const holed = whole.slice();
		holed.fill(0, at("word/media/") - 30, at("word/media/") + 20);
		const read = parseDocxToMarkdown(holed, "Guide.docx");
		expect(read.markdown).toBe("Before the picture.\n\n[the guide](https://docs.example/guide)\n\nAfter.");
		expect(DAMAGED.test(read.warnings?.[0] ?? "")).toBe(true);
		// The packed bytes of the links part spoiled.
		const spoiled = whole.slice();
		spoiled.fill(0xff, at("word/_rels/document.xml.rels") + 28, at("word/_rels/document.xml.rels") + 40);
		const second = parseDocxToMarkdown(spoiled, "Guide.docx");
		expect(second.markdown).toContain("Before the picture.");
		expect(DAMAGED.test(second.warnings?.[0] ?? "")).toBe(true);
	});

	test("a file cut before its text is refused, as it was", () => {
		expect(() => parseDocxToMarkdown(whole.subarray(0, 120), "Guide.docx")).toThrow(/Guide\.docx is not a Word document that can be read here\..*cut short/);
	});

	test("the import hands the warning on to the window: it is in what the backend answers", async () => {
		const root = join(base, "ws-word");
		mkdirSync(join(root, "docs"), { recursive: true });
		const source = join(base, "Guide.docx");
		writeFileSync(source, whole.subarray(0, at("word/media/") + 40));
		const host: Host = { app: "test", kind: "app", emit: () => {}, pick: async () => null, trash: async () => {}, quit: () => {} };
		const backend = createBackend(host, root);
		try {
			await backend.ready;
			const fromFile = await backend.api.importDocFile({ sourcePath: source, destDir: join(root, "docs") });
			expect(DAMAGED.test(fromFile?.warnings?.[0] ?? "")).toBe(true);
			expect(readFileSync(fromFile!.path, "utf8")).toBe("Before the picture.\n\n[the guide](https://docs.example/guide)\n\nAfter.\n");
			const dropped = await backend.api.importDocxBytes({ fileName: "Dropped.docx", base64: Buffer.from(whole.subarray(0, whole.length - 10)).toString("base64"), destDir: join(root, "docs") });
			expect(DAMAGED.test(dropped.warnings?.[0] ?? "")).toBe(true);
			const fine = await backend.api.importDocxBytes({ fileName: "Whole.docx", base64: Buffer.from(whole).toString("base64"), destDir: join(root, "docs") });
			expect(fine.warnings).toBeUndefined();
		} finally {
			backend.dispose();
		}
	});
});

describe("a Word file: text in a code font is code wherever it stands, as it is in a page", () => {
	const run = (text: string, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
	const CODE = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>';
	const img = "<img src=x onerror=alert(1)>";
	const read = (body: string) =>
		parseDocxToMarkdown(zip([{ name: "word/document.xml", data: wordDocument(`<w:p>${body}</w:p>`) }, { name: "word/_rels/document.xml.rels", data: relationships([{ id: "rLink", target: "https://docs.example/guide" }]) }]), "Code.docx").markdown;

	test("an address, a backtick or other code straight before it does not make HTML of it", () => {
		const pages: [string, string][] = [
			// An address in the text is read on to the next space: through the backtick that opens the code.
			[run("see https://docs.example/a") + run(img, CODE), "see <https://docs.example/a>`<img src=x onerror=alert(1)>`"],
			[run("see www.docs.example/a") + run(img, CODE), "see www\\.docs.example/a`<img src=x onerror=alert(1)>`"],
			[run("see https://docs.example/a.", "<w:b/>") + run(img, CODE), "**see <https://docs.example/a>.**`<img src=x onerror=alert(1)>`"],
			[`<w:hyperlink r:id="rLink">${run("a ")}${run("x`y", CODE)}${run(" guide")}</w:hyperlink>${run(img, CODE)}`, "[a ``x`y`` guide](<https://docs.example/guide>)`<img src=x onerror=alert(1)>`"],
			// After "\`" the editor's reader takes the next backtick for more of the same run.
			[run("a `") + run(img, CODE), "a &#96;`<img src=x onerror=alert(1)>`"],
			// Two runs of code with different marks ran their backticks together.
			[run("a", CODE) + run(`${img}\`\``, `${CODE}<w:b/>`), "``` a<img src=x onerror=alert(1)>`` ```"],
		];
		for (const [body, md] of pages) {
			expect({ body, md: read(body) }).toEqual({ body, md });
			expect({ md, live: htmlIn(md) }).toEqual({ md, live: [] });
			expect({ md, shown: /<code>[^<]*&lt;img src=x onerror=alert\(1\)&gt;[^<]*<\/code>/.test(render(md)) }).toEqual({ md, shown: true });
		}
	});

	test("an address with a space or the end of its paragraph after it is written as it always was", () => {
		expect(read(run("see https://docs.example/a and ") + run("x", CODE))).toBe("see https://docs.example/a and `x`");
		expect(read(run("see https://docs.example/a"))).toBe("see https://docs.example/a");
		expect(read(`<w:hyperlink r:id="rLink">${run("the guide")}</w:hyperlink>${run(" and ")}${run("x", CODE)}`)).toBe("[the guide](https://docs.example/guide) and `x`");
		expect(read(`<w:hyperlink r:id="rLink">${run("https://docs.example/guide")}</w:hyperlink>`)).toBe("<https://docs.example/guide>");
	});
});
