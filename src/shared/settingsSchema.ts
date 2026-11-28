// Single declarative registry of user-facing SSL Studio settings, categories,
// scope metadata, and VS Code-style `@modified` / `@user` / `@workspace` query
// filtering (ADR 0053).
import { DEFAULT_CSV_TABLE_CONFIG } from "./csvFormat";
import { DEFAULT_SQL_DIALECT } from "./format";
import { RULER_MARGIN } from "./houseStyle";
import { DEFAULT_MATERIAL } from "./oklchTheme";
import { DEFAULT_SETTINGS, type Settings, type SettingsScope } from "./protocol";

export type SettingsCategoryId = "appearance" | "editor" | "markdown" | "ssl" | "agent" | "storage" | "keyboard";

export type SettingsCategoryInfo = {
	id: SettingsCategoryId;
	label: string;
	description: string;
};

export const SETTINGS_CATEGORIES: readonly SettingsCategoryInfo[] = [
	{ id: "appearance", label: "Appearance", description: "Theme, material tone, interface scale, fonts, and menu bar" },
	{ id: "editor", label: "Editor", description: "Formatting, SQL dialect, minimap, wrapping, rulers, and CSV tables" },
	{ id: "markdown", label: "Markdown & Docs", description: "Live Preview, reading highlight, attachments, and templates" },
	{ id: "ssl", label: "SSL & Language Server", description: "starlims-lsp binary path and style profile" },
	{ id: "agent", label: "Agent & AI", description: "Default model, local models, opencode server, skills, and MCP" },
	{ id: "storage", label: "History & Limits", description: "House-style script limits and SQLite local history storage" },
	{ id: "keyboard", label: "Keyboard Shortcuts", description: "Global shell, code editor, and Markdown keybindings" },
];

/** Settings that may only be stored in User scope for security (mirrors `USER_ONLY_SETTINGS` in `src/bun/settings.ts`). */
export const USER_ONLY_SETTING_KEYS: ReadonlySet<keyof Settings> = new Set<keyof Settings>([
	"lspPath",
	"agentServerUrl",
	"agentServerConfig",
	"agentOwnModels",
	"agentModel",
	"keys",
	"editorKeys",
	"markdownKeys",
]);

export type SettingMeta = {
	key: keyof Settings;
	category: SettingsCategoryId;
	label: string;
	description: string;
	scope: "any" | "user";
	keywords?: readonly string[];
	userOnlyReason?: string;
};

export const SETTINGS_SCHEMA: readonly SettingMeta[] = [
	// Appearance
	{ key: "theme", category: "appearance", label: "Theme", description: "Warm Material OKLCH tones, Classic presets, or an imported VS Code theme", scope: "any", keywords: ["color", "dark", "light", "paper", "slate", "material", "oklch"] },
	{ key: "uiScale", category: "appearance", label: "Interface size", description: "The whole window, from 80% to 160%", scope: "any", keywords: ["zoom", "scale", "dpi"] },
	{ key: "fontSize", category: "appearance", label: "Font size", description: "The editor, Blocks, diffs and rendered documents", scope: "any", keywords: ["text", "size", "px"] },
	{ key: "uiFont", category: "appearance", label: "Interface font", description: "Chrome, tabs and panels; empty uses the system sans-serif", scope: "any", keywords: ["font", "family", "sans"] },
	{ key: "codeFont", category: "appearance", label: "Code font", description: "Editor, Blocks, Tables and Output; empty uses the system monospace", scope: "any", keywords: ["font", "monospace", "family"] },
	{ key: "readFont", category: "appearance", label: "Reading font", description: "Optional face for rendered Markdown Read view; empty matches the interface font", scope: "any", keywords: ["font", "serif", "markdown"] },
	{ key: "menuBar", category: "appearance", label: "Menu bar", description: "File, Edit, Selection, View, Go and Help across the top of the window", scope: "any", keywords: ["chrome", "top", "bar"] },

	// Editor
	{ key: "formatOnSave", category: "editor", label: "Format changed lines on save", description: "Only the lines changed since the last save", scope: "any", keywords: ["format", "save", "prettier"] },
	{ key: "sqlDialect", category: "editor", label: "SQL dialect", description: "Database dialect used when formatting standalone .sql files (T-SQL for SQL Server, PL/SQL for Oracle)", scope: "any", keywords: ["sql", "tsql", "plsql", "oracle", "mssql"] },
	{ key: "minimap", category: "editor", label: "Minimap", description: "The outline of the file at the editor's edge; a narrow editor goes without", scope: "any", keywords: ["overview", "scrollbar"] },
	{ key: "wordWrap", category: "editor", label: "Word wrap", description: "Long lines wrapped at the editor's edge, not scrolled to; Alt+Z switches it", scope: "any", keywords: ["wrap", "lines"] },
	{ key: "inlayHints", category: "editor", label: "Parameter name hints", description: "Names shown beside the arguments of a call", scope: "any", keywords: ["hints", "inlay", "parameters"] },
	{ key: "indentOnType", category: "editor", label: "Indent as the formatter does", description: "A new line of a script, and a statement as its ; is typed, are indented as the language server's formatter indents them", scope: "any", keywords: ["indent", "autoindent", "ssl"] },
	{ key: "ctrlClickAddsCursor", category: "editor", label: "Ctrl+click adds a cursor", description: "As in Sublime Text, and Alt+click goes to a definition. Off: the other way round, as in VS Code", scope: "any", keywords: ["multicursor", "sublime", "definition", "click"] },
	{ key: "rulers", category: "editor", label: "Ruler at the line length", description: "A line down the editor at the style profile's line length", scope: "any", keywords: ["column", "line length", "guide"] },
	{ key: "rulerMargin", category: "editor", label: "Rulers beside it", description: "Fainter rulers this many columns before and after; 0 for none", scope: "any", keywords: ["column", "margin", "guide"] },
	{ key: "csvTable", category: "editor", label: "CSV column badges", description: "Format configured CSV columns (such as status) as colored badges; customize rules from any CSV table's Format button", scope: "any", keywords: ["csv", "tsv", "table", "badges", "registry"] },

	// Markdown & Docs
	{ key: "livePreview", category: "markdown", label: "Markdown live preview", description: "A document drawn as it is written: headings larger, the markup hidden except on the line being written", scope: "any", keywords: ["markdown", "obsidian", "codemirror", "live"] },
	{ key: "markdownReadingHighlight", category: "markdown", label: "Markdown reading highlight", description: "Subtly dim lines below the active cursor (or mouse pointer when reading) in Markdown Live and Read views", scope: "any", keywords: ["markdown", "focus", "dim", "reading"] },
	{ key: "attachmentsFolder", category: "markdown", label: "Attachments folder", description: "Workspace folder where pasted or dropped Markdown images are saved; empty uses ticket folder or docs/attachments", scope: "any", keywords: ["images", "paste", "drop", "folder"] },
	{ key: "templatesFolder", category: "markdown", label: "Templates folder", description: "Workspace folder for custom Markdown templates; empty uses docs/templates", scope: "any", keywords: ["templater", "templates", "folder"] },

	// SSL & Language Server
	{ key: "lspPath", category: "ssl", label: "Language server program", description: "Leave empty to have it found automatically", scope: "user", keywords: ["starlims-lsp", "binary", "path", "executable"], userOnlyReason: "Executable paths can only be configured in User settings." },
	{ key: "stylePreset", category: "ssl", label: "Style profile preset", description: "Base ruleset for SSL formatting and diagnostics: House style or language server defaults", scope: "any", keywords: ["ssl", "house", "server", "formatter", "lint"] },

	// Agent & AI
	{ key: "agentModel", category: "agent", label: "Default agent model", description: "Model reference (providerID/modelID) used for new Agent sessions; local models need no cost confirmation", scope: "user", keywords: ["ai", "llm", "ollama", "opencode", "model"], userOnlyReason: "Billing and default model trust can only be configured in User settings." },
	{ key: "agentOwnModels", category: "agent", label: "Self-hosted models", description: "Comma-separated providerID/modelID entries running on your own infrastructure (treated as local with no cost prompt)", scope: "user", keywords: ["ai", "local", "self-hosted", "billing", "models"], userOnlyReason: "Self-hosted billing exemptions can only be configured in User settings." },
	{ key: "agentServerUrl", category: "agent", label: "External opencode server URL", description: "Optional http://127.0.0.1:... or https://... URL to attach to an existing opencode server instead of spawning a private one", scope: "user", keywords: ["opencode", "remote", "server", "url"], userOnlyReason: "Remote server URLs can only be configured in User settings." },
	{ key: "agentServerConfig", category: "agent", label: "Private opencode JSON config", description: "Optional JSON passed as OPENCODE_CONFIG_CONTENT to SSL Studio's private opencode server (never modifies global opencode config)", scope: "user", keywords: ["opencode", "json", "provider", "config"], userOnlyReason: "Server process configuration can only be configured in User settings." },

	// History & Limits
	{ key: "limits", category: "storage", label: "House-style script limits", description: "Advisory thresholds for script bytes, code lines, and changelog history entries shown in Status Bar and Health", scope: "any", keywords: ["bytes", "lines", "history", "limits", "sqlite", "storage"] },
];

export const SETTINGS_SCHEMA_MAP: ReadonlyMap<keyof Settings, SettingMeta> = new Map(SETTINGS_SCHEMA.map((m) => [m.key, m]));

export type ParsedSettingsQuery = {
	raw: string;
	text: string;
	modifiedOnly: boolean;
	scopeFilter: SettingsScope | null;
	userOnly: boolean;
};

/** Parses VS Code-style search tokens (`@modified`, `@user`, `@workspace`, `@userOnly` / `@security`) alongside free text. */
export function parseSettingsQuery(raw: string): ParsedSettingsQuery {
	const trimmed = raw.trim();
	if (!trimmed) return { raw, text: "", modifiedOnly: false, scopeFilter: null, userOnly: false };
	let modifiedOnly = false;
	let scopeFilter: SettingsScope | null = null;
	let userOnly = false;
	const words: string[] = [];
	for (const part of trimmed.split(/\s+/)) {
		const low = part.toLowerCase();
		if (low === "@modified") modifiedOnly = true;
		else if (low === "@user") scopeFilter = "user";
		else if (low === "@workspace") scopeFilter = "workspace";
		else if (low === "@security" || low === "@useronly" || low === "@tag:useronly") userOnly = true;
		else words.push(part);
	}
	return { raw, text: words.join(" "), modifiedOnly, scopeFilter, userOnly };
}

/** Structural value equality for primitives, arrays, and plain objects. */
export function settingValueEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => settingValueEqual(item, b[i]));
	}
	if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
		const ka = Object.keys(a as Record<string, unknown>);
		const kb = Object.keys(b as Record<string, unknown>);
		if (ka.length !== kb.length) return false;
		return ka.every((k) => Object.hasOwn(b as object, k) && settingValueEqual((a as any)[k], (b as any)[k]));
	}
	return false;
}

/** Canonical default value for a setting key, including implicit boolean/string defaults. */
export function defaultValueForSetting(key: keyof Settings): unknown {
	switch (key) {
		case "themeMaterial":
			return DEFAULT_MATERIAL;
		case "uiFont":
		case "codeFont":
		case "readFont":
		case "attachmentsFolder":
		case "templatesFolder":
		case "lspPath":
		case "agentModel":
		case "agentServerUrl":
		case "agentServerConfig":
		case "activeTicket":
			return "";
		case "uiScale":
			return 1;
		case "menuBar":
		case "livePreview":
		case "markdownReadingHighlight":
		case "inlayHints":
		case "indentOnType":
		case "ctrlClickAddsCursor":
		case "rulers":
			return true;
		case "wordWrap":
			return false;
		case "rulerMargin":
			return RULER_MARGIN;
		case "sqlDialect":
			return DEFAULT_SQL_DIALECT;
		case "csvTable":
			return DEFAULT_CSV_TABLE_CONFIG;
		case "agentOwnModels":
			return [];
		default:
			return DEFAULT_SETTINGS[key];
	}
}

export type SettingsLayers = { user: Partial<Settings>; workspace: Partial<Settings> };

/** True when `key` is explicitly set in `scope`'s settings layer (or for `theme`, also considers `themeMaterial`). */
export function isSettingDefinedInScope(key: keyof Settings, layers: SettingsLayers, scope: SettingsScope): boolean {
	const layer = layers[scope];
	if (!layer) return false;
	if (key === "theme") {
		return (
			(layer.theme !== undefined && !settingValueEqual(layer.theme, defaultValueForSetting("theme"))) ||
			(layer.themeMaterial !== undefined && !settingValueEqual(layer.themeMaterial, defaultValueForSetting("themeMaterial")))
		);
	}
	const val = layer[key];
	if (val === undefined) return false;
	if (scope === "workspace") return true;
	return !settingValueEqual(val, defaultValueForSetting(key));
}

/** True when `key` is modified in either layer (or in the specified `scope` when provided). */
export function isSettingModified(key: keyof Settings, layers: SettingsLayers, scope?: SettingsScope): boolean {
	if (scope) return isSettingDefinedInScope(key, layers, scope);
	return isSettingDefinedInScope(key, layers, "user") || isSettingDefinedInScope(key, layers, "workspace");
}

/** Counts visible schema settings modified in `scope` (plus customized keybinding overrides for User scope). */
export function countModifiedSettings(layers: SettingsLayers, scope: SettingsScope): number {
	let count = 0;
	for (const meta of SETTINGS_SCHEMA) {
		if (scope === "workspace" && meta.scope === "user") continue;
		if (isSettingDefinedInScope(meta.key, layers, scope)) count++;
	}
	if (scope === "user") {
		count += Object.keys(layers.user.keys ?? {}).length;
		count += Object.keys(layers.user.editorKeys ?? {}).length;
		count += Object.keys(layers.user.markdownKeys ?? {}).length;
	}
	return count;
}

/** VS Code-style scope override annotation shown beside a setting row. */
export function settingScopeNote(
	key: keyof Settings,
	layers: SettingsLayers,
	activeScope: SettingsScope,
	hasWorkspace: boolean,
): { text: string; tone: "muted" | "accent" | "lock" } | null {
	const meta = SETTINGS_SCHEMA_MAP.get(key);
	if (USER_ONLY_SETTING_KEYS.has(key) && activeScope === "workspace") {
		return {
			text: meta?.userOnlyReason ?? "User setting only — cannot be overridden by a workspace file.",
			tone: "lock",
		};
	}
	const inUser = isSettingDefinedInScope(key, layers, "user");
	const inWs = hasWorkspace && isSettingDefinedInScope(key, layers, "workspace");
	if (activeScope === "user" && inWs) {
		return { text: "Also modified in Workspace", tone: "accent" };
	}
	if (activeScope === "workspace" && inWs) {
		return { text: inUser ? "Overrides User setting" : "Modified in Workspace", tone: "accent" };
	}
	if (activeScope === "workspace" && inUser) {
		return { text: "Inherited from User", tone: "muted" };
	}
	if (activeScope === "user" && inUser) {
		return { text: "Modified in User", tone: "accent" };
	}
	return null;
}

/** Whether a schema setting matches the parsed query and active scope filters. */
export function settingMatchesQuery(
	meta: SettingMeta,
	parsed: ParsedSettingsQuery,
	layers: SettingsLayers,
	activeScope: SettingsScope,
	matchText: (query: string, haystack: string) => number,
): boolean {
	if (parsed.userOnly && meta.scope !== "user") return false;
	if (parsed.scopeFilter === "workspace" && !isSettingDefinedInScope(meta.key, layers, "workspace")) return false;
	if (parsed.scopeFilter === "user" && !isSettingDefinedInScope(meta.key, layers, "user")) return false;
	if (parsed.modifiedOnly && !isSettingModified(meta.key, layers, activeScope)) return false;
	if (!parsed.text) return true;
	const cat = SETTINGS_CATEGORIES.find((c) => c.id === meta.category)?.label ?? meta.category;
	const hay = [cat, meta.label, meta.description, meta.key, ...(meta.keywords ?? [])].join(" ");
	return matchText(parsed.text, hay) > 0;
}
