// Writes src/view/public/THIRD-PARTY-NOTICES.md: the license texts of the
// packages and files the app ships, so every build carries them.
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const packages = ["monaco-editor", "solid-js", "vscode-textmate", "vscode-oniguruma", "elkjs"];
const parts = ["# Third-party notices\n", "SSL Studio is MIT licensed (LICENSE). It ships the following.\n"];
for (const name of packages) {
	const dir = join(root, "node_modules", name);
	const pkg = await Bun.file(join(dir, "package.json")).json();
	parts.push(`## ${name} ${pkg.version} (${pkg.license})\n`);
	for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICES.txt", "ThirdPartyNotices.txt"])
		if (existsSync(join(dir, file))) parts.push(`### ${file}\n\n\`\`\`\n${(await Bun.file(join(dir, file)).text()).trim()}\n\`\`\`\n`);
}
const source = (await Bun.file(join(root, "src/view/public/grammar/SOURCE")).text()).trim();
parts.push(`## SSL grammar and language configuration (MIT)\n\nFrom ${source}, copyright Benjamin Buddle, MIT licensed.\n`);
parts.push("## starlims-lsp\n\nWhen a build bundles the language server, its license and notices are in `bin/` beside it.\n");
await Bun.write(join(root, "src/view/public/THIRD-PARTY-NOTICES.md"), parts.join("\n"));
console.log(`notices for ${packages.length} packages`);
