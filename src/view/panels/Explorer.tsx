// The workspace tree, loaded a folder at a time, with a size badge on files
// near or over the ceiling (program decision 0006).
import { createResource, createSignal, For, Show } from "solid-js";
import type { Entry } from "../../shared/protocol";
import { level } from "../../shared/houseStyle";
import { backend } from "../backend";
import { ask, choose } from "../dialogs";
import { activePath, canonical, notify, openFile, setState, state } from "../state";
import { baseName, dirName, joinPath } from "../../shared/paths";

const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
const toggle = (path: string) =>
	setExpanded((set) => {
		const next = new Set(set);
		next.has(path) ? next.delete(path) : next.add(path);
		return next;
	});

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

function Folder(props: { path: string; depth: number }) {
	const [entries] = createResource(
		() => [props.path, state.treeVersion] as const,
		([path]) => backend.list(path).catch(() => [] as Entry[]),
	);
	return (
		<For each={entries()}>
			{(entry) => (
				<>
					<div
						class="tree-row"
						classList={{ selected: activePath() === canonical(entry.path) }}
						style={{ "padding-left": `${8 + props.depth * 14}px` }}
						title={entry.path}
						onClick={() => (entry.kind === "dir" ? toggle(entry.path) : void openFile(entry.path))}
						onContextMenu={(e) => {
							e.preventDefault();
							void entryMenu(entry);
						}}
					>
						<span class="twisty">{entry.kind === "dir" ? (expanded().has(entry.path) ? "▾" : "▸") : ""}</span>
						<span class="label">{entry.name}</span>
						<Show when={entry.kind === "file" && level(entry.size, state.settings.limits.bytes) !== "ok"}>
							<span class={`badge ${level(entry.size, state.settings.limits.bytes)}`} title={`Size ceiling ${kb(state.settings.limits.bytes)} (decision 0006)`}>
								{kb(entry.size)}
							</span>
						</Show>
					</div>
					<Show when={entry.kind === "dir" && expanded().has(entry.path)}>
						<Folder path={entry.path} depth={props.depth + 1} />
					</Show>
				</>
			)}
		</For>
	);
}

async function entryMenu(entry: Entry) {
	const action = await choose(entry.name, entry.kind === "dir" ? ["New file", "New folder", "Rename", "Delete"] : ["Rename", "Delete"]);
	const parent = entry.kind === "dir" ? entry.path : dirName(entry.path);
	try {
		if (action === "New file" || action === "New folder") {
			const name = await ask(`${action} in ${baseName(parent)}`);
			if (!name) return;
			await backend.create(joinPath(parent, name), action === "New file" ? "file" : "dir");
			setExpanded((set) => new Set(set).add(parent));
			if (action === "New file") void openFile(joinPath(parent, name));
		} else if (action === "Rename") {
			const name = await ask(`Rename ${entry.name}`, entry.name);
			if (!name || name === entry.name) return;
			await backend.rename(entry.path, joinPath(dirName(entry.path), name));
		} else if (action === "Delete") {
			if ((await choose(`Move ${entry.name} to the trash?`, ["Move to trash"])) !== "Move to trash") return;
			await backend.trash(entry.path);
		} else return;
		setState("treeVersion", (v) => v + 1);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

export function Explorer() {
	return (
		<div class="panel-body">
			<div class="panel-title">
				<span>{state.workspace?.name}</span>
				<button title="New file" onClick={() => state.workspace && void entryMenu({ name: state.workspace.name, path: state.workspace.root, kind: "dir", size: 0 })}>
					＋
				</button>
				<button title="Refresh" onClick={() => setState("treeVersion", (v) => v + 1)}>
					⟳
				</button>
			</div>
			<div class="tree" role="tree">
				<Show when={state.workspace}>{(ws) => <Folder path={ws().root} depth={0} />}</Show>
			</div>
		</div>
	);
}
