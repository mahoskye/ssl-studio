# What SSL Studio needs from starlims-lsp

What SSL Studio asked of `starlims-lsp`, filed there as #359 and #360
(2026-11-01). The language server owns the design; this says what the IDE
needs and why.

**Released in starlims-lsp 0.29.0 (2026-11-03)**, SSL Studio's pinned
version (mahoskye/starlims-lsp#359, #360, PR #361). The server advertises them as
`capabilities.experimental.ssl.{syntaxTree, callGraph}: 1` (shape version 1,
its `docs/features/custom-requests.md`). SSL Studio reads shape version 1
(`treeFromSyntax` in `src/view/blocks/model.ts`, `fromCallGraph` in
`src/view/graph/model.ts`, tested on that shape), and the self-test calls
both against the bundled server. With an older server that lacks them, it
keeps using document symbols, folding ranges and references.

## L1: a syntax tree request (needed for blocks mode, M3)

**Why:** the blocks view shows a file as nested procedures, regions and
control flow. It must agree exactly with the server's parse, so it cannot
parse SSL itself.

**Needs:**

- A custom request, for example `ssl/syntaxTree`, taking a document URI and
  returning the tree of the current parse for that document version.
- Each node: a kind, its full range (including the terminating `;`), its
  children, and for named nodes the name and the name's range.
- Kinds the view uses, at least: file banner comment, comment region (open
  and close, with name), `:REGION` text block, procedure (with `:PARAMETERS`
  and `:DEFAULT` as children), the doc block above a procedure, `:IF` /
  `:ELSE`, `:WHILE`, `:FOR`, `:BEGINCASE` with its `:CASE` and
  `:OTHERWISE` arms, `:TRY` / `:CATCH` / `:FINALLY`, a statement, a comment,
  blank-line runs.
- Error nodes for spans the parser could not read, with their ranges.
- **Coverage:** the top-level nodes' ranges, together with the gaps between
  them, cover the document exactly.
- Statement-level granularity is enough. Expressions inside a statement can
  stay opaque text.

**Nice to have:** a notification when the tree changes, or the document
version in the response, so the client can drop stale trees.

## L2: a workspace call graph request (needed for graph mode, M5)

**Why:** graph mode draws scripts and procedures joined by their calls. The
server's workspace index already resolves dotted `DoProc` / `ExecFunction`
targets, `RunDS` data sources and `:INCLUDE` paths for go to definition.

**Needs:**

- A custom request, for example `ssl/callGraph`, optionally scoped to one
  document or symbol and a depth.
- Nodes: scripts, procedures, data sources, with location and the comment
  region each sits in.
- Edges: caller, callee, kind (`DoProc`, `ExecFunction`, `RunDS`,
  `:INCLUDE`), call-site location, and whether the target was resolved.
- Unresolved targets as their own nodes, so missing scripts are visible.

## L3 (later): semantic tokens

The IDE highlights with the formatter's TextMate grammar. Semantic tokens
would let it colour procedures, parameters, `:PUBLIC` variables and unknown
names apart. Not needed to start.
