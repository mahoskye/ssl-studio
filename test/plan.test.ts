import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addAfter, addBranch, addCall, checkPlan, checkRefs, connect, findingLine, isPlanPath, newPlan, nodeAtLine, nodeLines, parsePlan, printPlan, removeEdge, removeNode, setDecision, setEdgeLabel, setGroup, setText, type Plan } from "../src/view/plan/model";

const sample = readFileSync(join(import.meta.dir, "../fixtures/workspace/design/Release.plan.json"), "utf8");
const parsed = (text: string) => parsePlan(text).plan!;
const codes = (plan: Plan) => checkPlan(plan).map((f) => f.code);
const flow = (plan: Plan) => plan.edges.map((e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ""}`);

describe("reading and printing a plan", () => {
	test("names a plan by its file", () => {
		expect(isPlanPath("design/Release.plan.json")).toBe(true);
		expect(isPlanPath("settings.json")).toBe(false);
		expect(isPlanPath(null)).toBe(false);
	});
	test("the sample round-trips byte for byte", () => {
		expect(printPlan(parsed(sample))).toBe(sample);
	});
	test("keeps fields it does not know", () => {
		const plan = parsed(JSON.stringify({ version: 1, title: "t", nodes: [{ id: "n1", kind: "step", text: "x", future: 1 }], edges: [], decisions: [{ q: "why" }] }));
		const again = parsed(printPlan(plan));
		expect(again.decisions).toEqual([{ q: "why" }]);
		expect(again.nodes[0]!.future).toBe(1);
	});
	test("one node or edge a line, so a change is a small diff", () => {
		const before = printPlan(newPlan("t")).split("\n");
		const after = printPlan(setText(newPlan("t"), "n1", "Begin")).split("\n");
		expect(after.length).toBe(before.length);
		expect(before.filter((line, i) => line !== after[i]).length).toBe(1);
	});
	test("says what is wrong instead of failing", () => {
		expect(parsePlan("{ nope").error).toContain("Not valid JSON");
		expect(parsePlan('{"version":2,"nodes":[],"edges":[]}').error).toContain("version 2");
		expect(parsePlan('{"version":1,"nodes":{},"edges":[]}').error).toContain("lists");
		expect(parsePlan('{"version":1,"nodes":[{"id":"a","kind":"odd","text":"x"}],"edges":[]}').error).toContain("unknown kind");
		expect(parsePlan('{"version":1,"nodes":[],"edges":[{"from":"a"}]}').error).toContain('"to"');
	});
});

describe("editing the chart", () => {
	test("the next step takes over the way out", () => {
		const { plan, select } = addAfter(newPlan("t"), "n1");
		expect(select).toBe("n3");
		expect(flow(plan)).toEqual(["n3>n2", "n1>n3"]);
		expect(codes(plan)).toEqual([]);
	});
	test("adding after an end comes before it", () => {
		const { plan } = addAfter(newPlan("t"), "n2");
		expect(flow(plan)).toEqual(["n1>n3", "n3>n2"]);
	});
	test("a branch makes a step a decision, labels both ways, and runs to the end", () => {
		const step = addAfter(newPlan("t"), "n1").plan;
		const { plan, select } = addBranch(step, "n3")!;
		expect(plan.nodes.find((n) => n.id === "n3")!.kind).toBe("decision");
		expect(flow(plan)).toEqual(["n3>n2:yes", "n1>n3", "n3>n4:no", "n4>n2"]);
		expect(select).toBe("n4");
		expect(codes(plan)).toEqual([]);
	});
	test("more branches get their own labels, and adding after a decision branches", () => {
		const step = addAfter(newPlan("t"), "n1").plan;
		const two = addBranch(step, "n3")!.plan;
		const three = addAfter(two, "n3").plan;
		expect(three.edges.filter((e) => e.from === "n3").map((e) => e.label)).toEqual(["yes", "no", "option 3"]);
	});
	test("a start, an end or a call cannot branch", () => {
		const plan = addCall(newPlan("t"), "Helper", "n1").plan;
		expect(addBranch(plan, "n1")).toBeNull();
		expect(addBranch(plan, "n2")).toBeNull();
		expect(addBranch(plan, "n3")).toBeNull();
	});
	test("a call keeps what it calls, in the flow or on its own", () => {
		const after = addCall(newPlan("t"), "Helper", "n1").plan;
		expect(after.nodes.at(-1)).toEqual({ id: "n3", kind: "call", text: "Helper", ref: "Helper" });
		expect(flow(after)).toEqual(["n3>n2", "n1>n3"]);
		const alone = addCall(newPlan("t"), "Helper").plan;
		expect(alone.edges).toEqual(newPlan("t").edges);
		expect(codes(alone)).toContain("plan-unreachable");
	});
	test("removing a node joins one way in to one way out", () => {
		const { plan, select } = removeNode(addAfter(newPlan("t"), "n1").plan, "n3");
		expect(flow(plan)).toEqual(["n1>n2"]);
		expect(select).toBe("n1");
	});
	test("removing a decision leaves its branches for you to reconnect", () => {
		const two = addBranch(addAfter(newPlan("t"), "n1").plan, "n3")!.plan;
		const { plan } = removeNode(two, "n3");
		expect(flow(plan)).toEqual(["n4>n2"]);
		expect(codes(plan)).toEqual(["plan-dead-end", "plan-unreachable", "plan-unreachable"]);
	});
	test("connecting labels a decision's new branch, and refuses repeats and loops to itself", () => {
		const two = addBranch(addAfter(newPlan("t"), "n1").plan, "n3")!.plan;
		const linked = connect(two, "n3", "n1");
		expect(linked.edges.at(-1)).toEqual({ from: "n3", to: "n1", label: "option 3" });
		expect(connect(linked, "n3", "n1")).toBe(linked);
		expect(connect(linked, "n3", "n3")).toBe(linked);
	});
	test("an edge can be relabelled, unlabelled and removed", () => {
		const two = addBranch(addAfter(newPlan("t"), "n1").plan, "n3")!.plan;
		expect(setEdgeLabel(two, "n3", "n4", "maybe").edges.find((e) => e.to === "n4")!.label).toBe("maybe");
		expect(setEdgeLabel(two, "n3", "n4", "").edges.find((e) => e.to === "n4")!.label).toBeUndefined();
		expect(flow(removeEdge(two, "n3", "n4"))).not.toContain("n3>n4:no");
	});
	test("a step can turn into a decision and back; other kinds stay", () => {
		const plan = addAfter(newPlan("t"), "n1").plan;
		expect(setDecision(plan, "n3", true).nodes.find((n) => n.id === "n3")!.kind).toBe("decision");
		expect(setDecision(setDecision(plan, "n3", true), "n3", false).nodes.find((n) => n.id === "n3")!.kind).toBe("step");
		expect(setDecision(plan, "n1", true).nodes.find((n) => n.id === "n1")!.kind).toBe("start");
	});
	test("groups are made by name, shared, and go when empty", () => {
		let plan = addAfter(newPlan("t"), "n1").plan;
		plan = setGroup(plan, "n3", "Validation");
		expect(plan.groups).toEqual([{ id: "g1", name: "Validation" }]);
		plan = setGroup(plan, "n1", "validation");
		expect(plan.groups.length).toBe(1);
		expect(plan.nodes.find((n) => n.id === "n1")!.group).toBe("g1");
		plan = setGroup(setGroup(plan, "n3", ""), "n1", "");
		expect(plan.groups).toEqual([]);
	});
	test("new nodes join the group of the node they follow", () => {
		const plan = setGroup(addAfter(newPlan("t"), "n1").plan, "n3", "Validation");
		expect(addAfter(plan, "n3").plan.nodes.at(-1)!.group).toBe("g1");
	});
	test("ids are never reused while the plan holds a higher one", () => {
		const plan = removeNode(addAfter(addAfter(newPlan("t"), "n1").plan, "n3").plan, "n3").plan;
		expect(addAfter(plan, "n1").select).toBe("n5");
	});
});

describe("the check, with no agent", () => {
	const base = (nodes: any[], edges: any[], groups: any[] = []): Plan => ({ version: 1, title: "t", groups, nodes, edges });
	test("a new plan and the sample are clean", () => {
		expect(checkPlan(newPlan("t"))).toEqual([]);
		expect(checkPlan(parsed(sample))).toEqual([]);
	});
	test("finds a missing start and end", () => {
		const list = codes(base([{ id: "a", kind: "step", text: "x" }], []));
		expect(list).toContain("plan-no-start");
		expect(list).toContain("plan-no-end");
	});
	test("finds unreachable nodes and dead ends", () => {
		const plan = base(
			[
				{ id: "s", kind: "start", text: "s" },
				{ id: "a", kind: "step", text: "a" },
				{ id: "b", kind: "step", text: "b" },
				{ id: "e", kind: "end", text: "e" },
			],
			[
				{ from: "s", to: "a" },
				{ from: "b", to: "e" },
			],
		);
		const list = checkPlan(plan);
		expect(list.find((f) => f.code === "plan-dead-end")!.node).toBe("a");
		expect(list.filter((f) => f.code === "plan-unreachable").map((f) => f.node)).toEqual(["b", "e"]);
	});
	test("a loop back is fine", () => {
		const plan = base(
			[
				{ id: "s", kind: "start", text: "s" },
				{ id: "a", kind: "step", text: "a" },
				{ id: "d", kind: "decision", text: "again?" },
				{ id: "e", kind: "end", text: "e" },
			],
			[
				{ from: "s", to: "a" },
				{ from: "a", to: "d" },
				{ from: "d", to: "a", label: "yes" },
				{ from: "d", to: "e", label: "no" },
			],
		);
		expect(checkPlan(plan)).toEqual([]);
	});
	test("finds one-way decisions and unlabelled branches", () => {
		const plan = base(
			[
				{ id: "s", kind: "start", text: "s" },
				{ id: "d", kind: "decision", text: "ok?" },
				{ id: "e", kind: "end", text: "e" },
			],
			[
				{ from: "s", to: "d" },
				{ from: "d", to: "e" },
			],
		);
		expect(codes(plan)).toEqual(["plan-one-way-decision", "plan-unlabelled-branch"]);
	});
	test("finds edges to nothing, duplicate ids, empty words and flows through a start or end", () => {
		const plan = base(
			[
				{ id: "s", kind: "start", text: "s" },
				{ id: "s", kind: "step", text: " " },
				{ id: "e", kind: "end", text: "e" },
			],
			[
				{ from: "s", to: "ghost" },
				{ from: "e", to: "s" },
			],
		);
		const list = codes(plan);
		for (const code of ["plan-duplicate-id", "plan-bad-edge", "plan-empty-text", "plan-end-continues", "plan-start-entered"]) expect(list).toContain(code);
	});
	test("finds calls that name nothing, or something the server does not know", () => {
		const plan = base([{ id: "c", kind: "call", text: "x" }], []);
		expect(codes(plan)).toContain("plan-call-no-ref");
		const named = base([{ id: "c", kind: "call", text: "x", ref: "Gone" }], []);
		expect(checkRefs(named, () => true)).toEqual([]);
		expect(checkRefs(named, () => false)[0]!.code).toBe("plan-unresolved-ref");
	});
});

describe("between the chart and its text", () => {
	const plan = parsed(sample);
	test("every node has its line", () => {
		const lines = nodeLines(sample, plan);
		const all = sample.split("\n");
		for (const n of plan.nodes) expect(all[lines.get(n.id)! - 1]).toContain(`"id": "${n.id}"`);
	});
	test("a group's id is not taken for a node's", () => {
		expect(nodeLines(sample, plan).has("g1")).toBe(false);
	});
	test("the cursor selects the node on its line, and nothing outside the nodes", () => {
		const lines = nodeLines(sample, plan);
		const line = lines.get("n3")!;
		expect(nodeAtLine(sample, plan, line)).toBe("n3");
		expect(nodeAtLine(sample, plan, 1)).toBeNull();
		const edges = sample.split("\n").findIndex((l) => l.includes('"edges"')) + 1;
		expect(nodeAtLine(sample, plan, edges)).toBeNull();
		expect(nodeAtLine(sample, plan, edges + 1)).toBeNull();
	});
	test("reads a node's line in hand-spread JSON too", () => {
		const spread = JSON.stringify(plan, null, 2);
		const line = nodeLines(spread, plan).get("n2")!;
		expect(spread.split("\n")[line - 1]).toContain('"n2"');
		expect(nodeAtLine(spread, plan, line + 1)).toBe("n2");
	});
	test("a finding points at its node or edge", () => {
		expect(findingLine(sample, plan, { severity: "warning", code: "x", message: "", node: "n4" })).toBe(nodeLines(sample, plan).get("n4")!);
		const edge = plan.edges[0]!;
		const line = findingLine(sample, plan, { severity: "warning", code: "x", message: "", edge: { from: edge.from, to: edge.to } });
		expect(sample.split("\n")[line - 1]).toContain(`"from": "${edge.from}"`);
		expect(findingLine(sample, plan, { severity: "warning", code: "x", message: "" })).toBe(1);
	});
});
