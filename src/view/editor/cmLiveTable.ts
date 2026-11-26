// Obsidian-grade in-place Live Table Grid Widget for CodeMirror 6 (ADR 0002 & ADR 0028).
// - In Live mode: stays rendered as an interactive HTML table grid. Clicking any cell edits
//   that cell directly in place with zero vertical shift, zero raw-pipe explosion, and zero
//   chance of kicking you out when clicking between cells.
// - Uses CM6 `WidgetType.updateDOM` to update the DOM in place while preserving cell focus & caret.
// - Controls bar docks cleanly at the bottom of the active table card so table rows never jump.
// - A cell edit writes that cell's own text to the underlying CM6/Monaco document and nothing else; an action on
//   rows or columns (add, remove, move, sort, align, Format) writes the table again as cleanly formatted GFM.
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { pasteUrlOverSelection } from "../../shared/markdownEdit";
import {
	cellValueForEdit,
	deleteTableColumn,
	deleteTableRow,
	docLineToTableRow,
	enterTableRow,
	formatTable,
	insertTableColumn,
	insertTableRow,
	locateTableCell,
	moveTableColumn,
	moveTableRow,
	parseTableRaw,
	serializeTableCell,
	setTableAlignment,
	sortTableByColumn,
	stepTableCell,
	tableCellTextEdit,
	updateTableCell,
	type MarkdownTable,
	type TableAlign,
	type TableEdit,
} from "../../shared/markdownTables";
import { baseName, isInside, relativeTo, resolvePath } from "../../shared/paths";
import type { RowMenuEntry } from "../../shared/contextMenu";
import { backend, fileExists, inApp } from "../backend";
import { notify, setState, state as appState } from "../state";
import { createTextareaCompleter, type TextareaCompleter } from "./cmCompletion";
import {
	historyFallbackFacet,
	liveCallbacksFacet,
	renderInlineHtml,
	setRawEditBlockEffect,
	type TableWidgetHost,
} from "./cmLiveShared";
import { hydrateImagesInElement } from "./imageResolve";
import {
	hydrateMathInElement,
	normalizeTableRange,
	serializeTableToCsv,
	serializeTableToTsv,
	type TableCellRange,
} from "./markdownHtml";

export { normalizeTableRange, serializeTableToCsv, serializeTableToTsv, type TableCellRange };

/**
 * Parses clipboard TSV text (e.g. from Excel / Google Sheets / TableView) into a 2D cell matrix.
 * Returns null for single-cell text or plain multi-line prose without tabs.
 */
export function parseTsvGrid(raw: string): string[][] | null {
	if (!raw || !raw.includes("\t")) return null;
	const normalized = raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	if (!normalized || !normalized.includes("\t")) return null;
	const rows = normalized.split("\n").map((line) => line.split("\t"));
	const maxCols = Math.max(...rows.map((r) => r.length));
	if (maxCols < 2) return null;
	return rows;
}

/**
 * Expands a multi-row or multi-column TSV paste across table cells starting at `(startRow, startCol)`,
 * automatically adding rows and columns as needed while preserving existing alignments and prefix.
 */
export function mergeTsvIntoTable(
	table: MarkdownTable,
	startRow: number,
	startCol: number,
	raw: string,
): TableEdit | null {
	const grid = parseTsvGrid(raw);
	if (!grid) return null;
	const safeRow = Math.max(0, startRow);
	const safeCol = Math.max(0, startCol);
	const maxCols = Math.max(...grid.map((r) => r.length));
	const neededRows = safeRow + grid.length;
	const neededCols = safeCol + maxCols;

	const working: MarkdownTable = {
		...table,
		alignments: [...table.alignments],
		rows: table.rows.map((r) => [...r]),
	};
	while (working.alignments.length < neededCols) {
		working.alignments.push("none");
		for (let r = 0; r < working.rows.length; r++) {
			working.rows[r]!.push(r === 0 ? "Column" : "");
		}
	}
	while (working.rows.length < neededRows) {
		working.rows.push(Array.from({ length: working.alignments.length }, () => ""));
	}
	for (let rOff = 0; rOff < grid.length; rOff++) {
		const srcRow = grid[rOff]!;
		for (let cOff = 0; cOff < srcRow.length; cOff++) {
			working.rows[safeRow + rOff]![safeCol + cOff] = serializeTableCell(srcRow[cOff]!);
		}
	}
	return formatTable(working, safeRow + grid.length - 1, safeCol + maxCols - 1);
}

/**
 * What is said of a row that has more cells than the table has columns: the mark drawn at the end of the row
 * (`+1`) and what it says when pointed at. Null for a row that has none, or none with text in it: empty cells
 * at the row's end are not counted.
 *
 * The table draws the header's columns and no more, as GFM does, and said nothing of the rest: a row such as
 * `| or | written a | b in SSL |` under two headers looked complete, and the text after its second cell could
 * only be found by reading the file.
 */
export function extraCellsNote(table: MarkdownTable, row: number, readMode: boolean): { label: string; title: string } | null {
	const more = [...(table.extra?.[row] ?? [])];
	while (more.length && !more[more.length - 1]!.trim()) more.pop();
	if (!more.length) return null;
	const one = more.length === 1;
	return {
		label: `+${more.length}`,
		title: `${one ? "1 more cell" : `${more.length} more cells`} in this row than the table has columns: ${more.join(" | ")}${
			readMode ? "" : `. Use Raw to edit ${one ? "it" : "them"}.`
		}`,
	};
}

type TableController = {
	view: EditorView;
	raw: string;
	from: number;
	to: number;
	startLine: number;
	filePath: string;
	readMode: boolean;
	table: MarkdownTable | null;
	activeCell: { row: number; col: number } | null;
	activeTextarea: HTMLTextAreaElement | null;
	activeCompleter: TextareaCompleter | null;
	pendingFocus: { row: number; col: number; select?: boolean } | null;
	rangeAnchor: { row: number; col: number } | null;
	selectedRange: TableCellRange | null;
	sortState: { col: number; dir: "asc" | "desc" } | null;
	switchingCells: boolean;
	selfDispatching: boolean;
	suppressEnterUntil: number;
	root: TableDomElement;
	hoverBarEl: HTMLDivElement;
	tableEl: HTMLTableElement;
	barEl: HTMLDivElement;
	addColBtn: HTMLButtonElement;
	addRowBtn: HTMLButtonElement;
	syncAll: () => void;
	openCell: (row: number, col: number, opts?: { select?: boolean; atEnd?: boolean }) => void;
	closeActiveCell: (commit?: boolean) => void;
};

type TableDomElement = TableWidgetHost & { __tableCtrl?: TableController };

function codicon(glyph: string): HTMLSpanElement {
	const span = document.createElement("span");
	span.className = "codicon-glyph";
	span.setAttribute("aria-hidden", "true");
	span.textContent = glyph;
	return span;
}

function fitTextarea(el: HTMLTextAreaElement) {
	el.style.height = "auto";
	el.style.height = `${Math.max(22, el.scrollHeight)}px`;
}

function caretOnFirstLine(el: HTMLTextAreaElement): boolean {
	return !el.value.slice(0, el.selectionStart).includes("\n");
}

function caretOnLastLine(el: HTMLTextAreaElement): boolean {
	return !el.value.slice(el.selectionEnd).includes("\n");
}

function runHistory(view: EditorView, dir: "undo" | "redo") {
	if (view.state.readOnly) return;
	const fallback = view.state.facet(historyFallbackFacet);
	if (fallback) {
		if (dir === "undo") fallback.undo();
		else fallback.redo();
		return;
	}
	if (dir === "undo") {
		if (undoDepth(view.state) > 0) undo(view);
	} else {
		if (redoDepth(view.state) > 0) redo(view);
	}
}

export class TableWidget extends WidgetType {
	constructor(
		private readonly raw: string,
		private readonly from: number,
		private readonly to: number,
		private readonly startLine: number,
		private readonly filePath: string,
		private readonly readMode: boolean,
	) {
		super();
	}

	eq(other: TableWidget) {
		return (
			other.raw === this.raw &&
			other.from === this.from &&
			other.to === this.to &&
			other.startLine === this.startLine &&
			other.filePath === this.filePath &&
			other.readMode === this.readMode
		);
	}

	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		const el = dom as TableDomElement;
		const ctrl = el.__tableCtrl;
		if (!ctrl) return false;

		const prevRead = ctrl.readMode;
		const prevRaw = ctrl.raw;
		ctrl.view = view;
		ctrl.raw = this.raw;
		ctrl.from = this.from;
		ctrl.to = this.to;
		ctrl.startLine = this.startLine;
		ctrl.filePath = this.filePath;
		ctrl.readMode = this.readMode;
		ctrl.table = parseTableRaw(this.raw);

		if (this.readMode && ctrl.activeCell) {
			ctrl.closeActiveCell(false);
		}

		if (prevRead !== this.readMode || prevRaw !== this.raw || ctrl.pendingFocus) {
			ctrl.syncAll();
		}
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		const root = document.createElement("div") as TableDomElement;
		root.className = "cm-md-table-wrap cm-md-table-card";
		root.tabIndex = -1;
		root.dataset.editing = "false";
		root.dataset.hasRange = "false";

		const hoverBarEl = document.createElement("div");
		hoverBarEl.className = "cm-tbl-hover-bar";
		hoverBarEl.setAttribute("role", "toolbar");
		hoverBarEl.setAttribute("aria-label", "Quick table actions");

		const scroll = document.createElement("div");
		scroll.className = "cm-md-table-scroll";

		const gridRow = document.createElement("div");
		gridRow.className = "cm-md-table-grid-row";

		const tableEl = document.createElement("table");
		tableEl.className = "cm-md-table";

		const addColBtn = document.createElement("button");
		addColBtn.type = "button";
		addColBtn.className = "cm-tbl-add-col";
		addColBtn.title = "Add column on the right";
		addColBtn.setAttribute("aria-label", "Add column");
		addColBtn.appendChild(codicon("\uea60"));

		gridRow.append(tableEl, addColBtn);

		const addRowBtn = document.createElement("button");
		addRowBtn.type = "button";
		addRowBtn.className = "cm-tbl-add-row";
		addRowBtn.title = "Add a new row at the bottom";
		addRowBtn.append(codicon("\uea60"), document.createTextNode(" Add row"));

		scroll.append(gridRow, addRowBtn);

		const barEl = document.createElement("div");
		barEl.className = "cm-tbl-bar";
		barEl.setAttribute("role", "toolbar");
		barEl.setAttribute("aria-label", "Table editing controls");

		root.append(hoverBarEl, scroll, barEl);

		const ctrl: TableController = {
			view,
			raw: this.raw,
			from: this.from,
			to: this.to,
			startLine: this.startLine,
			filePath: this.filePath,
			readMode: this.readMode,
			table: parseTableRaw(this.raw),
			activeCell: null,
			activeTextarea: null,
			activeCompleter: null,
			pendingFocus: null,
			rangeAnchor: null,
			selectedRange: null,
			sortState: null,
			switchingCells: false,
			selfDispatching: false,
			suppressEnterUntil: 0,
			root,
			hoverBarEl,
			tableEl,
			barEl,
			addColBtn,
			addRowBtn,
			syncAll: () => {},
			openCell: () => {},
			closeActiveCell: () => {},
		};
		root.__tableCtrl = ctrl;

		const latestTable = (): MarkdownTable | null => {
			if (!ctrl.table) return null;
			if (ctrl.activeCell && ctrl.activeTextarea) {
				const upd = updateTableCell(ctrl.table, ctrl.activeCell.row, ctrl.activeCell.col, ctrl.activeTextarea.value);
				return parseTableRaw(upd.text) ?? ctrl.table;
			}
			return ctrl.table;
		};

		const copyDelimited = async (format: "tsv" | "csv", range?: TableCellRange | null) => {
			const t = latestTable();
			if (!t) return;
			const payload = format === "tsv" ? serializeTableToTsv(t, range) : serializeTableToCsv(t, range);
			const scope = range ? "selected cells" : "table";
			const label = `Copied ${scope} as ${format.toUpperCase()}.`;
			try {
				const { copyText } = await import("../commands");
				await copyText(payload, label);
			} catch {
				const ok = await navigator.clipboard?.writeText(payload).then(() => true, () => false);
				if (ok) notify(label);
				else notify("Could not reach the clipboard.", "error");
			}
		};

		const exportCsv = async (range?: TableCellRange | null) => {
			const t = latestTable();
			if (!t) return;
			const csvText = `${serializeTableToCsv(t, range)}\n`;
			const stem = (ctrl.filePath ? baseName(ctrl.filePath).replace(/\.(md|markdown)$/i, "") : "table") || "table";
			const filename = `${stem}-table.csv`;
			if (inApp && appState.workspace?.root) {
				const docsRel = (appState.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");
				const defaultRel = `${docsRel}/exports/${filename}`;
				const { ask, choose } = await import("../dialogs");
				const picked = (await ask("Export table CSV to (path in workspace)", defaultRel))?.trim();
				if (!picked) return;
				const cleanRel = picked.replace(/\\/g, "/").replace(/^\/+/, "");
				const dest = resolvePath(appState.workspace.root, cleanRel);
				if (!isInside(appState.workspace.root, dest)) {
					notify("Export path must stay inside the workspace.", "error");
					return;
				}
				try {
					const exists = await fileExists(dest);
					if (exists) {
						const OVERWRITE = "Overwrite file";
						if (
							(await choose(`${relativeTo(appState.workspace.root, dest)} already exists. Overwrite it?`, [OVERWRITE], {
								danger: OVERWRITE,
							})) !== OVERWRITE
						) {
							return;
						}
					} else {
						await backend.create(dest, "file");
					}
					await backend.write(dest, csvText);
					setState((s) => {
						s.treeVersion += 1;
					});
					notify(`Exported table to ${relativeTo(appState.workspace.root, dest)}.`);
				} catch (err: any) {
					notify(`Could not export CSV: ${err?.message ?? err}`, "error");
				}
				return;
			}
			const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
			notify(`Exported ${filename}.`);
		};

		const dispatchEdit = (edit: TableEdit | null, nextFocus?: { row: number; col: number; select?: boolean } | null) => {
			if (!edit) return;
			if (nextFocus !== undefined) ctrl.pendingFocus = nextFocus;
			const curFrom = Math.min(ctrl.from, ctrl.view.state.doc.length);
			const curTo = Math.min(ctrl.to, ctrl.view.state.doc.length);
			ctrl.selfDispatching = true;
			try {
				ctrl.view.dispatch({
					changes: { from: curFrom, to: curTo, insert: edit.text },
					userEvent: "input.table",
				});
			} finally {
				ctrl.selfDispatching = false;
			}
		};

		/**
		 * Writes the cell being edited: its own text and nothing else (`tableCellTextEdit`). It wrote the whole table
		 * again, padded, at every letter: lines the user was not in were rewritten, and a row with more cells than
		 * the header lost them.
		 */
		const commitActiveCell = (): boolean => {
			if (!ctrl.activeCell || !ctrl.activeTextarea || !ctrl.table) return false;
			const { row, col } = ctrl.activeCell;
			const curRaw = ctrl.table.rows[row]?.[col] ?? "";
			const nextVal = ctrl.activeTextarea.value;
			if (cellValueForEdit(curRaw) === nextVal) return false;
			const edit = tableCellTextEdit(ctrl.raw, ctrl.table, row, col, nextVal);
			if (!edit) return false;
			// The cell's place was measured in the table's text: nothing is written unless that text is what stands there.
			const at = Math.min(ctrl.from, ctrl.view.state.doc.length);
			if (ctrl.view.state.sliceDoc(at, at + ctrl.raw.length) !== ctrl.raw) return false;
			ctrl.selfDispatching = true;
			try {
				ctrl.view.dispatch({
					changes: { from: at + edit.from, to: at + edit.to, insert: edit.insert },
					userEvent: "input.table",
				});
			} finally {
				ctrl.selfDispatching = false;
			}
			return true;
		};

		const sortByColumnInPlace = (col: number, explicitDir?: "asc" | "desc", keepCellFocus = false) => {
			if (ctrl.readMode) return;
			const latest = latestTable();
			if (!latest || col < 0 || col >= latest.alignments.length) return;
			const dir: "asc" | "desc" =
				explicitDir ?? (ctrl.sortState?.col === col && ctrl.sortState.dir === "asc" ? "desc" : "asc");
			ctrl.sortState = { col, dir };
			const focusRow = ctrl.activeCell?.row ?? 0;
			const edit = sortTableByColumn(latest, focusRow, col, dir);
			dispatchEdit(edit, keepCellFocus ? { row: edit.focusRow, col: edit.focusCol, select: false } : null);
		};

		const cycleColumnAlignment = (col: number) => {
			if (ctrl.readMode) return;
			const latest = latestTable();
			if (!latest || col < 0 || col >= latest.alignments.length) return;
			const cur = latest.alignments[col] ?? "none";
			const next: TableAlign = cur === "left" ? "center" : cur === "center" ? "right" : "left";
			const row = ctrl.activeCell?.row ?? 0;
			const edit = setTableAlignment(latest, row, col, next);
			dispatchEdit(edit, ctrl.activeCell ? { row: edit.focusRow, col: edit.focusCol, select: false } : null);
		};

		const exitToDocument = (position: "above" | "below", createIfEof = true) => {
			commitActiveCell();
			ctrl.closeActiveCell(false);
			const doc = ctrl.view.state.doc;
			if (position === "above") {
				const targetLine = Math.max(1, ctrl.startLine - 1);
				const ln = doc.line(targetLine);
				ctrl.view.focus();
				ctrl.view.dispatch({ selection: EditorSelection.cursor(ln.to), scrollIntoView: true });
			} else {
				const endLineNum = doc.lineAt(Math.min(ctrl.to, doc.length)).number;
				if (endLineNum < doc.lines) {
					const ln = doc.line(endLineNum + 1);
					ctrl.view.focus();
					ctrl.view.dispatch({ selection: EditorSelection.cursor(ln.from), scrollIntoView: true });
				} else if (createIfEof) {
					const endPos = doc.length;
					ctrl.view.focus();
					ctrl.view.dispatch({
						changes: { from: endPos, to: endPos, insert: "\n\n" },
						selection: EditorSelection.cursor(endPos + 2),
						scrollIntoView: true,
						userEvent: "input",
					});
				} else if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) {
					document.activeElement.blur();
				}
			}
		};

		const renderCellDisplay = (cellEl: HTMLTableCellElement, rawVal: string) => {
			cellEl.innerHTML = "";
			const viewBox = document.createElement("div");
			viewBox.className = "cm-tbl-cell-view";
			if (rawVal.trim()) {
				viewBox.innerHTML = renderInlineHtml(rawVal, ctrl.filePath, true);
				hydrateImagesInElement(viewBox, ctrl.filePath);
				hydrateMathInElement(viewBox);
			} else {
				viewBox.innerHTML = "&nbsp;";
				viewBox.classList.add("is-empty");
			}
			if (cellEl.tagName === "TH" && !ctrl.readMode) {
				const colIdx = Number(cellEl.dataset.col ?? "0");
				const inner = document.createElement("div");
				inner.className = "cm-tbl-th-inner";
				const sortBtn = document.createElement("button");
				sortBtn.type = "button";
				sortBtn.className = "cm-tbl-th-sort";
				const activeDir = ctrl.sortState?.col === colIdx ? ctrl.sortState.dir : null;
				if (activeDir) sortBtn.classList.add("is-sorted");
				sortBtn.title =
					activeDir === "asc"
						? "Sorted ascending — click to sort Z to A"
						: activeDir === "desc"
							? "Sorted descending — click to sort A to Z"
							: "Sort column A to Z";
				sortBtn.setAttribute("aria-label", sortBtn.title);
				sortBtn.appendChild(codicon(activeDir === "asc" ? "\ueaa1" : activeDir === "desc" ? "\uea9a" : "\ueb55"));
				sortBtn.addEventListener("mousedown", (e) => {
					e.preventDefault();
					e.stopPropagation();
				});
				sortBtn.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					sortByColumnInPlace(colIdx);
				});
				inner.append(viewBox, sortBtn);
				cellEl.appendChild(inner);
				return;
			}
			// A row with more cells than the table has columns says so at its end (see extraCellsNote).
			const more =
				ctrl.table && Number(cellEl.dataset.col) === ctrl.table.alignments.length - 1
					? extraCellsNote(ctrl.table, Number(cellEl.dataset.row), ctrl.readMode)
					: null;
			if (more) {
				const note = document.createElement("span");
				note.className = "cm-tbl-extra";
				note.textContent = more.label;
				note.title = more.title;
				note.setAttribute("aria-label", more.title);
				viewBox.appendChild(note);
			}
			cellEl.appendChild(viewBox);
		};

		const renderHoverBar = () => {
			hoverBarEl.innerHTML = "";
			const t = ctrl.table;
			if (!t) return;

			const mkQuickBtn = (opts: { icon?: string; label?: string; title: string }, run: () => void) => {
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = "cm-tbl-qbtn";
				btn.title = opts.title;
				if (!opts.label) btn.setAttribute("aria-label", opts.title);
				if (opts.icon) btn.appendChild(codicon(opts.icon));
				if (opts.label) {
					const sp = document.createElement("span");
					sp.textContent = opts.label;
					btn.appendChild(sp);
				}
				btn.addEventListener("mousedown", (e) => {
					e.preventDefault();
					e.stopPropagation();
				});
				btn.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					run();
				});
				return btn;
			};

			if (ctrl.selectedRange) {
				const rCount = ctrl.selectedRange.maxRow - ctrl.selectedRange.minRow + 1;
				const cCount = ctrl.selectedRange.maxCol - ctrl.selectedRange.minCol + 1;
				const badge = document.createElement("span");
				badge.className = "cm-tbl-range-badge";
				badge.textContent = `${rCount}x${cCount} selected`;
				badge.title = "Press Ctrl+C to copy selected cells as TSV, or Esc to clear selection";
				hoverBarEl.appendChild(badge);
			}

			const activeCol = ctrl.activeCell?.col ?? ctrl.selectedRange?.minCol ?? 0;
			if (!ctrl.readMode) {
				const align = t.alignments[activeCol] ?? "none";
				const alignTag = align === "center" ? "C" : align === "right" ? "R" : "L";
				hoverBarEl.append(
					mkQuickBtn({ icon: "\ueb55", label: "Sort", title: `Sort rows by column ${activeCol + 1}` }, () =>
						sortByColumnInPlace(activeCol, undefined, Boolean(ctrl.activeCell)),
					),
					mkQuickBtn(
						{ label: `Align ${alignTag}`, title: `Cycle alignment for column ${activeCol + 1} (Left / Center / Right)` },
						() => cycleColumnAlignment(activeCol),
					),
				);
			}

			hoverBarEl.append(
				mkQuickBtn(
					{
						icon: "\uebcc",
						label: "TSV",
						title: ctrl.selectedRange ? "Copy selected cells as TSV (Ctrl+C)" : "Copy entire table as TSV (Excel / Sheets)",
					},
					() => void copyDelimited("tsv", ctrl.selectedRange),
				),
				mkQuickBtn(
					{
						label: "CSV",
						title: ctrl.selectedRange ? "Copy selected cells as CSV" : "Copy entire table as CSV",
					},
					() => void copyDelimited("csv", ctrl.selectedRange),
				),
				mkQuickBtn({ label: "Export .csv", title: "Export table as a .csv file" }, () => void exportCsv(ctrl.selectedRange)),
			);
		};

		const applyRangeClasses = () => {
			const rng = ctrl.selectedRange;
			root.dataset.hasRange = rng ? "true" : "false";
			for (const cell of tableEl.querySelectorAll<HTMLTableCellElement>("th[data-row], td[data-row]")) {
				const r = Number(cell.dataset.row);
				const c = Number(cell.dataset.col);
				const inRange = Boolean(rng && r >= rng.minRow && r <= rng.maxRow && c >= rng.minCol && c <= rng.maxCol);
				cell.classList.toggle("is-range-selected", inRange);
			}
			renderHoverBar();
		};

		const renderBar = () => {
			barEl.innerHTML = "";
			if (ctrl.readMode || !ctrl.table || !ctrl.activeCell) {
				root.dataset.editing = "false";
				renderHoverBar();
				return;
			}
			root.dataset.editing = "true";
			renderHoverBar();
			const { row, col } = ctrl.activeCell;
			const t = ctrl.table;
			const align = t.alignments[col] ?? "none";

			const pos = document.createElement("span");
			pos.className = "cm-tbl-pos";
			pos.title = "Tab / Shift+Tab moves across cells · Enter moves down · Shift+Enter adds a line break · Esc exits";
			pos.append(codicon("\uebb7"), document.createTextNode(row === 0 ? `Header · Col ${col + 1}` : `Row ${row} · Col ${col + 1}`));
			barEl.appendChild(pos);

			const sep = () => {
				const s = document.createElement("span");
				s.className = "cm-tbl-sep";
				s.setAttribute("aria-hidden", "true");
				return s;
			};

			const mkBtn = (
				opts: { icon?: string; label?: string; title: string; disabled?: boolean; active?: boolean; danger?: boolean },
				run: () => void,
			) => {
				const btn = document.createElement("button");
				btn.type = "button";
				if (opts.active) btn.classList.add("active");
				if (opts.danger) btn.classList.add("danger");
				btn.disabled = Boolean(opts.disabled);
				btn.title = opts.title;
				if (!opts.label) btn.setAttribute("aria-label", opts.title);
				if (opts.icon) btn.appendChild(codicon(opts.icon));
				if (opts.label) {
					const sp = document.createElement("span");
					sp.textContent = opts.label;
					btn.appendChild(sp);
				}
				btn.addEventListener("mousedown", (e) => {
					e.preventDefault();
					e.stopPropagation();
				});
				btn.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					run();
				});
				return btn;
			};

			const runOp = (fn: (tbl: MarkdownTable) => TableEdit | null) => {
				if (!ctrl.table) return;
				let latest = ctrl.table;
				if (ctrl.activeCell && ctrl.activeTextarea) {
					const upd = updateTableCell(latest, ctrl.activeCell.row, ctrl.activeCell.col, ctrl.activeTextarea.value);
					latest = parseTableRaw(upd.text) ?? latest;
				}
				const edit = fn(latest);
				if (!edit) return;
				dispatchEdit(edit, { row: edit.focusRow, col: edit.focusCol, select: Boolean(edit.selectCell) });
			};

			const rowGrp = document.createElement("div");
			rowGrp.className = "cm-tbl-group";
			rowGrp.append(
				mkBtn({ icon: "\uea60", label: "Row above", title: "Insert row above" }, () => runOp((tbl) => insertTableRow(tbl, row, "above"))),
				mkBtn({ icon: "\uea60", label: "Row below", title: "Insert row below" }, () => runOp((tbl) => insertTableRow(tbl, row, "below"))),
				mkBtn({ icon: "\ueaa1", title: "Move row up", disabled: row <= 1 }, () => runOp((tbl) => moveTableRow(tbl, row, col, -1))),
				mkBtn({ icon: "\uea9a", title: "Move row down", disabled: row <= 0 || row >= t.rows.length - 1 }, () => runOp((tbl) => moveTableRow(tbl, row, col, 1))),
				mkBtn({ icon: "\uea81", title: "Delete row", disabled: row <= 0 || t.rows.length <= 1, danger: true }, () => runOp((tbl) => deleteTableRow(tbl, row, col))),
			);

			const colGrp = document.createElement("div");
			colGrp.className = "cm-tbl-group";
			colGrp.append(
				mkBtn({ icon: "\uea60", label: "Col left", title: "Insert column to the left" }, () => runOp((tbl) => insertTableColumn(tbl, row, col, "left"))),
				mkBtn({ icon: "\uea60", label: "Col right", title: "Insert column to the right" }, () => runOp((tbl) => insertTableColumn(tbl, row, col, "right"))),
				mkBtn({ icon: "\uea9b", title: "Move column left", disabled: col <= 0 }, () => runOp((tbl) => moveTableColumn(tbl, row, col, -1))),
				mkBtn({ icon: "\uea9c", title: "Move column right", disabled: col >= t.alignments.length - 1 }, () => runOp((tbl) => moveTableColumn(tbl, row, col, 1))),
				mkBtn({ icon: "\uea76", title: "Delete column", disabled: t.alignments.length <= 1, danger: true }, () => runOp((tbl) => deleteTableColumn(tbl, row, col))),
			);

			const alignGrp = document.createElement("div");
			alignGrp.className = "cm-tbl-group";
			alignGrp.append(
				mkBtn({ label: "L", title: "Align column left", active: align === "left" }, () => runOp((tbl) => setTableAlignment(tbl, row, col, "left"))),
				mkBtn({ label: "C", title: "Align column center", active: align === "center" }, () => runOp((tbl) => setTableAlignment(tbl, row, col, "center"))),
				mkBtn({ label: "R", title: "Align column right", active: align === "right" }, () => runOp((tbl) => setTableAlignment(tbl, row, col, "right"))),
			);

			const utilGrp = document.createElement("div");
			utilGrp.className = "cm-tbl-group";
			utilGrp.append(
				mkBtn({ icon: "\ueb55", label: "A–Z", title: "Sort rows A to Z by this column" }, () => runOp((tbl) => sortTableByColumn(tbl, row, col, "asc"))),
				mkBtn({ label: "Z–A", title: "Sort rows Z to A by this column" }, () => runOp((tbl) => sortTableByColumn(tbl, row, col, "desc"))),
				mkBtn({ label: "Format", title: "Align pipes and pad Markdown columns" }, () => runOp((tbl) => formatTable(tbl, row, col))),
				mkBtn({ icon: "\uea73", label: "Raw", title: "Edit raw Markdown pipe syntax" }, () => {
					commitActiveCell();
					ctrl.closeActiveCell(false);
					const fromPos = Math.min(ctrl.from, ctrl.view.state.doc.length);
					const toPos = Math.min(ctrl.to, ctrl.view.state.doc.length);
					ctrl.view.focus();
					ctrl.view.dispatch({
						effects: setRawEditBlockEffect.of({ from: fromPos, to: toPos }),
						selection: EditorSelection.cursor(fromPos),
						scrollIntoView: true,
					});
				}),
			);

			barEl.append(sep(), rowGrp, sep(), colGrp, sep(), alignGrp, sep(), utilGrp);
		};

		const findCellEl = (row: number, col: number): HTMLTableCellElement | null =>
			tableEl.querySelector<HTMLTableCellElement>(`[data-row="${row}"][data-col="${col}"]`);

		ctrl.closeActiveCell = (commit = true) => {
			if (commit) commitActiveCell();
			ctrl.activeCompleter?.dispose();
			ctrl.activeCompleter = null;
			const prev = ctrl.activeCell;
			ctrl.activeCell = null;
			ctrl.activeTextarea = null;
			if (prev) {
				const cellEl = findCellEl(prev.row, prev.col);
				if (cellEl) {
					cellEl.classList.remove("is-active-cell");
					renderCellDisplay(cellEl, ctrl.table?.rows[prev.row]?.[prev.col] ?? "");
				}
			}
			renderBar();
		};

		ctrl.openCell = (row: number, col: number, opts: { select?: boolean; atEnd?: boolean } = {}) => {
			if (ctrl.readMode || !ctrl.table) return;
			const clampedRow = Math.max(0, Math.min(ctrl.table.rows.length - 1, row));
			const clampedCol = Math.max(0, Math.min(ctrl.table.alignments.length - 1, col));

			if (ctrl.activeCell && ctrl.activeCell.row === clampedRow && ctrl.activeCell.col === clampedCol && ctrl.activeTextarea?.isConnected) {
				ctrl.activeTextarea.focus();
				if (opts.select) ctrl.activeTextarea.select();
				return;
			}

			ctrl.switchingCells = true;
			try {
				ctrl.activeCompleter?.dispose();
				ctrl.activeCompleter = null;
				if (ctrl.activeCell) {
					const prev = ctrl.activeCell;
					commitActiveCell();
					const prevEl = findCellEl(prev.row, prev.col);
					if (prevEl) {
						prevEl.classList.remove("is-active-cell");
						renderCellDisplay(prevEl, ctrl.table?.rows[prev.row]?.[prev.col] ?? "");
					}
				}

				const cellEl = findCellEl(clampedRow, clampedCol);
				if (!cellEl) return;

				ctrl.activeCell = { row: clampedRow, col: clampedCol };
				cellEl.classList.add("is-active-cell");
				cellEl.innerHTML = "";

				const ta = document.createElement("textarea");
				ta.className = "cm-tbl-cell-input";
				ta.rows = 1;
				ta.spellcheck = true;
				const rawVal = ctrl.table.rows[clampedRow]?.[clampedCol] ?? "";
				ta.value = cellValueForEdit(rawVal);
				const align = ctrl.table.alignments[clampedCol] ?? "none";
				if (align !== "none") ta.style.textAlign = align;

				const completer = createTextareaCompleter(ta, {
					mode: "markdown",
					filePath: () => ctrl.filePath,
					onApply: () => {
						fitTextarea(ta);
						commitActiveCell();
					},
				});
				ctrl.activeCompleter = completer;

				let plainPasteUntil = 0;

				const runCellOp = (fn: (tbl: MarkdownTable) => TableEdit | null) => {
					if (!ctrl.table) return;
					const upd = updateTableCell(ctrl.table, clampedRow, clampedCol, ta.value);
					const latest = parseTableRaw(upd.text) ?? ctrl.table;
					const edit = fn(latest);
					if (!edit) return;
					dispatchEdit(edit, { row: edit.focusRow, col: edit.focusCol, select: Boolean(edit.selectCell) });
				};

				ta.addEventListener("beforeinput", (e) => {
					if (
						performance.now() < ctrl.suppressEnterUntil &&
						(e.inputType === "insertLineBreak" || e.inputType === "insertParagraph" || e.data === "\n" || e.data === "\r")
					) {
						e.preventDefault();
						e.stopPropagation();
					}
				});

				ta.addEventListener("keypress", (e) => {
					if (performance.now() < ctrl.suppressEnterUntil && e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						e.stopPropagation();
					}
				});

				ta.addEventListener("input", () => {
					fitTextarea(ta);
					commitActiveCell();
					completer.update();
				});

				ta.addEventListener("paste", (e) => {
					e.stopPropagation();
					const plainOnly = performance.now() < plainPasteUntil;
					plainPasteUntil = 0;
					if (plainOnly || !ctrl.table) return;
					const raw = e.clipboardData?.getData("text/plain") ?? "";
					if (!raw) return;

					// 1. Multi-row or multi-column TSV paste expands across cells starting at (row, col), auto-growing rows/columns.
					const latestUpd = updateTableCell(ctrl.table, clampedRow, clampedCol, ta.value);
					const latestTbl = parseTableRaw(latestUpd.text) ?? ctrl.table;
					const merged = mergeTsvIntoTable(latestTbl, clampedRow, clampedCol, raw);
					if (merged) {
						e.preventDefault();
						completer.close();
						dispatchEdit(merged, { row: merged.focusRow, col: merged.focusCol, select: false });
						return;
					}

					// 2. URL pasted over selected text inside cell -> `[selected](url)`.
					const s = ta.selectionStart ?? 0;
					const end = ta.selectionEnd ?? s;
					if (end > s) {
						const wrapped = pasteUrlOverSelection(ta.value.slice(s, end), raw);
						if (wrapped) {
							e.preventDefault();
							completer.close();
							ta.setRangeText(wrapped, s, end, "end");
							fitTextarea(ta);
							commitActiveCell();
						}
					}
				});

				ta.addEventListener("mousedown", (e) => {
					e.stopPropagation();
				});

				ta.addEventListener("keydown", (e) => {
					if (completer.handleKeyDown(e)) return;
					if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "v") {
						plainPasteUntil = performance.now() + 400;
						e.stopPropagation();
						return;
					}
					if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
						e.preventDefault();
						e.stopPropagation();
						completer.close();
						commitActiveCell();
						runHistory(ctrl.view, e.shiftKey ? "redo" : "undo");
						return;
					}
					if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "y") {
						e.preventDefault();
						e.stopPropagation();
						completer.close();
						commitActiveCell();
						runHistory(ctrl.view, "redo");
						return;
					}
					// Structural table shortcuts: Alt+Arrows reorder rows/columns, Ctrl+Alt+Enter inserts row below, Ctrl+Shift+Backspace deletes row.
					if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
						if (e.key === "ArrowUp") {
							e.preventDefault();
							e.stopPropagation();
							completer.close();
							runCellOp((tbl) => moveTableRow(tbl, clampedRow, clampedCol, -1));
							return;
						}
						if (e.key === "ArrowDown") {
							e.preventDefault();
							e.stopPropagation();
							completer.close();
							runCellOp((tbl) => moveTableRow(tbl, clampedRow, clampedCol, 1));
							return;
						}
						if (e.key === "ArrowLeft") {
							e.preventDefault();
							e.stopPropagation();
							completer.close();
							runCellOp((tbl) => moveTableColumn(tbl, clampedRow, clampedCol, -1));
							return;
						}
						if (e.key === "ArrowRight") {
							e.preventDefault();
							e.stopPropagation();
							completer.close();
							runCellOp((tbl) => moveTableColumn(tbl, clampedRow, clampedCol, 1));
							return;
						}
					}
					if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.key === "Enter") {
						ctrl.suppressEnterUntil = performance.now() + 80;
						e.preventDefault();
						e.stopPropagation();
						completer.close();
						runCellOp((tbl) => insertTableRow(tbl, clampedRow, "below"));
						return;
					}
					if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key === "Backspace") {
						e.preventDefault();
						e.stopPropagation();
						completer.close();
						if (!ctrl.table || clampedRow <= 0) return;
						const rowEmpty = ctrl.table.rows[clampedRow]?.every((c, idx) => !(idx === clampedCol ? ta.value : c).trim()) ?? false;
						if (ctrl.table.rows.length > 2 || rowEmpty) {
							runCellOp((tbl) => deleteTableRow(tbl, clampedRow, clampedCol));
						}
						return;
					}
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						completer.close();
						exitToDocument("below", false);
						return;
					}
					if (e.key === "Tab") {
						e.preventDefault();
						e.stopPropagation();
						completer.close();
						if (!ctrl.table) return;
						const dir = e.shiftKey ? -1 : 1;
						const cols = ctrl.table.alignments.length;
						const updated = updateTableCell(ctrl.table, clampedRow, clampedCol, ta.value);
						const latest = parseTableRaw(updated.text) ?? ctrl.table;
						const atVeryStart = dir === -1 && clampedRow === 0 && clampedCol === 0;
						const atVeryEnd = dir === 1 && clampedRow === latest.rows.length - 1 && clampedCol === cols - 1;
						// Tab and Enter write the cell that was being edited and move on. They wrote the whole table whenever
						// it was not in padded form, though nothing in it had changed.
						if (atVeryStart) {
							commitActiveCell();
							ctrl.openCell(0, 0, { select: true });
						} else if (atVeryEnd) {
							const edit = stepTableCell(latest, clampedRow, clampedCol, 1);
							dispatchEdit(edit, { row: edit.focusRow, col: edit.focusCol, select: true });
						} else {
							commitActiveCell();
							const nextCol = dir === 1 ? (clampedCol + 1 < cols ? clampedCol + 1 : 0) : clampedCol > 0 ? clampedCol - 1 : cols - 1;
							const nextRow =
								dir === 1
									? clampedCol + 1 < cols
										? clampedRow
										: Math.min(latest.rows.length - 1, clampedRow + 1)
									: clampedCol > 0
										? clampedRow
										: Math.max(0, clampedRow - 1);
							ctrl.openCell(nextRow, nextCol, { select: true });
						}
						return;
					}
					if (e.key === "Enter" && !e.shiftKey) {
						ctrl.suppressEnterUntil = performance.now() + 80;
						e.preventDefault();
						e.stopPropagation();
						completer.close();
						if (!ctrl.table) return;
						const updated = updateTableCell(ctrl.table, clampedRow, clampedCol, ta.value);
						const latest = parseTableRaw(updated.text) ?? ctrl.table;
						if (clampedRow + 1 >= latest.rows.length) {
							const edit = enterTableRow(latest, clampedRow, clampedCol);
							dispatchEdit(edit, { row: edit.focusRow, col: edit.focusCol, select: true });
						} else {
							commitActiveCell();
							ctrl.openCell(clampedRow + 1, clampedCol, { select: true });
						}
						return;
					}
					if (e.key === "ArrowUp" && !e.shiftKey && caretOnFirstLine(ta)) {
						e.preventDefault();
						e.stopPropagation();
						completer.close();
						if (clampedRow === 0) exitToDocument("above");
						else {
							commitActiveCell();
							ctrl.openCell(clampedRow - 1, clampedCol, { atEnd: true });
						}
						return;
					}
					if (e.key === "ArrowDown" && !e.shiftKey && caretOnLastLine(ta)) {
						e.preventDefault();
						e.stopPropagation();
						completer.close();
						if (!ctrl.table || clampedRow >= ctrl.table.rows.length - 1) exitToDocument("below");
						else {
							commitActiveCell();
							ctrl.openCell(clampedRow + 1, clampedCol, { atEnd: true });
						}
						return;
					}
					e.stopPropagation();
				});

				ta.addEventListener("blur", (e) => {
					completer.close();
					if (ctrl.switchingCells) return;
					commitActiveCell();
					const nextFocused = e.relatedTarget instanceof Node ? e.relatedTarget : null;
					if (nextFocused && root.contains(nextFocused)) return;
					// Defer visual bar collapse by 1 frame so clicking a paragraph below the table lands on the exact clicked line first!
					requestAnimationFrame(() => {
						if (ctrl.switchingCells) return;
						if (document.activeElement && root.contains(document.activeElement)) return;
						if (ctrl.activeTextarea === ta) ctrl.closeActiveCell(false);
					});
				});

				ctrl.activeTextarea = ta;
				cellEl.appendChild(ta);
				renderBar();

				const focusNow = () => {
					if (!ta.isConnected || ctrl.activeTextarea !== ta) return;
					fitTextarea(ta);
					ta.focus();
					if (opts.select) ta.select();
					else if (opts.atEnd) ta.setSelectionRange(ta.value.length, ta.value.length);
				};
				if (root.isConnected) focusNow();
				else requestAnimationFrame(focusNow);
			} finally {
				ctrl.switchingCells = false;
			}
		};

		ctrl.syncAll = () => {
			const t = ctrl.table;
			if (!t) {
				ctrl.activeCompleter?.dispose();
				ctrl.activeCompleter = null;
				ctrl.activeCell = null;
				ctrl.activeTextarea = null;
				tableEl.innerHTML = renderInlineHtml(ctrl.raw, ctrl.filePath);
				hydrateImagesInElement(tableEl, ctrl.filePath);
				hydrateMathInElement(tableEl);
				addColBtn.hidden = true;
				addRowBtn.hidden = true;
				hoverBarEl.innerHTML = "";
				barEl.innerHTML = "";
				root.dataset.editing = "false";
				return;
			}

			addColBtn.hidden = ctrl.readMode;
			addRowBtn.hidden = ctrl.readMode;
			root.classList.toggle("is-read", ctrl.readMode);

			const existingRows = tableEl.querySelectorAll("tr");
			const sameShape =
				existingRows.length === t.rows.length &&
				(existingRows[0]?.children.length ?? 0) === t.alignments.length;

			if (sameShape && ctrl.activeCell && ctrl.activeTextarea?.isConnected && !ctrl.pendingFocus) {
				for (let r = 0; r < t.rows.length; r++) {
					const tr = existingRows[r]!;
					for (let c = 0; c < t.alignments.length; c++) {
						const cellEl = tr.children[c] as HTMLTableCellElement;
						const align = t.alignments[c] ?? "none";
						cellEl.style.textAlign = align === "none" ? "" : align;
						if (r === ctrl.activeCell.row && c === ctrl.activeCell.col) {
							ctrl.activeTextarea.style.textAlign = align === "none" ? "" : align;
							// If an external change or Undo/Redo modified the active cell, sync the textarea immediately!
							if (!ctrl.selfDispatching) {
								const nextText = cellValueForEdit(t.rows[r]?.[c] ?? "");
								if (ctrl.activeTextarea.value !== nextText) {
									ctrl.activeTextarea.value = nextText;
									fitTextarea(ctrl.activeTextarea);
								}
							}
							continue;
						}
						renderCellDisplay(cellEl, t.rows[r]?.[c] ?? "");
					}
				}
				renderBar();
				return;
			}

			ctrl.activeCompleter?.dispose();
			ctrl.activeCompleter = null;
			const preserve = ctrl.pendingFocus ?? (ctrl.activeCell ? { ...ctrl.activeCell, select: false } : null);
			ctrl.pendingFocus = null;
			ctrl.activeCell = null;
			ctrl.activeTextarea = null;
			if (
				ctrl.selectedRange &&
				(ctrl.selectedRange.maxRow >= t.rows.length || ctrl.selectedRange.maxCol >= t.alignments.length)
			) {
				ctrl.selectedRange = null;
			}

			tableEl.innerHTML = "";
			const thead = document.createElement("thead");
			const headTr = document.createElement("tr");
			for (let c = 0; c < t.alignments.length; c++) {
				const th = document.createElement("th");
				th.dataset.row = "0";
				th.dataset.col = String(c);
				const align = t.alignments[c] ?? "none";
				if (align !== "none") th.style.textAlign = align;
				renderCellDisplay(th, t.rows[0]?.[c] ?? "");
				headTr.appendChild(th);
			}
			thead.appendChild(headTr);
			tableEl.appendChild(thead);

			const tbody = document.createElement("tbody");
			for (let r = 1; r < t.rows.length; r++) {
				const tr = document.createElement("tr");
				for (let c = 0; c < t.alignments.length; c++) {
					const td = document.createElement("td");
					td.dataset.row = String(r);
					td.dataset.col = String(c);
					const align = t.alignments[c] ?? "none";
					if (align !== "none") td.style.textAlign = align;
					renderCellDisplay(td, t.rows[r]?.[c] ?? "");
					tr.appendChild(td);
				}
				tbody.appendChild(tr);
			}
			tableEl.appendChild(tbody);

			if (!ctrl.readMode && preserve) {
				ctrl.openCell(preserve.row, preserve.col, { select: preserve.select, atEnd: !preserve.select });
			} else {
				renderBar();
			}
			applyRangeClasses();
		};

		// Programmatic focus entrypoint (e.g. after inserting a table, template with cursor in cell, or reveal).
		root.__liveTableFocus = (pos, opts) => {
			if (ctrl.readMode || !ctrl.table) return false;
			if (pos < ctrl.from || pos > ctrl.to) return false;
			const doc = ctrl.view.state.doc;
			const line = doc.lineAt(Math.min(pos, doc.length));
			const localTable: MarkdownTable = {
				...ctrl.table,
				startLine: ctrl.startLine - 1,
				endLine: doc.lineAt(Math.min(ctrl.to, doc.length)).number - 1,
			};
			const rawRow = docLineToTableRow(localTable, line.number - 1);
			const row = Math.max(0, Math.min(ctrl.table.rows.length - 1, rawRow));
			const col = locateTableCell(line.text, pos - line.from, ctrl.table.alignments.length, ctrl.table.prefix);
			ctrl.openCell(row, col, { select: opts?.select, atEnd: !opts?.select });
			findCellEl(row, col)?.scrollIntoView({ block: "nearest", inline: "nearest" });
			return true;
		};

		// Keep clicks on the table card chrome/bars from bubbling to CM6.
		hoverBarEl.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		barEl.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});

		root.addEventListener("keydown", (e) => {
			if (!ctrl.selectedRange || !ctrl.table) return;
			if (document.activeElement?.closest(".cm-tbl-cell-input")) return;
			if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c") {
				e.preventDefault();
				e.stopPropagation();
				void copyDelimited("tsv", ctrl.selectedRange);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				ctrl.selectedRange = null;
				applyRangeClasses();
			}
		});

		root.addEventListener("focusout", (e) => {
			if (!ctrl.selectedRange) return;
			const next = e.relatedTarget instanceof Node ? e.relatedTarget : null;
			if (next && root.contains(next)) return;
			ctrl.selectedRange = null;
			applyRangeClasses();
		});

		tableEl.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			const target = e.target as HTMLElement | null;
			if (target?.closest(".cm-tbl-th-sort")) return;
			const cb = ctrl.view.state.facet(liveCallbacksFacet);
			const anchor = target?.closest<HTMLAnchorElement>("a[href]");
			const tag = target?.closest<HTMLElement>(".md-tag");
			const img = target?.closest<HTMLImageElement>("img");
			if (anchor && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (tag && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				const label = tag.dataset.tag ?? tag.textContent?.trim() ?? "";
				if (label) cb?.onTagClick(label);
				return;
			}
			if (img && !e.altKey && img.src) {
				e.preventDefault();
				e.stopPropagation();
				cb?.onOpenImageLightbox({ src: img.src, alt: img.alt || "" });
				return;
			}
			if (target?.closest(".cm-tbl-cell-input")) {
				e.stopPropagation();
				return;
			}

			const cell = target?.closest<HTMLTableCellElement>("th[data-row], td[data-row]");
			if (!cell) return;
			const r = Number(cell.dataset.row);
			const c = Number(cell.dataset.col);

			if (e.shiftKey) {
				const base = ctrl.rangeAnchor ?? ctrl.activeCell ?? { row: r, col: c };
				e.preventDefault();
				e.stopPropagation();
				if (ctrl.activeCell) ctrl.closeActiveCell(true);
				ctrl.rangeAnchor = base;
				ctrl.selectedRange = normalizeTableRange(base, { row: r, col: c });
				applyRangeClasses();
				root.focus({ preventScroll: true });
				return;
			}

			ctrl.rangeAnchor = { row: r, col: c };
			if (ctrl.selectedRange) {
				ctrl.selectedRange = null;
				applyRangeClasses();
			}
			if (ctrl.readMode) return;

			e.preventDefault();
			e.stopPropagation();
			ctrl.openCell(r, c, { atEnd: true });
		});

		tableEl.addEventListener("click", (e) => {
			const anchor = (e.target instanceof Element ? e.target : null)?.closest<HTMLAnchorElement>("a[href]");
			if (!anchor) return;
			e.preventDefault();
			e.stopPropagation();
			if (!e.altKey) {
				ctrl.view.state.facet(liveCallbacksFacet)?.onFollowLink(anchor.getAttribute("href") ?? "");
			}
		});

		tableEl.addEventListener("contextmenu", (e) => {
			const target = e.target as HTMLElement | null;
			const cell = target?.closest<HTMLTableCellElement>("th[data-row], td[data-row]");
			const t = latestTable();
			if (!cell || !t) return;
			e.preventDefault();
			e.stopPropagation();
			const row = Number(cell.dataset.row);
			const col = Number(cell.dataset.col);
			const align = t.alignments[col] ?? "none";
			const hasRange = Boolean(ctrl.selectedRange);
			const COPY_TSV = hasRange ? "Copy selection as TSV" : "Copy table as TSV";
			const COPY_CSV = hasRange ? "Copy selection as CSV" : "Copy table as CSV";
			const EXPORT_CSV = "Export .csv…";

			const ROW_ABOVE = "Insert row above";
			const ROW_BELOW = "Insert row below";
			const COL_LEFT = "Insert column left";
			const COL_RIGHT = "Insert column right";
			const MOVE_ROW_UP = "Move row up";
			const MOVE_ROW_DOWN = "Move row down";
			const MOVE_COL_LEFT = "Move column left";
			const MOVE_COL_RIGHT = "Move column right";
			const ALIGN_LEFT = "Align left";
			const ALIGN_CENTER = "Align center";
			const ALIGN_RIGHT = "Align right";
			const SORT_ASC = "Sort ascending (A–Z)";
			const SORT_DESC = "Sort descending (Z–A)";
			const DEL_ROW = "Delete row";
			const DEL_COL = "Delete column";

			const entries: RowMenuEntry[] = ctrl.readMode
				? [
						{ label: COPY_TSV, value: COPY_TSV, keys: hasRange ? "Ctrl+C" : undefined },
						COPY_CSV,
						"separator",
						EXPORT_CSV,
					]
				: [
						ROW_ABOVE,
						ROW_BELOW,
						COL_LEFT,
						COL_RIGHT,
						"separator",
						{
							label: "Move",
							children: [
								{ label: MOVE_ROW_UP, value: MOVE_ROW_UP, disabled: row <= 1 },
								{ label: MOVE_ROW_DOWN, value: MOVE_ROW_DOWN, disabled: row <= 0 || row >= t.rows.length - 1 },
								"separator",
								{ label: MOVE_COL_LEFT, value: MOVE_COL_LEFT, disabled: col <= 0 },
								{ label: MOVE_COL_RIGHT, value: MOVE_COL_RIGHT, disabled: col >= t.alignments.length - 1 },
							],
						},
						{
							label: "Align column",
							children: [
								{ label: ALIGN_LEFT, value: ALIGN_LEFT, checked: align === "left" },
								{ label: ALIGN_CENTER, value: ALIGN_CENTER, checked: align === "center" },
								{ label: ALIGN_RIGHT, value: ALIGN_RIGHT, checked: align === "right" },
							],
						},
						{
							label: "Sort column",
							children: [SORT_ASC, SORT_DESC],
						},
						"separator",
						{ label: DEL_ROW, value: DEL_ROW, danger: true, disabled: row <= 0 || t.rows.length <= 1 },
						{ label: DEL_COL, value: DEL_COL, danger: true, disabled: t.alignments.length <= 1 },
						"separator",
						{ label: COPY_TSV, value: COPY_TSV, keys: hasRange ? "Ctrl+C" : undefined },
						COPY_CSV,
						EXPORT_CSV,
					];

			const at = { x: e.clientX, y: e.clientY };
			const box = ctrl.activeTextarea && ctrl.activeTextarea.isConnected ? ctrl.activeTextarea : undefined;
			void (async () => {
				const { chooseFromMenu } = await import("../panels/RowMenu");
				const picked = await chooseFromMenu("Table actions", entries, at, box ? { box } : {});
				if (!picked || !root.isConnected) return;
				if (picked === COPY_TSV) return void copyDelimited("tsv", ctrl.selectedRange);
				if (picked === COPY_CSV) return void copyDelimited("csv", ctrl.selectedRange);
				if (picked === EXPORT_CSV) return void exportCsv(ctrl.selectedRange);
				const cur = latestTable();
				if (!cur || ctrl.readMode) return;
				const runEdit = (edit: TableEdit | null) => {
					if (!edit) return;
					dispatchEdit(edit, { row: edit.focusRow, col: edit.focusCol, select: Boolean(edit.selectCell) });
				};
				if (picked === ROW_ABOVE) runEdit(insertTableRow(cur, row, "above"));
				else if (picked === ROW_BELOW) runEdit(insertTableRow(cur, row, "below"));
				else if (picked === COL_LEFT) runEdit(insertTableColumn(cur, row, col, "left"));
				else if (picked === COL_RIGHT) runEdit(insertTableColumn(cur, row, col, "right"));
				else if (picked === MOVE_ROW_UP) runEdit(moveTableRow(cur, row, col, -1));
				else if (picked === MOVE_ROW_DOWN) runEdit(moveTableRow(cur, row, col, 1));
				else if (picked === MOVE_COL_LEFT) runEdit(moveTableColumn(cur, row, col, -1));
				else if (picked === MOVE_COL_RIGHT) runEdit(moveTableColumn(cur, row, col, 1));
				else if (picked === ALIGN_LEFT) runEdit(setTableAlignment(cur, row, col, "left"));
				else if (picked === ALIGN_CENTER) runEdit(setTableAlignment(cur, row, col, "center"));
				else if (picked === ALIGN_RIGHT) runEdit(setTableAlignment(cur, row, col, "right"));
				else if (picked === SORT_ASC) sortByColumnInPlace(col, "asc", Boolean(ctrl.activeCell));
				else if (picked === SORT_DESC) sortByColumnInPlace(col, "desc", Boolean(ctrl.activeCell));
				else if (picked === DEL_ROW) runEdit(deleteTableRow(cur, row, col));
				else if (picked === DEL_COL) runEdit(deleteTableColumn(cur, row, col));
			})();
		});

		tableEl.addEventListener("mouseover", (e) => {
			const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
			if (anchor) ctrl.view.state.facet(liveCallbacksFacet)?.onHoverLink({ kind: "href", href: anchor.getAttribute("href") ?? "", anchor });
		});
		tableEl.addEventListener("mouseout", (e) => {
			const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
			if (anchor) ctrl.view.state.facet(liveCallbacksFacet)?.onHoverLeave();
		});

		addRowBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		addRowBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (ctrl.readMode || !ctrl.table) return;
			let latest = ctrl.table;
			if (ctrl.activeCell && ctrl.activeTextarea) {
				const upd = updateTableCell(latest, ctrl.activeCell.row, ctrl.activeCell.col, ctrl.activeTextarea.value);
				latest = parseTableRaw(upd.text) ?? latest;
			}
			const edit = insertTableRow(latest, latest.rows.length - 1, "below");
			dispatchEdit(edit, { row: edit.focusRow, col: 0, select: true });
		});

		addColBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		addColBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (ctrl.readMode || !ctrl.table) return;
			let latest = ctrl.table;
			if (ctrl.activeCell && ctrl.activeTextarea) {
				const upd = updateTableCell(latest, ctrl.activeCell.row, ctrl.activeCell.col, ctrl.activeTextarea.value);
				latest = parseTableRaw(upd.text) ?? latest;
			}
			const edit = insertTableColumn(latest, 0, latest.alignments.length - 1, "right");
			dispatchEdit(edit, { row: 0, col: edit.focusCol, select: true });
		});

		ctrl.syncAll();
		return root;
	}

	destroy(dom: HTMLElement) {
		const ctrl = (dom as TableDomElement).__tableCtrl;
		ctrl?.activeCompleter?.dispose();
	}

	ignoreEvent() {
		return true;
	}
}
