// ADR 0007 & ADR 0027: legible first. Classic themes and all 25 generated OKLCH
// Warm Material themes are held to WCAG 2 contrast: 4.5 for text against every
// surface it is drawn on, 3 for the edge of a control.
import { describe, expect, test } from "bun:test";
import { BOUNDARY, TEXT, contrast } from "../src/shared/contrast";
import { allOklchThemes, type GeneratedTheme } from "../src/shared/oklchTheme";
import { resolveFontStack, DEFAULT_UI_FONT, DEFAULT_CODE_FONT } from "../src/shared/fonts";
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

const failingValues = (pairs: [label: string, front: string, back: string][], needs: number) =>
	pairs
		.map(([label, front, back]) => ({ label, ratio: contrast(front, back) }))
		.filter((p) => !(p.ratio >= needs))
		.map((p) => `${p.label}: ${p.ratio.toFixed(2)}, needs ${needs}`);

describe("contrast", () => {
	test("the ratio is the WCAG one", () => {
		expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
		expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
		expect(contrast("#123456", "#123456")).toBe(1);
	});
});

describe("font stack normalization", () => {
	test("defaults cleanly and quotes multi-word font names safely", () => {
		expect(resolveFontStack("", DEFAULT_UI_FONT)).toBe(DEFAULT_UI_FONT);
		expect(resolveFontStack("IBM Plex Sans", DEFAULT_UI_FONT)).toBe(`"IBM Plex Sans", ${DEFAULT_UI_FONT}`);
		expect(resolveFontStack("JetBrains Mono; color: red", DEFAULT_CODE_FONT)).toBe(`"JetBrains Mono color red", ${DEFAULT_CODE_FONT}`);
		expect(resolveFontStack("Inter", DEFAULT_UI_FONT)).toBe(`"Inter", ${DEFAULT_UI_FONT}`);
	});
});

for (const [name, theme] of [
	["classic dark", dark as Theme],
	["classic light", light as Theme],
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

describe("all 25 OKLCH Warm Material themes", () => {
	const themes: GeneratedTheme[] = allOklchThemes();

	test("generates all 5 tones × 5 materials with valid 6-digit hex tokens", () => {
		expect(themes.length).toBe(25);
		for (const theme of themes) {
			const badColors = Object.entries(theme.colors).filter(([, v]) => !/^#[0-9a-f]{6}$/i.test(v));
			const badStudio = Object.entries(theme.studio).filter(([, v]) => !/^#[0-9a-f]{6}$/i.test(v));
			expect(badColors).toEqual([]);
			expect(badStudio).toEqual([]);
		}
	});

	for (const theme of themes) {
		describe(theme.name, () => {
			const s = theme.studio;
			const chromeSurfaces: [string, string][] = [
				["trayBg", s.trayBg],
				["sideBg", s.sideBg],
				["panelBg", s.panelBg],
				["hover", s.hover],
				["selected", s.selected],
			];
			const editorSurfaces: [string, string][] = [
				["editorBg", s.editorBg],
				["editorLineHl", s.editorLineHl],
			];

			test("text in its home surface passes WCAG AA", () => {
				expect(failing(theme, TEXT_ON, TEXT)).toEqual([]);
				expect(
					failingValues(
						[
							["strongFg on sideBg", s.strongFg, s.sideBg],
							["strongFg on selected", s.strongFg, s.selected],
							["editorStrong on editorBg", s.editorStrong, s.editorBg],
							["editorFg on editorLineHl", s.editorFg, s.editorLineHl],
							["buttonFg on buttonBg", s.buttonFg, s.buttonBg],
							["peekViewTitleLabel on peekViewTitle", theme.colors["peekViewTitleLabel.foreground"]!, theme.colors["peekViewTitle.background"]!],
							["peekViewTitleDescription on peekViewTitle", theme.colors["peekViewTitleDescription.foreground"]!, theme.colors["peekViewTitle.background"]!],
							["peekViewResult.file on peekViewResult", theme.colors["peekViewResult.fileForeground"]!, theme.colors["peekViewResult.background"]!],
							["peekViewResult.line on peekViewResult", theme.colors["peekViewResult.lineForeground"]!, theme.colors["peekViewResult.background"]!],
							["peekViewResult.selection on selectionBg", theme.colors["peekViewResult.selectionForeground"]!, theme.colors["peekViewResult.selectionBackground"]!],
						],
						TEXT,
					),
				).toEqual([]);
			});

			test("chrome muted, accent and semantic colours read on every chrome surface", () => {
				const chromeFg: [string, string][] = [
					["muted", s.muted],
					["accent", s.accent],
					["ok", s.ok],
					["warning", s.warning],
					["error", s.error],
					["info", s.info],
				];
				const pairs = chromeFg.flatMap(([fName, fHex]) =>
					chromeSurfaces.map(([bName, bHex]): [string, string, string] => [`${fName} on ${bName}`, fHex, bHex]),
				);
				expect(failingValues(pairs, TEXT)).toEqual([]);
			});

			test("editor muted, accent and semantic colours read on editor surfaces", () => {
				const editorFg: [string, string][] = [
					["editorMuted", s.editorMuted],
					["editorAccent", s.editorAccent],
					["editorOk", s.editorOk],
					["editorWarning", s.editorWarning],
					["editorError", s.editorError],
					["editorInfo", s.editorInfo],
				];
				const pairs = editorFg.flatMap(([fName, fHex]) =>
					editorSurfaces.map(([bName, bHex]): [string, string, string] => [`${fName} on ${bName}`, fHex, bHex]),
				);
				expect(failingValues(pairs, TEXT)).toEqual([]);
			});

			test("control borders and focus rings pass WCAG boundary contrast", () => {
				expect(
					failingValues(
						[
							["inputBorder on sideBg", s.inputBorder, s.sideBg],
							["inputBorder on inputBg", s.inputBorder, s.inputBg],
							["accent on sideBg", s.accent, s.sideBg],
							["accent on inputBg", s.accent, s.inputBg],
							["editorAccent on editorBg", s.editorAccent, s.editorBg],
						],
						BOUNDARY,
					),
				).toEqual([]);
			});

			test("every TextMate and semantic syntax colour reads on editor and active line", () => {
				const tokenPairs: [string, string, string][] = [];
				for (const t of theme.tokenColors) {
					if (!t.settings.foreground) continue;
					for (const [bName, bHex] of editorSurfaces) tokenPairs.push([`${String(t.scope)} on ${bName}`, t.settings.foreground, bHex]);
				}
				for (const [sel, val] of Object.entries(theme.semanticTokenColors)) {
					const fg = typeof val === "string" ? val : val.foreground;
					if (!fg) continue;
					for (const [bName, bHex] of editorSurfaces) tokenPairs.push([`semantic:${sel} on ${bName}`, fg, bHex]);
				}
				expect(failingValues(tokenPairs, TEXT)).toEqual([]);
			});
		});
	}
});
