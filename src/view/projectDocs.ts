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
	assembleReleaseBundleCsv,
	assembleReleaseBundleMarkdown,
	assembleReleaseNotesMarkdown,
	assembleRtmCsv,
	assembleRtmMarkdown,
	assembleTestExecutionProtocol,
	assembleTicketPacketMarkdown,
	buildPrintableHtml,
	buildRtmRows,
	classifyDeploymentArtifact,
	demoteMarkdownHeadings,
	detectChecksumDrift,
	escapeHtml,
	evaluateTicketReadiness,
	extractExportMeta,
	inlineExportStyles,
	isTestRunStale,
	markdownToJira,
	parseTestRunDocument,
	renderFrontMatterSummaryHtml,
	transformMarkdownFootnotes,
	type DeploymentManifestRegistry,
	type DeploymentManifestSql,
	type DeploymentRunbookInput,
	type DeploymentRunbookTableDep,
	type PlanBusinessTest,
	type ReleaseBundleCommit,
	type ReleaseBundleInput,
	type ReleaseBundleTicket,
	type TestRunPhase,
	type TestRunSummary,
} from "../shared/docExport";
import { headingAnchor } from "../shared/docTables";
import {
	addToFrontMatterList,
	bodyOffset,
	frontMatter,
	many,
	one,
	quoteYamlScalar,
	removeFrontMatterKey,
	removeFromFrontMatterList,
	replaceInFrontMatterList,
	withFrontMatter,
} from "../shared/frontMatter";
import { documentHeadings, findHeadingLine, parseImageAltSize, upsertTocBlock } from "../shared/markdownEdit";
import { keysIn, ticketColumn } from "../shared/registryTickets";
import {
	diffSqlAgainstSchemaMarkdown,
	extractSqlObjects,
	filterSqlTablesForMarkdown,
	mergeSqlTablesIntoMarkdown,
	parseCreateTables,
	schemaMarkdownToSql,
	sqlTablesToMarkdown,
} from "../shared/sqlSchema";
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
import { ask, browseWorkspaceFile, choose, quickPick, quickPickMany, type QuickPickOption } from "./dialogs";
import { recall, remember } from "./graph/canvas";
import { tasks, toggleTask } from "../shared/tasks";
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
import { activeDoc, activePath, applyText, canonical, changingOnDisk, documents, fileRemoved, fileRenamed, notify, openFile, revert, save, saveSetting, setState, state } from "./state";

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
	if (open?.binary) return null;
	if (open && !open.model.isDisposed()) return open.model.getValue();
	try {
		const res = await backend.read(path);
		return res.binary ? null : res.text;
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
	const openDoc = documents.get(open);
	if (openDoc && !openDoc.binary && !openDoc.model.isDisposed()) {
		const clean = !state.dirty[open];
		if (!applyText(open, text)) throw new Error(`${relativeTo(root(), path)} could not be updated in the editor.`);
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
		const kindPick = await quickPick<string>({
			title: `${key}: ticket type`,
			placeholder: "Choose a ticket type…",
			items: [
				{ label: "Task", value: "Task", icon: "checklist", description: "Implementation or maintenance work item" },
				{ label: "Story", value: "Story", icon: "note", description: "User-facing feature or workflow enhancement" },
				{ label: "Bug", value: "Bug", icon: "bug", description: "Defect or regression fix" },
				{ label: "Epic", value: "Epic", icon: "layers", description: "Multi-ticket initiative or release theme" },
				{ label: "Sub-task", value: "Sub-task", icon: "list-tree", description: "Child item rolled up under a parent ticket" },
			],
		});
		if (!kindPick) return;
		type = kindPick;
		if (kindPick !== "Epic") {
			const parentCandidates = docs()
				.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket && !isArchivedTicket(d))
				.sort((a, b) => (a.ticket ?? "").localeCompare(b.ticket ?? "", undefined, { numeric: true, sensitivity: "base" }));
			if (parentCandidates.length) {
				const parentPick = await quickPick<string>({
					title: `${key}: parent epic or ticket`,
					placeholder: "Filter by ticket key or title, or choose None…",
					items: [
						{ label: "None (top-level ticket)", value: "__none__", icon: "dash" },
						...parentCandidates.map((t, i) => ({
							label: `${t.ticket}: ${t.title || t.name}`,
							value: t.ticket!,
							icon: "checklist" as const,
							badge: t.status ? { text: t.status, tone: toneOf(t.status) } : undefined,
							detail: t.release || undefined,
							divide: i === 0,
							keywords: [t.ticket, t.title, t.status, t.release].filter(Boolean).join(" "),
						})),
						{ label: "Enter another ticket key…", value: "__other__", icon: "edit", divide: true },
					],
				});
				if (!parentPick) return;
				if (parentPick === "__other__") {
					const parentInput = ticketKey((await ask(`${key}: parent epic/ticket key (leave empty for none)`)) ?? "");
					if (parentInput) parent = parentInput;
				} else if (parentPick !== "__none__") {
					parent = parentPick;
				}
			} else {
				const parentInput = ticketKey((await ask(`${key}: parent epic/ticket key (leave empty for none)`)) ?? "");
				if (parentInput) parent = parentInput;
			}
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
	const startRoot = root();
	const clean = canonical(ticketPath);
	const listed = docs().find((d) => d.exists && d.group === "tickets" && canonical(d.path) === clean);
	if (listed?.ticketFolder && isInside(listed.ticketFolder, ticketPath)) {
		notify(`${listed.ticket ?? baseName(ticketPath)} already lives inside its ticket folder (${relativeTo(startRoot, listed.ticketFolder)}/).`);
		return listed.ticketFolder;
	}
	const key = listed?.ticket || ticketKey(baseName(ticketPath).replace(/\.(md|markdown)$/i, ""));
	if (!key) return null;
	const folderPath = listed?.ticketFolder ?? joinPath(dirName(ticketPath), key);
	const targetPath = joinPath(folderPath, baseName(ticketPath));
	const relFolder = relativeTo(startRoot, folderPath).split("\\").join("/");
	const GO = listed?.ticketFolder ? "Move into folder" : "Create folder";
	const answer = await choose(
		`Move ${baseName(ticketPath)} into its own ticket folder (${relFolder}/)? Reference docs, code samples, and fixtures placed there stay accessible via Explorer without cluttering the Docs panel.`,
		[GO],
	);
	if (answer !== GO) return null;
	if (!state.workspace || root() !== startRoot) return null;
	if (state.dirty[clean]) {
		const saved = await save(clean);
		if (!saved) return null;
	}
	const beforeDocs = await backend.docs().catch(() => docs().slice());
	try {
		await backend.rename(ticketPath, targetPath);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
		return null;
	}
	fileRenamed(ticketPath, targetPath);
	setState("treeVersion", (v) => v + 1);
	try {
		await followRename(ticketPath, targetPath, beforeDocs);
	} catch (e: any) {
		notify(`Moved ${baseName(ticketPath)}, but could not update links: ${e?.message ?? e}`, "error");
	}
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
	const startRoot = root();
	const exported = /\.(csv|tsv|json)$/i;
	const open = activePath();
	// Both spelled the one way the editor spells a path: a drive's letter is lowered there.
	const notProjectJson = (p: string) => !isPlanPath(p) && !/^(package|tsconfig|jsconfig|settings)\.json$/i.test(baseName(p)) && !canonical(p).includes("/.ssl-studio/");
	const inFolder = open && exported.test(open) && notProjectJson(open) && !canonical(open).startsWith(canonical(areaFolder("registries"))) ? relativeTo(startRoot, open) : "";
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
		if (!state.workspace || root() !== startRoot) return;
		[typed, from, text] = [baseName(picked.path), picked.path, picked.text];
	} else {
		typed = (await ask("The exported file (CSV or JSON): its path in this folder, or its whole path anywhere", inFolder))?.trim() ?? "";
		if (!typed) return;
		if (!state.workspace || root() !== startRoot) return;
		// As a person writes a path: in quotes when it was copied, from "~" for their own folder, or up and out of this one.
		const said = typed.replace(/^(["'])(.*)\1$/, "$2");
		const home = /^~[\\/]/.test(said);
		const whole = home || /^([A-Za-z]:[\\/]|\/)/.test(said);
		// "." and ".." are taken out before asking where it is: "/project/../Downloads" is not in the project.
		from = home ? said : whole ? resolvePath(said, ".") : resolvePath(startRoot, said);
		const inside = !home && isInside(startRoot, from);
		// In the folder it is read as the editor has it; anywhere else, from the disk, and the backend says why not.
		text = inside ? await current(from) : await backend.readExport(from).catch((e: any) => (notify(String(e?.message ?? e), "error"), null));
		if (!state.workspace || root() !== startRoot) return;
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
	if (!state.workspace || root() !== startRoot) return;
	const existingByKey = new Map(
		freshDocs
			.filter((d) => d.exists && d.group === "tickets" && d.ticket)
			.map((d) => [d.ticket!.toLowerCase(), d.path]),
	);
	const path = (ticket: ImportedTicket) => existingByKey.get(ticket.key.toLowerCase()) ?? joinPath(areaFolder("tickets"), `${ticket.key}.md`);
	const before = await Promise.all(read.tickets.map((ticket) => current(path(ticket))));
	if (!state.workspace || root() !== startRoot) return;
	const here = before.filter((was) => was !== null).length;
	const newCount = read.tickets.length - here;
	let useFolders = false;
	if (newCount > 0) {
		const SINGLE = "Import as single files";
		const FOLDERS = "Import as ticket folders";
		const said = `${read.tickets.length} ${read.tickets.length === 1 ? "ticket" : "tickets"} in ${typed}: ${newCount} new, ${here} already here. Existing tickets keep your notes; state, title, type, parent, source, and links update.`;
		const picked = await choose(said, [FOLDERS, SINGLE]);
		if (!picked) return;
		if (!state.workspace || root() !== startRoot) return;
		useFolders = picked === FOLDERS;
	} else {
		const go = "Update existing";
		const said = `${read.tickets.length} ${read.tickets.length === 1 ? "ticket" : "tickets"} in ${typed}: all ${here} already here. Your notes stay; state, title, type, parent, source, and links update.`;
		if ((await choose(said, [go])) !== go) return;
		if (!state.workspace || root() !== startRoot) return;
	}
	const destPath = (ticket: ImportedTicket) =>
		existingByKey.get(ticket.key.toLowerCase()) ??
		(useFolders ? joinPath(areaFolder("tickets"), ticket.key, `${ticket.key}.md`) : joinPath(areaFolder("tickets"), `${ticket.key}.md`));
	const counts = { made: 0, updated: 0, same: 0, skipped: read.skipped, pulls: read.pulls };
	let failed = 0;
	for (const ticket of read.tickets) {
		if (!state.workspace || root() !== startRoot) break;
		const dest = destPath(ticket);
		// Always re-read at the resolved destination AFTER confirmation (respecting useFolders and live edits).
		const was = await current(dest);
		try {
			if (was === null) {
				let fresh = ticketTemplate(ticket);
				if (ticket.release) fresh = withFrontMatter(fresh, "release", ticket.release) ?? fresh;
				if (ticket.priority) fresh = withFrontMatter(fresh, "priority", ticket.priority) ?? fresh;
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
				now = withFrontMatter(now, k, value) ?? now;
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
		} catch (e: any) {
			failed++;
			notify(`Could not import ${ticket.key}: ${e?.message ?? e}`, "error");
		}
	}
	if (!state.workspace || root() !== startRoot) return;
	if (counts.made || counts.updated) setState("treeVersion", (v) => v + 1);
	if (counts.made || counts.updated || counts.same || !failed) {
		notify(`${importSummary(counts)}${failed ? ` (${failed} failed)` : ""}`);
	}
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
export async function newSchema(id: SchemaKind["id"], inFolder?: string, initialTitle?: string): Promise<boolean> {
	if (!ready()) return false;
	const kind = SCHEMAS.find((known) => known.id === id)!;
	// Asked for with no folder named (the Schema heading, the New menu, the palette), it goes where the project
	// already keeps that kind, whatever capitals the folder is written in; only a project with none gets a new one.
	const kept = docs().find((file) => file.group === "schema" && file.kind === id)?.name.split(/[\\/]/)[0];
	const into = folderParts(inFolder ?? kept ?? id);
	// A folder inside the interfaces' is a system the project exchanges messages with: the message is with it.
	const system = id === "interfaces" ? into[1] : undefined;
	const title = (await ask(id === "database" ? "The table's name, as the database has it" : `The ${kind.one}${system ? ` with ${system}` : ""}, in a few words`, initialTitle ?? ""))?.trim();
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
	const OTHER = "__other__";
	const picked = await quickPick<string>({
		title: "A registry of what?",
		placeholder: "Filter registry templates…",
		items: [
			...REGISTRIES.map((r) => ({
				label: r.title,
				value: r.id,
				icon: "table" as const,
				detail: r.file,
				description: r.about,
				keywords: `${r.id} ${r.file} ${r.columns.join(" ")}`,
			})),
			{
				label: "Another…",
				value: OTHER,
				icon: "add",
				description: "A table of your own: you name its columns.",
				divide: true,
			},
		],
	});
	if (!picked) return;
	const kind = REGISTRIES.find((r) => r.id === picked);
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
	let after = withFrontMatter(before, "status", status);
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
			const targetDecision = await quickPick<DocFile>({
				title: "Which existing decision supersedes this one?",
				placeholder: "Filter decisions by number, title, or status…",
				items: others.map((d) => ({
					label: `${baseName(d.path).replace(/\.(md|markdown)$/i, "")}${d.title ? ` — ${d.title}` : ""}`,
					value: d,
					icon: "note",
					badge: d.status ? { text: d.status, tone: toneOf(d.status) } : undefined,
					detail: relativeTo(root(), d.path).split("\\").join("/"),
					keywords: [d.name, d.title, d.status, ...(d.tickets ?? [])].filter(Boolean).join(" "),
				})),
			});
			if (!targetDecision) return;
			const oldStem = baseName(path).replace(/\.(md|markdown)$/i, "");
			const newStem = baseName(targetDecision.path).replace(/\.(md|markdown)$/i, "");
			let linked = false;
			try {
				const oldText = await current(path);
				if (oldText !== null) {
					const curBy = many(frontMatter(oldText).values["superseded-by"]);
					const updatedOld = curBy.length
						? addToFrontMatterList(oldText, "superseded-by", newStem)
						: withFrontMatter(oldText, "superseded-by", newStem);
					if (updatedOld && updatedOld !== oldText) {
						await put(path, updatedOld, true);
						linked = true;
					}
				}
				const targetText = await current(targetDecision.path);
				if (targetText !== null) {
					const curSup = many(frontMatter(targetText).values.supersedes);
					const updatedTarget = curSup.length
						? addToFrontMatterList(targetText, "supersedes", oldStem)
						: withFrontMatter(targetText, "supersedes", oldStem);
					if (updatedTarget && updatedTarget !== targetText) {
						await put(targetDecision.path, updatedTarget, true);
						linked = true;
					}
				}
				if (linked) setState("treeVersion", (v) => v + 1);
				notify(`Linked ${newStem} as superseding ${oldStem}.`);
			} catch (e: any) {
				if (linked) setState("treeVersion", (v) => v + 1);
				notify(`Could not link superseding decision: ${e?.message ?? e}`, "error");
			}
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
				newBody = withFrontMatter(newBody, "supersedes", oldStem) ?? newBody;
				try {
					const oldText = await current(path);
					if (oldText !== null) {
						const updatedOld = withFrontMatter(oldText, "superseded-by", newStem);
						if (updatedOld && updatedOld !== oldText) await put(path, updatedOld, true);
					}
				} catch (e: any) {
					notify(`Could not update superseded-by on ${baseName(path)}: ${e?.message ?? e}`, "error");
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
/** Returns the 1-based inclusive line range of a catalog's managed `<!-- catalog --> ... <!-- /catalog -->` block, or null. */
export function catalogLineRange(text: string): { from: number; to: number } | null {
	const at = catalogBlock(text);
	if (!at) return null;
	return {
		from: text.slice(0, at.start).split("\n").length,
		to: text.slice(0, at.end).split("\n").length,
	};
}

/**
 * Drops links or wikilinks whose 1-based `line` sits inside a catalog file's managed
 * `<!-- catalog --> ... <!-- /catalog -->` block (ADR 0031). Matches outside catalog markers
 * or in non-catalog files are kept intact.
 */
export function excludeCatalogBlockMatches<T extends { path: string; line: number }>(
	items: readonly T[],
	textByPath: ReadonlyMap<string, string>,
): T[] {
	const lists = new Map<string, { from: number; to: number }>();
	for (const [path, text] of textByPath) {
		if (!isCatalog({ name: path })) continue;
		const range = catalogLineRange(text);
		if (range) lists.set(path, range);
	}
	if (!lists.size) return [...items];
	return items.filter((item) => {
		const list = lists.get(item.path);
		return !list || item.line < list.from || item.line > list.to;
	});
}

/**
 * Drops links/wikilinks that sit inside a catalog's managed `<!-- catalog -->` block:
 * under ADR 0031 catalogs are reconciled explicitly via Update catalogs or the
 * Agent, never partially patched during rename/move prompts. Links written by a
 * person outside the catalog markers are still updated normally.
 */
async function withoutCatalogLists<T extends { path: string; line: number }>(links: T[]): Promise<T[]> {
	const textByPath = new Map<string, string>();
	for (const path of new Set(links.map((link) => link.path))) {
		if (!isCatalog({ name: path })) continue;
		try {
			const text = (await current(path)) ?? (await backend.read(path)).text;
			textByPath.set(path, text);
		} catch {
			// Not there to read: nothing of it is asked about either way.
		}
	}
	return excludeCatalogBlockMatches(links, textByPath);
}

type NormalizedMovePair = { from: string; to: string; fromCanon: string; toCanon: string };

function normalizeMovePairs(rawPairs: readonly { from: string; to: string }[]): NormalizedMovePair[] {
	return rawPairs
		.filter((p) => p.from && p.to && canonical(p.from) !== canonical(p.to))
		.map((p) => ({ from: p.from, to: p.to, fromCanon: canonical(p.from), toCanon: canonical(p.to) }))
		.sort((a, b) => b.fromCanon.length - a.fromCanon.length);
}

/** Rewrites a single plain (non-URL-encoded) workspace or relative path ref when it falls inside `pairs`. */
function rewritePlainPathRef(
	rawRef: string,
	docPath: string,
	pairs: readonly NormalizedMovePair[],
	wsRoot: string,
): string | null {
	const trimmed = rawRef.trim();
	if (!trimmed || /^(?:https?:|mailto:|#)/i.test(trimmed)) return null;
	const hashIdx = trimmed.indexOf("#");
	const pathPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
	const fragPart = hashIdx >= 0 ? trimmed.slice(hashIdx) : "";
	const normPart = pathPart.replace(/\\/g, "/");
	const leadSlash = normPart.startsWith("/");
	const isRel = /^\.{1,2}\//.test(normPart);
	const clean = normPart.replace(/^\/+/, "").replace(/^\.\//, "");
	if (!clean) return null;
	const resolved = isRel ? resolvePath(dirName(docPath), normPart) : resolvePath(wsRoot, clean);
	const canonRes = canonical(resolved);
	for (const pair of pairs) {
		if (canonRes === pair.fromCanon || isInside(pair.fromCanon, canonRes)) {
			const dest = canonRes === pair.fromCanon ? pair.to : joinPath(pair.to, relativeTo(pair.from, resolved));
			let nextPath: string;
			if (isRel) {
				const rel = relativePath(dirName(docPath), dest).split("\\").join("/");
				nextPath = normPart.startsWith("./") && !rel.startsWith(".") ? `./${rel}` : rel;
			} else {
				const rel = relativeTo(wsRoot, dest).split("\\").join("/");
				nextPath = `${leadSlash ? "/" : ""}${rel}`;
			}
			const nextFull = `${nextPath}${fragPart}`;
			return nextFull !== trimmed ? nextFull : null;
		}
	}
	return null;
}

const REGISTRY_FORBIDDEN_COLS = new Set([
	"status",
	"state",
	"note",
	"notes",
	"comment",
	"comments",
	"ticket",
	"tickets",
	"sha256",
	"sha-256",
	"checksum",
	"hash",
	"bytes",
	"lines",
	"kind",
	"type",
	"direction",
]);
const REGISTRY_PATH_COLS = new Set(["path", "file", "script", "scripts", "calls", "used by", "source", "where", "handler", "how"]);

/**
 * Surgically updates exact matching path/script cells in `files.csv` (preserving `status` + `note`)
 * and code columns of `settings.csv`/`database.csv`/`jobs.csv`/`reports.csv` without disturbing
 * unrelated columns or formatting (ADR 0002).
 */
function rewriteRegistryPathsInCsv(
	csvText: string,
	regPath: string,
	pairs: readonly NormalizedMovePair[],
	wsRoot: string,
): { text: string; hits: number } {
	const parsed = parseCsv(csvText);
	if (!parsed.header.length || !parsed.rows.length) return { text: csvText, hits: 0 };
	const fileLower = baseName(regPath).toLowerCase();
	const isFilesManifest = fileLower === "files.csv";
	const eligibleCols = new Set<number>();
	parsed.header.forEach((h, idx) => {
		const col = h.text.trim().toLowerCase();
		if (!col || REGISTRY_FORBIDDEN_COLS.has(col)) return;
		if (isFilesManifest) {
			if (col === "path" || col === "file") eligibleCols.add(idx);
		} else if (REGISTRY_PATH_COLS.has(col)) {
			eligibleCols.add(idx);
		}
	});
	if (!eligibleCols.size) return { text: csvText, hits: 0 };

	const edits: { start: number; end: number; replacement: string }[] = [];
	for (const row of parsed.rows) {
		for (const colIdx of eligibleCols) {
			const cell = row[colIdx];
			if (!cell) continue;
			const raw = cell.text.trim();
			if (!raw) continue;
			const nextVal = rewritePlainPathRef(raw, regPath, pairs, wsRoot);
			if (nextVal && nextVal !== raw) {
				edits.push({ start: cell.start, end: cell.end, replacement: csvCell(nextVal, parsed.delimiter) });
			}
		}
	}
	if (!edits.length) return { text: csvText, hits: 0 };
	let out = csvText;
	for (let i = edits.length - 1; i >= 0; i--) {
		const ed = edits[i]!;
		out = `${out.slice(0, ed.start)}${ed.replacement}${out.slice(ed.end)}`;
	}
	return { text: out, hits: edits.length };
}

/**
 * Surgically rewrites old path strings ONLY on comment-only lines/blocks in `.ssl`/`.srvscr`/`.ds`/`.sql`
 * files using exact range offsets (no SSL parser, pure range edit per ADR 0002 & ADR 0003).
 */
function rewriteCodeCommentPaths(
	text: string,
	codePath: string,
	hits: readonly { link: LinkTo; pair: NormalizedMovePair }[],
	wsRoot: string,
): { text: string; done: number } {
	if (!hits.length) return { text, done: 0 };
	const isSql = /\.sql$/i.test(codePath);
	const parts = text.split(/(\r?\n)/);
	const lineCount = Math.ceil(parts.length / 2);

	// Track comment-only lines/blocks without parsing any SSL/SQL syntax.
	const commentEndCol = new Map<number, number>();
	let inBlock = false;
	for (let li = 0; li < lineCount; li++) {
		const rawLine = parts[li * 2] ?? "";
		const trimmed = rawLine.trim();
		if (isSql) {
			if (inBlock) {
				const closeIdx = rawLine.indexOf("*/");
				if (closeIdx >= 0) {
					inBlock = false;
					if (!rawLine.slice(closeIdx + 2).trim()) commentEndCol.set(li + 1, closeIdx);
				} else {
					commentEndCol.set(li + 1, rawLine.length);
				}
			} else if (trimmed.startsWith("--")) {
				commentEndCol.set(li + 1, rawLine.length);
			} else if (trimmed.startsWith("/*")) {
				const openIdx = rawLine.indexOf("/*");
				const closeIdx = rawLine.indexOf("*/", openIdx + 2);
				if (closeIdx >= 0) {
					if (!rawLine.slice(closeIdx + 2).trim()) commentEndCol.set(li + 1, closeIdx);
				} else {
					inBlock = true;
					commentEndCol.set(li + 1, rawLine.length);
				}
			}
		} else {
			if (inBlock) {
				const semiIdx = rawLine.indexOf(";");
				const starIdx = rawLine.indexOf("*/");
				const closeIdx = semiIdx >= 0 && starIdx >= 0 ? Math.min(semiIdx, starIdx) : semiIdx >= 0 ? semiIdx : starIdx;
				const closeLen = closeIdx === starIdx && starIdx >= 0 ? 2 : 1;
				if (closeIdx >= 0) {
					inBlock = false;
					if (!rawLine.slice(closeIdx + closeLen).trim()) commentEndCol.set(li + 1, closeIdx);
				} else {
					commentEndCol.set(li + 1, rawLine.length);
				}
			} else if (trimmed.startsWith("//")) {
				commentEndCol.set(li + 1, rawLine.length);
			} else if (trimmed.startsWith("/*")) {
				const openIdx = rawLine.indexOf("/*");
				const semiIdx = rawLine.indexOf(";", openIdx + 2);
				const starIdx = rawLine.indexOf("*/", openIdx + 2);
				const closeIdx = semiIdx >= 0 && starIdx >= 0 ? Math.min(semiIdx, starIdx) : semiIdx >= 0 ? semiIdx : starIdx;
				const closeLen = closeIdx === starIdx && starIdx >= 0 ? 2 : 1;
				if (closeIdx >= 0) {
					if (!rawLine.slice(closeIdx + closeLen).trim()) commentEndCol.set(li + 1, closeIdx);
				} else {
					inBlock = true;
					commentEndCol.set(li + 1, rawLine.length);
				}
			}
		}
	}

	const unique = new Map<string, { link: LinkTo; pair: NormalizedMovePair }>();
	for (const h of hits) {
		const k = `${h.link.line}:${h.link.column}:${h.link.href}`;
		if (!unique.has(k)) unique.set(k, h);
	}
	const ordered = [...unique.values()].sort((a, b) => b.link.line - a.link.line || b.link.column - a.link.column);
	let done = 0;
	for (const { link, pair } of ordered) {
		const maxCol = commentEndCol.get(link.line);
		if (maxCol === undefined) continue;
		const idx = (link.line - 1) * 2;
		const rawLine = parts[idx];
		if (rawLine === undefined) continue;
		if (link.column < 0 || link.column + link.href.length > maxCol) continue;
		if (!rawLine.startsWith(link.href, link.column)) continue;
		const target = `${pair.to}${link.rest}`;
		const fromTop = relativeTo(wsRoot, target).split("\\").join("/");
		let instead: string;
		if (link.from === "top") {
			instead = `/${fromTop}`;
		} else if (link.from === "doc") {
			const rel = relativePath(dirName(codePath), target).split("\\").join("/");
			instead = link.href.startsWith("./") && !rel.startsWith(".") ? `./${rel}` : rel;
		} else {
			instead = fromTop;
		}
		if (instead === link.href) continue;
		parts[idx] = `${rawLine.slice(0, link.column)}${instead}${rawLine.slice(link.column + link.href.length)}`;
		done++;
	}
	return { text: done ? parts.join("") : text, done };
}

async function followPaths(
	fromOrPairs: string | readonly { from: string; to: string }[],
	toSingle?: string,
	preloadedByPair?: Map<string, LinkTo[]>,
) {
	if (!state.workspace) return;
	const rawPairs = typeof fromOrPairs === "string" ? [{ from: fromOrPairs, to: toSingle! }] : [...fromOrPairs];
	const pairs = normalizeMovePairs(rawPairs);
	if (!pairs.length) return;
	const canonMoves = pairs.map((p) => ({ from: p.fromCanon, to: p.toCanon }));
	const primary = pairs[0]!;
	const isMovedTarget = (fileCanon: string) =>
		pairs.some((p) => fileCanon === p.toCanon || isInside(p.toCanon, fileCanon));

	// Gather incoming Markdown links across all co-moved paths, matching the most specific move first.
	// Explicitly skip `.plan.json`, CSV registries, and code comment hits so each format uses its own safe rewriter.
	const incomingPairs: { link: LinkTo; pair: NormalizedMovePair }[] = [];
	const seenIncoming = new Set<string>();
	for (const pair of pairs) {
		let links: LinkTo[];
		const cached = preloadedByPair?.get(pair.fromCanon);
		if (cached) {
			links = cached;
		} else {
			try {
				links = await backend.linksTo(pair.from);
			} catch {
				continue;
			}
		}
		const mdOnly = links.filter(
			(link) =>
				link.kind !== "plan" &&
				link.kind !== "registry" &&
				link.kind !== "code" &&
				!isPlanPath(link.path),
		);
		const filtered = await withoutCatalogLists(mdOnly);
		for (const link of filtered) {
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
 * Rewrites matching workspace-relative and doc-relative paths inside `.plan.json` files
 * (`targets`, `scripts`, `testScripts`, `built.units[].script`, `built.tests.script`, and `node.docs`),
 * serializing exclusively via `parsePlan()` / `printPlan()` after user confirmation (ADR 0009).
 */
async function followPlanPaths(rawPairs: readonly { from: string; to: string }[]) {
	if (!state.workspace) return;
	const wsRoot = root();
	const pairs = normalizeMovePairs(rawPairs);
	if (!pairs.length) return;

	const allDocs = await backend.docs().catch(() => docs());
	if (!state.workspace || root() !== wsRoot) return;
	const planDocs = allDocs.filter((d) => d.exists && isPlanPath(d.path));
	if (!planDocs.length) return;

	const rewritePlanText = (rawText: string, planPath: string): { nextText: string; hits: number } | null => {
		const parsed = parsePlan(rawText);
		if (!parsed.plan) return null;
		let hits = 0;
		const plan = parsed.plan;
		const rewriteRef = (rawRef: string) => rewritePlainPathRef(rawRef, planPath, pairs, wsRoot);

		const rewriteEntryList = (list: unknown): unknown => {
			if (!Array.isArray(list)) return list;
			return list.map((entry: unknown) => {
				if (typeof entry === "string") {
					const rep = rewriteRef(entry);
					if (rep) {
						hits++;
						return rep;
					}
					return entry;
				}
				if (entry && typeof entry === "object" && !Array.isArray(entry)) {
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
		};

		const nextTargets = plan.targets !== undefined ? rewriteEntryList(plan.targets) : undefined;
		const nextScripts = plan.scripts !== undefined ? rewriteEntryList(plan.scripts) : undefined;
		const nextTestScripts = plan.testScripts !== undefined ? rewriteEntryList(plan.testScripts) : undefined;

		let nextBuilt = plan.built;
		if (plan.built && typeof plan.built === "object" && !Array.isArray(plan.built)) {
			const builtObj = { ...(plan.built as Record<string, unknown>) };
			let builtChanged = false;
			if (Array.isArray(builtObj.units)) {
				let unitsChanged = false;
				const nextUnits = builtObj.units.map((u: unknown) => {
					if (!u || typeof u !== "object" || Array.isArray(u)) return u;
					const rec = u as Record<string, unknown>;
					if (typeof rec.script !== "string") return u;
					const rep = rewriteRef(rec.script);
					if (!rep) return u;
					hits++;
					unitsChanged = true;
					return { ...rec, script: rep };
				});
				if (unitsChanged) {
					builtObj.units = nextUnits;
					builtChanged = true;
				}
			}
			if (builtObj.tests && typeof builtObj.tests === "object" && !Array.isArray(builtObj.tests)) {
				const testsRec = builtObj.tests as Record<string, unknown>;
				if (typeof testsRec.script === "string") {
					const rep = rewriteRef(testsRec.script);
					if (rep) {
						hits++;
						builtObj.tests = { ...testsRec, script: rep };
						builtChanged = true;
					}
				}
			}
			if (builtChanged) nextBuilt = builtObj;
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

		if (hits <= 0) return null;
		const nextPlan = {
			...plan,
			...(nextTargets !== undefined ? { targets: nextTargets } : {}),
			...(nextScripts !== undefined ? { scripts: nextScripts } : {}),
			...(nextTestScripts !== undefined ? { testScripts: nextTestScripts } : {}),
			...(nextBuilt !== undefined ? { built: nextBuilt } : {}),
			nodes: nextNodes,
		};
		const nextText = printPlan(nextPlan);
		return nextText !== rawText ? { nextText, hits } : null;
	};

	const updates: { path: string; hits: number }[] = [];
	for (const pDoc of planDocs) {
		const rawText = await current(pDoc.path);
		if (rawText === null) continue;
		const res = rewritePlanText(rawText, pDoc.path);
		if (res) updates.push({ path: pDoc.path, hits: res.hits });
	}

	if (!updates.length) return;
	const totalHits = updates.reduce((sum, u) => sum + u.hits, 0);
	const primary = pairs[0]!;
	const where = updates.length === 1 ? relativeTo(wsRoot, updates[0]!.path) : `${updates.length} plans`;
	const said = `${totalHits === 1 ? "One path" : `${totalHits} paths`} in ${where} (targets / scripts / node docs) still ${totalHits === 1 ? "points" : "point"} to ${baseName(primary.from)}.`;
	const go = updates.length === 1 ? "Update plan" : `Update ${updates.length} plans`;
	if ((await choose(said, [go])) !== go) return;
	if (!state.workspace || root() !== wsRoot) return;

	let written = 0;
	let writtenHits = 0;
	for (const item of updates) {
		// Re-read current buffer after confirmation so edits made meanwhile are preserved.
		const freshRaw = await current(item.path);
		if (freshRaw === null) continue;
		const fresh = rewritePlanText(freshRaw, item.path);
		if (!fresh) continue;
		try {
			await put(item.path, fresh.nextText, true);
			written++;
			writtenHits += fresh.hits;
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	}
	if (written) {
		setState("treeVersion", (v) => v + 1);
		notify(`Updated ${writtenHits} ${writtenHits === 1 ? "path" : "paths"} in ${written} ${written === 1 ? "plan" : "plans"} for ${baseName(primary.to)}.`);
	}
}

/**
 * Surgically updates exact matching path/script cells in CSV registries (`files.csv`, `settings.csv`,
 * `database.csv`, `jobs.csv`, `reports.csv`) after ADR 0009 confirmation, preserving `status` and `note`.
 */
async function followRegistryPaths(
	rawPairs: readonly { from: string; to: string }[],
	registryHits: readonly { link: LinkTo; pair: NormalizedMovePair }[],
) {
	if (!state.workspace || !registryHits.length) return;
	const wsRoot = root();
	const pairs = normalizeMovePairs(rawPairs);
	if (!pairs.length) return;
	const isMovedTarget = (fileCanon: string) => pairs.some((p) => fileCanon === p.toCanon || isInside(p.toCanon, fileCanon));

	const uniqueRegPaths = new Map<string, string>();
	for (const { link } of registryHits) {
		const lc = canonical(link.path);
		if (isMovedTarget(lc)) continue;
		if (!uniqueRegPaths.has(lc)) uniqueRegPaths.set(lc, link.path);
	}
	if (!uniqueRegPaths.size) return;

	const updates: { path: string; hits: number }[] = [];
	for (const regPath of uniqueRegPaths.values()) {
		const before = await current(regPath);
		if (before === null) continue;
		const res = rewriteRegistryPathsInCsv(before, regPath, pairs, wsRoot);
		if (res.hits > 0 && res.text !== before) {
			updates.push({ path: regPath, hits: res.hits });
		}
	}
	if (!updates.length) return;

	const totalHits = updates.reduce((sum, u) => sum + u.hits, 0);
	const primary = pairs[0]!;
	const where = updates.length === 1 ? relativeTo(wsRoot, updates[0]!.path) : `${updates.length} registries`;
	const said = `${totalHits === 1 ? "One path cell" : `${totalHits} path cells`} in ${where} still ${totalHits === 1 ? "references" : "reference"} ${baseName(primary.from)}. Status and notes will be preserved.`;
	const go = updates.length === 1 ? "Update registry" : `Update ${updates.length} registries`;
	if ((await choose(said, [go])) !== go) return;
	if (!state.workspace || root() !== wsRoot) return;

	let written = 0;
	let writtenHits = 0;
	for (const item of updates) {
		const freshBefore = await current(item.path);
		if (freshBefore === null) continue;
		const res = rewriteRegistryPathsInCsv(freshBefore, item.path, pairs, wsRoot);
		if (res.hits <= 0 || res.text === freshBefore) continue;
		try {
			await put(item.path, res.text, true);
			written++;
			writtenHits += res.hits;
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	}
	if (written) {
		setState("treeVersion", (v) => v + 1);
		notify(`Updated ${writtenHits} ${writtenHits === 1 ? "path cell" : "path cells"} in ${written} ${written === 1 ? "registry" : "registries"} for ${baseName(primary.to)}.`);
	}
}

/**
 * Surgically rewrites old path strings ONLY on comment-only lines/blocks in `.ssl`/`.srvscr`/`.ds`/`.sql`
 * files after ADR 0009 confirmation (no SSL parser, pure range edit per ADR 0002 & ADR 0003).
 */
async function followCodeCommentLinks(
	rawPairs: readonly { from: string; to: string }[],
	codeHits: readonly { link: LinkTo; pair: NormalizedMovePair }[],
) {
	if (!state.workspace || !codeHits.length) return;
	const wsRoot = root();
	const pairs = normalizeMovePairs(rawPairs);
	if (!pairs.length) return;
	const isMovedTarget = (fileCanon: string) => pairs.some((p) => fileCanon === p.toCanon || isInside(p.toCanon, fileCanon));

	const byFile = new Map<string, { path: string; hits: { link: LinkTo; pair: NormalizedMovePair }[] }>();
	for (const hit of codeHits) {
		const lc = canonical(hit.link.path);
		if (isMovedTarget(lc)) continue;
		const bucket = byFile.get(lc) ?? { path: hit.link.path, hits: [] };
		bucket.hits.push(hit);
		byFile.set(lc, bucket);
	}
	if (!byFile.size) return;

	const updates: { path: string; hits: { link: LinkTo; pair: NormalizedMovePair }[]; count: number }[] = [];
	for (const bucket of byFile.values()) {
		const before = await current(bucket.path);
		if (before === null) continue;
		const res = rewriteCodeCommentPaths(before, bucket.path, bucket.hits, wsRoot);
		if (res.done > 0 && res.text !== before) {
			updates.push({ path: bucket.path, hits: bucket.hits, count: res.done });
		}
	}
	if (!updates.length) return;

	const totalHits = updates.reduce((sum, u) => sum + u.count, 0);
	const primary = pairs[0]!;
	const where = updates.length === 1 ? relativeTo(wsRoot, updates[0]!.path) : `${updates.length} code files`;
	const said = `${totalHits === 1 ? "One comment link" : `${totalHits} comment links`} in ${where} still ${totalHits === 1 ? "references" : "reference"} ${baseName(primary.from)}. Only comment lines will be edited.`;
	const go = updates.length === 1 ? "Update comment" : `Update ${totalHits} comments`;
	if ((await choose(said, [go])) !== go) return;
	if (!state.workspace || root() !== wsRoot) return;

	let written = 0;
	let writtenHits = 0;
	for (const item of updates) {
		const freshBefore = await current(item.path);
		if (freshBefore === null) continue;
		const res = rewriteCodeCommentPaths(freshBefore, item.path, item.hits, wsRoot);
		if (res.done <= 0 || res.text === freshBefore) continue;
		try {
			await put(item.path, res.text, true);
			written++;
			writtenHits += res.done;
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	}
	if (written) {
		setState("treeVersion", (v) => v + 1);
		notify(`Updated ${writtenHits} ${writtenHits === 1 ? "comment reference" : "comment references"} across ${written} ${written === 1 ? "file" : "files"} for ${baseName(primary.to)}.`);
	}
}

/**
 * After a file or a folder is renamed: updates Markdown path links, wikilinks (`[[name]]`),
 * `.plan.json` references, CSV registry path cells, and code-comment references — each asked
 * about clearly and written only on the user's word (ADR 0009).
 */
export async function followRename(from: string, to: string, beforeDocs?: DocFile[], coMoved?: readonly { from: string; to: string }[]) {
	// Prefer a caller-provided pre-rename snapshot so `followNames` never races an async `docs()` refresh.
	const listed = (beforeDocs ?? docs()).map((file) => ({ ...file, path: canonical(file.path) }));
	const allPairs = coMoved?.length ? [{ from, to }, ...coMoved] : [{ from, to }];
	const normalized = normalizeMovePairs(allPairs);
	const preloadedByPair = new Map<string, LinkTo[]>();
	const registryHits: { link: LinkTo; pair: NormalizedMovePair }[] = [];
	const codeHits: { link: LinkTo; pair: NormalizedMovePair }[] = [];

	for (const pair of normalized) {
		try {
			const links = await backend.linksTo(pair.from);
			preloadedByPair.set(pair.fromCanon, links);
			for (const link of links) {
				if (link.kind === "registry") registryHits.push({ link, pair });
				else if (link.kind === "code") codeHits.push({ link, pair });
			}
		} catch {
			// Skip unreadable pair cleanly.
		}
	}

	await followPaths(coMoved?.length ? allPairs : from, to, preloadedByPair);
	await followNames(allPairs, listed);
	await followPlanPaths(allPairs);
	await followRegistryPaths(allPairs, registryHits);
	await followCodeCommentLinks(allPairs, codeHits);
}

/**
 * The links by name ([[name]]) a rename leaves behind: those that no longer
 * mean the document they meant, whether they named it by its file's name,
 * its path or what it called itself, and those whose name the renamed file
 * took. A name that still means its document is left alone. Only the name
 * is written anew, through the editor where the document is open. `listed`
 * is the project's documents as they were in hand when the rename was made.
 */
async function followNames(rawPairs: readonly { from: string; to: string }[], listed: DocFile[]) {
	if (!state.workspace || !rawPairs.length) return;
	const wsRoot = root();
	const pairs = normalizeMovePairs(rawPairs);
	if (!pairs.length) return;
	const primary = { from: rawPairs[0]!.from, to: rawPairs[0]!.to };
	const was = canonical(primary.from);
	const is = canonical(primary.to);
	const under = (path: string, base: string) => path === base || (isInside(base, path) && path.length > base.length);
	const moved = (path: string) => {
		for (const p of pairs) {
			if (under(path, p.fromCanon)) return p.toCanon + path.slice(p.fromCanon.length);
		}
		return path;
	};
	const pairsByTo = [...pairs].sort((a, b) => b.toCanon.length - a.toCanon.length);
	const unmoved = (path: string) => {
		for (const p of pairsByTo) {
			if (under(path, p.toCanon)) return p.fromCanon + path.slice(p.toCanon.length);
		}
		return path;
	};
	const anyUnderFrom = (files: readonly DocFile[]) => files.some((file) => pairs.some((p) => under(file.path, p.fromCanon)));
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
	if (!state.workspace || root() !== wsRoot) return;
	const before = anyUnderFrom(listed)
		? listed
		: after.map((file) => {
				const orig = unmoved(file.path);
				return orig !== file.path ? { ...file, path: orig } : file;
			});
	let places: NameIn[];
	try {
		places = (await backend.namesIn()).map((place) => ({ ...place, path: canonical(place.path) }));
	} catch {
		return;
	}
	if (!state.workspace || root() !== wsRoot) return;
	// Respect ADR 0031: never rewrite wikilinks inside managed `<!-- catalog --> ... <!-- /catalog -->` blocks.
	places = await withoutCatalogLists(places);
	const follow: (NameIn & { instead: string })[] = anyUnderFrom(before)
		? namesToFollow(places, before, after, moved, wsRoot)
		: [];

	// Also rewrite non-doc wikilink/embed references such as `![[old.png]]` or `![[samples/old.sql]]` across all co-moved pairs.
	const seenFollow = new Set(follow.map((p) => `${p.path}:${p.line}:${p.column}`));
	for (const place of places) {
		const key = `${place.path}:${place.line}:${place.column}`;
		if (seenFollow.has(key)) continue;
		const raw = place.name.replace(/\\/g, "/").trim();
		if (!raw) continue;
		const placeOrigPath = unmoved(place.path);
		const placeOrigDir = dirName(placeOrigPath);
		const placeCurDir = dirName(place.path);
		let instead: string | null = null;
		if (raw.includes("/")) {
			const cleanRaw = raw.replace(/^\.\//, "");
			const candDoc = canonical(resolvePath(placeOrigDir, cleanRaw));
			const candRoot = canonical(resolvePath(wsRoot, cleanRaw.replace(/^\/+/, "")));
			const hitDoc = pairs.find((p) => under(candDoc, p.fromCanon));
			const hitRoot = !hitDoc ? pairs.find((p) => under(candRoot, p.fromCanon)) : undefined;
			if (hitDoc) {
				const destPath = moved(candDoc);
				const rel = relativePath(placeCurDir, destPath).split("\\").join("/");
				instead = raw.startsWith("./") && !rel.startsWith(".") ? `./${rel}` : rel;
			} else if (hitRoot) {
				const destPath = moved(candRoot);
				const rel = relativeTo(wsRoot, destPath).split("\\").join("/");
				instead = raw.startsWith("/") ? `/${rel}` : rel;
			} else if (canonical(placeOrigDir) !== canonical(placeCurDir) && /^\.{1,2}\//.test(raw)) {
				const rel = relativePath(placeCurDir, candDoc).split("\\").join("/");
				instead = raw.startsWith("./") && !rel.startsWith(".") ? `./${rel}` : rel;
			}
		} else {
			for (const p of pairs) {
				const oldBase = baseName(p.fromCanon);
				const newBase = baseName(p.toCanon);
				if (raw.toLowerCase() !== oldBase.toLowerCase()) continue;
				if (!((place as NameIn & { embed?: boolean }).embed || /\.[a-z0-9]{1,8}$/i.test(oldBase))) continue;
				if (oldBase.toLowerCase() !== newBase.toLowerCase()) {
					instead = newBase;
				} else if (canonical(dirName(p.fromCanon)) === canonical(placeOrigDir) && canonical(dirName(p.toCanon)) !== canonical(placeCurDir)) {
					instead = relativePath(placeCurDir, p.toCanon).split("\\").join("/");
				}
				break;
			}
		}
		if (instead && instead !== place.name) {
			seenFollow.add(key);
			follow.push({ ...place, instead });
		}
	}

	if (follow.length) {
		const holders = [...new Set(follow.map((place) => place.path))];
		const where = holders.length === 1 ? relativeTo(wsRoot, holders[0]!) : `${holders.length} documents`;
		const said = `${follow.length === 1 ? "One link by name" : `${follow.length} links by name`} in ${where} no longer ${follow.length === 1 ? "means what it" : "mean what they"} meant, now that ${baseName(primary.from)} is ${baseName(primary.from) === baseName(primary.to) ? `in ${relativeTo(wsRoot, dirName(primary.to)) || "the project's folder"}` : baseName(primary.to)}.`;
		const go = follow.length === 1 ? "Update it" : "Update them";
		if ((await choose(said, [go])) === go && state.workspace && root() === wsRoot) {
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
			if (done) notify(`${done} ${done === 1 ? "link by name was" : "links by name were"} written anew for ${baseName(primary.to)}.`);
			const left = follow.length - done;
			if (left > 0) notify(`${left} of them ${left === 1 ? "is" : "are"} not where ${left === 1 ? "it was" : "they were"}: the document has changed since. Mend ${left === 1 ? "it" : "them"} in the text.`, "error");
		}
	}

	// Follow decision `supersedes:` / `superseded-by:` frontmatter stems when renaming a decision file.
	const movedDecision =
		before.find((file) => file.path === was && file.group === "knowledge" && file.kind === "decisions") ??
		after.find((file) => file.path === is && file.group === "knowledge" && file.kind === "decisions");
	const oldStem = baseName(was).replace(/\.(md|markdown)$/i, "");
	const newStem = baseName(is).replace(/\.(md|markdown)$/i, "");
	if (movedDecision && oldStem && newStem && oldStem.toLowerCase() !== newStem.toLowerCase()) {
		const decisionTargets: string[] = [];
		for (const doc of after) {
			if (!doc.exists || doc.group !== "knowledge" || doc.kind !== "decisions" || doc.path === is || isCatalog(doc)) continue;
			const text = await current(doc.path);
			if (text === null) continue;
			let next = text;
			for (const field of ["supersedes", "superseded-by"]) {
				next = replaceInFrontMatterList(next, field, oldStem, newStem) ?? next;
			}
			if (next !== text) decisionTargets.push(doc.path);
		}
		if (decisionTargets.length) {
			const count = decisionTargets.length;
			const go = count === 1 ? "Update decision link" : `Update ${count} decisions`;
			const said = `${count === 1 ? "One decision" : `${count} decisions`} still ${count === 1 ? "references" : "reference"} ${oldStem} in supersedes / superseded-by frontmatter.`;
			if ((await choose(said, [go])) === go && state.workspace && root() === wsRoot) {
				let updatedCount = 0;
				for (const targetPath of decisionTargets) {
					const freshText = await current(targetPath);
					if (freshText === null) continue;
					let next = freshText;
					for (const field of ["supersedes", "superseded-by"]) {
						next = replaceInFrontMatterList(next, field, oldStem, newStem) ?? next;
					}
					if (next === freshText) continue;
					try {
						await put(targetPath, next, true);
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
export function staleCatalogSummary(files?: readonly DocFile[]): { stale: DocFile[]; missing: string[]; prompt: string } {
	const all = files ?? docs();
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

	const kindIcon = (f: DocFile) =>
		f.group === "plans"
			? ("graph" as const)
			: f.group === "specs"
				? ("file" as const)
				: f.group === "tickets"
					? ("checklist" as const)
					: f.group === "schema"
						? ("database" as const)
						: f.kind === "questions"
							? ("question" as const)
							: ("note" as const);

	const target = await quickPick<DocFile>({
		title: `Link an existing document to ${key}`,
		placeholder: "Filter specs, plans, tickets, decisions, questions, or schema docs…",
		items: candidates.map((f) => {
			const title =
				f.group === "plans"
					? f.name.replace(/\.plan\.json$/i, "")
					: f.group === "tickets" && f.ticket
						? `${f.ticket}: ${f.title || f.name}`
						: f.title || f.name;
			const relPath = rel(f.path);
			const actionDetail =
				f.group === "specs"
					? `Adds ${relPath} to specs: in ${baseName(ticketPath)}`
					: f.group === "plans"
						? `Adds ${relPath} to plans: in ${baseName(ticketPath)}`
						: f.group === "tickets"
							? `Link ${f.ticket} as related, sub-ticket, blocks, or blocked-by`
							: `Adds ${key} to ticket: in ${relPath}'s frontmatter`;
			return {
				label: `${kindTag(f)}: ${title}`,
				value: f,
				icon: kindIcon(f),
				badge: f.status ? { text: f.status, tone: toneOf(f.status) } : undefined,
				detail: relPath,
				description: actionDetail,
				keywords: [kindTag(f), f.ticket, f.title, f.name, relPath, f.status].filter(Boolean).join(" "),
			};
		}),
	});
	if (!target) return;

	try {
		if (target.group === "tickets") {
			const otherKey = target.ticket ?? target.name;
			const relation = await quickPick<"related" | "sub" | "blocks" | "blocked-by">({
				title: `How does ${otherKey} relate to ${key}?`,
				placeholder: "Choose ticket relationship…",
				searchable: false,
				items: [
					{ label: "Related to", value: "related", icon: "references", description: `Adds ${otherKey} to related: in ${baseName(ticketPath)}` },
					{ label: `Sub-ticket of ${key}`, value: "sub", icon: "list-tree", description: `Sets parent: ${key} on ${otherKey}` },
					{ label: `${key} blocks ${otherKey}`, value: "blocks", icon: "warning", description: `Adds ${otherKey} to blocks: in ${baseName(ticketPath)}` },
					{ label: `${key} is blocked by ${otherKey}`, value: "blocked-by", icon: "warning", description: `Adds ${otherKey} to blocked-by: in ${baseName(ticketPath)}` },
				],
			});
			if (!relation) return;
			if (relation === "sub") {
				const before = await current(target.path);
				if (before === null) return;
				const next = withFrontMatter(before, "parent", key);
				if (next && next !== before) await put(target.path, next, true);
				setState("treeVersion", (v) => v + 1);
				notify(`Set parent: ${key} on ${otherKey}.`);
				return;
			}
			const field = relation === "blocks" ? "blocks" : relation === "blocked-by" ? "blocked-by" : "related";
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
	const startRoot = root();
	const before = await current(docPath);
	if (before === null) return;
	const fm = frontMatter(before);
	const existingSingle = many(fm.values.ticket);
	const existingMulti = many(fm.values.tickets);
	const already = new Set([...existingSingle, ...existingMulti].map((k) => k.toLowerCase()));
	const tickets = docs().filter((d) => d.exists && d.group === "tickets" && d.ticket && !isCatalog(d) && !already.has(d.ticket.toLowerCase()));
	if (!tickets.length) return notify(already.size ? "This document is already linked to every ticket in the project." : "No tickets exist in this project yet.");
	const ticket = await quickPick<DocFile>({
		title: `Link ${baseName(docPath)} to a ticket`,
		placeholder: "Filter by ticket key, title, status, or release…",
		items: tickets.map((t) => ({
			label: `${t.ticket}: ${t.title || t.name}`,
			value: t,
			icon: "checklist",
			badge: t.status ? { text: t.status, tone: toneOf(t.status) } : undefined,
			detail: t.release || undefined,
			keywords: [t.ticket, t.title, t.status, t.release].filter(Boolean).join(" "),
		})),
	});
	if (!ticket?.ticket) return;
	if (!state.workspace || root() !== startRoot) return;
	// Re-read current buffer after modal so edits made meanwhile are preserved.
	const fresh = await current(docPath);
	if (fresh === null) return;
	const freshFm = frontMatter(fresh);
	const freshSingle = many(freshFm.values.ticket);
	const freshMulti = many(freshFm.values.tickets);
	let next: string | null = fresh;
	if (freshMulti.length) next = addToFrontMatterList(fresh, "tickets", ticket.ticket);
	else if (freshSingle.length) {
		const merged = [...new Set([...freshSingle, ticket.ticket])];
		let cleared = fresh;
		for (const prev of freshSingle) cleared = removeFromFrontMatterList(cleared, "ticket", prev) ?? cleared;
		next = cleared;
		for (const t of merged) next = addToFrontMatterList(next, "tickets", t) ?? next;
	} else next = withFrontMatter(fresh, "ticket", ticket.ticket);
	if (next && next !== fresh) {
		try {
			await put(docPath, next, true);
			setState("treeVersion", (v) => v + 1);
			notify(`Linked ${baseName(docPath)} to ${ticket.ticket}.`);
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	}
}

/** Appends a new row to a chosen CSV registry pre-filled with `key` in its Ticket column (adding a `ticket` column if missing). */
export async function addRegistryRowForTicket(key: string, initialItem?: string): Promise<void> {
	if (!ready()) return;
	const startRoot = root();
	const regs = docs().filter((d) => d.exists && d.group === "registries" && !isCatalog(d) && /\.(csv|tsv)$/i.test(d.name));
	if (!regs.length) return notify("No CSV registries exist yet. Create one from Docs -> New -> New registry….");
	const reg =
		regs.length === 1
			? regs[0]!
			: await quickPick<DocFile>({
					title: `Add a row for ${key} to which registry?`,
					placeholder: "Filter registries…",
					items: regs.map((r) => ({
						label: registryTitle(r.name),
						value: r,
						icon: "table",
						detail: r.name,
						keywords: `${registryTitle(r.name)} ${r.name}`,
					})),
				});
	if (!reg) return;
	if (!state.workspace || root() !== startRoot) return;
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
		if (!state.workspace || root() !== startRoot) return;
		addTicketCol = true;
	}
	const firstCol = table.header[0]!.text.trim() || "item";
	const name = (await ask(`New ${firstCol} for ${key} in ${reg.name}`, initialItem ?? ""))?.trim();
	if (!name) return;
	if (!state.workspace || root() !== startRoot) return;
	// Re-read current CSV after user prompts so edits made meanwhile are preserved.
	const freshText = await current(reg.path);
	if (freshText === null) return;
	const freshTable = parseCsv(freshText);
	if (!freshTable.header.length) return notify(`${reg.name} has no header row.`, "error");
	const nl = freshText.includes("\r\n") ? "\r\n" : "\n";
	let nextText = freshText;
	if (addTicketCol && ticketColumn(freshTable) < 0) {
		const headerVals = [...freshTable.header.map((h) => h.text), "ticket"];
		const dataLines = freshTable.rows.map((r) => csvRow([...r.map((c) => c.text), ""], freshTable.delimiter));
		const newRow = headerVals.map((h, idx) => {
			const col = h.trim().toLowerCase();
			if (idx === 0) return name;
			if (col === "ticket") return key;
			if (col === "status") return "found";
			return "";
		});
		nextText = [csvRow(headerVals, freshTable.delimiter), ...dataLines, csvRow(newRow, freshTable.delimiter)].join(nl) + nl;
	} else {
		const row = freshTable.header.map((h, idx) => {
			const col = h.text.trim().toLowerCase();
			if (idx === 0) return name;
			if (col === "ticket" || col === "tickets") return key;
			if (col === "status") return "found";
			return "";
		});
		const prefix = freshText && !/\r?\n$/.test(freshText) ? nl : "";
		nextText = `${freshText}${prefix}${csvRow(row, freshTable.delimiter)}${nl}`;
	}
	try {
		await put(reg.path, nextText, true);
		setState("treeVersion", (v) => v + 1);
		notify(`Added “${name}” to ${reg.name} for ${key}.`);
		await openFile(reg.path);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
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
	const startRoot = root();
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
		if (!stillExists) {
			await clearActiveIfMatching().catch(() => {});
			setState("treeVersion", (v) => v + 1);
		}
		return;
	}
	const folder = file.ticketFolder;
	const relFolder = relativeTo(startRoot, folder).split("\\").join("/");
	const count = file.ticketFileCount ?? file.ticketFiles?.length ?? 0;
	const allDocs = docs();
	const isSelf = (p: string) => canonical(p) === canonical(file.path) || isInside(canonical(folder), canonical(p));
	const [incomingDoc, incomingFolder, allNames] = await Promise.all([
		backend.linksTo(file.path).catch(() => []),
		backend.linksTo(folder).catch(() => []),
		backend.namesIn().catch(() => []),
	]);
	if (!state.workspace || root() !== startRoot) return;
	const outsideRefs = new Set<string>();
	for (const l of [...incomingDoc, ...incomingFolder]) {
		if (!isCatalog({ name: l.path }) && !isSelf(l.path)) outsideRefs.add(canonical(l.path));
	}
	const nameIdx = buildDocNameIndex(allDocs, startRoot);
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
	if (!state.workspace || root() !== startRoot) return;
	const { retargetScopedFolder } = await import("./panels/Explorer");
	let primaryTrashed = false;
	try {
		if (picked === TRASH_ALL) {
			if (isLayout2) {
				await backend.trash(file.path);
				fileRemoved(file.path);
				primaryTrashed = true;
			}
			await backend.trash(folder);
			fileRemoved(folder);
			primaryTrashed = true;
			retargetScopedFolder(folder, null);
			await clearActiveIfMatching().catch(() => {});
			setState("treeVersion", (v) => v + 1);
			notify(`Moved ${isLayout2 ? `${baseName(file.path)} and ` : ""}${relFolder}/ to the trash.`);
		} else {
			await backend.trash(file.path);
			fileRemoved(file.path);
			primaryTrashed = true;
			await clearActiveIfMatching().catch(() => {});
			setState("treeVersion", (v) => v + 1);
			notify(`Moved ${relativeTo(startRoot, file.path)} to the trash.`);
		}
	} catch (e: any) {
		if (primaryTrashed) {
			await clearActiveIfMatching().catch(() => {});
			setState("treeVersion", (v) => v + 1);
		}
		notify(String(e?.message ?? e), "error");
	}
}

/** Bundle-aware ticket key rename (`TEMP-1` -> `LIMS-456`): handles Layout 1, Layout 2, and flat tickets; updates wikilinks, paths, plans, and CSV ticket cells. */
export async function renameTicket(file: DocFile): Promise<void> {
	if (!ready()) return;
	const startRoot = root();
	const oldKey = file.ticket;
	if (!oldKey) {
		await (await import("./panels/Explorer")).renameFile(file.path);
		return;
	}
	const typed = (await ask(`Rename ticket key ${oldKey} to`, oldKey))?.trim();
	const newKey = ticketKey(typed ?? "");
	if (!newKey || newKey === oldKey) return;
	if (!state.workspace || root() !== startRoot) return;

	const beforeDocs = await backend.docs();
	if (!state.workspace || root() !== startRoot) return;
	const duplicate = beforeDocs.find(
		(d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === newKey.toLowerCase() && canonical(d.path) !== canonical(file.path),
	);
	if (duplicate) {
		notify(`Ticket ${newKey} already exists at ${relativeTo(startRoot, duplicate.path)}.`, "error");
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
	} catch (e: any) {
		setState("treeVersion", (v) => v + 1);
		notify(String(e?.message ?? e), "error");
		return;
	}

	// Always update activeTicket right after rename succeeds so follow-up errors/cancels never leave it stale.
	if (state.settings.activeTicket?.trim().toLowerCase() === oldKey.toLowerCase()) {
		await saveSetting({ activeTicket: newKey }, "workspace").catch(() => {});
	}

	// Update `ticket:` frontmatter + body-only H1 BEFORE `followRename` so `followNames` detects `[[OLD]]` -> `[[NEW]]`.
	try {
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
	} catch (e: any) {
		notify(`Renamed file, but could not update header in ${baseName(toPath)}: ${e?.message ?? e}`, "error");
	}

	// Follow incoming file path links & [[wikilinks]] atomically with all co-moved bundle paths so intra-bundle links stay intact.
	const coMoved = oldFolder && newFolder && canonical(oldFolder) !== canonical(newFolder) ? [{ from: oldFolder, to: newFolder }] : undefined;
	try {
		await followRename(file.path, toPath, beforeDocs, coMoved);
	} catch (e: any) {
		notify(`Renamed ${oldKey} to ${newKey}, but could not follow some links: ${e?.message ?? e}`, "error");
	}

	// Collect candidate ticket key refactoring edits across Markdown docs, plans, and CSV registries (Ticket column only!).
	const candidates: { docPath: string; kind: "plan" | "registry" | "markdown" }[] = [];
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
				candidates.push({ docPath, kind: "plan" });
			}
		} else if (doc.group === "registries" && /\.(csv|tsv)$/i.test(doc.name)) {
			const next = replaceTicketKeyInCsv(text, oldKey, newKey);
			if (next !== text) candidates.push({ docPath, kind: "registry" });
		} else if (isMarkdown(docPath)) {
			let next = text;
			for (const field of ["ticket", "tickets", "parent", "related", "blocks", "blocked-by"]) {
				next = replaceInFrontMatterList(next, field, oldKey, newKey) ?? next;
			}
			if (next !== text) candidates.push({ docPath, kind: "markdown" });
		}
	}

	let refactored = 0;
	if (candidates.length && state.workspace && root() === startRoot) {
		const preview =
			candidates
				.slice(0, 4)
				.map((c) => relativeTo(startRoot, c.docPath).split("\\").join("/"))
				.join(", ") + (candidates.length > 4 ? ` and ${candidates.length - 4} more` : "");
		const GO = candidates.length === 1 ? "Update reference" : `Update ${candidates.length} files`;
		const picked = await choose(
			`${candidates.length} other ${candidates.length === 1 ? "file references" : "files reference"} ${oldKey} in frontmatter, plan metadata, or registry Ticket columns (${preview}). Update ${candidates.length === 1 ? "it" : "them"} to ${newKey}?`,
			[GO],
		);
		if (picked === GO && state.workspace && root() === startRoot) {
			for (const cand of candidates) {
				const text = await current(cand.docPath);
				if (text === null) continue;
				let next: string | null = null;
				if (cand.kind === "plan") {
					const parsed = parsePlan(text);
					if (parsed.plan && typeof parsed.plan.ticket === "string" && parsed.plan.ticket.toLowerCase() === oldKey.toLowerCase()) {
						next = printPlan({ ...parsed.plan, ticket: newKey });
					}
				} else if (cand.kind === "registry") {
					const updatedCsv = replaceTicketKeyInCsv(text, oldKey, newKey);
					if (updatedCsv !== text) next = updatedCsv;
				} else {
					let updatedMd = text;
					for (const field of ["ticket", "tickets", "parent", "related", "blocks", "blocked-by"]) {
						updatedMd = replaceInFrontMatterList(updatedMd, field, oldKey, newKey) ?? updatedMd;
					}
					if (updatedMd !== text) next = updatedMd;
				}
				if (next === null || next === text) continue;
				try {
					await put(cand.docPath, next, true);
					refactored++;
				} catch (e: any) {
					notify(`Could not update ${baseName(cand.docPath)}: ${e?.message ?? e}`, "error");
				}
			}
		}
	}
	setState("treeVersion", (v) => v + 1);
	notify(`Renamed ${oldKey} to ${newKey}${refactored ? ` and updated ${refactored} referencing ${refactored === 1 ? "file" : "files"}` : ""}.`);
}

/** Moves a flat ticket, Layout 1 bundle, or Layout 2 ticket + sibling folder cleanly into `<tickets>/archive/`. */
export async function archiveTicket(file: DocFile): Promise<void> {
	if (!ready()) return;
	const startRoot = root();
	const ticketsRoot = areaFolder("tickets");
	const archiveDir = joinPath(ticketsRoot, "archive");
	const relArchive = relativeTo(startRoot, archiveDir).split("\\").join("/");
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
	if (!state.workspace || root() !== startRoot) return;
	const beforeDocs = await backend.docs();
	if (!state.workspace || root() !== startRoot) return;
	const { retargetScopedFolder } = await import("./panels/Explorer");
	try {
		if (!(await saveDirtyUnder(fromSibling ? [fromPrimary, fromSibling] : [fromPrimary]))) {
			notify("Save unsaved edits before archiving this ticket.", "error");
			return;
		}
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
	} catch (e: any) {
		setState("treeVersion", (v) => v + 1);
		notify(String(e?.message ?? e), "error");
		return;
	}
	// Update status on the moved path AFTER rename succeeds so a failed/rolled-back move never leaves mutated status behind.
	const movedTicketPath = isLayout1
		? joinPath(toPrimary, ...relativeTo(fromPrimary, file.path).split(/[\\/]/))
		: toPrimary;
	if (picked === ARCHIVE_DONE) {
		await setStatus(movedTicketPath, "done");
	}
	if (file.ticket && state.settings.activeTicket?.trim().toLowerCase() === file.ticket.toLowerCase()) {
		await saveSetting({ activeTicket: null }, "workspace").catch(() => {});
	}
	setState("treeVersion", (v) => v + 1);
	try {
		const coMoved = fromSibling && toSibling ? [{ from: fromSibling, to: toSibling }] : undefined;
		await followRename(fromPrimary, toPrimary, beforeDocs, coMoved);
	} catch (e: any) {
		notify(`Archived ${file.ticket ?? baseName(fromPrimary)}, but could not update links: ${e?.message ?? e}`, "error");
	}
	notify(`Archived ${file.ticket ?? baseName(fromPrimary)} to ${relArchive}/.`);
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
	const startRoot = root();
	const ticketsRoot = areaFolder("tickets");
	const archiveDir = joinPath(ticketsRoot, "archive");
	if (!isInside(archiveDir, file.path)) return notify(`${file.ticket ?? baseName(file.path)} is not in archive/.`);

	const isLayout1 = Boolean(file.ticketFolder && isInside(file.ticketFolder, file.path));
	const isLayout2 = Boolean(file.ticketFolder && !isLayout1);
	const fromPrimary = isLayout1 ? file.ticketFolder! : file.path;
	const toPrimary = joinPath(ticketsRoot, baseName(fromPrimary));
	const fromSibling = isLayout2 ? file.ticketFolder! : null;
	const toSibling = fromSibling ? joinPath(ticketsRoot, baseName(fromSibling)) : null;

	const relTickets = relativeTo(startRoot, ticketsRoot).split("\\").join("/");
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
	if (!state.workspace || root() !== startRoot) return;
	const beforeDocs = await backend.docs();
	if (!state.workspace || root() !== startRoot) return;
	const { retargetScopedFolder } = await import("./panels/Explorer");
	try {
		if (!(await saveDirtyUnder(fromSibling ? [fromPrimary, fromSibling] : [fromPrimary]))) {
			notify("Save unsaved edits before unarchiving this ticket.", "error");
			return;
		}
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
	} catch (e: any) {
		setState("treeVersion", (v) => v + 1);
		notify(String(e?.message ?? e), "error");
		return;
	}
	const movedTicketPath = isLayout1
		? joinPath(toPrimary, ...relativeTo(fromPrimary, file.path).split(/[\\/]/))
		: toPrimary;
	if (picked === RESTORE_ACTIVE) {
		await setStatus(movedTicketPath, "in progress");
	}
	setState("treeVersion", (v) => v + 1);
	try {
		const coMoved = fromSibling && toSibling ? [{ from: fromSibling, to: toSibling }] : undefined;
		await followRename(fromPrimary, toPrimary, beforeDocs, coMoved);
	} catch (e: any) {
		notify(`Restored ${file.ticket ?? baseName(fromPrimary)}, but could not update links: ${e?.message ?? e}`, "error");
	}
	notify(`Restored ${file.ticket ?? baseName(fromPrimary)} to ${relTickets}/.`);
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
 * When `targetDocPath` is provided and exists, updates that exact file in place.
 */
export async function generateSchemaDocFromSql(sqlPath?: string, targetDocPath?: string): Promise<void> {
	if (!ready()) return;
	let sourcePath = sqlPath;
	if (!sourcePath) {
		const sqlFiles = docs().filter((d) => d.exists && d.group === "schema" && /\.(sql|ddl|pks|pkb)$/i.test(d.name));
		const BROWSE = "__browse__";
		if (!sqlFiles.length) {
			const browsed = await browseWorkspaceFile({
				title: "Choose a SQL/DDL file to document",
				root: root(),
				initialDir: schemaFolder(),
			});
			if (!browsed) return;
			sourcePath = browsed.path;
		} else {
			const picked = await quickPick<string>({
				title: "Choose a SQL file to document database objects from",
				placeholder: "Filter schema SQL files or browse workspace…",
				items: [
					...sqlFiles.map((f) => ({
						label: baseName(f.name),
						value: f.path,
						file: baseName(f.name),
						detail: relativeTo(root(), f.path).split("\\").join("/"),
						keywords: `${f.name} ${f.title ?? ""}`,
					})),
					{
						label: "Browse workspace for another SQL file…",
						value: BROWSE,
						icon: "folder",
						divide: true,
					},
				],
			});
			if (!picked) return;
			if (picked === BROWSE) {
				const browsed = await browseWorkspaceFile({
					title: "Choose a SQL/DDL file to document",
					root: root(),
					initialDir: schemaFolder(),
				});
				if (!browsed) return;
				sourcePath = browsed.path;
			} else {
				sourcePath = picked;
			}
		}
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
	const directTargetMd = targetDocPath ? await current(targetDocPath) : null;

	// Handle Views, Stored Procedures, Functions, Triggers, Packages, Sequences, Synonyms, and Types when no CREATE TABLE exists.
	if (!tables.length) {
		const objects = extractSqlObjects(sqlText, { includeAlter: true }).filter((o) => o.kind !== "index");
		if (!objects.length) {
			return notify(`No CREATE/ALTER SQL objects (tables, views, procedures, functions, triggers, or packages) were found in ${baseName(sourcePath)}.`);
		}
		let dest: string;
		let docTitle: string;
		if (targetDocPath && directTargetMd !== null) {
			dest = targetDocPath;
			docTitle = objects.length === 1 ? objects[0]!.bareName : baseName(targetDocPath).replace(/\.(md|markdown)$/i, "");
		} else {
			const defaultName = objects.length === 1 ? objects[0]!.bareName : baseName(sourcePath).replace(/\.[^.]+$/, "");
			const name = (await ask(`Schema document name (saved under ${state.project!.schema}/${dbSubfolder}/)`, defaultName))?.trim();
			if (!name) return;
			const named = typedParts(name, "file");
			if ("problem" in named || named.parts.length !== 1) return notify("Give a single valid filename.", "error");
			dest = joinPath(schemaFolder(), dbSubfolder, `${named.parts[0]}.md`);
			docTitle = objects.length === 1 ? objects[0]!.bareName : name;
		}
		const existingMd = dest === targetDocPath ? directTargetMd : await current(dest);
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
			try {
				await put(dest, nextText, true);
				setState("treeVersion", (v) => v + 1);
				notify(`Updated ${baseName(dest)} with ${missingObjs.length} new SQL ${missingObjs.length === 1 ? "object" : "objects"} from ${baseName(sourcePath)}.`);
				await openFile(dest);
			} catch (e: any) {
				notify(String(e?.message ?? e), "error");
			}
			return;
		}
		await start(dest, sqlNonTableObjectsToMarkdown(objects, relSql, docTitle), "schema");
		return;
	}

	let dest: string;
	let docTitle: string;
	if (targetDocPath && directTargetMd !== null) {
		dest = targetDocPath;
		docTitle = tables.length === 1 ? tables[0]!.tableName : baseName(targetDocPath).replace(/\.(md|markdown)$/i, "");
	} else {
		const defaultName = tables.length === 1 ? tables[0]!.tableName : baseName(sourcePath).replace(/\.[^.]+$/, "");
		const name = (await ask(`Table document name (saved under ${state.project!.schema}/${dbSubfolder}/)`, defaultName))?.trim();
		if (!name) return;
		const named = typedParts(name, "file");
		if ("problem" in named || named.parts.length !== 1) return notify("Give a single valid filename.", "error");
		dest = joinPath(schemaFolder(), dbSubfolder, `${named.parts[0]}.md`);
		docTitle = tables.length === 1 ? tables[0]!.tableName : name;
	}

	const existingMd = dest === targetDocPath ? directTargetMd : await current(dest);
	if (existingMd !== null) {
		// Unify dropped/modified detection via `diffSqlAgainstSchemaMarkdown` so already-tagged
		// `[deprecated / dropped in SQL]` rows are never re-prompted.
		const drifts = diffSqlAgainstSchemaMarkdown(sqlText, existingMd);
		const isColumnEntry = (entry: string) => !/^(?:FK|INDEX): /.test(entry);
		const dropped = drifts.flatMap((d) => d.dropped.filter(isColumnEntry).map((col) => (tables.length > 1 ? `${d.table}.${col}` : col)));
		const modified = drifts.flatMap((d) => d.modified.filter(isColumnEntry).map((col) => (tables.length > 1 ? `${d.table}.${col}` : col)));

		// Prompt BEFORE merging so "Keep existing rows as-is" genuinely leaves dropped rows untagged (ADR 0002 / 0009).
		let markDropped = false;
		let latestMd = existingMd;
		if (dropped.length > 0) {
			const droppedPreview = dropped.slice(0, 6).join(", ") + (dropped.length > 6 ? `, +${dropped.length - 6} more` : "");
			const modNote = modified.length ? ` Modified: ${modified.slice(0, 5).join(", ")}${modified.length > 5 ? "…" : ""}.` : "";
			const MARK_DROPPED = "Mark dropped in Notes";
			const KEEP = "Keep existing rows as-is";
			const action = await choose(
				`${dropped.length} documented ${dropped.length === 1 ? "column is" : "columns are"} no longer in ${baseName(sourcePath)}: ${droppedPreview}.${modNote} Existing rows are preserved — how should dropped columns be handled?`,
				[MARK_DROPPED, KEEP],
			);
			if (!action) return;
			markDropped = action === MARK_DROPPED;
			latestMd = (await current(dest)) ?? existingMd;
		}

		const targetTables = filterSqlTablesForMarkdown(tables, latestMd);
		const merged = mergeSqlTablesIntoMarkdown(latestMd, targetTables, relSql, { markDropped });
		let nextText = merged.text;
		if (!one(frontMatter(nextText).values.source)) {
			nextText = withFrontMatter(nextText, "source", relSql) ?? nextText;
		}

		if (nextText === latestMd) {
			if (dropped.length > 0) {
				notify(`${baseName(dest)} kept ${dropped.length} dropped ${dropped.length === 1 ? "column" : "columns"} (${dropped.slice(0, 4).join(", ")}) for manual review.`);
			} else {
				notify(`${baseName(dest)} is already up to date with ${baseName(sourcePath)}.`);
			}
			await openFile(dest);
			return;
		}
		try {
			await put(dest, nextText, true);
			setState("treeVersion", (v) => v + 1);
			void import("./docAudit").then((m) => m.refreshDocAudit());
			const parts = [
				merged.addedTables ? `${merged.addedTables} ${merged.addedTables === 1 ? "table" : "tables"} added` : "",
				merged.addedColumns ? `${merged.addedColumns} ${merged.addedColumns === 1 ? "column" : "columns"} added` : "",
				merged.updatedColumns
					? `${merged.updatedColumns} modified${modified.length && modified.length <= 4 ? ` (${modified.join(", ")})` : ""}`
					: "",
				dropped.length
					? `${dropped.length} dropped in SQL${markDropped ? " (marked)" : " (kept as-is)"} (${dropped.slice(0, 4).join(", ")}${dropped.length > 4 ? "…" : ""})`
					: "",
			].filter(Boolean);
			notify(`Synced ${baseName(dest)} from ${baseName(sourcePath)}${parts.length ? ` (${parts.join("; ")})` : ""}.`);
			await openFile(dest);
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
		return;
	}
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

/**
 * Generates (or updates) a 1:1 `.sql` DDL file directly from a database schema
 * Markdown document's column table(s) and links `source:` to it.
 */
export async function generateSqlFromSchemaDoc(mdPath: string): Promise<void> {
	if (!ready()) return;
	const startRoot = root();
	const mdText = await current(mdPath);
	if (mdText === null) return;
	const relMd = relativeTo(startRoot, mdPath).split("\\").join("/");
	const stem = baseName(mdPath).replace(/\.(md|markdown)$/i, "");
	const generated = schemaMarkdownToSql(mdText, { sourceNote: relMd, fallbackTableName: stem });
	if (!generated) {
		notify("Add a column table (| Column | Type | Null | ... |) before generating SQL DDL.");
		return;
	}

	const existingSource = one(frontMatter(mdText).values.source)?.trim() ?? "";
	const otherDocsUsingSource = existingSource
		? docs().filter(
				(d) =>
					d.exists &&
					d.group === "schema" &&
					canonical(d.path) !== canonical(mdPath) &&
					d.source?.trim().toLowerCase() === existingSource.toLowerCase(),
			).length
		: 0;
	let dest = joinPath(dirName(mdPath), `${stem}.sql`);
	if (existingSource && !/^https?:\/\//i.test(existingSource) && /\.(sql|ddl)$/i.test(existingSource) && otherDocsUsingSource === 0) {
		const isAbs = /^([A-Za-z]:[\\/]|\/)/.test(existingSource);
		const candidate = isAbs
			? resolvePath(existingSource, ".")
			: /^\.{1,2}[\\/]/.test(existingSource)
				? resolvePath(dirName(mdPath), existingSource)
				: resolvePath(startRoot, existingSource);
		if (!isInside(startRoot, candidate)) {
			notify(`Cannot write SQL outside the workspace: ${existingSource}`, "error");
			return;
		}
		dest = candidate;
	}
	if (!isInside(startRoot, dest)) {
		notify("Cannot write SQL outside the workspace.", "error");
		return;
	}

	const existingSql = await current(dest);
	let finalGenerated = generated;
	if (existingSql !== null && existingSql.replace(/\r\n/g, "\n").trim() !== generated.sql.trim()) {
		const OVERWRITE = "Update SQL file";
		const picked = await choose(
			`Overwrite ${baseName(dest)} with CREATE TABLE DDL generated from ${baseName(mdPath)}?`,
			[OVERWRITE],
			{ danger: OVERWRITE },
		);
		if (picked !== OVERWRITE) return;
		if (!state.workspace || root() !== startRoot) return;
		// Re-read the schema doc after confirmation so edits made meanwhile are reflected & preserved.
		const freshMd = await current(mdPath);
		if (freshMd === null) return notify("Could not read the schema document.", "error");
		const regenerated = schemaMarkdownToSql(freshMd, { sourceNote: relMd, fallbackTableName: stem });
		if (!regenerated) {
			notify("Add a column table (| Column | Type | Null | ... |) before generating SQL DDL.");
			return;
		}
		finalGenerated = regenerated;
	}

	try {
		const existedNow = (await current(dest)) !== null;
		if (existedNow) {
			await put(dest, finalGenerated.sql, true);
		} else {
			await backend.create(dest, "file");
			await backend.write(dest, finalGenerated.sql);
		}
		const latestMd = await current(mdPath);
		const relSql = relativeTo(startRoot, dest).split("\\").join("/");
		if (latestMd !== null) {
			const latestSource = one(frontMatter(latestMd).values.source)?.trim() ?? "";
			if (latestSource.toLowerCase() !== relSql.toLowerCase()) {
				const updatedMd = withFrontMatter(latestMd, "source", relSql);
				if (updatedMd && updatedMd !== latestMd) await put(mdPath, updatedMd, true);
			}
		}
		setState("treeVersion", (v) => v + 1);
		void import("./docAudit").then((m) => m.refreshDocAudit());
		notify(`Generated ${baseName(dest)} (${finalGenerated.tables.join(", ")}) from ${baseName(mdPath)}.`);
		await openFile(dest);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/** Removes the `source:` SQL link from a schema Markdown doc so it acts as a standalone doc. */
export async function unlinkSchemaDocSql(mdPath: string): Promise<void> {
	if (!ready()) return;
	const cur = await current(mdPath);
	if (cur === null) return;
	const next = removeFrontMatterKey(cur, "source");
	if (next === cur) return;
	try {
		await put(mdPath, next, true);
		setState("treeVersion", (v) => v + 1);
		void import("./docAudit").then((m) => m.refreshDocAudit());
		notify(`Unlinked SQL source from ${baseName(mdPath)}.`);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/** Opens a searchable QuickPick to link, switch, generate, or unlink a schema doc's SQL source. */
export async function linkSchemaDocToSql(mdPath: string): Promise<void> {
	if (!ready()) return;
	const startRoot = root();
	const cur = await current(mdPath);
	if (cur === null) return;
	const currentSource = one(frontMatter(cur).values.source)?.trim() ?? "";
	const stem = baseName(mdPath).replace(/\.(md|markdown)$/i, "");
	const sqlDocs = docs()
		.filter((d) => d.exists && d.group === "schema" && /\.(sql|ddl|pks|pkb)$/i.test(d.name))
		.sort((a, b) => {
			const aSame = baseName(a.name).replace(/\.[^.]+$/, "").toLowerCase() === stem.toLowerCase() ? 0 : 1;
			const bSame = baseName(b.name).replace(/\.[^.]+$/, "").toLowerCase() === stem.toLowerCase() ? 0 : 1;
			return aSame - bSame || a.name.localeCompare(b.name);
		});

	const GENERATE = "__generate__";
	const BROWSE = "__browse__";
	const UNLINK = "__unlink__";
	const picked = await quickPick<string>({
		title: `SQL source for ${baseName(mdPath)}`,
		placeholder: "Pick a SQL/DDL file, generate a 1:1 .sql file, or unlink…",
		items: [
			...sqlDocs.map((f) => {
				const rel = relativeTo(startRoot, f.path).split("\\").join("/");
				const isCurrent = Boolean(currentSource && rel.toLowerCase() === currentSource.toLowerCase());
				return {
					label: baseName(f.name),
					value: f.path,
					detail: rel,
					icon: "database" as const,
					badge: isCurrent ? { text: "current", tone: "active" } : undefined,
				};
			}),
			{
				label: `Generate ${stem}.sql from this document`,
				value: GENERATE,
				detail: "Create or update a 1:1 SQL DDL file from this Markdown column table",
				icon: "wand",
				divide: sqlDocs.length > 0,
			},
			{
				label: "Browse workspace for SQL file…",
				value: BROWSE,
				detail: "Choose any .sql / .ddl file in the repository",
				icon: "folder",
			},
			...(currentSource
				? [
						{
							label: "Unlink SQL source (standalone doc)",
							value: UNLINK,
							detail: "Remove source: frontmatter and disable SQL drift checks for this doc",
							icon: "close" as const,
							divide: true,
						},
					]
				: []),
		],
	});
	if (!picked) return;
	if (!state.workspace || root() !== startRoot) return;
	if (picked === GENERATE) return generateSqlFromSchemaDoc(mdPath);
	if (picked === UNLINK) return unlinkSchemaDocSql(mdPath);

	let chosenPath = picked;
	if (picked === BROWSE) {
		const browsed = await browseWorkspaceFile({
			title: `Choose SQL source for ${baseName(mdPath)}`,
			root: startRoot,
			initialDir: dirName(mdPath),
		});
		if (!browsed) return;
		if (!state.workspace || root() !== startRoot) return;
		chosenPath = browsed.path;
	}
	// Re-read schema doc after modals so edits made meanwhile are preserved.
	const freshCur = await current(mdPath);
	if (freshCur === null) return;
	const relSql = relativeTo(startRoot, chosenPath).split("\\").join("/");
	const next = withFrontMatter(freshCur, "source", relSql);
	if (!next || next === freshCur) return;
	try {
		await put(mdPath, next, true);
		setState("treeVersion", (v) => v + 1);
		void import("./docAudit").then((m) => m.refreshDocAudit());
		notify(`Linked ${baseName(mdPath)} to ${relSql}.`);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
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
		const startRoot = state.workspace.root;
		const picked = (await ask("Save export to (path in workspace)", defaultRelPath))?.trim();
		if (!picked) return false;
		if (!state.workspace || state.workspace.root !== startRoot) return false;
		const cleanRel = picked.replace(/\\/g, "/").replace(/^\/+/, "");
		const dest = resolvePath(startRoot, cleanRel);
		if (!isInside(startRoot, dest)) {
			notify("Export path must stay inside the workspace.", "error");
			return false;
		}
		try {
			const exists = await backend.read(dest).then(() => true, () => false);
			if (exists) {
				const OVERWRITE = "Overwrite file";
				if ((await choose(`${relativeTo(startRoot, dest)} already exists. Overwrite it?`, [OVERWRITE], { danger: OVERWRITE })) !== OVERWRITE) {
					return false;
				}
				if (!state.workspace || state.workspace.root !== startRoot) return false;
			}
			// Compute payload BEFORE creating or touching any file on disk.
			const payload = typeof content === "function" ? await content(dest) : content;
			const openKey = canonical(dest);
			await changingOnDisk(dest, async () => {
				if (!exists) await backend.create(dest, "file");
				else await backend.historyKeep(dest).catch(() => {});
				await backend.write(dest, payload);
				if (documents.get(openKey)) await revert(openKey);
			});
			setState("treeVersion", (v) => v + 1);
			notify(`Saved export to ${relativeTo(startRoot, dest)}.`);
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

/**
 * Finds local `.svg` / `.webp` image references in Markdown (outside fenced code blocks)
 * and rasterizes each to PNG base64 via an offscreen `<canvas>` for Word (`.docx`) embedding.
 */
async function rasterizeVectorAndWebpImagesForDocx(markdown: string, baseDocPath: string): Promise<Record<string, string>> {
	if (typeof document === "undefined" || typeof Image === "undefined") return {};
	const body = frontMatter(markdown).body.replace(/\r\n/g, "\n");
	const lines = body.split("\n");
	const refs = new Set<string>();
	let outerFence: { ch: string; len: number } | null = null;
	for (const line of lines) {
		if (outerFence) {
			if (new RegExp(`^[ \\t]{0,3}${outerFence.ch}{${outerFence.len},}[ \\t]*$`).test(line)) outerFence = null;
			continue;
		}
		const fenceOpen = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)(?:[ \t]+.*)?$/.exec(line);
		if (fenceOpen && !(fenceOpen[1]![0] === "`" && line.slice(line.indexOf(fenceOpen[1]!) + fenceOpen[1]!.length).includes("`"))) {
			outerFence = { ch: fenceOpen[1]![0]!, len: fenceOpen[1]!.length };
			continue;
		}
		for (const m of line.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
			const raw = m[1]!.trim();
			if (!raw || /^(?:https?:|data:)/i.test(raw)) continue;
			const clean = raw.split(/[?#]/)[0] ?? raw;
			if (/\.(?:svg|webp)$/i.test(clean)) refs.add(raw);
		}
		for (const m of line.matchAll(/!\[\[([^[\]|#]+\.(?:svg|webp))(?:\|[^[\]]*)?\]\]/gi)) {
			const raw = m[1]!.trim();
			if (raw) refs.add(raw);
		}
	}
	if (!refs.size) return {};

	const { loadImageUrl } = await import("./editor/imageResolve");
	const out: Record<string, string> = {};
	const rasterizeUrl = (url: string, isSvg: boolean): Promise<string | null> =>
		new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				try {
					const natW = img.naturalWidth || img.width || 800;
					const natH = img.naturalHeight || img.height || 600;
					const scale = isSvg ? 2 : 1;
					const maxDim = 1600;
					const fit = Math.min(1, maxDim / Math.max(natW * scale, natH * scale, 1));
					const w = Math.max(1, Math.round(natW * scale * fit));
					const h = Math.max(1, Math.round(natH * scale * fit));
					const canvas = document.createElement("canvas");
					canvas.width = w;
					canvas.height = h;
					const ctx = canvas.getContext("2d");
					if (!ctx) return resolve(null);
					ctx.drawImage(img, 0, 0, w, h);
					const pngUrl = canvas.toDataURL("image/png");
					const b64 = pngUrl.replace(/^data:image\/png;base64,/i, "");
					resolve(b64 || null);
				} catch {
					resolve(null);
				}
			};
			img.onerror = () => resolve(null);
			img.src = url;
		});

	for (const rawRef of refs) {
		try {
			const decoded = linkFile(rawRef);
			const loaded = await loadImageUrl(decoded, baseDocPath);
			if (!loaded?.url) continue;
			const isSvg = /\.svg$/i.test(decoded) || loaded.url.startsWith("data:image/svg+xml");
			const b64 = await rasterizeUrl(loaded.url, isSvg);
			if (!b64) continue;
			out[rawRef] = b64;
			const clean = decoded.replace(/\\/g, "/");
			if (clean && clean !== rawRef) out[clean] = b64;
		} catch {
			// Skip unrasterizable image gracefully.
		}
	}
	return out;
}

/** Loads and parses all IQ/OQ/PQ validation test run Markdown documents across the workspace. */
async function loadWorkspaceTestRuns(allDocs: readonly DocFile[]): Promise<TestRunSummary[]> {
	const candidatePaths = new Map<string, string>();
	const addCand = (p: string) => {
		if (!isMarkdown(p)) return;
		const c = canonical(p);
		if (!candidatePaths.has(c)) candidatePaths.set(c, p);
	};
	for (const d of allDocs) {
		if (!d.exists || isCatalog(d)) continue;
		if (
			d.docKind === "test-run" ||
			/(?:^|[\\/])test-runs?[\\/]/i.test(d.path) ||
			(d.group === "docs" && /(?:^|[\\/])tests[\\/]/i.test(d.name))
		) {
			addCand(d.path);
		}
		for (const tf of d.ticketFiles ?? []) {
			if (/(?:^|[\\/])test-runs?[\\/]/i.test(tf.rel)) addCand(tf.path);
		}
	}
	const runs: TestRunSummary[] = [];
	for (const p of candidatePaths.values()) {
		const txt = await current(p);
		if (!txt) continue;
		const parsed = parseTestRunDocument(p, txt);
		if (parsed) runs.push(parsed);
	}
	return runs;
}

/**
 * Builds STARLIMS Deployment Execution Runbook inputs:
 * - FK-ordered table dependencies extracted from workspace SQL DDL (`parseCreateTables`)
 * - Verified `files.csv` SHA-256 checksum drift (`detectChecksumDrift`)
 * - Affected scheduled jobs (`jobs.csv`) matching in-scope scripts
 */
async function buildDeploymentRunbookData(options: {
	allDocs: readonly DocFile[];
	scopeDocs: readonly DocFile[];
	scripts: readonly { ref: string }[];
	sqlArtifacts: readonly DeploymentManifestSql[];
	registries: readonly DeploymentManifestRegistry[];
	checksums: readonly { path: string; sha256: string }[];
	wsRoot: string;
}): Promise<DeploymentRunbookInput> {
	const { allDocs, scopeDocs, scripts, sqlArtifacts, checksums, wsRoot } = options;

	// 1. Collect SQL DDL files referenced by this manifest/bundle and extract table FK dependencies.
	const sqlPaths = new Map<string, { abs: string; rel: string }>();
	const addSqlPath = (abs: string) => {
		if (!/\.(sql|ddl|pks|pkb)$/i.test(abs)) return;
		const c = canonical(abs);
		if (!sqlPaths.has(c)) sqlPaths.set(c, { abs, rel: relativeTo(wsRoot, abs).split("\\").join("/") });
	};
	for (const art of sqlArtifacts) {
		if (!/\.(sql|ddl|pks|pkb)$/i.test(art.path)) continue;
		const direct = resolvePath(wsRoot, art.path.replace(/^\/+/, ""));
		if (isInside(wsRoot, direct)) addSqlPath(direct);
		for (const sd of scopeDocs) {
			for (const tf of sd.ticketFiles ?? []) {
				if (tf.rel.replace(/\\/g, "/").toLowerCase() === art.path.replace(/\\/g, "/").toLowerCase()) {
					addSqlPath(tf.path);
				}
			}
		}
	}
	// Also include schema-folder SQL files whose table names match any referenced schema doc.
	const referencedTables = new Set<string>();
	for (const art of sqlArtifacts) {
		const stem = baseName(art.path).replace(/\.[^.]+$/, "").toLowerCase();
		if (stem) referencedTables.add(stem);
	}
	for (const d of allDocs) {
		if (!d.exists || d.group !== "schema" || !/\.(sql|ddl)$/i.test(d.name)) continue;
		if (!sqlPaths.size || d.schemaObjects?.some((obj) => referencedTables.has(obj.toLowerCase()))) {
			addSqlPath(d.path);
		}
	}

	const sqlTables: DeploymentRunbookTableDep[] = [];
	const seenTables = new Set<string>();
	for (const { abs, rel } of sqlPaths.values()) {
		const txt = await current(abs);
		if (!txt) continue;
		for (const tbl of parseCreateTables(txt, { includeStandaloneAlter: true })) {
			const k = tbl.tableName.toLowerCase();
			if (seenTables.has(k)) continue;
			seenTables.add(k);
			const dependsOn = [...new Set((tbl.foreignKeys ?? []).map((fk) => fk.refTable).filter(Boolean))];
			sqlTables.push({ name: tbl.tableName, ...(dependsOn.length ? { dependsOn } : {}), path: rel, kind: "table" });
		}
	}

	// 2. Read `files.csv` to detect SHA-256 drift on any `verified` artifact in scope.
	const fileManifestRows: { path: string; sha256: string; status?: string }[] = [];
	const filesCsv = allDocs.find((d) => d.exists && d.group === "registries" && /(^|[\\/])files\.csv$/i.test(d.name));
	if (filesCsv) {
		const csvText = await current(filesCsv.path);
		if (csvText) {
			const parsed = parseCsv(csvText);
			const lower = parsed.header.map((h) => h.text.trim().toLowerCase());
			const pathIdx = Math.max(0, lower.findIndex((h) => h === "path" || h === "file"));
			const shaIdx = lower.findIndex((h) => h === "sha256" || h === "sha-256" || h === "checksum" || h === "hash");
			const statusIdx = lower.findIndex((h) => h === "status" || h === "state");
			if (shaIdx >= 0) {
				for (const row of parsed.rows) {
					const p = (row[pathIdx]?.text ?? "").trim();
					const sha = (row[shaIdx]?.text ?? "").trim();
					if (p && sha) {
						fileManifestRows.push({
							path: p,
							sha256: sha,
							status: statusIdx >= 0 ? (row[statusIdx]?.text ?? "").trim() : undefined,
						});
					}
				}
			}
		}
	}
	const checksumDrifts = detectChecksumDrift(fileManifestRows, checksums);

	// 3. Catch any scheduled jobs in `jobs.csv` calling an in-scope script (even if unticketed).
	const extraJobs: { name: string; schedule?: string; calls?: string; status?: string }[] = [];
	const jobsCsv = allDocs.find((d) => d.exists && d.group === "registries" && /(^|[\\/])jobs\.csv$/i.test(d.name));
	if (jobsCsv && scripts.length) {
		const csvText = await current(jobsCsv.path);
		if (csvText) {
			const parsed = parseCsv(csvText);
			const lower = parsed.header.map((h) => h.text.trim().toLowerCase());
			const nameIdx = Math.max(0, lower.findIndex((h) => h === "job" || h === "name"));
			const runsIdx = lower.findIndex((h) => h === "runs" || h === "schedule" || h === "cron");
			const callsIdx = lower.findIndex((h) => h === "calls" || h === "script");
			const statusIdx = lower.findIndex((h) => h === "status" || h === "state");
			if (callsIdx >= 0) {
				for (const row of parsed.rows) {
					const name = (row[nameIdx]?.text ?? "").trim();
					const calls = (row[callsIdx]?.text ?? "").trim();
					if (!name || !calls) continue;
					if (scripts.some((s) => codeMatchesRef(calls, s.ref, wsRoot) || codeMatchesRef(s.ref, calls, wsRoot))) {
						extraJobs.push({
							name,
							schedule: runsIdx >= 0 ? (row[runsIdx]?.text ?? "").trim() : undefined,
							calls,
							status: statusIdx >= 0 ? (row[statusIdx]?.text ?? "").trim() : undefined,
						});
					}
				}
			}
		}
	}

	return {
		...(sqlTables.length ? { sqlTables } : {}),
		...(fileManifestRows.length ? { fileManifestRows } : {}),
		...(checksumDrifts.length ? { checksumDrifts } : {}),
		...(extraJobs.length ? { jobs: extraJobs } : {}),
	};
}

/** Saves an OpenXML `.docx` document generated by the backend inside the workspace (embedding local images, Mermaid PNGs, rasterized SVG/WebP, hyperlinks, footnotes & metadata). */
async function saveDocxExport(
	defaultRelPath: string,
	title: string,
	subtitle: string | undefined,
	markdown: string,
	options?: { baseDir?: string; baseDocPath?: string; meta?: Record<string, string>; toc?: boolean; headerFooter?: boolean },
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
		const baseDocPath = options?.baseDocPath ?? (options?.baseDir ? joinPath(options.baseDir, "doc.md") : joinPath(docsFolder(), "INDEX.md"));
		const [mermaidPngs, rasterizedImages] = await Promise.all([
			rasterizeMermaidPngsForDocx(markdown),
			rasterizeVectorAndWebpImagesForDocx(markdown, baseDocPath),
		]);
		const res = await backend.exportDocx({
			path: dest,
			title,
			subtitle,
			markdown,
			...(options?.baseDir ? { baseDir: options.baseDir } : {}),
			...(Object.keys(meta).length ? { meta } : {}),
			...(Object.keys(mermaidPngs).length ? { mermaidPngs } : {}),
			...(state.settings.attachmentsFolder?.trim() ? { attachmentsFolder: state.settings.attachmentsFolder.trim() } : {}),
			...(state.project?.docs ? { docsFolder: state.project.docs } : {}),
			...(Object.keys(rasterizedImages).length ? { rasterizedImages } : {}),
			...(options?.toc !== undefined ? { toc: options.toc } : {}),
			headerFooter: options?.headerFooter ?? true,
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
			baseDocPath: path,
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

	const [{ gitStatus }, headSha, allTestRuns] = await Promise.all([
		import("./git"),
		backend.gitHeadSha().catch(() => null),
		loadWorkspaceTestRuns(allDocs),
	]);
	const matchingRuns = allTestRuns.filter((r) => scopeKeySet.has(r.ticket.trim().toLowerCase()));
	const readiness = evaluateTicketReadiness(allDocs, key, {
		gitFiles: gitStatus()?.files,
		root: state.workspace?.root,
		testRuns: matchingRuns,
		currentGitSha: headSha,
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
		...(matchingRuns.length ? { testRuns: matchingRuns } : {}),
		...(headSha ? { currentGitSha: headSha } : {}),
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
			baseDocPath: ticketPath,
			toc: true,
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
		if (rb) pushRollback(doc === ticketDoc ? null : `${doc.ticket ?? doc.name}`, rewriteRelativeLinksForBase(rb, doc.path, ticketPath));
		const k = doc.ticket ?? key;
		for (const sp of ticketWork(allDocs, k).find((g) => g.kind === "spec")?.files ?? []) {
			const spCanon = canonical(sp.path);
			if (seenSpecPaths.has(spCanon)) continue;
			seenSpecPaths.add(spCanon);
			const spText = await current(sp.path);
			const spRb = spText ? extractRollbackSection(spText) : "";
			if (spRb) pushRollback(`${sp.title || sp.name} (${k})`, rewriteRelativeLinksForBase(spRb, sp.path, ticketPath));
		}
	}

	const [{ gitStatus }, headSha, manifestFiles, allTestRuns] = await Promise.all([
		import("./git"),
		backend.gitHeadSha().catch(() => null),
		backend.manifest().catch(() => []),
		loadWorkspaceTestRuns(allDocs),
	]);
	const matchingRuns = allTestRuns.filter((r) => scopeKeySet.has(r.ticket.trim().toLowerCase()));
	const readiness = evaluateTicketReadiness(allDocs, key, {
		gitFiles: gitStatus()?.files,
		root: state.workspace?.root,
		testRuns: matchingRuns,
		currentGitSha: headSha,
	});

	// Match SHA-256 checksums for referenced script, test script, and SQL artifacts.
	const wsRoot = state.workspace?.root ?? "";
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

	const runbook = await buildDeploymentRunbookData({
		allDocs,
		scopeDocs,
		scripts,
		sqlArtifacts,
		registries,
		checksums,
		wsRoot,
	});

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
		runbook,
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
			baseDocPath: ticketPath,
			toc: true,
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
	const startRoot = root();
	const allDocs = docs();
	const ticketDoc = allDocs.find((d) => canonical(d.path) === canonical(ticketPath));
	const title = ticketDoc?.title || key;
	const [{ gitStatus }, headSha, allTestRuns] = await Promise.all([
		import("./git"),
		backend.gitHeadSha().catch(() => null),
		loadWorkspaceTestRuns(allDocs),
	]);
	if (!state.workspace || root() !== startRoot) return;
	const readiness = evaluateTicketReadiness(allDocs, key, {
		gitFiles: gitStatus()?.files,
		root: state.workspace?.root,
		testRuns: allTestRuns,
		currentGitSha: headSha,
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
	if (!state.workspace || root() !== startRoot) return;

	let summaryLine = "";
	if (picked !== DONE_ONLY) {
		const typed = (await ask("One-line completion summary for STATE.md", `${key}: ${title}`))?.trim();
		if (!typed) return;
		if (!state.workspace || root() !== startRoot) return;
		summaryLine = typed;
	}

	// 1. Mark ticket status `done` if not already.
	if (toneOf(ticketDoc?.status) !== "done") {
		await setStatus(ticketPath, "done");
	}

	// 2. Append dated bullet to `docs/STATE.md` (creating it from template if absent, honoring existing casing on Linux).
	let stateUpdated = false;
	if (picked === DONE_STATE || picked === DONE_STATE_README) {
		try {
			const stateDoc = allDocs.find(
				(d) => d.exists && canonical(dirName(d.path)) === canonical(docsFolder()) && baseName(d.path).toLowerCase() === STATE_FILE.toLowerCase(),
			);
			const statePath = stateDoc?.path ?? joinPath(docsFolder(), STATE_FILE);
			const existingState = await current(statePath);
			const bullet = `- ${today()} — ${summaryLine}`;
			if (existingState === null) {
				const fresh = `${stateTemplate(state.project!.name, today()).trimEnd()}\n\n## Completed\n\n${bullet}\n`;
				await start(statePath, fresh);
				stateUpdated = true;
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
				stateUpdated = true;
			}
		} catch (e: any) {
			notify(`Could not update ${STATE_FILE}: ${e?.message ?? e}`, "error");
		}
	}

	// 3. Optionally promote completed milestone / capability note into `README.md` (honoring existing casing on Linux).
	let readmeUpdated = false;
	if (picked === DONE_STATE_README) {
		try {
			const readmeDoc = allDocs.find((d) => d.exists && d.group === "project" && baseName(d.path).toLowerCase() === "readme.md");
			const readmePath = readmeDoc?.path ?? joinPath(startRoot, "README.md");
			const existingReadme = await current(readmePath);
			if (existingReadme !== null) {
				const eol = existingReadme.includes("\r\n") ? "\r\n" : "\n";
				const bullet = `- **${key}** (${today()}): ${summaryLine.replace(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:\\s—-]+`, "i"), "")}`;
				const secRe = /^(##\s+(?:Completed|Milestones|Capabilities|Delivered|What this does)[^\r\n]*\r?\n+)/im;
				const nextReadme = secRe.test(existingReadme)
					? existingReadme.replace(secRe, (_, head: string) => `${head}${bullet}${eol}`)
					: `${existingReadme.trimEnd()}${eol}${eol}## Milestones${eol}${eol}${bullet}${eol}`;
				await put(readmePath, nextReadme, true);
				readmeUpdated = true;
			}
		} catch (e: any) {
			notify(`Could not update README.md: ${e?.message ?? e}`, "error");
		}
	}

	// 4. Always clear active workspace ticket focus if it matched this closed-out ticket and refresh tree.
	if (state.settings.activeTicket?.toLowerCase() === key.toLowerCase()) {
		await saveSetting({ activeTicket: null }, "workspace").catch(() => {});
	}

	setState("treeVersion", (v) => v + 1);
	// Respect ADR 0031: never auto-rewrite INDEX.md catalogs silently — check fresh backend docs and offer manual trigger if stale.
	const freshDocs = await backend.docs().catch(() => docs());
	const staleInfo = staleCatalogSummary(freshDocs);
	const hasStale = staleInfo.stale.length > 0 || staleInfo.missing.length > 0;
	const detail =
		stateUpdated && readmeUpdated
			? " (updated STATE.md & README.md)"
			: stateUpdated
				? " (recorded in STATE.md)"
				: readmeUpdated
					? " (updated README.md)"
					: "";
	notify(
		`Closed out ${key}${detail}.`,
		"info",
		hasStale ? { label: "Update catalogs", run: () => void updateCatalogs() } : undefined,
	);
}

/** Computes inline protected character ranges on one Markdown line (code spans, comments, wikilinks, link destinations, HTML tags/attributes, bare URLs). */
function protectedProseRanges(line: string): [number, number][] {
	const ranges: [number, number][] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === "`") {
			let run = 0;
			while (i + run < line.length && line[i + run] === "`") run++;
			let j = i + run;
			let closed = -1;
			while (j < line.length) {
				if (line[j] !== "`") {
					j++;
					continue;
				}
				let closeRun = 0;
				while (j + closeRun < line.length && line[j + closeRun] === "`") closeRun++;
				if (closeRun === run) {
					closed = j + closeRun;
					break;
				}
				j += closeRun;
			}
			if (closed >= 0) {
				ranges.push([i, closed]);
				i = closed;
				continue;
			}
			i += run;
			continue;
		}
		if (line.startsWith("<!--", i)) {
			const end = line.indexOf("-->", i + 4);
			if (end >= 0) {
				ranges.push([i, end + 3]);
				i = end + 3;
				continue;
			}
		}
		if (line.startsWith("[[", i)) {
			const m = /^\[\[[^[\]\n]*\]\]/.exec(line.slice(i));
			if (m) {
				ranges.push([i, i + m[0].length]);
				i += m[0].length;
				continue;
			}
		}
		if (line.startsWith("](", i)) {
			const m = /^\]\((?:[^()\n]|\([^()\n]*\))*\)/.exec(line.slice(i));
			if (m) {
				ranges.push([i, i + m[0].length]);
				i += m[0].length;
				continue;
			}
		}
		if (line[i] === "<") {
			const m = /^<(?:[A-Za-z/!][^>\n]*|https?:\/\/[^>\s\n]+)>/.exec(line.slice(i));
			if (m) {
				ranges.push([i, i + m[0].length]);
				i += m[0].length;
				continue;
			}
		}
		if (line[i] === "=") {
			const m = /^=\s*(?:"[^"\n]*"|'[^'\n]*')/.exec(line.slice(i));
			if (m) {
				ranges.push([i, i + m[0].length]);
				i += m[0].length;
				continue;
			}
		}
		if ((line[i] === "h" || line[i] === "H") && /^https?:\/\//i.test(line.slice(i))) {
			const m = /^https?:\/\/[^\s)>]+/i.exec(line.slice(i));
			if (m) {
				ranges.push([i, i + m[0].length]);
				i += m[0].length;
				continue;
			}
		}
		i++;
	}
	return ranges;
}

/**
 * Pure helper that renames inline prose `#oldTag` occurrences in Markdown text while preserving:
 * - YAML frontmatter (handled separately by `replaceInFrontMatterList`),
 * - fenced code blocks (following CommonMark fence length + `/^[ \t]*$/` closing-line rules),
 * - ATX headings & reference-link definitions,
 * - inline code spans, HTML comments, HTML tags & attributes (`href="#tag"`, `="...#tag"`),
 * - Markdown link destinations (`](#tag)`), wikilinks (`[[Doc#tag]]`), and bare URLs.
 */
export function renameProseTagInMarkdown(text: string, oldTag: string, newTag: string): string {
	const cleanOld = oldTag.trim().replace(/^#+/, "");
	const cleanNew = newTag.trim().replace(/^#+/, "");
	if (!cleanOld || !cleanNew) return text;
	const cutAt = bodyOffset(text);
	const headPart = text.slice(0, cutAt);
	const bodyPart = text.slice(cutAt);
	const esc = cleanOld.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const proseRe = new RegExp(`(^|[\\s([{"'.,;:])#${esc}(?=$|[\\s)\\]}"'.,;:!?])`, "gi");
	const lines = bodyPart.split(/(\r?\n)/);
	let inFence: { ch: string; len: number } | null = null;
	let inHtmlComment = false;
	for (let i = 0; i < lines.length; i += 2) {
		const ln = lines[i]!;
		const fm = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(ln);
		if (fm) {
			const ch = fm[1]![0]!;
			const len = fm[1]!.length;
			const rest = fm[2] ?? "";
			if (!inFence) {
				if (!(ch === "`" && rest.includes("`"))) inFence = { ch, len };
				continue;
			}
			if (ch === inFence.ch && len >= inFence.len && /^[ \t]*$/.test(rest)) {
				inFence = null;
			}
			continue;
		}
		if (inFence) continue;
		const ranges: [number, number][] = [];
		let scanFrom = 0;
		if (inHtmlComment) {
			const closeIdx = ln.indexOf("-->");
			if (closeIdx < 0) continue;
			ranges.push([0, closeIdx + 3]);
			scanFrom = closeIdx + 3;
			inHtmlComment = false;
		}
		if (scanFrom === 0 && (/^[ \t]{0,3}#{1,6}[ \t]+/.test(ln) || /^[ \t]{0,3}\[[^\]]+\]:[ \t]*\S/.test(ln))) {
			continue;
		}
		if (!ln.includes("#") && !ln.includes("<!--")) continue;
		const subRanges = protectedProseRanges(scanFrom ? ln.slice(scanFrom) : ln);
		for (const [from, to] of subRanges) ranges.push([from + scanFrom, to + scanFrom]);
		// Detect an unclosed multi-line `<!--` comment outside already-protected spans.
		for (let idx = ln.indexOf("<!--", scanFrom); idx >= 0; idx = ln.indexOf("<!--", idx + 4)) {
			if (ranges.some(([from, to]) => idx >= from && idx < to)) continue;
			if (ln.indexOf("-->", idx + 4) < 0) {
				ranges.push([idx, ln.length]);
				inHtmlComment = true;
				break;
			}
		}
		if (!ln.includes("#")) continue;
		lines[i] = ln.replace(proseRe, (full, lead: string, offset: number) => {
			const hashAt = offset + lead.length;
			if (ranges.some(([from, to]) => hashAt >= from && hashAt < to)) return full;
			return `${lead}#${cleanNew}`;
		});
	}
	return headPart + lines.join("");
}

/** Renames a `#tag` across both YAML frontmatter (`tags:`/`tag:`) and prose `#tag` occurrences in workspace Markdown docs. */
export async function renameTagAcrossWorkspace(oldTag: string): Promise<void> {
	if (!ready()) return;
	const startRoot = root();
	const cleanOld = oldTag.trim().replace(/^#+/, "");
	if (!cleanOld) return;
	const typed = (await ask(`Rename tag #${cleanOld} across workspace to (without #)`, cleanOld))?.trim().replace(/^#+/, "");
	if (!typed || typed.toLowerCase() === cleanOld.toLowerCase()) return;
	if (!state.workspace || root() !== startRoot) return;
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
	if (!state.workspace || root() !== startRoot) return;
	let changedCount = 0;
	let failedCount = 0;
	for (const doc of targets) {
		if (!state.workspace || root() !== startRoot) break;
		const before = await current(doc.path);
		if (before === null) continue;
		let next = before;
		for (const field of ["tags", "tag"]) {
			next = replaceInFrontMatterList(next, field, cleanOld, typed) ?? next;
		}
		next = renameProseTagInMarkdown(next, cleanOld, typed);
		if (next !== before) {
			try {
				await put(doc.path, next, true);
				changedCount++;
			} catch (e: any) {
				failedCount++;
				notify(`Could not update ${baseName(doc.path)}: ${e?.message ?? e}`, "error");
			}
		}
	}
	if (changedCount) {
		setState("treeVersion", (v) => v + 1);
		notify(`Renamed #${cleanOld} to #${typed} in ${changedCount} ${changedCount === 1 ? "document" : "documents"}${failedCount ? ` (${failedCount} failed)` : ""}.`);
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
	const startRoot = root();
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
		pickedHeading =
			(await quickPick<(typeof headings)[number]>({
				title: `Rename which heading in ${baseName(docPath)}?`,
				placeholder: "Filter headings…",
				items: ordered.map((h) => ({
					label: `${"#".repeat(h.level)} ${h.text}`,
					value: h,
					icon: "list-flat",
					detail: `H${h.level} · line ${h.line}`,
					keywords: `${h.text} h${h.level} line ${h.line}`,
				})),
			})) ?? undefined;
	}
	if (!pickedHeading) return;
	if (!state.workspace || root() !== startRoot) return;

	const typed = (await ask(`Rename heading “${pickedHeading.text}” to`, pickedHeading.text))?.trim();
	if (!typed || typed === pickedHeading.text) return;
	if (!state.workspace || root() !== startRoot) return;

	const renameSourceHeading = (raw: string): { text: string; newAnchor: string } | null => {
		const curHeadings = documentHeadings(raw);
		const match =
			curHeadings.find((h) => h.line === pickedHeading!.line && h.text === pickedHeading!.text) ??
			curHeadings.find((h) => h.text === pickedHeading!.text && h.level === pickedHeading!.level);
		if (!match) return null;
		const lines = raw.split(/(\r?\n)/);
		const lineIdx = (match.line - 1) * 2;
		const rawLine = lines[lineIdx];
		if (rawLine === undefined) return null;
		const updatedLine = rawLine.replace(/^([ \t]{0,3}#{1,6}[ \t]+).+?([ \t]*#*[ \t]*)$/, (_, prefix: string, suffix: string) => `${prefix}${typed}${suffix}`);
		if (updatedLine === rawLine) return null;
		lines[lineIdx] = updatedLine;
		const renamed = lines.join("");
		const nextH = documentHeadings(renamed).find((h) => h.line === match.line);
		if (!nextH) return null;
		return { text: renamed, newAnchor: nextH.anchor };
	};

	const freshSourceBeforeConfirm = await current(docPath);
	if (freshSourceBeforeConfirm === null) return notify("Could not read the active Markdown document.", "error");
	const sourcePreview = renameSourceHeading(freshSourceBeforeConfirm);
	if (!sourcePreview) return;

	const allDocs = docs();
	const wsRoot = startRoot;
	const targetCanon = canonical(docPath);
	const nameIdx = buildDocNameIndex(allDocs, wsRoot);
	const scanPaths = new Map<string, string>();
	scanPaths.set(targetCanon, docPath);
	for (const d of allDocs) {
		if (!d.exists || !isMarkdown(d.path) || isCatalog(d)) continue;
		const c = canonical(d.path);
		if (!scanPaths.has(c)) scanPaths.set(c, d.path);
	}

	const rewriteFileRefs = (baseText: string, filePath: string, isSameDoc: boolean, newAnchor: string) => {
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
			oldHeading: pickedHeading!.text,
			oldAnchor: pickedHeading!.anchor,
			newHeading: typed,
			newAnchor,
		});
		let finalText = res.text;
		if (isSameDoc && finalText.includes("<!-- toc -->") && finalText.includes("<!-- /toc -->")) {
			finalText = upsertTocBlock(finalText).text;
		}
		return { text: finalText, refs: res.count };
	};

	const candidateFiles: { path: string; refs: number; isSource: boolean }[] = [];
	let totalRefs = 0;
	for (const [canon, filePath] of scanPaths) {
		const isSameDoc = canon === targetCanon;
		const baseText = isSameDoc ? sourcePreview.text : await current(filePath);
		if (baseText === null) continue;
		const res = rewriteFileRefs(baseText, filePath, isSameDoc, sourcePreview.newAnchor);
		if (isSameDoc || res.refs > 0) {
			totalRefs += res.refs;
			candidateFiles.push({ path: filePath, refs: res.refs, isSource: isSameDoc });
		}
	}

	const externalCount = candidateFiles.filter((e) => !e.isSource).length;
	if (totalRefs > 0 || externalCount > 0) {
		const GO = "Rename heading";
		const scope =
			externalCount > 0
				? `${totalRefs} ${totalRefs === 1 ? "reference" : "references"} across ${candidateFiles.length} ${candidateFiles.length === 1 ? "file" : "files"}`
				: `${totalRefs} ${totalRefs === 1 ? "reference" : "references"} in ${baseName(docPath)}`;
		const ok = await choose(`Rename “${pickedHeading.text}” to “${typed}” and update ${scope}?`, [GO]);
		if (ok !== GO) return;
		if (!state.workspace || root() !== startRoot) return;
	}

	let written = 0;
	let writtenRefs = 0;
	let activeNewAnchor = sourcePreview.newAnchor;
	for (const item of candidateFiles) {
		// Re-read current buffer after confirmation so edits made meanwhile are never overwritten.
		const freshText = await current(item.path);
		if (freshText === null) continue;
		let baseText = freshText;
		if (item.isSource) {
			const renamed = renameSourceHeading(freshText);
			if (!renamed) continue;
			baseText = renamed.text;
			activeNewAnchor = renamed.newAnchor;
		}
		const rewritten = rewriteFileRefs(baseText, item.path, item.isSource, activeNewAnchor);
		if (rewritten.text === freshText) continue;
		try {
			await put(item.path, rewritten.text, true);
			written++;
			writtenRefs += rewritten.refs;
		} catch (e: any) {
			notify(`Could not update ${baseName(item.path)}: ${e?.message ?? e}`, "error");
		}
	}
	if (written) {
		setState("treeVersion", (v) => v + 1);
		notify(
			writtenRefs > 0
				? `Renamed heading to “${typed}” and updated ${writtenRefs} ${writtenRefs === 1 ? "reference" : "references"} across ${written} ${written === 1 ? "file" : "files"}.`
				: `Renamed heading to “${typed}”.`,
		);
	}
}

/**
 * Interactive Multi-Ticket Release Bundle & Release Notes exporter.
 * Selects tickets by release tag, status, or multi-select QuickPick, optionally includes a local Git tag range,
 * deduplicates scripts, test scripts, business tests, SQL artifacts, checksums, ordered deployment runbook,
 * registry rows, and rebased rollback notes across all tickets + descendants, and exports Markdown, HTML, Word (.docx), or CAB CSV.
 */
export async function exportReleaseBundle(
	format?: "markdown" | "html" | "docx" | "csv",
	options?: { release?: string; tickets?: DocFile[] },
): Promise<void> {
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

	let baseTickets: DocFile[] = [];
	let defaultReleaseName = options?.release?.trim() || `release-${today()}`;

	if (options?.tickets?.length) {
		baseTickets = options.tickets.filter((t) => t.exists && t.group === "tickets" && t.ticket);
		if (!options.release) {
			const sharedRels = [...new Set(baseTickets.map((t) => t.release?.trim()).filter((r): r is string => Boolean(r)))];
			if (sharedRels.length === 1) defaultReleaseName = sharedRels[0]!;
		}
	} else if (options?.release) {
		const targetRel = options.release.trim().toLowerCase();
		baseTickets = activeTickets.filter((t) =>
			targetRel === "unscheduled" ? !t.release?.trim() : t.release?.trim().toLowerCase() === targetRel,
		);
		if (!baseTickets.length) return notify(`No active tickets found for release ${options.release}.`);
	} else {
		type ScopeChoice = { label: string; detail: string; description: string; tickets?: DocFile[]; defaultName: string; custom?: boolean };
		const scopeOptions: ScopeChoice[] = [];
		for (const rel of releases) {
			const matched = activeTickets.filter((t) => t.release?.trim().toLowerCase() === rel.toLowerCase());
			scopeOptions.push({
				label: `Release: ${rel}`,
				detail: `${matched.length} ${matched.length === 1 ? "ticket" : "tickets"}`,
				description: matched.map((t) => t.ticket).slice(0, 6).join(", ") + (matched.length > 6 ? "…" : ""),
				tickets: matched,
				defaultName: rel,
			});
		}
		if (doneTickets.length) {
			scopeOptions.push({
				label: `All done tickets`,
				detail: `${doneTickets.length}`,
				description: "Non-archived tickets marked done / resolved / approved",
				tickets: doneTickets,
				defaultName: `release-${today()}`,
			});
		}
		if (inProgTickets.length) {
			scopeOptions.push({
				label: `Active / in-progress tickets`,
				detail: `${inProgTickets.length}`,
				description: "Tickets currently under way",
				tickets: inProgTickets,
				defaultName: `release-${today()}`,
			});
		}
		scopeOptions.push({
			label: `All active tickets`,
			detail: `${activeTickets.length}`,
			description: "Every non-archived ticket in the workspace",
			tickets: activeTickets,
			defaultName: `release-${today()}`,
		});
		scopeOptions.push({
			label: "Select tickets…",
			detail: "Multi-select",
			description: "Pick individual tickets with checkboxes",
			defaultName: `release-${today()}`,
			custom: true,
		});

		const chosenScope = await quickPick<ScopeChoice>({
			title: "Which tickets belong in this Release Bundle?",
			placeholder: "Filter releases or ticket scopes…",
			items: scopeOptions.map((o, i) => ({
				label: o.label,
				value: o,
				icon: o.custom ? "checklist" : "layers",
				detail: o.detail,
				description: o.description,
				divide: Boolean(o.custom && i > 0),
				keywords: `${o.label} ${o.description}`,
			})),
		});
		if (!chosenScope) return;
		defaultReleaseName = chosenScope.defaultName;

		if (chosenScope.custom) {
			const sortedTickets = [...allTickets].sort((a, b) => {
				const aArch = isArchivedTicket(a) ? 1 : 0;
				const bArch = isArchivedTicket(b) ? 1 : 0;
				if (aArch !== bArch) return aArch - bArch;
				return (a.ticket ?? "").localeCompare(b.ticket ?? "", undefined, { numeric: true, sensitivity: "base" });
			});
			const activeKey = state.settings.activeTicket?.trim().toLowerCase();
			const preSelected = activeKey
				? sortedTickets.filter((t) => t.ticket?.toLowerCase() === activeKey)
				: [];
			const pickedTickets = await quickPickMany<DocFile>({
				title: "Select tickets to include in Release Bundle",
				placeholder: "Filter by ticket key, title, status, or release…",
				initialSelected: preSelected,
				confirmLabel: "Bundle selected",
				items: sortedTickets.map((t) => ({
					label: `${t.ticket}: ${t.title || t.name}`,
					value: t,
					icon: "checklist",
					badge: t.status ? { text: t.status, tone: toneOf(t.status) } : undefined,
					detail: [t.release, isArchivedTicket(t) ? "archived" : ""].filter(Boolean).join(" · ") || undefined,
					keywords: [t.ticket, t.title, t.status, t.release, ...(t.tags ?? [])].filter(Boolean).join(" "),
				})),
			});
			if (!pickedTickets || !pickedTickets.length) return;
			baseTickets = pickedTickets;
			const sharedRels = [...new Set(baseTickets.map((t) => t.release?.trim()).filter((r): r is string => Boolean(r)))];
			if (sharedRels.length === 1) defaultReleaseName = sharedRels[0]!;
		} else {
			baseTickets = chosenScope.tickets ?? [];
		}
	}
	if (!baseTickets.length) return notify("No tickets selected for the Release Bundle.");

	const releaseName = (await ask("Release name or version label", defaultReleaseName))?.trim();
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
		const pickedTag = await quickPick<string>({
			title: "Include local Git commits since a previous tag?",
			placeholder: "Choose a Git tag or skip…",
			items: [
				{ label: "Skip Git commit range", value: "__none__", icon: "dash" },
				...tags.slice(0, 20).map((t, i) => ({
					label: t.name,
					value: t.name,
					icon: "git-branch" as const,
					detail: t.sha,
					divide: i === 0,
					keywords: `${t.name} ${t.sha}`,
				})),
			],
		});
		if (!pickedTag) return;
		if (pickedTag !== "__none__") {
			gitRange = { from: pickedTag, to: "HEAD" };
			const log = await backend.gitRangeLog(pickedTag, "HEAD", 150).catch(() => []);
			if (log.length) commits = log;
		}
	}

	let chosenFormat = format;
	if (!chosenFormat) {
		const pickedFmt = await quickPick<"docx" | "html" | "markdown" | "csv">({
			title: `Export “${releaseName}” as`,
			placeholder: "Choose export format…",
			searchable: false,
			items: [
				{ label: "Word (.docx)", value: "docx", icon: "file", description: "Formatted Word dossier with TOC, tables, and embedded diagrams" },
				{ label: "HTML (Print / PDF)", value: "html", icon: "eye", description: "Standalone print-ready HTML with embedded images and Mermaid SVGs" },
				{ label: "Markdown (.md)", value: "markdown", icon: "note", description: "Portable Git-friendly Markdown bundle" },
				{ label: "CSV (.csv)", value: "csv", icon: "table", description: "Flat CAB / ServiceNow / Excel artifact manifest with SHA-256 checksums" },
			],
		});
		if (!pickedFmt) return;
		chosenFormat = pickedFmt;
	}

	let outputChoice: "both" | "bundle" | "notes" = "bundle";
	if (chosenFormat !== "csv") {
		const pickedOut = await quickPick<"both" | "bundle" | "notes">({
			title: `Generate artifacts for ${releaseName}`,
			placeholder: "Choose which documents to generate…",
			searchable: false,
			items: [
				{ label: "Release Bundle + Release Notes", value: "both", icon: "layers", description: "Full deployment dossier plus stakeholder release notes" },
				{ label: "Release Bundle only", value: "bundle", icon: "checklist", description: "Artifacts, checksums, runbook, rollback, and readiness" },
				{ label: "Release Notes only", value: "notes", icon: "megaphone", description: "Stakeholder-ready grouped change summary" },
			],
		});
		if (!pickedOut) return;
		outputChoice = pickedOut;
	}

	// Aggregate scripts, test scripts, plan business tests, SQL, registries, checksums, rebased rollback notes & readiness across all tickets.
	const anchorPath = joinPath(docsFolder(), "INDEX.md");
	const scripts: { ref: string; kind: string; ticket: string }[] = [];
	const testScripts: { ref: string; ticket: string }[] = [];
	const planTests: PlanBusinessTest[] = [];
	const seenPlanTests = new Set<string>();
	const sqlArtifacts: { path: string; kind: string; source: string; ticket: string }[] = [];
	const rollbackNotes: { ticket: string; source?: string; body: string }[] = [];
	const seenSpecRollback = new Set<string>();

	const [{ gitStatus }, headSha, manifestFiles, allTestRuns] = await Promise.all([
		import("./git"),
		backend.gitHeadSha().catch(() => null),
		backend.manifest().catch(() => []),
		loadWorkspaceTestRuns(allDocs),
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
		for (const p of planDocs) {
			const planName = p.heading || p.title || p.name;
			for (const pt of p.planTests ?? []) {
				const ptKey = `${planName.toLowerCase()}::${pt.name.toLowerCase()}`;
				if (seenPlanTests.has(ptKey)) continue;
				seenPlanTests.add(ptKey);
				planTests.push({ ...pt, plan: planName, ticket: k });
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
		if (docRb) rollbackNotes.push({ ticket: k, body: rewriteRelativeLinksForBase(docRb, doc.path, anchorPath) });
		for (const sp of specDocs) {
			const spKey = `${k.toLowerCase()}::${canonical(sp.path)}`;
			if (seenSpecRollback.has(spKey)) continue;
			seenSpecRollback.add(spKey);
			const spText = await current(sp.path);
			const spRb = spText ? extractRollbackSection(spText) : "";
			if (spRb) rollbackNotes.push({ ticket: k, source: sp.title || sp.name, body: rewriteRelativeLinksForBase(spRb, sp.path, anchorPath) });
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
			readiness: evaluateTicketReadiness(allDocs, k, {
				gitFiles,
				root: state.workspace?.root,
				testRuns: allTestRuns,
				currentGitSha: headSha,
			}),
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

	// Deduplicated SHA-256 checksums across all scripts, test scripts, and SQL artifacts in the bundle.
	const wsRoot = state.workspace?.root ?? "";
	const checksums: { path: string; sha256: string }[] = [];
	const seenChecksum = new Set<string>();
	const allArtifactRefs = [...scripts.map((s) => s.ref), ...testScripts.map((t) => t.ref), ...sqlArtifacts.map((s) => s.path)];
	for (const mf of manifestFiles) {
		if (!allArtifactRefs.some((ref) => codeMatchesRef(mf.path, ref, wsRoot))) continue;
		const ck = mf.path.toLowerCase();
		if (seenChecksum.has(ck)) continue;
		seenChecksum.add(ck);
		checksums.push({ path: mf.path, sha256: mf.sha256 });
	}

	const runbook = await buildDeploymentRunbookData({
		allDocs,
		scopeDocs,
		scripts,
		sqlArtifacts,
		registries,
		checksums,
		wsRoot,
	});

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
		planTests: planTests.length ? planTests : undefined,
		sqlArtifacts,
		registries,
		checksums: checksums.length ? checksums : undefined,
		runbook,
		rollbackNotes: rollbackNotes.length ? rollbackNotes : undefined,
		commits,
	};

	const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");
	const fileSlug = slug(releaseName).toLowerCase() || `release-${today()}`;
	const subtitle = `${bundleInput.projectName} · Generated ${today()}`;

	if (chosenFormat === "csv") {
		const csv = assembleReleaseBundleCsv(bundleInput);
		await saveExportFile(
			`${docsRel}/exports/${fileSlug}-release-bundle.csv`,
			`${fileSlug}-release-bundle.csv`,
			csv,
			"text/csv;charset=utf-8",
		);
		return;
	}

	const writeArtifact = async (kind: "bundle" | "notes", title: string, md: string) => {
		const suffix = kind === "bundle" ? "release-bundle" : "release-notes";
		if (chosenFormat === "markdown") {
			await saveExportFile(`${docsRel}/exports/${fileSlug}-${suffix}.md`, `${fileSlug}-${suffix}.md`, md, "text/markdown;charset=utf-8");
		} else if (chosenFormat === "docx") {
			await saveDocxExport(`${docsRel}/exports/${fileSlug}-${suffix}.docx`, title, subtitle, md, {
				baseDir: docsFolder(),
				baseDocPath: anchorPath,
				toc: kind === "bundle",
			});
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

	if (outputChoice === "both" || outputChoice === "bundle") {
		await writeArtifact("bundle", `${releaseName} — Release Bundle`, assembleReleaseBundleMarkdown(bundleInput));
	}
	if (outputChoice === "both" || outputChoice === "notes") {
		await writeArtifact("notes", `${releaseName} — Release Notes`, assembleReleaseNotesMarkdown(bundleInput));
	}
}

/**
 * Exports a Requirements Traceability Matrix (CSV, Markdown, HTML, or Word .docx)
 * linking tickets, acceptance criteria, specs, plans, code scripts, test scripts,
 * business test cases, validation test runs, decisions, registries, formal approvals, and HEAD Git SHA.
 */
export async function exportRtm(
	format?: "csv" | "markdown" | "html" | "docx",
	options?: { release?: string; tickets?: DocFile[] },
): Promise<void> {
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

	if (options?.tickets?.length) {
		selectedTickets = options.tickets.filter((t) => t.exists && t.group === "tickets" && t.ticket);
		if (options.release) {
			scopeSlug = `${slug(options.release).toLowerCase()}-rtm`;
			scopeTitle = `${scopeTitle} (${options.release})`;
		} else if (selectedTickets.length === 1 && selectedTickets[0]!.ticket) {
			scopeSlug = `${selectedTickets[0]!.ticket.toLowerCase()}-rtm`;
			scopeTitle = `${selectedTickets[0]!.ticket}: ${selectedTickets[0]!.title || selectedTickets[0]!.name}`;
		}
	} else if (options?.release) {
		const targetRel = options.release.trim().toLowerCase();
		selectedTickets = activeTickets.filter((t) =>
			targetRel === "unscheduled" ? !t.release?.trim() : t.release?.trim().toLowerCase() === targetRel,
		);
		scopeSlug = `${slug(options.release).toLowerCase()}-rtm`;
		scopeTitle = `${scopeTitle} (${options.release})`;
	} else if (releases.length || epics.length) {
		type RtmScope = { label: string; detail: string; description: string; tickets: DocFile[]; slug: string; title: string };
		const scopeItems: RtmScope[] = [
			{
				label: "All active tickets",
				detail: `${selectedTickets.length}`,
				description: "Every non-archived ticket in the project",
				tickets: selectedTickets,
				slug: "rtm",
				title: scopeTitle,
			},
		];
		for (const rel of releases) {
			const matched = activeTickets.filter((t) => t.release?.trim().toLowerCase() === rel.toLowerCase());
			scopeItems.push({
				label: `Release: ${rel}`,
				detail: `${matched.length} ${matched.length === 1 ? "ticket" : "tickets"}`,
				description: matched.map((t) => t.ticket).slice(0, 6).join(", "),
				tickets: matched,
				slug: `${slug(rel).toLowerCase()}-rtm`,
				title: `${scopeTitle} (${rel})`,
			});
		}
		for (const epic of epics) {
			const kids = descendantTickets(allDocs, epic.ticket!).filter((d) => toneOf(d.status) !== "off");
			const group = [epic, ...kids];
			scopeItems.push({
				label: `Epic: ${epic.ticket}`,
				detail: `${group.length} ${group.length === 1 ? "ticket" : "tickets"}`,
				description: epic.title || epic.name,
				tickets: group,
				slug: `${epic.ticket!.toLowerCase()}-rtm`,
				title: `${epic.ticket}: ${epic.title || epic.name}`,
			});
		}
		const hit = await quickPick<RtmScope>({
			title: "Build Requirements Traceability Matrix for which scope?",
			placeholder: "Filter releases, epics, or all tickets…",
			items: scopeItems.map((o) => ({
				label: o.label,
				value: o,
				icon: "table",
				detail: o.detail,
				description: o.description,
				keywords: `${o.label} ${o.description}`,
			})),
		});
		if (!hit) return;
		selectedTickets = hit.tickets;
		scopeSlug = hit.slug;
		scopeTitle = hit.title;
	}

	let chosenFormat = format;
	if (!chosenFormat) {
		const pickedFmt = await quickPick<"csv" | "docx" | "html" | "markdown">({
			title: "Export Requirements Traceability Matrix as",
			placeholder: "Choose export format…",
			searchable: false,
			items: [
				{ label: "CSV (.csv)", value: "csv", icon: "table", description: "Spreadsheet / QMS audit import with validation evidence columns" },
				{ label: "Word (.docx)", value: "docx", icon: "file", description: "Formatted Word RTM dossier with table of contents" },
				{ label: "HTML (Print / PDF)", value: "html", icon: "eye", description: "Standalone print-ready HTML matrix" },
				{ label: "Markdown (.md)", value: "markdown", icon: "note", description: "ADR-0008-compliant Markdown traceability matrix" },
			],
		});
		if (!pickedFmt) return;
		chosenFormat = pickedFmt;
	}

	const [headSha, testRuns] = await Promise.all([
		backend.gitHeadSha().catch(() => null),
		loadWorkspaceTestRuns(allDocs),
	]);
	const rows = buildRtmRows({
		docs: allDocs,
		tickets: selectedTickets,
		headSha,
		testRuns,
		currentGitSha: headSha,
	});
	const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");

	if (chosenFormat === "csv") {
		const csv = assembleRtmCsv(rows);
		await saveExportFile(`${docsRel}/exports/${scopeSlug}.csv`, `${scopeSlug}.csv`, csv, "text/csv;charset=utf-8");
		return;
	}

	const rtmMd = assembleRtmMarkdown(rows, scopeTitle);
	const title = `Requirements Traceability Matrix — ${scopeTitle}`;
	const subtitle = `${state.project?.name || state.workspace?.name || "Project"} · Generated ${today()}`;
	const anchorPath = joinPath(docsFolder(), "INDEX.md");

	if (chosenFormat === "markdown") {
		await saveExportFile(`${docsRel}/exports/${scopeSlug}.md`, `${scopeSlug}.md`, rtmMd, "text/markdown;charset=utf-8");
		return;
	}

	if (chosenFormat === "docx") {
		await saveDocxExport(`${docsRel}/exports/${scopeSlug}.docx`, title, subtitle, rtmMd, {
			baseDir: docsFolder(),
			baseDocPath: anchorPath,
			toc: true,
		});
		return;
	}

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

/** Syncs an already-open editor buffer from disk after an import writes over its path so `savedText`/`mtime` stay aligned without double-writing. */
async function syncImportedBuffer(importedPath: string): Promise<void> {
	const key = canonical(importedPath);
	if (!documents.get(key)) return;
	try {
		await changingOnDisk(importedPath, () => revert(key));
	} catch {
		// Ignore if unreadable; `openFile` will surface any file error.
	}
}

/** Prompts ADR 0009 conflict resolution when an import destination already exists on disk. */
async function promptImportConflict(existingPath: string): Promise<"copy" | "overwrite" | null> {
	const relExisting = state.workspace?.root ? relativeTo(state.workspace.root, existingPath).split("\\").join("/") : baseName(existingPath);
	const SAVE_COPY = "Save as copy";
	const OVERWRITE = "Overwrite existing";
	const picked = await choose(
		`${relExisting} already exists. Save the imported document as a new copy or overwrite the existing file (keeping a local history snapshot)?`,
		[SAVE_COPY, OVERWRITE],
		{ danger: OVERWRITE },
	);
	if (!picked) return null;
	return picked === OVERWRITE ? "overwrite" : "copy";
}

/**
 * Imports a legacy `.docx`, `.html`, or `.md` document into the workspace as Markdown,
 * with ADR 0009 conflict prompting, open-editor buffer sync, extracted Word images,
 * and clear notifications for unaccepted Track Changes or QA comments.
 */
export async function importLegacyDoc(
	targetGroup?: "docs" | "specs" | "knowledge" | "schema",
	explicitSourcePath?: string,
): Promise<void> {
	if (!ready()) return;
	let group = targetGroup;
	if (!group) {
		const picked = await quickPick<"docs" | "specs" | "knowledge" | "schema">({
			title: "Import document (.docx, .html, .md) into which folder?",
			placeholder: "Choose destination folder…",
			searchable: false,
			items: [
				{ label: "Docs", value: "docs", icon: "folder", detail: `${areaSaid("docs")}/`, description: "General project documentation" },
				{ label: "Specs", value: "specs", icon: "file", detail: `${areaSaid("docs")}/specs/`, description: "Functional & technical specifications" },
				{ label: "Knowledge (Reference)", value: "knowledge", icon: "note", detail: `${areaSaid("docs")}/knowledge/reference/`, description: "SOPs, runbooks, & architecture notes" },
				{ label: "Schema (Database)", value: "schema", icon: "database", detail: `${areaSaid("schema")}/database/`, description: "Database & data contract docs" },
			],
		});
		if (!picked) return;
		group = picked;
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

	let sourcePath = explicitSourcePath?.trim() || undefined;
	if (!sourcePath && state.info?.host !== "app") {
		const typed = (await ask("Full path to the .docx, .html, or .md file to import"))?.trim();
		if (!typed) return;
		sourcePath = typed.replace(/^(["'])(.*)\1$/, "$2");
	}

	try {
		let res = await backend.importDocFile({ sourcePath, destDir, attachmentsDir, onConflict: "prompt" });
		if (!res) return;
		if (res.conflict) {
			const resolution = await promptImportConflict(res.existingPath || res.path);
			if (!resolution) return;
			res = await backend.importDocFile({ sourcePath: res.sourcePath ?? sourcePath, destDir, attachmentsDir, onConflict: resolution });
			if (!res) return;
		}
		await syncImportedBuffer(res.path);
		setState("treeVersion", (v) => v + 1);
		const imgNote = res.images.length ? ` (${res.images.length} ${res.images.length === 1 ? "image" : "images"} extracted)` : "";
		notify(`Imported ${relativeTo(root(), res.path)} from ${res.kind.toUpperCase()}${imgNote}.`);
		if (res.warnings?.length) {
			notify(`${baseName(res.path)}: ${res.warnings.join(" ")}`);
		}
		await openFile(res.path);
	} catch (e: any) {
		notify(`Could not import document: ${e?.message ?? e}`, "error");
	}
}

/**
 * Safe `.docx` drop/upload importer using `backend.importDocxBytes` with `onConflict: "prompt"`,
 * ADR 0009 conflict confirmation, open-editor buffer synchronization via `put()`, and clear
 * Track-Changes / QA-comment warnings.
 */
export async function importDocxDrop(options: {
	fileName: string;
	base64: string;
	destDir: string;
	attachmentsDir?: string;
}): Promise<{ path: string; images: string[]; warnings?: string[] } | null> {
	if (!state.workspace?.root) {
		notify("Open a folder first.", "error");
		return null;
	}
	const configuredAttach = state.settings.attachmentsFolder?.trim();
	const attachmentsDir =
		options.attachmentsDir ??
		(configuredAttach
			? resolvePath(root(), configuredAttach.replace(/\\/g, "/").replace(/^\/+/, ""))
			: joinPath(docsFolder(), "attachments"));

	try {
		let res = await backend.importDocxBytes({
			fileName: options.fileName,
			base64: options.base64,
			destDir: options.destDir,
			attachmentsDir,
			onConflict: "prompt",
		});
		if (res.conflict) {
			const resolution = await promptImportConflict(res.existingPath || res.path);
			if (!resolution) return null;
			res = await backend.importDocxBytes({
				fileName: options.fileName,
				base64: options.base64,
				destDir: options.destDir,
				attachmentsDir,
				onConflict: resolution,
			});
		}
		await syncImportedBuffer(res.path);
		setState("treeVersion", (v) => v + 1);
		const imgNote = res.images.length ? ` (${res.images.length} ${res.images.length === 1 ? "image" : "images"} extracted)` : "";
		notify(`Imported ${relativeTo(root(), res.path)}${imgNote}.`);
		if (res.warnings?.length) {
			notify(`${baseName(res.path)}: ${res.warnings.join(" ")}`);
		}
		return { path: res.path, images: res.images, ...(res.warnings?.length ? { warnings: res.warnings } : {}) };
	} catch (e: any) {
		notify(`Could not import Word document: ${e?.message ?? e}`, "error");
		return null;
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
	if (!state.workspace || root() !== wsRoot) return;
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
	const needsSetup = !state.project?.configured;
	const [hasDbCsv, hasFilesCsv, plannedSetup] = await Promise.all([
		current(dbCsvPath).then((t) => t !== null),
		current(filesCsvPath).then((t) => t !== null),
		needsSetup ? backend.setupPreview().catch(() => [] as string[]) : Promise.resolve([] as string[]),
	]);
	if (!state.workspace || root() !== wsRoot) return;
	const actions: string[] = [];
	if (needsSetup) {
		actions.push(plannedSetup.length ? `create ${plannedSetup.join(", ")}` : "create .ssl-studio/project.toml");
	}
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
	if (!state.workspace || root() !== wsRoot) return;

	if (picked === LIST_ONLY) {
		const preview = legacyMdFiles.slice(0, 12).join(", ") + (legacyMdFiles.length > 12 ? `, and ${legacyMdFiles.length - 12} more` : "");
		notify(`Legacy Markdown outside ${areaSaid("docs")}/ (${legacyMdFiles.length}): ${preview}`);
		return;
	}

	const created: string[] = [];
	try {
		if (needsSetup) {
			const made = await backend.setupProject();
			if (!state.workspace || root() !== wsRoot) return;
			created.push(...made);
			const refreshed = await backend.project();
			if (!state.workspace || root() !== wsRoot) return;
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
			if (!state.workspace || root() !== wsRoot) return;
			const csvBody = `${csvRow(dbKind.columns)}\n${rows.length ? `${rows.join("\n")}\n` : ""}`;
			await put(dbCsvPath, csvBody, false);
			created.push(relativeTo(wsRoot, dbCsvPath).split("\\").join("/"));
		}

		if (!hasFilesCsv) {
			const ownRel = relativeTo(wsRoot, filesCsvPath).split("\\").join("/");
			const manifest = (await backend.manifest()).filter((f) => f.path !== ownRel);
			if (!state.workspace || root() !== wsRoot) return;
			const merged = mergeManifest(null, manifest);
			await put(filesCsvPath, merged.text, false);
			created.push(ownRel);
		}

		if (!state.workspace || root() !== wsRoot) return;
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

// --- Controlled-Document Approval, Validation Protocols, Release Readiness, Clone & Split ---

/** Computes an incremented version string (`keep`, `minor`, or `major`) from a current version label. */
function computeVersionBump(currentVersion: string | undefined, kind: "keep" | "minor" | "major"): string {
	const raw = (currentVersion ?? "").trim();
	if (kind === "keep") return raw;
	const stripped = raw.replace(/^v/i, "");
	const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(stripped);
	if (!match) return kind === "major" ? "1.0" : raw ? `${raw}.1` : "1.0";
	const major = Number(match[1]);
	const minor = match[2] !== undefined ? Number(match[2]) : 0;
	const hasPatch = match[3] !== undefined;
	if (kind === "major") {
		return hasPatch ? `${major + 1}.0.0` : `${major + 1}.0`;
	}
	return hasPatch ? `${major}.${minor + 1}.0` : `${major}.${minor + 1}`;
}

/** Adds `months` calendar months to an ISO `YYYY-MM-DD` date string (clamping day to month end). */
function addMonthsIso(isoDate: string, months: number): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
	if (!m) return isoDate;
	const year = Number(m[1]);
	const monthIdx = Number(m[2]) - 1 + months;
	const day = Number(m[3]);
	const targetYear = year + Math.floor(monthIdx / 12);
	const targetMonth = ((monthIdx % 12) + 12) % 12;
	const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
	const clamped = Math.min(day, lastDay);
	return `${String(targetYear).padStart(4, "0")}-${String(targetMonth + 1).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

/** Clips plain table cells to ADR 0008 column width limits and escapes Markdown pipes. */
function clipRevisionCell(value: string, maxLen: number): string {
	const clean = value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
	const esc = (s: string) => s.replace(/\|/g, "\\|");
	if (clean.length <= maxLen) return esc(clean);
	return esc(`${clean.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`);
}

/** Stamps controlled-doc approval metadata in YAML frontmatter and appends an ADR-0008 Revision History row. */
function applyApprovalToMarkdown(
	text: string,
	input: {
		approver: string;
		date: string;
		version?: string;
		changeControl?: string;
		reviewDue?: string;
		summary: string;
	},
): string {
	let next = text;
	next = withFrontMatter(next, "status", "approved") ?? next;
	next = withFrontMatter(next, "approved-by", input.approver) ?? next;
	next = withFrontMatter(next, "approved-date", input.date) ?? next;
	next = withFrontMatter(next, "effective-date", input.date) ?? next;
	if (input.version?.trim()) next = withFrontMatter(next, "version", input.version.trim()) ?? next;
	if (input.changeControl?.trim()) next = withFrontMatter(next, "change-control", input.changeControl.trim()) ?? next;
	if (input.reviewDue?.trim()) next = withFrontMatter(next, "review-due", input.reviewDue.trim()) ?? next;

	const eol = next.includes("\r\n") ? "\r\n" : "\n";
	const verCell = clipRevisionCell(input.version?.trim() || one(frontMatter(next).values.version) || "1.0", 20);
	const dateCell = clipRevisionCell(input.date, 20);
	const authorCell = clipRevisionCell(input.approver, 20);
	const summaryCell = clipRevisionCell(input.summary, 120);
	const newRow = `| ${verCell} | ${dateCell} | ${authorCell} | ${summaryCell} |`;

	const lines = next.split(/\r?\n/);
	const fmLines = frontMatter(next).lines;
	let headingIdx = -1;
	let fenceChar = "";
	let fenceLen = 0;
	for (let i = fmLines; i < lines.length; i++) {
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
			continue;
		}
		if (fenceChar) continue;
		if (/^[ \t]{0,3}##[ \t]+Revision\s+History\b/i.test(ln)) {
			headingIdx = i;
			break;
		}
	}

	if (headingIdx >= 0) {
		// Find the end of the Revision History section and any pipe table inside it.
		let sectionEnd = lines.length;
		for (let i = headingIdx + 1; i < lines.length; i++) {
			if (/^[ \t]{0,3}#{1,2}[ \t]+/.test(lines[i]!)) {
				sectionEnd = i;
				break;
			}
		}
		let lastTableRow = -1;
		for (let i = headingIdx + 1; i < sectionEnd; i++) {
			if (lines[i]!.trim().startsWith("|") && i + 1 < sectionEnd && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
				let end = i + 2;
				while (end < sectionEnd && lines[end]!.trim().startsWith("|")) end++;
				lastTableRow = end;
				break;
			}
		}
		if (lastTableRow >= 0) {
			lines.splice(lastTableRow, 0, newRow);
		} else {
			lines.splice(headingIdx + 1, 0, "", "| Version | Date | Author | Summary |", "| --- | --- | --- | --- |", newRow);
		}
		return lines.join(eol);
	}

	const trimmed = next.replace(/(?:\r?\n)+$/, "");
	return [
		trimmed,
		"",
		"## Revision History",
		"",
		"| Version | Date | Author | Summary |",
		"| --- | --- | --- | --- |",
		newRow,
		"",
	].join(eol);
}

/**
 * Guided controlled-document approval workflow (ISO-17025 / GxP):
 * prompts approver, optional change-control ID, version bump, and periodic `review-due`,
 * stamps frontmatter governance metadata, and appends an ADR-0008 row to `## Revision History`.
 */
export async function recordDocApproval(targetPath?: string): Promise<void> {
	if (!ready()) return;
	const startRoot = root();
	const docPath = targetPath ?? activePath();
	if (!docPath || !isMarkdown(docPath)) {
		notify("Open a Markdown document first to record approval.");
		return;
	}
	const before = await current(docPath);
	if (before === null) return notify("Could not read the document.", "error");
	const fm = frontMatter(before);
	const gitAuthor = (await backend.gitLog(docPath, 1).catch(() => []))[0]?.author?.trim() ?? "";
	const defaultApprover =
		one(fm.values["approved-by"]) ||
		recall("docs.lastApprover")?.trim() ||
		one(fm.values.reviewer) ||
		gitAuthor;

	const approver = (await ask(`Approver name or role for ${baseName(docPath)}`, defaultApprover))?.trim();
	if (!approver) return;
	if (!state.workspace || root() !== startRoot) return;
	remember("docs.lastApprover", approver);

	const ccInput = await ask("Change-control / CAB ID (optional, leave empty to skip)", one(fm.values["change-control"]) || "");
	if (ccInput === null) return;
	if (!state.workspace || root() !== startRoot) return;
	const changeControl = ccInput.trim();

	const curVer = one(fm.values.version);
	const minorVer = computeVersionBump(curVer, "minor");
	const majorVer = computeVersionBump(curVer, "major");
	const versionPick = await quickPick<string>({
		title: `Version for ${baseName(docPath)}`,
		placeholder: "Choose version bump…",
		searchable: false,
		items: curVer
			? [
					{ label: `Bump minor (${curVer} -> ${minorVer})`, value: minorVer, icon: "arrow-up", description: "Recommended for controlled revisions" },
					{ label: `Bump major (${curVer} -> ${majorVer})`, value: majorVer, icon: "sparkle", description: "Major baseline or breaking specification change" },
					{ label: `Keep ${curVer}`, value: curVer, icon: "check", description: "Keep current version number unchanged" },
				]
			: [
					{ label: "Set version 1.0", value: "1.0", icon: "check", description: "Initial approved controlled release" },
					{ label: "Set version 0.1", value: "0.1", icon: "arrow-up", description: "Preliminary controlled baseline" },
					{ label: "Keep unversioned", value: "__none__", icon: "dash", description: "Do not add a version field" },
				],
	});
	if (!versionPick) return;
	if (!state.workspace || root() !== startRoot) return;
	const nextVersion = versionPick === "__none__" ? "" : versionPick;

	const approvalDate = today();
	const plusYear = addMonthsIso(approvalDate, 12);
	const plusSix = addMonthsIso(approvalDate, 6);
	const reviewPick = await quickPick<string>({
		title: `Periodic review deadline (review-due)`,
		placeholder: "Choose review schedule…",
		searchable: false,
		items: [
			{ label: "+1 year", value: plusYear, icon: "sync", detail: plusYear, description: "Standard annual GxP / ISO-17025 document review" },
			{ label: "+6 months", value: plusSix, icon: "sync", detail: plusSix, description: "Semi-annual review cycle" },
			{ label: "None", value: "__none__", icon: "dash", description: "Do not set review-due" },
		],
	});
	if (!reviewPick) return;
	if (!state.workspace || root() !== startRoot) return;
	const reviewDue = reviewPick === "__none__" ? "" : reviewPick;

	// Re-read current buffer after confirmation modals so edits made meanwhile are preserved.
	const freshBefore = await current(docPath);
	if (freshBefore === null) return notify("Could not read the document.", "error");
	const summary = changeControl ? `Approved (${changeControl})` : "Formal approval recorded";
	const after = applyApprovalToMarkdown(freshBefore, {
		approver,
		date: approvalDate,
		version: nextVersion || undefined,
		changeControl: changeControl || undefined,
		reviewDue: reviewDue || undefined,
		summary,
	});
	try {
		await put(docPath, after, true);
		setState("treeVersion", (v) => v + 1);
		notify(`Recorded approval on ${baseName(docPath)} (${nextVersion ? `v${nextVersion}, ` : ""}${approver}, ${approvalDate}).`);
		await openFile(docPath);
	} catch (e: any) {
		notify(`Could not record approval: ${e?.message ?? e}`, "error");
	}
}

/** Resolves a ticket DocFile from an explicit path, active editor/ticket, or a searchable QuickPick. */
async function resolveTargetTicket(ticketPath: string | undefined, pickTitle: string): Promise<DocFile | null> {
	const allDocs = docs();
	const allTickets = allDocs
		.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket)
		.sort((a, b) => (a.ticket ?? "").localeCompare(b.ticket ?? "", undefined, { numeric: true, sensitivity: "base" }));
	if (!allTickets.length) {
		notify("No tickets exist in this project yet.");
		return null;
	}
	if (ticketPath) {
		const hit = allTickets.find((t) => canonical(t.path) === canonical(ticketPath));
		if (hit) return hit;
	}
	const openPath = activePath();
	if (openPath) {
		const openTicket = allTickets.find((t) => canonical(t.path) === canonical(openPath));
		if (openTicket) return openTicket;
	}
	const picked = await quickPick<DocFile>({
		title: pickTitle,
		placeholder: "Filter by ticket key, title, status, or release…",
		items: allTickets.map((t) => ({
			label: `${t.ticket}: ${t.title || t.name}`,
			value: t,
			icon: "checklist",
			badge: t.status ? { text: t.status, tone: toneOf(t.status) } : undefined,
			detail: t.release || undefined,
			keywords: [t.ticket, t.title, t.status, t.release].filter(Boolean).join(" "),
		})),
	});
	return picked;
}

/**
 * Generates a pre-populated IQ/OQ/PQ Validation Test Execution Protocol Markdown document
 * from linked `plan.tests`, ticket acceptance checklist, `testScripts`, and current Git HEAD SHA.
 */
export async function generateTestExecutionProtocol(ticketPath?: string): Promise<void> {
	if (!ready()) return;
	const ticketDoc = await resolveTargetTicket(ticketPath, "Generate IQ/OQ/PQ Test Execution Protocol for which ticket?");
	if (!ticketDoc?.ticket) return;
	const key = ticketDoc.ticket;

	const phase = await quickPick<TestRunPhase>({
		title: `${key}: Validation phase`,
		placeholder: "Choose qualification phase…",
		searchable: false,
		items: [
			{ label: "OQ — Operational Qualification", value: "OQ", icon: "beaker", description: "Verify business logic, calculations, and error handling" },
			{ label: "IQ — Installation Qualification", value: "IQ", icon: "tools", description: "Verify DDL, scripts, settings, and roles deployed cleanly" },
			{ label: "PQ — Performance / User Acceptance", value: "PQ", icon: "pass", description: "Verify end-to-end laboratory workflow with realistic data" },
		],
	});
	if (!phase) return;

	const environment = await quickPick<string>({
		title: `${key} (${phase}): Target STARLIMS environment`,
		placeholder: "Choose execution environment…",
		searchable: false,
		items: [
			{ label: "QA", value: "QA", icon: "beaker", description: "Quality Assurance validation environment" },
			{ label: "UAT", value: "UAT", icon: "pass", description: "User Acceptance Testing environment" },
			{ label: "PROD", value: "PROD", icon: "warning", description: "Production post-deploy verification" },
			{ label: "DEV", value: "DEV", icon: "tools", description: "Development integration environment" },
		],
	});
	if (!environment) return;

	const allDocs = docs();
	const ticketText = (await current(ticketDoc.path)) ?? "";
	const checklistItems = tasks(ticketText).map((t) => t.text).filter(Boolean);
	const activeDescendants = descendantTickets(allDocs, key).filter((d) => toneOf(d.status) !== "off");
	const scopeKeys = [key, ...activeDescendants.map((d) => d.ticket).filter((k): k is string => Boolean(k))];
	const scopeGroups = scopeKeys.flatMap((k) => ticketWork(allDocs, k));

	const seenPlan = new Set<string>();
	const planTests: { name: string; given?: string; expect?: string; plan?: string }[] = [];
	const testScriptSet = new Set<string>();
	for (const ts of ticketDoc.testScripts ?? []) {
		if (ts.trim()) testScriptSet.add(ts.trim());
	}
	for (const g of scopeGroups) {
		if (g.kind === "plan" || g.kind === "spec") {
			for (const f of g.files) {
				for (const ts of f.testScripts ?? []) {
					if (ts.trim()) testScriptSet.add(ts.trim());
				}
				if (g.kind === "plan") {
					const c = canonical(f.path);
					if (seenPlan.has(c)) continue;
					seenPlan.add(c);
					const planLabel = f.heading || f.title || f.name;
					for (const pt of f.planTests ?? []) {
						planTests.push({ ...pt, plan: planLabel });
					}
				}
			}
		}
	}

	const [gitSha, gitLog] = await Promise.all([
		backend.gitHeadSha().catch(() => null),
		backend.gitLog(ticketDoc.path, 1).catch(() => []),
	]);
	const executedBy = recall("docs.lastApprover")?.trim() || gitLog[0]?.author?.trim() || "";
	const runDate = today();

	const protocolMd = assembleTestExecutionProtocol({
		ticketKey: key,
		ticketTitle: ticketDoc.title || key,
		phase,
		environment,
		gitSha: gitSha ?? undefined,
		executedBy,
		executedDate: runDate,
		projectName: state.project?.name || state.workspace?.name || "Project",
		planTests,
		checklistItems,
		testScripts: [...testScriptSet],
		changeControl: ticketDoc.changeControl,
	});

	const baseDir = ticketDoc.ticketFolder
		? joinPath(ticketDoc.ticketFolder, "test-runs")
		: joinPath(docsFolder(), "tests");
	const baseStem = ticketDoc.ticketFolder
		? `${runDate}-${environment.toLowerCase()}-${phase.toLowerCase()}`
		: `${key}-${runDate}-${environment.toLowerCase()}-${phase.toLowerCase()}`;

	let dest = joinPath(baseDir, `${baseStem}.md`);
	let n = 2;
	while ((await current(dest)) !== null && n < 50) {
		dest = joinPath(baseDir, `${baseStem}-${n++}.md`);
	}

	await start(dest, protocolMd);
	notify(`Created ${phase} validation protocol at ${relativeTo(root(), dest).split("\\").join("/")}.`);
}

/**
 * Interactive Release Readiness dashboard via QuickPick:
 * groups active tickets by `release:` (or `Unscheduled`), evaluates readiness (including validation runs),
 * and lets you jump directly to any blocked ticket or export the Release Bundle / RTM in one click.
 */
export async function openReleaseReadiness(): Promise<void> {
	if (!ready()) return;
	const allDocs = docs();
	const activeTickets = allDocs.filter(
		(d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket && !isArchivedTicket(d) && toneOf(d.status) !== "off",
	);
	if (!activeTickets.length) return notify("No active tickets found to evaluate release readiness.");

	const [{ gitStatus }, headSha, allTestRuns] = await Promise.all([
		import("./git"),
		backend.gitHeadSha().catch(() => null),
		loadWorkspaceTestRuns(allDocs),
	]);
	const gitFiles = gitStatus()?.files;

	type TicketEval = { doc: DocFile; report: ReturnType<typeof evaluateTicketReadiness>; staleRuns: number };
	const byRelease = new Map<string, TicketEval[]>();
	for (const t of activeTickets) {
		const rel = t.release?.trim() || "Unscheduled";
		const report = evaluateTicketReadiness(allDocs, t.ticket!, {
			gitFiles,
			root: state.workspace?.root,
			testRuns: allTestRuns,
			currentGitSha: headSha,
		});
		const staleRuns = allTestRuns.filter(
			(r) => r.ticket.trim().toLowerCase() === t.ticket!.toLowerCase() && isTestRunStale(r, headSha),
		).length;
		const bucket = byRelease.get(rel) ?? [];
		bucket.push({ doc: t, report, staleRuns });
		byRelease.set(rel, bucket);
	}

	const releaseNames = [...byRelease.keys()].sort((a, b) => {
		if (a === "Unscheduled") return 1;
		if (b === "Unscheduled") return -1;
		return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
	});

	const chosenRelease = await quickPick<string>({
		title: "Release Readiness",
		placeholder: "Filter releases to inspect blockers or export CAB bundles…",
		items: releaseNames.map((rel) => {
			const list = byRelease.get(rel)!;
			const readyCount = list.filter((x) => x.report?.ready).length;
			const blockedCount = list.length - readyCount;
			const staleCount = list.reduce((sum, x) => sum + x.staleRuns, 0);
			const tone = blockedCount === 0 ? ("done" as const) : readyCount > 0 ? ("active" as const) : ("waiting" as const);
			const sampleKeys = list.map((x) => x.doc.ticket).slice(0, 6).join(", ") + (list.length > 6 ? "…" : "");
			const detailBits = [
				blockedCount > 0 ? `${blockedCount} blocked` : "All clear",
				staleCount > 0 ? `${staleCount} stale run${staleCount === 1 ? "" : "s"}` : "",
			].filter(Boolean);
			return {
				label: `${rel} · ${readyCount}/${list.length} ready`,
				value: rel,
				icon: blockedCount === 0 ? "pass" : "warning",
				badge: { text: `${readyCount}/${list.length} ready`, tone },
				detail: detailBits.join(" · "),
				description: sampleKeys,
				keywords: `${rel} ${list.map((x) => `${x.doc.ticket} ${x.doc.title ?? ""}`).join(" ")}`,
			};
		}),
	});
	if (!chosenRelease) return;

	const evals = (byRelease.get(chosenRelease) ?? []).slice().sort((a, b) => {
		const aReady = a.report?.ready ? 1 : 0;
		const bReady = b.report?.ready ? 1 : 0;
		return aReady - bReady || (a.doc.ticket ?? "").localeCompare(b.doc.ticket ?? "", undefined, { numeric: true });
	});
	const releaseTicketDocs = evals.map((e) => e.doc);

	type DrillAction = { kind: "bundle" } | { kind: "rtm" } | { kind: "open"; path: string };
	const drillItems: QuickPickOption<DrillAction>[] = [
		{
			label: `Export Release Bundle for ${chosenRelease}…`,
			value: { kind: "bundle" },
			icon: "layers",
			detail: `${releaseTicketDocs.length} tickets`,
			description: "Assemble Release Bundle, Runbook, Checksums & Release Notes",
			keywords: "export release bundle cab",
		},
		{
			label: `Export Traceability Matrix (RTM) for ${chosenRelease}…`,
			value: { kind: "rtm" },
			icon: "table",
			detail: `${releaseTicketDocs.length} tickets`,
			description: "Export audit-ready RTM (CSV, Word, HTML, or Markdown)",
			keywords: "export rtm traceability matrix",
		},
		...evals.map((ev, i) => {
			const r = ev.report;
			const warns = r ? r.checks.filter((c) => c.level === "warn") : [];
			const jumpPath = warns[0]?.path ?? ev.doc.path;
			const warnSummary = warns.length
				? warns.map((w) => `${w.label}: ${w.detail}`).join("; ")
				: "All release readiness checks pass";
			return {
				label: `${ev.doc.ticket}: ${ev.doc.title || ev.doc.name}`,
				value: { kind: "open", path: jumpPath } as DrillAction,
				icon: (r?.ready ? "pass" : "warning") as "pass" | "warning",
				badge: { text: r?.ready ? "READY" : "BLOCKED", tone: r?.ready ? ("done" as const) : ("off" as const) },
				detail: r ? `${r.pass}/${r.total} checks` : undefined,
				description: warnSummary,
				divide: i === 0,
				keywords: `${ev.doc.ticket} ${ev.doc.title ?? ""} ${ev.doc.status ?? ""} ${warnSummary}`,
			};
		}),
	];

	const action = await quickPick<DrillAction>({
		title: `${chosenRelease} — Release Readiness`,
		placeholder: "Jump to a blocked ticket or export Release Bundle / RTM…",
		items: drillItems,
	});
	if (!action) return;
	if (action.kind === "bundle") {
		await exportReleaseBundle(undefined, { release: chosenRelease, tickets: releaseTicketDocs });
	} else if (action.kind === "rtm") {
		await exportRtm(undefined, { release: chosenRelease, tickets: releaseTicketDocs });
	} else {
		await openFile(action.path);
	}
}

/**
 * Clones an existing ticket's governance & organizational metadata (`release`, `parent`,
 * `change-control`, `gxp-impact`, `priority`, `tags`, `specs`) into a brand-new ticket with fresh unchecked sections.
 */
export async function cloneTicket(targetPath?: string): Promise<void> {
	if (!ready()) return;
	const srcDoc = await resolveTargetTicket(targetPath, "Clone which ticket?");
	if (!srcDoc?.ticket) return;
	const srcKey = srcDoc.ticket;
	const srcText = (await current(srcDoc.path)) ?? "";
	const fm = frontMatter(srcText).values;

	const rawKey = await ask(`New ticket key (cloning ${srcKey})`);
	const newKey = ticketKey(rawKey ?? "");
	if (!newKey) return;
	const duplicate = docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === newKey.toLowerCase());
	if (duplicate) {
		notify(`${newKey} already exists (${relativeTo(root(), duplicate.path)}): opened.`);
		await openFile(duplicate.path);
		return;
	}

	const srcTitle = srcDoc.title || one(fm.title) || srcKey;
	const newTitle = (await ask(`${newKey}: title`, `${srcTitle} (copy)`))?.trim();
	if (!newTitle) return;

	const FOLDER = "Ticket folder";
	const SINGLE = "Single file";
	const layout = await choose(
		`Create ${newKey} in its own ticket folder (${relativeTo(root(), joinPath(areaFolder("tickets"), newKey))}/) or as a single Markdown file?`,
		srcDoc.ticketFolder ? [FOLDER, SINGLE] : [SINGLE, FOLDER],
	);
	if (!layout) return;

	const srcType = one(fm.type) || undefined;
	const srcParent = srcDoc.parent || one(fm.parent) || undefined;
	let fresh = ticketTemplate({
		key: newKey,
		title: newTitle,
		type: srcType,
		parent: srcParent,
		related: [srcKey],
	});

	const releaseVal = srcDoc.release || one(fm.release);
	const priorityVal = srcDoc.priority || one(fm.priority);
	const ccVal = srcDoc.changeControl || one(fm["change-control"]);
	const gxpVal = srcDoc.gxpImpact || one(fm["gxp-impact"]);
	if (releaseVal) fresh = withFrontMatter(fresh, "release", releaseVal) ?? fresh;
	if (priorityVal) fresh = withFrontMatter(fresh, "priority", priorityVal) ?? fresh;
	if (ccVal) fresh = withFrontMatter(fresh, "change-control", ccVal) ?? fresh;
	if (gxpVal) fresh = withFrontMatter(fresh, "gxp-impact", gxpVal) ?? fresh;

	for (const tag of many(fm.tags)) fresh = addToFrontMatterList(fresh, "tags", tag) ?? fresh;
	for (const sp of [...many(fm.specs), ...many(fm.spec)]) fresh = addToFrontMatterList(fresh, "specs", sp) ?? fresh;

	const dest =
		layout === FOLDER
			? joinPath(areaFolder("tickets"), newKey, `${newKey}.md`)
			: joinPath(areaFolder("tickets"), `${newKey}.md`);
	await start(dest, fresh, "tickets");
}

/** Extracts all unchecked `- [ ]` checklist lines (1-based line numbers) outside frontmatter & fenced code blocks. */
function extractUncheckedChecklistLines(markdown: string): { line: number; text: string; raw: string }[] {
	const fmLines = frontMatter(markdown).lines;
	const lines = markdown.split(/\r?\n/);
	const out: { line: number; text: string; raw: string }[] = [];
	let fenceChar = "";
	let fenceLen = 0;
	for (let i = fmLines; i < lines.length; i++) {
		const raw = lines[i]!;
		const fm = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(raw);
		if (fm) {
			if (!fenceChar) {
				fenceChar = fm[1]![0]!;
				fenceLen = fm[1]!.length;
			} else if (fm[1]![0] === fenceChar && fm[1]!.length >= fenceLen && /^[ \t]*$/.test(raw.slice(fm[0].length))) {
				fenceChar = "";
				fenceLen = 0;
			}
			continue;
		}
		if (fenceChar) continue;
		const m = /^[ \t]*[-*+][ \t]+\[ \][ \t]+(.+)$/.exec(raw);
		if (m && m[1]!.trim()) {
			out.push({ line: i + 1, text: m[1]!.trim(), raw });
		}
	}
	return out;
}

/** Removes selected 1-based checklist line numbers from a parent ticket and records a clean wikilink back to the new child ticket. */
function splitParentTicketChecklist(
	markdown: string,
	removedLines: ReadonlySet<number>,
	childKey: string,
	childTitle: string,
): string {
	const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
	const lines = markdown.split(/\r?\n/);
	const kept = lines.filter((_, idx) => !removedLines.has(idx + 1));
	const linkLine = `- Split to [[${childKey}]]: ${childTitle}`;

	// Place backlink under `## Notes` when present; otherwise append under a new `## Notes` section.
	const notesIdx = kept.findIndex((ln) => /^[ \t]{0,3}##[ \t]+Notes\b/i.test(ln));
	if (notesIdx >= 0) {
		let insertAt = notesIdx + 1;
		while (insertAt < kept.length && !/^[ \t]{0,3}#{1,2}[ \t]+/.test(kept[insertAt]!)) {
			insertAt++;
		}
		while (insertAt > notesIdx + 1 && !kept[insertAt - 1]!.trim()) insertAt--;
		if (insertAt === notesIdx + 1) kept.splice(insertAt, 0, "", linkLine);
		else kept.splice(insertAt, 0, linkLine);
	} else {
		while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
		kept.push("", "## Notes", "", linkLine, "");
	}
	return kept.join(eol).replace(/(\r?\n){3,}/g, `${eol}${eol}`);
}

/** Suggests a deterministic next sub-ticket key (e.g. `LIMS-100-1` or `LIMS-101`). */
function suggestSubticketKey(parentKey: string, allDocs: readonly DocFile[]): string {
	const taken = new Set(
		allDocs
			.filter((d) => d.exists && d.group === "tickets" && d.ticket)
			.map((d) => d.ticket!.toLowerCase()),
	);
	let n = 1;
	while (taken.has(`${parentKey}-${n}`.toLowerCase())) n++;
	return `${parentKey}-${n}`;
}

/**
 * Splits unchecked `- [ ]` checklist items out of a ticket into a new child sub-ticket (`parent: <KEY>`)
 * using `quickPickMany()`, moving selected items into the child and linking back from the parent.
 */
export async function splitTicketSubticket(targetPath?: string): Promise<void> {
	if (!ready()) return;
	const startRoot = root();
	const srcDoc = await resolveTargetTicket(targetPath, "Split checklist items from which ticket?");
	if (!srcDoc?.ticket) return;
	if (!state.workspace || root() !== startRoot) return;
	const parentKey = srcDoc.ticket;
	const srcText = await current(srcDoc.path);
	if (srcText === null) return notify("Could not read the ticket.", "error");

	const unchecked = extractUncheckedChecklistLines(srcText);
	if (!unchecked.length) {
		notify(`No unchecked checklist items (- [ ]) found in ${parentKey} to split.`);
		return;
	}

	const pickedItems = await quickPickMany<{ line: number; text: string; raw: string }>({
		title: `Move checklist items from ${parentKey} to a new sub-ticket`,
		placeholder: "Select unchecked items to split out…",
		confirmLabel: "Split selected",
		items: unchecked.map((item) => ({
			label: item.text,
			value: item,
			icon: "checklist",
			detail: `line ${item.line}`,
			keywords: item.text,
		})),
	});
	if (!pickedItems || !pickedItems.length) return;
	if (!state.workspace || root() !== startRoot) return;

	const allDocs = docs();
	const suggestedKey = suggestSubticketKey(parentKey, allDocs);
	const rawChildKey = await ask(`New sub-ticket key under ${parentKey}`, suggestedKey);
	const childKey = ticketKey(rawChildKey ?? "");
	if (!childKey) return;
	if (!state.workspace || root() !== startRoot) return;
	const duplicate = allDocs.find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === childKey.toLowerCase());
	if (duplicate) {
		notify(`${childKey} already exists (${relativeTo(startRoot, duplicate.path)}).`, "error");
		return;
	}

	const defaultTitle =
		pickedItems.length === 1
			? pickedItems[0]!.text
			: `${srcDoc.title || parentKey} — follow-up`;
	const childTitle = (await ask(`${childKey}: sub-ticket title`, defaultTitle))?.trim();
	if (!childTitle) return;
	if (!state.workspace || root() !== startRoot) return;

	// Re-read parent ticket after confirmation modals so edits made meanwhile are preserved.
	const freshSrcText = await current(srcDoc.path);
	if (freshSrcText === null) return notify("Could not read the ticket.", "error");
	const fm = frontMatter(freshSrcText).values;
	let childMd = ticketTemplate({
		key: childKey,
		title: childTitle,
		type: "Sub-task",
		parent: parentKey,
	});
	const releaseVal = srcDoc.release || one(fm.release);
	const ccVal = srcDoc.changeControl || one(fm["change-control"]);
	const gxpVal = srcDoc.gxpImpact || one(fm["gxp-impact"]);
	if (releaseVal) childMd = withFrontMatter(childMd, "release", releaseVal) ?? childMd;
	if (ccVal) childMd = withFrontMatter(childMd, "change-control", ccVal) ?? childMd;
	if (gxpVal) childMd = withFrontMatter(childMd, "gxp-impact", gxpVal) ?? childMd;
	for (const tag of many(fm.tags)) childMd = addToFrontMatterList(childMd, "tags", tag) ?? childMd;

	const movedChecklist = pickedItems.map((it) => `- [ ] ${it.text}`).join("\n");
	const donePlaceholder = /^## What done looks like\r?\n\r?\n- \[ \] What must be true when this is done:[^\r\n]*/m;
	if (donePlaceholder.test(childMd)) {
		childMd = childMd.replace(donePlaceholder, () => `## What done looks like\n\n${movedChecklist}`);
	} else {
		childMd = childMd.replace(/^## What done looks like\r?\n+/m, (m) => `${m}${movedChecklist}\n\n`);
	}
	childMd = `${childMd.trimEnd()}\n\nSplit from [[${parentKey}]].\n`;

	const childDest = joinPath(areaFolder("tickets"), `${childKey}.md`);
	try {
		await backend.create(childDest, "file");
		await backend.write(childDest, childMd);
		const freshUnchecked = extractUncheckedChecklistLines(freshSrcText);
		const removedSet = new Set<number>();
		for (const picked of pickedItems) {
			const exact = freshUnchecked.find((u) => !removedSet.has(u.line) && u.line === picked.line && u.text === picked.text);
			const fallback = exact ?? freshUnchecked.find((u) => !removedSet.has(u.line) && u.text === picked.text);
			if (fallback) removedSet.add(fallback.line);
		}
		const nextParent = splitParentTicketChecklist(freshSrcText, removedSet, childKey, childTitle);
		await put(srcDoc.path, nextParent, true);
		setState("treeVersion", (v) => v + 1);
		notify(`Split ${pickedItems.length} ${pickedItems.length === 1 ? "item" : "items"} from ${parentKey} into ${childKey}.`);
		await openFile(childDest);
	} catch (e: any) {
		notify(`Could not split sub-ticket: ${e?.message ?? e}`, "error");
	}
}

/**
 * Appends a `found` row to `docs/registries/database.csv` for an undocumented SQL / `.ds` table
 * citing `relativeTo(root, sourcePath)`, creating `database.csv` with standard columns if missing.
 */
export async function addDatabaseRegistryRow(objectName: string, sourcePath: string, line?: number): Promise<void> {
	if (!ready()) return;
	const cleanObj = objectName.trim();
	if (!cleanObj) return;
	const dbKind = REGISTRIES.find((r) => r.id === "database")!;
	const existingDoc = docs().find((d) => d.exists && d.group === "registries" && /(^|[\\/])database\.csv$/i.test(d.name));
	const dbPath = existingDoc?.path ?? joinPath(areaFolder("registries"), dbKind.file);
	const relSrc = relativeTo(root(), sourcePath).split("\\").join("/");
	const citeNote = line ? `Referenced in ${relSrc}:${line}` : `Referenced in ${relSrc}`;

	const existingText = await current(dbPath);
	if (existingText === null) {
		const fresh = `${csvRow(dbKind.columns)}\n${csvRow([cleanObj, "table", relSrc, "", "found", citeNote])}\n`;
		try {
			await put(dbPath, fresh, false);
			setState("treeVersion", (v) => v + 1);
			notify(`Created database.csv and added ${cleanObj}.`);
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
		return;
	}

	const table = parseCsv(existingText);
	if (!table.header.length) return notify("database.csv has no header row.", "error");
	const objLower = cleanObj.toLowerCase();
	const already = table.rows.some((r) => {
		const v = (r[0]?.text ?? "").trim().toLowerCase();
		const bare = v.includes(".") ? v.split(".").pop()! : v;
		return v === objLower || bare === objLower;
	});
	if (already) {
		notify(`${cleanObj} is already listed in database.csv.`);
		await openFile(dbPath);
		return;
	}

	const nl = existingText.includes("\r\n") ? "\r\n" : "\n";
	const newRow = table.header.map((h, idx) => {
		const col = h.text.trim().toLowerCase();
		if (idx === 0 || col === "object" || col === "name") return cleanObj;
		if (col === "kind" || col === "type") return "table";
		if (col === "used by" || col === "source") return relSrc;
		if (col === "status") return "found";
		if (col === "note" || col === "notes") return citeNote;
		return "";
	});
	const prefix = existingText && !/\r?\n$/.test(existingText) ? nl : "";
	const nextText = `${existingText}${prefix}${csvRow(newRow, table.delimiter)}${nl}`;
	try {
		await put(dbPath, nextText, true);
		setState("treeVersion", (v) => v + 1);
		notify(`Added ${cleanObj} to database.csv (${relSrc}).`);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}
