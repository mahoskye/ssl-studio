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
import { createSignal, createUniqueId, For, Show, type JSX } from "solid-js";
import type { Settings } from "../shared/protocol";
import { backend } from "./backend";
import { commands, DEFAULT_KEYS, keymap, keysFor, onOpenSettings } from "./commands";
import { choose } from "./dialogs";
import { bindable, conflict, displayKey, isModifierKey, keyNames, rebind, unbind } from "./keys";
import { Modal } from "./modal";
import { matchWords } from "./quickRank";
import { loadSettings, notify, saveSetting, state, syncLivePreviewMode } from "./state";
import { clampScale, stepScale, UI_SCALE } from "./uiScale";

type Layers = { user: Partial<Settings>; workspace: Partial<Settings> };
type Group = "Appearance" | "Editor" | "Language server" | "Keyboard";

const FONT = { min: 8, max: 32, normal: 13 };

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
	const save = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
		await saveSetting({ [key]: value } as Partial<Settings>, scopeOf(key));
		await loadLayers();
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
		e.preventDefault();
		e.stopImmediatePropagation();
		if (isModifierKey(e.key)) return true;
		if (e.key === "Escape") {
			setCapturing(null);
			return true;
		}
		const key = keyNames(e)[0]!;
		const check = bindable(key);
		if (!check.ok) {
			setRefused(check.why);
			return true;
		}
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
			if (!theme) return notify("Theme import needs the app's file dialog; copy the theme into ~/.config/ssl-studio/themes/ instead.");
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
							<span class="settings-scope" classList={{ project: scopeOf(p.setting) === "workspace" }}>
								{scopeOf(p.setting) === "workspace" ? "Saved for this project" : "Saved for you"}
							</span>
						</span>
					</div>
					<div class="settings-control" classList={{ wide: p.wide }}>
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
			<section class="settings-group" aria-label={p.title} ref={(el) => sections.set(p.title, el)}>
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
		editor: () => anyShown("Editor", "formatOnSave", "sqlDialect", "minimap", "wordWrap", "livePreview", "markdownReadingHighlight", "inlayHints", "rulers", "rulerMargin", "csvTable", "attachmentsFolder", "templatesFolder"),
		server: () => anyShown("Language server", "lspPath"),
		keyboard: () => keyRows().length > 0,
	};

	const parsedOklch = () => parseOklchThemeId(state.settings.theme);
	const isWarmMode = () => state.settings.theme === "system" || parsedOklch() !== null;
	const activeMaterial = (): ThemeMaterial => {
		const p = parsedOklch();
		if (p) return p.material;
		return isThemeMaterial(state.settings.themeMaterial) ? state.settings.themeMaterial : DEFAULT_MATERIAL;
	};
	const pickTone = (tone: "system" | ThemeTone) => {
		const mat = activeMaterial();
		if (tone === "system") void saveSetting({ theme: "system", themeMaterial: mat }, scopeOf("theme")).then(loadLayers);
		else void saveSetting({ theme: oklchThemeId(tone, mat), themeMaterial: mat }, scopeOf("theme")).then(loadLayers);
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
					onChange={(e) => {
						const val = e.currentTarget.value;
						if (val === "__custom__") setCustomizing(true);
						else {
							setCustomizing(false);
							void save(p.setting, val);
						}
					}}
				>
					<For each={p.presets}>{(item) => <option value={item.id}>{item.label}</option>}</For>
					<option value="__custom__">Custom local font…</option>
				</select>
				<Show when={showInput()}>
					<input
						type="text"
						aria-label={`${ROWS[p.setting][0]} family name`}
						placeholder={p.placeholder}
						value={current()}
						onChange={(e) => {
							const val = e.currentTarget.value.trim();
							if (!val) setCustomizing(false);
							void save(p.setting, val);
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
				<input class="settings-search" data-autofocus aria-label="Search settings" placeholder="Search settings" autocomplete="off" spellcheck={false} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} onMouseDown={() => setCapturing(null)} />
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
							{(ids) => (
								<div class="settings-theme">
									<div class="settings-theme-bar" role="group" aria-label="Surface tone" aria-describedby={ids.hint}>
										<button
											type="button"
											aria-pressed={state.settings.theme === "system"}
											classList={{ active: state.settings.theme === "system" }}
											onClick={() => pickTone("system")}
										>
											System
										</button>
										<For each={TONES}>
											{(tone) => (
												<button
													type="button"
													aria-pressed={parsedOklch()?.tone === tone}
													classList={{ active: parsedOklch()?.tone === tone }}
													onClick={() => pickTone(tone)}
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
														class="settings-swatch"
														aria-pressed={active()}
														classList={{ active: active() }}
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
											id={ids.control}
											aria-label="Classic or imported theme"
											aria-describedby={ids.hint}
											value={isWarmMode() ? "__warm__" : state.settings.theme}
											onChange={(e) => {
												const val = e.currentTarget.value;
												if (val === "__warm__") pickTone("system");
												else void save("theme", val);
											}}
										>
											<option value="__warm__">Warm Material (chosen above)</option>
											<option value="dark">Studio Dark (Classic)</option>
											<option value="light">Studio Light (Classic)</option>
											<For each={state.themes}>{(t) => <option value={t.id}>{t.name}</option>}</For>
										</select>
										<button type="button" onClick={() => void importTheme()}>
											Import…
										</button>
									</div>
								</div>
							)}
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
								<input
									id={ids.control}
									aria-describedby={ids.hint}
									type="number"
									min={FONT.min}
									max={FONT.max}
									value={state.settings.fontSize}
									onChange={(e) => void save("fontSize", Math.min(FONT.max, Math.max(FONT.min, Math.round(Number(e.currentTarget.value)) || FONT.normal)))}
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
							{(ids) => <input id={ids.control} aria-describedby={ids.hint} type="checkbox" checked={state.settings.menuBar !== false} onChange={(e) => void save("menuBar", e.currentTarget.checked)} />}
						</Row>
					</Section>
					<Section title="Editor" when={groups.editor()}>
						<Row group="Editor" label={ROWS.formatOnSave[0]} hint={ROWS.formatOnSave[1]} setting="formatOnSave">
							{(ids) => <input id={ids.control} aria-describedby={ids.hint} type="checkbox" checked={state.settings.formatOnSave} onChange={(e) => void save("formatOnSave", e.currentTarget.checked)} />}
						</Row>
						<Row group="Editor" label={ROWS.sqlDialect[0]} hint={ROWS.sqlDialect[1]} setting="sqlDialect">
							{(ids) => (
								<select
									id={ids.control}
									aria-describedby={ids.hint}
									value={state.settings.sqlDialect ?? DEFAULT_SQL_DIALECT}
									onChange={(e) => void save("sqlDialect", e.currentTarget.value as SqlDialect)}
								>
									<For each={SQL_DIALECTS}>{(d) => <option value={d.id}>{d.label}</option>}</For>
								</select>
							)}
						</Row>
						<Row group="Editor" label={ROWS.minimap[0]} hint={ROWS.minimap[1]} setting="minimap">
							{(ids) => <input id={ids.control} aria-describedby={ids.hint} type="checkbox" checked={state.settings.minimap} onChange={(e) => void save("minimap", e.currentTarget.checked)} />}
						</Row>
						<Row group="Editor" label={ROWS.wordWrap[0]} hint={ROWS.wordWrap[1]} setting="wordWrap">
							{(ids) => <input id={ids.control} aria-describedby={ids.hint} type="checkbox" checked={Boolean(state.settings.wordWrap)} onChange={(e) => void save("wordWrap", e.currentTarget.checked)} />}
						</Row>
						<Row group="Editor" label={ROWS.livePreview[0]} hint={ROWS.livePreview[1]} setting="livePreview">
							{(ids) => (
								<input
									id={ids.control}
									aria-describedby={ids.hint}
									type="checkbox"
									checked={state.settings.livePreview !== false}
									onChange={(e) => {
										const checked = e.currentTarget.checked;
										syncLivePreviewMode(checked);
										void save("livePreview", checked);
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
									onChange={(e) => void save("markdownReadingHighlight", e.currentTarget.checked)}
								/>
							)}
						</Row>
						<Row group="Editor" label={ROWS.inlayHints[0]} hint={ROWS.inlayHints[1]} setting="inlayHints">
							{(ids) => <input id={ids.control} aria-describedby={ids.hint} type="checkbox" checked={state.settings.inlayHints !== false} onChange={(e) => void save("inlayHints", e.currentTarget.checked)} />}
						</Row>
						<Row group="Editor" label={ROWS.rulers[0]} hint={ROWS.rulers[1]} setting="rulers">
							{(ids) => <input id={ids.control} aria-describedby={ids.hint} type="checkbox" checked={state.settings.rulers !== false} onChange={(e) => void save("rulers", e.currentTarget.checked)} />}
						</Row>
						<Row group="Editor" label={ROWS.rulerMargin[0]} hint={ROWS.rulerMargin[1]} setting="rulerMargin">
							{(ids) => (
								<input
									id={ids.control}
									aria-describedby={ids.hint}
									type="number"
									min="0"
									max="60"
									disabled={state.settings.rulers === false}
									value={state.settings.rulerMargin ?? RULER_MARGIN}
									onChange={(e) => void save("rulerMargin", Math.min(60, Math.max(0, Math.round(Number(e.currentTarget.value)) || 0)))}
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
											onChange={(e) => void save("csvTable", { ...cfg(), badgeFormatting: e.currentTarget.checked })}
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
								<input
									id={ids.control}
									aria-describedby={ids.hint}
									type="text"
									placeholder="docs/attachments"
									value={state.settings.attachmentsFolder ?? ""}
									onChange={(e) => void save("attachmentsFolder", e.currentTarget.value.trim() || undefined)}
								/>
							)}
						</Row>
						<Row group="Editor" label={ROWS.templatesFolder[0]} hint={ROWS.templatesFolder[1]} setting="templatesFolder" wide>
							{(ids) => (
								<input
									id={ids.control}
									aria-describedby={ids.hint}
									type="text"
									placeholder="docs/templates"
									value={state.settings.templatesFolder ?? ""}
									onChange={(e) => void save("templatesFolder", e.currentTarget.value.trim() || undefined)}
								/>
							)}
						</Row>
					</Section>
					<Section title="Language server" when={groups.server()}>
						<Row group="Language server" label={ROWS.lspPath[0]} hint={ROWS.lspPath[1]} setting="lspPath" wide>
							{(ids) => (
								<input
									id={ids.control}
									aria-describedby={ids.hint}
									autocomplete="off"
									spellcheck={false}
									placeholder={state.info?.lsp.path ?? "Found automatically"}
									value={state.settings.lspPath ?? ""}
									onChange={(e) => void save("lspPath", e.currentTarget.value.trim())}
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
