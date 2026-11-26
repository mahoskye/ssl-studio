import { afterAll, describe, expect, mock, test } from "bun:test";
import { flush } from "solid-js";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as oniguruma from "vscode-oniguruma";
import { Registry } from "vscode-textmate";
import { LspProcess } from "../src/bun/lsp";
import { LEGEND, semanticRules, tokenStyle, translateTokens } from "../src/view/editor/semantic";
import { LspClient } from "../src/view/lsp/client";
import { applyTextEdits, changedRanges } from "../src/view/lsp/edits";

// Minimal browser & Monaco shims so editor/LSP view modules load cleanly under Bun tests.
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/" },
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
		createElement: () => ({ style: {} }),
	};
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

class MockRange {
	constructor(
		public startLineNumber: number,
		public startColumn: number,
		public endLineNumber: number,
		public endColumn: number,
	) {}
}

class MockUri {
	readonly scheme: string;
	readonly path: string;
	readonly fsPath: string;
	constructor(scheme: string, path: string) {
		this.scheme = scheme;
		this.path = path;
		this.fsPath = path;
	}
	toString() {
		return this.scheme === "file" ? `file://${encodeURI(this.path)}` : `${this.scheme}:${this.path}`;
	}
	static file(p: string) {
		return new MockUri("file", p.replace(/\\/g, "/"));
	}
	static parse(raw: string) {
		if (raw.startsWith("file://")) {
			const decoded = decodeURI(raw.slice("file://".length));
			return new MockUri("file", decoded);
		}
		const idx = raw.indexOf(":");
		return idx >= 0 ? new MockUri(raw.slice(0, idx), raw.slice(idx + 1)) : new MockUri("file", raw);
	}
	static from(parts: { scheme: string; path?: string }) {
		return new MockUri(parts.scheme, parts.path ?? "/");
	}
}

const mockModels = new Map<string, any>();
const mockMarkers = new Map<string, Map<string, any[]>>();

const noopProxy = (extra: Record<string, any> = {}) =>
	new Proxy(extra, { get: (target, prop) => (prop in target ? target[prop as any] : () => ({ dispose() {} })) });

mock.module("monaco-editor/editor/editor.api", () => ({
	Range: MockRange,
	Emitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	Uri: MockUri,
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: {},
	languages: noopProxy({
		CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24 },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
		FoldingRangeKind: { Comment: { value: "comment" }, Imports: { value: "imports" }, Region: { value: "region" } },
		SymbolKind: { Namespace: 2, Class: 4, Method: 5, Function: 11 },
	}),
	editor: noopProxy({
		getEditors: () => [],
		ScrollType: { Immediate: 1 },
		getModels: () => [...mockModels.values()],
		getModel: (uri: MockUri) => mockModels.get(uri.toString()) ?? null,
		setModelMarkers: (model: any, owner: string, markers: any[]) => {
			const key = model.uri.toString();
			let byOwner = mockMarkers.get(key);
			if (!byOwner) {
				byOwner = new Map();
				mockMarkers.set(key, byOwner);
			}
			byOwner.set(owner, markers);
		},
		getModelMarkers: (filter?: { resource?: MockUri }) => {
			if (filter?.resource) {
				const byOwner = mockMarkers.get(filter.resource.toString());
				return byOwner ? [...byOwner.values()].flat() : [];
			}
			return [...mockMarkers.values()].flatMap((m) => [...m.values()].flat());
		},
	}),
}));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({ default: class {} }));

const { matchMarkerSeverity, observeMarkerHoverSeverity } = await import("../src/view/editor/hoverSeverity");
const { normalizeMonacoHex, sslCommentSpans } = await import("../src/view/editor/textmate");
const { diagnostics, publishFindings, toMinimalEdits, LspSession } = await import("../src/view/lsp/session");

const rootTmp = mkdtempSync(join(tmpdir(), "ssl-studio-r2a-"));
afterAll(() => rmSync(rootTmp, { recursive: true, force: true }));

function makeFakeModel(text: string, uriStr = "file:///ws/test.ssl", eol = "\n") {
	const uri = MockUri.parse(uriStr);
	let value = text;
	let disposed = false;
	const lines = () => value.split(eol);
	const model: any = {
		uri,
		getLanguageId: () => "ssl",
		isDisposed: () => disposed,
		dispose: () => {
			disposed = true;
			mockModels.delete(uri.toString());
		},
		getEOL: () => eol,
		getValue: () => value,
		getLineCount: () => lines().length,
		getLineMaxColumn: (lineNumber: number) => (lines()[lineNumber - 1]?.length ?? 0) + 1,
		validateRange: (r: MockRange) => {
			const ls = lines();
			const clampPos = (line: number, col: number) => {
				if (line < 1) return { line: 1, col: 1 };
				if (line > ls.length) return { line: ls.length, col: ls[ls.length - 1]!.length + 1 };
				return { line, col: Math.min(Math.max(1, col), ls[line - 1]!.length + 1) };
			};
			const start = clampPos(r.startLineNumber, r.startColumn);
			const end = clampPos(r.endLineNumber, r.endColumn);
			return new MockRange(start.line, start.col, end.line, end.col);
		},
		getValueInRange: (r: MockRange) => {
			const ls = lines();
			if (r.startLineNumber === r.endLineNumber) {
				return ls[r.startLineNumber - 1]!.slice(r.startColumn - 1, r.endColumn - 1);
			}
			const parts = [ls[r.startLineNumber - 1]!.slice(r.startColumn - 1)];
			for (let l = r.startLineNumber + 1; l < r.endLineNumber; l++) parts.push(ls[l - 1]!);
			parts.push(ls[r.endLineNumber - 1]!.slice(0, r.endColumn - 1));
			return parts.join(eol);
		},
		onDidChangeContent: () => ({ dispose() {} }),
		onWillDispose: () => ({ dispose() {} }),
		getVersionId: () => 1,
		applyEdits(edits: { range: MockRange; text: string }[]) {
			const offsetOf = (line: number, col: number) => {
				const ls = lines();
				let off = 0;
				for (let i = 0; i < line - 1; i++) off += ls[i]!.length + eol.length;
				return off + (col - 1);
			};
			const placed = edits
				.map((e) => ({
					from: offsetOf(e.range.startLineNumber, e.range.startColumn),
					to: offsetOf(e.range.endLineNumber, e.range.endColumn),
					text: e.text,
				}))
				.sort((a, b) => b.from - a.from || b.to - a.to);
			for (const e of placed) value = value.slice(0, e.from) + e.text + value.slice(e.to);
			return value;
		},
	};
	mockModels.set(uri.toString(), model);
	return model;
}

describe("edits.ts LSP Position clamping and changedRanges", () => {
	const at = (line: number, character: number) => ({ line, character });

	test("applyTextEdits clamps columns past EOL before LF and CRLF without splitting CRLF", () => {
		expect(applyTextEdits("ab\ncd", [{ range: { start: at(0, 99), end: at(0, 99) }, newText: "!" }])).toBe("ab!\ncd");
		expect(applyTextEdits("ab\r\ncd", [{ range: { start: at(0, 99), end: at(0, 99) }, newText: "!" }])).toBe("ab!\r\ncd");
		expect(applyTextEdits("\r\ncd", [{ range: { start: at(0, 5), end: at(0, 5) }, newText: "!" }])).toBe("!\r\ncd");
		// Full-line CRLF deletion spans into next line column 0 and removes CRLF cleanly.
		expect(applyTextEdits("ab\r\ncd", [{ range: { start: at(0, 0), end: at(1, 0) }, newText: "" }])).toBe("cd");
		// Replacing to past EOL on line 0 does not swallow the newline.
		expect(applyTextEdits("ab\r\ncd", [{ range: { start: at(0, 1), end: at(0, 99) }, newText: "X" }])).toBe("aX\r\ncd");
	});

	test("applyTextEdits clamps negative line and negative character safely", () => {
		expect(applyTextEdits("ab\ncd", [{ range: { start: at(-2, 0), end: at(-1, 0) }, newText: "!" }])).toBe("!ab\ncd");
		expect(applyTextEdits("ab\ncd", [{ range: { start: at(-5, -3), end: at(0, 1) }, newText: "Z" }])).toBe("Zb\ncd");
	});

	test("changedRanges preserves non-empty adjacent ranges on leading and interior pure deletions", () => {
		// Pure deletion before first kept line in trimmed middle:
		const r1 = changedRanges(["a", "d1", "k", "d2", "b"], ["a", "k", "b"]);
		expect(r1.length).toBeGreaterThanOrEqual(1);
		expect(r1.some(([s, e]) => s <= 1 && e >= 0)).toBe(true);
		for (const [s, e] of r1) {
			expect(s).toBeGreaterThanOrEqual(0);
			expect(e).toBeGreaterThanOrEqual(s);
			expect(e).toBeLessThan(3);
		}

		// Leading deletion at start of file + edit later in file:
		const r2 = changedRanges(["deleted", "k1", "k2", "k3", "old"], ["k1", "k2", "k3", "new"]);
		expect(r2).toEqual([
			[0, 0],
			[3, 3],
		]);

		// Deletion right after a kept prefix and before a kept middle, with a separate edit later:
		const r3 = changedRanges(["a", "deleted", "k1", "k2", "old"], ["a", "k1", "k2", "new"]);
		expect(r3).toEqual([
			[0, 0],
			[3, 3],
		]);
	});
});

describe("semantic.ts independent inheritance, empty rules, language qualifiers, and >=32 modifiers", () => {
	test("inherits foreground when a more specific rule sets only fontStyle", () => {
		// TextMate tokenColors inheritance:
		const scopeTheme = {
			semanticHighlighting: true,
			tokenColors: [
				{ scope: "variable", settings: { foreground: "#444444" } },
				{ scope: "variable.parameter", settings: { fontStyle: "italic" } },
			],
		};
		expect(tokenStyle(scopeTheme, "parameter", [])).toEqual({ foreground: "#444444", fontStyle: "italic" });

		// semanticTokenColors inheritance from less-specific semantic rule:
		const semTheme = {
			semanticHighlighting: true,
			semanticTokenColors: {
				variable: "#aaaaaa",
				"variable.readonly": { italic: true },
			},
		};
		expect(tokenStyle(semTheme, "variable", ["readonly"])).toEqual({ foreground: "#aaaaaa", fontStyle: "italic" });

		// semanticTokenColors fontStyle-only inherits foreground from TextMate tokenColors:
		const mixedTheme = {
			semanticHighlighting: true,
			tokenColors: [{ scope: "variable.other.readwrite", settings: { foreground: "#555555" } }],
			semanticTokenColors: { "variable.unknown": { underline: true } },
		};
		expect(tokenStyle(mixedTheme, "variable", ["unknown"])).toEqual({ foreground: "#555555", fontStyle: "underline" });
	});

	test("returns null for empty semantic rules such as { italic: false } so TextMate is never overridden", () => {
		const theme = {
			semanticHighlighting: true,
			semanticTokenColors: {
				variable: { italic: false },
				function: {},
			},
		};
		expect(tokenStyle(theme, "variable", [])).toBeNull();
		expect(tokenStyle(theme, "function", [])).toBeNull();
		expect(semanticRules(theme)).toEqual([]);
	});

	test("supports :ssl language qualifiers and ignores non-SSL :lang qualifiers", () => {
		const theme = {
			semanticHighlighting: true,
			semanticTokenColors: {
				variable: "#111111",
				"variable:ssl": "#222222",
				"variable:python": "#999999",
				"function:python": "#888888",
				"*.readonly:typescript": "#777777",
				"*.readonly:ssl": { italic: true },
			},
		};
		expect(tokenStyle(theme, "variable", [])?.foreground).toBe("#222222");
		expect(tokenStyle(theme, "variable", ["readonly"])).toEqual({ foreground: "#222222", fontStyle: "italic" });
		expect(tokenStyle(theme, "function", [])).toBeNull();
	});

	test("translateTokens ignores modifier indices >= 32 instead of wrapping 1 << 32 into bit 0", () => {
		const modifiers = Array.from({ length: 34 }, (_, i) => (i === 32 ? "readonly" : `custom${i}`));
		const legend = { tokenTypes: ["variable"], tokenModifiers: modifiers };
		// Bit 0 is set (custom0), NOT bit 32 (which doesn't fit in 32-bit bitmask).
		// Without the index < 32 guard, `1 << 32` wraps to `1` and falsely enables `readonly`!
		const out = [...translateTokens([0, 0, 4, 0, 1], legend, () => true)];
		expect(out).toEqual([0, 0, 4, LEGEND.tokenTypes.indexOf("variable"), 0]);
	});
});

describe("textmate.ts normalizeMonacoHex and canonical SSL comment spans", () => {
	test("normalizeMonacoHex expands #RGB and #RGBA, strips 8-digit alpha, and rejects invalid colors", () => {
		expect(normalizeMonacoHex("#ABC")).toBe("AABBCC");
		expect(normalizeMonacoHex("#abc")).toBe("aabbcc");
		expect(normalizeMonacoHex("#F0A8")).toBe("FF00AA");
		expect(normalizeMonacoHex("#123456")).toBe("123456");
		expect(normalizeMonacoHex("123456")).toBe("123456");
		expect(normalizeMonacoHex("#123456cc")).toBe("123456");
		expect(normalizeMonacoHex("")).toBeUndefined();
		expect(normalizeMonacoHex(undefined)).toBeUndefined();
		expect(normalizeMonacoHex("#12")).toBeUndefined();
		expect(normalizeMonacoHex("#12345")).toBeUndefined();
		expect(normalizeMonacoHex("#1234567")).toBeUndefined();
		expect(normalizeMonacoHex("#zzzzzz")).toBeUndefined();
		expect(normalizeMonacoHex("red")).toBeUndefined();
		expect(normalizeMonacoHex("rgb(1, 2, 3)")).toBeUndefined();
	});

	test("sslCommentSpans follows canonical ssl.tmLanguage.json rules (ADR 0003)", async () => {
		const wasm = readFileSync(join(import.meta.dir, "../src/view/public/onig.wasm"));
		await oniguruma.loadWASM({ data: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
		const rawGrammar = JSON.parse(readFileSync(join(import.meta.dir, "../src/view/public/grammar/ssl.tmLanguage.json"), "utf8"));
		const reg = new Registry({
			onigLib: Promise.resolve({
				createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
				createOnigString: (text) => new oniguruma.OnigString(text),
			}),
			loadGrammar: async (scope) => (scope === "source.ssl" ? rawGrammar : null),
		});
		const sslGrammar = (await reg.loadGrammar("source.ssl"))!;

		const lines = [
			"/* comment */ still comment;", // 0: SSL comments end at `;`, NOT `*/`
			"// not an SSL comment", // 1: no `//` comments in SSL
			'sA := "trailing\\"; /* real comment;', // 2: no `\"` escapes in SSL -> `/* real comment;` IS a comment
			"sB := [/* inside bracket string;];", // 3: bracket string is NOT a comment
			'sC := "multiline start', // 4: multiline double-quoted string start
			"/* inside multiline string;", // 5: still inside string, NOT a comment
			'multiline end";', // 6: closes multiline string
		];

		const spans = sslCommentSpans(lines, sslGrammar)!;
		expect(spans[0]).toEqual([{ from: 0, to: lines[0]!.length }]);
		expect(spans[1]).toEqual([]);
		expect(spans[2]).toEqual([{ from: lines[2]!.indexOf("/*"), to: lines[2]!.length }]);
		expect(spans[3]).toEqual([]);
		expect(spans[4]).toEqual([]);
		expect(spans[5]).toEqual([]);
		expect(spans[6]).toEqual([]);
	});
});

describe("hoverSeverity.ts multi-line normalization, linked codes, and line scoping", () => {
	test("normalizes whitespace across multi-line diagnostics", () => {
		const markers = [
			{ message: "Procedure is too long.\nSplit into smaller helpers.", severity: 8, source: "starlims-lsp", code: "SSL010" },
		];
		expect(matchMarkerSeverity("Procedure is too long.\n  Split into   smaller helpers.", "starlims-lsp(SSL010)", markers)).toBe("error");
		expect(matchMarkerSeverity("Procedure is too long. Split into smaller helpers.", "starlims-lsp(SSL010)", markers)).toBe("error");
	});

	test("matches linked code objects rendered with or without parentheses", () => {
		const markers = [
			{ message: "Implicit global", severity: 4, source: "starlims-lsp", code: { value: "SSL002" } },
			{ message: "Implicit global", severity: 8, source: "starlims-lsp", code: { value: "SSL003" } },
		];
		expect(matchMarkerSeverity("Implicit global", "starlims-lsp(SSL002)", markers)).toBe("warning");
		expect(matchMarkerSeverity("Implicit global", "starlims-lspSSL002", markers)).toBe("warning");
		expect(matchMarkerSeverity("Implicit global", "starlims-lspSSL003", markers)).toBe("error");
		expect(matchMarkerSeverity("Implicit global", "starlims-lsp (SSL002)", markers)).toBe("warning");
	});

	test("scopes candidate markers to the hovered line before falling back to all markers", () => {
		const markers = [
			{ message: "Unused variable x", severity: 4, source: "starlims-lsp", code: "SSL020", startLineNumber: 5, endLineNumber: 5 },
			{ message: "Unused variable x", severity: 8, source: "starlims-lsp", code: "SSL020", startLineNumber: 20, endLineNumber: 20 },
		];
		expect(matchMarkerSeverity("Unused variable x", "starlims-lsp(SSL020)", markers, 5)).toBe("warning");
		expect(matchMarkerSeverity("Unused variable x", "starlims-lsp(SSL020)", markers, 20)).toBe("error");
		// Unknown/non-overlapping line falls back to all markers (max severity).
		expect(matchMarkerSeverity("Unused variable x", "starlims-lsp(SSL020)", markers, 99)).toBe("error");
	});

	test("observeMarkerHoverSeverity uses innerText for <br> lines and tracks hovered line via onMouseMove", () => {
		const prevMO = (globalThis as any).MutationObserver;
		let triggerMutation: (() => void) | null = null;
		(globalThis as any).MutationObserver = class {
			constructor(cb: () => void) {
				triggerMutation = cb;
			}
			observe() {}
			disconnect() {}
		};
		try {
			const model = makeFakeModel("a\nb\nc\nd\ne\n", "file:///ws/hover.ssl");
			mockMarkers.set(
				model.uri.toString(),
				new Map([
					[
						"starlims-lsp",
						[
							{ message: "Line 1\nLine 2", severity: 4, source: "starlims-lsp", code: { value: "SSL01" }, startLineNumber: 2, endLineNumber: 2 },
							{ message: "Line 1\nLine 2", severity: 8, source: "starlims-lsp", code: { value: "SSL01" }, startLineNumber: 5, endLineNumber: 5 },
						],
					],
				]),
			);
			const row: any = { dataset: {} };
			const markerEl: any = {
				closest: (sel: string) => (sel === ".hover-row" ? row : null),
				querySelectorAll: () => [
					// Simulates Monaco rendering `<br>` where textContent lacks newline but innerText has `\n`.
					{ innerText: "Line 1\nLine 2", textContent: "Line 1Line 2" },
					{ innerText: "starlims-lspSSL01", textContent: "starlims-lspSSL01" },
				],
			};
			const root: any = {
				querySelector: () => root,
				querySelectorAll: () => [markerEl],
			};
			let mouseMoveCb: ((e: any) => void) | null = null;
			const fakeEditor: any = {
				getModel: () => model,
				getDomNode: () => root,
				getPosition: () => ({ lineNumber: 5, column: 1 }),
				onMouseMove: (cb: (e: any) => void) => {
					mouseMoveCb = cb;
					return { dispose() {} };
				},
				onDidChangeModel: () => ({ dispose() {} }),
			};
			const stop = observeMarkerHoverSeverity(fakeEditor);
			// Initially uses cursor line 5 -> error.
			expect(row.dataset.severity).toBe("error");
			// Hovering line 2 updates severity to warning on next mutation.
			mouseMoveCb!({ target: { position: { lineNumber: 2, column: 1 } } });
			triggerMutation!();
			expect(row.dataset.severity).toBe("warning");
			stop();
			model.dispose();
		} finally {
			(globalThis as any).MutationObserver = prevMO;
		}
	});
});

describe("LspProcess stale-pipe isolation, spawn error, and failed state cleanup", () => {
	test("emits failed state on spawn failure and send() stays safe", () => {
		const states: { state: string; message?: string }[] = [];
		const proc = new LspProcess(
			join(rootTmp, "definitely-missing-starlims-lsp-bin"),
			() => {},
			(s) => states.push(s),
		);
		proc.start();
		expect(states.map((s) => s.state)).toEqual(["starting", "failed"]);
		expect(() => proc.send('{"jsonrpc":"2.0","method":"ping"}')).not.toThrow();
		proc.stop();
	});

	test("enters failed state after rapid crashes, clears dead proc, and does not throw on send()", async () => {
		const crashJs = join(rootTmp, "crash-lsp.js");
		writeFileSync(crashJs, `process.stderr.write("fatal boom\\n"); process.exit(1);\n`);
		const crashing = join(rootTmp, process.platform === "win32" ? "crash-lsp.cmd" : "crash-lsp.sh");
		if (process.platform === "win32") {
			writeFileSync(crashing, `@echo off\r\n"${process.execPath}" "${crashJs}" %*\r\n`);
		} else {
			writeFileSync(crashing, `#!/bin/sh\nexec "${process.execPath}" "${crashJs}" "$@"\n`);
			chmodSync(crashing, 0o755);
		}

		const states: { state: string; message?: string }[] = [];
		let resolveFailed!: () => void;
		const failed = new Promise<void>((r) => (resolveFailed = r));
		const proc = new LspProcess(
			crashing,
			() => {},
			(s) => {
				states.push(s);
				if (s.state === "failed") resolveFailed();
			},
		);
		try {
			proc.start();
			await Promise.race([failed, new Promise((_, rej) => setTimeout(() => rej(new Error("did not fail in time")), 4000))]);
			expect(states.at(-1)?.state).toBe("failed");
			expect(() => proc.send('{"jsonrpc":"2.0","method":"afterFail"}')).not.toThrow();
		} finally {
			proc.stop();
		}
	});

	test("drops stale stdout frames from a stopped or restarted subprocess", async () => {
		const markerFile = join(rootTmp, "run-count");
		writeFileSync(markerFile, "");
		const noisyJs = join(rootTmp, "stale-lsp.js");
		writeFileSync(
			noisyJs,
			`const fs = require("node:fs");
const marker = ${JSON.stringify(markerFile)};
fs.appendFileSync(marker, "x\\n");
const count = fs.readFileSync(marker, "utf8").split(/\\r?\\n/).filter(Boolean).length;
if (count === 1) {
  const emitOld = () => {
    process.stdout.write('Content-Length: 14\\r\\n\\r\\n{"gen":"old"}');
    process.exit(0);
  };
  process.on("SIGTERM", emitOld);
  process.stdin.resume();
  process.stdin.on("end", emitOld);
  process.stdout.write('Content-Length: 16\\r\\n\\r\\n{"gen":"first1"}');
  setTimeout(() => process.exit(0), 2500);
} else {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  process.stdout.write('Content-Length: 14\\r\\n\\r\\n{"gen":"new1"}');
  setTimeout(() => process.exit(0), 2500);
}
`,
		);
		const noisy = join(rootTmp, process.platform === "win32" ? "stale-lsp.cmd" : "stale-lsp.sh");
		if (process.platform === "win32") {
			writeFileSync(noisy, `@echo off\r\n"${process.execPath}" "${noisyJs}" %*\r\n`);
		} else {
			writeFileSync(noisy, `#!/bin/sh\nexec "${process.execPath}" "${noisyJs}" "$@"\n`);
			chmodSync(noisy, 0o755);
		}

		const received: string[] = [];
		let gotFirst!: () => void;
		let gotNew!: () => void;
		const pFirst = new Promise<void>((r) => (gotFirst = r));
		const pNew = new Promise<void>((r) => (gotNew = r));

		const proc = new LspProcess(
			noisy,
			(msg) => {
				received.push(msg);
				if (msg.includes("first1")) gotFirst();
				if (msg.includes("new1")) gotNew();
			},
			() => {},
		);
		try {
			proc.start();
			await Promise.race([pFirst, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out first1")), 3000))]);
			proc.restart();
			await Promise.race([pNew, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out new1")), 3000))]);
			await new Promise((r) => setTimeout(r, 80));
			expect(received).toContain('{"gen":"first1"}');
			expect(received).toContain('{"gen":"new1"}');
			expect(received.some((m) => m.includes('"old"'))).toBe(false);
		} finally {
			proc.stop();
		}
	});
});

describe("LspClient send rejection and server request JSON-RPC error responses", () => {
	test("request() rejects immediately and cleans up pending entry when send fails", async () => {
		let deliver!: (text: string) => void;
		const client = new LspClient({
			send: () => Promise.reject(new Error("pipe closed")),
			onMessage: (listener) => {
				deliver = listener;
			},
		});
		await expect(client.request("textDocument/hover", {})).rejects.toThrow("pipe closed");
		// Delivering a late response for id 1 must be a safe no-op.
		expect(() => deliver(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { contents: "late" } }))).not.toThrow();
	});

	test("server->client request handler throwing or rejecting returns JSON-RPC -32603 error response", async () => {
		const sent: any[] = [];
		let deliver!: (text: string) => void;
		const client = new LspClient({
			send: async (raw) => {
				sent.push(JSON.parse(raw));
			},
			onMessage: (listener) => {
				deliver = listener;
			},
		});

		client.onRequest("sync/boom", () => {
			throw new Error("sync failure");
		});
		client.onRequest("async/boom", async () => {
			throw new Error("async failure");
		});
		client.onRequest("ok/false", () => false);
		client.onRequest("ok/undef", () => undefined);

		deliver(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "sync/boom", params: {} }));
		deliver(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "async/boom", params: {} }));
		deliver(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "ok/false", params: {} }));
		deliver(JSON.stringify({ jsonrpc: "2.0", id: 13, method: "ok/undef", params: {} }));

		await new Promise((r) => setTimeout(r, 20));
		expect([...sent].sort((a, b) => a.id - b.id)).toEqual([
			{ jsonrpc: "2.0", id: 10, error: { code: -32603, message: "sync failure" } },
			{ jsonrpc: "2.0", id: 11, error: { code: -32603, message: "async failure" } },
			{ jsonrpc: "2.0", id: 12, result: false },
			{ jsonrpc: "2.0", id: 13, result: null },
		]);
	});
});

describe("session.ts toMinimalEdits, multi-owner diagnostics, and untrack owner cleanup", () => {
	test("toMinimalEdits handles pure EOF insertion, out-of-range clamping, and same-line multi-edits", () => {
		// Pure EOF insertion (trailing newline / extra line):
		const m1 = makeFakeModel("line1\nline2", "file:///ws/eof.ssl");
		const eofEdits = toMinimalEdits(m1, [
			{ range: { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } }, newText: "line1\nline2\nline3" },
		]);
		expect(m1.applyEdits(eofEdits)).toBe("line1\nline2\nline3");
		m1.dispose();

		// Multiple edits touching the same line do not expand into overlapping whole-line edits:
		const m2 = makeFakeModel("a:=1;b:=2;\n", "file:///ws/same-line.ssl");
		const multiEdits = toMinimalEdits(m2, [
			{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: " := " },
			{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 8 } }, newText: " := " },
		]);
		expect(multiEdits.length).toBe(2);
		expect(m2.applyEdits(multiEdits)).toBe("a := 1;b := 2;\n");
		m2.dispose();
	});

	test("publishFindings tracks diagnostics per owner without clobbering other owners", () => {
		const model = makeFakeModel("x;\n", "file:///ws/multi-owner.ssl");
		const uri = model.uri.toString();
		publishFindings(model, "ownerA", [{ line: 1, column: 1, endLine: 1, endColumn: 2, severity: 1, message: "A err" }]);
		publishFindings(model, "ownerB", [{ line: 1, column: 1, endLine: 1, endColumn: 2, severity: 2, message: "B warn" }]);
		flush();
		expect(diagnostics[uri]?.map((d) => d.message)).toEqual(["A err", "B warn"]);

		publishFindings(model, "ownerA", null);
		flush();
		expect(diagnostics[uri]?.map((d) => d.message)).toEqual(["B warn"]);

		publishFindings(model, "ownerB", null);
		flush();
		expect(diagnostics[uri]).toBeUndefined();
		model.dispose();
	});

	test("LspSession.untrack clears starlims-lsp markers and reset() clears LSP diagnostics", () => {
		const sess = new LspSession();
		const model = makeFakeModel("x;\n", "file:///ws/untrack.ssl");
		const uri = model.uri.toString();
		sess.track(model);
		// Simulate server diagnostics published under starlims-lsp owner.
		(sess as any).publish({
			uri,
			diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "Bad token" }],
		});
		flush();
		expect(mockMarkers.get(uri)?.get("starlims-lsp")?.length).toBe(1);
		expect(diagnostics[uri]?.length).toBe(1);

		sess.untrack(model);
		flush();
		expect(mockMarkers.get(uri)?.get("starlims-lsp")).toEqual([]);
		expect(diagnostics[uri]).toBeUndefined();

		// Publish again and verify reset() clears LSP diagnostics and markers.
		(sess as any).publish({
			uri,
			diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: "Warn" }],
		});
		flush();
		expect(diagnostics[uri]?.length).toBe(1);
		sess.reset();
		flush();
		expect(mockMarkers.get(uri)?.get("starlims-lsp")).toEqual([]);
		expect(diagnostics[uri]).toBeUndefined();
		model.dispose();
	});
});

describe("LspSession: where a document's comments and names are (starlims-lsp 0.32.0, ssl/lexicalTokens)", () => {
	const LEGEND_032 = { tokenTypes: ["function", "method", "parameter", "variable", "property", "class", "label"], tokenModifiers: ["declaration", "defaultLibrary", "readonly", "public", "unknown"] };
	const comment = { kind: "comment", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } } };

	/** A session over a server that is not there: what it sends is kept, and what it is answered is given. */
	async function fakeServer(ssl: Record<string, number>, answer: (method: string, params: any) => any) {
		const sess = new LspSession();
		const sent: { method: string; params: any }[] = [];
		(sess.client as any).notify = (method: string, params: any) => void sent.push({ method, params });
		(sess.client as any).request = async (method: string, params: any) => {
			sent.push({ method, params });
			if (method === "initialize") return { capabilities: { experimental: { ssl }, semanticTokensProvider: { legend: LEGEND_032 } } };
			return answer(method, params);
		};
		return { sess, sent };
	}
	/** A model whose text can be said to have changed, as an edit says it to the session. */
	function tracked(sess: InstanceType<typeof LspSession>, uri: string) {
		const model = makeFakeModel("/* a note;\nnA := 1;", uri);
		let changed: (event: any) => void = () => {};
		model.onDidChangeContent = (listener: (event: any) => void) => {
			changed = listener;
			return { dispose() {} };
		};
		sess.track(model);
		return { model, edit: () => changed({ changes: [{ range: new MockRange(2, 1, 2, 1), rangeLength: 0, text: " " }] }) };
	}

	test("the tokens of the text as it is, and nothing for a text that changed while it was asked", async () => {
		let onAsk = () => {};
		const { sess, sent } = await fakeServer({ lexicalTokens: 1 }, (method) => {
			if (method !== "ssl/lexicalTokens") return null;
			onAsk();
			return { uri: "file:///ws/lex-a.ssl", version: 1, tokens: [comment] };
		});
		const { model, edit } = tracked(sess, "file:///ws/lex-a.ssl");
		await sess.start("/ws");
		expect(await sess.lexicalTokens(model)).toEqual([comment]);
		expect(sent.at(-1)).toEqual({ method: "ssl/lexicalTokens", params: { textDocument: { uri: model.uri.toString() } } });

		// An edit goes to the server while the answer is on its way: the ranges are of the text before it.
		onAsk = edit;
		expect(await sess.lexicalTokens(model)).toBeNull();
		expect(sent.some((m) => m.method === "textDocument/didChange" && m.params.textDocument.version === 2)).toBe(true);
		model.dispose();
	});

	test("nothing, and no question, from a server without the request or for a document it does not hold", async () => {
		const older = await fakeServer({ syntaxTree: 1, callGraph: 1 }, () => ({ version: 1, tokens: [comment] }));
		const held = tracked(older.sess, "file:///ws/lex-b.ssl");
		await older.sess.start("/ws");
		expect(await older.sess.lexicalTokens(held.model)).toBeNull();
		expect(await older.sess.scratchLexical("/* a note;")).toBeNull();
		expect(older.sent.some((m) => m.method === "ssl/lexicalTokens")).toBe(false);
		held.model.dispose();

		const newer = await fakeServer({ lexicalTokens: 1 }, () => ({ version: 1, tokens: [comment] }));
		await newer.sess.start("/ws");
		const stray = makeFakeModel("/* a note;", "file:///ws/lex-c.ssl");
		expect(await newer.sess.lexicalTokens(stray)).toBeNull();
		expect(await newer.sess.nameTokens(stray)).toBeNull();
		expect(newer.sent.some((m) => m.method === "ssl/lexicalTokens" || m.method === "textDocument/semanticTokens/full")).toBe(false);
		stray.dispose();
	});

	test("the names come with the types and modifiers of the server's own legend", async () => {
		const { sess } = await fakeServer({ lexicalTokens: 1 }, (method) => (method === "textDocument/semanticTokens/full" ? { data: [1, 0, 2, 6, 1] } : null));
		const { model } = tracked(sess, "file:///ws/lex-d.ssl");
		await sess.start("/ws");
		// `label` is not coloured by every theme, and `translateTokens` drops what is not: this one keeps every name.
		expect(await sess.nameTokens(model)).toEqual([{ line: 1, character: 0, length: 2, type: "label", modifiers: ["declaration"] }]);
		model.dispose();
	});

	test("a text that is not open is asked about under a scratch name with the file's own ending, and closed again", async () => {
		const { sess, sent } = await fakeServer({ lexicalTokens: 1 }, (method) => (method === "ssl/lexicalTokens" ? { version: 1, tokens: [comment] } : null));
		await sess.start("/ws");
		expect(await sess.scratchLexical("/* a note;", "Orders.ds")).toEqual([comment]);
		await sess.scratchLexical("/* a note;", "Legacy.ssl.txt");
		await sess.scratchLexical("/* a note;", "Rules.srvscr");
		await sess.scratchLexical("/* a note;");
		const opened = sent.filter((m) => m.method === "textDocument/didOpen").map((m) => m.params.textDocument.uri as string);
		expect(opened.map((uri) => uri.replace(/^.*\/\.ssl-studio\/lexical-\d+/, ""))).toEqual([".ds", ".ssl.txt", ".srvscr", ".ssl"]);
		expect(opened.every((uri) => uri.includes("/ws/.ssl-studio/lexical-"))).toBe(true);
		expect(sent.filter((m) => m.method === "textDocument/didClose").map((m) => m.params.textDocument.uri)).toEqual(opened);
		// Each is asked about between its opening and its closing.
		expect(sent.filter((m) => !["initialize", "initialized"].includes(m.method)).map((m) => m.method).slice(0, 3)).toEqual(["textDocument/didOpen", "ssl/lexicalTokens", "textDocument/didClose"]);
	});
});

describe("The code editor's everyday editing: completion ranges, format on save, scripts not yet saved", () => {
	test("toSmallEdits makes the formatter's text and leaves alone the lines it did not change", async () => {
		const { toSmallEdits } = await import("../src/view/lsp/session");
		const before = [":PROCEDURE  foo ;", ":DECLARE x;", "x:=5 ;", ":RETURN x;", ":ENDPROC;", "", "y := 1;"];
		const after = [":PROCEDURE foo;", "\t:DECLARE x;", "", "\tx := 5;", "\t:RETURN x;", ":ENDPROC;"];
		for (const eol of ["\n", "\r\n"]) {
			const model = makeFakeModel(before.join(eol), `file:///ws/small-${eol.length}.ssl`, eol);
			// As the server sends a range formatting: one edit over the whole range, its lines ended with a bare LF.
			const edits = toSmallEdits(model, [{ range: { start: { line: 0, character: 0 }, end: { line: 4, character: 9 } }, newText: after.join("\n") }]);
			// The line typed last ("x:=5 ;", line 3) is changed within itself, before its semicolon: a cursor at its end stays.
			const onTyped = edits.filter((e) => e.range.endLineNumber === 3);
			expect(onTyped.length).toBeGreaterThan(0);
			expect(onTyped.every((e) => e.range.startLineNumber === 3 && e.range.endColumn <= 6)).toBe(true);
			// ":ENDPROC;" and what follows the range are the same: nothing reaches them.
			expect(edits.every((e) => e.range.endLineNumber < 5)).toBe(true);
			expect(edits.every((e) => !/(^|[^\r])\n/.test(e.text ?? "") || eol === "\n")).toBe(true);
			expect(model.applyEdits(edits)).toBe([...after, "", "y := 1;"].join(eol));
			model.dispose();
		}
	});

	test("toSmallEdits gives lines only added or only taken out as the one edit they are, and nothing for no change", async () => {
		const { toSmallEdits } = await import("../src/view/lsp/session");
		const whole = (text: string, newText: string, name: string) => {
			const model = makeFakeModel(text, `file:///ws/${name}.ssl`);
			const edits = toSmallEdits(model, [{ range: { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } }, newText }]);
			const out = model.applyEdits(edits);
			model.dispose();
			return { edits, out };
		};
		expect(whole("a;\nb;", "a;\n\nb;", "added").out).toBe("a;\n\nb;");
		expect(whole("a;\n\n\nb;", "a;\nb;", "taken").out).toBe("a;\nb;");
		expect(whole("a;\nb;", "a;\nb;", "same").edits).toEqual([]);
	});

	test("a completion with no range from the server replaces the punctuation typed before the word, and is still found by it", async () => {
		const { registerProviders, session: shared } = await import("../src/view/lsp/session");
		const { monaco } = await import("../src/view/editor/monaco");
		let provider: any;
		const languages = monaco.languages as any;
		const registered = languages.registerCompletionItemProvider;
		languages.registerCompletionItemProvider = (_language: string, given: any) => ((provider = given), { dispose() {} });
		registerProviders();
		languages.registerCompletionItemProvider = registered;

		const items = [
			{ label: ":WHILE", kind: 14, insertText: ":WHILE", insertTextFormat: 1 },
			{ label: "while", kind: 15, insertText: ":WHILE ${1:condition};\n\t${0}\n:ENDWHILE;", insertTextFormat: 2 },
			{ label: "WhileAway", kind: 3, insertText: "WhileAway", insertTextFormat: 1 },
			{ label: ".T.", kind: 21, insertText: ".T.", insertTextFormat: 1 },
			{ label: ":WITH", kind: 14, textEdit: { newText: ":WITH", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } } },
		];
		const request = shared.request;
		const asked: any[] = [];
		(shared as any).request = async (_method: string, params: any) => (asked.push(params), { items });
		try {
			const ask = async (line: string, context?: { triggerKind: number; triggerCharacter?: string }) => {
				const model = makeFakeModel(line, "file:///ws/complete.ssl");
				const start = line.length - (/[A-Za-z0-9_]*$/.exec(line)?.[0].length ?? 0);
				model.getLineContent = () => line;
				model.getWordUntilPosition = () => ({ word: line.slice(start), startColumn: start + 1, endColumn: line.length + 1 });
				const result = await provider.provideCompletionItems(model, { lineNumber: 1, column: line.length + 1 }, context);
				model.dispose();
				return Object.fromEntries(result.suggestions.map((s: any) => [s.label, s])) as Record<string, any>;
			};
			const cols = (s: any) => [s.range.startColumn, s.range.endColumn];

			// ":wh": the keyword takes the colon with it; so does the snippet, which is found by ":wh" for it.
			const afterColon = await ask(":wh");
			expect(cols(afterColon[":WHILE"])).toEqual([1, 4]);
			expect(afterColon[":WHILE"].filterText).toBeUndefined();
			expect(cols(afterColon.while)).toEqual([1, 4]);
			expect(afterColon.while.filterText).toBe(":while");
			// A name that opens with no punctuation replaces the word alone, as before.
			expect(cols(afterColon.WhileAway)).toEqual([2, 4]);
			expect(cols(afterColon[".T."])).toEqual([2, 4]);
			// A range the server names is the server's.
			expect(cols(afterColon[":WITH"])).toEqual([1, 4]);

			// "wh" with no colon typed: nothing before the word to take.
			const bare = await ask("\twh");
			expect(cols(bare[":WHILE"])).toEqual([2, 4]);
			expect(cols(bare.while)).toEqual([2, 4]);
			expect(bare.while.filterText).toBeUndefined();

			// A colon alone, and a dot before a word.
			expect(cols((await ask("x := 1;:"))[":WHILE"])).toEqual([8, 9]);
			const afterDot = await ask("b := .t");
			expect(cols(afterDot[".T."])).toEqual([6, 8]);
			expect(cols(afterDot[":WHILE"])).toEqual([7, 8]);

			// The server is told what set the list off, in the protocol's numbers (the editor's plus one): it
			// answers a typed ":" with members or keywords, and with nothing said it gave everything it knows.
			asked.length = 0;
			await ask("oMail:", { triggerKind: 1, triggerCharacter: ":" });
			await ask("wh", { triggerKind: 0 });
			await ask("wh", { triggerKind: 2 });
			await ask("wh");
			expect(asked.map((params) => params.context)).toEqual([{ triggerKind: 2, triggerCharacter: ":" }, { triggerKind: 1 }, { triggerKind: 3 }, { triggerKind: 1 }]);
			expect(asked[0].position).toEqual({ line: 0, character: 6 });
		} finally {
			(shared as any).request = request;
		}
	});

	test("a script not yet saved is the server's to read; a model that is no document of the user's is not", async () => {
		const sess = new LspSession();
		const sent: { method: string; params: any }[] = [];
		let hello: any;
		(sess.client as any).notify = (method: string, params: any) => void sent.push({ method, params });
		(sess.client as any).request = async (method: string, params: any) => (method === "initialize" ? ((hello = params), { capabilities: {} }) : null);
		const untitled = makeFakeModel(":DECLARE x;", "untitled:Untitled-1");
		const preview = makeFakeModel(":DECLARE y;", "inmemory://model/1");
		sess.track(untitled);
		sess.track(preview);
		await sess.start("/ws");
		const opened = sent.filter((m) => m.method === "textDocument/didOpen").map((m) => m.params.textDocument.uri);
		expect(opened).toEqual([untitled.uri.toString()]);
		expect(untitled.uri.toString()).toBe("untitled:Untitled-1");
		// The server is told at the start that each completion request says what set it off.
		expect(hello.capabilities.textDocument.completion.contextSupport).toBe(true);
		sess.untrack(untitled);
		expect(sent.at(-1)).toEqual({ method: "textDocument/didClose", params: { textDocument: { uri: "untitled:Untitled-1" } } });
		untitled.dispose();
		preview.dispose();
	});
});

describe("The code editor's keys are Sublime Text's for editing (ADR 0034)", () => {
	type Rule = { keybinding: number; command: string; when?: string };
	const CODES = { KeyD: 34, KeyG: 37, KeyJ: 40, KeyK: 41, KeyL: 42, KeyM: 43, KeyU: 51, UpArrow: 16, DownArrow: 18, Delete: 20, Backspace: 1, Digit0: 21, F3: 61, F5: 63, F9: 67, Slash: 90 };
	const CTRL = 2048;
	const SHIFT = 1024;
	const ALT = 512;
	const WIN = 256;
	const chord = (first: number, second: number) => (first | ((second & 0xffff) << 16)) >>> 0;

	/** The rules `setEditorKeys` gives the editor, on a system named as the browser names it. */
	async function rulesOn(platform: string): Promise<Rule[]> {
		const { monaco, setEditorKeys } = await import("../src/view/editor/monaco");
		Object.assign(monaco.KeyMod as any, { CtrlCmd: CTRL, Shift: SHIFT, Alt: ALT, WinCtrl: WIN, chord });
		Object.assign(monaco.KeyCode as any, CODES);
		const editorApi = monaco.editor as any;
		const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		let given: Rule[] = [];
		editorApi.addKeybindingRules = (rules: Rule[]) => ((given = rules), { dispose() {} });
		Object.defineProperty(globalThis, "navigator", { value: { platform }, configurable: true });
		try {
			setEditorKeys();
		} finally {
			if (real) Object.defineProperty(globalThis, "navigator", real);
			delete editorApi.addKeybindingRules;
		}
		return given;
	}
	const bound = (rules: Rule[], key: number) => rules.filter((r) => r.keybinding === key && !r.command.startsWith("-")).map((r) => r.command);
	const freed = (rules: Rule[], key: number) => rules.filter((r) => r.keybinding === key && r.command.startsWith("-")).map((r) => r.command.slice(1));

	test("on Windows and Linux: each of Sublime Text's keys runs its command, and the command the key had is let go", async () => {
		const rules = await rulesOn("Linux x86_64");
		expect(bound(rules, CTRL | SHIFT | CODES.KeyD)).toEqual(["editor.action.duplicateSelection"]);
		expect(bound(rules, CTRL | CODES.KeyJ)).toEqual(["editor.action.joinLines"]);
		expect(bound(rules, CTRL | SHIFT | CODES.UpArrow)).toEqual(["editor.action.moveLinesUpAction"]);
		expect(freed(rules, CTRL | SHIFT | CODES.UpArrow)).toEqual(["editor.action.insertCursorAbove"]);
		expect(bound(rules, CTRL | SHIFT | CODES.DownArrow)).toEqual(["editor.action.moveLinesDownAction"]);
		expect(bound(rules, CODES.F9)).toEqual(["editor.action.sortLinesAscending"]);
		expect(bound(rules, CTRL | SHIFT | CODES.Backspace)).toEqual(["deleteAllLeft"]);
		expect(bound(rules, CTRL | SHIFT | CODES.Delete)).toEqual(["deleteAllRight"]);
		expect(bound(rules, chord(CTRL | CODES.KeyK, CTRL | CODES.KeyK))).toEqual(["deleteAllRight"]);
		expect(bound(rules, chord(CTRL | CODES.KeyK, CTRL | CODES.KeyU))).toEqual(["editor.action.transformToUppercase"]);
		expect(freed(rules, chord(CTRL | CODES.KeyK, CTRL | CODES.KeyU))).toEqual(["editor.action.removeCommentLine"]);
		expect(bound(rules, chord(CTRL | CODES.KeyK, CTRL | CODES.KeyL))).toEqual(["editor.action.transformToLowercase"]);
		expect(freed(rules, chord(CTRL | CODES.KeyK, CTRL | CODES.KeyL))).toEqual(["editor.toggleFold"]);
		expect(bound(rules, CTRL | SHIFT | CODES.KeyL)).toEqual(["editor.action.insertCursorAtEndOfEachLineSelected"]);
		expect(freed(rules, CTRL | SHIFT | CODES.KeyL)).toEqual(["editor.action.selectHighlights"]);
		expect(bound(rules, ALT | CODES.F3)).toEqual(["editor.action.selectHighlights"]);
		expect(bound(rules, chord(CTRL | CODES.KeyK, CTRL | CODES.Digit0))).toEqual(["editor.unfoldAll"]);
		expect(freed(rules, chord(CTRL | CODES.KeyK, CTRL | CODES.Digit0))).toEqual(["editor.foldAll"]);
		expect(bound(rules, CTRL | SHIFT | CODES.Slash)).toEqual(["editor.action.blockComment"]);
		// The bracket keys: Ctrl+M no longer turns Tab off.
		expect(bound(rules, CTRL | CODES.KeyM)).toEqual(["editor.action.jumpToBracket"]);
		expect(freed(rules, CTRL | CODES.KeyM)).toEqual(["editor.action.toggleTabFocusMode"]);
		expect(bound(rules, CTRL | SHIFT | CODES.KeyM)).toEqual(["editor.action.selectToBracket"]);
	});

	test("every key runs one command, in the editor's text only, and a command that changes text not where text may not be changed", async () => {
		for (const platform of ["Win32", "MacIntel"]) {
			const rules = await rulesOn(platform);
			const adds = rules.filter((r) => !r.command.startsWith("-"));
			expect(adds.length).toBeGreaterThan(12);
			expect(new Set(adds.map((r) => r.keybinding)).size).toBe(adds.length);
			for (const rule of adds) expect(rule.when?.startsWith("editorTextFocus")).toBe(true);
			const changes = adds.filter((r) => /duplicate|joinLines|moveLines|sortLines|deleteAll|transformTo|blockComment/.test(r.command));
			expect(changes.length).toBeGreaterThan(8);
			for (const rule of changes) expect(rule.when).toBe("editorTextFocus && !editorReadonly");
			// A command is let go from a key before the key is given: the order the editor reads them in.
			for (const rule of rules.filter((r) => r.command.startsWith("-"))) {
				const at = rules.indexOf(rule);
				expect(rules.findIndex((r) => r.keybinding === rule.keybinding && !r.command.startsWith("-"))).toBeGreaterThan(at);
			}
		}
	});

	test("on a Mac the keys are Sublime Text's for a Mac", async () => {
		const rules = await rulesOn("MacIntel");
		// Cmd (the editor's CtrlCmd) where the others have Ctrl.
		expect(bound(rules, CTRL | SHIFT | CODES.KeyD)).toEqual(["editor.action.duplicateSelection"]);
		// A line is moved with Ctrl+Cmd and an arrow: Cmd+Shift with one selects to the start or end of the file.
		expect(bound(rules, WIN | CTRL | CODES.UpArrow)).toEqual(["editor.action.moveLinesUpAction"]);
		expect(bound(rules, CTRL | SHIFT | CODES.UpArrow)).toEqual([]);
		expect(bound(rules, CODES.F5)).toEqual(["editor.action.sortLinesAscending"]);
		expect(bound(rules, CODES.F9)).toEqual([]);
		expect(bound(rules, WIN | CTRL | CODES.KeyG)).toEqual(["editor.action.selectHighlights"]);
		// The editor has its own keys there for deleting to either end of the line.
		expect(bound(rules, CTRL | SHIFT | CODES.Backspace)).toEqual([]);
		// The bracket keys are on Ctrl itself, and "Tab moves focus" is let go of the one it was on there.
		expect(bound(rules, WIN | CODES.KeyM)).toEqual(["editor.action.jumpToBracket"]);
		expect(freed(rules, WIN | CODES.KeyM)).toEqual([]);
		expect(bound(rules, WIN | SHIFT | CODES.KeyM)).toEqual(["editor.action.selectToBracket"]);
		expect(freed(rules, WIN | SHIFT | CODES.KeyM)).toEqual(["editor.action.toggleTabFocusMode"]);
	});
});

describe("Format on save takes the changed lines from a format of the whole document (formatRangesAsDocument)", () => {
	const OLD = [":PROCEDURE one;", "x:=sqlexecute(a) ;", ":RETURN x;", ":ENDPROC;", ":PROCEDURE two;", "y:=1 ;", ":ENDPROC;"];
	const NEW = [":PROCEDURE one;", "\tx := SQLExecute(a);", "", "\t:RETURN x;", ":ENDPROC;", "", ":PROCEDURE two;", "\ty := 1;", ":ENDPROC;"];

	/** A session whose server formats any document to `formatted`, as one edit over the whole of it. */
	async function sessionThatFormats(formatted: string[] | null) {
		const sess = new LspSession();
		const asked: { method: string; params: any }[] = [];
		(sess.client as any).notify = () => {};
		(sess.client as any).request = async (method: string, params: any) => {
			asked.push({ method, params });
			if (method === "initialize") return { capabilities: {} };
			if (method !== "textDocument/formatting" || !formatted) return null;
			return [{ range: { start: { line: 0, character: 0 }, end: { line: 9999, character: 0 } }, newText: formatted.join("\n") }];
		};
		await sess.start("/ws");
		return { sess, asked };
	}
	const modelOf = (lines: string[], name: string, eol = "\n") => {
		const model = makeFakeModel(lines.join(eol), `file:///ws/${name}.ssl`, eol);
		model.getLinesContent = () => model.getValue().split(eol);
		return model;
	};
	const OPTIONS = { tabSize: 4, insertSpaces: false } as any;

	test("the lines asked for become the formatter's; the rest of the document is not touched", async () => {
		for (const eol of ["\n", "\r\n"]) {
			const { sess, asked } = await sessionThatFormats(NEW);
			const model = modelOf(OLD, `whole-${eol.length}`, eol);
			const edits = (await sess.formatRangesAsDocument(model, [[0, 3]], OPTIONS))!;
			// The document itself is formatted, not a range of it.
			expect(asked.at(-1)!.method).toBe("textDocument/formatting");
			expect(asked.at(-1)!.params.textDocument.uri).toBe(model.uri.toString());
			// Nothing reaches the second procedure, and a line that is kept is changed within itself.
			expect(edits.every((e) => e.range.endLineNumber <= 5)).toBe(true);
			expect(edits.length).toBeGreaterThan(1);
			expect(model.applyEdits(edits)).toBe([":PROCEDURE one;", "\tx := SQLExecute(a);", "", "\t:RETURN x;", ":ENDPROC;", "", ":PROCEDURE two;", "y:=1 ;", ":ENDPROC;"].join(eol));
			model.dispose();
		}
	});

	test("a document the formatter leaves alone, or does not answer for, gives no edits", async () => {
		const same = await sessionThatFormats(OLD);
		const model = modelOf(OLD, "same");
		expect(await same.sess.formatRangesAsDocument(model, [[0, 6]], OPTIONS)).toEqual([]);
		const silent = await sessionThatFormats(null);
		expect(await silent.sess.formatRangesAsDocument(model, [[0, 6]], OPTIONS)).toEqual([]);
		model.dispose();
	});

	test("lines the formatter has none of any more go with their line break, wherever they stand", async () => {
		// Blank lines beyond the one the formatter keeps, in the middle of the text and at its end.
		const middle = modelOf(["a := 1;", "", "", "b := 2;"], "gone-middle");
		const { sess } = await sessionThatFormats(["a := 1;", "", "b := 2;"]);
		expect(middle.applyEdits((await sess.formatRangesAsDocument(middle, [[1, 2]], OPTIONS))!)).toBe("a := 1;\n\nb := 2;");
		middle.dispose();
		const end = modelOf(["a := 1;", "", ""], "gone-end");
		const trimmed = await sessionThatFormats(["a := 1;"]);
		expect(end.applyEdits((await trimmed.sess.formatRangesAsDocument(end, [[1, 2]], OPTIONS))!)).toBe("a := 1;");
		end.dispose();
	});
});
