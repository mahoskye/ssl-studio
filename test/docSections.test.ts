import { describe, expect, test } from "bun:test";
import { folderParts, folderSaid, IMPORT_TICKETS, kindOf, NEW_DOCUMENT, NEW_FOLDER, NEW_PLAN, NEW_REGISTRY, NEW_SPEC, NEW_TICKET, plainSection, schemaFolderOf, schemaOf, sectionFolder, sectionMenu, SHOW_FOLDER, typedDocument, typedParts, type DocSection } from "../src/shared/docSections";

const folders = { docs: "docs", schema: "db/schema", plans: "design" };
const sections: DocSection[] = ["work", "knowledge", "knowledge:decisions", "knowledge:questions", "knowledge:snippets", "knowledge:prompts", "knowledge:reference", "registries", "docs", "schema", "schema:database", "schema:interfaces", "schema:files", "schema:labels", "plans"];

describe("the folder of a list in the Docs panel", () => {
	test("is the one the project's settings name, or the one under the docs folder that the list keeps", () => {
		expect(sectionFolder("docs", folders)).toBe("docs");
		expect(sectionFolder("schema", folders)).toBe("db/schema");
		expect(sectionFolder("schema:database", folders)).toBe("db/schema/database");
		expect(sectionFolder("schema:labels", folders)).toBe("db/schema/labels");
		expect(schemaOf("schema:interfaces")?.one).toBe("interface message");
		expect(schemaOf("schema:labels")).toBeUndefined();
		// A known kind's folder written in other capitals is that kind, and what is made there goes in that folder.
		expect(schemaOf("schema:Database")?.id).toBe("database");
		expect(sectionFolder("schema:Database", folders)).toBe("db/schema/Database");
		expect(sectionMenu("schema:Database")).toEqual(["New table…", NEW_FOLDER, SHOW_FOLDER]);
		expect(schemaFolderOf("schema:labels")).toBe("labels");
		expect(schemaFolderOf("schema")).toBeUndefined();
		expect(sectionFolder("plans", folders)).toBe("design");
		expect(sectionFolder("work", folders)).toBe("docs/tickets");
		expect(sectionFolder("knowledge", folders)).toBe("docs/knowledge");
		expect(sectionFolder("registries", folders)).toBe("docs/registries");
	});

	test("is the kind's own for a kind of the knowledge base", () => {
		expect(sectionFolder("knowledge:decisions", folders)).toBe("docs/knowledge/decisions");
		expect(sectionFolder("knowledge:reference", { ...folders, docs: "notes" })).toBe("notes/knowledge/reference");
		expect(kindOf("knowledge:snippets")?.id).toBe("snippets");
		expect(kindOf("knowledge")).toBeUndefined();
	});
});

describe("a folder the project's settings put at the top", () => {
	test("has no part that is a dot, so what is made there is named as every listing names it", () => {
		const top = { docs: ".", schema: "./schema/", plans: "design" };
		expect(sectionFolder("docs", top)).toBe("");
		expect(sectionFolder("work", top)).toBe("tickets");
		expect(sectionFolder("knowledge:questions", top)).toBe("knowledge/questions");
		expect(sectionFolder("schema", top)).toBe("schema");
		expect(folderParts("./docs//guides/")).toEqual(["docs", "guides"]);
		expect(folderParts(".")).toEqual([]);
	});

	test("is said by name in a question, and any other folder with a slash after it", () => {
		expect(folderSaid("")).toBe("the project's folder");
		expect(folderSaid(".")).toBe("the project's folder");
		expect(folderSaid("docs/guides")).toBe("docs/guides/");
		expect(folderSaid("docs/guides/")).toBe("docs/guides/");
	});
});

describe("the menu of a list's heading", () => {
	test("ends, for every list, with a new folder and the folder's place in the Explorer", () => {
		for (const section of sections) expect(sectionMenu(section).slice(-2)).toEqual([NEW_FOLDER, SHOW_FOLDER]);
	});

	test("opens with what the list keeps", () => {
		expect(sectionMenu("docs")).toEqual([NEW_DOCUMENT, NEW_FOLDER, SHOW_FOLDER]);
		// The schema's own heading offers each kind it knows; a kind's heading offers its own.
		expect(sectionMenu("schema")).toEqual(["New table…", "New interface message…", "New file layout…", NEW_FOLDER, SHOW_FOLDER]);
		expect(sectionMenu("schema:database")).toEqual(["New table…", NEW_FOLDER, SHOW_FOLDER]);
		expect(sectionMenu("schema:interfaces")).toEqual(["New interface message…", NEW_FOLDER, SHOW_FOLDER]);
		expect(sectionMenu("schema:files")).toEqual(["New file layout…", NEW_FOLDER, SHOW_FOLDER]);
		// A folder of the project's own under the schema folder holds documents named by whoever writes them.
		expect(sectionMenu("schema:labels")).toEqual([NEW_DOCUMENT, NEW_FOLDER, SHOW_FOLDER]);
		expect(sectionMenu("knowledge:prompts")).toEqual(["New prompt…", NEW_FOLDER, SHOW_FOLDER]);
		expect(sectionMenu("plans")[0]).toBe(NEW_PLAN);
		expect(sectionMenu("registries")[0]).toBe(NEW_REGISTRY);
		expect(sectionMenu("work").slice(0, 3)).toEqual([NEW_TICKET, IMPORT_TICKETS, NEW_SPEC]);
		expect(sectionMenu("knowledge").slice(0, 5)).toEqual(["New decision…", "New question…", "New snippet…", "New prompt…", "New reference note…"]);
		expect(sectionMenu("knowledge:questions")).toEqual(["New question…", NEW_FOLDER, SHOW_FOLDER]);
	});

	test("names nothing twice", () => {
		for (const section of sections) expect(new Set(sectionMenu(section)).size).toBe(sectionMenu(section).length);
	});

	test("a plain document can be named straight into a new folder only where documents are plain", () => {
		expect(sections.filter(plainSection)).toEqual(["docs", "schema", "schema:database", "schema:interfaces", "schema:files", "schema:labels"]);
	});
});

describe("where a typed name puts a new folder", () => {
	test("a name is one folder, and a name with folders before it is each of them", () => {
		expect(typedParts("guides")).toEqual({ parts: ["guides"] });
		expect(typedParts("  guides/first steps ")).toEqual({ parts: ["guides", "first steps"] });
		expect(typedParts("guides\\setup")).toEqual({ parts: ["guides", "setup"] });
	});

	test("what a name cannot hold is written as a dash", () => {
		expect(typedParts('what: "why"?')).toEqual({ parts: ["what- -why-"] });
	});

	test("nothing typed leads out of the folder, or is no name at all", () => {
		expect(typedParts("")).toEqual({ problem: "A name is needed." });
		expect(typedParts("   ")).toEqual({ problem: "A name is needed." });
		for (const bad of ["..", "../outside", "guides/../..", "/guides", "guides/", "guides//setup", ".", "a/./b", "..."]) expect(typedParts(bad)).toEqual({ problem: `“${bad}” is not a name that can be used here.` });
	});

	test("a name that is not the same on every system is refused", () => {
		for (const bad of ["guides.", "guides./setup", "CON", "nul", "com1", "LPT9/x", "con.txt"]) expect(typedParts(bad)).toEqual({ problem: `“${bad}” is not a name that can be used here.` });
		expect(typedParts("console")).toEqual({ parts: ["console"] });
		expect(typedParts("com10")).toEqual({ parts: ["com10"] });
	});

	test("a folder no listing shows is refused, since nothing made there would be seen", () => {
		for (const hidden of ["build", "dist", "node_modules", ".git", ".ssl-studio", ".hutch"]) {
			expect(typedParts(hidden)).toEqual({ problem: `“${hidden}” is a folder the app leaves out of every list: nothing made there would be shown.` });
			expect(typedParts(`notes/${hidden}/more`)).toEqual({ problem: `“${hidden}” is a folder the app leaves out of every list: nothing made there would be shown.` });
		}
		expect(typedParts("builds")).toEqual({ parts: ["builds"] });
	});

	test("so is one that differs from it only in its capitals, which some disks do not tell apart", () => {
		expect(typedParts("Build")).toEqual({ problem: "“Build” is the folder “build” on a disk that does not tell capitals apart, and the app leaves that one out of every list." });
		expect(typedParts("notes/NODE_MODULES")).toEqual({ problem: "“NODE_MODULES” is the folder “node_modules” on a disk that does not tell capitals apart, and the app leaves that one out of every list." });
		expect(typedDocument("Dist/notes")).toEqual({ problem: "“Dist” is the folder “dist” on a disk that does not tell capitals apart, and the app leaves that one out of every list." });
		// A document is a file: called as one of them, with its ending, it is listed.
		expect(typedDocument("Build")).toEqual({ folders: [], file: "Build.md", title: "Build" });
		// So is a table described under its own name: BUILD and dist are tables like any other.
		expect(typedParts("BUILD", "file")).toEqual({ parts: ["BUILD"] });
		expect(typedParts("dist", "file")).toEqual({ parts: ["dist"] });
		expect(typedParts("build/ORDERS", "file")).toEqual({ problem: "“build” is a folder the app leaves out of every list: nothing made there would be shown." });
	});

	test("a name that only opens with a dot is a name", () => {
		expect(typedParts(".drafts")).toEqual({ parts: [".drafts"] });
	});
});

describe("where a typed name puts a new document", () => {
	test("a name is a Markdown file that opens with the name as its heading", () => {
		expect(typedDocument("Release notes")).toEqual({ folders: [], file: "Release notes.md", title: "Release notes" });
		expect(typedDocument("Release notes.md")).toEqual({ folders: [], file: "Release notes.md", title: "Release notes" });
		expect(typedDocument("NOTES.MD")).toEqual({ folders: [], file: "NOTES.md", title: "NOTES" });
	});

	test("folders before the name are the folders it goes in", () => {
		expect(typedDocument("guides/Intro")).toEqual({ folders: ["guides"], file: "Intro.md", title: "Intro" });
		expect(typedDocument("guides/setup/First run.md")).toEqual({ folders: ["guides", "setup"], file: "First run.md", title: "First run" });
	});

	test("the heading keeps what the file's name cannot hold", () => {
		expect(typedDocument("Why: a note?")).toEqual({ folders: [], file: "Why- a note-.md", title: "Why: a note?" });
	});

	test("a full stop at the end is the heading's, and the file's name leaves it off", () => {
		expect(typedDocument("What next.")).toEqual({ folders: [], file: "What next.md", title: "What next." });
		expect(typedDocument("guides/Wait...")).toEqual({ folders: ["guides"], file: "Wait.md", title: "Wait..." });
		expect(typedDocument("...")).toEqual({ problem: "“...” is not a name that can be used here." });
	});

	test("a full stop typed after the ending is the heading's too: the ending is not written twice", () => {
		expect(typedDocument("Intro.md.")).toEqual({ folders: [], file: "Intro.md", title: "Intro." });
		expect(typedDocument("guides/Intro.markdown... ")).toEqual({ folders: ["guides"], file: "Intro.md", title: "Intro..." });
		expect(typedDocument(".md.")).toEqual({ problem: "“.md.” is not a name that can be used here." });
		expect(typedDocument("a/..md.")).toEqual({ problem: "“a/..md.” is not a name that can be used here." });
	});

	test("an ending with no name before it is no name, however often it is typed", () => {
		expect(typedDocument(".md .md")).toEqual({ problem: "“.md .md” is not a name that can be used here." });
		expect(typedDocument("guides/.markdown.md")).toEqual({ problem: "“guides/.markdown.md” is not a name that can be used here." });
		expect(typedDocument(".md.md.md")).toEqual({ problem: "“.md.md.md” is not a name that can be used here." });
		expect(typedDocument(".md .markdown .md.")).toEqual({ problem: "“.md .markdown .md.” is not a name that can be used here." });
		// A name with an ending typed twice keeps the one that is part of it.
		expect(typedDocument("x.md.md")).toEqual({ folders: [], file: "x.md.md", title: "x.md" });
	});

	test("a full stop inside the name stays in it, and the ending follows", () => {
		// "e.g." is the name "e.g", headed as typed: the file is the name with ".md" after it, as any other is.
		expect(typedDocument("e.g.")).toEqual({ folders: [], file: "e.g.md", title: "e.g." });
		expect(typedDocument("v1.2 notes")).toEqual({ folders: [], file: "v1.2 notes.md", title: "v1.2 notes" });
	});

	test("a folder on the way that no listing shows is refused; a document called as one is a file, and is not", () => {
		expect(typedDocument("build/notes")).toEqual({ problem: "“build” is a folder the app leaves out of every list: nothing made there would be shown." });
		expect(typedDocument("build")).toEqual({ folders: [], file: "build.md", title: "build" });
		expect(typedDocument("guides/dist")).toEqual({ folders: ["guides"], file: "dist.md", title: "dist" });
	});

	test("a folder on the way that is not the same on every system is refused in the words that were typed", () => {
		expect(typedDocument("guides./Intro.md")).toEqual({ problem: "“guides./Intro.md” is not a name that can be used here." });
		expect(typedDocument("aux/Intro")).toEqual({ problem: "“aux/Intro” is not a name that can be used here." });
	});

	test("a name that is nothing, or that leads out, is refused in the words that were typed", () => {
		expect(typedDocument(" ")).toEqual({ problem: "A name is needed." });
		expect(typedDocument(".md")).toEqual({ problem: "A name is needed." });
		expect(typedDocument("../README.md")).toEqual({ problem: "“../README.md” is not a name that can be used here." });
		expect(typedDocument("guides/.md")).toEqual({ problem: "“guides/.md” is not a name that can be used here." });
	});
});
