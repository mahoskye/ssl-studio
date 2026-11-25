# ADR 0024: A Markdown text is drawn as it is written

**Status:** Draft
**Date:** 2026-11-19
**Decided by:** the agent's draft, written after the user asked that
editing a Markdown document "behave like Obsidian" and chose to do it on
the editor the app already has; the user has not reviewed it.

Under [ADR 0002](0002-text-is-the-source-of-truth.md),
[ADR 0007](0007-design-is-held-to-a-standard-that-serves-starlims-work.md)
and [ADR 0020](0020-the-shell-does-what-vs-code-does-and-stays-its-own.md).

## Context

- A document had two views: its text, in the code editor as code, and
  the rendered page, which is for reading. Writing meant looking at
  markup; seeing the result meant leaving the text.
- The user writes tickets, specs and notes here, and asked for the way
  Obsidian does it: one view, formatted as it is typed.
- A second editor (CodeMirror, which Obsidian uses) was considered. The
  editor already shipped can set a size, a face and a line height for a
  stretch of text, which is what this needs.

## Decision

- **The text view of a document draws what the text is.** A heading is
  larger, strong words are strong, a link shows its words, a task's box
  is pressed like a button. Prose is set in the app's face and wrapped;
  code, tables and the lines a document opens with keep the code's face.
- **Markup is out of the way except where one is writing.** On the lines
  the cursor or a selection is on, the markup is there, dimmed. On every
  other line it takes no room.
- **Nothing is rewritten.** What a line is made of is read from the
  text (`src/shared/markdownLive.ts`), and the editor styles those
  places. The one edit is a click on a task's box, which changes the one
  character between its brackets.
- **No new dependency.** It is drawn with the editor's own decorations.
- **It can be switched off.** A setting and a command show the text
  plain, as code, with line numbers.
- **Read stays.** The rendered page is still the renderer's, and still
  where a document opens.

## Consequences

- Markup is hidden only where the page would not show it either. Which
  lines are a block of code, a block of HTML or a table is asked of the
  renderer's own lexer. Stars and underscores are paired here, by the
  renderer's rules; addresses are not looked into.
- Inside a list or a quote the renderer's reading is of text with the
  indent taken off, and cannot be laid back over the lines. There the
  blocks are found by rules of this reading's own, which know a fence,
  code set in under a bullet, and a table. The two readings can differ
  there, and on runs of mixed stars, underscores and brackets. Where
  they do, the Read view is right.
- A line is never left with nothing to see: markup that is all a line
  has stays in sight.
- Sizes and faces are said twice: in the style sheet, which draws them,
  and to the editor, which is told a stretch is not in its usual face.
  They must be changed together.
- Where a line wraps is worked out in the text's own face and with the
  hidden markup counted. So a line with much markup may wrap a little
  early, and a heading is drawn at the largest of its sizes that its
  line has room for, down to the text's own. A long line of code or a
  wide table row, in the code's wider face, may run past the edge and
  be scrolled to.
- The editor's own colouring of Markdown still gives the colours; its
  bold, slant and underline are set aside, since they follow a reading
  that is not this one.
- A line longer than 5,000 characters has its words left unread. A
  text with such a line, or one longer than 60,000 characters, is read
  without the renderer's lexer, by the rules a list is read by: the
  lexer's time grows faster than the text.
- A text of more than 8,000 characters is read aside from the window,
  in a worker, when the typing pauses, so that reading it is not felt
  at the keys. What is drawn is carried along with each edit by the
  editor meanwhile.
- A long document opened for the first time shows as plain text for the
  moment its reading takes, then takes its shape, with the line at the
  top of the view held where it is. One that has been drawn before is
  drawn at once when it comes back to the front. If its text was changed
  while it was not in front (by an agent, or on disk), it is drawn from
  what it was until it has been read again: for that moment the shapes
  below the change can sit a line or more off.
- Pictures and tables are not drawn in place; they are in the Read view.
- Links between double brackets are drawn, and are not yet followed,
  completed or listed as backlinks.
- Seen in the browser preview only.

## Changes to this draft

- 2026-11-19, with Markdown writing: a link written as Markdown writes
  it is followed from the text, by Ctrl+click or "Open the link at the
  cursor": to a file where the Read view would take it; to a heading
  named by its words as they are written, so one with markup in its
  words, one inside a quote, and a link written by reference are not
  followed from the text. While that click is
  under way the line's markup stays hidden until the button is up, so
  the link does not move from under the pointer. Enter in a list starts
  the next item, and on an item with no words ends the list; it is one
  edit of the text at the cursor. Links between double brackets are
  still only drawn: the project's documents link by path, and whether
  they should also link by name is the user's to say.
- 2026-11-19, with [ADR 0025](0025-documents-link-by-name-as-well-as-by-path.md):
  links between double brackets now lead to the document they name, and
  the documents are offered when `[[` is typed. Backlinks are still not
  listed.
- 2026-11-20: no longer seen in the browser preview only. The cycle
  self-test, which runs in the app's own window, now opens a document
  as text and checks that it is drawn (a heading sized, markup hidden, a
  link marked), that the action Enter runs starts a list's next item,
  that a link is followed from the text, and that a page of 28,587
  characters is drawn with the worker having answered for it: 1.3 and
  1.4 seconds on this machine, in two runs, from asking for the file.
  The steps run the actions and not the keys, and the self-test is not
  run by CI. How it looks there has still not been seen by eye.
- 2026-11-20, later: seen by eye in the app's own window, in pictures
  of that window taken while the self-test ran, at 1400 and 720 wide in
  the dark and the light theme: a long page drawn as written, and the
  moment of plain text before its reading comes.

