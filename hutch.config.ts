// Scripts for `hutch run <name>`. The app builds with Electrobun 2.x
// through Hutch (ADR 0001); `web` serves the same UI to a browser tab for
// development and UI checks.
//
// Vite runs under Node on every OS. Through `hutch pm exec` it ran under Node
// on Linux (the bin's shebang) but under Hutch's own runtime on Windows, which
// put `__name(...)` calls into the helpers Vite copies into the bundle from its
// own source, and the view failed to start with "__name is not defined".
const vite = "node node_modules/vite/bin/vite.js build";

export default {
	electrobun: { version: "2.0.5" },
	scripts: {
		install: ["hutch", "install"],
		assets: "bun scripts/assets.ts",
		start: `hutch electrobun prepare && bun scripts/assets.ts && ${vite} && hutch electrobun dev`,
		web: `bun scripts/assets.ts && ${vite} && bun src/bun/web.ts`,
		test: "bun test",
		// Runs the desktop app on the sample workspace, checks it, writes selftest.json, quits.
		// Settings and history go to .selftest/, not the user's own. Fails when a check fails.
		selftest: `hutch electrobun prepare && bun scripts/assets.ts && ${vite} && bun scripts/selftest.ts`,
		// The same, plus a plan built, changed and rebuilt in the window, with the fake in place of a model.
		"selftest-cycle": `hutch electrobun prepare && bun scripts/assets.ts && ${vite} && bun scripts/selftest.ts --cycle`,
		check: "hutch pm exec -- tsc --noEmit -p .",
		// A release: the pinned language server goes inside (bun scripts/bundle-lsp.ts --download fetches it).
		build: `hutch electrobun prepare && bun scripts/assets.ts && bun scripts/bundle-lsp.ts && bun scripts/notices.ts && ${vite} && hutch electrobun build --env=stable`,
	},
};
