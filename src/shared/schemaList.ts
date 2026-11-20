// The Docs panel's Schema list, worked out from the files the schema folder
// holds (ADR 0026): each kind with what lies in its folder, what lies in a
// folder inside it under that folder's name (the systems a project exchanges
// messages with, the areas of a database), what lies at the top of the schema
// folder, and the folder's catalog. Pure, so it can be tested.
import { isCatalog, SCHEMAS } from "./projectDocs";
import type { DocFile } from "./protocol";

/** A folder inside a kind's folder, with what it holds: a system among the interfaces, an area of the database. */
export type SchemaPart = {
	/** The folder's name, as it is written. */
	name: string;
	/** The folder from the schema folder, with "/" between its parts: "interfaces/ERP". */
	folder: string;
	files: DocFile[];
};

export type SchemaKindList = {
	/** The kind's id ("database"), or the folder's name for a kind of the project's own. */
	id: string;
	name: string;
	/** One of the kinds the app knows. */
	known: boolean;
	/** The kind's folder as the project has it: a known kind's may be written in other capitals ("Database"). */
	folder: string;
	/** What lies in the kind's folder itself. */
	files: DocFile[];
	parts: SchemaPart[];
	/** Everything the kind lists, in its folder and in the folders inside it. */
	count: number;
};

export type SchemaList = {
	kinds: SchemaKindList[];
	/** What lies at the top of the schema folder, other than its catalog. */
	top: DocFile[];
	/** The schema folder's catalog (INDEX.md), listed last and apart, as the other folders' catalogs are. */
	catalog?: DocFile;
	/** How many files the list shows, the catalog apart. */
	count: number;
};

const parts = (file: DocFile) => file.name.split(/[\\/]/);
const isReadme = (file: DocFile) => /^readme\.(md|markdown)$/i.test(parts(file).at(-1) ?? "");
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/**
 * The schema list. A kind the app knows is shown once the project is set up, empty or not (it is where the first of
 * its kind goes), but not while a filter is narrowing the list. `files` are the schema group's, in the order they
 * are listed in.
 */
export function schemaList(files: readonly DocFile[], options: { configured?: boolean; filtered?: boolean } = {}): SchemaList {
	// The folder's own catalog is not one of the things it describes.
	const catalog = files.find((file) => file.group === "schema" && !file.kind && isCatalog(file));
	const schema = files.filter((file) => file.group === "schema" && file !== catalog);
	const own = [...new Set(schema.flatMap((file) => (file.kind && !SCHEMAS.some((known) => known.id === file.kind) ? [file.kind] : [])))].sort(byName);
	const kinds = [...SCHEMAS.map((known) => ({ id: known.id as string, name: known.name, known: true })), ...own.map((name) => ({ id: name, name, known: false }))]
		.map((kind): SchemaKindList => {
			const all = schema.filter((file) => file.kind === kind.id);
			const folder = all[0] ? parts(all[0])[0]! : kind.id;
			// A file two folders down is in a folder inside the kind's: named by the first of them, whatever lies deeper.
			const inside = [...new Set(all.flatMap((file) => (parts(file).length > 2 ? [parts(file)[1]!] : [])))].sort(byName);
			return {
				...kind,
				folder,
				files: all.filter((file) => parts(file).length <= 2),
				parts: inside.map((name) => ({ name, folder: `${folder}/${name}`, files: all.filter((file) => parts(file).length > 2 && parts(file)[1] === name) })),
				count: all.length,
			};
		})
		.filter((kind) => kind.count || (kind.known && !options.filtered && options.configured));
	const top = schema.filter((file) => !file.kind);
	return { kinds, top, catalog, count: kinds.reduce((sum, kind) => sum + kind.count, 0) + top.length };
}

/**
 * What a file is called in the list: what it calls itself, or else its name in the folder it is listed under (the
 * SQL, a sample, a schema). A folder's README goes by its file's name too: titled as its folder is, it would repeat
 * the heading it stands under. `under` is how many folders of its name the heading it stands under already says.
 */
export function schemaRowTitle(file: DocFile, under: number): string {
	const rest = parts(file).slice(under).join("/");
	return isReadme(file) ? rest : file.title || rest;
}
