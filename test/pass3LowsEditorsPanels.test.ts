// The low findings of the pass 3 audit in the editors and the panels: the live Markdown editor's pictures and
// folds, a file dropped on SSL, the language server's edits, a UTF-16 file dropped on the Explorer, the pattern for
// a folder to search in, and the Output following what is written. Each test runs the code it names.
//
// Bun has no DOM. What CodeMirror does with a widget's element is tested as what CodeMirror asks (whether two
// widgets are the same one, by the comparison its own view runs), and a picture's buttons are run against
// stand-in elements. The drop on code and the Output's scrolling are tested as the decisions they are made of.
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, RangeSet, type Transaction } from "@codemirror/state";
import * as oniguruma from "vscode-oniguruma";
import { Registry } from "vscode-textmate";
import { droppedFileNote, extractCommentSpans, findCommentDocRefsInSpans, writtenInComment } from "../src/shared/editorDocHelpers";
import { createFileFilter, folderPattern, globMatcher, literalPattern, patternsOf } from "../src/shared/fileGlob";
import { looksBinary, utf16Kind } from "../src/shared/fileKind";
import { applyTextEdits } from "../src/view/lsp/edits";

// --- The same headless window and Monaco stand-ins as r8bPanelsAndMenus.test.ts, so the view's modules load under bun ---
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

const { liveBlockField, liveCallbacksFacet, widgetRangeNow } = await import("../src/view/editor/cmLivePlugin");
const { sslCommentSpans } = await import("../src/view/editor/textmate");
const { decodeDroppedText } = await import("../src/view/panels/Explorer");
const { endFollower } = await import("../src/view/panels/Problems");

// --- 1. The live Markdown editor: a picture and a fold keep what was drawn for them --------------------------

/** A document in the live editor, as its block decorations are built: the cursor on the first line. */
const liveState = (doc: string, callbacks: Record<string, unknown> = {}, cursor = 0) =>
	EditorState.create({
		doc,
		selection: EditorSelection.cursor(cursor),
		extensions: [markdown({ base: markdownLanguage }), liveCallbacksFacet.of({ filePath: () => "/w/docs/note.md", ...callbacks } as any), liveBlockField],
	});

/** The block widgets of one kind in a document, with where they stand. */
function widgetsOf(state: EditorState, kind: string): { from: number; to: number; widget: any }[] {
	const out: { from: number; to: number; widget: any }[] = [];
	state.field(liveBlockField).between(0, state.doc.length, (from, to, deco) => {
		if (deco.spec.widget?.constructor.name === kind) out.push({ from, to, widget: deco.spec.widget });
	});
	return out;
}

/**
 * Where CodeMirror draws again for a transaction because a decoration is not what it was: the comparison its view
 * runs (`findChangedDeco`), with every difference it is told of kept. Places are in the new document.
 */
function redrawn(before: EditorState, tr: Transaction): [number, number][] {
	const out: [number, number][] = [];
	RangeSet.compare([before.field(liveBlockField)], [tr.state.field(liveBlockField)], tr.changes, {
		compareRange: (from, to) => void out.push([from, to]),
		comparePoint: (from, to) => void out.push([from, to]),
		boundChange: (pos) => void out.push([pos, pos]),
	});
	return out;
}

/** An element that keeps what is put in it and what listens on it, in place of the browser's. */
class StandInElement {
	readonly children: StandInElement[] = [];
	readonly listeners = new Map<string, ((event: any) => void)[]>();
	readonly style: Record<string, string> = {};
	readonly classList = { add() {}, remove() {} };
	isConnected = true;
	className = "";
	textContent = "";
	title = "";
	constructor(readonly tag: string) {}
	appendChild(child: StandInElement) {
		this.children.push(child);
		return child;
	}
	prepend(child: StandInElement) {
		this.children.unshift(child);
	}
	remove() {}
	setAttribute() {}
	closest() {
		return null;
	}
	getBoundingClientRect() {
		return { width: 400 };
	}
	addEventListener(type: string, listener: (event: any) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	/** The mouse goes down on it. */
	press() {
		for (const listener of this.listeners.get("mousedown") ?? []) listener({ button: 0, target: this, preventDefault() {}, stopPropagation() {} });
	}
	within(): StandInElement[] {
		return [this, ...this.children.flatMap((child) => child.within())];
	}
}

/** Runs `draw` with the document making stand-in elements. */
function withStandInElements<T>(draw: () => T): T {
	const doc = (globalThis as any).document;
	const real = doc.createElement;
	doc.createElement = (tag: string) => new StandInElement(tag);
	try {
		return draw();
	} finally {
		doc.createElement = real;
	}
}

describe("the live editor's pictures", () => {
	const PICTURE = "![Chart](https://example.test/chart.png)";
	const doc = `Intro\n\n${PICTURE}\n\nAfter\n`;

	test("a picture is the same widget after a letter is typed on a line above it, and after a line is added there", () => {
		const before = liveState(doc);
		const [drawn] = widgetsOf(before, "ImageWidget");
		expect(before.sliceDoc(drawn!.from, drawn!.to)).toBe(PICTURE);

		for (const typed of ["x", "A new line\n", "\n\n"]) {
			const tr = before.update({ changes: { from: 0, insert: typed } });
			const [moved] = widgetsOf(tr.state, "ImageWidget");
			// It did move, and it is not the object it was: only what `eq` says keeps its element.
			expect(moved!.from).toBe(drawn!.from + typed.length);
			expect(moved!.widget).not.toBe(drawn!.widget);
			expect(moved!.widget.eq(drawn!.widget)).toBe(true);
			// And so CodeMirror finds nothing to draw again: before, it drew the picture again at each letter.
			expect(redrawn(before, tr)).toEqual([]);
		}
	});

	test("an inline picture is the same widget wherever it stands, by the same rule", () => {
		// The block field does not build inline pictures (the view's plugin does, and needs a view): the class is the
		// one both use, so its `eq` is asked of two of them that differ in nothing a block picture's does not.
		const a = widgetsOf(liveState(doc), "ImageWidget")[0]!.widget;
		const b = widgetsOf(liveState(`One\nTwo\nThree\n\n${PICTURE}\n`), "ImageWidget")[0]!.widget;
		expect(b.eq(a)).toBe(true);
	});

	test("a picture that changed is another widget, and is drawn again", () => {
		const before = liveState(doc);
		const [drawn] = widgetsOf(before, "ImageWidget");
		// Its width is set: the Markdown between the brackets grows.
		const at = drawn!.from + "![Chart".length;
		const tr = before.update({ changes: { from: at, insert: "|320" } });
		const [resized] = widgetsOf(tr.state, "ImageWidget");
		expect(tr.state.sliceDoc(resized!.from, resized!.to)).toBe("![Chart|320](https://example.test/chart.png)");
		expect(resized!.widget.eq(drawn!.widget)).toBe(false);
		expect(redrawn(before, tr).length).toBeGreaterThan(0);
		// Another picture, or the same one with a longer way of writing it, is another widget too.
		const other = widgetsOf(liveState(`Intro\n\n![Chart](https://example.test/other.png)\n`), "ImageWidget")[0]!.widget;
		expect(other.eq(drawn!.widget)).toBe(false);
		const spaced = widgetsOf(liveState(`Intro\n\n${PICTURE}  \n`), "ImageWidget")[0]!.widget;
		expect(spaced.eq(drawn!.widget)).toBe(false);
	});

	test("the element drawn for a picture acts where the picture stands when it is used, not where it stood when drawn", () => {
		const resized: [number, number, number | null][] = [];
		const before = liveState(doc, { onResizeImage: (from: number, to: number, width: number | null) => void resized.push([from, to, width]) });
		const [drawn] = widgetsOf(before, "ImageWidget");
		const dispatched: any[] = [];
		const asked: unknown[] = [];
		let whereNow = drawn!.from;
		const view: any = {
			state: before,
			posAtDOM: (dom: unknown) => (asked.push(dom), whereNow),
			focus() {},
			dispatch: (spec: unknown) => void dispatched.push(spec),
		};
		const wrap = withStandInElements(() => drawn!.widget.toDOM(view)) as StandInElement;
		const button = (label: string) => wrap.within().find((el) => el.tag === "button" && el.textContent === label)!;

		// Two lines are added above. The widget for the new place is the same one, so the element stays as drawn.
		const tr = before.update({ changes: { from: 0, insert: "First\nSecond\n" } });
		const [moved] = widgetsOf(tr.state, "ImageWidget");
		expect(moved!.widget.eq(drawn!.widget)).toBe(true);
		view.state = tr.state;
		whereNow = moved!.from;

		button("320").press();
		expect(resized).toEqual([[moved!.from, moved!.to, 320]]);
		expect(tr.state.sliceDoc(resized[0]![0], resized[0]![1])).toBe(PICTURE);
		// What the old place holds now is not the picture: written there, the width went into another line.
		expect(tr.state.sliceDoc(drawn!.from, drawn!.to)).not.toBe(PICTURE);

		button("Edit").press();
		wrap.press();
		expect(dispatched.map((spec) => spec.selection.head)).toEqual([moved!.from, moved!.from]);
		// Where it stands is asked of the element that was drawn.
		expect(asked.every((dom) => dom === wrap)).toBe(true);
	});

	test("where a widget's source stands now is read from where its element is, and kept inside the document", () => {
		const view = (pos: number, length: number): any => ({ posAtDOM: () => pos, state: { doc: { length } } });
		const dom = {} as HTMLElement;
		expect(widgetRangeNow(view(17, 100), dom, 40)).toEqual({ from: 17, to: 57 });
		// A document cut short under it gives a place that is still in it.
		expect(widgetRangeNow(view(17, 30), dom, 40)).toEqual({ from: 17, to: 30 });
		expect(widgetRangeNow(view(50, 30), dom, 40)).toEqual({ from: 30, to: 30 });
	});
});

describe("the live editor's folds (<details>)", () => {
	const fold = (summary: string, body = "The courier came on Tuesday.") => `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
	const doc = `Intro\n\n${fold("Why it is late")}\n\nAfter\n`;

	test("a fold is the same widget, kept under the same name, after a line is added above it", () => {
		const before = liveState(doc);
		const [drawn] = widgetsOf(before, "DetailsWidget");
		expect(before.sliceDoc(drawn!.from, drawn!.to)).toBe(fold("Why it is late"));

		for (const typed of ["x", "A new line\n"]) {
			const tr = before.update({ changes: { from: 0, insert: typed } });
			const [moved] = widgetsOf(tr.state, "DetailsWidget");
			expect(moved!.from).toBe(drawn!.from + typed.length);
			// The element stays (and with it whether the fold is open) ...
			expect(moved!.widget.eq(drawn!.widget)).toBe(true);
			expect(redrawn(before, tr)).toEqual([]);
			// ... and a fold drawn afresh, scrolled away and back, finds what was kept: the name had the line in it.
			expect(moved!.widget.openStateKey).toBe(drawn!.widget.openStateKey);
		}
	});

	test("two folds with one summary are kept apart, and a fold with another summary above renames neither", () => {
		const twice = `Intro\n\n${fold("Notes")}\n\nBetween\n\n${fold("Notes")}\n\nAfter\n`;
		const [first, second] = widgetsOf(liveState(twice), "DetailsWidget");
		expect(first!.widget.openStateKey).not.toBe(second!.widget.openStateKey);
		// The same in all but which of the two it is: not the same widget, or one would be drawn in the other's element.
		expect(second!.widget.eq(first!.widget)).toBe(false);

		const withOther = `Intro\n\n${fold("Something else")}\n\n${twice.slice("Intro\n\n".length)}`;
		const [, firstAgain, secondAgain] = widgetsOf(liveState(withOther), "DetailsWidget");
		expect(firstAgain!.widget.openStateKey).toBe(first!.widget.openStateKey);
		expect(secondAgain!.widget.openStateKey).toBe(second!.widget.openStateKey);
	});

	test("the cursor in the first of two folds with one summary does not rename the second", () => {
		const twice = `Intro\n\n${fold("Notes")}\n\nBetween\n\n${fold("Notes")}\n\nAfter\n`;
		const [, second] = widgetsOf(liveState(twice), "DetailsWidget");
		// The first is shown as its Markdown while the cursor is in it, and is no widget then.
		const inFirst = widgetsOf(liveState(twice, {}, twice.indexOf("<details>") + 3), "DetailsWidget");
		expect(inFirst.length).toBe(1);
		expect(inFirst[0]!.widget.openStateKey).toBe(second!.widget.openStateKey);
	});

	test("a fold whose text changed is another widget", () => {
		const [drawn] = widgetsOf(liveState(doc), "DetailsWidget");
		const [other] = widgetsOf(liveState(`Intro\n\n${fold("Why it is late", "The courier came on Friday.")}\n\nAfter\n`), "DetailsWidget");
		expect(other!.widget.eq(drawn!.widget)).toBe(false);
	});
});

// --- 2. A file dropped on SSL or SQL code ---------------------------------------------------------------------

const wasm = readFileSync(join(import.meta.dir, "../src/view/public/onig.wasm"));
await oniguruma.loadWASM({ data: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
const rawGrammar = JSON.parse(readFileSync(join(import.meta.dir, "../src/view/public/grammar/ssl.tmLanguage.json"), "utf8"));
const registry = new Registry({
	onigLib: Promise.resolve({
		createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
		createOnigString: (text) => new oniguruma.OnigString(text),
	}),
	loadGrammar: async (scope) => (scope === "source.ssl" ? rawGrammar : null),
});
const sslGrammar = (await registry.loadGrammar("source.ssl"))!;
/** The comments of SSL lines as the grammar the editor colours with reads them. */
const sslSpans = (lines: readonly string[]) => sslCommentSpans(lines, sslGrammar);
const sqlSpans = (lines: readonly string[]) => extractCommentSpans(lines);
/** Whether what is dropped at `|` in the last of the lines lands in a comment. */
const inComment = (spansOf: typeof sslSpans, ...lines: string[]) => {
	const last = lines.at(-1)!;
	const offset = last.indexOf("|");
	return writtenInComment(lines.slice(0, -1), last.replace("|", ""), offset, spansOf);
};

describe("what a file dropped on code leaves there", () => {
	test("in SSL code, a comment that ends where an SSL comment ends: at its semicolon", () => {
		const note = droppedFileNote("docs/specs/due-dates.md", "ssl", false);
		expect(note).toBe("/* See docs/specs/due-dates.md;");
		// The grammar reads all of it as comment, and the line after it as code.
		expect(sslSpans([note!, "nDays := 3;"])).toEqual([[{ from: 0, to: note!.length }], []]);
		// What was written before: the comment ended at the semicolon and " */" was left as code.
		const was = "/* See docs/specs/due-dates.md; */";
		expect(sslSpans([was])![0]).toEqual([{ from: 0, to: was.indexOf(";") + 1 }]);
	});

	test("in SQL code, a comment closed as SQL closes one", () => {
		expect(droppedFileNote("docs/specs/due-dates.md", "sql", false)).toBe("/* See docs/specs/due-dates.md */");
	});

	test("inside a comment, the path alone", () => {
		expect(droppedFileNote("docs/specs/due-dates.md", "ssl", true)).toBe("docs/specs/due-dates.md");
		expect(droppedFileNote("docs/specs/due-dates.md", "sql", true)).toBe("docs/specs/due-dates.md");
	});

	test("nothing, where the path has in it what ends a comment", () => {
		// In SSL the comment would end at the path's own semicolon, in or out of a comment, and the rest would be code.
		expect(droppedFileNote("docs/a;b.md", "ssl", false)).toBeNull();
		expect(droppedFileNote("docs/a;b.md", "ssl", true)).toBeNull();
		expect(droppedFileNote("docs/a;b.md", "sql", false)).toBe("/* See docs/a;b.md */");
		expect(droppedFileNote("odd*/name.md", "sql", false)).toBeNull();
		expect(droppedFileNote("odd*/name.md", "ssl", false)).toBe("/* See odd*/name.md;");
	});
});

describe("whether a drop lands in a comment", () => {
	test("in SSL it is the grammar's to say", () => {
		expect(inComment(sslSpans, "/* The day limit | and the priorities;")).toBe(true);
		expect(inComment(sslSpans, "nDays := 3; /* why |three;")).toBe(true);
		expect(inComment(sslSpans, "nDays := |3;")).toBe(false);
		// A comment left open on a line above.
		expect(inComment(sslSpans, "/* Each skip is a pair.", "   A caller tests |the code;")).toBe(true);
		expect(inComment(sslSpans, "/* Each skip is a pair.", "   A caller tests the code;", "nDays := |3;")).toBe(false);
		// An SSL comment does not end at "*/", and "//" does not start one: the scanner written here said otherwise.
		expect(inComment(sslSpans, "/* a */ still a |comment;")).toBe(true);
		expect(inComment(sslSpans, "// not a comment |in SSL")).toBe(false);
		// Inside a string, the mark that opens a comment opens none.
		expect(inComment(sslSpans, 'sText := "/* not a |comment";')).toBe(false);
	});

	test("the place just after a comment's end, and just before its start, is code", () => {
		// Both counted as inside the comment, and the path alone was written into code.
		expect(inComment(sslSpans, "/* done;|")).toBe(false);
		expect(inComment(sslSpans, "/* done;| nDays := 3;")).toBe(false);
		expect(inComment(sslSpans, "|/* done;")).toBe(false);
		expect(inComment(sslSpans, "nDays := 3; |/* why three;")).toBe(false);
		// The end of a line whose comment goes on is inside it.
		expect(inComment(sslSpans, "/* goes on|")).toBe(true);
		expect(inComment(sqlSpans, "SELECT 1 /* why */|")).toBe(false);
		expect(inComment(sqlSpans, "SELECT 1 |-- why")).toBe(false);
	});

	test("in SQL, by SQL's comments", () => {
		expect(inComment(sqlSpans, "SELECT 1 -- the first |row")).toBe(true);
		expect(inComment(sqlSpans, "SELECT 1 /* the first |row */ FROM T")).toBe(true);
		expect(inComment(sqlSpans, "/* a note", "that goes |on */")).toBe(true);
		expect(inComment(sqlSpans, "SELECT |1 FROM T")).toBe(false);
		expect(inComment(sqlSpans, "SELECT '-- not a |comment' FROM T")).toBe(false);
	});

	test("where nothing can say (the grammar is not loaded), it is taken for code", () => {
		expect(writtenInComment([], "/* a note;", 5, () => null)).toBe(false);
	});
});

// --- 3. The language server's edits at one position -----------------------------------------------------------

describe("document references in SSL comments, the comments read by the grammar", () => {
	const docs = [
		{ path: "/ws/docs/tickets/DEMO-101.md", name: "DEMO-101.md", group: "tickets", exists: true, ticket: "DEMO-101" },
		{ path: "/ws/docs/specs/due-dates.md", name: "due-dates.md", group: "specs", exists: true },
		{ path: "/ws/design/due-dates.plan.json", name: "due-dates.plan.json", group: "plans", exists: true },
		{ path: "/ws/schema/database/DEMO_HOLIDAYS.md", name: "DEMO_HOLIDAYS.md", group: "schema", exists: true },
		{ path: "/ws/docs/knowledge/decisions/0001-utc-dates.md", name: "decisions/0001-utc-dates.md", group: "knowledge", kind: "decisions", exists: true },
	] as Parameters<typeof findCommentDocRefsInSpans>[2];

	test("paths and wikilinks are found in comments, not in strings, and not after a line the grammar does not read as a comment", () => {
		const lines = [
			'sIgnored := "docs/specs/due-dates.md [[DEMO-101]]";',
			"/* Implements docs/specs/due-dates.md#holidays and [[DEMO-101]];",
			"/*",
			" * Plan: design/due-dates.plan.json",
			" * Schema: schema/database/DEMO_HOLIDAYS.md#L5-L18",
			" * ADR: [[0001-utc-dates|UTC rule]]",
			" * Missing: docs/specs/does-not-exist.md",
			";",
			// Two slashes open no comment in SSL: what follows them is code, and is not searched.
			"// Not a comment: [[DEMO_HOLIDAYS#Columns]]",
			"/* Inline check: [[DEMO_HOLIDAYS#Columns]];",
		];
		const refs = findCommentDocRefsInSpans(lines, sslSpans(lines)!, docs, "/ws");
		expect(refs.map((r) => [r.line, r.kind, r.doc.name, r.heading ?? null, r.targetLine ?? null, r.targetEndLine ?? null])).toEqual([
			[2, "wikilink", "DEMO-101.md", null, null, null],
			[2, "path", "due-dates.md", "holidays", null, null],
			[4, "path", "due-dates.plan.json", null, null, null],
			[5, "path", "DEMO_HOLIDAYS.md", null, 5, 18],
			[6, "wikilink", "decisions/0001-utc-dates.md", null, null, null],
			[10, "wikilink", "DEMO_HOLIDAYS.md", "Columns", null, null],
		]);
		// Each reference is at its own place in its line, without the semicolon that ends the comment.
		for (const r of refs) {
			expect(lines[r.line - 1]!.slice(r.from, r.to)).toBe(r.raw);
			expect(r.raw.endsWith(";")).toBe(false);
		}
	});
});

describe("several edits at one position", () => {
	const at = (line: number, character: number) => ({ line, character });
	const insert = (line: number, character: number, newText: string) => ({ range: { start: at(line, character), end: at(line, character) }, newText });
	const replace = (line: number, from: number, to: number, newText: string) => ({ range: { start: at(line, from), end: at(line, to) }, newText });

	test("two inserts come out in the order they are listed", () => {
		expect(applyTextEdits("x", [insert(0, 0, "A"), insert(0, 0, "B")])).toBe("ABx");
		expect(applyTextEdits("x", [insert(0, 0, "B"), insert(0, 0, "A")])).toBe("BAx");
		expect(applyTextEdits("ab\ncd", [insert(1, 1, "1"), insert(1, 1, "2")])).toBe("ab\nc12d");
	});

	test("three inserts do", () => {
		expect(applyTextEdits("x", [insert(0, 1, "A"), insert(0, 1, "B"), insert(0, 1, "C")])).toBe("xABC");
		expect(applyTextEdits("x", [insert(0, 0, "C"), insert(0, 0, "A"), insert(0, 0, "B")])).toBe("CABx");
	});

	test("an insert where a replacement starts stands before what replaces", () => {
		expect(applyTextEdits("abc", [insert(0, 0, "I"), replace(0, 0, 2, "R")])).toBe("IRc");
		expect(applyTextEdits("abc", [insert(0, 0, "I"), insert(0, 0, "J"), replace(0, 0, 2, "R")])).toBe("IJRc");
		// Listed the other way round the insert still stands before it: the replaced text is all taken out, once.
		expect(applyTextEdits("abc", [replace(0, 0, 2, "R"), insert(0, 0, "I")])).toBe("IRc");
	});

	test("with edits elsewhere among them, each still lands in its place", () => {
		const edits = [insert(1, 0, "  "), replace(0, 0, 1, "A"), insert(1, 0, "/* "), insert(0, 2, "!"), insert(1, 2, ";")];
		expect(applyTextEdits("ab\ncd", edits)).toBe("Ab!\n  /* cd;");
	});

	test("inserts at one clamped position, past the end of the text, keep their order too", () => {
		expect(applyTextEdits("ab", [insert(5, 0, "X"), insert(9, 3, "Y")])).toBe("abXY");
	});
});

// --- 4. A UTF-16 file dropped on the Explorer -----------------------------------------------------------------

describe("text dropped on the Explorer, read as what it is written in", () => {
	const NOT_TEXT = "binary files other than images and .docx cannot be dropped here";
	const le = (text: string, mark = true) => new Uint8Array([...(mark ? [0xff, 0xfe] : []), ...Buffer.from(text, "utf16le")]);
	const be = (text: string, mark = true) => new Uint8Array([...(mark ? [0xfe, 0xff] : []), ...Buffer.from(text, "utf16le").swap16()]);
	/** What the Explorer does with a dropped file that is no picture, page or Word document: the text it writes, or the refusal. */
	const dropped = (bytes: Uint8Array) => {
		if (looksBinary(bytes)) return { refused: NOT_TEXT };
		try {
			return { text: decodeDroppedText(bytes) };
		} catch (e: any) {
			return { refused: String(e?.message ?? e) };
		}
	};
	const text = "SELECT * FROM ORDERS;\r\n-- café, Größe, 5 € and a 😀\r\n";

	test("UTF-16 with its mark, either way round: the right characters, and no mark left at the start", () => {
		expect(dropped(le(text))).toEqual({ text });
		expect(dropped(be(text))).toEqual({ text });
		// What it gave before: the mark as two letters, and a NUL beside each character.
		expect(new TextDecoder("windows-1252").decode(le("AB"))).toBe("ÿþA\u0000B\u0000");
	});

	test("UTF-8 with its mark: the mark is not part of the text", () => {
		const marked = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
		expect(dropped(marked)).toEqual({ text });
		expect(dropped(marked).text!.charCodeAt(0)).not.toBe(0xfeff);
	});

	test("UTF-16 with no mark, where it is plain letters: read the way round its zero bytes stand", () => {
		const plain = ":PROCEDURE DueSoon;\r\n:RETURN 3;\r\n:ENDPROC;\r\n";
		expect(utf16Kind(le(plain, false))).toBe("utf-16le");
		expect(utf16Kind(be(plain, false))).toBe("utf-16be");
		expect(dropped(le(plain, false))).toEqual({ text: plain });
		expect(dropped(be(plain, false))).toEqual({ text: plain });
		// Letters with marks, and a few characters with no zero byte at all, do not change that.
		const marked = "-- café, Größe, 5 € a row\r\nSELECT * FROM ORDERS;\r\n";
		expect(dropped(le(marked, false))).toEqual({ text: marked });
		expect(dropped(be(marked, false))).toEqual({ text: marked });
	});

	test("UTF-16 with no mark whose zero bytes stand on both sides is bytes, as it was", () => {
		// The second half of this face is DE00: its zero byte stands on the other side from the letters'.
		expect(utf16Kind(le(text, false))).toBeNull();
		expect(dropped(le(text, false))).toEqual({ refused: NOT_TEXT });
	});

	test("UTF-16 with no mark that is not plain letters cannot be told from bytes, and is refused as they are", () => {
		const greek = le("Καλημέρα κόσμε, τι κάνεις σήμερα;", false);
		expect(utf16Kind(greek)).toBeNull();
		expect(dropped(greek)).toEqual({ refused: NOT_TEXT });
	});

	test("which way round, by the mark first", () => {
		expect(utf16Kind(le("A"))).toBe("utf-16le");
		expect(utf16Kind(be("A"))).toBe("utf-16be");
		expect(utf16Kind(new TextEncoder().encode("plain text"))).toBeNull();
		expect(utf16Kind(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBeNull();
		expect(utf16Kind(new Uint8Array())).toBeNull();
		// The mark of UTF-32 opens as that of UTF-16 does.
		expect(utf16Kind(new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]))).toBeNull();
	});

	test("bytes that are not text are still refused", () => {
		// A picture's bytes under another name, and UTF-32.
		expect(dropped(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48]))).toEqual({ refused: NOT_TEXT });
		expect(dropped(new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]))).toEqual({ refused: NOT_TEXT });
		// Bytes that open as UTF-16 does and do not read as it: a byte left over, half a pair, a NUL.
		expect(dropped(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42]))).toEqual({ refused: NOT_TEXT });
		expect(dropped(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x00, 0xd8, 0x42, 0x00]))).toEqual({ refused: NOT_TEXT });
		expect(dropped(new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0x00, 0x00, 0x42]))).toEqual({ refused: NOT_TEXT });
		// The page a .html file is turned from is read by the same function, which says so itself.
		expect(() => decodeDroppedText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42]))).toThrow(NOT_TEXT);
	});

	test("UTF-8 and the one-byte Windows encoding are read as before", () => {
		expect(dropped(new TextEncoder().encode("Temp: 25°C, café"))).toEqual({ text: "Temp: 25°C, café" });
		expect(dropped(new Uint8Array([0x32, 0x35, 0xb0, 0x43, 0x20, 0xe9]))).toEqual({ text: "25°C é" });
		expect(dropped(new Uint8Array())).toEqual({ text: "" });
	});
});

// --- 5. The pattern for a folder to search in -----------------------------------------------------------------

describe("the pattern a folder is searched by", () => {
	/** Whether a search in `folder` looks in the file. */
	const searches = (folder: string, file: string) => createFileFilter(folderPattern(folder), "")(file);

	test("a folder whose name opens with a dot keeps the dot", () => {
		expect(folderPattern(".github")).toBe(".github/**");
		expect(searches(".github", ".github/workflows/build.yml")).toBe(true);
		expect(searches(".github", "github/notes.md")).toBe(false);
		expect(searches("docs/.drafts", "docs/.drafts/a.md")).toBe(true);
		expect(searches("docs/.drafts", "docs/drafts/a.md")).toBe(false);
		expect(searches("..archive", "..archive/a.md")).toBe(true);
	});

	test("a comma in a folder's name is that character, and does not part two patterns", () => {
		expect(patternsOf(folderPattern("docs/a,b"))).toEqual(["docs/a[,]b/**"]);
		expect(searches("docs/a,b", "docs/a,b/note.md")).toBe(true);
		// Written straight in, it was "docs/a" and "b/**": the folder's own files were left out and b's taken in.
		expect(searches("docs/a,b", "docs/a/note.md")).toBe(false);
		expect(searches("docs/a,b", "b/note.md")).toBe(false);
	});

	test("braces in a folder's name are those characters, and not a choice", () => {
		expect(searches("src/{x}", "src/{x}/a.ssl")).toBe(true);
		expect(searches("src/{x}", "src/x/a.ssl")).toBe(false);
		expect(searches("src/{a,b}", "src/{a,b}/a.ssl")).toBe(true);
		expect(searches("src/{a,b}", "src/a/a.ssl")).toBe(false);
		expect(searches("half{open", "half{open/a.ssl")).toBe(true);
	});

	test("so are a star, a question mark, square brackets and a space at the start", () => {
		expect(searches("a*b", "a*b/f.ssl")).toBe(true);
		expect(searches("a*b", "axb/f.ssl")).toBe(false);
		expect(searches("what?", "what?/f.ssl")).toBe(true);
		expect(searches("what?", "whats/f.ssl")).toBe(false);
		expect(folderPattern("src/[old]")).toBe("src/[old]/**");
		expect(searches("src/[old]", "src/[old]/f.ssl")).toBe(true);
		// Brackets that would read as a mark written as itself.
		expect(searches("[,]", "[,]/f.ssl")).toBe(true);
		expect(searches("[,]", ",/f.ssl")).toBe(false);
		expect(searches("x[*]y", "x[*]y/f.ssl")).toBe(true);
		expect(searches("x[*]y", "x*y/f.ssl")).toBe(false);
		expect(searches(" notes", " notes/f.md")).toBe(true);
		expect(searches(" notes", "notes/f.md")).toBe(false);
	});

	test("it is that folder from the workspace's folder, and all that is in it", () => {
		expect(searches("src", "src/a.ssl")).toBe(true);
		expect(searches("src", "src/deep/er/a.ssl")).toBe(true);
		expect(searches("src", "tests/src/a.ssl")).toBe(false);
		expect(searches("src", "srcs/a.ssl")).toBe(false);
		expect(folderPattern("src\\DueDates\\")).toBe("src/DueDates/**");
		expect(folderPattern("./src/")).toBe("src/**");
	});

	test("the workspace's own folder needs no pattern", () => {
		expect(folderPattern("")).toBe("");
		expect(folderPattern(".")).toBe("");
		expect(folderPattern("./")).toBe("");
	});

	test("it stands in a list with other patterns as one of them", () => {
		const filter = createFileFilter(`*.md, ${folderPattern("docs/a,b {x}")}, tests`, "");
		expect(filter("docs/a,b {x}/data.csv")).toBe(true);
		expect(filter("readme.md")).toBe(true);
		expect(filter("tests/a.ssl")).toBe(true);
		expect(filter("docs/a/data.csv")).toBe(false);
		expect(filter("b {x}/data.csv")).toBe(false);
	});

	test("any folder's name is searched as itself and as no other", () => {
		let seed = 99;
		const next = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
		const marks = ["a", "b", ",", "{", "}", "*", "?", "[", "]", " ", ".", "-", "(", ")", "+", "^", "$", "|"];
		const name = () => Array.from({ length: 1 + next(6) }, () => marks[next(marks.length)]).join("");
		const problems: string[] = [];
		let pairs = 0;
		for (let i = 0; i < 20000 && problems.length < 5; i++) {
			const a = name();
			const b = next(3) ? name() : a;
			// "." and ".." are not names a folder has.
			if (/^\.\.?$/.test(a) || /^\.\.?$/.test(b)) continue;
			pairs++;
			if (searches(a, `${b}/f.ssl`) !== (a.toLowerCase() === b.toLowerCase())) problems.push(`${JSON.stringify(a)} searched ${JSON.stringify(b)}`);
			if (patternsOf(`${folderPattern(a)}, other`).length !== 2) problems.push(`${JSON.stringify(a)} is not one pattern`);
			if (!globMatcher(literalPattern(a))(`deep/${a}`)) problems.push(`${JSON.stringify(a)} is not found by its name`);
		}
		expect(problems).toEqual([]);
		expect(pairs).toBeGreaterThan(15000);
	});
});

// --- 6. A slash at the end of a pattern is a slash ------------------------------------------------------------

describe("a pattern with a slash is read from the workspace's folder, wherever the slash is", () => {
	test("a slash at the end", () => {
		const src = globMatcher("src/");
		expect(src("src/a.ssl")).toBe(true);
		expect(src("src/deep/a.ssl")).toBe(true);
		// It was a folder named src wherever it is, as "src" is, against the rule the file opens with.
		expect(src("tests/src/a.ssl")).toBe(false);
		expect(globMatcher("src\\")("tests/src/a.ssl")).toBe(false);
	});

	test("a dot and a slash at the start", () => {
		expect(globMatcher("./src")("src/a.ssl")).toBe(true);
		expect(globMatcher("./src")("tests/src/a.ssl")).toBe(false);
		expect(globMatcher("./*.md")("README.md")).toBe(true);
		expect(globMatcher("./*.md")("docs/README.md")).toBe(false);
	});

	test("with no slash it is still a name, wherever it is", () => {
		expect(globMatcher("src")("tests/src/a.ssl")).toBe(true);
		expect(globMatcher("src")("src/a.ssl")).toBe(true);
		expect(globMatcher("*.md")("docs/README.md")).toBe(true);
	});

	test("in a list, each pattern by its own slash", () => {
		const filter = createFileFilter("tests/", "legacy");
		expect(filter("tests/a.ssl")).toBe(true);
		expect(filter("src/tests/a.ssl")).toBe(false);
		expect(filter("tests/legacy/a.ssl")).toBe(false);
	});
});

// --- 7. The Output follows what is written --------------------------------------------------------------------

describe("the Output keeps to its end", () => {
	/** A view 200 high over what is written, scrolled to its end. */
	const atItsEnd = (written: number) => ({ scrollHeight: written, scrollTop: written - 200, clientHeight: 200 });

	test("through an entry of three rows or more", () => {
		const end = endFollower();
		const box = atItsEnd(1000);
		end.scrolled(box);
		expect(end.following()).toBe(true);
		// An entry of three rows arrives: what is written is taller, and nothing was scrolled.
		box.scrollHeight += 51;
		// Measured now, the end is further off than counts as near. That is what was asked, and why it stopped.
		expect(box.scrollHeight - box.scrollTop - box.clientHeight).toBeGreaterThanOrEqual(40);
		expect(end.following()).toBe(true);
		// The view is taken to its end, which is a scroll, and the next entry is followed as well.
		box.scrollTop = box.scrollHeight - box.clientHeight;
		end.scrolled(box);
		box.scrollHeight += 170;
		expect(end.following()).toBe(true);
	});

	test("and not for someone who scrolled up to read", () => {
		const end = endFollower();
		const box = atItsEnd(1000);
		box.scrollTop = 300;
		end.scrolled(box);
		expect(end.following()).toBe(false);
		box.scrollHeight += 17;
		expect(end.following()).toBe(false);
		// Scrolled back to within reach of the end, it follows again.
		box.scrollTop = box.scrollHeight - box.clientHeight - 10;
		end.scrolled(box);
		expect(end.following()).toBe(true);
	});

	test("from when it is opened, before anything was scrolled", () => {
		expect(endFollower().following()).toBe(true);
	});
});
