import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { createEffect, createRoot, createSignal, createStore, flush, snapshot } from "solid-js";
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
	closeTab,
	commitPendingEdits,
	documents,
	fileRemoved,
	fileRenamed,
	focusRequest,
	holdsPendingEdit,
	loadSettings,
	moveTab,
	newUntitled,
	nextTab,
	openFile,
	openFolder,
	openedForALook,
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
const { askAbout, attachFileToAgent, currentAgentContext } = await import("../src/view/agent/Agent");
const { agent, chatSessionEpoch, setAgent, stop: stopAgent } = await import("../src/view/agent/store");

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

	// Pass 3: a run saved before layout was left out of the plan's hash holds the older kind of hash.
	test("loadRun() takes up a run saved with the older kind of hash, and a node dragged afterwards does not put it out of reach", async () => {
		const { legacyPlanHash, planHashMatches } = await import("../src/view/plan/assist");
		const { setNodeOffset } = await import("../src/view/plan/model");
		const planPath = "/ws/design/Older.plan.json";
		// A node had already been dragged when the run was saved: its place is part of the older hash.
		const plan: Plan = setNodeOffset(
			{
				version: 1,
				title: "Older",
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
			},
			"n2",
			{ x: 24, y: 12 },
		);
		const saved: BuildRun = {
			version: 1,
			planHash: legacyPlanHash(plan),
			model: "local/qwen",
			status: "stopped",
			tokens: 50,
			cost: 0,
			budget: { tokens: 400_000 },
			units: [{ name: "DoRun", script: "src/Run.ssl", nodes: ["n2"], status: "passed", attempts: 1, code: ":PROCEDURE DoRun;\n:ENDPROC;\n" }],
			map: [],
			accepted: [],
		};
		const rFile = runFile(planPath, "/ws");
		rpcHandler = (method, args) => {
			if (method === "read" && String(args[0]) === planPath) return { text: printPlan(plan), mtime: 1, encoding: "utf-8" };
			if (method === "read" && String(args[0]) === rFile) return { text: JSON.stringify(saved), mtime: 2, encoding: "utf-8" };
			if (method === "read") throw new Error("ENOENT");
			return null;
		};
		try {
			await openFile(planPath);
			flush();
			await loadRun(planPath);
			const loaded = latestAssistOf(planPath).run;
			expect(loaded?.units.map((u) => u.name)).toEqual(["DoRun"]);
			// It is of this plan, and from here on holds the kind of hash that moving a node does not change.
			expect(loaded?.planHash).toBe(planHash(planOf(planPath)!));
			const draggedAgain = setNodeOffset(plan, "n2", { x: 96, y: 48 });
			expect(planHashMatches(loaded?.planHash, draggedAgain)).toBe(true);
			expect(planHashMatches(saved.planHash, draggedAgain)).toBe(false);
		} finally {
			updateAssist(planPath, { run: null });
			flush();
		}
	});

	// Pass 3: the build's own loop, from "New build" to its end, with opencode and the language server faked.
	// No model is asked anything: every reply is written here.
	describe("a build, with opencode faked", () => {
		const planPath = "/ws/design/Release.plan.json";
		const paid = { providerID: "openrouter", id: "paid-model", name: "Paid", local: false, tools: true, variants: [] };
		const local = { providerID: "ollama", id: "qwen3", name: "qwen3", local: true, tools: true, variants: [] };
		const releasePlan = (): Plan => ({
			version: 1,
			title: "Release",
			groups: [],
			targets: ["src/Release.ssl"],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "step", text: "Mark the sample" },
				{ id: "n3", kind: "step", text: "Tell the lab" },
				{ id: "n4", kind: "end", text: "Done" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
				{ from: "n3", to: "n4" },
			],
		});
		const waitingRun = (plan: Plan): BuildRun => ({
			version: 1,
			planHash: planHash(plan),
			model: "ollama/qwen3",
			status: "stopped",
			tokens: 0,
			cost: 0,
			budget: { tokens: 400_000 },
			units: [
				{ name: "Mark", script: "src/Release.ssl", nodes: ["n2"], calls: [], status: "pending", attempts: 0 },
				{ name: "Notify", script: "src/Release.ssl", nodes: ["n3"], calls: [], status: "pending", attempts: 0 },
			],
			map: [
				{ node: "n1", becomes: "entry" },
				{ node: "n4", becomes: "exit" },
			],
			accepted: [],
		});
		const said = (text: string) => ({ sessionID: "s", text, outcome: "succeeded", tokens: { input: 5000, output: 10 }, cost: 0 });
		const codeFor = (name: string) => said("```ssl\n:PROCEDURE " + name + ";\n:ENDPROC;\n```");
		/** What a turn is asked to build, from its prompt; null for the second opinion. */
		const unitAsked = (prompt: string) => /^PLAN STAGE: build (\w+)/.exec(prompt)?.[1] ?? null;
		const proceduresIn = (text: string) => [...text.matchAll(/:PROCEDURE (\w+)/g)].map((m) => ({ name: m[1], kind: 11, children: [] }));

		const realSession = { analyze: session.analyze, scratchTree: session.scratchTree, scratchCalls: session.scratchCalls, formatText: session.formatText, workspaceSymbols: session.workspaceSymbols };
		let agentCalls: string[] = [];
		let prompts: string[] = [];
		let questions: string[] = [];

		/** The plan with its approved doc on disk, a language server that answers, and an opencode that says what `reply` says. */
		async function setUp(opts: { models: unknown[]; model?: string; reply?: (prompt: string) => unknown; analyze?: (text: string) => unknown; budget?: string | null }) {
			tidyUp();
			const { printSpec } = await import("../src/view/plan/assist");
			const plan = releasePlan();
			const run = waitingRun(plan);
			const disk = new Map<string, string>([
				[planPath, printPlan(plan)],
				["/ws/design/Release.plan.md", printSpec("The spec.", run.units.map(({ name, script, nodes, calls }) => ({ name, script, nodes, calls })), run.map, planHash(plan))],
			]);
			agentCalls = [];
			prompts = [];
			questions = [];
			rpcHandler = async (method, args) => {
				if (method === "read") {
					const p = String(args[0]);
					if (!disk.has(p)) throw new Error("ENOENT");
					return { text: disk.get(p)!, mtime: 1, encoding: "utf-8" };
				}
				if (method === "write") {
					disk.set(String(args[0]), String(args[1]));
					return { mtime: 2 };
				}
				if (method === "search") return [];
				if (method !== "agent") return null;
				agentCalls.push(String(args[0]));
				if (args[0] === "start") return { state: "ready" };
				if (args[0] === "models") return opts.models;
				if (args[0] === "skills") return [{ id: "ssl-new-procedure" }];
				if (args[0] === "ask") {
					const prompt = String((args[1] as { text: string }[])[0]!.text);
					prompts.push(prompt);
					return opts.reply ? opts.reply(prompt) : unitAsked(prompt) ? codeFor(unitAsked(prompt)!) : said("It does what the chart says.");
				}
				return null;
			};
			askHandler = (prompt) => {
				questions.push(prompt);
				return opts.budget ?? null;
			};
			(session as any).analyze = async (text: string) => (opts.analyze ? opts.analyze(text) : { diagnostics: [], symbols: proceduresIn(text), timedOut: false });
			(session as any).scratchTree = async () => [];
			(session as any).scratchCalls = async () => [];
			(session as any).formatText = async (text: string) => text;
			(session as any).workspaceSymbols = async () => [];
			// A fresh launch: opencode is off, and no list of models has been asked for.
			setAgent((s) => {
				s.status = { state: "off" } as any;
				s.models = [];
				s.busy = false;
			});
			setState((s) => {
				if (opts.model) s.settings.agentModel = opts.model;
			});
			await openFile(planPath);
			flush();
			return { plan, run, ...(await import("../src/view/plan/buildRun")) };
		}
		const unitsNow = () => (latestAssistOf(planPath).run?.units ?? []).map((u) => [u.name, u.status]);

		/** Leaves nothing of one build for the next test: the run, the language server's stand-ins, opencode's state. */
		function tidyUp() {
			Object.assign(session, realSession);
			discardRun(planPath);
			setAgent((s) => {
				s.status = { state: "off" } as any;
				s.models = [];
				s.busy = false;
			});
			flush();
		}
		afterAll(tidyUp);

		test("a paid model is asked about on a fresh launch, before the list of models has ever been read", async () => {
			const { startBuild } = await setUp({ models: [local, paid], model: "openrouter/paid-model" });
			await startBuild(planPath);
			expect(questions).toEqual(["openrouter/paid-model may cost money. Stop the build at what cost?"]);
			// opencode was started and its models read first; backing out of the question spends nothing and begins no run.
			expect(agentCalls).toEqual(["start", "models"]);
			expect(latestAssistOf(planPath).run).toBeNull();
		});

		test("a model opencode does not list is asked about too", async () => {
			const { startBuild } = await setUp({ models: [local], model: "openrouter/not-listed" });
			await startBuild(planPath);
			expect(questions).toEqual(["openrouter/not-listed may cost money. Stop the build at what cost?"]);
			expect(agentCalls).not.toContain("ask");
		});

		test("a local model is not asked about, and the build runs to its end", async () => {
			const { startBuild } = await setUp({ models: [local, paid], model: "ollama/qwen3" });
			await startBuild(planPath);
			expect(questions).toEqual([]);
			expect(latestAssistOf(planPath).run?.status).toBe("built");
			expect(latestAssistOf(planPath).run?.budget.cost).toBeUndefined();
			expect(unitsNow()).toEqual([
				["Mark", "passed"],
				["Notify", "passed"],
			]);
		});

		test("a run begun with no cost budget is asked about when it is carried on with a paid model", async () => {
			const { run, startBuild } = await setUp({ models: [local, paid], model: "openrouter/paid-model", budget: "2" });
			updateAssist(planPath, { run });
			await startBuild(planPath);
			expect(questions).toEqual(["openrouter/paid-model may cost money. Stop the build at what cost?"]);
			expect(latestAssistOf(planPath).run?.budget.cost).toBe(2);
			expect(latestAssistOf(planPath).run?.status).toBe("built");
		});

		test("a unit that throws is stuck with the reason, the build stops, and trying again builds it", async () => {
			let serverUp = false;
			const { retryUnit, startBuild } = await setUp({
				models: [local],
				analyze: (text) => {
					if (!serverUp) throw new Error("The language server is not running.");
					return { diagnostics: [], symbols: proceduresIn(text), timedOut: false };
				},
			});
			await startBuild(planPath);
			const stopped = latestAssistOf(planPath).run!;
			expect(stopped.status).toBe("stopped");
			expect(unitsNow()).toEqual([
				["Mark", "stuck"],
				["Notify", "pending"],
			]);
			expect(stopped.units[0]!.problems).toEqual(["It could not be built: The language server is not running."]);
			// It threw before a turn was asked for: nothing was spent.
			expect(agentCalls).not.toContain("ask");
			expect(latestAssistOf(planPath).running).toBe("");

			serverUp = true;
			retryUnit(planPath, "Mark");
			await startBuild(planPath);
			expect(latestAssistOf(planPath).run?.status).toBe("built");
			expect(unitsNow()).toEqual([
				["Mark", "passed"],
				["Notify", "passed"],
			]);
		});

		test("a unit an earlier attempt left marked as being built is built when the build is carried on", async () => {
			const { run, startBuild } = await setUp({ models: [local] });
			run.status = "running";
			run.units[0]!.status = "running";
			updateAssist(planPath, { run });
			await startBuild(planPath);
			expect(prompts.map(unitAsked)).toEqual(["Mark", "Notify", null]);
			expect(latestAssistOf(planPath).run?.status).toBe("built");
			expect(unitsNow()).toEqual([
				["Mark", "passed"],
				["Notify", "passed"],
			]);
		});

		test("a build the folder was changed under does not go on saying that a unit is being built", async () => {
			let asked!: () => void;
			const asking = new Promise<void>((resolve) => (asked = resolve));
			let letGo!: () => void;
			const held = new Promise<void>((resolve) => (letGo = resolve));
			const { startBuild } = await setUp({
				models: [local],
				reply: async (prompt) => {
					asked();
					await held;
					return codeFor(unitAsked(prompt) ?? "Mark");
				},
			});
			const build = startBuild(planPath);
			await asking;
			expect(unitsNow()[0]).toEqual(["Mark", "running"]);
			setState((s) => {
				s.workspace = { root: "/other", name: "other" };
			});
			letGo();
			await build;
			// Nothing is building it now: it waits, and the run can be carried on when the folder is opened again.
			expect(latestAssistOf(planPath).run?.status).toBe("stopped");
			expect(unitsNow()).toEqual([
				["Mark", "pending"],
				["Notify", "pending"],
			]);
			setState((s) => {
				s.workspace = { root: "/ws", name: "ws" };
			});
		});

		test("an answer given to a stuck unit while the build is still running is kept, and the unit is built with it", async () => {
			let building!: () => void;
			const notifyBuilding = new Promise<void>((resolve) => (building = resolve));
			let letGo!: () => void;
			const held = new Promise<void>((resolve) => (letGo = resolve));
			const { answerUnit, startBuild } = await setUp({
				models: [local],
				reply: async (prompt) => {
					const unit = unitAsked(prompt);
					if (unit === "Mark" && !prompt.includes("THE USER SAID")) return said('<<<QUESTIONS\n[{"question":"Which table holds the samples?"}]\n>>>QUESTIONS');
					if (unit === "Notify") {
						building();
						await held;
					}
					return unit ? codeFor(unit) : said("It does what the chart says.");
				},
			});
			const build = startBuild(planPath);
			await notifyBuilding;
			// Mark asked its question and is stuck; Notify's turn is in flight.
			expect(unitsNow()).toEqual([
				["Mark", "stuck"],
				["Notify", "running"],
			]);
			answerUnit(planPath, "Mark", "SAMPLES");
			expect(latestAssistOf(planPath).run!.units[0]).toMatchObject({ status: "pending", answer: "SAMPLES" });
			letGo();
			await build;
			const done = latestAssistOf(planPath).run!;
			expect(done.units[0]).toMatchObject({ name: "Mark", status: "passed", answer: "SAMPLES" });
			expect(done.status).toBe("built");
			expect(prompts.filter((p) => unitAsked(p) === "Mark").at(-1)).toContain("THE USER SAID: SAMPLES");
		});

		// Pass 3, lows: a build stopped at its budget is carried on, and a script it may not write is refused.
		const priced = (reply: any, cost: number) => ({ ...reply, cost });

		test("a build stopped at its cost budget is carried on once the budget is raised, and what passed is not built again", async () => {
			const { startBuild } = await setUp({
				models: [local, paid],
				model: "openrouter/paid-model",
				reply: (prompt) => priced(unitAsked(prompt) ? codeFor(unitAsked(prompt)!) : said("It does what the chart says."), 1.5),
			});
			let answers: (string | null)[] = ["1"];
			askHandler = (prompt) => {
				questions.push(prompt);
				return answers.length ? answers.shift()! : null;
			};
			await startBuild(planPath);
			// Mark cost 1.50 against a budget of 1: the build stops before Notify.
			expect(latestAssistOf(planPath).run?.status).toBe("budget");
			expect(unitsNow()).toEqual([
				["Mark", "passed"],
				["Notify", "pending"],
			]);
			const turns = prompts.length;
			// Carried on, and the question backed out of: nothing is spent, and nothing changes.
			answers = [null];
			await startBuild(planPath);
			expect(questions.at(-1)).toBe("The build has spent 1.50, and its budget was 1. Stop it at what cost now?");
			expect(prompts.length).toBe(turns);
			expect(latestAssistOf(planPath).run?.status).toBe("budget");
			// A budget that is not above what is spent is refused.
			answers = ["1.5"];
			await startBuild(planPath);
			expect(prompts.length).toBe(turns);
			expect(latestAssistOf(planPath).run?.budget.cost).toBe(1);
			// Raised: the unit not built yet is built, and the one that passed is not asked for again.
			answers = ["5"];
			await startBuild(planPath);
			expect(latestAssistOf(planPath).run?.budget.cost).toBe(5);
			expect(prompts.map(unitAsked)).toEqual(["Mark", "Notify", null]);
			expect(latestAssistOf(planPath).run?.status).toBe("built");
			expect(unitsNow()).toEqual([
				["Mark", "passed"],
				["Notify", "passed"],
			]);
		});

		test("a unit the budget ran out on, with tries still to come, waits: it is not stuck, and is built when the build is carried on", async () => {
			const { startBuild } = await setUp({
				models: [local, paid],
				model: "openrouter/paid-model",
				// Mark's first try has no code, and costs more than the budget.
				reply: (prompt) => priced(unitAsked(prompt) === "Mark" && !prompt.includes("THESE ARE WRONG WITH IT") ? said("I will write it later.") : unitAsked(prompt) ? codeFor(unitAsked(prompt)!) : said("It does what the chart says."), 1.5),
			});
			let answers: (string | null)[] = ["1"];
			askHandler = (prompt) => {
				questions.push(prompt);
				return answers.length ? answers.shift()! : null;
			};
			await startBuild(planPath);
			expect(latestAssistOf(planPath).run?.status).toBe("budget");
			expect(unitsNow()).toEqual([
				["Mark", "pending"],
				["Notify", "pending"],
			]);
			answers = ["10"];
			await startBuild(planPath);
			expect(latestAssistOf(planPath).run?.status).toBe("built");
			expect(unitsNow()).toEqual([
				["Mark", "passed"],
				["Notify", "passed"],
			]);
		});

		test("a run that has used its tokens is carried on after a yes, and not without one", async () => {
			const { run, startBuild } = await setUp({ models: [local], model: "ollama/qwen3" });
			run.status = "budget";
			run.tokens = 400_100;
			updateAssist(planPath, { run });
			const asked: [string, string[] | undefined][] = [];
			let say: string | null = null;
			chooseHandler = (prompt, options) => {
				asked.push([prompt, options]);
				return say;
			};
			await startBuild(planPath);
			expect(asked.length).toBe(1);
			expect(asked[0]![1]).toEqual(["Carry on"]);
			expect(prompts.length).toBe(0);
			expect(latestAssistOf(planPath).run?.status).toBe("budget");
			say = "Carry on";
			await startBuild(planPath);
			expect(latestAssistOf(planPath).run?.status).toBe("built");
			expect(latestAssistOf(planPath).run?.budget.tokens).toBe(400_100 + 400_000);
		});

		test("a run past its budget with nothing left to build is built, and is asked for nothing", async () => {
			const { run, startBuild } = await setUp({ models: [local, paid], model: "openrouter/paid-model" });
			run.status = "budget";
			run.cost = 3;
			run.budget.cost = 1;
			for (const unit of run.units) Object.assign(unit, { status: "passed", code: `:PROCEDURE ${unit.name};\n:ENDPROC;` });
			updateAssist(planPath, { run });
			await startBuild(planPath);
			expect(questions).toEqual([]);
			expect(prompts.length).toBe(0);
			expect(latestAssistOf(planPath).run?.status).toBe("built");
		});

		test("carrying on a build that has finished asks the model nothing more", async () => {
			const { startBuild } = await setUp({
				models: [local],
				model: "ollama/local-model",
				reply: (prompt) => (unitAsked(prompt) ? codeFor(unitAsked(prompt)!) : said("It does what the chart says.")),
			});
			await startBuild(planPath);
			expect(latestAssistOf(planPath).run?.status).toBe("built");
			expect(latestAssistOf(planPath).run?.review).toBe("It does what the chart says.");
			const turns = prompts.length;
			// The button is still there on a finished run: pressed again, there is nothing to build and nothing new to read.
			await startBuild(planPath);
			await startBuild(planPath);
			expect(prompts.length).toBe(turns);
			expect(latestAssistOf(planPath).run?.status).toBe("built");
			expect(latestAssistOf(planPath).run?.review).toBe("It does what the chart says.");
		});

		test("a unit whose script is in a hidden folder stops the build before anything is asked", async () => {
			const { run, startBuild } = await setUp({ models: [local], model: "ollama/qwen3" });
			run.units[1]!.script = ".git/hooks/pre-commit";
			updateAssist(planPath, { run });
			await startBuild(planPath);
			expect(agentCalls).toEqual([]);
			expect(state.messages.at(-1)?.text).toBe("The build cannot write .git/hooks/pre-commit, where Notify is to go: it is hidden, or in a hidden folder. Discard this build, and correct the plan doc or the plan's target scripts.");
			expect(unitsNow()).toEqual([
				["Mark", "pending"],
				["Notify", "pending"],
			]);
		});
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

	test("fileRenamed clears stale conflicts[target], bumps kindVersion on binary-over-binary, and prevents preview demotion", async () => {
		rpcHandler = (method, args) => {
			const p = String(args[0] ?? "");
			if (method === "read") {
				if (p.endsWith(".png")) {
					const size = p.endsWith("img1.png") ? 10 : 20;
					return { text: "", mtime: 1, binary: { size, image: "image/png" } };
				}
				return { text: `text:${p}`, mtime: 1, encoding: "utf-8" };
			}
			if (method === "sizes") return { [String((args[0] as string[])[0])]: 10 };
			if (method === "create") return null;
			if (method === "write") return { mtime: 5 };
			return null;
		};

		// 1. Renaming a kept tab over a preview tab clears conflicts[target] and clears g.preview (never demotes kept tab).
		await openFile("/ws/kept.ssl", { keep: true });
		await openFile("/ws/preview.ssl", { preview: true });
		flush();
		expect(state.groups[0]!.preview).toBe("/ws/preview.ssl");

		setState((s) => {
			s.conflicts["/ws/preview.ssl"] = true;
		});
		flush();

		fileRenamed("/ws/kept.ssl", "/ws/preview.ssl");
		expect(state.conflicts["/ws/preview.ssl"]).toBeUndefined();
		expect(state.groups[0]!.preview).toBeNull();
		expect(state.groups[0]!.tabs).toEqual(["/ws/preview.ssl"]);

		// 2. Binary-over-binary rename bumps kindVersion so image/binary viewers refresh cleanly.
		await openFile("/ws/img1.png", { keep: true });
		await openFile("/ws/img2.png", { keep: true });
		flush();
		const kindBefore = state.kindVersion;
		fileRenamed("/ws/img1.png", "/ws/img2.png");
		expect(state.kindVersion).toBe(kindBefore + 1);
		expect(documents.get("/ws/img2.png")?.binary?.size).toBe(10);

		// 3. Untitled save over an existing preview tab clears g.preview.
		await openFile("/ws/preview-target.ssl", { preview: true });
		const untitled = newUntitled(0, "ssl");
		flush();
		expect(state.groups[0]!.preview).toBe("/ws/preview-target.ssl");
		documents.get(untitled)!.model.setValue(":RETURN 42;");
		askHandler = () => "preview-target.ssl";
		chooseHandler = () => "Overwrite";
		expect(await save(untitled)).toBe(true);
		expect(state.groups[0]!.preview).toBeNull();
	});

	test("onFlush callbacks guard against superseded focus and centerView switches while clearing lookedAt", async () => {
		rpcHandler = (method, args) => {
			if (method === "read") return { text: `body:${String(args[0])}`, mtime: 1, encoding: "utf-8" };
			return null;
		};
		await openFile("/ws/a.ssl", { keep: true });
		await openFile("/ws/b.ssl", { keep: true });
		await openFile("/ws/c.ssl", { keep: true });
		flush();
		tabShown(0, "/ws/a.ssl");
		tabShown(0, "/ws/b.ssl");
		tabShown(0, "/ws/c.ssl");

		const events: string[] = [];
		const unsubReveal = revealSignal.listen((p) => events.push(`reveal:${p}`));
		const unsubFocus = focusRequest.listen((t) => events.push(`focus:${t}`));

		try {
			// 1. nextTab() superseded by switching centerView to "graph" before flush must NOT reveal or steal focus.
			nextTab();
			setState((s) => {
				s.centerView = "graph";
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(events).toEqual([]);

			// 2. Rapid stepRecent() A -> B -> C before flush skips stale B reveal/focus and only fires for A.
			setState((s) => {
				s.centerView = "editors";
				s.groups[0]!.active = "/ws/c.ssl";
			});
			flush();
			events.length = 0;
			stepRecent(1, true); // c -> b
			stepRecent(1, false); // b -> a
			await Promise.resolve();
			await Promise.resolve();
			expect(events).toEqual(["reveal:/ws/a.ssl", "focus:editor"]);

			// 3. Concurrent openFile(a, keep) + openFile(b, keep) suppresses stale a.ssl reveal/focus.
			events.length = 0;
			await Promise.all([openFile("/ws/a.ssl", { keep: true }), openFile("/ws/b.ssl", { keep: true })]);
			await Promise.resolve();
			await Promise.resolve();
			expect(events).toEqual(["reveal:/ws/b.ssl", "focus:editor"]);

			// 4. openFile(a, keep) superseded in the same microtask batch by openFile(a, preview) does NOT steal focus.
			events.length = 0;
			await Promise.all([openFile("/ws/a.ssl", { keep: true }), openFile("/ws/a.ssl", { preview: true })]);
			await Promise.resolve();
			await Promise.resolve();
			expect(openedForALook("/ws/a.ssl")).toBe(false);
			expect(events).not.toContain("focus:editor");

			// 5. openFile(c, preview) interrupted by switching to "graph" during flush still clears lookedAt and skips reveal/focus.
			events.length = 0;
			let sawLookDuringFlush = false;
			const dispose = createRoot((d) => {
				createEffect(
					() => state.groups[0]?.active,
					(active) => {
						if (active === "/ws/c.ssl" && openedForALook("/ws/c.ssl")) {
							sawLookDuringFlush = true;
							setState((s) => {
								s.centerView = "graph";
							});
						}
					},
				);
				return d;
			});
			try {
				flush();
				await openFile("/ws/c.ssl", { preview: true });
				await Promise.resolve();
				await Promise.resolve();
				expect(sawLookDuringFlush).toBe(true);
				expect(openedForALook("/ws/c.ssl")).toBe(false);
				expect(events).toEqual([]);
			} finally {
				dispose();
			}
		} finally {
			unsubReveal();
			unsubFocus();
		}
	});

	test("saveSetting ignores late success and failure rollback after switching workspaces", async () => {
		let resolveSave!: (v: unknown) => void;
		let rejectSave!: (e: Error) => void;
		let failMode = false;
		let settingsReads = 0;

		rpcHandler = (method) => {
			if (method === "saveSettings") {
				return new Promise((resolve, reject) => {
					resolveSave = resolve;
					rejectSave = reject;
				});
			}
			if (method === "settings") {
				settingsReads++;
				return { effective: { ...DEFAULT_SETTINGS, wordWrap: true } };
			}
			return null;
		};

		// 1. In-flight success from Workspace A must not overwrite Workspace B.
		setState((s) => {
			s.workspace = { root: "/ws-a", name: "ws-a" };
			s.settings.wordWrap = false;
		});
		flush();

		const savingA = saveSetting({ wordWrap: true });
		await Promise.resolve();
		await Promise.resolve();

		setState((s) => {
			s.workspace = { root: "/ws-b", name: "ws-b" };
			s.settings.wordWrap = false;
		});
		flush();

		resolveSave({ ...DEFAULT_SETTINGS, wordWrap: true });
		await savingA;
		flush();
		expect(state.settings.wordWrap).toBe(false);

		// 2. In-flight failure from Workspace B must not trigger disk rollback over Workspace C.
		failMode = true;
		const failingB = saveSetting({ wordWrap: true });
		await Promise.resolve();
		await Promise.resolve();

		setState((s) => {
			s.workspace = { root: "/ws-c", name: "ws-c" };
			s.settings.wordWrap = false;
		});
		flush();

		if (failMode) rejectSave(new Error("ws-b write failed"));
		await failingB;
		flush();
		expect(settingsReads).toBe(0);
		expect(state.settings.wordWrap).toBe(false);
	});

	// Pass 3: the question about unsaved changes is asked before the folder is chosen and opened, which takes a while.
	test("a folder is not opened over what was typed while it was being opened", async () => {
		const file = "/ws/a.ssl";
		const opened: unknown[] = [];
		let letGo!: () => void;
		const held = new Promise<void>((resolve) => (letGo = resolve));
		let asked!: () => void;
		const asking = new Promise<void>((resolve) => (asked = resolve));
		rpcHandler = async (method, args) => {
			if (method === "read") return { text: ":RETURN 1;\n", mtime: 1, encoding: "utf-8" };
			if (method === "openFolder") {
				opened.push(args[0]);
				if (args[0] === "/other") {
					asked();
					await held;
					return { root: "/other", name: "other" };
				}
				return { root: String(args[0]), name: "ws" };
			}
			return null;
		};
		await openFile(file, { keep: true });
		flush();
		const model = documents.get(file)!.model as any;

		const switching = openFolder("/other");
		await asking;
		// Nothing was unsaved when the question would have been asked. This is typed while the backend opens the folder.
		model.pushEditOperations([], [{ range: new FakeRange(1, 1, 1, 1), text: "x" }], () => null);
		letGo();
		await switching;
		flush();

		// The backend, already in the new folder, was sent back; the view never left, and the edit is still there.
		expect(opened).toEqual(["/other", "/ws"]);
		expect(snapshot(state).workspace?.root).toBe("/ws");
		expect(documents.get(file)?.model).toBe(model);
		expect(model.isDisposed()).toBe(false);
		expect(model.getValue()).toBe("x:RETURN 1;\n");
		expect(snapshot(state).dirty[file]).toBe(true);
		expect(snapshot(state).messages.some((m) => /other was not opened: .*a\.ssl changed while it was being opened/.test(m.text))).toBe(true);
	});

	test("changes the user chose to discard do not call the folder off; typing in such a file afterwards does", async () => {
		const file = "/ws/a.ssl";
		const opened: unknown[] = [];
		const gates: (() => void)[] = [];
		rpcHandler = async (method, args) => {
			if (method === "read") return { text: ":RETURN 1;\n", mtime: 1, encoding: "utf-8" };
			if (method === "settings") return { effective: DEFAULT_SETTINGS };
			if (method === "themes") return [];
			if (method === "info") return { app: "0.1.0", selftest: true };
			if (method === "lspState") return { state: "stopped" };
			if (method === "openFolder") {
				opened.push(args[0]);
				if (args[0] === "/other") await new Promise<void>((resolve) => gates.push(resolve));
				return { root: String(args[0]), name: String(args[0]).slice(1) };
			}
			return null;
		};
		chooseHandler = () => "Discard changes";
		const edit = (text: string) => (documents.get(file)!.model as any).pushEditOperations([], [{ range: new FakeRange(1, 1, 1, 1), text }], () => null);
		const until = async (ok: () => boolean) => {
			for (let i = 0; i < 500 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
			expect(ok()).toBe(true);
		};

		// Typed in again after "Discard changes" was answered: that is not what was agreed to drop.
		await openFile(file, { keep: true });
		flush();
		edit("x");
		flush();
		const first = openFolder("/other");
		await until(() => gates.length === 1);
		edit("y");
		gates.shift()!();
		await first;
		flush();
		expect(opened).toEqual(["/other", "/ws"]);
		expect(snapshot(state).workspace?.root).toBe("/ws");
		expect((documents.get(file)!.model as any).getValue()).toBe("yx:RETURN 1;\n");

		// Left as it was after the answer: the folder opens and the file goes, as chosen.
		opened.length = 0;
		const second = openFolder("/other");
		await until(() => gates.length === 1);
		gates.shift()!();
		await second;
		flush();
		expect(opened).toEqual(["/other"]);
		expect(snapshot(state).workspace?.root).toBe("/other");
		expect(documents.has(file)).toBe(false);
	});

	// Pass 3: what is typed in a view's own editor (a table's open cell) is not in the document until it is committed.
	describe("a cell still being typed in", () => {
		const path = "/ws/docs/registries/objects.csv";
		/** A table with one open cell: what is typed goes into the model only when the view is asked to commit. */
		const openCell = async () => {
			const disk = new Map([[path, "id,name\n1,Alpha\n"]]);
			rpcHandler = (method, args) => {
				if (method === "read") return { text: disk.get(String(args[0])) ?? "", mtime: 1, encoding: "utf-8" };
				if (method === "write") {
					disk.set(String(args[0]), String(args[1]));
					return { mtime: 2 };
				}
				return null;
			};
			await openFile(path, { keep: true });
			flush();
			const cell = { typed: null as string | null };
			const release = holdsPendingEdit(() => {
				if (cell.typed === null) return;
				const model = documents.get(path)!.model as any;
				model.pushEditOperations([], [{ range: new FakeRange(2, 3, 2, 8), text: cell.typed }], () => null);
				cell.typed = null;
			});
			return { disk, cell, release };
		};

		test("is part of what a save writes", async () => {
			const { disk, cell, release } = await openCell();
			try {
				cell.typed = "CHANGED";
				expect(await save(path)).toBe(true);
				expect(disk.get(path)).toBe("id,name\n1,CHANGED\n");
			} finally {
				release();
			}
		});

		test("is an unsaved change a close of the tab asks about", async () => {
			const { cell, release } = await openCell();
			try {
				cell.typed = "CHANGED";
				const asked: string[] = [];
				chooseHandler = (prompt) => {
					asked.push(prompt);
					return null; // Cancel: the tab stays.
				};
				expect(await closeTab(path)).toBe(false);
				expect(asked).toHaveLength(1);
				expect(asked[0]).toContain("unsaved changes");
				expect(snapshot(state).groups[0]!.tabs).toContain(path);
				expect((documents.get(path)!.model as any).getValue()).toBe("id,name\n1,CHANGED\n");
			} finally {
				release();
			}
		});

		test("is put in its document before the keyboard steps to the next tab", async () => {
			const { cell, release } = await openCell();
			try {
				rpcHandler = (method) => (method === "read" ? { text: "other\n", mtime: 1, encoding: "utf-8" } : null);
				await openFile("/ws/data/other.csv", { keep: true });
				await openFile(path, { keep: true });
				flush();
				cell.typed = "TYPED";
				// The tab is left by a key: nothing takes the focus out of the cell, so nothing else commits it.
				nextTab();
				flush();
				expect(snapshot(state).groups[0]!.active).toBe("/ws/data/other.csv");
				expect(cell.typed).toBeNull();
				expect(documents.get(path)!.model.getValue()).toBe("id,name\n1,TYPED\n");
			} finally {
				release();
			}
		});

		// Pass 4, M6: the step by Ctrl+PageDown was the one way of leaving a tab that put the text in first.
		test("is put in its document on every other way of leaving the tab: Ctrl+Tab, a click, Go back, a new file, another view of it", async () => {
			const { cell, release } = await openCell();
			const other = "/ws/data/other.csv";
			const back = async () => {
				await openFile(path, { keep: true });
				flush();
				expect(snapshot(state).groups[0]!.active).toBe(path);
			};
			const kept = (typed: string) => {
				flush();
				expect(cell.typed).toBeNull();
				expect(documents.get(path)!.model.getValue()).toBe(`id,name\n1,${typed}\n`);
			};
			try {
				rpcHandler = (method) => (method === "read" ? { text: "other\n", mtime: 1, encoding: "utf-8" } : null);
				await openFile(other, { keep: true });

				// Ctrl+Tab: to the tab used before this one.
				await back();
				cell.typed = "BYTAB";
				stepRecent(1, false);
				expect(snapshot(state).groups[0]!.active).toBe(other);
				kept("BYTAB");

				// A press on another tab, as the tab strip does it: the state is set, nothing more.
				await back();
				cell.typed = "CLICK";
				setState((s) => {
					s.groups[0]!.active = other;
				});
				kept("CLICK");

				// Go back, Go to file, a result in a list: all open a file.
				await back();
				cell.typed = "OPENS";
				await openFile(other, { keep: true });
				kept("OPENS");

				// A new file.
				await back();
				cell.typed = "NEWED";
				const untitled = newUntitled();
				expect(snapshot(state).groups[0]!.active).toBe(untitled);
				kept("NEWED");
				await closeTab(untitled, 0, { discard: true });

				// The same file in its other view: Table to Text.
				await back();
				cell.typed = "TEXTS";
				setState((s) => {
					s.groups[0]!.tableText = !s.groups[0]!.tableText;
				});
				kept("TEXTS");
			} finally {
				release();
			}
		});

		test("a change of state that leaves every view where it is commits nothing", async () => {
			const { cell, release } = await openCell();
			try {
				cell.typed = "STILL TYPING";
				setState((s) => {
					s.bottomMaximized = !s.bottomMaximized;
				});
				setState((s) => {
					s.groups[0]!.active = path;
				});
				flush();
				expect(cell.typed).toBe("STILL TYPING");
				expect(documents.get(path)!.model.getValue()).not.toContain("STILL TYPING");
				cell.typed = null;
			} finally {
				release();
			}
		});

		test("a view that has gone is not asked, and one that fails does not stop the others", async () => {
			const { cell, release } = await openCell();
			let asked = 0;
			const releaseOther = holdsPendingEdit(() => {
				asked++;
				throw new Error("this view's editor is broken");
			});
			try {
				cell.typed = "X";
				commitPendingEdits();
				expect(asked).toBe(1);
				expect(cell.typed).toBeNull();
				release();
				releaseOther();
				cell.typed = "Y";
				commitPendingEdits();
				expect(asked).toBe(1);
				expect(cell.typed as string | null).toBe("Y");
			} finally {
				release();
				releaseOther();
			}
		});
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

	test("refetch() on a falsy source returns early without wiping a mutate()d value", async () => {
		let fetchCalls = 0;
		const ctx = createRoot((dispose) => {
			const [key, setKey] = createSignal<string | false | null>(false);
			const [data, { refetch, mutate }] = createAsyncQuery(key, (k) => {
				fetchCalls++;
				return `fetched:${k}`;
			});
			return { setKey, data, refetch, mutate, dispose };
		});
		try {
			flush();
			expect(fetchCalls).toBe(0);

			ctx.mutate("kept-local");
			flush();
			expect(ctx.data()).toBe("kept-local");
			expect(ctx.data.latest).toBe("kept-local");

			// Calling refetch() while source is falsy must NOT wipe the mutated value or trigger a fetch.
			ctx.refetch();
			flush();
			expect(fetchCalls).toBe(0);
			expect(ctx.data()).toBe("kept-local");
			expect(ctx.data.latest).toBe("kept-local");

			// Switching to a truthy source fetches normally, and refetch() works again on a truthy source.
			ctx.setKey("live");
			flush();
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(fetchCalls).toBe(1);
			expect(ctx.data()).toBe("fetched:live");

			ctx.refetch();
			flush();
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(fetchCalls).toBe(2);
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

	test("multi-owner diagnostics reconcile does not alias objects across Owner A + Owner B -> clear A -> republish A", () => {
		const model = createFakeModel("x := 1;\ny := 2;\n", "ssl", makeUri("file", "/ws/multi-owner-diag.ssl"));
		const uri = model.uri.toString();
		try {
			// Step 1: Owner A publishes A1, Owner B publishes B1 -> [A1, B1]
			publishFindings(model as any, "ownerA", [
				{ line: 1, column: 1, endLine: 1, endColumn: 2, severity: 1, message: "A1", code: "A1" },
			]);
			publishFindings(model as any, "ownerB", [
				{ line: 2, column: 1, endLine: 2, endColumn: 2, severity: 2, message: "B1", code: "B1" },
			]);
			flush();
			expect(diagnostics[uri]?.map((d) => d.message)).toEqual(["A1", "B1"]);

			// Step 2: Clear Owner A (with empty list, preserving ownerA before ownerB, just like LSP publishDiagnostics([])) -> [B1]
			publishFindings(model as any, "ownerA", []);
			flush();
			expect(diagnostics[uri]?.map((d) => d.message)).toEqual(["B1"]);

			// Step 3: Republish Owner A with A2 -> MUST hold [A2, B1], NOT [A2, A2]!
			publishFindings(model as any, "ownerA", [
				{ line: 1, column: 1, endLine: 1, endColumn: 3, severity: 1, message: "A2", code: "A2" },
			]);
			flush();
			expect(diagnostics[uri]?.map((d) => d.message)).toEqual(["A2", "B1"]);

			// Step 4: Also verify clear via null followed by republish A3 -> [B1, A3] without corrupting B1
			publishFindings(model as any, "ownerA", null);
			flush();
			expect(diagnostics[uri]?.map((d) => d.message)).toEqual(["B1"]);

			publishFindings(model as any, "ownerA", [
				{ line: 1, column: 1, endLine: 1, endColumn: 4, severity: 1, message: "A3", code: "A3" },
			]);
			flush();
			expect(diagnostics[uri]?.map((d) => d.message)).toEqual(["B1", "A3"]);
		} finally {
			publishFindings(model as any, "ownerA", null);
			publishFindings(model as any, "ownerB", null);
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

// =============================================================================
// 7. agent/Agent.tsx — same-tick workspace switch + attachFileToAgent + currentAgentContext
// =============================================================================
describe("SolidJS 2.0.3 audit — agent/Agent.tsx", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	test("same-tick workspace switch + attachFileToAgent + currentAgentContext preserves new attachment and never leaks old workspace context", () => {
		// 1. Seed Workspace A with an attached file.
		setState((s) => {
			s.workspace = { root: "/ws-agent-a", name: "ws-a" };
		});
		flush();
		attachFileToAgent("/ws-agent-a/docs/old.md");
		flush();
		expect(currentAgentContext().workOptions.ticketFiles).toEqual([
			{ path: "/ws-agent-a/docs/old.md", rel: "docs/old.md" },
		]);

		// 2. Switch to Workspace B WITHOUT flushing, attach a Workspace B file, and immediately read currentAgentContext().
		setState((s) => {
			s.workspace = { root: "/ws-agent-b", name: "ws-b" };
		});
		attachFileToAgent("/ws-agent-b/docs/new.md");
		const ctxSameTick = currentAgentContext();
		expect(ctxSameTick.workOptions.ticketFiles).toEqual([
			{ path: "/ws-agent-b/docs/new.md", rel: "docs/new.md" },
		]);
		expect(ctxSameTick.workOptions.includeSchema).toBe(false);
		expect(ctxSameTick.workOptions.includeRegistries).toBe(false);
		expect(ctxSameTick.workOptions.includeState).toBe(false);

		// 3. Switch to Workspace C WITHOUT flushing and read currentAgentContext() without attaching: clean empty context!
		setState((s) => {
			s.workspace = { root: "/ws-agent-c", name: "ws-c" };
		});
		const ctxC1 = currentAgentContext();
		expect(ctxC1.workOptions.ticketFiles).toEqual([]);
		const ctxC2 = currentAgentContext();
		expect(ctxC2.workOptions.ticketFiles).toEqual([]);

		// 4. Attempting to attach a Workspace A file while switched to Workspace C (unflushed) is rejected.
		attachFileToAgent("/ws-agent-a/docs/old.md");
		expect(currentAgentContext().workOptions.ticketFiles).toEqual([]);
		flush();
		expect(currentAgentContext().workOptions.ticketFiles).toEqual([]);
	});

	// Pass 3: a turn's session is the conversation's only while nothing ended the conversation's session during it.
	describe("a session ended while a reply is running", () => {
		const reply = { sessionID: "session-of-the-old-model", text: "an answer", outcome: "succeeded", tokens: { input: 1, output: 1 } };
		/** A backend whose reply waits to be let go, so something can happen while the turn is running. */
		const heldReply = () => {
			let letGo!: () => void;
			const held = new Promise<void>((resolve) => (letGo = resolve));
			let asked: () => void;
			const asking = new Promise<void>((resolve) => (asked = resolve));
			rpcHandler = async (method, args) => {
				if (method !== "agent") return null;
				if (args[0] === "ask") {
					asked();
					await held;
					return reply;
				}
				if (args[0] === "stop") return { state: "off" };
				return null;
			};
			return { letGo, asking };
		};
		const ready = () => {
			setAgent((s) => {
				s.status = { state: "ready" } as any;
				s.chatSession = null;
				s.busy = false;
			});
			flush();
		};

		test("left alone, the conversation carries on in the session the reply came from", async () => {
			ready();
			const { letGo, asking } = heldReply();
			const turn = askAbout("What does this do?", false);
			await asking;
			letGo();
			await turn;
			flush();
			expect(snapshot(agent).chatSession).toBe(reply.sessionID);
		});

		test("ended meanwhile (opencode stopped, as when another model is picked), the reply's session is not taken up again", async () => {
			ready();
			const { letGo, asking } = heldReply();
			const before = chatSessionEpoch();
			const turn = askAbout("What does this do?", false);
			await asking;
			// What picking another model does too: the conversation's session ends, the turn itself goes on.
			await stopAgent();
			expect(chatSessionEpoch()).toBeGreaterThan(before);
			letGo();
			await turn;
			flush();
			expect(snapshot(agent).chatSession).toBeNull();
		});
	});
});
