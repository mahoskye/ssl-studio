// The low findings of the pass 4 audit in the live Markdown editor: which `<details>` block a remembered open state
// belongs to, a picture that is asked for again when its file appears or changes, a click on a link in the diagram
// viewer, and what a rendered document's own HTML may start or fetch.
//
// Bun has no DOM. A picture is drawn into stand-in elements (it needs no more of them than to be put together);
// a `<details>` block cannot be (its summary goes through DOMPurify), so its two decisions are asked of the widget
// the editor's own field builds: whether it is drawn open, and what its `toggle` remembers. The sanitiser's rules
// and the viewer's press are the functions the window's handlers call; that they are called is read from the source.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, RangeSet, type Transaction } from "@codemirror/state";

// --- The same headless window and Monaco stand-ins as pass3LowsEditorsPanels.test.ts, so the view's modules load under bun ---
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
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" },
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
		head: { appendChild() {} },
		body: { style: {} },
		activeElement: null,
		getElementById: () => null,
		createElement: () => ({ style: {}, getContext: () => null }),
		querySelector: () => null,
		addEventListener() {},
		removeEventListener() {},
	};
} else {
	if (!(globalThis as any).document.body) (globalThis as any).document.body = { style: {} };
	else if (!(globalThis as any).document.body.style) (globalThis as any).document.body.style = {};
	if (!(globalThis as any).document.addEventListener) (globalThis as any).document.addEventListener = () => {};
	if (!(globalThis as any).document.removeEventListener) (globalThis as any).document.removeEventListener = () => {};
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

const makeUri = (scheme: string, fsPath: string) => {
	const normalized = fsPath.replace(/\\/g, "/");
	const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
	return { scheme, fsPath, path: normalized, toString: () => raw };
};

mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({
	default: class {},
}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
for (const lang of ["markdown", "sql", "yaml", "xml", "ini", "shell", "powershell", "bat", "javascript", "typescript", "html", "css", "scss", "less", "csharp", "vb", "razor", "pgsql", "mysql", "python", "java", "cpp", "php", "dockerfile", "graphql", "r", "perl", "ruby", "go", "rust", "fsharp"]) {
	mock.module(`monaco-editor/languages/definitions/${lang}/register`, () => ({}));
}

const noopProxy = (base: Record<string, any> = {}): any =>
	new Proxy(base, {
		get(target, prop) {
			if (prop in target) return target[prop as any];
			return () => ({ dispose() {} });
		},
	});

mock.module("monaco-editor/editor/editor.api", () => ({
	Range: class {
		constructor(
			public startLineNumber: number,
			public startColumn: number,
			public endLineNumber: number,
			public endColumn: number,
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
		parse: (raw: string) => {
			if (raw.startsWith("file://")) return makeUri("file", raw.slice("file://".length));
			if (raw.startsWith("untitled:")) return makeUri("untitled", raw.slice("untitled:".length));
			return makeUri("file", raw);
		},
	},
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { KeyF: 36, KeyZ: 56, KeyY: 55 },
	languages: noopProxy({
		CompletionItemKind: { File: 1, Keyword: 2, Text: 3, Snippet: 4, Field: 5, Struct: 6 },
		SymbolKind: { Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Function: 11, Variable: 12, Constant: 13, String: 14, Object: 18, Key: 19, Struct: 22 },
		FoldingRangeKind: { Comment: "comment", Imports: "imports", Region: "region" },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
	}),
	editor: noopProxy({
		EndOfLineSequence: { LF: 0, CRLF: 1 },
		ScrollType: { Immediate: 1 },
		getEditors: () => [],
		getModels: () => [],
		getModel: () => null,
		createModel: () => null,
		onDidCreateModel: () => ({ dispose() {} }),
		setModelMarkers() {},
		getModelMarkers: () => [],
		registerEditorOpener: () => ({ dispose() {} }),
	}),
}));

// The view finds its backend from the page's address (as r4aMarkdownCm6.test.ts gives it one).
if (typeof (globalThis as any).location === "undefined") {
	(globalThis as any).location = (globalThis as any).window.location ?? { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" };
}

const { connect, disconnectForTest } = await import("../src/view/backend");
const { liveBlockField, liveCallbacksFacet, refreshLiveEffect, settleFolds } = await import("../src/view/editor/cmLivePlugin");
const { pressBecomes, renderedKeepsStyle, RENDERED_PURIFY_CONFIG, styleWithoutFetches } = await import("../src/view/editor/cmLiveShared");
const { hydrateImagesInElement, invalidateImageCache, pictureDrawnAgain, rehydrateImages } = await import("../src/view/editor/imageResolve");
const { setState } = await import("../src/view/state");
const { flush } = await import("solid-js");

const source = (rel: string) => readFileSync(resolve(import.meta.dir, "..", rel), "utf8");

/** A document in the live editor, as its block decorations are built: the cursor on the first line. */
const liveState = (doc: string, filePath: string) =>
	EditorState.create({
		doc,
		selection: EditorSelection.cursor(0),
		extensions: [markdown({ base: markdownLanguage }), liveCallbacksFacet.of({ filePath: () => filePath } as any), liveBlockField],
	});

/** The block widgets of one kind in a document, in its order. */
function widgetsOf(state: EditorState, kind: string): any[] {
	const out: any[] = [];
	state.field(liveBlockField).between(0, state.doc.length, (_from, _to, deco) => {
		if (deco.spec.widget?.constructor.name === kind) out.push(deco.spec.widget);
	});
	return out;
}

/** Where CodeMirror draws again for a transaction because a decoration is not what it was (the comparison its view runs). */
function redrawn(before: EditorState, tr: Transaction): [number, number][] {
	const out: [number, number][] = [];
	RangeSet.compare([before.field(liveBlockField)], [tr.state.field(liveBlockField)], tr.changes, {
		compareRange: (from, to) => void out.push([from, to]),
		comparePoint: (from, to) => void out.push([from, to]),
		boundChange: (pos) => void out.push([pos, pos]),
	});
	return out;
}

// --- 1. B2-6: a `<details>` block's open state stays with the block ---------------------------------------------

describe("the live editor's folds (<details>): what is remembered stays with its block", () => {
	const fold = (summary: string, body: string) => `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
	const TUESDAY = fold("Notes", "The courier came on Tuesday.");
	const FRIDAY = fold("Notes", "The sample was logged on Friday.");
	const NEW = fold("Notes", "Nothing yet.");
	// A file for each test: what is remembered is kept by file for as long as the app runs.
	let files = 0;
	const file = () => `/w4/docs/folds-${files++}.md`;
	/** Whether each fold of the document is drawn open, in the document's order. */
	const drawnOpen = (state: EditorState) => widgetsOf(state, "DetailsWidget").map((widget) => widget.drawnOpen as boolean);

	test("a block written above two with its summary takes neither's state, and each keeps its own", () => {
		const before = liveState(`Intro\n\n${TUESDAY}\n\nBetween\n\n${FRIDAY}\n\nAfter\n`, file());
		const [, friday] = widgetsOf(before, "DetailsWidget");
		expect(drawnOpen(before)).toEqual([false, false]);
		// The second is opened: this is what its element's `toggle` does.
		friday.leftOpen(true);
		expect(drawnOpen(before)).toEqual([false, true]);

		// A third "Notes" is written above them. It was: the first drawn open, the second closed.
		const added = before.update({ changes: { from: "Intro\n\n".length, insert: `${NEW}\n\n` } });
		expect(drawnOpen(added.state)).toEqual([false, false, true]);

		// The one in the middle is closed by hand and then removed: the last is still the open one, and the new one
		// has still not been touched.
		const [, tuesday] = widgetsOf(added.state, "DetailsWidget");
		tuesday.leftOpen(false);
		const at = added.state.doc.toString().indexOf(TUESDAY);
		const removed = added.state.update({ changes: { from: at, to: at + TUESDAY.length + 2 } });
		expect(removed.state.doc.toString()).not.toContain("Tuesday");
		expect(drawnOpen(removed.state)).toEqual([false, true]);

		// And with the new one gone too it is the only "Notes", and open.
		const alone = removed.state.update({ changes: { from: "Intro\n\n".length, to: "Intro\n\n".length + NEW.length + 2 } });
		expect(drawnOpen(alone.state)).toEqual([true]);
	});

	test("the first of two with one summary removed: the second keeps its own state, not the first's", () => {
		const before = liveState(`Intro\n\n${TUESDAY}\n\n${FRIDAY}\n\nAfter\n`, file());
		const [tuesday, friday] = widgetsOf(before, "DetailsWidget");
		tuesday.leftOpen(true);
		friday.leftOpen(false);
		const removed = before.update({ changes: { from: "Intro\n\n".length, to: "Intro\n\n".length + TUESDAY.length + 2 } });
		// It was: drawn open, as the block that is gone had been left.
		expect(drawnOpen(removed.state)).toEqual([false]);
	});

	test("a summary typed above, passing through the summary of a block below, does not touch that block", () => {
		const above = fold("Note", "Nothing yet.");
		const before = liveState(`Intro\n\n${above}\n\n${FRIDAY}\n\nAfter\n`, file());
		widgetsOf(before, "DetailsWidget")[1].leftOpen(true);
		// "Note" becomes "Notes": for this one letter the two have one summary.
		const end = before.doc.toString().indexOf("Note</summary>") + "Note".length;
		const same = before.update({ changes: { from: end, insert: "s" } });
		expect(same.state.doc.toString()).toContain(`${NEW}\n\n${FRIDAY}`);
		expect(drawnOpen(same.state)).toEqual([false, true]);
		// ... and "Notes on Friday" is another summary again.
		const on = same.state.update({ changes: { from: end + 1, insert: " on Friday" } });
		expect(drawnOpen(on.state)).toEqual([false, true]);
	});

	test("a block cut and put back above another with its summary is still the one that was open", () => {
		const before = liveState(`Intro\n\n${TUESDAY}\n\n${FRIDAY}\n\nAfter\n`, file());
		widgetsOf(before, "DetailsWidget")[1].leftOpen(true);
		const at = before.doc.toString().indexOf(FRIDAY);
		const cut = before.update({ changes: { from: at, to: at + FRIDAY.length + 2 } });
		expect(drawnOpen(cut.state)).toEqual([false]);
		const pasted = cut.state.update({ changes: { from: "Intro\n\n".length, insert: `${FRIDAY}\n\n` } });
		expect(pasted.state.doc.toString()).toContain(`${FRIDAY}\n\n${TUESDAY}`);
		expect(drawnOpen(pasted.state)).toEqual([true, false]);
	});

	test("what held before still holds: a block whose text is edited, and a block with another summary above", () => {
		const before = liveState(`Intro\n\n${TUESDAY}\n\n${FRIDAY}\n\nAfter\n`, file());
		const [tuesday, friday] = widgetsOf(before, "DetailsWidget");
		tuesday.leftOpen(true);
		friday.leftOpen(false);
		// Each is edited in turn, with no toggle between: each keeps its own.
		const one = before.update({ changes: { from: before.doc.toString().indexOf("Tuesday."), insert: "late on " } });
		const two = one.state.update({ changes: { from: one.state.doc.toString().indexOf("Friday."), insert: "early on " } });
		expect(two.state.doc.toString()).toContain("came on late on Tuesday.");
		expect(drawnOpen(two.state)).toEqual([true, false]);
		// A fold with another summary above renumbers neither.
		const other = two.state.update({ changes: { from: "Intro\n\n".length, insert: `${fold("Something else", "Not a note.")}\n\n` } });
		expect(drawnOpen(other.state)).toEqual([false, true, false]);
		// The widget for a block that only moved down is the same one: its element, and whether it is open, stay.
		const [, tuesdayMoved] = widgetsOf(other.state, "DetailsWidget");
		expect(tuesdayMoved.eq(widgetsOf(two.state, "DetailsWidget")[0])).toBe(true);
	});

	test("a code fence typed in a block: the blocks below are not blocks until it is closed, and all are as they were left", () => {
		const third = fold("Notes", "The report went out on Monday.");
		const before = liveState(`Intro\n\n${TUESDAY}\n\n${FRIDAY}\n\n${third}\n\nAfter\n`, file());
		const [tuesday, , monday] = widgetsOf(before, "DetailsWidget");
		tuesday.leftOpen(true);
		monday.leftOpen(true);
		expect(drawnOpen(before)).toEqual([true, false, true]);
		// The fence is opened in the first block's text ...
		const at = before.doc.toString().indexOf("The courier");
		const opened = before.update({ changes: { from: at, insert: "```sql\nSELECT 1\n" } });
		expect(drawnOpen(opened.state)).toEqual([]);
		// ... and closed.
		const closed = opened.state.update({ changes: { from: at + "```sql\nSELECT 1\n".length, insert: "```\n\n" } });
		expect(closed.state.doc.toString()).toContain("```sql\nSELECT 1\n```\n\nThe courier came on Tuesday.");
		expect(drawnOpen(closed.state)).toEqual([true, false, true]);
	});

	test("a block as its Markdown says while nothing is remembered: `<details open>` is open, and can be left closed", () => {
		const opened = "<details open>\n<summary>Notes</summary>\n\nShown from the start.\n\n</details>";
		const before = liveState(`Intro\n\n${opened}\n\n${FRIDAY}\n\nAfter\n`, file());
		expect(drawnOpen(before)).toEqual([true, false]);
		widgetsOf(before, "DetailsWidget")[0].leftOpen(false);
		expect(drawnOpen(before)).toEqual([false, false]);
	});

	describe("settleFolds: which remembered state belongs to which block of one summary", () => {
		const open = (body: string) => ({ open: true, body });
		const shut = (body: string) => ({ open: false, body });
		/** With every place written out: a place nothing is remembered at reads `undefined`. */
		const settled = (kept: (ReturnType<typeof open> | undefined)[], bodies: string[]) => Array.from(settleFolds(kept, bodies));

		test("a block that stands where it stood, with the text it had, keeps what is there", () => {
			expect(settled([shut("a"), open("b")], ["a", "b"])).toEqual([shut("a"), open("b")]);
			expect(settled([undefined, open("b")], ["a", "b"])).toEqual([undefined, open("b")]);
			expect(settled([], ["a", "b"])).toEqual([]);
		});

		test("blocks added or removed above it: it takes its own along, and the newcomer takes nothing", () => {
			expect(settled([undefined, open("b")], ["new", "a", "b"])).toEqual([undefined, undefined, open("b")]);
			expect(settled([open("a")], ["new", "a"])).toEqual([undefined, open("a")]);
			expect(settled([shut("a"), open("b"), shut("c")], ["b", "c"]).slice(0, 2)).toEqual([open("b"), shut("c")]);
			// Two that changed places.
			expect(settled([shut("a"), open("b")], ["b", "a"])).toEqual([open("b"), shut("a")]);
		});

		test("a block whose text was edited keeps what is at its place, with the new text", () => {
			expect(settled([shut("a"), open("b")], ["a", "b, edited"])).toEqual([shut("a"), open("b, edited")]);
			expect(settled([shut("a"), open("b")], ["a, edited", "b, edited"])).toEqual([shut("a, edited"), open("b, edited")]);
		});

		test("a neighbour's is never taken: what is at a block's place and belongs to a text still in the document is left", () => {
			// A new block stands where "b" stood, and "b" is still in the document, one place down.
			expect(settled([shut("a"), open("b")], ["a", "new", "b"])).toEqual([shut("a"), undefined, open("b")]);
			// What was remembered twice for one text (it stood at both places in turn) is given once.
			expect(settled([open("a"), open("a")], ["new", "a"])).toEqual([undefined, open("a")]);
		});

		test("a block that is not in the document keeps its state for when it is back", () => {
			// The only one, gone (cut, or its closing tag half-typed), and back with another text.
			expect(settled([open("a")], [])).toEqual([open("a")]);
			expect(settled(settled([open("a")], []), ["a, edited"])).toEqual([open("a, edited")]);
			// The first of two gone: the second moves up with its own, and the first's waits after it ...
			const gone = settled([shut("a"), open("b")], ["b"]);
			expect(gone).toEqual([open("b"), shut("a")]);
			// ... and is found by its text when the block is back.
			expect(settled(gone, ["a", "b"])).toEqual([shut("a"), open("b")]);
		});

		test("the blocks below a code fence being typed are all absent for a while, and all keep their state", () => {
			// Until the fence is closed nothing below it is read as a block: only the one above is in the document.
			const below = Array.from({ length: 30 }, (_, n) => (n % 2 ? open(`block ${n}`) : shut(`block ${n}`)));
			const typing = settled([open("above"), ...below], ["above"]);
			expect(typing).toEqual([open("above"), ...below]);
			// The fence is closed: each is back at its place, and the one it was typed in has another text.
			const closed = ["above", "block 0, with code", ...below.slice(1).map((kept) => kept.body)];
			expect(settled(typing, closed)).toEqual([open("above"), shut("block 0, with code"), ...below.slice(1)]);
		});

		test("what is remembered for absent blocks under one summary has an end", () => {
			const many = Array.from({ length: 500 }, (_, n) => open(`gone ${n}`));
			expect(settled(many, ["here"]).length).toBeLessThanOrEqual(1 + 64);
			expect(settled(many, []).length).toBeLessThanOrEqual(64);
		});

		test("two blocks with one summary and one text are told apart by their order alone", () => {
			expect(settled([open("same"), shut("same")], ["same", "same"])).toEqual([open("same"), shut("same")]);
			// Nothing was remembered for the first: the second's is not moved up to it.
			expect(settled([undefined, shut("same")], ["same", "same"])).toEqual([undefined, shut("same")]);
		});
	});

	test("the element is drawn open as `drawnOpen` says and its toggle remembers through `leftOpen` (read from the source: it needs a DOM)", () => {
		const plugin = source("src/view/editor/cmLivePlugin.ts");
		expect(plugin).toContain("details.open = this.drawnOpen;");
		expect(plugin).toMatch(/details\.addEventListener\("toggle", \(\) => \{\s*this\.leftOpen\(details\.open\);\s*\}\);/);
		// Settled once for each build of the decorations, before a widget is drawn.
		expect(plugin).toContain("for (const [summaryMd, bodies] of detailsSeen) settleDetailsOpen(filePath, summaryMd, bodies);");
	});
});

// --- 2. B2-8: a picture is asked for again when its file appears or changes --------------------------------------

/** An element that keeps what is put in it, in place of the browser's: a picture needs no more to be put together. */
class StandInElement {
	readonly children: StandInElement[] = [];
	readonly style: Record<string, string> = {};
	readonly classList = { add() {}, remove() {} };
	isConnected = true;
	className = "";
	textContent = "";
	src = "";
	constructor(readonly tag: string) {}
	parent: StandInElement | null = null;
	appendChild(child: StandInElement) {
		child.remove();
		child.parent = this;
		this.children.push(child);
		return child;
	}
	prepend(child: StandInElement) {
		child.remove();
		child.parent = this;
		this.children.unshift(child);
	}
	remove() {
		const at = this.parent?.children.indexOf(this) ?? -1;
		if (at >= 0) this.parent!.children.splice(at, 1);
		this.parent = null;
	}
	setAttribute() {}
	addEventListener() {}
	within(): StandInElement[] {
		return [this, ...this.children.flatMap((child) => child.within())];
	}
}

describe("the live editor's pictures: asked for again when the file appears or changes", () => {
	const ROOT = "/w4";
	/** What the workspace lists, what each picture file holds, and every time a picture's bytes were asked for. */
	const listed: string[] = [];
	const held = new Map<string, string>();
	const asked: string[] = [];
	let realSocket: unknown;

	/** The backend, as far as a picture needs it: the list of files, and a picture's bytes or "no such file". */
	class PictureSocket extends EventTarget {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;
		readyState = 0;
		constructor(_url: string) {
			super();
			queueMicrotask(() => {
				this.readyState = 1;
				this.dispatchEvent(new Event("open"));
			});
		}
		send(raw: string) {
			const { id, method, args } = JSON.parse(raw) as { id: number; method: string; args: unknown[] };
			let reply: Record<string, unknown> = { id, result: null };
			if (method === "files") reply = { id, result: [...listed] };
			if (method === "image") {
				const path = String(args[0]);
				asked.push(path);
				const bytes = held.get(path);
				reply = bytes === undefined ? { id, error: `ENOENT: no such file, open '${path}'` } : { id, result: { type: "image/png", base64: Buffer.from(bytes).toString("base64") } };
			}
			queueMicrotask(() => {
				if (this.readyState === 1) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(reply) }));
			});
		}
		close() {
			this.readyState = 3;
		}
	}

	beforeAll(async () => {
		realSocket = (globalThis as any).WebSocket;
		(globalThis as any).WebSocket = PictureSocket;
		await connect();
		setState((s) => {
			s.workspace = { root: ROOT, name: "w4" };
			s.project = null;
		});
		flush();
	});

	afterAll(() => {
		disconnectForTest();
		(globalThis as any).WebSocket = realSocket;
		invalidateImageCache();
		setState((s) => {
			s.workspace = null;
		});
		flush();
	});

	/** The workspace's files have changed: what a save, the watcher's news of a file and the Explorer read again all do. */
	const filesChanged = () => {
		setState((s) => {
			s.treeVersion += 1;
		});
		flush();
	};
	/** What the editor does when it hears of that: it builds its decorations again. */
	let refreshes = 0;
	const told = (state: EditorState) => state.update({ effects: refreshLiveEffect.of(++refreshes) });
	const settled = async () => {
		for (let i = 0; i < 6; i++) await new Promise((done) => setTimeout(done, 0));
	};

	/** What a drawn picture shows: "Image not found" with its address, or the picture. */
	const shown = (wrap: StandInElement) => {
		const all = wrap.within();
		return { missing: all.find((el) => el.className === "cm-md-image-missing")?.textContent ?? null, src: all.find((el) => el.tag === "img")?.src ?? "" };
	};
	/** Draws a picture's widget and waits for its file: what the reader sees at once (`first`), and then. */
	async function draw(widget: any, state: EditorState): Promise<{ missing: string | null; src: string; first: { missing: string | null; src: string } }> {
		const doc = (globalThis as any).document;
		const real = doc.createElement;
		doc.createElement = (tag: string) => new StandInElement(tag);
		try {
			const wrap: StandInElement = widget.toDOM({ state, posAtDOM: () => 0, focus() {}, dispatch() {} });
			const first = shown(wrap);
			// "Image not found" is an element made when the answer has come.
			await settled();
			return { ...shown(wrap), first };
		} finally {
			doc.createElement = real;
		}
	}

	const reset = () => {
		listed.length = 0;
		held.clear();
		asked.length = 0;
	};

	test("a picture that was not found is drawn again when the workspace's files change, and then found", async () => {
		reset();
		const file = `${ROOT}/docs/chart.png`;
		const before = liveState("Intro\n\n![Chart](chart.png)\n\nAfter\n", `${ROOT}/docs/found-later.md`);
		const [drawn] = widgetsOf(before, "ImageWidget");
		// Nothing is known of it yet: an empty picture at once, and "Image not found" when the answer has come.
		expect(await draw(drawn, before)).toEqual({ missing: "Image not found: chart.png", src: "", first: { missing: null, src: "" } });
		expect(asked).toEqual([file]);

		// A letter typed above it: the same picture, and nothing is asked.
		const typed = before.update({ changes: { from: 0, insert: "x" } });
		expect(widgetsOf(typed.state, "ImageWidget")[0].eq(drawn)).toBe(true);
		expect(redrawn(before, typed)).toEqual([]);

		// The file is put there. It was: the same widget still, and "Image not found" for as long as the document was open.
		listed.push(file);
		held.set(file, "first");
		filesChanged();
		const after = told(before);
		const [again] = widgetsOf(after.state, "ImageWidget");
		expect(again.eq(drawn)).toBe(false);
		expect(redrawn(before, after).length).toBeGreaterThan(0);
		const second = await draw(again, after.state);
		// It says "not found" until the answer says otherwise, and then the picture stands where the words stood.
		expect(second.first).toEqual({ missing: "Image not found: chart.png", src: "" });
		expect(second.missing).toBeNull();
		expect(second.src).toBe(`data:image/png;base64,${Buffer.from("first").toString("base64")}`);
		expect(asked).toEqual([file, file]);

		// Found: the same picture at every later update, whatever else changes in the workspace, and nothing asked.
		filesChanged();
		const later = told(after.state);
		expect(widgetsOf(later.state, "ImageWidget")[0].eq(again)).toBe(true);
		expect(redrawn(after.state, later)).toEqual([]);
		expect(asked.length).toBe(2);
	});

	test("a picture still not found is asked for once for each change, not at each update", async () => {
		reset();
		const before = liveState("Intro\n\n![Chart](missing.png)\n\nAfter\n", `${ROOT}/docs/still-missing.md`);
		const [drawn] = widgetsOf(before, "ImageWidget");
		expect((await draw(drawn, before)).missing).toBe("Image not found: missing.png");
		expect(asked.length).toBe(1);

		// Updates with no change in the workspace: the same picture each time.
		const idle = told(told(before).state);
		expect(widgetsOf(idle.state, "ImageWidget")[0].eq(drawn)).toBe(true);

		// A change: drawn again once. A second look before the file has been asked for is not another cause.
		filesChanged();
		const first = told(idle.state);
		const [again] = widgetsOf(first.state, "ImageWidget");
		expect(again.eq(drawn)).toBe(false);
		const second = told(first.state);
		expect(widgetsOf(second.state, "ImageWidget")[0].eq(again)).toBe(true);
		// Drawn again and still missing: the words stand from the start, and do not go and come back.
		const stillMissing = await draw(again, second.state);
		expect(stillMissing.first.missing).toBe("Image not found: missing.png");
		expect(stillMissing.missing).toBe("Image not found: missing.png");
		expect(asked.length).toBe(2);
		// Still missing, and nothing has changed since it was asked for: it rests.
		const third = told(second.state);
		expect(widgetsOf(third.state, "ImageWidget")[0].eq(again)).toBe(true);
		expect(asked.length).toBe(2);

		// The next change is a cause again.
		filesChanged();
		expect(widgetsOf(told(third.state).state, "ImageWidget")[0].eq(again)).toBe(false);
	});

	test("a picture read from a file is drawn again when that file changed, and the others are left", async () => {
		reset();
		const [a, b] = [`${ROOT}/docs/a.png`, `${ROOT}/docs/b.png`];
		listed.push(a, b);
		held.set(a, "a, as first drawn");
		held.set(b, "b");
		const remote = "https://example.test/r.png";
		const path = `${ROOT}/docs/changed.md`;
		const before = liveState(`Intro\n\n![A](a.png)\n\n![B](b.png)\n\n![R](${remote})\n\nAfter\n`, path);
		const [wa, wb, wr] = widgetsOf(before, "ImageWidget");
		const firstA = await draw(wa, before);
		expect((await draw(wb, before)).missing).toBeNull();
		expect((await draw(wr, before)).src).toBe(remote);
		expect(asked).toEqual([a, b]);

		// a.png is written again outside the app: the watcher's news drops what was read of it and counts a change.
		held.set(a, "a, as changed");
		invalidateImageCache(a);
		filesChanged();
		const after = told(before);
		const [wa2, wb2, wr2] = widgetsOf(after.state, "ImageWidget");
		// It was: the same widget, and the old picture until the document was closed and opened.
		expect(wa2.eq(wa)).toBe(false);
		expect(wb2.eq(wb)).toBe(true);
		expect(wr2.eq(wr)).toBe(true);
		const secondA = await draw(wa2, after.state);
		expect(secondA.src).not.toBe(firstA.src);
		expect(secondA.src).toBe(`data:image/png;base64,${Buffer.from("a, as changed").toString("base64")}`);
		expect(asked).toEqual([a, b, a]);

		// Its file removed: drawn again, and now not found; put back: drawn again, and found.
		held.delete(a);
		listed.splice(listed.indexOf(a), 1);
		invalidateImageCache(a);
		filesChanged();
		const gone = told(after.state);
		const [wa3] = widgetsOf(gone.state, "ImageWidget");
		expect(wa3.eq(wa2)).toBe(false);
		expect((await draw(wa3, gone.state)).missing).toBe("Image not found: a.png");
		listed.push(a);
		held.set(a, "a, put back");
		filesChanged();
		const back = told(gone.state);
		const [wa4, wb4] = widgetsOf(back.state, "ImageWidget");
		expect(wa4.eq(wa3)).toBe(false);
		expect((await draw(wa4, back.state)).missing).toBeNull();
		// b.png was never asked for a second time, through all of it.
		expect(wb4.eq(wb)).toBe(true);
		expect(asked.filter((file) => file === b).length).toBe(1);
	});

	test("a picture inside a card is asked for again when its file appears or changes, and the card is not drawn again", async () => {
		reset();
		const doc = `${ROOT}/docs/card.md`;
		const [later, there] = [`${ROOT}/docs/in-card.png`, `${ROOT}/docs/there.png`];
		listed.push(there);
		held.set(there, "there from the start");
		/** An `<img>` as a callout, a table cell or a `<details>` block holds it: written with its address, and in the window. */
		const picture = (written: string) => ({ isConnected: true, src: "", getAttribute: (name: string) => (name === "src" ? written : null) });
		const [missing, found] = [picture("in-card.png"), picture("there.png")];
		const card = { querySelectorAll: () => [missing, found] };
		hydrateImagesInElement(card as never, doc);
		await settled();
		expect(missing.src).toBe("");
		expect(found.src).toBe(`data:image/png;base64,${Buffer.from("there from the start").toString("base64")}`);
		expect(asked).toEqual([later, there]);

		// Nothing has changed in the workspace: nothing is asked.
		rehydrateImages(card as never);
		await settled();
		expect(asked.length).toBe(2);

		// The missing one's file is put there. It was: never asked for again while its card stood.
		listed.push(later);
		held.set(later, "in the card");
		filesChanged();
		rehydrateImages(card as never);
		await settled();
		expect(missing.src).toBe(`data:image/png;base64,${Buffer.from("in the card").toString("base64")}`);
		expect(asked).toEqual([later, there, later]);
		// Once for the change, and the picture that was there all along not at all.
		rehydrateImages(card as never);
		await settled();
		expect(asked.length).toBe(3);

		// The other's file is written again.
		held.set(there, "there, changed");
		invalidateImageCache(there);
		filesChanged();
		rehydrateImages(card as never);
		await settled();
		expect(found.src).toBe(`data:image/png;base64,${Buffer.from("there, changed").toString("base64")}`);
		expect(asked).toEqual([later, there, later, there]);

		// An `<img>` that no card put there is not this function's to change.
		const stranger = picture("in-card.png");
		filesChanged();
		rehydrateImages({ querySelectorAll: () => [stranger] } as never);
		await settled();
		expect(stranger.src).toBe("");
		expect(asked.length).toBe(4);
	});

	test("the editor asks for the cards' pictures when the workspace's files change (read from the source: an effect in a component)", () => {
		const editor = source("src/view/editor/MarkdownLiveEditor.tsx");
		expect(editor).toMatch(/\(\) => \[docs\(\), state\.treeVersion\] as const,\s*\(\) => \{[^}]*refreshLiveEffect\.of\(\+\+refreshSeq\)[^}]*\}\)\);[\s\S]{0,200}?untrack\(\(\) => rehydrateImages\(\)\);/);
	});

	test("the count of causes: none for a picture never drawn, or one on the network, and one for each change while missing", async () => {
		reset();
		const doc = `${ROOT}/docs/count.md`;
		expect(pictureDrawnAgain("never.png", doc, 7)).toBe(0);
		expect(pictureDrawnAgain("never.png", doc, 8)).toBe(0);

		const state = liveState("Intro\n\n![N](nowhere.png)\n", doc);
		await draw(widgetsOf(state, "ImageWidget")[0], state);
		// Asked with the count the workspace had when it was looked for: no cause. With another: one, and only one.
		const now = pictureDrawnAgain("nowhere.png", doc);
		expect(pictureDrawnAgain("nowhere.png", doc)).toBe(now);
		expect(pictureDrawnAgain("nowhere.png", doc, -1)).toBe(now + 1);
		expect(pictureDrawnAgain("nowhere.png", doc, -2)).toBe(now + 1);
		// The same address in another document is another picture.
		expect(pictureDrawnAgain("nowhere.png", `${ROOT}/docs/other.md`, -1)).toBe(0);

		// A picture on the network is nothing a file of the workspace changes.
		const remote = "https://example.test/r.png";
		const online = liveState(`Intro\n\n![R](${remote})\n`, doc);
		expect((await draw(widgetsOf(online, "ImageWidget")[0], online)).src).toBe(remote);
		expect(pictureDrawnAgain(remote, doc, -1)).toBe(0);
		expect(asked).toEqual([`${ROOT}/docs/nowhere.png`]);
	});
});

// --- 3. B2-5: a click on a link in the diagram viewer reaches the link -------------------------------------------

describe("the diagram viewer: a press on the drawing is a click or a pan", () => {
	test("a press is a click until it has moved further than a hand trembles, and a pan from then on", () => {
		expect(pressBecomes(0, 0, 1)).toBe("press");
		expect(pressBecomes(1, -1, 1)).toBe("press");
		expect(pressBecomes(2, -2, 1)).toBe("press");
		expect(pressBecomes(3, 2, 1)).toBe("pan");
		expect(pressBecomes(0, -5, 1)).toBe("pan");
		expect(pressBecomes(-40, 12, 1)).toBe("pan");
		// Another button held with the first changes nothing.
		expect(pressBecomes(1, 1, 5)).toBe("press");
		expect(pressBecomes(9, 0, 3)).toBe("pan");
	});

	test("a move with the button no longer down is no drag: the press was let go where the viewer did not hear of it", () => {
		expect(pressBecomes(0, 0, 0)).toBe("released");
		expect(pressBecomes(120, 80, 0)).toBe("released");
		// Only another button down: the one that pressed is up.
		expect(pressBecomes(120, 80, 2)).toBe("released");
	});

	test("the pointer is taken hold of when the press becomes a pan, not when it goes down (read from the source: JSX in a window)", () => {
		const editor = source("src/view/editor/MarkdownLiveEditor.tsx");
		const stage = editor.indexOf('class="md-lightbox-stage md-mermaid-lightbox-stage"');
		const down = editor.indexOf("onPointerDown={(e) => {", stage);
		const move = editor.indexOf("onPointerMove={(e) => {", down);
		const up = editor.indexOf("onPointerUp={", move);
		expect(stage).toBeGreaterThan(0);
		expect(down).toBeGreaterThan(stage);
		expect(move).toBeGreaterThan(down);
		expect(up).toBeGreaterThan(move);
		// Held from the press, Chromium gave the click to the stage and never to the link under the pointer.
		expect(editor.slice(down, move)).not.toContain("setPointerCapture(");
		expect(editor.slice(down, move)).toContain("mermaidDragged = false;");
		const moving = editor.slice(move, up);
		expect(moving).toContain("const became = pressBecomes(dx, dy, e.buttons);");
		expect(moving).toMatch(/if \(became === "released"\) \{\s*mermaidPan = null;\s*return;\s*\}/);
		expect(moving).toMatch(/if \(became === "pan" && !mermaidDragged\) \{\s*mermaidDragged = true;[\s\S]*?setPointerCapture\(e\.pointerId\);\s*\}/);
		expect(moving.match(/setPointerCapture\(/g)?.length).toBe(1);
		// The half that was right stays: the links are guarded, and the click that ends a pan follows none.
		const guard = editor.slice(editor.lastIndexOf("guardRenderedLinks(el, (href) => {", down), down);
		expect(guard).toMatch(/const panned = mermaidDragged;\s*mermaidDragged = false;\s*if \(panned\) return;/);
		expect(guard).toContain("void followLink(href);");
	});
});

// --- 4. B2-7: what a rendered document's own HTML may start or fetch ---------------------------------------------

describe("rendered Markdown: media does not start by itself, and a style fetches nothing", () => {
	const REMOTE = "https://example.test/t.png";

	test("`autoplay` is taken off what is left; `controls` and the rest of a player stay", () => {
		expect(RENDERED_PURIFY_CONFIG.FORBID_ATTR).toContain("autoplay");
		// DOMPurify lower-cases an attribute's name before it looks it up.
		for (const attr of RENDERED_PURIFY_CONFIG.FORBID_ATTR) expect(attr).toBe(attr.toLowerCase());
		for (const attr of ["controls", "src", "loop", "muted", "poster", "preload", "width", "height", "style"]) {
			expect(RENDERED_PURIFY_CONFIG.FORBID_ATTR).not.toContain(attr);
		}
		// The elements themselves are not what this is about.
		for (const tag of ["video", "audio", "source", "img"]) expect(RENDERED_PURIFY_CONFIG.FORBID_TAGS).not.toContain(tag);
	});

	test("a declaration that loads from an address goes, and the others stay as written", () => {
		expect(styleWithoutFetches(`background:url(${REMOTE})`)).toBe("");
		expect(styleWithoutFetches(`color: red; background: url(${REMOTE}); font-weight: bold`)).toBe("color: red; font-weight: bold");
		expect(styleWithoutFetches(`background: url(${REMOTE}); color: red;`)).toBe(" color: red;");
		// An address in the document's own folder is fetched all the same.
		expect(styleWithoutFetches("background-image: url(attachments/logo.png)")).toBe("");
		expect(styleWithoutFetches("background: url(data:image/png;base64,AAAA)")).toBe("");
	});

	test("a style with nothing to take out is returned untouched", () => {
		for (const style of [
			"color: red; width: 50%",
			"position:fixed;inset:0;z-index:99999",
			'font-family: "Courier New", monospace',
			"background: linear-gradient(to right, red, blue)",
			"width: calc(100% - 2em); transform: rotate(3deg)",
			'content: "a;b"; color: red',
			"color: var(--accent)",
			"/* a note; with a semicolon */ color: red",
			"",
			";;",
		]) {
			expect(styleWithoutFetches(style)).toBe(style);
		}
		// `url (` is not the function (a space parts the name from the bracket): the browser fetches nothing for it.
		expect(styleWithoutFetches("background: url (x.png)")).toBe("background: url (x.png)");
	});

	test("however `url(` is spelt: case, quotes, escapes, and comments about it", () => {
		const spellings = [
			`background:URL(${REMOTE})`,
			`BACKGROUND: uRl(${REMOTE})`,
			`background: url("${REMOTE}")`,
			`background: url('${REMOTE}')`,
			`background: url(  "${REMOTE}"  )`,
			`background: #fff url(${REMOTE}) no-repeat`,
			// Escapes in the name: a code point in hex (with and without the space that ends it), and a letter escaped as itself.
			`background: u\\72l(${REMOTE})`,
			`background: \\75rl(${REMOTE})`,
			`background: \\75 rl(${REMOTE})`,
			`background: \\000075rl(${REMOTE})`,
			`background: \\55RL(${REMOTE})`,
			`background: ur\\l(${REMOTE})`,
			`background: \\u\\r\\l(${REMOTE})`,
			`background: \\75\\72\\6c(${REMOTE})`,
			// The space after an escape's digits may be a tab or a line end, and CR LF is one line end.
			`background: \\75\trl(${REMOTE})`,
			`background: \\75\nrl(${REMOTE})`,
			`background: \\75\r\nrl(${REMOTE})`,
			`background: \\75\rrl(${REMOTE})`,
			// Comments beside it, and a `;` that is in a comment or in the address and ends nothing.
			`background:/**/url(${REMOTE})`,
			`background: url(${REMOTE})/* note */`,
			`/* a note; here */background: url(${REMOTE})`,
			`background: /* \\*/ url(${REMOTE})`,
			`background: url("https://example.test/a;b.png")`,
			`background: url(https://example.test/a;b.png)`,
			// Never closed: the browser closes it at the end of the attribute.
			`background: url(${REMOTE}`,
			`background: url("${REMOTE}`,
		];
		for (const style of spellings) {
			expect(styleWithoutFetches(style)).toBe("");
			// And beside declarations that stay, those stay and it goes.
			const kept = styleWithoutFetches(`color: red; ${style}`);
			expect(kept).toBe("color: red");
			expect(styleWithoutFetches(`${style}; color: red`).includes("example.test")).toBe(false);
		}
	});

	test("the other ways CSS names an address: image-set() with a bare string, src(), image(), and any property", () => {
		for (const style of [
			`background-image: image-set("${REMOTE}" 1x)`,
			`background-image: -webkit-image-set("${REMOTE}" 1x, "${REMOTE}" 2x)`,
			`background-image: IMAGE-SET(url(${REMOTE}) 1x)`,
			`background-image: image\\-set("${REMOTE}" 1x)`,
			`background-image: \\69mage-set("${REMOTE}" 1x)`,
			// The string comes from a variable set on another element: nothing in this one names an address.
			"background-image: image-set(var(--from-elsewhere) 1x)",
			`background-image: src("${REMOTE}")`,
			"background-image: src(var(--from-elsewhere))",
			`background-image: image("${REMOTE}")`,
			`background-image: cross-fade(url(${REMOTE}), url(${REMOTE}), 50%)`,
			`list-style: square url(${REMOTE})`,
			`list-style-image: url(${REMOTE})`,
			`cursor: url(${REMOTE}), auto`,
			`content: url(${REMOTE})`,
			`border-image: url(${REMOTE}) 30 round`,
			`mask-image: url(${REMOTE})`,
			`-webkit-mask: url(${REMOTE})`,
			`filter: url(${REMOTE}#f)`,
			`clip-path: url(${REMOTE}#c)`,
			`shape-outside: url(${REMOTE})`,
			// A variable that holds an address is an address waiting to be used.
			`--bg: url(${REMOTE})`,
		]) {
			expect(styleWithoutFetches(style)).toBe("");
			expect(styleWithoutFetches(`color: red; ${style}; font-weight: bold`)).toBe("color: red; font-weight: bold");
		}
	});

	test("a cut in the wrong place cannot let a fetch through: what is kept never spells one", () => {
		// Strings, brackets and comments left open, so that the pieces are not the declarations the browser will read.
		for (const style of [
			`content: "x; background: url(${REMOTE})`,
			`content: 'x; background: url(${REMOTE}); color: red`,
			`width: calc(1px; background: url(${REMOTE})`,
			`color: red /* open; background: url(${REMOTE})`,
			`color: red; } background: url(${REMOTE})`,
			`a\;b: c; background: url(${REMOTE}); d: e\\`,
			`color: red;background: u;rl(${REMOTE});\\75rl(${REMOTE})`,
		]) {
			const kept = styleWithoutFetches(style);
			expect(kept.toLowerCase()).not.toContain("url(");
			expect(kept).not.toMatch(/\\75|\\55/);
		}
		// `u;rl(` is two declarations to the browser as well, and no function: it is not a fetch, and may stay.
		expect(styleWithoutFetches("color: red;background: u;rl(x)")).toBe("color: red;background: u;rl(x)");
	});

	test("the sanitiser is told to keep a style less its fetches, to drop one left empty, and to leave every other attribute", () => {
		const ask = (attrName: string, attrValue: string) => {
			const data = { attrName, attrValue, keepAttr: true };
			renderedKeepsStyle(data);
			return data;
		};
		expect(ask("style", `color: red; background: url(${REMOTE})`)).toEqual({ attrName: "style", attrValue: "color: red", keepAttr: true });
		expect(ask("style", `background: url(${REMOTE})`).keepAttr).toBe(false);
		expect(ask("style", `background: url(${REMOTE});`).keepAttr).toBe(false);
		expect(ask("style", "color: red")).toEqual({ attrName: "style", attrValue: "color: red", keepAttr: true });
		// An address in another attribute is not a style's: a link's, a picture's and a title's stay as they are.
		for (const name of ["href", "src", "title", "alt", "class", "data-style"]) {
			expect(ask(name, `url(${REMOTE})`)).toEqual({ attrName: name, attrValue: `url(${REMOTE})`, keepAttr: true });
		}
	});

	test("the rule is a hook on the rendered documents' own sanitiser (read from the source: DOMPurify needs a DOM)", () => {
		const shared = source("src/view/editor/cmLiveShared.ts");
		expect(shared).toContain('renderedSanitizer.addHook("uponSanitizeAttribute", (_node, data) => renderedKeepsStyle(data));');
		// Never on the one every other caller shares, as for the checkbox rule.
		expect(shared).not.toContain("DOMPurify.addHook(");
	});
});
