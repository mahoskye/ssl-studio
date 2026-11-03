// Writes src/view/public/THIRD-PARTY-NOTICES.md: the license texts of the
// packages, files and runtime the app ships, so every build carries them.
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// Vite is here for the small helpers it copies into the bundle.
const packages = ["monaco-editor", "solid-js", "vscode-textmate", "vscode-oniguruma", "elkjs", "vite"];
const fence = (text: string) => `\`\`\`\n${text.trim()}\n\`\`\`\n`;
const parts = ["# Third-party notices\n", "SSL Studio is MIT licensed (LICENSE). It ships the following.\n"];
for (const name of packages) {
	const dir = join(root, "node_modules", name);
	const pkg = await Bun.file(join(dir, "package.json")).json();
	parts.push(`## ${name} ${pkg.version} (${pkg.license})\n`);
	if (name === "elkjs") parts.push("Used under EPL-2.0 and included unmodified. Its source is at https://github.com/kieler/elkjs.\n");
	for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICES.txt", "ThirdPartyNotices.txt"]) {
		if (!existsSync(join(dir, file))) continue;
		let text = await Bun.file(join(dir, file)).text();
		// Vite's file goes on to its own build-time dependencies, which the app does not ship.
		if (name === "vite") text = text.split("# Licenses of bundled dependencies")[0];
		parts.push(`### ${file}\n\n${fence(text)}`);
	}
}
parts.push(
	"## Codicons (CC BY 4.0)\n\nThe icon font inside monaco-editor is Microsoft's Codicons " +
		"(https://github.com/microsoft/vscode-codicons), licensed under the Creative Commons " +
		"Attribution 4.0 International license (https://creativecommons.org/licenses/by/4.0/).\n",
);
const source = (await Bun.file(join(root, "src/view/public/grammar/SOURCE")).text()).trim();
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
for (const [what, file] of runtime) parts.push(`## ${what}\n\n${fence(await Bun.file(join(root, "third-party", file)).text())}`);

parts.push("## starlims-lsp\n\nWhen a build bundles the language server, its license and notices are in `bin/` beside it.\n");
await Bun.write(join(root, "src/view/public/THIRD-PARTY-NOTICES.md"), parts.join("\n"));
console.log(`notices for ${packages.length} packages and ${runtime.length} runtime parts`);
