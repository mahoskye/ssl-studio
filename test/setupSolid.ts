// Bun test preload: resolve SolidJS 2.0's client/browser reactive runtime instead of its
// Node SSR stub (`dist/server.js`) so unit tests exercise real Solid 2 reactivity, and
// provide JSX runtime shims when Bun directly imports `.tsx` modules to test pure exports.
import { mock } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const solidClient = await import(pathToFileURL(resolve(import.meta.dir, "../node_modules/solid-js/dist/solid.js")).href);
mock.module("solid-js", () => solidClient);
const webClient = await import(pathToFileURL(resolve(import.meta.dir, "../node_modules/@solidjs/web/dist/web.js")).href);
mock.module("@solidjs/web", () => webClient);

const jsxShim = {
	...webClient,
	jsx: () => null,
	jsxs: () => null,
	jsxDEV: () => null,
	Fragment: () => null,
};
mock.module("@solidjs/web/jsx-runtime", () => jsxShim);
mock.module("@solidjs/web/jsx-dev-runtime", () => jsxShim);
