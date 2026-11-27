// The view's side for tests that need a language server to say what a test lets it say, and otherwise nothing: the
// real state module and the real LSP session run against a backend that is a function here, with Monaco and the
// dialogs replaced (the set-up of pass4LowsViewCore.test.ts). The language server is that function too. Importing
// this file puts the replacements in place before the view's modules are loaded, so a test takes those modules
// from here. Not a test file itself: test/formatOnSaveWait.test.ts and test/lspNotAnswering.test.ts run on it.
import { expect, mock } from "bun:test";
import { resolve } from "node:path";
import { flush, snapshot } from "solid-js";
import { DEFAULT_SETTINGS, type BackendEvents } from "../src/shared/protocol";

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

export const fakeModels = new Map<string, FakeModel>();

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

export class FakeRange {
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

/** What the dialogs answer: a test sets these. */
export const dialogs = {
	ask: (() => null) as (prompt: string, initial?: string) => Promise<string | null> | string | null,
	choose: (() => null) as (prompt: string, options?: string[]) => Promise<string | null> | string | null,
};
/**
 * Puts the stand-ins for Monaco and the dialogs in place. Bun binds a replaced module anew for every test file that
 * replaces it, the modules already loaded included: after another file's tests the view's modules hold that file's
 * Monaco. So this is done when this file is first loaded and again by `connectTestRpc`, before a file's tests.
 */
export function installFakes() {
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

	mock.module(resolve(import.meta.dir, "../src/view/dialogs.tsx"), () => ({
		ask: async (prompt: string, initial?: string) => dialogs.ask(prompt, initial),
		choose: async (prompt: string, options?: string[]) => dialogs.choose(prompt, options),
		quickPick: async () => null,
		quickPickMany: async () => null,
		browseWorkspaceFile: async () => null,
	}));
}
installFakes();

const { connect } = await import("../src/view/backend");
export const { answerWait, LspClient } = await import("../src/view/lsp/client");
export const { lspAnswering, session } = await import("../src/view/lsp/session");
export const { documents, formatOnSaveWait, openFile, save, saveAll, setState, state } = await import("../src/view/state");
export const { serverDown, serverSilent, sslOutlineEmpty } = await import("../src/view/panels/server");

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export const until = async (ok: () => boolean) => {
	for (let i = 0; i < 500 && !ok(); i++) await sleep(1);
	expect(ok()).toBe(true);
};

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
export const pushed = <K extends keyof BackendEvents>(event: K, payload: BackendEvents[K]) => {
	liveSocket!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event, payload }) }));
};

let savedWebSocket: typeof globalThis.WebSocket;
let savedLocation: unknown;

export async function connectTestRpc() {
	installFakes();
	savedWebSocket = globalThis.WebSocket;
	savedLocation = (globalThis as any).location;
	(globalThis as any).WebSocket = TestRpcSocket;
	(globalThis as any).location = { protocol: "http:", host: "127.0.0.1:5194" };
	failNextConnect = false;
	await connect();
}

export async function disconnectTestRpc() {
	failNextConnect = true;
	await connect().catch(() => {});
	failNextConnect = false;
	(globalThis as any).WebSocket = savedWebSocket;
	(globalThis as any).location = savedLocation;
}

// --- The language server: what the view sends it, and what a test lets it answer ---
export type Sent = { id?: number; method?: string; params?: any };
/** No answer at all: the request stays asked. */
export const SILENT = Symbol("no answer");
/** What the view has sent the server, and what the server answers to a request: a test sets `answers`. */
export const lsp = { sent: [] as Sent[], answers: (() => SILENT) as (request: Sent) => unknown };
export const answer = (id: number, result: unknown) => pushed("lsp", JSON.stringify({ jsonrpc: "2.0", id, result }));
/** A refusal: an answer all the same. */
export const refuse = (id: number, message: string) => pushed("lsp", JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }));
/** What the server says of its own accord: a notification, or with `id` a request to the client. */
export const serverSays = (method: string, params: unknown, id?: number) => pushed("lsp", JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }));
export const handshake = { capabilities: { documentRangeFormattingProvider: true }, serverInfo: { name: "starlims-lsp", version: "0.2.0" } };
export const asked = (method: string) => lsp.sent.filter((m) => m.method === method && m.id !== undefined);

// --- The files, as the backend holds them ---
/** The files as the backend holds them, each write, and how many times the server was asked to restart. */
export const files = { disk: new Map<string, { text: string; mtime: number }>(), written: [] as { path: string; text: string }[], restarts: 0 };

export const PROCEDURE = ":PROCEDURE Demo;\n:RETURN 1;\n:ENDPROC;\n";
/** What is typed at the top of a file, and what the server's formatter makes of that line. */
export const TYPED = "nCount:=1;";
export const FORMATTED = "nCount := 1;";

export const typeInto = (path: string, text: string) => (documents.get(path)!.model as any).pushEditOperations([], [{ range: new FakeRange(1, 1, 1, 1), text }], () => null);
export const textOf = (path: string) => (documents.get(path)!.model as any).getValue() as string;
export const dirty = (path: string) => snapshot(state).dirty[path];
/** An SSL file on disk, open, with a line typed at its top that is not yet formatted. */
export async function openChanged(path: string) {
	files.disk.set(path, { text: PROCEDURE, mtime: 1 });
	await openFile(path, { keep: true });
	flush();
	typeInto(path, `${TYPED}\n`);
	flush();
	expect(dirty(path)).toBe(true);
}

/** The server's process runs and the session has asked it to start; what it answers is the test's. */
export async function serverRuns(answers: (request: Sent) => unknown) {
	lsp.answers = answers;
	setState((s) => {
		s.lsp = { state: "running" };
	});
	flush();
	void session.start("/ws").catch(() => {});
	await until(() => asked("initialize").length > 0);
}

/** What the work came to and how long it took; "still waiting" when it has not come back after two seconds. */
export async function timed<T>(work: Promise<T>) {
	const start = performance.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const result = await Promise.race([work, new Promise<"still waiting">((done) => (timer = setTimeout(() => done("still waiting"), 2000)))]);
	clearTimeout(timer);
	return { result, ms: performance.now() - start };
}

/** Gives the model's stand-in the two things the session reads a server's edits by (Monaco's own model has both). */
export function readsRanges(path: string) {
	const model = documents.get(path)!.model as any;
	model.validateRange = (range: FakeRange) => range;
	model.getValueInRange = (range: FakeRange) => {
		const lines = (model.getValue() as string).split(model.getEOL());
		const offsetOf = (line: number, column: number) => lines.slice(0, line - 1).reduce((sum: number, l: string) => sum + l.length + model.getEOL().length, 0) + column - 1;
		return (model.getValue() as string).slice(offsetOf(range.startLineNumber, range.startColumn), offsetOf(range.endLineNumber, range.endColumn));
	};
}
/** The server's formatter, for the one line the tests type. */
export const formatsTheLine = (request: Sent) => [{ range: request.params.range, newText: FORMATTED }];

export function resetAll() {
	// What was asked of the server and never answered is refused: a save left waiting on it in the test before ends there.
	session.reset();
	for (const doc of [...documents.values()]) doc.model?.dispose?.();
	documents.clear();
	fakeModels.clear();
	files.disk.clear();
	lsp.sent = [];
	files.written = [];
	files.restarts = 0;
	lsp.answers = () => SILENT;
	dialogs.ask = () => null;
	dialogs.choose = () => null;
	rpcHandler = (method, args) => {
		const path = String(args[0]);
		if (method === "read") {
			const file = files.disk.get(path);
			if (!file) throw new Error(`${path} is not there`);
			return { ...file, encoding: "utf-8" };
		}
		if (method === "write") {
			const file = { text: String(args[1]), mtime: (files.disk.get(path)?.mtime ?? 0) + 1 };
			files.disk.set(path, file);
			files.written.push({ path, text: file.text });
			return { mtime: file.mtime };
		}
		if (method === "lspSend") {
			const message = JSON.parse(String(args[0])) as Sent;
			lsp.sent.push(message);
			if (message.id !== undefined && message.method) {
				const result = lsp.answers(message);
				if (result !== SILENT) queueMicrotask(() => answer(message.id!, result));
			}
			return null;
		}
		if (method === "lspRestart") files.restarts++;
		return null;
	};
	setState((s) => {
		s.workspace = { root: "/ws", name: "ws" };
		s.project = null;
		s.groups = [{ tabs: [], active: null }];
		s.activeGroup = 0;
		s.dirty = {};
		s.conflicts = {};
		s.messages = [];
		s.output = [];
		s.lsp = { state: "stopped" };
		s.settings = structuredClone(DEFAULT_SETTINGS);
		s.centerView = "editors";
		s.info = null;
	});
	flush();
}
