import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBackend, type Host } from "../src/bun/backend";
import { computeLineDelta, History, historyKey } from "../src/bun/history";
import { dirs } from "../src/bun/paths";
import { contrast, TEXT } from "../src/shared/contrast";
import { allOklchThemes } from "../src/shared/oklchTheme";
import type { GitCommit, HistoryStats, Snapshot } from "../src/shared/protocol";
import { ICON } from "../src/view/icons";
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
	snapshotSeq,
	sourceSubtitle,
	sourceTitle,
} from "../src/view/panels/historyTimeline";
import dark from "../src/view/themes/studio-dark.json";
import light from "../src/view/themes/studio-light.json";

const rootTmp = mkdtempSync(join(tmpdir(), "ssl-hist-sqlite-"));
afterAll(() => {
	rmSync(rootTmp, { recursive: true, force: true });
});

const repoRead = (rel: string) => readFileSync(resolve(import.meta.dir, "..", rel), "utf8").replace(/\r\n/g, "\n");

function parseHex(h: string): [number, number, number] {
	return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function toHex(r: number, g: number, b: number): string {
	const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
	return `#${c(r)}${c(g)}${c(b)}`;
}
function mixSrgb(fg: string, pct: number, bg: string): string {
	const [r1, g1, b1] = parseHex(fg);
	const [r2, g2, b2] = parseHex(bg);
	const t = pct / 100;
	return toHex(r1 * t + r2 * (1 - t), g1 * t + g2 * (1 - t), b1 * t + b2 * (1 - t));
}

function makeHost(): Host {
	return {
		emit: () => {},
		pick: async () => null,
		trash: async (p) => rmSync(p, { recursive: true, force: true }),
		app: "test",
		kind: "app",
		quit: () => {},
	};
}

describe("SQLite local history — compression, deduplication, deltas, checkpoints, pruning, rename & legacy", () => {
	test("lazy initialization creates no database on read-only list/stats until first write", () => {
		const ws = join(rootTmp, "lazy-ws");
		const base = join(rootTmp, "lazy-base");
		mkdirSync(ws, { recursive: true });
		const file = join(ws, "Empty.ssl");
		const hist = new History(ws, base);
		try {
			expect(hist.list(file)).toEqual([]);
			const st = hist.stats(file);
			expect(st.workspaceSnapshots).toBe(0);
			expect(st.dbBytes).toBe(0);
			expect(existsSync(base)).toBe(false);
		} finally {
			hist.close();
		}
	});

	test("gzip compresses text blobs and content-addresses identical versions across edits and files", async () => {
		const ws = join(rootTmp, "dedup-ws");
		const base = join(rootTmp, "dedup-base");
		mkdirSync(ws, { recursive: true });
		const fileA = join(ws, "RuleA.ssl");
		const fileB = join(ws, "RuleB.ssl");
		const hist = new History(ws, base);

		const textA = Array.from({ length: 60 }, (_, i) => `:DECLARE nRow${i};\nnRow${i} := ${i} * 10;`).join("\n") + "\n";
		const textB = textA + ":RETURN nRow0;\n";
		try {
			expect(await hist.record(fileA, textA, 1000, "save")).toBe(true);
			expect(await hist.record(fileA, textB, 2000, "save")).toBe(true);
			// Reverting back to textA creates a new snapshot row, but reuses textA's existing gzipped blob!
			expect(await hist.record(fileA, textA, 3000, "restore")).toBe(true);
			// Saving identical textA in a second file also reuses the exact same blob!
			expect(await hist.record(fileB, textA, 4000, "save")).toBe(true);

			const listA = hist.list(fileA);
			expect(listA.length).toBe(3);
			expect(listA[0]!.source).toBe("restore");
			expect(listA[0]!.added).toBe(0);
			expect(listA[0]!.removed).toBe(1);
			expect(listA[1]!.added).toBe(1);
			expect(listA[1]!.removed).toBe(0);
			expect(listA[2]!.added).toBeUndefined();

			expect(await hist.read(fileA, listA[0]!.id)).toBe(textA);
			expect(await hist.read(fileA, listA[1]!.id)).toBe(textB);
			expect(await hist.read(fileB, hist.list(fileB)[0]!.id)).toBe(textA);

			const st = hist.stats(fileA);
			expect(st.fileSnapshots).toBe(3);
			expect(st.workspaceSnapshots).toBe(4);
			expect(st.workspaceFiles).toBe(2);
			// Gzip + dedup compresses 4 snapshots (~8.5 KB raw) down to well under 2 KB stored.
			expect(st.workspaceRawBytes).toBeGreaterThan(st.workspaceStoredBytes * 3);
			expect(st.dbBytes).toBeGreaterThan(0);

			// Verify only 2 distinct blobs exist in SQLite despite 4 snapshots across 2 files.
			const { rootKey } = historyKey(ws, ws);
			const inspectDb = new Database(join(base, `${rootKey}.sqlite`), { readonly: true });
			try {
				const blobCount = inspectDb.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM blobs").get()!.c;
				expect(blobCount).toBe(2);
			} finally {
				inspectDb.close();
			}
		} finally {
			hist.close();
		}
	});

	test("checkpoints pin and label snapshots, promoting identical newest snapshot without duplication", async () => {
		const ws = join(rootTmp, "cp-ws");
		const base = join(rootTmp, "cp-base");
		mkdirSync(ws, { recursive: true });
		const file = join(ws, "Rule.ssl");
		const hist = new History(ws, base);
		try {
			await hist.record(file, ":RETURN 1;\n", 1000, "save");
			// Checkpoint of identical newest text promotes it in-place rather than creating a duplicate.
			const promoted = await hist.checkpoint(file, ":RETURN 1;\n", "Before refactor", 2000);
			expect(promoted.pinned).toBe(true);
			expect(promoted.label).toBe("Before refactor");
			expect(hist.list(file).length).toBe(1);

			// Checkpoint of new text creates a pinned manual snapshot.
			const created = await hist.checkpoint(file, ":RETURN 2;\n", "After refactor", 3000);
			expect(created.pinned).toBe(true);
			expect(created.source).toBe("manual");
			expect(created.label).toBe("After refactor");
			expect(hist.list(file).length).toBe(2);

			// setLabel updates label and unpins cleanly.
			expect(await hist.setLabel(file, created.id, "Renamed milestone", false)).toBe(true);
			const updated = hist.list(file)[0]!;
			expect(updated.label).toBe("Renamed milestone");
			expect(updated.pinned).toBeUndefined();
		} finally {
			hist.close();
		}
	});

	test("per-file cap, 90-day TTL, and workspace byte budget preserve pinned checkpoints and GC orphan blobs", async () => {
		const ws = join(rootTmp, "prune-ws");
		const base = join(rootTmp, "prune-base");
		mkdirSync(ws, { recursive: true });
		const fileA = join(ws, "A.ssl");
		const fileB = join(ws, "B.ssl");
		const DAY = 24 * 60 * 60 * 1000;
		const NOW = 1_760_000_000_000; // Real epoch ms (> REAL_EPOCH_FLOOR)

		// 1. Per-file keep=3 cap + TTL=30d preserves pinned checkpoints.
		const hist = new History(ws, base, { keep: 3, maxAgeMs: 30 * DAY });
		try {
			// Old pinned checkpoint (120 days ago) must survive BOTH TTL and count cap!
			await hist.checkpoint(fileA, ":RETURN 'pinned-ancient';\n", "Keep forever", NOW - 120 * DAY);
			// Old unpinned save (60 days ago) should be TTL-pruned once a fresh save arrives.
			await hist.record(fileA, ":RETURN 'old-unpinned';\n", NOW - 60 * DAY, "save");
			// 5 recent unpinned saves -> only newest 3 unpinned survive alongside the 1 pinned checkpoint.
			for (let i = 1; i <= 5; i++) {
				await hist.record(fileA, `:RETURN ${i};\n`, NOW - (6 - i) * DAY, "save");
			}
			const list = hist.list(fileA);
			expect(list.length).toBe(4);
			expect(list.filter((s) => s.pinned).map((s) => s.label)).toEqual(["Keep forever"]);
			expect(list.filter((s) => !s.pinned).length).toBe(3);
			expect(await hist.read(fileA, list.find((s) => s.pinned)!.id)).toBe(":RETURN 'pinned-ancient';\n");
		} finally {
			hist.close();
		}

		// 2. Workspace compressed byte budget evicts oldest unpinned snapshots across files and collects orphan blobs.
		const budgetBase = join(rootTmp, "budget-base");
		const budgetHist = new History(ws, budgetBase, { keep: 50, workspaceBudgetBytes: 600 });
		try {
			// Generate distinct high-entropy payloads (~400 B each) so gzip doesn't collapse them below budget.
			const payload = (seed: number) => {
				let s = `// payload ${seed}\n`;
				let x = (seed + 1) * 2654435761;
				for (let i = 0; i < 40; i++) {
					x = (Math.imul(x ^ (x >>> 15), 2246822519) + 3266489917) >>> 0;
					s += x.toString(36).padStart(7, "0") + (i % 4 === 3 ? "\n" : " ");
				}
				return s;
			};
			await budgetHist.record(fileA, payload(1), 1000, "save");
			await budgetHist.record(fileA, payload(2), 2000, "save");
			await budgetHist.record(fileB, payload(3), 3000, "save");
			await budgetHist.record(fileB, payload(4), 4000, "save");
			const st = budgetHist.stats();
			expect(st.workspaceStoredBytes).toBeLessThanOrEqual(600);
			expect(st.workspaceSnapshots).toBeLessThan(4);
			// Newest snapshot survives.
			expect(budgetHist.list(fileB).length).toBeGreaterThanOrEqual(1);
		} finally {
			budgetHist.close();
		}
	});

	test("rename() follows both exact file renames and parent folder renames", async () => {
		const ws = join(rootTmp, "rename-ws");
		const base = join(rootTmp, "rename-base");
		mkdirSync(join(ws, "old-dir"), { recursive: true });
		const file1 = join(ws, "One.ssl");
		const file1Renamed = join(ws, "OneRenamed.ssl");
		const nested = join(ws, "old-dir", "Nested.ssl");
		const nestedMoved = join(ws, "new-dir", "Nested.ssl");

		const hist = new History(ws, base);
		try {
			await hist.record(file1, ":RETURN 'v1';\n", 1000);
			await hist.record(file1, ":RETURN 'v2';\n", 2000);
			await hist.record(nested, ":RETURN 'n1';\n", 3000);

			expect(await hist.rename(file1, file1Renamed)).toBe(2);
			expect(hist.list(file1)).toEqual([]);
			expect(hist.list(file1Renamed).length).toBe(2);
			expect(await hist.read(file1Renamed, hist.list(file1Renamed)[0]!.id)).toBe(":RETURN 'v2';\n");

			expect(await hist.rename(join(ws, "old-dir"), join(ws, "new-dir"))).toBe(1);
			expect(hist.list(nested)).toEqual([]);
			expect(hist.list(nestedMoved).length).toBe(1);
			expect(await hist.read(nestedMoved, hist.list(nestedMoved)[0]!.id)).toBe(":RETURN 'n1';\n");
		} finally {
			hist.close();
		}
	});

	test("clearFile and clearWorkspace respect keepPinned and collect orphan blobs", async () => {
		const ws = join(rootTmp, "clear-ws");
		const base = join(rootTmp, "clear-base");
		mkdirSync(ws, { recursive: true });
		const fileA = join(ws, "A.ssl");
		const fileB = join(ws, "B.ssl");
		const hist = new History(ws, base);
		try {
			await hist.record(fileA, "a1", 1000);
			await hist.checkpoint(fileA, "a2-pinned", "Milestone", 2000);
			await hist.record(fileA, "a3", 3000);
			await hist.record(fileB, "b1", 4000);

			expect(await hist.clearFile(fileA, true)).toBe(2);
			expect(hist.list(fileA).map((s) => s.label)).toEqual(["Milestone"]);
			expect(hist.list(fileB).length).toBe(1);

			expect(await hist.clearWorkspace(true)).toBe(1);
			expect(hist.list(fileB)).toEqual([]);
			expect(hist.list(fileA).length).toBe(1);

			expect(await hist.clearFile(fileA, false)).toBe(1);
			expect(hist.list(fileA)).toEqual([]);
			expect(hist.stats().workspaceStoredBytes).toBe(0);
		} finally {
			hist.close();
		}
	});

	test("transparently reads, lists, labels/migrates, and deletes legacy .txt snapshots", async () => {
		const ws = join(rootTmp, "legacy-ws");
		const base = join(rootTmp, "legacy-base");
		mkdirSync(ws, { recursive: true });
		const file = join(ws, "Legacy.ssl");
		const { rootKey, relKey } = historyKey(ws, file);
		const legacyDir = join(base, rootKey, relKey);
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "1000-0.txt"), ":RETURN 'legacy-1';\n");
		writeFileSync(join(legacyDir, "2000-0.txt"), ":RETURN 'legacy-2';\n");
		writeFileSync(join(legacyDir, "PATH"), "Legacy.ssl");

		const hist = new History(ws, base);
		try {
			// Legacy snapshots appear in list() and read() even before SQLite DB exists.
			const initial = hist.list(file);
			expect(initial.map((s) => s.id)).toEqual(["2000-0", "1000-0"]);
			expect(await hist.read(file, "1000-0")).toBe(":RETURN 'legacy-1';\n");

			// Labeling a legacy snapshot migrates it into SQLite and removes its `.txt` file.
			expect(await hist.setLabel(file, "2000-0", "Migrated milestone", true)).toBe(true);
			expect(existsSync(join(legacyDir, "2000-0.txt"))).toBe(false);
			const afterLabel = hist.list(file);
			expect(afterLabel[0]!.label).toBe("Migrated milestone");
			expect(afterLabel[0]!.pinned).toBe(true);
			expect(await hist.read(file, "2000-0")).toBe(":RETURN 'legacy-2';\n");

			// Deleting the remaining legacy snapshot removes it from disk.
			expect(await hist.remove(file, "1000-0")).toBe(true);
			expect(existsSync(join(legacyDir, "1000-0.txt"))).toBe(false);
			expect(hist.list(file).map((s) => s.id)).toEqual(["2000-0"]);
		} finally {
			hist.close();
		}
	});

	test("computeLineDelta handles additions, deletions, modifications, pure EOL changes, and large-diff fallback", () => {
		expect(computeLineDelta("a\nb\n", "a\nb\n")).toEqual({ added: 0, removed: 0 });
		expect(computeLineDelta("a\r\nb\r\n", "a\nb\n")).toEqual({ added: 0, removed: 0 });
		expect(computeLineDelta("a\n", "a\nb\nc\n")).toEqual({ added: 2, removed: 0 });
		expect(computeLineDelta("a\nb\nc\n", "a\nx\nc\n")).toEqual({ added: 1, removed: 1 });
		expect(computeLineDelta("", "first\n")).toEqual({ added: 1, removed: 0 });
		// Large diff triggering multiset fallback (> 250,000 product)
		const bigA = Array.from({ length: 600 }, (_, i) => `old-${i}`).join("\n");
		const bigB = Array.from({ length: 600 }, (_, i) => (i < 500 ? `old-${i}` : `new-${i}`)).join("\n");
		expect(computeLineDelta(bigA, bigB)).toEqual({ added: 100, removed: 100 });
	});

	test("backend RPC wires historyCheckpoint, historyLabel, historyDelete, historyClear, historyStats, and rename tracking", async () => {
		const ws = join(rootTmp, "rpc-ws");
		mkdirSync(ws, { recursive: true });
		const fileA = join(ws, "Script.ssl");
		const fileB = join(ws, "Renamed.ssl");
		writeFileSync(fileA, ":RETURN 1;\n");

		const b = createBackend(makeHost(), ws);
		try {
			await b.ready;
			await b.api.write(fileA, ":RETURN 2;\n");
			await b.api.write(fileA, ":RETURN 3;\n");
			const cp = await b.api.historyCheckpoint(fileA, ":RETURN 3;\n", "Release cut");
			expect(cp?.pinned).toBe(true);
			expect(cp?.label).toBe("Release cut");

			const statsBefore = await b.api.historyStats(fileA);
			expect(statsBefore.fileSnapshots).toBe(2);

			await b.api.rename(fileA, fileB);
			const afterRename = await b.api.history(fileB);
			expect(afterRename.length).toBe(2);
			expect(afterRename[0]!.label).toBe("Release cut");

			expect(await b.api.historyLabel(fileB, afterRename[0]!.id, "Renamed cut", true)).toBe(true);
			expect((await b.api.history(fileB))[0]!.label).toBe("Renamed cut");

			const cleared = await b.api.historyClear(fileB, true);
			expect(cleared).toBe(1);
			const remaining = await b.api.history(fileB);
			expect(remaining.length).toBe(1);
			expect(await b.api.historyDelete(fileB, remaining[0]!.id)).toBe(true);
			expect(await b.api.history(fileB)).toEqual([]);
		} finally {
			b.dispose();
			const { rootKey } = historyKey(ws, ws);
			for (const suffix of ["", "-wal", "-shm"]) {
				rmSync(join(dirs.data, "history", `${rootKey}.sqlite${suffix}`), { force: true });
			}
		}
	});
});

describe("History Timeline & Time-Travel Scrubber pure helpers", () => {
	const NOW = new Date(2026, 10, 27, 15, 0, 0).getTime();
	const HOUR = 60 * 60 * 1000;
	const DAY = 24 * HOUR;

	const snaps: Snapshot[] = [
		{ id: `${NOW - 5 * 60_000}-1`, time: NOW - 5 * 60_000, size: 1200, source: "save", added: 4, removed: 1 },
		{ id: `${NOW - 5 * 60_000}-0`, time: NOW - 5 * 60_000, size: 1100, source: "manual", label: "Before refactor", pinned: true },
		{ id: `${NOW - DAY}-0`, time: NOW - DAY, size: 950, source: "replace" },
		{ id: `${NOW - 5 * DAY}-0`, time: NOW - 5 * DAY, size: 800, source: "discard" },
	];
	const commits: GitCommit[] = [
		{ sha: "aaaa1111", shortSha: "aaaa111", time: NOW - 2 * HOUR, author: "Dev", subject: "DEMO-1: add guard", path: "Rule.ssl" },
		{ sha: "bbbb2222", shortSha: "bbbb222", time: NOW - 5 * DAY - HOUR, author: "Dev", subject: "DEMO-1: initial", path: "Rule.ssl" },
	];

	test("mergeHistoryTimeline interleaves snapshots and commits newest-first with deterministic tie-breaking", () => {
		const merged = mergeHistoryTimeline(snaps, commits);
		expect(merged.map((i) => i.key)).toEqual([
			`snap:${snaps[0]!.id}`,
			`snap:${snaps[1]!.id}`,
			"git:aaaa1111",
			`snap:${snaps[2]!.id}`,
			`snap:${snaps[3]!.id}`,
			"git:bbbb2222",
		]);
		expect(snapshotSeq("5000-12")).toBe(12);
		expect(snapshotSeq("bad")).toBe(0);
	});

	test("filterHistoryTimeline filters local, git, pinned, and specific sources cleanly", () => {
		const merged = mergeHistoryTimeline(snaps, commits);
		expect(filterHistoryTimeline(merged, "all").length).toBe(6);
		expect(filterHistoryTimeline(merged, "local").length).toBe(4);
		expect(filterHistoryTimeline(merged, "git").length).toBe(2);
		expect(filterHistoryTimeline(merged, "pinned").length).toBe(1);
		expect(filterHistoryTimeline(merged, "replace").length).toBe(1);
		expect(filterHistoryTimeline(merged, "discard").length).toBe(1);
		expect(filterLabel("pinned")).toBe("Pinned checkpoints");
		expect(filterLabel("replace")).toBe("Before Replace");
	});

	test("groupTimelineByDay separates Today, Yesterday, and earlier calendar dates", () => {
		const groups = groupTimelineByDay(mergeHistoryTimeline(snaps, commits), NOW);
		expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", expect.stringMatching(/Nov 22/)]);
		expect(groups[0]!.items.length).toBe(3);
		expect(groups[1]!.items.length).toBe(1);
		expect(groups[2]!.items.length).toBe(2);
	});

	test("scrubberChronological orders revisions oldest -> newest and formatters produce crisp labels", () => {
		const merged = mergeHistoryTimeline(snaps, commits);
		const chrono = scrubberChronological(merged);
		expect(chrono[0]!.key).toBe("git:bbbb2222");
		expect(chrono[chrono.length - 1]!.key).toBe(`snap:${snaps[0]!.id}`);

		expect(sourceTitle({ source: "save" })).toBe("File Saved");
		expect(sourceTitle({ source: "discard" })).toBe("Before Discard");
		expect(sourceTitle({ source: "manual", label: "Baseline" })).toBe("Baseline");
		expect(sourceSubtitle({ source: "manual", label: "Baseline" })).toBe("Checkpoint");
		expect(sourceSubtitle({ source: "save" })).toBe("");

		expect(formatRelativeTime(NOW - 10_000, NOW)).toBe("just now");
		expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
		expect(formatRelativeTime(NOW - 3 * HOUR, NOW)).toBe("3h ago");
		expect(formatRelativeTime(NOW - DAY, NOW)).toBe("Yesterday");
		expect(formatByteSize(0)).toBe("0 B");
		expect(formatByteSize(900)).toBe("900 B");
		expect(formatByteSize(14_336)).toBe("14 KB");
		expect(formatByteSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
		expect(formatLineDelta(5, 2)).toEqual({ addedText: "+5", removedText: "−2" });
		expect(formatLineDelta(0, 0)).toBeNull();

		const stats: HistoryStats = {
			fileSnapshots: 10,
			fileRawBytes: 100_000,
			fileStoredBytes: 16_000,
			workspaceFiles: 4,
			workspaceSnapshots: 40,
			workspaceRawBytes: 400_000,
			workspaceStoredBytes: 60_000,
			dbBytes: 72_000,
		};
		expect(formatStorageSummary(stats)).toContain("84% saved");
		expect(formatWorkspaceStorageSummary(stats)).toContain("4 files");
		expect(formatWorkspaceStorageSummary(stats)).toContain("85% saved");
	});
});

describe("History Timeline — 27-theme WCAG AA contrast, icons, wiring & application skills", () => {
	test("History scrubber, active toggle, base banner, and base pill pass WCAG AA (>= 4.5:1) across all 27 built-in themes", () => {
		const allThemes = [
			...allOklchThemes().map((t) => ({ name: t.name, s: t.studio })),
			...(
				[
					["Classic Dark", dark],
					["Classic Light", light],
				] as const
			).map(([name, t]) => ({
				name,
				s: {
					sideBg: t.colors["sideBar.background"]!,
					fg: t.colors["sideBar.foreground"]!,
					strongFg: t.colors["tab.activeForeground"]!,
					accent: t.colors["focusBorder"]!,
					buttonBg: t.colors["button.background"]!,
					buttonFg: t.colors["button.foreground"]!,
				},
			})),
		];
		expect(allThemes.length).toBe(27);

		for (const { name, s } of allThemes) {
			expect(contrast(s.buttonFg, s.buttonBg), `${name} scrubber mode toggle / base pill`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.accent, 12, s.sideBg)), `${name} compare-base banner`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.accent, 16, s.sideBg)), `${name} active scrubbing row`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.fg, mixSrgb(s.fg, 4, s.sideBg)), `${name} scrubber card surface`).toBeGreaterThanOrEqual(TEXT);
		}
	});

	test("History Codicons are registered and History.tsx uses dedicated .history-row CSS", () => {
		for (const name of ["bookmark", "diff", "history", "save", "pin", "pinned", "filter", "filter-filled", "git-commit", "trash"] as const) {
			expect(ICON[name]).toBeTruthy();
		}
		const src = repoRead("src/view/panels/History.tsx");
		expect(src).toContain('class="history-title-actions"');
		expect(src).toContain('class="history-scrubber"');
		expect(src).toContain("history-row-acts");
		expect(src).not.toContain("git-row");
		expect(src).not.toContain("git-acts");
		expect(src).toContain("replaceable: true");
		expect(src).toContain("historyCheckpoint");
		expect(src).toContain("historyClear");
		expect(src).toContain("historyStats");
	});

	test("application-specific agent skills exist under .agents/skills/ with valid YAML frontmatter", () => {
		const skillsRoot = resolve(import.meta.dir, "..", ".agents", "skills");
		const expected = [
			"ssl-studio-ui-standards",
			"ssl-studio-storage",
			"ssl-studio-visual-verify",
			"ssl-studio-testing-and-git",
		];
		const found = readdirSync(skillsRoot).sort();
		for (const name of expected) {
			expect(found).toContain(name);
			const content = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
			const fm = /^---\n([\s\S]*?)\n---\n/.exec(content);
			expect(fm, `${name}/SKILL.md frontmatter`).not.toBeNull();
			expect(fm![1]).toContain(`name: ${name}`);
			expect(fm![1]).toMatch(/^description:\s+\S.{20,}/m);
		}
	});
});
