---
name: ssl-studio-testing-and-git
description: Verification commands, source-invariant test contracts, ADR and documentation table checks, and GitHub CLI push workflow for SSL Studio. Use when running tests, adding ADRs, editing core panels, or committing and pushing changes.
---

# SSL Studio Testing, Docs & Git Workflow

## Required Verification Pipeline

Run all three checks before declaring any code change complete:

```bash
node node_modules/typescript/bin/tsc --noEmit -p .
bun test
node node_modules/vite/bin/vite.js build
```

When adding UI surfaces or tinted tokens, also write unit tests covering pure logic and WCAG AA contrast across all 27 built-in themes in `src/shared/themes.ts`.

## Source-Invariant Test Map

Several regression tests inspect panel source files directly to guard critical safety invariants. Check these before refactoring handlers or guards:

- **`src/view/panels/History.tsx`**
  - `test/pass3LowsBackendProcesses.test.ts`: Handlers `showSnapshot`, `showCommitVsCurrent`, `showCommitDiff`, `openSnapshotMenu`, and `openCommitMenu` must read `const path = fileOf(snap|commit);` on their first line; `compareTwoRevs` must check `fileOf(a)` and `b.forPath !== path`; never write `const path = activePath();` in `History.tsx`; keep `stillFor` and `rowsFor` exported.
  - `test/r6cGitReviewHistoryDiff.test.ts`: Keep untitled/workspace guard, `if (doc.binary) return notify`, `docVersion` drift checks, `if (!applyText(path, restored))`, and `activePath() !== path || doc.model.isDisposed()`.
- **`src/view/panels/Search.tsx`**
  - `test/pass4MainLowsSearchGit.test.ts`: Keep `backend.historyKeep(at)` check before `replaceInModel(...)` and replace confirmation guards.
- **`src/bun/history.ts`**
  - `test/pass4MainLowsSearchGit.test.ts`, `test/r1bSettingsHistoryHost.test.ts`, `test/bun.test.ts`: Preserve `MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024`, `${time}-${seq}` snapshot IDs, `KEEP_LARGE = 5`, `record()` boolean return, and `keep()` rejection on unwritable base.
- **`src/view/style.css` & `src/view/icons.ts`**
  - `test/r9cCssLayoutA11y.test.ts` and icon/theme tests verify CSS tokens, focus rules, and Codicon integrity.

## ADRs & Documentation Tables (ADR 0008)

- Record architectural decisions in `docs/adr/NNNN-short-title.md`. Supersede rather than rewriting existing ADRs.
- Every Markdown table in `docs/` is enforced by `src/shared/docTables.ts`:
  - At most **4 columns**.
  - Column heading length **<= 16 characters**.
  - Every cell except the last column **<= 20 characters** (one short fact per cell).
  - Last column cells **<= 100 characters**.

## Git & Public Repository Hygiene

- This repository is **public**. Never commit work STARLIMS code, staff names, deployment hosts, opencode transcripts, or credentials (`AGENTS.md`).
- Never run opencode against paid providers in tests or manually without user approval; tests use `test/fake-opencode.ts`.
- Use the GitHub CLI credential helper for non-interactive GitHub remote actions when SSH keys require a passphrase:

```bash
GIT_TERMINAL_PROMPT=0 git -c credential.helper='!gh auth git-credential' push https://github.com/mahoskye/ssl-studio.git main:main
```
