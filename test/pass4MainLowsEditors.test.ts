// Four low findings of audit pass 4 that were on main before the branch, in the editors:
//
// B1-2. A file dragged from the Explorer could never be dropped on an editor: the source allowed one effect and
//       the target asked for another, and a browser fires no drop then.
// B1-4. A file dropped on code: past a line limit a drop into an SSL comment wrote a comment into the comment, and
//       on .pgsql and .mysql files the bare path was written into SQL code.
// B1-5. "Keep mine and save" in the review of a file that changed on disk wrote the text the review was opened
//       with, over whatever had been done to the document since, and did not look whether the save went through.
// B2-9. Moving the last section of a document in the outline took the document's closing lines with it, and a
//       file with both kinds of line end came back with one.
//
// What cannot be run here is said at each test. A real drag in a browser is one such thing: an event sent with
// `dispatchEvent` skips the rule that B1-2 is about, so what is tested is the table both sides read their words
// from, and that they read them from it. The review's choice runs in the real state module against a backend that
// is a function here, with Monaco and the dialogs replaced (the set-up of pass4LowsViewCore.test.ts, copied).
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChangeSet } from "@codemirror/state";
import { flush, snapshot } from "solid-js";
import * as oniguruma from "vscode-oniguruma";
import { Registry } from "vscode-textmate";
import {
	COMMENT_SCAN_LINES,
	DRAG_PAIRS,
	DRAG_TYPE,
	dragEffect,
	dropEffectFor,
	droppedFileNote,
	droppedInComment,
	droppedNoteLanguage,
	effectAllowedFor,
	extractCommentSpans,
	writtenInComment,
	type DragSource,
} from "../src/shared/editorDocHelpers";
import { frontMatter } from "../src/shared/frontMatter";
import { LANGUAGES } from "../src/shared/languages";
import { demoteMarkdownSection, markdownSectionTree, moveMarkdownSection, moveMarkdownSectionTo, promoteMarkdownSection, type MarkdownSection } from "../src/shared/outline";
import { DEFAULT_SETTINGS } from "../src/shared/protocol";

// --- Headless browser & Monaco shims (compatible superset of r2cEditorTabsState.test.ts / r8cStateKeysQuickPick.test.ts) ---
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
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5194" },
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
		activeElement: null,
		createElement: () => ({ style: {} }),
		querySelector: () => null,
	};
} else if (typeof (globalThis as any).document.querySelector !== "function") {
	(globalThis as any).document.querySelector = () => null;
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

type FakeModel = {
	uri: { scheme: string; fsPath: string; path: string; toString(): string };
	_value: string;
	_lang: string;
	_eol: "\n" | "\r\n";
	_version: number;
	_altVersion: number;
	_disposed: boolean;
	_changeListeners: Set<(e: any) => void>;
	_disposeListeners: Set<() => void>;
	getValue(): string;
	setValue(v: string): void;
	getEOL(): "\n" | "\r\n";
	setEOL(seq: number): void;
	getLanguageId(): string;
	getVersionId(): number;
	getAlternativeVersionId(): number;
	getLineCount(): number;
	getLineMaxColumn(line: number): number;
	getLineFirstNonWhitespaceColumn(line: number): number;
	getPositionAt(offset: number): { lineNumber: number; column: number };
	getFullModelRange(): any;
	getOptions(): { tabSize: number; insertSpaces: boolean };
	isDisposed(): boolean;
	pushStackElement(): void;
	pushEditOperations(_before: any[], edits: { range: any; text: string }[], _cursor: any): any;
	onDidChangeContent(cb: (e: any) => void): { dispose(): void };
	onWillDispose(cb: () => void): { dispose(): void };
	dispose(): void;
};

const fakeModels = new Map<string, FakeModel>();

const makeUri = (scheme: string, fsPath: string) => {
	const normalized = fsPath.replace(/\\/g, "/");
	const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
	return { scheme, fsPath, path: normalized, toString: () => raw };
};

const parseUri = (raw: string) => {
	if (raw.startsWith("file://")) return makeUri("file", raw.slice("file://".length));
	const colon = raw.indexOf(":");
	return colon >= 0 ? makeUri(raw.slice(0, colon), raw.slice(colon + 1)) : makeUri("file", raw);
};

class FakeRange {
	constructor(
		public startLineNumber: number,
		public startColumn: number,
		public endLineNumber: number,
		public endColumn: number,
	) {}
	static fromPositions(a: { lineNumber: number; column: number }, b: { lineNumber: number; column: number }) {
		return new FakeRange(a.lineNumber, a.column, b.lineNumber, b.column);
	}
}

function createFakeModel(text: string, lang: string, uri: ReturnType<typeof makeUri>): FakeModel {
	const key = uri.toString();
	const model: FakeModel = {
		uri,
		_value: text,
		_lang: lang,
		_eol: text.includes("\r\n") ? "\r\n" : "\n",
		_version: 1,
		_altVersion: 1,
		_disposed: false,
		_changeListeners: new Set(),
		_disposeListeners: new Set(),
		getValue() {
			return this._value;
		},
		setValue(v: string) {
			this._value = v;
			this._version++;
			this._altVersion++;
			for (const cb of [...this._changeListeners]) cb({ changes: [{ range: this.getFullModelRange(), rangeLength: 0, text: v }] });
		},
		getEOL() {
			return this._eol;
		},
		setEOL(seq: number) {
			const next = seq === 1 ? "\r\n" : "\n";
			if (this._eol !== next) {
				this._eol = next;
				this._value = this._value.replace(/\r?\n/g, next);
				this._version++;
				this._altVersion++;
			}
		},
		getLanguageId() {
			return this._lang;
		},
		getVersionId() {
			return this._version;
		},
		getAlternativeVersionId() {
			return this._altVersion;
		},
		getLineCount() {
			return this._value.split(/\r?\n/).length;
		},
		getLineMaxColumn(line: number) {
			const lines = this._value.split(/\r?\n/);
			return (lines[Math.max(0, Math.min(line - 1, lines.length - 1))]?.length ?? 0) + 1;
		},
		getLineFirstNonWhitespaceColumn(line: number) {
			const lines = this._value.split(/\r?\n/);
			const content = lines[Math.max(0, Math.min(line - 1, lines.length - 1))] ?? "";
			const idx = content.search(/\S/);
			return idx >= 0 ? idx + 1 : 0;
		},
		getPositionAt(offset: number) {
			const before = this._value.slice(0, Math.max(0, offset));
			const lines = before.split(/\r?\n/);
			return { lineNumber: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
		},
		getFullModelRange() {
			const lines = this._value.split(/\r?\n/);
			return new FakeRange(1, 1, lines.length, (lines[lines.length - 1]?.length ?? 0) + 1);
		},
		getOptions() {
			return { tabSize: 4, insertSpaces: false };
		},
		isDisposed() {
			return this._disposed;
		},
		pushStackElement() {},
		pushEditOperations(_before, edits) {
			const offsetOf = (line: number, col: number) => {
				const lines = this._value.split(this._eol);
				let off = 0;
				for (let i = 0; i < line - 1; i++) off += (lines[i]?.length ?? 0) + this._eol.length;
				return off + (col - 1);
			};
			for (const edit of edits) {
				const from = offsetOf(edit.range.startLineNumber, edit.range.startColumn);
				const to = offsetOf(edit.range.endLineNumber, edit.range.endColumn);
				this._value = this._value.slice(0, from) + edit.text + this._value.slice(to);
			}
			this._version++;
			this._altVersion++;
			for (const cb of [...this._changeListeners]) cb({ changes: edits.map((e) => ({ range: e.range, rangeLength: 0, text: e.text })) });
			return null;
		},
		onDidChangeContent(cb) {
			this._changeListeners.add(cb);
			return { dispose: () => void this._changeListeners.delete(cb) };
		},
		onWillDispose(cb) {
			this._disposeListeners.add(cb);
			return { dispose: () => void this._disposeListeners.delete(cb) };
		},
		dispose() {
			if (this._disposed) return;
			for (const cb of [...this._disposeListeners]) cb();
			this._disposed = true;
			fakeModels.delete(key);
		},
	};
	fakeModels.set(key, model);
	return model;
}

const noopProxy = (extra: Record<string, any> = {}) =>
	new Proxy(extra, { get: (target, prop) => (prop in target ? target[prop as any] : () => ({ dispose() {} })) });

mock.module("monaco-editor/editor/editor.api", () => ({
	Range: FakeRange,
	Position: class {
		constructor(
			public lineNumber: number,
			public column: number,
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
		parse: (s: string) => parseUri(s),
	},
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: {},
	languages: noopProxy({
		CompletionItemKind: { File: 1, Keyword: 2, Text: 3, Snippet: 4, Field: 5, Struct: 6 },
		SymbolKind: { Function: 11, Method: 5, Constructor: 8, Namespace: 2 },
		FoldingRangeKind: { Comment: "comment", Imports: "imports", Region: "region" },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
	}),
	editor: noopProxy({
		EndOfLineSequence: { LF: 0, CRLF: 1 },
		ScrollType: { Immediate: 1 },
		getEditors: () => [],
		getModel: (uri: { toString(): string }) => fakeModels.get(uri.toString()) ?? null,
		getModels: () => [...fakeModels.values()],
		createModel: (text: string, lang: string, uri: ReturnType<typeof makeUri>) => createFakeModel(text, lang, uri),
		setModelLanguage: (model: FakeModel, lang: string) => {
			model._lang = lang;
		},
		setModelMarkers: () => {},
		onDidCreateModel: () => ({ dispose() {} }),
		registerEditorOpener: () => ({ dispose() {} }),
	}),
}));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({
	default: class {},
}));
for (const lang of [
	"markdown",
	"sql",
	"yaml",
	"xml",
	"ini",
	"shell",
	"powershell",
	"bat",
	"javascript",
	"typescript",
	"html",
	"css",
	"scss",
	"less",
	"csharp",
	"vb",
	"razor",
	"pgsql",
	"mysql",
	"python",
	"java",
	"cpp",
	"php",
	"dockerfile",
	"graphql",
	"r",
	"perl",
	"ruby",
	"go",
	"rust",
	"fsharp",
]) {
	mock.module(`monaco-editor/languages/definitions/${lang}/register`, () => ({}));
}

let askHandler: (prompt: string, initial?: string) => Promise<string | null> | string | null = () => null;
let chooseHandler: (prompt: string, options?: string[]) => Promise<string | null> | string | null = () => null;
mock.module(resolve(import.meta.dir, "../src/view/dialogs.tsx"), () => ({
	ask: async (prompt: string, initial?: string) => askHandler(prompt, initial),
	choose: async (prompt: string, options?: string[]) => chooseHandler(prompt, options),
	quickPick: async () => null,
	quickPickMany: async () => null,
	browseWorkspaceFile: async () => null,
}));

const { connect } = await import("../src/view/backend");
const { closeReview, review } = await import("../src/view/editor/Review");
const { documents, openFile, save, setState, state } = await import("../src/view/state");
const { resetRecentTabs } = await import("../src/view/recentTabs");
const { resetTidy } = await import("../src/view/agent/tidy");
const { sslCommentSpans } = await import("../src/view/editor/textmate");

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

// --- The view's backend: a function here, reached through the socket the view opens ---
type RpcHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;
let rpcHandler: RpcHandler = () => null;
let failNextConnect = false;

class TestRpcSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = 0;
	constructor(_url: string) {
		super();
		queueMicrotask(() => {
			if (this.readyState === 3) return;
			if (failNextConnect) {
				this.readyState = 3;
				this.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
			} else {
				this.readyState = 1;
				this.dispatchEvent(new Event("open"));
			}
		});
	}
	send(raw: string) {
		const { id, method, args } = JSON.parse(raw) as { id: number; method: string; args: unknown[] };
		Promise.resolve()
			.then(() => rpcHandler(method, args))
			.then(
				(result) => {
					if (this.readyState !== 1) return;
					this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result }) }));
				},
				(err: any) => {
					if (this.readyState !== 1) return;
					this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, error: String(err?.message ?? err) }) }));
				},
			);
	}
	close() {
		this.readyState = 3;
	}
}


let savedWebSocket: typeof globalThis.WebSocket;
let savedLocation: unknown;

async function connectTestRpc() {
	savedWebSocket = globalThis.WebSocket;
	savedLocation = (globalThis as any).location;
	(globalThis as any).WebSocket = TestRpcSocket;
	(globalThis as any).location = { protocol: "http:", host: "127.0.0.1:5194" };
	failNextConnect = false;
	await connect();
}

async function disconnectTestRpc() {
	failNextConnect = true;
	await connect().catch(() => {});
	failNextConnect = false;
	(globalThis as any).WebSocket = savedWebSocket;
	(globalThis as any).location = savedLocation;
}

function resetAll() {
	const r = review();
	if (r) {
		r.onReject = undefined;
		closeReview();
	}
	for (const doc of [...documents.values()]) doc.model?.dispose?.();
	documents.clear();
	fakeModels.clear();
	storage.clear();
	resetRecentTabs();
	resetTidy();
	askHandler = () => null;
	chooseHandler = () => null;
	rpcHandler = () => null;
	setState((s) => {
		s.workspace = { root: "/ws", name: "ws" };
		s.project = { root: "/ws", path: "/ws/.ssl-studio/project.toml", configured: true, docs: "docs", plans: "design", schema: "schema" } as any;
		s.groups = [{ tabs: [], active: null }];
		s.activeGroup = 0;
		s.dirty = {};
		s.conflicts = {};
		s.messages = [];
		s.lsp = { state: "stopped" };
		s.settings = structuredClone(DEFAULT_SETTINGS);
		s.bottomMaximized = false;
		s.centerView = "editors";
		s.info = null;
	});
	flush();
}

const notices = () => snapshot(state).messages.map((m) => m.text);
const typeInto = (path: string, text: string) => (documents.get(path)!.model as any).pushEditOperations([], [{ range: new FakeRange(1, 1, 1, 1), text }], () => null);

// =============================================================================
// B1-2. What is dragged, and where it may be let go
// =============================================================================

/**
 * The browser's rule (HTML, "drag-and-drop processing model"): a drop happens only when the effect the target
 * asked for at `dragover` is one the source allowed at `dragstart`. Otherwise the drag ends with no `drop` event.
 */
const dropHappens = (effectAllowed: string, dropEffect: string): boolean => {
	if (dropEffect !== "copy" && dropEffect !== "move" && dropEffect !== "link") return false;
	if (effectAllowed === "all" || effectAllowed === "uninitialized") return true;
	return effectAllowed.toLowerCase().includes(dropEffect);
};

describe("B1-2: a drag ends in a drop wherever one is meant", () => {
	const inApp = DRAG_PAIRS.filter(([from]) => from !== "os-files");

	test("what each source allows includes what each of its targets asks for", () => {
		expect(inApp.length).toBeGreaterThan(0);
		for (const [from, onto, effect] of inApp) {
			expect(dragEffect(from, onto)).toBe(effect);
			expect(`${from} -> ${onto}: ${dropHappens(effectAllowedFor(from), dragEffect(from, onto))}`).toBe(`${from} -> ${onto}: true`);
			// The target that sees only the kinds of data over it asks for the same.
			expect(dropHappens(effectAllowedFor(from), dropEffectFor(onto, [DRAG_TYPE[from]]))).toBe(true);
		}
	});

	test("the pairs that are meant to work are in the table, each with what the drop does", () => {
		const pairs = DRAG_PAIRS.map(([from, onto, effect]) => `${from} -> ${onto}: ${effect}`);
		for (const meant of [
			// The file is moved, and is shown as moved.
			"explorer-row -> explorer-folder: move",
			// A note of the file, or a link to it, is written: the file stays, so it is a copy.
			"explorer-row -> code-editor: copy",
			"explorer-row -> markdown-editor: copy",
			"docs-row -> code-editor: copy",
			"docs-row -> markdown-editor: copy",
			"tab -> tab-strip: move",
			"tab -> markdown-editor: copy",
		]) {
			expect(pairs).toContain(meant);
		}
		// Both effects are among a row's and a tab's targets, so both are allowed.
		expect(effectAllowedFor("explorer-row")).toBe("copyMove");
		expect(effectAllowedFor("tab")).toBe("copyMove");
	});

	test("the words each side had before did not meet", () => {
		// The Explorer's rows and the tabs allowed `move` alone; the editors asked for `copy`.
		expect(dropHappens("move", dragEffect("explorer-row", "code-editor"))).toBe(false);
		expect(dropHappens("move", dragEffect("explorer-row", "markdown-editor"))).toBe(false);
		expect(dropHappens("move", dragEffect("tab", "markdown-editor"))).toBe(false);
		// The Docs panel allowed both, which is why the same drop worked from there.
		expect(dropHappens("copyMove", dragEffect("docs-row", "code-editor"))).toBe(true);
	});

	test("a target asks for nothing where a drop is not meant", () => {
		// A tab on code writes nothing: the code editor has no use for it.
		expect(dragEffect("tab", "code-editor")).toBe("none");
		expect(dropEffectFor("code-editor", [DRAG_TYPE.tab])).toBe("none");
		expect(dropEffectFor("code-editor", ["text/plain"])).toBe("none");
		expect(dropEffectFor("code-editor", [])).toBe("none");
		// The Markdown editor takes a row, a tab, and files from outside (a picture).
		for (const from of ["explorer-row", "docs-row", "tab", "os-files"] as DragSource[]) expect(dropEffectFor("markdown-editor", [DRAG_TYPE[from]])).toBe("copy");
		expect(dropEffectFor("markdown-editor", ["text/plain", "text/html"])).toBe("none");
		// `DataTransfer.types` is not an array everywhere: a list with a length is read too.
		expect(dropEffectFor("code-editor", { length: 1, 0: DRAG_TYPE["docs-row"] })).toBe("copy");
		// A row of the Docs panel carries the same kind of data as one of the Explorer.
		expect(DRAG_TYPE["docs-row"]).toBe(DRAG_TYPE["explorer-row"]);
	});

	test("both sides take their words from the table (source text: a drag cannot be run here)", () => {
		const explorer = readSrc("../src/view/panels/Explorer.tsx");
		const group = readSrc("../src/view/editor/EditorGroup.tsx");
		const keymap = readSrc("../src/view/editor/cmKeymap.ts");
		// No effect is written out where it is used: that is how the two sides came apart.
		for (const source of [explorer, group, keymap]) expect(source).not.toMatch(/(?:effectAllowed|dropEffect) = "/);
		expect(explorer).toContain('e.dataTransfer.effectAllowed = effectAllowedFor("explorer-row")');
		expect(explorer).toContain('e.dataTransfer.dropEffect = dragEffect("explorer-row", "explorer-folder")');
		expect(explorer).toContain('e.dataTransfer.dropEffect = dragEffect("os-files", "explorer-folder")');
		expect(group).toContain('e.dataTransfer.effectAllowed = effectAllowedFor("tab")');
		// A tab over a row of tabs says "move" itself, at both places a tab can be over: the row and a tab in it.
		expect(group).toContain('e.dataTransfer.dropEffect = dragEffect("tab", "tab-strip")');
		expect(group.match(/overTabs\(e\)/g)?.length).toBe(2);
		expect(group).toContain('dropEffectFor("code-editor", e.dataTransfer.types)');
		expect(keymap).toContain('dropEffectFor("markdown-editor", dt.types)');
		// The Docs panel's rows are not this test's to change: what they allow is read from the file as it stands.
		const allowed = [...readSrc("../src/view/panels/Docs.tsx").matchAll(/effectAllowed = (?:"(\w+)"|effectAllowedFor\("docs-row"\))/g)].map((m) => m[1] ?? effectAllowedFor("docs-row"));
		expect(allowed.length).toBeGreaterThan(0);
		for (const word of allowed) {
			expect(dropHappens(word, dragEffect("docs-row", "code-editor"))).toBe(true);
			expect(dropHappens(word, dragEffect("docs-row", "markdown-editor"))).toBe(true);
		}
	});
});

// =============================================================================
// B1-4. A file dropped on code
// =============================================================================

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

describe("B1-4: a file dropped on code", () => {
	const rel = "docs/specs/due-dates.md";
	/** A script of `count` lines of code, with a comment that opens on `from` and ends on `to` (lines from 1). */
	const script = (count: number, from: number, to: number) => {
		const lines = Array.from({ length: count }, (_, i) => `nDays${i} := ${i};`);
		lines[from - 1] = "/* The day limit and the priorities.";
		for (let n = from + 1; n < to; n++) lines[n - 1] = `   Note ${n} of the limit`;
		lines[to - 1] = "   and where it ends;";
		return lines;
	};

	test("inside an SSL comment below line 5,000 the path alone is written, not a comment that ends the one around it", () => {
		const lines = script(5300, 5100, 5200);
		const lineAt = (n: number) => lines[n - 1]!;
		// Line 5,150 is inside the comment, line 5,250 is code again.
		const inside = droppedInComment("ssl", 5150, lineAt, 8, sslSpans);
		expect(inside).toBe(true);
		expect(droppedFileNote(rel, "ssl", inside)).toBe(rel);
		const after = droppedInComment("ssl", 5250, lineAt, 0, sslSpans);
		expect(after).toBe(false);
		expect(droppedFileNote(rel, "ssl", after)).toBe(`/* See ${rel};`);
		// What was written before, for any place past line 5,000: a note whose semicolon ends the comment it is in.
		const was = [...lines.slice(0, 5149), `   Note${droppedFileNote(rel, "ssl", false)} 5150 of the limit`, ...lines.slice(5150)];
		const spans = sslSpans(was)!;
		expect(spans[5150]).toEqual([]); // The line after the note, once comment, is read as code.
	});

	test("where it cannot be known, no comment is written", () => {
		// Past the lines that are read for it: nothing is read, and the answer is "not known".
		const none = (n: number): string => {
			throw new Error(`line ${n} was read`);
		};
		const past = droppedInComment("ssl", COMMENT_SCAN_LINES + 1, none, 0, () => {
			throw new Error("the grammar was asked");
		});
		expect(past).toBeNull();
		// With no grammar loaded: the same.
		expect(droppedInComment("ssl", 1, () => "/* a note", 5, () => null)).toBeNull();
		expect(writtenInComment([], "/* a note;", 5, () => null)).toBeNull();
		// Not known is not "in code": the path alone, which breaks no comment.
		expect(droppedFileNote(rel, "ssl", null)).toBe(rel);
		expect(droppedFileNote(rel, "sql", null)).toBe(rel);
		// A path that would end a comment is refused all the same.
		expect(droppedFileNote("docs/a;b.md", "ssl", null)).toBeNull();
		// The limit is far above the old one, and at it the lines are still read.
		expect(COMMENT_SCAN_LINES).toBeGreaterThan(5000);
		const calls: number[] = [];
		expect(droppedInComment("ssl", COMMENT_SCAN_LINES, (n) => (n === COMMENT_SCAN_LINES ? "nDays := 3;" : ""), 0, (all) => (calls.push(all.length), all.map(() => [])))).toBe(false);
		expect(calls).toEqual([COMMENT_SCAN_LINES]);
	});

	test("SQL has no limit: its comments are found however far down", () => {
		const count = COMMENT_SCAN_LINES + 50;
		const lines = Array.from({ length: count }, (_, i) => `SELECT ${i} FROM DEMO_HOLIDAYS;`);
		lines[count - 20] = "/* Why the next rows";
		lines[count - 19] = "   are skipped */";
		const lineAt = (n: number) => lines[n - 1]!;
		expect(droppedInComment("sql", count - 18, lineAt, 3, extractCommentSpans)).toBe(true);
		expect(droppedInComment("sql", count - 10, lineAt, 0, extractCommentSpans)).toBe(false);
		expect(droppedFileNote(rel, "sql", false)).toBe(`/* See ${rel} */`);
	});

	test("every SQL the editor has a language for gets SQL's comment", () => {
		const sqls = LANGUAGES.filter((language) => /sql$/.test(language.id)).map((language) => language.id);
		expect(sqls).toEqual(expect.arrayContaining(["sql", "pgsql", "mysql"]));
		for (const id of sqls) {
			expect(droppedNoteLanguage(id)).toBe("sql");
			// In code: a comment, where the bare path was written for all but `sql`.
			expect(droppedFileNote(rel, droppedNoteLanguage(id)!, false)).toBe(`/* See ${rel} */`);
		}
		expect(droppedNoteLanguage("ssl")).toBe("ssl");
		// The others get the path alone, as before (Markdown has its own branch, a link).
		for (const id of ["markdown", "json", "yaml", "plaintext", "javascript"]) expect(droppedNoteLanguage(id)).toBeNull();
	});

	test("the editor asks these (source text: the editor cannot be mounted here)", () => {
		const group = readSrc("../src/view/editor/EditorGroup.tsx");
		expect(group).toContain("const noteLang = droppedNoteLanguage(lang);");
		expect(group).toContain("} else if (noteLang) {");
		expect(group).toContain("const insideComment = droppedInComment(");
		expect(group).toContain("const note = droppedFileNote(rel, noteLang, insideComment);");
		expect(group).not.toContain("pos.lineNumber <= 5000");
	});
});

// =============================================================================
// B2-9. A section moved in the outline
// =============================================================================

describe("B2-9: moving a section leaves the document's closing lines and every line end alone", () => {
	const flat = (tree: MarkdownSection[]): MarkdownSection[] => tree.flatMap((section) => [section, ...flat(section.children)]);
	const lineOf = (text: string, heading: string) => text.split(/\r?\n/).indexOf(heading) + 1;
	const closing = '[^1]: a footnote\n\n[ref]: https://example.com\n\n<!-- plan 0af3c2 -->\n';
	const spec = `# Plan\n\nintro\n\n## One\n\n1[^1]\n\n## Two\n\n2 [see][ref]\n\n${closing}`;

	test("the last section moved up leaves the footnotes, the link definitions and the closing mark last", () => {
		const moved = moveMarkdownSection(spec, lineOf(spec, "## Two"), "up");
		expect(moved?.text).toBe(`# Plan\n\nintro\n\n## Two\n\n2 [see][ref]\n\n## One\n\n1[^1]\n\n${closing}`);
		expect(moved?.newLine).toBe(5);
		// The same move, asked for from the section above.
		expect(moveMarkdownSection(spec, lineOf(spec, "## One"), "down")?.text).toBe(moved!.text);
		// And by dragging: before the first, and the first after the last.
		expect(moveMarkdownSectionTo(spec, lineOf(spec, "## Two"), lineOf(spec, "## One"), "before").text).toBe(moved!.text);
		expect(moveMarkdownSectionTo(spec, lineOf(spec, "## One"), lineOf(spec, "## Two"), "after").text).toBe(moved!.text);
	});

	test("a top-level section that runs to the end of the file ends before them too", () => {
		const text = `# A\n\na\n\n# B\n\nb\n\n## B1\n\nb1\n\n${closing}`;
		expect(moveMarkdownSection(text, lineOf(text, "# B"), "up")?.text).toBe(`# B\n\nb\n\n## B1\n\nb1\n\n# A\n\na\n\n${closing}`);
		// A section dropped inside the last one goes in above the closing lines, not below them.
		const inside = moveMarkdownSectionTo(text, lineOf(text, "# A"), lineOf(text, "## B1"), "inside");
		expect(inside.text).toBe(`# B\n\nb\n\n## B1\n\nb1\n\n### A\n\na\n\n${closing}`);
		expect(inside.text.split("\n")[inside.newLine - 1]).toBe("### A");
	});

	test("a footnote's further lines stay with it, and no blank line is needed above the closing lines", () => {
		const text = "# A\n\na\n\n# B\n\nb\n[^1]: A note that goes on\nin a second line,\n\n    and in a second paragraph.\n[ref]: https://example.com\n";
		expect(moveMarkdownSection(text, 5, "up")?.text).toBe("# B\n\nb\n\n# A\n\na\n[^1]: A note that goes on\nin a second line,\n\n    and in a second paragraph.\n[ref]: https://example.com\n");
	});

	test("what is not known to be the document's stays with its section", () => {
		// The closing half of a pair: left behind, whatever fills the pair next would write over everything between.
		const flow = "# Spec\n\n## Steps\n\n1. Count the days.\n\n## Flow\n\n<!-- plan-mermaid:start -->\n```mermaid\nflowchart TD\n```\n<!-- plan-mermaid:end -->\n";
		expect(moveMarkdownSection(flow, lineOf(flow, "## Flow"), "up")?.text).toBe(
			"# Spec\n\n## Flow\n\n<!-- plan-mermaid:start -->\n```mermaid\nflowchart TD\n```\n<!-- plan-mermaid:end -->\n\n## Steps\n\n1. Count the days.\n",
		);
		const catalog = "# A\n\na\n\n# Catalog\n\n<!-- catalog -->\n\n- [[One]]\n\n<!-- /catalog -->\n";
		expect(moveMarkdownSection(catalog, 5, "up")?.text).toBe("# Catalog\n\n<!-- catalog -->\n\n- [[One]]\n\n<!-- /catalog -->\n\n# A\n\na\n");
		// A note on the section, a definition with text after it, a definition inside a fence.
		const noted = "# A\n\na\n\n# B\n\nb\n\n<!-- to do: the sign-off table -->\n";
		expect(moveMarkdownSection(noted, 5, "up")?.text).toBe("# B\n\nb\n\n<!-- to do: the sign-off table -->\n\n# A\n\na\n");
		const mid = "# A\n\na\n\n# B\n\n[ref]: https://example.com\n\nb [see][ref]\n";
		expect(moveMarkdownSection(mid, 5, "up")?.text).toBe("# B\n\n[ref]: https://example.com\n\nb [see][ref]\n\n# A\n\na\n");
		const fenced = "# A\n\na\n\n# B\n\n```md\n[ref]: https://example.com\n```\n";
		expect(moveMarkdownSection(fenced, 5, "up")?.text).toBe("# B\n\n```md\n[ref]: https://example.com\n```\n\n# A\n\na\n");
	});

	test("a last heading with nothing under it but definitions keeps them: they are its text", () => {
		const text = "# A\n\na[^1]\n\n# Footnotes\n\n[^1]: a footnote\n\n<!-- plan 0af3c2 -->\n";
		// The mark is the document's all the same.
		expect(moveMarkdownSection(text, 5, "up")?.text).toBe("# Footnotes\n\n[^1]: a footnote\n\n# A\n\na[^1]\n\n<!-- plan 0af3c2 -->\n");
	});

	test("every line keeps the line end it has", () => {
		const mixed = "# A\r\ntext a\n\n# B\ntext b\n";
		expect(moveMarkdownSection(mixed, 4, "up")?.text).toBe("# B\ntext b\n\n# A\r\ntext a\n");
		expect(moveMarkdownSection(mixed, 1, "down")?.text).toBe("# B\ntext b\n\n# A\r\ntext a\n");
		expect(moveMarkdownSectionTo(mixed, 4, 1, "before").text).toBe("# B\ntext b\n\n# A\r\ntext a\n");
		// A change of level changes the heading's marks and nothing else.
		expect(demoteMarkdownSection(mixed, 4).text).toBe("# A\r\ntext a\n\n## B\ntext b\n");
		expect(promoteMarkdownSection("# A\r\ntext a\n\n## B\ntext b\n", 4).text).toBe(mixed);
		// One kind throughout stays that kind, as it did.
		expect(moveMarkdownSection("# A\r\n\r\na\r\n\r\n# B\r\n\r\nb\r\n", 5, "up")?.text).toBe("# B\r\n\r\nb\r\n\r\n# A\r\n\r\na\r\n");
		// A text that ends in no line end still ends in none: the line that is last now gives its end to the one that was.
		expect(moveMarkdownSection("# A\r\ntext a\n# B\ntext b", 3, "up")?.text).toBe("# B\ntext b\n# A\r\ntext a");
		// A blank line put between two sections is the one line made here: it has the end of the blank line it is
		// modelled on (the one above the section moved).
		expect(moveMarkdownSectionTo("# A\r\na\r\n\r\n# B\r\nb\r\n# C\r\nc\r\n", 6, 1, "before").text).toBe("# C\r\nc\r\n\r\n# A\r\na\r\n\r\n# B\r\nb\r\n");
	});

	test("no move reaches the front matter: what the Live editor is given starts in the body", () => {
		const docs = [
			"---\ntitle: T\nstatus: draft\n---\n\n# A\n\na\n\n## A1\n\na1\n\n# B\n\nb\n\n# C\n\nc\n",
			// The first heading right under the closing fence: a blank line may be put between them, below the fence.
			"---\ntitle: T\n---\n# A\na\n\n# B\nb\n",
			"---\ntitle: T\n---\n\nA line before any heading.\n\n# A\n\na\n\n# B\n\nb\n\n[^1]: a footnote\n",
		];
		let moves = 0;
		for (const text of docs) {
			const fm = frontMatter(text);
			expect(fm.lines).toBeGreaterThan(0);
			/** Where the closing fence's line ends: what the editor's guard calls the end of the hidden block. */
			const fmTo = text.split("\n").slice(0, fm.lines).join("\n").length;
			const sections = flat(markdownSectionTree(text));
			// The first section has nowhere to go up to.
			expect(moveMarkdownSection(text, sections[0]!.line, "up")).toBeNull();
			const results: string[] = [];
			for (const section of sections) {
				for (const direction of ["up", "down"] as const) {
					const moved = moveMarkdownSection(text, section.line, direction);
					if (moved) results.push(moved.text);
				}
				for (const target of sections) {
					for (const place of ["before", "after", "inside"] as const) {
						const moved = moveMarkdownSectionTo(text, section.line, target.line, place);
						if (moved.changed) results.push(moved.text);
					}
				}
			}
			expect(results.length).toBeGreaterThan(2);
			for (const next of results) {
				moves++;
				// The block and its line end are as they were.
				expect(next.slice(0, fmTo + 1)).toBe(text.slice(0, fmTo + 1));
				// The edit the Live editor makes of a change of the model: the part that differs (MarkdownLiveEditor's
				// model listener). The guard asks whether it touches the block; it never does.
				let start = 0;
				while (start < text.length && start < next.length && text[start] === next[start]) start++;
				let end = text.length;
				let nextEnd = next.length;
				while (end > start && nextEnd > start && text[end - 1] === next[nextEnd - 1]) (end--, nextEnd--);
				const change = ChangeSet.of({ from: start, to: end, insert: next.slice(start, nextEnd) }, text.length);
				expect(change.touchesRange(0, fmTo)).toBe(false);
			}
		}
		expect(moves).toBeGreaterThan(20);
		// The move is made in the document's model, and reaches the Live editor from there as a change from outside.
		const objects = readSrc("../src/view/panels/Objects.tsx");
		expect(objects).toContain("if (!applyMinimalModelEdit(doc.model, nextText)) return;");
		expect(readSrc("../src/view/editor/MarkdownLiveEditor.tsx")).toContain("annotations: [externalSyncAnnotation.of(true), Transaction.addToHistory.of(false)],");
	});
});

// =============================================================================
// B1-5. "Keep mine and save", in the review of a file that changed on disk
// =============================================================================

describe("B1-5: the review of a file that changed on disk acts on what is there when the choice is made", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	const file = "/ws/docs/Notes.md";
	const opened = "# Notes\n\nThe day limit is three.\n";
	const theirs = "# Notes\n\nThe day limit is three.\n\nAdded by someone else.\n";
	const textOf = () => (documents.get(file)!.model as any).getValue() as string;

	/** A file opened and edited here, then changed on disk; the save that finds it so is answered with "Compare". */
	async function conflict(disk: { text: string; mtime: number; failWrite?: string }) {
		const written: string[] = [];
		let changed = false;
		rpcHandler = (method, args) => {
			if (method === "read") return changed ? { text: disk.text, mtime: disk.mtime, encoding: "utf-8" } : { text: opened, mtime: 1, encoding: "utf-8" };
			if (method === "write") {
				if (disk.failWrite) throw new Error(disk.failWrite);
				written.push(String(args[1]));
				return { mtime: 9 };
			}
			return null;
		};
		const questions: string[] = [];
		chooseHandler = (prompt) => {
			questions.push(prompt);
			if (prompt.includes("changed on disk after you opened it")) return "Compare";
			// Asked only because the test calls the review's accept without the button: in the app the review that is
			// being accepted gives way to the next without a question (agentPanel.test.ts).
			if (prompt.includes("is still open for review")) return "Replace";
			return null;
		};
		await openFile(file, { keep: true });
		flush();
		typeInto(file, "Mine. ");
		changed = true;
		expect(await save(file)).toBe(false);
		flush();
		const shown = review()!;
		expect(shown.acceptLabel).toBe("Keep mine and save");
		expect(shown.original).toBe(disk.text);
		expect(shown.proposed).toBe(`Mine. ${opened}`);
		return { written, questions, shown, disk };
	}

	test("with nothing changed since, the right side is kept and saved over the file", async () => {
		const { written, shown } = await conflict({ text: theirs, mtime: 2 });
		// The right side can be edited in the review: what it holds when the button is pressed is what is kept.
		await shown.onAccept(`Mine, edited. ${opened}`);
		flush();
		expect(written).toEqual([`Mine, edited. ${opened}`]);
		expect(textOf()).toBe(`Mine, edited. ${opened}`);
		expect(snapshot(state).dirty[file]).toBe(false);
		expect(notices()).toEqual([]);
	});

	test("a change made to the document while the review is open is not undone: the review opens again on it", async () => {
		const { written, shown } = await conflict({ text: theirs, mtime: 2 });
		// From a panel: a property set in the Info panel, a replace, a table action.
		const doc = documents.get(file)!;
		(doc.model as any).pushEditOperations([], [{ range: new FakeRange(3, 1, 3, 1), text: "Set from a panel. " }], () => null);
		const now = `Mine. # Notes\n\nSet from a panel. The day limit is three.\n`;
		expect(textOf()).toBe(now);

		await shown.onAccept(shown.proposed);
		flush();
		// Nothing was written, and the panel's change stands.
		expect(written).toEqual([]);
		expect(textOf()).toBe(now);
		expect(snapshot(state).dirty[file]).toBe(true);
		// The review is another one, on the document as it is.
		const again = review()!;
		expect(again).not.toBe(shown);
		expect(again.acceptLabel).toBe("Keep mine and save");
		expect(again.original).toBe(theirs);
		expect(again.proposed).toBe(now);
		expect(notices()).toEqual(["Notes.md changed in the app while the review was open. Nothing was saved: the review now shows both sides as they are."]);

		// Chosen there, it is kept and saved: the panel's change with it.
		await again.onAccept(again.proposed);
		flush();
		expect(written).toEqual([now]);
		expect(snapshot(state).dirty[file]).toBe(false);
	});

	test("a file that changed on disk again is shown again, with the right side as it was left", async () => {
		const first = { text: theirs, mtime: 2 };
		const { written, shown, disk } = await conflict(first);
		const later = `${theirs}\nAnd a second time.\n`;
		disk.text = later;
		disk.mtime = 3;

		await shown.onAccept(`Mine, edited. ${opened}`);
		flush();
		expect(written).toEqual([]);
		// The document is untouched: nothing was applied.
		expect(textOf()).toBe(`Mine. ${opened}`);
		const again = review()!;
		expect(again).not.toBe(shown);
		expect(again.original).toBe(later);
		expect(again.proposed).toBe(`Mine, edited. ${opened}`);
		expect(notices()).toEqual(["Notes.md changed on disk again while the review was open. Nothing was saved: the review now shows both sides as they are."]);

		// The right side it was given is not the document: a change made elsewhere now is not a reason to drop it.
		typeInto(file, "From a panel. ");
		let said = "";
		await Promise.resolve(again.onAccept(again.proposed)).catch((e: Error) => (said = e.message));
		expect(said).toContain("was also changed outside this review");
		expect(review()).toBe(again);
		expect(written).toEqual([]);
		// With that change taken back, it is kept and saved.
		(documents.get(file)!.model as any).pushEditOperations([], [{ range: new FakeRange(1, 1, 1, "From a panel. ".length + 1), text: "" }], () => null);
		expect(textOf()).toBe(`Mine. ${opened}`);

		await again.onAccept(again.proposed);
		flush();
		expect(written).toEqual([`Mine, edited. ${opened}`]);
		expect(textOf()).toBe(`Mine, edited. ${opened}`);
	});

	test("a file whose time changed but not its text is the file the review shows: the choice is applied", async () => {
		const { written, shown, disk } = await conflict({ text: theirs, mtime: 2 });
		disk.mtime = 5;
		await shown.onAccept(shown.proposed);
		flush();
		expect(written).toEqual([`Mine. ${opened}`]);
		expect(review()).toBe(shown); // Closed by the button's own flow, which is not run here.
		expect(notices()).toEqual([]);
	});

	test("the document changed elsewhere and the right side edited too: nothing is applied, and the review says why", async () => {
		const { written, shown } = await conflict({ text: theirs, mtime: 2 });
		typeInto(file, "From a panel. ");
		const now = textOf();
		let said = "";
		await Promise.resolve(shown.onAccept(`Mine, edited. ${opened}`)).catch((e: Error) => (said = e.message));
		flush();
		expect(said).toBe("Notes.md was also changed outside this review, and keeping the right side as it stands would undo that. Copy what you changed here, close the review, and save again");
		expect(written).toEqual([]);
		expect(textOf()).toBe(now);
		// It is the same review still: the edits made in it are there to be copied.
		expect(review()).toBe(shown);
	});

	test("a save that fails is said to have failed, and the review stays for another try", async () => {
		const state0 = await conflict({ text: theirs, mtime: 2, failWrite: "The disk is full: Notes.md was not written." });
		let said = "";
		await Promise.resolve(state0.shown.onAccept(state0.shown.proposed)).catch((e: Error) => (said = e.message));
		flush();
		expect(said).toBe("Notes.md was not saved: the right side is in the document now, unsaved");
		expect(state0.written).toEqual([]);
		expect(snapshot(state).dirty[file]).toBe(true);
		// Why it failed was said by the save.
		expect(notices()).toEqual(["The disk is full: Notes.md was not written."]);
		// The same button again, once the disk takes it: the text the review left in the document is not a change
		// made elsewhere.
		state0.disk.failWrite = undefined;
		await state0.shown.onAccept(state0.shown.proposed);
		flush();
		expect(state0.written).toEqual([`Mine. ${opened}`]);
		expect(snapshot(state).dirty[file]).toBe(false);
	});

	test("a document that is no longer open is not written to, and that is said", async () => {
		const { written, shown } = await conflict({ text: theirs, mtime: 2 });
		const doc = documents.get(file)!;
		documents.delete(file);
		let said = "";
		await Promise.resolve(shown.onAccept(shown.proposed)).catch((e: Error) => (said = e.message));
		expect(said).toBe("Notes.md is no longer open as text");
		expect(written).toEqual([]);
		documents.set(file, doc);
	});
});
