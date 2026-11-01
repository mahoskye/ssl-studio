# ADR 0004: opencode through its service API, behind one adapter

**Status:** Accepted, pending the M0 API probe
**Date:** 2026-10-31
**Decided by:** the user chose to design fresh for opencode 2.2.5
(2026-10-31).

## Context

- The cleanup runner (`ssl-harness-results/agent-checks/run_tidy.py`) runs
  each step as an `opencode run` subprocess and reads its JSON output. On the
  user's remote machine a different opencode version broke it.
- opencode 2.x runs a background service with an HTTP API described by an
  OpenAPI document; `opencode api` and `--server` use it. That API is the
  stable surface; command-line output is not.

## Decision

- The IDE talks to the opencode service over HTTP and its event stream.
- All opencode calls live in one adapter module. The rest of the IDE sees a
  small interface: sessions, prompts, events, models, abort.
- The adapter states a supported version range. On connect it reads the
  service's version and refuses anything outside the range with a message
  saying what to install.
- The service password is read at run time and never stored, logged or
  committed.
- Tests use a recorded fake. Live checks run by hand, on the local model.

## Consequences

- A future opencode change touches one module, and fails loudly at connect
  rather than halfway through a tidy step.
- M0 confirms how 2.2.5 sets per-session permissions (deny shell, web and
  outside-workspace access) and loads user-level skills.

## M0 result (2026-10-31)

See [opencode-api.md](../spikes/opencode-api.md) and [M0](../spikes/M0.md).

- **Default: a private server.** The IDE starts `opencode serve --stdio
  --port 0` with a password it generates, reads the URL from the first line,
  and stops the server by closing stdin. Attaching to the background service
  (`~/.local/state/opencode/service.json`) is an option.
- **Version:** `GET /api/info`. First supported range: `>=2.2.5 <2.3.0`.
- **Auth:** HTTP Basic, user `opencode`.
- **Every session sets its model explicitly**, local by default: the
  server's own default here is a paid model.
- **Every session starts with deny rules** for `shell`, `webfetch`,
  `websearch` and `external_directory`. Enforcement is not yet confirmed.

## Prompt result (2026-11-01)

- Deny rules: `webfetch` enforced on a real call; the rest evaluate to deny,
  and add `question` for unattended runs, since a question waits forever.
- opencode ran the local model in code mode, with no file tools and no
  shell. The IDE puts the code in the prompt and applies the answer itself
  as range edits (ADR 0002); it does not rely on agent file tools.
- The private server's model is pinned with `OPENCODE_CONFIG_CONTENT`.
- A small hand-written client with types generated from `/openapi.json`, not
  `@opencode/client`, which describes itself as private.
- The SSL agents are not visible to opencode v2 (it does not read
  `~/.claude/agents`); skills are. The fix belongs to the style guide's
  installer.