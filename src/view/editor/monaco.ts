// Monaco with every editor feature and none of its own language services:
// SSL support comes from the grammar and the language server only.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
// Not in register.all: without it Monaco never asks for semantic tokens.
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.languages.register({ id: "ssl", extensions: [".ssl", ".srvscr", ".ds"], aliases: ["SSL", "STARLIMS Scripting Language"] });

/** Comment markers and brackets from the formatter extension's language configuration. */
export async function loadLanguageConfiguration() {
	const config = await fetch("./grammar/language-configuration.json").then((r) => r.json());
	const { comments, brackets, autoClosingPairs, surroundingPairs } = config;
	monaco.languages.setLanguageConfiguration("ssl", {
		comments,
		brackets,
		autoClosingPairs,
		surroundingPairs: surroundingPairs.map(([open, close]: string[]) => ({ open, close })),
	});
}

export { monaco };
export const languageFor = (path: string) => (/\.(ssl|srvscr|ds)$/i.test(path) ? "ssl" : /\.json$/i.test(path) ? "json" : "plaintext");
