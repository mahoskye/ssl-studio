// The Markdown Live editor's keys, and Markdown's own (shared/editorKeymap.ts, view/keys.ts, ADR 0041): which of
// the code editor's keys are the Live editor's, how one is written for it, whose a press is where the shell has
// the key too, and Markdown's keys as they come and as they are changed.
import { describe, expect, test } from "bun:test";
import {
	editorHasKey,
	isLiveEditorCommand,
	isMarkdownCommand,
	LIVE_KEYS_AS_THEY_CAME,
	liveEditorKeys,
	liveKeyName,
	MARKDOWN_COMMANDS,
	MARKDOWN_KEYS,
	markdownCommandLabel,
	markdownOverrides,
} from "../src/shared/editorKeymap";
import { bindable, effectiveKeys, keyNamesByLetter, keysOf, rebind, sharedKeyName, unbind } from "../src/view/keys";

describe("the Live editor's keys out of the editor's", () => {
	const NOW = {
		"ctrl+shift+d": "editor.action.duplicateSelection",
		"ctrl+j": "editor.action.joinLines",
		"ctrl+k ctrl+0": "editor.unfoldAll",
		"ctrl+k ctrl+u": "editor.action.transformToUppercase",
		f9: "editor.action.sortLinesAscending",
		f2: "editor.action.rename",
		"ctrl+shift+{": "editor.fold",
	};

	test("a key of one press on a command the Live editor has, and no other", () => {
		expect(liveEditorKeys(NOW)).toEqual({ "ctrl+shift+d": "editor.action.duplicateSelection", "ctrl+j": "editor.action.joinLines", "ctrl+shift+{": "editor.fold" });
		expect(liveEditorKeys({})).toEqual({});
		expect(isLiveEditorCommand("editor.action.joinLines")).toBe(true);
		expect(isLiveEditorCommand("editor.action.rename")).toBe(false);
		expect(isLiveEditorCommand(undefined)).toBe(false);
	});

	test("a change in Settings is a change here: a key moved, a key cleared, a key given to a command it has not", () => {
		const base = { "ctrl+j": "editor.action.joinLines", "ctrl+l": "expandLineSelection", f9: "editor.action.sortLinesAscending" };
		const moved = effectiveKeys(base, rebind(base, {}, "editor.action.joinLines", "ctrl+alt+j"));
		expect(liveEditorKeys(moved)).toEqual({ "ctrl+l": "expandLineSelection", "ctrl+alt+j": "editor.action.joinLines" });
		const cleared = effectiveKeys(base, unbind(base, {}, "expandLineSelection"));
		expect(liveEditorKeys(cleared)).toEqual({ "ctrl+j": "editor.action.joinLines" });
		// "Sort lines" is the code editor's alone: given "Join lines"'s key, the key is nothing here.
		const taken = effectiveKeys(base, rebind(base, {}, "editor.action.sortLinesAscending", "ctrl+j"));
		expect(liveEditorKeys(taken)).toEqual({ "ctrl+l": "expandLineSelection" });
	});

	test("a key is written for the Live editor by the key itself, whatever it types with Shift", () => {
		expect(liveKeyName("ctrl+shift+d")).toBe("Ctrl-Shift-d");
		expect(liveKeyName("ctrl+j")).toBe("Ctrl-j");
		expect(liveKeyName("alt+shift+arrowup")).toBe("Alt-Shift-ArrowUp");
		expect(liveKeyName("ctrl+shift+{")).toBe("Ctrl-Shift-[");
		expect(liveKeyName("ctrl+shift+?")).toBe("Ctrl-Shift-/");
		expect(liveKeyName("ctrl+shift+|")).toBe("Ctrl-Shift-\\");
		expect(liveKeyName("ctrl+]")).toBe("Ctrl-]");
		expect(liveKeyName("ctrl+`")).toBe("Ctrl-`");
		expect(liveKeyName("ctrl+enter")).toBe("Ctrl-Enter");
		expect(liveKeyName("ctrl+shift+backspace")).toBe("Ctrl-Shift-Backspace");
		expect(liveKeyName("alt+f3")).toBe("Alt-F3");
		expect(liveKeyName("ctrl+1")).toBe("Ctrl-1");
		expect(liveKeyName("ctrl+space")).toBe("Ctrl-Space");
		// On a Mac, Cmd and the Ctrl key are two keys.
		expect(liveKeyName("cmd+shift+d")).toBe("Cmd-Shift-d");
		expect(liveKeyName("ctrl+m")).toBe("Ctrl-m");
		// Two presses, and a key the editor has no code for.
		expect(liveKeyName("ctrl+k ctrl+0")).toBeNull();
		expect(liveKeyName("ctrl+é")).toBeNull();
		expect(liveKeyName("")).toBeNull();
	});

	test("whose a press is in the Live editor's text, where the shell has the key too (the code editor's rule)", () => {
		const now = liveEditorKeys({ "ctrl+j": "editor.action.joinLines", "ctrl+l": "expandLineSelection", "ctrl+b": "editor.action.duplicateSelection", f9: "editor.action.sortLinesAscending" });
		const has = (name: string, shell?: string, shellChosen = false, chosen: Record<string, string> = {}) => editorHasKey(name, { now, chosen, shell, shellChosen });
		// Nothing of the shell's on the key: the editor's.
		expect(has("ctrl+l")).toBe(true);
		// One of the three editing keys of ADR 0034, with the shell's own command on it: the editor's.
		expect(has("ctrl+j", "toggle-panel")).toBe(true);
		// Any other key the shell has by default: the shell's.
		expect(has("ctrl+l", "some-shell-command")).toBe(false);
		// A key the user gave an editor command is the editor's; one they gave a shell command is the shell's.
		expect(has("ctrl+b", "toggle-sidebar", false, { "ctrl+b": "editor.action.duplicateSelection" })).toBe(true);
		expect(has("ctrl+j", "word-wrap", true)).toBe(false);
		// A key on a command the Live editor has not is no key of its: F9 sorts lines in the code editor alone.
		expect(has("f9")).toBe(false);
	});

	test("the keys it falls back on are keys of one press, each on one of its commands", () => {
		for (const [key, command] of Object.entries(LIVE_KEYS_AS_THEY_CAME)) {
			expect([key, isLiveEditorCommand(command), liveKeyName(key) !== null]).toEqual([key, true, true]);
		}
		expect(liveEditorKeys(LIVE_KEYS_AS_THEY_CAME)).toEqual({ ...LIVE_KEYS_AS_THEY_CAME });
	});
});

describe("Markdown's own keys", () => {
	const usable = (key: string) => bindable(key).ok;

	test("each key it comes with is one of its commands', and may be a shortcut", () => {
		expect(MARKDOWN_COMMANDS.map((command) => command.id)).toEqual(["md-bold", "md-italic", "md-strike", "md-code", "md-highlight", "md-link", "md-checkbox"]);
		for (const [key, command] of Object.entries(MARKDOWN_KEYS)) expect([key, isMarkdownCommand(command), usable(key)]).toEqual([key, true, true]);
		// Every command has a key, the checkbox two.
		for (const { id } of MARKDOWN_COMMANDS) expect(keysOf(id, MARKDOWN_KEYS).length).toBeGreaterThan(0);
		expect(keysOf("md-checkbox", MARKDOWN_KEYS)).toEqual(["alt+c", "ctrl+alt+enter"]);
		expect(markdownCommandLabel("md-link")).toBe("Insert link");
		expect(isMarkdownCommand("md-insert-footnote")).toBe(false);
	});

	test("the names are the shell's for the same commands, less the word it puts before them", async () => {
		const source = await Bun.file(new URL("../src/view/commands.ts", import.meta.url)).text();
		for (const { id, label } of MARKDOWN_COMMANDS) expect(source).toContain(`{ id: "${id}", label: "Markdown: ${label}"`);
		// And none of them names a key in its description any more: the key is whatever Settings has.
		for (const { id } of MARKDOWN_COMMANDS) expect(new RegExp(`id: "${id}"[^\\n]*\\((?:Ctrl|Alt)\\+`).test(source)).toBe(false);
	});

	test("a change: a command moved to another key, a key cleared, and what is no change at all", () => {
		const moved = rebind(MARKDOWN_KEYS, {}, "md-link", "ctrl+alt+l");
		expect(moved).toEqual({ "ctrl+k": "", "ctrl+alt+l": "md-link" });
		const now = effectiveKeys(MARKDOWN_KEYS, markdownOverrides(moved, usable));
		expect(now["ctrl+k"]).toBeUndefined();
		expect(now["ctrl+alt+l"]).toBe("md-link");
		expect(now["ctrl+b"]).toBe("md-bold");
		// Clearing the checkbox lets both of its keys go.
		expect(unbind(MARKDOWN_KEYS, {}, "md-checkbox")).toEqual({ "alt+c": "", "ctrl+alt+enter": "" });
		// A key taken from another of Markdown's commands leaves that one with none.
		const taken = effectiveKeys(MARKDOWN_KEYS, rebind(MARKDOWN_KEYS, {}, "md-bold", "ctrl+i"));
		expect(taken["ctrl+i"]).toBe("md-bold");
		expect(keysOf("md-italic", taken)).toEqual([]);
		expect(taken["ctrl+b"]).toBeUndefined();
	});

	test("only what means something is read from the settings", () => {
		expect(
			markdownOverrides(
				{
					"Ctrl+Alt+L": "md-link",
					"ctrl+k": "",
					"ctrl+j": "editor.action.joinLines",
					"ctrl+u": "toggle-sidebar",
					"ctrl+k ctrl+b": "md-bold",
					b: "md-bold",
					"ctrl+c": "md-code",
					"ctrl+alt+m": 7,
					"": "md-bold",
				},
				usable,
			),
		).toEqual({ "ctrl+alt+l": "md-link", "ctrl+k": "" });
		expect(markdownOverrides(undefined, usable)).toEqual({});
	});
});

describe("a press named for a list written once for every system", () => {
	const press = (key: string, code: string, held: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ key, code, ...held });

	test("off a Mac a press has the names it always had", () => {
		expect(keyNamesByLetter(press("c", "KeyC", { altKey: true }), false)).toEqual([]);
		expect(sharedKeyName(press("b", "KeyB", { ctrlKey: true }), false)).toBe("ctrl+b");
		expect(sharedKeyName(press("Enter", "Enter", { ctrlKey: true, altKey: true }), false)).toBe("ctrl+alt+enter");
	});

	test("on a Mac, Option and a letter is the letter's key, and Cmd is written as Ctrl", () => {
		// Option+C types "ç": by the letter it is "alt+c", the checkbox's key.
		expect(keyNamesByLetter(press("ç", "KeyC", { altKey: true }), true)).toEqual(["alt+c"]);
		expect(sharedKeyName(press("ç", "KeyC", { altKey: true }), true)).toBe("alt+c");
		// Cmd+Option+H types "˙": the highlight's key, by either name.
		expect(keyNamesByLetter(press("˙", "KeyH", { metaKey: true, altKey: true }), true)).toEqual(["cmd+alt+h", "ctrl+alt+h"]);
		expect(sharedKeyName(press("˙", "KeyH", { metaKey: true, altKey: true }), true)).toBe("ctrl+alt+h");
		expect(MARKDOWN_KEYS[sharedKeyName(press("˙", "KeyH", { metaKey: true, altKey: true }), true)!]).toBe("md-highlight");
		// Cmd+B is written "ctrl+b", as the list writes it.
		expect(sharedKeyName(press("b", "KeyB", { metaKey: true }), true)).toBe("ctrl+b");
		// A press that types its own letter, or none, has no second name.
		expect(keyNamesByLetter(press("c", "KeyC", { altKey: true }), true)).toEqual([]);
		expect(keyNamesByLetter(press("ArrowUp", "ArrowUp", { altKey: true }), true)).toEqual([]);
		expect(keyNamesByLetter(press("b", "KeyB", { metaKey: true }), true)).toEqual([]);
	});
});
