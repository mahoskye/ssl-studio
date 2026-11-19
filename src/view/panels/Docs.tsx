// The project's documents in one place: README.md and AGENTS.md first,
// whether or not they exist yet, then the Markdown in the docs folder and the
// plans. Which folders those are comes from .ssl-studio/project.toml.
import { FileMark } from "../FileMark";
import { createResource, For, Show } from "solid-js";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { relativeTo } from "../../shared/paths";
import { DOC_FOLDERS, isCatalog, KNOWLEDGE, progress, registryTitle, toneOf } from "../../shared/projectDocs";
import { docs, newDoc, setUpProject } from "../project";
import { newKnowledge, newRegistry, newSpec, newState, newTicket, updateCatalogs, updateManifest } from "../projectDocs";
import { activePath, canonical, openFile, setState, state } from "../state";
import { IconButton, Row, RowGroup, Rows } from "./Rows";
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

/** A row for one of the working documents: its title where it has one, and its state. */
function ItemRow(props: { file: DocFile; depth?: number; lead?: string; note?: string; aside?: boolean }) {
	const selected = () => activePath() === canonical(props.file.path);
	const stale = () => props.file.catalog?.stale;
	return (
		<Row
			class="tree-row doc-row"
			key={props.file.path}
			selected={selected()}
			classList={{ selected: selected(), catalog: isCatalog(props.file) }}
			style={{ "padding-left": `${8 + (props.depth ?? 0) * 14}px` }}
			title={[props.file.path, props.file.status ? `Status: ${props.file.status}` : "", props.file.summary, props.file.tickets?.length ? `${props.file.group === "tickets" ? "Related to" : "For"} ${props.file.tickets.join(", ")}` : "", ...(props.file.problems ?? [])].filter(Boolean).join("\n")}
			onActivate={() => void openFile(props.file.path)}
		>
			<FileMark name={props.file.name} />
			<span class="label">
				<Show when={props.lead}>
					<strong class="doc-key">{props.lead}</strong>{" "}
				</Show>
				{isCatalog(props.file) ? "Catalog" : props.file.title || props.file.name}
			</span>
			<Show when={props.note}>
				<span class="meta" classList={{ aside: props.aside }}>{props.note}</span>
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

/** The work: each ticket, and under it the specs written for it. Specs for no ticket here follow. */
function Work(props: { files: DocFile[]; empty?: string }) {
	const tickets = () => props.files.filter((d) => d.group === "tickets" && !isCatalog(d));
	const specs = () => props.files.filter((d) => d.group === "specs" && !isCatalog(d));
	const rel = (path: string) => relativeTo(state.workspace?.root, path).split("\\").join("/");
	const specsOf = (ticket: DocFile) => specs().filter((spec) => spec.tickets?.some((key) => key.toLowerCase() === ticket.ticket?.toLowerCase()) || ticket.specs?.some((path) => path === rel(spec.path)));
	const loose = () => specs().filter((spec) => !tickets().some((ticket) => specsOf(ticket).includes(spec)));
	const catalogs = () => props.files.filter((d) => (d.group === "tickets" || d.group === "specs") && isCatalog(d));
	return (
		<RowGroup head={<Head title="Work" folder={`${state.project?.docs}/${DOC_FOLDERS.tickets}`} />} rows={props.files.some((d) => d.group === "tickets" || d.group === "specs")} empty={<Show when={props.empty}><p class="hint">{props.empty}</p></Show>}>
			<For each={tickets()}>
				{(ticket) => (
					<>
						<ItemRow file={ticket} lead={ticket.ticket} />
						<For each={specsOf(ticket)}>{(spec) => <ItemRow file={spec} depth={1} note="spec" aside />}</For>
					</>
				)}
			</For>
			<For each={loose()}>{(spec) => <ItemRow file={spec} note={spec.tickets?.length ? `for ${spec.tickets.join(", ")}` : "spec, no ticket"} />}</For>
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
			<For each={files().filter((d) => !isCatalog(d))}>{(file) => <ItemRow file={{ ...file, title: registryTitle(file.name) }} note={progress(file)} />}</For>
			<For each={files().filter(isCatalog)}>{(catalog) => <ItemRow file={catalog} />}</For>
		</RowGroup>
	);
}

function Group(props: { title: string; folder?: string; group: DocFile["group"]; empty?: string }) {
	const files = () => docs().filter((d) => d.group === props.group);
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
	return (
		<div class="panel-body" data-panel="docs">
			<div class="panel-title">
				<span>Docs</span>
				<Menu label="New document, or update the catalogs" title="New ticket, spec, decision, question, snippet, registry, document or plan; update the catalogs" items={() => [
					{ label: "New ticket…", run: () => void newTicket() },
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
			<Rows label="The project's documents">
				<Group title="Project" group="project" />
				<Show when={state.project?.configured || docs().some((d) => d.group === "tickets" || d.group === "specs" || d.group === "knowledge" || d.group === "registries")}>
					<Work files={docs()} empty={settled() ? "No tickets yet. Use ＋ to add the ticket this work comes from." : undefined} />
					<Knowledge files={docs()} empty={settled() ? "Nothing kept yet. Use ＋ to write down a decision, a question or a snippet." : undefined} />
					<Registries files={docs()} empty={settled() ? "No registries yet. Use ＋ to start one: settings, files, database objects." : undefined} />
				</Show>
				<Group title="Docs" folder={state.project?.docs} group="docs" empty={settled() ? "No Markdown files here yet. Use ＋ to add one." : undefined} />
				<Group title="Schema" folder={state.project?.schema} group="schema" empty={settled() ? "No tables described yet. Add a Markdown file to this folder for each table." : undefined} />
				<Group title="Plans" folder={state.project?.plans} group="plans" empty={settled() ? "No plans yet. Use ＋ to draw one." : undefined} />
			</Rows>
		</div>
	);
}
