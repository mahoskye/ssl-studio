// File history: VS Code-aligned unified chronological Timeline combining SQLite
// local snapshots and per-file Git commits, with checkpoints/pinning, ADR 0050
// header funnel filtering, storage stats, and an interactive Time-Travel Scrubber
// for live Step-diff and vs-Current playback inside ReviewView (ADR 0052).
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { baseName, isInside } from "../../shared/paths";
import type { GitCommit, HistoryStats, Snapshot } from "../../shared/protocol";
import { createAsyncQuery } from "../asyncQuery";
import { backend } from "../backend";
import { ask, choose } from "../dialogs";
import { closeReview, openComparison, openReview, review } from "../editor/Review";
import { gitStatus, gitVersion, refreshGit } from "../git";
import { Icon } from "../Icon";
import { Menu, type MenuItem } from "../Menu";
import { activeDoc, activePath, applyText, documents, historyChanged, notify, state } from "../state";
import {
	filterHistoryTimeline,
	filterLabel,
	formatByteSize,
	formatLineDelta,
	formatRelativeTime,
	formatStorageSummary,
	formatWorkspaceStorageSummary,
	groupTimelineByDay,
	mergeHistoryTimeline,
	scrubberChronological,
	sourceSubtitle,
	sourceTitle,
	type ScrubMode,
	type TimelineFilter,
	type TimelineItem,
} from "./historyTimeline";
import { chooseFromMenu, type RowMenuEntry } from "./RowMenu";
import { Row, Rows, type Point } from "./Rows";

/** A row with the file it was loaded for: what the row does, it does to that file. */
type Loaded<T> = T & { forPath: string };

type HistoryRev =
	| { kind: "snapshot"; id: string; time: number; label: string; key: string; forPath: string }
	| { kind: "commit"; sha: string; shortSha: string; time: number; subject: string; repoPath: string; label: string; key: string; forPath: string };

/** Whether what was loaded for one file may be shown, or acted on, while `activePath` is the file on screen. */
export function stillFor(loadedPath: string | null | undefined, activePath: string | null | undefined): boolean {
	return Boolean(loadedPath) && loadedPath === activePath;
}

/**
 * The rows to show for the file on screen: the ones loaded for it, and none while the last ones loaded are still
 * another file's. Those stayed on screen until the new file's had been read, and a click on one read the other
 * file's commit and offered it as this file's text to restore.
 */
export function rowsFor<T>(loaded: { path: string; rows: T[] } | undefined, activePath: string | null | undefined): T[] {
	return loaded && stillFor(loaded.path, activePath) ? loaded.rows : [];
}

export function History() {
	const [version, setVersion] = createSignal(0);
	const [baseRev, setBaseRev] = createSignal<HistoryRev | null>(null);
	const [filter, setFilter] = createSignal<TimelineFilter>("all");
	const [scrubMode, setScrubMode] = createSignal<ScrubMode>("step");
	/** Key of the revision currently displayed by the Time-Travel Scrubber, or "current" when comparing latest -> Current, or null when idle. */
	const [scrubKey, setScrubKey] = createSignal<string | null>(null);
	const [scrubBusy, setScrubBusy] = createSignal(false);

	let listEl: HTMLDivElement | undefined;
	let scrubTimer: ReturnType<typeof setTimeout> | null = null;
	let scrubSeq = 0;
	let ownReviewOpen = false;
	const revCache = new Map<string, string>();

	const clearScrubTimer = () => {
		if (scrubTimer !== null) {
			clearTimeout(scrubTimer);
			scrubTimer = null;
		}
	};

	onCleanup(() => {
		clearScrubTimer();
		revCache.clear();
	});

	onSettled(() => {
		const off = historyChanged.listen((path) => path === activePath() && setVersion((v) => v + 1));
		return () => {
			off();
		};
	});

	const currentPath = createMemo(() => activePath());
	const isWorkspaceFile = createMemo(() => {
		const path = currentPath();
		const root = state.workspace?.root ?? "";
		return Boolean(path && !path.startsWith("untitled:") && Boolean(root && isInside(root, path)));
	});

	createEffect(
		() => currentPath(),
		() => {
			clearScrubTimer();
			scrubSeq++;
			ownReviewOpen = false;
			setBaseRev(null);
			setScrubKey(null);
			setScrubBusy(false);
			revCache.clear();
		},
	);

	// Clear active scrubber highlight if the user closes ReviewView directly.
	createEffect(
		() => review(),
		(open) => {
			if (!open && ownReviewOpen) {
				ownReviewOpen = false;
				setScrubKey(null);
			}
		},
	);

	const [history] = createAsyncQuery(
		() => [activePath(), version(), state.workspace?.root ?? ""] as const,
		([path, , root]): Promise<{ path: string; rows: Loaded<Snapshot>[]; error: string }> | { path: string; rows: Loaded<Snapshot>[]; error: string } =>
			path && !path.startsWith("untitled:") && Boolean(root && isInside(root, path))
				? backend.history(path).then(
						(list) => ({ path, rows: list.map((snap): Loaded<Snapshot> => ({ ...snap, forPath: path })), error: "" }),
						(e) => ({ path, rows: [] as Loaded<Snapshot>[], error: String(e?.message ?? e) }),
					)
				: { path: path ?? "", rows: [] as Loaded<Snapshot>[], error: "" },
	);

	const [commits] = createAsyncQuery(
		() => [activePath(), gitVersion(), Boolean(gitStatus()), state.workspace?.root ?? ""] as const,
		([path, , inRepo, root]): Promise<{ path: string; rows: Loaded<GitCommit>[] }> | { path: string; rows: Loaded<GitCommit>[] } =>
			path && inRepo && !path.startsWith("untitled:") && Boolean(root && isInside(root, path))
				? backend.gitLog(path, 50).then(
						(list) => ({ path, rows: list.map((commit): Loaded<GitCommit> => ({ ...commit, forPath: path })) }),
						() => ({ path, rows: [] as Loaded<GitCommit>[] }),
					)
				: { path: path ?? "", rows: [] as Loaded<GitCommit>[] },
	);

	const [stats] = createAsyncQuery(
		() => [activePath(), version(), state.workspace?.root ?? ""] as const,
		([path, , root]): Promise<{ path: string; data: HistoryStats | null }> | { path: string; data: HistoryStats | null } =>
			root
				? backend
						.historyStats(path && !path.startsWith("untitled:") && isInside(root, path) ? path : undefined)
						.then(
							(data) => ({ path: path ?? "", data }),
							() => ({ path: path ?? "", data: null }),
						)
				: { path: path ?? "", data: null },
	);

	// What is loaded is shown only while it is the open file's: the moment another file is opened there are no rows.
	const snapshots = () => rowsFor(history(), activePath());
	const gitCommits = () => rowsFor(commits(), activePath());
	const historyError = () => (stillFor(history()?.path, activePath()) ? history()!.error : "");
	const activeStats = () => (stats()?.path === (activePath() ?? "") ? stats()!.data : null);
	const reading = () => history.loading || commits.loading || history()?.path !== (activePath() ?? "") || commits()?.path !== (activePath() ?? "");

	const allTimeline = createMemo(() => mergeHistoryTimeline(snapshots(), gitCommits()));
	const visibleTimeline = createMemo(() => filterHistoryTimeline(allTimeline(), filter()));
	const dayGroups = createMemo(() => groupTimelineByDay(visibleTimeline()));
	/** Oldest -> newest list used by the Time-Travel Scrubber. */
	const chronological = createMemo(() => scrubberChronological(visibleTimeline()));

	/** Current numeric slider value: 0..N-1 = revision index, N = Current. */
	const scrubberIndex = createMemo(() => {
		const list = chronological();
		const key = scrubKey();
		if (!key || key === "current") return list.length;
		const idx = list.findIndex((item) => item.key === key);
		return idx >= 0 ? idx : list.length;
	});

	const activeScrubItem = createMemo(() => {
		const list = chronological();
		const idx = scrubberIndex();
		return idx >= 0 && idx < list.length ? list[idx]! : null;
	});

	/** The file a row acts on: the one it was loaded for. A row of another file's history does nothing but say so. */
	const fileOf = (row: { forPath: string }): string | null => {
		if (stillFor(row.forPath, activePath())) return row.forPath;
		notify(`That entry is from the history of ${baseName(row.forPath)}, which is not the file that is open now.`);
		return null;
	};

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
	const size = (bytes: number) => formatByteSize(bytes);

	const snapToRev = (snap: Loaded<Snapshot>): HistoryRev => ({
		kind: "snapshot",
		id: snap.id,
		time: snap.time,
		label: snap.label?.trim() ? `${snap.label.trim()} (${shortTime(snap.time)})` : `${sourceTitle(snap)} ${shortTime(snap.time)}`,
		key: `snap:${snap.id}`,
		forPath: snap.forPath,
	});

	const commitToRev = (commit: Loaded<GitCommit>): HistoryRev => ({
		kind: "commit",
		sha: commit.sha,
		shortSha: commit.shortSha,
		time: commit.time,
		subject: commit.subject,
		repoPath: commit.path,
		label: commit.shortSha,
		key: `git:${commit.sha}`,
		forPath: commit.forPath,
	});

	const itemToRev = (item: TimelineItem<Loaded<Snapshot>, Loaded<GitCommit>>): HistoryRev =>
		item.kind === "snapshot" ? snapToRev(item.snap) : commitToRev(item.commit);

	const loadRevText = async (path: string, rev: HistoryRev): Promise<string | null> => {
		const cacheKey = `${path}\0${rev.key}`;
		if (revCache.has(cacheKey)) return revCache.get(cacheKey)!;
		const text = rev.kind === "snapshot" ? await backend.snapshot(path, rev.id) : await backend.gitShow(path, rev.sha, rev.repoPath);
		if (text !== null) {
			if (revCache.size > 60) {
				const oldestKey = revCache.keys().next().value;
				if (oldestKey !== undefined) revCache.delete(oldestKey);
			}
			revCache.set(cacheKey, text);
		}
		return text;
	};

	const scrollRowIntoView = (key: string) => {
		if (!listEl) return;
		const target = listEl.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);
		target?.scrollIntoView({ block: "nearest" });
	};

	const openRestoreReview = (opts: {
		title: string;
		path: string;
		effect: string;
		original: string;
		proposed: string;
		leftLabel: string;
		acceptLabel: string;
		language: string;
		doc: NonNullable<ReturnType<typeof activeDoc>>;
		docVersion: number;
		restoredMessage: string;
	}) => {
		const { path, doc, docVersion } = opts;
		ownReviewOpen = true;
		return openReview({
			title: opts.title,
			path,
			effect: opts.effect,
			original: opts.original,
			proposed: opts.proposed,
			sides: { left: opts.leftLabel, right: "Current" },
			acceptSide: "original",
			replaceable: true,
			language: opts.language,
			acceptLabel: opts.acceptLabel,
			rejectLabel: "Close",
			onAccept: (restored) => {
				if (doc.model.isDisposed() || documents.get(path) !== doc || doc.binary) {
					throw new Error(`${baseName(path)} is no longer open as text.`);
				}
				if (doc.model.getVersionId() !== docVersion) {
					throw new Error(`${baseName(path)} changed while the review was open. Reopen the revision to review against the latest text.`);
				}
				if (!applyText(path, restored)) {
					throw new Error(`Could not restore ${baseName(path)} because the editor buffer is no longer available.`);
				}
				notify(opts.restoredMessage);
			},
		});
	};

	/** Compares an older local snapshot (left) against the current editor buffer (right), with one-click Restore. */
	const showSnapshot = async (snap: Loaded<Snapshot>) => {
		const path = fileOf(snap);
		if (!path) return;
		const doc = activeDoc();
		if (!doc || doc.model.isDisposed()) return notify("Open the file again to see its snapshots.", "error");
		if (doc.binary) return notify(`${baseName(path)} is not text: there is nothing of it to compare.`);
		const docVersion = doc.model.getVersionId();
		const currentText = doc.model.getValue();
		const rev = snapToRev(snap);
		try {
			const text = await loadRevText(path, rev);
			if (text === null) return;
			if (activePath() !== path || doc.model.isDisposed() || doc.binary) return;
			if (doc.model.getVersionId() !== docVersion) {
				notify(`${baseName(path)} changed while loading the snapshot. Try again.`);
				return;
			}
			setScrubMode("current");
			setScrubKey(rev.key);
			void openRestoreReview({
				title: `${rev.label} vs Current`,
				path,
				effect: "Left is the older snapshot; right is your current buffer. Restoring puts the snapshot into the editor as one undoable edit; nothing is saved until you save.",
				original: text,
				proposed: currentText,
				leftLabel: rev.label,
				acceptLabel: "Restore this snapshot",
				language: doc.model.getLanguageId(),
				doc,
				docVersion,
				restoredMessage: "Snapshot restored into the editor. Save to keep it; undo to go back.",
			});
		} catch (e: any) {
			if (activePath() !== path || doc.model.isDisposed()) return;
			notify(`The snapshot of ${when(snap.time)} could not be opened: ${String(e?.message ?? e)}`, "error");
		}
	};

	/** Compares an older Git commit (left) against the current editor buffer (right), with one-click Restore. */
	const showCommitVsCurrent = async (commit: Loaded<GitCommit>) => {
		const path = fileOf(commit);
		if (!path) return;
		const doc = activeDoc();
		if (!doc || doc.model.isDisposed()) return notify("Open the file again to inspect its Git history.", "error");
		if (doc.binary) return notify(`${baseName(path)} is not text: there is nothing of it to compare.`);
		const docVersion = doc.model.getVersionId();
		const currentText = doc.model.getValue();
		const rev = commitToRev(commit);
		try {
			const historical = await loadRevText(path, rev);
			if (activePath() !== path || doc.model.isDisposed() || doc.binary) return;
			if (doc.model.getVersionId() !== docVersion) {
				notify(`${baseName(path)} changed while loading commit ${commit.shortSha}. Try again.`);
				return;
			}
			if (historical === null) {
				notify(`Could not read ${baseName(path)} at commit ${commit.shortSha}.`, "error");
				return;
			}
			setScrubMode("current");
			setScrubKey(rev.key);
			void openRestoreReview({
				title: `${commit.shortSha}: ${commit.subject} (${shortDay(commit.time)})`,
				path,
				effect: `Left is commit ${commit.shortSha}; right is your current buffer. Restoring puts ${commit.shortSha} into the editor as one undoable edit; nothing is saved until you save.`,
				original: historical,
				proposed: currentText,
				leftLabel: commit.shortSha,
				acceptLabel: `Restore ${commit.shortSha}`,
				language: doc.model.getLanguageId(),
				doc,
				docVersion,
				restoredMessage: `Restored ${baseName(path)} from ${commit.shortSha} into the editor. Save to keep it; undo to go back.`,
			});
		} catch (e: any) {
			if (activePath() !== path || doc.model.isDisposed()) return;
			notify(`Could not load commit ${commit.shortSha}: ${String(e?.message ?? e)}`, "error");
		}
	};

	/** Opens what a single Git commit changed (`sha~1` on left vs `sha` on right). */
	const showCommitDiff = async (commit: Loaded<GitCommit>) => {
		const path = fileOf(commit);
		if (!path) return;
		const doc = activeDoc();
		if (!doc || doc.model.isDisposed()) return notify("Open the file again to inspect its Git history.", "error");
		if (doc.binary) return notify(`${baseName(path)} is not text: there is nothing of it to compare.`);
		try {
			const { before, after } = await backend.gitCommitFile(path, commit.sha, commit.path);
			if (activePath() !== path || doc.model.isDisposed() || documents.get(path) !== doc || doc.binary) return;
			if (before === null && after === null) {
				notify(`Could not read text diff for ${baseName(path)} at commit ${commit.shortSha}.`, "error");
				return;
			}
			ownReviewOpen = true;
			setScrubMode("step");
			setScrubKey(`git:${commit.sha}`);
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
			if (activePath() !== path || doc.model.isDisposed()) return;
			notify(`Could not load diff for commit ${commit.shortSha}: ${String(e?.message ?? e)}`, "error");
		}
	};

	/** Compares any two selected snapshots or Git commits chronologically (older on left, newer on right). */
	const compareTwoRevs = async (a: HistoryRev, b: HistoryRev) => {
		const path = fileOf(a);
		if (!path) return;
		if (b.forPath !== path) return notify("Choose a revision of the same file to compare with.");
		const doc = activeDoc();
		if (!doc || doc.model.isDisposed()) return notify("Open the file again to compare revisions.", "error");
		if (doc.binary) return notify(`${baseName(path)} is not text: there is nothing of it to compare.`);
		if (a.key === b.key) return notify("Choose a different revision to compare with.");
		const [older, newer] = a.time <= b.time ? [a, b] : [b, a];
		try {
			const [before, after] = await Promise.all([loadRevText(path, older), loadRevText(path, newer)]);
			if (activePath() !== path || doc.model.isDisposed() || documents.get(path) !== doc || doc.binary) return;
			if (before === null || after === null) {
				notify(`Could not read both revisions (${older.label} and ${newer.label}) as text.`, "error");
				return;
			}
			setBaseRev(null);
			ownReviewOpen = true;
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
			if (activePath() !== path || doc.model.isDisposed()) return;
			notify(`Could not compare ${older.label} and ${newer.label}: ${String(e?.message ?? e)}`, "error");
		}
	};

	/** Renders the requested scrubber index (0..N-1 = revision, N = Current) inside ReviewView. */
	const renderScrubAt = async (index: number, mode = scrubMode()) => {
		const path = currentPath();
		const list = chronological();
		if (!path || !list.length) return;
		const clamped = Math.max(0, Math.min(list.length, index));
		const doc = activeDoc();
		if (!doc || doc.model.isDisposed()) return notify("Open the file again to scrub its history.", "error");
		if (doc.binary) return notify(`${baseName(path)} is not text: there is nothing of it to scrub.`);

		const seq = ++scrubSeq;

		// Rightmost position (`Current`)
		if (clamped >= list.length) {
			if (mode === "current") {
				setScrubKey(null);
				if (ownReviewOpen) {
					ownReviewOpen = false;
					void closeReview();
				}
				return;
			}
			// Step mode at `Current`: diff latest revision -> Current buffer.
			const latestItem = list[list.length - 1]!;
			const latestRev = itemToRev(latestItem);
			setScrubKey("current");
			setScrubBusy(true);
			try {
				const before = await loadRevText(path, latestRev);
				if (seq !== scrubSeq || activePath() !== path || doc.model.isDisposed() || doc.binary) return;
				if (before === null) return;
				ownReviewOpen = true;
				void openComparison({
					title: `Time travel: ${latestRev.label} → Current`,
					path,
					before,
					after: doc.model.getValue(),
					beforeLabel: latestRev.label,
					afterLabel: "Current",
					language: doc.model.getLanguageId(),
					effect: `Step ${list.length + 1} of ${list.length + 1}: changes since ${latestRev.label}. Nothing here changes the file.`,
				});
			} catch (e: any) {
				if (seq === scrubSeq && activePath() === path) notify(`Could not load revision: ${String(e?.message ?? e)}`, "error");
			} finally {
				if (seq === scrubSeq) setScrubBusy(false);
			}
			return;
		}

		const targetItem = list[clamped]!;
		const targetRev = itemToRev(targetItem);
		setScrubKey(targetRev.key);
		scrollRowIntoView(targetRev.key);
		setScrubBusy(true);

		const docVersion = doc.model.getVersionId();
		const currentText = doc.model.getValue();

		try {
			if (mode === "current") {
				const historical = await loadRevText(path, targetRev);
				if (seq !== scrubSeq || activePath() !== path || doc.model.isDisposed() || doc.binary) return;
				if (historical === null) {
					notify(`Could not read ${baseName(path)} at ${targetRev.label}.`, "error");
					return;
				}
				if (doc.model.getVersionId() !== docVersion) {
					notify(`${baseName(path)} changed while loading ${targetRev.label}. Try again.`);
					return;
				}
				const isCommit = targetItem.kind === "commit";
				void openRestoreReview({
					title: `Time travel (${clamped + 1}/${list.length}): ${targetRev.label} vs Current`,
					path,
					effect: `Left is ${targetRev.label} (${when(targetRev.time)}); right is your current buffer. Restoring puts this revision into the editor as one undoable edit.`,
					original: historical,
					proposed: currentText,
					leftLabel: targetRev.label,
					acceptLabel: isCommit ? `Restore ${targetItem.commit.shortSha}` : "Restore this snapshot",
					language: doc.model.getLanguageId(),
					doc,
					docVersion,
					restoredMessage: isCommit
						? `Restored ${baseName(path)} from ${targetItem.commit.shortSha} into the editor. Save to keep it; undo to go back.`
						: "Snapshot restored into the editor. Save to keep it; undo to go back.",
				});
				return;
			}

			// Step mode: diff immediate predecessor -> targetRev (or initial -> targetRev at index 0).
			const prevItem = clamped > 0 ? list[clamped - 1]! : null;
			const prevRev = prevItem ? itemToRev(prevItem) : null;
			const [before, after] = await Promise.all([
				prevRev ? loadRevText(path, prevRev) : Promise.resolve(""),
				loadRevText(path, targetRev),
			]);
			if (seq !== scrubSeq || activePath() !== path || doc.model.isDisposed() || doc.binary) return;
			if (before === null || after === null) {
				notify(`Could not read ${targetRev.label} as text.`, "error");
				return;
			}
			ownReviewOpen = true;
			void openComparison({
				title: prevRev ? `Time travel (${clamped + 1}/${list.length}): ${prevRev.label} → ${targetRev.label}` : `Time travel (1/${list.length}): ${targetRev.label}`,
				path,
				before,
				after,
				beforeLabel: prevRev ? prevRev.label : "(earliest captured)",
				afterLabel: targetRev.label,
				language: doc.model.getLanguageId(),
				effect: prevRev
					? `Step ${clamped + 1} of ${list.length}: changes from ${prevRev.label} to ${targetRev.label} (${when(targetRev.time)}).`
					: `Step 1 of ${list.length}: earliest revision in this timeline (${when(targetRev.time)}).`,
			});
		} catch (e: any) {
			if (seq === scrubSeq && activePath() === path) notify(`Could not load revision: ${String(e?.message ?? e)}`, "error");
		} finally {
			if (seq === scrubSeq) setScrubBusy(false);
		}
	};

	const scheduleScrub = (index: number, immediate = false) => {
		clearScrubTimer();
		const list = chronological();
		const clamped = Math.max(0, Math.min(list.length, index));
		setScrubKey(clamped >= list.length ? (scrubMode() === "step" ? "current" : null) : list[clamped]!.key);
		if (immediate) {
			void renderScrubAt(clamped);
			return;
		}
		scrubTimer = setTimeout(() => {
			scrubTimer = null;
			void renderScrubAt(clamped);
		}, 45);
	};

	const switchScrubMode = (nextMode: ScrubMode) => {
		if (scrubMode() === nextMode) return;
		setScrubMode(nextMode);
		if (scrubKey() !== null) {
			void renderScrubAt(scrubberIndex(), nextMode);
		}
	};

	const exitScrub = () => {
		clearScrubTimer();
		scrubSeq++;
		setScrubKey(null);
		setScrubBusy(false);
		if (ownReviewOpen) {
			ownReviewOpen = false;
			void closeReview();
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

	const saveCheckpoint = async () => {
		const path = currentPath();
		const root = state.workspace?.root ?? "";
		if (!path || path.startsWith("untitled:") || !root || !isInside(root, path)) return;
		const doc = activeDoc();
		if (!doc || doc.model.isDisposed()) return notify("Open the file again to save a checkpoint.", "error");
		if (doc.binary) return notify(`${baseName(path)} is not text: checkpoints only apply to text files.`);
		const label = await ask(`Save pinned checkpoint for ${baseName(path)} (optional label)`, "");
		if (label === null) return;
		if (activePath() !== path || doc.model.isDisposed() || doc.binary) return;
		try {
			const saved = await backend.historyCheckpoint(path, doc.model.getValue(), label.trim() || undefined);
			if (!saved) return notify(`Could not save a checkpoint for ${baseName(path)}.`, "error");
			revCache.clear();
			historyChanged.fire(path);
			setVersion((v) => v + 1);
			notify(saved.label ? `Saved checkpoint "${saved.label}".` : `Saved pinned checkpoint for ${baseName(path)}.`);
		} catch (e: any) {
			notify(`Could not save checkpoint: ${String(e?.message ?? e)}`, "error");
		}
	};

	const editSnapshotLabel = async (snap: Loaded<Snapshot>) => {
		const path = fileOf(snap);
		if (!path) return;
		const next = await ask(`Label for snapshot (${shortTime(snap.time)})`, snap.label ?? "");
		if (next === null) return;
		try {
			const ok = await backend.historyLabel(path, snap.id, next.trim() || null, snap.pinned ?? (next.trim() ? true : undefined));
			if (ok) {
				historyChanged.fire(path);
				setVersion((v) => v + 1);
			}
		} catch (e: any) {
			notify(`Could not update snapshot label: ${String(e?.message ?? e)}`, "error");
		}
	};

	const togglePinSnapshot = async (snap: Loaded<Snapshot>) => {
		const path = fileOf(snap);
		if (!path) return;
		const nextPinned = !snap.pinned;
		try {
			const ok = await backend.historyLabel(path, snap.id, snap.label ?? null, nextPinned);
			if (ok) {
				historyChanged.fire(path);
				setVersion((v) => v + 1);
				notify(nextPinned ? "Snapshot pinned (protected from automatic cleanup)." : "Snapshot unpinned.");
			}
		} catch (e: any) {
			notify(`Could not update pin state: ${String(e?.message ?? e)}`, "error");
		}
	};

	const deleteSnapshot = async (snap: Loaded<Snapshot>) => {
		const path = fileOf(snap);
		if (!path) return;
		const picked = await choose(`Delete snapshot "${sourceTitle(snap)}" (${when(snap.time)})? This cannot be undone.`, ["Delete snapshot"]);
		if (picked !== "Delete snapshot") return;
		try {
			const ok = await backend.historyDelete(path, snap.id);
			if (ok) {
				revCache.delete(`${path}\0snap:${snap.id}`);
				if (baseRev()?.key === `snap:${snap.id}`) setBaseRev(null);
				if (scrubKey() === `snap:${snap.id}`) exitScrub();
				historyChanged.fire(path);
				setVersion((v) => v + 1);
				notify("Snapshot deleted.");
			}
		} catch (e: any) {
			notify(`Could not delete snapshot: ${String(e?.message ?? e)}`, "error");
		}
	};

	const clearFileHistory = async (keepPinned: boolean) => {
		const path = currentPath();
		const root = state.workspace?.root ?? "";
		if (!path || path.startsWith("untitled:") || !root || !isInside(root, path)) return;
		const prompt = keepPinned
			? `Clear unpinned local snapshots for ${baseName(path)}? Pinned checkpoints will be kept.`
			: `Clear ALL local snapshots (including pinned checkpoints) for ${baseName(path)}? This cannot be undone.`;
		const button = keepPinned ? "Clear unpinned" : "Clear all";
		const picked = await choose(prompt, [button]);
		if (picked !== button) return;
		try {
			const count = await backend.historyClear(path, keepPinned);
			revCache.clear();
			setBaseRev(null);
			exitScrub();
			historyChanged.fire(path);
			setVersion((v) => v + 1);
			notify(count ? `Removed ${count} local ${count === 1 ? "snapshot" : "snapshots"} for ${baseName(path)}.` : "No snapshots to remove.");
		} catch (e: any) {
			notify(`Could not clear history: ${String(e?.message ?? e)}`, "error");
		}
	};

	const clearWorkspaceHistory = async () => {
		const picked = await choose(
			"Clear unpinned local snapshots across the entire workspace? Pinned checkpoints will be kept.",
			["Clear workspace history"],
		);
		if (picked !== "Clear workspace history") return;
		try {
			const count = await backend.historyClear(undefined, true);
			revCache.clear();
			setBaseRev(null);
			exitScrub();
			const path = currentPath();
			if (path) historyChanged.fire(path);
			setVersion((v) => v + 1);
			notify(count ? `Removed ${count} unpinned local ${count === 1 ? "snapshot" : "snapshots"} from workspace history.` : "No unpinned snapshots to remove.");
		} catch (e: any) {
			notify(`Could not clear workspace history: ${String(e?.message ?? e)}`, "error");
		}
	};

	const refreshAll = () => {
		revCache.clear();
		setVersion((v) => v + 1);
		void refreshGit();
	};

	const openSnapshotMenu = async (snap: Loaded<Snapshot>, at: Point) => {
		const path = fileOf(snap);
		const doc = activeDoc();
		if (!path || !doc || doc.model.isDisposed()) return;
		const rev = snapToRev(snap);
		const base = baseRev();
		const timeline = allTimeline();
		const idx = timeline.findIndex((item) => item.key === rev.key);
		const olderItem = idx >= 0 && idx + 1 < timeline.length ? timeline[idx + 1]! : null;

		const CMP_CURRENT = "Compare with current";
		const CMP_PREV = olderItem ? "Compare with previous revision" : "";
		const CMP_BASE = base && base.key !== rev.key ? `Compare with ${base.label}` : "";
		const EDIT_LABEL = snap.label ? "Edit label…" : "Add label…";
		const TOGGLE_PIN = snap.pinned ? "Unpin checkpoint" : "Pin checkpoint";
		const SET_BASE = base?.key === rev.key ? "Clear compare base" : "Compare with… (select as base)";
		const DELETE = "Delete snapshot…";
		const entries: RowMenuEntry[] = [
			CMP_CURRENT,
			...(CMP_PREV ? [CMP_PREV] : []),
			...(CMP_BASE ? [CMP_BASE] : []),
			"separator",
			EDIT_LABEL,
			TOGGLE_PIN,
			SET_BASE,
			"separator",
			DELETE,
		];
		const picked = await chooseFromMenu(rev.label, entries, at);
		if (!picked || activePath() !== path || doc.model.isDisposed() || documents.get(path) !== doc) return;
		if (picked === CMP_CURRENT) void showSnapshot(snap);
		else if (CMP_PREV && picked === CMP_PREV && olderItem) void compareTwoRevs(itemToRev(olderItem), rev);
		else if (CMP_BASE && picked === CMP_BASE && base) void compareTwoRevs(base, rev);
		else if (picked === EDIT_LABEL) void editSnapshotLabel(snap);
		else if (picked === TOGGLE_PIN) void togglePinSnapshot(snap);
		else if (picked === SET_BASE) setBaseRev(base?.key === rev.key ? null : rev);
		else if (picked === DELETE) void deleteSnapshot(snap);
	};

	const openCommitMenu = async (commit: Loaded<GitCommit>, at: Point) => {
		const path = fileOf(commit);
		const doc = activeDoc();
		if (!path || !doc || doc.model.isDisposed()) return;
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
		if (!picked || activePath() !== path || doc.model.isDisposed() || documents.get(path) !== doc) return;
		if (picked === COMMIT_DIFF) void showCommitDiff(commit);
		else if (picked === CMP_CURRENT) void showCommitVsCurrent(commit);
		else if (CMP_BASE && picked === CMP_BASE && base) void compareTwoRevs(base, rev);
		else if (picked === SET_BASE) setBaseRev(base?.key === rev.key ? null : rev);
	};

	const filterMenuItems = (): MenuItem[] => {
		const all = allTimeline();
		const localCount = snapshots().length;
		const gitCount = gitCommits().length;
		const pinnedCount = snapshots().filter((s) => s.pinned).length;
		const countSource = (src: NonNullable<Snapshot["source"]>) => snapshots().filter((s) => (s.source ?? "save") === src).length;
		const items: MenuItem[] = [
			{ label: `All entries (${all.length})`, checked: filter() === "all", run: () => setFilter("all") },
			{ label: `Local snapshots (${localCount})`, checked: filter() === "local", run: () => setFilter("local") },
			{ label: `Git commits (${gitCount})`, checked: filter() === "git", run: () => setFilter("git") },
			{ label: `Pinned checkpoints (${pinnedCount})`, checked: filter() === "pinned", run: () => setFilter("pinned") },
			"separator",
			{ label: `File Saved (${countSource("save")})`, checked: filter() === "save", run: () => setFilter("save") },
			{ label: `Before Discard (${countSource("discard")})`, checked: filter() === "discard", run: () => setFilter("discard") },
			{ label: `Before Replace (${countSource("replace")})`, checked: filter() === "replace", run: () => setFilter("replace") },
			{ label: `Before Import (${countSource("import")})`, checked: filter() === "import", run: () => setFilter("import") },
			{ label: `Manual Checkpoints (${countSource("manual")})`, checked: filter() === "manual", run: () => setFilter("manual") },
		];
		if (filter() !== "all") {
			items.push("separator", { label: "Clear Filter", run: () => setFilter("all") });
		}
		return items;
	};

	const moreMenuItems = (): MenuItem[] => {
		const st = activeStats();
		const hasFile = isWorkspaceFile();
		const hasSnaps = snapshots().length > 0;
		const hasWorkspaceSnaps = (st?.workspaceSnapshots ?? 0) > 0;
		return [
			{ label: formatStorageSummary(st), disabled: true, run: () => {} },
			{ label: formatWorkspaceStorageSummary(st), disabled: true, run: () => {} },
			"separator",
			{ label: "Save Checkpoint…", disabled: !hasFile, run: () => void saveCheckpoint() },
			{ label: "Clear Unpinned File History…", disabled: !hasFile || !hasSnaps, run: () => void clearFileHistory(true) },
			{ label: "Clear All File History…", disabled: !hasFile || !hasSnaps, run: () => void clearFileHistory(false) },
			"separator",
			{ label: "Clear Unpinned Workspace History…", disabled: !hasWorkspaceSnaps, run: () => void clearWorkspaceHistory() },
		];
	};

	const activeCaption = createMemo(() => {
		const list = chronological();
		const key = scrubKey();
		if (!list.length) return "";
		if (!key) {
			return `At Current · ${list.length} ${list.length === 1 ? "revision" : "revisions"}`;
		}
		if (key === "current") {
			return `Latest → Current`;
		}
		const item = activeScrubItem();
		if (!item) return `At Current`;
		const title = item.kind === "snapshot" ? sourceTitle(item.snap) : item.commit.subject || item.commit.shortSha;
		return `${title} · ${formatRelativeTime(item.time)}`;
	});

	return (
		<div class="panel-body history-panel" data-panel="history">
			<div class="panel-title">
				<span>Timeline</span>
				<div class="history-title-actions">
					<button
						type="button"
						title="Save Pinned Checkpoint…"
						aria-label="Save Pinned Checkpoint"
						disabled={!isWorkspaceFile()}
						onClick={() => void saveCheckpoint()}
					>
						<Icon name="bookmark" />
					</button>
					<Menu
						floating
						class={filter() !== "all" ? "docs-filter-menu on" : "docs-filter-menu"}
						label={filter() !== "all" ? `Filter timeline: ${filterLabel(filter())}` : "Filter timeline"}
						title={filter() !== "all" ? `Filter: ${filterLabel(filter())}` : "Filter Timeline"}
						items={filterMenuItems}
					>
						<Icon name={filter() !== "all" ? "filter-filled" : "filter"} />
					</Menu>
					<button
						type="button"
						title="Refresh Timeline"
						aria-label="Refresh Timeline"
						onClick={refreshAll}
					>
						<Icon name="refresh" />
					</button>
					<Menu floating label="More Timeline Actions" title="More Actions…" items={moreMenuItems}>
						<Icon name="ellipsis" />
					</Menu>
				</div>
			</div>

			<Show when={filter() !== "all"}>
				<div class="history-filter-chips">
					<button
						type="button"
						class="docs-tag-active"
						title="Clear timeline filter"
						onClick={() => setFilter("all")}
					>
						<span>{filterLabel(filter())}</span>
						<Icon name="close" />
					</button>
				</div>
			</Show>

			<Show when={activePath()} fallback={<p class="hint">No file open. Open a file to inspect its local snapshots, Git commits, and time-travel scrubber.</p>}>
				<Show when={baseRev()}>
					{(base) => (
						<div class="history-base-banner" role="status">
							<Icon name="diff" />
							<span class="history-base-text">
								Base: <strong>{base().label}</strong> — pick another revision
							</span>
							<button type="button" class="link" onClick={compareBaseWithCurrent}>
								vs Current
							</button>
							<button type="button" class="link" onClick={() => setBaseRev(null)}>
								Cancel
							</button>
						</div>
					)}
				</Show>

				<Show when={historyError()}>
					<p class="hint warn" role="alert">
						The snapshots of {baseName(activePath()!)} could not be read: {historyError()}
					</p>
				</Show>

				<Show when={chronological().length > 0}>
					<div class="history-scrubber" role="region" aria-label={`Time-travel scrubber for ${baseName(activePath()!)}`}>
						<div class="history-scrubber-head">
							<span class="history-scrubber-title">
								<Icon name="history" />
								<span>
									{scrubKey() === null
										? "Time travel"
										: scrubKey() === "current"
											? `Current (${chronological().length}/${chronological().length})`
											: `${scrubberIndex() + 1} / ${chronological().length}`}
								</span>
							</span>
							<div class="history-mode-toggle" role="group" aria-label="Time-travel diff mode">
								<button
									type="button"
									class={scrubMode() === "step" ? "on" : undefined}
									aria-pressed={scrubMode() === "step" ? "true" : "false"}
									title="Show incremental changes at each revision (previous → revision)"
									onClick={() => switchScrubMode("step")}
								>
									Step
								</button>
								<button
									type="button"
									class={scrubMode() === "current" ? "on" : undefined}
									aria-pressed={scrubMode() === "current" ? "true" : "false"}
									title="Compare scrubbed revision against your current buffer with one-click Restore"
									onClick={() => switchScrubMode("current")}
								>
									vs Current
								</button>
							</div>
						</div>
						<div class="history-scrubber-track">
							<button
								type="button"
								class="history-step-btn"
								title="Step backward to older revision"
								aria-label="Older revision"
								disabled={scrubberIndex() <= 0}
								onClick={() => scheduleScrub(scrubberIndex() - 1, true)}
							>
								<Icon name="chevron-left" />
							</button>
							<input
								type="range"
								class="history-slider"
								min={0}
								max={chronological().length}
								step={1}
								value={scrubberIndex()}
								aria-label="Scrub through file revisions from oldest to current"
								aria-valuetext={activeCaption()}
								onInput={(e) => scheduleScrub(Number(e.currentTarget.value), false)}
							/>
							<button
								type="button"
								class="history-step-btn"
								title="Step forward to newer revision"
								aria-label="Newer revision"
								disabled={scrubberIndex() >= chronological().length}
								onClick={() => scheduleScrub(scrubberIndex() + 1, true)}
							>
								<Icon name="chevron-right" />
							</button>
						</div>
						<div class="history-scrubber-foot">
							<span class="history-scrubber-caption" title={activeCaption()}>
								{scrubBusy() ? "Loading revision…" : activeCaption()}
							</span>
							<Show when={scrubKey() !== null}>
								<button type="button" class="link history-scrub-exit" onClick={exitScrub}>
									Exit
								</button>
							</Show>
						</div>
					</div>
				</Show>

				<Show
					when={visibleTimeline().length > 0}
					fallback={
						<p class="hint">
							{reading()
								? "Reading timeline…"
								: allTimeline().length > 0
									? `No entries match "${filterLabel(filter())}".`
									: `No local snapshots or Git commits for ${baseName(activePath()!)} yet.`}
						</p>
					}
				>
					<div class="history-list-wrap" ref={listEl}>
						<Rows role="listbox" label={`History of ${baseName(activePath()!)}`}>
							<For each={dayGroups()}>
								{(group) => (
									<div class="history-day-group" role="group" aria-label={group.label}>
										<div class="history-day-head" aria-hidden="true">
											<span class="history-day-label">{group.label}</span>
											<span class="history-day-count">{group.items.length}</span>
										</div>
										<For each={group.items}>
											{(item) => {
												if (item.kind === "snapshot") {
													const snap = item.snap;
													const rev = () => snapToRev(snap);
													const isBase = () => baseRev()?.key === rev().key;
													const isScrubbing = () => scrubKey() === rev().key;
													const delta = () => formatLineDelta(snap.added, snap.removed);
													const sub = () => sourceSubtitle(snap);
													const isSafety = () =>
														snap.source === "discard" ||
														snap.source === "replace" ||
														snap.source === "import" ||
														snap.source === "restore";
													return (
														<Row
															class={`tree-row history-row${isScrubbing() ? " scrubbing" : ""}${snap.pinned ? " pinned" : ""}`}
															key={rev().key}
															selected={isBase() || isScrubbing()}
															title={`${sourceTitle(snap)}${sub() ? ` (${sub()})` : ""}\n${when(snap.time)} · ${size(snap.size)}\nClick to compare against Current; right-click for label, pin, compare, or delete.`}
															onActivate={() => void showSnapshot(snap)}
															onMenu={(at) => void openSnapshotMenu(snap, at)}
														>
															<span class="history-rail" aria-hidden="true">
																<Show
																	when={snap.pinned}
																	fallback={
																		<span
																			class={`snap-dot${isSafety() ? " safety" : ""}${snap.source === "manual" ? " manual" : ""}`}
																		/>
																	}
																>
																	<Icon name="pinned" class="history-pin-icon" />
																</Show>
															</span>
															<span class="history-main">
																<span class="label">{sourceTitle(snap)}</span>
																<Show when={sub()}>
																	<span class="history-sub">{sub()}</span>
																</Show>
																<Show when={isBase()}>
																	<span class="history-base-pill">Base</span>
																</Show>
															</span>
															<span class="history-meta">
																<Show when={delta()}>
																	{(d) => (
																		<span class="history-delta">
																			<Show when={d().addedText}>
																				<span class="add">{d().addedText}</span>
																			</Show>
																			<Show when={d().removedText}>
																				<span class="del">{d().removedText}</span>
																			</Show>
																		</span>
																	)}
																</Show>
																<span class="history-time">{formatRelativeTime(snap.time)}</span>
															</span>
															<span
																class="history-row-acts"
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
																				title={snap.pinned ? "Unpin checkpoint" : "Pin checkpoint"}
																				aria-label={snap.pinned ? `Unpin ${rev().label}` : `Pin ${rev().label}`}
																				onClick={() => void togglePinSnapshot(snap)}
																			>
																				<Icon name={snap.pinned ? "pinned" : "pin"} />
																			</button>
																			<button
																				type="button"
																				tabindex={-1}
																				title={isBase() ? "Clear compare base" : "Compare with… (select as base)"}
																				aria-label={isBase() ? "Clear compare base" : `Select ${rev().label} as compare base`}
																				onClick={() => setBaseRev(isBase() ? null : rev())}
																			>
																				<Icon name={isBase() ? "close" : "diff"} />
																			</button>
																			<button
																				type="button"
																				tabindex={-1}
																				title="Delete snapshot…"
																				aria-label={`Delete ${rev().label}`}
																				onClick={() => void deleteSnapshot(snap)}
																			>
																				<Icon name="trash" />
																			</button>
																		</>
																	}
																>
																	<button
																		type="button"
																		class="link history-compare-btn"
																		tabindex={-1}
																		title={`Compare ${baseRev()!.label} with ${rev().label}`}
																		onClick={() => void compareTwoRevs(baseRev()!, rev())}
																	>
																		Compare
																	</button>
																</Show>
															</span>
														</Row>
													);
												}

												const commit = item.commit;
												const rev = () => commitToRev(commit);
												const isBase = () => baseRev()?.key === rev().key;
												const isScrubbing = () => scrubKey() === rev().key;
												return (
													<Row
														class={`tree-row history-row history-commit${isScrubbing() ? " scrubbing" : ""}`}
														key={rev().key}
														selected={isBase() || isScrubbing()}
														title={`${commit.shortSha} · ${commit.subject}\n${commit.author ? `${commit.author} · ` : ""}${when(commit.time)}\nClick to compare with Current; right-click for commit diff (${commit.shortSha}~1..${commit.shortSha}) or Compare with…`}
														onActivate={() => void showCommitVsCurrent(commit)}
														onMenu={(at) => void openCommitMenu(commit, at)}
													>
														<span class="history-rail" aria-hidden="true">
															<Icon name="git-commit" class="history-commit-icon" />
														</span>
														<span class="history-main">
															<span class="label">{commit.subject || commit.shortSha}</span>
															<span class="history-sha">{commit.shortSha}</span>
															<Show when={isBase()}>
																<span class="history-base-pill">Base</span>
															</Show>
														</span>
														<span class="history-meta">
															<span class="history-time">{formatRelativeTime(commit.time)}</span>
														</span>
														<span
															class="history-row-acts"
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
																			<Icon name={isBase() ? "close" : "diff"} />
																		</button>
																	</>
																}
															>
																<button
																	type="button"
																	class="link history-compare-btn"
																	tabindex={-1}
																	title={`Compare ${baseRev()!.label} with ${commit.shortSha}`}
																	onClick={() => void compareTwoRevs(baseRev()!, rev())}
																>
																	Compare
																</button>
															</Show>
														</span>
													</Row>
												);
											}}
										</For>
									</div>
								)}
							</For>
						</Rows>
					</div>
				</Show>
			</Show>
		</div>
	);
}
