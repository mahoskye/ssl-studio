import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDocs, projectSettings, readProject, setupProject, undoSetup } from "../src/bun/project";
import { merge } from "../src/bun/settings";
import { WorkspaceFiles } from "../src/bun/workspace";

const dir = mkdtempSync(join(tmpdir(), "ssl-studio-project-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fresh = (name: string) => {
	const root = join(dir, name);
	mkdirSync(root, { recursive: true });
	return root;
};

test("a folder without project.toml has defaults and is not configured", async () => {
	const project = await readProject(fresh("plain"));
	expect(project).toMatchObject({ configured: false, name: "plain", docs: "docs", schema: "schema", tests: "tests", code: "src", plans: "design" });
});

test("setup writes the three files once and never overwrites", async () => {
	const root = fresh("setup");
	writeFileSync(join(root, "readme.md"), "# Mine\n");
	mkdirSync(join(root, "docs"));
	mkdirSync(join(root, "Server Scripts"));
	writeFileSync(join(root, "Server Scripts", "Orders.srvscr"), "");
	// docs/ is already there and there is code already: neither gets a README or a folder.
	expect((await setupProject(root)).sort()).toEqual(
		// The schema folder comes with a folder for each kind of thing it describes.
		[join(".ssl-studio", "project.toml"), "AGENTS.md", join("schema", "README.md"), join("schema", "database", "README.md"), join("schema", "interfaces", "README.md"), join("schema", "files", "README.md"), join("tests", "README.md")].sort(),
	);
	expect(existsSync(join(root, "src"))).toBe(false);
	expect(await Bun.file(join(root, "readme.md")).text()).toBe("# Mine\n");
	expect(existsSync(join(root, "README.md"))).toBe(process.platform === "darwin" || process.platform === "win32");
	expect(await setupProject(root)).toEqual([]);
	expect(await readProject(root)).toMatchObject({ configured: true, name: "setup" });
});

test("project.toml chooses the name, docs folder, model and style", async () => {
	const root = fresh("chosen");
	mkdirSync(join(root, ".ssl-studio"));
	writeFileSync(
		join(root, ".ssl-studio", "project.toml"),
		'[project]\nname = "Orders"\ndescription = "Order entry"\n[folders]\ndocs = "notes/"\nschema = "db"\ncode = "."\n[agent]\nmodel = "ollama/qwen3:14b"\n[style]\npreset = "server"\n',
	);
	const project = await readProject(root);
	expect(project).toMatchObject({ name: "Orders", description: "Order entry", docs: "notes", schema: "db", tests: "tests", code: ".", agentModel: "ollama/qwen3:14b", stylePreset: "server" });
	// The user's setting, then the project's, then what the IDE saved for the workspace.
	expect(merge({ agentModel: "a/user" }, projectSettings(project)).agentModel).toBe("ollama/qwen3:14b");
	expect(merge({ agentModel: "a/user" }, projectSettings(project), { agentModel: "b/workspace" }).agentModel).toBe("b/workspace");
	expect(merge({ agentModel: "a/user" }, projectSettings(await readProject(fresh("none")))).agentModel).toBe("a/user");
});

test("a docs folder outside the project, or a broken file, falls back to the defaults", async () => {
	const root = fresh("bad");
	mkdirSync(join(root, ".ssl-studio"));
	writeFileSync(join(root, ".ssl-studio", "project.toml"), '[folders]\ndocs = "../elsewhere"\n');
	expect((await readProject(root)).docs).toBe("docs");
	writeFileSync(join(root, ".ssl-studio", "project.toml"), "[project\nname = ");
	const broken = await readProject(root);
	expect(broken).toMatchObject({ configured: true, name: "bad", docs: "docs" });
	expect(broken.error).toBeTruthy();
});

test("the document list puts README and AGENTS first, missing or not, and says which are unwritten", async () => {
	const root = fresh("docs");
	let docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
	expect(docs.map((d) => [d.name, d.exists])).toEqual([["README.md", false], ["AGENTS.md", false], ["project.toml", false]]);
	expect(await setupProject(root)).toContain(join("src", "README.md"));
	mkdirSync(join(root, "docs", "adr"), { recursive: true });
	writeFileSync(join(root, "schema", "ORDERS.sql"), "");
	mkdirSync(join(root, "design"));
	writeFileSync(join(root, "docs", "adr", "0001-first.md"), "# One\n");
	writeFileSync(join(root, "docs", "notes.txt"), "not listed");
	writeFileSync(join(root, "design", "Orders.plan.json"), "{}");
	writeFileSync(join(root, "AGENTS.md"), "# Agents\n\nWritten.\n");
	docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
	expect(docs.map((d) => [d.group, d.name, d.exists, d.untouched])).toEqual([
		["project", "README.md", true, true],
		["project", "AGENTS.md", true, false],
		["project", "project.toml", true, undefined],
		["docs", join("adr", "0001-first.md"), true, undefined],
		["docs", "README.md", true, undefined],
		["schema", join("database", "README.md"), true, undefined],
		["schema", join("files", "README.md"), true, undefined],
		["schema", join("interfaces", "README.md"), true, undefined],
		["schema", "ORDERS.sql", true, undefined],
		["schema", "README.md", true, undefined],
		["plans", "Orders.plan.json", true, undefined],
	]);
});

test("the preview says what setup would create and writes nothing", async () => {
	const root = fresh("preview");
	const planned = await setupProject(root, true);
	expect(planned.sort()).toEqual([join(".ssl-studio", "project.toml"), "AGENTS.md", "README.md", join("docs", "README.md"), join("schema", "README.md"), join("schema", "database", "README.md"), join("schema", "interfaces", "README.md"), join("schema", "files", "README.md"), join("src", "README.md"), join("tests", "README.md")].sort());
	expect(readdirSync(root)).toEqual([]);
	// What was previewed is what gets written.
	expect((await setupProject(root)).sort()).toEqual(planned.sort());
});

test("undoing a setup removes what it wrote, with the folders it left empty", async () => {
	const root = fresh("undo");
	writeFileSync(join(root, "Notes.txt"), "mine\n");
	await setupProject(root);
	const { removed, kept } = await undoSetup(root);
	expect(removed.length).toBe(10);
	expect(kept).toEqual([]);
	expect(readdirSync(root)).toEqual(["Notes.txt"]);
});

test("undoing a setup keeps a file that was changed since, and a folder that now holds something else", async () => {
	const root = fresh("undo-kept");
	await setupProject(root);
	writeFileSync(join(root, "README.md"), "# Written by hand\n");
	writeFileSync(join(root, "docs", "Decisions.md"), "# Decisions\n");
	const { removed, kept } = await undoSetup(root);
	expect(kept).toEqual(["README.md"]);
	expect(removed).toContain(join("docs", "README.md"));
	expect(readdirSync(root).sort()).toEqual(["README.md", "docs"]);
	expect(readdirSync(join(root, "docs"))).toEqual(["Decisions.md"]);
});

test("there is nothing to undo twice, or in a folder that was never set up", async () => {
	const root = fresh("undo-once");
	await setupProject(root);
	await undoSetup(root);
	expect(await undoSetup(root)).toEqual({ removed: [], kept: [] });
	expect(await undoSetup(fresh("never"))).toEqual({ removed: [], kept: [] });
});
