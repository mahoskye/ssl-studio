// The low findings of audit pass 4 in the view's core: the notice of a settings file that does not read, local
// history that is not kept, the close of the desktop window over text still being typed, "Save all" on the card
// that stands in for a failed view, the agent's model when its list cannot be read again, and an Enter pressed in
// "Go to symbol" before the symbols have come. The backend's side runs the real backend in folders made for the
// test; the view's side runs the real state module and the real agent store against a backend that is a function
// here, with Monaco and the dialogs replaced (the set-up of solid2AuditCore.test.ts, copied). The desktop window
// itself and the error card's markup cannot be run here: what is held of them is said at each test.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEffect, createMemo, createRoot, createSignal, flush, snapshot } from "solid-js";
import { createBackend, VIEW_ANSWERS_WITHIN, type Host } from "../src/bun/backend";
import { historyNotKept } from "../src/bun/history";
import { dirs } from "../src/bun/paths";
import { DEFAULT_SETTINGS, type BackendEvents, type KeptText, type Settings } from "../src/shared/protocol";
import { createAsyncQuery } from "../src/view/asyncQuery";

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
	detectIndentation(insertSpaces: boolean, tabSize: number): void;
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
		// What Tab writes is the real editor's to work out: asked here, nothing follows from it.
		detectIndentation() {},
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
const { closeTab, commitPendingEdits, documents, forgetKeptRecord, holdsPendingEdit, KEEP_AFTER, keepUnsaved, loadSettings, newUntitled, notSavedText, openFile, openFolder, restoreTabs, save, saveAllUnasked, saveSetting, setState, state } =
	await import("../src/view/state");
const { resetRecentTabs } = await import("../src/view/recentTabs");
const { resetTidy } = await import("../src/view/agent/tidy");
const { askAbout } = await import("../src/view/agent/Agent");
const { agent, chatSessionEpoch, chooseModel, currentModel, setAgent } = await import("../src/view/agent/store");
const { symbolsFor } = await import("../src/view/QuickPick");

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const until = async (ok: () => boolean) => {
	for (let i = 0; i < 500 && !ok(); i++) await sleep(1);
	expect(ok()).toBe(true);
};
const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

// --- The view's backend: a function here, reached through the socket the view opens ---
type RpcHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;
let rpcHandler: RpcHandler = () => null;
let failNextConnect = false;
let liveSocket: TestRpcSocket | null = null;

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
				liveSocket = this;
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

/** An event as the backend sends it to the view. */
const pushed = <K extends keyof BackendEvents>(event: K, payload: BackendEvents[K]) => {
	liveSocket!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event, payload }) }));
};

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

// --- The real backend, for its own side ---
const base = mkdtempSync(join(tmpdir(), "ssl-studio-p4l-viewcore-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string) => {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};

/** A host that keeps what the backend sends the view. */
function hostOf() {
	const events: { event: keyof BackendEvents; payload: unknown }[] = [];
	let quits = 0;
	const host: Host = {
		app: "test",
		kind: "app",
		emit: (event, payload) => void events.push({ event, payload }),
		pick: async () => null,
		trash: async () => {},
		quit: () => void quits++,
	};
	return { host, events, quits: () => quits, sent: (event: keyof BackendEvents) => events.filter((e) => e.event === event).map((e) => e.payload as any) };
}

/** The app's own folders somewhere of the test's, for as long as the work takes. */
async function withDirs<T>(name: string, work: (d: { data: string }) => Promise<T>): Promise<T> {
	const before = { ...dirs };
	const sandbox = fresh(name);
	Object.assign(dirs, { config: join(sandbox, "config"), data: join(sandbox, "data"), state: join(sandbox, "state") });
	try {
		return await work({ data: dirs.data });
	} finally {
		Object.assign(dirs, before);
	}
}

/** The log is kept quiet while the work runs: the failures made here on purpose are written to it. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
	const said = console.error;
	console.error = () => {};
	try {
		return await work();
	} finally {
		console.error = said;
	}
}

// =============================================================================
// B9-3. The notice that a settings file does not read, across the opening of a folder
// =============================================================================
describe("B9-3: a settings file that does not read stays said", () => {
	beforeAll(connectTestRpc);
	beforeEach(resetAll);

	const problem = "/home/someone/.config/ssl-studio/settings.json does not read as settings (line 9, column 3: A comma is followed by another name, not by }.), so none of its settings are used. It is not written over until it is mended by hand, or removed.";
	/** A backend whose settings name `problems` as not reading, and which opens any folder. */
	const answering = (problems: () => string[]) => {
		rpcHandler = (method, args) => {
			if (method === "settings") {
				const now = problems();
				return { effective: structuredClone(DEFAULT_SETTINGS), user: {}, workspace: {}, ...(now.length ? { problems: now } : {}) };
			}
			if (method === "saveSettings") return { ...structuredClone(DEFAULT_SETTINGS), ...(args[1] as Partial<Settings>) };
			if (method === "themes") return [];
			if (method === "info") return { app: "0.1.0", selftest: true };
			if (method === "lspState") return { state: "stopped" };
			if (method === "openFolder") return { root: String(args[0]), name: String(args[0]).slice(1) };
			return null;
		};
	};
	const said = () => snapshot(state).messages.filter((m) => m.text === problem).map((m) => m.id);
	// The state module is one for the whole run: what it has on record as said is taken back, for the test files after this one.
	afterAll(async () => {
		answering(() => []);
		await loadSettings().catch(() => {});
		await disconnectTestRpc();
	});

	test("opening a folder from the Welcome page does not take the notice away while the file is still broken", async () => {
		answering(() => [problem]);
		// The app as it starts with no folder: the settings are read, and the broken file is said.
		setState((s) => {
			s.workspace = null;
		});
		flush();
		await loadSettings(true);
		flush();
		expect(notices()).toEqual([problem]);

		// A folder is opened: the notices of before go, and the settings are read for it. The file is as broken as it was.
		await openFolder("/project");
		flush();
		expect(snapshot(state).workspace?.root).toBe("/project");
		expect(notices()).toEqual([problem]);
		const once = said();

		// Read again while it stands and is on screen (project.toml saved, a setting reloaded): not said a second time.
		await loadSettings();
		await loadSettings();
		flush();
		expect(said()).toEqual(once);
	});

	test("a file that was mended and is broken again is said again, though no reading saw it mended", async () => {
		let broken = true;
		answering(() => (broken ? [problem] : []));
		await openFolder("/project");
		flush();
		const first = said();
		expect(first.length).toBe(1);

		// Mended by hand. No folder is opened and nothing reloads the settings: the app learns of it when a change of
		// a setting goes through, which a file that does not read never lets happen.
		broken = false;
		expect(await saveSetting({ fontSize: 15 })).toBeDefined();
		await sleep(5);
		// Broken again in the same place, and read: a new problem, said anew.
		broken = true;
		await loadSettings();
		flush();
		expect(said().length).toBe(1);
		expect(said()).not.toEqual(first);
	});

	test("a save that goes through while another file is still broken does not say that one again", async () => {
		answering(() => [problem]);
		await openFolder("/project");
		flush();
		const first = said();
		expect(first.length).toBe(1);
		// The workspace's file takes the save; the user's own is as broken as before.
		expect(await saveSetting({ fontSize: 16 }, "workspace")).toBeDefined();
		await sleep(5);
		await loadSettings();
		flush();
		expect(said()).toEqual(first);
	});
});

// =============================================================================
// L6 / B11-5. Local history that cannot be written
// =============================================================================
describe("L6: local history that is not kept is said in the app", () => {
	test("the words name what was not kept, the folder, the system's reason, and that the file was saved", () => {
		const text = historyNotKept("/home/someone/.local/share/ssl-studio/history", "Script.ssl", "ENOSPC: no space left on device, write");
		expect(text).toBe(
			"Local history is not being kept: a copy of Script.ssl could not be written to /home/someone/.local/share/ssl-studio/history (ENOSPC: no space left on device, write). The file itself was saved. Until that folder can be written there are no earlier versions to go back to, also not of a file that is discarded. This is said once, not at every save.",
		);
	});

	test("the backend tells the view once for a cause, keeps history again when it can, and tells a later failure again", async () => {
		await withDirs("dirs-history", async ({ data }) => {
			const root = fresh("history-ws");
			const file = join(root, "Script.ssl");
			writeFileSync(file, ":RETURN 1;\n");
			// Where the history is kept there is a file: no snapshot can be made (as with a full or read-only folder).
			const inTheWay = () => {
				rmSync(join(data, "history"), { recursive: true, force: true });
				mkdirSync(data, { recursive: true });
				writeFileSync(join(data, "history"), "in the way\n");
			};
			inTheWay();
			const { host, sent } = hostOf();
			const backend = createBackend(host, root);
			await backend.ready;
			try {
				await quietly(async () => {
					// The save is a save: the file is written and the call answers.
					expect((await backend.api.write(file, ":RETURN 2;\n")).mtime).toBeGreaterThan(0);
					expect(readFileSync(file, "utf8")).toBe(":RETURN 2;\n");
					const told = sent("notice");
					expect(told.length).toBe(1);
					expect(told[0].kind).toBe("error");
					expect(told[0].text).toStartWith(`Local history is not being kept: a copy of Script.ssl could not be written to ${join(data, "history")} (`);
					// The system's own reason, whichever this system gives for a file where a folder is wanted.
					expect(told[0].text).toMatch(/\((ENOTDIR|EEXIST)[^)]*\)\. The file itself was saved\./);

					// Not at every save.
					await backend.api.write(file, ":RETURN 3;\n");
					await backend.api.write(file, ":RETURN 4;\n");
					expect(sent("notice").length).toBe(1);
					expect(await backend.api.history(file)).toEqual([]);

					// The folder can be written again: history is kept again, without a word.
					rmSync(join(data, "history"));
					await backend.api.write(file, ":RETURN 5;\n");
					expect((await backend.api.history(file)).length).toBe(1);
					expect(sent("notice").length).toBe(1);

					// And it fails again: that is news, and is said again.
					inTheWay();
					await backend.api.write(file, ":RETURN 6;\n");
					expect(readFileSync(file, "utf8")).toBe(":RETURN 6;\n");
					expect(sent("notice").length).toBe(2);
				});
			} finally {
				backend.dispose();
			}
		});
	});

	describe("the view", () => {
		beforeAll(connectTestRpc);
		afterAll(disconnectTestRpc);
		beforeEach(resetAll);

		test("shows what the backend has to say as a notice that stays, and keeps it in Output", () => {
			const text = "Local history is not being kept: a copy of Script.ssl could not be written to /data/history (EACCES: permission denied, mkdir '/data/history/ab'). The file itself was saved.";
			pushed("notice", { kind: "error", text });
			flush();
			expect(snapshot(state).messages.filter((m) => m.text === text).map((m) => m.kind)).toEqual(["error"]);
			expect(snapshot(state).output.some((line) => line.includes("Local history is not being kept"))).toBe(true);
			// Something that is not a notice shows nothing, and breaks nothing.
			pushed("notice", {} as any);
			flush();
			expect(snapshot(state).messages.length).toBe(1);
		});
	});
});

// =============================================================================
// B9-4. The desktop window closed over text that is still being typed, and over unsaved files (ADR 0042)
// =============================================================================
describe("B9-4: the window is not closed over text still being typed, nor over unsaved files before their text is kept", () => {
	// The backend's side: what `will-close` and `before-quit` ask (src/bun/index.ts), and what it answers from.
	describe("the backend", () => {
		test("with nothing unsaved and no view that may hold typed text, the window closes at once and nobody is asked", async () => {
			const { host, events } = hostOf();
			const backend = createBackend(host);
			expect(backend.mayClose()).toBe(true);
			await backend.api.typingChanged(true);
			await backend.api.typingChanged(false);
			expect(backend.mayClose()).toBe(true);
			expect(events).toEqual([]);
			backend.dispose();
		});

		test("while such a view is open it does not close on a count of 0: the view is sent for", async () => {
			const { host, sent, quits } = hostOf();
			const backend = createBackend(host);
			await backend.api.unsavedChanged(0);
			await backend.api.typingChanged(true);
			expect(backend.mayClose()).toBe(false);
			expect(sent("closeRequested").length).toBe(1);

			// The view put the text in its document: one file is unsaved now. Until the view has had its text kept and
			// closes the app, the window stays, and a second press of the close button sends for the view again.
			await backend.api.unsavedChanged(1);
			expect(backend.mayClose()).toBe(false);
			expect(sent("closeRequested").length).toBe(2);

			// The view's decision closes the app, and the quit that follows is let through.
			await backend.api.closeWindow();
			expect(backend.mayClose()).toBe(true);
			await sleep(80);
			expect(quits()).toBe(1);
			backend.dispose();
		});

		test("the view's answer that nothing is unsaved after all closes the app without a question", async () => {
			const { host, sent, quits } = hostOf();
			const backend = createBackend(host);
			await backend.api.typingChanged(true);
			expect(backend.mayClose()).toBe(false);
			// What the view does when the text it put in changed nothing: no question, the app is closed.
			await backend.api.closeWindow();
			expect(sent("closeRequested").length).toBe(1);
			expect(backend.mayClose()).toBe(true);
			await sleep(80);
			expect(quits()).toBe(1);
			backend.dispose();
		});

		test("a view that never answers does not keep the window open for ever: a later request closes it", async () => {
			const { host, sent } = hostOf();
			const backend = createBackend(host);
			const clock = Date.now;
			let now = 1_000_000;
			Date.now = () => now;
			try {
				await backend.api.typingChanged(true);
				expect(backend.mayClose()).toBe(false);
				// Pressed again at once (a double click): the view has had no time, and is asked again.
				now += 50;
				expect(backend.mayClose()).toBe(false);
				now += VIEW_ANSWERS_WITHIN;
				// Heard from in the meantime: it is there, and the window waits for it as before.
				await backend.api.unsavedChanged(0);
				expect(backend.mayClose()).toBe(false);
				expect(sent("closeRequested").length).toBe(3);
				// Never heard from since it was asked, and asked long enough ago: it is not there to answer.
				now += VIEW_ANSWERS_WITHIN + 1;
				expect(backend.mayClose()).toBe(true);
				expect(sent("closeRequested").length).toBe(3);
			} finally {
				Date.now = clock;
				backend.dispose();
			}
		});

		test("unsaved files are let go that way too: what was kept as they were typed is what there is of them (ADR 0042)", async () => {
			const { host } = hostOf();
			const backend = createBackend(host);
			const clock = Date.now;
			let now = 1_000_000;
			Date.now = () => now;
			try {
				await backend.api.typingChanged(true);
				await backend.api.unsavedChanged(1);
				expect(backend.mayClose()).toBe(false);
				now += 10 * VIEW_ANSWERS_WITHIN;
				expect(backend.mayClose()).toBe(true);
			} finally {
				Date.now = clock;
				backend.dispose();
			}
		});
	});

	// The view's side: it says when such a view is open, and what it does when asked.
	describe("the view", () => {
		beforeAll(connectTestRpc);
		afterAll(disconnectTestRpc);
		beforeEach(resetAll);

		test("tells the backend when a view that may hold typed text opens, and when the last one goes", async () => {
			const told: unknown[] = [];
			rpcHandler = (method, args) => (method === "typingChanged" ? void told.push(args[0]) : null);
			const first = holdsPendingEdit(() => {});
			const second = holdsPendingEdit(() => {});
			await sleep(5);
			expect(told).toEqual([true]);
			first();
			await sleep(5);
			expect(told).toEqual([true]);
			second();
			await sleep(5);
			expect(told).toEqual([true, false]);
		});

		test("a view that says whether it has typed text holds the window only while it has", async () => {
			const told: unknown[] = [];
			rpcHandler = (method, args) => (method === "typingChanged" ? void told.push(args[0]) : null);
			let typed = "";
			const release = holdsPendingEdit(
				() => void (typed = ""),
				() => typed !== "",
			);
			try {
				// Open, with nothing typed: the backend is told nothing, and closes the window on its count as before.
				await sleep(5);
				expect(told).toEqual([]);
				// Typed in. The view is asked again whenever the answer may have changed (here: another such view opens;
				// in the window also after a key, text put in a field, a field left, which cannot be raised here).
				typed = "A1";
				const other = holdsPendingEdit(
					() => {},
					() => false,
				);
				await sleep(5);
				expect(told).toEqual([true]);
				// The text is put in its document (a save, a change of tab, the question about a close): no longer held.
				commitPendingEdits();
				await sleep(5);
				expect(told).toEqual([true, false]);
				other();
				// A view whose answer cannot be had is taken to have text.
				const broken = holdsPendingEdit(
					() => {},
					() => {
						throw new Error("the view is gone");
					},
				);
				await sleep(5);
				expect(told).toEqual([true, false, true]);
				broken();
				await sleep(5);
				expect(told).toEqual([true, false, true, false]);
			} finally {
				release();
			}
			expect(readSrc("../src/view/state.ts")).toContain('for (const type of ["keydown", "input", "focusout"]) window.addEventListener(type, askAgain, true);');
		});

		test("sent for about a close, it puts the typed text in its document, has the unsaved text kept, and closes the app without a question", async () => {
			const file = "/ws/registry.csv";
			const calls: string[] = [];
			const keeps: unknown[][] = [];
			rpcHandler = (method, args) => {
				calls.push(method);
				if (method === "read") return { text: "Code,Name\n", mtime: 1, encoding: "utf-8" };
				if (method === "unsavedKeep") keeps.push(args);
				return null;
			};
			await openFile(file, { keep: true });
			flush();
			// A cell is open with text in it that the document does not have yet.
			let typed = "A1,";
			const release = holdsPendingEdit(() => {
				if (!typed) return;
				typeInto(file, typed);
				typed = "";
			});
			try {
				expect(snapshot(state).dirty[file]).toBeFalsy();
				let asked = 0;
				chooseHandler = () => (asked++, null);
				pushed("closeRequested", {});
				await until(() => calls.includes("closeWindow"));
				expect(asked).toBe(0);
				// The text that was still in the cell is in the document, and is what was kept: before the app was closed.
				expect((documents.get(file)!.model as any).getValue()).toBe("A1,Code,Name\n");
				expect(keeps).toEqual([["/ws", [{ path: file, text: "A1,Code,Name\n", saved: { text: "Code,Name\n", mtime: 1 } }], []]]);
				expect(calls.indexOf("unsavedKeep")).toBeLessThan(calls.indexOf("closeWindow"));
				// Still unsaved here: nothing saved it, and nothing discarded it.
				expect(snapshot(state).dirty[file]).toBe(true);
				expect(calls).not.toContain("write");
			} finally {
				release();
			}
		});

		test("where the text cannot be kept, it asks as it did before (ADR 0009), and closes the app only on an answer", async () => {
			const file = "/ws/registry.csv";
			const calls: string[] = [];
			rpcHandler = (method) => {
				calls.push(method);
				if (method === "read") return { text: "Code,Name\n", mtime: 1, encoding: "utf-8" };
				if (method === "unsavedKeep") throw new Error("ENOSPC: no space left on device");
				return null;
			};
			await openFile(file, { keep: true });
			flush();
			typeInto(file, "A1,");
			const asked: string[] = [];
			chooseHandler = (prompt) => (asked.push(prompt), null);
			pushed("closeRequested", {});
			await until(() => asked.length === 1);
			expect(asked[0]).toBe("1 file has unsaved changes (registry.csv). They could not be kept for next time. Closing the window would lose them.");
			await sleep(5);
			// Cancelled: the window stays, and nothing closed the app.
			expect(calls).not.toContain("closeWindow");
			expect((documents.get(file)!.model as any).getValue()).toBe("A1,Code,Name\n");

			// The close button again: asked again, and "Discard changes" closes the app.
			chooseHandler = (prompt) => (asked.push(prompt), "Discard changes");
			pushed("closeRequested", {});
			await until(() => calls.includes("closeWindow"));
			expect(asked.length).toBe(2);
		});

		test("with such a view open and nothing typed in it, it closes the app at once and asks nothing", async () => {
			const calls: string[] = [];
			rpcHandler = (method) => void calls.push(method);
			let commits = 0;
			const release = holdsPendingEdit(() => void commits++);
			try {
				let asked = 0;
				chooseHandler = () => (asked++, null);
				pushed("closeRequested", {});
				await until(() => calls.includes("closeWindow"));
				expect(commits).toBe(1);
				expect(asked).toBe(0);
			} finally {
				release();
			}
		});
	});

	test("the desktop host asks the guard on both ways to close, and the view answers a request by having the unsaved text kept (source text)", () => {
		// Electrobun cannot be run here: these are the two ends the tests above stand between.
		const host = readSrc("../src/bun/index.ts");
		expect(host).toContain('window.on("will-close", (event: unknown) => {\n\tif (!backend.mayClose())');
		expect(host).toContain('Electrobun.events.on("before-quit"');
		expect(host.match(/backend\.mayClose\(\)/g)?.length).toBe(2);
		const view = readSrc("../src/view/state.ts");
		expect(view).toContain('if (await leaveUnsavedKept("Closing the window would lose them.")) await backend.closeWindow();');
		expect(view).toMatch(/export async function leaveUnsavedKept\(what: string\): Promise<boolean> \{\n\tcommitPendingEdits\(\);\n\tif \(\(await keepUnsaved\(\)\) === null\) return true;/);
		expect(view).toMatch(/export async function settleUnsaved\(what: string\): Promise<boolean> \{\n\tcommitPendingEdits\(\);/);
		// A page that goes (a reload, a browser tab closed) asks nothing either: the text is sent to be kept.
		expect(readSrc("../src/view/main.tsx")).toContain('window.addEventListener("beforeunload", () => keepUnsavedOnLeave());');
		// A window that was reloaded starts by saying that no such view is open.
		expect(readSrc("../src/view/main.tsx")).toContain("void backend.typingChanged(false).catch(() => undefined);");
	});
});

// =============================================================================
// ADR 0042. Unsaved text is kept as it is typed, and comes back with the folder
// =============================================================================
describe("ADR 0042: unsaved text is kept, and comes back when the folder is opened again", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	/** The tabs and panels the window remembers for the folders of these tests. Through the window's own storage: in a run of every test file it is whichever file's came first, not this file's `storage`. */
	const forgetTabs = () => {
		for (const root of ["/ws", "/other"]) for (const kind of ["tabs", "views"]) localStorage.removeItem(`ssl-studio.${kind}:${root}`);
	};
	const rememberedTabs = (tabs: string[], active: string) => localStorage.setItem("ssl-studio.tabs:/ws", JSON.stringify({ groups: [{ tabs, active }], activeGroup: 0 }));
	beforeEach(() => {
		resetAll();
		forgetKeptRecord();
		forgetTabs();
	});
	afterAll(forgetTabs);

	type Keep = { root: string; keep: KeptText[]; drop: string[] };
	/**
	 * A backend with these files on disk (null: not there), and this text kept for the folder. It writes down what
	 * it is asked to keep, and what it is asked to write.
	 */
	function backendOf(files: Record<string, { text: string; mtime: number } | null>, kept: KeptText[] = []) {
		const keeps: Keep[] = [];
		const written: Record<string, string> = {};
		const calls: string[] = [];
		rpcHandler = (method, args) => {
			calls.push(method);
			if (method === "read") {
				const file = files[String(args[0])];
				if (!file) throw new Error(`ENOENT: no such file or directory, open '${args[0]}'`);
				return { path: args[0], ...file, encoding: "utf-8" };
			}
			if (method === "write") {
				written[String(args[0])] = String(args[1]);
				files[String(args[0])] = { text: String(args[1]), mtime: 99 };
				return { mtime: 99 };
			}
			if (method === "unsavedKeep") keeps.push({ root: args[0] as string, keep: args[1] as KeptText[], drop: args[2] as string[] });
			if (method === "unsavedKept") return kept;
			if (method === "settings") return { effective: structuredClone(DEFAULT_SETTINGS), user: {}, workspace: {} };
			if (method === "themes") return [];
			if (method === "info") return { app: "0.1.0", selftest: false };
			if (method === "lspState") return { state: "stopped" };
			if (method === "openFolder") return { root: String(args[0]), name: String(args[0]).slice(1) };
			return null;
		};
		return { keeps, written, calls };
	}
	const A = "/ws/a.ssl";
	const B = "/ws/b.ssl";
	const textOf = (path: string) => (documents.get(path)!.model as any).getValue() as string;
	const tabs = () => snapshot(state).groups.map((g) => [...g.tabs]);
	const unsaved = () => Object.keys(snapshot(state).dirty).filter((path) => snapshot(state).dirty[path]);

	test("text is kept within the second of being typed, and a further key does not put that off", async () => {
		const { keeps } = backendOf({ [A]: { text: "one\n", mtime: 1 } });
		await openFile(A, { keep: true });
		typeInto(A, "a");
		await sleep(KEEP_AFTER / 2);
		typeInto(A, "b");
		expect(keeps).toEqual([]);
		await sleep(KEEP_AFTER / 2 + 100);
		// A second after the first key, with what had been typed by then; the file it was made over goes along.
		expect(keeps).toEqual([{ root: "/ws", keep: [{ path: A, text: "baone\n", saved: { text: "one\n", mtime: 1 } }], drop: [] }]);
		typeInto(A, "c");
		await sleep(KEEP_AFTER + 100);
		// The next text goes alone: the backend has the file it was made over.
		expect(keeps[1]).toEqual({ root: "/ws", keep: [{ path: A, text: "cbaone\n" }], drop: [] });
		// Nothing typed since: nothing more is sent, also when it is asked for.
		expect(await keepUnsaved()).toBeNull();
		expect(keeps.length).toBe(2);
	});

	test("what is saved, or closed with its changes given up, is no longer kept; a document with no file yet is kept too", async () => {
		const { keeps } = backendOf({ [A]: { text: "one\n", mtime: 1 }, [B]: { text: "two\n", mtime: 1 } });
		await openFile(A, { keep: true });
		await openFile(B, { keep: true });
		typeInto(A, "a");
		typeInto(B, "b");
		const untitled = newUntitled(0, "ssl");
		typeInto(untitled, "draft");
		expect(await keepUnsaved()).toBeNull();
		expect(keeps.length).toBe(1);
		expect(keeps[0]!.keep).toEqual([
			{ path: A, text: "aone\n", saved: { text: "one\n", mtime: 1 } },
			{ path: B, text: "btwo\n", saved: { text: "two\n", mtime: 1 } },
			{ path: untitled, text: "draft", language: "ssl" },
		]);

		expect(await save(A)).toBe(true);
		expect(await keepUnsaved()).toBeNull();
		expect(keeps[1]).toEqual({ root: "/ws", keep: [], drop: [A] });

		expect(await closeTab(B, 0, { discard: true })).toBe(true);
		expect(await closeTab(untitled, 0, { discard: true })).toBe(true);
		expect(await keepUnsaved()).toBeNull();
		expect(keeps[2]).toEqual({ root: "/ws", keep: [], drop: [B, untitled] });

		// Edited again after the save: kept again, over the file as the save left it.
		typeInto(A, "x");
		expect(await keepUnsaved()).toBeNull();
		expect(keeps[3]).toEqual({ root: "/ws", keep: [{ path: A, text: "xaone\n", saved: { text: "aone\n", mtime: 99 } }], drop: [] });
	});

	test("opening another folder asks nothing: what is unsaved is kept for the folder that is left, before it is left", async () => {
		const { keeps, calls } = backendOf({ [A]: { text: "one\n", mtime: 1 } });
		await openFile(A, { keep: true });
		typeInto(A, "a");
		let asked = 0;
		chooseHandler = () => (asked++, null);
		await openFolder("/other");
		flush();
		expect(asked).toBe(0);
		expect(snapshot(state).workspace?.root).toBe("/other");
		expect(keeps).toEqual([{ root: "/ws", keep: [{ path: A, text: "aone\n", saved: { text: "one\n", mtime: 1 } }], drop: [] }]);
		expect(calls.indexOf("unsavedKeep")).toBeLessThan(calls.indexOf("openFolder"));
		// The folder that is open now has none of it: not among its documents, and not on record to be forgotten.
		expect(documents.size).toBe(0);
		expect(unsaved()).toEqual([]);
		expect(await keepUnsaved()).toBeNull();
		expect(keeps.length).toBe(1);
	});

	test("where it cannot be kept, opening another folder asks as it did, and a cancelled question leaves the folder open", async () => {
		const { calls } = backendOf({ [A]: { text: "one\n", mtime: 1 } });
		const answer = rpcHandler;
		rpcHandler = (method, args) => {
			if (method === "unsavedKeep") throw new Error("EROFS: read-only file system");
			return answer(method, args);
		};
		await openFile(A, { keep: true });
		typeInto(A, "a");
		const asked: string[] = [];
		chooseHandler = (prompt) => (asked.push(prompt), null);
		await openFolder("/other");
		expect(asked).toEqual(["1 file has unsaved changes (a.ssl). They could not be kept for next time. Opening another folder closes them."]);
		expect(snapshot(state).workspace?.root).toBe("/ws");
		expect(calls).not.toContain("openFolder");
		expect(textOf(A)).toBe("aone\n");
	});

	test("the folder opens with what was left unsaved: the kept text, unsaved, each in a tab, and nothing said", async () => {
		const { keeps } = backendOf({ [A]: { text: "one\n", mtime: 1 } }, [
			{ path: A, text: "edited\n", saved: { text: "one\n", mtime: 1 } },
			{ path: "untitled:Untitled-1", text: "draft\n", language: "ssl" },
		]);
		let asked = 0;
		chooseHandler = () => (asked++, null);
		await restoreTabs();
		flush();
		expect(textOf(A)).toBe("edited\n");
		expect(textOf("untitled:Untitled-1")).toBe("draft\n");
		expect((documents.get("untitled:Untitled-1")!.model as any).getLanguageId()).toBe("ssl");
		expect(unsaved().sort()).toEqual([A, "untitled:Untitled-1"]);
		expect(tabs()).toEqual([[A, "untitled:Untitled-1"]]);
		expect(snapshot(state).conflicts).toEqual({});
		expect(notices()).toEqual([]);
		expect(asked).toBe(0);
		// The backend has these texts: they are not sent to it again until they change.
		expect(await keepUnsaved()).toBeNull();
		expect(keeps).toEqual([]);
		// A new document with no file does not take the name of the one that came back.
		expect(newUntitled()).toBe("untitled:Untitled-2");
		// The file was touched meanwhile (another date, the same text): it has not changed under the edits, and a save is a save.
		expect(await save(A)).toBe(true);
		expect(asked).toBe(0);
	});

	test("with tabs remembered, each comes back in its place: a document with no file among them, and one left empty not at all", async () => {
		backendOf({ [A]: { text: "one\n", mtime: 1 }, [B]: { text: "two\n", mtime: 1 } }, [
			{ path: A, text: "edited\n", saved: { text: "one\n", mtime: 1 } },
			{ path: "untitled:Untitled-2", text: "draft\n" },
		]);
		rememberedTabs(["untitled:Untitled-2", B, A, "untitled:Untitled-7"], A);
		await restoreTabs();
		flush();
		expect(tabs()).toEqual([["untitled:Untitled-2", B, A]]);
		expect(snapshot(state).groups[0]!.active).toBe(A);
		expect(unsaved().sort()).toEqual([A, "untitled:Untitled-2"]);
		expect(textOf(B)).toBe("two\n");
	});

	test("a file that changed on disk meanwhile comes back with the kept text, marked: it is said, and saving asks which to keep", async () => {
		for (const diskDate of [5, 1]) {
			resetAll();
			forgetKeptRecord();
			forgetTabs();
			// Changed on disk, with a later date or (a file put back from elsewhere) with the very date it had.
			const { written } = backendOf({ [A]: { text: "changed elsewhere\n", mtime: diskDate } }, [{ path: A, text: "edited\n", saved: { text: "one\n", mtime: 1 } }]);
			await restoreTabs();
			flush();
			expect(textOf(A)).toBe("edited\n");
			expect(unsaved()).toEqual([A]);
			expect(snapshot(state).conflicts).toEqual({ [A]: true });
			expect(notices()).toEqual(["a.ssl changed on disk while its unsaved text was kept. The unsaved text is open: saving will ask which to keep."]);
			const asked: string[] = [];
			chooseHandler = (prompt) => (asked.push(prompt), null);
			expect(await save(A)).toBe(false);
			expect(asked).toEqual(["a.ssl changed on disk after you opened it. Saving would replace what is there."]);
			expect(written).toEqual({});
		}
	});

	test("a file that is gone comes back with its kept text, and saving puts the file back", async () => {
		const { written } = backendOf({ [A]: null, [B]: null }, [
			{ path: A, text: "edited\n", saved: { text: "one\n", mtime: 1 } },
			{ path: B, text: "more\n", saved: { text: "two\n", mtime: 1 } },
		]);
		await restoreTabs();
		flush();
		expect(unsaved().sort()).toEqual([A, B]);
		expect(snapshot(state).conflicts).toEqual({});
		expect(notices()).toEqual(["a.ssl, b.ssl are no longer on disk. Their unsaved text is open: save to put the files back."]);
		let asked = 0;
		chooseHandler = () => (asked++, null);
		expect(await save(A)).toBe(true);
		expect(asked).toBe(0);
		expect(written).toEqual({ [A]: "edited\n" });
	});

	test("a file that has the kept text by now has nothing unsaved: it gets no tab for it, and the kept text is forgotten", async () => {
		const { keeps } = backendOf({ [A]: { text: "edited\n", mtime: 8 } }, [{ path: A, text: "edited\n", saved: { text: "one\n", mtime: 1 } }]);
		await restoreTabs();
		flush();
		expect(unsaved()).toEqual([]);
		expect(tabs()).toEqual([[]]);
		expect(notices()).toEqual([]);
		await sleep(20);
		expect(keeps).toEqual([{ root: "/ws", keep: [], drop: [A] }]);
	});

	test("text kept with no word of the file it was made over is not taken to fit the file that is there", async () => {
		// What a keep cut short could leave. The file is not written over on the strength of it: saving asks.
		backendOf({ [A]: { text: "one\n", mtime: 1 } }, [{ path: A, text: "edited\n" }]);
		await restoreTabs();
		flush();
		expect(textOf(A)).toBe("edited\n");
		expect(snapshot(state).conflicts).toEqual({ [A]: true });
		const asked: string[] = [];
		chooseHandler = (prompt) => (asked.push(prompt), null);
		expect(await save(A)).toBe(false);
		expect(asked.length).toBe(1);
	});

	test("reloaded without its tabs, the folder keeps the unsaved text for when the file is opened, and says that it has it", async () => {
		const had = (globalThis as any).sessionStorage;
		(globalThis as any).sessionStorage = { getItem: (key: string) => (key === "ssl-studio.skipTabsOnce" ? "1" : null), setItem() {}, removeItem() {} };
		try {
			const { keeps } = backendOf({ [A]: { text: "one\n", mtime: 1 } }, [{ path: A, text: "edited\n", saved: { text: "one\n", mtime: 1 } }]);
			rememberedTabs([A], A);
			await restoreTabs();
			flush();
			expect(tabs()).toEqual([[]]);
			expect(documents.size).toBe(0);
			expect(notices()).toEqual(["Unsaved text is kept for a.ssl. It comes back when the file is opened."]);
			// Nothing of it is forgotten for not being open.
			expect(await keepUnsaved()).toBeNull();
			expect(keeps).toEqual([]);
			await openFile(A, { keep: true });
			flush();
			expect(textOf(A)).toBe("edited\n");
			expect(unsaved()).toEqual([A]);
		} finally {
			(globalThis as any).sessionStorage = had;
		}
	});

	test("unsaved text that cannot be asked for loses nothing: the files open as they are, and why is in Output", async () => {
		backendOf({ [A]: { text: "one\n", mtime: 1 } });
		const answer = rpcHandler;
		rpcHandler = (method, args) => {
			if (method === "unsavedKept") throw new Error("EACCES: permission denied");
			return answer(method, args);
		};
		rememberedTabs([A], A);
		await restoreTabs();
		flush();
		expect(tabs()).toEqual([[A]]);
		expect(textOf(A)).toBe("one\n");
		expect(snapshot(state).output.some((line) => line.includes("the unsaved text kept for ws could not be read: EACCES: permission denied"))).toBe(true);
	});
});

// =============================================================================
// B9-5. "Save all" on the card that stands in for a failed view
// =============================================================================
describe("B9-5: Save all where nothing can be asked", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	test("says which files were not saved and why, does not wait on a question, and still saves the rest", async () => {
		const refused = "/ws/Refused.ssl";
		const changed = "/ws/docs/Changed.md";
		const fine = "/ws/Fine.ssl";
		const written: string[] = [];
		rpcHandler = (method, args) => {
			const path = String(args[0]);
			if (method === "read") {
				// Changed.md is another text on disk by the time it is saved.
				if (path === changed && written.includes("asked")) return { text: "# Written by someone else\n", mtime: 2, encoding: "utf-8" };
				return { text: path.endsWith(".md") ? "# Notes\n" : ":RETURN 1;\n", mtime: 1, encoding: "utf-8" };
			}
			if (method === "write") {
				written.push(path);
				if (path === refused) throw new Error("The disk is full: Refused.ssl was not written.");
				return { mtime: 3 };
			}
			return null;
		};
		for (const path of [refused, changed, fine]) {
			await openFile(path, { keep: true });
			flush();
			typeInto(path, path.endsWith(".md") ? "More. " : "/* more; */ ");
		}
		const untitled = newUntitled();
		flush();
		typeInto(untitled, ":RETURN 2;\n");
		flush();
		expect(Object.keys(snapshot(state).dirty).filter((path) => snapshot(state).dirty[path])).toEqual([refused, changed, fine, untitled]);
		written.push("asked");

		// A question asked here is one nobody can answer: the dialogs are not on screen.
		let questions = 0;
		const never = new Promise<string | null>(() => {});
		chooseHandler = () => (questions++, never);
		askHandler = () => (questions++, never);

		const outcome = await Promise.race([saveAllUnasked(), sleep(1500).then(() => "still waiting" as const)]);
		expect(outcome).not.toBe("still waiting");
		expect(questions).toBe(0);
		expect(outcome).toEqual([
			{ path: refused, why: "The disk is full: Refused.ssl was not written." },
			{ path: changed, why: "it changed on disk after it was opened, and which of the two to keep cannot be asked here", asks: true },
			{ path: untitled, why: "it has no file name yet, and one cannot be asked for here", asks: true },
		]);
		// The file with nothing in its way was saved all the same, and the others were left as they were.
		expect(written.filter((path) => path !== "asked")).toEqual([refused, fine]);
		flush();
		expect(snapshot(state).dirty[fine]).toBe(false);
		expect(snapshot(state).dirty[refused]).toBe(true);
		expect(snapshot(state).dirty[changed]).toBe(true);
		expect((documents.get(changed)!.model as any).getValue()).toBe("More. # Notes\n");

		// What the card shows of it.
		expect(notSavedText(outcome as any)).toBe(
			[
				"3 files were not saved:",
				"The disk is full: Refused.ssl was not written.",
				"Changed.md: it changed on disk after it was opened, and which of the two to keep cannot be asked here.",
				"Untitled-1: it has no file name yet, and one cannot be asked for here.",
				"“Try again” may bring the editor back, where that can be asked.",
			].join("\n"),
		);
	});

	test("with nothing in the way everything is saved, and the card has nothing to say of files not saved", async () => {
		const file = "/ws/Fine.ssl";
		rpcHandler = (method) => (method === "read" ? { text: ":RETURN 1;\n", mtime: 1, encoding: "utf-8" } : method === "write" ? { mtime: 2 } : null);
		await openFile(file, { keep: true });
		flush();
		typeInto(file, "/* more; */ ");
		expect(await saveAllUnasked()).toEqual([]);
		flush();
		expect(snapshot(state).dirty[file]).toBe(false);
		expect(notSavedText([])).toBe("");
		expect(notSavedText([{ path: "/ws/A.ssl", why: "it is no longer open" }])).toBe("1 file was not saved:\nA.ssl: it is no longer open.");
	});

	test("what is typed in an open cell is saved with the rest", async () => {
		const file = "/ws/registry.csv";
		const wrote: string[] = [];
		rpcHandler = (method, args) => (method === "read" ? { text: "Code\n", mtime: 1, encoding: "utf-8" } : method === "write" ? (wrote.push(String(args[1])), { mtime: 2 }) : null);
		await openFile(file, { keep: true });
		flush();
		let typed = "A1\n";
		const release = holdsPendingEdit(() => {
			if (typed) typeInto(file, typed);
			typed = "";
		});
		try {
			expect(await saveAllUnasked()).toEqual([]);
			expect(wrote.length).toBe(1);
			expect(wrote[0]!.replace(/\r\n/g, "\n")).toBe("A1\nCode\n");
		} finally {
			release();
		}
	});

	test("the card's button runs that save and shows its outcome on the card (source text)", () => {
		// The card is drawn by main.tsx, which starts the app when it is loaded and cannot be loaded here.
		const main = readSrc("../src/view/main.tsx");
		expect(main).toContain("setOutcome(notSavedText(await saveAllUnasked()));");
		expect(main).toContain('<button type="button" disabled={saving()} onClick={() => void saveAllHere()}>');
		expect(main).toContain('{outcome() || "All changes were saved."}');
		expect(main).not.toContain("void saveAll()");
	});
});

// =============================================================================
// B8-7. The agent's model, when the list of models cannot be read again
// =============================================================================
describe("B8-7: a model that was saved is the model, whatever comes of reading the list again", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	const models = [
		{ providerID: "ollama", id: "first:8b", name: "First", local: true, tools: true, variants: [] },
		{ providerID: "ollama", id: "second:8b", name: "Second", local: true, tools: true, variants: [] },
	];

	test("the old session ends, the notice says what is so, and the next question starts a new session", async () => {
		const asks: { sessionID?: string }[] = [];
		const saved: unknown[] = [];
		rpcHandler = (method, args) => {
			if (method === "saveSettings") {
				saved.push(args);
				return { ...structuredClone(DEFAULT_SETTINGS), ...(args[1] as Partial<Settings>) };
			}
			if (method !== "agent") return null;
			if (args[0] === "models") throw new Error("opencode did not answer");
			if (args[0] === "ask") {
				asks.push((args[1] as { sessionID?: string }[])[0]!);
				return { sessionID: "session-on-the-second-model", text: "an answer", outcome: "succeeded", tokens: { input: 1, output: 1 } };
			}
			return null;
		};
		setState((s) => {
			s.settings.agentModel = "ollama/first:8b";
		});
		setAgent((s) => {
			s.status = { state: "ready" } as any;
			s.models = structuredClone(models);
			s.entries = [];
			s.busy = false;
			// The conversation so far ran on the first model.
			s.chatSession = "session-on-the-first-model";
		});
		flush();
		const before = chatSessionEpoch();

		// The panel's own call, as its picker makes it: a failure of the whole is caught there and said as "not changed".
		const changed = await chooseModel("ollama/second:8b").catch((e: unknown) => e);
		flush();

		// The setting was saved, and the picker shows what the setting holds.
		expect(saved).toEqual([["user", { agentModel: "ollama/second:8b" }]]);
		expect(currentModel()).toBe("ollama/second:8b");
		// So the change is the change everywhere: it is reported as made, the session of the model before is ended,
		expect(changed).toBe(true);
		expect(snapshot(agent).chatSession).toBeNull();
		expect(chatSessionEpoch()).toBeGreaterThan(before);
		// what could not be done is said for what it is,
		expect(notices().filter((text) => /model/.test(text))).toEqual(["The model was changed, but the list of models could not be read again: opencode did not answer"]);
		// and the list is as it was.
		expect(snapshot(agent).models).toEqual(models);

		// The next question goes to a new session, which opencode starts on the model that is set: not on in the old one.
		await askAbout("And the other one?", false);
		expect(asks.length).toBe(1);
		expect(asks[0]!.sessionID).toBeUndefined();
	});

	test("read again without trouble, the list is the new one and the session ends as before", async () => {
		const relisted = [...models, { providerID: "ollama", id: "third:8b", name: "Third", local: true, tools: true, variants: [] }];
		rpcHandler = (method, args) => {
			if (method === "saveSettings") return { ...structuredClone(DEFAULT_SETTINGS), ...(args[1] as Partial<Settings>) };
			if (method === "agent" && args[0] === "models") return relisted;
			return null;
		};
		setAgent((s) => {
			s.status = { state: "ready" } as any;
			s.models = structuredClone(models);
			s.busy = false;
			s.chatSession = "session-on-the-first-model";
		});
		flush();
		expect(await chooseModel("ollama/second:8b")).toBe(true);
		flush();
		expect(snapshot(agent).chatSession).toBeNull();
		expect(snapshot(agent).models).toEqual(relisted);
		expect(notices()).toEqual([]);
	});

	test("a model that could not be saved changes nothing: the session and the setting stay", async () => {
		rpcHandler = (method) => {
			if (method === "saveSettings") throw new Error("the disk is full");
			if (method === "settings") return { effective: { ...structuredClone(DEFAULT_SETTINGS), agentModel: "ollama/first:8b" }, user: {}, workspace: {} };
			return null;
		};
		setState((s) => {
			s.settings.agentModel = "ollama/first:8b";
		});
		setAgent((s) => {
			s.status = { state: "ready" } as any;
			s.models = structuredClone(models);
			s.busy = false;
			s.chatSession = "session-on-the-first-model";
		});
		flush();
		expect(await chooseModel("ollama/second:8b")).toBe(false);
		flush();
		expect(snapshot(agent).chatSession).toBe("session-on-the-first-model");
		expect(currentModel()).toBe("ollama/first:8b");
	});
});

// =============================================================================
// B6-4. Enter in "Go to symbol" before the symbols have come
// =============================================================================
describe("B6-4: a query is loading from the update in which its question changes", () => {
	test("a reader of `loading` never sees a new question as not loading (source and refetch)", async () => {
		const answers = new Map<string, (value: string) => void>();
		const seen: string[] = [];
		const ctx = createRoot((dispose) => {
			const [key, setKey] = createSignal<string | false>(false);
			const [data, { refetch }] = createAsyncQuery(key, (k) => new Promise<string>((answer) => answers.set(k, answer)));
			// A reader that acts on what it reads, once for each thing read, as the quick pick's waiting Enter does.
			const read = createMemo(() => `${key()}:${data.loading ? "loading" : "idle"}:${data() ?? "-"}`);
			createEffect(
				() => read(),
				(now) => void seen.push(now),
			);
			return { setKey, data, refetch, dispose };
		});
		try {
			flush();
			expect(seen).toEqual(["false:idle:-"]);
			ctx.setKey("a");
			flush();
			// It used to read "a:idle:-" first: the question had changed, and the query still said it was not loading.
			expect(seen.slice(1)).toEqual(["a:loading:-"]);
			answers.get("a")!("for a");
			await sleep(1);
			flush();
			expect(seen.at(-1)).toBe("a:idle:for a");

			seen.length = 0;
			ctx.setKey("b");
			flush();
			// Nor is the answer to the question before read as the answer to this one.
			expect(seen).toEqual(["b:loading:for a"]);
			answers.get("b")!("for b");
			await sleep(1);
			flush();

			seen.length = 0;
			ctx.refetch();
			flush();
			expect(seen).toEqual(["b:loading:for b"]);
			answers.get("b")!("for b, again");
			await sleep(1);
			flush();
			expect(seen.at(-1)).toBe("b:idle:for b, again");
			expect(ctx.data.loading).toBe(false);
		} finally {
			ctx.dispose();
		}
	});

	test("a query with no source is loading from a refetch on, too", async () => {
		let answer!: (value: number) => void;
		const seen: string[] = [];
		const ctx = createRoot((dispose) => {
			const [asked, setAsked] = createSignal(0);
			const [data, { refetch }] = createAsyncQuery(() => new Promise<number>((done) => (answer = done)));
			const read = createMemo(() => `${asked()}:${data.loading ? "loading" : "idle"}:${data() ?? "-"}`);
			createEffect(
				() => read(),
				(now) => void seen.push(now),
			);
			return { data, again: () => (setAsked((n) => n + 1), refetch()), dispose };
		});
		try {
			flush();
			answer(1);
			await sleep(1);
			flush();
			expect(seen.at(-1)).toBe("0:idle:1");
			seen.length = 0;
			// Asked again, with something else that changes in the same update: what reads both reads them together.
			ctx.again();
			flush();
			expect(seen).toEqual(["1:loading:1"]);
			answer(2);
			await sleep(1);
			flush();
			expect(seen.at(-1)).toBe("1:idle:2");
		} finally {
			ctx.dispose();
		}
	});

	/**
	 * The quick pick's own arrangement for "#" (QuickPick.tsx, `Picker`): the question asked of the language server a
	 * moment after the typing stops, the list kept with the question it answers, and the Enter that waits for a
	 * list. The component cannot be drawn here, so these lines are a copy of its lines; the query and `symbolsFor`
	 * are the real ones. `wait` is the 120 ms of the component, shortened.
	 */
	function pickerOf(server: (query: string) => Promise<{ name: string }[]>, wait = 30) {
		return createRoot((dispose) => {
			const [text, setText] = createSignal("#");
			const query = () => text().slice(1);
			const [selected, setSelected] = createSignal(0);
			const [debouncedSymbolQuery, setDebouncedSymbolQuery] = createSignal<string | false>(false);
			const [symbolsPending, setSymbolsPending] = createSignal(false);
			const symbolInput = createMemo(() => query());
			createEffect(
				() => symbolInput(),
				(q) => {
					setSymbolsPending(true);
					const timer = setTimeout(() => {
						setSymbolsPending(false);
						setDebouncedSymbolQuery(q);
					}, wait);
					return () => clearTimeout(timer);
				},
			);
			const [symbols] = createAsyncQuery(debouncedSymbolQuery, async (q) => ({ query: q, list: await server(q) }));
			const items = createMemo(() => symbolsFor(symbols(), query()).map((symbol) => symbol.name));
			const picked: string[] = [];
			const pick = (item?: string) => {
				if (item) picked.push(item);
			};
			const [pendingEnter, setPendingEnter] = createSignal(false);
			const loading = () => symbolsPending() || symbols.loading;
			createEffect(
				() => (pendingEnter() && !loading() ? { pick: true as const, item: items()[selected()] } : { pick: false as const }),
				(next) => {
					if (next.pick) {
						setPendingEnter(false);
						pick(next.item);
					}
				},
			);
			return {
				/** The box's `onInput`. */
				type: (value: string) => (setText(value), setSelected(0), setPendingEnter(false)),
				/** The box's Enter. */
				enter: () => {
					const current = items()[selected()];
					if (current) pick(current);
					else if (loading()) setPendingEnter(true);
				},
				items,
				picked,
				dispose,
			};
		});
	}
	/** A language server that knows three procedures, answers after a moment, and lists nothing for no question. */
	const server = (asked: string[]) => async (query: string) => {
		asked.push(query);
		await sleep(25);
		return query ? ["GetSampleDueDate", "GetUser", "ZebraCount"].filter((name) => name.toLowerCase().includes(query.toLowerCase())).map((name) => ({ name })) : [];
	};

	test("Enter pressed while the symbols are on their way picks the first of them when they come", async () => {
		const asked: string[] = [];
		const box = pickerOf(server(asked));
		try {
			// The box is open, and what it asked with nothing typed has been answered.
			await sleep(120);
			box.type("#getsample");
			// Enter a moment after the last letter, before the question has even been asked.
			await sleep(8);
			expect(box.items()).toEqual([]);
			box.enter();
			expect(box.picked).toEqual([]);
			await sleep(150);
			expect(asked.at(-1)).toBe("getsample");
			// It used to be dropped: at the moment the question was sent the list read as here, and empty.
			expect(box.picked).toEqual(["GetSampleDueDate"]);
		} finally {
			box.dispose();
		}
	});

	test("it never picks from the list of the question before, and typing again lets the Enter go", async () => {
		const asked: string[] = [];
		const box = pickerOf(server(asked));
		try {
			await sleep(120);
			box.type("#get");
			await sleep(150);
			expect(box.items()).toEqual(["GetSampleDueDate", "GetUser"]);
			// Another question: nothing of the old list answers it, so the list is empty and on its way.
			box.type("#zebra");
			await sleep(8);
			expect(box.items()).toEqual([]);
			box.enter();
			await sleep(150);
			expect(box.picked).toEqual(["ZebraCount"]);

			// Typed again after Enter: the Enter was for the question before, and is let go.
			box.picked.length = 0;
			box.type("#user");
			await sleep(8);
			box.enter();
			box.type("#use");
			await sleep(150);
			expect(box.items()).toEqual(["GetUser"]);
			expect(box.picked).toEqual([]);
		} finally {
			box.dispose();
		}
	});

	test("the box closed meanwhile picks nothing", async () => {
		const asked: string[] = [];
		const box = pickerOf(server(asked));
		await sleep(120);
		box.type("#zebra");
		await sleep(8);
		box.enter();
		box.dispose();
		await sleep(150);
		expect(box.picked).toEqual([]);
	});

	test("the quick pick is arranged as the copy above is (source text)", () => {
		const src = readSrc("../src/view/QuickPick.tsx");
		expect(src).toContain("const [symbols] = createAsyncQuery(debouncedSymbolQuery, async (q) => {");
		expect(src).toContain('const loading = () => (mode() === "files" && files.loading) || (mode() === "symbols" && (symbolsPending() || symbols.loading));');
		expect(src).toContain("() => (pendingEnter() && !loading() ? { pick: true as const, item: items()[selected()] } : { pick: false as const }),");
		expect(src).toContain("onInput={(e) => (setText(e.currentTarget.value), setSelected(0), setPendingEnter(false))}");
		expect(src).toContain("else if (loading()) setPendingEnter(true);");
	});
});
