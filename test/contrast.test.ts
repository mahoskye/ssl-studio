// ADR 0007: legible first. Both built-in themes are held to WCAG 2 contrast:
// 4.5 for text against everything it is drawn on, 3 for the edge of a control.
import { describe, expect, test } from "bun:test";
import { BOUNDARY, TEXT, contrast } from "../src/shared/contrast";
import dark from "../src/view/themes/studio-dark.json";
import light from "../src/view/themes/studio-light.json";

type Theme = { colors: Record<string, string>; tokenColors: { scope?: string | string[]; settings: { foreground?: string } }[] };

/** Every surface a row of text can sit on: a panel, a tab, the status bar, a hovered or selected row. */
const SURFACES = ["editor.background", "sideBar.background", "panel.background", "tab.inactiveBackground", "statusBar.background", "list.hoverBackground", "list.activeSelectionBackground"];
/** Colours used for text anywhere in the window. */
const TEXT_ANYWHERE = ["descriptionForeground", "editorError.foreground", "editorWarning.foreground", "editorInfo.foreground", "testing.iconPassed", "focusBorder"];
/** Text that has one home. */
const TEXT_ON: [string, string][] = [
	["editor.foreground", "editor.background"],
	["editor.foreground", "editor.lineHighlightBackground"],
	["sideBar.foreground", "sideBar.background"],
	["sideBar.foreground", "list.hoverBackground"],
	["sideBar.foreground", "list.activeSelectionBackground"],
	["statusBar.foreground", "statusBar.background"],
	["tab.inactiveForeground", "tab.inactiveBackground"],
	["tab.activeForeground", "tab.activeBackground"],
	["button.foreground", "button.background"],
	["input.foreground", "input.background"],
	["editorLineNumber.foreground", "editor.background"],
	["editorLineNumber.foreground", "editor.lineHighlightBackground"],
];
/** A control's edge against what surrounds it. */
const EDGES: [string, string][] = [
	["input.border", "sideBar.background"],
	["input.border", "editor.background"],
	["input.border", "input.background"],
	["focusBorder", "editor.background"],
	["focusBorder", "sideBar.background"],
	["focusBorder", "input.background"],
];

const failing = (theme: Theme, pairs: [string, string][], needs: number) =>
	pairs
		.map(([front, back]) => ({ front, back, ratio: contrast(theme.colors[front]!, theme.colors[back]!) }))
		.filter((p) => !(p.ratio >= needs))
		.map((p) => `${p.front} on ${p.back}: ${p.ratio.toFixed(2)}, needs ${needs}`);

describe("contrast", () => {
	test("the ratio is the WCAG one", () => {
		expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
		expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
		expect(contrast("#123456", "#123456")).toBe(1);
	});
});

for (const [name, theme] of [
	["dark", dark as Theme],
	["light", light as Theme],
] as const) {
	describe(`the ${name} theme`, () => {
		test("has every colour the window reads", () => {
			const keys = new Set([...SURFACES, ...TEXT_ANYWHERE, ...TEXT_ON.flat(), ...EDGES.flat()]);
			expect([...keys].filter((key) => !/^#[0-9a-f]{6}$/i.test(theme.colors[key] ?? ""))).toEqual([]);
		});

		test("text that has one home can be read there", () => {
			expect(failing(theme, TEXT_ON, TEXT)).toEqual([]);
		});

		test("muted, error, warning, info, ok and link text can be read on every surface", () => {
			expect(
				failing(
					theme,
					TEXT_ANYWHERE.flatMap((front) => SURFACES.map((back): [string, string] => [front, back])),
					TEXT,
				),
			).toEqual([]);
		});

		test("the edge of an input and the focus ring can be seen", () => {
			expect(failing(theme, EDGES, BOUNDARY)).toEqual([]);
		});

		test("comments and keywords in code can be read", () => {
			const backs = [theme.colors["editor.background"]!, theme.colors["editor.lineHighlightBackground"]!];
			const low = theme.tokenColors
				.filter((t) => t.settings.foreground && /^#[0-9a-f]{6}$/i.test(t.settings.foreground))
				.flatMap((t) => backs.map((back) => ({ scope: String(t.scope), ratio: contrast(t.settings.foreground!, back) })))
				.filter((t) => !(t.ratio >= TEXT))
				.map((t) => `${t.scope}: ${t.ratio.toFixed(2)}`);
			expect(low).toEqual([]);
		});
	});
}
