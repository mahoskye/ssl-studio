# Instructions for agents working on SSL Studio

## This repository is public

- Never commit STARLIMS code from work projects, the corpus, the sequencing
  sample, raw Designer output, staff names or deployment hosts. Tests and
  screenshots use SSL written for this repository or taken from the public
  style guide and reference site.
- Never commit opencode transcripts, credentials, or the opencode service
  password (`~/.config/opencode/service.json`). Read it at run time only.
- See the program's
  [DATA-BOUNDARIES.md](../starlims-program/DATA-BOUNDARIES.md), rule 1.

## The IDE knows no SSL of its own

- Every SSL fact comes from `starlims-lsp`: tokens, syntax tree, symbols,
  diagnostics, formatting. Do not write an SSL parser, tokenizer or formatter
  here, not even a "quick" one for the blocks view. If the language server
  lacks something, ask for it in an issue on `starlims-lsp` (ADR 0003).
- Style rules come from the style guide through the language server. House
  style settings choose among the server's options; they do not reimplement
  them.

## Text is the source of truth

- The blocks and graph views are projections of the text. An edit in either
  view becomes a text edit on the ranges it touches, followed by a range
  format. Never reprint a whole file from a tree (ADR 0002).
- Code the parser cannot read stays visible and editable as a raw text block.
  No view may drop or rewrite code it does not understand.

## Models cost money

- Do not run opencode against a paid provider (Copilot, OpenAI, OpenRouter)
  in tests or by hand without asking the user first. Automated tests use a
  recorded fake of the opencode API.
- The IDE's default model is a local one (Ollama or another local server).

## Decisions

- Record decisions in `docs/adr/`, numbered. Supersede, never rewrite.
- A decision that affects another project goes in the program's
  `decisions/` and is linked from here.
