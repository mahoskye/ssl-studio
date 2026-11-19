// Shown until a folder is open.
import { createResource, For, Show } from "solid-js";
import { backend, inApp } from "./backend";
import { ask } from "./dialogs";
import { openFolder, state } from "./state";
import { baseName } from "../shared/paths";
import { FileMark } from "./FileMark";

/** What a folder opens to, for someone who has not seen it: each view by its name, and what it is for. */
const VIEWS: readonly (readonly [name: string, what: string])[] = [
	["Text and Blocks", "A script as it is written, or as blocks to fold, move and edit. Either one changes the other."],
	["Call graph", "Which script calls which, folder by folder, down to the procedure."],
	["Plans", "A flow chart of what to build, checked against the code it becomes."],
	["Agent", "A model on your own machine by default. Every change is shown before it is kept."],
];
/** What can be done before a folder is open, beside opening one. */
const ALSO: readonly (readonly [id: string, label: string])[] = [
	["command-palette", "All commands"],
	["settings", "Settings"],
];

export function Welcome() {
	const [recent] = createResource(() => backend.recent());
	// commands.ts imports the editors, so it is loaded here when it is needed, not at the top.
	const [loaded] = createResource(() => import("./commands"));
	const keys = (id: string) => loaded()?.keysFor(id) ?? "";
	const open = async () => {
		if (inApp) return openFolder();
		const path = await ask("Folder to open (absolute path)");
		if (path) await openFolder(path);
	};
	return (
		<div class="welcome">
			<h1>SSL Studio</h1>
			<p class="hint">An SSL editor: text, blocks, a call graph and plans, all views of one text.</p>
			<div class="welcome-open">
				<button class="primary" onClick={() => void open()}>
					Open folder…
				</button>
				<Show when={keys("open-folder")}>
					<kbd>{keys("open-folder")}</kbd>
				</Show>
			</div>
			<Show when={recent()?.length}>
				<h2>Recent</h2>
				<ul class="recent">
					<For each={recent()}>
						{(path) => (
							<li>
								<button title={`Open ${path}`} onClick={() => void openFolder(path)}>
									<FileMark name={path} folder={{ open: false }} />
									<span class="recent-name">{baseName(path)}</span>
									{/* A long path keeps its end, which is the part that tells two folders apart. */}
									<span class="hint">
										<bdi>{path}</bdi>
									</span>
								</button>
							</li>
						)}
					</For>
				</ul>
			</Show>
			<h2>What a folder opens to</h2>
			<dl class="welcome-views">
				<For each={VIEWS}>
					{([name, what]) => (
						<div>
							<dt>{name}</dt>
							<dd>{what}</dd>
						</div>
					)}
				</For>
			</dl>
			<Show when={state.info && !state.info.lsp.ok}>
				<p class="warn">{state.info!.lsp.message}</p>
			</Show>
			<p class="welcome-also">
				<For each={ALSO}>
					{([id, label]) => (
						<button class="link" onClick={() => loaded()?.runCommand(id)}>
							{label}
							<Show when={keys(id)}>
								<kbd>{keys(id)}</kbd>
							</Show>
						</button>
					)}
				</For>
			</p>
		</div>
	);
}
