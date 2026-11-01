# Vision

**An SSL editor for daily work that makes a long script easy to see, keeps
it in the team's style, and puts the SSL agents one click away, with nothing
accepted until the language server agrees.**

## Who it is for

The user, first: daily STARLIMS work on scripts that average 500 to 1,400
lines and sometimes pass 6,000. Then anyone else writing SSL, since the
repository is public.

## Modes

The three modes are views of one text. Switching is instant and keeps the
selection: the block under the cursor in text mode is the block selected in
blocks mode, and the reverse.

### Text mode

- Editor with SSL highlighting from the formatter extension's TextMate
  grammar.
- Completion, hover, signature help, go to definition, find references,
  rename, inlay hints, folding, format document and range, format on save.
- Diagnostics inline and in a panel, with the rule code linking to the style
  guide's rule page.
- Breadcrumbs: region › procedure › block.

### Blocks mode

- **File banner card:** the Designer header (program decision 0005) as a
  form: Description, Parameters, Returns, Date, and the modification history.
- **Region frames:** each comment region (`/* region Name;` …
  `/* endregion;`) is a coloured, collapsible frame. Regions nest. A region's
  colour is kept in the workspace's `.ssl-studio/` settings, never in the code.
- **Procedure cards:** name, `:PARAMETERS` and `:DEFAULT` as fields, the
  procedure's doc block as a form, the body as nested blocks.
- **Control-flow blocks:** `:IF`/`:ELSE`, `:WHILE`, `:FOR`, `:BEGINCASE`
  with its `:CASE` arms, `:TRY`/`:CATCH`/`:FINALLY` as nested containers with their conditions shown
  as editable text.
- **Statements** are one-line text chips, edited as text in place.
- **SQL:** `SQLExecute`, `GetDataSet`, `RunSQL` and similar calls show their
  SQL formatted, in a panel that opens from the chip.
- **Text regions:** `:REGION` … `:ENDREGION` bodies (the text payload read by
  `GetRegion`) show as embedded text panels. These are not the comment
  regions above and are never used for grouping.
- **Raw blocks:** anything the parser could not read shows as plain text,
  editable, with its diagnostic.
- **Block operations:** drag to reorder statements and procedures, move a
  procedure into or out of a region, wrap a selection in a new region or a
  control-flow block, collapse to signatures, delete with undo.

Regions are what make a long script visible: a region outline of a
6,000-line script fits on one screen, and each frame says how many lines and
procedures it holds.

### Graph mode (later)

- Nodes: scripts, procedures, data sources. Edges: `DoProc`, `ExecFunction`,
  `RunDS`, `:INCLUDE`. Regions and scripts as group boxes.
- Filters: one procedure's callers and callees, one script's neighbourhood,
  cross-script calls only.
- Shows where program decision 0006 applies: a large script called only for
  small helpers stands out.

## Panels

| Panel | What it shows |
| --- | --- |
| Explorer | Workspace files, with a size badge on scripts near or over the limit |
| Objects | The current file's regions, procedures, `:PUBLIC` variables, `:INCLUDE`s, data sources called, external procedures called. Click to go; drag in blocks mode to move |
| Palette | Insertable templates: script, procedure, region, `:IF`, `:WHILE`, `:FOR`, `:BEGINCASE`, `:TRY`, SQL call, data source. Drag into blocks mode or insert at the cursor. Templates follow the house style |
| Reference | Built-in functions, classes and keywords from the language server's bundled reference: signature, summary, link to the reference site |
| Problems | Diagnostics for the file or workspace, grouped by rule |
| Agent | The opencode session for this workspace: chat, the tidy sequence, diffs to review |
| Health | The current script against the house style: size, code lines, history entries, procedures without doc blocks, diagnostics by severity |

Panels dock left, right or bottom, and can be hidden. The layout is saved per
workspace.

## House style

A style profile, per user with per-workspace overrides, built from the
program's decisions:

- **Layout (decision 0005):** the Designer file banner, the procedure doc
  block, the fixed blank-line rule. New scripts and procedures come from
  these templates; Author is left empty unless the user sets one.
- **Size (decision 0006):** a meter in the status bar for bytes against
  50 KB, code lines against about 400, and history entries against three.
  It warns as a script nears a limit; it never blocks a save.
- **Clarity (decision 0002):** the language server's style-guide
  diagnostics, with their tiers chosen in the profile.
- **Formatter options:** indent, line length, SQL formatting, Hungarian
  notation checks: the language server's own settings, set from the profile.

## Themes

- Light and dark built-in themes, following the system by default.
- Import a VS Code colour theme (JSON): token colours map through the
  grammar's TextMate scopes, as in VS Code; the blocks view takes its frame,
  card and chip colours from the same theme.
- Region colours come from a palette that stays readable in both themes.

## Agents

- One opencode session per workspace, shown in the Agent panel.
- **Tidy:** run the style guide's `ssl-tidy-*` sequence (context, guards,
  structure, clarity, comments, verify) on the current file, one step at a
  time. After each step the IDE shows the diff and the checks that
  `run_tidy.py` made: no new findings, `:PARAMETERS` unchanged, the comments
  step changed only comments. You accept, reject or edit each step.
- **Ask about this block:** send the selected block, region or procedure with
  a question.
- **Model choice:** a local model by default. A paid provider is
  chosen per session, with a warning.
- Shell, web and outside-workspace access are denied to the agent by
  default.

## Other features

- Text and blocks side by side, with synced selection.
- A region minimap beside the scrollbar.
- Local history: a snapshot on every save, kept outside the workspace, with
  diff and restore.
- Command palette and rebindable shortcuts.
- Workspace search, with results grouped by region and procedure.
- Copy for Designer: copy the current procedure or file formatted, ready to
  paste into STARLIMS Designer.

## Not in scope

- Connecting to a STARLIMS server, checking scripts in or out, or running
  them. The IDE edits files on disk. Running code in the sandbox may come
  later as an optional, configured command (roadmap, later).
- Any SSL knowledge of the IDE's own (see AGENTS.md).
