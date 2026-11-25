import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirs } from "../src/bun/paths";
import { SettingsStore, USER_ONLY_SETTINGS } from "../src/bun/settings";
import {
	clampMenuBarLeftOffset,
	normalizeMenuEntries,
	safeQuickPickInitialIndex,
	shouldUseQuickPick,
	submenuOrInline,
} from "../src/shared/contextMenu";
import { languageFor } from "../src/shared/languages";
import { lspIndicator } from "../src/shared/statusBar";
import { fileIcon, fileKind } from "../src/view/fileIcon";
import { keyNamesForPlatform } from "../src/view/keys";

// --- Minimal headless browser & DOM shims for testing view helpers ---
class FakeElement {
	tagName: string;
	classList: { contains: (c: string) => boolean; _set: Set<string> };
	children: FakeElement[] = [];
	parentElement: FakeElement | null = null;
	style: Record<string, string> = {};
	inert = false;
	isConnected = true;
	attributes = new Map<string, string>();
	type = "";
	readOnly = false;
	disabled = false;

	constructor(tag: string, classes: string[] = [], attrs: Record<string, string> = {}) {
		this.tagName = tag.toUpperCase();
		const set = new Set(classes);
		this.classList = { _set: set, contains: (c: string) => set.has(c) };
		for (const [k, v] of Object.entries(attrs)) {
			this.attributes.set(k, v);
			if (k === "type") this.type = v;
		}
	}

	append(...els: FakeElement[]) {
		for (const el of els) {
			el.parentElement = this;
			this.children.push(el);
		}
		return this;
	}

	contains(other: FakeElement | null): boolean {
		let cur: FakeElement | null = other;
		while (cur) {
			if (cur === this) return true;
			cur = cur.parentElement;
		}
		return false;
	}

	private matchesSimple(sel: string): boolean {
		const s = sel.trim();
		if (!s) return false;
		if (s.startsWith(".")) return this.classList.contains(s.slice(1));
		const typeMatch = /^input\[type=([a-z]+)\]$/i.exec(s);
		if (typeMatch) return this.tagName === "INPUT" && this.type.toLowerCase() === typeMatch[1]!.toLowerCase();
		if (s === "[contenteditable='']") return this.attributes.get("contenteditable") === "";
		if (s === "[contenteditable=true]") return this.attributes.get("contenteditable") === "true";
		if (/^[a-z]+$/i.test(s)) return this.tagName === s.toUpperCase();
		return false;
	}

	matches(selector: string): boolean {
		return selector.split(",").some((part) => this.matchesSimple(part));
	}

	querySelector(selector: string): FakeElement | null {
		for (const child of this.children) {
			if (child.matches(selector)) return child;
			const nested = child.querySelector(selector);
			if (nested) return nested;
		}
		return null;
	}
}

class FakeInputElement extends FakeElement {
	constructor(type = "text", classes: string[] = [], attrs: Record<string, string> = {}) {
		super("input", classes, { ...attrs, type });
	}
}

class FakeTextAreaElement extends FakeElement {
	constructor(classes: string[] = [], attrs: Record<string, string> = {}) {
		super("textarea", classes, attrs);
	}
}

if (typeof (globalThis as any).HTMLElement === "undefined") {
	(globalThis as any).HTMLElement = FakeElement;
	(globalThis as any).Element = FakeElement;
	(globalThis as any).HTMLInputElement = FakeInputElement;
	(globalThis as any).HTMLTextAreaElement = FakeTextAreaElement;
}

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
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5192" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
}
if (typeof (globalThis as any).document === "undefined") {
	(globalThis as any).document = {
		documentElement: { dataset: {}, style: {}, clientWidth: 1280 },
		head: { appendChild() {} },
		body: new FakeElement("body"),
		activeElement: null,
		getElementById: () => null,
		createElement: () => new FakeElement("div"),
		querySelector: () => null,
		addEventListener() {},
		removeEventListener() {},
	};
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

const makeUri = (scheme: string, fsPath: string) => {
	const normalized = fsPath.replace(/\\/g, "/");
	const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
	return { scheme, fsPath, path: normalized, toString: () => raw };
};

mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({ default: class {} }));
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
		SymbolKind: { Module: 1, Function: 11, Method: 5, Object: 18 },
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

const { isolateOutsideOverlay } = await import("../src/view/modal");
const { nextItem } = await import("../src/view/Menu");
const { textBox } = await import("../src/view/MenuBar");
const { clampNumericSetting, validateWorkspaceFolderSetting } = await import("../src/view/Settings");
const { templatesFolderPath } = await import("../src/view/templater");
const { setState } = await import("../src/view/state");

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");
const rootTmp = mkdtempSync(join(tmpdir(), "ssl-studio-r9a-"));
afterAll(() => rmSync(rootTmp, { recursive: true, force: true }));

describe("R9A P0-1 — ChooseQuickPick danger safety & compact destructive confirmations", () => {
	test("shouldUseQuickPick never routes compact destructive confirmations (<= 3 buttons with danger) into QuickPick", () => {
		// Even with long button text (> 34 chars) or details, <= 3 buttons with `danger` MUST stay in centered Dialog.
		expect(
			shouldUseQuickPick(
				["Trash ticket & folder (docs/tickets/LIMS-123456-very-long-name/)", "Trash ticket file only"],
				undefined,
				"Trash ticket & folder (docs/tickets/LIMS-123456-very-long-name/)",
			),
		).toBe(false);
		expect(
			shouldUseQuickPick(
				["Delete everything", "Keep"],
				{ "Delete everything": "Irreversible removal", Keep: "Leave untouched" },
				"Delete everything",
			),
		).toBe(false);
		expect(shouldUseQuickPick(["Delete"], undefined, "Delete")).toBe(false);

		// 4+ buttons still route to QuickPick (where ChooseQuickPick protects the danger row).
		expect(shouldUseQuickPick(["Delete all", "Archive", "Export", "Keep"], undefined, "Delete all")).toBe(true);
		// Non-danger long buttons or rich lists still route to QuickPick per ADR 0032.
		expect(shouldUseQuickPick(["DEMO-101: Add due dates and overdue notices (in progress)", "Clear"])).toBe(true);
	});

	test("safeQuickPickInitialIndex skips danger buttons and returns -1 when no safe button exists", () => {
		expect(safeQuickPickInitialIndex(["Alpha", "Beta"])).toBe(0);
		expect(safeQuickPickInitialIndex(["Delete all", "Keep", "Archive"], "Delete all")).toBe(1);
		expect(safeQuickPickInitialIndex(["Keep", "Delete all"], "Delete all")).toBe(0);
		expect(safeQuickPickInitialIndex(["Delete all"], "Delete all")).toBe(-1);
		expect(safeQuickPickInitialIndex([], "Delete all")).toBe(-1);
	});

	test("dialogs.tsx passes request.danger to shouldUseQuickPick, guards Enter on danger, and wraps long prompts", () => {
		const src = readSrc("../src/view/dialogs.tsx");
		expect(src).toContain("shouldUseQuickPick(request.buttons, request.details, request.danger)");
		expect(src).toContain("safeQuickPickInitialIndex(request.buttons, request.danger)");
		expect(src).toContain("cur !== request.danger || explicitPick()");
		expect(src).toContain("quickpick-prompt");
	});

	test("projectDocs.ts uses concise TRASH_ALL / TRASH_DOC labels and places folder path in the confirmation message", () => {
		const src = readSrc("../src/view/projectDocs.ts");
		expect(src).toContain('const TRASH_ALL = isLayout1 ? "Trash folder" : "Trash ticket & folder";');
		expect(src).toContain('const TRASH_DOC = "Trash ticket file only";');
		expect(src).not.toContain("Trash ticket & folder (${relFolder}/)");
	});
});

describe("R9A P0-2 — MenuBar CM6 fallthrough prevention, dead command cleanup, narrowHosted, and clamping", () => {
	test("clampMenuBarLeftOffset clamps right overflow while keeping left edge >= margin even on narrow viewports", () => {
		expect(clampMenuBarLeftOffset(100, 200, 1000, 8)).toBe(0);
		expect(clampMenuBarLeftOffset(400, 240, 500, 8)).toBe(500 - 8 - 240 - 400);
		// Ultra-narrow viewport: menu wider than viewport must clamp left to >= 8 (never negative viewport x).
		const offset = clampMenuBarLeftOffset(100, 280, 240, 8);
		expect(100 + offset).toBe(8);
	});

	test("MenuBar.tsx stops after activeLiveEditor().runAction, removes go-to-symbol-in-file, checks narrowHosted, and clamps on resize", () => {
		const src = readSrc("../src/view/MenuBar.tsx");
		expect(src).not.toContain("if (live && live.runAction(id)) return;");
		expect(src).toContain("if (live) {\n\t\tlive.runAction(id);\n\t\treturn;\n\t}");
		expect(src).not.toContain('"go-to-symbol-in-file"');
		expect(src).toContain('"quick-outline"');
		expect(src).toContain("const hostedRight = narrowPanels() ? narrowHosted() : null;");
		expect(src).toContain('if (hosted && sideOf(hosted) === "right") movePanel(hosted);');
		expect(src).toContain('window.addEventListener("resize", reposition)');
		expect(src).toContain("clampMenuBarLeftOffset(");
	});
});

describe("R9A P1 — modal.tsx portaling, stacked isolation, IME safety, and focus restoration", () => {
	test("isolateOutsideOverlay isolates underlying modals and app chrome while keeping .toasts and .row-menu-host interactive", () => {
		const body = new FakeElement("body");
		const root = new FakeElement("div");
		const app = new FakeElement("div", ["app"]);
		const menubar = new FakeElement("div", ["menubar"]);
		const center = new FakeElement("main", ["center"]);
		const toasts = new FakeElement("div", ["toasts"]);
		app.append(menubar, center, toasts);
		root.append(app);

		const rowMenuPortal = new FakeElement("div");
		const rowMenuShade = new FakeElement("div", ["row-menu-shade"]);
		const rowMenuHost = new FakeElement("div", ["row-menu-host"]);
		rowMenuPortal.append(rowMenuShade, rowMenuHost);

		const modal1Portal = new FakeElement("div");
		const modal1Overlay = new FakeElement("div", ["overlay"]);
		modal1Portal.append(modal1Overlay);

		const modal2Portal = new FakeElement("div");
		const modal2Overlay = new FakeElement("div", ["overlay"]);
		modal2Portal.append(modal2Overlay);

		body.append(root, rowMenuPortal, modal1Portal, modal2Portal);

		const prevBody = (globalThis as any).document.body;
		(globalThis as any).document.body = body;
		try {
			// Isolate around top modal (modal2Overlay).
			const made = isolateOutsideOverlay(modal2Overlay as unknown as HTMLElement);
			expect(menubar.inert).toBe(true);
			expect(center.inert).toBe(true);
			expect(modal1Portal.inert).toBe(true);
			// Excluded live surfaces and active overlay stay interactive!
			expect(toasts.inert).toBe(false);
			expect(root.inert).toBe(false);
			expect(app.inert).toBe(false);
			expect(rowMenuPortal.inert).toBe(false);
			expect(rowMenuHost.inert).toBe(false);
			expect(rowMenuShade.inert).toBe(false);
			expect(modal2Portal.inert).toBe(false);
			expect(modal2Overlay.inert).toBe(false);
			expect(made.length).toBe(3);

			// Un-inert all cleanly.
			for (const el of made) el.inert = false;
			expect(menubar.inert).toBe(false);
			expect(modal1Portal.inert).toBe(false);
		} finally {
			(globalThis as any).document.body = prevBody;
		}
	});

	test("modal.tsx portals to document.body, guards IME, syncs isolation, and restores focus to underlying modal", () => {
		const src = readSrc("../src/view/modal.tsx");
		expect(src).toContain("Portal");
		expect(src).toContain("<Portal mount={document.body}>");
		expect(src).toContain("if (e.isComposing || e.keyCode === 229) return;");
		expect(src).toContain("syncIsolation()");
		expect(src).toContain("const wasTop = at === stack.length - 1;");
		expect(src).toContain("const nextTop = stack[stack.length - 1]?.dialog();");
	});
});

describe("R9A P1 — dialogs.tsx IME guards, QuickPickMany focus & keys, non-searchable a11y, FileBrowser focus", () => {
	test("dialogs.tsx guards IME in every key handler and preserves focus/a11y across all overlay modals", () => {
		const src = readSrc("../src/view/dialogs.tsx");
		const imeCount = [...src.matchAll(/isComposing \|\| e\.keyCode === 229/g)].length;
		expect(imeCount).toBeGreaterThanOrEqual(7);
		// QuickPickManyModal refocuses inputEl on Select all / Clear and wires <Modal onKey>
		expect(src).toContain("onKey={onModalKey}");
		expect(src).toMatch(/selectAllVisible[\s\S]*inputEl\?\.focus\(\)/);
		expect(src).toMatch(/clearAll[\s\S]*inputEl\?\.focus\(\)/);
		// Non-searchable QuickPickModal has aria-activedescendant + PageDown/PageUp/Home/End
		expect(src).toContain("aria-activedescendant={!req.searchable && filtered().length ? `${listId}-${selected()}` : undefined}");
		// FileBrowserModal refocuses inputEl on breadcrumb click and handles Home/End
		expect(src).toContain("onClick={() => (setDir(crumb.path), setSelected(0), inputEl?.focus())}");
		expect(src).toContain('else if (e.key === "End" && !query()) (e.preventDefault(), setSelected(Math.max(0, rows().length - 1)))');
	});
});

describe("R9A P1 — Menu.tsx modal close, focusout/blur/scroll close, loader error handling, and a11y", () => {
	test("nextItem skips disabled items and separators, returning from when all items are disabled", () => {
		const allDisabled = [
			"separator" as const,
			{ label: "One", disabled: true, run: () => {} },
			{ label: "Two", disabled: true, run: () => {} },
		];
		expect(nextItem(allDisabled, -1, 1)).toBe(-1);
		expect(nextItem(allDisabled, allDisabled.length, -1)).toBe(allDisabled.length);
	});

	test("Menu.tsx closes on modalOpen/blur/scroll/focusout, catches async loader errors, opens on ArrowDown/Up, clamps non-floating, and focuses list fallback", () => {
		const src = readSrc("../src/view/Menu.tsx");
		expect(src).toMatch(/modalOpen\(\) && items\(\) !== null[\s\S]*?if \(shouldClose\) close\(false\);/);
		expect(src).toContain('window.addEventListener("blur", onBlur)');
		expect(src).toContain('window.addEventListener("scroll", onScroll, true)');
		expect(src).toContain("onFocusOut={onFocusOut}");
		expect(src).toContain("try {\n\t\t\tloaded = await props.items();");
		expect(src).toContain('e.key === "ArrowDown" && !items()');
		expect(src).toContain('e.key === "ArrowUp" && !items()');
		expect(src).toContain("tabindex={-1}");
		expect(src).toContain("list?.focus()");
		expect(src).toContain("const targetLeft = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));");
	});
});

describe("R9A P1 — contextMenu.ts, MenuBar.tsx inline inputs, submenuOrInline unwrap, and RowMenu ARIA", () => {
	test("textBox allows Find/Replace and CM6 inline inputs while excluding editor content surfaces and non-text input types", () => {
		const cmEditor = new FakeElement("div", ["cm-editor"]);
		const cmContent = new FakeElement("div", ["cm-content"], { contenteditable: "true" });
		const cmFindInput = new FakeInputElement("text", ["cm-textfield"]);
		const cmCellInput = new FakeInputElement("text", ["cm-tbl-cell-input"]);
		cmEditor.append(cmContent, cmFindInput, cmCellInput);

		const monacoEditor = new FakeElement("div", ["monaco-editor"]);
		const monacoInputArea = new FakeTextAreaElement(["inputarea"]);
		const monacoFindBox = new FakeTextAreaElement(["input"]);
		monacoEditor.append(monacoInputArea, monacoFindBox);

		expect(textBox(cmFindInput as unknown as Element)).toBe(cmFindInput as unknown as HTMLElement);
		expect(textBox(cmCellInput as unknown as Element)).toBe(cmCellInput as unknown as HTMLElement);
		expect(textBox(monacoFindBox as unknown as Element)).toBe(monacoFindBox as unknown as HTMLElement);

		expect(textBox(cmContent as unknown as Element)).toBeNull();
		expect(textBox(monacoInputArea as unknown as Element)).toBeNull();
		expect(textBox(new FakeElement("div", ["native-edit-context"], { contenteditable: "true" }) as unknown as Element)).toBeNull();
		expect(textBox(new FakeTextAreaElement(["ime-text-area"]) as unknown as Element)).toBeNull();

		for (const badType of ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]) {
			expect(textBox(new FakeInputElement(badType) as unknown as Element)).toBeNull();
		}
	});

	test("submenuOrInline unwraps a single submenu entry instead of double-wrapping it", () => {
		const out = submenuOrInline("Outer", [
			"separator",
			{ label: "Move", danger: true, children: ["Up", "Down"] },
			"separator",
		]);
		expect(out).toHaveLength(1);
		const normalized = normalizeMenuEntries(out);
		expect(normalized).toHaveLength(1);
		const only = normalized[0]!;
		expect(only !== "separator" && only.kind === "submenu").toBe(true);
		if (only !== "separator" && only.kind === "submenu") {
			expect(only.label).toBe("Move");
			expect(only.danger).toBe(true);
			expect(only.children.map((c) => (c === "separator" ? "-" : c.label))).toEqual(["Up", "Down"]);
		}
	});

	test("contextMenu.ts and RowMenu.tsx implement editor-surface exclusions and menuitemcheckbox ARIA", () => {
		const ctxSrc = readSrc("../src/view/contextMenu.ts");
		expect(ctxSrc).not.toContain('box.closest(".cm-editor")');
		expect(ctxSrc).toContain(".cm-content, .inputarea, .ime-text-area, .native-edit-context");
		expect(ctxSrc).toContain("input[type=submit]");

		const mbSrc = readSrc("../src/view/MenuBar.tsx");
		expect(mbSrc).not.toContain('el.closest(".monaco-editor, .cm-editor")');
		expect(mbSrc).toContain("MUTATING_BOX_COMMANDS");
		expect(mbSrc).toContain("boxCannotEdit");

		const rmSrc = readSrc("../src/view/panels/RowMenu.tsx");
		expect(rmSrc).toContain('role={entry.checked !== undefined ? "menuitemcheckbox" : "menuitem"}');
		expect(rmSrc).toContain("[role=menuitem]:not(:disabled), [role=menuitemcheckbox]:not(:disabled)");
	});
});

describe("R9A P1 — Settings.tsx, templater.ts, and USER_ONLY_SETTINGS security", () => {
	test("validateWorkspaceFolderSetting allows empty (null) and workspace-relative folders, rejecting absolute paths and '..' escapes", () => {
		expect(validateWorkspaceFolderSetting("")).toEqual({ ok: true, value: null });
		expect(validateWorkspaceFolderSetting("   ")).toEqual({ ok: true, value: null });
		expect(validateWorkspaceFolderSetting("docs/attachments")).toEqual({ ok: true, value: "docs/attachments" });
		expect(validateWorkspaceFolderSetting("docs/sub/../templates")).toEqual({ ok: true, value: "docs/sub/../templates" });

		for (const bad of ["/etc/passwd", "\\\\server\\share", "C:\\Windows", "D:foo", "..", "../outside", "docs/../../outside", "../__ws_root__/docs", "docs/\x00bad"]) {
			const res = validateWorkspaceFolderSetting(bad);
			expect(res.ok).toBe(false);
		}
	});

	test("clampNumericSetting handles finite 0 consistently with negatives and falls back only on empty/NaN", () => {
		expect(clampNumericSetting("0", 8, 32, 13)).toBe(8);
		expect(clampNumericSetting("-1", 8, 32, 13)).toBe(8);
		expect(clampNumericSetting("999", 8, 32, 13)).toBe(32);
		expect(clampNumericSetting("", 8, 32, 13)).toBe(13);
		expect(clampNumericSetting("NaN", 8, 32, 13)).toBe(13);
		expect(clampNumericSetting("0", 0, 60, 10)).toBe(0);
		expect(clampNumericSetting("-5", 0, 60, 10)).toBe(0);
		expect(clampNumericSetting("120", 0, 60, 10)).toBe(60);
	});

	test("templatesFolderPath confines custom templatesFolder inside workspace root", async () => {
		const { flush } = await import("solid-js");
		setState((s) => {
			s.workspace = { root: "/work/project", name: "project" } as any;
			s.project = { docs: "docs" } as any;
		});
		flush();
		try {
			setState((s) => { s.settings.templatesFolder = "custom/tpls"; });
			flush();
			expect(templatesFolderPath()).toBe("/work/project/custom/tpls");

			setState((s) => { s.settings.templatesFolder = "../../etc/evil"; });
			flush();
			expect(templatesFolderPath()).toBe("/work/project/docs/templates");

			setState((s) => { s.settings.templatesFolder = "/etc/evil"; });
			flush();
			expect(templatesFolderPath()).toBe("/work/project/docs/templates");

			setState((s) => { s.settings.templatesFolder = "C:\\Windows\\System32"; });
			flush();
			expect(templatesFolderPath()).toBe("/work/project/docs/templates");
		} finally {
			setState((s) => {
				s.settings.templatesFolder = undefined;
				s.workspace = null;
				s.project = null;
			});
			flush();
		}
	});

	test("USER_ONLY_SETTINGS blocks workspace 'keys' overrides while honoring user 'keys'", async () => {
		expect(USER_ONLY_SETTINGS.has("keys")).toBe(true);
		const prev = { ...dirs };
		const sandbox = mkdtempSync(join(rootTmp, "keys-sec-"));
		dirs.config = join(sandbox, "config");
		dirs.data = join(sandbox, "data");
		dirs.state = join(sandbox, "state");
		const ws = join(sandbox, "ws");
		mkdirSync(dirs.config, { recursive: true });
		mkdirSync(join(ws, ".ssl-studio"), { recursive: true });
		try {
			writeFileSync(join(dirs.config, "settings.json"), JSON.stringify({ keys: { "ctrl+k": "quick-open" } }));
			writeFileSync(join(ws, ".ssl-studio", "settings.json"), JSON.stringify({ keys: { "ctrl+s": "delete-everything" }, fontSize: 15 }));
			const store = new SettingsStore(() => ws);
			const loaded = await store.load();
			expect(loaded.workspace.keys).toBeUndefined();
			expect(loaded.effective.keys).toEqual({ "ctrl+k": "quick-open" });
			expect(loaded.effective.fontSize).toBe(15);
		} finally {
			dirs.config = prev.config;
			dirs.data = prev.data;
			dirs.state = prev.state;
		}
	});

	test("Settings.tsx uses keyNamesForPlatform, guards IME & inApp theme cancel, and commits text inputs on Enter", () => {
		expect(keyNamesForPlatform({ key: "a", ctrlKey: true }, true)).toEqual([]);
		expect(keyNamesForPlatform({ key: "k", metaKey: true }, true)).toEqual(["cmd+k", "ctrl+k"]);

		const src = readSrc("../src/view/Settings.tsx");
		expect(src).toContain("keyNamesForPlatform(e, onMac)");
		expect(src).toContain("if (e.isComposing || e.keyCode === 229) return true;");
		expect(src).toContain("if (!inApp) notify(");
		expect(src).toContain("onKeyDown={commitOnEnter}");
		expect(src).toContain('saveRelFolder("attachmentsFolder"');
		expect(src).toContain('saveRelFolder("templatesFolder"');
		expect(src).not.toContain('save("attachmentsFolder", e.currentTarget.value.trim() || undefined)');
		expect(src).not.toContain('save("templatesFolder", e.currentTarget.value.trim() || undefined)');
	});
});

describe("R9A P1 — languages, monaco, StatusBar, EditorGroup cursor sync, fileIcon, Welcome", () => {
	test("languages.ts and monaco.ts recognize .ssl.txt, .srvscr.txt, and .ds.txt Designer text exports as SSL", () => {
		expect(languageFor("OldRule.ssl.txt")).toBe("ssl");
		expect(languageFor("Legacy.SRVSCR.TXT")).toBe("ssl");
		expect(languageFor("Samples.ds.txt")).toBe("ssl");
		expect(languageFor("Notes.txt")).toBe("plaintext");

		const monacoSrc = readSrc("../src/view/editor/monaco.ts");
		expect(monacoSrc).toContain('".ssl.txt"');
		expect(monacoSrc).toContain('".srvscr.txt"');
		expect(monacoSrc).toContain('".ds.txt"');
	});

	test("fileIcon.ts maps .csv, .tsv, and .srvscr.txt cleanly", () => {
		expect(fileKind("database.csv")).toBe("data");
		expect(fileKind("export.TSV")).toBe("data");
		expect(fileKind("Legacy.srvscr.txt")).toBe("script");
		expect(fileIcon("database.csv").kind).toBe("data");
	});

	test("lspIndicator always returns actionable: false when !hasWorkspace, even with warnings or errors", () => {
		expect(lspIndicator({ state: "stopped" }, { ok: true, version: "0.31.0" }, false).actionable).toBe(false);
		expect(lspIndicator({ state: "stopped", message: "starlims-lsp not found" }, { ok: false, message: "not found" }, false)).toMatchObject({
			tone: "error",
			actionable: false,
		});
		expect(lspIndicator({ state: "failed", message: "crashed" }, { ok: true }, false).actionable).toBe(false);
		expect(lspIndicator({ state: "starting" }, { ok: true }, false).actionable).toBe(false);
		expect(lspIndicator({ state: "running" }, { ok: true }, false).actionable).toBe(false);
		expect(lspIndicator({ state: "failed", message: "crashed" }, { ok: true }, false).detail).not.toContain("Click to restart");
		expect(lspIndicator({ state: "running" }, { ok: true }, true).actionable).toBe(true);
	});

	test("StatusBar.tsx, EditorGroup.tsx, and Welcome.tsx invariants", () => {
		const sbSrc = readSrc("../src/view/StatusBar.tsx");
		expect(sbSrc).not.toContain('title="Show Problems (Ctrl+Shift+M)"');
		expect(sbSrc).toContain('keysFor("problems")');
		expect(sbSrc).not.toContain("box.top - 70");
		expect(sbSrc).toContain("placeAnchoredMenu(");
		expect(sbSrc).toContain("doc.model.isDisposed()");
		expect(sbSrc).toContain("displayName(doc.path)");
		expect(sbSrc).toContain("${activePath() ?? \"\"}\\0${state.kindVersion}");
		expect(sbSrc).toContain("if (!state.workspace) return;");

		const egSrc = readSrc("../src/view/editor/EditorGroup.tsx");
		expect(egSrc).toMatch(/onDidFocusEditorText\(\(\) => \{\s*const at = editor\.getPosition\(\);[\s\S]*?s\.activeGroup = props\.index;/);
		expect(egSrc).toContain("liveEditorAt(props.index)?.getPosition()");

		const wSrc = readSrc("../src/view/Welcome.tsx");
		expect(wSrc).toContain("() => state.workspace?.root ?? \"\"");
		expect(wSrc).toContain("backend.recent().catch(() => [] as string[])");
		expect(wSrc).toContain("const mod = loaded() ?? (await commandsPromise);");
		// <kbd>{keys("open-folder")}</kbd> must appear BEFORE "Return to {state.workspace!.name}"
		expect(wSrc.indexOf('<kbd>{keys("open-folder")}</kbd>')).toBeLessThan(wSrc.indexOf("Return to {state.workspace!.name}"));
	});
});

describe("R9A P1 — ADR 0032 compliance & duplicate Cancel cleanup (TableView, Agent, projectDocs)", () => {
	test("TableView.tsx removes duplicate Cancel buttons from choose() calls and removes runtime TABLE_POWER_CSS <style> injection", () => {
		const src = readSrc("../src/view/editor/TableView.tsx");
		expect(src).toContain('import "./tableViewExtra.css";');
		expect(src).not.toContain("TABLE_POWER_CSS");
		expect(src).not.toContain("ensureTablePowerStyles");
		expect(src).not.toContain('["Delete rows", "Cancel"]');
		expect(src).not.toContain('["Delete column", "Cancel"]');
		expect(src).not.toContain('["Apply sort to file", "Cancel"]');
		expect(src).not.toContain('["Overwrite", "Cancel"]');
	});

	test("Agent.tsx uses quickPick() instead of choose() + labels.indexOf for all 3 item pickers", () => {
		const src = readSrc("../src/view/agent/Agent.tsx");
		expect(src).not.toContain('choose("Save which code block as a kept snippet?"');
		expect(src).not.toContain("choose(`Write this reply as the answer to which open question");
		expect(src).not.toContain('choose(placeholder || "Choose an option", labels)');
		expect(src).toContain("await quickPick<FencedBlock>({");
		expect(src).toContain("await quickPick<DocFile>({");
		expect(src).toContain("const idx = await quickPick<number>({");
	});

	test("projectDocs.ts replaces choose(..., { details }) pickers at interface direction, ADR supersede, and workspace onboarding with quickPick()", () => {
		const src = readSrc("../src/view/projectDocs.ts");
		expect(src).not.toContain("choose(`Which way does");
		expect(src).not.toContain('choose("Link a superseding decision to this ADR?"');
		expect(src).not.toContain("choose(summary, choices, { details })");
		expect(src).toContain('await quickPick<"in" | "out" | "both">({');
		expect(src).toContain('await quickPick<"link" | "create" | "skip">({');
		expect(src).toContain('await quickPick<"onboard" | "list">({');
	});
});
