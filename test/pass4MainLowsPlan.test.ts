// Planning mode, pass 4, low findings that were already on main (B7-2, B7-6 with B9-6, B7-7, B7-10, B7-11, B7-12),
// and two found while the last of them were fixed: a unit that passes after its script was accepted, and a review
// accepted after the run or the target script it was opened for had changed.
//
// Four of them are one question, asked at the moment of accepting: is what the review shows still what accepting
// would act on? The run it was opened from, the target script, and the script's text.
//
// Builds are run from "New build" to their end, reviewed and accepted, with opencode and the language server faked
// as in pass4MainPlan.test.ts: no model is asked anything, every reply is written here, and the "paid" model is a
// name in a list. The last blocks are pure logic.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { flush } from "solid-js";
import { DEFAULT_SETTINGS } from "../src/shared/protocol";
import { planHash, printSpec } from "../src/view/plan/assist";
// As a namespace: what this pass added to it is looked up when a test runs.
import * as build from "../src/view/plan/build";
import type { BuildRun, BuildUnit } from "../src/view/plan/build";
import * as built from "../src/view/plan/built";
import { addPlanTest, parsePlan, planTestsOf, printPlan, removeNode, removePlanTest, updatePlanTest, type Plan } from "../src/view/plan/model";

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
const { session } = await import("../src/view/lsp/session");
const { applyText, closeTab, documents, openFile, setState, state } = await import("../src/view/state");
const { resetRecentTabs } = await import("../src/view/recentTabs");
const { latestAssistOf, planOf, savePlan, updateAssist } = await import("../src/view/plan/run");
const { discardRun, loadRun, retryUnit, reviewBuild, runFile, scriptsToReview, startBuild } = await import("../src/view/plan/buildRun");
const { writeTests } = await import("../src/view/plan/testScript");
const { resetTidy } = await import("../src/view/agent/tidy");
const { setAgent } = await import("../src/view/agent/store");

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

// --- what the blocks that drive a build share -------------------------------------------------------------------

const planPath = "/ws/design/Release.plan.json";
const specFile = "/ws/design/Release.plan.md";
const script = "/ws/src/Release.ssl";
const testsFile = "/ws/src/ReleaseTests.ssl";
const local = { providerID: "ollama", id: "qwen3", name: "qwen3", local: true, tools: true, variants: [] };
const paid = { providerID: "openrouter", id: "paid-model", name: "Paid", local: false, tools: true, variants: [] };
const PAID = "openrouter/paid-model";
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
type Unit = { name: string; script?: string; nodes: string[]; calls: string[] };
const oneScript: Unit[] = [
	{ name: "Mark", script: "src/Release.ssl", nodes: ["n2"], calls: [] },
	{ name: "Notify", script: "src/Release.ssl", nodes: ["n3"], calls: [] },
];
/** Units with no script of their own: they go to the plan's target script, whichever that is at the time. */
const noScripts: Unit[] = oneScript.map(({ script: _script, ...unit }) => unit);
const ends = [
	{ node: "n1", becomes: "entry" },
	{ node: "n4", becomes: "exit" },
];

const said = (text: string, cost = 0) => ({ sessionID: "s", text, outcome: "succeeded", tokens: { input: 5000, output: 10 }, cost });
const codeOf = (name: string) => `:PROCEDURE ${name};\n:ENDPROC;`;
const fence = (code: string) => "```ssl\n" + code + "\n```";
/** What a turn is asked to build, from its prompt; null for the second opinion and for the tests. */
const unitAsked = (prompt: string) => /^PLAN STAGE: build (\w+)/.exec(prompt)?.[1] ?? null;
const proceduresIn = (text: string) => [...text.matchAll(/:PROCEDURE (\w+)/g)].map((m) => ({ name: m[1], kind: 11, children: [] }));
/** The language server's syntax tree, as far as a build reads it: each procedure, and the lines it runs over. */
const treeOf = (text: string) => {
	const lines = text.split(/\r?\n/);
	return lines.flatMap((line, i) => {
		const name = /^:PROCEDURE (\w+)/.exec(line)?.[1];
		return name ? [{ kind: "procedure", name, range: { start: { line: i }, end: { line: lines.findIndex((l, j) => j >= i && l.startsWith(":ENDPROC")) } } }] : [];
	});
};
const count = (text: string, part: string) => text.split(part).length - 1;

const realSession = {
	analyze: session.analyze,
	scratchTree: session.scratchTree,
	scratchCalls: session.scratchCalls,
	formatText: session.formatText,
	workspaceSymbols: session.workspaceSymbols,
	scriptCalls: session.scriptCalls,
};
let disk = new Map<string, string>();
let prompts: string[] = [];
/** Every question asked through a dialog, budget questions among them, in order. */
let questions: string[] = [];
/** What the build's own file holds, where a test says so; otherwise it is read from `disk` like any file. */
let runFileText: string | undefined;
/** By path: how many more reads of the file are answered before they are refused. */
let readsLeft = new Map<string, number>();

type SetUp = { plan?: Plan; units?: Unit[]; models?: unknown[]; model?: string; reply?: (prompt: string) => unknown; files?: Record<string, string>; unreadable?: string[]; runFileText?: string; budget?: string };

/**
 * The plan with its approved doc on disk, a language server that answers, and an opencode that writes each
 * procedure it is asked for, or says what `reply` says. The model is a local one unless a test names another.
 */
async function setUp(opts: SetUp = {}) {
	tidyUp();
	const plan = opts.plan ?? releasePlan();
	disk = new Map<string, string>([[planPath, printPlan(plan)], [specFile, printSpec("The spec.", opts.units ?? oneScript, ends, planHash(plan))], ...Object.entries(opts.files ?? {})]);
	prompts = [];
	questions = [];
	readsLeft = new Map((opts.unreadable ?? []).map((path) => [path, 0]));
	runFileText = opts.runFileText;
	const savedRun = runFile(planPath, "/ws");
	rpcHandler = async (method, args) => {
		if (method === "read") {
			const p = String(args[0]);
			if (p === savedRun && runFileText !== undefined) return { text: runFileText, mtime: 1, encoding: "utf-8" };
			const left = readsLeft.get(p);
			if (left !== undefined) {
				if (left <= 0) throw new Error(`EACCES: permission denied, open '${p}'`);
				readsLeft.set(p, left - 1);
			}
			if (!disk.has(p)) throw new Error("ENOENT");
			return { text: disk.get(p)!, mtime: 1, encoding: "utf-8" };
		}
		if (method === "write") {
			disk.set(String(args[0]), String(args[1]));
			return { mtime: 2 };
		}
		if (method === "sizes") return Object.fromEntries((args[0] as string[]).filter((p) => disk.has(p)).map((p) => [p, disk.get(p)!.length]));
		if (method === "search") return [];
		if (method !== "agent") return null;
		if (args[0] === "start") return { state: "ready" };
		if (args[0] === "models") return opts.models ?? [local];
		if (args[0] === "skills") return [{ id: "ssl-new-procedure" }, { id: "ssl-unit-test" }];
		if (args[0] === "ask") {
			const prompt = String((args[1] as { text: string }[])[0]!.text);
			prompts.push(prompt);
			if (opts.reply) return opts.reply(prompt);
			return unitAsked(prompt) ? said(fence(codeOf(unitAsked(prompt)!))) : said("It does what the chart says.");
		}
		return null;
	};
	askHandler = (prompt) => {
		questions.push(prompt);
		return opts.budget ?? null;
	};
	chooseHandler = (prompt) => {
		questions.push(prompt);
		return null;
	};
	(session as any).analyze = async (text: string) => ({ diagnostics: [], symbols: proceduresIn(text), timedOut: false });
	(session as any).scratchTree = async (text: string) => treeOf(text);
	(session as any).scratchCalls = async () => [];
	(session as any).formatText = async (text: string) => text;
	(session as any).workspaceSymbols = async () => [];
	(session as any).scriptCalls = async () => null;
	setAgent((s) => {
		s.status = { state: "off" } as any;
		s.models = [];
		s.busy = false;
	});
	setState((s) => {
		s.settings.agentModel = opts.model ?? "ollama/qwen3";
	});
	await openFile(planPath);
	flush();
	return plan;
}

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

const runNow = () => latestAssistOf(planPath).run!;
const planNow = () => planOf(planPath)!;
const unitsNow = () => (latestAssistOf(planPath).run?.units ?? []).map((u) => [u.name, u.status]);
const recordNow = () => built.builtOf(planNow());
const bufferOf = (path: string) => documents.get(path)!.model.getValue();
const toReview = () => scriptsToReview(runNow(), planNow());
const notices = () => {
	flush();
	return state.messages.map((m) => m.text);
};
const aMoment = () => new Promise((r) => setTimeout(r, 25));
const latestModel = () => {
	flush();
	return state.settings.agentModel;
};
/** The model chosen in the Agent panel while a build runs: the setting is written, and nothing waits for it to show. */
const chooseModel = (model: string) => {
	setState((s) => {
		s.settings.agentModel = model;
	});
};

type Open = NonNullable<ReturnType<typeof review>>;
/** "Review" in the Assistant: the review that then stands open. */
async function openTheReview(): Promise<Open> {
	await reviewBuild(planPath);
	flush();
	return review()!;
}
/** A review put aside without a word: closed, and nothing sent back to the agent. */
function putAside(open: Open) {
	open.onReject = undefined;
	if (review() === open) closeReview();
	flush();
}
/** "Accept" in the review: it closes, and what it proposed is accepted. */
async function accept(open: Open, text = open.proposed) {
	putAside(open);
	await open.onAccept(text);
	flush();
}
/**
 * "Accept" where the review refuses: what it says, which the review shows after "Not accepted:" while it stays
 * open. Empty when the accept went through.
 */
async function refused(open: Open): Promise<string> {
	let why = "";
	await Promise.resolve()
		.then(() => open.onAccept(open.proposed))
		.catch((e) => (why = String(e?.message ?? e)));
	flush();
	// Refusing neither closes the review nor puts another in its place.
	if (why) expect(review()).toBe(open);
	putAside(open);
	return why;
}

/** A finished build of the plan: both units passed, nothing accepted. */
const finishedRun = (plan: Plan, more: Partial<BuildRun> = {}): BuildRun => ({
	version: 1,
	planHash: planHash(plan),
	prints: built.nodePrints(plan),
	model: "ollama/qwen3",
	status: "built",
	tokens: 100,
	cost: 0,
	budget: { tokens: 400_000 },
	units: oneScript.map((u) => ({ ...u, status: "passed", attempts: 1, code: codeOf(u.name) })) as BuildUnit[],
	map: ends,
	accepted: [],
	...more,
});
/** A build that stopped before it built anything, as its file holds it. */
const waitingRun = (plan: Plan, more: Record<string, unknown> = {}): Record<string, unknown> => ({
	...finishedRun(plan, { status: "stopped", tokens: 0 }),
	units: oneScript.map((u) => ({ ...u, status: "pending", attempts: 0 })),
	...more,
});

const OLD = "/* Release: what was here before the build;\n:PROCEDURE Old;\n:ENDPROC;\n";
const TYPED = ":PROCEDURE TypedMeanwhile;\n:ENDPROC;\n";

describe("pass 4, lows on main: a build, its review and its test script, with opencode faked", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);
	afterAll(tidyUp);

	// --- B7-2 ---------------------------------------------------------------------------------------------------

	describe("B7-2: the model changed to one that may cost money while a build runs", () => {
		/** Each turn costs what a paid model's would, so a turn that should not have been asked shows in the cost. */
		const replies = (changeAt: (prompt: string, turn: number) => boolean, text = (prompt: string) => (unitAsked(prompt) ? fence(codeOf(unitAsked(prompt)!)) : "It does what the chart says.")) => {
			let turn = 0;
			let changed = false;
			return (prompt: string) => {
				turn++;
				// A turn on the paid model: it is the one chosen as the build begins, or was chosen in an earlier turn.
				const onPaid = changed || latestModel() === PAID;
				if (changeAt(prompt, turn)) {
					changed = true;
					chooseModel(PAID);
				}
				return said(text(prompt), onPaid ? 2.5 : 0);
			};
		};

		test("the build stops before its next turn: nothing is asked of the paid model, and nothing is spent", async () => {
			await setUp({ models: [local, paid], reply: replies((_prompt, turn) => turn === 1) });
			await startBuild(planPath);
			// One turn, on the local model. It used to be three, two of them on the paid model with no budget ever set.
			expect(prompts.map(unitAsked)).toEqual(["Mark"]);
			expect(runNow().cost).toBe(0);
			expect(runNow().status).toBe("stopped");
			expect(unitsNow()).toEqual([
				["Mark", "passed"],
				["Notify", "pending"],
			]);
			expect(questions).toEqual([]);
			expect(runNow().budget.cost).toBeUndefined();
			expect(notices().at(-1)).toBe("The build has stopped: the model is now openrouter/paid-model, which may cost money, and this build has no cost budget. Carrying on asks for one.");
		});

		test("carrying on asks for the budget a new build would have been asked for, and then goes on within it", async () => {
			await setUp({ models: [local, paid], reply: replies((_prompt, turn) => turn === 1) });
			await startBuild(planPath);
			// No answer to the question: nothing more is asked.
			await startBuild(planPath);
			expect(questions).toEqual(["openrouter/paid-model may cost money. Stop the build at what cost?"]);
			expect(prompts.map(unitAsked)).toEqual(["Mark"]);
			askHandler = (prompt) => {
				questions.push(prompt);
				return "6";
			};
			await startBuild(planPath);
			expect(questions).toEqual(["openrouter/paid-model may cost money. Stop the build at what cost?", "openrouter/paid-model may cost money. Stop the build at what cost?"]);
			expect(runNow().budget.cost).toBe(6);
			expect(prompts.map(unitAsked)).toEqual(["Mark", "Notify", null]);
			expect(runNow().status).toBe("built");
			expect(runNow().cost).toBe(5);
		});

		test("a second try of the same unit is not asked of the paid model either", async () => {
			// The first reply holds no code, so the unit is tried again: by then the model has been changed.
			await setUp({ models: [local, paid], reply: replies((_prompt, turn) => turn === 1, () => "I am not sure how to write this.") });
			await startBuild(planPath);
			expect(prompts).toHaveLength(1);
			expect(runNow().cost).toBe(0);
			expect(runNow().status).toBe("stopped");
			// It waits: it has not had its tries, so it is not stuck.
			expect(unitsNow()).toEqual([
				["Mark", "pending"],
				["Notify", "pending"],
			]);
			expect(notices().at(-1)).toContain("The build has stopped: the model is now openrouter/paid-model");
		});

		test("the second opinion is a turn too: it is not asked for, and that is said", async () => {
			await setUp({ models: [local, paid], reply: replies((prompt) => unitAsked(prompt) === "Notify") });
			await startBuild(planPath);
			expect(prompts.map(unitAsked)).toEqual(["Mark", "Notify"]);
			expect(runNow().cost).toBe(0);
			expect(runNow().status).toBe("built");
			expect(runNow().review).toBeUndefined();
			expect(notices()).toContain("The second opinion was not asked for: the model is now openrouter/paid-model, which may cost money, and this build has no cost budget.");
			expect(notices().at(-1)).toBe("The build is ready to review. Nothing has been written.");
		});

		test("a build begun on a paid model, with its budget, is not stopped by this", async () => {
			await setUp({ models: [local, paid], model: PAID, budget: "9", reply: replies(() => false) });
			await startBuild(planPath);
			expect(questions).toEqual(["openrouter/paid-model may cost money. Stop the build at what cost?"]);
			expect(prompts.map(unitAsked)).toEqual(["Mark", "Notify", null]);
			expect(runNow().status).toBe("built");
		});

		test("nor is one left on its local model", async () => {
			await setUp({ models: [local, paid], reply: replies(() => false) });
			await startBuild(planPath);
			expect(questions).toEqual([]);
			expect(prompts.map(unitAsked)).toEqual(["Mark", "Notify", null]);
			expect(runNow().status).toBe("built");
		});
	});

	// --- B7-6, B9-6 -----------------------------------------------------------------------------------------------

	describe("B7-6: a script changed while its review stood open", () => {
		test("typed in since: accepting writes nothing and records nothing, and the review opened again shows it", async () => {
			await setUp({ files: { [script]: OLD } });
			await openFile(script);
			await startBuild(planPath);
			const open = await openTheReview();
			expect(open.original).toBe(OLD);
			// While the review stands open, a procedure is typed into the script.
			applyText(script, OLD + TYPED);
			flush();
			expect(await refused(open)).toBe("src/Release.ssl has changed since this review was opened, so nothing was written. Reject this review and open it again: it then shows the build against the script as it is now");
			// It used to hold the build, and not what was typed.
			expect(bufferOf(script)).toBe(OLD + TYPED);
			expect(runNow().accepted).toEqual([]);
			expect(toReview()).toEqual(["src/Release.ssl"]);
			expect(recordNow()).toBeNull();
			expect(notices().some((text) => text.startsWith("Applied to"))).toBe(false);
			// Opened again, it is the build against the script as it is now, and accepting keeps what was typed.
			const again = await openTheReview();
			expect(again.original).toBe(OLD + TYPED);
			expect(again.proposed).toContain(TYPED);
			await accept(again);
			expect(bufferOf(script)).toBe(again.proposed);
			for (const part of [":PROCEDURE Old;", ":PROCEDURE TypedMeanwhile;", ":PROCEDURE Mark;", ":PROCEDURE Notify;"]) expect(bufferOf(script)).toContain(part);
			expect(runNow().accepted).toEqual(["src/Release.ssl"]);
			expect(recordNow()?.units.map((u) => u.name)).toEqual(["Mark", "Notify"]);
			expect(notices().at(-1)).toBe("Applied to src/Release.ssl. Review and save it; undo reverts it.");
		});

		test("changed on disk, and not open in the editor: the same", async () => {
			await setUp({ files: { [script]: OLD } });
			await startBuild(planPath);
			const open = await openTheReview();
			disk.set(script, OLD + TYPED);
			expect(await refused(open)).toContain("src/Release.ssl has changed since this review was opened, so nothing was written");
			expect(disk.get(script)).toBe(OLD + TYPED);
			expect(runNow().accepted).toEqual([]);
			expect(recordNow()).toBeNull();
		});

		test("a script that was not there when the review opened, and is there now, is not written over", async () => {
			await setUp();
			await startBuild(planPath);
			const open = await openTheReview();
			expect(open.acceptLabel).toBe("Accept and create the file");
			disk.set(script, TYPED);
			expect(await refused(open)).toContain("src/Release.ssl has changed since this review was opened, so nothing was written");
			expect(disk.get(script)).toBe(TYPED);
			expect(runNow().accepted).toEqual([]);
			expect(recordNow()).toBeNull();
		});

		test("line endings alone are not a change: a script that reads the same is accepted into", async () => {
			await setUp({ files: { [script]: OLD.replace(/\n/g, "\r\n") } });
			await startBuild(planPath);
			const open = await openTheReview();
			await accept(open);
			expect(bufferOf(script)).toContain(":PROCEDURE Mark;");
			expect(runNow().accepted).toEqual(["src/Release.ssl"]);
		});

		test("B9-6: a script that is there and cannot be opened is not reported as applied to, nor recorded as accepted", async () => {
			// It is in the folder, and every read of it is refused: to the build and its review it is not there.
			await setUp({ files: { [script]: OLD }, unreadable: [script] });
			await startBuild(planPath);
			const open = await openTheReview();
			expect(open.acceptLabel).toBe("Accept and create the file");
			expect(await refused(open)).toBe("src/Release.ssl is there, and could not be read, so nothing was written");
			expect(disk.get(script)).toBe(OLD);
			// It used to say "Applied to src/Release.ssl", mark the script accepted, and record the plan as built.
			expect(notices().some((text) => text.startsWith("Applied to") || text.startsWith("Created"))).toBe(false);
			expect(runNow().accepted).toEqual([]);
			expect(toReview()).toEqual(["src/Release.ssl"]);
			expect(recordNow()).toBeNull();
		});

		test("B9-6: nor one that reads as it did, and then cannot be opened in the editor", async () => {
			await setUp({ files: { [script]: OLD } });
			await startBuild(planPath);
			const open = await openTheReview();
			// One more read is answered, which is the look at whether it has changed: the editor's own is refused.
			readsLeft.set(script, 1);
			expect(await refused(open)).toBe("src/Release.ssl could not be opened, so nothing was written");
			expect(documents.has(script)).toBe(false);
			expect(disk.get(script)).toBe(OLD);
			expect(notices().some((text) => text.startsWith("Applied to"))).toBe(false);
			expect(runNow().accepted).toEqual([]);
			expect(recordNow()).toBeNull();
		});
	});

	// --- B7-7 -----------------------------------------------------------------------------------------------------

	describe("B7-7: an accepted script that no longer holds what was accepted", () => {
		/** Built, reviewed and accepted into a script that was there: what the script then holds. */
		async function acceptedInto(before = OLD) {
			await startBuild(planPath);
			const open = await openTheReview();
			expect(open.original).toBe(before);
			await accept(open);
			expect(runNow().accepted).toEqual(["src/Release.ssl"]);
			expect(toReview()).toEqual([]);
			return open.proposed;
		}

		test("undone in the editor: it is offered for review again when the assistant comes up, and can be accepted again", async () => {
			await setUp({ files: { [script]: OLD } });
			await acceptedInto();
			// Ctrl+Z in the script: it reads as it did before.
			applyText(script, OLD);
			flush();
			// What the assistant does each time it comes up.
			await loadRun(planPath);
			expect(toReview()).toEqual(["src/Release.ssl"]);
			expect(runNow().accepted).toEqual([]);
			expect(notices().at(-1)).toBe("src/Release.ssl no longer holds what was accepted: the change was undone, or closed without saving. It is offered for review again.");
			const again = await openTheReview();
			expect(again.original).toBe(OLD);
			expect(count(again.proposed, ":PROCEDURE Mark;")).toBe(1);
			await accept(again);
			expect(bufferOf(script)).toBe(again.proposed);
			expect(toReview()).toEqual([]);
			expect(runNow().accepted).toEqual(["src/Release.ssl"]);
		});

		test("closed without saving, with other unsaved typing in it: the same", async () => {
			await setUp({ files: { [script]: OLD } });
			await openFile(script);
			applyText(script, OLD + TYPED);
			flush();
			await acceptedInto(OLD + TYPED);
			expect(await closeTab(script, undefined, { discard: true })).toBe(true);
			flush();
			expect(documents.has(script)).toBe(false);
			await loadRun(planPath);
			expect(toReview()).toEqual(["src/Release.ssl"]);
			expect(runNow().accepted).toEqual([]);
		});

		test("Review itself looks first, so the undone script is among those reviewed", async () => {
			await setUp({ files: { [script]: OLD } });
			await acceptedInto();
			applyText(script, OLD);
			flush();
			const again = await openTheReview();
			expect(again?.title).toBe("Build: src/Release.ssl");
			putAside(again);
		});

		test("worked on by hand after it was accepted, it stays accepted", async () => {
			await setUp({ files: { [script]: OLD } });
			const accepted = await acceptedInto();
			applyText(script, accepted.replace(":PROCEDURE Mark;", ":PROCEDURE Mark;\n\t/* checked by hand;"));
			flush();
			await loadRun(planPath);
			expect(toReview()).toEqual([]);
			expect(runNow().accepted).toEqual(["src/Release.ssl"]);
		});

		test("the next start does not record it as built: the build's file says what the script read as before", async () => {
			await setUp({ files: { [script]: OLD } });
			await acceptedInto();
			await aMoment();
			expect(disk.has(runFile(planPath, "/ws"))).toBe(true);
			// Undone, and the plan closed without saving its record of the build. Then the app is started again.
			applyText(script, OLD);
			savePlan(planPath, releasePlan());
			updateAssist(planPath, { run: null });
			flush();
			expect(recordNow()).toBeNull();
			await loadRun(planPath);
			expect(unitsNow()).toEqual([
				["Mark", "passed"],
				["Notify", "passed"],
			]);
			// It used to be recorded as built again here, with nothing of it in the script.
			expect(recordNow()).toBeNull();
			expect(toReview()).toEqual(["src/Release.ssl"]);
		});

		test("still holding it at the next start, it is recorded as before", async () => {
			await setUp({ files: { [script]: OLD } });
			await acceptedInto();
			await aMoment();
			savePlan(planPath, releasePlan());
			updateAssist(planPath, { run: null });
			flush();
			await loadRun(planPath);
			expect(recordNow()?.units.map((u) => u.name)).toEqual(["Mark", "Notify"]);
			expect(toReview()).toEqual([]);
		});
	});

	// --- a unit that passes after its script was accepted ---------------------------------------------------------

	describe("a unit that passes after its script was accepted", () => {
		test("is offered for review, reaches the script, and is recorded as built only then", async () => {
			const plan = await setUp();
			const stopped = finishedRun(plan, { status: "stopped" });
			Object.assign(stopped.units[1]!, { status: "stuck", attempts: 3, code: undefined, problems: ["It does not define the procedure Notify."] });
			updateAssist(planPath, { run: stopped });
			flush();
			const first = await openTheReview();
			expect(first.proposed).not.toContain(":PROCEDURE Notify;");
			await accept(first);
			expect(disk.get(script)).toBe(first.proposed);
			expect(runNow().accepted).toEqual(["src/Release.ssl"]);
			expect(toReview()).toEqual([]);
			expect(recordNow()?.units.map((u) => u.name)).toEqual(["Mark"]);
			// "Try again" on the stuck unit, and "Carry on building": it passes.
			retryUnit(planPath, "Notify");
			flush();
			await startBuild(planPath);
			expect(unitsNow()).toEqual([
				["Mark", "passed"],
				["Notify", "passed"],
			]);
			// It used to be: nothing to review, and Notify never reached the file.
			expect(toReview()).toEqual(["src/Release.ssl"]);
			expect(runNow().accepted).toEqual([]);
			// Nor is it recorded as built at the next start, as it used to be.
			await aMoment();
			updateAssist(planPath, { run: null });
			flush();
			await loadRun(planPath);
			expect(recordNow()?.units.map((u) => u.name)).toEqual(["Mark"]);
			expect(toReview()).toEqual(["src/Release.ssl"]);
			// The review is of what the script has not been given: Mark is in it already, and is not put in twice.
			const second = await openTheReview();
			expect(second.title).toBe("Build: src/Release.ssl");
			expect(second.original).toBe(first.proposed);
			expect(count(second.proposed, ":PROCEDURE Mark;")).toBe(1);
			expect(second.proposed).toContain(":PROCEDURE Notify;");
			await accept(second);
			expect(bufferOf(script)).toBe(second.proposed);
			expect(recordNow()?.units.map((u) => u.name)).toEqual(["Mark", "Notify"]);
			expect(toReview()).toEqual([]);
			expect(runNow().accepted).toEqual(["src/Release.ssl"]);
		});

		test("the second accepting undone takes back the later unit alone; both undone, both", async () => {
			const plan = await setUp({ files: { [script]: OLD } });
			const stopped = finishedRun(plan, { status: "stopped" });
			Object.assign(stopped.units[1]!, { status: "stuck", attempts: 3, code: undefined, problems: ["It does not define the procedure Notify."] });
			updateAssist(planPath, { run: stopped });
			flush();
			const first = await openTheReview();
			await accept(first);
			retryUnit(planPath, "Notify");
			flush();
			await startBuild(planPath);
			const second = await openTheReview();
			await accept(second);
			expect(toReview()).toEqual([]);
			// One undo: the script reads as it did after the first accepting.
			applyText(script, first.proposed);
			flush();
			await loadRun(planPath);
			const waiting = () => build.unitsToReview(runNow(), planNow()).map((u) => u.name);
			expect(waiting()).toEqual(["Notify"]);
			// Accepted again, and then undone twice: the script reads as it did before either.
			await accept(await openTheReview());
			expect(waiting()).toEqual([]);
			applyText(script, OLD);
			flush();
			await loadRun(planPath);
			expect(waiting()).toEqual(["Mark", "Notify"]);
		});
	});

	// --- a review is of one run and one target --------------------------------------------------------------------

	describe("a review is of one run and one target script", () => {
		test("the target script changed while the review stood open: the old target is not written, and the review opened again is of the new one", async () => {
			await setUp({ units: noScripts });
			await startBuild(planPath);
			const open = await openTheReview();
			expect(open.title).toBe("Build: src/Release.ssl");
			// Target scripts are not part of what makes a build out of date: the run is still of this chart.
			savePlan(planPath, { ...planNow(), targets: ["src/Other.ssl"] });
			flush();
			expect(await refused(open)).toBe("the plan now puts Mark in src/Other.ssl, not in src/Release.ssl, so nothing was written. Reject this review and open it again");
			// It used to write src/Release.ssl, mark it accepted, and record nothing.
			expect([...disk.keys()].filter((path) => path.endsWith(".ssl"))).toEqual([]);
			expect(runNow().accepted).toEqual([]);
			expect(recordNow()).toBeNull();
			const again = await openTheReview();
			expect(again.title).toBe("Build: src/Other.ssl");
			await accept(again);
			expect([...disk.keys()].filter((path) => path.endsWith(".ssl"))).toEqual(["/ws/src/Other.ssl"]);
			expect(recordNow()?.units.map((u) => [u.name, u.script])).toEqual([
				["Mark", "src/Other.ssl"],
				["Notify", "src/Other.ssl"],
			]);
			expect(runNow().accepted).toEqual(["src/Other.ssl"]);
			expect(toReview()).toEqual([]);
		});

		test("a new build begun while an old review stood open is not marked as accepted by it", async () => {
			const plan = await setUp();
			await startBuild(planPath);
			const old = await openTheReview();
			// The build is discarded and a new one begun: nothing of it is built yet.
			discardRun(planPath);
			updateAssist(planPath, { run: build.newRun({ hash: planHash(plan), model: "ollama/qwen3", prints: built.nodePrints(plan) }, oneScript, ends) });
			flush();
			expect(await refused(old)).toBe("the build has changed since this review was opened, so nothing was written. Reject this review and open it again");
			expect(disk.has(script)).toBe(false);
			expect(runNow().accepted).toEqual([]);
			expect(unitsNow()).toEqual([
				["Mark", "pending"],
				["Notify", "pending"],
			]);
			expect(recordNow()).toBeNull();
		});

		test("a build discarded while its review stood open: nothing is written", async () => {
			await setUp();
			await startBuild(planPath);
			const old = await openTheReview();
			discardRun(planPath);
			flush();
			expect(await refused(old)).toBe("the build this review was of has been discarded, so nothing was written");
			expect(disk.has(script)).toBe(false);
			expect(notices().some((text) => text.startsWith("Created"))).toBe(false);
		});

		test("rejecting an old review sends nothing of the new build back to the agent, and asks nothing", async () => {
			const plan = await setUp();
			await startBuild(planPath);
			const old = await openTheReview();
			// A new build, whose units have passed with other code than the old review shows.
			const fresh = finishedRun(plan);
			for (const unit of fresh.units) unit.code = `:PROCEDURE ${unit.name};\n\tDoProc("Audit", {"${unit.name}"});\n:ENDPROC;`;
			discardRun(planPath);
			updateAssist(planPath, { run: fresh });
			flush();
			askHandler = (prompt) => {
				questions.push(prompt);
				return "It marks the wrong sample.";
			};
			await old.onReject!();
			flush();
			expect(questions).toEqual([]);
			expect(unitsNow()).toEqual([
				["Mark", "passed"],
				["Notify", "passed"],
			]);
			expect(runNow().units.every((u) => u.feedback === undefined && u.code?.includes("Audit"))).toBe(true);
			putAside(old);
		});

		test("rejecting the review of the build as it stands still sends its units back, with the reason", async () => {
			await setUp();
			await startBuild(planPath);
			const open = await openTheReview();
			askHandler = (prompt) => {
				questions.push(prompt);
				return "It marks the wrong sample.";
			};
			await open.onReject!();
			flush();
			expect(questions).toEqual(["What is wrong with src/Release.ssl? It goes back to the agent with your reason. Empty keeps it for later."]);
			expect(unitsNow()).toEqual([
				["Mark", "pending"],
				["Notify", "pending"],
			]);
			expect(runNow().units.map((u) => u.feedback)).toEqual(["It marks the wrong sample.", "It marks the wrong sample."]);
			putAside(open);
		});
	});

	// --- B7-11 ----------------------------------------------------------------------------------------------------

	describe("B7-11: a build's file that is damaged, or from an earlier version", () => {
		test("with no budget at all it is taken up with the default token budget, and the build can be carried on", async () => {
			const { budget: _budget, tokens: _tokens, cost: _cost, ...bare } = waitingRun(releasePlan());
			await setUp({ runFileText: JSON.stringify(bare) });
			await loadRun(planPath);
			expect(runNow().budget).toEqual({ tokens: build.DEFAULT_TOKEN_BUDGET });
			expect([runNow().tokens, runNow().cost]).toEqual([0, 0]);
			await startBuild(planPath);
			// It used to end here with "undefined is not an object (evaluating 'run.budget.cost')".
			flush();
			expect(state.messages.filter((m) => m.kind === "error")).toEqual([]);
			expect(prompts.map(unitAsked)).toEqual(["Mark", "Notify", null]);
			expect(runNow().status).toBe("built");
		});

		test("a budget of {} is not 'no token limit': the build stops at the default one, and asks", async () => {
			await setUp({ runFileText: JSON.stringify(waitingRun(releasePlan(), { budget: {}, tokens: 500_000 })) });
			await loadRun(planPath);
			expect(runNow().budget).toEqual({ tokens: build.DEFAULT_TOKEN_BUDGET });
			await startBuild(planPath);
			const n = (count: number) => count.toLocaleString();
			expect(questions).toEqual([`The build has used ${n(500_000)} tokens, and its budget was ${n(400_000)}. Carry on for up to ${n(400_000)} more?`]);
			// Unanswered, nothing is asked of the model. It used to build on, with no limit.
			expect(prompts).toEqual([]);
		});

		test("a cost budget that does not read as a number is no cost budget: a paid model is asked about before anything is spent", async () => {
			await setUp({ models: [local, paid], model: PAID, runFileText: JSON.stringify(waitingRun(releasePlan(), { model: PAID, budget: { cost: "plenty", tokens: 400_000 } })) });
			await loadRun(planPath);
			expect(runNow().budget).toEqual({ tokens: 400_000 });
			await startBuild(planPath);
			expect(questions).toEqual(["openrouter/paid-model may cost money. Stop the build at what cost?"]);
			expect(prompts).toEqual([]);
		});

		test("a file that is not a build's is refused once, in plain words that name it; a discarded build's file says nothing", async () => {
			await setUp({ runFileText: "null" });
			await loadRun(planPath);
			expect(latestAssistOf(planPath).run ?? null).toBeNull();
			expect(notices()).toEqual([]);
			runFileText = '{ "units": 5, "note": "not a build" }';
			await loadRun(planPath);
			expect(latestAssistOf(planPath).run ?? null).toBeNull();
			const name = runFile(planPath, "/ws").slice("/ws/".length);
			expect(name.startsWith(".ssl-studio/plans/Release-")).toBe(true);
			expect(notices()).toEqual([`The build's saved progress in ${name} could not be read, so it was not taken up. A new build starts afresh.`]);
			// Said once, not every time the plan's assistant comes up.
			setState((s) => {
				s.messages = [];
			});
			await loadRun(planPath);
			expect(notices()).toEqual([]);
		});
	});

	// --- B7-12 ----------------------------------------------------------------------------------------------------

	describe("B7-12: what is not known to be a local model is not called one", () => {
		const LABEL = "A draft from a local model";
		/** Whether a build's review calls it a local model's draft, for a build on `model` with opencode listing `models`. */
		async function buildReviewSaysLocal(model: string, models: unknown[]) {
			const plan = await setUp();
			setAgent((s) => {
				s.models = models as any;
			});
			updateAssist(planPath, { run: finishedRun(plan, { model }) });
			flush();
			const open = await openTheReview();
			const says = open.checks!.some((check) => check.label === LABEL);
			putAside(open);
			return says;
		}

		test("a build's review: a model opencode does not list is not called local", async () => {
			expect(await buildReviewSaysLocal("openrouter/not-listed", [local, paid])).toBe(false);
		});
		test("nor one it lists as not local, nor one it has not listed yet because it has not started", async () => {
			expect(await buildReviewSaysLocal(PAID, [local, paid])).toBe(false);
			expect(await buildReviewSaysLocal(PAID, [])).toBe(false);
		});
		test("a model it lists as local is, and so is a local provider's before the list is there", async () => {
			expect(await buildReviewSaysLocal("ollama/qwen3", [local, paid])).toBe(true);
			expect(await buildReviewSaysLocal("ollama/qwen3", [])).toBe(true);
		});
	});

	// --- the test script: the twin of B7-6, B9-6 and B7-12 --------------------------------------------------------

	describe("the test script's review", () => {
		const CODE = `${codeOf("Mark")}\n\n${codeOf("Notify")}\n`;
		const OLD_TESTS = "/* Tests for Release, written by hand;\n:PROCEDURE RunTests;\n:ENDPROC;\n";
		const NEW_TESTS = '/* Path 1: the sample is marked and the lab is told;\n:PROCEDURE RunTests;\n\tDoProc("Mark");\n:ENDPROC;';
		/** A plan whose build was accepted: its record says where the procedures are. */
		const builtPlan = () => built.recordBuilt(releasePlan(), finishedRun(releasePlan()).units, oneScript);
		/** "Write the tests" in the Assistant: the review that then stands open. */
		async function testsReview(opts: SetUp = {}) {
			await setUp({ plan: builtPlan(), files: { [script]: CODE, [testsFile]: OLD_TESTS }, reply: () => said(fence(NEW_TESTS)), ...opts });
			await writeTests(planPath);
			flush();
			const open = review()!;
			expect(open?.title).toBe("Tests: src/ReleaseTests.ssl");
			return open;
		}

		test("typed in while the review stood open: nothing is written, and the same tests are offered against it as it is now", async () => {
			const first = await testsReview();
			expect(first.original).toBe(OLD_TESTS);
			const turns = prompts.length;
			await openFile(testsFile);
			applyText(testsFile, OLD_TESTS + TYPED);
			flush();
			await accept(first);
			// It used to hold the agent's tests, and not what was typed.
			expect(bufferOf(testsFile)).toBe(OLD_TESTS + TYPED);
			expect(recordNow()?.tests).toBeUndefined();
			expect(notices().some((text) => text.startsWith("Wrote"))).toBe(false);
			expect(notices().at(-1)).toBe("src/ReleaseTests.ssl has changed since this review was opened, so nothing was written. The review now shows the tests against the script as it is.");
			// The tests are not asked for again: that would be another turn of the model.
			const second = review()!;
			expect(second).not.toBe(first);
			expect(second.original).toBe(OLD_TESTS + TYPED);
			expect(second.proposed).toBe(first.proposed);
			expect(prompts).toHaveLength(turns);
			await accept(second);
			expect(bufferOf(testsFile)).toBe(first.proposed);
			expect(recordNow()?.tests?.script).toBe("src/ReleaseTests.ssl");
			expect(notices().at(-1)).toBe("Wrote src/ReleaseTests.ssl. These tests have not been run: run them in STARLIMS.");
		});

		test("what was edited in the review is what is offered again", async () => {
			const first = await testsReview();
			disk.set(testsFile, OLD_TESTS + TYPED);
			const edited = first.proposed.replace("the lab is told", "the lab is told, by hand");
			await accept(first, edited);
			expect(disk.get(testsFile)).toBe(OLD_TESTS + TYPED);
			expect(review()!.proposed).toBe(edited);
			putAside(review()!);
		});

		test("B9-6: a test script that is there and cannot be opened is not reported as written, nor recorded in the plan", async () => {
			const open = await testsReview({ unreadable: [testsFile] });
			expect(open.acceptLabel).toBe("Accept and create the file");
			expect(await refused(open)).toBe("src/ReleaseTests.ssl is there, and could not be read, so nothing was written");
			expect(disk.get(testsFile)).toBe(OLD_TESTS);
			// It used to say "Wrote src/ReleaseTests.ssl", and record it in the plan as the tests of this chart.
			expect(notices().some((text) => text.startsWith("Wrote"))).toBe(false);
			expect(recordNow()?.tests).toBeUndefined();
		});

		test("B9-6: nor one that reads as it did, and then cannot be opened in the editor", async () => {
			const open = await testsReview();
			readsLeft.set(testsFile, 1);
			expect(await refused(open)).toBe("src/ReleaseTests.ssl could not be opened, so nothing was written");
			expect(disk.get(testsFile)).toBe(OLD_TESTS);
			expect(notices().some((text) => text.startsWith("Wrote"))).toBe(false);
			expect(recordNow()?.tests).toBeUndefined();
		});

		test("left alone, it is written and recorded as before", async () => {
			const open = await testsReview();
			await accept(open);
			expect(bufferOf(testsFile)).toBe(open.proposed);
			expect(recordNow()?.tests?.script).toBe("src/ReleaseTests.ssl");
		});

		test("B7-12: tests from a model opencode does not list are not called a local model's draft", async () => {
			const LABEL = "A draft from a local model";
			const unlisted = await testsReview({ models: [local, paid], model: "openrouter/not-listed" });
			expect(unlisted.checks!.some((check) => check.label === LABEL)).toBe(false);
			putAside(unlisted);
			const listed = await testsReview({ models: [local, paid] });
			expect(listed.checks!.some((check) => check.label === LABEL)).toBe(true);
			putAside(listed);
		});
	});
});

// --- the same, as pure logic ------------------------------------------------------------------------------------

describe("B7-2: whether a turn would go to a paid model with no cost budget", () => {
	const models = [local, paid];
	const none = { budget: { tokens: 400_000 } };
	test("a model that may cost money, and no cost budget", () => {
		expect(build.unbudgeted(none, models, PAID)).toBe(true);
		// One opencode does not list is not known to be free.
		expect(build.unbudgeted(none, models, "openrouter/not-listed")).toBe(true);
		expect(build.unbudgeted(none, [], PAID)).toBe(true);
	});
	test("not with a budget, a local model, one of the user's own, or no model chosen", () => {
		expect(build.unbudgeted({ budget: { tokens: 400_000, cost: 2 } }, models, PAID)).toBe(false);
		expect(build.unbudgeted(none, models, "ollama/qwen3")).toBe(false);
		expect(build.unbudgeted(none, [], "ollama/qwen3")).toBe(false);
		expect(build.unbudgeted(none, models, "acme/house", ["acme/house"])).toBe(false);
		expect(build.unbudgeted(none, models, "")).toBe(false);
	});
});

describe("B7-11: a build's file, made safe to carry on", () => {
	const sound = () => ({
		version: 1,
		planHash: "abc",
		model: "ollama/qwen3",
		status: "stopped",
		tokens: 1200,
		cost: 0.5,
		budget: { cost: 2, tokens: 900_000 },
		units: [{ name: "Mark", status: "pending", attempts: 0 }],
		map: [{ node: "n1", becomes: "entry" }],
		accepted: ["src/Release.ssl"],
	});
	test("a sound one is taken as it is", () => {
		expect(build.mendRun(sound())).toEqual(sound() as unknown as BuildRun);
	});
	test("a missing token budget is the default one, never no limit", () => {
		for (const budget of [undefined, null, {}, { tokens: "many" }, { tokens: 0 }, { tokens: -5 }, { tokens: Number.NaN }, [], "none"]) {
			const run = build.mendRun({ ...sound(), budget })!;
			expect(run.budget.tokens).toBe(build.DEFAULT_TOKEN_BUDGET);
			// So a build that has used that much is over it, where it was never over anything.
			expect(build.overTokens({ ...run, tokens: build.DEFAULT_TOKEN_BUDGET })).toBe(true);
		}
	});
	test("a cost budget that does not read is no cost budget, which a paid model is asked about", () => {
		for (const cost of ["plenty", null, 0, -1, Number.POSITIVE_INFINITY, {}]) {
			const run = build.mendRun({ ...sound(), budget: { cost, tokens: 1000 } })!;
			expect(run.budget).toEqual({ tokens: 1000 });
			expect(build.unbudgeted(run, [paid], PAID)).toBe(true);
		}
		expect(build.mendRun(sound())!.budget.cost).toBe(2);
	});
	test("what was spent, the model and the state are what they can be read as", () => {
		const run = build.mendRun({ ...sound(), tokens: "1200", cost: undefined, model: 7, status: "paused" })!;
		expect([run.tokens, run.cost, run.model, run.status]).toEqual([0, 0, "", "stopped"]);
	});
	test("entries that are not units, steps or script names are left out", () => {
		const run = build.mendRun({ ...sound(), units: [null, 5, { status: "passed" }, { name: "Mark", status: "pending", attempts: 0 }], map: [null, { node: 3 }, { node: "n1", becomes: "entry" }], accepted: [1, "src/Release.ssl", null] })!;
		expect(run.units.map((u) => u.name)).toEqual(["Mark"]);
		expect(run.map).toEqual([{ node: "n1", becomes: "entry" }]);
		expect(run.accepted).toEqual(["src/Release.ssl"]);
	});
	test("what is not a build's file at all is refused", () => {
		for (const raw of [null, 5, "run", [], {}, { ...sound(), units: "none" }, { ...sound(), accepted: undefined }, { ...sound(), map: {} }]) expect(build.mendRun(raw)).toBeNull();
	});
});

describe("what a script has been given, and what a review is of", () => {
	const plan = releasePlan();
	const SCRIPT = "src/Release.ssl";
	const run = (more: Partial<BuildRun> = {}) => finishedRun(plan, more);
	const names = (units: readonly BuildUnit[]) => units.map((u) => u.name);

	test("a script is reviewed for each passed unit it has not been given", () => {
		const r = run();
		expect(names(build.unitsToReview(r, plan))).toEqual(["Mark", "Notify"]);
		build.giveTo(r, build.shownOf(SCRIPT, [r.units[0]!]), plan, []);
		expect(names(build.unitsToReview(r, plan))).toEqual(["Notify"]);
		// A script with a unit waiting is not among the accepted ones, accepted before or not.
		expect(r.accepted).toEqual([]);
		build.giveTo(r, build.shownOf(SCRIPT, [r.units[1]!]), plan, []);
		expect(build.unitsToReview(r, plan)).toEqual([]);
		expect(r.accepted).toEqual([SCRIPT]);
	});

	test("code that has changed since it was given is to be reviewed again, and so is the same code for another script", () => {
		const r = run();
		build.giveTo(r, build.shownOf(SCRIPT, r.units), plan, []);
		r.units[0]!.code = ":PROCEDURE Mark;\n\t/* written again;\n:ENDPROC;";
		expect(names(build.unitsToReview(r, plan))).toEqual(["Mark"]);
		const moved = { ...plan, targets: ["src/Other.ssl"] };
		const bare = run({ units: run().units.map(({ script: _script, ...unit }) => unit) as BuildUnit[] });
		build.giveTo(bare, build.shownOf(SCRIPT, bare.units), plan, []);
		expect(build.unitsToReview(bare, plan)).toEqual([]);
		expect(names(build.unitsToReview(bare, moved))).toEqual(["Mark", "Notify"]);
	});

	test("a run saved before units were marked: the passed units of its accepted scripts are taken as given, once", () => {
		const old = run({ accepted: [SCRIPT] });
		build.givenFromAccepted(old, plan);
		expect(build.unitsToReview(old, plan)).toEqual([]);
		// A run that marks its units is left as it is: a unit that passed after the accepting waits.
		const marked = run();
		build.giveTo(marked, build.shownOf(SCRIPT, [marked.units[0]!]), plan, []);
		marked.accepted = [SCRIPT];
		build.givenFromAccepted(marked, plan);
		expect(names(build.unitsToReview(marked, plan))).toEqual(["Notify"]);
	});

	test("a review is stale when the build, or the target, is no longer what it shows", () => {
		const r = run();
		const shown = build.shownOf(SCRIPT, r.units);
		expect(build.reviewStale(shown, r, plan)).toBeNull();
		expect(build.reviewStale(shown, null, plan)).toContain("has been discarded");
		const rebuilt = run();
		rebuilt.units[1]!.code = ":PROCEDURE Notify;\n\t/* another build's;\n:ENDPROC;";
		expect(build.reviewStale(shown, rebuilt, plan)).toContain("the build has changed since this review was opened");
		const waiting = run();
		waiting.units[0]!.status = "pending";
		expect(build.reviewStale(shown, waiting, plan)).toContain("the build has changed since this review was opened");
		const given = run();
		build.giveTo(given, shown, plan, []);
		expect(build.reviewStale(shown, given, plan)).toContain("the build has changed since this review was opened");
		const bare = run({ units: run().units.map(({ script: _script, ...unit }) => unit) as BuildUnit[] });
		expect(build.reviewStale(build.shownOf(SCRIPT, bare.units), bare, { ...plan, targets: ["src/Other.ssl"] })).toContain("the plan now puts Mark in src/Other.ssl, not in src/Release.ssl");
	});

	test("a script reads as it did before: the units accepted into it since are taken back, and no others", () => {
		const r = run();
		const [before, between] = [build.textPrint("before\n"), build.textPrint("before\nMark\n")];
		build.giveTo(r, build.shownOf(SCRIPT, [r.units[0]!]), plan, [before]);
		build.giveTo(r, build.shownOf(SCRIPT, [r.units[1]!]), plan, [between]);
		expect(r.units.map((u) => u.was)).toEqual([[before], [between, before]]);
		// Line endings aside, and a file that is gone says nothing.
		expect(build.takenBack(r.units[1]!.was, "before\r\nMark\r\n")).toBe(true);
		expect(build.takenBack(r.units[0]!.was, "before\nMark\n")).toBe(false);
		expect(build.takenBack(r.units[0]!.was, null)).toBe(false);
		expect(build.takenBack(undefined, "before\n")).toBe(false);
		build.takeBack(r, new Set([r.units[1]!.given!]), plan);
		expect(names(build.unitsToReview(r, plan))).toEqual(["Notify"]);
		expect(r.accepted).toEqual([]);
		expect(r.units[1]!.was).toBeUndefined();
	});

	test("two readings of a script: the same text whatever its line endings, and no file is not an empty file", () => {
		expect(build.sameText("a\r\nb\r\n", "a\nb\n")).toBe(true);
		expect(build.sameText("a\nb\n", "a\nb \n")).toBe(false);
		expect(build.sameText(null, null)).toBe(true);
		expect(build.sameText(null, "")).toBe(false);
	});
});

// --- B7-10 ------------------------------------------------------------------------------------------------------

describe("B7-10: an edit of one test case leaves every other entry as it was read", () => {
	/** Two entries this version cannot make sense of, around a case it can. */
	const ODD = [
		{ id: 5, title: "a numeric id", given: "from a later version" },
		{ title: "no id at all", expect: "kept" },
		{ id: "t7" },
	];
	const read = (tests: unknown[]) =>
		parsePlan(
			JSON.stringify({
				version: 1,
				title: "Release",
				groups: [],
				nodes: [
					{ id: "n1", kind: "start", text: "Start" },
					{ id: "n2", kind: "step", text: "Mark the sample" },
					{ id: "n3", kind: "end", text: "Done" },
				],
				edges: [
					{ from: "n1", to: "n2" },
					{ from: "n2", to: "n3" },
				],
				tests,
			}),
		).plan!;
	const CASE = { id: "t1", title: "A released sample is marked", node: "n2" };
	const plan = () => read([ODD[0], ODD[1], CASE, ODD[2]]);
	const entries = (p: Plan) => p.tests as unknown[];
	/** As the plan's text has it once the edit is saved and read again. */
	const saved = (p: Plan) => entries(parsePlan(printPlan(p)).plan!);

	test("the plan reads with the entries it cannot use, and shows the one case", () => {
		expect(entries(plan())).toEqual([ODD[0], ODD[1], CASE, ODD[2]]);
		expect(planTestsOf(plan()).map((t) => t.id)).toEqual(["t1"]);
	});

	test("adding a case keeps them, and does not take an id one of them has", () => {
		const next = addPlanTest(plan(), { title: "A sample on hold is not marked" });
		// It used to be the one case and the new one: the three others were gone from the plan's text.
		expect(entries(next)).toEqual([ODD[0], ODD[1], CASE, ODD[2], { id: "t8", title: "A sample on hold is not marked" }]);
		expect(saved(next)).toEqual(entries(next));
	});

	test("editing a case changes that case alone", () => {
		const next = updatePlanTest(plan(), "t1", { title: "A released sample is marked as released", expect: "Status is Released" });
		expect(entries(next)).toEqual([ODD[0], ODD[1], { id: "t1", title: "A released sample is marked as released", node: "n2", expect: "Status is Released" }, ODD[2]]);
		expect(saved(next)).toEqual(entries(next));
	});

	test("removing a case removes that case alone, and the list stays while it holds anything", () => {
		const next = removePlanTest(plan(), "t1");
		expect(entries(next)).toEqual(ODD);
		expect(saved(next)).toEqual(ODD);
		// An entry that is not a case is not one that can be removed by its id.
		expect(removePlanTest(next, "t7")).toBe(next);
		// With cases only, the last one removed takes the list with it, as before.
		expect("tests" in removePlanTest(read([CASE]), "t1")).toBe(false);
	});

	test("removing a step keeps its cases as cases of the plan, and the other entries as they were", () => {
		const next = removeNode(plan(), "n2").plan;
		expect(entries(next)).toEqual([ODD[0], ODD[1], { id: "t1", title: "A released sample is marked" }, ODD[2]]);
	});

	test("with nothing odd in the list, the three edits do what they did", () => {
		const two = read([CASE, { id: "t2", title: "A sample on hold is not marked" }]);
		expect(entries(addPlanTest(two, { title: "Third", given: " a sample " })).at(-1)).toEqual({ id: "t3", title: "Third", given: "a sample" });
		expect(entries(updatePlanTest(two, "t2", { node: "n2" }))).toEqual([CASE, { id: "t2", title: "A sample on hold is not marked", node: "n2" }]);
		expect(entries(removePlanTest(two, "t1"))).toEqual([{ id: "t2", title: "A sample on hold is not marked" }]);
		expect(updatePlanTest(two, "t9", { title: "x" })).toBe(two);
	});
});
