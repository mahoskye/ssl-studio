// Configurable CSV column badge formatting and per-column header filtering.
// Nothing about how a CSV column is badged is hard-coded "magic": defaults
// (including common STARLIMS and migration-registry statuses) are plain data
// that can be inspected, edited, disabled, or extended per project or user.
import { compareCellText, type Cell, type Table } from "./csv";

/** Semantic visual badge tones mapped to theme variables (WCAG AA across all themes). */
export type BadgeTone = "done" | "active" | "waiting" | "warn" | "error" | "off";

export const BADGE_TONES: readonly { id: BadgeTone; label: string }[] = [
	{ id: "done", label: "Done (green)" },
	{ id: "active", label: "Active (accent)" },
	{ id: "waiting", label: "Waiting (neutral)" },
	{ id: "warn", label: "Warning (amber)" },
	{ id: "error", label: "Error (red)" },
	{ id: "off", label: "Off / retired (muted)" },
];

export const VALID_BADGE_TONES = new Set<string>(BADGE_TONES.map((t) => t.id));

export type CsvBadgeRule = {
	/** Column header names (matched case-insensitively) styled by this rule. */
	columns: string[];
	/** Case-insensitive value -> semantic tone map; keys are also offered as cell suggestions. */
	values: Record<string, BadgeTone>;
	/** How non-empty values not listed in `values` are styled; `"none"` leaves them plain text. */
	fallback?: BadgeTone | "none";
};

export type CsvColumnFormatRule = CsvBadgeRule;

export type CsvTableConfig = {
	/** Master toggle for CSV column badge formatting. */
	badgeFormatting: boolean;
	/** Ordered list of column formatting rules; first rule matching a header wins. */
	rules: CsvBadgeRule[];
};

const REGISTRY_STATUS_VALUES: Record<string, BadgeTone> = {
	verified: "done",
	migrated: "done",
	done: "done",
	"in progress": "active",
	found: "waiting",
	open: "waiting",
	pending: "waiting",
	changed: "warn",
	blocked: "error",
	"not needed": "off",
	dropped: "off",
	gone: "off",
};

/** Common STARLIMS sample, folder, test, and result lifecycle statuses. */
const STARLIMS_STATUS_VALUES: Record<string, BadgeTone> = {
	Prelogged: "waiting",
	Unreceived: "waiting",
	Waiting: "waiting",
	Queued: "waiting",
	Scheduled: "waiting",
	Logged: "active",
	Received: "active",
	InPrep: "active",
	"In Progress": "active",
	Testing: "active",
	Review: "active",
	"In Review": "active",
	Completed: "done",
	Complete: "done",
	Approved: "done",
	Authorized: "done",
	Released: "done",
	"On Hold": "warn",
	Hold: "warn",
	Retest: "warn",
	OOS: "warn",
	Flagged: "warn",
	Rejected: "error",
	Failed: "error",
	Cancelled: "off",
	Canceled: "off",
	Disposed: "off",
};

/** Case-insensitively deduplicates a badge value -> tone map (later case-colliding entries override earlier ones). */
function dedupeBadgeValues(raw: Record<string, unknown>): Record<string, BadgeTone> {
	const out: Record<string, BadgeTone> = {};
	const keyByLower = new Map<string, string>();
	for (const [k, v] of Object.entries(raw)) {
		const key = k.trim();
		if (!key || typeof v !== "string" || !VALID_BADGE_TONES.has(v)) continue;
		const lower = key.toLowerCase();
		const prev = keyByLower.get(lower);
		if (prev !== undefined && prev !== key) delete out[prev];
		keyByLower.set(lower, key);
		out[key] = v as BadgeTone;
	}
	return out;
}

export type CsvStatusPresetId = "default" | "starlims" | "registry";

export const CSV_STATUS_PRESETS: readonly { id: CsvStatusPresetId; name: string; about: string; config: CsvTableConfig }[] = [
	{
		id: "default",
		name: "STARLIMS + Registry statuses (default)",
		about: "Formats status columns with both STARLIMS lifecycle statuses and migration registry statuses.",
		config: {
			badgeFormatting: true,
			rules: [
				{
					columns: ["status", "state", "sample_status", "result_status"],
					values: dedupeBadgeValues({ ...REGISTRY_STATUS_VALUES, ...STARLIMS_STATUS_VALUES }),
					fallback: "waiting",
				},
			],
		},
	},
	{
		id: "starlims",
		name: "STARLIMS lifecycle statuses",
		about: "Formats STARLIMS sample, folder, and result status columns; leaves unrecognized values plain.",
		config: {
			badgeFormatting: true,
			rules: [
				{
					columns: ["status", "sample_status", "result_status", "folder_status"],
					values: { ...STARLIMS_STATUS_VALUES },
					fallback: "none",
				},
			],
		},
	},
	{
		id: "registry",
		name: "Migration registry statuses",
		about: "Formats only the registry workflow statuses (found, in progress, migrated, verified, blocked, not needed).",
		config: {
			badgeFormatting: true,
			rules: [
				{
					columns: ["status"],
					values: { ...REGISTRY_STATUS_VALUES },
					fallback: "waiting",
				},
			],
		},
	},
];

export const DEFAULT_CSV_TABLE_CONFIG: CsvTableConfig = CSV_STATUS_PRESETS[0]!.config;

export function cloneCsvTableConfig(config: CsvTableConfig): CsvTableConfig {
	return {
		badgeFormatting: config.badgeFormatting,
		rules: config.rules.map((r) => ({
			columns: [...r.columns],
			values: { ...r.values },
			fallback: r.fallback ?? "waiting",
		})),
	};
}

/** Sanitizes and resolves a saved partial CSV table config against defaults without mutating defaults. */
export function effectiveCsvTableConfig(saved?: Partial<CsvTableConfig> | null): CsvTableConfig {
	if (!saved) return cloneCsvTableConfig(DEFAULT_CSV_TABLE_CONFIG);
	const badgeFormatting = saved.badgeFormatting !== false;
	if (!Array.isArray(saved.rules)) {
		return { badgeFormatting, rules: cloneCsvTableConfig(DEFAULT_CSV_TABLE_CONFIG).rules };
	}
	const rules: CsvBadgeRule[] = [];
	for (const raw of saved.rules) {
		if (!raw || typeof raw !== "object") continue;
		const columns: string[] = [];
		const seenCols = new Set<string>();
		if (Array.isArray(raw.columns)) {
			for (const c of raw.columns) {
				const trimmed = typeof c === "string" ? c.trim() : "";
				if (!trimmed) continue;
				const lower = trimmed.toLowerCase();
				if (seenCols.has(lower)) continue;
				seenCols.add(lower);
				columns.push(trimmed);
			}
		}
		const values =
			raw.values && typeof raw.values === "object" && !Array.isArray(raw.values)
				? dedupeBadgeValues(raw.values as Record<string, unknown>)
				: {};
		const fallback: BadgeTone | "none" =
			raw.fallback === "none" ? "none" : typeof raw.fallback === "string" && VALID_BADGE_TONES.has(raw.fallback) ? (raw.fallback as BadgeTone) : "waiting";
		if (columns.length) rules.push({ columns, values, fallback });
	}
	return { badgeFormatting, rules };
}

/** Returns the active badge formatting rule for a CSV column header, or null if none applies. */
export function ruleForColumn(config: CsvTableConfig, headerName: string): CsvBadgeRule | null {
	if (!config.badgeFormatting) return null;
	const target = headerName.trim().toLowerCase();
	if (!target) return null;
	for (const rule of config.rules) {
		if (rule.columns.some((c) => c.trim().toLowerCase() === target)) return rule;
	}
	return null;
}

/** Resolves the visual badge tone for a cell value under `rule`, or null to render as plain text. */
export function badgeToneForValue(rule: CsvBadgeRule | null, rawValue: string): BadgeTone | null {
	if (!rule) return null;
	const trimmed = rawValue.trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	let matched: BadgeTone | undefined;
	for (const [key, tone] of Object.entries(rule.values)) {
		if (key.trim().toLowerCase() === lower) matched = tone;
	}
	if (matched !== undefined) return matched;
	if (rule.fallback === "none") return null;
	return rule.fallback ?? "waiting";
}

/**
 * True when a column has an explicit badge rule with non-empty `values`, the cell
 * is non-empty, and `value` does not match any configured canonical value
 * (case-insensitive) — used to flag typos like `verifed` or `in progres`.
 */
export function isUnrecognizedBadgeValue(rule: CsvColumnFormatRule | null | undefined, value: string): boolean {
	if (!rule) return false;
	const keys = Object.keys(rule.values);
	if (!keys.length) return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	const lower = trimmed.toLowerCase();
	return !keys.some((key) => key.trim().toLowerCase() === lower);
}

/** Returns the configured canonical `{ value, tone }` badge options for a column rule (deduplicated case-insensitively). */
export function knownBadgeValues(rule: CsvColumnFormatRule | null | undefined): { value: string; tone: BadgeTone }[] {
	if (!rule) return [];
	const byLower = new Map<string, { value: string; tone: BadgeTone }>();
	for (const [key, tone] of Object.entries(rule.values)) {
		const trimmed = key.trim();
		if (!trimmed) continue;
		const lower = trimmed.toLowerCase();
		byLower.delete(lower);
		byLower.set(lower, { value: trimmed, tone });
	}
	return [...byLower.values()];
}

/** Autocomplete values for editing a cell in a badged column: existing table values followed by the rule's configured values. */
export function suggestionsForColumn(rule: CsvBadgeRule | null, existingValues: readonly string[]): string[] {
	if (!rule) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push(trimmed);
	};
	for (const v of existingValues) add(v);
	for (const k of Object.keys(rule.values)) add(k);
	return out;
}

/** Removes `headerName` from any matching badge rule (pruning rules left with no columns). */
export function removeColumnFromRules(config: CsvTableConfig, headerName: string): CsvTableConfig {
	const target = headerName.trim().toLowerCase();
	const next = cloneCsvTableConfig(config);
	next.rules = next.rules
		.map((rule) => ({
			...rule,
			columns: rule.columns.filter((c) => c.trim().toLowerCase() !== target),
		}))
		.filter((rule) => rule.columns.length > 0);
	return next;
}

/**
 * Ensures a rule exists for `headerName` (returning its index). If none matches yet, appends a
 * new rule seeded with `sampleValues` (assigned neutral `"waiting"` tone) and turns on `badgeFormatting`.
 */
export function ensureRuleForColumn(
	config: CsvTableConfig,
	headerName: string,
	sampleValues: readonly string[],
): { config: CsvTableConfig; ruleIndex: number } {
	const next = cloneCsvTableConfig(config);
	next.badgeFormatting = true;
	const target = headerName.trim().toLowerCase();
	const existing = next.rules.findIndex((r) => r.columns.some((c) => c.trim().toLowerCase() === target));
	if (existing >= 0) return { config: next, ruleIndex: existing };
	const values: Record<string, BadgeTone> = {};
	const seen = new Set<string>();
	for (const raw of sampleValues) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const low = trimmed.toLowerCase();
		if (seen.has(low)) continue;
		seen.add(low);
		values[trimmed] = "waiting";
		if (seen.size >= 25) break;
	}
	next.rules.push({ columns: [headerName.trim()], values, fallback: "waiting" });
	return { config: next, ruleIndex: next.rules.length - 1 };
}

// --- Per-column header filtering --------------------------------------------

export type ColumnFilter = {
	/** Case-insensitive substring filter for this column ("" when unused). */
	text: string;
	/**
	 * Normalized (`trim().toLowerCase()`) allowed values for this column.
	 * `""` represents empty cells. `null` means all values are allowed.
	 */
	values: Set<string> | null;
};

export type ColumnFilters = ReadonlyMap<number, ColumnFilter>;

export type ColumnValueOption = {
	/** Normalized key (`trim().toLowerCase()`; `""` for empty cells). */
	key: string;
	/** Display label (first non-empty spelling seen in the table, or `""` for empty). */
	label: string;
	/** Matching row count under all OTHER active filters (faceted count). */
	count: number;
	/** Total row count across the unfiltered table. */
	total: number;
};

export const normalizeCellKey = (text: string | undefined) => (text ?? "").trim().toLowerCase();

export function isColumnFilterActive(filter: ColumnFilter | undefined): boolean {
	if (!filter) return false;
	return Boolean(filter.text.trim()) || filter.values !== null;
}

export function cellMatchesColumnFilter(cellText: string | undefined, filter: ColumnFilter | undefined): boolean {
	if (!filter) return true;
	const raw = cellText ?? "";
	const needle = filter.text.trim().toLowerCase();
	if (needle && !raw.toLowerCase().includes(needle)) return false;
	if (filter.values !== null && !filter.values.has(normalizeCellKey(raw))) return false;
	return true;
}

/** True when `cells` satisfies every active column filter (optionally excluding `skipColumn` for faceted counts). */
export function rowMatchesColumnFilters(cells: readonly Cell[], filters: ColumnFilters, skipColumn?: number): boolean {
	for (const [col, filter] of filters) {
		if (col === skipColumn) continue;
		if (!cellMatchesColumnFilter(cells[col]?.text, filter)) return false;
	}
	return true;
}

/**
 * Computes distinct value options and faceted counts for `column`.
 * `baseRows` are rows already filtered by global/ticket/missing filters (before column filters).
 */
export function columnValueOptions(
	allRows: readonly (readonly Cell[])[],
	baseRows: readonly (readonly Cell[])[],
	column: number,
	filters: ColumnFilters,
): ColumnValueOption[] {
	const totals = new Map<string, { label: string; total: number; count: number }>();
	for (const cells of allRows) {
		const raw = (cells[column]?.text ?? "").trim();
		const key = raw.toLowerCase();
		const entry = totals.get(key);
		if (entry) entry.total++;
		else totals.set(key, { label: raw, total: 1, count: 0 });
	}
	for (const cells of baseRows) {
		if (!rowMatchesColumnFilters(cells, filters, column)) continue;
		const raw = (cells[column]?.text ?? "").trim();
		const key = raw.toLowerCase();
		const entry = totals.get(key);
		if (entry) entry.count++;
		else totals.set(key, { label: raw, total: 0, count: 1 });
	}
	return [...totals.entries()]
		.map(([key, info]) => ({ key, label: info.label, count: info.count, total: info.total }))
		.sort((a, b) => {
			// Active matches first, then higher count, then empty last, then natural alphabetical.
			if ((a.count > 0) !== (b.count > 0)) return a.count > 0 ? -1 : 1;
			if (b.count !== a.count) return b.count - a.count;
			if ((a.key === "") !== (b.key === "")) return a.key === "" ? 1 : -1;
			return compareCellText(a.label, b.label);
		});
}

/**
 * `columnValueOptions` for one state of a table and its filters: a column's options are worked out the first time
 * they are asked for and handed back as they are after that, however many ask (each filter chip, the header's
 * tooltip and the open filter menu ask for the same column).
 */
export function columnValueOptionsOnce(
	allRows: readonly (readonly Cell[])[],
	baseRows: readonly { cells: readonly Cell[] }[],
	filters: ColumnFilters,
): (column: number) => ColumnValueOption[] {
	let baseCells: (readonly Cell[])[] | undefined;
	const byColumn = new Map<number, ColumnValueOption[]>();
	return (column) => {
		let options = byColumn.get(column);
		if (!options) {
			baseCells ??= baseRows.map((r) => r.cells);
			options = columnValueOptions(allRows, baseCells, column, filters);
			byColumn.set(column, options);
		}
		return options;
	};
}

/** Toggles one normalized value key in a column's filter, collapsing back to `values: null` when every key is checked. */
export function toggleColumnFilterValue(
	current: ColumnFilter | undefined,
	key: string,
	allKeys: readonly string[],
): ColumnFilter | undefined {
	const text = current?.text ?? "";
	let nextSet: Set<string>;
	if (current?.values == null) {
		// Previously "all selected": uncheck just `key`.
		nextSet = new Set(allKeys.filter((k) => k !== key));
	} else {
		nextSet = new Set(current.values);
		if (nextSet.has(key)) nextSet.delete(key);
		else nextSet.add(key);
	}
	const allChecked = allKeys.length > 0 && allKeys.every((k) => nextSet.has(k));
	const nextValues = allChecked ? null : nextSet;
	if (!text.trim() && nextValues === null) return undefined;
	return { text, values: nextValues };
}

/** Human-readable short summary of an active column filter for toolbar chips and header tooltips. */
export function describeColumnFilter(header: string, filter: ColumnFilter, options: readonly ColumnValueOption[]): string {
	const parts: string[] = [];
	if (filter.text.trim()) parts.push(`“${filter.text.trim()}”`);
	if (filter.values !== null) {
		if (filter.values.size === 0) {
			parts.push("none");
		} else if (filter.values.size <= 2) {
			const labels = [...filter.values].map((k) => {
				if (k === "") return "(empty)";
				return options.find((o) => o.key === k)?.label || k;
			});
			parts.push(labels.join(", "));
		} else {
			parts.push(`${filter.values.size} selected`);
		}
	}
	return `${header || "Column"}: ${parts.join(" · ")}`;
}

/** Collects distinct non-empty values for all columns in `table` matching any name in `columns` (case-insensitive). */
export function distinctTableValuesForColumns(table: Pick<Table, "header" | "rows">, columns: readonly string[]): string[] {
	const wanted = new Set(columns.map((c) => c.trim().toLowerCase()).filter(Boolean));
	if (!wanted.size) return [];
	const indices: number[] = [];
	table.header.forEach((cell, i) => {
		if (wanted.has(cell.text.trim().toLowerCase())) indices.push(i);
	});
	const seen = new Set<string>();
	const out: string[] = [];
	for (const row of table.rows) {
		for (const col of indices) {
			const val = (row[col]?.text ?? "").trim();
			if (!val) continue;
			const low = val.toLowerCase();
			if (seen.has(low)) continue;
			seen.add(low);
			out.push(val);
		}
	}
	return out;
}

// --- Column freezing & reordering (visual projection; CSV unchanged until saved) ---

/** Keeps only valid, unique 0-based column indices within `[0, headerCount)`. */
export function pruneFrozenColumns(frozen: readonly number[], headerCount: number): number[] {
	const seen = new Set<number>();
	const out: number[] = [];
	for (const col of frozen) {
		if (!Number.isInteger(col) || col < 0 || col >= headerCount || seen.has(col)) continue;
		seen.add(col);
		out.push(col);
	}
	return out;
}

/** Keeps valid unique column indices from `order` and appends any missing indices in file order. */
export function pruneColumnOrder(order: readonly number[], headerCount: number): number[] {
	const seen = new Set<number>();
	const out: number[] = [];
	for (const col of order) {
		if (!Number.isInteger(col) || col < 0 || col >= headerCount || seen.has(col)) continue;
		seen.add(col);
		out.push(col);
	}
	for (let col = 0; col < headerCount; col++) {
		if (!seen.has(col)) out.push(col);
	}
	return out;
}

/** True when `order` matches the file's natural `0..length-1` column sequence. */
export function isNaturalOrder(order: readonly number[]): boolean {
	return order.every((col, idx) => col === idx);
}

/** Moves the element at `fromIndex` to `toIndex`, returning a new array. */
export function moveColumnInList(list: readonly number[], fromIndex: number, toIndex: number): number[] {
	if (fromIndex < 0 || fromIndex >= list.length) return [...list];
	const clampedTo = Math.max(0, Math.min(toIndex, list.length - 1));
	if (fromIndex === clampedTo) return [...list];
	const copy = [...list];
	const [moved] = copy.splice(fromIndex, 1);
	copy.splice(clampedTo, 0, moved!);
	return copy;
}

/** Maps an old 0-based column index to its new index after applying `appliedOrder` (`appliedOrder[newIdx] === oldIdx`). */
export function remapColumnIndex(oldCol: number, appliedOrder: readonly number[]): number {
	return appliedOrder.indexOf(oldCol);
}

/** Toggles `column` in the ordered frozen-columns list (appends when freezing, removes when unfreezing). */
export function toggleFrozenColumn(frozen: readonly number[], column: number): number[] {
	return frozen.includes(column) ? frozen.filter((c) => c !== column) : [...frozen, column];
}

/** Keeps valid unique hidden column indices within `[0, headerCount)`, always leaving at least one column visible. */
export function pruneHiddenColumns(hidden: ReadonlySet<number>, headerCount: number): Set<number> {
	const out = new Set<number>();
	if (headerCount <= 1) return out;
	for (const col of hidden) {
		if (!Number.isInteger(col) || col < 0 || col >= headerCount) continue;
		if (out.size >= headerCount - 1) break;
		out.add(col);
	}
	return out;
}

/** Hides `column` if doing so leaves at least one column visible; otherwise returns a copy of `hidden`. */
export function hideColumn(hidden: ReadonlySet<number>, column: number, headerCount: number): Set<number> {
	const next = pruneHiddenColumns(hidden, headerCount);
	if (!Number.isInteger(column) || column < 0 || column >= headerCount) return next;
	if (!next.has(column) && next.size < headerCount - 1) next.add(column);
	return next;
}

/** Shows (unhides) `column`. */
export function showColumn(hidden: ReadonlySet<number>, column: number): Set<number> {
	const next = new Set(hidden);
	next.delete(column);
	return next;
}

/**
 * Computes the complete left-to-right column permutation (including hidden
 * columns) used when saving column order back to the CSV file.
 */
export function fullColumnOrder(headerCount: number, frozen: readonly number[], baseOrder?: readonly number[]): number[] {
	const pinned = pruneFrozenColumns(frozen, headerCount);
	const pinnedSet = new Set(pinned);
	const base = baseOrder ? pruneColumnOrder(baseOrder, headerCount) : Array.from({ length: headerCount }, (_, i) => i);
	return [...pinned, ...base.filter((col) => !pinnedSet.has(col))];
}

/**
 * Computes the visual left-to-right column order: frozen columns first (in the
 * order they were frozen), followed by all remaining columns in `baseOrder`
 * (defaulting to file order `0..headerCount-1`), excluding any `hidden` columns.
 */
export function visualColumnOrder(
	headerCount: number,
	frozen: readonly number[],
	baseOrder?: readonly number[],
	hidden?: ReadonlySet<number>,
): number[] {
	const all = fullColumnOrder(headerCount, frozen, baseOrder);
	if (!hidden?.size) return all;
	const prunedHidden = pruneHiddenColumns(hidden, headerCount);
	return all.filter((col) => !prunedHidden.has(col));
}
