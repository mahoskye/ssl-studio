// Puts the view's static assets in src/view/public: the Oniguruma wasm from
// node_modules, and (with --grammar) a fresh copy of the formatter
// extension's TextMate grammar. The grammar is committed with its source
// commit recorded and never edited here (ADR 0003), with its language
// configuration (comment markers, brackets).
//
//   bun scripts/assets.ts              copy the wasm
//   bun scripts/assets.ts --grammar    also update the grammar from SSL_FORMATTER
import { $ } from "bun";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const root = `${import.meta.dir}/..`;
const pub = `${root}/src/view/public`;
mkdirSync(`${pub}/grammar`, { recursive: true });
await Bun.write(`${pub}/onig.wasm`, Bun.file(`${root}/node_modules/vscode-oniguruma/release/onig.wasm`));

if (process.argv.includes("--grammar")) {
	const formatter = process.env.SSL_FORMATTER ?? `${homedir()}/dev/starlims-projects/vs-code-ssl-formatter`;
	const path = "syntaxes/ssl.tmLanguage.json";
	const config = "language-configuration.json";
	const commit = (await $`git -C ${formatter} log -1 --format=%H -- ${path} ${config}`.text()).trim();
	await Bun.write(`${pub}/grammar/ssl.tmLanguage.json`, Bun.file(`${formatter}/${path}`));
	await Bun.write(`${pub}/grammar/${config}`, Bun.file(`${formatter}/${config}`));
	await Bun.write(`${pub}/grammar/SOURCE`, `mahoskye/vs-code-ssl-formatter ${path} and ${config} @ ${commit}\n`);
	console.log(`grammar @ ${commit.slice(0, 7)}`);
}
