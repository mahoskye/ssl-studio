import { describe, expect, test } from "bun:test";
import { adfToMarkdown, isAdf } from "../src/shared/adf";
import { marked } from "marked";
import { ticketsFromJson } from "../src/shared/ticketImport";

// The shape is the one a public Jira Cloud site gives out for a description
// (its search API, version 3), read on 2026-11-19 for its node kinds and
// their fields only. Every word here is invented.

const text = (words: string, ...marks: string[]) => ({ type: "text", text: words, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const para = (...content: unknown[]) => ({ type: "paragraph", attrs: { localId: "8760a7416e59" }, content });
const item = (...content: unknown[]) => ({ type: "listItem", attrs: { localId: "48449eefd963" }, content });

const doc = {
	type: "doc",
	version: 1,
	content: [
		{ type: "heading", attrs: { level: 2, localId: "b0eeda27b921" }, content: [text("Where it happens")] },
		{ type: "bulletList", attrs: { localId: "bd8417f58306" }, content: [item(para(text("The morning report"))), item(para(text("Rush samples only"), { type: "hardBreak" }, { type: "hardBreak" }))] },
		{ type: "heading", attrs: { level: 2 }, content: [text("What happens")] },
		para(text("RunSQL", "code"), text(" returns a "), text("late", "strong"), text(" row twice, "), text("every", "em"), text(" morning. See "), { type: "text", text: "the notes", marks: [{ type: "link", attrs: { href: "https://example.test/notes (old)" } }] }, text(".")),
		{ type: "blockquote", attrs: { localId: "cf78b54ca826" }, content: [para(text("Each sample is listed once.")), para(text("Soonest first."))] },
		{ type: "orderedList", attrs: { order: 3 }, content: [item(para(text("Open the report")), { type: "bulletList", content: [item(para(text("as a supervisor")))] }), item(para(text("Look at a late sample")))] },
		{ type: "codeBlock", attrs: { language: "sql", localId: "9ef45df9", wrap: true }, content: [text("SELECT *\n  FROM DEMO_SAMPLES -- # not a heading\n")] },
		{ type: "codeBlock", attrs: { localId: "309a1d3d", wrap: true }, content: [text("uses ``` inside")] },
		{ type: "rule" },
		{
			type: "table",
			attrs: { isNumberColumnEnabled: false, layout: "default" },
			content: [
				{ type: "tableRow", content: [{ type: "tableHeader", attrs: {}, content: [para(text("Sample"))] }, { type: "tableHeader", attrs: {}, content: [para(text("Due"))] }] },
				{ type: "tableRow", content: [{ type: "tableCell", attrs: {}, content: [para(text("S-1 | S-2"))] }, { type: "tableCell", attrs: {}, content: [para(text("today"))] }] },
			],
		},
		{ type: "taskList", attrs: { localId: "t1" }, content: [{ type: "taskItem", attrs: { localId: "a", state: "DONE" }, content: [text("Asked the lab")] }, { type: "taskItem", attrs: { localId: "b", state: "TODO" }, content: [text("Asked the vendor")] }] },
		para(text("# is the sample's number, not a heading")),
		para(text("Ask "), { type: "mention", attrs: { id: "x1", text: "@the lab lead" } }, text(" by "), { type: "date", attrs: { timestamp: "1795046400000" } }, text(" "), { type: "emoji", attrs: { shortName: ":warning:", text: "⚠" } }, text(" "), { type: "inlineCard", attrs: { url: "https://example.test/browse/LAB-9" } }),
		{ type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { id: "m1", type: "file", collection: "" } }] },
		{ type: "aKindNotKnownHere", content: [para(text("Words in a node of a new kind are kept."))] },
	],
};

describe("a description that is a tree of nodes", () => {
	const markdown = adfToMarkdown(doc);
	test("is written as Markdown: the same headings, lists, code and links, every word as it was", () => {
		expect(markdown).toBe(
			[
				"## Where it happens",
				"",
				"- The morning report\n- Rush samples only",
				"",
				"## What happens",
				"",
				"`RunSQL` returns a **late** row twice, *every* morning. See [the notes](https://example.test/notes%20%28old%29).",
				"",
				"> Each sample is listed once.\n>\n> Soonest first.",
				"",
				"3. Open the report\n\n   - as a supervisor\n4. Look at a late sample",
				"",
				"```sql\nSELECT *\n  FROM DEMO_SAMPLES -- # not a heading\n```",
				"",
				"````\nuses ``` inside\n````",
				"",
				"---",
				"",
				"| Sample | Due |\n| --- | --- |\n| S-1 \\| S-2 | today |",
				"",
				"- [x] Asked the lab\n- [ ] Asked the vendor",
				"",
				"\\# is the sample's number, not a heading",
				"",
				"Ask @the lab lead by 2026-11-19 ⚠ <https://example.test/browse/LAB-9>",
				"",
				"*(an attachment, not brought across)*",
				"",
				"Words in a node of a new kind are kept.",
			].join("\n"),
		);
	});
	test("what is not such a tree is nothing, and a tree is told from text", () => {
		expect(adfToMarkdown(null)).toBe("");
		expect(adfToMarkdown("words")).toBe("");
		expect(isAdf(doc)).toBe(true);
		expect(isAdf("words")).toBe(false);
		expect(isAdf(null)).toBe(false);
	});
	test("a mark sits against its words, and code that holds a backtick is told from its fence", () => {
		expect(adfToMarkdown({ type: "doc", content: [para(text(" spaced ", "strong"), text("a`b", "code"), text(" and "), text("`edge", "code"))] })).toBe("**spaced** ``a`b`` and `` `edge ``");
	});
});

describe("an issue as Jira Cloud's search gives it", () => {
	const response = {
		issues: [
			{
				expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
				id: "115654",
				self: "https://lab.example.test/rest/api/3/issue/115654",
				key: "LAB-21",
				fields: {
					summary: "The report shows late samples twice",
					issuetype: { self: "https://lab.example.test/rest/api/3/issuetype/1", id: "1", description: "A problem.", iconUrl: "https://lab.example.test/x.png", name: "Bug", subtask: false, avatarId: 12143, hierarchyLevel: 0 },
					issuelinks: [],
					status: { self: "https://lab.example.test/rest/api/3/status/10002", description: "Awaiting review.", iconUrl: "https://lab.example.test/y.png", name: "Waiting for review", id: "10002", statusCategory: { self: "https://lab.example.test/rest/api/3/statuscategory/4", id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" } },
					description: doc,
				},
			},
		],
		nextPageToken: "abc",
		isLast: true,
	};
	const read = ticketsFromJson(response);
	test("is a ticket with its kind, its state and the page a person opens", () => {
		expect(read.tickets.map((t) => [t.key, t.type, t.status, t.source])).toEqual([["LAB-21", "Bug", "Waiting for review", "https://lab.example.test/browse/LAB-21"]]);
	});
	test("its description is Markdown, with its headings under the ticket's own sections", () => {
		const description = read.tickets[0]!.description;
		expect(description.startsWith("### Where it happens\n\n- The morning report\n- Rush samples only\n\n### What happens")).toBe(true);
		expect(description).toContain("```sql\nSELECT *\n  FROM DEMO_SAMPLES -- # not a heading\n```");
		expect(description).toContain("\\# is the sample's number, not a heading");
	});
});

// A fourth review (2026-11-19).
describe("words that look like marks, and nodes that hold their words elsewhere", () => {
	const md = (...content: unknown[]) => adfToMarkdown({ type: "doc", version: 1, content });
	test("a card on a line of its own keeps its address, and a caption its words", () => {
		expect(md(para(text("See:")), { type: "blockCard", attrs: { url: "https://example.test/browse/LAB-9" } })).toBe("See:\n\n<https://example.test/browse/LAB-9>");
		expect(md({ type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { id: "m1", type: "file" } }, { type: "caption", content: [text("The report, with the late row twice")] }] })).toBe("*(an attachment, not brought across)*\n\nThe report, with the late row twice");
		expect(md(para({ type: "mention", attrs: { id: "the-lab-lead" } }, text(" and "), { type: "inlineCard", attrs: { data: { name: "A page" } } }))).toBe("the-lab-lead and *(a linked page, not brought across)*");
	});
	test("a line that begins like a list, a heading, a quotation or a rule is written as words", () => {
		expect(md(para(text("1. Open the form")))).toBe("1\\. Open the form");
		expect(md(para(text("Steps:"), { type: "hardBreak" }, text("# first"), { type: "hardBreak" }, text("> second"), { type: "hardBreak" }, text("- third")))).toBe("Steps:  \n\\# first  \n\\> second  \n\\- third");
		expect(md(para(text("Title"), { type: "hardBreak" }, text("---")))).toBe("Title  \n\\---");
	});
	test("a character that would be a mark is written as itself; an underscore inside a word is left", () => {
		const said = "a*b*c and __init__ and snake_case and <ReportName> and `tick` and x[0](y) and ~~no~~ and C:\\dir";
		const markdown = md(para(text(said)));
		expect(shown(markdown)).toBe(said);
		expect(markdown).toContain("snake_case");
		expect(md(para(text("5 < 6 and a_b"), text(" *kept as code* ", "code")))).toBe("5 < 6 and a_b` *kept as code* `");
	});
	test("a line break inside a quotation is kept, and every blank line of a block of code", () => {
		expect(md({ type: "blockquote", content: [para(text("one"), { type: "hardBreak" }, text("two"))] })).toBe("> one  \n> two");
		expect(md({ type: "codeBlock", attrs: { language: "java" }, content: [text("class A {}\n\n\nclass B {}")] })).toBe("```java\nclass A {}\n\n\nclass B {}\n```");
	});
});

/** What a reader sees of Markdown: the page the renderer makes of it, without its tags. */
function shown(markdown: string): string {
	return (marked.parse(markdown, { gfm: true, async: false }) as string)
		.replace(/<br\s*\/?>/g, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\n+$/, "");
}

// A fifth review (2026-11-19): what the page shows is the test, not what the Markdown looks like.
describe("the page shows the words the ticket had", () => {
	const md = (...content: unknown[]) => adfToMarkdown({ type: "doc", version: 1, content });
	const same = (...content: unknown[]) => shown(md(...content));
	test("words that hold marks of their own, in a sentence", () => {
		for (const said of [
			"see http://localhost/<app>/api now",
			"[1]: https://example.com/spec",
			"5 &lt; 6 &amp; so on",
			"a~b~c and ~~x~~ and H~2~O",
			"price*qty and tax*rate",
			"C:\\Users\\<name>\\AppData",
			"an [x] in brackets and [link](not.md)",
			"_edge_ and __dunder__ and snake_case_name",
		])
			expect(same(para(text(said)))).toBe(said);
	});
	test("marked words that begin or end with a mark of their own", () => {
		expect(same(para(text("~2 hours", "strike"), text(" later")))).toBe("~2 hours later");
		expect(same(para(text("Note:", "strong"), text("text")))).toBe("Note:text");
		expect(same(para(text("C:\\Temp\\"), text("now", "strong")))).toBe("C:\\Temp\\now");
		expect(same(para(text("before "), text("<name>.log", "code")))).toBe("before <name>.log");
		expect(md(para(text("plain", "strong"), text(" and "), text("words", "em")))).toBe("**plain** and *words*");
	});
	test("a line of a paragraph that is only dashes stays a line of dashes", () => {
		const markdown = md(para(text("Thanks,"), { type: "hardBreak" }, text("--"), { type: "hardBreak" }, text("Bob")));
		expect(shown(markdown)).toBe("Thanks,\n--\nBob");
		// And through the import, where the headings are moved: nothing is taken for a heading.
		const imported = ticketsFromJson({ issues: [{ key: "LAB-1", fields: { summary: "T", description: { type: "doc", content: [para(text("Thanks,"), { type: "hardBreak" }, text("--"), { type: "hardBreak" }, text("Bob"))] } } }] });
		expect(shown(imported.tickets[0]!.description)).toBe("Thanks,\n--\nBob");
	});
	test("a heading that ends with its own mark, and a bullet that looks like a task", () => {
		expect(shown(md({ type: "heading", attrs: { level: 2 }, content: [text("Sample #")] }))).toBe("Sample #");
		const bullet = md({ type: "bulletList", content: [item(para(text("[x] done")))] });
		expect(shown(bullet).trim()).toBe("[x] done");
		expect((marked.parse(bullet, { gfm: true, async: false }) as string).includes("checkbox")).toBe(false);
	});
	test("code in a table's cell keeps its lines", () => {
		const table = md({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [para(text("Query"))] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "codeBlock", content: [text("SELECT 1\nFROM x")] }] }] }] });
		expect(table).toBe("| Query |\n| --- |\n| `SELECT 1`<br>`FROM x` |");
	});
});
