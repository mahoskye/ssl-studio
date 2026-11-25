import { describe, expect, test } from "bun:test";
import { marked } from "marked";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExport } from "../src/bun/project";
import { parseCsv } from "../src/shared/csv";
import { importSummary, ticketsFromJson, ticketsFromTable } from "../src/shared/ticketImport";
import { toneOf } from "../src/shared/projectDocs";
import { wikiToMarkdown } from "../src/shared/wikiMarkup";

// The shapes are those a public Jira server gives out (its "all fields" CSV
// export and its search API), read on 2026-11-19 for their column names and
// their structure only. Every ticket here is invented.

const HEADER =
	"Summary,Issue key,Issue id,Parent id,Issue Type,Status,Project key,Project name,Priority,Resolution,Assignee,Reporter,Created,Labels,Labels,Description,Inward issue link (Blocker),Outward issue link (Reference),Outward issue link (Reference),Custom field (Epic Link),Custom field (Parent Link),Custom field (Rank),Sprint,Comment,Comment";
const csv = [
	HEADER,
	'Calendars for each site,LAB-10,50010,,Epic,In Progress,LAB,Lab,Major,,,,19/Nov/26 03:46,calendar,sites,"h2. Why\n\nEach site keeps {{holidays}} of its own.\n\n# first\n# second\n\n{code:sql}\nSELECT * FROM DEMO_HOLIDAYS\n{code}\n\nSee [the wiki|https://example.test/wiki].",,,,,,0|z26n5k:,,,',
	"A calendar table,LAB-11,50011,50010,Sub-task,Open,LAB,Lab,Minor,,,,19/Nov/26 03:50,,,Make the table.,LAB-12,LAB-13,LAB-14,,,0|z26n5l:,Sprint 4,,",
	"A screen to keep it,LAB-12,50012,,Story,Open,LAB,Lab,Minor,,,,19/Nov/26 03:51,,,Plain words only.,,,,LAB-10,,0|z26n5m:,,,",
	"Part of a ticket not in this export,LAB-13,50013,49999,Sub-task,Open,LAB,Lab,Minor,,,,19/Nov/26 03:52,,,,,,,,,0|z26n5n:,,,",
].join("\n");

describe("a table as a Jira server exports it", () => {
	const read = ticketsFromTable(parseCsv(csv));
	const ticket = (key: string) => read.tickets.find((t) => t.key === key)!;
	test("every row is a ticket, with its kind and its state", () => {
		expect(read.skipped).toBe(0);
		expect(read.tickets.map((t) => [t.key, t.type, t.status])).toEqual([
			["LAB-10", "Epic", "In Progress"],
			["LAB-11", "Sub-task", "Open"],
			["LAB-12", "Story", "Open"],
			["LAB-13", "Sub-task", "Open"],
		]);
	});
	test("a parent given by the system's number is the ticket of that number", () => {
		expect(ticket("LAB-11").parent).toBe("LAB-10");
	});
	test("a ticket with no parent is part of the epic it is linked to", () => {
		expect(ticket("LAB-12").parent).toBe("LAB-10");
	});
	test("a parent whose number no row has is left out: 49999 is not a ticket anyone could find", () => {
		expect(ticket("LAB-13").parent).toBeUndefined();
	});
	test("each link column gives its ticket, a column to a link", () => {
		expect(ticket("LAB-11").related).toEqual(["LAB-12", "LAB-13", "LAB-14"]);
	});
	test("the description comes across as Markdown", () => {
		expect(ticket("LAB-10").description).toBe("### Why\n\nEach site keeps `holidays` of its own.\n\n1. first\n1. second\n\n```sql\nSELECT * FROM DEMO_HOLIDAYS\n```\n\nSee [the wiki](https://example.test/wiki).");
		expect(ticket("LAB-12").description).toBe("Plain words only.");
	});
	test("people, rank and comments are not read; priority and sprint/release are preserved", () => {
		expect(Object.keys(ticket("LAB-11")).sort()).toEqual(["description", "key", "parent", "priority", "related", "release", "source", "status", "title", "type"]);
	});
});

describe("what a Jira server's search returns", () => {
	const json = {
		expand: "names,schema",
		startAt: 0,
		maxResults: 2,
		total: 2,
		issues: [
			{
				expand: "operations,versionedRepresentations,editmeta,changelog,renderedFields",
				id: "50011",
				self: "https://tickets.example.test/jira/rest/api/2/issue/50011",
				key: "LAB-11",
				fields: {
					summary: "A calendar table",
					issuetype: { self: "https://tickets.example.test/jira/rest/api/2/issuetype/7", id: "7", description: "A part of a ticket.", iconUrl: "https://tickets.example.test/x.png", name: "Sub-task", subtask: true, avatarId: 21146 },
					parent: { id: "50010", key: "LAB-10", self: "https://tickets.example.test/jira/rest/api/2/issue/50010", fields: { summary: "Calendars for each site", status: { name: "In Progress", id: "3", statusCategory: { id: 4, key: "indeterminate", colorName: "inprogress", name: "In Progress" } }, priority: { name: "Major", id: "3" }, issuetype: { id: "4", name: "Epic", subtask: false } } },
					subtasks: [],
					description: "Make the {{DEMO_HOLIDAYS}} table.\n\n* one row for each site and day",
					issuelinks: [
						{ id: "1", self: "https://tickets.example.test/jira/rest/api/2/issueLink/1", type: { id: "10", name: "Blocker", inward: "is blocked by", outward: "blocks" }, inwardIssue: { id: "50012", key: "LAB-12", fields: { summary: "A screen to keep it" } } },
						{ id: "2", type: { id: "11", name: "Reference", inward: "is related to", outward: "relates to" }, outwardIssue: { id: "50013", key: "LAB-13" } },
					],
					priority: { self: "https://tickets.example.test/jira/rest/api/2/priority/4", iconUrl: "https://tickets.example.test/y.png", name: "Minor", id: "4" },
					labels: [],
					status: { self: "https://tickets.example.test/jira/rest/api/2/status/1", description: "Open and ready.", iconUrl: "https://tickets.example.test/z.png", name: "Open", id: "1", statusCategory: { self: "https://tickets.example.test/jira/rest/api/2/statuscategory/2", id: 2, key: "new", colorName: "default", name: "To Do" } },
				},
				renderedFields: null,
			},
			{ id: "50010", self: "https://tickets.example.test/jira/rest/api/2/issue/50010", key: "LAB-10", fields: { summary: "Calendars for each site", issuetype: { name: "Epic", subtask: false }, subtasks: [{ id: "50011", key: "LAB-11", fields: { summary: "A calendar table" } }], description: null, issuelinks: [], status: { name: "In Progress" } } },
		],
		warningMessages: null,
		names: null,
		schema: null,
	};
	const read = ticketsFromJson(json);
	test("each issue is a ticket, with its parent, its links and its parts", () => {
		expect(read.skipped).toBe(0);
		expect(read.tickets.map((t) => [t.key, t.type, t.status, t.parent, t.related, t.blockedBy])).toEqual([
			["LAB-11", "Sub-task", "Open", "LAB-10", ["LAB-13"], ["LAB-12"]],
			["LAB-10", "Epic", "In Progress", undefined, ["LAB-11"], undefined],
		]);
	});
	test("the ticket's page is the address a person opens, not the API's", () => {
		expect(read.tickets[0]!.source).toBe("https://tickets.example.test/jira/browse/LAB-11");
	});
	test("a description in wiki markup comes across as Markdown, and one that is not there as nothing", () => {
		expect(read.tickets[0]!.description).toBe("Make the `DEMO_HOLIDAYS` table.\n\n- one row for each site and day");
		expect(read.tickets[1]!.description).toBe("");
	});
});

// The shapes are those GitHub gives out: its own command's ("gh issue list
// --json") and its API's, read on 2026-11-19 for their field names only.
// Every issue here is invented.
describe("issues as GitHub gives them out", () => {
	const cli = [
		{ body: "# Steps\n\n1. Open the report\n\nUses `${{ secrets.X }}` and {{ a template }}.", closed: false, labels: [{ id: "LA_1", name: "bug", description: "", color: "d73a4a" }], milestone: null, number: 12, state: "OPEN", title: "The report shows late samples twice", url: "https://github.com/example/lab/issues/12" },
		{ body: "", closed: true, labels: [], milestone: { number: 1, title: "First", description: "", dueOn: null }, number: 13, state: "CLOSED", title: "Holidays table", url: "https://github.com/example/lab/issues/13" },
	];
	const rest = [
		{ url: "https://api.github.com/repos/example/lab/issues/14", html_url: "https://github.com/example/lab/pull/14", id: 6400000001, node_id: "PR_x", number: 14, title: "Fix the report", user: { login: "someone", id: 1 }, labels: [], state: "closed", type: null, draft: false, pull_request: { url: "https://api.github.com/repos/example/lab/pulls/14", html_url: "https://github.com/example/lab/pull/14", merged_at: null }, body: "Closes #12", state_reason: null },
		{ url: "https://api.github.com/repos/example/lab/issues/12", html_url: "https://github.com/example/lab/issues/12", id: 6400000002, number: 12, title: "The report shows late samples twice", user: { login: "someone", id: 1 }, labels: [{ id: 1, name: "bug", color: "d73a4a", default: true, description: "" }], state: "closed", state_reason: "not_planned", type: { id: 5, name: "Bug", description: "", color: "red" }, sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 }, body: "## Steps\n\n1. Open the report" },
		{ url: "https://api.github.com/repos/example/lab/issues/15", html_url: "https://github.com/example/lab/issues/15", id: 6400000003, number: 15, title: "Done one", labels: [], state: "closed", state_reason: "completed", type: null, body: null },
	];
	test("its own command's: the body is what was asked, the state is a word, the page is the issue's", () => {
		const read = ticketsFromJson(cli);
		expect(read.tickets.map((t) => [t.key, t.status, t.source])).toEqual([
			["12", "open", "https://github.com/example/lab/issues/12"],
			["13", "closed", "https://github.com/example/lab/issues/13"],
		]);
		// Markdown is left as Markdown, its own "{{ }}" included; its headings go under the ticket's sections.
		expect(read.tickets[0]!.description).toBe("### Steps\n\n1. Open the report\n\nUses `${{ secrets.X }}` and {{ a template }}.");
		expect(read.tickets[1]!.description).toBe("");
	});
	test("its API's: a pull request is passed over, the page is the one a person opens, and why it was closed is said", () => {
		const read = ticketsFromJson(rest);
		expect(read.pulls).toBe(1);
		expect(read.tickets.map((t) => [t.key, t.status, t.type, t.source, t.description])).toEqual([
			["12", "not planned", "Bug", "https://github.com/example/lab/issues/12", "### Steps\n\n1. Open the report"],
			["15", "closed", undefined, "https://github.com/example/lab/issues/15", ""],
		]);
		expect(importSummary({ made: 2, updated: 0, same: 0, skipped: 0, pulls: 1 })).toBe("2 tickets: 2 new. 1 pull request was passed over: a change is not a ticket.");
		expect(importSummary({ made: 0, updated: 0, same: 0, skipped: 0, pulls: 2 })).toBe("No tickets there. 2 pull requests were passed over: a change is not a ticket.");
	});
	test("an issue that was not planned is set aside, not done", () => {
		expect(toneOf("not planned")).toBe("off");
		expect(toneOf("duplicate")).toBe("off");
		expect(toneOf("closed")).toBe("done");
	});
});

describe("a description from somewhere else", () => {
	test("Markdown from a system that writes Markdown keeps its marks, with its headings under the ticket's own", () => {
		const table = ticketsFromTable(parseCsv('ID,Title,Body,State\n12,A title,"# A heading\n\n## A lower one\n\n* a bullet\n\n```\n# not a heading\n```\n\nUse {{x}} as it is.",OPEN\n'));
		expect(table.tickets[0]!.description).toBe("### A heading\n\n#### A lower one\n\n* a bullet\n\n```\n# not a heading\n```\n\nUse {{x}} as it is.");
		expect(table.tickets[0]!.status).toBe("open");
	});
	test("headings that are already low enough, and a text with none, are left as they are", () => {
		const api = ticketsFromJson([{ number: 12, title: "A title", body: "### Low\n\n#### Lower\n\n#hashtag and # alone", state: "open" }, { number: 13, title: "Plain", body: "No headings here." }]);
		expect(api.tickets.map((t) => t.description)).toEqual(["### Low\n\n#### Lower\n\n#hashtag and # alone", "No headings here."]);
	});
});

describe("wiki markup as Markdown", () => {
	test("headings sit under the ticket's own, lists keep their depth", () => {
		expect(wikiToMarkdown("h1. Top\nh3. Lower\n# one\n## inside\n* a\n** b\n- plain dash")).toBe("### Top\n##### Lower\n1. one\n   1. inside\n- a\n  - b\n- plain dash");
		// The largest heading used is the third level, whichever it is; one in code does not count.
		expect(wikiToMarkdown("h3. Why\nh4. More\n{code}\nh1. not a heading\n{code}")).toBe("### Why\n#### More\n\n```\nh1. not a heading\n```");
	});
	test("code is fenced and left as written, whatever marks it holds", () => {
		expect(wikiToMarkdown("Before {{x}}.\n{code:title=Query|language=sql}\nSELECT '{{not this}}' -- h1. nor this\n{code}\nAfter.")).toBe("Before `x`.\n\n**Query**\n\n```sql\nSELECT '{{not this}}' -- h1. nor this\n```\n\nAfter.");
		expect(wikiToMarkdown("{noformat}\n# kept\n{noformat}")).toBe("```\n# kept\n```");
		expect(wikiToMarkdown("{code}\nuses ``` inside\n{code}")).toBe("````\nuses ``` inside\n````");
	});
	test("links, quotations, a table's heading row and colour", () => {
		expect(wikiToMarkdown("[the spec|https://example.test/spec|a tip] and [https://example.test]")).toBe("[the spec](https://example.test/spec) and <https://example.test>");
		expect(wikiToMarkdown("bq. one line\n{quote}\nsaid\nmore\n{quote}\nafter")).toBe("> one line\n> said\n> more\n\nafter");
		expect(wikiToMarkdown("||name||value||\n|a|1|")).toBe("| name | value |\n| --- | --- |\n|a|1|");
		expect(wikiToMarkdown("{color:red}urgent{color} words")).toBe("urgent words");
	});
	test("what it does not know, and every word, is left as it was", () => {
		expect(wikiToMarkdown("A plain sentence, with _lines_ and {a brace} and 2 * 3 * 4.")).toBe("A plain sentence, with _lines_ and {a brace} and 2 \\* 3 \\* 4.");
	});
	// A fourth review (2026-11-19).
	test("a heading inside a quotation is a heading, and nothing is thrown", () => {
		expect(wikiToMarkdown("{quote}h1. Heading{quote}")).toBe("> ### Heading");
		expect(wikiToMarkdown("{quote}h2. Heading\ntext\n{quote}\nh3. Lower")).toBe("> ### Heading\n> text\n\n#### Lower");
		expect(wikiToMarkdown("no headings at all")).toBe("no headings at all");
	});
	test("words after a quotation are not part of it", () => {
		expect(wikiToMarkdown("{quote}\nsaid\n{quote}\nOur answer.")).toBe("> said\n\nOur answer.");
		expect(wikiToMarkdown("bq. said\nOur answer.")).toBe("> said\n\nOur answer.");
	});
	test("a rule does not make a heading of the line above it", () => {
		expect(wikiToMarkdown("text\n----\nmore")).toBe("text\n\n---\n\nmore");
	});
	test("bold there is bold here, and a word in angle brackets stays a word", () => {
		expect(wikiToMarkdown("*bold* text and (*this too*), not 2*3*4.")).toBe("**bold** text and (**this too**), not 2\\*3\\*4.");
		expect(wikiToMarkdown("Open <ReportName> and {{<Tag>}} then [https://example.test]")).toBe("Open &lt;ReportName> and `<Tag>` then <https://example.test>");
	});
	test("a block's title is kept, and every blank line of its code", () => {
		expect(wikiToMarkdown("{code:title=Foo.java}\nclass A {}\n\n\nclass B {}\n{code}")).toBe("**Foo.java**\n\n```\nclass A {}\n\n\nclass B {}\n```");
		expect(wikiToMarkdown("{code:java|title=Foo.java}\nx\n{code}")).toBe("**Foo.java**\n\n```java\nx\n```");
	});
});

describe("an export read from where it was downloaded", () => {
	test("is a table or JSON at a whole path, read without its byte-order mark", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-export-"));
		try {
			writeFileSync(join(dir, "export.csv"), "\uFEFFIssue key,Summary\nLAB-1,One\n");
			expect(await readExport(join(dir, "export.csv"))).toBe("Issue key,Summary\nLAB-1,One\n");
			writeFileSync(join(dir, "notes.txt"), "not an export");
			await expect(readExport(join(dir, "notes.txt"))).rejects.toThrow("An export is a .csv, .tsv or .json file.");
			await expect(readExport(join(dir, "gone.json"))).rejects.toThrow("is not there.");
			await expect(readExport("export.csv")).rejects.toThrow("is not a whole path.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// A fourth review (2026-11-19).
describe("more of what the review found in the import", () => {
	test("a heading written with a line under it goes under the ticket's sections too, its words as they were", () => {
		const api = ticketsFromJson([{ number: 1, title: "T", body: "Title\n=====\n\nWords.\n\nLower\n-----\n\n- item\n---\n\nA paragraph\nof two lines\n---" }]);
		expect(api.tickets[0]!.description).toBe("### Title\n\nWords.\n\n#### Lower\n\n- item\n---\n\nA paragraph\nof two lines\n---");
	});
	test("a line in a block of HTML that keeps its lines is not a heading", () => {
		const api = ticketsFromJson([{ number: 1, title: "T", body: "# Real\n\n<pre>\n# not a heading\n</pre>\n\n<!--\n# nor this\n-->\n\n## Lower" }]);
		expect(api.tickets[0]!.description).toBe("### Real\n\n<pre>\n# not a heading\n</pre>\n\n<!--\n# nor this\n-->\n\n#### Lower");
	});
	test("a state that is a name in capitals is left as it was written", () => {
		const table = ticketsFromTable(parseCsv("Key,Summary,Status\nA-1,One,QA\nA-2,Two,UAT\nA-3,Three,ON HOLD\nA-4,Four,NOT_PLANNED\nA-5,Five,OPEN\n"));
		expect(table.tickets.map((t) => t.status)).toEqual(["QA", "UAT", "ON HOLD", "not planned", "open"]);
	});
	test("every blank line of a body is kept, in code and out of it", () => {
		const api = ticketsFromJson([{ number: 1, title: "T", body: "Before.\n\n\n```\na\n\n\nb\n```" }]);
		expect(api.tickets[0]!.description).toBe("Before.\n\n\n```\na\n\n\nb\n```");
	});
	test("a description that throws nothing: a heading inside a quotation, in a table's row", () => {
		const table = ticketsFromTable(parseCsv('Issue key,Summary,Description\nLAB-1,One,"{quote}h1. Heading{quote}"\n'));
		expect(table.tickets[0]!.description).toBe("> ### Heading");
	});
});

// A fifth review (2026-11-19): a line of dashes under something that is not a heading's words was taken for one.
describe("only what the renderer reads as a heading is moved", () => {
	const moved = (body: string) => ticketsFromJson([{ number: 1, title: "T", body }]).tickets[0]!.description;
	test("a line of dashes under code, under a list item's words, or under a tag is a rule, and stays", () => {
		expect(moved("# H\n\n    log line\n---")).toBe("### H\n\n    log line\n---");
		expect(moved("# H\n\n- item\n\n  para\n---")).toBe("### H\n\n- item\n\n  para\n---");
		expect(moved('## Steps\n\n<img src="a.png">\n---')).toBe('### Steps\n\n<img src="a.png">\n---');
	});
	test("a line in a block of HTML is not a heading", () => {
		expect(moved("# Real\n\n<div>\n# x\n</div>")).toBe("### Real\n\n<div>\n# x\n</div>");
	});
	test("a heading with a line under it is one wherever the renderer reads one", () => {
		expect(moved("## A\nSub\n---")).toBe("### A\n### Sub");
		expect(moved("```\ncode\n```\nResult\n======")).toBe("```\ncode\n```\n### Result");
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
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&amp;/g, "&")
		.replace(/\n+$/, "");
}

// A fifth review (2026-11-19): what the page shows is the test.
describe("the page shows the words a wiki description had", () => {
	test("stars, tildes, backslashes and angle brackets that are words", () => {
		for (const said of ["see *.srvscr,*.ssl files", "price*qty and tax*rate", "C:\\Users\\<name>\\AppData", "H~2~O and ~about~", "see http://localhost/<app>/api now", "a * b * c"]) expect(shown(wikiToMarkdown(said))).toBe(said);
	});
	test("a line of dashes or of = under a line of words stays a line", () => {
		expect(shown(wikiToMarkdown("Regards\n--\nBob"))).toBe("Regards\n--\nBob");
		expect(shown(wikiToMarkdown("text\n---"))).toBe("text\n---");
		expect(shown(wikiToMarkdown("text\n===="))).toBe("text\n====");
	});
	test("bold inside colour is bold", () => {
		expect(wikiToMarkdown("{color:red}*IMPORTANT*{color} and *this*.")).toBe("**IMPORTANT** and **this**.");
	});
});

// A sixth review (2026-11-19).
describe("more of a wiki description that the page must show as written", () => {
	test("a character written with a backslash is itself, as it is there", () => {
		expect(shown(wikiToMarkdown("\\_x\\_ and \\*y\\* and \\[z\\]"))).toBe("_x_ and *y* and [z]");
	});
	test("text in backticks is left as it is", () => {
		expect(shown(wikiToMarkdown("run `SELECT * FROM t` then"))).toBe("run SELECT * FROM t then");
	});
	test("an address keeps its marks, in brackets or in the sentence", () => {
		expect(wikiToMarkdown("[http://x.test/~u]")).toBe("<http://x.test/~u>");
		expect(shown(wikiToMarkdown("see http://x.test/~u/a*b_c. and more"))).toBe("see http://x.test/~u/a*b_c. and more");
		expect(wikiToMarkdown("[the ~wiki|https://example.test/a*b]")).toBe("[the \\~wiki](https://example.test/a*b)");
	});
	test("a tab in code does not stop the headings being moved, and a heading over a line keeps a # that ends it", () => {
		const moved = (body: string) => ticketsFromJson([{ number: 1, title: "T", body }]).tickets[0]!.description;
		expect(moved("# Steps\n\n```\nif x:\n\treturn\n```\n")).toBe("### Steps\n\n```\nif x:\n\treturn\n```");
		expect(moved("- a\n\t- b\n\n# After")).toBe("- a\n\t- b\n\n### After");
		expect(shown(moved("Title ##\n----"))).toBe("Title ##");
		expect(moved("Line one  \nline two\n---")).toBe("Line one  \nline two\n---");
	});
});
