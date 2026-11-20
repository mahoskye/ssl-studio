import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogFilesOf, listDocs, readProject, setupProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { CATALOG_END, CATALOG_START, catalogLine, catalogStale, hasCatalogPlace, withCatalog } from "../src/shared/catalog";
import { docChecks } from "../src/shared/docChecks";
import { areaPath, CATALOG_FILES_MAX, catalogItems, catalogTemplate, fileItems, isFileArea, OPTIONAL_CATALOGS } from "../src/shared/projectDocs";
import type { DocFile } from "../src/shared/protocol";

const made: string[] = [];
const fresh = (name: string) => {
	const root = mkdtempSync(join(tmpdir(), `ssl-studio-${name}-`));
	made.push(root);
	return root;
};
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })));
const toml = (root: string, folders: string) => {
	mkdirSync(join(root, ".ssl-studio"), { recursive: true });
	writeFileSync(join(root, ".ssl-studio", "project.toml"), `[project]\nname = "P"\n\n[folders]\n${folders}\n`);
};

describe("the catalog of a tests or code folder", () => {
	test("lists its files as they lie, each by its name, under the folder it is in", () => {
		const items = fileItems(["Orders/Save.ssl", "README.txt", "Orders/Load.ds", "Legacy/old/Check.ssl", "Orders/save10.ssl", "Orders/save2.ssl"]);
		expect(items.map((item) => [item.section ?? "", item.title, item.path])).toEqual([
			// What lies in the folder itself first, then each folder inside it by its name; numbers in their own order.
			["", "README.txt", "README.txt"],
			["Legacy/old", "Check.ssl", "Legacy/old/Check.ssl"],
			["Orders", "Load.ds", "Orders/Load.ds"],
			["Orders", "Save.ssl", "Orders/Save.ssl"],
			["Orders", "save2.ssl", "Orders/save2.ssl"],
			["Orders", "save10.ssl", "Orders/save10.ssl"],
		]);
	});

	test("does not list itself, and says nothing of a file but its name: what a script is for is not read here", () => {
		expect(fileItems(["INDEX.md", "index.md", "A.ssl"]).map((item) => item.path)).toEqual(["A.ssl"]);
		// A catalog a person keeps deeper in is a file like any other.
		expect(fileItems(["Orders/INDEX.md"]).map((item) => item.path)).toEqual(["Orders/INDEX.md"]);
		expect(Object.keys(fileItems(["A.ssl"])[0]!).sort()).toEqual(["path", "title"]);
	});

	test("written into its template, reads back as up to date, and a file added after makes it stale", () => {
		const items = fileItems(["Orders/Save.ssl", "Orders/Load.ds"]);
		const text = withCatalog(catalogTemplate("code"), items);
		expect(text.startsWith("# Code\n\nThe project's scripts and data sources.")).toBe(true);
		expect(text).toContain("### Orders\n\n- [Load.ds](Orders/Load.ds)\n- [Save.ssl](Orders/Save.ssl)");
		expect(catalogStale(text, items)).toBe(false);
		expect(catalogStale(text, fileItems(["Orders/Save.ssl", "Orders/Load.ds", "Orders/New.ssl"]))).toBe(true);
		expect(catalogTemplate("tests").startsWith("# Tests\n\n")).toBe(true);
	});

	test("are the two folders whose catalogs list files, and lie where the project says its tests and code are", () => {
		expect(["tickets", "schema", "docs", "tests", "code"].map((area) => isFileArea(area as never))).toEqual([false, false, false, true, true]);
		const folders = { docs: "/p/docs", schema: "/p/schema", tests: "/p/checks", code: "/p/scripts" };
		expect([areaPath("tests", folders), areaPath("code", folders), areaPath("docs", folders)]).toEqual(["/p/checks", "/p/scripts", "/p/docs"]);
	});
});

describe("the docs folder's catalog", () => {
	const doc = (name: string, title: string, summary?: string): DocFile => ({ path: `/p/docs/${name}`, name, group: "docs", exists: true, title, ...(summary ? { summary } : {}) });
	const catalogOf = (group: DocFile["group"], folder: string): DocFile => ({ path: `/p/docs/${folder}/INDEX.md`, name: "INDEX.md", group, exists: true, catalog: { stale: false } });

	test("lists the plain documents, those in a folder under it, and then the way to the working documents' own catalogs", () => {
		const items = catalogItems("docs", [doc("guides/Setup.md", "Setup"), doc("Decisions.md", "Decisions", "Newest first."), doc("adr/0001-first.md", "One"), doc("INDEX.md", "Docs"), catalogOf("tickets", "tickets"), catalogOf("knowledge", "knowledge"), { ...catalogOf("knowledge", "knowledge/reference"), name: "reference/INDEX.md" }], "/p/docs");
		expect(items.map((item) => [item.section ?? "", item.title, item.path])).toEqual([
			["", "Decisions", "Decisions.md"],
			["adr", "One", "adr/0001-first.md"],
			["guides", "Setup", "guides/Setup.md"],
			// Only the catalogs that are there, and only each folder's own: not one a person keeps deeper in.
			["Working documents", "Tickets", "tickets/INDEX.md"],
			["Working documents", "Knowledge base", "knowledge/INDEX.md"],
		]);
		expect(items[0]).toMatchObject({ summary: "Newest first." });
	});

	test("starts by saying what the folder holds, the working documents' folders among it", () => {
		const text = catalogTemplate("docs");
		expect(text.startsWith("# Docs\n\nNotes and decisions about this project, and the working documents")).toBe(true);
		expect(text).toContain(`${CATALOG_START}\n\nNothing here yet.\n\n${CATALOG_END}`);
	});
});

describe("a project's folders on disk", () => {
	test("set up, each new folder starts as its catalog and none as a README", async () => {
		const root = fresh("folders-setup");
		const wrote = await setupProject(root);
		for (const folder of ["docs", "schema", "tests", "src"]) expect(wrote).toContain(join(folder, "INDEX.md"));
		// The project's own README and AGENTS are still written: they are the project's, not a folder's.
		expect(wrote.filter((path) => /README\.md$/.test(path))).toEqual(["README.md"]);
		// Said so as to be true of any project: one that keeps no catalog for a folder is not told it has one.
		expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("The docs, schema, code and tests folders have one too, where the project keeps one.");
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		// With nothing in them yet, each says so: all four are up to date.
		expect(docs.filter((d) => d.catalog).map((d) => [d.catalog!.area, d.catalog!.stale])).toEqual([["docs", false], ["schema", false], ["code", false], ["tests", false]]);
		expect(docChecks(docs).filter((check) => /catalog/.test(check.text))).toEqual([]);
	});

	test("a script put in the code folder makes its catalog out of date, and Health says so by what the folder is", async () => {
		const root = fresh("folders-stale");
		await setupProject(root);
		mkdirSync(join(root, "src", "Orders"), { recursive: true });
		writeFileSync(join(root, "src", "Orders", "Save.ssl"), ":PROCEDURE Save;\n:ENDPROC;\n");
		writeFileSync(join(root, "tests", "SaveTests.ssl"), ":PROCEDURE RunTests;\n:ENDPROC;\n");
		writeFileSync(join(root, "docs", "Notes.md"), "# Notes\n\nSome notes.\n");
		const files = new WorkspaceFiles(root);
		const project = await readProject(root);
		const docs = await listDocs(files, project);
		expect(docs.filter((d) => d.catalog?.stale).map((d) => d.catalog!.area).sort()).toEqual(["code", "docs", "tests"]);
		expect(docChecks(docs).map((check) => check.text)).toContain("The catalogs of the docs folder, the code folder and the tests folder are out of date.");
		expect(catalogFilesOf(files, project, "code")).toEqual(["Orders/Save.ssl"]);
		expect(catalogFilesOf(files, project, "tests")).toEqual(["SaveTests.ssl"]);
		// Written afresh as "Update catalogs" writes it, the code's says what the folder holds again.
		const index = join(root, "src", "INDEX.md");
		writeFileSync(index, withCatalog(readFileSync(index, "utf8"), fileItems(catalogFilesOf(files, project, "code")!)));
		expect((await listDocs(files, project)).find((d) => d.catalog?.area === "code")?.catalog?.stale).toBe(false);
	});

	test("a folder with scripts and no catalog is not asked for one: a project may do without", async () => {
		const root = fresh("folders-none");
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(join(root, "tests"), { recursive: true });
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "src", "A.ssl"), "");
		writeFileSync(join(root, "tests", "ATests.ssl"), "");
		writeFileSync(join(root, "docs", "Notes.md"), "# Notes\n");
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		expect(docs.filter((d) => d.catalog)).toEqual([]);
		expect(docChecks(docs).filter((check) => /catalog/.test(check.text))).toEqual([]);
	});

	test("code kept at the project's own folder has no catalog, and tests kept among the code have the code's", async () => {
		const flat = fresh("folders-flat");
		toml(flat, 'code = "."');
		writeFileSync(join(flat, "A.ssl"), "");
		writeFileSync(join(flat, "INDEX.md"), catalogTemplate("code"));
		const flatFiles = new WorkspaceFiles(flat);
		expect(catalogFilesOf(flatFiles, await readProject(flat), "code")).toBeNull();
		expect((await listDocs(flatFiles, await readProject(flat))).filter((d) => d.catalog?.area === "code")).toEqual([]);

		const same = fresh("folders-same");
		toml(same, 'code = "src"\ntests = "src"');
		mkdirSync(join(same, "src"));
		writeFileSync(join(same, "src", "A.ssl"), "");
		writeFileSync(join(same, "src", "INDEX.md"), catalogTemplate("code"));
		const sameFiles = new WorkspaceFiles(same);
		const project = await readProject(same);
		// One folder, one catalog: where the tests are kept in the code's own folder, it is the code's.
		const areas = (await listDocs(sameFiles, project)).filter((d) => d.catalog).map((d) => d.catalog!.area);
		expect(areas).toEqual(["code"]);
		expect(catalogFilesOf(sameFiles, project, "code")).toEqual(["A.ssl"]);
		expect(catalogFilesOf(sameFiles, project, "tests")).toBeNull();
	});

	test("a folder with more files than a catalog lists has none kept, and is never said to be out of date", async () => {
		const root = fresh("folders-many");
		mkdirSync(join(root, "src"), { recursive: true });
		for (let n = 0; n <= CATALOG_FILES_MAX; n++) writeFileSync(join(root, "src", `S${n}.ssl`), "");
		writeFileSync(join(root, "src", "INDEX.md"), catalogTemplate("code"));
		const files = new WorkspaceFiles(root);
		const project = await readProject(root);
		expect(catalogFilesOf(files, project, "code")).toBeNull();
		expect((await listDocs(files, project)).find((d) => d.catalog?.area === "code")?.catalog).toEqual({ stale: false, area: "code" });
	});
});

describe("what a review of these catalogs found", () => {
	test("a file a person keeps under the catalog's name, with no place for the list, is theirs: not marked, not a catalog", async () => {
		const root = fresh("folders-own");
		for (const folder of ["docs", "src", "tests"]) mkdirSync(join(root, folder));
		writeFileSync(join(root, "docs", "index.md"), "# My own index\n\n- [Notes](Notes.md)\n");
		writeFileSync(join(root, "docs", "Notes.md"), "# Notes\n");
		writeFileSync(join(root, "src", "INDEX.md"), "# Scripts, by hand\n");
		writeFileSync(join(root, "src", "A.ssl"), "");
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		expect(docs.filter((d) => d.catalog)).toEqual([]);
		expect(hasCatalogPlace("# My own index\n")).toBe(false);
		expect(hasCatalogPlace(catalogTemplate("docs"))).toBe(true);
		// The three that a project may do without, and so never started by a step that only keeps catalogs.
		expect(OPTIONAL_CATALOGS).toEqual(["docs", "code", "tests"]);
	});

	test("a plain document's heading is for its catalog's line, and is not a name it is linked by", async () => {
		const root = fresh("folders-heading");
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "docs", "Notes.md"), "# How the samples flow\n\nFrom receipt to report.\n");
		const doc = (await listDocs(new WorkspaceFiles(root), await readProject(root))).find((d) => d.group === "docs")!;
		expect(doc).toMatchObject({ heading: "How the samples flow", summary: "From receipt to report." });
		expect(doc.title).toBeUndefined();
		expect(catalogItems("docs", [doc], join(root, "docs"))[0]).toMatchObject({ title: "How the samples flow", path: "Notes.md" });
	});

	test("the docs' catalog leaves what lies under a schema folder inside it to the schema's", () => {
		const where = { docs: "/p/docs", schema: "/p/docs/schema" };
		const files: DocFile[] = [
			{ path: "/p/docs/Notes.md", name: "Notes.md", group: "docs", exists: true },
			{ path: "/p/docs/schema/database/ORDERS.md", name: "schema/database/ORDERS.md", group: "docs", exists: true },
			{ path: "/p/docs/schemas-old/X.md", name: "schemas-old/X.md", group: "docs", exists: true },
		];
		expect(catalogItems("docs", files, where).map((item) => item.path)).toEqual(["Notes.md", "schemas-old/X.md"]);
		// With the schema folder beside the docs folder, nothing is left out.
		expect(catalogItems("docs", files, { docs: "/p/docs", schema: "/p/schema" }).length).toBe(3);
	});

	test("a folder a project calls \"Working documents\" keeps its own heading apart from the catalogs'", () => {
		const files: DocFile[] = [
			{ path: "/p/docs/Working documents/A.md", name: "Working documents/A.md", group: "docs", exists: true },
			{ path: "/p/docs/tickets/INDEX.md", name: "INDEX.md", group: "tickets", exists: true },
		];
		expect(catalogItems("docs", files, "/p/docs").map((item) => item.section)).toEqual(["Working documents", "The working documents' catalogs"]);
	});

	test("a round bracket in a file's name does not end its link, and the list still reads back as up to date", () => {
		const items = fileItems(["Old (copy).ssl", "Odd).ssl", "A [draft].ssl"]);
		expect(items.map(catalogLine)).toEqual(["- [A \\[draft\\].ssl](A%20%5Bdraft%5D.ssl)", "- [Odd).ssl](Odd%29.ssl)", "- [Old (copy).ssl](Old%20%28copy%29.ssl)"]);
		expect(catalogStale(withCatalog(catalogTemplate("code"), items), items)).toBe(false);
	});

	test("what a system or a tool keeps for itself is not listed, and a setting that names a file is no folder to list", async () => {
		const root = fresh("folders-dots");
		mkdirSync(join(root, "src", ".cache"), { recursive: true });
		writeFileSync(join(root, "src", "A.ssl"), "");
		writeFileSync(join(root, "src", ".DS_Store"), "");
		writeFileSync(join(root, "src", ".gitkeep"), "");
		writeFileSync(join(root, "src", ".cache", "x.ssl"), "");
		const files = new WorkspaceFiles(root);
		expect(catalogFilesOf(files, await readProject(root), "code")).toEqual(["A.ssl"]);
		toml(root, 'code = "src/A.ssl"');
		const project = await readProject(root);
		expect(catalogFilesOf(files, project, "code")).toBeNull();
		// The listing does not fail for it.
		expect((await listDocs(files, project)).some((d) => d.group === "project")).toBe(true);
	});

	test("a link in the code's catalog that leads nowhere is said, as in any other listed document", async () => {
		const root = fresh("folders-links");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "A.ssl"), "");
		writeFileSync(join(root, "src", "INDEX.md"), `${withCatalog(catalogTemplate("code"), fileItems(["A.ssl"]))}\nSee [the plan](../design/Gone.md).\n`);
		const catalog = (await listDocs(new WorkspaceFiles(root), await readProject(root))).find((d) => d.catalog?.area === "code")!;
		expect(catalog.catalog).toEqual({ stale: false, area: "code" });
		expect(catalog.broken?.map((link) => link.href)).toEqual(["../design/Gone.md"]);
	});

	test("set up with the tests kept in the code's own folder, that folder's catalog is the code's", async () => {
		const root = fresh("folders-shared");
		toml(root, 'code = "scripts"\ntests = "scripts"');
		const wrote = await setupProject(root);
		expect(wrote.filter((path) => path.startsWith("scripts"))).toEqual([join("scripts", "INDEX.md")]);
		expect(readFileSync(join(root, "scripts", "INDEX.md"), "utf8").startsWith("# Code\n")).toBe(true);
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		expect(docs.filter((d) => d.catalog && d.group === "project").map((d) => d.catalog!.area)).toEqual(["code"]);
	});

	test("and so it is where scripts lie elsewhere, and the tests' step is the one that makes the folder", async () => {
		const root = fresh("folders-shared-export");
		toml(root, 'code = "scripts"\ntests = "scripts"');
		mkdirSync(join(root, "Server Scripts"));
		writeFileSync(join(root, "Server Scripts", "Orders.srvscr"), "");
		await setupProject(root);
		expect(readFileSync(join(root, "scripts", "INDEX.md"), "utf8").startsWith("# Code\n")).toBe(true);
	});
});
