import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { createEffect, createRoot, createSignal, createStore, flush } from "solid-js";
import { DEFAULT_SETTINGS } from "../src/shared/protocol";
import { createAsyncQuery } from "../src/view/asyncQuery";
import { planHash } from "../src/view/plan/assist";
import type { BuildRun } from "../src/view/plan/build";
import { builtOf } from "../src/view/plan/built";
import { printPlan, type Plan } from "../src/view/plan/model";

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
const { diagnostics, publishFindings, session } = await import("../src/view/lsp/session");
const {
	closeOtherTabs,
	documents,
	fileRemoved,
	fileRenamed,
	focusRequest,
	loadSettings,
	moveTab,
	newUntitled,
	nextTab,
	openFile,
	revealSignal,
	save,
	saveSetting,
	setState,
	state,
	togglePin,
} = await import("../src/view/state");
const { resetRecentTabs, stepRecent, tabShown } = await import("../src/view/recentTabs");
const { assistOf, begin, dismissWarning, latestAssistOf, planOf, stopAssist, updateAssist, warn } = await import("../src/view/plan/run");
const { discardRun, loadRun, reviewBuild, runFile } = await import("../src/view/plan/buildRun");
const { discard, useGit } = await import("../src/view/git");
const { resetTidy, runStep, startTidy } = await import("../src/view/agent/tidy");

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

// =============================================================================
// 1. plan/run.ts — concurrent begin() guard, warn() accumulation, fine-grained draft update
// =============================================================================
describe("SolidJS 2.0.3 audit — plan/run.ts", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	test("begin() guards synchronously against concurrent double-calls before flush and releases after completion", async () => {
		const path = "/ws/design/guard.plan.json";
		let runs = 0;
		let finishFirst!: () => void;

		const p1 = begin(path, "refine", async () => {
			runs++;
			await new Promise<void>((r) => (finishFirst = r));
		});
		// Second call in the same synchronous tick (before Solid flushes `running`) must be ignored!
		const p2 = begin(path, "refine", async () => {
			runs++;
		});
		expect(latestAssistOf(path).running).toBe("refine");
		expect(runs).toBe(1);
		await p2;
		expect(runs).toBe(1);

		// stopAssist sees latestAssistOf(path).running immediately before flush
		stopAssist(path);
		expect(latestAssistOf(path).progress).toBe("Stopping…");

		finishFirst();
		await p1;
		flush();
		expect(latestAssistOf(path).running).toBe("");

		// After completion, a new begin() runs normally
		await begin(path, "spec", async () => {
			runs++;
		});
		expect(runs).toBe(2);
	});

	test("warn() back-to-back calls before flush keep all unique warnings and dismissWarning() removes cleanly", () => {
		const path = "/ws/design/warn.plan.json";
		updateAssist(path, { warnings: [] });
		flush();

		warn(path, "First warning");
		warn(path, "Second warning");
		warn(path, "First warning"); // duplicate ignored

		expect(latestAssistOf(path).warnings).toEqual(["First warning", "Second warning"]);
		flush();
		expect(assistOf(path).warnings).toEqual(["First warning", "Second warning"]);

		dismissWarning(path, "First warning");
		expect(latestAssistOf(path).warnings).toEqual(["Second warning"]);
		flush();
		expect(assistOf(path).warnings).toEqual(["Second warning"]);
	});

	test("updateAssist() mutates draft in place: updating progress does not notify effect tracking suggestions", () => {
		const path = "/ws/design/fine.plan.json";
		updateAssist(path, { progress: "init", suggestions: [], warnings: [] });
		flush();

		let suggestionsRuns = 0;
		let progressRuns = 0;
		const dispose = createRoot((d) => {
			createEffect(
				() => assistOf(path).suggestions.length,
				() => {
					suggestionsRuns++;
				},
			);
			createEffect(
				() => assistOf(path).progress,
				() => {
					progressRuns++;
				},
			);
			return d;
		});
		try {
			flush();
			expect(suggestionsRuns).toBe(1);
			expect(progressRuns).toBe(1);

			updateAssist(path, { progress: "step 1" });
			flush();
			updateAssist(path, { progress: "step 2" });
			flush();
			expect(progressRuns).toBe(3);
			expect(suggestionsRuns).toBe(1);

			updateAssist(path, {
				suggestions: [{ key: "k1", type: "node", temp: "t1", node: { kind: "step", text: "Check" }, why: "test" }],
			});
			flush();
			expect(suggestionsRuns).toBe(2);
		} finally {
			dispose();
		}
	});
});

// =============================================================================
// 2. plan/buildRun.ts — acceptance settlement, non-looping reviewBuild, & loadRun recovery
// =============================================================================
describe("SolidJS 2.0.3 audit — plan/buildRun.ts", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	function makeTwoScriptPlan(): Plan {
		return {
			version: 1,
			title: "DueDates",
			groups: [],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "step", text: "Compute A" },
				{ id: "n3", kind: "step", text: "Compute B" },
				{ id: "n4", kind: "end", text: "Done" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
				{ from: "n3", to: "n4" },
			],
			targets: ["src/A.ssl", "src/B.ssl"],
		};
	}

	function makeBuildRun(plan: Plan, accepted: string[] = []): BuildRun {
		return {
			version: 1,
			planHash: planHash(plan),
			model: "local/qwen",
			status: "built",
			tokens: 100,
			cost: 0,
			budget: { tokens: 400_000 },
			units: [
				{ name: "ComputeA", script: "src/A.ssl", nodes: ["n2"], status: "passed", attempts: 1, code: ":PROCEDURE ComputeA;\n:ENDPROC;\n" },
				{ name: "ComputeB", script: "src/B.ssl", nodes: ["n3"], status: "passed", attempts: 1, code: ":PROCEDURE ComputeB;\n:ENDPROC;\n" },
			],
			map: [
				{ node: "n1", becomes: "entry" },
				{ node: "n2", becomes: "ComputeA" },
				{ node: "n3", becomes: "ComputeB" },
				{ node: "n4", becomes: "exit" },
			],
			accepted,
		};
	}

	test("reviewBuild() advances across scripts without looping and settles plan.built on final accept", async () => {
		const planPath = "/ws/design/DueDates.plan.json";
		const plan = makeTwoScriptPlan();
		const disk = new Map<string, string>([[planPath, printPlan(plan)]]);

		rpcHandler = (method, args) => {
			if (method === "read") {
				const p = String(args[0]);
				if (!disk.has(p)) throw new Error("ENOENT");
				return { text: disk.get(p)!, mtime: 1, encoding: "utf-8" };
			}
			if (method === "write") {
				disk.set(String(args[0]), String(args[1]));
				return { mtime: 2 };
			}
			return null;
		};

		const origAnalyze = session.analyze.bind(session);
		const origTree = session.scratchTree.bind(session);
		const origCalls = session.scratchCalls.bind(session);
		(session as any).analyze = async () => ({ diagnostics: [], symbols: [], timedOut: false });
		(session as any).scratchTree = async () => [];
		(session as any).scratchCalls = async () => [];

		try {
			await openFile(planPath);
			flush();
			updateAssist(planPath, { run: makeBuildRun(plan) });
			// Do NOT flush here: reviewBuild must still read latestAssistOf(planPath).run!

			await reviewBuild(planPath);
			flush();
			const r1 = review();
			expect(r1).not.toBeNull();
			expect(r1!.title).toContain("src/A.ssl");

			// Accept script 1 without rejecting
			r1!.onReject = undefined;
			closeReview();
			flush();
			await r1!.onAccept(r1!.proposed);

			// Immediately after accept 1: accepted contains src/A.ssl, unit A is recorded, NOT settled yet (n1/n4 absent)
			expect(latestAssistOf(planPath).run?.accepted).toEqual(["src/A.ssl"]);
			const midBuilt = builtOf(planOf(planPath)!);
			expect(midBuilt?.units.map((u) => u.name)).toEqual(["ComputeA"]);
			expect(midBuilt?.nodes.n2).toBeDefined();
			expect(midBuilt?.nodes.n1).toBeUndefined();
			expect(midBuilt?.nodes.n4).toBeUndefined();

			// Wait for recursive reviewBuild to open script 2 (and NOT loop back onto src/A.ssl!)
			await new Promise((r) => setTimeout(r, 25));
			flush();
			const r2 = review();
			expect(r2).not.toBeNull();
			expect(r2!.title).toContain("src/B.ssl");

			// Accept script 2
			r2!.onReject = undefined;
			closeReview();
			flush();
			await r2!.onAccept(r2!.proposed);

			await new Promise((r) => setTimeout(r, 25));
			flush();

			// No 3rd review opened (non-looping!)
			expect(review()).toBeNull();
			expect(latestAssistOf(planPath).run?.accepted).toEqual(["src/A.ssl", "src/B.ssl"]);

			// settleBuilt ran: non-unit start/end nodes from run.map (n1, n4) are now settled in plan.built.nodes!
			const finalBuilt = builtOf(planOf(planPath)!);
			expect(finalBuilt?.units.map((u) => u.name)).toEqual(["ComputeA", "ComputeB"]);
			expect(finalBuilt?.nodes.n1).toBeDefined();
			expect(finalBuilt?.nodes.n2).toBeDefined();
			expect(finalBuilt?.nodes.n3).toBeDefined();
			expect(finalBuilt?.nodes.n4).toBeDefined();
		} finally {
			(session as any).analyze = origAnalyze;
			(session as any).scratchTree = origTree;
			(session as any).scratchCalls = origCalls;
			discardRun(planPath);
			flush();
		}
	});

	test("loadRun() recovers and settles previously accepted scripts even before Solid flushes updateAssist", async () => {
		const planPath = "/ws/design/Recover.plan.json";
		const plan: Plan = {
			version: 1,
			title: "Recover",
			groups: [],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "step", text: "Run" },
				{ id: "n3", kind: "end", text: "End" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
			],
			targets: ["src/Run.ssl"],
		};
		const savedRun: BuildRun = {
			version: 1,
			planHash: planHash(plan),
			model: "local/qwen",
			status: "built",
			tokens: 50,
			cost: 0,
			budget: { tokens: 400_000 },
			units: [{ name: "DoRun", script: "src/Run.ssl", nodes: ["n2"], status: "passed", attempts: 1, code: ":PROCEDURE DoRun;\n:ENDPROC;\n" }],
			map: [
				{ node: "n1", becomes: "entry" },
				{ node: "n2", becomes: "DoRun" },
				{ node: "n3", becomes: "exit" },
			],
			accepted: ["src/Run.ssl"],
		};
		const rFile = runFile(planPath, "/ws");
		rpcHandler = (method, args) => {
			if (method === "read" && String(args[0]) === planPath) return { text: printPlan(plan), mtime: 1, encoding: "utf-8" };
			if (method === "read" && String(args[0]) === rFile) return { text: JSON.stringify(savedRun), mtime: 2, encoding: "utf-8" };
			if (method === "read") throw new Error("ENOENT");
			return null;
		};

		try {
			await openFile(planPath);
			flush();
			updateAssist(planPath, { run: null });
			flush();
			expect(builtOf(planOf(planPath)!)).toBeNull();

			await loadRun(planPath);

			// recordAccepted received `run` explicitly and settled the plan right away!
			const recovered = builtOf(planOf(planPath)!);
			expect(recovered?.units.map((u) => u.name)).toEqual(["DoRun"]);
			expect(recovered?.nodes.n1).toBeDefined();
			expect(recovered?.nodes.n2).toBeDefined();
			expect(recovered?.nodes.n3).toBeDefined();
		} finally {
			updateAssist(planPath, { run: null });
			flush();
		}
	});
});

// =============================================================================
// 3. state.ts & recentTabs.ts — reconcile, proxy-safe saveSetting, WORKED_OUT_HERE, flush before disposeDoc, onFlush
// =============================================================================
describe("SolidJS 2.0.3 audit — state.ts & recentTabs.ts", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	test("reconcile on state.settings avoids notifying unrelated theme subscriber when wordWrap changes and allows regionColors.id", async () => {
		let themeRuns = 0;
		let wrapRuns = 0;
		const dispose = createRoot((d) => {
			createEffect(
				() => state.settings.theme,
				() => {
					themeRuns++;
				},
			);
			createEffect(
				() => state.settings.wordWrap,
				() => {
					wrapRuns++;
				},
			);
			return d;
		});
		try {
			flush();
			expect(themeRuns).toBe(1);
			expect(wrapRuns).toBe(1);

			rpcHandler = (method) => {
				if (method === "saveSettings") return { ...DEFAULT_SETTINGS, wordWrap: true, regionColors: { id: "blue" } };
				if (method === "settings") return { effective: { ...DEFAULT_SETTINGS, wordWrap: true, regionColors: { id: "green" } } };
				if (method === "themes") return [];
				return null;
			};

			await saveSetting({ wordWrap: true, regionColors: { id: "blue" } });
			flush();
			expect(state.settings.wordWrap).toBe(true);
			expect(state.settings.regionColors.id).toBe("blue");
			expect(wrapRuns).toBe(2);
			expect(themeRuns).toBe(1);

			// loadSettings with a changed `regionColors.id` also reconciles cleanly (key=null, no identity error) without churning theme!
			await loadSettings(false);
			flush();
			expect(state.settings.regionColors.id).toBe("green");
			expect(themeRuns).toBe(1);
		} finally {
			dispose();
		}
	});

	test("saveSetting accepts store proxies in patch without DataCloneError and never leaks settingsOut on throw", async () => {
		const [external] = createStore({ models: ["remote/model-a"], keys: { "ctrl+k": "save" } });
		let savedPatches: unknown[] = [];
		let failNextSave = false;
		let diskReads = 0;

		rpcHandler = (method, args) => {
			if (method === "saveSettings") {
				if (failNextSave) throw new Error("disk write failed");
				savedPatches.push(args[1]);
				return { ...DEFAULT_SETTINGS, keys: (args[1] as any).keys ?? {}, agentOwnModels: (args[1] as any).agentOwnModels };
			}
			if (method === "settings") {
				diskReads++;
				return { effective: { ...DEFAULT_SETTINGS, keys: { recovered: "yes" } } };
			}
			return null;
		};

		// Passing live Solid store proxies directly inside patch must NOT throw DataCloneError!
		const res = await saveSetting({ keys: external.keys, agentOwnModels: external.models });
		flush();
		expect(res).toBeDefined();
		expect(state.settings.keys).toEqual({ "ctrl+k": "save" });
		expect(state.settings.agentOwnModels).toEqual(["remote/model-a"]);

		// Passing an uncloneable value throws BEFORE settingsOut++, so settingsOut stays 0!
		await expect(saveSetting({ keys: { bad: (() => {}) as any } })).rejects.toThrow();

		// Prove settingsOut did NOT leak > 0: a subsequent failed save triggers disk recovery (`!settingsOut && settingFailed`).
		failNextSave = true;
		const failed = await saveSetting({ keys: { temp: "unpersisted" } });
		flush();
		expect(failed).toBeUndefined();
		expect(diskReads).toBe(1);
		expect(state.settings.keys).toEqual({ recovered: "yes" });
	});

	test("WORKED_OUT_HERE keys commit synchronously via flush() so back-to-back calls in one tick compose cleanly", async () => {
		const sent: any[] = [];
		rpcHandler = (method, args) => {
			if (method === "saveSettings") {
				sent.push(args[1]);
				return { ...DEFAULT_SETTINGS, ...(args[1] as any) };
			}
			return null;
		};

		// Two back-to-back calls in the same synchronous tick reading state.settings.keys:
		const p1 = saveSetting({ keys: { ...state.settings.keys, "ctrl+1": "cmd-a" } });
		// Synchronous visibility contract: state.settings.keys already contains "ctrl+1" before awaiting p1!
		expect(state.settings.keys["ctrl+1"]).toBe("cmd-a");
		const p2 = saveSetting({ keys: { ...state.settings.keys, "ctrl+2": "cmd-b" } });
		expect(state.settings.keys).toEqual({ "ctrl+1": "cmd-a", "ctrl+2": "cmd-b" });

		await Promise.all([p1, p2]);
		flush();
		expect(sent[1]?.keys).toEqual({ "ctrl+1": "cmd-a", "ctrl+2": "cmd-b" });
		expect(state.settings.keys).toEqual({ "ctrl+1": "cmd-a", "ctrl+2": "cmd-b" });
	});

	test("fileRenamed and untitled save commit updated tabs via flush() BEFORE disposing the old Monaco model", async () => {
		rpcHandler = (method, args) => {
			if (method === "read") return { text: `text:${String(args[0])}`, mtime: 1, encoding: "utf-8" };
			if (method === "sizes") return {};
			if (method === "create") return null;
			if (method === "write") return { mtime: 5 };
			return null;
		};

		// 1. fileRenamed: old model dispose sees committed target path in state.groups
		await openFile("/ws/old.ssl");
		flush();
		const oldDoc = documents.get("/ws/old.ssl")!;
		let tabsAtRenameDispose: string[] = [];
		let activeAtRenameDispose: string | null = null;
		oldDoc.model.onWillDispose(() => {
			tabsAtRenameDispose = [...state.groups[0]!.tabs];
			activeAtRenameDispose = state.groups[0]!.active;
		});
		fileRenamed("/ws/old.ssl", "/ws/new.ssl");
		expect(tabsAtRenameDispose).toEqual(["/ws/new.ssl"]);
		expect(activeAtRenameDispose as string | null).toBe("/ws/new.ssl");
		expect(documents.get("/ws/new.ssl")!.model.isDisposed()).toBe(false);

		// 2. untitled save promotion: untitled model dispose sees committed promoted path in state.groups
		const u = newUntitled(0, "ssl");
		flush();
		const uDoc = documents.get(u)!;
		uDoc.model.setValue(":RETURN 1;");
		let tabsAtPromoteDispose: string[] = [];
		let activeAtPromoteDispose: string | null = null;
		uDoc.model.onWillDispose(() => {
			tabsAtPromoteDispose = [...state.groups[0]!.tabs];
			activeAtPromoteDispose = state.groups[0]!.active;
		});
		askHandler = () => "promoted.ssl";
		expect(await save(u)).toBe(true);
		expect(tabsAtPromoteDispose).toContain("/ws/promoted.ssl");
		expect(tabsAtPromoteDispose).not.toContain(u);
		expect(activeAtPromoteDispose as string | null).toBe("/ws/promoted.ssl");
	});

	test("openFile, nextTab, moveTab, and stepRecent defer revealSignal/focusEditor until after flush", async () => {
		rpcHandler = (method, args) => {
			if (method === "read") return { text: `body:${String(args[0])}`, mtime: 1, encoding: "utf-8" };
			return null;
		};

		const events: { kind: string; path?: string; committedActive: string | null }[] = [];
		const dispose = createRoot((d) => {
			createEffect(
				() => state.groups[state.activeGroup]?.active ?? null,
				(active) => {
					if (active) events.push({ kind: "effect", path: active, committedActive: active });
				},
			);
			return d;
		});
		flush();
		events.length = 0;

		const unsubReveal = revealSignal.listen((p) => {
			events.push({ kind: "reveal", path: p, committedActive: state.groups[state.activeGroup]?.active ?? null });
		});
		const unsubFocus = focusRequest.listen((target) => {
			events.push({ kind: `focus:${target}`, committedActive: state.groups[state.activeGroup]?.active ?? null });
		});

		try {
			await openFile("/ws/a.ssl", { keep: true });
			await Promise.resolve();
			await Promise.resolve();
			// Reactive effect commits `/ws/a.ssl` BEFORE onFlush fires reveal and focus!
			expect(events).toEqual([
				{ kind: "effect", path: "/ws/a.ssl", committedActive: "/ws/a.ssl" },
				{ kind: "reveal", path: "/ws/a.ssl", committedActive: "/ws/a.ssl" },
				{ kind: "focus:editor", committedActive: "/ws/a.ssl" },
			]);

			await openFile("/ws/b.ssl", { keep: true });
			await Promise.resolve();
			await Promise.resolve();
			tabShown(0, "/ws/a.ssl");
			tabShown(0, "/ws/b.ssl");

			// stepTab (nextTab) — synchronous call must NOT fire reveal/focus before flush!
			events.length = 0;
			nextTab();
			expect(events).toEqual([]);
			await Promise.resolve();
			await Promise.resolve();
			expect(events).toEqual([
				{ kind: "effect", path: "/ws/a.ssl", committedActive: "/ws/a.ssl" },
				{ kind: "reveal", path: "/ws/a.ssl", committedActive: "/ws/a.ssl" },
				{ kind: "focus:editor", committedActive: "/ws/a.ssl" },
			]);

			// stepRecent
			events.length = 0;
			stepRecent(1, false);
			expect(events).toEqual([]);
			await Promise.resolve();
			await Promise.resolve();
			expect(events).toEqual([
				{ kind: "effect", path: "/ws/b.ssl", committedActive: "/ws/b.ssl" },
				{ kind: "reveal", path: "/ws/b.ssl", committedActive: "/ws/b.ssl" },
				{ kind: "focus:editor", committedActive: "/ws/b.ssl" },
			]);

			// moveTab across groups
			setState((s) => {
				s.groups.push({ tabs: [], active: null });
			});
			flush();
			events.length = 0;
			moveTab("/ws/b.ssl", 0, 1, null);
			expect(events).toEqual([]);
			await Promise.resolve();
			await Promise.resolve();
			expect(events.map((e) => e.kind)).toEqual(["effect", "reveal", "focus:editor"]);
			expect(events.every((e) => e.committedActive === "/ws/b.ssl")).toBe(true);
		} finally {
			unsubReveal();
			unsubFocus();
			dispose();
		}
	});

	test("togglePin, closeOtherTabs, fileRemoved, and session.sslSettings read unflushed snapshot(state)", async () => {
		rpcHandler = (method, args) => {
			if (method === "read") return { text: `body:${String(args[0])}`, mtime: 1, encoding: "utf-8" };
			return null;
		};
		await openFile("/ws/p1.ssl");
		await openFile("/ws/p2.ssl");
		flush();

		// Switch active tab WITHOUT flushing, then call togglePin() with defaults -> pins /ws/p1.ssl!
		setState((s) => {
			s.groups[0]!.active = "/ws/p1.ssl";
			s.settings.ssl = { format: { indentSize: 2 } };
		});
		expect(session.sslSettings()).toEqual({ format: { indentSize: 2 } });
		togglePin();
		flush();
		expect(state.groups[0]!.pinned).toEqual(["/ws/p1.ssl"]);

		// closeOtherTabs with default args on unflushed active change
		setState((s) => {
			s.groups[0]!.active = "/ws/p2.ssl";
		});
		await closeOtherTabs();
		flush();
		// p1 is pinned so stays; p2 is keep so stays
		expect(state.groups[0]!.tabs).toEqual(["/ws/p1.ssl", "/ws/p2.ssl"]);

		// fileRemoved respects unflushed dirty flag
		setState((s) => {
			s.dirty["/ws/p2.ssl"] = true;
		});
		fileRemoved("/ws/p2.ssl");
		flush();
		expect(state.groups[0]!.tabs).toContain("/ws/p2.ssl");
	});
});

// =============================================================================
// 4. asyncQuery.ts — falsy .latest clear, mutate() cancellation, error clearing
// =============================================================================
describe("SolidJS 2.0.3 audit — asyncQuery.ts", () => {
	test("falsy key clears .latest, mutate() cancels stale in-flight fetches, and errors clear stale value()", async () => {
		const resolvers = new Map<string, { resolve: (v: string) => void; reject: (e: unknown) => void }>();
		const ctx = createRoot((dispose) => {
			const [key, setKey] = createSignal<string | false | null | undefined>("a");
			const [data, { mutate }] = createAsyncQuery(key, (k) => {
				if (k === "sync-throw") throw new Error("sync boom");
				return new Promise<string>((resolve, reject) => {
					resolvers.set(k, { resolve, reject });
				});
			});
			return { setKey, data, mutate, dispose };
		});
		try {
			flush();

			// 1. Resolve key "a"
			resolvers.get("a")!.resolve("val-a");
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(ctx.data()).toBe("val-a");
			expect(ctx.data.latest).toBe("val-a");
			expect(ctx.data.loading).toBe(false);

			// 2. Start key "b", then call mutate("local") before "b" resolves -> "b" must NOT overwrite "local"
			ctx.setKey("b");
			flush();
			expect(ctx.data.loading).toBe(true);
			ctx.mutate("local");
			flush();
			expect(ctx.data()).toBe("local");
			expect(ctx.data.latest).toBe("local");
			expect(ctx.data.loading).toBe(false);
			expect(ctx.data.error).toBeUndefined();

			resolvers.get("b")!.resolve("stale-b");
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(ctx.data()).toBe("local");
			expect(ctx.data.latest).toBe("local");
			expect(ctx.data.loading).toBe(false);

			// 3. Async rejection clears stale value() so value() isn't returned alongside error
			ctx.setKey("fail-async");
			flush();
			expect(ctx.data.loading).toBe(true);
			resolvers.get("fail-async")!.reject(new Error("async boom"));
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(ctx.data()).toBeUndefined();
			expect((ctx.data.error as Error)?.message).toBe("async boom");
			expect(ctx.data.loading).toBe(false);

			// 4. Populate value again, then synchronous throw clears stale value() too
			ctx.mutate("before-sync-throw");
			flush();
			expect(ctx.data()).toBe("before-sync-throw");
			ctx.setKey("sync-throw");
			flush();
			expect(ctx.data()).toBeUndefined();
			expect((ctx.data.error as Error)?.message).toBe("sync boom");
			expect(ctx.data.loading).toBe(false);

			// 5. Falsy key clears BOTH value() AND latest!
			ctx.mutate("cached");
			flush();
			expect(ctx.data.latest).toBe("cached");
			ctx.setKey(false);
			flush();
			expect(ctx.data()).toBeUndefined();
			expect(ctx.data.latest).toBeUndefined();
			expect(ctx.data.loading).toBe(false);
			expect(ctx.data.error).toBeUndefined();
		} finally {
			ctx.dispose();
		}
	});

	test("fetcher-only createAsyncQuery initializes loading to true without untracked source reads", async () => {
		let resolveFetch!: (v: number) => void;
		const ctx = createRoot((dispose) => {
			const [data] = createAsyncQuery(() => new Promise<number>((r) => (resolveFetch = r)));
			return { data, dispose };
		});
		try {
			// Immediately true before first flush
			expect(ctx.data.loading).toBe(true);
			flush();
			expect(ctx.data.loading).toBe(true);
			resolveFetch(42);
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(ctx.data()).toBe(42);
			expect(ctx.data.loading).toBe(false);
		} finally {
			ctx.dispose();
		}
	});
});

// =============================================================================
// 5. lsp/session.ts — reconcile stability on identical diagnostics
// =============================================================================
describe("SolidJS 2.0.3 audit — lsp/session.ts", () => {
	test("publishFindings with identical diagnostics does not churn subscribers via reconcile", () => {
		const model = createFakeModel("x := 1;\n", "ssl", makeUri("file", "/ws/reconcile-diag.ssl"));
		const uri = model.uri.toString();
		try {
			publishFindings(model as any, "lint", [
				{ line: 1, column: 1, endLine: 1, endColumn: 2, severity: 2, message: "Unused x", code: "SSL001" },
			]);
			flush();

			let lenRuns = 0;
			let rowRuns = 0;
			let msgRuns = 0;
			const dispose = createRoot((d) => {
				createEffect(
					() => diagnostics[uri]?.length,
					() => {
						lenRuns++;
					},
				);
				createEffect(
					() => diagnostics[uri]?.[0],
					() => {
						rowRuns++;
					},
				);
				createEffect(
					() => diagnostics[uri]?.[0]?.message,
					() => {
						msgRuns++;
					},
				);
				return d;
			});

			try {
				flush();
				expect([lenRuns, rowRuns, msgRuns]).toEqual([1, 1, 1]);

				// Re-publish identical diagnostics: ZERO re-runs!
				publishFindings(model as any, "lint", [
					{ line: 1, column: 1, endLine: 1, endColumn: 2, severity: 2, message: "Unused x", code: "SSL001" },
				]);
				flush();
				expect([lenRuns, rowRuns, msgRuns]).toEqual([1, 1, 1]);

				// Change only message: only message observer re-runs, length & row proxy stay stable!
				publishFindings(model as any, "lint", [
					{ line: 1, column: 1, endLine: 1, endColumn: 2, severity: 2, message: "Unused x (updated)", code: "SSL001" },
				]);
				flush();
				expect(lenRuns).toBe(1);
				expect(rowRuns).toBe(1);
				expect(msgRuns).toBe(2);
				expect(diagnostics[uri]?.[0]?.message).toBe("Unused x (updated)");
			} finally {
				dispose();
			}
		} finally {
			publishFindings(model as any, "lint", null);
			flush();
			model.dispose();
		}
	});
});

// =============================================================================
// 6. git.ts & agent/tidy.ts — discard() single gitStatus poll & tidy runStep() snapshot reads
// =============================================================================
describe("SolidJS 2.0.3 audit — git.ts & agent/tidy.ts", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	test("git.ts discard() does not trigger a duplicate backend.gitStatus() via the deferred treeVersion effect", async () => {
		let statusCalls = 0;
		rpcHandler = (method, args) => {
			if (method === "gitStatus") {
				statusCalls++;
				return { branch: "main", files: [] };
			}
			if (method === "gitDiscard") return null;
			if (method === "sizes") return { [String((args[0] as string[])[0])]: 10 };
			if (method === "read") return { text: "clean", mtime: 2, encoding: "utf-8" };
			return null;
		};
		chooseHandler = () => "Discard changes";

		const dispose = createRoot((d) => {
			useGit();
			return d;
		});
		try {
			flush();
			await new Promise((r) => setTimeout(r, 20));
			const before = statusCalls;

			await openFile("/ws/clean.ssl");
			flush();
			await discard({ path: "/ws/clean.ssl", unstaged: "modified", staged: "" } as any);
			expect(statusCalls).toBe(before + 1);

			// Wait past the 400ms refreshGitSoon debounce window: must NOT fire a duplicate gitStatus()!
			await new Promise((r) => setTimeout(r, 460));
			expect(statusCalls).toBe(before + 1);
		} finally {
			dispose();
		}
	});

	test("agent/tidy.ts runStep() reads unflushed snapshot(tidy).path and snapshot(state).workspace", async () => {
		rpcHandler = (method, args) => {
			if (method === "read" && String(args[0]) === "/ws/Demo.ssl") return { text: ":PROCEDURE Demo;\n:ENDPROC;\n", mtime: 1, encoding: "utf-8" };
			if (method === "read") throw new Error("ENOENT");
			return null;
		};
		await openFile("/ws/Demo.ssl");
		flush();

		// startTidy() sets tidy.path; calling runStep(1) immediately before flush must see snapshot(tidy).path
		// and reach the "Run the context step first" guard rather than failing with "The file being tidied is not open."
		startTidy();
		await runStep(1);
		flush();
		const texts = state.messages.map((m) => m.text);
		expect(texts.some((t) => t.includes("Run the context step first"))).toBe(true);
		expect(texts.some((t) => t.includes("is not open"))).toBe(false);
	});
});
