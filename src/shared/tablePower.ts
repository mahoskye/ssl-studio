// Pure TableView power helpers (ADR 0002 / ADR 0032): multi-column sorting,
// bounded workspace-scoped LRU view-state persistence, Excel fill-series
// progression, Markdown table serialization, Regex/Whole-Word/In-Selection cell
// matching, measured virtual-window math, auto-fit row sampling, and unified
// URL / ticket / schema / inline-issue classification. No DOM, Solid, or Monaco.
import { compareCellText } from "./csv";
import { isInside, plainFileError, relativeTo } from "./paths";
import { codeCheckSummary } from "./registryCheck";
import { keyOf } from "./registryTickets";

// --- Multi-column sorting ----------------------------------------------------

export type SortSpec = {
	column: number;
	down: boolean;
};

/**
 * Updates the active multi-column sort list when a user clicks a column header.
 * - Plain click: cycles `asc -> desc -> clear` if already the sole sort column;
 *   otherwise replaces sort with `[{ column, down: false }]`.
 * - Shift+Click: appends `{ column, down: false }` if absent, flips to `down: true`
 *   if ascending, or removes the column from the sort list if descending.
 */
export function toggleSortSpec(current: readonly SortSpec[], column: number, shiftKey: boolean): SortSpec[] {
	if (!shiftKey) {
		if (current.length === 1 && current[0]!.column === column) {
			return current[0]!.down ? [] : [{ column, down: true }];
		}
		return [{ column, down: false }];
	}
	const idx = current.findIndex((s) => s.column === column);
	if (idx < 0) return [...current, { column, down: false }];
	const existing = current[idx]!;
	if (!existing.down) {
		return current.map((s, i) => (i === idx ? { column, down: true } : s));
	}
	return current.filter((_, i) => i !== idx);
}

/** Explicitly sets a column's sort direction (replacing or appending/updating when `additive` is true). */
export function setColumnSortDirection(
	current: readonly SortSpec[],
	column: number,
	down: boolean,
	additive = false,
): SortSpec[] {
	if (!additive) return [{ column, down }];
	const idx = current.findIndex((s) => s.column === column);
	if (idx < 0) return [...current, { column, down }];
	return current.map((s, i) => (i === idx ? { column, down } : s));
}

// A number as the table's footer adds one up: digits, with or without a minus sign, a decimal part, or commas
// between groups of three.
const SORT_NUMBER_RE = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;

function trimmedSortNumber(t: string): number | null {
	// Most cells are text, and their first character says so without the pattern being run.
	const first = t.charCodeAt(0);
	if (!(first >= 48 && first <= 57) && first !== 45) return null;
	if (!SORT_NUMBER_RE.test(t)) return null;
	const digits = t.replace(/,/g, "");
	const dot = digits.indexOf(".");
	// More than fifteen digits are an identifier (a barcode, a key): a number cannot hold them exactly, and two
	// that differ in their last digit would count as equal. It stays text, which orders digits of any length.
	if ((dot < 0 ? digits.length : dot) - (first === 45 ? 1 : 0) > 15) return null;
	return Number(digits);
}

/** The number a cell holds, for ordering rows: `-5`, `1.5`, `1,200`. Null when what it holds is text, or nothing. */
export function cellSortNumber(raw: string): number | null {
	return trimmedSortNumber(raw.trim());
}

/**
 * Orders two cell texts for sorting rows. Going up: empty cells, then numbers by their value, then text as
 * `compareCellText` orders it (digits inside text by their number, case and accents aside); going down is the same
 * turned round. Whether a cell is a number is asked of the cell, not of its column, so a column of numbers with a
 * few words in it (`n/a`) still has its numbers in order, and the order of any three cells agrees with itself.
 * Numbers were ordered as text is: `-5` came after `-3`, `1.25` after `1.5`, and `1,200` before `300`.
 */
export function compareSortValues(a: string, b: string): number {
	const ta = a.trim();
	const tb = b.trim();
	const na = trimmedSortNumber(ta);
	const nb = trimmedSortNumber(tb);
	const kindA = na !== null ? 1 : ta === "" ? 0 : 2;
	const kindB = nb !== null ? 1 : tb === "" ? 0 : 2;
	if (kindA !== kindB) return kindA - kindB;
	if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
	return compareCellText(a, b);
}

/** Compares two rows across all active `SortSpec` entries, each column's cells as `compareSortValues` orders them. */
export function compareRowsBySorts<T>(
	a: T,
	b: T,
	sorts: readonly SortSpec[],
	getCellText: (row: T, column: number) => string,
): number {
	for (const spec of sorts) {
		const va = getCellText(a, spec.column);
		const vb = getCellText(b, spec.column);
		const cmp = compareSortValues(va, vb);
		if (cmp !== 0) return spec.down ? -cmp : cmp;
	}
	return 0;
}

/** Remaps column indices in a multi-column sort list (dropping removed columns and deduplicating). */
export function remapSortSpecs(sorts: readonly SortSpec[], remap: (col: number) => number): SortSpec[] {
	const out: SortSpec[] = [];
	const seen = new Set<number>();
	for (const spec of sorts) {
		const nextCol = remap(spec.column);
		if (nextCol < 0 || !Number.isInteger(nextCol) || seen.has(nextCol)) continue;
		seen.add(nextCol);
		out.push({ column: nextCol, down: spec.down });
	}
	return out;
}

/** Prunes out-of-range or duplicate entries from a multi-column sort list. */
export function pruneSortSpecs(sorts: readonly SortSpec[], colCount: number): SortSpec[] {
	return remapSortSpecs(sorts, (col) => (col >= 0 && col < colCount ? col : -1));
}

// --- Per-file view-state persistence (bounded LRU, max 40 files) -------------

export const TABLE_VIEW_STATE_MAX_FILES = 40;

export type TableViewStateSnapshot = {
	colWidths: Record<number, number>;
	frozenCols: number[];
	colOrder: number[];
	hiddenCols: number[];
	order: SortSpec[];
	groupByCol: number | null;
};

export type PersistedTableViewEntry = Partial<TableViewStateSnapshot> & {
	updatedAt: number;
};

export type TableViewStateStore = {
	version: 1;
	entries: Record<string, PersistedTableViewEntry>;
};

function normStoragePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Workspace-scoped `localStorage` key so view state never leaks across unrelated projects. */
export function tableViewStateStorageKey(workspaceRoot?: string | null): string {
	const root = workspaceRoot?.trim();
	return `ssl-studio.tableViewState.v1:${root ? normStoragePath(root) : "global"}`;
}

/** Canonical per-file key inside a workspace store (relative path when inside workspace). */
export function tableViewFileKey(filePath: string, workspaceRoot?: string | null): string {
	const root = workspaceRoot?.trim();
	if (root && isInside(root, filePath)) {
		return normStoragePath(relativeTo(root, filePath));
	}
	return normStoragePath(filePath);
}

/** True when every persisted visual field is at its clean default (no entry needed). */
export function isDefaultTableViewState(state: Partial<TableViewStateSnapshot>): boolean {
	const hasWidths = Boolean(state.colWidths && Object.keys(state.colWidths).length > 0);
	const hasFrozen = Boolean(state.frozenCols && state.frozenCols.length > 0);
	const hasOrder = Boolean(state.colOrder && state.colOrder.length > 0);
	const hasHidden = Boolean(state.hiddenCols && state.hiddenCols.length > 0);
	const hasSort = Boolean(state.order && state.order.length > 0);
	const hasGroup = state.groupByCol !== undefined && state.groupByCol !== null;
	return !hasWidths && !hasFrozen && !hasOrder && !hasHidden && !hasSort && !hasGroup;
}

/** Validates and normalizes an untrusted persisted view-state object, optionally pruning against `colCount`. */
export function sanitizeTableViewState(raw: unknown, colCount?: number): TableViewStateSnapshot | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const inRange = (c: number) => Number.isInteger(c) && c >= 0 && (colCount === undefined || c < colCount);

	const colWidths: Record<number, number> = {};
	if (obj.colWidths && typeof obj.colWidths === "object" && !Array.isArray(obj.colWidths)) {
		for (const [k, v] of Object.entries(obj.colWidths as Record<string, unknown>)) {
			const col = Number(k);
			if (!inRange(col)) continue;
			if (typeof v === "number" && Number.isFinite(v) && v >= 40 && v <= 2400) {
				colWidths[col] = Math.round(v);
			}
		}
	}

	const uniqueCols = (arr: unknown): number[] => {
		if (!Array.isArray(arr)) return [];
		const out: number[] = [];
		const seen = new Set<number>();
		for (const item of arr) {
			if (typeof item !== "number" || !inRange(item) || seen.has(item)) continue;
			seen.add(item);
			out.push(item);
		}
		return out;
	};

	const colOrder = uniqueCols(obj.colOrder);
	let hiddenCols = uniqueCols(obj.hiddenCols);
	if (colCount !== undefined && colCount > 0 && hiddenCols.length >= colCount) {
		hiddenCols = hiddenCols.slice(0, colCount - 1);
	}
	const hiddenSet = new Set(hiddenCols);
	const frozenCols = uniqueCols(obj.frozenCols).filter((col) => !hiddenSet.has(col));

	const order: SortSpec[] = [];
	if (Array.isArray(obj.order)) {
		const seen = new Set<number>();
		for (const entry of obj.order) {
			if (!entry || typeof entry !== "object") continue;
			const col = (entry as Record<string, unknown>).column;
			const down = (entry as Record<string, unknown>).down;
			if (typeof col !== "number" || !inRange(col) || seen.has(col)) continue;
			seen.add(col);
			order.push({ column: col, down: Boolean(down) });
		}
	}

	let groupByCol: number | null = null;
	if (typeof obj.groupByCol === "number" && inRange(obj.groupByCol)) {
		groupByCol = obj.groupByCol;
	}

	return { colWidths, frozenCols, colOrder, hiddenCols, order, groupByCol };
}

/** Parses a JSON string from `localStorage` into a safe `TableViewStateStore`. */
export function parseTableViewStateStore(rawJson: string | null): TableViewStateStore {
	if (!rawJson) return { version: 1, entries: {} };
	try {
		const parsed = JSON.parse(rawJson) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
			return { version: 1, entries: {} };
		}
		const entries: Record<string, PersistedTableViewEntry> = {};
		for (const [key, val] of Object.entries(parsed.entries as Record<string, unknown>)) {
			if (!key || !val || typeof val !== "object") continue;
			const clean = sanitizeTableViewState(val);
			if (!clean || isDefaultTableViewState(clean)) continue;
			const ts = (val as Record<string, unknown>).updatedAt;
			entries[key] = {
				...clean,
				updatedAt: typeof ts === "number" && Number.isFinite(ts) ? ts : 0,
			};
		}
		return { version: 1, entries };
	} catch {
		return { version: 1, entries: {} };
	}
}

/**
 * Inserts/updates or deletes one file's visual state in the store while enforcing
 * a strict LRU ceiling of `maxFiles` entries (evicting oldest `updatedAt` first).
 */
export function upsertTableViewState(
	store: TableViewStateStore,
	fileKey: string,
	next: Partial<TableViewStateSnapshot> | null,
	now = Date.now(),
	maxFiles = TABLE_VIEW_STATE_MAX_FILES,
): TableViewStateStore {
	const entries: Record<string, PersistedTableViewEntry> = { ...store.entries };
	if (!fileKey) return { version: 1, entries };
	const clean = next ? sanitizeTableViewState(next) : null;
	if (!clean || isDefaultTableViewState(clean)) {
		delete entries[fileKey];
		return { version: 1, entries };
	}
	entries[fileKey] = { ...clean, updatedAt: now };
	const keys = Object.keys(entries);
	if (keys.length > maxFiles) {
		const victims = keys
			.filter((k) => k !== fileKey)
			.sort((a, b) => (entries[a]!.updatedAt ?? 0) - (entries[b]!.updatedAt ?? 0));
		const dropCount = keys.length - maxFiles;
		for (let i = 0; i < dropCount && i < victims.length; i++) {
			delete entries[victims[i]!];
		}
	}
	return { version: 1, entries };
}

/** Reads and prunes one file's persisted view state from the store. */
export function getTableViewState(
	store: TableViewStateStore,
	fileKey: string,
	colCount?: number,
): TableViewStateSnapshot | null {
	const raw = store.entries[fileKey];
	if (!raw) return null;
	const clean = sanitizeTableViewState(raw, colCount);
	if (!clean || isDefaultTableViewState(clean)) return null;
	return clean;
}

/** Serializes a `TableViewStateStore` for `localStorage`. */
export function serializeTableViewStateStore(store: TableViewStateStore): string {
	return JSON.stringify(store);
}

// --- The Largest of Many -----------------------------------------------------

/**
 * The largest of what `of` gives for the items, and `least` when there are none. A loop, where
 * `Math.max(...items.map(of))` was written: a spread hands every item to the call as an argument of its own, and
 * an engine has room for only so many (V8 for about 125,000, JavaScriptCore for under a million). A paste of
 * 130,000 rows landed, and "Maximum call stack size exceeded" was thrown before its notice was said. Nothing here
 * spreads rows, cells or seeds into a call.
 */
export function greatest<T>(items: Iterable<T>, of: (item: T) => number, least = -Infinity): number {
	let most = least;
	for (const item of items) {
		const n = of(item);
		if (n > most) most = n;
	}
	return most;
}

// --- Excel Drag-Fill Smart Series Generator ----------------------------------

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PURE_INT_RE = /^(-?)(\d+)$/;
const PURE_FLOAT_RE = /^-?\d+(?:\.\d+)?$/;
const PREFIX_NUM_RE = /^(.*?)(\d+)$/;
const MS_PER_DAY = 86_400_000;

function parseIsoDay(raw: string): number | null {
	const m = ISO_DATE_RE.exec(raw.trim());
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	const utc = Date.UTC(y, mo - 1, d);
	const dt = new Date(utc);
	if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
	return Math.floor(utc / MS_PER_DAY);
}

function formatIsoDay(dayIndex: number): string {
	const dt = new Date(dayIndex * MS_PER_DAY);
	const y = String(dt.getUTCFullYear()).padStart(4, "0");
	const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
	const d = String(dt.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

// A date that is not an ISO one: its parts set apart by slashes or dashes, the year first (`2026/11/30`) or last
// (`30/11/2026`, `11/30/2026`).
const YEAR_FIRST_DATE_RE = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/;
const YEAR_LAST_DATE_RE = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/;

/** A date as written: `a` and `b` are the two numbers that are not the year, in the order they stand in. */
type WrittenDate = { yearFirst: boolean; sep: string; year: number; a: number; b: number; padded: boolean };

function parseWrittenDate(raw: string): WrittenDate | null {
	const first = YEAR_FIRST_DATE_RE.exec(raw);
	if (first) {
		const padded = first[3]!.length === 2 && first[4]!.length === 2;
		return { yearFirst: true, sep: first[2]!, year: Number(first[1]), a: Number(first[3]), b: Number(first[4]), padded };
	}
	const last = YEAR_LAST_DATE_RE.exec(raw);
	if (!last) return null;
	const padded = last[1]!.length === 2 && last[3]!.length === 2;
	return { yearFirst: false, sep: last[2]!, year: Number(last[4]), a: Number(last[1]), b: Number(last[3]), padded };
}

function dayIndexOf(year: number, month: number, day: number): number | null {
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const utc = Date.UTC(year, month - 1, day);
	const dt = new Date(utc);
	if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
	return Math.floor(utc / MS_PER_DAY);
}

let localeDayFirst: boolean | undefined;

/** Whether dates are written here with the day before the month, as far as this machine's locale says. */
function dayComesFirst(): boolean {
	if (localeDayFirst === undefined) {
		try {
			const parts = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(Date.UTC(2001, 1, 3, 12)));
			localeDayFirst = parts.findIndex((p) => p.type === "day") < parts.findIndex((p) => p.type === "month");
		} catch {
			localeDayFirst = false;
		}
	}
	return localeDayFirst;
}

/**
 * The seeds as days, with how to write a day as they are written (the same separator, order and zero-padding),
 * when every seed is a real calendar date written the same way. With the year last, a first number over twelve is
 * a day and a second number over twelve says the month came first; where the seeds do not say (`01/02/2026`),
 * `dayFirst` does, and without it the machine's locale, as a spreadsheet goes by its own.
 */
function writtenDates(seeds: readonly string[], dayFirst: boolean | undefined): { days: number[]; format: (day: number) => string } | null {
	const parts: WrittenDate[] = [];
	for (const seed of seeds) {
		const p = parseWrittenDate(seed);
		if (!p || (parts[0] && (p.yearFirst !== parts[0].yearFirst || p.sep !== parts[0].sep))) return null;
		parts.push(p);
	}
	const { yearFirst, sep } = parts[0]!;
	const dayLeads = !yearFirst && (parts.some((p) => p.a > 12) || (!parts.some((p) => p.b > 12) && (dayFirst ?? dayComesFirst())));
	const days: number[] = [];
	for (const p of parts) {
		const day = dayLeads ? dayIndexOf(p.year, p.b, p.a) : dayIndexOf(p.year, p.a, p.b);
		if (day === null) return null;
		days.push(day);
	}
	const padded = parts.every((p) => p.padded);
	const two = (n: number) => (padded ? String(n).padStart(2, "0") : String(n));
	const format = (dayIndex: number) => {
		const dt = new Date(dayIndex * MS_PER_DAY);
		const y = String(dt.getUTCFullYear()).padStart(4, "0");
		const m = two(dt.getUTCMonth() + 1);
		const d = two(dt.getUTCDate());
		return yearFirst ? `${y}${sep}${m}${sep}${d}` : dayLeads ? `${d}${sep}${m}${sep}${y}` : `${m}${sep}${d}${sep}${y}`;
	};
	return { days, format };
}

/**
 * A day of a month as a day index. The month is counted from year 0 (`year * 12 + month - 1`), so that a step in
 * months is a plain sum; day 0 is the last day of the month before.
 */
function dayInMonth(month: number, day: number): number {
	const dt = new Date(0);
	// Set as a whole date, not through `Date.UTC`: that takes the years 0 to 99 for 1900 to 1999.
	dt.setUTCFullYear(0, month, day);
	return Math.round(dt.getTime() / MS_PER_DAY);
}

/**
 * The `count` days that follow a series of seed days (that come before it, for `reverse`), or null when the seeds
 * have no one step.
 *
 * Seeds that are whole months apart go on by months, as in Excel and Sheets: all on the same day of the month
 * (`01-15`, `02-15` -> `03-15`; a month too short for the day gives its last day, and the day is back in the
 * month after), or all on the last day of their month (`01-31`, `02-28` -> `03-31`, `04-30`). Twelve months are a
 * year: `2025-06-01`, `2026-06-01` -> `2027-06-01`. The step used to be the number of days between the first two
 * seeds whatever they were, so a monthly series drifted (`01-01`, `02-01` -> `03-04`, `04-04`, `05-05`) and a
 * yearly one lost a day at each leap year. Seeds that are not whole months apart keep a constant step in days
 * (`11-01`, `11-08` -> `11-15`).
 */
function daysAfter(days: readonly number[], count: number, reverse: boolean): number[] | null {
	const at = days.map((d) => {
		const dt = new Date(d * MS_PER_DAY);
		return { month: dt.getUTCFullYear() * 12 + dt.getUTCMonth(), day: dt.getUTCDate() };
	});
	const months = at[1]!.month - at[0]!.month;
	if (months !== 0 && at.every((a, i) => i === 0 || a.month - at[i - 1]!.month === months)) {
		const lastOf = (month: number) => new Date(dayInMonth(month + 1, 0) * MS_PER_DAY).getUTCDate();
		const sameDay = at.every((a) => a.day === at[0]!.day);
		if (sameDay || at.every((a) => a.day === lastOf(a.month))) {
			const anchor = (reverse ? at[0]! : at[at.length - 1]!).month;
			const delta = reverse ? -months : months;
			return Array.from({ length: count }, (_, i) => {
				const month = anchor + delta * (i + 1);
				return dayInMonth(month, sameDay ? Math.min(at[0]!.day, lastOf(month)) : lastOf(month));
			});
		}
	}
	const step = days[1]! - days[0]!;
	if (!days.every((d, i) => i === 0 || d - days[i - 1]! === step)) return null;
	const anchor = reverse ? days[0]! : days[days.length - 1]!;
	const delta = reverse ? -step : step;
	return Array.from({ length: count }, (_, i) => anchor + delta * (i + 1));
}

function formatPaddedInt(n: number, padWidth: number): string {
	if (padWidth <= 1) return String(n);
	if (n < 0) return `-${String(Math.abs(n)).padStart(padWidth, "0")}`;
	return String(n).padStart(padWidth, "0");
}

function decimalPlaces(raw: string): number {
	const dot = raw.indexOf(".");
	return dot < 0 ? 0 : raw.length - dot - 1;
}

function parsePrefixedNumber(raw: string): { prefix: string; num: number; padWidth: number } | null {
	const m = PREFIX_NUM_RE.exec(raw);
	if (!m) return null;
	const prefix = m[1]!;
	const digits = m[2]!;
	// Require a non-empty prefix that contains at least one letter or structural separator
	// (prevents bare decimals like "3.14" or negative numbers like "-5" from matching as prefixes).
	if (!prefix || prefix === "-" || !/[A-Za-z_#\s/-]/.test(prefix)) return null;
	const num = Number(digits);
	if (!Number.isSafeInteger(num)) return null;
	const padWidth = digits.length > 1 && digits.startsWith("0") ? digits.length : 0;
	return { prefix, num, padWidth };
}

/**
 * Generates up to `count` drag-fill continuation values from `seedValues`:
 * - Single or arithmetic-stepped integers & decimals (`1` -> `2, 3, 4`; `10, 20` -> `30, 40`)
 * - Prefix + integer with zero-padding preservation (`DEMO-101` -> `DEMO-102, DEMO-103`; `TC-001` -> `TC-002`)
 * - ISO `YYYY-MM-DD` dates (`2026-11-23` -> `2026-11-24, 2026-11-25`; weekly `2026-11-01, 2026-11-08` -> `2026-11-15`)
 * - Dates written with slashes, or with dashes and the year last, day by day in the way they are written
 *   (`2026/11/30` -> `2026/12/01`; `28/02/2026` -> `01/03/2026`); `options.dayFirst` reads `01/02/2026`
 * - Two or more dates of either kind that are whole months apart go on by months, not by the days between them
 *   (`2026-01-01, 2026-02-01` -> `2026-03-01`; `2026-01-31, 2026-02-28` -> `2026-03-31`): `daysAfter`
 * - Plain text repeats cleanly (`in progress` -> `in progress`)
 * - `options.literal = true` (Alt-drag) copies seeds cyclically without incrementing.
 *
 * A plain number counts down through zero (`1` -> `0, -1`), as in Excel and Sheets. A numbered name or a
 * zero-padded number does not: there is no `TC--001` and no `-001`, so such a series ends at zero and the result
 * is then shorter than `count`. What is left of the cells being filled is for the caller to leave as it is.
 */
export function generateFillSeries(
	seedValues: readonly string[],
	count: number,
	options?: { literal?: boolean; reverse?: boolean; dayFirst?: boolean },
): string[] {
	if (count <= 0 || seedValues.length === 0) return [];
	const literal = Boolean(options?.literal);
	const reverse = Boolean(options?.reverse);
	const repeatSeeds = () =>
		Array.from({ length: count }, (_, i) =>
			reverse
				? seedValues[seedValues.length - 1 - (i % seedValues.length)]!
				: seedValues[i % seedValues.length]!,
		);
	if (literal) return repeatSeeds();

	const dir = reverse ? -1 : 1;
	/** The numbers that follow `anchor` in steps of `delta`, as far as zero and no further. */
	const downToZero = (anchor: number, delta: number): number[] => {
		const out: number[] = [];
		for (let i = 1; i <= count; i++) {
			const n = anchor + delta * i;
			if (n < 0) break;
			out.push(n);
		}
		return out;
	};

	if (seedValues.length === 1) {
		const raw = seedValues[0]!;
		const trimmed = raw.trim();
		if (!trimmed) return repeatSeeds();

		// 1. ISO date
		const day = parseIsoDay(trimmed);
		if (day !== null) {
			return Array.from({ length: count }, (_, i) => formatIsoDay(day + dir * (i + 1)));
		}

		// 2. A date written another way. Read as a name and a number, `2026/11/30` went on to `2026/11/31`.
		const written = writtenDates([trimmed], options?.dayFirst);
		if (written) {
			return Array.from({ length: count }, (_, i) => written.format(written.days[0]! + dir * (i + 1)));
		}

		// 3. Pure integer (preserving zero-padding like "001" -> "002")
		const intMatch = PURE_INT_RE.exec(trimmed);
		if (intMatch) {
			const neg = intMatch[1] === "-";
			const digits = intMatch[2]!;
			const base = Number(trimmed);
			if (Number.isSafeInteger(base)) {
				const padWidth = !neg && digits.length > 1 && digits.startsWith("0") ? digits.length : 0;
				if (padWidth > 0) return downToZero(base, dir).map((n) => formatPaddedInt(n, padWidth));
				return Array.from({ length: count }, (_, i) => formatPaddedInt(base + dir * (i + 1), padWidth));
			}
		}

		// 4. Prefix + trailing integer (e.g. DEMO-101, TC-001, Item 1)
		const pref = parsePrefixedNumber(trimmed);
		if (pref) {
			return downToZero(pref.num, dir).map((n) => `${pref.prefix}${formatPaddedInt(n, pref.padWidth)}`);
		}

		// 5. Plain text (or decimal without explicit step) repeats verbatim
		return repeatSeeds();
	}

	// Multiple seeds (length >= 2)
	const trimmedSeeds = seedValues.map((s) => s.trim());

	// 1. All ISO dates, a constant number of months or of days apart
	const days = trimmedSeeds.map(parseIsoDay);
	if (days.every((d): d is number => d !== null)) {
		return daysAfter(days, count, reverse)?.map(formatIsoDay) ?? repeatSeeds();
	}

	// 2. All dates written another way, the same way, a constant number of months or of days apart
	const written = writtenDates(trimmedSeeds, options?.dayFirst);
	if (written) {
		return daysAfter(written.days, count, reverse)?.map(written.format) ?? repeatSeeds();
	}

	// 3. All pure integers or decimals with constant arithmetic step
	if (trimmedSeeds.every((s) => PURE_FLOAT_RE.test(s))) {
		const nums = trimmedSeeds.map(Number);
		if (nums.every(Number.isFinite)) {
			const step = nums[1]! - nums[0]!;
			const constant = nums.every((n, i) => i === 0 || Math.abs(n - nums[i - 1]! - step) < 1e-9);
			if (constant) {
				const allInts = trimmedSeeds.every((s) => PURE_INT_RE.test(s));
				const padWidth =
					allInts && trimmedSeeds.every((s) => !s.startsWith("-") && s.length > 1 && s.startsWith("0"))
						? greatest(trimmedSeeds, (s) => s.length)
						: 0;
				const maxDec = allInts ? 0 : greatest(trimmedSeeds, decimalPlaces);
				const anchor = reverse ? nums[0]! : nums[nums.length - 1]!;
				const delta = reverse ? -step : step;
				if (padWidth > 0) return downToZero(anchor, delta).map((n) => formatPaddedInt(n, padWidth));
				return Array.from({ length: count }, (_, i) => {
					const val = anchor + delta * (i + 1);
					if (allInts && Number.isInteger(step)) return formatPaddedInt(Math.round(val), padWidth);
					const rounded = Math.round(val * 1e9) / 1e9;
					return maxDec > 0 ? rounded.toFixed(maxDec) : String(rounded);
				});
			}
		}
		return repeatSeeds();
	}

	// 4. All same prefix + trailing integer with constant step (e.g. ["DEMO-100", "DEMO-110"])
	const parsedPrefs = trimmedSeeds.map(parsePrefixedNumber);
	if (parsedPrefs.every((p): p is { prefix: string; num: number; padWidth: number } => p !== null)) {
		const prefix = parsedPrefs[0]!.prefix;
		if (parsedPrefs.every((p) => p.prefix === prefix)) {
			const step = parsedPrefs[1]!.num - parsedPrefs[0]!.num;
			const constant = parsedPrefs.every((p, i) => i === 0 || p.num - parsedPrefs[i - 1]!.num === step);
			if (constant) {
				const padWidth = greatest(parsedPrefs, (p) => p.padWidth);
				const anchor = reverse ? parsedPrefs[0]!.num : parsedPrefs[parsedPrefs.length - 1]!.num;
				const delta = reverse ? -step : step;
				return downToZero(anchor, delta).map((n) => `${prefix}${formatPaddedInt(n, padWidth)}`);
			}
		}
		return repeatSeeds();
	}

	return repeatSeeds();
}

// --- Markdown Table Formatter ------------------------------------------------

/**
 * Formats headers and cell rows into a GitHub-Flavored Markdown pipe table,
 * cleanly escaping literal pipes (`|`) and converting embedded newlines to `<br>`.
 */
export function cellsToMarkdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const colCount = greatest(rows, (r) => r.length, headers.length);
	if (colCount === 0) return "";
	const esc = (raw: string) =>
		raw
			.replace(/\|/g, "\\|")
			.replace(/\r\n|\r|\n/g, "<br>");
	const resolvedHeaders = Array.from({ length: colCount }, (_, i) => {
		const h = headers[i];
		return h !== undefined ? esc(h) : `Column ${i + 1}`;
	});
	const headLine = `| ${resolvedHeaders.join(" | ")} |`;
	const sepLine = `| ${resolvedHeaders.map(() => "---").join(" | ")} |`;
	const bodyLines = rows.map(
		(row) => `| ${Array.from({ length: colCount }, (_, i) => esc(row[i] ?? "")).join(" | ")} |`,
	);
	return [headLine, sepLine, ...bodyLines].join("\n");
}

// --- Find & Replace (Case, Whole-Word, Regex, In-Selection) ------------------

export type CellFindOptions = {
	caseSensitive?: boolean;
	wholeWord?: boolean;
	regex?: boolean;
};

export type CompiledCellMatcher =
	| { ok: true; regex: RegExp }
	| { ok: false; error: string };

function escapeRegExpLiteral(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CELL_WORD_CHAR = "[A-Za-z0-9_]";
const CELL_WORD_START = `(?:(?<!${CELL_WORD_CHAR})(?=${CELL_WORD_CHAR})|(?!${CELL_WORD_CHAR}))`;
const CELL_WORD_END = `(?:(?<=${CELL_WORD_CHAR})(?!${CELL_WORD_CHAR})|(?<!${CELL_WORD_CHAR}))`;

/**
 * Compiles a cell search query into a safe global `RegExp` supporting case sensitivity,
 * whole-word boundaries, and regular expressions. Never throws on invalid regex syntax.
 */
export function compileCellMatcher(query: string, opts?: CellFindOptions): CompiledCellMatcher | null {
	if (!query) return null;
	const flags = opts?.caseSensitive ? "g" : "gi";
	let pattern: string;
	if (opts?.regex) {
		pattern = opts.wholeWord ? `${CELL_WORD_START}(?:${query})${CELL_WORD_END}` : query;
	} else {
		const escaped = escapeRegExpLiteral(query);
		if (opts?.wholeWord) {
			const lead = /^\w/.test(query) ? "(?<![A-Za-z0-9_])" : "";
			const trail = /\w$/.test(query) ? "(?![A-Za-z0-9_])" : "";
			pattern = `${lead}${escaped}${trail}`;
		} else {
			pattern = escaped;
		}
	}
	try {
		if (opts?.regex && opts.wholeWord) new RegExp(query, flags);
		return { ok: true, regex: new RegExp(pattern, flags) };
	} catch (e: any) {
		return { ok: false, error: e?.message ? String(e.message) : "Invalid regular expression" };
	}
}

/** Tests whether a cell value matches `query` under the given Find options. */
export function cellMatchesQuery(value: string, query: string, opts?: CellFindOptions): boolean {
	const compiled = compileCellMatcher(query, opts);
	if (!compiled || !compiled.ok) return false;
	compiled.regex.lastIndex = 0;
	return compiled.regex.test(value);
}

/**
 * Replaces all occurrences of `query` in `value`.
 * - Non-regex mode treats `replacement` strictly literally (never expanding `$&`, `$1`, etc.).
 * - Regex mode supports standard capture-group substitutions (`$1`, `$&`).
 */
export function replaceCellMatches(value: string, query: string, replacement: string, opts?: CellFindOptions): string {
	const compiled = compileCellMatcher(query, opts);
	if (!compiled || !compiled.ok) return value;
	compiled.regex.lastIndex = 0;
	if (opts?.regex) return value.replace(compiled.regex, replacement);
	return value.replace(compiled.regex, () => replacement);
}

/** True when `(row, column)` lies within an active Find "In Selection" scope (or no scope is active). */
export function isCellInFindSelection(
	row: number,
	column: number,
	scope: { rows: ReadonlySet<number>; cols: ReadonlySet<number> } | null,
): boolean {
	if (!scope) return true;
	return scope.rows.has(row) && scope.cols.has(column);
}

// --- Measured Virtual-Window Layout & Auto-Fit Sampling ----------------------

export const DEFAULT_ROW_HEIGHT = 31;
export const AUTOFIT_SAMPLE_LIMIT = 500;

export type VirtualLayout = {
	virtual: boolean;
	start: number;
	end: number;
	topPad: number;
	bottomPad: number;
	/** Prefix sums of entry heights (`offsets[i]` = top px of entry `i`, `offsets[count]` = total height). */
	offsets: number[];
	totalHeight: number;
};

/**
 * Computes the visible virtual slice and exact spacer heights using measured per-entry
 * heights (`Map<number, number>`) with `fallbackHeight` (31px) for unmeasured rows.
 */
export function computeVirtualWindow(
	entryKeys: readonly number[],
	heights: ReadonlyMap<number, number>,
	scrollTop: number,
	viewportHeight: number,
	threshold = 200,
	overscan = 20,
	fallbackHeight = DEFAULT_ROW_HEIGHT,
): VirtualLayout {
	const count = entryKeys.length;
	if (count <= threshold) {
		return { virtual: false, start: 0, end: count, topPad: 0, bottomPad: 0, offsets: [], totalHeight: 0 };
	}

	const offsets = new Array<number>(count + 1);
	offsets[0] = 0;
	for (let i = 0; i < count; i++) {
		const measured = heights.get(entryKeys[i]!);
		const h = measured !== undefined && measured > 0 ? measured : fallbackHeight;
		offsets[i + 1] = offsets[i]! + h;
	}
	const totalHeight = offsets[count]!;
	const clampedTop = Math.max(0, scrollTop);
	const bottomEdge = clampedTop + Math.max(fallbackHeight, viewportHeight);

	// Binary search for first entry whose bottom > clampedTop.
	let lo = 0;
	let hi = count - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (offsets[mid + 1]! <= clampedTop) lo = mid + 1;
		else hi = mid;
	}
	const firstVis = lo;

	// Binary search for last entry whose top < bottomEdge.
	lo = firstVis;
	hi = count - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (offsets[mid]! < bottomEdge) lo = mid;
		else hi = mid - 1;
	}
	const lastVis = lo;

	const start = Math.max(0, firstVis - overscan);
	const end = Math.min(count, lastVis + 1 + overscan);
	const topPad = offsets[start]!;
	const bottomPad = Math.max(0, totalHeight - offsets[end]!);

	return { virtual: true, start, end, topPad, bottomPad, offsets, totalHeight };
}

/**
 * Evenly samples up to `maxSamples` rows across the entire dataset (always including
 * first and last rows) so `autoFitColumn` measures long cells outside the virtual viewport.
 */
export function sampleRowsForAutoFit<T>(rows: readonly T[], maxSamples = AUTOFIT_SAMPLE_LIMIT): T[] {
	if (maxSamples <= 0 || rows.length === 0) return [];
	if (rows.length <= maxSamples) return rows.slice();
	if (maxSamples === 1) return [rows[0]!];
	const out: T[] = [];
	const step = (rows.length - 1) / (maxSamples - 1);
	let lastIdx = -1;
	for (let i = 0; i < maxSamples; i++) {
		const idx = Math.min(rows.length - 1, Math.round(i * step));
		if (idx !== lastIdx) {
			out.push(rows[idx]!);
			lastIdx = idx;
		}
	}
	return out;
}

// --- Clickable URL, Multi-Column Ticket, Schema Column & Unified Issues ------

const SCHEMA_TABLE_COL_NAMES = new Set([
	"table",
	"db_table",
	"db table",
	"object",
	"entity",
	"table_name",
	"table name",
	"object_name",
	"object name",
	"sql_table",
	"sql_object",
]);

/**
 * True when a column header represents a database table/object identifier eligible for
 * direct links to `schema/database/<table>.md` across ALL registries (plus `name` inside `database.csv`/`tsv`).
 */
export function isSchemaTableColumn(header: string, isDatabaseRegistry = false): boolean {
	const h = header.trim().toLowerCase();
	if (!h) return false;
	if (SCHEMA_TABLE_COL_NAMES.has(h)) return true;
	return isDatabaseRegistry && h === "name";
}

const DEDICATED_TICKET_COL_RE = /^(?:tickets?|ticket[_\s-]?(?:id|key|no|num|number|ref)s?|jira(?:[_\s-]?(?:id|key))?)$/i;

/** True when a column is explicitly dedicated to ticket keys (eligible for unknown-ticket validation warnings). */
export function isDedicatedTicketColumn(header: string): boolean {
	return DEDICATED_TICKET_COL_RE.test(header.trim());
}

const HTTP_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCT_RE = /[.,;:!?]+$/;

function trimTrailingUrlPunct(raw: string): { url: string; trailing: string } {
	let url = raw;
	let trailing = "";
	while (url.length > 0) {
		const punct = TRAILING_URL_PUNCT_RE.exec(url);
		if (punct) {
			trailing = punct[0]! + trailing;
			url = url.slice(0, -punct[0]!.length);
			continue;
		}
		const last = url[url.length - 1]!;
		if (last === ")" || last === "]" || last === "}") {
			const open = last === ")" ? "(" : last === "]" ? "[" : "{";
			const opens = url.split(open).length - 1;
			const closes = url.split(last).length - 1;
			if (closes > opens) {
				trailing = last + trailing;
				url = url.slice(0, -1);
				continue;
			}
		}
		break;
	}
	return { url, trailing };
}

export type CellUrlSegment =
	| { kind: "text"; text: string }
	| { kind: "url"; text: string; url: string };

/** Splits a cell value into plain text and clickable `http://` / `https://` URL segments. */
export function splitCellUrls(value: string): CellUrlSegment[] {
	if (!value || !/https?:\/\//i.test(value)) {
		return value ? [{ kind: "text", text: value }] : [];
	}
	const out: CellUrlSegment[] = [];
	const pushText = (t: string) => {
		if (!t) return;
		const prev = out[out.length - 1];
		if (prev && prev.kind === "text") prev.text += t;
		else out.push({ kind: "text", text: t });
	};
	let cursor = 0;
	HTTP_URL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = HTTP_URL_RE.exec(value)) !== null) {
		const start = match.index;
		if (start > cursor) pushText(value.slice(cursor, start));
		const { url, trailing } = trimTrailingUrlPunct(match[0]!);
		if (/^https?:\/\/\S/i.test(url)) {
			out.push({ kind: "url", text: url, url });
			if (trailing) pushText(trailing);
		} else {
			pushText(match[0]!);
		}
		cursor = start + match[0]!.length;
	}
	if (cursor < value.length) pushText(value.slice(cursor));
	return out;
}

/** Returns the first `http://` or `https://` URL in `value`, or `null` when none exists. */
export function extractFirstHttpUrl(value: string): string | null {
	for (const seg of splitCellUrls(value)) {
		if (seg.kind === "url") return seg.url;
	}
	return null;
}

export type CellLinkSegment =
	| { kind: "text"; text: string }
	| { kind: "url"; text: string; url: string }
	| { kind: "ticket"; text: string; key: string };

/**
 * Tokenizes a general cell value into plain text, `http(s)://` URLs, and known workspace
 * ticket chips (without misclassifying bare numeric values in non-ticket columns as tickets).
 */
export function tokenizeCellLinks(value: string, knownTickets: ReadonlySet<string>): CellLinkSegment[] {
	if (!value) return [];
	const urlSegments = splitCellUrls(value);
	if (knownTickets.size === 0) return urlSegments;

	const out: CellLinkSegment[] = [];
	const pushText = (t: string) => {
		if (!t) return;
		const prev = out[out.length - 1];
		if (prev && prev.kind === "text") prev.text += t;
		else out.push({ kind: "text", text: t });
	};

	for (const seg of urlSegments) {
		if (seg.kind === "url") {
			out.push(seg);
			continue;
		}
		for (const part of seg.text.split(/([\s,;/]+)/)) {
			if (!part) continue;
			if (/^[\s,;/]+$/.test(part)) {
				pushText(part);
				continue;
			}
			const leadMatch = /^([(\[{#]+)/.exec(part);
			const lead = leadMatch ? leadMatch[1]! : "";
			const afterLead = part.slice(lead.length);
			const trailMatch = /([)\]}.,:;!?]+)$/.exec(afterLead);
			const trail = trailMatch ? trailMatch[1]! : "";
			const bare = trail ? afterLead.slice(0, -trail.length) : afterLead;
			const lower = bare.toLowerCase();
			// Only linkify in non-ticket columns when the key is a real known ticket AND
			// either non-pure-numeric (e.g. DEMO-101, T12) or explicitly prefixed with `#`.
			const isExplicitHashNumeric = /^\d+$/.test(bare) && lead.endsWith("#");
			const isKnownChip = bare.length > 0 && knownTickets.has(lower) && (!/^\d+$/.test(bare) || isExplicitHashNumeric);
			if (isKnownChip) {
				if (isExplicitHashNumeric) {
					pushText(lead.slice(0, -1));
					out.push({ kind: "ticket", text: `#${bare}`, key: bare });
				} else {
					pushText(lead);
					out.push({ kind: "ticket", text: bare, key: bare });
				}
				pushText(trail);
			} else {
				pushText(part);
			}
		}
	}
	return out;
}

const TICKET_PLACEHOLDER_RE = /^(?:[-—–]+|n\/a|none|tbd|todo)$/i;

/** Returns unrecognized non-placeholder tokens from a dedicated ticket column cell (skipping URLs). */
export function findUnknownTicketTokens(cellValue: string, knownTickets: ReadonlySet<string>): string[] {
	if (knownTickets.size === 0 || !cellValue.trim()) return [];
	const unknown: string[] = [];
	for (const seg of splitCellUrls(cellValue)) {
		if (seg.kind === "url") continue;
		for (const chunk of seg.text.split(/[\s,;]+/)) {
			const trimmedChunk = chunk.trim();
			if (!trimmedChunk || TICKET_PLACEHOLDER_RE.test(trimmedChunk)) continue;
			for (const part of trimmedChunk.split("/")) {
				const trimmed = part.trim();
				if (!trimmed || TICKET_PLACEHOLDER_RE.test(trimmed)) continue;
				const matched = keyOf(trimmed, knownTickets);
				if (matched && knownTickets.has(matched.toLowerCase())) continue;
				unknown.push(trimmed);
			}
		}
	}
	return unknown;
}

// --- Unified Inline Table Issues Navigator (F8) ------------------------------

export type TableIssueKind =
	| "missing-path"
	| "malformed-path"
	| "unknown-ticket"
	| "unrecognized-badge"
	| "empty-key"
	| "duplicate-key";

export type TableIssue = {
	row: number;
	column: number;
	kind: TableIssueKind;
	message: string;
};

/** Formats a concise breakdown of issue counts by category for the toolbar pill tooltip. */
export function summarizeTableIssues(issues: readonly TableIssue[]): string {
	if (!issues.length) return "No issues";
	const counts = new Map<TableIssueKind, number>();
	for (const issue of issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
	const labels: [TableIssueKind, string, string][] = [
		["missing-path", "missing file", "missing files"],
		["malformed-path", "malformed path", "malformed paths"],
		["unknown-ticket", "unknown ticket", "unknown tickets"],
		["unrecognized-badge", "unrecognized badge", "unrecognized badges"],
		["empty-key", "empty key", "empty keys"],
		["duplicate-key", "duplicate key", "duplicate keys"],
	];
	const parts: string[] = [];
	for (const [kind, singular, plural] of labels) {
		const n = counts.get(kind) ?? 0;
		if (n > 0) parts.push(`${n} ${n === 1 ? singular : plural}`);
	}
	return parts.join(", ");
}

/**
 * Returns the index of the next (`delta = 1`) or previous (`delta = -1`) issue relative
 * to `active` cell in visual `(rowOrder, colOrder)` order, wrapping cleanly around ends.
 */
export function nextTableIssueIndex(
	issues: readonly TableIssue[],
	active: { row: number; column: number } | null,
	delta: 1 | -1,
	rowOrder?: ReadonlyMap<number, number>,
	colOrder?: ReadonlyMap<number, number>,
): number {
	if (!issues.length) return -1;
	const rowRank = (r: number) => rowOrder?.get(r) ?? r;
	const colRank = (c: number) => colOrder?.get(c) ?? c;

	const ranked = issues
		.map((issue, origIdx) => ({
			origIdx,
			r: rowRank(issue.row),
			c: colRank(issue.column),
		}))
		.sort((a, b) => a.r - b.r || a.c - b.c || a.origIdx - b.origIdx);

	if (!active) {
		return delta > 0 ? ranked[0]!.origIdx : ranked[ranked.length - 1]!.origIdx;
	}
	const ar = rowRank(active.row);
	const ac = colRank(active.column);

	if (delta > 0) {
		for (const item of ranked) {
			if (item.r > ar || (item.r === ar && item.c > ac)) return item.origIdx;
		}
		return ranked[0]!.origIdx;
	}
	for (let i = ranked.length - 1; i >= 0; i--) {
		const item = ranked[i]!;
		if (item.r < ar || (item.r === ar && item.c < ac)) return item.origIdx;
	}
	return ranked[ranked.length - 1]!.origIdx;
}

// --- Paste Start & Open Cell Editor Guard ------------------------------------

/**
 * Where a paste starts, among the rows and columns as they are shown: the top-left cell of a selection of more
 * than one cell, as in Excel and Sheets, whichever corner the selection was dragged or extended to. A cell that is
 * selected alone is where its paste starts (`visRow` and `visCol` are then the active cell's, as given).
 */
export function pasteStart(
	activeVisRow: number,
	activeVisCol: number,
	range: { r1: number; c1: number; isMulti: boolean } | null,
): { visRow: number; visCol: number } {
	return range && range.isMulti ? { visRow: range.r1, visCol: range.c1 } : { visRow: activeVisRow, visCol: activeVisCol };
}

/**
 * Tells an open cell editor whether the text is still the one it was opened on. An editor writes to the row and
 * column it was opened on, which are places in the text as it was then; after a reload from disk with rows added
 * above, or an edit from another view, the same numbers are another cell. The editor keeps `stamp()` from when it
 * opens and writes only while `fresh(stamp)`; the view calls `changed()` for every change of the text, and runs an
 * editor's own write inside `commit`, so that it is not counted against the editor that Tab or Enter opens next.
 */
export function cellEditGuard() {
	let foreign = 0;
	let committing = 0;
	return {
		/** Runs an editor's own write to the text. */
		commit<T>(write: () => T): T {
			committing++;
			try {
				return write();
			} finally {
				committing--;
			}
		},
		/** For every change of the text: says whether it came from somewhere other than an editor's own write. */
		changed(): boolean {
			if (committing > 0) return false;
			foreign++;
			return true;
		},
		stamp: (): number => foreign,
		fresh: (stamp: number): boolean => stamp === foreign,
	};
}

// --- An Open Cell Editor Is on the Page ---------------------------------------

/**
 * What is to be done for the row of an open cell editor that is not among the rows shown: the row is shown, or
 * the editor is closed. "close" where nothing can show it (there is no such row, or nothing says why it is not
 * shown). Otherwise the row is kept among the rows the filters let through (`pin`, as a row being worked on is),
 * and its group is opened (`openGroup`: the group's key, or null when it is not in a closed group).
 *
 * The table was "editing" with no editor on the page: a row inserted while the rows are grouped is a blank row,
 * which belongs to the group of rows with nothing in the grouping column, and that group was closed; so was the
 * group that Tab moved a row into when it wrote the grouping column's cell. While it was so, the arrows, F2,
 * typing and paste did nothing, and nothing showed why: Escape was the only way out.
 */
export function editorRowReveal(
	row: number,
	s: {
		/** How many rows the table has. */
		rowCount: number;
		/** The row is among those the filters let through. */
		passes: boolean;
		/** The key of the row's group where the rows are grouped, else null. */
		groupKey: string | null;
		/** The keys of the groups that are closed. */
		collapsed: ReadonlySet<string>;
	},
): "close" | { pin: boolean; openGroup: string | null } {
	if (!Number.isInteger(row) || row < 0 || row >= s.rowCount) return "close";
	const openGroup = s.groupKey !== null && s.collapsed.has(s.groupKey) ? s.groupKey : null;
	if (s.passes && openGroup === null) return "close";
	return { pin: !s.passes, openGroup };
}

// --- The Suggestions Under an Open Cell: Which One Is Marked -------------------

/** The suggestion that Enter or Tab would take (-1: none), and where the pointer was last seen over the list. */
export type SuggestionMark = { index: number; pointerAt: string | null };

export type SuggestionEvent =
	/** The list is shown for a cell, or its suggestions are made anew because the text in the cell changed. */
	| { kind: "shown" }
	/** The pointer is reported over suggestion `index` (entering it or moving on it), at this place on the screen. */
	| { kind: "pointer"; index: number; screenX: number; screenY: number }
	/** The pointer is reported outside the list. */
	| { kind: "left" }
	/** An arrow key, with `count` suggestions in the list. */
	| { kind: "arrow"; key: "ArrowDown" | "ArrowUp"; count: number };

export const NO_SUGGESTION: SuggestionMark = { index: -1, pointerAt: null };

/**
 * Which suggestion is marked after an event. A suggestion is marked only when the user chose it: with the arrow
 * keys, or with a pointer that MOVED onto it. A web view also reports the pointer over whatever is drawn under it
 * while it rests: the list opens under the pointer, or is drawn anew after a letter is typed, and the suggestion
 * that lands there is "entered". That marked it, and Enter or Tab then wrote it into the cell instead of what was
 * typed (`y`, Enter: the cell got another row's whole value).
 *
 * So the first report after the list is shown, drawn anew or scrolled by an arrow key only says where the pointer
 * is; a later report from another place is a move, and marks. The place is forgotten whenever the list changes
 * under the pointer or the pointer leaves it, because moves outside the list are not seen: a pointer that went
 * elsewhere and rests there would otherwise count as moved when a suggestion is next drawn under it. A real move
 * is never one report, so it still marks at once. The row menu keeps the same rule (`createPointerTracker`).
 */
export function stepSuggestionMark(mark: SuggestionMark, event: SuggestionEvent): SuggestionMark {
	if (event.kind === "shown") return NO_SUGGESTION;
	if (event.kind === "left") return { index: mark.index, pointerAt: null };
	if (event.kind === "arrow") {
		if (event.count <= 0) return { index: -1, pointerAt: null };
		const index = event.key === "ArrowDown" ? (mark.index + 1) % event.count : mark.index <= 0 ? event.count - 1 : mark.index - 1;
		return { index, pointerAt: null };
	}
	const at = `${event.screenX},${event.screenY}`;
	const moved = mark.pointerAt !== null && mark.pointerAt !== at;
	return { index: moved ? event.index : mark.index, pointerAt: at };
}

/** What Enter, Tab or Ctrl+Enter writes: the marked suggestion while the list is open and one is marked, else what was typed. */
export function suggestionTaken<T>(mark: Pick<SuggestionMark, "index">, options: readonly T[], open: boolean): T | undefined {
	return open && mark.index >= 0 ? options[mark.index] : undefined;
}

// --- Pasting, Filling & Checking: What Is Written and What Is Said ------------

/**
 * How many of a pasted grid's columns land in the table: those from the column the paste starts at to the last
 * column shown. The rest are left out; a paste adds rows, never columns.
 */
export function pasteFit(gridCols: number, startVisCol: number, shownCols: number): { cols: number; leftOut: number } {
	const cols = Math.max(0, Math.min(gridCols, shownCols - startVisCol));
	return { cols, leftOut: Math.max(0, gridCols - cols) };
}

/** What is said after a paste: the cells that were pasted, and the copied columns that were not, when there are any. */
export function pasteNotice(rows: number, cols: number, leftOut: number): string {
	const pasted = `Pasted ${rows} × ${cols} cells (Ctrl+Z to undo).`;
	if (leftOut <= 0) return pasted;
	return leftOut === 1
		? `${pasted} The last column copied was left out: there is no column for it after the last one shown.`
		: `${pasted} The last ${leftOut} columns copied were left out: there are no columns for them after the last one shown.`;
}

/**
 * What is said after a drag-fill: the cells that were written, and those left as they were because the series
 * ended (`generateFillSeries` does not count a numbered name below zero). Empty when there is nothing to say.
 */
export function fillNotice(changed: number, leftAlone: number, literal: boolean): string {
	const cells = (n: number) => `${n} ${n === 1 ? "cell" : "cells"}`;
	const filled = changed > 0 ? `${literal ? "Copied" : "Filled"} ${cells(changed)} (Ctrl+Z to undo).` : "";
	if (leftAlone <= 0) return filled;
	const left = `${cells(leftAlone)} ${leftAlone === 1 ? "was" : "were"} left as ${leftAlone === 1 ? "it was" : "they were"}: a numbered name or a zero-padded number does not count below zero.`;
	return filled ? `${filled} ${left}` : left;
}

/**
 * What is said when an edit is not made because it would change what the file is read with: it would leave the
 * file's first record with one cell, which names no delimiter (`csvTextKeepingDelimiter`). `delimiter` is the one
 * the table is read with.
 */
export function firstRowRefusal(delimiter: string): string {
	const name = delimiter === "\t" ? "tab" : delimiter === ";" ? "semicolon" : delimiter === "|" ? "pipe" : "comma";
	return `Not done: the file's first row would be left with one cell, and the file would then be read as comma-separated, not ${name}-separated. To do this, convert the file's delimiter to commas first.`;
}

// --- A Column's Values in Code: Scans That Read Every File, and Scans That Did Not ---

/**
 * What a check of a column's values has found, by each value's key. `counts`: how often a value is in the files,
 * from a scan that read every one of them; 0 there means the value is not in the code. `unfinished`: what was found
 * of a value before its scan ran out of time, which is at least that many and, at 0, nothing known. A value is in
 * one of the two, never both.
 */
export type CodeCheckTally = { counts: Map<string, number>; unfinished: Map<string, number> };

/**
 * Looks for each value in the project's files, one scan after another, and files what each scan came to in
 * `tally`. Returns how many values were filed.
 *
 * One after another, because the backend is one thread: six scans at once each took six times as long, so that in
 * a workspace where one scan takes a second every one of them passed its time budget and came back with what it
 * had found so far, often nothing. And with the scan's own word on whether it finished (`searchScan`), because
 * the bare list of hits says nothing of it: a value that IS in the code was shown as "not in code".
 *
 * A scan that ran out of time though it ran alone is filed under `unfinished`. When any scan of the run did read
 * every file, a value of which nothing was found is looked for once more at the end: the first scan of a
 * workspace reads its files cold, and something else may have been scanning at the same moment.
 */
export async function scanValuesInTurn(
	terms: readonly string[],
	keyOf: (term: string) => string,
	scan: (term: string) => Promise<{ hits: readonly unknown[]; timedOut: boolean }>,
	tally: CodeCheckTally,
	stopped: () => boolean = () => false,
	progress: (done: number) => void = () => {},
): Promise<number> {
	let done = 0;
	let finished = 0;
	const again: string[] = [];
	const look = async (term: string, first: boolean): Promise<boolean> => {
		if (stopped()) return false;
		const { hits, timedOut } = await scan(term);
		if (stopped()) return false;
		const key = keyOf(term);
		if (timedOut) {
			tally.counts.delete(key);
			tally.unfinished.set(key, hits.length);
			if (first && hits.length === 0) again.push(term);
		} else {
			tally.unfinished.delete(key);
			tally.counts.set(key, hits.length);
			finished++;
		}
		if (first) progress(++done);
		return true;
	};
	for (const term of terms) if (!(await look(term, true))) return done;
	if (finished > 0) for (const term of again) if (!(await look(term, false))) return done;
	return done;
}

/**
 * How one checked value reads in its cell, or null for a value that was not checked. "missing" only when a scan
 * read every file and did not find it. A value whose scan ran out of time is "found", at least so many times, when
 * the scan had found it by then, and "unknown" when it had not: that is not a count of 0.
 */
export function checkedUse(
	key: string,
	check: { counts: ReadonlyMap<string, number>; unfinished: ReadonlyMap<string, number> },
	limit: number,
): null | { state: "missing" } | { state: "unknown" } | { state: "found"; count: number; text: string; atLeast: boolean } {
	const partial = check.unfinished.get(key);
	if (partial !== undefined) return partial > 0 ? { state: "found", count: partial, text: `${partial}+`, atLeast: true } : { state: "unknown" };
	const count = check.counts.get(key);
	if (count === undefined) return null;
	if (count === 0) return { state: "missing" };
	return count >= limit ? { state: "found", count, text: `${limit}+`, atLeast: true } : { state: "found", count, text: String(count), atLeast: false };
}

/** How many checked values are in the code, are not, and could not be said of (`checkedUse`). */
export function codeCheckTotals(check: { counts: ReadonlyMap<string, number>; unfinished: ReadonlyMap<string, number> }): { found: number; missing: number; unknown: number } {
	let found = 0;
	let missing = 0;
	let unknown = 0;
	for (const count of check.counts.values()) count === 0 ? missing++ : found++;
	for (const partial of check.unfinished.values()) partial === 0 ? unknown++ : found++;
	return { found, missing, unknown };
}

/**
 * What a check came to, in a sentence or two. The values whose scan ran out of time before anything was found
 * are said apart from those not found: they were counted among the "not found in code".
 */
export function codeCheckSaid(
	columnName: string,
	check: { counts: ReadonlyMap<string, number>; unfinished: ReadonlyMap<string, number> },
	cancelled = false,
): string {
	const { unknown } = codeCheckTotals(check);
	const known = new Map(check.counts);
	for (const [key, partial] of check.unfinished) if (partial > 0) known.set(key, partial);
	if (!unknown) return codeCheckSummary(columnName, known, cancelled);
	const col = columnName.trim() || "column";
	const ranOut = "the search ran out of time before it had read every file";
	if (!known.size) return `${cancelled ? `Stopped checking “${col}”` : `Could not check “${col}”`}: ${ranOut}.`;
	return `${codeCheckSummary(columnName, known, cancelled)} ${unknown} ${unknown === 1 ? "value was" : "values were"} not checked: ${ranOut}.`;
}

/**
 * What stopped a check that was running, other than its own Cancel: its column is no longer in the table (deleted
 * here, or taken out of the text in another view); the table went away (its tab was closed or left, or the text
 * view was put in its place); the table was given another file or project folder to show; another check was
 * started.
 */
export type CodeCheckStop = "column" | "closed" | "file" | "replaced";

/**
 * What is said, once, when a check is stopped by something other than its own Cancel. The progress went from the
 * bar and nothing said that the check had not finished. (What it had found by then is not kept, as it is after a
 * Cancel: a stop of this kind leaves nothing to show it on, or another check's result in its place.)
 */
export function codeCheckStopped(columnName: string, why: CodeCheckStop): string {
	const col = columnName.trim() || "column";
	const reason =
		why === "column"
			? "the column is no longer in the table"
			: why === "closed"
				? "the table is no longer shown"
				: why === "file"
					? "the table shows another file or folder now"
					: "another check was started";
	return `Stopped checking “${col}”: ${reason}.`;
}

/**
 * Follows one column while columns are deleted or put in another order. A check of a column's values in code
 * runs for a while, and its result was given the place the column had when the check began: with a column to its
 * left deleted meanwhile, the result landed on the column next to it.
 */
export function trackedColumn(column: number) {
	let at = column;
	return {
		/** Where the column is now; -1 once it has been deleted. */
		at: (): number => at,
		/** For every change of the columns: `remap` gives the new place of a column, or -1 for one that is gone. */
		moved(remap: (column: number) => number): void {
			if (at < 0) return;
			const next = remap(at);
			at = Number.isInteger(next) && next >= 0 ? next : -1;
		},
	};
}

/**
 * Where each column goes when a column is deleted (`deleted`) or the columns are put in another order (`order`,
 * where `order[newPlace] = oldPlace`), and where it goes back to when that change is undone. `made` is also what
 * a redo does. A check that is running follows its column through all three (`trackedColumn`): it was stopped,
 * without a word, by the undo of a change to a column it was not reading.
 *
 * Undoing a delete puts the deleted column back, but no check was following it by then: a check of that column
 * was stopped when the column went.
 */
export function columnMoves(change: { deleted: number } | { order: readonly number[] }): {
	made: (column: number) => number;
	undone: (column: number) => number;
} {
	if ("deleted" in change) {
		const gone = change.deleted;
		return {
			made: (column) => (column === gone ? -1 : column > gone ? column - 1 : column),
			undone: (column) => (column >= gone ? column + 1 : column),
		};
	}
	const order = change.order;
	return {
		made: (column) => order.indexOf(column),
		undone: (column) => order[column] ?? -1,
	};
}

// --- Keys and Focus When the Active Cell's Row Is Not Drawn -------------------

/** The fields of a key press that say what it types; a plain object does for a test. */
export type TypedKey = {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	getModifierState?: (key: string) => boolean;
};

/**
 * Whose keyboard a key press comes from, for what its modifiers mean: Option types a character on a Mac, and
 * Windows sends AltGr as Ctrl+Alt. The same press is a shortcut on the other two.
 */
export type KeyOs = "mac" | "windows" | "other";

/**
 * The character a key press types, or null when it types none: a named key (Enter, an arrow, a dead key), or a
 * shortcut. Typing on a selected cell starts an edit with that character, and "typing" was every key of one
 * character pressed with neither Ctrl nor Alt. But a keyboard layout puts characters behind those two keys:
 *
 * - AltGr, the third level of most European layouts (`@ { [ ] } \ | €` on a German one). Windows has no AltGr of
 *   its own and sends Ctrl+Alt for it, so its press says `ctrlKey` and `altKey`, with or without the AltGraph
 *   state beside them. Elsewhere the press says the AltGraph state and neither key.
 * - Option on a Mac, which is `altKey`: Option+L is `@` on a German keyboard, Option+5 `[`, and every letter has
 *   a character there. The press's `key` is the character made.
 *
 * So none of these characters could begin a cell. What is still no typing: anything with Cmd or the Windows key;
 * Ctrl without Alt (Ctrl+C); Alt without Ctrl where it is not a Mac's Option and the layout's third level is not
 * on (Alt+letter opens a menu); Ctrl+Alt where it is not AltGr (on a Mac, and where the press does not say the
 * AltGraph state and does not come from Windows); and Ctrl+Alt with a plain letter or digit even where it is,
 * which is a shortcut on a key that has nothing on its third level (Ctrl+Alt+S), not a character a layout keeps
 * there.
 */
export function typedCharacter(e: TypedKey, os: KeyOs = "other"): string | null {
	const key = e.key;
	const first = key.codePointAt(0);
	// One character, and not a control character: a named key is a word ("Enter", "Dead"), never one character.
	if (first === undefined || key.length !== (first > 0xffff ? 2 : 1) || first < 0x20 || first === 0x7f) return null;
	if (e.metaKey) return null;
	const ctrl = Boolean(e.ctrlKey);
	const alt = Boolean(e.altKey);
	const thirdLevel = Boolean(e.getModifierState?.("AltGraph"));
	if (ctrl && alt) return os !== "mac" && (os === "windows" || thirdLevel) && !/^[a-z0-9]$/i.test(key) ? key : null;
	if (ctrl) return null;
	if (alt) return os === "mac" || thirdLevel ? key : null;
	return key;
}

/**
 * Whether a key is one the table answers on a cell (the keys of the view's `onCellKey`; keep the two together):
 * typing (`typedCharacter`), Enter and F2, Delete and Backspace, the arrows with or without Shift, Alt+arrows,
 * Page Up and Down, Home and End, and the menu key. A key pressed while the table itself has the focus is asked
 * this, and one that passes goes to the active cell; any other (a modifier alone, Ctrl+C, Escape, Tab, F8) is left
 * to whoever else answers it.
 */
export function keyActsOnCell(e: TypedKey & { shiftKey?: boolean }, os: KeyOs = "other"): boolean {
	const ctrl = Boolean(e.ctrlKey || e.metaKey);
	const alt = Boolean(e.altKey);
	const shift = Boolean(e.shiftKey);
	const key = e.key;
	if (key === "ContextMenu" || (shift && key === "F10")) return true;
	if (key === "Enter" || key === "F2") return true;
	if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") return !ctrl && !(alt && shift);
	if (key === "PageUp" || key === "PageDown" || key === "Delete" || key === "Backspace") return !ctrl && !alt;
	if (key === "Home" || key === "End") return !alt;
	return typedCharacter(e, os) !== null;
}

/**
 * What becomes of the focus once the rows have been drawn again. The rows are drawn a window at a time, and a
 * cell that had the focus is taken off the page when its row is scrolled far enough away; the browser then gives
 * the focus to the page's body, and no key reached the table any more. So the table itself takes the focus
 * ("table") and holds it for the cell (`held`), and the active cell gets it back ("cell") when its row is drawn
 * again. Null leaves the focus where it is: nothing was lost, or the focus has since gone somewhere else.
 */
export function focusAfterRowsDrawn(s: {
	/** The focus was in the rows before they were drawn again. */
	wasInRows: boolean;
	/** It is nowhere now: what had it is gone from the page. */
	lost: boolean;
	/** The table was already holding the focus for the cell. */
	held: boolean;
	/** The table itself has the focus now. */
	onTable: boolean;
	/** The active cell's row is among the rows drawn. */
	cellDrawn: boolean;
}): { focus: "table" | "cell" | null; held: boolean } {
	const take = s.wasInRows && s.lost;
	if (!take && !(s.held && s.onTable)) return { focus: null, held: false };
	if (s.cellDrawn) return { focus: "cell", held: false };
	return { focus: take ? "table" : null, held: true };
}

/**
 * Where Shift+Tab goes from a cell, among the rows and columns as they are shown: the cell before it, and from a
 * row's first cell the last cell of the row above. From the first cell of all there is nowhere to go, and it
 * stays where it is, as in Excel and Sheets; the editor closed there with the focus given to nothing.
 */
export function cellBeforeInTabOrder(visRow: number, visCol: number, colCount: number): { visRow: number; visCol: number } {
	if (visCol > 0) return { visRow, visCol: visCol - 1 };
	if (visRow > 0 && colCount > 0) return { visRow: visRow - 1, visCol: colCount - 1 };
	return { visRow, visCol };
}

// --- Files That Are There and Could Not Be Read (Schema Sync, ER Diagram) ----

/** A file that is there and could not be read: the name it is shown by, and why, as the reader said it. */
export type UnreadFile = { file: string; why: string };

/**
 * A file's text, or why there is none to work from: the reader's refusal in plain words (`plainFileError`), or
 * that the file is not text. A read that failed used to be taken for a file with nothing in it, or for no file:
 * since the backend reads no text over 20 MB, a schema script larger than that fell out of a sync or a diagram
 * without a word. `file` is the name the file is shown by, `root` the folder a path in a refusal is named from.
 */
export async function textOrWhy(
	read: () => Promise<{ text: string; binary?: unknown }>,
	file: string,
	root?: string | null,
): Promise<{ text: string } | { why: string }> {
	try {
		const got = await read();
		return got.binary ? { why: `${file} is not text.` } : { text: got.text };
	} catch (e: any) {
		return { why: plainFileError(String(e?.message ?? e), root) };
	}
}

/**
 * The files that could not be read, each with why, as sentences for a notice. A refusal that names the file itself
 * ("schema/big.sql is 21.0 MB: too large to open here (the most is 20.0 MB).") is said as it is; any other reason
 * is put after the file's name. Three files are said and the rest counted.
 */
export function unreadFilesSaid(unread: readonly UnreadFile[]): string {
	const sentence = ({ file, why }: UnreadFile) => {
		const reason = why.trim();
		if (!reason) return `${file} could not be read.`;
		if (reason.replace(/\\/g, "/").startsWith(file.replace(/\\/g, "/"))) return /[.!?]$/.test(reason) ? reason : `${reason}.`;
		return `${file} could not be read (${reason.replace(/\.$/, "")}).`;
	};
	const said = unread.slice(0, 3).map(sentence).join(" ");
	const more = unread.length - 3;
	return more > 0 ? `${said} ${more} more ${more === 1 ? "file" : "files"} could not be read either.` : said;
}

/**
 * Whether a registry row's note says the row came from one of these files: "From schema/tables.sql", as a sync
 * from the schema writes it, the file's name alone or with something written after it. The files are named as the
 * notes name them, from the workspace's root with forward slashes; the case of the letters is not held to.
 */
export function noteNamesFile(note: string, files: readonly string[]): boolean {
	const asNamed = (path: string) => path.trim().replace(/\\/g, "/").toLowerCase();
	const source = asNamed(/^\s*From\s+(.*)/i.exec(note)?.[1] ?? "");
	return files.some((file) => source === asNamed(file) || source.startsWith(`${asNamed(file)} `));
}

/**
 * The rows of a database registry that a sync from the schema SQL files offers to mark as gone: rows an earlier
 * sync wrote (the note begins "From"), not marked gone yet, whose object is in none of the files that were read
 * (`sqlNames`: every object found, in lower case, with and without its schema).
 *
 * A row whose note names a file that is there but could not be read (`unreadFiles`) is not among them. Such a
 * file was passed over without a word, and every row that had come from it was offered as gone, though nothing
 * was known of the file but that it was too large to open.
 */
export function registryRowsGone<R extends { name: string; note: string; status: string }>(
	rows: readonly R[],
	sqlNames: ReadonlySet<string>,
	unreadFiles: readonly string[],
): R[] {
	return rows.filter(
		(r) =>
			r.name &&
			/^From\s+/i.test(r.note) &&
			r.status !== "gone" &&
			!noteNamesFile(r.note, unreadFiles) &&
			!sqlNames.has(r.name.toLowerCase()) &&
			!sqlNames.has(r.name.split(".").pop()!.toLowerCase()),
	);
}
