import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reconcile } from "solid-js/store";
import { findCommentDocRefsInLines } from "../src/shared/editorDocHelpers";
import { imageType, looksBinary } from "../src/shared/fileKind";
import { DEFAULT_SETTINGS, type DocFile } from "../src/shared/protocol";
import { fileTarget } from "../src/shared/quickPrefix";
import { docsGoverningFile, extractSection, scriptsForTicket, ticketWork, workFor, workText } from "../src/shared/workContext";
import { workList } from "../src/shared/workList";
import { bindable, displayKey, effectiveKeys, keyNames, keyNamesForPlatform, rebind } from "../src/view/keys";
import { CENTER_MIN, fitPanels, LEFT_MIN, RIGHT_MIN } from "../src/view/layout";
import { fileTier } from "../src/view/quickRank";

// --- Headless browser & Monaco shims (compatible superset of r2cEditorTabsState.test.ts) ---
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
		innerWidth: 1280,
		innerHeight: 900,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5191" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
} else if (!(globalThis as any).window.Error) {
	(globalThis as any).window.Error = Error;
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
			for (const edit of edits) this._value = edit.text;
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

const { backend, connect, on } = await import("../src/view/backend");
const { remember } = await import("../src/view/graph/canvas");
const { packTabs, tabsKey } = await import("../src/view/editor/sessionTabs");
const { isInMarkdownTextEditor } = await import("../src/view/editor/liveBridge");
const { editors } = await import("../src/view/editor/EditorGroup");
const { session } = await import("../src/view/lsp/session");
const {
	closeTab,
	documents,
	fileChangedOnDisk,
	fileRenamed,
	loadSettings,
	newUntitled,
	openFile,
	openFolder,
	pathChanges,
	restoreTabs,
	revert,
	save,
	saveSetting,
	sendTabAcross,
	setState,
	state,
	takeReveal,
	unsavedPaths,
} = await import("../src/view/state");
const { removeRecentGroup, resetRecentTabs, stepRecent, tabShown } = await import("../src/view/recentTabs");
const { goAlong, noteCursor } = await import("../src/view/navigation");
const { newDocIn, setUpProject, undoSetUp } = await import("../src/view/project");
const { copyPath, defaultKeysForPlatform, MARKDOWN_TEXT_KEYS, resolveCommandKey, runCommand } = await import("../src/view/commands");

// --- In-process MockSocket RPC driver for real src/view/backend.ts ---
type RpcHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;
let rpcHandler: RpcHandler = () => null;
let failNextConnect = false;
let activeSockets: TestRpcSocket[] = [];

class TestRpcSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = 0;
	constructor(_url: string) {
		super();
		activeSockets.push(this);
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
let savedDocument: unknown;

async function connectTestRpc() {
	savedWebSocket = globalThis.WebSocket;
	savedLocation = (globalThis as any).location;
	savedDocument = (globalThis as any).document;
	(globalThis as any).WebSocket = TestRpcSocket;
	(globalThis as any).location = { protocol: "http:", host: "127.0.0.1:5191" };
	if (!(globalThis as any).document) {
		(globalThis as any).document = { documentElement: { dataset: {}, style: {} }, activeElement: null, createElement: () => ({ style: {} }), querySelector: () => null };
	}
	failNextConnect = false;
	activeSockets = [];
	await connect();
}

async function disconnectTestRpc() {
	failNextConnect = true;
	await connect().catch(() => {});
	failNextConnect = false;
	(globalThis as any).WebSocket = savedWebSocket;
	(globalThis as any).location = savedLocation;
	(globalThis as any).document = savedDocument;
}

function resetAppState() {
	for (const doc of [...documents.values()]) doc.model?.dispose?.();
	documents.clear();
	fakeModels.clear();
	editors.length = 0;
	storage.clear();
	resetRecentTabs();
	askHandler = () => null;
	chooseHandler = () => null;
	rpcHandler = () => null;
	setState("workspace", { root: "/ws", name: "ws" });
	setState("project", { root: "/ws", path: "/ws/.ssl-studio/project.toml", configured: true, docs: "docs", plans: "design", schema: "schema" } as any);
	setState("groups", [{ tabs: [], active: null }]);
	setState("activeGroup", 0);
	setState("dirty", reconcile({}));
	setState("conflicts", reconcile({}));
	setState("messages", []);
	setState("lsp", reconcile({ state: "stopped" }));
	setState("settings", reconcile(structuredClone(DEFAULT_SETTINGS)));
	setState("bottomMaximized", false);
	setState("centerView", "editors");
	setState("info", null);
}

// =============================================================================
// 1. P0 — SolidJS createStore shallow-merge traps (state.ts)
// =============================================================================
describe("R8C P0 — SolidJS createStore reconcile() fixes in state.ts", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAppState);

	test("openFolder() clears stale dirty, conflicts, bottomMaximized, and lsp.message via reconcile()", async () => {
		setState("dirty", "/ws/old.ssl", true);
		setState("conflicts", "/ws/old.ssl", true);
		setState("bottomMaximized", true);
		setState("lsp", reconcile({ state: "error", message: "old crash" } as any));

		chooseHandler = () => "Discard changes";
		rpcHandler = (method, args) => {
			if (method === "openFolder") return { root: String(args[0]), name: "ws2" };
			if (method === "settings") return { effective: DEFAULT_SETTINGS };
			if (method === "themes") return [];
			if (method === "project") return null;
			if (method === "info") return { app: "0.1.0", selftest: true };
			if (method === "lspState") return { state: "stopped" };
			return null;
		};

		await openFolder("/ws2");

		expect(Object.keys(state.dirty)).toEqual([]);
		expect(unsavedPaths()).toEqual([]);
		expect(Object.keys(state.conflicts)).toEqual([]);
		expect(state.bottomMaximized).toBe(false);
		expect(state.lsp).toEqual({ state: "stopped" });
		expect((state.lsp as any).message).toBeUndefined();
	});

	test("loadSettings() and saveSetting() remove cleared optional keys via reconcile()", async () => {
		setState("settings", reconcile({ ...DEFAULT_SETTINGS, activeTicket: "DEMO-101", wordWrap: true, sqlDialect: "tsql" } as any));
		expect(state.settings.activeTicket).toBe("DEMO-101");
		expect(state.settings.wordWrap).toBe(true);

		rpcHandler = (method) => {
			if (method === "saveSettings") return { ...DEFAULT_SETTINGS };
			if (method === "settings") return { effective: { ...DEFAULT_SETTINGS } };
			if (method === "themes") return [];
			return null;
		};

		await saveSetting({ activeTicket: null });
		expect("activeTicket" in state.settings).toBe(false);
		expect(state.settings.activeTicket).toBeUndefined();
		expect("wordWrap" in state.settings).toBe(false);
		expect("sqlDialect" in state.settings).toBe(false);

		setState("settings", "activeTicket", "OLD-99");
		await loadSettings(false);
		expect("activeTicket" in state.settings).toBe(false);
		expect(state.settings.activeTicket).toBeUndefined();
	});
});

// =============================================================================
// 2. P0 — Untitled save overwrite confirmation, closeTab promotion, & in-flight save() race
// =============================================================================
describe("R8C P0 — untitled save overwrite safety & in-flight save() race", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAppState);

	test("saving untitled onto existing disk file or open doc prompts Overwrite and aborts unless confirmed", async () => {
		let writes = 0;
		rpcHandler = (method, args) => {
			if (method === "sizes") return { [String((args[0] as string[])[0])]: 42 };
			if (method === "create") return null;
			if (method === "write") {
				writes++;
				return { mtime: 99 };
			}
			return null;
		};

		const u = newUntitled(0, "ssl");
		documents.get(u)!.model.setValue("NEW CODE");
		askHandler = () => "existing.ssl";

		// 1. User cancels overwrite dialog -> no write, untitled buffer stays intact
		const prompts: string[] = [];
		chooseHandler = (msg) => {
			prompts.push(msg);
			return null;
		};
		expect(await save(u)).toBe(false);
		expect(writes).toBe(0);
		expect(prompts.length).toBe(1);
		expect(documents.has(u)).toBe(true);
		expect(state.groups[0]!.tabs).toEqual([u]);

		// 2. User confirms Overwrite -> writes and promotes cleanly
		chooseHandler = () => "Overwrite";
		expect(await save(u)).toBe(true);
		expect(writes).toBe(1);
		expect(documents.has(u)).toBe(false);
		expect(documents.has("/ws/existing.ssl")).toBe(true);
		expect(state.groups[0]!.tabs).toEqual(["/ws/existing.ssl"]);
	});

	test("closing a dirty untitled tab and choosing Save promotes AND closes the newly saved tab", async () => {
		rpcHandler = (method) => {
			if (method === "sizes") return {};
			if (method === "create") return null;
			if (method === "write") return { mtime: 101 };
			return null;
		};

		const u = newUntitled(0, "ssl");
		documents.get(u)!.model.setValue(":RETURN 1;");
		expect(state.dirty[u]).toBe(true);

		chooseHandler = () => "Save";
		askHandler = () => "saved_on_close.ssl";

		const closed = await closeTab(u, 0);
		expect(closed).toBe(true);
		expect(state.groups[0]!.tabs).toEqual([]);
		expect(documents.has(u)).toBe(false);
		expect(documents.has("/ws/saved_on_close.ssl")).toBe(false);
	});

	test("closing an untitled tab emits pathChanges.gone so navigation drops it", async () => {
		const goneChecks: ((p: string) => boolean)[] = [];
		const listener = (fn: (p: string) => boolean) => goneChecks.push(fn);
		pathChanges.gone.add(listener);
		try {
			const u = newUntitled(0, "ssl");
			expect(await closeTab(u, 0, { discard: true })).toBe(true);
			expect(goneChecks.some((fn) => fn(u))).toBe(true);
		} finally {
			pathChanges.gone.delete(listener);
		}
	});

	test("edits typed while save() is in flight keep state.dirty[path] true and preserve savedText", async () => {
		let resolveWrite!: (v: { mtime: number }) => void;
		rpcHandler = (method) => {
			if (method === "read") return { text: "v1", mtime: 10, encoding: "utf-8" };
			if (method === "write") {
				return new Promise((res) => {
					resolveWrite = res;
				});
			}
			return null;
		};

		await openFile("/ws/race.ssl");
		const doc = documents.get("/ws/race.ssl")!;
		doc.model.setValue("v2");
		expect(state.dirty["/ws/race.ssl"]).toBe(true);

		const saving = save("/ws/race.ssl", { format: false });
		await new Promise((r) => setTimeout(r, 15));

		// User types "v3" while backend.write("v2") is still in flight!
		doc.model.setValue("v3");

		resolveWrite({ mtime: 20 });
		expect(await saving).toBe(true);
		expect(doc.savedText).toBe("v2");
		expect(state.dirty["/ws/race.ssl"]).toBe(true);
	});
});

// =============================================================================
// 3. P1 — Workspace switch, cancel openFolder, watcher race, recentTabs, backend, project
// =============================================================================
describe("R8C P1 — workspace switch, cancel openFolder, watcher race, recentTabs, backend, project", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAppState);

	test("cancelling openFolder restarts live LSP via backend.lspRestart() for previous workspace without double-initializing", async () => {
		const started: string[] = [];
		const restarted: string[] = [];
		const origStart = session.start.bind(session);
		const origReset = session.reset.bind(session);
		(session as any).start = (root: string) => {
			started.push(root);
			return Promise.resolve();
		};
		(session as any).reset = () => origReset();
		try {
			setState("workspace", { root: "/ws-prev", name: "ws-prev" });
			setState("lsp", reconcile({ state: "running" }));
			rpcHandler = (method) => {
				if (method === "openFolder") return null;
				if (method === "lspRestart") {
					restarted.push("lspRestart");
					return null;
				}
				return null;
			};

			await openFolder();
			await new Promise((r) => setTimeout(r, 15));
			expect(restarted).toEqual(["lspRestart"]);
			// Direct session.start() must NOT be sent to the already-initialized starlims-lsp process.
			expect(started).toEqual([]);
		} finally {
			(session as any).start = origStart;
			(session as any).reset = origReset;
		}
	});

	test("monotonic openSeq prevents delayed workspace A from overwriting workspace B", async () => {
		let resolveA!: (v: any) => void;
		const started: string[] = [];
		const origStart = session.start.bind(session);
		(session as any).start = (root: string) => {
			started.push(root);
			return Promise.resolve();
		};
		try {
			rpcHandler = (method, args) => {
				if (method === "openFolder" && args[0] === "/wsA") return new Promise((r) => (resolveA = r));
				if (method === "openFolder" && args[0] === "/wsB") return { root: "/wsB", name: "wsB" };
				if (method === "settings") return { effective: DEFAULT_SETTINGS };
				if (method === "themes") return [];
				if (method === "project") return null;
				if (method === "info") return { app: "0.1.0", selftest: true };
				if (method === "lspState") return { state: "running" };
				return null;
			};

			const openA = openFolder("/wsA");
			await new Promise((r) => setTimeout(r, 10));
			await openFolder("/wsB");
			resolveA({ root: "/wsA", name: "wsA" });
			await openA;

			expect(state.workspace?.root).toBe("/wsB");
			expect(started).toEqual(["/wsB"]);
		} finally {
			(session as any).start = origStart;
		}
	});

	test("fileChangedOnDisk applies read content directly (single read) and never clobbers edits typed mid-read", async () => {
		let readCount = 0;
		let resolveSecondRead!: (v: any) => void;
		rpcHandler = (method) => {
			if (method === "read") {
				readCount++;
				if (readCount === 1) return { text: "initial", mtime: 1, encoding: "utf-8" };
				if (readCount === 2) return { text: "external-clean", mtime: 2, encoding: "utf-8" };
				return new Promise((r) => (resolveSecondRead = r));
			}
			return null;
		};

		await openFile("/ws/watch.ssl");
		const doc = documents.get("/ws/watch.ssl")!;

		// Clean external reload: does ONLY 1 backend.read (not 2 via revert!)
		await fileChangedOnDisk("/ws/watch.ssl");
		expect(readCount).toBe(2);
		expect(doc.model.getValue()).toBe("external-clean");
		expect(state.dirty["/ws/watch.ssl"]).toBe(false);

		// User edits while fileChangedOnDisk's read is in flight -> conflict, NOT overwritten!
		const watching = fileChangedOnDisk("/ws/watch.ssl");
		await new Promise((r) => setTimeout(r, 10));
		doc.model.setValue("my-unsaved-edit");
		expect(state.dirty["/ws/watch.ssl"]).toBe(true);
		resolveSecondRead({ text: "external-v3", mtime: 3, encoding: "utf-8" });
		await watching;

		expect(doc.model.getValue()).toBe("my-unsaved-edit");
		expect(state.conflicts["/ws/watch.ssl"]).toBe(true);

		// revert() ignores untitled paths safely
		const u = newUntitled(0, "ssl");
		documents.get(u)!.model.setValue("keep-untitled");
		await revert(u);
		expect(documents.get(u)!.model.getValue()).toBe("keep-untitled");
	});

	test("fileRenamed early-returns on identical path and deduplicates tabs; restoreTabs drops empty Group 0; sendTabAcross & newUntitled guard edge cases", async () => {
		rpcHandler = (method, args) => {
			if (method === "read" && args[0] === "/ws/deleted.ssl") throw new Error("ENOENT");
			if (method === "read") return { text: `body:${String(args[0])}`, mtime: 1, encoding: "utf-8" };
			return null;
		};

		await openFile("/ws/a.ssl");
		const docA = documents.get("/ws/a.ssl")!;
		fileRenamed("/ws/a.ssl", "/ws/a.ssl");
		expect(documents.get("/ws/a.ssl")).toBe(docA);

		// sendTabAcross is a no-op with 1 group and 1 tab
		sendTabAcross();
		expect(state.groups.length).toBe(1);
		expect(state.groups[0]!.tabs).toEqual(["/ws/a.ssl"]);

		// fileRenamed deduplicates when target is already open in the same group
		await openFile("/ws/b.ssl");
		fileRenamed("/ws/a.ssl", "/ws/b.ssl");
		expect(state.groups[0]!.tabs).toEqual(["/ws/b.ssl"]);

		// restoreTabs drops empty leading Group 0 when Group 1 still has valid files
		resetAppState();
		rpcHandler = (method, args) => {
			if (method === "read" && args[0] === "/ws/deleted.ssl") throw new Error("ENOENT");
			if (method === "read") return { text: `body:${String(args[0])}`, mtime: 1, encoding: "utf-8" };
			return null;
		};
		remember(
			tabsKey("/ws"),
			packTabs(
				[
					{ tabs: ["/ws/deleted.ssl"], active: "/ws/deleted.ssl" },
					{ tabs: ["/ws/alive.ssl"], active: "/ws/alive.ssl" },
				],
				1,
			),
		);
		await restoreTabs();
		expect(state.groups.length).toBe(1);
		expect(state.groups[0]!.tabs).toEqual(["/ws/alive.ssl"]);
		expect(state.activeGroup).toBe(0);

		// newUntitled guards !state.workspace and clamps group index
		setState("workspace", null);
		expect(newUntitled()).toBe("");
		setState("workspace", { root: "/ws", name: "ws" });
		const clamped = newUntitled(99, "ssl");
		expect(clamped).toMatch(/^untitled:Untitled-/);
		expect(state.activeGroup).toBe(0);
	});

	test("recentTabs steps synchronously A -> B -> C, tracks renames, and shifts group MRU on group removal", async () => {
		setState("groups", [
			{ tabs: ["/ws/a.ssl", "/ws/b.ssl", "/ws/c.ssl"], active: "/ws/c.ssl" },
			{ tabs: ["/ws/x.ssl", "/ws/y.ssl"], active: "/ws/y.ssl" },
		]);
		setState("activeGroup", 0);
		tabShown(0, "/ws/a.ssl");
		tabShown(0, "/ws/b.ssl");
		tabShown(0, "/ws/c.ssl");
		tabShown(1, "/ws/x.ssl");
		tabShown(1, "/ws/y.ssl");

		// Rapid Ctrl+Tab steps (hold = true) advance synchronously C -> B -> A
		stepRecent(1, true);
		expect(state.groups[0]!.active).toBe("/ws/b.ssl");
		stepRecent(1, true);
		expect(state.groups[0]!.active).toBe("/ws/a.ssl");

		// Rename updates MRU & active walk
		pathChanges.renamed.forEach((fn) => fn((p) => (p === "/ws/b.ssl" ? "/ws/b2.ssl" : p)));
		setState("groups", 0, "tabs", ["/ws/a.ssl", "/ws/b2.ssl", "/ws/c.ssl"]);
		stepRecent(-1, false);
		expect(state.groups[0]!.active).toBe("/ws/b2.ssl");

		// Removing group 0 shifts group 1's MRU to group 0 instead of inheriting group 0's MRU
		removeRecentGroup(0);
		setState("groups", [{ tabs: ["/ws/x.ssl", "/ws/y.ssl"], active: "/ws/y.ssl" }]);
		setState("activeGroup", 0);
		stepRecent(1, false);
		expect(state.groups[0]!.active).toBe("/ws/x.ssl");
	});

	test("navigation goAlong reveals line 1 in same file and aborts cleanly on workspace switch mid-navigation", async () => {
		let resolveSlow!: (v: any) => void;
		rpcHandler = (method, args) => {
			if (method === "read" && args[0] === "/ws/a.ssl") return { text: "line1\n".repeat(60), mtime: 1, encoding: "utf-8" };
			if (method === "read" && args[0] === "/ws/slow.ssl") return new Promise((r) => (resolveSlow = r));
			return null;
		};

		await openFile("/ws/a.ssl");
		const doc = documents.get("/ws/a.ssl")!;
		let curLine = 1;
		editors[0] = {
			getModel: () => doc.model,
			getPosition: () => ({ lineNumber: curLine, column: 1 }),
			getDomNode: () => ({ offsetParent: {} }),
		} as any;

		noteCursor({ path: "/ws/a.ssl", line: 1, column: 1 });
		curLine = 50;
		noteCursor({ path: "/ws/a.ssl", line: 50, column: 1 });

		await goAlong(-1);
		expect(takeReveal("/ws/a.ssl")).toEqual({ line: 1, column: 1 });

		// Wait for navigation's 60ms stepping settle window before recording new stops
		await new Promise((r) => setTimeout(r, 70));
		// Workspace switch mid-goAlong must not corrupt new workspace
		noteCursor({ path: "/ws/slow.ssl", line: 5, column: 1 });
		curLine = 10;
		noteCursor({ path: "/ws/a.ssl", line: 10, column: 1 });
		const nav = goAlong(-1);
		await new Promise((r) => setTimeout(r, 10));
		setState("workspace", { root: "/ws-other", name: "other" });
		resolveSlow({ text: "slow", mtime: 1, encoding: "utf-8" });
		await nav;
		expect(state.workspace?.root).toBe("/ws-other");
		expect(documents.has("/ws/slow.ssl")).toBe(false);
	});

	test("backend.ts ignores messages/open on replaced sockets and guards reconnect with connectSeq", async () => {
		const delivered: string[] = [];
		const off = on("fileChanged", ({ path }) => delivered.push(path));
		try {
			const oldSocket = activeSockets[activeSockets.length - 1]!;
			await connect();
			const newSocket = activeSockets[activeSockets.length - 1]!;
			expect(newSocket).not.toBe(oldSocket);

			// Late push on replaced socket must be ignored!
			oldSocket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event: "fileChanged", payload: { path: "/stale" } }) }));
			expect(delivered).toEqual([]);

			// Push on active socket delivers normally
			newSocket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event: "fileChanged", payload: { path: "/fresh" } }) }));
			expect(delivered).toEqual(["/fresh"]);

			// Late "open" on replaced socket must not resurrect or break active caller
			oldSocket.dispatchEvent(new Event("open"));
			rpcHandler = (method) => (method === "workspace" ? { root: "/ws", name: "ws" } : null);
			expect(await backend.workspace()).toEqual({ root: "/ws", name: "ws" });
		} finally {
			off();
		}
	});

	test("project.ts catches backend.docs() failure in setUpProject and guards workspace switch in undoSetUp / newDocIn", async () => {
		rpcHandler = (method) => {
			if (method === "setupPreview") return ["README.md"];
			if (method === "setupProject") return ["README.md"];
			if (method === "project") return { root: "/ws", path: "/ws/.ssl-studio/project.toml", configured: true, docs: "docs", plans: "design", schema: "schema" };
			if (method === "settings") return { effective: DEFAULT_SETTINGS };
			if (method === "themes") return [];
			if (method === "docs") throw new Error("docs boom");
			return null;
		};
		chooseHandler = () => "Create the file";
		// Must not throw unhandled rejection when backend.docs() rejects
		await expect(setUpProject()).resolves.toBeUndefined();

		// undoSetUp aborts if workspace switches mid-call
		let resolveUndo!: (v: any) => void;
		rpcHandler = (method) => {
			if (method === "setupUndo") return new Promise((r) => (resolveUndo = r));
			return null;
		};
		const treeBefore = state.treeVersion;
		const undoing = undoSetUp();
		await new Promise((r) => setTimeout(r, 10));
		setState("workspace", { root: "/ws2", name: "ws2" });
		resolveUndo({ removed: ["README.md"], kept: [] });
		await undoing;
		expect(state.treeVersion).toBe(treeBefore);

		// newDocIn aborts before write if workspace switches during create
		resetAppState();
		let wrote = false;
		let resolveCreate!: () => void;
		askHandler = () => "Guide";
		rpcHandler = (method) => {
			if (method === "create") return new Promise<void>((r) => (resolveCreate = r));
			if (method === "write") {
				wrote = true;
				return { mtime: 1 };
			}
			return null;
		};
		const making = newDocIn("docs");
		await new Promise((r) => setTimeout(r, 10));
		setState("workspace", { root: "/ws2", name: "ws2" });
		resolveCreate();
		expect(await making).toBe(false);
		expect(wrote).toBe(false);
	});
});

// =============================================================================
// 4. P1 — Keybindings, Commands, and Markdown Input Protection
// =============================================================================
describe("R8C P1 — keys.ts, commands.ts, and isInMarkdownTextEditor", () => {
	test("MARKDOWN_TEXT_KEYS excludes ctrl+l (Select Line) and reconciles ctrl+alt+enter to md-checkbox", () => {
		expect(MARKDOWN_TEXT_KEYS["ctrl+l"]).toBeUndefined();
		expect(MARKDOWN_TEXT_KEYS["ctrl+alt+enter"]).toBe("md-checkbox");
		expect(MARKDOWN_TEXT_KEYS["ctrl+b"]).toBe("md-bold");
	});

	test("defaultKeysForPlatform includes ctrl+shift++ zoom-in and keeps macOS Cmd+- zoom-out independent of go-back", () => {
		const nonMac = defaultKeysForPlatform(false);
		expect(nonMac["ctrl+shift++"]).toBe("zoom-in");
		expect(nonMac["ctrl+-"]).toBe("zoom-out");

		const mac = defaultKeysForPlatform(true);
		expect(mac["ctrl+shift++"]).toBe("zoom-in");
		expect(mac["ctrl+-"]).toBe("go-back");
		expect(mac["cmd+-"]).toBe("zoom-out");

		// Cmd+- resolves to zoom-out on macOS even if go-back is rebound away from ctrl+-!
		const reboundOverrides = rebind(mac, {}, "go-back", "alt+b");
		const reboundMap = effectiveKeys(mac, reboundOverrides);
		expect(reboundMap["ctrl+-"]).toBeUndefined();
		expect(resolveCommandKey({ key: "-", metaKey: true, ctrlKey: false }, reboundMap, true, reboundOverrides).id).toBe("zoom-out");
		expect(resolveCommandKey({ key: "-", ctrlKey: true, metaKey: false }, reboundMap, true, reboundOverrides).id).toBeUndefined();

		// On macOS default map, Ctrl+- runs go-back while Cmd+- runs zoom-out
		expect(resolveCommandKey({ key: "-", ctrlKey: true, metaKey: false }, mac, true).id).toBe("go-back");
		expect(resolveCommandKey({ key: "-", metaKey: true, ctrlKey: false }, mac, true).id).toBe("zoom-out");

		// Physical Ctrl+<letter> on macOS is NOT hijacked; Cmd+<letter> IS matched
		expect(keyNamesForPlatform({ key: "p", ctrlKey: true }, true)).toEqual([]);
		expect(keyNamesForPlatform({ key: "e", ctrlKey: true }, true)).toEqual([]);
		expect(keyNamesForPlatform({ key: "p", metaKey: true }, true)).toEqual(["cmd+p", "ctrl+p"]);
		expect(keyNamesForPlatform({ key: "Tab", ctrlKey: true }, true)).toEqual(["ctrl+tab"]);

		// Existing keyNames contract preserved
		expect(keyNames({ key: "s", metaKey: true })).toEqual(["ctrl+s"]);
		expect(displayKey("cmd+-")).toBe("Cmd+-");
		expect(bindable("cmd+-").ok).toBe(true);
		expect(bindable("cmd+c").ok).toBe(false);
	});

	test("isInMarkdownTextEditor rejects inputs, panels, table widgets, find widgets, and rename inputs", () => {
		class FakeEl {
			constructor(private selectors: Set<string>) {}
			closest(selectorList: string): FakeEl | null {
				for (const sel of selectorList.split(",").map((s) => s.trim())) {
					if (this.selectors.has(sel)) return this;
				}
				return null;
			}
		}
		const prevElement = (globalThis as any).Element;
		(globalThis as any).Element = FakeEl;
		try {
			// Normal CM6 live editor content
			expect(isInMarkdownTextEditor(new FakeEl(new Set([".cm-editor"])) as any, "markdown")).toBe(true);
			// CM6 Read mode
			expect(isInMarkdownTextEditor(new FakeEl(new Set([".cm-editor", ".cm-md-read"])) as any, "markdown")).toBe(false);
			// CM6 search panel / table widget / input inside CM6
			expect(isInMarkdownTextEditor(new FakeEl(new Set([".cm-editor", ".cm-panels"])) as any, "markdown")).toBe(false);
			expect(isInMarkdownTextEditor(new FakeEl(new Set([".cm-editor", ".cm-md-table-wrap"])) as any, "markdown")).toBe(false);
			expect(isInMarkdownTextEditor(new FakeEl(new Set([".cm-editor", "input"])) as any, "markdown")).toBe(false);
			expect(isInMarkdownTextEditor(new FakeEl(new Set([".cm-editor", "textarea:not(.inputarea)"])) as any, "markdown")).toBe(false);
			// Monaco Markdown source editor (textarea.inputarea) vs find/rename widgets
			expect(isInMarkdownTextEditor(new FakeEl(new Set([".monaco-editor"])) as any, "markdown")).toBe(true);
			expect(isInMarkdownTextEditor(new FakeEl(new Set([".monaco-editor", ".find-widget"])) as any, "markdown")).toBe(false);
			expect(isInMarkdownTextEditor(new FakeEl(new Set([".monaco-editor", ".rename-input"])) as any, "markdown")).toBe(false);
			expect(isInMarkdownTextEditor(new FakeEl(new Set([".monaco-editor"])) as any, "ssl")).toBe(false);
		} finally {
			(globalThis as any).Element = prevElement;
		}
	});

	test("copyPath uses displayName for untitled tabs and workspace-only commands guard !state.workspace", async () => {
		await connectTestRpc();
		try {
			resetAppState();
			let copied = "";
			rpcHandler = (method, args) => {
				if (method === "clipboard") {
					copied = String(args[0]);
					return true;
				}
				return null;
			};
			await copyPath("name", "untitled:Untitled-3");
			expect(copied).toBe("Untitled-3");
			await copyPath("whole", "untitled:Untitled-3");
			expect(copied).toBe("Untitled-3");

			// Workspace-only commands refuse cleanly when !state.workspace
			setState("workspace", null);
			const beforeBottom = state.settings.layout.bottom;
			runCommand("toggle-panel");
			expect(state.settings.layout.bottom).toBe(beforeBottom);
			runCommand("graph");
			expect(state.centerView).toBe("editors");
		} finally {
			await disconnectTestRpc();
		}
	});
});

// =============================================================================
// 5. P1 — QuickRank, QuickPrefix, Layout, and UI source invariants
// =============================================================================
describe("R8C P1 — quickRank memoization, quickPrefix 1-char prefix, layout sanitization", () => {
	test("quickRank matchesWords memoizes failed states and avoids exponential blowup", () => {
		const adversarial = `${"a_".repeat(30)}.ssl`;
		const query = `${"a".repeat(20)}z`;
		const t0 = performance.now();
		expect(fileTier(query, adversarial)).toBeNull();
		const elapsed = performance.now() - t0;
		expect(elapsed).toBeLessThan(50);

		// Valid camelCase/acronym matching still works
		expect(fileTier("ssdd", "Scripts/SetSampleDueDates.ssl")).toBe(2);
	});

	test("quickPrefix fileTarget supports 1-char file prefixes before #heading", () => {
		expect(fileTarget("r#intro")).toEqual({ file: "r", at: null, heading: "intro" });
		expect(fileTarget("a#")).toEqual({ file: "a", at: null, heading: null });
		expect(fileTarget("#tag")).toEqual({ file: "#tag", at: null, heading: null });
		expect(fileTarget("due #tag")).toEqual({ file: "due #tag", at: null, heading: null });
	});

	test("layout fitPanels sanitizes NaN, Infinity, negative, and huge widths without NaN/Infinity overflow", () => {
		expect(fitPanels(Number.NaN, 260, 360)).toEqual({ left: 0, right: 0 });
		expect(fitPanels(Number.POSITIVE_INFINITY, 260, 360)).toEqual({ left: 0, right: 0 });
		expect(fitPanels(-500, 260, 360)).toEqual({ left: 0, right: 0 });
		expect(fitPanels(1200, Number.NaN, 300)).toEqual({ left: 0, right: 300 });
		expect(fitPanels(1200, 260, Number.POSITIVE_INFINITY)).toEqual({ left: 260, right: 0 });

		for (const [l, r] of [
			[1e200, 1e200],
			[1e308, 1e308],
			[Number.MAX_VALUE, 200],
		] as const) {
			const res = fitPanels(800, l, r);
			expect(Number.isFinite(res.left)).toBe(true);
			expect(Number.isFinite(res.right)).toBe(true);
			expect(res.left).toBeGreaterThanOrEqual(LEFT_MIN);
			expect(res.right).toBeGreaterThanOrEqual(RIGHT_MIN);
			expect(res.left + res.right).toBe(800 - 44 - CENTER_MIN);
		}
	});

	test("QuickPick.tsx, App.tsx, main.tsx, commands.ts, navigation.ts enforce Round 8C UI invariants", () => {
		const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

		const qp = readSrc("../src/view/QuickPick.tsx");
		expect(qp).toContain("e.isComposing || e.keyCode === 229");
		expect(qp).toContain("/\\.(ssl|srvscr|ds)(\\.txt)?$/i.test(path)");
		expect(qp).toContain('if (mode() === "files" && failed()) return failed()');
		expect(qp).toContain("const current = items()[selected()]");
		expect(qp).toContain("120");

		const app = readSrc("../src/view/App.tsx");
		expect(app).toContain("onCleanup(() => clearTimeout(timer))");
		expect(app).toContain("if (state.workspace?.root !== targetRoot) return");
		expect(app).toContain("focusPanel((narrowPanels() && narrowHosted()) || state.leftView)");
		expect(app).toContain("narrowOpenedLeft");
		expect(app).toContain("Number.isFinite(v) && v > 0");

		const main = readSrc("../src/view/main.tsx");
		expect(main).toContain('window.addEventListener("dragover"');
		expect(main).toContain('window.addEventListener("drop"');
		expect(main).toContain('"Files"');

		const cmd = readSrc("../src/view/commands.ts");
		expect(cmd).toContain("e.isComposing || e.keyCode === 229");
		expect(cmd).toContain("state.project?.plans ?? \"design\"");
		expect(cmd).toContain("await heldFromBefore(path)");
		expect(cmd).toContain("!doc || doc.binary || !editor || !editor.getDomNode()?.offsetParent");

		const nav = readSrc("../src/view/navigation.ts");
		expect(nav).toContain("if (modalOpen()) return");
		expect(nav).toContain("if (state.workspace?.root !== startRoot) return");
	});
});

// =============================================================================
// 6. P1/P2 — Shared Helpers (workContext, workList, fileKind, editorDocHelpers)
// =============================================================================
describe("R8C P1/P2 — shared helpers (workContext, workList, fileKind, editorDocHelpers)", () => {
	test("scriptsForTicket excludes related tickets, parent epics, and non-requested sub-tickets", () => {
		const files: DocFile[] = [
			{ group: "tickets", name: "EPIC-1.md", path: "/ws/docs/tickets/EPIC-1.md", exists: true, ticket: "EPIC-1", codeRefs: ["src/EpicOnly.ssl"] },
			{
				group: "tickets",
				name: "T-1.md",
				path: "/ws/docs/tickets/T-1.md",
				exists: true,
				ticket: "T-1",
				parent: "EPIC-1",
				tickets: ["REL-1"],
				codeRefs: ["src/Main.ssl"],
			},
			{ group: "tickets", name: "SUB-1.md", path: "/ws/docs/tickets/SUB-1.md", exists: true, ticket: "SUB-1", parent: "T-1", codeRefs: ["src/Sub.ssl"] },
			{ group: "tickets", name: "REL-1.md", path: "/ws/docs/tickets/REL-1.md", exists: true, ticket: "REL-1", codeRefs: ["src/Related.ssl"] },
		];

		expect(scriptsForTicket(files, "T-1")).toEqual(["src/Main.ssl"]);
		expect(scriptsForTicket(files, "T-1", { includeDescendants: true })).toEqual(["src/Main.ssl", "src/Sub.ssl"]);
	});

	test("docsGoverningFile propagates pairedDoc.tickets when .plan.json pulls in paired .plan.md", () => {
		const files: DocFile[] = [
			{ group: "tickets", name: "LIMS-7.md", path: "/ws/docs/tickets/LIMS-7.md", exists: true, ticket: "LIMS-7", title: "Rollout" },
			{ group: "plans", name: "Rollout.plan.json", path: "/ws/design/Rollout.plan.json", exists: true, codeRefs: ["src/Rollout.ssl"] },
			{ group: "plans", name: "Rollout.plan.md", path: "/ws/design/Rollout.plan.md", exists: true, tickets: ["LIMS-7"] },
		];

		const gov = docsGoverningFile(files, "/ws/src/Rollout.ssl", "/ws");
		expect(gov.map((g) => g.file.name)).toContain("Rollout.plan.json");
		expect(gov.map((g) => g.file.name)).toContain("Rollout.plan.md");
		expect(gov.map((g) => g.file.name)).toContain("LIMS-7.md");
	});

	test("extractSection escapes regex metacharacters and ignores # comments inside fenced code blocks", async () => {
		const doc = [
			"# Q1",
			"",
			"## Answer",
			"Run the helper:",
			"```sh",
			"# This shell comment is NOT a Markdown heading!",
			"echo ok",
			"```",
			"After fence paragraph.",
			"",
			"## Notes",
			"Should not be included.",
		].join("\n");

		const extracted = extractSection(doc, "Answer");
		expect(extracted).toContain("# This shell comment is NOT a Markdown heading!");
		expect(extracted).toContain("After fence paragraph.");
		expect(extracted).not.toContain("Should not be included.");

		const specialHeadingDoc = "## Decision (v2.0)?\nUse C++ [fast] path.\n## Next\nOther";
		expect(extractSection(specialHeadingDoc, "Decision (v2.0)?")).toBe("Use C++ [fast] path.");

		// Verify through workText() as well
		const files: DocFile[] = [
			{ group: "tickets", name: "T-1.md", path: "/ws/docs/tickets/T-1.md", exists: true, ticket: "T-1", title: "Test" },
			{ group: "knowledge", kind: "questions", name: "questions/q1.md", path: "/ws/docs/knowledge/questions/q1.md", exists: true, title: "Q1", status: "answered", tickets: ["T-1"] },
		];
		const txt = await workText(workFor(files, "T-1")!, async (p) => (p.endsWith("q1.md") ? doc : "# T-1\nBody."));
		expect(txt).toContain("After fence paragraph.");
	});

	test("workList unifies ref matching with pathMatchesRef (specs/auth.md & rollout.plan.json)", () => {
		const files: DocFile[] = [
			{
				group: "tickets",
				name: "T-9.md",
				path: "/ws/docs/tickets/T-9.md",
				exists: true,
				ticket: "T-9",
				title: "Auth rollout",
				status: "in progress",
				specs: ["specs/auth.md"],
				plans: ["rollout.plan.json"],
			},
			{ group: "specs", name: "auth.md", path: "/ws/docs/specs/auth.md", exists: true, title: "Auth Spec" },
			{ group: "plans", name: "rollout.plan.json", path: "/ws/design/rollout.plan.json", exists: true, title: "Rollout Plan" },
		];

		const tw = ticketWork(files, "T-9");
		const wl = workList(files, "/ws");
		expect(tw.map((g) => g.kind)).toEqual(["plan", "spec"]);
		expect(wl.loose).toEqual([]);
		expect(wl.rows.map((r) => [r.kind, r.file.name])).toEqual([
			["ticket", "T-9.md"],
			["plan", "rollout.plan.json"],
			["spec", "auth.md"],
		]);
	});

	test("fileKind excludes UTF-32 LE BOM in looksBinary and rejects bare dotfiles in imageType", () => {
		expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]))).toBe(true);
		expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x00, 0x00]))).toBe(true);
		expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]))).toBe(false);

		expect(imageType(".png")).toBeNull();
		expect(imageType("/w/.png")).toBeNull();
		expect(imageType("C:\\w\\.jpg")).toBeNull();
		expect(imageType("/w/icon.png")).toBe("image/png");
	});

	test("editorDocHelpers resolves leading ../ segments safely and ignores #L0 in parseDocFragment", () => {
		const docs: DocFile[] = [
			{ path: "/ws/docs/specs/due-dates.md", name: "due-dates.md", group: "specs", exists: true },
			{ path: "/ws/schema/database/HOLIDAYS.md", name: "HOLIDAYS.md", group: "schema", exists: true },
		];

		// Without sourcePath: normalizes leading ../ against workspace docs
		const refs1 = findCommentDocRefsInLines(
			[
				"/* See ../../docs/specs/due-dates.md#L0;",
				"/* Also ../schema/database/HOLIDAYS.md#L12-L20;",
				"/* Bad range docs/specs/due-dates.md#L0-L5;",
			],
			"ssl",
			docs,
			"/ws",
		);
		expect(refs1.map((r) => [r.line, r.doc.name, r.targetLine ?? null, r.targetEndLine ?? null, r.heading ?? null])).toEqual([
			[1, "due-dates.md", null, null, null],
			[2, "HOLIDAYS.md", 12, 20, null],
			[3, "due-dates.md", null, null, null],
		]);

		// With sourcePath: resolves relative to source file directory and rejects escapes outside root
		const refs2 = findCommentDocRefsInLines(
			[
				"-- ../../docs/specs/due-dates.md#L5",
				"-- ../../../../../etc/passwd.md",
			],
			"sql",
			docs,
			"/ws",
			{ sourcePath: "/ws/src/DueDates/Query.sql" },
		);
		expect(refs2.map((r) => [r.line, r.doc.name, r.targetLine ?? null])).toEqual([[1, "due-dates.md", 5]]);
	});
});
