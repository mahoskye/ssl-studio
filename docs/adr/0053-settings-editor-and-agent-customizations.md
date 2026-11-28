# ADR 0053: VS Code-aligned Settings Editor and Agent Customizations

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user, requesting alignment with VS Code's agent
customizations model (instructions, skills, custom agents, prompts, MCP) and
an overhaul of settings management.

Extends [ADR 0004](0004-opencode-through-its-service-api.md),
[ADR 0006](0006-a-project-has-settings-a-readme-and-an-agents-file.md),
[ADR 0026](0026-schema-is-kept-by-kind-and-prompts-are-kept.md),
[ADR 0032](0032-design-precedents-and-interaction-standards.md), and
[ADR 0050](0050-a-filter-is-out-of-sight-until-it-is-asked-for.md).

## Context

- Settings lived inside a centered modal (`SettingsDialog`) with implicit
  write scoping (writing to Workspace only if a key already existed there),
  no `@modified` filter, no per-setting reset, no raw `settings.json` view,
  and no UI for Agent settings (`agentModel`, `agentOwnModels`,
  `agentServerUrl`, `agentServerConfig`) or house-style limits (`limits.*`).
- SSL Studio introduced open-standard `.agents/skills/*/SKILL.md` files, but
  had no unified UI for browsing, creating, editing, or attaching skills,
  custom agents, scoped rules, prompt files, or MCP servers.
- Workspace configuration files from untrusted repositories must never
  silently override executable paths, billing trust, keybindings, or launch
  local `stdio` MCP commands without explicit user consent.

## Decision

### 1. VS Code-style Settings Editor

- **Full center editor tab (`CenterTabStrip`):** When a workspace is open,
  Settings (`Ctrl+,`) opens in the center workspace tab alongside open file
  tabs (`state.centerView === "settings"`). When no workspace is open,
  Settings falls back to a modal sheet so User settings remain editable from
  the Welcome screen.
- **Explicit `User` | `Workspace` scope tabs:** Each tab shows a live count
  of modified settings. Writing in Workspace scope explicitly creates or
  updates `.ssl-studio/settings.json`; resetting a setting clears it from the
  active scope (`null`).
- **Declarative schema (`src/shared/settingsSchema.ts`):** Defines categories,
  titles, descriptions, defaults, and `USER_ONLY_SETTING_KEYS` in one place.
  Powers the left category TOC (`Appearance`, `Editor`, `Markdown & Docs`,
  `SSL & Language Server`, `Agent & AI`, `History & Limits`,
  `Keyboard Shortcuts`), `@modified` / `@user` / `@workspace` / `@security`
  search filters, ADR 0050 header funnel menu + chips, modified left gutter
  bars, and per-setting Reset.
- **Settings (JSON) toggle (`settingsFile` / `saveSettingsFile`):** Allows
  validated raw editing of both User (`~/.config/ssl-studio/settings.json`)
  and Workspace (`.ssl-studio/settings.json`) files with live `jsonProblem`
  syntax checks while stripping `USER_ONLY_SETTINGS` on Workspace writes.
- **Unified Keyboard Shortcuts table:** Consolidates Global, Code Editor, and
  Markdown bindings into one searchable table with context filters, chord
  capture, and source (`Default` / `User`) indicators.

### 2. Agent Customizations Hub and Composer Integration

A dedicated **Agent Customizations** editor tab (`state.centerView ===
"customizations"`, accessible from the Agent panel header, Settings, and the
Command Palette) unifies five file-first customization types:

| Kind | Scope | Files | Role |
| --- | --- | --- | --- |
| Instructions | Workspace / User | `AGENTS.md`, `rules/` | Always-on project instructions and glob-scoped `applyTo` rule files. |
| Agent Skills | Workspace / User | `skills/*/SKILL.md` | Open-standard `SKILL.md` bundles attached explicitly into Agent prompts. |
| Custom Agents | Workspace / User | `agents/*.agent.md` | Reusable personas defining specialist instructions, skills, and model hints. |
| Prompt Files | Workspace / User | `prompts/*.md` | Reusable `/slash` templates from `docs/knowledge/prompts/` and `.agents/prompts/`. |
| MCP Servers | Workspace / User | `mcp.json` | Local `stdio` or remote HTTP/SSE servers; workspace entries require explicit trust. |

- **Deterministic prompt assembly (ADR 0004):** The Agent panel composer
  lets developers explicitly attach discovered `SKILL.md` skills (`+ Skill…`),
  select a Custom Agent persona (`*.agent.md`), and insert `/slash` prompt
  files. Selected skills and personas are injected deterministically into the
  session context slices with content-hash deduplication rather than enabling
  autonomous `skill` tool guessing on local models.
- **MCP security boundary:**
  - User servers live in `~/.config/ssl-studio/mcp.json` and are trusted by
    authorship.
  - Workspace servers (`.ssl-studio/mcp.json` or `.mcp.json`) are **never**
    trusted automatically. Trust is stored per server in User config
    (`~/.config/ssl-studio/mcp-trust.json`) keyed to a SHA-256 fingerprint of
    `(workspaceRoot, id, transport, command, args, env, url, headers)`. Any
    change to the workspace file invalidates the fingerprint and revokes
    trust automatically.
  - Only `trusted && !disabled` servers are merged into
    `OPENCODE_CONFIG_CONTENT` for SSL Studio's private opencode server, and
    opencode's MCP resource tools remain denied unless a trusted enabled
    server explicitly opts into `allowTools: true`.

## Consequences

- Developers get VS Code-familiar Settings and Agent Customizations surfaces
  without losing SSL Studio's plain-file source-of-truth guarantee (ADR 0002)
  or strict workspace-trust security boundary.
- Application skills under `.agents/skills/` are immediately discoverable,
  editable, and attachable inside the IDE itself.
- Every customization file remains ordinary Markdown or JSON checked into Git
  or stored cleanly in `~/.config/ssl-studio/`.
