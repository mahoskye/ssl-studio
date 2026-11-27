# ADR 0047: Symbol search matches initials where the list it has is whole

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user, who asked for each area of the editor to be
reviewed adversarially and for what was missing to be added. The rule is the
agent's; the user has not reviewed it.

Under [ADR 0003](0003-the-language-server-owns-ssl.md): which procedures a
workspace has is the language server's to say. How a typed query is matched
against their names is the app's, as VS Code matches a server's answer with
its own fuzzy matching.

## Context

- Go to symbol (`#` in the quick open box) asked starlims-lsp with what was
  typed. The server matches a part of a name only, and says so in its
  catalog: "awd" found nothing, where VS Code finds `AddWorkingDays`.
- Its answer is capped at 500 symbols, the open documents' included, and is
  taken from its index in no set order. In a workspace with more procedures
  than that, the answer for nothing typed is a different 500 from one search
  to the next.
- A first attempt matched initials over that answer. In the example
  workspace it listed copies of `AddWorkingDays` from two large files and
  missed the one in `WorkCalendar.ssl`, the file it is defined in. A list
  that finds some copies of a name and not others misleads more than an
  empty one.

## Decision

- **The server's answer for what is typed is listed whole,** as before.
- **Initials and letters in order are matched by the app,** ranked as file
  names are ranked in quick open (the name, its start, the starts of its
  words, anywhere in it, then its letters in order), each typed word having
  to match.
- **They are matched over a list known to be whole:** the server's answer
  for nothing typed when it came back under its cap; past the cap, the open
  documents' own symbol lists (`textDocument/documentSymbol`), which the
  server gives in full.
- **Past the cap, an empty result says why:** only open files are matched
  by initials in a workspace that large, and typing part of the name
  searches every file.

## Consequences

- In a small workspace "awd" finds every `AddWorkingDays`. In a large one it
  finds those in open files, and part of the name finds the rest.
- No request is made of the server. If it later matches letters in order
  itself, as the protocol suggests for `workspace/symbol`, its answer for
  what is typed already covers this, and the loose match over open files
  only adds what it found too.
