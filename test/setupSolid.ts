// Bun test preload: resolve SolidJS 2.0's client/browser dev runtime instead of its
// Node SSR stub (`dist/server.js`) so unit tests exercise real Solid 2 reactivity with
// dev diagnostics enabled, and provide JSX runtime shims when Bun directly imports `.tsx`
// modules to test pure exports.
import { mock } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
