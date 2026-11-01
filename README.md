# SSL Studio

A desktop IDE for STARLIMS SSL, built on Bun. Code can be read and edited as
text or as visual blocks, and the two stay in step because the text is always
the source of truth.

- **Text mode:** a full editor backed by
  [`starlims-lsp`](https://github.com/mahoskye/starlims-lsp): completion,
  hover, diagnostics, formatting, navigation.
- **Blocks mode:** the same file as nested blocks. Procedures are cards,
  control flow is nested, and comment regions are coloured frames that group
  the code inside them.
- **Graph mode (later):** a whole workspace as procedures and data sources
  joined by their `DoProc`, `ExecFunction`, `RunDS` and `:INCLUDE` calls,
  grouped by region.
- **Agents:** the SSL agents and `ssl-tidy-*` cleanup skills from
  [`ssl-style-guide`](https://github.com/mahoskye/ssl-style-guide), run
  through opencode, with every change shown as a diff and checked by the
  language server before you accept it.
- **House style:** the team's Designer header, procedure doc block, spacing
  and script size limit built into templates, the formatter and a size meter.

Status: planning. See [docs/VISION.md](docs/VISION.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/ROADMAP.md](docs/ROADMAP.md).

## Disclaimer

This is an unofficial community project and is not affiliated with, endorsed
by, or sponsored by STARLIMS. STARLIMS and related trademarks are the property
of their respective owners.
