import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "ssl-studio-spike",
		identifier: "dev.ssl-studio.spike",
		version: "0.0.1",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"dist/onig.wasm": "views/mainview/onig.wasm",
			"dist/grammar": "views/mainview/grammar",
		},
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
