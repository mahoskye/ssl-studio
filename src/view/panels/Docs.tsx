// The project's documents in one place: README.md and AGENTS.md first,
// whether or not they exist yet, then the Markdown in the docs folder and the
// plans. Which folders those are comes from .ssl-studio/project.toml.
import { Icon } from "../Icon";
import { FileMark } from "../FileMark";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { docChecks } from "../../shared/docChecks";
import { CATALOG_AREAS, docMatches, isCatalog, KNOWLEDGE, progress, progressShort, registryTitle, SCHEMAS, statusChoices, toneOf } from "../../shared/projectDocs";
import { workspaceTags } from "../../shared/tags";
import { docs, docsError, docsLoading, newDoc, newDocIn, newFolderIn, setUpProject } from "../project";
import {
	archiveTicket,
	createTicketFolder,
	exportTicketPacket,
	generateSchemaDocFromSql,
	importTickets,
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
	updateCatalogs,
	updateManifest,
} from "../projectDocs";
import { searchFor } from "./Search";
import { manageTemplates, newNoteFromTemplate } from "../templater";
import { folderParts, folderSaid, IMPORT_TICKETS, kindOf, NEW_DOCUMENT, NEW_FOLDER, NEW_PLAN, NEW_REGISTRY, NEW_SPEC, NEW_TICKET, newOfKind, plainSection, schemaFolderOf, schemaOf, sectionFolder, sectionMenu, SHOW_FOLDER, type DocSection } from "../../shared/docSections";
import { joinPath } from "../../shared/paths";
import { schemaList, schemaRowTitle } from "../../shared/schemaList";
import { shownRows, workList } from "../../shared/workList";
import { activePath, canonical, notify, openFile, openToSide, setState, state } from "../state";
import { gitStatus } from "../git";
import { changeLetter } from "../../shared/gitStatus";
import { focusRowsBelow, IconButton, isFolded, Row, RowGroup, Rows, setFold, setFolds, type Point } from "./Rows";
import { chooseFromMenu } from "./RowMenu";
import { Menu } from "../Menu";

function gitKindOf(path: string) {
	const st = gitStatus();
	if (!st) return null;
	const hit = st.files.find((f) => canonical(f.path) === canonical(path));
	return hit ? (hit.unstaged ?? hit.staged ?? null) : null;
}

function DocRow(props: { file: DocFile }) {
	// One click opens it for a look, in a tab the next file clicked takes; a double click keeps the tab.
	const open = () => (props.file.exists ? void openFile(props.file.path, { preview: true }) : void setUpProject());
	const selected = () => props.file.exists && activePath() === canonical(props.file.path);
	const dirty = () => props.file.exists && Boolean(state.dirty[canonical(props.file.path)]);
	const git = () => (props.file.exists ? gitKindOf(props.file.path) : null);
	return (
		<Row
			class="tree-row doc-row"
			key={props.file.path}
			selected={selected()}
			classList={{ selected: selected(), missing: !props.file.exists }}
			title={props.file.exists ? props.file.path : `${props.file.name} is missing. Click it, or press Enter on it, to create it.`}
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
			<FileMark name={props.file.name} />
			<span class="label">{props.file.heading || props.file.title || props.file.name}</span>
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
const RENAME = "Rename…";
const TRASH = "Move to trash…";
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
	const states = markdown && !catalog && (contract || (["tickets", "specs", "knowledge"].includes(file.group) && (file.status || file.group !== "knowledge" || file.kind === "decisions" || file.kind === "questions"))) ? statusChoices(file).filter((status) => status.toLowerCase() !== (file.status ?? "").toLowerCase()) : [];
	const UPDATE = catalog ? "Update catalogs" : "Update file manifest";
	// A file that is not there yet has one thing that can be done to it.
	// The project's own settings file is what makes the folder a project: it is not renamed or thrown away from its
	// row here, where nothing would read the project again after it.
	const own = Boolean(state.project && canonical(file.path) === canonical(state.project.path));
	const isTicket = file.group === "tickets" && !catalog;
	const isAnsweredQuestion = file.group === "knowledge" && file.kind === "questions" && !catalog && toneOf(file.status) === "done";
	const isSchemaItem = file.group === "schema" && !catalog;
	const isSchemaSql = isSchemaItem && /\.(sql|ddl|pks|pkb)$/i.test(file.name);
	const EXPORT_PACKET = "Export release packet (HTML)…";
	const PROMOTE_DECISION = "Promote answer to decision…";
	const DOC_FROM_SQL = "Generate table doc from SQL…";
	const FIND_IN_CODE = "Find usages in code";
	const ticketActions = isTicket
		? [
				...(file.ticket ? [NEW_SUBTICKET, EXPORT_PACKET] : []),
				...(file.ticketFolder ? [NEW_TICKET_FILE, SHOW_TICKET_FOLDER] : [CREATE_TICKET_FOLDER]),
				ARCHIVE_TICKET,
			]
		: [];
	const extraActions = [
		...(isAnsweredQuestion ? [PROMOTE_DECISION] : []),
		...(isSchemaSql ? [DOC_FROM_SQL] : []),
		...(isSchemaItem ? [FIND_IN_CODE] : []),
	];
	const items = file.exists ? [OPEN, SIDE, ...states.map((status) => `${STATE}${status}`), ...ticketActions, ...extraActions, ...(catalog || manifest ? [UPDATE] : []), PATH, RELATIVE, NAME, SHOW, ...(own ? [] : [RENAME, TRASH])] : [CREATE];
	const picked = await chooseFromMenu(`Actions for ${file.ticket ?? file.title ?? file.name}`, items, at);
	if (!picked) return;
	if (picked === OPEN) await openFile(file.path, { keep: true });
	else if (picked === SIDE) await openToSide(file.path);
	else if (picked === CREATE) await setUpProject();
	else if (picked === NEW_SUBTICKET && file.ticket) await newTicket(undefined, undefined, { parent: file.ticket });
	else if (picked === EXPORT_PACKET && file.ticket) await exportTicketPacket(file.path, file.ticket, "html");
	else if (picked === PROMOTE_DECISION) await promoteQuestionToDecision(file.path);
	else if (picked === DOC_FROM_SQL) await generateSchemaDocFromSql(file.path);
	else if (picked === FIND_IN_CODE) {
		const stem = (file.title || file.name.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "").trim();
		if (stem) searchFor(stem);
	}
	else if (picked === ARCHIVE_TICKET) await archiveTicket(file);
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
	/**
	 * In a list where rows have rows under them: whether this one has, and whether they are shut away. Leaves a
	 * twisty's room either way. `locked` says why it cannot be shut now (a filter is showing everything it found).
	 */
	fold?: { parent: boolean; shut: boolean; locked?: string; toggle: () => void };
}) {
	const selected = () => activePath() === canonical(props.file.path);
	const stale = () => props.file.catalog?.stale;
	return (
		<Row
			class="tree-row doc-row"
			key={props.file.path}
			selected={selected()}
			classList={{ selected: selected(), catalog: isCatalog(props.file) }}
			style={{ "padding-left": `${8 + (props.depth ?? 0) * 14}px` }}
			// Where it is, its state, what it is for, how it is linked, and what is wrong with it: nothing the reader has to keep up by hand.
			title={[
				props.file.path,
				props.file.status ? `Status: ${props.file.status}` : "",
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
			onActivate={() => void openFile(props.file.path, { preview: true })}
			onKeep={() => void openFile(props.file.path, { keep: true })}
			onMenu={(at) => void rowMenu(props.file, at)}
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
			<FileMark name={props.file.name} />
			{/* Open or shut, in words, for what reads the screen aloud: a list's row has no state for it. */}
			<Show when={props.fold?.parent}>
				<span class="visually-hidden">{props.fold!.locked ? `${props.fold!.locked}.` : props.fold!.shut ? "Shut: what is under it is hidden." : "Open."} </span>
			</Show>
			<span class="label">
				<Show when={props.lead}>
					<strong class="doc-key">{props.lead}</strong>{" "}
				</Show>
				{isCatalog(props.file) ? "Catalog" : props.file.title || props.file.name}
			</span>
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
	...(["project", "work", "knowledge", "registries", "docs", "schema", "plans"] as const).map((group) => `docs:${group}`),
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
	const picked = await chooseFromMenu(`Actions for ${title}, in ${folderSaid(folder)}`, sectionMenu(section), at);
	if (!picked) return;
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
 */
function Work(props: { files: DocFile[]; empty?: string; filtered?: boolean }) {
	const [all, setAll] = createSignal(false);
	// What a filter found is shown, finished or not.
	const list = createMemo(() => workList(props.files, state.workspace?.root, { all: all() || props.filtered }));
	/** How many finished tickets fold away, whether or not they are shown now. */
	const everything = createMemo(() => (props.filtered ? 0 : workList(props.files, state.workspace?.root).folded));
	const catalogs = () => props.files.filter((d) => (d.group === "tickets" || d.group === "specs") && isCatalog(d));
	/** The rows with what is under a shut ticket left out. What a filter found is shown, shut or not. */
	const rows = createMemo(() => shownRows(list().rows, (row) => !props.filtered && isFolded(ticketFold(row.file))));
	const fold = (row: ReturnType<typeof rows>[number]) => ({ parent: row.parent, shut: row.shut, locked: props.filtered ? LOCKED : undefined, toggle: () => setFold(ticketFold(row.file), !row.shut) });
	return (
		<RowGroup fold="docs:work" label="Work" onMenu={(at) => void headMenu("work", "Work", at)} open={props.filtered} count={props.files.filter((d) => (d.group === "tickets" || d.group === "specs") && !isCatalog(d)).length} head={<Head title="Work" folder={folderOf("work")} />} rows={props.files.some((d) => d.group === "tickets" || d.group === "specs")} empty={<Show when={props.empty}><p class="hint">{props.empty}</p></Show>}>
			<For each={rows()}>
				{(row) =>
					row.kind === "ticket" ? (
						<ItemRow file={row.file} depth={row.depth} lead={row.file.ticket} linkDetail={row.link?.detail} fold={fold(row)} />
					) : row.kind === "plan" ? (
						<ItemRow file={{ ...row.file, title: row.file.name.replace(/\.plan\.json$/i, "") }} depth={row.depth} note="plan" linkDetail={row.link?.detail} fold={fold(row)} />
					) : (
						<ItemRow file={row.file} depth={row.depth} note="spec" linkDetail={row.link?.detail} fold={fold(row)} />
					)
				}
			</For>
			{/* What is done or set aside is not what the list is opened for: beyond a few, it waits behind its count. */}
			<Show when={everything()}>
				<Row class="tree-row doc-row doc-more" key="finished-tickets" title={all() ? "Leave out the tickets that are done or set aside" : "Show the tickets that are done or set aside"} onActivate={() => setAll(!all())}>
					<span class="label">{all() ? "Hide" : "Show"} the {everything()} finished</span>
				</Row>
			</Show>
			{/* The same room for a twisty as the rows above, so that the marks line up down the list. */}
			<For each={list().loose}>{(spec) => <ItemRow file={spec} note={spec.tickets?.length ? `for ${spec.tickets.join(", ")}` : "spec, no ticket"} fold={NO_FOLD} />}</For>
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
	const [mode, setMode] = createSignal<"all" | "active" | "problems">("all");
	const [activeTag, setActiveTag] = createSignal<string | null>(null);
	const tags = createMemo(() => workspaceTags(docs()));
	const filtering = () => Boolean(filter().trim()) || mode() !== "all" || Boolean(activeTag());
	const hasIssue = (d: DocFile) => Boolean(d.broken?.length || d.missing?.length || d.missingSource || d.problems?.length || d.catalog?.stale || d.untouched);
	// A registry is known by what it is called, not by its file's name.
	const shown = createMemo(() => {
		const list = docs();
		if (!filtering()) return list;
		const tagLower = activeTag()?.toLowerCase() ?? "";
		return list.filter((d) => {
			if (tagLower) {
				if (isCatalog(d) || !d.tags?.some((t) => t.toLowerCase() === tagLower)) return false;
			}
			if (mode() === "problems") {
				if (!hasIssue(d)) return false;
			} else if (mode() === "active") {
				if (isCatalog(d)) return false;
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
		<div class="panel-body" data-panel="docs">
			<div class="panel-title">
				<span>Docs</span>
				<Menu floating label="New document, or update the catalogs" title="New…: a ticket, spec, plan, decision, question, snippet, prompt, registry, table, interface message, file layout or document. Also: import tickets, update the catalogs" items={() => [
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
				]}>
					<Icon name="add" />
				</Menu>
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
						<button type="button" classList={{ on: mode() === "active" }} title="Active and waiting work" onClick={() => setMode("active")}>
							Active
						</button>
						<button type="button" classList={{ on: mode() === "problems" }} title="Documents with broken links, problems, or stale catalogs" onClick={() => setMode("problems")}>
							Issues
						</button>
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
			<Rows label="The project's documents">
				<Show when={filtering() && !shown().length}>
					<p class="hint">
						{filter().trim()
							? `No document matches “${filter().trim()}”. Clear the filter to see them all.`
							: activeTag()
								? `No matching documents tagged #${activeTag()}.`
								: mode() === "problems"
									? "No documents with issues right now."
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
									title={`#${bucket.tag} (${bucket.count} ${bucket.count === 1 ? "document" : "documents"}). Click to filter; right-click to search workspace.`}
									onActivate={() => setActiveTag((cur) => (cur?.toLowerCase() === bucket.tag.toLowerCase() ? null : bucket.tag))}
									onMenu={() => searchFor(`#${bucket.tag}`)}
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
	);
}
