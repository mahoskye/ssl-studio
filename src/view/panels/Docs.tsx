// The project's documents in one place: README.md and AGENTS.md first,
// whether or not they exist yet, then the Markdown in the docs folder and the
// plans. Which folders those are comes from .ssl-studio/project.toml.
import { Icon } from "../Icon";
import { FileMark } from "../FileMark";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { docMatches, isCatalog, KNOWLEDGE, progress, progressShort, registryTitle, statusChoices, toneOf } from "../../shared/projectDocs";
import { docs, newDoc, newDocIn, newFolderIn, setUpProject } from "../project";
import { importTickets, newKnowledge, newRegistry, newSpec, newState, newTicket, setStatus, updateCatalogs, updateManifest } from "../projectDocs";
import { folderParts, folderSaid, IMPORT_TICKETS, kindOf, NEW_DOCUMENT, NEW_FOLDER, NEW_PLAN, NEW_REGISTRY, NEW_SPEC, NEW_TICKET, newOfKind, plainSection, sectionFolder, sectionMenu, SHOW_FOLDER, type DocSection } from "../../shared/docSections";
import { joinPath } from "../../shared/paths";
import { shownRows, workList } from "../../shared/workList";
import { activePath, canonical, notify, openFile, openToSide, setState, state } from "../state";
import { focusRowsBelow, IconButton, isFolded, Row, RowGroup, Rows, setFold, setFolds, type Point } from "./Rows";
import { chooseFromMenu } from "./RowMenu";
import { Menu } from "../Menu";

function DocRow(props: { file: DocFile }) {
	// One click opens it for a look, in a tab the next file clicked takes; a double click keeps the tab.
	const open = () => (props.file.exists ? void openFile(props.file.path, { preview: true }) : void setUpProject());
	const selected = () => props.file.exists && activePath() === canonical(props.file.path);
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
		>
			<FileMark name={props.file.name} />
			<span class="label">{props.file.name}</span>
			<Show when={!props.file.exists}>
				<span class="meta warn">missing</span>
			</Show>
			<Show when={props.file.untouched}>
				<span class="meta warn" title="Still the template text: not written yet.">
					template
				</span>
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
	const states = markdown && !catalog && ["tickets", "specs", "knowledge"].includes(file.group) && (file.status || file.group !== "knowledge" || file.kind === "decisions" || file.kind === "questions") ? statusChoices(file).filter((status) => status.toLowerCase() !== (file.status ?? "").toLowerCase()) : [];
	const UPDATE = catalog ? "Update catalogs" : "Update file manifest";
	// A file that is not there yet has one thing that can be done to it.
	// The project's own settings file is what makes the folder a project: it is not renamed or thrown away from its
	// row here, where nothing would read the project again after it.
	const own = Boolean(state.project && canonical(file.path) === canonical(state.project.path));
	const items = file.exists ? [OPEN, SIDE, ...states.map((status) => `${STATE}${status}`), ...(catalog || manifest ? [UPDATE] : []), PATH, RELATIVE, NAME, SHOW, ...(own ? [] : [RENAME, TRASH])] : [CREATE];
	const picked = await chooseFromMenu(`Actions for ${file.ticket ?? file.title ?? file.name}`, items, at);
	if (!picked) return;
	if (picked === OPEN) await openFile(file.path, { keep: true });
	else if (picked === SIDE) await openToSide(file.path);
	else if (picked === CREATE) await setUpProject();
	else if (picked === UPDATE) await (catalog ? updateCatalogs() : updateManifest());
	else if (picked.startsWith(STATE)) await setStatus(file.path, picked.slice(STATE.length));
	else if (picked === PATH || picked === RELATIVE || picked === NAME) await (await import("../commands")).copyPath(picked === PATH ? "whole" : picked === NAME ? "name" : "relative", file.path);
	// The tree's own steps, asking and all: loaded when asked for, since the Explorer is another panel.
	else if (picked === SHOW) (await import("./Explorer")).showInExplorer(file.path);
	else if (picked === RENAME) await (await import("./Explorer")).renameFile(file.path);
	else if (picked === TRASH) await (await import("./Explorer")).trashFile(file.path);
}

/** A row for one of the working documents: its title where it has one, and its state. */
function ItemRow(props: {
	file: DocFile;
	depth?: number;
	lead?: string;
	note?: string;
	aside?: boolean;
	short?: string;
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
			// Where it is, its state, what it is for, and what is wrong with it: nothing the reader has to keep up by hand.
			title={[props.file.path, props.file.status ? `Status: ${props.file.status}` : "", props.file.tickets?.length ? `${props.file.group === "tickets" ? "Related to" : "For"} ${props.file.tickets.join(", ")}` : "", ...(props.file.problems ?? [])].filter(Boolean).join("\n")}
			expanded={props.fold?.parent ? !props.fold.shut : undefined}
			onToggle={() => props.fold?.parent && !props.fold.locked && props.fold.toggle()}
			onActivate={() => void openFile(props.file.path, { preview: true })}
			onKeep={() => void openFile(props.file.path, { keep: true })}
			onMenu={(at) => void rowMenu(props.file, at)}
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
			<Show when={stale()}>
				<span class="meta warn" title="The list in this catalog no longer says what the folder holds. “Update catalogs”, under New above, writes it afresh.">
					out of date
				</span>
			</Show>
			<Show when={props.file.untouched}>
				<span class="meta warn" title="Still the text it started with: not written yet.">
					template
				</span>
			</Show>
			<Show when={props.file.problems?.length}>
				<span class="meta warn" title={props.file.problems!.join("\n")}>
					{props.file.problems!.length === 1 ? "1 problem" : `${props.file.problems!.length} problems`}
				</span>
			</Show>
			<Status status={props.file.status} />
		</Row>
	);
}

/** Why nothing folds while a filter is on: what it found is shown, shut or not. */
const LOCKED = "Shown open while the filter is narrowing the list";
/** A row with nothing under it, in a list where others have: it leaves a twisty's room and has none. */
const NO_FOLD = { parent: false, shut: false, toggle: () => {} };
/** The name a ticket folds under: what is under it (its plans, its specs, the tickets that are part of it) is shut away with it. */
const ticketFold = (file: DocFile) => `docs:ticket:${file.path}`;
/** Every name the panel folds under: its groups, the kinds of the knowledge base, and each ticket. */
const allFolds = () => [
	...(["project", "work", "knowledge", "registries", "docs", "schema", "plans"] as const).map((group) => `docs:${group}`),
	...KNOWLEDGE.map((kind) => `docs:knowledge:${kind.id}`),
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
	if (picked === NEW_FOLDER) await newFolderIn(folder, plainSection(section));
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
						<ItemRow file={row.file} depth={row.depth} lead={row.file.ticket} fold={fold(row)} />
					) : row.kind === "plan" ? (
						<ItemRow file={{ ...row.file, title: row.file.name.replace(/\.plan\.json$/i, "") }} depth={row.depth} note="plan" fold={fold(row)} />
					) : (
						<ItemRow file={row.file} depth={row.depth} note="spec" fold={fold(row)} />
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

function Group(props: { title: string; folder?: string; group: DocFile["group"]; empty?: string; filter?: string }) {
	const files = () => docs().filter((d) => d.group === props.group && docMatches(d, props.filter ?? ""));
	return (
		<RowGroup
			fold={`docs:${props.group}`}
			label={props.title}
			// The lists that are a folder of the project's: "Project" is the files at its top, and has no menu.
			onMenu={props.group === "docs" || props.group === "schema" || props.group === "plans" ? (at) => void headMenu(props.group as DocSection, props.title, at) : undefined}
			open={Boolean(props.filter?.trim())}
			count={files().length}
			head={<Head title={props.title} folder={props.folder} />}
			rows={files().length > 0}
			empty={
				<Show when={props.empty}>
					<p class="hint">{props.empty}</p>
				</Show>
			}
		>
			<For each={files()}>{(file) => <DocRow file={file} />}</For>
		</RowGroup>
	);
}

export function Docs() {
	// The list itself comes from project.ts, which shows nothing when it cannot be read. This asks
	// as well, only to learn whether the listing failed or is still on its way.
	const [failure] = createResource(
		() => state.workspace && ([state.workspace.root, state.treeVersion] as const),
		() => backend.docs().then(() => "", (e) => String(e?.message ?? e)),
	);
	const reading = () => failure.loading && !docs().length;
	const settled = () => !reading() && !failure();
	/** Narrows every list in the panel to the documents the words typed are in. */
	const [filter, setFilter] = createSignal("");
	const filtering = () => Boolean(filter().trim());
	// A registry is known by what it is called, not by its file's name.
	const shown = createMemo(() => (filtering() ? docs().filter((d) => !isCatalog(d) && docMatches(d.group === "registries" ? { ...d, title: registryTitle(d.name) } : d, filter())) : docs()));
	/** Whether a list has anything to show: while filtering, one that has nothing is left out, heading and all. */
	const has = (...groups: DocFile["group"][]) => !filtering() || shown().some((d) => groups.includes(d.group));
	return (
		<div class="panel-body" data-panel="docs">
			<div class="panel-title">
				<span>Docs</span>
				<Menu floating label="New document, or update the catalogs" title="New…: a ticket, spec, decision, question, snippet, registry, document or plan. Also: import tickets, update the catalogs" items={() => [
					{ label: "New ticket…", run: () => void newTicket() },
					{ label: "Import tickets…", run: () => void importTickets() },
					{ label: "New spec…", run: () => void newSpec() },
					{ label: "New plan…", run: () => void import("../commands").then((m) => m.runCommand("new-plan")) },
					"separator",
					{ label: "New decision…", run: () => void newKnowledge("decisions") },
					{ label: "New question…", run: () => void newKnowledge("questions") },
					{ label: "New snippet…", run: () => void newKnowledge("snippets") },
					{ label: "New reference note…", run: () => void newKnowledge("reference") },
					"separator",
					{ label: "New registry…", run: () => void newRegistry() },
					{ label: "Update file manifest", run: () => void updateManifest() },
					"separator",
					{ label: "New document…", run: () => void newDoc() },
					{ label: "Project state…", run: () => void newState() },
					{ label: "Update catalogs", run: () => void updateCatalogs() },
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
			{/* Shown for a list long enough to need it, and for as long as it is narrowing the list: it is the way to clear itself. */}
			<Show when={filtering() || docs().filter((d) => d.exists).length > 6}>
				<input
					class="filter"
					type="search"
					aria-label="Filter the project's documents by title, key, state or what they are about"
					placeholder="Filter"
					value={filter()}
					onInput={(e) => setFilter(e.currentTarget.value)}
					onKeyDown={(e) => e.key === "ArrowDown" && focusRowsBelow(e.currentTarget) && e.preventDefault()}
				/>
			</Show>
			<Rows label="The project's documents">
				<Show when={filtering() && !shown().length}>
					<p class="hint">No document matches “{filter().trim()}”. Clear the filter to see them all.</p>
				</Show>
				<Show when={has("project")}>
					<Group title="Project" group="project" filter={filter()} />
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
					<Group title="Docs" folder={folderOf("docs")} group="docs" filter={filter()} empty={settled() ? "No Markdown files here yet. Use New, above, to add one." : undefined} />
				</Show>
				<Show when={has("schema")}>
					<Group title="Schema" folder={folderOf("schema")} group="schema" filter={filter()} empty={settled() ? "No tables described yet. Add a Markdown file to this folder for each table." : undefined} />
				</Show>
				<Show when={has("plans")}>
					<Group title="Plans" folder={folderOf("plans")} group="plans" filter={filter()} empty={settled() ? "No plans yet. Use New, above, to draw one." : undefined} />
				</Show>
			</Rows>
		</div>
	);
}
