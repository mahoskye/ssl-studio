import { describe, expect, test } from "bun:test";
import { bindable, conflict, displayKey, effectiveKeys, isModifierKey, keyNames, keysOf, rebind, unbind } from "../src/view/keys";
import { clampScale, stepScale } from "../src/view/uiScale";

const DEFAULTS = { "ctrl+s": "save", "ctrl+\\": "split", "ctrl+alt+\\": "split", "ctrl+shift+p": "command-palette", "ctrl+b": "toggle-sidebar" };

describe("what a key press is called", () => {
	test("modifiers in one order, the key in lower case", () => {
		expect(keyNames({ key: "P", ctrlKey: true, shiftKey: true })).toEqual(["ctrl+shift+p"]);
		expect(keyNames({ key: "s", metaKey: true })).toEqual(["ctrl+s"]);
		expect(keyNames({ key: "\\", ctrlKey: true, altKey: true })).toEqual(["ctrl+alt+\\"]);
		expect(keyNames({ key: "PageDown", ctrlKey: true })).toEqual(["ctrl+pagedown"]);
		expect(keyNames({ key: " ", ctrlKey: true })).toEqual(["ctrl+space"]);
		expect(keyNames({ key: "F1" })).toEqual(["f1"]);
	});

	test("a digit key is its digit, whatever Shift or the layout makes of it", () => {
		expect(keyNames({ key: ")", code: "Digit0", ctrlKey: true, shiftKey: true })).toEqual(["ctrl+shift+0", "ctrl+shift+)"]);
		expect(keyNames({ key: "&", code: "Digit1", ctrlKey: true })).toEqual(["ctrl+1", "ctrl+&"]);
		expect(keyNames({ key: "0", code: "Digit0", ctrlKey: true })).toEqual(["ctrl+0"]);
		// Under AltGr the key is typing a character, not naming a digit.
		expect(keyNames({ key: "}", code: "Digit0", ctrlKey: true, altKey: true })).toEqual(["ctrl+alt+}"]);
		expect(keyNames({ key: "}", code: "Digit0", getModifierState: (k) => k === "AltGraph" })).toEqual(["}"]);
	});

	test("as it is shown", () => {
		expect(displayKey("ctrl+shift+p")).toBe("Ctrl+Shift+P");
		expect(displayKey("ctrl+pagedown")).toBe("Ctrl+PageDown");
		expect(displayKey("ctrl++")).toBe("Ctrl++");
		expect(displayKey("ctrl+,")).toBe("Ctrl+,");
		expect(displayKey("ctrl+alt+\\")).toBe("Ctrl+Alt+\\");
		expect(displayKey("f1")).toBe("F1");
	});

	test("keys that are only held", () => {
		expect(isModifierKey("Control")).toBe(true);
		expect(isModifierKey("AltGraph")).toBe(true);
		expect(isModifierKey("a")).toBe(false);
	});
});

describe("which keys may be shortcuts", () => {
	test("a modifier or a function key is needed", () => {
		expect(bindable("a").ok).toBe(false);
		expect(bindable("shift+a").ok).toBe(false);
		expect(bindable("enter").ok).toBe(false);
		expect(bindable("+").ok).toBe(false);
		expect(bindable("ctrl+k").ok).toBe(true);
		expect(bindable("alt+k").ok).toBe(true);
		expect(bindable("ctrl++").ok).toBe(true);
		expect(bindable("f5").ok).toBe(true);
		expect(bindable("shift+f12").ok).toBe(true);
		expect(bindable("f25").ok).toBe(false);
	});

	test("the keys text is edited with are refused, with a reason", () => {
		const copy = bindable("ctrl+c");
		expect(copy.ok).toBe(false);
		expect(!copy.ok && copy.why).toContain("Ctrl+C");
		expect(bindable("ctrl+shift+c").ok).toBe(true);
	});
});

describe("the keymap", () => {
	test("overrides add, replace and unbind", () => {
		const map = effectiveKeys(DEFAULTS, { "Ctrl+K": "save", "ctrl+b": "", "ctrl+shift+p": "split" });
		expect(map["ctrl+k"]).toBe("save");
		expect(map["ctrl+b"]).toBeUndefined();
		expect(map["ctrl+shift+p"]).toBe("split");
		expect(keysOf("split", effectiveKeys(DEFAULTS))).toEqual(["ctrl+\\", "ctrl+alt+\\"]);
	});

	test("a key another command has is a conflict; the command's own is not", () => {
		const map = effectiveKeys(DEFAULTS);
		expect(conflict("ctrl+s", "split", map)).toBe("save");
		expect(conflict("Ctrl+S", "split", map)).toBe("save");
		expect(conflict("ctrl+s", "save", map)).toBeUndefined();
		expect(conflict("ctrl+k", "save", map)).toBeUndefined();
	});

	test("rebinding lets go of the old keys and takes the new one from its owner", () => {
		const overrides = rebind(DEFAULTS, {}, "split", "ctrl+s");
		const map = effectiveKeys(DEFAULTS, overrides);
		expect(keysOf("split", map)).toEqual(["ctrl+s"]);
		expect(keysOf("save", map)).toEqual([]);
		// Back to its default: no override is left for it.
		const back = rebind(DEFAULTS, rebind(DEFAULTS, {}, "toggle-sidebar", "ctrl+k"), "toggle-sidebar", "ctrl+b");
		expect(back).toEqual({});
	});

	test("rebinding the command list's key leaves every other command alone", () => {
		const map = effectiveKeys(DEFAULTS, rebind(DEFAULTS, {}, "command-palette", "f2"));
		expect(keysOf("command-palette", map)).toEqual(["f2"]);
		expect(map["ctrl+shift+p"]).toBeUndefined();
		expect(map["ctrl+s"]).toBe("save");
	});

	test("clearing one command's shortcut", () => {
		const overrides = unbind(DEFAULTS, { "ctrl+k": "split" }, "split");
		expect(overrides).toEqual({ "ctrl+\\": "", "ctrl+alt+\\": "" });
		expect(keysOf("split", effectiveKeys(DEFAULTS, overrides))).toEqual([]);
	});
});

describe("the interface size", () => {
	test("stays between 0.8 and 1.6, and anything else is 1", () => {
		expect(clampScale(undefined)).toBe(1);
		expect(clampScale(Number.NaN)).toBe(1);
		expect(clampScale("2")).toBe(1);
		expect(clampScale(0.1)).toBe(0.8);
		expect(clampScale(9)).toBe(1.6);
		expect(clampScale(1.25)).toBe(1.25);
	});

	test("steps by a tenth and stops at the ends", () => {
		expect(stepScale(undefined, 1)).toBe(1.1);
		expect(stepScale(1.1, -1)).toBe(1);
		expect(stepScale(1.6, 1)).toBe(1.6);
		expect(stepScale(0.8, -1)).toBe(0.8);
		let scale = 0.8;
		for (let i = 0; i < 8; i++) scale = stepScale(scale, 1);
		expect(scale).toBe(1.6);
	});
});
