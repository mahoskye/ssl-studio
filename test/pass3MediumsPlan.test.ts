// Planning mode, pass 3: what the plan's hash is taken of, whether a model is known to be free, a unit left
// marked as being built, Shift+click on the chart, and the selection after an edit of several lines.
// Everything here is the plan's pure logic: no model is asked, and nothing is drawn. The build's own loop
// (the budget question, a unit that throws, an answer given while it runs) is driven with a fake backend in
// test/solid2AuditCore.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { minimalReplace } from "../src/view/lsp/edits";
import { batchOffsetPlanNodes, checkPlanDocs, legacyPlanHash, lineToKeep, marqueeMoved, marqueeNodeIds, planHash, planHashMatches, printSpec, testsHash, testsHashMatches, toggleSelection, type NodeRect } from "../src/view/plan/assist";
import { modelCostNote, modelIsLocal, newRun, nextUnit, requeueRunning } from "../src/view/plan/build";
import { builtOf, chartChanges, recordBuilt, recordTests } from "../src/view/plan/built";
import { addNodeDoc, addPlanTest, nodeAtLine, nodeLines, parsePlan, printPlan, resetPlanLayout, setEdgeLabel, setEdgeRoute, setGroup, setGroupOffset, setNodeOffset, setText, updatePlanTest, type Plan } from "../src/view/plan/model";

const plan = (): Plan =>
	parsePlan(
		JSON.stringify({
			version: 1,
			title: "Release a sample",
			goal: "Release a sample once its results are approved.",
			targets: ["Sample/Release.ssl"],
			groups: [{ id: "g1", name: "Validation" }],
			nodes: [
				{ id: "n1", kind: "start", text: "A sample id arrives" },
				{ id: "n2", kind: "step", text: "Read the sample" },
				{ id: "n3", kind: "decision", text: "Is the id usable?", group: "g1" },
				{ id: "n4", kind: "step", text: "Check the status", group: "g1", notes: "Inside a transaction." },
				{ id: "n5", kind: "call", text: "Mark the sample released", ref: "Sample.Mark" },
				{ id: "n6", kind: "step", text: "Tell the lab" },
				{ id: "n7", kind: "end", text: "Return the new status" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
				{ from: "n3", to: "n4", label: "yes" },
				{ from: "n4", to: "n5" },
				{ from: "n5", to: "n6" },
				{ from: "n6", to: "n7" },
				{ from: "n3", to: "n7", label: "no" },
			],
			decisions: [{ question: "Which table?", answer: "SAMPLES" }],
		}),
	).plan!;

/** Everything a hand can do to where the chart is drawn, without changing what it says. */
const redrawn: [string, (p: Plan) => Plan][] = [
	["a node dragged", (p) => setNodeOffset(p, "n2", { x: 120, y: -48 })],
	["a wire dragged", (p) => setEdgeRoute(p, "n5", "n6", { "1h": 24 })],
	["a node put in a stage", (p) => setGroup(p, "n6", "Telling")],
	["a node taken out of its stage", (p) => setGroup(p, "n4", "")],
	["a stage dragged", (p) => setGroupOffset(p, "g1", { x: 36, y: 12 })],
	["several nodes nudged", (p) => batchOffsetPlanNodes(p, new Set(["n3", "n5"]), 12, 0)],
	["a document linked to a node", (p) => addNodeDoc(p, "n4", "docs/knowledge/decisions/0001.md")],
];

/** What changes the words or the structure. */
const reworded: [string, (p: Plan) => Plan][] = [
	["a node's words", (p) => setText(p, "n2", "Read the sample and its results")],
	["a node's notes", (p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === "n6" ? { ...n, notes: "By e-mail." } : n)) })],
	["what a call node calls", (p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === "n5" ? { ...n, ref: "Sample.Release" } : n)) })],
	["a node's kind", (p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === "n6" ? { ...n, kind: "decision" as const } : n)) })],
	["a branch's label", (p) => setEdgeLabel(p, "n3", "n7", "otherwise")],
	["a way on added", (p) => ({ ...p, edges: [...p.edges, { from: "n4", to: "n7" }] })],
	["a node added", (p) => ({ ...p, nodes: [...p.nodes, { id: "n8", kind: "step" as const, text: "Log it" }] })],
	["the title", (p) => ({ ...p, title: "Release two samples" })],
	["the goal", (p) => ({ ...p, goal: "Something else." })],
	["an answer", (p) => ({ ...p, decisions: [{ question: "Which table?", answer: "ORDERS" }] })],
];

describe("the plan's hash is of what the plan says, not of where it is drawn", () => {
	for (const [name, change] of redrawn) {
		test(`${name} leaves it as it was`, () => {
			const moved = change(plan());
			expect(printPlan(moved)).not.toBe(printPlan(plan()));
			expect(planHash(moved)).toBe(planHash(plan()));
			// And through the plan's text, as the app reads it.
			expect(planHash(parsePlan(printPlan(moved)).plan!)).toBe(planHash(plan()));
		});
	}
	for (const [name, change] of reworded) {
		test(`${name} changes it`, () => {
			expect(planHash(change(plan()))).not.toBe(planHash(plan()));
		});
	}
	test("going back to auto-layout after dragging leaves it as it was", () => {
		const dragged = setEdgeRoute(setNodeOffset(plan(), "n2", { x: 120, y: -48 }), "n5", "n6", { "1h": 24 });
		expect(planHash(resetPlanLayout(dragged))).toBe(planHash(plan()));
	});
	test("recording a build, or the test script, does not change it", () => {
		const built = recordBuilt(plan(), [{ name: "Tell", script: "Sample/Release.ssl", nodes: ["n6"], status: "passed", attempts: 1 }], [{ name: "Tell", nodes: ["n6"] }]);
		expect(planHash(recordTests(built, "Sample/ReleaseTests.ssl"))).toBe(planHash(plan()));
	});
});

describe("a hash stored before layout was left out of it still reads as current", () => {
	// The plan as it stood when its doc, its build and its tests were written: a node already dragged, a stage in use.
	const then = () => setNodeOffset(plan(), "n3", { x: 24, y: 12 });
	const stored = () => legacyPlanHash(then());

	test("the older hash is what was stored: whole nodes and edges, layout included", () => {
		const p = then();
		// The function as it was, written out again here: a stored hash can only be matched by making it the same way.
		let hash = 5381;
		const text = JSON.stringify([p.title, p.goal, p.nodes, p.edges, [["Which table?", "SAMPLES"]]]);
		for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
		expect(legacyPlanHash(p)).toBe(hash.toString(16));
		expect(legacyPlanHash(p)).not.toBe(planHash(p));
	});
	test("a plan doc, a build run and a test script that hold it are current", () => {
		const p = then();
		expect(planHashMatches(stored(), p)).toBe(true);
		expect(checkPlanDocs(p, { specText: printSpec("The spec", [], [], stored()) }).map((f) => f.code)).not.toContain("plan-stale-spec");
		// A run of this very chart: what it has not reached is not shown as a change.
		const built = recordBuilt(p, [{ name: "Tell", script: "Sample/Release.ssl", nodes: ["n6"], status: "passed", attempts: 1 }], [{ name: "Tell", nodes: ["n6"] }]);
		const reworked = setText(built, "n6", "Tell the lab by e-mail");
		expect(chartChanges(reworked, newRun({ hash: legacyPlanHash(reworked), model: "m" }, [], [])).changed).toEqual([]);
		expect(chartChanges(reworked, newRun({ hash: stored(), model: "m" }, [], [])).changed).toEqual(["n6"]);
		expect(testsHashMatches(stored(), p)).toBe(true);
	});
	test("after a node is dragged the new hash is unchanged, and what is written from then on stays current", () => {
		const p = then();
		const dragged = setNodeOffset(p, "n5", { x: 60, y: 0 });
		expect(planHash(dragged)).toBe(planHash(p));
		expect(planHashMatches(planHash(p), dragged)).toBe(true);
		expect(testsHashMatches(testsHash(p), dragged)).toBe(true);
	});
	test("an older hash of a plan nothing had been moved in survives the first drag", () => {
		const untouched = plan();
		const old = legacyPlanHash(untouched);
		const dragged = setEdgeRoute(setNodeOffset(untouched, "n5", { x: 60, y: 0 }), "n1", "n2", { "1h": 12 });
		expect(legacyPlanHash(dragged)).not.toBe(old);
		expect(planHashMatches(old, dragged)).toBe(true);
		expect(testsHashMatches(old, dragged)).toBe(true);
	});
	test("after the words change, neither kind matches", () => {
		const p = then();
		const changed = setText(p, "n2", "Read the sample and its results");
		expect(planHash(changed)).not.toBe(planHash(p));
		expect(legacyPlanHash(changed)).not.toBe(legacyPlanHash(p));
		expect(planHashMatches(stored(), changed)).toBe(false);
		expect(planHashMatches(planHash(p), changed)).toBe(false);
		expect(checkPlanDocs(changed, { specText: printSpec("The spec", [], [], stored()) }).map((f) => f.code)).toContain("plan-stale-spec");
		expect(checkPlanDocs(changed, { specText: printSpec("The spec", [], [], planHash(p)) }).map((f) => f.code)).toContain("plan-stale-spec");
	});
	test("no hash at all matches nothing", () => {
		expect(planHashMatches(null, plan())).toBe(false);
		expect(planHashMatches("", plan())).toBe(false);
		expect(testsHashMatches(undefined, plan())).toBe(false);
	});
});

describe("the test script is compared with the plan and the test cases it was written from", () => {
	const withCase = () => addPlanTest(plan(), { title: "A sample on hold is not released", node: "n3", given: "The sample is on hold", expect: "Nothing is released" });

	test("it is recorded against both", () => {
		const p = recordTests(withCase(), "Sample/ReleaseTests.ssl");
		expect(builtOf(p)!.tests).toEqual({ script: "Sample/ReleaseTests.ssl", hash: testsHash(withCase()) });
		expect(testsHashMatches(builtOf(p)!.tests!.hash, p)).toBe(true);
	});
	test("a test case added, changed or taken away makes the script out of date, and not the plan doc or the build", () => {
		const recorded = builtOf(recordTests(withCase(), "T.ssl"))!.tests!.hash;
		const added = addPlanTest(withCase(), { title: "An unknown id is refused" });
		const changed = updatePlanTest(withCase(), "t1", { expect: "The sample stays on hold" });
		for (const p of [added, changed, plan()]) {
			expect(testsHashMatches(recorded, p)).toBe(false);
			expect(planHash(p)).toBe(planHash(plan()));
		}
	});
	test("dragging a node does not make the script out of date", () => {
		const recorded = builtOf(recordTests(withCase(), "T.ssl"))!.tests!.hash;
		expect(testsHashMatches(recorded, setNodeOffset(withCase(), "n2", { x: 120, y: -48 }))).toBe(true);
	});
	test("a change to the chart's words makes it out of date", () => {
		const recorded = builtOf(recordTests(withCase(), "T.ssl"))!.tests!.hash;
		expect(testsHashMatches(recorded, setText(withCase(), "n2", "Read it"))).toBe(false);
	});
});

describe("whether a model is known to cost nothing", () => {
	const models = [
		{ providerID: "ollama", id: "qwen3:14b", local: true },
		{ providerID: "openrouter", id: "some/paid-model", local: false },
	];
	test("a model opencode has not listed is not known to be local: the list is empty until opencode has started", () => {
		expect(modelIsLocal([], "openrouter/some/paid-model")).toBe(false);
		// A local provider's model is local by its name, before opencode has listed anything: the backend's own rule.
		expect(modelIsLocal([], "ollama/qwen3:14b")).toBe(true);
		expect(modelCostNote([], "ollama/qwen3:14b")).toBeNull();
		expect(modelIsLocal([], "acme/own-model")).toBe(false);
		expect(modelIsLocal([], "acme/own-model", ["Acme/Own-Model"])).toBe(true);
		expect(modelIsLocal(models, "openrouter/another-model")).toBe(false);
	});
	test("a listed model is local when the list says so", () => {
		expect(modelIsLocal(models, "ollama/qwen3:14b")).toBe(true);
		expect(modelIsLocal(models, "openrouter/some/paid-model")).toBe(false);
	});
	test("names are compared as opencode compares them", () => {
		expect(modelIsLocal(models, " Ollama/QWEN3:14b ")).toBe(true);
		expect(modelIsLocal(models, "")).toBe(false);
	});
	test("the assistant's note warns of a model before opencode has listed any, and says what it knows", () => {
		expect(modelCostNote([], "openrouter/some/paid-model")?.words).toBe("may cost money");
		expect(modelCostNote([], "openrouter/some/paid-model")?.why).toContain("has not started");
		expect(modelCostNote(models, "openrouter/another-model")?.words).toBe("may cost money");
		expect(modelCostNote(models, "openrouter/another-model")?.why).toContain("does not list");
		expect(modelCostNote(models, "openrouter/some/paid-model")?.words).toBe("paid model");
		expect(modelCostNote(models, "ollama/qwen3:14b")).toBeNull();
		// No model chosen: opencode takes a local one or refuses the turn, so there is nothing to warn of.
		expect(modelCostNote([], "")).toBeNull();
	});
});

describe("a unit left marked as being built", () => {
	const run = () => {
		const r = newRun({ hash: "h", model: "m" }, [{ name: "Mark" }, { name: "Notify" }, { name: "Release", calls: ["Mark"] }], []);
		r.units[0]!.status = "passed";
		r.units[1]!.status = "running";
		return r;
	};
	test("is never taken up while it is marked, so the run ends around it", () => {
		const r = run();
		expect(nextUnit(r)?.name).toBe("Release");
		r.units[2]!.status = "passed";
		expect(nextUnit(r)).toBeNull();
		expect(r.units[1]!.status).toBe("running");
	});
	test("goes back to waiting when a build starts, and is built", () => {
		const r = run();
		expect(requeueRunning(r)).toBe(true);
		expect(r.units.map((u) => u.status)).toEqual(["passed", "pending", "pending"]);
		expect(nextUnit(r)?.name).toBe("Notify");
		expect(requeueRunning(r)).toBe(false);
	});
});

describe("Shift+click on the chart", () => {
	const boxes: NodeRect[] = [
		{ id: "a", x: 0, y: 0, width: 100, height: 40 },
		{ id: "b", x: 0, y: 100, width: 100, height: 40 },
	];
	test("adds a node to what is selected", () => {
		const { ids, lead } = toggleSelection(new Set(["a"]), "b");
		expect([...ids].sort()).toEqual(["a", "b"]);
		expect(lead).toBe("b");
	});
	test("takes just that node out when it was selected", () => {
		const { ids, lead } = toggleSelection(new Set(["a", "b"]), "b");
		expect([...ids]).toEqual(["a"]);
		expect(lead).toBe("a");
		expect(toggleSelection(new Set(["b"]), "b")).toEqual({ ids: new Set(), lead: null });
	});
	test("leaves the set it was given alone", () => {
		const current = new Set(["a"]);
		toggleSelection(current, "b");
		expect([...current]).toEqual(["a"]);
	});
	test("a press that never moved is no marquee: the marquee it would have been takes the click's node, and the click takes it out again", () => {
		const press = { x: 50, y: 120 };
		expect(marqueeMoved(press, press)).toBe(false);
		expect(marqueeMoved(press, { x: 52, y: 122 })).toBe(false);
		expect(marqueeMoved(press, { x: 50, y: 126 })).toBe(true);
		expect(marqueeMoved(press, { x: 10, y: 10 })).toBe(true);
		// What went wrong: with "a" selected, Shift+click on "b" ran a marquee of no size and then the click.
		const asMarquee = new Set(marqueeNodeIds(boxes, { x: press.x, y: press.y, width: 0, height: 0 }));
		expect([...asMarquee]).toEqual(["b"]);
		expect(toggleSelection(asMarquee, "b").ids.size).toBe(0);
		// Left to the click alone, it adds.
		expect([...toggleSelection(new Set(["a"]), "b").ids].sort()).toEqual(["a", "b"]);
	});
});

describe("the selection after an edit of several lines", () => {
	const lineStart = (text: string, line: number) => {
		let at = 0;
		for (let l = 1; l < line; l++) at = text.indexOf("\n", at) + 1;
		return at;
	};
	const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;
	/**
	 * Where the editor leaves a cursor that stood at the start of `line` when `applyText` replaces the text: the one
	 * replace is the app's own (`minimalReplace`), and the cursor is moved by the editor's own marker arithmetic (an
	 * internal file of monaco-editor, with no imports of its own). When that file is not where it was, null: the tests
	 * below then show only that the cursor is put back, not that it had moved.
	 */
	const cursorAfter = async (before: string, after: string, line: number): Promise<number | null> => {
		const file = "../node_modules/monaco-editor/esm/vs/editor/common/model/intervalTree.js";
		const tree: any = await import(file).catch(() => null);
		if (!tree?.IntervalNode || !tree?.nodeAcceptEdit) return null;
		const edit = minimalReplace(before, after)!;
		const node = new tree.IntervalNode(null, 0, 0);
		node.start = node.end = lineStart(before, line);
		node.metadata = 0;
		tree.nodeAcceptEdit(node, edit.start, edit.end, edit.text.length, false);
		return lineOf(after, node.start);
	};

	test("after auto-layout the cursor goes back to the node that was selected", async () => {
		let p = plan();
		for (const id of ["n2", "n3", "n4"]) p = setNodeOffset(p, id, { x: 120, y: -48 });
		p = setEdgeRoute(p, "n5", "n6", { "1h": 24 });
		const before = printPlan(p);
		const next = resetPlanLayout(p);
		const after = printPlan(next);
		const selectedLine = nodeLines(before, p).get("n6")!;
		expect(nodeAtLine(before, p, selectedLine)).toBe("n6");
		const left = await cursorAfter(before, after, selectedLine);
		if (left !== null) expect(nodeAtLine(after, next, left)).toBe("n7");
		const line = lineToKeep(after, next, "n6")!;
		expect(nodeAtLine(after, next, line)).toBe("n6");
	});
	test("after several nodes are nudged the cursor is still on one of them, so the selection of several stands", async () => {
		const p = plan();
		const before = printPlan(p);
		const next = batchOffsetPlanNodes(p, new Set(["n3", "n5"]), 12, 0);
		const after = printPlan(next);
		const selectedLine = nodeLines(before, p).get("n5")!;
		const left = await cursorAfter(before, after, selectedLine);
		if (left !== null) expect(nodeAtLine(after, next, left)).toBe("n4");
		expect(nodeAtLine(after, next, lineToKeep(after, next, "n5")!)).toBe("n5");
	});
	test("nothing selected, or a node that is gone, moves no cursor", () => {
		const p = plan();
		expect(lineToKeep(printPlan(p), p, null)).toBeNull();
		expect(lineToKeep(printPlan(p), p, "n99")).toBeNull();
	});
});

// The chart's own handlers live inside the PlanView component and run only against a DOM, which these tests do
// not have. What they call (`toggleSelection`, `marqueeMoved`, `lineToKeep`) is tested above; this only says that
// they call it, read from the source. It proves no behaviour: the steps to look at are in the pass's report.
describe("PlanView's handlers use them (read from the source: they cannot be run without a DOM)", () => {
	const source = readFileSync(join(import.meta.dir, "../src/view/plan/PlanView.tsx"), "utf8");
	const between = (from: string, to: string) => {
		const [start, end] = [source.indexOf(from), source.indexOf(to, source.indexOf(from))];
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return source.slice(start, end);
	};

	test("every edit made from the chart goes through the one place that puts the cursor back", () => {
		// `apply` and the paste, which selects what it pasted.
		expect(source.match(/applyText\(props\.path,/g)?.length).toBe(2);
		const apply = between("const apply = (next: Plan, selectId?: string | null) => {", "const applyEdit = ");
		expect(apply).toContain("const lead = selected();");
		expect(apply).toContain("lineToKeep(printed, next, lead)");
		expect(apply).toContain("if (multi.size > 1) setSelectedIds(multi);");
	});
	test("a marquee that never moved selects nothing, and Shift+click toggles", () => {
		const marquee = between("const startMarqueeDrag = (e: MouseEvent) => {", "\n\treturn (\n");
		expect(marquee).toContain("moved = moved || marqueeMoved(pressed, { x: ev.clientX, y: ev.clientY });");
		expect(marquee.indexOf("if (!moved) {")).toBeGreaterThan(-1);
		expect(marquee.indexOf("if (!moved) {")).toBeLessThan(marquee.indexOf("marqueeNodeIds(nodeRects()"));
		expect(between("const toggleSelectNode = (id: string) => {", "const nodeRects = ")).toContain("toggleSelection(activeSelectedIds(), id)");
	});
});
