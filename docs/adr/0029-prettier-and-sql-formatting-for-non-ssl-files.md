# ADR 0029: Prettier and SQL formatting for non-SSL files

**Status:** Accepted  
**Date:** 2026-11-22  
**Decided by:** user request to format `.sql` schema/query files and other STARLIMS companion files (JavaScript, XML, HTML, CSS, JSON, YAML, Markdown) using Prettier and SQL formatting.

Under [ADR 0002](0002-text-is-the-source-of-truth.md),
[ADR 0003](0003-the-language-server-owns-ssl.md),
[ADR 0015](0015-what-is-not-ssl-is-read-here.md), and
[ADR 0019](0019-a-file-is-written-back-in-what-it-was-written-in.md).

## Context

- Real STARLIMS projects hold more than `.ssl`, `.srvscr`, and `.ds` files: standalone `.sql` schema and query scripts (SQL Server T-SQL and Oracle PL/SQL), HTML5 Form `.js`/`.ts`/`.html`/`.css` assets, `.xfd` XML Form Definitions, `.xml`/`.xsd`/`.xsl`/`.wsdl`/`.config` interface and server files, `.json`/`.jsonc` payloads, `.yaml` configs, and `.md` project documentation.
- Previously, only SSL (via `starlims-lsp`) and plain JSON (via `src/shared/jsonFormat.ts`) had document formatters. Running **Format document** (`Ctrl+Shift+I`) on `.sql` or `.xml` did nothing, and `.js`/`.ts`/`.html`/`.css`/`.xfd` fell back to plain text.
- The frontend Vite bundle is already large (`~7.4 MB`). Shipping Prettier and its parsers into the browser bundle would bloat startup and build times, while Electrobun bundles `src/bun/index.ts` as a single Bun entrypoint where dynamic `import()` plugin discovery in Node Prettier can break.

## Decision

- **SSL stays strictly with `starlims-lsp` (ADR 0003, ADR 0015).** The non-SSL formatter refuses `.ssl`, `.srvscr`, and `.ds` files and never registers a provider for `"ssl"`.
- **Format non-SSL files in the Bun backend (`src/bun/format.ts`).** Expose `formatDocument` on `BackendApi` so both the Electrobun desktop app and the browser host share one implementation without adding Prettier to the frontend bundle.
- **Use Prettier standalone with statically imported plugins plus `sql-formatter`:**
  - `prettier/standalone` with `babel`, `estree`, `typescript`, `html`, `postcss`, `yaml`, `markdown`, and `@prettier/plugin-xml` (all MIT licensed) bundles cleanly under `bun build` with no dynamic plugin resolution.
  - `sql-formatter` (MIT) formats standalone `.sql` files across STARLIMS database dialects (`tsql` default for SQL Server, `plsql` for Oracle, plus standard `sql`, `postgresql`, `mysql`, `sqlite`), inheriting the style profile's SQL keyword casing (`upper` / `lower` / `preserve`).
  - Static project Prettier configs (`.prettierrc`, `.prettierrc.json`, `.prettierrc.yml`, `.prettierrc.yaml`, `package.json#prettier`) inside the workspace are honored without executing arbitrary JavaScript config files.
- **Preserve text integrity and special layouts (ADR 0002, ADR 0019):**
  - Formatting applies through Monaco's undoable edit stack (`Ctrl+Z` restores cleanly), preserves LF/CRLF line endings, leaves `*.plan.json` untouched so plans keep their deterministic line-per-node printer, and reports syntax errors as notifications without altering the buffer.
- **Register STARLIMS companion languages and surface Format in the Folio header:**
  - Map `.xfd`, `.wsdl`, `.csproj`, `.svg` as XML and register `.js`/`.ts`/`.html`/`.css`/`.scss`/`.less`/`.cs`/`.ps1`/`.sh`/`.py` in `src/view/editor/languages.ts`.
  - Show a quiet **Format** action (and a SQL dialect switcher on `.sql` files) in the Folio header alongside `Ctrl+Shift+I`, Edit -> Format document, tab `…`, and Monaco's right-click **Format Document**.
- **Format Markdown fenced code blocks (including `ssl` via `starlims-lsp`):**
  - Fenced code blocks inside Markdown documents format both individually (a **Format** button beside **Copy** in Live Preview, right-click **Format code block**, and the `Markdown: Format code block` command in Live & Source modes) and together during whole-document **Format document** (`Ctrl+Shift+I`).
  - ```` ```ssl ```` / `srvscr` / `ds` / `starlims` fences route exclusively through `starlims-lsp` (`session.formatText`, honoring the active SSL style profile — ADR 0003). Explicit SQL dialect tags (`tsql`, `plsql`, `mysql`, `postgres`/`pgsql`, `sqlite`) override the default SQL dialect for that block, while generic `sql` uses the configured dialect. Blockquote (`> `) and list indentation prefixes are preserved cleanly, and syntax errors in one fence never corrupt surrounding prose or other blocks (ADR 0002).

| Language | Engine | Files |
| --- | --- | --- |
| SQL | `sql-formatter` | `.sql` (T-SQL, PL/SQL, SQL, Postgres, MySQL, SQLite) |
| JS / TS | Prettier | `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx` |
| Web | Prettier | `.html`, `.htm`, `.css`, `.scss`, `.less` |
| XML / XFD | Prettier XML | `.xml`, `.xfd`, `.xsd`, `.xsl`, `.xslt`, `.wsdl`, `.config`, `.csproj`, `.svg` |
| Data / Docs | Prettier | `.json`, `.jsonc` (excluding `.plan.json`), `.yml`, `.yaml`, `.md` |
| SSL | `starlims-lsp` | `.ssl`, `.srvscr`, `.ds` (unchanged, ADR 0003) |

## Consequences

- Standalone SQL, HTML5 Form code, XML/XFD definitions, configs, and docs format cleanly with zero frontend bundle growth and full desktop bundle compatibility.
- Teams with a `.prettierrc.json` get consistent formatting automatically, while STARLIMS projects without one get sensible SQL Server / Prettier defaults out of the box.
- SQL formatting inside SSL string literals remains exclusively `starlims-lsp`'s responsibility.
