import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as oniguruma from "vscode-oniguruma";
import { Registry } from "vscode-textmate";
import type { DocFile } from "../src/shared/protocol";
import { cut, isAllowedWorkAttachment, workFor, workLabel, workText } from "../src/shared/workContext";
import {
	applySimpleUnifiedDiff,
	createContextAccumulator,
	decideModel,
	extractFencedBlocks,
	MINE,
	USE_IT,
} from "../src/view/agent/logic";

// Minimal browser & Monaco shims (matching test/r2aLspAndMonaco.test.ts) so view modules load cleanly under Bun.
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
		querySelector: () => null,
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
		if (raw.startsWith("file://")) return new MockUri("file", decodeURI(raw.slice("file://".length)));
		const idx = raw.indexOf(":");
		return idx >= 0 ? new MockUri(raw.slice(0, idx), raw.slice(idx + 1)) : new MockUri("file", raw);
	}
	static from(parts: { scheme: string; path?: string }) {
		return new MockUri(parts.scheme, parts.path ?? "/");
	}
}

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
		CompletionItemKind: { Text: 0, Method: 1, Function: 2 },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
		FoldingRangeKind: { Comment: { value: "comment" }, Imports: { value: "imports" }, Region: { value: "region" } },
		SymbolKind: { Namespace: 2, Class: 4, Method: 5, Function: 11 },
	}),
	editor: noopProxy({
		getEditors: () => [],
		ScrollType: { Immediate: 1 },
		getModels: () => [],
		getModel: () => null,
		setModelMarkers: () => {},
		getModelMarkers: () => [],
	}),
}));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({ default: class {} }));

const { REPLY_PURIFY_CONFIG, rewriteFileLinksBeforeParse } = await import("../src/view/agent/markdown");
const { evaluateTidyChecks, fenced, isExplicitUnchanged, notePath, pickPrimarySslBlock } = await import("../src/view/agent/tidy");
const { MAX_SAVED_ENTRY_CHARS, trimThreadsForStorage, writeSavedThreads } = await import("../src/view/agent/store");
const { codeOnly } = await import("../src/view/editor/textmate");

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

describe("R6B — decideModel fail-closed paid-model confirmation", () => {
	const models = [
		{ providerID: "ollama", id: "qwen3:14b", name: "Qwen 3 14B", local: true },
		{ providerID: "openrouter", id: "paid-model", name: "Paid Model", local: false },
	];

	test("only empty/whitespace ref short-circuits without asking", async () => {
		let prompts = 0;
		const choose = async () => (prompts++, USE_IT);
		expect(await decideModel("", [], choose)).toEqual({ model: "", own: false });
		expect(await decideModel("   \t\n ", [], choose)).toEqual({ model: "", own: false });
		expect(prompts).toBe(0);
	});

	test("normalizes case and whitespace for known local and paid models", async () => {
		let prompts = 0;
		const localRes = await decideModel("  OLLAMA/QWEN3:14B  ", models, async () => (prompts++, null));
		expect(localRes).toEqual({ model: "ollama/qwen3:14b", own: false });
		expect(prompts).toBe(0);

		const asked: string[] = [];
		const paidDeclined = await decideModel("  OPENROUTER/PAID-MODEL ", models, async (title) => (asked.push(title), null));
		expect(paidDeclined).toBeNull();
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/not a local model and may cost money/);

		expect(await decideModel("  OpenRouter/Paid-Model ", models, async () => USE_IT)).toEqual({
			model: "openrouter/paid-model",
			own: false,
		});
		expect(await decideModel("OPENROUTER/PAID-MODEL", models, async () => MINE)).toEqual({
			model: "openrouter/paid-model",
			own: true,
		});
	});

	test("fails closed and prompts for unlisted models and before models list populates", async () => {
		const asked: string[] = [];
		expect(await decideModel("openai/gpt-5", models, async (t) => (asked.push(t), null))).toBeNull();
		expect(await decideModel("ollama/qwen3:14b", [], async (t) => (asked.push(t), null))).toBeNull();
		expect(asked).toHaveLength(2);
		expect(asked[0]).toMatch(/may cost money/);
		expect(asked[1]).toMatch(/may cost money/);

		expect(await decideModel("  openai/gpt-5  ", [], async () => USE_IT)).toEqual({
			model: "openai/gpt-5",
			own: false,
		});
		expect(await decideModel("custom/local-srv", [], async () => MINE)).toEqual({
			model: "custom/local-srv",
			own: true,
		});
	});
});

describe("R6B — markdown.ts exfiltration/spoofing hardening & inline backtick fence", () => {
	test("REPLY_PURIFY_CONFIG forbids zero-click exfiltration attributes, data-* attrs, and spoofing tags", () => {
		for (const tag of ["canvas", "dialog", "area", "track", "img", "iframe", "style", "svg", "math", "form", "input", "button"]) {
			expect(REPLY_PURIFY_CONFIG.FORBID_TAGS).toContain(tag);
		}
		for (const attr of [
			"style",
			"background",
			"poster",
			"src",
			"srcset",
			"ping",
			"action",
			"formaction",
			"popover",
			"popovertarget",
			"command",
			"commandfor",
		]) {
			expect(REPLY_PURIFY_CONFIG.FORBID_ATTR).toContain(attr);
		}
		expect(REPLY_PURIFY_CONFIG.ALLOW_DATA_ATTR).toBe(false);

		// Simulate DOMPurify tag/attribute policy enforcement over exfiltration & spoofing HTML payloads.
		const forbidTags = new Set(REPLY_PURIFY_CONFIG.FORBID_TAGS.map((t) => t.toLowerCase()));
		const forbidAttrs = new Set(REPLY_PURIFY_CONFIG.FORBID_ATTR.map((a) => a.toLowerCase()));
		const stripByPolicy = (html: string) =>
			html
				.replace(/<([a-z][a-z0-9-]*)\b[^>]*>[\s\S]*?<\/\1>|<([a-z][a-z0-9-]*)\b[^>]*\/?>/gi, (full, paired, single) => {
					const tag = (paired || single || "").toLowerCase();
					if (forbidTags.has(tag)) return "";
					return full.replace(/\s+([a-z][a-z0-9:-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, (attrFull, name: string) => {
						const low = name.toLowerCase();
						if (forbidAttrs.has(low)) return "";
						if (!REPLY_PURIFY_CONFIG.ALLOW_DATA_ATTR && low.startsWith("data-")) return "";
						return attrFull;
					});
				});

		const evil = [
			'<div style="background-image:url(https://evil.example/leak)">hello</div>',
			'<table background="https://evil.example/bg"><tr><td>cell</td></tr></table>',
			'<a href="https://ok.example" ping="https://evil.example/p" data-ticket="FAKE-1" data-tag="spoof">ok</a>',
			'<dialog open>Fake Auth Prompt</dialog><canvas id="c"></canvas><area href="x"><track src="x">',
			'<div popover popovertarget="p" command="show" commandfor="p">ok</div>',
		].join("");
		const cleaned = stripByPolicy(evil);
		expect(cleaned).not.toContain("background-image");
		expect(cleaned).not.toContain("background=");
		expect(cleaned).not.toContain("data-ticket");
		expect(cleaned).not.toContain("data-tag");
		expect(cleaned).not.toContain("<dialog");
		expect(cleaned).not.toContain("<canvas");
		expect(cleaned).not.toContain("<area");
		expect(cleaned).not.toContain("<track");
		expect(cleaned).not.toContain("popover");
		expect(cleaned).not.toContain("command=");
		expect(cleaned).not.toContain("ping=");
		expect(cleaned).toContain("hello");
		expect(cleaned).toContain("cell");
	});

	test("rewriteFileLinksBeforeParse ignores inline ```foo.ssl``` spans so linkification stays active", () => {
		const input = [
			"```foo.ssl``` and check `bar.ssl`",
			"Then inspect `src/DueDates/SetDueDates.ssl:42` and [Other.ssl:12](Other.ssl:12).",
			"```ssl",
			"`inside_fence.ssl` must not be linkified",
			"```",
			"Back in prose: `after.ssl`.",
		].join("\n");

		const out = rewriteFileLinksBeforeParse(input);
		const lines = out.split("\n");
		// Inline triple-backtick span stays intact and does NOT open a phantom fence.
		expect(lines[0]).toContain("```foo.ssl```");
		expect(lines[0]).toContain("[`bar.ssl`](file-ref://bar.ssl)");
		expect(lines[1]).toContain("[`src/DueDates/SetDueDates.ssl:42`](file-ref://src%2FDueDates%2FSetDueDates.ssl%3A42)");
		expect(lines[1]).toContain("[Other.ssl:12](file-ref://Other.ssl%3A12)");
		// Real fenced block still suppresses linkification.
		expect(lines[3]).toBe("`inside_fence.ssl` must not be linkified");
		// Linkification resumes after the real closing fence.
		expect(lines[5]).toContain("[`after.ssl`](file-ref://after.ssl)");
	});
});

describe("R6B — extractFencedBlocks & applySimpleUnifiedDiff safety", () => {
	test("extractFencedBlocks preserves line-1 indentation and trailing spaces in diff hunks", () => {
		const reply = [
			"Here is an indented snippet:",
			"```ssl",
			"    :LOCAL nDue := 1;",
			"    :RETURN nDue;",
			"```",
			"And a diff with a trailing blank context line:",
			"```diff",
			"@@ -1,3 +1,3 @@",
			" line1",
			"-old",
			"+new",
			" ",
			"```",
		].join("\n");

		const blocks = extractFencedBlocks(reply);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toEqual({
			lang: "ssl",
			code: "    :LOCAL nDue := 1;\n    :RETURN nDue;",
		});
		expect(blocks[1]).toEqual({
			lang: "diff",
			code: "@@ -1,3 +1,3 @@\n line1\n-old\n+new\n ",
		});
	});

	test("applySimpleUnifiedDiff rejects multi-file diffs and never merges FileB headers into hunk 1", () => {
		const orig = "keep\noldA\n";
		const multiFile = [
			"--- a/src/FileA.ssl",
			"+++ b/src/FileA.ssl",
			"@@ -1,2 +1,2 @@",
			" keep",
			"-oldA",
			"+newA",
			"--- a/src/FileB.ssl",
			"+++ b/src/FileB.ssl",
			"@@ -1,2 +1,2 @@",
			" keepB",
			"-oldB",
			"+newB",
		].join("\n");
		expect(applySimpleUnifiedDiff(orig, multiFile, "/ws/src/FileA.ssl")).toBeNull();

		// Even with broken hunk counts trying to swallow FileB headers inside hunk 1, reject cleanly.
		const swallowedMultiFile = [
			"--- a/src/FileA.ssl",
			"+++ b/src/FileA.ssl",
			"@@ -1,4 +1,4 @@",
			" keep",
			"-oldA",
			"+newA",
			"--- a/src/FileB.ssl",
			"+++ b/src/FileB.ssl",
		].join("\n");
		expect(applySimpleUnifiedDiff(orig, swallowedMultiFile, "/ws/src/FileA.ssl")).toBeNull();
	});

	test("applySimpleUnifiedDiff validates +++ target headers against targetPath and blocks traversal", () => {
		const orig = "alpha\nbeta\n";
		const goodDiff = ["--- a/src/DueDates/SetDueDates.ssl", "+++ b/src/DueDates/SetDueDates.ssl", "@@ -1,2 +1,2 @@", " alpha", "-beta", "+BETA"].join("\n");
		expect(applySimpleUnifiedDiff(orig, goodDiff, "/ws/src/DueDates/SetDueDates.ssl")).toBe("alpha\nBETA\n");

		const wrongFileDiff = ["--- a/src/Other.ssl", "+++ b/src/Other.ssl", "@@ -1,2 +1,2 @@", " alpha", "-beta", "+BETA"].join("\n");
		expect(applySimpleUnifiedDiff(orig, wrongFileDiff, "/ws/src/DueDates/SetDueDates.ssl")).toBeNull();

		const wrongFolderDiff = ["--- a/evil/SetDueDates.ssl", "+++ b/evil/SetDueDates.ssl", "@@ -1,2 +1,2 @@", " alpha", "-beta", "+BETA"].join("\n");
		expect(applySimpleUnifiedDiff(orig, wrongFolderDiff, "/ws/src/DueDates/SetDueDates.ssl")).toBeNull();

		const traversalDiff = ["--- a/../../etc/passwd", "+++ b/../../etc/passwd", "@@ -1,2 +1,2 @@", " alpha", "-beta", "+BETA"].join("\n");
		expect(applySimpleUnifiedDiff(orig, traversalDiff, "/ws/src/DueDates/SetDueDates.ssl")).toBeNull();
		expect(applySimpleUnifiedDiff(orig, traversalDiff)).toBeNull();
	});

	test("applySimpleUnifiedDiff enforces hunk counts, fixes pure-insertion offsets, and requires empty original for @@ -0,0", () => {
		// Pure insertion after line 1: @@ -1,0 +2,2 @@ must insert AFTER line 1, not before it.
		const orig = "line1\nline2\nline3\n";
		const insertAfter1 = ["@@ -1,0 +2,2 @@", "+insA", "+insB"].join("\n");
		expect(applySimpleUnifiedDiff(orig, insertAfter1)).toBe("line1\ninsA\ninsB\nline2\nline3\n");

		// Pure insertion at EOF after line 3.
		const insertAtEnd = ["@@ -3,0 +4,1 @@", "+tail"].join("\n");
		expect(applySimpleUnifiedDiff(orig, insertAtEnd)).toBe("line1\nline2\nline3\ntail\n");

		// @@ -0,0 succeeds ONLY on empty original and rejects non-empty original.
		const newFileDiff = ["--- /dev/null", "+++ b/src/New.ssl", "@@ -0,0 +1,2 @@", "+:PROCEDURE Main;", "+:ENDPROC;"].join("\n");
		expect(applySimpleUnifiedDiff("", newFileDiff, "/ws/src/New.ssl")).toBe(":PROCEDURE Main;\n:ENDPROC;");
		expect(applySimpleUnifiedDiff("existing\n", newFileDiff, "/ws/src/New.ssl")).toBeNull();

		// Declared hunk count mismatch must be rejected.
		const badCount = ["@@ -1,3 +1,3 @@", " line1", "-line2", "+LINE2"].join("\n");
		expect(applySimpleUnifiedDiff(orig, badCount)).toBeNull();
	});

	test("applySimpleUnifiedDiff preserves CRLF and LF line endings and trailing-newline state", () => {
		const crlfOrig = "first\r\nsecond\r\nthird\r\n";
		const patch = ["@@ -1,3 +1,3 @@", " first", "-second", "+SECOND", " third"].join("\n");
		expect(applySimpleUnifiedDiff(crlfOrig, patch)).toBe("first\r\nSECOND\r\nthird\r\n");

		const crlfNoTrail = "first\r\nsecond";
		const patch2 = ["@@ -1,2 +1,2 @@", " first", "-second", "+SECOND"].join("\n");
		expect(applySimpleUnifiedDiff(crlfNoTrail, patch2)).toBe("first\r\nSECOND");
	});
});

describe("R6B — cut() open-fence closure & incremental context budgeting", () => {
	test("cut() closes an unclosed backtick or tilde fence so THE QUESTION: is never swallowed", () => {
		const fencedSsl = "STAGED GIT DIFF:\n```diff\n+line one\n+line two\n+line three\n+line four\n```";
		const clipped = cut(fencedSsl, 40);
		expect(clipped.endsWith("\n```")).toBe(true);
		// Fence count is now even (opened once, closed once).
		expect(clipped.match(/^```/gm)?.length).toBe(2);

		const tildeFence = "DOC:\n~~~~markdown\n# Heading\nBody text that keeps going on and on\n~~~~";
		const clippedTilde = cut(tildeFence, 32);
		expect(clippedTilde.endsWith("\n~~~~")).toBe(true);

		// Already-closed fence or inline triple-backtick span must NOT get an extra closing fence.
		const closedThenProse = "```ssl\n:RETURN 1;\n```\n" + "prose ".repeat(40);
		const clippedClosed = cut(closedThenProse, 50);
		expect(clippedClosed.endsWith("\n```")).toBe(false);

		const inlineSpan = "See ```foo.ssl``` and " + "details ".repeat(40);
		const clippedInline = cut(inlineSpan, 45);
		expect(clippedInline.endsWith("\n```")).toBe(false);
	});

	test("createContextAccumulator enforces budget incrementally and never marks skipped slices as sent", () => {
		const already = new Map<string, string>();
		const acc = createContextAccumulator(already, 100, cut);
		expect(acc.addSlice("ticket:1", "DEMO-1", "A".repeat(70))).toBe(true);
		// Does not fit remaining 28 chars: must be skipped and NOT recorded in slices/labels.
		expect(acc.addSlice("file:big", "Big.ssl", "B".repeat(50))).toBe(false);
		// Smaller slice fits remaining 28 chars.
		expect(acc.addSlice("state", "STATE.md", "C".repeat(20))).toBe(true);

		const turn1 = acc.finish();
		expect(turn1.text.length).toBeLessThanOrEqual(100);
		expect(turn1.slices.has("ticket:1")).toBe(true);
		expect(turn1.slices.has("state")).toBe(true);
		expect(turn1.slices.has("file:big")).toBe(false);
		expect(turn1.labels).toEqual(["DEMO-1", "STATE.md"]);

		// Turn 2 with Turn 1's committed hashes: now Big.ssl fits and IS sent!
		const acc2 = createContextAccumulator(turn1.slices, 100, cut);
		expect(acc2.addSlice("ticket:1", "DEMO-1", "A".repeat(70))).toBe(false); // already sent
		expect(acc2.addSlice("file:big", "Big.ssl", "B".repeat(50))).toBe(true);
		const turn2 = acc2.finish();
		expect(turn2.slices.has("file:big")).toBe(true);
		expect(turn2.labels).toEqual(["Big.ssl"]);
	});
});

describe("R6B — textmate.ts codeOnly unloaded guard & token-boundary preservation", () => {
	test("codeOnly returns null when grammar is not loaded yet", () => {
		expect(codeOnly(":IF x;")).toBeNull();
		expect(codeOnly(":IF x;", undefined)).toBeNull();
	});

	test("codeOnly preserves token boundaries so :IF x != :IFx while ignoring comments and layout", async () => {
		const wasm = readFileSync(resolve(import.meta.dir, "../node_modules/vscode-oniguruma/release/onig.wasm"));
		await oniguruma.loadWASM({ data: wasm });
		const rawGrammar = JSON.parse(readFileSync(resolve(import.meta.dir, "../src/view/public/grammar/ssl.tmLanguage.json"), "utf8"));
		const reg = new Registry({
			onigLib: Promise.resolve({
				createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
				createOnigString: (text) => new oniguruma.OnigString(text),
			}),
			loadGrammar: async (scope) => (scope === "source.ssl" ? rawGrammar : null),
		});
		const sslGrammar = (await reg.loadGrammar("source.ssl"))!;

		// Merging tokens across whitespace must NEVER falsely compare equal.
		expect(codeOnly(":IF x;\n:ENDIF;", sslGrammar)).not.toBe(codeOnly(":IFx;\n:ENDIF;", sslGrammar));
		expect(codeOnly(":LOCAL a b;", sslGrammar)).not.toBe(codeOnly(":LOCAL ab;", sslGrammar));

		// Pure SSL comment (`/* ... ;`) & indentation changes STILL compare equal.
		const before = ":PROCEDURE Calc;\n:PARAMETERS nX;\n:IF nX > 0;\n\t:RETURN nX;\n:ENDIF;\n:ENDPROC;";
		const after = [
			"/* Calculates positive value ;",
			":PROCEDURE Calc;",
			"  :PARAMETERS nX; /* input value ;",
			"  :IF nX > 0;",
			"    /* positive branch ;",
			"    :RETURN nX;",
			"  :ENDIF;",
			":ENDPROC;",
		].join("\n");
		expect(codeOnly(before, sslGrammar)).toBe(codeOnly(after, sslGrammar));

		// String literal interior changes must still differ.
		expect(codeOnly('s := "a b";', sslGrammar)).not.toBe(codeOnly('s := "a  b";', sslGrammar));
	});
});

describe("R6B — tidy.ts silent LSP timeout, fence-depth extraction, UNCHANGED, & notePath", () => {
	test("evaluateTidyChecks marks Procedures and parameters unchanged as ok: null on LSP timeout", () => {
		const timedOut = { diagnostics: [], symbols: [], timedOut: true };
		const checks = evaluateTidyChecks(timedOut, timedOut, ":RETURN 1;", ":RETURN 2;", false, () => ":RETURN 1;");
		const lspCheck = checks.find((c) => c.label === "The language server did not answer");
		const procCheck = checks.find((c) => c.label === "Procedures and parameters unchanged");
		expect(lspCheck?.ok).toBeNull();
		expect(procCheck?.ok).toBeNull();

		// Unloaded grammar in commentsOnly step also yields ok: null instead of crashing or passing.
		const okSnap = { diagnostics: [], symbols: [], timedOut: false };
		const commentChecks = evaluateTidyChecks(okSnap, okSnap, ":IF x;", ":IFx;", true, () => null);
		expect(commentChecks.find((c) => c.label === "Only comments changed")?.ok).toBeNull();
	});

	test("fenced() supports markdown|md, nested fences, and ``` inside SSL comments/strings", () => {
		const mdAlias = "```md\n# Context Note\n- Uses Holidays\n```";
		expect(fenced(mdAlias, "markdown")).toEqual(["# Context Note\n- Uses Holidays"]);

		const nestedMd = ["````markdown", "# Notes", "```ssl", ":RETURN 1;", "```", "````"].join("\n");
		expect(fenced(nestedMd, "markdown")).toEqual(["# Notes\n```ssl\n:RETURN 1;\n```"]);

		const sslWithBackticks = [
			"```ssl",
			"/* Inline SSL comment with ``` backticks ;",
			'sFence := "```";',
			":RETURN sFence;",
			"```",
		].join("\n");
		const extracted = fenced(sslWithBackticks, "ssl");
		expect(extracted).toHaveLength(1);
		expect(extracted[0]).toContain(":RETURN sFence;");
		expect(extracted[0]).toContain('sFence := "```";');

		const fourTickSsl = ["````ssl", "/* Multi-line SSL comment:", "```", ";", ":RETURN 1;", "````"].join("\n");
		expect(fenced(fourTickSsl, "ssl")).toEqual(["/* Multi-line SSL comment:\n```\n;\n:RETURN 1;"]);
	});

	test("pickPrimarySslBlock chooses full rewritten file over tiny trailing snippet", () => {
		const orig = ":PROCEDURE Main;\n:LOCAL a := 1;\n:LOCAL b := 2;\n:RETURN a + b;\n:ENDPROC;";
		const fullNew = ":PROCEDURE Main;\n:LOCAL nA := 1;\n:LOCAL nB := 2;\n:IF Empty(nA);\n\t:RETURN 0;\n:ENDIF;\n:RETURN nA + nB;\n:ENDPROC;";
		const tinyTrailing = ":RETURN 0;";
		expect(pickPrimarySslBlock([fullNew, tinyTrailing], orig)).toBe(fullNew);
		// If model echoed original first then gave full rewritten file, pick the modified one.
		expect(pickPrimarySslBlock([orig, fullNew], orig)).toBe(fullNew);
	});

	test("isExplicitUnchanged requires standalone UNCHANGED outside fences", () => {
		expect(isExplicitUnchanged("UNCHANGED")).toBe(true);
		expect(isExplicitUnchanged("UNCHANGED\n\n```markdown\n- Guards already clean.\n```")).toBe(true);
		expect(isExplicitUnchanged("I ran into an error and could not format the file.")).toBe(false);
		expect(isExplicitUnchanged("```ssl\nUNCHANGED\n```")).toBe(false);
		expect(isExplicitUnchanged("Nothing remained unchanged after refactor.")).toBe(false);
	});

	test("notePath disambiguates same-basename scripts across folders", () => {
		const a = notePath("/ws/src/A/Util.ssl", "/ws");
		const b = notePath("/ws/src/B/Util.ssl", "/ws");
		expect(a).toBe("/ws/design/src/A/Util.tidy.md");
		expect(b).toBe("/ws/design/src/B/Util.tidy.md");
		expect(a).not.toBe(b);
	});
});

describe("R6B — workContext.ts hidden dotfile filtering", () => {
	test("isAllowedWorkAttachment rejects dotfiles, hidden folders, and traversal", () => {
		expect(isAllowedWorkAttachment("samples/query.sql", "/ws/docs/tickets/T-1/samples/query.sql")).toBe(true);
		expect(isAllowedWorkAttachment("src/DueDates.ssl", "/home/dev/.workspace/src/DueDates.ssl")).toBe(true);

		expect(isAllowedWorkAttachment(".env", "/ws/.env")).toBe(false);
		expect(isAllowedWorkAttachment(".npmrc", "/ws/.npmrc")).toBe(false);
		expect(isAllowedWorkAttachment("sub/.env.local", "/ws/sub/.env.local")).toBe(false);
		expect(isAllowedWorkAttachment(".git/config", "/ws/.git/config")).toBe(false);
		expect(isAllowedWorkAttachment("../secret.txt", "/ws/../secret.txt")).toBe(false);
		expect(isAllowedWorkAttachment("safe.txt", "/ws/.env")).toBe(false);
	});

	test("workText and workLabel skip hidden dotfiles without reading them", async () => {
		const ticket: DocFile = {
			path: "/ws/docs/tickets/T-1/T-1.md",
			name: "T-1.md",
			group: "tickets",
			exists: true,
			ticket: "T-1",
			title: "Guard secrets",
			status: "in progress",
			ticketFiles: [
				{ path: "/ws/docs/tickets/T-1/.env", rel: ".env", size: 20 },
				{ path: "/ws/docs/tickets/T-1/.npmrc", rel: ".npmrc", size: 20 },
				{ path: "/ws/docs/tickets/T-1/sample.sql", rel: "sample.sql", size: 20 },
			],
		};
		const work = workFor([ticket], "T-1")!;
		const opts = {
			ticketFiles: [
				{ path: "/ws/.env", rel: ".env" },
				{ path: "/ws/.npmrc", rel: ".npmrc" },
				{ path: "/ws/src/Safe.ssl", rel: "src/Safe.ssl" },
			],
		};
		expect(workLabel(work, opts)).toContain("1 ticket file");
		expect(workLabel(work, opts)).not.toContain("3 ticket files");

		const readPaths: string[] = [];
		const prompt = await workText(
			work,
			async (p) => {
				readPaths.push(p);
				if (p.endsWith("T-1.md")) return "# Guard secrets\n\nBody text.";
				if (p.endsWith("Safe.ssl")) return ":RETURN 1;";
				return "SECRET_TOKEN=leaked";
			},
			opts,
		);
		expect(readPaths).not.toContain("/ws/.env");
		expect(readPaths).not.toContain("/ws/.npmrc");
		expect(prompt).not.toContain("SECRET_TOKEN=leaked");
		expect(prompt).not.toContain("- .env");
		expect(prompt).not.toContain("- .npmrc");
		expect(prompt).toContain("ATTACHED TICKET FILE src/Safe.ssl:");
		expect(prompt).toContain("- sample.sql");
	});
});

describe("R6B — store.ts localStorage budget & Agent/Tidy wiring invariants", () => {
	test("trimThreadsForStorage and writeSavedThreads cap payload size and evict cleanly on QuotaExceededError", () => {
		const huge = "X".repeat(MAX_SAVED_ENTRY_CHARS + 5000);
		const threads = Array.from({ length: 5 }, (_, i) => ({
			id: `t${i}`,
			title: `Thread ${i}`,
			updatedAt: 1000 - i,
			entries: [
				{ role: "user" as const, text: `Question ${i}` },
				{ role: "agent" as const, text: huge },
			],
		}));

		const trimmed = trimThreadsForStorage(threads, 2000, 5000);
		expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(5000);
		expect(trimmed[0]!.entries[1]!.text.length).toBeLessThanOrEqual(2000);

		// Simulate localStorage throwing QuotaExceededError until serialized payload <= 1200 bytes.
		let stored = "";
		let attempts = 0;
		const mockStorage = {
			setItem(_key: string, val: string) {
				attempts++;
				if (val.length > 1200) {
					const err = new Error("QuotaExceededError");
					err.name = "QuotaExceededError";
					throw err;
				}
				stored = val;
			},
			removeItem() {
				stored = "";
			},
		};
		writeSavedThreads("/ws/demo", threads, mockStorage, 2000, 100_000);
		expect(attempts).toBeGreaterThan(1);
		expect(stored.length).toBeGreaterThan(0);
		expect(stored.length).toBeLessThanOrEqual(1200);
		const parsed = JSON.parse(stored);
		expect(parsed[0].id).toBe("t0");
	});

	test("store.ts, Agent.tsx, markdown.ts, and tidy.ts keep all Round 6B lifecycle & safety guards wired", () => {
		const storeSrc = readSrc("../src/view/agent/store.ts");
		expect(storeSrc).toContain('nextStatus?.state === "off" || nextStatus?.state === "failed"');
		expect(storeSrc).toContain("setAgent({ status, chatSession: null })");
		expect(storeSrc).toContain("activeTurn.epoch === turnEpoch && activeTurn.workspaceKey === activeWorkspaceKey");
		expect(storeSrc).toContain('typeof d?.delta !== "string"');
		expect(storeSrc).toContain("turnState.streamedEntryId === null && typeof reply.text === \"string\"");
		expect(storeSrc).toContain('if (agent.status.state !== "ready")');
		expect(storeSrc).toContain("if (!savedModel) return false;");

		const agentSrc = readSrc("../src/view/agent/Agent.tsx");
		expect(agentSrc).toContain("if (!root || !isInside(root, path)) return null;");
		expect(agentSrc).toContain("if (!isAllowedContextPath(rel)) return null;");
		expect(agentSrc).toContain("let targetPath = candidates[0]?.path ?? \"\";");
		expect(agentSrc).toContain("hashes: new Map(prepared.slices)");
		expect(agentSrc).toContain("let preparingLock = false;");
		expect(agentSrc).toContain("setTimeout(() => setDebouncedDeltaSrc(next), 350)");
		expect(agentSrc).toContain('safely("Could not open review diff"');
		expect(agentSrc).toContain('safely("Could not add tests to plan"');
		expect(agentSrc).toContain('safely("Could not record answer"');

		const tidySrc = readSrc("../src/view/agent/tidy.ts");
		expect(tidySrc).toContain("const startVersion = doc.model.getAlternativeVersionId();");
		expect(tidySrc).toContain("currentDoc.model.getAlternativeVersionId() !== startVersion");
		expect(tidySrc).toContain("isAllowedContextPath(relativeTo(root, filePath))");
		expect(tidySrc).toContain("canonical(filePath) === selfKey");
		expect(tidySrc).toContain("writeNoteFile");
	});
});
