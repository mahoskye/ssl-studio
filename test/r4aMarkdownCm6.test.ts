import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { history } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldable } from "@codemirror/language";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LiveEditorHandle } from "../src/view/editor/liveBridge";

// Minimal headless browser & Monaco shims so editor modules load cleanly under Bun tests.
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
} else {
	if (!(globalThis as any).window.Error) (globalThis as any).window.Error = Error;
	if (!(globalThis as any).window.Map) (globalThis as any).window.Map = Map;
	if (!(globalThis as any).window.Set) (globalThis as any).window.Set = Set;
	if (!(globalThis as any).window.location) (globalThis as any).window.location = { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" };
	if (!(globalThis as any).window.location.protocol) (globalThis as any).window.location.protocol = "http:";
	if (!(globalThis as any).window.location.host) (globalThis as any).window.location.host = "127.0.0.1:5190";
}
if (typeof (globalThis as any).location === "undefined") {
	(globalThis as any).location = (globalThis as any).window.location;
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
if (typeof (globalThis as any).Event === "undefined") {
	(globalThis as any).Event = class {
		constructor(public type: string) {}
	};
}

const noopProxy = (extra: Record<string, any> = {}) =>
	new Proxy(extra, { get: (target, prop) => (prop in target ? target[prop as any] : () => ({ dispose() {} })) });

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
	Uri: { from: () => ({}), file: (p: string) => ({ fsPath: p }) },
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { KeyB: 1, KeyI: 2, KeyX: 3, Backquote: 4, KeyH: 5, KeyK: 6, KeyL: 7, KeyC: 8, Enter: 9, Tab: 10, Backspace: 11 },
	languages: noopProxy({
		CompletionItemKind: { File: 1, Keyword: 2, Text: 3, Snippet: 4, Field: 5, Struct: 6 },
	}),
	editor: noopProxy({ getEditors: () => [], ScrollType: { Immediate: 1 } }),
}));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({
	default: class {},
}));
mock.module(resolve(import.meta.dir, "../src/view/editor/markdownLive.ts"), () => ({
	marksFor: async () => [],
}));

const { connect } = await import("../src/view/backend");
const { resolveMermaidSvgDimensions } = await import("../src/view/editor/cmMermaid");
const { cmJoinLines, cmRedo, cmToggleBold, cmUndo, historyFallbackFacet } = await import("../src/view/editor/cmKeymap");
const { applyMarkdownFormatToTextarea } = await import("../src/view/editor/cmLiveShared");
const { computeTextareaCompletions } = await import("../src/view/editor/cmCompletion");
const { findCalloutTaskBracketOffset, serializePrefixedCalloutBlock } = await import("../src/view/editor/cmLiveCallout");
const { liveBlockField, markdownFoldService } = await import("../src/view/editor/cmLivePlugin");
const {
	imageCacheStats,
	invalidateImageCache,
	loadImageUrl,
	resolveImageTarget,
	saveImageAttachment,
} = await import("../src/view/editor/imageResolve");
const {
	liveEditorAt,
	readFinderAt,
	registerLiveEditor,
	registerReadFind,
	unregisterLiveEditor,
	unregisterReadFinder,
} = await import("../src/view/editor/liveBridge");
const { setState } = await import("../src/view/state");

/** Minimal headless CM6 EditorView wrapper for running real CM6 commands without a full browser DOM. */
function makeHeadlessView(stateInit: EditorState): EditorView {
	const view: any = {
		state: stateInit,
		dom: { isConnected: true },
		dispatch(...specs: TransactionSpec[]) {
			const tr = view.state.update(...specs);
			view.state = tr.state;
		},
		focus() {},
	};
	return view as EditorView;
}

describe("Round 4A — Mermaid PNG SVG dimension resolution", () => {
	test("prefers viewBox dimensions over width='100%' so PNGs never crush to 100px", () => {
		expect(resolveMermaidSvgDimensions("100%", "100%", "0 0 640 320")).toEqual({ width: 640, height: 320 });
		expect(resolveMermaidSvgDimensions("100%", null, { width: 640, height: 320 })).toEqual({ width: 640, height: 320 });
	});

	test("ignores %-suffixed attributes and falls back to numeric attrs or 800x480", () => {
		expect(resolveMermaidSvgDimensions("100%", "50%", null)).toEqual({ width: 800, height: 480 });
		expect(resolveMermaidSvgDimensions("520", "310", null)).toEqual({ width: 520, height: 310 });
		expect(resolveMermaidSvgDimensions("420px", "260px", { width: 0, height: 0 })).toEqual({ width: 420, height: 260 });
		expect(resolveMermaidSvgDimensions("100%", "310", null)).toEqual({ width: 800, height: 310 });
	});
});

describe("Round 4A — CM6 multi-cursor dedup & Read-mode undo/redo guard", () => {
	test("cmToggleBold deduplicates multiple cursors inside the same word without crashing or double-wrapping", () => {
		const view = makeHeadlessView(
			EditorState.create({
				doc: "hello world",
				selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]),
				extensions: [EditorState.allowMultipleSelections.of(true)],
			}),
		);
		expect(cmToggleBold(view)).toBe(true);
		expect(view.state.doc.toString()).toBe("**hello** world");
		expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
			[3, 3],
			[5, 5],
		]);

		// Calling again unwraps the same word cleanly once.
		expect(cmToggleBold(view)).toBe(true);
		expect(view.state.doc.toString()).toBe("hello world");
		expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
			[1, 1],
			[3, 3],
		]);
	});

	test("cmToggleBold wraps distinct multi-cursor words cleanly", () => {
		const view = makeHeadlessView(
			EditorState.create({
				doc: "foo bar",
				selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(5)]),
				extensions: [EditorState.allowMultipleSelections.of(true)],
			}),
		);
		expect(cmToggleBold(view)).toBe(true);
		expect(view.state.doc.toString()).toBe("**foo** **bar**");
	});

	test("cmJoinLines deduplicates same-line cursors and merges adjacent overlapping line joins", () => {
		// Two cursors on line 1 -> joins line 1 & 2 once.
		const sameLine = makeHeadlessView(
			EditorState.create({
				doc: "alpha\nbeta\ngamma",
				selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]),
				extensions: [EditorState.allowMultipleSelections.of(true)],
			}),
		);
		expect(cmJoinLines(sameLine)).toBe(true);
		expect(sameLine.state.doc.toString()).toBe("alpha beta\ngamma");

		// Cursors on line 1 and line 2 -> merges overlapping spans into one 3-line join with zero duplication.
		const adjacent = makeHeadlessView(
			EditorState.create({
				doc: "alpha\nbeta\ngamma",
				selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(6)]),
				extensions: [EditorState.allowMultipleSelections.of(true)],
			}),
		);
		expect(cmJoinLines(adjacent)).toBe(true);
		expect(adjacent.state.doc.toString()).toBe("alpha beta gamma");

		// Disjoint cursors on line 1 and line 3 -> joins both pairs independently.
		const disjoint = makeHeadlessView(
			EditorState.create({
				doc: "a\nb\nc\nd",
				selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]),
				extensions: [EditorState.allowMultipleSelections.of(true)],
			}),
		);
		expect(cmJoinLines(disjoint)).toBe(true);
		expect(disjoint.state.doc.toString()).toBe("a b\nc d");
	});

	test("cmUndo / cmRedo return false in Read mode without mutating Monaco fallback, and route authoritatively to fallback in Live mode", () => {
		let undoCalls = 0;
		let redoCalls = 0;
		const fallback = {
			undo: () => {
				undoCalls++;
				return true;
			},
			redo: () => {
				redoCalls++;
				return true;
			},
		};

		// Read mode: must NEVER touch Monaco fallback or CM6 history.
		const readView = makeHeadlessView(
			EditorState.create({
				doc: "hello",
				extensions: [EditorState.readOnly.of(true), history(), historyFallbackFacet.of(fallback)],
			}),
		);
		expect(cmUndo(readView)).toBe(false);
		expect(cmRedo(readView)).toBe(false);
		expect(undoCalls).toBe(0);
		expect(redoCalls).toBe(0);

		// Live mode with fallback: routes directly to Monaco fallback even when CM6 history has entries.
		const liveView = makeHeadlessView(
			EditorState.create({
				doc: "hello",
				extensions: [history(), historyFallbackFacet.of(fallback)],
			}),
		);
		liveView.dispatch({ changes: { from: 5, to: 5, insert: "!" }, userEvent: "input.type" });
		expect(cmUndo(liveView)).toBe(true);
		expect(cmRedo(liveView)).toBe(true);
		expect(undoCalls).toBe(1);
		expect(redoCalls).toBe(1);
		// CM6 doc wasn't double-mutated by CM6's own undo (Monaco callback owns model->CM6 sync).
		expect(liveView.state.doc.toString()).toBe("hello!");
	});
});

describe("Round 4A — Textarea Alt+C at offset 0 & completion boundary safety", () => {
	test("applyMarkdownFormatToTextarea md-checkbox at offset 0 of '\\nTask' never throws IndexSizeError", () => {
		let inputEvents = 0;
		const fakeTa: any = {
			value: "\nTask",
			selectionStart: 0,
			selectionEnd: 0,
			classList: { contains: (cls: string) => cls === "cm-callout-body-input" },
			setRangeText(replacement: string, start: number, end: number) {
				if (start > end) {
					throw new RangeError(`IndexSizeError: start (${start}) > end (${end})`);
				}
				fakeTa.value = `${fakeTa.value.slice(0, start)}${replacement}${fakeTa.value.slice(end)}`;
				fakeTa.selectionStart = start + replacement.length;
				fakeTa.selectionEnd = start + replacement.length;
			},
			setSelectionRange(s: number, e: number) {
				fakeTa.selectionStart = s;
				fakeTa.selectionEnd = e;
			},
			dispatchEvent() {
				inputEvents++;
				return true;
			},
		};

		expect(applyMarkdownFormatToTextarea(fakeTa as HTMLTextAreaElement, "md-checkbox")).toBe(true);
		expect(fakeTa.value).toBe("- [ ] \nTask");
		expect(fakeTa.selectionStart).toBe(6);
		expect(inputEvents).toBe(1);

		// Also verify caret at start of line 2 (`Task`).
		fakeTa.value = "\nTask";
		fakeTa.selectionStart = 1;
		fakeTa.selectionEnd = 1;
		expect(applyMarkdownFormatToTextarea(fakeTa as HTMLTextAreaElement, "md-checkbox")).toBe(true);
		expect(fakeTa.value).toBe("\n- [ ] Task");
	});

	test("computeTextareaCompletions at caret 0 of leading-newline value handles lineStart cleanly", () => {
		const res = computeTextareaCompletions({
			mode: "yaml",
			value: "\nstatus: open",
			caret: 0,
			explicit: true,
			filePath: "/ws/project/docs/a.md",
			docs: [],
			root: "/ws/project",
		});
		expect(res?.from).toBe(0);
		expect(res?.to).toBe(0);
		expect(res?.items.some((i) => i.label === "status")).toBe(true);
	});
});

describe("Round 4A — Callout task regex ReDoS linearity & prefixed callout serialization", () => {
	test("findCalloutTaskBracketOffset runs in linear time on adversarial blockquote prefixes and validates checkbox trailing boundary", () => {
		const torture = `${"> ".repeat(5000)}- not a task`;
		const t0 = performance.now();
		expect(findCalloutTaskBracketOffset(torture)).toBe(-1);
		expect(performance.now() - t0).toBeLessThan(100);

		expect(findCalloutTaskBracketOffset("> - [ ] Buy reagents")).toBe(4);
		expect(findCalloutTaskBracketOffset("> >   1. [x] Verify batch")).toBe(9);
		expect(findCalloutTaskBracketOffset("> - [x]")).toBe(4);
		// Markdown link `[x](url)` after a bullet must NOT be misclassified as a task checkbox.
		expect(findCalloutTaskBracketOffset("> - [x](https://example.com)")).toBe(-1);
	});

	test("serializePrefixedCalloutBlock preserves leading indentation on every emitted line", () => {
		const out = serializePrefixedCalloutBlock("note", "Indented", null, "First\n\nSecond", false, "  ");
		expect(out).toBe("  > [!note] Indented\n  > First\n  >\n  > Second");
	});
});

describe("Round 4A — imageResolve path traversal rejection, untitled paste & bounded LRU cache", () => {
	const ROOT = "/ws/project";
	let mockWorkspaceFiles: string[] = [];
	let mockImageReads = 0;
	let lastWrittenImagePath: string | null = null;
	let origWebSocket: unknown;

	class ImageTestSocket extends EventTarget {
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
			let result: unknown = null;
			if (method === "files") {
				result = mockWorkspaceFiles;
			} else if (method === "image") {
				mockImageReads++;
				result = { type: "image/png", base64: Buffer.from(`img:${String(args[0])}`).toString("base64") };
			} else if (method === "writeImage") {
				lastWrittenImagePath = String(args[0]);
				result = { path: lastWrittenImagePath };
			} else if (method === "read") {
				result = { text: "" };
			}
			queueMicrotask(() => {
				if (this.readyState !== 1) return;
				this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result }) }));
			});
		}
		close() {
			this.readyState = 3;
		}
	}

	beforeAll(async () => {
		origWebSocket = (globalThis as any).WebSocket;
		(globalThis as any).WebSocket = ImageTestSocket;
		await connect();
	});

	afterAll(async () => {
		// Reset `src/view/backend.ts`'s module-level `caller` back to `undefined` so tests checking
		// disconnected-backend rejection (e.g. r1aBackendSecurity.test.ts) stay 100% isolated.
		class ClosingSocket extends EventTarget {
			static OPEN = 1;
			readyState = 0;
			constructor() {
				super();
				queueMicrotask(() => {
					this.readyState = 3;
					this.dispatchEvent(new Event("close"));
				});
			}
			close() {
				this.readyState = 3;
			}
		}
		(globalThis as any).WebSocket = ClosingSocket;
		await connect().catch(() => {});
		(globalThis as any).WebSocket = origWebSocket;
	});

	afterEach(() => {
		invalidateImageCache();
		setState("workspace", null);
		setState("project", null);
		setState("settings", "attachmentsFolder", undefined);
		mockWorkspaceFiles = [];
		mockImageReads = 0;
		lastWrittenImagePath = null;
	});

	test("rejects path traversal in resolveImageTarget and attachmentsFolder in saveImageAttachment", async () => {
		setState("workspace", { root: ROOT, name: "project" });
		mockWorkspaceFiles = [`${ROOT}/assets/secret.png`, `${ROOT}/assets/logo.png`];

		expect(await resolveImageTarget("../../../etc/passwd.png", `${ROOT}/docs/note.md`)).toBeNull();
		expect(await resolveImageTarget("/../../etc/passwd.png", `${ROOT}/docs/note.md`)).toBeNull();
		// Explicit traversal must NOT fall back to a same-named workspace image.
		expect(await resolveImageTarget("../../../etc/secret.png", `${ROOT}/docs/note.md`)).toBeNull();
		// Valid root-relative workspace image resolves cleanly.
		expect(await resolveImageTarget("/assets/logo.png", `${ROOT}/docs/note.md`)).toEqual({
			filePath: `${ROOT}/assets/logo.png`,
		});

		// Configured attachmentsFolder escaping workspace is rejected.
		setState("settings", "attachmentsFolder", "../../outside");
		const blob = new Blob(["png"], { type: "image/png" });
		expect(await saveImageAttachment(blob, `${ROOT}/docs/note.md`)).toBeNull();
		expect(lastWrittenImagePath).toBeNull();

		// Untitled doc falls back to docs/attachments inside workspace with a clean root-relative link.
		setState("settings", "attachmentsFolder", undefined);
		const saved = await saveImageAttachment(blob, "untitled:1");
		expect(saved).not.toBeNull();
		expect(saved!.path.startsWith(`${ROOT}/docs/attachments/`)).toBe(true);
		expect(saved!.rel.startsWith("/docs/attachments/")).toBe(true);
	});

	test("evicts oldest cached images when exceeding the 40-entry LRU limit and clears via invalidateImageCache", async () => {
		setState("workspace", { root: ROOT, name: "project" });
		const files = Array.from({ length: 50 }, (_, i) => `${ROOT}/assets/img-${i}.png`);
		mockWorkspaceFiles = files;

		for (let i = 0; i < 50; i++) {
			const loaded = await loadImageUrl(`/assets/img-${i}.png`, `${ROOT}/docs/note.md`);
			expect(loaded?.url.startsWith("data:image/png;base64,")).toBe(true);
		}
		expect(imageCacheStats().entries).toBeLessThanOrEqual(40);
		expect(mockImageReads).toBe(50);

		// Most recent entry is a cache hit (no extra backend.image read).
		await loadImageUrl("/assets/img-49.png", `${ROOT}/docs/note.md`);
		expect(mockImageReads).toBe(50);

		// Evicted oldest entry reloads from backend.
		await loadImageUrl("/assets/img-0.png", `${ROOT}/docs/note.md`);
		expect(mockImageReads).toBe(51);

		// Targeted and full invalidation both clear entries.
		const beforeTarget = imageCacheStats().entries;
		invalidateImageCache(`${ROOT}/assets/img-49.png`);
		expect(imageCacheStats().entries).toBe(beforeTarget - 1);
		invalidateImageCache();
		expect(imageCacheStats()).toEqual({ entries: 0, chars: 0 });
	});
});

describe("Round 4A — liveBridge identity-checked unregistration", () => {
	const mkHandle = (path: string): LiveEditorHandle => ({
		path,
		focus() {},
		hasFocus: () => false,
		getPosition: () => ({ lineNumber: 1, column: 1 }),
		getSelection: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1, isEmpty: () => true }),
		getSelectedText: () => "",
		reveal() {},
		runAction: () => false,
		openLinkAtCursor: () => false,
		insertText() {},
	});

	test("stale pane cleanup never wipes a replacement pane's Live handle or Read finder", () => {
		const handleA = mkHandle("/ws/a.md");
		const handleB = mkHandle("/ws/b.md");
		registerLiveEditor(0, handleA);
		registerLiveEditor(0, handleB);
		expect(unregisterLiveEditor(0, handleA)).toBe(false);
		expect(liveEditorAt(0)).toBe(handleB);
		expect(unregisterLiveEditor(0, handleB)).toBe(true);
		expect(liveEditorAt(0)).toBeUndefined();

		const finderA = () => {};
		const finderB = () => {};
		registerReadFind(1, finderA);
		registerReadFind(1, finderB);
		expect(unregisterReadFinder(1, finderA)).toBe(false);
		expect(readFinderAt(1)).toBe(finderB);
		expect(unregisterReadFinder(1, finderB)).toBe(true);
		expect(readFinderAt(1)).toBeUndefined();
	});
});

describe("Round 4A — markdownFoldService 3,000-line performance & block widget prefix anchoring", () => {
	test("markdownFoldService evaluates all 3,000 lines cleanly without O(N^2) slowdown", () => {
		const lines: string[] = [];
		for (let i = 0; i < 60; i++) {
			lines.push(`## Section ${i + 1}`);
			lines.push("- Parent item");
			lines.push("  - Nested child item");
			lines.push("```bash");
			lines.push("# comment inside fence must not fold or break heading");
			lines.push("echo ok");
			lines.push("```");
			for (let j = 0; j < 43; j++) {
				lines.push(`Plain prose line ${i}-${j} discussing STARLIMS lab workflow details.`);
			}
		}
		expect(lines.length).toBe(3000);

		const st = EditorState.create({
			doc: lines.join("\n"),
			extensions: [markdownFoldService],
		});

		const t0 = performance.now();
		let headingFolds = 0;
		let listFolds = 0;
		for (let n = 1; n <= st.doc.lines; n++) {
			const ln = st.doc.line(n);
			const range = foldable(st, ln.from, ln.to);
			if (range) {
				if (ln.text.startsWith("## ")) headingFolds++;
				else if (ln.text.startsWith("- ")) listFolds++;
			}
		}
		const elapsed = performance.now() - t0;

		expect(headingFolds).toBe(60);
		expect(listFolds).toBe(60);
		// Comment `# ...` on line 5 inside the bash fence must not produce a fold.
		const commentLine = st.doc.line(5);
		expect(foldable(st, commentLine.from, commentLine.to)).toBeNull();
		expect(elapsed).toBeLessThan(250);
	});

	test("indented tables & callouts anchor widget replacement to startLine.from and skip list-marker tables", () => {
		const indentedTableDoc = ["Intro", "", "  | A | B |", "  | - | - |", "  | 1 | 2 |"].join("\n");
		const st1 = EditorState.create({
			doc: indentedTableDoc,
			selection: EditorSelection.cursor(0),
			extensions: [markdown({ base: markdownLanguage }), liveBlockField],
		});
		const decos1: [number, number][] = [];
		st1.field(liveBlockField).between(0, st1.doc.length, (from, to, d) => {
			if (d.spec.widget) decos1.push([from, to]);
		});
		expect(decos1).toEqual([[st1.doc.line(3).from, st1.doc.line(5).to]]);

		const listMarkerTableDoc = ["Intro", "", "- | A | B |", "  | - | - |", "  | 1 | 2 |"].join("\n");
		const st2 = EditorState.create({
			doc: listMarkerTableDoc,
			selection: EditorSelection.cursor(0),
			extensions: [markdown({ base: markdownLanguage }), liveBlockField],
		});
		const decos2: [number, number][] = [];
		st2.field(liveBlockField).between(0, st2.doc.length, (from, to, d) => {
			if (d.spec.widget) decos2.push([from, to]);
		});
		expect(decos2).toEqual([]);

		const indentedCalloutDoc = ["Intro", "", "  > [!note] Nested", "  > Body line"].join("\n");
		const st3 = EditorState.create({
			doc: indentedCalloutDoc,
			selection: EditorSelection.cursor(0),
			extensions: [markdown({ base: markdownLanguage }), liveBlockField],
		});
		const decos3: [number, number][] = [];
		st3.field(liveBlockField).between(0, st3.doc.length, (from, to, d) => {
			if (d.spec.widget) decos3.push([from, to]);
		});
		expect(decos3).toEqual([[st3.doc.line(3).from, st3.doc.line(4).to]]);
	});
});
