// Themes are VS Code colour theme files or generated OKLCH Warm Material
// palettes (ADR 0027). Token colours go through the grammar's TextMate scopes
// (editor/textmate.ts); workbench colours become CSS variables for chrome and
// editor canvases.
import { createSignal } from "solid-js";
import type { IRawTheme } from "vscode-textmate";
import { DEFAULT_CODE_FONT, DEFAULT_UI_FONT, resolveFontStack } from "../../shared/fonts";
import { parseJsonc } from "../../shared/jsonc";
import {
	DEFAULT_DARK_TONE,
	DEFAULT_LIGHT_TONE,
	DEFAULT_MATERIAL,
	generateOklchTheme,
	isThemeMaterial,
	parseOklchThemeId,
	type StudioTokens,
} from "../../shared/oklchTheme";
import { monaco } from "../editor/monaco";
import { refreshSemanticTokens, semanticRules } from "../editor/semantic";
import { applyTokenTheme } from "../editor/textmate";
import dark from "./studio-dark.json";
import light from "./studio-light.json";

export type VsTheme = {
	name?: string;
	type?: "dark" | "light" | "hc" | "hcLight";
	chromeDark?: boolean;
	editorDark?: boolean;
	colors?: Record<string, string>;
	semanticHighlighting?: boolean;
	semanticTokenColors?: Record<string, string | { foreground?: string; fontStyle?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean }>;
	tokenColors?: { name?: string; scope?: string | string[]; settings: { foreground?: string; background?: string; fontStyle?: string } }[];
	studio?: StudioTokens;
};

export const builtIn: Record<string, VsTheme> = { dark: dark as VsTheme, light: light as VsTheme };

const CSS_VARS: [string, string][] = [
	["--bg", "editor.background"],
	["--fg", "editor.foreground"],
	["--side-bg", "sideBar.background"],
	["--side-fg", "sideBar.foreground"],
	["--border", "sideBar.border"],
	["--panel-bg", "panel.background"],
	["--status-bg", "statusBar.background"],
	["--status-fg", "statusBar.foreground"],
	["--tab-bg", "tab.inactiveBackground"],
	["--tab-fg", "tab.inactiveForeground"],
	["--tab-active-bg", "tab.activeBackground"],
	["--tab-active-fg", "tab.activeForeground"],
	["--accent", "focusBorder"],
	["--button-bg", "button.background"],
	["--button-fg", "button.foreground"],
	["--input-bg", "input.background"],
	["--input-fg", "input.foreground"],
	["--input-border", "input.border"],
	["--hover", "list.hoverBackground"],
	["--selected", "list.activeSelectionBackground"],
	["--muted", "descriptionForeground"],
	["--error", "editorError.foreground"],
	["--warning", "editorWarning.foreground"],
	["--info", "editorInfo.foreground"],
	// "Passed", "ready", "within the limit": VS Code's own key for a passed test.
	["--ok", "testing.iconPassed"],
];

const isChromeDark = (theme: VsTheme) => theme.chromeDark ?? (theme.type !== "light" && theme.type !== "hcLight");
const isEditorDark = (theme: VsTheme) => theme.editorDark ?? (theme.type !== "light" && theme.type !== "hcLight");
const validColor = (value: unknown): value is string => typeof value === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);

/** The shape of the app's own menus (style.css, .menu-pop and .menu-item), for the editor's menu in its own tree. */
const MENU_SHAPE = `
.monaco-menu-container { border-radius: var(--radius-lg) !important; box-shadow: var(--shadow) !important; overflow: hidden; }
.monaco-menu { font: var(--text-base)/1.4 var(--ui-font, system-ui, -apple-system, "Segoe UI", sans-serif) !important; }
.monaco-menu .monaco-action-bar.vertical { padding: var(--space-2) !important; }
.monaco-menu .monaco-action-bar.vertical .action-item { border-radius: var(--radius-sm); }
.monaco-menu .monaco-action-bar.vertical .keybinding { color: var(--muted) !important; opacity: 1 !important; font-size: var(--text-sm) !important; }
`;

/** Gives each of the editor's menus, as it is made, the shape of the app's own. */
export function shapeEditorMenus() {
	const shape = (host: Element) => {
		const root = host.shadowRoot;
		if (!root || root.querySelector("style[data-studio]")) return;
		const style = document.createElement("style");
		style.dataset.studio = "";
		style.textContent = MENU_SHAPE;
		root.append(style);
	};
	new MutationObserver((changes) => {
		for (const change of changes) for (const node of change.addedNodes) if (node instanceof Element && node.classList.contains("shadow-root-host")) shape(node);
	}).observe(document.body, { childList: true, subtree: true });
}

let themeRevision = 0;
const [themeVersion, setThemeVersion] = createSignal(0);

/** Reactive counter bumped whenever the active editor/UI theme changes. */
export { themeVersion };
/** Non-reactive read of the current theme revision (safe inside CodeMirror plugins & caches). */
export const currentThemeVersion = () => themeRevision;

/**
 * Mirrors Monaco's active `.mtk*` token colour and font-style rules under
 * `.cm-md-codeblock-line` so fenced code blocks in CodeMirror Live & Read
 * views render in the exact same colours as the Monaco editor—even inside
 * blockquotes or nested Markdown structures whose single-class CM6 rules
 * would otherwise match `.mtk*` specificity.
 */
export function syncCodeTokenStyles() {
	if (typeof document === "undefined") return;
	const declared = [...document.querySelectorAll("style.monaco-colors")].map((style) => style.textContent ?? "").join("\n");
	const rules: string[] = [];
	for (const match of declared.matchAll(/(\.mtk(?:\d+|[bius])(?:\.mtk[bius])*)\s*(\{[^{}]*\})/g)) {
		rules.push(`.cm-md-codeblock-line ${match[1]} ${match[2]}`);
	}
	if (!rules.length) return;
	let style = document.getElementById("studio-code-tokens");
	if (!style) {
		style = document.createElement("style");
		style.id = "studio-code-tokens";
		document.head.append(style);
	}
	style.textContent = rules.join("\n");
}

function carryMenuColours() {
	const declared = [...document.querySelectorAll("style.monaco-colors")].map((style) => style.textContent ?? "").join("\n");
	const block = /\{([^{}]*--vscode-menu-background[^{}]*)\}/.exec(declared)?.[1];
	if (block) {
		let style = document.getElementById("studio-menu-colours");
		if (!style) {
			style = document.createElement("style");
			style.id = "studio-menu-colours";
			document.head.append(style);
		}
		style.textContent = `.shadow-root-host { ${block} }`;
	}
	syncCodeTokenStyles();
}

/** Applies the configured UI, code and optional Markdown reading font stacks. */
export function applyFonts(fonts: { uiFont?: string; codeFont?: string; readFont?: string }) {
	const root = document.documentElement;
	const ui = resolveFontStack(fonts.uiFont, DEFAULT_UI_FONT);
	const code = resolveFontStack(fonts.codeFont, DEFAULT_CODE_FONT);
	const read = fonts.readFont?.trim() ? resolveFontStack(fonts.readFont, ui) : ui;
	root.style.setProperty("--ui-font", ui);
	root.style.setProperty("--code-font", code);
	root.style.setProperty("--read-font", read);
}

export function applyTheme(theme: VsTheme) {
	const chromeDark = isChromeDark(theme);
	const editorDark = isEditorDark(theme);
	const base = editorDark ? builtIn.dark! : builtIn.light!;
	const themed: Record<string, string> = { ...base.colors, ...theme.colors };
	// The editor's right-click menu takes the colours the app's own menus are drawn in, whatever the theme says of
	// "menu.*": those keys are for a window's menu bar, which this app does not have.
	const colors: Record<string, string> = {
		...themed,
		"menu.background": themed["sideBar.background"],
		"menu.foreground": themed["sideBar.foreground"],
		"menu.selectionBackground": themed["list.hoverBackground"],
		"menu.selectionForeground": themed["sideBar.foreground"],
		"menu.separatorBackground": themed["sideBar.border"],
		"menu.border": themed["input.border"],
		"peekView.border": themed["peekView.border"] ?? themed["focusBorder"],
		"peekViewTitle.background": themed["peekViewTitle.background"] ?? themed["panel.background"],
		"peekViewTitleLabel.foreground": themed["peekViewTitleLabel.foreground"] ?? themed["tab.activeForeground"] ?? themed["editor.foreground"],
		"peekViewTitleDescription.foreground": themed["peekViewTitleDescription.foreground"] ?? themed["descriptionForeground"],
		"peekViewEditor.background": themed["peekViewEditor.background"] ?? themed["editor.background"],
		"peekViewEditorGutter.background": themed["peekViewEditorGutter.background"] ?? themed["peekViewEditor.background"] ?? themed["editor.background"],
		"peekViewEditor.matchHighlightBackground": themed["peekViewEditor.matchHighlightBackground"] ?? themed["editor.selectionBackground"],
		"peekViewResult.background": themed["peekViewResult.background"] ?? themed["sideBar.background"],
		"peekViewResult.fileForeground": themed["peekViewResult.fileForeground"] ?? themed["tab.activeForeground"] ?? themed["sideBar.foreground"],
		"peekViewResult.lineForeground": themed["peekViewResult.lineForeground"] ?? themed["sideBar.foreground"],
		"peekViewResult.matchHighlightBackground": themed["peekViewResult.matchHighlightBackground"] ?? themed["editor.selectionBackground"],
		"peekViewResult.selectionBackground": themed["peekViewResult.selectionBackground"] ?? themed["list.activeSelectionBackground"],
		"peekViewResult.selectionForeground": themed["peekViewResult.selectionForeground"] ?? themed["list.activeSelectionForeground"] ?? themed["sideBar.foreground"],
		"editorStickyScroll.background": themed["editorStickyScroll.background"] ?? themed["editor.background"],
		"editorStickyScrollHover.background": themed["editorStickyScrollHover.background"] ?? themed["editor.lineHighlightBackground"],
		"editorStickyScroll.border": themed["editorStickyScroll.border"] ?? themed["sideBar.border"],
	};
	const raw: IRawTheme = {
		name: theme.name,
		settings: [
			{ settings: { foreground: colors["editor.foreground"], background: colors["editor.background"] } },
			...((theme.tokenColors ?? []) as IRawTheme["settings"]),
		],
	};
	const rules = applyTokenTheme(raw);
	monaco.editor.defineTheme("studio", {
		base: editorDark ? "vs-dark" : "vs",
		inherit: true,
		rules: [...rules, ...semanticRules(theme)],
		colors: Object.fromEntries(Object.entries(colors).filter(([, v]) => validColor(v))),
	});
	monaco.editor.setTheme("studio");
	carryMenuColours();
	// The editor may write its colours a moment after the theme is set: carried again then.
	requestAnimationFrame(carryMenuColours);
	refreshSemanticTokens();

	const root = document.documentElement;
	const setVar = (name: string, value: string | undefined) => {
		if (validColor(value)) root.style.setProperty(name, value);
	};

	if (theme.studio) {
		const s = theme.studio;
		const pairs: [string, string][] = [
			["--tray-bg", s.trayBg],
			["--cmd-bg", s.cmdBg],
			["--strong-fg", s.strongFg],
			["--bg", s.bg],
			["--fg", s.fg],
			["--side-bg", s.sideBg],
			["--side-fg", s.sideFg],
			["--border", s.border],
			["--panel-bg", s.panelBg],
			["--status-bg", s.statusBg],
			["--status-fg", s.statusFg],
			["--tab-bg", s.tabBg],
			["--tab-fg", s.tabFg],
			["--tab-active-bg", s.tabActiveBg],
			["--tab-active-fg", s.tabActiveFg],
			["--accent", s.accent],
			["--button-bg", s.buttonBg],
			["--button-fg", s.buttonFg],
			["--input-bg", s.inputBg],
			["--input-fg", s.inputFg],
			["--input-border", s.inputBorder],
			["--hover", s.hover],
			["--selected", s.selected],
			["--muted", s.muted],
			["--error", s.error],
			["--warning", s.warning],
			["--info", s.info],
			["--ok", s.ok],
			["--editor-bg", s.editorBg],
			["--editor-fg", s.editorFg],
			["--editor-strong", s.editorStrong],
			["--editor-muted", s.editorMuted],
			["--editor-accent", s.editorAccent],
			["--editor-border", s.editorBorder],
			["--editor-strip-bg", s.editorStripBg],
			["--editor-line-hl", s.editorLineHl],
			["--editor-ok", s.editorOk],
			["--editor-warning", s.editorWarning],
			["--editor-error", s.editorError],
			["--editor-info", s.editorInfo],
		];
		for (const [cssVar, value] of pairs) setVar(cssVar, value);
	} else {
		for (const [cssVar, key] of CSS_VARS) setVar(cssVar, colors[key] ?? base.colors![key]);
		// Classic and imported VS Code themes populate the decoupled Folio Bento
		// and editor-scoped variables from their own workbench keys.
		const get = (key: string) => colors[key] ?? base.colors![key];
		setVar("--tray-bg", get("statusBar.background"));
		setVar("--cmd-bg", get("input.background"));
		setVar("--strong-fg", get("tab.activeForeground"));
		setVar("--editor-bg", get("editor.background"));
		setVar("--editor-fg", get("editor.foreground"));
		setVar("--editor-strong", get("tab.activeForeground"));
		setVar("--editor-muted", get("descriptionForeground"));
		setVar("--editor-accent", get("focusBorder"));
		setVar("--editor-border", get("sideBar.border"));
		setVar("--editor-strip-bg", get("tab.inactiveBackground"));
		setVar("--editor-line-hl", get("editor.lineHighlightBackground"));
		setVar("--editor-ok", get("testing.iconPassed"));
		setVar("--editor-warning", get("editorWarning.foreground"));
		setVar("--editor-error", get("editorError.foreground"));
		setVar("--editor-info", get("editorInfo.foreground"));
	}

	root.dataset.theme = chromeDark ? "dark" : "light";
	root.dataset.editorTheme = editorDark ? "dark" : "light";
	root.style.colorScheme = chromeDark ? "dark" : "light";
	themeRevision++;
	setThemeVersion(themeRevision);
}

/**
 * Resolves a settings value ("system", "oklch:<tone>:<material>", "dark",
 * "light", or "custom:<id>"). `systemDark` is the system's own answer where
 * the app could ask it; without one, "system" uses the web view's media query.
 */
export function resolveTheme(choice: string, custom: { id: string; json: string }[], systemDark?: boolean, material?: string): VsTheme {
	if (choice.startsWith("custom:")) {
		const file = custom.find((t) => t.id === choice);
		if (file) {
			try {
				return parseJsonc(file.json);
			} catch {
				// Fall through to the default OKLCH theme.
			}
		}
	}
	const parsed = parseOklchThemeId(choice);
	if (parsed) return generateOklchTheme(parsed.tone, parsed.material);
	if (choice === "dark" || choice === "light") return builtIn[choice]!;
	const mat = isThemeMaterial(material) ? material : DEFAULT_MATERIAL;
	const preferDark = systemDark !== undefined ? systemDark : !matchMedia("(prefers-color-scheme: light)").matches;
	return generateOklchTheme(preferDark ? DEFAULT_DARK_TONE : DEFAULT_LIGHT_TONE, mat);
}
