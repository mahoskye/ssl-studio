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
 * The editor's keys where they are not left as the editor has them: Sublime Text's keys for editing (ADR 0032,
 * ADR 0034). The editor comes with VS Code's. Where the two differ on a key for editing, the key does what it does
 * in Sublime Text; the commands the key had keep their place in the editor's command list (F1), and in the menus.
 *
 * Each rule is written for Windows and Linux, and for a Mac where Sublime Text's key there is another.
 *
 * Ctrl+M was the editor's own key for "Tab moves focus": pressed once, Tab leaves the editor instead of indenting,
 * in every editor, until the key is pressed again, and nothing on the screen says so. It is Sublime Text's key
 * for "jump to matching bracket", so a hand used to that turned Tab off without knowing it had. On a Mac the
 * editor's key for the mode is Ctrl+Shift+M, which is Sublime Text's "select to bracket" there as it is here.
 *
 * Left as the editor has them, though Sublime Text differs: Ctrl+Shift+Space (parameter hints, not "expand
 * selection to scope") and Ctrl+Space, since what the language server says is asked for as in VS Code; F2
 * (rename) and Ctrl+F2 (change all occurrences), where Sublime Text keeps bookmarks, which this editor has none of.
 */
export function setEditorKeys() {
	const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
	const { KeyMod: M, KeyCode: K } = monaco;
	/** The Ctrl key itself, on a Mac too: Sublime Text's bracket keys are on it there. */
	const ctrl = mac ? M.WinCtrl : M.CtrlCmd;
	const text = "editorTextFocus";
	const writing = "editorTextFocus && !editorReadonly";
	const chord = (first: number, second: number) => M.chord(M.CtrlCmd | first, M.CtrlCmd | second);
	type Rule = { key: number; command: string; when: string; frees?: string[] };
	const rules: Rule[] = [
		// Lines.
		{ key: M.CtrlCmd | M.Shift | K.KeyD, command: "editor.action.duplicateSelection", when: writing },
		{ key: M.CtrlCmd | K.KeyJ, command: "editor.action.joinLines", when: writing },
		// On Linux the editor adds a cursor with these two; that stays on Shift+Alt+Up and Down, as in Sublime Text.
		{ key: mac ? M.WinCtrl | M.CtrlCmd | K.UpArrow : M.CtrlCmd | M.Shift | K.UpArrow, command: "editor.action.moveLinesUpAction", when: writing, frees: ["editor.action.insertCursorAbove"] },
		{ key: mac ? M.WinCtrl | M.CtrlCmd | K.DownArrow : M.CtrlCmd | M.Shift | K.DownArrow, command: "editor.action.moveLinesDownAction", when: writing, frees: ["editor.action.insertCursorBelow"] },
		{ key: mac ? K.F5 : K.F9, command: "editor.action.sortLinesAscending", when: writing },
		{ key: chord(K.KeyK, K.KeyK), command: "deleteAllRight", when: writing, frees: ["editor.action.selectFromAnchorToCursor"] },
		...(mac
			? []
			: [
					{ key: M.CtrlCmd | M.Shift | K.Delete, command: "deleteAllRight", when: writing },
					{ key: M.CtrlCmd | M.Shift | K.Backspace, command: "deleteAllLeft", when: writing },
				]),
		// Letter case. The editor had these two for "remove line comment" and "toggle fold".
		{ key: chord(K.KeyK, K.KeyU), command: "editor.action.transformToUppercase", when: writing, frees: ["editor.action.removeCommentLine"] },
		{ key: chord(K.KeyK, K.KeyL), command: "editor.action.transformToLowercase", when: writing, frees: ["editor.toggleFold"] },
		// Selections. Ctrl+Shift+L is "split into lines"; every occurrence of the selection is Alt+F3.
		{ key: M.CtrlCmd | M.Shift | K.KeyL, command: "editor.action.insertCursorAtEndOfEachLineSelected", when: text, frees: ["editor.action.selectHighlights"] },
		{ key: mac ? M.WinCtrl | M.CtrlCmd | K.KeyG : M.Alt | K.F3, command: "editor.action.selectHighlights", when: text },
		{ key: M.CtrlCmd | M.Shift | K.KeyU, command: "cursorRedo", when: text },
		// Brackets.
		{ key: ctrl | K.KeyM, command: "editor.action.jumpToBracket", when: text, frees: mac ? [] : ["editor.action.toggleTabFocusMode"] },
		{ key: ctrl | M.Shift | K.KeyM, command: "editor.action.selectToBracket", when: text, frees: mac ? ["editor.action.toggleTabFocusMode"] : [] },
		// Folds: the editor's Ctrl+K Ctrl+0 folds everything, Sublime Text's unfolds everything.
		{ key: chord(K.KeyK, K.Digit0), command: "editor.unfoldAll", when: text, frees: ["editor.foldAll"] },
	];
	monaco.editor.addKeybindingRules(
		rules.flatMap(({ key, command, when, frees = [] }) => [...frees.map((freed) => ({ keybinding: key, command: `-${freed}` })), { keybinding: key, command, when }]),
	);
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
