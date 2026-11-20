// Links by name: which document a name means, and what is read from between the brackets.
import { describe, expect, test } from "bun:test";
import { docByName, nameBeingWritten, nameChoices, nameFor, namedLink, namedLinksIn } from "../src/shared/namedLinks";
import type { DocFile } from "../src/shared/protocol";

const doc = (path: string, more: Partial<DocFile> = {}): DocFile => ({ path, name: path.split("/").pop()!, group: "docs", exists: true, ...more });
const root = "/work/project";
const files: DocFile[] = [
	doc("/work/project/docs/tickets/DEMO-103.md", { group: "tickets", ticket: "DEMO-103", title: "A report of the samples due soon" }),
	doc("/work/project/docs/specs/Late samples.md", { group: "specs", title: "Late samples on the report" }),
	doc("/work/project/docs/knowledge/decisions/Decisions.md", { group: "knowledge", title: "What was decided" }),
	doc("/work/project/docs/README.md", { title: "The documents" }),
	doc("/work/project/README.md", { group: "project", title: "Due dates" }),
	doc("/work/project/docs/Gone.md", { exists: false, title: "Gone" }),
];

describe("what stands between the brackets", () => {
	test("is a name", () => {
		expect(namedLink("DEMO-103")).toEqual({ name: "DEMO-103" });
		expect(namedLink("  Late samples  ")).toEqual({ name: "Late samples" });
	});
	test("with the words to show after a bar", () => {
		expect(namedLink("DEMO-103|the report")).toEqual({ name: "DEMO-103", words: "the report" });
		expect(namedLink("Late samples | a | b")).toEqual({ name: "Late samples", words: "a | b" });
	});
	test("with a heading after a hash", () => {
		expect(namedLink("Decisions#Rush work")).toEqual({ name: "Decisions", heading: "Rush work" });
		expect(namedLink("Decisions#Rush work|why")).toEqual({ name: "Decisions", heading: "Rush work", words: "why" });
	});
	test("is nothing to go by without a name", () => {
		expect(namedLink("")).toBeNull();
		expect(namedLink("   ")).toBeNull();
		expect(namedLink("#a heading")).toBeNull();
		expect(namedLink("|words")).toBeNull();
	});
});

describe("the document a name means", () => {
	const path = (name: string) => docByName(name, files, root)?.path ?? null;
	test("is a ticket by its key, whatever its capitals", () => {
		expect(path("DEMO-103")).toBe("/work/project/docs/tickets/DEMO-103.md");
		expect(path("demo-103")).toBe("/work/project/docs/tickets/DEMO-103.md");
	});
	test("is a file by its name, with or without its ending", () => {
		expect(path("Late samples")).toBe("/work/project/docs/specs/Late samples.md");
		expect(path("late samples.md")).toBe("/work/project/docs/specs/Late samples.md");
		expect(path("Decisions")).toBe("/work/project/docs/knowledge/decisions/Decisions.md");
	});
	test("is a file by its path from the project's folder", () => {
		expect(path("docs/specs/Late samples")).toBe("/work/project/docs/specs/Late samples.md");
		expect(path("docs\\README.md")).toBe("/work/project/docs/README.md");
	});
	test("is a document by what it calls itself", () => {
		expect(path("What was decided")).toBe("/work/project/docs/knowledge/decisions/Decisions.md");
		expect(path("due dates")).toBe("/work/project/README.md");
	});
	test("is the file at that path before a file of that name elsewhere", () => {
		expect(path("README")).toBe("/work/project/README.md");
		expect(path("docs/README")).toBe("/work/project/docs/README.md");
	});
	test("is the first as links are offered, where two files of one name answer", () => {
		const two = [
			doc("/work/project/docs/specs/INDEX.md", { group: "specs" }),
			doc("/work/project/docs/tickets/INDEX.md", { group: "tickets" }),
			doc("/work/project/docs/knowledge/INDEX.md", { group: "knowledge" }),
		];
		expect(docByName("INDEX", two, root)?.path).toBe("/work/project/docs/tickets/INDEX.md");
		expect(docByName("docs/specs/INDEX", two, root)?.path).toBe("/work/project/docs/specs/INDEX.md");
	});
	test("is a file's name before another document's title", () => {
		const two = [doc("/work/project/docs/a.md", { title: "Plan" }), doc("/work/project/docs/Plan.md", { title: "Other" })];
		expect(docByName("Plan", two, root)?.path).toBe("/work/project/docs/Plan.md");
	});
	test("is none for a name nothing answers to, and for a file that is not there", () => {
		expect(path("Nothing")).toBeNull();
		expect(path("Gone")).toBeNull();
		expect(path("")).toBeNull();
	});
});

describe("the name to write for a document", () => {
	test("is a ticket's key, or the file's name without its ending", () => {
		expect(nameFor(files[0]!, files, root)).toBe("DEMO-103");
		expect(nameFor(files[1]!, files, root)).toBe("Late samples");
		const dotted = doc("/work/project/docs/notes.v2.md");
		expect(nameFor(dotted, [dotted], root)).toBe("notes.v2");
	});
	test("is its path from the project's folder where another document answers to its name", () => {
		const catalogs = [
			doc("/work/project/docs/tickets/INDEX.md", { group: "tickets" }),
			doc("/work/project/docs/specs/INDEX.md", { group: "specs" }),
			doc("/work/project/docs/README.md"),
			doc("/work/project/README.md", { group: "project" }),
			doc("/work/project/docs/specs/DEMO-1.md", { group: "specs" }),
			doc("/work/project/docs/tickets/DEMO-1.md", { group: "tickets", ticket: "DEMO-1" }),
		];
		const names = catalogs.map((file) => nameFor(file, catalogs, root));
		expect(names).toEqual(["INDEX", "docs/specs/INDEX", "docs/README", "README", "docs/specs/DEMO-1", "DEMO-1"]);
	});
	test("leads back to the document, whichever it is", () => {
		for (const file of files.filter((f) => f.exists)) expect(docByName(nameFor(file, files, root)!, files, root)).toBe(file);
	});
	test("is none for a file whose name cannot stand between the brackets", () => {
		const sharp = doc("/work/project/docs/C# notes.md");
		const barred = doc("/work/project/docs/a|b.md");
		expect(nameFor(sharp, [sharp, barred], root)).toBeNull();
		expect(nameFor(barred, [sharp, barred], root)).toBeNull();
	});
});

describe("a name being written", () => {
	test("is what follows the two brackets, up to the cursor", () => {
		expect(nameBeingWritten("See [[")).toBe("");
		expect(nameBeingWritten("See [[DEMO")).toBe("DEMO");
		expect(nameBeingWritten("See [[Late sam")).toBe("Late sam");
	});
	test("is none outside a link, past its bar or hash, or in code", () => {
		expect(nameBeingWritten("See [DEMO")).toBeNull();
		expect(nameBeingWritten("See [[DEMO-103]] and")).toBeNull();
		expect(nameBeingWritten("See [[DEMO-103|the")).toBeNull();
		expect(nameBeingWritten("See [[DEMO-103#Wh")).toBeNull();
		expect(nameBeingWritten("as in `[[DEMO")).toBeNull();
	});
});

describe("links by name in a piece of text", () => {
	test("are found in order, each with its place", () => {
		const text = "See [[DEMO-103]] and [[Late samples|the spec]].";
		const found = namedLinksIn(text);
		expect(found.map((f) => text.slice(f.from, f.to))).toEqual(["[[DEMO-103]]", "[[Late samples|the spec]]"]);
		expect(found.map((f) => f.link)).toEqual([{ name: "DEMO-103" }, { name: "Late samples", words: "the spec" }]);
	});
	test("are not found where the brackets hold no name or do not close", () => {
		expect(namedLinksIn("[[]] and [[#h]] and [[open")).toEqual([]);
		expect(namedLinksIn("a[1][[2]]")).toHaveLength(1);
	});
});

describe("the names offered while a link by name is written", () => {
	test("are the documents that exist but this one, tickets first, each by the name to write", () => {
		const offered = nameChoices(files, "/work/project/docs/README.md", root);
		expect(offered.map((o) => o.name)).toEqual(["DEMO-103", "Late samples", "Decisions", "README"]);
		expect(offered.map((o) => o.detail)).toEqual(["docs/tickets/DEMO-103.md", "docs/specs/Late samples.md", "docs/knowledge/decisions/Decisions.md", "README.md"]);
		expect(offered[0]).toEqual({ label: "DEMO-103 A report of the samples due soon", detail: "docs/tickets/DEMO-103.md", name: "DEMO-103" });
	});
	test("lead to the document chosen and not back to the one being written in", () => {
		const here = "/work/project/README.md";
		const others = files.filter((file) => file.path !== here);
		const offered = nameChoices(others, here, root, files);
		const docsReadme = offered.find((one) => one.detail === "docs/README.md")!;
		expect(docsReadme.name).toBe("docs/README");
		for (const one of offered) expect(docByName(one.name, files, root)?.path).toBe(`${root}/${one.detail}`);
	});
	test("each lead to the document they were offered for", () => {
		const offered = nameChoices(files, "/work/project/docs/Gone.md", root);
		expect(offered).toHaveLength(5);
		for (const one of offered) expect(docByName(one.name, files, root)?.path).toBe(`${root}/${one.detail}`);
	});
});
