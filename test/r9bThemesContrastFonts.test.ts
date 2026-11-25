import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HTML_CSP, startWebHost } from "../src/bun/web";
import { BOUNDARY, TEXT, contrast, luminance, pickAccentFg } from "../src/shared/contrast";
import { DEFAULT_CODE_FONT, DEFAULT_UI_FONT, resolveFontStack } from "../src/shared/fonts";
import { allOklchThemes, generateOklchTheme, studioVars } from "../src/shared/oklchTheme";
import darkTheme from "../src/view/themes/studio-dark.json";
import lightTheme from "../src/view/themes/studio-light.json";

// Minimal DOM + Monaco harness so themes.ts runs against real vscode-textmate and semantic.ts
// without mocking ../src/view/editor/textmate or polluting other test suites.
type MockStyleEl = {
	id: string;
	className: string;
	dataset: Record<string, string>;
	textContent: string;
	nodeType: 1;
	classList: { contains: (c: string) => boolean };
	querySelectorAll: (sel: string) => MockElement[];
};

type MockShadowRoot = {
	styles: MockStyleEl[];
	querySelector: (sel: string) => MockStyleEl | null;
	append: (el: MockStyleEl) => void;
};

type MockElement = {
	nodeType: 1;
	className: string;
	classList: { contains: (c: string) => boolean };
	shadowRoot: MockShadowRoot | null;
	children: MockElement[];
	querySelectorAll: (sel: string) => MockElement[];
};

function makeShadowHost(): MockElement {
	const styles: MockStyleEl[] = [];
	const shadowRoot: MockShadowRoot = {
		styles,
		querySelector: (sel: string) => (sel === "style[data-studio]" ? (styles.find((s) => "studio" in s.dataset) ?? null) : null),
		append: (el: MockStyleEl) => void styles.push(el),
	};
	return {
		nodeType: 1,
		className: "shadow-root-host",
		classList: { contains: (c: string) => c === "shadow-root-host" },
		shadowRoot,
		children: [],
		querySelectorAll: () => [],
	};
}

function makeWrapper(children: MockElement[]): MockElement {
	const findAll = (list: MockElement[]): MockElement[] => {
		const out: MockElement[] = [];
		for (const el of list) {
			if (el.classList.contains("shadow-root-host")) out.push(el);
			out.push(...findAll(el.children));
		}
		return out;
	};
	return {
		nodeType: 1,
		className: "monaco-wrapper",
		classList: { contains: () => false },
		shadowRoot: null,
		children,
		querySelectorAll: (sel: string) => (sel === ".shadow-root-host" ? findAll(children) : []),
	};
}

const cssProps = new Map<string, string>();
const headStyles: MockStyleEl[] = [];
const bodyHosts: MockElement[] = [];
let activeObserverCallback: ((records: { addedNodes: MockElement[] }[]) => void) | null = null;
let observerDisconnected = 0;

const rootEl = {
	dataset: {} as Record<string, string>,
	style: {
		colorScheme: "",
		setProperty(name: string, value: string) {
			cssProps.set(name, value);
		},
		getPropertyValue(name: string) {
			return cssProps.get(name) ?? "";
		},
	},
};

const mockDocument = {
	documentElement: rootEl,
	head: {
		append(el: MockStyleEl) {
			if (!headStyles.includes(el)) headStyles.push(el);
		},
	},
	body: {
		style: {} as Record<string, string>,
		querySelectorAll(sel: string) {
			return sel === ".shadow-root-host" ? [...bodyHosts] : [];
		},
	},
	getElementById(id: string) {
		return headStyles.find((s) => s.id === id) ?? null;
	},
	querySelectorAll(sel: string) {
		if (sel === "style.monaco-colors") return headStyles.filter((s) => s.className === "monaco-colors");
		return [];
	},
	createElement(_tag: string): MockStyleEl {
		return {
			id: "",
			className: "",
			dataset: {},
			textContent: "",
			nodeType: 1,
			classList: { contains: () => false },
			querySelectorAll: () => [],
		};
	},
};

const origDocument = (globalThis as any).document;
const origWindow = (globalThis as any).window;
const origSelf = (globalThis as any).self;
const origMutationObserver = (globalThis as any).MutationObserver;
const origRaf = (globalThis as any).requestAnimationFrame;
const origCancelRaf = (globalThis as any).cancelAnimationFrame;

let nextRafId = 1;
const pendingRafs = new Map<number, () => void>();
const cancelledRafIds: number[] = [];

(globalThis as any).document = mockDocument;
(globalThis as any).window = {
	Error,
	addEventListener() {},
	removeEventListener() {},
	location: { href: "http://127.0.0.1/" },
};
(globalThis as any).self = globalThis;
(globalThis as any).MutationObserver = class MockMutationObserver {
	constructor(cb: (records: { addedNodes: MockElement[] }[]) => void) {
		activeObserverCallback = cb;
	}
	observe() {}
	disconnect() {
		observerDisconnected++;
	}
};
(globalThis as any).requestAnimationFrame = (cb: () => void) => {
	const id = nextRafId++;
	pendingRafs.set(id, cb);
	return id;
};
(globalThis as any).cancelAnimationFrame = (id: number) => {
	cancelledRafIds.push(id);
	pendingRafs.delete(id);
};

let lastDefinedMonacoTheme: any = null;
const noopProxy = (extra: Record<string, any> = {}) =>
	new Proxy(extra, { get: (target, prop) => (prop in target ? target[prop as any] : () => ({ dispose() {} })) });

mock.module("monaco-editor/editor/editor.api", () => ({
	Range: class {},
	Emitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	Uri: { file: (p: string) => ({ toString: () => `file://${p}` }) },
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: {},
	languages: noopProxy(),
	editor: noopProxy({
		defineTheme: (_name: string, data: any) => {
			lastDefinedMonacoTheme = data;
		},
		setTheme: () => {},
		getEditors: () => [],
		getModels: () => [],
	}),
}));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({ default: class {} }));
mock.module(resolve(import.meta.dir, "../src/view/editor/schemaHover.ts"), () => ({ registerSchemaHoverProviders() {} }));
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

const { loadGrammar, resetGrammarForTest } = await import("../src/view/editor/textmate");
const { applyTheme, builtIn, resolveTheme, sanitizeTokenColors, shapeEditorMenus } = await import("../src/view/themes/themes");

const rootTmp = mkdtempSync(join(tmpdir(), "ssl-studio-r9b-"));

beforeAll(async () => {
	// Load the real onig.wasm and ssl.tmLanguage.json once so applyTheme exercises real vscode-textmate.
	const origFetch = globalThis.fetch;
	const wasmBytes = readFileSync(resolve(import.meta.dir, "../src/view/public/onig.wasm"));
	const grammarJson = readFileSync(resolve(import.meta.dir, "../src/view/public/grammar/ssl.tmLanguage.json"), "utf8");
	(globalThis as any).fetch = async (url: string) => {
		if (String(url).includes("onig.wasm")) return new Response(wasmBytes);
		if (String(url).includes("ssl.tmLanguage.json")) return new Response(grammarJson, { headers: { "Content-Type": "application/json" } });
		return origFetch(url as any);
	};
	try {
		await loadGrammar();
	} finally {
		(globalThis as any).fetch = origFetch;
	}
});
afterAll(() => {
	resetGrammarForTest();
	rmSync(rootTmp, { recursive: true, force: true });
	if (origDocument === undefined) delete (globalThis as any).document;
	else (globalThis as any).document = origDocument;
	if (origWindow === undefined) delete (globalThis as any).window;
	else (globalThis as any).window = origWindow;
	if (origSelf === undefined) delete (globalThis as any).self;
	else (globalThis as any).self = origSelf;
	if (origMutationObserver === undefined) delete (globalThis as any).MutationObserver;
	else (globalThis as any).MutationObserver = origMutationObserver;
	if (origRaf === undefined) delete (globalThis as any).requestAnimationFrame;
	else (globalThis as any).requestAnimationFrame = origRaf;
	if (origCancelRaf === undefined) delete (globalThis as any).cancelAnimationFrame;
	else (globalThis as any).cancelAnimationFrame = origCancelRaf;
});

function mixSrgb(fg: string, weight: number, bg: string): string {
	const p = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const;
	const [fr, fgg, fb] = p(fg);
	const [br, bgg, bb] = p(bg);
	const ch = (a: number, b: number) => Math.round(a * weight + b * (1 - weight)).toString(16).padStart(2, "0");
	return `#${ch(fr, br)}${ch(fgg, bgg)}${ch(fb, bb)}`;
}

describe("P2-1: contrast.ts hex parsing, alpha compositing & WCAG 2.1/2.2 threshold", () => {
	test("supports #RGB and #RGBA expansion identically to #RRGGBB and #RRGGBBAA", () => {
		expect(luminance("#000")).toBe(0);
		expect(luminance("#fff")).toBe(1);
		expect(luminance("#abc")).toBeCloseTo(luminance("#aabbcc"), 12);
		expect(contrast("#000", "#fff")).toBeCloseTo(21, 5);
		expect(contrast("#abc", "#123")).toBeCloseTo(contrast("#aabbcc", "#112233"), 12);
		expect(contrast("#0000", "#fff")).toBe(1);
		expect(contrast("#000f", "#fff")).toBeCloseTo(21, 5);
		expect(contrast("#0008", "#fff")).toBeCloseTo(contrast("#00000088", "#ffffff"), 12);
	});

	test("composites translucent foreground over opaque background instead of ignoring alpha", () => {
		expect(contrast("#00000000", "#ffffff")).toBe(1);
		expect(contrast("#ffffff00", "#000000")).toBe(1);
		expect(contrast("#000000ff", "#ffffff")).toBeCloseTo(21, 5);
		// 50% black over white composites to ~rgb(127,127,127), ~3.95:1 against white (not 21:1!)
		const halfBlack = contrast("#00000080", "#ffffff");
		expect(halfBlack).toBeGreaterThan(3.8);
		expect(halfBlack).toBeLessThan(4.1);
		// Semi-transparent white over dark background
		const halfWhite = contrast("#ffffff80", "#1b1d23");
		expect(halfWhite).toBeGreaterThan(4.0);
		expect(halfWhite).toBeLessThan(6.5);
	});

	test("uses WCAG 2.1/2.2 sRGB linear transfer threshold 0.04045", () => {
		// Composited value right in (0.03928, 0.04045]: #141414 (20) at alpha 0x80 (128/255) over #000000
		// gives channel = 20 * (128/255) / 255 = 0.03937... which is > 0.03928 and <= 0.04045.
		const c = (20 * (128 / 255)) / 255;
		expect(c).toBeGreaterThan(0.03928);
		expect(c).toBeLessThanOrEqual(0.04045);
		const expectedL = c / 12.92;
		const expectedRatio = (expectedL + 0.05) / 0.05;
		expect(contrast("#14141480", "#000000")).toBeCloseTo(expectedRatio, 10);
	});

	test("strictly validates hex format and returns NaN on malformed inputs", () => {
		for (const bad of ["", "transparent", "rgb(0,0,0)", "red", "bad", "facade", "##ffffff", "#12", "#12345", "#1234567", "#123456789", "#zzzzzz"]) {
			expect(Number.isNaN(luminance(bad))).toBe(true);
			expect(Number.isNaN(contrast(bad, "#ffffff"))).toBe(true);
			expect(Number.isNaN(contrast("#000000", bad))).toBe(true);
		}
		expect(Number.isNaN(luminance(null as any))).toBe(true);
		expect(Number.isNaN(contrast(undefined as any, "#ffffff"))).toBe(true);
	});

	test("pickAccentFg guarantees >= 4.5:1 across all sRGB backgrounds", () => {
		expect(pickAccentFg("#7a36ed")).toBe("#ffffff");
		expect(pickAccentFg("#ef945f")).toBe("#171411");
		expect(pickAccentFg("#777777")).toBe("#000000");
		for (let i = 0; i <= 255; i += 5) {
			const h = i.toString(16).padStart(2, "0");
			const bg = `#${h}${h}${h}`;
			const fg = pickAccentFg(bg);
			expect(contrast(fg, bg)).toBeGreaterThanOrEqual(TEXT);
		}
	});
});

describe("P1-1: resolveFontStack() CSS syntax injection & IACVT hardening", () => {
	test("strips control chars, newlines, backslashes, braces, parens, angle brackets, colons, and semicolons", () => {
		expect(resolveFontStack("JetBrains Mono; color: red", DEFAULT_CODE_FONT)).toBe(`"JetBrains Mono color red", ${DEFAULT_CODE_FONT}`);
		expect(resolveFontStack("Inter\r\n} body { display: none; }", DEFAULT_UI_FONT)).toBe(`"Inter body display none", ${DEFAULT_UI_FONT}`);
		expect(resolveFontStack("Foo\\Bar(1)<script>:baz", DEFAULT_UI_FONT)).toBe(`"FooBar1scriptbaz", ${DEFAULT_UI_FONT}`);
		expect(resolveFontStack("\x00\x07\x1b\x7f", DEFAULT_UI_FONT)).toBe(DEFAULT_UI_FONT);
		expect(resolveFontStack('url("https://evil.example/x")', DEFAULT_UI_FONT)).toBe(`"urlhttps//evil.example/x", ${DEFAULT_UI_FONT}`);
	});

	test("unwraps only matching outer quotes, strips embedded quotes, and quotes every non-generic family", () => {
		expect(resolveFontStack("Inter", DEFAULT_UI_FONT)).toBe(`"Inter", ${DEFAULT_UI_FONT}`);
		expect(resolveFontStack("IBM Plex Sans", DEFAULT_UI_FONT)).toBe(`"IBM Plex Sans", ${DEFAULT_UI_FONT}`);
		expect(resolveFontStack('"IBM Plex Sans"', DEFAULT_UI_FONT)).toBe(`"IBM Plex Sans", ${DEFAULT_UI_FONT}`);
		expect(resolveFontStack("'Source Serif 4'", DEFAULT_UI_FONT)).toBe(`"Source Serif 4", ${DEFAULT_UI_FONT}`);
		expect(resolveFontStack(`'Mismatched"`, DEFAULT_UI_FONT)).toBe(`"Mismatched", ${DEFAULT_UI_FONT}`);
		expect(resolveFontStack(`"Foo\\"; background: red; --x: "`, DEFAULT_UI_FONT)).toBe(`"Foo background red --x", ${DEFAULT_UI_FONT}`);
		expect(resolveFontStack("2Fast, bold, 12px/1.5, foo.bar", DEFAULT_UI_FONT)).toBe(`"2Fast", "bold", "12px/1.5", "foo.bar", ${DEFAULT_UI_FONT}`);
	});

	test("rejects CSS-wide keywords and preserves CSS generic families unquoted", () => {
		for (const kw of ["inherit", "INHERIT", "initial", "unset", "revert", "revert-layer", "default", '"inherit"', "'initial'"]) {
			expect(resolveFontStack(kw, DEFAULT_UI_FONT)).toBe(DEFAULT_UI_FONT);
		}
		expect(resolveFontStack("inherit, Inter, unset, monospace", DEFAULT_CODE_FONT)).toBe(`"Inter", monospace, ${DEFAULT_CODE_FONT}`);
		const generics = "system-ui, -apple-system, sans-serif, serif, monospace, ui-sans-serif, ui-serif, ui-monospace, cursive, fantasy, emoji, math, fangsong";
		expect(resolveFontStack(generics, DEFAULT_UI_FONT)).toBe(`${generics}, ${DEFAULT_UI_FONT}`);
	});
});

describe("P0-1, P0-2, P1-2: All 27 built-in themes meet WCAG AA on every new and existing contract token", () => {
	const all27 = [
		{ id: "studio-dark", theme: builtIn.dark!, kind: "classic" as const },
		{ id: "studio-light", theme: builtIn.light!, kind: "classic" as const },
		...allOklchThemes().map((t) => ({ id: t.id, theme: t, kind: "oklch" as const })),
	];

	const EXPECTED_VARS = Object.keys(studioVars(generateOklchTheme("dusk", "walnut").studio));

	test("all 27 themes emit all 44 contract CSS custom properties with valid WCAG AA contrast", () => {
		expect(all27).toHaveLength(27);
		expect(EXPECTED_VARS).toContain("--accent-fg");
		expect(EXPECTED_VARS).toContain("--editor-accent-fg");
		expect(EXPECTED_VARS).toContain("--editor-input-border");
		expect(EXPECTED_VARS).toContain("--chrome-muted");
		expect(EXPECTED_VARS).toContain("--editor-info");
		expect(EXPECTED_VARS).toContain("--editor-ok");
		expect(EXPECTED_VARS).toContain("--editor-warning");
		expect(EXPECTED_VARS).toContain("--editor-error");

		const failures: string[] = [];
		for (const { id, theme, kind } of all27) {
			cssProps.clear();
			applyTheme(theme);

			for (const name of EXPECTED_VARS) {
				const v = cssProps.get(name);
				if (!v || !/^#[0-9a-f]{6}$/i.test(v)) failures.push(`${id}: missing/invalid ${name}=${String(v)}`);
			}

			const get = (name: string) => cssProps.get(name)!;
			const check = (label: string, fg: string, bg: string, min: number) => {
				const r = contrast(fg, bg);
				if (!(r >= min)) failures.push(`${id}: ${label} (${fg} on ${bg}) = ${r.toFixed(2)} < ${min}`);
			};

			// 1. --accent-fg on --accent and --editor-accent-fg on --editor-accent >= 4.5:1
			check("--accent-fg on --accent", get("--accent-fg"), get("--accent"), TEXT);
			check("--editor-accent-fg on --editor-accent", get("--editor-accent-fg"), get("--editor-accent"), TEXT);

			// 2. --editor-input-border on [editorBg, editorStripBg] >= 3.0 (and >= 3.15 on OKLCH)
			const edBorderMin = kind === "oklch" ? 3.15 : BOUNDARY;
			check("--editor-input-border on --editor-bg", get("--editor-input-border"), get("--editor-bg"), edBorderMin);
			check("--editor-input-border on --editor-strip-bg", get("--editor-input-border"), get("--editor-strip-bg"), edBorderMin);

			// 3. --input-border on [sideBg, inputBg, cmdBg] >= 3.0
			check("--input-border on --side-bg", get("--input-border"), get("--side-bg"), BOUNDARY);
			check("--input-border on --input-bg", get("--input-border"), get("--input-bg"), BOUNDARY);
			check("--input-border on --cmd-bg", get("--input-border"), get("--cmd-bg"), BOUNDARY);

			// 4. --chrome-muted equals --muted and passes >= 4.5 on menu.background (--side-bg)
			if (get("--chrome-muted") !== get("--muted")) failures.push(`${id}: --chrome-muted !== --muted`);
			check("--chrome-muted on --side-bg (menu.background)", get("--chrome-muted"), get("--side-bg"), TEXT);

			// 5. --editor-info/ok/warning/error on [editorBg, editorStripBg, editorLineHl] >= 4.5
			for (const sem of ["--editor-info", "--editor-ok", "--editor-warning", "--editor-error"] as const) {
				for (const surf of ["--editor-bg", "--editor-strip-bg", "--editor-line-hl"] as const) {
					check(`${sem} on ${surf}`, get(sem), get(surf), TEXT);
				}
			}

			// 6. On OKLCH themes, verify cmdBg chrome text & .title-ticket.active (12% mix into cmdBg)
			if (kind === "oklch") {
				check("--muted on --cmd-bg", get("--muted"), get("--cmd-bg"), TEXT);
				check("--accent on --cmd-bg", get("--accent"), get("--cmd-bg"), TEXT);
				const ticketActiveBg = mixSrgb(get("--accent"), 0.12, get("--cmd-bg"));
				check("--accent on .title-ticket.active", get("--accent"), ticketActiveBg, TEXT);
				const g = theme as ReturnType<typeof generateOklchTheme>;
				if (g.tone === "split") {
					// Split Warm must have light-paper editor tokens distinct from dark-chrome tokens.
					expect(get("--accent-fg")).toBe("#171411");
					expect(get("--editor-accent-fg")).toBe("#ffffff");
					expect(get("--chrome-muted")).not.toBe(get("--editor-muted"));
					expect(get("--editor-info")).not.toBe(get("--info"));
					expect(get("--editor-ok")).not.toBe(get("--ok"));
					expect(get("--editor-warning")).not.toBe(get("--warning"));
					expect(get("--editor-error")).not.toBe(get("--error"));
				} else {
					expect(get("--editor-info")).toBe(get("--info"));
					expect(get("--editor-ok")).toBe(get("--ok"));
					expect(get("--editor-warning")).toBe(get("--warning"));
					expect(get("--editor-error")).toBe(get("--error"));
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test("P1-2: studio-light variable.unknown and studio-dark comment on selection pass WCAG AA", () => {
		const lightUnknown = (lightTheme.semanticTokenColors["variable.unknown"] as { foreground: string }).foreground;
		expect(lightUnknown).toBe("#be2841");
		expect(contrast(lightUnknown, lightTheme.colors["editor.lineHighlightBackground"])).toBeGreaterThanOrEqual(5.2);
		expect(contrast(lightUnknown, lightTheme.colors["editor.background"])).toBeGreaterThanOrEqual(5.6);

		const darkComment = darkTheme.tokenColors.find((t) => t.scope === "comment")!.settings.foreground!;
		expect(contrast(darkComment, darkTheme.colors["editor.selectionBackground"])).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(darkComment, darkTheme.colors["editor.lineHighlightBackground"])).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(darkComment, darkTheme.colors["editor.background"])).toBeGreaterThanOrEqual(TEXT);
	});
});

describe("P0-2 & P0-3: themes.ts JSON validation, stale CSS var prevention & menu shaping", () => {
	test("resolveTheme guards missing matchMedia in non-DOM/SSR environments", () => {
		const origMatchMedia = (globalThis as any).matchMedia;
		delete (globalThis as any).matchMedia;
		try {
			const resolved = resolveTheme("system", []);
			expect(resolved.type).toBe("dark");
			expect(resolved.studio).toBeDefined();
		} finally {
			if (origMatchMedia !== undefined) (globalThis as any).matchMedia = origMatchMedia;
		}
	});

	test("resolveTheme rejects malformed custom JSON and strips untrusted studio property", () => {
		const badInputs = ["null", "[]", '"hello"', "42", "true", "{not valid json"];
		for (const json of badInputs) {
			const resolved = resolveTheme("custom:bad", [{ id: "custom:bad", json }], true);
			expect(resolved.type).toBe("dark");
			expect(resolved.studio).toBeDefined();
		}

		const spoofed = JSON.stringify({
			name: "Spoofed",
			type: "dark",
			colors: { "editor.background": "#101010" },
			studio: { bg: "#ff00ff" },
			chromeDark: false,
			editorDark: false,
		});
		const clean = resolveTheme("custom:spoof", [{ id: "custom:spoof", json: spoofed }], true);
		expect(clean.name).toBe("Spoofed");
		expect(clean.studio).toBeUndefined();
		expect(clean.chromeDark).toBeUndefined();
		expect(clean.editorDark).toBeUndefined();
	});

	test("applyTheme filters invalid theme.colors before merging, prevents stale CSS vars, and sanitizes tokenColors", () => {
		// First apply a light OKLCH theme so light CSS vars are populated on <html>.
		applyTheme(generateOklchTheme("paper", "walnut"));
		const paperBg = cssProps.get("--bg")!;
		const paperError = cssProps.get("--error")!;
		expect(paperBg).not.toBe(darkTheme.colors["editor.background"]);

		// Now switch to a malformed imported dark theme with invalid colors and broken tokenColors/semanticTokenColors.
		const brokenImported = resolveTheme(
			"custom:broken",
			[
				{
					id: "custom:broken",
					json: JSON.stringify({
						name: "Broken Imported",
						type: "dark",
						semanticHighlighting: true,
						colors: {
							"editor.background": "transparent",
							"editor.foreground": "rgb(255, 0, 0)",
							"editorError.foreground": "",
							"focusBorder": "not-a-color",
							"sideBar.background": "#111216",
						},
						tokenColors: [
							null,
							42,
							"bad",
							{ scope: "comment" },
							{ scope: "keyword", settings: null },
							{ scope: 123, settings: { foreground: "rgb(1,2,3)" } },
							{ scope: [null, "comment"], settings: { foreground: "#99aabb", fontStyle: "italic" } },
						],
						semanticTokenColors: {
							method: "rgb(1,2,3)",
							parameter: null,
							variable: { foreground: "#aabbcc", bold: true },
						},
					}),
				},
			],
			true,
		);

		expect(() => applyTheme(brokenImported)).not.toThrow();

		// Invalid keys MUST fall back to studio-dark base colors, never leaving stale paper values!
		expect(cssProps.get("--bg")).toBe(darkTheme.colors["editor.background"]);
		expect(cssProps.get("--bg")).not.toBe(paperBg);
		expect(cssProps.get("--fg")).toBe(darkTheme.colors["editor.foreground"]);
		expect(cssProps.get("--error")).toBe(darkTheme.colors["editorError.foreground"]);
		expect(cssProps.get("--error")).not.toBe(paperError);
		expect(cssProps.get("--accent")).toBe(darkTheme.colors["focusBorder"]);
		expect(cssProps.get("--accent-fg")).toBe(pickAccentFg(darkTheme.colors["focusBorder"]));
		// Valid custom color still applied!
		expect(cssProps.get("--side-bg")).toBe("#111216");
		expect(lastDefinedMonacoTheme?.colors?.["editor.foreground"]).toBe(darkTheme.colors["editor.foreground"]);

		// Direct sanitizeTokenColors checks
		expect(sanitizeTokenColors("not-an-array")).toEqual([]);
		expect(
			sanitizeTokenColors([
				null,
				{ settings: "nope" },
				{ scope: ["comment", 42 as any], settings: { foreground: "#abcdef", background: "transparent", fontStyle: "italic" } },
			]),
		).toEqual([{ scope: ["comment"], settings: { foreground: "#abcdef", fontStyle: "italic" } }]);
	});

	test("shapeEditorMenus scans pre-existing and nested shadow-root-host nodes and uses --chrome-muted for keybindings", () => {
		bodyHosts.length = 0;
		const existingHost = makeShadowHost();
		bodyHosts.push(existingHost);

		shapeEditorMenus();

		// Pre-existing host was shaped immediately with --chrome-muted keybinding rule.
		expect(existingHost.shadowRoot!.styles).toHaveLength(1);
		expect(existingHost.shadowRoot!.styles[0]!.textContent).toContain("var(--chrome-muted, var(--muted))");

		// Newly added nested host inside a wrapper is also shaped by the MutationObserver.
		const nestedHost = makeShadowHost();
		const wrapper = makeWrapper([nestedHost]);
		expect(activeObserverCallback).not.toBeNull();
		activeObserverCallback!([{ addedNodes: [wrapper] }]);
		expect(nestedHost.shadowRoot!.styles).toHaveLength(1);
		expect(nestedHost.shadowRoot!.styles[0]!.textContent).toContain("var(--chrome-muted, var(--muted))");

		// Calling shapeEditorMenus() again disconnects prior observer instead of leaking duplicates.
		const beforeDisconnect = observerDisconnected;
		shapeEditorMenus();
		expect(observerDisconnected).toBe(beforeDisconnect + 1);
	});

	test("carryMenuColours cancels prior queued rAF and clears stale #studio-menu-colours when block is absent", () => {
		headStyles.length = 0;
		pendingRafs.clear();
		cancelledRafIds.length = 0;

		const monacoStyle = mockDocument.createElement("style");
		monacoStyle.className = "monaco-colors";
		monacoStyle.textContent = ".monaco-workbench { --vscode-menu-background: #1a1816; --vscode-menu-foreground: #e8e2d9; }";
		headStyles.push(monacoStyle);

		applyTheme(generateOklchTheme("split", "walnut"));
		const firstRafCount = pendingRafs.size;
		expect(firstRafCount).toBe(1);
		const menuStyle = mockDocument.getElementById("studio-menu-colours");
		expect(menuStyle?.textContent).toContain("--vscode-menu-background: #1a1816");

		// Second rapid theme switch cancels the prior queued rAF and clears stale menu colours when block disappears.
		monacoStyle.textContent = ".mtk1 { color: #d4d7de; }";
		applyTheme(builtIn.dark!);
		expect(cancelledRafIds.length).toBeGreaterThanOrEqual(1);
		expect(pendingRafs.size).toBe(1);
		expect(mockDocument.getElementById("studio-menu-colours")?.textContent).toBe("");
	});
});

describe("P2-2: Startup color-scheme, live OS theme sync & web host CSP", () => {
	test("index.html declares color-scheme meta to prevent startup flash", () => {
		const html = readFileSync(resolve(import.meta.dir, "../src/view/index.html"), "utf8");
		expect(html).toContain('<meta name="color-scheme" content="dark light" />');
	});

	test("App.tsx useTheme reacts live to OS prefers-color-scheme changes instead of staying pinned to static systemDark", () => {
		const appSrc = readFileSync(resolve(import.meta.dir, "../src/view/App.tsx"), "utf8");
		const start = appSrc.indexOf("function useTheme()");
		const end = appSrc.indexOf("function useLayoutPersistence");
		expect(start).toBeGreaterThan(-1);
		const useThemeSrc = appSrc.slice(start, end);
		expect(useThemeSrc).toContain('matchMedia("(prefers-color-scheme: dark)")');
		expect(useThemeSrc).toContain("liveDark");
		expect(useThemeSrc).toContain("setLiveDark");
		expect(useThemeSrc).toContain("media.matches");
	});

	test("web.ts serves strict safe Content-Security-Policy on HTML responses", async () => {
		const dist = join(rootTmp, "csp-dist");
		mkdirSync(dist, { recursive: true });
		writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>App</title></head><body></body></html>");
		writeFileSync(join(dist, "other.html"), "<!doctype html><html><head><title>Other</title></head><body></body></html>");
		writeFileSync(join(dist, "app.js"), "console.log(1);\n");

		const host = startWebHost({ port: 0, dist, quit: () => {} });
		await host.backend.ready;
		const baseUrl = `http://127.0.0.1:${host.server.port}`;
		try {
			const idxRes = await fetch(`${baseUrl}/`);
			expect(idxRes.status).toBe(200);
			const csp = idxRes.headers.get("content-security-policy");
			expect(csp).toBe(HTML_CSP);
			expect(csp).toContain("default-src 'self'");
			expect(csp).toContain("script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:");
			expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
			expect(csp).toContain("style-src 'self' 'unsafe-inline'");
			expect(csp).toContain("img-src 'self' data: blob:");
			expect(csp).toContain("font-src 'self' data:");
			expect(csp).toContain("connect-src 'self' ws: wss:");
			expect(csp).toContain("worker-src 'self' blob:");
			expect(csp).toContain("object-src 'none'");
			expect(csp).toContain("base-uri 'self'");
			expect(csp).toContain("frame-ancestors 'none'");

			const otherRes = await fetch(`${baseUrl}/other.html`);
			expect(otherRes.status).toBe(200);
			expect(otherRes.headers.get("content-security-policy")).toBe(HTML_CSP);

			const jsRes = await fetch(`${baseUrl}/app.js`);
			expect(jsRes.status).toBe(200);
			expect(jsRes.headers.get("content-security-policy")).toBeNull();
		} finally {
			host.stop();
		}
	});
});
