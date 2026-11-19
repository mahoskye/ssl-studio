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

	test("none is typed as text: no view draws a symbol the system's fonts would have to find", () => {
		// Shapes, dingbats and wide forms: the kinds that came out as an oval dot and a double-width plus.
		const drawn = /[\u25A0-\u25FF\u2700-\u27BF\u2600-\u26FF\u27F0-\u27FF\u2B00-\u2BFF\uFF00-\uFFEF\u21B0-\u21FF\u22EE-\u22F1]/;
		const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
		const found = files(join(root, "src/view"))
			.filter((file) => /\.(tsx|ts|css)$/.test(file) && !/selftest|icons\.ts$/.test(file))
			.flatMap((file) =>
				readFileSync(file, "utf8")
					.split("\n")
					.flatMap((line, at) => (drawn.test(line) ? [`${file.slice(root.length + 1)}:${at + 1}`] : [])),
			);
		expect(found).toEqual([]);
	});
});
