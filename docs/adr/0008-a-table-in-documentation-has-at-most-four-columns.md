# ADR 0008: A table in documentation has at most four columns

**Status:** Accepted
**Date:** 2026-11-17
**Decided by:** the user asked for a rule on the number of columns in a
Markdown table, specific about what a table shows and about how the change is
handled so that tables stay legible. The numbers were drafted from the
measurements under "Context", and the user accepted them as drafted
(2026-11-17).

Under [ADR 0007](0007-design-is-held-to-a-standard-that-serves-starlims-work.md).

## Context

- A seven-column table in the demo project's docs rendered with words broken
  in the middle: "Sam / ple", "ROUTI / NE", "Turnaro / und".
- Two causes. The rendered view let a line break anywhere, so a table squeezed
  every column instead of scrolling. And seven columns do not fit: the reading
  column is 760px of text at its widest and about 556px in a 1280px window with
  both side panels open.
- Each column costs 21px of padding and border before any text. At 760px, four
  columns leave about 676px for text and seven leave 613px shared seven ways.
- Every other table in the repository already has four columns or fewer
  (23 tables, 2026-11-17). None of them meets the limits on text below: 20 put
  a long value in a column that is not the last, usually because they have two
  columns of text. Looser numbers do not change that; at twice these limits 6
  of the 23 pass.

## Decision

### What a table is for

- A table is for looking something up. Its rows are all the same kind of
  thing, and the reader arrives with a name and leaves with a value.
- Anything read from start to finish is prose or a list, not a table.

### What a table shows

| Part | Limit | What it holds |
| --- | --- | --- |
| Columns | 4 | Two or three is usual |
| Heading | 16 characters | A word or two |
| First column | 20 characters | What names the row: a name, an id, a code |
| Middle columns | 20 characters | One short value: a name, a code, a number, a date |
| Last column | 100 characters | The only column of text: a phrase or one sentence |

- One fact in a cell. No lists, no line breaks, no second fact in brackets.
- Lengths count what the reader sees: `code` and links count as their text.

### When the information does not fit

Do not add a fifth column, shrink the text, or abbreviate the headings. In
this order:

1. **Drop** a column the reader does not look things up by. Say it once in a
   sentence under the table.
2. **Split** into two tables with the same first column, each answering one
   question.
3. **One section for each row**, when a row is really a record with many
   fields: a short table on top (name, the one value most looked up, a phrase)
   and a heading for each row with its details as a list.
   `examples/due-dates/docs/Worked-examples.md` is the pattern.

### How the rendered view keeps a table legible

- A word never breaks inside. Text wraps at spaces only.
- A column whose values are all short (20 characters or fewer) is never
  wrapped, and neither is a heading: a date or an id stays whole. The column of
  text takes the wrapping.
- A table that still does not fit scrolls sideways inside its own frame. The
  page does not scroll sideways and no column is squeezed.
- Documents the rule does not govern (a README from somewhere else) get the
  same treatment: legible, scrolling if they must.

### How it is enforced, and how existing documents change

- The numbers and the check are in one place, `src/shared/docTables.ts`. The
  rendered view reads the numbers from it.
- `test/docTables.test.ts` holds the documents written under this rule to all
  of it: the project templates and everything under `examples/`.
- The same test holds every other Markdown file in the repository to the
  column limit only.
- An existing document is brought within the whole rule when it is next
  edited, and is then added to the first list. They are not rewritten in one
  pass.

## Consequences

- Some information that used to sit in one wide table becomes a short table
  and a few sections. The document gets longer and each part gets easier to
  read.
- The check cannot see "one fact in a cell" or "the rows are the same kind of
  thing". A reviewer does.
- The IDE flags a table that breaks the rule in any Markdown file it has
  open, as information in Problems (2026-11-18). It is advice: a README that
  came from somewhere else is not this project's to fix.
- None of the 23 tables in this repository's other documents meets the text
  limits today. They are held to the column limit only until they are edited.
