# ADR 0006: A project has settings, a README and an AGENTS file

**Status:** Accepted
**Date:** 2026-11-09
**Decided by:** the user asked for project settings in a dot directory (TOML or
YAML), a README and an agents document at the root, and a side panel for the
documentation (2026-11-09).

## Context

- The user starts projects in the IDE and loses track of what a project is as
  the work goes on. The flow charts help with one script; they do not say what
  the project is for, what its rules are or where things are.
- `<workspace>/.ssl-studio/settings.json` already existed, written by the IDE.
  It holds the panel layout beside the region colours, so it changes whenever a
  panel is resized, and it cannot carry comments.
- opencode reads `AGENTS.md` from the folder it runs in, so that file already
  reaches the agents.

## Decision

- A project is a workspace folder with `.ssl-studio/project.toml`, a `README.md`
  and an `AGENTS.md` at its root.
- `project.toml` says what the project is: its name and description, where its
  folders are, and the agent model and style preset it chooses for everyone who
  opens it.
- A project has four folders, each of which `project.toml` can rename: `docs`
  (notes and decisions), `schema` (the tables the project reads and writes),
  `tests` (test scripts and what they need) and `src` (the code). The user
  asked for the schema folder and agreed the other two (2026-11-09). Tests are
  code, not documentation: the Docs panel lists `docs` and `schema` only. It is TOML because Bun reads it without a
  package and it has no indentation rules to break.
- The IDE writes `project.toml` once, from a template, and never rewrites it.
  It is edited as text, so comments survive. `settings.json` stays the file the
  IDE writes: layout, region colours, and a model picked in the Agent panel.
- Settings layer in this order, each later one winning: the user's, the
  project's, what the IDE saved for the workspace.
- "Set up project" writes the three files where they are missing and never
  overwrites one. It starts each missing folder with a short README, leaves an
  existing folder alone, and makes the code folder only where the workspace has
  no scripts yet, since an export brings its own layout. A folder that is not set up is offered it once per session,
  and works as before if the offer is turned down.
- The Docs panel lists `README.md` and `AGENTS.md` first, missing or not, then
  the Markdown in the docs folder, the schema and the plans. Health says which of the root
  files are missing or still the template.
- Markdown opens rendered, with a switch to its text. The rendered view is a
  projection of the text (ADR 0002) and its HTML is sanitised.
- Plans and tidy notes stay in `design/` (ADR 0005), whatever `project.toml`
  says.

## Consequences

- Nothing reads the schema folder yet but people and the Docs panel. Giving a
  script's tables to the agent, or checking SQL against them, needs the
  language server to say which tables a script uses (ADR 0003).
- A project carries its own description and rules, and the agents get the rules
  without the IDE passing them.
- A folder holds two settings files. The split is by who writes them: the
  person writes `project.toml`, the IDE writes `settings.json`.
- A project that names a model can name one a teammate does not have. The Agent
  panel still lets them pick another, saved with the workspace.
- `marked` and `dompurify` are now direct dependencies, at the versions
  `monaco-editor` already brought in.
