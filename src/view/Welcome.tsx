// Shown until a folder is open.
import { createResource, For, Show } from "solid-js";
import { backend, inApp } from "./backend";
import { ask } from "./dialogs";
import { openFolder, state } from "./state";

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
			<p class="hint">An SSL editor: text today, blocks and graph views to come, over one text.</p>
			<button class="primary" onClick={() => void open()}>
				Open folder…
			</button>
			<Show when={recent()?.length}>
				<h2>Recent</h2>
				<ul class="recent">
					<For each={recent()}>
						{(path) => (
							<li>
								<button class="link" onClick={() => void openFolder(path)}>
									{path.split("/").pop()} <span class="hint">{path}</span>
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
