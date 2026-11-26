// Monaco with every editor feature and none of its own language services:
// SSL support comes from the grammar and the language server only.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
// Not in register.all: without it Monaco never asks for semantic tokens.
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.languages.register({
	id: "ssl",
	extensions: [".ssl", ".srvscr", ".ds", ".ssl.txt", ".srvscr.txt", ".ds.txt"],
	aliases: ["SSL", "STARLIMS Scripting Language"],
});

/**
 * The editor's keys where they are not left as the editor has them.
 *
 * Ctrl+M is its own key for "Tab moves focus": pressed once, Tab leaves the editor instead of indenting, in
 * every editor, until the key is pressed again, and nothing on the screen says so. It is also Sublime Text's key
 * for "jump to matching bracket" (ADR 0032), so a hand used to that turned Tab off without knowing it had. The
 * key goes to the bracket; the mode keeps its place in the editor's command list (F1). On a Mac the editor's key
 * for the mode is another (Ctrl+Shift+M), and Ctrl+M is free for the bracket.
 */
export function setEditorKeys() {
	const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
	const ctrlM = (mac ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd) | monaco.KeyCode.KeyM;
	monaco.editor.addKeybindingRules([
		...(mac ? [] : [{ keybinding: ctrlM, command: "-editor.action.toggleTabFocusMode" }]),
		{ keybinding: ctrlM, command: "editor.action.jumpToBracket", when: "editorTextFocus" },
	]);
}

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
