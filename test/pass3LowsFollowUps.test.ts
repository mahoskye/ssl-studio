// What the low findings left at the edges of the files they were fixed in: the same defect one call further on.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDocs, readProject } from "../src/bun/project";
import { frontMatter, one } from "../src/shared/frontMatter";
import { decisionTemplate, questionTemplate, specTemplate, ticketTemplate } from "../src/shared/projectDocs";
import { defaultExcludePattern } from "../src/shared/registryCheck";
import { createFileFilter } from "../src/shared/fileGlob";
import { WorkspaceFiles } from "../src/bun/workspace";
import { existsBy } from "../src/view/backend";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p3l-follow-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A link, or false where this system does not let one be made (the test is then passed over). */
const link = (target: string, at: string) => {
	try {
		symlinkSync(target, at);
		return true;
	} catch {
		return false;
	}
};

describe("project documents that are links out of the workspace", () => {
	/** A workspace beside a folder that is not part of it. */
	const beside = (name: string) => {
		const root = join(base, name, "ws");
		const outside = join(base, name, "outside");
		mkdirSync(root, { recursive: true });
		mkdirSync(join(outside, "docs"), { recursive: true });
		writeFileSync(join(outside, "docs", "STATE.md"), "# Where another project stands\n\nA summary kept elsewhere.\n");
		writeFileSync(join(outside, "README.md"), "# Another project\n\n## A heading kept elsewhere\n\nSee [the notes](notes.md).\n");
		return { root, outside };
	};

	test("the state file of a docs folder that is a link elsewhere is not listed", async () => {
		const { root, outside } = beside("state-out");
		if (!link(join(outside, "docs"), join(root, "docs"))) return;
		const listed = await listDocs(new WorkspaceFiles(root), await readProject(root));
		expect(listed.some((doc) => doc.name === "STATE.md")).toBe(false);
		expect(JSON.stringify(listed)).not.toContain("kept elsewhere");
	});

	test("a state file that is itself a link elsewhere is not listed", async () => {
		const { root, outside } = beside("state-file-out");
		mkdirSync(join(root, "docs"));
		if (!link(join(outside, "docs", "STATE.md"), join(root, "docs", "STATE.md"))) return;
		const listed = await listDocs(new WorkspaceFiles(root), await readProject(root));
		expect(listed.some((doc) => doc.name === "STATE.md")).toBe(false);
		expect(JSON.stringify(listed)).not.toContain("kept elsewhere");
	});

	test("a README that is a link elsewhere is listed by name and not read through", async () => {
		const { root, outside } = beside("readme-out");
		if (!link(join(outside, "README.md"), join(root, "README.md"))) return;
		const listed = await listDocs(new WorkspaceFiles(root), await readProject(root));
		const readme = listed.find((doc) => doc.name === "README.md");
		expect(readme?.exists).toBe(true);
		expect(readme?.headings).toBeUndefined();
		expect(JSON.stringify(listed)).not.toContain("kept elsewhere");
	});

	test("a state file and a README inside the workspace are read as before", async () => {
		const root = join(base, "inside", "ws");
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "STATE.md"), "# Where the project stands\n\nThe summary of this project.\n");
		writeFileSync(join(root, "README.md"), "# This project\n\n## Getting started\n");
		const listed = await listDocs(new WorkspaceFiles(root), await readProject(root));
		expect(listed.some((doc) => doc.name === "STATE.md")).toBe(true);
		expect(listed.find((doc) => doc.name === "README.md")?.headings?.map((h) => h.text)).toContain("Getting started");
	});
});

describe("a ticket's key in the documents written without a template", () => {
	const ticketOf = (text: string) => one(frontMatter(text).values.ticket);

	test("a key YAML would read as something else comes back as the key", () => {
		for (const key of ["#12", "OPS: 7", "[LAB]-3", "it's-4"]) {
			expect(ticketOf(ticketTemplate({ key, title: "A ticket" })), key).toBe(key);
			expect(ticketOf(specTemplate({ title: "A spec", ticket: key })), key).toBe(key);
			expect(ticketOf(decisionTemplate({ title: "A decision", date: "2026-11-25", ticket: key })), key).toBe(key);
			expect(ticketOf(questionTemplate({ title: "A question", date: "2026-11-25", ticket: key })), key).toBe(key);
		}
	});

	test("an ordinary key is written bare, and no key writes no line", () => {
		expect(ticketTemplate({ key: "DEMO-101", title: "A ticket" })).toContain("\nticket: DEMO-101\n");
		expect(specTemplate({ title: "A spec", ticket: "DEMO-101" })).toContain("\nticket: DEMO-101\n");
		expect(specTemplate({ title: "A spec" })).not.toContain("ticket:");
		expect(decisionTemplate({ title: "A decision", date: "2026-11-25" })).not.toContain("ticket:");
	});
});

describe("whether a file is there, asked by its size", () => {
	const never = () => Promise.reject(new Error("not asked"));

	test("a text too large to open is there: the read that refuses it is not asked", async () => {
		const tooLarge = () => Promise.reject(new Error("design/Big.plan.json is 40.0 MB: too large to open here (the most is 20.0 MB)."));
		expect(await existsBy(async (paths) => ({ [paths[0]!]: 40_000_000 }), tooLarge, "/ws/design/Big.plan.json")).toBe(true);
	});

	test("a file with no size is not there, and an empty file is", async () => {
		expect(await existsBy(async () => ({}), never, "/ws/a.md")).toBe(false);
		expect(await existsBy(async (paths) => ({ [paths[0]!]: 0 }), never, "/ws/a.md")).toBe(true);
	});

	test("where the sizes cannot be had, the read answers as before", async () => {
		const noSizes = () => Promise.reject(new Error("no such method"));
		expect(await existsBy(noSizes, async () => ({ text: "" }), "/ws/a.md")).toBe(true);
		expect(await existsBy(noSizes, never, "/ws/a.md")).toBe(false);
		// A stand-in backend that answers every call with nothing.
		expect(await existsBy(async () => undefined as never, async () => "text", "/ws/a.md")).toBe(true);
	});
});

describe("the folders a code check leaves out, as patterns", () => {
	test("a folder's name is written as itself: a dot, a comma and a brace are its characters", () => {
		const pattern = defaultExcludePattern([".notes", "docs/a,b", "design/{old}", "./schema/", "Schema", "."]);
		const left = createFileFilter("", pattern);
		for (const path of [".notes/x.md", "docs/a,b/x.md", "design/{old}/x.md", "schema/x.md"]) expect(left(path), path).toBe(false);
		// Not the folders a comma or a brace used to make of them, and not the name without its dot.
		for (const path of ["notes/x.md", "b/x.md", "docs/a/x.md", "design/old/x.md", "src/x.ssl"]) expect(left(path), path).toBe(true);
	});

	test("ordinary folders are written as they were, each once", () => {
		expect(defaultExcludePattern(["docs", "design/", "./docs", "Docs", "", "."])).toBe("docs/**, design/**");
	});
});
