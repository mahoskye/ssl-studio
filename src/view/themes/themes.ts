// Themes are VS Code colour theme files. Token colours go through the
// grammar's TextMate scopes (editor/textmate.ts); a few workbench colours
// become CSS variables for the panels, tabs and status bar.
import type { IRawTheme } from "vscode-textmate";
import { monaco } from "../editor/monaco";
import { applyTokenTheme } from "../editor/textmate";
import { parseJsonc } from "../../shared/jsonc";
import dark from "./studio-dark.json";
import light from "./studio-light.json";

export type VsTheme = {
	name?: string;
	type?: "dark" | "light" | "hc" | "hcLight";
	colors?: Record<string, string>;
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
];

const isDark = (theme: VsTheme) => theme.type !== "light" && theme.type !== "hcLight";
const validColor = (value: unknown): value is string => typeof value === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);

export function applyTheme(theme: VsTheme) {
	const base = isDark(theme) ? builtIn.dark! : builtIn.light!;
	const colors = { ...base.colors, ...theme.colors };
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
		rules,
		colors: Object.fromEntries(Object.entries(colors).filter(([, v]) => validColor(v))),
	});
	monaco.editor.setTheme("studio");
	const root = document.documentElement;
	for (const [cssVar, key] of CSS_VARS) {
		const value = colors[key] ?? base.colors![key];
		if (validColor(value)) root.style.setProperty(cssVar, value);
	}
	root.dataset.theme = isDark(theme) ? "dark" : "light";
	root.style.colorScheme = isDark(theme) ? "dark" : "light";
}

/** Resolves a settings value ("system", "dark", "light", "custom:<id>"). */
export function resolveTheme(choice: string, custom: { id: string; json: string }[]): VsTheme {
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
	return matchMedia("(prefers-color-scheme: light)").matches ? builtIn.light! : builtIn.dark!;
}
