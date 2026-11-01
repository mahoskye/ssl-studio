import type { ElectrobunConfig } from "electrobun";
import { existsSync } from "node:fs";

// The pinned language server, when scripts/bundle-lsp.ts has put it in vendor/.
const lsp = ["vendor/starlims-lsp", "vendor/starlims-lsp.exe"].find((p) => existsSync(p));

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
			...(existsSync("dist/THIRD-PARTY-NOTICES.md") ? { "dist/THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md" } : {}),
			...(lsp ? { [lsp]: `bin/${lsp.slice("vendor/".length)}` } : {}),
			...(existsSync("vendor/STARLIMS-LSP-LICENSE") ? { "vendor/STARLIMS-LSP-LICENSE": "bin/STARLIMS-LSP-LICENSE" } : {}),
			...(existsSync("vendor/THIRD-PARTY-NOTICES.md") ? { "vendor/THIRD-PARTY-NOTICES.md": "bin/STARLIMS-LSP-THIRD-PARTY-NOTICES.md" } : {}),
		},
		watchIgnore: ["dist/**"],
		linux: { bundleCEF: false },
		mac: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
