// What the heading of each list in the Docs panel offers from its menu
// (right-click, the menu key, Shift+F10): a new document of the kind the list
// keeps, a new folder in the list's folder, and the folder's place in the
// Explorer. Pure, so it can be tested: which folder a list is, what its menu
// holds, and where a typed name puts a new document or folder.
import { UNLISTED } from "./paths";
import { DOC_FOLDERS, KNOWLEDGE, SCHEMAS, type KnowledgeKind, type SchemaKind } from "./projectDocs";

/**
 * A list of the Docs panel that has a folder of its own. "Project" has none: its files are at the top of the folder.
 * "schema:database" is a folder under the schema folder: one of the kinds the app knows, or one of the project's own.
 */
export type DocSection = "work" | "knowledge" | `knowledge:${KnowledgeKind["id"]}` | "registries" | "docs" | "schema" | `schema:${string}` | "plans";

/** The folders the project's settings name, each from the top of the workspace. */
export type SectionFolders = { docs: string; schema: string; plans: string };

export const NEW_TICKET = "New ticket…";
export const IMPORT_TICKETS = "Import tickets…";
export const NEW_SPEC = "New spec…";
export const NEW_PLAN = "New plan…";
export const NEW_REGISTRY = "New registry…";
export const NEW_DOCUMENT = "New document…";
export const NEW_FOLDER = "New folder…";
export const SHOW_FOLDER = "Show in the Explorer";
/** "New decision…", "New reference note…", "New table…": what the panel's own New menu calls it. */
export const newOfKind = (kind: { one: string }) => `New ${kind.one}…`;

/** The kind of the knowledge base a section is, when it is one. */
export const kindOf = (section: DocSection): KnowledgeKind | undefined => KNOWLEDGE.find((kind) => section === `knowledge:${kind.id}`);

/** The folder under the schema folder a section is, when it is one: "database", or a name of the project's own. */
export const schemaFolderOf = (section: DocSection): string | undefined => (section.startsWith("schema:") ? section.slice("schema:".length) : undefined);
/**
 * The kind of schema a section is, when it is one the app knows: whatever the capitals its folder is written in,
 * since a folder "Database" is the database's (and on some disks is the folder "database").
 */
export const schemaOf = (section: DocSection): SchemaKind | undefined => {
	// A folder inside a kind's folder ("schema:interfaces/ERP") is of that kind.
	const first = schemaFolderOf(section)?.split("/")[0]?.toLowerCase();
	return SCHEMAS.find((kind) => kind.id === first);
};

/**
 * The folder a section's documents are in, from the top of the workspace, with "/" between its parts: "" for the top
 * itself, which a folder set to "." in the project's settings is. No part of it is ".": what is made or shown there is
 * named the way every listing names it.
 */
export function sectionFolder(section: DocSection, folders: SectionFolders): string {
	const kind = kindOf(section);
	const under = schemaFolderOf(section);
	const said = kind
		? `${folders.docs}/${DOC_FOLDERS.knowledge}/${kind.id}`
		: under !== undefined
			? `${folders.schema}/${under}`
			: section === "work"
			? `${folders.docs}/${DOC_FOLDERS.tickets}`
			: section === "knowledge"
				? `${folders.docs}/${DOC_FOLDERS.knowledge}`
				: section === "registries"
					? `${folders.docs}/${DOC_FOLDERS.registries}`
					: section === "docs"
						? folders.docs
						: section === "schema"
							? folders.schema
							: folders.plans;
	return folderParts(said).join("/");
}

/** The parts of a folder said from the top of the workspace: nothing for the top itself. */
export const folderParts = (folder: string) => folder.split(/[\\/]+/).filter((part) => part && part !== ".");

/** A folder as it is said in a question or a notice: "docs/guides/", or the project's own folder in words. */
export const folderSaid = (folder: string) => (folderParts(folder).length ? `${folderParts(folder).join("/")}/` : "the project's folder");

/** True for a section whose documents are plain Markdown, named by whoever writes them: a new one can go in a folder of its own. */
export const plainSection = (section: DocSection) => section === "docs" || section === "schema" || section.startsWith("schema:");

/**
 * The menu of a section's heading: first what the section keeps, by the names
 * the panel's New menu gives them, then a new folder in the section's folder,
 * then the folder in the Explorer (which is where an empty folder shows).
 */
export function sectionMenu(section: DocSection): string[] {
	const kind = kindOf(section) ?? schemaOf(section);
	const own = kind
		? [newOfKind(kind)]
		: section === "schema"
			? SCHEMAS.map(newOfKind)
			: section === "work"
			? [NEW_TICKET, IMPORT_TICKETS, NEW_SPEC]
			: section === "knowledge"
				? KNOWLEDGE.map(newOfKind)
				: section === "registries"
					? [NEW_REGISTRY]
					: section === "plans"
						? [NEW_PLAN]
						: [NEW_DOCUMENT];
	return [...own, NEW_FOLDER, SHOW_FOLDER];
}

/** What a file's or a folder's name cannot hold on one system or another: written as "-". */
const UNSAFE = /[:*?"<>|]+/g;
/** Names Windows keeps for its devices, whatever follows a dot: no file or folder can be called one there. */
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Where a typed name puts something new in a folder. "Intro" is a name;
 * "guides/Intro" is a name in a folder, which is made when it is not there.
 * Each part is the name of a folder or a file, so it cannot be empty, "." or
 * "..": nothing typed here leads out of the folder it was asked for. Nor can
 * it be a name that would not be the same on every system (one that ends in
 * a dot, or is a device's on Windows), or one of the folders no listing
 * shows: what was made there would be seen nowhere in the app. `last` says
 * what the last part names: a file is not a folder that is left out.
 */
export function typedParts(typed: string, last: "folder" | "file" = "folder"): { parts: string[] } | { problem: string } {
	const name = typed.trim();
	if (!name) return { problem: NEEDED };
	const parts = name.split(/[\\/]/).map((part) => part.replace(UNSAFE, "-").trim());
	if (parts.some((part) => !part || part.endsWith(".") || DEVICE.test(part))) return { problem: unusable(name) };
	// Whatever its capitals: on a disk that does not tell them apart, "Build" is the folder "build". Chosen knowingly:
	// on a disk that does tell them apart, a folder "Build" that is there and listed cannot be named here either, so
	// that a name means the same on every system. A file is listed whatever folder's name it has before its ending.
	const unlisted = (last === "file" ? parts.slice(0, -1) : parts).find((part) => (UNLISTED as readonly string[]).includes(part.toLowerCase()));
	if (unlisted && (UNLISTED as readonly string[]).includes(unlisted)) return { problem: `“${unlisted}” is a folder the app leaves out of every list: nothing made there would be shown.` };
	if (unlisted) return { problem: `“${unlisted}” is the folder “${unlisted.toLowerCase()}” on a disk that does not tell capitals apart, and the app leaves that one out of every list.` };
	return { parts };
}

const NEEDED = "A name is needed.";
const unusable = (name: string) => `“${name}” is not a name that can be used here.`;

/**
 * A new Markdown document from the name typed for it: the folders it goes
 * in, its file, and the heading it opens with (the last part of the name as
 * it was typed, which may hold what a file's name cannot, and may end in a
 * full stop, which the file's name leaves off). A full stop inside the name
 * stays in it: "e.g." is the file `e.g.md`, the name "e.g" with its ending.
 */
export function typedDocument(typed: string): { folders: string[]; file: string; title: string } | { problem: string } {
	const whole = typed.trim();
	// The ending may be typed, and a sentence's full stop may follow it: "Intro.md." is Intro.md, headed "Intro.".
	const ending = /\.(md|markdown)(?=[.\s]*$)/i;
	const name = whole.replace(ending, "");
	const title = name.split(/[\\/]/).pop()!.trim();
	// What the file is called: the name without the full stops a sentence ends in.
	const called = name.replace(/[.\s]+$/, "");
	if (!called) return { problem: name.replace(/\s+/g, "") ? unusable(whole) : NEEDED };
	// What is left is itself only endings (".md .md", ".md.md.md"): no name was typed before them.
	if (/(^|[\\/])(\s*\.(md|markdown))+$/i.test(called)) return { problem: unusable(whole) };
	const placed = typedParts(called, "file");
	// A name refused for what it is, is refused in the words that were typed, ".md" and all.
	if ("problem" in placed) return { problem: placed.problem === unusable(called) ? unusable(whole) : placed.problem };
	return { folders: placed.parts.slice(0, -1), file: `${placed.parts.at(-1)}.md`, title };
}
