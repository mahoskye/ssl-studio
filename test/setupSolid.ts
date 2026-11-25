// Bun test preload: resolve SolidJS 2.0's client/browser dev runtime instead of its
// Node SSR stub (`dist/server.js`) so unit tests exercise real Solid 2 reactivity with
// dev diagnostics enabled, and provide JSX runtime shims when Bun directly imports `.tsx`
// modules to test pure exports.
import { afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The app's own files (settings, recent folders, local history) go to a folder made for this run and removed
// after it. They are found from these variables when src/bun/paths.ts is first imported, so they are set here,
// before any test is. Without this, every test that opened a folder or started a host without redirecting them
// itself wrote the developer's real ones: a run of the suite left the app's Recent list holding ten deleted
// test folders and nothing else, and filled the real local history with theirs.
const appState = mkdtempSync(join(tmpdir(), "ssl-studio-test-state-"));
process.env.XDG_CONFIG_HOME = join(appState, "config");
process.env.XDG_DATA_HOME = join(appState, "data");
process.env.XDG_STATE_HOME = join(appState, "state");
// Once, after the last test file (a hook in a preload is the run's; the process's own "exit" is not raised here).
afterAll(() => rmSync(appState, { recursive: true, force: true }));

const signalsDevPath = resolve(import.meta.dir, "../node_modules/@solidjs/signals/dist/dev.js");
const signalsDev = await import(pathToFileURL(signalsDevPath).href);
mock.module("@solidjs/signals", () => signalsDev);

const solidDevPath = resolve(import.meta.dir, "../node_modules/solid-js/dist/solid.dev.js");
const solidClient = await import(pathToFileURL(solidDevPath).href);
mock.module("solid-js", () => solidClient);

// Note: import `web.js` (not `web.dev.js`) because `@solidjs/web/package.json` maps
// `./jsx-dev-runtime` directly to `./dist/web.dev.js`; pre-loading `web.dev.js` bypasses
// Bun's `mock.module("@solidjs/web/jsx-dev-runtime")` shim for direct `.tsx` test imports.
// Reactive dev diagnostics live in `@solidjs/signals/dist/dev.js` + `solid-js/dist/solid.dev.js`.
const webPath = resolve(import.meta.dir, "../node_modules/@solidjs/web/dist/web.js");
const webClient = await import(pathToFileURL(webPath).href);

const jsxShim = {
	...webClient,
	jsx: () => null,
	jsxs: () => null,
	jsxDEV: () => null,
	Fragment: () => null,
};
mock.module("@solidjs/web", () => jsxShim);
mock.module("@solidjs/web/jsx-runtime", () => jsxShim);
mock.module("@solidjs/web/jsx-dev-runtime", () => jsxShim);
