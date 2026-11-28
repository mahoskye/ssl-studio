# ADR 0046: A save writes the encoding the text was read in

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user, who asked for the defects of the second review of
the editor to be fixed. The rule is the agent's; the user has not reviewed it.

Supersedes one point of
[ADR 0019](0019-a-file-is-written-back-in-what-it-was-written-in.md): that a
file is written in what its bytes on disk say it is written in now.

## Context

- Each save worked out the file's encoding again from its bytes on disk.
- A Windows-1252 file whose one accented letter was taken out and saved was
  plain ASCII on disk, which reads as UTF-8 too. The next save, with a `µ`
  typed, wrote it as UTF-8, two bytes, while the status bar still said
  Windows-1252.
- VS Code keeps the encoding a file was opened in until the user changes it.

## Decision

- **A document is saved in the encoding it was read in,** which the editor
  hands to the backend with the text. The status bar says that encoding, and
  now it is the one written.
- **Without one** (a file written by the app itself, a new file), the
  backend works the encoding out from the bytes on disk, as before.
- The rest of ADR 0019 stands: a character the encoding has no byte for is
  refused, and a new file is UTF-8 with no mark.

## Consequences

- A file another tool rewrote in another encoding while it was open is saved
  in the encoding it was opened in. Saving asks first, since the file
  changed on disk (ADR 0009); reloading it reads its new encoding.
