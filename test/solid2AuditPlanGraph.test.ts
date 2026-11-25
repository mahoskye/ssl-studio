import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createEffect, createMemo, createRoot, createSignal, flush, untrack } from "solid-js";
import { buildNotices } from "../scripts/notices";
import type { PreviewTarget } from "../src/view/plan/PlanCodeDrilldown";

// Minimal headless browser & Monaco shims so pure exported helpers from .tsx views can be imported cleanly.
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
		innerHeight: 900,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
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
		parse: (raw: string) => (raw.startsWith("file://") ? makeUri("file", raw.slice("file://".length)) : makeUri("untitled", raw)),
	},
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { KeyF: 36, KeyZ: 56, KeyY: 55 },
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
		getModels: () => [],
		getModel: () => null,
		createModel: () => null,
		onDidCreateModel: () => ({ dispose() {} }),
		setModelMarkers() {},
		getModelMarkers: () => [],
		registerEditorOpener: () => ({ dispose() {} }),
	}),
}));

const { samePreviewTarget } = await import("../src/view/plan/PlanCodeDrilldown");

const root = resolve(import.meta.dir, "..");
const readRepo = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

// =============================================================================
// 1. Build, Notices & TypeScript 7.0.2 Config Audits
// =============================================================================
describe("Vite 8.3.8, TypeScript 7.0.2 & notices audit fixes", () => {
	test("vite.config.ts uses Oxc minifier and never references esbuild", () => {
		const src = readRepo("vite.config.ts");
		expect(src).toContain('minify: process.env.NO_MINIFY ? false : "oxc"');
		expect(src).not.toContain('"esbuild"');
		expect(src).not.toContain("'esbuild'");
	});

	test("scripts/notices.ts includes rolldown and captures its MIT LICENSE in THIRD-PARTY-NOTICES", async () => {
		const src = readRepo("scripts/notices.ts");
		expect(src).toContain('"rolldown"');

		const { text } = await buildNotices(root);
		const rolldownIdx = text.indexOf("## rolldown ");
		expect(rolldownIdx).toBeGreaterThan(-1);
		const nextSectionIdx = text.indexOf("\n## ", rolldownIdx + 1);
		const rolldownSection = text.slice(rolldownIdx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
		expect(rolldownSection).toContain("(MIT)");
		expect(rolldownSection).toContain("### LICENSE");
	});

	test("tsconfig.json declares all 7 explicit electrobun UI/JSX aliases ahead of wildcards", () => {
		const cfg = JSON.parse(readRepo("tsconfig.json")) as {
			compilerOptions: { paths: Record<string, string[]> };
		};
		const paths = cfg.compilerOptions.paths;
		const keys = Object.keys(paths);
		const mainWildcardIdx = keys.indexOf("electrobun/main/*");
		const bunWildcardIdx = keys.indexOf("electrobun/bun/*");
		expect(mainWildcardIdx).toBeGreaterThan(-1);
		expect(bunWildcardIdx).toBeGreaterThan(-1);
		const firstWildcardIdx = Math.min(mainWildcardIdx, bunWildcardIdx);

		const expected: Record<string, string[]> = {
			"electrobun/main/ui/jsx-runtime": ["./.hutch/devkit/api/sdks/main/ui/jsx-runtime.ts"],
			"electrobun/main/ui/jsx-dev-runtime": ["./.hutch/devkit/api/sdks/main/ui/jsx-dev-runtime.ts"],
			"electrobun/bun/ui/jsx-runtime": ["./.hutch/devkit/api/sdks/main/ui/jsx-runtime.ts"],
			"electrobun/bun/ui/jsx-dev-runtime": ["./.hutch/devkit/api/sdks/main/ui/jsx-dev-runtime.ts"],
			"electrobun/browser/ui": ["./.hutch/devkit/api/browser/ui/index.ts"],
			"electrobun/browser/ui/jsx-runtime": ["./.hutch/devkit/api/browser/ui/jsx-runtime.ts"],
			"electrobun/browser/ui/jsx-dev-runtime": ["./.hutch/devkit/api/browser/ui/jsx-dev-runtime.ts"],
		};

		for (const [alias, targets] of Object.entries(expected)) {
			expect(paths[alias]).toEqual(targets);
			const idx = keys.indexOf(alias);
			expect(idx).toBeGreaterThan(-1);
			expect(idx).toBeLessThan(firstWildcardIdx);
		}
	});
});

// =============================================================================
// 2. SolidJS 2.0.3 Reactive Runtime Proofs (Coalesced Pan & Structural Memos)
// =============================================================================
describe("SolidJS 2.0.3 reactive invariants", () => {
	test("functional setView updater preserves every coalesced drag-pan delta before flush()", () => {
		const ctx = createRoot((dispose) => {
			const [view, setView] = createSignal({ x: 10, y: 20, scale: 1 });
			return { view, setView, dispose };
		});
		try {
			// Two coalesced pointer moves prior to Solid 2 flush must accumulate both deltas.
			ctx.setView((v) => ({ ...v, x: v.x + 15, y: v.y - 5 }));
			ctx.setView((v) => ({ ...v, x: v.x + 25, y: v.y + 12 }));
			flush();
			expect(ctx.view()).toEqual({ x: 50, y: 27, scale: 1 });
		} finally {
			ctx.dispose();
		}
	});

	test("samePreviewTarget prevents downstream effect reruns on structurally equal target recreations", () => {
		expect(samePreviewTarget(null, null)).toBe(true);
		expect(samePreviewTarget(null, { name: "Foo", label: "Foo" })).toBe(false);
		expect(
			samePreviewTarget(
				{ name: "Release", script: "Sample/Release.ssl", label: "Release" },
				{ name: "Release", script: "Sample/Release.ssl", label: "Release" },
			),
		).toBe(true);
		expect(
			samePreviewTarget(
				{ name: "Release", script: "Sample/Release.ssl", label: "Release" },
				{ name: "Release", script: "Sample/Other.ssl", label: "Release" },
			),
		).toBe(false);
		expect(
			samePreviewTarget(
				{ name: "Helper", hintScript: "A.ssl", label: "Helper" },
				{ name: "Helper", hintScript: "B.ssl", label: "Helper" },
			),
		).toBe(false);

		let effectRuns = 0;
		const ctx = createRoot((dispose) => {
			const [rev, setRev] = createSignal(0);
			const [targetSpec, setTargetSpec] = createSignal<PreviewTarget>({
				name: "Release",
				script: "Sample/Release.ssl",
				label: "Release",
			});
			const memo = createMemo<PreviewTarget | null>(
				() => {
					rev();
					const t = targetSpec();
					return { ...t };
				},
				{ equals: samePreviewTarget },
			);
			createEffect(
				() => memo(),
				() => {
					effectRuns++;
				},
			);
			return { setRev, setTargetSpec, dispose };
		});
		try {
			flush();
			expect(effectRuns).toBe(1);

			// Unrelated plan revisions (drags, notes, offsets) produce fresh object with identical fields -> no rerun.
			ctx.setRev(1);
			flush();
			ctx.setRev(2);
			flush();
			expect(effectRuns).toBe(1);

			// Real target change triggers effect once.
			ctx.setTargetSpec({ name: "Approve", script: "Sample/Release.ssl", label: "Approve" });
			flush();
			expect(effectRuns).toBe(2);
		} finally {
			ctx.dispose();
		}
	});

	test("ELK layout cleanup cancels in-flight work when input key or mode changes", () => {
		let layoutRun = 0;
		let startedRun = 0;
		const ctx = createRoot((dispose) => {
			const [mode, setMode] = createSignal<"graph" | "list">("graph");
			createEffect(
				() => mode(),
				(as) => {
					if (as !== "graph") {
						++layoutRun;
						return () => {
							++layoutRun;
						};
					}
					startedRun = ++layoutRun;
					return () => {
						++layoutRun;
					};
				},
			);
			return { setMode, dispose };
		});
		try {
			flush();
			expect(startedRun).toBe(1);
			expect(layoutRun).toBe(1);

			// Switching Graph -> List runs cleanup and invalidates the in-flight run token.
			ctx.setMode("list");
			flush();
			expect(layoutRun).toBeGreaterThan(startedRun);
		} finally {
			ctx.dispose();
		}
	});

	test("draft signal seeded with untrack() stays synced on source changes without losing user typing", () => {
		const ctx = createRoot((dispose) => {
			const [source, setSource] = createSignal("Sample/A.ssl");
			const [draft, setDraft] = createSignal(untrack(source));
			createEffect(
				() => source(),
				(v) => {
					setDraft(v);
				},
			);
			return { setSource, draft, setDraft, dispose };
		});
		try {
			flush();
			expect(ctx.draft()).toBe("Sample/A.ssl");

			// User edits locally via onInput.
			ctx.setDraft("Sample/A.ssl, Sample/B.ssl");
			flush();
			expect(ctx.draft()).toBe("Sample/A.ssl, Sample/B.ssl");

			// External source update resyncs draft.
			ctx.setSource("Sample/C.ssl");
			flush();
			expect(ctx.draft()).toBe("Sample/C.ssl");
		} finally {
			ctx.dispose();
		}
	});
});

// =============================================================================
// 3. PlanView.tsx, PlanTextView.tsx, PlanCodeDrilldown.tsx, PlanAssistant.tsx
// =============================================================================
describe("Plan views — Solid 2 audit regression checks", () => {
	test("PlanView.tsx fixes nodeContextMenu align count, drag-pan functional updater, ELK memo/cleanup, reveal drag guard, and editing-keyed inline input", () => {
		const src = readRepo("src/view/plan/PlanView.tsx");

		// 1. nodeContextMenu passes effective selection count into alignSubmenu
		expect(src).toContain("const alignSubmenu = (count = selectedIds().size): RowMenuEntry[] =>");
		expect(src).toContain("const effectiveCount = keepMulti ? selectedIds().size : 1;");
		expect(src).toContain("const alignGroup = alignSubmenu(effectiveCount);");

		// 2. Canvas drag-pan uses functional setView updater
		expect(src).toContain("setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));");
		expect(src).not.toContain("const v = view();\n\t\t\t\t\t\t\tsetView({ ...v, x: v.x + dx, y: v.y + dy });");

		// 3. ELK layout memo uses structural key equality, passes { key, plan, suggestions, dir }, and returns cleanup
		expect(src).toContain("const layoutInput = createMemo(");
		expect(src).toContain("{ equals: (a, b) => a.key === b.key }");
		expect(src).toMatch(
			/createEffect\(\s*\(\) => layoutInput\(\),\s*\(\{ key, plan: p, suggestions, dir \}\) => \{[\s\S]*?return \(\) => \{\s*\+\+layoutRun;\s*\};/,
		);

		// 4. fit() uses untrack for snapshot reads; reveal effect skips auto-pan while nodeDrag moved and uses functional setView
		expect(src).toContain("const [l, sel] = untrack(() => [layout(), selected()] as const);");
		expect(src).toContain("if (!l || !canvas || untrack(nodeDrag)?.moved) return;");
		expect(src).toMatch(
			/setView\(\(v\) => \{\s*const shown = reveal\(v, box, size\);\s*return outOfSight\(l, shown, size\) \? clearOf\(shown, box, mapArea\(l, size\)\) : shown;\s*\}\);/,
		);

		// 5. Inline edit input is keyed on editing() (NOT editBox()), binds style to box(), and seeds defaultValue outside ref
		expect(src).toContain("<Show when={editing()} keyed>");
		expect(src).not.toContain("<Show when={editBox()} keyed>");
		expect(src).toContain("const initial = untrack(editValue);");
		expect(src).toContain("defaultValue={initial}");
		expect(src).not.toContain("el.value = editValue();");
	});

	test("PlanTextView.tsx wraps builderRequest imperative snapshot reads in untrack()", () => {
		const src = readRepo("src/view/plan/PlanTextView.tsx");
		expect(src).toMatch(
			/createEffect\(\s*\(\) => props\.builderRequest,\s*\(req\) => \{\s*if \(!req \|\| req\.seq === handledSeq\) return;\s*handledSeq = req\.seq;\s*untrack\(\(\) => \{/,
		);
	});

	test("PlanCodeDrilldown.tsx uses structural equals on preview target memos and draft signal on Target scripts textarea", () => {
		const src = readRepo("src/view/plan/PlanCodeDrilldown.tsx");
		expect(src).toContain("export function samePreviewTarget(");
		expect(src).toMatch(/const defaultTarget = createMemo<PreviewTarget \| null>\([\s\S]*?\{ equals: samePreviewTarget \}/);
		expect(src).toContain("const activeTarget = createMemo<PreviewTarget | null>(() => pickedTarget() ?? defaultTarget(), { equals: samePreviewTarget });");
		expect(src).toContain("const [scriptsDraft, setScriptsDraft] = createSignal(untrack(scriptsText));");
		expect(src).toContain("ref={props.bindTextarea(scriptsDraft)}");
		expect(src).toContain("value={scriptsDraft()}");
		expect(src).toContain("setScriptsDraft(e.currentTarget.value);");
	});

	test("PlanAssistant.tsx loads saved build runs inside the planPath effect rather than mount-only onSettled", () => {
		const src = readRepo("src/view/plan/PlanAssistant.tsx");
		expect(src).not.toContain("onSettled(");
		expect(src).toMatch(
			/createEffect\(\s*\(\) => planPath\(\),\s*\(p\) => \{\s*setDraftReq\(null\);\s*untrack\(\(\) => \{\s*void loadRun\(p\);\s*\}\);\s*\},\s*\);/,
		);
	});
});

// =============================================================================
// 4. GraphView.tsx — Solid 2 Audit Fixes
// =============================================================================
describe("GraphView.tsx — Solid 2 audit regression checks", () => {
	test("GraphView.tsx fixes drag-pan updater, ELK cleanup & compute inputs, STRICT_READ_UNTRACKED effects, and number input drafts", () => {
		const src = readRepo("src/view/graph/GraphView.tsx");

		// 1. Canvas drag-pan uses functional updater
		expect(src).toContain("setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));");
		expect(src).not.toContain("setView({ ...v, x: v.x + e.clientX - dragging.x, y: v.y + e.clientY - dragging.y });");

		// 2. ELK layout effect passes govMap, fitKey, folding, root, byteLimit via compute and cleans up unconditionally
		expect(src).toContain("const govScriptState = createMemo(");
		expect(src).toContain(
			"() => [graph(), drawn(), mode(), gathered(), govScriptState().map, fitKey(), folding(), state.workspace?.root, state.settings.limits.bytes] as const",
		);
		expect(src).toContain("([g, keep, as, gathering, govMap, layoutKey, canFold, root, byteLimit]) => {");
		expect(src).toMatch(
			/if \(!g \|\| !keep \|\| as !== "graph"\) \{\s*\+\+layoutRun;\s*return \(\) => \{\s*\+\+layoutRun;\s*\};\s*\}/,
		);
		expect(src).toMatch(/setProgress\(`Layout failed: \$\{e\?\.message \?\? e\}`\);\s*\}\s*\}\)\(\);\s*return \(\) => \{\s*\+\+layoutRun;\s*\};/);

		// 3. STRICT_READ_UNTRACKED eliminations across effects
		expect(src).toContain('setFilter((f) => (f.mode === "around" ? { ...f, mode: "all" } : f));');
		expect(src).toContain("const cur = untrack(ticketHighlightKey)?.trim() || \"\";");
		expect(src).toContain("const rootAndLsp = createMemo(() => [state.workspace?.root ?? \"\", state.lsp.state] as const, {");
		expect(src).toMatch(/createEffect\(\s*\(\) => rootAndLsp\(\),\s*\(\[root, lsp\]\) => \{\s*if \(root && lsp === "running"\) \{\s*void refresh\(root\);/);
		expect(src).toMatch(/if \(!req \|\| !g \|\| req\.seq === handledFocusReq\) return;[\s\S]*?untrack\(\(\) => \{/);
		expect(src).toMatch(/if \(!req \|\| req\.seq === handledImpactReq\) return;[\s\S]*?untrack\(\(\) => \{\s*void runTicketImpactAnalysis\(req\.key\);\s*\}\);/);

		// 4. Depth & Hops number inputs backed by local draft signals
		expect(src).toContain("const [depthDraft, setDepthDraft] = createSignal(String(untrack(filter).depth));");
		expect(src).toContain("value={depthDraft()}");
		expect(src).toContain("onInput={(e) => setDepthDraft(e.currentTarget.value)}");
		expect(src).toContain("const [hopsDraft, setHopsDraft] = createSignal(String(untrack(impactHops)));");
		expect(src).toContain("value={hopsDraft()}");
		expect(src).toContain("onInput={(e) => setHopsDraft(e.currentTarget.value)}");
	});
});
