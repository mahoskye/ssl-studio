// Copies the formatter extension's TextMate grammar and the Oniguruma wasm
// into web/public, recording where the grammar came from. The grammar is
// never edited here (ADR 0003).
import { $ } from "bun";

const formatter = process.env.SSL_FORMATTER ?? `${process.env.HOME}/dev/starlims-projects/vs-code-ssl-formatter`;
const commit = (await $`git -C ${formatter} log -1 --format=%H -- syntaxes/ssl.tmLanguage.json`.text()).trim();
await $`mkdir -p web/public/grammar`;
await Bun.write("web/public/grammar/ssl.tmLanguage.json", Bun.file(`${formatter}/syntaxes/ssl.tmLanguage.json`));
await Bun.write("web/public/grammar/SOURCE", `mahoskye/vs-code-ssl-formatter syntaxes/ssl.tmLanguage.json @ ${commit}\n`);
await Bun.write("web/public/onig.wasm", Bun.file("node_modules/vscode-oniguruma/release/onig.wasm"));
console.log(`grammar @ ${commit.slice(0, 7)}`);
