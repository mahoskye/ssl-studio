// Obsidian-grade Markdown keymap + full VS Code / Monaco command & menu parity
// for CodeMirror 6 Live Preview (ADR 0028).
// Every edit mutates the underlying plain Markdown text directly (ADR 0002).
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
import { foldKeymap } from "@codemirror/language";
import { gotoLine, openSearchPanel, search, searchKeymap, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { EditorSelection, Prec, type ChangeSpec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type Command, type KeyBinding } from "@codemirror/view";
import { fenced } from "../../shared/catalog";
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
import { showPanel } from "../panels/registry";
import { notify } from "../state";
import { focusLiveWidgetAt, historyFallbackFacet, rawEditBlockField, type HistoryFallback } from "./cmLiveShared";
import { IMAGE_FILE_RE, saveImageAttachment } from "./imageResolve";

export { historyFallbackFacet, type HistoryFallback };

export const cmUndo: Command = (view) => {
	if (undoDepth(view.state) > 0) return undo(view);
	return view.state.facet(historyFallbackFacet)?.undo() ?? false;
};

export const cmRedo: Command = (view) => {
	if (redoDepth(view.state) > 0) return redo(view);
	return view.state.facet(historyFallbackFacet)?.redo() ?? false;
};

/** Opens CodeMirror's search panel docked cleanly at the top of the Markdown page (matching VS Code & Obsidian). */
export const cmSearchTop: Extension = search({ top: true });

/** Applies an Obsidian inline marker toggle (`**`, `*`, `~~`, `` ` ``, `==`) to every selection range. */
function toggleWrapCommand(marker: string): Command {
	return (view) => {
		const doc = view.state.doc.toString();
		const changes: ChangeSpec[] = [];
		const ranges: { from: number; to: number }[] = [];
		let delta = 0;
		for (const range of view.state.selection.ranges) {
			const res = toggleInlineWrap(doc, range.from, range.to, marker);
			changes.push({ from: res.changeFrom, to: res.changeTo, insert: res.insert });
			ranges.push({ from: res.selFrom + delta, to: res.selTo + delta });
			delta += res.insert.length - (res.changeTo - res.changeFrom);
		}
		view.dispatch({
			changes,
			selection: EditorSelection.create(ranges.map((r) => EditorSelection.range(r.from, r.to)), view.state.selection.mainIndex),
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

/** Obsidian `Ctrl+L` cycle/toggle task checkbox across every selected line. */
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

/** Opens CodeMirror's search panel and optionally moves focus to the Replace input. */
function openFind(view: EditorView, replace: boolean): boolean {
	openSearchPanel(view);
	if (replace) {
		queueMicrotask(() => {
			const input = view.dom.querySelector<HTMLInputElement>(".cm-search input[name='replace']");
			input?.focus();
			input?.select();
		});
	}
	return true;
}

async function cmCopy(view: EditorView, cut: boolean) {
	const main = view.state.selection.main;
	let from = main.from;
	let to = main.to;
	let text = view.state.sliceDoc(from, to);
	if (!text) {
		const line = view.state.doc.lineAt(main.head);
		from = line.from;
		to = Math.min(view.state.doc.length, line.to + 1);
		text = `${line.text}\n`;
	}
	const copied = (await backend.clipboard(text).catch(() => false)) || (await navigator.clipboard?.writeText(text).then(() => true, () => false));
	if (!copied) return notify("Could not reach the clipboard.", "error");
	if (cut) {
		view.dispatch({
			changes: { from, to, insert: "" },
			selection: EditorSelection.cursor(from),
			scrollIntoView: true,
			userEvent: "delete.cut",
		});
	}
}

async function cmPaste(view: EditorView) {
	const text = await navigator.clipboard?.readText().catch(() => null);
	if (text === null || text === undefined) {
		return notify("This window was not allowed to read the clipboard. Paste with Ctrl+V.");
	}
	const main = view.state.selection.main;
	const selected = view.state.sliceDoc(main.from, main.to);
	const smart = pasteUrlOverSelection(selected, text);
	const insert = smart ?? text;
	view.dispatch({
		changes: { from: main.from, to: main.to, insert },
		selection: EditorSelection.cursor(main.from + insert.length),
		scrollIntoView: true,
		userEvent: "input.paste",
	});
}

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

/**
 * Smart paste & drop:
 * 1. Pasting or dropping an image file saves it to workspace attachments and inserts `![alt](relative/path.png)`.
 * 2. Pasting an `http(s)://` URL over selected prose creates `[selected](url)`.
 */
export function cmSmartPasteExtension(filePath: () => string): Extension {
	const extractImageFiles = (dt: DataTransfer | null): File[] => {
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
	};

	const saveAndInsertImages = async (view: EditorView, files: File[], pos?: number) => {
		const snippets: string[] = [];
		for (const file of files) {
			const saved = await saveImageAttachment(file, filePath());
			if (saved) snippets.push(saved.markdown);
		}
		if (!snippets.length) return;
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
		paste(event, view) {
			if (!view.state.facet(EditorView.editable)) return false;
			const images = extractImageFiles(event.clipboardData);
			if (images.length) {
				event.preventDefault();
				void saveAndInsertImages(view, images);
				return true;
			}
			const main = view.state.selection.main;
			if (main.empty || view.state.selection.ranges.length !== 1) return false;
			const pasted = event.clipboardData?.getData("text/plain") ?? "";
			const selected = view.state.sliceDoc(main.from, main.to);
			const wrapped = pasteUrlOverSelection(selected, pasted);
			if (!wrapped) return false;
			event.preventDefault();
			view.dispatch({
				changes: { from: main.from, to: main.to, insert: wrapped },
				selection: EditorSelection.cursor(main.from + wrapped.length),
				scrollIntoView: true,
				userEvent: "input.paste",
			});
			return true;
		},
		dragover(event, view) {
			if (!view.state.facet(EditorView.editable)) return false;
			const dt = event.dataTransfer;
			if (!dt) return false;
			const hasFile = Array.from(dt.types).includes("Files");
			if (!hasFile) return false;
			event.preventDefault();
			dt.dropEffect = "copy";
			return true;
		},
		drop(event, view) {
			if (!view.state.facet(EditorView.editable)) return false;
			const images = extractImageFiles(event.dataTransfer);
			if (!images.length) return false;
			event.preventDefault();
			const dropPos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
			void saveAndInsertImages(view, images, dropPos);
			return true;
		},
	});
}

const markdownBindings: KeyBinding[] = [
	// Obsidian text formatting (takes precedence over conflicting window chrome shortcuts inside Markdown).
	{ key: "Mod-b", run: cmToggleBold, preventDefault: true },
	{ key: "Mod-i", run: cmToggleItalic, preventDefault: true },
	{ key: "Mod-Shift-x", run: cmToggleStrike, preventDefault: true },
	{ key: "Mod-`", run: cmToggleCode, preventDefault: true },
	{ key: "Mod-Alt-h", run: cmToggleHighlight, preventDefault: true },
	{ key: "Mod-k", run: cmInsertLink, preventDefault: true },
	{ key: "Mod-l", run: cmToggleCheckbox, preventDefault: true },
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

/** Complete keymap extension combining Obsidian Markdown commands + VS Code parity + CodeMirror defaults. */
export const cmMarkdownKeymap: Extension = [
	Prec.high(keymap.of(markdownBindings)),
	keymap.of([...searchKeymap, ...historyKeymap, ...foldKeymap, ...defaultKeymap]),
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
		default:
			if (id.startsWith("md-table-")) return runTableAction(view, id);
			return false;
	}
}
