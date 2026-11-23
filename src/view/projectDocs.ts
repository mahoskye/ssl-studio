// The project's working documents, made and kept from here: the tickets that
// drive the work, the specs, the knowledge base, the registries, and the
// catalog each of those folders is found by (ADR 0012). What these write is
// text like any other: an open file is changed through the editor, so it can
// be undone, and a file that exists is never written over.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { CATALOG_FILE, catalogBlock, catalogList, catalogStale, hasCatalogPlace, withCatalog, type CatalogItem } from "../shared/catalog";
import { csvCell, csvRow, parseCsv } from "../shared/csv";
import { localDay } from "../shared/dates";
import { docChecks } from "../shared/docChecks";
import { assembleTicketPacketMarkdown, buildPrintableHtml, escapeHtml, evaluateTicketReadiness, markdownToJira } from "../shared/docExport";
import { addToFrontMatterList, bodyOffset, frontMatter, many, one, removeFromFrontMatterList, replaceInFrontMatterList, withFrontMatter } from "../shared/frontMatter";
import { keysIn, ticketColumn } from "../shared/registryTickets";
import { extractSqlObjects, parseCreateTables, sqlTablesToMarkdown } from "../shared/sqlSchema";
import { importSummary, ticketsFromJson, ticketsFromTable, type Imported, type ImportedTicket } from "../shared/ticketImport";
import { manifestSummary, mergeManifest } from "../shared/manifest";
import { docByName, namesToFollow, withNames } from "../shared/namedLinks";
import { baseName, dirName, isInside, joinPath, relativePath, relativeTo, resolvePath } from "../shared/paths";
import { activeEditor } from "./editor/EditorGroup";
import {
	catalogItems,
	catalogTemplate,
	codeSection,
	decisionTemplate,
	DOC_FOLDERS,
	KNOWLEDGE,
	promptTemplate,
	questionTemplate,
	referenceTemplate,
	REGISTRIES,
	registryTitle,
	SCHEMAS,
	schemaTemplate,
	slug,
	snippetTemplate,
	specTemplate,
	STATE_FILE,
	stateTemplate,
	ticketKey,
	ticketTemplate,
	toneOf,
	frontValue,
	isCatalog,
	areaPath,
	CATALOG_AREAS,
	fileItems,
	isFileArea,
	OPTIONAL_CATALOGS,
	type AreaFolders,
	type CatalogArea,
	type KnowledgeKind,
	type SchemaKind,
} from "../shared/projectDocs";
import { folderParts, typedParts } from "../shared/docSections";
import type { DocFile, LinkTo, NameIn } from "../shared/protocol";
import { backend } from "./backend";
import { ask, choose } from "./dialogs";
import { toggleTask } from "../shared/tasks";
import type { LinkMend } from "../shared/docChecks";
import { ownLinkEdits, withLinkFiles, type LinkEdit } from "../shared/docLinks";
import { parsePlan, isPlanPath } from "./plan/model";
import { docs, isMarkdown } from "./project";
import { ticketAtHand as listedTicketAtHand, ticketWork, workFor, workLabel, workText, type WorkTextOptions } from "../shared/workContext";
import { finishMarkdown } from "./editor/markdownHtml";
import { activeDoc, activePath, applyText, canonical, documents, fileRemoved, fileRenamed, notify, openFile, save, setState, state } from "./state";

const today = () => localDay();
const root = () => state.workspace?.root ?? "";
// "." is the project's own folder: no part of a path, or the same file would have two spellings.
const docsFolder = () => joinPath(root(), ...(state.project?.docs ?? "docs").split(/[\\/]/).filter((part) => part && part !== "."));
// "." is the project's own folder here too.
const projectFolder = (said: string | undefined, usual: string) => joinPath(root(), ...folderParts(said ?? usual));
const schemaFolder = () => projectFolder(state.project?.schema, "schema");
const catalogFolders = (): AreaFolders => ({ docs: docsFolder(), schema: schemaFolder(), tests: projectFolder(state.project?.tests, "tests"), code: projectFolder(state.project?.code, "src") });
const areaFolder = (area: CatalogArea) => areaPath(area, catalogFolders());
/** An area's folder as it is said: "tickets", or one of the project's own folders by the name the project gives it. */
const areaSaid = (area: CatalogArea) => (area === "schema" || area === "docs" || isFileArea(area) ? relativeTo(root(), areaFolder(area)).split("\\").join("/") : DOC_FOLDERS[area]);
/**
 * Whether a folder is one to catalogue as this area. The schema, tests and code folders are not when they are the
 * project's own folder, nor is a folder an area before it already is (as the backend has it, bun/project.ts).
 */
function catalogued(area: CatalogArea): boolean {
	const folder = canonical(areaFolder(area));
	if ((area === "schema" || isFileArea(area)) && folder === canonical(root())) return false;
	// Only an area before it that is itself catalogued has the folder: one that is not (a schema folder that is the
	// project's own) leaves it to this one.
	return !CATALOG_AREAS.slice(0, CATALOG_AREAS.indexOf(area)).some((before) => canonical(areaFolder(before)) === folder && catalogued(before));
}
const ready = () => (state.workspace && state.project ? true : (notify("Open a folder first."), false));

/** A file's text as it stands: in the editor if it is open there, on disk otherwise, null when there is no such file. */
async function current(path: string): Promise<string | null> {
	const open = documents.get(canonical(path));
	if (open) return open.model.getValue();
	try {
		return (await backend.read(path)).text;
	} catch {
		return null;
	}
}

/**
 * Writes a file's text: through the editor when it is open there, where the
 * change can be undone. An open file that had nothing unsaved is saved with
 * the change, so what the folder says and what the editor shows stay the
 * same; one with unsaved work of the person's is left for them to save.
 */
async function put(path: string, text: string, existed: boolean) {
	const open = canonical(path);
	if (documents.get(open)) {
		const clean = !state.dirty[open];
		applyText(open, text);
		// A save that fails has said why; whoever asked for the write is told it was not made.
		if (clean && !(await save(open))) throw new Error(`${relativeTo(root(), path)} was changed in the editor and could not be saved.`);
		return;
	}
	if (!existed) await backend.create(path, "file");
	await backend.write(path, text);
}

/** Writes an area's catalog afresh from its documents; makes the catalog where there is none. True when it changed. */
async function writeCatalog(
	area: CatalogArea,
	files: readonly DocFile[],
	options: {
		/** Only where the folder has a catalog already: none is started. */
		kept?: boolean;
		/** Start one in a folder that may do without (the docs, code and tests folders): only when asked for. */
		start?: boolean;
		/** The docs folder's catalog is written by the caller in its own turn: not from here. */
		alone?: boolean;
	} = {},
): Promise<boolean> {
	if (!catalogued(area)) return false;
	// The catalog the folder already has, however its name is cased: a second one is not made beside it.
	const folder = canonical(areaFolder(area));
	const has = files.find((file) => file.exists && isCatalog(file) && canonical(dirName(file.path)) === folder && (file.catalog?.area ?? file.group) === area);
	const path = has?.path ?? joinPath(areaFolder(area), CATALOG_FILE);
	let items: CatalogItem[];
	if (isFileArea(area)) {
		// The tests' and the code's list their files as they lie. A folder with more than a catalog lists has none kept.
		const paths = await backend.catalogFiles(area);
		if (!paths) return false;
		items = fileItems(paths);
	} else items = catalogItems(area, files, catalogFolders());
	const before = await current(path);
	const optional = OPTIONAL_CATALOGS.includes(area);
	if (before === null && (!items.length || options.kept || (optional && !options.start))) return false;
	// In a folder that may do without a catalog, a file of that name with no place for the list is a person's own.
	if (before !== null && optional && !hasCatalogPlace(before)) return false;
	if (before !== null && !catalogStale(before, items)) return false;
	await put(path, withCatalog(before ?? catalogTemplate(area), items), before !== null);
	// The docs folder's catalog names the catalogs of the folders under it: one of those just started is one more for
	// it to name, where it is kept.
	if (before === null && area in DOC_FOLDERS && !options.alone) await writeCatalog("docs", await backend.docs(), { kept: true });
	return true;
}

/**
 * Catalogs (`INDEX.md`) are reconciled manually or via an explicit Agent trigger (ADR 0031),
 * never silently rewritten as a side effect of edits or file moves.
 */
export async function catalogsKeptFor(_paths: readonly string[]) {
	// Intentionally no-op: treeVersion refresh marks affected catalogs out of date in Docs & Health.
}

/** Makes a document from its template and opens it as text. A file already there is opened, not replaced. */
async function start(path: string, text: string, _area?: CatalogArea) {
	if ((await current(path)) !== null) {
		notify(`${relativeTo(root(), path)} is already there: opened.`);
		return openFile(path);
	}
	try {
		await backend.create(path, "file");
		await backend.write(path, text);
	} catch (e: any) {
		return notify(String(e?.message ?? e), "error");
	}
	setState("treeVersion", (v) => v + 1);
	if (isMarkdown(path)) setState("mdText", canonical(path), true);
	await openFile(path);
}

/** The ticket the open document is, or is for, as it stands in the editor: a document's front matter, or a plan's own. */
function ticketOfOpen(): string {
	const path = activePath();
	const doc = activeDoc();
	if (!path || !doc) return "";
	if (isPlanPath(path)) {
		const ticket = parsePlan(doc.model.getValue()).plan?.ticket;
		return typeof ticket === "string" ? ticket.trim() : "";
	}
	if (!isMarkdown(path)) return "";
	const { values } = frontMatter(doc.model.getValue());
	return many(values.ticket)[0] ?? many(values.tickets)[0] ?? "";
}

/** The ticket at hand: the open document's, or else the one ticket that is under way. "" when it cannot be told. */
export const ticketAtHand = (): string => ticketOfOpen() || listedTicketAtHand(docs(), activePath());

/**
 * The work a ticket is, as text for an agent that cannot read the folder, and
 * what that text holds in a few words. Null when the ticket is not among the
 * project's tickets.
 */
export async function workPrompt(key: string, options: WorkTextOptions = {}): Promise<{ text: string; label: string } | null> {
	const work = key ? workFor(docs(), key) : null;
	if (!work) return null;
	return { text: await workText(work, current, options), label: workLabel(work, options) };
}

/** A ticket: the work as it was asked for. Can live as a flat file or inside its own bundle folder (ADR 0030). */
export async function newTicket(known?: string, related?: string, options?: { parent?: string; type?: string }) {
	if (!ready()) return;
	const key = ticketKey(known ?? (await ask(options?.parent ? `Sub-ticket key under ${options.parent} (e.g. LIMS-124)` : "The ticket's key, as in LIMS-123")) ?? "");
	if (!key) return;
	const existing = docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === key.toLowerCase());
	if (existing) {
		notify(`${key} already exists (${relativeTo(root(), existing.path)}): opened.`);
		return openFile(existing.path);
	}
	const title = (await ask(`${key}: its title, as the ticket has it`))?.trim();
	if (!title) return;
	let parent = options?.parent;
	let type = options?.type;
	if (!parent && !known) {
		const kindPick = await choose(`${key}: ticket type`, ["Task", "Story", "Bug", "Epic", "Sub-task"]);
		if (!kindPick) return;
		type = kindPick;
		if (kindPick !== "Epic") {
			const parentInput = ticketKey((await ask(`${key}: parent epic/ticket key (leave empty for none)`)) ?? "");
			if (parentInput) parent = parentInput;
		}
	} else if (parent && !type) {
		type = "Sub-task";
	}
	const source = (await ask(`${key}: a link to the ticket (leave empty for none)`))?.trim();
	const FOLDER = "Ticket folder";
	const SINGLE = "Single file";
	const layout = await choose(
		`Create ${key} in its own ticket folder (${relativeTo(root(), joinPath(areaFolder("tickets"), key))}/) for reference docs, code samples, and fixtures, or as a single Markdown file?`,
		[FOLDER, SINGLE],
	);
	if (!layout) return;
	const target = layout === FOLDER ? joinPath(areaFolder("tickets"), key, `${key}.md`) : joinPath(areaFolder("tickets"), `${key}.md`);
	await start(target, ticketTemplate({ key, title, type, parent, source: source || undefined, related: related ? [related] : undefined }), "tickets");
}

/** Promotes a flat ticket (`docs/tickets/LIMS-123.md`) into a self-contained ticket bundle folder (`docs/tickets/LIMS-123/LIMS-123.md`). */
export async function createTicketFolder(ticketPath: string): Promise<string | null> {
	if (!ready()) return null;
	const clean = canonical(ticketPath);
	const listed = docs().find((d) => d.exists && d.group === "tickets" && canonical(d.path) === clean);
	if (listed?.ticketFolder && isInside(listed.ticketFolder, ticketPath)) {
		notify(`${listed.ticket ?? baseName(ticketPath)} already lives inside its ticket folder (${relativeTo(root(), listed.ticketFolder)}/).`);
		return listed.ticketFolder;
	}
	const key = listed?.ticket || ticketKey(baseName(ticketPath).replace(/\.(md|markdown)$/i, ""));
	if (!key) return null;
	const folderPath = listed?.ticketFolder ?? joinPath(dirName(ticketPath), key);
	const targetPath = joinPath(folderPath, baseName(ticketPath));
	const relFolder = relativeTo(root(), folderPath).split("\\").join("/");
	const GO = listed?.ticketFolder ? "Move into folder" : "Create folder";
	const answer = await choose(
		`Move ${baseName(ticketPath)} into its own ticket folder (${relFolder}/)? Reference docs, code samples, and fixtures placed there stay accessible via Explorer without cluttering the Docs panel.`,
		[GO],
	);
	if (answer !== GO) return null;
	if (state.dirty[clean]) {
		const saved = await save(clean);
		if (!saved) return null;
	}
	try {
		await backend.rename(ticketPath, targetPath);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
		return null;
	}
	fileRenamed(ticketPath, targetPath);
	setState("treeVersion", (v) => v + 1);
	await followRename(ticketPath, targetPath);
	notify(`Moved ${baseName(ticketPath)} into ${relFolder}/.`);
	return folderPath;
}

/** Creates a new reference note or companion file (e.g. `vendor-notes.md`, `samples/query.sql`) inside a ticket's folder. */
export async function newTicketFile(ticketFolder: string, key: string) {
	if (!ready()) return;
	const relFolder = relativeTo(root(), ticketFolder).split("\\").join("/");
	const raw = (await ask(`New file in ${relFolder}/ (e.g. notes, samples/legacy.sql, fixtures/input.json)`))?.trim();
	if (!raw) return;
	const parsed = typedParts(raw, "file");
	if ("problem" in parsed) return notify(parsed.problem, "error");
	const parts = parsed.parts;
	const last = parts.at(-1)!;
	const withExt = /\.[A-Za-z0-9]+$/.test(last) ? parts : [...parts.slice(0, -1), `${last}.md`];
	const target = joinPath(ticketFolder, ...withExt);
	const fileName = withExt.at(-1)!;
	const isMd = /\.(md|markdown)$/i.test(fileName);
	const stemTitle = fileName.replace(/\.(md|markdown)$/i, "").replace(/[-_]+/g, " ");
	const initial = isMd ? `# ${stemTitle}\n\nReference notes for ${key}.\n` : "";
	await start(target, initial);
}

/**
 * Tickets from an export of a ticket system: a table (CSV) or what its API
 * returns (JSON). A ticket not here yet gets its file; one already here has
 * its state, title and kind brought up to date in its front matter, and
 * nothing else in it is touched. Read from the open document when that is
 * such a file, or from a path.
 */
export async function importTickets() {
	if (!ready()) return;
	const exported = /\.(csv|tsv|json)$/i;
	const open = activePath();
	// Both spelled the one way the editor spells a path: a drive's letter is lowered there.
	const inFolder = open && exported.test(open) && !canonical(open).startsWith(canonical(areaFolder("registries"))) ? relativeTo(root(), open) : "";
	let typed: string;
	let from: string;
	let text: string | null;
	// In the app, with no export open, the system's own dialog finds the file: a download is not in the project.
	if (!inFolder && state.info?.host === "app") {
		let picked: { path: string; text: string } | null;
		try {
			picked = await backend.pickExport();
		} catch (e: any) {
			return notify(String(e?.message ?? e), "error");
		}
		if (!picked) return;
		[typed, from, text] = [baseName(picked.path), picked.path, picked.text];
	} else {
		typed = (await ask("The exported file (CSV or JSON): its path in this folder, or its whole path anywhere", inFolder))?.trim() ?? "";
		if (!typed) return;
		// As a person writes a path: in quotes when it was copied, from "~" for their own folder, or up and out of this one.
		const said = typed.replace(/^(["'])(.*)\1$/, "$2");
		const home = /^~[\\/]/.test(said);
		const whole = home || /^([A-Za-z]:[\\/]|\/)/.test(said);
		// "." and ".." are taken out before asking where it is: "/project/../Downloads" is not in the project.
		from = home ? said : whole ? resolvePath(said, ".") : resolvePath(root(), said);
		const inside = !home && isInside(root(), from);
		// In the folder it is read as the editor has it; anywhere else, from the disk, and the backend says why not.
		text = inside ? await current(from) : await backend.readExport(from).catch((e: any) => (notify(String(e?.message ?? e), "error"), null));
		if (text === null) return inside ? notify(`${typed} could not be read: there is no such file in this folder.`, "error") : undefined;
		// From outside the folder it is called by its name: the way there is long, and not the point.
		if (!inside) typed = baseName(from);
	}
	let read: Imported;
	if (/\.json$/i.test(from)) {
		try {
			read = ticketsFromJson(JSON.parse(text));
		} catch (e: any) {
			// What JSON itself could not read, and what the reader of tickets fell over, are two things to say.
			return notify(e instanceof SyntaxError ? `${typed} is not JSON that can be read: ${e.message}` : `${typed} could not be read as tickets: ${e?.message ?? e}`, "error");
		}
	} else {
		try {
			read = ticketsFromTable(parseCsv(text));
		} catch (e: any) {
			return notify(`${typed} could not be read as a table of tickets: ${e?.message ?? e}`, "error");
		}
	}
	if (read.problem) return notify(`${typed}: ${read.problem}`, "error");
	if (!read.tickets.length) return notify(importSummary({ made: 0, updated: 0, same: 0, skipped: read.skipped, pulls: read.pulls }));
	// A ticket that is in the export twice is one ticket: the last of its rows is the one that stands.
	const once = new Map(read.tickets.map((ticket) => [ticket.key.toLowerCase(), ticket]));
	read = { ...read, tickets: [...once.values()] };
	// Read fresh docs from backend so a newly pulled/created ticket bundle isn't missed by a debounced cache.
	const freshDocs = await backend.docs().catch(() => docs());
	const existingByKey = new Map(
		freshDocs
			.filter((d) => d.exists && d.group === "tickets" && d.ticket)
			.map((d) => [d.ticket!.toLowerCase(), d.path]),
	);
	const path = (ticket: ImportedTicket) => existingByKey.get(ticket.key.toLowerCase()) ?? joinPath(areaFolder("tickets"), `${ticket.key}.md`);
	const before = await Promise.all(read.tickets.map((ticket) => current(path(ticket))));
	const here = before.filter((was) => was !== null).length;
	const newCount = read.tickets.length - here;
	let useFolders = false;
	if (newCount > 0) {
		const SINGLE = "Import as single files";
		const FOLDERS = "Import as ticket folders";
		const said = `${read.tickets.length} ${read.tickets.length === 1 ? "ticket" : "tickets"} in ${typed}: ${newCount} new, ${here} already here. Existing tickets keep your notes; state, title, type, parent, source, and links update.`;
		const picked = await choose(said, [FOLDERS, SINGLE]);
		if (!picked) return;
		useFolders = picked === FOLDERS;
	} else {
		const go = "Update existing";
		const said = `${read.tickets.length} ${read.tickets.length === 1 ? "ticket" : "tickets"} in ${typed}: all ${here} already here. Your notes stay; state, title, type, parent, source, and links update.`;
		if ((await choose(said, [go])) !== go) return;
	}
	const destPath = (ticket: ImportedTicket) =>
		existingByKey.get(ticket.key.toLowerCase()) ??
		(useFolders ? joinPath(areaFolder("tickets"), ticket.key, `${ticket.key}.md`) : joinPath(areaFolder("tickets"), `${ticket.key}.md`));
	const counts = { made: 0, updated: 0, same: 0, skipped: read.skipped, pulls: read.pulls };
	try {
		for (const [at, ticket] of read.tickets.entries()) {
			const dest = destPath(ticket);
			const was = before[at] ?? (await current(dest));
			if (was === null) {
				await put(dest, ticketTemplate(ticket), false);
				counts.made++;
				continue;
			}
			// Only what the ticket system knows better: what a person wrote in the file stays.
			const { values } = frontMatter(was);
			const oldTitle = one(values.title);
			let now = was;
			for (const [k, value] of [
				["status", ticket.status],
				["title", ticket.title],
				["type", ticket.type],
				["parent", ticket.parent],
				["source", ticket.source],
			] as const) {
				if (!value || one(values[k]).toLowerCase() === value.toLowerCase()) continue;
				now = withFrontMatter(now, k, frontValue(value)) ?? now;
			}
			// Keep heading synced if it still matches `# KEY: Old Title` (function replacer prevents `$` corruption).
			if (oldTitle && ticket.title && oldTitle.toLowerCase() !== ticket.title.toLowerCase()) {
				const h1 = new RegExp(`^(#\\s+${ticket.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s+)${oldTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
				if (h1.test(now)) now = now.replace(h1, (_, prefix: string) => `${prefix}${ticket.title}`);
			}
			for (const relKey of ticket.related) now = addToFrontMatterList(now, "related", relKey) ?? now;
			for (const blk of ticket.blocks ?? []) now = addToFrontMatterList(now, "blocks", blk) ?? now;
			for (const by of ticket.blockedBy ?? []) now = addToFrontMatterList(now, "blocked-by", by) ?? now;
			if (now === was) counts.same++;
			else {
				await put(dest, now, true);
				counts.updated++;
			}
		}
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
	setState("treeVersion", (v) => v + 1);
	notify(importSummary(counts));
	if (counts.made === 1 && read.tickets.length === 1) await openFile(destPath(read.tickets[0]!));
}

/** A spec: what is to be built, written from a ticket. */
export async function newSpec() {
	if (!ready()) return;
	const title = (await ask("What the spec is for, in a few words"))?.trim();
	if (!title) return;
	if (!slug(title)) return notify("Give the spec a name with at least one letter or digit.", "error");
	const ticket = ticketKey((await ask("The ticket it is for (leave empty for none)", ticketAtHand())) ?? "");
	await start(joinPath(areaFolder("specs"), `${slug(title)}.md`), specTemplate({ title, ticket: ticket || undefined }), "specs");
}

/**
 * The code a new question or decision is about: what is selected in the
 * editor, when it is in a file that is not one of the project's documents.
 * Null when nothing is selected.
 */
function codeAtHand(): { path: string; from: number; to: number; text: string; language: string } | null {
	const path = activePath();
	const editor = activeEditor();
	const model = editor?.getModel();
	const selection = editor?.getSelection();
	if (!path || !editor || !model || !selection || selection.isEmpty()) return null;
	if (isMarkdown(path)) return null;
	const df = canonical(docsFolder());
	if (df !== canonical(root()) && isInside(df, path)) return null;
	// Whole lines: a selection that stops at a line's start does not take that line.
	const to = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
	const language = model.getLanguageId();
	return { path, from: selection.startLineNumber, to, text: model.getValueInRange({ startLineNumber: selection.startLineNumber, startColumn: 1, endLineNumber: to, endColumn: model.getLineMaxColumn(to) }), language: language === "plaintext" ? "" : language };
}

/** Something for the knowledge base: a decision, a question, a snippet or a reference note. */
export async function newKnowledge(kind: KnowledgeKind["id"], options?: { ticket?: string }) {
	if (!ready()) return;
	const what = KNOWLEDGE.find((k) => k.id === kind)!;
	const folder = joinPath(areaFolder("knowledge"), kind);
	// Read before anything is asked: a dialog takes the keyboard, and the selection with it.
	const code = kind === "questions" || kind === "decisions" || kind === "snippets" ? codeAtHand() : null;
	const aboutCode = code ? ` (about ${code.from === code.to ? `line ${code.from}` : `lines ${code.from} to ${code.to}`} of ${baseName(code.path)})` : "";
	const title = (await ask(kind === "questions" ? `The question, as you would ask it${aboutCode}` : kind === "snippets" ? `What the snippet is for, in a few words${aboutCode}` : kind === "prompts" ? "What the prompt is for, in a few words" : `The ${what.one}, in a few words${aboutCode}`))?.trim();
	if (!title) return;
	if (!slug(title)) return notify("Give the document a name with at least one letter or digit.", "error");
	if (kind === "snippets") {
		const guessed = code?.language === "sql" ? "SQL" : code?.language === "ssl" ? "SSL" : null;
		const language = guessed ?? (await choose("A snippet of what?", ["SQL", "SSL"]));
		if (!language) return;
		const lang = language === "SQL" ? "sql" : "ssl";
		const header = snippetTemplate({ title, language: lang });
		const body = code ? `${header.replace(/\n*$/, "\n\n")}${code.text}\n` : header;
		return start(joinPath(folder, `${slug(title)}.${lang}`), body, "knowledge");
	}
	if (kind === "reference") return start(joinPath(folder, `${slug(title)}.md`), referenceTemplate({ title }), "knowledge");
	if (kind === "prompts") return start(joinPath(folder, `${slug(title)}.md`), promptTemplate({ title }), "knowledge");
	const ticket = options?.ticket || ticketAtHand() || undefined;
	// Started with code selected, it is about that code: it says where, and keeps the lines as they were.
	const about = code ? codeSection({ file: relativeTo(root(), code.path).split("\\").join("/"), link: relativePath(folder, code.path), from: code.from, to: code.to, text: code.text, language: code.language, date: today() }) : "";
	if (kind === "questions") return start(joinPath(folder, `${slug(title)}.md`), questionTemplate({ title, date: today(), ticket }) + about, "knowledge");
	// Decisions are numbered, so that one can be named by its number and they list in the order they were made.
	const taken = (await backend.docs()).filter((d) => d.group === "knowledge" && d.kind === "decisions").map((d) => Number(/^(\d+)/.exec(baseName(d.name))?.[1] ?? 0));
	const number = String(Math.max(0, ...taken) + 1).padStart(4, "0");
	await start(joinPath(folder, `${number}-${slug(title)}.md`), decisionTemplate({ title, date: today(), ticket }) + about, "knowledge");
}

/** A folder's catalog as a notice names it: "docs/INDEX.md", or the file alone for a folder that is the project's own. */
const catalogSaid = (area: CatalogArea) => [areaSaid(area), CATALOG_FILE].filter(Boolean).join("/");

/**
 * Starts a catalog for the docs, code and tests folders, where the folder holds something and has none: the three
 * a project may do without, which "Update catalogs" keeps and does not start.
 */
export async function startFolderCatalogs() {
	if (!ready()) return;
	try {
		const started: string[] = [];
		const theirs: string[] = [];
		for (const area of OPTIONAL_CATALOGS) {
			if (!catalogued(area)) continue;
			// A file of the catalog's name that is there already, in whatever capitals: the app's own catalog, which
			// needs no starting, or a person's own document, which is left alone and has no second one made beside it.
			const there = await backend.list(areaFolder(area)).then(
				(entries) => entries.find((entry) => entry.kind === "file" && isCatalog(entry)),
				() => undefined,
			);
			if (there) {
				if (!hasCatalogPlace((await current(there.path)) ?? "")) theirs.push([areaSaid(area), there.name].filter(Boolean).join("/"));
				continue;
			}
			if (await writeCatalog(area, await backend.docs(), { start: true })) started.push(catalogSaid(area));
		}
		setState("treeVersion", (v) => v + 1);
		const own = theirs.length ? ` ${theirs.join(", ")} ${theirs.length === 1 ? "is a document of your own and is" : "are documents of your own and are"} left as ${theirs.length === 1 ? "it is" : "they are"}.` : "";
		notify(started.length ? `Started ${started.join(", ")}.${own}` : `Nothing to start: the docs, code and tests folders have their catalogs, or hold nothing to list.${own}`);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/**
 * Manual trigger for rewriting the schema catalog; kept as an explicit action only (ADR 0031).
 */
export async function schemaCatalogKept() {
	// Intentionally no-op for automatic creation flows; use Update catalogs to rewrite INDEX.md.
}

/**
 * A description of one table, one message or one file layout, in its kind's folder under the schema folder. A table
 * is called what it is called in the database; a message and a layout are named in a few words. It goes in the
 * kind's folder as the project has it, which may be written in other capitals ("Database"): no second folder is made
 * beside it.
 */
export async function newSchema(id: SchemaKind["id"], inFolder?: string): Promise<boolean> {
	if (!ready()) return false;
	const kind = SCHEMAS.find((known) => known.id === id)!;
	// Asked for with no folder named (the Schema heading, the New menu, the palette), it goes where the project
	// already keeps that kind, whatever capitals the folder is written in; only a project with none gets a new one.
	const kept = docs().find((file) => file.group === "schema" && file.kind === id)?.name.split(/[\\/]/)[0];
	const into = folderParts(inFolder ?? kept ?? id);
	// A folder inside the interfaces' is a system the project exchanges messages with: the message is with it.
	const system = id === "interfaces" ? into[1] : undefined;
	const title = (await ask(id === "database" ? "The table's name, as the database has it" : `The ${kind.one}${system ? ` with ${system}` : ""}, in a few words`))?.trim();
	if (!title) return false;
	// A file, so a table called BUILD is described: only a folder of that name is left out of the app's lists.
	const named = typedParts(id === "database" ? title : slug(title), "file");
	if ("problem" in named || named.parts.length !== 1) return notify("problem" in named ? named.problem : `“${title}” is not one name: a table is described in the ${kind.name.toLowerCase()} folder itself.`, "error"), false;
	const path = joinPath(root(), ...folderParts(state.project!.schema), ...into, `${named.parts[0]}.md`);
	// "Index" is what a folder's catalog is called: a description by that name would be taken for one.
	if (isCatalog({ name: `${named.parts[0]}.md` })) return notify(`“${title}” would be the file ${CATALOG_FILE}, which is a folder's catalog. Call the ${kind.one} something else.`, "error"), false;
	// One already there is opened, before anything more is asked about a new one.
	if ((await current(path)) !== null) return await start(path, "", "schema"), false;
	// Which way a message goes is part of what was agreed: asked, since a wrong guess would stand as if it were known.
	const way = id === "interfaces" ? await choose(`Which way does “${title}” go?`, Object.keys(WAYS), { details: WAYS }) : undefined;
	if (id === "interfaces" && !way) return false;
	await start(path, schemaTemplate(kind, title, { with: system, direction: way ? (way.toLowerCase() as "in" | "out" | "both") : undefined }), "schema");
	return (await current(path)) !== null;
}

/** Which way a message goes, as it is asked: the word that is written, and what it means. */
const WAYS: Record<string, string> = { In: "The project receives it", Out: "The project sends it", Both: "It goes each way" };

/** A row for each object the schema folder's SQL creates: object, kind, used by (empty), status, and where it was found. */
async function schemaRows(): Promise<string> {
	const rows: string[] = [];
	const seen = new Set<string>();
	try {
		for (const file of (await backend.docs()).filter((d) => d.group === "schema" && d.exists && /\.(sql|ddl|pks|pkb)$/i.test(d.name))) {
			const text = await current(file.path);
			if (text === null) continue;
			for (const made of extractSqlObjects(text)) {
				const key = made.name.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				rows.push(csvRow([made.name, made.kind, "", "found", `From ${relativeTo(root(), file.path).split("\\").join("/")}`]));
			}
		}
	} catch {
		// The registry starts empty: what the schema says is a convenience, not a condition.
	}
	return rows.length ? `${rows.join("\n")}\n` : "";
}

/** A registry: a table of what a migration must carry across, each row with how far it has come. */
export async function newRegistry() {
	if (!ready()) return;
	const other = "Another…";
	const picked = await choose("A registry of what?", [...REGISTRIES.map((r) => r.title), other], { details: { ...Object.fromEntries(REGISTRIES.map((r) => [r.title, r.about])), [other]: "A table of your own: you name its columns." } });
	if (!picked) return;
	const kind = REGISTRIES.find((r) => r.title === picked);
	if (kind?.id === "files") return updateManifest();
	// The database objects start from what the project's schema already says, where it is kept as SQL.
	if (kind?.id === "database") return start(joinPath(areaFolder("registries"), kind.file), `${csvRow(kind.columns)}\n${await schemaRows()}`, "registries");
	if (kind) return start(joinPath(areaFolder("registries"), kind.file), `${csvRow(kind.columns)}\n`, "registries");
	const name = (await ask("What the registry lists, in a word or two"))?.trim();
	if (!name || !slug(name)) return;
	const columns = (await ask("Its columns, separated by commas. A status column says how far each row has come.", "name, status, note"))?.split(",").map((c) => c.trim()).filter(Boolean);
	if (!columns?.length) return;
	await start(joinPath(areaFolder("registries"), `${slug(name).toLowerCase()}.csv`), `${csvRow(columns)}\n`, "registries");
}

/**
 * Sets a document's status: the one line of its front matter, through the
 * editor, so it can be undone. Folder catalogs are marked out of sync rather
 * than rewritten automatically (ADR 0031).
 */
export async function setStatus(path: string, status: string) {
	// Front matter is a Markdown document's: a query or a table kept in the same folder has none to set.
	if (!isMarkdown(path)) return notify("Only a Markdown document has a status to set.", "error");
	const before = await current(path);
	if (before === null) return;
	let after = withFrontMatter(before, "status", frontValue(status));
	if (after === null) return notify("The status could not be set here: it is written as a list. Change it in the text.", "error");
	// A question that is answered says when, once: the day is part of the answer.
	const question = docs().some((d) => d.group === "knowledge" && d.kind === "questions" && canonical(d.path) === canonical(path));
	if (question && toneOf(status) === "done" && !one(frontMatter(after).values.answered)) after = withFrontMatter(after, "answered", today()) ?? after;
	if (after === before) return;
	try {
		await put(path, after, true);
		setState("treeVersion", (v) => v + 1);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
		return;
	}

	// Decision Supersede flow: offer to create a linked superseding ADR and cross-link both frontmatters.
	const decisionDoc = docs().find((d) => d.group === "knowledge" && d.kind === "decisions" && canonical(d.path) === canonical(path));
	if (decisionDoc && status.toLowerCase() === "superseded" && ready()) {
		const CREATE = "Create superseding decision…";
		const picked = await choose("Link a new superseding decision to this ADR?", [CREATE, "Skip"], {
			details: {
				[CREATE]: "Creates the next numbered decision with supersedes: and adds superseded-by: here",
				Skip: "Keep status as superseded without creating a new file",
			},
		});
		if (picked === CREATE) {
			const nextTitle = (await ask(`Title for the decision that supersedes “${decisionDoc.title || baseName(path)}”`))?.trim();
			if (nextTitle && slug(nextTitle)) {
				const folder = joinPath(areaFolder("knowledge"), "decisions");
				const allDocs = await backend.docs();
				const taken = allDocs
					.filter((d) => d.group === "knowledge" && d.kind === "decisions")
					.map((d) => Number(/^(\d+)/.exec(baseName(d.name))?.[1] ?? 0));
				const number = String(Math.max(0, ...taken) + 1).padStart(4, "0");
				const newStem = `${number}-${slug(nextTitle)}`;
				const oldStem = baseName(path).replace(/\.(md|markdown)$/i, "");
				const ticket = decisionDoc.tickets?.[0] ?? ticketAtHand() ?? undefined;
				let newBody = decisionTemplate({ title: nextTitle, date: today(), ticket });
				newBody = withFrontMatter(newBody, "supersedes", frontValue(oldStem)) ?? newBody;
				const oldText = await current(path);
				if (oldText !== null) {
					const updatedOld = withFrontMatter(oldText, "superseded-by", frontValue(newStem));
					if (updatedOld && updatedOld !== oldText) await put(path, updatedOld, true);
				}
				await start(joinPath(folder, `${newStem}.md`), newBody, "knowledge");
			}
		}
	}
}

/**
 * Ticks or unticks the nth task of a document: the one character between its
 * brackets, through the editor. Its folder's catalog does not change: a
 * catalog says a document's state, not how far through its list it is.
 */
export async function tickTask(path: string, index: number) {
	const before = await current(path);
	const after = before === null ? null : toggleTask(before, index);
	if (after === null || after === before) return;
	try {
		await put(path, after, true);
		setState("treeVersion", (v) => v + 1);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/**
 * Points a document's links at where their files are now: each link's file
 * part, on its line, through the editor so it can be undone.
 */
export async function mendLinks(path: string, mends: readonly LinkMend[]) {
	const before = await current(path);
	if (before === null) return;
	const { text: after, done } = withLinkFiles(before, mends);
	// The listing may be older than the text: a link that is no longer where it was is left to the person.
	if (!done) return notify("The link is not where it was: the document has changed since. Mend it in the text.", "error");
	try {
		await put(path, after, true);
		setState("treeVersion", (v) => v + 1);
		notify(done === 1 && mends.length === 1 ? `The link now leads to ${mends[0]!.instead}.` : `${done} ${done === 1 ? "link now leads" : "links now lead"} to where ${done === 1 ? "its file is" : "their files are"}.`);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/**
 * After a file or a folder is renamed: the links that led to the old name
 * are found, and on the person's word pointed at the new one. Each is the
 * link's file part on its line, through the editor where the document is
 * open, so it can be undone there.
 */
/**
 * Drops links that sit inside a catalog's managed `<!-- catalog -->` block:
 * under ADR 0031 catalogs are reconciled explicitly via Update catalogs or the
 * Agent, never partially patched during rename/move prompts. Links written by a
 * person outside the catalog markers are still updated normally.
 */
async function withoutCatalogLists(links: LinkTo[]): Promise<LinkTo[]> {
	const lists = new Map<string, { from: number; to: number }>();
	for (const path of new Set(links.map((link) => link.path))) {
		if (!isCatalog({ name: path })) continue;
		try {
			const text = (await current(path)) ?? (await backend.read(path)).text;
			const at = catalogBlock(text);
			if (at) lists.set(path, { from: text.slice(0, at.start).split("\n").length, to: text.slice(0, at.end).split("\n").length });
		} catch {
			// Not there to read: nothing of it is asked about either way.
		}
	}
	return links.filter((link) => {
		const list = lists.get(link.path);
		return !list || link.line < list.from || link.line > list.to;
	});
}

async function followPaths(from: string, to: string) {
	if (!state.workspace) return;
	let links: LinkTo[];
	try {
		links = await backend.linksTo(from);
	} catch {
		return;
	}
	links = await withoutCatalogLists(links);
	// A document OR folder moved to another folder has outward relative links of its own to rewrite from where it is now.
	const fromCanon = canonical(from);
	const toCanon = canonical(to);
	const ownByFile = new Map<string, LinkEdit[]>();
	if (dirName(fromCanon) !== dirName(toCanon)) {
		if (isMarkdown(to)) {
			const moved = (await current(to)) ?? "";
			const own = moved ? ownLinkEdits(moved, fromCanon, toCanon) : [];
			if (own.length) ownByFile.set(to, own);
		} else {
			// Moved folder: rewrite ONLY outward relative links in every Markdown file inside the moved folder;
			// intra-folder links moved alongside the folder stay untouched.
			const wsFiles = await backend.files().catch(() => []);
			for (const filePath of wsFiles) {
				if (!isMarkdown(filePath) || !isInside(toCanon, canonical(filePath))) continue;
				const oldFile = fromCanon + canonical(filePath).slice(toCanon.length);
				const movedText = (await current(filePath)) ?? "";
				const own = movedText ? ownLinkEdits(movedText, oldFile, canonical(filePath), { from: fromCanon, to: toCanon }) : [];
				if (own.length) ownByFile.set(filePath, own);
			}
		}
	}

	const edits = new Map<string, LinkEdit[]>();
	const seenKey = new Set<string>();
	const addEdit = (filePath: string, edit: LinkEdit) => {
		const key = `${canonical(filePath)}:${edit.line}:${edit.column ?? ""}:${edit.href}`;
		if (seenKey.has(key)) return;
		seenKey.add(key);
		edits.set(filePath, [...(edits.get(filePath) ?? []), edit]);
	};

	let incomingCount = 0;
	for (const link of links) {
		const target = `${to}${link.rest}`;
		// What is written from the project's top stays written from the top; a path in front matter is written as it is.
		const fromTop = relativeTo(root(), target);
		const instead = link.from === "root" ? fromTop : link.from === "top" ? `/${fromTop}` : relativePath(dirName(link.path), target);
		addEdit(link.path, { line: link.line, column: link.column, href: link.href, instead, plain: link.from === "root" });
		incomingCount++;
	}
	let ownCount = 0;
	for (const [movedPath, own] of ownByFile) {
		for (const edit of own) {
			const before = seenKey.size;
			addEdit(movedPath, edit);
			if (seenKey.size > before) ownCount++;
		}
	}
	const total = incomingCount + ownCount;
	if (!total) return;

	const holders = [...new Set(links.map((link) => link.path))];
	const where = holders.length === 1 ? relativeTo(root(), holders[0]!) : `${holders.length} documents`;
	// A ticket's "specs:" line is counted with the links: it names the file as a link does.
	const said = [
		incomingCount ? `${incomingCount === 1 ? "One place" : `${incomingCount} places`} in ${where} still ${incomingCount === 1 ? "says" : "say"} the old name, ${baseName(from)}.` : "",
		ownCount ? `${ownCount === 1 ? "One link" : `${ownCount} links`} in ${baseName(to)} ${ownCount === 1 ? "is" : "are"} written from where it was.` : "",
	]
		.filter(Boolean)
		.join(" ");
	const go = total === 1 ? "Update it" : "Update them";
	if ((await choose(said, [go])) !== go) return;
	let done = 0;
	for (const [path, changes] of edits) {
		const before = await current(path);
		if (before === null) continue;
		const changed = withLinkFiles(before, changes);
		if (!changed.done) continue;
		try {
			await put(path, changed.text, true);
			done += changed.done;
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	}
	setState("treeVersion", (v) => v + 1);
	if (done) notify(`${done} ${done === 1 ? "place was" : "places were"} written anew for ${baseName(to)}.`);
	const left = total - done;
	if (left > 0) notify(`${left} of them ${left === 1 ? "is" : "are"} not where ${left === 1 ? "it was" : "they were"}: the document has changed since. Mend ${left === 1 ? "it" : "them"} in the text.`, "error");
}

/**
 * After a file or a folder is renamed: first the links by path that led to
 * the old name, then the links by name that no longer mean what they
 * meant. Each is asked about once, and written on the person's word.
 */
export async function followRename(from: string, to: string, beforeDocs?: DocFile[]) {
	// Prefer a caller-provided pre-rename snapshot so `followNames` never races an async `docs()` refresh.
	const listed = (beforeDocs ?? docs()).map((file) => ({ ...file, path: canonical(file.path) }));
	await followPaths(from, to);
	await followNames(from, to, listed);
}

/**
 * The links by name ([[name]]) a rename leaves behind: those that no longer
 * mean the document they meant, whether they named it by its file's name,
 * its path or what it called itself, and those whose name the renamed file
 * took. A name that still means its document is left alone. Only the name
 * is written anew, through the editor where the document is open. `listed`
 * is the project's documents as they were in hand when the rename was made.
 */
async function followNames(from: string, to: string, listed: DocFile[]) {
	if (!state.workspace) return;
	const was = canonical(from);
	const is = canonical(to);
	const under = (path: string, base: string) => path === base || (isInside(base, path) && path.length > base.length);
	const moved = (path: string) => (under(path, was) ? is + path.slice(was.length) : path);
	// The documents as they are now are asked for: what a document is called, and whether it is still one of the
	// project's, can change with where it is. As they were is the list that was in hand, where that is of before
	// the rename; where it was already of after, it is the new one with the moved paths put back, which knows the
	// documents only by what they are called now.
	let after: DocFile[];
	try {
		after = (await backend.docs()).map((file) => ({ ...file, path: canonical(file.path) }));
	} catch {
		return;
	}
	const before = listed.some((file) => under(file.path, was)) ? listed : after.map((file) => (under(file.path, is) ? { ...file, path: was + file.path.slice(is.length) } : file));
	if (!before.some((file) => under(file.path, was))) return;
	let places: NameIn[];
	try {
		places = (await backend.namesIn()).map((place) => ({ ...place, path: canonical(place.path) }));
	} catch {
		return;
	}
	const follow = namesToFollow(places, before, after, moved, root());
	if (!follow.length) return;
	const holders = [...new Set(follow.map((place) => place.path))];
	const where = holders.length === 1 ? relativeTo(root(), holders[0]!) : `${holders.length} documents`;
	const said = `${follow.length === 1 ? "One link by name" : `${follow.length} links by name`} in ${where} no longer ${follow.length === 1 ? "means what it" : "mean what they"} meant, now that ${baseName(from)} is ${baseName(from) === baseName(to) ? `in ${relativeTo(root(), dirName(to)) || "the project's folder"}` : baseName(to)}.`;
	const go = follow.length === 1 ? "Update it" : "Update them";
	if ((await choose(said, [go])) !== go) return;
	let done = 0;
	for (const path of holders) {
		const text = await current(path);
		if (text === null) continue;
		const changed = withNames(
			text,
			follow.filter((place) => place.path === path),
		);
		if (!changed.done) continue;
		try {
			await put(path, changed.text, true);
			done += changed.done;
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	}
	setState("treeVersion", (v) => v + 1);
	if (done) notify(`${done} ${done === 1 ? "link by name was" : "links by name were"} written anew for ${baseName(to)}.`);
	const left = follow.length - done;
	if (left > 0) notify(`${left} of them ${left === 1 ? "is" : "are"} not where ${left === 1 ? "it was" : "they were"}: the document has changed since. Mend ${left === 1 ? "it" : "them"} in the text.`, "error");
}

/** Where the project stands, in plain words. */
export async function newState() {
	if (!ready()) return;
	await start(joinPath(docsFolder(), STATE_FILE), stateTemplate(state.project!.name, today()));
}

/** Writes every catalog afresh from the documents in its folder. */
export async function updateCatalogs() {
	if (!ready()) return;
	try {
		const files = await backend.docs();
		const changed: string[] = [];
		for (const area of CATALOG_AREAS) {
			// The docs folder's names the catalogs under it, which this pass may have just started: listed afresh for it.
			if (await writeCatalog(area, area === "docs" ? await backend.docs() : files, { alone: true })) changed.push(catalogSaid(area));
		}
		setState("treeVersion", (v) => v + 1);
		notify(changed.length ? `Updated ${changed.join(", ")}.` : "Every catalog already says what its folder holds.");
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/** Computes compact added/removed diff lines between an existing catalog block and a fresh one. */
export function diffCatalogLines(existingText: string, expectedItems: readonly CatalogItem[]): { added: string[]; removed: string[] } {
	const extractBullets = (block: string) =>
		block
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.startsWith("- "));
	const currentBlock = catalogBlock(existingText)?.inner ?? "";
	const currentSet = new Set(extractBullets(currentBlock));
	const expectedList = extractBullets(catalogList(expectedItems));
	const expectedSet = new Set(expectedList);
	const added = expectedList.filter((line) => !currentSet.has(line));
	const removed = [...currentSet].filter((line) => !expectedSet.has(line));
	return { added, removed };
}

/** Builds a concise summary prompt for Agent-assisted catalog reconciliation (ADR 0031), including missing catalogs. */
export function staleCatalogSummary(): { stale: DocFile[]; missing: string[]; prompt: string } {
	const all = docs();
	const areas = CATALOG_AREAS.filter((area) => area !== "schema" || folderParts(state.project?.schema ?? "schema").length > 0);
	const stale = all.filter((d) => d.exists && d.catalog?.stale);
	const missingChecks = docChecks(all, areas).filter((c) => c.fix?.kind === "catalogs" && c.text.includes("no catalog"));
	const missing = missingChecks.map((c) => c.text);
	const rel = (p: string) => relativeTo(root(), p).split("\\").join("/");
	const lines = [
		...stale.map((d) => `- ${rel(d.path)} (${d.catalog?.area ?? d.group} — out of sync)`),
		...missing.map((text) => `- ${text}`),
	];
	const prompt = lines.length
		? [
				"The following INDEX.md catalogs are out of sync or missing:",
				...lines,
				"",
				"Please review what changed in these areas and tell me whether anything looks missing, misclassified, or needs follow-up before I run Update catalogs.",
			].join("\n")
		: "";
	return { stale, missing, prompt };
}

/** Async diff-backed reconciliation summary for the Agent: embeds exact added/removed catalog entries per folder. */
export async function staleCatalogSummaryAsync(): Promise<{ stale: DocFile[]; missing: string[]; prompt: string }> {
	const base = staleCatalogSummary();
	if (!base.stale.length && !base.missing.length) return base;
	if (!ready()) return base;
	const all = docs();
	const folders = catalogFolders();
	const rel = (p: string) => relativeTo(root(), p).split("\\").join("/");
	const sections: string[] = [];

	for (const cat of base.stale) {
		const area = (cat.catalog?.area ?? cat.group) as (typeof CATALOG_AREAS)[number];
		const existing = (await current(cat.path)) ?? "";
		let expected: CatalogItem[] = [];
		if (area === "code" || area === "tests") {
			const paths = await backend.catalogFiles(area).catch(() => null);
			if (paths) expected = fileItems(paths);
		} else {
			expected = catalogItems(area, all, folders);
		}
		const { added, removed } = diffCatalogLines(existing, expected);
		const diffLines = [
			...added.slice(0, 15).map((l) => `  + ${l}`),
			...(added.length > 15 ? [`  + … and ${added.length - 15} more added`] : []),
			...removed.slice(0, 15).map((l) => `  - ${l}`),
			...(removed.length > 15 ? [`  - … and ${removed.length - 15} more removed`] : []),
		];
		sections.push(
			`### ${rel(cat.path)} (${area})`,
			...(diffLines.length ? diffLines : ["  (ordering or formatting changed)"]),
		);
	}
	for (const m of base.missing) {
		sections.push(`### Missing catalog`, `  - ${m}`);
	}

	const prompt = [
		"The following INDEX.md catalogs are out of sync or missing (exact computed diff):",
		"",
		...sections,
		"",
		"Please review these additions/removals and tell me if anything looks misnamed, orphaned, or missing metadata before I run Update catalogs.",
	].join("\n");
	return { ...base, prompt };
}

/** Writes the file manifest afresh from the folder: what is new, what has changed, what has gone. A person's status and notes are kept. */
export async function updateManifest() {
	if (!ready()) return;
	const path = joinPath(areaFolder("registries"), REGISTRIES.find((r) => r.id === "files")!.file);
	try {
		const own = relativeTo(root(), path).split("\\").join("/");
		const files = (await backend.manifest()).filter((file) => file.path !== own);
		const before = await current(path);
		const change = mergeManifest(before, files);
		if (before !== change.text) await put(path, change.text, before !== null);
		setState("treeVersion", (v) => v + 1);
		notify(manifestSummary(change));
		await openFile(path);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/**
 * Lets the user link an existing spec, plan, ticket, decision, or question directly from a ticket file,
 * writing the exact standard YAML frontmatter field so the association shows up in both the ticket and Work list.
 */
export async function linkDocumentToTicket(ticketPath: string, key: string): Promise<void> {
	if (!ready()) return;
	const all = docs();
	const linkedPaths = new Set(
		ticketWork(all, key).flatMap((group) => group.files.map((f) => canonical(f.path))),
	);
	linkedPaths.add(canonical(ticketPath));

	const rel = (p: string) => relativeTo(root(), p).split("\\").join("/");
	const candidates = all.filter((f) => {
		if (!f.exists || isCatalog(f)) return false;
		if (linkedPaths.has(canonical(f.path))) return false;
		if (f.group === "specs" || f.group === "plans") return true;
		if (f.group === "tickets" && f.ticket) return true;
		if (f.group === "knowledge" && /\.(md|markdown)$/i.test(f.name) && (f.kind === "decisions" || f.kind === "questions" || f.kind === "reference")) return true;
		if (f.group === "schema" && /\.(md|markdown)$/i.test(f.name)) return true;
		return false;
	});

	if (!candidates.length) {
		notify(`Every spec, plan, ticket, knowledge note, and schema doc in this project is already linked to ${key}.`);
		return;
	}

	const kindTag = (f: DocFile) =>
		f.group === "plans"
			? "Plan"
			: f.group === "specs"
				? "Spec"
				: f.group === "tickets"
					? "Ticket"
					: f.group === "schema"
						? "Schema"
						: f.kind === "decisions"
							? "Decision"
							: f.kind === "reference"
								? "Reference"
								: "Question";

	const labels: string[] = [];
	const details: Record<string, string> = {};
	const byLabel = new Map<string, DocFile>();

	for (const f of candidates) {
		const title =
			f.group === "plans"
				? f.name.replace(/\.plan\.json$/i, "")
				: f.group === "tickets" && f.ticket
					? `${f.ticket}: ${f.title || f.name}`
					: f.title || f.name;
		const label = `${kindTag(f)}: ${title}`;
		const relPath = rel(f.path);
		const actionDetail =
			f.group === "specs"
				? `Adds ${relPath} to specs: in ${baseName(ticketPath)}`
				: f.group === "plans"
					? `Adds ${relPath} to plans: in ${baseName(ticketPath)}`
					: f.group === "tickets"
						? `Link ${f.ticket} as related, sub-ticket, blocks, or blocked-by`
						: `Adds ${key} to ticket: in ${relPath}'s frontmatter`;
		labels.push(label);
		details[label] = actionDetail;
		byLabel.set(label, f);
	}

	const picked = await choose(`Link an existing document to ${key}`, labels, { details });
	if (!picked) return;
	const target = byLabel.get(picked);
	if (!target) return;

	try {
		if (target.group === "tickets") {
			const otherKey = target.ticket ?? target.name;
			const REL = "Related to";
			const SUB = `Sub-ticket of ${key}`;
			const BLOCKS = `${key} blocks ${otherKey}`;
			const BLOCKED = `${key} is blocked by ${otherKey}`;
			const relation = await choose(`How does ${otherKey} relate to ${key}?`, [REL, SUB, BLOCKS, BLOCKED]);
			if (!relation) return;
			if (relation === SUB) {
				const before = await current(target.path);
				if (before === null) return;
				const next = withFrontMatter(before, "parent", key);
				if (next && next !== before) await put(target.path, next, true);
				setState("treeVersion", (v) => v + 1);
				notify(`Set parent: ${key} on ${otherKey}.`);
				return;
			}
			const field = relation === BLOCKS ? "blocks" : relation === BLOCKED ? "blocked-by" : "related";
			const before = await current(ticketPath);
			if (before === null) return;
			const next = addToFrontMatterList(before, field, otherKey);
			if (next && next !== before) await put(ticketPath, next, true);
			setState("treeVersion", (v) => v + 1);
			notify(`Linked ${otherKey} under ${field}: in ${baseName(ticketPath)}.`);
			return;
		}
		if (target.group === "specs" || target.group === "plans") {
			const before = await current(ticketPath);
			if (before === null) return;
			const field = target.group === "specs" ? "specs" : "plans";
			const entry = rel(target.path);
			const next = addToFrontMatterList(before, field, entry);
			if (next === null) {
				notify(`Could not update ${field}: automatically in ${baseName(ticketPath)} — add ${entry} directly in YAML.`, "error");
				return;
			}
			if (next !== before) await put(ticketPath, next, true);
			setState("treeVersion", (v) => v + 1);
			notify(`Linked ${baseName(target.path)} — added to ${field}: in ${baseName(ticketPath)}.`);
			return;
		}

		// Knowledge / schema doc: write ticket: or promote single ticket: into tickets: cleanly without duplicating keys.
		const before = await current(target.path);
		if (before === null) return;
		const fm = frontMatter(before);
		const existingSingle = many(fm.values.ticket);
		const existingMulti = many(fm.values.tickets);
		let next: string | null = before;
		if (existingMulti.length) {
			next = addToFrontMatterList(before, "tickets", key);
		} else if (existingSingle.length) {
			const merged = [...new Set([...existingSingle, key])];
			let cleared = before;
			for (const prev of existingSingle) cleared = removeFromFrontMatterList(cleared, "ticket", prev) ?? cleared;
			next = cleared;
			for (const t of merged) next = addToFrontMatterList(next, "tickets", t) ?? next;
		} else {
			next = withFrontMatter(before, "ticket", key);
		}
		if (next === null) {
			notify(`Could not update ticket: automatically in ${baseName(target.path)} — add ticket: ${key} directly in its frontmatter.`, "error");
			return;
		}
		if (next !== before) await put(target.path, next, true);
		setState("treeVersion", (v) => v + 1);
		notify(`Linked ${baseName(target.path)} to ${key}.`);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/** Removes the YAML/JSON association between `ticketPath` (`key`) and `target`. */
export async function unlinkDocumentFromTicket(ticketPath: string, key: string, target: DocFile): Promise<void> {
	if (!ready()) return;
	const relTarget = relativeTo(root(), target.path).split("\\").join("/");
	try {
		let changed = false;
		// 1. Remove from ticket's own specs/plans/related/blocks/blocked-by/parent frontmatter.
		const tBefore = await current(ticketPath);
		if (tBefore !== null) {
			let tNext = tBefore;
			const normRef = (v: string) => v.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
			const removePathField = (src: string, field: string) => {
				const vals = many(frontMatter(src).values[field]);
				let cur = src;
				for (const v of vals) {
					if (normRef(v) === normRef(relTarget)) cur = removeFromFrontMatterList(cur, field, v) ?? cur;
				}
				return cur;
			};
			if (target.group === "specs") {
				tNext = removePathField(removePathField(tNext, "specs"), "spec");
			} else if (target.group === "plans") {
				tNext = removePathField(removePathField(tNext, "plans"), "plan");
			} else if (target.group === "tickets" && target.ticket) {
				for (const field of ["related", "blocks", "blocked-by", "parent"]) {
					tNext = removeFromFrontMatterList(tNext, field, target.ticket) ?? tNext;
				}
			}
			if (tNext !== tBefore) {
				await put(ticketPath, tNext, true);
				changed = true;
			}
		}
		// 2. Remove from target document's frontmatter (or plan JSON "ticket" field).
		const dBefore = await current(target.path);
		if (dBefore !== null) {
			if (target.group === "plans" && isPlanPath(target.path)) {
				try {
					const parsed = JSON.parse(dBefore);
					if (typeof parsed?.ticket === "string" && parsed.ticket.toLowerCase() === key.toLowerCase()) {
						delete parsed.ticket;
						await put(target.path, `${JSON.stringify(parsed, null, 2)}\n`, true);
						changed = true;
					}
				} catch {
					// Invalid JSON plan left untouched.
				}
			} else if (isMarkdown(target.path)) {
				let dNext = dBefore;
				for (const field of target.group === "tickets" ? ["parent", "related", "blocks", "blocked-by"] : ["ticket", "tickets"]) {
					dNext = removeFromFrontMatterList(dNext, field, key) ?? dNext;
				}
				if (dNext !== dBefore) {
					await put(target.path, dNext, true);
					changed = true;
				}
			}
		}
		if (changed) {
			setState("treeVersion", (v) => v + 1);
			notify(`Unlinked ${target.ticket ?? target.title ?? baseName(target.path)} from ${key}.`);
		} else {
			notify(`That link is inferred (e.g. via a paired plan or ticket folder) and cannot be unlinked from YAML.`);
		}
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/** Links an unlinked spec, decision, question, reference note, or schema doc to a chosen ticket. */
export async function linkNonTicketToTicket(docPath: string): Promise<void> {
	if (!ready()) return;
	const before = await current(docPath);
	if (before === null) return;
	const fm = frontMatter(before);
	const existingSingle = many(fm.values.ticket);
	const existingMulti = many(fm.values.tickets);
	const already = new Set([...existingSingle, ...existingMulti].map((k) => k.toLowerCase()));
	const tickets = docs().filter((d) => d.exists && d.group === "tickets" && d.ticket && !isCatalog(d) && !already.has(d.ticket.toLowerCase()));
	if (!tickets.length) return notify(already.size ? "This document is already linked to every ticket in the project." : "No tickets exist in this project yet.");
	const labels = tickets.map((t) => `${t.ticket}: ${t.title || t.name}`);
	const byLabel = new Map(tickets.map((t, i) => [labels[i]!, t]));
	const picked = await choose(`Link ${baseName(docPath)} to a ticket`, labels);
	if (!picked) return;
	const ticket = byLabel.get(picked);
	if (!ticket?.ticket) return;
	let next: string | null = before;
	if (existingMulti.length) next = addToFrontMatterList(before, "tickets", ticket.ticket);
	else if (existingSingle.length) {
		const merged = [...new Set([...existingSingle, ticket.ticket])];
		let cleared = before;
		for (const prev of existingSingle) cleared = removeFromFrontMatterList(cleared, "ticket", prev) ?? cleared;
		next = cleared;
		for (const t of merged) next = addToFrontMatterList(next, "tickets", t) ?? next;
	} else next = withFrontMatter(before, "ticket", ticket.ticket);
	if (next && next !== before) {
		await put(docPath, next, true);
		setState("treeVersion", (v) => v + 1);
		notify(`Linked ${baseName(docPath)} to ${ticket.ticket}.`);
	}
}

/** Appends a new row to a chosen CSV registry pre-filled with `key` in its Ticket column. */
export async function addRegistryRowForTicket(key: string): Promise<void> {
	if (!ready()) return;
	const regs = docs().filter((d) => d.exists && d.group === "registries" && !isCatalog(d) && /\.(csv|tsv)$/i.test(d.name));
	if (!regs.length) return notify("No CSV registries exist yet. Create one from Docs -> New -> New registry….");
	const labels = regs.map((r) => r.name);
	const byLabel = new Map(regs.map((r, i) => [labels[i]!, r]));
	const picked = regs.length === 1 ? labels[0]! : await choose(`Add a row for ${key} to which registry?`, labels);
	if (!picked) return;
	const reg = byLabel.get(picked);
	if (!reg) return;
	const text = await current(reg.path);
	if (text === null) return;
	const table = parseCsv(text);
	if (!table.header.length) return notify(`${reg.name} has no header row.`, "error");
	const firstCol = table.header[0]!.text.trim() || "item";
	const name = (await ask(`New ${firstCol} for ${key} in ${reg.name}`))?.trim();
	if (!name) return;
	const row = table.header.map((h, idx) => {
		const col = h.text.trim().toLowerCase();
		if (idx === 0) return name;
		if (col === "ticket" || col === "tickets") return key;
		if (col === "status") return "found";
		return "";
	});
	const nl = text.includes("\r\n") ? "\r\n" : "\n";
	const prefix = text && !/\r?\n$/.test(text) ? nl : "";
	await put(reg.path, `${text}${prefix}${csvRow(row, table.delimiter)}${nl}`, true);
	setState("treeVersion", (v) => v + 1);
	notify(`Added “${name}” to ${reg.name} for ${key}.`);
	await openFile(reg.path);
}

/** Saves any dirty open editor buffers matching `target` (or inside `target` when it is a folder) before a filesystem move. */
async function saveDirtyUnder(targets: readonly string[]) {
	for (const [docPath] of documents) {
		if (!state.dirty[docPath]) continue;
		if (targets.some((t) => canonical(t) === docPath || isInside(canonical(t), docPath))) {
			await save(docPath);
		}
	}
}

/** Replaces `oldKey` with `newKey` ONLY inside the Ticket column of a CSV/TSV registry (preserving URLs, paths, and notes). */
function replaceTicketKeyInCsv(text: string, oldKey: string, newKey: string): string {
	const parsed = parseCsv(text);
	const col = ticketColumn(parsed);
	if (col < 0) return text;
	const re = new RegExp(`(?<![A-Za-z0-9_-])${oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "gi");
	const edits: { start: number; end: number; replacement: string }[] = [];
	for (const row of parsed.rows) {
		const cell = row[col];
		if (!cell) continue;
		const nextVal = cell.text.replace(re, newKey);
		if (nextVal !== cell.text) edits.push({ start: cell.start, end: cell.end, replacement: csvCell(nextVal, parsed.delimiter) });
	}
	if (!edits.length) return text;
	let out = text;
	for (let i = edits.length - 1; i >= 0; i--) {
		const ed = edits[i]!;
		out = `${out.slice(0, ed.start)}${ed.replacement}${out.slice(ed.end)}`;
	}
	return out;
}

/** Bundle-aware ticket trash: handles Layout 1 (`KEY/KEY.md`), Layout 2 (`KEY.md` + sibling `KEY/`), and incoming link checks. */
export async function trashTicket(file: DocFile): Promise<void> {
	if (!ready()) return;
	const isLayout1 = Boolean(file.ticketFolder && isInside(file.ticketFolder, file.path));
	const isLayout2 = Boolean(file.ticketFolder && !isLayout1);
	if (!file.ticketFolder) {
		await (await import("./panels/Explorer")).trashFile(file.path);
		return;
	}
	const folder = file.ticketFolder;
	const relFolder = relativeTo(root(), folder).split("\\").join("/");
	const count = file.ticketFileCount ?? file.ticketFiles?.length ?? 0;
	const incoming = await backend.linksTo(file.path).catch(() => []);
	const outsideRefs = new Set(
		incoming
			.filter((l) => !isCatalog({ name: l.path }) && canonical(l.path) !== canonical(file.path) && !isInside(canonical(folder), canonical(l.path)))
			.map((l) => l.path),
	);
	const refNote = outsideRefs.size ? ` ${outsideRefs.size} other ${outsideRefs.size === 1 ? "document links" : "documents link"} to it.` : "";
	const TRASH_ALL = isLayout1 ? `Trash folder (${relFolder}/)` : `Trash ticket & folder (${relFolder}/)`;
	const TRASH_DOC = `Trash only ${baseName(file.path)}`;
	const picked = await choose(
		`${file.ticket ?? baseName(file.path)} has a ticket folder with ${count} extra ${count === 1 ? "file" : "files"}.${refNote} What should be moved to the trash?`,
		[TRASH_ALL, TRASH_DOC],
		{ danger: TRASH_ALL },
	);
	if (!picked) return;
	const { retargetScopedFolder } = await import("./panels/Explorer");
	try {
		if (picked === TRASH_ALL) {
			if (isLayout2) {
				await backend.trash(file.path);
				fileRemoved(file.path);
			}
			await backend.trash(folder);
			fileRemoved(folder);
			retargetScopedFolder(folder, null);
			setState("treeVersion", (v) => v + 1);
			notify(`Moved ${isLayout2 ? `${baseName(file.path)} and ` : ""}${relFolder}/ to the trash.`);
		} else {
			await backend.trash(file.path);
			fileRemoved(file.path);
			setState("treeVersion", (v) => v + 1);
			notify(`Moved ${relativeTo(root(), file.path)} to the trash.`);
		}
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/** Bundle-aware ticket key rename (`TEMP-1` -> `LIMS-456`): handles Layout 1, Layout 2, and flat tickets; updates wikilinks, paths, plans, and CSV ticket cells. */
export async function renameTicket(file: DocFile): Promise<void> {
	if (!ready()) return;
	const oldKey = file.ticket;
	if (!oldKey) {
		await (await import("./panels/Explorer")).renameFile(file.path);
		return;
	}
	const typed = (await ask(`Rename ticket key ${oldKey} to`, oldKey))?.trim();
	const newKey = ticketKey(typed ?? "");
	if (!newKey || newKey === oldKey) return;

	const beforeDocs = await backend.docs();
	const duplicate = beforeDocs.find(
		(d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === newKey.toLowerCase() && canonical(d.path) !== canonical(file.path),
	);
	if (duplicate) {
		notify(`Ticket ${newKey} already exists at ${relativeTo(root(), duplicate.path)}.`, "error");
		return;
	}

	const extMatch = /\.(md|markdown)$/i.exec(baseName(file.path));
	const ext = extMatch ? extMatch[0] : ".md";
	const isLayout1 = Boolean(file.ticketFolder && isInside(file.ticketFolder, file.path));
	const isLayout2 = Boolean(file.ticketFolder && !isLayout1);
	const oldFolder = file.ticketFolder;
	const newFolder = oldFolder ? joinPath(dirName(oldFolder), newKey) : undefined;
	const { retargetScopedFolder } = await import("./panels/Explorer");

	await saveDirtyUnder(oldFolder ? [file.path, oldFolder] : [file.path]);

	let toPath = file.path;
	let folderMoved = false;
	try {
		if (isLayout1 && oldFolder && newFolder) {
			if (canonical(oldFolder) !== canonical(newFolder)) {
				await backend.rename(oldFolder, newFolder);
				folderMoved = true;
				fileRenamed(oldFolder, newFolder);
			}
			const movedDoc = joinPath(newFolder, baseName(file.path));
			const oldStem = baseName(file.path).replace(/\.(md|markdown)$/i, "");
			if (oldStem.toLowerCase() === oldKey.toLowerCase() && canonical(movedDoc) !== canonical(joinPath(newFolder, `${newKey}${ext}`))) {
				const renamedDoc = joinPath(newFolder, `${newKey}${ext}`);
				try {
					await backend.rename(movedDoc, renamedDoc);
					fileRenamed(movedDoc, renamedDoc);
					toPath = renamedDoc;
				} catch (err) {
					if (folderMoved) {
						await backend.rename(newFolder, oldFolder).catch(() => {});
						fileRenamed(newFolder, oldFolder);
					}
					throw err;
				}
			} else {
				toPath = movedDoc;
			}
			retargetScopedFolder(oldFolder, newFolder, `${newKey} files`);
		} else if (isLayout2 && oldFolder && newFolder) {
			const renamedDoc = joinPath(dirName(file.path), `${newKey}${ext}`);
			if (canonical(file.path) !== canonical(renamedDoc)) {
				await backend.rename(file.path, renamedDoc);
				fileRenamed(file.path, renamedDoc);
			}
			toPath = renamedDoc;
			if (canonical(oldFolder) !== canonical(newFolder)) {
				try {
					await backend.rename(oldFolder, newFolder);
					folderMoved = true;
					fileRenamed(oldFolder, newFolder);
					retargetScopedFolder(oldFolder, newFolder, `${newKey} files`);
				} catch (err) {
					if (canonical(file.path) !== canonical(renamedDoc)) {
						await backend.rename(renamedDoc, file.path).catch(() => {});
						fileRenamed(renamedDoc, file.path);
					}
					throw err;
				}
			}
		} else {
			toPath = joinPath(dirName(file.path), `${newKey}${ext}`);
			if (canonical(file.path) !== canonical(toPath)) {
				await backend.rename(file.path, toPath);
				fileRenamed(file.path, toPath);
			}
		}

		// Update `ticket:` frontmatter + body-only H1 BEFORE `followRename` so `followNames` detects `[[OLD]]` -> `[[NEW]]`.
		const selfText = await current(toPath);
		if (selfText !== null) {
			let updated = withFrontMatter(selfText, "ticket", newKey) ?? selfText;
			const cut = bodyOffset(updated);
			const head = updated.slice(0, cut);
			const bodyText = updated.slice(cut);
			const h1Re = new RegExp(`^(#\\s+)${oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[:\\s]|$)`, "im");
			updated = head + bodyText.replace(h1Re, (_, prefix: string) => `${prefix}${newKey}`);
			if (updated !== selfText) await put(toPath, updated, true);
		}

		// Follow incoming file path links & [[wikilinks]] cleanly (doc path first so OLD/OLD.md -> NEW/NEW.md, then companion folder links).
		await followRename(file.path, toPath, beforeDocs);
		if (oldFolder && newFolder && canonical(oldFolder) !== canonical(newFolder)) {
			await followPaths(oldFolder, newFolder);
		}

		// Refactor ticket key references in other Markdown docs, plans, and CSV registries (Ticket column only!).
		let refactored = 0;
		for (const doc of beforeDocs) {
			if (!doc.exists || canonical(doc.path) === canonical(file.path) || isCatalog(doc)) continue;
			const docPath =
				oldFolder && newFolder && isInside(canonical(oldFolder), canonical(doc.path))
					? joinPath(newFolder, relativeTo(oldFolder, doc.path))
					: doc.path;
			const text = await current(docPath);
			if (text === null) continue;
			if (doc.group === "plans" && isPlanPath(docPath)) {
				try {
					const parsed = JSON.parse(text);
					if (typeof parsed?.ticket === "string" && parsed.ticket.toLowerCase() === oldKey.toLowerCase()) {
						parsed.ticket = newKey;
						await put(docPath, `${JSON.stringify(parsed, null, 2)}\n`, true);
						refactored++;
					}
				} catch {}
			} else if (doc.group === "registries" && /\.(csv|tsv)$/i.test(doc.name)) {
				const next = replaceTicketKeyInCsv(text, oldKey, newKey);
				if (next !== text) {
					await put(docPath, next, true);
					refactored++;
				}
			} else if (isMarkdown(docPath)) {
				let next = text;
				for (const field of ["ticket", "tickets", "parent", "related", "blocks", "blocked-by"]) {
					next = replaceInFrontMatterList(next, field, oldKey, newKey) ?? next;
				}
				if (next !== text) {
					await put(docPath, next, true);
					refactored++;
				}
			}
		}
		setState("treeVersion", (v) => v + 1);
		notify(`Renamed ${oldKey} to ${newKey}${refactored ? ` and updated ${refactored} referencing ${refactored === 1 ? "file" : "files"}` : ""}.`);
	} catch (e: any) {
		setState("treeVersion", (v) => v + 1);
		notify(String(e?.message ?? e), "error");
	}
}

/** Moves a flat ticket, Layout 1 bundle, or Layout 2 ticket + sibling folder cleanly into `<tickets>/archive/`. */
export async function archiveTicket(file: DocFile): Promise<void> {
	if (!ready()) return;
	const ticketsRoot = areaFolder("tickets");
	const archiveDir = joinPath(ticketsRoot, "archive");
	const relArchive = relativeTo(root(), archiveDir).split("\\").join("/");
	if (isInside(archiveDir, file.path)) return notify(`${file.ticket ?? baseName(file.path)} is already archived.`);

	const isLayout1 = Boolean(file.ticketFolder && isInside(file.ticketFolder, file.path));
	const isLayout2 = Boolean(file.ticketFolder && !isLayout1);
	const fromPrimary = isLayout1 ? file.ticketFolder! : file.path;
	const toPrimary = joinPath(archiveDir, baseName(fromPrimary));
	const fromSibling = isLayout2 ? file.ticketFolder! : null;
	const toSibling = fromSibling ? joinPath(archiveDir, baseName(fromSibling)) : null;

	// Check destination collisions BEFORE mutating ticket status!
	const archiveEntries = await backend.list(archiveDir).catch(() => []);
	const existingNames = new Set(archiveEntries.map((e) => e.name.toLowerCase()));
	if (existingNames.has(baseName(toPrimary).toLowerCase()) || (toSibling && existingNames.has(baseName(toSibling).toLowerCase()))) {
		notify(`Cannot archive: ${baseName(toPrimary)} already exists in ${relArchive}/.`, "error");
		return;
	}

	const markDone = toneOf(file.status) !== "done";
	const ARCHIVE_DONE = "Archive & mark done";
	const ARCHIVE_KEEP = "Archive (keep status)";
	const picked = await choose(
		`Move ${file.ticket ?? baseName(fromPrimary)} into ${relArchive}/?`,
		markDone ? [ARCHIVE_DONE, ARCHIVE_KEEP] : ["Archive"],
	);
	if (!picked) return;
	const beforeDocs = await backend.docs();
	const { retargetScopedFolder } = await import("./panels/Explorer");
	try {
		if (picked === ARCHIVE_DONE) await setStatus(file.path, "done");
		await saveDirtyUnder(fromSibling ? [fromPrimary, fromSibling] : [fromPrimary]);
		await backend.rename(fromPrimary, toPrimary);
		fileRenamed(fromPrimary, toPrimary);
		if (fromSibling && toSibling) {
			await backend.rename(fromSibling, toSibling);
			fileRenamed(fromSibling, toSibling);
			retargetScopedFolder(fromSibling, toSibling);
		} else if (isLayout1) {
			retargetScopedFolder(fromPrimary, toPrimary);
		}
		setState("treeVersion", (v) => v + 1);
		await followRename(fromPrimary, toPrimary, beforeDocs);
		if (fromSibling && toSibling) await followPaths(fromSibling, toSibling);
		notify(`Archived ${file.ticket ?? baseName(fromPrimary)} to ${relArchive}/.`);
	} catch (e: any) {
		setState("treeVersion", (v) => v + 1);
		notify(String(e?.message ?? e), "error");
	}
}

/**
 * Promotes an answered question (or any Markdown text from Agent / Plan Assistant) into a
 * properly structured knowledge base document (Decision, Question, or Reference note).
 */
export async function promoteToKnowledge(
	kind: "decisions" | "questions" | "reference",
	input: { title?: string; body: string; decision?: string; ticket?: string; heading?: string; sourcePlan?: string; codePath?: string },
): Promise<string | null> {
	if (!ready()) return null;
	const folder = joinPath(areaFolder("knowledge"), kind);
	const defaultTitle = input.title?.trim() || "";
	const promptLabel =
		kind === "decisions"
			? "Decision title"
			: kind === "questions"
				? "Question title"
				: "Reference note title";
	const title = (await ask(promptLabel, defaultTitle))?.trim();
	if (!title || !slug(title)) return null;
	const ticket = input.ticket || ticketAtHand() || undefined;
	const bodyText = input.body.trim();
	const decisionText = input.decision?.trim() ?? "";

	if (kind === "reference") {
		const dest = joinPath(folder, `${slug(title)}.md`);
		let template = referenceTemplate({ title });
		if (ticket) {
			const withT = withFrontMatter(template, "ticket", ticket);
			template = withT ?? `---\ntitle: ${title}\nticket: ${ticket}\n---\n\n${template}`;
		}
		const final = bodyText
			? `${template.split("## ")[0] ?? template}${input.heading ? `## ${input.heading}\n\n` : ""}${bodyText}\n`
			: template;
		await start(dest, final, "knowledge");
		return dest;
	}

	if (kind === "questions") {
		const dest = joinPath(folder, `${slug(title)}.md`);
		const template = questionTemplate({ title, date: today(), ticket });
		const final = bodyText
			? `${template.replace(/\n## Answer[\s\S]*$/, "")}\n${bodyText}\n\n## Answer\n\n`
			: template;
		await start(dest, final, "knowledge");
		return dest;
	}

	// Duplicate ADR guard: check if a decision with the same slug/title already exists before minting a new number.
	const allDecisions = (await backend.docs()).filter((d) => d.exists && d.group === "knowledge" && d.kind === "decisions");
	const wantedSlug = slug(title).toLowerCase();
	const existingMatch = allDecisions.find((d) => {
		const stem = baseName(d.name).replace(/\.(md|markdown)$/i, "").replace(/^\d+-/, "").toLowerCase();
		return stem === wantedSlug || (d.title && slug(d.title).toLowerCase() === wantedSlug);
	});
	if (existingMatch) {
		const OPEN_EXISTING = "Open existing decision";
		const CREATE_NEW = "Create new decision";
		const picked = await choose(
			`A decision with this title already exists (${baseName(existingMatch.name)}).`,
			[OPEN_EXISTING, CREATE_NEW],
		);
		if (!picked) return null;
		if (picked === OPEN_EXISTING) {
			await openFile(existingMatch.path);
			return existingMatch.path;
		}
	}

	const taken = allDecisions.map((d) => Number(/^(\d+)/.exec(baseName(d.name))?.[1] ?? 0));
	const number = String(Math.max(0, ...taken) + 1).padStart(4, "0");
	const dest = joinPath(folder, `${number}-${slug(title)}.md`);
	const header = decisionTemplate({ title, date: today(), ticket }).replace(/## Context[\s\S]*$/, "");

	// Build context citation (from sourcePlan or active code file if applicable).
	const contextNotes: string[] = [];
	if (input.sourcePlan) {
		const relPlan = relativePath(dirName(dest), input.sourcePlan);
		contextNotes.push(`From plan [${baseName(input.sourcePlan)}](${relPlan}).`);
	} else {
		const code = codeAtHand();
		if (code) {
			contextNotes.push(
				codeSection({
					file: relativeTo(root(), code.path).split("\\").join("/"),
					link: relativePath(dirName(dest), code.path),
					from: code.from,
					to: code.to,
					text: code.text,
					language: code.language,
					date: today(),
				}),
			);
		} else if (input.codePath) {
			const relCode = relativePath(dirName(dest), input.codePath);
			contextNotes.push(`Related file: [${baseName(input.codePath)}](${relCode}).`);
		}
	}
	if (decisionText) {
		if (bodyText) contextNotes.push(bodyText);
	}
	const contextSection = contextNotes.length ? contextNotes.join("\n\n") : "(describe context)";
	const settledDecision = decisionText || bodyText || "(summarize the settled decision)";
	const final = `${header}## Context\n\n${contextSection}\n\n## Decision\n\n${settledDecision}\n\n## Consequences\n\n`;
	await start(dest, final, "knowledge");
	return dest;
}

/** Promotes an answered Question document into a numbered Decision ADR pre-filled with the question & answer. */
export async function promoteQuestionToDecision(questionPath: string): Promise<void> {
	if (!ready()) return;
	const text = await current(questionPath);
	if (text === null) return;
	const fm = frontMatter(text);
	const doc = docs().find((d) => canonical(d.path) === canonical(questionPath));
	const qTitle = doc?.title || baseName(questionPath).replace(/\.(md|markdown)$/i, "");
	const ticket = many(fm.values.ticket)[0] ?? many(fm.values.tickets)[0] ?? doc?.tickets?.[0] ?? ticketAtHand() ?? undefined;
	const cleanBody = fm.body.replace(/^\s*#\s+.*\r?\n/, "").trim();
	const answerMatch = /^#{1,6}\s+Answer\s*$\r?\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(cleanBody);
	const answer = answerMatch?.[1]?.trim() ?? "";
	const context = answerMatch ? cleanBody.slice(0, answerMatch.index).trim() : cleanBody;
	const qStem = baseName(questionPath).replace(/\.(md|markdown)$/i, "");
	const title = (await ask("Decision title for this settled question", qTitle.replace(/\?+$/, "")))?.trim();
	if (!title || !slug(title)) return;
	const folder = joinPath(areaFolder("knowledge"), "decisions");
	const taken = (await backend.docs())
		.filter((d) => d.group === "knowledge" && d.kind === "decisions")
		.map((d) => Number(/^(\d+)/.exec(baseName(d.name))?.[1] ?? 0));
	const number = String(Math.max(0, ...taken) + 1).padStart(4, "0");
	const dest = joinPath(folder, `${number}-${slug(title)}.md`);
	const header = decisionTemplate({ title, date: today(), ticket }).replace(/## Context[\s\S]*$/, "");
	const body = [
		header.trimEnd(),
		"",
		"## Context",
		"",
		`Promoted from [[${qStem}]].`,
		...(context ? ["", context] : []),
		"",
		"## Decision",
		"",
		answer || "(summarize the settled decision)",
		"",
		"## Consequences",
		"",
		"",
	].join("\n");
	await start(dest, body, "knowledge");
}

/** Appends a dated note (e.g. an Agent reply) to a ticket's Markdown document. */
export async function appendNoteToTicket(key: string, noteMarkdown: string): Promise<void> {
	if (!ready()) return;
	const target = docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === key.toLowerCase());
	if (!target) return notify(`Ticket ${key} was not found.`, "error");
	const before = await current(target.path);
	if (before === null) return;
	const sep = before.endsWith("\n") ? "\n" : "\n\n";
	const next = `${before}${sep}## Agent note (${today()})\n\n${noteMarkdown.trim()}\n`;
	try {
		await put(target.path, next, true);
		setState("treeVersion", (v) => v + 1);
		notify(`Appended note to ${target.ticket ?? target.name}.`);
		await openFile(target.path);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/** Parses `CREATE TABLE` DDL from a schema SQL file and generates a Markdown table reference doc. */
export async function generateSchemaDocFromSql(sqlPath?: string): Promise<void> {
	if (!ready()) return;
	let sourcePath = sqlPath;
	if (!sourcePath) {
		const sqlFiles = docs().filter((d) => d.exists && d.group === "schema" && /\.(sql|ddl|pks|pkb)$/i.test(d.name));
		if (!sqlFiles.length) return notify(`No SQL/DDL files found under ${state.project!.schema}/.`);
		const labels = sqlFiles.map((f) => f.name);
		const picked = await choose("Choose a SQL file to document tables from", labels);
		if (!picked) return;
		sourcePath = sqlFiles.find((f) => f.name === picked)?.path;
	}
	if (!sourcePath) return;
	const sqlText = await current(sourcePath);
	if (sqlText === null) return notify("Could not read the SQL file.", "error");
	const tables = parseCreateTables(sqlText);
	if (!tables.length) return notify(`No CREATE TABLE statements were found in ${baseName(sourcePath)}.`);
	const relSql = relativeTo(root(), sourcePath).split("\\").join("/");
	const defaultName = tables.length === 1 ? tables[0]!.tableName : baseName(sourcePath).replace(/\.[^.]+$/, "");
	const name = (await ask("Table document name (saved under schema/database/)", defaultName))?.trim();
	if (!name) return;
	const named = typedParts(name, "file");
	if ("problem" in named || named.parts.length !== 1) return notify("Give a single valid filename.", "error");
	const dest = joinPath(schemaFolder(), "database", `${named.parts[0]}.md`);
	const mdBody = [
		"---",
		`title: ${tables.length === 1 ? tables[0]!.tableName : name}`,
		`status: draft`,
		`source: ${relSql}`,
		"---",
		"",
		`# ${tables.length === 1 ? tables[0]!.tableName : name}`,
		"",
		sqlTablesToMarkdown(tables, relSql).trimEnd(),
		"",
	].join("\n");
	await start(dest, mdBody, "schema");
}

async function renderCleanHtmlForExport(markdown: string, docPath: string): Promise<string> {
	const rawBody = frontMatter(markdown).body.replace(/\r\n/g, "\n");
	// 1. Pre-render fenced ```mermaid blocks into self-contained light-mode SVGs.
	const { renderMermaidSvgForExport } = await import("./editor/cmMermaid");
	const mermaidSvgs: string[] = [];
	const lines = rawBody.split("\n");
	const rebuilt: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/i.exec(lines[i]!);
		if (m) {
			const delim = m[1]![0]!;
			const len = m[1]!.length;
			const closeRe = new RegExp(`^[ \\t]{0,3}${delim}{${len},}[ \\t]*$`);
			const block: string[] = [];
			let j = i + 1;
			while (j < lines.length && !closeRe.test(lines[j]!)) {
				block.push(lines[j]!);
				j++;
			}
			const code = block.join("\n").trim();
			if (code && j < lines.length) {
				const svg = await renderMermaidSvgForExport(code);
				if (svg) {
					const idx = mermaidSvgs.length;
					mermaidSvgs.push(svg);
					rebuilt.push(`<div data-export-mermaid="${idx}"></div>`);
					i = j;
					continue;
				}
			}
		}
		rebuilt.push(lines[i]!);
	}

	const rawHtml = marked.parse(rebuilt.join("\n"), { async: false, gfm: true }) as string;
	const clean = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ["data-export-mermaid"] });
	const allDocs = docs();
	const wsRoot = state.workspace?.root;
	const tickets = allDocs
		.filter((d) => d.exists && d.group === "tickets" && d.ticket)
		.map((d) => ({
			key: d.ticket!,
			href: relativePath(dirName(docPath), d.path),
			about: [d.ticket, d.title].filter(Boolean).join(" "),
		}));
	const named = (name: string) => {
		const found = docByName(name, allDocs, wsRoot);
		if (!found) return null;
		return { href: relativePath(dirName(docPath), found.path), about: found.title || found.name };
	};
	const finished = finishMarkdown(clean, { tickets, named });

	// 2. Transform DOM in a detached container: callout cards, ==highlight==, inline base64 images, and Mermaid SVGs.
	if (typeof document === "undefined") return finished;
	const box = document.createElement("div");
	box.innerHTML = finished;

	// Splice pre-rendered Mermaid SVGs safely.
	for (const holder of box.querySelectorAll<HTMLElement>("[data-export-mermaid]")) {
		const idx = Number(holder.dataset.exportMermaid);
		const svg = mermaidSvgs[idx];
		if (!svg) continue;
		const fig = document.createElement("figure");
		fig.className = "md-mermaid-export";
		fig.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } });
		holder.replaceWith(fig);
	}

	// Convert Obsidian callout blockquotes (`> [!kind] Title`) into styled `.md-callout` cards.
	for (const bq of box.querySelectorAll("blockquote")) {
		const firstP = bq.firstElementChild;
		if (!firstP || firstP.tagName !== "P") continue;
		const firstHtml = firstP.innerHTML;
		const cm = /^\s*\[!([A-Za-z0-9_-]+)\][+-]?(?:[ \t]+([^\n<]*))?(?:<br\s*\/?>|\n)?([\s\S]*)$/i.exec(firstHtml);
		if (!cm) continue;
		const kind = cm[1]!.toLowerCase();
		const titleText = cm[2]?.trim() || kind[0]!.toUpperCase() + kind.slice(1);
		const restFirst = cm[3]?.trim() ?? "";
		const card = document.createElement("div");
		card.className = `md-callout md-callout-${kind}`;
		const titleDiv = document.createElement("div");
		titleDiv.className = "md-callout-title";
		titleDiv.textContent = titleText;
		card.append(titleDiv);
		if (restFirst) {
			const p = document.createElement("p");
			p.innerHTML = restFirst;
			card.append(p);
		}
		while (firstP.nextSibling) card.append(firstP.nextSibling);
		bq.replaceWith(card);
	}

	// Convert `==highlight==` outside code/pre elements.
	const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	let curNode = walker.nextNode();
	while (curNode) {
		const parent = curNode.parentElement;
		if (parent && !parent.closest("code, pre, script, style, svg") && (curNode.nodeValue ?? "").includes("==")) {
			textNodes.push(curNode as Text);
		}
		curNode = walker.nextNode();
	}
	for (const tn of textNodes) {
		const val = tn.nodeValue ?? "";
		if (!/==[^=\n]+==/.test(val)) continue;
		const span = document.createElement("span");
		span.innerHTML = escapeHtml(val).replace(/==([^=\n]+)==/g, '<mark class="md-highlight">$1</mark>');
		tn.replaceWith(...Array.from(span.childNodes));
	}

	// Inline local workspace images as self-contained data URLs so exported HTML works offline.
	const { loadImageUrl } = await import("./editor/imageResolve");
	const imgs = Array.from(box.querySelectorAll<HTMLImageElement>("img"));
	for (const img of imgs) {
		const rawSrc = img.getAttribute("src")?.trim() ?? "";
		if (!rawSrc || /^https?:\/\//i.test(rawSrc) || /^data:/i.test(rawSrc)) continue;
		const loaded = await loadImageUrl(rawSrc, docPath);
		if (loaded?.url) img.setAttribute("src", loaded.url);
	}

	return box.innerHTML;
}

function downloadBlobFile(filename: string, content: string, mime: string) {
	const blob = new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Saves an exported file into the workspace in desktop Electrobun builds, or downloads via Blob in browser builds. */
async function saveExportFile(defaultRelPath: string, filename: string, content: string, mime: string): Promise<boolean> {
	const { inApp } = await import("./backend");
	if (inApp && state.workspace?.root) {
		const picked = (await ask("Save export to (path in workspace)", defaultRelPath))?.trim();
		if (!picked) return false;
		const cleanRel = picked.replace(/\\/g, "/").replace(/^\/+/, "");
		const dest = joinPath(state.workspace.root, ...cleanRel.split("/").filter(Boolean));
		if (!isInside(state.workspace.root, dest)) {
			notify("Export path must stay inside the workspace.", "error");
			return false;
		}
		try {
			const exists = await backend.read(dest).then(() => true, () => false);
			if (!exists) await backend.create(dest, "file");
			await backend.write(dest, content);
			setState("treeVersion", (v) => v + 1);
			notify(`Saved export to ${relativeTo(state.workspace.root, dest)}.`);
			return true;
		} catch (e: any) {
			notify(`Could not save export: ${e?.message ?? e}`, "error");
			return false;
		}
	}
	downloadBlobFile(filename, content, mime);
	notify(`Exported ${filename}.`);
	return true;
}

/** Prints standalone HTML cleanly using a hidden iframe (immune to popup blockers and works in Electrobun & Source mode). */
function printHtmlDocument(fullHtml: string) {
	const frame = document.createElement("iframe");
	frame.style.position = "fixed";
	frame.style.width = "0";
	frame.style.height = "0";
	frame.style.border = "0";
	frame.style.visibility = "hidden";
	frame.setAttribute("aria-hidden", "true");
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		frame.remove();
	};
	frame.addEventListener("load", () => {
		const win = frame.contentWindow;
		if (!win) {
			cleanup();
			window.print();
			return;
		}
		win.addEventListener("afterprint", cleanup, { once: true });
		try {
			win.focus();
			win.print();
		} catch {
			cleanup();
			window.print();
		}
		setTimeout(cleanup, 60_000);
	});
	frame.srcdoc = fullHtml;
	document.body.appendChild(frame);
}

/** Copies or exports a Markdown document as rich HTML, Jira/Confluence wiki markup, standalone HTML, or Print/PDF. */
export async function exportDocAs(
	path: string,
	format: "html-copy" | "jira-copy" | "html-download" | "print",
): Promise<void> {
	const text = await current(path);
	if (text === null) return notify("Could not read the document.", "error");
	const fm = frontMatter(text);
	const title = one(fm.values.title) || baseName(path).replace(/\.(md|markdown)$/i, "");
	const stem = baseName(path).replace(/\.(md|markdown)$/i, "");

	if (format === "jira-copy") {
		const jira = markdownToJira(text);
		const { copyText } = await import("./commands");
		await copyText(jira, "Copied Jira / Confluence markup.");
		return;
	}

	const bodyHtml = await renderCleanHtmlForExport(text, path);

	if (format === "html-copy") {
		const plainText = fm.body.trim();
		try {
			if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
				await navigator.clipboard.write([
					new ClipboardItem({
						"text/html": new Blob([bodyHtml], { type: "text/html" }),
						"text/plain": new Blob([plainText], { type: "text/plain" }),
					}),
				]);
				notify("Copied rich HTML to clipboard.");
				return;
			}
		} catch {
			// Fall back to plain clipboard write below.
		}
		const { copyText } = await import("./commands");
		await copyText(bodyHtml, "Copied HTML to clipboard.");
		return;
	}

	const subtitle = state.project?.name ? `${state.project.name} · Exported ${today()}` : `Exported ${today()}`;
	const fullHtml = buildPrintableHtml(title, bodyHtml, subtitle);

	if (format === "html-download") {
		const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");
		await saveExportFile(`${docsRel}/exports/${stem}.html`, `${stem}.html`, fullHtml, "text/html;charset=utf-8");
		return;
	}

	printHtmlDocument(fullHtml);
}

/** Assembles and exports a complete Ticket Release Packet (HTML or Markdown) bundling all linked work & Readiness Gate. */
export async function exportTicketPacket(ticketPath: string, key: string, format: "html" | "markdown"): Promise<void> {
	if (!ready()) return;
	const ticketText = await current(ticketPath);
	if (ticketText === null) return notify("Could not read the ticket.", "error");
	const allDocs = docs();
	const ticketDoc = allDocs.find((d) => canonical(d.path) === canonical(ticketPath));
	const groups = ticketWork(allDocs, key);

	const readGroup = async (kind: string) => {
		const files = groups.find((g) => g.kind === kind)?.files ?? [];
		const out: { title: string; status?: string; body: string }[] = [];
		for (const f of files) {
			const txt = (await current(f.path)) ?? "";
			out.push({ title: f.title || f.name, status: f.status, body: txt });
		}
		return out;
	};

	const specs = await readGroup("spec");
	const decisions = await readGroup("decision");
	const questions = [...(await readGroup("answer")), ...(await readGroup("question"))];
	const references = await readGroup("reference");
	const schemas = await readGroup("schema");
	const subtickets = (groups.find((g) => g.kind === "subticket")?.files ?? []).map((t) => ({
		key: t.ticket ?? t.name,
		title: t.title || t.name,
		status: t.status,
	}));
	const related = (groups.find((g) => g.kind === "ticket")?.files ?? []).map((t) => ({
		key: t.ticket ?? t.name,
		title: t.title || t.name,
		status: t.status,
	}));
	const plans = (groups.find((g) => g.kind === "plan")?.files ?? []).map((p) => ({
		name: p.name,
		title: p.heading || p.title,
		status: p.status,
		scripts: p.codeRefs,
	}));

	const registries: { title: string; headers: string[]; rows: string[][] }[] = [];
	const keyLower = key.toLowerCase();
	const knownSet = new Set([keyLower]);
	for (const reg of groups.find((g) => g.kind === "registry")?.files ?? []) {
		const csvText = await current(reg.path);
		if (!csvText) continue;
		const parsed = parseCsv(csvText);
		const tCol = ticketColumn(parsed);
		if (tCol < 0) continue;
		const matched = parsed.rows
			.filter((cells) => keysIn(cells[tCol]?.text ?? "", knownSet).some((k) => k.toLowerCase() === keyLower))
			.map((cells) => parsed.header.map((_, i) => cells[i]?.text ?? ""));
		if (matched.length) {
			registries.push({
				title: registryTitle(reg.name),
				headers: parsed.header.map((c) => c.text.trim()),
				rows: matched,
			});
		}
	}

	const { gitStatus } = await import("./git");
	const readiness = evaluateTicketReadiness(allDocs, key, {
		gitFiles: gitStatus()?.files,
		root: state.workspace?.root,
	});

	const packetMd = assembleTicketPacketMarkdown({
		projectName: state.project?.name || state.workspace?.name || "Project",
		generatedOn: today(),
		ticketKey: key,
		ticketTitle: ticketDoc?.title || key,
		status: ticketDoc?.status,
		parent: ticketDoc?.parent,
		ticketBody: ticketText,
		specs,
		plans,
		subtickets,
		related,
		decisions,
		questions,
		references,
		schemas,
		registries,
		ticketFiles: ticketDoc?.ticketFiles ?? [],
		totalTicketFiles: ticketDoc?.ticketFileCount,
		readiness,
	});

	const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");
	const exportDir = ticketDoc?.ticketFolder
		? `${relativeTo(root(), ticketDoc.ticketFolder).split("\\").join("/")}/exports`
		: `${docsRel}/exports`;

	if (format === "markdown") {
		await saveExportFile(`${exportDir}/${key}-release-packet.md`, `${key}-release-packet.md`, packetMd, "text/markdown;charset=utf-8");
		return;
	}

	const bodyHtml = await renderCleanHtmlForExport(packetMd, ticketPath);
	const html = buildPrintableHtml(`${key}: ${ticketDoc?.title || key} — Release Packet`, bodyHtml);
	await saveExportFile(`${exportDir}/${key}-release-packet.html`, `${key}-release-packet.html`, html, "text/html;charset=utf-8");
}
