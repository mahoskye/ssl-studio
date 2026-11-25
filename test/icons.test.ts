import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ICON } from "../src/view/icons";

const root = join(import.meta.dir, "..");

describe("the app's small graphics", () => {
	test("each is the Codicon of its name, as the font the editor ships has it", () => {
		const library = readFileSync(join(root, "node_modules/monaco-editor/esm/vs/base/common/codiconsLibrary.js"), "utf8");
		const points = new Map([...library.matchAll(/register\('([a-z0-9-]+)', 0x([0-9a-f]+)\)/g)].map((found) => [found[1]!, Number.parseInt(found[2]!, 16)]));
		expect(points.size).toBeGreaterThan(300);
		const wrong = Object.entries(ICON).filter(([name, glyph]) => points.get(name) !== glyph.codePointAt(0));
		expect(wrong).toEqual([]);
	});

	const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
	/** The lines of the view's own files that a pattern finds, as "file:line". */
	const linesWith = (pattern: RegExp) =>
		files(join(root, "src/view"))
			.filter((file) => /\.(tsx|ts|css)$/.test(file) && !/selftest|icons\.ts$/.test(file))
			.flatMap((file) =>
				readFileSync(file, "utf8")
					.split("\n")
					.flatMap((line, at) => (pattern.test(line) ? [`${file.slice(root.length + 1)}:${at + 1}`] : [])),
			);

	test("no view types a shape, a dingbat or a wide form: the kinds the system's fonts draw each their own way", () => {
		// What came out as an oval dot and a double-width plus. A cross, a minus and a plain arrow are in every font
		// and are words in a sentence ("64 × 40 pixels"); as a button's whole face they are held by the next test.
		expect(linesWith(/[\u25A0-\u25FF\u2700-\u27BF\u2600-\u26FF\u27F0-\u27FF\u2B00-\u2BFF\uFF00-\uFFEF\u21B0-\u21FF\u22EE-\u22F1\u2139]/)).toEqual([]);
	});

	test("no control's whole face is a typed symbol", () => {
		// A line of markup that is one symbol and nothing else, an element that holds only one, and a `glyph` that is not letters.
		expect(linesWith(/^\s*[\u00D7\u2212\u2190-\u21FF\u2026\u2022\u00B7]\s*$/)).toEqual([]);
		expect(linesWith(/>\s*[\u00D7\u2212\u2190-\u21FF\u2026\u2022]\s*<\//)).toEqual([]);
		expect(linesWith(/glyph=\{?["'`][^"'`]*[^\x20-\x7E][^"'`]*["'`]/)).toEqual([]);
		// And a piece of text in quotes that is only a cross, a minus, an arrow or a bullet, however it is written
		// in: `{down ? " ↓" : " ↑"}`, `{"×"}`, `content: "×"`. A symbol inside a longer text is a word in a sentence
		// and passes; so does the name of a key in a menu's column of keys.
		const quoted = /(?<!keys: )(["'])\s*[\u00D7\u2212\u2190-\u21FF\u2022]\s*\1/;
		expect(linesWith(quoted)).toEqual([]);
		for (const typed of ['{down ? " ↓" : " ↑"}', '{staged ? "−" : "+"}', '{"×"}', 'content: "×";', "{'•'}"]) expect(quoted.test(typed)).toBe(true);
		for (const prose of ['"64 × 40 pixels"', '["+, −, 0", "Zoom in, zoom out, fit"]', 'keys: "−",']) expect(quoted.test(prose)).toBe(false);
	});
});
