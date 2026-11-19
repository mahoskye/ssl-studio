# Roadmap

Ranked. Each milestone ends in something usable.

## M0: spikes (a day or two)

**Mostly done (2026-11-01)**, results in [spikes/M0.md](spikes/M0.md).
Monaco works in WebKitGTK and in the Electrobun window, the LSP bridge works
over Electrobun's RPC, opencode's API is mapped and tried on the local
model, Solid chosen. The remote machine turned out to be Windows (see M6).

- An Electrobun window on Linux running Monaco with the TextMate grammar and
  a VS Code theme, talking to `starlims-lsp --stdio` through Bun. Decide CEF
  or system webview (ADR 0001).
- Choose the UI library (Solid or Svelte) by building the Objects panel in
  each, roughly.
- Probe the opencode 2.2.5 service API: version endpoint, sessions, prompts,
  the event stream, model list, per-session permissions, skill loading.
  Record the fake from a session on the local model (ADR 0004).
- Find out the remote machine's OS and opencode version.

## M1: a text IDE for daily use

**Done (2026-11-01).** Electrobun app and a browser host for development;
every server feature, multi-file definition and references, rename; format
on save widened to the changed procedures; local history with diff and
restore; `hutch run selftest` checks the desktop build.
Semantic highlighting from starlims-lsp 0.30.0 (L3, 2026-11-03).

- Open a folder; file tree; tabs; split editors.
- All the language server's features; format on save; the Problems panel.
- Light and dark themes; VS Code theme import.
- Status bar: language server and opencode versions, the size meter.
- Local history on save.

## M2: panels and house style

**Done (2026-11-01)**, except what waits on the language server: the Objects
panel shows what document symbols carry (regions, procedures, parameters);
`:INCLUDE`s and calls need L2. The style profile edits the server's own
`ssl` settings over a house preset (decisions 0002, 0005, 0006); the house
preset turns off `c_style_comment_closer`, which flags the Designer banner's
`*/;` closer that decision 0005 prescribes.

- Objects panel from document symbols (regions, procedures, publics, includes,
  calls).
- Palette with templates from the style profile: Designer banner, procedure
  doc block (program decision 0005).
- Reference panel.
- Health panel and the size limits (program decision 0006).
- Style profile editor, mapped to the language server's settings.
- Region minimap; breadcrumbs.

## M3: blocks mode

**First version done (2026-11-01), on what the server already gives.** The
tree is built from document symbols (comment regions, procedures and their
parameters) and folding ranges (control flow, comments, `:REGION` text):
region frames in their colours, procedure cards, control-flow blocks, code
chips coloured by the theme, the banner as a card. Selection follows the text
cursor; moves (siblings up and down), wrap in a region, delete, in-place
editing of chips and drops from the palette are all text edits on the same
model, with one undo stack. The coverage test runs over recorded server
data for every fixture.

With L1 (the server's `ssl/syntaxTree`, released in starlims-lsp 0.29.0 on
2026-11-03): statement-level chips,
`:ELSE`/`:CASE`/`:CATCH` arms as their own blocks, unreadable spans as raw
blocks. The self-test checks the tree on Linux and Windows. A block's header
shows its condition as a field (`:IF` · `Empty(sSampleId)` · `;`), cut from
the server's `headerRange`; editing it replaces only that span, as one undo
step (2026-11-03).

1. Read-only blocks view, synced selection with text mode, region frames with
   colours, collapse. The round-trip coverage test over all fixtures.
2. Block moves: reorder statements and procedures, move into or out of
   regions, wrap in a region.
3. In-place editing of chips and fields (conditions, parameters, banner and
   doc-block forms); drag from the palette.

## M4: agents

**Done (2026-11-01).** A private `opencode serve --stdio` per app run (or an
attached server), version-checked, every session with a set model (local
by default; a paid one asks first) and deny rules for shell, web,
outside-workspace access and questions. The tidy sequence runs step by
step; since the agent has no file tools (M0), the IDE supplies the file,
the note at `design/<name>.tidy.md` and the callers it finds through the
language server, and reviews each step with the runner's checks. Tests use
a fake of the API (`test/fake-opencode.ts`); the real path was checked once
on the local model. opencode 2.2.5 runs two code-mode helpers,
`worktree_create` and `session_move`, without any permission check, so no
rule or policy can deny them (found in the binary, 2026-11-01); the adapter
interrupts any turn whose code names them. That is best effort, and worth
raising with opencode.

- Agent panel: one session per workspace, model picker, local model by
  default.
- Tidy: the six `ssl-tidy-*` steps, a diff and the checks after each, accept
  or reject per step.
- "Ask about this block" from blocks and text mode.

## M5: graph mode

**First version done (2026-11-01), without L2.** The server's references
already resolve `DoProc` and `ExecFunction` targets, so the graph comes from
workspace symbols, document symbols and references: scripts as boxes (marked
near or over the size ceiling), regions inside them, procedures as nodes,
calls as edges, laid out by ELK. Filters: every call, calls between scripts,
and a procedure's or script's neighbourhood to a chosen depth. With L2 (`ssl/callGraph`, also in 0.29.0): data sources, `Include` edges
and unresolved targets as nodes, from one request. The self-test checks that
it resolves the sample's `ExecFunction` call on Linux and Windows.

## M6: packaging

**Done for Linux (2026-11-01).** `hutch run build` makes an installer and an
update bundle, with the pinned language server and the third-party notices
inside; [INSTALL.md](INSTALL.md) covers installing, building per OS and the
self-test. The remote machine is Windows (2026-11-01): paths, data folders,
`PATH` and opencode's npm shim are handled for it, and
`.github/workflows/build.yml` builds Windows, Linux and macOS installers once
the repository is on GitHub. **Run on Windows 11 (2026-11-03)** in an
evaluation VM ([tools/windows-vm](../tools/windows-vm/README.md)): tests,
release build, installer, self-test and opencode 2.2.5 pass.

- Builds for the remote machine's OS; a pinned language server bundled or
  checked; an install note.

## Later

- **Projects and docs: done in a first version (2026-11-09).** Project settings in
  `.ssl-studio/project.toml`, "Set up project" for the settings, README and AGENTS
  files, a Docs panel, Markdown rendered for reading, and missing documents flagged
  in Health ([ADR 0006](adr/0006-a-project-has-settings-a-readme-and-an-agents-file.md)).
- **Planning mode: all four stages are done (2026-11-04).** Design a process or script as
  a flow chart, let an agent ask what it leaves undecided, write the spec and build from
  it, review the result, then follow nodes to their code, see where chart and code differ,
  rebuild only what changed, and generate a test script from the chart's paths. Left: trying
  a stronger model, which needs the user's say, and drawing a chart from existing code.
  Design and build order: [PLANNING-MODE.md](PLANNING-MODE.md),
  [ADR 0005](adr/0005-a-plan-is-a-document-of-its-own.md).
- Run a procedure in the sandbox through a configured command (the sandbox is
  private; the IDE would only call it).

## Review of 2026-11-18

An adversarial review of the demo project and a UI and accessibility audit of
the app, then everything they recommended. The rules it left are
[ADR 0009](adr/0009-nothing-is-lost-or-destroyed-without-a-say.md) (nothing
is lost or destroyed without a say) and
[ADR 0010](adr/0010-everything-works-from-the-keyboard.md) (everything works
from the keyboard, and says what it is).

- **Lost work and breakage:** Blocks no longer breaks on a file that is not
  SSL; a failed save keeps the tab; opening a folder, and closing the window
  (in a browser and in the desktop app, where `hutch run selftest-close`
  presses the real close button, on Linux and on Windows 11), ask about
  unsaved files; a file changed on disk is compared
  before it is overwritten; "Set up project" lists what it will create.
- **Keyboard and focus:** one dialog that holds and returns focus; lists,
  trees, tabs, Blocks, the plan chart, the call graph and the splitters all
  work without a mouse.
- **Legibility:** both themes pass a contrast test; one scale for type,
  spacing and corners; an interface size setting; the code's font size
  reaches Blocks, diffs and rendered documents.
- **The demo project:** review fixes, a report script, an include, a rough
  script to tidy, a spec and a build record for its plan.
- **Classes:** Blocks draws a class's head as one card and a procedure with
  its doc block as one; the call graph marks class files and draws
  inheritance. Both use what the server's syntax tree already marks.
- **Classes in the call graph (L4).** In the language server since 0.31.0
  (mahoskye/starlims-lsp#373), the pinned version: an edge for an object
  created, a method called and a class inherited. The graph draws each with
  its own line, names them in its key and its list, and counts them apart
  from calls. The IDE no longer works inheritance out by itself.
- **Left for the language server** ([LSP-REQUESTS](LSP-REQUESTS.md), filed
  as mahoskye/starlims-lsp#370 to #372): the
  tables a script uses (L6), the required exception to "prefer unannotated
  procedures" (L7), and what running the demo showed the server accepts and
  STARLIMS does not (L8).
- **The demo project runs.** `bun scripts/demo-sandbox.ts` runs its tests in
  the SSL sandbox runner (a separate, private compatibility runtime). The
  first run found defects that validation had not.
- **A narrow window keeps the panel you asked for.** With room for one side
  panel of two, the one opened last is shown; before, the left one always
  won and the other's button looked pressed with nothing on screen. A panel
  with no room is not marked as open, and its button brings it back.
- **The Agent panel shows what is so.** After a reload it reads whether
  opencode is already running, and no longer says it is not.
- **The agent says why a turn failed.** A turn that fails before the model
  answers used to show "failed" and nothing else. It now shows opencode's
  reason and what to check, in the panel and in Output.

## Pictures that can be followed (2026-11-18)

The call graph and a plan's chart were hard to follow: every procedure and
call at once, in lines with sharp corners.

- **The graph opens on the scripts.** A workspace of more than 40 procedures
  opens with every script folded to one node, in its folder, with its
  procedures and inner calls counted on it. A click, Enter or X unfolds one;
  "Fold all" and "Unfold all" do the rest.
- **Lines are curves, and say how many.** A line that stands for several
  places carries the number, and is a little thicker.
- **Pointing lights a node's calls.** The pointer, or the arrow keys, light
  the lines in and out of a node and the nodes at their other ends; the rest
  step back. A line can be pointed at too, and says what it joins.
- **The key shows what is on screen,** no more.
- **A plan's chart:** lines turn in rounded corners, a loop's way back is in
  the accent, the ways in and out of the selected node stand out, and nodes
  lift off the canvas a little.
- **A map of the picture** sits in the corner of both while some of it is out
  of sight: the part in view is outlined, and a click or a drag moves it.
- **No file open:** the editor area shows the project by name and the ways
  into it, each with its keys.
- **The graph's first picture fits a screen.** A workspace of more than 24
  scripts in several folders opens with its folders folded too: the demo is
  four nodes and five lines, and unfolds a folder, then a script, at a time.
- **A folder opens as it was left:** the files that were open, in their
  groups, with the same one in front, and the Explorer's folders open as
  they were. Unsaved text is not kept; closing already asks about it.
- **Files have marks.** In the Explorer, the Docs panel and the tabs, a
  script, a data source, a plan, a document and a settings file each have
  their own glyph.
- **Reference shows the whole entry:** the signature, each parameter, what
  it returns, the errors it raises and its caveats, as the language server
  has them; and operators and predefined names are listed too.
- **Scroll bars are the theme's,** thin and without arrow buttons.
- **Health's procedures** are rows that go to the procedure, each with a bar
  of its length against the longest.
- **The graph is laid out the way that fits.** A picture of up to 150 nodes
  is laid out across and down, and the one the view shows more of is kept.
- **Objects** marks the region or procedure the cursor is in.
- **Search** results carry file marks, are set in the code's face, and mark
  a match with a tint and an underline.
- **Palette** shows what the template under the pointer or the keys inserts.
- **Problems** heads each file with its mark and a count per severity.
- **Local history** no longer draws an empty, focused list.
- **Agent** offers questions to start from before anything is asked.
- **The graph's text is 13px,** so a fitted picture can shrink further and
  stay readable, and its instructions moved into a Keys list: the demo's
  source folder, open, fits one screen whole.
- **Blocks** says the line each region and procedure starts on.
- **Settings** names its sections above the list; a name goes to its
  section, and a section's heading stays in view while its rows scroll.
- **Search** keeps a match in sight in a narrow panel.

## On hold

- **Forms, client scripts and code-behind (2026-11-17).** Wanted eventually, in
  the IDE and in the demo project (`examples/due-dates`), which is server side
  only until then. No date: it starts when the user says so, not before.
