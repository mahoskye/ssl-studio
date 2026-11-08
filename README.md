# SSL Studio

A desktop IDE for STARLIMS SSL, built on Bun. Code can be read and edited as
text or as visual blocks, and the two stay in step because the text is always
the source of truth.

- **Text mode:** a full editor backed by
  [`starlims-lsp`](https://github.com/mahoskye/starlims-lsp): completion,
  hover, diagnostics, formatting, navigation, and semantic highlighting: the
  server colours parameters, `:PUBLIC` variables and undeclared names apart.
- **Blocks mode:** the same file as nested blocks. Procedures are cards,
  control flow is nested, and comment regions are coloured frames that group
  the code inside them.
- **Graph mode:** a whole workspace as procedures and data sources
  joined by their `DoProc`, `ExecFunction`, `RunDS` and `:INCLUDE` calls,
  grouped by region.
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
- **House style:** the team's Designer header, procedure doc block, spacing
  and script size limit built into templates, the formatter and a size meter.

Status: M1 to M6 done in a first version, and tested on Linux and Windows
(see the roadmap). Install and build: [docs/INSTALL.md](docs/INSTALL.md). See [docs/VISION.md](docs/VISION.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/ROADMAP.md](docs/ROADMAP.md).

## Running it

Needs [Bun](https://bun.sh), and
[`starlims-lsp`](https://github.com/mahoskye/starlims-lsp/releases) 0.30.0 on
`PATH` (or set `lspPath` in Settings). opencode 2.2.x is optional: it powers
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

Tidy runs the style guide's six `ssl-tidy-*` steps on the open file. Each
step's result opens as a diff with checks (no new findings, procedures and
parameters unchanged, comments-only for the comments step); accepting it
edits the file in the editor, and you save it.

## Keys

| Key | Does |
| --- | --- |
| Ctrl+O | Open folder |
| Ctrl+P / Ctrl+Shift+P / Ctrl+T | Go to file / command palette / symbol in workspace |
| Ctrl+S, Ctrl+Alt+S | Save (formats the changed procedures), save all |
| Ctrl+\\ | Split editor |
| Ctrl+Shift+F | Search the workspace |
| Ctrl+B, Ctrl+J | Side bar, bottom panel |
| Ctrl+Shift+A | Ask the agent about the selection |
| F1 | Editor commands |

## License

SSL Studio is MIT licensed ([LICENSE](LICENSE)). Every build carries
`THIRD-PARTY-NOTICES.md` with the licenses of what it ships:

- Monaco, Solid, vscode-textmate and vscode-oniguruma (MIT), elkjs (EPL-2.0,
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
