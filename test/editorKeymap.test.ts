// The code editor's keys as they can be changed in Settings (shared/editorKeymap.ts, ADR 0039): how one of the
// editor's keys is named, which changes mean something, the rules a change becomes, and whose a key is where the
// shell has a command on it too.
import { describe, expect, test } from "bun:test";
import {
	EDITOR_COMMANDS,
	editorCommandLabel,
	editorHasKey,
	editorKeyCode,
	editorKeyName,
	editorKeyRules,
	editorOverrides,
	isEditorCommand,
	pressesOf,
	pressShown,
	type EditorChord,
} from "../src/shared/editorKeymap";
import { MENU_BAR } from "../src/shared/menuBar";
import { bindable, effectiveKeys, rebind, unbind } from "../src/view/keys";

/** One press as the editor reports it. */
const chord = (keyLabel: string, held: Partial<Omit<EditorChord, "keyLabel">> = {}): EditorChord => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...held, keyLabel });

describe("the list of the editor's commands", () => {
	test("names each command once, with a label of its own", () => {
		const ids = EDITOR_COMMANDS.map((command) => command.id);
		const labels = EDITOR_COMMANDS.map((command) => command.label);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(labels).size).toBe(labels.length);
		expect(labels.every((label) => label.trim() === label && label.length > 0)).toBe(true);
	});

	test("says what is in it, and labels a command by its name there", () => {
		expect(isEditorCommand("editor.action.joinLines")).toBe(true);
		expect(isEditorCommand("deleteAllRight")).toBe(true);
		// The shell's own commands, and a command of the editor's that is not listed.
		expect(isEditorCommand("toggle-panel")).toBe(false);
		expect(isEditorCommand("editor.action.quickCommand")).toBe(false);
		expect(isEditorCommand(undefined)).toBe(false);
		expect(editorCommandLabel("editor.action.joinLines")).toBe("Join lines");
		expect(editorCommandLabel("no.such.command")).toBe("no.such.command");
	});

	test("goes by the names the menus use for the same commands", () => {
		const inMenus = new Map<string, string>();
		for (const menu of MENU_BAR) {
			for (const entry of menu.entries) if (entry !== "separator" && "editor" in entry) inMenus.set(entry.editor, entry.label);
		}
		const differing = EDITOR_COMMANDS.filter((command) => inMenus.has(command.id) && inMenus.get(command.id) !== command.label).map((command) => `${command.label} / ${inMenus.get(command.id)}`);
		expect(differing).toEqual([]);
	});
});

describe("one of the editor's keys, named as the shell names keys", () => {
	test("a letter, a digit and a function key", () => {
		expect(editorKeyName([chord("J", { ctrlKey: true })])).toBe("ctrl+j");
		expect(editorKeyName([chord("D", { ctrlKey: true, shiftKey: true })])).toBe("ctrl+shift+d");
		expect(editorKeyName([chord("0", { ctrlKey: true, shiftKey: true })])).toBe("ctrl+shift+0");
		expect(editorKeyName([chord("F9")])).toBe("f9");
		expect(editorKeyName([chord("F3", { altKey: true })])).toBe("alt+f3");
	});

	test("the modifiers in the shell's order: Ctrl, Alt, Shift", () => {
		expect(editorKeyName([chord("DownArrow", { shiftKey: true, altKey: true, ctrlKey: true })])).toBe("ctrl+alt+shift+arrowdown");
	});

	test("the keys the editor names otherwise", () => {
		expect(editorKeyName([chord("UpArrow", { ctrlKey: true, shiftKey: true })])).toBe("ctrl+shift+arrowup");
		expect(editorKeyName([chord("Enter", { ctrlKey: true })])).toBe("ctrl+enter");
		expect(editorKeyName([chord("Space", { ctrlKey: true })])).toBe("ctrl+space");
		expect(editorKeyName([chord("Backspace", { ctrlKey: true, shiftKey: true })])).toBe("ctrl+shift+backspace");
		expect(editorKeyName([chord("/", { ctrlKey: true })])).toBe("ctrl+/");
		expect(editorKeyName([chord("]", { ctrlKey: true })])).toBe("ctrl+]");
	});

	test("with Shift, a key is named by what it types, as a press of it is", () => {
		expect(editorKeyName([chord("/", { ctrlKey: true, shiftKey: true })])).toBe("ctrl+shift+?");
		expect(editorKeyName([chord("[", { ctrlKey: true, shiftKey: true })])).toBe("ctrl+shift+{");
		expect(editorKeyName([chord("\\", { ctrlKey: true, shiftKey: true })])).toBe("ctrl+shift+|");
	});

	test("a key of two presses is the two names with a space between", () => {
		expect(editorKeyName([chord("K", { ctrlKey: true }), chord("U", { ctrlKey: true })])).toBe("ctrl+k ctrl+u");
		expect(pressesOf("ctrl+k ctrl+u")).toEqual(["ctrl+k", "ctrl+u"]);
		expect(pressesOf("ctrl+j")).toEqual(["ctrl+j"]);
	});

	test("no name where a press has none here", () => {
		expect(editorKeyName([])).toBeNull();
		expect(editorKeyName([chord("NumPad0", { ctrlKey: true })])).toBeNull();
		expect(editorKeyName([{ ...chord("K", { ctrlKey: true }), keyLabel: null }])).toBeNull();
		expect(editorKeyName([chord("K", { ctrlKey: true }), chord("NumPad0")])).toBeNull();
		// Off a Mac the shell reads the Windows key as Ctrl, and the editor does not.
		expect(editorKeyName([chord("J", { metaKey: true })])).toBeNull();
	});

	test("on a Mac, Cmd and the Ctrl key are two keys, and the arrows are written as arrows", () => {
		expect(editorKeyName([chord("J", { metaKey: true })], true)).toBe("cmd+j");
		expect(editorKeyName([chord("M", { ctrlKey: true })], true)).toBe("ctrl+m");
		expect(editorKeyName([chord("↑", { metaKey: true, shiftKey: true })], true)).toBe("cmd+shift+arrowup");
		// Held with Cmd and Ctrl both (Sublime Text's "move line" there): the shell's names have no way to say it.
		expect(editorKeyName([chord("↑", { metaKey: true, ctrlKey: true })], true)).toBeNull();
	});

	test("is shown, with Shift, by the key itself", () => {
		expect(pressShown("ctrl+shift+?")).toBe("ctrl+shift+/");
		expect(pressShown("ctrl+shift+{")).toBe("ctrl+shift+[");
		expect(pressShown("ctrl+shift+|")).toBe("ctrl+shift+\\");
		expect(pressShown("ctrl+shift++")).toBe("ctrl+shift+=");
		// Nothing to change: no Shift, or a key that types the same with it.
		expect(pressShown("ctrl+/")).toBe("ctrl+/");
		expect(pressShown("ctrl+shift+d")).toBe("ctrl+shift+d");
		expect(pressShown("ctrl+shift+arrowup")).toBe("ctrl+shift+arrowup");
		expect(pressShown("f9")).toBe("f9");
	});
});

describe("the editor's code for a key named as the shell names it", () => {
	test("the modifiers and the key", () => {
		expect(editorKeyCode("ctrl+j")).toEqual({ cmd: false, ctrl: true, alt: false, shift: false, code: "KeyJ" });
		expect(editorKeyCode("ctrl+alt+shift+arrowdown")).toEqual({ cmd: false, ctrl: true, alt: true, shift: true, code: "DownArrow" });
		expect(editorKeyCode("cmd+shift+0")).toEqual({ cmd: true, ctrl: false, alt: false, shift: true, code: "Digit0" });
		expect(editorKeyCode("f9")?.code).toBe("F9");
		expect(editorKeyCode("alt+f12")?.code).toBe("F12");
		expect(editorKeyCode("u")).toEqual({ cmd: false, ctrl: false, alt: false, shift: false, code: "KeyU" });
	});

	test("a key named by what it types with Shift is the same key", () => {
		expect(editorKeyCode("ctrl+shift+?")?.code).toBe("Slash");
		expect(editorKeyCode("ctrl+/")?.code).toBe("Slash");
		expect(editorKeyCode("ctrl+shift+{")?.code).toBe("BracketLeft");
		expect(editorKeyCode("ctrl++")?.code).toBe("Equal");
	});

	test("none for a key the editor has no place for", () => {
		expect(editorKeyCode("ctrl+ö")).toBeNull();
		expect(editorKeyCode("ctrl+")).toBeNull();
		expect(editorKeyCode("")).toBeNull();
	});

	test("every key read from the editor goes back to the key it was", () => {
		const presses: [EditorChord, string][] = [
			[chord("J", { ctrlKey: true }), "KeyJ"],
			[chord("UpArrow", { ctrlKey: true, shiftKey: true }), "UpArrow"],
			[chord("/", { ctrlKey: true, shiftKey: true }), "Slash"],
			[chord("`", { ctrlKey: true }), "Backquote"],
			[chord("F12", { shiftKey: true }), "F12"],
			[chord("Delete", { ctrlKey: true, shiftKey: true }), "Delete"],
		];
		for (const [press, code] of presses) {
			const back = editorKeyCode(editorKeyName([press])!)!;
			expect(back.code).toBe(code);
			expect([back.ctrl, back.alt, back.shift]).toEqual([press.ctrlKey, press.altKey, press.shiftKey]);
		}
	});
});

describe("the user's changes, as far as they mean something", () => {
	test("a listed command on a key, and a key let go", () => {
		expect(editorOverrides({ "ctrl+alt+j": "editor.action.joinLines", "ctrl+j": "" })).toEqual({ "ctrl+alt+j": "editor.action.joinLines", "ctrl+j": "" });
	});

	test("the key in small letters, with one space between two presses", () => {
		expect(editorOverrides({ "Ctrl+K  Ctrl+B": "editor.action.joinLines" })).toEqual({ "ctrl+k ctrl+b": "editor.action.joinLines" });
	});

	test("not a command that is not listed, a value that is not text, or a key the editor has no code for", () => {
		expect(
			editorOverrides({
				"ctrl+alt+j": "editor.action.quickCommand",
				"ctrl+alt+k": "toggle-panel",
				"ctrl+alt+l": 7,
				"ctrl+ö": "editor.action.joinLines",
				"ctrl+k ctrl+b ctrl+c": "editor.action.joinLines",
				"": "editor.action.joinLines",
			}),
		).toEqual({});
		expect(editorOverrides(undefined)).toEqual({});
	});
});

describe("the rules a change becomes in the editor's own list of keys", () => {
	const base = { "ctrl+j": "editor.action.joinLines", "ctrl+shift+d": "editor.action.duplicateSelection", "ctrl+k ctrl+u": "editor.action.transformToUppercase", f9: "editor.action.sortLinesAscending" };
	const when = { "editor.action.joinLines": "editorTextFocus && !editorReadonly", "editor.action.triggerSuggest": "editorHasCompletionItemProvider && textInputFocus" };

	test("none without a change", () => {
		expect(editorKeyRules(base, when, {})).toEqual([]);
	});

	test("a key let go takes the command off it", () => {
		expect(editorKeyRules(base, when, { "ctrl+j": "" })).toEqual([{ key: "ctrl+j", command: "-editor.action.joinLines" }]);
	});

	test("nothing for a key let go that had nothing, or for a key given the command it came with", () => {
		expect(editorKeyRules(base, when, { "ctrl+alt+j": "", "ctrl+j": "editor.action.joinLines" })).toEqual([]);
	});

	test("a new key works where the command's own key worked", () => {
		expect(editorKeyRules(base, when, { "ctrl+alt+j": "editor.action.joinLines" })).toEqual([{ key: "ctrl+alt+j", command: "editor.action.joinLines", when: "editorTextFocus && !editorReadonly" }]);
		expect(editorKeyRules(base, when, { "ctrl+alt+space": "editor.action.triggerSuggest" })[0]!.when).toBe("editorHasCompletionItemProvider && textInputFocus");
	});

	test("a command that came with no key works in the editor's text", () => {
		expect(editorKeyRules(base, when, { "ctrl+k ctrl+1": "editor.foldAll" })).toEqual([{ key: "ctrl+k ctrl+1", command: "editor.foldAll", when: "editorTextFocus" }]);
	});

	test("a key given to another command is taken from the one it came with", () => {
		expect(editorKeyRules(base, when, { "ctrl+shift+d": "editor.action.joinLines" })).toEqual([
			{ key: "ctrl+shift+d", command: "-editor.action.duplicateSelection" },
			{ key: "ctrl+shift+d", command: "editor.action.joinLines", when: "editorTextFocus && !editorReadonly" },
		]);
	});

	test("moving a command, as Settings does it, lets its old key go and puts it on the new", () => {
		const changes = rebind(base, {}, "editor.action.joinLines", "ctrl+alt+j");
		expect(changes).toEqual({ "ctrl+j": "", "ctrl+alt+j": "editor.action.joinLines" });
		expect(editorKeyRules(base, when, editorOverrides(changes))).toEqual([
			{ key: "ctrl+j", command: "-editor.action.joinLines" },
			{ key: "ctrl+alt+j", command: "editor.action.joinLines", when: "editorTextFocus && !editorReadonly" },
		]);
		// And back: on its own key again there is no change left, and no rule.
		const back = rebind(base, changes, "editor.action.joinLines", "ctrl+j");
		expect(back).toEqual({});
		expect(editorKeyRules(base, when, editorOverrides(back))).toEqual([]);
	});

	test("a key of two presses is let go and given like any other", () => {
		const cleared = unbind(base, {}, "editor.action.transformToUppercase");
		expect(cleared).toEqual({ "ctrl+k ctrl+u": "" });
		expect(editorKeyRules(base, when, editorOverrides(cleared))).toEqual([{ key: "ctrl+k ctrl+u", command: "-editor.action.transformToUppercase" }]);
		expect(rebind(base, cleared, "editor.action.transformToUppercase", "ctrl+k ctrl+u")).toEqual({});
	});

	test("every key a rule is written for is one that may be a shortcut, by its first press", () => {
		for (const key of Object.keys(base)) expect(bindable(pressesOf(key)[0]!).ok).toBe(true);
	});
});

describe("whose a key is while code is edited, where the shell has a command on it too", () => {
	const base = { "ctrl+j": "editor.action.joinLines", "ctrl+shift+d": "editor.action.duplicateSelection", "ctrl+l": "expandLineSelection", "ctrl+shift+m": "editor.action.selectToBracket" };
	const has = (name: string, chosen: Record<string, string>, shell?: string, shellChosen = false, mac = false) => editorHasKey(name, { now: effectiveKeys(base, chosen), chosen, shell, shellChosen, mac });

	test("the editor's, where the shell has nothing on it", () => {
		expect(has("ctrl+l", {})).toBe(true);
		expect(has("ctrl+alt+j", { "ctrl+alt+j": "editor.action.joinLines" })).toBe(true);
	});

	test("not the editor's where the editor has nothing on it", () => {
		expect(has("ctrl+b", {}, "toggle-sidebar")).toBe(false);
		expect(has("ctrl+b", {})).toBe(false);
	});

	test("Sublime Text's editing keys are the editor's over the shell's own command", () => {
		expect(has("ctrl+j", {}, "toggle-panel")).toBe(true);
		expect(has("ctrl+shift+d", {}, "docs")).toBe(true);
		expect(has("ctrl+shift+m", {}, "problems")).toBe(true);
	});

	test("such a key let go in the editor is the shell's again", () => {
		expect(has("ctrl+j", { "ctrl+j": "" }, "toggle-panel")).toBe(false);
		expect(has("ctrl+shift+d", { "ctrl+shift+d": "" }, "docs")).toBe(false);
	});

	test("another key both have by default is the shell's", () => {
		expect(has("ctrl+l", {}, "some-shell-command")).toBe(false);
		// One of the three, with another command of the shell's on it by default: not the pair the rule is for.
		expect(has("ctrl+j", {}, "docs")).toBe(false);
	});

	test("a key the user gave a shell command is the shell's, in the editor too", () => {
		expect(has("ctrl+l", {}, "word-wrap", true)).toBe(false);
		expect(has("ctrl+j", {}, "word-wrap", true)).toBe(false);
	});

	test("a key the user gave an editor command is the editor's, whatever the shell has on it", () => {
		const chosen = { "ctrl+b": "editor.action.joinLines" };
		expect(has("ctrl+b", chosen, "toggle-sidebar")).toBe(true);
		expect(has("ctrl+b", chosen, "word-wrap", true)).toBe(true);
	});

	test("on a Mac the editing keys are the ones Sublime Text has there", () => {
		const macBase = { "cmd+j": "editor.action.joinLines", "ctrl+shift+m": "editor.action.selectToBracket" };
		const on = (name: string, shell: string) => editorHasKey(name, { now: macBase, chosen: {}, shell, mac: true });
		expect(on("cmd+j", "toggle-panel")).toBe(true);
		expect(on("ctrl+shift+m", "problems")).toBe(true);
		expect(editorHasKey("ctrl+j", { now: { "ctrl+j": "editor.action.joinLines" }, chosen: {}, shell: "toggle-panel", mac: true })).toBe(false);
	});
});
