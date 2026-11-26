// Planning mode and the Palette, pass 3, the low findings: a paste into another plan, a wire dropped on a
// suggested node, a build carried on past its budget, the label of a decision's next way out, the "Build in Text"
// request, the script a build may write, what a test script is recorded against, and a Palette field's text
// when the selection moves on before the field is left.
// Everything here is run: the plan's pure logic, and two small pieces of state the views are built on
// (`builderRequests` and `pendingField`, under Solid's own runtime). No model is asked anything, and nothing is
// drawn. What the views do with these is read from the source in the last block, and proves no behaviour.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, createSignal, flush } from "solid-js";
import { applySuggestion, copyPlanSelection, copySteps, hasCopiedSteps, parseSuggestions, pastePlanSelection, pasteSteps, previewPlan, testsHash, testsHashMatches } from "../src/view/plan/assist";
import { cutShort, DEFAULT_TOKEN_BUDGET, MAX_ATTEMPTS, newRun, nextCostBudget, nextStep, overBudget, raiseBudget, readCostBudget, scriptOf, scriptProblem, spentUp, unwritableUnit, type BuildRun } from "../src/view/plan/build";
import { builtOf, recordTests } from "../src/view/plan/built";
import { nodeUnder } from "../src/view/plan/chart";
import { addBranch, addPlanTest, checkPlan, connect, parsePlan, printPlan, removeEdge, setNodeOffset, setText, type Plan } from "../src/view/plan/model";
import { builderRequests, pendingField } from "../src/view/plan/planBridge";

const planOf = (rest: Record<string, unknown>): Plan => parsePlan(JSON.stringify({ version: 1, title: "A plan", groups: [], ...rest })).plan!;
const stageOf = (plan: Plan, id: string) => plan.groups.find((g) => g.id === plan.nodes.find((n) => n.id === id)?.group)?.name ?? null;

// --- 1. a paste into another plan --------------------------------------------------------------------------

describe("steps pasted into another plan", () => {
	const A = "/ws/design/Intake.plan.json";
	const B = "/ws/design/Billing.plan.json";
	// Both plans call their only stage g1, as every plan does: ids are counted from one in each.
	const intake = () =>
		planOf({
			groups: [{ id: "g1", name: "Validation" }],
			nodes: [
				{ id: "n1", kind: "start", text: "A sample arrives" },
				{ id: "n2", kind: "step", text: "Check the id", group: "g1", offset: { x: 120, y: -48 } },
				{ id: "n3", kind: "step", text: "Check the status", group: "g1", notes: "Inside a transaction." },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3", label: "then", route: { "1h": 24 } },
			],
		});
	const billing = (stage = "Billing") =>
		planOf({
			groups: [{ id: "g1", name: stage }],
			nodes: [
				{ id: "n1", kind: "start", text: "An order closes" },
				{ id: "n2", kind: "step", text: "Raise the invoice", group: "g1" },
			],
			edges: [{ from: "n1", to: "n2" }],
		});
	const pick = new Set(["n2", "n3"]);

	test("do not land in the stage that happens to share an id with the one they came from", () => {
		expect(copySteps(intake(), pick, A)?.nodes.length).toBe(2);
		expect(hasCopiedSteps()).toBe(true);
		const pasted = pasteSteps(billing(), B)!;
		expect(pasted.pastedIds.length).toBe(2);
		for (const id of pasted.pastedIds) expect(stageOf(pasted.plan, id)).toBeNull();
		// The other plan's own stage and its step are as they were.
		expect(pasted.plan.groups).toEqual([{ id: "g1", name: "Billing" }]);
		expect(stageOf(pasted.plan, "n2")).toBe("Billing");
		expect(checkPlan(pasted.plan).filter((f) => f.code === "plan-unknown-group")).toEqual([]);
	});

	test("join the stage of the same name where the other plan has one", () => {
		copySteps(intake(), pick, A);
		const pasted = pasteSteps(billing("validation"), B)!;
		for (const id of pasted.pastedIds) expect(stageOf(pasted.plan, id)).toBe("validation");
	});

	test("leave the first plan's layout behind, and keep their words, notes and the way between them", () => {
		copySteps(intake(), pick, A);
		const pasted = pasteSteps(billing(), B)!;
		const [first, second] = pasted.pastedIds.map((id) => pasted.plan.nodes.find((n) => n.id === id)!);
		expect(first).toEqual({ id: first!.id, kind: "step", text: "Check the id" });
		expect(second).toEqual({ id: second!.id, kind: "step", text: "Check the status", notes: "Inside a transaction." });
		expect(pasted.plan.edges.at(-1)).toEqual({ from: first!.id, to: second!.id, label: "then" });
		// Fresh ids, and the plan still reads back from its text.
		expect(new Set(pasted.plan.nodes.map((n) => n.id)).size).toBe(pasted.plan.nodes.length);
		expect(parsePlan(printPlan(pasted.plan)).plan).toEqual(pasted.plan);
	});

	test("a paste back into the plan they were copied from is as it was: the same stage, a little off the original", () => {
		const before = pastePlanSelection(intake(), copyPlanSelection(intake(), pick)!, "DOWN");
		copySteps(intake(), pick, A);
		const pasted = pasteSteps(intake(), A, "DOWN")!;
		expect(pasted).toEqual(before);
		const [first, second] = pasted.pastedIds.map((id) => pasted.plan.nodes.find((n) => n.id === id)!);
		expect(stageOf(pasted.plan, first!.id)).toBe("Validation");
		expect(first!.offset).toEqual({ x: 156, y: -12 });
		expect(second!.offset).toEqual({ x: 36, y: 36 });
	});

	test("with no plan said, the helper takes the paste for one into the same plan, and still does not go by the stage's id alone", () => {
		// This is how the chart called it. The step went to "Billing", which only shares an id with "Validation": since pass 4 the stage's name is compared too.
		const pasted = pastePlanSelection(billing(), copyPlanSelection(intake(), new Set(["n2"]))!, "DOWN");
		expect(stageOf(pasted.plan, pasted.pastedIds[0]!)).toBeNull();
	});

	test("nothing to copy copies nothing, and what was copied before stays", () => {
		copySteps(intake(), pick, A);
		expect(copySteps(intake(), new Set(["no-such-node"]), A)).toBeNull();
		expect(pasteSteps(billing(), B)!.pastedIds.length).toBe(2);
	});
});

// --- 2. a wire dropped on a suggested node -----------------------------------------------------------------

describe("a wire dropped on a node the assistant only suggests", () => {
	const base = () =>
		planOf({
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "end", text: "Done" },
			],
			edges: [{ from: "n1", to: "n2" }],
		});
	const suggested = () => parseSuggestions(JSON.stringify({ nodes: [{ id: "a", kind: "step", text: "Tell the lab" }], edges: [{ from: "n1", to: "a" }] }), base());
	const drawn = () => previewPlan(base(), suggested());
	const pendingId = () => drawn().nodes.find((n) => n.pending)!.id;

	test("writes no edge: the plan's text never holds an edge whose end is missing", () => {
		const plan = base();
		expect(plan.nodes.some((n) => n.id === pendingId())).toBe(false);
		const wired = connect(plan, "n1", pendingId());
		expect(wired).toBe(plan);
		expect(checkPlan(wired).filter((f) => f.code === "plan-bad-edge")).toEqual([]);
		// From a node that is not there, the same.
		expect(connect(plan, pendingId(), "n2")).toBe(plan);
		expect(connect(plan, "n1", "nowhere")).toBe(plan);
	});

	test("a wire between two nodes of the plan is still written, with a decision's label", () => {
		const plan = planOf({
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "decision", text: "Usable?" },
				{ id: "n3", kind: "end", text: "Done" },
			],
			edges: [{ from: "n1", to: "n2" }],
		});
		expect(connect(plan, "n2", "n3").edges.at(-1)).toEqual({ from: "n2", to: "n3", label: "yes" });
		expect(connect(plan, "n1", "n3").edges.at(-1)).toEqual({ from: "n1", to: "n3" });
	});

	test("once the suggestion is accepted, the step can be connected to under the id it was given", () => {
		const ids = new Map<string, string>();
		const accepted = applySuggestion(base(), suggested()[0]!, ids)!;
		const real = ids.get(pendingId())!;
		const wired = connect(accepted, "n1", real);
		expect(wired.edges.at(-1)).toEqual({ from: "n1", to: real });
		expect(checkPlan(wired).filter((f) => f.code === "plan-bad-edge")).toEqual([]);
	});

	test("the drag is told what it is over: a node of the plan, or one that is only suggested", () => {
		const nodes = drawn().nodes;
		const boxes = [
			// A stage's frame has no node: it is never what a wire lands on.
			{ id: "g1", x: 0, y: 0, width: 400, height: 400 },
			{ id: "n1", x: 10, y: 10, width: 100, height: 40, node: nodes[0]! },
			{ id: "n2", x: 10, y: 200, width: 100, height: 40, node: nodes[1]! },
			{ id: pendingId(), x: 200, y: 100, width: 100, height: 40, node: nodes[2]! },
		];
		expect(nodeUnder(boxes, { x: 250, y: 120 })).toEqual({ id: pendingId(), suggested: true });
		expect(nodeUnder(boxes, { x: 60, y: 220 })).toEqual({ id: "n2", suggested: false });
		// A little outside the box still counts, and the node the wire starts from does not.
		expect(nodeUnder(boxes, { x: 114, y: 30 })).toEqual({ id: "n1", suggested: false });
		expect(nodeUnder(boxes, { x: 60, y: 30 }, "n1")).toBeNull();
		expect(nodeUnder(boxes, { x: 350, y: 350 })).toBeNull();
		expect(nodeUnder([], { x: 0, y: 0 })).toBeNull();
	});
});

// --- 3. a build stopped at its budget ----------------------------------------------------------------------

describe("a build stopped at its budget", () => {
	const units = [
		{ name: "Mark", script: "Sample/Release.ssl", nodes: ["n2"], calls: [] },
		{ name: "Notify", script: "Sample/Release.ssl", nodes: ["n3"], calls: ["Mark"] },
		{ name: "Log", script: "Sample/Release.ssl", nodes: ["n4"], calls: [] },
	];
	/** Mark has passed, at a cost over the budget of 1; the other two wait. */
	const stopped = (): BuildRun => {
		const run = newRun({ hash: "h", model: "openrouter/paid-model" }, units, [], { cost: 1 });
		Object.assign(run.units[0]!, { status: "passed", code: ":PROCEDURE Mark;\n:ENDPROC;", attempts: 1 });
		run.cost = 1.5;
		run.tokens = 30_000;
		run.status = "budget";
		return run;
	};

	test("stops with a unit waiting, and says which budget it must be given more of", () => {
		const run = stopped();
		expect(overBudget(run)).toBe(true);
		expect(nextStep(run)).toEqual({ ends: "budget" });
		expect(spentUp(run)).toEqual({ cost: true, tokens: false });
		const tokens = { ...stopped(), cost: 0, tokens: DEFAULT_TOKEN_BUDGET, budget: { tokens: DEFAULT_TOKEN_BUDGET } };
		expect(spentUp(tokens)).toEqual({ cost: false, tokens: true });
		expect(spentUp({ ...stopped(), tokens: DEFAULT_TOKEN_BUDGET + 1 })).toEqual({ cost: true, tokens: true });
	});

	test("carried on with the budget it had, it would stop again at once: that is why it is asked", () => {
		const run = stopped();
		// What starting it again used to do: nothing was raised, so the first step was to stop.
		expect(nextStep(run)).toEqual({ ends: "budget" });
		expect(run.units.map((u) => u.status)).toEqual(["passed", "pending", "pending"]);
	});

	test("given more, it goes on with the units not built yet, and what passed is not built again", () => {
		const run = stopped();
		raiseBudget(run, { cost: 5 });
		expect(run.budget).toEqual({ cost: 5, tokens: DEFAULT_TOKEN_BUDGET });
		expect(spentUp(run)).toBeNull();
		const built: string[] = [];
		for (let step = nextStep(run); "unit" in step; step = nextStep(run)) {
			built.push(step.unit.name);
			step.unit.status = "passed";
		}
		expect(built).toEqual(["Notify", "Log"]);
		expect(nextStep(run)).toEqual({ ends: "built" });
		expect(run.units[0]).toMatchObject({ name: "Mark", status: "passed", attempts: 1, code: ":PROCEDURE Mark;\n:ENDPROC;" });
	});

	test("a yes to more tokens gives it another budget of them on top of what it has used", () => {
		const run = { ...stopped(), cost: 0, tokens: 412_345, budget: { tokens: DEFAULT_TOKEN_BUDGET } };
		raiseBudget(run, { tokens: true });
		expect(run.budget.tokens).toBe(412_345 + DEFAULT_TOKEN_BUDGET);
		expect(overBudget(run)).toBe(false);
		// Only what was agreed to is raised.
		const both = { ...stopped(), tokens: DEFAULT_TOKEN_BUDGET };
		raiseBudget(both, { tokens: true });
		expect(spentUp(both)).toEqual({ cost: true, tokens: false });
		raiseBudget(both, {});
		expect(both.budget.cost).toBe(1);
	});

	test("the budget offered is above what is spent, and one typed is taken only when it is", () => {
		expect(nextCostBudget(stopped())).toBe(2);
		// One turn took it far past its budget: twice the budget would stop it again at once.
		expect(nextCostBudget({ ...stopped(), cost: 2.5 })).toBe(3.5);
		expect(nextCostBudget({ ...stopped(), cost: 1.03, budget: { cost: 0.5, tokens: 1 } })).toBe(1.53);
		for (const run of [stopped(), { ...stopped(), cost: 2.5 }, { ...stopped(), cost: 40, budget: { cost: 0.001, tokens: 1 } }]) expect(nextCostBudget(run)).toBeGreaterThan(run.cost);
		expect(readCostBudget("5", 1.5)).toBe(5);
		expect(readCostBudget(" 2.25 ", 1.5)).toBe(2.25);
		for (const typed of ["1.5", "1", "0", "-3", "", "   ", "a lot", "Infinity"]) expect(readCostBudget(typed, 1.5)).toBeNull();
		expect(readCostBudget("1")).toBe(1);
	});

	test("with nothing left to build it is built, whatever it spent, and is asked for nothing", () => {
		const run = stopped();
		for (const unit of run.units) unit.status = "passed";
		expect(overBudget(run)).toBe(true);
		expect(nextStep(run)).toEqual({ ends: "built" });
		expect(spentUp(run)).toBeNull();
		// Nothing waiting, only a stuck unit and what waits on it: nothing to spend more on until it is tried again.
		const stuck = stopped();
		stuck.units[1]!.status = "stuck";
		stuck.units[2]!.status = "passed";
		expect(spentUp(stuck)).toBeNull();
		stuck.units[1]!.status = "pending";
		expect(spentUp(stuck)).toEqual({ cost: true, tokens: false });
	});

	test("a unit the budget ran out on, with tries still to come, is not stuck", () => {
		const run = stopped();
		expect(cutShort(run, 1)).toBe(true);
		expect(cutShort(run, MAX_ATTEMPTS - 1)).toBe(true);
		// It has had its tries: then it is stuck, budget or no budget.
		expect(cutShort(run, MAX_ATTEMPTS)).toBe(false);
		raiseBudget(run, { cost: 5 });
		expect(cutShort(run, 1)).toBe(false);
	});

	test("within its budget a run is asked nothing and builds the next unit", () => {
		const run = newRun({ hash: "h", model: "ollama/qwen3" }, units, []);
		expect(spentUp(run)).toBeNull();
		expect(nextStep(run)).toMatchObject({ unit: { name: "Mark" } });
	});
});

// --- 4a. the label of a decision's next way out ------------------------------------------------------------

describe("the label given to a decision's next way out", () => {
	const decision = () =>
		planOf({
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "decision", text: "Which kind?" },
				...["a", "b", "c", "d", "e", "f"].map((id) => ({ id, kind: "step", text: id })),
			],
			edges: [{ from: "n1", to: "n2" }],
		});
	const labels = (plan: Plan) => plan.edges.filter((e) => e.from === "n2").map((e) => e.label);
	const unique = (plan: Plan) => expect(new Set(labels(plan).map((l) => String(l).trim().toLowerCase())).size).toBe(labels(plan).length);

	test("is counted on as before while nothing has been removed", () => {
		let plan = decision();
		for (const to of ["a", "b", "c", "d"]) plan = connect(plan, "n2", to);
		expect(labels(plan)).toEqual(["yes", "no", "option 3", "option 4"]);
	});

	test("is never one a way out already has, after one was removed", () => {
		let plan = decision();
		for (const to of ["a", "b", "c", "d"]) plan = connect(plan, "n2", to);
		plan = connect(removeEdge(plan, "n2", "c"), "n2", "e");
		expect(labels(plan)).toEqual(["yes", "no", "option 4", "option 5"]);
		plan = connect(removeEdge(plan, "n2", "a"), "n2", "f");
		expect(labels(plan)).toEqual(["no", "option 4", "option 5", "yes"]);
		unique(plan);
	});

	test("a branch added from the chart gets one of its own too", () => {
		let plan = decision();
		for (const to of ["a", "b", "c", "d"]) plan = connect(plan, "n2", to);
		plan = addBranch(removeEdge(plan, "n2", "c"), "n2")!.plan;
		unique(plan);
		expect(labels(plan).at(-1)).toBe("option 5");
	});

	test("a label typed with other capitals or spaces around it counts as taken", () => {
		const plan = planOf({
			nodes: [
				{ id: "n2", kind: "decision", text: "Which kind?" },
				{ id: "a", kind: "step", text: "a" },
				{ id: "b", kind: "step", text: "b" },
				{ id: "c", kind: "step", text: "c" },
			],
			edges: [
				{ from: "n2", to: "a", label: " Yes " },
				{ from: "n2", to: "b", label: "Option 3" },
			],
		});
		expect(connect(plan, "n2", "c").edges.at(-1)?.label).toBe("no");
		expect(connect(connect(plan, "n2", "c"), "n2", "n2").edges.length).toBe(3);
		const next = planOf({ ...plan, nodes: [...plan.nodes, { id: "d", kind: "step", text: "d" }], edges: [...plan.edges, { from: "n2", to: "c", label: "NO" }] });
		expect(connect(next, "n2", "d").edges.at(-1)?.label).toBe("option 4");
	});
});

// --- 4b. "Build in Text" -----------------------------------------------------------------------------------

describe('a "Build in Text" request', () => {
	test("is handed to the text view once: a text view built later finds none", () => {
		const builder = builderRequests();
		expect(builder.pending()).toBeNull();
		builder.ask({ nodeId: "n3" });
		flush();
		// The text view the plan was switched to reads it, opens its builder, and says it has taken it.
		const first = builder.pending()!;
		expect(first).toMatchObject({ nodeId: "n3" });
		builder.taken(first);
		flush();
		// Chart, then Text again: the next text view is built with nothing to open.
		expect(builder.pending()).toBeNull();
	});

	test("the same request made again is a new one", () => {
		const builder = builderRequests();
		builder.ask({ journeyIndex: 2 });
		flush();
		const first = builder.pending()!;
		builder.taken(first);
		builder.ask({ journeyIndex: 2 });
		flush();
		expect(builder.pending()).toMatchObject({ journeyIndex: 2 });
		expect(builder.pending()!.seq).not.toBe(first.seq);
	});

	test("one made since is not thrown away with the one that was taken", () => {
		const builder = builderRequests();
		builder.ask({ nodeId: "n3" });
		flush();
		const first = builder.pending()!;
		builder.ask({ testId: "t1" });
		flush();
		builder.taken(first);
		flush();
		expect(builder.pending()).toMatchObject({ testId: "t1" });
	});

	test("with nothing said it opens a fresh builder", () => {
		const builder = builderRequests();
		builder.ask();
		flush();
		expect(builder.pending()).toEqual({ seq: 1 });
	});
});

// --- 4c. the script a build may write ----------------------------------------------------------------------

describe("the script a build may write", () => {
	const plan = () => planOf({ title: "Release a sample", targets: ["Sample/Release.ssl"], nodes: [{ id: "n1", kind: "start", text: "Start" }], edges: [] });

	test("is an SSL file in the workspace's own folders", () => {
		for (const script of ["Release.ssl", "Sample/Release.ssl", "Sample\\Release.ssl", "./Sample/Release.ssl", "scripts/server/Release.srvscr", "data/Samples.ds", "Sample/Release.SSL", "Sample/Release.ssl.txt", "a.b/Release.ssl"]) expect(scriptProblem(script)).toBeNull();
	});

	test("is not a hidden file, nor in a hidden folder", () => {
		for (const script of [".git/hooks/pre-commit.ssl", ".git/hooks/pre-commit", ".ssl-studio/plans/Release.ssl", "Sample/.cache/Release.ssl", "Sample/.Release.ssl", ".ssl", ".github/workflows/x.ssl"]) expect(scriptProblem(script)).toBe("it is hidden, or in a hidden folder");
	});

	test("is not a file of another kind", () => {
		for (const script of ["package.json", "Sample/Release", "Sample/Release.ssl.bak", "Sample/Release.sql", "docs/notes.md", "Sample/Release.txt", "design/Release.plan.json"]) expect(scriptProblem(script)).toBe("it is not an SSL file (.ssl, .srvscr or .ds)");
	});

	test("is not outside the workspace, as before", () => {
		for (const script of ["../outside/Release.ssl", "../../outside/Release.ssl", "Sample/../../Release.ssl", "/etc/Release.ssl", "C:\\Scripts\\Release.ssl", "c:/Scripts/Release.ssl", "\\\\server\\share\\Release.ssl"]) expect(scriptProblem(script)).toBe("it is not a path inside the workspace");
		for (const script of ["", "   ", "/", "./"]) expect(scriptProblem(script)).not.toBeNull();
	});

	test("the first unit to be written that names another kind of file stops the build, and says why", () => {
		const units = [
			{ name: "Mark", script: "Sample/Release.ssl" },
			{ name: "Hook", script: ".git/hooks/pre-commit" },
			{ name: "Notes", script: "docs/notes.md" },
		];
		expect(unwritableUnit(units, plan())).toEqual({ unit: "Hook", script: ".git/hooks/pre-commit", why: "it is hidden, or in a hidden folder" });
		expect(unwritableUnit(units.slice(0, 1), plan())).toBeNull();
		// A unit that names no script goes to the plan's target, or to one named after the plan: those pass.
		expect(unwritableUnit([{ name: "Mark" }], plan())).toBeNull();
		expect(scriptProblem(scriptOf({ name: "Mark" }, planOf({ title: "../../Release: a sample", nodes: [], edges: [] })))).toBeNull();
		// The plan's own target is held to the same rule.
		expect(unwritableUnit([{ name: "Mark" }], { ...plan(), targets: ["../Release.ssl"] })).toEqual({ unit: "Mark", script: "../Release.ssl", why: "it is not a path inside the workspace" });
	});

	test("a unit kept as it is, is not written, so where it stands is not judged", () => {
		const units = [
			{ name: "Old", script: "legacy/Old.prg", status: "kept" as const },
			{ name: "Mark", script: "Sample/Release.ssl", status: "pending" as const },
		];
		expect(unwritableUnit(units, plan())).toBeNull();
		expect(unwritableUnit([{ ...units[0]!, status: "pending" as const }], plan())?.unit).toBe("Old");
	});
});

// --- 4d. what a test script is recorded against -------------------------------------------------------------

describe("a test script is recorded against the plan it was written from", () => {
	const written = () =>
		planOf({
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "step", text: "Mark the sample" },
				{ id: "n3", kind: "end", text: "Done" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
			],
			built: { units: [{ name: "Mark", script: "Sample/Release.ssl", nodes: ["n2"], calls: [] }], nodes: {} },
		});

	test("a chart changed while the agent wrote, or while the review stood open, shows the script as out of date", () => {
		const from = written();
		const now = setText(from, "n2", "Mark the sample and tell the lab");
		const recorded = recordTests(now, "Sample/ReleaseTests.ssl", from);
		const tests = builtOf(recorded)!.tests!;
		expect(tests.script).toBe("Sample/ReleaseTests.ssl");
		expect(tests.hash).toBe(testsHash(from));
		expect(testsHashMatches(tests.hash, recorded)).toBe(false);
		// It is recorded in the plan as it is now: the change made meanwhile is not undone.
		expect(recorded.nodes.find((n) => n.id === "n2")?.text).toBe("Mark the sample and tell the lab");
	});

	test("a test case added meanwhile counts too", () => {
		const from = written();
		const now = addPlanTest(from, { title: "An unknown id is refused" });
		expect(testsHashMatches(builtOf(recordTests(now, "T.ssl", from))!.tests!.hash, now)).toBe(false);
	});

	test("a plan that was not changed, or only moved about, is current", () => {
		const from = written();
		expect(testsHashMatches(builtOf(recordTests(from, "T.ssl", from))!.tests!.hash, from)).toBe(true);
		const moved = setNodeOffset(from, "n2", { x: 48, y: 0 });
		expect(testsHashMatches(builtOf(recordTests(moved, "T.ssl", from))!.tests!.hash, moved)).toBe(true);
		// With no plan said, it is the one it is recorded in, as before.
		expect(builtOf(recordTests(from, "T.ssl"))!.tests!.hash).toBe(testsHash(from));
	});
});

// --- 5. a Palette field when the selection moves on --------------------------------------------------------

describe("a Palette field typed in and not left", () => {
	/** A field as the Palette builds it: the node's id as its key, the node's text as its value. */
	const mount = (first = { id: "n2", text: "Read the sample" }) => {
		const handed: [text: string, key: string][] = [];
		const held = new Set<() => void>();
		let setNode!: (node: { id: string; text: string }) => void;
		let field!: ReturnType<typeof pendingField>;
		const dispose = createRoot((done) => {
			const [node, set] = createSignal(first);
			setNode = set;
			field = pendingField(
				{
					get value() {
						return node().text;
					},
					get resetKey() {
						return node().id;
					},
					onCommit: (text, key) => void handed.push([text, key]),
				},
				{
					hold: (commit) => {
						held.add(commit);
						return () => void held.delete(commit);
					},
				},
			);
			return done;
		});
		flush();
		const select = (node: { id: string; text: string }) => {
			setNode(node);
			flush();
		};
		return { field, handed, held, select, dispose };
	};

	test("hands its text to the node it was typed for when another node is selected", () => {
		const { field, handed, select } = mount();
		field.type("Read the sample and its results");
		flush();
		expect(field.draft()).toBe("Read the sample and its results");
		select({ id: "n5", text: "Tell the lab" });
		expect(handed).toEqual([["Read the sample and its results", "n2"]]);
		// The field now shows the node that is selected, and has nothing more to hand over.
		expect(field.draft()).toBe("Tell the lab");
		select({ id: "n6", text: "Done" });
		expect(handed.length).toBe(1);
	});

	test("does so when the next node says the very same thing", () => {
		const { field, handed, select } = mount({ id: "n2", text: "New step" });
		field.type("Check the status");
		flush();
		select({ id: "n3", text: "New step" });
		expect(handed).toEqual([["Check the status", "n2"]]);
		expect(field.draft()).toBe("New step");
	});

	test("hands nothing over when nothing was typed", () => {
		const { field, handed, select } = mount();
		select({ id: "n5", text: "Tell the lab" });
		field.commit("Tell the lab");
		expect(handed).toEqual([]);
	});

	test("left in the usual way, it hands its text over once", () => {
		const { field, handed, select } = mount();
		field.type("Read it");
		field.commit("Read it");
		expect(handed).toEqual([["Read it", "n2"]]);
		// The plan takes the text, and the selection moves on: nothing is handed over twice.
		select({ id: "n2", text: "Read it" });
		select({ id: "n5", text: "Tell the lab" });
		expect(handed.length).toBe(1);
	});

	test("keeps what is typed through a change elsewhere in the plan", () => {
		const { field, handed, select } = mount();
		field.type("Read the sam");
		flush();
		// The plan is read again after an edit to another node: this node comes back as a new object saying the same.
		select({ id: "n2", text: "Read the sample" });
		expect(field.draft()).toBe("Read the sam");
		select({ id: "n5", text: "Tell the lab" });
		expect(handed).toEqual([["Read the sam", "n2"]]);
	});

	test("Escape gives up what was typed: it is handed to no node", () => {
		const { field, handed, select } = mount();
		field.type("Something else");
		expect(field.revert()).toBe("Read the sample");
		flush();
		expect(field.draft()).toBe("Read the sample");
		select({ id: "n5", text: "Tell the lab" });
		expect(handed).toEqual([]);
	});

	test("a save or a close that asks for what is pending gets it, for the node it was typed for", () => {
		const { field, handed, held, dispose } = mount();
		expect(held.size).toBe(1);
		for (const commit of held) commit();
		expect(handed).toEqual([]);
		field.type("Read the sample twice");
		for (const commit of held) commit();
		expect(handed).toEqual([["Read the sample twice", "n2"]]);
		for (const commit of held) commit();
		expect(handed.length).toBe(1);
		dispose();
		expect(held.size).toBe(0);
	});

	test("taken away while typed in (the selection was cleared), it hands its text over a moment later", async () => {
		const { field, handed, dispose } = mount();
		field.type("Read the sample carefully");
		dispose();
		// Not inside the update that takes it away: a write there is refused.
		expect(handed).toEqual([]);
		await Promise.resolve();
		expect(handed).toEqual([["Read the sample carefully", "n2"]]);
	});

	test("taken away with nothing typed, it hands nothing over", async () => {
		const { handed, dispose } = mount();
		dispose();
		await Promise.resolve();
		expect(handed).toEqual([]);
	});
});

// --- what the views do with these ---------------------------------------------------------------------------

// The chart, the Palette, the text view and the build's loop need a DOM, Monaco, or opencode's stand-in to run,
// which this file does not set up. What they call is run above; this block only says that they call it, read
// from the source. It proves no behaviour: the steps to look at in the app are in the pass's report.
describe("the views use them (read from the source: these cannot be run here)", () => {
	const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
	const chart = read("src/view/plan/PlanView.tsx");

	test("the chart copies and pastes with its own plan's path", () => {
		expect(chart).toContain("copySteps(p, ids, props.path)");
		expect(chart).toContain("pasteSteps(p, props.path, direction())");
		expect(chart).not.toContain("pastePlanSelection(");
		expect(chart).not.toContain("copyPlanSelection(");
	});

	test("a wire or a shape dropped on a suggested node is refused, and said to be", () => {
		expect(chart).toContain("if (target?.suggested) notify(SUGGESTED_ONLY);");
		expect(chart).toContain("setDropNodeId(dropNodeAt(pt, cur.fromId));");
		expect(chart).toContain("if (hitNodeAt(clientToCanvas(e.clientX, e.clientY))?.suggested) {");
	});

	test("the text view says when it has taken a request, and the chart then holds none", () => {
		expect(read("src/view/plan/PlanTextView.tsx")).toContain("props.onBuilderRequestTaken?.(req);");
		expect(chart).toContain("builderRequest={builder.pending()}");
		expect(chart).toContain("onBuilderRequestTaken={builder.taken}");
	});

	test("the build asks before it carries on past its budget, and holds a unit's script to the rule", () => {
		const build = read("src/view/plan/buildRun.ts");
		expect(build).toContain("const short = carried && spentUp(carried);");
		expect(build).toContain("raiseBudget(run, { cost, tokens: moreTokens });");
		expect(build).toContain("const next = nextStep(run);");
		expect(build).toContain("if (cutShort(run, attempt)) {");
		expect(build).toContain("const refused = unwritableUnit(units, plan);");
		expect(build).toContain("const why = scriptProblem(script);");
		expect(read("src/view/plan/testScript.ts")).toContain("recordTests(latest, file, plan)");
	});

	test("a Palette field's text goes to the node it names, not to the one selected by then", () => {
		expect(chart).toContain("const nodeFor = (id?: string) => (id === undefined ? selectedNode() : plan()?.nodes.find((n) => n.id === id));");
		expect(chart.match(/const node = nodeFor\(id\);/g)?.length).toBe(3);
		const palette = read("src/view/panels/Palette.tsx");
		expect(palette.match(/pendingField\(props, \{ hold: holdsPendingEdit \}\)/g)?.length).toBe(2);
		expect(palette).toContain("onCommit={(val, id) => plan.setNodeText(val, id)}");
	});
});
