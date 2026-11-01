# Spike: opencode v2 background-service API

Probed 2026-10-31 against opencode **v2.2.5** (`@opencode/cli`, npm global
install) on Linux, to inform the design of SSL Studio's opencode adapter.

Ground rules for the probe: read-only endpoints only; no prompt was sent and
no model was called. One empty session (no prompt) was created in a scratch
directory and deleted. The service password was used in requests but never
printed. This file records **shapes, not values**: no credentials, tokens,
session contents or work-project paths.

`opencode api ...` was used where possible (it finds and authenticates to the
service itself); `curl` was used only for the event stream, with the password
read into a shell variable inside the command.

## 1. Finding and authenticating to the background service

**Discovery.** The running background service writes a state file:

- `~/.local/state/opencode/service.json`, shape
  `{ id: string, version: string, url: string, pid: number, password: string }`.
  `url` was `http://127.0.0.1:<port>`; the port is chosen at service start and
  is not fixed.
- `~/.config/opencode/service.json`, shape `{ password: string }`. It holds
  the same password as the state file (compared in-process, not printed).
- `opencode service status` prints the URL only. `opencode service get` printed
  `{}` (no non-default service settings). Other subcommands: `start`,
  `restart`, `stop`, `set`, `unset`.
- The npm package `@opencode/client` exports a `./service` entry point, which
  by its name is the official discovery helper; not downloaded or inspected.

**Auth scheme.** HTTP Basic, realm `Secure Area`.

| Request to `/api/info` | Result |
|---|---|
| no credentials | `401`, `www-authenticate: Basic realm="Secure Area"` |
| Basic, user `opencode`, the service password | `200` |
| Basic, user `admin` or empty user | `401` |
| `Authorization: Bearer <password>` | `401` |

So the header is `Authorization: Basic base64("opencode:" + password)`.
The OpenAPI document declares `security: []` on every operation and no
`securitySchemes`, so the spec does not describe the auth; it is enforced
anyway. `GET /` and other unknown non-`/api` paths return the web app's HTML
shell without auth; everything under `/api` and `/openapi.json` needs auth.

Other auth routes in the spec: `POST /api/pair` creates a short-lived,
single-use code (`{ code, expires_in }`); `GET /auth/connect/{code}` redeems
it, giving a browser a session cookie or, for a JSON request, `{ token }`
"to use as the password". `opencode pair` prints such links. A few WebSocket
routes (PTY connect, client MCP) take a one-time ticket in an
`x-opencode-ticket` header or `ticket` query parameter.

Environment variables found in the binary: `OPENCODE_PASSWORD` (alias
`OPENCODE_SERVER_PASSWORD`) sets a server's password, and is what a client
uses for `--server <url>`; the CLI's error text is "Server at ... requires a
password; set OPENCODE_PASSWORD". Also `OPENCODE_CONFIG`,
`OPENCODE_CONFIG_CONTENT` (inline config document), `OPENCODE_CONFIG_DIR`,
`OPENCODE_DISABLE_PROJECT_CONFIG`.

**`--server` and `--standalone`.** These are client flags of the CLI/TUI
(`opencode`, `opencode api`, `opencode session`, `opencode models`). By
default the CLI talks to the background service; `--server <url>` points it
at another server; `--standalone` makes it start a private server instead.
They cannot be combined. When connecting, the CLI checks the server's version
and warns "Server at ... has version ...; this client is ... Continuing
anyway." For an embedding app they matter only as a model of what to do: the
app is its own client and chooses between the shared service and a private
server.

**A private server for the app: `opencode serve`.** Flags: `--hostname`,
`--port`, `--cors <origin>` (repeatable), `--service`, `--stdio`. The CLI's
own `--standalone` runs `opencode serve --stdio --port 0` with
`OPENCODE_PASSWORD=<random>` in the child's environment. Verified by hand with
a throwaway password in a scratch directory:

- stdout carried exactly one JSON line, `{"url":"http://127.0.0.1:<port>"}`;
- Basic auth `opencode:<that password>` worked; `/api/info` reported `2.2.5`;
- the process exited cleanly (exit 0) as soon as its stdin closed, so the
  server's lifetime is tied to the parent holding the pipe.

`opencode acp` does the same thing: while it ran, a second `opencode.exe`
listened on a random loopback port and it disappeared when ACP exited.

## 2. The OpenAPI document

- Served at **`GET /openapi.json`** (auth required). `/doc` is the web app,
  not Swagger UI. `/api/openapi.json`, `/api/doc` return 404.
- `openapi: 3.1.0`, `info: { title: "opencode HttpApi", version: "0.0.1",
  description: "Experimental HttpApi surface for selected instance routes." }`.
  **`info.version` is not the product version**; do not use it for checks.
- About 350 KB, **169 operations** in 37 tags (session 44, integration 12,
  persistentPty 11, experimental 14, mcp 8, permission 8, pty 7, ...), 363
  component schemas. No `servers` entry.
- Every operation has an `operationId` (dotted, such as `session.prompt`);
  `opencode api <operationId> --param k=v -d <json>` accepts them directly.
- Most operations take `location`, a deepObject query parameter
  (`?location[directory]=/abs/path`), selecting which project directory the
  request is about. Without it the server uses its default location.
- The full document was saved outside this repository for the adapter work
  (it is regenerable with `opencode api GET /openapi.json > file`).
- Operation table: [appendix](#appendix-operation-list).

Caveat: piping `opencode api model.list` into another process truncated the
output at exactly 262 144 bytes; redirecting to a file gave the full 378 KB.
Use files or a real HTTP client for large responses.

## 3. Server version endpoint

**`GET /api/info`** (`server.info`) returns
`{ version: string, pid: integer, hostname?: string|null, urls: string[],
paths: { tmp: string }, capabilities?: { persistentPty?: boolean|null } }`.
Observed `version: "2.2.5"`, one URL, `capabilities.persistentPty: true`. The
description calls it "server identity, connection URLs, paths, and readiness
status"; the CLI's own connect check treats it as the "V2 health response".
The discovery file's `version` field gives the same value without a request.
`opencode --version` prints `opencode v2.2.5`.

## 4. Session lifecycle (from the OpenAPI; prompts not called)

All under `/api/session`. Session IDs match `^ses`, message IDs `^msg_`.
Responses wrap results in `{ data: ... }`.

| Step | Operation | Shape |
|---|---|---|
| Create | `session.create` `POST /api/session` | body `{ id?, parentID?, title?, agent?, model?: { providerID, id, variant? }, location?: { directory }, metadata?, permissions?: Rule[] }` → `{ data: Session.Info }`. **The working directory is `location.directory`** (absolute path). |
| List | `session.list` `GET /api/session` | query `limit, order(asc/desc), search, parentID, archived, directory, project, subpath, cursor` → `{ data: Session.Info[], cursor: { previous, next } }` |
| Get / update | `session.get`, `session.update` `PATCH` | update body `{ title?, metadata?, permissions?, archived? }` → 204 |
| Send prompt | `session.prompt` `POST /api/session/{id}/prompt` | body `{ text, id?, files?: [{uri, name?, description?, source?, mention?}], agents?: [{name}], skills?: [{id}], metadata?, delivery?: "steer"/"queue", resume?: boolean }` → `{ data: Session.Inbox.User }` |
| Abort | `session.interrupt` `POST /api/session/{id}/interrupt` | query `resume?` → `{ interrupted: boolean }` (false when already idle) |
| Wait | `experimental.session.wait` `POST .../wait` | blocks until the agent loop is idle → 204 |
| Messages | `session.message.list` `GET .../message` | query `limit, order, cursor, type` → `{ data: Message[], cursor }`; `session.message.get` for one |
| Delete | `session.remove` `DELETE /api/session/{id}` | deletes the session and its children → 204 |

**The prompt call is asynchronous.** Its description: "Durably admit one
session input and schedule agent-loop execution unless resume is false." It
returns the queued input (an inbox item), not the reply. Completion is known
from the event stream (`session.execution.succeeded/failed/interrupted`,
`session.idle`), or by `experimental.session.wait`. `delivery: "steer"`
injects into a running turn; `"queue"` waits its turn. `session.inbox.list`
shows queued, undelivered input; `session.inbox.cancel` withdraws one.

Other session operations: `fork`, `move`, `switchAgent`, `switchModel`,
`command` (slash command), `shell` (run one shell command in the session's
directory), `compact`, `revert.stage/clear/commit`, `diff`, `context`,
`generate` (transient text from session context, **calls a model**),
`synthetic`, `form.*`, `permission.*`, `environment`, `view`, `background`,
`active`, and `experimental.session.log` (durable per-session event log as
SSE, from an exclusive sequence `after`, live with `follow=true`).

**Message shapes** (`Session.Message.Info` union, by `type`): `user`
`{ text, files, agents, skills }`, `assistant`, `synthetic`, `system`,
`skill`, `shell` `{ command, status, exit, output }`, `agent-switched`,
`model-switched`, `location-switched`, `compaction`, `idle`
`{ outcome, error }`. An assistant message is
`{ agent, model: {providerID, id, variant?}, content: Part[], finish?,
cost?, tokens?: { input, output, reasoning, cache: { read, write } },
error?, retry?, time: { created, streamed?, completed? } }`, where a part is
`{ type: "text", text }`, `{ type: "reasoning", text, time? }` or
`{ type: "tool", id, name, executed?, state: Streaming|Running|Completed|Error, time }`.

**The empty-session check.** One session was created in a scratch directory
with a title and a three-rule deny ruleset, then:
`session.message.list` → `{ data: [], cursor: { previous: null, next: null } }`;
`session.permission.list` → `{ data: [] }`; `session.active` → `{ data: {} }`;
`session.update` (rename) → 204; `session.remove` → 204; `session.get`
afterwards → 404 `{ _tag: "SessionNotFoundError", sessionID, message }`.
The created `Session.Info` had keys `cost, id, location, permissions,
projectID, time{created, updated}, title, tokens` (all zero); `agent` and
`model` were absent until set. No model was invoked: no title generation, no
usage. Side effect: the scratch directory was registered as a project
(`project.list` grew by one; the API has no project delete).

## 5. Event stream

- **`GET /api/event`** (`event.subscribe`), `content-type: text/event-stream`,
  `cache-control: no-cache, no-transform`, `x-accel-buffering: no`. Basic auth
  as above. `opencode api event.subscribe` buffered and printed nothing in
  6 s, so use a streaming HTTP client.
- The stream is global ("across all server locations"), and **volatile**: "a
  slow consumer overflows and fails the stream, and events during
  disconnection are missed." After a reconnect, resync state from the REST
  endpoints, or replay one session from `experimental.session.log?after=<seq>`.
- Optional filter `?types=a&types=b`. With a filter, `server.connected` still
  arrives first.

Observed framing (ids replaced):

```text
data: {"id":"<id>","type":"server.connected","data":{}}

: heartbeat

```

There is **no `event:` line**: the event name is the JSON `type` field, so a
browser `EventSource` sees every event as `message`. Heartbeats are SSE
comments. During the empty-session check the stream carried, in order:

| `type` | top-level keys | `data` keys |
|---|---|---|
| `session.created` | `id, type, created, durable, location, data` | `sessionID, title, slug, location, permissions, projectID, subpath, version` |
| `project.updated` | `id, type, created, data` | `id, canonical, sandboxes, time` |
| `session.renamed` | `id, type, created, durable, data` | `sessionID, title` |
| `session.deleted` | `id, type, created, durable, data` | `sessionID` |

`durable` is `{ aggregateID, seq, version }` on session events (null on
others); `created` is a number (epoch ms).

Event types relevant to a chat UI, from the `types` parameter's enum (100+
names in all). Payload schemas are **not** in the OpenAPI document
(`V2EventEncoded` is typed as a plain string), so payload shapes beyond the
four above are unverified:

- Turn lifecycle: `session.execution.started`, `session.execution.succeeded`,
  `session.execution.failed`, `session.execution.interrupted`,
  `session.status`, `session.idle`, `session.step.started/streamed/ended/failed`,
  `session.retry.scheduled`, `session.usage.updated`.
- Streaming text: `session.text.started`, `session.text.delta`,
  `session.text.ended`; `session.reasoning.started/delta/ended`.
- Tools: `session.tool.input.started/delta/ended`, `session.tool.called`,
  `session.tool.progress`, `session.tool.success`, `session.tool.failed`;
  `session.shell.started/ended`; `session.skill.activated`.
- Input queue: `session.inbox.enqueued`, `session.inbox.delivered`,
  `session.inbox.cancelled`, `session.inbox.delivery.changed`.
- Questions to the user: `permission.asked`, `permission.replied`,
  `form.created`, `form.replied`, `form.cancelled`.
- Session bookkeeping: `session.created/deleted/renamed/forked/moved`,
  `session.agent.selected`, `session.model.selected`, `session.permissions`,
  `session.compaction.*`, `session.revert.*`.
- Environment: `filesystem.changed`, `config.updated`, `agent.updated`,
  `skill.updated`, `model.updated`, `provider.updated`, `mcp.status.changed`.

## 6. Permissions

**Rule model.** `Permission.Rule = { action: string, resource: string (glob),
effect: "allow" | "deny" | "ask" }`; a `Permission.Ruleset` is an array of
rules. Rulesets can be attached at four levels:

- global config `permissions` (`Config.InfoEncoded.permissions`);
- per agent, config `agents.<id>.permissions` (and each `Agent.Info` from
  `agent.list` reports its effective `permissions`);
- **per session**: `permissions` in the `session.create` body, changeable
  later with `session.update` (emits `session.permissions`);
- saved approvals: `permission.saved.list/update/remove` (`{ id, projectID,
  action, resource, time }`), created when the user answers "always".

Config also has `policies`, a separate allow/deny list over
`provider.use, tool.use, integration.connect, integration.use, mcp.use,
skill.use, plugin.use` — an administrative layer, not per-session.

**Action names** seen in the built-in agents' rulesets: `shell`, `webfetch`,
`websearch`, `external_directory`, `read`, `edit`, `glob`, `grep`,
`question`, `subagent`, `skill`, `browser`, and `*`. The built-in `build`
agent allows `shell`, `webfetch` and `external_directory` with resource `*`;
`read` of `*.env` files is `ask`.

**Denying shell, web fetch and outside-directory access per session**
(verified only to the extent that the server stored and echoed the rules;
enforcement was not exercised, since that would need a prompt):

```json
{ "permissions": [
  { "action": "shell",              "resource": "*", "effect": "deny" },
  { "action": "webfetch",           "resource": "*", "effect": "deny" },
  { "action": "external_directory", "resource": "*", "effect": "deny" }
] }
```

Add `websearch` too if web search should be off. How session rules combine
with agent rules (which wins, and whether order matters, as in "last match
wins") was not determined.

**How the server asks and the client answers.**

1. A tool needs approval. The server creates a `Permission.Request`
   `{ id, sessionID, action, resources: string[], save?: string[], metadata?,
   source?: { type: "tool", messageID, id }, message? }` and emits
   `permission.asked`.
2. The client finds pending requests from the event or by polling
   `GET /api/session/{sessionID}/permission` or
   `GET /api/permission/request?location[directory]=...`.
3. The client replies with **`POST /api/session/{sessionID}/permission/{requestID}/reply`**,
   body `{ decision: "once" | "always" | "reject", message?: string }` → 204.
   `permission.replied` follows.

`session.permission.create` lets a client or plugin ask the server to
evaluate a permission (it returns `{ id, effect }`). The `question` tool uses
the parallel **forms** mechanism: `form.created` event, `GET /api/form` or
`session.form.list`, answer with `POST .../form/{formID}/reply`
`{ answer: object }`. The CLI's `--auto` flag auto-approves anything not
explicitly denied; the API has no such switch, so an embedding app must
answer or deny.

## 7. Skills and agents

**Listing.** `GET /api/skill` (`skill.list`) →
`{ location, data: [{ id, name, description?, autoinvoke?, path, content }] }`
(`content` is the whole skill body). `GET /api/agent` (`agent.list`) →
`{ location, data: [{ id, name, description?, mode: "primary"|"subagent"|"all",
hidden, model?, steps?, color?, system?, request, permissions }] }`.
`GET /api/command` lists slash commands (`{ name, description? }`; observed
`init`, `review`, `goal`).

**Observed on this machine** (location = a scratch directory):

- Skills: 19, of which three are built in (`opencode`, `report`, `browser`)
  and 16 come from `~/.claude/skills`, including all six `ssl-tidy-*` skills
  and the other `ssl-*` skills. opencode v2 auto-loads `~/.claude/skills`
  (Claude Code compatibility; switched off by
  `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` or `OPENCODE_DISABLE_CLAUDE_CODE`).
  Config also has a `skills: string[]` field for extra sources.
- Agents: only the built-ins — `build`, `plan` (primary), `general`,
  `explore` (subagents), and hidden `compaction`, `title`, `summary`.
  **The SSL agents installed at user level in `~/.claude/agents` are not
  registered.** The binary's agent discovery pattern is
  `{agent,agents}/**/*.md` (plus `{mode,modes}/*.md`) under opencode config
  directories, and `~/.config/opencode` has no such folder. Config can also
  define agents inline under `agents.<id>` (`Config.AgentEncoded`: `model,
  system, description, mode, hidden, color, steps, disabled, permissions,
  request`). This is a gap for the style guide's opencode installer, not for
  the adapter.

**Invoking.**

- Agent for the whole session: `agent` in `session.create`, or
  `POST /api/session/{id}/agent` `{ agent }` (`session.switchAgent`) before a
  prompt. It applies to subsequent turns.
- Agent mention in one prompt: `agents: [{ name }]` in the `session.prompt`
  body (an @-mention attachment; presumably hands work to a subagent —
  behaviour unverified).
- Skill in one prompt: `skills: [{ id }]` in the `session.prompt` body; or
  `POST /api/experimental/session/{id}/skill` `{ id, resume? }`, which
  appends a skill message and resumes execution (so it runs the model unless
  `resume: false`).
- Slash command: `POST /api/session/{id}/command` `{ name, text, ... }`.

## 8. Models and providers

- `GET /api/provider` (`provider.list`) →
  `{ data: [{ id, name, activation: "auto"|"enabled"|"disabled", package,
  settings?, headers?, body?, ... }] }`. **The response carries provider
  settings and headers, including API-key fields where configured. Treat it as
  secret: never log or persist it.** Same for `config.get`, which returns the
  config documents verbatim.
- `GET /api/model` (`model.list`, `types=chat|decision|image`, chat by
  default) → `{ data: [{ id, modelID, providerID, name, family?, capabilities:
  { tools, input[], output[], temperature }, variants: [{ id, settings }],
  limit: { context, input?, output }, cost[], status, enabled, time } ] }`.
- `GET /api/model/default` → the model used when a session has none.

Provider ids active here: `google`, `opencode`, `anthropic`, `openrouter`,
`github-copilot`, `openai`, `ollama`, `pneuma`. 461 chat models in all
(openrouter 351, github-copilot 25, google 23, anthropic 20, openai 19,
pneuma 10, opencode 8, ollama 5). **Local/gateway providers:** `ollama`
(local, 5 models) and `pneuma`, an `openai-compatible` provider named
"Pneuma Gateway" with custom auth headers — presumably the LiteLLM gateway.
The server's default model is currently an `openrouter` model, which is a
paid provider: an adapter must always set a model explicitly.

**Choosing model and reasoning variant.** A model reference is
`Model.Ref = { providerID, id, variant? }`; `variant` is one of that model's
`variants[].id`. Variant ids differ by model, so read them from `model.list`:
OpenAI-style models offer `none, minimal, low, medium, high, xhigh` (some
`max`), each `settings: { reasoning: { effort } }`; the gateway's smaller
models `low, medium, high`; most ollama models `thinking, no-thinking`; one
ollama model has none. **`session.prompt` has no model field.** Set the model
on `session.create`, or call `POST /api/session/{id}/model`
`{ model: { providerID, id, variant } }` (`session.switchModel`) before the
prompt; it applies to subsequent turns and emits `session.model.selected`.

## 9. SDK

| Package | Latest | Modified | Notes |
|---|---|---|---|
| `@opencode-ai/sdk` | 1.19.5 | 2026-10-28 | the v1 line; does not match 2.x |
| `@opencode/sdk` | 2.2.5 | 2026-11-01 | "In-process OpenCode host ... executes Server's assembled HTTP router in memory, opening no listener". Depends on `@opencode/server`, `@opencode/core`, `effect` 4.0.6 |
| `@opencode/client` | 2.2.5 | 2026-11-01 | "Private generation target for clients derived directly from OpenCode's authoritative Effect `HttpApi`". Exports `./promise`, `./effect`, `./solid`, `./mcp`, `./service`; peer deps `effect` 4.0.6, `solid-js` |
| `@opencode/plugin` | 2.2.5 | 2026-11-01 | plugin API |
| `@opencode/cli` | 2.2.5 | 2026-11-01 | the installed CLI |

The v2 scope is `@opencode/*`, versioned in lockstep with the CLI.
`@opencode/client` is the HTTP client for a remote or background server, but
it calls itself "private", so its API may change without notice.
`@opencode/sdk` embeds the whole server in the host process, which suits a
Node host but brings the full server dependency tree into the extension.

The CLI install contains no SDK.
`~/.nvm/versions/node/v24.11.0/lib/node_modules/` has `@opencode/cli` only
(no `opencode*` folder); it holds `bin/opencode.exe` (a ~250 MB single
compiled binary, also exposed as `opencode2`), `postinstall.mjs`, and
platform packages `@opencode/cli-linux-x64*`.

## 10. ACP (`opencode acp`)

`opencode acp` speaks the Agent Client Protocol (JSON-RPC over stdio). Only
`initialize` was sent. It answered `protocolVersion: 1`,
`agentInfo: { name: "OpenCode", version: "2.2.5" }`, `agentCapabilities:
{ loadSession: true, promptCapabilities: { image: true, embeddedContext:
true }, mcpCapabilities: { http: true, sse: false }, sessionCapabilities:
{ list, resume, fork, close, delete, additionalDirectories }, _meta:
{ "opencode/child-session-updates": true } }`, and one auth method,
`opencode-login`. It started its own private server, not the background
service.

Assessment: ACP is the better surface **if** SSL Studio wants editor-neutral
plumbing that already exists in editors (Zed and others): stdio lifecycle, a
standard session/prompt/update/permission vocabulary, a version in the
handshake, and the editor serving file reads and terminals itself. It is the
worse surface for what SSL Studio specifically needs: model and variant lists
with reasoning variants, skill attachment, the opencode permission ruleset,
forms, saved permissions, agent switching and usage are opencode-specific
and either absent from ACP or squeezed through `_meta` extensions. ACP also
runs its own server process, so its live events are not shared with a TUI
attached to the background service (stored sessions probably are, through
the shared database; unverified). Recommendation: build on the HTTP API now;
keep the adapter's interface narrow enough that an ACP back end could be
added later.

## 11. Prompt results (2026-11-01)

Three prompts to `qwen3:14b` on this machine's Ollama (cost 0), through
`spikes/m0-opencode/probe.ts` on a private server, and one rule evaluation
with no model. Raw events and messages stayed in a scratch directory. The
first prompt asked the model to try a shell command, a web fetch and a read
outside the session directory; the second and third gave it exact code to
run, so the result did not depend on a 14B model's planning.

**Pointing a private server at a local model.** The configured `ollama`
provider points at another machine, which was not answering.
`OPENCODE_CONFIG_CONTENT` in the private server's environment overrode the
provider's `api` URL and added a model for that server only, without
touching the user's config. The IDE can pin its local model the same way.
Ollama's own context default applies unless set: the second step of two
turns reported exactly 4,096 input tokens, which looks like truncation of a
system prompt of about 2,700 tokens plus history. Set the context size on
the Ollama side before judging a local model's answers.

**Code mode.** The model was offered one tool, `execute`, which runs
JavaScript in opencode's own interpreter (an unknown name fails as
`Unknown identifier`; top-level `await` and `try/catch` work). Inside it:

- a global `fetch`;
- `tools.opencode`: `session_rename, session_move, worktree_create,
  worktree_list, worktree_remove, models, list_mcp_resources,
  read_mcp_resource`;
- `tools.browser`: empty.

**No file tools (read, edit, glob, grep) and no shell were reachable.**
Whether they appear for other models or agents, and what switches code mode
on, is not known. For the IDE this argues for sending the code in the prompt
and applying the returned text as range edits itself (ADR 0002), rather than
relying on the agent's file tools.

**Deny rules.**

| Rule | Exercised by a tool | Evaluated (`session.permission.create`) |
| --- | --- | --- |
| `webfetch` | **Enforced**: `fetch` threw `Permission denied: webfetch`; the error went back to the model and the turn carried on | deny |
| `shell` | Not reachable: `Unknown tool 'shell'` / `'bash'` | deny |
| `external_directory` | Not reachable: no file tool | deny |
| `question` | (added for the third run) | deny |

`permission.asked` never fired: a denied action fails without asking.
Evaluation with the session's deny rules, `agent` null or `"build"`, gave the
same answers: `read` and `edit` inside the directory allow; `read` of a file
outside also allow, because "outside" is the separate `external_directory`
action; `browser` deny (the build agent denies it). Session rules beat the
build agent's `* allow`. One earlier evaluation sent without the `agent` key
answered `read` deny and `browser` allow; not reproduced, so always name the
agent when evaluating.

The `tools.opencode` helpers (worktrees, `session_move`) were callable with
these rules in place. Their action names are not known yet; find them before
an agent runs unattended.

**The question tool hangs a turn.** In the second run the model asked the
user a question: `form.created` `{ form: { id, sessionID, title, metadata:
{ kind: "question", tool: { messageID, id } }, fields: [{ key, title,
description, type, options }] } }`. The turn waited until the probe gave up
after five minutes; deleting the session interrupted the tool
(`session.tool.failed`, `error: { type: "aborted" }`). Deny `question` for
unattended runs; otherwise show the form and answer
(`.../form/{formID}/reply`) or cancel (`DELETE .../form/{formID}`).

**One turn's events, in order** (runs collapsed; environment events such as
`provider.updated`, `model.updated`, `agent.updated`, `skill.updated` and
`models-dev.refreshed` interleave):

`session.inbox.enqueued` > `session.execution.started` >
`session.instructions.updated` > `session.inbox.delivered` >
`session.step.started` > `session.reasoning.started/delta/ended` >
`session.tool.input.started` > `session.tool.input.ended` >
`session.tool.called` > `session.step.streamed` > `session.tool.progress` >
`session.tool.success` > `session.step.ended` > `session.usage.updated` >
(second step: reasoning, `session.text.started/delta/ended`) >
`session.execution.succeeded`.

| `type` | `data` |
| --- | --- |
| `session.inbox.enqueued` | `inboxID, sessionID, item: { type, payload: { text }, delivery }` |
| `session.execution.started` / `succeeded` | `sessionID` |
| `session.instructions.updated` | `sessionID, delta` (instruction section name to hash) |
| `session.step.started` | `sessionID, agent, model: { id, providerID, variant }, assistantMessageID, started` |
| `session.reasoning.delta`, `session.text.delta` | `sessionID, assistantMessageID, ordinal, delta` |
| `session.reasoning.ended`, `session.text.ended` | the same plus `text` (the whole part) |
| `session.tool.input.started` | `sessionID, assistantMessageID, id, name` |
| `session.tool.input.ended` | `... id, text` (raw input JSON) |
| `session.tool.called` | `... id, input, executed` |
| `session.tool.progress` | `... id, metadata: { toolCalls: [{ tool, status, input }] }` |
| `session.tool.success` | `... id, content: [{ type: "text", text }], metadata: { error, truncated }, executed` |
| `session.tool.failed` | `... id, error: { type, message }, executed` |
| `session.step.ended` | `sessionID, assistantMessageID, finish, rawFinish, tokens: { input, output, reasoning, cache: { read, write } }, cost` |
| `session.usage.updated` | `sessionID, cost, tokens` |

Notes for the client:
- **`session.idle` was never emitted.** The end of a turn is
  `session.execution.succeeded | failed | interrupted`; the message list ends
  with an `idle` message `{ outcome }`.
- A code-mode error is a *successful* tool call with `metadata.error: true`
  and the error in `content`.
- `session.prompt` returns the inbox item `{ id, sessionID, time, type,
  payload, delivery }`.
- Turns took 28 to 94 seconds on `qwen3:14b` (RTX 4080).

**Still unknown:** native file tools outside code mode, and
`external_directory` enforced on a real read; the helper tools' action
names; title generation (the probe always set a title); `agents: [{ name }]`
in a prompt; `delivery: "steer"` mid-turn.

## Appendix: operation list

All 169 operations in the v2.2.5 OpenAPI document. Purpose is the spec's
`summary` (or the first sentence of its description). `experimental.*`
operations may change between releases.

| operationId | Method | Path | Purpose |
|---|---|---|---|
| `server.info` | GET | `/api/info` | Get server info |
| `server.pair` | POST | `/api/pair` | Create pairing code |
| `server.connect` | GET | `/auth/connect/{code}` | Redeem pairing code |
| `location.get` | GET | `/api/location` | Get location |
| `location.reload` | POST | `/api/location/reload` | Reload configuration |
| `agent.list` | GET | `/api/agent` | List agents |
| `agent.get` | GET | `/api/agent/{agentID}` | Get agent |
| `plugin.list` | GET | `/api/plugin` | List plugins |
| `plugin.gui` | GET | `/api/plugin/gui` | Read plugin GUI bundle |
| `plugin.check` | POST | `/api/plugin/check` | Check plugin updates |
| `plugin.update` | POST | `/api/plugin/update` | Update plugins |
| `session.list` | GET | `/api/session` | List sessions |
| `session.create` | POST | `/api/session` | Create session |
| `experimental.session.stats` | GET | `/api/experimental/session/stats` | Get session statistics |
| `experimental.session.import` | POST | `/api/experimental/session/import` | Import session |
| `experimental.session.export` | GET | `/api/experimental/session/{sessionID}/export` | Export session |
| `session.active` | GET | `/api/session/active` | List active sessions |
| `session.get` | GET | `/api/session/{sessionID}` | Get session |
| `session.remove` | DELETE | `/api/session/{sessionID}` | Delete session |
| `session.update` | PATCH | `/api/session/{sessionID}` | Update session |
| `session.fork` | POST | `/api/session/{sessionID}/fork` | Fork session |
| `session.switchAgent` | POST | `/api/session/{sessionID}/agent` | Switch session agent |
| `session.switchModel` | POST | `/api/session/{sessionID}/model` | Switch session model |
| `session.move` | POST | `/api/session/{sessionID}/move` | Move session |
| `session.prompt` | POST | `/api/session/{sessionID}/prompt` | Send message |
| `session.command` | POST | `/api/session/{sessionID}/command` | Run command |
| `experimental.session.skill` | POST | `/api/experimental/session/{sessionID}/skill` | Activate skill |
| `session.synthetic` | POST | `/api/session/{sessionID}/synthetic` | Add synthetic message |
| `session.shell` | POST | `/api/session/{sessionID}/shell` | Run shell command |
| `session.compact` | POST | `/api/session/{sessionID}/compact` | Compact session |
| `experimental.session.wait` | POST | `/api/experimental/session/{sessionID}/wait` | Wait for session |
| `session.revert.stage` | POST | `/api/session/{sessionID}/revert/stage` | Stage session revert |
| `session.revert.clear` | DELETE | `/api/session/{sessionID}/revert` | Clear staged revert |
| `session.revert.commit` | POST | `/api/session/{sessionID}/revert/commit` | Commit staged revert |
| `session.context` | GET | `/api/session/{sessionID}/context` | Get session context |
| `session.diff` | GET | `/api/session/{sessionID}/diff` | Diff session turns |
| `session.inbox.list` | GET | `/api/session/{sessionID}/inbox` | List session inbox |
| `session.inbox.cancel` | DELETE | `/api/session/{sessionID}/inbox/{inboxID}` | Cancel inbox input |
| `session.inbox.update` | PATCH | `/api/session/{sessionID}/inbox/{inboxID}` | Update inbox item |
| `experimental.session.instructions.entry.list` | GET | `/api/experimental/session/{sessionID}/instructions/entries` | List instruction entries |
| `experimental.session.instructions.entry.put` | PUT | `/api/experimental/session/{sessionID}/instructions/entries/{key}` | Put instruction entry |
| `experimental.session.instructions.entry.remove` | DELETE | `/api/experimental/session/{sessionID}/instructions/entries/{key}` | Remove instruction entry |
| `session.generate` | POST | `/api/session/{sessionID}/generate` | Generate text from session context |
| `experimental.session.log` | GET | `/api/experimental/session/{sessionID}/log` | Read the session log |
| `session.interrupt` | POST | `/api/session/{sessionID}/interrupt` | Interrupt session execution |
| `session.background` | POST | `/api/session/{sessionID}/background` | Background blocking session tools |
| `session.message.get` | GET | `/api/session/{sessionID}/message/{messageID}` | Get session message |
| `session.form.list` | GET | `/api/session/{sessionID}/form` | List session forms |
| `session.form.create` | POST | `/api/session/{sessionID}/form` | Create session form |
| `session.form.get` | GET | `/api/session/{sessionID}/form/{formID}` | Get session form |
| `session.form.cancel` | DELETE | `/api/session/{sessionID}/form/{formID}` | Cancel form |
| `session.form.reply` | POST | `/api/session/{sessionID}/form/{formID}/reply` | Reply to form |
| `session.environment` | PUT | `/api/session/{sessionID}/environment` | Set session environment |
| `session.view` | POST | `/api/session/{sessionID}/view` | View session |
| `session.message.list` | GET | `/api/session/{sessionID}/message` | Get session messages |
| `model.list` | GET | `/api/model` | List models |
| `model.default` | GET | `/api/model/default` | Get default model |
| `experimental.generate.text` | POST | `/api/experimental/generate/text` | Generate text |
| `experimental.generate.textLegacy` | POST | `/api/experimental/generate` | Generate text (deprecated path) |
| `experimental.generate.image` | POST | `/api/experimental/generate/image` | Generate images |
| `experimental.generate.decisions` | POST | `/api/experimental/generate/decisions` | Generate decisions |
| `experimental.voice.models` | GET | `/api/experimental/voice/models` | List voice models |
| `experimental.voice.session` | POST | `/api/experimental/voice/session` | Create voice session |
| `provider.list` | GET | `/api/provider` | List providers |
| `provider.get` | GET | `/api/provider/{providerID}` | Get provider |
| `integration.list` | GET | `/api/integration` | List integrations |
| `integration.get` | GET | `/api/integration/{integrationID}` | Get integration |
| `experimental.integration.wellknown.add` | POST | `/api/experimental/integration/wellknown` | Add wellknown integration |
| `integration.connect.key` | POST | `/api/integration/{integrationID}/connect/key` | Connect with key |
| `integration.connect.external` | POST | `/api/integration/{integrationID}/connect/external` | Connect with external credentials |
| `integration.oauth.connect` | POST | `/api/integration/{integrationID}/connect/oauth` | Begin OAuth connection |
| `integration.oauth.status` | GET | `/api/integration/{integrationID}/connect/oauth/{attemptID}` | Get OAuth attempt status |
| `integration.oauth.cancel` | DELETE | `/api/integration/{integrationID}/connect/oauth/{attemptID}` | Cancel OAuth connection |
| `integration.oauth.complete` | POST | `/api/integration/{integrationID}/connect/oauth/{attemptID}/complete` | Complete OAuth connection |
| `integration.command.connect` | POST | `/api/integration/{integrationID}/connect/command` | Begin command connection |
| `integration.command.status` | GET | `/api/integration/{integrationID}/connect/command/{attemptID}` | Get command attempt status |
| `integration.command.cancel` | DELETE | `/api/integration/{integrationID}/connect/command/{attemptID}` | Cancel command connection |
| `mcp.list` | GET | `/api/mcp` | List MCP servers |
| `experimental.mcp.add` | PUT | `/api/experimental/mcp/{server}` | Add MCP server |
| `experimental.mcp.remove` | DELETE | `/api/experimental/mcp/{server}` | Remove MCP server |
| `experimental.mcp.connect` | POST | `/api/experimental/mcp/{server}/connect` | Connect MCP server |
| `experimental.mcp.disconnect` | POST | `/api/experimental/mcp/{server}/disconnect` | Disconnect MCP server |
| `mcp.resource.catalog` | GET | `/api/mcp/resource` | List MCP resources |
| `experimental.mcp.client.token` | POST | `/api/experimental/client-mcp/token` | Create client MCP WebSocket token |
| `experimental.mcp.client` | GET | `/api/experimental/client-mcp` | Attach client MCP server |
| `credential.list` | GET | `/api/credential` | List credentials |
| `credential.create` | POST | `/api/credential` | Create credential |
| `credential.update` | PATCH | `/api/credential/{credentialID}` | Update credential |
| `credential.remove` | DELETE | `/api/credential/{credentialID}` | Remove credential |
| `credential.activate` | POST | `/api/credential/{credentialID}/activate` | Activate credential |
| `project.list` | GET | `/api/project` | List projects |
| `project.update` | PATCH | `/api/project/{projectID}` | Update project |
| `form.list` | GET | `/api/form` | List pending forms |
| `permission.request.list` | GET | `/api/permission/request` | List pending permission requests |
| `permission.saved.list` | GET | `/api/permission/saved` | List saved permissions |
| `permission.saved.update` | PATCH | `/api/permission/saved/{id}` | Update saved permission |
| `permission.saved.remove` | DELETE | `/api/permission/saved/{id}` | Remove saved permission |
| `session.permission.create` | POST | `/api/session/{sessionID}/permission` | Create permission request |
| `session.permission.list` | GET | `/api/session/{sessionID}/permission` | List session permission requests |
| `session.permission.get` | GET | `/api/session/{sessionID}/permission/{requestID}` | Get permission request |
| `session.permission.reply` | POST | `/api/session/{sessionID}/permission/{requestID}/reply` | Reply to pending permission request |
| `fs.read` | GET | `/api/fs/read/*` | Read file |
| `fs.list` | GET | `/api/fs/list` | List directory |
| `fs.find` | GET | `/api/fs/find` | Find files |
| `experimental.fs.write` | POST | `/api/experimental/fs/write` | Write file |
| `experimental.fs.watch` | POST | `/api/experimental/fs/watch` | Watch file |
| `experimental.fs.unwatch` | DELETE | `/api/experimental/fs/watch` | Unwatch file |
| `command.list` | GET | `/api/command` | List commands |
| `skill.list` | GET | `/api/skill` | List skills |
| `rpc.call` | POST | `/api/rpc/{rpcID}/{method}` | Call a plugin RPC |
| `event.subscribe` | GET | `/api/event` | Subscribe to events |
| `pty.list` | GET | `/api/pty` | List PTY sessions |
| `pty.create` | POST | `/api/pty` | Create PTY session |
| `pty.get` | GET | `/api/pty/{ptyID}` | Get PTY session |
| `pty.update` | PUT | `/api/pty/{ptyID}` | Update PTY session |
| `pty.remove` | DELETE | `/api/pty/{ptyID}` | Remove PTY session |
| `pty.connect.token` | POST | `/api/pty/{ptyID}/connect-token` | Create PTY WebSocket token |
| `pty.connect` | GET | `/api/pty/{ptyID}/connect` | Connect to PTY session |
| `experimental.persistentPty.read` | GET | `/api/experimental/session/{sessionID}/terminal/read` | Read the session's most recently controlled terminal |
| `experimental.persistentPty.list` | GET | `/api/experimental/session/{sessionID}/terminal` | (no summary in spec) |
| `experimental.persistentPty.create` | POST | `/api/experimental/session/{sessionID}/terminal` | (no summary in spec) |
| `experimental.persistentPty.shutdown` | POST | `/api/experimental/persistent-pty/shutdown` | (no summary in spec) |
| `experimental.persistentPty.handoff` | POST | `/api/experimental/persistent-pty/handoff` | (no summary in spec) |
| `experimental.persistentPty.get` | GET | `/api/experimental/persistent-pty/{ptyID}` | (no summary in spec) |
| `experimental.persistentPty.update` | PUT | `/api/experimental/persistent-pty/{ptyID}` | Resize when size is present and rename when title is present; a null title clears the user title so the shell's title shows again |
| `experimental.persistentPty.remove` | DELETE | `/api/experimental/persistent-pty/{ptyID}` | (no summary in spec) |
| `experimental.persistentPty.snapshot` | GET | `/api/experimental/persistent-pty/{ptyID}/snapshot` | (no summary in spec) |
| `experimental.persistentPty.connectToken` | POST | `/api/experimental/persistent-pty/{ptyID}/connect-token` | (no summary in spec) |
| `experimental.persistentPty.connect` | GET | `/api/experimental/persistent-pty/{ptyID}/connect` | Connect to a persistent PTY |
| `experimental.media.get` | GET | `/api/experimental/media/{hash}` | Read media blob |
| `experimental.schedule.create` | POST | `/api/experimental/schedule` | Create schedule |
| `experimental.schedule.list` | GET | `/api/experimental/schedule` | List schedules |
| `experimental.schedule.get` | GET | `/api/experimental/schedule/{scheduleID}` | Get schedule |
| `experimental.schedule.delete` | DELETE | `/api/experimental/schedule/{scheduleID}` | Delete schedule |
| `experimental.schedule.pause` | POST | `/api/experimental/schedule/{scheduleID}/pause` | Pause schedule |
| `experimental.schedule.resume` | POST | `/api/experimental/schedule/{scheduleID}/resume` | Resume schedule |
| `experimental.artifacts.providers` | GET | `/api/experimental/artifacts/providers` | List artifact providers |
| `experimental.artifacts.list` | GET | `/api/experimental/artifacts` | List artifacts |
| `experimental.artifacts.create` | POST | `/api/experimental/artifacts` | Create artifact |
| `experimental.artifacts.get` | GET | `/api/experimental/artifacts/{artifactID}` | Read artifact |
| `experimental.artifacts.update` | PATCH | `/api/experimental/artifacts/{artifactID}` | Update artifact |
| `experimental.artifacts.delete` | DELETE | `/api/experimental/artifacts/{artifactID}` | Delete artifact |
| `experimental.artifacts.view` | GET | `/api/experimental/artifacts/{artifactID}/view/*` | View local artifact |
| `shell.list` | GET | `/api/shell` | List running shell commands |
| `shell.create` | POST | `/api/shell` | Run shell command |
| `shell.get` | GET | `/api/shell/{id}` | Get shell command |
| `shell.remove` | DELETE | `/api/shell/{id}` | Remove shell command |
| `shell.output` | GET | `/api/shell/{id}/output` | Read shell output |
| `reference.list` | GET | `/api/reference` | List references |
| `worktree.list` | GET | `/api/worktree` | List worktrees |
| `worktree.create` | POST | `/api/worktree` | Create worktree |
| `worktree.remove` | DELETE | `/api/worktree` | Remove worktree |
| `worktree.refresh` | POST | `/api/worktree/refresh` | Refresh worktrees |
| `vcs.init` | POST | `/api/vcs/init` | Initialize VCS repository |
| `vcs.get` | GET | `/api/vcs` | VCS info |
| `vcs.base` | GET | `/api/vcs/base` | VCS review base |
| `vcs.status` | GET | `/api/vcs/status` | VCS status |
| `vcs.branch.list` | GET | `/api/vcs/branch` | VCS branches |
| `vcs.diff` | GET | `/api/vcs/diff` | VCS diff |
| `debug.heapDump` | POST | `/api/debug/heap-dump` | Write a heap snapshot |
| `debug.location.list` | GET | `/api/debug/location` | List loaded locations |
| `debug.location.evict` | DELETE | `/api/debug/location` | Evict a loaded location |
| `experimental.migration.v1.status` | GET | `/api/experimental/migration/v1` | Get V1 migration status |
| `websearch.providers` | GET | `/api/websearch/provider` | List web search providers |
| `websearch.query` | POST | `/api/websearch` | Search the web |
| `experimental.usage.limits` | GET | `/api/experimental/usage/limits` | Get usage limits |
| `config.get` | GET | `/api/config` | Get configuration |
| `config.shells` | GET | `/api/config/shell` | List available shells |
| `experimental.config.update` | PATCH | `/api/experimental/config` | Update global configuration |

## Recommendation for the adapter

- **Surface.** Use the v2 HTTP API under `/api` with a hand-written, narrow
  TypeScript client (about 15 operations: info, model/provider/agent/skill
  list, session create/get/update/remove/list, prompt, interrupt, message
  list, permission and form list/reply, event subscribe). Generate its types
  from `/openapi.json` at build time. Do not depend on `@opencode/client`,
  which calls itself private; keep it in view as a reference. Do not adopt
  ACP now (section 10).
- **Which server.** Default to a **private server** started by the IDE:
  spawn `opencode serve --stdio --port 0` with a freshly generated
  `OPENCODE_PASSWORD` in the child's environment, read the one JSON line
  `{"url": ...}` from stdout, and keep stdin open; closing it stops the
  server. This needs no shared secret and no file reads. Offer "attach to the
  background service" as an option, discovered from
  `~/.local/state/opencode/service.json` (`url`, `version`, `pid`), and fall
  back to private when the pid is dead or `/api/info` fails.
- **Version check.** After connecting, call `GET /api/info` and check
  `version` against a declared range (start with `>=2.2.5 <2.3.0`, then widen
  as versions are tested). Ignore the OpenAPI `info.version` (`0.0.1`).
  Before spawning, `opencode --version` gives the same number. Refuse below
  range; warn above it, as the CLI itself does.
- **Auth.** Send `Authorization: Basic base64("opencode:" + password)` on
  every request, including the SSE request. Hold the password in memory only;
  read the service file at connect time, never copy it to settings, logs,
  telemetry or crash reports. Redact `Authorization` in any request logging.
  Treat the bodies of `provider.list`, `config.get` and `credential.*` as
  secret too.
- **Model choice is mandatory.** Always create sessions with an explicit
  `model: { providerID, id, variant }` and re-assert it with
  `session.switchModel` when the user changes it; the server default here is
  a paid openrouter model. Default to the local provider, as the project
  rules require, and read valid `variant` ids from `model.list` per model.
- **Permissions default.** Create every session with a deny ruleset for
  `shell`, `webfetch`, `websearch`, `external_directory` and, for unattended
  runs, `question` (resource `*`; section 11),
  and set `location.directory` to the workspace root. Show `permission.asked`
  as an inline prompt answered through `.../permission/{id}/reply`
  (`once | always | reject`); default to `reject` on timeout or when the
  panel is closed. Never offer `always` for shell. Handle `form.created` the
  same way, or the `question` tool will hang the turn.
- **Events.** Run one SSE connection per server, filtered with `types=`, and
  route by `data.sessionID`. Dispatch on the JSON `type` field (there are no
  `event:` lines). On disconnect, reconnect and resync from
  `session.message.list` and the pending permission/form lists, since the
  stream does not replay.
- **Agents and skills.** List with `agent.list` / `skill.list` per location.
  Choose an agent per session (`session.create` / `session.switchAgent`) and
  attach `ssl-tidy-*` skills per prompt through `skills: [{ id }]`. The SSL
  agents are not visible to opencode v2 yet (they live in `~/.claude/agents`;
  v2 reads `agents/` folders under its config directories): raise that with
  the style guide's installer rather than working round it in the IDE.
- **Testing.** Record real responses from the read-only endpoints and the SSE
  framing for the fake server; never hit a paid provider in tests.
- **Open before the first prompt**, as first written (section 11 answers most; what remains is listed there): the payload shapes of
  `session.text.delta`, `session.tool.*`, `session.execution.*`,
  `session.idle` and `permission.asked`; whether the deny rules are enforced
  as written and how session rules combine with agent rules (precedence,
  order); whether a denied action fails the tool quietly or ends the turn;
  what `agents: [{ name }]` in a prompt does exactly; whether title generation
  (the hidden `title` agent, which calls a model) runs on the first prompt and
  which model it uses; how `delivery: "steer"` behaves mid-turn; and how cost
  and token usage arrive (`session.usage.updated`). One prompt against the
  local ollama model, with the user's agreement, would answer most of these.
