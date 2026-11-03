import { describe, expect, test } from "bun:test";
import { LEGEND, semanticRules, tokenStyle, translateTokens } from "../src/view/editor/semantic";
import dark from "../src/view/themes/studio-dark.json";
import light from "../src/view/themes/studio-light.json";

const theme = {
	semanticHighlighting: true,
	tokenColors: [
		{ scope: "entity.name.function", settings: { foreground: "#111111" } },
		{ scope: ["support.function", "support.class"], settings: { foreground: "#222222" } },
		{ scope: "variable.parameter", settings: { foreground: "#333333", fontStyle: "italic" } },
		{ scope: "variable", settings: { foreground: "#444444" } },
		{ scope: "variable.other.readwrite", settings: { foreground: "#555555" } },
		{ scope: "source.ssl variable.other.constant", settings: { foreground: "#666666" } },
	],
};

describe("a token's style under a theme", () => {
	test("comes from the scopes VS Code maps it to, longest selector first", () => {
		expect(tokenStyle(theme, "function", ["declaration"])?.foreground).toBe("#111111");
		expect(tokenStyle(theme, "function", ["defaultLibrary"])?.foreground).toBe("#222222");
		expect(tokenStyle(theme, "parameter", [])).toEqual({ foreground: "#333333", fontStyle: "italic" });
		expect(tokenStyle(theme, "variable", [])?.foreground).toBe("#555555");
	});
	test("skips descendant selectors, and falls back from a modifier to the type", () => {
		expect(tokenStyle(theme, "variable", ["readonly"])?.foreground).toBe("#444444");
	});
	test("is null when no rule colours it, so the grammar's colour stands", () => {
		expect(tokenStyle({ tokenColors: [] }, "class", [])).toBeNull();
	});
	test("takes semanticTokenColors first, the most specific selector winning", () => {
		const colors = {
			...theme,
			semanticTokenColors: { variable: "#aaaaaa", "variable.unknown": { foreground: "#bbbbbb", underline: true }, "*.public": "#cccccc" },
		};
		expect(tokenStyle(colors, "variable", [])?.foreground).toBe("#aaaaaa");
		expect(tokenStyle(colors, "variable", ["unknown"])).toEqual({ foreground: "#bbbbbb", fontStyle: "underline" });
		expect(tokenStyle(colors, "variable", ["public", "declaration"])?.foreground).toBe("#cccccc");
	});
});

describe("Monaco rules for a theme", () => {
	test("a theme that does not opt in has none, as in VS Code", () => {
		expect(semanticRules({ ...theme, semanticHighlighting: false })).toEqual([]);
	});
	test("names follow the legend's modifier order, with Monaco's colour form", () => {
		const rules = semanticRules({ semanticHighlighting: true, semanticTokenColors: { "variable.public": "#abc" } });
		expect(rules.find((r) => r.token === "variable.declaration.public")).toEqual({ token: "variable.declaration.public", foreground: "aabbcc", fontStyle: "" });
		expect(rules.find((r) => r.token === "variable")).toBeUndefined();
	});
	test("the built-in themes opt in and colour the server's own modifiers", () => {
		for (const builtIn of [dark, light] as any[]) {
			const rules = semanticRules(builtIn);
			for (const token of ["variable.public", "variable.unknown", "parameter", "function.declaration", "function.defaultLibrary", "method", "property", "class.defaultLibrary", "variable.defaultLibrary.readonly"])
				expect(rules.some((r) => r.token === token && r.foreground)).toBe(true);
		}
	});
});

describe("the server's tokens for Monaco", () => {
	// The server's legend, reordered: indices must move to ours.
	const from = { tokenTypes: ["variable", "function"], tokenModifiers: ["unknown", "declaration"] };
	const all = () => true;
	test("moves types and modifiers to our legend", () => {
		const out = [...translateTokens([0, 2, 3, 1, 0b10, 1, 0, 4, 0, 0b01], from, all)];
		expect(out).toEqual([0, 2, 3, LEGEND.tokenTypes.indexOf("function"), 1 << LEGEND.tokenModifiers.indexOf("declaration"), 1, 0, 4, LEGEND.tokenTypes.indexOf("variable"), 1 << LEGEND.tokenModifiers.indexOf("unknown")]);
	});
	test("dropping a token keeps the next one's position", () => {
		// Absolute: 0:2 and 0:10 and 2:1; the middle one has no style.
		const keep = (name: string) => name !== "variable.unknown";
		const out = [...translateTokens([0, 2, 3, 1, 0, 0, 8, 3, 0, 1, 2, 1, 3, 1, 0], from, keep)];
		expect(out).toEqual([0, 2, 3, 0, 0, 2, 1, 3, 0, 0]);
	});
	test("a type or modifier we do not know is ignored", () => {
		const later = { tokenTypes: ["macro", "variable"], tokenModifiers: ["fancy", "public"] };
		const out = [...translateTokens([0, 1, 2, 0, 0, 0, 5, 2, 1, 0b11], later, all)];
		expect(out).toEqual([0, 6, 2, LEGEND.tokenTypes.indexOf("variable"), 1 << LEGEND.tokenModifiers.indexOf("public")]);
	});
});
