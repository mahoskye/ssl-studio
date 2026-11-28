// Pure helpers for the VS Code-aligned History Timeline and Time-Travel Scrubber (ADR 0052).
import type { GitCommit, HistoryStats, Snapshot, SnapshotSource } from "../../shared/protocol";

export type TimelineFilter = "all" | "local" | "git" | "pinned" | SnapshotSource;
export type ScrubMode = "step" | "current";

export type TimelineItem<S extends Snapshot = Snapshot, C extends GitCommit = GitCommit> =
	| { kind: "snapshot"; key: string; time: number; seq: number; snap: S }
	| { kind: "commit"; key: string; time: number; seq: number; commit: C };

export type TimelineDayGroup<S extends Snapshot = Snapshot, C extends GitCommit = GitCommit> = {
	dayKey: string;
	label: string;
	items: TimelineItem<S, C>[];
};

/** Extracts the numeric sequence tie-breaker from a `${time}-${seq}` snapshot id. */
export function snapshotSeq(id: string): number {
	const dash = id.indexOf("-");
	if (dash < 0) return 0;
	const n = Number(id.slice(dash + 1));
	return Number.isSafeInteger(n) ? n : 0;
}

/** Human-readable provenance label for a snapshot source. */
export function sourceKindLabel(source: SnapshotSource | undefined): string {
	switch (source) {
		case "discard":
			return "Before Discard";
		case "replace":
			return "Before Replace";
		case "import":
			return "Before Import";
		case "restore":
			return "Before Restore";
		case "manual":
			return "Checkpoint";
		case "save":
		default:
			return "File Saved";
	}
}

/** Primary display title for a snapshot row (user label when present, else provenance). */
export function sourceTitle(snap: Pick<Snapshot, "source" | "label">): string {
	const clean = snap.label?.trim();
	return clean ? clean : sourceKindLabel(snap.source);
}

/** Secondary provenance badge text when a custom label overrides the default title. */
export function sourceSubtitle(snap: Pick<Snapshot, "source" | "label">): string {
	return snap.label?.trim() ? sourceKindLabel(snap.source) : "";
}

/** Human-readable label for an active filter chip (ADR 0050). */
export function filterLabel(filter: TimelineFilter): string {
	switch (filter) {
		case "all":
			return "All entries";
		case "local":
			return "Local snapshots";
		case "git":
			return "Git commits";
		case "pinned":
			return "Pinned checkpoints";
		case "save":
			return "File Saved";
		case "discard":
			return "Before Discard";
		case "replace":
			return "Before Replace";
		case "import":
			return "Before Import";
		case "restore":
			return "Before Restore";
		case "manual":
			return "Manual Checkpoints";
	}
}

/** Interleaves local snapshots and Git commits into one chronological newest-first timeline. */
export function mergeHistoryTimeline<S extends Snapshot, C extends GitCommit>(
	snapshots: readonly S[],
	commits: readonly C[],
): TimelineItem<S, C>[] {
	const items: TimelineItem<S, C>[] = [];
	for (const snap of snapshots) {
		items.push({
			kind: "snapshot",
			key: `snap:${snap.id}`,
			time: snap.time,
			seq: snapshotSeq(snap.id),
			snap,
		});
	}
	for (let i = 0; i < commits.length; i++) {
		const commit = commits[i]!;
		items.push({
			kind: "commit",
			key: `git:${commit.sha}`,
			time: commit.time,
			// Preserve git log order for commits sharing the same second, placing commits just below same-ms local snapshots.
			seq: -(i + 1),
			commit,
		});
	}
	items.sort((a, b) => b.time - a.time || b.seq - a.seq);
	return items;
}

/** Filters unified timeline entries according to the active header funnel menu filter. */
export function filterHistoryTimeline<S extends Snapshot, C extends GitCommit>(
	items: readonly TimelineItem<S, C>[],
	filter: TimelineFilter,
): TimelineItem<S, C>[] {
	if (filter === "all") return [...items];
	if (filter === "local") return items.filter((item) => item.kind === "snapshot");
	if (filter === "git") return items.filter((item) => item.kind === "commit");
	if (filter === "pinned") return items.filter((item) => item.kind === "snapshot" && Boolean(item.snap.pinned));
	return items.filter((item) => item.kind === "snapshot" && (item.snap.source ?? "save") === filter);
}

function localDayKey(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** Groups newest-first timeline items into local calendar day sections ("Today", "Yesterday", "Nov 24"). */
export function groupTimelineByDay<S extends Snapshot, C extends GitCommit>(
	items: readonly TimelineItem<S, C>[],
	now = Date.now(),
): TimelineDayGroup<S, C>[] {
	const today = new Date(now);
	const todayKey = localDayKey(today);
	const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
	const yesterdayKey = localDayKey(yesterday);
	const currentYear = today.getFullYear();

	const groups: TimelineDayGroup<S, C>[] = [];
	const byDay = new Map<string, TimelineDayGroup<S, C>>();

	for (const item of items) {
		const d = new Date(item.time);
		const valid = !Number.isNaN(d.getTime());
		const dayKey = valid ? localDayKey(d) : "unknown";
		let group = byDay.get(dayKey);
		if (!group) {
			let label = "Earlier";
			if (valid) {
				if (dayKey === todayKey) label = "Today";
				else if (dayKey === yesterdayKey) label = "Yesterday";
				else if (d.getFullYear() === currentYear) {
					label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
				} else {
					label = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
				}
			}
			group = { dayKey, label, items: [] };
			byDay.set(dayKey, group);
			groups.push(group);
		}
		group.items.push(item);
	}
	return groups;
}

/** Compact relative timestamp matching VS Code Timeline rows. */
export function formatRelativeTime(time: number, now = Date.now()): string {
	if (!Number.isFinite(time)) return "";
	const diff = now - time;
	if (diff < 0) return "just now";
	const sec = Math.floor(diff / 1000);
	if (sec < 45) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hrs = Math.floor(min / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	if (days === 1) return "Yesterday";
	if (days < 7) return `${days}d ago`;
	const d = new Date(time);
	const nowDate = new Date(now);
	if (d.getFullYear() === nowDate.getFullYear()) {
		return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Human-readable byte size (`0 B`, `840 B`, `12 KB`, `2.4 MB`). */
export function formatByteSize(bytes: number): string {
	const safe = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
	if (safe < 1024) return `${Math.round(safe)} B`;
	if (safe < 1024 * 1024) return `${Math.max(1, Math.round(safe / 1024))} KB`;
	return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact savings summary for the active file's local snapshots. */
export function formatStorageSummary(stats: HistoryStats | null | undefined): string {
	if (!stats || stats.fileSnapshots === 0) return "File: no local snapshots";
	const count = `${stats.fileSnapshots} ${stats.fileSnapshots === 1 ? "snapshot" : "snapshots"}`;
	const stored = formatByteSize(stats.fileStoredBytes);
	if (stats.fileRawBytes > stats.fileStoredBytes && stats.fileRawBytes > 0) {
		const pct = Math.round(((stats.fileRawBytes - stats.fileStoredBytes) / stats.fileRawBytes) * 100);
		if (pct > 0) return `File: ${count} · ${stored} (${pct}% saved)`;
	}
	return `File: ${count} · ${stored}`;
}

/** Compact savings summary for the entire workspace's SQLite history store. */
export function formatWorkspaceStorageSummary(stats: HistoryStats | null | undefined): string {
	if (!stats || stats.workspaceSnapshots === 0) return "Workspace: empty";
	const files = `${stats.workspaceFiles} ${stats.workspaceFiles === 1 ? "file" : "files"}`;
	const stored = formatByteSize(stats.workspaceStoredBytes);
	if (stats.workspaceRawBytes > stats.workspaceStoredBytes && stats.workspaceRawBytes > 0) {
		const pct = Math.round(((stats.workspaceRawBytes - stats.workspaceStoredBytes) / stats.workspaceRawBytes) * 100);
		if (pct > 0) return `Workspace: ${stats.workspaceSnapshots} across ${files} · ${stored} (${pct}% saved)`;
	}
	return `Workspace: ${stats.workspaceSnapshots} across ${files} · ${stored}`;
}

/** Returns timeline items ordered oldest → newest for the Time-Travel Scrubber. */
export function scrubberChronological<S extends Snapshot, C extends GitCommit>(
	items: readonly TimelineItem<S, C>[],
): TimelineItem<S, C>[] {
	return [...items].reverse();
}

/** Formats `+N −M` line-delta summary when non-zero; empty string when unavailable or zero. */
export function formatLineDelta(added: number | undefined, removed: number | undefined): { addedText: string; removedText: string } | null {
	const a = typeof added === "number" && added > 0 ? added : 0;
	const r = typeof removed === "number" && removed > 0 ? removed : 0;
	if (!a && !r) return null;
	return {
		addedText: a ? `+${a}` : "",
		removedText: r ? `−${r}` : "",
	};
}
