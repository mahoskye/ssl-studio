// Local history of the current file: a snapshot per save, with diff and restore.
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { backend } from "../backend";
import { openReview } from "../editor/Review";
import { activeDoc, activePath, applyText, historyChanged, notify } from "../state";

export function History() {
	const [version, setVersion] = createSignal(0);
	onCleanup(historyChanged.listen((path) => path === activePath() && setVersion((v) => v + 1)));
	const [snapshots] = createResource(
		() => [activePath(), version()] as const,
		([path]) => (path ? backend.history(path) : Promise.resolve([])),
	);
	const when = (time: number) => new Date(time).toLocaleString();
	const show = async (id: string, time: number) => {
		const path = activePath()!;
		const doc = activeDoc()!;
		const text = await backend.snapshot(path, id);
		openReview({
			title: `Snapshot ${when(time)}`,
			original: doc.model.getValue(),
			proposed: text,
			language: doc.model.getLanguageId(),
			acceptLabel: "Restore this snapshot",
			onAccept: (restored) => {
				applyText(path, restored);
				notify("Snapshot restored into the editor. Save to keep it; undo to go back.");
			},
		});
	};
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
							<div class="tree-row" onClick={() => void show(snap.id, snap.time)}>
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
