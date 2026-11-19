import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD_COMMANDS, letterItem, MENU_BAR, menuForLetter, missing, stepMenu, type BarEntry } from "../src/shared/menuBar";

const entries = (name: string) => MENU_BAR.find((menu) => menu.name === name)!.entries;
const named = (name: string, label: string) => entries(name).find((entry) => entry !== "separator" && entry.label === label) as Exclude<BarEntry, "separator">;

describe("the menu bar's menus", () => {
	test("are the six an editor is expected to have, in their order", () => {
		expect(MENU_BAR.map((menu) => menu.name)).toEqual(["File", "Edit", "Selection", "View", "Go", "Help"]);
	});

	test("each opens with its own first letter", () => {
		for (const menu of MENU_BAR) expect(menu.name[0]!.toLowerCase()).toBe(menu.letter);
		expect(new Set(MENU_BAR.map((menu) => menu.letter)).size).toBe(MENU_BAR.length);
	});

	test("every command a menu runs is one of the app's commands", () => {
		// The command list is not loaded here (it brings the editor with it): its ids are read from where they are written.
		const source = readFileSync(join(import.meta.dir, "../src/view/commands.ts"), "utf8");
		const ids = new Set([...source.matchAll(/\{ id: "([a-z0-9-]+)"/g)].map((found) => found[1]));
		expect(ids.size).toBeGreaterThan(50);
		const asked = MENU_BAR.flatMap((menu) => menu.entries).flatMap((entry) => (entry !== "separator" && "command" in entry ? [entry.command] : []));
		expect(asked.filter((id) => !ids.has(id))).toEqual([]);
	});

	test("a menu holds no command of its own: every entry is the app's or the text editor's", () => {
		for (const menu of MENU_BAR) for (const entry of menu.entries) expect(entry === "separator" || "command" in entry || "editor" in entry).toBe(true);
	});

	test("the commands a text box has of its own are entries of the Edit and Selection menus", () => {
		const ids = MENU_BAR.flatMap((menu) => menu.entries).flatMap((entry) => (entry !== "separator" && "editor" in entry ? [entry.editor] : []));
		for (const id of Object.keys(FIELD_COMMANDS)) expect(ids).toContain(id);
		expect(Object.values(FIELD_COMMANDS).sort()).toEqual(["copy", "cut", "paste", "redo", "selectAll", "undo"]);
	});

	test("no menu starts or ends with a line, or has two together", () => {
		for (const menu of MENU_BAR) {
			expect(menu.entries[0]).not.toBe("separator");
			expect(menu.entries[menu.entries.length - 1]).not.toBe("separator");
			menu.entries.forEach((entry, at) => expect(entry === "separator" && menu.entries[at + 1] === "separator").toBe(false));
		}
	});

	test("no menu names two entries alike", () => {
		for (const menu of MENU_BAR) {
			const labels = menu.entries.flatMap((entry) => (entry === "separator" ? [] : [entry.label]));
			expect(new Set(labels).size).toBe(labels.length);
		}
	});

	test("what works on the text asks for a file shown as text", () => {
		for (const menu of MENU_BAR)
			for (const entry of menu.entries) {
				if (entry === "separator" || !("editor" in entry)) continue;
				// Undo and redo are the text's own, whichever way the file is shown.
				expect(entry.needs).toBe(entry.editor === "undo" || entry.editor === "redo" ? "file" : "text");
			}
	});
});

describe("what an entry needs", () => {
	const nothing = { folder: false, file: false, text: false };
	const folder = { folder: true, file: false, text: false };
	const blocks = { folder: true, file: true, text: false };
	const text = { folder: true, file: true, text: true };

	test("with nothing open, only what needs nothing can run", () => {
		expect(missing(named("File", "Open folder…"), nothing)).toBe("");
		expect(missing(named("File", "Settings…"), nothing)).toBe("");
		expect(missing(named("Help", "About SSL Studio"), nothing)).toBe("");
		expect(missing(named("File", "New file or folder…"), nothing)).toBe("Open a folder first");
		expect(missing(named("File", "Save"), nothing)).toBe("Open a file first");
	});

	test("a folder is enough for what is about the folder", () => {
		expect(missing(named("File", "New file or folder…"), folder)).toBe("");
		expect(missing(named("Go", "Go to file…"), folder)).toBe("");
		expect(missing(named("File", "Save"), folder)).toBe("Open a file first");
	});

	test("with no file open, the text's commands ask for a file, not for text", () => {
		expect(missing(named("Edit", "Find"), folder)).toBe("Open a file first");
	});

	test("a file shown as blocks or as a page can be saved and undone, not searched", () => {
		expect(missing(named("File", "Save"), blocks)).toBe("");
		expect(missing(named("Edit", "Undo"), blocks)).toBe("");
		expect(missing(named("Edit", "Find"), blocks)).toBe("For a file shown as text");
		expect(missing(named("Edit", "Format document"), blocks)).toBe("For a file shown as text");
	});

	test("a file shown as text has everything", () => {
		for (const menu of MENU_BAR) for (const entry of menu.entries) expect(missing(entry, text)).toBe("");
	});

	test("a line needs nothing", () => {
		expect(missing("separator", nothing)).toBe("");
	});
});

describe("the keyboard in the bar", () => {
	test("Alt and a letter finds its menu, in either case", () => {
		expect(menuForLetter("f")).toBe(0);
		expect(menuForLetter("G")).toBe(4);
		expect(menuForLetter("x")).toBe(-1);
		// Where Alt and a letter types a character, the key is that character.
		expect(menuForLetter("ƒ")).toBe(-1);
	});

	test("Left and Right go round at the ends", () => {
		expect(stepMenu(0, 1)).toBe(1);
		expect(stepMenu(5, 1)).toBe(0);
		expect(stepMenu(0, -1)).toBe(5);
		expect(stepMenu(2, -1, 3)).toBe(1);
	});

	test("a letter goes to the next entry that starts with it, and round", () => {
		const labels = ["Save", "Save all", null, "Revert file", "Settings…"];
		expect(letterItem(labels, "s", -1)).toBe(0);
		expect(letterItem(labels, "s", 0)).toBe(1);
		expect(letterItem(labels, "S", 1)).toBe(4);
		expect(letterItem(labels, "s", 4)).toBe(0);
		expect(letterItem(labels, "r", 3)).toBe(3);
		expect(letterItem(labels, "x", 0)).toBe(-1);
		expect(letterItem([], "s", -1)).toBe(-1);
	});

	test("a letter never lands on a line between entries", () => {
		expect(letterItem([null, "Cut", null], "c", 1)).toBe(1);
		expect(letterItem([null, null], "c", -1)).toBe(-1);
	});
});
