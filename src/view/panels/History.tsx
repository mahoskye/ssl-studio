// File history: local save snapshots AND per-file Git commits (with diff & restore in ReviewView).
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { GitCommit, Snapshot } from "../../shared/protocol";
import { backend } from "../backend";
import { openReview } from "../editor/Review";
import { gitStatus, gitVersion } from "../git";
import { activeDoc, activePath, applyText, historyChanged, notify } from "../state";
import { baseName } from "../../shared/paths";
import { Icon } from "../Icon";
import { Row, RowGroup, Rows } from "./Rows";

export function History() {
	const [version, setVersion] = createSignal(0);
	onCleanup(historyChanged.listen((path) => path === activePath() && setVersion((v) => v + 1)));
	const [history] = createResource(
		() => [activePath(), version()] as const,
		([path]) => (path ? backend.history(path).then((list) => ({ list, error: "" }), (e) => ({ list: [] as Snapshot[], error: String(e?.message ?? e) })) : { list: [] as Snapshot[], error: "" }),
	);
	const [commits] = createResource(
		() => [activePath(), gitVersion(), Boolean(gitStatus())] as const,
		([path, , inRepo]) =>
			path && inRepo && !path.startsWith("untitled:")
				? backend.gitLog(path, 25).catch(() => [] as GitCommit[])
				: Promise.resolve([] as GitCommit[]),
	);
	const snapshots = () => history()?.list ?? [];
	const gitCommits = () => commits() ?? [];
	const when = (time: number) => new Date(time).toLocaleString();
	const shortDay = (time: number) => new Date(time).toLocaleDateString();
	const size = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

	const showSnapshot = async (id: string, time: number) => {
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

	const showCommit = async (commit: GitCommit) => {
		const path = activePath();
		const doc = activeDoc();
		if (!path || !doc) return notify("Open the file again to inspect its Git history.", "error");
		try {
			const historical = await backend.gitShow(path, commit.sha, commit.path);
			if (historical === null) {
				notify(`Could not read ${baseName(path)} at commit ${commit.shortSha}.`, "error");
				return;
			}
			void openReview({
				title: `${commit.shortSha}: ${commit.subject} (${shortDay(commit.time)})`,
				path,
				effect: `Restoring puts commit ${commit.shortSha}'s text into the editor as one undoable edit (you can edit the right side before accepting); nothing is saved until you save.`,
				original: doc.model.getValue(),
				proposed: historical,
				language: doc.model.getLanguageId(),
				acceptLabel: `Restore ${commit.shortSha}`,
				onAccept: (restored) => {
					applyText(path, restored);
					notify(`Restored ${baseName(path)} from ${commit.shortSha} into the editor. Save to keep it; undo to go back.`);
				},
			});
		} catch (e: any) {
			notify(`Could not load commit ${commit.shortSha}: ${String(e?.message ?? e)}`, "error");
		}
	};

	return (
		<div class="panel-body" data-panel="history">
			<div class="panel-title">
				<span>History</span>
			</div>
			<Show when={activePath()} fallback={<p class="hint">No file open. Open a file to see its local snapshots and Git commit history.</p>}>
				<p class="hint">Local snapshots are kept on every save; Git commits show committed revisions. Click any entry to compare it with the editor.</p>
				<Show when={history()?.error}>
					<p class="hint warn" role="alert">
						The snapshots of {baseName(activePath()!)} could not be read: {history()!.error}
					</p>
				</Show>
				<Show when={snapshots().length || gitCommits().length} fallback={<p class="hint">{history.loading || commits.loading ? "Reading history…" : `No local snapshots or Git commits for ${baseName(activePath()!)} yet.`}</p>}>
					<Rows role="listbox" label={`History of ${baseName(activePath()!)}`}>
						<Show when={snapshots().length}>
							<RowGroup fold="history:local" label="Local snapshots" count={snapshots().length} head={<span class="label">Local snapshots</span>} rows={true}>
								<For each={snapshots()}>
									{(snap) => (
										<Row key={`snap:${snap.id}`} title={`Snapshot of ${when(snap.time)}, ${size(snap.size)}. Click, or press Enter, to compare it with the editor.`} onActivate={() => void showSnapshot(snap.id, snap.time)}>
											<span class="snap-dot" aria-hidden="true" />
											<span class="label">{when(snap.time)}</span>
											<span class="meta">{size(snap.size)}</span>
										</Row>
									)}
								</For>
							</RowGroup>
						</Show>
						<Show when={gitCommits().length}>
							<RowGroup fold="history:git" label="Git commits" count={gitCommits().length} head={<span class="label">Git commits</span>} rows={true}>
								<For each={gitCommits()}>
									{(commit) => (
										<Row
											key={`git:${commit.sha}`}
											title={`${commit.shortSha} · ${commit.subject}\n${commit.author ? `${commit.author} · ` : ""}${when(commit.time)}\nClick to diff against the current file.`}
											onActivate={() => void showCommit(commit)}
										>
											<Icon name="git-branch" class="icon" />
											<span class="label">{commit.subject || commit.shortSha}</span>
											<span class="meta">{commit.shortSha} · {shortDay(commit.time)}</span>
										</Row>
									)}
								</For>
							</RowGroup>
						</Show>
					</Rows>
				</Show>
			</Show>
		</div>
	);
}
