# Third-party license texts

License texts for the runtime every build ships, which no npm package in
`node_modules` carries. `scripts/notices.ts` puts them in the app's
`THIRD-PARTY-NOTICES.md`. When Electrobun or its Bun changes version, fetch
these again from the same places at the new tags.

| File | What | From |
|------|------|------|
| `bun-LICENSE.md` | Bun 1.4.4, the app's `bin/bun` (MIT; it statically links JavaScriptCore, LGPL-2, and the libraries it lists) | `oven-sh/bun` at `bun-v1.4.4`, `LICENSE.md` |
| `electrobun-LICENSE` | Electrobun 2.0.5: the launcher, native libraries (`libasar` among them, shipped in Electrobun's repository) and the main-process API (MIT) | `blackboardsh/electrobun` at `v2.0.5`, `LICENSE` |
| `zig-bsdiff-LICENSE` | `bin/bspatch`'s Zig port (MIT) | `blackboardsh/zig-bsdiff` at `18eef2a`, `LICENSE` |
| `bspatch-LICENSE` | bsdiff's own notice, which `bspatch` carries (BSD-2-Clause, Colin Percival) | the header of `bspatch.zig` in `blackboardsh/zig-bsdiff` at `18eef2a` |
| `zig-zstd-LICENSE` | `bin/zig-zstd` (MIT) | `blackboardsh/zig-zstd` at `b371f9f`, `LICENSE` |
| `zstd-LICENSE` | Zstandard, linked into `zig-zstd` and `bspatch` (BSD) | `facebook/zstd` at `1168da0`, `LICENSE` |
| `webview2-LICENSE`, `webview2-NOTICE` | Microsoft's WebView2 loader, linked into Windows builds' `libNativeWrapper.dll` (BSD-style) | the `Microsoft.Web.WebView2` NuGet package, 1.0.4314.35 |
