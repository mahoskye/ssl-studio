// A table of values (CSV or TSV), as a table. It is a view of the text in the
// editor (ADR 0002): a cell changed here is that cell's part of the text
// changed, and nothing else; the Text switch shows the same file as written.
//
// Each column header offers sorting and a value/text filter menu, column badge
// formatting is driven strictly by the user/project `csvTable` configuration,
// row/cell/column actions live in right-click context menus, a blank final row
// lets users add entries without writing empty lines until content is entered,
// and code-usage checks target the exact column, rows, and file globs chosen.
import { createEffect, createMemo, createSignal, createUniqueId, For, Index, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import {
	addCsvColumn,
	appendRowEdit,
	columnOf,
	csvCell,
	csvDuplicateKeys,
	csvRow,
	deleteCsvColumn,
	deleteCsvRows,
	insertRowEdit,
	parseClipboardGrid,
	parseCsv,
	rawRowText,
	renameCsvColumn,
	reorderCsvColumns,
	rowSpan,
	sortCsvRows,
	tableToMarkdown,
	tableToTsv,
	type Cell,
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
import { baseName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { keyOf, keysIn, ticketColumn } from "../../shared/registryTickets";
import { SEARCH_LIMIT, type SearchOptions } from "../../shared/searchPattern";
import { extractSqlObjects } from "../../shared/sqlSchema";
import { backend } from "../backend";
import { copyText } from "../commands";
import { ask, choose } from "../dialogs";
import { Icon } from "../Icon";
import { modalOpen } from "../modal";
import { chooseFromMenu, rowMenuOpen, type RowMenuEntry } from "../panels/RowMenu";
import { searchFor } from "../panels/Search";
import { docs } from "../project";
import { canonical, documents, notify, openFile, saveSetting, state } from "../state";
import { CsvCodeCheckDialog } from "./CsvCodeCheckDialog";
import { CsvFormatDialog } from "./CsvFormatDialog";
import { rowsAsked, rowsShown } from "./tableRows";

/** As many rows as are drawn at once. A longer table is narrowed with filters. */
const ROWS_SHOWN = 500;

/** Maximum distinct values rendered in a column filter checklist before asking the user to narrow via search. */
const FILTER_VALUES_CAP = 250;

/** Minimum column width (px) when manually dragging a resize handle. */
const MIN_COL_WIDTH = 56;

/** Upper cap (px) when double-clicking a column divider to auto-fit long cells. */
const MAX_AUTOFIT_WIDTH = 960;

type OpenFilterMenu = {
	column: number;
	x: number;
	y: number;
	anchor: HTMLElement;
};

type ActiveCell =
	| { ghost: false; row: number; column: number }
	| { ghost: true; column: number };

type EditingCell =
	| { ghost: false; row: number; column: number; seed?: string; forceMultiline?: boolean }
	| { ghost: true; column: number; seed?: string; forceMultiline?: boolean };

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

const shortLabel = (text: string, max = 26) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function menuPoint(e: MouseEvent, fallbackEl: Element | null): { x: number; y: number } {
	if (e.clientX || e.clientY || !fallbackEl) return { x: e.clientX, y: e.clientY };
	const rect = fallbackEl.getBoundingClientRect();
	return { x: rect.left + 8, y: rect.bottom };
}

export function TableView(props: { path: string }) {
	const model = documents.get(props.path)?.model;
	let rootEl: HTMLDivElement | undefined;
	const [text, setText] = createSignal(model?.getValue() ?? "");
	type ColumnUiSnapshot = {
		colFilters: Map<number, ColumnFilter>;
		order: { column: number; down: boolean } | null;
		frozenCols: number[];
		hiddenCols: Set<number>;
		colOrder: number[];
		colWidths: Record<number, number>;
		codeCheck: CodeCheckResult | null;
	};
	const colSnapshots = new Map<number, ColumnUiSnapshot>();
	const captureColUi = (): ColumnUiSnapshot => ({
		colFilters: new Map(colFilters()),
		order: order() ? { ...order()! } : null,
		frozenCols: [...frozenCols()],
		hiddenCols: new Set(hiddenCols()),
		colOrder: [...colOrder()],
		colWidths: { ...colWidths() },
		codeCheck: codeCheck() ? { ...codeCheck()! } : null,
	});
	const restoreColUi = (snap: ColumnUiSnapshot) => {
		setColFilters(new Map(snap.colFilters));
		setOrder(snap.order ? { ...snap.order } : null);
		setFrozenCols([...snap.frozenCols]);
		setHiddenCols(new Set(snap.hiddenCols));
		setColOrder([...snap.colOrder]);
		setColWidths({ ...snap.colWidths });
		setCodeCheck(snap.codeCheck ? { ...snap.codeCheck } : null);
	};
	const listener = model?.onDidChangeContent(() => {
		const next = model.getValue();
		setText(next);
		const snap = colSnapshots.get(model.getAlternativeVersionId());
		if (snap) restoreColUi(snap);
		const count = table().rows.length;
		const cur = current();
		if (cur !== null && cur >= count) setCurrent(count > 0 ? count - 1 : null);
	});
	onCleanup(() => listener?.dispose());

	const table = createMemo(() => parseCsv(text()));
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
	const current = () => {
		const ac = activeCell();
		return ac && !ac.ghost ? ac.row : null;
	};
	const setCurrent = (row: number | null) => {
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
		setActiveCell(null);
		if (document.activeElement instanceof HTMLElement && document.activeElement.closest(".table-view td")) {
			document.activeElement.blur();
		}
	};

	// Press Escape (when no edit input, popover, menu, modal, or column drag is active) to clear cell selection.
	createEffect(() => {
		if (!activeCell()) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			if (editing() || filterMenu() || colDrag() || modalOpen() || rowMenuOpen()) return;
			const target = e.target as HTMLElement | null;
			if (target?.closest("input, textarea")) return;
			e.preventDefault();
			clearCellSelection();
		};
		window.addEventListener("keydown", onKeyDown);
		onCleanup(() => window.removeEventListener("keydown", onKeyDown));
	});

	/** Selected row indices (0-based in `table().rows`) for bulk operations. */
	const [selectedRows, setSelectedRows] = createSignal<Set<number>>(new Set());
	const [lastClickedRow, setLastClickedRow] = createSignal<number | null>(null);
	/** Current pagination window size (expands via "Show more" / "Show all"). */
	const [rowLimit, setRowLimit] = createSignal(ROWS_SHOWN);
	createEffect(() => {
		props.path;
		setRowLimit(ROWS_SHOWN);
		setSelectedRows(new Set<number>());
		setLastClickedRow(null);
	});
	// Prune selected row indices when rows are deleted from the file.
	createEffect(() => {
		const rowCount = table().rows.length;
		const sel = selectedRows();
		if (!sel.size) return;
		let dirty = false;
		for (const r of sel) if (r < 0 || r >= rowCount) dirty = true;
		if (dirty) {
			const next = new Set<number>();
			for (const r of sel) if (r >= 0 && r < rowCount) next.add(r);
			setSelectedRows(next);
		}
	});

	/** Keeps a newly created/inserted row visible while editing even when filters are active. */
	const [pinnedRow, setPinnedRow] = createSignal<number | null>(null);
	/** The column the rows are ordered by here, and which way; the file's own order is not changed. */
	const [order, setOrder] = createSignal<{ column: number; down: boolean } | null>(null);
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
	/** Complete left-to-right column order (including hidden columns) used when applying order to the file. */
	const fullColumns = createMemo(() =>
		fullColumnOrder(table().header.length, frozenCols(), colOrder().length ? colOrder() : undefined),
	);
	/** Visual left-to-right column order: frozen columns first, then remaining visible columns in current base order. */
	const visibleColumns = createMemo(() =>
		visualColumnOrder(table().header.length, frozenCols(), colOrder().length ? colOrder() : undefined, hiddenCols()),
	);
	const hasCustomOrder = createMemo(
		() => colOrder().length > 0 && !isNaturalOrder(pruneColumnOrder(colOrder(), table().header.length)),
	);
	const differsFromFile = createMemo(() => !isNaturalOrder(fullColumns()));
	const hasCustomWidths = createMemo(() => Object.keys(colWidths()).length > 0);
	const isFrozenCol = (col: number) => frozenCols().includes(col);
	const toggleFreeze = (col: number) => setFrozenCols((prev) => toggleFrozenColumn(prev, col));
	const unfreezeAll = () => setFrozenCols([]);
	const resetColumnOrder = () => setColOrder([]);
	const resetColumnWidths = () => setColWidths({});
	const cellStyle = (col: number, visIdx: number): JSX.CSSProperties | undefined => {
		const isFrozen = visIdx < frozenCols().length;
		const w = colWidths()[col];
		if (!isFrozen && w === undefined) return undefined;
		const style: JSX.CSSProperties = {};
		if (isFrozen) style.left = `${frozenLefts()[visIdx] ?? (visIdx === 0 ? 32 : 0)}px`;
		if (w !== undefined) {
			style.width = `${w}px`;
			style["min-width"] = `${w}px`;
			style["max-width"] = `${w}px`;
		}
		return style;
	};
	/** The cell currently being edited (either an existing row or the blank final ghost row). */
	const [editing, setEditing] = createSignal<EditingCell | null>(null);

	// Prune column filters, frozen/hidden columns, widths, custom order, popovers, or code-check state if columns were removed in Text view.
	createEffect(() => {
		const count = table().header.length;
		const cur = colFilters();
		let stale = false;
		for (const col of cur.keys()) {
			if (col < 0 || col >= count) stale = true;
		}
		if (stale) {
			const next = new Map<number, ColumnFilter>();
			for (const [col, f] of cur) if (col >= 0 && col < count) next.set(col, f);
			setColFilters(next);
		}
		const prunedFrozen = pruneFrozenColumns(frozenCols(), count);
		if (prunedFrozen.length !== frozenCols().length) setFrozenCols(prunedFrozen);
		const curHidden = hiddenCols();
		if (curHidden.size) {
			const prunedHidden = pruneHiddenColumns(curHidden, count);
			if (prunedHidden.size !== curHidden.size || [...prunedHidden].some((c) => !curHidden.has(c))) {
				setHiddenCols(prunedHidden);
			}
		}
		const curWidths = colWidths();
		const widthKeys = Object.keys(curWidths);
		if (widthKeys.some((k) => Number(k) < 0 || Number(k) >= count)) {
			const nextWidths: Record<number, number> = {};
			for (const k of widthKeys) {
				const idx = Number(k);
				if (idx >= 0 && idx < count) nextWidths[idx] = curWidths[idx]!;
			}
			setColWidths(nextWidths);
		}
		const curOrder = colOrder();
		if (curOrder.length) {
			const prunedOrder = pruneColumnOrder(curOrder, count);
			if (isNaturalOrder(prunedOrder)) setColOrder([]);
			else if (prunedOrder.length !== curOrder.length || prunedOrder.some((c, i) => c !== curOrder[i])) setColOrder(prunedOrder);
		}
		const ac = activeCell();
		if (ac && (ac.column < 0 || ac.column >= count)) {
			const fallbackCol = visibleColumns()[0];
			if (fallbackCol === undefined) setActiveCell(null);
			else setActiveCell(ac.ghost ? { ghost: true, column: fallbackCol } : { ghost: false, row: ac.row, column: fallbackCol });
		}
		const menu = filterMenu();
		if (menu && menu.column >= count) setFilterMenu(null);
		const curSort = order();
		if (curSort && (curSort.column < 0 || curSort.column >= count)) setOrder(null);
		const chk = codeCheck();
		if (chk && chk.column >= count) {
			setCodeCheck(null);
			setOnlyMissing(false);
		}
	});

	/** The ticket the rows are narrowed to: those whose ticket column names it, and no row that merely holds the same letters. */
	const [onlyTicket, setOnlyTicket] = createSignal<string | null>(null);
	// Rows asked for from a ticket's page.
	createEffect(() => {
		const asked = rowsAsked();
		if (!asked || canonical(asked.path) !== canonical(props.path)) return;
		setOnlyTicket(asked.ticket);
		setPinnedRow(null);
		rowsShown();
	});
	const ticketAt = () => ticketColumn(table());
	const tickets = createMemo(() => new Map(docs().flatMap((d) => (d.group === "tickets" && d.exists && d.ticket ? [[d.ticket.toLowerCase(), d] as const] : []))));
	/** The project's own keys: a word that is one of them names a ticket, however it is written. */
	const known = createMemo(() => new Set(tickets().keys()));
	const namesTicket = (cells: Cell[], key: string) => keysIn(cells[ticketAt()]?.text ?? "", known()).some((named) => named.toLowerCase() === key.toLowerCase());
	// A ticket no row names any more (the last was changed), or a table with no such column, has nothing to narrow to.
	createEffect(() => {
		const wanted = onlyTicket();
		if (wanted !== null && (ticketAt() < 0 || !table().rows.some((cells) => namesTicket(cells, wanted)))) setOnlyTicket(null);
	});

	/** Autocomplete suggestions for whichever cell is currently being edited (tickets, badge rules, or column distinct values). */
	const activeSuggestions = createMemo(() => {
		const ed = editing();
		if (!ed) return [];
		const existing = table().rows.map((r) => r[ed.column]?.text ?? "");
		if (ed.column === ticketAt()) {
			const seen = new Set<string>();
			const out: string[] = [];
			for (const d of docs()) {
				if (d.group !== "tickets" || !d.exists || !d.ticket) continue;
				const k = d.ticket.toLowerCase();
				if (seen.has(k)) continue;
				seen.add(k);
				out.push(d.ticket);
			}
			for (const val of existing) {
				const t = val.trim();
				if (!t || seen.has(t.toLowerCase())) continue;
				seen.add(t.toLowerCase());
				out.push(t);
			}
			return out;
		}
		const rule = columnRule(ed.column);
		if (rule) return suggestionsForColumn(rule, existing);
		// Offer distinct non-empty values for low-cardinality columns (e.g. Kind, Module, Owner).
		const distinct: string[] = [];
		const seen = new Set<string>();
		for (const val of existing) {
			const t = val.trim();
			if (!t || seen.has(t.toLowerCase())) continue;
			seen.add(t.toLowerCase());
			distinct.push(t);
			if (distinct.length > 40) return [];
		}
		return distinct;
	});
	const suggestionListId = createUniqueId();

	/** Default exclude glob list built from the workspace's docs, plans, and IDE metadata folders. */
	const defaultExclude = createMemo(() =>
		defaultExcludePattern([state.project?.docs ?? "docs", state.project?.plans ?? "design", ".ssl-studio"]),
	);

	/** Targeted code-usage check state (specific column, scope, match options, and cancellable progress). */
	const [codeCheck, setCodeCheck] = createSignal<CodeCheckResult | null>(null);
	const [checking, setChecking] = createSignal<{ done: number; total: number; columnName: string } | null>(null);
	const [onlyMissing, setOnlyMissing] = createSignal(false);
	let checkRunId = 0;
	onCleanup(() => {
		checkRunId++;
	});

	const cancelCodeCheck = () => {
		checkRunId++;
		setChecking(null);
	};

	const clearCodeCheck = () => {
		checkRunId++;
		setChecking(null);
		setCodeCheck(null);
		setOnlyMissing(false);
	};

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

	const runCodeCheck = async (spec: CodeCheckSpec, mergeExisting = false) => {
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

		const curIdx = current();
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
					if (runId !== checkRunId) {
						cancelled = true;
						return;
					}
					const term = terms[idx]!;
					const hits = await backend.search(term, options);
					if (runId !== checkRunId) {
						cancelled = true;
						return;
					}
					counts.set(termLookupKey(term, spec.caseSensitive), hits.length);
					completed++;
					setChecking({ done: completed, total: terms.length, columnName: colName });
				}
			};
			await Promise.all(Array.from({ length: Math.min(CONCURRENCY, terms.length) }, () => worker()));
			if (!cancelled || completed > 0) {
				setCodeCheck({
					column: spec.column,
					columnName: colName,
					splitLists: spec.splitLists,
					caseSensitive: spec.caseSensitive,
					options,
					counts,
				});
				if (![...counts.values()].some((n) => n === 0)) setOnlyMissing(false);
				notify(codeCheckSummary(colName, counts, cancelled));
			}
		} catch (e: any) {
			if (runId === checkRunId) {
				notify(`Code check failed: ${e?.message ?? e}`, "error");
			}
		} finally {
			if (runId === checkRunId) setChecking(null);
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

	/** A cell of the ticket column as it is written, each key of a ticket the project has as a way to that ticket. */
	const ticketCell = (value: string) => (
		<For each={value.split(/([\s,;/]+)/)}>
			{(part) => {
				const ticket = tickets().get(keyOf(part, known()).toLowerCase());
				return ticket ? (
					<button class="link table-ticket" title={`${ticket.ticket}: ${ticket.title ?? ""}${ticket.status ? ` (${ticket.status})` : ""}. Open the ticket.`} onClick={(e) => (e.stopPropagation(), void openFile(ticket.path))} onDblClick={(e) => e.stopPropagation()}>
						{part}
					</button>
				) : (
					part
				);
			}}
		</For>
	);

	/** Renders a checked cell's value alongside its targeted code-hit badge(s). */
	const renderCheckBadge = (term: string, count: number | undefined, opts: SearchOptions) => {
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
				class="link table-use"
				title={`Found ${countText} ${count === 1 ? "time" : "times"} in the searched code files. Click to view in Search.`}
				onClick={(e) => (e.stopPropagation(), searchFor(term, opts))}
				onDblClick={(e) => e.stopPropagation()}
			>
				{countText}×
			</button>
		);
	};

	/** Rows after global/ticket/missing filters, before per-column filters (used for faceted header counts). */
	const baseRows = createMemo(() => {
		const words = filter().trim().toLowerCase().split(/\s+/).filter(Boolean);
		const pinned = pinnedRow();
		const chk = codeCheck();
		let list = table().rows.map((cells, index) => ({ cells, index }));
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
		const by = order();
		if (by) {
			const value = (cells: Cell[]) => cells[by.column]?.text ?? "";
			list = [...list].sort((a, b) => value(a.cells).localeCompare(value(b.cells), undefined, { numeric: true, sensitivity: "base" }) * (by.down ? -1 : 1));
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
		() => Boolean(filter().trim()) || activeFilterCols().length > 0 || onlyTicket() !== null || onlyMissing(),
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
		const popW = Math.min(280, window.innerWidth - 16);
		const popH = 380;
		const idealX = rect.left + popW <= window.innerWidth - 8 ? rect.left : rect.right - popW;
		const x = Math.max(8, Math.min(idealX, window.innerWidth - popW - 8));
		const y = rect.bottom + 4 + popH <= window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - popH - 4);
		setFilterMenu({ column: col, x, y, anchor });
	};

	// Dismiss open filter popover on outside click or Escape.
	createEffect(() => {
		if (!filterMenu()) return;
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
		onCleanup(() => {
			window.removeEventListener("mousedown", onMouseDown, true);
			window.removeEventListener("keydown", onKeyDown, true);
		});
	});

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

	// Scroll-windowed virtualization when tables exceed 200 rows so 1,000+ row STARLIMS registries scroll smoothly at 60fps.
	const VIRTUAL_THRESHOLD = 200;
	const EST_ROW_H = 31;
	const VIRT_OVERSCAN = 20;
	const [scrollTop, setScrollTop] = createSignal(0);
	const [viewportH, setViewportH] = createSignal(640);

	const virtualWindow = createMemo(() => {
		const all = rows();
		if (all.length <= VIRTUAL_THRESHOLD) {
			return { virtual: false, start: 0, end: all.length, topPad: 0, bottomPad: 0 };
		}
		const start = Math.max(0, Math.floor(scrollTop() / EST_ROW_H) - VIRT_OVERSCAN);
		const visibleCount = Math.ceil((viewportH() || 640) / EST_ROW_H) + VIRT_OVERSCAN * 2;
		const end = Math.min(all.length, start + visibleCount);
		return {
			virtual: true,
			start,
			end,
			topPad: start * EST_ROW_H,
			bottomPad: Math.max(0, (all.length - end) * EST_ROW_H),
		};
	});

	/** The rows drawn: virtualized viewport slice for large tables (>200 rows), or all filtered rows for small tables. */
	const drawn = createMemo(() => {
		const win = virtualWindow();
		const all = rows();
		const slice = win.virtual ? all.slice(win.start, win.end) : all;
		const ed = editing();
		const focusRow = ed && !ed.ghost ? ed.row : pinnedRow();
		const beyond = focusRow !== null && !slice.some((row) => row.index === focusRow) ? all.find((row) => row.index === focusRow) : undefined;
		return beyond ? [...slice, beyond] : slice;
	});

	const allDrawnSelected = createMemo(() => {
		const list = rows();
		const sel = selectedRows();
		return list.length > 0 && list.every((r) => sel.has(r.index));
	});

	const toggleRowSelect = (rowIdx: number, shiftKey: boolean) => {
		const list = rows();
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
	let cancelActiveDrag: (() => void) | null = null;
	let cancelActiveResize: (() => void) | null = null;
	onCleanup(() => {
		cancelActiveDrag?.();
		cancelActiveResize?.();
	});

	// Measure cumulative widths of frozen columns so multi-column freezing locks seamlessly with zero overlap/gap.
	createEffect(() => {
		const count = frozenCols().length;
		// Track visual layout dependencies so resizing/reordering/hiding/checking recalculates sticky offsets.
		visibleColumns();
		colWidths();
		hiddenCols();
		table();
		rows();
		codeCheck();
		order();
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
		onCleanup(() => {
			cancelAnimationFrame(raf);
			ro?.disconnect();
		});
	});

	const focusCell = (row: number, column: number) => {
		queueMicrotask(() => {
			const td = body?.querySelector<HTMLElement>(`tr[data-row="${row}"] > td[data-col="${column}"]`);
			if (td) {
				td.focus();
				return;
			}
			if (virtualWindow().virtual && scrollEl) {
				const visIdx = rows().findIndex((r) => r.index === row);
				if (visIdx >= 0) {
					const targetTop = Math.max(0, visIdx * EST_ROW_H - Math.floor((viewportH() || 600) / 3));
					scrollEl.scrollTop = targetTop;
					setScrollTop(targetTop);
					requestAnimationFrame(() => {
						body?.querySelector<HTMLElement>(`tr[data-row="${row}"] > td[data-col="${column}"]`)?.focus();
					});
				}
			}
		});
	};

	const focusGhostCell = (column: number) => {
		queueMicrotask(() => {
			const td = foot?.querySelector<HTMLElement>(`tr.table-ghost-row > td[data-col="${column}"]`);
			td?.focus();
		});
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
			? [cell.start, cell.end, csvCell(value, delimiter)]
			: [last.end, last.end, delimiter.repeat(column - cells.length + 1) + csvCell(value, delimiter)];
		const from = model.getPositionAt(start);
		const to = model.getPositionAt(end);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: written }], () => null);
		model.pushStackElement();
	};

	/** Commits an existing cell edit and optionally moves to the next/previous visual cell (for Tab / Shift+Tab). */
	const commitCell = (row: number, column: number, value: string, move: "none" | "stay" | "next" | "prev") => {
		// Pin the edited row under active filters so editing a cell doesn't immediately drop the row and strand Tab/focus.
		if (hasActiveFilters()) setPinnedRow(row);
		changeCell(row, column, value);
		const cols = visibleColumns();
		const visCol = cols.indexOf(column);
		if (move === "next") {
			if (visCol >= 0 && visCol + 1 < cols.length) {
				setEditing({ ghost: false, row, column: cols[visCol + 1]! });
				return;
			}
			const list = drawn();
			const vis = list.findIndex((r) => r.index === row);
			const firstCol = cols[0] ?? 0;
			if (vis >= 0 && vis + 1 < list.length) {
				const nextRow = list[vis + 1]!.index;
				setCurrent(nextRow);
				setEditing({ ghost: false, row: nextRow, column: firstCol });
			} else {
				setEditing({ ghost: true, column: firstCol });
			}
			return;
		}
		if (move === "prev") {
			if (visCol > 0) {
				setEditing({ ghost: false, row, column: cols[visCol - 1]! });
				return;
			}
			const list = drawn();
			const vis = list.findIndex((r) => r.index === row);
			if (vis > 0) {
				const prevRow = list[vis - 1]!.index;
				setCurrent(prevRow);
				setEditing({ ghost: false, row: prevRow, column: cols[cols.length - 1] ?? 0 });
				return;
			}
		}
		setEditing(null);
		if (move === "stay") focusCell(row, column);
	};

	/**
	 * Commits the blank final ghost row. Nothing is written to the file unless
	 * the user entered non-empty content; Tab on an empty ghost cell moves
	 * horizontally across the ghost row without dirtying the file.
	 */
	const commitGhost = (column: number, value: string, move: "none" | "stay" | "next" | "prev") => {
		const cols = visibleColumns();
		const visCol = cols.indexOf(column);
		if (!model || !cols.length) {
			setEditing(null);
			return;
		}
		if (value === "") {
			if (move === "next" && visCol >= 0 && visCol + 1 < cols.length) {
				setEditing({ ghost: true, column: cols[visCol + 1]! });
				return;
			}
			if (move === "prev" && visCol > 0) {
				setEditing({ ghost: true, column: cols[visCol - 1]! });
				return;
			}
			setEditing(null);
			if (move === "stay") focusGhostCell(column);
			return;
		}

		const values = table().header.map((_, i) => (i === column ? value : ""));
		const edit = appendRowEdit(model.getValue(), values, table().delimiter, model.getEOL());
		const pos = model.getPositionAt(edit.offset);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: edit.text }], () => null);
		model.pushStackElement();

		const newRow = table().rows.length - 1;
		setPinnedRow(newRow);
		setCurrent(newRow);

		if (move === "next") {
			if (visCol >= 0 && visCol + 1 < cols.length) {
				setEditing({ ghost: false, row: newRow, column: cols[visCol + 1]! });
			} else {
				setEditing({ ghost: true, column: cols[0] ?? 0 });
			}
			return;
		}
		if (move === "prev" && visCol > 0) {
			setEditing({ ghost: false, row: newRow, column: cols[visCol - 1]! });
			return;
		}
		setEditing(null);
		if (move === "stay") focusCell(newRow, column);
	};

	const insertRowAt = (row: number, position: "above" | "below") => {
		if (!model || !table().header.length) return;
		const line = table().header.length > 1 ? csvRow(table().header.map(() => ""), table().delimiter) : '""';
		const edit = insertRowEdit(model.getValue(), table(), row, position, line, model.getEOL());
		if (!edit) return;
		const pos = model.getPositionAt(edit.offset);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: edit.text }], () => null);
		model.pushStackElement();
		const targetRow = position === "above" ? row : row + 1;
		setPinnedRow(targetRow);
		setCurrent(targetRow);
		queueMicrotask(() => setEditing({ ghost: false, row: targetRow, column: visibleColumns()[0] ?? 0 }));
	};

	const duplicateRowAt = (row: number) => {
		if (!model) return;
		const raw = rawRowText(model.getValue(), table(), row);
		if (raw === null) return;
		const edit = insertRowEdit(model.getValue(), table(), row, "below", raw, model.getEOL());
		if (!edit) return;
		const pos = model.getPositionAt(edit.offset);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: edit.text }], () => null);
		model.pushStackElement();
		const targetRow = row + 1;
		setPinnedRow(targetRow);
		setCurrent(targetRow);
		focusCell(targetRow, visibleColumns()[0] ?? 0);
	};

	const deleteRowAt = (row: number) => {
		if (!model) return;
		const span = rowSpan(model.getValue(), table(), row);
		if (!span) return;
		const from = model.getPositionAt(span.start);
		const to = model.getPositionAt(span.end);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: "" }], () => null);
		model.pushStackElement();
		const remaining = table().rows.length;
		const nextRow = remaining > 0 ? Math.min(row, remaining - 1) : null;
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
		if (!["database.csv", "settings.csv", "files.csv"].includes(lower)) return "";
		const dups = csvDuplicateKeys(table(), 0);
		if (!dups.length) return "";
		const preview = dups.slice(0, 3).map((d) => d.key).join(", ");
		return `${dups.length} duplicate ${dups.length === 1 ? "key" : "keys"} in “${headerName(0) || "column 1"}” (${preview}${dups.length > 3 ? ", …" : ""}).`;
	});

	/** Applies a single column value across all visible selected rows in one undoable edit. */
	const bulkSetColumn = (colIdx: number, value: string) => {
		if (!model) return;
		const t = parseCsv(model.getValue());
		const targetRows = visibleSelectedRows().filter((r) => r >= 0 && r < t.rows.length).sort((a, b) => b - a);
		if (!targetRows.length) return;
		const ops: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }[] = [];
		for (const r of targetRows) {
			const cells = t.rows[r]!;
			const cell = cells[colIdx];
			if (cell && cell.text === value) continue;
			const last = cells[cells.length - 1]!;
			const [start, end, written] = cell
				? [cell.start, cell.end, csvCell(value, t.delimiter)]
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
		if ((await choose(`Delete ${targetBefore.length} selected ${targetBefore.length === 1 ? "row" : "rows"}?`, ["Delete rows", "Cancel"], { danger: "Delete rows" })) !== "Delete rows") return;
		const raw = model.getValue();
		const fresh = parseCsv(raw);
		const targetRows = visibleSelectedRows().filter((r) => r >= 0 && r < fresh.rows.length);
		const nextText = deleteCsvRows(raw, fresh, targetRows);
		if (nextText === null) return;
		setSelectedRows(new Set<number>());
		setLastClickedRow(null);
		setEditing(null);
		setPinnedRow(null);
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
		const suggestions = rule ? suggestionsForColumn(rule, existing) : [...new Set(existing.map((v) => v.trim()).filter(Boolean))];
		const CUSTOM = "Enter custom value…";
		const CLEAR = "(Clear value)";
		const visCount = visibleSelectedRows().length;
		const picked = await choose(`Set “${headerName(col)}” for ${visCount} selected ${visCount === 1 ? "row" : "rows"}`, [...suggestions, CUSTOM, CLEAR]);
		if (!picked) return;
		if (picked === CLEAR) return bulkSetColumn(col, "");
		if (picked === CUSTOM) {
			const custom = await ask(`Value for “${headerName(col)}”`);
			if (custom !== null) bulkSetColumn(col, custom);
			return;
		}
		bulkSetColumn(col, picked);
	};

	const bulkAssignTicket = async () => {
		const col = ticketAt();
		if (col < 0) return;
		const keys = [...new Set(docs().filter((d) => d.group === "tickets" && d.exists && d.ticket).map((d) => d.ticket!))];
		const CUSTOM = "Enter custom ticket key…";
		const CLEAR = "(Clear ticket)";
		const visCount = visibleSelectedRows().length;
		const picked = await choose(`Assign ticket for ${visCount} selected ${visCount === 1 ? "row" : "rows"}`, [...keys, CUSTOM, CLEAR]);
		if (!picked) return;
		if (picked === CLEAR) return bulkSetColumn(col, "");
		if (picked === CUSTOM) {
			const custom = await ask("Ticket key (e.g. LIMS-101)");
			if (custom !== null) bulkSetColumn(col, custom.trim());
			return;
		}
		bulkSetColumn(col, picked);
	};

	const bulkFillAnyColumn = async () => {
		const names = table().header.map((h, i) => h.text.trim() || `Column ${i + 1}`);
		const picked = await choose("Which column to fill for selected rows?", names);
		if (!picked) return;
		const col = names.indexOf(picked);
		if (col < 0) return;
		const visCount = visibleSelectedRows().length;
		const val = await ask(`Value for “${picked}” across ${visCount} selected ${visCount === 1 ? "row" : "rows"}`, "");
		if (val === null) return;
		bulkSetColumn(col, val);
	};

	const addColumnInteractive = async () => {
		if (!model) return;
		const name = (await ask("New column name"))?.trim();
		if (!name) return;
		const defVal = (await ask(`Default value for existing rows in “${name}” (leave blank for empty)`, "")) ?? "";
		const next = addCsvColumn(model.getValue(), table(), name, defVal);
		if (next) applyFullText(next, `Added column “${name}” (Ctrl+Z to undo).`);
	};

	const renameColumnInteractive = async (col: number) => {
		if (!model) return;
		const oldName = headerName(col);
		const nextName = (await ask(`Rename column “${oldName || `Column ${col + 1}`}” to`, oldName))?.trim();
		if (!nextName || nextName === oldName) return;
		const next = renameCsvColumn(model.getValue(), table(), col, nextName);
		if (next) applyFullText(next, `Renamed column to “${nextName}”.`);
	};

	const deleteColumnInteractive = async (col: number) => {
		if (!model || table().header.length < 2) return;
		const name = headerName(col) || `Column ${col + 1}`;
		if ((await choose(`Delete column “${name}” and all of its values?`, ["Delete column", "Cancel"], { danger: "Delete column" })) !== "Delete column") return;
		const raw = model.getValue();
		const fresh = parseCsv(raw);
		const next = deleteCsvColumn(raw, fresh, col);
		if (!next) return;
		colSnapshots.set(model.getAlternativeVersionId(), captureColUi());
		const shift = (idx: number) => (idx === col ? -1 : idx > col ? idx - 1 : idx);

		// Remap sort, code-check, frozen/hidden/order/widths/filters for remaining columns cleanly.
		const curSort = order();
		if (curSort) {
			const mapped = shift(curSort.column);
			setOrder(mapped >= 0 ? { ...curSort, column: mapped } : null);
		}
		const curChk = codeCheck();
		if (curChk) {
			const mapped = shift(curChk.column);
			if (mapped >= 0) setCodeCheck({ ...curChk, column: mapped });
			else clearCodeCheck();
		}
		setFrozenCols((prev) => prev.map(shift).filter((c) => c >= 0));
		setHiddenCols((prev) => new Set([...prev].map(shift).filter((c) => c >= 0)));
		setColOrder((prev) => {
			const remapped = prev.map(shift).filter((c) => c >= 0);
			return isNaturalOrder(remapped) ? [] : remapped;
		});
		setColWidths((prev) => {
			const out: Record<number, number> = {};
			for (const [k, w] of Object.entries(prev)) {
				const m = shift(Number(k));
				if (m >= 0) out[m] = w;
			}
			return out;
		});
		setColFilters((prev) => {
			const out = new Map<number, ColumnFilter>();
			for (const [k, f] of prev) {
				const m = shift(k);
				if (m >= 0) out.set(m, f);
			}
			return out;
		});
		setEditing(null);
		closeFilterMenu(false);
		applyFullText(next, `Deleted column “${name}” (Ctrl+Z to undo).`);
		colSnapshots.set(model.getAlternativeVersionId(), captureColUi());
	};

	const applySortToFile = async () => {
		if (!model) return;
		const by = order();
		if (!by) return;
		if (hasActiveFilters()) {
			const ok = await choose(
				"Filters are active. Applying sort writes the sorted order for all rows in the file (including hidden rows).",
				["Apply sort to file", "Cancel"],
			);
			if (ok !== "Apply sort to file") return;
		}
		const raw = model.getValue();
		const t = parseCsv(raw);
		const sortedIndices = t.rows
			.map((cells, idx) => ({ idx, val: cells[by.column]?.text ?? "" }))
			.sort((a, b) => a.val.localeCompare(b.val, undefined, { numeric: true, sensitivity: "base" }) * (by.down ? -1 : 1))
			.map((x) => x.idx);
		const next = sortCsvRows(raw, t, sortedIndices);
		setOrder(null);
		if (!next) {
			notify("Rows are already in that order.");
			return;
		}
		// Clear row-index-based selection so checked checkboxes never point at shifted rows.
		setSelectedRows(new Set<number>());
		setLastClickedRow(null);
		setPinnedRow(null);
		setActiveCell(null);
		setEditing(null);
		applyFullText(next, "Saved row sort order to file (Ctrl+Z to undo).");
	};

	const copyFilteredAs = async (fmt: "tsv" | "csv" | "markdown") => {
		const cols = visibleColumns();
		const headers = cols.map((c) => headerName(c));
		const bodyRows = rows().map((r) => cols.map((c) => r.cells[c]?.text ?? ""));
		const out =
			fmt === "tsv"
				? tableToTsv(headers, bodyRows)
				: fmt === "csv"
					? [csvRow(headers, table().delimiter), ...bodyRows.map((r) => csvRow(r, table().delimiter))].join("\n")
					: tableToMarkdown(headers, bodyRows);
		const label = fmt === "tsv" ? "TSV for Excel/Sheets" : fmt === "csv" ? "CSV" : "a Markdown table";
		await copyText(out, `Copied ${bodyRows.length} rows as ${label}.`);
	};

	const copySelectedAsCsv = async () => {
		const selected = visibleSelectedRows();
		if (!selected.length) return;
		const cols = visibleColumns();
		const headers = cols.map((c) => headerName(c));
		const bodyRows = selected
			.sort((a, b) => a - b)
			.map((rIdx) => cols.map((c) => table().rows[rIdx]?.[c]?.text ?? ""));
		const out = [csvRow(headers, table().delimiter), ...bodyRows.map((r) => csvRow(r, table().delimiter))].join("\n");
		await copyText(out, `Copied ${bodyRows.length} selected ${bodyRows.length === 1 ? "row" : "rows"} as CSV.`);
	};

	const isDatabaseRegistry = createMemo(() => baseName(props.path).toLowerCase() === "database.csv");

	/** Scans `schema/**\/*.sql` and appends newly discovered SQL objects to `database.csv` without duplicating schema-qualified names or overwriting existing rows. */
	const syncDatabaseRegistryFromSchema = async () => {
		const root = state.workspace?.root;
		if (!model || !root) return;
		const schemaRel = state.project?.schema ?? "schema";
		const schemaDir = joinPath(root, ...schemaRel.split(/[\\/]/).filter((p) => p && p !== "."));
		try {
			const allFiles = await backend.files();
			const sqlFiles = allFiles.filter((f) => isInside(schemaDir, f) && /\.(sql|ddl|pks|pkb)$/i.test(f));
			if (!sqlFiles.length) {
				notify(`No SQL files found under ${schemaRel}/ to sync from.`);
				return;
			}
			const t = parseCsv(model.getValue());
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
				for (const obj of extractSqlObjects(res.text)) {
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
			// Also detect objects that were previously imported from schema/ SQL but no longer appear in any SQL file.
			const dropped = t.rows
				.map((r) => ({ name: (r[nameCol]?.text ?? "").trim(), note: noteCol >= 0 ? (r[noteCol]?.text ?? "") : "" }))
				.filter((r) => r.name && /^From\s+/i.test(r.note) && !allSqlNames.has(r.name.toLowerCase()) && !allSqlNames.has(r.name.split(".").pop()!.toLowerCase()));
			const droppedMsg = dropped.length ? ` (${dropped.length} listed ${dropped.length === 1 ? "object is" : "objects are"} no longer in schema SQL: ${dropped.slice(0, 3).map((d) => d.name).join(", ")}${dropped.length > 3 ? ", …" : ""})` : "";

			if (!discovered.length) {
				notify(`database.csv already lists every object found in schema SQL files.${droppedMsg}`);
				return;
			}
			if (
				(await choose(
					`Found ${discovered.length} new SQL ${discovered.length === 1 ? "object" : "objects"} in ${schemaRel}/ (${discovered.slice(0, 5).map((d) => d.name).join(", ")}${discovered.length > 5 ? ", …" : ""}).${droppedMsg} Append rows to database.csv?`,
					["Append rows", "Cancel"],
				)) !== "Append rows"
			) {
				return;
			}
			const nl = model.getEOL();
			const textNow = model.getValue();
			const freshTable = parseCsv(textNow);
			const lines: string[] = [];
			for (const obj of discovered) {
				const vals = freshTable.header.map((_, i) => {
					if (i === nameCol) return obj.name;
					if (i === kindCol) return obj.kind;
					if (i === statusIdx) return "found";
					if (i === noteCol) return obj.source;
					return "";
				});
				lines.push(csvRow(vals, freshTable.delimiter));
			}
			const prefix = textNow && !/\r?\n$/.test(textNow) ? nl : "";
			const pos = model.getPositionAt(textNow.length);
			model.pushStackElement();
			model.pushEditOperations([], [{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: `${prefix}${lines.join(nl)}${nl}` }], () => null);
			model.pushStackElement();
			notify(`Added ${discovered.length} SQL ${discovered.length === 1 ? "object" : "objects"} to database.csv (Ctrl+Z to undo).${droppedMsg}`);
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
			const curList = drawn();
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
			const ok = await choose(`Filters are active. Pasting ${grid.length} rows will ${summary}.`, ["Paste here", "Cancel"]);
			if (ok !== "Paste here") return;
		}

		const curText = model.getValue();
		const t = parseCsv(curText);
		const list = drawn();
		const startVisRow = ac.ghost ? list.length : list.findIndex((r) => r.index === ac.row);
		if (startVisRow < 0) return;

		// Build strictly minimal cell-level edits so ragged trailing cells and untouched cell formatting stay verbatim.
		const cellEdits: { start: number; end: number; text: string }[] = [];
		const appended: string[][] = [];
		for (let rOff = 0; rOff < grid.length; rOff++) {
			const pasteRow = grid[rOff]!;
			const targetVis = startVisRow + rOff;
			if (targetVis < list.length) {
				const rowIdx = list[targetVis]!.index;
				const cells = t.rows[rowIdx]!;
				const maxColNeeded = Math.max(
					...pasteRow.map((_, cOff) => cols[startVisCol + cOff] ?? -1),
				);
				// Handle cells that exist in `cells` individually, and pad any missing trailing cells in one tail edit.
				const tailVals = new Map<number, string>();
				for (let cOff = 0; cOff < pasteRow.length; cOff++) {
					const targetCol = cols[startVisCol + cOff];
					if (targetCol === undefined) break;
					const val = pasteRow[cOff]!;
					const existing = cells[targetCol];
					if (existing) {
						if (existing.text !== val) {
							cellEdits.push({ start: existing.start, end: existing.end, text: csvCell(val, t.delimiter) });
						}
					} else {
						tailVals.set(targetCol, val);
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

		const ops = cellEdits
			.sort((a, b) => b.start - a.start || b.end - a.end)
			.map((ed) => {
				const from = model.getPositionAt(ed.start);
				const to = model.getPositionAt(ed.end);
				return { range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: ed.text };
			});
		if (appended.length) {
			const nl = model.getEOL();
			const prefix = curText && !/\r?\n$/.test(curText) ? nl : "";
			const pos = model.getPositionAt(curText.length);
			const block = appended.map((vals) => csvRow(vals, t.delimiter)).join(nl) + nl;
			ops.unshift({ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: prefix + block });
		}
		if (!ops.length) return;
		model.pushStackElement();
		model.pushEditOperations([], ops, () => null);
		model.pushStackElement();
		if (appended.length === 1) setPinnedRow(t.rows.length);
		notify(`Pasted ${grid.length} × ${Math.max(...grid.map((r) => r.length))} cells (Ctrl+Z to undo).`);
	};

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
		const frozen = frozenCols();
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
		const frozen = frozenCols();
		const frozenIdx = frozen.indexOf(col);
		if (frozenIdx >= 0) {
			const clamped = Math.max(0, Math.min(targetVisIdx, frozen.length - 1));
			if (clamped === frozenIdx) return;
			const nextFrozen = moveColumnInList(frozen, frozenIdx, clamped);
			setFrozenCols(nextFrozen);
			const nextFull = fullColumnOrder(count, nextFrozen, colOrder().length ? colOrder() : undefined);
			setColOrder(isNaturalOrder(nextFull) ? [] : nextFull);
			return;
		}
		const full = colOrder().length ? pruneColumnOrder(colOrder(), count) : Array.from({ length: count }, (_, i) => i);
		const pinnedSet = new Set(frozen);
		const hiddenSet = hiddenCols();
		const unfrozenVisible = full.filter((c) => !pinnedSet.has(c) && !hiddenSet.has(c));
		const fromU = unfrozenVisible.indexOf(col);
		const toU = Math.max(0, Math.min(targetVisIdx - frozen.length, unfrozenVisible.length - 1));
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
		if (isFrozenCol(col)) setFrozenCols((prev) => prev.filter((c) => c !== col));
		if (filterMenu()?.column === col) closeFilterMenu(false);
		const ed = editing();
		if (ed && ed.column === col) setEditing(null);
		setHiddenCols(next);
		const ac = activeCell();
		if (ac && ac.column === col) {
			const fallback = visibleColumns()[0];
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

	/** Measures the full untruncated width of `col` (header + visible cells) and sets its column width to fit. */
	const autoFitColumn = (col: number) => {
		let needed = MIN_COL_WIDTH;
		const th = headRow?.querySelector<HTMLElement>(`th[data-col="${col}"]`);
		if (th) {
			const label = th.querySelector<HTMLElement>(".table-th-label");
			const pin = th.querySelector<HTMLElement>(".table-th-pin");
			const filterBtn = th.querySelector<HTMLElement>(".table-th-filter");
			const labelW = label ? Math.ceil(label.scrollWidth) : 0;
			const extras =
				(pin ? pin.getBoundingClientRect().width : 0) +
				(filterBtn ? filterBtn.getBoundingClientRect().width : 0) +
				(order()?.column === col ? 22 : 0) +
				32;
			needed = Math.max(needed, labelW + extras);
		}
		if (body) {
			const range = document.createRange();
			const cells = body.querySelectorAll<HTMLElement>(`td[data-col="${col}"]`);
			for (const td of cells) {
				const cs = getComputedStyle(td);
				const padX =
					Number.parseFloat(cs.paddingLeft || "0") +
					Number.parseFloat(cs.paddingRight || "0") +
					Number.parseFloat(cs.borderRightWidth || "1");
				let contentW = 0;
				if (td.childNodes.length) {
					range.selectNodeContents(td);
					contentW = Math.ceil(range.getBoundingClientRect().width);
				}
				const overflowW = td.scrollWidth > td.clientWidth ? td.scrollWidth : 0;
				needed = Math.max(needed, Math.ceil(contentW + padX) + 8, overflowW + 8);
			}
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
		colSnapshots.set(model.getAlternativeVersionId(), captureColUi());

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
		if (curSort) {
			const mapped = remapColumnIndex(curSort.column, applied);
			setOrder(mapped >= 0 ? { column: mapped, down: curSort.down } : null);
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

		const curCheck = codeCheck();
		if (curCheck) {
			const mapped = remapColumnIndex(curCheck.column, applied);
			setCodeCheck(mapped >= 0 ? { ...curCheck, column: mapped } : null);
		}

		setColOrder([]);
		colSnapshots.set(model.getAlternativeVersionId(), captureColUi());
		notify("Saved column order to file (Ctrl+Z to undo).");
		queueMicrotask(() => rootEl?.focus());
	};

	/** Pointer-based drag-and-drop on column headers (5px threshold so normal clicks sort without interference). */
	const onHeaderPointerDown = (e: PointerEvent, col: number, visIdx: number) => {
		if (e.button !== 0) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest(".table-th-pin, .table-th-filter, .table-col-resizer")) return;
		const frozenCount = frozenCols().length;
		const isFrozen = visIdx < frozenCount;
		const minVis = isFrozen ? 0 : frozenCount;
		const maxVis = isFrozen ? frozenCount - 1 : visibleColumns().length - 1;
		if (maxVis <= minVis) return;

		const startX = e.clientX;
		const label = headerName(col) || `Column ${col + 1}`;
		let dragging = false;

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
			setColDrag({ col, label, fromVis: visIdx, dropVis, side, x: ev.clientX, y: ev.clientY });
		};

		const onUp = () => {
			const drag = colDrag();
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

	/** Arrow keys move between cells (including seamlessly into the blank final row); Alt+Left/Right moves columns; Enter/F2/type edits; Delete clears. */
	const onCellKey = (e: KeyboardEvent, row: number, column: number) => {
		if (editing()) return;
		if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
			e.preventDefault();
			moveColumnBy(column, e.key === "ArrowLeft" ? -1 : 1);
			focusCell(row, column);
			return;
		}
		const cell = e.currentTarget as HTMLElement;
		const move = (to: Element | null | undefined) => to instanceof HTMLElement && to.matches("td[data-col]") && (e.preventDefault(), to.focus());
		if (e.key === "Enter" || e.key === "F2") return e.preventDefault(), setEditing({ ghost: false, row, column });
		if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			changeCell(row, column, "");
			return;
		}
		if (e.key === "ArrowRight") return move(cell.nextElementSibling);
		if (e.key === "ArrowLeft") return move(cell.previousElementSibling);
		const at = [...cell.parentElement!.children].indexOf(cell);
		if (e.key === "ArrowDown") {
			const nextTr = cell.parentElement!.nextElementSibling;
			if (nextTr) return move(nextTr.children[at]);
			return move(foot?.querySelector("tr.table-ghost-row")?.children[at]);
		}
		if (e.key === "ArrowUp") return move(cell.parentElement!.previousElementSibling?.children[at]);
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			setEditing({ ghost: false, row, column, seed: e.key });
		}
	};

	const onGhostKey = (e: KeyboardEvent, column: number) => {
		if (editing()) return;
		const cell = e.currentTarget as HTMLElement;
		const move = (to: Element | null | undefined) => to instanceof HTMLElement && to.matches("td[data-col]") && (e.preventDefault(), to.focus());
		if (e.key === "Enter" || e.key === "F2") return e.preventDefault(), setEditing({ ghost: true, column });
		if (e.key === "ArrowRight") return move(cell.nextElementSibling);
		if (e.key === "ArrowLeft") return move(cell.previousElementSibling);
		if (e.key === "ArrowUp") {
			const lastTr = body?.lastElementChild;
			const at = [...cell.parentElement!.children].indexOf(cell);
			return move(lastTr?.children[at]);
		}
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			setEditing({ ghost: true, column, seed: e.key });
		}
	};

	const sortBy = (column: number) => setOrder((by) => (by?.column !== column ? { column, down: false } : by.down ? null : { column, down: true }));

	// --- Right-click Context Menus ------------------------------------------

	const onCellContextMenu = async (e: MouseEvent, row: number, column: number) => {
		const target = e.target instanceof Element ? e.target : null;
		if (target?.closest("input, textarea")) return; // Let global text-box menu handle active editor inputs.
		e.preventDefault();
		e.stopPropagation();
		closeFilterMenu(false);
		setActiveCell({ ghost: false, row, column });
		const cellEl = e.currentTarget as HTMLElement;
		const at = menuPoint(e, cellEl);
		const cells = table().rows[row];
		if (!cells) return;
		const rawVal = (cells[column]?.text ?? "").trim();
		const col = headerName(column) || `Column ${column + 1}`;
		const hasRule = Boolean(columnRule(column));
		const frozenHere = isFrozenCol(column);

		const items: RowMenuEntry[] = [
			{ label: "Edit cell", value: "edit", keys: "Enter" },
			...(rawVal ? [{ label: "Copy cell", value: "copy-cell", keys: "Ctrl+C" }] : []),
			{ label: "Copy row", value: "copy-row" },
			"separator",
			{
				label: rawVal ? `Filter by “${shortLabel(rawVal)}”` : `Filter by empty in “${shortLabel(col)}”`,
				value: "filter-val",
			},
			...(rawVal
				? [
						{ label: `Find “${shortLabel(rawVal)}” in code`, value: "find-code" },
						{ label: `Check “${shortLabel(rawVal)}” in code`, value: "check-cell" },
					]
				: []),
			{ label: `Check “${shortLabel(col)}” in code…`, value: "check-col" },
			"separator",
			{ label: "Insert row above", value: "insert-above" },
			{ label: "Insert row below", value: "insert-below" },
			{ label: "Duplicate row", value: "duplicate" },
			{ label: "Delete row", value: "delete" },
			"separator",
			{ label: frozenHere ? `Unfreeze “${shortLabel(col)}”` : `Freeze “${shortLabel(col)}” to left`, value: "freeze" },
			...(visibleColumns().length > 1 ? [{ label: `Hide “${shortLabel(col)}”`, value: "hide" }] : []),
			{ label: hasRule ? `Configure “${shortLabel(col)}” badges…` : `Format “${shortLabel(col)}” as badges…`, value: "badges" },
		];

		const picked = await chooseFromMenu(`Actions for ${col}, row ${row + 1}`, items, at);
		if (!picked) return;
		if (picked === "edit") {
			setEditing({ ghost: false, row, column });
		} else if (picked === "copy-cell") {
			await copyText(cells[column]?.text ?? "", "Copied cell value.");
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
			);
		} else if (picked === "check-col") {
			setCheckDialog({ open: true, column, rowScope: hasActiveFilters() ? "filtered" : "all" });
		} else if (picked === "insert-above") {
			insertRowAt(row, "above");
		} else if (picked === "insert-below") {
			insertRowAt(row, "below");
		} else if (picked === "duplicate") {
			duplicateRowAt(row);
		} else if (picked === "delete") {
			deleteRowAt(row);
		} else if (picked === "freeze") {
			toggleFreeze(column);
		} else if (picked === "hide") {
			hideCol(column);
		} else if (picked === "badges") {
			setFormatDialog({ open: true, initialColumn: headerName(column) });
		}
	};

	const onHeaderContextMenu = async (e: MouseEvent, column: number) => {
		e.preventDefault();
		e.stopPropagation();
		closeFilterMenu(false);
		const thEl = e.currentTarget as HTMLElement;
		const at = menuPoint(e, thEl);
		const col = headerName(column) || `Column ${column + 1}`;
		const hasRule = Boolean(columnRule(column));
		const sortedHere = order()?.column === column;
		const filteredHere = isColFiltered(column);
		const frozenHere = isFrozenCol(column);

		const items: RowMenuEntry[] = [
			{ label: "Sort ascending", value: "sort-asc" },
			{ label: "Sort descending", value: "sort-desc" },
			...(sortedHere ? [{ label: "Apply sort order to file", value: "sort-apply" }, { label: "Clear sort", value: "sort-clear" }] : []),
			"separator",
			{ label: `Filter “${shortLabel(col)}”…`, value: "filter" },
			...(filteredHere ? [{ label: `Clear filter on “${shortLabel(col)}”`, value: "filter-clear" }] : []),
			"separator",
			{ label: `Rename “${shortLabel(col)}”…`, value: "rename-col" },
			{ label: "Add column…", value: "add-col" },
			...(table().header.length > 1 ? [{ label: `Delete “${shortLabel(col)}”…`, value: "delete-col" }] : []),
			"separator",
			{ label: frozenHere ? `Unfreeze “${shortLabel(col)}”` : `Freeze “${shortLabel(col)}” to left`, value: "freeze" },
			...(frozenCols().length > 1 || (frozenCols().length === 1 && !frozenHere)
				? [{ label: "Unfreeze all columns", value: "unfreeze-all" }]
				: []),
			...(visibleColumns().length > 1 ? [{ label: `Hide “${shortLabel(col)}”`, value: "hide" }] : []),
			...(hiddenCols().size > 0 ? [{ label: `Show all hidden columns (${hiddenCols().size})`, value: "show-all" }] : []),
			...(canMoveColumn(column, -1) ? [{ label: `Move “${shortLabel(col)}” left`, value: "move-left", keys: "Alt+Left" }] : []),
			...(canMoveColumn(column, 1) ? [{ label: `Move “${shortLabel(col)}” right`, value: "move-right", keys: "Alt+Right" }] : []),
			{ label: `Auto-fit “${shortLabel(col)}” width`, value: "autofit" },
			...(hasCustomWidths() ? [{ label: "Reset column widths", value: "reset-widths" }] : []),
			...(differsFromFile() ? [{ label: "Save column order to file", value: "save-order" }] : []),
			...(hasCustomOrder() ? [{ label: "Reset column order", value: "reset-order" }] : []),
			"separator",
			{ label: `Check “${shortLabel(col)}” in code…`, value: "check-col" },
			...(codeCheck() ? [{ label: "Clear code check results", value: "check-clear" }] : []),
			"separator",
			{ label: hasRule ? `Configure “${shortLabel(col)}” badges…` : `Format “${shortLabel(col)}” as badges…`, value: "badges" },
			...(hasRule ? [{ label: `Turn off badges for “${shortLabel(col)}”`, value: "badges-off" }] : []),
		];

		const picked = await chooseFromMenu(`Actions for column ${col}`, items, at);
		if (!picked) return;
		if (picked === "sort-asc") setOrder({ column, down: false });
		else if (picked === "sort-desc") setOrder({ column, down: true });
		else if (picked === "sort-apply") applySortToFile();
		else if (picked === "sort-clear") setOrder(null);
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

	const onGhostContextMenu = async (e: MouseEvent, column: number) => {
		const target = e.target instanceof Element ? e.target : null;
		if (target?.closest("input, textarea")) return;
		e.preventDefault();
		e.stopPropagation();
		closeFilterMenu(false);
		const cellEl = e.currentTarget as HTMLElement;
		const at = menuPoint(e, cellEl);
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

	const openTableActionsMenu = async (anchor: HTMLElement) => {
		closeFilterMenu(false);
		const rect = anchor.getBoundingClientRect();
		const at = { x: rect.left, y: rect.bottom + 4 };
		const selIdx = current();
		const hasSelectedRow = selIdx !== null && Boolean(table().rows[selIdx]);
		const selName = currentName();

		const items: RowMenuEntry[] = [
			{ label: "Add column…", value: "add-col" },
			...(isDatabaseRegistry() ? [{ label: "Sync from schema SQL…", value: "sync-schema" }] : []),
			...(order() ? [{ label: "Apply sort order to file", value: "sort-apply" }] : []),
			"separator",
			{ label: "Copy visible rows as CSV", value: "copy-csv" },
			{ label: "Copy visible rows as TSV (Excel)", value: "copy-tsv" },
			{ label: "Copy visible rows as Markdown table", value: "copy-md" },
			"separator",
			{ label: "Check column in code…", value: "check" },
			...(codeCheck() ? [{ label: "Clear code check results", value: "check-clear" }] : []),
			...(frozenCols().length ? [{ label: "Unfreeze all columns", value: "unfreeze-all" }] : []),
			...(hiddenCols().size ? [{ label: `Show all hidden columns (${hiddenCols().size})`, value: "show-all-cols" }] : []),
			...(hasCustomWidths() ? [{ label: "Reset column widths", value: "reset-widths" }] : []),
			...(differsFromFile() ? [{ label: "Save column order to file", value: "save-order" }] : []),
			...(hasCustomOrder() ? [{ label: "Reset column order", value: "reset-order" }] : []),
			"separator",
			{ label: "Configure column badges…", value: "badges" },
			"separator",
			{ label: "Start new row at end", value: "add-end" },
			...(hasSelectedRow
				? [
						{ label: "Insert row above selected", value: "insert-above" },
						{ label: "Insert row below selected", value: "insert-below" },
						{ label: "Duplicate selected row", value: "duplicate" },
						{ label: `Delete selected row${selName ? ` (“${shortLabel(selName)}”)` : ""}`, value: "delete-selected" },
					]
				: []),
		];

		const picked = await chooseFromMenu("Table actions", items, at);
		if (!picked) return;
		if (picked === "add-col") {
			void addColumnInteractive();
		} else if (picked === "sync-schema") {
			void syncDatabaseRegistryFromSchema();
		} else if (picked === "sort-apply") {
			applySortToFile();
		} else if (picked === "copy-csv") {
			void copyFilteredAs("csv");
		} else if (picked === "copy-tsv") {
			void copyFilteredAs("tsv");
		} else if (picked === "copy-md") {
			void copyFilteredAs("markdown");
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
		} else if (picked === "delete-selected" && selIdx !== null) {
			deleteRowAt(selIdx);
		}
	};

	return (
		<div
			ref={rootEl}
			tabIndex={-1}
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
				// The table is a view of the text, and its changes are the text's: they are undone as the text's are.
				if (!model || !(e.ctrlKey || e.metaKey) || e.altKey) return;
				const tag = (e.target as HTMLElement).tagName;
				if (tag === "INPUT" || tag === "TEXTAREA") return;
				const key = e.key.toLowerCase();
				if (key === "z" && !e.shiftKey) (e.preventDefault(), void model.undo());
				else if (key === "y" || (key === "z" && e.shiftKey)) (e.preventDefault(), void model.redo());
				else if (key === "c" && !e.shiftKey) {
					const sel = window.getSelection();
					if (sel && !sel.isCollapsed) return;
					const ac = activeCell();
					if (ac && !ac.ghost) {
						const val = table().rows[ac.row]?.[ac.column]?.text ?? "";
						e.preventDefault();
						void copyText(val, "Copied cell value.");
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
				<Show when={onlyTicket()}>
					<button class="doc-status tone-active table-for" aria-pressed="true" title="Show every row again" onClick={() => setOnlyTicket(null)}>
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
				<Show when={activeFilterCols().length > 1 || (activeFilterCols().length > 0 && Boolean(filter().trim()))}>
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
									aria-pressed={onlyMissing()}
									title={`Show only rows whose “${chk().columnName}” value was not found in the searched code files`}
									onClick={() => setOnlyMissing(!onlyMissing())}
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

				<Show when={order()}>
					<span class="table-reorder-bar" role="status">
						<span class="table-reorder-label">Sorted</span>
						<button
							type="button"
							class="link table-reorder-apply"
							title="Write the current row sort order into the CSV file (Ctrl+Z undoes)"
							onClick={() => void applySortToFile()}
						>
							Apply sort to file
						</button>
						<button type="button" class="link table-reorder-reset" title="Clear temporary sort" onClick={() => setOrder(null)}>
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
					<button
						type="button"
						class="table-format-btn"
						classList={{ active: matchedBadgeCols().length > 0 }}
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
					<button type="button" class="table-bulk-btn" onClick={() => void copySelectedAsCsv()}>
						Copy CSV
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

			<Show when={table().problems.length || duplicateKeyWarning()}>
				<p class="hint warn table-problems" role="status">
					{[...table().problems, ...(duplicateKeyWarning() ? [duplicateKeyWarning()] : [])].join(" ")} The Text view shows the file as written.
				</p>
			</Show>

			{/* Autocomplete suggestions for whichever configured badge column is currently being edited. */}
			<datalist id={suggestionListId}>
				<For each={activeSuggestions()}>{(val) => <option value={val} />}</For>
			</datalist>

			<div
				class="table-scroll"
				ref={(el) => {
					scrollEl = el;
					setViewportH(el.clientHeight || 640);
					if (typeof ResizeObserver !== "undefined") {
						const ro = new ResizeObserver(() => setViewportH(el.clientHeight || 640));
						ro.observe(el);
						onCleanup(() => ro.disconnect());
					}
				}}
				classList={{ "is-dragging-col": Boolean(colDrag()), "is-resizing-col": resizingCol() !== null }}
				onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
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
									<input
										type="checkbox"
										checked={allDrawnSelected()}
										aria-label="Select all visible rows"
										title="Select all visible rows"
										onChange={toggleSelectAllDrawn}
									/>
								</th>
							</Show>
							<Index each={visibleColumns()}>
								{(colAcc, visIdx) => {
									const col = () => colAcc();
									const name = () => headerName(col());
									const filtered = () => isColFiltered(col());
									const isFrozen = () => visIdx < frozenCols().length;
									const isLastFrozen = () => isFrozen() && visIdx === frozenCols().length - 1;
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
									return (
										<th
											scope="col"
											data-col={col()}
											style={cellStyle(col(), visIdx)}
											classList={{
												"col-filtered": filtered(),
												"col-checked": codeCheck()?.column === col(),
												"col-frozen": isFrozen(),
												"col-frozen-last": isLastFrozen(),
												"col-dragging": isDragging(),
												"col-drop-before": isDropBefore(),
												"col-drop-after": isDropAfter(),
											}}
											aria-sort={order()?.column === col() ? (order()!.down ? "descending" : "ascending") : "none"}
											onPointerDown={(e) => onHeaderPointerDown(e, col(), visIdx)}
											onContextMenu={(e) => void onHeaderContextMenu(e, col())}
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
													title={`Click to sort by ${name() || "this column"}; drag to reorder; right-click for more actions.`}
													onClick={() => {
														if (suppressSortClick) return;
														sortBy(col());
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
													<Show when={order()?.column === col()}>
														<Icon name={order()!.down ? "arrow-down" : "arrow-up"} />
													</Show>
												</button>
												<button
													type="button"
													class="table-th-filter"
													classList={{ active: filtered(), open: filterMenu()?.column === col() }}
													aria-label={`Filter ${name() || `column ${col() + 1}`}`}
													aria-haspopup="dialog"
													aria-expanded={filterMenu()?.column === col()}
													title={filterTip()}
													onClick={(e) => openFilterMenu(col(), e.currentTarget)}
												>
													<Icon name={filtered() ? "filter-filled" : "filter"} />
												</button>
											</div>
											<div
												class="table-col-resizer"
												classList={{ active: resizingCol() === col() }}
												title={`Drag to resize “${name() || `Column ${col() + 1}`}”; double-click to fit content`}
												onPointerDown={(e) => onResizerPointerDown(e, col())}
												onDblClick={(e) => (e.stopPropagation(), e.preventDefault(), autoFitColumn(col()))}
												onClick={(e) => e.stopPropagation()}
											/>
										</th>
									);
								}}
							</Index>
						</tr>
					</thead>

					<tbody ref={body}>
						<Show when={virtualWindow().topPad > 0}>
							<tr class="table-virt-spacer" aria-hidden="true">
								<td colSpan={visibleColumns().length + 1} style={{ height: `${virtualWindow().topPad}px`, padding: "0", border: "0" }} />
							</tr>
						</Show>
						<Index each={drawn()}>
							{(rowItem) => {
								const index = () => rowItem().index;
								const cells = () => rowItem().cells;
								return (
									<tr data-row={index()} classList={{ "row-current": current() === index(), "row-selected": selectedRows().has(index()) }}>
										<td class="table-sel-col" onClick={(e) => e.stopPropagation()}>
											<input
												type="checkbox"
												checked={selectedRows().has(index())}
												aria-label={`Select row ${index() + 1}`}
												onClick={(e) => {
													e.stopPropagation();
													toggleRowSelect(index(), e.shiftKey);
												}}
												onChange={() => {}}
											/>
										</td>
										<Index each={visibleColumns()}>
											{(colAcc, visIdx) => {
												const col = () => colAcc();
												const value = () => cells()[col()]?.text ?? "";
												const open = () => {
													const ed = editing();
													return Boolean(ed && !ed.ghost && ed.row === index() && ed.column === col());
												};
												const rule = () => columnRule(col());
												const badgeTone = () => badgeToneForValue(rule(), value());
												const checkedHere = () => {
													const chk = codeCheck();
													return chk && chk.column === col() ? chk : null;
												};
												const isFrozen = () => visIdx < frozenCols().length;
												const isLastFrozen = () => isFrozen() && visIdx === frozenCols().length - 1;
												return (
													<td
														tabindex={0}
														data-col={col()}
														style={cellStyle(col(), visIdx)}
														classList={{
															number: /^-?\d[\d.,]*$/.test(value().trim()),
															"col-frozen": isFrozen(),
															"col-frozen-last": isLastFrozen(),
															"cell-selected": isCellSelected(index(), col()),
															"cell-editing": open(),
														}}
														title="Double-click, Enter or F2 to edit; right-click for actions"
														onMouseDown={() => setActiveCell({ ghost: false, row: index(), column: col() })}
														onFocus={() => setActiveCell({ ghost: false, row: index(), column: col() })}
														onDblClick={() => setEditing({ ghost: false, row: index(), column: col() })}
														onKeyDown={(e) => onCellKey(e, index(), col())}
														onContextMenu={(e) => void onCellContextMenu(e, index(), col())}
													>
														<Show
															when={open()}
															fallback={
																<Show
																	when={checkedHere()?.splitLists && value().trim()}
																	fallback={
																		<>
																			<Show
																				when={col() === ticketAt() && value().trim()}
																				fallback={
																					<Show when={badgeTone()} fallback={value()}>
																						{(tone) => <span class={`doc-status tone-${tone()}`}>{value()}</span>}
																					</Show>
																				}
																			>
																				{ticketCell(value())}
																			</Show>
																			<Show when={checkedHere()}>
																				{(chk) => {
																					const trimmed = value().trim();
																					if (!trimmed) return null;
																					const count = chk().counts.get(termLookupKey(trimmed, chk().caseSensitive));
																					return renderCheckBadge(trimmed, count, chk().options);
																				}}
																			</Show>
																		</>
																	}
																>
																	{/* Split comma/semicolon list cell with per-term code check counts */}
																	<For each={value().split(/([,;\r\n]+\s*)/)}>
																		{(part) => {
																			const trimmed = part.trim();
																			const chk = checkedHere();
																			if (!trimmed || /^[,;\r\n]+$/.test(trimmed) || !chk) return part;
																			const count = chk.counts.get(termLookupKey(trimmed, chk.caseSensitive));
																			return (
																				<>
																					{part}
																					{renderCheckBadge(trimmed, count, chk.options)}
																				</>
																			);
																		}}
																	</For>
																</Show>
															}
														>
															{(() => {
																let done = false;
																const rowIdx = index();
																const targetCol = col();
																const ed = editing();
																const seed = ed && !ed.ghost && ed.seed !== undefined ? ed.seed : undefined;
																const initVal = seed !== undefined ? seed : value();
																const finish = (val: string, move: "none" | "stay" | "next" | "prev") => {
																	if (done) return;
																	done = true;
																	commitCell(rowIdx, targetCol, val, move);
																};
																const multiline = Boolean(ed && !ed.ghost && ed.forceMultiline) || (seed === undefined && /[\r\n]/.test(value()));
																if (multiline) {
																	return (
																		<textarea
																			class="table-cell-multiline"
																			value={initVal}
																			rows={Math.min(6, Math.max(2, initVal.split(/\r?\n/).length))}
																			aria-label={`${headerName(targetCol) || "Cell"}, row ${rowIdx + 1} (Ctrl+Enter to save)`}
																			ref={(el) =>
																				queueMicrotask(() => {
																					el.focus();
																					if (seed !== undefined) el.setSelectionRange(seed.length, seed.length);
																					else el.select();
																				})
																			}
																			onKeyDown={(e) => {
																				e.stopPropagation();
																				if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
																					e.preventDefault();
																					finish(e.currentTarget.value, "stay");
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
																		list={activeSuggestions().length ? suggestionListId : undefined}
																		value={initVal}
																		aria-label={`${headerName(targetCol) || "Cell"}, row ${rowIdx + 1} (Shift+Enter for new line)`}
																		ref={(el) =>
																			queueMicrotask(() => {
																				el.focus();
																				if (seed !== undefined) el.setSelectionRange(seed.length, seed.length);
																				else el.select();
																			})
																		}
																		onKeyDown={(e) => {
																			e.stopPropagation();
																			if (e.key === "Enter" && (e.shiftKey || e.altKey)) {
																				e.preventDefault();
																				const el = e.currentTarget;
																				const at = el.selectionStart ?? el.value.length;
																				const nextSeed = `${el.value.slice(0, at)}\n${el.value.slice(el.selectionEnd ?? at)}`;
																				done = true;
																				setEditing({ ghost: false, row: rowIdx, column: targetCol, seed: nextSeed, forceMultiline: true });
																			} else if (e.key === "Enter") {
																				e.preventDefault();
																				finish(e.currentTarget.value, "stay");
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
															})()}
														</Show>
													</td>
												);
											}}
										</Index>
									</tr>
								);
							}}
						</Index>
						<Show when={virtualWindow().bottomPad > 0}>
							<tr class="table-virt-spacer" aria-hidden="true">
								<td colSpan={visibleColumns().length + 1} style={{ height: `${virtualWindow().bottomPad}px`, padding: "0", border: "0" }} />
							</tr>
						</Show>
					</tbody>

					{/* Blank final row: lives outside tbody and writes nothing to the file until content is entered. */}
					<Show when={table().header.length > 0}>
						<tfoot ref={foot}>
							<tr class="table-ghost-row">
								<td class="table-sel-col" aria-hidden="true" />
								<Index each={visibleColumns()}>
									{(colAcc, visIdx) => {
										const col = () => colAcc();
										const open = () => {
											const ed = editing();
											return Boolean(ed && ed.ghost && ed.column === col());
										};
										const colLabel = () => headerName(col()) || `Column ${col() + 1}`;
										const isFrozen = () => visIdx < frozenCols().length;
										const isLastFrozen = () => isFrozen() && visIdx === frozenCols().length - 1;
										return (
											<td
												tabindex={0}
												data-col={col()}
												style={cellStyle(col(), visIdx)}
												classList={{
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
													when={open()}
													fallback={
														<Show when={visIdx === 0}>
															<span class="table-ghost-placeholder">
																<Icon name="add" /> New row…
															</span>
														</Show>
													}
												>
													{(() => {
														let done = false;
														const targetCol = col();
														const ed = editing();
														const seed = ed && ed.ghost && ed.seed ? ed.seed : "";
														const finish = (val: string, move: "none" | "stay" | "next" | "prev") => {
															if (done) return;
															done = true;
															commitGhost(targetCol, val, move);
														};
														return (
															<input
																list={activeSuggestions().length ? suggestionListId : undefined}
																value={seed}
																placeholder={colLabel()}
																aria-label={`New row, ${colLabel()}`}
																ref={(el) =>
																	queueMicrotask(() => {
																		el.focus();
																		if (seed) el.setSelectionRange(seed.length, seed.length);
																	})
																}
																onKeyDown={(e) => {
																	e.stopPropagation();
																	if (e.key === "Enter") {
																		e.preventDefault();
																		finish(e.currentTarget.value, "stay");
																	} else if (e.key === "Tab") {
																		e.preventDefault();
																		finish(e.currentTarget.value, e.shiftKey ? "prev" : "next");
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
													})()}
												</Show>
											</td>
										);
									}}
								</Index>
							</tr>
						</tfoot>
					</Show>
				</table>

				<Show when={false && rows().length > rowLimit()}>
					<div class="table-more-rows" role="status">
						<span class="hint">
							Showing {rowLimit()} of {rows().length} rows.
						</span>
						<button type="button" class="link" onClick={() => setRowLimit((n) => n + ROWS_SHOWN)}>
							Show {Math.min(ROWS_SHOWN, rows().length - rowLimit())} more
						</button>
						<button type="button" class="link" onClick={() => setRowLimit(rows().length)}>
							Show all ({rows().length})
						</button>
					</div>
				</Show>
				<Show when={table().rows.length > 0 && rows().length === 0}>
					<p class="hint">
						No rows match the active filters.{" "}
						<button type="button" class="link" onClick={clearAllFilters}>
							Clear filters
						</button>
					</p>
				</Show>
			</div>

			{/* Portaled per-column header filter popover (never clipped by .table-scroll overflow). */}
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
					return (
						<Portal>
							<div
								class="table-filter-pop"
								role="dialog"
								aria-label={`Filter ${colName()}`}
								style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
							>
								<div class="table-filter-head">
									<span class="table-filter-title" title={colName()}>
										{colName()}
									</span>
									<div class="table-filter-sort-btns" role="group" aria-label={`Sort ${colName()}`}>
										<button
											type="button"
											class="icon-btn"
											classList={{ active: order()?.column === col() && !order()!.down }}
											title="Sort ascending"
											aria-label="Sort ascending"
											onClick={() => setOrder({ column: col(), down: false })}
										>
											<Icon name="arrow-up" />
										</button>
										<button
											type="button"
											class="icon-btn"
											classList={{ active: order()?.column === col() && order()!.down }}
											title="Sort descending"
											aria-label="Sort descending"
											onClick={() => setOrder({ column: col(), down: true })}
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
										<For each={visibleOptions()}>
											{(opt) => {
												const tone = () => badgeToneForValue(rule(), opt.label);
												return (
													<div class="table-filter-item" classList={{ zero: opt.count === 0 }}>
														<label class="table-filter-check">
															<input type="checkbox" checked={isChecked(opt.key)} onChange={() => toggleKey(opt.key)} />
															<Show
																when={opt.label}
																fallback={<span class="table-filter-blank">(empty)</span>}
															>
																<Show when={tone()} fallback={<span class="table-filter-val" title={opt.label}>{opt.label}</span>}>
																	{(t) => <span class={`doc-status tone-${t()}`}>{opt.label}</span>}
																</Show>
															</Show>
														</label>
														<button
															type="button"
															class="table-filter-only"
															title={`Show only ${opt.label || "(empty)"}`}
															onClick={() => selectOnly(opt.key)}
														>
															Only
														</button>
														<span class="table-filter-count">{opt.count}</span>
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

			{/* Floating drag ghost pill while dragging a column header. */}
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
