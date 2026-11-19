# ADR 0019: A file is written back in what it was written in

**Status:** Accepted
**Date:** 2026-11-19
**Decided by:** drafted from the work, after a review found files changed
by being saved; the user has not reviewed it.

Under [ADR 0002](0002-text-is-the-source-of-truth.md) and
[ADR 0009](0009-nothing-is-lost-or-destroyed-without-a-say.md).

## Context

- The IDE read every file as UTF-8 and wrote every file as UTF-8. A file
  in anything else was changed by being saved, with nothing said.
- Scripts and SQL from older tools on Windows are often in the one-byte
  Windows encoding (Windows-1252), and SQL saved from some tools is UTF-16.
  Read as UTF-8, a letter with an accent became a mark for "unreadable",
  and the save wrote that mark over the letter.
- A table exported from a spreadsheet on Windows is seldom UTF-8 either.

## Decision

- **A file is read as what it is:** by the mark it opens with (UTF-8,
  UTF-16 either way round); failing a mark, as UTF-8 where it reads as
  UTF-8, and otherwise as Windows-1252.
- **A file is written in what it is written in now,** its mark with it. A
  new file is UTF-8 with no mark.
- **A save that the encoding cannot hold is refused, and says which
  character.** The file is not turned into UTF-8 on the quiet: whatever
  reads it next would find every other accented letter changed.
- **A file that is not text says so** (UTF-16 with a byte left over) and
  is not opened as something else.
- **An export is read the same way.**

## Consequences

- Saving a file from an older tool no longer damages it.
- A character Windows-1252 has no byte for cannot be typed into such a
  file and saved. Changing a file's encoding is done outside the IDE.
- Which one-byte encoding a file is in is assumed, not known: a file in
  another one-byte encoding reads with the wrong letters, though it still
  saves back byte for byte.
- The listing, the search and the catalogs still read files as UTF-8 to
  show them; only opening and saving go through this.
