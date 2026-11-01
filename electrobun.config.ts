import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "SSL Studio",
		identifier: "dev.ssl-studio.app",
		version: "0.1.0",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			"dist/index.html": "views/main/index.html",
			"dist/assets": "views/main/assets",
			"dist/onig.wasm": "views/main/onig.wasm",
			"dist/grammar": "views/main/grammar",
		},
		watchIgnore: ["dist/**"],
		linux: { bundleCEF: false },
		mac: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
