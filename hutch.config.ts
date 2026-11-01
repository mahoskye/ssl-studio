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
		// Settings and history go to .selftest/, not the user's own.
		selftest:
			"hutch electrobun prepare && bun scripts/assets.ts && hutch pm exec -- vite build && XDG_CONFIG_HOME=$PWD/.selftest/config XDG_DATA_HOME=$PWD/.selftest/data XDG_STATE_HOME=$PWD/.selftest/state SSL_STUDIO_SELFTEST=$PWD/selftest.json SSL_STUDIO_FOLDER=$PWD/fixtures/workspace hutch electrobun dev",
		check: "hutch pm exec -- tsc --noEmit -p .",
		build: "hutch electrobun prepare && bun scripts/assets.ts && hutch pm exec -- vite build && hutch electrobun build --env=stable",
	},
};
