// Themes are VS Code colour theme files or generated OKLCH Warm Material
// palettes (ADR 0027). Token colours go through the grammar's TextMate scopes
// (editor/textmate.ts); workbench colours become CSS variables for chrome and
// editor canvases.
import { createSignal } from "solid-js";
import type { IRawTheme } from "vscode-textmate";
import { pickAccentFg } from "../../shared/contrast";
import { DEFAULT_CODE_FONT, DEFAULT_UI_FONT, resolveFontStack } from "../../shared/fonts";
import { parseJsonc } from "../../shared/jsonc";
import {
	DEFAULT_DARK_TONE,
	DEFAULT_LIGHT_TONE,
	DEFAULT_MATERIAL,
	generateOklchTheme,
	isThemeMaterial,
	parseOklchThemeId,
	studioVars,
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

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isChromeDark = (theme: VsTheme) => (typeof theme.chromeDark === "boolean" ? theme.chromeDark : theme.type !== "light" && theme.type !== "hcLight");
const isEditorDark = (theme: VsTheme) => (typeof theme.editorDark === "boolean" ? theme.editorDark : theme.type !== "light" && theme.type !== "hcLight");
const validColor = (value: unknown): value is string => typeof value === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);

type TokenColorEntry = { name?: string; scope?: string | string[]; settings: { foreground?: string; background?: string; fontStyle?: string } };

/** Sanitizes untrusted tokenColors from imported VS Code themes so vscode-textmate and semantic.ts never crash. */
export function sanitizeTokenColors(raw: unknown): TokenColorEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: TokenColorEntry[] = [];
	for (const item of raw) {
		if (!isPlainObject(item) || !isPlainObject(item.settings)) continue;
		const settings: TokenColorEntry["settings"] = {};
		if (validColor(item.settings.foreground)) settings.foreground = item.settings.foreground;
		if (validColor(item.settings.background)) settings.background = item.settings.background;
		if (typeof item.settings.fontStyle === "string") settings.fontStyle = item.settings.fontStyle;
		const entry: TokenColorEntry = { settings };
		if (typeof item.name === "string") entry.name = item.name;
		if (typeof item.scope === "string") entry.scope = item.scope;
		else if (Array.isArray(item.scope)) entry.scope = item.scope.filter((s): s is string => typeof s === "string");
		out.push(entry);
	}
	return out;
}

function sanitizeSemanticTokenColors(raw: unknown): VsTheme["semanticTokenColors"] {
	if (!isPlainObject(raw)) return undefined;
	const out: NonNullable<VsTheme["semanticTokenColors"]> = {};
	for (const [selector, value] of Object.entries(raw)) {
		if (typeof value === "string") {
			if (validColor(value)) out[selector] = value;
		} else if (isPlainObject(value)) {
			const rule: { foreground?: string; fontStyle?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean } = {};
			if (validColor(value.foreground)) rule.foreground = value.foreground;
			if (typeof value.fontStyle === "string") rule.fontStyle = value.fontStyle;
			if (typeof value.bold === "boolean") rule.bold = value.bold;
			if (typeof value.italic === "boolean") rule.italic = value.italic;
			if (typeof value.underline === "boolean") rule.underline = value.underline;
			if (typeof value.strikethrough === "boolean") rule.strikethrough = value.strikethrough;
			out[selector] = rule;
		}
	}
	return out;
}

/** The shape of the app's own menus (style.css, .menu-pop and .menu-item), for the editor's menu in its own tree. */
const MENU_SHAPE = `
.monaco-menu-container { border-radius: var(--radius-lg) !important; box-shadow: var(--shadow) !important; overflow: hidden; }
.monaco-menu { font: var(--text-base)/1.4 var(--ui-font, system-ui, -apple-system, "Segoe UI", sans-serif) !important; }
.monaco-menu .monaco-action-bar.vertical { padding: var(--space-2) !important; }
.monaco-menu .monaco-action-bar.vertical .action-item { border-radius: var(--radius-sm); }
.monaco-menu .monaco-action-bar.vertical .keybinding { color: var(--chrome-muted, var(--muted)) !important; opacity: 1 !important; font-size: var(--text-sm) !important; }
`;

let menuObserver: MutationObserver | null = null;

/** Gives each of the editor's menus, as it is made, the shape of the app's own. */
export function shapeEditorMenus() {
	if (typeof document === "undefined" || !document.body) return;
	const shape = (host: Element) => {
		const root = host.shadowRoot;
		if (!root || root.querySelector("style[data-studio]")) return;
		const style = document.createElement("style");
		style.dataset.studio = "";
		style.textContent = MENU_SHAPE;
		root.append(style);
	};
	const scan = (node: Node) => {
		if (!node || (node as Element).nodeType !== 1) return;
		const el = node as Element;
		if (el.classList?.contains("shadow-root-host")) shape(el);
		if (typeof el.querySelectorAll === "function") {
			for (const nested of el.querySelectorAll(".shadow-root-host")) shape(nested);
		}
	};
	// Shape any pre-existing Monaco menu shadow hosts already present in the DOM.
	for (const host of document.body.querySelectorAll(".shadow-root-host")) shape(host);
	if (menuObserver) menuObserver.disconnect();
	if (typeof MutationObserver === "function") {
		menuObserver = new MutationObserver((changes) => {
			for (const change of changes) for (const node of change.addedNodes) scan(node);
		});
		menuObserver.observe(document.body, { childList: true, subtree: true });
	}
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

let menuColoursRaf = 0;

function carryMenuColours() {
	if (menuColoursRaf && typeof cancelAnimationFrame === "function") {
		cancelAnimationFrame(menuColoursRaf);
		menuColoursRaf = 0;
	}
	if (typeof document === "undefined") return;
	const declared = [...document.querySelectorAll("style.monaco-colors")].map((style) => style.textContent ?? "").join("\n");
	const block = /\{([^{}]*--vscode-menu-background[^{}]*)\}/.exec(declared)?.[1];
	let style = document.getElementById("studio-menu-colours");
	if (block) {
		if (!style) {
			style = document.createElement("style");
			style.id = "studio-menu-colours";
			document.head.append(style);
		}
		style.textContent = `.shadow-root-host { ${block} }`;
	} else if (style) {
		style.textContent = "";
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
	const safeTheme: VsTheme = isPlainObject(theme) ? theme : {};
	const chromeDark = isChromeDark(safeTheme);
	const editorDark = isEditorDark(safeTheme);
	const base = editorDark ? builtIn.dark! : builtIn.light!;
	// Filter theme.colors through validColor() BEFORE merging onto base.colors so invalid/empty/
	// "transparent"/"rgb(...)" keys in imported themes cleanly fall back to base.colors instead
	// of leaving stale CSS custom properties or passing bad foregrounds to vscode-textmate.
	const validThemeColors: Record<string, string> = {};
	if (isPlainObject(safeTheme.colors)) {
		for (const [key, value] of Object.entries(safeTheme.colors)) {
			if (validColor(value)) validThemeColors[key] = value;
		}
	}
	const themed: Record<string, string> = { ...base.colors, ...validThemeColors };
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
		"editorWidget.background": themed["editorWidget.background"] ?? themed["sideBar.background"],
		"editorWidget.foreground": themed["editorWidget.foreground"] ?? themed["sideBar.foreground"] ?? themed["editor.foreground"],
		"editorWidget.border": themed["editorWidget.border"] ?? themed["input.border"] ?? themed["sideBar.border"],
		"editorSuggestWidget.background": themed["editorSuggestWidget.background"] ?? themed["editorWidget.background"] ?? themed["sideBar.background"],
		"editorSuggestWidget.foreground": themed["editorSuggestWidget.foreground"] ?? themed["sideBar.foreground"] ?? themed["editor.foreground"],
		"editorSuggestWidget.border": themed["editorSuggestWidget.border"] ?? themed["input.border"] ?? themed["sideBar.border"],
		"editorSuggestWidget.selectedBackground": themed["editorSuggestWidget.selectedBackground"] ?? themed["list.activeSelectionBackground"],
		"editorSuggestWidget.selectedForeground": themed["editorSuggestWidget.selectedForeground"] ?? themed["tab.activeForeground"] ?? themed["editor.foreground"],
		"editorSuggestWidget.highlightForeground": themed["editorSuggestWidget.highlightForeground"] ?? themed["focusBorder"],
		"editorSuggestWidget.focusHighlightForeground": themed["editorSuggestWidget.focusHighlightForeground"] ?? themed["focusBorder"],
		"editorHoverWidget.background": themed["editorHoverWidget.background"] ?? themed["editorWidget.background"] ?? themed["sideBar.background"],
		"editorHoverWidget.foreground": themed["editorHoverWidget.foreground"] ?? themed["sideBar.foreground"] ?? themed["editor.foreground"],
		"editorHoverWidget.border": themed["editorHoverWidget.border"] ?? themed["input.border"] ?? themed["sideBar.border"],
	};
	const tokenColors = sanitizeTokenColors(safeTheme.tokenColors);
	const sanitizedTheme: VsTheme = {
		...safeTheme,
		tokenColors,
		semanticTokenColors: sanitizeSemanticTokenColors(safeTheme.semanticTokenColors),
	};
	const raw: IRawTheme = {
		name: typeof safeTheme.name === "string" ? safeTheme.name : undefined,
		settings: [
			{ settings: { foreground: colors["editor.foreground"], background: colors["editor.background"] } },
			...(tokenColors as IRawTheme["settings"]),
		],
	};
	const rules = applyTokenTheme(raw);
	monaco.editor.defineTheme("studio", {
		base: editorDark ? "vs-dark" : "vs",
		inherit: true,
		rules: [...rules, ...semanticRules(sanitizedTheme)],
		colors: Object.fromEntries(Object.entries(colors).filter(([, v]) => validColor(v))),
	});
	monaco.editor.setTheme("studio");
	carryMenuColours();
	// The editor may write its colours a moment after the theme is set: carried again then.
	if (typeof requestAnimationFrame === "function") {
		menuColoursRaf = requestAnimationFrame(() => {
			menuColoursRaf = 0;
			carryMenuColours();
		});
	}
	refreshSemanticTokens();

	const root = document.documentElement;
	const setVar = (name: string, value: string | undefined) => {
		if (validColor(value)) root.style.setProperty(name, value);
	};

	const studioMap = isPlainObject(safeTheme.studio) ? studioVars(safeTheme.studio as StudioTokens) : null;
	if (studioMap && Object.values(studioMap).every(validColor)) {
		for (const [cssVar, value] of Object.entries(studioMap)) setVar(cssVar, value);
	} else {
		const get = (key: string) => colors[key] ?? base.colors![key]!;
		const accent = get("focusBorder");
		const accentFg = pickAccentFg(accent);
		for (const [cssVar, key] of CSS_VARS) setVar(cssVar, get(key));
		// Classic and imported VS Code themes populate the decoupled Folio Bento
		// and editor-scoped variables from their own workbench keys.
		setVar("--accent-fg", accentFg);
		setVar("--chrome-muted", get("descriptionForeground"));
		setVar("--tray-bg", get("statusBar.background"));
		setVar("--cmd-bg", get("input.background"));
		setVar("--strong-fg", get("tab.activeForeground"));
		setVar("--editor-bg", get("editor.background"));
		setVar("--editor-fg", get("editor.foreground"));
		setVar("--editor-strong", get("tab.activeForeground"));
		setVar("--editor-muted", get("descriptionForeground"));
		setVar("--editor-accent", accent);
		setVar("--editor-accent-fg", accentFg);
		setVar("--editor-border", get("sideBar.border"));
		setVar("--editor-input-border", get("input.border"));
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
				const parsed: unknown = parseJsonc(file.json);
				if (isPlainObject(parsed)) {
					// Strip untrusted internal fields so imported themes never bypass CSS_VARS
					// or leave stale custom properties behind.
					const { studio: _studio, chromeDark: _chromeDark, editorDark: _editorDark, ...safe } = parsed;
					return safe as VsTheme;
				}
			} catch {
				// Fall through to the default OKLCH theme.
			}
		}
	}
	const parsed = parseOklchThemeId(choice);
	if (parsed) return generateOklchTheme(parsed.tone, parsed.material);
	if (choice === "dark" || choice === "light") return builtIn[choice]!;
	const mat = isThemeMaterial(material) ? material : DEFAULT_MATERIAL;
	const preferDark =
		systemDark !== undefined
			? systemDark
			: typeof matchMedia === "function"
				? !matchMedia("(prefers-color-scheme: light)").matches
				: true;
	return generateOklchTheme(preferDark ? DEFAULT_DARK_TONE : DEFAULT_LIGHT_TONE, mat);
}
