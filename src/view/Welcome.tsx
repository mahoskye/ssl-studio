// Shown until a folder is open.
import { createResource, For, Show } from "solid-js";
import { backend, inApp } from "./backend";
import { ask } from "./dialogs";
import { canonical, openFolder, setState, state } from "./state";
import { baseName } from "../shared/paths";
import { FileMark } from "./FileMark";

/** What a folder opens to, for someone who has not seen it: each view by its name, and what it is for. */
const VIEWS: readonly (readonly [name: string, what: string])[] = [
	["Text and Blocks", "A script as it is written, or as blocks to fold, move and edit. Either one changes the other."],
	["Docs and Tickets", "Tickets, specs, decisions, schema tables, and registries linked straight to your scripts."],
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
			<p class="hint">An SSL workspace: code, blocks, docs & tickets, a call graph and plans, all grounded in plain text.</p>
			<div class="welcome-open">
				<button class="primary" onClick={() => void open()}>
					Open folder…
				</button>
				<Show when={state.workspace}>
					<button onClick={() => setState("centerView", "editors")}>
						Return to {state.workspace!.name}
					</button>
				</Show>
				<Show when={keys("open-folder")}>
					<kbd>{keys("open-folder")}</kbd>
				</Show>
			</div>
			<Show when={recent()?.length}>
				<h2>Recent</h2>
				<ul class="recent">
					<For each={recent()}>
						{(path) => {
							const current = () => Boolean(state.workspace && canonical(state.workspace.root) === canonical(path));
							return (
								<li>
									<button
										title={current() ? `Return to ${path}` : `Open ${path}`}
										onClick={() => (current() ? setState("centerView", "editors") : void openFolder(path))}
									>
										<FileMark name={path} folder={{ open: current() }} />
										<span class="recent-name">{baseName(path)}</span>
										<Show when={current()}>
											<span class="recent-current">Open now</span>
										</Show>
										{/* A long path keeps its end, which is the part that tells two folders apart. */}
										<span class="hint">
											<bdi>{path}</bdi>
										</span>
									</button>
								</li>
							);
						}}
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
