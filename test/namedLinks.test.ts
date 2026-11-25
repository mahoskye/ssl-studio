// Links by name: which document a name means, and what is read from between the brackets.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDocs, namesIn, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { docByName, linkedFrom, nameBeingWritten, nameChoices, nameFor, namedLink, namedLinksIn, namePlaces, namesToFollow, withNames } from "../src/shared/namedLinks";
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

describe("where the links by name of a text stand", () => {
	test("is each one's line, the column of its name, and the name", () => {
		const text = "# Notes\n\nSee [[DEMO-103]] and [[ Late samples |the spec]].\nAlso [[Decisions#Rush work]].\n";
		expect(namePlaces(text)).toEqual([
			{ line: 3, column: 6, name: "DEMO-103" },
			{ line: 3, column: 24, name: "Late samples" },
			{ line: 4, column: 7, name: "Decisions" },
		]);
	});
	test("leaves out what is in code, and what the document opens with", () => {
		const text = "---\nrelated: [[DEMO-1]]\n---\n\nas in `[[DEMO-2]]`, but [[DEMO-3]]\n\n```\n[[DEMO-4]]\n```\n";
		expect(namePlaces(text).map((place) => place.name)).toEqual(["DEMO-3"]);
	});
	test("is the same with the line ends of Windows", () => {
		const text = "one\r\n```\r\n[[in code]]\r\n```\r\nSee [[DEMO-103]].\r\n";
		expect(namePlaces(text)).toEqual([{ line: 5, column: 6, name: "DEMO-103" }]);
	});
	test("is none in a text with no such link", () => {
		expect(namePlaces("plain [words](a.md) and [x] only")).toEqual([]);
	});
});

describe("names written anew", () => {
	const text = "See [[Late samples|the spec]] and [[Late samples#Why]].\r\nAlso [[ Late samples ]].\n";
	const places = namePlaces(text);
	test("change the name and nothing else, with the line ends kept", () => {
		const changed = withNames(text, places.map((place) => ({ ...place, instead: "Late work" })));
		expect(changed.done).toBe(3);
		expect(changed.text).toBe("See [[Late work|the spec]] and [[Late work#Why]].\r\nAlso [[ Late work ]].\n");
	});
	test("are not written where the text is no longer as it was read", () => {
		const since = text.replace("See ", "Now see ");
		const changed = withNames(since, places.map((place) => ({ ...place, instead: "Late work" })));
		expect(changed.done).toBe(1);
		expect(changed.text).toBe("Now see [[Late samples|the spec]] and [[Late samples#Why]].\r\nAlso [[ Late work ]].\n");
	});
	test("are not written over the same words outside a link", () => {
		expect(withNames("Late samples", [{ line: 1, column: 0, name: "Late samples", instead: "x" }])).toEqual({ text: "Late samples", done: 0 });
	});
});

describe("the links by name a rename leaves behind", () => {
	const before = [
		doc("/work/project/docs/tickets/DEMO-103.md", { group: "tickets", ticket: "DEMO-103", title: "A report" }),
		doc("/work/project/docs/specs/Late samples.md", { group: "specs", title: "Late samples on the report" }),
		doc("/work/project/docs/Decisions.md", { title: "What was decided" }),
	];
	const renamed = (from: string, to: string) => {
		const moved = (path: string) => (path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
		return { moved, after: before.map((file) => ({ ...file, path: moved(file.path) })) };
	};
	const places = [
		{ path: "/work/project/docs/a.md", line: 1, column: 2, name: "Late samples" },
		{ path: "/work/project/docs/a.md", line: 2, column: 2, name: "late samples.md" },
		{ path: "/work/project/docs/a.md", line: 3, column: 2, name: "Late samples on the report" },
		{ path: "/work/project/docs/a.md", line: 4, column: 2, name: "DEMO-103" },
		{ path: "/work/project/docs/b.md", line: 1, column: 2, name: "docs/specs/Late samples" },
		{ path: "/work/project/docs/b.md", line: 2, column: 2, name: "Decisions" },
		{ path: "/work/project/docs/b.md", line: 3, column: 2, name: "no such note" },
	];
	test("are those that named the file by its name or its path, each with the new name", () => {
		const { moved, after } = renamed("/work/project/docs/specs/Late samples.md", "/work/project/docs/specs/Late work.md");
		expect(namesToFollow(places, before, after, moved, root).map((f) => [f.path.slice(-4), f.line, f.name, f.instead])).toEqual([
			["a.md", 1, "Late samples", "Late work"],
			["a.md", 2, "late samples.md", "Late work"],
			["b.md", 1, "docs/specs/Late samples", "Late work"],
		]);
	});
	test("are none for a ticket renamed, which its key still names", () => {
		const { moved, after } = renamed("/work/project/docs/tickets/DEMO-103.md", "/work/project/docs/tickets/A report.md");
		expect(namesToFollow(places, before, after, moved, root)).toEqual([]);
	});
	test("are those that named a file by its path, when its folder is renamed", () => {
		const { moved, after } = renamed("/work/project/docs/specs", "/work/project/docs/designs");
		expect(namesToFollow(places, before, after, moved, root).map((f) => [f.name, f.instead])).toEqual([["docs/specs/Late samples", "Late samples"]]);
	});
});

describe("the documents a document is linked from", () => {
	const here = "/work/project/docs/specs/Late samples.md";
	const ticket = "/work/project/docs/tickets/DEMO-103.md";
	const decisions = "/work/project/docs/knowledge/decisions/Decisions.md";
	test("are those that link to it by path or by a name that means it, each once", () => {
		const byPath = [
			{ path: decisions, line: 12 },
			{ path: ticket, line: 30 },
		];
		const byName = [
			{ path: ticket, line: 8, column: 2, name: "Late samples" },
			{ path: ticket, line: 9, column: 2, name: "late samples on the report" },
			{ path: decisions, line: 40, column: 2, name: "DEMO-103" },
			{ path: here, line: 3, column: 2, name: "Late samples" },
			{ path: "/work/project/docs/README.md", line: 5, column: 2, name: "no such note" },
		];
		expect(linkedFrom(here, byPath, byName, files, root)).toEqual([
			{ path: ticket, line: 8, places: 3 },
			{ path: decisions, line: 12, places: 1 },
		]);
	});
	test("are none for a document nothing links to", () => {
		expect(linkedFrom(here, [], [{ path: ticket, line: 1, column: 2, name: "DEMO-103" }], files, root)).toEqual([]);
	});
	test("leave its links to itself out", () => {
		expect(linkedFrom(here, [{ path: here, line: 2 }], [{ path: here, line: 3, column: 2, name: "Late samples" }], files, root)).toEqual([]);
	});
});

describe("the shapes a link by name is read in", () => {
	test("a bar after a backslash is the bar, as a table's row writes it", () => {
		expect(namePlaces("| [[Late samples\\|the spec]] | x |")).toEqual([{ line: 1, column: 4, name: "Late samples" }]);
	});
	test("a lone backtick earlier on the line opens no span of code", () => {
		expect(namePlaces("a ` tick then [[Late samples]]").map((place) => place.name)).toEqual(["Late samples"]);
		expect(namePlaces("in `[[code]]` and [[Late samples]]").map((place) => place.name)).toEqual(["Late samples"]);
	});
});

describe("a name written anew must stand there whole", () => {
	test("a longer name that starts the same is left", () => {
		expect(withNames("[[Later]] and [[Late samples]]", [{ line: 1, column: 2, name: "Late", instead: "X" }])).toEqual({ text: "[[Later]] and [[Late samples]]", done: 0 });
	});
	test("before a hash, a bar, an escaped bar or the brackets it is written", () => {
		const text = "[[Late]] [[Late#h]] [[Late|w]] [[ Late ]] [[Late\\|w]]";
		const edits = namePlaces(text).map((place) => ({ ...place, instead: "New" }));
		expect(withNames(text, edits)).toEqual({ text: "[[New]] [[New#h]] [[New|w]] [[ New ]] [[New\\|w]]", done: 5 });
	});
});

describe("a rename that changes what a name means", () => {
	const list = (paths: [string, Partial<DocFile>?][]) => paths.map(([path, more]) => doc(`${root}/${path}`, more));
	const at = (name: string) => [{ path: `${root}/docs/a.md`, line: 1, column: 2, name }];
	test("a link to a document that did not move, whose name the renamed file took, is given its path", () => {
		const before = list([["docs/Notes.md"], ["docs/specs/Other.md", { group: "specs" }]]);
		const after = list([["docs/Notes.md"], ["docs/specs/Notes.md", { group: "specs" }]]);
		const moved = (path: string) => (path === `${root}/docs/specs/Other.md` ? `${root}/docs/specs/Notes.md` : path);
		expect(namesToFollow(at("Notes"), before, after, moved, root).map((f) => f.instead)).toEqual(["docs/Notes"]);
		// The spec is before the note in the order names are matched in, so the bare name is now the spec's.
		expect(namesToFollow(at("Other"), before, after, moved, root).map((f) => f.instead)).toEqual(["Notes"]);
	});
	test("a ticket named by its file's name, with no key of its own written, is followed", () => {
		const before = list([["docs/tickets/DEMO-2.md", { group: "tickets", ticket: "DEMO-2" }]]);
		const after = list([["docs/tickets/DEMO-9.md", { group: "tickets", ticket: "DEMO-9" }]]);
		const moved = (path: string) => path.replace("DEMO-2.md", "DEMO-9.md");
		expect(namesToFollow(at("DEMO-2"), before, after, moved, root).map((f) => f.instead)).toEqual(["DEMO-9"]);
	});
	test("a link by what a document called itself, when it is called that no longer, is given its name", () => {
		const before = list([["docs/specs/Late samples.md", { group: "specs", title: "Late samples on the report" }]]);
		const after = list([["docs/Late samples.md", {}]]);
		const moved = (path: string) => path.replace("docs/specs/", "docs/");
		expect(namesToFollow(at("Late samples on the report"), before, after, moved, root).map((f) => f.instead)).toEqual(["Late samples"]);
	});
	test("a document that is no longer one of the project's is left", () => {
		const before = list([["docs/specs/Late samples.md", { group: "specs" }]]);
		expect(namesToFollow(at("Late samples"), before, [], (path) => path.replace("docs/specs", "src"), root)).toEqual([]);
	});
});

describe("the links by name of a folder on disk", () => {
	test("are read from every Markdown document, and a renamed ticket's are followed with the documents as they are after", async () => {
		const top = mkdtempSync(join(tmpdir(), "ssl-studio-names-"));
		try {
			mkdirSync(join(top, "docs", "tickets"), { recursive: true });
			writeFileSync(join(top, "docs", "tickets", "DEMO-2.md"), "# A ticket with no key written\n");
			writeFileSync(join(top, "docs", "notes.md"), "# Notes\n\nSee [[DEMO-2]] and [[DEMO-2|the ticket]].\n\n```\n[[DEMO-2]]\n```\n");
			writeFileSync(join(top, "docs", "plain.txt"), "[[DEMO-2]]\n");
			const files = new WorkspaceFiles(top);
			const places = await namesIn(files);
			expect(places.map((place) => [place.path.slice(top.length + 1).split("\\").join("/"), place.line, place.column, place.name])).toEqual([
				["docs/notes.md", 3, 6, "DEMO-2"],
				["docs/notes.md", 3, 21, "DEMO-2"],
			]);
			const before = await listDocs(files, await readProject(top));
			const was = join(top, "docs", "tickets", "DEMO-2.md");
			const is = join(top, "docs", "tickets", "DEMO-9.md");
			renameSync(was, is);
			const renamed = new WorkspaceFiles(top);
			const after = await listDocs(renamed, await readProject(top));
			const moved = (path: string) => (path === was ? is : path);
			// With the list of before in hand, and with only the list of after to make it from.
			const made = after.map((file) => (file.path === is ? { ...file, path: was } : file));
			for (const listing of [before, made]) {
				const follow = namesToFollow(places, listing, after, moved, top);
				expect(follow.map((f) => [f.line, f.column, f.name, f.instead])).toEqual([
					[3, 6, "DEMO-2", "DEMO-9"],
					[3, 21, "DEMO-2", "DEMO-9"],
				]);
			}
		} finally {
			rmSync(top, { recursive: true, force: true });
		}
	});
});

