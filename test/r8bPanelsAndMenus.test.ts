import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeMenuEntries, type RowMenuEntry } from "../src/shared/contextMenu";
import { TEMPLATES } from "../src/shared/houseStyle";
import { copyProblem, moveProblem } from "../src/view/panels/explorerMoves";

// --- Minimal headless browser & Monaco shims so view/.tsx helpers load cleanly under Bun ---
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
		innerWidth: 1280,
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
		SymbolKind: {
			Module: 1,
			Namespace: 2,
			Package: 3,
			Class: 4,
			Method: 5,
			Function: 11,
			Variable: 12,
			Constant: 13,
			String: 14,
			Object: 18,
			Key: 19,
			Struct: 22,
		},
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

const { documents, setState, state } = await import("../src/view/state");
const { editors } = await import("../src/view/editor/EditorGroup");
const { openReview, closeReview } = await import("../src/view/editor/Review");
const { registerLiveEditor } = await import("../src/view/editor/liveBridge");
const { clampReferenceHeight, insertReferenceText, nextReferenceScratchUri } = await import("../src/view/panels/Reference");
const { clampPaletteHeight, formatSnippetForEditor, insertMermaidInMd, insertSnippet, insertTableInMd, insertTemplate } = await import("../src/view/panels/Palette");
const { createPointerTracker, navigableMenuEntries, stepKeptMenuKey } = await import("../src/view/panels/RowMenu");
const { problemDedupKey, problemPath, problemRowKey } = await import("../src/view/panels/Problems");
const { applyOutlineCollapseAll, buildSymbolKeyMap, planCollapseKey, symbolCollapseKey } = await import("../src/view/panels/Objects");
const { clampExplorerHeight, decodeDroppedText, gitKindMapFor, MAX_DROP_FILE_BYTES, OPEN_EDITORS_MAX_H, OPEN_EDITORS_MIN_H, resizeOpenEditorsHeight, sanitizeDropName } = await import("../src/view/panels/Explorer");
const { focusRowsBelow } = await import("../src/view/panels/Rows");
const { narrowHosted, panelOn, setNarrowHosted, setNarrowPanels, toggleSide } = await import("../src/view/panels/registry");

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

/** Minimal fake Monaco model + editor to verify edit mutations, visibility guards, and null-position safety. */
function makeFakeMonaco(initialText: string, opts: { languageId?: string; visible?: boolean; nullPosition?: boolean; disposed?: boolean } = {}) {
	let text = initialText;
	let pos: { lineNumber: number; column: number } | null = opts.nullPosition ? null : { lineNumber: 1, column: 1 };
	let sel: any = pos
		? { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column, isEmpty: () => true }
		: null;
	const typed: string[] = [];
	const snippetInserts: string[] = [];
	const edits: { source: string; text: string }[] = [];
	let focused = false;

	const lines = () => text.split("\n");
	const offsetAt = (p: { lineNumber: number; column: number }) => {
		const ls = lines();
		let off = 0;
		for (let i = 0; i < p.lineNumber - 1 && i < ls.length; i++) off += ls[i]!.length + 1;
		return Math.min(text.length, off + Math.max(0, p.column - 1));
	};
	const positionAt = (offset: number) => {
		const clamped = Math.max(0, Math.min(text.length, offset));
		const before = text.slice(0, clamped).split("\n");
		return { lineNumber: before.length, column: before[before.length - 1]!.length + 1 };
	};

	const model: any = {
		isDisposed: () => Boolean(opts.disposed),
		dispose: () => {},
		getLanguageId: () => opts.languageId ?? "ssl",
		getValue: () => text,
		getEOL: () => "\n",
		getLineCount: () => lines().length,
		getLineContent: (n: number) => lines()[n - 1] ?? "",
		getOffsetAt: offsetAt,
		getPositionAt: positionAt,
		getFullModelRange: () => {
			const ls = lines();
			return {
				getEndPosition: () => ({ lineNumber: ls.length, column: (ls[ls.length - 1]?.length ?? 0) + 1 }),
			};
		},
	};

	const editor: any = {
		getModel: () => model,
		getDomNode: () => ({ offsetParent: opts.visible === false ? null : {} }),
		getPosition: () => pos,
		setPosition: (next: { lineNumber: number; column: number }) => {
			pos = next;
		},
		getSelection: () => sel,
		setSelection: (next: any) => {
			sel = next;
		},
		revealPositionInCenterIfOutsideViewport() {},
		focus: () => {
			focused = true;
		},
		pushUndoStop() {},
		trigger: (_source: string, handlerId: string, payload: any) => {
			if (handlerId === "type" && payload?.text) {
				typed.push(payload.text);
				text += payload.text;
			}
		},
		executeEdits: (source: string, ops: { range: any; text: string }[]) => {
			for (const op of ops) {
				edits.push({ source, text: op.text });
				const start = offsetAt({ lineNumber: op.range.startLineNumber, column: op.range.startColumn });
				const end = offsetAt({ lineNumber: op.range.endLineNumber, column: op.range.endColumn });
				text = text.slice(0, start) + op.text + text.slice(end);
			}
			return true;
		},
		getContribution: (id: string) =>
			id === "snippetController2"
				? {
						insert: (body: string) => {
							snippetInserts.push(body);
							text += body;
						},
					}
				: null,
	};

	return {
		model,
		editor,
		getText: () => text,
		typed,
		snippetInserts,
		edits,
		wasFocused: () => focused,
	};
}

function setActiveTab(path: string, model: any, extra: { binary?: { size: number; image?: string } } = {}) {
	documents.clear();
	documents.set(path, {
		path,
		model,
		savedVersion: 1,
		savedText: model.getValue(),
		mtime: 1,
		binary: extra.binary,
	});
	setState("workspace", { root: "/w", name: "w" } as any);
	setState("centerView", "editors");
	setState("activeGroup", 0);
	setState("groups", [{ tabs: [path], active: path, mode: "text" } as any]);
}

describe("R8B-1 — Reference & Palette hidden-view/binary guards + Markdown Source mode", () => {
	test("blocks Reference and Palette insertion when binary, hidden Monaco, Call Graph, or ReviewView is active", async () => {
		registerLiveEditor(0, undefined);
		const tpl = TEMPLATES[0]!;
		const snippetFile = {
			path: "/w/docs/snippets/orders.sql",
			name: "orders.sql",
			exists: true,
			group: "knowledge",
			kind: "snippets",
		} as any;
		const readFakeSnippet = async () => "SELECT * FROM ORDERS;";

		try {
			// 1. Binary image tab (even if Monaco somehow still had a model & visible DOM)
			const binFake = makeFakeMonaco("", { visible: true });
			editors[0] = binFake.editor;
			setActiveTab("/w/docs/logo.png", binFake.model, { binary: { size: 1024, image: "image/png" } });
			expect(insertReferenceText("SQLExecute")).toBe(false);
			insertTemplate(tpl);
			await insertSnippet(snippetFile, readFakeSnippet);
			expect(binFake.getText()).toBe("");
			expect(binFake.typed).toHaveLength(0);
			expect(binFake.snippetInserts).toHaveLength(0);
			expect(binFake.edits).toHaveLength(0);

			// 2. Hidden Monaco (Blocks view / TableView / Plan Chart / Markdown Read mode -> offsetParent === null)
			const hiddenFake = makeFakeMonaco("original", { visible: false });
			editors[0] = hiddenFake.editor;
			setActiveTab("/w/src/DueRules.ssl", hiddenFake.model);
			expect(insertReferenceText("SQLExecute")).toBe(false);
			insertTemplate(tpl);
			await insertSnippet(snippetFile, readFakeSnippet);
			expect(hiddenFake.getText()).toBe("original");

			// 3. Call Graph active (state.centerView === "graph")
			const graphFake = makeFakeMonaco("original", { visible: true });
			editors[0] = graphFake.editor;
			setActiveTab("/w/src/DueRules.ssl", graphFake.model);
			setState("centerView", "graph");
			expect(insertReferenceText("SQLExecute")).toBe(false);
			insertTemplate(tpl);
			await insertSnippet(snippetFile, readFakeSnippet);
			expect(graphFake.getText()).toBe("original");

			// 4. ReviewView open over editor
			setState("centerView", "editors");
			await openReview({
				title: "Diff",
				original: "a",
				proposed: "b",
				language: "ssl",
				compare: { left: "Before", right: "After" },
				replaceable: true,
				onAccept: () => {},
			});
			expect(insertReferenceText("SQLExecute")).toBe(false);
			insertTemplate(tpl);
			await insertSnippet(snippetFile, readFakeSnippet);
			expect(graphFake.getText()).toBe("original");
			closeReview();

			// 5. Visible Monaco editor with null cursor position -> insertTemplate null-checks getPosition() cleanly
			const nullPosFake = makeFakeMonaco("x := 1;", { visible: true, nullPosition: true });
			editors[0] = nullPosFake.editor;
			setActiveTab("/w/src/DueRules.ssl", nullPosFake.model);
			expect(() => insertTemplate(tpl)).not.toThrow();
			expect(nullPosFake.snippetInserts.length).toBe(1);
			expect(insertReferenceText("SQLExecute")).toBe(true);
			expect(nullPosFake.typed).toEqual(["SQLExecute"]);
		} finally {
			closeReview();
			documents.clear();
			delete editors[0];
		}
	});

	test("supports inserting Markdown table, Mermaid block, and fenced SQL/SSL snippets in Markdown Source mode", async () => {
		registerLiveEditor(0, undefined);
		const mdFake = makeFakeMonaco("# Notes", { languageId: "markdown", visible: true });
		editors[0] = mdFake.editor;
		setActiveTab("/w/docs/spec.md", mdFake.model);

		try {
			expect(await insertTableInMd()).toBe(true);
			expect(mdFake.getText()).toContain("| Column 1 | Column 2 | Column 3 |");

			expect(await insertMermaidInMd()).toBe(true);
			expect(mdFake.getText()).toContain("```mermaid\nflowchart LR\n\tA[Start] --> B[End]\n```");

			await insertSnippet(
				{
					path: "/w/docs/snippets/orders.sql",
					name: "orders.sql",
					exists: true,
					group: "knowledge",
					kind: "snippets",
				} as any,
				async () => "SELECT ID FROM ORDERS;\r\n",
			);
			expect(mdFake.getText()).toContain("```sql\nSELECT ID FROM ORDERS;\n```");

			expect(formatSnippetForEditor(":PROCEDURE Run;\r\n:ENDPROC;\r\n", "helper.ssl", true)).toBe("```ssl\n:PROCEDURE Run;\n:ENDPROC;\n```\n");
			expect(formatSnippetForEditor(":PROCEDURE Run;\r\n:ENDPROC;\r\n", "helper.ssl", false)).toBe(":PROCEDURE Run;\n:ENDPROC;\n");
		} finally {
			documents.clear();
			delete editors[0];
		}
	});

	test("clamps recalled splitter heights and checks Palette seq/slice/reset invariants", () => {
		expect(clampPaletteHeight(null)).toBe(190);
		expect(clampPaletteHeight("")).toBe(190);
		expect(clampPaletteHeight("abc")).toBe(190);
		expect(clampPaletteHeight("20")).toBe(80);
		expect(clampPaletteHeight("9999")).toBe(440);
		expect(clampPaletteHeight("260")).toBe(260);

		expect(clampReferenceHeight(null)).toBe(220);
		expect(clampReferenceHeight("10")).toBe(100);
		expect(clampReferenceHeight("999")).toBe(520);
		expect(clampReferenceHeight("300")).toBe(300);

		const paletteSrc = readSrc("../src/view/panels/Palette.tsx");
		expect(paletteSrc).toContain("lastHandledPlanTabSeq");
		expect(paletteSrc).toContain("visibleLinkableDocs = createMemo(() => filteredLinkableDocs().slice(0, 40))");
		expect(paletteSrc).toContain("setShown(null)");
		expect(paletteSrc).toContain("setShownMd(null)");
	});
});

describe("R8B-2 — Reference & Objects workspace switch reactivity and scratch URI uniqueness", () => {
	test("allocates unique monotonic scratch URIs so concurrent Reference calls never collide", () => {
		const a = nextReferenceScratchUri("/w");
		const b = nextReferenceScratchUri("/w");
		const c = nextReferenceScratchUri("/w");
		expect(a).not.toBe(b);
		expect(b).not.toBe(c);
		expect(a).toMatch(/reference-scratch-\d+\.ssl$/);
		expect(b).toMatch(/reference-scratch-\d+\.ssl$/);
	});

	test("Reference.tsx awaits session.waitReady() before didOpen, tracks lspReadyEpoch, and resets open on root switch", () => {
		const refSrc = readSrc("../src/view/panels/Reference.tsx");
		expect(refSrc).toContain("lspReadyEpoch");
		expect(refSrc).toContain("await session.waitReady()");
		const loadIdx = refSrc.indexOf("async function loadReference");
		const loadWait = refSrc.indexOf("await session.waitReady()", loadIdx);
		const loadOpen = refSrc.indexOf('session.client.notify("textDocument/didOpen"', loadIdx);
		expect(loadWait).toBeGreaterThan(loadIdx);
		expect(loadWait).toBeLessThan(loadOpen);

		const descIdx = refSrc.indexOf("async function describe(");
		const descWait = refSrc.indexOf("await session.waitReady()", descIdx);
		const descOpen = refSrc.indexOf('session.client.notify("textDocument/didOpen"', descIdx);
		expect(descWait).toBeGreaterThan(descIdx);
		expect(descWait).toBeLessThan(descOpen);
		expect(refSrc).toContain("() => setOpen(null)");
	});
});

describe("R8B-3 — RowMenu submenus under { box } (menu.keep), pointer tracking, and window resize", () => {
	const tableMenu = normalizeMenuEntries([
		"Insert row above",
		"separator",
		{
			label: "Move",
			children: [
				{ label: "Move row up", value: "move-up", disabled: true },
				{ label: "Move row down", value: "move-down" },
				"separator",
				{ label: "Move column left", value: "move-col-left" },
			],
		},
		{
			label: "Align column",
			children: [
				{ label: "Align left", value: "align-left", checked: true },
				{ label: "Align right", value: "align-right" },
			],
		},
		"separator",
		{ label: "Delete row", value: "del-row", danger: true, disabled: true },
		{ label: "Copy as TSV", value: "copy-tsv" },
	] as RowMenuEntry[]);

	const noMods = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

	test("navigableMenuEntries includes enabled leaves and submenu triggers while skipping separators and disabled items", () => {
		const nav = navigableMenuEntries(tableMenu);
		expect(nav.map((n) => n.entry.label)).toEqual(["Insert row above", "Move", "Align column", "Copy as TSV"]);
	});

	test("stepKeptMenuKey navigates across root leaves, opens/navigates/closes submenus with ArrowRight/ArrowLeft/Enter/Escape", () => {
		// Enter with nothing marked is a consumed no-op (never selects unchosen item or leaks to box)
		expect(stepKeptMenuKey("Enter", noMods, tableMenu, [], { depth: 0, index: -1 })).toEqual({ action: "noop", consume: true });

		// ArrowDown -> marks index 0 ("Insert row above"), then index 1 ("Move" submenu)
		const s1 = stepKeptMenuKey("ArrowDown", noMods, tableMenu, [], { depth: 0, index: -1 });
		expect(s1).toEqual({ action: "mark", mark: { depth: 0, index: 0 }, closeSubDepth: undefined });
		const s2 = stepKeptMenuKey("ArrowDown", noMods, tableMenu, [], { depth: 0, index: 0 });
		expect(s2).toEqual({ action: "mark", mark: { depth: 0, index: 1 }, closeSubDepth: undefined });

		// ArrowRight on "Move" submenu -> opens submenu at depth 0 and marks first enabled child (index 0 = "Move row down")
		const opened = stepKeptMenuKey("ArrowRight", noMods, tableMenu, [], { depth: 0, index: 1 });
		expect(opened.action).toBe("open-sub");
		if (opened.action !== "open-sub") throw new Error("expected open-sub");
		expect(opened.depth).toBe(0);
		expect(opened.entry.label).toBe("Move");
		expect(opened.mark).toEqual({ depth: 1, index: 0 });

		const openSubs = [{ parentIdx: opened.parentIdx, entry: opened.entry }];

		// ArrowDown inside Move submenu -> moves from "Move row down" (0) to "Move column left" (1)
		const subDown = stepKeptMenuKey("ArrowDown", noMods, tableMenu, openSubs, opened.mark);
		expect(subDown).toEqual({ action: "mark", mark: { depth: 1, index: 1 }, closeSubDepth: undefined });

		// Enter inside Move submenu -> chooses "move-col-left"
		const chosen = stepKeptMenuKey("Enter", noMods, tableMenu, openSubs, { depth: 1, index: 1 });
		expect(chosen).toEqual({ action: "choose", value: "move-col-left" });

		// ArrowLeft inside Move submenu -> closes depth 0 submenu and restores mark to "Move" trigger (index 1)
		const backed = stepKeptMenuKey("ArrowLeft", noMods, tableMenu, openSubs, { depth: 1, index: 1 });
		expect(backed).toEqual({ action: "close-sub", depth: 0, mark: { depth: 0, index: 1 } });

		// Escape at depth 1 closes submenu; Escape at depth 0 closes menu
		expect(stepKeptMenuKey("Escape", noMods, tableMenu, openSubs, { depth: 1, index: 0 })).toEqual({
			action: "close-sub",
			depth: 0,
			mark: { depth: 0, index: 1 },
		});
		expect(stepKeptMenuKey("Escape", noMods, tableMenu, [], { depth: 0, index: 1 })).toEqual({ action: "close", consume: true });

		// Typing a normal key dismisses menu without consuming so the box receives it
		expect(stepKeptMenuKey("a", noMods, tableMenu, [], { depth: 0, index: 0 })).toEqual({ action: "close", consume: false });
		expect(stepKeptMenuKey("Shift", { ...noMods, shiftKey: true }, tableMenu, [], { depth: 0, index: 0 })).toEqual({ action: "ignore" });
	});

	test("createPointerTracker ignores stationary cursor events under clamped menus until real pointer movement occurs", () => {
		const moved = createPointerTracker();
		// Menu clamps upward directly under stationary cursor at (500, 820)
		expect(moved({ screenX: 500, screenY: 820 })).toBe(false);
		expect(moved({ screenX: 500, screenY: 820 })).toBe(false);
		// User moves pointer by 1px -> now triggers hover/submenu open
		expect(moved({ screenX: 501, screenY: 820 })).toBe(true);
		expect(moved({ screenX: 501, screenY: 820 })).toBe(false);
	});

	test("RowMenu.tsx guards submenu mousedown, click focusFirst, hover pointerMoved, and window resize", () => {
		const src = readSrc("../src/view/panels/RowMenu.tsx");
		expect(src).toContain('window.addEventListener("resize", onResize)');
		expect(src).toContain("openSubAt(depth, entryIdx(), entry, e.currentTarget, !menu.keep)");
		const subIdx = src.indexOf("row-submenu");
		const subBlock = src.slice(subIdx, subIdx + 600);
		expect(subBlock).toContain("onMouseDown={(e) => menu.keep && e.preventDefault()}");
		expect(subBlock).toContain("classList={{ kept: menu.keep }}");
	});
});

describe("R8B-4 — Problems panel untitled URI preservation, same-line dedup, and scope reset", () => {
	test("preserves untitled: URIs instead of stripping scheme via fsPath", () => {
		expect(problemPath("untitled:Untitled-1")).toBe("untitled:Untitled-1");
		expect(problemPath("untitled:Untitled-2.md")).toBe("untitled:Untitled-2.md");
		expect(problemPath("file:///workspace/src/Orders.ssl")).toBe("/workspace/src/Orders.ssl");
	});

	test("keeps distinct doc issues on the same line (same column or different columns) while still deduplicating identical issues", () => {
		const file = "/w/docs/spec.md";
		const cit1 = problemDedupKey(file, 12, 1, "code-citation", "Broken citation [a.ssl#L1](src/a.ssl#L1)");
		const cit2 = problemDedupKey(file, 12, 1, "code-citation", "Broken citation [b.ssl#L2](src/b.ssl#L2)");
		const cit1Dup = problemDedupKey(file, 12, 1, "code-citation", "Broken citation [a.ssl#L1](src/a.ssl#L1)");
		expect(cit1).not.toBe(cit2);
		expect(cit1).toBe(cit1Dup);

		const row1 = problemRowKey("file:///w/docs/spec.md", { line: 12, column: 1, code: "code-citation", message: "Broken link A" });
		const row2 = problemRowKey("file:///w/docs/spec.md", { line: 12, column: 1, code: "code-citation", message: "Broken link B" });
		expect(row1).not.toBe(row2);
	});

	test("Problems.tsx resets problemsScope to 'all' on !hasDocIssues() and workspace root change", () => {
		const src = readSrc("../src/view/panels/Problems.tsx");
		expect(src).toContain('if (!hasDocIssues() && problemsScope() !== "all") setProblemsScope("all")');
		expect(src).toContain("if (root !== lastProblemsRoot)");
		expect(src).toContain("openFile(problemPath(uri)");
	});
});

describe("R8B-5 — Objects / Outline scoped collapse keys, per-file toggle, renameHeading, sort guard, and LSP seq", () => {
	test("scopes symbol and plan collapse keys by canonical file path and line/occurrence so duplicate names never collide", () => {
		const mkSym = (name: string, line: number, children: any[] = []): any => ({
			name,
			detail: "table",
			kind: 18,
			tags: [],
			range: { startLineNumber: line, startColumn: 1, endLineNumber: line + 3, endColumn: 1 },
			selectionRange: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 10 },
			children,
		});
		const childA = mkSym("host", 6);
		const childB = mkSym("host", 15);
		const server1 = mkSym("servers", 5, [childA]);
		const server2 = mkSym("servers", 14, [childB]);
		const sameLineDup = mkSym("servers", 14);

		const mapA = buildSymbolKeyMap([server1, server2, sameLineDup], "/w/a.toml");
		const mapB = buildSymbolKeyMap([mkSym("servers", 5)], "/w/b.toml");

		expect(mapA.get(server1)).not.toBe(mapA.get(server2));
		expect(mapA.get(server2)).not.toBe(mapA.get(sameLineDup));
		expect(mapA.get(childA)).not.toBe(mapA.get(childB));
		expect(mapA.get(server1)).not.toBe([...mapB.values()][0]);
		expect(symbolCollapseKey("/w/a.toml", "servers", 5)).toContain("/w/a.toml:sym:");
		expect(planCollapseKey("/w/a.plan.json", "ungrouped")).not.toBe(planCollapseKey("/w/b.plan.json", "ungrouped"));
	});

	test("applyOutlineCollapseAll toggles only active file keys and preserves other files' collapse state", () => {
		const fileA = ["/w/a.toml:sym:/servers@5", "/w/a.toml:sym:/servers@14"];
		const fileB = ["/w/b.toml:sym:/alpha@1", "/w/b.toml:sym:/beta@8"];

		// File A has one section collapsed.
		const initial = new Set([fileA[0]!]);

		// Collapse all in File B -> adds both File B keys while keeping File A untouched.
		const afterCollapseB = applyOutlineCollapseAll(initial, fileB);
		expect(afterCollapseB.has(fileA[0]!)).toBe(true);
		expect(afterCollapseB.has(fileA[1]!)).toBe(false);
		expect(afterCollapseB.has(fileB[0]!)).toBe(true);
		expect(afterCollapseB.has(fileB[1]!)).toBe(true);

		// Expand all in File B -> removes ONLY File B keys; File A stays collapsed!
		const afterExpandB = applyOutlineCollapseAll(afterCollapseB, fileB);
		expect(afterExpandB.has(fileA[0]!)).toBe(true);
		expect(afterExpandB.has(fileB[0]!)).toBe(false);
		expect(afterExpandB.has(fileB[1]!)).toBe(false);
	});

	test("Objects.tsx clears SSL debounce timer, uses reqSeq, tracks lspReadyEpoch, passes sec.line to renameHeadingAcrossWorkspace, and guards reorder in non-position sort", () => {
		const src = readSrc("../src/view/panels/Objects.tsx");
		expect(src).toContain("lspReadyEpoch");
		expect(src).toContain("let reqSeq = 0;");
		expect(src).toContain("if (!current || seq !== reqSeq) return;");
		expect(src).toContain("clearTimeout(timer);");
		expect(src).toContain("renameHeadingAcrossWorkspace(path, sec.line)");
		expect(src).toContain('if (outlineSort() !== "position") return;');
		expect(src).toContain('const inPositionOrder = outlineSort() === "position";');
		expect(src).toContain('if (outlineSort() === "position") moveSection');
	});
});

describe("R8B-6 — Explorer hardening, explorerMoves, and Rows focus", () => {
	test("explorerMoves rejects source paths outside workspace and normalizes Windows slashes/drive casing", () => {
		expect(moveProblem("/elsewhere/secret.ssl", "/w/src", "/w")).toBe("secret.ssl is outside the workspace.");
		expect(copyProblem("/elsewhere/secret.ssl", "/w/src", "/w")).toBe("secret.ssl is outside the workspace.");
		expect(moveProblem("C:\\Work\\src\\DueRules.ssl", "c:/work/src", "C:\\Work")).toBe("DueRules.ssl is already in src.");
		expect(moveProblem("/w/src/DueRules.ssl", "/w/src/", "/w")).toBe("DueRules.ssl is already in src.");
		expect(moveProblem("C:\\Work\\src\\DueRules.ssl", "c:/work/tests", "C:\\Work")).toBe("");
		expect(copyProblem("C:\\Work\\src\\DueRules.ssl", "c:/work/src", "C:\\Work")).toBe("");
	});

	test("sanitizeDropName strips control chars, illegal path chars, leading/trailing dots & spaces", () => {
		expect(sanitizeDropName("report\x00\x1f\x7f.ssl")).toBe("report.ssl");
		expect(sanitizeDropName("notes.txt...   ")).toBe("notes.txt");
		expect(sanitizeDropName("..hidden..")).toBe("hidden");
		expect(sanitizeDropName(".env")).toBe("env");
		expect(sanitizeDropName("... . .")).toBe("imported");
		expect(sanitizeDropName("a/b\\c:d*e?f\"g<h>i|j.ssl")).toBe("a-b-c-d-e-f-g-h-i-j.ssl");
	});

	test("decodeDroppedText preserves UTF-8 and falls back to windows-1252 without U+FFFD corruption", () => {
		const utf8 = new TextEncoder().encode("Temp: 25°C — café ✓");
		expect(decodeDroppedText(utf8)).toBe("Temp: 25°C — café ✓");

		// Legacy Windows-1252 STARLIMS script bytes: 0xB0 = °, 0xE9 = é, 0x80 = €, 0x93/0x94 = “ ”
		const win1252 = new Uint8Array([0x32, 0x35, 0xb0, 0x43, 0x20, 0xe9, 0x20, 0x80, 0x20, 0x93, 0x4f, 0x4b, 0x94]);
		const decoded = decodeDroppedText(win1252);
		expect(decoded).toBe("25°C é € “OK”");
		expect(decoded).not.toContain("\uFFFD");
		expect(MAX_DROP_FILE_BYTES).toBe(20 * 1024 * 1024);
	});

	test("clampExplorerHeight and resizeOpenEditorsHeight align min=56 and prevent dragging down from shrinking 1-editor lists", () => {
		expect(clampExplorerHeight(null, OPEN_EDITORS_MIN_H, OPEN_EDITORS_MAX_H, 120)).toBe(120);
		expect(clampExplorerHeight("10", OPEN_EDITORS_MIN_H, OPEN_EDITORS_MAX_H, 120)).toBe(56);
		expect(clampExplorerHeight("900", OPEN_EDITORS_MIN_H, OPEN_EDITORS_MAX_H, 120)).toBe(360);

		// 1 open editor: cap = 42 (< 56), current = 120. Dragging DOWN (+8) must NOT shrink from 120 to 50!
		expect(resizeOpenEditorsHeight(120, 42, +8)).toBe(128);
		// Dragging UP (-8) on 1-editor list stops cleanly at min 56 (never drops to 44).
		expect(resizeOpenEditorsHeight(120, 42, -8)).toBe(56);
		// 2 open editors (cap = 68), current = 120: dragging UP (-8) shrinks immediately from rendered 68 -> 60.
		expect(resizeOpenEditorsHeight(120, 68, -8)).toBe(60);
	});

	test("gitKindMapFor caches canonical lookup map per status snapshot in O(1)", () => {
		expect(gitKindMapFor(null).size).toBe(0);
		const snap: any = {
			branch: "main",
			ahead: 0,
			behind: 0,
			files: [
				{ path: "/w/src/a.ssl", staged: "added", unstaged: "modified" },
				{ path: "/w/src/b.ssl", staged: "added", unstaged: null },
			],
		};
		const map1 = gitKindMapFor(snap);
		const map2 = gitKindMapFor(snap);
		expect(map1).toBe(map2);
		expect(map1.get("/w/src/a.ssl")).toBe("modified");
		expect(map1.get("/w/src/b.ssl")).toBe("added");
		expect(map1.get("/w/src/c.ssl")).toBeUndefined();
	});

	test("focusRowsBelow selects the first [data-rows] AFTER the input in document order and never jumps up to Workspace", () => {
		const FOLLOWING = 4;
		const PRECEDING = 2;
		const focused: string[] = [];
		const mkRow = (id: string, tabIndex = -1) => ({
			id,
			tabIndex,
			focus() {
				focused.push(id);
			},
		});
		const wsRow = mkRow("ws-row-1", 0);
		const outlineRow1 = mkRow("outline-row-1", -1);
		const outlineRow2 = mkRow("outline-row-2", 0);

		const wsList: any = {
			__order: 1,
			querySelector: (sel: string) => (sel.includes('tabindex="0"') ? wsRow : wsRow),
		};
		const outlineList: any = {
			__order: 3,
			querySelector: (sel: string) => (sel.includes('tabindex="0"') ? outlineRow2 : outlineRow1),
		};
		let lists = [wsList, outlineList];
		const panel: any = {
			querySelectorAll: () => lists,
		};
		const filterInput: any = {
			__order: 2,
			closest: (sel: string) => (sel === ".panel-body" ? panel : null),
			compareDocumentPosition: (other: any) => (other.__order > 2 ? FOLLOWING : PRECEDING),
		};

		// Outline exists below input -> focuses outline's tabindex=0 row, NOT wsList above!
		expect(focusRowsBelow(filterInput)).toBe(true);
		expect(focused).toEqual(["outline-row-2"]);

		// Outline is empty (only wsList exists above input) -> returns false, never jumps up!
		focused.length = 0;
		lists = [wsList];
		expect(focusRowsBelow(filterInput)).toBe(false);
		expect(focused).toEqual([]);
	});

	test("Explorer.tsx and Rows.tsx structural hardening checks", () => {
		const expSrc = readSrc("../src/view/panels/Explorer.tsx");
		expect(expSrc).toContain("await quickPick<DocFile>");
		expect(expSrc).not.toContain("choose(`Open governing doc");
		expect(expSrc).toContain("if (root !== lastWorkspaceRoot)");
		expect(expSrc).toContain("setClip(null);");
		expect(expSrc).toContain("if (await heldFromBefore(destPath))");
		expect(expSrc).toContain("backend.sizes([path])");
		expect(expSrc).toContain("cancelExplorerFocusSearch()");
		expect(expSrc).toContain('if (state.bottomMaximized) setState("bottomMaximized", false);');
		expect(expSrc).toContain("focusEditor();");

		const rowsSrc = readSrc("../src/view/panels/Rows.tsx");
		expect(rowsSrc).toContain("Math.max(0, list.findIndex((r) => r.tabIndex === 0))");
	});
});

describe("R8B-7 — Panel registry panelOn availability filtering and narrow toggleSide", () => {
	test("panelOn('right') skips unavailable 'objects' and falls back to 'agent' so narrow toggleSide('right') opens Agent", () => {
		// No outlineable file open -> isPanelAvailable("objects") is false
		documents.clear();
		setState("groups", [{ tabs: [], active: null, mode: "text" } as any]);
		setState("activeGroup", 0);
		setState("centerView", "editors");
		setState("rightView", "objects");
		setState("settings", "layout", "dock", {});
		setState("settings", "layout", "left", false);
		setNarrowHosted(null);
		setNarrowPanels(true);

		expect(panelOn("right")).toBe("agent");
		toggleSide("right");
		expect(narrowHosted()).toBe("agent");
		expect(state.rightView).toBe("agent");
		expect(state.settings.layout.left).toBe(true);

		// Toggling right again in narrow mode closes the hosted panel cleanly
		toggleSide("right");
		expect(narrowHosted()).toBeNull();
		expect(state.settings.layout.left).toBe(false);

		// When an SSL file IS open, objects IS available and panelOn("right") respects rightView = "objects"
		const sslFake = makeFakeMonaco(":PROCEDURE Foo;\n:ENDPROC;", { languageId: "ssl", visible: true });
		setActiveTab("/w/src/Foo.ssl", sslFake.model);
		setState("rightView", "objects");
		expect(panelOn("right")).toBe("objects");
		setNarrowPanels(false);
	});
});
