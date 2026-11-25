import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const devkit = resolve(import.meta.dirname, ".hutch/devkit");
// The browser host (`hutch run web`) builds without the devkit projected.
const aliases = existsSync(devkit)
	? (await import("./.hutch/devkit/api/config/electrobun-vite.ts")).electrobunViteAliases(devkit)
	: {};

export default defineConfig({
	plugins: [solid()],
	resolve: { alias: aliases },
	root: "src/view",
	base: "./",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		chunkSizeWarningLimit: 8000,
		minify: process.env.NO_MINIFY ? false : "oxc",
	},
});
