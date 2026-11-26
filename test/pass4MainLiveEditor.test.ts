// Two medium findings of the pass 4 audit in the live Markdown editor that were on main before the branch:
//
// P2. What is done in the editor stays out of the front matter while it is hidden (Move Line Up on the first line
//     of the body swapped it with the closing `---`).
// P3. An edit of one cell of a live table changes that cell's text and nothing else, and no action on a table
//     drops the cells a row has beyond the header's columns.
//
// Bun has no DOM. The front matter's guard is a transaction filter, so it is asked here as the editor asks it: a
// state built with the editor's own field and filter, and CodeMirror's and the editor's own commands run on it.
// A table's widget cannot be drawn: what its cell editor writes is a pure function, run here on its own and
// through the widget the editor's field builds; that the widget calls it is read from the source.
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	copyLineDown,
	copyLineUp,
	deleteCharBackward,
	deleteLine,
	history,
	indentLess,
	indentMore,
	moveLineDown,
	moveLineUp,
	redo,
	transposeChars,
	undo,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { openSearchPanel, search, SearchQuery, selectNextOccurrence, selectSelectionMatches, setSearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// --- The same headless window and Monaco stand-ins as pass4LowsLiveEditor.test.ts, so the view's modules load under bun ---
const storage = new Map<string, string>();
if (typeof (globalThis as any).localStorage === "undefined") {
	(globalThis as any).localStorage = {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, String(v)),
		removeItem: (k: string) => void storage.delete(k),
		clear: () => storage.clear(),
	};
}
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		innerWidth: 1280,
		innerHeight: 900,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
} else {
	if (!(globalThis as any).window.Error) (globalThis as any).window.Error = Error;
	if (!(globalThis as any).window.Map) (globalThis as any).window.Map = Map;
	if (!(globalThis as any).window.Set) (globalThis as any).window.Set = Set;
}
if (typeof (globalThis as any).document === "undefined") {
	(globalThis as any).document = {
		documentElement: { dataset: {}, style: {} },
		head: { appendChild() {} },
		body: { style: {} },
		activeElement: null,
		getElementById: () => null,
		createElement: () => ({ style: {}, getContext: () => null }),
		querySelector: () => null,
		addEventListener() {},
		removeEventListener() {},
	};
} else {
	if (!(globalThis as any).document.body) (globalThis as any).document.body = { style: {} };
	else if (!(globalThis as any).document.body.style) (globalThis as any).document.body.style = {};
	if (!(globalThis as any).document.addEventListener) (globalThis as any).document.addEventListener = () => {};
	if (!(globalThis as any).document.removeEventListener) (globalThis as any).document.removeEventListener = () => {};
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

const makeUri = (scheme: string, fsPath: string) => {
	const normalized = fsPath.replace(/\\/g, "/");
	const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
	return { scheme, fsPath, path: normalized, toString: () => raw };
};

mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({
	default: class {},
}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
for (const lang of ["markdown", "sql", "yaml", "xml", "ini", "shell", "powershell", "bat", "javascript", "typescript", "html", "css", "scss", "less", "csharp", "vb", "razor", "pgsql", "mysql", "python", "java", "cpp", "php", "dockerfile", "graphql", "r", "perl", "ruby", "go", "rust", "fsharp"]) {
	mock.module(`monaco-editor/languages/definitions/${lang}/register`, () => ({}));
}

const noopProxy = (base: Record<string, any> = {}): any =>
	new Proxy(base, {
		get(target, prop) {
			if (prop in target) return target[prop as any];
			return () => ({ dispose() {} });
		},
	});

mock.module("monaco-editor/editor/editor.api", () => ({
	Range: class {
		constructor(
			public startLineNumber: number,
			public startColumn: number,
			public endLineNumber: number,
			public endColumn: number,
		) {}
	},
	Emitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	Uri: {
		from: () => ({}),
		file: (p: string) => makeUri("file", p),
		parse: (raw: string) => {
			if (raw.startsWith("file://")) return makeUri("file", raw.slice("file://".length));
			if (raw.startsWith("untitled:")) return makeUri("untitled", raw.slice("untitled:".length));
			return makeUri("file", raw);
		},
	},
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { KeyF: 36, KeyZ: 56, KeyY: 55 },
	languages: noopProxy({
		CompletionItemKind: { File: 1, Keyword: 2, Text: 3, Snippet: 4, Field: 5, Struct: 6 },
		SymbolKind: { Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Function: 11, Variable: 12, Constant: 13, String: 14, Object: 18, Key: 19, Struct: 22 },
		FoldingRangeKind: { Comment: "comment", Imports: "imports", Region: "region" },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
	}),
	editor: noopProxy({
		EndOfLineSequence: { LF: 0, CRLF: 1 },
		ScrollType: { Immediate: 1 },
		getEditors: () => [],
		getModels: () => [],
		getModel: () => null,
		createModel: () => null,
		onDidCreateModel: () => ({ dispose() {} }),
		setModelMarkers() {},
		getModelMarkers: () => [],
		registerEditorOpener: () => ({ dispose() {} }),
	}),
}));

// The view finds its backend from the page's address (as r4aMarkdownCm6.test.ts gives it one).
if (typeof (globalThis as any).location === "undefined") {
	(globalThis as any).location = (globalThis as any).window.location ?? { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" };
}

const { liveBlockField, liveCallbacksFacet, liveInteractionExtension } = await import("../src/view/editor/cmLivePlugin");
const { cmDuplicateLineOrSelection, cmInsertCursor, cmInsertLineAbove, cmJoinLines, cmToggleComment, runTableAction } = await import("../src/view/editor/cmKeymap");
const { extraCellsNote, mergeTsvIntoTable } = await import("../src/view/editor/cmLiveTable");
const { frontMatter } = await import("../src/shared/frontMatter");
const {
	cellValueForEdit,
	deleteTableColumn,
	deleteTableRow,
	enterTableRow,
	formatTable,
	insertTableColumn,
	insertTableRow,
	moveTableColumn,
	moveTableRow,
	parseTableRaw,
	serializeTableCell,
	setTableAlignment,
	sortTableByColumn,
	splitTableRow,
	stepTableCell,
	tableCellTextEdit,
	updateTableCell,
} = await import("../src/shared/markdownTables");
type MarkdownTable = NonNullable<ReturnType<typeof parseTableRaw>>;

const source = (rel: string) => readFileSync(resolve(import.meta.dir, "..", rel), "utf8");

// --- P2. The hidden front matter -----------------------------------------------------------------------------

const FM = "---\ntitle: Sample note\nstatus: open\n---";
const BODY = "Remember: call the lab\nSecond line\nThird line\n";
const DOC = `${FM}\n${BODY}`;
/** Where the body starts: after the block and its line break. */
const B = FM.length + 1;

/** A document in the live editor: the editor's own block field and its own filter, several cursors allowed as there. */
const liveState = (doc: string, selection: EditorSelection | number, extra: Extension[] = []) =>
	EditorState.create({
		doc,
		selection: typeof selection === "number" ? EditorSelection.cursor(selection) : selection,
		extensions: [
			EditorState.allowMultipleSelections.of(true),
			markdown({ base: markdownLanguage }),
			liveCallbacksFacet.of({ filePath: () => "/w/docs/note.md" } as any),
			liveBlockField,
			liveInteractionExtension,
			...extra,
		],
	});

/** As much of a view as a command needs to be run: a state, and a dispatch that goes through the state's filters. */
function headless(state: EditorState): EditorView {
	const view: any = {
		state,
		dom: { isConnected: true },
		lineWrapping: false,
		moveVertically: (range: unknown) => range,
		dispatch(...specs: (Transaction | TransactionSpec)[]) {
			const tr = specs[0] instanceof Transaction ? specs[0] : view.state.update(...(specs as TransactionSpec[]));
			view.state = tr.state;
		},
		focus() {},
	};
	return view as EditorView;
}

const text = (view: EditorView) => view.state.doc.toString();
const cursors = (view: EditorView) => view.state.selection.ranges.map((r) => [r.anchor, r.head]);
/** What the editor draws nothing for: the range its hidden front matter widget replaces. */
function hidden(state: EditorState): string | null {
	let out: string | null = null;
	state.field(liveBlockField).between(0, state.doc.length, (from, to, deco) => {
		if (deco.spec.widget?.constructor.name === "HiddenFrontmatterWidget") out = state.sliceDoc(from, to);
	});
	return out;
}
/** Text typed at the main cursor, as the editor's input handler dispatches it. */
function type(view: EditorView, typed: string) {
	const at = view.state.selection.main.head;
	view.dispatch({ changes: { from: at, insert: typed }, selection: EditorSelection.cursor(at + typed.length), userEvent: "input.type" });
}
/** The document's text arriving from the model: how MarkdownLiveEditor's model listener dispatches it. */
function fromModel(view: EditorView, next: string, cursor: number) {
	view.dispatch({
		changes: { from: 0, to: view.state.doc.length, insert: next },
		selection: EditorSelection.cursor(Math.min(cursor, next.length)),
		annotations: [Transaction.addToHistory.of(false)],
	});
}

describe("P2: the hidden front matter: what is done in the editor stays out of it", () => {
	test("the block is hidden, and the cursor of these tests is on the first line of the body", () => {
		const state = liveState(DOC, B + 3);
		expect(hidden(state)).toBe(FM);
		expect(state.doc.lineAt(B + 3).text).toBe("Remember: call the lab");
	});

	test("Move Line Up on the first line of the body does nothing, however long the key is held", () => {
		const view = headless(liveState(DOC, B + 3));
		for (let press = 0; press < 6; press++) moveLineUp(view);
		expect(text(view)).toBe(DOC);
		expect(cursors(view)).toEqual([[B + 3, B + 3]]);
		expect(hidden(view.state)).toBe(FM);
		expect(frontMatter(text(view)).values).toEqual({ title: "Sample note", status: "open" });
		// What is typed next is typed in the body, where the cursor still is.
		type(view, "ZZ");
		expect(text(view)).toBe(`${FM}\nRemZZember: call the lab\nSecond line\nThird line\n`);
	});

	test("with an empty line under the block the line goes up to it, and no further", () => {
		const doc = `${FM}\n\nFirst paragraph\nSecond\n`;
		const view = headless(liveState(doc, doc.indexOf("First") + 2));
		moveLineUp(view);
		expect(text(view)).toBe(`${FM}\nFirst paragraph\n\nSecond\n`);
		moveLineUp(view);
		moveLineUp(view);
		expect(text(view)).toBe(`${FM}\nFirst paragraph\n\nSecond\n`);
		expect(hidden(view.state)).toBe(FM);
	});

	test("a selection that starts on the first line of the body, and one cursor of several there: nothing moves", () => {
		const selected = headless(liveState(DOC, EditorSelection.single(B + 2, DOC.indexOf("Second") + 3)));
		moveLineUp(selected);
		expect(text(selected)).toBe(DOC);
		expect(cursors(selected)).toEqual([[B + 2, DOC.indexOf("Second") + 3]]);

		const two = EditorSelection.create([EditorSelection.cursor(B + 2), EditorSelection.cursor(DOC.indexOf("Third") + 1)], 1);
		const several = headless(liveState(DOC, two));
		moveLineUp(several);
		expect(text(several)).toBe(DOC);
		expect(cursors(several)).toEqual([[B + 2, B + 2], [DOC.indexOf("Third") + 1, DOC.indexOf("Third") + 1]]);
	});

	test("lines of the body move as they did: down from the first line, up from the second", () => {
		const down = headless(liveState(DOC, B + 3));
		moveLineDown(down);
		expect(text(down)).toBe(`${FM}\nSecond line\nRemember: call the lab\nThird line\n`);
		const up = headless(liveState(DOC, DOC.indexOf("Second") + 2));
		moveLineUp(up);
		expect(text(up)).toBe(`${FM}\nSecond line\nRemember: call the lab\nThird line\n`);
		expect(hidden(up.state)).toBe(FM);
		// A selection over the first two lines of the body goes down as one.
		const both = headless(liveState(DOC, EditorSelection.single(B + 2, DOC.indexOf("Second") + 3)));
		moveLineDown(both);
		expect(text(both)).toBe(`${FM}\nThird line\nRemember: call the lab\nSecond line\n`);
		expect(hidden(both.state)).toBe(FM);
	});

	test("Transpose Characters at the start of the body does not join its first letter to the closing fence", () => {
		const view = headless(liveState(DOC, B));
		transposeChars(view);
		expect(text(view)).toBe(DOC);
		expect(hidden(view.state)).toBe(FM);
		// Inside the line it still swaps two letters.
		const inside = headless(liveState(DOC, B + 2));
		transposeChars(inside);
		expect(text(inside)).toBe(`${FM}\nRmeember: call the lab\nSecond line\nThird line\n`);
	});

	test("Backspace with a second cursor at the start of the body does not join the body to the closing fence", () => {
		// The main cursor is elsewhere: the guard on Backspace looked at the main cursor alone.
		const two = EditorSelection.create([EditorSelection.cursor(B), EditorSelection.cursor(DOC.indexOf("Third") + 2)], 1);
		const view = headless(liveState(DOC, two));
		deleteCharBackward(view);
		expect(text(view)).toBe(DOC);
		expect(hidden(view.state)).toBe(FM);
	});

	test("the commands on whole lines work on the first line of the body and leave the block as it was", () => {
		const run = (command: (view: EditorView) => boolean, at = B + 3) => {
			const view = headless(liveState(DOC, at));
			command(view);
			expect(hidden(view.state)).toBe(FM);
			expect(text(view).startsWith(`${FM}\n`)).toBe(true);
			return text(view).slice(B);
		};
		expect(run(copyLineUp)).toBe(`Remember: call the lab\n${BODY}`);
		expect(run(copyLineDown)).toBe(`Remember: call the lab\n${BODY}`);
		expect(run(cmDuplicateLineOrSelection)).toBe(`Remember: call the lab\n${BODY}`);
		// Delete Line takes the line break before the line, which is the block's: the block still ends in one after it.
		expect(run(deleteLine)).toBe("Second line\nThird line\n");
		expect(run(cmJoinLines)).toBe("Remember: call the lab Second line\nThird line\n");
		expect(run(indentMore)).toBe(`  ${BODY}`);
		expect(run(indentLess)).toBe(BODY);
		expect(run(cmInsertLineAbove)).toBe(`\n${BODY}`);
		expect(run(cmToggleComment)).toBe("<!-- Remember: call the lab -->\nSecond line\nThird line\n");
	});

	test("Delete Line on the only line of the body leaves the block its line break, and the next letter goes under it", () => {
		const doc = `${FM}\nOnly line`;
		const view = headless(liveState(doc, B + 2));
		deleteLine(view);
		expect(text(view)).toBe(`${FM}\n`);
		expect(cursors(view)).toEqual([[B, B]]);
		type(view, "x");
		expect(text(view)).toBe(`${FM}\nx`);
		expect(hidden(view.state)).toBe(FM);
		expect(frontMatter(text(view)).values).toEqual({ title: "Sample note", status: "open" });
	});

	test("Select Next Occurrence and Select All Occurrences take no word of the hidden block, and typing over them leaves it", () => {
		const doc = `${FM}\nit is open\nand open again\n`;
		const first = doc.indexOf("open", B);
		const second = doc.indexOf("open", first + 1);
		const view = headless(liveState(doc, EditorSelection.single(first, first + 4)));
		selectNextOccurrence(view);
		expect(cursors(view)).toEqual([[first, first + 4], [second, second + 4]]);
		// The next one is the property's `open`: it is not selected.
		selectNextOccurrence(view);
		expect(cursors(view)).toEqual([[first, first + 4], [second, second + 4]]);
		view.dispatch(view.state.replaceSelection("closed"), { userEvent: "input.type" });
		expect(text(view)).toBe(`${FM}\nit is closed\nand closed again\n`);

		const all = headless(liveState(doc, EditorSelection.single(first, first + 4)));
		selectSelectionMatches(all);
		expect(cursors(all)).toEqual([[first, first + 4], [second, second + 4]]);
	});

	test("a range of several in the block: a selection goes, one that reaches into it is cut, a cursor stops at the body", () => {
		const body = EditorSelection.cursor(DOC.indexOf("Second") + 2);
		const set = (ranges: ReturnType<typeof EditorSelection.range>[], main: number) => {
			const view = headless(liveState(DOC, B + 3));
			view.dispatch({ selection: EditorSelection.create(ranges, main) });
			return cursors(view);
		};
		expect(set([EditorSelection.range(4, 9), body], 1)).toEqual([[body.head, body.head]]);
		expect(set([EditorSelection.range(4, B + 4), body], 1)).toEqual([[B, B + 4], [body.head, body.head]]);
		expect(set([EditorSelection.cursor(6), body], 1)).toEqual([[B, B], [body.head, body.head]]);
		// As before for the main one: it stops at the body's start (the others are let go, as they were).
		expect(set([EditorSelection.cursor(6), body], 0)).toEqual([[B, B]]);
		// Add Cursor Above from the first line of the body puts its new cursor there too.
		const view = headless(liveState(DOC, B));
		cmInsertCursor(view, -1);
		expect(cursors(view)).toEqual([[B, B]]);
	});

	test("the model's text is taken as it comes: a property written in the Info panel, a file read again", () => {
		const view = headless(liveState(DOC, B + 3));
		const written = DOC.replace("status: open", "status: in review\nowner: lab");
		fromModel(view, written, B + 3);
		expect(text(view)).toBe(written);
		expect(frontMatter(text(view)).values).toEqual({ title: "Sample note", status: "in review", owner: "lab" });
		// The block grew past the cursor's number: the cursor is put at the body, not left in the YAML.
		const bodyNow = written.indexOf("Remember");
		expect(cursors(view)).toEqual([[bodyNow, bodyNow]]);
		type(view, "ZZ");
		expect(text(view)).toBe(written.replace("Remember", "ZZRemember"));
		// A file read again with no front matter at all.
		fromModel(view, "No front matter now\n", 3);
		expect(text(view)).toBe("No front matter now\n");
		expect(cursors(view)).toEqual([[3, 3]]);
	});

	test("the undo of a write to the block leaves the cursor in the body, and what is typed next goes there", () => {
		// MarkdownLiveEditor's model listener puts the cursor at the end of what an undo changed: here, in the block.
		const view = headless(liveState(DOC.replace("status: open", "status: done"), B + 3));
		fromModel(view, DOC, DOC.indexOf("open") + 4);
		expect(text(view)).toBe(DOC);
		expect(cursors(view)).toEqual([[B, B]]);
		type(view, "ZZ");
		expect(text(view)).toBe(`${FM}\nZZ${BODY}`);
	});

	test("undo and redo of the editor's own history may write in the block", () => {
		const view = headless(liveState(DOC, B + 3, [history()]));
		type(view, "ZZ");
		undo(view);
		expect(text(view)).toBe(DOC);
		redo(view);
		expect(text(view)).toBe(`${FM}\nRemZZember: call the lab\nSecond line\nThird line\n`);
		// A change that undoes one in the block (the history's own transactions carry these user events).
		for (const userEvent of ["undo", "redo"]) {
			const at = headless(liveState(DOC, B + 3));
			at.dispatch({ changes: { from: DOC.indexOf("open"), to: DOC.indexOf("open") + 4, insert: "done" }, userEvent });
			expect(text(at)).toBe(DOC.replace("status: open", "status: done"));
		}
	});

	test("a document written again whole is applied when it leaves the block as it was, and refused when it does not", () => {
		// The context menu's "Fix broken link" writes the whole document.
		const view = headless(liveState(DOC, B + 3));
		const mended = DOC.replace("call the lab", "call the [lab](lab.md)");
		view.dispatch({ changes: { from: 0, to: DOC.length, insert: mended }, userEvent: "input.fix" });
		expect(text(view)).toBe(mended);
		// The cursor of a text replaced whole is at its top, which is in the block: it is put at the body.
		expect(cursors(view)).toEqual([[B, B]]);
		view.dispatch({ changes: { from: 0, to: mended.length, insert: mended.replace("status: open", "status: shut") }, userEvent: "input.fix" });
		expect(text(view)).toBe(mended);
	});

	test("whatever the user event, and with none: a change in the block is refused, one beside it is not", () => {
		for (const userEvent of ["input.type", "input.paste", "input.drop", "delete.cut", "move.line", "input.table", undefined]) {
			const view = headless(liveState(DOC, B + 3));
			view.dispatch({ changes: { from: 6, insert: "Z" }, ...(userEvent ? { userEvent } : {}) });
			expect(text(view)).toBe(DOC);
			// At the end of the closing fence: the fence would no longer be one.
			view.dispatch({ changes: { from: FM.length, insert: "Z" }, ...(userEvent ? { userEvent } : {}) });
			expect(text(view)).toBe(DOC);
			// A new first line of the body, written from the block's end: the block is as it was.
			view.dispatch({ changes: { from: FM.length, insert: "\nNew first line" }, ...(userEvent ? { userEvent } : {}) });
			expect(text(view)).toBe(`${FM}\nNew first line\n${BODY}`);
			expect(hidden(view.state)).toBe(FM);
		}
	});

	test("while a search shows the block as text it can be edited there, as before", () => {
		const view = headless(liveState(DOC, B + 3, [search()]));
		openSearchPanel(view);
		view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "Sample" })) });
		expect(hidden(view.state)).toBeNull();
		view.dispatch({ changes: { from: DOC.indexOf("Sample"), insert: "A " }, userEvent: "input.type" });
		expect(text(view)).toBe(DOC.replace("Sample", "A Sample"));
		// A query that is not in the block: it is hidden again, and kept.
		view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "Third" })) });
		expect(hidden(view.state)).toBe(FM.replace("Sample", "A Sample"));
		const before = text(view);
		view.dispatch({ changes: { from: 6, insert: "Z" }, userEvent: "input.type" });
		expect(text(view)).toBe(before);
	});

	test("Replace All still writes the matches of the body and skips the block's", () => {
		const doc = `${FM}\nit is open\n`;
		const view = headless(liveState(doc, B));
		view.dispatch({
			changes: [
				{ from: doc.indexOf("open"), to: doc.indexOf("open") + 4, insert: "shut" },
				{ from: doc.lastIndexOf("open"), to: doc.lastIndexOf("open") + 4, insert: "shut" },
			],
			userEvent: "input.replace.all",
		});
		expect(text(view)).toBe(`${FM}\nit is shut\n`);
	});

	test("a document that is its front matter and nothing more can still be typed in", () => {
		// No body to keep the cursor in: the guard stands aside, as the cursor's clamp always did there, and does
		// not refuse every key. (Where the letter goes is as it was.)
		const view = headless(liveState(FM, FM.length));
		type(view, "x");
		expect(text(view)).toContain("x");
		// A line break typed at its end starts the body, and from then on the block is kept.
		const started = headless(liveState(FM, FM.length));
		type(started, "\n");
		type(started, "x");
		expect(text(started)).toBe(`${FM}\nx`);
		started.dispatch({ changes: { from: 6, insert: "Z" }, userEvent: "input.type" });
		expect(text(started)).toBe(`${FM}\nx`);
	});

	test("where it is wired (read from the source: the key and the model listener need a window)", () => {
		const keymap = source("src/view/editor/cmKeymap.ts");
		expect(keymap).toContain('{ key: "Alt-ArrowUp", run: moveLineUp, preventDefault: true }');
		const editor = source("src/view/editor/MarkdownLiveEditor.tsx");
		// The filter is one of the live editor's extensions, and the model's text is dispatched with the mark the filter lets through.
		expect(editor).toMatch(/liveBlockField,[\s\S]{0,200}liveInteractionExtension,/);
		expect(editor).toContain("annotations: [externalSyncAnnotation.of(true), Transaction.addToHistory.of(false)]");
	});
});

// --- P3. A live table: one cell edited, and the cells beyond the header's columns ---------------------------------

/** The text of a table after one cell was edited as the live table edits it. */
function editCell(raw: string, row: number, col: number, value: string): string {
	const table = parseTableRaw(raw)!;
	const edit = tableCellTextEdit(raw, table, row, col, value);
	return edit ? raw.slice(0, edit.from) + edit.insert + raw.slice(edit.to) : raw;
}

/** A table's rows with the cells each has beyond the header's columns. */
const rowsWithExtra = (table: MarkdownTable) => table.rows.map((cells, r) => ({ cells, extra: table.extra?.[r] ?? [] }));

const OPERATORS = ["| Operator | Meaning |", "|---|---|", "| `a` | plain |", "| or | written a | b in SSL |", "| and | both |"].join("\n");

// A small seeded generator, so that a failure can be run again from its seed.
function seeded(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const CELLS = ["a", "b c", "", "`x\\|y`", "a \\| b", "1", "**bold**", "ends\\\\", "tail\\", "<br>two", "ü", "`code`", "-", ":-:", "x  y", "\\|", "a\\\\\\|b", "[l](u)"];
const VALUES = ["new", "", "a|b", "`p|q`", "line1\nline2", "ends with \\", "\\", " padded ", "a\\|b", "x\\\\", "|", "||", "---", "ü ö", "tab\there", "a | b | c"];

/**
 * A table as people and tools write them: with or without the outer pipes, padded with spaces, a tab or nothing,
 * in a quote or indented, rows indented further, with LF or CRLF line ends, rows shorter and longer than the
 * header, a row that is one pipe, empty headers, escaped pipes, code with pipes and trailing backslashes in cells.
 */
function randomTable(next: () => number): { raw: string; eol: string } {
	const pick = <X>(xs: X[]) => xs[Math.floor(next() * xs.length)]!;
	const cols = 1 + Math.floor(next() * 4);
	const prefix = pick(["", "", "", "> ", "  ", "> > "]);
	const eol = pick(["\n", "\n", "\r\n"]);
	const style = () => ({ lead: next() < 0.85, trail: next() < 0.85, pad: pick(["", " ", " ", "  ", "\t"]), indent: pick(["", "", "", " ", "   "]) });
	const row = (cells: string[], st = style()) => {
		if (cells.length === 1 && !cells[0] && next() < 0.3) return `${prefix}${st.indent}|`;
		// Written without its leading pipe a row cannot open with an empty cell, and a row needs one pipe to be one.
		const lead = st.lead || !cells[0]?.trim();
		const trail = st.trail || !cells[cells.length - 1]?.trim() || cells.length === 1;
		// A cell that ends in an odd number of backslashes has a space before the pipe after it, or it would not be that cell.
		const escapes = (c: string) => /\\*$/.exec(c)![0].length % 2 === 1;
		const body = cells.map((c) => `${st.pad}${c}${escapes(c) && !st.pad ? " " : st.pad}`).join("|");
		return `${prefix}${st.indent}${lead ? "|" : ""}${body}${trail ? "|" : ""}${pick(["", "", " ", "  "])}`;
	};
	const header = Array.from({ length: cols }, (_, i) => pick(["H", "Name", `Col ${i}`, "`h\\|h`", "x", ""]));
	const delimiter = Array.from({ length: cols }, () => pick(["---", ":--", "--:", ":-:", "-", "-----"]));
	const lines = [row(header, { lead: true, trail: true, pad: " ", indent: "" }), row(delimiter, { lead: true, trail: true, pad: pick(["", " "]), indent: "" })];
	const bodyRows = Math.floor(next() * 5);
	for (let i = 0; i < bodyRows; i++) {
		const count = Math.max(1, cols + Math.floor(next() * 5) - 2);
		lines.push(row(Array.from({ length: count }, () => pick(CELLS))));
	}
	return { raw: lines.join(eol), eol };
}

describe("P3: a live table: an edit of one cell changes that cell's text and nothing else", () => {
	test("a cell of another row edited: the row with a cell more than the header keeps it, and no line is repadded", () => {
		expect(editCell(OPERATORS, 1, 1, "plain text")).toBe(
			["| Operator | Meaning |", "|---|---|", "| `a` | plain text |", "| or | written a | b in SSL |", "| and | both |"].join("\n"),
		);
	});

	test("the row's own cells edited: the cell after them stays", () => {
		expect(editCell(OPERATORS, 2, 0, "either")).toBe(OPERATORS.replace("| or |", "| either |"));
		expect(editCell(OPERATORS, 2, 1, "one | other")).toBe(OPERATORS.replace("| written a |", "| one \\| other |"));
		expect(editCell(OPERATORS, 2, 1, "")).toBe(OPERATORS.replace("| written a |", "|  |"));
		expect(parseTableRaw(editCell(OPERATORS, 2, 1, ""))!.extra![2]).toEqual(["b in SSL"]);
	});

	test("what the live table wrote for it before is what the whole-table edit still writes, now with the cell kept", () => {
		// `updateTableCell` is still how the table is worked out for an action on rows or columns.
		expect(updateTableCell(parseTableRaw(OPERATORS)!, 1, 1, "plain text").text).toBe(
			["| Operator | Meaning    |", "| -------- | ---------- |", "| `a`      | plain text |", "| or       | written a  | b in SSL |", "| and      | both       |"].join("\n"),
		);
	});

	test("odd spacing, escaped pipes, code with a pipe and a header written without outer pipes stay as written", () => {
		const raw = ["Name|Notes", ":--|--:", "  `a\\|b`   |x \\| y", "|plain|   spaced   out   |", "last | row"].join("\n");
		expect(editCell(raw, 2, 1, "edited")).toBe(raw.replace("   spaced   out   ", "   edited   "));
		expect(editCell(raw, 1, 1, "x | y | z")).toBe(raw.replace("x \\| y", "x \\| y \\| z"));
		expect(editCell(raw, 1, 0, "`a|c`")).toBe(raw.replace("`a\\|b`", "`a\\|c`"));
		expect(editCell(raw, 0, 0, "Title")).toBe(raw.replace("Name|", "Title|"));
		expect(editCell(raw, 3, 1, "two\nlines")).toBe(raw.replace("last | row", "last | two<br>lines"));
	});

	test("a cell the row does not have is written after its last cell, and nothing is written while it is empty", () => {
		const raw = ["| A | B | C |", "|---|---|---|", "| 1 |", "| 1 | 2", "x | y"].join("\n");
		expect(editCell(raw, 1, 2, "three")).toBe(raw.replace("| 1 |\n", "| 1 |  | three |\n"));
		expect(editCell(raw, 2, 2, "three")).toBe(raw.replace("| 1 | 2\n", "| 1 | 2 | three\n"));
		expect(editCell(raw, 3, 2, "z")).toBe(raw.replace("x | y", "x | y | z"));
		expect(editCell(raw, 1, 2, "")).toBe(raw);
		expect(tableCellTextEdit(raw, parseTableRaw(raw)!, 1, 2, "  ")).toBeNull();
		expect(parseTableRaw(editCell(raw, 1, 2, "three"))!.rows[1]).toEqual(["1", "", "three"]);
	});

	test("a value that ends in a backslash does not escape the pipe after it", () => {
		const raw = ["|A|B|", "|-|-|", "|one|two|"].join("\n");
		const next = editCell(raw, 1, 0, "path\\");
		expect(next).toBe(raw.replace("|one|", "|path\\ |"));
		expect(parseTableRaw(next)!.rows[1]).toEqual(["path\\", "two"]);
	});

	test("the first cell of a row written without a leading pipe is emptied without moving its other cells left", () => {
		const raw = ["| A | B |", "|---|---|", "one | two"].join("\n");
		const next = editCell(raw, 1, 0, "");
		expect(next).toBe(raw.replace("one | two", "| | two"));
		expect(parseTableRaw(next)!.rows[1]).toEqual(["", "two"]);
	});

	test("a table read with its CRLF line ends: the change is where the cell is, and every `\\r` stays", () => {
		const raw = OPERATORS.replace(/\n/g, "\r\n");
		expect(editCell(raw, 2, 0, "either")).toBe(raw.replace("| or |", "| either |"));
		expect(editCell(raw, 3, 1, "all")).toBe(raw.replace("| both |", "| all |"));
		expect(editCell(raw, 3, 1, "all").split("\r\n").length).toBe(5);
	});

	test("a cell that already says what was typed, and a cell that is not in the table, change nothing", () => {
		const table = parseTableRaw(OPERATORS)!;
		expect(tableCellTextEdit(OPERATORS, table, 1, 1, "plain")).toBeNull();
		expect(tableCellTextEdit(OPERATORS, table, 1, 1, " plain  ")).toBeNull();
		expect(tableCellTextEdit(OPERATORS, table, 1, 2, "x")).toBeNull();
		expect(tableCellTextEdit(OPERATORS, table, 9, 0, "x")).toBeNull();
		expect(tableCellTextEdit(OPERATORS, table, -1, 0, "x")).toBeNull();
	});

	test("random tables, one random cell edited: every other line is byte for byte, and the table reads back with the edit", () => {
		const seen = { tables: 0, extra: 0, short: 0, missing: 0, crlf: 0, bare: 0 };
		for (let seed = 1; seed <= 4000; seed++) {
			const next = seeded(seed);
			const { raw, eol } = randomTable(next);
			const table = parseTableRaw(raw)!;
			const lines = raw.split(eol);
			expect(table.endLine).toBe(lines.length - 1);
			const row = Math.floor(next() * table.rows.length);
			const col = Math.floor(next() * table.alignments.length);
			const value = VALUES[Math.floor(next() * VALUES.length)]!;
			const want = serializeTableCell(value);
			const lineIdx = row === 0 ? 0 : row + 1;
			const written = splitTableRow(lines[lineIdx]!, table.prefix)!.length;
			seen.tables++;
			if (table.extra?.[row]?.length) seen.extra++;
			if (written < table.alignments.length) seen.short++;
			if (col >= written) seen.missing++;
			if (eol === "\r\n") seen.crlf++;
			if (!lines[lineIdx]!.slice(table.prefix.length).trimStart().startsWith("|")) seen.bare++;

			const edit = tableCellTextEdit(raw, table, row, col, value);
			const at = `seed ${seed}: ${JSON.stringify({ raw, row, col, value, edit })}`;
			if (!edit) {
				// Nothing to write: the cell says it already (a cell the row does not have says nothing).
				expect(table.rows[row]![col], at).toBe(want);
				continue;
			}
			const after = raw.slice(0, edit.from) + edit.insert + raw.slice(edit.to);
			const afterLines = after.split(eol);
			expect(afterLines.length, at).toBe(lines.length);
			afterLines.forEach((line, i) => {
				if (i !== lineIdx) expect(line, at).toBe(lines[i]!);
			});
			const read = parseTableRaw(after)!;
			expect(read, at).not.toBeNull();
			expect(read.rows, at).toEqual(table.rows.map((cells, r) => cells.map((cell, c) => (r === row && c === col ? want : cell))));
			expect(read.extra ?? [], at).toEqual(table.extra ?? []);
			expect(read.alignments, at).toEqual(table.alignments);
			expect([read.prefix, read.endLine], at).toEqual([table.prefix, table.endLine]);
			expect(cellValueForEdit(read.rows[row]![col]!), at).toBe(cellValueForEdit(want));
		}
		// The cases the test is for were met, each many times.
		expect(seen.tables).toBe(4000);
		for (const count of [seen.extra, seen.short, seen.missing, seen.crlf, seen.bare]) expect(count).toBeGreaterThan(150);
	});

	test("through the editor: the widget the field builds over the table, and the change its cell editor dispatches", () => {
		const doc = `Intro\n\n${OPERATORS}\n\nAfter\n`;
		const state = EditorState.create({
			doc,
			selection: EditorSelection.cursor(0),
			extensions: [markdown({ base: markdownLanguage }), liveCallbacksFacet.of({ filePath: () => "/w/docs/note.md" } as any), liveBlockField, liveInteractionExtension],
		});
		const widgetOf = (s: EditorState) => {
			let found: { raw: string; from: number } | null = null;
			s.field(liveBlockField).between(0, s.doc.length, (_from, _to, deco) => {
				if (deco.spec.widget?.constructor.name === "TableWidget") found = { raw: (deco.spec.widget as any).raw, from: (deco.spec.widget as any).from };
			});
			return found as { raw: string; from: number } | null;
		};
		const widget = widgetOf(state)!;
		expect(widget.raw).toBe(OPERATORS);
		expect(state.sliceDoc(widget.from, widget.from + widget.raw.length)).toBe(OPERATORS);
		// What commitActiveCell does with the cell's textarea: the cell's own change, at the table's place.
		const edit = tableCellTextEdit(widget.raw, parseTableRaw(widget.raw)!, 1, 1, "plain text")!;
		const tr = state.update({ changes: { from: widget.from + edit.from, to: widget.from + edit.to, insert: edit.insert }, userEvent: "input.table" });
		expect(tr.state.doc.toString()).toBe(doc.replace("| plain |", "| plain text |"));
		let changed = 0;
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			changed++;
			expect(state.sliceDoc(fromA, toA)).toBe("plain");
			expect(inserted.toString()).toBe("plain text");
		});
		expect(changed).toBe(1);
		// The table is still one table to the editor, and its widget has the new text.
		expect(widgetOf(tr.state)!.raw).toBe(OPERATORS.replace("| plain |", "| plain text |"));
	});

	test("the widget writes a cell through that function, and Tab and Enter no longer write the table (read from the source: it needs a DOM)", () => {
		const widget = source("src/view/editor/cmLiveTable.ts");
		const commit = widget.slice(widget.indexOf("const commitActiveCell = (): boolean => {"), widget.indexOf("const sortByColumnInPlace"));
		expect(commit).toContain("tableCellTextEdit(ctrl.raw, ctrl.table, row, col, nextVal)");
		expect(commit).toContain("changes: { from: at + edit.from, to: at + edit.to, insert: edit.insert }");
		expect(commit).not.toContain("updateTableCell");
		// Nothing but an action that adds a row is written whole from the cell's key handler.
		expect(widget).not.toContain("dispatchEdit(updated");
		expect(widget.match(/commitActiveCell\(\);\n\t+ctrl\.openCell\(/g)?.length).toBeGreaterThanOrEqual(3);
	});
});

describe("P3: actions that write the table again keep the cells beyond the header's columns", () => {
	const table = () => parseTableRaw(OPERATORS)!;
	const read = (edit: { text: string } | null) => rowsWithExtra(parseTableRaw(edit!.text)!);
	const or = { cells: ["or", "written a"], extra: ["b in SSL"] };

	test("the table as it is read: the row's cells under the header, and the rest beside them", () => {
		expect(table().rows[2]).toEqual(["or", "written a"]);
		expect(table().extra).toEqual([[], [], ["b in SSL"], []]);
		// A table with no such row is as it was read before.
		expect("extra" in parseTableRaw("| A |\n|---|\n| 1 |")!).toBe(false);
	});

	test("Format, and Tab or Enter in a table edited as text: the cell stays in its row, after the last column", () => {
		expect(formatTable(table(), 1, 0).lines[3]).toBe("| or       | written a | b in SSL |");
		expect(stepTableCell(table(), 1, 0, 1).lines[3]).toBe("| or       | written a | b in SSL |");
		expect(enterTableRow(table(), 1, 0).lines[3]).toBe("| or       | written a | b in SSL |");
		// Format of what Format wrote changes nothing more.
		const once = formatTable(table(), 1, 0).text;
		expect(formatTable(parseTableRaw(once)!, 1, 0).text).toBe(once);
	});

	test("a row added, removed, moved or sorted: the cell goes where its row goes", () => {
		expect(read(insertTableRow(table(), 1, "below"))).toEqual([
			{ cells: ["Operator", "Meaning"], extra: [] },
			{ cells: ["`a`", "plain"], extra: [] },
			{ cells: ["", ""], extra: [] },
			or,
			{ cells: ["and", "both"], extra: [] },
		]);
		expect(read(deleteTableRow(table(), 1, 0))[1]).toEqual(or);
		expect(read(deleteTableRow(table(), 2, 0)).some((row) => row.extra.length)).toBe(false);
		expect(read(moveTableRow(table(), 2, 0, 1))[3]).toEqual(or);
		expect(read(moveTableRow(table(), 2, 0, -1))[1]).toEqual(or);
		expect(read(sortTableByColumn(table(), 1, 0, "asc")).map((row) => row.cells[0])).toEqual(["Operator", "`a`", "and", "or"]);
		expect(read(sortTableByColumn(table(), 1, 0, "asc"))[3]).toEqual(or);
		expect(read(sortTableByColumn(table(), 1, 0, "desc"))[1]).toEqual(or);
		// A row added at the end by Tab from the last cell, or by Enter on the last row.
		expect(read(stepTableCell(table(), 3, 1, 1))[2]).toEqual(or);
		expect(read(enterTableRow(table(), 3, 1))[2]).toEqual(or);
	});

	test("a column added, removed, moved or aligned: the cell stays after the row's last column, in no column", () => {
		expect(insertTableColumn(table(), 0, 0, "left").lines[3]).toBe("|        | or       | written a | b in SSL |");
		expect(insertTableColumn(table(), 0, 1, "right").lines[3]).toBe("| or       | written a |        | b in SSL |");
		expect(read(insertTableColumn(table(), 0, 1, "right"))[2]).toEqual({ cells: ["or", "written a", ""], extra: ["b in SSL"] });
		expect(read(deleteTableColumn(table(), 0, 1))[2]).toEqual({ cells: ["or"], extra: ["b in SSL"] });
		expect(read(deleteTableColumn(table(), 0, 0))[2]).toEqual({ cells: ["written a"], extra: ["b in SSL"] });
		expect(read(moveTableColumn(table(), 0, 0, 1))[2]).toEqual({ cells: ["written a", "or"], extra: ["b in SSL"] });
		expect(read(setTableAlignment(table(), 0, 1, "right"))[2]).toEqual(or);
		expect(read(updateTableCell(table(), 2, 0, "either"))[2]).toEqual({ cells: ["either", "written a"], extra: ["b in SSL"] });
	});

	test("cells pasted over the table, growing it by a column: the cell is not taken for the new column", () => {
		const merged = mergeTsvIntoTable(table(), 1, 1, "x\ty\nz\tw")!;
		expect(read(merged)[2]).toEqual({ cells: ["or", "z", "w"], extra: ["b in SSL"] });
	});

	test("the Format action on a table edited as text keeps it in the document (the command the menu and the palette run)", () => {
		const doc = `Intro\n\n${OPERATORS}\n`;
		const view = headless(EditorState.create({ doc, selection: EditorSelection.cursor(doc.indexOf("| or |") + 3), extensions: [markdown({ base: markdownLanguage })] }));
		expect(runTableAction(view, "md-table-format")).toBe(true);
		expect(view.state.doc.toString()).toContain("| or       | written a | b in SSL |");
		expect(runTableAction(view, "md-table-row-below")).toBe(true);
		expect(view.state.doc.toString()).toContain("| or       | written a | b in SSL |");
	});

	test("random tables, every action: each row that stays has the cells beyond the header that it had", () => {
		type Action = (t: MarkdownTable, row: number, col: number) => { text: string } | null;
		const actions: [string, Action, (rows: ReturnType<typeof rowsWithExtra>, row: number, t: MarkdownTable) => string[][]][] = [
			["format", (t, row, col) => formatTable(t, row, col), (rows) => rows.map((r) => r.extra)],
			["cell", (t, row, col) => updateTableCell(t, row, col, "edited"), (rows) => rows.map((r) => r.extra)],
			["align", (t, row, col) => setTableAlignment(t, row, col, "center"), (rows) => rows.map((r) => r.extra)],
			["column left", (t, row, col) => insertTableColumn(t, row, col, "left"), (rows) => rows.map((r) => r.extra)],
			["column right", (t, row, col) => insertTableColumn(t, row, col, "right"), (rows) => rows.map((r) => r.extra)],
			["column gone", (t, row, col) => deleteTableColumn(t, row, col), (rows) => rows.map((r) => r.extra)],
			["column moved", (t, row, col) => moveTableColumn(t, row, col, 1), (rows) => rows.map((r) => r.extra)],
			["row below", (t, row) => insertTableRow(t, row, "below"), (rows, row) => [...rows.slice(0, row + 1).map((r) => r.extra), [], ...rows.slice(row + 1).map((r) => r.extra)]],
			["row gone", (t, row, col) => deleteTableRow(t, row, col), (rows, row) => rows.filter((_, r) => r !== row).map((r) => r.extra)],
			[
				"row down",
				(t, row, col) => moveTableRow(t, row, col, 1),
				(rows, row) => {
					const out = rows.map((r) => r.extra);
					[out[row], out[row + 1]] = [out[row + 1]!, out[row]!];
					return out;
				},
			],
			["row at the end", (t, _row, col) => stepTableCell(t, t.rows.length - 1, t.alignments.length - 1, 1) && enterTableRow(t, t.rows.length - 1, col), (rows) => [...rows.map((r) => r.extra), []]],
		];
		let withExtra = 0;
		for (let seed = 1; seed <= 1500; seed++) {
			const next = seeded(seed);
			const { raw } = randomTable(next);
			const t = parseTableRaw(raw)!;
			const row = Math.floor(next() * t.rows.length);
			const col = Math.floor(next() * t.alignments.length);
			const before = rowsWithExtra(t);
			if (before.some((r) => r.extra.length)) withExtra++;
			for (const [name, run, expected] of actions) {
				const edit = run(t, row, col);
				if (!edit) continue;
				const after = parseTableRaw(edit.text)!;
				expect(rowsWithExtra(after).map((r) => r.extra), `seed ${seed}, ${name}: ${JSON.stringify({ raw, row, col, text: edit.text })}`).toEqual(expected(before, row, t));
			}
			// Sorted: each row is still with its own cells, whatever the order.
			const key = (r: { cells: string[]; extra: string[] }) => JSON.stringify([r.cells, r.extra]);
			const sorted = rowsWithExtra(parseTableRaw(sortTableByColumn(t, row, col, "asc").text)!);
			expect(sorted.slice(1).map(key).sort(), `seed ${seed}, sort: ${JSON.stringify(raw)}`).toEqual(before.slice(1).map(key).sort());
			// The action leaves the table it was given as it was.
			expect(rowsWithExtra(t)).toEqual(before);
		}
		expect(withExtra).toBeGreaterThan(400);
	});
});

describe("P3: a row with more cells than the table has columns says so", () => {
	const table = parseTableRaw(OPERATORS)!;

	test("the mark at the end of such a row, and what it says in Live and in Read", () => {
		expect(extraCellsNote(table, 2, false)).toEqual({
			label: "+1",
			title: "1 more cell in this row than the table has columns: b in SSL. Use Raw to edit it.",
		});
		expect(extraCellsNote(table, 2, true)).toEqual({ label: "+1", title: "1 more cell in this row than the table has columns: b in SSL" });
		const three = parseTableRaw("| A |\n|---|\n| 1 | 2 | `x\\|y` |  |")!;
		// The empty cell at the row's end is not counted: there is nothing in it to find.
		expect(extraCellsNote(three, 1, false)).toEqual({
			label: "+2",
			title: "2 more cells in this row than the table has columns: 2 | `x\\|y`. Use Raw to edit them.",
		});
	});

	test("no mark for a row that fits, for the header, or for a row whose further cells are all empty", () => {
		expect(extraCellsNote(table, 0, false)).toBeNull();
		expect(extraCellsNote(table, 1, false)).toBeNull();
		expect(extraCellsNote(parseTableRaw("| A |\n|---|\n| 1 | | |")!, 1, false)).toBeNull();
		expect(extraCellsNote(parseTableRaw("| A |\n|---|\n| 1 |")!, 1, false)).toBeNull();
	});

	test("it is drawn in the row's last cell and styled by the editor's theme (read from the source: it needs a DOM)", () => {
		const widget = source("src/view/editor/cmLiveTable.ts");
		const draw = widget.slice(widget.indexOf("const renderCellDisplay ="), widget.indexOf("const renderHoverBar ="));
		expect(draw).toContain("Number(cellEl.dataset.col) === ctrl.table.alignments.length - 1");
		expect(draw).toContain("extraCellsNote(ctrl.table, Number(cellEl.dataset.row), ctrl.readMode)");
		expect(draw).toContain('note.className = "cm-tbl-extra"');
		expect(source("src/view/editor/cmLivePlugin.ts")).toContain('".cm-tbl-extra": {');
	});
});
