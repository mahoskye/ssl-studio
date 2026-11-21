// Deterministic OKLCH Warm Material theme engine (ADR 0027, docs/UI-DESIGN.md).
// Pure TypeScript with zero DOM or Monaco imports so both the view and
// test/contrast.test.ts can share the exact same generated themes.
import { contrast, luminance } from "./contrast";

export const TONES = ["paper", "stone", "split", "dusk", "obsidian"] as const;
export type ThemeTone = (typeof TONES)[number];

export const MATERIALS = ["walnut", "moss", "clay", "steel", "veridian"] as const;
export type ThemeMaterial = (typeof MATERIALS)[number];

export type ToneInfo = {
	id: ThemeTone;
	label: string;
	chromeDark: boolean;
	editorDark: boolean;
};

export type MaterialInfo = {
	id: ThemeMaterial;
	label: string;
	baseH: number;
	baseC: number;
	accH: number;
	accC: number;
	swatch: string;
};

export const TONE_INFO: Record<ThemeTone, ToneInfo> = {
	paper: { id: "paper", label: "Paper", chromeDark: false, editorDark: false },
	stone: { id: "stone", label: "Stone", chromeDark: false, editorDark: false },
	split: { id: "split", label: "Split Warm", chromeDark: true, editorDark: false },
	dusk: { id: "dusk", label: "Slate Dusk", chromeDark: true, editorDark: true },
	obsidian: { id: "obsidian", label: "Obsidian", chromeDark: true, editorDark: true },
};

export const MATERIAL_INFO: Record<ThemeMaterial, MaterialInfo> = {
	walnut: { id: "walnut", label: "Walnut", baseH: 66, baseC: 0.014, accH: 50, accC: 0.13, swatch: "#b86b35" },
	moss: { id: "moss", label: "Moss", baseH: 142, baseC: 0.013, accH: 148, accC: 0.11, swatch: "#3b7f52" },
	clay: { id: "clay", label: "Clay", baseH: 46, baseC: 0.014, accH: 30, accC: 0.14, swatch: "#c45238" },
	steel: { id: "steel", label: "Steel", baseH: 235, baseC: 0.013, accH: 242, accC: 0.13, swatch: "#3a6ec4" },
	veridian: { id: "veridian", label: "Veridian", baseH: 175, baseC: 0.012, accH: 176, accC: 0.11, swatch: "#1c807c" },
};

type ToneCurve = {
	dark: boolean;
	tray: number;
	side: number;
	ed: number;
	panel: number;
	hl: number;
	bdr: number;
	inp: number;
	hov: number;
	sel: number;
};

// Frozen verbatim from ui-overhaul-final.html (docs/UI-DESIGN.md Section 7).
const CURVES: Record<ThemeTone, ToneCurve> = {
	paper: { dark: false, tray: 0.904, side: 0.942, ed: 0.975, panel: 0.946, hl: 0.944, bdr: 0.848, inp: 0.985, hov: 0.896, sel: 0.866 },
	stone: { dark: false, tray: 0.832, side: 0.876, ed: 0.916, panel: 0.880, hl: 0.882, bdr: 0.775, inp: 0.942, hov: 0.834, sel: 0.798 },
	split: { dark: true, tray: 0.146, side: 0.186, ed: 0.224, panel: 0.186, hl: 0.262, bdr: 0.285, inp: 0.160, hov: 0.232, sel: 0.274 },
	dusk: { dark: true, tray: 0.200, side: 0.240, ed: 0.280, panel: 0.244, hl: 0.318, bdr: 0.346, inp: 0.218, hov: 0.286, sel: 0.328 },
	obsidian: { dark: true, tray: 0.134, side: 0.174, ed: 0.214, panel: 0.178, hl: 0.252, bdr: 0.278, inp: 0.150, hov: 0.222, sel: 0.266 },
};

export const DEFAULT_MATERIAL: ThemeMaterial = "walnut";
export const DEFAULT_LIGHT_TONE: ThemeTone = "paper";
export const DEFAULT_DARK_TONE: ThemeTone = "dusk";

export type StudioTokens = {
	trayBg: string;
	cmdBg: string;
	strongFg: string;
	bg: string;
	fg: string;
	sideBg: string;
	sideFg: string;
	border: string;
	panelBg: string;
	statusBg: string;
	statusFg: string;
	tabBg: string;
	tabFg: string;
	tabActiveBg: string;
	tabActiveFg: string;
	accent: string;
	buttonBg: string;
	buttonFg: string;
	inputBg: string;
	inputFg: string;
	inputBorder: string;
	hover: string;
	selected: string;
	muted: string;
	error: string;
	warning: string;
	info: string;
	ok: string;
	// Decoupled editor-surface tokens so Split Warm (dark chrome + warm paper
	// editor) guarantees WCAG AA independently on both polarities.
	editorBg: string;
	editorFg: string;
	editorStrong: string;
	editorMuted: string;
	editorAccent: string;
	editorBorder: string;
	editorStripBg: string;
	editorLineHl: string;
	editorOk: string;
	editorWarning: string;
	editorError: string;
	editorInfo: string;
};

export type GeneratedTheme = {
	id: string;
	tone: ThemeTone;
	material: ThemeMaterial;
	name: string;
	type: "dark" | "light";
	chromeDark: boolean;
	editorDark: boolean;
	semanticHighlighting: true;
	semanticTokenColors: Record<string, string | { foreground?: string; fontStyle?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean }>;
	colors: Record<string, string>;
	tokenColors: { name?: string; scope?: string | string[]; settings: { foreground?: string; background?: string; fontStyle?: string } }[];
	studio: StudioTokens;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Converts OKLCH (L in 0..1, C >= 0, H in degrees) to sRGB "#rrggbb". */
export function oklchHex(L: number, C: number, H: number): string {
	const hr = (H * Math.PI) / 180;
	const a = C * Math.cos(hr);
	const b = C * Math.sin(hr);
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;
	const rL = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const gL = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const bL = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
	const enc = (x: number) => {
		const c = clamp01(x);
		return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
	};
	return (
		"#" +
		[rL, gL, bL]
			.map((v) => Math.round(enc(v) * 255).toString(16).padStart(2, "0"))
			.join("")
	);
}

/**
 * Nudges OKLCH lightness (and gently eases chroma if hitting sRGB bounds) until
 * the resulting colour achieves at least `target` contrast against every surface
 * in `surfaces`.
 */
function safeFgOnAll(L: number, C: number, H: number, surfaces: string[], target = 4.65): string {
	const dark = surfaces.every((bg) => luminance(bg) < 0.25);
	let curL = L;
	let curC = C;
	let hex = oklchHex(curL, curC, H);
	const ok = (color: string) => surfaces.every((bg) => contrast(color, bg) >= target);
	if (ok(hex)) return hex;
	for (let i = 0; i < 65; i++) {
		curL = dark ? Math.min(0.985, curL + 0.012) : Math.max(0.10, curL - 0.012);
		hex = oklchHex(curL, curC, H);
		if (ok(hex)) return hex;
		if ((dark && curL >= 0.975) || (!dark && curL <= 0.12)) {
			curC *= 0.82;
			hex = oklchHex(curL, curC, H);
			if (ok(hex)) return hex;
		}
	}
	return hex;
}

/** Picks a filled button background + white/ink foreground guaranteed >= 4.7:1. */
function safeButton(baseAccent: string, accC: number, accH: number, dark: boolean): { bg: string; fg: string } {
	const white = "#ffffff";
	const ink = "#171411";
	const pickFg = (bg: string) => (contrast(white, bg) >= contrast(ink, bg) ? white : ink);
	let bg = baseAccent;
	let fg = pickFg(bg);
	if (contrast(fg, bg) >= 4.7) return { bg, fg };
	// Step darker toward a rich solid button fill with white text, or lighter with dark ink.
	let L = dark ? 0.56 : 0.45;
	for (let i = 0; i < 40; i++) {
		bg = oklchHex(L, accC, accH);
		fg = pickFg(bg);
		if (contrast(fg, bg) >= 4.7) return { bg, fg };
		L = Math.max(0.24, L - 0.015);
	}
	return { bg, fg };
}

export const oklchThemeId = (tone: ThemeTone, material: ThemeMaterial) => `oklch:${tone}:${material}`;

export function isThemeTone(value: unknown): value is ThemeTone {
	return typeof value === "string" && (TONES as readonly string[]).includes(value);
}

export function isThemeMaterial(value: unknown): value is ThemeMaterial {
	return typeof value === "string" && (MATERIALS as readonly string[]).includes(value);
}

export function parseOklchThemeId(id: string): { tone: ThemeTone; material: ThemeMaterial } | null {
	const match = /^oklch:([a-z]+):([a-z]+)$/.exec(id);
	if (!match) return null;
	const [, tone, material] = match;
	if (!isThemeTone(tone) || !isThemeMaterial(material)) return null;
	return { tone, material };
}

export const isOklchThemeId = (id: string) => parseOklchThemeId(id) !== null;

const cache = new Map<string, GeneratedTheme>();

/** Generates (and memoizes) a complete WCAG-verified OKLCH Warm Material theme. */
export function generateOklchTheme(tone: ThemeTone, material: ThemeMaterial): GeneratedTheme {
	const id = oklchThemeId(tone, material);
	const cached = cache.get(id);
	if (cached) return cached;

	const m = MATERIAL_INFO[material];
	const c = CURVES[tone];
	const isSplit = tone === "split";
	const mk = (L: number, cm = 1) => oklchHex(L, m.baseC * cm, m.baseH);

	const trayBg = mk(c.tray);
	const sideBg = mk(c.side);
	const panelBg = mk(c.panel);
	const border = mk(c.bdr, 1.1);
	const cmdBg = mk(c.dark ? c.tray + 0.032 : c.tray - 0.025, 0.9);
	const inputBg = mk(c.inp, 0.8);
	const hover = mk(c.hov, 1.2);
	const selected = mk(c.sel, 1.45);

	// Editor canvas (warm paper on Split Warm; material-matched on uniform tones).
	const edDark = isSplit ? false : c.dark;
	const edH = isSplit ? 76 : m.baseH;
	const edC = isSplit ? 0.013 : m.baseC;
	const edMk = (L: number, cm = 1) => oklchHex(L, edC * cm, edH);
	const editorBg = isSplit ? edMk(0.972) : mk(c.ed);
	const lineHl = isSplit ? edMk(0.944, 1.15) : mk(c.hl, 1.15);
	const editorBorder = isSplit ? edMk(0.862, 1.05) : border;
	const editorStripBg = isSplit ? edMk(0.955) : mk(c.ed - 0.016);
	const editorSelection = edDark ? oklchHex(Math.min(0.40, c.ed + 0.11), Math.max(0.032, m.baseC * 2.2), m.accH) : oklchHex(0.885, 0.032, m.accH);
	const indentGuide = edDark ? edMk(c.ed + 0.06, 0.9) : edMk(isSplit ? 0.915 : c.ed - 0.055, 0.9);
	const whitespace = edDark ? edMk(c.ed + 0.12, 0.9) : edMk(isSplit ? 0.845 : c.ed - 0.12, 0.9);

	// Every chrome surface where chrome text/status labels may sit.
	const chromeSurfaces = isSplit ? [trayBg, sideBg, panelBg, hover, selected] : [trayBg, sideBg, panelBg, hover, selected, editorBg];
	const editorSurfaces = [editorBg, lineHl];

	const sideFg = safeFgOnAll(c.dark ? 0.86 : 0.28, m.baseC * 0.5, m.baseH, [sideBg, hover, selected], 7.0);
	const strongFg = safeFgOnAll(c.dark ? 0.94 : 0.18, m.baseC * 0.4, m.baseH, [sideBg, trayBg, hover, selected], 9.0);
	const statusFg = safeFgOnAll(c.dark ? 0.78 : 0.34, m.baseC * 0.6, m.baseH, [trayBg], 5.5);
	const inputFg = safeFgOnAll(c.dark ? 0.89 : 0.24, m.baseC * 0.5, m.baseH, [inputBg], 8.5);
	const muted = safeFgOnAll(c.dark ? 0.69 : 0.47, m.baseC * 0.7, m.baseH, chromeSurfaces, 4.65);
	const inputBorder = safeFgOnAll(c.dark ? 0.50 : 0.56, m.baseC * 0.85, m.baseH, isSplit ? [sideBg, inputBg] : [sideBg, inputBg, editorBg], 3.15);
	const accent = safeFgOnAll(c.dark ? 0.75 : 0.47, m.accC, m.accH, [...chromeSurfaces, inputBg], 4.65);
	const button = safeButton(accent, m.accC, m.accH, c.dark);

	const ok = safeFgOnAll(c.dark ? 0.76 : 0.45, 0.12, 148, chromeSurfaces, 4.65);
	const warning = safeFgOnAll(c.dark ? 0.80 : 0.50, 0.13, 78, chromeSurfaces, 4.65);
	const error = safeFgOnAll(c.dark ? 0.72 : 0.47, 0.15, 22, chromeSurfaces, 4.65);
	const info = safeFgOnAll(c.dark ? 0.76 : 0.47, 0.12, 245, chromeSurfaces, 4.65);

	// Editor-calibrated foregrounds & semantic marks.
	const editorFg = safeFgOnAll(edDark ? 0.89 : 0.23, edC * 0.5, edH, editorSurfaces, 9.5);
	const editorStrong = safeFgOnAll(edDark ? 0.95 : 0.17, edC * 0.4, edH, editorSurfaces, 11.0);
	const editorMuted = safeFgOnAll(edDark ? 0.67 : 0.48, edC * 0.7, edH, editorSurfaces, 4.65);
	const lineNum = safeFgOnAll(edDark ? 0.61 : 0.51, edC * 0.6, edH, editorSurfaces, 4.65);
	const lineNumActive = safeFgOnAll(edDark ? 0.80 : 0.34, edC * 0.5, edH, editorSurfaces, 6.5);
	const editorAccent = safeFgOnAll(edDark ? 0.75 : 0.46, m.accC, m.accH, editorSurfaces, 4.65);
	const editorOk = safeFgOnAll(edDark ? 0.76 : 0.45, 0.13, 148, editorSurfaces, 4.65);
	const editorWarning = safeFgOnAll(edDark ? 0.80 : 0.50, 0.13, 78, editorSurfaces, 4.65);
	const editorError = safeFgOnAll(edDark ? 0.72 : 0.47, 0.15, 22, editorSurfaces, 4.65);
	const editorInfo = safeFgOnAll(edDark ? 0.75 : 0.46, 0.13, 245, editorSurfaces, 4.65);

	// Peek references / Peek definition widget surfaces & foregrounds (editor-polarity calibrated on Split Warm).
	const peekEditorBg = isSplit
		? edMk(0.962)
		: edDark
			? oklchHex(Math.max(0.11, c.ed - 0.022), edC, edH)
			: oklchHex(Math.min(0.99, c.ed + 0.014), edC, edH);
	const peekResultBg = isSplit ? editorStripBg : sideBg;
	const peekTitleBg = isSplit ? lineHl : panelBg;
	const peekSelectBg = isSplit ? editorSelection : selected;
	const peekTitleFg = safeFgOnAll(edDark ? 0.94 : 0.18, edC * 0.4, edH, [peekTitleBg], 7.0);
	const peekDescFg = safeFgOnAll(edDark ? 0.67 : 0.47, edC * 0.7, edH, [peekTitleBg, peekResultBg], 4.65);
	const peekFileFg = safeFgOnAll(edDark ? 0.92 : 0.20, edC * 0.4, edH, [peekResultBg], 7.0);
	const peekLineFg = safeFgOnAll(edDark ? 0.85 : 0.28, edC * 0.5, edH, [peekResultBg], 6.0);
	const peekSelectFg = safeFgOnAll(edDark ? 0.95 : 0.16, edC * 0.4, edH, [peekSelectBg], 7.0);

	// Syntax tokens guaranteed >= 4.65:1 against both editorBg and lineHl.
	const syn = (L: number, C: number, H: number) => safeFgOnAll(L, C, H, editorSurfaces, 4.65);
	const syntax = {
		comment: editorMuted,
		string: syn(edDark ? 0.79 : 0.45, 0.11, 146),
		stringId: syn(edDark ? 0.82 : 0.44, 0.12, 134),
		number: syn(edDark ? 0.76 : 0.47, 0.12, 48),
		keyword: editorAccent,
		operator: syn(edDark ? 0.81 : 0.45, 0.10, 206),
		dbParam: syn(edDark ? 0.76 : 0.46, 0.13, 36),
		supportFn: syn(edDark ? 0.77 : 0.46, 0.12, 246),
		method: syn(edDark ? 0.80 : 0.45, 0.10, 182),
		entity: syn(edDark ? 0.81 : 0.47, 0.12, 76),
		param: syn(edDark ? 0.74 : 0.47, 0.13, 14),
		varLang: syn(edDark ? 0.76 : 0.46, 0.13, 352),
		property: syn(edDark ? 0.78 : 0.44, 0.05, 215),
		invalid: editorError,
	};

	const bracket1 = syntax.entity;
	const bracket2 = syntax.keyword;
	const bracket3 = syntax.supportFn;

	const studio: StudioTokens = {
		trayBg,
		cmdBg,
		strongFg,
		// On Split Warm, root --bg/--fg stay on the dark chrome polarity so
		// dialogs, toasts, bottom panels and menus stay readable; editor sheets
		// scope to --editor-* tokens explicitly in style.css.
		bg: isSplit ? sideBg : editorBg,
		fg: isSplit ? sideFg : editorFg,
		sideBg,
		sideFg,
		border,
		panelBg,
		statusBg: trayBg,
		statusFg,
		tabBg: trayBg,
		tabFg: muted,
		tabActiveBg: editorBg,
		tabActiveFg: editorStrong,
		accent,
		buttonBg: button.bg,
		buttonFg: button.fg,
		inputBg,
		inputFg,
		inputBorder,
		hover,
		selected,
		muted,
		error,
		warning,
		info,
		ok,
		editorBg,
		editorFg,
		editorStrong,
		editorMuted,
		editorAccent,
		editorBorder,
		editorStripBg,
		editorLineHl: lineHl,
		editorOk,
		editorWarning,
		editorError,
		editorInfo,
	};

	// Monaco & VS Code workbench colours. On Split Warm, Monaco's in-editor
	// diagnostic/widget keys use editor-calibrated colours so squiggles and
	// hover widgets stay high-contrast on the light warm paper sheet.
	const colors: Record<string, string> = {
		"editor.background": editorBg,
		"editor.foreground": editorFg,
		"editorLineNumber.foreground": lineNum,
		"editorLineNumber.activeForeground": lineNumActive,
		"editor.selectionBackground": editorSelection,
		"editor.lineHighlightBackground": lineHl,
		"editorCursor.foreground": editorAccent,
		"editorIndentGuide.background1": indentGuide,
		"editorWhitespace.foreground": whitespace,
		"editorWidget.background": isSplit ? editorStripBg : sideBg,
		"editorWidget.foreground": isSplit ? editorFg : sideFg,
		"editorWidget.border": editorBorder,
		"editorHoverWidget.background": isSplit ? editorStripBg : sideBg,
		"editorHoverWidget.foreground": isSplit ? editorFg : sideFg,
		"editorHoverWidget.border": editorBorder,
		"editorSuggestWidget.background": isSplit ? editorStripBg : sideBg,
		"editorSuggestWidget.foreground": isSplit ? editorFg : sideFg,
		"editorSuggestWidget.border": editorBorder,
		"editorSuggestWidget.selectedBackground": isSplit ? lineHl : selected,
		"editorStickyScroll.background": editorBg,
		"editorStickyScrollHover.background": lineHl,
		"editorStickyScroll.border": editorBorder,
		"peekView.border": editorAccent,
		"peekViewTitle.background": peekTitleBg,
		"peekViewTitleLabel.foreground": peekTitleFg,
		"peekViewTitleDescription.foreground": peekDescFg,
		"peekViewEditor.background": peekEditorBg,
		"peekViewEditorGutter.background": peekEditorBg,
		"peekViewEditor.matchHighlightBackground": editorSelection,
		"peekViewEditor.matchHighlightBorder": editorAccent,
		"peekViewResult.background": peekResultBg,
		"peekViewResult.fileForeground": peekFileFg,
		"peekViewResult.lineForeground": peekLineFg,
		"peekViewResult.matchHighlightBackground": editorSelection,
		"peekViewResult.selectionBackground": peekSelectBg,
		"peekViewResult.selectionForeground": peekSelectFg,
		"sideBar.background": sideBg,
		"sideBar.foreground": sideFg,
		"sideBar.border": border,
		"panel.background": panelBg,
		"panel.border": border,
		"statusBar.background": trayBg,
		"statusBar.foreground": statusFg,
		"tab.activeBackground": editorBg,
		"tab.inactiveBackground": trayBg,
		"tab.activeForeground": editorStrong,
		"tab.inactiveForeground": muted,
		"focusBorder": accent,
		"editorBracketHighlight.foreground1": bracket1,
		"editorBracketHighlight.foreground2": bracket2,
		"editorBracketHighlight.foreground3": bracket3,
		"editorBracketHighlight.foreground4": bracket1,
		"editorBracketHighlight.foreground5": bracket2,
		"editorBracketHighlight.foreground6": bracket3,
		"editorBracketHighlight.unexpectedBracket.foreground": editorError,
		"button.background": button.bg,
		"button.foreground": button.fg,
		"input.background": inputBg,
		"input.foreground": inputFg,
		"input.border": inputBorder,
		"list.hoverBackground": hover,
		"list.activeSelectionBackground": selected,
		"list.activeSelectionForeground": strongFg,
		"descriptionForeground": muted,
		"editorError.foreground": isSplit ? editorError : error,
		"editorWarning.foreground": isSplit ? editorWarning : warning,
		"editorInfo.foreground": isSplit ? editorInfo : info,
		"testing.iconPassed": ok,
	};

	const generated: GeneratedTheme = {
		id,
		tone,
		material,
		name: `${TONE_INFO[tone].label} · ${m.label}`,
		type: c.dark ? "dark" : "light",
		chromeDark: c.dark,
		editorDark: edDark,
		semanticHighlighting: true,
		semanticTokenColors: {
			method: syntax.method,
			"variable.defaultLibrary": syntax.varLang,
			"variable.public": { foreground: syntax.dbParam, italic: true },
			"variable.unknown": { foreground: syntax.invalid, underline: true },
		},
		colors,
		tokenColors: [
			{ scope: "comment", settings: { foreground: syntax.comment, fontStyle: "italic" } },
			{ scope: ["string", "string.quoted"], settings: { foreground: syntax.string } },
			{ scope: "string.quoted.double.identifier", settings: { foreground: syntax.stringId } },
			{ scope: "constant.numeric", settings: { foreground: syntax.number } },
			{ scope: "constant.language", settings: { foreground: syntax.number, fontStyle: "bold" } },
			{ scope: "keyword.control", settings: { foreground: syntax.keyword, fontStyle: "bold" } },
			{ scope: "keyword.operator", settings: { foreground: syntax.operator } },
			{ scope: "keyword.other.database-parameter", settings: { foreground: syntax.dbParam } },
			{ scope: "storage.modifier", settings: { foreground: syntax.keyword } },
			{ scope: ["support.function", "support.class"], settings: { foreground: syntax.supportFn } },
			{ scope: "support.function.method", settings: { foreground: syntax.method } },
			{ scope: ["entity.name.function", "entity.name.type", "entity.name.module", "entity.other.inherited-class"], settings: { foreground: syntax.entity } },
			{ scope: "entity.name.label", settings: { foreground: syntax.dbParam } },
			{ scope: "variable.parameter", settings: { foreground: syntax.param } },
			{ scope: "variable.language", settings: { foreground: syntax.varLang } },
			{ scope: "variable.other.property", settings: { foreground: syntax.property } },
			{ scope: "markup.heading", settings: { foreground: syntax.keyword, fontStyle: "bold" } },
			{ scope: "markup.bold", settings: { fontStyle: "bold" } },
			{ scope: "markup.italic", settings: { fontStyle: "italic" } },
			{ scope: "markup.inline.raw", settings: { foreground: syntax.method } },
			{ scope: "markup.underline.link", settings: { foreground: syntax.supportFn, fontStyle: "underline" } },
			{ scope: "entity.name.tag", settings: { foreground: syntax.param } },
			{ scope: "entity.other.attribute-name", settings: { foreground: syntax.entity } },
			{ scope: "support.type.property-name", settings: { foreground: syntax.supportFn } },
			{ scope: "entity.name.section", settings: { foreground: syntax.entity, fontStyle: "bold" } },
			{ scope: "constant.character.escape", settings: { foreground: syntax.operator } },
			{ scope: "invalid", settings: { foreground: syntax.invalid, fontStyle: "underline" } },
		],
		studio,
	};

	cache.set(id, generated);
	return generated;
}

/** All 25 built-in OKLCH Tone × Material themes. */
export function allOklchThemes(): GeneratedTheme[] {
	const list: GeneratedTheme[] = [];
	for (const tone of TONES) for (const material of MATERIALS) list.push(generateOklchTheme(tone, material));
	return list;
}
