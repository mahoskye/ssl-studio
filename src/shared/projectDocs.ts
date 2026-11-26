import { CATALOG_FILE, type CatalogItem } from "./catalog";
import { frontMatter, quoteYamlText } from "./frontMatter";
import { baseName, isInside, joinPath, relativePath } from "./paths";
import type { DocFile, DocGroup } from "./protocol";

// What a project's documents are, beyond its README: the tickets that drive
// the work, the specs written from them, a knowledge base of decisions,
// questions and things kept for use, and the registries a migration is
// checked against (ADR 0012). All of it is under the project's docs folder;
// this says where, and what a new one of each starts as.

/** The folders under the docs folder, each with its catalog. */
export const DOC_FOLDERS = { tickets: "tickets", specs: "specs", knowledge: "knowledge", registries: "registries" } as const;
export type DocArea = keyof typeof DOC_FOLDERS;
/**
 * A folder with a catalog. The four under the docs folder hold the working documents; the schema folder, the docs
 * folder itself, and the tests and code folders are the project's own and may lie anywhere in it (ADR 0026). Each
 * says what it is for and lists what it holds, in place of a README written once and left.
 */
export type CatalogArea = DocArea | "schema" | "docs" | "tests" | "code";
// The code before the tests: where a project keeps both in one folder, that folder is its code.
export const CATALOG_AREAS: readonly CatalogArea[] = ["tickets", "specs", "knowledge", "registries", "schema", "docs", "code", "tests"];
/**
 * The folders whose catalog a project may do without: it comes with "Set up project", or is started when asked
 * for, and is never started by a step that only keeps catalogs up to date. A file called INDEX.md there that has no
 * place for the list is a person's own, and is left alone.
 */
export const OPTIONAL_CATALOGS: readonly CatalogArea[] = ["docs", "code", "tests"];
/** The folders whose catalog lists files as they lie: what they hold is scripts and what scripts need, not documents. */
export type FileArea = "tests" | "code";
export const isFileArea = (area: CatalogArea): area is FileArea => area === "tests" || area === "code";
/** The project's folders, as whole paths. The tests and code folders are needed only for their own catalogs. */
export type AreaFolders = { docs: string; schema: string; tests?: string; code?: string };
/** Where an area's folder is: under the docs folder, or one of the project's own folders. */
export const areaPath = (area: CatalogArea, folders: AreaFolders): string =>
	area === "schema" ? folders.schema : area === "docs" ? folders.docs : area === "tests" ? (folders.tests ?? "") : area === "code" ? (folders.code ?? "") : joinPath(folders.docs, DOC_FOLDERS[area]);

/** The project's state, in plain words: at the top of the docs folder. */
export const STATE_FILE = "STATE.md";

export type KnowledgeKind = { id: "decisions" | "questions" | "snippets" | "prompts" | "reference"; name: string; one: string; about: string };
/** The kinds of thing the knowledge base keeps, each in its own folder. */
export const KNOWLEDGE: readonly KnowledgeKind[] = [
	{ id: "decisions", name: "Decisions", one: "decision", about: "What was decided, and why: one decision in a file." },
	{ id: "questions", name: "Questions", one: "question", about: "What is not yet known, and what was answered: one question in a file." },
	{ id: "snippets", name: "Snippets", one: "snippet", about: "SQL queries and pieces of SSL kept for use." },
	{ id: "prompts", name: "Prompts", one: "prompt", about: "Questions and instructions for the agent, kept to be put to it again." },
	{ id: "reference", name: "Reference", one: "reference note", about: "How something works: one subject in a file." },
];

export type SchemaKind = { id: "database" | "interfaces" | "files"; name: string; one: string; about: string; columns: readonly string[] };
/**
 * What the project's data looks like, each kind in its own folder under the schema folder: the tables it reads and
 * writes, the messages it exchanges with instruments and other systems, and the files it reads or writes. Any other
 * folder there is a kind of the project's own, listed under its own name.
 */
export const SCHEMAS: readonly SchemaKind[] = [
	{ id: "database", name: "Database", one: "table", about: "The tables the project reads and writes: one Markdown file for each table or area, with its columns, types and keys, and a line on what it is for. `.sql` files are listed too.", columns: ["Column", "Type", "Null", "What it holds"] },
	{ id: "interfaces", name: "Interfaces", one: "interface message", about: "What the project exchanges with instruments and other systems, and what was agreed with them: one Markdown file for each message, with its fields, in a folder for each system. The agreed specification itself (OpenAPI, WSDL, XSD) or a sample of the message can lie beside it.", columns: ["Field", "Type", "Needed", "What it holds"] },
	{ id: "files", name: "Files", one: "file layout", about: "The files the project reads or writes: one Markdown file for each layout, with its columns. A sample file can lie beside it.", columns: ["Column", "Type", "Example", "What it holds"] },
];

export type RegistryKind = { id: string; file: string; title: string; about: string; columns: readonly string[] };
/** The registries a project is offered. Each is a table of values with a `status` column to say how far each row has come. */
export const REGISTRIES: readonly RegistryKind[] = [
	{ id: "settings", file: "settings.csv", title: "Application settings", about: "Each setting the application reads: its name, its value, where it is set.", columns: ["name", "value", "where", "ticket", "status", "note"] },
	{ id: "files", file: "files.csv", title: "File manifest", about: "Each file of the project, with its size and a checksum, to check that all of it came across.", columns: ["path", "kind", "bytes", "lines", "sha256", "status", "note"] },
	{ id: "database", file: "database.csv", title: "Database objects", about: "Each table, view, procedure and sequence the project reads or writes.", columns: ["object", "kind", "used by", "ticket", "status", "note"] },
	{ id: "interfaces", file: "interfaces.csv", title: "Interfaces", about: "Each system the application sends to or reads from: instruments, other applications, files dropped in a folder.", columns: ["interface", "direction", "how", "ticket", "status", "note"] },
	{ id: "jobs", file: "jobs.csv", title: "Scheduled jobs", about: "Each job that runs on its own: when it runs and what it calls.", columns: ["job", "runs", "calls", "ticket", "status", "note"] },
	{ id: "reports", file: "reports.csv", title: "Reports and labels", about: "Each report, label and printed form, and what reads it.", columns: ["report", "kind", "used by", "ticket", "status", "note"] },
	{ id: "roles", file: "roles.csv", title: "Roles and access", about: "Each role, and what it may do. Roles, not people.", columns: ["role", "may do", "ticket", "status", "note"] },
];

/** The words a status is usually one of, by what they come to: a row that is finished, under way, waiting, or set aside. */
const TONES: Record<string, readonly string[]> = {
	done: ["done", "accepted", "agreed", "answered", "verified", "migrated", "closed", "resolved", "complete", "completed", "approved", "built"],
	active: ["in progress", "doing", "started", "under way", "building", "review", "in review", "testing"],
	waiting: ["open", "to do", "todo", "planned", "ready", "draft", "proposed", "new", "found", "pending", ""],
	off: ["dropped", "superseded", "retired", "rejected", "blocked", "gone", "not needed", "not planned", "duplicate", "won't do", "wontfix", "cancelled", "canceled"],
};
export type Tone = "done" | "active" | "waiting" | "off";
/** What a status comes to. A word that is none of those known is taken as under way. */
export function toneOf(status: string | undefined): Tone {
	const word = (status ?? "").trim().toLowerCase();
	for (const [tone, words] of Object.entries(TONES)) if (words.includes(word)) return tone as Tone;
	return "active";
}

/** A name for a file from a title: its letters and digits, the rest as single dashes. */
export const slug = (title: string) =>
	title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");

/** A ticket's key as a file name: "LIMS-123", whatever case and spaces it was typed with. */
export const ticketKey = (typed: string) => typed.trim().toUpperCase().replace(/\s+/g, "-").replace(/[^A-Z0-9_-]/g, "");

/**
 * The lines a new document starts with, where its own words go. One still
 * there says nothing about the document: it is not its summary.
 */
export const PROMPTS = {
	ticket: "Paste the ticket's description here, in its own words.",
	spec: "One sentence on what this builds, and for whom.",
	decision: "What made a decision necessary.",
	question: "What cannot be done, or decided, until this is known.",
	reference: "One sentence on what this explains.",
	sql: "What it is for, and what to change before running it.",
	ssl: "What it is for, and what to change before using it.",
	prompt: "The words to put to the agent, as they are to be sent.",
	database: "What the table holds, and what writes it.",
	interfaces: "Who sends it, who receives it, and when.",
	files: "What the file is, who writes it and who reads it.",
	contract: "Where the agreed specification is kept, and who answers for it on each side.",
	state: "One paragraph.",
} as const;
/** Whether a line is one a template wrote, not yet replaced. */
export const isPrompt = (line: string | undefined) => Object.values(PROMPTS).some((prompt) => prompt === (line ?? "").trim());

const fence = (pairs: [string, string | undefined][]) => `---\n${pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n`;
/**
 * A value on its one line: a line end inside it is a space, and it is quoted when it holds what would be read as
 * something else. What that is, is said in one place, beside the reader (`quoteYamlText`): the rule kept here knew
 * a colon and a hash and not `@x`, `- x` or `NO`, which the other writers of front matter quote or YAML misreads.
 */
const quoted = (value: string) => quoteYamlText(value.replace(/\s*[\r\n]+\s*/g, " "));
/** A value as it is written in front matter: quoted when it holds what would be read as something else. */
export const frontValue = quoted;
/**
 * A list on one line, `[a, "b, c"]`, each item written by the same rule as a value on its own: an item with a
 * comma was read back as two, one with a hash cut the list short, and `[x]` made the whole line a string.
 */
const quotedList = (items: readonly string[]) => `[${items.map(quoted).filter((item) => item !== '""').join(", ")}]`;

export const ticketTemplate = (ticket: { key: string; title: string; source?: string; related?: readonly string[]; blocks?: readonly string[]; blockedBy?: readonly string[]; status?: string; type?: string; parent?: string; description?: string }) => `${fence([
	// Quoted like the title when it holds what YAML reads as something else: a key such as #12 was a comment, and the ticket had none.
	["ticket", quoted(ticket.key)],
	["title", quoted(ticket.title)],
	["type", ticket.type ? quoted(ticket.type) : undefined],
	["source", ticket.source?.trim() ? quoted(ticket.source) : undefined],
	["status", ticket.status ? quoted(ticket.status) : "open"],
	// The tickets it names, by the same rule: these four were written as they came, so a parent #11 was a comment
	// and the ticket had no parent, and `related: [#13, a, b]` was not the two keys it was written from.
	["parent", ticket.parent?.trim() ? quoted(ticket.parent) : undefined],
	["related", quotedList(ticket.related ?? [])],
	["blocks", ticket.blocks?.length ? quotedList(ticket.blocks) : undefined],
	["blocked-by", ticket.blockedBy?.length ? quotedList(ticket.blockedBy) : undefined],
])}
# ${ticket.key}: ${ticket.title}

## What is asked

${ticket.description?.trim() || PROMPTS.ticket}

## What done looks like

- [ ] What must be true when this is done: one thing to a line, ticked as it is.

## Notes

`;

export const specTemplate = (spec: { title: string; ticket?: string }) => `${fence([
	["title", quoted(spec.title)],
	["ticket", spec.ticket ? quoted(spec.ticket) : undefined],
	["status", "draft"],
])}
# ${spec.title}

${PROMPTS.spec}

## What it does

-

## What it does not do

-

## How it is checked

- [ ] A case that shows it works: one to a line, ticked as it passes.
`;

export const decisionTemplate = (decision: { title: string; date: string; ticket?: string }) => `${fence([
	["title", quoted(decision.title)],
	["status", "proposed"],
	["date", decision.date],
	["ticket", decision.ticket ? quoted(decision.ticket) : undefined],
])}
# ${decision.title}

## Context

${PROMPTS.decision}

## Decision

What was decided.

## Consequences

What follows from it, good and bad.
`;

export const questionTemplate = (question: { title: string; date: string; ticket?: string }) => `${fence([
	["title", quoted(question.title)],
	["status", "open"],
	["asked", question.date],
	["ticket", question.ticket ? quoted(question.ticket) : undefined],
])}
# ${question.title}

## Why it matters

${PROMPTS.question}

## Answer

Not answered yet. When it is: the answer, who gave it and when, and set the status to answered.
`;

export const referenceTemplate = (note: { title: string }) => `# ${note.title}

${PROMPTS.reference}
`;

/** A prompt kept for the agent: its name, then the words that are put to it. */
export const promptTemplate = (prompt: { title: string }) => `# ${prompt.title}

${PROMPTS.prompt}
`;

/**
 * The words of a kept prompt, as they go into the agent's box: the document without the lines it opens with and
 * without its heading, which is its name and not part of what is asked. Nothing for a prompt still as its template.
 */
export function promptText(text: string): string {
	const body = frontMatter(text)
		.body.replace(/^\s*#(?:[ \t]+[^\r\n]*)?[ \t]*(\r?\n|$)/, "")
		.trim();
	return isPrompt(body.split(/\r?\n/)[0]) ? "" : body;
}

/**
 * A description of one table, one message or one file layout: what it is, then its columns or fields as a table.
 * What is exchanged with another system is a contract with it, so a message opens with whom it is exchanged with,
 * which way it goes, the version agreed and how far the agreement is, and says where the agreed specification is.
 */
export const schemaTemplate = (kind: SchemaKind, title: string, about: { with?: string; direction?: "in" | "out" | "both" } = {}) => `${
	kind.id === "interfaces"
		? fence([
				["with", about.with ? quoted(about.with) : undefined],
				["direction", about.direction ?? "in"],
				["version", "1"],
				["status", "draft"],
			])
		: ""
}# ${title}

${PROMPTS[kind.id]}
${kind.id === "interfaces" ? `\n${PROMPTS.contract}\n` : ""}
| ${kind.columns.join(" | ")} |
| ${kind.columns.map(() => "---").join(" | ")} |
| ${kind.columns.map(() => " ").join(" | ")} |
${
	kind.id === "database"
		? `
## Foreign keys

| Column | Target table | Target column | Notes |
| --- | --- | --- | --- |
|   |   |   |   |

## Indexes

| Name | Unique | Columns |
| --- | --- | --- |
|   |   |   |
`
		: ""
}`;

/** A snippet starts with a comment that says what it is for: the catalog reads its first line as the title. */
export const snippetTemplate = (snippet: { title: string; language: "sql" | "ssl" }) =>
	// An SSL comment runs to its first semicolon: one in the title would end it early.
	snippet.language === "sql" ? `-- ${snippet.title}\n-- ${PROMPTS.sql}\n\nSELECT 1;\n` : `/* ${snippet.title.replace(/;/g, ",")}\n   ${PROMPTS.ssl}\n;\n`;

export const stateTemplate = (name: string, date: string) => `# Where ${name} stands

As of ${date}. Written to be read aloud to someone who is not an engineer: no
file names, no code.

## Where things stand

One paragraph.

## What works now

-

## What is half-built

-

## What is blocked, and on what

-

## What is next

-
`;

const CATALOG_NOTE = "The list between the two markers is written by SSL Studio from the files here (Docs panel, Update catalogs). Write anything else you like around it.";

/** A catalog as it starts: what the folder is for, and an empty list between its markers. */
/** What each catalogued folder is called, and what it is for: what its catalog opens with. */
export const CATALOG_HEADS: Record<CatalogArea, [string, string]> = {
	docs: ["Docs", "Notes and decisions about this project, and the working documents the work is written down in: the tickets, the specs, the knowledge base and the registries, each in its own folder with its own catalog."],
	tests: ["Tests", "Test scripts, and the sample requests and data they need."],
	code: ["Code", "The project's scripts and data sources."],
		schema: ["Schema", "What the project's data looks like, each kind in its own folder: the database's tables, the messages exchanged with other systems and what was agreed with them, and the files read or written. Another folder made here is a kind of the project's own."],
		tickets: ["Tickets", "The tickets that drive the work: one file for each, with what was asked, its state and the tickets it is related to."],
		specs: ["Specs", "Behavior and design specifics written from the tickets: one spec in a file, with its state."],
		knowledge: ["Knowledge base", "What the project has learned: decisions, questions, snippets and prompts kept for use, and notes on how things work."],
		registries: ["Registries", "What a migration is checked against: tables of the application's settings, its files and its database objects, each row with how far it has come."],
};
export const catalogTemplate = (area: CatalogArea) => `# ${CATALOG_HEADS[area][0]}\n\n${CATALOG_HEADS[area][1]}\n\n${CATALOG_NOTE}\n\n<!-- catalog -->\n\nNothing here yet.\n\n<!-- /catalog -->\n`;

/** A registry's name: what it is called when it is one of those offered, its file's name otherwise. */
export const registryTitle = (file: string) => REGISTRIES.find((r) => r.file.toLowerCase() === baseName(file).toLowerCase())?.title ?? baseName(file).replace(/\.[^.]+$/, "");

/** How far a registry is, in a few words: "12 rows", or "8 of 12 done". */
export function progress(file: Pick<DocFile, "rows" | "tally">): string {
	const rows = file.rows ?? 0;
	if (!file.tally) return `${rows} ${rows === 1 ? "row" : "rows"}`;
	const done = file.tally.by.filter(([status]) => toneOf(status) === "done").reduce((n, [, count]) => n + count, 0);
	return `${done} of ${file.tally.total} done`;
}

/** The same in as little room as it can be said: "8/12", or "12" for a table with no status. */
export function progressShort(file: Pick<DocFile, "rows" | "tally">): string {
	if (!file.tally) return String(file.rows ?? 0);
	const done = file.tally.by.filter(([status]) => toneOf(status) === "done").reduce((n, [, count]) => n + count, 0);
	return `${done}/${file.tally.total}`;
}

/** Whether a file is its folder's catalog. */
export const isCatalog = (file: Pick<DocFile, "name">) => baseName(file.name).toLowerCase() === CATALOG_FILE.toLowerCase();

const AREA_GROUP: Record<Exclude<CatalogArea, FileArea>, DocGroup> = { tickets: "tickets", specs: "specs", knowledge: "knowledge", registries: "registries", schema: "schema", docs: "docs" };

/** The most files a tests or code folder's catalog lists: a folder with more is found by the Explorer and by search. */
export const CATALOG_FILES_MAX = 1000;

/**
 * What the catalog of a tests or code folder lists: its files as they lie, each by its name, under the folder it is
 * in. Nothing is read from a file: what a script is for is the language server's to say, not this list's.
 * `paths` are from the catalog's folder, with "/" between their parts; the catalog itself is not among them.
 */
export function fileItems(paths: readonly string[]): CatalogItem[] {
	const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
	const folder = (path: string) => path.split("/").slice(0, -1).join("/");
	return [...paths]
		.filter((path) => path.toLowerCase() !== CATALOG_FILE.toLowerCase())
		// What lies in the folder itself first, then each folder inside it by its name.
		.sort((a, b) => byName(folder(a), folder(b)) || byName(a, b))
		.map((path) => ({ path, title: baseName(path), ...(folder(path) ? { section: folder(path) } : {}) }));
}

/**
 * What an area's catalog lists: each of its documents, with the way to it
 * from the catalog's folder. A ticket goes by its key and title, a registry by
 * how far it is, the knowledge base under the kinds of thing it keeps, and the
 * schema folder under its kinds, with a folder inside a kind (a system the
 * project exchanges messages with) named beside it.
 *
 * `where` is the docs folder, or the docs folder and the schema folder: the
 * schema's catalog needs the second.
 */
export function catalogItems(area: DocArea | "docs", files: readonly DocFile[], where: string | AreaFolders): CatalogItem[];
export function catalogItems(area: Exclude<CatalogArea, FileArea>, files: readonly DocFile[], where: AreaFolders): CatalogItem[];
export function catalogItems(area: Exclude<CatalogArea, FileArea>, files: readonly DocFile[], where: string | AreaFolders): CatalogItem[] {
	const folders = typeof where === "string" ? { docs: where, schema: "" } : where;
	const folder = areaPath(area, folders);
	// The knowledge base and the schema list their kinds in their own order, whatever the files' names.
	const schemaOrder = (file: DocFile) => SCHEMAS.findIndex((k) => k.id === file.kind) + 1 || (file.kind ? SCHEMAS.length + 1 : SCHEMAS.length + 2);
	const order = (file: DocFile) => (area === "knowledge" ? KNOWLEDGE.findIndex((k) => k.id === file.kind) + 1 || KNOWLEDGE.length + 1 : area === "schema" ? schemaOrder(file) : 0);
	const schema = files.filter((file) => file.group === "schema");
	// What lies at the top is headed so that no folder's name is taken for it, whatever a project calls its folders.
	const atTop = schema.some((file) => file.kind?.toLowerCase() === "at the top") ? "At the top of the folder" : "At the top";
	/** The heading a schema file is listed under: its kind, and the folder inside the kind where it is in one. */
	const schemaSection = (file: DocFile) => {
		const parts = file.name.split(/[\\/]/);
		const kind = !file.kind ? atTop : (SCHEMAS.find((k) => k.id === file.kind)?.name ?? file.kind);
		return file.kind && parts.length > 2 ? `${kind}: ${parts[1]}` : kind;
	};
	/** Within the schema: by kind, then what lies in the kind's own folder before the folders inside it, each by name. */
	const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
	const part = (file: DocFile) => (file.kind && file.name.split(/[\\/]/).length > 2 ? file.name.split(/[\\/]/)[1]! : "");
	const schemaBefore = (a: DocFile, b: DocFile) => byName(a.kind ?? "", b.kind ?? "") || Number(Boolean(part(a))) - Number(Boolean(part(b))) || byName(part(a), part(b));
	// The heading the working documents' catalogs are named under: kept apart from a folder a project calls the same.
	const working = files.some((file) => file.group === "docs" && file.name.split(/[\\/]/)[0]?.toLowerCase() === "working documents" && /[\\/]/.test(file.name)) ? "The working documents' catalogs" : "Working documents";
	// The docs folder's catalog is the way in to the others under it: each of those that is there is named first.
	const others: CatalogItem[] =
		area === "docs"
			? (Object.keys(DOC_FOLDERS) as DocArea[]).flatMap((name) => {
					const catalog = files.find((file) => file.group === AREA_GROUP[name] && file.exists && isCatalog(file) && !/[\\/]/.test(file.name));
					return catalog ? [{ path: relativePath(folder, catalog.path), title: CATALOG_HEADS[name][0], section: working }] : [];
				})
			: [];
	/** In the docs folder, a document in a folder of its own is listed under that folder; one at the top under none. */
	const docsSection = (file: DocFile) => file.name.split(/[\\/]/).slice(0, -1).join("/");
	/** What lies under the schema folder, where that is inside the docs folder, is the schema's to list, not the docs'. */
	const schemas = (file: DocFile) => area === "docs" && Boolean(folders.schema) && folders.schema !== folder && isInside(folders.schema, file.path);
	const listed = files
		.filter((file) => file.group === AREA_GROUP[area] && file.exists && !isCatalog(file) && !schemas(file))
		.map((file, at) => ({ file, at }))
		.sort((a, b) => order(a.file) - order(b.file) || (area === "schema" ? schemaBefore(a.file, b.file) : area === "docs" ? byName(docsSection(a.file), docsSection(b.file)) : 0) || a.at - b.at)
		.map(({ file }): CatalogItem => {
			const path = relativePath(folder, file.path);
			const named = file.title || baseName(file.name).replace(/\.(md|markdown|csv|tsv)$/i, "");
			if (area === "tickets") return { path, title: file.ticket && !named.startsWith(file.ticket) ? `${file.ticket}: ${named}` : named, status: file.status, summary: file.summary };
			// A note kept beside the registries is a document, not a table of none.
			if (area === "registries" && file.rows === undefined && !file.problems) return { path, title: named, status: file.status, summary: file.summary };
			if (area === "registries") return { path, title: registryTitle(file.name), status: progress(file) };
			if (area === "knowledge") return { path, title: named, status: file.status, summary: file.summary, section: KNOWLEDGE.find((k) => k.id === file.kind)?.name ?? "Other" };
			// A description by what it calls itself; what lies beside it (the SQL, a sample, a schema) by its file's name.
			if (area === "schema") return { path, title: file.title || baseName(file.name), status: file.status, summary: file.summary, section: schemaSection(file) };
			// A plain document under the folder it is in, where it is in one.
			if (area === "docs") return { path, title: file.heading || named, status: file.status, summary: file.summary, ...(docsSection(file) ? { section: docsSection(file) } : {}) };
			return { path, title: named, status: file.status, summary: file.tickets?.length ? `For ${file.tickets.join(", ")}.${file.summary ? ` ${file.summary}` : ""}` : file.summary };
		});
	// The documents first (those at the top, then each folder's), then the way to the working documents' own catalogs.
	return [...listed, ...others];
}

/** The most lines of code a question or a decision takes with it: enough to say what it is about, not a copy of the file. */
export const CODE_LINES_KEPT = 40;

/**
 * The part of a question or a decision that says which code it is about: a
 * link to the lines, which opens them, and the lines as they were when it was
 * written. `link` is the way to the file from the document's folder.
 */
export function codeSection(code: { file: string; link: string; from: number; to: number; text: string; language: string; date: string }): string {
	const lines = code.text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
	const kept = lines.slice(0, CODE_LINES_KEPT);
	const where = code.from === code.to ? `line ${code.from}` : `lines ${code.from} to ${code.to}`;
	const anchor = code.from === code.to ? `#L${code.from}` : `#L${code.from}-L${code.to}`;
	// A fence longer than any run of backticks in the code, so the code cannot close it.
	const fence = "`".repeat(Math.max(3, ...(code.text.match(/`+/g) ?? []).map((run) => run.length + 1)));
	return `\n## In the code\n\n[${code.file}, ${where}](${code.link.split("/").map(encodeURIComponent).join("/")}${anchor}), as it was on ${code.date}:\n\n${fence}${code.language}\n${kept.join("\n")}\n${fence}\n${lines.length > kept.length ? `\nThe first ${kept.length} of ${lines.length} lines.\n` : ""}`;
}

/** The lines a link to code asks for: "#L12" or "#L12-L18". Null when the link names none. */
export function linkedLines(href: string): { line: number; endLine?: number } | null {
	const found = /#L(\d+)(?:-L?(\d+))?$/i.exec(href);
	if (!found) return null;
	const line = Number(found[1]);
	const endLine = found[2] ? Number(found[2]) : undefined;
	return line > 0 ? { line, ...(endLine && endLine >= line ? { endLine } : {}) } : null;
}

/**
 * The states a document of each kind is usually in, in the order it moves
 * through them: what a status is chosen from. Any other word can still be
 * written in the text.
 */
export function statusChoices(
	file:
		| {
				group?: string;
				kind?: string;
				docKind?: string;
				version?: string;
				changeControl?: string;
				gxpImpact?: string;
		  }
		| undefined,
): string[] {
	if (file?.group === "tickets") return ["open", "in progress", "done", "blocked", "dropped"];
	if (file?.group === "specs") return ["draft", "ready", "in progress", "approved", "done", "superseded"];
	if (file?.group === "knowledge" && file.kind === "decisions") return ["proposed", "accepted", "superseded", "rejected"];
	if (file?.group === "knowledge" && file.kind === "questions") return ["open", "answered"];
	if (file?.group === "knowledge" && file.kind === "reference") return ["draft", "in progress", "approved", "done", "retired"];
	// What is exchanged with another system is a contract with it: proposed, then agreed by both, then no longer used.
	if (file?.group === "schema" && file.kind === "interfaces") return ["draft", "agreed", "retired"];
	const hasGxp = Boolean(file?.gxpImpact && !/^(?:none|no|n\/a|false)$/i.test(file.gxpImpact.trim()));
	if (file?.version || file?.changeControl || hasGxp || file?.docKind === "test-run") {
		return ["draft", "in progress", "approved", "done", "retired"];
	}
	return ["draft", "in progress", "done"];
}

/**
 * Standard friendly label and quiet filename metadata for curated Project-section
 * documents (ADR 0032). Returns null for documents outside the Project group.
 */
export function projectDocLabel(
	file: Pick<DocFile, "name" | "group" | "catalog">,
): { label: string; fileMeta: string } | null {
	if (file.group !== "project") return null;
	const norm = file.name.replace(/\\/g, "/");
	const base = norm.split("/").pop()?.toLowerCase() ?? norm.toLowerCase();
	if (base === "readme.md" || base === "readme.markdown") return { label: "Project Overview", fileMeta: file.name };
	if (base === "agents.md" || base === "agents.markdown") return { label: "Agent Instructions", fileMeta: file.name };
	if (base === "project.toml") return { label: "Project Settings", fileMeta: file.name };
	if (base === "state.md" || base === "state.markdown") return { label: "Project State", fileMeta: file.name };
	if (file.catalog?.area === "code") return { label: "Deployment", fileMeta: file.name };
	if (file.catalog?.area === "tests") return { label: "Tests", fileMeta: file.name };
	return { label: file.name, fileMeta: "" };
}

/**
 * Whether a document is one a filter is looking for: every word typed is in
 * its title, its name, its ticket's key, its state, what it is about, or the
 * tickets it is for. "open holiday" finds the open question about holidays.
 */
export function docMatches(
	file: Pick<DocFile, "name" | "title" | "heading" | "ticket" | "parent" | "status" | "summary" | "tickets" | "kind" | "tags"> &
		Partial<Pick<DocFile, "group" | "catalog">>,
	filter: string,
): boolean {
	const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const friendly = file.group === "project" ? projectDocLabel({ name: file.name, group: file.group, catalog: file.catalog })?.label : undefined;
	const said = [
		friendly,
		file.title,
		file.heading,
		file.name,
		file.ticket,
		file.parent,
		file.status,
		file.summary,
		file.kind,
		...(file.tickets ?? []),
		...(file.tags ?? []).flatMap((t) => [t, `#${t}`]),
	]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
	return words.every((word) => said.includes(word));
}
