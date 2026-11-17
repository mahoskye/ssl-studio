// The project's documents in one place: README.md and AGENTS.md first,
// whether or not they exist yet, then the Markdown in the docs folder and the
// plans. Which folders those are comes from .ssl-studio/project.toml.
import { For, Show } from "solid-js";
import type { DocFile } from "../../shared/protocol";
import { docs, newDoc, setUpProject } from "../project";
import { activePath, canonical, openFile, setState, state } from "../state";

function Row(props: { file: DocFile }) {
	const open = () => (props.file.exists ? void openFile(props.file.path) : void setUpProject());
	return (
		<div
			class="tree-row doc-row"
			classList={{ selected: props.file.exists && activePath() === canonical(props.file.path), missing: !props.file.exists }}
			title={props.file.exists ? props.file.path : `${props.file.name} is missing. Click to create it.`}
			onClick={open}
		>
			<span class="label">{props.file.name}</span>
			<Show when={!props.file.exists}>
				<span class="meta warn">missing</span>
			</Show>
			<Show when={props.file.untouched}>
				<span class="meta warn" title="Still the template text: not written yet.">template</span>
			</Show>
		</div>
	);
}

function Group(props: { title: string; folder?: string; group: DocFile["group"]; empty?: string }) {
	const files = () => docs().filter((d) => d.group === props.group);
	return (
		<>
			<div class="group-head">
				{props.title} <Show when={props.folder}><span class="folder">{props.folder}/</span></Show>
			</div>
			<For each={files()}>{(file) => <Row file={file} />}</For>
			<Show when={!files().length && props.empty}>
				<p class="hint">{props.empty}</p>
			</Show>
		</>
	);
}

export function Docs() {
	return (
		<div class="panel-body">
			<div class="panel-title">
				<span>Docs</span>
				<button title="New document" onClick={() => void newDoc()}>
					＋
				</button>
				<button title="Refresh" onClick={() => setState("treeVersion", (v) => v + 1)}>
					⟳
				</button>
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
			<div class="tree">
				<Group title="Project" group="project" />
				<Group title="Docs" folder={state.project?.docs} group="docs" empty="No Markdown files here yet. Use ＋ to add one." />
				<Group title="Schema" folder={state.project?.schema} group="schema" empty="No tables described yet." />
				<Group title="Plans" folder={state.project?.plans} group="plans" empty="No plans yet. Run “New plan…” from the command palette." />
			</div>
		</div>
	);
}
