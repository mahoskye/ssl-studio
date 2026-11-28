// Local history: snapshots of workspace files kept outside the workspace in a
// per-workspace SQLite database with gzipped content-addressed deduplication
// (ADR 0052; ARCHITECTURE, "Settings and state"). Legacy `.txt` buckets from
// earlier versions remain readable transparently.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { HistoryStats, Snapshot, SnapshotSource } from "../shared/protocol";
import { dirs } from "./paths";
import { Serial } from "./serial";

const DEFAULT_KEEP = 100;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** As many copies larger than `MAX_SNAPSHOT_BYTES` as are kept of one file (`keep`): each is as large as the file was. */
const DEFAULT_KEEP_LARGE = 5;
/** Default retention window for unpinned snapshots (90 days). */
export const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Default compressed blob budget per workspace (128 MB). */
export const DEFAULT_WORKSPACE_BUDGET_BYTES = 128 * 1024 * 1024;
/** Timestamps below this (Sep 2001) are synthetic test clocks and are never age-pruned. */
const REAL_EPOCH_FLOOR = 1_000_000_000_000;
/** Minimum UTF-8 byte length before gzip compression is attempted. */
const GZIP_MIN_BYTES = 128;
/** Maximum text length for automatic line-delta computation on save. */
const MAX_DELTA_CHARS = 512 * 1024;

const SNAPSHOT_FILE = /^(\d+)-(\d+)\.txt$/;
const SNAPSHOT_ID = /^(\d+)-(\d+)$/;
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

const hash16 = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);
const sha256Hex = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");
const historySerial = new Serial();

export type HistoryOptions = {
	keep?: number;
	keepLarge?: number;
	maxAgeMs?: number;
	workspaceBudgetBytes?: number;
};

export function historyKey(root: string, path: string, caseInsensitive = CASE_INSENSITIVE): { rootKey: string; relKey: string; rel: string } {
	const normRoot = resolve(root).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
	const normPath = resolve(path).replace(/\\/g, "/");
	const rootCmp = caseInsensitive ? normRoot.toLowerCase() : normRoot;
	const pathCmp = caseInsensitive ? normPath.toLowerCase() : normPath;
	const prefix = rootCmp === "/" ? "/" : `${rootCmp}/`;
	const rel =
		pathCmp === rootCmp
			? ""
			: pathCmp.startsWith(prefix)
				? normPath.slice(prefix.length)
				: relative(rootCmp, pathCmp).replace(/\\/g, "/");
	const relForHash = caseInsensitive ? rel.toLowerCase() : rel;
	return { rootKey: hash16(rootCmp), relKey: hash16(relForHash), rel };
}

/**
 * What the person is told when a file was saved and its snapshot could not be written: what is not kept, where
 * and why in the system's own words, and that the save itself worked. A save does not fail for it, so without
 * these words nobody knew, and a discard went on promising a copy in local history that was not made.
 */
export function historyNotKept(folder: string, saved: string, reason: string): string {
	return `Local history is not being kept: a copy of ${saved} could not be written to ${folder} (${reason}). The file itself was saved. Until that folder can be written there are no earlier versions to go back to, also not of a file that is discarded. This is said once, not at every save.`;
}

/**
 * What the person is told when a step that cannot be taken back (a discard, a replace) is refused because the copy
 * of the file for local history could not be made: the step was offered with the words that the file as it was is
 * kept there, and without the copy there is no way back from it.
 */
export function copyNotKept(name: string, reason: string): string {
	return `no copy of ${name} could be kept in local history (${reason}): the file is left as it is`;
}

function splitLines(text: string): string[] {
	if (!text) return [];
	const normalized = text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Fast added/removed line counts between two file texts (exact LCS for normal diffs, O(N) multiset fallback for huge rewrites). */
export function computeLineDelta(before: string, after: string): { added: number; removed: number } {
	if (before === after) return { added: 0, removed: 0 };
	const a = splitLines(before);
	const b = splitLines(after);
	let start = 0;
	const minLen = Math.min(a.length, b.length);
	while (start < minLen && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = endA - start;
	const midB = endB - start;
	if (midA === 0) return { added: midB, removed: 0 };
	if (midB === 0) return { added: 0, removed: midA };

	if (midA * midB <= 250_000) {
		let prev = new Int32Array(midB + 1);
		let curr = new Int32Array(midB + 1);
		for (let i = 0; i < midA; i++) {
			const lineA = a[start + i];
			for (let j = 0; j < midB; j++) {
				if (lineA === b[start + j]) {
					curr[j + 1] = prev[j]! + 1;
				} else {
					const up = prev[j + 1]!;
					const left = curr[j]!;
					curr[j + 1] = up >= left ? up : left;
				}
			}
			const swap = prev;
			prev = curr;
			curr = swap;
			curr.fill(0);
		}
		const lcs = prev[midB]!;
		return { added: midB - lcs, removed: midA - lcs };
	}

	const counts = new Map<string, number>();
	for (let i = start; i < endA; i++) {
		const line = a[i]!;
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	let common = 0;
	for (let j = start; j < endB; j++) {
		const line = b[j]!;
		const n = counts.get(line) ?? 0;
		if (n > 0) {
			common++;
			if (n === 1) counts.delete(line);
			else counts.set(line, n - 1);
		}
	}
	return { added: midB - common, removed: midA - common };
}

function encodeBlob(text: string): { sha256: string; rawBytes: number; storedBytes: number; encoding: "gzip" | "raw"; data: Uint8Array } {
	const raw = Buffer.from(text, "utf8");
	const sha256 = sha256Hex(raw);
	if (raw.byteLength >= GZIP_MIN_BYTES) {
		const gz = Bun.gzipSync(raw, { level: 6 });
		if (gz.byteLength < raw.byteLength) {
			return { sha256, rawBytes: raw.byteLength, storedBytes: gz.byteLength, encoding: "gzip", data: gz };
		}
	}
	return { sha256, rawBytes: raw.byteLength, storedBytes: raw.byteLength, encoding: "raw", data: raw };
}

function decodeBlob(encoding: string, data: Uint8Array): string {
	if (encoding === "gzip") {
		return Buffer.from(Bun.gunzipSync(data as Uint8Array<ArrayBuffer>)).toString("utf8");
	}
	return Buffer.from(data).toString("utf8");
}

function validSource(value: unknown): SnapshotSource {
	switch (value) {
		case "save":
		case "discard":
		case "replace":
		case "import":
		case "restore":
		case "manual":
			return value;
		default:
			return "save";
	}
}

type SnapshotRow = {
	id: string;
	time: number;
	seq: number;
	size: number;
	sha256: string;
	source: string;
	label: string | null;
	pinned: number;
	added_lines: number | null;
	removed_lines: number | null;
};

function rowToSnapshot(row: SnapshotRow): Snapshot {
	const snap: Snapshot = {
		id: row.id,
		time: row.time,
		size: row.size,
		source: validSource(row.source),
	};
	if (row.label) snap.label = row.label;
	if (row.pinned) snap.pinned = true;
	if (typeof row.added_lines === "number") snap.added = row.added_lines;
	if (typeof row.removed_lines === "number") snap.removed = row.removed_lines;
	return snap;
}

function fileSizeOrZero(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export class History {
	private normalizedRoot: string;
	private rootKey: string;
	private dbPath: string;
	private db: Database | null = null;
	private dbIdentity: { dev: number; ino: number } | null = null;
	private keepLimit: number;
	private keepLargeLimit: number;
	private maxAgeMs: number;
	private workspaceBudgetBytes: number;

	constructor(
		root: string,
		/** The folder the snapshots of every workspace are kept in. */
		readonly base = join(dirs.data, "history"),
		options?: HistoryOptions,
	) {
		this.normalizedRoot = resolve(root);
		this.rootKey = historyKey(this.normalizedRoot, this.normalizedRoot).rootKey;
		this.dbPath = join(this.base, `${this.rootKey}.sqlite`);
		this.keepLimit = Math.max(1, options?.keep ?? DEFAULT_KEEP);
		this.keepLargeLimit = Math.max(1, options?.keepLarge ?? DEFAULT_KEEP_LARGE);
		this.maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
		this.workspaceBudgetBytes = options?.workspaceBudgetBytes ?? DEFAULT_WORKSPACE_BUDGET_BYTES;
	}

	private bucket(path: string) {
		const { rootKey, relKey, rel } = historyKey(this.normalizedRoot, path);
		return { rootKey, relKey, rel, legacyDir: join(this.base, rootKey, relKey) };
	}

	private ensureDb(create: boolean): Database | null {
		if (this.db) {
			try {
				const st = statSync(this.dbPath);
				if (st.isFile() && (!this.dbIdentity || (st.dev === this.dbIdentity.dev && st.ino === this.dbIdentity.ino))) {
					return this.db;
				}
			} catch {
				// DB file or parent directory was deleted or replaced while open; close stale fd and reopen below.
			}
			this.close();
		}
		if (!create && !existsSync(this.dbPath)) return null;
		mkdirSync(this.base, { recursive: true });
		const db = new Database(this.dbPath, { create: true });
		try {
			db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
			db.exec("PRAGMA journal_mode = WAL;");
			db.exec("PRAGMA synchronous = NORMAL;");
			db.exec("PRAGMA busy_timeout = 5000;");
			db.exec("PRAGMA foreign_keys = ON;");
			db.exec(`
				CREATE TABLE IF NOT EXISTS meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS blobs (
					sha256 TEXT PRIMARY KEY,
					raw_bytes INTEGER NOT NULL,
					stored_bytes INTEGER NOT NULL,
					encoding TEXT NOT NULL,
					data BLOB NOT NULL
				);
				CREATE TABLE IF NOT EXISTS snapshots (
					id TEXT NOT NULL,
					rel_key TEXT NOT NULL,
					rel_path TEXT NOT NULL,
					time INTEGER NOT NULL,
					seq INTEGER NOT NULL,
					size INTEGER NOT NULL,
					sha256 TEXT NOT NULL REFERENCES blobs(sha256),
					source TEXT NOT NULL DEFAULT 'save',
					label TEXT,
					pinned INTEGER NOT NULL DEFAULT 0,
					added_lines INTEGER,
					removed_lines INTEGER,
					PRIMARY KEY (rel_key, id)
				);
				CREATE INDEX IF NOT EXISTS idx_snapshots_file_order ON snapshots (rel_key, time DESC, seq DESC);
				CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots (time ASC);
				CREATE INDEX IF NOT EXISTS idx_snapshots_sha256 ON snapshots (sha256);
			`);
			db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
			db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('root', ?)").run(this.normalizedRoot);
			try {
				const st = statSync(this.dbPath);
				this.dbIdentity = { dev: st.dev, ino: st.ino };
			} catch {
				this.dbIdentity = null;
			}
			this.db = db;
			return db;
		} catch (err) {
			try {
				db.close();
			} catch {
				// Best-effort close on failed initialization.
			}
			throw err;
		}
	}

	/** Closes the underlying SQLite connection (WAL checkpointed cleanly by SQLite). */
	close(): void {
		if (!this.db) return;
		try {
			this.db.close();
		} catch {
			// Ignore close errors during shutdown.
		}
		this.db = null;
		this.dbIdentity = null;
	}

	private listLegacy(legacyDir: string): Array<Snapshot & { seq: number }> {
		if (!existsSync(legacyDir)) return [];
		let names: string[];
		try {
			names = readdirSync(legacyDir);
		} catch (e: any) {
			if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return [];
			throw e;
		}
		const entries: Array<Snapshot & { seq: number }> = [];
		for (const f of names) {
			const m = SNAPSHOT_FILE.exec(f);
			if (!m) continue;
			const time = Number(m[1]);
			const seq = Number(m[2]);
			if (!Number.isSafeInteger(time) || !Number.isSafeInteger(seq)) continue;
			try {
				const size = statSync(join(legacyDir, f)).size;
				entries.push({ id: `${m[1]}-${m[2]}`, time, size, source: "save", seq });
			} catch (e: any) {
				if (e?.code === "ENOENT") continue;
				throw e;
			}
		}
		return entries;
	}

	list(path: string): Snapshot[] {
		const { relKey, legacyDir } = this.bucket(path);
		const byId = new Map<string, Snapshot & { seq: number }>();

		for (const item of this.listLegacy(legacyDir)) {
			byId.set(item.id, item);
		}

		const db = this.ensureDb(false);
		if (db) {
			const rows = db
				.query<SnapshotRow, [string]>(
					"SELECT id, time, seq, size, sha256, source, label, pinned, added_lines, removed_lines FROM snapshots WHERE rel_key = ? ORDER BY time DESC, seq DESC",
				)
				.all(relKey);
			for (const row of rows) {
				byId.set(row.id, { ...rowToSnapshot(row), seq: row.seq });
			}
		}

		const merged = [...byId.values()];
		merged.sort((a, b) => b.time - a.time || b.seq - a.seq);
		return merged.map(({ seq: _seq, ...snap }) => snap);
	}

	async read(path: string, id: string): Promise<string> {
		if (!SNAPSHOT_ID.test(id)) throw new Error("bad snapshot id");
		const { relKey, legacyDir } = this.bucket(path);
		const db = this.ensureDb(false);
		if (db) {
			const row = db
				.query<{ encoding: string; data: Uint8Array }, [string, string]>(
					"SELECT b.encoding, b.data FROM snapshots s JOIN blobs b ON b.sha256 = s.sha256 WHERE s.rel_key = ? AND s.id = ?",
				)
				.get(relKey, id);
			if (row) return decodeBlob(row.encoding, row.data);
		}
		return Bun.file(join(legacyDir, `${id}.txt`)).text();
	}

	/**
	 * Saves `text` unless it equals the newest snapshot or exceeds the byte cap. Says whether a snapshot was
	 * written: one passed over wrote nothing, and so does not show that the folder can be written.
	 */
	async record(path: string, text: string, now = Date.now(), source: SnapshotSource = "save"): Promise<boolean> {
		if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) return false;
		const res = await this.snapshot(path, text, now, { source });
		return res.written;
	}

	/**
	 * Keeps `text` whatever its size: the copy of a file as it is, made before a step that cannot be taken back (a
	 * discard, a replace across files). Done when the text is in local history, written now or there already as the
	 * newest snapshot; throws when it could not be written. The byte cap is for saves, each of which leaves the
	 * file itself behind: a discard and a replace said that the file as it was is kept, and for a text over the cap
	 * (`record`) nothing was, with nothing said. Such a step is rare, and its copy is the only way back from it.
	 */
	async keep(path: string, text: string, now = Date.now(), source: SnapshotSource = "replace"): Promise<void> {
		await this.snapshot(path, text, now, { source });
	}

	/**
	 * Creates a pinned manual checkpoint for `path`, or promotes the newest snapshot if its text matches `text`.
	 */
	async checkpoint(path: string, text: string, label?: string, now = Date.now()): Promise<Snapshot> {
		const cleanLabel = label?.trim() ? label.trim().slice(0, 120) : undefined;
		const res = await this.snapshot(path, text, now, {
			source: "manual",
			label: cleanLabel,
			pinned: true,
			promoteDuplicate: true,
		});
		return res.snapshot;
	}

	/** Updates a snapshot's label and/or pinned state (migrating a legacy `.txt` snapshot into SQLite if needed). */
	async setLabel(path: string, id: string, label: string | null, pinned?: boolean): Promise<boolean> {
		if (!SNAPSHOT_ID.test(id)) throw new Error("bad snapshot id");
		const { relKey, rel, legacyDir } = this.bucket(path);
		const cleanLabel = label && label.trim() ? label.trim().slice(0, 120) : null;
		return historySerial.run(this.dbPath, async () => {
			const db = this.ensureDb(false);
			if (db) {
				const existing = db
					.query<{ pinned: number }, [string, string]>("SELECT pinned FROM snapshots WHERE rel_key = ? AND id = ?")
					.get(relKey, id);
				if (existing) {
					const nextPinned = pinned === undefined ? existing.pinned : pinned ? 1 : 0;
					db.query("UPDATE snapshots SET label = ?, pinned = ? WHERE rel_key = ? AND id = ?").run(cleanLabel, nextPinned, relKey, id);
					return true;
				}
			}
			// Transparent migration if user labels/pins a legacy `.txt` snapshot.
			const legacyFile = join(legacyDir, `${id}.txt`);
			if (!existsSync(legacyFile)) return false;
			const m = SNAPSHOT_ID.exec(id)!;
			const time = Number(m[1]);
			const seq = Number(m[2]);
			const text = await Bun.file(legacyFile).text();
			const blob = encodeBlob(text);
			const targetDb = this.ensureDb(true)!;
			const tx = targetDb.transaction(() => {
				targetDb
					.query("INSERT OR IGNORE INTO blobs (sha256, raw_bytes, stored_bytes, encoding, data) VALUES (?, ?, ?, ?, ?)")
					.run(blob.sha256, blob.rawBytes, blob.storedBytes, blob.encoding, blob.data);
				targetDb
					.query(
						"INSERT OR REPLACE INTO snapshots (id, rel_key, rel_path, time, seq, size, sha256, source, label, pinned, added_lines, removed_lines) VALUES (?, ?, ?, ?, ?, ?, ?, 'save', ?, ?, NULL, NULL)",
					)
					.run(id, relKey, rel, time, seq, blob.rawBytes, blob.sha256, cleanLabel, pinned ? 1 : 0);
			});
			tx();
			rmSync(legacyFile, { force: true });
			return true;
		});
	}

	/** Deletes a single snapshot (from SQLite and/or legacy `.txt`) and collects any orphaned blob. */
	async remove(path: string, id: string): Promise<boolean> {
		if (!SNAPSHOT_ID.test(id)) throw new Error("bad snapshot id");
		const { relKey, legacyDir } = this.bucket(path);
		return historySerial.run(this.dbPath, async () => {
			let removed = false;
			const db = this.ensureDb(false);
			if (db) {
				let changed = 0;
				const tx = db.transaction(() => {
					const res = db.query("DELETE FROM snapshots WHERE rel_key = ? AND id = ?").run(relKey, id);
					changed = res.changes;
					if (changed > 0) this.gcBlobs(db);
				});
				tx();
				if (changed > 0) {
					removed = true;
					this.vacuumIncremental(db);
				}
			}
			const legacyFile = join(legacyDir, `${id}.txt`);
			if (existsSync(legacyFile)) {
				rmSync(legacyFile, { force: true });
				removed = true;
			}
			return removed;
		});
	}

	/** Clears history for a single file (preserving pinned snapshots by default). Returns count removed. */
	async clearFile(path: string, keepPinned = true): Promise<number> {
		const { relKey, legacyDir } = this.bucket(path);
		return historySerial.run(this.dbPath, async () => {
			let removed = 0;
			const db = this.ensureDb(false);
			if (db) {
				let changed = 0;
				const tx = db.transaction(() => {
					const res = keepPinned
						? db.query("DELETE FROM snapshots WHERE rel_key = ? AND pinned = 0").run(relKey)
						: db.query("DELETE FROM snapshots WHERE rel_key = ?").run(relKey);
					changed = res.changes;
					if (changed > 0) this.gcBlobs(db);
				});
				tx();
				removed += changed;
				if (changed > 0) this.vacuumIncremental(db);
			}
			for (const legacy of this.listLegacy(legacyDir)) {
				rmSync(join(legacyDir, `${legacy.id}.txt`), { force: true });
				removed++;
			}
			return removed;
		});
	}

	/** Clears local history across the workspace (preserving pinned snapshots by default). Returns count removed. */
	async clearWorkspace(keepPinned = true): Promise<number> {
		return historySerial.run(this.dbPath, async () => {
			let removed = 0;
			const db = this.ensureDb(false);
			if (db) {
				let changed = 0;
				const tx = db.transaction(() => {
					const res = keepPinned
						? db.query("DELETE FROM snapshots WHERE pinned = 0").run()
						: db.query("DELETE FROM snapshots").run();
					changed = res.changes;
					if (changed > 0) this.gcBlobs(db);
				});
				tx();
				removed += changed;
				if (changed > 0) this.vacuumIncremental(db);
			}
			const legacyRoot = join(this.base, this.rootKey);
			if (existsSync(legacyRoot)) {
				try {
					for (const bucketName of readdirSync(legacyRoot)) {
						removed += this.listLegacy(join(legacyRoot, bucketName)).length;
					}
					rmSync(legacyRoot, { recursive: true, force: true });
				} catch {
					// Best-effort cleanup of legacy directory.
				}
			}
			return removed;
		});
	}

	/** Follows a file or directory rename so local history stays attached to the moved path. */
	async rename(oldPath: string, newPath: string): Promise<number> {
		const prev = this.bucket(oldPath);
		const next = this.bucket(newPath);
		if (prev.relKey === next.relKey && prev.rel === next.rel) return 0;
		return historySerial.run(this.dbPath, async () => {
			let moved = 0;
			const db = this.ensureDb(false);
			if (db) {
				const tx = db.transaction(() => {
					const moveRelKey = (fromKey: string, toKey: string, toRel: string) => {
						if (fromKey === toKey) {
							const res = db.query("UPDATE snapshots SET rel_path = ? WHERE rel_key = ?").run(toRel, fromKey);
							moved += res.changes;
							return;
						}
						const rows = db
							.query<SnapshotRow, [string]>(
								"SELECT id, time, seq, size, sha256, source, label, pinned, added_lines, removed_lines FROM snapshots WHERE rel_key = ?",
							)
							.all(fromKey);
						for (const row of rows) {
							db.query(
								"INSERT OR IGNORE INTO snapshots (id, rel_key, rel_path, time, seq, size, sha256, source, label, pinned, added_lines, removed_lines) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
							).run(
								row.id,
								toKey,
								toRel,
								row.time,
								row.seq,
								row.size,
								row.sha256,
								row.source,
								row.label,
								row.pinned,
								row.added_lines,
								row.removed_lines,
							);
							moved++;
						}
						db.query("DELETE FROM snapshots WHERE rel_key = ?").run(fromKey);
					};

					// 1. Exact file rename
					moveRelKey(prev.relKey, next.relKey, next.rel);

					// 2. Folder rename (any nested rel_path starting with `${prev.rel}/`)
					if (prev.rel) {
						const prefix = `${prev.rel}/`;
						const prefixCmp = CASE_INSENSITIVE ? prefix.toLowerCase() : prefix;
						const distinctFiles = db
							.query<{ rel_key: string; rel_path: string }, []>("SELECT DISTINCT rel_key, rel_path FROM snapshots")
							.all();
						for (const entry of distinctFiles) {
							const cmp = CASE_INSENSITIVE ? entry.rel_path.toLowerCase() : entry.rel_path;
							if (!cmp.startsWith(prefixCmp)) continue;
							const suffix = entry.rel_path.slice(prefix.length);
							const updatedRel = next.rel ? `${next.rel}/${suffix}` : suffix;
							const updatedKey = historyKey(this.normalizedRoot, join(this.normalizedRoot, updatedRel)).relKey;
							moveRelKey(entry.rel_key, updatedKey, updatedRel);
						}
					}
					if (moved > 0) this.gcBlobs(db);
				});
				tx();
			}
			// Best-effort move of legacy file bucket if present and destination does not exist.
			if (existsSync(prev.legacyDir) && !existsSync(next.legacyDir)) {
				try {
					renameSync(prev.legacyDir, next.legacyDir);
				} catch {
					// Ignore cross-device or missing legacy folder errors.
				}
			}
			return moved;
		});
	}

	/** Storage footprint statistics for one file (optional) and the whole workspace. */
	stats(path?: string): HistoryStats {
		const out: HistoryStats = {
			fileSnapshots: 0,
			fileRawBytes: 0,
			fileStoredBytes: 0,
			workspaceFiles: 0,
			workspaceSnapshots: 0,
			workspaceRawBytes: 0,
			workspaceStoredBytes: 0,
			dbBytes: fileSizeOrZero(this.dbPath) + fileSizeOrZero(`${this.dbPath}-wal`),
		};

		const db = this.ensureDb(false);
		if (db) {
			const wsSnap = db
				.query<{ files: number; snaps: number; raw: number }, []>(
					"SELECT COUNT(DISTINCT rel_key) AS files, COUNT(*) AS snaps, COALESCE(SUM(size), 0) AS raw FROM snapshots",
				)
				.get();
			const wsBlob = db
				.query<{ stored: number }, []>("SELECT COALESCE(SUM(stored_bytes), 0) AS stored FROM blobs")
				.get();
			out.workspaceFiles = wsSnap?.files ?? 0;
			out.workspaceSnapshots = wsSnap?.snaps ?? 0;
			out.workspaceRawBytes = wsSnap?.raw ?? 0;
			out.workspaceStoredBytes = wsBlob?.stored ?? 0;

			if (path) {
				const { relKey } = this.bucket(path);
				const fileSnap = db
					.query<{ snaps: number; raw: number }, [string]>(
						"SELECT COUNT(*) AS snaps, COALESCE(SUM(size), 0) AS raw FROM snapshots WHERE rel_key = ?",
					)
					.get(relKey);
				const fileBlob = db
					.query<{ stored: number }, [string]>(
						"SELECT COALESCE(SUM(b.stored_bytes), 0) AS stored FROM blobs b WHERE b.sha256 IN (SELECT DISTINCT sha256 FROM snapshots WHERE rel_key = ?)",
					)
					.get(relKey);
				out.fileSnapshots = fileSnap?.snaps ?? 0;
				out.fileRawBytes = fileSnap?.raw ?? 0;
				out.fileStoredBytes = fileBlob?.stored ?? 0;
			}
		}

		// Include any remaining legacy `.txt` snapshots for the requested file.
		if (path) {
			const { legacyDir } = this.bucket(path);
			const legacy = this.listLegacy(legacyDir);
			if (legacy.length) {
				const existingIds = new Set(
					db
						? db
								.query<{ id: string }, [string]>("SELECT id FROM snapshots WHERE rel_key = ?")
								.all(this.bucket(path).relKey)
								.map((r) => r.id)
						: [],
				);
				for (const item of legacy) {
					if (existingIds.has(item.id)) continue;
					out.fileSnapshots++;
					out.fileRawBytes += item.size;
					out.fileStoredBytes += item.size;
					out.workspaceSnapshots++;
					out.workspaceRawBytes += item.size;
					out.workspaceStoredBytes += item.size;
				}
			}
		}

		return out;
	}

	private gcBlobs(db: Database): void {
		db.exec("DELETE FROM blobs WHERE sha256 NOT IN (SELECT DISTINCT sha256 FROM snapshots)");
	}

	private vacuumIncremental(db: Database): void {
		try {
			db.exec("PRAGMA incremental_vacuum(64);");
		} catch {
			// Best-effort page reclamation.
		}
	}

	/** Writes `text` as the newest snapshot, unless it is that already. Says whether it wrote one. */
	private async snapshot(
		path: string,
		text: string,
		now: number,
		opts: { source: SnapshotSource; label?: string; pinned?: boolean; promoteDuplicate?: boolean },
	): Promise<{ written: boolean; snapshot: Snapshot }> {
		const { relKey, rel, legacyDir } = this.bucket(path);
		return historySerial.run(this.dbPath, async () => {
			const db = this.ensureDb(true)!;
			const blob = encodeBlob(text);

			// Inspect newest snapshot (checking both SQLite and legacy `.txt` files).
			const latestSql = db
				.query<SnapshotRow, [string]>(
					"SELECT id, time, seq, size, sha256, source, label, pinned, added_lines, removed_lines FROM snapshots WHERE rel_key = ? ORDER BY time DESC, seq DESC LIMIT 1",
				)
				.get(relKey);
			const legacyList = this.listLegacy(legacyDir).sort((a, b) => b.time - a.time || b.seq - a.seq);
			const latestLegacy = legacyList[0] ?? null;

			const legacyIsNewer =
				latestLegacy !== null &&
				(!latestSql || latestLegacy.time > latestSql.time || (latestLegacy.time === latestSql.time && latestLegacy.seq > latestSql.seq));

			let prevText: string | null = null;
			if (!legacyIsNewer && latestSql) {
				if (latestSql.sha256 === blob.sha256) {
					if (opts.promoteDuplicate) {
						const nextLabel = opts.label !== undefined ? opts.label : latestSql.label;
						const nextPinned = opts.pinned ? 1 : latestSql.pinned;
						db.query("UPDATE snapshots SET label = ?, pinned = ? WHERE rel_key = ? AND id = ?").run(
							nextLabel,
							nextPinned,
							relKey,
							latestSql.id,
						);
						const updated: SnapshotRow = { ...latestSql, label: nextLabel, pinned: nextPinned };
						return { written: false, snapshot: rowToSnapshot(updated) };
					}
					return { written: false, snapshot: rowToSnapshot(latestSql) };
				}
				if (text.length <= MAX_DELTA_CHARS && latestSql.size <= MAX_DELTA_CHARS) {
					const prevBlob = db
						.query<{ encoding: string; data: Uint8Array }, [string]>("SELECT encoding, data FROM blobs WHERE sha256 = ?")
						.get(latestSql.sha256);
					if (prevBlob) {
						try {
							prevText = decodeBlob(prevBlob.encoding, prevBlob.data);
						} catch {
							prevText = null;
						}
					}
				}
			} else if (latestLegacy) {
				try {
					const legacyText = await Bun.file(join(legacyDir, `${latestLegacy.id}.txt`)).text();
					if (legacyText === text && !opts.promoteDuplicate) {
						const { seq: _seq, ...snap } = latestLegacy;
						return { written: false, snapshot: snap };
					}
					if (text.length <= MAX_DELTA_CHARS && legacyText.length <= MAX_DELTA_CHARS) {
						prevText = legacyText;
					}
				} catch {
					// Legacy snapshot removed concurrently; continue recording.
				}
			}

			// Compute line delta against immediate predecessor when within fast bounds.
			const delta = prevText !== null ? computeLineDelta(prevText, text) : null;

			// Compute next sequence number for `now` across both SQLite and legacy `.txt`.
			const sqlMax = db
				.query<{ maxSeq: number | null }, [string, number]>(
					"SELECT MAX(seq) AS maxSeq FROM snapshots WHERE rel_key = ? AND time = ?",
				)
				.get(relKey, now)?.maxSeq;
			const legacySameMs = legacyList.filter((s) => s.time === now).map((s) => s.seq);
			const nextSeq = Math.max(-1, sqlMax ?? -1, ...legacySameMs) + 1;
			const id = `${now}-${nextSeq}`;
			const pinnedInt = opts.pinned ? 1 : 0;
			const labelVal = opts.label ?? null;

			let prunedAny = false;
			const tx = db.transaction(() => {
				db.query("INSERT OR IGNORE INTO blobs (sha256, raw_bytes, stored_bytes, encoding, data) VALUES (?, ?, ?, ?, ?)").run(
					blob.sha256,
					blob.rawBytes,
					blob.storedBytes,
					blob.encoding,
					blob.data,
				);
				db.query(
					"INSERT INTO snapshots (id, rel_key, rel_path, time, seq, size, sha256, source, label, pinned, added_lines, removed_lines) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				).run(
					id,
					relKey,
					rel,
					now,
					nextSeq,
					blob.rawBytes,
					blob.sha256,
					opts.source,
					labelVal,
					pinnedInt,
					delta ? delta.added : null,
					delta ? delta.removed : null,
				);

				// 1. Per-file normal cap (<= MAX_SNAPSHOT_BYTES, unpinned only).
				const excessNormal = db
					.query<{ id: string }, [string, number, number]>(
						"SELECT id FROM snapshots WHERE rel_key = ? AND pinned = 0 AND size <= ? ORDER BY time DESC, seq DESC LIMIT -1 OFFSET ?",
					)
					.all(relKey, MAX_SNAPSHOT_BYTES, this.keepLimit);
				for (const row of excessNormal) {
					db.query("DELETE FROM snapshots WHERE rel_key = ? AND id = ?").run(relKey, row.id);
					prunedAny = true;
				}

				// 2. Per-file oversized cap (> MAX_SNAPSHOT_BYTES, unpinned only).
				const excessLarge = db
					.query<{ id: string }, [string, number, number]>(
						"SELECT id FROM snapshots WHERE rel_key = ? AND pinned = 0 AND size > ? ORDER BY time DESC, seq DESC LIMIT -1 OFFSET ?",
					)
					.all(relKey, MAX_SNAPSHOT_BYTES, this.keepLargeLimit);
				for (const row of excessLarge) {
					db.query("DELETE FROM snapshots WHERE rel_key = ? AND id = ?").run(relKey, row.id);
					prunedAny = true;
				}

				// 3. Age / TTL pruning (only for real epoch timestamps; never evicts pinned snapshots).
				if (now >= REAL_EPOCH_FLOOR && this.maxAgeMs > 0) {
					const cutoff = now - this.maxAgeMs;
					const aged = db
						.query("DELETE FROM snapshots WHERE pinned = 0 AND time >= ? AND time < ? AND NOT (rel_key = ? AND id = ?)")
						.run(REAL_EPOCH_FLOOR, cutoff, relKey, id);
					if (aged.changes > 0) prunedAny = true;
				}

				if (prunedAny) this.gcBlobs(db);

				// 4. Workspace compressed-blob budget pruning (evict oldest unpinned snapshots until under budget).
				if (this.workspaceBudgetBytes > 0) {
					let totalStored =
						db.query<{ total: number }, []>("SELECT COALESCE(SUM(stored_bytes), 0) AS total FROM blobs").get()?.total ?? 0;
					let guard = 0;
					while (totalStored > this.workspaceBudgetBytes && guard < 10_000) {
						guard++;
						const victim = db
							.query<{ rel_key: string; id: string }, [string, string]>(
								"SELECT rel_key, id FROM snapshots WHERE pinned = 0 AND NOT (rel_key = ? AND id = ?) ORDER BY time ASC, seq ASC LIMIT 1",
							)
							.get(relKey, id);
						if (!victim) break;
						db.query("DELETE FROM snapshots WHERE rel_key = ? AND id = ?").run(victim.rel_key, victim.id);
						this.gcBlobs(db);
						prunedAny = true;
						totalStored =
							db.query<{ total: number }, []>("SELECT COALESCE(SUM(stored_bytes), 0) AS total FROM blobs").get()?.total ?? 0;
					}
				}
			});
			tx();

			if (prunedAny) this.vacuumIncremental(db);

			const created: Snapshot = {
				id,
				time: now,
				size: blob.rawBytes,
				source: opts.source,
				...(labelVal ? { label: labelVal } : {}),
				...(pinnedInt ? { pinned: true } : {}),
				...(delta ? { added: delta.added, removed: delta.removed } : {}),
			};
			return { written: true, snapshot: created };
		});
	}
}
