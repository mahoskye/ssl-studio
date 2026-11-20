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

## L3: semantic tokens

**Released in starlims-lsp 0.30.0 (2026-11-03)**
(mahoskye/starlims-lsp#366, PR #367).

The IDE highlights with the formatter's TextMate grammar. Semantic tokens let
it colour procedures, parameters, `:PUBLIC` variables and unknown names apart.
`src/view/editor/semantic.ts` follows VS Code's rules: a theme opts in with
`semanticHighlighting`, `semanticTokenColors` comes first, then the scopes VS
Code maps each token to. A token no rule colours is dropped, so the grammar's
colour stands. Studio Dark and Light opt in and colour `variable.public` and
`variable.unknown`. Blocks mode's code chips stay with the grammar.

## Asked on 2026-11-18

Found by opening a project with classes in the IDE
(`examples/due-dates`), and by running it. The IDE cannot fill any of these
in by itself, because it does not read SSL (ADR 0003). Filed on
`starlims-lsp`:

| Request | Issue |
| --- | --- |
| L4 | mahoskye/starlims-lsp#369 |
| L6 | mahoskye/starlims-lsp#370 |
| L7 | mahoskye/starlims-lsp#371 |
| L8 | mahoskye/starlims-lsp#372 |

L5 needed no request: shape version 1 already gives it.

### L4: classes in the call graph

**Why:** the graph draws `ExecFunction`, `DoProc`, `RunDS` and `:INCLUDE`
edges. A project built on classes shows little of its real structure:
`SetSampleDueDates` has no line to the rule it creates or to the method it
calls on it.

**Released in starlims-lsp 0.31.0 (2026-11-18)**, SSL Studio's pinned
version (mahoskye/starlims-lsp#369, PR #373). `ssl/callGraph` sends three
more edge kinds, and the shape version stays 1:

- `CreateUdObject`: from the procedure holding
  `CreateUdObject("Category.Class", …)` to the class file.
- `Method`: from the procedure holding `Me:Method()`, `Base:Method()` or
  `oObject:Method()` to the method, in the class or the nearest ancestor that
  declares it. `oObject` counts only when every assignment to it in that
  procedure is a `CreateUdObject` of one class.
- `Inherit`: from a class file to the parent its `:INHERIT` names.

**What the server cannot say:** the class of an object that another
procedure made. In the demo, `SetSampleDueDates` gets its rule from
`DueRules.RuleFor`, which creates one of two classes, so its
`oRule:DueDate()` has no line. The graph shows the path there is:
`PlanDueDate` calls `RuleFor`, and `RuleFor` creates both classes.

**In the IDE:** the three relations are drawn apart from calls and from
each other by the shape of the line (dashed inherits, dotted creates, dash
and dot for a method call), the key names the ones on screen, the list says
"creates an object of", "calls the method" and "inherits", and a class
file's top-level box is labelled as the class
(`src/view/graph/model.ts`, `relationOf`).

**No reading of its own:** until 0.31.0 the IDE worked inheritance out by
itself, from the `:INHERIT` statement the syntax tree marks. That is gone.
With an older server the graph marks class files and draws no class
relation.

### L5: a class header and doc blocks in the syntax tree

**Done in the IDE on shape version 1 (2026-11-18).** The tree already gives
what was needed: `docBlock` for the comment above a procedure, and
`statement` nodes with the keywords `CLASS`, `INHERIT` and `DECLARE`. Blocks
now draws a procedure with its doc block as one card, and the `:CLASS` line
with what it inherits and its fields as the class's head.

**Would still help:** the class's name and its parent's name as `name` and
`nameRange` on those statements, so that the IDE need not cut them out of
the statement's text; and the ranges of a doc block's Description,
Parameters and Returns parts, for the vision's "doc block as a form".

### L6: the tables a script reads and writes

**Why:** a project keeps its tables under `schema/database/` (ADRs 0006
and 0026). Nothing
connects a script's SQL to them: the agent is not given the tables a script
uses, and a column that does not exist is not reported.

A registry of database objects waits on this too (2026-11-19). The IDE can
look for a row's name in the project's files, which is a search and reads no
SSL; it cannot say which tables the scripts use that no row lists.

**Needs:**

- A request that lists, for a document, the tables and columns its SQL
  strings name, each with the range of the SQL string and whether it is read
  or written.
- Later: a diagnostic for a table or column that a schema source does not
  have, once the server is given one.

### L7: the required exception to "prefer unannotated procedures"

**Why:** the style guide prefers procedures without `/*@private;`, with one
required exception: a raise-only helper must be private
(`private_raise_only_helpers`). The server's `visibility_annotation_usage`
reports every annotation, the required ones included, and leaves a reviewer
to confirm the exception. In the IDE that means a correct script shows
information rows that can never be cleared: `SetSampleDueDates` in
`examples/due-dates` shows one for each private helper.

**Needs:** either the diagnostic left off a procedure the server can see is
raise-only (it raises, or lets an error out, and returns no failure value),
or a field on the diagnostic that says "this is the required exception", so
the IDE can show it as confirmed and not as a finding.

### L8: what the server accepts and STARLIMS does not

**Why:** the demo project was clean under `--validate --strict` and did not
run. Its tests were then run in the SSL sandbox runner (a separate
compatibility runtime that models the STARLIMS compiler and executor; it is
not STARLIMS). Each row is something the runner refuses, or warns of, that
the server says nothing about. A project the server calls clean should run.

**Needs** a diagnostic for each, once the behaviour is confirmed against
STARLIMS itself:

| Construct | The runner says | The server says |
| --- | --- | --- |
| `DoProc("Name", aVariable)` | Compile error: invalid arguments for `doproc` | nothing |
| An include's variable, read in a called procedure | Undefined at run time | nothing |
| `IIf(b, DoProc(...), DoProc(...))` | Warning: an argument should be a constant or a name | nothing |

- **The first:** `DoProc`'s arguments must be written as an array literal.
- **The second:** a variable declared and set at the top of an included
  script exists only while the including script's own lines run. A procedure
  entered by its three-part name (`ExecFunction("Cat.Script.Proc")`) runs
  alone, and the variable is not there. An included procedure is.

**The other way round:** the server reports `doproc_in_class` for `DoProc`
in a method of a class that includes a script; the runner runs it.
