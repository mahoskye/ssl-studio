import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linksTo, listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { docChecks } from "../src/shared/docChecks";
import { fileLinks, frontPaths, linkBeingWritten, linkChoices, linkFile, withLinkFile, withLinkFiles } from "../src/shared/docLinks";
import type { DocFile } from "../src/shared/protocol";

describe("the file a link names", () => {
	test("is the link without what follows ? or #", () => {
		expect(linkFile("../specs/Due-dates.md#how-it-is-checked")).toBe("../specs/Due-dates.md");
		expect(linkFile("../../scripts/Late.ssl#L12-L18")).toBe("../../scripts/Late.ssl");
		expect(linkFile("notes.md?plain=1")).toBe("notes.md");
	});
	test("reads an escaped space, and keeps a % that is no escape", () => {
		expect(linkFile("My%20notes.md")).toBe("My notes.md");
		expect(linkFile("100%.md")).toBe("100%.md");
	});
	test("is nothing for the web, a mail address, another host, or a place in the same document", () => {
		for (const href of ["https://example.com/a.md", "mailto:someone@example.com", "//example.com/a.md", "#a-heading", "", "C:\\notes.md"]) expect(linkFile(href)).toBe("");
	});
});

describe("the links of a document", () => {
	test("are those that name a file, each with its line", () => {
		const text = ["---", "status: open", "---", "", "# A ticket", "", "See [the spec](../specs/Due.md#checks) and [the site](https://example.com).", "", "![a chart](chart.png)"].join("\n");
		expect(fileLinks(text)).toEqual([
			{ href: "../specs/Due.md#checks", file: "../specs/Due.md", line: 7, column: 15 },
			{ href: "chart.png", file: "chart.png", line: 9, column: 11 },
		]);
	});
	test("a link in code is not one", () => {
		expect(fileLinks("Write `[a](b.md)` for a link.\n\n```md\n[c](d.md)\n```\n\n    [e](f.md)\n")).toEqual([]);
	});
	test("a reference written apart from its text is one, placed where it is written", () => {
		expect(fileLinks("See [the notes][n] first.\n\n[n]: notes/first.md\n")).toEqual([{ href: "notes/first.md", file: "notes/first.md", line: 3, column: 5 }]);
	});
	test("a link in a table and in a list is read", () => {
		const text = "| Doc | About |\n| --- | --- |\n| [A](a.md) | first |\n\n- [B](b.md)\n  - [C](<my c.md>)\n";
		expect(fileLinks(text).map((link) => [link.file, link.line])).toEqual([
			["a.md", 3],
			["b.md", 5],
			["my c.md", 6],
		]);
	});
	test("the same link twice is placed twice", () => {
		expect(fileLinks("[a](a.md)\n\n[again](a.md)\n").map((link) => link.line)).toEqual([1, 3]);
	});
	test("front matter that looks like a link is not read, and Windows line ends count the same lines", () => {
		expect(fileLinks("---\r\ntitle: \"[x](y.md)\"\r\n---\r\n\r\n[a](a.md)\r\n")).toEqual([{ href: "a.md", file: "a.md", line: 5, column: 4 }]);
	});
	test("a document with no links costs nothing and gives none", () => {
		expect(fileLinks("# Plain\n\nNothing to follow here.\n")).toEqual([]);
	});
});

describe("the check for links that lead nowhere", () => {
	const doc = (over: Partial<DocFile>): DocFile => ({ path: "/p/docs/tickets/T-1.md", name: "T-1.md", group: "tickets", exists: true, ticket: "T-1", ...over });
	test("names the file, and goes to its line", () => {
		const checks = docChecks([doc({ broken: [{ href: "../specs/Gone.md#checks", line: 12, column: 4 }] })]);
		expect(checks).toContainEqual({ level: "warn", text: "T-1 links to a file that is not there: ../specs/Gone.md", path: "/p/docs/tickets/T-1.md", line: 12 });
	});
	test("names two and counts the rest, each file once", () => {
		const broken = ["a.md", "a.md#x", "b.md", "c.md", "d.md"].map((href, i) => ({ href, line: i + 1, column: 0 }));
		const check = docChecks([doc({ broken })]).find((c) => c.text.includes("not there"));
		expect(check?.text).toBe("T-1 links to 4 files that are not there: a.md, b.md and 2 more");
	});
	test("a catalog that is out of date is said once, as out of date", () => {
		const catalog = doc({ path: "/p/docs/tickets/INDEX.md", name: "INDEX.md", ticket: undefined, catalog: { stale: true }, broken: [{ href: "T-9.md", line: 4, column: 8 }] });
		const texts = docChecks([catalog, doc({})]).map((c) => c.text);
		expect(texts.filter((text) => text.includes("not there"))).toEqual([]);
		expect(texts.some((text) => text.includes("out of date"))).toBe(true);
	});
});

describe("the listing says which links lead nowhere", () => {
	test("a link to a file that is there, outside the project, or on the web is not reported", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-links-"));
		try {
			mkdirSync(join(root, "docs", "tickets"), { recursive: true });
			mkdirSync(join(root, "docs", "specs"), { recursive: true });
			writeFileSync(join(root, "README.md"), "# A project\n\n[State](docs/STATE.md) and [the old notes](docs/old-notes.md).\n");
			writeFileSync(join(root, "docs", "specs", "Due.md"), "# Due dates\n\nFor [T-1](../tickets/T-1.md).\n");
			writeFileSync(
				join(root, "docs", "tickets", "T-1.md"),
				["---", "ticket: T-1", "---", "", "# Due dates", "", "- [the spec](../specs/Due.md#checks)", "- [a spec since renamed](../specs/Due-dates.md)", "- [from the top](/docs/specs/Due.md)", "- [from the top, gone](/docs/specs/Gone.md)", "- [another project](../../../elsewhere/README.md)", "- [the web](https://example.com/x.md)", ""].join("\n"),
			);
			const files = new WorkspaceFiles(root);
			const list = await listDocs(files, await readProject(root));
			const ticket = list.find((file) => file.name === "T-1.md");
			expect(ticket?.broken).toEqual([
				{ href: "../specs/Due-dates.md", line: 8, column: 25 },
				{ href: "/docs/specs/Gone.md", line: 10, column: 23 },
			]);
			expect(list.find((file) => file.name === "Due.md")?.broken).toBeUndefined();
			expect(list.find((file) => file.name === "README.md")?.broken).toEqual([
				{ href: "docs/STATE.md", line: 3, column: 8 },
				{ href: "docs/old-notes.md", line: 3, column: 43 },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("a link pointed at another file", () => {
	const text = "# T\n\nSee [the notes](../specs/Notes.md#columns) and [again](../specs/Notes.md).\n\n[one more](<../specs/My notes.md>)\n";
	test("has its file part rewritten on that line, and keeps what follows the mark", () => {
		expect(withLinkFile(text, 3, "../specs/Notes.md#columns", "../specs/reports/Notes.md")).toBe(text.replace("../specs/Notes.md#columns", "../specs/reports/Notes.md#columns"));
	});
	test("only the one link is changed, and a space is written as an escape", () => {
		const after = withLinkFile(text, 5, "../specs/My notes.md", "../kept/My notes.md");
		expect(after).toBe(text.replace("<../specs/My notes.md>", "<../kept/My%20notes.md>"));
	});
	test("is not made when the link is no longer on that line", () => {
		expect(withLinkFile(text, 1, "../specs/Notes.md", "x.md")).toBeNull();
		expect(withLinkFile(text, 99, "../specs/Notes.md", "x.md")).toBeNull();
	});
	test("Windows line ends are kept", () => {
		const windows = text.replace(/\n/g, "\r\n");
		expect(withLinkFile(windows, 3, "../specs/Notes.md#columns", "a.md")).toBe(windows.replace("../specs/Notes.md#columns", "a.md#columns"));
	});
});

describe("a link whose file was moved", () => {
	test("is offered the one file of its name elsewhere in the project, and the check can mend it", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-moved-"));
		try {
			mkdirSync(join(root, "docs", "tickets"), { recursive: true });
			mkdirSync(join(root, "docs", "specs", "reports"), { recursive: true });
			mkdirSync(join(root, "docs", "specs", "old"), { recursive: true });
			writeFileSync(join(root, "docs", "specs", "reports", "Report.md"), "# The report\n");
			writeFileSync(join(root, "docs", "specs", "reports", "Twice.md"), "# One\n");
			writeFileSync(join(root, "docs", "specs", "old", "Twice.md"), "# Another\n");
			writeFileSync(join(root, "docs", "tickets", "T-1.md"), "# T-1\n\n[the report](../specs/report.md#columns), [two of these](../specs/Twice.md), [none of these](../specs/Nowhere.md)\n");
			// A document of the same name as the file its link meant is not that file.
			writeFileSync(join(root, "docs", "specs", "reports", "Solo.md"), "# A spec\n");
			writeFileSync(join(root, "docs", "tickets", "Solo.md"), "# Notes on the spec\n\n[the spec](../specs/Solo.md)\n");
			const list = await listDocs(new WorkspaceFiles(root), await readProject(root));
			const ticket = list.find((file) => file.name === "T-1.md")!;
			expect(ticket.broken).toEqual([
				{ href: "../specs/report.md#columns", line: 3, column: 13, instead: "../specs/reports/Report.md" },
				{ href: "../specs/Twice.md", line: 3, column: 57 },
				{ href: "../specs/Nowhere.md", line: 3, column: 93 },
			]);
			expect(list.find((file) => file.group === "tickets" && file.name === "Solo.md")?.broken).toEqual([{ href: "../specs/Solo.md", line: 3, column: 11, instead: "../specs/reports/Solo.md" }]);
			const check = docChecks(list).find((c) => c.text.startsWith("T-1 ") && c.text.includes("not there"));
			expect(check?.fix).toEqual({ kind: "links", mends: [{ line: 3, column: 13, href: "../specs/report.md#columns", instead: "../specs/reports/Report.md" }] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("a check with nowhere to point has nothing to offer", () => {
		const checks = docChecks([{ path: "/p/docs/tickets/T-1.md", name: "T-1.md", group: "tickets", exists: true, ticket: "T-1", broken: [{ href: "gone.md", line: 2, column: 0 }] }]);
		expect(checks.find((c) => c.text.includes("not there"))?.fix).toBeUndefined();
	});
});

describe("several links pointed at new files", () => {
	test("two of the same link on one line are each rewritten once, though the new name holds the old", () => {
		const text = "[a](Notes.md) and [b](Notes.md#top)\n";
		const links = fileLinks(text);
		const { text: after, done } = withLinkFiles(text, links.map((link) => ({ line: link.line, column: link.column, href: link.href, instead: "kept/Notes.md" })));
		expect(done).toBe(2);
		expect(after).toBe("[a](kept/Notes.md) and [b](kept/Notes.md#top)\n");
	});
	test("a link that is no longer at its column is left, and the others are made", () => {
		const text = "[a](a.md)\n[b](b.md)\n";
		const { text: after, done } = withLinkFiles(text, [
			{ line: 1, column: 9, href: "a.md", instead: "x.md" },
			{ line: 2, column: 4, href: "b.md", instead: "y.md" },
		]);
		expect(done).toBe(1);
		expect(after).toBe("[a](a.md)\n[b](y.md)\n");
	});
});

describe("the links that lead to a file", () => {
	test("are found wherever they are written from, and into a folder", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-linksto-"));
		try {
			mkdirSync(join(root, "docs", "tickets"), { recursive: true });
			mkdirSync(join(root, "docs", "specs", "reports"), { recursive: true });
			writeFileSync(join(root, "docs", "specs", "reports", "Late.md"), "# Late\n\n[its neighbour](Soon.md)\n");
			writeFileSync(join(root, "docs", "specs", "reports", "Soon.md"), "# Soon\n");
			writeFileSync(join(root, "README.md"), "# P\n\n[late](docs/specs/reports/Late.md#checks) and [from the top](/docs/specs/reports/Late.md)\n");
			writeFileSync(join(root, "docs", "tickets", "T-1.md"), "# T-1\n\n```md\n[not a link](../specs/reports/Late.md)\n```\n\n[late](../specs/reports/Late.md) [soon](../specs/reports/Soon.md) [web](https://example.com/Late.md)\n");
			const files = new WorkspaceFiles(root);
			const short = (links: Awaited<ReturnType<typeof linksTo>>) => links.map((link) => [link.path.slice(root.length + 1).split("\\").join("/"), link.line, link.column, link.href, link.rest.split("\\").join("/"), link.from]).sort();
			expect(short(await linksTo(files, join(root, "docs", "specs", "reports", "Late.md")))).toEqual([
				["README.md", 3, 61, "/docs/specs/reports/Late.md", "", "top"],
				["README.md", 3, 7, "docs/specs/reports/Late.md#checks", "", "doc"],
				["docs/tickets/T-1.md", 7, 7, "../specs/reports/Late.md", "", "doc"],
			]);
			// A folder: everything that leads into it, with what follows the folder in each path.
			const into = short(await linksTo(files, join(root, "docs", "specs", "reports")));
			expect(into.map((link) => [link[0], link[3], link[4]]).sort()).toEqual([
				["README.md", "/docs/specs/reports/Late.md", "/Late.md"],
				["README.md", "docs/specs/reports/Late.md#checks", "/Late.md"],
				["docs/specs/reports/Late.md", "Soon.md", "/Soon.md"],
				["docs/tickets/T-1.md", "../specs/reports/Late.md", "/Late.md"],
				["docs/tickets/T-1.md", "../specs/reports/Soon.md", "/Soon.md"],
			]);
			// A file whose name another's begins with is not that file.
			expect(await linksTo(files, join(root, "docs", "specs", "reports", "Lat"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("where a link is placed in the text", () => {
	test("is where it is written as a link, not where the same words are an example", () => {
		const text = ["An example: `[a](x.md)`, and then [a](x.md).", "", "```md", "[b](y.md)", "```", "", "    [c](z.md)", "", "> [b](y.md) and [c](z.md)"].join("\n");
		expect(fileLinks(text).map((link) => [link.file, link.line, link.column])).toEqual([
			["x.md", 1, 38],
			["y.md", 9, 6],
			["z.md", 9, 20],
		]);
	});
	test("the name alone in the prose is not the link", () => {
		expect(fileLinks("Notes.md is linked [here](Notes.md).\n")[0]).toMatchObject({ line: 1, column: 26 });
	});
	test("a reference in a quotation is placed", () => {
		expect(fileLinks("> See [the notes][n].\n>\n> [n]: <my notes.md>\n")).toEqual([{ href: "my notes.md", file: "my notes.md", line: 3, column: 8 }]);
	});
});

describe("the files a document's front matter names", () => {
	test("are a ticket's specs and a spec's plan, each with its place", () => {
		const text = ["---", "ticket: T-1", 'specs: [design/Due.spec.md, "docs/specs/My spec.md"]', "plan: design/Due.plan.json", "plans:", "  - design/A.plan.json", "  - 'design/B.plan.json'", "related: [T-2]", "---", "", "specs: not/this.md"].join("\n");
		expect(frontPaths(text)).toEqual([
			{ value: "design/Due.spec.md", line: 3, column: 8 },
			{ value: "docs/specs/My spec.md", line: 3, column: 29 },
			{ value: "design/Due.plan.json", line: 4, column: 6 },
			{ value: "design/A.plan.json", line: 6, column: 4 },
			{ value: "design/B.plan.json", line: 7, column: 5 },
		]);
	});
	test("a document with no front matter names none", () => {
		expect(frontPaths("specs: [a.md]\n")).toEqual([]);
	});
	test("a path in front matter is rewritten as it is, with no escape", () => {
		const text = '---\nspecs: [design/Due.spec.md, "docs/specs/My spec.md"]\n---\n';
		const edits = frontPaths(text).map((named) => ({ line: named.line, column: named.column, href: named.value, instead: named.value.replace("specs/My spec", "specs/Our spec").replace("Due", "Due dates"), plain: true }));
		expect(withLinkFiles(text, edits)).toEqual({ text: '---\nspecs: [design/Due dates.spec.md, "docs/specs/Our spec.md"]\n---\n', done: 2 });
	});
});

describe("a rename finds the front matter that names the file", () => {
	test("a ticket's specs line is one of the places", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-front-"));
		try {
			mkdirSync(join(root, "docs", "tickets"), { recursive: true });
			mkdirSync(join(root, "design"), { recursive: true });
			writeFileSync(join(root, "design", "Due.spec.md"), "# Due\n");
			writeFileSync(join(root, "docs", "tickets", "T-1.md"), "---\nticket: T-1\nspecs: [design/Due.spec.md]\n---\n\n# T-1\n\nNo links here.\n");
			const found = await linksTo(new WorkspaceFiles(root), join(root, "design", "Due.spec.md"));
			expect(found.map((link) => [link.line, link.column, link.href, link.rest, link.from])).toEqual([[3, 8, "design/Due.spec.md", "", "root"]]);
			// The folder it is in: the path that follows the folder is kept.
			const into = await linksTo(new WorkspaceFiles(root), join(root, "design"));
			expect(into.map((link) => link.rest.split("\\").join("/"))).toEqual(["/Due.spec.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("the documents offered while a link is written", () => {
	const files: DocFile[] = [
		{ path: "/p/docs/tickets/T-1.md", name: "T-1.md", group: "tickets", exists: true, ticket: "T-1", title: "Due dates" },
		{ path: "/p/docs/specs/Due dates.md", name: "Due dates.md", group: "specs", exists: true, title: "The due date spec" },
		{ path: "/p/docs/knowledge/snippets/late.sql", name: "snippets/late.sql", group: "knowledge", exists: true },
		{ path: "/p/README.md", name: "README.md", group: "project", exists: false },
	];
	test("the work comes first, whatever order the listing has", () => {
		const mixed: DocFile[] = [{ path: "/p/AGENTS.md", name: "AGENTS.md", group: "project", exists: true }, ...files];
		expect(linkChoices(mixed, "/p/docs/x.md", "/p").map((choice) => choice.label)).toEqual(["T-1 Due dates", "The due date spec", "late.sql", "AGENTS.md"]);
	});
	test("are each called by what they are, and written as the way there from this document", () => {
		expect(linkChoices(files, "/p/docs/tickets/T-1.md", "/p")).toEqual([
			{ label: "The due date spec", detail: "docs/specs/Due dates.md", insert: "../specs/Due%20dates.md" },
			{ label: "late.sql", detail: "docs/knowledge/snippets/late.sql", insert: "../knowledge/snippets/late.sql" },
		]);
		expect(linkChoices(files, "/p/docs/specs/Due dates.md", "/p")[0]).toEqual({ label: "T-1 Due dates", detail: "docs/tickets/T-1.md", insert: "../tickets/T-1.md" });
	});
	test("are offered after the mark that opens a link's target, and nowhere else", () => {
		expect(linkBeingWritten("See [the spec](")).toBe("");
		expect(linkBeingWritten("See [the spec](../sp")).toBe("../sp");
		expect(linkBeingWritten("See [the spec](<../my sp")).toBeNull();
		expect(linkBeingWritten("See [the spec](<../sp")).toBe("../sp");
		expect(linkBeingWritten("See [the spec](a.md) and then")).toBeNull();
		expect(linkBeingWritten("A call(")).toBeNull();
		expect(linkBeingWritten("In code: `[a](")).toBeNull();
	});
});
