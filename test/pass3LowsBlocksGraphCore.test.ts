// The low findings of the third audit pass in the Blocks view, the call graph, the Agent panel's view side and
// the view core. The pure parts (src/view/blocks/model.ts, src/view/graph/canvas.ts, and the functions pulled out
// of Agent.tsx and agent/store.ts) and the view's own state (src/view/state.ts, over a fake of the backend's RPC)
// are run for real. BlocksView.tsx, GraphView.tsx, App.tsx and the Agent panel's markup need a DOM and the real
// Monaco to be mounted, which the suite does not have: what is checked of them is only that they are wired to the
// tested parts, by reading their source, and each such test says so in its name.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { flush, snapshot } from "solid-js";
import { DEFAULT_SETTINGS } from "../src/shared/protocol";
import { buildTree, editedLines, treeFromSyntax, type Node, type SyntaxNodeIn } from "../src/view/blocks/model";
import { secondClick, wheelZoom, zoomAt } from "../src/view/graph/canvas";

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8").replace(/\r\n/g, "\n");
const between = (src: string, from: string, to: string) => {
	const start = src.indexOf(from);
	const end = src.indexOf(to, start + from.length);
	expect(start).toBeGreaterThan(0);
	expect(end).toBeGreaterThan(start);
	return src.slice(start, end);
};

// --- Headless browser & Monaco shims (the same as solid2AuditCore.test.ts: the mocks are the whole run's) ---
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


const { backend, connect } = await import("../src/view/backend");
const { closeReview, review } = await import("../src/view/editor/Review");
const { documents, keepForFolder, loadSettings, openFile, openFolder, saveSetting, setState, state } = await import("../src/view/state");
const { resetRecentTabs } = await import("../src/view/recentTabs");
const { resetTidy } = await import("../src/view/agent/tidy");
const { answeredQuestion, reviewProposedEdit, reviewTargetRefusal } = await import("../src/view/agent/Agent");
const { agent, chatSessionEpoch, clearEntries, isSessionBreak, SESSION_BREAK, sessionBreakDue, setAgent, startNewThread, stop: stopAgent, switchThread, syncWorkspaceThreads } = await import("../src/view/agent/store");
// --- In-process MockSocket RPC driver ---
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

const tick = (ms = 0) => new Promise((done) => setTimeout(done, ms));
const until = async (ok: () => boolean) => {
	for (let i = 0; i < 500 && !ok(); i++) await tick(1);
	expect(ok()).toBe(true);
};
const notices = () => snapshot(state).messages.map((m) => m.text);

// --- 1. Blocks: a fold is kept by the block's place in the structure ------------------------------------------

const span = (from: number, to: number) => ({ start: { line: from - 1, character: 0 }, end: { line: to - 1, character: 200 } });
const headOf = (line: number, text: string) => ({ start: { line: line - 1, character: 0 }, end: { line: line - 1, character: text.length } });

/**
 * A file as the language server's syntax tree gives it: `above` statements, then procedures. A procedure is a list
 * of parts: "-" is a statement, anything else the keyword of a three-line block (`:IF bMore;` … `:ENDIF;`).
 */
const fileOf = (procedures: [name: string, parts: string[]][], above = 0) => {
	const lines: string[] = Array(above).fill("nCount := 0;");
	const nodes: SyntaxNodeIn[] = lines.map((_, i) => ({ kind: "statement", range: span(i + 1, i + 1) }));
	for (const [name, parts] of procedures) {
		const start = lines.length + 1;
		lines.push(`:PROCEDURE ${name};`);
		const children: SyntaxNodeIn[] = [];
		for (const part of parts) {
			const at = lines.length + 1;
			if (part === "-") {
				lines.push("nCount := nCount + 1;");
				children.push({ kind: "statement", range: span(at, at) });
				continue;
			}
			const header = `:${part} bMore;`;
			lines.push(header, "nCount := nCount + 1;", `:END${part};`);
			children.push({ kind: part.toLowerCase(), keyword: part, range: span(at, at + 2), headerRange: headOf(at, header), children: [{ kind: "statement", range: span(at + 1, at + 1) }] });
		}
		lines.push(":ENDPROC;");
		nodes.push({ kind: "procedure", name, range: span(start, lines.length), children });
	}
	return treeFromSyntax(lines, nodes, () => []);
};
/** Every block that can be folded, top to bottom. */
const foldable = (node: Node, out: Node[] = []): Node[] => {
	for (const child of node.children) {
		if (child.fold !== undefined) out.push(child);
		foldable(child, out);
	}
	return out;
};
const folds = (root: Node) => foldable(root).map((n) => n.fold);
const everyNode = (node: Node): Node[] => [node, ...node.children.flatMap(everyNode)];

describe("Blocks — a fold stays on its block when lines are added or removed above (finding 1)", () => {
	const two: [string, string[]][] = [
		["CountDue", ["IF"]],
		["PurgeOld", ["WHILE"]],
	];

	test("a block's fold is named by where it is, and the name does not hold a line", () => {
		expect(folds(fileOf(two))).toEqual(["procedure:CountDue", "procedure:CountDue/block:IF", "procedure:PurgeOld", "procedure:PurgeOld/block:WHILE"]);
	});

	test("everything folded stays folded, on the same blocks, after lines are added above", () => {
		const before = fileOf(two);
		// What the view keeps: the names of the folded blocks ("Fold all", or a long file that opens folded).
		const collapsed = new Set(folds(before));
		for (const above of [1, 4]) {
			const after = fileOf(two, above);
			expect(foldable(after).every((n) => collapsed.has(n.fold))).toBe(true);
			expect(folds(after)).toEqual(folds(before));
			// The same blocks, each `above` lines further down.
			expect(foldable(after).map((n) => n.start)).toEqual(foldable(before).map((n) => n.start + above));
		}
	});

	test("the key the folds used to be kept by holds the line: with lines added above, a fold was lost or sat on another block", () => {
		const before = fileOf([["Run", ["IF", "WHILE"]]]);
		const whileKey = foldable(before).find((n) => n.header?.keyword === "WHILE")!.key;
		expect(whileKey).toBe("block::5");
		// Three statements added above the two blocks, inside the procedure: the :IF now starts where the :WHILE did.
		const after = fileOf([["Run", ["-", "-", "-", "IF", "WHILE"]]]);
		expect(foldable(after).find((n) => n.key === whileKey)!.header?.keyword).toBe("IF");
		// By its name the :WHILE's fold is still the :WHILE's.
		expect(foldable(after).find((n) => n.fold === "procedure:Run/block:WHILE")!.header?.keyword).toBe("WHILE");
		// And one line added above a procedure changes every key in it: every fold was lost.
		const keys = new Set(foldable(fileOf(two)).map((n) => n.key));
		expect(foldable(fileOf(two, 1)).filter((n) => keys.has(n.key))).toEqual([]);
	});

	test("lines added inside a procedure, above a block, do not move its fold either", () => {
		expect(folds(fileOf([["Run", ["-", "-", "IF", "-", "WHILE"]]]))).toEqual(folds(fileOf([["Run", ["IF", "WHILE"]]])));
	});

	test("blocks of one kind under one parent are told apart by their order, and only an earlier one of that kind moves them", () => {
		expect(folds(fileOf([["Run", ["IF", "WHILE", "IF"]]]))).toEqual(["procedure:Run", "procedure:Run/block:IF", "procedure:Run/block:WHILE", "procedure:Run/block:IF#2"]);
		// A block of another kind added above: the two :IF blocks keep their names.
		const withWhile = fileOf([["Run", ["WHILE", "IF", "WHILE", "IF"]]]);
		expect(foldable(withWhile).filter((n) => n.header?.keyword === "IF").map((n) => n.fold)).toEqual(["procedure:Run/block:IF", "procedure:Run/block:IF#2"]);
		// The limit, as model.ts says it: an :IF added above them takes the first one's name, and the folds move on by one.
		const withIf = fileOf([["Run", ["IF", "IF", "WHILE", "IF"]]]);
		expect(foldable(withIf).filter((n) => n.header?.keyword === "IF").map((n) => `${n.fold}@${n.start}`)).toEqual(["procedure:Run/block:IF@2", "procedure:Run/block:IF#2@5", "procedure:Run/block:IF#3@11"]);
	});

	test("a procedure is known by its name wherever it is, and its doc block by the procedure", () => {
		const text = ["/* region Checks;", "/* Says whether a sample is due;", ":PROCEDURE IsDue;", ":RETURN .T.;", ":ENDPROC;", "/* What follows is kept", "   for the next release;", "/* endregion;"];
		const card: SyntaxNodeIn[] = [
			{ kind: "docBlock", range: span(2, 2) },
			{ kind: "procedure", name: "IsDue", range: span(3, 5), children: [{ kind: "statement", range: span(4, 4) }] },
			{ kind: "comment", range: span(6, 7) },
		];
		const inRegion = treeFromSyntax(text, [{ kind: "region", name: "Checks", range: span(1, 8), children: card }], () => []);
		expect(folds(inRegion)).toEqual(["region:Checks", "doc:procedure:IsDue", "procedure:IsDue", "region:Checks/comment"]);
		// The same card with no region round it (one line less above): the procedure and its doc block keep their names.
		const bare = treeFromSyntax(text.slice(1, 7), card.map((n) => ({ ...n, range: span(n.range.start.line, n.range.end.line), children: n.children?.map((c) => ({ ...c, range: span(c.range.start.line, c.range.end.line) })) })), () => []);
		expect(folds(bare)).toEqual(["doc:procedure:IsDue", "procedure:IsDue", "comment"]);
	});

	test("no two blocks share a name, even two procedures of one name; a leaf has none", () => {
		const root = fileOf([
			["Run", ["IF", "IF"]],
			["Run", ["IF"]],
			["Stop", []],
		]);
		const names = folds(root);
		expect(names).toEqual(["procedure:Run", "procedure:Run/block:IF", "procedure:Run/block:IF#2", "procedure:Run#2", "procedure:Run#2/block:IF", "procedure:Stop"]);
		expect(new Set(names).size).toBe(names.length);
		for (const node of everyNode(root).slice(1)) expect(node.fold === undefined).toBe(node.kind === "text" || node.kind === "blank" || node.kind === "raw");
	});

	test("the tree built from symbols and folding ranges (a server with no syntax tree) names its folds the same way", () => {
		const text = (above: number) => [...Array(above).fill("nCount := 0;"), ":PROCEDURE Run;", ":IF bMore;", "nCount := 1;", ":ENDIF;", ":ENDPROC;"];
		const tree = (above: number) => buildTree(text(above), [{ name: "Run", kind: 12, startLine: above, endLine: above + 4 }], [{ startLine: above + 1, endLine: above + 3 }]);
		// A folding range has no keyword: the block is one of the blocks of its procedure.
		expect(folds(tree(0))).toEqual(["procedure:Run", "procedure:Run/block:"]);
		expect(folds(tree(3))).toEqual(folds(tree(0)));
	});

	test("BlocksView keeps its folds by that name (source only: the view needs a DOM and Monaco to run)", () => {
		const src = readSrc("src/view/blocks/BlocksView.tsx");
		expect(src).toContain("const isCollapsed = (n: Node) => (collapseVersion(), Boolean(n.fold && collapsed().has(n.fold)));");
		expect(src).toContain("collapsed().has(n.fold) ? collapsed().delete(n.fold) : collapsed().add(n.fold);");
		expect(src).toContain("if (openFolds(collapsedByPath, path, root, model.getLineCount())) setCollapseVersion((v) => v + 1);");
		// Nothing is kept, or looked up, by the key that holds the line.
		expect(src).not.toMatch(/collapsed\(\)\.(has|add|delete)\((n|c|banner)\.key\)/);
	});
});

// --- 5b. Blocks: an edit is followed by a range format of what it touched ------------------------------------

describe("Blocks — the lines an edit leaves to be formatted (finding 5b)", () => {
	test("text put in place of a block's lines, or between two lines, is its own lines", () => {
		// A two-line chip rewritten as three lines, in a file that is then 21 lines long.
		expect(editedLines(5, "a := 1;\nb := 2;\nc := 3;", 21)).toEqual({ start: 5, end: 7 });
		expect(editedLines(5, "a := 1;", 20)).toEqual({ start: 5, end: 5 });
		// What is dropped ends in a line break, which ends its last line and begins no other; so with CRLF.
		expect(editedLines(3, "a := 1;\nb := 2;\n", 12)).toEqual({ start: 3, end: 4 });
		expect(editedLines(3, "a := 1;\r\nb := 2;\r\n", 12)).toEqual({ start: 3, end: 4 });
		// Never past the end of the text.
		expect(editedLines(9, "a\nb\nc", 10)).toEqual({ start: 9, end: 10 });
	});

	test("a deletion leaves the two lines that now meet, as far as there are two", () => {
		expect(editedLines(5, null, 10)).toEqual({ start: 4, end: 5 });
		// The first lines went: only the line that moved up is there.
		expect(editedLines(1, null, 10)).toEqual({ start: 1, end: 1 });
		// The last lines went: only the line before them.
		expect(editedLines(11, null, 10)).toEqual({ start: 10, end: 10 });
		// Everything went: the one empty line a text always has.
		expect(editedLines(1, null, 1)).toEqual({ start: 1, end: 1 });
	});

	test("BlocksView formats after each of the four edits, a range and never the file, and only with the server running (source only, as above)", () => {
		const src = readSrc("src/view/blocks/BlocksView.tsx");
		const format = between(src, "const formatLines = async (start: number, end: number, raw: Span[] = []) => {", "const formatEdited = async (span: Span, raw: Span[] = []) => {");
		// Asked of a running server only, and before the request is made; the undo step is closed either way.
		expect(format.indexOf('if (state.lsp.state !== "running") return;')).toBeGreaterThan(0);
		expect(format.indexOf('if (state.lsp.state !== "running") return;')).toBeLessThan(format.indexOf("session.formatRanges(model, [[run.start - 1, run.end - 1]], model.getOptions())"));
		// Each run of lines is asked on its own, what the server could not read cut out of it, and an answer is applied
		// only when it changes no line outside its run (pass 4, M1; the functions are run in pass4Regressions.test.ts).
		expect(format).toContain("for (const run of cutOut({ start: Math.max(1, start), end: Math.min(end, model.getLineCount()) }, raw)) {");
		expect(format).toContain("if (edits.length && formatStaysWithin(before, linesWithEdits(before, edits), run)) kept.push(...edits);");
		expect(format).toContain("} finally {\n\t\t\tif (!model.isDisposed()) model.pushStackElement();");
		const remove = between(src, "const remove = async (n: Node) => {", "const opened = (");
		expect(remove).toContain("replaceLines(card.start, card.end, null, false);\n\t\tawait formatEdited(editedLines(card.start, null, model.getLineCount()), raw);");
		const condition = between(src, "const commitCondition = (n: Node, value: string) => {", "const commitEdit = (n: Node, text: string) => {");
		expect(condition).toContain("void formatEdited({ start: h.line, end: h.line });");
		const edit = between(src, "const commitEdit = (n: Node, text: string) => {", "const drop = (e: DragEvent, line: number) => {");
		expect(edit).toContain("void formatEdited(editedLines(n.start, put, model.getLineCount()));");
		// Code the server could not read is written as typed and no format follows it.
		expect(edit).toContain('if (n.kind === "raw") {\n\t\t\treplaceLines(n.start, n.end, text, true);\n\t\t\treturn editedHere();');
		const drop = between(src, "const drop = (e: DragEvent, line: number) => {", "const dropZone = ");
		expect(drop).toContain("void formatEdited(editedLines(targetLine, inserted, model.getLineCount()));");
		// The only format the view asks for is of line ranges, and it never sets a file's whole text.
		expect(src.match(/session\.format\w+\(/g)).toEqual(["session.formatRanges("]);
		expect(src).not.toContain(".setValue(");
	});
});

// --- 3, 4, 5a. Call graph: a double-click, the wheel, and the notice of a failed layout ---------------------

describe("Call graph — the second click of a double-click is its node's (finding 3)", () => {
	const at = (detail: number, ms: number, x = 200, y = 120) => ({ detail, at: ms, x, y });
	const onNode = at(1, 1000);

	test("a click that follows none on a node is a click of its own, whatever its count", () => {
		expect(secondClick(at(1, 1000), null)).toBe(false);
		// A double-click that began on the empty picture, or on a script's frame: two clicks, as it was.
		expect(secondClick(at(2, 1100), null)).toBe(false);
	});

	test("the click the window system counts as the second is the node's, as late as a slow double-click lands", () => {
		expect(secondClick(at(2, 1150), onNode)).toBe(true);
		// A slow double-click, by someone who has set the system to allow it: the count is the system's to say.
		expect(secondClick(at(2, 1900), onNode)).toBe(true);
	});

	test("a click the count does not mark is still the second when it follows at once, in the same place", () => {
		// A webview that starts the count again because the node under the pointer is no longer the one clicked.
		expect(secondClick(at(1, 1300), onNode)).toBe(true);
		expect(secondClick(at(1, 1300, 203, 123), onNode)).toBe(true);
		expect(secondClick(at(0, 1300), onNode)).toBe(true);
	});

	test("a later click, or one somewhere else, is a click of its own: nothing waits to see whether a second follows", () => {
		expect(secondClick(at(1, 1401), onNode)).toBe(false);
		expect(secondClick(at(1, 1300, 240, 120), onNode)).toBe(false);
		// A third click in a row is not a second.
		expect(secondClick(at(3, 1300), onNode)).toBe(false);
	});

	test("GraphView hears the second click before any node does, and opens the node the first was on (source only: the view needs a DOM)", () => {
		const src = readSrc("src/view/graph/GraphView.tsx");
		const listener = between(src, 'el.addEventListener(\n\t\t\t\t\t\t\t\t"click",', "true,\n\t\t\t\t\t\t\t);");
		// What was clicked before is taken up once: a click that is not its second is a click of its own and goes on to the nodes.
		expect(listener).toContain('const heard = clicks.heard(clickAt(e), panned);\n\t\t\t\t\t\t\t\t\tif (heard.is === "own") return;\n\t\t\t\t\t\t\t\t\te.stopPropagation();');
		expect(listener).toContain('if (heard.node.kind !== "fold" && heard.node.kind !== "dir") open(heard.node);');
		// A node's own click says which node it was, and focuses at once; no node opens on the browser's dblclick,
		// which is given to whatever node has come to lie under the pointer.
		expect(src).toContain('onClick={(e) => (e.stopPropagation(), clicks.onNode(clickAt(e), b), far() ? comeIn(b) : b.kind === "dir" ? toggleDir(b.folder) : b.kind === "fold" ? toggleFold(b.path) : focus(b.id))}');
		expect(src).not.toContain('onDblClick={() => b.kind !== "fold" && b.kind !== "dir" && open(b)}');
	});
});

describe("Call graph — the wheel zooms by as much as it turned (finding 4)", () => {
	const wheel = (deltaY: number, more: Partial<{ deltaX: number; deltaMode: number; ctrlKey: boolean }> = {}) => wheelZoom({ deltaX: 0, deltaY, deltaMode: 0, ...more });

	test("a movement that is only sideways, or more sideways than not, does not zoom", () => {
		// It used to zoom out: deltaY 0 is "not up".
		expect(wheel(0, { deltaX: 30 })).toBe(1);
		expect(wheel(0, { deltaX: -30 })).toBe(1);
		expect(wheel(5, { deltaX: 50 })).toBe(1);
		expect(wheel(-5, { deltaX: 50 })).toBe(1);
		// Mostly up or down, with a little drift: it zooms.
		expect(wheel(-40, { deltaX: 6 })).toBeGreaterThan(1);
		expect(wheel(0)).toBe(1);
	});

	test("a notch of a mouse wheel is the 10 % it was, whatever the webview calls a notch", () => {
		for (const notch of [40, 100, 120]) {
			expect(wheel(-notch)).toBeCloseTo(1.1, 10);
			expect(wheel(notch)).toBeCloseTo(1 / 1.1, 10);
		}
		// In and out by the same turn come back to where they started (1.1 × 0.9 did not).
		expect(wheel(-40) * wheel(40)).toBeCloseTo(1, 12);
	});

	test("many small events add up to what one large one does for the same distance", () => {
		// A trackpad's 40 pixels in ten events: one notch in all. At 10 % an event it was ×2.6.
		const steps = Array.from({ length: 10 }, () => wheel(-4));
		expect(steps.every((f) => f > 1 && f < 1.02)).toBe(true);
		expect(steps.reduce((a, b) => a * b, 1)).toBeCloseTo(1.1, 10);
		expect(wheel(-20)).toBeCloseTo(Math.sqrt(1.1), 10);
	});

	test("one event zooms by a notch at the most, however far it says it went", () => {
		expect(wheel(-5000)).toBeCloseTo(1.1, 10);
		expect(wheel(5000)).toBeCloseTo(1 / 1.1, 10);
	});

	test("a wheel that counts in lines or pages is read in its own unit", () => {
		// Three lines are a notch; one line is a third of the way there.
		expect(wheel(-3, { deltaMode: 1 })).toBeCloseTo(1.1, 10);
		expect(wheel(-1, { deltaMode: 1 })).toBeCloseTo(1.1 ** 0.4, 10);
		expect(wheel(1, { deltaMode: 2 })).toBeCloseTo(1 / 1.1, 10);
		expect(wheel(0, { deltaX: 1, deltaMode: 1 })).toBe(1);
	});

	test("a pinch follows the fingers, and Ctrl with a mouse wheel is a notch like any other", () => {
		expect(wheel(-5, { ctrlKey: true })).toBeCloseTo(Math.exp(0.05), 10);
		expect(wheel(5, { ctrlKey: true })).toBeCloseTo(Math.exp(-0.05), 10);
		expect(wheel(-100, { ctrlKey: true })).toBeCloseTo(1.1, 10);
	});

	test("a delta that is not a number changes nothing, and the point under the pointer stays where it is", () => {
		expect(wheel(Number.NaN)).toBe(1);
		const view = { x: 20, y: 20, scale: 1 };
		const zoomed = zoomAt(view, { x: 300, y: 200 }, wheel(-40), 0.05, 3);
		expect(zoomed.scale).toBeCloseTo(1.1, 10);
		// The content that was under (300, 200) is still under it.
		expect((300 - zoomed.x) / zoomed.scale).toBeCloseTo((300 - view.x) / view.scale, 10);
		expect((200 - zoomed.y) / zoomed.scale).toBeCloseTo((200 - view.y) / view.scale, 10);
	});

	test("GraphView zooms by that factor, and not at all when it is 1 (source only, as above)", () => {
		const src = readSrc("src/view/graph/GraphView.tsx");
		const handler = between(src, "onWheel={(e) => {", "onMouseDown={(e) => {");
		expect(handler).toContain("const factor = wheelZoom(e);\n\t\t\t\t\t\t\tif (factor === 1) return;");
		expect(handler).toContain("zoomBy(factor, { x: e.clientX - box.left, y: e.clientY - box.top });");
		expect(src).not.toContain("e.deltaY < 0 ? 1.1 : 0.9");
	});
});

describe("Call graph — a failed layout's notice goes when a layout succeeds (finding 5a)", () => {
	test("GraphView takes the notice back before it draws the new layout (source only, as above)", () => {
		const src = readSrc("src/view/graph/GraphView.tsx");
		const cleared = src.indexOf('if (progress().startsWith("Layout failed: ")) setProgress("");');
		const drawn = src.indexOf("setLayout({ boxes, lines, width: result.width, height: result.height, key: layoutKey });");
		const said = src.indexOf("setProgress(`Layout failed: ${e?.message ?? e}`);");
		expect(cleared).toBeGreaterThan(0);
		// In the layout's own run, after the last point it can be superseded at, and before the failure branch.
		expect(cleared).toBeLessThan(drawn);
		expect(drawn).toBeLessThan(said);
		expect(src.slice(src.lastIndexOf("if (run !== layoutRun) return;", cleared), cleared)).not.toContain("await ");
	});
});

// --- 2. Agent: "Review diff…" reads its target, and holds the proposal against it again before writing -----

describe("Agent — Review diff refuses a target it cannot read, and one that changed (finding 2)", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	const target = "/ws/src/Due.ssl";
	const reply = "Here is the change:\n\n```ssl\n:RETURN 2;\n```\n";
	/** A backend with one file, as text or not, readable or not; and what was written to it. */
	const disk = (file: { text?: string; binary?: boolean; unreadable?: string }) => {
		const side = { file, reads: 0, writes: [] as { path: string; text: string }[] };
		rpcHandler = (method, args) => {
			if (method === "read") {
				side.reads++;
				if (side.file.unreadable) throw new Error(side.file.unreadable);
				return side.file.binary ? { path: String(args[0]), text: "", mtime: 1, binary: { size: 2048 } } : { path: String(args[0]), text: side.file.text ?? "", mtime: 1, encoding: "utf-8" };
			}
			if (method === "write") {
				side.writes.push({ path: String(args[0]), text: String(args[1]) });
				return { mtime: 2 };
			}
			return null;
		};
		return side;
	};
	/** "Review diff…" on the reply, against the file the turn was about. */
	const ask = async () => {
		chooseHandler = (_prompt, options) => options?.[0] ?? null;
		await reviewProposedEdit(reply, target);
		flush();
		return review();
	};

	test("a file that is not text is refused out loud, and no comparison is opened", async () => {
		const side = disk({ binary: true });
		expect(await ask()).toBeNull();
		expect(notices()).toEqual(["src/Due.ssl is not text, so the reply was not compared with it. Nothing was changed."]);
		expect(side.writes).toEqual([]);
	});

	test("a file that cannot be read is refused out loud, with the reason, and no comparison is opened", async () => {
		const side = disk({ unreadable: "permission denied" });
		// It used to be compared as an empty file: the whole reply showed as new, and Accept wrote it over the file.
		expect(await ask()).toBeNull();
		expect(notices().length).toBe(1);
		expect(notices()[0]).toMatch(/^src\/Due\.ssl could not be read \(.*permission denied.*\), so the reply was not compared with it\. Nothing was changed\.$/);
		expect(side.writes).toEqual([]);
	});

	test("a file that reads is compared with what it holds, and accepting writes the proposal", async () => {
		const side = disk({ text: ":RETURN 1;\n" });
		const open = await ask();
		expect(open?.original).toBe(":RETURN 1;\n");
		expect(open?.proposed).toBe(":RETURN 2;\n");
		await open!.onAccept(open!.proposed);
		expect(side.writes).toEqual([{ path: target, text: ":RETURN 2;\n" }]);
	});

	test("a file changed on disk after the proposal was made is said so, and nothing is written", async () => {
		const side = disk({ text: ":RETURN 1;\n" });
		const open = await ask();
		side.file = { text: ":RETURN 1;\n/* added meanwhile;\n" };
		await expect(Promise.resolve().then(() => open!.onAccept(open!.proposed))).rejects.toThrow("src/Due.ssl was changed after this proposal was made. Nothing was written: reject, and ask for Review diff again so the changes are not overwritten.");
		expect(side.writes).toEqual([]);
		// Put back as it was, the proposal is for the file again.
		side.file = { text: ":RETURN 1;\n" };
		await open!.onAccept(open!.proposed);
		expect(side.writes.length).toBe(1);
	});

	test("a file that stopped being readable, or being text, after the proposal is said so, and nothing is written", async () => {
		const side = disk({ text: ":RETURN 1;\n" });
		const open = await ask();
		side.file = { unreadable: "no such file" };
		await expect(Promise.resolve().then(() => open!.onAccept(open!.proposed))).rejects.toThrow(/^src\/Due\.ssl can no longer be read \(.*no such file.*\)\. Nothing was written: reject, and ask for Review diff again\.$/);
		side.file = { binary: true };
		await expect(Promise.resolve().then(() => open!.onAccept(open!.proposed))).rejects.toThrow("src/Due.ssl is no longer text. Nothing was written: reject, and ask for Review diff again.");
		expect(side.writes).toEqual([]);
	});

	test("an open file is compared as its editor has it, and an edit made there after the proposal stops the accept", async () => {
		const side = disk({ text: ":RETURN 1;\n" });
		await openFile(target, { keep: true });
		flush();
		const model = documents.get(target)!.model as any;
		const open = await ask();
		expect(open?.original).toBe(":RETURN 1;\n");
		// Typed in the editor while the review stood open.
		model.pushEditOperations([], [{ range: new FakeRange(1, 1, 1, 1), text: "/* mine; */ " }], () => null);
		await expect(Promise.resolve().then(() => open!.onAccept(open!.proposed))).rejects.toThrow(/was changed after this proposal was made/);
		expect(model.getValue()).toBe("/* mine; */ :RETURN 1;\n");
		expect(side.writes).toEqual([]);
	});

	test("the refusal, as a rule: unreadable, not text, changed since; null when the file is as it was compared", () => {
		expect(reviewTargetRefusal("a.ssl", { text: "x" })).toBeNull();
		expect(reviewTargetRefusal("a.ssl", { text: "x" }, "x")).toBeNull();
		expect(reviewTargetRefusal("a.ssl", { text: "y" }, "x")).toContain("was changed after this proposal was made");
		// An empty file is a file: compared with it, the whole reply is new, and that is right.
		expect(reviewTargetRefusal("a.ssl", { text: "" })).toBeNull();
		expect(reviewTargetRefusal("a.bin", { refused: "binary" })).toBe("a.bin is not text, so the reply was not compared with it. Nothing was changed.");
		expect(reviewTargetRefusal("a.ssl", { refused: "unreadable" })).toBe("a.ssl could not be read, so the reply was not compared with it. Nothing was changed.");
		expect(reviewTargetRefusal("a.ssl", { refused: "unreadable", reason: "busy" }, "x")).toBe("a.ssl can no longer be read (busy). Nothing was written: reject, and ask for Review diff again.");
	});
});

// --- 5c. Agent: where a session ends, the transcript says so --------------------------------------------------

describe("Agent — a thread carried on in a new session says where the new session starts (finding 5c)", () => {
	beforeAll(connectTestRpc);
	afterAll(async () => {
		// The store is the whole run's: left with no folder and no conversation, as it starts.
		syncWorkspaceThreads(null);
		flush();
		await disconnectTestRpc();
	});
	beforeEach(() => {
		resetAll();
		syncWorkspaceThreads(null);
		flush();
	});

	// Through localStorage itself: an earlier test file of the run may have set it up over a map of its own.
	const key = (root: string) => `agent.threads.v1:${root}`;
	const said = () => snapshot(agent).entries.map((e) => `${e.role}: ${e.text}`);
	const thread = (id: string, updatedAt: number, entries: { role: string; text: string }[]) => ({ id, title: id, updatedAt, entries });

	test("the rule: a reply on screen since the last such line is what the next session will not know", () => {
		expect(sessionBreakDue([])).toBe(false);
		expect(sessionBreakDue([{ role: "user", text: "Why is it slow?" }])).toBe(false);
		expect(sessionBreakDue([{ role: "user", text: "Why is it slow?" }, { role: "note", text: "failed: opencode is not ready." }])).toBe(false);
		expect(sessionBreakDue([{ role: "user", text: "Why is it slow?" }, { role: "agent", text: "The loop reads every row." }])).toBe(true);
		// A reply still empty (nothing streamed yet) is nothing to mark off.
		expect(sessionBreakDue([{ role: "user", text: "Why?" }, { role: "agent", text: "  " }])).toBe(false);
		// Already marked off, and nothing answered since: one line, not two.
		expect(sessionBreakDue([{ role: "agent", text: "The loop reads every row." }, { role: "note", text: SESSION_BREAK }])).toBe(false);
		expect(sessionBreakDue([{ role: "agent", text: "a" }, { role: "note", text: SESSION_BREAK }, { role: "user", text: "And now?" }])).toBe(false);
		expect(sessionBreakDue([{ role: "agent", text: "a" }, { role: "note", text: SESSION_BREAK }, { role: "user", text: "And now?" }, { role: "agent", text: "b" }])).toBe(true);
		expect(SESSION_BREAK).toBe("A new session starts here: the model does not know the messages above.");
		expect(isSessionBreak({ role: "note", text: SESSION_BREAK })).toBe(true);
		expect(isSessionBreak({ role: "agent", text: SESSION_BREAK })).toBe(false);
	});

	test("a thread restored when its folder is opened ends with the line, and has no session", () => {
		localStorage.setItem(key("/lows-restored"), JSON.stringify([thread("thr_a", 2, [{ role: "user", text: "Why is it slow?" }, { role: "agent", text: "The loop reads every row." }])]));
		const before = chatSessionEpoch();
		syncWorkspaceThreads("/lows-restored");
		flush();
		expect(said()).toEqual(["user: Why is it slow?", "agent: The loop reads every row.", `note: ${SESSION_BREAK}`]);
		expect(snapshot(agent).chatSession).toBeNull();
		expect(chatSessionEpoch()).toBeGreaterThan(before);
	});

	test("a thread saved with the line at its end is restored with one line, not two", () => {
		localStorage.setItem(key("/lows-twice"), JSON.stringify([thread("thr_a", 2, [{ role: "user", text: "Why?" }, { role: "agent", text: "Because." }, { role: "note", text: SESSION_BREAK }])]));
		syncWorkspaceThreads("/lows-twice");
		flush();
		expect(said().filter((line) => line === `note: ${SESSION_BREAK}`).length).toBe(1);
	});

	test("a thread switched to ends with the line; a new conversation, and a thread with no reply in it, have none", () => {
		localStorage.setItem(
			key("/lows-switch"),
			JSON.stringify([thread("thr_new", 5, [{ role: "user", text: "Only asked" }]), thread("thr_old", 1, [{ role: "user", text: "Earlier" }, { role: "agent", text: "Earlier answer" }])]),
		);
		syncWorkspaceThreads("/lows-switch");
		flush();
		// The latest thread is the one restored: a question nobody answered.
		expect(said()).toEqual(["user: Only asked"]);
		switchThread("thr_old");
		flush();
		expect(said()).toEqual(["user: Earlier", "agent: Earlier answer", `note: ${SESSION_BREAK}`]);
		startNewThread();
		flush();
		expect(said()).toEqual([]);
	});

	test("opencode stopped under a conversation marks it off once, however often it is said to be off", async () => {
		syncWorkspaceThreads("/lows-stopped");
		setAgent((s) => {
			s.entries = [
				{ id: 9001, role: "user", text: "Why is it slow?" },
				{ id: 9002, role: "agent", text: "The loop reads every row." },
			];
			s.chatSession = "ses_1";
		});
		flush();
		rpcHandler = (method, args) => (method === "agent" && args[0] === "stop" ? { state: "off" } : null);
		await stopAgent();
		await stopAgent();
		flush();
		expect(said()).toEqual(["user: Why is it slow?", "agent: The loop reads every row.", `note: ${SESSION_BREAK}`]);
		expect(snapshot(agent).chatSession).toBeNull();
		clearEntries();
		flush();
	});

	test("the panel draws that note as a line across the thread (source only: the panel needs a DOM)", () => {
		const src = readSrc("src/view/agent/Agent.tsx");
		expect(src).toContain("<Show when={isSessionBreak(e)} fallback={<EntryView entry={e} />}>\n\t\t\t\t\t\t\t<SessionBreakLine text={e.text} />");
		const line = between(src, "function SessionBreakLine(props: { text: string }) {", "function EntryView(props: { entry: Entry }) {");
		// A note among the thread's notes (its colour and size are theirs), under a rule across the thread.
		expect(line).toContain('<div class="entry note" style={{ "border-top": "1px solid var(--border)", "padding-top": "var(--space-3)", "text-align": "center" }}>');
		expect(line).toContain("<pre>{props.text}</pre>");
	});
});

// --- 6. View core: what is kept for a folder is written into that folder, or not at all ------------------------

describe("View core — a layout save still waiting when another folder is opened (finding 6)", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	const layout = { ...structuredClone(DEFAULT_SETTINGS.layout), leftWidth: 333 };
	/** A backend that, like the real one, writes a folder's settings into the folder it is in itself. */
	const backendSide = () => {
		let open!: () => void;
		const side = {
			root: "/ws",
			saves: [] as { into: string; patch: unknown }[],
			calls: [] as string[],
			/** Opening a folder waits here, after the backend has moved and before the view is told. */
			held: new Promise<void>((resolve) => (open = resolve)),
			letGo: () => open(),
			refuses: false,
		};
		rpcHandler = async (method, args) => {
			side.calls.push(method);
			if (method === "settings") return { effective: DEFAULT_SETTINGS, user: {}, workspace: {} };
			if (method === "themes") return [];
			if (method === "info") return { app: "0.1.0", selftest: true };
			if (method === "lspState") return { state: "stopped" };
			if (method === "saveSettings") {
				side.saves.push({ into: side.root, patch: args[1] });
				return DEFAULT_SETTINGS;
			}
			if (method === "openFolder") {
				if (!side.refuses) side.root = String(args[0]);
				await side.held;
				if (side.refuses) throw new Error("the folder could not be opened");
				return { root: side.root, name: side.root.slice(1) };
			}
			return null;
		};
		return side;
	};
	/** What App.tsx asks for when the layout has changed: a save for this folder, a moment from now. */
	const keepLayout = (root: string, after: number) => keepForFolder(root, () => backend.saveSettings("workspace", { layout }), after);

	test("it is written before the backend is sent to the other folder, into the folder it was made in", async () => {
		const side = backendSide();
		keepLayout("/ws", 30);
		const opening = openFolder("/other");
		await until(() => side.calls.includes("openFolder"));
		// The backend is in /other and the view has not heard yet: the gap the save used to be sent in, by its timer.
		expect(side.root).toBe("/other");
		expect(snapshot(state).workspace?.root).toBe("/ws");
		await tick(60);
		side.letGo();
		await opening;
		flush();
		await tick(60);
		expect(snapshot(state).workspace?.root).toBe("/other");
		// Once, and into /ws: never into the folder that was being opened.
		expect(side.saves).toEqual([{ into: "/ws", patch: { layout } }]);
		expect(side.calls.indexOf("saveSettings")).toBeLessThan(side.calls.indexOf("openFolder"));
	});

	test("one that comes due while a folder is being opened waits, and is dropped when that folder opens", async () => {
		const side = backendSide();
		const opening = openFolder("/other");
		await until(() => side.calls.includes("openFolder"));
		keepLayout("/ws", 5);
		await tick(40);
		expect(side.saves).toEqual([]);
		side.letGo();
		await opening;
		flush();
		await tick(40);
		expect(snapshot(state).workspace?.root).toBe("/other");
		expect(side.saves).toEqual([]);
	});

	test("one that waited is written after all when the opening is called off, into its own folder", async () => {
		const side = backendSide();
		side.refuses = true;
		const opening = openFolder("/other");
		await until(() => side.calls.includes("openFolder"));
		keepLayout("/ws", 5);
		await tick(40);
		expect(side.saves).toEqual([]);
		side.letGo();
		await opening;
		flush();
		await until(() => side.saves.length === 1);
		expect(snapshot(state).workspace?.root).toBe("/ws");
		expect(side.saves).toEqual([{ into: "/ws", patch: { layout } }]);
	});

	test("with no folder being opened it is written when it is due, once; called off, or made for another folder, never", async () => {
		const side = backendSide();
		keepLayout("/ws", 5);
		const off = keepLayout("/ws", 5);
		off();
		keepLayout("/elsewhere", 5);
		await tick(40);
		expect(side.saves).toEqual([{ into: "/ws", patch: { layout } }]);
	});

	test("App.tsx keeps the layout through it, with no timer of its own (source only: the window needs a DOM)", () => {
		const src = readSrc("src/view/App.tsx");
		const persistence = between(src, "function useLayoutPersistence(", "/** One panel by id, whichever side it is docked on. */");
		expect(persistence).toContain('return keepForFolder(targetRoot, () =>\n\t\t\t\tbackend.saveSettings("workspace", { layout: JSON.parse(layout) }).then(');
		expect(persistence).not.toContain("setTimeout(");
	});
});

// --- 7. View core: a setting that was never saved does not stay on screen --------------------------------------

describe("View core — a settings save that fails, with the disk unreadable after it (finding 7)", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	const settingsWith = (keys: Record<string, string>) => ({ ...structuredClone(DEFAULT_SETTINGS), keys });
	const reading = (keys: Record<string, string>) => {
		rpcHandler = (method) => (method === "settings" ? { effective: settingsWith(keys), user: {}, workspace: {} } : method === "themes" ? [] : null);
	};
	const backNotice = /The settings could not be read back after the save failed \(.*the settings file is locked.*\)\. What is shown is what was last known to be saved\./;

	test("what is shown goes back to what was last read from disk, and both failures are said", async () => {
		reading({ save: "ctrl+s" });
		await loadSettings(true);
		flush();
		expect(snapshot(state).settings.keys).toEqual({ save: "ctrl+s" });
		rpcHandler = (method) => {
			if (method === "saveSettings") throw new Error("the disk is full");
			if (method === "settings") throw new Error("the settings file is locked");
			return null;
		};
		// A shortcut is shown at once, before its save answers (state.ts, WORKED_OUT_HERE).
		const saving = saveSetting({ keys: { save: "ctrl+k" } });
		expect(snapshot(state).settings.keys).toEqual({ save: "ctrl+k" });
		expect(await saving).toBeUndefined();
		flush();
		// It used to stay: ctrl+k on screen, ctrl+s on disk, and nothing to tell them apart.
		expect(snapshot(state).settings.keys).toEqual({ save: "ctrl+s" });
		expect(notices().some((text) => text.includes("the disk is full"))).toBe(true);
		expect(notices().some((text) => backNotice.test(text))).toBe(true);
	});

	test("a settings file that does not read as settings is said when the settings are read, once", async () => {
		const problem = "/home/someone/.config/ssl-studio/settings.json does not read as settings (line 4, column 1: A comma is followed by another name, not by }.), so none of its settings are used. It is not written over until it is mended by hand, or removed.";
		const answering = (problems?: string[]) => {
			rpcHandler = (method) => (method === "settings" ? { effective: settingsWith({}), user: {}, workspace: {}, ...(problems ? { problems } : {}) } : method === "themes" ? [] : null);
		};
		// A notice said again takes the place of the one with its words, under a new id: the id tells the two apart.
		const said = () => snapshot(state).messages.filter((m) => m.text === problem).map((m) => m.id);
		answering([problem]);
		await loadSettings(true);
		flush();
		expect(notices()).toEqual([problem]);
		const first = said();
		// Read again while it is still broken (a folder opened, a save answered): not said a second time.
		await loadSettings();
		flush();
		expect(said()).toEqual(first);
		// Mended, then broken anew: said again.
		answering();
		await loadSettings();
		answering([problem]);
		await loadSettings();
		flush();
		expect(said().length).toBe(1);
		expect(said()).not.toEqual(first);
	});

	test("what was last known to be saved is the last save that answered, not what was read when the folder opened", async () => {
		reading({ save: "ctrl+s" });
		await loadSettings(true);
		flush();
		rpcHandler = (method) => (method === "saveSettings" ? settingsWith({ save: "ctrl+j" }) : null);
		await saveSetting({ keys: { save: "ctrl+j" } });
		flush();
		rpcHandler = (method) => {
			if (method === "saveSettings") throw new Error("the disk is full");
			if (method === "settings") throw new Error("the settings file is locked");
			return null;
		};
		await saveSetting({ keys: { save: "ctrl+k" } });
		flush();
		expect(snapshot(state).settings.keys).toEqual({ save: "ctrl+j" });
		// The record is its own copy: what was done on screen since has not changed it.
		await saveSetting({ keys: { save: "ctrl+l", open: "ctrl+o" } });
		flush();
		expect(snapshot(state).settings.keys).toEqual({ save: "ctrl+j" });
	});

	test("a failed save whose reading of the disk goes through shows the disk, and says nothing more than the save's failure", async () => {
		reading({ save: "ctrl+s" });
		await loadSettings(true);
		flush();
		rpcHandler = (method) => {
			if (method === "saveSettings") throw new Error("the disk is full");
			if (method === "settings") return { effective: settingsWith({ save: "ctrl+d" }), user: {}, workspace: {} };
			return null;
		};
		await saveSetting({ keys: { save: "ctrl+k" } });
		flush();
		expect(snapshot(state).settings.keys).toEqual({ save: "ctrl+d" });
		expect(notices().some((text) => text.includes("could not be read back"))).toBe(false);
	});

	test("the layout on screen is the view's own, and is not put back with the rest", async () => {
		reading({ save: "ctrl+s" });
		await loadSettings(true);
		setState((s) => {
			s.settings.layout.leftWidth = 412;
		});
		flush();
		rpcHandler = (method) => {
			if (method === "saveSettings") throw new Error("the disk is full");
			if (method === "settings") throw new Error("the settings file is locked");
			return null;
		};
		await saveSetting({ keys: { save: "ctrl+k" } });
		flush();
		expect(snapshot(state).settings.keys).toEqual({ save: "ctrl+s" });
		expect(snapshot(state).settings.layout.leftWidth).toBe(412);
	});
});

// --- 8. Agent: a status the front-matter writer would not set is said ------------------------------------------

describe("Agent — an answer written into a question whose status could not be set (finding 8)", () => {
	const answer = "Use the due date of the sample, not of the order.";

	test("a status on one line is set, and the answer is written under ## Answer", () => {
		const doc = "---\ntitle: Which date?\nstatus: open\n---\n\n# Which date?\n\n## Answer\n";
		const done = answeredQuestion(doc, answer, true);
		expect(done.unmarked).toBe(false);
		expect(done.text).toContain("status: answered\n");
		expect(done.text).toContain(`## Answer\n\n${answer}\n`);
	});

	test("a status written over several lines is left as it is: the answer is written, and it is said to be unmarked", () => {
		const doc = "---\ntitle: Which date?\nstatus: >\n  open, waiting\n  for the lab\n---\n\n# Which date?\n\n## Answer\n";
		const done = answeredQuestion(doc, answer, true);
		expect(done.unmarked).toBe(true);
		expect(done.text).toContain("status: >\n  open, waiting\n  for the lab\n---\n");
		expect(done.text).not.toContain("answered");
		expect(done.text).toContain(`## Answer\n\n${answer}\n`);
	});

	test("front matter that is never closed is left as it is too, and said", () => {
		const doc = "---\ntitle: Which date?\nstatus: open\n\n# Which date?\n";
		const done = answeredQuestion(doc, answer, true);
		expect(done.unmarked).toBe(true);
		expect(done.text.startsWith("---\ntitle: Which date?\nstatus: open\n")).toBe(true);
		expect(done.text).toContain(answer);
	});

	test("an answer that is only written, not marked, touches no status and has nothing to say", () => {
		const doc = "---\nstatus: >\n  open\n---\n\n## Answer\n";
		expect(answeredQuestion(doc, answer, false)).toEqual({ text: `---\nstatus: >\n  open\n---\n\n## Answer\n\n${answer}\n`, unmarked: false });
	});

	test("the panel says it, as an error that stays (source only: the action is a button of the panel)", () => {
		const src = readSrc("src/view/agent/Agent.tsx");
		const action = between(src, "const answerOpenQuestion = async () => {", "\n\treturn (\n\t\t<div class={[\"entry\", props.entry.role");
		expect(action).toContain("const { text: next, unmarked } = answeredQuestion(cur, props.entry.text, action === WRITE_MARK);");
		expect(action).toContain('if (unmarked) notify(`Recorded answer in ${target.title || baseName(target.path)}, but it was not marked answered: its status is written over several lines, or its front matter is not closed. Change the status in the text.`, "error");');
		// The writer's refusal is no longer passed over.
		expect(src).not.toContain('withFrontMatter(next, "status", "answered") ?? next');
	});
});
