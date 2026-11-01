import { defineConfig } from "vite";
import { resolve } from "node:path";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

// The page and its assets come from spikes/m0-editor; only the host differs.
export default defineConfig({
	resolve: {
		alias: electrobunViteAliases(resolve(__dirname, ".hutch/devkit")),
	},
	root: "src/mainview",
	publicDir: resolve(__dirname, "../m0-editor/web/public"),
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		chunkSizeWarningLimit: 8000,
	},
});
