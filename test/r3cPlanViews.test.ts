import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { planTargetsOf } from "../src/view/plan/assist";
import { planPaths, type BuiltUnit, type Drift } from "../src/view/plan/built";
import { chartGraph } from "../src/view/plan/chart";
import type { Plan } from "../src/view/plan/model";

// --- Minimal headless browser & Monaco shims so pure exported helpers from .tsx views can be imported directly ---
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

const { defaultNodeLabel, pruneSelectedIds, resolveElkBoxKind, syncSelectedIds } = await import("../src/view/plan/PlanView");
const { resolveDriftOpenAction, safeDecisionsOf } = await import("../src/view/plan/PlanAssistant");
const { sigOf } = await import("../src/view/plan/PlanCodeDrilldown");
const { validTestScript } = await import("../src/view/plan/PlanTests");
const { computeAnchorDetachState, isEditableTarget, planTextUndoAction, resolveBuilderSaveMode } = await import("../src/view/plan/PlanTextView");

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

const basePlan = (): Plan => ({
	version: 1,
	title: "Sample Approval",
	groups: [{ id: "g1", name: "Review" }],
	nodes: [
		{ id: "n1", kind: "start", text: "Receive sample" },
		{ id: "n2", kind: "decision", text: "Is urgent?", group: "g1" },
		{ id: "n3", kind: "step", text: "Fast track", group: "g1" },
		{ id: "n4", kind: "step", text: "Standard queue", group: "g1" },
		{ id: "n5", kind: "decision", text: "Needs QA?", group: "g1" },
		{ id: "n6", kind: "end", text: "Released" },
		{ id: "n7", kind: "end", text: "Held for QA" },
	],
	edges: [
		{ from: "n1", to: "n2" },
		{ from: "n2", to: "n3", label: "yes" },
		{ from: "n2", to: "n4", label: "no" },
		{ from: "n3", to: "n5" },
		{ from: "n4", to: "n5" },
		{ from: "n5", to: "n6", label: "no" },
		{ from: "n5", to: "n7", label: "yes" },
	],
});

// =============================================================================
// 1. PlanView.tsx — ELK resolution, labels, selection sync, and UI invariants
// =============================================================================
describe("PlanView.tsx — pure helpers & layout invariants", () => {
	test("resolveElkBoxKind handles node/group ID collisions, node 'root', empty-named stages, and groupElkIds fallback", () => {
		const nodes = [
			{ id: "root", kind: "start" as const, text: "Start" },
			{ id: "s1", kind: "step" as const, text: "Validate", group: "s1" },
			{ id: "s2", kind: "step" as const, text: "Archive", group: "g_empty" },
		];
		const groups = [
			{ id: "s1", name: "Validation" },
			{ id: "g_empty", name: "" },
		];
		const groupElkIds = new Map<string, string>([
			["group:s1", "s1"],
			["group:g_empty", "g_empty"],
		]);

		// Colliding node and group IDs both resolve cleanly without overshadowing each other.
		const groupHit = resolveElkBoxKind("group:s1", nodes, groups, groupElkIds);
		expect(groupHit).toEqual({ kind: "group", id: "s1", group: groups[0]! });

		const nodeHit = resolveElkBoxKind("s1", nodes, groups, groupElkIds);
		expect(nodeHit).toEqual({ kind: "node", id: "s1", node: nodes[1]! });

		// Node literally named "root" resolves as a node.
		const rootNode = resolveElkBoxKind("root", nodes, groups, groupElkIds);
		expect(rootNode).toEqual({ kind: "node", id: "root", node: nodes[0]! });

		// Empty-named stage resolves as a group with name "".
		const emptyStage = resolveElkBoxKind("group:g_empty", nodes, groups, groupElkIds);
		expect(emptyStage).toEqual({ kind: "group", id: "g_empty", group: { id: "g_empty", name: "" } });

		// Fallback when groupElkIds is absent still resolves non-colliding groups and nodes.
		expect(resolveElkBoxKind("g_empty", nodes, groups)).toEqual({ kind: "group", id: "g_empty", group: groups[1]! });
		expect(resolveElkBoxKind("root", nodes, groups)).toEqual({ kind: "node", id: "root", node: nodes[0]! });
		expect(resolveElkBoxKind("missing", nodes, groups, groupElkIds)).toBeNull();
	});

	test("chartGraph + resolveElkBoxKind cleanly preserve colliding node/group IDs, node 'root', and empty-named stages", () => {
		const plan: Plan = {
			version: 1,
			title: "Collision Test",
			groups: [
				{ id: "s1", name: "Stage One" },
				{ id: "g_blank", name: "" },
			],
			nodes: [
				{ id: "root", kind: "start", text: "Begin" },
				{ id: "s1", kind: "step", text: "Work", group: "s1" },
				{ id: "n3", kind: "end", text: "Done", group: "g_blank" },
			],
			edges: [
				{ from: "root", to: "s1" },
				{ from: "s1", to: "n3" },
			],
		};
		const built = chartGraph(plan, new Map());
		const resolvedNodes: string[] = [];
		const resolvedGroups: { id: string; name: string }[] = [];
		const walk = (n: any) => {
			if (n !== built.graph) {
				const r = resolveElkBoxKind(String(n.id), built.nodes, built.groups, built.groupElkIds);
				if (r?.kind === "node") resolvedNodes.push(r.id);
				else if (r?.kind === "group") resolvedGroups.push({ id: r.id, name: r.group.name });
			}
			for (const c of n.children ?? []) walk(c);
		};
		walk(built.graph);

		expect(resolvedNodes.sort()).toEqual(["n3", "root", "s1"]);
		expect(resolvedGroups).toEqual([
			{ id: "s1", name: "Stage One" },
			{ id: "g_blank", name: "" },
		]);
	});

	test("defaultNodeLabel returns 'End' for kind === 'end' instead of 'New step'", () => {
		expect(defaultNodeLabel("end")).toBe("End");
		expect(defaultNodeLabel("start")).toBe("Start");
		expect(defaultNodeLabel("decision")).toBe("Decision?");
		expect(defaultNodeLabel("step")).toBe("New step");
		expect(defaultNodeLabel("call", "Samples.Release")).toBe("Samples.Release");
		expect(defaultNodeLabel("call")).toBe("Call procedure");
	});

	test("pruneSelectedIds removes deleted nodes and syncSelectedIds tracks external cursor changes", () => {
		const initial = new Set(["n1", "n2", "n3"]);
		const valid = new Set(["n1", "n3"]);
		const pruned = pruneSelectedIds(initial, valid);
		expect([...pruned]).toEqual(["n1", "n3"]);
		expect(pruneSelectedIds(pruned, valid)).toBe(pruned);

		// Preserves multi-selection when cursor lands on one of the selected nodes.
		expect(syncSelectedIds(pruned, "n1")).toBe(pruned);
		// Resets to single node when cursor moves externally (e.g. split Source edit or Undo).
		expect([...syncSelectedIds(pruned, "n9")]).toEqual(["n9"]);
		// Clears multi-selection when cursor leaves nodes altogether.
		expect([...syncSelectedIds(pruned, null)]).toEqual([]);
	});

	test("PlanView source invariants: root check, empty stage rendering, stale ask guards, split-view bridge & setPlanMode, ELK cleanup, Text->Chart fit, float-bar refocus", () => {
		const src = readSrc("../src/view/plan/PlanView.tsx");

		// layoutWith skips `n !== result` (not `n.id !== "root"`) and checks `!b.node && b.group !== undefined` via isGroupBox.
		expect(src).toContain("if (n !== result)");
		expect(src).not.toContain('if (n.id !== "root")');
		expect(src).toContain("const isGroupBox = (b: Box): boolean => !b.node && b.group !== undefined;");
		expect(src).toContain("if (!isGroupBox(b)) return b;");
		expect(src).toContain("if (!isGroupBox(g)) continue;");
		expect(src).toContain("baseLayout()?.boxes.filter(isGroupBox)");

		// Re-reads latest plan() after await ask(...) in addStageGroupAsk, renameStageAsk, addCallAsk.
		for (const fn of ["addStageGroupAsk", "renameStageAsk", "addCallAsk"]) {
			const start = src.indexOf(`const ${fn} =`);
			expect(start).toBeGreaterThan(-1);
			const slice = src.slice(start, start + 600);
			const askIdx = slice.indexOf("await ask(");
			const latestIdx = slice.indexOf("const latest = plan();");
			expect(askIdx).toBeGreaterThan(-1);
			expect(latestIdx).toBeGreaterThan(askIdx);
			expect(slice).toContain("if (!latest) return;");
		}

		// Split-view planBridge registration gated on props.group.
		expect(src).toContain("state.activeGroup === props.group");
		expect(src).toContain("state.groups[props.group]?.active === props.path");
		expect(src).toContain('planMode(props.path, props.group) !== "source"');

		// Every setPlanMode(...) call passes props.group as the 3rd argument.
		const modeCalls = [...src.matchAll(/setPlanMode\(([^)]+)\)/g)].map((m) => m[1]!);
		expect(modeCalls.length).toBeGreaterThanOrEqual(3);
		for (const args of modeCalls) {
			expect(args).toContain("props.group");
		}

		// ELK layout effect cleans up and guards stale/unmounted runs in both try & catch.
		expect(src).toContain("onCleanup(() => ++layoutRun);");
		expect(src).toContain("if (!key || !p) {\n\t\t\t\t++layoutRun;\n\t\t\t\treturn;\n\t\t\t}");
		expect(src).toMatch(/catch \(e: any\) \{\s*if \(run !== layoutRun\) return;/);

		// Text -> Chart fit() effect watches isTextMode() and layout().
		expect(src).toMatch(/createEffect\(\(\) => \{\s*if \(isTextMode\(\) \|\| !layout\(\) \|\| fitted\) return;\s*if \(fit\(\)\)/);

		// Float-bar non-editing buttons call refocus().
		const floatBarIdx = src.indexOf('class="plan-float-bar"');
		expect(floatBarIdx).toBeGreaterThan(-1);
		const floatBar = src.slice(floatBarIdx, floatBarIdx + 6500);
		expect(floatBar).toContain("reverseSelectedEdge({ from: eb.edge.from, to: eb.edge.to }), refocus()");
		expect(floatBar).toContain("resetEdgeRoute({ from: eb.edge.from, to: eb.edge.to }), refocus()");
		expect(floatBar).toContain("toggleDecision(n.id), refocus()");
		expect(floatBar).toContain("addBranchFrom(n.id), refocus()");
		expect(floatBar).toContain("resetNodePos(n.id), refocus()");
		expect(floatBar).toContain("remove(), refocus()");
		expect(floatBar).toContain("zoomToSelection(), refocus()");
		expect(floatBar).toContain("copySelection(), refocus()");

		// PlanTextView undo/redo wiring from PlanView.
		expect(src).toContain('onUndo={() => undo("undo")}');
		expect(src).toContain('onRedo={() => undo("redo")}');
	});
});

// =============================================================================
// 2. PlanAssistant.tsx — safe decisions, manual drift visibility, draft cleanup
// =============================================================================
describe("PlanAssistant.tsx — decisions guard, manual drift, draft clearing", () => {
	test("safeDecisionsOf ignores null/non-object entries and non-string fields without throwing", () => {
		const corrupted: Plan = {
			...basePlan(),
			decisions: [
				null,
				42,
				"bad",
				["array"],
				{ question: null, answer: 123 },
				{ question: 999, answer: "yes" },
				{ question: "   ", answer: "" },
				{ question: "Retry on timeout?", answer: 123, node: 456, suggested: [null, 7, "Retry once", ""] },
				{ question: "Notify supervisor?", answer: "Yes, for rush samples", node: "n2" },
			] as any,
		};

		const clean = safeDecisionsOf(corrupted);
		expect(clean).toEqual([
			{ question: "Retry on timeout?", suggested: ["Retry once"] },
			{ question: "Notify supervisor?", node: "n2", answer: "Yes, for rush samples" },
		]);
	});

	test("resolveDriftOpenAction handles built units, gone units, manual target scripts, and stage-region drift items", () => {
		const units: BuiltUnit[] = [{ name: "ApproveSample", script: "Sample/Release.ssl", nodes: ["n3"], calls: [] }];
		const targets = ["Sample/Release.ssl"];
		const nodeIds = new Set(["n1", "n2", "n3"]);

		const builtDrift: Drift = { kind: "missing-call", unit: "ApproveSample", node: "n3", severity: "warning", message: "missing" };
		expect(resolveDriftOpenAction(builtDrift, units, targets, nodeIds)).toEqual({ kind: "unit", unit: units[0]! });

		const goneDrift: Drift = { kind: "gone", unit: "ApproveSample", node: "n3", severity: "warning", message: "gone" };
		expect(resolveDriftOpenAction(goneDrift, units, targets, nodeIds)).toEqual({ kind: "node", nodeId: "n3" });

		const manualScriptDrift: Drift = { kind: "missing-call", unit: "Sample/Release.ssl", node: "n2", severity: "warning", message: "ref missing" };
		expect(resolveDriftOpenAction(manualScriptDrift, [], targets, nodeIds)).toEqual({ kind: "script", script: "Sample/Release.ssl" });

		const stageRegionDriftItem: Drift = { kind: "orphan", unit: "Review", node: "n2", severity: "info", message: "no region marker" };
		expect(resolveDriftOpenAction(stageRegionDriftItem, [], targets, nodeIds)).toEqual({ kind: "node", nodeId: "n2" });

		const unknownOrphan: Drift = { kind: "orphan", unit: "Unknown", severity: "info", message: "orphan" };
		expect(resolveDriftOpenAction(unknownOrphan, [], [], nodeIds)).toBeNull();
	});

	test("PlanAssistant shows 'Chart and code' for manual plans and clears draftReq via onConsumeDraft", () => {
		const src = readSrc("../src/view/plan/PlanAssistant.tsx");
		expect(src).toContain("<Show when={built()?.units.length || drift().checked || drift().items.length}>");
		expect(src).toContain("onConsumeDraft={() => setDraftReq(null)}");
		expect(src).toContain("safeDecisionsOf(props.plan)");
	});
});

// =============================================================================
// 3. PlanCodeDrilldown.tsx — parameter array guard & object-form plan.targets
// =============================================================================
describe("PlanCodeDrilldown.tsx — sigOf & planTargetsOf", () => {
	test("sigOf handles missing, non-array, and mixed-type parameters without throwing", () => {
		expect(sigOf({ name: "Release", parameters: ["sSampleId", "bRush"] })).toBe("Release(sSampleId, bRush)");
		expect(sigOf({ name: "Release" })).toBe("Release()");
		expect(sigOf({ name: "Release", parameters: "not-an-array" as any })).toBe("Release()");
		expect(sigOf({ name: "Release", parameters: 42 as any })).toBe("Release()");
		expect(sigOf({ name: "Release", parameters: [null, "sId", 9] as any })).toBe("Release(sId)");
	});

	test("PlanImplementation reads targets via planTargetsOf so object-form targets are preserved", () => {
		const plan: Plan = {
			...basePlan(),
			targets: ["Sample/Release.ssl", { script: "Sample/Notify.ssl", role: "helper" }],
		};
		expect(planTargetsOf(plan)).toEqual(["Sample/Release.ssl", "Sample/Notify.ssl"]);

		const src = readSrc("../src/view/plan/PlanCodeDrilldown.tsx");
		expect(src).toContain('import { planTargetsOf } from "./assist";');
		expect(src).toContain("planTargetsOf(props.plan)");
	});
});

// =============================================================================
// 4. PlanTests.tsx — script guard, draftReq reset, accurate Generate tests button
// =============================================================================
describe("PlanTests.tsx — validTestScript, draft cleanup, and Generate button copy", () => {
	test("validTestScript rejects non-string and empty built.tests.script values", () => {
		const pValid: Plan = { ...basePlan(), built: { units: [], nodes: {}, tests: { script: "tests/Approval.test.ssl", hash: "abc" } } };
		expect(validTestScript(pValid)).toEqual({ script: "tests/Approval.test.ssl", hash: "abc" });

		const pNumeric: Plan = { ...basePlan(), built: { units: [], nodes: {}, tests: { script: 123, hash: "abc" } } };
		expect(validTestScript(pNumeric)).toBeNull();

		const pEmpty: Plan = { ...basePlan(), built: { units: [], nodes: {}, tests: { script: "   ", hash: "abc" } } };
		expect(validTestScript(pEmpty)).toBeNull();

		const pMalformed: Plan = { ...basePlan(), built: { units: [], nodes: {}, tests: true } };
		expect(validTestScript(pMalformed)).toBeNull();
	});

	test("PlanTests guards tests.script, resets draftReq on save/cancel/node change/collapse, and removes stale 'Soon'/'Scheduled' copy", () => {
		const src = readSrc("../src/view/plan/PlanTests.tsx");

		// Both NodeTests and PlanTests guard tests.script before calling baseName(...)
		const scriptGuards = src.match(/typeof tests\?\.script === "string" && tests\.script\.length > 0/g) ?? [];
		expect(scriptGuards.length).toBeGreaterThanOrEqual(2);

		// TestCaseList supports onConsumeDraft and NodeTests clears draftReq on node change
		expect(src).toContain("onConsumeDraft?: () => void;");
		expect(src).toMatch(/props\.node\.id;\s*setJourneyFilter\(null\);\s*setDraftReq\(null\);/);
		expect(src).toContain("onConsumeDraft={() => setDraftReq(null)}");

		// No stale "Soon" pill or "Scheduled —" tooltip, and NodeTests forwards props.node.id
		expect(src).not.toContain("plan-sched-pill");
		expect(src).not.toContain(">Soon<");
		expect(src).not.toContain("Scheduled —");
		expect(src).toContain('kind: "tests" as const, id: props.node.id');
	});
});

// =============================================================================
// 5. PlanTextView.tsx — undo/redo forwarding, anchor detach recompute, safe saveBuilder
// =============================================================================
describe("PlanTextView.tsx — undo/redo, anchor detach, and deleted-test save recovery", () => {
	test("planTextUndoAction maps Ctrl/Cmd+Z, Ctrl+Y, and Cmd+Shift+Z only when outside editable fields", () => {
		expect(planTextUndoAction({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "z" }, false)).toBe("undo");
		expect(planTextUndoAction({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: "Z" }, false)).toBe("undo");
		expect(planTextUndoAction({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "y" }, false)).toBe("redo");
		expect(planTextUndoAction({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: true, key: "z" }, false)).toBe("redo");
		expect(planTextUndoAction({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, key: "Z" }, false)).toBe("redo");

		// Ignored when inside input/textarea/select/contenteditable or when Alt is held.
		expect(planTextUndoAction({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "z" }, true)).toBeNull();
		expect(planTextUndoAction({ ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, key: "z" }, false)).toBeNull();

		// isEditableTarget checks element.closest against form controls.
		expect(isEditableTarget(null)).toBe(false);
		expect(isEditableTarget({ closest: () => ({}) } as any)).toBe(true);
		expect(isEditableTarget({ closest: () => null } as any)).toBe(false);
	});

	test("computeAnchorDetachState immediately recomputes linkedJourney and auto-expect when detaching step anchor", () => {
		const plan = basePlan();
		const { paths } = planPaths(plan);
		expect(paths.length).toBe(4);

		// With only decision n5="no" chosen, two journeys match (via Fast track and via Standard queue), both ending at "Released".
		const detachedTwo = computeAnchorDetachState(plan, paths, { n5: "no" }, "Stale outcome", true);
		expect(detachedTwo.linkedJourney).toBeNull();
		expect(detachedTwo.expect).toBe("Released");

		// With no choices, 4 journeys match with different outcomes -> linkedJourney null and auto-expect cleared.
		const detachedAll = computeAnchorDetachState(plan, paths, {}, "Held for QA", true);
		expect(detachedAll.linkedJourney).toBeNull();
		expect(detachedAll.expect).toBe("");

		// When analyst customized expect (expectAuto = false), preserve their custom expect text while clearing stale journey.
		const detachedCustom = computeAnchorDetachState(plan, paths, {}, "Custom analyst expectation", false);
		expect(detachedCustom.linkedJourney).toBeNull();
		expect(detachedCustom.expect).toBe("Custom analyst expectation");

		// When choices alone narrow to an exact journey (n2="yes", n5="yes"), linkedJourney resolves to that exact 1-based journey.
		const detachedExact = computeAnchorDetachState(plan, paths, { n2: "yes", n5: "yes" }, "", true);
		expect(detachedExact.linkedJourney).not.toBeNull();
		expect(detachedExact.expect).toBe("Held for QA");
	});

	test("resolveBuilderSaveMode detects externally deleted tests so saveBuilder recreates instead of dropping edits", () => {
		const withTest: Plan = { ...basePlan(), tests: [{ id: "t1", title: "Rush QA hold" }] };
		const withoutTest: Plan = { ...basePlan(), tests: [{ id: "t2", title: "Other test" }] };

		expect(resolveBuilderSaveMode(withTest, null)).toBe("create");
		expect(resolveBuilderSaveMode(withTest, "t1")).toBe("update");
		expect(resolveBuilderSaveMode(withoutTest, "t1")).toBe("recreate");
	});

	test("PlanTextView source wires detachAnchor, undo/redo forwarding, and saveBuilder recreation fallback", () => {
		const src = readSrc("../src/view/plan/PlanTextView.tsx");
		expect(src).toContain('aria-label="Detach step anchor"');
		expect(src).toContain("onClick={detachAnchor}");
		expect(src).toContain("planTextUndoAction(e, isEditableTarget(e.target) || isEditableTarget(document.activeElement))");
		expect(src).toContain("resolveBuilderSaveMode(props.plan, editId)");
		expect(src).toContain('if (mode === "recreate")');
	});
});
