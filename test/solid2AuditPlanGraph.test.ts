import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createEffect, createMemo, createRoot, createSignal, flush, untrack } from "solid-js";
import { buildNotices, FALLBACK_LICENSE, NOTICE_FILENAMES } from "../scripts/notices";
import { createDraft } from "../src/view/draft";
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

	test("createDraft follows a changed source, and keeps the typing when the source is only worked out again", () => {
		// The shape the plan's rows have: every plan edit hands each row a new object, usually holding the same text.
		const ctx = createRoot((dispose) => {
			const [row, setRow] = createSignal({ answer: "Sample/A.ssl" });
			const [draft, setDraft, committed] = createDraft(() => row().answer);
			return { setRow, draft, setDraft, committed, dispose };
		});
		try {
			flush();
			expect(ctx.draft()).toBe("Sample/A.ssl");

			// The user types.
			ctx.setDraft("Sample/A.ssl, Sample/B.ssl");
			flush();
			expect(ctx.draft()).toBe("Sample/A.ssl, Sample/B.ssl");

			// An unrelated edit: a new row object with the same saved text. The typing stays.
			ctx.setRow({ answer: "Sample/A.ssl" });
			flush();
			expect(ctx.draft()).toBe("Sample/A.ssl, Sample/B.ssl");
			expect(ctx.committed()).toBe("Sample/A.ssl");

			// The saved text itself changes: the draft follows it.
			ctx.setRow({ answer: "Sample/C.ssl" });
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
		expect(src).toContain("const scripts = targetsField({");
		expect(src).toContain("ref={props.bindTextarea(scripts.draft)}");
		expect(src).toContain("value={scripts.draft()}");
		expect(src).toContain("scripts.type(e.currentTarget.value);");
	});

	test("PlanAssistant.tsx loads saved build runs inside the planPath effect rather than mount-only onSettled", () => {
		const src = readRepo("src/view/plan/PlanAssistant.tsx");
		expect(src).not.toMatch(/onSettled\(\(\) => \{[^}]*loadRun/);
		expect(src).toMatch(
			/createEffect\(\s*\(\) => planPath\(\),\s*\(p\) => \{\s*setDraftReq\(null\);\s*untrack\(\(\) => \{\s*void loadRun\(p\);\s*\}\);\s*\},\s*\);/,
		);
	});
});

// =============================================================================
// 5. Pass-2 Adversarial Audit Regression Checks
// =============================================================================
describe("Pass-2 adversarial audit fixes — Plan, Graph, Backend & Notices", () => {
	test("PlanTests.tsx uses one-shot untrack() signal initializers and keyed <For> loops", () => {
		const src = readRepo("src/view/plan/PlanTests.tsx");

		// 1. TestCaseForm uses createSignal(untrack(...)) rather than derived writable createSignal(() => ...)
		expect(src).toContain('import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";');
		expect(src).toContain("const [title, setTitle] = createSignal(untrack(() => props.initial?.title ?? \"\"));");
		expect(src).toContain("const [nodeId, setNodeId] = createSignal(untrack(() => props.initial?.node ?? \"\"));");
		expect(src).toContain("const [journey, setJourney] = createSignal(untrack(() => (props.initial?.journey ? String(props.initial.journey) : \"\")));");
		expect(src).toContain("const [given, setGiven] = createSignal(untrack(() => props.initial?.given ?? \"\"));");
		expect(src).toContain("const [expect, setExpect] = createSignal(untrack(() => props.initial?.expect ?? \"\"));");
		expect(src).toContain("const [notes, setNotes] = createSignal(untrack(() => props.initial?.notes ?? \"\"));");
		expect(src).toContain("const [notesOpen, setNotesOpen] = createSignal(untrack(() => Boolean(props.initial?.notes?.trim())));");
		expect(src).not.toContain("createSignal(() => props.initial");

		// 2. Keyed <For> loops for cases, nodes, and paths, reading accessors lazily
		expect(src).toContain("<For each={props.cases} keyed={(item) => item.id}>");
		expect(src).toContain("<For each={props.nodes} keyed={(n) => n.id}>");
		expect(src).toMatch(/<For each=\{props\.paths\} keyed=\{\(p\) => /);
		expect(src).toContain("const isEditing = () => editingId() === item().id;");
		expect(src).toContain("const isOpen = () => expandedId() === item().id;");
		expect(src).toContain("initial={item()}");
	});

	test("PlanView.tsx keys activeHandles, avoids redundant setEdge on same edge, guards inline edit blur with settled, removes keyed on dynamic Show overlays, and fits via ResizeObserver", () => {
		const src = readRepo("src/view/plan/PlanView.tsx");

		// 1. Keyed activeHandles + redundant setEdge guard in startRouteDrag
		expect(src).toContain("<For each={activeHandles()} keyed={(item) => item.h.key}>");
		expect(src).toContain("onMouseDown={(e) => startRouteDrag(e, item().line, item().h)}");
		expect(src).toContain("resetEdgeRoute({ from: item().line.from, to: item().line.to }, item().h.key);");
		expect(src).toMatch(
			/const curEdge = edge\(\);\s*if \(!curEdge \|\| curEdge\.from !== line\.from \|\| curEdge\.to !== line\.to\) \{\s*select\(null\);\s*setEdge\(\{ from: line\.from, to: line\.to \}\);\s*\}/,
		);

		// 2. Inline edit synchronous settled guard prevents Escape/Enter double-commit or escaped commit on blur
		expect(src).toContain("let settled = false;");
		expect(src).toMatch(/if \(e\.key === "Enter"\) \{\s*settled = true;\s*commitEdit\(e\.currentTarget\.value\);\s*\}/);
		expect(src).toMatch(/if \(e\.key === "Escape"\) \{\s*settled = true;\s*setEditing\(null\);\s*refocus\(\);\s*\}/);
		expect(src).toMatch(/onBlur=\{\(e\) => \{\s*if \(!settled && editing\(\) === target\) \{\s*settled = true;\s*commitEdit\(e\.currentTarget\.value, false\);\s*\}\s*\}\}/);

		// 3. Remove keyed on marquee(), floatBarPos(), and activePathInfo()
		expect(src).toContain("<Show when={marquee()}>");
		expect(src).not.toContain("<Show when={marquee()} keyed>");
		expect(src).toContain("<Show when={floatBarPos()}>");
		expect(src).not.toContain("<Show when={floatBarPos()} keyed>");
		expect(src).toContain("<Show when={!linking() && activePathInfo()}>");
		expect(src).not.toContain("<Show when={!linking() && activePathInfo()} keyed>");

		// 4. Live Source -> Chart ResizeObserver auto-fit when !fitted
		expect(src).toContain("if (!untrack(isTextMode) && width >= 10 && height >= 10)");
		expect(src).toContain("if (!fitted && w >= 10 && h >= 10 && !untrack(isTextMode) && untrack(layout))");
		expect(src).toContain("ref={bindCanvas}");
	});

	test("PlanAssistant.tsx uses DraftAnswerInput with onSettled snap-back and keyed <For> loops", () => {
		const src = readRepo("src/view/plan/PlanAssistant.tsx");

		expect(src).toContain("function DraftAnswerInput(");
		expect(src).toContain("const [draft, setDraft] = createDraft(() => props.value);");
		expect(src).toMatch(/onSettled\(\(\) => \{[\s\S]*?const cur = untrack\(\(\) => props\.value\);[\s\S]*?setDraft\(cur\);/);
		expect(src).toContain("<DraftAnswerInput");
		expect(src).toContain("<For each={open()} keyed={(q) => q.question}>");
		expect(src).toContain("<For each={closed()} keyed={(q) => q.question}>");
		expect(src).toContain('<For each={r().units.filter((u) => u.status !== "kept")} keyed={(u) => u.name}>');
	});

	test("GraphView.tsx removes keyed from Impact Analysis <Show> and resyncs hopsDraft/depthDraft on open and blur", () => {
		const src = readRepo("src/view/graph/GraphView.tsx");

		expect(src).toContain("<Show when={impactOpen() && impactReport()}>");
		expect(src).not.toContain("<Show when={impactOpen() && impactReport()} keyed>");
		expect(src).toContain("aria-label={`Impact analysis for ${report().targetLabel || \"selection\"}`}");
		expect(src).toContain('() => (filter().mode === "around" ? String(filter().depth) : null)');
		expect(src).toContain("() => (impactOpen() ? String(impactHops()) : null)");
		expect(src).toContain("onChange={(e) => commitDepth(e.currentTarget)}");
		expect(src).toContain("onBlur={(e) => commitDepth(e.currentTarget)}");
		expect(src).toContain("onChange={(e) => commitHops(e.currentTarget)}");
		expect(src).toContain("onBlur={(e) => commitHops(e.currentTarget)}");

		// Runtime proof: opening/re-entering resyncs dirty draft value cleanly in Solid 2.
		const ctx = createRoot((dispose) => {
			const [open, setOpen] = createSignal(false);
			const [hops, setHops] = createSignal(4);
			const [draft, setDraft] = createSignal(String(untrack(hops)));
			createEffect(
				() => (open() ? String(hops()) : null),
				(v) => {
					if (v !== null) setDraft(v);
				},
			);
			return { setOpen, setHops, draft, setDraft, dispose };
		});
		try {
			flush();
			ctx.setOpen(true);
			flush();
			expect(ctx.draft()).toBe("4");

			// User types garbage and closes without committing.
			ctx.setDraft("999");
			flush();
			expect(ctx.draft()).toBe("999");
			ctx.setOpen(false);
			flush();

			// Reopening resyncs draft to canonical hops value.
			ctx.setOpen(true);
			flush();
			expect(ctx.draft()).toBe("4");
		} finally {
			ctx.dispose();
		}
	});

	test("PlanCodeDrilldown.tsx snaps Target scripts draft back via onSettled on change and blur", () => {
		const src = readRepo("src/view/plan/PlanCodeDrilldown.tsx");

		expect(src).toContain('import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";');
		expect(src).toMatch(
			/onSettled\(\(\) => \{[\s\S]*?const cur = untrack\(\(\) => targets\(\)\.join\(", "\)\);[\s\S]*?scripts\.show\(cur\);[\s\S]*?if \(el\.value !== cur\) el\.value = cur;[\s\S]*?props\.fitTextarea\(el\);/,
		);
		expect(src).toContain("onBlur={(e) => {");
		expect(src).toContain("resyncScripts(e.currentTarget);");
	});

	test("src/bun/backend.ts importDocFile strips case-sensitive extname(src) so uppercase extensions do not leave double extensions", () => {
		const src = readRepo("src/bun/backend.ts");
		expect(src).toContain('const rawStem = basename(src, extname(src)).replace(/[\\\\/:*?"<>|]+/g, "-").trim() || "imported";');
		expect(src).not.toContain("basename(src, ext).replace(");
	});

	test("scripts/notices.ts includes THIRD-PARTY-LICENSE, fallback MIT licenses for solid-js/@solidjs/web, mermaid deps, and full text in THIRD-PARTY-NOTICES.md", async () => {
		expect(NOTICE_FILENAMES).toContain("THIRD-PARTY-LICENSE");
		expect(FALLBACK_LICENSE["solid-js"]).toBe("third-party/solid-MIT-LICENSE");
		expect(FALLBACK_LICENSE["@solidjs/web"]).toBe("third-party/solid-MIT-LICENSE");

		const solidLicense = readRepo("third-party/solid-MIT-LICENSE");
		expect(solidLicense).toContain("MIT License");
		expect(solidLicense).toContain("Ryan Carniato");

		// src/view/public/THIRD-PARTY-NOTICES.md is a build artefact (gitignored), so it is not compared here:
		// a stale local copy failed this test and a clean checkout skipped it. What is built is what is checked.
		const built = await buildNotices(root);

		const sectionOf = (pkg: string) => {
			const idx = built.text.indexOf(`## ${pkg} `);
			expect(idx, `missing heading for ${pkg}`).toBeGreaterThan(-1);
			const next = built.text.indexOf("\n## ", idx + 1);
			return built.text.slice(idx, next === -1 ? undefined : next);
		};

		for (const pkg of [
			"solid-js", "@solidjs/web", "rolldown", "katex", "cytoscape", "d3", "dagre-d3-es", "roughjs",
			// Bundled through CodeMirror, Monaco and the XML formatter.
			"@lezer/common", "@lezer/lr", "style-mod", "w3c-keyname", "crelt", "@marijn/find-cluster-break", "@vscode/diff", "@xml-tools/parser", "nearley",
		]) {
			const sec = sectionOf(pkg);
			expect(sec, `${pkg} should include fenced license text`).toContain("```");
		}
		expect(sectionOf("solid-js")).toContain("Ryan Carniato");
		expect(sectionOf("@solidjs/web")).toContain("Ryan Carniato");
		expect(sectionOf("rolldown")).toContain("### THIRD-PARTY-LICENSE");
		expect(sectionOf("katex")).toContain("### LICENSE");
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
			"() => [graph(), drawn(), mode(), gathered(), govScriptState().map, fitKey(), folding(), state.workspace?.root, state.settings.limits.bytes, answered()] as const",
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
