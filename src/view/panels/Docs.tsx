// The project's documents in one place: README.md and AGENTS.md first,
// whether or not they exist yet, then the Markdown in the docs folder and the
// plans. Which folders those are comes from .ssl-studio/project.toml.
import { FileMark } from "../FileMark";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { docMatches, DOC_FOLDERS, isCatalog, KNOWLEDGE, progress, progressShort, registryTitle, statusChoices, toneOf } from "../../shared/projectDocs";
import { docs, newDoc, setUpProject } from "../project";
import { importTickets, newKnowledge, newRegistry, newSpec, newState, newTicket, setStatus, updateCatalogs, updateManifest } from "../projectDocs";
import { workList } from "../../shared/workList";
import { activePath, canonical, openFile, setState, state } from "../state";
import { focusRowsBelow, IconButton, Row, RowGroup, Rows, type Point } from "./Rows";
import { chooseFromMenu } from "./RowMenu";
import { Menu } from "../Menu";

function DocRow(props: { file: DocFile }) {
	const open = () => (props.file.exists ? void openFile(props.file.path) : void setUpProject());
	const selected = () => props.file.exists && activePath() === canonical(props.file.path);
	return (
		<Row
			class="tree-row doc-row"
			key={props.file.path}
			selected={selected()}
			classList={{ selected: selected(), missing: !props.file.exists }}
			title={props.file.exists ? props.file.path : `${props.file.name} is missing. Click it, or press Enter on it, to create it.`}
			onActivate={open}
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
const STATE = "Set to ";
/**
 * What can be done to a working document from its row, without opening it:
 * a ticket, a spec, a decision or a question is set to a state; a catalog is
 * written afresh; the file manifest is updated. Right-click, the menu key or
 * Shift+F10 (ADR 0010).
 */
async function rowMenu(file: DocFile, at: Point) {
	const catalog = isCatalog(file);
	const manifest = file.group === "registries" && /(^|[\\/])files\.csv$/i.test(file.name);
	// A state is a Markdown document's front matter: a query or a table kept in the knowledge base has none.
	const markdown = /\.(md|markdown)$/i.test(file.name);
	const states = markdown && !catalog && ["tickets", "specs", "knowledge"].includes(file.group) && (file.status || file.group !== "knowledge" || file.kind === "decisions" || file.kind === "questions") ? statusChoices(file).filter((status) => status.toLowerCase() !== (file.status ?? "").toLowerCase()) : [];
	const UPDATE = catalog ? "Update catalogs" : "Update file manifest";
	const picked = await chooseFromMenu(`Actions for ${file.ticket ?? file.title ?? file.name}`, [OPEN, ...states.map((status) => `${STATE}${status}`), ...(catalog || manifest ? [UPDATE] : [])], at);
	if (picked === OPEN) await openFile(file.path);
	else if (picked === UPDATE) await (catalog ? updateCatalogs() : updateManifest());
	else if (picked?.startsWith(STATE)) await setStatus(file.path, picked.slice(STATE.length));
}

/** A row for one of the working documents: its title where it has one, and its state. */
function ItemRow(props: { file: DocFile; depth?: number; lead?: string; note?: string; aside?: boolean; short?: string }) {
	const selected = () => activePath() === canonical(props.file.path);
	const stale = () => props.file.catalog?.stale;
	return (
		<Row
			class="tree-row doc-row"
			key={props.file.path}
			selected={selected()}
			classList={{ selected: selected(), catalog: isCatalog(props.file) }}
			style={{ "padding-left": `${8 + (props.depth ?? 0) * 14}px` }}
			title={[props.file.path, props.file.status ? `Status: ${props.file.status}` : "", "Right-click, or the menu key, for what can be done to it.", props.file.summary, props.file.tickets?.length ? `${props.file.group === "tickets" ? "Related to" : "For"} ${props.file.tickets.join(", ")}` : "", ...(props.file.problems ?? [])].filter(Boolean).join("\n")}
			onActivate={() => void openFile(props.file.path)}
			onMenu={(at) => void rowMenu(props.file, at)}
		>
			<FileMark name={props.file.name} />
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
				<span class="meta warn" title="The list in this catalog no longer says what the folder holds. ＋, Update catalogs, writes it afresh.">
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
	return (
		<RowGroup head={<Head title="Work" folder={`${state.project?.docs}/${DOC_FOLDERS.tickets}`} />} rows={props.files.some((d) => d.group === "tickets" || d.group === "specs")} empty={<Show when={props.empty}><p class="hint">{props.empty}</p></Show>}>
			<For each={list().rows}>
				{(row) =>
					row.kind === "ticket" ? (
						<ItemRow file={row.file} depth={row.depth} lead={row.file.ticket} />
					) : row.kind === "plan" ? (
						<ItemRow file={{ ...row.file, title: row.file.name.replace(/\.plan\.json$/i, "") }} depth={row.depth} note="plan" />
					) : (
						<ItemRow file={row.file} depth={row.depth} note="spec" />
					)
				}
			</For>
			{/* What is done or set aside is not what the list is opened for: beyond a few, it waits behind its count. */}
			<Show when={everything()}>
				<Row class="tree-row doc-row doc-more" key="finished-tickets" title={all() ? "Leave out the tickets that are done or set aside" : "Show the tickets that are done or set aside"} onActivate={() => setAll(!all())}>
					<span class="label">{all() ? "Hide" : "Show"} the {everything()} finished</span>
				</Row>
			</Show>
			<For each={list().loose}>{(spec) => <ItemRow file={spec} note={spec.tickets?.length ? `for ${spec.tickets.join(", ")}` : "spec, no ticket"} />}</For>
			<For each={catalogs()}>{(catalog) => <ItemRow file={catalog} note={catalog.group} />}</For>
		</RowGroup>
	);
}

/** The knowledge base: its decisions, questions, snippets and notes, each kind together. */
function Knowledge(props: { files: DocFile[]; empty?: string }) {
	const files = () => props.files.filter((d) => d.group === "knowledge");
	const kinds = () => [...KNOWLEDGE.map((k) => ({ id: k.id as string, name: k.name })), { id: "", name: "Other" }].map((kind) => ({ ...kind, files: files().filter((d) => !isCatalog(d) && (kind.id ? d.kind === kind.id : !KNOWLEDGE.some((k) => k.id === d.kind))) })).filter((kind) => kind.files.length);
	return (
		<RowGroup head={<Head title="Knowledge base" folder={`${state.project?.docs}/${DOC_FOLDERS.knowledge}`} />} rows={files().length > 0} empty={<Show when={props.empty}><p class="hint">{props.empty}</p></Show>}>
			<For each={kinds()}>
				{(kind) => (
					<>
						<div class="doc-kind" role="presentation">
							{kind.name} <span class="count">{kind.files.length}</span>
						</div>
						<For each={kind.files}>{(file) => <ItemRow file={file} depth={1} />}</For>
					</>
				)}
			</For>
			<For each={files().filter(isCatalog)}>{(catalog) => <ItemRow file={catalog} />}</For>
		</RowGroup>
	);
}

/** The registries: each with how far it is. */
function Registries(props: { files: DocFile[]; empty?: string }) {
	const files = () => props.files.filter((d) => d.group === "registries");
	return (
		<RowGroup head={<Head title="Registries" folder={`${state.project?.docs}/${DOC_FOLDERS.registries}`} />} rows={files().length > 0} empty={<Show when={props.empty}><p class="hint">{props.empty}</p></Show>}>
			<For each={files().filter((d) => !isCatalog(d))}>{(file) => <ItemRow file={{ ...file, title: registryTitle(file.name) }} note={progress(file)} short={progressShort(file)} />}</For>
			<For each={files().filter(isCatalog)}>{(catalog) => <ItemRow file={catalog} />}</For>
		</RowGroup>
	);
}

function Group(props: { title: string; folder?: string; group: DocFile["group"]; empty?: string; filter?: string }) {
	const files = () => docs().filter((d) => d.group === props.group && docMatches(d, props.filter ?? ""));
	return (
		<RowGroup
			head={
				<>
					{props.title}{" "}
					<Show when={props.folder}>
						<span class="folder">{props.folder}/</span>
					</Show>
				</>
			}
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
				<Menu label="New document, or update the catalogs" title="New ticket, spec, decision, question, snippet, registry, document or plan; import tickets; update the catalogs" items={() => [
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
					<span aria-hidden="true">＋</span>
				</Menu>
				<IconButton label="Refresh the document list" title="Refresh" glyph="⟳" onClick={() => setState("treeVersion", (v) => v + 1)} />
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
					The documents could not be listed: {failure()}. Press ⟳ to try again.
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
						<Work files={shown()} filtered={filtering()} empty={settled() ? "No tickets yet. Use ＋ to add the ticket this work comes from." : undefined} />
					</Show>
					<Show when={has("knowledge")}>
						<Knowledge files={shown()} empty={settled() ? "Nothing kept yet. Use ＋ to write down a decision, a question or a snippet." : undefined} />
					</Show>
					<Show when={has("registries")}>
						<Registries files={shown()} empty={settled() ? "No registries yet. Use ＋ to start one: settings, files, database objects." : undefined} />
					</Show>
				</Show>
				<Show when={has("docs")}>
					<Group title="Docs" folder={state.project?.docs} group="docs" filter={filter()} empty={settled() ? "No Markdown files here yet. Use ＋ to add one." : undefined} />
				</Show>
				<Show when={has("schema")}>
					<Group title="Schema" folder={state.project?.schema} group="schema" filter={filter()} empty={settled() ? "No tables described yet. Add a Markdown file to this folder for each table." : undefined} />
				</Show>
				<Show when={has("plans")}>
					<Group title="Plans" folder={state.project?.plans} group="plans" filter={filter()} empty={settled() ? "No plans yet. Use ＋ to draw one." : undefined} />
				</Show>
			</Rows>
		</div>
	);
}
