// Shown until a folder is open.
import { createResource, For, Show } from "solid-js";
import { backend, inApp } from "./backend";
import { ask } from "./dialogs";
import { openFolder, state } from "./state";
import { baseName } from "../shared/paths";
import { FileMark } from "./FileMark";

export function Welcome() {
	const [recent] = createResource(() => backend.recent());
	const open = async () => {
		if (inApp) return openFolder();
		const path = await ask("Folder to open (absolute path)");
		if (path) await openFolder(path);
	};
	return (
		<div class="welcome">
			<h1>SSL Studio</h1>
			<p class="hint">An SSL editor: text, blocks, a call graph and plans, all views of one text.</p>
			<button class="primary" onClick={() => void open()}>
				Open folder…
			</button>
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
			<Show when={state.info && !state.info.lsp.ok}>
				<p class="warn">{state.info!.lsp.message}</p>
			</Show>
		</div>
	);
}
