// Configurable CSV column badge formatting modal: inspect, edit, disable,
// or extend which CSV columns render values as colored badges and which
// values map to which tones (with STARLIMS and registry presets).
import { createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import type { Table } from "../../shared/csv";
import {
	BADGE_TONES,
	cloneCsvTableConfig,
	CSV_STATUS_PRESETS,
	DEFAULT_CSV_TABLE_CONFIG,
	distinctTableValuesForColumns,
	effectiveCsvTableConfig,
	ensureRuleForColumn,
	type BadgeTone,
	type CsvBadgeRule,
	type CsvStatusPresetId,
	type CsvTableConfig,
} from "../../shared/csvFormat";
import type { SettingsScope } from "../../shared/protocol";
import { backend } from "../backend";
import { Icon } from "../Icon";
import { Modal } from "../modal";
import { notify, saveSetting, state } from "../state";

type DraftEntry = { id: number; value: string; tone: BadgeTone };
type DraftRule = {
	id: number;
	columnsText: string;
	fallback: BadgeTone | "none";
	entries: DraftEntry[];
	search: string;
};

let nextId = 1;
const uid = () => nextId++;

function parseColumns(text: string): string[] {
	return [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];
}

function toDraftRules(rules: readonly CsvBadgeRule[]): DraftRule[] {
	return rules.map((r) => ({
		id: uid(),
		columnsText: r.columns.join(", "),
		fallback: r.fallback ?? "waiting",
		entries: Object.entries(r.values).map(([value, tone]) => ({ id: uid(), value, tone })),
		search: "",
	}));
}

function fromDraft(badgeFormatting: boolean, rules: readonly DraftRule[]): CsvTableConfig {
	const out: CsvBadgeRule[] = [];
	for (const r of rules) {
		const columns = parseColumns(r.columnsText);
		if (!columns.length) continue;
		const values: Record<string, BadgeTone> = {};
		for (const e of r.entries) {
			const key = e.value.trim();
			if (key) values[key] = e.tone;
		}
		out.push({ columns, values, fallback: r.fallback });
	}
	return { badgeFormatting, rules: out };
}

export function CsvFormatDialog(props: {
	table: Table;
	/** Optional column name to focus (creating a draft rule seeded from this table if needed). */
	initialColumn?: string;
	onClose: () => void;
}) {
	const titleId = createUniqueId();
	const init = (() => {
		const base = effectiveCsvTableConfig(state.settings.csvTable);
		if (props.initialColumn?.trim()) {
			const samples = distinctTableValuesForColumns(props.table, [props.initialColumn]);
			const ensured = ensureRuleForColumn(base, props.initialColumn, samples);
			return { cfg: ensured.config, focusIdx: ensured.ruleIndex };
		}
		return { cfg: base, focusIdx: 0 };
	})();

	const [enabled, setEnabled] = createSignal(init.cfg.badgeFormatting);
	const [rules, setRules] = createSignal<DraftRule[]>(toDraftRules(init.cfg.rules));
	const [scope, setScope] = createSignal<SettingsScope>("user");
	const [saving, setSaving] = createSignal(false);

	onMount(() => {
		if (!state.workspace) return;
		void backend.settings().then(
			(layers) => {
				if ("csvTable" in layers.workspace) setScope("workspace");
			},
			() => {},
		);
	});

	const updateRule = (id: number, patch: (r: DraftRule) => DraftRule) => {
		setRules((list) => list.map((r) => (r.id === id ? patch(r) : r)));
	};

	const removeRule = (id: number) => {
		setRules((list) => list.filter((r) => r.id !== id));
	};

	const addRule = () => {
		const existingCols = new Set(rules().flatMap((r) => parseColumns(r.columnsText).map((c) => c.toLowerCase())));
		const firstUnused = props.table.header.map((h) => h.text.trim()).find((name) => name && !existingCols.has(name.toLowerCase())) ?? "";
		const samples = firstUnused ? distinctTableValuesForColumns(props.table, [firstUnused]).slice(0, 12) : [];
		setEnabled(true);
		setRules((list) => [
			...list,
			{
				id: uid(),
				columnsText: firstUnused,
				fallback: "waiting",
				entries: samples.map((value) => ({ id: uid(), value, tone: "waiting" as BadgeTone })),
				search: "",
			},
		]);
	};

	const addEntry = (ruleId: number) => {
		updateRule(ruleId, (r) => ({
			...r,
			search: "",
			entries: [...r.entries, { id: uid(), value: "", tone: "active" }],
		}));
	};

	const updateEntry = (ruleId: number, entryId: number, patch: Partial<DraftEntry>) => {
		updateRule(ruleId, (r) => ({
			...r,
			entries: r.entries.map((e) => (e.id === entryId ? { ...e, ...patch } : e)),
		}));
	};

	const removeEntry = (ruleId: number, entryId: number) => {
		updateRule(ruleId, (r) => ({
			...r,
			entries: r.entries.filter((e) => e.id !== entryId),
		}));
	};

	const unmappedFromTable = (rule: DraftRule): string[] => {
		const cols = parseColumns(rule.columnsText);
		if (!cols.length) return [];
		const already = new Set(rule.entries.map((e) => e.value.trim().toLowerCase()).filter(Boolean));
		return distinctTableValuesForColumns(props.table, cols).filter((v) => !already.has(v.toLowerCase()));
	};

	const importFromTable = (ruleId: number) => {
		updateRule(ruleId, (r) => {
			const missing = unmappedFromTable(r);
			if (!missing.length) return r;
			return {
				...r,
				search: "",
				entries: [...r.entries, ...missing.map((value) => ({ id: uid(), value, tone: "waiting" as BadgeTone }))],
			};
		});
	};

	const applyPreset = (id: CsvStatusPresetId) => {
		const preset = CSV_STATUS_PRESETS.find((p) => p.id === id);
		if (!preset) return;
		const cloned = cloneCsvTableConfig(preset.config);
		setEnabled(cloned.badgeFormatting);
		setRules(toDraftRules(cloned.rules));
	};

	const resetDefaults = () => {
		const cloned = cloneCsvTableConfig(DEFAULT_CSV_TABLE_CONFIG);
		setEnabled(cloned.badgeFormatting);
		setRules(toDraftRules(cloned.rules));
	};

	const save = async () => {
		if (saving()) return;
		setSaving(true);
		try {
			const next = fromDraft(enabled(), rules());
			await saveSetting({ csvTable: next }, scope());
			notify(next.badgeFormatting ? `Saved CSV column formatting (${next.rules.length} ${next.rules.length === 1 ? "rule" : "rules"}).` : "Turned off CSV column badge formatting.");
			props.onClose();
		} catch (e: any) {
			notify(`Could not save CSV column formatting: ${e?.message ?? e}`, "error");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal class="dialog csv-fmt-dialog" labelledBy={titleId} onClose={props.onClose}>
			<div class="csv-fmt-head">
				<div>
					<h2 id={titleId}>CSV column formatting</h2>
					<p class="csv-fmt-sub">Configure which columns render values as colored badges and how each value is styled.</p>
				</div>
				<button type="button" class="icon-btn" aria-label="Close" title="Close (Esc)" onClick={props.onClose}>
					<Icon name="close" />
				</button>
			</div>

			<div class="csv-fmt-toolbar">
				<label class="csv-fmt-toggle">
					<input type="checkbox" checked={enabled()} onChange={(e) => setEnabled(e.currentTarget.checked)} />
					<span>Format matching columns as badges</span>
				</label>
				<div class="csv-fmt-presets">
					<select
						aria-label="Load a status preset"
						value=""
						onChange={(e) => {
							const id = e.currentTarget.value as CsvStatusPresetId | "";
							if (id) applyPreset(id);
							e.currentTarget.value = "";
						}}
					>
						<option value="">Load preset…</option>
						<For each={CSV_STATUS_PRESETS}>{(p) => <option value={p.id}>{p.name}</option>}</For>
					</select>
					<button type="button" onClick={resetDefaults} title="Restore default STARLIMS + Registry status rules">
						Reset defaults
					</button>
				</div>
			</div>

			<div class="csv-fmt-body" classList={{ dimmed: !enabled() }}>
				<Show when={rules().length} fallback={<p class="hint">No column formatting rules configured. Every CSV column will display as plain text.</p>}>
					<For each={rules()}>
						{(rule, idx) => {
							const filteredEntries = () => {
								const q = rule.search.trim().toLowerCase();
								return q ? rule.entries.filter((e) => e.value.toLowerCase().includes(q) || e.tone.includes(q)) : rule.entries;
							};
							const importable = () => unmappedFromTable(rule);
							return (
								<section class="csv-fmt-rule" aria-label={`Formatting rule ${idx() + 1}`}>
									<div class="csv-fmt-rule-head">
										<label class="csv-fmt-field csv-fmt-cols">
											<span>Column names (comma-separated)</span>
											<input
												type="text"
												data-autofocus={idx() === init.focusIdx ? "" : undefined}
												placeholder="e.g. status, state, sample_status"
												value={rule.columnsText}
												onInput={(e) => updateRule(rule.id, (r) => ({ ...r, columnsText: e.currentTarget.value }))}
											/>
										</label>
										<label class="csv-fmt-field csv-fmt-fallback">
											<span>Unlisted values</span>
											<select
												value={rule.fallback}
												onChange={(e) => updateRule(rule.id, (r) => ({ ...r, fallback: e.currentTarget.value as BadgeTone | "none" }))}
											>
												<option value="none">Plain text (no badge)</option>
												<For each={BADGE_TONES}>{(t) => <option value={t.id}>{t.label}</option>}</For>
											</select>
										</label>
										<button
											type="button"
											class="icon-btn csv-fmt-rule-del"
											title="Remove this formatting rule"
											aria-label="Remove formatting rule"
											onClick={() => removeRule(rule.id)}
										>
											<Icon name="trash" />
										</button>
									</div>

									<div class="csv-fmt-values-bar">
										<span class="csv-fmt-values-count">
											Value styles ({rule.entries.length})
										</span>
										<Show when={rule.entries.length > 6}>
											<input
												type="search"
												class="csv-fmt-values-search"
												placeholder="Filter values…"
												aria-label="Filter value styles"
												value={rule.search}
												onInput={(e) => updateRule(rule.id, (r) => ({ ...r, search: e.currentTarget.value }))}
											/>
										</Show>
										<span class="spacer" />
										<Show when={importable().length > 0}>
											<button type="button" onClick={() => importFromTable(rule.id)} title={`Add ${importable().join(", ")} from this table`}>
												+ Import {importable().length} from table
											</button>
										</Show>
										<button type="button" onClick={() => addEntry(rule.id)}>
											<Icon name="add" /> Value
										</button>
									</div>

									<Show when={filteredEntries().length} fallback={<p class="csv-fmt-empty">{rule.entries.length ? "No values match your filter." : "No explicit value mappings yet — unlisted values use the style above."}</p>}>
										<div class="csv-fmt-entries">
											<For each={filteredEntries()}>
												{(entry) => (
													<div class="csv-fmt-entry">
														<input
															type="text"
															placeholder="Value (e.g. Approved)"
															aria-label="Cell value"
															value={entry.value}
															onInput={(e) => updateEntry(rule.id, entry.id, { value: e.currentTarget.value })}
														/>
														<select
															aria-label={`Tone for ${entry.value || "value"}`}
															value={entry.tone}
															onChange={(e) => updateEntry(rule.id, entry.id, { tone: e.currentTarget.value as BadgeTone })}
														>
															<For each={BADGE_TONES}>{(t) => <option value={t.id}>{t.label}</option>}</For>
														</select>
														<span class="csv-fmt-preview">
															<span class={`doc-status tone-${entry.tone}`}>{entry.value.trim() || "sample"}</span>
														</span>
														<button
															type="button"
															class="icon-btn"
															title="Remove value"
															aria-label={`Remove ${entry.value || "value"}`}
															onClick={() => removeEntry(rule.id, entry.id)}
														>
															<Icon name="close" />
														</button>
													</div>
												)}
											</For>
										</div>
									</Show>
								</section>
							);
						}}
					</For>
				</Show>
				<div class="csv-fmt-add-row">
					<button type="button" onClick={addRule}>
						<Icon name="add" /> Add column rule
					</button>
				</div>
			</div>

			<div class="csv-fmt-foot">
				<Show when={state.workspace} fallback={<span class="settings-scope">Saved for you</span>}>
					<div class="csv-fmt-scope" role="radiogroup" aria-label="Where to save CSV formatting">
						<label>
							<input type="radio" name="csv-fmt-scope" checked={scope() === "workspace"} onChange={() => setScope("workspace")} />
							<span>Save for this project</span>
						</label>
						<label>
							<input type="radio" name="csv-fmt-scope" checked={scope() === "user"} onChange={() => setScope("user")} />
							<span>Save for you</span>
						</label>
					</div>
				</Show>
				<span class="spacer" />
				<button type="button" onClick={props.onClose}>
					Cancel
				</button>
				<button type="button" class="primary" disabled={saving()} onClick={() => void save()}>
					{saving() ? "Saving…" : "Save"}
				</button>
			</div>
		</Modal>
	);
}
