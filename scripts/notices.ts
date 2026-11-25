// Writes src/view/public/THIRD-PARTY-NOTICES.md: the license texts of the
// packages, files and runtime the app ships, so every build carries them.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// Vite and Rolldown are here for the small runtime helpers copied into the bundle.
const packages = [
	"monaco-editor",
	"@codemirror/state",
	"@codemirror/view",
	"@codemirror/language",
	"@codemirror/commands",
	"@codemirror/search",
	"@codemirror/autocomplete",
	"@codemirror/lang-markdown",
	"@lezer/markdown",
	"@lezer/highlight",
	"solid-js",
	"@solidjs/web",
	"@solidjs/signals",
	"vscode-textmate",
	"vscode-oniguruma",
	"elkjs",
	"marked",
	"mermaid",
	"@braintree/sanitize-url",
	"@iconify/utils",
	"@mermaid-js/parser",
	"@upsetjs/venn.js",
	"chevrotain",
	"cytoscape",
	"cytoscape-cose-bilkent",
	"cytoscape-fcose",
	"d3",
	"d3-sankey",
	"dagre-d3-es",
	"dayjs",
	"es-toolkit",
	"katex",
	"khroma",
	"roughjs",
	"stylis",
	"ts-dedent",
	"dompurify",
	"prettier",
	"@prettier/plugin-xml",
	"sql-formatter",
	"vite",
	"rolldown",
];
export const NOTICE_FILENAMES = [
	"LICENSE",
	"LICENSE.md",
	"LICENSE.txt",
	"NOTICE",
	"NOTICES.txt",
	"ThirdPartyNotices.txt",
	"THIRD-PARTY-LICENSE",
	"THIRD-PARTY-NOTICES.md",
] as const;
export const FALLBACK_LICENSE: Record<string, string> = {
	"solid-js": "third-party/solid-MIT-LICENSE",
	"@solidjs/web": "third-party/solid-MIT-LICENSE",
};
const FALLBACK_SPDX: Record<string, string> = {
	khroma: "MIT",
};

const fence = (text: string) => `\`\`\`\n${text.replace(/\r\n/g, "\n").trim()}\n\`\`\`\n`;

export async function buildNotices(rootDir = root): Promise<{ text: string; packageCount: number; runtimeCount: number }> {
	const parts = ["# Third-party notices\n", "SSL Studio is MIT licensed (LICENSE). It ships the following.\n"];
	for (const name of packages) {
		const dir = join(rootDir, "node_modules", name);
		const pkg = await Bun.file(join(dir, "package.json")).json();
		const licenseLabel = pkg.license ?? FALLBACK_SPDX[name] ?? "see license below";
		parts.push(`## ${name} ${pkg.version} (${licenseLabel})\n`);
		if (name === "elkjs") parts.push("Used under EPL-2.0 and included unmodified. Its source is at https://github.com/kieler/elkjs.\n");
		const entriesByLower = new Map<string, string>();
		for (const entry of readdirSync(dir)) {
			const lower = entry.toLowerCase();
			if (!entriesByLower.has(lower)) entriesByLower.set(lower, entry);
		}
		let found = 0;
		for (const file of NOTICE_FILENAMES) {
			const actual = entriesByLower.get(file.toLowerCase());
			if (!actual) continue;
			let text = await Bun.file(join(dir, actual)).text();
			// Vite's file goes on to its own build-time dependencies, which the app does not ship.
			if (name === "vite") text = text.split("# Licenses of bundled dependencies")[0];
			if (!text.trim()) continue;
			parts.push(`### ${actual}\n\n${fence(text)}`);
			found++;
		}
		if (found === 0) {
			const fallbackRel = FALLBACK_LICENSE[name];
			if (fallbackRel) {
				const fallbackPath = join(rootDir, fallbackRel);
				if (existsSync(fallbackPath)) {
					const text = await Bun.file(fallbackPath).text();
					if (text.trim()) {
						parts.push(`### LICENSE\n\n${fence(text)}`);
						found++;
					}
				}
			}
		}
		if (found === 0) {
			throw new Error(`No license or notice file found for package "${name}" in ${dir}`);
		}
	}
	parts.push(
		"## Codicons (CC BY 4.0)\n\nThe icon font inside monaco-editor is Microsoft's Codicons " +
			"(https://github.com/microsoft/vscode-codicons), licensed under the Creative Commons " +
			"Attribution 4.0 International license (https://creativecommons.org/licenses/by/4.0/).\n",
	);
	const source = (await Bun.file(join(rootDir, "src/view/public/grammar/SOURCE")).text()).trim();
	parts.push(`## SSL grammar and language configuration (MIT)\n\nFrom ${source}, copyright Benjamin Buddle, MIT licensed.\n`);

	// The desktop runtime: texts kept in third-party/ (its README says where each comes from).
	const runtime: [string, string][] = [
		["Bun 1.4.4 (bin/bun)", "bun-LICENSE.md"],
		["Electrobun 2.0.5 (launcher, native libraries, main-process API)", "electrobun-LICENSE"],
		["zig-bsdiff (bin/bspatch)", "zig-bsdiff-LICENSE"],
		["bsdiff, which bspatch is ported from", "bspatch-LICENSE"],
		["zig-zstd (bin/zig-zstd)", "zig-zstd-LICENSE"],
		["Zstandard, linked into zig-zstd and bspatch", "zstd-LICENSE"],
		["Microsoft WebView2 loader, linked into libNativeWrapper.dll on Windows", "webview2-LICENSE"],
		["Microsoft WebView2 SDK notices", "webview2-NOTICE"],
	];
	parts.push("# The desktop runtime\n");
	for (const [what, file] of runtime) parts.push(`## ${what}\n\n${fence(await Bun.file(join(rootDir, "third-party", file)).text())}`);

	parts.push("## starlims-lsp\n\nWhen a build bundles the language server, its license and notices are in `bin/` beside it.\n");
	return { text: parts.join("\n"), packageCount: packages.length, runtimeCount: runtime.length };
}

if (import.meta.main) {
	const { text, packageCount, runtimeCount } = await buildNotices();
	await Bun.write(join(root, "src/view/public/THIRD-PARTY-NOTICES.md"), text);
	console.log(`notices for ${packageCount} packages and ${runtimeCount} runtime parts`);
}
