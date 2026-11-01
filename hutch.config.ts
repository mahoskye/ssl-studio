// Scripts for `hutch run <name>`. The app builds with Electrobun 2.x
// through Hutch (ADR 0001); `web` serves the same UI to a browser tab for
// development and UI checks.
export default {
	electrobun: { version: "2.0.5" },
	scripts: {
		install: ["hutch", "install"],
		assets: "bun scripts/assets.ts",
		start: "hutch electrobun prepare && bun scripts/assets.ts && hutch pm exec -- vite build && hutch electrobun dev",
		web: "bun scripts/assets.ts && hutch pm exec -- vite build && bun src/bun/web.ts",
		test: "bun test",
		// Runs the desktop app on the sample workspace, checks it, writes selftest.json, quits.
		// Settings and history go to .selftest/, not the user's own. Fails when a check fails.
		selftest: "hutch electrobun prepare && bun scripts/assets.ts && hutch pm exec -- vite build && bun scripts/selftest.ts",
		check: "hutch pm exec -- tsc --noEmit -p .",
		// A release: the pinned language server goes inside (bun scripts/bundle-lsp.ts --download fetches it).
		build: "hutch electrobun prepare && bun scripts/assets.ts && bun scripts/bundle-lsp.ts && bun scripts/notices.ts && hutch pm exec -- vite build && hutch electrobun build --env=stable",
	},
};
