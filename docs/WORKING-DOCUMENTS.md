# The work, written down

**Status:** built (2026-11-19). Decisions:
[ADR 0012](adr/0012-a-projects-work-is-written-down.md),
[0013](adr/0013-the-agent-is-told-the-work-a-question-is-for.md),
[0014](adr/0014-tickets-come-in-from-an-export.md) and
[0015](adr/0015-what-is-not-ssl-is-read-here.md), each drafted from the
user's request and not yet reviewed by them point by point.

**The idea, in the user's words:** "most often the project will come from a
jira ticket or some similar source. it and any related tickets will be the
drivers of the work."

## The shape of it

A project carries its own record under its docs folder. Four folders, each
with a catalog the IDE keeps:

| Folder | Holds | A file is |
| --- | --- | --- |
| `tickets/` | What was asked | Markdown, named by the ticket's key |
| `specs/` | What will be built | Markdown, for a ticket |
| `knowledge/` | What was learned | A decision, a question, a snippet, a note |
| `registries/` | What must carry | A CSV table, a row for each thing a migration must carry across |

`STATE.md` beside them says where the project stands, in plain words. The
demo project (`examples/due-dates`) has one of everything, invented for it.

## From a ticket to the work

1. **Bring the tickets in.** Docs panel, ＋, "Import tickets…" reads an
   export from the ticket system: a CSV table, or the JSON its API returns.
   "New ticket…" makes one by hand. Reporter and assignee are not read.
2. **Read the ticket's page.** It shows what the ticket says of itself, and
   under that everything tied to it: plans, specs, related tickets,
   questions, decisions. On any document's page, a ticket's key written in
   the prose ("this waits on DEMO-101") is a link to that ticket, with its
   title and state in the tooltip.
3. **Spec it out.** "New spec…" writes a spec for the ticket. A plan
   (`design/*.plan.json`) names its ticket too, and the spec the planner
   writes from it is listed with the ticket.
4. **Write down what comes up.** A decision, a question, a snippet or a
   reference note goes in the knowledge base. Started with code selected, a
   question or a decision keeps a link to those lines and the lines as they
   were.
5. **Tick what is done.** A ticket's "What done looks like" and a spec's
   "How it is checked" are task lists. Their boxes are ticked on the
   document's page, and the Docs panel shows how many are ("2/3").
6. **Move its state.** The status on a document's page is a menu. So is a
   row's menu in the Docs panel: right-click, the menu key or Shift+F10.

"Spec'd out work" is the right way to see it: a ticket says what was asked,
a spec says what will be built for it, and a plan is the chart a spec is
written from.

## What the Docs panel shows

- **Work:** each ticket with its plans and specs under it. A ticket that is
  part of another is under its parent. What is under way comes first;
  finished tickets beyond three fold away behind a count.
- **Knowledge base:** decisions, questions, snippets and reference notes,
  each kind together, with a count.
- **Registries:** each with how far it is.
- **A filter** narrows every list to the documents the words typed are in.

## Catalogs

Each folder's `INDEX.md` is its catalog: one line for each document, with
its title, its state and what it is about. The IDE writes the list between
two marker lines and leaves everything else in the file alone. It writes it
when it makes or changes a document; "Update catalogs" writes them all.

## Registries

A registry is a CSV file whose first row names its columns. A `status`
column says how far each row has come.

| Registry | A row is |
| --- | --- |
| Application settings | A setting the application reads |
| File manifest | A file, with its size and checksum |
| Database objects | A table, view, procedure or sequence |
| Interfaces | A system the application talks to |
| Scheduled jobs | A job that runs on its own |
| Reports and labels | A report, label or printed form |
| Roles and access | A role and what it may do |

- **It opens as a table.** Filter, order, narrow to a status, edit a cell,
  add or delete a row. Each change is that part of the text; Ctrl+Z undoes
  it.
- **The file manifest is written from the folder,** and written again says
  what is new, changed and gone, keeping your status and notes.
- **Database objects start from the schema:** a row for each object the
  schema folder's SQL creates.
- **"Check against code"** looks for each row's name in the project's
  files. A row found nowhere is one to question.

## Health

Health's Work section says what the working documents need.

| Kind | Examples |
| --- | --- |
| To fix | A catalog out of date; a registry that is not a table; a spec missing from where its ticket says |
| To know | A document still its template; a ticket named and not there; open questions |

A row's menu puts right what the IDE can: the catalogs are written afresh,
a named ticket is started. The Registries section shows a bar for each.

A link to a file that is not there is one to fix: the document it led to
was moved, renamed or never written. Health names the file and opens the
document at the link; the document's page marks the link before anyone
clicks it. Links to the web, and to files outside the project, are not
checked. Where the project has one file of that name somewhere else, the
row offers "Mend": the link is pointed there, and Ctrl+Z undoes it.

A file or a folder renamed in the Explorer takes what names it along: the
IDE says how many places, in how many documents, still say the old name,
and on your word writes the new one in each. A link is one such place; a
ticket's `specs:` line and a spec's `plan:` line are the others. A name
typed with a folder in it ("archive/Old.md") moves the file there, and the
links the moved document holds are written from where it is now.

Writing a link, the project's documents are offered once `](` is typed:
tickets first, each by its key and title. Typing narrows the list by title,
key or path, and the path written is the way there from the document.

## The agent

The agent cannot read the folder, so the IDE sends what bears on the work:
what the ticket asks, the tickets around it, the questions nobody has
answered (with an instruction not to guess), the answers given, and the
decisions that stand.

- **The planner** is sent it when it refines a plan or writes its spec.
- **A chat** is sent it once in a conversation, with the ticket's specs,
  when "include the ticket" is ticked.
- **A small context cuts it.** With Ollama's default of 4096 tokens a
  second question, or a build, no longer fits. The conversation says when a
  prompt was cut; [INSTALL.md](INSTALL.md) says how to raise it.

## Documents as what they are

| Kind | The IDE |
| --- | --- |
| Markdown | Colours it, renders it, outlines its headings |
| JSON | Colours it, outlines its keys, says where it breaks, lays it out |
| TOML, INI | Colours it, outlines its tables; TOML says where it breaks |
| SQL | Colours it, outlines its statements |
| CSV, TSV | Colours each column; opens as a table |
| YAML | Colours it, outlines its top keys, says about where it breaks |
| XML | Colours it, says where it is not well formed |

SSL is not on this list: its outline, findings and formatting are the
language server's ([ADR 0015](adr/0015-what-is-not-ssl-is-read-here.md)).
Kept snippets are in the Palette, to insert at the cursor.

## Not done

- Reading tickets from a ticket system itself, without an export. No
  export from a real ticket system has been tried: the reader follows what
  Jira's own tracker says of its CSV.
- A table a script uses that no registry lists. It needs the language
  server to say which tables a script uses
  ([LSP-REQUESTS.md](LSP-REQUESTS.md), L6).
- Every stage of the planner has been run on opencode 2.3 with a local
  model at Ollama's default context, where a build and a test script are
  cut and do not pass. None has been tried with a larger context or a
  stronger model.
