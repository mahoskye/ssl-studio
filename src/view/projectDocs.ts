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
import {
	assembleDeploymentManifestCsv,
	assembleDeploymentManifestMarkdown,
	assembleReleaseBundleMarkdown,
	assembleReleaseNotesMarkdown,
	assembleRtmCsv,
	assembleRtmMarkdown,
	assembleTicketPacketMarkdown,
	buildPrintableHtml,
	buildRtmRows,
	classifyDeploymentArtifact,
	demoteMarkdownHeadings,
	escapeHtml,
	evaluateTicketReadiness,
	extractExportMeta,
	inlineExportStyles,
	markdownToJira,
	renderFrontMatterSummaryHtml,
	transformMarkdownFootnotes,
	type PlanBusinessTest,
	type ReleaseBundleCommit,
	type ReleaseBundleInput,
	type ReleaseBundleTicket,
} from "../shared/docExport";
import { headingAnchor } from "../shared/docTables";
import {
	addToFrontMatterList,
	bodyOffset,
	frontMatter,
	many,
	one,
	quoteYamlScalar,
	removeFromFrontMatterList,
	replaceInFrontMatterList,
	withFrontMatter,
} from "../shared/frontMatter";
import { documentHeadings, findHeadingLine, parseImageAltSize, upsertTocBlock } from "../shared/markdownEdit";
import { keysIn, ticketColumn } from "../shared/registryTickets";
import { extractSqlObjects, mergeSqlTablesIntoMarkdown, parseCreateTables, sqlTablesToMarkdown } from "../shared/sqlSchema";
import { importSummary, ticketsFromJson, ticketsFromTable, type Imported, type ImportedTicket } from "../shared/ticketImport";
import { manifestSummary, mergeManifest } from "../shared/manifest";
import { buildDocNameIndex, docByName, lookupInIndex, namedLink, namesToFollow, withNames } from "../shared/namedLinks";
import { baseName, dirName, isInside, joinPath, relativePath, relativeTo, resolvePath } from "../shared/paths";
import { activeEditor } from "./editor/EditorGroup";
import { activeLiveEditor } from "./editor/liveBridge";
import {
	catalogItems,
	catalogTemplate,
	codeSection,
	decisionTemplate,
	DOC_FOLDERS,
	KNOWLEDGE,
	PROMPTS,
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
import { ask, choose, quickPick, type QuickPickOption } from "./dialogs";
import { toggleTask } from "../shared/tasks";
import type { LinkMend } from "../shared/docChecks";
import { linkFile, linkWritten, ownLinkEdits, rewriteHeadingReferences, withLinkFiles, type LinkEdit } from "../shared/docLinks";
import { parsePlan, printPlan, isPlanPath } from "./plan/model";
import { docs, isMarkdown } from "./project";
import {
	codeMatchesRef,
	descendantTickets,
	ticketAtHand as listedTicketAtHand,
	scriptsForTicket,
	ticketForFile,
	ticketWork,
	workFor,
	workLabel,
	workText,
	type WorkTextOptions,
} from "../shared/workContext";
import { finishMarkdown, loadKatex } from "./editor/markdownHtml";
import { activeDoc, activePath, applyText, canonical, documents, fileRemoved, fileRenamed, notify, openFile, save, saveSetting, setState, state } from "./state";

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

/** The ticket at hand: active workspace ticket, governing ticket for the open file, the open doc's own ticket, or the sole active ticket. "" when it cannot be told. */
export const ticketAtHand = (): string =>
	state.settings.activeTicket?.trim() ||
	ticketForFile(docs(), activePath(), state.workspace?.root) ||
	ticketOfOpen() ||
	listedTicketAtHand(docs(), activePath());

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
	const notProjectJson = (p: string) => !isPlanPath(p) && !/^(package|tsconfig|jsconfig|settings)\.json$/i.test(baseName(p)) && !canonical(p).includes("/.ssl-studio/");
	const inFolder = open && exported.test(open) && notProjectJson(open) && !canonical(open).startsWith(canonical(areaFolder("registries"))) ? relativeTo(root(), open) : "";
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
				let fresh = ticketTemplate(ticket);
				if (ticket.release) fresh = withFrontMatter(fresh, "release", frontValue(ticket.release)) ?? fresh;
				if (ticket.priority) fresh = withFrontMatter(fresh, "priority", frontValue(ticket.priority)) ?? fresh;
				for (const tag of ticket.tags ?? []) fresh = addToFrontMatterList(fresh, "tags", tag) ?? fresh;
				if (ticket.acceptanceCriteria?.trim()) {
					const ac = ticket.acceptanceCriteria.trim();
					const donePlaceholder = /^## What done looks like\r?\n\r?\n- \[ \] What must be true when this is done:[^\r\n]*/m;
					if (donePlaceholder.test(fresh)) {
						fresh = fresh.replace(donePlaceholder, () => `## What done looks like\n\n${ac}`);
					} else {
						fresh = fresh.replace(/^## What done looks like\r?\n+/m, (m) => `${m}${ac}\n\n`);
					}
				}
				await put(dest, fresh, false);
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
				["release", ticket.release],
				["priority", ticket.priority],
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
			for (const tag of ticket.tags ?? []) now = addToFrontMatterList(now, "tags", tag) ?? now;
			for (const relKey of ticket.related) now = addToFrontMatterList(now, "related", relKey) ?? now;
			for (const blk of ticket.blocks ?? []) now = addToFrontMatterList(now, "blocks", blk) ?? now;
			for (const by of ticket.blockedBy ?? []) now = addToFrontMatterList(now, "blocked-by", by) ?? now;
			// Hydrate untouched stub descriptions only when the template prompt is still verbatim (ADR 0009: never overwrite human-edited descriptions).
			if (ticket.description?.trim() && now.includes(PROMPTS.ticket)) {
				const cutAt = bodyOffset(now);
				const headPart = now.slice(0, cutAt);
				const bodyPart = now.slice(cutAt);
				if (bodyPart.includes(PROMPTS.ticket)) {
					now = headPart + bodyPart.replace(PROMPTS.ticket, () => ticket.description.trim());
				}
			}
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
 * When `allowEmptySelection` is true (e.g. invoked from a code file's Docs menu
 * or context menu with no selection), falls back to the current file and cursor line.
 */
function codeAtHand(options?: {
	allowEmptySelection?: boolean;
	codePath?: string;
	codeLine?: number;
}): { path: string; from: number; to: number; text: string; language: string; hasExcerpt: boolean } | null {
	const path = options?.codePath ?? activePath();
	const editor = activeEditor();
	const model = editor?.getModel();
	if (!path || isMarkdown(path) || isPlanPath(path)) return null;
	const df = canonical(docsFolder());
	if (df !== canonical(root()) && isInside(df, path)) return null;
	const sameModel = Boolean(editor && model && (!options?.codePath || canonical(options.codePath) === canonical(activePath() ?? "")));
	const selection = sameModel ? editor?.getSelection() : null;
	if (sameModel && model && selection && !selection.isEmpty()) {
		// Whole lines: a selection that stops at a line's start does not take that line.
		const to = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
		const language = model.getLanguageId();
		return {
			path,
			from: selection.startLineNumber,
			to,
			text: model.getValueInRange({ startLineNumber: selection.startLineNumber, startColumn: 1, endLineNumber: to, endColumn: model.getLineMaxColumn(to) }),
			language: language === "plaintext" ? "" : language,
			hasExcerpt: true,
		};
	}
	if (!options?.allowEmptySelection) return null;
	const line = Math.max(1, options.codeLine ?? (sameModel ? editor?.getPosition()?.lineNumber : undefined) ?? 1);
	const language = sameModel && model ? model.getLanguageId() : "";
	return { path, from: line, to: line, text: "", language: language === "plaintext" ? "" : language, hasExcerpt: false };
}

/** Something for the knowledge base: a decision, a question, a snippet or a reference note. */
export async function newKnowledge(
	kind: KnowledgeKind["id"],
	options?: { ticket?: string; codePath?: string; codeLine?: number; allowEmptySelection?: boolean },
) {
	if (!ready()) return;
	const what = KNOWLEDGE.find((k) => k.id === kind)!;
	const folder = joinPath(areaFolder("knowledge"), kind);
	// Read before anything is asked: a dialog takes the keyboard, and the selection with it.
	const allowEmpty = kind !== "snippets" && Boolean(options?.allowEmptySelection || options?.codePath || activeEditor()?.hasTextFocus());
	const code =
		kind === "questions" || kind === "decisions" || kind === "snippets"
			? codeAtHand({ allowEmptySelection: allowEmpty, codePath: options?.codePath, codeLine: options?.codeLine })
			: null;
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
		const body = code?.hasExcerpt ? `${header.replace(/\n*$/, "\n\n")}${code.text}\n` : header;
		return start(joinPath(folder, `${slug(title)}.${lang}`), body, "knowledge");
	}
	if (kind === "reference") return start(joinPath(folder, `${slug(title)}.md`), referenceTemplate({ title }), "knowledge");
	if (kind === "prompts") return start(joinPath(folder, `${slug(title)}.md`), promptTemplate({ title }), "knowledge");
	const ticket = options?.ticket || (code ? ticketForFile(docs(), code.path, root()) : "") || ticketAtHand() || undefined;
	// Started with code selected (or from a code file), it is about that code: cites the file & line(s), and keeps selected lines verbatim.
	const about = code
		? code.hasExcerpt
			? codeSection({
					file: relativeTo(root(), code.path).split("\\").join("/"),
					link: relativePath(folder, code.path),
					from: code.from,
					to: code.to,
					text: code.text,
					language: code.language,
					date: today(),
				})
			: `\n## In the code\n\n[${relativeTo(root(), code.path).split("\\").join("/")}, line ${code.from}](${relativePath(folder, code.path).split("/").map(encodeURIComponent).join("/")}#L${code.from})\n`
		: "";
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

/** A row for each object the schema folder's SQL creates or alters: object, kind, used by (empty), ticket (empty), status, and where it was found. */
async function schemaRows(): Promise<string> {
	const rows: string[] = [];
	const seen = new Set<string>();
	try {
		for (const file of (await backend.docs()).filter((d) => d.group === "schema" && d.exists && /\.(sql|ddl|pks|pkb)$/i.test(d.name))) {
			const text = await current(file.path);
			if (text === null) continue;
			const rel = relativeTo(root(), file.path).split("\\").join("/");
			for (const made of extractSqlObjects(text, { includeAlter: true })) {
				const key = made.name.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				rows.push(csvRow([made.name, made.kind, "", "", "found", `From ${rel}`]));
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

	// Decision Supersede flow: offer to link an existing ADR OR create a new superseding ADR and cross-link both frontmatters.
	const decisionDoc = docs().find((d) => d.group === "knowledge" && d.kind === "decisions" && canonical(d.path) === canonical(path));
	if (decisionDoc && status.toLowerCase() === "superseded" && ready()) {
		const LINK_EXISTING = "Link existing decision…";
		const CREATE = "Create superseding decision…";
		const picked = await choose("Link a superseding decision to this ADR?", [LINK_EXISTING, CREATE, "Skip"], {
			details: {
				[LINK_EXISTING]: "Pick an already-written decision and cross-link supersedes: / superseded-by:",
				[CREATE]: "Creates the next numbered decision with supersedes: and adds superseded-by: here",
				Skip: "Keep status as superseded without linking a decision",
			},
		});
		if (picked === LINK_EXISTING) {
			const allDocs = await backend.docs().catch(() => docs());
			const others = allDocs.filter(
				(d) => d.exists && d.group === "knowledge" && d.kind === "decisions" && !isCatalog(d) && canonical(d.path) !== canonical(path),
			);
			if (!others.length) {
				notify("No other decision documents exist yet.");
				return;
			}
			const labels = others.map((d) => `${baseName(d.path).replace(/\.(md|markdown)$/i, "")}${d.title ? ` — ${d.title}` : ""}`);
			const chosenLabel = await choose("Which existing decision supersedes this one?", labels);
			if (!chosenLabel) return;
			const targetDecision = others[labels.indexOf(chosenLabel)];
			if (!targetDecision) return;
			const oldStem = baseName(path).replace(/\.(md|markdown)$/i, "");
			const newStem = baseName(targetDecision.path).replace(/\.(md|markdown)$/i, "");
			const oldText = await current(path);
			if (oldText !== null) {
				const curBy = many(frontMatter(oldText).values["superseded-by"]);
				const updatedOld = curBy.length
					? addToFrontMatterList(oldText, "superseded-by", newStem)
					: withFrontMatter(oldText, "superseded-by", frontValue(newStem));
				if (updatedOld && updatedOld !== oldText) await put(path, updatedOld, true);
			}
			const targetText = await current(targetDecision.path);
			if (targetText !== null) {
				const curSup = many(frontMatter(targetText).values.supersedes);
				const updatedTarget = curSup.length
					? addToFrontMatterList(targetText, "supersedes", oldStem)
					: withFrontMatter(targetText, "supersedes", frontValue(oldStem));
				if (updatedTarget && updatedTarget !== targetText) await put(targetDecision.path, updatedTarget, true);
			}
			setState("treeVersion", (v) => v + 1);
			notify(`Linked ${newStem} as superseding ${oldStem}.`);
		} else if (picked === CREATE) {
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

async function followPaths(fromOrPairs: string | readonly { from: string; to: string }[], toSingle?: string) {
	if (!state.workspace) return;
	const rawPairs = typeof fromOrPairs === "string" ? [{ from: fromOrPairs, to: toSingle! }] : [...fromOrPairs];
	const pairs = rawPairs
		.filter((p) => p.from && p.to && canonical(p.from) !== canonical(p.to))
		.map((p) => ({ from: p.from, to: p.to, fromCanon: canonical(p.from), toCanon: canonical(p.to) }))
		.sort((a, b) => b.fromCanon.length - a.fromCanon.length);
	if (!pairs.length) return;
	const canonMoves = pairs.map((p) => ({ from: p.fromCanon, to: p.toCanon }));
	const primary = pairs[0]!;
	const isMovedTarget = (fileCanon: string) =>
		pairs.some((p) => fileCanon === p.toCanon || isInside(p.toCanon, fileCanon));

	// Gather incoming links across all co-moved paths, matching the most specific move first.
	const incomingPairs: { link: LinkTo; pair: (typeof pairs)[number] }[] = [];
	const seenIncoming = new Set<string>();
	for (const pair of pairs) {
		let links: LinkTo[];
		try {
			links = await backend.linksTo(pair.from);
		} catch {
			continue;
		}
		links = await withoutCatalogLists(links);
		for (const link of links) {
			const lc = canonical(link.path);
			// Links inside co-moved files themselves are rewritten atomically via `ownLinkEdits(..., canonMoves)`.
			if (isMovedTarget(lc)) continue;
			const key = `${lc}:${link.line}:${link.column ?? ""}:${link.href}`;
			if (seenIncoming.has(key)) continue;
			seenIncoming.add(key);
			incomingPairs.push({ link, pair });
		}
	}

	// Every moved Markdown file (single file or inside a moved folder) gets one atomic `ownLinkEdits` pass knowing ALL co-moved targets.
	const ownByFile = new Map<string, LinkEdit[]>();
	const seenOwnFile = new Set<string>();
	let wsFilesCache: string[] | null = null;
	for (const pair of pairs) {
		if (isMarkdown(pair.to)) {
			if (seenOwnFile.has(pair.toCanon)) continue;
			seenOwnFile.add(pair.toCanon);
			const moved = (await current(pair.to)) ?? "";
			const own = moved ? ownLinkEdits(moved, pair.fromCanon, pair.toCanon, canonMoves) : [];
			if (own.length) ownByFile.set(pair.to, own);
		} else {
			wsFilesCache ??= await backend.files().catch(() => []);
			for (const filePath of wsFilesCache) {
				const fc = canonical(filePath);
				if (!isMarkdown(filePath) || seenOwnFile.has(fc) || !isInside(pair.toCanon, fc)) continue;
				seenOwnFile.add(fc);
				const oldFile = pair.fromCanon + fc.slice(pair.toCanon.length);
				const movedText = (await current(filePath)) ?? "";
				const own = movedText ? ownLinkEdits(movedText, oldFile, fc, canonMoves) : [];
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
	for (const { link, pair } of incomingPairs) {
		const target = `${pair.to}${link.rest}`;
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

	const holders = [...new Set(incomingPairs.map((x) => x.link.path))];
	const where = holders.length === 1 ? relativeTo(root(), holders[0]!) : `${holders.length} documents`;
	const said = [
		incomingCount ? `${incomingCount === 1 ? "One place" : `${incomingCount} places`} in ${where} still ${incomingCount === 1 ? "says" : "say"} the old name, ${baseName(primary.from)}.` : "",
		ownCount ? `${ownCount === 1 ? "One link" : `${ownCount} links`} in ${baseName(primary.to)} ${ownCount === 1 ? "is" : "are"} written from where it was.` : "",
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
	if (done) notify(`${done} ${done === 1 ? "place was" : "places were"} written anew for ${baseName(primary.to)}.`);
	const left = total - done;
	if (left > 0) notify(`${left} of them ${left === 1 ? "is" : "are"} not where ${left === 1 ? "it was" : "they were"}: the document has changed since. Mend ${left === 1 ? "it" : "them"} in the text.`, "error");
}

/**
 * Rewrites matching workspace-relative paths inside `.plan.json` files (`targets` and `node.docs`),
 * serializing via `printPlan()` after user confirmation (ADR 0009).
 */
async function followPlanPaths(rawPairs: readonly { from: string; to: string }[]) {
	if (!state.workspace) return;
	const wsRoot = root();
	const pairs = rawPairs
		.filter((p) => p.from && p.to && canonical(p.from) !== canonical(p.to))
		.map((p) => ({ from: p.from, to: p.to, fromCanon: canonical(p.from), toCanon: canonical(p.to) }))
		.sort((a, b) => b.fromCanon.length - a.fromCanon.length);
	if (!pairs.length) return;

	const rewriteRef = (rawRef: string): string | null => {
		const trimmed = rawRef.trim();
		if (!trimmed || /^(?:https?:|mailto:|#)/i.test(trimmed)) return null;
		const hashIdx = trimmed.indexOf("#");
		const pathPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
		const fragPart = hashIdx >= 0 ? trimmed.slice(hashIdx) : "";
		const leadSlash = pathPart.startsWith("/");
		const clean = pathPart.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
		if (!clean) return null;
		const resolved = resolvePath(wsRoot, clean);
		const canonRes = canonical(resolved);
		for (const pair of pairs) {
			if (canonRes === pair.fromCanon || isInside(pair.fromCanon, canonRes)) {
				const dest = canonRes === pair.fromCanon ? pair.to : joinPath(pair.to, relativeTo(pair.from, resolved));
				const nextRel = relativeTo(wsRoot, dest).split("\\").join("/");
				const nextFull = `${leadSlash ? "/" : ""}${nextRel}${fragPart}`;
				return nextFull !== trimmed ? nextFull : null;
			}
		}
		return null;
	};

	const allDocs = await backend.docs().catch(() => docs());
	const planDocs = allDocs.filter((d) => d.exists && isPlanPath(d.path));
	if (!planDocs.length) return;

	const updates: { path: string; nextText: string; hits: number }[] = [];
	for (const pDoc of planDocs) {
		const rawText = await current(pDoc.path);
		if (rawText === null) continue;
		const parsed = parsePlan(rawText);
		if (!parsed.plan) continue;
		let hits = 0;
		const plan = parsed.plan;

		let nextTargets = plan.targets;
		if (Array.isArray(plan.targets)) {
			nextTargets = plan.targets.map((entry: unknown) => {
				if (typeof entry === "string") {
					const rep = rewriteRef(entry);
					if (rep) {
						hits++;
						return rep;
					}
					return entry;
				}
				if (entry && typeof entry === "object") {
					const obj = { ...(entry as Record<string, unknown>) };
					let objChanged = false;
					if (typeof obj.path === "string") {
						const rep = rewriteRef(obj.path);
						if (rep) {
							obj.path = rep;
							hits++;
							objChanged = true;
						}
					}
					if (typeof obj.script === "string") {
						const rep = rewriteRef(obj.script);
						if (rep) {
							obj.script = rep;
							hits++;
							objChanged = true;
						}
					}
					return objChanged ? obj : entry;
				}
				return entry;
			});
		}

		const nextNodes = plan.nodes.map((node) => {
			if (!Array.isArray(node.docs) || !node.docs.length) return node;
			let nodeChanged = false;
			const nextDocs = node.docs.map((docRef) => {
				if (typeof docRef !== "string") return docRef;
				const rep = rewriteRef(docRef);
				if (rep) {
					hits++;
					nodeChanged = true;
					return rep;
				}
				return docRef;
			});
			return nodeChanged ? { ...node, docs: nextDocs } : node;
		});

		if (hits > 0) {
			const nextPlan = {
				...plan,
				...(nextTargets !== undefined ? { targets: nextTargets } : {}),
				nodes: nextNodes,
			};
			const nextText = printPlan(nextPlan);
			if (nextText !== rawText) updates.push({ path: pDoc.path, nextText, hits });
		}
	}

	if (!updates.length) return;
	const totalHits = updates.reduce((sum, u) => sum + u.hits, 0);
	const primary = pairs[0]!;
	const where = updates.length === 1 ? relativeTo(wsRoot, updates[0]!.path) : `${updates.length} plans`;
	const said = `${totalHits === 1 ? "One path" : `${totalHits} paths`} in ${where} (targets / node docs) still ${totalHits === 1 ? "points" : "point"} to ${baseName(primary.from)}.`;
	const go = updates.length === 1 ? "Update plan" : `Update ${updates.length} plans`;
	if ((await choose(said, [go])) !== go) return;

	let written = 0;
	for (const item of updates) {
		try {
			await put(item.path, item.nextText, true);
			written++;
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	}
	if (written) {
		setState("treeVersion", (v) => v + 1);
		notify(`Updated ${totalHits} ${totalHits === 1 ? "path" : "paths"} in ${written} ${written === 1 ? "plan" : "plans"} for ${baseName(primary.to)}.`);
	}
}

/**
 * After a file or a folder is renamed: first the links by path that led to
 * the old name, then the links by name that no longer mean what they
 * meant, then matching workspace paths inside `.plan.json` files (`targets` and `node.docs`).
 * Each is asked about once, and written on the person's word.
 */
export async function followRename(from: string, to: string, beforeDocs?: DocFile[], coMoved?: readonly { from: string; to: string }[]) {
	// Prefer a caller-provided pre-rename snapshot so `followNames` never races an async `docs()` refresh.
	const listed = (beforeDocs ?? docs()).map((file) => ({ ...file, path: canonical(file.path) }));
	const allPairs = coMoved?.length ? [{ from, to }, ...coMoved] : [{ from, to }];
	await followPaths(coMoved?.length ? allPairs : from, to);
	await followNames(from, to, listed);
	await followPlanPaths(allPairs);
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
	let places: NameIn[];
	try {
		places = (await backend.namesIn()).map((place) => ({ ...place, path: canonical(place.path) }));
	} catch {
		return;
	}
	const follow: (NameIn & { instead: string })[] = before.some((file) => under(file.path, was))
		? namesToFollow(places, before, after, moved, root())
		: [];

	// Also rewrite non-doc wikilink/embed references such as `![[old.png]]` or `![[samples/old.sql]]`.
	const seenFollow = new Set(follow.map((p) => `${p.path}:${p.line}:${p.column}`));
	const oldBase = baseName(was);
	const newBase = baseName(is);
	const wsRoot = root();
	for (const place of places) {
		const key = `${place.path}:${place.line}:${place.column}`;
		if (seenFollow.has(key)) continue;
		const raw = place.name.replace(/\\/g, "/").trim();
		if (!raw) continue;
		let instead: string | null = null;
		if (raw.includes("/")) {
			const cleanRaw = raw.replace(/^\.\//, "");
			const candDoc = canonical(resolvePath(dirName(place.path), cleanRaw));
			const candRoot = canonical(resolvePath(wsRoot, cleanRaw.replace(/^\/+/, "")));
			if (under(candDoc, was)) {
				const destPath = moved(candDoc);
				const rel = relativePath(dirName(place.path), destPath).split("\\").join("/");
				instead = raw.startsWith("./") && !rel.startsWith(".") ? `./${rel}` : rel;
			} else if (under(candRoot, was)) {
				const destPath = moved(candRoot);
				const rel = relativeTo(wsRoot, destPath).split("\\").join("/");
				instead = raw.startsWith("/") ? `/${rel}` : rel;
			}
		} else if (raw.toLowerCase() === oldBase.toLowerCase() && ((place as NameIn & { embed?: boolean }).embed || /\.[a-z0-9]{1,8}$/i.test(oldBase))) {
			if (oldBase.toLowerCase() !== newBase.toLowerCase()) {
				instead = newBase;
			} else if (canonical(dirName(was)) === canonical(dirName(place.path)) && canonical(dirName(is)) !== canonical(dirName(place.path))) {
				instead = relativePath(dirName(place.path), is).split("\\").join("/");
			}
		}
		if (instead && instead !== place.name) {
			seenFollow.add(key);
			follow.push({ ...place, instead });
		}
	}

	if (follow.length) {
		const holders = [...new Set(follow.map((place) => place.path))];
		const where = holders.length === 1 ? relativeTo(root(), holders[0]!) : `${holders.length} documents`;
		const said = `${follow.length === 1 ? "One link by name" : `${follow.length} links by name`} in ${where} no longer ${follow.length === 1 ? "means what it" : "mean what they"} meant, now that ${baseName(from)} is ${baseName(from) === baseName(to) ? `in ${relativeTo(root(), dirName(to)) || "the project's folder"}` : baseName(to)}.`;
		const go = follow.length === 1 ? "Update it" : "Update them";
		if ((await choose(said, [go])) === go) {
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
	}

	// Follow decision `supersedes:` / `superseded-by:` frontmatter stems when renaming a decision file.
	const movedDecision =
		before.find((file) => file.path === was && file.group === "knowledge" && file.kind === "decisions") ??
		after.find((file) => file.path === is && file.group === "knowledge" && file.kind === "decisions");
	const oldStem = oldBase.replace(/\.(md|markdown)$/i, "");
	const newStem = newBase.replace(/\.(md|markdown)$/i, "");
	if (movedDecision && oldStem && newStem && oldStem.toLowerCase() !== newStem.toLowerCase()) {
		const decisionUpdates: { path: string; next: string }[] = [];
		for (const doc of after) {
			if (!doc.exists || doc.group !== "knowledge" || doc.kind !== "decisions" || doc.path === is || isCatalog(doc)) continue;
			const text = await current(doc.path);
			if (text === null) continue;
			let next = text;
			for (const field of ["supersedes", "superseded-by"]) {
				next = replaceInFrontMatterList(next, field, oldStem, newStem) ?? next;
			}
			if (next !== text) decisionUpdates.push({ path: doc.path, next });
		}
		if (decisionUpdates.length) {
			const count = decisionUpdates.length;
			const go = count === 1 ? "Update decision link" : `Update ${count} decisions`;
			const said = `${count === 1 ? "One decision" : `${count} decisions`} still ${count === 1 ? "references" : "reference"} ${oldStem} in supersedes / superseded-by frontmatter.`;
			if ((await choose(said, [go])) === go) {
				let updatedCount = 0;
				for (const item of decisionUpdates) {
					try {
						await put(item.path, item.next, true);
						updatedCount++;
					} catch (e: any) {
						notify(String(e?.message ?? e), "error");
					}
				}
				if (updatedCount) {
					setState("treeVersion", (v) => v + 1);
					notify(`Updated supersedes / superseded-by in ${updatedCount} ${updatedCount === 1 ? "decision" : "decisions"} for ${newStem}.`);
				}
			}
		}
	}
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
		let change = mergeManifest(before, files);
		if (change.changedAfterDone.length > 0) {
			const n = change.changedAfterDone.length;
			const preview = change.changedAfterDone.slice(0, 4).join(", ") + (n > 4 ? `, and ${n - 4} more` : "");
			const MARK = n === 1 ? "Mark as changed" : `Mark ${n} files as changed`;
			const KEEP = "Keep existing status";
			const picked = await choose(
				`${n === 1 ? "One verified or migrated file" : `${n} verified or migrated files`} changed since its checksum was recorded (${preview}). Mark ${n === 1 ? "it" : "them"} as "changed" for re-verification?`,
				[MARK, KEEP],
			);
			if (!picked) return;
			if (picked === MARK) change = mergeManifest(before, files, { markChangedAfterDone: true });
		}
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
			const normRef = (v: string) => v.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").toLowerCase();
			const targetNorm = normRef(relTarget);
			const removePathField = (src: string, field: string) => {
				const vals = many(frontMatter(src).values[field]);
				let cur = src;
				for (const v of vals) {
					const vn = normRef(v);
					if (vn === targetNorm || targetNorm.endsWith(`/${vn}`) || vn.endsWith(`/${targetNorm}`)) {
						cur = removeFromFrontMatterList(cur, field, v) ?? cur;
					}
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
				const parsed = parsePlan(dBefore);
				if (parsed.plan && typeof parsed.plan.ticket === "string" && parsed.plan.ticket.toLowerCase() === key.toLowerCase()) {
					const nextPlan = { ...parsed.plan };
					delete nextPlan.ticket;
					await put(target.path, printPlan(nextPlan), true);
					changed = true;
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

/** Appends a new row to a chosen CSV registry pre-filled with `key` in its Ticket column (adding a `ticket` column if missing). */
export async function addRegistryRowForTicket(key: string, initialItem?: string): Promise<void> {
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
	const hasTicketCol = ticketColumn(table) >= 0;
	let addTicketCol = false;
	if (!hasTicketCol) {
		const ADD_COL = "Add ticket column & row";
		if ((await choose(`${reg.name} has no "ticket" column yet, so a new row wouldn't link to ${key}. Add a "ticket" column first?`, [ADD_COL])) !== ADD_COL) {
			return;
		}
		addTicketCol = true;
	}
	const firstCol = table.header[0]!.text.trim() || "item";
	const name = (await ask(`New ${firstCol} for ${key} in ${reg.name}`, initialItem ?? ""))?.trim();
	if (!name) return;
	const nl = text.includes("\r\n") ? "\r\n" : "\n";
	let nextText = text;
	if (addTicketCol) {
		const headerVals = [...table.header.map((h) => h.text), "ticket"];
		const dataLines = table.rows.map((r) => csvRow([...r.map((c) => c.text), ""], table.delimiter));
		const newRow = headerVals.map((h, idx) => {
			const col = h.trim().toLowerCase();
			if (idx === 0) return name;
			if (col === "ticket") return key;
			if (col === "status") return "found";
			return "";
		});
		nextText = [csvRow(headerVals, table.delimiter), ...dataLines, csvRow(newRow, table.delimiter)].join(nl) + nl;
	} else {
		const row = table.header.map((h, idx) => {
			const col = h.text.trim().toLowerCase();
			if (idx === 0) return name;
			if (col === "ticket" || col === "tickets") return key;
			if (col === "status") return "found";
			return "";
		});
		const prefix = text && !/\r?\n$/.test(text) ? nl : "";
		nextText = `${text}${prefix}${csvRow(row, table.delimiter)}${nl}`;
	}
	await put(reg.path, nextText, true);
	setState("treeVersion", (v) => v + 1);
	notify(`Added “${name}” to ${reg.name} for ${key}.`);
	await openFile(reg.path);
}

/** Saves any dirty open editor buffers matching `target` (or inside `target` when it is a folder) before a filesystem move. Returns false if any save failed or was cancelled. */
async function saveDirtyUnder(targets: readonly string[]): Promise<boolean> {
	for (const [docPath] of documents) {
		if (!state.dirty[docPath]) continue;
		if (targets.some((t) => canonical(t) === docPath || isInside(canonical(t), docPath))) {
			const ok = await save(docPath);
			if (!ok || state.dirty[docPath]) return false;
		}
	}
	return true;
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
	const clearActiveIfMatching = async () => {
		if (file.ticket && state.settings.activeTicket?.trim().toLowerCase() === file.ticket.toLowerCase()) {
			await saveSetting({ activeTicket: null }, "workspace");
		}
	};
	const isLayout1 = Boolean(file.ticketFolder && isInside(file.ticketFolder, file.path));
	const isLayout2 = Boolean(file.ticketFolder && !isLayout1);
	if (!file.ticketFolder) {
		await (await import("./panels/Explorer")).trashFile(file.path);
		const stillExists = await backend.read(file.path).then(() => true, () => false);
		if (!stillExists) await clearActiveIfMatching();
		return;
	}
	const folder = file.ticketFolder;
	const relFolder = relativeTo(root(), folder).split("\\").join("/");
	const count = file.ticketFileCount ?? file.ticketFiles?.length ?? 0;
	const allDocs = docs();
	const isSelf = (p: string) => canonical(p) === canonical(file.path) || isInside(canonical(folder), canonical(p));
	const [incomingDoc, incomingFolder, allNames] = await Promise.all([
		backend.linksTo(file.path).catch(() => []),
		backend.linksTo(folder).catch(() => []),
		backend.namesIn().catch(() => []),
	]);
	const outsideRefs = new Set<string>();
	for (const l of [...incomingDoc, ...incomingFolder]) {
		if (!isCatalog({ name: l.path }) && !isSelf(l.path)) outsideRefs.add(canonical(l.path));
	}
	const nameIdx = buildDocNameIndex(allDocs, root());
	for (const n of allNames) {
		if (isSelf(n.path)) continue;
		const resolved = lookupInIndex(n.name, nameIdx);
		if (resolved && isSelf(resolved.path)) outsideRefs.add(canonical(n.path));
	}
	if (file.ticket) {
		for (const group of ticketWork(allDocs, file.ticket)) {
			for (const ref of group.files) {
				if (!isSelf(ref.path)) outsideRefs.add(canonical(ref.path));
			}
		}
	}
	const refNote = outsideRefs.size ? ` Warning: referenced by ${outsideRefs.size} other ${outsideRefs.size === 1 ? "document" : "documents"} (links, wikilinks, specs, plans, or registries).` : "";
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
			await clearActiveIfMatching();
			setState("treeVersion", (v) => v + 1);
			notify(`Moved ${isLayout2 ? `${baseName(file.path)} and ` : ""}${relFolder}/ to the trash.`);
		} else {
			await backend.trash(file.path);
			fileRemoved(file.path);
			await clearActiveIfMatching();
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

	if (!(await saveDirtyUnder(oldFolder ? [file.path, oldFolder] : [file.path]))) {
		notify(`Save unsaved edits in ${oldKey} first before renaming.`, "error");
		return;
	}

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

		// Follow incoming file path links & [[wikilinks]] atomically with all co-moved bundle paths so intra-bundle links stay intact.
		const coMoved = oldFolder && newFolder && canonical(oldFolder) !== canonical(newFolder) ? [{ from: oldFolder, to: newFolder }] : undefined;
		await followRename(file.path, toPath, beforeDocs, coMoved);

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
				const parsed = parsePlan(text);
				if (parsed.plan && typeof parsed.plan.ticket === "string" && parsed.plan.ticket.toLowerCase() === oldKey.toLowerCase()) {
					await put(docPath, printPlan({ ...parsed.plan, ticket: newKey }), true);
					refactored++;
				}
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
		if (state.settings.activeTicket?.trim().toLowerCase() === oldKey.toLowerCase()) {
			await saveSetting({ activeTicket: newKey }, "workspace");
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
		if (!(await saveDirtyUnder(fromSibling ? [fromPrimary, fromSibling] : [fromPrimary]))) {
			notify("Save unsaved edits before archiving this ticket.", "error");
			return;
		}
		if (picked === ARCHIVE_DONE) await setStatus(file.path, "done");
		await backend.rename(fromPrimary, toPrimary);
		fileRenamed(fromPrimary, toPrimary);
		if (fromSibling && toSibling) {
			try {
				await backend.rename(fromSibling, toSibling);
				fileRenamed(fromSibling, toSibling);
				retargetScopedFolder(fromSibling, toSibling);
			} catch (err) {
				// Roll back primary move so ticket & companion folder never split across archive/.
				await backend.rename(toPrimary, fromPrimary).catch(() => {});
				fileRenamed(toPrimary, fromPrimary);
				throw err;
			}
		} else if (isLayout1) {
			retargetScopedFolder(fromPrimary, toPrimary);
		}
		if (file.ticket && state.settings.activeTicket?.trim().toLowerCase() === file.ticket.toLowerCase()) {
			await saveSetting({ activeTicket: null }, "workspace");
		}
		setState("treeVersion", (v) => v + 1);
		const coMoved = fromSibling && toSibling ? [{ from: fromSibling, to: toSibling }] : undefined;
		await followRename(fromPrimary, toPrimary, beforeDocs, coMoved);
		notify(`Archived ${file.ticket ?? baseName(fromPrimary)} to ${relArchive}/.`);
	} catch (e: any) {
		setState("treeVersion", (v) => v + 1);
		notify(String(e?.message ?? e), "error");
	}
}

/** True when `file` lives inside the project's `<tickets>/archive/` folder. */
export function isArchivedTicket(file: Pick<DocFile, "path"> | null | undefined): boolean {
	if (!file || !state.workspace || !state.project) return false;
	const archiveDir = joinPath(areaFolder("tickets"), "archive");
	return isInside(archiveDir, file.path);
}

/** Moves an archived ticket (flat, Layout 1, or Layout 2 + sibling folder) cleanly back to `<tickets>/`. */
export async function unarchiveTicket(file: DocFile): Promise<void> {
	if (!ready()) return;
	const ticketsRoot = areaFolder("tickets");
	const archiveDir = joinPath(ticketsRoot, "archive");
	if (!isInside(archiveDir, file.path)) return notify(`${file.ticket ?? baseName(file.path)} is not in archive/.`);

	const isLayout1 = Boolean(file.ticketFolder && isInside(file.ticketFolder, file.path));
	const isLayout2 = Boolean(file.ticketFolder && !isLayout1);
	const fromPrimary = isLayout1 ? file.ticketFolder! : file.path;
	const toPrimary = joinPath(ticketsRoot, baseName(fromPrimary));
	const fromSibling = isLayout2 ? file.ticketFolder! : null;
	const toSibling = fromSibling ? joinPath(ticketsRoot, baseName(fromSibling)) : null;

	const relTickets = relativeTo(root(), ticketsRoot).split("\\").join("/");
	const activeEntries = await backend.list(ticketsRoot).catch(() => []);
	const existingNames = new Set(activeEntries.map((e) => e.name.toLowerCase()));
	if (existingNames.has(baseName(toPrimary).toLowerCase()) || (toSibling && existingNames.has(baseName(toSibling).toLowerCase()))) {
		notify(`Cannot unarchive: ${baseName(toPrimary)} already exists in ${relTickets}/.`, "error");
		return;
	}

	const RESTORE_ACTIVE = "Unarchive & set in progress";
	const RESTORE_KEEP = "Unarchive (keep status)";
	const picked = await choose(
		`Restore ${file.ticket ?? baseName(fromPrimary)} back to ${relTickets}/?`,
		toneOf(file.status) === "done" || toneOf(file.status) === "off" ? [RESTORE_ACTIVE, RESTORE_KEEP] : [RESTORE_KEEP],
	);
	if (!picked) return;
	const beforeDocs = await backend.docs();
	const { retargetScopedFolder } = await import("./panels/Explorer");
	try {
		if (!(await saveDirtyUnder(fromSibling ? [fromPrimary, fromSibling] : [fromPrimary]))) {
			notify("Save unsaved edits before unarchiving this ticket.", "error");
			return;
		}
		if (picked === RESTORE_ACTIVE) await setStatus(file.path, "in progress");
		await backend.rename(fromPrimary, toPrimary);
		fileRenamed(fromPrimary, toPrimary);
		if (fromSibling && toSibling) {
			try {
				await backend.rename(fromSibling, toSibling);
				fileRenamed(fromSibling, toSibling);
				retargetScopedFolder(fromSibling, toSibling);
			} catch (err) {
				await backend.rename(toPrimary, fromPrimary).catch(() => {});
				fileRenamed(toPrimary, fromPrimary);
				throw err;
			}
		} else if (isLayout1) {
			retargetScopedFolder(fromPrimary, toPrimary);
		}
		setState("treeVersion", (v) => v + 1);
		const coMoved = fromSibling && toSibling ? [{ from: fromSibling, to: toSibling }] : undefined;
		await followRename(fromPrimary, toPrimary, beforeDocs, coMoved);
		notify(`Restored ${file.ticket ?? baseName(fromPrimary)} to ${relTickets}/.`);
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

/** Saves a raw code snippet (e.g. from an Agent reply or Markdown code block) into `docs/knowledge/snippets/`. */
export async function saveAsSnippet(code: string, langHint?: string): Promise<string | null> {
	if (!ready()) return null;
	const cleanCode = code.replace(/\r\n/g, "\n").trim();
	if (!cleanCode) return null;
	const title = (await ask("What is this snippet for? (short title)"))?.trim();
	if (!title || !slug(title)) return null;
	const normLang = (langHint ?? "").trim().toLowerCase();
	let lang: "sql" | "ssl";
	if (normLang === "sql" || normLang === "tsql" || normLang === "plsql") lang = "sql";
	else if (normLang === "ssl") lang = "ssl";
	else {
		const picked = await choose("Save snippet as which language?", ["SSL", "SQL"]);
		if (!picked) return null;
		lang = picked === "SQL" ? "sql" : "ssl";
	}
	const folder = joinPath(areaFolder("knowledge"), "snippets");
	const ext = lang === "sql" ? "sql" : "ssl";
	const dest = joinPath(folder, `${slug(title)}.${ext}`);
	const header = snippetTemplate({ title, language: lang });
	await start(dest, `${header}\n${cleanCode}\n`, "knowledge");
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

/** Inspects an existing Markdown schema doc against parsed SQL tables to surface exact modified and dropped columns. */
function diffExistingSchemaColumns(
	existingMd: string,
	tables: readonly ReturnType<typeof parseCreateTables>[number][],
): { modified: string[]; dropped: string[] } {
	const lines = existingMd.split(/\r?\n/);
	const stripCell = (s: string) => s.trim().replace(/^`|`$/g, "").trim();
	const splitRow = (line: string): string[] => {
		const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
		const cells: string[] = [];
		let cur = "";
		for (let i = 0; i < trimmed.length; i++) {
			if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
				cur += "|";
				i++;
			} else if (trimmed[i] === "|") {
				cells.push(cur.trim());
				cur = "";
			} else cur += trimmed[i]!;
		}
		cells.push(cur.trim());
		return cells;
	};
	const modified: string[] = [];
	const dropped: string[] = [];

	for (const tbl of tables) {
		const target = tbl.tableName.toLowerCase();
		let startSearch = 0;
		let headLine = -1;
		for (let i = 0; i < lines.length; i++) {
			const hm = /^#{1,3}\s+`?([A-Za-z_][\w$.]*)`?\s*$/.exec(lines[i]!.trim());
			if (hm) {
				const hName = hm[1]!.toLowerCase();
				const bare = hName.includes(".") ? hName.split(".").pop()! : hName;
				if (hName === target || bare === target) {
					headLine = i;
					startSearch = i + 1;
					break;
				}
			}
		}
		if (headLine < 0 && tables.length > 1) continue;
		let tableStart = -1;
		let tableEnd = -1;
		for (let i = startSearch; i < lines.length; i++) {
			if (headLine >= 0 && /^#{1,2}\s+/.test(lines[i]!)) break;
			if (!lines[i]!.trim().startsWith("|")) continue;
			const hdr = splitRow(lines[i]!).map((c) => c.toLowerCase());
			if (!hdr[0]?.includes("column")) continue;
			if (i + 1 >= lines.length || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) continue;
			tableStart = i;
			tableEnd = i + 2;
			while (tableEnd < lines.length && lines[tableEnd]!.trim().startsWith("|")) tableEnd++;
			break;
		}
		if (tableStart < 0) continue;

		const sqlByCol = new Map(tbl.columns.map((c) => [c.name.toLowerCase(), c]));
		for (const raw of lines.slice(tableStart + 2, tableEnd)) {
			const cells = splitRow(raw);
			const colName = stripCell(cells[0] ?? "");
			if (!colName) continue;
			const sqlCol = sqlByCol.get(colName.toLowerCase());
			if (!sqlCol) {
				dropped.push(tables.length > 1 ? `${tbl.tableName}.${colName}` : colName);
			} else {
				const prevType = stripCell(cells[1] ?? "");
				const prevCons = (cells[2] ?? "").trim();
				const nextCons = (sqlCol.constraints || "—").replace(/\|/g, "\\|");
				if (prevType !== sqlCol.type || prevCons !== nextCons) {
					modified.push(tables.length > 1 ? `${tbl.tableName}.${colName}` : colName);
				}
			}
		}
	}
	return { modified, dropped };
}

/** Annotates dropped column rows in a Markdown schema table with `(dropped in SQL)` without deleting existing notes. */
function annotateDroppedSchemaColumns(markdown: string, droppedBareNames: readonly string[]): string {
	if (!droppedBareNames.length) return markdown;
	const droppedSet = new Set(droppedBareNames.map((n) => (n.includes(".") ? n.split(".").pop()! : n).toLowerCase()));
	const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
	return markdown
		.split(/\r?\n/)
		.map((line) => {
			if (!line.trim().startsWith("|")) return line;
			const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
			const parts = trimmed.split(/(?<!\\)\|/);
			if (parts.length < 4) return line;
			const col = parts[0]!.trim().replace(/^`|`$/g, "").trim().toLowerCase();
			if (!droppedSet.has(col)) return line;
			const lastIdx = parts.length - 1;
			const note = parts[lastIdx]!.trim();
			if (/dropped in sql/i.test(note)) return line;
			parts[lastIdx] = note ? ` ${note} (dropped in SQL) ` : " (dropped in SQL) ";
			return `|${parts.join("|")}|`;
		})
		.join(eol);
}

/** Formats non-table SQL objects (Views, Procedures, Functions, Triggers, Packages, Sequences, Synonyms, Types) as clean Markdown. */
function sqlNonTableObjectsToMarkdown(
	objects: readonly ReturnType<typeof extractSqlObjects>[number][],
	relSql: string,
	docTitle: string,
): string {
	const esc = (s: string) => s.replace(/\|/g, "\\|");
	const kindLabel = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
	const lines: string[] = [
		"---",
		`title: ${quoteYamlScalar(docTitle)}`,
		"status: draft",
		`source: ${quoteYamlScalar(relSql)}`,
		"---",
		"",
		`# ${docTitle}`,
		"",
		`Database objects defined in \`${relSql}\`.`,
		"",
		"| Object | Kind | Action | Notes |",
		"| --- | --- | --- | --- |",
	];
	for (const obj of objects) {
		lines.push(`| \`${esc(obj.name)}\` | ${kindLabel(obj.kind)} | ${obj.action === "alter" ? "ALTER" : "CREATE"} |  |`);
	}
	lines.push("");
	for (const obj of objects) {
		lines.push(`## ${obj.bareName}`, "");
		lines.push(`- **Object:** \`${obj.name}\` (${obj.kind})`);
		lines.push(`- **Source:** \`${relSql}\``);
		lines.push("");
	}
	return lines.join("\n").trimEnd() + "\n";
}

/**
 * Parses `CREATE TABLE` / `ALTER TABLE ADD` DDL (or Views, Stored Procedures, Functions, Triggers,
 * and Packages when no table DDL is present) from a schema SQL file and creates or non-destructively
 * updates a Markdown reference doc, clearly surfacing added, modified, and dropped columns.
 */
export async function generateSchemaDocFromSql(sqlPath?: string): Promise<void> {
	if (!ready()) return;
	let sourcePath = sqlPath;
	if (!sourcePath) {
		const sqlFiles = docs().filter((d) => d.exists && d.group === "schema" && /\.(sql|ddl|pks|pkb)$/i.test(d.name));
		if (!sqlFiles.length) return notify(`No SQL/DDL files found under ${state.project!.schema}/.`);
		const labels = sqlFiles.map((f) => f.name);
		const picked = await choose("Choose a SQL file to document database objects from", labels);
		if (!picked) return;
		sourcePath = sqlFiles.find((f) => f.name === picked)?.path;
	}
	if (!sourcePath) return;
	const sqlText = await current(sourcePath);
	if (sqlText === null) return notify("Could not read the SQL file.", "error");
	const tables = parseCreateTables(sqlText, { includeStandaloneAlter: true });
	const relSql = relativeTo(root(), sourcePath).split("\\").join("/");
	const schemaEntries = await backend.list(schemaFolder()).catch(() => []);
	const dbFolderEntry = schemaEntries.find((e) => e.kind === "dir" && e.name.toLowerCase() === "database");
	const existingDbDoc = docs().find((d) => d.exists && d.group === "schema" && d.kind === "database" && d.name.includes("/"));
	const dbSubfolder = dbFolderEntry?.name || existingDbDoc?.name.split(/[\\/]/)[0] || "database";

	// Handle Views, Stored Procedures, Functions, Triggers, Packages, Sequences, Synonyms, and Types when no CREATE TABLE exists.
	if (!tables.length) {
		const objects = extractSqlObjects(sqlText, { includeAlter: true }).filter((o) => o.kind !== "index");
		if (!objects.length) {
			return notify(`No CREATE/ALTER SQL objects (tables, views, procedures, functions, triggers, or packages) were found in ${baseName(sourcePath)}.`);
		}
		const defaultName = objects.length === 1 ? objects[0]!.bareName : baseName(sourcePath).replace(/\.[^.]+$/, "");
		const name = (await ask(`Schema document name (saved under ${state.project!.schema}/${dbSubfolder}/)`, defaultName))?.trim();
		if (!name) return;
		const named = typedParts(name, "file");
		if ("problem" in named || named.parts.length !== 1) return notify("Give a single valid filename.", "error");
		const dest = joinPath(schemaFolder(), dbSubfolder, `${named.parts[0]}.md`);
		const existingMd = await current(dest);
		if (existingMd !== null) {
			const missingObjs = objects.filter(
				(o) => !existingMd.toLowerCase().includes(o.bareName.toLowerCase()) && !existingMd.toLowerCase().includes(o.name.toLowerCase()),
			);
			let nextText = existingMd;
			if (!one(frontMatter(nextText).values.source)) {
				nextText = withFrontMatter(nextText, "source", relSql) ?? nextText;
			}
			if (missingObjs.length) {
				const eol = nextText.includes("\r\n") ? "\r\n" : "\n";
				const additions = missingObjs
					.map((o) => `## ${o.bareName}${eol}${eol}- **Object:** \`${o.name}\` (${o.kind})${eol}- **Source:** \`${relSql}\``)
					.join(`${eol}${eol}`);
				nextText = `${nextText.trimEnd()}${eol}${eol}${additions}${eol}`;
			}
			if (nextText === existingMd) {
				notify(`${baseName(dest)} already lists all ${objects.length} SQL ${objects.length === 1 ? "object" : "objects"} from ${baseName(sourcePath)}.`);
				await openFile(dest);
				return;
			}
			await put(dest, nextText, true);
			setState("treeVersion", (v) => v + 1);
			notify(`Updated ${baseName(dest)} with ${missingObjs.length} new SQL ${missingObjs.length === 1 ? "object" : "objects"} from ${baseName(sourcePath)}.`);
			await openFile(dest);
			return;
		}
		const docTitle = objects.length === 1 ? objects[0]!.bareName : name;
		await start(dest, sqlNonTableObjectsToMarkdown(objects, relSql, docTitle), "schema");
		return;
	}

	const defaultName = tables.length === 1 ? tables[0]!.tableName : baseName(sourcePath).replace(/\.[^.]+$/, "");
	const name = (await ask(`Table document name (saved under ${state.project!.schema}/${dbSubfolder}/)`, defaultName))?.trim();
	if (!name) return;
	const named = typedParts(name, "file");
	if ("problem" in named || named.parts.length !== 1) return notify("Give a single valid filename.", "error");
	const dest = joinPath(schemaFolder(), dbSubfolder, `${named.parts[0]}.md`);
	const existingMd = await current(dest);
	if (existingMd !== null) {
		const diff = diffExistingSchemaColumns(existingMd, tables);
		const merged = mergeSqlTablesIntoMarkdown(existingMd, tables, relSql);
		let nextText = merged.text;
		if (!one(frontMatter(nextText).values.source)) {
			nextText = withFrontMatter(nextText, "source", relSql) ?? nextText;
		}

		// Surface dropped & modified columns clearly so nothing is silently hidden or deleted (ADR 0002 / 0009).
		if (diff.dropped.length > 0) {
			const droppedPreview = diff.dropped.slice(0, 6).join(", ") + (diff.dropped.length > 6 ? `, +${diff.dropped.length - 6} more` : "");
			const modNote = diff.modified.length ? ` Modified: ${diff.modified.slice(0, 5).join(", ")}${diff.modified.length > 5 ? "…" : ""}.` : "";
			const MARK = "Mark dropped in Notes";
			const KEEP = "Keep existing rows as-is";
			const choice = await choose(
				`${diff.dropped.length} documented ${diff.dropped.length === 1 ? "column is" : "columns are"} no longer in ${baseName(sourcePath)}: ${droppedPreview}.${modNote} Existing rows are preserved — how should dropped columns be handled?`,
				[MARK, KEEP],
			);
			if (!choice) return;
			if (choice === MARK) nextText = annotateDroppedSchemaColumns(nextText, diff.dropped);
		}

		if (nextText === existingMd) {
			if (diff.dropped.length > 0) {
				notify(`${baseName(dest)} kept ${diff.dropped.length} dropped ${diff.dropped.length === 1 ? "column" : "columns"} (${diff.dropped.slice(0, 4).join(", ")}) for manual review.`);
			} else {
				notify(`${baseName(dest)} is already up to date with ${baseName(sourcePath)}.`);
			}
			await openFile(dest);
			return;
		}
		await put(dest, nextText, true);
		setState("treeVersion", (v) => v + 1);
		const parts = [
			merged.addedTables ? `${merged.addedTables} ${merged.addedTables === 1 ? "table" : "tables"} added` : "",
			merged.addedColumns ? `${merged.addedColumns} ${merged.addedColumns === 1 ? "column" : "columns"} added` : "",
			merged.updatedColumns
				? `${merged.updatedColumns} modified${diff.modified.length && diff.modified.length <= 4 ? ` (${diff.modified.join(", ")})` : ""}`
				: "",
			diff.dropped.length ? `${diff.dropped.length} dropped in SQL (${diff.dropped.slice(0, 4).join(", ")}${diff.dropped.length > 4 ? "…" : ""})` : "",
		].filter(Boolean);
		notify(`Synced ${baseName(dest)} from ${baseName(sourcePath)}${parts.length ? ` (${parts.join("; ")})` : ""}.`);
		await openFile(dest);
		return;
	}
	const docTitle = tables.length === 1 ? tables[0]!.tableName : name;
	const mdBody = [
		"---",
		`title: ${quoteYamlScalar(docTitle)}`,
		`status: draft`,
		`source: ${quoteYamlScalar(relSql)}`,
		"---",
		"",
		`# ${docTitle}`,
		"",
		sqlTablesToMarkdown(tables, relSql).trimEnd(),
		"",
	].join("\n");
	await start(dest, mdBody, "schema");
}

/** Rewrites relative Markdown image paths from `srcDocPath` so they stay valid when embedded inside a packet rendered relative to `baseDocPath`. */
function rewriteRelativeImagesForBase(md: string, srcDocPath: string, baseDocPath: string): string {
	if (canonical(dirName(srcDocPath)) === canonical(dirName(baseDocPath))) return md;
	const srcDir = dirName(srcDocPath);
	const baseDir = dirName(baseDocPath);
	return md.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (full, alt: string, url: string, title?: string) => {
		if (!url || /^(?:https?:|data:|\/)/i.test(url)) return full;
		const decoded = linkFile(url);
		const resolved = resolvePath(srcDir, decoded);
		const rel = linkWritten(relativePath(baseDir, resolved).split("\\").join("/"), url);
		return `![${alt}](${rel}${title ?? ""})`;
	});
}

/** Rewrites BOTH relative images AND relative Markdown/file links from `srcDocPath` to stay valid relative to `baseDocPath`. */
function rewriteRelativeLinksForBase(md: string, srcDocPath: string, baseDocPath: string): string {
	if (canonical(dirName(srcDocPath)) === canonical(dirName(baseDocPath))) return md;
	const srcDir = dirName(srcDocPath);
	const baseDir = dirName(baseDocPath);
	return md.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (full, bang: string, label: string, url: string, title?: string) => {
		if (!url || /^(?:https?:|mailto:|data:|#|\/)/i.test(url)) return full;
		const hashIdx = url.indexOf("#");
		const filePart = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
		const fragPart = hashIdx >= 0 ? url.slice(hashIdx) : "";
		if (!filePart) return full;
		const decoded = linkFile(filePart);
		const resolved = resolvePath(srcDir, decoded);
		const rel = linkWritten(relativePath(baseDir, resolved).split("\\").join("/"), filePart);
		return `${bang}[${label}](${rel}${fragPart}${title ?? ""})`;
	});
}

const EMBED_IMAGE_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

/** Extracts a single ATX heading section (including subheadings) from a Markdown body. */
function extractMarkdownSection(body: string, headingQuery: string): string | null {
	const lineNum = findHeadingLine(body, headingQuery);
	if (!lineNum) return null;
	const lines = body.split(/\r?\n/);
	const startIdx = lineNum - 1;
	const headMatch = /^[ \t]{0,3}(#{1,6})[ \t]+/.exec(lines[startIdx] ?? "");
	if (!headMatch) return null;
	const level = headMatch[1]!.length;
	const out: string[] = [lines[startIdx]!];
	let fenceChar = "";
	let fenceLen = 0;
	for (let i = startIdx + 1; i < lines.length; i++) {
		const ln = lines[i]!;
		const fm = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(ln);
		if (fm) {
			if (!fenceChar) {
				fenceChar = fm[1]![0]!;
				fenceLen = fm[1]!.length;
			} else if (fm[1]![0] === fenceChar && fm[1]!.length >= fenceLen && /^[ \t]*$/.test(ln.slice(fm[0].length))) {
				fenceChar = "";
				fenceLen = 0;
			}
			out.push(ln);
			continue;
		}
		if (!fenceChar) {
			const hm = /^[ \t]{0,3}(#{1,6})[ \t]+/.exec(ln);
			if (hm && hm[1]!.length <= level) break;
		}
		out.push(ln);
	}
	return out.join("\n").trim();
}

/** Wraps an embedded workspace code/SQL file in a backtick fence safe against inner backticks. */
function fenceEmbeddedCode(text: string, filePath: string): string {
	const ext = baseName(filePath).split(".").pop()?.toLowerCase() ?? "";
	const lang =
		ext === "sql" || ext === "ddl" || ext === "pks" || ext === "pkb" || ext === "ds"
			? "sql"
			: ext === "ssl" || ext === "srvscr"
				? "ssl"
				: ext === "xfd" || ext === "xml"
					? "xml"
					: ext === "json" || ext === "jsonc"
						? "json"
						: ext === "ts" || ext === "tsx"
							? "ts"
							: ext === "js" || ext === "jsx"
								? "js"
								: ext === "css"
									? "css"
									: ext === "html" || ext === "htm"
										? "html"
										: ext === "yaml" || ext === "yml"
											? "yaml"
											: ext === "toml"
												? "toml"
												: ext === "csv" || ext === "tsv"
													? "csv"
													: "";
	const clean = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
	let maxTicks = 2;
	for (const m of clean.matchAll(/`+/g)) {
		if (m[0].length > maxTicks) maxTicks = m[0].length;
	}
	const fence = "`".repeat(maxTicks + 1);
	return `${fence}${lang}\n${clean}\n${fence}`;
}

/**
 * Cycle-guarded pre-export transclusion expander (depth limit 2) resolving
 * `![[note]]`, `![[note#Heading]]`, and workspace file embeds like `![[path/file.sql]]`
 * outside fenced code blocks. Image embeds (`![[diagram.png]]`) are preserved as-is.
 */
async function expandTransclusionsForExport(
	markdown: string,
	docPath: string,
	depth = 0,
	visited?: Set<string>,
): Promise<string> {
	const MAX_DEPTH = 2;
	if (depth >= MAX_DEPTH || !markdown.includes("![[")) return markdown;
	const seen = visited ?? new Set<string>([canonical(docPath)]);
	const fmCut = bodyOffset(markdown);
	const head = markdown.slice(0, fmCut);
	const body = markdown.slice(fmCut).replace(/\r\n/g, "\n");
	const allDocs = docs();
	const wsRoot = state.workspace?.root ?? "";
	const nameIdx = buildDocNameIndex(allDocs, wsRoot);
	const lines = body.split("\n");
	const out: string[] = [];
	let fenceChar = "";
	let fenceLen = 0;
	let currentHeadingLevel = 1;

	for (const line of lines) {
		const fm = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
		if (fm) {
			if (!fenceChar) {
				fenceChar = fm[1]![0]!;
				fenceLen = fm[1]!.length;
			} else if (fm[1]![0] === fenceChar && fm[1]!.length >= fenceLen && /^[ \t]*$/.test(line.slice(fm[0].length))) {
				fenceChar = "";
				fenceLen = 0;
			}
			out.push(line);
			continue;
		}
		if (fenceChar) {
			out.push(line);
			continue;
		}
		const hm = /^[ \t]{0,3}(#{1,6})[ \t]+/.exec(line);
		if (hm) currentHeadingLevel = hm[1]!.length;

		const em = /^[ \t]*!\[\[([^[\]\n]+)\]\][ \t]*$/.exec(line);
		if (!em) {
			out.push(line);
			continue;
		}
		const parsed = namedLink(em[1]!.replace(/\\\|/g, "|"));
		if (!parsed || EMBED_IMAGE_RE.test(parsed.name)) {
			out.push(line);
			continue;
		}

		// Resolve target either as a known project doc or as a workspace file path.
		let targetPath: string | null = null;
		const docMatch = lookupInIndex(parsed.name, nameIdx);
		if (docMatch) {
			targetPath = docMatch.path;
		} else if (wsRoot) {
			const cleaned = parsed.name.replace(/\\/g, "/").trim();
			const candidates = [
				resolvePath(dirName(docPath), cleaned),
				resolvePath(wsRoot, cleaned.replace(/^\/+/, "")),
			];
			for (const cand of candidates) {
				if (!isInside(wsRoot, cand)) continue;
				const probe = await current(cand);
				if (probe !== null) {
					targetPath = cand;
					break;
				}
			}
		}
		if (!targetPath) {
			out.push(line);
			continue;
		}
		const canonTarget = canonical(targetPath);
		if (seen.has(canonTarget)) {
			// Cycle guard: keep a quiet note instead of recursing infinitely.
			out.push(line);
			continue;
		}
		const targetText = await current(targetPath);
		if (targetText === null) {
			out.push(line);
			continue;
		}
		if (isMarkdown(targetPath)) {
			const targetBody = frontMatter(targetText).body.replace(/\r\n/g, "\n").trim();
			const sliced = parsed.heading ? extractMarkdownSection(targetBody, parsed.heading) : targetBody;
			if (!sliced) {
				out.push(line);
				continue;
			}
			const nextSeen = new Set(seen);
			nextSeen.add(canonTarget);
			const nested = await expandTransclusionsForExport(sliced, targetPath, depth + 1, nextSeen);
			const rebased = rewriteRelativeImagesForBase(nested, targetPath, docPath);
			const demoted = demoteMarkdownHeadings(rebased, Math.min(6, Math.max(2, currentHeadingLevel + 1))).trim();
			out.push(demoted);
		} else {
			out.push(fenceEmbeddedCode(targetText, targetPath));
		}
	}

	return head + out.join("\n");
}

/** Converts an ArrayBuffer to a base64 string in chunked slices safe against call-stack limits. */
function bytesToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * Finds fenced `mermaid` / `mmd` blocks outside outer fences and rasterizes each to a light-mode
 * 2x PNG base64 string for `.docx` embedding. Safely skips any block that fails or taints canvas.
 */
async function rasterizeMermaidPngsForDocx(markdown: string): Promise<Record<string, string>> {
	if (typeof document === "undefined" || !/```|~~~/.test(markdown)) return {};
	const body = frontMatter(markdown).body.replace(/\r\n/g, "\n");
	const lines = body.split("\n");
	const sources: string[] = [];
	let outerFence: { ch: string; len: number } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (outerFence) {
			if (new RegExp(`^[ \\t]{0,3}${outerFence.ch}{${outerFence.len},}[ \\t]*$`).test(line)) outerFence = null;
			continue;
		}
		const fenceOpen = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)(?:[ \t]+.*)?$/.exec(line);
		if (fenceOpen && !(fenceOpen[1]![0] === "`" && line.slice(line.indexOf(fenceOpen[1]!) + fenceOpen[1]!.length).includes("`"))) {
			const delim = fenceOpen[1]![0]!;
			const len = fenceOpen[1]!.length;
			const lang = fenceOpen[2]!.toLowerCase();
			if (lang === "mermaid" || lang === "mmd") {
				const closeRe = new RegExp(`^[ \\t]{0,3}${delim}{${len},}[ \\t]*$`);
				const block: string[] = [];
				let j = i + 1;
				while (j < lines.length && !closeRe.test(lines[j]!)) {
					block.push(lines[j]!);
					j++;
				}
				const code = block.join("\n").trim();
				if (code) sources.push(code);
				i = j;
				continue;
			}
			outerFence = { ch: delim, len };
		}
	}
	if (!sources.length) return {};

	const out: Record<string, string> = {};
	try {
		const { renderMermaidSvgForExport, mermaidSvgToPngBlob } = await import("./editor/cmMermaid");
		for (let idx = 0; idx < sources.length; idx++) {
			const code = sources[idx]!;
			try {
				const svg = await renderMermaidSvgForExport(code, "light");
				if (!svg) continue;
				const blob = await mermaidSvgToPngBlob(svg, "light");
				if (!blob) continue;
				const b64 = bytesToBase64(await blob.arrayBuffer());
				if (b64) {
					out[code] = b64;
					out[`mermaid-${idx}`] = b64;
				}
			} catch {
				// Canvas taint or render error: gracefully fall back to code box in docx.ts.
			}
		}
	} catch {
		// Mermaid unavailable in headless environment.
	}
	return out;
}

async function renderCleanHtmlForExport(
	markdown: string,
	docPath: string,
	options?: { bundledAnchors?: ReadonlyMap<string, string>; exportDestPath?: string },
): Promise<string> {
	const expanded = await expandTransclusionsForExport(markdown, docPath);
	const rawBody = transformMarkdownFootnotes(frontMatter(expanded).body.replace(/\r\n/g, "\n"), "html");
	if (rawBody.includes("$")) await loadKatex().catch(() => {});
	// 1. Pre-render fenced ```mermaid / ```mmd blocks (respecting outer fence nesting) & convert ![[image.png]] embeds.
	const { renderMermaidSvgForExport } = await import("./editor/cmMermaid");
	const mermaidSvgs: string[] = [];
	const lines = rawBody.split("\n");
	const rebuilt: string[] = [];
	let outerFence: { ch: string; len: number } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (outerFence) {
			if (new RegExp(`^[ \\t]{0,3}${outerFence.ch}{${outerFence.len},}[ \\t]*$`).test(line)) outerFence = null;
			rebuilt.push(line);
			continue;
		}
		const fenceOpen = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)(?:[ \t]+.*)?$/.exec(line);
		if (fenceOpen && !(fenceOpen[1]![0] === "`" && line.slice(line.indexOf(fenceOpen[1]!) + fenceOpen[1]!.length).includes("`"))) {
			const delim = fenceOpen[1]![0]!;
			const len = fenceOpen[1]!.length;
			const lang = fenceOpen[2]!.toLowerCase();
			if (lang === "mermaid" || lang === "mmd") {
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
			outerFence = { ch: delim, len };
			rebuilt.push(line);
			continue;
		}
		// Convert Obsidian image embeds `![[diagram.png|400]]` into standard Markdown images so marked + base64 inliner render them cleanly.
		const withWikiImgs = line.replace(
			/!\[\[([^[\]|#]+\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif))(?:\|([^[\]]*))?\]\]/gi,
			(_, imgPath: string, altOrSize?: string) => `![${altOrSize?.trim() || baseName(imgPath)}](${linkWritten(imgPath.trim())})`,
		);
		rebuilt.push(withWikiImgs);
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
	const finished = finishMarkdown(clean, { tickets, named, anchors: true });

	// 2. Transform DOM in a detached container: normalize callout icons (no PUA tofu boxes), ==highlight==, image sizing, inline base64 images, and Mermaid SVGs.
	if (typeof document === "undefined") return finished;
	const box = document.createElement("div");
	box.innerHTML = finished;

	// Replace Codicon Private Use Area glyphs inside `.md-callout-icon` with crisp inline SVG icons for offline HTML & PDF export.
	const svgIcon = (path: string) =>
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true" style="vertical-align:-2px">${path}</svg>`;
	const CALLOUT_SVG = {
		warn: svgIcon('<path d="M7.56 1.97a.5.5 0 0 1 .88 0l6.4 11.78a.5.5 0 0 1-.44.75H1.6a.5.5 0 0 1-.44-.75L7.56 1.97zM7.25 6v4h1.5V6h-1.5zm0 5.25v1.5h1.5v-1.5h-1.5z"/>'),
		danger: svgIcon('<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm2.6 4.96L9.06 8l1.54 1.54-1.06 1.06L8 9.06 6.46 10.6 5.4 9.54 6.94 8 5.4 6.46 6.46 5.4 8 6.94 9.54 5.4l1.06 1.06z"/>'),
		done: svgIcon('<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm3.28 5.03-3.9 4.12a.75.75 0 0 1-1.08.02L4.72 9.1l1.06-1.06 1.04 1.04 3.38-3.57 1.08 1.02z"/>'),
		important: svgIcon('<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm-.75 3h1.5v4.5h-1.5V4.5zm0 6h1.5v1.5h-1.5v-1.5z"/>'),
		quote: svgIcon('<path d="M3 4h4v4.5c0 2-1.2 3.3-3.2 3.8l-.4-1.3c1.2-.3 1.9-1.1 2-2.2H3V4zm6 0h4v4.5c0 2-1.2 3.3-3.2 3.8l-.4-1.3c1.2-.3 1.9-1.1 2-2.2H9V4z"/>'),
		info: svgIcon('<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm-.75 3.25h1.5v1.5h-1.5v-1.5zm0 2.75h1.5v4.25h-1.5V7.5z"/>'),
	};
	for (const callout of box.querySelectorAll<HTMLElement>(".md-callout")) {
		const iconEl = callout.querySelector<HTMLElement>(".md-callout-icon");
		if (!iconEl) continue;
		const cls = callout.className;
		if (/\btone-(?:warning|warn)\b/.test(cls)) iconEl.innerHTML = CALLOUT_SVG.warn;
		else if (/\btone-(?:danger|error)\b/.test(cls)) iconEl.innerHTML = CALLOUT_SVG.danger;
		else if (/\btone-(?:ok|tip|success|done)\b/.test(cls)) iconEl.innerHTML = CALLOUT_SVG.done;
		else if (/\btone-(?:accent|important)\b/.test(cls)) iconEl.innerHTML = CALLOUT_SVG.important;
		else if (/\btone-(?:quote|muted)\b/.test(cls)) iconEl.innerHTML = CALLOUT_SVG.quote;
		else iconEl.innerHTML = CALLOUT_SVG.info;
	}

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

	// Rewrite intra-packet doc links to `#section-slug` anchors and rebase relative workspace `.md`/file links when exported to another folder.
	if (options?.bundledAnchors?.size || options?.exportDestPath) {
		const existingIds = new Set(Array.from(box.querySelectorAll<HTMLElement>("[id]")).map((el) => el.id));
		const srcDir = dirName(docPath);
		const destDir = options.exportDestPath ? dirName(options.exportDestPath) : "";
		for (const anchor of box.querySelectorAll<HTMLAnchorElement>("a[href]")) {
			const rawHref = anchor.getAttribute("href")?.trim() ?? "";
			if (!rawHref || rawHref.startsWith("#") || /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(rawHref)) continue;
			const hashIdx = rawHref.indexOf("#");
			const filePart = hashIdx >= 0 ? rawHref.slice(0, hashIdx) : rawHref;
			const fragPart = hashIdx >= 0 ? rawHref.slice(hashIdx + 1) : "";
			if (!filePart) continue;
			const decoded = linkFile(filePart);
			const resolved = decoded.startsWith("/") && wsRoot ? resolvePath(wsRoot, decoded.slice(1)) : resolvePath(srcDir, decoded);
			const targetCanon = canonical(resolved);
			const bundledSlug = options.bundledAnchors?.get(targetCanon);
			if (bundledSlug) {
				const targetFrag = fragPart && existingIds.has(fragPart) ? fragPart : bundledSlug;
				anchor.setAttribute("href", `#${targetFrag}`);
				continue;
			}
			if (destDir && wsRoot && isInside(wsRoot, resolved)) {
				const rebased = linkWritten(relativePath(destDir, resolved).split("\\").join("/"), filePart);
				anchor.setAttribute("href", fragPart ? `${rebased}#${fragPart}` : rebased);
			}
		}
	}

	// Apply Obsidian image sizing (`![alt|400]`, `![alt|400x250]`) & inline local workspace images as data URLs.
	const { loadImageUrl } = await import("./editor/imageResolve");
	const imgs = Array.from(box.querySelectorAll<HTMLImageElement>("img"));
	for (const img of imgs) {
		const rawAlt = img.getAttribute("alt") ?? "";
		const parsedAlt = parseImageAltSize(rawAlt);
		img.setAttribute("alt", parsedAlt.alt);
		if (parsedAlt.width) img.style.width = `${parsedAlt.width}px`;
		if (parsedAlt.height) img.style.height = `${parsedAlt.height}px`;
		const rawSrc = img.getAttribute("src")?.trim() ?? "";
		if (!rawSrc || /^https?:\/\//i.test(rawSrc) || /^data:/i.test(rawSrc)) continue;
		const loaded = await loadImageUrl(linkFile(rawSrc), docPath);
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
async function saveExportFile(
	defaultRelPath: string,
	filename: string,
	content: string | ((destPath: string) => string | Promise<string>),
	mime: string,
): Promise<boolean> {
	const { inApp } = await import("./backend");
	if (inApp && state.workspace?.root) {
		const picked = (await ask("Save export to (path in workspace)", defaultRelPath))?.trim();
		if (!picked) return false;
		const cleanRel = picked.replace(/\\/g, "/").replace(/^\/+/, "");
		const dest = resolvePath(state.workspace.root, cleanRel);
		if (!isInside(state.workspace.root, dest)) {
			notify("Export path must stay inside the workspace.", "error");
			return false;
		}
		try {
			const exists = await backend.read(dest).then(() => true, () => false);
			if (exists) {
				const OVERWRITE = "Overwrite file";
				if ((await choose(`${relativeTo(state.workspace.root, dest)} already exists. Overwrite it?`, [OVERWRITE], { danger: OVERWRITE })) !== OVERWRITE) {
					return false;
				}
			} else {
				await backend.create(dest, "file");
			}
			const payload = typeof content === "function" ? await content(dest) : content;
			await put(dest, payload, true);
			setState("treeVersion", (v) => v + 1);
			notify(`Saved export to ${relativeTo(state.workspace.root, dest)}.`);
			return true;
		} catch (e: any) {
			notify(`Could not save export: ${e?.message ?? e}`, "error");
			return false;
		}
	}
	const fallbackDest = state.workspace?.root ? resolvePath(state.workspace.root, defaultRelPath) : defaultRelPath;
	const payload = typeof content === "function" ? await content(fallbackDest) : content;
	downloadBlobFile(filename, payload, mime);
	notify(`Exported ${filename}.`);
	return true;
}

/** Saves an OpenXML `.docx` document generated by the backend inside the workspace (embedding local images, Mermaid PNGs, hyperlinks, footnotes & metadata). */
async function saveDocxExport(
	defaultRelPath: string,
	title: string,
	subtitle: string | undefined,
	markdown: string,
	options?: { baseDir?: string; meta?: Record<string, string> },
): Promise<boolean> {
	if (!state.workspace?.root) {
		notify("Open a workspace folder before exporting to Word (.docx).", "error");
		return false;
	}
	const picked = (await ask("Save Word document to (path in workspace)", defaultRelPath))?.trim();
	if (!picked) return false;
	const cleanRel = picked.replace(/\\/g, "/").replace(/^\/+/, "");
	const withExt = /\.docx$/i.test(cleanRel) ? cleanRel : `${cleanRel}.docx`;
	const dest = resolvePath(state.workspace.root, withExt);
	if (!isInside(state.workspace.root, dest)) {
		notify("Export path must stay inside the workspace.", "error");
		return false;
	}
	try {
		const sizes = await backend.sizes([dest]).catch(() => ({} as Record<string, number>));
		if (dest in sizes) {
			const OVERWRITE = "Overwrite file";
			if ((await choose(`${relativeTo(state.workspace.root, dest)} already exists. Overwrite it?`, [OVERWRITE], { danger: OVERWRITE })) !== OVERWRITE) {
				return false;
			}
		}
		const meta = options?.meta ?? extractExportMeta(markdown);
		const mermaidPngs = await rasterizeMermaidPngsForDocx(markdown);
		const res = await backend.exportDocx({
			path: dest,
			title,
			subtitle,
			markdown,
			...(options?.baseDir ? { baseDir: options.baseDir } : {}),
			...(Object.keys(meta).length ? { meta } : {}),
			...(Object.keys(mermaidPngs).length ? { mermaidPngs } : {}),
		});
		setState("treeVersion", (v) => v + 1);
		notify(`Saved Word document to ${relativeTo(state.workspace.root, res.path)}.`, "info", {
			label: "Open externally",
			run: () => void backend.openExternal(res.path),
		});
		return true;
	} catch (e: any) {
		notify(`Could not export Word document: ${e?.message ?? e}`, "error");
		return false;
	}
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

/** Copies or exports a Markdown document as rich HTML, Jira/Confluence wiki markup, standalone HTML, Print/PDF, or Word (.docx). */
export async function exportDocAs(
	path: string,
	format: "html-copy" | "jira-copy" | "html-download" | "print" | "docx",
): Promise<void> {
	const text = await current(path);
	if (text === null) return notify("Could not read the document.", "error");
	const fm = frontMatter(text);
	const title = one(fm.values.title) || baseName(path).replace(/\.(md|markdown)$/i, "");
	const stem = baseName(path).replace(/\.(md|markdown)$/i, "");
	const subtitle = state.project?.name ? `${state.project.name} · Exported ${today()}` : `Exported ${today()}`;
	const meta = extractExportMeta(text);
	const metaHtml = renderFrontMatterSummaryHtml(meta);

	if (format === "jira-copy") {
		const expanded = await expandTransclusionsForExport(text, path);
		const withFootnotes = transformMarkdownFootnotes(frontMatter(expanded).body, "jira");
		const jira = markdownToJira(withFootnotes);
		const { copyText } = await import("./commands");
		await copyText(jira, "Copied Jira / Confluence markup.");
		return;
	}

	if (format === "docx") {
		const expanded = await expandTransclusionsForExport(text, path);
		const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");
		await saveDocxExport(`${docsRel}/exports/${stem}.docx`, title, subtitle, expanded, {
			baseDir: dirName(path),
			meta,
		});
		return;
	}

	if (format === "html-download") {
		const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");
		await saveExportFile(
			`${docsRel}/exports/${stem}.html`,
			`${stem}.html`,
			async (destPath) => {
				const bodyHtml = await renderCleanHtmlForExport(text, path, { exportDestPath: destPath });
				return buildPrintableHtml(title, bodyHtml, subtitle, metaHtml);
			},
			"text/html;charset=utf-8",
		);
		return;
	}

	const bodyHtml = await renderCleanHtmlForExport(text, path);

	if (format === "html-copy") {
		const styledHtml = inlineExportStyles(bodyHtml);
		const plainText = fm.body.trim();
		try {
			if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
				await navigator.clipboard.write([
					new ClipboardItem({
						"text/html": new Blob([styledHtml], { type: "text/html" }),
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
		await copyText(styledHtml, "Copied HTML to clipboard.");
		return;
	}

	const fullHtml = buildPrintableHtml(title, bodyHtml, subtitle, metaHtml);
	printHtmlDocument(fullHtml);
}

/** Assembles and exports a complete Ticket Release Packet (HTML, Markdown, or Word .docx) rolling up recursive descendants, tests, governance metadata, & Readiness Gate. */
export async function exportTicketPacket(ticketPath: string, key: string, format: "html" | "markdown" | "docx"): Promise<void> {
	if (!ready()) return;
	const ticketText = await current(ticketPath);
	if (ticketText === null) return notify("Could not read the ticket.", "error");
	const allDocs = docs();
	const ticketDoc = allDocs.find((d) => canonical(d.path) === canonical(ticketPath));
	const allDescendants = descendantTickets(allDocs, key);
	const activeDescendants = allDescendants.filter((s) => toneOf(s.status) !== "off");
	const scopeDocs = [ticketDoc, ...activeDescendants].filter((d): d is DocFile => Boolean(d));
	const scopeKeys = [key, ...activeDescendants.map((d) => d.ticket).filter((k): k is string => Boolean(k))];
	const scopeKeySet = new Set(scopeKeys.map((k) => k.toLowerCase()));
	const allGroups = scopeKeys.flatMap((k) => ticketWork(allDocs, k));

	const dedupeDocs = (list: DocFile[]) => {
		const seen = new Set<string>();
		const out: DocFile[] = [];
		for (const d of list) {
			const c = canonical(d.path);
			if (!seen.has(c)) {
				seen.add(c);
				out.push(d);
			}
		}
		return out;
	};

	const bundledAnchors = new Map<string, string>();
	bundledAnchors.set(canonical(ticketPath), headingAnchor(`${key}: ${ticketDoc?.title || key}`));

	const readGroup = async (kind: string) => {
		const files = dedupeDocs(allGroups.filter((g) => g.kind === kind).flatMap((g) => g.files));
		const out: { title: string; status?: string; body: string }[] = [];
		for (const f of files) {
			const rawTxt = (await current(f.path)) ?? "";
			const expanded = await expandTransclusionsForExport(rawTxt, f.path);
			const title = f.title || f.name;
			const sectionHeading = `${title}${f.status ? ` (${f.status})` : ""}`;
			bundledAnchors.set(canonical(f.path), headingAnchor(sectionHeading));
			out.push({ title, status: f.status, body: rewriteRelativeLinksForBase(expanded, f.path, ticketPath) });
		}
		return out;
	};

	const expandedTicketText = await expandTransclusionsForExport(ticketText, ticketPath);
	const specs = await readGroup("spec");
	const decisions = await readGroup("decision");
	const questions = [...(await readGroup("answer")), ...(await readGroup("question"))];
	const references = await readGroup("reference");
	const schemas = await readGroup("schema");
	const subtickets = allDescendants.map((t) => ({
		key: t.ticket ?? t.name,
		title: t.title || t.name,
		status: t.status,
	}));
	const related = dedupeDocs(allGroups.filter((g) => g.kind === "ticket").flatMap((g) => g.files))
		.filter((t) => !scopeKeySet.has((t.ticket ?? "").toLowerCase()))
		.map((t) => ({
			key: t.ticket ?? t.name,
			title: t.title || t.name,
			status: t.status,
		}));
	const planDocs = dedupeDocs(allGroups.filter((g) => g.kind === "plan").flatMap((g) => g.files));
	const plans = planDocs.map((p) => ({
		name: p.name,
		title: p.heading || p.title,
		status: p.status,
		scripts: p.codeRefs,
		testScripts: p.testScripts,
		planTests: p.planTests,
	}));

	const testScripts = [
		...new Set(
			[...scopeDocs, ...planDocs, ...dedupeDocs(allGroups.filter((g) => g.kind === "spec").flatMap((g) => g.files))]
				.flatMap((d) => d.testScripts ?? [])
				.map((s) => s.trim())
				.filter(Boolean),
		),
	];

	const registries: { title: string; headers: string[]; rows: string[][] }[] = [];
	const regDocs = dedupeDocs(allGroups.filter((g) => g.kind === "registry").flatMap((g) => g.files));
	for (const reg of regDocs) {
		const csvText = await current(reg.path);
		if (!csvText) continue;
		const parsed = parseCsv(csvText);
		const tCol = ticketColumn(parsed);
		if (tCol < 0) continue;
		const matched = parsed.rows
			.filter((cells) => keysIn(cells[tCol]?.text ?? "", scopeKeySet).some((k) => scopeKeySet.has(k.toLowerCase())))
			.map((cells) => parsed.header.map((_, i) => cells[i]?.text ?? ""));
		if (matched.length) {
			registries.push({
				title: registryTitle(reg.name),
				headers: parsed.header.map((c) => c.text.trim()),
				rows: matched,
			});
		}
	}

	// Collect ticket folder artifacts across ticket + descendants.
	const ticketFiles: { rel: string }[] = [];
	let totalTicketFiles = 0;
	for (const sd of scopeDocs) {
		const prefix = sd !== ticketDoc && sd.ticket ? `${sd.ticket}/` : "";
		for (const tf of sd.ticketFiles ?? []) ticketFiles.push({ rel: `${prefix}${tf.rel}` });
		totalTicketFiles += Math.max(sd.ticketFiles?.length ?? 0, sd.ticketFileCount ?? 0);
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
		release: ticketDoc?.release,
		priority: ticketDoc?.priority,
		version: ticketDoc?.version,
		owner: ticketDoc?.owner,
		reviewer: ticketDoc?.reviewer,
		approvedBy: ticketDoc?.approvedBy,
		approvedDate: ticketDoc?.approvedDate,
		changeControl: ticketDoc?.changeControl,
		gxpImpact: ticketDoc?.gxpImpact,
		ticketBody: expandedTicketText,
		specs,
		plans,
		testScripts,
		subtickets,
		related,
		decisions,
		questions,
		references,
		schemas,
		registries,
		ticketFiles,
		totalTicketFiles,
		readiness,
	});

	const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");
	const exportDir = ticketDoc?.ticketFolder
		? `${relativeTo(root(), ticketDoc.ticketFolder).split("\\").join("/")}/exports`
		: `${docsRel}/exports`;

	if (format === "markdown") {
		await saveExportFile(
			`${exportDir}/${key}-release-packet.md`,
			`${key}-release-packet.md`,
			(outPath) => rewriteRelativeLinksForBase(packetMd, ticketPath, outPath),
			"text/markdown;charset=utf-8",
		);
		return;
	}

	if (format === "docx") {
		const subtitle = state.project?.name ? `${state.project.name} · Generated ${today()}` : `Generated ${today()}`;
		await saveDocxExport(`${exportDir}/${key}-release-packet.docx`, `${key}: ${ticketDoc?.title || key} — Release Packet`, subtitle, packetMd, {
			baseDir: dirName(ticketPath),
		});
		return;
	}

	await saveExportFile(
		`${exportDir}/${key}-release-packet.html`,
		`${key}-release-packet.html`,
		async (destPath) => {
			const bodyHtml = await renderCleanHtmlForExport(packetMd, ticketPath, {
				bundledAnchors,
				exportDestPath: destPath,
			});
			return buildPrintableHtml(`${key}: ${ticketDoc?.title || key} — Release Packet`, bodyHtml);
		},
		"text/html;charset=utf-8",
	);
}

/** Extracts any `## Rollback` / `## Backout` / `## Revert` section from a Markdown document. */
function extractRollbackSection(md: string): string {
	const m = /^#{1,6}\s+[^\n]*(?:rollback|backout|back-out|revert)[^\n]*$\r?\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(frontMatter(md).body);
	return m?.[1]?.trim() ?? "";
}

/**
 * Exports a STARLIMS Deployment / Transport Manifest (Markdown, CSV, HTML, or Word .docx)
 * aggregating the ticket + all recursive descendant tickets: SSL scripts & data sources,
 * test scripts & plan test cases, SQL/DDL artifacts, SHA-256 checksums, local Git HEAD & commits,
 * affected CSV registry rows, readiness gate, rollback notes across all descendants & specs, and DEV->PROD sign-off.
 */
export async function exportDeploymentManifest(
	ticketPath: string,
	key: string,
	format: "markdown" | "csv" | "html" | "docx",
): Promise<void> {
	if (!ready()) return;
	const ticketText = await current(ticketPath);
	if (ticketText === null) return notify("Could not read the ticket.", "error");
	const allDocs = docs();
	const ticketDoc = allDocs.find((d) => canonical(d.path) === canonical(ticketPath));
	const descendants = descendantTickets(allDocs, key);
	const scopeDocs = [ticketDoc, ...descendants].filter((d): d is DocFile => Boolean(d));
	const scopeKeys = scopeDocs.map((d) => d.ticket!).filter(Boolean);
	if (!scopeKeys.length) scopeKeys.push(key);
	const scopeKeySet = new Set(scopeKeys.map((k) => k.toLowerCase()));

	// 1. All scripts / code refs & test scripts across ticket + recursive descendants.
	const scripts: { ref: string; kind: string; ticket: string }[] = [];
	const seenScripts = new Set<string>();
	const testScripts: { ref: string; ticket: string }[] = [];
	const seenTestScripts = new Set<string>();
	const planTests: PlanBusinessTest[] = [];
	const seenPlanTests = new Set<string>();

	for (const k of scopeKeys) {
		const groups = ticketWork(allDocs, k);
		const planFiles = groups.find((g) => g.kind === "plan")?.files ?? [];
		const specFiles = groups.find((g) => g.kind === "spec")?.files ?? [];
		const docSelf = scopeDocs.find((d) => d.ticket?.toLowerCase() === k.toLowerCase());
		for (const d of [docSelf, ...planFiles, ...specFiles].filter((x): x is DocFile => Boolean(x))) {
			for (const ts of d.testScripts ?? []) {
				const clean = ts.trim();
				if (!clean || seenTestScripts.has(clean.toLowerCase())) continue;
				seenTestScripts.add(clean.toLowerCase());
				testScripts.push({ ref: clean, ticket: k });
			}
		}
		for (const p of planFiles) {
			const planName = p.heading || p.title || p.name;
			for (const pt of p.planTests ?? []) {
				const ptKey = `${planName.toLowerCase()}::${pt.name.toLowerCase()}`;
				if (seenPlanTests.has(ptKey)) continue;
				seenPlanTests.add(ptKey);
				planTests.push({ ...pt, plan: planName, ticket: k });
			}
		}
		for (const ref of scriptsForTicket(allDocs, k)) {
			const norm = ref.toLowerCase();
			if (seenScripts.has(norm) || seenTestScripts.has(norm)) continue;
			seenScripts.add(norm);
			scripts.push({ ref, kind: classifyDeploymentArtifact(ref), ticket: k });
		}
	}

	// 2. SQL / DDL / Schema artifacts tied to the ticket or its descendants (stamping owning sub-ticket key).
	const sqlArtifacts: { path: string; kind: string; source: string; ticket: string }[] = [];
	const seenSql = new Set<string>();
	const addSql = (artifactPath: string, kind: string, source: string, ownerTicket: string) => {
		const norm = artifactPath.replace(/\\/g, "/").toLowerCase();
		if (seenSql.has(norm)) return;
		seenSql.add(norm);
		sqlArtifacts.push({ path: artifactPath.replace(/\\/g, "/"), kind, source, ticket: ownerTicket });
	};
	for (const doc of scopeDocs) {
		const k = doc.ticket ?? key;
		// Ticket bundle SQL/DDL files
		for (const tf of doc.ticketFiles ?? []) {
			if (/\.(sql|ddl|pks|pkb)$/i.test(tf.rel)) addSql(tf.rel, "Ticket SQL / DDL", `${k} bundle`, k);
		}
		// Linked schema docs + their `source:` DDL
		const groups = ticketWork(allDocs, k);
		for (const sc of groups.find((g) => g.kind === "schema")?.files ?? []) {
			addSql(relativeTo(root(), sc.path), "Schema doc", k, k);
			if (sc.source) addSql(sc.source, "DDL source", sc.title || sc.name, k);
		}
	}

	// 3. Affected CSV registry rows across every ticket in scope.
	const registries: { title: string; headers: string[]; rows: string[][] }[] = [];
	for (const reg of allDocs.filter((d) => d.exists && d.group === "registries" && !isCatalog(d) && /\.(csv|tsv)$/i.test(d.name))) {
		const csvText = await current(reg.path);
		if (!csvText) continue;
		const parsed = parseCsv(csvText);
		const tCol = ticketColumn(parsed);
		if (tCol < 0) continue;
		const matched = parsed.rows
			.filter((cells) => keysIn(cells[tCol]?.text ?? "", scopeKeySet).some((k) => scopeKeySet.has(k.toLowerCase())))
			.map((cells) => parsed.header.map((_, i) => cells[i]?.text ?? ""));
		if (matched.length) {
			registries.push({
				title: registryTitle(reg.name),
				headers: parsed.header.map((c) => c.text.trim()),
				rows: matched,
			});
		}
	}

	// 4. Rollback notes extracted across the ticket, ALL descendant tickets, and ALL their linked specs (deduplicated).
	const rollbackNotes: string[] = [];
	const seenRollbackBodies = new Set<string>();
	const seenSpecPaths = new Set<string>();
	const pushRollback = (label: string | null, rawBody: string) => {
		const sig = rawBody.trim().replace(/\s+/g, " ").toLowerCase();
		if (!sig || seenRollbackBodies.has(sig)) return;
		seenRollbackBodies.add(sig);
		rollbackNotes.push(label ? `**From ${label}:**\n\n${rawBody.trim()}` : rawBody.trim());
	};
	for (const doc of scopeDocs) {
		const text = canonical(doc.path) === canonical(ticketPath) ? ticketText : await current(doc.path);
		const rb = text ? extractRollbackSection(text) : "";
		if (rb) pushRollback(doc === ticketDoc ? null : `${doc.ticket ?? doc.name}`, rb);
		const k = doc.ticket ?? key;
		for (const sp of ticketWork(allDocs, k).find((g) => g.kind === "spec")?.files ?? []) {
			const spCanon = canonical(sp.path);
			if (seenSpecPaths.has(spCanon)) continue;
			seenSpecPaths.add(spCanon);
			const spText = await current(sp.path);
			const spRb = spText ? extractRollbackSection(spText) : "";
			if (spRb) pushRollback(`${sp.title || sp.name} (${k})`, spRb);
		}
	}

	const [{ gitStatus }, headSha, manifestFiles] = await Promise.all([
		import("./git"),
		backend.gitHeadSha().catch(() => null),
		backend.manifest().catch(() => []),
	]);
	const readiness = evaluateTicketReadiness(allDocs, key, {
		gitFiles: gitStatus()?.files,
		root: state.workspace?.root,
	});

	// Match SHA-256 checksums for referenced script, test script, and SQL artifacts.
	const wsRoot = state.workspace?.root;
	const checksums: { path: string; sha256: string }[] = [];
	const seenChecksum = new Set<string>();
	const allArtifactRefs = [...scripts.map((s) => s.ref), ...testScripts.map((t) => t.ref), ...sqlArtifacts.map((s) => s.path)];
	for (const mf of manifestFiles) {
		if (!allArtifactRefs.some((ref) => codeMatchesRef(mf.path, ref, wsRoot))) continue;
		const k = mf.path.toLowerCase();
		if (seenChecksum.has(k)) continue;
		seenChecksum.add(k);
		checksums.push({ path: mf.path, sha256: mf.sha256 });
	}

	const manifestInput = {
		projectName: state.project?.name || state.workspace?.name || "Project",
		generatedOn: today(),
		ticketKey: key,
		ticketTitle: ticketDoc?.title || key,
		status: ticketDoc?.status,
		parent: ticketDoc?.parent,
		release: ticketDoc?.release,
		headSha: headSha ?? undefined,
		changeControl: ticketDoc?.changeControl,
		approvedBy: ticketDoc?.approvedBy,
		approvedDate: ticketDoc?.approvedDate,
		gxpImpact: ticketDoc?.gxpImpact,
		scopeTickets: scopeDocs.map((d) => ({ key: d.ticket ?? d.name, title: d.title || d.name, status: d.status })),
		scripts,
		testScripts: testScripts.length ? testScripts : undefined,
		planTests: planTests.length ? planTests : undefined,
		sqlArtifacts,
		registries,
		checksums: checksums.length ? checksums : undefined,
		readiness,
		rollbackNotes: rollbackNotes.length ? rollbackNotes : undefined,
	};

	// 5. Best-effort local Git commits mentioning any ticket in scope (files not already listed above).
	const gitCommitted: { status: string; commit: string; path: string; ticket: string }[] = [];
	const seenGitFiles = new Set<string>();
	const statusWord = (code: string) => {
		const c = code.trim().toUpperCase()[0] ?? "";
		return c === "A" ? "Added" : c === "D" ? "Deleted" : c === "R" ? "Renamed" : c === "C" ? "Copied" : "Modified";
	};
	const commitBatches = await Promise.all(scopeKeys.map(async (k) => ({ k, commits: await backend.gitTicketLog(k, 40).catch(() => []) })));
	for (const { k, commits } of commitBatches) {
		for (const commit of commits) {
			for (const gf of commit.files) {
				const cleanPath = gf.path.replace(/\\/g, "/");
				const norm = cleanPath.toLowerCase();
				if (seenGitFiles.has(norm)) continue;
				const coveredByScripts = scripts.some((s) => codeMatchesRef(cleanPath, s.ref, wsRoot));
				const coveredByTests = testScripts.some((t) => codeMatchesRef(cleanPath, t.ref, wsRoot));
				const coveredBySql = sqlArtifacts.some((s) => codeMatchesRef(cleanPath, s.path, wsRoot));
				if (coveredByScripts || coveredByTests || coveredBySql) continue;
				seenGitFiles.add(norm);
				gitCommitted.push({ status: statusWord(gf.status), commit: commit.shortSha, path: cleanPath, ticket: k });
			}
		}
	}

	const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");
	const exportDir = ticketDoc?.ticketFolder
		? `${relativeTo(root(), ticketDoc.ticketFolder).split("\\").join("/")}/exports`
		: `${docsRel}/exports`;

	if (format === "csv") {
		let csv = assembleDeploymentManifestCsv(manifestInput);
		if (gitCommitted.length) {
			const extra = gitCommitted.map((g) => csvRow(["Git commit (local)", g.path, g.ticket, g.status, `Commit ${g.commit}`], ","));
			csv = `${csv.trimEnd()}\n${extra.join("\n")}\n`;
		}
		await saveExportFile(`${exportDir}/${key}-deployment-manifest.csv`, `${key}-deployment-manifest.csv`, csv, "text/csv;charset=utf-8");
		return;
	}

	let manifestMd = assembleDeploymentManifestMarkdown(manifestInput);
	if (gitCommitted.length) {
		const escCell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
		const gitSection = [
			"## Committed in Git (local)",
			"",
			"| Status | Commit | File |",
			"| --- | --- | --- |",
			...gitCommitted.map((g) => `| ${escCell(g.status)} | \`${escCell(g.commit)}\` | \`${escCell(g.path)}\` |`),
			"",
		].join("\n");
		const rollbackMarker = "\n## Rollback Plan";
		const at = manifestMd.indexOf(rollbackMarker);
		manifestMd = at >= 0 ? `${manifestMd.slice(0, at)}\n${gitSection}${manifestMd.slice(at)}` : `${manifestMd.trimEnd()}\n\n${gitSection}`;
	}
	if (format === "markdown") {
		await saveExportFile(`${exportDir}/${key}-deployment-manifest.md`, `${key}-deployment-manifest.md`, manifestMd, "text/markdown;charset=utf-8");
		return;
	}

	if (format === "docx") {
		const expanded = await expandTransclusionsForExport(manifestMd, ticketPath);
		const subtitle = state.project?.name ? `${state.project.name} · Generated ${today()}` : `Generated ${today()}`;
		await saveDocxExport(`${exportDir}/${key}-deployment-manifest.docx`, `${key}: ${ticketDoc?.title || key} — Deployment Manifest`, subtitle, expanded, {
			baseDir: dirName(ticketPath),
		});
		return;
	}

	await saveExportFile(
		`${exportDir}/${key}-deployment-manifest.html`,
		`${key}-deployment-manifest.html`,
		async (destPath) => {
			const bodyHtml = await renderCleanHtmlForExport(manifestMd, ticketPath, { exportDestPath: destPath });
			return buildPrintableHtml(`${key}: ${ticketDoc?.title || key} — Deployment Manifest`, bodyHtml);
		},
		"text/html;charset=utf-8",
	);
}

/**
 * Guided closeout for a ticket or epic: summarizes readiness warnings, marks the ticket `done`,
 * optionally appends a dated completion entry to `docs/STATE.md` and/or promotes a milestone note
 * to `README.md`, clears active ticket focus if matching, and offers manual catalog reconciliation (ADR 0031).
 */
export async function closeoutTicket(ticketPath: string, key: string): Promise<void> {
	if (!ready()) return;
	const allDocs = docs();
	const ticketDoc = allDocs.find((d) => canonical(d.path) === canonical(ticketPath));
	const title = ticketDoc?.title || key;
	const { gitStatus } = await import("./git");
	const readiness = evaluateTicketReadiness(allDocs, key, {
		gitFiles: gitStatus()?.files,
		root: state.workspace?.root,
	});
	const warns = readiness ? readiness.checks.filter((c) => c.level === "warn") : [];
	const warnNote = warns.length
		? ` Attention: ${warns.map((w) => `${w.label} (${w.detail})`).join("; ")}.`
		: " All release readiness checks pass.";

	const DONE_STATE = "Mark done & record in STATE.md";
	const DONE_STATE_README = "Mark done, record in STATE.md & README.md";
	const DONE_ONLY = "Mark done only";
	const picked = await choose(`Close out ${key}: ${title}?${warnNote}`, [DONE_STATE, DONE_STATE_README, DONE_ONLY]);
	if (!picked) return;

	let summaryLine = "";
	if (picked !== DONE_ONLY) {
		const typed = (await ask("One-line completion summary for STATE.md", `${key}: ${title}`))?.trim();
		if (!typed) return;
		summaryLine = typed;
	}

	// 1. Mark ticket status `done` if not already.
	if (toneOf(ticketDoc?.status) !== "done") {
		await setStatus(ticketPath, "done");
	}

	// 2. Append dated bullet to `docs/STATE.md` (creating it from template if absent, honoring existing casing on Linux).
	if (picked === DONE_STATE || picked === DONE_STATE_README) {
		const stateDoc = allDocs.find(
			(d) => d.exists && canonical(dirName(d.path)) === canonical(docsFolder()) && baseName(d.path).toLowerCase() === STATE_FILE.toLowerCase(),
		);
		const statePath = stateDoc?.path ?? joinPath(docsFolder(), STATE_FILE);
		const existingState = await current(statePath);
		const bullet = `- ${today()} — ${summaryLine}`;
		if (existingState === null) {
			const fresh = `${stateTemplate(state.project!.name, today()).trimEnd()}\n\n## Completed\n\n${bullet}\n`;
			await start(statePath, fresh);
		} else {
			const eol = existingState.includes("\r\n") ? "\r\n" : "\n";
			const headingRe = /^(##\s+(?:Completed|Recent(?:ly)?\s+(?:completed|done|milestones)|Done|History)[^\r\n]*\r?\n+)/im;
			let nextState: string;
			if (headingRe.test(existingState)) {
				nextState = existingState.replace(headingRe, (_, head: string) => `${head}${bullet}${eol}`);
			} else {
				const sep = existingState.endsWith("\n") ? eol : `${eol}${eol}`;
				nextState = `${existingState}${sep}## Completed${eol}${eol}${bullet}${eol}`;
			}
			await put(statePath, nextState, true);
		}
	}

	// 3. Optionally promote completed milestone / capability note into `README.md` (honoring existing casing on Linux).
	if (picked === DONE_STATE_README) {
		const readmeDoc = allDocs.find((d) => d.exists && d.group === "project" && baseName(d.path).toLowerCase() === "readme.md");
		const readmePath = readmeDoc?.path ?? joinPath(root(), "README.md");
		const existingReadme = await current(readmePath);
		if (existingReadme !== null) {
			const eol = existingReadme.includes("\r\n") ? "\r\n" : "\n";
			const bullet = `- **${key}** (${today()}): ${summaryLine.replace(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:\\s—-]+`, "i"), "")}`;
			const secRe = /^(##\s+(?:Completed|Milestones|Capabilities|Delivered|What this does)[^\r\n]*\r?\n+)/im;
			const nextReadme = secRe.test(existingReadme)
				? existingReadme.replace(secRe, (_, head: string) => `${head}${bullet}${eol}`)
				: `${existingReadme.trimEnd()}${eol}${eol}## Milestones${eol}${eol}${bullet}${eol}`;
			await put(readmePath, nextReadme, true);
		}
	}

	// 4. Clear active workspace ticket focus if it matched this closed-out ticket.
	if (state.settings.activeTicket?.toLowerCase() === key.toLowerCase()) {
		await saveSetting({ activeTicket: null }, "workspace");
	}

	setState("treeVersion", (v) => v + 1);
	// Respect ADR 0031: never auto-rewrite INDEX.md catalogs silently — offer explicit manual trigger if stale.
	const staleInfo = staleCatalogSummary();
	const hasStale = staleInfo.stale.length > 0 || staleInfo.missing.length > 0;
	notify(
		`Closed out ${key}${picked === DONE_STATE_README ? " (updated STATE.md & README.md)" : picked === DONE_STATE ? " (recorded in STATE.md)" : ""}.`,
		"info",
		hasStale ? { label: "Update catalogs", run: () => void updateCatalogs() } : undefined,
	);
}

/** Renames a `#tag` across both YAML frontmatter (`tags:`/`tag:`) and prose `#tag` occurrences in workspace Markdown docs. */
export async function renameTagAcrossWorkspace(oldTag: string): Promise<void> {
	if (!ready()) return;
	const cleanOld = oldTag.trim().replace(/^#+/, "");
	if (!cleanOld) return;
	const typed = (await ask(`Rename tag #${cleanOld} across workspace to (without #)`, cleanOld))?.trim().replace(/^#+/, "");
	if (!typed || typed.toLowerCase() === cleanOld.toLowerCase()) return;
	if (!/^[A-Za-z][A-Za-z0-9_/-]{0,63}$/.test(typed)) {
		notify("Tags must start with a letter and use letters, numbers, _, /, or -.", "error");
		return;
	}
	const targets = docs().filter(
		(d) => d.exists && isMarkdown(d.path) && !isCatalog(d) && d.tags?.some((t) => t.toLowerCase() === cleanOld.toLowerCase()),
	);
	if (!targets.length) return notify(`No documents currently carry #${cleanOld}.`);
	const GO = `Rename in ${targets.length} ${targets.length === 1 ? "file" : "files"}`;
	if ((await choose(`Rename #${cleanOld} to #${typed} across ${targets.length} ${targets.length === 1 ? "document" : "documents"} (YAML frontmatter and prose)?`, [GO])) !== GO) {
		return;
	}
	const esc = cleanOld.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const proseRe = new RegExp(`(^|[\\s([{"'.,;:])#${esc}(?=$|[\\s)\\]}"'.,;:!?])`, "gi");
	let changedCount = 0;
	for (const doc of targets) {
		const before = await current(doc.path);
		if (before === null) continue;
		let next = before;
		for (const field of ["tags", "tag"]) {
			next = replaceInFrontMatterList(next, field, cleanOld, typed) ?? next;
		}
		const cutAt = bodyOffset(next);
		const headPart = next.slice(0, cutAt);
		const bodyPart = next.slice(cutAt);
		// Rewrite prose `#oldTag` lines outside fenced code blocks & ATX headings.
		const lines = bodyPart.split(/(\r?\n)/);
		let inFence: { ch: string; len: number } | null = null;
		for (let i = 0; i < lines.length; i += 2) {
			const ln = lines[i]!;
			const fm = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(ln);
			if (fm) {
				if (!inFence) inFence = { ch: fm[1]![0]!, len: fm[1]!.length };
				else if (fm[1]![0] === inFence.ch && fm[1]!.length >= inFence.len) inFence = null;
				continue;
			}
			if (inFence || /^[ \t]{0,3}#{1,6}[ \t]+/.test(ln)) continue;
			// Skip inline backtick spans while rewriting `#oldTag`.
			const parts = ln.split(/(`+[^`]*`+)/);
			for (let p = 0; p < parts.length; p += 2) {
				parts[p] = parts[p]!.replace(proseRe, `$1#${typed}`);
			}
			lines[i] = parts.join("");
		}
		next = headPart + lines.join("");
		if (next !== before) {
			await put(doc.path, next, true);
			changedCount++;
		}
	}
	if (changedCount) {
		setState("treeVersion", (v) => v + 1);
		notify(`Renamed #${cleanOld} to #${typed} in ${changedCount} ${changedCount === 1 ? "document" : "documents"}.`);
	}
}

/** Sets (or clears) the persisted workspace-level active ticket coordinating Agent, Git, Search, Docs, Graph & Explorer. */
export async function setActiveTicket(key: string | null): Promise<void> {
	if (!state.workspace) return;
	const clean = key?.trim() || null;
	await saveSetting({ activeTicket: clean }, "workspace");
	notify(clean ? `Active ticket set to ${clean} (Agent, Git, Search & Graph follow it).` : "Cleared active ticket focus.");
}

/** Interactive StatusBar / Command Palette switcher for the active working ticket. */
export async function pickActiveTicket(): Promise<void> {
	if (!ready()) return;
	const root = state.workspace?.root ?? "";
	const allTickets = docs()
		.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket)
		.sort((a, b) => {
			const aActive = toneOf(a.status) === "active" ? 0 : toneOf(a.status) === "waiting" ? 1 : 2;
			const bActive = toneOf(b.status) === "active" ? 0 : toneOf(b.status) === "waiting" ? 1 : 2;
			return aActive - bActive || (a.ticket ?? "").localeCompare(b.ticket ?? "", undefined, { numeric: true });
		});
	if (!allTickets.length) return notify("No tickets exist yet. Create one from Docs -> New -> New ticket….");

	const cur = state.settings.activeTicket?.trim() ?? "";
	const curDoc = cur ? allTickets.find((t) => t.ticket?.toLowerCase() === cur.toLowerCase()) : undefined;

	type Action = { kind: "open" } | { kind: "browse" } | { kind: "clear" } | { kind: "select"; ticket: string };
	const items: QuickPickOption<Action>[] = [];
	if (curDoc) {
		items.push({
			label: `Open ${curDoc.ticket}`,
			value: { kind: "open" },
			icon: "go-to-file",
			detail: curDoc.title || curDoc.name,
			keywords: `open active ${curDoc.ticket}`,
		});
		if (curDoc.ticketFolder) {
			items.push({
				label: `Browse ${curDoc.ticket} files in Explorer`,
				value: { kind: "browse" },
				icon: "folder",
				detail: root ? relativeTo(root, curDoc.ticketFolder).replace(/\\/g, "/") : "",
				keywords: `browse folder files explorer ${curDoc.ticket}`,
			});
		}
	}

	const firstTicketIdx = items.length;
	for (const t of allTickets) {
		const isActive = Boolean(cur && t.ticket?.toLowerCase() === cur.toLowerCase());
		const progressText = t.tasks?.total ? `${t.tasks.done}/${t.tasks.total}` : "";
		const detail = [t.release, progressText].filter(Boolean).join(" · ") || undefined;
		items.push({
			label: `${t.ticket}: ${t.title || t.name}`,
			value: { kind: "select", ticket: t.ticket! },
			checked: isActive,
			icon: isActive ? undefined : "checklist",
			badge: t.status ? { text: t.status, tone: toneOf(t.status) } : undefined,
			detail,
			divide: items.length === firstTicketIdx && firstTicketIdx > 0,
			keywords: [t.ticket, t.title, t.status, t.release, ...(t.tags ?? [])].filter(Boolean).join(" "),
		});
	}

	if (cur) {
		items.push({
			label: `Clear active ticket (${cur})`,
			value: { kind: "clear" },
			icon: "close",
			divide: true,
			keywords: "clear reset none unfocus",
		});
	}

	const picked = await quickPick<Action>({
		title: cur ? `Active ticket: ${cur}` : "Switch active ticket",
		placeholder: "Filter by ticket key, title, status, or release…",
		items,
		empty: "No matching tickets.",
	});
	if (!picked) return;
	if (picked.kind === "open" && curDoc) return void openFile(curDoc.path);
	if (picked.kind === "browse" && curDoc?.ticketFolder) {
		const { browseFolderInExplorer } = await import("./panels/Explorer");
		browseFolderInExplorer(curDoc.ticketFolder, `${curDoc.ticket} files`);
		return;
	}
	if (picked.kind === "clear") return void setActiveTicket(null);
	if (picked.kind === "select") await setActiveTicket(picked.ticket);
}

/**
 * Renames a Markdown heading in the active document and rewrites `#anchor` / `[[Doc#Heading]]`
 * references across all workspace Markdown docs, confirming impact first (ADR 0009), and
 * refreshes any existing `<!-- toc -->` block in the source document.
 */
export async function renameHeadingAcrossWorkspace(targetPath?: string): Promise<void> {
	if (!ready()) return;
	const docPath = targetPath ?? activePath();
	if (!docPath || !isMarkdown(docPath)) {
		notify("Open a Markdown document first to rename a heading.");
		return;
	}
	const sourceText = await current(docPath);
	if (sourceText === null) return notify("Could not read the active Markdown document.", "error");
	const headings = documentHeadings(sourceText);
	if (!headings.length) {
		notify("This document has no headings to rename.");
		return;
	}

	// Determine the cursor line (works in both Live CM6 and Source Monaco modes).
	let cursorLine = 0;
	const live = activeLiveEditor();
	if (live && canonical(live.path) === canonical(docPath)) {
		cursorLine = live.getPosition().lineNumber;
	} else {
		const ed = activeEditor();
		if (ed && ed.getModel() === documents.get(canonical(docPath))?.model) {
			cursorLine = ed.getPosition()?.lineNumber ?? 0;
		}
	}

	let pickedHeading = cursorLine ? headings.find((h) => h.line === cursorLine) : undefined;
	if (!pickedHeading) {
		const ordered = [...headings].sort((a, b) => {
			const aAbove = cursorLine && a.line <= cursorLine ? 0 : 1;
			const bAbove = cursorLine && b.line <= cursorLine ? 0 : 1;
			if (aAbove !== bAbove) return aAbove - bAbove;
			if (aAbove === 0) return b.line - a.line;
			return a.line - b.line;
		});
		const labels = ordered.map((h) => `${"#".repeat(h.level)} ${h.text} (line ${h.line})`);
		const picked = await choose(`Rename which heading in ${baseName(docPath)}?`, labels);
		if (!picked) return;
		pickedHeading = ordered[labels.indexOf(picked)];
	}
	if (!pickedHeading) return;

	const typed = (await ask(`Rename heading “${pickedHeading.text}” to`, pickedHeading.text))?.trim();
	if (!typed || typed === pickedHeading.text) return;

	const lines = sourceText.split(/(\r?\n)/);
	const lineIdx = (pickedHeading.line - 1) * 2;
	const rawLine = lines[lineIdx];
	if (rawLine === undefined) return;
	const updatedLine = rawLine.replace(/^([ \t]{0,3}#{1,6}[ \t]+).+?([ \t]*#*[ \t]*)$/, (_, prefix: string, suffix: string) => `${prefix}${typed}${suffix}`);
	if (updatedLine === rawLine) return;
	lines[lineIdx] = updatedLine;
	const renamedSource = lines.join("");

	const nextHeading = documentHeadings(renamedSource).find((h) => h.line === pickedHeading.line);
	if (!nextHeading) return;

	const allDocs = docs();
	const wsRoot = root();
	const targetCanon = canonical(docPath);
	const nameIdx = buildDocNameIndex(allDocs, wsRoot);
	const scanPaths = new Map<string, string>();
	scanPaths.set(targetCanon, docPath);
	for (const d of allDocs) {
		if (!d.exists || !isMarkdown(d.path) || isCatalog(d)) continue;
		const c = canonical(d.path);
		if (!scanPaths.has(c)) scanPaths.set(c, d.path);
	}

	const edits: { path: string; next: string; refs: number; isSource: boolean }[] = [];
	let totalRefs = 0;
	for (const [canon, filePath] of scanPaths) {
		const isSameDoc = canon === targetCanon;
		const baseText = isSameDoc ? renamedSource : await current(filePath);
		if (baseText === null) continue;
		const res = rewriteHeadingReferences(baseText, {
			isSameDoc,
			matchesDocHref: (hrefPath) => {
				const clean = linkFile(hrefPath);
				if (!clean) return false;
				const resolved = clean.startsWith("/") ? resolvePath(wsRoot, clean.slice(1)) : resolvePath(dirName(filePath), clean);
				return canonical(resolved) === targetCanon;
			},
			matchesWikiTarget: (name) => {
				const found = lookupInIndex(name, nameIdx);
				return Boolean(found && canonical(found.path) === targetCanon);
			},
			oldHeading: pickedHeading.text,
			oldAnchor: pickedHeading.anchor,
			newHeading: typed,
			newAnchor: nextHeading.anchor,
		});
		let finalText = res.text;
		if (isSameDoc && finalText.includes("<!-- toc -->") && finalText.includes("<!-- /toc -->")) {
			finalText = upsertTocBlock(finalText).text;
		}
		if (isSameDoc || res.count > 0) {
			totalRefs += res.count;
			edits.push({ path: filePath, next: finalText, refs: res.count, isSource: isSameDoc });
		}
	}

	const externalCount = edits.filter((e) => !e.isSource).length;
	if (totalRefs > 0 || externalCount > 0) {
		const GO = "Rename heading";
		const scope =
			externalCount > 0
				? `${totalRefs} ${totalRefs === 1 ? "reference" : "references"} across ${edits.length} ${edits.length === 1 ? "file" : "files"}`
				: `${totalRefs} ${totalRefs === 1 ? "reference" : "references"} in ${baseName(docPath)}`;
		const ok = await choose(`Rename “${pickedHeading.text}” to “${typed}” and update ${scope}?`, [GO]);
		if (ok !== GO) return;
	}

	let written = 0;
	for (const item of edits) {
		try {
			await put(item.path, item.next, true);
			written++;
		} catch (e: any) {
			notify(`Could not update ${baseName(item.path)}: ${e?.message ?? e}`, "error");
		}
	}
	if (written) {
		setState("treeVersion", (v) => v + 1);
		notify(
			totalRefs > 0
				? `Renamed heading to “${typed}” and updated ${totalRefs} ${totalRefs === 1 ? "reference" : "references"} across ${written} ${written === 1 ? "file" : "files"}.`
				: `Renamed heading to “${typed}”.`,
		);
	}
}

/**
 * Interactive Multi-Ticket Release Bundle & Release Notes exporter.
 * Selects tickets by release tag, status, or explicit keys, optionally includes a local Git tag range,
 * deduplicates scripts, test scripts, SQL artifacts, registry rows, and rollback notes across all
 * tickets + descendants, and exports the Release Bundle and/or stakeholder Release Notes.
 */
export async function exportReleaseBundle(format?: "markdown" | "html" | "docx"): Promise<void> {
	if (!ready()) return;
	const allDocs = docs();
	const allTickets = allDocs.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket);
	if (!allTickets.length) return notify("No tickets exist in this project yet.");

	const activeTickets = allTickets.filter((t) => !isArchivedTicket(t));
	const releases = [...new Set(activeTickets.map((t) => t.release?.trim()).filter((r): r is string => Boolean(r)))].sort((a, b) =>
		a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
	);
	const doneTickets = activeTickets.filter((t) => toneOf(t.status) === "done");
	const inProgTickets = activeTickets.filter((t) => toneOf(t.status) === "active");

	const scopeOptions: { label: string; detail: string; tickets?: DocFile[]; defaultName: string; custom?: boolean }[] = [];
	for (const rel of releases) {
		const matched = activeTickets.filter((t) => t.release?.trim().toLowerCase() === rel.toLowerCase());
		scopeOptions.push({
			label: `Release: ${rel} (${matched.length})`,
			detail: matched.map((t) => t.ticket).slice(0, 6).join(", ") + (matched.length > 6 ? "…" : ""),
			tickets: matched,
			defaultName: rel,
		});
	}
	if (doneTickets.length) {
		scopeOptions.push({
			label: `All done tickets (${doneTickets.length})`,
			detail: "Non-archived tickets marked done / resolved / approved",
			tickets: doneTickets,
			defaultName: `release-${today()}`,
		});
	}
	if (inProgTickets.length) {
		scopeOptions.push({
			label: `Active / in-progress tickets (${inProgTickets.length})`,
			detail: "Tickets currently under way",
			tickets: inProgTickets,
			defaultName: `release-${today()}`,
		});
	}
	scopeOptions.push({
		label: `All active tickets (${activeTickets.length})`,
		detail: "Every non-archived ticket in the workspace",
		tickets: activeTickets,
		defaultName: `release-${today()}`,
	});
	scopeOptions.push({
		label: "Select ticket keys…",
		detail: "Enter a comma-separated list of ticket keys (e.g. LIMS-101, LIMS-102)",
		defaultName: `release-${today()}`,
		custom: true,
	});

	const pickedScope = await choose(
		"Which tickets belong in this Release Bundle?",
		scopeOptions.map((o) => o.label),
		{ details: Object.fromEntries(scopeOptions.map((o) => [o.label, o.detail])) },
	);
	if (!pickedScope) return;
	const chosenScope = scopeOptions.find((o) => o.label === pickedScope);
	if (!chosenScope) return;

	let baseTickets = chosenScope.tickets ?? [];
	if (chosenScope.custom) {
		const defaultKeys = state.settings.activeTicket?.trim() || activeTickets.slice(0, 5).map((t) => t.ticket).join(", ");
		const typed = (await ask("Ticket keys to bundle (comma-separated)", defaultKeys))?.trim();
		if (!typed) return;
		const wanted = new Set(typed.split(/[\s,;]+/).map((k) => ticketKey(k).toLowerCase()).filter(Boolean));
		baseTickets = allTickets.filter((t) => t.ticket && wanted.has(t.ticket.toLowerCase()));
		if (!baseTickets.length) return notify("None of those ticket keys matched tickets in this project.", "error");
	}

	const releaseName = (await ask("Release name or version label", chosenScope.defaultName))?.trim();
	if (!releaseName) return;

	// Roll up descendants of every selected ticket (excluding dropped/cancelled) and deduplicate.
	const scopedMap = new Map<string, DocFile>();
	for (const t of baseTickets) {
		scopedMap.set(canonical(t.path), t);
		if (t.ticket) {
			for (const desc of descendantTickets(allDocs, t.ticket)) {
				if (toneOf(desc.status) === "off") continue;
				scopedMap.set(canonical(desc.path), desc);
			}
		}
	}
	const scopeDocs = [...scopedMap.values()].sort((a, b) =>
		(a.ticket ?? "").localeCompare(b.ticket ?? "", undefined, { numeric: true, sensitivity: "base" }),
	);
	const scopeKeys = scopeDocs.map((d) => d.ticket!).filter(Boolean);
	const scopeKeySet = new Set(scopeKeys.map((k) => k.toLowerCase()));

	// Optional local Git tag range
	let commits: ReleaseBundleCommit[] | undefined;
	let gitRange: { from: string; to: string } | undefined;
	const tags = await backend.gitTags().catch(() => []);
	if (tags.length) {
		const NONE = "Skip Git commit range";
		const tagChoices = tags.slice(0, 10).map((t) => `${t.name} (${t.sha})`);
		const pickedTag = await choose("Include local Git commits since a previous tag?", [NONE, ...tagChoices]);
		if (!pickedTag) return;
		if (pickedTag !== NONE) {
			const tagObj = tags[tagChoices.indexOf(pickedTag)];
			if (tagObj) {
				gitRange = { from: tagObj.name, to: "HEAD" };
				const log = await backend.gitRangeLog(tagObj.name, "HEAD", 150).catch(() => []);
				if (log.length) commits = log;
			}
		}
	}

	let chosenFormat = format;
	if (!chosenFormat) {
		const DOCX = "Word (.docx)";
		const HTML = "HTML (Print / PDF)";
		const MD = "Markdown (.md)";
		const pickedFmt = await choose(`Export “${releaseName}” as`, [DOCX, HTML, MD]);
		if (!pickedFmt) return;
		chosenFormat = pickedFmt === DOCX ? "docx" : pickedFmt === HTML ? "html" : "markdown";
	}

	const BOTH = "Release Bundle + Release Notes";
	const BUNDLE_ONLY = "Release Bundle only";
	const NOTES_ONLY = "Release Notes only";
	const outputChoice = await choose(`Generate artifacts for ${releaseName}`, [BOTH, BUNDLE_ONLY, NOTES_ONLY]);
	if (!outputChoice) return;

	// Aggregate scripts, test scripts, SQL, registries, rollback notes & readiness across all tickets.
	const scripts: { ref: string; kind: string; ticket: string }[] = [];
	const testScripts: { ref: string; ticket: string }[] = [];
	const sqlArtifacts: { path: string; kind: string; source: string; ticket: string }[] = [];
	const rollbackNotes: { ticket: string; source?: string; body: string }[] = [];
	const seenSpecRollback = new Set<string>();

	const [{ gitStatus }, headSha] = await Promise.all([
		import("./git"),
		backend.gitHeadSha().catch(() => null),
	]);
	const gitFiles = gitStatus()?.files;

	const bundleTickets: ReleaseBundleTicket[] = [];
	for (const doc of scopeDocs) {
		const k = doc.ticket!;
		const groups = ticketWork(allDocs, k);
		const planDocs = groups.find((g) => g.kind === "plan")?.files ?? [];
		const specDocs = groups.find((g) => g.kind === "spec")?.files ?? [];
		const tsSet = new Set<string>();
		for (const d of [doc, ...planDocs, ...specDocs]) {
			for (const ts of d.testScripts ?? []) {
				const clean = ts.trim();
				if (clean && !tsSet.has(clean.toLowerCase())) {
					tsSet.add(clean.toLowerCase());
					testScripts.push({ ref: clean, ticket: k });
				}
			}
		}
		for (const ref of scriptsForTicket(allDocs, k)) {
			if (!tsSet.has(ref.toLowerCase())) {
				scripts.push({ ref, kind: classifyDeploymentArtifact(ref), ticket: k });
			}
		}
		for (const tf of doc.ticketFiles ?? []) {
			if (/\.(sql|ddl|pks|pkb)$/i.test(tf.rel)) {
				sqlArtifacts.push({ path: tf.rel, kind: "Ticket SQL / DDL", source: `${k} bundle`, ticket: k });
			}
		}
		for (const sc of groups.find((g) => g.kind === "schema")?.files ?? []) {
			sqlArtifacts.push({ path: relativeTo(root(), sc.path).split("\\").join("/"), kind: "Schema doc", source: k, ticket: k });
			if (sc.source) sqlArtifacts.push({ path: sc.source, kind: "DDL source", source: sc.title || sc.name, ticket: k });
		}
		const docText = await current(doc.path);
		const docRb = docText ? extractRollbackSection(docText) : "";
		if (docRb) rollbackNotes.push({ ticket: k, body: docRb });
		for (const sp of specDocs) {
			const spKey = `${k.toLowerCase()}::${canonical(sp.path)}`;
			if (seenSpecRollback.has(spKey)) continue;
			seenSpecRollback.add(spKey);
			const spText = await current(sp.path);
			const spRb = spText ? extractRollbackSection(spText) : "";
			if (spRb) rollbackNotes.push({ ticket: k, source: sp.title || sp.name, body: spRb });
		}
		const fmVals = docText ? frontMatter(docText).values : {};
		bundleTickets.push({
			key: k,
			title: doc.title || doc.name,
			type: one(fmVals.type) || undefined,
			status: doc.status,
			release: doc.release,
			priority: doc.priority,
			summary: doc.summary,
			approvedBy: doc.approvedBy,
			approvedDate: doc.approvedDate,
			changeControl: doc.changeControl,
			readiness: evaluateTicketReadiness(allDocs, k, { gitFiles, root: state.workspace?.root }),
		});
	}

	const registries: { title: string; headers: string[]; rows: string[][] }[] = [];
	for (const reg of allDocs.filter((d) => d.exists && d.group === "registries" && !isCatalog(d) && /\.(csv|tsv)$/i.test(d.name))) {
		const csvText = await current(reg.path);
		if (!csvText) continue;
		const parsed = parseCsv(csvText);
		const tCol = ticketColumn(parsed);
		if (tCol < 0) continue;
		const matched = parsed.rows
			.filter((cells) => keysIn(cells[tCol]?.text ?? "", scopeKeySet).some((k) => scopeKeySet.has(k.toLowerCase())))
			.map((cells) => parsed.header.map((_, i) => cells[i]?.text ?? ""));
		if (matched.length) {
			registries.push({
				title: registryTitle(reg.name),
				headers: parsed.header.map((c) => c.text.trim()),
				rows: matched,
			});
		}
	}

	const changeControls = [...new Set(scopeDocs.map((d) => d.changeControl?.trim()).filter((c): c is string => Boolean(c)))];
	const bundleInput: ReleaseBundleInput = {
		projectName: state.project?.name || state.workspace?.name || "Project",
		releaseName,
		generatedOn: today(),
		headSha: headSha ?? undefined,
		gitRange,
		changeControl: changeControls.length ? changeControls.join(", ") : undefined,
		tickets: bundleTickets,
		scripts,
		testScripts: testScripts.length ? testScripts : undefined,
		sqlArtifacts,
		registries,
		rollbackNotes: rollbackNotes.length ? rollbackNotes : undefined,
		commits,
	};

	const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");
	const fileSlug = slug(releaseName).toLowerCase() || `release-${today()}`;
	const anchorPath = joinPath(docsFolder(), "INDEX.md");
	const subtitle = `${bundleInput.projectName} · Generated ${today()}`;

	const writeArtifact = async (kind: "bundle" | "notes", title: string, md: string) => {
		const suffix = kind === "bundle" ? "release-bundle" : "release-notes";
		if (chosenFormat === "markdown") {
			await saveExportFile(`${docsRel}/exports/${fileSlug}-${suffix}.md`, `${fileSlug}-${suffix}.md`, md, "text/markdown;charset=utf-8");
		} else if (chosenFormat === "docx") {
			await saveDocxExport(`${docsRel}/exports/${fileSlug}-${suffix}.docx`, title, subtitle, md, { baseDir: docsFolder() });
		} else {
			await saveExportFile(
				`${docsRel}/exports/${fileSlug}-${suffix}.html`,
				`${fileSlug}-${suffix}.html`,
				async (destPath) => {
					const bodyHtml = await renderCleanHtmlForExport(md, anchorPath, { exportDestPath: destPath });
					return buildPrintableHtml(title, bodyHtml, subtitle);
				},
				"text/html;charset=utf-8",
			);
		}
	};

	if (outputChoice === BOTH || outputChoice === BUNDLE_ONLY) {
		await writeArtifact("bundle", `${releaseName} — Release Bundle`, assembleReleaseBundleMarkdown(bundleInput));
	}
	if (outputChoice === BOTH || outputChoice === NOTES_ONLY) {
		await writeArtifact("notes", `${releaseName} — Release Notes`, assembleReleaseNotesMarkdown(bundleInput));
	}
}

/**
 * Exports a Requirements Traceability Matrix (CSV, Markdown, HTML, or Word .docx)
 * linking tickets, acceptance criteria, specs, plans, code scripts, test scripts,
 * business test cases, decisions, registries, formal approvals, and HEAD Git SHA.
 */
export async function exportRtm(format?: "csv" | "markdown" | "html" | "docx"): Promise<void> {
	if (!ready()) return;
	const allDocs = docs();
	const allTickets = allDocs.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket);
	if (!allTickets.length) return notify("No tickets exist in this project yet.");

	const activeTickets = allTickets.filter((t) => !isArchivedTicket(t));
	const releases = [...new Set(activeTickets.map((t) => t.release?.trim()).filter((r): r is string => Boolean(r)))].sort();
	const epics = activeTickets.filter((t) => t.ticket && descendantTickets(allDocs, t.ticket).length > 0);

	let selectedTickets = activeTickets.length ? activeTickets : allTickets;
	let scopeSlug = "rtm";
	let scopeTitle = state.project?.name || state.workspace?.name || "Project";

	if (releases.length || epics.length) {
		const options: { label: string; detail: string; tickets: DocFile[]; slug: string; title: string }[] = [
			{
				label: `All active tickets (${selectedTickets.length})`,
				detail: "Every non-archived ticket in the project",
				tickets: selectedTickets,
				slug: "rtm",
				title: scopeTitle,
			},
		];
		for (const rel of releases) {
			const matched = activeTickets.filter((t) => t.release?.trim().toLowerCase() === rel.toLowerCase());
			options.push({
				label: `Release: ${rel} (${matched.length})`,
				detail: matched.map((t) => t.ticket).slice(0, 6).join(", "),
				tickets: matched,
				slug: `${slug(rel).toLowerCase()}-rtm`,
				title: `${scopeTitle} (${rel})`,
			});
		}
		for (const epic of epics) {
			const kids = descendantTickets(allDocs, epic.ticket!).filter((d) => toneOf(d.status) !== "off");
			const group = [epic, ...kids];
			options.push({
				label: `Epic: ${epic.ticket} (${group.length})`,
				detail: epic.title || epic.name,
				tickets: group,
				slug: `${epic.ticket!.toLowerCase()}-rtm`,
				title: `${epic.ticket}: ${epic.title || epic.name}`,
			});
		}
		const picked = await choose(
			"Build Requirements Traceability Matrix for which scope?",
			options.map((o) => o.label),
			{ details: Object.fromEntries(options.map((o) => [o.label, o.detail])) },
		);
		if (!picked) return;
		const hit = options.find((o) => o.label === picked);
		if (hit) {
			selectedTickets = hit.tickets;
			scopeSlug = hit.slug;
			scopeTitle = hit.title;
		}
	}

	let chosenFormat = format;
	if (!chosenFormat) {
		const CSV = "CSV (.csv)";
		const DOCX = "Word (.docx)";
		const HTML = "HTML (Print / PDF)";
		const MD = "Markdown (.md)";
		const pickedFmt = await choose("Export Requirements Traceability Matrix as", [CSV, DOCX, HTML, MD]);
		if (!pickedFmt) return;
		chosenFormat = pickedFmt === CSV ? "csv" : pickedFmt === DOCX ? "docx" : pickedFmt === HTML ? "html" : "markdown";
	}

	const headSha = await backend.gitHeadSha().catch(() => null);
	const rows = buildRtmRows(allDocs, selectedTickets, headSha);
	const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");

	if (chosenFormat === "csv") {
		const csv = assembleRtmCsv(rows);
		await saveExportFile(`${docsRel}/exports/${scopeSlug}.csv`, `${scopeSlug}.csv`, csv, "text/csv;charset=utf-8");
		return;
	}

	const rtmMd = assembleRtmMarkdown(rows, scopeTitle);
	const title = `Requirements Traceability Matrix — ${scopeTitle}`;
	const subtitle = `${state.project?.name || state.workspace?.name || "Project"} · Generated ${today()}`;

	if (chosenFormat === "markdown") {
		await saveExportFile(`${docsRel}/exports/${scopeSlug}.md`, `${scopeSlug}.md`, rtmMd, "text/markdown;charset=utf-8");
		return;
	}

	if (chosenFormat === "docx") {
		await saveDocxExport(`${docsRel}/exports/${scopeSlug}.docx`, title, subtitle, rtmMd, { baseDir: docsFolder() });
		return;
	}

	const anchorPath = joinPath(docsFolder(), "INDEX.md");
	await saveExportFile(
		`${docsRel}/exports/${scopeSlug}.html`,
		`${scopeSlug}.html`,
		async (destPath) => {
			const bodyHtml = await renderCleanHtmlForExport(rtmMd, anchorPath, { exportDestPath: destPath });
			return buildPrintableHtml(title, bodyHtml, subtitle);
		},
		"text/html;charset=utf-8",
	);
}

/**
 * Imports a legacy `.docx`, `.html`, or `.md` document into the workspace as Markdown,
 * extracting embedded Word images into the workspace attachments folder and opening the result.
 */
export async function importLegacyDoc(targetGroup?: "docs" | "specs" | "knowledge" | "schema"): Promise<void> {
	if (!ready()) return;
	let group = targetGroup;
	if (!group) {
		const DOCS_OPT = "Docs";
		const SPECS_OPT = "Specs";
		const KNOW_OPT = "Knowledge (Reference)";
		const SCHEMA_OPT = "Schema (Database)";
		const picked = await choose("Import document (.docx, .html, .md) into which folder?", [DOCS_OPT, SPECS_OPT, KNOW_OPT, SCHEMA_OPT], {
			details: {
				[DOCS_OPT]: `${areaSaid("docs")}/ — general project documentation`,
				[SPECS_OPT]: `${areaSaid("docs")}/specs/ — functional & technical specifications`,
				[KNOW_OPT]: `${areaSaid("docs")}/knowledge/reference/ — SOPs, runbooks, & architecture notes`,
				[SCHEMA_OPT]: `${areaSaid("schema")}/database/ — database & data contract docs`,
			},
		});
		if (!picked) return;
		group = picked === SPECS_OPT ? "specs" : picked === KNOW_OPT ? "knowledge" : picked === SCHEMA_OPT ? "schema" : "docs";
	}

	const destDir =
		group === "specs"
			? areaFolder("specs")
			: group === "knowledge"
				? joinPath(areaFolder("knowledge"), "reference")
				: group === "schema"
					? joinPath(schemaFolder(), "database")
					: areaFolder("docs");

	const configuredAttach = state.settings.attachmentsFolder?.trim();
	const attachmentsDir = configuredAttach
		? resolvePath(root(), configuredAttach.replace(/\\/g, "/").replace(/^\/+/, ""))
		: joinPath(docsFolder(), "attachments");

	let sourcePath: string | undefined;
	if (state.info?.host !== "app") {
		const typed = (await ask("Full path to the .docx, .html, or .md file to import"))?.trim();
		if (!typed) return;
		sourcePath = typed.replace(/^(["'])(.*)\1$/, "$2");
	}

	try {
		const res = await backend.importDocFile({ sourcePath, destDir, attachmentsDir });
		if (!res) return;
		setState("treeVersion", (v) => v + 1);
		const imgNote = res.images.length ? ` (${res.images.length} ${res.images.length === 1 ? "image" : "images"} extracted)` : "";
		notify(`Imported ${relativeTo(root(), res.path)} from ${res.kind.toUpperCase()}${imgNote}.`);
		await openFile(res.path);
	} catch (e: any) {
		notify(`Could not import document: ${e?.message ?? e}`, "error");
	}
}

/**
 * Non-destructive brownfield workspace onboarding: scans existing `.sql`, `.ssl`, `.ds`, and `.md`
 * files to create missing `project.toml` setup, seed `database.csv` and `files.csv` registries,
 * and report legacy Markdown docs living outside `docs/` without moving or overwriting existing files.
 */
export async function onboardBrownfieldWorkspace(): Promise<void> {
	if (!state.workspace) {
		notify("Open a folder first.");
		return;
	}
	const wsRoot = root();
	const wsFiles = await backend.files().catch(() => []);
	const docsDir = docsFolder();
	const skipPath = (rel: string) => /(?:^|\/)(?:node_modules|\.git|\.ssl-studio|dist|build)\//i.test(rel);

	const scriptFiles: string[] = [];
	const sqlFiles: string[] = [];
	const legacyMdFiles: string[] = [];
	for (const full of wsFiles) {
		const rel = relativeTo(wsRoot, full).split("\\").join("/");
		if (skipPath(rel)) continue;
		if (/\.(ssl|srvscr|ds|xfd)$/i.test(rel)) scriptFiles.push(full);
		else if (/\.(sql|ddl|pks|pkb)$/i.test(rel)) sqlFiles.push(full);
		else if (/\.(md|markdown)$/i.test(rel)) {
			const topName = rel.toLowerCase();
			if (topName === "readme.md" || topName === "agents.md") continue;
			if (isInside(docsDir, full) && canonical(docsDir) !== canonical(wsRoot)) continue;
			if (rel.toLowerCase().startsWith("design/")) continue;
			legacyMdFiles.push(rel);
		}
	}

	const dbCsvPath = joinPath(areaFolder("registries"), REGISTRIES.find((r) => r.id === "database")!.file);
	const filesCsvPath = joinPath(areaFolder("registries"), REGISTRIES.find((r) => r.id === "files")!.file);
	const [hasDbCsv, hasFilesCsv] = await Promise.all([
		current(dbCsvPath).then((t) => t !== null),
		current(filesCsvPath).then((t) => t !== null),
	]);
	const needsSetup = !state.project?.configured;
	const actions: string[] = [];
	if (needsSetup) actions.push("create .ssl-studio/project.toml");
	if (!hasDbCsv && sqlFiles.length) actions.push(`seed database.csv from ${sqlFiles.length} SQL files`);
	if (!hasFilesCsv) actions.push("seed files.csv manifest");

	if (!actions.length && !legacyMdFiles.length) {
		notify(`Workspace is already onboarded (${scriptFiles.length} scripts, ${sqlFiles.length} SQL files; project.toml and registries are in place).`);
		return;
	}

	const summary = `Scanned workspace: ${scriptFiles.length} scripts/data sources, ${sqlFiles.length} SQL files, ${legacyMdFiles.length} legacy Markdown ${legacyMdFiles.length === 1 ? "doc" : "docs"} outside ${areaSaid("docs")}/.`;
	const ONBOARD = "Set up & seed registries";
	const LIST_ONLY = "List legacy Markdown files";
	const choices = [...(actions.length ? [ONBOARD] : []), ...(legacyMdFiles.length ? [LIST_ONLY] : [])];
	const details: Record<string, string> = {};
	if (actions.length) details[ONBOARD] = `Non-destructive: ${actions.join("; ")}. Existing files are never overwritten.`;
	if (legacyMdFiles.length) details[LIST_ONLY] = `Preview ${legacyMdFiles.length} Markdown ${legacyMdFiles.length === 1 ? "file" : "files"} outside ${areaSaid("docs")}/ without moving them.`;

	const picked = await choose(summary, choices, { details });
	if (!picked) return;

	if (picked === LIST_ONLY) {
		const preview = legacyMdFiles.slice(0, 12).join(", ") + (legacyMdFiles.length > 12 ? `, and ${legacyMdFiles.length - 12} more` : "");
		notify(`Legacy Markdown outside ${areaSaid("docs")}/ (${legacyMdFiles.length}): ${preview}`);
		return;
	}

	const created: string[] = [];
	try {
		if (needsSetup) {
			const made = await backend.setupProject();
			created.push(...made);
			const refreshed = await backend.project();
			setState("project", refreshed);
		}

		if (!hasDbCsv && sqlFiles.length) {
			const dbKind = REGISTRIES.find((r) => r.id === "database")!;
			const rows: string[] = [];
			const seen = new Set<string>();
			for (const sf of sqlFiles.slice(0, 200)) {
				const txt = await current(sf);
				if (!txt) continue;
				const rel = relativeTo(wsRoot, sf).split("\\").join("/");
				for (const obj of extractSqlObjects(txt, { includeAlter: true })) {
					const k = obj.name.toLowerCase();
					if (seen.has(k)) continue;
					seen.add(k);
					rows.push(csvRow([obj.name, obj.kind, "", "", "found", `From ${rel}`]));
				}
			}
			const csvBody = `${csvRow(dbKind.columns)}\n${rows.length ? `${rows.join("\n")}\n` : ""}`;
			await put(dbCsvPath, csvBody, false);
			created.push(relativeTo(wsRoot, dbCsvPath).split("\\").join("/"));
		}

		if (!hasFilesCsv) {
			const ownRel = relativeTo(wsRoot, filesCsvPath).split("\\").join("/");
			const manifest = (await backend.manifest()).filter((f) => f.path !== ownRel);
			const merged = mergeManifest(null, manifest);
			await put(filesCsvPath, merged.text, false);
			created.push(ownRel);
		}

		setState("treeVersion", (v) => v + 1);
		const legacyNote = legacyMdFiles.length
			? ` Found ${legacyMdFiles.length} legacy Markdown ${legacyMdFiles.length === 1 ? "doc" : "docs"} outside ${areaSaid("docs")}/ (${legacyMdFiles.slice(0, 4).join(", ")}${legacyMdFiles.length > 4 ? "…" : ""}).`
			: "";
		notify(
			created.length
				? `Onboarded workspace: created ${created.join(", ")}.${legacyNote}`
				: `Workspace setup checked; nothing new needed.${legacyNote}`,
		);
	} catch (e: any) {
		notify(`Onboarding error: ${e?.message ?? e}`, "error");
	}
}
