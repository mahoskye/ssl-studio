# ADR 0001: A desktop app on Electrobun

**Status:** Accepted (M0 spike passed 2026-11-01)
**Date:** 2026-10-31
**Decided by:** the user chose a desktop window over a browser tab
(2026-10-31); Electrobun follows from "Bun-powered".

## Context

- The user wants a Bun-powered IDE in its own window.
- Electron runs Node, not Bun. Tauri runs Rust. Electrobun runs Bun as the
  main process and the system webview as the UI, with an option to bundle
  CEF.
- The IDE must run on the user's remote machine too, where the cleanup runner
  failed on an opencode version difference.

## Decision

- Electrobun: Bun main process, system webview, typed RPC between them.
- The UI is a web app that does not depend on Electrobun beyond the RPC
  layer, so it could also be served to a browser if the shell ever fails.
- M0 confirms Monaco runs well in WebKitGTK. If not, bundle CEF.

## Consequences

- One language (TypeScript) on both sides; `bun test` for both.
- The remote machine's OS decides which builds to produce. Not yet known.

## M0 result (2026-10-31)

- Monaco, the TextMate grammar and the LSP client run in WebKitGTK 2.52 with
  every check passing and a 6,250-line file scrolling at 18 ms a frame. **The
  system webview is enough; CEF is not needed** ([M0](../spikes/M0.md)).
- Electrobun 2.x installs through Hutch, which downloads the runtime from
  GitHub releases.
- UI library: Solid.

## Window result (2026-11-01)

- The same page runs in an Electrobun 2.0.5 window from `views://`, every
  check passing, timings within a few milliseconds of MiniBrowser.
- The LSP bridge over Electrobun's RPC works. RPC costs about 16 ms per round
  trip for small messages and 93 ms for 1 MB. Kept for M1; if completion
  feels slow while typing, a loopback WebSocket from the Bun process with a
  per-launch token is the fallback, and the LSP client already takes either.