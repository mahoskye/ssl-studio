// File history: local save snapshots AND per-file Git commits (with proper chronological
// before->after diffs, commit-vs-parent diffs, snapshot-vs-snapshot compare, and restore in ReviewView).
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { baseName } from "../../shared/paths";
import type { GitCommit, Snapshot } from "../../shared/protocol";
import { backend } from "../backend";
import { openComparison, openReview } from "../editor/Review";
import { gitStatus, gitVersion } from "../git";
import { Icon } from "../Icon";
import { activeDoc, activePath, applyText, historyChanged, notify } from "../state";
import { chooseFromMenu, type RowMenuEntry } from "./RowMenu";
import { Row, RowGroup, Rows, type Point } from "./Rows";

type HistoryRev =
	| { kind: "snapshot"; id: string; time: number; label: string; key: string }
	| { kind: "commit"; sha: string; shortSha: string; time: number; subject: string; repoPath: string; label: string; key: string };

export function History() {
	const [version, setVersion] = createSignal(0);
	const [baseRev, setBaseRev] = createSignal<HistoryRev | null>(null);
	onCleanup(historyChanged.listen((path) => path === activePath() && setVersion((v) => v + 1)));
	createEffect(() => {
		activePath();
		setBaseRev(null);
	});
	const [history] = createResource(
		() => [activePath(), version()] as const,
		([path]) =>
			path
				? backend.history(path).then(
						(list) => ({ list, error: "" }),
						(e) => ({ list: [] as Snapshot[], error: String(e?.message ?? e) }),
					)
				: { list: [] as Snapshot[], error: "" },
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
	const shortTime = (time: number) => {
		const d = new Date(time);
		if (Number.isNaN(d.getTime())) return "";
		const now = new Date();
		const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
		const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
		return sameDay ? hm : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
	};
	const size = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

	const snapToRev = (snap: Snapshot): HistoryRev => ({
		kind: "snapshot",
		id: snap.id,
		time: snap.time,
		label: `Snapshot ${shortTime(snap.time)}`,
		key: `snap:${snap.id}`,
	});
	const commitToRev = (commit: GitCommit): HistoryRev => ({
		kind: "commit",
		sha: commit.sha,
		shortSha: commit.shortSha,
		time: commit.time,
		subject: commit.subject,
		repoPath: commit.path,
		label: commit.shortSha,
		key: `git:${commit.sha}`,
	});

	const loadRevText = async (path: string, rev: HistoryRev): Promise<string | null> => {
		if (rev.kind === "snapshot") {
			return backend.snapshot(path, rev.id);
		}
		return backend.gitShow(path, rev.sha, rev.repoPath);
	};

	/** Compares an older local snapshot (left) against the current editor buffer (right), with one-click Restore. */
	const showSnapshot = async (snap: Snapshot) => {
		const path = activePath();
		const doc = activeDoc();
		if (!path || !doc) return notify("Open the file again to see its snapshots.", "error");
		const revLabel = `Snapshot ${shortTime(snap.time)}`;
		try {
			const text = await backend.snapshot(path, snap.id);
			void openReview({
				title: `${revLabel} vs Current`,
				path,
				effect: "Left is the older snapshot; right is your current buffer. Restoring puts the snapshot into the editor as one undoable edit; nothing is saved until you save.",
				original: text,
				proposed: doc.model.getValue(),
				sides: { left: revLabel, right: "Current" },
				acceptSide: "original",
				language: doc.model.getLanguageId(),
				acceptLabel: "Restore this snapshot",
				rejectLabel: "Close",
				onAccept: (restored) => {
					applyText(path, restored);
					notify("Snapshot restored into the editor. Save to keep it; undo to go back.");
				},
			});
		} catch (e: any) {
			notify(`The snapshot of ${when(snap.time)} could not be opened: ${String(e?.message ?? e)}`, "error");
		}
	};

	/** Compares an older Git commit (left) against the current editor buffer (right), with one-click Restore. */
	const showCommitVsCurrent = async (commit: GitCommit) => {
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
				effect: `Left is commit ${commit.shortSha}; right is your current buffer. Restoring puts ${commit.shortSha} into the editor as one undoable edit; nothing is saved until you save.`,
				original: historical,
				proposed: doc.model.getValue(),
				sides: { left: commit.shortSha, right: "Current" },
				acceptSide: "original",
				language: doc.model.getLanguageId(),
				acceptLabel: `Restore ${commit.shortSha}`,
				rejectLabel: "Close",
				onAccept: (restored) => {
					applyText(path, restored);
					notify(`Restored ${baseName(path)} from ${commit.shortSha} into the editor. Save to keep it; undo to go back.`);
				},
			});
		} catch (e: any) {
			notify(`Could not load commit ${commit.shortSha}: ${String(e?.message ?? e)}`, "error");
		}
	};

	/** Opens what a single Git commit changed (`sha~1` on left vs `sha` on right). */
	const showCommitDiff = async (commit: GitCommit) => {
		const path = activePath();
		const doc = activeDoc();
		if (!path || !doc) return notify("Open the file again to inspect its Git history.", "error");
		try {
			const { before, after } = await backend.gitCommitFile(path, commit.sha, commit.path);
			if (before === null && after === null) {
				notify(`Could not read text diff for ${baseName(path)} at commit ${commit.shortSha}.`, "error");
				return;
			}
			void openComparison({
				title: `${commit.shortSha}: ${commit.subject}`,
				path,
				before: before ?? "",
				after: after ?? "",
				beforeLabel: before === null ? "(not in parent)" : `${commit.shortSha}~1`,
				afterLabel: after === null ? "(deleted)" : commit.shortSha,
				language: doc.model.getLanguageId(),
				effect: `Changes introduced by commit ${commit.shortSha} (${shortDay(commit.time)}). Nothing here changes the file.`,
			});
		} catch (e: any) {
			notify(`Could not load diff for commit ${commit.shortSha}: ${String(e?.message ?? e)}`, "error");
		}
	};

	/** Compares any two selected snapshots or Git commits chronologically (older on left, newer on right). */
	const compareTwoRevs = async (a: HistoryRev, b: HistoryRev) => {
		const path = activePath();
		const doc = activeDoc();
		if (!path || !doc) return notify("Open the file again to compare revisions.", "error");
		if (a.key === b.key) return notify("Choose a different revision to compare with.");
		const [older, newer] = a.time <= b.time ? [a, b] : [b, a];
		try {
			const [before, after] = await Promise.all([loadRevText(path, older), loadRevText(path, newer)]);
			if (before === null || after === null) {
				notify(`Could not read both revisions (${older.label} and ${newer.label}) as text.`, "error");
				return;
			}
			setBaseRev(null);
			void openComparison({
				title: `${older.label} vs ${newer.label}`,
				path,
				before,
				after,
				beforeLabel: older.label,
				afterLabel: newer.label,
				language: doc.model.getLanguageId(),
				effect: `Comparing ${older.label} (older) with ${newer.label} (newer). Nothing here changes the file.`,
			});
		} catch (e: any) {
			notify(`Could not compare ${older.label} and ${newer.label}: ${String(e?.message ?? e)}`, "error");
		}
	};

	const compareBaseWithCurrent = () => {
		const base = baseRev();
		if (!base) return;
		setBaseRev(null);
		if (base.kind === "snapshot") {
			const snap = snapshots().find((s) => s.id === base.id);
			if (snap) void showSnapshot(snap);
		} else {
			const commit = gitCommits().find((c) => c.sha === base.sha);
			if (commit) void showCommitVsCurrent(commit);
		}
	};

	const openSnapshotMenu = async (snap: Snapshot, at: Point) => {
		const rev = snapToRev(snap);
		const base = baseRev();
		const CMP_CURRENT = "Compare with current";
		const CMP_BASE = base && base.key !== rev.key ? `Compare with ${base.label}` : "";
		const SET_BASE = base?.key === rev.key ? "Clear compare base" : "Compare with… (select as base)";
		const entries: RowMenuEntry[] = [
			CMP_CURRENT,
			...(CMP_BASE ? [CMP_BASE] : []),
			"separator",
			SET_BASE,
		];
		const picked = await chooseFromMenu(rev.label, entries, at);
		if (picked === CMP_CURRENT) void showSnapshot(snap);
		else if (CMP_BASE && picked === CMP_BASE && base) void compareTwoRevs(base, rev);
		else if (picked === SET_BASE) setBaseRev(base?.key === rev.key ? null : rev);
	};

	const openCommitMenu = async (commit: GitCommit, at: Point) => {
		const rev = commitToRev(commit);
		const base = baseRev();
		const COMMIT_DIFF = `View commit diff (${commit.shortSha}~1..${commit.shortSha})`;
		const CMP_CURRENT = "Compare with current";
		const CMP_BASE = base && base.key !== rev.key ? `Compare with ${base.label}` : "";
		const SET_BASE = base?.key === rev.key ? "Clear compare base" : "Compare with… (select as base)";
		const entries: RowMenuEntry[] = [
			COMMIT_DIFF,
			CMP_CURRENT,
			...(CMP_BASE ? [CMP_BASE] : []),
			"separator",
			SET_BASE,
		];
		const picked = await chooseFromMenu(`${commit.shortSha}: ${commit.subject}`, entries, at);
		if (picked === COMMIT_DIFF) void showCommitDiff(commit);
		else if (picked === CMP_CURRENT) void showCommitVsCurrent(commit);
		else if (CMP_BASE && picked === CMP_BASE && base) void compareTwoRevs(base, rev);
		else if (picked === SET_BASE) setBaseRev(base?.key === rev.key ? null : rev);
	};

	return (
		<div class="panel-body" data-panel="history">
			<div class="panel-title">
				<span>History</span>
			</div>
			<Show when={activePath()} fallback={<p class="hint">No file open. Open a file to see its local snapshots and Git commit history.</p>}>
				<p class="hint">Local snapshots are kept on every save; Git commits show committed revisions. Click an entry to diff against Current, or right-click for commit diff and Compare with…</p>
				<Show when={baseRev()}>
					{(base) => (
						<div
							role="status"
							style={{
								display: "flex",
								"flex-wrap": "wrap",
								"align-items": "center",
								gap: "var(--space-2)",
								margin: "0 var(--space-4) var(--space-3)",
								padding: "var(--space-2) var(--space-3)",
								border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
								"border-radius": "var(--radius-sm)",
								background: "color-mix(in srgb, var(--accent) 10%, transparent)",
								"font-size": "var(--text-xs)",
							}}
						>
							<Icon name="split-horizontal" />
							<span style={{ flex: 1, "min-width": 0 }}>
								Base: <strong>{base().label}</strong> — choose another revision
							</span>
							<button type="button" class="link" style={{ padding: 0, "font-size": "var(--text-xs)" }} onClick={compareBaseWithCurrent}>
								vs Current
							</button>
							<button type="button" class="link" style={{ padding: 0, "font-size": "var(--text-xs)" }} onClick={() => setBaseRev(null)}>
								Cancel
							</button>
						</div>
					)}
				</Show>
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
									{(snap) => {
										const rev = () => snapToRev(snap);
										const isBase = () => baseRev()?.key === rev().key;
										return (
											<Row
												class="tree-row git-row"
												key={rev().key}
												selected={isBase()}
												title={`Snapshot of ${when(snap.time)}, ${size(snap.size)}. Click to compare against Current; right-click to select as Compare base.`}
												onActivate={() => void showSnapshot(snap)}
												onMenu={(at) => void openSnapshotMenu(snap, at)}
											>
												<span class="snap-dot" aria-hidden="true" />
												<span class="label">{when(snap.time)}</span>
												<Show when={isBase()}>
													<span class="meta" style={{ color: "var(--accent)", "font-weight": 600 }}>Base</span>
												</Show>
												<span
													class="git-acts"
													style={baseRev() && !isBase() ? { display: "inline-flex" } : undefined}
													onClick={(e) => e.stopPropagation()}
												>
													<Show
														when={baseRev() && !isBase()}
														fallback={
															<button
																type="button"
																tabindex={-1}
																title={isBase() ? "Clear compare base" : "Compare with… (select as base)"}
																aria-label={isBase() ? "Clear compare base" : `Select ${rev().label} as compare base`}
																onClick={() => setBaseRev(isBase() ? null : rev())}
															>
																<Icon name={isBase() ? "close" : "pin"} />
															</button>
														}
													>
														<button
															type="button"
															class="link"
															tabindex={-1}
															style={{ padding: "0 var(--space-1)", "font-size": "var(--text-xs)" }}
															title={`Compare ${baseRev()!.label} with ${rev().label}`}
															onClick={() => void compareTwoRevs(baseRev()!, rev())}
														>
															Compare
														</button>
													</Show>
												</span>
												<span class="meta">{size(snap.size)}</span>
											</Row>
										);
									}}
								</For>
							</RowGroup>
						</Show>
						<Show when={gitCommits().length}>
							<RowGroup fold="history:git" label="Git commits" count={gitCommits().length} head={<span class="label">Git commits</span>} rows={true}>
								<For each={gitCommits()}>
									{(commit) => {
										const rev = () => commitToRev(commit);
										const isBase = () => baseRev()?.key === rev().key;
										return (
											<Row
												class="tree-row git-row"
												key={rev().key}
												selected={isBase()}
												title={`${commit.shortSha} · ${commit.subject}\n${commit.author ? `${commit.author} · ` : ""}${when(commit.time)}\nClick to compare with Current; right-click for commit diff (${commit.shortSha}~1..${commit.shortSha}) or Compare with…`}
												onActivate={() => void showCommitVsCurrent(commit)}
												onMenu={(at) => void openCommitMenu(commit, at)}
											>
												<Icon name="git-branch" class="icon" />
												<span class="label">{commit.subject || commit.shortSha}</span>
												<Show when={isBase()}>
													<span class="meta" style={{ color: "var(--accent)", "font-weight": 600 }}>Base</span>
												</Show>
												<span
													class="git-acts"
													style={baseRev() && !isBase() ? { display: "inline-flex" } : undefined}
													onClick={(e) => e.stopPropagation()}
												>
													<Show
														when={baseRev() && !isBase()}
														fallback={
															<>
																<button
																	type="button"
																	tabindex={-1}
																	title={`View commit diff (${commit.shortSha}~1..${commit.shortSha})`}
																	aria-label={`View commit diff for ${commit.shortSha}`}
																	onClick={() => void showCommitDiff(commit)}
																>
																	<Icon name="split-horizontal" />
																</button>
																<button
																	type="button"
																	tabindex={-1}
																	title={isBase() ? "Clear compare base" : "Compare with… (select as base)"}
																	aria-label={isBase() ? "Clear compare base" : `Select ${commit.shortSha} as compare base`}
																	onClick={() => setBaseRev(isBase() ? null : rev())}
																>
																	<Icon name={isBase() ? "close" : "pin"} />
																</button>
															</>
														}
													>
														<button
															type="button"
															class="link"
															tabindex={-1}
															style={{ padding: "0 var(--space-1)", "font-size": "var(--text-xs)" }}
															title={`Compare ${baseRev()!.label} with ${commit.shortSha}`}
															onClick={() => void compareTwoRevs(baseRev()!, rev())}
														>
															Compare
														</button>
													</Show>
												</span>
												<span class="meta">
													{commit.shortSha} · {shortDay(commit.time)}
												</span>
											</Row>
										);
									}}
								</For>
							</RowGroup>
						</Show>
					</Rows>
				</Show>
			</Show>
		</div>
	);
}
