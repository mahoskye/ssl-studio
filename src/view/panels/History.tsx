// Local history of the current file: a snapshot per save, with diff and restore.
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { backend } from "../backend";
import { activePath, historyChanged, setState, state } from "../state";

export function History() {
	const [version, setVersion] = createSignal(0);
	onCleanup(historyChanged.listen((path) => path === activePath() && setVersion((v) => v + 1)));
	const [snapshots] = createResource(
		() => [activePath(), version()] as const,
		([path]) => (path ? backend.history(path) : Promise.resolve([])),
	);
	const when = (time: number) => new Date(time).toLocaleString();
	return (
		<div class="panel-body">
			<div class="panel-title">
				<span>Local history</span>
			</div>
			<Show when={activePath()} fallback={<p class="hint">No file open.</p>}>
				<p class="hint">A snapshot is kept on every save that changes the file, outside the workspace.</p>
				<div class="tree">
					<For each={snapshots() ?? []} fallback={<p class="hint">No snapshots yet.</p>}>
						{(snap) => (
							<div
								class="tree-row"
								classList={{ selected: state.diffWith?.id === snap.id }}
								onClick={async () => {
									const path = activePath()!;
									setState("diffWith", { path, id: snap.id, text: await backend.snapshot(path, snap.id) });
								}}
							>
								<span class="label">{when(snap.time)}</span>
								<span class="meta">{Math.max(1, Math.round(snap.size / 1024))} KB</span>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}
