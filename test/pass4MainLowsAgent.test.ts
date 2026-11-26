// Three low findings of audit pass 4 that were on main before the branch: what the tidy steps write into the
// context note, the boxes of a task list in a reply, and "Import Mermaid flowchart as Plan…".
//
// The tidy steps and the command run as they do in the app: the real state module, the real agent store and the
// real command, against a backend that is a function here, with Monaco and the dialogs replaced (the set-up of
// pass4LowsViewCore.test.ts, copied). The agent's reply is a text the test hands back from the backend's `agent`
// call: no opencode and no model is started, here or by anything this file imports.
//
// A reply's Markdown is run through the real renderer. What DOMPurify then does with it needs a DOM, which bun
// has not: the lists and the rule it is given are tested here, and the whole of it (the 22 probes of the audit
// and the ones below) was run in a browser when the fix was made; see the test that says so.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { flush, snapshot } from "solid-js";
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


/** What the dialogs were asked, in order, and what the test answers. */
type PickOptions = { title: string; placeholder?: string; items: { label: string; value: unknown; detail?: string; description?: string; divide?: boolean }[] };
let asked: string[] = [];
let picks: PickOptions[] = [];
let askHandler: (prompt: string, initial?: string) => string | null = () => null;
let chooseHandler: (prompt: string, buttons: string[]) => string | null = () => null;
let quickPickHandler: (options: PickOptions) => unknown = () => null;
let browseHandler: (options: { title?: string; root: string; pinned?: { path: string; rel: string }[] }) => { path: string; rel: string } | null = () => null;
mock.module(resolve(import.meta.dir, "../src/view/dialogs.tsx"), () => ({
	ask: async (prompt: string, initial?: string) => {
		asked.push(`ask: ${prompt}`);
		return askHandler(prompt, initial);
	},
	choose: async (prompt: string, buttons: string[]) => {
		asked.push(`choose: ${prompt}`);
		return chooseHandler(prompt, buttons);
	},
	quickPick: async (options: PickOptions) => {
		asked.push(`pick: ${options.title}`);
		picks.push(options);
		return quickPickHandler(options);
	},
	quickPickMany: async () => null,
	browseWorkspaceFile: async (options: { title?: string; root: string; pinned?: { path: string; rel: string }[] }) => {
		asked.push(`browse: ${options.title}`);
		return browseHandler(options);
	},
}));

const { connect } = await import("../src/view/backend");
const { closeReview, review } = await import("../src/view/editor/Review");
const { documents, openFile, setState, state } = await import("../src/view/state");
const { resetRecentTabs } = await import("../src/view/recentTabs");
const { registerLiveEditor } = await import("../src/view/editor/liveBridge");
const { resetTidy, runStep, sameNote, startTidy, tidy } = await import("../src/view/agent/tidy");
const { agent, setAgent } = await import("../src/view/agent/store");
const { REPLY_PURIFY_CONFIG, replyKeepsAttribute, replyMarkup } = await import("../src/view/agent/markdown");
const { flowchartSourceRows, runCommand } = await import("../src/view/commands");

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
	registerLiveEditor(0, undefined);
	for (const doc of [...documents.values()]) doc.model?.dispose?.();
	documents.clear();
	fakeModels.clear();
	storage.clear();
	resetRecentTabs();
	resetTidy();
	asked = [];
	picks = [];
	askHandler = () => null;
	chooseHandler = () => null;
	quickPickHandler = () => null;
	browseHandler = () => null;
	rpcHandler = () => null;
	setState((s) => {
		s.workspace = { root: "/ws", name: "ws" };
		s.project = { root: "/ws", path: "/ws/.ssl-studio/project.toml", configured: true, docs: "docs", plans: "design", schema: "schema" } as any;
		s.groups = [{ tabs: [], active: null }];
		s.activeGroup = 0;
		s.dirty = {};
		s.conflicts = {};
		s.messages = [];
		s.cursor = { line: 1, column: 1 };
		s.lsp = { state: "stopped" };
		s.settings = structuredClone(DEFAULT_SETTINGS);
		s.bottomMaximized = false;
		s.centerView = "editors";
		s.info = null;
	});
	setAgent((s) => {
		s.status = { state: "ready" } as any;
		s.entries = [];
		s.busy = false;
	});
	flush();
}

const notices = () => snapshot(state).messages.map((m) => m.text);
const typeInto = (path: string, text: string) => (documents.get(path)!.model as any).pushEditOperations([], [{ range: new FakeRange(1, 1, 1, 1), text }], () => null);

/** A folder of files held here, as the backend would give and take them. What is written, and what is kept in history first, is listed. */
function workspaceOf(files: Record<string, string>, agentReply?: string) {
	const disk: Record<string, string> = { ...files };
	const writes: [string, string][] = [];
	const kept: string[] = [];
	const prompts: string[] = [];
	rpcHandler = (method, args) => {
		const path = String(args[0]);
		if (method === "read") {
			if (!(path in disk)) throw new Error(`ENOENT: no such file, open '${path}'`);
			return { text: disk[path], mtime: 1, encoding: "utf-8" };
		}
		if (method === "sizes") return Object.fromEntries((args[0] as string[]).filter((p) => p in disk).map((p) => [p, disk[p]!.length]));
		if (method === "files") return Object.keys(disk);
		if (method === "historyKeep") return void kept.push(path);
		if (method === "write") {
			writes.push([path, String(args[1])]);
			disk[path] = String(args[1]);
			return { mtime: 2 };
		}
		if (method === "agent" && args[0] === "ask" && agentReply !== undefined) {
			prompts.push((args[1] as { text: string }[])[0]!.text);
			return { sessionID: "session", text: agentReply, outcome: "succeeded", tokens: { input: 4000, output: 40 } };
		}
		return null;
	};
	return { disk, writes, kept, prompts };
}

// =============================================================================
// B8-6. What a tidy step writes into the context note
// =============================================================================
describe("B8-6: nothing the agent wrote goes into the tidy note unseen, and a note that would not change is not written", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	const SCRIPT = "/ws/Demo.ssl";
	const NOTE_FILE = "/ws/design/Demo.tidy.md";
	const NOTE = "# Tidy notes: Demo.ssl\n\nSets the due date of a sample.\n";
	const UNCHANGED_WITH_ENTRY = "UNCHANGED\n\n```markdown\n- Nothing to guard: the procedure takes no parameters.\n```\n";
	const step = (index: number) => snapshot(tidy).steps[index];
	const said = () => snapshot(agent).entries.filter((e) => e.role === "note").map((e) => e.text);

	async function tidying(reply: string, files: Record<string, string> = { [NOTE_FILE]: NOTE }) {
		const ws = workspaceOf({ [SCRIPT]: ":PROCEDURE Demo;\n:ENDPROC;\n", ...files }, reply);
		await openFile(SCRIPT);
		flush();
		startTidy();
		return ws;
	}

	test("a step that changes no code: its entry for the note is put up for review, and nothing is written before it is accepted", async () => {
		const ws = await tidying(UNCHANGED_WITH_ENTRY);
		await runStep(1);
		flush();

		// The agent was told this, and it is now so (the entry used to be in the file by this point).
		expect(ws.prompts[0]).toContain("SSL Studio will save what you return after the user reviews it");
		expect(ws.writes).toEqual([]);
		expect(step(1)).toBe("review");
		const shown = review()!;
		expect(shown.title).toBe("Tidy 2/6 Guards: note");
		expect(shown.path).toBe(NOTE_FILE);
		// The left side is the note as it is, the right side the note with the entry after it.
		expect(shown.original).toBe(NOTE);
		expect(shown.proposed.startsWith(`${NOTE.trimEnd()}\n\n## Step 2: Guards (`)).toBe(true);
		expect(shown.proposed.endsWith(")\n\n- Nothing to guard: the procedure takes no parameters.\n")).toBe(true);
		expect(shown.effect).toBe("Demo.ssl stays as it is. Accepting saves the right side as the context note, design/Demo.tidy.md.");
		expect(said()).toContain("Guards: no changes proposed (UNCHANGED).");

		// Accepted, with a word of the user's own added in the review: that is what is saved, once.
		const final = `${shown.proposed}- Checked by hand.\n`;
		await shown.onAccept(final);
		flush();
		expect(ws.writes).toEqual([[NOTE_FILE, final]]);
		expect(step(1)).toBe("unchanged");
	});

	test("rejected, the entry is not kept: nothing is written and the step is what its reply said, unchanged", async () => {
		const ws = await tidying(UNCHANGED_WITH_ENTRY);
		await runStep(2);
		flush();
		expect(review()!.title).toBe("Tidy 3/6 Structure: note");
		await review()!.onReject!();
		flush();
		expect(ws.writes).toEqual([]);
		expect(ws.disk[NOTE_FILE]).toBe(NOTE);
		expect(step(2)).toBe("unchanged");
	});

	test("a step that changes no code and has no entry puts nothing up and writes nothing, as before", async () => {
		const ws = await tidying("UNCHANGED\n");
		await runStep(1);
		flush();
		expect(review()).toBeNull();
		expect(ws.writes).toEqual([]);
		expect(step(1)).toBe("unchanged");
		expect(said()).toContain("Guards: no changes proposed (UNCHANGED).");
	});

	test("a context note that comes back as it is, is not put up for review and not written", async () => {
		// The same note, in a fence, with the line ends of another system and no line end after its last line.
		const ws = await tidying("```markdown\n" + NOTE.trimEnd().replace(/\n/g, "\r\n") + "\n```\n");
		await runStep(0);
		flush();
		expect(review()).toBeNull();
		expect(ws.writes).toEqual([]);
		expect(step(0)).toBe("unchanged");
		expect(said()).toContain("Context: the note is as it was. There is nothing to review, and nothing was written.");
	});

	test("a context note that differs is reviewed as before, and saved when accepted", async () => {
		const ws = await tidying("```markdown\n# Tidy notes: Demo.ssl\n\nSets the due date of a sample from its order.\n```\n");
		await runStep(0);
		flush();
		expect(ws.writes).toEqual([]);
		const shown = review()!;
		expect(shown.title).toBe("Tidy 1/6 Context");
		expect(shown.original).toBe(NOTE);
		await shown.onAccept(shown.proposed);
		flush();
		expect(ws.writes).toEqual([[NOTE_FILE, "# Tidy notes: Demo.ssl\n\nSets the due date of a sample from its order.\n"]]);
		expect(step(0)).toBe("accepted");
	});

	test("accepting a text that is the note as it stands writes nothing", async () => {
		const ws = await tidying("```markdown\n# Tidy notes: Demo.ssl\n\nSomething else.\n```\n");
		await runStep(0);
		flush();
		// The user took the proposed lines out again in the review, and pressed Accept.
		await review()!.onAccept(NOTE);
		flush();
		expect(ws.writes).toEqual([]);
		expect(step(0)).toBe("unchanged");
	});

	test("a note that changed after the step read it is not written over: the review says so and stays", async () => {
		const ws = await tidying("```markdown\nAll six steps hold.\n```\n");
		await runStep(5);
		flush();
		const shown = review()!;
		expect(shown.title).toBe("Tidy 6/6 Verify");
		expect(shown.original).toBe(NOTE);
		// Meanwhile another step's entry was accepted into the note (or the user wrote in it).
		const newer = `${NOTE}\n## Step 2: Guards (today)\n\n- An entry accepted meanwhile.\n`;
		ws.disk[NOTE_FILE] = newer;
		let refused = "";
		await Promise.resolve(shown.onAccept(shown.proposed)).catch((e: Error) => (refused = e.message));
		flush();
		expect(refused).toBe("design/Demo.tidy.md was changed after this tidy step read it. Reject and run the step again so that change is not written over.");
		expect(ws.writes).toEqual([]);
		expect(ws.disk[NOTE_FILE]).toBe(newer);
		// Not accepted, so still under review.
		expect(step(5)).toBe("review");
	});

	test("an empty reply is not a note: the step fails, with nothing put up and nothing written", async () => {
		const ws = await tidying("   \n");
		await runStep(0);
		flush();
		expect(review()).toBeNull();
		expect(ws.writes).toEqual([]);
		expect(step(0)).toBe("failed");
		expect(snapshot(tidy).problems[0]).toBe("The reply was empty: there is nothing to put in the note. Try again.");
	});

	test("the same note: line ends and the blank end of the file aside, and nothing else", () => {
		expect(sameNote("a\nb\n", "a\r\nb")).toBe(true);
		expect(sameNote("a\nb\n\n\n", "a\nb")).toBe(true);
		expect(sameNote("", "\n")).toBe(true);
		expect(sameNote("a\nb\n", "a\n\nb\n")).toBe(false);
		expect(sameNote("a\nb\n", "a\nb \nc\n")).toBe(false);
		expect(sameNote("a\nb\n", " a\nb\n")).toBe(false);
	});
});

// =============================================================================
// B8-8. The boxes of a task list in a reply
// =============================================================================
describe("B8-8: a reply's task list shows its boxes, drawn, and no input of any kind comes with them", () => {
	const OPEN = '<span class="task-box" role="img" aria-label="Not done"></span>';
	const DONE = '<span class="task-box checked" role="img" aria-label="Done"></span>';
	const count = (html: string, part: string) => html.split(part).length - 1;

	test("`- [ ] step` and `- [x] done` are drawn as boxes: a span each, not an input", () => {
		// These came out of the renderer as `<input disabled type="checkbox">`, which a reply may not hold: the
		// sanitiser took them out, and the list was three plain bullets.
		expect(replyMarkup("- [ ] step\n- [x] done\n- plain")).toBe(`<ul>\n<li>${OPEN} step</li>\n<li>${DONE} done</li>\n<li>plain</li>\n</ul>\n`);
	});

	test("so are the boxes of a numbered list, of items with paragraphs, and of a list inside a list", () => {
		const html = replyMarkup("1. [x] numbered\n2. [ ] two\n\n- [ ] loose\n\n- [X] loose and done\n\n  second paragraph\n\n- [x] **outer**\n  - [ ] inner\n");
		expect(html).toContain(`<ol>\n<li>${DONE} numbered</li>\n<li>${OPEN} two</li>\n</ol>`);
		expect(html).toContain(`<li><p>${OPEN} loose</p>`);
		expect(html).toContain(`<li><p>${DONE} loose and done</p>\n<p>second paragraph</p>`);
		expect(html).toContain(`${DONE} <strong>outer</strong>`);
		expect(html).toContain(`<li>${OPEN} inner</li>`);
		expect(count(html, "task-box")).toBe(6);
		expect(html).not.toContain("<input");
	});

	test("what is not a task is not given a box", () => {
		for (const text of ["- [x]no space", "- [x]\n- [ ] ", "[ ] not in a list", "- a [x] in the middle", "`- [ ] in code`", "```\n- [ ] in a fence\n```"]) {
			expect(replyMarkup(text), text).not.toContain("task-box");
		}
	});

	test("the renderer draws a box for a task and for nothing else: an input the reply writes itself stays an input, for the sanitiser to refuse", () => {
		// Every spelling here reaches the sanitiser as the `<input>` (or the form) it is, never as the drawn box.
		const smuggled = [
			"<input type=checkbox checked disabled> a checkbox of the reply's own",
			'<input type="checkbox" disabled class="task-box checked">',
			'<input type=text class="task-box" name=q value=1 autofocus onclick=alert(1) formaction=https://example.invalid/>',
			'<input type=image class="task-box" src=https://example.invalid/i.png>',
			'<input type=submit class="task-box checked" formaction=https://example.invalid/ value=go>',
			"<input type=file class=task-box> <input type=hidden name=task-box value=1> <input type=password> <input type=radio>",
			'<form class="task-box" action=https://example.invalid/><input name=q><button formaction=https://example.invalid/>go</button></form>',
		];
		for (const text of smuggled) {
			const html = replyMarkup(text);
			expect(html, text).toContain(text.startsWith("<form") ? "<form" : "<input");
			expect(html, text).not.toContain('role="img"');
		}
		// Beside a real task, the box is the renderer's and the input is still the reply's.
		const mixed = replyMarkup("- [x] <input type=text name=q value=1 autofocus onclick=alert(1) formaction=https://example.invalid/>");
		expect(count(mixed, DONE)).toBe(1);
		expect(count(mixed, "<input")).toBe(1);
		// And what the sanitiser is told to refuse is what it was told before: every form control, and the attributes
		// that name, send or style.
		for (const tag of ["input", "form", "button", "select", "textarea", "img", "iframe", "object", "embed", "style", "svg", "math"]) expect(REPLY_PURIFY_CONFIG.FORBID_TAGS, tag).toContain(tag);
		for (const attr of ["name", "id", "style", "action", "formaction", "src", "srcset", "ping", "background", "poster", "popover", "popovertarget", "command", "commandfor"]) expect(REPLY_PURIFY_CONFIG.FORBID_ATTR, attr).toContain(attr);
		expect(REPLY_PURIFY_CONFIG.ALLOW_DATA_ATTR).toBe(false);
	});

	test("the one class a span keeps is the box's, spelled as the renderer writes it; nothing rides in on it", () => {
		expect(replyKeepsAttribute("span", "class", "task-box")).toBe(true);
		expect(replyKeepsAttribute("SPAN", "class", "task-box checked")).toBe(true);
		// Another class beside it, another spelling, or another element: refused as every class is.
		for (const value of ["task-box overlay", "overlay task-box", "task-box checked dialog", "task-box  checked", "task-box\tchecked", "task-box\nchecked", "task-box checked ", " task-box", "TASK-BOX", "Task-Box", "task-boxes", "checked", "checked task-box", "task-box task-box", "task-box,checked", ""]) {
			expect(replyKeepsAttribute("span", "class", value), JSON.stringify(value)).toBe(false);
		}
		for (const tag of ["input", "form", "button", "select", "textarea", "label", "a", "div", "p", "li", "ul", "code", "pre", "td", "details", "summary", "template"]) {
			expect(replyKeepsAttribute(tag, "class", "task-box"), tag).toBe(false);
			expect(replyKeepsAttribute(tag, "class", "task-box checked"), tag).toBe(false);
		}
		// The box's span is a span like any other for the rest: no name, no id.
		for (const attr of ["id", "ID", "name", "NAME"]) expect(replyKeepsAttribute("span", attr, "task-box"), attr).toBe(false);
		// What was kept before still is.
		expect(replyKeepsAttribute("code", "class", "language-ssl")).toBe(true);
		expect(replyKeepsAttribute("code", "class", "language-ssl task-box")).toBe(false);
	});

	test("the reply goes through that renderer and that sanitiser, and the box is drawn by the stylesheet (read from the source: DOMPurify needs a DOM)", () => {
		// Not run here: bun has no DOM, and DOMPurify does nothing without one. When this was fixed the 22 probes of
		// the audit and 15 more (the spellings above among them) were put through this module's renderer, config and
		// hook with DOMPurify in a browser: no input, form, button, name, id, style or handler was left by any, the
		// only classes left were `language-…` on code and the box's two on a span, and 21 of the audit's 22 came out
		// byte for byte as before (the other is its task list, which now has its boxes).
		const src = readSrc("../src/view/agent/markdown.ts");
		expect(src).toContain("sanitizer().sanitize(replyMarkup(text), REPLY_PURIFY_CONFIG)");
		expect(src).toContain("if (!replyKeepsAttribute(node.nodeName, data.attrName, data.attrValue)) data.keepAttr = false;");
		// The other views' renderer is left as it is: a document's boxes are inputs, and can be ticked.
		expect(src).not.toContain("marked.use(");
		expect(src).not.toContain("marked.setOptions(");
		const css = readSrc("../src/view/style.css");
		expect(css).toContain(".md li > .task-box, .md li > p > .task-box {");
		expect(css).toContain(".md li > .task-box.checked::after, .md li > p > .task-box.checked::after {");
		// Drawn with the theme's own colours, so it is right in the light and the dark one.
		const box = css.slice(css.indexOf(".md li > .task-box, .md li > p > .task-box {"), css.indexOf(".md ul > li > .task-box, .md ul > li > p > .task-box {"));
		for (const colour of ["var(--input-border)", "var(--input-bg)", "var(--accent)", "var(--accent-fg)"]) expect(box).toContain(colour);
		expect(box).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
		expect(box).not.toContain("cursor: pointer");
	});
});

// =============================================================================
// B6-5. "Import Mermaid flowchart as Plan…"
// =============================================================================
describe("B6-5: a Mermaid flowchart is imported from where it is, not typed into a one-line prompt", () => {
	beforeAll(connectTestRpc);
	afterAll(() => {
		clipboardIs(undefined);
		return disconnectTestRpc();
	});
	beforeEach(() => {
		resetAll();
		clipboardIs(undefined);
		// The one-line box: it gives back the value it was handed without its line breaks, as an <input> does. The
		// name of the plan is typed.
		askHandler = (prompt, initial) => (prompt === "Name of the imported plan" ? "Sample check" : (initial ?? "").replace(/[\r\n]+/g, ""));
	});

	const FLOW = "flowchart TD\n  A([Start]) --> B[Check the sample]\n  B --> C([End])";
	const OTHER_FLOW = "graph LR\n  X[Read the order] --> Y[Set the due date]";
	const SEQUENCE = "sequenceDiagram\n  Lab->>Store: sample";
	const PLAN_FILE = "/ws/design/Sample check.plan.json";

	let clipboardReads = 0;
	/** What `navigator.clipboard.readText` does: gives a text, refuses, or is not there at all. */
	function clipboardIs(read: (() => Promise<string>) | undefined) {
		clipboardReads = 0;
		if (typeof (globalThis as any).navigator === "undefined") (globalThis as any).navigator = {};
		// Not there at all is how bun has it, and how every other test file finds it again.
		delete (globalThis as any).navigator.clipboard;
		if (read) Object.defineProperty((globalThis as any).navigator, "clipboard", { configurable: true, value: { readText: () => (clipboardReads++, read()) } });
	}
	const pickRow = (label: string | RegExp) => {
		quickPickHandler = (options) => {
			const row = options.items.find((item) => (typeof label === "string" ? item.label === label : label.test(item.label)));
			if (!row) throw new Error(`no row ${label} among ${options.items.map((item) => item.label).join(" | ")}`);
			return row.value;
		};
	};
	const rowsShown = () => picks[0]!.items.map((item) => [item.label, item.description ?? item.detail ?? ""]);
	const texts = (json: string) => (JSON.parse(json) as { nodes: { text: string }[] }).nodes.map((n) => n.text);
	/** For what comes only after the short wait the command gives a clipboard that does not answer. */
	const eventually = async (ok: () => boolean) => {
		for (let i = 0; i < 300 && !ok(); i++) await sleep(10);
		expect(ok()).toBe(true);
	};
	const settled = async () => {
		await until(() => picks.length > 0);
		await sleep(30);
		flush();
	};

	test("from the clipboard: the flowchart is taken as it is, line breaks and all, and only the plan's name is asked for", async () => {
		const ws = workspaceOf({});
		clipboardIs(async () => FLOW);
		pickRow("Clipboard");
		runCommand("import-mermaid-plan");
		await until(() => ws.writes.length > 0 || notices().length > 0);
		await sleep(20);
		flush();

		// The prompt that could not hold a flowchart is gone: a list, then the one line that is a line.
		expect(asked).toEqual(["pick: Import Mermaid flowchart as Plan", "ask: Name of the imported plan"]);
		expect(picks[0]!.placeholder).toBe("Choose where the flowchart is…");
		expect(rowsShown()).toEqual([
			["Clipboard", "flowchart TD"],
			["Choose a file…", "A .mmd or .md file of the workspace"],
		]);
		expect(ws.writes.map(([path]) => path)).toEqual([PLAN_FILE]);
		expect(texts(ws.writes[0]![1])).toEqual(["Start", "Check the sample", "End"]);
		expect(notices()).toEqual(["Imported Mermaid flowchart to design/Sample check.plan.json (3 nodes)."]);
		// The new plan is opened.
		expect(snapshot(state).groups[0]!.active).toBe(PLAN_FILE);
	});

	test("from the open Markdown document: its flowcharts are listed, the one the cursor is in first; a diagram that is not a flowchart is not", async () => {
		const md = ["# Flow", "", "```mermaid", SEQUENCE, "```", "", "```mermaid", FLOW, "```", "", "```mermaid", OTHER_FLOW, "```", ""].join("\n");
		const ws = workspaceOf({ "/ws/docs/flow.md": md });
		await openFile("/ws/docs/flow.md");
		setState((s) => {
			s.cursor = { line: 15, column: 1 };
		});
		flush();
		let nameOffered = "";
		askHandler = (_prompt, initial) => ((nameOffered = initial ?? ""), "Sample check");
		pickRow("Flowchart in flow.md, lines 14–17");
		runCommand("import-mermaid-plan");
		await until(() => ws.writes.length > 0);
		await sleep(20);
		flush();
		expect(rowsShown()).toEqual([
			["Flowchart in flow.md, lines 14–17", "graph LR"],
			["Flowchart in flow.md, lines 8–12", "flowchart TD"],
			["Clipboard", "This window was not allowed to read the clipboard"],
			["Choose a file…", "A .mmd or .md file of the workspace"],
		]);
		// The name offered is the document's.
		expect(nameOffered).toBe("flow");
		expect(texts(ws.writes[0]![1])).toEqual(["Read the order", "Set the due date"]);
	});

	test("from the selected text of the editor", async () => {
		const ws = workspaceOf({ "/ws/docs/notes.md": `Some words.\n\n${FLOW}\n\nMore words.\n` });
		await openFile("/ws/docs/notes.md");
		flush();
		registerLiveEditor(0, { path: "/ws/docs/notes.md", getPosition: () => ({ lineNumber: 3, column: 1 }), getSelectedText: () => FLOW } as any);
		clipboardIs(async () => "not a flowchart");
		pickRow("Selected text in notes.md");
		runCommand("import-mermaid-plan");
		await until(() => ws.writes.length > 0);
		await sleep(20);
		flush();
		// The document has no fenced flowchart, and says so; the selection is one, and comes first.
		expect(rowsShown()).toEqual([
			["Selected text in notes.md", "flowchart TD"],
			["notes.md", "Holds no Mermaid flowchart block"],
			["Clipboard", "The clipboard holds no flowchart"],
			["Choose a file…", "A .mmd or .md file of the workspace"],
		]);
		expect(texts(ws.writes[0]![1])).toEqual(["Start", "Check the sample", "End"]);
	});

	test("a clipboard this window may not read: the row says so, and picking it says so plainly; nothing is asked or written", async () => {
		const ws = workspaceOf({});
		clipboardIs(() => Promise.reject(new DOMException("Read permission denied.", "NotAllowedError")));
		pickRow("Clipboard");
		runCommand("import-mermaid-plan");
		await settled();
		expect(picks[0]!.placeholder).toBe("No flowchart open or copied: choose a file…");
		expect(rowsShown()[0]).toEqual(["Clipboard", "This window was not allowed to read the clipboard"]);
		// Asked again when the row was picked, which is the user's own act: refused again.
		expect(clipboardReads).toBe(2);
		expect(notices()).toEqual(["This window was not allowed to read the clipboard. Select the flowchart in an editor, or save it as a .mmd file, and import it from there."]);
		expect(asked).toEqual(["pick: Import Mermaid flowchart as Plan"]);
		expect(ws.writes).toEqual([]);
	});

	test("refused when the command starts and allowed when the row is picked: imported", async () => {
		const ws = workspaceOf({});
		let allowed = false;
		clipboardIs(() => (allowed ? Promise.resolve(FLOW) : Promise.reject(new Error("not allowed"))));
		quickPickHandler = (options) => ((allowed = true), options.items.find((item) => item.label === "Clipboard")!.value);
		runCommand("import-mermaid-plan");
		await until(() => ws.writes.length > 0);
		expect(texts(ws.writes[0]![1])).toEqual(["Start", "Check the sample", "End"]);
	});

	test("a web view with no clipboard to read at all is one that may not read it", async () => {
		const ws = workspaceOf({});
		clipboardIs(undefined);
		pickRow("Clipboard");
		runCommand("import-mermaid-plan");
		await settled();
		expect(notices()).toEqual(["This window was not allowed to read the clipboard. Select the flowchart in an editor, or save it as a .mmd file, and import it from there."]);
		expect(ws.writes).toEqual([]);
	});

	test("a web view that asks the user before it answers does not keep the list back: the row says the clipboard is not read yet", async () => {
		const ws = workspaceOf({ "/ws/design/check.mmd": `${FLOW}\n` });
		// The read stays open for as long as the web view's own question does: here, for ever.
		clipboardIs(() => new Promise<string>(() => {}));
		pickRow("Clipboard");
		const started = Date.now();
		runCommand("import-mermaid-plan");
		await eventually(() => picks.length > 0);
		expect(Date.now() - started).toBeLessThan(2500);
		expect(rowsShown()).toEqual([
			["Clipboard", "Not read yet: waiting for permission"],
			["Choose a file…", "A .mmd or .md file of the workspace"],
		]);
		// Picked while it is still unanswered: said, with what to do, and the command ends.
		await eventually(() => notices().length > 0);
		expect(notices()).toEqual(["The clipboard was not read: this window is still waiting to be allowed to read it. Allow it and run the command again, or import the flowchart from a file."]);
		expect(ws.writes).toEqual([]);

		// And the other places are there to be picked meanwhile.
		resetAll();
		const again = workspaceOf({ "/ws/design/check.mmd": `${FLOW}\n` });
		askHandler = () => "Sample check";
		clipboardIs(() => new Promise<string>(() => {}));
		browseHandler = () => ({ path: "/ws/design/check.mmd", rel: "design/check.mmd" });
		pickRow("Choose a file…");
		runCommand("import-mermaid-plan");
		await eventually(() => again.writes.length > 0);
		expect(texts(again.writes[0]![1])).toEqual(["Start", "Check the sample", "End"]);
	});

	test("a clipboard that holds something else: the row says it holds no flowchart, and so does picking it", async () => {
		const ws = workspaceOf({});
		// One line, as the old prompt made of every flowchart: the parser wants the header on a line of its own.
		clipboardIs(async () => FLOW.replace(/\n/g, ""));
		pickRow("Clipboard");
		runCommand("import-mermaid-plan");
		await settled();
		expect(rowsShown()).toEqual([
			["Clipboard", "The clipboard holds no flowchart"],
			["Choose a file…", "A .mmd or .md file of the workspace"],
		]);
		expect(picks[0]!.placeholder).toBe("No flowchart open or copied: choose a file…");
		expect(notices()).toEqual(["The clipboard holds no Mermaid flowchart."]);
		expect(asked).toEqual(["pick: Import Mermaid flowchart as Plan"]);
		expect(ws.writes).toEqual([]);
	});

	test("from a file chosen in the workspace file browser: a .mmd file whole, a Markdown file's flowchart block", async () => {
		const files = { "/ws/design/check.mmd": `${FLOW}\n`, "/ws/docs/flow.md": `# Flow\n\n\`\`\`mermaid\n${OTHER_FLOW}\n\`\`\`\n`, "/ws/docs/plain.md": "# No diagram\n", "/ws/src/Demo.ssl": ":PROCEDURE Demo;\n:ENDPROC;\n" };
		let ws = workspaceOf(files);
		let offered: { title?: string; root: string; pinned?: { path: string; rel: string }[] } | undefined;
		browseHandler = (options) => ((offered = options), { path: "/ws/design/check.mmd", rel: "design/check.mmd" });
		let nameOffered = "";
		askHandler = (_prompt, initial) => ((nameOffered = initial ?? ""), "Sample check");
		pickRow("Choose a file…");
		runCommand("import-mermaid-plan");
		await until(() => ws.writes.length > 0);
		expect(asked).toEqual(["pick: Import Mermaid flowchart as Plan", "browse: Import Mermaid flowchart from a .mmd or .md file", "ask: Name of the imported plan"]);
		// The workspace's Mermaid files are offered first in the browser.
		expect(offered!.root).toBe("/ws");
		expect(offered!.pinned).toEqual([{ path: "/ws/design/check.mmd", rel: "design/check.mmd" }]);
		expect(nameOffered).toBe("check");
		expect(texts(ws.writes[0]![1])).toEqual(["Start", "Check the sample", "End"]);

		resetAll();
		ws = workspaceOf(files);
		askHandler = () => "Sample check";
		browseHandler = () => ({ path: "/ws/docs/flow.md", rel: "docs/flow.md" });
		pickRow("Choose a file…");
		runCommand("import-mermaid-plan");
		await until(() => ws.writes.length > 0);
		expect(texts(ws.writes[0]![1])).toEqual(["Read the order", "Set the due date"]);
	});

	test("a chosen file that holds no flowchart, or cannot be read, is said plainly, and nothing is written", async () => {
		const files = { "/ws/docs/plain.md": "# No diagram\n\n```mermaid\n" + SEQUENCE + "\n```\n", "/ws/src/Demo.ssl": ":PROCEDURE Demo;\n:ENDPROC;\n" };
		for (const [path, rel, notice] of [
			["/ws/docs/plain.md", "docs/plain.md", "docs/plain.md holds no Mermaid flowchart block."],
			["/ws/src/Demo.ssl", "src/Demo.ssl", "src/Demo.ssl holds no Mermaid flowchart."],
			["/ws/gone.mmd", "gone.mmd", "gone.mmd is not there."],
		] as const) {
			resetAll();
			const ws = workspaceOf(files);
			browseHandler = () => ({ path, rel });
			pickRow("Choose a file…");
			runCommand("import-mermaid-plan");
			await until(() => notices().length > 0);
			expect(notices()).toEqual([notice]);
			expect(asked.filter((a) => a.startsWith("ask:"))).toEqual([]);
			expect(ws.writes).toEqual([]);
		}
	});

	// The plan's own file. The flowchart comes from the open Markdown document in these, which is a place the
	// command could always import from: what is tested is what it then does to a plan that is already there.
	const FLOW_DOC = "/ws/docs/flow.md";
	const OLD_PLAN = '{"title":"old"}\n';
	async function importingOver(openPlan: "closed" | "open" | "unsaved") {
		const ws = workspaceOf({ [PLAN_FILE]: OLD_PLAN, [FLOW_DOC]: `# Flow\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n` });
		if (openPlan !== "closed") {
			await openFile(PLAN_FILE);
			flush();
		}
		if (openPlan === "unsaved") {
			typeInto(PLAN_FILE, " ");
			flush();
			expect(snapshot(state).dirty[PLAN_FILE]).toBe(true);
		}
		await openFile(FLOW_DOC);
		flush();
		pickRow("Flowchart in flow.md, lines 3–7");
		return ws;
	}
	const questions = () => asked.filter((a) => a.startsWith("choose:"));

	test("a plan of that name on disk is asked about, kept in history and written over only on a yes", async () => {
		let ws = await importingOver("closed");
		runCommand("import-mermaid-plan");
		await until(() => questions().length > 0);
		await sleep(20);
		expect(questions()).toEqual(["choose: design/Sample check.plan.json already exists. Overwrite it?"]);
		expect(ws.writes).toEqual([]);
		expect(ws.kept).toEqual([]);

		resetAll();
		askHandler = () => "Sample check";
		ws = await importingOver("closed");
		chooseHandler = () => "Overwrite existing plan";
		runCommand("import-mermaid-plan");
		await until(() => ws.writes.length > 0);
		expect(ws.kept).toEqual([PLAN_FILE]);
		expect(ws.writes.map(([path]) => path)).toEqual([PLAN_FILE]);
		expect(texts(ws.writes[0]![1])).toEqual(["Start", "Check the sample", "End"]);
	});

	test("a plan that is open with unsaved changes is not written under: it is asked about as that, and a no leaves it alone", async () => {
		const ws = await importingOver("unsaved");
		const before = documents.get(PLAN_FILE)!.model.getValue();
		runCommand("import-mermaid-plan");
		await until(() => questions().length > 0);
		await sleep(20);
		flush();
		expect(questions()).toEqual(["choose: design/Sample check.plan.json is open with unsaved changes. Overwrite it with the imported plan?"]);
		// Answered no (Cancel): the file, its history and the unsaved text are as they were.
		expect(ws.writes).toEqual([]);
		expect(ws.kept).toEqual([]);
		expect(documents.get(PLAN_FILE)!.model.getValue()).toBe(before);
		expect(notices()).toEqual([]);
	});

	test("on a yes the open plan is given the import as an edit and stays unsaved: the file on disk is not touched", async () => {
		const ws = await importingOver("unsaved");
		chooseHandler = () => "Overwrite existing plan";
		runCommand("import-mermaid-plan");
		await until(() => notices().length > 0);
		flush();
		// The file was written under the tab here: the disk held the import, the tab the old plan with its unsaved
		// changes, and the next save put the one over the other.
		expect(ws.writes).toEqual([]);
		expect(ws.disk[PLAN_FILE]).toBe(OLD_PLAN);
		expect(texts(documents.get(PLAN_FILE)!.model.getValue())).toEqual(["Start", "Check the sample", "End"]);
		expect(snapshot(state).dirty[PLAN_FILE]).toBe(true);
		expect(notices()).toEqual(["Imported Mermaid flowchart to design/Sample check.plan.json (3 nodes). It is open with the plan in it, and not saved yet."]);
		expect(snapshot(state).groups[0]!.active).toBe(PLAN_FILE);
	});

	test("an open plan with unsaved changes whose file is gone from the disk is still asked about", async () => {
		const ws = await importingOver("unsaved");
		// Deleted outside the app while it was open: nothing by that name on disk, a tab with unsaved text in the app.
		delete ws.disk[PLAN_FILE];
		runCommand("import-mermaid-plan");
		await until(() => questions().length > 0 || ws.writes.length > 0);
		await sleep(20);
		expect(questions()).toEqual(["choose: design/Sample check.plan.json is open with unsaved changes. Overwrite it with the imported plan?"]);
		expect(ws.writes).toEqual([]);
	});

	test("an open plan with nothing unsaved is asked about as a file that is there, given the import and saved", async () => {
		const ws = await importingOver("open");
		chooseHandler = () => "Overwrite existing plan";
		runCommand("import-mermaid-plan");
		await until(() => notices().length > 0);
		flush();
		expect(questions()).toEqual(["choose: design/Sample check.plan.json already exists. Overwrite it?"]);
		// Saved through its document, once: what is on disk is what the tab shows.
		expect(ws.writes.map(([path]) => path)).toEqual([PLAN_FILE]);
		expect(texts(ws.writes[0]![1])).toEqual(["Start", "Check the sample", "End"]);
		expect(documents.get(PLAN_FILE)!.model.getValue()).toBe(ws.writes[0]![1]);
		expect(notices()).toEqual(["Imported Mermaid flowchart to design/Sample check.plan.json (3 nodes)."]);
	});

	test("the rows of the list: what holds a flowchart first, what holds none said as that, a file always", () => {
		const holds = (source: string) => /^\s*(flowchart|graph)\b/.test(source);
		const rows = (at: Parameters<typeof flowchartSourceRows>[0]) => flowchartSourceRows(at, holds).map((row) => [row.label, row.value.from, row.description ?? ""]);
		// Nothing open, nothing copied.
		expect(rows({ clipboard: "" })).toEqual([
			["Clipboard", "clipboard", "The clipboard holds no flowchart"],
			["Choose a file…", "file", ""],
		]);
		// A read of the clipboard that has no answer yet is neither a refusal nor an empty clipboard.
		expect(rows({ clipboard: undefined })[0]).toEqual(["Clipboard", "clipboard", "Not read yet: waiting for permission"]);
		// A Mermaid file that is open is offered whole; an empty one says it holds none.
		expect(rows({ document: { name: "check.mmd", text: FLOW, selection: "", cursorLine: 1 }, clipboard: null })).toEqual([
			["The whole of check.mmd", "text", ""],
			["Clipboard", "clipboard", "This window was not allowed to read the clipboard"],
			["Choose a file…", "file", ""],
		]);
		expect(rows({ document: { name: "check.mmd", text: "%% to do\n", selection: "", cursorLine: 1 }, clipboard: FLOW })).toEqual([
			["Clipboard", "clipboard", ""],
			["check.mmd", "nothing", "Holds no flowchart"],
			["Choose a file…", "file", ""],
		]);
		// A file of another kind is no place to look, unless what is selected in it is a flowchart.
		expect(rows({ document: { name: "Demo.ssl", text: ":PROCEDURE Demo;\n:ENDPROC;\n", selection: ":PROCEDURE Demo;", cursorLine: 1 }, clipboard: "x" }).map((r) => r[0])).toEqual(["Clipboard", "Choose a file…"]);
		expect(rows({ document: { name: "Demo.ssl", text: `/* ${FLOW} */`, selection: FLOW, cursorLine: 1 }, clipboard: "x" }).map((r) => r[0])).toEqual(["Selected text in Demo.ssl", "Clipboard", "Choose a file…"]);
		// Only the last row is set apart, and it is the last whatever else there is.
		const all = flowchartSourceRows({ document: { name: "flow.md", text: "```mermaid\n" + FLOW + "\n```\n", selection: FLOW, cursorLine: 2 }, clipboard: FLOW }, holds);
		expect(all.map((row) => Boolean(row.divide))).toEqual([false, false, false, true]);
		expect(all.at(-1)!.label).toBe("Choose a file…");
	});
});
