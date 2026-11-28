// The code editor's commands that have keys, and whose keys can be changed (ADR 0039).
//
// The shell's shortcuts are a map from a key to a command (view/keys.ts), and Settings lets each be changed. The
// editor's own keys were outside it: they are the editor component's, and no row in Settings named them. Here is
// the list of the editor's commands a key is worth having for, how one of the editor's keys is named in the
// shell's way, and what a key press in the editor's text does once some of those keys have been changed.
//
// Nothing here holds the keys themselves. The keys the editor comes with are read from it while the app runs, so
// they are the ones it really has on this system (they differ between Windows, Linux and a Mac). A change the user
// makes becomes a rule in the editor's own list of keys (view/editor/editorKeys.ts): the editor still decides what
// a press does, by where the cursor is and what is open, and its command list and the menus show the new key.

import { EDITING_KEYS_OVER_SHELL } from "./menuBar";

export type EditorCommand = { id: string; label: string };

/** The editor's commands that Settings lists, each by the editor's own id for it. */
export const EDITOR_COMMANDS: readonly EditorCommand[] = [
	// Lines
	{ id: "editor.action.duplicateSelection", label: "Duplicate selection" },
	{ id: "editor.action.joinLines", label: "Join lines" },
	{ id: "editor.action.moveLinesUpAction", label: "Move line up" },
	{ id: "editor.action.moveLinesDownAction", label: "Move line down" },
	{ id: "editor.action.copyLinesUpAction", label: "Copy line up" },
	{ id: "editor.action.copyLinesDownAction", label: "Copy line down" },
	{ id: "editor.action.deleteLines", label: "Delete line" },
	{ id: "editor.action.insertLineAfter", label: "Insert line below" },
	{ id: "editor.action.insertLineBefore", label: "Insert line above" },
	{ id: "editor.action.indentLines", label: "Indent line" },
	{ id: "editor.action.outdentLines", label: "Outdent line" },
	{ id: "editor.action.sortLinesAscending", label: "Sort lines" },
	{ id: "deleteAllRight", label: "Delete to the end of the line" },
	{ id: "deleteAllLeft", label: "Delete to the start of the line" },
	{ id: "editor.action.transformToUppercase", label: "Upper case" },
	{ id: "editor.action.transformToLowercase", label: "Lower case" },
	{ id: "editor.action.commentLine", label: "Toggle line comment" },
	{ id: "editor.action.blockComment", label: "Toggle block comment" },
	// Selections and cursors
	{ id: "expandLineSelection", label: "Select line" },
	{ id: "editor.action.smartSelect.expand", label: "Expand selection" },
	{ id: "editor.action.smartSelect.shrink", label: "Shrink selection" },
	{ id: "editor.action.addSelectionToNextFindMatch", label: "Add next occurrence" },
	{ id: "editor.action.moveSelectionToNextFindMatch", label: "Skip to next occurrence" },
	{ id: "editor.action.selectHighlights", label: "Select all occurrences" },
	{ id: "editor.action.insertCursorAbove", label: "Add cursor above" },
	{ id: "editor.action.insertCursorBelow", label: "Add cursor below" },
	{ id: "editor.action.insertCursorAtEndOfEachLineSelected", label: "Add cursors to line ends" },
	{ id: "editor.action.jumpToBracket", label: "Go to bracket" },
	{ id: "editor.action.selectToBracket", label: "Select to bracket" },
	{ id: "cursorUndo", label: "Undo cursor move" },
	{ id: "cursorRedo", label: "Redo cursor move" },
	// Finding and going
	{ id: "actions.find", label: "Find" },
	{ id: "editor.action.startFindReplaceAction", label: "Replace" },
	{ id: "editor.action.nextMatchFindAction", label: "Find next" },
	{ id: "editor.action.previousMatchFindAction", label: "Find previous" },
	{ id: "editor.action.gotoLine", label: "Go to line…" },
	{ id: "editor.action.revealDefinition", label: "Go to definition" },
	{ id: "editor.action.peekDefinition", label: "Peek definition" },
	{ id: "editor.action.goToReferences", label: "Go to references" },
	{ id: "editor.action.rename", label: "Rename symbol" },
	{ id: "editor.action.marker.nextInFiles", label: "Next problem" },
	{ id: "editor.action.marker.prevInFiles", label: "Previous problem" },
	// What the language server says
	{ id: "editor.action.triggerSuggest", label: "Trigger suggest" },
	{ id: "editor.action.triggerParameterHints", label: "Trigger parameter hints" },
	{ id: "editor.action.showHover", label: "Show hover" },
	// Folds and formatting
	{ id: "editor.fold", label: "Fold" },
	{ id: "editor.unfold", label: "Unfold" },
	{ id: "editor.foldAll", label: "Fold all" },
	{ id: "editor.unfoldAll", label: "Unfold all" },
	{ id: "editor.action.formatSelection", label: "Format selection" },
];

const LISTED = new Set(EDITOR_COMMANDS.map((command) => command.id));
export const isEditorCommand = (id: string | undefined): boolean => Boolean(id && LISTED.has(id));
export const editorCommandLabel = (id: string): string => EDITOR_COMMANDS.find((command) => command.id === id)?.label ?? id;

/**
 * "Go to Bracket", as the editor names a command, written as this app writes a command's name: "Go to bracket". A
 * word after punctuation ("(Error, Warning, Info)") is a list of names, and stays as it is; so does a word written
 * another way ("IntelliSense").
 */
export const sentenceCase = (label: string) => label.replace(/(?<=[A-Za-z] )([A-Z])([a-z]+)\b/g, (_, first: string, rest: string) => first.toLowerCase() + rest);

/** One key of the editor's with what is held with it, as the editor reports its own keys. */
export type EditorChord = { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; keyLabel: string | null };

/**
 * The keys the editor names otherwise than the shell does: the editor's label, the shell's name for the key, the
 * name it has with Shift on a US keyboard (a key is named by what it types), and the editor's code for it.
 */
const NAMED: readonly [label: string, key: string, shifted: string, code: string][] = [
	["UpArrow", "arrowup", "arrowup", "UpArrow"],
	["DownArrow", "arrowdown", "arrowdown", "DownArrow"],
	["LeftArrow", "arrowleft", "arrowleft", "LeftArrow"],
	["RightArrow", "arrowright", "arrowright", "RightArrow"],
	["Enter", "enter", "enter", "Enter"],
	["Tab", "tab", "tab", "Tab"],
	["Space", "space", "space", "Space"],
	["Backspace", "backspace", "backspace", "Backspace"],
	["Delete", "delete", "delete", "Delete"],
	["Home", "home", "home", "Home"],
	["End", "end", "end", "End"],
	["PageUp", "pageup", "pageup", "PageUp"],
	["PageDown", "pagedown", "pagedown", "PageDown"],
	["Escape", "escape", "escape", "Escape"],
	["Insert", "insert", "insert", "Insert"],
	["/", "/", "?", "Slash"],
	["\\", "\\", "|", "Backslash"],
	["[", "[", "{", "BracketLeft"],
	["]", "]", "}", "BracketRight"],
	[";", ";", ":", "Semicolon"],
	["'", "'", '"', "Quote"],
	[",", ",", "<", "Comma"],
	[".", ".", ">", "Period"],
	["-", "-", "_", "Minus"],
	["=", "=", "+", "Equal"],
	["`", "`", "~", "Backquote"],
];

/** The arrow keys as the editor writes them on a Mac. */
const MAC_ARROWS: Record<string, string> = { "↑": "UpArrow", "↓": "DownArrow", "←": "LeftArrow", "→": "RightArrow" };

/** One key press of the editor's, named as the shell names a press ("ctrl+shift+d"). Null for a key with no name here. */
function chordName(chord: EditorChord, mac: boolean): string | null {
	// Off a Mac the shell reads the Windows key as Ctrl, and the editor does not: such a key has no one name. Nor
	// has one held with Cmd and the Ctrl key both, on a Mac: the shell's names have one of the two.
	if (!chord.keyLabel || (chord.metaKey && (!mac || chord.ctrlKey))) return null;
	const label = MAC_ARROWS[chord.keyLabel] ?? chord.keyLabel;
	let key: string | undefined;
	if (/^[A-Z]$/.test(label)) key = label.toLowerCase();
	else if (/^[0-9]$/.test(label)) key = label;
	else if (/^F([1-9]|1\d|2[0-4])$/.test(label)) key = label.toLowerCase();
	else {
		const named = NAMED.find(([its]) => its === label);
		key = named && (chord.shiftKey ? named[2] : named[1]);
	}
	if (!key) return null;
	// On a Mac, Cmd and the Ctrl key are two keys; elsewhere either is "ctrl" to the shell.
	const first = chord.metaKey ? "cmd+" : chord.ctrlKey ? "ctrl+" : "";
	return `${first}${chord.altKey ? "alt+" : ""}${chord.shiftKey ? "shift+" : ""}${key}`;
}

/**
 * One of the editor's keys as the shell names keys: "ctrl+j", and for a key of two presses the two names with a
 * space between ("ctrl+k ctrl+u"). Null where a press has no name here.
 */
export function editorKeyName(chords: readonly EditorChord[], mac = false): string | null {
	const names = chords.map((chord) => chordName(chord, mac));
	return names.length && names.every(Boolean) ? names.join(" ") : null;
}

/** A key name's presses: one, or two for a key of two presses. */
export const pressesOf = (name: string): string[] => name.split(" ").filter(Boolean);

/**
 * The editor's code for a press named as the shell names it: its modifiers, and the name of its key in the
 * editor's own list of keys. Null for a key that has no place in that list (a letter of another alphabet).
 */
export function editorKeyCode(press: string): { cmd: boolean; ctrl: boolean; alt: boolean; shift: boolean; code: string } | null {
	let key = press;
	const held = { cmd: false, ctrl: false, alt: false, shift: false };
	for (const modifier of ["cmd", "ctrl", "alt", "shift"] as const) {
		if (key.startsWith(`${modifier}+`) && key.length > modifier.length + 1) {
			held[modifier] = true;
			key = key.slice(modifier.length + 1);
		}
	}
	let code: string | undefined;
	if (/^[a-z]$/.test(key)) code = `Key${key.toUpperCase()}`;
	else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
	else if (/^f([1-9]|1\d|2[0-4])$/.test(key)) code = key.toUpperCase();
	else code = NAMED.find(([, plain, shifted]) => plain === key || shifted === key)?.[3];
	return code ? { ...held, code } : null;
}

/**
 * A press as it is written for the reader where it is one of the editor's keys: with Shift, by the key and not by
 * what the key then types ("ctrl+shift+/", not "ctrl+shift+?"), as the editor's own lists and VS Code write it.
 */
export function pressShown(press: string): string {
	const at = press.lastIndexOf("+", press.length - 2) + 1;
	const key = press.slice(at);
	if (!press.slice(0, at).includes("shift+")) return press;
	const named = NAMED.find(([, plain, shifted]) => shifted === key && plain !== key);
	return named ? press.slice(0, at) + named[1] : press;
}

/** The editor's keys as they are: the key's name to the editor's id for the command on it. */
export type EditorKeys = Readonly<Record<string, string>>;

/**
 * The user's changes to the editor's keys, as far as they mean something: one of the listed commands on a key, or
 * "" for a key taken from the command it came with. A command that is not listed is left out, and so is a key the
 * editor has no code for: neither could be shown in Settings, and a key that does something no list shows is a
 * key nobody can find again.
 */
export function editorOverrides(saved: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
	const changes: Record<string, string> = {};
	for (const [written, command] of Object.entries(saved ?? {})) {
		if (command !== "" && !(typeof command === "string" && LISTED.has(command))) continue;
		const presses = pressesOf(written.toLowerCase());
		if (presses.length < 1 || presses.length > 2 || !presses.every(editorKeyCode)) continue;
		changes[presses.join(" ")] = command;
	}
	return changes;
}

/** Where a key the user adds works, for a command that came with no key to take that from: in the editor's text. */
const IN_THE_TEXT = "editorTextFocus";

/** One change to the editor's own list of keys. A command written with "-" before it is taken off the key. */
export type EditorKeyRule = { key: string; command: string; when?: string };

/**
 * The rules that make the editor's keys what the user has changed them to, from the keys it came with (`base`)
 * and the changes (`changes`, as `editorOverrides` gives them).
 *
 * A key given to a command works where that command's own key worked (`when`, the editor's condition for it, by
 * command): "trigger suggest" on a new key still needs a file that has suggestions.
 */
export function editorKeyRules(base: EditorKeys, when: Readonly<Record<string, string>>, changes: Readonly<Record<string, string>>): EditorKeyRule[] {
	const rules: EditorKeyRule[] = [];
	for (const [key, command] of Object.entries(changes)) {
		const had = base[key];
		if (had === command) continue;
		if (had) rules.push({ key, command: `-${had}` });
		if (command) rules.push({ key, command, when: when[command] || IN_THE_TEXT });
	}
	return rules;
}

/**
 * Whether a key is the editor's while the code editor has the keyboard, where the shell has a command on the
 * same key too.
 *
 * `now` is the editor's keys with the user's changes, `chosen` those changes; `shell` is the shell's command on
 * the key and `shellChosen` whether the user put it there. In order:
 *
 * - a key the user gave an editor command is the editor's while code is edited, and the shell's elsewhere;
 * - a key the user gave a shell command is the shell's, in an editor too;
 * - with neither changed, the key is the shell's, but for Sublime Text's editing keys (ADR 0034).
 */
export function editorHasKey(name: string, keys: { now: EditorKeys; chosen: Readonly<Record<string, string>>; shell?: string; shellChosen?: boolean; mac?: boolean }): boolean {
	if (!keys.now[name]) return false;
	if (!keys.shell) return true;
	if (keys.chosen[name]) return true;
	if (keys.shellChosen) return false;
	return EDITING_KEYS_OVER_SHELL.some((own) => own.command === keys.shell && name === (keys.mac ? own.macKey : own.key));
}

// --- The Markdown Live editor, and Markdown's own keys (ADR 0041) ------------------------------------------------
//
// A Markdown document is edited in the code editor (Source) or in the Live editor, which is another editor with
// commands of its own making. It has the same keys as the code editor where it has the command (ADR 0034), and so
// it has them as they are changed: the Live editor's keys are the code editor's, read where the code editor's are
// read, for the commands below. Its own list of keys holds none of them (view/editor/cmKeymap.ts).

/** The listed commands the Live editor has too: each by the code editor's id for it (`LIVE_COMMANDS` runs them). */
export const LIVE_EDITOR_COMMANDS: readonly string[] = [
	"editor.action.duplicateSelection",
	"editor.action.joinLines",
	"editor.action.moveLinesUpAction",
	"editor.action.moveLinesDownAction",
	"editor.action.copyLinesUpAction",
	"editor.action.copyLinesDownAction",
	"editor.action.deleteLines",
	"editor.action.insertLineAfter",
	"editor.action.insertLineBefore",
	"editor.action.indentLines",
	"editor.action.outdentLines",
	"deleteAllRight",
	"deleteAllLeft",
	"editor.action.commentLine",
	"editor.action.blockComment",
	"expandLineSelection",
	"editor.action.smartSelect.expand",
	"editor.action.smartSelect.shrink",
	"editor.action.addSelectionToNextFindMatch",
	"editor.action.selectHighlights",
	"editor.action.insertCursorAbove",
	"editor.action.insertCursorBelow",
	"editor.action.insertCursorAtEndOfEachLineSelected",
	"editor.action.jumpToBracket",
	"editor.action.selectToBracket",
	"cursorUndo",
	"cursorRedo",
	"actions.find",
	"editor.action.startFindReplaceAction",
	"editor.action.nextMatchFindAction",
	"editor.action.previousMatchFindAction",
	"editor.action.gotoLine",
	"editor.fold",
	"editor.unfold",
	"editor.foldAll",
	"editor.unfoldAll",
];

const IN_LIVE = new Set(LIVE_EDITOR_COMMANDS);
export const isLiveEditorCommand = (id: string | undefined): boolean => Boolean(id && IN_LIVE.has(id));

/**
 * The Live editor's keys, out of the editor's keys as they are now: those of one press, on a command the Live
 * editor has. A key of two presses is the code editor's alone: it is the code editor that waits for a second
 * press, and in a Markdown document the first of them (Ctrl+K) inserts a link.
 */
export function liveEditorKeys(now: EditorKeys): Record<string, string> {
	return Object.fromEntries(Object.entries(now).filter(([key, command]) => IN_LIVE.has(command) && pressesOf(key).length === 1));
}

/** What the Live editor calls the keys that the code editor's codes name otherwise than by a letter, a digit or an F-number. */
const LIVE_KEY_NAMES: Readonly<Record<string, string>> = {
	UpArrow: "ArrowUp",
	DownArrow: "ArrowDown",
	LeftArrow: "ArrowLeft",
	RightArrow: "ArrowRight",
	Enter: "Enter",
	Tab: "Tab",
	Space: "Space",
	Backspace: "Backspace",
	Delete: "Delete",
	Home: "Home",
	End: "End",
	PageUp: "PageUp",
	PageDown: "PageDown",
	Escape: "Escape",
	Insert: "Insert",
	Slash: "/",
	Backslash: "\\",
	BracketLeft: "[",
	BracketRight: "]",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Minus: "-",
	Equal: "=",
	Backquote: "`",
};

/**
 * A key of one press, named as the shell names it, as the Live editor writes a key: "ctrl+shift+d" is
 * "Ctrl-Shift-d". A key named by what it types with Shift is written by the key itself ("ctrl+shift+{" is
 * "Ctrl-Shift-["), which is how that editor knows a key whatever the keyboard makes of it. Null for a key of two
 * presses, and for one the code editor has no code for.
 */
export function liveKeyName(name: string): string | null {
	const presses = pressesOf(name);
	const key = presses.length === 1 ? editorKeyCode(presses[0]!) : null;
	if (!key) return null;
	const { code } = key;
	const base = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit\d$/.test(code) ? code.slice(5) : /^F\d+$/.test(code) ? code : LIVE_KEY_NAMES[code];
	if (!base) return null;
	return `${key.cmd ? "Cmd-" : ""}${key.ctrl ? "Ctrl-" : ""}${key.alt ? "Alt-" : ""}${key.shift ? "Shift-" : ""}${base}`;
}

/**
 * The keys the Live editor had for those commands before they followed the code editor's. They are its keys still
 * where the code editor's could not be read (a later version of it may not say), so that it is never left with none.
 */
export const LIVE_KEYS_AS_THEY_CAME: EditorKeys = {
	"ctrl+shift+d": "editor.action.duplicateSelection",
	"ctrl+j": "editor.action.joinLines",
	"ctrl+shift+arrowup": "editor.action.moveLinesUpAction",
	"ctrl+shift+arrowdown": "editor.action.moveLinesDownAction",
	"alt+arrowup": "editor.action.moveLinesUpAction",
	"alt+arrowdown": "editor.action.moveLinesDownAction",
	"alt+shift+arrowup": "editor.action.copyLinesUpAction",
	"alt+shift+arrowdown": "editor.action.copyLinesDownAction",
	"ctrl+shift+k": "editor.action.deleteLines",
	"ctrl+enter": "editor.action.insertLineAfter",
	"ctrl+shift+enter": "editor.action.insertLineBefore",
	"ctrl+]": "editor.action.indentLines",
	"ctrl+[": "editor.action.outdentLines",
	"ctrl+/": "editor.action.commentLine",
	"alt+shift+a": "editor.action.blockComment",
	"ctrl+l": "expandLineSelection",
	"alt+shift+arrowright": "editor.action.smartSelect.expand",
	"alt+shift+arrowleft": "editor.action.smartSelect.shrink",
	"ctrl+d": "editor.action.addSelectionToNextFindMatch",
	"alt+f3": "editor.action.selectHighlights",
	"ctrl+alt+arrowup": "editor.action.insertCursorAbove",
	"ctrl+alt+arrowdown": "editor.action.insertCursorBelow",
	"ctrl+shift+l": "editor.action.insertCursorAtEndOfEachLineSelected",
	"ctrl+m": "editor.action.jumpToBracket",
	"ctrl+shift+m": "editor.action.selectToBracket",
	"ctrl+u": "cursorUndo",
	"ctrl+f": "actions.find",
	"ctrl+h": "editor.action.startFindReplaceAction",
	f3: "editor.action.nextMatchFindAction",
	"shift+f3": "editor.action.previousMatchFindAction",
	"ctrl+g": "editor.action.gotoLine",
};

/** Markdown's own commands that have keys: the shell's id for each, and its name in Settings. */
export const MARKDOWN_COMMANDS: readonly EditorCommand[] = [
	{ id: "md-bold", label: "Toggle bold" },
	{ id: "md-italic", label: "Toggle italic" },
	{ id: "md-strike", label: "Toggle strikethrough" },
	{ id: "md-code", label: "Toggle inline code" },
	{ id: "md-highlight", label: "Toggle highlight" },
	{ id: "md-link", label: "Insert link" },
	{ id: "md-checkbox", label: "Toggle checkbox" },
];

const MARKDOWN = new Set(MARKDOWN_COMMANDS.map((command) => command.id));
export const isMarkdownCommand = (id: string | undefined): boolean => Boolean(id && MARKDOWN.has(id));
export const markdownCommandLabel = (id: string): string => MARKDOWN_COMMANDS.find((command) => command.id === id)?.label ?? id;

/**
 * The keys Markdown's commands come with (Obsidian's). They work while the keyboard is in a Markdown document's
 * text, in either editor, and there they come before every other key: Ctrl+B is bold in a document and the side
 * bar's key everywhere else. Named as the shell names a press; on a Mac the press with Cmd goes by these names too.
 */
export const MARKDOWN_KEYS: EditorKeys = {
	"ctrl+b": "md-bold",
	"ctrl+i": "md-italic",
	"ctrl+shift+x": "md-strike",
	"ctrl+`": "md-code",
	"ctrl+alt+h": "md-highlight",
	"ctrl+k": "md-link",
	"alt+c": "md-checkbox",
	"ctrl+alt+enter": "md-checkbox",
};

/**
 * The user's changes to Markdown's keys, as far as they mean something: one of Markdown's commands on a key of
 * one press that may be a shortcut (`usable`), or "" for a key taken from the command it came with.
 */
export function markdownOverrides(saved: Readonly<Record<string, unknown>> | undefined, usable: (key: string) => boolean): Record<string, string> {
	const changes: Record<string, string> = {};
	for (const [written, command] of Object.entries(saved ?? {})) {
		if (command !== "" && !(typeof command === "string" && MARKDOWN.has(command))) continue;
		const key = written.trim().toLowerCase();
		if (!key || /\s/.test(key) || !usable(key)) continue;
		changes[key] = command;
	}
	return changes;
}
