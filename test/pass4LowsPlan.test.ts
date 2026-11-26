// Planning mode, pass 4, the low findings: the second opinion of a build (asked when what has passed has changed
// since it was last asked, and not otherwise), a turn that does not finish at the budget, a paste back into a plan
// whose stage has gone, and the "Target scripts" field typed in and not left.
// The build is run from "New build" to its end with opencode and the language server faked, as in
// solid2AuditCore.test.ts: no model is asked anything, every reply is written here. The paste is the plan's pure
// logic. The field is its own state, run under Solid's runtime with the app's real pending edits; that the
// drill-down's textarea is wired to it is read from the source in the last block, and proves no behaviour.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRoot, createSignal, flush } from "solid-js";
import { DEFAULT_SETTINGS } from "../src/shared/protocol";
import { copySteps, pasteSteps, planHash, printSpec } from "../src/view/plan/assist";
import type { BuildRun } from "../src/view/plan/build";
import { parsePlan, printPlan, setGroup, type Plan } from "../src/view/plan/model";

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
const { session } = await import("../src/view/lsp/session");
const { applyText, commitPendingEdits, documents, openFile, save, setState, state } = await import("../src/view/state");
const { resetRecentTabs } = await import("../src/view/recentTabs");
const { latestAssistOf, planOf, updateAssist } = await import("../src/view/plan/run");
const { answerUnit, discardRun, reviewBuild, startBuild, stopBuild } = await import("../src/view/plan/buildRun");
const { resetTidy } = await import("../src/view/agent/tidy");
const { setAgent } = await import("../src/view/agent/store");
const drilldown = await import("../src/view/plan/PlanCodeDrilldown");

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

// --- 1. the build: its second opinion, and a turn that does not finish -------------------------------------

describe("a build, with opencode faked", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

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
			{ id: "n4", kind: "step", text: "Write the log" },
			{ id: "n5", kind: "end", text: "Done" },
		],
		edges: [
			{ from: "n1", to: "n2" },
			{ from: "n2", to: "n3" },
			{ from: "n3", to: "n4" },
			{ from: "n4", to: "n5" },
		],
	});
	/** Three units, none calling another: one that is stuck does not hold the others back. */
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
			{ name: "Log", script: "src/Release.ssl", nodes: ["n4"], calls: [], status: "pending", attempts: 0 },
		],
		map: [
			{ node: "n1", becomes: "entry" },
			{ node: "n5", becomes: "exit" },
		],
		accepted: [],
	});
	const said = (text: string, cost = 0, outcome = "succeeded") => ({ sessionID: "s", text, outcome, tokens: { input: 5000, output: 10 }, cost, ...(outcome === "error" ? { error: "the provider gave no answer" } : {}) });
	const codeFor = (name: string, cost = 0) => said("```ssl\n:PROCEDURE " + name + ";\n:ENDPROC;\n```", cost);
	const asks = (question: string) => said(`<<<QUESTIONS\n[{"question":${JSON.stringify(question)}}]\n>>>QUESTIONS`);
	/** What a turn is asked to build, from its prompt; null for the second opinion. */
	const unitAsked = (prompt: string) => /^PLAN STAGE: build (\w+)/.exec(prompt)?.[1] ?? null;
	const proceduresIn = (text: string) => [...text.matchAll(/:PROCEDURE (\w+)/g)].map((m) => ({ name: m[1], kind: 11, children: [] }));

	const realSession = { analyze: session.analyze, scratchTree: session.scratchTree, scratchCalls: session.scratchCalls, formatText: session.formatText, workspaceSymbols: session.workspaceSymbols };
	let prompts: string[] = [];
	let questions: string[] = [];

	/** The plan with its approved doc on disk, a language server that answers, and an opencode that says what `reply` says. */
	async function setUp(opts: { models: unknown[]; model?: string; reply: (prompt: string) => unknown; analyze?: (text: string) => unknown; budget?: string | null }) {
		tidyUp();
		const plan = releasePlan();
		const run = waitingRun(plan);
		const disk = new Map<string, string>([
			[planPath, printPlan(plan)],
			["/ws/design/Release.plan.md", printSpec("The spec.", run.units.map(({ name, script, nodes, calls }) => ({ name, script, nodes, calls })), run.map, planHash(plan))],
		]);
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
			if (args[0] === "start") return { state: "ready" };
			if (args[0] === "models") return opts.models;
			if (args[0] === "skills") return [{ id: "ssl-new-procedure" }];
			if (args[0] === "ask") {
				const prompt = String((args[1] as { text: string }[])[0]!.text);
				prompts.push(prompt);
				return opts.reply(prompt);
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
			s.settings.agentModel = opts.model ?? "";
		});
		await openFile(planPath);
		flush();
		return { plan, run };
	}
	const runNow = () => latestAssistOf(planPath).run!;
	const unitsNow = () => (latestAssistOf(planPath).run?.units ?? []).map((u) => [u.name, u.status]);
	/** What a review of the build shows above its diff, as "Review" in the Assistant opens it. */
	const noteShown = async () => {
		await reviewBuild(planPath);
		flush();
		const open = review();
		const note = open?.note;
		if (open) {
			open.onReject = undefined;
			closeReview();
			flush();
		}
		return note;
	};

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

	// B7-4. The opinion is asked about what has passed, once: what came back does not change that.
	test("a finished build whose second opinion came back empty is not asked for it again on each click", async () => {
		await setUp({
			models: [local, paid],
			model: "openrouter/paid-model",
			budget: "100",
			reply: (prompt) => (unitAsked(prompt) ? codeFor(unitAsked(prompt)!, 0.5) : said("", 0.5)),
		});
		await startBuild(planPath);
		expect(prompts.map(unitAsked)).toEqual(["Mark", "Notify", "Log", null]);
		expect(runNow().status).toBe("built");
		expect(runNow().review).toBeUndefined();
		expect(runNow().cost).toBe(2);
		// "Carry on building" is still there on a finished build. Each click used to be one more turn, and its cost.
		await startBuild(planPath);
		await startBuild(planPath);
		expect(prompts.length).toBe(4);
		expect(runNow().cost).toBe(2);
		expect(runNow().status).toBe("built");
		expect(questions).toEqual(["openrouter/paid-model may cost money. Stop the build at what cost?"]);
	});

	test("nor one whose second opinion's turn failed", async () => {
		await setUp({
			models: [local, paid],
			model: "openrouter/paid-model",
			budget: "100",
			reply: (prompt) => (unitAsked(prompt) ? codeFor(unitAsked(prompt)!, 0.5) : said("", 0.5, "error")),
		});
		await startBuild(planPath);
		expect(prompts.length).toBe(4);
		expect(runNow().review).toBeUndefined();
		expect(state.messages.at(-2)?.text).toBe("The agent did not finish: the provider gave no answer");
		await startBuild(planPath);
		await startBuild(planPath);
		expect(prompts.length).toBe(4);
		expect(runNow().cost).toBe(2);
	});

	test("a build that finished without the opinion ever having been asked is asked for it, once", async () => {
		const { run } = await setUp({
			models: [local],
			model: "ollama/qwen3",
			reply: () => said("It does what the chart says."),
		});
		// The app was closed while the last unit's opinion was out: everything has passed, and nothing has read it.
		for (const unit of run.units) Object.assign(unit, { status: "passed", attempts: 1, code: `:PROCEDURE ${unit.name};\n:ENDPROC;` });
		updateAssist(planPath, { run });
		await startBuild(planPath);
		expect(prompts.map(unitAsked)).toEqual([null]);
		expect(runNow().review).toBe("It does what the chart says.");
		await startBuild(planPath);
		expect(prompts.length).toBe(1);
	});

	test("a second opinion you stopped is asked for again when the build is carried on, and then no more", async () => {
		let opinions = 0;
		await setUp({
			models: [local],
			model: "ollama/qwen3",
			reply: (prompt) => {
				if (unitAsked(prompt)) return codeFor(unitAsked(prompt)!);
				if (++opinions > 1) return said("It does what the chart says.");
				stopBuild(planPath);
				return said("", 0, "interrupted");
			},
		});
		await startBuild(planPath);
		expect(runNow().status).toBe("built");
		expect(runNow().review).toBeUndefined();
		await startBuild(planPath);
		expect(opinions).toBe(2);
		expect(runNow().review).toBe("It does what the chart says.");
		await startBuild(planPath);
		expect(opinions).toBe(2);
	});

	// B7-5. What passes after the opinion, in a call that then stops, is read before it is shown as read.
	test("a unit that passes after the second opinion, in a call that then stops, is read by the next opinion", async () => {
		let opinions = 0;
		let breakOn = "";
		await setUp({
			models: [local],
			model: "ollama/qwen3",
			reply: (prompt) => {
				const unit = unitAsked(prompt);
				if (!unit) return said(`Opinion ${++opinions}.`);
				// Notify and Log each need an answer first.
				return unit !== "Mark" && !prompt.includes("THE USER SAID") ? asks(`Which table does ${unit} write to?`) : codeFor(unit);
			},
			analyze: (text) => {
				if (breakOn && text.includes(`:PROCEDURE ${breakOn}`)) throw new Error("The language server is not running.");
				return { diagnostics: [], symbols: proceduresIn(text), timedOut: false };
			},
		});
		await startBuild(planPath);
		expect(runNow().status).toBe("built");
		expect(unitsNow()).toEqual([
			["Mark", "passed"],
			["Notify", "stuck"],
			["Log", "stuck"],
		]);
		// The first opinion read Mark, which is all there was.
		expect(runNow().review).toBe("Opinion 1.");
		expect(await noteShown()).toBe("A second opinion, which may be wrong:\n\nOpinion 1.");

		// Both are answered. Notify passes, and the call stops at Log: the language server has gone.
		answerUnit(planPath, "Notify", "SAMPLES");
		answerUnit(planPath, "Log", "AUDIT");
		breakOn = "Log";
		await startBuild(planPath);
		expect(runNow().status).toBe("stopped");
		expect(unitsNow()).toEqual([
			["Mark", "passed"],
			["Notify", "passed"],
			["Log", "stuck"],
		]);
		// "Review" is offered on a stopped build too. The opinion it has was written before Notify, and says so.
		expect(runNow().review).toBe("Opinion 1.");
		expect(await noteShown()).toBe("A second opinion from earlier in this build, which may be wrong. It has not read what was built since:\n\nOpinion 1.");

		// Carried on, there is nothing to build, and this call builds nothing: the opinion is asked all the same,
		// because Notify has passed since the last one. It used to stay "Opinion 1.", shown as the opinion on Notify.
		const turns = prompts.length;
		await startBuild(planPath);
		expect(runNow().status).toBe("built");
		expect(prompts.length).toBe(turns + 1);
		expect(unitAsked(prompts.at(-1)!)).toBeNull();
		expect(prompts.at(-1)).toContain(":PROCEDURE Notify;");
		expect(runNow().review).toBe("Opinion 2.");
		expect(await noteShown()).toBe("A second opinion, which may be wrong:\n\nOpinion 2.");

		// And one more click asks nothing: nothing has passed since.
		await startBuild(planPath);
		expect(prompts.length).toBe(turns + 1);
		expect(opinions).toBe(2);
	});

	test("a script sent back at review is read again once it is rebuilt, though its code comes back the same", async () => {
		let opinions = 0;
		await setUp({
			models: [local],
			model: "ollama/qwen3",
			reply: (prompt) => (unitAsked(prompt) ? codeFor(unitAsked(prompt)!) : said(`Opinion ${++opinions}.`)),
		});
		await startBuild(planPath);
		expect(runNow().review).toBe("Opinion 1.");
		await reviewBuild(planPath);
		flush();
		const open = review()!;
		const reject = open.onReject!;
		open.onReject = undefined;
		closeReview();
		flush();
		askHandler = () => "Mark must check the status first.";
		await reject();
		expect(runNow().review).toBeUndefined();
		expect(unitsNow().map(([, status]) => status)).toEqual(["pending", "pending", "pending"]);
		await startBuild(planPath);
		expect(runNow().status).toBe("built");
		expect(opinions).toBe(2);
		expect(runNow().review).toBe("Opinion 2.");
	});

	// B7-3. The budget is looked at before every turn, the one asked again after a turn that did not finish too.
	test("a turn that does not finish is not asked again once it has taken the build past its budget", async () => {
		await setUp({
			models: [local, paid],
			model: "openrouter/paid-model",
			budget: "1",
			reply: () => said("", 1.5, "tool-limit"),
		});
		await startBuild(planPath);
		// One turn, which cost 1.50 against a budget of 1. It used to be three, and 4.50.
		expect(prompts.length).toBe(1);
		expect(runNow().cost).toBe(1.5);
		expect(runNow().status).toBe("budget");
		// Mark has not had its tries: it waits, and is built when the build is carried on with more to spend.
		expect(unitsNow()).toEqual([
			["Mark", "pending"],
			["Notify", "pending"],
			["Log", "pending"],
		]);
		expect(state.messages.at(-1)?.text).toBe("The build reached its budget and has stopped. Carrying on spends more.");
	});

	test("within its budget it is asked again, and what the unfinished turn cost is counted", async () => {
		let turn = 0;
		await setUp({
			models: [local, paid],
			model: "openrouter/paid-model",
			budget: "100",
			reply: (prompt) => (++turn === 1 ? said("", 0.25, "tool-limit") : unitAsked(prompt) ? codeFor(unitAsked(prompt)!, 0.25) : said("It does what the chart says.", 0.25)),
		});
		await startBuild(planPath);
		expect(prompts.map(unitAsked)).toEqual(["Mark", "Mark", "Notify", "Log", null]);
		expect(runNow().cost).toBe(1.25);
		expect(runNow().units[0]).toMatchObject({ name: "Mark", status: "passed", attempts: 2 });
		expect(runNow().status).toBe("built");
	});
});

// --- 2. a paste back into the plan the steps were copied from ----------------------------------------------

describe("steps pasted back into their own plan after their stage has gone", () => {
	const A = "/ws/design/Intake.plan.json";
	const planOf = (rest: Record<string, unknown>): Plan => parsePlan(JSON.stringify({ version: 1, title: "A plan", groups: [], ...rest })).plan!;
	const stageOf = (plan: Plan, id: string) => plan.groups.find((g) => g.id === plan.nodes.find((n) => n.id === id)?.group)?.name ?? null;
	const intake = () =>
		planOf({
			groups: [{ id: "g1", name: "Validation" }],
			nodes: [
				{ id: "n1", kind: "start", text: "A sample arrives" },
				{ id: "n2", kind: "step", text: "Check the id", group: "g1", offset: { x: 120, y: -48 } },
				{ id: "n3", kind: "step", text: "Raise the invoice" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
			],
		});
	/** "Validation" loses its only step and goes; the next stage made, "Billing", takes the id it had. */
	const afterTheStageWent = () => setGroup(setGroup(intake(), "n2", ""), "n3", "Billing");

	test("the plan is as the finding has it: another stage holds the id the copied one had", () => {
		expect(afterTheStageWent().groups).toEqual([{ id: "g1", name: "Billing" }]);
	});

	test("they do not land in the stage that has taken its id", () => {
		copySteps(intake(), new Set(["n2"]), A);
		const pasted = pasteSteps(afterTheStageWent(), A)!;
		const [id] = pasted.pastedIds;
		expect(stageOf(pasted.plan, id!)).toBeNull();
		expect(pasted.plan.nodes.find((n) => n.id === id)!.group).toBeUndefined();
		// The stage that is there, and the step in it, are as they were.
		expect(pasted.plan.groups).toEqual([{ id: "g1", name: "Billing" }]);
		expect(stageOf(pasted.plan, "n3")).toBe("Billing");
	});

	test("they join a stage of the name they were copied from, where the plan has one again", () => {
		copySteps(intake(), new Set(["n2"]), A);
		// "Validation" is made again, for another step: it is a new stage, with the next id.
		const again = setGroup(afterTheStageWent(), "n1", "Validation");
		expect(again.groups).toEqual([
			{ id: "g1", name: "Billing" },
			{ id: "g2", name: "Validation" },
		]);
		const pasted = pasteSteps(again, A)!;
		expect(stageOf(pasted.plan, pasted.pastedIds[0]!)).toBe("Validation");
	});

	test("while the stage is still there they go into it, a little off the original, as before", () => {
		copySteps(intake(), new Set(["n2"]), A);
		const pasted = pasteSteps(intake(), A)!;
		const node = pasted.plan.nodes.find((n) => n.id === pasted.pastedIds[0])!;
		expect(node.group).toBe("g1");
		expect(stageOf(pasted.plan, node.id)).toBe("Validation");
		expect(node.offset).toEqual({ x: 156, y: -12 });
	});

	test("in their own plan they still stand a little off the original when the stage has gone", () => {
		copySteps(intake(), new Set(["n2"]), A);
		const pasted = pasteSteps(afterTheStageWent(), A)!;
		expect(pasted.plan.nodes.find((n) => n.id === pasted.pastedIds[0])!.offset).toEqual({ x: 156, y: -12 });
	});
});

// --- 3. the "Target scripts" field, typed in and not left --------------------------------------------------

describe('the "Target scripts" field typed in and not left', () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	/** The field as the drill-down builds it: the plan's target scripts in, the text for the plan out. */
	const mount = (first: string[] = ["src/Release.ssl"]) => {
		const handed: string[] = [];
		let setTargets!: (targets: string[]) => void;
		let field!: ReturnType<typeof drilldown.targetsField>;
		const dispose = createRoot((done) => {
			const [targets, set] = createSignal(first);
			setTargets = set;
			field = drilldown.targetsField({
				get targets() {
					return targets();
				},
				onSetTargets: (text) => void handed.push(text),
			});
			return done;
		});
		flush();
		return { field, handed, dispose, setTargets: (targets: string[]) => (setTargets(targets), flush()) };
	};

	test("shows the plan's scripts, and what is typed over them", () => {
		const { field, dispose } = mount(["src/Release.ssl", "src/Notify.ssl"]);
		expect(field.draft()).toBe("src/Release.ssl, src/Notify.ssl");
		field.type("src/Release.ssl, src/Notify.ssl, src/Log.ssl");
		flush();
		expect(field.draft()).toBe("src/Release.ssl, src/Notify.ssl, src/Log.ssl");
		field.revert();
		dispose();
	});

	test("a save asks it for its text first, once", () => {
		const { field, handed, dispose } = mount();
		field.type("src/Release.ssl, src/Notify.ssl");
		// What Ctrl+S, Save all, a close of the tab and the question about unsaved changes all begin with.
		commitPendingEdits();
		expect(handed).toEqual(["src/Release.ssl, src/Notify.ssl"]);
		commitPendingEdits();
		expect(handed.length).toBe(1);
		dispose();
	});

	test("so does a change of tab", () => {
		const { field, handed, dispose } = mount();
		setState((s) => {
			s.groups = [{ tabs: ["/ws/design/Release.plan.json", "/ws/src/Release.ssl"], active: "/ws/design/Release.plan.json" }];
		});
		field.type("src/Other.ssl");
		setState((s) => {
			s.groups[0]!.active = "/ws/src/Release.ssl";
		});
		expect(handed).toEqual(["src/Other.ssl"]);
		dispose();
	});

	test("taken away with the inspector while typed in, it hands its text over a moment later", async () => {
		const { field, handed, dispose } = mount();
		field.type("src/Other.ssl");
		dispose();
		// Not inside the update that takes it away: a write there is refused.
		expect(handed).toEqual([]);
		await Promise.resolve();
		expect(handed).toEqual(["src/Other.ssl"]);
		// It is no longer held: a save after it has gone asks it for nothing.
		commitPendingEdits();
		expect(handed.length).toBe(1);
	});

	test("left in the usual way, it hands its text over once", () => {
		const { field, handed, dispose } = mount();
		field.type("src/Other.ssl");
		field.commit("src/Other.ssl");
		expect(handed).toEqual(["src/Other.ssl"]);
		commitPendingEdits();
		expect(handed.length).toBe(1);
		dispose();
	});

	test("typed back to what the plan holds, there is nothing to hand over", async () => {
		const { field, handed, dispose } = mount();
		field.type("src/Release.sslx");
		field.type("src/Release.ssl");
		flush();
		expect(field.draft()).toBe("src/Release.ssl");
		field.commit("src/Release.ssl");
		commitPendingEdits();
		dispose();
		await Promise.resolve();
		expect(handed).toEqual([]);
	});

	test("with nothing typed, nothing is handed over", async () => {
		const { handed, dispose } = mount();
		commitPendingEdits();
		dispose();
		await Promise.resolve();
		expect(handed).toEqual([]);
	});

	test("a save writes the plan with the scripts typed, though the field was never left", async () => {
		const path = "/ws/design/Targets.plan.json";
		const plan: Plan = {
			version: 1,
			title: "Targets",
			groups: [],
			targets: ["src/Release.ssl"],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "end", text: "Done" },
			],
			edges: [{ from: "n1", to: "n2" }],
		};
		const disk = new Map<string, string>([[path, printPlan(plan)]]);
		rpcHandler = (method, args) => {
			if (method === "read") {
				if (!disk.has(String(args[0]))) throw new Error("ENOENT");
				return { text: disk.get(String(args[0]))!, mtime: 1, encoding: "utf-8" };
			}
			if (method === "write") {
				disk.set(String(args[0]), String(args[1]));
				return { mtime: 2 };
			}
			return null;
		};
		await openFile(path);
		flush();
		const targetsOnDisk = () => parsePlan(disk.get(path)!).plan!.targets;
		let field!: ReturnType<typeof drilldown.targetsField>;
		const dispose = createRoot((done) => {
			field = drilldown.targetsField({
				get targets() {
					return (planOf(path)?.targets ?? []) as string[];
				},
				// What the chart does with the field's text (PlanView's setTargets): the list, into the plan's text.
				onSetTargets: (text) => {
					const { targets: _old, ...rest } = planOf(path)!;
					const list = text.split(",").map((t) => t.trim()).filter(Boolean);
					applyText(path, printPlan((list.length ? { ...rest, targets: list } : rest) as Plan));
				},
			});
			return done;
		});
		flush();
		field.type("src/Release.ssl, src/Notify.ssl");
		expect(await save(path)).toBe(true);
		expect(targetsOnDisk()).toEqual(["src/Release.ssl", "src/Notify.ssl"]);
		dispose();
		for (const doc of [...documents.values()]) doc.model?.dispose?.();
		documents.clear();
	});
});

// --- what the drill-down does with the field -----------------------------------------------------------------

// The drill-down needs a DOM to be drawn, which this file does not set up. The field it calls is run above; this
// block only says that its textarea calls it, read from the source. It proves no behaviour: the steps to look at
// in the app are in the pass's report.
describe("the drill-down uses the field (read from the source: it cannot be drawn here)", () => {
	const src = readFileSync(join(import.meta.dir, "..", "src/view/plan/PlanCodeDrilldown.tsx"), "utf8");

	/** The lines of the source that hold `text`: a failure then shows the text looked for, not the whole file. */
	const linesWith = (text: string) => src.split("\n").filter((line) => line.includes(text)).length;

	test("the Target scripts textarea shows, types into and commits the pending field", () => {
		expect(linesWith("const scripts = targetsField({")).toBe(1);
		expect(linesWith("{ hold: holdsPendingEdit },")).toBe(1);
		expect(linesWith("value={scripts.draft()}")).toBe(1);
		expect(linesWith("scripts.type(e.currentTarget.value);")).toBe(1);
		// On the change event, and on a blur that came with none.
		expect(linesWith("scripts.commit(el.value);")).toBe(1);
		expect(linesWith("scripts.commit(e.currentTarget.value);")).toBe(1);
		// It is no longer a plain draft, given to the plan only by the change event.
		expect(linesWith("createDraft(")).toBe(0);
		expect(linesWith("props.onSetTargets(el.value)")).toBe(0);
	});
});
