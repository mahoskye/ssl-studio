import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { docChecks } from "../src/shared/docChecks";
import { fileLinks, linkFile } from "../src/shared/docLinks";
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
			{ href: "../specs/Due.md#checks", file: "../specs/Due.md", line: 7 },
			{ href: "chart.png", file: "chart.png", line: 9 },
		]);
	});
	test("a link in code is not one", () => {
		expect(fileLinks("Write `[a](b.md)` for a link.\n\n```md\n[c](d.md)\n```\n\n    [e](f.md)\n")).toEqual([]);
	});
	test("a reference written apart from its text is one, placed where it is written", () => {
		expect(fileLinks("See [the notes][n] first.\n\n[n]: notes/first.md\n")).toEqual([{ href: "notes/first.md", file: "notes/first.md", line: 3 }]);
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
		expect(fileLinks("---\r\ntitle: \"[x](y.md)\"\r\n---\r\n\r\n[a](a.md)\r\n")).toEqual([{ href: "a.md", file: "a.md", line: 5 }]);
	});
	test("a document with no links costs nothing and gives none", () => {
		expect(fileLinks("# Plain\n\nNothing to follow here.\n")).toEqual([]);
	});
});

describe("the check for links that lead nowhere", () => {
	const doc = (over: Partial<DocFile>): DocFile => ({ path: "/p/docs/tickets/T-1.md", name: "T-1.md", group: "tickets", exists: true, ticket: "T-1", ...over });
	test("names the file, and goes to its line", () => {
		const checks = docChecks([doc({ broken: [{ href: "../specs/Gone.md#checks", line: 12 }] })]);
		expect(checks).toContainEqual({ level: "warn", text: "T-1 links to a file that is not there: ../specs/Gone.md", path: "/p/docs/tickets/T-1.md", line: 12 });
	});
	test("names two and counts the rest, each file once", () => {
		const broken = ["a.md", "a.md#x", "b.md", "c.md", "d.md"].map((href, i) => ({ href, line: i + 1 }));
		const check = docChecks([doc({ broken })]).find((c) => c.text.includes("not there"));
		expect(check?.text).toBe("T-1 links to 4 files that are not there: a.md, b.md and 2 more");
	});
	test("a catalog that is out of date is said once, as out of date", () => {
		const catalog = doc({ path: "/p/docs/tickets/INDEX.md", name: "INDEX.md", ticket: undefined, catalog: { stale: true }, broken: [{ href: "T-9.md", line: 4 }] });
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
				{ href: "../specs/Due-dates.md", line: 8 },
				{ href: "/docs/specs/Gone.md", line: 10 },
			]);
			expect(list.find((file) => file.name === "Due.md")?.broken).toBeUndefined();
			expect(list.find((file) => file.name === "README.md")?.broken).toEqual([
				{ href: "docs/STATE.md", line: 3 },
				{ href: "docs/old-notes.md", line: 3 },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
