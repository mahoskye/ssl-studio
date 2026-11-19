import { describe, expect, test } from "bun:test";
import { adfToMarkdown, isAdf } from "../src/shared/adf";
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
