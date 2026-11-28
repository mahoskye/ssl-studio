// Settings Editor (ADR 0053): VS Code-style searchable settings workspace with
// explicit User | Workspace scope tabs, left category TOC, `@modified` filtering,
// per-setting modified gutter + Reset, Open Settings (JSON) toggle, unified
// Keyboard Shortcuts table, and seamless center-tab + Welcome-modal hosting.
import { Icon } from "./Icon";
import { Menu, type MenuItem } from "./Menu";
import { cloneCsvTableConfig, DEFAULT_CSV_TABLE_CONFIG, effectiveCsvTableConfig } from "../shared/csvFormat";
import { DEFAULT_SQL_DIALECT, SQL_DIALECTS, type SqlDialect } from "../shared/format";
import { CODE_FONT_PRESETS, READ_FONT_PRESETS, UI_FONT_PRESETS, type FontPreset } from "../shared/fonts";
import { RULER_MARGIN } from "../shared/houseStyle";
import {
	DEFAULT_DARK_TONE,
	DEFAULT_MATERIAL,
	isThemeMaterial,
	MATERIAL_INFO,
	MATERIALS,
	oklchThemeId,
	parseOklchThemeId,
	TONE_INFO,
	TONES,
	type ThemeMaterial,
	type ThemeTone,
} from "../shared/oklchTheme";
import {
	countModifiedSettings,
	isSettingDefinedInScope,
	parseSettingsQuery,
	SETTINGS_CATEGORIES,
	SETTINGS_SCHEMA,
	SETTINGS_SCHEMA_MAP,
	settingMatchesQuery,
	settingScopeNote,
	USER_ONLY_SETTING_KEYS,
	type SettingsCategoryId,
	type SettingsLayers,
} from "../shared/settingsSchema";
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
	EDITOR_COMMANDS,
	editorCommandLabel,
	editorKeyCode,
	isEditorCommand,
	MARKDOWN_COMMANDS,
	MARKDOWN_KEYS,
	markdownCommandLabel,
	pressesOf,
} from "../shared/editorKeymap";
import { startsEditorChord } from "../shared/menuBar";
import { isInside, resolvePath } from "../shared/paths";
import type { Settings, SettingsPatch, SettingsScope } from "../shared/protocol";
import { backend, inApp } from "./backend";
import { commands, DEFAULT_KEYS, keymap, keysFor, onOpenSettings, openCustomizations } from "./commands";
import { choose } from "./dialogs";
import { closeComparison } from "./editor/Review";
import {
	baseEditorKeys,
	displayEditorKey,
	editorKeyChanges,
	editorKeysNow,
	editorKeysOf,
	editorTakesKey,
	markdownKeyChanges,
	markdownKeysNow,
} from "./editor/editorKeys";
import { bindable, conflict, displayKey, isModifierKey, keyNamesForPlatform, keysOf, rebind, sharedKeyName, unbind } from "./keys";
import { Modal } from "./modal";
import { matchWords } from "./quickRank";
import { AgentSettingsSection } from "./settings/AgentSettingsSection";
import { SettingsJsonEditor } from "./settings/SettingsJsonEditor";
import { StorageLimitsSection } from "./settings/StorageLimitsSection";
import { loadSettings, notify, restartLsp, saveSetting, setState, state, syncLivePreviewMode } from "./state";
import { openStyleProfile } from "./StyleProfile";
import { clampScale, stepScale, UI_SCALE } from "./uiScale";

type NavCategory = "all" | SettingsCategoryId;
type ShortcutContextFilter = "all" | "global" | "editor" | "markdown" | "modified";

/** What a row of Markdown's keys is recorded under: its commands are the shell's too, and have a row in that list. */
const MARKDOWN_ROW = "markdown-key:";

const FONT = { min: 8, max: 32, normal: 13 };
const onMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

// Shared view state so SettingsDialog (modal fallback when no workspace is open) and SettingsView (center tab) stay in sync.
const [modalOpen, setModalOpen] = createSignal(false);
const [settingsQuery, setSettingsQuery] = createSignal("");
const [activeScope, setActiveScope] = createSignal<SettingsScope>("user");
const [activeCategory, setActiveCategory] = createSignal<NavCategory>("all");
const [jsonMode, setJsonMode] = createSignal(false);
const [layers, setLayers] = createSignal<SettingsLayers>({ user: {}, workspace: {} });
const [layersNonce, setLayersNonce] = createSignal(0);

function refreshLayers() {
	return backend.settings().then(
		(s) => {
			setLayers({ user: s.user, workspace: s.workspace });
			setLayersNonce((n) => n + 1);
		},
		() => {},
	);
}

/** Clamps a numeric setting cleanly; empty or non-finite input falls back to `fallback`, while finite `0` clamps to `min`. */
export function clampNumericSetting(raw: string, min: number, max: number, fallback: number): number {
	const trimmed = raw.trim();
	if (!trimmed) return fallback;
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Validates a workspace-relative folder setting (`attachmentsFolder`, `templatesFolder`), rejecting absolute paths and `..` escapes. */
export function validateWorkspaceFolderSetting(raw: string): { ok: true; value: string | null } | { ok: false; error: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: true, value: null };
	if (/[\x00-\x1f\x7f]/.test(trimmed)) {
		return { ok: false, error: "Folder path cannot contain control characters." };
	}
	if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[a-zA-Z]:/.test(trimmed)) {
		return { ok: false, error: "Folder path must be relative to the workspace root (not an absolute path)." };
	}
	let depth = 0;
	for (const part of trimmed.split(/[\\/]/)) {
		if (!part || part === ".") continue;
		if (part === "..") {
			depth--;
			if (depth < 0) {
				return { ok: false, error: "Folder path cannot use “..” to escape the workspace folder." };
			}
		} else {
			depth++;
		}
	}
	const probeRoot = "/__ws_root__";
	const resolved = resolvePath(probeRoot, trimmed);
	if (!isInside(probeRoot, resolved)) {
		return { ok: false, error: "Folder path must stay inside the workspace folder." };
	}
	return { ok: true, value: trimmed };
}

const commitOnEnter = (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
	if (e.isComposing || e.keyCode === 229) return;
	if (e.key === "Enter") {
		e.preventDefault();
		e.currentTarget.blur();
	}
};

function DraftInput(props: {
	id?: string;
	"aria-label"?: string;
	"aria-describedby"?: string;
	type?: string;
	min?: number | string;
	max?: number | string;
	disabled?: boolean;
	autocomplete?: string;
	spellcheck?: boolean | "false" | "true";
	placeholder?: string;
	value: string;
	onKeyDown?: (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => void;
	onCommit: (value: string, el: HTMLInputElement) => Promise<string | false | void> | string | false | void;
}) {
	const committed = createMemo(() => props.value);
	const [draft, setDraft] = createSignal(untrack(committed));
	let seq = 0;
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	createEffect(committed, (v) => {
		setDraft(v);
	});
	return (
		<input
			id={props.id}
			aria-label={props["aria-label"]}
			aria-describedby={props["aria-describedby"]}
			type={props.type}
			min={props.min}
			max={props.max}
			disabled={props.disabled}
			autocomplete={props.autocomplete}
			spellcheck={props.spellcheck}
			placeholder={props.placeholder}
			value={draft()}
			onKeyDown={props.onKeyDown}
			onInput={(e) => {
				seq++;
				// A number field that cannot read what is typed so far ("14e", "-") reports an empty value. Mirrored
				// into the draft, the binding wrote that empty value back and wiped the typing: the draft waits for
				// something the field can read.
				if (e.currentTarget.validity.badInput) return;
				setDraft(e.currentTarget.value);
			}}
			onChange={(e) => {
				const el = e.currentTarget;
				const mySeq = ++seq;
				const apply = (result: string | false | void) => {
					if (disposed || seq !== mySeq) return;
					const next = result === false ? untrack(committed) : typeof result === "string" ? result : undefined;
					if (next !== undefined) {
						setDraft(next);
						if (el.value !== next) el.value = next;
					}
				};
				// Left unreadable: back to what is saved, not read as empty (and so saved as the default).
				if (el.validity.badInput) {
					apply(false);
					return;
				}
				const res = props.onCommit(el.value, el);
				if (res !== null && typeof res === "object") {
					void res.then(apply, () => apply(false));
				} else {
					apply(res);
				}
			}}
		/>
	);
}

type ShortcutRow = {
	rowId: string;
	commandId: string;
	label: string;
	context: "Global" | "Code Editor" | "Markdown";
	contextKey: "global" | "editor" | "markdown";
	keysText: string;
	modified: boolean;
};

/** Full VS Code-style Settings Editor body (hosted inside CenterTabStrip when a workspace is open, or inside Modal on Welcome). */
function SettingsWorkspace(props: { embedded: boolean; onClose?: () => void }) {
	const [capturing, setCapturing] = createSignal<string | null>(null);
	const [refused, setRefused] = createSignal("");
	const [chord, setChord] = createSignal<{ id: string; first: string } | null>(null);
	const [keyContextFilter, setKeyContextFilter] = createSignal<ShortcutContextFilter>("all");
	const chordFirst = () => (chord() && chord()!.id === capturing() ? chord()!.first : "");

	// Reset workspace scope back to User when no workspace is open.
	createEffect(
		() => !state.workspace && activeScope() === "workspace",
		(reset) => {
			if (reset) setActiveScope("user");
		},
	);

	// Reload layers whenever workspace changes or the Settings tab opens.
	createEffect(
		() => [state.workspace?.root ?? "", state.centerView === "settings" || modalOpen()] as const,
		([, visible]) => {
			if (visible) void refreshLayers();
		},
	);

	const scopeOf = (key: keyof Settings): SettingsScope => {
		if (USER_ONLY_SETTING_KEYS.has(key)) return "user";
		if (!state.workspace) return "user";
		return activeScope();
	};

	const save = async <K extends keyof Settings>(key: K, value: Settings[K] | null): Promise<boolean> => {
		const saved = Boolean(await saveSetting({ [key]: value } as SettingsPatch, scopeOf(key)));
		await refreshLayers();
		if (key === "lspPath" && saved) await restartLsp();
		return saved;
	};

	const saveUserOnly = async <K extends keyof Settings>(key: K, value: Settings[K] | null): Promise<boolean> => {
		const saved = Boolean(await saveSetting({ [key]: value } as SettingsPatch, "user"));
		await refreshLayers();
		if (key === "lspPath" && saved) await restartLsp();
		return saved;
	};

	const saveRelFolder = (key: "attachmentsFolder" | "templatesFolder", input: HTMLInputElement): string | Promise<string | false> => {
		const check = validateWorkspaceFolderSetting(input.value);
		if (!check.ok) {
			notify(check.error, "error");
			const fallback = state.settings[key] ?? "";
			input.value = fallback;
			return fallback;
		}
		const next = check.value ?? "";
		input.value = next;
		return save(key, check.value).then((saved) => (saved ? next : false));
	};

	const parsedQuery = createMemo(() => parseSettingsQuery(settingsQuery()));

	const toggleQueryToken = (token: string) => {
		const current = settingsQuery().trim();
		const re = new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "i");
		if (re.test(current)) {
			setSettingsQuery(current.replace(re, " ").replace(/\s+/g, " ").trim());
		} else {
			setSettingsQuery(current ? `${token} ${current}` : token);
		}
	};

	const activeFilterChips = createMemo(() => {
		const pq = parsedQuery();
		const chips: { token: string; label: string }[] = [];
		if (pq.modifiedOnly) chips.push({ token: "@modified", label: "Modified" });
		if (pq.scopeFilter === "user") chips.push({ token: "@user", label: "User overrides" });
		if (pq.scopeFilter === "workspace") chips.push({ token: "@workspace", label: "Workspace overrides" });
		if (pq.userOnly) chips.push({ token: "@security", label: "User-only security" });
		return chips;
	});

	const visibleSchemaKeys = createMemo(() => {
		const pq = parsedQuery();
		const l = layers();
		const sc = activeScope();
		const set = new Set<keyof Settings>();
		for (const meta of SETTINGS_SCHEMA) {
			if (settingMatchesQuery(meta, pq, l, sc, matchWords)) set.add(meta.key);
		}
		return set;
	});

	// --- keyboard shortcuts ----------------------------------------------------

	const labelOf = (id: string) => commands.find((c) => c.id === id)?.label ?? id;
	const shellKeys = () => ({ map: keymap(), chosen: state.settings.keys ?? {} });
	const editorsOn = (key: string) => (editorTakesKey([key], shellKeys()) ? editorKeysNow()?.[key] : undefined);
	const inMarkdown = (command: string) => `While you edit a Markdown document it stays “${markdownCommandLabel(command)}”.`;

	const bind = async (id: string, key: string) => {
		const taken = conflict(key, id, keymap());
		const editors = editorsOn(key);
		const stays = Boolean(editors && editorKeyChanges()[key]);
		const name = displayKey(key);
		let question = "";
		let yes = "Replace";
		if (editors && stays) {
			question = `${name} is the editor's key for “${editorCommandLabel(editors)}”, as you set it, and stays that while you edit text. ${taken ? `Everywhere else it is the shortcut for “${labelOf(taken)}”. Use it for “${labelOf(id)}” there instead?` : `Use it for “${labelOf(id)}” everywhere else?`}`;
			if (!taken) yes = "Use elsewhere";
		} else if (editors) {
			question = `${name} is ${taken ? `the shortcut for “${labelOf(taken)}”, and ` : ""}the editor's key for “${editorCommandLabel(editors)}”. Use it for “${labelOf(id)}” instead, in the editor too?`;
		} else if (taken) {
			question = `${name} is the shortcut for “${labelOf(taken)}”. Use it for “${labelOf(id)}” instead?`;
		}
		const markdown = markdownKeysNow()[key];
		if (markdown && question) question += ` ${inMarkdown(markdown)}`;
		else if (markdown) {
			question = `${name} is Markdown's key for “${markdownCommandLabel(markdown)}”, and stays that while you edit a Markdown document. Use it for “${labelOf(id)}” everywhere else?`;
			yes = "Use elsewhere";
		}
		if (question && (await choose(question, [yes])) !== yes) return;
		await saveSetting({ keys: rebind(DEFAULT_KEYS, state.settings.keys ?? {}, id, key) });
		await refreshLayers();
	};

	const bindEditor = async (id: string, key: string) => {
		const base = baseEditorKeys();
		if (!base) return;
		const changes = editorKeyChanges();
		const taken = conflict(key, id, editorKeysNow() ?? {});
		const shells = pressesOf(key).length === 1 && !editorTakesKey([key], shellKeys()) ? keymap()[key] : undefined;
		const name = displayEditorKey(key);
		const mine = editorCommandLabel(id);
		let question = "";
		let yes = "Replace";
		if (taken && shells) {
			question = `${name} is the editor's key for “${editorCommandLabel(taken)}”, and the shortcut for “${labelOf(shells)}”. Use it for “${mine}” while you edit text? “${labelOf(shells)}” keeps it everywhere else.`;
		} else if (taken) {
			question = `${name} is the editor's key for “${editorCommandLabel(taken)}”. Use it for “${mine}” instead?`;
		} else if (shells) {
			question = `${name} is the shortcut for “${labelOf(shells)}”. Use it for “${mine}” while you edit text? “${labelOf(shells)}” keeps it everywhere else.`;
			yes = "Use in the editor";
		}
		const markdown = pressesOf(key).length === 1 ? markdownKeysNow()[key] : undefined;
		if (markdown && question) question += ` ${inMarkdown(markdown)}`;
		else if (markdown) {
			question = `${name} is Markdown's key for “${markdownCommandLabel(markdown)}”, and stays that while you edit a Markdown document. Use it for “${mine}” in other files?`;
			yes = "Use elsewhere";
		}
		if (question && (await choose(question, [yes])) !== yes) return;
		await saveSetting({ editorKeys: rebind(base, changes, id, key) });
		await refreshLayers();
	};

	const bindMarkdown = async (id: string, key: string) => {
		const taken = conflict(key, id, markdownKeysNow());
		const mine = markdownCommandLabel(id);
		const name = displayKey(key);
		const editors = editorsOn(key);
		const shells = editors ? undefined : keymap()[key];
		const elsewhere = editors ? `the editor's key for “${editorCommandLabel(editors)}”` : shells ? `the shortcut for “${labelOf(shells)}”` : "";
		let question = "";
		let yes = "Replace";
		if (taken) {
			question = `${name} is Markdown's key for “${markdownCommandLabel(taken)}”. Use it for “${mine}” instead?`;
		} else if (elsewhere) {
			question = `${name} is ${elsewhere}. Use it for “${mine}” while you edit a Markdown document? It keeps what it does everywhere else.`;
			yes = "Use in Markdown";
		}
		if (question && (await choose(question, [yes])) !== yes) return;
		await saveSetting({ markdownKeys: rebind(MARKDOWN_KEYS, markdownKeyChanges(), id, key) });
		await refreshLayers();
	};

	const handleCaptureKey = (e: KeyboardEvent): boolean => {
		const id = capturing();
		if (!id) return false;
		if (e.isComposing || e.keyCode === 229) return true;
		e.preventDefault();
		e.stopImmediatePropagation();
		if (isModifierKey(e.key)) return true;
		if (e.key === "Escape") {
			setCapturing(null);
			setChord(null);
			return true;
		}
		const names = keyNamesForPlatform(e, onMac);
		if (!names.length) {
			setRefused("On macOS, bare Ctrl+letter shortcuts are reserved for system text navigation. Use Cmd, Alt, or add Shift.");
			return true;
		}
		const key = names[0]!;
		if (isEditorCommand(id)) {
			const first = chordFirst();
			if (!first && startsEditorChord(names, onMac)) {
				setRefused("");
				setChord({ id, first: key });
				return true;
			}
			const check = first ? { ok: true as const } : bindable(key);
			if (!check.ok) {
				setRefused(check.why);
				return true;
			}
			if (!editorKeyCode(key)) {
				setRefused(`${displayKey(key)} cannot be one of the editor's keys: the editor has no name for that key.`);
				return true;
			}
			setRefused("");
			setCapturing(null);
			setChord(null);
			void bindEditor(id, first ? `${first} ${key}` : key);
			return true;
		}
		const forMarkdown = id.startsWith(MARKDOWN_ROW);
		const chosen = forMarkdown ? (sharedKeyName(e, onMac) ?? key) : key;
		const check = bindable(chosen);
		if (!check.ok) {
			setRefused(check.why);
			return true;
		}
		setRefused("");
		setCapturing(null);
		setChord(null);
		if (forMarkdown) void bindMarkdown(id.slice(MARKDOWN_ROW.length), chosen);
		else void bind(id, chosen);
		return true;
	};

	// Capture keyboard shortcuts cleanly in both CenterTabStrip mode and Welcome Modal mode.
	createEffect(
		() => capturing(),
		(active) => {
			if (!active) return;
			const listener = (e: KeyboardEvent) => {
				handleCaptureKey(e);
			};
			window.addEventListener("keydown", listener, true);
			onCleanup(() => window.removeEventListener("keydown", listener, true));
		},
	);

	const record = (id: string) => {
		setRefused("");
		setChord(null);
		setCapturing(id);
	};

	const editorKeysFor = (id: string) => editorKeysOf(id, shellKeys()).map(displayEditorKey).join(", ");
	const markdownKeysFor = (id: string) => keysOf(id, markdownKeysNow()).map(displayKey).join(", ");

	const allShortcutRows = createMemo<ShortcutRow[]>(() => {
		const shellChanges = state.settings.keys ?? {};
		const edChanges = editorKeyChanges();
		const mdChanges = markdownKeyChanges();
		const isCmdModified = (id: string, changes: Record<string, string>, base: Record<string, string>) => {
			if (Object.values(changes).includes(id)) return true;
			for (const [k, v] of Object.entries(base)) {
				if (v === id && k in changes && changes[k] !== id) return true;
			}
			return false;
		};
		const baseEd = baseEditorKeys() ?? {};
		const rows: ShortcutRow[] = [];
		for (const c of commands) {
			rows.push({
				rowId: c.id,
				commandId: c.id,
				label: c.label,
				context: "Global",
				contextKey: "global",
				keysText: keysFor(c.id),
				modified: isCmdModified(c.id, shellChanges, DEFAULT_KEYS),
			});
		}
		for (const cmd of EDITOR_COMMANDS) {
			rows.push({
				rowId: cmd.id,
				commandId: cmd.id,
				label: editorCommandLabel(cmd.id),
				context: "Code Editor",
				contextKey: "editor",
				keysText: editorKeysFor(cmd.id),
				modified: isCmdModified(cmd.id, edChanges, baseEd),
			});
		}
		for (const cmd of MARKDOWN_COMMANDS) {
			rows.push({
				rowId: MARKDOWN_ROW + cmd.id,
				commandId: cmd.id,
				label: markdownCommandLabel(cmd.id),
				context: "Markdown",
				contextKey: "markdown",
				keysText: markdownKeysFor(cmd.id),
				modified: isCmdModified(cmd.id, mdChanges, MARKDOWN_KEYS),
			});
		}
		return rows;
	});

	const filteredShortcuts = createMemo(() => {
		const pq = parsedQuery();
		const ctx = keyContextFilter();
		return allShortcutRows().filter((row) => {
			if (pq.scopeFilter === "workspace") return false;
			if ((pq.modifiedOnly || ctx === "modified") && !row.modified) return false;
			if (ctx !== "all" && ctx !== "modified" && row.contextKey !== ctx) return false;
			if (!pq.text) return true;
			const hay = `keyboard shortcuts ${row.context} ${row.label} ${row.keysText}`;
			return matchWords(pq.text, hay) > 0;
		});
	});

	const clearShortcut = async (row: ShortcutRow) => {
		if (row.contextKey === "global") {
			await saveSetting({ keys: unbind(DEFAULT_KEYS, state.settings.keys ?? {}, row.commandId) });
		} else if (row.contextKey === "editor") {
			const base = baseEditorKeys();
			if (base) await saveSetting({ editorKeys: unbind(base, editorKeyChanges(), row.commandId) });
		} else {
			await saveSetting({ markdownKeys: unbind(MARKDOWN_KEYS, markdownKeyChanges(), row.commandId) });
		}
		await refreshLayers();
	};

	const anyCustomShortcuts = createMemo(
		() =>
			Object.keys(state.settings.keys ?? {}).length > 0 ||
			Object.keys(state.settings.editorKeys ?? {}).length > 0 ||
			Object.keys(state.settings.markdownKeys ?? {}).length > 0,
	);

	const resetAllShortcuts = async () => {
		const picked = await choose("Reset all customized Global, Code Editor, and Markdown shortcuts back to defaults?", ["Reset shortcuts"]);
		if (picked !== "Reset shortcuts") return;
		await saveSetting({ keys: null, editorKeys: null, markdownKeys: null });
		await refreshLayers();
		notify("Keyboard shortcuts restored to defaults.");
	};

	const importTheme = async () => {
		if (!inApp) notify("Importing a theme uses the system file dialog and is only available in the desktop app.");
		try {
			const added = await backend.importTheme();
			if (!added) return;
			await loadSettings();
			await save("theme", added.id);
			notify(`Imported theme “${added.name}”.`);
		} catch (e: any) {
			notify(`Could not import theme: ${String(e?.message ?? e)}`, "error");
		}
	};

	const scale = () => clampScale(state.settings.uiScale);
	const serverStatusText = () => {
		const lsp = state.info?.lsp;
		if (!lsp?.path) return lsp?.message ?? "Not found.";
		return `${state.lsp.state === "running" ? "Running" : `Not running (${state.lsp.state})`}: ${lsp.path}${lsp.version ? `, version ${lsp.version}` : ""}${lsp.message ? `. ${lsp.message}` : ""}`;
	};

	const parsedOklch = () => parseOklchThemeId(state.settings.theme);
	const isWarmMode = () => state.settings.theme === "system" || parsedOklch() !== null;
	const themeSelectValue = () => (isWarmMode() ? "__warm__" : state.settings.theme);
	const activeMaterial = (): ThemeMaterial => {
		const p = parsedOklch();
		if (p) return p.material;
		return isThemeMaterial(state.settings.themeMaterial) ? state.settings.themeMaterial : DEFAULT_MATERIAL;
	};
	const pickTone = async (tone: "system" | ThemeTone): Promise<boolean> => {
		const mat = activeMaterial();
		const patch: SettingsPatch =
			tone === "system" ? { theme: "system", themeMaterial: mat } : { theme: oklchThemeId(tone, mat), themeMaterial: mat };
		const saved = Boolean(await saveSetting(patch, scopeOf("theme")));
		await refreshLayers();
		return saved;
	};
	const pickMaterial = (mat: ThemeMaterial) => {
		const p = parsedOklch();
		const nextTheme = state.settings.theme === "system" ? "system" : oklchThemeId(p?.tone ?? DEFAULT_DARK_TONE, mat);
		void saveSetting({ theme: nextTheme, themeMaterial: mat }, scopeOf("theme")).then(refreshLayers);
	};

	const categoryCount = (catId: SettingsCategoryId): number => {
		if (catId === "keyboard") return filteredShortcuts().length;
		const vis = visibleSchemaKeys();
		let n = 0;
		for (const meta of SETTINGS_SCHEMA) {
			if (meta.category === catId && vis.has(meta.key)) n++;
		}
		return n;
	};

	const showCat = (catId: SettingsCategoryId): boolean => {
		const selected = activeCategory();
		if (selected !== "all" && selected !== catId) return false;
		if (catId === "keyboard") return selected === "keyboard" || (Boolean(settingsQuery().trim()) && filteredShortcuts().length > 0);
		return categoryCount(catId) > 0;
	};

	const userModCount = createMemo(() => {
		void layersNonce();
		return countModifiedSettings(layers(), "user");
	});
	const wsModCount = createMemo(() => {
		void layersNonce();
		return state.workspace ? countModifiedSettings(layers(), "workspace") : 0;
	});

	const filterMenuItems = (): MenuItem[] => {
		const pq = parsedQuery();
		const items: MenuItem[] = [
			{ label: "Modified (@modified)", checked: pq.modifiedOnly, run: () => toggleQueryToken("@modified") },
			{ label: "User overrides (@user)", checked: pq.scopeFilter === "user", run: () => toggleQueryToken("@user") },
			...(state.workspace
				? [{ label: "Workspace overrides (@workspace)", checked: pq.scopeFilter === "workspace", run: () => toggleQueryToken("@workspace") }]
				: []),
			{ label: "User-only security settings (@security)", checked: pq.userOnly, run: () => toggleQueryToken("@security") },
		];
		if (activeFilterChips().length > 0) {
			items.push("separator", { label: "Clear Filters", run: () => setSettingsQuery(pq.text) });
		}
		return items;
	};

	/** One VS Code-style setting row with category prefix, modified gutter bar, scope badge, and per-setting Reset. */
	const SettingRow = (p: {
		setting: keyof Settings;
		wide?: boolean;
		children: (ids: { control: string; label: string; hint: string; disabled: boolean }) => JSX.Element;
	}) => {
		const meta = () => SETTINGS_SCHEMA_MAP.get(p.setting)!;
		const catLabel = () => SETTINGS_CATEGORIES.find((c) => c.id === meta().category)?.label ?? "";
		const ids = { control: createUniqueId(), label: createUniqueId(), hint: createUniqueId() };
		const locked = () => activeScope() === "workspace" && USER_ONLY_SETTING_KEYS.has(p.setting);
		const modified = () => !locked() && isSettingDefinedInScope(p.setting, layers(), activeScope());
		const note = () => settingScopeNote(p.setting, layers(), activeScope(), Boolean(state.workspace));
		const resetSetting = async () => {
			if (p.setting === "theme") {
				await saveSetting({ theme: null, themeMaterial: null }, scopeOf("theme"));
				await refreshLayers();
				return;
			}
			await save(p.setting, null);
		};
		return (
			<Show when={visibleSchemaKeys().has(p.setting)}>
				<div class={["settings-item", "settings-row", { modified: modified(), locked: locked() }]}>
					<div class="settings-item-head">
						<span class="settings-item-cat">{catLabel()}</span>
						<label class="settings-item-title" id={ids.label} for={ids.control}>
							{meta().label}
						</label>
						<Show when={note()}>
							{(n) => (
								<span class={`settings-pill ${n().tone}`}>
									<Show when={n().tone === "lock"}>
										<Icon name="lock" />
									</Show>
									<span>{n().text}</span>
								</span>
							)}
						</Show>
						<Show when={locked()}>
							<button type="button" class="link settings-unlock-link" onClick={() => setActiveScope("user")}>
								Edit in User
							</button>
						</Show>
						<Show when={modified()}>
							<button
								type="button"
								class="settings-reset-btn"
								title={activeScope() === "workspace" ? `Clear workspace override for ${meta().label}` : `Reset ${meta().label} to default`}
								aria-label={`Reset ${meta().label}`}
								onClick={() => void resetSetting()}
							>
								<Icon name="discard" />
							</button>
						</Show>
					</div>
					<p class="settings-item-desc" id={ids.hint}>
						{meta().description}
					</p>
					<div class={["settings-item-control", { wide: p.wide }]}>
						{p.children({ ...ids, disabled: locked() })}
					</div>
				</div>
			</Show>
		);
	};

	const FontControl = (p: { id: string; hintId: string; setting: "uiFont" | "codeFont" | "readFont"; presets: readonly FontPreset[]; placeholder: string; disabled?: boolean }) => {
		const current = () => (state.settings[p.setting] ?? "").trim();
		const isPreset = () => p.presets.some((item) => item.id === current());
		const [customizing, setCustomizing] = createSignal(false);
		const showInput = () => customizing() || !isPreset();
		const selectValue = () => (showInput() ? "__custom__" : current());
		const metaLabel = () => SETTINGS_SCHEMA_MAP.get(p.setting)?.label ?? p.setting;
		return (
			<div class="settings-font-control">
				<select
					id={p.id}
					aria-describedby={p.hintId}
					disabled={p.disabled}
					value={selectValue()}
					onChange={async (e) => {
						const el = e.currentTarget;
						const val = el.value;
						if (val === "__custom__") {
							setCustomizing(true);
							return;
						}
						const wasCustomizing = untrack(customizing);
						setCustomizing(false);
						if (!(await save(p.setting, val))) {
							if (wasCustomizing) setCustomizing(true);
							el.value = untrack(selectValue);
						}
					}}
				>
					<For each={p.presets}>{(item) => <option value={item.id}>{item.label}</option>}</For>
					<option value="__custom__">Custom local font…</option>
				</select>
				<Show when={showInput()}>
					<DraftInput
						type="text"
						disabled={p.disabled}
						aria-label={`${metaLabel()} family name`}
						placeholder={p.placeholder}
						value={current()}
						onKeyDown={commitOnEnter}
						onCommit={async (raw, el) => {
							const val = raw.trim();
							el.value = val;
							const saved = await save(p.setting, val);
							if (!saved) return false;
							if (!val) setCustomizing(false);
							return val;
						}}
					/>
				</Show>
			</div>
		);
	};

	const anySettingVisible = createMemo(() => SETTINGS_CATEGORIES.some((cat) => showCat(cat.id)));

	return (
		<div class={["settings-workspace", { embedded: props.embedded }]} data-view="settings" onMouseDown={() => setCapturing(null)}>
			{/* Sticky VS Code-style Settings header: Search + Filter funnel + User/Workspace tabs + JSON toggle */}
			<div class="settings-topbar">
				<div class="settings-search-row">
					<div class="settings-search-wrap">
						<Icon name="search" class="settings-search-icon" />
						<input
							class="settings-search"
							data-autofocus
							aria-label="Search settings"
							placeholder="Search settings"
							autocomplete="off"
							spellcheck="false"
							value={settingsQuery()}
							onInput={(e) => {
								setSettingsQuery(e.currentTarget.value);
								if (jsonMode()) setJsonMode(false);
							}}
						/>
						<Show when={settingsQuery()}>
							<button
								type="button"
								class="settings-search-clear"
								title="Clear search"
								aria-label="Clear search"
								onClick={() => setSettingsQuery("")}
							>
								<Icon name="close" />
							</button>
						</Show>
						<Menu
							floating
							class={activeFilterChips().length > 0 ? "docs-filter-menu on" : "docs-filter-menu"}
							label={activeFilterChips().length > 0 ? "Filter settings: active" : "Filter settings"}
							title="Filter Settings (@modified, @user, @workspace)"
							items={filterMenuItems}
						>
							<Icon name={activeFilterChips().length > 0 ? "filter-filled" : "filter"} />
						</Menu>
					</div>
					<div class="settings-top-actions">
						<button
							type="button"
							class={["settings-icon-action", { active: jsonMode() }]}
							title={jsonMode() ? "Open Settings (UI)" : "Open Settings (JSON)"}
							aria-pressed={jsonMode() ? "true" : "false"}
							onClick={() => setJsonMode((v) => !v)}
						>
							<Icon name={jsonMode() ? "gear" : "json"} />
							<span>{jsonMode() ? "UI" : "JSON"}</span>
						</button>
						<button
							type="button"
							class="settings-icon-action"
							title="Configure Agent Customizations (Skills, Instructions, Agents, Prompts, MCP)"
							onClick={() => openCustomizations("skills")}
						>
							<Icon name="sparkle" />
							<span>Customizations</span>
						</button>
						<button
							type="button"
							class="settings-icon-action"
							title="Edit SSL Language Server Style Profile"
							onClick={() => openStyleProfile()}
						>
							<Icon name="tools" />
							<span>Style Profile</span>
						</button>
					</div>
				</div>

				<Show when={activeFilterChips().length > 0}>
					<div class="settings-filter-chips">
						<For each={activeFilterChips()}>
							{(chip) => (
								<button
									type="button"
									class="docs-tag-active"
									title={`Remove ${chip.token} filter`}
									onClick={() => toggleQueryToken(chip.token)}
								>
									<span>{chip.label}</span>
									<Icon name="close" />
								</button>
							)}
						</For>
					</div>
				</Show>

				<div class="settings-scope-tabs" role="tablist" aria-label="Settings scope">
					<button
						type="button"
						role="tab"
						aria-selected={activeScope() === "user" ? "true" : "false"}
						class={["settings-scope-tab", { active: activeScope() === "user" }]}
						onClick={() => setActiveScope("user")}
					>
						<span>User</span>
						<Show when={userModCount() > 0}>
							<span class="settings-tab-count">{userModCount()}</span>
						</Show>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeScope() === "workspace" ? "true" : "false"}
						disabled={!state.workspace}
						title={state.workspace ? `Workspace settings for ${state.workspace.name}` : "Open a workspace folder to edit workspace settings"}
						class={["settings-scope-tab", { active: activeScope() === "workspace" }]}
						onClick={() => state.workspace && setActiveScope("workspace")}
					>
						<span>Workspace{state.workspace ? ` (${state.workspace.name})` : ""}</span>
						<Show when={wsModCount() > 0}>
							<span class="settings-tab-count">{wsModCount()}</span>
						</Show>
					</button>
				</div>
			</div>

			<Show
				when={!jsonMode()}
				fallback={
					<SettingsJsonEditor
						scope={activeScope()}
						onSaved={refreshLayers}
						onSwitchToUi={() => setJsonMode(false)}
					/>
				}
			>
				<div class="settings-split">
					{/* Left Category TOC */}
					<nav class="settings-toc" aria-label="Settings categories">
						<button
							type="button"
							class={["settings-toc-item", { active: activeCategory() === "all" }]}
							onClick={() => setActiveCategory("all")}
						>
							<span class="settings-toc-label">All Settings</span>
						</button>
						<For each={SETTINGS_CATEGORIES}>
							{(cat) => {
								const count = () => categoryCount(cat.id);
								return (
									<button
										type="button"
										class={["settings-toc-item", { active: activeCategory() === cat.id, empty: Boolean(settingsQuery().trim()) && count() === 0 }]}
										onClick={() => setActiveCategory(cat.id)}
									>
										<span class="settings-toc-label">{cat.label}</span>
										<Show when={Boolean(settingsQuery().trim()) || cat.id === "keyboard"}>
											<span class="settings-toc-count">{count()}</span>
										</Show>
									</button>
								);
							}}
						</For>
					</nav>

					{/* Right Settings Content */}
					<div class="settings-content">
						<Show when={showCat("appearance")}>
							<section class="settings-group" aria-label="Appearance">
								<h3>Appearance</h3>
								<SettingRow setting="theme" wide>
									{(ids) => {
										let themeSelectEl: HTMLSelectElement | undefined;
										createEffect(
											() => [state.themes, themeSelectValue()] as const,
											([, val]) => {
												if (themeSelectEl && themeSelectEl.value !== val) themeSelectEl.value = val;
											},
										);
										return (
											<div class="settings-theme">
												<div class="settings-theme-bar" role="group" aria-label="Surface tone" aria-describedby={ids.hint}>
													<button
														type="button"
														aria-pressed={state.settings.theme === "system" ? "true" : "false"}
														class={{ active: state.settings.theme === "system" }}
														onClick={() => void pickTone("system")}
													>
														System
													</button>
													<For each={TONES}>
														{(tone) => (
															<button
																type="button"
																aria-pressed={parsedOklch()?.tone === tone ? "true" : "false"}
																class={{ active: parsedOklch()?.tone === tone }}
																onClick={() => void pickTone(tone)}
															>
																{TONE_INFO[tone].label}
															</button>
														)}
													</For>
												</div>
												<div class="settings-theme-materials" role="group" aria-label="Material finish">
													<For each={MATERIALS}>
														{(mat) => {
															const info = MATERIAL_INFO[mat];
															const active = () => isWarmMode() && activeMaterial() === mat;
															return (
																<button
																	type="button"
																	class={["settings-swatch", { active: active() }]}
																	aria-pressed={active() ? "true" : "false"}
																	onClick={() => pickMaterial(mat)}
																>
																	<span class="settings-swatch-dot" style={{ background: info.swatch }} aria-hidden="true" />
																	<span>{info.label}</span>
																</button>
															);
														}}
													</For>
												</div>
												<div class="settings-theme-extra">
													<select
														ref={themeSelectEl}
														id={ids.control}
														aria-label="Classic or imported theme"
														aria-describedby={ids.hint}
														value={themeSelectValue()}
														onChange={async (e) => {
															const el = e.currentTarget;
															const val = el.value;
															const saved = val === "__warm__" ? await pickTone("system") : await save("theme", val);
															if (!saved) el.value = untrack(themeSelectValue);
														}}
													>
														<option value="__warm__">Warm Material (chosen above)</option>
														<option value="dark">Studio Dark (Classic)</option>
														<option value="light">Studio Light (Classic)</option>
														<For each={state.themes} keyed={(t) => t.id}>
															{(t) => <option value={t().id}>{t().name}</option>}
														</For>
													</select>
													<button type="button" onClick={() => void importTheme()}>
														Import…
													</button>
												</div>
											</div>
										);
									}}
								</SettingRow>
								<SettingRow setting="uiScale">
									{(ids) => (
										<div class="settings-stepper" role="group" aria-labelledby={ids.label} aria-describedby={ids.hint}>
											<button type="button" aria-label="Smaller" disabled={scale() <= UI_SCALE.min} onClick={() => void save("uiScale", stepScale(scale(), -1))}>
												<Icon name="remove" />
											</button>
											<output id={ids.control} aria-live="polite">
												{Math.round(scale() * 100)}%
											</output>
											<button type="button" aria-label="Larger" disabled={scale() >= UI_SCALE.max} onClick={() => void save("uiScale", stepScale(scale(), 1))}>
												<Icon name="add" />
											</button>
											<button type="button" disabled={scale() === UI_SCALE.normal} onClick={() => void save("uiScale", UI_SCALE.normal)}>
												Reset
											</button>
										</div>
									)}
								</SettingRow>
								<SettingRow setting="fontSize">
									{(ids) => (
										<DraftInput
											id={ids.control}
											aria-describedby={ids.hint}
											type="number"
											min={FONT.min}
											max={FONT.max}
											value={String(state.settings.fontSize)}
											onKeyDown={commitOnEnter}
											onCommit={async (raw, el) => {
												const next = clampNumericSetting(raw, FONT.min, FONT.max, FONT.normal);
												const text = String(next);
												el.value = text;
												return (await save("fontSize", next)) ? text : false;
											}}
										/>
									)}
								</SettingRow>
								<SettingRow setting="uiFont">
									{(ids) => <FontControl id={ids.control} hintId={ids.hint} setting="uiFont" presets={UI_FONT_PRESETS} placeholder="e.g. IBM Plex Sans" />}
								</SettingRow>
								<SettingRow setting="codeFont">
									{(ids) => <FontControl id={ids.control} hintId={ids.hint} setting="codeFont" presets={CODE_FONT_PRESETS} placeholder="e.g. JetBrains Mono" />}
								</SettingRow>
								<SettingRow setting="readFont">
									{(ids) => <FontControl id={ids.control} hintId={ids.hint} setting="readFont" presets={READ_FONT_PRESETS} placeholder="e.g. Source Serif 4" />}
								</SettingRow>
								<SettingRow setting="menuBar">
									{(ids) => (
										<label class="settings-check">
											<input
												id={ids.control}
												aria-describedby={ids.hint}
												type="checkbox"
												checked={state.settings.menuBar !== false}
												onChange={async (e) => {
													const el = e.currentTarget;
													if (!(await save("menuBar", el.checked))) el.checked = untrack(() => state.settings.menuBar !== false);
												}}
											/>
											<span>Show top menu bar</span>
										</label>
									)}
								</SettingRow>
							</section>
						</Show>

						<Show when={showCat("editor")}>
							<section class="settings-group" aria-label="Editor">
								<h3>Editor</h3>
								<SettingRow setting="formatOnSave">
									{(ids) => (
										<label class="settings-check">
											<input
												id={ids.control}
												aria-describedby={ids.hint}
												type="checkbox"
												checked={state.settings.formatOnSave}
												onChange={async (e) => {
													const el = e.currentTarget;
													if (!(await save("formatOnSave", el.checked))) el.checked = untrack(() => state.settings.formatOnSave);
												}}
											/>
											<span>Format modified lines on save</span>
										</label>
									)}
								</SettingRow>
								<SettingRow setting="sqlDialect">
									{(ids) => (
										<select
											id={ids.control}
											aria-describedby={ids.hint}
											value={state.settings.sqlDialect ?? DEFAULT_SQL_DIALECT}
											onChange={async (e) => {
												const el = e.currentTarget;
												if (!(await save("sqlDialect", el.value as SqlDialect))) el.value = untrack(() => state.settings.sqlDialect ?? DEFAULT_SQL_DIALECT);
											}}
										>
											<For each={SQL_DIALECTS}>{(d) => <option value={d.id}>{d.label}</option>}</For>
										</select>
									)}
								</SettingRow>
								<SettingRow setting="minimap">
									{(ids) => (
										<label class="settings-check">
											<input
												id={ids.control}
												aria-describedby={ids.hint}
												type="checkbox"
												checked={state.settings.minimap}
												onChange={async (e) => {
													const el = e.currentTarget;
													if (!(await save("minimap", el.checked))) el.checked = untrack(() => state.settings.minimap);
												}}
											/>
											<span>Show code minimap</span>
										</label>
									)}
								</SettingRow>
								<SettingRow setting="wordWrap">
									{(ids) => (
										<label class="settings-check">
											<input
												id={ids.control}
												aria-describedby={ids.hint}
												type="checkbox"
												checked={Boolean(state.settings.wordWrap)}
												onChange={async (e) => {
													const el = e.currentTarget;
													if (!(await save("wordWrap", el.checked))) el.checked = untrack(() => Boolean(state.settings.wordWrap));
												}}
											/>
											<span>Wrap long lines</span>
										</label>
									)}
								</SettingRow>
								<SettingRow setting="inlayHints">
									{(ids) => (
										<label class="settings-check">
											<input
												id={ids.control}
												aria-describedby={ids.hint}
												type="checkbox"
												checked={state.settings.inlayHints !== false}
												onChange={async (e) => {
													const el = e.currentTarget;
													if (!(await save("inlayHints", el.checked))) el.checked = untrack(() => state.settings.inlayHints !== false);
												}}
											/>
											<span>Show parameter inlay hints</span>
										</label>
									)}
								</SettingRow>
								<SettingRow setting="indentOnType">
									{(ids) => (
										<label class="settings-check">
											<input
												id={ids.control}
												aria-describedby={ids.hint}
												type="checkbox"
												checked={state.settings.indentOnType !== false}
												onChange={async (e) => {
													const el = e.currentTarget;
													if (!(await save("indentOnType", el.checked))) el.checked = untrack(() => state.settings.indentOnType !== false);
												}}
											/>
											<span>Indent SSL lines as formatter does</span>
										</label>
									)}
								</SettingRow>
								<SettingRow setting="ctrlClickAddsCursor">
									{(ids) => (
										<label class="settings-check">
											<input
												id={ids.control}
												aria-describedby={ids.hint}
												type="checkbox"
												checked={state.settings.ctrlClickAddsCursor !== false}
												onChange={async (e) => {
													const el = e.currentTarget;
													if (!(await save("ctrlClickAddsCursor", el.checked))) el.checked = untrack(() => state.settings.ctrlClickAddsCursor !== false);
												}}
											/>
											<span>Ctrl+click adds cursor (Sublime style)</span>
										</label>
									)}
								</SettingRow>
								<SettingRow setting="rulers">
									{(ids) => (
										<label class="settings-check">
											<input
												id={ids.control}
												aria-describedby={ids.hint}
												type="checkbox"
												checked={state.settings.rulers !== false}
												onChange={async (e) => {
													const el = e.currentTarget;
													if (!(await save("rulers", el.checked))) el.checked = untrack(() => state.settings.rulers !== false);
												}}
											/>
											<span>Show column ruler</span>
										</label>
									)}
								</SettingRow>
								<SettingRow setting="rulerMargin">
									{(ids) => (
										<DraftInput
											id={ids.control}
											aria-describedby={ids.hint}
											type="number"
											min="0"
											max="60"
											disabled={state.settings.rulers === false}
											value={String(state.settings.rulerMargin ?? RULER_MARGIN)}
											onKeyDown={commitOnEnter}
											onCommit={async (raw, el) => {
												const next = clampNumericSetting(raw, 0, 60, RULER_MARGIN);
												const text = String(next);
												el.value = text;
												return (await save("rulerMargin", next)) ? text : false;
											}}
										/>
									)}
								</SettingRow>
								<SettingRow setting="csvTable">
									{(ids) => {
										const cfg = () => effectiveCsvTableConfig(state.settings.csvTable);
										return (
											<div class="settings-csv-control">
												<label class="settings-check">
													<input
														id={ids.control}
														aria-describedby={ids.hint}
														type="checkbox"
														checked={cfg().badgeFormatting}
														onChange={async (e) => {
															const el = e.currentTarget;
															if (!(await save("csvTable", { ...cfg(), badgeFormatting: el.checked }))) {
																el.checked = untrack(() => cfg().badgeFormatting);
															}
														}}
													/>
													<span>Format CSV status columns as colored badges</span>
												</label>
												<Show when={Boolean(state.settings.csvTable)}>
													<button
														type="button"
														title="Restore default STARLIMS + Registry CSV column badge rules"
														onClick={() => void save("csvTable", cloneCsvTableConfig(DEFAULT_CSV_TABLE_CONFIG))}
													>
														Reset rules
													</button>
												</Show>
											</div>
										);
									}}
								</SettingRow>
							</section>
						</Show>

						<Show when={showCat("markdown")}>
							<section class="settings-group" aria-label="Markdown & Docs">
								<h3>Markdown &amp; Docs</h3>
								<SettingRow setting="livePreview">
									{(ids) => (
										<label class="settings-check">
											<input
												id={ids.control}
												aria-describedby={ids.hint}
												type="checkbox"
												checked={state.settings.livePreview !== false}
												onChange={async (e) => {
													const el = e.currentTarget;
													const checked = el.checked;
													if (await save("livePreview", checked)) syncLivePreviewMode(checked);
													else el.checked = untrack(() => state.settings.livePreview !== false);
												}}
											/>
											<span>Enable Obsidian-style Live Preview</span>
										</label>
									)}
								</SettingRow>
								<SettingRow setting="markdownReadingHighlight">
									{(ids) => (
										<label class="settings-check">
											<input
												id={ids.control}
												aria-describedby={ids.hint}
												type="checkbox"
												checked={state.settings.markdownReadingHighlight !== false}
												onChange={async (e) => {
													const el = e.currentTarget;
													if (!(await save("markdownReadingHighlight", el.checked))) {
														el.checked = untrack(() => state.settings.markdownReadingHighlight !== false);
													}
												}}
											/>
											<span>Dim trailing lines while reading or editing</span>
										</label>
									)}
								</SettingRow>
								<SettingRow setting="attachmentsFolder" wide>
									{(ids) => (
										<DraftInput
											id={ids.control}
											aria-describedby={ids.hint}
											type="text"
											placeholder="docs/attachments"
											value={state.settings.attachmentsFolder ?? ""}
											onKeyDown={commitOnEnter}
											onCommit={(_raw, el) => saveRelFolder("attachmentsFolder", el)}
										/>
									)}
								</SettingRow>
								<SettingRow setting="templatesFolder" wide>
									{(ids) => (
										<DraftInput
											id={ids.control}
											aria-describedby={ids.hint}
											type="text"
											placeholder="docs/templates"
											value={state.settings.templatesFolder ?? ""}
											onKeyDown={commitOnEnter}
											onCommit={(_raw, el) => saveRelFolder("templatesFolder", el)}
										/>
									)}
								</SettingRow>
							</section>
						</Show>

						<Show when={showCat("ssl")}>
							<section class="settings-group" aria-label="SSL & Language Server">
								<h3>SSL &amp; Language Server</h3>
								<SettingRow setting="stylePreset">
									{(ids) => (
										<div class="settings-inline-row">
											<select
												id={ids.control}
												aria-describedby={ids.hint}
												value={state.settings.stylePreset}
												onChange={async (e) => {
													const el = e.currentTarget;
													if (!(await save("stylePreset", el.value as "house" | "server"))) {
														el.value = untrack(() => state.settings.stylePreset);
													}
												}}
											>
												<option value="house">House style (recommended)</option>
												<option value="server">starlims-lsp defaults</option>
											</select>
											<button type="button" onClick={() => openStyleProfile()}>
												Edit Style Profile…
											</button>
										</div>
									)}
								</SettingRow>
								<SettingRow setting="lspPath" wide>
									{(ids) => (
										<DraftInput
											id={ids.control}
											aria-describedby={ids.hint}
											disabled={ids.disabled}
											autocomplete="off"
											spellcheck="false"
											placeholder={state.info?.lsp.path ?? "Found automatically"}
											value={state.settings.lspPath ?? ""}
											onKeyDown={commitOnEnter}
											onCommit={async (raw, el) => {
												const trimmed = raw.trim();
												el.value = trimmed;
												return (await save("lspPath", trimmed)) ? trimmed : false;
											}}
										/>
									)}
								</SettingRow>
								<p class="settings-status-line">{serverStatusText()}</p>
							</section>
						</Show>

						<Show when={showCat("agent")}>
							<section class="settings-group" aria-label="Agent & AI">
								<h3>Agent &amp; AI</h3>
								<AgentSettingsSection
									scope={activeScope()}
									layers={layers()}
									visibleKeys={visibleSchemaKeys()}
									onSaveUser={saveUserOnly}
									onSwitchToUser={() => setActiveScope("user")}
								/>
							</section>
						</Show>

						<Show when={showCat("storage")}>
							<section class="settings-group" aria-label="History & Limits">
								<h3>History &amp; Limits</h3>
								<StorageLimitsSection
									scope={activeScope()}
									layers={layers()}
									showLimits={visibleSchemaKeys().has("limits")}
									onSave={save}
								/>
							</section>
						</Show>

						<Show when={showCat("keyboard")}>
							<section class="settings-group" aria-label="Keyboard Shortcuts">
								<div class="settings-kb-header">
									<div>
										<h3>Keyboard Shortcuts</h3>
										<p class="settings-item-desc">
											Saved in User settings. Editor chords start with {displayKey(onMac ? "cmd+k" : "ctrl+k")}; Markdown keys take priority inside Markdown editors.
										</p>
									</div>
									<button type="button" disabled={!anyCustomShortcuts()} onClick={() => void resetAllShortcuts()}>
										Reset All Defaults
									</button>
								</div>

								<Show when={activeScope() === "workspace"}>
									<div class="settings-lock-banner" role="note">
										<Icon name="lock" />
										<span>Keyboard shortcuts are personal and always saved in <strong>User</strong> settings.</span>
									</div>
								</Show>

								<div class="settings-kb-filters" role="group" aria-label="Filter shortcut context">
									{(
										[
											["all", "All"],
											["global", "Global"],
											["editor", "Code Editor"],
											["markdown", "Markdown"],
											["modified", "Modified"],
										] as const
									).map(([id, text]) => (
										<button
											type="button"
											class={["settings-kb-pill", { active: keyContextFilter() === id }]}
											aria-pressed={keyContextFilter() === id ? "true" : "false"}
											onClick={() => setKeyContextFilter(id)}
										>
											{text}
										</button>
									))}
								</div>

								<Show when={refused()}>
									<p class="settings-note" role="alert">
										{refused()}
									</p>
								</Show>

								<div class="settings-kb-table" role="table" aria-label="Keyboard shortcuts">
									<div class="settings-kb-head" role="row">
										<span role="columnheader">Command</span>
										<span role="columnheader">Keybinding</span>
										<span role="columnheader">Context</span>
										<span role="columnheader">Source</span>
										<span role="columnheader">Actions</span>
									</div>
									<For each={filteredShortcuts()} fallback={<p class="settings-empty">No shortcuts match.</p>}>
										{(row) => (
											<div class={["settings-kb-row", { modified: row.modified, capturing: capturing() === row.rowId }]} role="row">
												<span class="kb-cmd" role="cell" title={row.label}>{row.label}</span>
												<span class="kb-key" role="cell">
													{capturing() === row.rowId ? (
														<span class="kb-capturing">
															{chordFirst() ? `${displayKey(chordFirst())}, press 2nd key (Esc stops)` : "Press keys (Esc stops)"}
														</span>
													) : row.keysText ? (
														<kbd>{row.keysText}</kbd>
													) : (
														<span class="kb-none">—</span>
													)}
												</span>
												<span class="kb-ctx" role="cell">{row.context}</span>
												<span class="kb-src" role="cell">{row.modified ? "User" : "Default"}</span>
												<span class="kb-acts" role="cell">
													<button type="button" aria-label={`Set shortcut for ${row.label}`} onClick={() => record(row.rowId)}>
														Set
													</button>
													<button type="button" aria-label={`Clear shortcut for ${row.label}`} disabled={!row.keysText} onClick={() => void clearShortcut(row)}>
														Clear
													</button>
												</span>
											</div>
										)}
									</For>
								</div>
							</section>
						</Show>

						<Show when={!anySettingVisible()}>
							<p class="settings-empty">
								No settings match{settingsQuery().trim() ? ` “${settingsQuery().trim()}”` : ""}.
								<Show when={activeFilterChips().length > 0}>
									{" "}
									<button type="button" class="link" onClick={() => setSettingsQuery("")}>
										Clear filters
									</button>
								</Show>
							</p>
						</Show>
					</div>
				</div>
			</Show>
		</div>
	);
}

/** Full-pane Settings Editor tab mounted in `App.tsx` inside `<CenterTabStrip>` when `state.centerView === "settings"`. */
export function SettingsView() {
	return <SettingsWorkspace embedded={true} />;
}

/**
 * Registers the `openSettings()` command hook and hosts a fallback `<Modal>` sheet
 * when Settings is opened from the Welcome screen (before any workspace is open).
 */
export function SettingsDialog() {
	const titleId = createUniqueId();
	onOpenSettings((raw = "") => {
		const trimmed = raw.trim();
		if (trimmed === "__json__") {
			setSettingsQuery("");
			setJsonMode(true);
		} else if (trimmed.toLowerCase() === "keyboard") {
			setSettingsQuery("");
			setJsonMode(false);
			setActiveCategory("keyboard");
		} else {
			setSettingsQuery(raw);
			setJsonMode(false);
			setActiveCategory("all");
		}
		void refreshLayers();
		if (state.workspace) {
			closeComparison();
			setModalOpen(false);
			setState((s) => {
				s.centerView = "settings";
			});
		} else {
			setActiveScope("user");
			setModalOpen(true);
		}
	});

	const close = () => setModalOpen(false);

	return (
		<Show when={modalOpen() && !state.workspace}>
			<Modal class="dialog settings settings-modal" labelledBy={titleId} onClose={close}>
				<div class="settings-modal-head">
					<h2 id={titleId}>Settings</h2>
					<button type="button" class="primary" onClick={close}>
						Done
					</button>
				</div>
				<SettingsWorkspace embedded={false} onClose={close} />
			</Modal>
		</Show>
	);
}
