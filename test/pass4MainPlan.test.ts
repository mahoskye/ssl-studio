// Planning mode, pass 4, a medium finding (B7-1): what a plan records as built when a build is accepted.
// The record is of the plan the build was begun from, which the run keeps as one print for each node. It used to be
// taken from the chart as it stood at the moment of accepting: a step whose words were changed between the build
// and the accepting was recorded as built in its new words, nothing said that it had changed, and "Rebuild what
// changed" left it alone.
// The build is run from "New build" to its end, then reviewed and accepted, with opencode and the language server
// faked as in pass4LowsPlan.test.ts: no model is asked anything, every reply is written here. The second block is
// the record's pure logic.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { flush } from "solid-js";
import { DEFAULT_SETTINGS } from "../src/shared/protocol";
import { planHash, planHashMatches, printSpec } from "../src/view/plan/assist";
import { newRun, type BuildRun, type BuildUnit } from "../src/view/plan/build";
import * as built from "../src/view/plan/built";
import { printPlan, setText, type Plan } from "../src/view/plan/model";

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
const { documents, openFile, setState, state } = await import("../src/view/state");
const { resetRecentTabs } = await import("../src/view/recentTabs");
const { latestAssistOf, planOf, savePlan, updateAssist } = await import("../src/view/plan/run");
const { discardRun, loadRun, reviewBuild, runFile, startBuild } = await import("../src/view/plan/buildRun");
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

// --- 1. a build, reviewed and accepted after the chart was changed ------------------------------------------

describe("accepting a build after the chart was changed", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	const planPath = "/ws/design/Release.plan.json";
	const specFile = "/ws/design/Release.plan.md";
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
	type Unit = { name: string; script: string; nodes: string[]; calls: string[] };
	const oneScript: Unit[] = [
		{ name: "Mark", script: "src/Release.ssl", nodes: ["n2"], calls: [] },
		{ name: "Notify", script: "src/Release.ssl", nodes: ["n3"], calls: [] },
	];
	const twoScripts: Unit[] = [oneScript[0]!, { ...oneScript[1]!, script: "src/Notify.ssl" }];
	/** As a plan doc has it: what becomes of every node, those a unit carries included. */
	const everyNode = [
		{ node: "n1", becomes: "entry" },
		{ node: "n2", becomes: "Mark" },
		{ node: "n3", becomes: "Notify" },
		{ node: "n4", becomes: "exit" },
	];
	/** The least a plan doc may say: what becomes of the nodes no unit carries. */
	const ends = [everyNode[0]!, everyNode[3]!];
	const NOTHING = { changed: [], added: [], removed: [] };

	const said = (text: string) => ({ sessionID: "s", text, outcome: "succeeded", tokens: { input: 5000, output: 10 }, cost: 0 });
	const codeFor = (name: string) => said("```ssl\n:PROCEDURE " + name + ";\n:ENDPROC;\n```");
	/** What a turn is asked to build, from its prompt; null for the second opinion. */
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

	const realSession = { analyze: session.analyze, scratchTree: session.scratchTree, scratchCalls: session.scratchCalls, formatText: session.formatText, workspaceSymbols: session.workspaceSymbols };
	let disk = new Map<string, string>();
	let prompts: string[] = [];

	/**
	 * The plan with its approved doc on disk, a language server that answers, and an opencode that writes each
	 * procedure it is asked for. `runFileText` is what the build's own file holds, for a run begun in an earlier
	 * session; `whileBuilding` is called once the build has begun its run and before it builds anything.
	 */
	async function setUp(opts: { plan?: Plan; units?: Unit[]; map?: { node: string; becomes: string }[]; runFileText?: string; whileBuilding?: () => void } = {}) {
		tidyUp();
		const plan = opts.plan ?? releasePlan();
		disk = new Map<string, string>([
			[planPath, printPlan(plan)],
			[specFile, printSpec("The spec.", opts.units ?? oneScript, opts.map ?? ends, planHash(plan))],
		]);
		prompts = [];
		const savedRun = runFile(planPath, "/ws");
		rpcHandler = async (method, args) => {
			if (method === "read") {
				const p = String(args[0]);
				if (p === savedRun && opts.runFileText !== undefined) return { text: opts.runFileText, mtime: 1, encoding: "utf-8" };
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
			if (args[0] === "models") return [local];
			if (args[0] === "skills") {
				opts.whileBuilding?.();
				return [{ id: "ssl-new-procedure" }];
			}
			if (args[0] === "ask") {
				const prompt = String((args[1] as { text: string }[])[0]!.text);
				prompts.push(prompt);
				return unitAsked(prompt) ? codeFor(unitAsked(prompt)!) : said("It does what the chart says.");
			}
			return null;
		};
		(session as any).analyze = async (text: string) => ({ diagnostics: [], symbols: proceduresIn(text), timedOut: false });
		(session as any).scratchTree = async (text: string) => treeOf(text);
		(session as any).scratchCalls = async () => [];
		(session as any).formatText = async (text: string) => text;
		(session as any).workspaceSymbols = async () => [];
		setAgent((s) => {
			s.status = { state: "off" } as any;
			s.models = [];
			s.busy = false;
		});
		setState((s) => {
			s.settings.agentModel = "ollama/qwen3";
		});
		await openFile(planPath);
		flush();
		return plan;
	}
	const runNow = () => latestAssistOf(planPath).run!;
	const planNow = () => planOf(planPath)!;
	const unitsNow = () => (latestAssistOf(planPath).run?.units ?? []).map((u) => [u.name, u.status]);
	const recordNow = () => built.builtOf(planNow())!;
	/** A step's words changed on the chart, as the Palette's field does it: an edit of the plan's text. */
	const reword = (id: string, text: string) => {
		savePlan(planPath, setText(planNow(), id, text));
		flush();
	};
	/** "Review" in the Assistant: the review that then stands open. */
	async function openTheReview() {
		await reviewBuild(planPath);
		flush();
		return review()!;
	}
	/** "Accept" in the review: it closes, and what it proposed is accepted. */
	async function accept(open: NonNullable<ReturnType<typeof review>>) {
		open.onReject = undefined;
		closeReview();
		flush();
		await open.onAccept(open.proposed);
		flush();
	}
	/** The review the last accept opened by itself, for the next script. */
	async function theNextReview() {
		await new Promise((r) => setTimeout(r, 25));
		flush();
		return review()!;
	}
	/** The plan doc written again for the chart as it now stands, which a rebuild needs: it changes Mark, and no more. */
	const writePlanDocAgain = () => void disk.set(specFile, printSpec("The spec, revised.", [oneScript[0]!], [everyNode[1]!], planHash(planNow())));

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

	/** The finding, as it was reported: built, the review opened, a built step's words changed, Accept. */
	async function acceptedAfterAStepWasReworded() {
		const asBuilt = await setUp();
		await startBuild(planPath);
		expect(runNow().status).toBe("built");
		const open = await openTheReview();
		expect(open.title).toBe("Build: src/Release.ssl");
		reword("n2", "Mark the sample and bill the customer");
		expect(planHashMatches(runNow().planHash, planNow())).toBe(false);
		await accept(open);
		return { asBuilt, proposed: open.proposed };
	}

	test("a step reworded while the review stood open is recorded as it was built, and shows as changed", async () => {
		const { asBuilt, proposed } = await acceptedAfterAStepWasReworded();
		// The code is accepted as it always was: the script is created with what the review proposed.
		expect(disk.get("/ws/src/Release.ssl")).toBe(proposed);
		expect(proposed).toContain(":PROCEDURE Mark;");
		expect(state.messages.at(-1)?.text).toBe("Created src/Release.ssl.");
		expect(runNow().accepted).toEqual(["src/Release.ssl"]);
		// Both procedures carry their steps, and each step is recorded as the build read it.
		expect(recordNow().units.map((u) => [u.name, u.nodes])).toEqual([
			["Mark", ["n2"]],
			["Notify", ["n3"]],
		]);
		expect(recordNow().nodes.n2).toBe(built.nodePrint(asBuilt, "n2"));
		expect(recordNow().nodes.n2).not.toBe(built.nodePrint(planNow(), "n2"));
		// It used to be recorded in its new words: nothing had changed since it was built, and nothing was built again.
		expect(built.changesSince(planNow())).toEqual({ changed: ["n2"], added: [], removed: [] });
		// The chart marks it: the run that is left is of the earlier chart, and hides nothing.
		expect(built.chartChanges(planNow(), runNow()).changed).toEqual(["n2"]);
	});

	test('"Rebuild what changed" then builds that step again, and leaves the other alone', async () => {
		await acceptedAfterAStepWasReworded();
		writePlanDocAgain();
		prompts = [];
		await startBuild(planPath);
		// One turn for Mark, as an edit of the procedure that is there, and the second opinion. It used to be none:
		// "Nothing in the code needed to change. The chart is recorded as built."
		expect(prompts.map(unitAsked)).toEqual(["Mark", null]);
		expect(prompts[0]).toContain("Mark ALREADY EXISTS, as below.");
		expect(prompts[0]).toContain("WHAT CHANGED ON THE CHART:\n- n2: Mark the sample and bill the customer");
		expect(unitsNow()).toEqual([
			["Mark", "passed"],
			["Notify", "kept"],
		]);
		// Reviewed and accepted with the chart left alone, the step is built as it now reads.
		await accept(await openTheReview());
		expect(recordNow().nodes.n2).toBe(built.nodePrint(planNow(), "n2"));
		expect(built.changesSince(planNow())).toEqual(NOTHING);
	});

	test("a step reworded between the reviews of two scripts is recorded as it was built, once the whole run is accepted", async () => {
		const asBuilt = await setUp({ units: twoScripts, map: everyNode });
		await startBuild(planPath);
		const first = await openTheReview();
		expect(first.title).toBe("Build: src/Release.ssl (1 of 2)");
		await accept(first);
		expect(Object.keys(recordNow().nodes)).toEqual(["n2"]);
		// Before the second script's review is accepted, its step is changed on the chart.
		reword("n3", "Tell the lab, and the customer");
		const second = await theNextReview();
		expect(second.title).toBe("Build: src/Notify.ssl");
		await accept(second);
		expect(runNow().accepted).toEqual(["src/Release.ssl", "src/Notify.ssl"]);
		// The run is accepted whole, so what the plan doc only described is settled too: every node is recorded,
		// and each as the build read it. Settling used to print every node of the map as the chart had it by then.
		expect(Object.keys(recordNow().nodes).sort()).toEqual(["n1", "n2", "n3", "n4"]);
		for (const id of ["n1", "n2", "n3", "n4"]) expect(recordNow().nodes[id]).toBe(built.nodePrint(asBuilt, id));
		expect(built.changesSince(planNow())).toEqual({ changed: ["n3"], added: [], removed: [] });
	});

	test("with the chart left alone, accepting records what it always did", async () => {
		await setUp({ units: twoScripts, map: everyNode });
		await startBuild(planPath);
		await accept(await openTheReview());
		await accept(await theNextReview());
		expect(recordNow().units.map((u) => [u.name, u.script, u.nodes])).toEqual([
			["Mark", "src/Release.ssl", ["n2"]],
			["Notify", "src/Notify.ssl", ["n3"]],
		]);
		for (const id of ["n1", "n2", "n3", "n4"]) expect(recordNow().nodes[id]).toBe(built.nodePrint(planNow(), id));
		expect(built.changesSince(planNow())).toEqual(NOTHING);
		expect(built.chartChanges(planNow(), runNow())).toEqual(NOTHING);
	});

	test("a build that finds nothing to change records the chart it was begun from, not one changed under it", async () => {
		const plan = releasePlan();
		const passed: BuildUnit[] = oneScript.map((u) => ({ ...u, status: "passed", attempts: 1, code: `:PROCEDURE ${u.name};\n:ENDPROC;` }));
		// Built and accepted in an earlier session, and nothing changed since.
		const builtBefore = built.settleBuilt(built.recordBuilt(plan, passed, oneScript), newRun({ hash: planHash(plan), model: "m" }, oneScript, everyNode));
		expect(built.changesSince(builtBefore)).toEqual(NOTHING);
		await setUp({
			plan: builtBefore,
			map: everyNode,
			// While the build looks through the workspace, a built step's words are changed on the chart.
			whileBuilding: () => reword("n3", "Tell the lab, and the customer"),
		});
		await startBuild(planPath);
		expect(prompts).toEqual([]);
		expect(unitsNow()).toEqual([
			["Mark", "kept"],
			["Notify", "kept"],
		]);
		expect(state.messages.at(-1)?.text).toBe("Nothing in the code needed to change. The chart is recorded as built.");
		// That is said of the chart the build read. The step changed since is not part of it.
		expect(recordNow().nodes.n3).toBe(built.nodePrint(plan, "n3"));
		expect(built.changesSince(planNow())).toEqual({ changed: ["n3"], added: [], removed: [] });
	});

	/** A finished build as its file held it before a run kept its plan's prints. */
	const finishedRun = (plan: Plan, more: Partial<BuildRun> = {}): BuildRun => ({
		version: 1,
		planHash: planHash(plan),
		model: "ollama/qwen3",
		status: "built",
		tokens: 100,
		cost: 0,
		budget: { tokens: 400_000 },
		units: oneScript.map((u) => ({ ...u, status: "passed", attempts: 1, code: `:PROCEDURE ${u.name};\n:ENDPROC;` })),
		map: ends,
		accepted: [],
		...more,
	});

	test("a build saved by an earlier version is taken up, and is recorded as built from the chart it was read with", async () => {
		const saved = finishedRun(releasePlan());
		expect("prints" in saved).toBe(false);
		const asBuilt = await setUp({ runFileText: JSON.stringify(saved) });
		await loadRun(planPath);
		expect(unitsNow()).toEqual([
			["Mark", "passed"],
			["Notify", "passed"],
		]);
		const open = await openTheReview();
		reword("n2", "Mark the sample and bill the customer");
		await accept(open);
		expect(recordNow().nodes.n2).toBe(built.nodePrint(asBuilt, "n2"));
		expect(built.changesSince(planNow())).toEqual({ changed: ["n2"], added: [], removed: [] });
	});

	test("what a build's file says of the chart is not taken on trust: the chart it is read with is", async () => {
		// The file's prints are not those of this plan: written by hand, or damaged.
		const saved = finishedRun(releasePlan(), { prints: { n1: "0", n2: "0", n3: "0", n4: "0", n9: "0" } } as Partial<BuildRun>);
		await setUp({ runFileText: JSON.stringify(saved) });
		await loadRun(planPath);
		await accept(await openTheReview());
		for (const id of ["n1", "n2", "n3", "n4"]) expect(recordNow().nodes[id]).toBe(built.nodePrint(planNow(), id));
		expect(built.changesSince(planNow())).toEqual(NOTHING);
	});

	test("an accepted script whose record was never saved is recorded again when its build is taken up", async () => {
		const saved = finishedRun(releasePlan(), { accepted: ["src/Release.ssl"] });
		await setUp({ runFileText: JSON.stringify(saved) });
		expect(built.builtOf(planNow())).toBeNull();
		await loadRun(planPath);
		expect(recordNow().units.map((u) => u.name)).toEqual(["Mark", "Notify"]);
		expect(Object.keys(recordNow().nodes).sort()).toEqual(["n1", "n2", "n3", "n4"]);
		expect(built.changesSince(planNow())).toEqual(NOTHING);
	});

	test("a run that was begun without the prints is given them when it is carried on", async () => {
		const asBuilt = await setUp();
		const stopped = finishedRun(asBuilt, { status: "stopped" });
		Object.assign(stopped.units[1]!, { status: "pending", attempts: 0, code: undefined });
		updateAssist(planPath, { run: stopped });
		await startBuild(planPath);
		expect(prompts.map(unitAsked)).toEqual(["Notify", null]);
		const open = await openTheReview();
		reword("n2", "Mark the sample and bill the customer");
		await accept(open);
		expect(built.changesSince(planNow())).toEqual({ changed: ["n2"], added: [], removed: [] });
	});

	test("where nothing says what a run was built from, no step is recorded as built in words it was not built from", async () => {
		// A run put in place with no prints, and never read from its file or carried on: the app makes none such.
		const asBuilt = await setUp();
		updateAssist(planPath, { run: finishedRun(asBuilt) });
		const open = await openTheReview();
		reword("n2", "Mark the sample and bill the customer");
		await accept(open);
		// The procedures are linked to their steps, since their code is in the script. No step is marked as built.
		expect(recordNow().units.map((u) => u.name)).toEqual(["Mark", "Notify"]);
		expect(recordNow().nodes).toEqual({});
		expect(built.anyChanges(built.changesSince(planNow()))).toBe(true);
	});
});

// --- 2. the record's own logic ---------------------------------------------------------------------------------

describe("the record of a build is of the plan the run was begun from", () => {
	const plan = (): Plan => ({
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
	const spec = [
		{ name: "Mark", script: "src/Release.ssl", nodes: ["n2"], calls: [] },
		{ name: "Notify", script: "src/Release.ssl", nodes: ["n3"], calls: [] },
	];
	const passed = (): BuildUnit[] => spec.map((u) => ({ ...u, status: "passed", attempts: 1, code: `:PROCEDURE ${u.name};\n:ENDPROC;` }));
	const map = plan().nodes.map((n) => ({ node: n.id, becomes: "x" }));
	/** A run begun from `p`, as a build begins one. */
	const runFrom = (p: Plan) => newRun({ hash: planHash(p), model: "m", prints: built.nodePrints(p) }, spec, map);
	const without = (p: Plan, id: string): Plan => ({ ...p, nodes: p.nodes.filter((n) => n.id !== id), edges: p.edges.filter((e) => e.from !== id && e.to !== id) });

	test("a run keeps one print for each node of its plan, and a run begun without them holds none", () => {
		const p = plan();
		expect(runFrom(p).prints).toEqual({ n1: built.nodePrint(p, "n1"), n2: built.nodePrint(p, "n2"), n3: built.nodePrint(p, "n3"), n4: built.nodePrint(p, "n4") });
		expect("prints" in newRun({ hash: "h", model: "m" }, [], [])).toBe(false);
		// They are kept in the run's file with the rest of it.
		expect(JSON.parse(JSON.stringify(runFrom(p))).prints).toEqual(built.nodePrints(p));
	});

	test("what a run was built from: its own prints, or the plan in front of it while its hash says it is of that plan", () => {
		const p = plan();
		const later = setText(p, "n2", "Mark it, in a transaction");
		expect(built.builtFrom(runFrom(p), later)).toEqual(built.nodePrints(p));
		const older = newRun({ hash: planHash(p), model: "m" }, spec, map);
		expect(built.builtFrom(older, p)).toEqual(built.nodePrints(p));
		expect(built.builtFrom(older, later)).toBeNull();
	});

	test("an accepted unit's steps are recorded as the run has them, not as the chart has them by then", () => {
		const p = plan();
		const later = setText(p, "n2", "Mark it, in a transaction");
		const recorded = built.recordBuilt(later, passed(), spec, built.builtFrom(runFrom(p), later)!);
		expect(built.builtOf(recorded)!.nodes).toEqual({ n2: built.nodePrint(p, "n2"), n3: built.nodePrint(p, "n3") });
		expect(built.changesSince(recorded).changed).toEqual(["n2"]);
		// Given nothing, it records the plan in front of it, as it did: a plan and a run that are of one chart.
		expect(built.builtOf(built.recordBuilt(later, passed(), spec))!.nodes).toEqual({ n2: built.nodePrint(later, "n2"), n3: built.nodePrint(later, "n3") });
	});

	test("a step taken off the chart since it was built is reported as removed; one the run never had is not recorded", () => {
		const p = plan();
		const later = without(p, "n3");
		const units = passed();
		units[0]!.nodes = ["n2", "n7"];
		const recorded = built.recordBuilt(later, units, spec, built.nodePrints(p));
		expect(built.builtOf(recorded)!.nodes).toEqual({ n2: built.nodePrint(p, "n2"), n3: built.nodePrint(p, "n3") });
		expect(built.changesSince(recorded).removed).toEqual(["n3"]);
	});

	test("settling records the map's nodes as the run has them", () => {
		const p = plan();
		const run = runFrom(p);
		const later = setText(setText(p, "n4", "Return the id"), "n2", "Mark it, in a transaction");
		const settled = built.settleBuilt(built.recordBuilt(later, passed(), spec, run.prints), run);
		expect(built.builtOf(settled)!.nodes).toEqual(built.nodePrints(p));
		expect(built.changesSince(settled)).toEqual({ changed: ["n2", "n4"], added: [], removed: [] });
	});

	test("settling forgets a node the run's plan no longer had, and not one the chart lost only afterwards", () => {
		const first = built.settleBuilt(built.recordBuilt(plan(), passed(), spec), runFrom(plan()));
		// n3 is taken off the chart, and the chart is built again: that run's plan has no n3, and n3 is forgotten.
		const rebuilt = without(first, "n3");
		const forgotten = built.builtOf(built.settleBuilt(rebuilt, newRun({ hash: planHash(rebuilt), model: "m", prints: built.nodePrints(rebuilt) }, [], [])))!;
		expect(forgotten.nodes.n3).toBeUndefined();
		expect(forgotten.units.find((u) => u.name === "Notify")!.nodes).toEqual([]);
		// n3 is taken off the chart after the run was begun, and the run is then accepted: it was built, and is
		// reported as removed since.
		const kept = built.settleBuilt(without(first, "n3"), runFrom(plan()));
		expect(built.builtOf(kept)!.nodes.n3).toBe(built.nodePrint(plan(), "n3"));
		expect(built.builtOf(kept)!.units.find((u) => u.name === "Notify")!.nodes).toEqual(["n3"]);
		expect(built.changesSince(kept).removed).toEqual(["n3"]);
		// And a step put on the chart since is new: no run has built it.
		const added: Plan = { ...first, nodes: [...first.nodes, { id: "n5", kind: "step", text: "Write the log" }] };
		expect(built.changesSince(built.settleBuilt(added, runFrom(plan()))).added).toEqual(["n5"]);
	});

	test("a run that holds no prints and is not of this chart settles nothing", () => {
		const p = plan();
		const first = built.recordBuilt(p, passed().slice(0, 1), spec);
		const later = setText(first, "n3", "Tell the lab, and the customer");
		const older = newRun({ hash: planHash(p), model: "m" }, spec, map);
		expect(built.settleBuilt(later, older)).toBe(later);
		// While it is of this chart, it settles as it always did.
		expect(built.builtOf(built.settleBuilt(first, older))!.nodes).toEqual(built.nodePrints(p));
	});
});
