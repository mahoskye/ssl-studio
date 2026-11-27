// A save does not depend on the language server: format on save waits for the server's formatting no longer than a
// set time, the file is then written as it was typed, and it is said once. Seen on 2026-11-26 with an old
// starlims-lsp taken from the PATH: it answered `initialize`, asked the client to register a file watcher, and read
// nothing after that. Ctrl+S then wrote nothing and said nothing for as long as the server ran.
// The view's side runs the real state module and the real LSP session against a backend that is a function here,
// with Monaco and the dialogs replaced (the set-up of pass4LowsViewCore.test.ts, copied). The language server is
// that function too: it answers what a test lets it answer, and otherwise says nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
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
const { session } = await import("../src/view/lsp/session");
const { documents, formatOnSaveWait, openFile, save, saveAll, setState, state } = await import("../src/view/state");

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const until = async (ok: () => boolean) => {
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

// --- The language server: what the view sends it, and what a test lets it answer ---
type Sent = { id?: number; method?: string; params?: any };
/** No answer at all: the request stays asked. */
const SILENT = Symbol("no answer");
let sent: Sent[] = [];
let server: (request: Sent) => unknown = () => SILENT;
const answer = (id: number, result: unknown) => pushed("lsp", JSON.stringify({ jsonrpc: "2.0", id, result }));
const handshake = { capabilities: { documentRangeFormattingProvider: true }, serverInfo: { name: "starlims-lsp", version: "0.2.0" } };
const asked = (method: string) => sent.filter((m) => m.method === method && m.id !== undefined);

// --- The files, as the backend holds them ---
const disk = new Map<string, { text: string; mtime: number }>();
let written: { path: string; text: string }[] = [];
let restarts = 0;

const NOTICE = "The language server is not answering: files are saved without formatting until it does.";
const PROCEDURE = ":PROCEDURE Demo;\n:RETURN 1;\n:ENDPROC;\n";
/** What is typed at the top of a file, and what the server's formatter makes of that line. */
const TYPED = "nCount:=1;";
const FORMATTED = "nCount := 1;";

const typeInto = (path: string, text: string) => (documents.get(path)!.model as any).pushEditOperations([], [{ range: new FakeRange(1, 1, 1, 1), text }], () => null);
const textOf = (path: string) => (documents.get(path)!.model as any).getValue() as string;
const dirty = (path: string) => snapshot(state).dirty[path];
/** The notice, by the number of each time it was said. */
const said = () => snapshot(state).messages.filter((m) => m.text === NOTICE).map((m) => m.id);
const skips = () => snapshot(state).output.filter((line) => line.includes("format on save skipped"));

/** An SSL file on disk, open, with a line typed at its top that is not yet formatted. */
async function openChanged(path: string) {
	disk.set(path, { text: PROCEDURE, mtime: 1 });
	await openFile(path, { keep: true });
	flush();
	typeInto(path, `${TYPED}\n`);
	flush();
	expect(dirty(path)).toBe(true);
}

/** The server's process runs and the session has asked it to start; what it answers is the test's. */
async function serverRuns(answers: (request: Sent) => unknown) {
	server = answers;
	setState((s) => {
		s.lsp = { state: "running" };
	});
	flush();
	void session.start("/ws").catch(() => {});
	await until(() => asked("initialize").length > 0);
}

/** What the work came to and how long it took; "still waiting" when it has not come back after two seconds. */
async function timed<T>(work: Promise<T>) {
	const start = performance.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const result = await Promise.race([work, new Promise<"still waiting">((done) => (timer = setTimeout(() => done("still waiting"), 2000)))]);
	clearTimeout(timer);
	return { result, ms: performance.now() - start };
}

/** Gives the model's stand-in the two things the session reads a server's edits by (Monaco's own model has both). */
function readsRanges(path: string) {
	const model = documents.get(path)!.model as any;
	model.validateRange = (range: FakeRange) => range;
	model.getValueInRange = (range: FakeRange) => {
		const lines = (model.getValue() as string).split(model.getEOL());
		const offsetOf = (line: number, column: number) => lines.slice(0, line - 1).reduce((sum: number, l: string) => sum + l.length + model.getEOL().length, 0) + column - 1;
		return (model.getValue() as string).slice(offsetOf(range.startLineNumber, range.startColumn), offsetOf(range.endLineNumber, range.endColumn));
	};
}
/** The server's formatter, for the one line the tests type. */
const formatsTheLine = (request: Sent) => [{ range: request.params.range, newText: FORMATTED }];

function resetAll() {
	// What was asked of the server and never answered is refused: a save left waiting on it in the test before ends there.
	session.reset();
	for (const doc of [...documents.values()]) doc.model?.dispose?.();
	documents.clear();
	fakeModels.clear();
	disk.clear();
	sent = [];
	written = [];
	restarts = 0;
	server = () => SILENT;
	askHandler = () => null;
	chooseHandler = () => null;
	rpcHandler = (method, args) => {
		const path = String(args[0]);
		if (method === "read") {
			const file = disk.get(path);
			if (!file) throw new Error(`${path} is not there`);
			return { ...file, encoding: "utf-8" };
		}
		if (method === "write") {
			const file = { text: String(args[1]), mtime: (disk.get(path)?.mtime ?? 0) + 1 };
			disk.set(path, file);
			written.push({ path, text: file.text });
			return { mtime: file.mtime };
		}
		if (method === "lspSend") {
			const message = JSON.parse(String(args[0])) as Sent;
			sent.push(message);
			if (message.id !== undefined && message.method) {
				const result = server(message);
				if (result !== SILENT) queueMicrotask(() => answer(message.id!, result));
			}
			return null;
		}
		if (method === "lspRestart") restarts++;
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

describe("a save does not wait on a language server that does not answer", () => {
	// The waits as they ship are the bound a person meets; the tests run on shorter ones.
	const shipped = { ...formatOnSaveWait };
	const LONG = 300;
	const SHORT = 20;
	beforeAll(async () => {
		await connectTestRpc();
		Object.assign(formatOnSaveWait, { answering: LONG, silent: SHORT });
	});
	beforeEach(async () => {
		resetAll();
		// The refusals reach the saves that waited, and the silence of the test before is over.
		await sleep(0);
	});
	// The state module is one for the whole run: the waits and the silence are put back for the test files after this one.
	afterAll(async () => {
		resetAll();
		await sleep(0);
		Object.assign(formatOnSaveWait, shipped);
		await disconnectTestRpc();
	});

	test("the wait that ships is two seconds, and a quarter of a second while the server is silent", () => {
		expect(shipped).toEqual({ answering: 2000, silent: 250 });
		expect(DEFAULT_SETTINGS.formatOnSave).toBe(true);
	});

	test("a server that never finishes starting: the file is written when the wait is up, as typed, and it is said", async () => {
		const path = "/ws/Demo.ssl";
		await serverRuns(() => SILENT);
		await openChanged(path);

		const first = await timed(save(path));
		expect(first.result).toBe(true);
		// It did wait for the server, and no longer than it says.
		expect(first.ms).toBeGreaterThanOrEqual(LONG - 20);
		expect(written).toEqual([{ path, text: `${TYPED}\n${PROCEDURE}` }]);
		flush();
		expect(dirty(path)).toBe(false);
		expect(textOf(path)).toBe(`${TYPED}\n${PROCEDURE}`);
		// Said in a notice, with the way out of it, and in Output where it can be read again.
		expect(said().length).toBe(1);
		const notice = snapshot(state).messages.find((m) => m.text === NOTICE)!;
		expect(notice.kind).toBe("info");
		expect(notice.action?.label).toBe("Restart");
		expect(skips().length).toBe(1);
		expect(skips()[0]).toContain(`format on save skipped: the language server did not answer in ${LONG / 1000} s`);
		// The handshake was never answered, so nothing else was asked of the server.
		expect(sent.filter((m) => m.id !== undefined).map((m) => m.method)).toEqual(["initialize"]);

		// The button restarts the server, as the status bar's does.
		notice.action!.run();
		await until(() => restarts === 1);
	});

	test("the build that was seen (the handshake answered, then nothing): saved all the same, and said once for the silence", async () => {
		const path = "/ws/Demo.ssl";
		await serverRuns((request) => (request.method === "initialize" ? handshake : SILENT));
		await session.waitReady();
		await openChanged(path);

		const first = await timed(save(path));
		expect(first.result).toBe(true);
		expect(first.ms).toBeGreaterThanOrEqual(LONG - 20);
		expect(written.map((w) => w.text)).toEqual([`${TYPED}\n${PROCEDURE}`]);
		expect(asked("textDocument/documentSymbol").length).toBe(1);
		const once = said();
		expect(once.length).toBe(1);

		// Saved again while the server still says nothing: the short wait, the file written, and no second notice.
		typeInto(path, "/* more; */\n");
		flush();
		const second = await timed(save(path));
		expect(second.result).toBe(true);
		expect(second.ms).toBeLessThan(LONG - 50);
		expect(written.length).toBe(2);
		expect(written[1]!.text).toBe(`/* more; */\n${TYPED}\n${PROCEDURE}`);
		flush();
		expect(dirty(path)).toBe(false);
		expect(said()).toEqual(once);
		// Output has each.
		expect(skips().length).toBe(2);
		expect(skips()[1]).toContain(`did not answer in ${SHORT / 1000} s`);
	});

	test("an answer that comes after the file is written is not put into it", async () => {
		const path = "/ws/Demo.ssl";
		// The outline is answered; the formatting is not, until the test answers it.
		await serverRuns((request) => (request.method === "initialize" ? handshake : request.method === "textDocument/documentSymbol" ? [] : SILENT));
		await session.waitReady();
		await openChanged(path);
		readsRanges(path);

		expect((await timed(save(path))).result).toBe(true);
		expect(written.map((w) => w.text)).toEqual([`${TYPED}\n${PROCEDURE}`]);
		const late = asked("textDocument/rangeFormatting");
		expect(late.length).toBe(1);
		expect(late[0]!.params.range.start.line).toBe(0);
		const once = said();
		expect(once.length).toBe(1);

		// The server answers now, with the line formatted. The file on disk is as typed, and so the document stays.
		answer(late[0]!.id!, formatsTheLine(late[0]!));
		await sleep(5);
		flush();
		expect(textOf(path)).toBe(`${TYPED}\n${PROCEDURE}`);
		expect(dirty(path)).toBe(false);
		expect(written.length).toBe(1);

		// It answers again, so the next save waits the long time for it once more, and gets its formatting.
		server = (request) => (request.method === "textDocument/documentSymbol" ? [] : request.method === "textDocument/rangeFormatting" ? [{ range: request.params.range, newText: "nTotal := 2;" }] : SILENT);
		typeInto(path, "nTotal:=2;\n");
		flush();
		const next = await timed(save(path));
		expect(next.result).toBe(true);
		expect(next.ms).toBeLessThan(LONG - 50);
		expect(written.at(-1)!.text).toBe(`nTotal := 2;\n${TYPED}\n${PROCEDURE}`);
		expect(textOf(path)).toBe(`nTotal := 2;\n${TYPED}\n${PROCEDURE}`);
		expect(said()).toEqual(once);
		expect(skips().length).toBe(1);
	});

	test("a server that answers formats the changed lines before the file is written, and nothing is said", async () => {
		const path = "/ws/Demo.ssl";
		await serverRuns((request) => (request.method === "initialize" ? handshake : request.method === "textDocument/documentSymbol" ? [] : request.method === "textDocument/rangeFormatting" ? formatsTheLine(request) : SILENT));
		await session.waitReady();
		await openChanged(path);
		readsRanges(path);

		const saved = await timed(save(path));
		expect(saved.result).toBe(true);
		expect(saved.ms).toBeLessThan(LONG - 50);
		expect(written).toEqual([{ path, text: `${FORMATTED}\n${PROCEDURE}` }]);
		flush();
		expect(dirty(path)).toBe(false);
		expect(said()).toEqual([]);
		expect(skips()).toEqual([]);

		// With the setting off the server is not asked at all.
		setState((s) => {
			s.settings.formatOnSave = false;
		});
		flush();
		const before = asked("textDocument/rangeFormatting").length;
		typeInto(path, "nTotal:=2;\n");
		flush();
		expect(await save(path)).toBe(true);
		expect(written.at(-1)!.text).toBe(`nTotal:=2;\n${FORMATTED}\n${PROCEDURE}`);
		expect(asked("textDocument/rangeFormatting").length).toBe(before);
	});

	test("“Save all” over a silent server waits the long time once, not once for every file", async () => {
		const paths = ["/ws/One.ssl", "/ws/Two.ssl", "/ws/Three.ssl", "/ws/Four.ssl"];
		await serverRuns((request) => (request.method === "initialize" ? handshake : SILENT));
		await session.waitReady();
		for (const path of paths) await openChanged(path);

		const all = await timed(saveAll());
		expect(all.result).toBe(true);
		expect(written.map((w) => w.path)).toEqual(paths);
		expect(all.ms).toBeGreaterThanOrEqual(LONG - 20);
		expect(all.ms).toBeLessThan(2 * LONG);
		flush();
		for (const path of paths) expect(dirty(path)).toBe(false);
		expect(said().length).toBe(1);
		expect(skips().length).toBe(paths.length);
	});

	test("a restart ends the silence: the new server is waited for the long time, and its silence is said anew", async () => {
		const path = "/ws/Demo.ssl";
		await serverRuns((request) => (request.method === "initialize" ? handshake : SILENT));
		await session.waitReady();
		await openChanged(path);
		expect((await timed(save(path))).result).toBe(true);
		const first = said();
		expect(first.length).toBe(1);

		// The server is restarted from the status bar: what was asked of the old one is refused, and a new one starts.
		pushed("lspState", { state: "restarting" });
		pushed("lspState", { state: "running" });
		await until(() => asked("initialize").length === 2);
		await session.waitReady();
		// The refusal of what the save had asked is not a second "skipped" in Output: that save was told of already.
		expect(skips().length).toBe(1);

		// The new one is as silent. A save gives it the long wait, and says so again.
		typeInto(path, "/* more; */\n");
		flush();
		const again = await timed(save(path));
		expect(again.result).toBe(true);
		expect(again.ms).toBeGreaterThanOrEqual(LONG - 20);
		expect(written.length).toBe(2);
		const second = said();
		expect(second.length).toBe(1);
		expect(second[0]).not.toBe(first[0]);
	});
});
