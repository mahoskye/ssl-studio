// Obsidian-grade Markdown keymap + full VS Code / Monaco command & menu parity
// for CodeMirror 6 Live Preview (ADR 0028).
// Every edit mutates the underlying plain Markdown text directly (ADR 0002).
import { completionStatus } from "@codemirror/autocomplete";
import {
	copyLineDown,
	copyLineUp,
	defaultKeymap,
	deleteLine,
	historyKeymap,
	indentLess,
	indentMore,
	moveLineDown,
	moveLineUp,
	redo,
	redoDepth,
	selectAll,
	selectMatchingBracket,
	selectParentSyntax,
	undo,
	undoDepth,
} from "@codemirror/commands";
import { foldAll, foldKeymap, unfoldAll } from "@codemirror/language";
import { gotoLine, openSearchPanel, search, searchKeymap, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { EditorSelection, Prec, type ChangeSpec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type Command, type KeyBinding } from "@codemirror/view";
import { fenced } from "../../shared/catalog";
import { linkWritten } from "../../shared/docLinks";
import { DRAG_TYPE, dropEffectFor } from "../../shared/editorDocHelpers";
import { htmlToMarkdown, looksLikeRichHtml, tsvToMarkdownTable } from "../../shared/htmlToMarkdown";
import { nameFor } from "../../shared/namedLinks";
import { baseName, dirName, relativePath } from "../../shared/paths";
import {
	blockquoteEnter,
	insertLinkEdit,
	parseCalloutHeader,
	pasteUrlOverSelection,
	smartListBackspace,
	smartListIndent,
	toggleCheckboxLine,
	toggleInlineWrap,
	WRAP_PAIRS,
} from "../../shared/markdownEdit";
import {
	createEmptyTable,
	deleteTableColumn,
	deleteTableRow,
	docLineToTableRow,
	enterTableRow,
	focusRangeInTableEdit,
	formatTable,
	insertTableColumn,
	insertTableRow,
	locateTableCell,
	moveTableColumn,
	moveTableRow,
	parseMarkdownTable,
	setTableAlignment,
	sortTableByColumn,
	stepTableCell,
	type MarkdownTable,
	type TableEdit,
} from "../../shared/markdownTables";
import { listEnter } from "../../shared/markdownText";
import { backend } from "../backend";
import { docs } from "../project";
import { showPanel } from "../panels/registry";
import { canonical, notify, state as appState } from "../state";
import { focusLiveWidgetAt, historyFallbackFacet, rawEditBlockField, type HistoryFallback } from "./cmLiveShared";
import { IMAGE_FILE_RE, saveImageAttachment } from "./imageResolve";
import {
	computeDuplicateLineOrSelection,
	computeInsertLineAbove,
	computeInsertLineBelow,
	computeJoinLines,
	computeSelectLine,
	type PureLineEdit,
} from "./markdownHtml";

export {
	computeDuplicateLineOrSelection,
	computeInsertLineAbove,
	computeInsertLineBelow,
	computeJoinLines,
	computeSelectLine,
	historyFallbackFacet,
	type HistoryFallback,
	type PureLineEdit,
};

export const cmUndo: Command = (view) => {
	if (view.state.readOnly) return false;
	const fallback = view.state.facet(historyFallbackFacet);
	if (fallback) return fallback.undo();
	return undoDepth(view.state) > 0 ? undo(view) : false;
};

export const cmRedo: Command = (view) => {
	if (view.state.readOnly) return false;
	const fallback = view.state.facet(historyFallbackFacet);
	if (fallback) return fallback.redo();
	return redoDepth(view.state) > 0 ? redo(view) : false;
};

/** Opens CodeMirror's search panel docked cleanly at the top of the Markdown page (matching VS Code & Obsidian). */
export const cmSearchTop: Extension = search({ top: true });

/** Applies an Obsidian inline marker toggle (`**`, `*`, `~~`, `` ` ``, `==`) to every selection range, deduplicating overlapping spans. */
function toggleWrapCommand(marker: string): Command {
	return (view) => {
		if (view.state.readOnly) return false;
		const doc = view.state.doc.toString();
		const applied: { from: number; to: number; insert: string; prevDelta: number }[] = [];
		const rawRanges: ({ kind: "direct"; from: number; to: number } | { kind: "mapped"; from: number; to: number })[] = [];
		let delta = 0;
		for (const range of view.state.selection.ranges) {
			const res = toggleInlineWrap(doc, range.from, range.to, marker);
			const prev = applied[applied.length - 1];
			if (prev && res.changeFrom === prev.from && res.changeTo === prev.to) {
				rawRanges.push({ kind: "direct", from: res.selFrom + prev.prevDelta, to: res.selTo + prev.prevDelta });
				continue;
			}
			if (prev && res.changeFrom < prev.to) {
				rawRanges.push({ kind: "mapped", from: range.from, to: range.to });
				continue;
			}
			applied.push({ from: res.changeFrom, to: res.changeTo, insert: res.insert, prevDelta: delta });
			rawRanges.push({ kind: "direct", from: res.selFrom + delta, to: res.selTo + delta });
			delta += res.insert.length - (res.changeTo - res.changeFrom);
		}
		const changeSet = view.state.changes(applied.map((c) => ({ from: c.from, to: c.to, insert: c.insert })));
		const nextRanges = rawRanges.map((r) =>
			r.kind === "direct"
				? EditorSelection.range(r.from, r.to)
				: EditorSelection.range(changeSet.mapPos(r.from, 1), changeSet.mapPos(r.to, 1)),
		);
		view.dispatch({
			changes: changeSet,
			selection: EditorSelection.create(nextRanges, Math.min(view.state.selection.mainIndex, nextRanges.length - 1)),
			scrollIntoView: true,
			userEvent: "input.format",
		});
		return true;
	};
}

export const cmToggleBold: Command = toggleWrapCommand("**");
export const cmToggleItalic: Command = toggleWrapCommand("*");
export const cmToggleStrike: Command = toggleWrapCommand("~~");
export const cmToggleCode: Command = toggleWrapCommand("`");
export const cmToggleHighlight: Command = toggleWrapCommand("==");

/** Obsidian `Ctrl+K` insert Markdown link (`[text]()`, `[](url)`, or `[]()`). */
export const cmInsertLink: Command = (view) => {
	const doc = view.state.doc.toString();
	const range = view.state.selection.main;
	const res = insertLinkEdit(doc, range.from, range.to);
	view.dispatch({
		changes: { from: res.changeFrom, to: res.changeTo, insert: res.insert },
		selection: EditorSelection.range(res.selFrom, res.selTo),
		scrollIntoView: true,
		userEvent: "input.format",
	});
	return true;
};

/** Cycles/toggles task checkboxes across every selected line (`Alt+C` / `Ctrl+Alt+Enter`). */
export const cmToggleCheckbox: Command = (view) => {
	const lineNums = new Set<number>();
	for (const range of view.state.selection.ranges) {
		const startLine = view.state.doc.lineAt(range.from).number;
		const endPos = range.to > range.from && view.state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
		const endLine = view.state.doc.lineAt(endPos).number;
		for (let n = startLine; n <= endLine; n++) lineNums.add(n);
	}
	const sorted = [...lineNums].sort((a, b) => a - b);
	const changes: ChangeSpec[] = [];
	const main = view.state.selection.main;
	let mainDelta = 0;
	for (const n of sorted) {
		const line = view.state.doc.line(n);
		const next = toggleCheckboxLine(line.text);
		if (next !== line.text) {
			changes.push({ from: line.from, to: line.to, insert: next });
			if (line.from <= main.head) mainDelta += next.length - line.text.length;
		}
	}
	if (!changes.length) return true;
	const single = view.state.selection.ranges.length === 1 && main.empty;
	view.dispatch({
		changes,
		...(single ? { selection: EditorSelection.cursor(Math.max(0, main.head + mainDelta)) } : {}),
		scrollIntoView: true,
		userEvent: "input.format",
	});
	return true;
};

/** Active Markdown pipe table at the main cursor, or null if outside a table or inside a fenced code block. */
export function activeTableAtCursor(view: EditorView): { table: MarkdownTable; row: number; col: number } | null {
	const main = view.state.selection.main;
	const docText = view.state.doc.toString();
	if (fenced(docText).some(([from, to]) => main.head >= from && main.head <= to)) return null;
	const lines = docText.split("\n");
	const line = view.state.doc.lineAt(main.head);
	const lineIdx = line.number - 1;
	const table = parseMarkdownTable(lines, lineIdx);
	if (!table) return null;
	const row = docLineToTableRow(table, lineIdx);
	const col = locateTableCell(line.text, main.head - line.from, table.alignments.length, table.prefix);
	return { table, row, col };
}

function dispatchTableEdit(view: EditorView, edit: TableEdit | null, prefix: string): boolean {
	if (!edit) return false;
	const from = view.state.doc.line(edit.startLine + 1).from;
	const to = view.state.doc.line(edit.endLine + 1).to;
	const rel = focusRangeInTableEdit(edit, prefix);
	view.dispatch({
		changes: { from, to, insert: edit.text },
		selection: EditorSelection.range(from + rel.from, from + rel.to),
		scrollIntoView: true,
		userEvent: "input.table",
	});
	return true;
}

/** Inserts the next sequential `[^N]` footnote reference at cursor and appends its `[^N]: ` definition at the bottom. */
export const cmInsertFootnote: Command = (view) => {
	const docText = view.state.doc.toString();
	let maxNum = 0;
	for (const m of docText.matchAll(/\[\^(\d+)\]/g)) {
		const n = Number(m[1]);
		if (Number.isFinite(n) && n > maxNum) maxNum = n;
	}
	const nextNum = maxNum + 1;
	const ref = `[^${nextNum}]`;
	const main = view.state.selection.main;
	const docLen = view.state.doc.length;
	const sep = docText.endsWith("\n\n") ? "" : docText.endsWith("\n") ? "\n" : "\n\n";
	const def = `${sep}${ref}: `;
	const defCursor = docLen + ref.length - (main.to - main.from) + def.length;
	view.dispatch({
		changes: [
			{ from: main.from, to: main.to, insert: ref },
			{ from: docLen, to: docLen, insert: def },
		],
		selection: EditorSelection.cursor(defCursor),
		scrollIntoView: true,
		userEvent: "input.footnote",
	});
	return true;
};

/** Inserts a new 3×2 formatted GFM table at the cursor and focuses the first header cell in place. */
export const cmInsertTable: Command = (view) => {
	const main = view.state.selection.main;
	const line = view.state.doc.lineAt(main.head);
	const lead = line.text.trim() ? "\n\n" : "";
	const { text, cursorOffset } = createEmptyTable(3, 2);
	const insert = `${lead}${text}\n`;
	const start = lead ? line.to : main.from;
	const end = lead ? line.to : main.to;
	const selFrom = start + lead.length + cursorOffset;
	view.dispatch({
		changes: { from: start, to: end, insert },
		selection: EditorSelection.range(selFrom, selFrom + "Column 1".length),
		scrollIntoView: true,
		userEvent: "input.table",
	});
	if (!focusLiveWidgetAt(view, selFrom, { select: true })) {
		requestAnimationFrame(() => focusLiveWidgetAt(view, selFrom, { select: true }));
	}
	return true;
};

/** Runs an Advanced Tables operation by action id on the table at the cursor. */
export function runTableAction(view: EditorView, action: string): boolean {
	if (action === "md-table-insert") return cmInsertTable(view);
	const ctx = activeTableAtCursor(view);
	if (!ctx) return false;
	const { table, row, col } = ctx;
	switch (action) {
		case "md-table-format":
			return dispatchTableEdit(view, formatTable(table, row, col), table.prefix);
		case "md-table-row-above":
			return dispatchTableEdit(view, insertTableRow(table, row, "above"), table.prefix);
		case "md-table-row-below":
			return dispatchTableEdit(view, insertTableRow(table, row, "below"), table.prefix);
		case "md-table-row-del":
			return dispatchTableEdit(view, deleteTableRow(table, row, col), table.prefix);
		case "md-table-row-up":
			return dispatchTableEdit(view, moveTableRow(table, row, col, -1), table.prefix);
		case "md-table-row-down":
			return dispatchTableEdit(view, moveTableRow(table, row, col, 1), table.prefix);
		case "md-table-col-left":
			return dispatchTableEdit(view, insertTableColumn(table, row, col, "left"), table.prefix);
		case "md-table-col-right":
			return dispatchTableEdit(view, insertTableColumn(table, row, col, "right"), table.prefix);
		case "md-table-col-del":
			return dispatchTableEdit(view, deleteTableColumn(table, row, col), table.prefix);
		case "md-table-col-move-left":
			return dispatchTableEdit(view, moveTableColumn(table, row, col, -1), table.prefix);
		case "md-table-col-move-right":
			return dispatchTableEdit(view, moveTableColumn(table, row, col, 1), table.prefix);
		case "md-table-align-left":
			return dispatchTableEdit(view, setTableAlignment(table, row, col, "left"), table.prefix);
		case "md-table-align-center":
			return dispatchTableEdit(view, setTableAlignment(table, row, col, "center"), table.prefix);
		case "md-table-align-right":
			return dispatchTableEdit(view, setTableAlignment(table, row, col, "right"), table.prefix);
		case "md-table-sort-asc":
			return dispatchTableEdit(view, sortTableByColumn(table, row, col, "asc"), table.prefix);
		case "md-table-sort-desc":
			return dispatchTableEdit(view, sortTableByColumn(table, row, col, "desc"), table.prefix);
		default:
			return false;
	}
}

/** `Shift+Enter` inside a Markdown table inserts a clean `<br>` line break inside the cell. */
const cmTableShiftEnter: Command = (view) => {
	if (view.state.selection.ranges.length !== 1) return false;
	const ctx = activeTableAtCursor(view);
	if (!ctx || ctx.row < 0) return false;
	const r = view.state.selection.main;
	view.dispatch({
		changes: { from: r.from, to: r.to, insert: "<br>" },
		selection: EditorSelection.cursor(r.from + 4),
		scrollIntoView: true,
		userEvent: "input.table",
	});
	return true;
};

/** Smart Enter on tables, lists, and callouts/blockquotes. */
export const cmSmartEnter: Command = (view) => {
	if (view.state.selection.ranges.length !== 1) return false;
	const range = view.state.selection.main;
	// 1. Inside a Markdown pipe table -> format and move to same column in next row (auto-adding row at end).
	const tbl = activeTableAtCursor(view);
	if (tbl) {
		const rawBlock = view.state.field(rawEditBlockField, false);
		const done = dispatchTableEdit(view, enterTableRow(tbl.table, tbl.row, tbl.col), tbl.table.prefix);
		if (done && !rawBlock) {
			const head = view.state.selection.main.head;
			if (!focusLiveWidgetAt(view, head, { select: true })) {
				requestAnimationFrame(() => focusLiveWidgetAt(view, head, { select: true }));
			}
		}
		return done;
	}

	if (!range.empty) return false;
	const line = view.state.doc.lineAt(range.head);
	const col = range.head - line.from;
	// Never continue Markdown lists/blockquotes inside fenced code blocks.
	if (fenced(view.state.doc.toString()).some(([from, to]) => range.head >= from && range.head <= to)) return false;

	// 2. List items (`- `, `1. `, `- [ ] `, including inside quotes `> - `).
	const isCalloutHeader = Boolean(parseCalloutHeader(line.text));
	const next = listEnter(line.text, col) ?? blockquoteEnter(line.text, col);
	if (!next) return false;
	if ("start" in next) {
		const gap = /^[ \t]*/.exec(line.text.slice(col))![0].length;
		const insert = `\n${next.start}`;
		const newHead = range.head + insert.length;
		const rawBlock = view.state.field(rawEditBlockField, false);
		view.dispatch({
			changes: { from: range.head, to: range.head + gap, insert },
			selection: EditorSelection.cursor(newHead),
			scrollIntoView: true,
			userEvent: "input.enter",
		});
		if (isCalloutHeader && !rawBlock) {
			if (!focusLiveWidgetAt(view, newHead, { suppressEnter: true })) {
				queueMicrotask(() => focusLiveWidgetAt(view, newHead, { suppressEnter: true }));
			}
		}
		return true;
	}
	// Empty list / blockquote line: terminate block cleanly.
	const keepEnd = line.from + next.keep;
	view.dispatch({
		changes: { from: keepEnd, to: line.to, insert: "" },
		selection: EditorSelection.cursor(keepEnd),
		scrollIntoView: true,
		userEvent: "input.enter",
	});
	return true;
};

/** Smart Tab / Shift-Tab: navigates & auto-formats Markdown tables first, then list lines, then standard indent. */
function smartTab(direction: "indent" | "outdent"): Command {
	return (view) => {
		if (view.state.selection.ranges.length === 1) {
			const tbl = activeTableAtCursor(view);
			if (tbl) return dispatchTableEdit(view, stepTableCell(tbl.table, tbl.row, tbl.col, direction === "indent" ? 1 : -1), tbl.table.prefix);
		}
		const docText = view.state.doc.toString();
		const fences = fenced(docText);
		const lineNums = new Set<number>();
		for (const range of view.state.selection.ranges) {
			const startLine = view.state.doc.lineAt(range.from).number;
			const endPos = range.to > range.from && view.state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
			const endLine = view.state.doc.lineAt(endPos).number;
			for (let n = startLine; n <= endLine; n++) lineNums.add(n);
		}
		const sorted = [...lineNums].sort((a, b) => a - b);
		const edits: { lineFrom: number; lineTo: number; text: string; delta: number }[] = [];
		let anyList = false;
		for (const n of sorted) {
			const line = view.state.doc.line(n);
			if (fences.some(([from, to]) => line.from >= from && line.from < to)) continue;
			const res = smartListIndent(line.text, direction);
			if (res) {
				anyList = true;
				if (res.text !== line.text) edits.push({ lineFrom: line.from, lineTo: line.to, text: res.text, delta: res.delta });
			}
		}
		if (!anyList) return direction === "indent" ? indentMore(view) : indentLess(view);
		if (!edits.length) return true;
		const main = view.state.selection.main;
		const changes: ChangeSpec[] = edits.map((e) => ({ from: e.lineFrom, to: e.lineTo, insert: e.text }));
		const single = view.state.selection.ranges.length === 1 && main.empty;
		const mainDelta = edits.filter((e) => e.lineFrom <= main.head).reduce((sum, e) => sum + e.delta, 0);
		view.dispatch({
			changes,
			...(single ? { selection: EditorSelection.cursor(Math.max(0, main.head + mainDelta)) } : {}),
			scrollIntoView: true,
			userEvent: "input.indent",
		});
		return true;
	};
}

/** Smart Backspace right after a Markdown block marker (`- `, `- [ ] `, `## `, `> `). */
export const cmSmartBackspace: Command = (view) => {
	if (view.state.selection.ranges.length !== 1) return false;
	const range = view.state.selection.main;
	if (!range.empty) return false;
	const line = view.state.doc.lineAt(range.head);
	const col = range.head - line.from;
	const cut = smartListBackspace(line.text, col);
	if (!cut) return false;
	if (fenced(view.state.doc.toString()).some(([from, to]) => range.head >= from && range.head <= to)) return false;
	view.dispatch({
		changes: { from: line.from + cut.from, to: line.from + cut.to, insert: "" },
		selection: EditorSelection.cursor(line.from + cut.from),
		scrollIntoView: true,
		userEvent: "delete.backward",
	});
	return true;
};

/** Toggle Markdown HTML comment (`<!-- ... -->`) matching VS Code `Ctrl+/` and `Shift+Alt+A`. */
export const cmToggleComment: Command = (view) => {
	const range = view.state.selection.main;
	const doc = view.state.doc;
	if (!range.empty) {
		const text = doc.sliceString(range.from, range.to);
		const trimmed = /^<!--\s?([\s\S]*?)\s?-->$/.exec(text);
		if (trimmed) {
			view.dispatch({
				changes: { from: range.from, to: range.to, insert: trimmed[1]! },
				selection: EditorSelection.range(range.from, range.from + trimmed[1]!.length),
				userEvent: "input.comment",
			});
			return true;
		}
		const wrapped = `<!-- ${text} -->`;
		view.dispatch({
			changes: { from: range.from, to: range.to, insert: wrapped },
			selection: EditorSelection.range(range.from, range.from + wrapped.length),
			userEvent: "input.comment",
		});
		return true;
	}
	const line = doc.lineAt(range.head);
	const m = /^([ \t]*)<!--\s?(.*?)\s?-->([ \t]*)$/.exec(line.text);
	if (m) {
		const unwrapped = `${m[1]}${m[2]}${m[3]}`;
		view.dispatch({
			changes: { from: line.from, to: line.to, insert: unwrapped },
			userEvent: "input.comment",
		});
		return true;
	}
	const lead = /^[ \t]*/.exec(line.text)![0];
	const body = line.text.slice(lead.length);
	const commented = `${lead}<!-- ${body} -->`;
	view.dispatch({
		changes: { from: line.from, to: line.to, insert: commented },
		userEvent: "input.comment",
	});
	return true;
};

/** Add a cursor directly above (-1) or below (+1) matching VS Code `Ctrl+Alt+Up/Down`. */
export function cmInsertCursor(view: EditorView, dir: -1 | 1): boolean {
	const doc = view.state.doc;
	const current = view.state.selection.ranges;
	const edge = dir < 0 ? current[0]! : current[current.length - 1]!;
	const line = doc.lineAt(edge.head);
	const nextNum = line.number + dir;
	if (nextNum < 1 || nextNum > doc.lines) return false;
	const col = edge.head - line.from;
	const nextLine = doc.line(nextNum);
	const pos = nextLine.from + Math.min(col, nextLine.length);
	const ranges = [...current, EditorSelection.cursor(pos)];
	view.dispatch({
		selection: EditorSelection.create(ranges, ranges.length - 1),
		scrollIntoView: true,
	});
	return true;
}

/** Expand selection (cursor -> word -> syntax node -> line -> document) matching VS Code `Shift+Alt+Right`. */
const selectionStack = new WeakMap<EditorView, EditorSelection[]>();

export const cmExpandSelection: Command = (view) => {
	const prev = view.state.selection;
	const stack = selectionStack.get(view) ?? [];
	stack.push(prev);
	selectionStack.set(view, stack.slice(-16));
	const main = prev.main;
	if (main.empty) {
		const word = view.state.wordAt(main.head);
		if (word) {
			view.dispatch({ selection: EditorSelection.range(word.from, word.to) });
			return true;
		}
	}
	if (selectParentSyntax(view)) {
		if (view.state.selection.main.from !== main.from || view.state.selection.main.to !== main.to) return true;
	}
	const line = view.state.doc.lineAt(main.from);
	const endLine = view.state.doc.lineAt(main.to);
	if (main.from > line.from || main.to < endLine.to) {
		view.dispatch({ selection: EditorSelection.range(line.from, endLine.to) });
		return true;
	}
	return selectAll(view);
};

export const cmShrinkSelection: Command = (view) => {
	const stack = selectionStack.get(view);
	const prev = stack?.pop();
	if (!prev) return false;
	view.dispatch({ selection: prev });
	return true;
};

// --- Sublime Text editing commands (pure helpers imported from markdownHtml.ts) ---

/** Sublime Text `Mod-Shift-d`: duplicate selection inline, or duplicate current line(s) below keeping cursor offset. */
export const cmDuplicateLineOrSelection: Command = (view) => {
	const doc = view.state.doc.toString();
	const spec = view.state.changeByRange((range) => {
		const edit = computeDuplicateLineOrSelection(doc, range.from, range.to);
		return {
			changes: { from: edit.changeFrom, to: edit.changeTo, insert: edit.insert },
			range: EditorSelection.range(edit.selFrom, edit.selTo),
		};
	});
	view.dispatch(spec, { scrollIntoView: true, userEvent: "input.duplicate" });
	return true;
};

/** Sublime Text `Mod-j`: join current line (or selected lines) with next line cleanly using a single space, merging overlapping multi-cursor spans. */
export const cmJoinLines: Command = (view) => {
	if (view.state.readOnly) return false;
	const doc = view.state.doc.toString();
	type JoinItem =
		| { kind: "edit"; edit: PureLineEdit; sourceIndices: number[] }
		| { kind: "noop"; from: number; to: number; sourceIndex: number };
	const items: JoinItem[] = [];

	for (let i = 0; i < view.state.selection.ranges.length; i++) {
		const range = view.state.selection.ranges[i]!;
		const edit = computeJoinLines(doc, range.from, range.to);
		if (!edit) {
			items.push({ kind: "noop", from: range.from, to: range.to, sourceIndex: i });
			continue;
		}
		const prev = items[items.length - 1];
		if (prev && prev.kind === "edit" && edit.changeFrom <= prev.edit.changeTo) {
			const mergedFrom = prev.edit.changeFrom;
			const mergedTo = Math.max(prev.edit.changeTo, edit.changeTo);
			if (mergedFrom !== prev.edit.changeFrom || mergedTo !== prev.edit.changeTo) {
				const merged = computeJoinLines(doc, mergedFrom, mergedTo);
				if (merged) prev.edit = merged;
			}
			prev.sourceIndices.push(i);
		} else {
			items.push({ kind: "edit", edit, sourceIndices: [i] });
		}
	}

	const changeSpecs: ChangeSpec[] = [];
	for (const item of items) {
		if (item.kind === "edit") {
			changeSpecs.push({ from: item.edit.changeFrom, to: item.edit.changeTo, insert: item.edit.insert });
		}
	}
	if (!changeSpecs.length) return true;

	const changeSet = view.state.changes(changeSpecs);
	const nextRanges: ReturnType<typeof EditorSelection.range>[] = [];
	let mainIndex = 0;
	let delta = 0;
	for (const item of items) {
		if (item.kind === "edit") {
			if (item.sourceIndices.includes(view.state.selection.mainIndex)) mainIndex = nextRanges.length;
			nextRanges.push(EditorSelection.range(item.edit.selFrom + delta, item.edit.selTo + delta));
			delta += item.edit.insert.length - (item.edit.changeTo - item.edit.changeFrom);
		} else {
			if (item.sourceIndex === view.state.selection.mainIndex) mainIndex = nextRanges.length;
			nextRanges.push(EditorSelection.range(changeSet.mapPos(item.from, 1), changeSet.mapPos(item.to, 1)));
		}
	}

	view.dispatch({
		changes: changeSet,
		selection: EditorSelection.create(nextRanges, Math.min(mainIndex, nextRanges.length - 1)),
		scrollIntoView: true,
		userEvent: "input.join",
	});
	return true;
};

/** Sublime Text `Mod-Enter`: insert blank line below current line without splitting text, preserving indent. */
export const cmInsertLineBelow: Command = (view) => {
	const doc = view.state.doc.toString();
	const spec = view.state.changeByRange((range) => {
		const edit = computeInsertLineBelow(doc, range.head);
		return {
			changes: { from: edit.changeFrom, to: edit.changeTo, insert: edit.insert },
			range: EditorSelection.range(edit.selFrom, edit.selTo),
		};
	});
	view.dispatch(spec, { scrollIntoView: true, userEvent: "input.enter" });
	return true;
};

/** Sublime Text `Mod-Shift-Enter`: insert blank line above current line without splitting text, preserving indent. */
export const cmInsertLineAbove: Command = (view) => {
	const doc = view.state.doc.toString();
	const spec = view.state.changeByRange((range) => {
		const edit = computeInsertLineAbove(doc, range.head);
		return {
			changes: { from: edit.changeFrom, to: edit.changeTo, insert: edit.insert },
			range: EditorSelection.range(edit.selFrom, edit.selTo),
		};
	});
	view.dispatch(spec, { scrollIntoView: true, userEvent: "input.enter" });
	return true;
};

/** Sublime Text / Monaco `Mod-l`: select full current line, expanding to the next line on repeated presses. */
export const cmSelectLine: Command = (view) => {
	const doc = view.state.doc.toString();
	const ranges = view.state.selection.ranges.map((r) => {
		const next = computeSelectLine(doc, r.from, r.to);
		return EditorSelection.range(next.from, next.to);
	});
	view.dispatch({
		selection: EditorSelection.create(ranges, view.state.selection.mainIndex),
		scrollIntoView: true,
		userEvent: "select",
	});
	return true;
};

/** Opens CodeMirror's search panel and optionally moves focus to the Replace input (skipped in Read-only mode). */
function openFind(view: EditorView, replace: boolean): boolean {
	openSearchPanel(view);
	if (replace && !view.state.readOnly) {
		queueMicrotask(() => {
			const input = view.dom.querySelector<HTMLInputElement>(".cm-search input[name='replace']");
			input?.focus();
			input?.select();
		});
	}
	return true;
}

async function cmCopy(view: EditorView, cut: boolean) {
	if (cut && view.state.readOnly) return;
	const startDoc = view.state.doc;
	const main = view.state.selection.main;
	let from = main.from;
	let to = main.to;
	let text = view.state.sliceDoc(from, to);
	if (!text) {
		const line = startDoc.lineAt(main.head);
		from = line.from;
		to = Math.min(startDoc.length, line.to + 1);
		text = `${line.text}\n`;
	}
	const copied = (await backend.clipboard(text).catch(() => false)) || (await navigator.clipboard?.writeText(text).then(() => true, () => false));
	if (!copied) return notify("Could not reach the clipboard.", "error");
	if (cut) {
		if (!view.dom.isConnected || view.state.readOnly || view.state.doc !== startDoc) return;
		view.dispatch({
			changes: { from, to, insert: "" },
			selection: EditorSelection.cursor(from),
			scrollIntoView: true,
			userEvent: "delete.cut",
		});
	}
}

/**
 * Resolves clipboard payload (`text/plain` + optional `text/html`) into smart Markdown:
 * 1. Plain-text paste (`plainOnly`) returns null so raw text inserts verbatim.
 * 2. Selected text + URL -> `[selected](url)`.
 * 3. Multi-row tabular TSV outside fenced code blocks -> GFM Markdown table.
 * 4. Rich semantic HTML outside fenced code blocks -> clean GFM Markdown.
 */
export function resolveSmartPasteText(opts: {
	plain: string;
	html?: string;
	selected: string;
	insideFence: boolean;
	beforeOnLine?: string;
	plainOnly?: boolean;
}): string | null {
	if (opts.plainOnly) return null;
	if (opts.selected) {
		const wrapped = pasteUrlOverSelection(opts.selected, opts.plain);
		if (wrapped) return wrapped;
	}
	if (!opts.insideFence) {
		const tsvTable = tsvToMarkdownTable(opts.plain);
		if (tsvTable) {
			const lead = opts.beforeOnLine?.trim() ? "\n\n" : "";
			return `${lead}${tsvTable}`;
		}
		if (opts.html && looksLikeRichHtml(opts.html)) {
			const md = htmlToMarkdown(opts.html);
			if (md && md !== opts.plain.trim()) return md;
		}
	}
	return null;
}

async function cmPaste(view: EditorView, plainOnly = false) {
	if (view.state.readOnly) return;
	let plain: string | null = null;
	let html = "";
	if (!plainOnly && typeof navigator.clipboard?.read === "function") {
		try {
			const items = await navigator.clipboard.read();
			for (const item of items) {
				if (plain === null && item.types.includes("text/plain")) {
					plain = await (await item.getType("text/plain")).text();
				}
				if (!html && item.types.includes("text/html")) {
					html = await (await item.getType("text/html")).text();
				}
			}
		} catch {
			// Fall back to readText() when rich clipboard read is denied or unsupported.
		}
	}
	if (plain === null) {
		plain = await navigator.clipboard?.readText().catch(() => null);
	}
	if (!view.dom.isConnected || view.state.readOnly) return;
	if (plain === null || plain === undefined) {
		return notify("This window was not allowed to read the clipboard. Paste with Ctrl+V.");
	}
	const main = view.state.selection.main;
	const selected = view.state.sliceDoc(main.from, main.to);
	const insideFence = fenced(view.state.doc.toString()).some(([a, b]) => main.from >= a && main.from <= b);
	const line = view.state.doc.lineAt(main.from);
	const beforeOnLine = line.text.slice(0, main.from - line.from);
	const smart = resolveSmartPasteText({ plain, html, selected, insideFence, beforeOnLine, plainOnly });
	const insert = smart ?? plain.replace(/\r\n?/g, "\n");
	view.dispatch({
		changes: { from: main.from, to: main.to, insert },
		selection: EditorSelection.cursor(main.from + insert.length),
		scrollIntoView: true,
		userEvent: "input.paste",
	});
}

/** Pastes plain text verbatim (`Ctrl+Shift+V`), bypassing URL / TSV / HTML smart conversion. */
export const cmPastePlain: Command = (view) => {
	void cmPaste(view, true);
	return true;
};

/** Auto-wrap non-empty selection when typing a Markdown delimiter (`*`, `_`, `` ` ``, `~`, `=`, `[`, `(`). */
export const cmAutoWrapExtension: Extension = EditorView.inputHandler.of((view, from, to, text) => {
	if (from >= to || text.length !== 1) return false;
	const pair = WRAP_PAIRS[text];
	if (!pair) return false;
	const selected = view.state.sliceDoc(from, to);
	const [open, close] = pair;
	view.dispatch({
		changes: { from, to, insert: `${open}${selected}${close}` },
		selection: EditorSelection.range(from + open.length, from + open.length + selected.length),
		scrollIntoView: true,
		userEvent: "input.wrap",
	});
	return true;
});

/** Extracts pasted or dropped image files from a clipboard / drag-and-drop `DataTransfer`. */
export function extractImageFiles(dt: DataTransfer | null): File[] {
	if (!dt) return [];
	const out: File[] = [];
	if (dt.items) {
		for (const item of dt.items) {
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const f = item.getAsFile();
				if (f) out.push(f);
			}
		}
	}
	if (!out.length && dt.files) {
		for (const f of dt.files) {
			if (f.type.startsWith("image/") || IMAGE_FILE_RE.test(f.name)) out.push(f);
		}
	}
	return out;
}

/**
 * Smart paste & drop:
 * 1. `Ctrl+Shift+V` pastes plain text verbatim, bypassing smart conversion.
 * 2. Pasting or dropping an image file saves it to workspace attachments and inserts `![alt](relative/path.png)`.
 * 3. Pasting an `http(s)://` URL over selected prose creates `[selected](url)`.
 * 4. Pasting multi-row TSV (Excel/Sheets) outside fenced code inserts a clean GFM table.
 * 5. Pasting rich semantic HTML outside fenced code converts it via `htmlToMarkdown`.
 */
export function cmSmartPasteExtension(filePath: () => string): Extension {
	let plainPasteUntil = 0;
	let lastPasteAt = 0;

	const saveAndInsertImages = async (view: EditorView, files: File[], pos?: number) => {
		const snippets: string[] = [];
		for (const file of files) {
			const saved = await saveImageAttachment(file, filePath());
			if (saved) snippets.push(saved.markdown);
		}
		if (!snippets.length || !view.dom.isConnected || view.state.readOnly) return;
		const docLen = view.state.doc.length;
		const at = Math.max(0, Math.min(pos ?? view.state.selection.main.from, docLen));
		const to = Math.max(at, Math.min(pos ?? view.state.selection.main.to, docLen));
		const insert = snippets.join("\n");
		view.dispatch({
			changes: { from: at, to, insert },
			selection: EditorSelection.cursor(at + insert.length),
			scrollIntoView: true,
			userEvent: "input.paste",
		});
		view.focus();
	};

	return EditorView.domEventHandlers({
		keydown(event, view) {
			if (!view.state.facet(EditorView.editable)) return false;
			if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "v") {
				const pressedAt = performance.now();
				plainPasteUntil = pressedAt + 400;
				// If the host webview does not emit a native `paste` event for Ctrl+Shift+V, fall back to clipboard readText.
				setTimeout(() => {
					if (
						lastPasteAt < pressedAt &&
						view.dom.isConnected &&
						!view.state.readOnly &&
						view.hasFocus &&
						typeof navigator.clipboard?.readText === "function"
					) {
						plainPasteUntil = 0;
						void cmPaste(view, true);
					}
				}, 45);
			}
			return false;
		},
		paste(event, view) {
			if (!view.state.facet(EditorView.editable)) return false;
			const now = performance.now();
			lastPasteAt = now;
			const plainOnly = now < plainPasteUntil;
			plainPasteUntil = 0;

			const plain = event.clipboardData?.getData("text/plain") ?? "";
			const html = event.clipboardData?.getData("text/html") ?? "";
			const main = view.state.selection.main;

			if (plainOnly) {
				const verbatim = plain.replace(/\r\n?/g, "\n");
				event.preventDefault();
				view.dispatch({
					changes: { from: main.from, to: main.to, insert: verbatim },
					selection: EditorSelection.cursor(main.from + verbatim.length),
					scrollIntoView: true,
					userEvent: "input.paste",
				});
				return true;
			}

			// Save pasted image files (ignoring Excel/Calc bitmap previews that accompany TSV clipboard data).
			const images = extractImageFiles(event.clipboardData);
			if (images.length && !tsvToMarkdownTable(plain)) {
				event.preventDefault();
				void saveAndInsertImages(view, images);
				return true;
			}

			if (view.state.selection.ranges.length !== 1) return false;
			const selected = view.state.sliceDoc(main.from, main.to);
			const insideFence = fenced(view.state.doc.toString()).some(([a, b]) => main.from >= a && main.from <= b);
			const line = view.state.doc.lineAt(main.from);
			const beforeOnLine = line.text.slice(0, main.from - line.from);
			const smart = resolveSmartPasteText({ plain, html, selected, insideFence, beforeOnLine });
			if (smart === null) return false;
			event.preventDefault();
			view.dispatch({
				changes: { from: main.from, to: main.to, insert: smart },
				selection: EditorSelection.cursor(main.from + smart.length),
				scrollIntoView: true,
				userEvent: "input.paste",
			});
			return true;
		},
		dragover(event, view) {
			if (!view.state.facet(EditorView.editable)) return false;
			const dt = event.dataTransfer;
			if (!dt) return false;
			// Files from outside, a file's row, a tab: each leaves a link here and stays where it is, which is a copy.
			// The table that says so is the one the rows and the tabs take what they allow from (`DRAG_PAIRS`).
			const effect = dropEffectFor("markdown-editor", dt.types);
			if (effect === "none") return false;
			event.preventDefault();
			dt.dropEffect = effect;
			return true;
		},
		drop(event, view) {
			if (!view.state.facet(EditorView.editable)) return false;
			const dt = event.dataTransfer;
			if (!dt) return false;
			const dropPos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
			const droppedPath = dt.getData(DRAG_TYPE["explorer-row"]) || dt.getData(DRAG_TYPE.tab);
			if (droppedPath) {
				event.preventDefault();
				const curPath = filePath();
				const relRaw = curPath ? relativePath(dirName(curPath), droppedPath) : baseName(droppedPath);
				const rel = linkWritten(relRaw.replace(/\\/g, "/"), relRaw.replace(/\\/g, "/"));
				const name = baseName(droppedPath);
				const stem = name.replace(/\.[^.]+$/, "");
				let snippet: string;
				if (IMAGE_FILE_RE.test(name)) {
					snippet = `![${stem}](${rel})`;
				} else if (/\.(md|markdown)$/i.test(name)) {
					const root = appState.workspace?.root;
					const all = docs();
					const droppedDoc = all.find((d) => d.exists && canonical(d.path) === canonical(droppedPath));
					const wikiName = (droppedDoc ? nameFor(droppedDoc, all, root) : null) ?? stem;
					snippet = event.shiftKey ? `[${stem}](${rel})` : event.altKey ? `![[${wikiName}]]` : `[[${wikiName}]]`;
				} else {
					snippet = event.altKey ? `![[${relRaw.replace(/\\/g, "/")}]]` : `[${name}](${rel})`;
				}
				const at = Math.max(0, Math.min(dropPos, view.state.doc.length));
				view.dispatch({
					changes: { from: at, to: at, insert: snippet },
					selection: EditorSelection.cursor(at + snippet.length),
					scrollIntoView: true,
					userEvent: "input.drop",
				});
				view.focus();
				return true;
			}
			const images = extractImageFiles(dt);
			if (!images.length) return false;
			event.preventDefault();
			void saveAndInsertImages(view, images, dropPos);
			return true;
		},
	});
}

/**
 * Keyboard parity for CM6 Live Preview widgets (Wave 2.4): when pressing ArrowDown or ArrowUp
 * across the boundary into an adjacent interactive TableWidget or CalloutWidget, focus that widget directly.
 */
function cmStepIntoLiveWidget(dir: 1 | -1): Command {
	return (view) => {
		if (view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
		if (completionStatus(view.state) === "active") return false;
		if (view.state.field(rawEditBlockField, false)) return false;
		const main = view.state.selection.main;
		if (!main.empty) return false;
		const doc = view.state.doc;
		const curLine = doc.lineAt(main.head);
		if (dir === 1) {
			if (curLine.number >= doc.lines) return false;
			// Only cross into the next line's widget if ArrowDown would actually leave this line (handles wrapped paragraphs).
			const moved = view.moveVertically(main, true);
			if (curLine.length > 0 && moved.head <= curLine.to) return false;
			const nextLine = doc.line(curLine.number + 1);
			return focusLiveWidgetAt(view, nextLine.from);
		}
		if (curLine.number <= 1) return false;
		const moved = view.moveVertically(main, false);
		if (curLine.length > 0 && moved.head >= curLine.from) return false;
		const prevLine = doc.line(curLine.number - 1);
		return focusLiveWidgetAt(view, prevLine.to);
	};
}

const markdownBindings: KeyBinding[] = [
	// Obsidian text formatting (takes precedence over conflicting window chrome shortcuts inside Markdown).
	{ key: "Mod-b", run: cmToggleBold, preventDefault: true },
	{ key: "Mod-i", run: cmToggleItalic, preventDefault: true },
	{ key: "Mod-Shift-x", run: cmToggleStrike, preventDefault: true },
	{ key: "Mod-`", run: cmToggleCode, preventDefault: true },
	{ key: "Mod-Alt-h", run: cmToggleHighlight, preventDefault: true },
	{ key: "Mod-k", run: cmInsertLink, preventDefault: true },
	{ key: "Mod-Alt-Enter", run: cmToggleCheckbox, preventDefault: true },
	{ key: "Alt-c", run: cmToggleCheckbox, preventDefault: true },
	// Sublime Text editing ergonomics (ADR 0032).
	{ key: "Mod-Shift-d", run: cmDuplicateLineOrSelection, preventDefault: true },
	{ key: "Mod-j", run: cmJoinLines, preventDefault: true },
	{ key: "Mod-Enter", run: cmInsertLineBelow, preventDefault: true },
	{ key: "Mod-Shift-Enter", run: cmInsertLineAbove, preventDefault: true },
	{ key: "Mod-l", run: cmSelectLine, preventDefault: true },
	// Live Table & Callout keyboard entry on vertical boundary navigation.
	{ key: "ArrowDown", run: cmStepIntoLiveWidget(1) },
	{ key: "ArrowUp", run: cmStepIntoLiveWidget(-1) },
	// Smart Markdown tables, lists, callouts & block markers.
	{ key: "Shift-Enter", run: cmTableShiftEnter },
	{ key: "Enter", run: cmSmartEnter },
	{ key: "Tab", run: smartTab("indent") },
	{ key: "Shift-Tab", run: smartTab("outdent") },
	{ key: "Backspace", run: cmSmartBackspace },
	// VS Code / Monaco unified editing shortcuts.
	{ key: "Mod-z", run: cmUndo, preventDefault: true },
	{ key: "Mod-y", run: cmRedo, preventDefault: true },
	{ key: "Mod-Shift-z", run: cmRedo, preventDefault: true },
	{ key: "Mod-f", run: (v) => openFind(v, false), preventDefault: true },
	{ key: "Mod-h", run: (v) => openFind(v, true), preventDefault: true },
	{ key: "Mod-g", run: gotoLine, preventDefault: true },
	{ key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
	{ key: "Mod-Shift-l", run: selectSelectionMatches, preventDefault: true },
	{ key: "Mod-/", run: cmToggleComment, preventDefault: true },
	{ key: "Shift-Alt-a", run: cmToggleComment, preventDefault: true },
	{ key: "Alt-ArrowUp", run: moveLineUp, preventDefault: true },
	{ key: "Alt-ArrowDown", run: moveLineDown, preventDefault: true },
	{ key: "Shift-Alt-ArrowUp", run: copyLineUp, preventDefault: true },
	{ key: "Shift-Alt-ArrowDown", run: copyLineDown, preventDefault: true },
	{ key: "Ctrl-Alt-ArrowUp", run: (v) => cmInsertCursor(v, -1), preventDefault: true },
	{ key: "Ctrl-Alt-ArrowDown", run: (v) => cmInsertCursor(v, 1), preventDefault: true },
	{ key: "Mod-Shift-k", run: deleteLine, preventDefault: true },
	{ key: "Shift-Alt-ArrowRight", run: cmExpandSelection, preventDefault: true },
	{ key: "Shift-Alt-ArrowLeft", run: cmShrinkSelection, preventDefault: true },
	{ key: "Mod-Shift-\\", run: selectMatchingBracket, preventDefault: true },
];

const selectionHistoryKeymap = historyKeymap.filter((b) => b.run !== undo && b.run !== redo);

/** Complete keymap extension combining Obsidian Markdown commands + VS Code parity + CodeMirror defaults. */
export const cmMarkdownKeymap: Extension = [
	Prec.high(keymap.of(markdownBindings)),
	keymap.of([...searchKeymap, ...selectionHistoryKeymap, ...foldKeymap, ...defaultKeymap]),
];

/**
 * Unified action dispatcher: runs any Monaco menu/command action id or Markdown
 * formatting action id on a live CodeMirror 6 view, keeping File/Edit/Selection/Go
 * menus and the command palette 100% consistent across engines.
 */
export function runCmAction(view: EditorView, id: string): boolean {
	view.focus();
	switch (id) {
		case "undo":
			return cmUndo(view);
		case "redo":
			return cmRedo(view);
		case "editor.action.clipboardCutAction":
			void cmCopy(view, true);
			return true;
		case "editor.action.clipboardCopyAction":
			void cmCopy(view, false);
			return true;
		case "editor.action.clipboardPasteAction":
			void cmPaste(view);
			return true;
		case "editor.action.pasteAsPlainText":
		case "md-paste-plain":
			return cmPastePlain(view);
		case "editor.foldAll":
			return foldAll(view);
		case "editor.unfoldAll":
			return unfoldAll(view);
		case "actions.find":
			return openFind(view, false);
		case "editor.action.startFindReplaceAction":
			return openFind(view, true);
		case "editor.action.commentLine":
		case "editor.action.blockComment":
			return cmToggleComment(view);
		case "editor.action.selectAll":
			return selectAll(view);
		case "editor.action.smartSelect.expand":
			return cmExpandSelection(view);
		case "editor.action.smartSelect.shrink":
			return cmShrinkSelection(view);
		case "editor.action.copyLinesUpAction":
			return copyLineUp(view);
		case "editor.action.copyLinesDownAction":
			return copyLineDown(view);
		case "editor.action.moveLinesUpAction":
			return moveLineUp(view);
		case "editor.action.moveLinesDownAction":
			return moveLineDown(view);
		case "editor.action.insertCursorAbove":
			return cmInsertCursor(view, -1);
		case "editor.action.insertCursorBelow":
			return cmInsertCursor(view, 1);
		case "editor.action.addSelectionToNextFindMatch":
			return selectNextOccurrence(view);
		case "editor.action.selectHighlights":
			return selectSelectionMatches(view);
		case "editor.action.duplicateSelection":
		case "md-duplicate-line":
			return cmDuplicateLineOrSelection(view);
		case "editor.action.joinLines":
		case "md-join-lines":
			return cmJoinLines(view);
		case "editor.action.insertLineAfter":
		case "md-insert-line-below":
			return cmInsertLineBelow(view);
		case "editor.action.insertLineBefore":
		case "md-insert-line-above":
			return cmInsertLineAbove(view);
		case "expandLineSelection":
		case "editor.action.selectLine":
		case "md-select-line":
			return cmSelectLine(view);
		case "editor.action.gotoLine":
			return gotoLine(view);
		case "editor.action.quickOutline":
			showPanel("objects");
			return true;
		case "editor.action.jumpToBracket":
			return selectMatchingBracket(view);
		case "md-bold":
			return cmToggleBold(view);
		case "md-italic":
			return cmToggleItalic(view);
		case "md-strike":
			return cmToggleStrike(view);
		case "md-code":
			return cmToggleCode(view);
		case "md-highlight":
			return cmToggleHighlight(view);
		case "md-link":
			return cmInsertLink(view);
		case "md-checkbox":
			return cmToggleCheckbox(view);
		case "md-insert-footnote":
			return cmInsertFootnote(view);
		default:
			if (id.startsWith("md-table-")) return runTableAction(view, id);
			return false;
	}
}
