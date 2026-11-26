// Settings: appearance, the editor, the language server and the keyboard,
// each saying where it is saved.
import { Icon } from "./Icon";
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
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isInside, resolvePath } from "../shared/paths";
import type { Settings, SettingsPatch } from "../shared/protocol";
import { backend, inApp } from "./backend";
import { commands, DEFAULT_KEYS, keymap, keysFor, onOpenSettings } from "./commands";
import { choose } from "./dialogs";
import { bindable, conflict, displayKey, isModifierKey, keyNamesForPlatform, rebind, unbind } from "./keys";
import { Modal } from "./modal";
import { matchWords } from "./quickRank";
import { loadSettings, notify, restartLsp, saveSetting, state, syncLivePreviewMode } from "./state";
import { clampScale, stepScale, UI_SCALE } from "./uiScale";

type Layers = { user: Partial<Settings>; workspace: Partial<Settings> };
type Group = "Appearance" | "Editor" | "Language server" | "Keyboard";

const FONT = { min: 8, max: 32, normal: 13 };
const onMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

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

export function SettingsDialog() {
	const [open, setOpen] = createSignal(false);
	const [query, setQuery] = createSignal("");
	const [layers, setLayers] = createSignal<Layers>({ user: {}, workspace: {} });
	/** The command whose shortcut is being recorded. */
	const [capturing, setCapturing] = createSignal<string | null>(null);
	/** Why the last key pressed was not taken. */
	const [refused, setRefused] = createSignal("");
	const titleId = createUniqueId();

	const loadLayers = () =>
		backend.settings().then(
			(s) => setLayers({ user: s.user, workspace: s.workspace }),
			() => {},
		);
	onOpenSettings((query = "") => {
		setQuery(query);
		setRefused("");
		setOpen(true);
		void loadLayers();
	});
	const close = () => {
		setCapturing(null);
		setOpen(false);
	};

	// A value this project's own settings file holds is changed there: yours
	// would not be seen while the project's is in the way.
	const scopeOf = (key: keyof Settings) => (state.workspace && key in layers().workspace ? "workspace" : "user");
	const save = async <K extends keyof Settings>(key: K, value: Settings[K] | null): Promise<boolean> => {
		const saved = Boolean(await saveSetting({ [key]: value } as SettingsPatch, scopeOf(key)));
		await loadLayers();
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
	const shown = (group: Group, ...text: (string | undefined)[]) => matchWords(query(), [group, ...text].filter(Boolean).join(" ")) > 0;

	// --- keyboard --------------------------------------------------------------

	const label = (id: string) => commands.find((c) => c.id === id)?.label ?? id;
	const bind = async (id: string, key: string) => {
		const taken = conflict(key, id, keymap());
		if (taken && (await choose(`${displayKey(key)} is the shortcut for “${label(taken)}”. Use it for “${label(id)}” instead?`, ["Replace"])) !== "Replace") return;
		await saveSetting({ keys: rebind(DEFAULT_KEYS, state.settings.keys ?? {}, id, key) });
	};
	// While a shortcut is being recorded every key is the modal's: it is the
	// answer, not a command to run or a way out (Escape only stops recording).
	const onKey = (e: KeyboardEvent) => {
		const id = capturing();
		if (!id) return false;
		if (e.isComposing || e.keyCode === 229) return true;
		e.preventDefault();
		e.stopImmediatePropagation();
		if (isModifierKey(e.key)) return true;
		if (e.key === "Escape") {
			setCapturing(null);
			return true;
		}
		const names = keyNamesForPlatform(e, onMac);
		if (!names.length) {
			setRefused("On macOS, bare Ctrl+letter shortcuts are reserved for system text navigation. Use Cmd, Alt, or add Shift.");
			return true;
		}
		const key = names[0]!;
		const check = bindable(key);
		if (!check.ok) {
			setRefused(check.why);
			return true;
		}
		setRefused("");
		setCapturing(null);
		void bind(id, key);
		return true;
	};
	const record = (id: string) => {
		setRefused("");
		setCapturing(id);
	};
	const resetKeys = async () => {
		const answer = await choose("Reset every shortcut to its default? The ones you set are lost, and this cannot be undone.", ["Reset shortcuts"], { danger: "Reset shortcuts" });
		if (answer) await saveSetting({ keys: {} });
	};
	const keyRows = () =>
		[...commands]
			.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }))
			.filter((c) => shown("Keyboard", "shortcut", c.label, c.detail, keysFor(c.id)));

	// --- the rest ----------------------------------------------------------------

	const importTheme = async () => {
		try {
			const theme = await backend.importTheme();
			if (!theme) {
				if (!inApp) notify("Theme import needs the app's file dialog; copy the theme into ~/.config/ssl-studio/themes/ instead.");
				return;
			}
			await loadSettings();
			await save("theme", theme.id);
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	};
	// The language server's path is cleared by saving it empty, not absent: an
	// absent value does not survive the trip to the backend, and empty means "find it".
	const scale = () => clampScale(state.settings.uiScale);
	const server = () => {
		const lsp = state.info?.lsp;
		if (!lsp?.path) return lsp?.message ?? "Not found.";
		return `${state.lsp.state === "running" ? "Running" : `Not running (${state.lsp.state})`}: ${lsp.path}${lsp.version ? `, version ${lsp.version}` : ""}${lsp.message ? `. ${lsp.message}` : ""}`;
	};

	/** One setting: its name, what it does and where it is saved on the left, its control on the right. */
	const Row = (p: { group: Group; label: string; hint?: string; setting: keyof Settings; wide?: boolean; children: (ids: { control: string; label: string; hint: string }) => JSX.Element }) => {
		const ids = { control: createUniqueId(), label: createUniqueId(), hint: createUniqueId() };
		return (
			<Show when={shown(p.group, p.label, p.hint)}>
				<div class="settings-row">
					<div class="settings-text">
						<label id={ids.label} for={ids.control}>
							{p.label}
						</label>
						<span class="settings-hint" id={ids.hint}>
							{p.hint ? `${p.hint}. ` : ""}
							<span class={["settings-scope", { project: scopeOf(p.setting) === "workspace" }]}>
								{scopeOf(p.setting) === "workspace" ? "Saved for this project" : "Saved for you"}
							</span>
						</span>
					</div>
					<div class={["settings-control", { wide: p.wide }]}>
						{p.children(ids)}
					</div>
				</div>
			</Show>
		);
	};
	/** Each section on screen, for the row of names above that jumps to it. */
	const sections = new Map<Group, HTMLElement>();
	const Section = (p: { title: Group; when: boolean; children: JSX.Element }) => (
		<Show when={p.when}>
			<section
				class="settings-group"
				aria-label={p.title}
				ref={(el) => {
					sections.set(p.title, el);
				}}
			>
				<h3>{p.title}</h3>
				{p.children}
			</section>
		</Show>
	);
	const ROWS = {
		theme: ["Theme", "Warm Material OKLCH tones, Classic presets, or an imported VS Code theme"],
		uiScale: ["Interface size", "The whole window, from 80% to 160%"],
		menuBar: ["Menu bar", "File, Edit, Selection, View, Go and Help across the top of the window"],
		fontSize: ["Font size", "The editor, Blocks, diffs and rendered documents"],
		uiFont: ["Interface font", "Chrome, tabs and panels; empty uses the system sans-serif"],
		codeFont: ["Code font", "Editor, Blocks, Tables and Output; empty uses the system monospace"],
		readFont: ["Reading font", "Optional face for rendered Markdown Read view; empty matches the interface font"],
		formatOnSave: ["Format changed lines on save", "Only the lines changed since the last save"],
		sqlDialect: ["SQL dialect", "Database dialect used when formatting standalone .sql files (T-SQL for SQL Server, PL/SQL for Oracle)"],
		minimap: ["Minimap", "The outline of the file at the editor's edge; a narrow editor goes without"],
		wordWrap: ["Word wrap", "Long lines wrapped at the editor's edge, not scrolled to; Alt+Z switches it"],
		livePreview: ["Markdown live preview", "A document drawn as it is written: headings larger, the markup hidden except on the line being written"],
		markdownReadingHighlight: ["Markdown reading highlight", "Subtly dim lines below the active cursor (or mouse pointer when reading) in Markdown Live and Read views"],
		inlayHints: ["Parameter name hints", "Names shown beside the arguments of a call"],
		ctrlClickAddsCursor: ["Ctrl+click adds a cursor", "As in Sublime Text, and Alt+click goes to a definition. Off: the other way round, as in VS Code"],
		rulers: ["Ruler at the line length", "A line down the editor at the style profile's line length"],
		rulerMargin: ["Rulers beside it", "Fainter rulers this many columns before and after; 0 for none"],
		csvTable: ["CSV column badges", "Format configured CSV columns (such as status) as colored badges; customize rules from any CSV table's Format button"],
		attachmentsFolder: ["Attachments folder", "Workspace folder where pasted or dropped Markdown images are saved; empty uses ticket folder or docs/attachments"],
		templatesFolder: ["Templates folder", "Workspace folder for custom Markdown templates; empty uses docs/templates"],
		lspPath: ["Language server program", "Leave empty to have it found"],
	} as const;
	const anyShown = (group: Group, ...rows: (keyof typeof ROWS)[]) => rows.some((r) => shown(group, ...ROWS[r]));
	const groups = {
		appearance: () => anyShown("Appearance", "theme", "uiScale", "fontSize", "uiFont", "codeFont", "readFont", "menuBar"),
		editor: () => anyShown("Editor", "formatOnSave", "sqlDialect", "minimap", "wordWrap", "livePreview", "markdownReadingHighlight", "inlayHints", "ctrlClickAddsCursor", "rulers", "rulerMargin", "csvTable", "attachmentsFolder", "templatesFolder"),
		server: () => anyShown("Language server", "lspPath"),
		keyboard: () => keyRows().length > 0,
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
		await loadLayers();
		return saved;
	};
	const pickMaterial = (mat: ThemeMaterial) => {
		const p = parsedOklch();
		const nextTheme = state.settings.theme === "system" ? "system" : oklchThemeId(p?.tone ?? DEFAULT_DARK_TONE, mat);
		void saveSetting({ theme: nextTheme, themeMaterial: mat }, scopeOf("theme")).then(loadLayers);
	};

	const FontControl = (p: { id: string; hintId: string; setting: "uiFont" | "codeFont" | "readFont"; presets: readonly FontPreset[]; placeholder: string }) => {
		const current = () => (state.settings[p.setting] ?? "").trim();
		const isPreset = () => p.presets.some((item) => item.id === current());
		const [customizing, setCustomizing] = createSignal(false);
		const showInput = () => customizing() || !isPreset();
		const selectValue = () => (showInput() ? "__custom__" : current());
		return (
			<div class="settings-font-control">
				<select
					id={p.id}
					aria-describedby={p.hintId}
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
						aria-label={`${ROWS[p.setting][0]} family name`}
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

	const SECTIONS: [title: Group, key: keyof typeof groups][] = [
		["Appearance", "appearance"],
		["Editor", "editor"],
		["Language server", "server"],
		["Keyboard", "keyboard"],
	];

	return (
		<Show when={open()}>
			<Modal class="dialog settings" labelledBy={titleId} onClose={close} onKey={onKey}>
				<h2 id={titleId}>Settings</h2>
				<input class="settings-search" data-autofocus aria-label="Search settings" placeholder="Search settings" autocomplete="off" spellcheck="false" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} onMouseDown={() => setCapturing(null)} />
				{/* The sections by name: the list is long, and a name goes straight to its part of it. */}
				<nav class="settings-nav" aria-label="Sections">
					<For each={SECTIONS.filter(([, key]) => groups[key]())}>
						{([title]) => (
							<button title={`Go to ${title}`} onClick={() => sections.get(title)?.scrollIntoView({ block: "start" })}>
								{title}
							</button>
						)}
					</For>
				</nav>
				{/* A click anywhere stops a recording; the click on "Set" then starts its own. */}
				<div class="settings-body" onMouseDown={() => setCapturing(null)}>
					<Section title="Appearance" when={groups.appearance()}>
						<Row group="Appearance" label={ROWS.theme[0]} hint={ROWS.theme[1]} setting="theme" wide>
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
						</Row>
						<Row group="Appearance" label={ROWS.uiScale[0]} hint={ROWS.uiScale[1]} setting="uiScale">
							{(ids) => (
								<div class="settings-stepper" role="group" aria-labelledby={ids.label} aria-describedby={ids.hint}>
									<button aria-label="Smaller" disabled={scale() <= UI_SCALE.min} onClick={() => void save("uiScale", stepScale(scale(), -1))}>
										<Icon name="remove" />
									</button>
									<output id={ids.control} aria-live="polite">
										{Math.round(scale() * 100)}%
									</output>
									<button aria-label="Larger" disabled={scale() >= UI_SCALE.max} onClick={() => void save("uiScale", stepScale(scale(), 1))}>
										<Icon name="add" />
									</button>
									<button disabled={scale() === UI_SCALE.normal} onClick={() => void save("uiScale", UI_SCALE.normal)}>
										Reset
									</button>
								</div>
							)}
						</Row>
						<Row group="Appearance" label={ROWS.fontSize[0]} hint={ROWS.fontSize[1]} setting="fontSize">
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
						</Row>
						<Row group="Appearance" label={ROWS.uiFont[0]} hint={ROWS.uiFont[1]} setting="uiFont">
							{(ids) => <FontControl id={ids.control} hintId={ids.hint} setting="uiFont" presets={UI_FONT_PRESETS} placeholder="e.g. IBM Plex Sans" />}
						</Row>
						<Row group="Appearance" label={ROWS.codeFont[0]} hint={ROWS.codeFont[1]} setting="codeFont">
							{(ids) => <FontControl id={ids.control} hintId={ids.hint} setting="codeFont" presets={CODE_FONT_PRESETS} placeholder="e.g. JetBrains Mono" />}
						</Row>
						<Row group="Appearance" label={ROWS.readFont[0]} hint={ROWS.readFont[1]} setting="readFont">
							{(ids) => <FontControl id={ids.control} hintId={ids.hint} setting="readFont" presets={READ_FONT_PRESETS} placeholder="e.g. Source Serif 4" />}
						</Row>
						<Row group="Appearance" label={ROWS.menuBar[0]} hint={ROWS.menuBar[1]} setting="menuBar">
							{(ids) => (
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
							)}
						</Row>
					</Section>
					<Section title="Editor" when={groups.editor()}>
						<Row group="Editor" label={ROWS.formatOnSave[0]} hint={ROWS.formatOnSave[1]} setting="formatOnSave">
							{(ids) => (
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
							)}
						</Row>
						<Row group="Editor" label={ROWS.sqlDialect[0]} hint={ROWS.sqlDialect[1]} setting="sqlDialect">
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
						</Row>
						<Row group="Editor" label={ROWS.minimap[0]} hint={ROWS.minimap[1]} setting="minimap">
							{(ids) => (
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
							)}
						</Row>
						<Row group="Editor" label={ROWS.wordWrap[0]} hint={ROWS.wordWrap[1]} setting="wordWrap">
							{(ids) => (
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
							)}
						</Row>
						<Row group="Editor" label={ROWS.livePreview[0]} hint={ROWS.livePreview[1]} setting="livePreview">
							{(ids) => (
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
							)}
						</Row>
						<Row group="Editor" label={ROWS.markdownReadingHighlight[0]} hint={ROWS.markdownReadingHighlight[1]} setting="markdownReadingHighlight">
							{(ids) => (
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
							)}
						</Row>
						<Row group="Editor" label={ROWS.inlayHints[0]} hint={ROWS.inlayHints[1]} setting="inlayHints">
							{(ids) => (
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
							)}
						</Row>
						<Row group="Editor" label={ROWS.ctrlClickAddsCursor[0]} hint={ROWS.ctrlClickAddsCursor[1]} setting="ctrlClickAddsCursor">
							{(ids) => (
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
							)}
						</Row>
						<Row group="Editor" label={ROWS.rulers[0]} hint={ROWS.rulers[1]} setting="rulers">
							{(ids) => (
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
							)}
						</Row>
						<Row group="Editor" label={ROWS.rulerMargin[0]} hint={ROWS.rulerMargin[1]} setting="rulerMargin">
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
						</Row>
						<Row group="Editor" label={ROWS.csvTable[0]} hint={ROWS.csvTable[1]} setting="csvTable">
							{(ids) => {
								const cfg = () => effectiveCsvTableConfig(state.settings.csvTable);
								return (
									<div class="settings-csv-control">
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
										<Show when={Boolean(state.settings.csvTable)}>
											<button
												type="button"
												title="Restore default STARLIMS + Registry CSV column badge rules"
												onClick={() => void save("csvTable", cloneCsvTableConfig(DEFAULT_CSV_TABLE_CONFIG))}
											>
												Reset
											</button>
										</Show>
									</div>
								);
							}}
						</Row>
						<Row group="Editor" label={ROWS.attachmentsFolder[0]} hint={ROWS.attachmentsFolder[1]} setting="attachmentsFolder" wide>
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
						</Row>
						<Row group="Editor" label={ROWS.templatesFolder[0]} hint={ROWS.templatesFolder[1]} setting="templatesFolder" wide>
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
						</Row>
					</Section>
					<Section title="Language server" when={groups.server()}>
						<Row group="Language server" label={ROWS.lspPath[0]} hint={ROWS.lspPath[1]} setting="lspPath" wide>
							{(ids) => (
								<DraftInput
									id={ids.control}
									aria-describedby={ids.hint}
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
						</Row>
						<p class="settings-hint">{server()}</p>
					</Section>
					<Section title="Keyboard" when={groups.keyboard()}>
						<p class="settings-hint">
							A shortcut needs Ctrl or Alt, or a function key. <span class="settings-scope">Saved for you</span>
						</p>
						<Show when={refused()}>
							<p class="settings-note" role="alert">
								{refused()}
							</p>
						</Show>
						<div class="shortcuts">
							<For each={keyRows()}>
								{(c) => (
									<div class="shortcut-row">
										<span>{c.label}</span>
										<span class="hint">{capturing() === c.id ? "Press the keys (Esc stops)" : keysFor(c.id) || "—"}</span>
										<button aria-label={`Set the shortcut for ${c.label}`} onClick={() => record(c.id)}>
											Set
										</button>
										<button aria-label={`Clear the shortcut for ${c.label}`} disabled={!keysFor(c.id)} onClick={() => void saveSetting({ keys: unbind(DEFAULT_KEYS, state.settings.keys ?? {}, c.id) })}>
											Clear
										</button>
									</div>
								)}
							</For>
						</div>
						<div class="settings-actions">
							<button disabled={!Object.keys(state.settings.keys ?? {}).length} onClick={() => void resetKeys()}>
								Reset to defaults
							</button>
						</div>
					</Section>
					<Show when={!groups.appearance() && !groups.editor() && !groups.server() && !groups.keyboard()}>
						<p class="settings-empty">No settings match.</p>
					</Show>
				</div>
				<div class="buttons">
					<button class="primary" onClick={close}>
						Done
					</button>
				</div>
			</Modal>
		</Show>
	);
}
