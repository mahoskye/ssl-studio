// The project's documents in one place: README.md and AGENTS.md first,
// whether or not they exist yet, then the Markdown in the docs folder and the
// plans. Which folders those are comes from .ssl-studio/project.toml.
import { Icon } from "../Icon";
import { FileMark } from "../FileMark";
import { createContext, createEffect, createMemo, createSignal, For, Show, useContext } from "solid-js";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { ask, choose } from "../dialogs";
import { docChecks } from "../../shared/docChecks";
import { addToFrontMatterList, withFrontMatter } from "../../shared/frontMatter";
import { CATALOG_AREAS, DOC_FOLDERS, docMatches, isCatalog, KNOWLEDGE, progress, progressShort, projectDocLabel, registryTitle, SCHEMAS, statusChoices, toneOf } from "../../shared/projectDocs";
import { normalizeTag, tagSearchPattern, workspaceTags } from "../../shared/tags";
import { descendantTickets, ticketWork } from "../../shared/workContext";
import { docs, docsError, docsLoading, newDoc, newDocIn, newFolderIn, setUpProject } from "../project";
import {
	archiveTicket,
	closeoutTicket,
	createTicketFolder,
	exportDeploymentManifest,
	exportTicketPacket,
	followRename,
	generateSchemaDocFromSql,
	importTickets,
	isArchivedTicket,
	newKnowledge,
	newRegistry,
	newSchema,
	newSpec,
	newState,
	newTicket,
	newTicketFile,
	promoteQuestionToDecision,
	renameTicket,
	setStatus,
	staleCatalogSummaryAsync,
	startFolderCatalogs,
	trashTicket,
	unarchiveTicket,
	updateCatalogs,
	updateManifest,
} from "../projectDocs";
import { searchFor } from "./Search";
import { manageTemplates, newNoteFromTemplate } from "../templater";
import { folderParts, folderSaid, IMPORT_TICKETS, kindOf, NEW_DOCUMENT, NEW_FOLDER, NEW_PLAN, NEW_REGISTRY, NEW_SPEC, NEW_TICKET, newOfKind, plainSection, schemaFolderOf, schemaOf, sectionFolder, sectionMenuEntries, SHOW_FOLDER, type DocSection } from "../../shared/docSections";
import { baseName, dirName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { schemaList, schemaRowTitle } from "../../shared/schemaList";
import { isArchivedTicket as isArchivedTicketPath, shownRows, workList, type WorkSort } from "../../shared/workList";
import { activePath, applyText, canonical, documents, fileRenamed, notify, openFile, openToSide, save, setState, state } from "../state";
import { gitStatus } from "../git";
import { changeLetter } from "../../shared/gitStatus";
import { recall, remember } from "../graph/canvas";
import { focusRowsBelow, IconButton, isFolded, Row, RowGroup, Rows, setFold, setFolds, type Point } from "./Rows";
import { chooseFromMenu, type RowMenuEntry } from "./RowMenu";
import { Menu } from "../Menu";

type BulkSelectState = {
	active: () => boolean;
	has: (path: string) => boolean;
	toggle: (path: string) => void;
};

const BulkSelectContext = createContext<BulkSelectState>({
	active: () => false,
	has: () => false,
	toggle: () => {},
});

const isBulkSelectable = (file: DocFile) => file.exists && !isCatalog(file) && /\.(md|markdown)$/i.test(file.name);

type ProjectDocsExtras = {
	exportReleaseBundle?: () => Promise<void>;
	exportRtm?: () => Promise<void>;
	importLegacyDoc?: () => Promise<void>;
	onboardBrownfieldWorkspace?: () => Promise<void>;
};

async function runProjectDocsAction(key: keyof ProjectDocsExtras, label: string) {
	try {
		const mod = (await import("../projectDocs")) as ProjectDocsExtras;
		const fn = mod[key];
		if (typeof fn === "function") await fn();
		else notify(`${label} is not available yet.`, "error");
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

async function editDocFrontMatter(path: string, transform: (text: string) => string | null): Promise<boolean> {
	const key = canonical(path);
	const open = documents.get(key);
	const cur = open ? open.model.getValue() : await backend.read(path).then((r) => (r.binary ? null : r.text), () => null);
	if (cur === null) return false;
	const next = transform(cur);
	if (next === null || next === cur) return false;
	if (open) {
		const clean = !state.dirty[key];
		applyText(key, next);
		if (clean) await save(key, { format: false });
	} else {
		await backend.historyKeep(path).catch(() => {});
		await backend.write(path, next);
	}
	return true;
}

function gitKindOf(path: string) {
	const st = gitStatus();
	if (!st) return null;
	const hit = st.files.find((f) => canonical(f.path) === canonical(path));
	return hit ? (hit.unstaged ?? hit.staged ?? null) : null;
}

function DocRow(props: { file: DocFile }) {
	const bulk = useContext(BulkSelectContext);
	const canSelect = () => bulk.active() && isBulkSelectable(props.file);
	// One click opens it for a look, in a tab the next file clicked takes; a double click keeps the tab.
	// In bulk select mode, clicking a selectable Markdown doc toggles its selection checkbox.
	const open = () => {
		if (canSelect()) {
			bulk.toggle(props.file.path);
			return;
		}
		if (props.file.exists) void openFile(props.file.path, { preview: true });
		else void setUpProject();
	};
	const selected = () => (canSelect() ? bulk.has(props.file.path) : props.file.exists && activePath() === canonical(props.file.path));
	const dirty = () => props.file.exists && Boolean(state.dirty[canonical(props.file.path)]);
	const git = () => (props.file.exists ? gitKindOf(props.file.path) : null);
	const projectInfo = () => projectDocLabel(props.file);
	const displayLabel = () => projectInfo()?.label || props.file.heading || props.file.title || props.file.name;
	return (
		<Row
			class="tree-row doc-row"
			key={props.file.path}
			selected={selected()}
			classList={{ selected: selected(), missing: !props.file.exists }}
			title={
				props.file.exists
					? projectInfo()
						? `${projectInfo()!.label} — ${props.file.name}\n${props.file.path}`
						: props.file.path
					: `${displayLabel()} (${props.file.name}) is missing. Click it, or press Enter on it, to create it.`
			}
			draggable={props.file.exists}
			onDragStart={(e) => {
				if (!props.file.exists) return;
				e.dataTransfer?.setData("application/x-ssl-studio-file", props.file.path);
				if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
			}}
			onActivate={open}
			onKeep={() => props.file.exists && void openFile(props.file.path, { keep: true })}
			onMenu={(at) => void rowMenu(props.file, at)}
			onKey={(e) => {
				if (!props.file.exists || (e.key !== "F2" && e.key !== "Delete")) return false;
				const own = Boolean(state.project && canonical(props.file.path) === canonical(state.project.path));
				if (own) return false;
				void (e.key === "F2" ? import("./Explorer").then((m) => m.renameFile(props.file.path)) : import("./Explorer").then((m) => m.trashFile(props.file.path)));
				return true;
			}}
		>
			<Show when={canSelect()}>
				<input
					type="checkbox"
					tabindex={-1}
					checked={bulk.has(props.file.path)}
					aria-label={`Select ${displayLabel()}`}
					style={{ margin: "0 4px 0 0", flex: "none", "accent-color": "var(--accent)", cursor: "pointer" }}
					onClick={(e) => e.stopPropagation()}
					onChange={() => bulk.toggle(props.file.path)}
				/>
			</Show>
			<FileMark name={props.file.name} />
			<span class="label">{displayLabel()}</span>
			<Show when={projectInfo()?.fileMeta}>
				{(fileMeta) => <span class="meta project-file-meta">{fileMeta()}</span>}
			</Show>
			<Show when={!props.file.exists}>
				<span class="meta warn">missing</span>
			</Show>
			<Show when={props.file.untouched}>
				<span class="meta warn" title="Still the template text: not written yet.">
					template
				</span>
			</Show>
			{/* The tests' and the code's catalogs are listed here, with the project's own files. */}
			<Show when={props.file.catalog?.stale}>
				<span class="meta warn" title="The list in this catalog no longer says what the folder holds. “Update catalogs” writes it afresh.">
					out of date
				</span>
			</Show>
			<Show when={props.file.broken?.length}>
				<span class="meta warn" title={`${props.file.broken!.length} broken ${props.file.broken!.length === 1 ? "link" : "links"}`}>
					{props.file.broken!.length === 1 ? "1 broken" : `${props.file.broken!.length} broken`}
				</span>
			</Show>
			<Show when={dirty()}>
				<span class="tree-dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" />
			</Show>
			<Show when={git()}>
				{(kind) => (
					<span class={`tree-git-badge git-letter ${kind()}`} title={`Git: ${kind()}`} aria-label={`Git: ${kind()}`}>
						{changeLetter(kind())}
					</span>
				)}
			</Show>
		</Row>
	);
}

/** A status as a small word beside a row, in the tone of what it comes to: done, under way, waiting, set aside. */
function Status(props: { status?: string }) {
	return (
		<Show when={props.status}>
			<span class={`meta doc-status tone-${toneOf(props.status)}`}>{props.status}</span>
		</Show>
	);
}

const OPEN = "Open";
const SIDE = "Open to the side";
const STATE = "Set to ";
const CREATE = "Create it";
const PATH = "Copy path";
const RELATIVE = "Copy path in the project";
const NAME = "Copy name";
const SHOW = "Show in the Explorer";
const SHOW_TICKET_FOLDER = "Browse ticket files in Explorer";
const CREATE_TICKET_FOLDER = "Create ticket folder…";
const NEW_TICKET_FILE = "New file in ticket folder…";
const NEW_SUBTICKET = "New sub-ticket…";
const ARCHIVE_TICKET = "Archive ticket…";
const ARCHIVE_ALL_DONE = "Archive all done tickets…";
const ARCHIVE_RETIRE = "Archive / Retire…";
const RENAME = "Rename…";
const TRASH = "Move to trash…";

/** Moves a spec or decision into a local `archive/` subfolder after ADR 0009 confirmation, following links. */
async function archiveSpecOrDecision(file: DocFile): Promise<void> {
	const root = state.workspace?.root;
	if (!root) return;
	const archiveDir = joinPath(dirName(file.path), "archive");
	const dest = joinPath(archiveDir, baseName(file.path));
	const relArchive = relativeTo(root, archiveDir).split("\\").join("/");
	const existing = await backend.list(archiveDir).catch(() => []);
	if (existing.some((e) => e.name.toLowerCase() === baseName(dest).toLowerCase())) {
		notify(`Cannot archive: ${baseName(dest)} already exists in ${relArchive}/.`, "error");
		return;
	}
	const isDecision = file.group === "knowledge" && file.kind === "decisions";
	const targetStatus = isDecision ? "superseded" : "retired";
	const needsStatus = toneOf(file.status) !== "off";
	const ARCHIVE_MARK = `Archive & mark ${targetStatus}`;
	const ARCHIVE_KEEP = "Archive (keep status)";
	const picked = await choose(
		`Move ${file.title || baseName(file.path)} into ${relArchive}/?`,
		needsStatus ? [ARCHIVE_MARK, ARCHIVE_KEEP] : ["Archive"],
	);
	if (!picked) return;
	const key = canonical(file.path);
	if (state.dirty[key] && !(await save(key))) {
		notify("Save unsaved edits before archiving this document.", "error");
		return;
	}
	const beforeDocs = await backend.docs().catch(() => docs().slice());
	try {
		if (picked === ARCHIVE_MARK) await setStatus(file.path, targetStatus);
		await backend.rename(file.path, dest);
		fileRenamed(file.path, dest);
		setState("treeVersion", (v) => v + 1);
		await followRename(file.path, dest, beforeDocs);
		notify(`Archived ${file.title || baseName(file.path)} to ${relArchive}/.`);
	} catch (e: any) {
		setState("treeVersion", (v) => v + 1);
		notify(String(e?.message ?? e), "error");
	}
}

/** Batch-archives all non-archived tickets whose status is done into `<tickets>/archive/` after ADR 0009 confirmation. */
async function archiveAllDoneTickets(): Promise<void> {
	const root = state.workspace?.root;
	const project = state.project;
	if (!root || !project) return;
	const doneTickets = docs().filter(
		(d) => d.exists && d.group === "tickets" && !isCatalog(d) && !isArchivedTicket(d) && !isArchivedTicketPath(d) && toneOf(d.status) === "done",
	);
	if (!doneTickets.length) return notify("No done tickets to archive.");
	const docsParts = folderParts(project.docs ?? "docs");
	const ticketsRoot = joinPath(root, ...docsParts, DOC_FOLDERS.tickets);
	const archiveDir = joinPath(ticketsRoot, "archive");
	const relArchive = relativeTo(root, archiveDir).split("\\").join("/");
	const preview = doneTickets.slice(0, 4).map((t) => t.ticket || baseName(t.path)).join(", ") + (doneTickets.length > 4 ? ` and ${doneTickets.length - 4} more` : "");
	const GO = `Archive ${doneTickets.length} done ${doneTickets.length === 1 ? "ticket" : "tickets"}`;
	if ((await choose(`Move ${doneTickets.length} done ${doneTickets.length === 1 ? "ticket" : "tickets"} (${preview}) into ${relArchive}/?`, [GO])) !== GO) {
		return;
	}
	const { retargetScopedFolder } = await import("./Explorer");
	let archived = 0;
	const skipped: string[] = [];
	for (const file of doneTickets) {
		const isLayout1 = Boolean(file.ticketFolder && isInside(file.ticketFolder, file.path));
		const isLayout2 = Boolean(file.ticketFolder && !isLayout1);
		const fromPrimary = isLayout1 ? file.ticketFolder! : file.path;
		const toPrimary = joinPath(archiveDir, baseName(fromPrimary));
		const fromSibling = isLayout2 ? file.ticketFolder! : null;
		const toSibling = fromSibling ? joinPath(archiveDir, baseName(fromSibling)) : null;

		const archiveEntries = await backend.list(archiveDir).catch(() => []);
		const existingNames = new Set(archiveEntries.map((e) => e.name.toLowerCase()));
		if (existingNames.has(baseName(toPrimary).toLowerCase()) || (toSibling && existingNames.has(baseName(toSibling).toLowerCase()))) {
			skipped.push(file.ticket || baseName(fromPrimary));
			continue;
		}
		// Save any unsaved buffers inside the ticket/folder first.
		const dirtyTargets = Object.keys(state.dirty).filter(
			(p) =>
				state.dirty[p] &&
				(p === canonical(fromPrimary) ||
					isInside(fromPrimary, p) ||
					Boolean(fromSibling && (p === canonical(fromSibling) || isInside(fromSibling, p)))),
		);
		let allSaved = true;
		for (const p of dirtyTargets) {
			if (!(await save(p))) {
				allSaved = false;
				break;
			}
		}
		if (!allSaved) {
			skipped.push(file.ticket || baseName(fromPrimary));
			continue;
		}
		const beforeDocs = await backend.docs().catch(() => docs().slice());
		try {
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
			const coMoved = fromSibling && toSibling ? [{ from: fromSibling, to: toSibling }] : undefined;
			await followRename(fromPrimary, toPrimary, beforeDocs, coMoved);
			archived++;
		} catch {
			skipped.push(file.ticket || baseName(fromPrimary));
		}
	}
	setState("treeVersion", (v) => v + 1);
	if (archived) {
		notify(`Archived ${archived} done ${archived === 1 ? "ticket" : "tickets"} to ${relArchive}/${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}.`);
	} else if (skipped.length) {
		notify(`Could not archive: ${skipped.join(", ")} (already in archive/ or unsaved).`, "error");
	}
}
/**
 * What can be done to a document from its row, without opening it. First what
 * is the document's own: a ticket, a spec, a decision or a question is set to
 * a state (written into the lines it opens with); a catalog is written
 * afresh; the file manifest is updated. Then what any file has: its path and
 * name, its place in the Explorer, a new name, the trash. Right-click, the
 * menu key or Shift+F10 (ADR 0010).
 */
async function rowMenu(file: DocFile, at: Point) {
	const catalog = isCatalog(file);
	const manifest = file.group === "registries" && /(^|[\\/])files\.csv$/i.test(file.name);
	// A state is a Markdown document's front matter: a query or a table kept in the knowledge base has none.
	const markdown = /\.(md|markdown)$/i.test(file.name);
	// A message exchanged with another system is a contract with it, and has a state too: draft, agreed, retired.
	const contract = file.group === "schema" && file.kind === "interfaces" && !/(^|[\\/])readme\.(md|markdown)$/i.test(file.name);
	const hasStatus =
		markdown &&
		!catalog &&
		(contract ||
			(["tickets", "specs", "knowledge"].includes(file.group) &&
				(file.status || file.group !== "knowledge" || file.kind === "decisions" || file.kind === "questions")));
	const allStates = hasStatus ? statusChoices(file) : [];
	const UPDATE = catalog ? "Update catalogs" : "Update file manifest";
	// A file that is not there yet has one thing that can be done to it.
	// The project's own settings file is what makes the folder a project: it is not renamed or thrown away from its
	// row here, where nothing would read the project again after it.
	const own = Boolean(state.project && canonical(file.path) === canonical(state.project.path));
	const isTicket = file.group === "tickets" && !catalog;
	const isArchivableDoc =
		!catalog &&
		(file.group === "specs" || (file.group === "knowledge" && file.kind === "decisions")) &&
		!/[\\/]archive[\\/]/i.test(file.path);
	const isAnsweredQuestion = file.group === "knowledge" && file.kind === "questions" && !catalog && toneOf(file.status) === "done";
	const isSchemaItem = file.group === "schema" && !catalog;
	const isSchemaSql = isSchemaItem && /\.(sql|ddl|pks|pkb)$/i.test(file.name);
	const EXPORT_PACKET = "Export release packet (HTML)…";
	const EXPORT_MANIFEST = "Export deployment manifest (Markdown)…";
	const CLOSEOUT_TICKET = "Close out ticket…";
	const UNARCHIVE_TICKET = "Unarchive ticket…";
	const PROMOTE_DECISION = "Promote answer to decision…";
	const DOC_FROM_SQL = "Generate table doc from SQL…";
	const FIND_IN_CODE = "Find usages in code";
	const isFocusedTicket = Boolean(file.ticket && state.settings.activeTicket?.toLowerCase() === file.ticket.toLowerCase());
	const SET_ACTIVE_TICKET = isFocusedTicket ? `Clear active ticket (${file.ticket})` : `Set ${file.ticket} as active ticket`;
	const archived = isTicket && (isArchivedTicket(file) || isArchivedTicketPath(file));

	const statusSubmenu: RowMenuEntry[] = allStates.length
		? [
				{
					label: "Set status",
					children: allStates.map((status) => {
						const current = status.toLowerCase() === (file.status ?? "").toLowerCase();
						return {
							label: status,
							value: `${STATE}${status}`,
							checked: current,
							disabled: current,
						};
					}),
				},
			]
		: [];

	const workflowSection: RowMenuEntry[] = [
		...statusSubmenu,
		...(catalog || manifest ? [UPDATE] : []),
		...(isTicket && file.ticket ? [NEW_SUBTICKET, CLOSEOUT_TICKET] : []),
		...(isTicket
			? file.ticketFolder
				? [{ label: "Ticket folder", children: [NEW_TICKET_FILE, SHOW_TICKET_FOLDER] }]
				: [CREATE_TICKET_FOLDER]
			: []),
		...(isAnsweredQuestion ? [PROMOTE_DECISION] : []),
		...(isSchemaSql ? [DOC_FROM_SQL] : []),
		...(isSchemaItem ? [FIND_IN_CODE] : []),
	];

	const exportSection: RowMenuEntry[] =
		isTicket && file.ticket
			? [
					{
						label: "Export",
						children: [
							{ label: "Release packet (HTML)…", value: EXPORT_PACKET },
							{ label: "Deployment manifest (Markdown)…", value: EXPORT_MANIFEST },
						],
					},
				]
			: [];

	const lifecycleSection: RowMenuEntry[] = [
		...(isTicket ? [archived ? UNARCHIVE_TICKET : ARCHIVE_TICKET] : []),
		...(isArchivableDoc ? [ARCHIVE_RETIRE] : []),
		...(own ? [] : [{ label: RENAME, value: RENAME, keys: "F2" }]),
	];

	const items: RowMenuEntry[] = file.exists
		? [
				OPEN,
				SIDE,
				...(isTicket && file.ticket ? [SET_ACTIVE_TICKET] : []),
				"separator",
				...workflowSection,
				"separator",
				...exportSection,
				"separator",
				{ label: "Copy path", children: [PATH, RELATIVE, NAME] },
				SHOW,
				"separator",
				...lifecycleSection,
				...(own ? [] : (["separator", { label: TRASH, value: TRASH, keys: "Delete", danger: true }] as RowMenuEntry[])),
			]
		: [CREATE];
	const picked = await chooseFromMenu(`Actions for ${file.ticket ?? file.title ?? file.name}`, items, at);
	if (!picked) return;
	if (picked === OPEN) await openFile(file.path, { keep: true });
	else if (picked === SIDE) await openToSide(file.path);
	else if (picked === CREATE) await setUpProject();
	else if (picked === SET_ACTIVE_TICKET && file.ticket) {
		const { setActiveTicket } = await import("../projectDocs");
		await setActiveTicket(isFocusedTicket ? null : file.ticket);
	}
	else if (picked === NEW_SUBTICKET && file.ticket) await newTicket(undefined, undefined, { parent: file.ticket });
	else if (picked === EXPORT_MANIFEST && file.ticket) await exportDeploymentManifest(file.path, file.ticket, "markdown");
	else if (picked === EXPORT_PACKET && file.ticket) await exportTicketPacket(file.path, file.ticket, "html");
	else if (picked === CLOSEOUT_TICKET && file.ticket) await closeoutTicket(file.path, file.ticket);
	else if (picked === ARCHIVE_RETIRE) await archiveSpecOrDecision(file);
	else if (picked === PROMOTE_DECISION) await promoteQuestionToDecision(file.path);
	else if (picked === DOC_FROM_SQL) await generateSchemaDocFromSql(file.path);
	else if (picked === FIND_IN_CODE) {
		const rawStem = (file.name.split(/[\\/]/).pop() || file.title || "").replace(/\.[^.]+$/, "").trim();
		const cleanDir = (dir?: string) => (dir ?? "").replace(/^[./\\]+|[\\/]+$/g, "").replace(/\\/g, "/");
		const dRel = cleanDir(state.project?.docs ?? "docs");
		const pRel = cleanDir(state.project?.plans ?? "design");
		const sRel = cleanDir(state.project?.schema ?? "schema");
		const exc = [dRel ? `${dRel}/**` : "", pRel ? `${pRel}/**` : "", sRel ? `${sRel}/**` : "", "README.md", "AGENTS.md", "**/INDEX.md"]
			.filter(Boolean)
			.join(", ");
		if (rawStem) searchFor(rawStem, { wholeWord: true, include: "", exclude: exc });
	}
	else if (picked === ARCHIVE_TICKET) await archiveTicket(file);
	else if (picked === UNARCHIVE_TICKET) await unarchiveTicket(file);
	else if (picked === CREATE_TICKET_FOLDER) await createTicketFolder(file.path);
	else if (picked === NEW_TICKET_FILE && file.ticketFolder) await newTicketFile(file.ticketFolder, file.ticket ?? file.name);
	else if (picked === SHOW_TICKET_FOLDER && file.ticketFolder) (await import("./Explorer")).browseFolderInExplorer(file.ticketFolder, `${file.ticket ?? file.name} files`);
	else if (picked === UPDATE) await (catalog ? updateCatalogs() : updateManifest());
	else if (picked.startsWith(STATE)) await setStatus(file.path, picked.slice(STATE.length));
	else if (picked === PATH || picked === RELATIVE || picked === NAME) await (await import("../commands")).copyPath(picked === PATH ? "whole" : picked === NAME ? "name" : "relative", file.path);
	// The tree's own steps, asking and all: loaded when asked for, since the Explorer is another panel.
	else if (picked === SHOW) (await import("./Explorer")).showInExplorer(file.path);
	else if (picked === RENAME) await (isTicket ? renameTicket(file) : (await import("./Explorer")).renameFile(file.path));
	else if (picked === TRASH) await (isTicket ? trashTicket(file) : (await import("./Explorer")).trashFile(file.path));
}

/** A row for one of the working documents: its title where it has one, and its state. */
function ItemRow(props: {
	file: DocFile;
	depth?: number;
	lead?: string;
	note?: string;
	aside?: boolean;
	short?: string;
	linkDetail?: string;
	archived?: boolean;
	/**
	 * In a list where rows have rows under them: whether this one has, and whether they are shut away. Leaves a
	 * twisty's room either way. `locked` says why it cannot be shut now (a filter is showing everything it found).
	 */
	fold?: { parent: boolean; shut: boolean; locked?: string; toggle: () => void };
}) {
	const bulk = useContext(BulkSelectContext);
	const canSelect = () => bulk.active() && isBulkSelectable(props.file);
	const selected = () => (canSelect() ? bulk.has(props.file.path) : activePath() === canonical(props.file.path));
	const stale = () => props.file.catalog?.stale;
	const isFocusedTicket = () =>
		Boolean(
			props.file.group === "tickets" &&
				props.file.ticket &&
				state.settings.activeTicket &&
				state.settings.activeTicket.toLowerCase() === props.file.ticket.toLowerCase(),
		);
	return (
		<Row
			class="tree-row doc-row"
			key={props.file.path}
			selected={selected()}
			classList={{ selected: selected(), catalog: isCatalog(props.file), "active-ticket": isFocusedTicket(), "archived-row": Boolean(props.archived) }}
			style={{ "padding-left": `${8 + (props.depth ?? 0) * 14}px` }}
			// Where it is, its state, what it is for, how it is linked, and what is wrong with it: nothing the reader has to keep up by hand.
			title={[
				props.file.path,
				isFocusedTicket() ? "Active focused ticket" : "",
				props.archived ? "Archived ticket" : "",
				props.file.status ? `Status: ${props.file.status}` : "",
				props.file.release ? `Release: ${props.file.release}` : "",
				props.file.ticketFolder
					? (() => {
							const n = props.file.ticketFileCount ?? props.file.ticketFiles?.length ?? 0;
							return `Ticket folder: ${n} ${n === 1 ? "file" : "files"}`;
						})()
					: "",
				props.file.tickets?.length ? `${props.file.group === "tickets" ? "Related to" : "For"} ${props.file.tickets.join(", ")}` : "",
				props.linkDetail ? `Linked via: ${props.linkDetail}` : "",
				...(props.file.problems ?? []),
			]
				.filter(Boolean)
				.join("\n")}
			expanded={props.fold?.parent ? !props.fold.shut : undefined}
			onToggle={() => props.fold?.parent && !props.fold.locked && props.fold.toggle()}
			onActivate={() => (canSelect() ? bulk.toggle(props.file.path) : void openFile(props.file.path, { preview: true }))}
			onKeep={() => void openFile(props.file.path, { keep: true })}
			onMenu={(at) => void rowMenu(props.file, at)}
			draggable={props.file.exists}
			onDragStart={(e) => {
				if (!props.file.exists) return;
				e.dataTransfer?.setData("application/x-ssl-studio-file", props.file.path);
				if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
			}}
			onKey={(e) => {
				if (e.key !== "F2" && e.key !== "Delete") return false;
				const isTicket = props.file.group === "tickets" && !isCatalog(props.file);
				void (e.key === "F2"
					? isTicket ? renameTicket(props.file) : import("./Explorer").then((m) => m.renameFile(props.file.path))
					: isTicket ? trashTicket(props.file) : import("./Explorer").then((m) => m.trashFile(props.file.path)));
				return true;
			}}
		>
			<Show when={props.fold}>
				{(fold) => (
					<span
						class="twisty"
						aria-hidden="true"
						title={fold().parent ? (fold().locked ?? (fold().shut ? "Show what is under it" : "Hide what is under it")) : undefined}
						// The twisty shuts and opens; the rest of the row opens the document.
						onClick={(e) => fold().parent && (e.stopPropagation(), !fold().locked && fold().toggle())}
						// On a row with nothing under it the twisty's room is the row's: a double click there keeps the tab.
						onDblClick={(e) => fold().parent && e.stopPropagation()}
					>
						<Show when={fold().parent}>
							<Icon name={fold().shut ? "chevron-right" : "chevron-down"} />
						</Show>
					</span>
				)}
			</Show>
			<Show when={canSelect()}>
				<input
					type="checkbox"
					tabindex={-1}
					checked={bulk.has(props.file.path)}
					aria-label={`Select ${props.file.ticket ?? props.file.title ?? props.file.name}`}
					style={{ margin: "0 4px 0 0", flex: "none", "accent-color": "var(--accent)", cursor: "pointer" }}
					onClick={(e) => e.stopPropagation()}
					onChange={() => bulk.toggle(props.file.path)}
				/>
			</Show>
			<FileMark name={props.file.name} />
			{/* Open or shut, in words, for what reads the screen aloud: a list's row has no state for it. */}
			<Show when={props.fold?.parent}>
				<span class="visually-hidden">{props.fold!.locked ? `${props.fold!.locked}.` : props.fold!.shut ? "Shut: what is under it is hidden." : "Open."} </span>
			</Show>
			<span class="label">
				<Show when={isFocusedTicket()}>
					<span class="doc-active-pin" title="Active focused ticket" aria-label="Active focused ticket">
						<Icon name="pinned" />
					</span>
				</Show>
				<Show when={props.lead}>
					<strong class="doc-key">{props.lead}</strong>{" "}
				</Show>
				{isCatalog(props.file) ? "Catalog" : props.file.title || props.file.name}
			</span>
			<Show when={props.file.group === "tickets" && !isCatalog(props.file) && props.file.release}>
				<span
					class="meta doc-release-pill"
					title={`Release: ${props.file.release}`}
					style={{
						padding: "0 5px",
						"border-radius": "999px",
						border: "1px solid color-mix(in srgb, var(--border) 90%, transparent)",
						"font-size": "var(--text-xs)",
						"line-height": "1.35",
						"white-space": "nowrap",
					}}
				>
					{props.file.release}
				</span>
			</Show>
			<Show when={props.archived}>
				<span class="meta doc-archived-badge" title="Archived ticket">
					archived
				</span>
			</Show>
			<Show when={props.note}>
				{/* In a narrow panel a note that has a shorter way of saying itself says it that way, and the title keeps the room. */}
				<span class="meta" classList={{ aside: props.aside, shortens: Boolean(props.short) }} title={props.short ? props.note : undefined}>
					<span class="long">{props.note}</span>
					<Show when={props.short}>
						<span class="short" aria-hidden="true">
							{props.short}
						</span>
					</Show>
				</span>
			</Show>
			{/* How far through its list a ticket or a spec is: what done looks like, ticked. */}
			<Show when={props.file.tasks}>
				<span class="meta doc-tasks" title={`${props.file.tasks!.done} of ${props.file.tasks!.total} items ticked`}>
					{props.file.tasks!.done}/{props.file.tasks!.total}
				</span>
			</Show>
			<Show when={props.file.ticketFolder}>
				<span
					class="meta doc-folder-badge"
					title={`Ticket folder: ${props.file.ticketFileCount ?? props.file.ticketFiles?.length ?? 0} extra files. Right-click -> Browse ticket files in Explorer.`}
				>
					<Icon name="folder" />
					<span>{props.file.ticketFileCount ?? props.file.ticketFiles?.length ?? 0}</span>
				</span>
			</Show>
			<Show when={stale()}>
				<span class="meta warn" title="The list in this catalog no longer says what the folder holds. “Update catalogs” writes it afresh.">
					out of date
				</span>
			</Show>
			<Show when={props.file.untouched}>
				<span class="meta warn" title="Still the text it started with: not written yet.">
					template
				</span>
			</Show>
			<Show when={(props.file.broken?.length ?? 0) + (props.file.missing?.length ?? 0) > 0}>
				<span
					class="meta warn"
					title={[
						...(props.file.missing ?? []).map((m) => `Missing: ${m}`),
						...(props.file.broken ?? []).map((b) => `Broken link: ${b.href}`),
					].join("\n")}
				>
					{(props.file.broken?.length ?? 0) + (props.file.missing?.length ?? 0)} broken
				</span>
			</Show>
			<Show when={props.file.problems?.length}>
				<span class="meta warn" title={props.file.problems!.join("\n")}>
					{props.file.problems!.length === 1 ? "1 problem" : `${props.file.problems!.length} problems`}
				</span>
			</Show>
			<Show when={Boolean(state.dirty[canonical(props.file.path)])}>
				<span class="tree-dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" />
			</Show>
			<Show when={gitKindOf(props.file.path)}>
				{(kind) => (
					<span class={`tree-git-badge git-letter ${kind()}`} title={`Git: ${kind()}`} aria-label={`Git: ${kind()}`}>
						{changeLetter(kind())}
					</span>
				)}
			</Show>
			<Status status={props.file.status} />
		</Row>
	);
}

/** Why nothing folds while a filter is on: what it found is shown, shut or not. */
const LOCKED = "Shown open while the filter is narrowing the list";
/** A row with nothing under it, in a list where others have: it leaves a twisty's room and has none. */
const NO_FOLD = { parent: false, shut: false, toggle: () => {} };
/** The name what lies at the top of the schema folder folds under: one no folder there can have, whatever it is called. */
const SCHEMA_TOP = "docs:schema:/";
/** The name a ticket folds under: what is under it (its plans, its specs, the tickets that are part of it) is shut away with it. */
const ticketFold = (file: DocFile) => `docs:ticket:${file.path}`;
/** Every name the panel folds under: its groups, the kinds of the knowledge base, and each ticket. */
const allFolds = () => [
	...(["project", "work", "knowledge", "registries", "docs", "schema", "plans", "tags"] as const).map((group) => `docs:${group}`),
	...KNOWLEDGE.map((kind) => `docs:knowledge:${kind.id}`),
	SCHEMA_TOP,
	// The kinds of schema (those the app knows, and the folders the project has made beside them), and the folders
	// inside each.
	...SCHEMAS.map((kind) => `docs:schema:${kind.id}`),
	...schemaList(docs()).kinds.flatMap((kind) => [`docs:schema:${kind.id}`, ...kind.parts.map((part) => `docs:schema:${kind.id}/${part.name}`)]),
	"docs:knowledge:other",
	...docs()
		.filter((file) => file.group === "tickets")
		.map(ticketFold),
];

/**
 * What can be done from the heading of a list, to the list rather than to one
 * of its documents: a new document of the kind it keeps, a new folder in its
 * folder, and the folder's place in the Explorer. Right-click, the menu key or
 * Shift+F10 on the heading (ADR 0010).
 */
async function headMenu(section: DocSection, title: string, at: Point) {
	const project = state.project;
	const root = state.workspace?.root;
	if (!project || !root) return;
	const folder = sectionFolder(section, project);
	const hasDoneTickets =
		section === "work" &&
		docs().some(
			(d) => d.exists && d.group === "tickets" && !isCatalog(d) && !isArchivedTicket(d) && !isArchivedTicketPath(d) && toneOf(d.status) === "done",
		);
	const entries = sectionMenuEntries(section, { archiveAllDone: hasDoneTickets ? ARCHIVE_ALL_DONE : undefined });
	const picked = await chooseFromMenu(`Actions for ${title}, in ${folderSaid(folder)}`, entries, at);
	if (!picked) return;
	if (picked === ARCHIVE_ALL_DONE) return void archiveAllDoneTickets();
	const kind = kindOf(section) ?? KNOWLEDGE.find((known) => picked === newOfKind(known));
	// From the schema's own heading, the kind is the one whose entry was picked; from a kind's heading, that kind.
	const schema = schemaOf(section) ?? (section === "schema" ? SCHEMAS.find((known) => picked === newOfKind(known)) : undefined);
	// A folder made under a kind the app knows is for that kind: its first document is a table, a message or a
	// layout from its template, in the new folder. Elsewhere it is a plain document, where the list holds those.
	const known = schemaOf(section);
	const schemaRoot = sectionFolder("schema", project);
	if (picked === NEW_FOLDER) await newFolderIn(folder, known ? (inFolder) => newSchema(known.id, inFolder.slice(schemaRoot ? schemaRoot.length + 1 : 0)) : plainSection(section));
	else if (picked === SHOW_FOLDER) {
		const path = joinPath(root, ...folderParts(folder));
		// A list is shown for a folder that is not there yet: its first document or folder makes it.
		const there = await backend.list(path).then(
			() => true,
			() => false,
		);
		if (there) (await import("./Explorer")).showInExplorer(path);
		else notify(`${folderSaid(folder)} is not there yet: the first document or folder made here makes it.`);
	} else if (picked === NEW_DOCUMENT) await newDocIn(folder);
	else if (picked === NEW_TICKET) await newTicket();
	else if (picked === IMPORT_TICKETS) await importTickets();
	else if (picked === NEW_SPEC) await newSpec();
	else if (picked === NEW_REGISTRY) await newRegistry();
	else if (picked === NEW_PLAN) (await import("../commands")).runCommand("new-plan");
	else if (schema) await newSchema(schema.id, schemaFolderOf(section));
	else if (kind) await newKnowledge(kind.id);
}

/**
 * The folder a list is, as its heading and its menu say it: with no "." in it, and nothing for the project's own
 * folder, which a docs folder set to "." is.
 */
const folderOf = (section: DocSection) => (state.project ? sectionFolder(section, state.project) : undefined);

/** A group's heading, with the folder it is in. */
const Head = (props: { title: string; folder?: string }) => (
	<>
		{props.title}{" "}
		<Show when={props.folder}>
			<span class="folder">{props.folder}/</span>
		</Show>
	</>
);

/**
 * The work: each ticket with what was planned and spec'd for it under it, a ticket that is part of another under its
 * parent, what is under way first. Finished tickets beyond a few fold away behind a count. Specs for no ticket here follow.
 * Archived tickets (`tickets/archive/...`) stay collapsed in their own subgroup until opened or matched by search.
 */
function Work(props: { files: DocFile[]; empty?: string; filtered?: boolean }) {
	const [all, setAll] = createSignal(false);
	const savedSort = recall("docs.workSort");
	const [sort, setSort] = createSignal<WorkSort>(savedSort === "key" || savedSort === "title" ? savedSort : "status");
	const chooseSort = (next: WorkSort) => {
		setSort(next);
		remember("docs.workSort", next);
	};
	const [archiveOpen, setArchiveOpen] = createSignal(false);
	// What a filter found is shown, finished or not.
	const list = createMemo(() => workList(props.files, state.workspace?.root, { all: all() || props.filtered, sort: sort() }));
	/** How many finished tickets fold away, whether or not they are shown now. */
	const everything = createMemo(() => (props.filtered || sort() !== "status" ? 0 : workList(props.files, state.workspace?.root, { sort: sort() }).folded));
	const catalogs = () => props.files.filter((d) => (d.group === "tickets" || d.group === "specs") && isCatalog(d));
	/** The rows with what is under a shut ticket left out. What a filter found is shown, shut or not. */
	const rows = createMemo(() => shownRows(list().rows, (row) => !props.filtered && isFolded(ticketFold(row.file))));
	const archivedRows = createMemo(() => shownRows(list().archived, (row) => !props.filtered && isFolded(ticketFold(row.file))));
	const archivedTicketCount = createMemo(() => list().archived.filter((r) => r.kind === "ticket").length);
	const archiveExpanded = () => Boolean(props.filtered) || archiveOpen();
	const activeTicketCount = createMemo(() => list().rows.filter((r) => r.kind === "ticket").length);
	const fold = (row: ReturnType<typeof rows>[number]) => ({ parent: row.parent, shut: row.shut, locked: props.filtered ? LOCKED : undefined, toggle: () => setFold(ticketFold(row.file), !row.shut) });
	const renderWorkRow = (row: ReturnType<typeof rows>[number], isArchived = false) =>
		row.kind === "ticket" ? (
			<ItemRow file={row.file} depth={row.depth + (isArchived ? 1 : 0)} lead={row.file.ticket} linkDetail={row.link?.detail} archived={isArchived} fold={fold(row)} />
		) : row.kind === "plan" ? (
			<ItemRow file={{ ...row.file, title: row.file.name.replace(/\.plan\.json$/i, "") }} depth={row.depth + (isArchived ? 1 : 0)} note="plan" linkDetail={row.link?.detail} archived={isArchived} fold={fold(row)} />
		) : (
			<ItemRow file={row.file} depth={row.depth + (isArchived ? 1 : 0)} note="spec" linkDetail={row.link?.detail} archived={isArchived} fold={fold(row)} />
		);
	return (
		<RowGroup fold="docs:work" label="Work" onMenu={(at) => void headMenu("work", "Work", at)} open={props.filtered} count={props.files.filter((d) => (d.group === "tickets" || d.group === "specs") && !isCatalog(d)).length} head={<Head title="Work" folder={folderOf("work")} />} rows={props.files.some((d) => d.group === "tickets" || d.group === "specs")} empty={<Show when={props.empty}><p class="hint">{props.empty}</p></Show>}>
			<Show when={activeTicketCount() > 1}>
				<div class="docs-work-sort" role="group" aria-label="Sort tickets">
					<span class="docs-sort-label">Sort</span>
					<button type="button" classList={{ on: sort() === "status" }} onClick={() => chooseSort("status")}>
						Status
					</button>
					<button type="button" classList={{ on: sort() === "key" }} onClick={() => chooseSort("key")}>
						Key
					</button>
					<button type="button" classList={{ on: sort() === "title" }} onClick={() => chooseSort("title")}>
						Title
					</button>
				</div>
			</Show>
			<For each={rows()}>{(row) => renderWorkRow(row, false)}</For>
			{/* What is done or set aside is not what the list is opened for: beyond a few, it waits behind its count. */}
			<Show when={everything()}>
				<Row class="tree-row doc-row doc-more" key="finished-tickets" title={all() ? "Leave out the tickets that are done or set aside" : "Show the tickets that are done or set aside"} onActivate={() => setAll(!all())}>
					<span class="label">{all() ? "Hide" : "Show"} the {everything()} finished</span>
				</Row>
			</Show>
			{/* The same room for a twisty as the rows above, so that the marks line up down the list. */}
			<For each={list().loose}>{(spec) => <ItemRow file={spec} note={spec.tickets?.length ? `for ${spec.tickets.join(", ")}` : "spec, no ticket"} fold={NO_FOLD} />}</For>
			<Show when={archivedTicketCount() > 0}>
				<Row
					class="group-head doc-kind foldable docs-archive-head"
					key="docs:work:archive"
					label={`Archive (${archivedTicketCount()})`}
					expanded={archiveExpanded()}
					title={props.filtered ? LOCKED : archiveExpanded() ? "Hide archived tickets" : "Show archived tickets"}
					onActivate={() => !props.filtered && setArchiveOpen((v) => !v)}
					onToggle={() => !props.filtered && setArchiveOpen((v) => !v)}
				>
					<Icon name={archiveExpanded() ? "chevron-down" : "chevron-right"} class="twisty" />
					<span class="head-words">Archive ({archivedTicketCount()})</span>
				</Row>
				<Show when={archiveExpanded()}>
					<For each={archivedRows()}>{(row) => renderWorkRow(row, true)}</For>
				</Show>
			</Show>
			<For each={catalogs()}>{(catalog) => <ItemRow file={catalog} note={catalog.group} fold={NO_FOLD} />}</For>
		</RowGroup>
	);
}

/** The knowledge base: its decisions, questions, snippets and notes, each kind together. */
function Knowledge(props: { files: DocFile[]; empty?: string; filtered?: boolean }) {
	const files = () => props.files.filter((d) => d.group === "knowledge");
	const kinds = () => [...KNOWLEDGE.map((k) => ({ id: k.id as string, name: k.name })), { id: "", name: "Other" }].map((kind) => ({ ...kind, files: files().filter((d) => !isCatalog(d) && (kind.id ? d.kind === kind.id : !KNOWLEDGE.some((k) => k.id === d.kind))) })).filter((kind) => kind.files.length);
	return (
		<RowGroup fold="docs:knowledge" label="Knowledge base" onMenu={(at) => void headMenu("knowledge", "Knowledge base", at)} open={props.filtered} count={files().filter((d) => !isCatalog(d)).length} role="group" head={<Head title="Knowledge base" folder={folderOf("knowledge")} />} rows={files().length > 0} empty={<Show when={props.empty}><p class="hint">{props.empty}</p></Show>}>
			{/* Each kind is a group of its own inside: it folds by itself. */}
			<For each={kinds()}>
				{(kind) => (
					<RowGroup fold={`docs:knowledge:${kind.id || "other"}`} label={kind.name} onMenu={kind.id ? (at) => void headMenu(`knowledge:${kind.id}` as DocSection, kind.name, at) : undefined} open={props.filtered} count={kind.files.length} headClass="doc-kind" head={kind.name}>
						<For each={kind.files}>{(file) => <ItemRow file={file} depth={1} />}</For>
					</RowGroup>
				)}
			</For>
			<Show when={files().some(isCatalog)}>
				<div role="listbox" aria-label="The knowledge base's catalog">
					<For each={files().filter(isCatalog)}>{(catalog) => <ItemRow file={catalog} />}</For>
				</div>
			</Show>
		</RowGroup>
	);
}

/**
 * What the project's data looks like, each kind together: the tables, the messages, the file layouts, then any folder
 * of the project's own under its own name. Inside a kind, a folder is a heading of its own (a system the project
 * exchanges messages with, an area of the database). What lies at the top of the schema folder comes after, and its
 * catalog last, as the other folders' catalogs do (shared/schemaList.ts).
 */
function Schema(props: { files: DocFile[]; empty?: string; filtered?: boolean }) {
	const list = createMemo(() => schemaList(props.files, { configured: state.project?.configured, filtered: props.filtered }));
	return (
		<RowGroup fold="docs:schema" label="Schema" onMenu={(at) => void headMenu("schema", "Schema", at)} open={props.filtered} count={list().count} role="group" head={<Head title="Schema" folder={folderOf("schema")} />} rows={list().kinds.length + list().top.length > 0 || Boolean(list().catalog)} empty={<Show when={props.empty}><p class="hint">{props.empty}</p></Show>}>
			<For each={list().kinds}>
				{(kind) => (
					<RowGroup fold={`docs:schema:${kind.id}`} label={kind.name} onMenu={(at) => void headMenu(`schema:${kind.folder}`, kind.name, at)} open={props.filtered} count={kind.count} role={kind.parts.length ? "group" : undefined} headClass="doc-kind" head={kind.name}>
						<Show when={kind.parts.length} fallback={<For each={kind.files}>{(file) => <ItemRow file={{ ...file, title: schemaRowTitle(file, 1) }} depth={1} />}</For>}>
							{/* With folders inside it, a kind holds groups: what lies in the kind's own folder is a list beside them. */}
							<Show when={kind.files.length}>
								<div role="listbox" aria-label={`${kind.name}, not in a folder of its own`}>
									<For each={kind.files}>{(file) => <ItemRow file={{ ...file, title: schemaRowTitle(file, 1) }} depth={1} />}</For>
								</div>
							</Show>
							<For each={kind.parts}>
								{(part) => (
									<RowGroup fold={`docs:schema:${kind.id}/${part.name}`} label={part.name} onMenu={(at) => void headMenu(`schema:${part.folder}`, part.name, at)} open={props.filtered} count={part.files.length} headClass="doc-kind doc-part" head={part.name}>
										<For each={part.files}>{(file) => <ItemRow file={{ ...file, title: schemaRowTitle(file, 2) }} depth={2} />}</For>
									</RowGroup>
								)}
							</For>
						</Show>
					</RowGroup>
				)}
			</For>
			<Show when={list().top.length}>
				<RowGroup fold={SCHEMA_TOP} label="At the top" open={props.filtered} count={list().top.length} headClass="doc-kind" head="At the top">
					<For each={list().top}>{(file) => <ItemRow file={{ ...file, title: schemaRowTitle(file, 0) }} depth={1} />}</For>
				</RowGroup>
			</Show>
			<Show when={list().catalog}>
				<div role="listbox" aria-label="The schema's catalog">
					<ItemRow file={list().catalog!} />
				</div>
			</Show>
		</RowGroup>
	);
}

/** The registries: each with how far it is. */
function Registries(props: { files: DocFile[]; empty?: string; filtered?: boolean }) {
	const files = () => props.files.filter((d) => d.group === "registries");
	return (
		<RowGroup fold="docs:registries" label="Registries" onMenu={(at) => void headMenu("registries", "Registries", at)} open={props.filtered} count={files().filter((d) => !isCatalog(d)).length} head={<Head title="Registries" folder={folderOf("registries")} />} rows={files().length > 0} empty={<Show when={props.empty}><p class="hint">{props.empty}</p></Show>}>
			<For each={files().filter((d) => !isCatalog(d))}>{(file) => <ItemRow file={{ ...file, title: registryTitle(file.name) }} note={progress(file)} short={progressShort(file)} />}</For>
			<For each={files().filter(isCatalog)}>{(catalog) => <ItemRow file={catalog} />}</For>
		</RowGroup>
	);
}

function Group(props: { title: string; folder?: string; group: DocFile["group"]; files: DocFile[]; empty?: string; filtered?: boolean }) {
	const files = () => props.files.filter((d) => d.group === props.group);
	/** The catalog of this list's own folder: the one the app keeps, which says so of itself. */
	const own = (file: DocFile) => isCatalog(file) && file.catalog?.area === props.group;
	return (
		<RowGroup
			fold={`docs:${props.group}`}
			label={props.title}
			// The lists that are a folder of the project's: "Project" is the files at its top, and has no menu.
			onMenu={props.group === "docs" || props.group === "plans" ? (at) => void headMenu(props.group as DocSection, props.title, at) : undefined}
			open={props.filtered}
			count={files().filter((file) => !own(file)).length}
			head={<Head title={props.title} folder={props.folder} />}
			rows={files().length > 0}
			empty={
				<Show when={props.empty}>
					<p class="hint">{props.empty}</p>
				</Show>
			}
		>
			<For each={files().filter((file) => !own(file))}>{(file) => <DocRow file={file} />}</For>
			{/* The folder's own catalog last and apart, as the other lists have theirs. */}
			<For each={files().filter(own)}>{(catalog) => <ItemRow file={catalog} />}</For>
		</RowGroup>
	);
}

export function Docs() {
	const reading = () => docsLoading() && !docs().length;
	const failure = () => docsError();
	const settled = () => !reading() && !failure();
	const areas = createMemo(() => CATALOG_AREAS.filter((area) => area !== "schema" || folderParts(state.project?.schema ?? "schema").length > 0));
	const staleCatalogs = createMemo(() => docs().filter((d) => d.exists && d.catalog?.stale));
	const catalogIssues = createMemo(() => docChecks(docs(), areas()).filter((c) => c.fix?.kind === "catalogs"));
	const askAgentToReconcile = () => {
		void staleCatalogSummaryAsync().then(({ prompt }) => {
			if (!prompt) return;
			void import("../agent/Agent").then((m) => m.openAgentWithDraft(prompt, { cleanContext: true }));
		});
	};
	/** Narrows every list in the panel to the documents the words typed are in. */
	const [filter, setFilter] = createSignal("");
	const [mode, setMode] = createSignal<"all" | "active" | "ticket" | "problems">("all");
	const [typeFilter, setTypeFilter] = createSignal<"all" | "tickets" | "specs" | "decisions" | "questions" | "schema">("all");
	const [releaseFilter, setReleaseFilter] = createSignal("");
	const [activeTag, setActiveTag] = createSignal<string | null>(null);
	const [bulkMode, setBulkMode] = createSignal(false);
	const [selectedPaths, setSelectedPaths] = createSignal<Set<string>>(new Set());

	const focusedTicket = () => state.settings.activeTicket?.trim() || "";
	createEffect(() => {
		if (!focusedTicket() && mode() === "ticket") setMode("all");
	});
	const releases = createMemo(() =>
		[...new Set(docs().filter((d) => d.exists && !isCatalog(d) && d.release?.trim()).map((d) => d.release!.trim()))].sort((a, b) =>
			a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
		),
	);
	createEffect(() => {
		if (releaseFilter() && !releases().some((r) => r.toLowerCase() === releaseFilter().toLowerCase())) {
			setReleaseFilter("");
		}
	});
	const tags = createMemo(() => workspaceTags(docs()));
	const filtering = () =>
		Boolean(filter().trim()) || mode() !== "all" || Boolean(activeTag()) || typeFilter() !== "all" || Boolean(releaseFilter());
	const hasIssue = (d: DocFile) => Boolean(d.broken?.length || d.missing?.length || d.missingSource || d.problems?.length || d.catalog?.stale || d.untouched);

	const toggleBulkMode = () => {
		const next = !bulkMode();
		setBulkMode(next);
		if (!next) setSelectedPaths(new Set<string>());
	};
	const toggleBulkPath = (path: string) => {
		setSelectedPaths((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	};
	const bulkCtx: BulkSelectState = {
		active: bulkMode,
		has: (path) => selectedPaths().has(path),
		toggle: toggleBulkPath,
	};
	const selectedDocs = createMemo(() => {
		const sel = selectedPaths();
		if (!sel.size) return [] as DocFile[];
		return docs().filter((d) => sel.has(d.path) && isBulkSelectable(d));
	});
	const previewNames = (list: DocFile[]) =>
		list
			.slice(0, 4)
			.map((d) => d.ticket || d.title || baseName(d.path))
			.join(", ") + (list.length > 4 ? ` and ${list.length - 4} more` : "");

	const bulkSetStatus = async () => {
		const targets = selectedDocs();
		if (!targets.length) return;
		const statusPool = [...new Set([...targets.flatMap((d) => statusChoices(d)), "open", "in progress", "waiting", "review", "done", "draft", "decided", "retired"])];
		const picked = await choose(
			`Set status for ${targets.length} selected ${targets.length === 1 ? "document" : "documents"}`,
			statusPool.slice(0, 8),
		);
		if (!picked) return;
		if (targets.length > 1) {
			const GO = `Set status on ${targets.length} documents`;
			if ((await choose(`Set status to "${picked}" on ${targets.length} documents (${previewNames(targets)})?`, [GO])) !== GO) {
				return;
			}
		}
		let changed = 0;
		for (const doc of targets) {
			if (targets.length === 1) {
				await setStatus(doc.path, picked);
				changed++;
			} else if (await editDocFrontMatter(doc.path, (text) => withFrontMatter(text, "status", picked))) {
				changed++;
			}
		}
		if (targets.length > 1) {
			setState("treeVersion", (v) => v + 1);
			notify(changed ? `Set status to "${picked}" on ${changed} ${changed === 1 ? "document" : "documents"}.` : "Selected documents already had that status.");
		}
	};

	const bulkAddTag = async () => {
		const targets = selectedDocs();
		if (!targets.length) return;
		const raw = (await ask(`Add tag to ${targets.length} selected ${targets.length === 1 ? "document" : "documents"} (without #)`))?.trim();
		if (!raw) return;
		const tag = normalizeTag(raw, { fromYaml: true });
		if (!tag) return notify("Enter a valid tag name (letters, digits, _, -, /).", "error");
		if (targets.length > 1) {
			const GO = `Add #${tag} to ${targets.length} documents`;
			if ((await choose(`Add tag #${tag} to ${targets.length} documents (${previewNames(targets)})?`, [GO])) !== GO) {
				return;
			}
		}
		let changed = 0;
		for (const doc of targets) {
			if (await editDocFrontMatter(doc.path, (text) => addToFrontMatterList(text, "tags", tag))) changed++;
		}
		setState("treeVersion", (v) => v + 1);
		notify(changed ? `Added #${tag} to ${changed} ${changed === 1 ? "document" : "documents"}.` : `Selected documents already have #${tag}.`);
	};

	const bulkSetRelease = async () => {
		const targets = selectedDocs();
		if (!targets.length) return;
		const val = (await ask(`Set release for ${targets.length} selected ${targets.length === 1 ? "document" : "documents"} (e.g. R2026.12)`))?.trim();
		if (!val) return;
		if (targets.length > 1) {
			const GO = `Set release on ${targets.length} documents`;
			if ((await choose(`Set release: "${val}" on ${targets.length} documents (${previewNames(targets)})?`, [GO])) !== GO) {
				return;
			}
		}
		let changed = 0;
		for (const doc of targets) {
			if (await editDocFrontMatter(doc.path, (text) => withFrontMatter(text, "release", val))) changed++;
		}
		setState("treeVersion", (v) => v + 1);
		notify(changed ? `Set release "${val}" on ${changed} ${changed === 1 ? "document" : "documents"}.` : "Selected documents already had that release.");
	};

	const focusedTicketPaths = createMemo(() => {
		const key = focusedTicket();
		if (!key) return new Set<string>();
		const list = docs();
		const paths = new Set<string>();
		const keys = [key, ...descendantTickets(list, key).map((t) => t.ticket).filter((k): k is string => Boolean(k))];
		for (const k of keys) {
			const tDoc = list.find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === k.toLowerCase());
			if (tDoc) paths.add(canonical(tDoc.path));
			for (const g of ticketWork(list, k)) {
				if (g.kind === "ticket") continue;
				for (const f of g.files) paths.add(canonical(f.path));
			}
		}
		return paths;
	});
	// A registry is known by what it is called, not by its file's name.
	const shown = createMemo(() => {
		const list = docs();
		if (!filtering()) return list;
		const tagLower = activeTag()?.toLowerCase() ?? "";
		const relLower = releaseFilter().trim().toLowerCase();
		const tf = typeFilter();
		const tPaths = mode() === "ticket" ? focusedTicketPaths() : null;
		return list.filter((d) => {
			if (tagLower) {
				if (isCatalog(d) || !d.tags?.some((t) => t.toLowerCase() === tagLower)) return false;
			}
			if (relLower) {
				if (isCatalog(d) || d.release?.trim().toLowerCase() !== relLower) return false;
			}
			if (tf !== "all") {
				if (isCatalog(d)) return false;
				if (tf === "tickets" && d.group !== "tickets") return false;
				if (tf === "specs" && d.group !== "specs") return false;
				if (tf === "decisions" && !(d.group === "knowledge" && d.kind === "decisions")) return false;
				if (tf === "questions" && !(d.group === "knowledge" && d.kind === "questions")) return false;
				if (tf === "schema" && d.group !== "schema") return false;
			}
			if (mode() === "problems") {
				if (!hasIssue(d)) return false;
			} else if (mode() === "ticket") {
				if (isCatalog(d) || !tPaths?.has(canonical(d.path))) return false;
			} else if (mode() === "active") {
				if (isCatalog(d) || isArchivedTicket(d) || isArchivedTicketPath(d)) return false;
				const t = toneOf(d.status);
				if (t !== "active" && t !== "waiting") return false;
			} else if (isCatalog(d)) {
				return false;
			}
			if (!filter().trim()) return true;
			return docMatches(d.group === "registries" ? { ...d, title: registryTitle(d.name) } : d, filter());
		});
	});
	/** Whether a list has anything to show: while filtering, one that has nothing is left out, heading and all. */
	const has = (...groups: DocFile["group"][]) => !filtering() || shown().some((d) => groups.includes(d.group));
	return (
		<BulkSelectContext.Provider value={bulkCtx}>
		<div class="panel-body" data-panel="docs">
			<div class="panel-title">
				<span>Docs</span>
				<Menu floating label="New document, export, import, or update the catalogs" title="New…: a ticket, spec, plan, decision, question, snippet, prompt, registry, table, interface message, file layout or document. Also: import, export, onboard, update catalogs" items={() => [
					{ label: "New ticket…", run: () => void newTicket() },
					{ label: "Import tickets…", run: () => void importTickets() },
					{ label: "New spec…", run: () => void newSpec() },
					{ label: "New plan…", run: () => void import("../commands").then((m) => m.runCommand("new-plan")) },
					"separator",
					{ label: "New decision…", run: () => void newKnowledge("decisions") },
					{ label: "New question…", run: () => void newKnowledge("questions") },
					{ label: "New snippet…", run: () => void newKnowledge("snippets") },
					{ label: "New prompt…", run: () => void newKnowledge("prompts") },
					{ label: "New reference note…", run: () => void newKnowledge("reference") },
					"separator",
					{ label: "New registry…", run: () => void newRegistry() },
					{ label: "Update file manifest", run: () => void updateManifest() },
					"separator",
					...SCHEMAS.map((kind) => ({ label: newOfKind(kind), run: () => void newSchema(kind.id) })),
					{ label: "Generate table doc from SQL…", run: () => void generateSchemaDocFromSql() },
					"separator" as const,
					{ label: "New document…", run: () => void newDoc() },
					{ label: "New from template…", run: () => void newNoteFromTemplate() },
					{ label: "Customize templates…", run: () => void manageTemplates() },
					{ label: "Project state…", run: () => void newState() },
					{ label: "Update catalogs", run: () => void updateCatalogs() },
					{ label: "Start folder catalogs", run: () => void startFolderCatalogs() },
					"separator" as const,
					{ label: "Export Release Bundle…", run: () => void runProjectDocsAction("exportReleaseBundle", "Export Release Bundle") },
					{ label: "Export Traceability Matrix (RTM)…", run: () => void runProjectDocsAction("exportRtm", "Export Traceability Matrix (RTM)") },
					{ label: "Import Word / HTML doc…", run: () => void runProjectDocsAction("importLegacyDoc", "Import Word / HTML doc") },
					{ label: "Onboard existing workspace…", run: () => void runProjectDocsAction("onboardBrownfieldWorkspace", "Onboard existing workspace") },
				]}>
					<Icon name="add" />
				</Menu>
				<IconButton
					label={bulkMode() ? "Exit bulk select mode" : "Select multiple documents for bulk actions"}
					title={bulkMode() ? "Exit bulk select" : "Select multiple documents"}
					icon="checklist"
					pressed={bulkMode()}
					onClick={toggleBulkMode}
				/>
				<IconButton label="Collapse all" title={filtering() ? `Collapse all: not while filtering. ${LOCKED}.` : "Collapse all: shut every group and ticket"} icon="collapse-all" disabled={filtering()} onClick={() => setFolds(allFolds(), true)} />
				<IconButton label="Expand all" title={filtering() ? `Expand all: not while filtering. ${LOCKED}.` : "Expand all: open every group and ticket"} icon="expand-all" disabled={filtering()} onClick={() => setFolds(allFolds(), false)} />
				<IconButton label="Refresh the document list" title="Refresh" icon="refresh" onClick={() => setState("treeVersion", (v) => v + 1)} />
			</div>
			<Show when={state.project?.description}>
				<p class="hint">{state.project!.description}</p>
			</Show>
			<Show when={state.project?.error}>
				<p class="hint warn">project.toml could not be read, so the defaults apply: {state.project!.error}</p>
			</Show>
			<Show when={state.project && !state.project.configured}>
				<div class="docs-setup">
					<p class="hint">This folder is not set up as a project yet.</p>
					<button class="primary" onClick={() => void setUpProject()}>
						Set up project
					</button>
				</div>
			</Show>
			<Show when={reading()}>
				<p class="hint">Reading the project's documents…</p>
			</Show>
			<Show when={!reading() && failure()}>
				<p class="hint warn" role="alert">
					The documents could not be listed: {failure()}. Press Refresh, above, to try again.
				</p>
			</Show>
			<Show when={catalogIssues().length > 0}>
				<div class="docs-stale-bar" role="status">
					<span class="docs-stale-text" title={catalogIssues().map((c) => c.text).join("\n")}>
						<Icon name="warning" />
						<span>
							{staleCatalogs().length > 0
								? staleCatalogs().length === 1
									? "1 index out of sync"
									: `${staleCatalogs().length} indexes out of sync`
								: "Missing folder index"}
						</span>
					</span>
					<div class="docs-stale-actions">
						<button type="button" class="docs-stale-btn" title="Rewrite out-of-date or missing INDEX.md catalogs now (manual reconciliation)" onClick={() => void updateCatalogs()}>
							Update
						</button>
						<button type="button" class="docs-stale-btn" title="Open Agent with a reconciliation prompt for out-of-date or missing catalogs" onClick={askAgentToReconcile}>
							Agent
						</button>
					</div>
				</div>
			</Show>
			<Show when={filtering() || docs().some((d) => d.exists)}>
				<div class="docs-filter-bar">
					<input
						class="filter"
						type="search"
						aria-label="Filter the project's documents by title, key, state or what they are about"
						placeholder="Filter"
						value={filter()}
						onInput={(e) => setFilter(e.currentTarget.value)}
						onKeyDown={(e) => e.key === "ArrowDown" && focusRowsBelow(e.currentTarget) && e.preventDefault()}
					/>
					<div class="docs-filter-pills" role="group" aria-label="Document filter mode">
						<button type="button" classList={{ on: mode() === "all" }} onClick={() => setMode("all")}>
							All
						</button>
						<button type="button" classList={{ on: mode() === "active" }} title="Active and waiting work (excludes archived tickets)" onClick={() => setMode("active")}>
							Active
						</button>
						<Show when={focusedTicket()}>
							<button
								type="button"
								classList={{ on: mode() === "ticket" }}
								title={`Show only ${focusedTicket()} and its linked specs, plans, decisions, questions, schemas, and registries`}
								onClick={() => setMode("ticket")}
							>
								This ticket
							</button>
						</Show>
						<button type="button" classList={{ on: mode() === "problems" }} title="Documents with broken links, problems, or stale catalogs" onClick={() => setMode("problems")}>
							Issues
						</button>
					</div>
					<div
						class="docs-facet-row"
						style={{ display: "flex", gap: "4px", "align-items": "center", "flex-wrap": "wrap" }}
					>
						<select
							aria-label="Filter by document type"
							title="Filter by document type"
							value={typeFilter()}
							onChange={(e) => setTypeFilter(e.currentTarget.value as "all" | "tickets" | "specs" | "decisions" | "questions" | "schema")}
							style={{
								flex: "1 1 90px",
								"min-width": "0",
								padding: "2px 6px",
								"font-size": "var(--text-xs)",
								"line-height": "1.4",
							}}
						>
							<option value="all">All types</option>
							<option value="tickets">Tickets</option>
							<option value="specs">Specs</option>
							<option value="decisions">Decisions</option>
							<option value="questions">Questions</option>
							<option value="schema">Schema</option>
						</select>
						<Show when={releases().length > 0}>
							<select
								aria-label="Filter by release"
								title="Filter by release"
								value={releaseFilter()}
								onChange={(e) => setReleaseFilter(e.currentTarget.value)}
								style={{
									flex: "1 1 90px",
									"min-width": "0",
									padding: "2px 6px",
									"font-size": "var(--text-xs)",
									"line-height": "1.4",
								}}
							>
								<option value="">All releases</option>
								<For each={releases()}>{(rel) => <option value={rel}>{rel}</option>}</For>
							</select>
						</Show>
					</div>
					<Show when={activeTag()}>
						{(tag) => (
							<button
								type="button"
								class="docs-tag-active"
								title={`Filtering by #${tag()}. Click to clear.`}
								onClick={() => setActiveTag(null)}
							>
								<span>#{tag()}</span>
								<Icon name="close" />
							</button>
						)}
					</Show>
				</div>
			</Show>
			<Show when={bulkMode()}>
				<div
					class="docs-bulk-bar"
					role="region"
					aria-label="Bulk document actions"
					style={{
						display: "flex",
						"flex-direction": "column",
						gap: "4px",
						margin: "0 var(--space-3) var(--space-2)",
						padding: "var(--space-1) var(--space-2)",
						"border-radius": "var(--radius-sm)",
						border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
						background: "color-mix(in srgb, var(--accent) 10%, transparent)",
						"font-size": "var(--text-xs)",
						flex: "none",
					}}
				>
					<div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "var(--space-2)" }}>
						<span style={{ "font-weight": "500", color: "var(--fg)" }}>
							{selectedDocs().length === 0
								? "Select Markdown docs"
								: `${selectedDocs().length} selected`}
						</span>
						<button type="button" class="docs-stale-btn" onClick={toggleBulkMode}>
							Done
						</button>
					</div>
					<div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
						<button type="button" class="docs-stale-btn" disabled={!selectedDocs().length} onClick={() => void bulkSetStatus()}>
							Set status…
						</button>
						<button type="button" class="docs-stale-btn" disabled={!selectedDocs().length} onClick={() => void bulkAddTag()}>
							Add tag…
						</button>
						<button type="button" class="docs-stale-btn" disabled={!selectedDocs().length} onClick={() => void bulkSetRelease()}>
							Set release…
						</button>
					</div>
				</div>
			</Show>
			<Rows label="The project's documents">
				<Show when={filtering() && !shown().length}>
					<p class="hint">
						{filter().trim()
							? `No document matches “${filter().trim()}”. Clear the filter to see them all.`
							: releaseFilter()
								? `No matching documents in release ${releaseFilter()}.`
								: typeFilter() !== "all"
									? `No matching ${typeFilter()} right now.`
									: activeTag()
										? `No matching documents tagged #${activeTag()}.`
										: mode() === "problems"
											? "No documents with issues right now."
											: mode() === "ticket"
												? `No documents linked to ${focusedTicket()} right now.`
												: "No active or waiting documents right now."}
					</p>
				</Show>
				<Show when={has("project")}>
					<Group title="Project" group="project" files={shown()} filtered={filtering()} />
				</Show>
				<Show when={state.project?.configured || docs().some((d) => d.group === "tickets" || d.group === "specs" || d.group === "knowledge" || d.group === "registries")}>
					<Show when={has("tickets", "specs")}>
						<Work files={shown()} filtered={filtering()} empty={settled() ? "No tickets yet. Use New, above, to add the ticket this work comes from." : undefined} />
					</Show>
					<Show when={has("knowledge")}>
						<Knowledge files={shown()} filtered={filtering()} empty={settled() ? "Nothing kept yet. Use New, above, to write down a decision, a question or a snippet." : undefined} />
					</Show>
					<Show when={has("registries")}>
						<Registries files={shown()} filtered={filtering()} empty={settled() ? "No registries yet. Use New, above, to start one: settings, files, database objects." : undefined} />
					</Show>
				</Show>
				<Show when={has("docs")}>
					<Group title="Docs" folder={folderOf("docs")} group="docs" files={shown()} filtered={filtering()} empty={settled() ? "No Markdown files here yet. Use New, above, to add one." : undefined} />
				</Show>
				<Show when={has("schema")}>
					<Schema files={shown()} filtered={filtering()} empty={settled() ? "Nothing described yet. Use New, above, to describe a table, a message or a file layout." : undefined} />
				</Show>
				<Show when={has("plans")}>
					<Group title="Plans" folder={folderOf("plans")} group="plans" files={shown()} filtered={filtering()} empty={settled() ? "No plans yet. Use New, above, to draw one." : undefined} />
				</Show>
				<Show when={tags().length > 0}>
					<RowGroup fold="docs:tags" label="Tags" count={tags().length} head={<Head title="Tags" />} rows={true}>
						<For each={tags()}>
							{(bucket) => (
								<Row
									class="tree-row doc-row"
									classList={{ active: activeTag()?.toLowerCase() === bucket.tag.toLowerCase() }}
									key={`tag:${bucket.tag}`}
									title={`#${bucket.tag} (${bucket.count} ${bucket.count === 1 ? "document" : "documents"}). Click to filter; right-click to search or rename.`}
									onActivate={() => setActiveTag((cur) => (cur?.toLowerCase() === bucket.tag.toLowerCase() ? null : bucket.tag))}
									onMenu={(at) => {
										void (async () => {
											const FILTER = activeTag()?.toLowerCase() === bucket.tag.toLowerCase() ? "Clear tag filter" : `Filter Docs by #${bucket.tag}`;
											const SEARCH = `Search workspace for #${bucket.tag} (YAML + prose)`;
											const RENAME_TAG = `Rename #${bucket.tag} across workspace…`;
											const picked = await chooseFromMenu(`Tag #${bucket.tag}`, [FILTER, SEARCH, "separator", RENAME_TAG], at);
											if (!picked) return;
											if (picked === FILTER) setActiveTag((cur) => (cur?.toLowerCase() === bucket.tag.toLowerCase() ? null : bucket.tag));
											else if (picked === SEARCH) {
												searchFor(tagSearchPattern(bucket.tag), { regex: true, include: "", exclude: "" });
											} else if (picked === RENAME_TAG) {
												const { renameTagAcrossWorkspace } = await import("../projectDocs");
												await renameTagAcrossWorkspace(bucket.tag);
											}
										})();
									}}
								>
									<Icon name="tag" class="icon" />
									<span class="label">#{bucket.tag}</span>
									<span class="meta">{bucket.count}</span>
								</Row>
							)}
						</For>
					</RowGroup>
				</Show>
			</Rows>
		</div>
		</BulkSelectContext.Provider>
	);
}
