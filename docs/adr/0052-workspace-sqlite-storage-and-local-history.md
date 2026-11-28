# ADR 0052: Workspace SQLite storage and local history

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user, requesting an upgrade of local history storage to
SQLite, an audit of other areas that benefit from local database storage, and
a richer VS Code-aligned History timeline with time-travel scrubbing.

Under [ADR 0002](0002-text-is-the-source-of-truth.md),
[ADR 0009](0009-nothing-is-lost-or-destroyed-without-a-say.md),
[ADR 0032](0032-design-precedents-and-interaction-standards.md), and
[ADR 0050](0050-a-filter-is-out-of-sight-until-it-is-asked-for.md).

## Context

- `src/bun/history.ts` previously stored each saved snapshot as an
  uncompressed `<time>-<seq>.txt` file plus a `PATH` file under
  `~/.local/share/ssl-studio/history/<rootKey>/<relKey>/`.
- Keeping up to 100 uncompressed snapshots per file with no content
  deduplication, no age expiry, no workspace disk cap, and no orphan cleanup
  risked substantial disk bloat (especially for large CSV registries, SQL
  files, and plan files) and heavy filesystem churn on Windows.
- Snapshots had no metadata beyond timestamp and byte size: no source label
  (save vs discard vs replace vs import vs manual checkpoint), no pinning or
  user labels, no line-delta summaries, and no rename tracking.
- An audit of the rest of the application showed other state stores that hit
  browser `localStorage` limits or lack workspace lifecycle cleanup, while
  others must remain plain files on disk.

## Decision

### 1. Per-workspace SQLite database for local history

- Local history for each workspace lives in a single SQLite database via
  `bun:sqlite` at `~/.local/share/ssl-studio/history/<rootKey>.sqlite`.
- Every connection configures `PRAGMA auto_vacuum = INCREMENTAL`,
  `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`,
  `PRAGMA busy_timeout = 5000`, and `PRAGMA foreign_keys = ON`. Connections
  close cleanly on workspace switch and backend disposal.
- File content is stored in a content-addressed `blobs` table keyed by
  `sha256`, gzip-compressed via `Bun.gzipSync` whenever `raw_bytes >= 128`
  and compression reduces size. Reverting or duplicating file content reuses
  one blob across snapshots and files.
- The `snapshots` table records `(id, rel_key, rel_path, time, seq, size,
  sha256, source, label, pinned, added_lines, removed_lines)`.
- Retention and space bounds apply automatically on write:
  - Per-file cap of 100 unpinned normal snapshots (`<= 2 MB`) and 5 unpinned
    oversized safety copies (`> 2 MB`).
  - 90-day TTL for unpinned snapshots (real epoch timestamps only).
  - 128 MB compressed blob budget per workspace, evicting the oldest unpinned
    snapshots first.
  - Orphan blob garbage collection followed by `PRAGMA incremental_vacuum(64)`.
  - Pinned checkpoints are exempt from automatic pruning.
- Renaming a file or folder migrates its `rel_key` and `rel_path` rows so
  history follows the file.
- Legacy `<rootKey>/<relKey>/<ts>-<seq>.txt` snapshots remain readable
  transparently on `list`, `read`, `remove`, `clear`, and `setLabel` (which
  migrates a labeled legacy entry into SQLite).

### 2. Application-wide storage decision matrix

Auditing every disk and `localStorage` store in SSL Studio establishes clear
boundaries for where SQLite belongs and where plain files must stay:

| Area | Store | Decision |
| --- | --- | --- |
| Local history | Workspace SQLite | Upgraded now; gzipped blobs, dedup, TTL, 128 MB cap, checkpoints, rename tracking. |
| Agent threads | SQLite (next) | Move out of localStorage to drop the 5x40 cap and share threads across hosts. |
| Workspace UI state | SQLite kv (next) | Optional kv table for table views, search history, open tabs, and cleanup. |
| Doc and link cache | SQLite (optional) | Cache frontmatter and link indexes by mtime for large repos; text stays truth. |
| Unsaved buffers | Atomic JSON | Keep under `~/.local/state/ssl-studio/unsaved/` for crash recovery (ADR 0042). |
| Settings and themes | Plain JSON/TOML | Keep hand-editable and dotfile-friendly under `~/.config/` and `.ssl-studio/`. |
| Working documents | Plain text files | Never move to SQLite; text in the workspace stays the source of truth (ADR 0002). |

### 3. History panel timeline and time-travel scrubber

- The History panel aligns with VS Code's Timeline view: a unified
  chronological timeline grouped by day (Local snapshots and Git commits
  together), source descriptions, line-delta badges, checkpoints/pinning,
  storage stats, and header funnel filters (ADR 0050).
- Deleting a snapshot or clearing history always asks first (ADR 0009), and
  clearing defaults to keeping pinned checkpoints.
- An interactive Time-Travel Scrubber lets developers scrub across revisions
  live inside `ReviewView`, switching between **Step diff** (each revision
  against its predecessor) and **vs Current** (with one-click undoable
  restore).

## Consequences

- Typical SSL, SQL, Markdown, and CSV snapshot storage shrinks by roughly
  4x to 10x through gzip compression and content-addressed deduplication,
  while eliminating thousands of tiny files.
- Future storage migrations (Agent threads, workspace UI state, optional doc
  cache) follow the same per-workspace `bun:sqlite` pattern without ever
  moving source-of-truth workspace documents or secrets into a database.
- Users upgrading from older builds keep read access to existing `.txt`
  snapshots without any manual migration step.
