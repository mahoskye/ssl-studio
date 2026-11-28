# SSL Studio

A desktop IDE for STARLIMS SSL, built on Bun. Code can be read and edited as
text or as visual blocks, and the two stay in step because the text is always
the source of truth.

Write-ups of the work on it are at
[mahoskye.github.io/ssl-studio](https://mahoskye.github.io/ssl-studio/),
published from `site/`.

- **Text mode:** a full editor backed by
  [`starlims-lsp`](https://github.com/mahoskye/starlims-lsp): completion,
  hover, diagnostics, formatting, navigation, and semantic highlighting: the
  server colours parameters, `:PUBLIC` variables and undeclared names apart.
- **Blocks mode:** the same file as nested blocks. Procedures are cards,
  control flow is nested, and comment regions are coloured frames that group
  the code inside them.
- **Graph mode:** a whole workspace as its folders, scripts, procedures and
  data sources, joined by their `DoProc`, `ExecFunction`, `RunDS` and
  `:INCLUDE` calls and by what its classes inherit, create and call. It
  opens folded, a picture of folders or scripts to unfold from; calls into
  a folder are gathered at its edge; a focus shows one procedure's callers
  and callees; and zoomed far out it names its scripts as a map does. The
  same calls are there as a list.
- **Planning:** a process or script as a flow chart in plain words, kept as
  `design/<name>.plan.json`, with a Chart and Text view and a check that needs
  no model. An agent then asks what the chart leaves undecided, suggests changes
  you accept one by one, writes the spec, and builds from it without stopping.
  Nothing is written until you review it. Afterwards a node opens its code, differences
  between chart and code are reported, a changed chart rebuilds only what it touched,
  and each path through the chart becomes a case in an SSL test script for you to run in
  STARLIMS. On a local model that is a draft to read, not a working script
  ([design](docs/PLANNING-MODE.md)).
- **Agents:** the SSL agents and `ssl-tidy-*` cleanup skills from
  [`ssl-style-guide`](https://github.com/mahoskye/ssl-style-guide), run
  through opencode, with every change shown as a diff and checked by the
  language server before you accept it.
- **Projects and docs:** "Set up project" gives a folder its settings
  (`.ssl-studio/project.toml`), a `README.md`, an `AGENTS.md`, and folders
  for docs, schema, tests and code, each with a catalog (`INDEX.md`) that
  says what it is for and lists what it holds. The Docs panel lists the two files with
  the Markdown under `docs/`, rendered for reading, and what `schema/`
  holds by its kinds (the database's tables, the messages exchanged with
  other systems and what was agreed with them, the files read or
  written), with a catalog like the working documents'; Health says
  which are missing or still the template.
- **The work, written down:** under `docs/`, the tickets that drive the
  work, the specs written from them, a knowledge base (decisions, questions,
  snippets, prompts kept for the agent, reference notes) and registries: tables of the settings, files
  and database objects a migration must carry across. Each folder has a
  catalog the IDE keeps, the Docs panel shows each ticket with its specs
  and each registry with how far it is, and Health says what is out of
  date, not written yet, or named and not there. Tickets are read from a
  ticket system's export (CSV or JSON), without the people in it
  ([ADR 0014](docs/adr/0014-tickets-come-in-from-an-export.md)). A plan
  names its ticket, a ticket's page lists everything tied to it, a question
  or a decision can start from selected code, and the agent is told what
  the ticket asks, the open questions and the decisions already made
  ([guide](docs/WORKING-DOCUMENTS.md),
  [ADR 0012](docs/adr/0012-a-projects-work-is-written-down.md),
  [ADR 0013](docs/adr/0013-the-agent-is-told-the-work-a-question-is-for.md)).
- **Documents as what they are:** Markdown, SQL, JSON, TOML, CSV, YAML, XML
  and INI are coloured by the same themes as SSL. JSON and TOML that
  cannot be read say where, and Document outline (plus Explorer's Outline
  drawer) outlines a document: its headings, tables, keys or statements. The
  snippets a project keeps are in the Palette, to insert. A CSV opens as a
  table whose cells are edited in place, and a registry's names can be
  checked against the code; Markdown opens rendered (`Source | Live | Read`),
  with what its front matter says shown above it and its code coloured.
- **House style:** the team's Designer header, procedure doc block, spacing
  and script size limit built into templates, the formatter and a size meter.

Status: M1 to M6 done in a first version, and tested on Linux and Windows
(see the roadmap). Install and build: [docs/INSTALL.md](docs/INSTALL.md). See [docs/VISION.md](docs/VISION.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/UI-DESIGN.md](docs/UI-DESIGN.md) and
[docs/ROADMAP.md](docs/ROADMAP.md).

## Running it

Needs [Bun](https://bun.sh), and
[`starlims-lsp`](https://github.com/mahoskye/starlims-lsp/releases) 0.33.1 on
`PATH` (or set `lspPath` in Settings). opencode (2.2.5 up to 2.3.x) is optional: it powers
the Agent panel.

The app builds with [Electrobun](https://blackboard.sh/electrobun/) through
its Hutch toolchain, which downloads the Electrobun runtime on first use:

```bash
npx electrobun@2.0.5 prepare      # once: fetch Hutch and the runtime
hutch install                     # packages, from hutch.lock
hutch run start [folder]          # build and open the app
```

Other scripts:

| Script | What it does |
| --- | --- |
| `hutch run web [folder]` | The same UI in a browser tab at http://127.0.0.1:5190, for development |
| `hutch run test` | Unit tests (`bun test`) |
| `hutch run check` | Type check |
| `hutch run selftest` | Opens the app on `fixtures/workspace`, checks the editor and language server, writes `selftest.json`, quits |
| `hutch run selftest-close` | Closes the window over unsaved edits: nothing asked, and they are back next time (X11, Windows) |

A second fixture, `fixtures/sample-module`, is a whole module in STARLIMS export layout (server scripts, data sources, forms with code-behind, client scripts, resources, sidecars, and deliberately broken scripts); `hutch run start fixtures/sample-module` opens it. Its README says what the IDE does and does not open yet.
| `hutch run build` | A release build |

## The agent

The Agent panel starts its own opencode server when first used. It picks a
local model (Ollama) unless you choose another; a paid provider asks first.
To point the IDE's private server at a model without touching opencode's own
config, put opencode config JSON in the `agentServerConfig` setting
(`~/.config/ssl-studio/settings.json`), for example:

```json
{
  "agentServerConfig": "{\"provider\":{\"ollama\":{\"api\":\"http://127.0.0.1:11434/v1\",\"models\":{\"qwen3:14b\":{\"tool_call\":true}}}}}",
  "agentModel": "ollama/qwen3:14b"
}
```

A model you host yourself behind a remote provider (a gateway of your own)
looks paid to the IDE. Choose it in the Agent panel and answer "It runs on my
own machine": it is added to `agentOwnModels` in your settings, counts as
local, and is not asked about again. A project can name its model in
`.ssl-studio/project.toml` (`[agent] model = "provider/model"`).

Tidy runs the style guide's six `ssl-tidy-*` steps on the open file. Each
step's result opens as a diff with checks (no new findings, procedures and
parameters unchanged, comments-only for the comments step); accepting it
edits the file in the editor, and you save it.

## Keys

| Key | Does |
| --- | --- |
| Ctrl+N | New untitled file |
| Ctrl+O | Open folder |
| Ctrl+P, Ctrl+T | Go to file, go to symbol |
| Ctrl+Shift+P, F1 | All commands, the text editor's too |
| Ctrl+G | Go to a line of the open file |
| Ctrl+S, Ctrl+Alt+S | Save (formats the changed procedures), save all |
| Ctrl+W, Ctrl+Shift+T | Close tab, reopen the last closed tab |
| Ctrl+PageDown, Ctrl+PageUp | Next tab, previous tab |
| Ctrl+\\ | Split editor |
| Ctrl+1, Ctrl+0 | Focus the editor, focus the side panel |
| Ctrl+Shift+B | Blocks view (a plan: its chart; Markdown: rendered) |
| Ctrl+Shift+G | Call graph |
| Ctrl+Shift+F, Ctrl+Shift+E | Show Search, show Explorer |
| Ctrl+B, Ctrl+J | Side bar, bottom panel |
| Ctrl+Shift+H | Ask the agent about the selection |
| Ctrl+=, Ctrl+-, Ctrl+Shift+0 | Interface size: larger, smaller, reset |

Every shortcut can be changed in Settings (Ctrl+,). The lists and trees, the
editor tabs, Blocks, the plan chart and the call graph all work with the arrow
keys; Tab moves between them ([ADR 0010](docs/adr/0010-everything-works-from-the-keyboard.md)).

## License

SSL Studio is MIT licensed ([LICENSE](LICENSE)). Every build carries
`THIRD-PARTY-NOTICES.md` with the licenses of what it ships:

- Monaco, CodeMirror 6, Lezer, Solid, vscode-textmate and vscode-oniguruma (MIT), elkjs (EPL-2.0,
  unmodified) and the Codicons font (CC BY 4.0);
- the desktop runtime: Bun and Electrobun (MIT) with the libraries they
  link, and on Windows Microsoft's WebView2 loader.
  [third-party/](third-party/README.md) has those texts and where each comes
  from;
- starlims-lsp (MIT), whose license and notices sit beside it in `bin/`.

## Disclaimer

This is an unofficial community project and is not affiliated with, endorsed
by, or sponsored by STARLIMS. STARLIMS and related trademarks are the property
of their respective owners.
