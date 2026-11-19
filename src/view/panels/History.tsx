// Local history of the current file: a snapshot per save, with diff and restore.
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { Snapshot } from "../../shared/protocol";
import { backend } from "../backend";
import { openReview } from "../editor/Review";
import { activeDoc, activePath, applyText, historyChanged, notify } from "../state";
import { baseName } from "../../shared/paths";
import { Row, Rows } from "./Rows";

export function History() {
	const [version, setVersion] = createSignal(0);
	onCleanup(historyChanged.listen((path) => path === activePath() && setVersion((v) => v + 1)));
	const [history] = createResource(
		() => [activePath(), version()] as const,
		([path]) => (path ? backend.history(path).then((list) => ({ list, error: "" }), (e) => ({ list: [] as Snapshot[], error: String(e?.message ?? e) })) : { list: [] as Snapshot[], error: "" }),
	);
	const snapshots = () => history()?.list ?? [];
	const when = (time: number) => new Date(time).toLocaleString();
	const size = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
	const show = async (id: string, time: number) => {
		const path = activePath();
		const doc = activeDoc();
		if (!path || !doc) return notify("Open the file again to see its snapshots.", "error");
		try {
			const text = await backend.snapshot(path, id);
			void openReview({
				title: `Snapshot ${when(time)}`,
				path,
				effect: "Restoring puts the snapshot's text in the editor as one undoable edit; nothing is saved until you save.",
				original: doc.model.getValue(),
				proposed: text,
				language: doc.model.getLanguageId(),
				acceptLabel: "Restore this snapshot",
				onAccept: (restored) => {
					applyText(path, restored);
					notify("Snapshot restored into the editor. Save to keep it; undo to go back.");
				},
			});
		} catch (e: any) {
			notify(`The snapshot of ${when(time)} could not be opened: ${String(e?.message ?? e)}`, "error");
		}
	};
	return (
		<div class="panel-body" data-panel="history">
			<div class="panel-title">
				<span>Local history</span>
			</div>
			<Show when={activePath()} fallback={<p class="hint">No file open. Open a file to see the snapshots kept of it.</p>}>
				<p class="hint">A snapshot is kept on every save that changes the file, outside the workspace. Click one, or press Enter on it, to compare it with the editor and restore it.</p>
				<Show when={history()?.error}>
					<p class="hint warn" role="alert">
						The snapshots of {baseName(activePath()!)} could not be read: {history()!.error}
					</p>
				</Show>
				<Show when={!history()?.error && !snapshots().length}>
					<p class="hint">{history.loading ? "Reading the snapshots…" : `No snapshots of ${baseName(activePath()!)} yet. The first is kept when you save a change to it.`}</p>
				</Show>
				{/* A list with nothing in it is not drawn: it would take the keyboard and show an empty frame. */}
				<Show when={snapshots().length}>
					<Rows role="listbox" label={`Snapshots of ${baseName(activePath()!)}`}>
						<For each={snapshots()}>
							{(snap) => (
								<Row key={snap.id} title={`Snapshot of ${when(snap.time)}, ${size(snap.size)}. Click, or press Enter, to compare it with the editor.`} onActivate={() => void show(snap.id, snap.time)}>
									<span class="snap-dot" aria-hidden="true" />
									<span class="label">{when(snap.time)}</span>
									<span class="meta">{size(snap.size)}</span>
								</Row>
							)}
						</For>
					</Rows>
				</Show>
			</Show>
		</div>
	);
}
