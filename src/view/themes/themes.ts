// Themes are VS Code colour theme files. Token colours go through the
// grammar's TextMate scopes (editor/textmate.ts); a few workbench colours
// become CSS variables for the panels, tabs and status bar.
import type { IRawTheme } from "vscode-textmate";
import { monaco } from "../editor/monaco";
import { refreshSemanticTokens, semanticRules } from "../editor/semantic";
import { applyTokenTheme } from "../editor/textmate";
import { parseJsonc } from "../../shared/jsonc";
import dark from "./studio-dark.json";
import light from "./studio-light.json";

export type VsTheme = {
	name?: string;
	type?: "dark" | "light" | "hc" | "hcLight";
	colors?: Record<string, string>;
	semanticHighlighting?: boolean;
	semanticTokenColors?: Record<string, string | { foreground?: string; fontStyle?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean }>;
	tokenColors?: { name?: string; scope?: string | string[]; settings: { foreground?: string; background?: string; fontStyle?: string } }[];
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

const isDark = (theme: VsTheme) => theme.type !== "light" && theme.type !== "hcLight";
const validColor = (value: unknown): value is string => typeof value === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);

/**
 * The editor draws its right-click menu in a tree of its own, attached to the
 * page outside the editor, and declares the theme's colours on the editor: so
 * the menu found none of them and had no background. A tree inherits the
 * variables of the element that holds it, so the same declarations are given
 * to that element.
 */
/** The shape of the app's own menus (style.css, .menu-pop and .menu-item), for the editor's menu in its own tree. */
const MENU_SHAPE = `
.monaco-menu-container { border-radius: var(--radius-lg) !important; box-shadow: var(--shadow) !important; overflow: hidden; }
.monaco-menu { font: var(--text-base)/1.4 system-ui, -apple-system, "Segoe UI", sans-serif !important; }
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

function carryMenuColours() {
	const declared = [...document.querySelectorAll("style.monaco-colors")].map((style) => style.textContent ?? "").join("\n");
	const block = /\{([^{}]*--vscode-menu-background[^{}]*)\}/.exec(declared)?.[1];
	if (!block) return;
	let style = document.getElementById("studio-menu-colours");
	if (!style) {
		style = document.createElement("style");
		style.id = "studio-menu-colours";
		document.head.append(style);
	}
	style.textContent = `.shadow-root-host { ${block} }`;
}

export function applyTheme(theme: VsTheme) {
	const base = isDark(theme) ? builtIn.dark! : builtIn.light!;
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
		base: isDark(theme) ? "vs-dark" : "vs",
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
	for (const [cssVar, key] of CSS_VARS) {
		const value = colors[key] ?? base.colors![key];
		if (validColor(value)) root.style.setProperty(cssVar, value);
	}
	root.dataset.theme = isDark(theme) ? "dark" : "light";
	root.style.colorScheme = isDark(theme) ? "dark" : "light";
}

/**
 * Resolves a settings value ("system", "dark", "light", "custom:<id>").
 * `systemDark` is the system's own answer where the app could ask it; without
 * one, "system" is what the web view says it prefers.
 */
export function resolveTheme(choice: string, custom: { id: string; json: string }[], systemDark?: boolean): VsTheme {
	if (choice.startsWith("custom:")) {
		const file = custom.find((t) => t.id === choice);
		if (file) {
			try {
				return parseJsonc(file.json);
			} catch {
				// Fall through to the system theme.
			}
		}
	}
	if (choice === "dark" || choice === "light") return builtIn[choice]!;
	if (systemDark !== undefined) return systemDark ? builtIn.dark! : builtIn.light!;
	return matchMedia("(prefers-color-scheme: light)").matches ? builtIn.light! : builtIn.dark!;
}
