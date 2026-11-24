import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tabLabels } from "../src/view/editor/tabs";
import { packTabs, packViews, tabsKey, unpackTabs, viewsKey } from "../src/view/editor/sessionTabs";

// --- Headless browser & Monaco shims (compatible superset of markdownPowerFeatures.test.ts) ---
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
		innerHeight: 900,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
} else if (!(globalThis as any).window.Error) {
	(globalThis as any).window.Error = Error;
}
if (typeof (globalThis as any).document === "undefined") {
	(globalThis as any).document = {
		documentElement: { dataset: {}, style: {} },
		createElement: () => ({ style: {} }),
		querySelector: () => null,
	};
} else if (typeof (globalThis as any).document.querySelector !== "function") {
	(globalThis as any).document.querySelector = () => null;
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

type FakeMarker = { owner: string; message: string; code?: string };
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
const fakeMarkers = new Map<string, Map<string, FakeMarker[]>>();
const modelCreateListeners = new Set<(m: FakeModel) => void>();
const registeredOpeners: { openCodeEditor: (source: any, resource: any, selectionOrPosition?: any) => boolean }[] = [];
const modelDisposeEvents: string[] = [];

const makeUri = (scheme: string, fsPath: string) => {
	const normalized = fsPath.replace(/\\/g, "/");
	const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
	return { scheme, fsPath, path: normalized, toString: () => raw };
};

const parseUri = (raw: string) => {
	if (raw.startsWith("file://")) {
		const path = raw.slice("file://".length);
		return makeUri("file", path);
	}
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
			for (const edit of edits) {
				this._value = edit.text;
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
			modelDisposeEvents.push(this.uri.fsPath);
			for (const cb of [...this._disposeListeners]) cb();
			this._disposed = true;
			fakeModels.delete(key);
			fakeMarkers.delete(key);
		},
	};
	fakeModels.set(key, model);
	for (const cb of [...modelCreateListeners]) cb(model);
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
		setModelMarkers: (model: FakeModel, owner: string, markers: any[]) => {
			const key = model.uri.toString();
			let byOwner = fakeMarkers.get(key);
			if (!byOwner) {
				byOwner = new Map();
				fakeMarkers.set(key, byOwner);
			}
			if (!markers.length) byOwner.delete(owner);
			else byOwner.set(owner, markers.map((m) => ({ owner, message: m.message, code: m.code })));
		},
		onDidCreateModel: (cb: (m: FakeModel) => void) => {
			modelCreateListeners.add(cb);
			return { dispose: () => void modelCreateListeners.delete(cb) };
		},
		registerEditorOpener: (opener: any) => {
			registeredOpeners.push(opener);
			return { dispose() {} };
		},
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

let askAnswer: string | null = null;
let chooseAnswer: string | null = null;
mock.module(resolve(import.meta.dir, "../src/view/dialogs.tsx"), () => ({
	ask: async () => askAnswer,
	choose: async () => chooseAnswer,
	quickPick: async () => null,
	quickPickMany: async () => null,
	browseWorkspaceFile: async () => null,
}));

// Now import the real modules under test!
const { connect } = await import("../src/view/backend");
const { recall, remember } = await import("../src/view/graph/canvas");
const { DEFAULT_SETTINGS } = await import("../src/shared/protocol");
const { markdownEmbedFor } = await import("../src/view/editor/FileView");
const { clearEditorViewStates, editorGroupOf, editors } = await import("../src/view/editor/EditorGroup");
const { session } = await import("../src/view/lsp/session");
const {
	closeTab,
	documents,
	isTabsReady,
	newUntitled,
	openFile,
	openFolder,
	restoreTabs,
	save,
	setDocumentLanguage,
	setState,
	state,
	takeReveal,
} = await import("../src/view/state");
await import("../src/view/editor/opener");

// --- In-process MockSocket RPC driver for real `src/view/backend.ts` ---
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
	(globalThis as any).location = { protocol: "http:", host: "127.0.0.1:5190" };
	if (!(globalThis as any).document) {
		(globalThis as any).document = { documentElement: { dataset: {}, style: {} }, createElement: () => ({ style: {} }), querySelector: () => null };
	} else if (typeof (globalThis as any).document.querySelector !== "function") {
		(globalThis as any).document.querySelector = () => null;
	}
	failNextConnect = false;
	await connect();
}

async function disconnectTestRpc() {
	// Reset backend's internal `caller` back to `undefined` so sibling tests (e.g. r1aBackendSecurity) see disconnected state.
	failNextConnect = true;
	await connect().catch(() => {});
	failNextConnect = false;
	(globalThis as any).WebSocket = savedWebSocket;
	(globalThis as any).location = savedLocation;
	(globalThis as any).document = savedDocument;
}

function resetAppState() {
	for (const doc of [...documents.values()]) {
		doc.model.dispose();
	}
	documents.clear();
	fakeModels.clear();
	fakeMarkers.clear();
	editors.length = 0;
	modelDisposeEvents.length = 0;
	storage.clear();
	clearEditorViewStates();
	askAnswer = null;
	chooseAnswer = null;
	setState("workspace", { root: "/ws", name: "ws" });
	setState("groups", [{ tabs: [], active: null }]);
	setState("activeGroup", 0);
	setState("dirty", {});
	setState("conflicts", {});
	setState("messages", []);
	setState("lsp", { state: "stopped" });
	setState("info", null);
}

// =============================================================================
// 1. tabs.ts — Root-level duplicate filenames (no dangling " · ")
// =============================================================================
describe("tabs.ts — tabLabels root-level duplicate handling", () => {
	test("omits trailing separator when duplicate file sits at POSIX root with no workspace root", () => {
		const labels = tabLabels(["/README.md", "/docs/README.md"]);
		expect(labels.get("/README.md")).toBe("README.md");
		expect(labels.get("/docs/README.md")).toBe("README.md · docs");
		for (const label of labels.values()) {
			expect(label.endsWith(" · ")).toBe(false);
		}
	});

	test("omits trailing separator when external root file collides with workspace-root file", () => {
		const labels = tabLabels(["/README.md", "/work/proj/README.md"], "/work/proj");
		expect(labels.get("/README.md")).toBe("README.md");
		expect(labels.get("/work/proj/README.md")).toBe("README.md · proj");
	});

	test("omits trailing separator for bare relative duplicate filenames", () => {
		const labels = tabLabels(["README.md", "nested/README.md"], null);
		expect(labels.get("README.md")).toBe("README.md");
		expect(labels.get("nested/README.md")).toBe("README.md · nested");
	});
});

// =============================================================================
// 2. FileView.tsx — markdownEmbedFor escaping & outside-root safety
// =============================================================================
describe("FileView.tsx — markdownEmbedFor", () => {
	test("escapes closing brackets in alt text and URL-encodes workspace-relative path", () => {
		expect(markdownEmbedFor("/work/proj", "/work/proj/assets/diagram [v2].png")).toBe(
			"![diagram [v2\\]](/assets/diagram%20%5Bv2%5D.png)",
		);
		expect(markdownEmbedFor("/work/proj", "/work/proj/a]b]c.png")).toBe("![a\\]b\\]c](/a%5Db%5Dc.png)");
	});

	test("guards outside-workspace paths with isInside so external files never emit //...", () => {
		const posixExternal = markdownEmbedFor("/work/proj", "/tmp/outside/diagram [v2].png");
		expect(posixExternal).toBe("![diagram [v2\\]](/diagram%20%5Bv2%5D.png)");
		expect(posixExternal).not.toContain("(//");

		const winExternal = markdownEmbedFor("C:\\work\\proj", "D:\\other\\photo.png");
		expect(winExternal).toBe("![photo](/photo.png)");
		expect(winExternal).not.toContain("D%3A");
	});

	test("handles Windows inside-workspace paths and missing workspace root cleanly", () => {
		expect(markdownEmbedFor("C:\\work\\proj", "C:\\work\\proj\\img\\chart [1].png")).toBe(
			"![chart [1\\]](/img/chart%20%5B1%5D.png)",
		);
		expect(markdownEmbedFor(null, "/anywhere/logo.svg")).toBe("![logo](/logo.svg)");
		expect(markdownEmbedFor(undefined, "/anywhere/logo.svg")).toBe("![logo](/logo.svg)");
	});
});

// =============================================================================
// 3. EditorGroup.tsx & opener.ts — editorGroupOf & clearEditorViewStates
// =============================================================================
describe("EditorGroup.tsx & opener.ts — group resolution and viewState helpers", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAppState);

	test("editorGroupOf resolves direct group editors and embedded peek-widget descendants", () => {
		const dom0 = { contains: (n: any) => n === dom0 };
		const peekNode = {};
		const dom1 = { contains: (n: any) => n === dom1 || n === peekNode };
		const ed0 = { getDomNode: () => dom0 } as any;
		const ed1 = { getDomNode: () => dom1 } as any;
		editors[0] = ed0;
		editors[1] = ed1;

		expect(editorGroupOf(ed0)).toBe(0);
		expect(editorGroupOf(ed1)).toBe(1);
		expect(editorGroupOf({ getDomNode: () => peekNode } as any)).toBe(1);
		expect(editorGroupOf({ getDomNode: () => ({}) } as any)).toBeUndefined();
		expect(editorGroupOf(null)).toBeUndefined();
	});

	test("opener routes go-to-definition from group 1 into group 1 with reveal range", async () => {
		const ed0 = { getDomNode: () => null } as any;
		const ed1 = { getDomNode: () => null } as any;
		editors[0] = ed0;
		editors[1] = ed1;
		setState("groups", [
			{ tabs: ["/ws/a.ssl"], active: "/ws/a.ssl" },
			{ tabs: ["/ws/b.ssl"], active: "/ws/b.ssl" },
		]);
		setState("activeGroup", 0);
		rpcHandler = (method) => {
			if (method === "read") return { text: ":PROCEDURE Foo;\n:ENDPROC;\n", mtime: 100, encoding: "utf-8" };
			return null;
		};

		const opener = registeredOpeners[registeredOpeners.length - 1]!;
		const ok = opener.openCodeEditor(ed1, makeUri("file", "/ws/def.ssl"), { lineNumber: 2, column: 5 });
		expect(ok).toBe(true);
		await new Promise((r) => setTimeout(r, 15));

		expect(state.activeGroup).toBe(1);
		expect(state.groups[1]!.tabs).toContain("/ws/def.ssl");
		expect(state.groups[0]!.tabs).not.toContain("/ws/def.ssl");
		expect(takeReveal("/ws/def.ssl")).toEqual({ line: 2, column: 5 });
	});
});

// =============================================================================
// 4. state.ts — untitled save onto open path, restoreTabs, openFile, openFolder, setDocumentLanguage
// =============================================================================
describe("state.ts — lifecycle & race-condition repairs", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAppState);

	test("saving an untitled buffer onto an already-open path updates the existing model in place without duplicating listeners", async () => {
		rpcHandler = (method, args) => {
			if (method === "read" && args[0] === "/ws/target.ssl") return { text: "OLD\nLINE", mtime: 10, encoding: "utf-8" };
			if (method === "create") return null;
			if (method === "write") return { mtime: 20 };
			return null;
		};

		await openFile("/ws/target.ssl");
		const existingDoc = documents.get("/ws/target.ssl")!;
		const existingModel = existingDoc.model as unknown as FakeModel;
		const initialChangeListenerCount = existingModel._changeListeners.size;

		const untitledPath = newUntitled(0, "ssl");
		const untitledDoc = documents.get(untitledPath)!;
		untitledDoc.model.setEOL(1); // CRLF
		untitledDoc.model.setValue("NEW\r\nCONTENT");
		setState("conflicts", "/ws/target.ssl", true);

		askAnswer = "target.ssl";
		const saved = await save(untitledPath);
		expect(saved).toBe(true);

		// Existing Doc & Monaco model are reused and updated in place, with no duplicate content listener.
		expect(documents.get("/ws/target.ssl")).toBe(existingDoc);
		expect(documents.has(untitledPath)).toBe(false);
		expect(untitledDoc.model.isDisposed()).toBe(true);
		expect(existingModel.getValue()).toBe("NEW\r\nCONTENT");
		expect(existingModel.getEOL()).toBe("\r\n");
		expect(existingModel._changeListeners.size).toBe(initialChangeListenerCount);
		expect(state.dirty["/ws/target.ssl"]).toBe(false);
		expect(state.dirty[untitledPath]).toBeUndefined();
		expect(state.conflicts["/ws/target.ssl"]).toBeUndefined();
		expect(state.groups[0]!.tabs).toEqual(["/ws/target.ssl"]);
		expect(state.groups[0]!.active).toBe("/ws/target.ssl");
	});

	test("restoreTabs finally guard does not wipe Workspace B persisted tabs/views when switching workspaces mid-restore", async () => {
		// Seed persisted tabs & views for both workspaces via real remember/recall storage
		remember(tabsKey("/wsA"), packTabs([{ tabs: ["/wsA/slow.ssl"], active: "/wsA/slow.ssl" }], 0));
		remember(viewsKey("/wsA"), packViews("explorer", "problems", "health"));
		remember(tabsKey("/wsB"), packTabs([{ tabs: ["/wsB/keep.ssl"], active: "/wsB/keep.ssl" }], 0));
		remember(viewsKey("/wsB"), packViews("docs", "output", "objects"));

		let resolveSlowRead!: (v: any) => void;
		rpcHandler = (method, args) => {
			if (method === "read" && args[0] === "/wsA/slow.ssl") {
				return new Promise((resolve) => {
					resolveSlowRead = resolve;
				});
			}
			return null;
		};

		setState("workspace", { root: "/wsA", name: "wsA" });
		setState("groups", [{ tabs: [], active: null }]);
		const restoringA = restoreTabs();

		// Wait until read("/wsA/slow.ssl") is in flight
		await new Promise((r) => setTimeout(r, 10));
		expect(typeof resolveSlowRead).toBe("function");

		// Switch workspace mid-restore to /wsB (still empty before B restores)
		setState("workspace", { root: "/wsB", name: "wsB" });
		setState("groups", [{ tabs: [], active: null }]);
		setState("leftView", "search");

		// Now Workspace A's slow read resolves
		resolveSlowRead({ text: "A", mtime: 1, encoding: "utf-8" });
		await restoringA;

		// Workspace B's persisted tabs and views must remain completely intact!
		expect(unpackTabs(recall(tabsKey("/wsB")))).toEqual({
			groups: [{ tabs: ["/wsB/keep.ssl"], active: "/wsB/keep.ssl" }],
			activeGroup: 0,
		});
		expect(recall(viewsKey("/wsB"))).toBe(packViews("docs", "output", "objects"));
		expect(isTabsReady()).toBe(false);
		expect(documents.has("/wsA/slow.ssl")).toBe(false);
	});

	test("openFile slow preview cannot steal focus from a later non-preview openFile", async () => {
		let resolveSlow!: (v: any) => void;
		rpcHandler = (method, args) => {
			if (method === "read" && args[0] === "/ws/slow.ssl") {
				return new Promise((r) => {
					resolveSlow = r;
				});
			}
			if (method === "read" && args[0] === "/ws/fast.ssl") {
				return { text: "FAST", mtime: 2, encoding: "utf-8" };
			}
			return null;
		};

		const slowPreview = openFile("/ws/slow.ssl", { preview: true });
		await new Promise((r) => setTimeout(r, 10));
		await openFile("/ws/fast.ssl", { keep: true });
		expect(state.groups[0]!.active).toBe("/ws/fast.ssl");

		resolveSlow({ text: "SLOW", mtime: 1, encoding: "utf-8" });
		await slowPreview;

		expect(state.groups[0]!.active).toBe("/ws/fast.ssl");
		expect(state.groups[0]!.tabs).toEqual(["/ws/fast.ssl"]);
		expect(documents.has("/ws/slow.ssl")).toBe(false);
	});

	test("openFile bails out if workspace switches mid-read and clamps target group if split closes mid-read", async () => {
		let resolveA!: (v: any) => void;
		let resolveClamp!: (v: any) => void;
		rpcHandler = (method, args) => {
			if (method === "read" && args[0] === "/ws/stale.ssl") return new Promise((r) => (resolveA = r));
			if (method === "read" && args[0] === "/ws/clamped.ssl") return new Promise((r) => (resolveClamp = r));
			return null;
		};

		// 1. Workspace switch mid-read
		setState("workspace", { root: "/wsA", name: "wsA" });
		const staleOpen = openFile("/ws/stale.ssl");
		await new Promise((r) => setTimeout(r, 10));
		setState("workspace", { root: "/wsB", name: "wsB" });
		resolveA({ text: "STALE", mtime: 1, encoding: "utf-8" });
		await staleOpen;
		expect(state.groups[0]!.tabs).toEqual([]);
		expect(documents.has("/ws/stale.ssl")).toBe(false);

		// 2. Group 1 closed mid-read -> clamps safely to group 0 instead of throwing
		setState("groups", [
			{ tabs: ["/ws/one.ssl"], active: "/ws/one.ssl" },
			{ tabs: ["/ws/two.ssl"], active: "/ws/two.ssl" },
		]);
		const clampOpen = openFile("/ws/clamped.ssl", { group: 1 });
		await new Promise((r) => setTimeout(r, 10));
		setState("groups", [{ tabs: ["/ws/one.ssl"], active: "/ws/one.ssl" }]);
		setState("activeGroup", 0);
		resolveClamp({ text: "CLAMPED", mtime: 2, encoding: "utf-8" });
		await clampOpen;
		expect(state.groups[0]!.tabs).toContain("/ws/clamped.ssl");
		expect(state.groups[0]!.active).toBe("/ws/clamped.ssl");
	});

	test("openFolder calls session.reset() before backend.openFolder, clears groups before model disposal, and only starts LSP when running", async () => {
		const events: string[] = [];
		const origReset = session.reset.bind(session);
		const origStart = session.start.bind(session);
		let lspStateReply: { state: "stopped" | "running" } = { state: "stopped" };

		(session as any).reset = () => {
			events.push("session.reset");
			origReset();
		};
		(session as any).start = (root: string) => {
			events.push(`session.start:${root}`);
			return Promise.resolve();
		};

		try {
			rpcHandler = (method, args) => {
				if (method === "read") return { text: "code", mtime: 1, encoding: "utf-8" };
				if (method === "openFolder") {
					events.push(`backend.openFolder:${String(args[0])}`);
					return { root: String(args[0]), name: "next" };
				}
				if (method === "settings") return { effective: DEFAULT_SETTINGS };
				if (method === "themes") return [];
				if (method === "project") return null;
				if (method === "info") return { version: "0.1.0", selftest: true };
				if (method === "lspState") return lspStateReply;
				return null;
			};

			await openFile("/ws/old.ssl");
			const oldModel = documents.get("/ws/old.ssl")!.model as unknown as FakeModel;
			oldModel.onWillDispose(() => {
				// Groups must already be cleared before the model is disposed!
				events.push(`dispose:groupsTabs=${state.groups.map((g) => g.tabs.length).join(",")}`);
			});

			await openFolder("/ws2");
			expect(events.indexOf("session.reset")).toBeGreaterThanOrEqual(0);
			expect(events.indexOf("backend.openFolder:/ws2")).toBeGreaterThan(events.indexOf("session.reset"));
			expect(events).toContain("dispose:groupsTabs=0");
			expect(events.some((e) => e.startsWith("session.start:"))).toBe(false);

			// When LSP is running, session.start IS invoked with the new workspace root
			events.length = 0;
			lspStateReply = { state: "running" };
			await openFolder("/ws3");
			expect(events).toContain("session.start:/ws3");
		} finally {
			(session as any).reset = origReset;
			(session as any).start = origStart;
		}
	});

	test("setDocumentLanguage disposes old extension validators (e.g. trackJson) and starts new ones cleanly", async () => {
		rpcHandler = (method) => {
			if (method === "read") return { text: "{ invalid json", mtime: 1, encoding: "utf-8" };
			return null;
		};

		await openFile("/ws/sample.json");
		const doc = documents.get("/ws/sample.json")!;
		const uriKey = doc.model.uri.toString();

		// Opening invalid JSON immediately publishes a "json" marker
		expect(fakeMarkers.get(uriKey)?.has("json")).toBe(true);

		// Switching to SSL stops trackJson and clears its "json" markers
		expect(setDocumentLanguage("/ws/sample.json", "ssl")).toBe(true);
		expect(fakeMarkers.get(uriKey)?.has("json") ?? false).toBe(false);

		// Edits while in SSL mode must NOT re-trigger trackJson markers
		doc.model.setValue("{ still invalid json");
		await new Promise((r) => setTimeout(r, 450));
		expect(fakeMarkers.get(uriKey)?.has("json") ?? false).toBe(false);

		// Switching back to JSON restarts trackJson and reports the JSON error again
		expect(setDocumentLanguage("/ws/sample.json", "json")).toBe(true);
		expect(fakeMarkers.get(uriKey)?.has("json")).toBe(true);

		// Switching to plaintext stops trackJson and clears markers again
		expect(setDocumentLanguage("/ws/sample.json", "plaintext")).toBe(true);
		expect(fakeMarkers.get(uriKey)?.has("json") ?? false).toBe(false);
	});

	test("closeTab cleans up the closed tab cleanly and disposes its document when closed from last group", async () => {
		rpcHandler = (method) => {
			if (method === "read") return { text: "hello", mtime: 1, encoding: "utf-8" };
			return null;
		};
		await openFile("/ws/a.ssl");
		expect(documents.has("/ws/a.ssl")).toBe(true);
		expect(await closeTab("/ws/a.ssl", 0)).toBe(true);
		expect(documents.has("/ws/a.ssl")).toBe(false);
		expect(state.groups[0]!.tabs).toEqual([]);
	});
});

// =============================================================================
// 5. Structural UI regression guards for CenterTabStrip, EditorGroup, FileView
// =============================================================================
describe("UI interaction guards (EditorGroup, CenterTabStrip, FileView)", () => {
	const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

	test("CenterTabStrip guards tab activation on left click (e.button === 0) and renders unpin button for pinned tabs", () => {
		const src = readSrc("../src/view/editor/CenterTabStrip.tsx");
		expect(src).toContain("else if (e.button === 0)");
		expect(src).toContain('class="pin"');
		expect(src).toContain("togglePin(path, state.activeGroup)");
	});

	test("EditorGroup guards tab activation on left click, gates revealSignal on activeGroup & visible Monaco, and guards unmount", () => {
		const src = readSrc("../src/view/editor/EditorGroup.tsx");
		expect(src).toContain("else if (e.button === 0)");
		expect(src).toContain("state.activeGroup === props.index && path === group().active && shown === path && isMonacoVisible()");
		expect(src).toContain("!showBlocks() && !showChart() && !showRendered() && !showLive() && !showTable() && !showFile()");
		expect(src).toContain("if (disposed || !state.groups[props.index]");
		expect(src).toContain("cancelAnimationFrame(anchorRaf)");
		expect(src).toContain("othersOf(g.tabs, g.pinned ?? [], path).length > 0");
		expect(src).toContain("closeOtherTabs(path, props.index)");
		expect(src).toContain('focusRequest.fire("editor")');
	});

	test("FileView tracks state.kindVersion in both file() and createResource key for live disk reloads", () => {
		const src = readSrc("../src/view/editor/FileView.tsx");
		expect(src).toContain("void state.kindVersion;");
		expect(src).toContain("[props.path, state.kindVersion]");
	});
});
