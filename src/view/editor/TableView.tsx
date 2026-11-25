// A table of values (CSV or TSV), as a table. It is a view of the text in the
// editor (ADR 0002): a cell changed here is that cell's part of the text
// changed, and nothing else; the Text switch shows the same file as written.
//
// Each column header offers sorting and a value/text filter menu, column badge
// formatting is driven strictly by the user/project `csvTable` configuration,
// row/cell/column actions live in right-click context menus, a blank final row
// lets users add entries without writing empty lines until content is entered,
// and code-usage checks target the exact column, rows, and file globs chosen.
import { createEffect, createMemo, createSignal, createUniqueId, flush, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { Portal, type JSX } from "@solidjs/web";
import {
	addCsvColumn,
	appendRowEdit,
	columnOf,
	convertCsvDelimiter,
	csvCell,
	csvDuplicateKeys,
	csvRow,
	deleteCsvColumn,
	deleteCsvRows,
	insertRowEdit,
	moveCsvRow,
	parseClipboardGrid,
	parseCsv,
	rawRowText,
	renameCsvColumn,
	reorderCsvColumns,
	rowSpan,
	sortCsvRows,
	tableToTsv,
	tally,
	type Cell,
	type CsvDelimiter,
} from "../../shared/csv";
import {
	badgeToneForValue,
	columnValueOptions,
	describeColumnFilter,
	effectiveCsvTableConfig,
	fullColumnOrder,
	hideColumn,
	isColumnFilterActive,
	isNaturalOrder,
	isUnrecognizedBadgeValue,
	knownBadgeValues,
	moveColumnInList,
	pruneColumnOrder,
	pruneFrozenColumns,
	pruneHiddenColumns,
	remapColumnIndex,
	removeColumnFromRules,
	rowMatchesColumnFilters,
	ruleForColumn,
	showColumn,
	suggestionsForColumn,
	toggleColumnFilterValue,
	toggleFrozenColumn,
	visualColumnOrder,
	type BadgeTone,
	type ColumnFilter,
} from "../../shared/csvFormat";
import {
	codeCheckSearchOptions,
	codeCheckSummary,
	columnCheckTargets,
	defaultCheckColumn,
	defaultExcludePattern,
	extractCellTerms,
	termLookupKey,
	type CodeCheckRowScope,
	type CodeCheckSpec,
} from "../../shared/registryCheck";
import { baseName, dirName, isInside, joinPath, relativeTo, resolvePath } from "../../shared/paths";
import { keyOf, keysIn, ticketColumn } from "../../shared/registryTickets";
import { findSchemaDocForIdentifier } from "../../shared/schemaIndex";
import { SEARCH_LIMIT, type SearchOptions } from "../../shared/searchPattern";
import { extractSqlObjects } from "../../shared/sqlSchema";
import { backend } from "../backend";
const copyText = (text: string, label: string) => import("../commands").then((m) => m.copyText(text, label));
import { ask, choose, quickPick, type QuickPickOption } from "../dialogs";
import { Icon } from "../Icon";
import { modalOpen } from "../modal";
import { placeAnchoredMenu, submenuOrInline } from "../../shared/contextMenu";
import {
	AUTOFIT_SAMPLE_LIMIT,
	cellsToMarkdownTable,
	compareRowsBySorts,
	compileCellMatcher,
	computeVirtualWindow,
	DEFAULT_ROW_HEIGHT,
	extractFirstHttpUrl,
	findUnknownTicketTokens,
	generateFillSeries,
	getTableViewState,
	isCellInFindSelection,
	isDedicatedTicketColumn,
	isSchemaTableColumn,
	nextTableIssueIndex,
	parseTableViewStateStore,
	pruneSortSpecs,
	remapSortSpecs,
	replaceCellMatches,
	sampleRowsForAutoFit,
	serializeTableViewStateStore,
	setColumnSortDirection,
	splitCellUrls,
	summarizeTableIssues,
	tableViewFileKey,
	tableViewStateStorageKey,
	toggleSortSpec,
	tokenizeCellLinks,
	upsertTableViewState,
	type CellFindOptions,
	type SortSpec,
	type TableIssue,
} from "../../shared/tablePower";
import { chooseFromMenu, rowMenuOpen, type RowMenuEntry } from "../panels/RowMenu";
import { searchFor } from "../panels/Search";
import { docs } from "../project";
import { canonical, documents, notify, openFile, revealSignal, saveSetting, state, takeReveal, type Reveal } from "../state";
import { CsvCodeCheckDialog } from "./CsvCodeCheckDialog";
import { CsvFormatDialog } from "./CsvFormatDialog";
import { registerTableColumnJump, registerTableFind } from "./liveBridge";
import { rowsAsked, rowsShown } from "./tableRows";
import "./tableViewExtra.css";

/** Maximum distinct values rendered in a column filter checklist before asking the user to narrow via search. */
const FILTER_VALUES_CAP = 250;

/** Minimum column width (px) when manually dragging a resize handle. */
const MIN_COL_WIDTH = 56;

/** Upper cap (px) when double-clicking a column divider to auto-fit long cells. */
const MAX_AUTOFIT_WIDTH = 960;

/** Column-0 headers that are categorical/descriptive rather than unique keys (suppressed from duplicate-key checks). */
const NON_KEY_COL0_RE = /^(status|state|note|notes|comment|comments|description|desc|summary|remark|remarks|kind|type|category|group|priority|severity|tag|tags|phase|stage)$/i;

/** Non-ticket placeholder words ignored by Ticket-column inline validation. */
const TICKET_PLACEHOLDER_RE = /^(?:[-—–]+|n\/a|none|tbd|todo)$/i;

/** Recognizes keyboard context-menu requests (ADR 0010). */
const isContextMenuKey = (e: KeyboardEvent) => e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");

/** Anchors a keyboard-invoked context menu neatly beneath its focused element. */
function pointUnder(el: Element): { x: number; y: number } {
	const rect = el.getBoundingClientRect();
	return { x: rect.left + 8, y: rect.bottom };
}

/** Opens an external `http://` or `https://` URL safely in the user's browser. */
function openExternalUrl(url: string) {
	if (!/^https?:\/\//i.test(url)) return;
	void window.open(url, "_blank", "noopener,noreferrer");
}

/** Measures rendered single-line text width with an offscreen canvas (falls back cleanly when unavailable). */
let measureCanvasCtx: CanvasRenderingContext2D | null | undefined;
function measureTextPx(text: string, font: string): number {
	if (!text) return 0;
	if (measureCanvasCtx === undefined) {
		try {
			measureCanvasCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
		} catch {
			measureCanvasCtx = null;
		}
	}
	if (measureCanvasCtx) {
		measureCanvasCtx.font = font;
		return measureCanvasCtx.measureText(text).width;
	}
	return text.length * 8;
}

/** Parses plain or thousands-grouped numbers for the footer column sum (`null` when not numeric). */
function parseNumericValue(raw: string): number | null {
	const t = raw.trim();
	if (!t) return null;
	if (/^-?\d+(?:\.\d+)?$/.test(t)) {
		const n = Number(t);
		return Number.isFinite(n) ? n : null;
	}
	if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) {
		const n = Number(t.replace(/,/g, ""));
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

type OpenFilterMenu = {
	column: number;
	x: number;
	y: number;
	maxHeight: number;
	anchor: HTMLElement;
};

type FillDrag = {
	src: { r1: number; r2: number; c1: number; c2: number };
	axis: "down" | "right" | "up" | "left" | null;
	target: { r1: number; r2: number; c1: number; c2: number } | null;
	literal: boolean;
};

type FindSelectionScope = {
	rows: Set<number>;
	cols: Set<number>;
	rowCount: number;
	colCount: number;
};

type ActiveCell =
	| { ghost: false; row: number; column: number }
	| { ghost: true; column: number };

type EditingCell =
	| { ghost: false; row: number; column: number; seed?: string; forceMultiline?: boolean; caret?: number }
	| { ghost: true; column: number; seed?: string; forceMultiline?: boolean; caret?: number };

type CodeCheckResult = {
	column: number;
	columnName: string;
	splitLists: boolean;
	caseSensitive: boolean;
	options: SearchOptions;
	counts: Map<string, number>;
};

type ColDrag = {
	col: number;
	label: string;
	fromVis: number;
	dropVis: number;
	side: "before" | "after";
	x: number;
	y: number;
};

type RowDrag = {
	fromRow: number;
	dropRow: number;
	side: "before" | "after";
	label: string;
	x: number;
	y: number;
};

type CellRangeRect = {
	r1: number;
	r2: number;
	c1: number;
	c2: number;
	rowCount: number;
	colCount: number;
	isMulti: boolean;
};

type CellPickerOption = {
	value: string;
	tone?: BadgeTone | null;
	meta?: string;
	isCurrent?: boolean;
};

type DisplayEntry =
	| { kind: "group"; entryId: string; entryKey: number; key: string; label: string; count: number; rowIndices: number[]; collapsed: boolean }
	| { kind: "row"; entryId: string; index: number; cells: Cell[] };

type CommitMove = "none" | "stay" | "next" | "prev" | "down" | "range";

export type OffsetTextEdit = { start: number; end: number; text: string };

/**
 * Serializes a cell value for a row of `cellCount` cells. In 1-column CSVs or
 * ragged 1-cell rows, an empty value must be written as `""` so `parseCsv`
 * preserves the row instead of dropping an empty blank line.
 */
export function serializeCellInRow(value: string, cellCount: number, delimiter: CsvDelimiter = ","): string {
	return value === "" && cellCount <= 1 ? '""' : csvCell(value, delimiter);
}

/**
 * Merges zero-width insertions (`start === end`) that target the same offset
 * in insertion order so Monaco never receives colliding zero-width ranges
 * (e.g. an empty trailing cell + ragged-row padding + EOF appended rows).
 */
export function coalesceZeroWidthEdits(edits: readonly OffsetTextEdit[]): OffsetTextEdit[] {
	const out: OffsetTextEdit[] = [];
	const zeroByOffset = new Map<number, OffsetTextEdit>();
	for (const ed of edits) {
		if (ed.start === ed.end) {
			const prev = zeroByOffset.get(ed.start);
			if (prev) {
				prev.text += ed.text;
			} else {
				const copy: OffsetTextEdit = { start: ed.start, end: ed.end, text: ed.text };
				zeroByOffset.set(ed.start, copy);
				out.push(copy);
			}
		} else {
			out.push({ start: ed.start, end: ed.end, text: ed.text });
		}
	}
	return out;
}

/** Remaps selected row indices after inserting a row at `targetRow` (`r >= targetRow ? r + 1 : r`). */
export function remapRowSetOnInsert(rows: ReadonlySet<number>, targetRow: number): Set<number> {
	const next = new Set<number>();
	for (const r of rows) next.add(r >= targetRow ? r + 1 : r);
	return next;
}

/** Remaps a single row index after inserting a row at `targetRow`. */
export function remapRowIndexOnInsert(row: number | null, targetRow: number): number | null {
	if (row === null) return null;
	return row >= targetRow ? row + 1 : row;
}

/** Remaps selected row indices after deleting `deletedRow` (drops `deletedRow`, shifts `r > deletedRow`). */
export function remapRowSetOnDelete(rows: ReadonlySet<number>, deletedRow: number): Set<number> {
	const next = new Set<number>();
	for (const r of rows) {
		if (r === deletedRow) continue;
		next.add(r > deletedRow ? r - 1 : r);
	}
	return next;
}

/** Remaps a single row index after deleting `deletedRow`. */
export function remapRowIndexOnDelete(row: number | null, deletedRow: number): number | null {
	if (row === null || row === deletedRow) return null;
	return row > deletedRow ? row - 1 : row;
}

/** True when a split chunk inside a ticket cell consists solely of whitespace, comma, or semicolon separators. */
export function isTicketSeparatorChunk(chunk: string): boolean {
	return /^[\s,;]+$/.test(chunk);
}

/** Directed transition key for schema Undo/Redo UI snapshots (`"fromAlt->toAlt"`). */
export function colSnapshotTransitionKey(fromAlt: number, toAlt: number): string {
	return `${fromAlt}->${toAlt}`;
}

/** Formats a single cell value for clipboard copy, TSV-quoting values with line breaks or tabs so pasting back stays in 1 cell. */
export function formatSingleCellForClipboard(val: string): string {
	return /[\r\n\t]/.test(val) ? csvCell(val, "\t") : val;
}

/** Returns the number of frozen columns currently visible (excluding pruned hidden columns). */
export function countVisibleFrozenColumns(headerCount: number, frozen: readonly number[], hidden: ReadonlySet<number>): number {
	const prunedHidden = pruneHiddenColumns(hidden, headerCount);
	return pruneFrozenColumns(frozen, headerCount).filter((c) => !prunedHidden.has(c)).length;
}

const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

/**
 * Resolves a cell value to a strictly workspace-internal file path, or returns `null`
 * if it is not a file path, contains illegal characters, or points outside `root`
 * (including out-of-workspace POSIX, Windows drive, and UNC absolute paths).
 */
export function resolveWorkspaceFileLink(root: string, rawVal: string): string | null {
	const trimmed = rawVal.trim();
	if (!root || !trimmed) return null;
	if (/^(?:https?:|mailto:|ftp:)/i.test(trimmed)) return null;
	if (/[\r\n<>|*?"]/.test(trimmed) || trimmed === "." || trimmed === "..") return null;
	const looksLikePath = /[\\/]/.test(trimmed) || /\.[A-Za-z0-9]{1,10}$/.test(trimmed);
	if (!looksLikePath) return null;
	if (ABSOLUTE_PATH_RE.test(trimmed)) {
		if (!isInside(root, trimmed) || isInside(trimmed, root)) return null;
		if (trimmed.includes("..") && !trimmed.startsWith("\\\\") && !trimmed.startsWith("//")) {
			const drive = /^[a-zA-Z]:(?=[\\/])/.exec(trimmed);
			const normalized = drive
				? resolvePath(`${drive[0]}${trimmed[2]}`, trimmed.slice(3))
				: resolvePath("/", trimmed);
			if (!isInside(root, normalized) || isInside(normalized, root)) return null;
			return normalized;
		}
		return trimmed;
	}
	if (/^[a-zA-Z]:/.test(trimmed)) return null;
	const parts = trimmed.split(/[\\/]/).filter((p) => p && p !== ".");
	if (!parts.length) return null;
	const resolved = parts.includes("..") ? resolvePath(root, trimmed) : joinPath(root, ...parts);
	if (!isInside(root, resolved) || isInside(resolved, root)) return null;
	return resolved;
}

const shortLabel = (text: string, max = 26) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function delimiterLabel(d: CsvDelimiter): string {
	if (d === "\t") return "Tab";
	if (d === ";") return "Semicolon";
	if (d === "|") return "Pipe";
	return "Comma";
}

function parseTicketToken(raw: string): { prefix: string; token: string; existingKeys: Set<string> } {
	const m = /^(.*[,;]\s*)([^,;]*)$/.exec(raw);
	const prefix = m ? m[1]! : "";
	const token = (m ? m[2]! : raw).trim();
	const existingKeys = new Set(
		prefix
			.split(/[\s,;/]+/)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
	return { prefix, token, existingKeys };
}

function remapIndexAfterMove(idx: number, from: number, to: number): number {
	if (idx === from) return to;
	if (from < to && idx > from && idx <= to) return idx - 1;
	if (from > to && idx >= to && idx < from) return idx + 1;
	return idx;
}

function menuPoint(e: MouseEvent, fallbackEl: Element | null): { x: number; y: number } {
	if (e.clientX || e.clientY || !fallbackEl) return { x: e.clientX, y: e.clientY };
	const rect = fallbackEl.getBoundingClientRect();
	return { x: rect.left + 8, y: rect.bottom };
}

export function TableView(props: { path: string; group?: number }) {
	const model = documents.get(props.path)?.model;
	let rootEl: HTMLDivElement | undefined;
	const [text, setText] = createSignal(model?.getValue() ?? "");
	/** Per-view format overrides (visual projection until converted in-file — ADR 0002). */
	const [delimiterOverride, setDelimiterOverride] = createSignal<CsvDelimiter | "auto">("auto");
	const [hasHeader, setHasHeader] = createSignal(true);
	const parseCurrentCsv = (raw: string) => {
		const delim = delimiterOverride();
		return parseCsv(raw, {
			delimiter: delim === "auto" ? undefined : delim,
			hasHeader: hasHeader(),
		});
	};
	const autoDelimiter = createMemo(() => parseCsv(text()).delimiter);

	/** Optional collapsible group-by column index (visual projection only). */
	const [groupByCol, setGroupByCol] = createSignal<number | null>(null);
	const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(new Set());

	type ColumnUiSnapshot = {
		colFilters: Map<number, ColumnFilter>;
		order: SortSpec[];
		frozenCols: number[];
		hiddenCols: Set<number>;
		colOrder: number[];
		colWidths: Record<number, number>;
		codeCheck: CodeCheckResult | null;
		groupByCol: number | null;
	};
	const colSnapshots = new Map<string, ColumnUiSnapshot>();
	let lastAltVersion = model?.getAlternativeVersionId() ?? 0;
	const captureColUi = (): ColumnUiSnapshot => ({
		colFilters: new Map(colFilters()),
		order: order().map((s) => ({ ...s })),
		frozenCols: [...frozenCols()],
		hiddenCols: new Set(hiddenCols()),
		colOrder: [...colOrder()],
		colWidths: { ...colWidths() },
		codeCheck: codeCheck() ? { ...codeCheck()! } : null,
		groupByCol: groupByCol(),
	});
	const restoreColUi = (snap: ColumnUiSnapshot) => {
		if (checking()) {
			userCancelledRunId = 0;
			checkRunId++;
			setChecking(null);
		}
		setColFilters(new Map(snap.colFilters));
		setOrder(snap.order.map((s) => ({ ...s })));
		setFrozenCols([...snap.frozenCols]);
		setHiddenCols(new Set(snap.hiddenCols));
		setColOrder([...snap.colOrder]);
		setColWidths({ ...snap.colWidths });
		setCodeCheck(snap.codeCheck ? { ...snap.codeCheck } : null);
		setGroupByCol(snap.groupByCol);
	};
	const listener = model?.onDidChangeContent(() => {
		const prevAlt = lastAltVersion;
		const curAlt = model.getAlternativeVersionId();
		lastAltVersion = curAlt;
		const prevCount = table().rows.length;
		const next = model.getValue();
		setText(next);
		const snap = colSnapshots.get(colSnapshotTransitionKey(prevAlt, curAlt));
		if (snap) {
			restoreColUi(snap);
			clearFindSelectionScope();
			clearRowHeights();
		}
		const count = parseCurrentCsv(next).rows.length;
		if (count !== prevCount) clearRowHeights();
		const cur = current();
		if (cur !== null && cur >= count) setCurrent(count > 0 ? count - 1 : null);
	});
	onCleanup(() => listener?.dispose());

	const table = createMemo(() => parseCurrentCsv(text()));
	const csvConfig = createMemo(() => effectiveCsvTableConfig(state.settings.csvTable));
	const headerName = (col: number) => table().header[col]?.text.trim() ?? "";
	const columnRule = (col: number) => ruleForColumn(csvConfig(), headerName(col));

	const [filter, setFilter] = createSignal("");
	/** Per-column filters keyed by 0-based column index. */
	const [colFilters, setColFilters] = createSignal<Map<number, ColumnFilter>>(new Map());
	/** Currently open column header filter popover, if any. */
	const [filterMenu, setFilterMenu] = createSignal<OpenFilterMenu | null>(null);
	/** Configurable column badge formatting dialog state. */
	const [formatDialog, setFormatDialog] = createSignal<{ open: boolean; initialColumn?: string }>({ open: false });
	/** Targeted "Check in code" dialog state. */
	const [checkDialog, setCheckDialog] = createSignal<{ open: boolean; column: number; rowScope?: CodeCheckRowScope }>({
		open: false,
		column: 0,
	});
	/** Remembers last chosen file scope & match options across checks in this view. */
	const [lastCheckSpec, setLastCheckSpec] = createSignal<Partial<CodeCheckSpec>>({});

	/** Currently selected cell (drives both row highlight and crisp cell selection frame). */
	const [activeCell, setActiveCell] = createSignal<ActiveCell | null>(null);
	/** Anchor corner of rectangular multi-cell selection (Shift+Arrow, Shift+Click, or pointer drag). */
	const [cellAnchor, setCellAnchor] = createSignal<{ row: number; column: number } | null>(null);
	/** True while pointer-dragging across cells to select a rectangular range. */
	const [isDragSelecting, setIsDragSelecting] = createSignal(false);
	/** Active row grip pointer drag state (only when unsorted, unfiltered, ungrouped). */
	const [rowDrag, setRowDrag] = createSignal<RowDrag | null>(null);
	/** Active Excel drag-fill handle state (down/right/up/left with optional Alt literal copy). */
	const [fillDrag, setFillDrag] = createSignal<FillDrag | null>(null);
	/** Briefly highlights a row revealed from Search, Outline, or navigation history. */
	const [revealedRow, setRevealedRow] = createSignal<number | null>(null);
	let revealTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => {
		if (revealTimer !== undefined) clearTimeout(revealTimer);
	});
	const current = () => {
		const ac = activeCell();
		return ac && !ac.ghost ? ac.row : null;
	};
	const setCurrent = (row: number | null) => {
		setCellAnchor(null);
		if (row === null) {
			setActiveCell(null);
			return;
		}
		const prev = activeCell();
		const col = prev && !hiddenCols().has(prev.column) ? prev.column : (visibleColumns()[0] ?? 0);
		setActiveCell({ ghost: false, row, column: col });
	};
	const isCellSelected = (row: number, col: number) => {
		const ac = activeCell();
		return Boolean(ac && !ac.ghost && ac.row === row && ac.column === col);
	};
	const isGhostSelected = (col: number) => {
		const ac = activeCell();
		return Boolean(ac && ac.ghost && ac.column === col);
	};
	const clearCellSelection = () => {
		setCellAnchor(null);
		setActiveCell(null);
		if (
			document.activeElement instanceof HTMLElement &&
			rootEl?.contains(document.activeElement) &&
			document.activeElement.closest(".table-view td")
		) {
			document.activeElement.blur();
		}
	};

	/** Filter to rows with duplicate non-empty keys in column 0 (when column 0 is key-like). */
	const [onlyDupes, setOnlyDupes] = createSignal(false);
	/** Filter to rows that have at least one inline validation issue. */
	const [onlyIssues, setOnlyIssues] = createSignal(false);
	/** Compact inline Find & Replace bar state (`Ctrl+F` / `Ctrl+H`). */
	const [findOpen, setFindOpen] = createSignal(false);
	const [replaceOpen, setReplaceOpen] = createSignal(false);
	const [findQuery, setFindQuery] = createSignal("");
	const [replaceText, setReplaceText] = createSignal("");
	const [findCurrentColOnly, setFindCurrentColOnly] = createSignal(false);
	const [findCaseSensitive, setFindCaseSensitive] = createSignal(false);
	const [findWholeWord, setFindWholeWord] = createSignal(false);
	const [findRegex, setFindRegex] = createSignal(false);
	const [findInSelection, setFindInSelection] = createSignal(false);
	const [findSelectionScope, setFindSelectionScope] = createSignal<FindSelectionScope | null>(null);
	const [findMatchIdx, setFindMatchIdx] = createSignal(0);
	let findInputEl: HTMLInputElement | undefined;
	let replaceInputEl: HTMLInputElement | undefined;
	const clearFindSelectionScope = () => {
		setFindInSelection(false);
		setFindSelectionScope(null);
	};

	// Press Escape (when no edit input, popover, menu, modal, or drag is active) to close Find or clear cell selection.
	const hasSelectionOrFind = createMemo(() => Boolean(activeCell() || findOpen()));
	createEffect(
		() => hasSelectionOrFind(),
		(active) => {
			if (!active) return;
			const onKeyDown = (e: KeyboardEvent) => {
				if (e.key !== "Escape" || e.defaultPrevented) return;
				if (editing() || filterMenu() || colDrag() || rowDrag() || fillDrag() || modalOpen() || rowMenuOpen()) return;
				const target = e.target as Node | null;
				if (!target || !rootEl?.contains(target)) return;
				const targetEl = target instanceof Element ? target : null;
				if (findOpen()) {
					e.preventDefault();
					closeFind();
					return;
				}
				if (targetEl?.closest("input, textarea")) return;
				e.preventDefault();
				clearCellSelection();
			};
			window.addEventListener("keydown", onKeyDown);
			return () => window.removeEventListener("keydown", onKeyDown);
		},
	);

	/** Selected row indices (0-based in `table().rows`) for bulk operations. */
	const [selectedRows, setSelectedRows] = createSignal<Set<number>>(new Set());
	const [lastClickedRow, setLastClickedRow] = createSignal<number | null>(null);
	// Prune selected row indices when rows are deleted from the file.
	createEffect(
		() => ({ rowCount: table().rows.length, sel: selectedRows() }),
		({ rowCount, sel }) => {
			if (!sel.size) return;
			let dirty = false;
			for (const r of sel) if (r < 0 || r >= rowCount) dirty = true;
			if (dirty) {
				const next = new Set<number>();
				for (const r of sel) if (r >= 0 && r < rowCount) next.add(r);
				setSelectedRows(next);
			}
		},
	);

	/** Keeps a newly created/inserted row visible while editing even when filters are active. */
	const [pinnedRow, setPinnedRow] = createSignal<number | null>(null);
	/** Ordered multi-column sort specs (visual projection only; the file's own order is unchanged). */
	const [order, setOrder] = createSignal<SortSpec[]>([]);
	/** Ordered list of 0-based CSV column indices currently frozen to the left side (visual only; file unchanged). */
	const [frozenCols, setFrozenCols] = createSignal<number[]>([]);
	/** Temporary visual column order (empty = natural file order; can be saved to the CSV or reset). */
	const [colOrder, setColOrder] = createSignal<number[]>([]);
	/** Set of 0-based CSV column indices currently hidden (visual only; never removed from the CSV). */
	const [hiddenCols, setHiddenCols] = createSignal<Set<number>>(new Set());
	/** Per-column explicit widths in pixels (keyed by 0-based CSV column index). */
	const [colWidths, setColWidths] = createSignal<Record<number, number>>({});
	/** Column currently being drag-resized, if any. */
	const [resizingCol, setResizingCol] = createSignal<number | null>(null);
	/** Active column-header pointer drag state. */
	const [colDrag, setColDrag] = createSignal<ColDrag | null>(null);
	/** Measured cumulative sticky `left` pixel offsets for frozen visual slots `0..frozenCols.length-1`. */
	const [frozenLefts, setFrozenLefts] = createSignal<number[]>([]);
	/** Measured row height cache (keyed by data row index >= 0 or negative group entry key) for drift-free virtualization. */
	const rowHeights = new Map<number, number>();
	const [rowHeightVer, setRowHeightVer] = createSignal(0);
	const clearRowHeights = () => {
		const hadEntries = rowHeights.size > 0;
		rowHeights.clear();
		if (hadEntries) setRowHeightVer((v) => v + 1);
	};

	/** Targeted code-usage check state (specific column, scope, match options, and cancellable progress). */
	const [codeCheck, setCodeCheck] = createSignal<CodeCheckResult | null>(null);
	const [checking, setChecking] = createSignal<{ done: number; total: number; columnName: string } | null>(null);
	const [onlyMissing, setOnlyMissing] = createSignal(false);
	let checkRunId = 0;
	let userCancelledRunId = 0;
	let disposed = false;
	onCleanup(() => {
		disposed = true;
		checkRunId++;
	});

	const cancelCodeCheck = () => {
		if (!checking()) return;
		userCancelledRunId = checkRunId;
		checkRunId++;
		setChecking(null);
	};

	const clearCodeCheck = () => {
		userCancelledRunId = 0;
		checkRunId++;
		setChecking(null);
		setCodeCheck(null);
		setOnlyMissing(false);
	};

	/** Workspace-scoped per-file view-state persistence (localStorage LRU, max 40 files; never edits CSV text — ADR 0002). */
	const viewStateStorageKey = createMemo(() => tableViewStateStorageKey(state.workspace?.root));
	const viewStateFileKey = createMemo(() => tableViewFileKey(props.path, state.workspace?.root));
	const [hydratedViewKey, setHydratedViewKey] = createSignal<string | null>(null);
	const loadViewStore = (storageKey: string) => {
		try {
			return parseTableViewStateStore(typeof localStorage !== "undefined" ? localStorage.getItem(storageKey) : null);
		} catch {
			return parseTableViewStateStore(null);
		}
	};
	const writeViewStore = (storageKey: string, store: ReturnType<typeof parseTableViewStateStore>) => {
		try {
			if (typeof localStorage !== "undefined") localStorage.setItem(storageKey, serializeTableViewStateStore(store));
		} catch {
			// Ignore quota / privacy storage errors.
		}
	};

	createEffect(
		() => [props.path, state.workspace?.root, viewStateStorageKey(), viewStateFileKey()] as const,
		([, , storageKey, fileKey]) => {
			clearCodeCheck();
			setSelectedRows(new Set<number>());
			setLastClickedRow(null);
			setCellAnchor(null);
			setOnlyDupes(false);
			setOnlyIssues(false);
			setFindOpen(false);
			setReplaceOpen(false);
			setFindQuery("");
			setReplaceText("");
			setFindInSelection(false);
			setFindSelectionScope(null);
			setFindMatchIdx(0);
			setCollapsedGroups(new Set<string>());
			setDelimiterOverride("auto");
			setHasHeader(true);
			setRevealedRow(null);
			rowHeights.clear();
			setRowHeightVer((v) => v + 1);

			const colCount = untrack(table).header.length;
			const saved = getTableViewState(loadViewStore(storageKey), fileKey, colCount > 0 ? colCount : undefined);
			if (saved) {
				setColWidths(saved.colWidths);
				setFrozenCols(saved.frozenCols);
				setColOrder(isNaturalOrder(saved.colOrder) ? [] : saved.colOrder);
				setHiddenCols(new Set(saved.hiddenCols));
				setOrder(saved.order);
				setGroupByCol(saved.groupByCol);
			} else {
				setColWidths({});
				setFrozenCols([]);
				setColOrder([]);
				setHiddenCols(new Set<number>());
				setOrder([]);
				setGroupByCol(null);
			}
			setHydratedViewKey(`${storageKey}::${fileKey}`);
		},
	);

	// Invalidate cached off-screen row heights when column widths, column visibility, format overrides, or grouping change.
	createEffect(
		() => [colWidths(), hiddenCols()] as const,
		() => {
			clearRowHeights();
		},
		{ defer: true },
	);
	createEffect(
		() => [hasHeader(), delimiterOverride()] as const,
		() => {
			clearFindSelectionScope();
			clearRowHeights();
		},
		{ defer: true },
	);
	createEffect(
		() => [groupByCol(), collapsedGroups()] as const,
		() => {
			clearRowHeights();
		},
		{ defer: true },
	);

	createEffect(
		() => ({
			hydrated: hydratedViewKey(),
			storageKey: viewStateStorageKey(),
			fileKey: viewStateFileKey(),
			snap: {
				colWidths: colWidths(),
				frozenCols: frozenCols(),
				colOrder: colOrder(),
				hiddenCols: [...hiddenCols()].sort((a, b) => a - b),
				order: order(),
				groupByCol: groupByCol(),
			},
		}),
		({ hydrated, storageKey, fileKey, snap }) => {
			if (hydrated !== `${storageKey}::${fileKey}`) return;
			const nextStore = upsertTableViewState(loadViewStore(storageKey), fileKey, snap);
			writeViewStore(storageKey, nextStore);
		},
	);
	/** Complete left-to-right column order (including hidden columns) used when applying order to the file. */
	const fullColumns = createMemo(() =>
		fullColumnOrder(table().header.length, frozenCols(), colOrder().length ? colOrder() : undefined),
	);
	/** Visual left-to-right column order: frozen columns first, then remaining visible columns in current base order. */
	const visibleColumns = createMemo(() =>
		visualColumnOrder(table().header.length, frozenCols(), colOrder().length ? colOrder() : undefined, hiddenCols()),
	);
	/** Currently visible frozen columns (excludes any hidden columns so frozen/hidden overlap never freezes an unfrozen slot). */
	const visibleFrozenCols = createMemo(() => {
		const count = table().header.length;
		const prunedHidden = pruneHiddenColumns(hiddenCols(), count);
		return pruneFrozenColumns(frozenCols(), count).filter((c) => !prunedHidden.has(c));
	});
	const visibleFrozenCount = createMemo(() => visibleFrozenCols().length);
	const hasCustomOrder = createMemo(
		() => colOrder().length > 0 && !isNaturalOrder(pruneColumnOrder(colOrder(), table().header.length)),
	);
	const differsFromFile = createMemo(() => !isNaturalOrder(fullColumns()));
	const hasCustomWidths = createMemo(() => Object.keys(colWidths()).length > 0);
	const hasCustomViewState = createMemo(
		() =>
			hasCustomWidths() ||
			frozenCols().length > 0 ||
			hasCustomOrder() ||
			hiddenCols().size > 0 ||
			order().length > 0 ||
			groupByCol() !== null,
	);
	const isFrozenCol = (col: number) => frozenCols().includes(col);
	const toggleFreeze = (col: number) => setFrozenCols((prev) => toggleFrozenColumn(prev, col));
	const unfreezeAll = () => setFrozenCols([]);
	const resetColumnOrder = () => setColOrder([]);
	const resetColumnWidths = () => setColWidths({});
	const resetTableView = () => {
		setColWidths({});
		setFrozenCols([]);
		setColOrder([]);
		setHiddenCols(new Set<number>());
		setOrder([]);
		setGroupByCol(null);
		setCollapsedGroups(new Set<string>());
		rowHeights.clear();
		setRowHeightVer((v) => v + 1);
		notify("Reset table view to defaults.");
	};
	const cellStyle = (col: number, visIdx: number): JSX.CSSProperties | undefined => {
		const isFrozen = visIdx < visibleFrozenCount();
		const w = colWidths()[col];
		if (!isFrozen && w === undefined) return undefined;
		const style: JSX.CSSProperties = {};
		if (isFrozen) style.left = `${frozenLefts()[visIdx] ?? (visIdx === 0 ? 56 : 0)}px`;
		if (w !== undefined) {
			style.width = `${w}px`;
			style["min-width"] = `${w}px`;
			style["max-width"] = `${w}px`;
		}
		return style;
	};
	/** The cell currently being edited (either an existing row or the blank final ghost row). */
	const [editing, setEditing] = createSignal<EditingCell | null>(null);
	/** Live inline editor draft + custom cell picker popover state (replaces native `<datalist>`). */
	const [editDraft, setEditDraft] = createSignal("");
	const [editDirty, setEditDirty] = createSignal(false);
	const [pickerOpen, setPickerOpen] = createSignal(false);
	const [pickerIdx, setPickerIdx] = createSignal(-1);
	const [pickerAnchor, setPickerAnchor] = createSignal<DOMRect | null>(null);
	let activeInputEl: HTMLInputElement | undefined;
	let commitActiveEdit: ((val: string, move: CommitMove) => void) | null = null;
	const pickerListboxId = createUniqueId();

	createEffect(
		() => editing(),
		(ed) => {
			if (!ed) {
				setPickerOpen(false);
				setPickerAnchor(null);
				setPickerIdx(-1);
				activeInputEl = undefined;
				commitActiveEdit = null;
				return;
			}
			const existingVal = ed.ghost ? "" : (untrack(table).rows[ed.row]?.[ed.column]?.text ?? "");
			const initVal = ed.seed !== undefined ? ed.seed : existingVal;
			const isMultiline = Boolean(ed.forceMultiline) || (ed.seed === undefined && !ed.ghost && /[\r\n]/.test(existingVal));
			setEditDraft(initVal);
			setEditDirty(ed.seed !== undefined);
			setPickerIdx(-1);
			if (isMultiline) activeInputEl = undefined;
			setPickerOpen(!isMultiline);
		},
	);

	// Prune column filters, frozen/hidden columns, widths, custom order, grouping, popovers, or code-check state if columns were removed in Text view.
	createEffect(
		() => ({
			count: table().header.length,
			cur: colFilters(),
			frozen: frozenCols(),
			curHidden: hiddenCols(),
			curWidths: colWidths(),
			curOrder: colOrder(),
			ac: activeCell(),
			menu: filterMenu(),
			curSort: order(),
			curGroup: groupByCol(),
			chk: codeCheck(),
		}),
		({ count, cur, frozen, curHidden, curWidths, curOrder, ac, menu, curSort, curGroup, chk }) => {
			let stale = false;
			for (const col of cur.keys()) {
				if (col < 0 || col >= count) stale = true;
			}
			if (stale) {
				const next = new Map<number, ColumnFilter>();
				for (const [col, f] of cur) if (col >= 0 && col < count) next.set(col, f);
				setColFilters(next);
			}
			const prunedFrozen = pruneFrozenColumns(frozen, count);
			if (prunedFrozen.length !== frozen.length) setFrozenCols(prunedFrozen);
			let nextHidden = curHidden;
			if (curHidden.size) {
				const prunedHidden = pruneHiddenColumns(curHidden, count);
				if (prunedHidden.size !== curHidden.size || [...prunedHidden].some((c) => !curHidden.has(c))) {
					nextHidden = prunedHidden;
					setHiddenCols(prunedHidden);
				}
			}
			const widthKeys = Object.keys(curWidths);
			if (widthKeys.some((k) => Number(k) < 0 || Number(k) >= count)) {
				const nextWidths: Record<number, number> = {};
				for (const k of widthKeys) {
					const idx = Number(k);
					if (idx >= 0 && idx < count) nextWidths[idx] = curWidths[idx]!;
				}
				setColWidths(nextWidths);
			}
			let nextOrder = curOrder;
			if (curOrder.length) {
				const prunedOrder = pruneColumnOrder(curOrder, count);
				if (isNaturalOrder(prunedOrder)) {
					nextOrder = [];
					setColOrder([]);
				} else if (prunedOrder.length !== curOrder.length || prunedOrder.some((c, i) => c !== curOrder[i])) {
					nextOrder = prunedOrder;
					setColOrder(prunedOrder);
				}
			}
			if (ac && (ac.column < 0 || ac.column >= count)) {
				const fallbackCol = visualColumnOrder(count, prunedFrozen, nextOrder.length ? nextOrder : undefined, nextHidden)[0];
				if (fallbackCol === undefined) setActiveCell(null);
				else setActiveCell(ac.ghost ? { ghost: true, column: fallbackCol } : { ghost: false, row: ac.row, column: fallbackCol });
			}
			if (menu && menu.column >= count) setFilterMenu(null);
			if (curSort.length) {
				const prunedSort = pruneSortSpecs(curSort, count);
				if (prunedSort.length !== curSort.length) setOrder(prunedSort);
			}
			if (curGroup !== null && (curGroup < 0 || curGroup >= count)) setGroupByCol(null);
			if (chk && chk.column >= count) {
				clearCodeCheck();
			}
		},
	);

	/** The ticket the rows are narrowed to: those whose ticket column names it, and no row that merely holds the same letters. */
	const [onlyTicket, setOnlyTicket] = createSignal<string | null>(null);
	// Rows asked for from a ticket's page.
	createEffect(
		() => ({ asked: rowsAsked(), path: props.path }),
		({ asked, path }) => {
			if (!asked || canonical(asked.path) !== canonical(path)) return;
			setOnlyTicket(asked.ticket);
			setPinnedRow(null);
			rowsShown();
		},
	);
	const ticketAt = () => ticketColumn(table());
	const isTicketCol = (col: number) => col === ticketAt() || isDedicatedTicketColumn(headerName(col));
	const tickets = createMemo(() => new Map(docs().flatMap((d) => (d.group === "tickets" && d.exists && d.ticket ? [[d.ticket.toLowerCase(), d] as const] : []))));
	/** The project's own keys: a word that is one of them names a ticket, however it is written. */
	const known = createMemo(() => new Set(tickets().keys()));
	const namesTicket = (cells: Cell[], key: string) => keysIn(cells[ticketAt()]?.text ?? "", known()).some((named) => named.toLowerCase() === key.toLowerCase());
	// A ticket no row names any more (the last was changed), or a table with no such column, has nothing to narrow to.
	createEffect(
		() => {
			const wanted = onlyTicket();
			if (wanted === null) return false;
			return ticketAt() < 0 || !table().rows.some((cells) => namesTicket(cells, wanted));
		},
		(shouldClear) => {
			if (shouldClear) setOnlyTicket(null);
		},
	);

	/** Applies a picked dropdown option to the active input value (preserving prior comma-separated ticket keys in ticket columns). */
	const resolvePickerChoice = (pickedValue: string, currentDraft: string): string => {
		const ed = editing();
		if (ed && isTicketCol(ed.column)) {
			const { prefix } = parseTicketToken(currentDraft);
			return prefix ? `${prefix}${pickedValue}` : pickedValue;
		}
		return pickedValue;
	};

	/** Custom dropdown popover options for the currently edited cell (canonical badge pills, multi-ticket keys, or distinct values). */
	const pickerOptions = createMemo<CellPickerOption[]>(() => {
		const ed = editing();
		if (!ed || !pickerOpen()) return [];
		const draft = editDraft();
		const dirty = editDirty();
		const existingCellVal = ed.ghost ? "" : (table().rows[ed.row]?.[ed.column]?.text ?? "").trim().toLowerCase();
		const existing = table().rows.map((r) => r[ed.column]?.text ?? "");

		// 1. Ticket column: parse token after last comma/semicolon and suggest remaining workspace tickets + existing keys.
		if (isTicketCol(ed.column)) {
			const { prefix, token, existingKeys } = parseTicketToken(draft);
			const needle = (dirty || prefix ? token : "").toLowerCase();
			const seen = new Set<string>();
			const out: CellPickerOption[] = [];
			for (const d of docs()) {
				if (d.group !== "tickets" || !d.exists || !d.ticket) continue;
				const k = d.ticket.toLowerCase();
				if (seen.has(k) || existingKeys.has(k)) continue;
				seen.add(k);
				const meta = d.title?.trim() || d.status?.trim() || "";
				if (needle && !k.includes(needle) && !meta.toLowerCase().includes(needle)) continue;
				out.push({ value: d.ticket, meta: meta || undefined, isCurrent: !prefix && k === existingCellVal });
			}
			for (const rawCell of existing) {
				for (const part of rawCell.split(/[\s,;/]+/)) {
					const t = part.trim();
					const k = t.toLowerCase();
					if (!t || seen.has(k) || existingKeys.has(k) || TICKET_PLACEHOLDER_RE.test(t)) continue;
					seen.add(k);
					if (needle && !k.includes(needle)) continue;
					out.push({ value: t, isCurrent: !prefix && k === existingCellVal });
				}
			}
			return out.slice(0, 40);
		}

		// 2. Configured badge column: show ALL canonical badge options immediately on open; filter only once user starts typing.
		const rule = columnRule(ed.column);
		if (rule) {
			const needle = dirty ? draft.trim().toLowerCase() : "";
			const seen = new Set<string>();
			const out: CellPickerOption[] = [];
			for (const entry of knownBadgeValues(rule)) {
				const k = entry.value.toLowerCase();
				seen.add(k);
				if (needle && !k.includes(needle)) continue;
				out.push({ value: entry.value, tone: entry.tone, isCurrent: k === existingCellVal });
			}
			for (const val of existing) {
				const trimmed = val.trim();
				if (!trimmed) continue;
				const k = trimmed.toLowerCase();
				if (seen.has(k)) continue;
				seen.add(k);
				if (needle && !k.includes(needle)) continue;
				out.push({ value: trimmed, tone: badgeToneForValue(rule, trimmed), isCurrent: k === existingCellVal });
			}
			return out.slice(0, 50);
		}

		// 3. Other columns: offer distinct non-empty values from the column as quick-pick suggestions.
		const distinct: string[] = [];
		const seen = new Set<string>();
		for (const val of existing) {
			const t = val.trim();
			if (!t) continue;
			const k = t.toLowerCase();
			if (seen.has(k)) continue;
			seen.add(k);
			distinct.push(t);
		}
		if (!dirty && distinct.length > 40) return [];
		const needle = dirty ? draft.trim().toLowerCase() : "";
		const filtered = needle ? distinct.filter((v) => v.toLowerCase().includes(needle)) : distinct;
		return filtered.slice(0, 30).map((v) => ({ value: v, isCurrent: v.toLowerCase() === existingCellVal }));
	});

	/** Default exclude glob list built from the workspace's docs, plans, and IDE metadata folders. */
	const defaultExclude = createMemo(() =>
		defaultExcludePattern([state.project?.docs ?? "docs", state.project?.plans ?? "design", ".ssl-studio"]),
	);

	/** Looks up the targeted check result(s) for a specific cell when that column was checked. */
	const cellHasMissingCheck = (cells: Cell[], chk: CodeCheckResult): boolean => {
		const raw = cells[chk.column]?.text ?? "";
		const terms = extractCellTerms(raw, chk.splitLists);
		return terms.some((t) => chk.counts.get(termLookupKey(t, chk.caseSensitive)) === 0);
	};

	const missingCount = createMemo(() => {
		const chk = codeCheck();
		if (!chk) return 0;
		return [...chk.counts.values()].filter((n) => n === 0).length;
	});

	const runCodeCheck = async (spec: CodeCheckSpec, mergeExisting = false, targetRow?: number) => {
		if (!state.workspace?.root) {
			notify("Open a project folder to check values in code.", "error");
			return;
		}
		setLastCheckSpec({
			fileScope: spec.fileScope,
			include: spec.include,
			exclude: spec.exclude,
			wholeWord: spec.wholeWord,
			caseSensitive: spec.caseSensitive,
		});

		const curIdx = targetRow ?? current();
		const targetRows: readonly Cell[][] =
			spec.rowScope === "selected" && curIdx !== null && table().rows[curIdx]
				? [table().rows[curIdx]!]
				: spec.rowScope === "checked" && visibleSelectedRows().length > 0
					? visibleSelectedRows().map((i) => table().rows[i]!).filter(Boolean)
					: spec.rowScope === "filtered" && hasActiveFilters()
						? rows().map((r) => r.cells)
						: table().rows;

		const colName = headerName(spec.column) || `Column ${spec.column + 1}`;
		const { terms } = columnCheckTargets(targetRows, spec.column, {
			splitLists: spec.splitLists,
			caseSensitive: spec.caseSensitive,
			minLength: spec.rowScope === "selected" ? 1 : 2,
		});
		if (!terms.length) {
			notify(`No searchable values in “${colName}”.`);
			return;
		}

		const options = codeCheckSearchOptions(spec, defaultExclude());
		const runId = ++checkRunId;
		userCancelledRunId = 0;
		const existing = codeCheck();
		const canMerge =
			mergeExisting &&
			existing &&
			existing.column === spec.column &&
			existing.splitLists === spec.splitLists &&
			existing.caseSensitive === spec.caseSensitive &&
			existing.options.wholeWord === options.wholeWord &&
			(existing.options.include ?? "") === (options.include ?? "") &&
			(existing.options.exclude ?? "") === (options.exclude ?? "");
		const counts = canMerge ? new Map(existing.counts) : new Map<string, number>();

		setChecking({ done: 0, total: terms.length, columnName: colName });
		let cancelled = false;
		let completed = 0;
		const CONCURRENCY = 6;
		try {
			let nextIdx = 0;
			const worker = async () => {
				while (!cancelled) {
					const idx = nextIdx++;
					if (idx >= terms.length) return;
					if (disposed || runId !== checkRunId) {
						cancelled = true;
						return;
					}
					const term = terms[idx]!;
					const hits = await backend.search(term, options);
					if (disposed || runId !== checkRunId) {
						cancelled = true;
						return;
					}
					counts.set(termLookupKey(term, spec.caseSensitive), hits.length);
					completed++;
					setChecking({ done: completed, total: terms.length, columnName: colName });
				}
			};
			await Promise.all(Array.from({ length: Math.min(CONCURRENCY, terms.length) }, () => worker()));
			const isCurrentRun = !disposed && runId === checkRunId;
			const isUserCancelled = !disposed && userCancelledRunId === runId;
			if (isUserCancelled) userCancelledRunId = 0;
			if (isCurrentRun || (isUserCancelled && completed > 0)) {
				setCodeCheck({
					column: spec.column,
					columnName: colName,
					splitLists: spec.splitLists,
					caseSensitive: spec.caseSensitive,
					options,
					counts,
				});
				if (![...counts.values()].some((n) => n === 0)) setOnlyMissing(false);
				notify(codeCheckSummary(colName, counts, !isCurrentRun));
			}
		} catch (e: any) {
			cancelled = true;
			if (runId === checkRunId) {
				checkRunId++;
				if (!disposed) {
					setChecking(null);
					notify(`Code check failed: ${e?.message ?? e}`, "error");
				}
			}
		} finally {
			if (!disposed && runId === checkRunId) setChecking(null);
		}
	};

	const findValueInCode = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;
		const opts = codeCheckSearchOptions(
			{
				fileScope: lastCheckSpec().fileScope ?? "code",
				include: lastCheckSpec().include ?? "",
				exclude: lastCheckSpec().exclude ?? defaultExclude(),
				wholeWord: lastCheckSpec().wholeWord ?? true,
				caseSensitive: lastCheckSpec().caseSensitive ?? false,
			},
			defaultExclude(),
		);
		searchFor(trimmed, opts);
	};

	const isDatabaseRegistry = createMemo(() => /^database\.(csv|tsv)$/i.test(baseName(props.path)));
	const isFilesRegistry = createMemo(() => /^files\.(csv|tsv)$/i.test(baseName(props.path)));
	const isObjectColumn = (col: number) => isSchemaTableColumn(headerName(col), isDatabaseRegistry());
	const isPathColumn = (col: number) => {
		const h = headerName(col).toLowerCase();
		return h === "path" || h === "file" || h === "filepath" || h === "file path" || (isFilesRegistry() && col === 0);
	};
	const hasPathColumn = createMemo(() => table().header.some((_, idx) => isPathColumn(idx)));

	// Non-blocking workspace file index used to validate file links in `files.csv`/`files.tsv` and `path`/`file` columns.
	const [wsFileSet, setWsFileSet] = createSignal<Set<string> | null>(null);
	{
		let seq = 0;
		createEffect(
			() => [state.workspace?.root, state.treeVersion, hasPathColumn()] as const,
			([root, , needed]) => {
				const mySeq = ++seq;
				if (!root || !needed) {
					setWsFileSet(null);
					return;
				}
				void backend.files().then(
					(files) => {
						if (mySeq !== seq) return;
						// Cap at backend's 20,000 limit: if saturated, skip missing-file warnings rather than false-positiving.
						if (files.length >= 20_000) {
							setWsFileSet(null);
							return;
						}
						setWsFileSet(new Set(files.map(canonical)));
					},
					() => {
						if (mySeq === seq) setWsFileSet(null);
					},
				);
			},
		);
	}

	/** Matching workspace schema doc for a `database.csv`/`database.tsv` object cell, if any. */
	const schemaDocForCell = (col: number, rawVal: string) => {
		if (!isObjectColumn(col)) return null;
		const trimmed = rawVal.trim();
		if (!trimmed) return null;
		return findSchemaDocForIdentifier(trimmed, docs());
	};

	/** Resolves a workspace-relative file path in `files.csv`/`files.tsv` or a `path`/`file` column. */
	const fileLinkForCell = (col: number, rawVal: string): { path: string; missing: boolean } | null => {
		if (!isPathColumn(col)) return null;
		const root = state.workspace?.root;
		if (!root) return null;
		const resolved = resolveWorkspaceFileLink(root, rawVal);
		if (!resolved || canonical(resolved) === canonical(root)) return null;
		const knownFiles = wsFileSet();
		const missing = knownFiles !== null && knownFiles.size > 0 && !knownFiles.has(canonical(resolved));
		return { path: resolved, missing };
	};

	/** Flags malformed paths (e.g. traversal outside workspace or illegal characters) in `files.csv`/`files.tsv` `path` columns. */
	const isMalformedFilePath = (col: number, rawVal: string): boolean => {
		if (!isFilesRegistry() || !isPathColumn(col) || !state.workspace?.root) return false;
		const trimmed = rawVal.trim();
		if (!trimmed) return false;
		if (/^(?:https?:|mailto:|ftp:)/i.test(trimmed)) return false;
		return fileLinkForCell(col, trimmed) === null;
	};

	/** First known workspace ticket referenced inside a cell (works across any column). */
	const firstTicketForCell = (col: number, rawVal: string) => {
		if (!tickets().size || !rawVal.trim()) return undefined;
		if (isTicketCol(col)) {
			const firstKey = keysIn(rawVal, known())[0];
			return firstKey ? tickets().get(firstKey.toLowerCase()) : undefined;
		}
		for (const seg of tokenizeCellLinks(rawVal, known())) {
			if (seg.kind === "ticket") {
				const ticket = tickets().get(seg.key.toLowerCase());
				if (ticket) return ticket;
			}
		}
		return undefined;
	};

	/** Opens the primary link (schema doc, workspace file, external URL, or known ticket) for a cell, returning true if one existed. */
	const openCellLink = (col: number, rawVal: string): boolean => {
		const schemaDoc = schemaDocForCell(col, rawVal);
		if (schemaDoc) {
			void openFile(schemaDoc.path);
			return true;
		}
		const fileLink = fileLinkForCell(col, rawVal);
		if (fileLink) {
			void openFile(fileLink.path);
			return true;
		}
		const url = extractFirstHttpUrl(rawVal);
		if (url) {
			openExternalUrl(url);
			return true;
		}
		const ticket = firstTicketForCell(col, rawVal);
		if (ticket) {
			void openFile(ticket.path);
			return true;
		}
		return false;
	};

	/** A cell of a dedicated ticket column: known tickets open their doc, URLs open externally, unknown non-placeholders warn. */
	const ticketCell = (value: string, cellTabIndex: () => number) => {
		const hasTickets = () => tickets().size > 0;
		return (
			<For each={splitCellUrls(value)}>
				{(seg) =>
					seg.kind === "url" ? (
						<button
							type="button"
							tabindex={cellTabIndex()}
							class="link table-cell-link table-url-link"
							title={`Open ${seg.url} in browser (Click or Ctrl+Click)`}
							onClick={(e) => (e.stopPropagation(), openExternalUrl(seg.url))}
							onDblClick={(e) => e.stopPropagation()}
						>
							{seg.text}
						</button>
					) : (
						<For each={seg.text.split(/([\s,;]+)/)}>
							{(chunk) => {
								if (!chunk || isTicketSeparatorChunk(chunk)) return chunk;
								const trimmedChunk = chunk.trim();
								if (!trimmedChunk || TICKET_PLACEHOLDER_RE.test(trimmedChunk)) return chunk;
								return (
									<For each={chunk.split(/(\/)/)}>
										{(part) => {
											const trimmed = part.trim();
											if (!trimmed || trimmed === "/") return part;
											return (
												<>
													{() => {
														const matchedKey = keyOf(part, known());
														const ticket = matchedKey ? tickets().get(matchedKey.toLowerCase()) : undefined;
														if (ticket) {
															return (
																<button
																	type="button"
																	tabindex={cellTabIndex()}
																	class="link table-ticket"
																	title={`${ticket.ticket}: ${ticket.title ?? ""}${ticket.status ? ` (${ticket.status})` : ""}. Open the ticket.`}
																	onClick={(e) => (e.stopPropagation(), void openFile(ticket.path))}
																	onDblClick={(e) => e.stopPropagation()}
																>
																	{part}
																</button>
															);
														}
														if (hasTickets() && !TICKET_PLACEHOLDER_RE.test(trimmed)) {
															return (
																<span class="table-val-warn" title={`Ticket “${trimmed}” not found in workspace docs`}>
																	{part}
																</span>
															);
														}
														return part;
													}}
												</>
											);
										}}
									</For>
								);
							}}
						</For>
					)
				}
			</For>
		);
	};

	/** Renders inline external URLs and known workspace ticket chips inside any general text cell. */
	const richTextCell = (value: string, cellTabIndex: () => number) => {
		if (!value) return value;
		const segments = tokenizeCellLinks(value, known());
		if (!segments.some((s) => s.kind !== "text")) return value;
		return (
			<For each={segments}>
				{(seg) => {
					if (seg.kind === "url") {
						return (
							<button
								type="button"
								tabindex={cellTabIndex()}
								class="link table-cell-link table-url-link"
								title={`Open ${seg.url} in browser (Click or Ctrl+Click)`}
								onClick={(e) => (e.stopPropagation(), openExternalUrl(seg.url))}
								onDblClick={(e) => e.stopPropagation()}
							>
								{seg.text}
							</button>
						);
					}
					if (seg.kind === "ticket") {
						return (
							<>
								{() => {
									const ticket = tickets().get(seg.key.toLowerCase());
									if (ticket) {
										return (
											<button
												type="button"
												tabindex={cellTabIndex()}
												class="link table-ticket"
												title={`${ticket.ticket}: ${ticket.title ?? ""}${ticket.status ? ` (${ticket.status})` : ""}. Open the ticket.`}
												onClick={(e) => (e.stopPropagation(), void openFile(ticket.path))}
												onDblClick={(e) => e.stopPropagation()}
											>
												{seg.text}
											</button>
										);
									}
									return seg.text;
								}}
							</>
						);
					}
					return seg.text;
				}}
			</For>
		);
	};

	/** Renders a checked cell's value alongside its targeted code-hit badge(s). */
	const renderCheckBadge = (term: string, count: number | undefined, opts: SearchOptions, tabIndex = -1) => {
		if (count === undefined) return null;
		if (count === 0) {
			return (
				<span class="doc-status tone-off table-use" title="Not found in the searched code files">
					not in code
				</span>
			);
		}
		const countText = count >= SEARCH_LIMIT ? `${SEARCH_LIMIT}+` : String(count);
		return (
			<button
				type="button"
				tabindex={tabIndex}
				class="link table-use"
				title={`Found ${countText} ${count === 1 ? "time" : "times"} in the searched code files. Click to view in Search.`}
				onClick={(e) => (e.stopPropagation(), searchFor(term, opts))}
				onDblClick={(e) => e.stopPropagation()}
			>
				{countText}×
			</button>
		);
	};

	/** True when column 0 appears to hold unique identifiers (not status/notes/categorical badges). */
	const isCol0KeyLike = createMemo(() => {
		const h0 = headerName(0);
		if (!h0) return false;
		if (NON_KEY_COL0_RE.test(h0)) return false;
		if (columnRule(0)) return false;
		return true;
	});
	const duplicateEntries = createMemo(() => (isCol0KeyLike() ? csvDuplicateKeys(table(), 0) : []));
	const duplicateRowSet = createMemo(() => {
		const set = new Set<number>();
		for (const d of duplicateEntries()) {
			for (const r of d.rows) set.add(r);
		}
		return set;
	});
	createEffect(
		() => onlyDupes() && duplicateRowSet().size === 0,
		(shouldClear) => {
			if (shouldClear) setOnlyDupes(false);
		},
	);

	/**
	 * Aggregates all 5 inline cell validation checks into a unified issue navigator (`F8`):
	 * 1) missing/malformed file paths, 2) unknown ticket keys, 3) unrecognized badge values,
	 * 4) empty primary keys, 5) duplicate col-0 keys.
	 */
	const tableIssues = createMemo<TableIssue[]>(() => {
		const t = table();
		const colCount = t.header.length;
		if (!colCount || !t.rows.length) return [];
		const keyLike = isCol0KeyLike();
		const dupRows = duplicateRowSet();
		const knownTickets = known();
		const hasTickets = tickets().size > 0;
		const pathCols = new Set<number>();
		const ticketCols = new Set<number>();
		const badgeRules = new Map<number, ReturnType<typeof columnRule>>();
		for (let c = 0; c < colCount; c++) {
			if (isPathColumn(c)) pathCols.add(c);
			if (isTicketCol(c)) ticketCols.add(c);
			const r = columnRule(c);
			if (r) badgeRules.set(c, r);
		}
		const issues: TableIssue[] = [];
		for (let r = 0; r < t.rows.length; r++) {
			const cells = t.rows[r]!;
			for (let c = 0; c < colCount; c++) {
				const raw = cells[c]?.text ?? "";
				const trimmed = raw.trim();
				if (c === 0 && keyLike) {
					if (!trimmed && cells.some((cell, ci) => ci !== 0 && Boolean(cell.text.trim()))) {
						issues.push({
							row: r,
							column: 0,
							kind: "empty-key",
							message: `Missing primary key in “${headerName(0) || "Column 1"}”`,
						});
					} else if (dupRows.has(r)) {
						issues.push({
							row: r,
							column: 0,
							kind: "duplicate-key",
							message: `Duplicate key “${trimmed}” in “${headerName(0) || "Column 1"}”`,
						});
					}
				}
				if (pathCols.has(c) && trimmed) {
					const fl = fileLinkForCell(c, raw);
					if (fl?.missing) {
						issues.push({
							row: r,
							column: c,
							kind: "missing-path",
							message: `File not found: ${trimmed}`,
						});
					} else if (!fl && isMalformedFilePath(c, raw)) {
						issues.push({
							row: r,
							column: c,
							kind: "malformed-path",
							message: `Malformed path: ${trimmed}`,
						});
					}
				}
				if (ticketCols.has(c) && hasTickets && trimmed) {
					const unknown = findUnknownTicketTokens(raw, knownTickets);
					if (unknown.length > 0) {
						issues.push({
							row: r,
							column: c,
							kind: "unknown-ticket",
							message: `Unknown ticket${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
						});
					}
				}
				const rule = badgeRules.get(c);
				if (rule && isUnrecognizedBadgeValue(rule, raw)) {
					issues.push({
						row: r,
						column: c,
						kind: "unrecognized-badge",
						message: `Unrecognized value “${trimmed}” in “${headerName(c) || `Column ${c + 1}`}”`,
					});
				}
			}
		}
		return issues;
	});

	const issueRowSet = createMemo(() => {
		const set = new Set<number>();
		for (const issue of tableIssues()) set.add(issue.row);
		return set;
	});

	createEffect(
		() => onlyIssues() && tableIssues().length === 0,
		(shouldClear) => {
			if (shouldClear) setOnlyIssues(false);
		},
	);

	/** Rows after global/ticket/missing/dupes/issues filters, before per-column filters (used for faceted header counts). */
	const baseRows = createMemo(() => {
		const words = filter().trim().toLowerCase().split(/\s+/).filter(Boolean);
		const pinned = pinnedRow();
		const chk = codeCheck();
		let list = table().rows.map((cells, index) => ({ cells, index }));
		if (onlyIssues()) {
			const badRows = issueRowSet();
			list = list.filter(({ index }) => index === pinned || badRows.has(index));
		}
		if (onlyDupes()) {
			const dupRows = duplicateRowSet();
			list = list.filter(({ index }) => index === pinned || dupRows.has(index));
		}
		if (onlyMissing() && chk) {
			list = list.filter(({ cells, index }) => index === pinned || cellHasMissingCheck(cells, chk));
		}
		const forTicket = onlyTicket();
		if (forTicket !== null && ticketAt() >= 0) {
			list = list.filter(({ cells, index }) => index === pinned || namesTicket(cells, forTicket));
		}
		if (words.length) {
			list = list.filter(({ cells, index }) => index === pinned || words.every((word) => cells.some((cell) => cell.text.toLowerCase().includes(word))));
		}
		return list;
	});

	const rows = createMemo(() => {
		const filters = colFilters();
		const pinned = pinnedRow();
		let list = filters.size
			? baseRows().filter(({ cells, index }) => index === pinned || rowMatchesColumnFilters(cells, filters))
			: baseRows();
		const sorts = order();
		if (sorts.length) {
			list = [...list].sort((a, b) => compareRowsBySorts(a.cells, b.cells, sorts, (cells, col) => cells[col]?.text ?? ""));
		}
		return list;
	});

	const optionsForColumn = (column: number) =>
		columnValueOptions(
			table().rows,
			baseRows().map((r) => r.cells),
			column,
			colFilters(),
		);

	const activeFilterCols = createMemo(() =>
		[...colFilters().entries()]
			.filter(([, f]) => isColumnFilterActive(f))
			.sort(([a], [b]) => a - b),
	);

	const hasActiveFilters = createMemo(
		() =>
			Boolean(filter().trim()) ||
			activeFilterCols().length > 0 ||
			onlyTicket() !== null ||
			onlyMissing() ||
			onlyDupes() ||
			onlyIssues(),
	);

	const pinRowIfFiltered = (row: number) => {
		if (hasActiveFilters()) setPinnedRow(row);
	};

	createEffect(
		() => !hasActiveFilters() && pinnedRow() !== null,
		(shouldClear) => {
			if (shouldClear) setPinnedRow(null);
		},
	);

	const isColFiltered = (col: number) => isColumnFilterActive(colFilters().get(col));

	const setColumnFilter = (col: number, next: ColumnFilter | undefined) => {
		setPinnedRow(null);
		setColFilters((prev) => {
			const copy = new Map(prev);
			if (!next || !isColumnFilterActive(next)) copy.delete(col);
			else copy.set(col, next);
			return copy;
		});
	};

	const clearAllFilters = () => {
		setPinnedRow(null);
		setFilter("");
		setColFilters(new Map());
		setOnlyTicket(null);
		setOnlyMissing(false);
		setOnlyDupes(false);
		setOnlyIssues(false);
	};

	const closeFilterMenu = (restoreFocus = false) => {
		const menu = filterMenu();
		setFilterMenu(null);
		if (restoreFocus && menu?.anchor.isConnected) menu.anchor.focus();
	};

	const openFilterMenu = (col: number, anchor: HTMLElement) => {
		const cur = filterMenu();
		if (cur?.column === col) {
			closeFilterMenu(false);
			return;
		}
		const rect = anchor.getBoundingClientRect();
		const placed = placeAnchoredMenu(
			rect,
			{ width: Math.min(280, window.innerWidth - 16), height: 320 },
			{ width: window.innerWidth, height: window.innerHeight },
			8,
			4,
		);
		setFilterMenu({ column: col, x: placed.left, y: placed.top, maxHeight: placed.maxHeight, anchor });
	};

	// Dismiss open filter popover on outside click or Escape.
	const hasFilterMenu = createMemo(() => Boolean(filterMenu()));
	createEffect(
		() => hasFilterMenu(),
		(open) => {
			if (!open) return;
			const onMouseDown = (e: MouseEvent) => {
				const target = e.target as HTMLElement | null;
				if (!target) return;
				if (target.closest(".table-filter-pop")) return;
				if (target.closest(".table-th-filter")) return;
				closeFilterMenu(false);
			};
			const onKeyDown = (e: KeyboardEvent) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					closeFilterMenu(true);
				}
			};
			window.addEventListener("mousedown", onMouseDown, true);
			window.addEventListener("keydown", onKeyDown, true);
			return () => {
				window.removeEventListener("mousedown", onMouseDown, true);
				window.removeEventListener("keydown", onKeyDown, true);
			};
		},
	);

	const disableBadgeForColumn = async (colName: string) => {
		const next = removeColumnFromRules(csvConfig(), colName);
		try {
			const layers = state.workspace ? await backend.settings() : null;
			const scope = layers && "csvTable" in layers.workspace ? "workspace" : "user";
			await saveSetting({ csvTable: next }, scope);
			notify(`Turned off badge formatting for “${colName}”.`);
		} catch (e: any) {
			notify(`Could not update column formatting: ${e?.message ?? e}`, "error");
		}
	};

	const matchedBadgeCols = createMemo(() =>
		table().header
			.map((h) => h.text.trim())
			.filter((name) => Boolean(ruleForColumn(csvConfig(), name))),
	);

	const canReorderRows = createMemo(() => order().length === 0 && !hasActiveFilters() && groupByCol() === null);

	/** Grouped row buckets in exact visual display order (including collapsed groups). */
	const orderedGroups = createMemo<{ key: string; label: string; items: { index: number; cells: Cell[] }[] }[] | null>(() => {
		const gCol = groupByCol();
		if (gCol === null || gCol < 0 || gCol >= table().header.length) return null;
		const list = rows();
		const buckets = new Map<string, { label: string; items: { index: number; cells: Cell[] }[] }>();
		for (const item of list) {
			const raw = (item.cells[gCol]?.text ?? "").trim();
			const key = raw.toLowerCase();
			const bucket = buckets.get(key);
			if (bucket) bucket.items.push(item);
			else buckets.set(key, { label: raw, items: [item] });
		}
		const groups = [...buckets.entries()].map(([key, info]) => ({ key, label: info.label, items: info.items }));
		if (order()[0]?.column !== gCol) {
			groups.sort((a, b) => {
				if ((a.key === "") !== (b.key === "")) return a.key === "" ? 1 : -1;
				return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
			});
		}
		return groups;
	});

	/** Flat list of rendered tbody entries: either plain filtered/sorted rows or collapsible group header + member rows. */
	const displayEntries = createMemo<DisplayEntry[]>(() => {
		const groups = orderedGroups();
		if (!groups) {
			return rows().map((r) => ({ kind: "row" as const, entryId: `r:${r.index}`, index: r.index, cells: r.cells }));
		}
		const collapsed = collapsedGroups();
		const out: DisplayEntry[] = [];
		for (const grp of groups) {
			const isCollapsed = collapsed.has(grp.key);
			out.push({
				kind: "group",
				entryId: `g:${grp.key}`,
				entryKey: -(out.length + 1),
				key: grp.key,
				label: grp.label,
				count: grp.items.length,
				rowIndices: grp.items.map((x) => x.index),
				collapsed: isCollapsed,
			});
			if (!isCollapsed) {
				for (const item of grp.items) {
					out.push({ kind: "row", entryId: `r:${item.index}`, index: item.index, cells: item.cells });
				}
			}
		}
		return out;
	});

	const displayEntryMap = createMemo(() => {
		const map = new Map<string, DisplayEntry>();
		for (const e of displayEntries()) map.set(e.entryId, e);
		return map;
	});

	/** All filtered/sorted rows in exact visual group order INCLUDING collapsed groups (used by Find & Replace and F8 navigation). */
	const visualAllRows = createMemo<{ index: number; cells: Cell[] }[]>(() => {
		const groups = orderedGroups();
		if (!groups) return rows();
		const out: { index: number; cells: Cell[] }[] = [];
		for (const grp of groups) {
			for (const item of grp.items) out.push(item);
		}
		return out;
	});

	/** All non-collapsed data rows in exact visual display order (used for keyboard nav, rectangular range, paste, and fill-down/right). */
	const displayRows = createMemo<{ index: number; cells: Cell[] }[]>(() => {
		if (groupByCol() === null) return rows();
		const out: { index: number; cells: Cell[] }[] = [];
		for (const e of displayEntries()) {
			if (e.kind === "row") out.push({ index: e.index, cells: e.cells });
		}
		return out;
	});

	const rowVisIndexMap = createMemo(() => {
		const map = new Map<number, number>();
		const list = displayRows();
		for (let i = 0; i < list.length; i++) map.set(list[i]!.index, i);
		return map;
	});

	const colVisIndexMap = createMemo(() => {
		const map = new Map<number, number>();
		const cols = visibleColumns();
		for (let i = 0; i < cols.length; i++) map.set(cols[i]!, i);
		return map;
	});

	/** Rectangular multi-cell selection bounds in visual row/column coordinates, or null when no range is anchored. */
	const cellRange = createMemo<CellRangeRect | null>(() => {
		const anchor = cellAnchor();
		const ac = activeCell();
		if (!anchor || !ac || ac.ghost) return null;
		const rMap = rowVisIndexMap();
		const cMap = colVisIndexMap();
		const ar = rMap.get(anchor.row);
		const fr = rMap.get(ac.row);
		const acol = cMap.get(anchor.column);
		const fcol = cMap.get(ac.column);
		if (ar === undefined || fr === undefined || acol === undefined || fcol === undefined) return null;
		const r1 = Math.min(ar, fr);
		const r2 = Math.max(ar, fr);
		const c1 = Math.min(acol, fcol);
		const c2 = Math.max(acol, fcol);
		return {
			r1,
			r2,
			c1,
			c2,
			rowCount: r2 - r1 + 1,
			colCount: c2 - c1 + 1,
			isMulti: r1 !== r2 || c1 !== c2,
		};
	});

	const isCellInRange = (row: number, col: number): boolean => {
		const range = cellRange();
		if (!range || !range.isMulti) return false;
		const vr = rowVisIndexMap().get(row);
		const vc = colVisIndexMap().get(col);
		return vr !== undefined && vc !== undefined && vr >= range.r1 && vr <= range.r2 && vc >= range.c1 && vc <= range.c2;
	};

	const isCellFillTarget = (row: number, col: number): boolean => {
		const target = fillDrag()?.target;
		if (!target) return false;
		const vr = rowVisIndexMap().get(row);
		const vc = colVisIndexMap().get(col);
		return vr !== undefined && vc !== undefined && vr >= target.r1 && vr <= target.r2 && vc >= target.c1 && vc <= target.c2;
	};

	/** Cell coordinates where the Excel bottom-right drag-fill handle sits (bottom-right of range or single active cell). */
	const fillHandleCell = createMemo<{ row: number; col: number } | null>(() => {
		if (editing()) return null;
		const range = cellRange();
		if (range && range.isMulti) {
			const rItem = displayRows()[range.r2];
			const col = visibleColumns()[range.c2];
			if (rItem && col !== undefined) return { row: rItem.index, col };
		}
		const ac = activeCell();
		if (ac && !ac.ghost && rowVisIndexMap().has(ac.row) && colVisIndexMap().has(ac.column)) {
			return { row: ac.row, col: ac.column };
		}
		return null;
	});

	const toggleGroupCollapsed = (key: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const toggleGroupSelect = (rowIndices: readonly number[]) => {
		setSelectedRows((prev) => {
			const next = new Set(prev);
			const allSelected = rowIndices.length > 0 && rowIndices.every((r) => prev.has(r));
			for (const r of rowIndices) {
				if (allSelected) next.delete(r);
				else next.add(r);
			}
			return next;
		});
	};

	const toggleGroupByColumn = (col: number) => {
		if (groupByCol() === col) {
			setGroupByCol(null);
			setCollapsedGroups(new Set<string>());
		} else {
			setGroupByCol(col);
			setCollapsedGroups(new Set<string>());
		}
	};

	// Scroll-windowed virtualization when tables exceed 200 rows using measured per-row heights (`Map<number, number>`).
	const VIRTUAL_THRESHOLD = 200;
	const VIRT_OVERSCAN = 20;
	const [scrollTop, setScrollTop] = createSignal(0);
	const [viewportH, setViewportH] = createSignal(640);

	const virtualWindow = createMemo(() => {
		rowHeightVer();
		const all = displayEntries();
		const keys = all.map((e) => (e.kind === "row" ? e.index : e.entryKey));
		return computeVirtualWindow(
			keys,
			rowHeights,
			scrollTop(),
			viewportH() || 640,
			VIRTUAL_THRESHOLD,
			VIRT_OVERSCAN,
			DEFAULT_ROW_HEIGHT,
		);
	});

	/** The tbody entries drawn: virtualized viewport slice for large tables (>200 entries), or all entries for small tables. */
	const drawnEntries = createMemo<DisplayEntry[]>(() => {
		const win = virtualWindow();
		const all = displayEntries();
		const slice = win.virtual ? all.slice(win.start, win.end) : all;
		const ed = editing();
		const focusRow = ed && !ed.ghost ? ed.row : null;
		if (focusRow === null || slice.some((e) => e.kind === "row" && e.index === focusRow)) return slice;
		const beyondIdx = all.findIndex((e) => e.kind === "row" && e.index === focusRow);
		if (beyondIdx < 0) return slice;
		const beyond = all[beyondIdx]!;
		return beyondIdx < win.start ? [beyond, ...slice] : [...slice, beyond];
	});

	/** Stable primitive entry keys for `<For>` rendering so virtual scrolling never shifts slots or unmounts active inline editors. */
	const drawnEntryIds = createMemo(() => drawnEntries().map((e) => e.entryId));

	/** Roving tabindex target (ADR 0010): exactly one cell in tbody/tfoot gets tabindex=0 so Tab never traps users. */
	const rovingCell = createMemo<ActiveCell | null>(() => {
		const cols = visibleColumns();
		if (!cols.length) return null;
		const ac = activeCell();
		const list = drawnEntries();
		if (ac && cols.includes(ac.column)) {
			if (ac.ghost) return ac;
			if (list.some((e) => e.kind === "row" && e.index === ac.row)) return ac;
		}
		const firstRow = list.find((e) => e.kind === "row");
		if (firstRow && firstRow.kind === "row") return { ghost: false, row: firstRow.index, column: cols[0]! };
		return { ghost: true, column: cols[0]! };
	});
	const isRovingBodyCell = (row: number, col: number) => {
		const rc = rovingCell();
		return Boolean(rc && !rc.ghost && rc.row === row && rc.column === col);
	};
	const isRovingGhostCell = (col: number) => {
		const rc = rovingCell();
		return Boolean(rc && rc.ghost && rc.column === col);
	};
	const isRovingRow = (row: number) => {
		const rc = rovingCell();
		return Boolean(rc && !rc.ghost && rc.row === row);
	};

	const allDrawnSelected = createMemo(() => {
		const list = rows();
		const sel = selectedRows();
		return list.length > 0 && list.every((r) => sel.has(r.index));
	});

	const toggleRowSelect = (rowIdx: number, shiftKey: boolean) => {
		const list = displayRows();
		setSelectedRows((prev) => {
			const next = new Set(prev);
			if (shiftKey && lastClickedRow() !== null) {
				const a = list.findIndex((r) => r.index === lastClickedRow());
				const b = list.findIndex((r) => r.index === rowIdx);
				if (a >= 0 && b >= 0) {
					const [lo, hi] = a < b ? [a, b] : [b, a];
					const adding = !prev.has(rowIdx);
					for (let i = lo; i <= hi; i++) {
						const idx = list[i]!.index;
						if (adding) next.add(idx);
						else next.delete(idx);
					}
					return next;
				}
			}
			if (next.has(rowIdx)) next.delete(rowIdx);
			else next.add(rowIdx);
			return next;
		});
		setLastClickedRow(rowIdx);
	};

	const toggleSelectAllDrawn = () => {
		const list = rows();
		if (allDrawnSelected()) {
			setSelectedRows((prev) => {
				const next = new Set(prev);
				for (const r of list) next.delete(r.index);
				return next;
			});
		} else {
			setSelectedRows((prev) => {
				const next = new Set(prev);
				for (const r of list) next.add(r.index);
				return next;
			});
		}
	};

	let scrollEl: HTMLDivElement | undefined;
	let tableEl: HTMLTableElement | undefined;
	let headRow: HTMLTableRowElement | undefined;
	let body: HTMLTableSectionElement | undefined;
	let foot: HTMLTableSectionElement | undefined;
	let suppressSortClick = false;
	let lastKeyMenuAt = 0;
	let cancelActiveDrag: (() => void) | null = null;
	let cancelActiveResize: (() => void) | null = null;
	let cancelActiveRowDrag: (() => void) | null = null;
	let cancelActiveCellDrag: (() => void) | null = null;
	let cancelActiveFillDrag: (() => void) | null = null;
	onCleanup(() => {
		cancelActiveDrag?.();
		cancelActiveResize?.();
		cancelActiveRowDrag?.();
		cancelActiveCellDrag?.();
		cancelActiveFillDrag?.();
	});

	// Measure mounted `tr` elements via `offsetHeight` so multiline/wrapped rows never drift during virtual scroll/jump.
	createEffect(
		() => [drawnEntries(), colWidths(), hiddenCols(), editing(), text()] as const,
		() => {
			const raf = requestAnimationFrame(() => {
				if (!body) return;
				let changed = false;
				const trs = body.querySelectorAll<HTMLTableRowElement>("tr[data-row], tr[data-entry-key]");
				for (const tr of trs) {
					const rawKey = tr.getAttribute("data-row") ?? tr.getAttribute("data-entry-key");
					if (rawKey === null) continue;
					const key = Number(rawKey);
					if (!Number.isInteger(key)) continue;
					const h = tr.offsetHeight;
					if (h > 0 && rowHeights.get(key) !== h) {
						rowHeights.set(key, h);
						changed = true;
					}
				}
				if (changed) setRowHeightVer((v) => v + 1);
			});
			return () => cancelAnimationFrame(raf);
		},
	);

	// Measure cumulative widths of frozen columns so multi-column freezing locks seamlessly with zero overlap/gap.
	createEffect(
		() => ({
			count: visibleFrozenCount(),
			// Track visual layout dependencies so resizing/reordering/hiding/checking recalculates sticky offsets.
			cols: visibleColumns(),
			widths: colWidths(),
			hidden: hiddenCols(),
			t: table(),
			r: rows(),
			chk: codeCheck(),
			ord: order(),
			grp: groupByCol(),
		}),
		({ count }) => {
			if (!count) {
				setFrozenLefts([]);
				return;
			}
			const measure = () => {
				if (!headRow) return;
				const selTh = headRow.querySelector<HTMLElement>("th.table-sel-col");
				const dataThs = headRow.querySelectorAll<HTMLElement>("th[data-col]");
				const next: number[] = [];
				let x = selTh ? selTh.getBoundingClientRect().width : 0;
				for (let i = 0; i < count; i++) {
					next.push(x);
					const th = dataThs[i];
					x += th ? th.getBoundingClientRect().width : 0;
				}
				setFrozenLefts((prev) =>
					prev.length === next.length && prev.every((v, idx) => Math.abs(v - next[idx]!) < 0.25) ? prev : next,
				);
			};
			const raf = requestAnimationFrame(measure);
			let ro: ResizeObserver | undefined;
			if (typeof ResizeObserver !== "undefined" && headRow) {
				ro = new ResizeObserver(measure);
				const selTh = headRow.querySelector<HTMLElement>("th.table-sel-col");
				if (selTh) ro.observe(selTh);
				const dataThs = headRow.querySelectorAll<HTMLElement>("th[data-col]");
				for (let i = 0; i < count; i++) {
					const th = dataThs[i];
					if (th) ro.observe(th);
				}
			}
			return () => {
				cancelAnimationFrame(raf);
				ro?.disconnect();
			};
		},
	);

	const visEntryIdxForRow = (rowIdx: number) => displayEntries().findIndex((e) => e.kind === "row" && e.index === rowIdx);

	/** Adjusts `scrollEl.scrollTop` synchronously so entry `visIdx` in `displayEntries()` renders inside the virtual window. */
	const ensureVisRowInWindow = (visIdx: number, align: "nearest" | "center" = "nearest") => {
		if (!scrollEl || visIdx < 0) return;
		const win = virtualWindow();
		if (!win.virtual) return;
		const vh = scrollEl.clientHeight || viewportH() || 640;
		const headerH = headRow?.getBoundingClientRect().height ?? 32;
		const usableH = Math.max(DEFAULT_ROW_HEIGHT * 2, vh - headerH);
		const estTop = win.offsets[visIdx] ?? visIdx * DEFAULT_ROW_HEIGHT;
		const estH =
			win.offsets[visIdx + 1] !== undefined && win.offsets[visIdx] !== undefined
				? win.offsets[visIdx + 1]! - win.offsets[visIdx]!
				: DEFAULT_ROW_HEIGHT;
		const estBottom = estTop + estH;
		const curTop = scrollEl.scrollTop;
		let nextTop = curTop;
		if (align === "center") {
			nextTop = Math.max(0, estTop - Math.floor(usableH / 2));
		} else if (estTop < curTop || visIdx < win.start + 2) {
			nextTop = Math.max(0, estTop - estH);
		} else if (estBottom > curTop + usableH || visIdx >= win.end - 2) {
			nextTop = Math.max(0, estBottom - usableH + estH);
		}
		if (nextTop !== curTop) {
			scrollEl.scrollTop = nextTop;
			setScrollTop(nextTop);
		}
	};

	const nudgeCellOutFromHeader = (td: HTMLElement) => {
		if (!scrollEl) return;
		const sRect = scrollEl.getBoundingClientRect();
		const headH = headRow?.getBoundingClientRect().height ?? 0;
		const tdRect = td.getBoundingClientRect();
		if (tdRect.top < sRect.top + headH) {
			scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop - (sRect.top + headH - tdRect.top) - 2);
			setScrollTop(scrollEl.scrollTop);
		} else if (tdRect.bottom > sRect.bottom) {
			scrollEl.scrollTop += tdRect.bottom - sRect.bottom + 2;
			setScrollTop(scrollEl.scrollTop);
		}
	};

	const focusCell = (row: number, column: number, opts?: { keepAnchor?: boolean; align?: "nearest" | "center" }) => {
		if (!opts?.keepAnchor) setCellAnchor(null);
		const visIdx = visEntryIdxForRow(row);
		if (visIdx >= 0) {
			pinRowIfFiltered(row);
			ensureVisRowInWindow(visIdx, opts?.align ?? "nearest");
		}
		setActiveCell({ ghost: false, row, column });
		queueMicrotask(() => {
			const td = body?.querySelector<HTMLElement>(`tr[data-row="${row}"] > td[data-col="${column}"]`);
			if (td) {
				td.focus();
				nudgeCellOutFromHeader(td);
				return;
			}
			const latestVisIdx = visEntryIdxForRow(row);
			const win = virtualWindow();
			if (win.virtual && scrollEl && latestVisIdx >= 0) {
				const estTop = win.offsets[latestVisIdx] ?? latestVisIdx * DEFAULT_ROW_HEIGHT;
				const targetTop = Math.max(0, estTop - Math.floor((viewportH() || 600) / 3));
				scrollEl.scrollTop = targetTop;
				setScrollTop(targetTop);
				requestAnimationFrame(() => {
					const retry = body?.querySelector<HTMLElement>(`tr[data-row="${row}"] > td[data-col="${column}"]`);
					if (retry) {
						retry.focus();
						nudgeCellOutFromHeader(retry);
					}
				});
			}
		});
	};

	const focusGhostCell = (column: number) => {
		setCellAnchor(null);
		setActiveCell({ ghost: true, column });
		queueMicrotask(() => {
			const td = foot?.querySelector<HTMLElement>(`tr.table-ghost-row > td[data-col="${column}"]`);
			if (td) {
				td.focus();
				td.scrollIntoView({ block: "nearest", inline: "nearest" });
			}
		});
	};

	/** Moves selection/focus (or editing) to visual row `targetVis` in `displayRows()` cleanly across virtualized windows. */
	const navigateToVisRow = (
		targetVis: number,
		column: number,
		opts?: { edit?: boolean; align?: "nearest" | "center"; keepAnchor?: boolean },
	) => {
		const list = displayRows();
		const target = list[targetVis];
		if (!target) return;
		const nextRow = target.index;
		if (!opts?.keepAnchor) setCellAnchor(null);
		pinRowIfFiltered(nextRow);
		const entryIdx = visEntryIdxForRow(nextRow);
		ensureVisRowInWindow(entryIdx >= 0 ? entryIdx : targetVis, opts?.align ?? "nearest");
		setActiveCell({ ghost: false, row: nextRow, column });
		if (opts?.edit) {
			setEditing({ ghost: false, row: nextRow, column });
		} else {
			focusCell(nextRow, column, { keepAnchor: opts?.keepAnchor, align: opts?.align });
		}
	};

	/** Applies multiple `(row, col, value)` updates in a SINGLE Monaco undo step, preserving untouched quoting and padding short rows (ADR 0002). */
	const applyCellUpdates = (updates: readonly { row: number; col: number; value: string }[]): number => {
		if (!model || !updates.length) return 0;
		const raw = model.getValue();
		const t = parseCurrentCsv(raw);
		const byRow = new Map<number, Map<number, string>>();
		for (const u of updates) {
			if (u.row < 0 || u.row >= t.rows.length || u.col < 0 || u.col >= t.header.length) continue;
			let colsMap = byRow.get(u.row);
			if (!colsMap) {
				colsMap = new Map<number, string>();
				byRow.set(u.row, colsMap);
			}
			colsMap.set(u.col, u.value);
		}
		const cellEdits: OffsetTextEdit[] = [];
		let changedCells = 0;
		for (const [rowIdx, colsMap] of byRow) {
			const cells = t.rows[rowIdx];
			if (!cells?.length) continue;
			let maxColNeeded = -1;
			const tailVals = new Map<number, string>();
			for (const [colIdx, val] of colsMap) {
				if (!cells[colIdx] && val !== "") {
					tailVals.set(colIdx, val);
					if (colIdx > maxColNeeded) maxColNeeded = colIdx;
				}
			}
			const finalCellCount = tailVals.size && maxColNeeded >= cells.length ? maxColNeeded + 1 : cells.length;
			for (const [colIdx, val] of colsMap) {
				const existing = cells[colIdx];
				if (existing && existing.text !== val) {
					cellEdits.push({
						start: existing.start,
						end: existing.end,
						text: serializeCellInRow(val, finalCellCount, t.delimiter),
					});
					changedCells++;
				}
			}
			if (tailVals.size && maxColNeeded >= cells.length) {
				const last = cells[cells.length - 1]!;
				let suffix = "";
				for (let c = cells.length; c <= maxColNeeded; c++) {
					suffix += t.delimiter + csvCell(tailVals.get(c) ?? "", t.delimiter);
				}
				cellEdits.push({ start: last.end, end: last.end, text: suffix });
				changedCells += tailVals.size;
			}
		}
		if (!cellEdits.length) return 0;
		const ops = coalesceZeroWidthEdits(cellEdits)
			.sort((a, b) => b.start - a.start || b.end - a.end)
			.map((ed) => {
				const from = model.getPositionAt(ed.start);
				const to = model.getPositionAt(ed.end);
				return {
					range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column },
					text: ed.text,
				};
			});
		model.pushStackElement();
		model.pushEditOperations([], ops, () => null);
		model.pushStackElement();
		return changedCells;
	};

	const clearCellRange = (range: CellRangeRect) => {
		const list = displayRows();
		const cols = visibleColumns();
		const updates: { row: number; col: number; value: string }[] = [];
		for (let vr = range.r1; vr <= range.r2; vr++) {
			const item = list[vr];
			if (!item) continue;
			for (let vc = range.c1; vc <= range.c2; vc++) {
				const col = cols[vc];
				if (col === undefined) continue;
				updates.push({ row: item.index, col, value: "" });
			}
		}
		const count = applyCellUpdates(updates);
		if (count > 0) notify(`Cleared ${count} ${count === 1 ? "cell" : "cells"} (Ctrl+Z to undo).`);
	};

	const fillDownSelection = () => {
		if (!model) return;
		const list = displayRows();
		const cols = visibleColumns();
		const range = cellRange();
		const ac = activeCell();
		if (!ac || ac.ghost) return;
		const t = table();
		const updates: { row: number; col: number; value: string }[] = [];

		if (range && range.isMulti && range.r2 > range.r1) {
			const topRow = list[range.r1];
			if (!topRow) return;
			for (let vc = range.c1; vc <= range.c2; vc++) {
				const col = cols[vc];
				if (col === undefined) continue;
				const fillVal = t.rows[topRow.index]?.[col]?.text ?? "";
				for (let vr = range.r1 + 1; vr <= range.r2; vr++) {
					const targetRow = list[vr];
					if (!targetRow) continue;
					updates.push({ row: targetRow.index, col, value: fillVal });
				}
			}
		} else {
			// Single cell or single-row horizontal range: copy from the row directly above.
			const targetVisRow = range ? range.r1 : rowVisIndexMap().get(ac.row);
			if (targetVisRow === undefined || targetVisRow <= 0) return;
			const srcRow = list[targetVisRow - 1];
			const dstRow = list[targetVisRow];
			if (!srcRow || !dstRow) return;
			const cStart = range ? range.c1 : colVisIndexMap().get(ac.column);
			const cEnd = range ? range.c2 : cStart;
			if (cStart === undefined || cEnd === undefined) return;
			for (let vc = cStart; vc <= cEnd; vc++) {
				const col = cols[vc];
				if (col === undefined) continue;
				const fillVal = t.rows[srcRow.index]?.[col]?.text ?? "";
				updates.push({ row: dstRow.index, col, value: fillVal });
			}
		}
		const count = applyCellUpdates(updates);
		if (count > 0) notify(`Filled down ${count} ${count === 1 ? "cell" : "cells"} (Ctrl+Z to undo).`);
	};

	/** Excel-style Ctrl+R fill-right across rectangular selection (or from cell directly to the left). */
	const fillRightSelection = () => {
		if (!model) return;
		const list = displayRows();
		const cols = visibleColumns();
		const range = cellRange();
		const ac = activeCell();
		if (!ac || ac.ghost) return;
		const t = table();
		const updates: { row: number; col: number; value: string }[] = [];

		if (range && range.isMulti && range.c2 > range.c1) {
			const leftCol = cols[range.c1];
			if (leftCol === undefined) return;
			for (let vr = range.r1; vr <= range.r2; vr++) {
				const rowItem = list[vr];
				if (!rowItem) continue;
				const fillVal = t.rows[rowItem.index]?.[leftCol]?.text ?? "";
				for (let vc = range.c1 + 1; vc <= range.c2; vc++) {
					const targetCol = cols[vc];
					if (targetCol === undefined) continue;
					updates.push({ row: rowItem.index, col: targetCol, value: fillVal });
				}
			}
		} else {
			// Single cell or single-column vertical range: copy from the visible column directly to the left.
			const targetVisCol = range ? range.c1 : colVisIndexMap().get(ac.column);
			if (targetVisCol === undefined || targetVisCol <= 0) return;
			const srcCol = cols[targetVisCol - 1];
			const dstCol = cols[targetVisCol];
			if (srcCol === undefined || dstCol === undefined) return;
			const rStart = range ? range.r1 : rowVisIndexMap().get(ac.row);
			const rEnd = range ? range.r2 : rStart;
			if (rStart === undefined || rEnd === undefined) return;
			for (let vr = rStart; vr <= rEnd; vr++) {
				const rowItem = list[vr];
				if (!rowItem) continue;
				const fillVal = t.rows[rowItem.index]?.[srcCol]?.text ?? "";
				updates.push({ row: rowItem.index, col: dstCol, value: fillVal });
			}
		}
		const count = applyCellUpdates(updates);
		if (count > 0) notify(`Filled right ${count} ${count === 1 ? "cell" : "cells"} (Ctrl+Z to undo).`);
	};

	/** Excel-style bottom-right fill handle pointer drag with smart series progression (Alt = literal copy). */
	const onFillHandlePointerDown = (e: PointerEvent) => {
		if (e.button !== 0 || !model) return;
		e.preventDefault();
		e.stopPropagation();
		closeFilterMenu(false);

		const range = cellRange();
		const ac = activeCell();
		let src: { r1: number; r2: number; c1: number; c2: number } | null = null;
		if (range && range.isMulti) {
			src = { r1: range.r1, r2: range.r2, c1: range.c1, c2: range.c2 };
		} else if (ac && !ac.ghost) {
			const vr = rowVisIndexMap().get(ac.row);
			const vc = colVisIndexMap().get(ac.column);
			if (vr !== undefined && vc !== undefined) src = { r1: vr, r2: vr, c1: vc, c2: vc };
		}
		if (!src) return;
		const srcBounds = src;
		let literal = e.altKey;
		let latestFill: FillDrag = { src: srcBounds, axis: null, target: null, literal };
		const setFillState = (next: FillDrag) => {
			latestFill = next;
			setFillDrag(next);
		};
		setFillState(latestFill);

		const cleanup = () => {
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointercancel", onCancel, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("keyup", onKey, true);
			cancelActiveFillDrag = null;
		};

		const updateTargetAt = (clientX: number, clientY: number, altKey: boolean) => {
			literal = altKey;
			if (scrollEl) {
				const sRect = scrollEl.getBoundingClientRect();
				if (clientY > sRect.bottom - 28) scrollEl.scrollTop += 16;
				else if (clientY < sRect.top + 48) scrollEl.scrollTop -= 16;
				if (clientX > sRect.right - 28) scrollEl.scrollLeft += 16;
				else if (clientX < sRect.left + 64) scrollEl.scrollLeft -= 16;
			}
			const el = document.elementFromPoint(clientX, clientY);
			const td = el?.closest<HTMLElement>("tbody tr[data-row] > td[data-col]");
			if (!td || !body?.contains(td)) return;
			const rAttr = td.parentElement?.getAttribute("data-row");
			const cAttr = td.getAttribute("data-col");
			if (rAttr === null || rAttr === undefined || cAttr === null) return;
			const vr = rowVisIndexMap().get(Number(rAttr));
			const vc = colVisIndexMap().get(Number(cAttr));
			if (vr === undefined || vc === undefined) return;

			const dyDown = Math.max(0, vr - srcBounds.r2);
			const dyUp = Math.max(0, srcBounds.r1 - vr);
			const dxRight = Math.max(0, vc - srcBounds.c2);
			const dxLeft = Math.max(0, srcBounds.c1 - vc);
			const maxY = Math.max(dyDown, dyUp);
			const maxX = Math.max(dxRight, dxLeft);

			if (maxY === 0 && maxX === 0) {
				setFillState({ src: srcBounds, axis: null, target: null, literal });
				return;
			}
			if (maxY >= maxX) {
				if (dyDown > 0) {
					setFillState({
						src: srcBounds,
						axis: "down",
						target: { r1: srcBounds.r2 + 1, r2: vr, c1: srcBounds.c1, c2: srcBounds.c2 },
						literal,
					});
				} else {
					setFillState({
						src: srcBounds,
						axis: "up",
						target: { r1: vr, r2: srcBounds.r1 - 1, c1: srcBounds.c1, c2: srcBounds.c2 },
						literal,
					});
				}
			} else if (dxRight > 0) {
				setFillState({
					src: srcBounds,
					axis: "right",
					target: { r1: srcBounds.r1, r2: srcBounds.r2, c1: srcBounds.c2 + 1, c2: vc },
					literal,
				});
			} else {
				setFillState({
					src: srcBounds,
					axis: "left",
					target: { r1: srcBounds.r1, r2: srcBounds.r2, c1: vc, c2: srcBounds.c1 - 1 },
					literal,
				});
			}
		};

		const onMove = (ev: PointerEvent) => {
			ev.preventDefault();
			window.getSelection()?.removeAllRanges();
			updateTargetAt(ev.clientX, ev.clientY, ev.altKey);
		};

		const onCancel = () => {
			cleanup();
			setFillDrag(null);
		};

		const onKey = (ev: KeyboardEvent) => {
			if (ev.key === "Escape") {
				ev.preventDefault();
				ev.stopPropagation();
				onCancel();
				return;
			}
			if (ev.key === "Alt") {
				literal = ev.altKey;
				latestFill = { ...latestFill, literal: ev.altKey };
				setFillDrag((cur) => (cur ? { ...cur, literal: ev.altKey } : cur));
			}
		};

		const onUp = (ev: PointerEvent) => {
			const drag = latestFill;
			const useLiteral = ev.altKey || Boolean(drag?.literal);
			cleanup();
			setFillDrag(null);
			if (!drag || !drag.axis || !drag.target) return;

			const list = displayRows();
			const cols = visibleColumns();
			const t = table();
			const updates: { row: number; col: number; value: string }[] = [];
			const { axis, target } = drag;

			if (axis === "down" || axis === "up") {
				const count = target.r2 - target.r1 + 1;
				for (let vc = srcBounds.c1; vc <= srcBounds.c2; vc++) {
					const col = cols[vc];
					if (col === undefined) continue;
					const seeds: string[] = [];
					for (let vr = srcBounds.r1; vr <= srcBounds.r2; vr++) {
						const item = list[vr];
						seeds.push(item ? (t.rows[item.index]?.[col]?.text ?? "") : "");
					}
					const series = generateFillSeries(seeds, count, { literal: useLiteral, reverse: axis === "up" });
					for (let i = 0; i < count; i++) {
						const targetVr = axis === "down" ? target.r1 + i : target.r2 - i;
						const item = list[targetVr];
						if (item) updates.push({ row: item.index, col, value: series[i] ?? "" });
					}
				}
			} else {
				const count = target.c2 - target.c1 + 1;
				for (let vr = srcBounds.r1; vr <= srcBounds.r2; vr++) {
					const item = list[vr];
					if (!item) continue;
					const seeds: string[] = [];
					for (let vc = srcBounds.c1; vc <= srcBounds.c2; vc++) {
						const col = cols[vc];
						seeds.push(col !== undefined ? (t.rows[item.index]?.[col]?.text ?? "") : "");
					}
					const series = generateFillSeries(seeds, count, { literal: useLiteral, reverse: axis === "left" });
					for (let i = 0; i < count; i++) {
						const targetVc = axis === "right" ? target.c1 + i : target.c2 - i;
						const col = cols[targetVc];
						if (col !== undefined) updates.push({ row: item.index, col, value: series[i] ?? "" });
					}
				}
			}

			const changed = applyCellUpdates(updates);
			const unionR1 = Math.min(srcBounds.r1, target.r1);
			const unionR2 = Math.max(srcBounds.r2, target.r2);
			const unionC1 = Math.min(srcBounds.c1, target.c1);
			const unionC2 = Math.max(srcBounds.c2, target.c2);
			const startRowItem = list[unionR1];
			const endRowItem = list[unionR2];
			const startCol = cols[unionC1];
			const endCol = cols[unionC2];
			if (startRowItem && endRowItem && startCol !== undefined && endCol !== undefined) {
				setCellAnchor({ row: startRowItem.index, column: startCol });
				focusCell(endRowItem.index, endCol, { keepAnchor: true });
			}
			if (changed > 0) {
				notify(`${useLiteral ? "Copied" : "Filled"} ${changed} ${changed === 1 ? "cell" : "cells"} (Ctrl+Z to undo).`);
			}
		};

		cancelActiveFillDrag?.();
		cancelActiveFillDrag = onCancel;
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointercancel", onCancel, true);
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("keyup", onKey, true);
	};

	const copyCellRangeAsTsv = async (range: CellRangeRect) => {
		const list = displayRows();
		const cols = visibleColumns();
		const lines: string[] = [];
		for (let vr = range.r1; vr <= range.r2; vr++) {
			const item = list[vr];
			if (!item) continue;
			const rowVals: string[] = [];
			for (let vc = range.c1; vc <= range.c2; vc++) {
				const col = cols[vc];
				rowVals.push(col === undefined ? "" : csvCell(item.cells[col]?.text ?? "", "\t"));
			}
			lines.push(rowVals.join("\t"));
		}
		await copyText(lines.join("\n"), `Copied ${range.rowCount} × ${range.colCount} cells as TSV.`);
	};

	const copyCellRangeAsMarkdown = async (range: CellRangeRect) => {
		const list = displayRows();
		const cols = visibleColumns();
		const headers: string[] = [];
		for (let vc = range.c1; vc <= range.c2; vc++) {
			const col = cols[vc];
			headers.push(col === undefined ? "" : headerName(col) || `Column ${col + 1}`);
		}
		const bodyRows: string[][] = [];
		for (let vr = range.r1; vr <= range.r2; vr++) {
			const item = list[vr];
			if (!item) continue;
			const vals: string[] = [];
			for (let vc = range.c1; vc <= range.c2; vc++) {
				const col = cols[vc];
				vals.push(col === undefined ? "" : (item.cells[col]?.text ?? ""));
			}
			bodyRows.push(vals);
		}
		await copyText(
			cellsToMarkdownTable(headers, bodyRows),
			`Copied ${range.rowCount} × ${range.colCount} cells as a Markdown table.`,
		);
	};

	const copyRowAsMarkdown = async (row: number) => {
		const cells = table().rows[row];
		if (!cells) return;
		const cols = visibleColumns();
		const headers = cols.map((c) => headerName(c) || `Column ${c + 1}`);
		const rowVals = cols.map((c) => cells[c]?.text ?? "");
		await copyText(cellsToMarkdownTable(headers, [rowVals]), "Copied row as a Markdown table.");
	};

	/** Starts pointer drag-selection across cells (clears browser text selection only once drag crosses into another cell). */
	const onCellMouseDown = (e: MouseEvent, row: number, col: number) => {
		if (e.button !== 0) {
			// Right-clicking a cell already inside a multi-cell range preserves the range.
			if (!isCellInRange(row, col)) {
				setCellAnchor(null);
				setActiveCell({ ghost: false, row, column: col });
			}
			return;
		}
		const target = e.target as HTMLElement | null;
		if (target?.closest(".table-fill-handle")) return;
		if (target?.closest("input, textarea, button")) {
			setCellAnchor(null);
			setActiveCell({ ghost: false, row, column: col });
			return;
		}
		if (e.shiftKey) {
			e.preventDefault();
			const curAc = activeCell();
			if (!cellAnchor()) {
				if (curAc && !curAc.ghost) setCellAnchor({ row: curAc.row, column: curAc.column });
				else setCellAnchor({ row, column: col });
			}
			setActiveCell({ ghost: false, row, column: col });
			(e.currentTarget as HTMLElement).focus();
			return;
		}
		setCellAnchor({ row, column: col });
		setActiveCell({ ghost: false, row, column: col });
		let dragged = false;
		let endRow = row;
		let endCol = col;
		const cleanup = () => {
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointercancel", onUp, true);
			cancelActiveCellDrag = null;
			setIsDragSelecting(false);
		};
		const onMove = (ev: PointerEvent) => {
			const el = document.elementFromPoint(ev.clientX, ev.clientY);
			const td = el?.closest<HTMLElement>("tbody tr[data-row] > td[data-col]");
			if (!td || !body?.contains(td)) return;
			const tr = td.parentElement;
			const rAttr = tr?.getAttribute("data-row");
			const cAttr = td.getAttribute("data-col");
			if (rAttr === null || rAttr === undefined || cAttr === null) return;
			const nextRow = Number(rAttr);
			const nextCol = Number(cAttr);
			if (!Number.isInteger(nextRow) || !Number.isInteger(nextCol)) return;
			if (!dragged && (nextRow !== row || nextCol !== col)) {
				dragged = true;
				setIsDragSelecting(true);
				window.getSelection()?.removeAllRanges();
			}
			if (dragged) {
				endRow = nextRow;
				endCol = nextCol;
				setActiveCell({ ghost: false, row: nextRow, column: nextCol });
			}
		};
		const onUp = () => {
			cleanup();
			if (!dragged) {
				setCellAnchor(null);
			} else {
				queueMicrotask(() => {
					body?.querySelector<HTMLElement>(`tr[data-row="${endRow}"] > td[data-col="${endCol}"]`)?.focus();
				});
			}
		};
		cancelActiveCellDrag?.();
		cancelActiveCellDrag = cleanup;
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointercancel", onUp, true);
	};

	/** Changes one cell: that part of the text, written as a cell must be. A row short of the column gets the cells between. */
	const changeCell = (row: number, column: number, value: string) => {
		if (!model) return;
		const cells = table().rows[row];
		if (!cells) return;
		const delimiter = table().delimiter;
		const cell = cells[column];
		if (cell && cell.text === value) return;
		const last = cells[cells.length - 1]!;
		const [start, end, written] = cell
			? [cell.start, cell.end, serializeCellInRow(value, cells.length, delimiter)]
			: [last.end, last.end, delimiter.repeat(column - cells.length + 1) + csvCell(value, delimiter)];
		const from = model.getPositionAt(start);
		const to = model.getPositionAt(end);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: written }], () => null);
		model.pushStackElement();
	};

	/** Commits an existing cell edit (or writes across the whole multi-cell range on Ctrl+Enter) and optionally moves focus. */
	const commitCell = (row: number, column: number, value: string, move: CommitMove) => {
		// Pin the edited row under active filters so editing a cell doesn't immediately drop the row and strand Tab/focus.
		pinRowIfFiltered(row);
		if (move === "range") {
			const range = cellRange();
			if (range && range.isMulti) {
				const list = displayRows();
				const cols = visibleColumns();
				const updates: { row: number; col: number; value: string }[] = [];
				for (let vr = range.r1; vr <= range.r2; vr++) {
					const item = list[vr];
					if (!item) continue;
					for (let vc = range.c1; vc <= range.c2; vc++) {
						const c = cols[vc];
						if (c === undefined) continue;
						updates.push({ row: item.index, col: c, value });
					}
				}
				const count = applyCellUpdates(updates);
				setEditing(null);
				focusCell(row, column, { keepAnchor: true });
				if (count > 0) notify(`Updated ${count} ${count === 1 ? "cell" : "cells"} in selection (Ctrl+Z to undo).`);
				return;
			}
			changeCell(row, column, value);
			setEditing(null);
			focusCell(row, column);
			return;
		}
		changeCell(row, column, value);
		flush();
		const cols = visibleColumns();
		const visCol = cols.indexOf(column);
		if (move === "next") {
			if (visCol >= 0 && visCol + 1 < cols.length) {
				const nextCol = cols[visCol + 1]!;
				setCellAnchor(null);
				setActiveCell({ ghost: false, row, column: nextCol });
				setEditing({ ghost: false, row, column: nextCol });
				return;
			}
			const list = displayRows();
			const vis = list.findIndex((r) => r.index === row);
			const firstCol = cols[0] ?? 0;
			if (vis >= 0 && vis + 1 < list.length) {
				navigateToVisRow(vis + 1, firstCol, { edit: true });
			} else {
				setCellAnchor(null);
				setActiveCell({ ghost: true, column: firstCol });
				setEditing({ ghost: true, column: firstCol });
				queueMicrotask(() => foot?.scrollIntoView({ block: "nearest" }));
			}
			return;
		}
		if (move === "prev") {
			if (visCol > 0) {
				const prevCol = cols[visCol - 1]!;
				setCellAnchor(null);
				setActiveCell({ ghost: false, row, column: prevCol });
				setEditing({ ghost: false, row, column: prevCol });
				return;
			}
			const list = displayRows();
			const vis = list.findIndex((r) => r.index === row);
			if (vis > 0) {
				navigateToVisRow(vis - 1, cols[cols.length - 1] ?? 0, { edit: true });
				return;
			}
		}
		if (move === "down") {
			setEditing(null);
			const list = displayRows();
			const vis = list.findIndex((r) => r.index === row);
			if (vis >= 0 && vis + 1 < list.length) {
				navigateToVisRow(vis + 1, column);
			} else {
				focusGhostCell(column);
			}
			return;
		}
		setEditing(null);
		if (move === "stay") focusCell(row, column);
	};

	/**
	 * Commits the blank final ghost row. Nothing is written to the file unless
	 * the user entered non-empty content; Tab on an empty ghost cell moves
	 * horizontally across the ghost row without dirtying the file.
	 */
	const commitGhost = (column: number, value: string, move: CommitMove) => {
		const cols = visibleColumns();
		const visCol = cols.indexOf(column);
		if (!model || !cols.length) {
			setEditing(null);
			return;
		}
		if (value === "") {
			if (move === "next" && visCol >= 0 && visCol + 1 < cols.length) {
				const nextCol = cols[visCol + 1]!;
				setCellAnchor(null);
				setActiveCell({ ghost: true, column: nextCol });
				setEditing({ ghost: true, column: nextCol });
				return;
			}
			if (move === "prev") {
				if (visCol > 0) {
					const prevCol = cols[visCol - 1]!;
					setCellAnchor(null);
					setActiveCell({ ghost: true, column: prevCol });
					setEditing({ ghost: true, column: prevCol });
					return;
				}
				const list = displayRows();
				if (list.length > 0) {
					navigateToVisRow(list.length - 1, cols[cols.length - 1] ?? 0, { edit: true });
					return;
				}
			}
			setEditing(null);
			if (move === "stay" || move === "down") focusGhostCell(column);
			return;
		}

		const values = table().header.map((_, i) => (i === column ? value : ""));
		const edit = appendRowEdit(model.getValue(), values, table().delimiter, model.getEOL());
		const pos = model.getPositionAt(edit.offset);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: edit.text }], () => null);
		model.pushStackElement();

		const newRow = parseCurrentCsv(model.getValue()).rows.length - 1;
		pinRowIfFiltered(newRow);
		setCurrent(newRow);

		if (move === "next") {
			if (visCol >= 0 && visCol + 1 < cols.length) {
				const nextCol = cols[visCol + 1]!;
				setActiveCell({ ghost: false, row: newRow, column: nextCol });
				setEditing({ ghost: false, row: newRow, column: nextCol });
			} else {
				const firstCol = cols[0] ?? 0;
				setActiveCell({ ghost: true, column: firstCol });
				setEditing({ ghost: true, column: firstCol });
			}
			return;
		}
		if (move === "prev" && visCol > 0) {
			const prevCol = cols[visCol - 1]!;
			setActiveCell({ ghost: false, row: newRow, column: prevCol });
			setEditing({ ghost: false, row: newRow, column: prevCol });
			return;
		}
		setEditing(null);
		if (move === "down") focusGhostCell(column);
		else if (move === "stay") queueMicrotask(() => focusCell(newRow, column));
	};

	const moveRowTo = (fromRow: number, toRow: number, focusCol?: number) => {
		if (!model) return;
		if (order().length > 0) {
			notify("Clear or apply the active sort before reordering rows.");
			return;
		}
		if (hasActiveFilters()) {
			notify("Clear active filters before reordering rows.");
			return;
		}
		if (groupByCol() !== null) {
			notify("Clear row grouping before reordering rows.");
			return;
		}
		const count = table().rows.length;
		if (fromRow < 0 || fromRow >= count || toRow < 0 || toRow >= count || fromRow === toRow) return;
		const raw = model.getValue();
		const fresh = parseCurrentCsv(raw);
		const next = moveCsvRow(raw, fresh, fromRow, toRow);
		if (next === raw) return;

		setSelectedRows((prev) => {
			if (!prev.size) return prev;
			const remapped = new Set<number>();
			for (const r of prev) remapped.add(remapIndexAfterMove(r, fromRow, toRow));
			return remapped;
		});
		const lastClk = lastClickedRow();
		if (lastClk !== null) setLastClickedRow(remapIndexAfterMove(lastClk, fromRow, toRow));
		const pin = pinnedRow();
		if (pin !== null) setPinnedRow(remapIndexAfterMove(pin, fromRow, toRow));
		setCellAnchor(null);
		setEditing(null);
		clearFindSelectionScope();
		clearRowHeights();

		const fullRange = model.getFullModelRange();
		model.pushStackElement();
		model.pushEditOperations([], [{ range: fullRange, text: next }], () => null);
		model.pushStackElement();

		const col = focusCol ?? activeCell()?.column ?? visibleColumns()[0] ?? 0;
		queueMicrotask(() => focusCell(toRow, col));
	};

	const onRowGripPointerDown = (e: PointerEvent, rowIdx: number) => {
		if (e.button !== 0 || !canReorderRows() || table().rows.length < 2) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest("input")) return;
		e.stopPropagation();
		const startY = e.clientY;
		const label = table().rows[rowIdx]?.[0]?.text.trim() || `Row ${rowIdx + 1}`;
		let dragging = false;
		let latestRowDrag: RowDrag | null = null;

		const computeDrop = (clientY: number): { dropRow: number; side: "before" | "after" } => {
			if (!body) return { dropRow: rowIdx, side: "before" };
			const trs = body.querySelectorAll<HTMLElement>("tr[data-row]");
			let hoverRow = rowIdx;
			let side: "before" | "after" = "before";
			for (const tr of trs) {
				const r = Number(tr.getAttribute("data-row"));
				if (!Number.isInteger(r)) continue;
				const rect = tr.getBoundingClientRect();
				if (clientY <= rect.bottom) {
					hoverRow = r;
					side = clientY < rect.top + rect.height / 2 ? "before" : "after";
					return { dropRow: hoverRow, side };
				}
				hoverRow = r;
				side = "after";
			}
			return { dropRow: hoverRow, side };
		};

		const cleanup = () => {
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointercancel", onCancel, true);
			window.removeEventListener("keydown", onKey, true);
			cancelActiveRowDrag = null;
		};

		const onMove = (ev: PointerEvent) => {
			if (!dragging) {
				if (Math.abs(ev.clientY - startY) < 5) return;
				dragging = true;
				closeFilterMenu(false);
				setEditing(null);
			}
			ev.preventDefault();
			if (scrollEl) {
				const sRect = scrollEl.getBoundingClientRect();
				if (ev.clientY > sRect.bottom - 28) scrollEl.scrollTop += 14;
				else if (ev.clientY < sRect.top + 48) scrollEl.scrollTop -= 14;
			}
			const { dropRow, side } = computeDrop(ev.clientY);
			latestRowDrag = { fromRow: rowIdx, dropRow, side, label: shortLabel(label), x: ev.clientX, y: ev.clientY };
			setRowDrag(latestRowDrag);
		};

		const onUp = () => {
			const drag = latestRowDrag;
			cleanup();
			if (dragging && drag) {
				let target = drag.dropRow + (drag.side === "after" ? 1 : 0);
				if (target > drag.fromRow) target--;
				target = Math.max(0, Math.min(table().rows.length - 1, target));
				setRowDrag(null);
				if (target !== drag.fromRow) moveRowTo(drag.fromRow, target);
			} else {
				setRowDrag(null);
			}
		};

		const onCancel = () => {
			cleanup();
			setRowDrag(null);
		};

		const onKey = (ev: KeyboardEvent) => {
			if (ev.key === "Escape" && dragging) {
				ev.preventDefault();
				ev.stopPropagation();
				onCancel();
			}
		};

		cancelActiveRowDrag?.();
		cancelActiveRowDrag = onCancel;
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointercancel", onCancel, true);
		window.addEventListener("keydown", onKey, true);
	};

	const insertRowAt = (row: number, position: "above" | "below") => {
		if (!model || !table().header.length) return;
		const line = table().header.length > 1 ? csvRow(table().header.map(() => ""), table().delimiter) : '""';
		const edit = insertRowEdit(model.getValue(), table(), row, position, line, model.getEOL());
		if (!edit) return;
		const targetRow = position === "above" ? row : row + 1;
		const pos = model.getPositionAt(edit.offset);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: edit.text }], () => null);
		model.pushStackElement();
		setSelectedRows((prev) => (prev.size ? remapRowSetOnInsert(prev, targetRow) : prev));
		setLastClickedRow((prev) => remapRowIndexOnInsert(prev, targetRow));
		setCellAnchor((prev) => (prev ? { ...prev, row: remapRowIndexOnInsert(prev.row, targetRow)! } : null));
		clearFindSelectionScope();
		clearRowHeights();
		pinRowIfFiltered(targetRow);
		setCurrent(targetRow);
		queueMicrotask(() => setEditing({ ghost: false, row: targetRow, column: visibleColumns()[0] ?? 0 }));
	};

	const duplicateRowAt = (row: number) => {
		if (!model) return;
		const raw = rawRowText(model.getValue(), table(), row);
		if (raw === null) return;
		const edit = insertRowEdit(model.getValue(), table(), row, "below", raw, model.getEOL());
		if (!edit) return;
		const targetRow = row + 1;
		const pos = model.getPositionAt(edit.offset);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: edit.text }], () => null);
		model.pushStackElement();
		setSelectedRows((prev) => (prev.size ? remapRowSetOnInsert(prev, targetRow) : prev));
		setLastClickedRow((prev) => remapRowIndexOnInsert(prev, targetRow));
		setCellAnchor((prev) => (prev ? { ...prev, row: remapRowIndexOnInsert(prev.row, targetRow)! } : null));
		clearFindSelectionScope();
		clearRowHeights();
		pinRowIfFiltered(targetRow);
		setCurrent(targetRow);
		queueMicrotask(() => focusCell(targetRow, visibleColumns()[0] ?? 0));
	};

	const deleteRowAt = (row: number) => {
		if (!model) return;
		const span = rowSpan(model.getValue(), table(), row);
		if (!span) return;
		const from = model.getPositionAt(span.start);
		const to = model.getPositionAt(span.end);
		setSelectedRows((prev) => (prev.size ? remapRowSetOnDelete(prev, row) : prev));
		setLastClickedRow((prev) => remapRowIndexOnDelete(prev, row));
		setCellAnchor((prev) => {
			if (!prev) return null;
			const remapped = remapRowIndexOnDelete(prev.row, row);
			return remapped === null ? null : { ...prev, row: remapped };
		});
		clearFindSelectionScope();
		clearRowHeights();
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: "" }], () => null);
		model.pushStackElement();
		const remaining = parseCurrentCsv(model.getValue()).rows.length;
		const nextRow: number | null = remaining > 0 ? Math.min(row, remaining - 1) : null;
		setCurrent(nextRow);
		setEditing(null);
		const pin = pinnedRow();
		if (pin === row) setPinnedRow(null);
		else if (pin !== null && pin > row) setPinnedRow(pin - 1);
		queueMicrotask(() => {
			if (nextRow !== null) focusCell(nextRow, activeCell()?.column ?? visibleColumns()[0] ?? 0);
			else rootEl?.focus();
		});
	};

	const applyFullText = (nextText: string, message?: string) => {
		if (!model) return;
		const fullRange = model.getFullModelRange();
		model.pushStackElement();
		model.pushEditOperations([], [{ range: fullRange, text: nextText }], () => null);
		model.pushStackElement();
		if (message) notify(message);
		queueMicrotask(() => rootEl?.focus());
	};

	const visibleRowSet = createMemo(() => new Set(rows().map((r) => r.index)));
	/** Selected rows that are currently visible under active filters (bulk edits never silently mutate hidden rows). */
	const visibleSelectedRows = createMemo(() => {
		const vis = visibleRowSet();
		return [...selectedRows()].filter((r) => vis.has(r));
	});
	const hiddenSelectedCount = createMemo(() => Math.max(0, selectedRows().size - visibleSelectedRows().length));

	const duplicateKeyWarning = createMemo(() => {
		const lower = baseName(props.path).toLowerCase();
		if (!["database.csv", "database.tsv", "settings.csv", "settings.tsv", "files.csv", "files.tsv"].includes(lower)) return "";
		const dups = duplicateEntries();
		if (!dups.length) return "";
		const preview = dups.slice(0, 3).map((d) => d.key).join(", ");
		return `${dups.length} duplicate ${dups.length === 1 ? "key" : "keys"} in “${headerName(0) || "column 1"}” (${preview}${dups.length > 3 ? ", …" : ""}).`;
	});

	/** Applies a single column value across all visible selected rows in one undoable edit. */
	const bulkSetColumn = (colIdx: number, value: string) => {
		if (!model) return;
		const t = parseCurrentCsv(model.getValue());
		const targetRows = visibleSelectedRows().filter((r) => r >= 0 && r < t.rows.length).sort((a, b) => b - a);
		if (!targetRows.length) return;
		const ops: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }[] = [];
		for (const r of targetRows) {
			const cells = t.rows[r]!;
			const cell = cells[colIdx];
			if (cell && cell.text === value) continue;
			const last = cells[cells.length - 1]!;
			const [start, end, written] = cell
				? [cell.start, cell.end, serializeCellInRow(value, cells.length, t.delimiter)]
				: [last.end, last.end, t.delimiter.repeat(colIdx - cells.length + 1) + csvCell(value, t.delimiter)];
			const from = model.getPositionAt(start);
			const to = model.getPositionAt(end);
			ops.push({ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: written });
		}
		if (!ops.length) return;
		model.pushStackElement();
		model.pushEditOperations([], ops, () => null);
		model.pushStackElement();
		notify(`Updated ${ops.length} ${ops.length === 1 ? "row" : "rows"} (Ctrl+Z to undo).`);
	};

	const bulkDeleteSelected = async () => {
		if (!model) return;
		const targetBefore = visibleSelectedRows();
		if (!targetBefore.length) return;
		if ((await choose(`Delete ${targetBefore.length} selected ${targetBefore.length === 1 ? "row" : "rows"}?`, ["Delete rows"], { danger: "Delete rows" })) !== "Delete rows") return;
		const raw = model.getValue();
		const fresh = parseCurrentCsv(raw);
		const targetRows = visibleSelectedRows().filter((r) => r >= 0 && r < fresh.rows.length);
		const nextText = deleteCsvRows(raw, fresh, targetRows);
		if (nextText === null) return;
		setSelectedRows(new Set<number>());
		setLastClickedRow(null);
		setCellAnchor(null);
		setEditing(null);
		setPinnedRow(null);
		clearFindSelectionScope();
		clearRowHeights();
		applyFullText(nextText, `Deleted ${targetRows.length} ${targetRows.length === 1 ? "row" : "rows"} (Ctrl+Z to undo).`);
	};

	const statusCol = createMemo(() => {
		const idx = columnOf(table(), "status");
		if (idx >= 0) return idx;
		return table().header.findIndex((h) => Boolean(ruleForColumn(csvConfig(), h.text.trim())));
	});

	const bulkSetStatus = async () => {
		const col = statusCol();
		if (col < 0) return;
		const rule = columnRule(col);
		const existing = table().rows.map((r) => r[col]?.text ?? "");
		const counts = new Map<string, number>();
		for (const v of existing) {
			const k = v.trim().toLowerCase();
			if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
		}
		const suggestions = rule ? suggestionsForColumn(rule, existing) : [...new Set(existing.map((v) => v.trim()).filter(Boolean))];
		const visCount = visibleSelectedRows().length;
		type StatusPick = { kind: "value"; value: string } | { kind: "custom" } | { kind: "clear" };
		const items: QuickPickOption<StatusPick>[] = [
			...suggestions.map((val): QuickPickOption<StatusPick> => {
				const tone = badgeToneForValue(rule, val);
				const n = counts.get(val.toLowerCase()) ?? 0;
				return {
					label: val,
					value: { kind: "value", value: val },
					icon: "tag",
					badge: tone ? { text: val, tone } : undefined,
					detail: n > 0 ? `${n} ${n === 1 ? "row" : "rows"}` : undefined,
				};
			}),
			{ label: "Enter custom value…", value: { kind: "custom" }, icon: "edit", divide: suggestions.length > 0 },
			{ label: "Clear value", value: { kind: "clear" }, icon: "discard", danger: true },
		];
		const picked = await quickPick<StatusPick>({
			title: `Set “${headerName(col)}” for ${visCount} selected ${visCount === 1 ? "row" : "rows"}`,
			placeholder: `Pick a value for ${headerName(col) || "status"}…`,
			items,
		});
		if (!picked) return;
		if (picked.kind === "clear") return bulkSetColumn(col, "");
		if (picked.kind === "custom") {
			const custom = await ask(`Value for “${headerName(col)}”`);
			if (custom !== null) bulkSetColumn(col, custom);
			return;
		}
		bulkSetColumn(col, picked.value);
	};

	const bulkAssignTicket = async () => {
		const col = ticketAt();
		if (col < 0) return;
		const ticketDocs = docs().filter((d) => d.group === "tickets" && d.exists && d.ticket);
		const seen = new Set<string>();
		const visCount = visibleSelectedRows().length;
		type TicketPick = { kind: "ticket"; key: string } | { kind: "custom" } | { kind: "clear" };
		const items: QuickPickOption<TicketPick>[] = [];
		for (const d of ticketDocs) {
			const k = d.ticket!.toLowerCase();
			if (seen.has(k)) continue;
			seen.add(k);
			items.push({
				label: d.ticket!,
				value: { kind: "ticket", key: d.ticket! },
				icon: "note",
				detail: d.status || undefined,
				description: d.title || undefined,
				keywords: `${d.ticket} ${d.title ?? ""} ${d.status ?? ""}`,
			});
		}
		items.push(
			{ label: "Enter custom ticket key…", value: { kind: "custom" }, icon: "edit", divide: items.length > 0 },
			{ label: "Clear ticket", value: { kind: "clear" }, icon: "discard", danger: true },
		);
		const picked = await quickPick<TicketPick>({
			title: `Assign ticket for ${visCount} selected ${visCount === 1 ? "row" : "rows"}`,
			placeholder: "Type a ticket key or title…",
			items,
		});
		if (!picked) return;
		if (picked.kind === "clear") return bulkSetColumn(col, "");
		if (picked.kind === "custom") {
			const custom = await ask("Ticket key (e.g. LIMS-101)");
			if (custom !== null) bulkSetColumn(col, custom.trim());
			return;
		}
		bulkSetColumn(col, picked.key);
	};

	const bulkFillAnyColumn = async () => {
		const t = table();
		const visCount = visibleSelectedRows().length;
		const items: QuickPickOption<number>[] = t.header.map((h, i) => {
			const name = h.text.trim() || `Column ${i + 1}`;
			let nonEmpty = 0;
			for (const r of t.rows) if ((r[i]?.text ?? "").trim()) nonEmpty++;
			return {
				label: name,
				value: i,
				icon: "table",
				detail: `Column ${i + 1} · ${nonEmpty}/${t.rows.length} filled`,
			};
		});
		const col = await quickPick<number>({
			title: `Fill column for ${visCount} selected ${visCount === 1 ? "row" : "rows"}`,
			placeholder: "Choose a column to fill…",
			items,
		});
		if (col === null) return;
		const colName = headerName(col) || `Column ${col + 1}`;
		const val = await ask(`Value for “${colName}” across ${visCount} selected ${visCount === 1 ? "row" : "rows"}`, "");
		if (val === null) return;
		bulkSetColumn(col, val);
	};

	const pickGroupByColumn = async () => {
		const t = table();
		const curGroup = groupByCol();
		type GroupPick = number | "clear";
		const items: QuickPickOption<GroupPick>[] = [];
		if (curGroup !== null) {
			items.push({
				label: "Clear grouping",
				value: "clear",
				icon: "close",
				detail: `Currently grouped by ${headerName(curGroup) || `Column ${curGroup + 1}`}`,
			});
		}
		t.header.forEach((h, i) => {
			const name = h.text.trim() || `Column ${i + 1}`;
			const distinct = new Set<string>();
			for (const r of t.rows) distinct.add((r[i]?.text ?? "").trim().toLowerCase());
			items.push({
				label: name,
				value: i,
				icon: "list-tree",
				checked: curGroup === i,
				divide: curGroup !== null && i === 0,
				detail: `${distinct.size} ${distinct.size === 1 ? "group" : "groups"}`,
			});
		});
		const picked = await quickPick<GroupPick>({
			title: "Group rows by column",
			placeholder: "Choose a column to group by…",
			items,
		});
		if (picked === null) return;
		if (picked === "clear") {
			setGroupByCol(null);
			setCollapsedGroups(new Set<string>());
		} else {
			toggleGroupByColumn(picked);
		}
	};

	const addColumnInteractive = async () => {
		if (!model) return;
		const name = (await ask("New column name"))?.trim();
		if (!name) return;
		const defVal = await ask(`Default value for existing rows in “${name}” (leave blank for empty)`, "");
		if (defVal === null) return;
		const next = addCsvColumn(model.getValue(), table(), name, defVal);
		if (next) applyFullText(next, `Added column “${name}” (Ctrl+Z to undo).`);
	};

	const renameColumnInteractive = async (col: number) => {
		if (!model || !hasHeader()) return;
		const oldName = headerName(col);
		const nextName = (await ask(`Rename column “${oldName || `Column ${col + 1}`}” to`, oldName))?.trim();
		if (!nextName || nextName === oldName) return;
		const next = renameCsvColumn(model.getValue(), table(), col, nextName);
		if (next) applyFullText(next, `Renamed column to “${nextName}”.`);
	};

	const deleteColumnInteractive = async (col: number) => {
		if (!model || table().header.length < 2) return;
		const name = headerName(col) || `Column ${col + 1}`;
		if ((await choose(`Delete column “${name}” and all of its values?`, ["Delete column"], { danger: "Delete column" })) !== "Delete column") return;
		const raw = model.getValue();
		const fresh = parseCurrentCsv(raw);
		const next = deleteCsvColumn(raw, fresh, col);
		if (!next) return;
		const beforeAlt = model.getAlternativeVersionId();
		const beforeSnap = captureColUi();
		const shift = (idx: number) => (idx === col ? -1 : idx > col ? idx - 1 : idx);

		// Remap sort, grouping, code-check, frozen/hidden/order/widths/filters for remaining columns cleanly.
		const curSort = order();
		const nextSort = curSort.length ? remapSortSpecs(curSort, shift) : [];
		if (curSort.length) setOrder(nextSort);
		const curGrp = groupByCol();
		const nextGrp = curGrp !== null ? (shift(curGrp) >= 0 ? shift(curGrp) : null) : null;
		if (curGrp !== null) setGroupByCol(nextGrp);
		const curChk = codeCheck();
		let nextChk: CodeCheckResult | null = curChk;
		if (curChk) {
			const mapped = shift(curChk.column);
			if (mapped >= 0) {
				nextChk = { ...curChk, column: mapped };
				setCodeCheck(nextChk);
			} else {
				nextChk = null;
				clearCodeCheck();
			}
		}
		const nextFrozen = frozenCols().map(shift).filter((c) => c >= 0);
		setFrozenCols(nextFrozen);
		const nextHidden = new Set([...hiddenCols()].map(shift).filter((c) => c >= 0));
		setHiddenCols(nextHidden);
		const remappedOrder = colOrder().map(shift).filter((c) => c >= 0);
		const nextOrder = isNaturalOrder(remappedOrder) ? [] : remappedOrder;
		setColOrder(nextOrder);
		const nextWidths: Record<number, number> = {};
		for (const [k, w] of Object.entries(colWidths())) {
			const m = shift(Number(k));
			if (m >= 0) nextWidths[m] = w;
		}
		setColWidths(nextWidths);
		const nextFilters = new Map<number, ColumnFilter>();
		for (const [k, f] of colFilters()) {
			const m = shift(k);
			if (m >= 0) nextFilters.set(m, f);
		}
		setColFilters(nextFilters);
		setEditing(null);
		setCellAnchor(null);
		clearFindSelectionScope();
		clearRowHeights();
		closeFilterMenu(false);
		applyFullText(next, `Deleted column “${name}” (Ctrl+Z to undo).`);
		const afterAlt = model.getAlternativeVersionId();
		if (afterAlt !== beforeAlt) {
			const afterSnap: ColumnUiSnapshot = {
				colFilters: new Map(nextFilters),
				order: nextSort.map((s) => ({ ...s })),
				frozenCols: [...nextFrozen],
				hiddenCols: new Set(nextHidden),
				colOrder: [...nextOrder],
				colWidths: { ...nextWidths },
				codeCheck: nextChk ? { ...nextChk } : null,
				groupByCol: nextGrp,
			};
			colSnapshots.set(colSnapshotTransitionKey(afterAlt, beforeAlt), beforeSnap);
			colSnapshots.set(colSnapshotTransitionKey(beforeAlt, afterAlt), afterSnap);
		}
	};

	const applySortToFile = async () => {
		if (!model) return;
		const sorts = order();
		if (!sorts.length) return;
		if (hasActiveFilters()) {
			const ok = await choose(
				"Filters are active. Applying sort writes the sorted order for all rows in the file (including hidden rows).",
				["Apply sort to file"],
			);
			if (ok !== "Apply sort to file") return;
		}
		const raw = model.getValue();
		const t = parseCurrentCsv(raw);
		const sortedIndices = t.rows
			.map((cells, idx) => ({ idx, cells }))
			.sort((a, b) => compareRowsBySorts(a.cells, b.cells, sorts, (cells, col) => cells[col]?.text ?? ""))
			.map((x) => x.idx);
		const next = sortCsvRows(raw, t, sortedIndices);
		setOrder([]);
		if (!next) {
			notify("Rows are already in that order.");
			return;
		}
		// Clear row-index-based selection so checked checkboxes never point at shifted rows.
		setSelectedRows(new Set<number>());
		setLastClickedRow(null);
		setPinnedRow(null);
		setCellAnchor(null);
		setActiveCell(null);
		setEditing(null);
		clearFindSelectionScope();
		clearRowHeights();
		applyFullText(next, "Saved row sort order to file (Ctrl+Z to undo).");
	};

	const copyFilteredAs = async (fmt: "tsv" | "csv" | "markdown") => {
		const cols = visibleColumns();
		const headers = cols.map((c) => headerName(c) || `Column ${c + 1}`);
		const bodyRows = rows().map((r) => cols.map((c) => r.cells[c]?.text ?? ""));
		const out =
			fmt === "tsv"
				? hasHeader()
					? tableToTsv(headers, bodyRows)
					: bodyRows.map((r) => r.map((v) => csvCell(v, "\t")).join("\t")).join("\n")
				: fmt === "csv"
					? (hasHeader() ? [csvRow(headers, table().delimiter), ...bodyRows.map((r) => csvRow(r, table().delimiter))] : bodyRows.map((r) => csvRow(r, table().delimiter))).join("\n")
					: cellsToMarkdownTable(headers, bodyRows);
		const label = fmt === "tsv" ? "TSV for Excel/Sheets" : fmt === "csv" ? "CSV" : "a Markdown table";
		await copyText(out, `Copied ${bodyRows.length} rows as ${label}.`);
	};

	const exportVisibleToFile = async (fmt: "csv" | "tsv") => {
		const stem = baseName(props.path).replace(/\.(csv|tsv|txt|psv)$/i, "") || "table";
		const suffix = hasActiveFilters() ? "filtered" : "export";
		const suggestedFile = `${stem}-${suffix}.${fmt}`;
		const root = state.workspace?.root;
		const inWorkspace = Boolean(root && isInside(root, props.path));
		const curDir = dirName(props.path);
		const relDir = inWorkspace && root ? relativeTo(root, curDir) : "";
		const defaultDest =
			inWorkspace && relDir && relDir !== curDir && relDir !== "."
				? `${relDir}/${suggestedFile}`
				: suggestedFile;
		const entered = (
			await ask(
				`Export ${rows().length} visible ${rows().length === 1 ? "row" : "rows"} as ${fmt.toUpperCase()} file`,
				defaultDest,
			)
		)?.trim();
		if (!entered) return;
		const isAbs = entered.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(entered);
		const baseDir = inWorkspace && root ? root : curDir;
		const dest = isAbs ? entered : resolvePath(baseDir, entered);
		const exists = await backend.read(dest).then(() => true, () => false);
		if (exists) {
			const ok = await choose(`Overwrite existing file “${relativeTo(root, dest)}”?`, ["Overwrite"], { danger: "Overwrite" });
			if (ok !== "Overwrite") return;
		}
		const cols = visibleColumns();
		const headers = cols.map((c) => headerName(c));
		const bodyRows = rows().map((r) => cols.map((c) => r.cells[c]?.text ?? ""));
		const delim: CsvDelimiter = fmt === "tsv" ? "\t" : ",";
		const lines = hasHeader()
			? [csvRow(headers, delim), ...bodyRows.map((r) => csvRow(r, delim))]
			: bodyRows.map((r) => csvRow(r, delim));
		const content = `${lines.join("\n")}\n`;
		try {
			await backend.write(dest, content);
			notify(`Exported ${bodyRows.length} ${bodyRows.length === 1 ? "row" : "rows"} to ${relativeTo(root, dest)}.`);
		} catch (e: any) {
			notify(`Could not export file: ${e?.message ?? e}`, "error");
		}
	};

	const convertDelimiterInteractive = async () => {
		if (!model) return;
		const choices: { label: string; value: CsvDelimiter; detail: string }[] = [
			{ label: "Comma (,)", value: ",", detail: "Standard CSV" },
			{ label: "Tab (TSV)", value: "\t", detail: "Tab-separated (Excel / Sheets)" },
			{ label: "Semicolon (;)", value: ";", detail: "Regional CSV" },
			{ label: "Pipe (|)", value: "|", detail: "Pipe-delimited" },
		];
		const cur = table().delimiter;
		const items: QuickPickOption<CsvDelimiter>[] = choices
			.filter((c) => c.value !== cur)
			.map((c) => ({
				label: c.label,
				value: c.value,
				detail: c.detail,
				icon: "table",
			}));
		const target = await quickPick<CsvDelimiter>({
			title: `Convert file delimiter from ${delimiterLabel(cur)}`,
			placeholder: "Choose target delimiter…",
			items,
		});
		if (!target) return;
		const raw = model.getValue();
		const fresh = parseCurrentCsv(raw);
		const next = convertCsvDelimiter(raw, fresh, target);
		if (next === raw) return;
		setDelimiterOverride("auto");
		applyFullText(next, `Converted file delimiter to ${delimiterLabel(target)} (Ctrl+Z to undo).`);
	};

	const copySelectedAsCsv = async () => {
		const sel = selectedRows();
		const ordered = rows().filter((r) => sel.has(r.index));
		if (!ordered.length) return;
		const cols = visibleColumns();
		const headers = cols.map((c) => headerName(c));
		const bodyRows = ordered.map((r) => cols.map((c) => r.cells[c]?.text ?? ""));
		const out = (hasHeader() ? [csvRow(headers, table().delimiter), ...bodyRows.map((r) => csvRow(r, table().delimiter))] : bodyRows.map((r) => csvRow(r, table().delimiter))).join("\n");
		await copyText(out, `Copied ${bodyRows.length} selected ${bodyRows.length === 1 ? "row" : "rows"} as CSV.`);
	};

	const copySelectedAsTsv = async () => {
		const sel = selectedRows();
		const ordered = rows().filter((r) => sel.has(r.index));
		if (!ordered.length) return;
		const cols = visibleColumns();
		const headers = cols.map((c) => headerName(c));
		const bodyRows = ordered.map((r) => cols.map((c) => r.cells[c]?.text ?? ""));
		const out = hasHeader() ? tableToTsv(headers, bodyRows) : bodyRows.map((r) => r.map((v) => csvCell(v, "\t")).join("\t")).join("\n");
		await copyText(out, `Copied ${bodyRows.length} selected ${bodyRows.length === 1 ? "row" : "rows"} as TSV for Excel/Sheets.`);
	};

	const copySelectedAsMarkdown = async () => {
		const sel = selectedRows();
		const ordered = rows().filter((r) => sel.has(r.index));
		if (!ordered.length) return;
		const cols = visibleColumns();
		const headers = cols.map((c) => headerName(c) || `Column ${c + 1}`);
		const bodyRows = ordered.map((r) => cols.map((c) => r.cells[c]?.text ?? ""));
		await copyText(
			cellsToMarkdownTable(headers, bodyRows),
			`Copied ${bodyRows.length} selected ${bodyRows.length === 1 ? "row" : "rows"} as a Markdown table.`,
		);
	};

	/** Scans `schema/**\/*.sql` (including ALTER DDL) and reconciles `database.csv`/`database.tsv` with newly discovered and dropped SQL objects (ADR 0009). */
	const syncDatabaseRegistryFromSchema = async () => {
		const root = state.workspace?.root;
		if (!model || !root) return;
		const fileLabel = baseName(props.path);
		const schemaRel = state.project?.schema ?? "schema";
		const schemaDir = joinPath(root, ...schemaRel.split(/[\\/]/).filter((p) => p && p !== "."));
		try {
			const allFiles = await backend.files();
			const sqlFiles = allFiles.filter((f) => isInside(schemaDir, f) && /\.(sql|ddl|pks|pkb)$/i.test(f));
			if (!sqlFiles.length) {
				notify(`No SQL files found under ${schemaRel}/ to sync from.`);
				return;
			}
			const t = parseCurrentCsv(model.getValue());
			const nameCol = (() => {
				for (const candidate of ["object", "name", "table"]) {
					const idx = columnOf(t, candidate);
					if (idx >= 0) return idx;
				}
				return 0;
			})();
			const kindCol = columnOf(t, "kind") >= 0 ? columnOf(t, "kind") : columnOf(t, "type");
			const statusIdx = columnOf(t, "status");
			const noteCol = columnOf(t, "note") >= 0 ? columnOf(t, "note") : columnOf(t, "notes");
			// Match both schema-qualified (`dbo.SAMPLES`) and bare (`SAMPLES`) names to prevent duplicate rows.
			const existingNames = new Set<string>();
			for (const r of t.rows) {
				const val = (r[nameCol]?.text ?? "").trim().toLowerCase();
				if (!val) continue;
				existingNames.add(val);
				const dot = val.lastIndexOf(".");
				if (dot >= 0) existingNames.add(val.slice(dot + 1));
			}
			const allSqlNames = new Set<string>();
			const discovered: { name: string; kind: string; source: string }[] = [];
			const seenNew = new Set<string>();
			for (const file of sqlFiles) {
				const res = await backend.read(file).catch(() => null);
				if (!res || res.binary) continue;
				const relFile = relativeTo(root, file).split("\\").join("/");
				for (const obj of extractSqlObjects(res.text, { includeAlter: true })) {
					const fullKey = obj.name.toLowerCase();
					const bareKey = obj.bareName.toLowerCase();
					allSqlNames.add(fullKey);
					allSqlNames.add(bareKey);
					if (existingNames.has(fullKey) || existingNames.has(bareKey) || seenNew.has(fullKey) || seenNew.has(bareKey)) continue;
					seenNew.add(fullKey);
					seenNew.add(bareKey);
					discovered.push({ name: obj.name, kind: obj.kind, source: `From ${relFile}` });
				}
			}
			// Detect previously synced objects that no longer appear in any schema SQL file (skipping rows already marked "gone").
			const dropped = t.rows
				.map((r, rowIdx) => ({
					rowIdx,
					name: (r[nameCol]?.text ?? "").trim(),
					note: noteCol >= 0 ? (r[noteCol]?.text ?? "") : "",
					status: statusIdx >= 0 ? (r[statusIdx]?.text ?? "").trim().toLowerCase() : "",
				}))
				.filter(
					(r) =>
						r.name &&
						/^From\s+/i.test(r.note) &&
						r.status !== "gone" &&
						!allSqlNames.has(r.name.toLowerCase()) &&
						!allSqlNames.has(r.name.split(".").pop()!.toLowerCase()),
				);
			const droppedPreview = `${dropped.slice(0, 5).map((d) => d.name).join(", ")}${dropped.length > 5 ? ", …" : ""}`;
			const droppedMsg = dropped.length
				? ` (${dropped.length} listed ${dropped.length === 1 ? "object is" : "objects are"} no longer in schema SQL: ${dropped.slice(0, 3).map((d) => d.name).join(", ")}${dropped.length > 3 ? ", …" : ""})`
				: "";

			let doAppend = false;
			let doMarkGone = false;

			if (!discovered.length && !dropped.length) {
				notify(`${fileLabel} already matches every object found in schema SQL files.`);
				return;
			}
			if (!discovered.length && dropped.length > 0) {
				if (statusIdx < 0) {
					notify(`${fileLabel} already lists every object found in schema SQL files.${droppedMsg}`);
					return;
				}
				const picked = await choose(
					`No new SQL objects found in ${schemaRel}/, but ${dropped.length} previously synced ${dropped.length === 1 ? "object is" : "objects are"} no longer in schema SQL (${droppedPreview}). Mark ${dropped.length === 1 ? "it" : "them"} as “gone” in ${fileLabel}?`,
					["Mark as gone"],
				);
				if (picked !== "Mark as gone") return;
				doMarkGone = true;
			} else if (discovered.length > 0 && dropped.length > 0 && statusIdx >= 0) {
				const newPreview = `${discovered.slice(0, 5).map((d) => d.name).join(", ")}${discovered.length > 5 ? ", …" : ""}`;
				const picked = await choose(
					`Found ${discovered.length} new SQL ${discovered.length === 1 ? "object" : "objects"} (${newPreview}) and ${dropped.length} previously synced ${dropped.length === 1 ? "object" : "objects"} no longer in ${schemaRel}/ SQL (${droppedPreview}). How would you like to update ${fileLabel}?`,
					["Append & mark gone", "Append only", "Mark gone only"],
				);
				if (!picked) return;
				doAppend = picked === "Append & mark gone" || picked === "Append only";
				doMarkGone = picked === "Append & mark gone" || picked === "Mark gone only";
			} else {
				const newPreview = `${discovered.slice(0, 5).map((d) => d.name).join(", ")}${discovered.length > 5 ? ", …" : ""}`;
				const picked = await choose(
					`Found ${discovered.length} new SQL ${discovered.length === 1 ? "object" : "objects"} in ${schemaRel}/ (${newPreview}).${droppedMsg} Append rows to ${fileLabel}?`,
					["Append rows"],
				);
				if (picked !== "Append rows") return;
				doAppend = true;
			}

			const nl = model.getEOL();
			const textNow = model.getValue();
			const freshTable = parseCurrentCsv(textNow);
			const freshStatusIdx = columnOf(freshTable, "status");
			const rawEdits: { start: number; end: number; text: string }[] = [];
			let markedCount = 0;

			if (doMarkGone && freshStatusIdx >= 0) {
				const freshNameCol = (() => {
					for (const candidate of ["object", "name", "table"]) {
						const idx = columnOf(freshTable, candidate);
						if (idx >= 0) return idx;
					}
					return 0;
				})();
				const freshNoteCol = columnOf(freshTable, "note") >= 0 ? columnOf(freshTable, "note") : columnOf(freshTable, "notes");
				const droppedNameSet = new Set(dropped.map((d) => d.name.toLowerCase()));
				for (const r of freshTable.rows) {
					const name = (r[freshNameCol]?.text ?? "").trim().toLowerCase();
					const note = freshNoteCol >= 0 ? (r[freshNoteCol]?.text ?? "") : "";
					if (!name || !/^From\s+/i.test(note) || !droppedNameSet.has(name)) continue;
					const existingCell = r[freshStatusIdx];
					if (existingCell && existingCell.text.trim().toLowerCase() === "gone") continue;
					const last = r[r.length - 1]!;
					if (existingCell) {
						rawEdits.push({ start: existingCell.start, end: existingCell.end, text: csvCell("gone", freshTable.delimiter) });
					} else {
						rawEdits.push({
							start: last.end,
							end: last.end,
							text: freshTable.delimiter.repeat(freshStatusIdx - r.length + 1) + csvCell("gone", freshTable.delimiter),
						});
					}
					markedCount++;
				}
			}

			let appendedText = "";
			if (doAppend && discovered.length > 0) {
				const lines: string[] = [];
				for (const obj of discovered) {
					const vals = freshTable.header.map((_, i) => {
						if (i === nameCol) return obj.name;
						if (i === kindCol) return obj.kind;
						if (i === freshStatusIdx) return "found";
						if (i === noteCol) return obj.source;
						return "";
					});
					lines.push(csvRow(vals, freshTable.delimiter));
				}
				const prefix = textNow && !/\r?\n$/.test(textNow) ? nl : "";
				appendedText = `${prefix}${lines.join(nl)}${nl}`;
			}

			if (appendedText) {
				rawEdits.push({ start: textNow.length, end: textNow.length, text: appendedText });
			}

			if (!rawEdits.length) return;
			const ops = coalesceZeroWidthEdits(rawEdits)
				.sort((a, b) => b.start - a.start || b.end - a.end)
				.map((ed) => {
					const from = model.getPositionAt(ed.start);
					const to = model.getPositionAt(ed.end);
					return { range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: ed.text };
				});
			model.pushStackElement();
			model.pushEditOperations([], ops, () => null);
			model.pushStackElement();

			const parts: string[] = [];
			if (doAppend && discovered.length) parts.push(`added ${discovered.length} SQL ${discovered.length === 1 ? "object" : "objects"}`);
			if (markedCount) parts.push(`marked ${markedCount} as “gone”`);
			const summary = parts.join(" and ");
			notify(`${summary.charAt(0).toUpperCase()}${summary.slice(1)} in ${fileLabel} (Ctrl+Z to undo).${!doMarkGone ? droppedMsg : ""}`);
		} catch (e: any) {
			notify(`Could not sync schema SQL: ${e?.message ?? e}`, "error");
		}
	};

	/** Pastes a single cell or multi-row/multi-column TSV grid starting at the active cell via minimal per-cell edits (preserving ragged trailing cells and untouched quoting — ADR 0002). */
	const pasteGridAt = async (raw: string) => {
		const ac = activeCell();
		if (!model || !ac) return;
		const grid = parseClipboardGrid(raw);
		if (!grid.length) return;
		const cols = visibleColumns();
		const startVisCol = cols.indexOf(ac.column);
		if (startVisCol < 0) return;

		// Single-cell paste on an existing row uses `changeCell` directly (minimal edit).
		if (!ac.ghost && grid.length === 1 && grid[0]!.length === 1) {
			changeCell(ac.row, ac.column, grid[0]![0]!);
			return;
		}
		if (grid.length > 1 && hasActiveFilters()) {
			const curList = displayRows();
			const startVis = ac.ghost ? curList.length : curList.findIndex((r) => r.index === ac.row);
			const remainingVis = startVis >= 0 ? Math.max(0, curList.length - startVis) : 0;
			const willUpdate = Math.min(grid.length, remainingVis);
			const willAppend = Math.max(0, grid.length - willUpdate);
			const summary = [
				willUpdate ? `update ${willUpdate} visible ${willUpdate === 1 ? "row" : "rows"}` : "",
				willAppend ? `append ${willAppend} new ${willAppend === 1 ? "row" : "rows"}` : "",
			]
				.filter(Boolean)
				.join(" and ");
			const ok = await choose(`Filters are active. Pasting ${grid.length} rows will ${summary}.`, ["Paste here"]);
			if (ok !== "Paste here") return;
		}

		const curText = model.getValue();
		const t = parseCurrentCsv(curText);
		// Index the FULL filtered/sorted/display `displayRows()` array (not virtualized slice) so pasting past the viewport updates real rows instead of duplicating at EOF.
		const list = displayRows();
		const startVisRow = ac.ghost ? list.length : list.findIndex((r) => r.index === ac.row);
		if (startVisRow < 0) return;

		// Build strictly minimal cell-level edits so ragged trailing cells and untouched cell formatting stay verbatim.
		const cellEdits: OffsetTextEdit[] = [];
		const appended: string[][] = [];
		for (let rOff = 0; rOff < grid.length; rOff++) {
			const pasteRow = grid[rOff]!;
			const targetVis = startVisRow + rOff;
			if (targetVis < list.length) {
				const rowIdx = list[targetVis]!.index;
				const cells = t.rows[rowIdx];
				if (!cells?.length) continue;
				const maxColNeeded = Math.max(
					-1,
					...pasteRow.map((_, cOff) => cols[startVisCol + cOff] ?? -1),
				);
				// Collect missing trailing cells first so we know the resulting row width before serializing existing cells.
				const tailVals = new Map<number, string>();
				for (let cOff = 0; cOff < pasteRow.length; cOff++) {
					const targetCol = cols[startVisCol + cOff];
					if (targetCol === undefined) break;
					if (!cells[targetCol]) tailVals.set(targetCol, pasteRow[cOff]!);
				}
				const finalCellCount = tailVals.size && maxColNeeded >= cells.length ? maxColNeeded + 1 : cells.length;
				for (let cOff = 0; cOff < pasteRow.length; cOff++) {
					const targetCol = cols[startVisCol + cOff];
					if (targetCol === undefined) break;
					const val = pasteRow[cOff]!;
					const existing = cells[targetCol];
					if (existing && existing.text !== val) {
						cellEdits.push({
							start: existing.start,
							end: existing.end,
							text: serializeCellInRow(val, finalCellCount, t.delimiter),
						});
					}
				}
				if (tailVals.size && maxColNeeded >= cells.length) {
					const last = cells[cells.length - 1]!;
					let suffix = "";
					for (let c = cells.length; c <= maxColNeeded; c++) {
						suffix += t.delimiter + csvCell(tailVals.get(c) ?? "", t.delimiter);
					}
					cellEdits.push({ start: last.end, end: last.end, text: suffix });
				}
			} else {
				const vals = t.header.map(() => "");
				for (let cOff = 0; cOff < pasteRow.length; cOff++) {
					const targetCol = cols[startVisCol + cOff];
					if (targetCol === undefined) break;
					vals[targetCol] = pasteRow[cOff]!;
				}
				appended.push(vals);
			}
		}

		if (appended.length) {
			const nl = model.getEOL();
			const prefix = curText && !/\r?\n$/.test(curText) ? nl : "";
			const block =
				prefix +
				appended
					.map((vals) => (vals.length <= 1 ? serializeCellInRow(vals[0] ?? "", vals.length, t.delimiter) : csvRow(vals, t.delimiter)))
					.join(nl) +
				nl;
			cellEdits.push({ start: curText.length, end: curText.length, text: block });
		}
		const ops = coalesceZeroWidthEdits(cellEdits)
			.sort((a, b) => b.start - a.start || b.end - a.end)
			.map((ed) => {
				const from = model.getPositionAt(ed.start);
				const to = model.getPositionAt(ed.end);
				return { range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: ed.text };
			});
		if (!ops.length) return;
		model.pushStackElement();
		model.pushEditOperations([], ops, () => null);
		model.pushStackElement();
		if (appended.length === 1) pinRowIfFiltered(t.rows.length);
		notify(`Pasted ${grid.length} × ${Math.max(...grid.map((r) => r.length))} cells (Ctrl+Z to undo).`);
	};

	// --- In-table Find & Replace (Ctrl+F / Ctrl+H) --------------------------

	const findColumn = createMemo(() => {
		const ac = activeCell();
		if (ac && visibleColumns().includes(ac.column)) return ac.column;
		return visibleColumns()[0] ?? 0;
	});

	const findOptions = createMemo<CellFindOptions>(() => ({
		caseSensitive: findCaseSensitive(),
		wholeWord: findWholeWord(),
		regex: findRegex(),
	}));

	const compiledFindMatcher = createMemo(() => compileCellMatcher(findQuery(), findOptions()));

	const findRegexError = createMemo(() => {
		const compiled = compiledFindMatcher();
		return compiled && !compiled.ok ? compiled.error : null;
	});

	const captureCurrentSelectionScope = (): FindSelectionScope | null => {
		const range = cellRange();
		if (!range || !range.isMulti) return null;
		const list = displayRows();
		const cols = visibleColumns();
		const rowSet = new Set<number>();
		const colSet = new Set<number>();
		for (let vr = range.r1; vr <= range.r2; vr++) {
			const item = list[vr];
			if (item) rowSet.add(item.index);
		}
		for (let vc = range.c1; vc <= range.c2; vc++) {
			const col = cols[vc];
			if (col !== undefined) colSet.add(col);
		}
		if (!rowSet.size || !colSet.size) return null;
		return { rows: rowSet, cols: colSet, rowCount: rowSet.size, colCount: colSet.size };
	};

	const revealFirstMatchAfterFlush = () => {
		flush();
		const first = findMatches()[0];
		if (first) revealMatch(first);
	};

	const toggleFindInSelection = () => {
		if (findInSelection()) {
			setFindInSelection(false);
			setFindSelectionScope(null);
		} else {
			const scope = captureCurrentSelectionScope();
			if (!scope) {
				notify("Select multiple cells first to search in selection.");
				return;
			}
			setFindCurrentColOnly(false);
			setFindSelectionScope(scope);
			setFindInSelection(true);
		}
		setFindMatchIdx(0);
		revealFirstMatchAfterFlush();
	};

	const findMatches = createMemo(() => {
		if (!findOpen()) return [] as { row: number; visRow: number; column: number }[];
		const compiled = compiledFindMatcher();
		if (!compiled || !compiled.ok) return [];
		const re = compiled.regex;
		const scope = findInSelection() ? findSelectionScope() : null;
		if (findInSelection() && !scope) return [];
		const cols = findCurrentColOnly() ? [findColumn()] : visibleColumns();
		// Iterate in exact visual group order (including collapsed groups) so Next/Prev follows visual layout and auto-expands collapsed groups.
		const list = visualAllRows();
		const hits: { row: number; visRow: number; column: number }[] = [];
		for (let vi = 0; vi < list.length; vi++) {
			const item = list[vi]!;
			for (const col of cols) {
				if (!isCellInFindSelection(item.index, col, scope)) continue;
				const val = item.cells[col]?.text ?? "";
				re.lastIndex = 0;
				if (re.test(val)) {
					hits.push({ row: item.index, visRow: vi, column: col });
				}
			}
		}
		return hits;
	});

	const findMatchSet = createMemo(() => {
		const set = new Set<string>();
		for (const m of findMatches()) set.add(`${m.row}:${m.column}`);
		return set;
	});

	const currentMatchIdx = createMemo(() => {
		const m = findMatches();
		if (!m.length) return -1;
		return ((findMatchIdx() % m.length) + m.length) % m.length;
	});

	const activeFindMatch = createMemo(() => {
		const i = currentMatchIdx();
		return i >= 0 ? findMatches()[i]! : null;
	});

	const expandGroupForRow = (rowIdx: number) => {
		const gCol = groupByCol();
		if (gCol === null) return;
		const key = (table().rows[rowIdx]?.[gCol]?.text ?? "").trim().toLowerCase();
		if (collapsedGroups().has(key)) {
			setCollapsedGroups((prev) => {
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
		}
	};

	const revealMatch = (match: { row: number; visRow: number; column: number }) => {
		expandGroupForRow(match.row);
		pinRowIfFiltered(match.row);
		flush();
		const entryIdx = visEntryIdxForRow(match.row);
		ensureVisRowInWindow(entryIdx >= 0 ? entryIdx : match.visRow, "center");
		if (!findInSelection()) {
			setCellAnchor(null);
			setActiveCell({ ghost: false, row: match.row, column: match.column });
		}
		queueMicrotask(() => {
			const td = body?.querySelector<HTMLElement>(`tr[data-row="${match.row}"] > td[data-col="${match.column}"]`);
			if (td) {
				td.scrollIntoView({ block: "nearest", inline: "nearest" });
				nudgeCellOutFromHeader(td);
				return;
			}
			const latestEntryIdx = visEntryIdxForRow(match.row);
			ensureVisRowInWindow(latestEntryIdx >= 0 ? latestEntryIdx : match.visRow, "center");
			requestAnimationFrame(() => {
				const retry = body?.querySelector<HTMLElement>(`tr[data-row="${match.row}"] > td[data-col="${match.column}"]`);
				if (retry) {
					retry.scrollIntoView({ block: "nearest", inline: "nearest" });
					nudgeCellOutFromHeader(retry);
				}
			});
		});
	};

	const openFind = (withReplace: boolean) => {
		closeFilterMenu(false);
		setFindOpen(true);
		if (withReplace) setReplaceOpen(true);
		queueMicrotask(() => {
			if (withReplace && findQuery()) {
				replaceInputEl?.focus();
				replaceInputEl?.select();
			} else {
				findInputEl?.focus();
				findInputEl?.select();
			}
		});
	};

	const closeFind = () => {
		setFindOpen(false);
		setFindInSelection(false);
		setFindSelectionScope(null);
		const ac = activeCell();
		if (ac && !ac.ghost) focusCell(ac.row, ac.column);
		else if (ac?.ghost) focusGhostCell(ac.column);
		else {
			const rc = rovingCell();
			if (rc && !rc.ghost) focusCell(rc.row, rc.column);
			else if (rc?.ghost) focusGhostCell(rc.column);
			else rootEl?.focus();
		}
	};

	const findStep = (delta: 1 | -1) => {
		const m = findMatches();
		if (!m.length) return;
		const next = (((currentMatchIdx() + delta) % m.length) + m.length) % m.length;
		setFindMatchIdx(next);
		revealMatch(m[next]!);
	};

	const replaceCurrent = () => {
		const match = activeFindMatch();
		const query = findQuery();
		const compiled = compiledFindMatcher();
		if (!model || !match || !query || !compiled || !compiled.ok) return;
		const prevIdx = currentMatchIdx();
		const opts = findOptions();
		const rep = replaceText();
		const oldVal = table().rows[match.row]?.[match.column]?.text ?? "";
		const nextVal = replaceCellMatches(oldVal, query, rep, opts);
		if (nextVal !== oldVal) {
			pinRowIfFiltered(match.row);
			changeCell(match.row, match.column, nextVal);
		}
		flush();
		// If replacement still matches query (e.g. replacing "a" with "aa"), advance index to avoid sticking on the same cell.
		compiled.regex.lastIndex = 0;
		const stillMatches = compiled.regex.test(nextVal);
		const remaining = findMatches();
		if (!remaining.length) return;
		const nextIdx = stillMatches
			? (((prevIdx + 1) % remaining.length) + remaining.length) % remaining.length
			: Math.min(prevIdx, remaining.length - 1);
		setFindMatchIdx(nextIdx);
		revealMatch(remaining[nextIdx]!);
	};

	const replaceAll = () => {
		const query = findQuery();
		const compiled = compiledFindMatcher();
		if (!model || !query || !compiled || !compiled.ok) return;
		const opts = findOptions();
		const rep = replaceText();
		const t = parseCurrentCsv(model.getValue());
		const matches = findMatches();
		if (!matches.length) return;
		const updates: { row: number; col: number; value: string }[] = [];
		const seen = new Set<string>();
		for (const m of matches) {
			const key = `${m.row}:${m.column}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const oldVal = t.rows[m.row]?.[m.column]?.text ?? "";
			const nextVal = replaceCellMatches(oldVal, query, rep, opts);
			if (nextVal !== oldVal) {
				updates.push({ row: m.row, col: m.column, value: nextVal });
			}
		}
		const changed = applyCellUpdates(updates);
		if (!changed) return;
		setFindMatchIdx(0);
		notify(`Replaced in ${changed} ${changed === 1 ? "cell" : "cells"} (Ctrl+Z to undo).`);
	};

	/** Jumps to the next (`delta = 1`, F8) or previous (`delta = -1`, Shift+F8) inline validation issue. */
	const jumpToTableIssue = (delta: 1 | -1 = 1) => {
		const allIssues = tableIssues();
		if (!allIssues.length) return;
		const visList = visualAllRows();
		const visRowOrder = new Map<number, number>();
		for (let i = 0; i < visList.length; i++) visRowOrder.set(visList[i]!.index, i);
		const visIssues = allIssues.filter((issue) => visRowOrder.has(issue.row));
		const pool = visIssues.length > 0 ? visIssues : allIssues;
		const ac = activeCell();
		const activePos = ac && !ac.ghost ? { row: ac.row, column: ac.column } : null;
		const idx = nextTableIssueIndex(pool, activePos, delta, visIssues.length > 0 ? visRowOrder : undefined, colVisIndexMap());
		if (idx < 0) return;
		const target = pool[idx]!;
		if (hiddenCols().has(target.column)) showCol(target.column);
		expandGroupForRow(target.row);
		pinRowIfFiltered(target.row);
		flush();
		focusCell(target.row, target.column, { align: "center" });
	};

	// --- Reveal from Search / Outline / Nav history & liveBridge wiring -----

	const offsetAtLineCol = (raw: string, line: number, column = 1): { lineStart: number; lineEnd: number; offset: number } => {
		if (model) {
			const maxLine = Math.max(1, model.getLineCount());
			const ln = Math.max(1, Math.min(line, maxLine));
			const maxCol = model.getLineMaxColumn(ln);
			const col = Math.max(1, Math.min(column, maxCol));
			return {
				lineStart: model.getOffsetAt({ lineNumber: ln, column: 1 }),
				lineEnd: model.getOffsetAt({ lineNumber: ln, column: maxCol }),
				offset: model.getOffsetAt({ lineNumber: ln, column: col }),
			};
		}
		let curLine = 1;
		let idx = 0;
		while (curLine < line && idx < raw.length) {
			const nl = raw.indexOf("\n", idx);
			if (nl < 0) {
				idx = raw.length;
				break;
			}
			idx = nl + 1;
			curLine++;
		}
		const lineStart = idx;
		const nextNl = raw.indexOf("\n", lineStart);
		const lineEnd = nextNl < 0 ? raw.length : nextNl > lineStart && raw[nextNl - 1] === "\r" ? nextNl - 1 : nextNl;
		const offset = Math.min(lineEnd, lineStart + Math.max(0, column - 1));
		return { lineStart, lineEnd, offset };
	};

	const revealAt = (r: Reveal) => {
		const raw = model?.getValue() ?? text();
		const t = table();
		if (!t.rows.length) return;
		const { lineStart, lineEnd, offset } = offsetAtLineCol(raw, r.line, r.column ?? 1);
		let matchedRow = -1;
		for (let i = 0; i < t.rows.length; i++) {
			const cells = t.rows[i]!;
			if (!cells.length) continue;
			const rStart = cells[0]!.start;
			const rEnd = cells[cells.length - 1]!.end;
			if ((offset >= rStart && offset <= rEnd) || (rStart <= lineEnd && rEnd >= lineStart)) {
				matchedRow = i;
				break;
			}
		}
		if (matchedRow < 0) {
			if (offset < (t.rows[0]?.[0]?.start ?? 0)) {
				matchedRow = 0;
			} else {
				let nearest = -1;
				for (let i = 0; i < t.rows.length; i++) {
					const s = t.rows[i]?.[0]?.start;
					if (s !== undefined && s <= offset) nearest = i;
				}
				matchedRow = nearest >= 0 ? nearest : Math.max(0, Math.min(t.rows.length - 1, r.line - (hasHeader() ? 2 : 1)));
			}
		}
		let matchedCol = visibleColumns()[0] ?? 0;
		if (r.column !== undefined && r.column >= 1) {
			const rowCells = t.rows[matchedRow] ?? [];
			const foundInRow = rowCells.findIndex((c) => offset >= c.start && offset <= c.end);
			if (foundInRow >= 0 && foundInRow < t.header.length) {
				matchedCol = foundInRow;
			} else if (hasHeader() && t.header.length) {
				const foundInHeader = t.header.findIndex((c) => offset >= c.start && offset <= c.end);
				if (foundInHeader >= 0) matchedCol = foundInHeader;
			}
		}
		if (hiddenCols().has(matchedCol)) showCol(matchedCol);
		expandGroupForRow(matchedRow);
		pinRowIfFiltered(matchedRow);
		flush();
		const entryIdx = visEntryIdxForRow(matchedRow);
		ensureVisRowInWindow(entryIdx, "center");
		setCellAnchor(null);
		setActiveCell({ ghost: false, row: matchedRow, column: matchedCol });
		setRevealedRow(matchedRow);
		if (revealTimer !== undefined) clearTimeout(revealTimer);
		revealTimer = setTimeout(() => setRevealedRow((cur) => (cur === matchedRow ? null : cur)), 1800);
		queueMicrotask(() => {
			const tryFocus = () => {
				const td = body?.querySelector<HTMLElement>(`tr[data-row="${matchedRow}"] > td[data-col="${matchedCol}"]`);
				if (!td) return false;
				td.scrollIntoView({ block: "center", inline: "nearest" });
				nudgeCellOutFromHeader(td);
				td.focus();
				return true;
			};
			const latestEntryIdx = visEntryIdxForRow(matchedRow);
			const win = virtualWindow();
			if (!tryFocus() && win.virtual && scrollEl && latestEntryIdx >= 0) {
				const estTop = win.offsets[latestEntryIdx] ?? latestEntryIdx * DEFAULT_ROW_HEIGHT;
				const targetTop = Math.max(0, estTop - Math.floor((viewportH() || 600) / 2));
				scrollEl.scrollTop = targetTop;
				setScrollTop(targetTop);
				requestAnimationFrame(() => void tryFocus());
			}
		});
	};

	const jumpToColumn = (colIdx: number) => {
		if (colIdx < 0 || colIdx >= table().header.length) return;
		if (hiddenCols().has(colIdx)) showCol(colIdx);
		setCellAnchor(null);
		const curRow = current();
		const list = displayRows();
		const targetRow = curRow !== null && list.some((r) => r.index === curRow) ? curRow : (list[0]?.index ?? null);
		if (targetRow !== null) setActiveCell({ ghost: false, row: targetRow, column: colIdx });
		else setActiveCell({ ghost: true, column: colIdx });
		queueMicrotask(() => {
			const th = headRow?.querySelector<HTMLElement>(`th[data-col="${colIdx}"]`);
			if (th && scrollEl && !isFrozenCol(colIdx)) {
				const sRect = scrollEl.getBoundingClientRect();
				const thRect = th.getBoundingClientRect();
				const frozenWidth = (() => {
					const lastFrozenIdx = visibleFrozenCount() - 1;
					if (lastFrozenIdx < 0) return headRow?.querySelector<HTMLElement>("th.table-sel-col")?.getBoundingClientRect().width ?? 56;
					const lastTh = headRow?.querySelectorAll<HTMLElement>("th[data-col]")[lastFrozenIdx];
					return lastTh ? lastTh.getBoundingClientRect().right - sRect.left : 56;
				})();
				if (thRect.left < sRect.left + frozenWidth) {
					scrollEl.scrollLeft = Math.max(0, scrollEl.scrollLeft - (sRect.left + frozenWidth - thRect.left) - 12);
				} else if (thRect.right > sRect.right) {
					scrollEl.scrollLeft += thRect.right - sRect.right + 12;
				}
			}
			if (targetRow !== null) {
				const td = body?.querySelector<HTMLElement>(`tr[data-row="${targetRow}"] > td[data-col="${colIdx}"]`);
				if (td) {
					td.focus();
					nudgeCellOutFromHeader(td);
				}
			} else {
				th?.querySelector<HTMLElement>(".table-th-sort")?.focus();
			}
		});
	};

	const resolvedGroup = () => {
		if (props.group !== undefined) return props.group;
		const idx = state.groups.findIndex((g) => g.active === props.path);
		return idx >= 0 ? idx : state.activeGroup;
	};

	// Register Find/Replace and Outline column-jump bridges for MenuBar & Document Outline.
	createEffect(
		() => resolvedGroup(),
		(grp) => {
			const opener = (rep?: boolean) => openFind(Boolean(rep));
			const jumper = (colIdx: number) => jumpToColumn(colIdx);
			registerTableFind(grp, opener);
			registerTableColumnJump(grp, jumper);
			return () => {
				registerTableFind(grp, undefined);
				registerTableColumnJump(grp, undefined);
			};
		},
	);

	// Honor pending reveals on mount, live `revealSignal` updates from Search / Outline / Nav history, and scroll viewport observer.
	onSettled(() => {
		let disposed = false;
		let ro: ResizeObserver | undefined;
		if (scrollEl) {
			const el = scrollEl;
			setViewportH(el.clientHeight || 640);
			if (typeof ResizeObserver !== "undefined") {
				ro = new ResizeObserver(() => setViewportH(el.clientHeight || 640));
				ro.observe(el);
			}
		}
		const pending = takeReveal(props.path);
		if (pending) {
			queueMicrotask(() => {
				if (!disposed) revealAt(pending);
			});
		}
		const stopReveal = revealSignal.listen((path) => {
			if (canonical(path) !== canonical(props.path)) return;
			const r = takeReveal(path) ?? takeReveal(props.path);
			if (r) revealAt(r);
		});
		return () => {
			disposed = true;
			ro?.disconnect();
			stopReveal();
		};
	});

	// --- Inline status tally strip (`tally(table(), "status")`) --------------

	const exactStatusCol = createMemo(() => columnOf(table(), "status"));
	const statusTally = createMemo(() => tally(table(), "status"));
	const activeSingleStatusFilter = createMemo<string | null>(() => {
		const stCol = exactStatusCol();
		if (stCol < 0) return null;
		const f = colFilters().get(stCol);
		if (!f || f.text.trim() || !f.values || f.values.size !== 1) return null;
		return [...f.values][0] ?? null;
	});
	const toggleStatusTallyFilter = (statusKey: string) => {
		const stCol = exactStatusCol();
		if (stCol < 0) return;
		if (activeSingleStatusFilter() === statusKey) {
			setColumnFilter(stCol, undefined);
		} else {
			setColumnFilter(stCol, { text: "", values: new Set([statusKey]) });
		}
	};

	// --- Compact footer summary strip stats (range-aware) --------------------

	const footerStats = createMemo(() => {
		const list = rows();
		const total = table().rows.length;
		const selected = visibleSelectedRows().length;
		const cols = visibleColumns();
		const range = cellRange();
		if (range && range.isMulti) {
			const dRows = displayRows();
			let cellCount = 0;
			let nonEmpty = 0;
			const distinct = new Set<string>();
			let numericCount = 0;
			let sumVal = 0;
			for (let vr = range.r1; vr <= range.r2; vr++) {
				const item = dRows[vr];
				if (!item) continue;
				for (let vc = range.c1; vc <= range.c2; vc++) {
					const c = cols[vc];
					if (c === undefined) continue;
					cellCount++;
					const trimmed = (item.cells[c]?.text ?? "").trim();
					if (!trimmed) continue;
					nonEmpty++;
					distinct.add(trimmed);
					const num = parseNumericValue(trimmed);
					if (num !== null) {
						numericCount++;
						sumVal += num;
					}
				}
			}
			const fmtNum = (n: number) => (Math.round(n * 1e6) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
			return {
				shown: list.length,
				total,
				selected,
				isRange: true,
				colName: `${range.rowCount} × ${range.colCount} cells`,
				cellCount,
				nonEmpty,
				distinct: distinct.size,
				sum: numericCount >= 1 ? fmtNum(sumVal) : null,
				avg: numericCount >= 1 ? fmtNum(sumVal / numericCount) : null,
			};
		}
		const ac = activeCell();
		const col = ac && cols.includes(ac.column) ? ac.column : (cols[0] ?? -1);
		if (col < 0) {
			return {
				shown: list.length,
				total,
				selected,
				isRange: false,
				colName: "",
				cellCount: 0,
				nonEmpty: 0,
				distinct: 0,
				sum: null as string | null,
				avg: null as string | null,
			};
		}
		let nonEmpty = 0;
		const distinct = new Set<string>();
		let numericCount = 0;
		let sumVal = 0;
		for (const item of list) {
			const trimmed = (item.cells[col]?.text ?? "").trim();
			if (!trimmed) continue;
			nonEmpty++;
			distinct.add(trimmed);
			const num = parseNumericValue(trimmed);
			if (num !== null) {
				numericCount++;
				sumVal += num;
			}
		}
		const sum =
			numericCount >= 2
				? (Math.round(sumVal * 1e6) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })
				: null;
		return {
			shown: list.length,
			total,
			selected,
			isRange: false,
			colName: headerName(col) || `Column ${col + 1}`,
			cellCount: list.length,
			nonEmpty,
			distinct: distinct.size,
			sum,
			avg: null as string | null,
		};
	});

	const startNewRowAtEnd = () => {
		if (!table().header.length) return;
		setEditing({ ghost: true, column: visibleColumns()[0] ?? 0 });
		queueMicrotask(() => {
			foot?.scrollIntoView({ block: "nearest" });
		});
	};

	/** What the selected row is known by, for menus. */
	const currentName = () => {
		const row = current();
		return row === null ? "" : (table().rows[row]?.[0]?.text.trim() ?? "");
	};

	/** Returns whether `col` can move by `delta` (-1 left, +1 right) within its zone (frozen or unfrozen). */
	const canMoveColumn = (col: number, delta: -1 | 1): boolean => {
		const frozen = visibleFrozenCols();
		const frozenIdx = frozen.indexOf(col);
		if (frozenIdx >= 0) {
			const next = frozenIdx + delta;
			return next >= 0 && next < frozen.length;
		}
		const cols = visibleColumns();
		const visIdx = cols.indexOf(col);
		const next = visIdx + delta;
		return visIdx >= frozen.length && next >= frozen.length && next < cols.length;
	};

	/** Temporarily moves `col` to visual position `targetVisIdx` within its zone (frozen or unfrozen) without editing the file. */
	const moveColumnTo = (col: number, targetVisIdx: number) => {
		const count = table().header.length;
		if (count < 2) return;
		const visibleFrozen = visibleFrozenCols();
		const visFrozenIdx = visibleFrozen.indexOf(col);
		if (visFrozenIdx >= 0) {
			const clamped = Math.max(0, Math.min(targetVisIdx, visibleFrozen.length - 1));
			if (clamped === visFrozenIdx) return;
			const allFrozen = frozenCols();
			const fromF = allFrozen.indexOf(col);
			const toF = allFrozen.indexOf(visibleFrozen[clamped]!);
			if (fromF < 0 || toF < 0 || fromF === toF) return;
			const nextFrozen = moveColumnInList(allFrozen, fromF, toF);
			setFrozenCols(nextFrozen);
			const nextFull = fullColumnOrder(count, nextFrozen, colOrder().length ? colOrder() : undefined);
			setColOrder(isNaturalOrder(nextFull) ? [] : nextFull);
			return;
		}
		const full = colOrder().length ? pruneColumnOrder(colOrder(), count) : Array.from({ length: count }, (_, i) => i);
		const pinnedSet = new Set(frozenCols());
		const hiddenSet = hiddenCols();
		const unfrozenVisible = full.filter((c) => !pinnedSet.has(c) && !hiddenSet.has(c));
		const fromU = unfrozenVisible.indexOf(col);
		const toU = Math.max(0, Math.min(targetVisIdx - visibleFrozen.length, unfrozenVisible.length - 1));
		if (fromU < 0 || fromU === toU) return;
		const nextUnfrozen = moveColumnInList(unfrozenVisible, fromU, toU);
		let u = 0;
		const nextBase = full.map((c) => (pinnedSet.has(c) || hiddenSet.has(c) ? c : nextUnfrozen[u++]!));
		setColOrder(isNaturalOrder(nextBase) ? [] : nextBase);
	};

	const moveColumnBy = (col: number, delta: -1 | 1) => {
		const visIdx = visibleColumns().indexOf(col);
		if (visIdx < 0) return;
		moveColumnTo(col, visIdx + delta);
	};

	/** Hides `col` visually without touching the CSV (always keeping at least one visible column). */
	const hideCol = (col: number) => {
		const count = table().header.length;
		const next = hideColumn(hiddenCols(), col, count);
		if (next.size === hiddenCols().size) return;
		const nextFrozen = isFrozenCol(col) ? frozenCols().filter((c) => c !== col) : frozenCols();
		if (isFrozenCol(col)) setFrozenCols(nextFrozen);
		if (filterMenu()?.column === col) closeFilterMenu(false);
		const ed = editing();
		if (ed && ed.column === col) setEditing(null);
		setHiddenCols(next);
		const ac = activeCell();
		if (ac && ac.column === col) {
			const fallback = visualColumnOrder(count, nextFrozen, colOrder().length ? colOrder() : undefined, next)[0];
			if (fallback === undefined) setActiveCell(null);
			else setActiveCell(ac.ghost ? { ghost: true, column: fallback } : { ghost: false, row: ac.row, column: fallback });
		}
	};

	const showCol = (col: number) => setHiddenCols((prev) => showColumn(prev, col));
	const showAllCols = () => setHiddenCols(new Set<number>());

	const openHiddenColumnsMenu = async (anchor: HTMLElement) => {
		closeFilterMenu(false);
		const hiddenList = [...hiddenCols()].sort((a, b) => a - b);
		if (!hiddenList.length) return;
		const rect = anchor.getBoundingClientRect();
		const at = { x: rect.left, y: rect.bottom + 4 };
		const items: RowMenuEntry[] = [
			...hiddenList.map((col) => ({
				label: `Show “${shortLabel(headerName(col) || `Column ${col + 1}`)}”`,
				value: `show:${col}`,
			})),
			...(hiddenList.length > 1 ? ["separator" as const, { label: "Show all columns", value: "show-all" }] : []),
		];
		const picked = await chooseFromMenu("Hidden columns", items, at);
		if (!picked) return;
		if (picked === "show-all") showAllCols();
		else if (picked.startsWith("show:")) showCol(Number(picked.slice(5)));
	};

	/** Measures the full untruncated width of `col` (header + mounted cells + up to 500 sampled rows across `rows()`) and sets its width to fit. */
	const autoFitColumn = (col: number) => {
		let needed = MIN_COL_WIDTH;
		const th = headRow?.querySelector<HTMLElement>(`th[data-col="${col}"]`);
		if (th) {
			const label = th.querySelector<HTMLElement>(".table-th-label");
			const pin = th.querySelector<HTMLElement>(".table-th-pin");
			const filterBtn = th.querySelector<HTMLElement>(".table-th-filter");
			const labelW = label ? Math.ceil(label.scrollWidth) : 0;
			const isSortedHere = order().some((s) => s.column === col);
			const extras =
				(pin ? pin.getBoundingClientRect().width : 0) +
				(filterBtn ? filterBtn.getBoundingClientRect().width : 0) +
				(isSortedHere ? (order().length > 1 ? 34 : 22) : 0) +
				32;
			needed = Math.max(needed, labelW + extras);
		}
		let cellFont = "13px ui-monospace, monospace";
		let cellPadX = 26;
		if (body) {
			const range = document.createRange();
			const cells = body.querySelectorAll<HTMLElement>(`td[data-col="${col}"]`);
			let fontSampled = false;
			for (const td of cells) {
				const cs = getComputedStyle(td);
				const padX =
					Number.parseFloat(cs.paddingLeft || "0") +
					Number.parseFloat(cs.paddingRight || "0") +
					Number.parseFloat(cs.borderRightWidth || "1");
				if (!fontSampled) {
					fontSampled = true;
					cellPadX = padX;
					cellFont = cs.font || `${cs.fontWeight || "400"} ${cs.fontSize || "13px"} ${cs.fontFamily || "ui-monospace, monospace"}`;
				}
				let contentW = 0;
				if (td.childNodes.length) {
					range.selectNodeContents(td);
					contentW = Math.ceil(range.getBoundingClientRect().width);
				}
				const overflowW = td.scrollWidth > td.clientWidth ? td.scrollWidth : 0;
				needed = Math.max(needed, Math.ceil(contentW + padX) + 8, overflowW + 8);
			}
		} else if (tableEl) {
			const cs = getComputedStyle(tableEl);
			cellFont = cs.font || `${cs.fontSize || "13px"} ${cs.fontFamily || "ui-monospace, monospace"}`;
		}
		// Sample across ALL rows in `rows()` (capped at 500) so off-screen rows in virtualized tables are measured accurately.
		const sampled = sampleRowsForAutoFit(rows(), AUTOFIT_SAMPLE_LIMIT);
		const extraAllowance = (columnRule(col) ? 24 : 0) + (codeCheck()?.column === col ? 48 : 0) + 12;
		const topLongest: string[] = [];
		let minTopLen = 0;
		for (const item of sampled) {
			const raw = item.cells[col]?.text ?? "";
			if (!raw) continue;
			const lines = raw.includes("\n") ? raw.split(/\r?\n/) : [raw];
			for (const line of lines) {
				if (line.length <= minTopLen && topLongest.length >= 24) continue;
				topLongest.push(line);
				if (topLongest.length > 32) {
					topLongest.sort((a, b) => b.length - a.length);
					topLongest.length = 24;
					minTopLen = topLongest[topLongest.length - 1]!.length;
				}
			}
		}
		for (const sampleText of topLongest) {
			const measured = Math.ceil(measureTextPx(sampleText, cellFont) + cellPadX + extraAllowance);
			if (measured > needed) needed = measured;
		}
		const clamped = Math.max(MIN_COL_WIDTH, Math.min(MAX_AUTOFIT_WIDTH, needed));
		setColWidths((prev) => ({ ...prev, [col]: clamped }));
	};

	/** Drag-resizes a single column via its right-edge handle without affecting other columns or triggering sort/reorder. */
	const onResizerPointerDown = (e: PointerEvent, col: number) => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		closeFilterMenu(false);
		const th = (e.currentTarget as HTMLElement).closest("th");
		if (!th) return;
		const startX = e.clientX;
		const startW = th.getBoundingClientRect().width;
		let moved = false;
		setResizingCol(col);

		const cleanup = () => {
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointercancel", onUp, true);
			cancelActiveResize = null;
			setResizingCol(null);
		};

		const onMove = (ev: PointerEvent) => {
			ev.preventDefault();
			if (Math.abs(ev.clientX - startX) >= 2) moved = true;
			const nextW = Math.max(MIN_COL_WIDTH, Math.round(startW + (ev.clientX - startX)));
			setColWidths((prev) => (prev[col] === nextW ? prev : { ...prev, [col]: nextW }));
		};

		const onUp = () => {
			cleanup();
			if (moved) {
				suppressSortClick = true;
				queueMicrotask(() => (suppressSortClick = false));
			}
		};

		cancelActiveResize?.();
		cancelActiveResize = cleanup;
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointercancel", onUp, true);
	};

	/** Writes the current full column order (preserving hidden columns) into the CSV as one undoable edit, remapping UI state. */
	const applyColumnOrderToFile = () => {
		if (!model) return;
		const applied = fullColumns();
		const nextText = reorderCsvColumns(model.getValue(), table(), applied);
		if (!nextText) {
			setColOrder([]);
			return;
		}
		closeFilterMenu(false);
		setEditing(null);
		clearFindSelectionScope();
		clearRowHeights();
		const beforeAlt = model.getAlternativeVersionId();
		const beforeSnap = captureColUi();

		const fullRange = model.getFullModelRange();
		model.pushStackElement();
		model.pushEditOperations([], [{ range: fullRange, text: nextText }], () => null);
		model.pushStackElement();

		// Remap active filters, sort, frozen/hidden columns, widths, selection, and code-check annotations to the new indices.
		const nextFilters = new Map<number, ColumnFilter>();
		for (const [oldCol, f] of colFilters()) {
			const mapped = remapColumnIndex(oldCol, applied);
			if (mapped >= 0) nextFilters.set(mapped, f);
		}
		setColFilters(nextFilters);

		const curSort = order();
		const nextSort = curSort.length ? remapSortSpecs(curSort, (oldCol) => remapColumnIndex(oldCol, applied)) : [];
		if (curSort.length) {
			setOrder(nextSort);
		}

		const nextFrozen = frozenCols()
			.map((oldCol) => remapColumnIndex(oldCol, applied))
			.filter((c) => c >= 0);
		setFrozenCols(nextFrozen);

		const nextHidden = new Set<number>();
		for (const oldCol of hiddenCols()) {
			const mapped = remapColumnIndex(oldCol, applied);
			if (mapped >= 0) nextHidden.add(mapped);
		}
		setHiddenCols(nextHidden);

		const nextWidths: Record<number, number> = {};
		for (const [k, w] of Object.entries(colWidths())) {
			const mapped = remapColumnIndex(Number(k), applied);
			if (mapped >= 0) nextWidths[mapped] = w;
		}
		setColWidths(nextWidths);

		const ac = activeCell();
		if (ac) {
			const mapped = remapColumnIndex(ac.column, applied);
			if (mapped >= 0) setActiveCell(ac.ghost ? { ghost: true, column: mapped } : { ghost: false, row: ac.row, column: mapped });
		}
		const anc = cellAnchor();
		if (anc) {
			const mapped = remapColumnIndex(anc.column, applied);
			setCellAnchor(mapped >= 0 ? { row: anc.row, column: mapped } : null);
		}
		const curGrp = groupByCol();
		const nextGrp = curGrp !== null ? (remapColumnIndex(curGrp, applied) >= 0 ? remapColumnIndex(curGrp, applied) : null) : null;
		if (curGrp !== null) {
			setGroupByCol(nextGrp);
		}

		const curCheck = codeCheck();
		let nextCheck: CodeCheckResult | null = curCheck;
		if (curCheck) {
			const mapped = remapColumnIndex(curCheck.column, applied);
			nextCheck = mapped >= 0 ? { ...curCheck, column: mapped } : null;
			setCodeCheck(nextCheck);
		}

		setColOrder([]);
		const afterAlt = model.getAlternativeVersionId();
		if (afterAlt !== beforeAlt) {
			const afterSnap: ColumnUiSnapshot = {
				colFilters: new Map(nextFilters),
				order: nextSort.map((s) => ({ ...s })),
				frozenCols: [...nextFrozen],
				hiddenCols: new Set(nextHidden),
				colOrder: [],
				colWidths: { ...nextWidths },
				codeCheck: nextCheck ? { ...nextCheck } : null,
				groupByCol: nextGrp,
			};
			colSnapshots.set(colSnapshotTransitionKey(afterAlt, beforeAlt), beforeSnap);
			colSnapshots.set(colSnapshotTransitionKey(beforeAlt, afterAlt), afterSnap);
		}
		notify("Saved column order to file (Ctrl+Z to undo).");
		queueMicrotask(() => rootEl?.focus());
	};

	/** Pointer-based drag-and-drop on column headers (5px threshold so normal clicks sort without interference). */
	const onHeaderPointerDown = (e: PointerEvent, col: number, visIdx: number) => {
		if (e.button !== 0) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest(".table-th-pin, .table-th-filter, .table-col-resizer")) return;
		const frozenCount = visibleFrozenCount();
		const isFrozen = visIdx < frozenCount;
		const minVis = isFrozen ? 0 : frozenCount;
		const maxVis = isFrozen ? frozenCount - 1 : visibleColumns().length - 1;
		if (maxVis <= minVis) return;

		const startX = e.clientX;
		const label = headerName(col) || `Column ${col + 1}`;
		let dragging = false;
		let latestColDrag: ColDrag | null = null;

		const computeDrop = (clientX: number): { dropVis: number; side: "before" | "after" } => {
			if (!headRow) return { dropVis: visIdx, side: "before" };
			const dataThs = headRow.querySelectorAll<HTMLElement>("th[data-col]");
			let hoverVis = visIdx;
			for (let i = minVis; i <= maxVis; i++) {
				const th = dataThs[i];
				if (!th) continue;
				const rect = th.getBoundingClientRect();
				if (i === minVis && clientX <= rect.right) {
					hoverVis = minVis;
					break;
				}
				if (i === maxVis && clientX >= rect.left) {
					hoverVis = maxVis;
					break;
				}
				if (clientX >= rect.left && clientX <= rect.right) {
					hoverVis = i;
					break;
				}
			}
			return { dropVis: hoverVis, side: hoverVis < visIdx ? "before" : "after" };
		};

		const cleanup = () => {
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointercancel", onCancel, true);
			window.removeEventListener("keydown", onKey, true);
			cancelActiveDrag = null;
		};

		const onMove = (ev: PointerEvent) => {
			if (!dragging) {
				if (Math.abs(ev.clientX - startX) < 5) return;
				dragging = true;
				closeFilterMenu(false);
			}
			ev.preventDefault();
			// Gently scroll horizontally when dragging near the left/right edges of .table-scroll.
			if (scrollEl && !isFrozen) {
				const sRect = scrollEl.getBoundingClientRect();
				if (ev.clientX > sRect.right - 28) scrollEl.scrollLeft += 14;
				else if (ev.clientX < sRect.left + 28) scrollEl.scrollLeft -= 14;
			}
			const { dropVis, side } = computeDrop(ev.clientX);
			latestColDrag = { col, label, fromVis: visIdx, dropVis, side, x: ev.clientX, y: ev.clientY };
			setColDrag(latestColDrag);
		};

		const onUp = () => {
			const drag = latestColDrag;
			cleanup();
			if (dragging) {
				suppressSortClick = true;
				queueMicrotask(() => (suppressSortClick = false));
				if (drag && drag.dropVis !== drag.fromVis) moveColumnTo(drag.col, drag.dropVis);
				setColDrag(null);
			}
		};

		const onCancel = () => {
			cleanup();
			if (dragging) setColDrag(null);
		};

		const onKey = (ev: KeyboardEvent) => {
			if (ev.key === "Escape" && dragging) {
				ev.preventDefault();
				ev.stopPropagation();
				onCancel();
			}
		};

		cancelActiveDrag?.();
		cancelActiveDrag = onCancel;
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointercancel", onCancel, true);
		window.addEventListener("keydown", onKey, true);
	};

	const pageStepRows = () => {
		const vh = scrollEl?.clientHeight || viewportH() || 640;
		const headH = headRow?.getBoundingClientRect().height ?? 32;
		return Math.max(1, Math.floor((vh - headH) / DEFAULT_ROW_HEIGHT) - 1);
	};

	/** Arrow / Shift+Arrow / Page / Home / End / Alt+Arrow keys index `displayRows()` across virtualized windows; ContextMenu / Shift+F10 opens cell actions (ADR 0010). */
	const onCellKey = (e: KeyboardEvent, row: number, column: number) => {
		if (editing()) return;
		const targetEl = e.target as HTMLElement | null;
		const onInnerButton = targetEl !== e.currentTarget && Boolean(targetEl?.closest("button"));
		if (isContextMenuKey(e)) {
			e.preventDefault();
			e.stopPropagation();
			lastKeyMenuAt = performance.now();
			void openCellContextMenu(pointUnder(e.currentTarget as HTMLElement), row, column);
			return;
		}
		if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
			e.preventDefault();
			moveColumnBy(column, e.key === "ArrowLeft" ? -1 : 1);
			focusCell(row, column);
			return;
		}
		if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
			e.preventDefault();
			moveRowTo(row, row + (e.key === "ArrowUp" ? -1 : 1), column);
			return;
		}
		if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "Enter") {
			if (openCellLink(column, table().rows[row]?.[column]?.text ?? "")) {
				e.preventDefault();
				return;
			}
		}
		if (onInnerButton && (e.key === "Enter" || e.key === " ")) return;
		if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === " ") {
			e.preventDefault();
			toggleRowSelect(row, false);
			return;
		}
		if (e.key === "Enter" || e.key === "F2") {
			e.preventDefault();
			if (!isCellInRange(row, column)) setCellAnchor(null);
			setEditing({ ghost: false, row, column });
			return;
		}
		if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			const range = cellRange();
			if (range && range.isMulti) clearCellRange(range);
			else changeCell(row, column, "");
			return;
		}
		const cols = visibleColumns();
		const visCol = cols.indexOf(column);
		const list = displayRows();
		const visRow = list.findIndex((r) => r.index === row);
		const extendRange = () => {
			if (!cellAnchor()) setCellAnchor({ row, column });
		};

		if (e.key === "ArrowRight" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (visCol >= 0 && visCol + 1 < cols.length) {
				if (e.shiftKey) extendRange();
				focusCell(row, cols[visCol + 1]!, { keepAnchor: e.shiftKey });
			}
			return;
		}
		if (e.key === "ArrowLeft" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (visCol > 0) {
				if (e.shiftKey) extendRange();
				focusCell(row, cols[visCol - 1]!, { keepAnchor: e.shiftKey });
			}
			return;
		}
		if (e.key === "ArrowDown" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (visRow >= 0 && visRow + 1 < list.length) {
				if (e.shiftKey) extendRange();
				navigateToVisRow(visRow + 1, column, { keepAnchor: e.shiftKey });
			} else if (!e.shiftKey) {
				focusGhostCell(column);
			}
			return;
		}
		if (e.key === "ArrowUp" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (visRow > 0) {
				if (e.shiftKey) extendRange();
				navigateToVisRow(visRow - 1, column, { keepAnchor: e.shiftKey });
			}
			return;
		}
		if (e.key === "PageDown" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (visRow >= 0 && list.length > 0) {
				if (visRow >= list.length - 1 && !e.shiftKey) focusGhostCell(column);
				else {
					if (e.shiftKey) extendRange();
					navigateToVisRow(Math.min(list.length - 1, visRow + pageStepRows()), column, { keepAnchor: e.shiftKey });
				}
			}
			return;
		}
		if (e.key === "PageUp" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (visRow > 0) {
				if (e.shiftKey) extendRange();
				navigateToVisRow(Math.max(0, visRow - pageStepRows()), column, { keepAnchor: e.shiftKey });
			}
			return;
		}
		if (e.key === "Home" && !e.altKey) {
			e.preventDefault();
			const firstCol = cols[0] ?? column;
			if (e.shiftKey) extendRange();
			if ((e.ctrlKey || e.metaKey) && list.length > 0) navigateToVisRow(0, firstCol, { keepAnchor: e.shiftKey });
			else focusCell(row, firstCol, { keepAnchor: e.shiftKey });
			return;
		}
		if (e.key === "End" && !e.altKey) {
			e.preventDefault();
			const lastCol = cols[cols.length - 1] ?? column;
			if (e.shiftKey) extendRange();
			if ((e.ctrlKey || e.metaKey) && list.length > 0) navigateToVisRow(list.length - 1, lastCol, { keepAnchor: e.shiftKey });
			else focusCell(row, lastCol, { keepAnchor: e.shiftKey });
			return;
		}
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (!isCellInRange(row, column)) setCellAnchor(null);
			setEditing({ ghost: false, row, column, seed: e.key });
		}
	};

	const onGhostKey = (e: KeyboardEvent, column: number) => {
		if (editing()) return;
		if (isContextMenuKey(e)) {
			e.preventDefault();
			e.stopPropagation();
			lastKeyMenuAt = performance.now();
			void openGhostContextMenu(pointUnder(e.currentTarget as HTMLElement), column);
			return;
		}
		if (e.key === "Enter" || e.key === "F2") return e.preventDefault(), setEditing({ ghost: true, column });
		const cols = visibleColumns();
		const visCol = cols.indexOf(column);
		const list = displayRows();
		if (e.key === "ArrowRight" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (visCol >= 0 && visCol + 1 < cols.length) focusGhostCell(cols[visCol + 1]!);
			return;
		}
		if (e.key === "ArrowLeft" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (visCol > 0) focusGhostCell(cols[visCol - 1]!);
			return;
		}
		if (e.key === "ArrowUp" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (list.length > 0) navigateToVisRow(list.length - 1, column);
			return;
		}
		if (e.key === "PageUp" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (list.length > 0) navigateToVisRow(Math.max(0, list.length - pageStepRows()), column);
			return;
		}
		if (e.key === "Home" && !e.altKey) {
			e.preventDefault();
			const firstCol = cols[0] ?? column;
			if ((e.ctrlKey || e.metaKey) && list.length > 0) navigateToVisRow(0, firstCol);
			else focusGhostCell(firstCol);
			return;
		}
		if (e.key === "End" && !e.altKey) {
			e.preventDefault();
			focusGhostCell(cols[cols.length - 1] ?? column);
			return;
		}
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			setEditing({ ghost: true, column, seed: e.key });
		}
	};

	const sortBy = (column: number, shiftKey = false) => setOrder((by) => toggleSortSpec(by, column, shiftKey));

	// --- Right-click & Keyboard Context Menus -------------------------------

	const openCellContextMenu = async (at: { x: number; y: number }, row: number, column: number) => {
		closeFilterMenu(false);
		const curRange = cellRange();
		const inMultiRange = Boolean(curRange && curRange.isMulti && isCellInRange(row, column));
		if (!inMultiRange) {
			setCellAnchor(null);
			setActiveCell({ ghost: false, row, column });
		}
		const cells = table().rows[row];
		if (!cells) return;
		const rawVal = (cells[column]?.text ?? "").trim();
		const col = headerName(column) || `Column ${column + 1}`;
		const hasRule = Boolean(columnRule(column));
		const frozenHere = isFrozenCol(column);
		const schemaDoc = schemaDocForCell(column, rawVal);
		const fileLink = !schemaDoc ? fileLinkForCell(column, rawVal) : null;
		const cellUrl = !schemaDoc && !fileLink ? extractFirstHttpUrl(rawVal) : null;
		const cellTicket = !schemaDoc && !fileLink && !cellUrl ? firstTicketForCell(column, rawVal) : undefined;
		const totalRows = table().rows.length;
		const visRow = rowVisIndexMap().get(row) ?? row;
		const visCol = colVisIndexMap().get(column) ?? 0;

		const codeCheckEntries: RowMenuEntry[] = [
			...(rawVal
				? [
						{ label: `Find “${shortLabel(rawVal)}” in code`, value: "find-code" },
						{ label: `Check “${shortLabel(rawVal)}” in code`, value: "check-cell" },
					]
				: []),
			{ label: `Check “${shortLabel(col)}” in code…`, value: "check-col" },
		];

		const items: RowMenuEntry[] = [
			...(schemaDoc ? [{ label: `Open schema doc “${shortLabel(schemaDoc.name)}”`, value: "open-schema", keys: "Ctrl+Enter" }] : []),
			...(fileLink ? [{ label: `Open file “${shortLabel(rawVal)}”`, value: "open-file", keys: "Ctrl+Enter" }] : []),
			...(cellUrl ? [{ label: `Open URL “${shortLabel(cellUrl, 30)}”`, value: "open-url", keys: "Ctrl+Enter" }] : []),
			...(cellTicket ? [{ label: `Open ticket “${cellTicket.ticket}”`, value: "open-ticket", keys: "Ctrl+Enter" }] : []),
			"separator",
			{ label: "Edit cell", value: "edit", keys: "Enter" },
			...(inMultiRange && curRange
				? [
						{ label: `Copy ${curRange.rowCount} × ${curRange.colCount} cells (TSV)`, value: "copy-range", keys: "Ctrl+C" },
						{ label: "Copy as Markdown table", value: "copy-range-md" },
						{ label: "Fill down selection", value: "fill-down", keys: "Ctrl+D" },
						{ label: "Fill right selection", value: "fill-right", keys: "Ctrl+R" },
						{ label: "Clear selected cells", value: "clear-range", keys: "Delete" },
					]
				: [
						...(rawVal ? [{ label: "Copy cell", value: "copy-cell", keys: "Ctrl+C" }] : []),
						{ label: "Copy as Markdown table", value: "copy-row-md" },
						...(visRow > 0 ? [{ label: "Fill from cell above", value: "fill-down", keys: "Ctrl+D" }] : []),
						...(visCol > 0 ? [{ label: "Fill from cell to left", value: "fill-right", keys: "Ctrl+R" }] : []),
					]),
			{ label: "Copy row", value: "copy-row" },
			"separator",
			{
				label: rawVal ? `Filter by “${shortLabel(rawVal)}”` : `Filter by empty in “${shortLabel(col)}”`,
				value: "filter-val",
			},
			...submenuOrInline("Code check", codeCheckEntries),
			"separator",
			{
				label: "Row",
				children: [
					{ label: "Insert row above", value: "insert-above" },
					{ label: "Insert row below", value: "insert-below" },
					{ label: "Duplicate row", value: "duplicate" },
					"separator",
					{ label: "Move row up", value: "move-row-up", keys: "Alt+Up", disabled: row <= 0 },
					{ label: "Move row down", value: "move-row-down", keys: "Alt+Down", disabled: row >= totalRows - 1 },
				],
			},
			{
				label: `Column “${shortLabel(col)}”`,
				children: [
					{ label: frozenHere ? `Unfreeze “${shortLabel(col)}”` : `Freeze “${shortLabel(col)}” to left`, value: "freeze" },
					...(visibleColumns().length > 1 ? [{ label: `Hide “${shortLabel(col)}”`, value: "hide" }] : []),
					{ label: groupByCol() === column ? "Clear grouping" : `Group by “${shortLabel(col)}”`, value: "group-by", checked: groupByCol() === column },
					"separator",
					{ label: hasRule ? `Configure “${shortLabel(col)}” badges…` : `Format “${shortLabel(col)}” as badges…`, value: "badges" },
				],
			},
			"separator",
			{ label: "Delete row", value: "delete", danger: true },
		];

		const picked = await chooseFromMenu(`Actions for ${col}, row ${row + 1}`, items, at);
		if (!picked) return;
		if (picked === "open-schema" && schemaDoc) {
			void openFile(schemaDoc.path);
		} else if (picked === "open-file" && fileLink) {
			void openFile(fileLink.path);
		} else if (picked === "open-url" && cellUrl) {
			openExternalUrl(cellUrl);
		} else if (picked === "open-ticket" && cellTicket) {
			void openFile(cellTicket.path);
		} else if (picked === "edit") {
			if (!inMultiRange) setCellAnchor(null);
			setEditing({ ghost: false, row, column });
		} else if (picked === "copy-range" && curRange) {
			await copyCellRangeAsTsv(curRange);
		} else if (picked === "copy-range-md" && curRange) {
			await copyCellRangeAsMarkdown(curRange);
		} else if (picked === "copy-row-md") {
			await copyRowAsMarkdown(row);
		} else if (picked === "fill-down") {
			fillDownSelection();
		} else if (picked === "fill-right") {
			fillRightSelection();
		} else if (picked === "clear-range" && curRange) {
			clearCellRange(curRange);
		} else if (picked === "copy-cell") {
			await copyText(formatSingleCellForClipboard(cells[column]?.text ?? ""), "Copied cell value.");
		} else if (picked === "copy-row") {
			const raw = model ? rawRowText(model.getValue(), table(), row) : null;
			await copyText(raw ?? csvRow(cells.map((c) => c.text), table().delimiter), "Copied row.");
		} else if (picked === "filter-val") {
			setColumnFilter(column, { text: "", values: new Set([rawVal.toLowerCase()]) });
		} else if (picked === "find-code") {
			findValueInCode(rawVal);
		} else if (picked === "check-cell") {
			void runCodeCheck(
				{
					column,
					rowScope: "selected",
					fileScope: lastCheckSpec().fileScope ?? "code",
					include: lastCheckSpec().include ?? "",
					exclude: lastCheckSpec().exclude ?? defaultExclude(),
					wholeWord: lastCheckSpec().wholeWord ?? true,
					caseSensitive: lastCheckSpec().caseSensitive ?? false,
					splitLists: false,
				},
				true,
				row,
			);
		} else if (picked === "check-col") {
			setCheckDialog({ open: true, column, rowScope: hasActiveFilters() ? "filtered" : "all" });
		} else if (picked === "insert-above") {
			insertRowAt(row, "above");
		} else if (picked === "insert-below") {
			insertRowAt(row, "below");
		} else if (picked === "duplicate") {
			duplicateRowAt(row);
		} else if (picked === "move-row-up") {
			moveRowTo(row, row - 1, column);
		} else if (picked === "move-row-down") {
			moveRowTo(row, row + 1, column);
		} else if (picked === "delete") {
			deleteRowAt(row);
		} else if (picked === "freeze") {
			toggleFreeze(column);
		} else if (picked === "hide") {
			hideCol(column);
		} else if (picked === "group-by") {
			toggleGroupByColumn(column);
		} else if (picked === "badges") {
			setFormatDialog({ open: true, initialColumn: headerName(column) });
		}
	};

	const onCellContextMenu = async (e: MouseEvent, row: number, column: number) => {
		const target = e.target instanceof Element ? e.target : null;
		if (target?.closest("input, textarea")) return; // Let global text-box menu handle active editor inputs.
		e.preventDefault();
		e.stopPropagation();
		if (!e.clientX && !e.clientY && performance.now() - lastKeyMenuAt < 150) return;
		await openCellContextMenu(menuPoint(e, e.currentTarget as HTMLElement), row, column);
	};

	const openHeaderContextMenu = async (at: { x: number; y: number }, thEl: HTMLElement, column: number) => {
		closeFilterMenu(false);
		const col = headerName(column) || `Column ${column + 1}`;
		const hasRule = Boolean(columnRule(column));
		const curSorts = order();
		const sortIdx = curSorts.findIndex((s) => s.column === column);
		const sortEntry = sortIdx >= 0 ? curSorts[sortIdx]! : null;
		const filteredHere = isColFiltered(column);
		const frozenHere = isFrozenCol(column);
		const groupedHere = groupByCol() === column;

		const colLayoutEntries: RowMenuEntry[] = [
			{ label: frozenHere ? `Unfreeze “${shortLabel(col)}”` : `Freeze “${shortLabel(col)}” to left`, value: "freeze" },
			...(frozenCols().length > 1 || (frozenCols().length === 1 && !frozenHere)
				? [{ label: "Unfreeze all columns", value: "unfreeze-all" }]
				: []),
			"separator",
			...(visibleColumns().length > 1 ? [{ label: `Hide “${shortLabel(col)}”`, value: "hide" }] : []),
			...(hiddenCols().size > 0 ? [{ label: `Show all hidden columns (${hiddenCols().size})`, value: "show-all" }] : []),
			"separator",
			...(canMoveColumn(column, -1) ? [{ label: `Move “${shortLabel(col)}” left`, value: "move-left", keys: "Alt+Left" }] : []),
			...(canMoveColumn(column, 1) ? [{ label: `Move “${shortLabel(col)}” right`, value: "move-right", keys: "Alt+Right" }] : []),
			...(differsFromFile() ? [{ label: "Save column order to file", value: "save-order" }] : []),
			...(hasCustomOrder() ? [{ label: "Reset column order", value: "reset-order" }] : []),
			"separator",
			{ label: `Auto-fit “${shortLabel(col)}” width`, value: "autofit" },
			...(hasCustomWidths() ? [{ label: "Reset column widths", value: "reset-widths" }] : []),
			...(hasCustomViewState() ? ["separator" as const, { label: "Reset table view", value: "reset-view" }] : []),
		];

		const items: RowMenuEntry[] = [
			{ label: "Sort ascending", value: "sort-asc", checked: sortIdx === 0 && !sortEntry?.down },
			{ label: "Sort descending", value: "sort-desc", checked: sortIdx === 0 && Boolean(sortEntry?.down) },
			...(curSorts.length > 0 && sortIdx < 0
				? [
						{ label: "Add secondary sort (ascending)", value: "sort-add-asc", keys: "Shift+Click" },
						{ label: "Add secondary sort (descending)", value: "sort-add-desc" },
					]
				: []),
			...(curSorts.length > 1 && sortIdx >= 0 ? [{ label: "Remove from sort", value: "sort-remove" }] : []),
			...(curSorts.length > 0
				? [{ label: "Apply sort order to file", value: "sort-apply" }, { label: "Clear sort", value: "sort-clear" }]
				: []),
			"separator",
			{ label: `Filter “${shortLabel(col)}”…`, value: "filter" },
			...(filteredHere ? [{ label: `Clear filter on “${shortLabel(col)}”`, value: "filter-clear" }] : []),
			{ label: groupedHere ? "Clear grouping" : `Group by “${shortLabel(col)}”`, value: "group-by", checked: groupedHere },
			"separator",
			...(hasHeader() ? [{ label: `Rename “${shortLabel(col)}”…`, value: "rename-col" }] : []),
			{ label: "Add column…", value: "add-col" },
			{ label: "Column layout", children: colLayoutEntries },
			"separator",
			...submenuOrInline("Badges", [
				{ label: hasRule ? `Configure “${shortLabel(col)}” badges…` : `Format “${shortLabel(col)}” as badges…`, value: "badges" },
				...(hasRule ? [{ label: `Turn off badges for “${shortLabel(col)}”`, value: "badges-off" }] : []),
			]),
			...submenuOrInline("Code check", [
				{ label: `Check “${shortLabel(col)}” in code…`, value: "check-col" },
				...(codeCheck() ? [{ label: "Clear code check results", value: "check-clear" }] : []),
			]),
			...(table().header.length > 1
				? (["separator", { label: `Delete “${shortLabel(col)}”…`, value: "delete-col", danger: true }] as RowMenuEntry[])
				: []),
		];

		const picked = await chooseFromMenu(`Actions for column ${col}`, items, at);
		if (!picked) return;
		if (picked === "sort-asc") setOrder((prev) => setColumnSortDirection(prev, column, false, false));
		else if (picked === "sort-desc") setOrder((prev) => setColumnSortDirection(prev, column, true, false));
		else if (picked === "sort-add-asc") setOrder((prev) => setColumnSortDirection(prev, column, false, true));
		else if (picked === "sort-add-desc") setOrder((prev) => setColumnSortDirection(prev, column, true, true));
		else if (picked === "sort-remove") setOrder((prev) => prev.filter((s) => s.column !== column));
		else if (picked === "sort-apply") void applySortToFile();
		else if (picked === "sort-clear") setOrder([]);
		else if (picked === "group-by") toggleGroupByColumn(column);
		else if (picked === "rename-col") void renameColumnInteractive(column);
		else if (picked === "add-col") void addColumnInteractive();
		else if (picked === "delete-col") void deleteColumnInteractive(column);
		else if (picked === "filter") {
			const btn = thEl.querySelector<HTMLElement>(".table-th-filter") ?? thEl;
			openFilterMenu(column, btn);
		} else if (picked === "filter-clear") {
			setColumnFilter(column, undefined);
		} else if (picked === "freeze") {
			toggleFreeze(column);
		} else if (picked === "unfreeze-all") {
			unfreezeAll();
		} else if (picked === "hide") {
			hideCol(column);
		} else if (picked === "show-all") {
			showAllCols();
		} else if (picked === "move-left") {
			moveColumnBy(column, -1);
		} else if (picked === "move-right") {
			moveColumnBy(column, 1);
		} else if (picked === "autofit") {
			autoFitColumn(column);
		} else if (picked === "reset-widths") {
			resetColumnWidths();
		} else if (picked === "save-order") {
			applyColumnOrderToFile();
		} else if (picked === "reset-order") {
			resetColumnOrder();
		} else if (picked === "reset-view") {
			resetTableView();
		} else if (picked === "check-col") {
			setCheckDialog({ open: true, column, rowScope: hasActiveFilters() ? "filtered" : "all" });
		} else if (picked === "check-clear") {
			clearCodeCheck();
		} else if (picked === "badges") {
			setFormatDialog({ open: true, initialColumn: headerName(column) });
		} else if (picked === "badges-off") {
			void disableBadgeForColumn(headerName(column));
		}
	};

	const onHeaderContextMenu = async (e: MouseEvent, column: number) => {
		e.preventDefault();
		e.stopPropagation();
		if (!e.clientX && !e.clientY && performance.now() - lastKeyMenuAt < 150) return;
		const thEl = e.currentTarget as HTMLElement;
		await openHeaderContextMenu(menuPoint(e, thEl), thEl, column);
	};

	const openGhostContextMenu = async (at: { x: number; y: number }, column: number) => {
		closeFilterMenu(false);
		setActiveCell({ ghost: true, column });
		const col = headerName(column) || `Column ${column + 1}`;
		const hasRule = Boolean(columnRule(column));

		const items: RowMenuEntry[] = [
			{ label: "Start new row here", value: "edit-ghost", keys: "Enter" },
			"separator",
			{ label: hasRule ? `Configure “${shortLabel(col)}” badges…` : `Format “${shortLabel(col)}” as badges…`, value: "badges" },
		];
		const picked = await chooseFromMenu(`Actions for new row (${col})`, items, at);
		if (!picked) return;
		if (picked === "edit-ghost") setEditing({ ghost: true, column });
		else if (picked === "badges") setFormatDialog({ open: true, initialColumn: headerName(column) });
	};

	const onGhostContextMenu = async (e: MouseEvent, column: number) => {
		const target = e.target instanceof Element ? e.target : null;
		if (target?.closest("input, textarea")) return;
		e.preventDefault();
		e.stopPropagation();
		if (!e.clientX && !e.clientY && performance.now() - lastKeyMenuAt < 150) return;
		await openGhostContextMenu(menuPoint(e, e.currentTarget as HTMLElement), column);
	};

	const openTableActionsMenu = async (anchor: HTMLElement) => {
		closeFilterMenu(false);
		const rect = anchor.getBoundingClientRect();
		const at = { x: rect.left, y: rect.bottom + 4 };
		const selIdx = current();
		const hasSelectedRow = selIdx !== null && Boolean(table().rows[selIdx]);
		const selName = currentName();
		const totalRows = table().rows.length;

		const layoutResetEntries: RowMenuEntry[] = [
			...(frozenCols().length ? [{ label: "Unfreeze all columns", value: "unfreeze-all" }] : []),
			...(hiddenCols().size ? [{ label: `Show all hidden columns (${hiddenCols().size})`, value: "show-all-cols" }] : []),
			...(hasCustomWidths() ? [{ label: "Reset column widths", value: "reset-widths" }] : []),
			...(differsFromFile() ? [{ label: "Save column order to file", value: "save-order" }] : []),
			...(hasCustomOrder() ? [{ label: "Reset column order", value: "reset-order" }] : []),
			...(hasCustomViewState() ? ["separator" as const, { label: "Reset table view", value: "reset-view" }] : []),
		];

		const formatEntries: RowMenuEntry[] = [
			{ label: "First row is header", value: "fmt-toggle-header", checked: hasHeader() },
			"separator",
			{ label: `Delimiter: Auto (${delimiterLabel(autoDelimiter())})`, value: "fmt-delim-auto", checked: delimiterOverride() === "auto" },
			{ label: "Delimiter: Comma (,)", value: "fmt-delim-comma", checked: delimiterOverride() === "," },
			{ label: "Delimiter: Tab (TSV)", value: "fmt-delim-tab", checked: delimiterOverride() === "\t" },
			{ label: "Delimiter: Semicolon (;)", value: "fmt-delim-semi", checked: delimiterOverride() === ";" },
			{ label: "Delimiter: Pipe (|)", value: "fmt-delim-pipe", checked: delimiterOverride() === "|" },
			"separator",
			{ label: "Convert file delimiter to…", value: "fmt-convert-delim" },
		];

		const items: RowMenuEntry[] = [
			{ label: "Find & replace…", value: "find", keys: "Ctrl+F" },
			...(tableIssues().length > 0 ? [{ label: `Jump to next issue (${tableIssues().length})`, value: "next-issue", keys: "F8" }] : []),
			...(duplicateEntries().length > 0
				? [{ label: onlyDupes() ? "Show all rows (clear dupes filter)" : `Filter to duplicate keys (${duplicateEntries().length})`, value: "toggle-dupes", checked: onlyDupes() }]
				: []),
			"separator",
			{ label: "Start new row at end", value: "add-end" },
			...(hasSelectedRow
				? [
						{
							label: `Selected row${selName ? ` (“${shortLabel(selName)}”)` : ""}`,
							children: [
								{ label: "Insert row above", value: "insert-above" },
								{ label: "Insert row below", value: "insert-below" },
								{ label: "Duplicate row", value: "duplicate" },
								"separator",
								{ label: "Move row up", value: "move-row-up", keys: "Alt+Up", disabled: selIdx! <= 0 },
								{ label: "Move row down", value: "move-row-down", keys: "Alt+Down", disabled: selIdx! >= totalRows - 1 },
								"separator",
								{ label: "Delete row", value: "delete-selected", danger: true },
							],
						} satisfies RowMenuEntry,
					]
				: []),
			{ label: "Add column…", value: "add-col" },
			...(isDatabaseRegistry() ? [{ label: "Sync from schema SQL…", value: "sync-schema" }] : []),
			...(order().length > 0 ? [{ label: "Apply sort order to file", value: "sort-apply" }] : []),
			"separator",
			{
				label: "Copy / Export visible rows",
				children: [
					{ label: "As CSV", value: "copy-csv" },
					{ label: "As TSV (Excel)", value: "copy-tsv" },
					{ label: "As Markdown table", value: "copy-md" },
					"separator",
					{ label: "Export visible rows as CSV file…", value: "export-csv" },
					{ label: "Export visible rows as TSV file…", value: "export-tsv" },
				],
			},
			...(table().header.length > 0
				? [
						{
							label:
								groupByCol() !== null
									? `Group rows by… (${shortLabel(headerName(groupByCol()!) || `Column ${groupByCol()! + 1}`)})`
									: "Group rows by…",
							value: "group-pick",
							checked: groupByCol() !== null,
						} satisfies RowMenuEntry,
					]
				: []),
			...(groupByCol() !== null ? [{ label: "Clear grouping", value: "group-clear" }] : []),
			{ label: "Table format", children: formatEntries },
			"separator",
			...submenuOrInline("Code check", [
				{ label: "Check column in code…", value: "check" },
				...(codeCheck() ? [{ label: "Clear code check results", value: "check-clear" }] : []),
			]),
			{ label: "Configure column badges…", value: "badges" },
			...submenuOrInline("Column layout", layoutResetEntries),
		];

		const picked = await chooseFromMenu("Table actions", items, at);
		if (!picked) return;
		if (picked === "find") {
			openFind(false);
		} else if (picked === "next-issue") {
			jumpToTableIssue(1);
		} else if (picked === "toggle-dupes") {
			setPinnedRow(null);
			setOnlyDupes(!onlyDupes());
		} else if (picked === "add-col") {
			void addColumnInteractive();
		} else if (picked === "sync-schema") {
			void syncDatabaseRegistryFromSchema();
		} else if (picked === "sort-apply") {
			void applySortToFile();
		} else if (picked === "copy-csv") {
			void copyFilteredAs("csv");
		} else if (picked === "copy-tsv") {
			void copyFilteredAs("tsv");
		} else if (picked === "copy-md") {
			void copyFilteredAs("markdown");
		} else if (picked === "export-csv") {
			void exportVisibleToFile("csv");
		} else if (picked === "export-tsv") {
			void exportVisibleToFile("tsv");
		} else if (picked === "group-pick") {
			void pickGroupByColumn();
		} else if (picked === "group-clear") {
			setGroupByCol(null);
			setCollapsedGroups(new Set<string>());
		} else if (picked === "fmt-toggle-header") {
			setHasHeader((v) => !v);
		} else if (picked === "fmt-delim-auto") {
			setDelimiterOverride("auto");
		} else if (picked === "fmt-delim-comma") {
			setDelimiterOverride(",");
		} else if (picked === "fmt-delim-tab") {
			setDelimiterOverride("\t");
		} else if (picked === "fmt-delim-semi") {
			setDelimiterOverride(";");
		} else if (picked === "fmt-delim-pipe") {
			setDelimiterOverride("|");
		} else if (picked === "fmt-convert-delim") {
			void convertDelimiterInteractive();
		} else if (picked === "check") {
			setCheckDialog({ open: true, column: defaultCheckColumn(table()), rowScope: hasActiveFilters() ? "filtered" : "all" });
		} else if (picked === "check-clear") {
			clearCodeCheck();
		} else if (picked === "unfreeze-all") {
			unfreezeAll();
		} else if (picked === "show-all-cols") {
			showAllCols();
		} else if (picked === "reset-widths") {
			resetColumnWidths();
		} else if (picked === "save-order") {
			applyColumnOrderToFile();
		} else if (picked === "reset-order") {
			resetColumnOrder();
		} else if (picked === "reset-view") {
			resetTableView();
		} else if (picked === "badges") {
			setFormatDialog({ open: true });
		} else if (picked === "add-end") {
			startNewRowAtEnd();
		} else if (picked === "insert-above" && selIdx !== null) {
			insertRowAt(selIdx, "above");
		} else if (picked === "insert-below" && selIdx !== null) {
			insertRowAt(selIdx, "below");
		} else if (picked === "duplicate" && selIdx !== null) {
			duplicateRowAt(selIdx);
		} else if (picked === "move-row-up" && selIdx !== null) {
			moveRowTo(selIdx, selIdx - 1);
		} else if (picked === "move-row-down" && selIdx !== null) {
			moveRowTo(selIdx, selIdx + 1);
		} else if (picked === "delete-selected" && selIdx !== null) {
			deleteRowAt(selIdx);
		}
	};

	return (
		<div
			ref={rootEl}
			tabindex={-1}
			class="table-view"
			onPaste={(e) => {
				if (editing()) return;
				const target = e.target as HTMLElement | null;
				if (target?.closest("input, textarea")) return;
				if (!activeCell()) return;
				const raw = e.clipboardData?.getData("text/plain");
				if (!raw) return;
				e.preventDefault();
				void pasteGridAt(raw);
			}}
			onKeyDown={(e) => {
				// F8 / Shift+F8: jump to next/previous inline validation issue across the table.
				if (e.key === "F8" && !e.ctrlKey && !e.metaKey && !e.altKey) {
					if (editing() || modalOpen()) return;
					if (tableIssues().length > 0) {
						e.preventDefault();
						e.stopPropagation();
						jumpToTableIssue(e.shiftKey ? -1 : 1);
					}
					return;
				}
				// The table is a view of the text, and its changes are the text's: they are undone as the text's are.
				if (!model || !(e.ctrlKey || e.metaKey) || e.altKey) return;
				const key = e.key.toLowerCase();
				if ((key === "f" || key === "h") && !e.shiftKey) {
					if (editing() || modalOpen()) return;
					e.preventDefault();
					e.stopPropagation();
					openFind(key === "h");
					return;
				}
				const targetEl = e.target as HTMLElement;
				const isTextInput =
					targetEl.tagName === "TEXTAREA" ||
					(targetEl.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((targetEl as HTMLInputElement).type));
				if (isTextInput) return;
				if (key === "z" && !e.shiftKey) (e.preventDefault(), void model.undo());
				else if (key === "y" || (key === "z" && e.shiftKey)) (e.preventDefault(), void model.redo());
				else if (key === "d" && !e.shiftKey) {
					if (editing() || modalOpen()) return;
					if (!activeCell() || activeCell()?.ghost) return;
					e.preventDefault();
					e.stopPropagation();
					fillDownSelection();
				} else if (key === "r" && !e.shiftKey) {
					if (editing() || modalOpen()) return;
					if (!activeCell() || activeCell()?.ghost) return;
					e.preventDefault();
					e.stopPropagation();
					fillRightSelection();
				} else if (key === "c" && !e.shiftKey) {
					const sel = window.getSelection();
					if (sel && !sel.isCollapsed) return;
					const range = cellRange();
					if (range && range.isMulti) {
						e.preventDefault();
						void copyCellRangeAsTsv(range);
						return;
					}
					if (visibleSelectedRows().length > 0) {
						e.preventDefault();
						void copySelectedAsTsv();
						return;
					}
					const ac = activeCell();
					if (ac && !ac.ghost) {
						const val = table().rows[ac.row]?.[ac.column]?.text ?? "";
						e.preventDefault();
						void copyText(formatSingleCellForClipboard(val), "Copied cell value.");
					}
				}
			}}
		>
			<div
				class="table-bar"
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) clearCellSelection();
				}}
			>
				<input
					class="filter"
					type="search"
					placeholder="Filter rows"
					aria-label="Filter the rows by what they hold"
					value={filter()}
					onInput={(e) => (setPinnedRow(null), setFilter(e.currentTarget.value))}
				/>
				<span class="hint">
					{rows().length === table().rows.length ? `${table().rows.length} ${table().rows.length === 1 ? "row" : "rows"}` : `${rows().length} of ${table().rows.length} rows`}
				</span>
				<Show when={tableIssues().length > 0}>
					<span class="table-issues-pill" role="group" aria-label="Table validation issues">
						<button
							type="button"
							class="doc-status table-dupes-chip table-issues-toggle"
							aria-pressed={onlyIssues() ? "true" : "false"}
							title={`${summarizeTableIssues(tableIssues())}. Click to filter to rows with issues.`}
							onClick={() => (setPinnedRow(null), setOnlyIssues(!onlyIssues()))}
						>
							<Icon name="warning" /> {tableIssues().length} {tableIssues().length === 1 ? "issue" : "issues"}
						</button>
						<button
							type="button"
							class="table-issues-next"
							title="Jump to next issue (F8; Shift+F8 for previous)"
							aria-label="Next issue"
							onClick={() => jumpToTableIssue(1)}
						>
							Next
						</button>
					</span>
				</Show>
				<Show when={onlyDupes() && duplicateEntries().length > 0}>
					<button
						type="button"
						class="doc-status table-dupes-chip"
						aria-pressed="true"
						title={`${duplicateEntries().length} duplicate ${duplicateEntries().length === 1 ? "key" : "keys"} across ${duplicateRowSet().size} rows. Click to clear duplicates filter.`}
						onClick={() => (setPinnedRow(null), setOnlyDupes(false))}
					>
						<Icon name="warning" /> {duplicateEntries().length} {duplicateEntries().length === 1 ? "dupe" : "dupes"} <Icon name="close" />
					</button>
				</Show>
				<Show when={onlyTicket()}>
					<button class="doc-status tone-active table-for" aria-pressed="true" title="Show every row again" onClick={() => (setPinnedRow(null), setOnlyTicket(null))}>
						for {onlyTicket()} <Icon name="close" />
					</button>
				</Show>
				<For each={activeFilterCols()}>
					{([col, colFilter]) => {
						const summary = () => describeColumnFilter(headerName(col) || `Column ${col + 1}`, colFilter, optionsForColumn(col));
						return (
							<button
								type="button"
								class="doc-status tone-active table-col-chip"
								aria-pressed="true"
								title={`${summary()}. Click to clear this column filter.`}
								onClick={() => setColumnFilter(col, undefined)}
							>
								<span>{summary()}</span>
								<Icon name="close" />
							</button>
						);
					}}
				</For>
				<Show when={activeFilterCols().length > 1 || (activeFilterCols().length > 0 && Boolean(filter().trim())) || ((onlyDupes() || onlyIssues()) && (activeFilterCols().length > 0 || Boolean(filter().trim()) || onlyMissing() || onlyTicket() !== null))}>
					<button type="button" class="link table-clear-all" onClick={clearAllFilters}>
						Clear filters
					</button>
				</Show>

				{/* Targeted code-check live progress or result summary chip */}
				<Show when={checking()}>
					{(prog) => (
						<span class="table-check-progress" role="status">
							<span>
								Checking {prog().columnName} ({prog().done}/{prog().total})…
							</span>
							<button type="button" class="link" onClick={cancelCodeCheck}>
								Cancel
							</button>
						</span>
					)}
				</Show>
				<Show when={!checking() && codeCheck()}>
					{(chk) => (
						<span class="table-check-status">
							<Show
								when={missingCount() > 0}
								fallback={
									<span class="doc-status tone-done table-check-ok" title={`All ${chk().counts.size} checked values in “${chk().columnName}” were found in code`}>
										{chk().columnName}: {chk().counts.size} in code
									</span>
								}
							>
								<button
									type="button"
									class="doc-status tone-off table-missing"
									aria-pressed={onlyMissing() ? "true" : "false"}
									title={`Show only rows whose “${chk().columnName}” value was not found in the searched code files`}
									onClick={() => (setPinnedRow(null), setOnlyMissing(!onlyMissing()))}
								>
									{chk().columnName}: not in code {missingCount()}
								</button>
							</Show>
							<button
								type="button"
								class="icon-btn table-check-clear"
								title="Clear code check results"
								aria-label="Clear code check results"
								onClick={clearCodeCheck}
							>
								<Icon name="close" />
							</button>
						</span>
					)}
				</Show>

				<Show when={groupByCol() !== null}>
					<button
						type="button"
						class="doc-status tone-active table-col-chip"
						aria-pressed="true"
						title={`Grouped by “${headerName(groupByCol()!) || `Column ${groupByCol()! + 1}`}”. Click to clear grouping.`}
						onClick={() => {
							setGroupByCol(null);
							setCollapsedGroups(new Set<string>());
						}}
					>
						<Icon name="list-tree" />
						<span>Group: {headerName(groupByCol()!) || `Column ${groupByCol()! + 1}`}</span>
						<Icon name="close" />
					</button>
				</Show>

				<Show when={!hasHeader()}>
					<button
						type="button"
						class="doc-status tone-waiting table-fmt-chip"
						title="Treating row 1 as data (no header row). Click to restore header row."
						onClick={() => setHasHeader(true)}
					>
						<span>No header</span>
						<Icon name="close" />
					</button>
				</Show>

				<Show when={delimiterOverride() !== "auto"}>
					<button
						type="button"
						class="doc-status tone-waiting table-fmt-chip"
						title={`Delimiter override: ${delimiterLabel(delimiterOverride() as CsvDelimiter)}. Click to return to Auto.`}
						onClick={() => setDelimiterOverride("auto")}
					>
						<span>Delim: {delimiterLabel(delimiterOverride() as CsvDelimiter)}</span>
						<Icon name="close" />
					</button>
				</Show>

				<Show when={hiddenCols().size > 0}>
					<button
						type="button"
						class="doc-status tone-waiting table-hidden-chip"
						aria-haspopup="menu"
						title="Some columns are hidden. Click to show them."
						onClick={(e) => void openHiddenColumnsMenu(e.currentTarget)}
					>
						<Icon name="eye-closed" /> {hiddenCols().size} hidden
					</button>
				</Show>

				<Show when={order().length > 0}>
					<span
						class="table-reorder-bar"
						role="status"
						title={order()
							.map((s, idx) => `${idx + 1}. ${headerName(s.column) || `Column ${s.column + 1}`} (${s.down ? "desc" : "asc"})`)
							.join(", ")}
					>
						<span class="table-reorder-label">
							{order().length > 1 ? `Sorted (${order().length})` : "Sorted"}
						</span>
						<button
							type="button"
							class="link table-reorder-apply"
							title="Write the current row sort order into the CSV file (Ctrl+Z undoes)"
							onClick={() => void applySortToFile()}
						>
							Apply sort to file
						</button>
						<button type="button" class="link table-reorder-reset" title="Clear temporary sort" onClick={() => setOrder([])}>
							Clear
						</button>
					</span>
				</Show>

				<Show when={hasCustomOrder()}>
					<span class="table-reorder-bar" role="status">
						<span class="table-reorder-label">Columns reordered</span>
						<button
							type="button"
							class="link table-reorder-apply"
							title="Write the current column order into the CSV file (Ctrl+Z undoes)"
							onClick={applyColumnOrderToFile}
						>
							Apply to file
						</button>
						<button
							type="button"
							class="link table-reorder-reset"
							title="Restore the CSV file's original column order"
							onClick={resetColumnOrder}
						>
							Reset
						</button>
					</span>
				</Show>

				<span class="table-bar-actions">
					<Show when={hasCustomViewState()}>
						<button
							type="button"
							class="icon-btn table-reset-view-btn"
							aria-label="Reset table view"
							title="Reset table view (widths, frozen columns, order, hidden columns, sort, grouping)"
							onClick={resetTableView}
						>
							<Icon name="refresh" />
						</button>
					</Show>
					<button
						type="button"
						class={["icon-btn table-find-open-btn", { active: findOpen() }]}
						aria-label="Find and replace in table"
						aria-pressed={findOpen() ? "true" : "false"}
						title="Find & replace in table (Ctrl+F / Ctrl+H)"
						onClick={() => (findOpen() ? closeFind() : openFind(false))}
					>
						<Icon name="search" />
					</button>
					<button
						type="button"
						class={["table-format-btn", { active: matchedBadgeCols().length > 0 }]}
						title={
							!csvConfig().badgeFormatting
								? "Column badge formatting is off. Configure CSV column badges…"
								: matchedBadgeCols().length
									? `Badges active on: ${matchedBadgeCols().join(", ")}. Click to configure…`
									: "Configure CSV column badges…"
						}
						onClick={() => setFormatDialog({ open: true })}
					>
						<Icon name="tag" /> Badges
					</button>
					<button
						type="button"
						class="icon-btn table-more-btn"
						aria-haspopup="menu"
						aria-label="Table actions"
						title="Table actions (or right-click any cell or column header)"
						onClick={(e) => void openTableActionsMenu(e.currentTarget)}
					>
						<Icon name="ellipsis" />
					</button>
				</span>
			</div>

			<Show when={visibleSelectedRows().length > 0}>
				<div class="table-bulk-bar" role="region" aria-label="Selected rows actions">
					<span class="table-bulk-count">
						{visibleSelectedRows().length} {visibleSelectedRows().length === 1 ? "row" : "rows"} selected
						<Show when={hiddenSelectedCount() > 0}> ({hiddenSelectedCount()} hidden ignored)</Show>
					</span>
					<Show when={statusCol() >= 0}>
						<button type="button" class="table-bulk-btn" onClick={() => void bulkSetStatus()}>
							Set {headerName(statusCol()) || "status"}…
						</button>
					</Show>
					<Show when={ticketAt() >= 0}>
						<button type="button" class="table-bulk-btn" onClick={() => void bulkAssignTicket()}>
							Assign ticket…
						</button>
					</Show>
					<button type="button" class="table-bulk-btn" onClick={() => void bulkFillAnyColumn()}>
						Set column…
					</button>
					<button type="button" class="table-bulk-btn" title="Copy selected rows as TSV for Excel/Sheets (Ctrl+C)" onClick={() => void copySelectedAsTsv()}>
						Copy TSV
					</button>
					<button type="button" class="table-bulk-btn" onClick={() => void copySelectedAsCsv()}>
						Copy CSV
					</button>
					<button type="button" class="table-bulk-btn" title="Copy selected rows as a Markdown table" onClick={() => void copySelectedAsMarkdown()}>
						Copy Markdown
					</button>
					<button
						type="button"
						class="table-bulk-btn"
						title="Search workspace code for values in the checked rows"
						onClick={() => setCheckDialog({ open: true, column: defaultCheckColumn(table()), rowScope: "checked" })}
					>
						Check in code…
					</button>
					<button type="button" class="table-bulk-btn danger" onClick={() => void bulkDeleteSelected()}>
						<Icon name="trash" /> Delete
					</button>
					<button type="button" class="link table-bulk-clear" onClick={() => setSelectedRows(new Set<number>())}>
						Clear
					</button>
				</div>
			</Show>

			{/* Compact inline Find & Replace bar (Ctrl+F / Ctrl+H). */}
			<Show when={findOpen()}>
				<div class="table-find-bar" role="search" aria-label="Find and replace in table">
					<div class="table-find-group">
						<button
							type="button"
							class="icon-btn table-find-icon-btn"
							aria-expanded={replaceOpen() ? "true" : "false"}
							aria-label={replaceOpen() ? "Hide replace" : "Show replace"}
							title={replaceOpen() ? "Hide replace" : "Show replace (Ctrl+H)"}
							onClick={() => setReplaceOpen((v) => !v)}
						>
							<Icon name={replaceOpen() ? "chevron-down" : "chevron-right"} />
						</button>
						<input
							ref={findInputEl}
							type="search"
							class={["table-find-input", { invalid: Boolean(findRegexError()) }]}
							placeholder="Find in table…"
							aria-label="Find in table"
							aria-invalid={findRegexError() ? "true" : "false"}
							value={findQuery()}
							onInput={(e) => {
								setFindQuery(e.currentTarget.value);
								setFindMatchIdx(0);
								revealFirstMatchAfterFlush();
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									findStep(e.shiftKey ? -1 : 1);
								} else if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation();
									closeFind();
								}
							}}
						/>
						<Show
							when={!findRegexError()}
							fallback={
								<span class="table-find-err" role="alert" title={findRegexError()!}>
									Invalid regex
								</span>
							}
						>
							<span
								class={["table-find-count", { empty: Boolean(findQuery()) && findMatches().length === 0 }]}
								role="status"
								aria-live="polite"
							>
								{findQuery()
									? findMatches().length
										? `${currentMatchIdx() + 1}/${findMatches().length}`
										: "0/0"
									: ""}
							</span>
						</Show>
						<button
							type="button"
							class="icon-btn table-find-icon-btn"
							disabled={findMatches().length === 0}
							aria-label="Previous match"
							title="Previous match (Shift+Enter)"
							onClick={() => findStep(-1)}
						>
							<Icon name="arrow-up" />
						</button>
						<button
							type="button"
							class="icon-btn table-find-icon-btn"
							disabled={findMatches().length === 0}
							aria-label="Next match"
							title="Next match (Enter)"
							onClick={() => findStep(1)}
						>
							<Icon name="arrow-down" />
						</button>
						<button
							type="button"
							class="table-find-toggle"
							aria-pressed={findCaseSensitive() ? "true" : "false"}
							title="Match case"
							onClick={() => {
								setFindCaseSensitive((v) => !v);
								setFindMatchIdx(0);
								revealFirstMatchAfterFlush();
							}}
						>
							Aa
						</button>
						<button
							type="button"
							class="table-find-toggle"
							aria-pressed={findWholeWord() ? "true" : "false"}
							aria-label="Match whole word"
							title="Match whole word"
							onClick={() => {
								setFindWholeWord((v) => !v);
								setFindMatchIdx(0);
								revealFirstMatchAfterFlush();
							}}
						>
							ab
						</button>
						<button
							type="button"
							class="table-find-toggle"
							aria-pressed={findRegex() ? "true" : "false"}
							aria-label="Use regular expression"
							title="Use regular expression"
							onClick={() => {
								setFindRegex((v) => !v);
								setFindMatchIdx(0);
								revealFirstMatchAfterFlush();
							}}
						>
							.*
						</button>
						<button
							type="button"
							class="table-find-toggle"
							aria-pressed={findCurrentColOnly() ? "true" : "false"}
							title={`Search only in “${headerName(findColumn()) || `Column ${findColumn() + 1}`}”`}
							onClick={() => {
								const next = !findCurrentColOnly();
								if (next && findInSelection()) {
									setFindInSelection(false);
									setFindSelectionScope(null);
								}
								setFindCurrentColOnly(next);
								setFindMatchIdx(0);
								revealFirstMatchAfterFlush();
							}}
						>
							{findCurrentColOnly()
								? `Col: ${shortLabel(headerName(findColumn()) || `#${findColumn() + 1}`, 14)}`
								: "Current column"}
						</button>
						<button
							type="button"
							class="table-find-toggle"
							aria-pressed={findInSelection() ? "true" : "false"}
							disabled={!findInSelection() && !cellRange()?.isMulti}
							title={
								findInSelection() && findSelectionScope()
									? `Searching in ${findSelectionScope()!.rowCount} × ${findSelectionScope()!.colCount} selected cells. Click to search all visible cells.`
									: cellRange()?.isMulti
										? `Search only inside the selected ${cellRange()!.rowCount} × ${cellRange()!.colCount} cell range`
										: "Select multiple cells to search within selection"
							}
							onClick={toggleFindInSelection}
						>
							{findInSelection() && findSelectionScope()
								? `In selection (${findSelectionScope()!.rowCount}×${findSelectionScope()!.colCount})`
								: "In selection"}
						</button>
					</div>

					<Show when={replaceOpen()}>
						<div class="table-find-group">
							<input
								ref={replaceInputEl}
								type="text"
								class="table-find-input"
								placeholder="Replace with…"
								aria-label="Replace with"
								value={replaceText()}
								onInput={(e) => setReplaceText(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										if (e.ctrlKey || e.metaKey || e.altKey) replaceAll();
										else replaceCurrent();
									} else if (e.key === "Escape") {
										e.preventDefault();
										e.stopPropagation();
										closeFind();
									}
								}}
							/>
							<button
								type="button"
								class="table-find-btn"
								disabled={!activeFindMatch()}
								title="Replace current match (Enter)"
								onClick={replaceCurrent}
							>
								Replace
							</button>
							<button
								type="button"
								class="table-find-btn"
								disabled={findMatches().length === 0}
								title="Replace all matches in one undoable edit (Ctrl+Enter)"
								onClick={replaceAll}
							>
								Replace all
							</button>
						</div>
					</Show>

					<button
						type="button"
						class="icon-btn table-find-icon-btn table-find-close"
						aria-label="Close find bar"
						title="Close (Esc)"
						onClick={closeFind}
					>
						<Icon name="close" />
					</button>
				</div>
			</Show>

			<Show when={table().problems.length || duplicateKeyWarning()}>
				<p class="hint warn table-problems" role="status">
					{[...table().problems, ...(duplicateKeyWarning() ? [duplicateKeyWarning()] : [])].join(" ")} The Text view shows the file as written.
				</p>
			</Show>

			<div
				ref={scrollEl}
				class={[
					"table-scroll",
					{
						"is-dragging-col": Boolean(colDrag()),
						"is-dragging-row": Boolean(rowDrag()),
						"is-resizing-col": resizingCol() !== null,
						"is-drag-selecting": isDragSelecting(),
						"is-fill-dragging": Boolean(fillDrag()),
					},
				]}
				onScroll={(e) => {
					setScrollTop(e.currentTarget.scrollTop);
					if (editing() && activeInputEl?.isConnected) {
						setPickerAnchor(activeInputEl.getBoundingClientRect());
					}
				}}
				onMouseDown={(e) => {
					const target = e.target as HTMLElement | null;
					if (!target?.closest("td, th, button, input")) clearCellSelection();
				}}
			>
				<table ref={tableEl}>
					<thead>
						<tr ref={headRow}>
							<Show when={table().header.length > 0}>
								<th scope="col" class="table-sel-col">
									<div class="table-sel-inner">
										<input
											type="checkbox"
											checked={allDrawnSelected()}
											aria-label="Select all visible rows"
											title="Select all visible rows"
											onChange={toggleSelectAllDrawn}
										/>
									</div>
								</th>
							</Show>
							<For each={visibleColumns()} keyed={false}>
								{(colAcc, visIdx) => {
									const col = () => colAcc();
									const name = () => headerName(col());
									const filtered = () => isColFiltered(col());
									const isFrozen = () => visIdx < visibleFrozenCount();
									const isLastFrozen = () => isFrozen() && visIdx === visibleFrozenCount() - 1;
									const isDragging = () => colDrag()?.col === col();
									const isDropBefore = () => {
										const d = colDrag();
										return Boolean(d && d.dropVis === visIdx && d.dropVis !== d.fromVis && d.side === "before");
									};
									const isDropAfter = () => {
										const d = colDrag();
										return Boolean(d && d.dropVis === visIdx && d.dropVis !== d.fromVis && d.side === "after");
									};
									const filterTip = () => {
										const f = colFilters().get(col());
										if (f && isColumnFilterActive(f)) {
											return `${describeColumnFilter(name() || `Column ${col() + 1}`, f, optionsForColumn(col()))} — click to edit filter`;
										}
										return `Filter ${name() || "this column"}`;
									};
									const sortIdx = () => order().findIndex((s) => s.column === col());
									const sortEntry = () => {
										const i = sortIdx();
										return i >= 0 ? order()[i]! : null;
									};
									return (
										<th
											scope="col"
											data-col={col()}
											style={cellStyle(col(), visIdx)}
											class={{
												"col-filtered": filtered(),
												"col-checked": codeCheck()?.column === col(),
												"col-frozen": isFrozen(),
												"col-frozen-last": isLastFrozen(),
												"col-dragging": isDragging(),
												"col-drop-before": isDropBefore(),
												"col-drop-after": isDropAfter(),
											}}
											aria-sort={
												sortIdx() === 0
													? sortEntry()!.down
														? "descending"
														: "ascending"
													: sortIdx() > 0
														? "other"
														: "none"
											}
											onPointerDown={(e) => onHeaderPointerDown(e, col(), visIdx)}
											onContextMenu={(e) => void onHeaderContextMenu(e, col())}
											onKeyDown={(e) => {
												if (isContextMenuKey(e)) {
													e.preventDefault();
													e.stopPropagation();
													lastKeyMenuAt = performance.now();
													const thEl = e.currentTarget as HTMLElement;
													void openHeaderContextMenu(pointUnder(thEl), thEl, col());
												}
											}}
										>
											<div class="table-th-inner">
												<Show when={isFrozen()}>
													<button
														type="button"
														class="table-th-pin"
														title={`Unfreeze “${name() || `Column ${col() + 1}`}”`}
														aria-label={`Unfreeze ${name() || `column ${col() + 1}`}`}
														onClick={() => toggleFreeze(col())}
													>
														<Icon name="pinned" />
													</button>
												</Show>
												<button
													type="button"
													class="table-th-sort"
													title={`Click to sort by ${name() || "this column"}; Shift+Click to add secondary sort; drag to reorder; right-click for more actions.`}
													onClick={(e) => {
														if (suppressSortClick) return;
														sortBy(col(), e.shiftKey);
													}}
													onKeyDown={(e) => {
														if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
															e.preventDefault();
															const targetCol = col();
															moveColumnBy(targetCol, e.key === "ArrowLeft" ? -1 : 1);
															queueMicrotask(() => {
																headRow?.querySelector<HTMLElement>(`th[data-col="${targetCol}"] .table-th-sort`)?.focus();
															});
														}
													}}
												>
													<span class="table-th-label">{name() || "(no name)"}</span>
													<Show when={sortEntry()}>
														{(entry) => (
															<span class="table-sort-indicator">
																<Show when={order().length > 1}>
																	<span class="table-sort-prio" aria-label={`Sort priority ${sortIdx() + 1}`}>
																		{sortIdx() + 1}
																	</span>
																</Show>
																<Icon name={entry().down ? "arrow-down" : "arrow-up"} />
															</span>
														)}
													</Show>
												</button>
												<button
													type="button"
													class={["table-th-filter", { active: filtered(), open: filterMenu()?.column === col() }]}
													aria-label={`Filter ${name() || `column ${col() + 1}`}`}
													aria-haspopup="dialog"
													aria-expanded={filterMenu()?.column === col() ? "true" : "false"}
													title={filterTip()}
													onClick={(e) => openFilterMenu(col(), e.currentTarget)}
												>
													<Icon name={filtered() ? "filter-filled" : "filter"} />
												</button>
											</div>
											<div
												class={["table-col-resizer", { active: resizingCol() === col() }]}
												title={`Drag to resize “${name() || `Column ${col() + 1}`}”; double-click to fit content`}
												onPointerDown={(e) => onResizerPointerDown(e, col())}
												onDblClick={(e) => (e.stopPropagation(), e.preventDefault(), autoFitColumn(col()))}
												onClick={(e) => e.stopPropagation()}
											/>
										</th>
									);
								}}
							</For>
						</tr>
					</thead>

					<tbody ref={body}>
						<Show when={virtualWindow().topPad > 0}>
							<tr class="table-virt-spacer" aria-hidden="true">
								<td colspan={visibleColumns().length + 1} style={{ height: `${virtualWindow().topPad}px`, padding: "0", border: "0" }} />
							</tr>
						</Show>
						<For each={drawnEntryIds()}>
							{(entryId) => {
								if (entryId.startsWith("g:")) {
									const groupEntry = () => {
										const e = displayEntryMap().get(entryId);
										return e && e.kind === "group" ? e : null;
									};
									return (
										<Show when={groupEntry()}>
											{(ge) => {
												const allInGroupSelected = () => {
													const sel = selectedRows();
													const ids = ge().rowIndices;
													return ids.length > 0 && ids.every((r) => sel.has(r));
												};
												const someInGroupSelected = () => {
													const sel = selectedRows();
													const ids = ge().rowIndices;
													const hit = ids.filter((r) => sel.has(r)).length;
													return hit > 0 && hit < ids.length;
												};
												const groupTone = () => {
													const gCol = groupByCol();
													if (gCol === null) return null;
													return badgeToneForValue(columnRule(gCol), ge().label);
												};
												let groupCbEl: HTMLInputElement | undefined;
												createEffect(
													() => someInGroupSelected(),
													(ind) => {
														if (groupCbEl) groupCbEl.indeterminate = ind;
													},
												);
												return (
													<tr class="table-group-row" data-entry-key={ge().entryKey}>
														<td class="table-sel-col" onClick={(e) => e.stopPropagation()}>
															<div class="table-sel-inner">
																<input
																	type="checkbox"
																	checked={allInGroupSelected()}
																	ref={(el) => {
																		groupCbEl = el;
																	}}
																	aria-label={`Select all ${ge().count} rows in group ${ge().label || "(empty)"}`}
																	title={`Select/deselect all ${ge().count} rows in “${ge().label || "(empty)"}”`}
																	onClick={(e) => {
																		e.stopPropagation();
																		toggleGroupSelect(ge().rowIndices);
																	}}
																	onChange={() => {}}
																/>
															</div>
														</td>
														<td colspan={visibleColumns().length}>
															<button
																type="button"
																class="table-group-toggle"
																aria-expanded={!ge().collapsed ? "true" : "false"}
																onClick={() => toggleGroupCollapsed(ge().key)}
															>
																<Icon name={ge().collapsed ? "chevron-right" : "chevron-down"} />
																<Show
																	when={ge().label}
																	fallback={<span class="table-filter-blank">(empty)</span>}
																>
																	<Show when={groupTone()} fallback={<span>{ge().label}</span>}>
																		{(tone) => <span class={`doc-status tone-${tone()}`}>{ge().label}</span>}
																	</Show>
																</Show>
																<span class="table-group-count">
																	{ge().count} {ge().count === 1 ? "row" : "rows"}
																</span>
															</button>
														</td>
													</tr>
												);
											}}
										</Show>
									);
								}
								const rowIndex = Number(entryId.slice(2));
								const index = () => rowIndex;
								const cells = () => table().rows[rowIndex] ?? [];
								return (
									<tr
										data-row={index()}
										class={{
											"row-current": current() === index(),
											"row-selected": selectedRows().has(index()),
											"row-revealed": revealedRow() === index(),
											"row-dragging": rowDrag()?.fromRow === index(),
											"row-drop-before": Boolean(rowDrag() && rowDrag()!.dropRow === index() && rowDrag()!.side === "before"),
											"row-drop-after": Boolean(rowDrag() && rowDrag()!.dropRow === index() && rowDrag()!.side === "after"),
										}}
									>
										<td
											class="table-sel-col"
											onClick={(e) => e.stopPropagation()}
											onPointerDown={(e) => onRowGripPointerDown(e, index())}
										>
											<div class="table-sel-inner">
												<span
													class={["table-row-num", { draggable: canReorderRows() && table().rows.length > 1 }]}
													title={
														canReorderRows() && table().rows.length > 1
															? `Row ${index() + 1} — drag to reorder (or Alt+Up / Alt+Down)`
															: `Row ${index() + 1}`
													}
												>
													{index() + 1}
												</span>
												<input
													type="checkbox"
													tabindex={isRovingRow(index()) ? 0 : -1}
													checked={selectedRows().has(index())}
													aria-label={`Select row ${index() + 1}`}
													onClick={(e) => {
														e.stopPropagation();
														toggleRowSelect(index(), e.shiftKey);
													}}
													onChange={() => {}}
												/>
											</div>
										</td>
										<For each={visibleColumns()} keyed={false}>
											{(colAcc, visIdx) => {
												const col = () => colAcc();
												const value = () => cells()[col()]?.text ?? "";
												const openEdit = () => {
													const ed = editing();
													return ed && !ed.ghost && ed.row === index() && ed.column === col() ? ed : null;
												};
												const open = () => openEdit() !== null;
												const rule = () => columnRule(col());
												const badgeTone = () => badgeToneForValue(rule(), value());
												const unrecognizedBadge = () => isUnrecognizedBadgeValue(rule(), value());
												const emptyPrimaryKey = () =>
													col() === 0 &&
													isCol0KeyLike() &&
													!value().trim() &&
													cells().some((c, ci) => ci !== 0 && Boolean(c.text.trim()));
												const checkedHere = () => {
													const chk = codeCheck();
													return chk && chk.column === col() ? chk : null;
												};
												const isFrozen = () => visIdx < visibleFrozenCount();
												const isLastFrozen = () => isFrozen() && visIdx === visibleFrozenCount() - 1;
												const cellTabIndex = () => (isRovingBodyCell(index(), col()) ? 0 : -1);
												const isDupeKeyCell = () => col() === 0 && duplicateRowSet().has(index());
												const isFindMatch = () => findOpen() && findMatchSet().has(`${index()}:${col()}`);
												const isCurrentMatch = () => {
													const m = activeFindMatch();
													return Boolean(findOpen() && m && m.row === index() && m.column === col());
												};
												const schemaDoc = () => schemaDocForCell(col(), value());
												const fileLink = () => (!schemaDoc() ? fileLinkForCell(col(), value()) : null);
												const malformedPath = () => (!schemaDoc() && !fileLink() ? isMalformedFilePath(col(), value()) : false);
												const cellTitle = () => {
													if (emptyPrimaryKey()) return `Missing primary key in “${headerName(0) || "Column 1"}”`;
													if (unrecognizedBadge()) return `Unrecognized value “${value().trim()}” for ${headerName(col()) || `Column ${col() + 1}`}`;
													return "Double-click, Enter or F2 to edit; right-click or Shift+F10 for actions";
												};
												const hasFillHandle = () => {
													const fh = fillHandleCell();
													return Boolean(fh && fh.row === index() && fh.col === col());
												};
												return (
													<td
														tabindex={cellTabIndex()}
														data-col={col()}
														style={cellStyle(col(), visIdx)}
														class={{
															number: /^-?\d[\d.,]*$/.test(value().trim()),
															"col-frozen": isFrozen(),
															"col-frozen-last": isLastFrozen(),
															"cell-selected": isCellSelected(index(), col()),
															"cell-in-range": isCellInRange(index(), col()),
															"cell-fill-target": isCellFillTarget(index(), col()),
															"cell-has-fill-handle": hasFillHandle(),
															"cell-editing": open(),
															"cell-dupe": isDupeKeyCell(),
															"cell-empty-key": emptyPrimaryKey(),
															"cell-find-match": isFindMatch(),
															"cell-find-current": isCurrentMatch(),
														}}
														title={cellTitle()}
														onMouseDown={(e) => onCellMouseDown(e, index(), col())}
														onFocus={() => setActiveCell({ ghost: false, row: index(), column: col() })}
														onClick={(e) => {
															if ((e.ctrlKey || e.metaKey) && !open() && openCellLink(col(), value())) {
																e.preventDefault();
																e.stopPropagation();
															}
														}}
														onDblClick={() => {
															if (!isCellInRange(index(), col())) setCellAnchor(null);
															setEditing({ ghost: false, row: index(), column: col() });
														}}
														onKeyDown={(e) => onCellKey(e, index(), col())}
														onContextMenu={(e) => void onCellContextMenu(e, index(), col())}
													>
														<Show
															when={openEdit()}
															keyed
															fallback={
																<Show
																	when={checkedHere()?.splitLists && value().trim()}
																	fallback={
																		<>
																			<Show
																				when={isTicketCol(col()) && value().trim()}
																				fallback={
																					<Show
																						when={schemaDoc()}
																						fallback={
																							<Show
																								when={fileLink()}
																								fallback={
																									<Show
																										when={malformedPath()}
																										fallback={
																											<Show
																												when={emptyPrimaryKey()}
																												fallback={
																													<Show
																														when={unrecognizedBadge()}
																														fallback={
																															<Show when={badgeTone()} fallback={richTextCell(value(), cellTabIndex)}>
																																{(tone) => <span class={`doc-status tone-${tone()}`}>{value()}</span>}
																															</Show>
																														}
																													>
																														<span
																															class="table-badge-warn"
																															title={`Unrecognized value “${value().trim()}” for ${headerName(col()) || `Column ${col() + 1}`}`}
																														>
																															<Show when={badgeTone()} fallback={<span class="table-val-warn">{value()}</span>}>
																																{(tone) => <span class={`doc-status tone-${tone()}`}>{value()}</span>}
																															</Show>
																															<span class="table-badge-warn-icon" aria-hidden="true">
																																<Icon name="warning" />
																															</span>
																														</span>
																													</Show>
																												}
																											>
																												<span class="table-empty-key-warn" title={`Missing primary key in “${headerName(0) || "Column 1"}”`}>
																													<Icon name="warning" />
																												</span>
																											</Show>
																										}
																									>
																										<span class="table-val-warn" title="Path looks malformed or points outside the workspace">
																											{value()}
																										</span>
																									</Show>
																								}
																							>
																								{(fl) => (
																									<button
																										type="button"
																										tabindex={cellTabIndex()}
																										class={["link table-cell-link", { "table-val-warn": fl().missing }]}
																										title={
																											fl().missing
																												? `${value().trim()} — file not found in workspace`
																												: `Open ${value().trim()} (Click or Ctrl+Click)`
																										}
																										onClick={(e) => (e.stopPropagation(), void openFile(fl().path))}
																										onDblClick={(e) => e.stopPropagation()}
																									>
																										{value()}
																									</button>
																								)}
																							</Show>
																						}
																					>
																						{(doc) => (
																							<button
																								type="button"
																								tabindex={cellTabIndex()}
																								class="link table-cell-link"
																								title={`Open schema doc: ${relativeTo(state.workspace?.root, doc().path)} (Click or Ctrl+Click)`}
																								onClick={(e) => (e.stopPropagation(), void openFile(doc().path))}
																								onDblClick={(e) => e.stopPropagation()}
																							>
																								{value()}
																							</button>
																						)}
																					</Show>
																				}
																			>
																				{ticketCell(value(), cellTabIndex)}
																			</Show>
																			<Show when={checkedHere()}>
																				{(chk) => (
																					<>
																						{() => {
																							const trimmed = value().trim();
																							if (!trimmed) return null;
																							const count = chk().counts.get(termLookupKey(trimmed, chk().caseSensitive));
																							return renderCheckBadge(trimmed, count, chk().options, cellTabIndex());
																						}}
																					</>
																				)}
																			</Show>
																		</>
																	}
																>
																	{/* Split comma/semicolon list cell with per-term code check counts */}
																	<For each={value().split(/([,;\r\n]+\s*)/)}>
																		{(part) => {
																			const trimmed = part.trim();
																			if (!trimmed || /^[,;\r\n]+$/.test(trimmed)) return part;
																			return (
																				<>
																					{part}
																					{() => {
																						const chk = checkedHere();
																						if (!chk) return null;
																						const count = chk.counts.get(termLookupKey(trimmed, chk.caseSensitive));
																						return renderCheckBadge(trimmed, count, chk.options, cellTabIndex());
																					}}
																				</>
																			);
																		}}
																	</For>
																</Show>
															}
														>
															{(ed) => {
																let done = false;
																const rowIdx = ed.row;
																const targetCol = ed.column;
																const seed = ed.seed;
																const initialCellText = untrack(value);
																const initVal = seed !== undefined ? seed : initialCellText;
																const finish = (val: string, move: CommitMove) => {
																	if (done) return;
																	done = true;
																	commitCell(rowIdx, targetCol, val, move);
																};
																commitActiveEdit = finish;
																const multiline = Boolean(ed.forceMultiline) || (seed === undefined && /[\r\n]/.test(initialCellText));
																if (multiline) {
																	return (
																		<textarea
																			class="table-cell-multiline"
																			value={initVal}
																			rows={Math.min(6, Math.max(2, initVal.split(/\r?\n/).length))}
																			aria-label={`${headerName(targetCol) || "Cell"}, row ${rowIdx + 1} (Ctrl+Enter to save)`}
																			ref={(el) =>
																				queueMicrotask(() => {
																					if (!el.isConnected) return;
																					el.focus();
																					if (seed !== undefined) {
																						const pos = ed.caret ?? seed.length;
																						el.setSelectionRange(pos, pos);
																					} else {
																						el.select();
																					}
																				})
																			}
																			onKeyDown={(e) => {
																				e.stopPropagation();
																				if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
																					e.preventDefault();
																					finish(e.currentTarget.value, cellRange()?.isMulti ? "range" : "down");
																				} else if (e.key === "Tab") {
																					e.preventDefault();
																					finish(e.currentTarget.value, e.shiftKey ? "prev" : "next");
																				} else if (e.key === "Escape") {
																					e.preventDefault();
																					done = true;
																					setEditing(null);
																					focusCell(rowIdx, targetCol);
																				}
																			}}
																			onBlur={(e) => finish(e.currentTarget.value, "none")}
																		/>
																	);
																}
																return (
																	<input
																		role="combobox"
																		aria-autocomplete="list"
																		aria-expanded={pickerOpen() && pickerOptions().length > 0 ? "true" : "false"}
																		aria-controls={pickerOpen() && pickerOptions().length > 0 ? pickerListboxId : undefined}
																		value={initVal}
																		aria-label={`${headerName(targetCol) || "Cell"}, row ${rowIdx + 1} (Shift+Enter for new line)`}
																		ref={(el) => {
																			activeInputEl = el;
																			queueMicrotask(() => {
																				if (!el.isConnected) return;
																				el.focus();
																				if (seed !== undefined) el.setSelectionRange(seed.length, seed.length);
																				else el.select();
																				setPickerAnchor(el.getBoundingClientRect());
																			});
																		}}
																		onInput={(e) => {
																			setEditDraft(e.currentTarget.value);
																			setEditDirty(true);
																			setPickerOpen(true);
																			setPickerIdx(-1);
																			setPickerAnchor(e.currentTarget.getBoundingClientRect());
																		}}
																		onKeyDown={(e) => {
																			e.stopPropagation();
																			const opts = pickerOptions();
																			if (pickerOpen() && opts.length > 0) {
																				if (e.key === "ArrowDown") {
																					e.preventDefault();
																					setPickerIdx((i) => (i + 1) % opts.length);
																					return;
																				}
																				if (e.key === "ArrowUp") {
																					e.preventDefault();
																					setPickerIdx((i) => (i <= 0 ? opts.length - 1 : i - 1));
																					return;
																				}
																			}
																			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
																				e.preventDefault();
																				const chosen = pickerOpen() && pickerIdx() >= 0 ? opts[pickerIdx()] : undefined;
																				const val = chosen ? resolvePickerChoice(chosen.value, e.currentTarget.value) : e.currentTarget.value;
																				finish(val, cellRange()?.isMulti ? "range" : "stay");
																			} else if (e.key === "Enter" && (e.shiftKey || e.altKey)) {
																				e.preventDefault();
																				const el = e.currentTarget;
																				const at = el.selectionStart ?? el.value.length;
																				const nextSeed = `${el.value.slice(0, at)}\n${el.value.slice(el.selectionEnd ?? at)}`;
																				done = true;
																				const nextEdit = { ghost: false as const, row: rowIdx, column: targetCol, seed: nextSeed, forceMultiline: true, caret: at + 1 };
																				setTimeout(() => setEditing(nextEdit), 0);
																			} else if (e.key === "Enter") {
																				e.preventDefault();
																				const chosen = pickerOpen() && pickerIdx() >= 0 ? opts[pickerIdx()] : undefined;
																				const val = chosen ? resolvePickerChoice(chosen.value, e.currentTarget.value) : e.currentTarget.value;
																				finish(val, "down");
																			} else if (e.key === "Tab") {
																				e.preventDefault();
																				const chosen = pickerOpen() && pickerIdx() >= 0 ? opts[pickerIdx()] : undefined;
																				const val = chosen ? resolvePickerChoice(chosen.value, e.currentTarget.value) : e.currentTarget.value;
																				finish(val, e.shiftKey ? "prev" : "next");
																			} else if (e.key === "Escape") {
																				e.preventDefault();
																				done = true;
																				setEditing(null);
																				focusCell(rowIdx, targetCol);
																			}
																		}}
																		onBlur={(e) => finish(e.currentTarget.value, "none")}
																	/>
																);
															}}
														</Show>
														<Show when={hasFillHandle()}>
															<div
																class="table-fill-handle"
																aria-hidden="true"
																title="Drag to fill series (hold Alt to copy without incrementing)"
																onPointerDown={onFillHandlePointerDown}
																onDblClick={(e) => (e.stopPropagation(), e.preventDefault())}
															/>
														</Show>
													</td>
												);
											}}
										</For>
									</tr>
								);
							}}
						</For>
						<Show when={virtualWindow().bottomPad > 0}>
							<tr class="table-virt-spacer" aria-hidden="true">
								<td colspan={visibleColumns().length + 1} style={{ height: `${virtualWindow().bottomPad}px`, padding: "0", border: "0" }} />
							</tr>
						</Show>
					</tbody>

					{/* Blank final row: lives outside tbody and writes nothing to the file until content is entered. */}
					<Show when={table().header.length > 0}>
						<tfoot ref={foot}>
							<tr class="table-ghost-row">
								<td class="table-sel-col" aria-hidden="true" />
								<For each={visibleColumns()} keyed={false}>
									{(colAcc, visIdx) => {
										const col = () => colAcc();
										const openGhostEdit = () => {
											const ed = editing();
											return ed && ed.ghost && ed.column === col() ? ed : null;
										};
										const open = () => openGhostEdit() !== null;
										const colLabel = () => headerName(col()) || `Column ${col() + 1}`;
										const isFrozen = () => visIdx < visibleFrozenCount();
										const isLastFrozen = () => isFrozen() && visIdx === visibleFrozenCount() - 1;
										return (
											<td
												tabindex={isRovingGhostCell(col()) ? 0 : -1}
												data-col={col()}
												style={cellStyle(col(), visIdx)}
												class={{
													"ghost-editing": open(),
													"col-frozen": isFrozen(),
													"col-frozen-last": isLastFrozen(),
													"cell-selected": isGhostSelected(col()),
													"cell-editing": open(),
												}}
												title={`Click or press Enter to add a new row (${colLabel()})`}
												onMouseDown={() => setActiveCell({ ghost: true, column: col() })}
												onFocus={() => setActiveCell({ ghost: true, column: col() })}
												onClick={(e) => {
													if (e.button !== 0 || open()) return;
													setEditing({ ghost: true, column: col() });
												}}
												onKeyDown={(e) => onGhostKey(e, col())}
												onContextMenu={(e) => void onGhostContextMenu(e, col())}
											>
												<Show
													when={openGhostEdit()}
													keyed
													fallback={
														<Show when={visIdx === 0}>
															<span class="table-ghost-placeholder">
																<Icon name="add" /> New row…
															</span>
														</Show>
													}
												>
													{(ed) => {
														let done = false;
														const targetCol = ed.column;
														const seed = ed.seed ?? "";
														const finish = (val: string, move: CommitMove) => {
															if (done) return;
															done = true;
															commitGhost(targetCol, val, move);
														};
														commitActiveEdit = finish;
														return (
															<input
																role="combobox"
																aria-autocomplete="list"
																aria-expanded={pickerOpen() && pickerOptions().length > 0 ? "true" : "false"}
																aria-controls={pickerOpen() && pickerOptions().length > 0 ? pickerListboxId : undefined}
																value={seed}
																placeholder={colLabel()}
																aria-label={`New row, ${colLabel()}`}
																ref={(el) => {
																	activeInputEl = el;
																	queueMicrotask(() => {
																		if (!el.isConnected) return;
																		el.focus();
																		if (seed) el.setSelectionRange(seed.length, seed.length);
																		setPickerAnchor(el.getBoundingClientRect());
																	});
																}}
																onInput={(e) => {
																	setEditDraft(e.currentTarget.value);
																	setEditDirty(true);
																	setPickerOpen(true);
																	setPickerIdx(-1);
																	setPickerAnchor(e.currentTarget.getBoundingClientRect());
																}}
																onKeyDown={(e) => {
																	e.stopPropagation();
																	const opts = pickerOptions();
																	if (pickerOpen() && opts.length > 0) {
																		if (e.key === "ArrowDown") {
																			e.preventDefault();
																			setPickerIdx((i) => (i + 1) % opts.length);
																			return;
																		}
																		if (e.key === "ArrowUp") {
																			e.preventDefault();
																			setPickerIdx((i) => (i <= 0 ? opts.length - 1 : i - 1));
																			return;
																		}
																	}
																	if (e.key === "Enter") {
																		e.preventDefault();
																		const chosen = pickerOpen() && pickerIdx() >= 0 ? opts[pickerIdx()] : undefined;
																		const val = chosen ? resolvePickerChoice(chosen.value, e.currentTarget.value) : e.currentTarget.value;
																		finish(val, "down");
																	} else if (e.key === "Tab") {
																		e.preventDefault();
																		const chosen = pickerOpen() && pickerIdx() >= 0 ? opts[pickerIdx()] : undefined;
																		const val = chosen ? resolvePickerChoice(chosen.value, e.currentTarget.value) : e.currentTarget.value;
																		finish(val, e.shiftKey ? "prev" : "next");
																	} else if (e.key === "Escape") {
																		e.preventDefault();
																		done = true;
																		setEditing(null);
																		focusGhostCell(targetCol);
																	}
																}}
																onBlur={(e) => finish(e.currentTarget.value, "none")}
															/>
														);
													}}
												</Show>
											</td>
										);
									}}
								</For>
							</tr>
						</tfoot>
					</Show>
				</table>

				<Show when={table().rows.length > 0 && rows().length === 0}>
					<p class="hint">
						No rows match the active filters.{" "}
						<button type="button" class="link" onClick={clearAllFilters}>
							Clear filters
						</button>
					</p>
				</Show>
			</div>

			{/* Compact footer summary strip: visible/total rows, clickable status tally pills, and range / focused column statistics. */}
			<Show when={table().header.length > 0}>
				<div class="table-footer" role="status" aria-label="Table summary">
					<span class="table-footer-left">
						<span>
							Showing <strong class="table-footer-val">{footerStats().shown}</strong>/{footerStats().total}{" "}
							{footerStats().total === 1 ? "row" : "rows"}
						</span>
						<span class="table-footer-sep" aria-hidden="true" />
						<span>
							Selected <strong class="table-footer-val">{footerStats().selected}</strong>
						</span>
						<Show when={statusTally() && statusTally()!.by.length > 0}>
							{(() => {
								const stCol = () => exactStatusCol();
								const stRule = () => (stCol() >= 0 ? columnRule(stCol()) : null);
								const entries = () => statusTally()!.by.slice(0, 8);
								const extraCount = () => Math.max(0, statusTally()!.by.length - 8);
								return (
									<>
										<span class="table-footer-sep" aria-hidden="true" />
										<span class="table-status-strip" role="group" aria-label="Filter by status">
											<For each={entries()}>
												{([statusKey, count]) => {
													const tone = () => badgeToneForValue(stRule(), statusKey) ?? "waiting";
													const label = () => statusKey || "(empty)";
													const isActive = () => activeSingleStatusFilter() === statusKey;
													return (
														<button
															type="button"
															class={`doc-status tone-${tone()} table-status-pill`}
															aria-pressed={isActive() ? "true" : "false"}
															title={
																isActive()
																	? `Showing status “${label()}” (${count}). Click to clear status filter.`
																	: `Filter by status “${label()}” (${count})`
															}
															onClick={() => toggleStatusTallyFilter(statusKey)}
														>
															<span>{label()}</span>
															<span class="table-status-pill-count">{count}</span>
														</button>
													);
												}}
											</For>
											<Show when={extraCount() > 0}>
												<span class="hint">+{extraCount()} more</span>
											</Show>
										</span>
									</>
								);
							})()}
						</Show>
					</span>
					<Show when={footerStats().colName}>
						<span class="table-footer-right">
							<span class="table-footer-col" title={footerStats().colName}>
								{footerStats().colName}
							</span>
							<Show when={footerStats().isRange}>
								<span>
									Count <strong class="table-footer-val">{footerStats().cellCount}</strong>
								</span>
								<span class="table-footer-sep" aria-hidden="true" />
							</Show>
							<span>
								Non-empty <strong class="table-footer-val">{footerStats().nonEmpty}</strong>
							</span>
							<span class="table-footer-sep" aria-hidden="true" />
							<span>
								Distinct <strong class="table-footer-val">{footerStats().distinct}</strong>
							</span>
							<Show when={footerStats().sum !== null}>
								<span class="table-footer-sep" aria-hidden="true" />
								<span>
									Sum <strong class="table-footer-val">{footerStats().sum}</strong>
								</span>
							</Show>
							<Show when={footerStats().avg !== null}>
								<span class="table-footer-sep" aria-hidden="true" />
								<span>
									Avg <strong class="table-footer-val">{footerStats().avg}</strong>
								</span>
							</Show>
						</span>
					</Show>
				</div>
			</Show>

			{/* Portaled custom cell dropdown picker (badge pills, multi-ticket suggestions, or distinct column values). */}
			<Show when={editing() && pickerOpen() && pickerAnchor() && pickerOptions().length > 0}>
				{(() => {
					const opts = () => pickerOptions();
					const posStyle = (): JSX.CSSProperties => {
						const rect = pickerAnchor()!;
						const minW = Math.max(176, Math.round(rect.width));
						const maxW = Math.min(340, window.innerWidth - 16);
						const popW = Math.min(Math.max(minW, 220), maxW);
						const estH = Math.min(240, opts().length * 30 + 12);
						const left = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 8));
						const fitsBelow = rect.bottom + 4 + estH <= window.innerHeight - 8;
						const top = fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - estH - 4);
						return { left: `${left}px`, top: `${top}px`, "min-width": `${Math.min(minW, maxW)}px` };
					};
					return (
						<Portal>
							<div
								id={pickerListboxId}
								class="table-cell-picker"
								role="listbox"
								aria-label="Cell suggestions"
								style={posStyle()}
								onMouseDown={(e) => e.preventDefault()}
							>
								<For each={opts()}>
									{(opt, idx) => {
										const isActive = () => pickerIdx() === idx();
										let optEl: HTMLButtonElement | undefined;
										createEffect(
											() => isActive(),
											(active) => {
												if (active) optEl?.scrollIntoView({ block: "nearest" });
											},
										);
										return (
											<button
												type="button"
												role="option"
												aria-selected={isActive() ? "true" : "false"}
												class={["table-cell-picker-opt", { active: isActive(), current: Boolean(opt.isCurrent) }]}
												ref={(el) => {
													optEl = el;
												}}
												onMouseEnter={() => setPickerIdx(idx())}
												onClick={() => {
													const baseVal = activeInputEl?.value ?? editDraft();
													const nextVal = resolvePickerChoice(opt.value, baseVal);
													commitActiveEdit?.(nextVal, "down");
												}}
											>
												<Show
													when={opt.tone}
													fallback={<span class="table-cell-picker-val">{opt.value}</span>}
												>
													{(tone) => <span class={`doc-status tone-${tone()}`}>{opt.value}</span>}
												</Show>
												<Show when={opt.meta}>
													<span class="table-cell-picker-meta" title={opt.meta}>
														{opt.meta}
													</span>
												</Show>
												<Show when={opt.isCurrent}>
													<span class="table-cell-picker-check" aria-hidden="true">
														<Icon name="check" />
													</span>
												</Show>
											</button>
										);
									}}
								</For>
							</div>
						</Portal>
					);
				})()}
			</Show>

			{/* Portaled per-column header filter popover (measured post-mount via placeAnchoredMenu so it flips cleanly in split panes). */}
			<Show when={filterMenu()}>
				{(menu) => {
					const col = () => menu().column;
					const colName = () => headerName(col()) || `Column ${col() + 1}`;
					const curFilter = () => colFilters().get(col());
					const allOptions = createMemo(() => optionsForColumn(col()));
					const allKeys = createMemo(() => allOptions().map((o) => o.key));
					const visibleOptions = createMemo(() => {
						const q = (curFilter()?.text ?? "").trim().toLowerCase();
						const list = q ? allOptions().filter((o) => (o.label || "(empty)").toLowerCase().includes(q)) : allOptions();
						return list.slice(0, FILTER_VALUES_CAP);
					});
					const rule = () => columnRule(col());
					const isChecked = (key: string) => {
						const vals = curFilter()?.values;
						return vals == null ? true : vals.has(key);
					};
					const setTextFilter = (val: string) => {
						const existing = curFilter();
						setColumnFilter(col(), { text: val, values: existing?.values ?? null });
					};
					const toggleKey = (key: string) => {
						setColumnFilter(col(), toggleColumnFilterValue(curFilter(), key, allKeys()));
					};
					const selectOnly = (key: string) => {
						setColumnFilter(col(), { text: curFilter()?.text ?? "", values: new Set([key]) });
					};
					const selectAllValues = () => {
						const txt = curFilter()?.text ?? "";
						setColumnFilter(col(), txt.trim() ? { text: txt, values: null } : undefined);
					};
					const selectNoneValues = () => {
						setColumnFilter(col(), { text: curFilter()?.text ?? "", values: new Set() });
					};
					const [popPos, setPopPos] = createSignal<{ left: number; top: number; maxHeight: number }>(() => ({
						left: menu().x,
						top: menu().y,
						maxHeight: menu().maxHeight,
					}));
					let popEl: HTMLDivElement | undefined;
					const remeasurePopover = () => {
						const cur = menu();
						if (!popEl || !cur.anchor.isConnected) return;
						const anchorRect = cur.anchor.getBoundingClientRect();
						const popRect = popEl.getBoundingClientRect();
						const measuredW = Math.ceil(popRect.width) || Math.min(280, window.innerWidth - 16);
						const measuredH = Math.ceil(popRect.height) || 260;
						const placed = placeAnchoredMenu(
							anchorRect,
							{ width: measuredW, height: measuredH },
							{ width: window.innerWidth, height: window.innerHeight },
							8,
							4,
						);
						setPopPos((prev) =>
							Math.abs(prev.left - placed.left) < 1 &&
							Math.abs(prev.top - placed.top) < 1 &&
							Math.abs(prev.maxHeight - placed.maxHeight) < 1
								? prev
								: { left: placed.left, top: placed.top, maxHeight: placed.maxHeight },
						);
					};
					createEffect(
						() => [menu(), visibleOptions()] as const,
						() => {
							const raf = requestAnimationFrame(remeasurePopover);
							const onWinResize = () => remeasurePopover();
							window.addEventListener("resize", onWinResize);
							let ro: ResizeObserver | undefined;
							if (typeof ResizeObserver !== "undefined" && popEl) {
								ro = new ResizeObserver(remeasurePopover);
								ro.observe(popEl);
							}
							return () => {
								cancelAnimationFrame(raf);
								window.removeEventListener("resize", onWinResize);
								ro?.disconnect();
							};
						},
					);
					return (
						<Portal>
							<div
								ref={(el) => {
									popEl = el;
									queueMicrotask(remeasurePopover);
								}}
								class="table-filter-pop"
								role="dialog"
								aria-label={`Filter ${colName()}`}
								style={{
									left: `${popPos().left}px`,
									top: `${popPos().top}px`,
									"max-height": `${Math.min(400, popPos().maxHeight)}px`,
								}}
							>
								<div class="table-filter-head">
									<span class="table-filter-title" title={colName()}>
										{colName()}
									</span>
									<div class="table-filter-sort-btns" role="group" aria-label={`Sort ${colName()}`}>
										<button
											type="button"
											class={["icon-btn", { active: order().some((s) => s.column === col() && !s.down) }]}
											title="Sort ascending (Shift+Click to add secondary sort)"
											aria-label="Sort ascending"
											onClick={(e) => setOrder((prev) => setColumnSortDirection(prev, col(), false, e.shiftKey))}
										>
											<Icon name="arrow-up" />
										</button>
										<button
											type="button"
											class={["icon-btn", { active: order().some((s) => s.column === col() && s.down) }]}
											title="Sort descending (Shift+Click to add secondary sort)"
											aria-label="Sort descending"
											onClick={(e) => setOrder((prev) => setColumnSortDirection(prev, col(), true, e.shiftKey))}
										>
											<Icon name="arrow-down" />
										</button>
										<button type="button" class="icon-btn" title="Close (Esc)" aria-label="Close filter" onClick={() => closeFilterMenu(true)}>
											<Icon name="close" />
										</button>
									</div>
								</div>

								<div class="table-filter-search-wrap">
									<input
										type="search"
										class="table-filter-search"
										placeholder={`Filter ${colName()}…`}
										aria-label={`Filter ${colName()} by text`}
										value={curFilter()?.text ?? ""}
										ref={(el) => queueMicrotask(() => el.focus())}
										onInput={(e) => setTextFilter(e.currentTarget.value)}
									/>
								</div>

								<div class="table-filter-actions">
									<button type="button" class="link" onClick={selectAllValues}>
										Select all
									</button>
									<button type="button" class="link" onClick={selectNoneValues}>
										None
									</button>
									<span class="spacer" />
									<Show when={isColFiltered(col())}>
										<button type="button" class="link table-filter-clear" onClick={() => setColumnFilter(col(), undefined)}>
											Clear filter
										</button>
									</Show>
								</div>

								<div class="table-filter-list" role="group" aria-label={`Values in ${colName()}`}>
									<Show when={visibleOptions().length} fallback={<p class="table-filter-empty">No matching values.</p>}>
										<For each={visibleOptions()} keyed={(o) => o.key}>
											{(opt) => {
												const tone = () => badgeToneForValue(rule(), opt().label);
												return (
													<div class={["table-filter-item", { zero: opt().count === 0 }]}>
														<label class="table-filter-check">
															<input type="checkbox" checked={isChecked(opt().key)} onChange={() => toggleKey(opt().key)} />
															<Show
																when={opt().label}
																fallback={<span class="table-filter-blank">(empty)</span>}
															>
																<Show when={tone()} fallback={<span class="table-filter-val" title={opt().label}>{opt().label}</span>}>
																	{(t) => <span class={`doc-status tone-${t()}`}>{opt().label}</span>}
																</Show>
															</Show>
														</label>
														<button
															type="button"
															class="table-filter-only"
															title={`Show only ${opt().label || "(empty)"}`}
															onClick={() => selectOnly(opt().key)}
														>
															Only
														</button>
														<span class="table-filter-count">{opt().count}</span>
													</div>
												);
											}}
										</For>
									</Show>
									<Show when={allOptions().length > FILTER_VALUES_CAP}>
										<p class="table-filter-empty">Showing first {FILTER_VALUES_CAP} of {allOptions().length} values. Type above to narrow.</p>
									</Show>
								</div>

								<div class="table-filter-foot">
									<Show
										when={rule()}
										fallback={
											<button
												type="button"
												class="table-filter-fmt-btn"
												onClick={() => {
													const name = headerName(col());
													closeFilterMenu(false);
													setFormatDialog({ open: true, initialColumn: name });
												}}
											>
												<Icon name="tag" />
												<span>Format “{colName()}” as badges…</span>
											</button>
										}
									>
										<div class="table-filter-fmt-active">
											<span class="table-filter-fmt-label">
												<Icon name="tag" /> Badges active
											</span>
											<span class="spacer" />
											<button
												type="button"
												class="link"
												onClick={() => {
													const name = headerName(col());
													closeFilterMenu(false);
													setFormatDialog({ open: true, initialColumn: name });
												}}
											>
												Configure…
											</button>
											<button
												type="button"
												class="link"
												onClick={() => {
													const name = headerName(col());
													closeFilterMenu(false);
													void disableBadgeForColumn(name);
												}}
											>
												Turn off
											</button>
										</div>
									</Show>
								</div>
							</div>
						</Portal>
					);
				}}
			</Show>

			{/* Configurable CSV column badge formatting modal. */}
			<Show when={formatDialog().open}>
				<CsvFormatDialog
					table={table()}
					initialColumn={formatDialog().initialColumn}
					onClose={() => setFormatDialog({ open: false })}
				/>
			</Show>

			{/* Floating drag ghost pill while dragging a column header or row grip. */}
			<Show when={colDrag()}>
				{(drag) => (
					<Portal>
						<div
							class="table-col-drag-ghost"
							style={{ left: `${drag().x + 12}px`, top: `${drag().y + 12}px` }}
							aria-hidden="true"
						>
							{drag().label}
						</div>
					</Portal>
				)}
			</Show>
			<Show when={rowDrag()}>
				{(drag) => (
					<Portal>
						<div
							class="table-col-drag-ghost"
							style={{ left: `${drag().x + 12}px`, top: `${drag().y + 12}px` }}
							aria-hidden="true"
						>
							{drag().label}
						</div>
					</Portal>
				)}
			</Show>

			{/* Targeted "Check values in code" modal. */}
			<Show when={checkDialog().open}>
				<CsvCodeCheckDialog
					table={table()}
					filteredRows={rows().map((r) => r.cells)}
					checkedRows={visibleSelectedRows().map((i) => table().rows[i]!).filter(Boolean)}
					hasActiveFilters={hasActiveFilters()}
					selectedRow={
						current() !== null && table().rows[current()!]
							? { index: current()!, cells: table().rows[current()!]! }
							: null
					}
					initialColumn={checkDialog().column}
					initialRowScope={checkDialog().rowScope}
					defaultExclude={defaultExclude()}
					lastSpec={lastCheckSpec()}
					onRun={(spec) => {
						setCheckDialog({ open: false, column: spec.column });
						void runCodeCheck(spec);
					}}
					onClose={() => setCheckDialog({ open: false, column: checkDialog().column })}
				/>
			</Show>
		</div>
	);
}
