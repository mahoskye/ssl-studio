// The project's documents in one place: README.md and AGENTS.md first,
// whether or not they exist yet, then the Markdown in the docs folder and the
// plans. Which folders those are comes from .ssl-studio/project.toml.
import { FileMark } from "../FileMark";
import { createResource, For, Show } from "solid-js";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { docs, newDoc, setUpProject } from "../project";
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
				<Menu label="New document or plan" title="New document or plan" items={() => [
					{ label: "New document…", run: () => void newDoc() },
					{ label: "New plan…", run: () => void import("../commands").then((m) => m.runCommand("new-plan")) },
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
				<Group title="Docs" folder={state.project?.docs} group="docs" empty={settled() ? "No Markdown files here yet. Use ＋ to add one." : undefined} />
				<Group title="Schema" folder={state.project?.schema} group="schema" empty={settled() ? "No tables described yet. Add a Markdown file to this folder for each table." : undefined} />
				<Group title="Plans" folder={state.project?.plans} group="plans" empty={settled() ? "No plans yet. Use ＋ to draw one." : undefined} />
			</Rows>
		</div>
	);
}
