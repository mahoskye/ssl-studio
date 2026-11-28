---
name: ssl-studio-storage
description: Storage architecture, bun:sqlite conventions, compression, pruning, connection lifecycle, and data-boundary rules for SSL Studio. Use when adding or modifying persistent data stores, caches, local history, or workspace state in src/bun/ or src/view/.
---

# SSL Studio Storage Standards

Follow [ADR 0052](../../../docs/adr/0052-workspace-sqlite-storage-and-local-history.md) when deciding where and how state is persisted.

## Storage Decision Matrix

Choose the right storage layer before writing code:

- **Per-workspace `bun:sqlite` (`~/.local/share/ssl-studio/...`):** Best for bounded append/query stores, deduplicated binary/text snapshots, searchable history, agent conversation threads, workspace-scoped KV UI state, and rebuildable mtime-validated caches.
- **Atomic JSON files (`~/.local/state/ssl-studio/unsaved/`):** Keep for crash-isolated unsaved editor buffers (ADR 0042) where only a few dirty files exist at once and simple per-file atomic writes minimize recovery risk.
- **Plain JSON / TOML files (`~/.config/ssl-studio/`, `.ssl-studio/`):** Mandatory for user settings, imported themes, `project.toml`, and workspace settings so files remain hand-editable, diffable, and dotfile-friendly (ADR 0006).
- **Workspace text files (never SQLite):** Code, SQL, Markdown working documents, CSV registries, and `.plan.json` files must always live as plain text in the workspace (ADR 0002). Any database table indexing them is strictly a rebuildable cache, never the source of truth.

## `bun:sqlite` Conventions

When creating or extending a SQLite store in `src/bun/`:

1. **XDG paths:** Resolve directories exclusively through `dirs` in `src/bun/paths.ts` (`dirs.data`, `dirs.state`, `dirs.config`), keyed by workspace hash (`historyKey` / normalized root).
2. **Lazy initialization:** Do not create an empty `.sqlite` file on read-only queries (`list`, `stats`) when no database exists yet. Create the directory and DB file only on first write.
3. **Mandatory pragmas on open (in order):**
   ```sql
   PRAGMA auto_vacuum = INCREMENTAL;
   PRAGMA journal_mode = WAL;
   PRAGMA synchronous = NORMAL;
   PRAGMA busy_timeout = 5000;
   PRAGMA foreign_keys = ON;
   ```
4. **Schema versioning:** Store `schema_version` in a `meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)` table so future migrations are explicit and safe.
5. **Content-addressed compression for text blobs:** Hash UTF-8 bytes with SHA-256 into a `blobs` table and gzip via `Bun.gzipSync` when `raw_bytes >= 128` and the compressed payload is smaller.
6. **Bounded growth & reclamation:** Enforce explicit caps (row count, age TTL, and total compressed byte budget), exempt pinned user artifacts, delete orphaned blobs inside the write transaction, and run `PRAGMA incremental_vacuum(64)` **outside** the transaction afterward.
7. **Synthetic test clock safety:** Only apply age/TTL pruning when `now >= 1_000_000_000_000` (real epoch ms) so unit tests using small timestamps (`1000`, `5000`) behave deterministically.
8. **Serialization & lifecycle:** Serialize async writes per DB path with `Serial` (`src/bun/serial.ts`), and close handles cleanly on workspace switch and `backend.dispose()`.

## Security & Data Boundaries

- Never store credentials, API tokens, or the opencode service password (`~/.config/opencode/service.json`) inside SQLite databases or `localStorage`.
- Never commit STARLIMS work scripts, staff names, deployment hosts, or opencode transcripts in fixtures or tests (`AGENTS.md`).
- Validate every path passed over RPC with `WorkspaceFiles.inside()` before touching storage.
