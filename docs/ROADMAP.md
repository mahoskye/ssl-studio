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
- **A plan's chart has a key:** its Keys list also shows what each shape and
  line means, drawn by the chart's own rules.
- **A procedure is found by name in the graph:** typed into the bar, it is
  shown with what calls it and what it calls.
- **The graph opens as it was left:** what was folded is kept with the
  workspace.
- **Welcome** lists the recent folders as rows, each with its mark, its name
  and the end of its path.
- **The graph's finder lists its matches** under the box, with the script
  each is in; the arrow keys and Enter choose.
- **A rendered document lists its headings** beside it where the view is
  wide enough, and marks the one being read.
- **Go to file** shows each file's mark; **a plan's chart** has the graph's
  zoom controls; **Output** follows new lines and says what it is for while
  it is empty.
- **The style profile shows what it does:** a sample under the settings is
  formatted by the language server with the profile in force, and again
  whenever a setting changes.
- **A review names its two sides** ("Now" and "Proposed") over the diff, and
  says how many lines the proposal adds and takes away.
- **The plan assistant opens with where the plan stands:** spec, build, and
  the code against the chart, each with a mark and a word.
- **The status bar's line and column** open the editor's "go to line".
- **A plan's paths can be walked:** the assistant steps through them one at
  a time, and the chart lights the one shown and lists its steps.
- **Unresolved targets can be put aside** in the graph, with the lines to
  them; the choice is remembered.
- **The self-test opens the graph and a chart in the desktop app's own
  window,** and checks that each is drawn and that its picture is written
  out as a file that parses.
- **A picture can be kept:** the graph and a plan's chart each save what
  they show as an SVG file in the workspace, whole and at full size, with
  its styles written into it. A file already there is replaced only on a yes.

## From using it (2026-11-18)

What the user found in a first look at the round above, and what was done.

- **"Follow the system" follows the system.** The desktop app asks the
  system for its light or dark preference (the settings portal, on Linux): a
  GTK web view answers from GTK's own settings, which a desktop may leave on
  light while it prefers dark. In a browser the browser's answer stands.
- **The editor's right-click menu has its background.** It is drawn in a
  tree of its own outside the editor, where the theme's colours did not
  reach; they are now given to the element that holds it.
- **The editor's minimap is the editor's again.** The graph's corner map had
  the same style name, so the editor's minimap took its floating frame and
  sat over the code. The map has a name of its own, and both are quiet until
  pointed at.
- **The region tabs are to the left of the line numbers.**
- **Rulers:** one at the style profile's line length and a fainter one a set
  number of columns to each side (10 to start, 0 for none), with a setting
  for each.

- **Around a focus, one way or both:** the graph's focus view shows what the
  focus calls, what calls it, or both.
- **A step is found by its words** in a plan's chart: the one chosen is
  selected and brought into view. The graph and the chart share the find
  box.

- **The graph's bar is one row** for the whole picture: what is used now and
  then (fold, unresolved targets, keys, save picture, refresh) is in a menu,
  the counts are beside the key, and the focus is named in the choice of
  what is shown.
- **What is found or selected stays clear of the corner map,** in the graph
  and in a chart.

From a second look:

- **The rulers are much fainter:** there for the eye that looks for them,
  not seen all the time.
- **A bracket in a comment or a string is part of it.** The editor paired
  and coloured braces inside comments; each token now says when it is a
  comment or a string, so only brackets in code are paired and coloured.
- **The editor's right-click menu looks like the app's other menus:** the
  same background, border, highlight, corners and type.
- **A narrow editor has no minimap:** under 640 pixels the map would lie
  over the code it is a map of.
- **Calls gather at a folder's edge.** A node that calls three or more
  nodes of another folder, a folder of tests above all, sent a line to each
  across everything on the way, and the picture could not be followed. They
  are one line to the folder's edge now, with the number of places, and so
  are the lines of several nodes of a folder to one node outside it. Point
  at the line or at either end and the nodes it stands for stay lit while
  the rest step back. The menu draws each call again; around a focus every
  call is always drawn.
- **Whatever is pointed at, the rest steps back:** nodes with no line to the
  one pointed at fade, as the other lines already did.
- **In a narrow graph the key is one row** that scrolls sideways, with the
  counts under it; stacked, it took the room of the picture.
- **A decision is met at its points,** as on paper: every way in arrives at
  the top, the way on leaves by the bottom, and the other way leaves by a
  side. Before, they met the diamond part of the way along its slanted
  edges. A way that closes a loop from a decision is tried out of each side,
  and the chart with fewer crossings is kept.
- **The steps of a stage stand as far apart as the rest:** inside a stage
  they stood closer, and a way's label lay on the step under it.
- **The chart's bar is one row** at every width looked at: its keys and Save
  picture are in a menu, as the graph's are, and in a chart too narrow for
  the six editing buttons they are one Edit menu. A narrow bar leaves out
  the title, which the tab and the Title field say too.
- **A chart is laid out with more tries,** and of two charts with as many
  crossings the one with less line is kept: in the demo's plan the way back
  from "Was the sample's row changed?" no longer crosses the way on.
- **A size that changes twice in one frame is not an error.** The browser's
  notice of it was shown as "Something went wrong".
- **A step found by its words is put in the middle of the view,** with what
  leads to it and from it, where it used to be brought just inside the edge.
- **Around a focus, the list answers first:** what calls it and what it
  calls, side by side with their counts, each with where it is and from how
  many places. With a depth of more than one, every call within that many
  steps follows.
- **The graph's bar is shorter.** Its title is gone (the switch beside it
  says "Graph"), closing it is a cross, and in a narrow graph the zoom
  buttons are in the menu: one row for the whole picture and two around a
  focus, where there were three.
- **A picture nobody has moved stays fitted** when the window or a panel
  changes its room, in the graph and in a chart. Once it is panned or
  zoomed it is left where it was put.
- **In Blocks, what closes a line stands against it:** `:CLASS DueRule;`,
  where a gap made it `DueRule ;`.
- **A loop comes back into its decision's side.** The ways back used to
  come up both sides of a loop's decision and in at its top, so the way out
  of its side crossed one of them. They can now arrive at the decision's
  left point, all up the one side; both are laid out with the rest, and the
  chart with the fewest crossings is kept. The demo's plan has none left.
- **Fit, and Fit again for the whole picture.** Fit shows as much as stays
  legible; pressed again where that left some out of sight, it shows the
  whole graph or chart however small, and once more goes back. The 0 key
  does the same.
- **Far out, the graph names its scripts and folders.** Zoomed out past
  the point a procedure's name can be read, those words are left out and
  each script is named across its middle, each folder above it, at a size
  that reads at that zoom as far as the box allows.
- **A picture of up to 250 nodes is laid out both across and down** (it was
  150), and the one the view shows more of is kept.
- **A folder's scripts stand as a block, not in one line.** Scripts at the
  same step of a folder's calls (the callers of one helper, or scripts no
  line joins) were laid in a single row or column, as long as there were
  scripts: the demo with everything unfolded was 5080 by 7579. Six or more
  of them are now set out so many across and so many down. Unfolded, the
  demo is 7189 by 5131, close to the shape of the window, and the whole of
  it shows at 10% where it was 7%.
- **A target that did not resolve is one node.** The server names it once
  for each kind of call to it, and it was drawn once for each: the demo
  showed 19 such targets and has 13.
- **Far out, a click comes in.** Clicking a script or folder in the far
  picture brings the view in on it, as large as fits with its words
  readable; it used to focus whichever procedure was under the pointer,
  which nobody could read.
- **Moving the picture is not a click.** Dragging the graph by a node and
  letting go over it focused that node.
- **Brackets in the two built-in themes have the themes' own colours,**
  three that are told apart at a glance, where the editor's stock gold
  stood out of the dark theme.
- **The page before a folder is open says what a folder opens to:** the
  four views by name, each with a line of what it is for, the keys that
  open a folder, and the ways to all commands and to Settings. It was a
  title, a sentence and a button.
- **With no folder, the language server is not a warning.** The status bar
  said "Language server stopped" in the warning colour; it says that the
  server starts with a folder.
- **Far out, every name shown can be read.** A script's name was shrunk to
  fit its box, and in a narrow box nobody could read it. Names are now all
  one size on screen, and one that would lie over another waits for a
  closer look, the larger script's kept before the smaller's, as a map
  shows its names. The whole of the unfolded demo, at 10%, names 24 of its
  33 scripts and folders.
- **Far out, a chart names its stages.** Below 60% a step's words cannot
  be read: they are left out, and each stage is named across its middle,
  with where the chart starts and ends, at a size that reads; a name that
  would lie over another waits for a closer look. A click on a stage there
  brings the view in on it.
- **The workspace's procedures are listed by script.** Beside a plan, the
  Objects panel lists every procedure to drag into the chart; each row had
  its script's whole path after the name, and a long path left no room for
  the name at all. The path is said once, over the script's procedures,
  and a row is a name.
- **A folder opens with the panels it was left with:** the side panel and
  the bottom panel that were showing, as its tabs already did.
- **The agent's models are under headings.** A provider may offer hundreds,
  and they were one flat list: the models on this machine now come first
  under their own heading, then each other provider under its name, which
  says that its models may cost money.
- **The graph says what the pointer is on,** at once, at the foot of the
  picture: a line by its two ends and how many places, a node by what it
  is and how many lines come in and go out. The tooltip said the same after
  a wait, and a line is followed by moving along it.
- **A question to start the agent from wraps** in a narrow panel, where
  it ran past the edge and brought a sideways scroll bar.
- **The rules this work came to follow are written down** as
  [ADR 0011](adr/0011-a-picture-is-of-what-can-be-followed.md) (a picture is
  of what can be followed), and the README and the architecture notes say
  what the graph and the chart now do.
- **The status bar says where the cursor is:** the region and the procedure
  it is in, which in a long script only the Objects panel showed. A click
  shows it there. A window under 900 pixels wide has no room for it.
- **A procedure found from the list is fitted in the graph.** Finding one
  while the list was showing laid out two pictures, and the view was fitted
  to the wrong one: the focus came up small, cut off at the top, with a
  corner map it did not need. Only the last layout asked for is drawn now.

## The work, written down (2026-11-18)

Asked for by the user: the docs side of a project, driven by the tickets
the work comes from ([ADR 0012](adr/0012-a-projects-work-is-written-down.md)).

- **Documents are coloured.** Markdown, SQL, JSON, TOML, CSV, YAML, XML and
  INI, where every file that was not SSL was plain text. Their colours come
  from the active theme, as SSL's do.
- **Tickets, specs, a knowledge base and registries** each have a folder
  under `docs/`, a catalog (`INDEX.md`) the IDE writes, and a section of the
  Docs panel. A ticket is shown with its specs under it, a registry with
  how far it is.
- **A registry opens as a table.** Filtered, ordered, tallied by status, and
  edited a cell at a time, each change one piece of text.
- **The file manifest is written from the folder,** and written again says
  what is new, changed and gone, keeping a person's own status and notes.
- **A document shows what it says of itself:** its front matter above it,
  a ticket or a file as a link, and its code coloured.
- **The demo project has one of each,** invented for it.
- **Health says what the working documents need.** A catalog out of date, a
  registry that does not read as a table, a spec that is not where its
  ticket says: to fix. A document still its template, a ticket that is named
  and not there, a finished ticket whose spec is not, the open questions: to
  know. A catalog is written afresh, and a named ticket started, from the
  row that says so.
- **A link to a file that is not there is said.** Health names the file and
  opens the document at the link; the page marks the link before it is
  clicked. A file that is not there is said in plain words wherever one is
  opened, with its path as the project names it: the note used to be the
  file system's own ("ENOENT: no such file or directory, open …").
- **A link to a moved file is mended from Health.** Where one file of the
  link's name is elsewhere in the project, the row offers to point the link
  there: the link's file part is rewritten on its line, and what follows
  "#" is kept.
- **A rename takes its links along.** Renaming a file or a folder in the
  Explorer finds the links, in the workspace's Markdown documents, that led
  to the old name, and offers to point them at the new one. A link is
  placed only where it is written as a link: the same words in a block or
  a span of code are an example, and are never edited.
- **A rename rewrites front matter too.** A ticket's `specs:` line and a
  spec's `plan:` line name files from the project's top; a rename finds
  them with the links and writes the new name in each.
- **A link is written from a list.** After `](` in a Markdown document the
  project's documents are offered, the work first, and the path written is
  the way there from the document.
- **The selected row of the editor's suggest list is readable in the light
  theme.** It was white on pale blue, for SSL completion as well: the
  theme set the row's background and not its text.
- **YAML and XML say where they break.** XML is read by the browser's own
  reader, which gives the line and column. The runtime's YAML reader says
  only that it gave up, so the place is the line after the longest start
  of the document that still reads, and the note says "at or near".
- **The import was checked against what a real Jira gives out.** A public
  Jira server's "all fields" CSV export and its search API were read for
  their column names and structure, and invented tickets in those shapes
  were run through the reader. Three things did not come across, and now
  do: a sub-task's parent, which the CSV gives as the system's own number
  ("Parent id") beside each ticket's number ("Issue id"); a story's epic,
  when the row has a parent column that is empty; and the description,
  which is in Jira's wiki markup and read as headings and stray braces. A
  ticket read from the API also keeps the address a person opens for it.
- **And against what GitHub gives out.** Its own command's JSON (`gh
  issue list --json`) and its issues API were read for their field names,
  and invented issues in those shapes run through the reader. What was
  asked was not read at all: an issue keeps it under "body", and the
  reader looked under "description" only. Also: the state came across in
  capitals ("OPEN"); the link kept was the API's address, not the page; a
  pull request listed among the issues became a ticket; and an issue
  closed as not planned read as done. A description's headings now go
  under the ticket's own sections, so a ticket keeps the one title it has.
  Wiki markup is no longer guessed from the text: Markdown that holds
  "{{ }}" for a template of its own was at risk of being rewritten.
- **A registry's rows say which ticket carries them.** A `ticket` column
  in a registry ties each row to a ticket: the ticket's page lists what it
  has to carry across and how much of it has come, the table's key leads
  to the ticket, and a key that is no ticket is said in Health. The demo's
  settings registry has the column.
- **A third review, of the commits that read and rewrite links.** A second
  agent was given the diff and no conclusions, and confirmed its findings
  by running them. What it found and what was done:
  - A link's place was found by looking for its words, so an edit could
    land in an example of the link: a fence inside a list or a quotation,
    a comment, a bracket after a backslash, code indented with a tab. The
    place is now asked of the renderer: it is written over with a name of
    our own, and is the link's only if the renderer then reads that name
    as the link's target.
  - Two links to one file after a reference were taken for one place, and
    a reference used twice was edited twice. Each place is now listed once.
  - A path was written back with only its spaces escaped, so `C%23.md`
    became `C#.md` and stopped being a link to the file. A path is written
    with every mark a link cannot hold as its escape, and a rename writes
    anew only the part that was renamed.
  - A path in front matter kept a "#" tail it does not have.
  - A link to the document's own folder was written as nothing.
  - The plain wording of a missing file was applied to any message that
    held the words. It is now only the file system's own sentence, whole.
  - A file's byte-order mark was lost when the IDE wrote it. It is kept.
  - A rename that moves a document left its own links written from where
    it was. They are offered with the rest, and the folder is made.
  - Choosing a document inside a link's target left the target's tail; the
    list was offered inside a block of code; the reader of ticket keys was
    made again for every piece of text.
- **A ticket's key in the prose is a link.** Only the keys of tickets the
  project has; not in code, not in a link someone wrote, not the page's
  own ticket. A key of digits alone is one only as "#12".
- **The agent is told the work.** A plan names its ticket; the planner is
  sent what the ticket asks, the tickets around it, the open questions and
  the decisions that stand when it refines the plan or writes the spec; a
  chat is sent the same once in a conversation, on a tick box that says
  which ticket ([ADR 0013](adr/0013-the-agent-is-told-the-work-a-question-is-for.md)).
  Tried with the local model on opencode 2.3.2: asked what DEMO-103 asks
  for and which question is open, it said both from what it was sent.
- **opencode 2.3 is supported.** The machine's opencode had moved to 2.3.2
  and the Agent panel was off. The adapter works against it; its new image
  tool, its MCP resource tools and the file tools it gives a model are
  denied to every session, which leaves a model in the code mode of 2.2.5
  ([the record](spikes/opencode-api.md), section 13). The panel says why
  when opencode is there and cannot be used; it said "not found".
- **A prompt the model's context cut is said in the conversation.** With
  Ollama's default of 4096 tokens, the second question of a conversation
  that carries a ticket no longer fits, and the model answers as if it had
  not been told. The note says so and what to do.
- **Tickets are read from an export:** a table (CSV) or an API's JSON, in
  the project's folder. New tickets get their files; those already there
  have their state, title and kind brought up to date and keep everything
  else. People are left out
  ([ADR 0014](adr/0014-tickets-come-in-from-an-export.md)). Tried with
  invented exports, and checked against what Jira's own tracker says of
  its CSV: a column for each kind of link, several keys in one cell, a
  field of its own as "Custom field (…)", a parent as a number. Not tried
  with an export from a real ticket system.
- **Kept snippets are in the Palette,** under "Kept in this project": one
  is inserted at the cursor as it is written, copied, or opened to change.
- **A ticket shows its plans** as well as its specs, since a plan names its
  ticket.
- **Health shows how far each registry is,** a bar for each. Four more
  registries are offered beside settings, files and database objects:
  interfaces, scheduled jobs, reports and labels, roles and access. The
  list to choose from says what each is.
- **JSON that cannot be read says where,** in Problems and under the place:
  a trailing comma, a missing colon, a comment. A plan that cannot be read
  is marked at the place, not at its first line.
- **CSV columns keep their colour down the file.** They drifted from line to
  line: a line's end did not give the turn back to the first column.
- **A ticket's page shows its work:** under what the ticket says of
  itself, the plans drawn for it, its specs, the tickets around it, the
  questions asked and answered for it and the decisions made for it, each a
  link with its state.
- **A question or a decision can be about code.** Started with lines
  selected in a script, it takes a link to those lines, which opens them,
  and the lines as they were that day. A link to lines (`#L12`, `#L12-L18`)
  in any document opens the file there.
- **A registry is checked against the code.** "Check against code" looks
  for each row's name, as a whole word, in the project's files outside its
  documents. A row found nowhere is marked, and can be filtered to: a
  setting nothing reads. A row that is found shows how often, and that
  number opens Search on it. It is a search for a name, not a reading of
  SSL (ADR 0003).
- **A status is typed from the ones the table uses,** and the usual ones.
- **A document has an outline.** The Objects panel, the breadcrumbs and
  the status bar say where one is in a file that is not SSL: a Markdown
  document's headings, a TOML or INI file's tables and keys, a JSON
  document's keys, a SQL file's statements, a YAML file's top keys. A
  heading chosen while a document is being read scrolls the page to it.
  Where reading in the IDE stops, against the language server's ownership
  of SSL, is [ADR 0015](adr/0015-what-is-not-ssl-is-read-here.md).
- **TOML that cannot be read says where,** by the reader project.toml is
  loaded with, in plain words: a key set twice, a string not closed.
- **A document's state is changed where it is read.** On a ticket's, a
  spec's, a decision's or a question's page the status is a menu of the
  states that kind of document moves through. Choosing one changes that one
  line of the text and writes the folder's catalog afresh.
- **"Format document" lays out JSON,** a value to a line. Every string and
  number is written as it was: a number of twenty digits comes out as it
  went in. A plan keeps its own layout.
- **A registry of database objects starts from the schema.** Each table,
  view, procedure and sequence the schema folder's SQL creates is a row,
  marked found, with the file it came from.
- **The Docs panel has a filter.** Words typed narrow every list to the
  documents they are in: a title, a key, a state, what a document is
  about. A list with nothing to show is left out while filtering.
- **A row is taken out of a table** with Delete row, and Ctrl+Z in the
  table brings it back: the table's changes are the text's.
- **A question that is answered says when:** setting its status to
  answered writes the day beside it.
- **A spec the planner wrote is called what its plan is called.** It has no
  heading of its own, and was listed by its first section, "Units".
- **What done looks like is ticked off.** A task list in a rendered
  document has boxes that can be ticked: each changes the one character
  between its brackets in the text. A ticket's and a spec's row shows how
  many are ticked, and Health notes a finished one with items not ticked.
  New tickets and specs start with such a list.
- **The Work list is in the order of the work.** What is under way comes
  first, then what waits, then what is finished. A ticket that is part of
  another (an epic's story, a task's sub-task) is listed under it, and a
  parent with something under way counts as under way. Finished tickets
  beyond three fold away behind a count.
- **Tried in the app with the local model, on opencode 2.3.2:** the chat's
  ticket box, Refine on a plan started from a ticket, a tidy step with its
  skill, Write spec (a spec approved for a plan of four nodes), and a
  build of it. The build ran its three tries; the judge sent each back for
  parameter names against the house style, and nothing was written. Every
  build prompt was cut at Ollama's default 4096 tokens, and both the
  conversation and the planner said so. The test script was then run on the
  demo's plan, which is built: three tries, each prompt cut, ending in a
  review that marked "a test for every path" and "no errors" as failed and
  listed what the model got wrong. It was rejected and nothing was written.
  So every stage has now run on opencode 2.3.2 with the deny rules as they
  are; none has been tried with a larger context or a stronger model.
- **From looking at it:** in a narrow Docs panel a state is a dot in its
  tone, so the title has the room; a new document's opening prompt is not
  listed as its summary; a date is the day it is here, not in UTC; and a
  catalog open in the editor is saved with the list the IDE writes to it,
  unless it holds unsaved work.

**From a review of this code (2026-11-19).** An independent read of the
working-documents code, for defects only, found these; each has a test now
(`test/docsReview.test.ts`):

- A name with underscores lost them in titles, summaries, catalogs and the
  agent's prompt: `DUE_SOON_AT` read as `DUESOONAT`. A heading ending in a
  sharp lost it.
- A catalog could lose a person's words: with its end marker gone a second
  list was added and the next update deleted what lay between; a marker
  named in a sentence was taken for one. A marker now counts only on a line
  of its own, and a list with no end marker is replaced where it stands.
- A title with a quote or a backslash read back with its escapes showing.
- A schema written for SQL Server or Oracle gave one object: batches ended
  by `GO` or a slash were not statements, and `CREATE OR ALTER`, `FORCE`,
  `MATERIALIZED` and `EDITIONABLE` were not passed over.
- On Windows the link from a question to its code was wrong, because one
  path had its drive's letter lowered.
- `docs = "./docs"` in project.toml made every catalog read as out of
  date.
- A file renamed only in the case of its letters lost its status and note
  in the manifest; a manifest with Windows line ends was rewritten whole.
- In a table: the row Delete row takes out could be another after an undo;
  a status chip matched its word in any cell, and "no status" showed
  everything; a row added to a table of over 500 rows was not drawn.
- An export with the same ticket twice stopped the import midway. A ticket
  system that numbers its tickets had them passed over.
- Tickets under a ring of tickets that name each other as parent were
  flattened. A document set to a new state beside its plan did not get its
  catalog rewritten. A folder of over 500 tickets could crowd the other
  documents out of the list.

**From a second review (2026-11-19),** of those fixes and of what was
added after them; each has a test in the same file:

- A catalog with its end marker gone still took a heading and bullets of
  the person's own for its list. Only what a catalog writes is taken now.
  Markers shown as an example in a code fence were taken for the real ones.
- A box on a page could be a different item than the one in the text: an
  item in an HTML comment was counted, one written as a bullet in a bullet
  was not. The items are now read with the renderer's own reading, so the
  page and the text cannot differ; one that cannot be placed in the text is
  counted and not ticked.
- A line opening with a span of code in three backticks was taken for a
  fence, and hid every heading and item after it.
- `GO 5`, `GO -- note` and an indented `GO` did not end a batch; a slash
  alone on a line cut a statement that divides across lines.
- Setting a value in front matter rewrote every line end in a file with
  mixed ones, and changed the first of a key written twice where the last
  is the one read. A value with a line end in it was written on two lines.
- A query or a table kept among the decisions was offered a status, which
  would have written front matter into it.
- Two manifest rows differing only in case both became the one file. The
  ticket system's own numbers were still taken for tickets in an API's
  JSON.
- A table narrowed to a status stayed narrowed, with no chip to clear it,
  after the last such row was changed; the Docs filter could stay set with
  its box hidden.

**From walking it with the keyboard (2026-11-19, ADR 0010).**

- A working document's row has a menu (right-click, the menu key,
  Shift+F10): open it, set its state, update the catalogs or the manifest.
  A Health check's row has one too, with what puts it right; its button is
  for the pointer.
- The menu of a row was drawn only while the Explorer was showing, so one
  asked for from another panel never appeared. It is part of the window
  now.
- In a narrow Docs panel a state under way has a ring round its dot: done
  and under way were told apart by colour alone. A registry's progress is
  "7/11" there and a warning is its mark, so the title keeps the room.

**The self-test covers the working documents (2026-11-19).** The cycle
run writes a ticket with a part under it, a spec, a question and a
registry into its copy of the workspace, and checks thirteen things as a
person would meet them: the Work list's order and nesting, the registry's
progress, the catalogs written and then current, Health, the table, the
ticket's page, a state set from it, a row's menu opening and closing, and
a document's outline. The row menu that never appeared would have failed
it.

Left as they are: a ticket file whose name differs only in case from an
imported key on a file system that ignores case, and a catalog written
while its document has unsaved changes, which Health then reports.

Not done, and worth doing next:

- Reading tickets from a ticket system itself, without an export.
- The other way round from a registry's check: a table a script uses that
  no registry lists. It needs the language server to say which tables a
  script uses.

## On hold

- **Forms, client scripts and code-behind (2026-11-17).** Wanted eventually, in
  the IDE and in the demo project (`examples/due-dates`), which is server side
  only until then. No date: it starts when the user says so, not before.
