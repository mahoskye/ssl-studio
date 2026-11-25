import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDocs, readProject, setupProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { CATALOG_END, CATALOG_START, catalogStale, withCatalog } from "../src/shared/catalog";
import { docChecks } from "../src/shared/docChecks";
import { areaPath, CATALOG_AREAS, catalogItems, catalogTemplate, isCatalog } from "../src/shared/projectDocs";
import type { DocFile } from "../src/shared/protocol";
import { schemaList, schemaRowTitle } from "../src/shared/schemaList";

const made: string[] = [];
const fresh = (name: string) => {
	const root = mkdtempSync(join(tmpdir(), `ssl-studio-${name}-`));
	made.push(root);
	return root;
};
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })));

const file = (name: string, kind: string, title?: string): DocFile => ({ path: `/p/schema/${name}`, name, group: "schema", exists: true, kind, ...(title ? { title } : {}) });

describe("the Schema list", () => {
	const files = [
		file("database/ORDERS.md", "database", "ORDERS"),
		file("database/orders.sql", "database"),
		file("database/sales/INVOICES.md", "database", "INVOICES"),
		file("Interfaces/ERP/Order-feed.md", "interfaces", "Order feed"),
		file("Interfaces/ERP/order-feed.yaml", "interfaces"),
		file("Interfaces/ERP/v2/Order-feed.md", "interfaces", "Order feed, version 2"),
		file("Interfaces/Analyser/Result.md", "interfaces", "Result"),
		file("Interfaces/Heartbeat.md", "interfaces", "Heartbeat"),
		file("labels/Sample-label.md", "labels", "Sample label"),
		file("Old-notes.md", "", "Old notes"),
		file("INDEX.md", "", "Schema"),
		// Not the schema's: another group's files are not its to list.
		{ ...file("x.md", "database"), group: "docs" as const },
	];

	test("has each kind with what lies in its folder, and a folder inside it under that folder's name", () => {
		const list = schemaList(files, { configured: true });
		expect(list.kinds.map((kind) => [kind.id, kind.name, kind.known, kind.folder, kind.count])).toEqual([
			["database", "Database", true, "database", 3],
			// The folder as the project has it, in the capitals it is written in.
			["interfaces", "Interfaces", true, "Interfaces", 5],
			// A kind the app knows is where the first of its kind goes: shown empty, once the project is set up.
			["files", "Files", true, "files", 0],
			["labels", "labels", false, "labels", 1],
		]);
		const [database, interfaces] = list.kinds;
		expect(database!.files.map((f) => f.name)).toEqual(["database/ORDERS.md", "database/orders.sql"]);
		expect(database!.parts).toEqual([{ name: "sales", folder: "database/sales", files: [files[2]!] }]);
		// The systems in the order of their names; what lies deeper is listed under the first folder inside the kind.
		expect(interfaces!.parts.map((part) => [part.name, part.folder, part.files.map((f) => f.name)])).toEqual([
			["Analyser", "Interfaces/Analyser", ["Interfaces/Analyser/Result.md"]],
			["ERP", "Interfaces/ERP", ["Interfaces/ERP/Order-feed.md", "Interfaces/ERP/order-feed.yaml", "Interfaces/ERP/v2/Order-feed.md"]],
		]);
		expect(interfaces!.files.map((f) => f.name)).toEqual(["Interfaces/Heartbeat.md"]);
	});

	test("keeps the folder's catalog apart: it is not one of the things described, nor counted with them", () => {
		const list = schemaList(files, { configured: true });
		expect(list.catalog?.name).toBe("INDEX.md");
		expect(list.top.map((f) => f.name)).toEqual(["Old-notes.md"]);
		expect(list.count).toBe(10);
		// With nothing at the top but the catalog, nothing is listed there.
		expect(schemaList([file("INDEX.md", "", "Schema"), file("database/A.md", "database", "A")]).top).toEqual([]);
		// A catalog in a kind's folder is a file like any other there: only the schema folder's own is its catalog.
		expect(schemaList([file("database/INDEX.md", "database", "Tables")]).catalog).toBeUndefined();
	});

	test("shows an empty known kind only for a project that is set up, and not while a filter narrows the list", () => {
		const one = [file("database/A.md", "database", "A")];
		expect(schemaList(one, { configured: true }).kinds.map((kind) => kind.id)).toEqual(["database", "interfaces", "files"]);
		expect(schemaList(one, { configured: false }).kinds.map((kind) => kind.id)).toEqual(["database"]);
		expect(schemaList(one, { configured: true, filtered: true }).kinds.map((kind) => kind.id)).toEqual(["database"]);
		expect(schemaList([], { configured: true }).count).toBe(0);
	});

	test("calls a file what it calls itself, or by its name under the heading it stands under", () => {
		expect(schemaRowTitle(files[0]!, 1)).toBe("ORDERS");
		expect(schemaRowTitle(files[1]!, 1)).toBe("orders.sql");
		expect(schemaRowTitle(files[4]!, 2)).toBe("order-feed.yaml");
		// Deeper than the heading says, the folders on the way are part of its name.
		expect(schemaRowTitle({ ...files[5]!, title: undefined }, 2)).toBe("v2/Order-feed.md");
		// A README goes by its file's name: titled as its folder is, it would repeat the heading.
		expect(schemaRowTitle(file("database/README.md", "database", "Database"), 1)).toBe("README.md");
		expect(schemaRowTitle(file("Old-notes.md", "", "Old notes"), 0)).toBe("Old notes");
	});
});

describe("the schema folder's catalog", () => {
	test("is one of the catalogued folders, and lies in the schema folder wherever the project keeps it", () => {
		expect(CATALOG_AREAS).toEqual(["tickets", "specs", "knowledge", "registries", "schema", "docs", "code", "tests"]);
		expect(areaPath("schema", { docs: "/p/docs", schema: "/p/db/schema" })).toBe("/p/db/schema");
		expect(areaPath("tickets", { docs: "/p/docs", schema: "/p/db/schema" })).toBe("/p/docs/tickets");
	});

	test("starts by saying what the folder is for, with the place the list goes", () => {
		const text = catalogTemplate("schema");
		expect(text.startsWith("# Schema\n\nWhat the project's data looks like, each kind in its own folder")).toBe(true);
		expect(text).toContain(`${CATALOG_START}\n\nNothing here yet.\n\n${CATALOG_END}`);
	});

	test("lists what is described under its kinds, a folder inside a kind beside the kind, in the kinds' own order", () => {
		const where = { docs: "/p/docs", schema: "/p/schema" };
		const listed = [
			file("labels/Sample-label.md", "labels", "Sample label"),
			file("Old-notes.md", "", "Old notes"),
			file("files/Export.md", "files", "Export"),
			file("interfaces/ERP/Order-feed.md", "interfaces", "Order feed"),
			file("interfaces/Analyser/Result.md", "interfaces", "Result"),
			file("interfaces/Heartbeat.md", "interfaces", "Heartbeat"),
			file("database/orders.sql", "database"),
			file("database/ORDERS.md", "database", "ORDERS"),
			file("INDEX.md", "", "Schema"),
		].map((f) => ({ ...f, path: `/p/schema/${f.name}` }));
		const items = catalogItems("schema", listed, where);
		expect(items.map((item) => [item.section, item.title, item.path])).toEqual([
			["Database", "orders.sql", "database/orders.sql"],
			["Database", "ORDERS", "database/ORDERS.md"],
			["Interfaces", "Heartbeat", "interfaces/Heartbeat.md"],
			["Interfaces: Analyser", "Result", "interfaces/Analyser/Result.md"],
			["Interfaces: ERP", "Order feed", "interfaces/ERP/Order-feed.md"],
			["Files", "Export", "files/Export.md"],
			["labels", "Sample label", "labels/Sample-label.md"],
			["At the top", "Old notes", "Old-notes.md"],
		]);
		// The catalog does not list itself.
		expect(items.some((item) => isCatalog({ name: item.path }))).toBe(false);
		// Written into the template, it reads back as up to date; a description added after makes it stale.
		const written = withCatalog(catalogTemplate("schema"), items);
		expect(catalogStale(written, items)).toBe(false);
		expect(catalogStale(written, catalogItems("schema", [...listed, { ...file("files/Import.md", "files", "Import"), path: "/p/schema/files/Import.md" }], where))).toBe(true);
	});

	test("a state written for a message is in its line, as a ticket's is", () => {
		const items = catalogItems("schema", [{ ...file("interfaces/ERP/Order-feed.md", "interfaces", "Order feed"), status: "agreed", summary: "Orders as they come in." }], { docs: "/p/docs", schema: "/p/schema" });
		expect(items).toEqual([{ path: "interfaces/ERP/Order-feed.md", title: "Order feed", status: "agreed", summary: "Orders as they come in.", section: "Interfaces: ERP" }]);
	});

	test("the other folders' catalogs are worked out as they were, given the docs folder alone", () => {
		const note: DocFile = { path: "/p/docs/knowledge/reference/How.md", name: "reference/How.md", group: "knowledge", exists: true, kind: "reference", title: "How" };
		expect(catalogItems("knowledge", [note], "/p/docs")).toEqual(catalogItems("knowledge", [note], { docs: "/p/docs", schema: "/p/schema" }));
		expect(catalogItems("knowledge", [note], "/p/docs")[0]).toMatchObject({ path: "reference/How.md", section: "Reference" });
	});
});

describe("a project's schema folder on disk", () => {
	test("set up, it starts as its catalog, which names the kinds it can hold; a kind's folder comes with its first description", async () => {
		const root = fresh("schema-setup");
		const wrote = await setupProject(root);
		expect(wrote).toContain(join("schema", "INDEX.md"));
		expect(wrote.some((path) => /schema[\\/].*README\.md$/i.test(path))).toBe(false);
		const text = readFileSync(join(root, "schema", "INDEX.md"), "utf8");
		for (const kind of ["database/", "interfaces/", "files/"]) expect(text).toContain(`- \`${kind}\`: `);
		expect(text.indexOf("- `database/`")).toBeLessThan(text.indexOf(CATALOG_START));
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		const catalog = docs.find((d) => d.group === "schema" && isCatalog(d));
		// Nothing is described yet, and the catalog says so: it is up to date.
		expect(catalog?.catalog).toEqual({ stale: false, area: "schema" });
		expect(schemaList(docs, { configured: true }).kinds.map((kind) => [kind.id, kind.count])).toEqual([["database", 0], ["interfaces", 0], ["files", 0]]);
	});

	test("a catalog that no longer says what the folder holds is out of date, and Health says so with the others", async () => {
		const root = fresh("schema-stale");
		await setupProject(root);
		mkdirSync(join(root, "schema", "database"), { recursive: true });
		writeFileSync(join(root, "schema", "database", "ORDERS.md"), "# ORDERS\n\nOne row for each order.\n");
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		expect(docs.find((d) => d.group === "schema" && isCatalog(d))?.catalog).toEqual({ stale: true, area: "schema" });
		expect(docChecks(docs).map((check) => check.text)).toContain("The catalog of the schema folder is out of date.");
	});

	test("a schema folder with descriptions and no catalog is offered one, as the other folders are", async () => {
		const root = fresh("schema-none");
		mkdirSync(join(root, "schema", "database"), { recursive: true });
		writeFileSync(join(root, "schema", "database", "ORDERS.md"), "# ORDERS\n\nOne row for each order.\n");
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		const check = docChecks(docs).find((found) => found.text.includes("no catalog"));
		// By what it is, since a project may call the folder anything.
		expect(check).toMatchObject({ level: "note", text: "The schema folder has no catalog (INDEX.md).", fix: { kind: "catalogs" } });
		// Said with another folder's, each by its own name.
		writeFileSync(join(root, "docs-placeholder"), "");
		mkdirSync(join(root, "docs", "tickets"), { recursive: true });
		writeFileSync(join(root, "docs", "tickets", "A-1.md"), "---\nticket: A-1\n---\n# A\n");
		const both = docChecks(await listDocs(new WorkspaceFiles(root), await readProject(root))).find((found) => found.text.includes("no catalog"));
		expect(both?.text).toBe("tickets/ and the schema folder have no catalog (INDEX.md).");
	});

	test("a schema folder inside the docs folder has its own catalog marked, though the documents list it too", async () => {
		const root = fresh("schema-in-docs");
		mkdirSync(join(root, ".ssl-studio"), { recursive: true });
		writeFileSync(join(root, ".ssl-studio", "project.toml"), '[project]\nname = "In docs"\n\n[folders]\ndocs = "docs"\nschema = "docs/schema"\n');
		mkdirSync(join(root, "docs", "schema", "database"), { recursive: true });
		writeFileSync(join(root, "docs", "schema", "database", "ORDERS.md"), "# ORDERS\n\nOne row for each order.\n");
		writeFileSync(join(root, "docs", "schema", "INDEX.md"), catalogTemplate("schema"));
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		const listed = docs.filter((d) => d.path === join(root, "docs", "schema", "INDEX.md"));
		// Listed with the documents and with the schema: the one that is the schema's says it is out of date.
		expect(listed.map((d) => d.group).sort()).toEqual(["docs", "schema"]);
		expect(listed.find((d) => d.group === "schema")?.catalog).toEqual({ stale: true, area: "schema" });
		expect(listed.find((d) => d.group === "docs")?.catalog).toBeUndefined();
		expect(docChecks(docs).map((check) => check.text)).toContain("The catalog of the schema folder is out of date.");
	});

	test("a schema folder that is the project's own folder is no folder to catalogue", async () => {
		const root = fresh("schema-root");
		mkdirSync(join(root, ".ssl-studio"), { recursive: true });
		writeFileSync(join(root, ".ssl-studio", "project.toml"), '[project]\nname = "Flat"\n\n[folders]\nschema = "."\n');
		writeFileSync(join(root, "ORDERS.md"), "# ORDERS\n\nOne row for each order.\n");
		writeFileSync(join(root, "INDEX.md"), catalogTemplate("schema"));
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		// No catalog is marked for it, and the checks, told which folders have catalogs here, ask for none.
		expect(docs.filter((d) => d.group === "schema" && d.catalog)).toEqual([]);
		const areas = CATALOG_AREAS.filter((area) => area !== "schema");
		expect(docChecks(docs, areas).filter((check) => /catalog/.test(check.text))).toEqual([]);
	});

	test("the catalog a new project gets names the kinds under what the folder is for, apart from the list the app keeps", async () => {
		const root = fresh("schema-kinds");
		await setupProject(root);
		const text = readFileSync(join(root, "schema", "INDEX.md"), "utf8");
		const kinds = text.indexOf("- `database/`");
		const note = text.indexOf("The list between the two markers");
		// Kinds, a blank line, then the line about the app's own list: that line is not about the kinds.
		expect(kinds).toBeGreaterThan(0);
		expect(kinds).toBeLessThan(note);
		expect(text.slice(kinds, note).endsWith("\n\n")).toBe(true);
		expect(text.slice(0, kinds).endsWith("\n\n")).toBe(true);
		expect(text).toContain(`${CATALOG_START}\n\nNothing here yet.\n\n${CATALOG_END}`);
	});
});

describe("the order of the schema catalog's headings", () => {
	const at = (name: string, kind: string, title: string): DocFile => ({ path: `/p/schema/${name}`, name, group: "schema", exists: true, kind, title });
	const where = { docs: "/p/docs", schema: "/p/schema" };

	test("is by kind, then what lies in the kind's own folder, then the folders inside it by name", () => {
		const items = catalogItems("schema", [at("audit/sub/C.md", "audit", "C"), at("Audit B/B.md", "Audit B", "B"), at("audit/A.md", "audit", "A"), at("audit/alpha/D.md", "audit", "D")], where);
		expect([...new Set(items.map((item) => item.section))]).toEqual(["audit", "audit: alpha", "audit: sub", "Audit B"]);
	});

	test("what lies at the top is headed apart from a folder a project happens to call the same", () => {
		const items = catalogItems("schema", [at("At the top/X.md", "At the top", "X"), at("Loose.md", "", "Loose")], where);
		expect(items.map((item) => [item.section, item.title])).toEqual([["At the top", "X"], ["At the top of the folder", "Loose"]]);
		// With no such folder, it is simply "At the top".
		expect(catalogItems("schema", [at("Loose.md", "", "Loose")], where)[0]?.section).toBe("At the top");
	});
});
