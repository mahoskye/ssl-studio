// One command palette, with the editor's commands in it, and "go to line" in the same box (ADR 0044). F1 opened the
// code editor's own list, drawn inside the editor, with none of the app's commands; Ctrl+Shift+P had none of the
// editor's. Ctrl+G opened the editor's own box too.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sentenceCase } from "../src/shared/editorKeymap";
import { MENU_BAR } from "../src/shared/menuBar";

const source = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

describe("one command palette", () => {
	test("F1 and Ctrl+Shift+P open it, and Ctrl+G the box for a line, from anywhere", () => {
		const commands = source("src/view/commands.ts");
		expect(commands).toContain('\tf1: "command-palette",');
		expect(commands).toContain('\t"ctrl+shift+p": "command-palette",');
		expect(commands).toContain('\t"ctrl+g": "go-to-line",');
		expect(commands).not.toContain('"editor-commands"');
		// In the code editor its own commands for the two are the app's boxes, so its keys open them as well.
		expect(commands).toContain('monaco.editor.addCommand({ id: "editor.action.quickCommand", run: () => runCommand("command-palette") });');
		expect(commands).toContain('monaco.editor.addCommand({ id: "editor.action.gotoLine", run: () => runCommand("go-to-line") });');
		// And in the Live editor, and from the status bar.
		expect(source("src/view/editor/cmKeymap.ts")).toContain('"editor.action.gotoLine": () => (openLinePicker(), true),');
		expect(source("src/view/StatusBar.tsx")).toMatch(/async function goToLine\(\) \{\n\topenLinePicker\(\);\n\}/);
	});

	test("it lists the open editor's commands with the app's", () => {
		expect(source("src/view/QuickPick.tsx")).toContain("orderCommands([...commands, ...editorCommands()], recentCommands())");
		// Not twice: the editor's own list, its box for a line, its outline and its "Format document" are the app's.
		const commands = source("src/view/commands.ts");
		for (const id of ["editor.action.quickCommand", "editor.action.gotoLine", "editor.action.quickOutline", "editor.action.formatDocument"]) expect(commands).toContain(`\t"${id}",\n`);
	});

	test("the editor's names for its commands are written as the app writes a command's name", () => {
		expect(sentenceCase("Go to Bracket")).toBe("Go to bracket");
		expect(sentenceCase("Convert Indentation to Tabs")).toBe("Convert indentation to tabs");
		expect(sentenceCase("Toggle Tab Key Moves Focus")).toBe("Toggle tab key moves focus");
		// A word written another way is the editor's to write.
		expect(sentenceCase("Trigger IntelliSense")).toBe("Trigger IntelliSense");
		expect(sentenceCase("Go to Next Problem (Error, Warning, Info)")).toBe("Go to next problem (Error, Warning, Info)");
	});

	test("the menus ask for the app's box for a line, and have no list of the editor's apart", () => {
		const entries = MENU_BAR.flatMap((menu) => menu.entries).filter((entry) => entry !== "separator");
		expect(entries.find((entry) => entry.label === "Go to line…")).toEqual({ label: "Go to line…", command: "go-to-line", needs: "text" });
		expect(entries.some((entry) => "command" in entry && entry.command === "editor-commands")).toBe(false);
	});
});
