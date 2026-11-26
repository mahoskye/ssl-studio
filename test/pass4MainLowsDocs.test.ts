// Pass 4, the low findings in the project documents that were on main before this branch: a snippet started from
// selected code that kept the template's placeholder (B4-4), bulk changes that said "already had that" of documents
// they could not read (B5-2), "Select all visible" that selected what was not on the screen (B5-3), the YAML button
// that wrote front matter above a template's header (B5-4), a catalog under an unclosed code fence that grew by a
// list on every update (B4-6), the table check's three mismeasurements (B4-8), a registry that opens with its
// ticket column, a manifest printed anew from its cells and written from text read before a question, and a
// close-out that said it had recorded what it had not (B4-10).
// Each test runs the code it names. The flows that ask the backend (Update catalogs, Update file manifest, Close
// out ticket, Set status, a bulk change's edit of one document, Add a registry row) are run whole, against a
// backend answered here from a map of files; the dialogs are answered here too. What cannot be run here is said
// where it stands and read as source: a selection in an editor (B4-4), the Docs panel and the Inspector as
// components (B5-2's four summaries, B5-3's reading of the page, B5-4's two buttons).
// The modules that gained a function are imported whole (`import * as`), so that this file also loads against
// the code as it was, where each test then fails for what it tests.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRoot, flush, snapshot } from "solid-js";
import * as catalog from "../src/shared/catalog";
import { parseCsv } from "../src/shared/csv";
import { cellText, checkTables, shownLength } from "../src/shared/docTables";
import { addToFrontMatterList, frontMatterInnerSpan, withFrontMatter } from "../src/shared/frontMatter";
import { mergeManifest } from "../src/shared/manifest";
import * as sharedDocs from "../src/shared/projectDocs";
import { DEFAULT_SETTINGS, type DocFile, type ManifestFile } from "../src/shared/protocol";
import { DEFAULT_TEMPLATES, formatTemplateHeaderAttr, parseTemplateFile, renderTemplate } from "../src/shared/templater";

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

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
const { dismiss, documents, setState, state } = await import("../src/view/state");
const { resetRecentTabs } = await import("../src/view/recentTabs");
const { docs, useProject } = await import("../src/view/project");
const viewDocs = await import("../src/view/projectDocs");
const panel = await import("../src/view/panels/Docs");

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

// --- The folder the flows work in, as the backend answers for it ---
const ROOT = "/ws";
/** A file's text, or why it has none to give: it is not text, or reading it fails with these words. */
type Held = string | { binary: true } | { refused: string };
const disk = new Map<string, Held>();
/** Every write the flows asked for, in order. */
const writes: { path: string; text: string }[] = [];
let listedDocs: DocFile[] = [];
let manifestFiles: ManifestFile[] = [];

function answer(method: string, args: unknown[]): unknown {
	const path = String(args[0] ?? "");
	if (method === "read") {
		const held = disk.get(path);
		if (held === undefined) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
		if (typeof held === "string") return { path, text: held, mtime: 1 };
		if ("binary" in held) return { path, text: "", mtime: 1, binary: { size: 4 } };
		throw new Error(held.refused);
	}
	if (method === "write") {
		disk.set(path, String(args[1]));
		writes.push({ path, text: String(args[1]) });
		return { mtime: 2 };
	}
	if (method === "create") {
		// As src/bun/workspace.ts says it of a file that is there.
		if (disk.has(path)) throw new Error(`already exists: ${path.slice(ROOT.length + 1)}`);
		disk.set(path, "");
		return null;
	}
	if (method === "sizes") return Object.fromEntries((args[0] as string[]).filter((p) => disk.has(p)).map((p) => [p, 1]));
	if (method === "docs") return listedDocs;
	if (method === "manifest") return manifestFiles;
	if (method === "docsTruncated") return [];
	return null;
}

const notices = () => {
	flush();
	return snapshot(state).messages.map((message) => message.text);
};
const until = async (done: () => boolean, ms = 3000) => {
	const end = Date.now() + ms;
	while (!done()) {
		if (Date.now() > end) throw new Error("waited too long");
		await new Promise((r) => setTimeout(r, 5));
		flush();
	}
};

function resetAll() {
	for (const doc of [...documents.values()]) doc.model?.dispose?.();
	documents.clear();
	fakeModels.clear();
	storage.clear();
	resetRecentTabs();
	disk.clear();
	writes.length = 0;
	listedDocs = [];
	manifestFiles = [];
	askHandler = () => null;
	chooseHandler = () => null;
	rpcHandler = answer;
	flush();
	for (const message of snapshot(state).messages) dismiss(message.id);
	setState((s) => {
		s.workspace = { root: ROOT, name: "ws" };
		s.project = { root: ROOT, path: `${ROOT}/.ssl-studio/project.toml`, configured: true, name: "Demo", description: "", docs: "docs", plans: "design", schema: "schema", tests: "tests", code: "src" } as any;
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

// ---------------------------------------------------------------------------------------------------------------
// B4-4. A snippet started from selected code holds that code where the template's placeholder stood
// ---------------------------------------------------------------------------------------------------------------

describe("B4-4 — New > Snippet from selected code", () => {
	test("the selected SQL stands where SELECT 1; stood, under the snippet's name and nothing else", () => {
		const text = viewDocs.newSnippetText("Samples due today", "sql", "SELECT SAMPLE_ID\nFROM SAMPLES\nWHERE DUE_DATE = ?dToday?;");
		// Before: "-- Samples due today\n-- What it is for, and when to use it.\n\nSELECT 1;\n\nSELECT SAMPLE_ID…": the
		// placeholder ran first, and the prompt's line had the snippet listed as one not written yet.
		expect(text).toBe("-- Samples due today\n\nSELECT SAMPLE_ID\nFROM SAMPLES\nWHERE DUE_DATE = ?dToday?;\n");
		expect(text).not.toContain("SELECT 1;");
		expect(text).not.toContain(sharedDocs.PROMPTS.sql);
	});

	test("the selected SSL stands under a comment that is closed on the line of the name", () => {
		const text = viewDocs.newSnippetText("Find a sample; fast", "ssl", ":PROCEDURE FindSample;\n:RETURN .T.;\n:ENDPROC;");
		expect(text).toBe("/* Find a sample, fast;\n\n:PROCEDURE FindSample;\n:RETURN .T.;\n:ENDPROC;\n");
		expect(text).not.toContain(sharedDocs.PROMPTS.ssl);
	});

	test("with nothing selected the snippet is the template, to be written", () => {
		expect(viewDocs.newSnippetText("Samples due today", "sql", null)).toBe(sharedDocs.snippetTemplate({ title: "Samples due today", language: "sql" }));
		expect(viewDocs.newSnippetText("Samples due today", "sql", null)).toContain("SELECT 1;");
		expect(viewDocs.newSnippetText("Find a sample", "ssl", null)).toBe(sharedDocs.snippetTemplate({ title: "Find a sample", language: "ssl" }));
	});

	test("New > Snippet asks it with the selection, and not the template with the code under it (source read: the selection is an editor's)", () => {
		const src = readSrc("../src/view/projectDocs.ts");
		expect(src).toContain("return start(joinPath(folder, `${slug(title)}.${lang}`), newSnippetText(title, lang, code?.hasExcerpt ? code.text : null), \"knowledge\");");
		expect(src).not.toContain('header.replace(/\\n*$/, "\\n\\n")}${code.text}');
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B5-2. A document that cannot be read is named as that, not counted among those that "already had" the value
// ---------------------------------------------------------------------------------------------------------------

describe("B5-2 — a bulk change and a document that cannot be read", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);

	const spec = (name: string) => `${ROOT}/docs/specs/${name}`;
	const setRelease = (path: string) => panel.editDocFrontMatter(path, "release", (text: string) => withFrontMatter(text, "release", "R2026.12"));
	/** One document of a bulk change, as each of the four loops in the Docs panel takes it. */
	const taken = async (path: string) => {
		try {
			return (await setRelease(path)) ? "changed" : "already had it";
		} catch (e: any) {
			return `Could not update ${path.split("/").pop()}: ${e?.message ?? e}`;
		}
	};

	test("a document too large to read is raised with what the reading said", async () => {
		disk.set(spec("Big.md"), { refused: "docs/specs/Big.md is 30 MB: too large to open here (the most is 20 MB)." });
		// Before: false, which every caller counts as "already had that".
		expect(await taken(spec("Big.md"))).toBe("Could not update Big.md: it could not be read. docs/specs/Big.md is 30 MB: too large to open here (the most is 20 MB).");
		expect(writes).toEqual([]);
	});

	test("so is one that has gone, in plain words, and one that is not text", async () => {
		expect(await taken(spec("Gone.md"))).toBe("Could not update Gone.md: it could not be read. docs/specs/Gone.md is not there.");
		disk.set(spec("Picture.md"), { binary: true });
		expect(await taken(spec("Picture.md"))).toBe("Could not update Picture.md: it is not a text file.");
		expect(writes).toEqual([]);
	});

	test("a selection of four: one changed, one that had it, two not read, each said for what it is", async () => {
		disk.set(spec("A.md"), "---\ntitle: A\n---\n\n# A\n");
		disk.set(spec("B.md"), "---\ntitle: B\nrelease: R2026.12\n---\n\n# B\n");
		disk.set(spec("Big.md"), { refused: "docs/specs/Big.md is 30 MB: too large to open here (the most is 20 MB)." });
		const said = [];
		for (const name of ["A.md", "B.md", "Big.md", "Gone.md"]) said.push(await taken(spec(name)));
		expect(said).toEqual([
			"changed",
			"already had it",
			"Could not update Big.md: it could not be read. docs/specs/Big.md is 30 MB: too large to open here (the most is 20 MB).",
			"Could not update Gone.md: it could not be read. docs/specs/Gone.md is not there.",
		]);
		expect(writes).toEqual([{ path: spec("A.md"), text: "---\ntitle: A\nrelease: R2026.12\n---\n\n# A\n" }]);
	});

	test("Set status, which one selected document goes through, says so too (the flow is run)", async () => {
		disk.set(spec("Big.md"), { refused: "docs/specs/Big.md is 30 MB: too large to open here (the most is 20 MB)." });
		await viewDocs.setStatus(spec("Big.md"), "done");
		// Before: nothing was said, and nothing was done.
		expect(notices()).toContain("Could not set the status of Big.md: it could not be read. docs/specs/Big.md is 30 MB: too large to open here (the most is 20 MB).");
		await viewDocs.setStatus(spec("Gone.md"), "done");
		expect(notices()).toContain("Could not set the status of Gone.md: it could not be read. docs/specs/Gone.md is not there.");
		expect(writes).toEqual([]);
	});

	test("each of the four bulk changes counts what is raised as failed, and says \"already had\" only when nothing failed (source read: the loops are the panel's)", () => {
		const src = readSrc("../src/view/panels/Docs.tsx");
		// Each loop: an edit that is raised is counted and named.
		expect(src.match(/\} catch \(e: any\) \{\n\t+failed\+\+;\n\t+notify\(`Could not update \$\{baseName\(doc\.path\)\}: \$\{e\?\.message \?\? e\}`, "error"\);/g)).toHaveLength(4);
		// And "already had" is said only of a selection none of whose documents failed.
		for (const already of ['notify("Selected documents already had that status.");', "notify(`Selected documents already have #${tag}.`);", 'notify("Selected documents already had that release.");', 'notify(`Selected documents already had ${field}: "${value}".`);']) {
			const at = src.indexOf(already);
			expect(at).toBeGreaterThan(0);
			expect(src.slice(at - 40, at)).toContain("} else if (!failed) {");
		}
		// Nothing in the edit passes a document over as unchanged because it could not be read.
		const edit = src.slice(src.indexOf("export async function editDocFrontMatter"), src.indexOf("function gitKindOf"));
		expect(edit).toContain("if (cur === null) throw new Error(await whyNotRead(path));");
		expect(edit).not.toContain("return false;\n\tconst liveOpen");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B5-3. "Select all visible" selects the rows that are drawn, and never the project's own files
// ---------------------------------------------------------------------------------------------------------------

describe("B5-3 — Select all visible", () => {
	const doc = (path: string, group: DocFile["group"], more: Partial<DocFile> = {}): DocFile => ({ path: `${ROOT}/${path}`, name: path.split("/").pop()!, group, exists: true, ...more });
	const listed = [
		doc("README.md", "project"),
		doc("AGENTS.md", "project"),
		doc(".ssl-studio/project.toml", "project"),
		doc("docs/STATE.md", "project"),
		doc("docs/tickets/DEMO-1.md", "tickets", { ticket: "DEMO-1" }),
		doc("docs/tickets/DEMO-2.md", "tickets", { ticket: "DEMO-2" }),
		doc("docs/specs/Due-dates.md", "specs"),
		doc("docs/specs/INDEX.md", "specs"),
		doc("docs/knowledge/decisions/0001-keep.md", "knowledge", { kind: "decisions" }),
		doc("docs/registries/files.csv", "registries"),
	];
	/** What of the listing can be selected, by path. */
	const selectable = () => listed.filter((d) => panel.isBulkSelectable(d)).map((d) => d.path);
	const at = (path: string) => `${ROOT}/${path}`;

	test("the project's own files are not among what can be selected", () => {
		// Before: README.md, AGENTS.md and STATE.md were, and a bulk Set status wrote front matter at the top of each.
		expect(selectable()).toEqual([at("docs/tickets/DEMO-1.md"), at("docs/tickets/DEMO-2.md"), at("docs/specs/Due-dates.md"), at("docs/knowledge/decisions/0001-keep.md")]);
		for (const own of ["README.md", "AGENTS.md", "docs/STATE.md"]) expect(panel.isBulkSelectable(doc(own, "project"))).toBe(false);
		// As before: no catalog, no table, nothing that is not there.
		expect(panel.isBulkSelectable(doc("docs/specs/INDEX.md", "specs"))).toBe(false);
		expect(panel.isBulkSelectable(doc("docs/registries/files.csv", "registries"))).toBe(false);
		expect(panel.isBulkSelectable({ ...doc("docs/specs/New.md", "specs"), exists: false })).toBe(false);
	});

	test("with every list folded, nothing is drawn and nothing is selected", () => {
		// The rows the page has then: the headings of the lists, and no document.
		const drawn = ["head:docs:project", "head:docs:work", "head:docs:knowledge", "head:docs:registries"];
		// Before: every document the filter let through, "26 selected" over an empty panel.
		expect(panel.drawnSelectable(selectable(), drawn)).toEqual([]);
	});

	test("what is drawn is selected, in the order it is drawn, once", () => {
		// Work is open with DEMO-2 above DEMO-1 and the spec under it; the knowledge base is folded. A document
		// drawn in two lists is one document.
		const drawn = ["head:docs:project", at("README.md"), at("AGENTS.md"), "head:docs:work", at("docs/tickets/DEMO-2.md"), at("docs/specs/Due-dates.md"), at("docs/tickets/DEMO-1.md"), "finished-tickets", at("docs/specs/INDEX.md"), "head:docs:knowledge", at("docs/specs/Due-dates.md")];
		expect(panel.drawnSelectable(selectable(), drawn)).toEqual([at("docs/tickets/DEMO-2.md"), at("docs/specs/Due-dates.md"), at("docs/tickets/DEMO-1.md")]);
	});

	test("the bar says how many of the selected are not shown", () => {
		expect(panel.selectionSaid(3, 0)).toBe("3 selected");
		expect(panel.selectionSaid(1, 0)).toBe("1 selected");
		// Selected, and then its list folded: still selected, still changed by a bulk action, and said.
		expect(panel.selectionSaid(5, 2)).toBe("5 selected, 2 of them not shown");
	});

	test("the panel reads the rows from the page, at the click and whenever the page changes (source read: the panel is a component)", () => {
		const src = readSrc("../src/view/panels/Docs.tsx");
		expect(src).toContain('const rowsDrawn = (): string[] => (panelEl ? [...panelEl.querySelectorAll<HTMLElement>("[data-row]")].map((el) => el.dataset.row ?? "") : []);');
		// The button selects what is drawn at the click.
		expect(src).toMatch(/const bulkSelectAllVisible = \(\) => \{\n\t\tconst drawn = drawnSelectable\(visibleSelectablePaths\(\), rowsDrawn\(\)\);\n\t\tsetSelectedPaths\(\(prev\) => \{\n\t\t\tconst next = new Set\(prev\);\n\t\t\tfor \(const p of drawn\) next\.add\(p\);/);
		expect(src).not.toContain("for (const p of visibleSelectablePaths()) next.add(p);");
		// It is offered while a drawn row is not selected, and the count is the bar's own sentence.
		expect(src).toContain("<Show when={drawnSelectablePaths().length > 0 && !allVisibleSelected()}>");
		expect(src).toContain("{selectionSaid(selectedDocs().length, selectedNotShown())}");
		// The rows are read again when the page changes, and the reading is given up with the panel.
		expect(src).toMatch(/onSettled\(\(\) => \{\n\t\tif \(!panelEl \|\| typeof MutationObserver === "undefined"\) return;\n\t\tconst read = \(\) => setDrawnRows\(rowsDrawn\(\)\);\n\t\tconst observer = new MutationObserver\(read\);\n\t\tobserver\.observe\(panelEl, \{ childList: true, subtree: true, attributes: true, attributeFilter: \["data-row"\] \}\);\n\t\tread\(\);\n\t\treturn \(\) => observer\.disconnect\(\);\n\t\}\);/);
		// Where the selection is made, it is said which files are never part of one.
		expect(src.match(/\$\{NOT_IN_BULK\}/g)).toHaveLength(2);
		expect(src).toContain('const NOT_IN_BULK = "The project\'s own files (README.md, AGENTS.md, STATE.md) are never selected: they are changed one at a time.";');
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B5-4. A template's first front matter goes under its header comment
// ---------------------------------------------------------------------------------------------------------------

describe("B5-4 — the YAML button on a template with a header and no front matter", () => {
	// A built-in template as "Customize templates" writes it into the workspace: its header, then its own text.
	const builtin = DEFAULT_TEMPLATES.find((t) => t.id === "database-table")!;
	const header = `<!-- template: ${[formatTemplateHeaderAttr("name", builtin.name), formatTemplateHeaderAttr("description", builtin.description), formatTemplateHeaderAttr("group", builtin.group), formatTemplateHeaderAttr("folder", builtin.folder!), formatTemplateHeaderAttr("fileName", builtin.fileName!)].join(" ")} -->`;
	const file = `${header}\n${builtin.content}`;
	const read = (text: string) => parseTemplateFile(text, "database-table", "database-table", `${ROOT}/docs/templates/database-table.md`);

	test("the template has no front matter of its own (or this test tests nothing)", () => {
		expect(frontMatterInnerSpan(file)).toBeNull();
		expect(read(file)).toMatchObject({ name: "Database Table", group: "Schema", folder: "schema/database" });
	});

	test("the block is written under the header, and the template is still the template", async () => {
		const next = viewDocs.withTitleFrontMatter(file, "database-table")!;
		expect(next.startsWith(`${header}\n---\ntitle: database-table\n---\n\n${builtin.content.slice(0, 20)}`)).toBe(true);
		// Before, the block stood above the header: no folder, no file name, listed under "Custom".
		const before = read(`---\ntitle: database-table\n---\n\n${file}`);
		expect([before.group, before.folder, before.fileName]).toEqual(["Custom", undefined, undefined]);
		const after = read(next);
		expect([after.name, after.description, after.group, after.folder, after.fileName]).toEqual([builtin.name, builtin.description, builtin.group, builtin.folder, builtin.fileName]);
		// The box the button opens has the block to show.
		expect(frontMatterInnerSpan(next)?.inner).toBe("title: database-table");
		// And a note made from the template opens with the front matter, not with the template's header.
		const note = await renderTemplate(after.content, { title: "DEMO_SAMPLES", fileName: "DEMO_SAMPLES.md", relativePath: "schema/database/DEMO_SAMPLES.md", folder: "schema/database", projectName: "Demo" });
		expect(note.text.startsWith("---\ntitle: database-table\n---\n\n# DEMO_SAMPLES")).toBe(true);
		expect(note.text).not.toContain("<!-- template:");
	});

	test("a document that is no template gets the block at its top, as before, in its own line ends", () => {
		expect(viewDocs.withTitleFrontMatter("# Due dates\n\nBody.\n", "Due-dates")).toBe("---\ntitle: Due-dates\n---\n\n# Due dates\n\nBody.\n");
		expect(viewDocs.withTitleFrontMatter("# Due dates\r\n\r\nBody.\r\n", "Due-dates")).toBe("---\r\ntitle: Due-dates\r\n---\r\n\r\n# Due dates\r\n\r\nBody.\r\n");
		expect(viewDocs.withTitleFrontMatter("", "Empty")).toBe("---\ntitle: Empty\n---\n\n");
		// A name YAML would read as something else is quoted, as it was.
		expect(viewDocs.withTitleFrontMatter("Body\n", "Notes: draft")).toBe('---\ntitle: "Notes: draft"\n---\n\nBody\n');
	});

	test("where no block can be written that both readers find, none is: a header over several lines, one under a blank line, an unclosed block", () => {
		const overLines = `<!-- template: name="Table"\n  folder="schema/database" -->\n# <% tp.file.title %>\n`;
		expect(read(overLines).folder).toBe("schema/database");
		// Before: the block went above this header too, and the template lost its folder.
		expect(viewDocs.withTitleFrontMatter(overLines, "table")).toBeNull();
		expect(viewDocs.withTitleFrontMatter(`\n${header}\n# T\n`, "table")).toBeNull();
		expect(viewDocs.withTitleFrontMatter("---\ntitle: T\n\n# No closing fence\n", "t")).toBeNull();
	});

	test("+ Property on the same file writes under the header too, and is refused where it would not", () => {
		// The two writers the "+ Property" button asks: a value, and an item of a list.
		const withStatus = withFrontMatter(file, "status", "draft")!;
		expect(withStatus.startsWith(`${header}\n---\nstatus: draft\n---\n\n`)).toBe(true);
		expect(viewDocs.hidesTemplateHeader(file, withStatus)).toBe(false);
		const withTag = addToFrontMatterList(file, "tags", "schema")!;
		expect(withTag.startsWith(`${header}\n---\n`)).toBe(true);
		expect(viewDocs.hidesTemplateHeader(file, withTag)).toBe(false);
		expect(read(withTag).folder).toBe("schema/database");
		// A header the front matter's writer does not take for one: the property would be written above it.
		const overLines = `<!-- template: name="Table"\n  folder="schema/database" -->\n# <% tp.file.title %>\n`;
		expect(viewDocs.hidesTemplateHeader(overLines, withFrontMatter(overLines, "status", "draft")!)).toBe(true);
		// A change to a document with no header hides none.
		expect(viewDocs.hidesTemplateHeader("# T\n", withFrontMatter("# T\n", "status", "draft")!)).toBe(false);
	});

	test("the Inspector's two buttons ask it (source read: the Inspector is a component over an open editor document)", () => {
		const src = readSrc("../src/view/panels/MarkdownInspector.tsx");
		const button = src.slice(src.indexOf("const ensureFrontmatterAndOpenYaml = "), src.indexOf("const toggleEditYaml = "));
		expect(button).toMatch(/const next = withTitleFrontMatter\(cur, stem\);\n\t\t\tif \(next === null\) \{\n\t\t\t\tnotify\(TEMPLATE_HEADER_IN_THE_WAY, "error"\);\n\t\t\t\treturn;\n\t\t\t\}\n\t\t\tapplyDocTextUpdate\(next\);/);
		expect(button).not.toContain("applyDocTextUpdate(`---");
		const property = src.slice(src.indexOf("const addPropertyValueInteractive = "), src.indexOf("const removePropertyValue = "));
		expect(property).toContain('if (hidesTemplateHeader(cur, next)) return void notify(TEMPLATE_HEADER_IN_THE_WAY, "error");\n\t\t\tapplyDocTextUpdate(next);');
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B4-6. Updating a catalog twice gives what updating it once gives, whatever the document
// ---------------------------------------------------------------------------------------------------------------

describe("B4-6 — a catalog under a code fence that is never closed", () => {
	const S = catalog.CATALOG_START;
	const E = catalog.CATALOG_END;
	const items = [
		{ path: "a.md", title: "A", status: "draft", summary: "About a" },
		{ path: "b.md", title: "B" },
	];
	const LIST = "- [A](a.md): draft. About a.\n- [B](b.md)";

	test("the list is written between its markers, once, and the catalog is then up to date", () => {
		const text = `# T\n\n\`\`\`\ncode\n\n${S}\n\nold\n\n${E}\n`;
		const once = catalog.withCatalog(text, items);
		// Before: the old list stayed, and a second pair of markers with the list was put at the end; then a third.
		expect(once).toBe(`# T\n\n\`\`\`\ncode\n\n${S}\n\n${LIST}\n\n${E}\n`);
		expect(catalog.withCatalog(once, items)).toBe(once);
		expect(catalog.catalogStale(once, items)).toBe(false);
		expect(catalog.hasCatalogPlace(text)).toBe(true);
		expect(catalog.catalogBlock(text)?.inner).toBe("old");
	});

	test("a catalog with an open fence and no markers gets its list once", () => {
		const text = "# T\n\n```\ncode\n";
		const once = catalog.withCatalog(text, items);
		expect(once).toBe(`# T\n\n\`\`\`\ncode\n\n${S}\n\n${LIST}\n\n${E}\n`);
		// Before: the list put at the end stood under the open fence, was passed over, and another was put after it.
		expect(catalog.withCatalog(once, items)).toBe(once);
		expect(catalog.catalogStale(once, items)).toBe(false);
	});

	test("the fence is named by its line, for the notice", () => {
		expect(catalog.catalogUnderOpenFence(`# T\n\n\`\`\`\ncode\n\n${S}\n\nold\n\n${E}\n`)).toBe(3);
		expect(catalog.catalogUnderOpenFence(`${S}\n\nold\n\n${E}\n\n~~~sql\nSELECT 1;\n`)).toBe(0);
		expect(catalog.catalogUnderOpenFence(`# T\n\n\`\`\`\ncode\n\`\`\`\n\n${S}\n\n${E}\n`)).toBe(0);
		expect(catalog.catalogUnderOpenFence("# T\n\nNo fence, no markers.\n")).toBe(0);
	});

	test("markers shown as an example inside a closed fence are still an example", () => {
		const text = `# How a catalog looks\n\n\`\`\`md\n${S}\n\n- [x](x.md)\n\n${E}\n\`\`\`\n\nAfter.\n`;
		expect(catalog.hasCatalogPlace(text)).toBe(false);
		const once = catalog.withCatalog(text, items);
		expect(once).toBe(`${text}\n${S}\n\n${LIST}\n\n${E}\n`);
		expect(catalog.withCatalog(once, items)).toBe(once);
	});

	test("an end marker under an open fence does not end a list that opens above the fence: what lies between is kept", () => {
		const text = `${S}\n\n- [Old](old.md)\n\nMy notes.\n\n\`\`\`md\nAn example:\n${E}\n`;
		const once = catalog.withCatalog(text, items);
		expect(once).toContain("My notes.");
		expect(once).toContain("- [Old](old.md)");
		expect(once).toContain("An example:");
		expect(once.startsWith(`${S}\n\n${LIST}\n\n${E}\n`)).toBe(true);
		expect(catalog.withCatalog(once, items)).toBe(once);
	});

	test("twice is once, and the catalog is then up to date, for 6,000 documents made of markers, fences, lists and words", () => {
		const pieces = [S, E, "```", "```md", "~~~", "````", "words", "", "- [A](a.md): draft. About a.", "- [B](b.md)", "- [Old](old.md)", "## Mine", "Nothing here yet.", `  ${S}`, `${S} said in a sentence`, `> ${S}`, "\t```"];
		const lists = [items, [], [{ path: "a.md", title: "A", section: "One" }, { path: "c.md", title: "C", section: "Two" }]];
		let seed = 20261125;
		const pick = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const wrong: string[] = [];
		for (let i = 0; i < 6000; i++) {
			const lines = Array.from({ length: 1 + pick(9) }, () => pieces[pick(pieces.length)]!);
			const eol = pick(4) === 0 ? "\r\n" : "\n";
			const text = lines.join(eol) + (pick(3) ? eol : "");
			const list = lists[pick(lists.length)]!;
			const once = catalog.withCatalog(text, list);
			if (catalog.withCatalog(once, list) !== once || catalog.catalogStale(once, list)) wrong.push(text);
			// Where the catalog had no pair of markers, nothing a person wrote is taken with the old list.
			else if (!catalog.catalogBlock(text)) for (const line of ["words", "## Mine", "- [Old](old.md)"]) if (lines.includes(line) && !once.includes(line)) wrong.push(`lost ${line}: ${text}`);
		}
		// Before: 2,700 or so of them grew on every update.
		expect(wrong.slice(0, 3)).toEqual([]);
	});

	describe("Update catalogs, run twice", () => {
		beforeAll(connectTestRpc);
		afterAll(disconnectTestRpc);
		beforeEach(resetAll);

		test("the first update writes the list in its place and names the open fence; the second finds nothing to do", async () => {
			const index = `${ROOT}/docs/specs/INDEX.md`;
			listedDocs = [
				{ path: `${ROOT}/docs/specs/Due-dates.md`, name: "Due-dates.md", group: "specs", exists: true, title: "Due dates", status: "draft" },
				{ path: index, name: "INDEX.md", group: "specs", exists: true },
			];
			const opening = `# Specs\n\nHow a spec is laid out:\n\n\`\`\`md\n# Title\n\n${S}\n\nNothing here yet.\n\n${E}\n`;
			disk.set(index, opening);
			await viewDocs.updateCatalogs();
			const written = `# Specs\n\nHow a spec is laid out:\n\n\`\`\`md\n# Title\n\n${S}\n\n- [Due dates](Due-dates.md): draft.\n\n${E}\n`;
			expect(writes).toEqual([{ path: index, text: written }]);
			expect(notices()).toContain("docs/specs/INDEX.md has a code fence that is never closed (it opens on line 5), and the catalog's list is under it: the list is written, and is shown as code until the fence is closed.");
			// Before: a second list at the end of the file here, a third on the next update, and "out of date" after each.
			await viewDocs.updateCatalogs();
			await viewDocs.updateCatalogs();
			expect(writes).toHaveLength(1);
			expect(disk.get(index)).toBe(written);
			expect(notices()).toContain("Every catalog already says what its folder holds.");
		});
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B4-8. The table check measures a cell as it is shown, and reports a table on its own line
// ---------------------------------------------------------------------------------------------------------------

describe("B4-8 — the documentation table check", () => {
	const table = (cell: string) => `| Name | What |\n| --- | --- |\n| ${cell} | y |\n`;
	const said = (markdown: string) => checkTables(markdown).map((found) => `${found.line}: ${found.message}`);

	test("a link by name written as code is measured as the code it shows", () => {
		// Before: "Alias", five characters, for a cell that shows sixteen.
		expect(cellText("`[[Target|Alias]]`")).toBe("[[Target|Alias]]");
		expect(cellText("**`[[Target|Alias]]`**")).toBe("[[Target|Alias]]");
		expect(cellText("`[[Target]]` and [[Target|Alias]]")).toBe("[[Target]] and Alias");
		// In a table, where the bar of a link by name is written with a backslash: 24 characters shown, and reported.
		expect(said(table("`[[Sample-due-dates\\|Due]]`"))).toEqual(['1: "Name" holds a value of 24 characters; only the last column holds text, and the others at most 20.']);
		// Outside code it is the alias that shows, as before.
		expect(said(table("[[Sample-due-dates\\|Due]]"))).toEqual([]);
		expect(cellText("[[Target|Alias]]")).toBe("Alias");
		expect(cellText("[[Target\\|Alias]]")).toBe("Alias");
		expect(cellText("[[a]] and [[b|c]]")).toBe("a and c");
		expect(cellText("*[[a|b]]* [x](y) ~~[[c]]~~")).toBe("b x c");
	});

	test("marked words are measured without their marks", () => {
		// Before: five characters for one, so a value of seventeen marked characters was "21 characters".
		expect(cellText("==x==")).toBe("x");
		expect(shownLength(cellText("==seventeen letters=="))).toBe(17);
		expect(said(table("==seventeen letters=="))).toEqual([]);
		expect(said(table("==twenty-one characters=="))).toEqual(['1: "Name" holds a value of 21 characters; only the last column holds text, and the others at most 20.']);
		expect(cellText("due ==today== or sooner")).toBe("due today or sooner");
		expect(cellText("[due ==today==](x)")).toBe("due today");
		// Marks written as code are code, and a lone pair of equals signs marks nothing.
		expect(cellText("`==x==`")).toBe("==x==");
		expect(cellText("a == b")).toBe("a == b");
		expect(cellText("x==y")).toBe("x==y");
		expect(cellText("===")).toBe("===");
	});

	test("what was measured rightly is measured as it was", () => {
		for (const [cell, shown] of [
			["`SAMPLE_DUE_DATE_OVERRIDE`", "SAMPLE_DUE_DATE_OVERRIDE"],
			["snake_case_name_here_x", "snake_case_name_here_x"],
			["[text](http://x.example/a/long/path)", "text"],
			["&amp;&lt;", "&<"],
			["a \\| b", "a | b"],
			["\\*not em\\*", "*not em*"],
			["a<br/>b", "a b"],
			["**bold** _em_ ~~del~~", "bold em del"],
			["`a` `b`", "a b"],
			["[link `code`](x)", "link code"],
		] as const) {
			expect([cell, cellText(cell)]).toEqual([cell, shown]);
		}
	});

	const long = "x".repeat(30);
	const wide = (lead = "") => `${lead}| A | B |\n${lead}| --- | --- |\n${lead}| ${long} | y |\n`;

	test("a table in a quote and the same table below it are each reported on their own line", () => {
		// Before: [5, 1], the quoted table on the line of the one below it and that one on line 1.
		expect(checkTables(`${wide("> ")}\n${wide()}`).map((found) => found.line)).toEqual([1, 5]);
		expect(checkTables(`> Quoted words.\n${wide("> ")}\n${wide()}`).map((found) => found.line)).toEqual([2, 6]);
		expect(checkTables(`${wide("> > ")}\n${wide()}`).map((found) => found.line)).toEqual([1, 5]);
		expect(checkTables(`${wide("> ").replace(/\n/g, "\r\n")}\r\n${wide().replace(/\n/g, "\r\n")}`).map((found) => found.line)).toEqual([1, 5]);
		// In a list item, and between two at the top.
		expect(checkTables(`- item\n\n${wide("  ")}\ntext\n\n${wide()}`).map((found) => found.line)).toEqual([3, 9]);
		expect(checkTables(`${wide()}\n${wide("> ")}\n${wide()}`).map((found) => found.line)).toEqual([1, 5, 9]);
	});

	test("tables that were reported on their own lines still are", () => {
		expect(checkTables(`${wide()}\n${wide("> ")}`).map((found) => found.line)).toEqual([1, 5]);
		expect(checkTables(`${wide("> ")}\ntext\n\n${wide("> ")}`).map((found) => found.line)).toEqual([1, 7]);
		expect(checkTables(`text\n\n${wide()}\n${wide()}`).map((found) => found.line)).toEqual([3, 7]);
		expect(checkTables(`---\ntitle: x\n---\n\n${wide()}`).map((found) => found.line)).toEqual([5]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B4-10a. A registry that opens with its ticket column
// ---------------------------------------------------------------------------------------------------------------

describe("B4-10 — a registry whose first column is the ticket column", () => {
	test("the new row has the key in the ticket column and the name in the column for names", () => {
		// Before: "NEW,,found": the name where the key belongs, and no key.
		expect(viewDocs.registryTextWithRow("ticket,item,status\nDEMO-1,a,done\n", "docs/registries/jobs.csv", "NEW", "DEMO-2", false)).toBe("ticket,item,status\nDEMO-1,a,done\nDEMO-2,NEW,found\n");
		expect(viewDocs.registryTextWithRow("Ticket\tStatus\tJob\nDEMO-1\tdone\ta\n", "docs/registries/jobs.tsv", "NEW", "DEMO-2", false)).toBe("Ticket\tStatus\tJob\nDEMO-1\tdone\ta\nDEMO-2\tfound\tNEW\n");
		// A registry of tickets and nothing else: the row is the key.
		expect(viewDocs.registryTextWithRow("ticket\nDEMO-1\n", "docs/registries/carried.csv", "", "DEMO-2", false)).toBe("ticket\nDEMO-1\nDEMO-2\n");
		expect(viewDocs.registryTextWithRow("tickets,status\nDEMO-1,done\n", "docs/registries/carried.csv", "", "DEMO-2", false)).toBe("tickets,status\nDEMO-1,done\nDEMO-2,found\n");
	});

	test("a registry that opens with its names is written as before", () => {
		expect(viewDocs.registryTextWithRow("name,status,ticket\na,done,DEMO-1\n", "docs/registries/jobs.csv", "NEW", "DEMO-2", false)).toBe("name,status,ticket\na,done,DEMO-1\nNEW,found,DEMO-2\n");
		expect(viewDocs.registryTextWithRow("name,status\na,done\n", "docs/registries/jobs.csv", "NEW", "DEMO-2", true)).toBe("name,status,ticket\na,done,\nNEW,found,DEMO-2\n");
		expect(viewDocs.registryTextWithRow("name\na\n", "docs/registries/jobs.tsv", "NEW", "DEMO-2", false)).toBe("name\na\nNEW\n");
	});

	test("the column for names is the first that is neither the tickets' nor the status", () => {
		const header = (text: string) => parseCsv(text);
		expect(viewDocs.registryNameColumn(header("name,status,ticket\n"))).toBe(0);
		expect(viewDocs.registryNameColumn(header("ticket,item,status\n"))).toBe(1);
		expect(viewDocs.registryNameColumn(header("Tickets,Status,Job\n"))).toBe(2);
		expect(viewDocs.registryNameColumn(header("ticket,status\n"))).toBe(-1);
	});

	describe("Add a registry row for a ticket (the flow is run)", () => {
		let dispose = () => {};
		beforeAll(async () => {
			await connectTestRpc();
			// The list of documents the flow picks its registry from is the app's own, kept by `useProject`.
			createRoot((d) => {
				dispose = d;
				useProject();
			});
		});
		afterAll(async () => {
			dispose();
			await disconnectTestRpc();
		});
		beforeEach(resetAll);
		const registry = `${ROOT}/docs/registries/jobs.csv`;
		const lists = async (text: string) => {
			disk.set(registry, text);
			listedDocs = [{ path: registry, name: "jobs.csv", group: "registries", exists: true }];
			setState((s) => {
				s.treeVersion += 1;
			});
			flush();
			await until(() => docs().some((d) => d.path === registry));
		};

		test("it asks for the name by the column the name goes in, and writes the key where it belongs", async () => {
			await lists("ticket,item,status\nDEMO-1,a,done\n");
			const asked: string[] = [];
			askHandler = (prompt) => {
				asked.push(prompt);
				return "Nightly export";
			};
			await viewDocs.addRegistryRowForTicket("DEMO-2");
			// Before: "New ticket for DEMO-2 in jobs.csv", and the answer written into the ticket column.
			expect(asked).toEqual(["New item for DEMO-2 in jobs.csv"]);
			expect(writes).toEqual([{ path: registry, text: "ticket,item,status\nDEMO-1,a,done\nDEMO-2,Nightly export,found\n" }]);
			expect(notices()).toContain("Added “Nightly export” to jobs.csv for DEMO-2.");
		});

		test("a registry of tickets alone is given the key, and no name is asked for", async () => {
			await lists("ticket\nDEMO-1\n");
			const asked: string[] = [];
			askHandler = (prompt) => {
				asked.push(prompt);
				return "A name with nowhere to go";
			};
			await viewDocs.addRegistryRowForTicket("DEMO-2");
			expect(asked).toEqual([]);
			expect(writes).toEqual([{ path: registry, text: "ticket\nDEMO-1\nDEMO-2\n" }]);
			expect(notices()).toContain("Added a row for DEMO-2 to jobs.csv.");
		});
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B4-10b. The file manifest: only what changed is written, into the text as it is when the question is answered
// ---------------------------------------------------------------------------------------------------------------

describe("B4-10 — the file manifest", () => {
	const file = (path: string, sha256: string, bytes = 10, lines = 2): ManifestFile => ({ path, kind: "ssl", bytes, lines, sha256 });
	const now = [file("src/a.ssl", "aaa"), file("src/b.ssl", "bbb2", 20, 4), file("src/New, file.ssl", "nnn")];

	test("rows that have not changed stay as they were written: quotes, blank lines, line ends, a byte-order mark", () => {
		const before = '﻿path,kind,bytes,lines,sha256,status,note\r\n\r\n"src/a.ssl",ssl,10,2,aaa,"verified","a, note"\r\n\r\nsrc/b.ssl,ssl,20,4,bbb,verified,"keep ""this"""\r\nsrc/old.ssl,ssl,1,1,ooo,Gone,x';
		const change = mergeManifest(before, now);
		// Before: every row printed anew. The mark and the blank lines went, "src/a.ssl" and "verified" lost their
		// quotes, and "Gone" became "gone", in rows where nothing had changed.
		expect(change.text).toBe(
			'﻿path,kind,bytes,lines,sha256,status,note\r\n\r\n"src/a.ssl",ssl,10,2,aaa,"verified","a, note"\r\n\r\nsrc/b.ssl,ssl,20,4,bbb2,verified,"keep ""this"""\r\nsrc/old.ssl,ssl,1,1,ooo,Gone,x\r\n"src/New, file.ssl",ssl,10,2,nnn,found,\r\n',
		);
		expect({ added: change.added, changed: change.changed, gone: change.gone, same: change.same, changedAfterDone: change.changedAfterDone }).toEqual({ added: 1, changed: 1, gone: 0, same: 1, changedAfterDone: ["src/b.ssl"] });
		// And an update with nothing to say changes nothing at all.
		expect(mergeManifest(change.text, now).text).toBe(change.text);
		const settled = 'path,kind,bytes,lines,sha256,status,note\n"src/a.ssl",ssl,10,2,aaa,verified,\n\nsrc/b.ssl,ssl,20,4,bbb2,"verified",';
		expect(mergeManifest(settled, [now[0]!, now[1]!]).text).toBe(settled);
	});

	test("one cell is written where one value changed, and a row is told it has gone", () => {
		const before = "owner,path,status,sha256,kind,bytes,lines\nme,src/a.ssl,verified,aaa,ssl,10,2\nyou,src/b.ssl,,bbb,ssl,20,4\nme,src/old.ssl,verified,ooo,ssl,1,1\n";
		expect(mergeManifest(before, [now[0]!, now[1]!]).text).toBe("owner,path,status,sha256,kind,bytes,lines\nme,src/a.ssl,verified,aaa,ssl,10,2\nyou,src/b.ssl,found,bbb2,ssl,20,4\nme,src/old.ssl,gone,ooo,ssl,1,1\n");
		expect(mergeManifest("path,kind,bytes,lines,sha256,status,note\nsrc/b.ssl,ssl,20,4,bbb,verified,mine\n", [now[1]!], { markChangedAfterDone: true }).text).toBe("path,kind,bytes,lines,sha256,status,note\nsrc/b.ssl,ssl,20,4,bbb2,changed,mine\n");
	});

	test("a column the manifest lacks goes on the end of each row's own line, and a short row gets the cells it needs", () => {
		expect(mergeManifest("path,status\nsrc/a.ssl,verified,extra\n\nsrc/b.ssl\n", [now[0]!, now[1]!]).text).toBe("path,status,kind,bytes,lines,sha256\nsrc/a.ssl,verified,ssl,10,2,aaa,extra\n\nsrc/b.ssl,found,ssl,20,4,bbb2\n");
		expect(mergeManifest("path,kind,bytes,lines,sha256,status,note\nsrc/a.ssl\nsrc/old.ssl\n", [now[0]!]).text).toBe("path,kind,bytes,lines,sha256,status,note\nsrc/a.ssl,ssl,10,2,aaa,found\nsrc/old.ssl,,,,,gone\n");
	});

	test("a new manifest, and what an update counts, are as they were", () => {
		const fresh = "path,kind,bytes,lines,sha256,status,note\nsrc/a.ssl,ssl,10,2,aaa,found,\nsrc/b.ssl,ssl,20,4,bbb2,found,\n\"src/New, file.ssl\",ssl,10,2,nnn,found,\n";
		expect(mergeManifest(null, now).text).toBe(fresh);
		expect(mergeManifest("", now).text).toBe(fresh);
		expect(mergeManifest("path,kind,bytes,lines,sha256,status,note", now).text).toBe(fresh);
		const counted = mergeManifest("path,kind,bytes,lines,sha256,status,note\nsrc/a.ssl,ssl,10,2,aaa,verified,\nsrc/A.SSL,ssl,10,2,aaa,verified,\nsrc/old.ssl,ssl,1,1,ooo,found,\nsrc/b.ssl,ssl,20,4,bbb,verified,\n", now);
		expect([counted.added, counted.changed, counted.gone, counted.same, counted.changedAfterDone]).toEqual([1, 1, 2, 1, ["src/b.ssl"]]);
	});

	describe("Update file manifest (the flow is run)", () => {
		beforeAll(connectTestRpc);
		afterAll(disconnectTestRpc);
		beforeEach(resetAll);
		const manifest = `${ROOT}/docs/registries/files.csv`;
		const read = 'path,kind,bytes,lines,sha256,status,note\n"src/a.ssl",ssl,10,2,aaa,verified,"mine, kept"\n\nsrc/b.ssl,ssl,20,4,bbb,verified,\n';

		test("a manifest changed while the question stood open is not written over, and that is said", async () => {
			disk.set(manifest, read);
			manifestFiles = [now[0]!, now[1]!];
			const edited = read.replace("verified,\n", "verified,checked by hand\n");
			const asked: string[] = [];
			chooseHandler = (prompt) => {
				asked.push(prompt);
				// While the question is open, the manifest is changed (by a person in another window, by a tool).
				disk.set(manifest, edited);
				return "Mark as changed";
			};
			await viewDocs.updateManifest();
			expect(asked).toHaveLength(1);
			// Before: written from the text read before the question, so "checked by hand" was gone.
			expect(writes).toEqual([]);
			expect(disk.get(manifest)).toBe(edited);
			expect(notices()).toContain("docs/registries/files.csv was changed while the question was open, so nothing was written to it. Update the file manifest again.");
		});

		test("answered over a manifest that stayed as it was, only what changed is written", async () => {
			disk.set(manifest, read);
			manifestFiles = [now[0]!, now[1]!];
			chooseHandler = () => "Mark as changed";
			await viewDocs.updateManifest();
			expect(writes).toEqual([{ path: manifest, text: 'path,kind,bytes,lines,sha256,status,note\n"src/a.ssl",ssl,10,2,aaa,verified,"mine, kept"\n\nsrc/b.ssl,ssl,20,4,bbb2,changed,\n' }]);
			expect(notices()).toContain("File manifest: 2 files; 1 changed.");
		});

		test("with nothing to ask, the manifest is written as before, and one that is up to date is not written at all", async () => {
			disk.set(manifest, 'path,kind,bytes,lines,sha256,status,note\n"src/a.ssl",ssl,10,2,aaa,found,\n');
			manifestFiles = [now[0]!, now[1]!];
			await viewDocs.updateManifest();
			expect(writes).toEqual([{ path: manifest, text: 'path,kind,bytes,lines,sha256,status,note\n"src/a.ssl",ssl,10,2,aaa,found,\nsrc/b.ssl,ssl,20,4,bbb2,found,\n' }]);
			await viewDocs.updateManifest();
			expect(writes).toHaveLength(1);
		});
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B4-10c. A close-out says it recorded the ticket in STATE.md only when it did
// ---------------------------------------------------------------------------------------------------------------

describe("B4-10 — closing out a ticket", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);
	beforeEach(resetAll);
	const ticket = `${ROOT}/docs/tickets/DEMO-1.md`;
	const stateFile = `${ROOT}/docs/STATE.md`;
	const closeOut = async () => {
		disk.set(ticket, "---\nticket: DEMO-1\ntitle: Due dates\nstatus: open\n---\n\n# DEMO-1: Due dates\n");
		chooseHandler = () => "Mark done & record in STATE.md";
		askHandler = () => "DEMO-1: due dates are shown";
		await viewDocs.closeoutTicket(ticket, "DEMO-1");
	};

	test("a STATE.md that could not be made is not said to hold the record", async () => {
		// A file of that name is there and is not text: it cannot be read, so it is taken for missing, and cannot be made.
		disk.set(stateFile, { binary: true });
		await closeOut();
		const said = notices();
		// Before: "Closed out DEMO-1 (recorded in STATE.md)." under the notice that the file could not be made.
		expect(said).toContain("already exists: docs/STATE.md");
		expect(said).toContain("Closed out DEMO-1. STATE.md was not written.");
		expect(said.join("\n")).not.toContain("recorded in STATE.md");
		expect(disk.get(stateFile)).toEqual({ binary: true });
		// The ticket is closed all the same: that is what "Closed out" says.
		expect(disk.get(ticket)).toContain("status: done");
	});

	test("a STATE.md that is made holds the record, and the close-out says so", async () => {
		await closeOut();
		expect(notices()).toContain("Closed out DEMO-1 (recorded in STATE.md).");
		expect(String(disk.get(stateFile))).toMatch(/## Completed\n\n- \d{4}-\d{2}-\d{2} — DEMO-1: due dates are shown\n$/);
	});

	test("so does one that was there, and one that cannot be written says that", async () => {
		disk.set(stateFile, "# Where Demo stands\n\n## Completed\n\n- 2026-11-01 — DEMO-0: begun\n");
		await closeOut();
		expect(notices()).toContain("Closed out DEMO-1 (recorded in STATE.md).");
		expect(String(disk.get(stateFile))).toMatch(/## Completed\n\n- \d{4}-\d{2}-\d{2} — DEMO-1: due dates are shown\n- 2026-11-01 — DEMO-0: begun\n$/);
		// The record cannot be written: the folder refuses the write.
		resetAll();
		disk.set(stateFile, "# Where Demo stands\n");
		rpcHandler = (method, args) => {
			if (method === "write" && args[0] === stateFile) throw new Error("EACCES: permission denied, open '/ws/docs/STATE.md'");
			return answer(method, args);
		};
		await closeOut();
		expect(notices()).toContain("Closed out DEMO-1. STATE.md was not written.");
		expect(notices().join("\n")).not.toContain("recorded in STATE.md");
	});
});
