import { describe, expect, test } from "bun:test";
import {
	applySuggestion,
	copyPlanSelection,
	decisionsOf,
	isAllowedContextPath,
	manualPlanDrift,
	mermaidToPlan,
	openQuestions,
	overLimit,
	pastePlanSelection,
	planToMermaid,
	syncPlanMermaidInMarkdown,
} from "../src/view/plan/assist";
import { assembleScript, bannerFor, judgeUnit, runFileName, scriptOf, type BuildUnit, type Judged } from "../src/view/plan/build";
import { builtOf, planPaths, type Reading } from "../src/view/plan/built";
import { chartGraph, offsetFor, sizeNode } from "../src/view/plan/chart";
import {
	addAfter,
	addBranch,
	checkPlan,
	duplicateNode,
	findingLine,
	newPlan,
	nodeAtLine,
	nodeLines,
	parsePlan,
	printPlan,
	removeNode,
	type Plan,
} from "../src/view/plan/model";
import { matchPathsForChoices, planTextOutline } from "../src/view/plan/textModel";

const seven = (s: string) => s.length * 7;

const basePlan = (): Plan => ({
	version: 1,
	title: "Release a sample",
	groups: [],
	nodes: [
		{ id: "n1", kind: "start", text: "Start" },
		{ id: "n2", kind: "step", text: "Do work" },
		{ id: "n3", kind: "end", text: "End" },
	],
	edges: [
		{ from: "n1", to: "n2" },
		{ from: "n2", to: "n3" },
	],
});

describe("R3B — model.ts validation, serialization, graph edits, and JSON scanner", () => {
	test("parsePlan strips null/non-object entries in tests, decisions, built.units, coerces ref/notes/label, and drops bad offsets", () => {
		const raw = JSON.stringify({
			version: 1,
			title: "Messy",
			groups: [{ id: "g1", name: "Stage", offset: { x: "bad", y: 10 } }],
			nodes: [
				{ id: "n1", kind: "start", text: "Start", offset: { x: 10, y: 20 } },
				{ id: "n2", kind: "call", text: "Call", ref: 42, notes: null, offset: { x: null, y: 5 }, docs: "not-a-list" },
				{ id: "n3", kind: "decision", text: "Ok?", notes: true, offset: "oops" },
				{ id: "n4", kind: "end", text: "End" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
				{ from: "n3", to: "n4", label: true, route: "bad" },
				{ from: "n3", to: "n2", label: { bad: 1 } },
			],
			tests: [null, 123, { id: "t1", title: "Valid case" }],
			decisions: [null, "bad", { question: "Which?", answer: 123 }],
			built: {
				units: [null, "bad", { name: "Proc", script: "a.ssl", parameters: ["sId", 99, null], nodes: ["n2"], calls: [] }],
				nodes: { n2: "abc" },
				tests: { script: "aTests.ssl", hash: "abc" },
			},
		});
		const parsed = parsePlan(raw);
		expect(parsed.error).toBeUndefined();
		const plan = parsed.plan!;

		// Coerced / guarded string fields never crash checkPlan
		expect(plan.nodes.find((n) => n.id === "n2")?.ref).toBe("42");
		expect(plan.nodes.find((n) => n.id === "n2")?.notes).toBeUndefined();
		expect(plan.nodes.find((n) => n.id === "n2")?.offset).toBeUndefined();
		expect(plan.nodes.find((n) => n.id === "n2")?.docs).toBeUndefined();
		expect(plan.nodes.find((n) => n.id === "n3")?.notes).toBe("true");
		expect(plan.nodes.find((n) => n.id === "n3")?.offset).toBeUndefined();
		expect(plan.nodes.find((n) => n.id === "n1")?.offset).toEqual({ x: 10, y: 20 });
		expect(plan.groups[0]?.offset).toBeUndefined();
		expect(plan.edges[2]?.label).toBe("true");
		expect(plan.edges[2]?.route).toBeUndefined();
		expect(plan.edges[3]?.label).toBeUndefined();
		expect(() => checkPlan(plan)).not.toThrow();

		// Null/non-object entries stripped from tests, decisions, built.units
		expect(plan.tests).toEqual([{ id: "t1", title: "Valid case" }]);
		expect(plan.decisions).toEqual([{ question: "Which?", answer: 123 }]);
		expect(openQuestions(plan)).toHaveLength(1);
		expect(builtOf(plan)?.units).toEqual([{ name: "Proc", script: "a.ssl", parameters: ["sId"], nodes: ["n2"], calls: [] }]);

		// Re-printing always yields valid JSON
		const printed = printPlan(plan);
		expect(() => JSON.parse(printed)).not.toThrow();
	});

	test("printPlan filters undefined custom fields in nodes, edges, rest, and built without emitting invalid JSON", () => {
		const plan: Plan = {
			...basePlan(),
			customTop: undefined,
			validTop: { keep: 1 },
			nodes: [
				{ id: "n1", kind: "start", text: "Start", customUndef: undefined, customKeep: 7 },
				{ id: "n2", kind: "end", text: "End" },
			],
			edges: [{ from: "n1", to: "n2", customEdgeUndef: undefined }],
			tests: [null as any, { id: "t1", title: "T", extraUndef: undefined }],
			built: {
				units: [null as any, { name: "U", script: "a.ssl", parameters: ["p"], nodes: ["n1"], calls: [], extraUndef: undefined }],
				nodes: { n1: "h1" },
				undefProp: undefined,
			},
		};
		const printed = printPlan(plan);
		expect(printed).not.toContain("undefined");
		expect(printed).not.toContain(",\n\n}");
		const reparsed = JSON.parse(printed);
		expect(reparsed.validTop).toEqual({ keep: 1 });
		expect(reparsed.nodes[0].customKeep).toBe(7);
		expect("customTop" in reparsed).toBe(false);
		expect("customUndef" in reparsed.nodes[0]).toBe(false);
		expect("undefProp" in reparsed.built).toBe(false);
	});

	test("removeNode avoids creating a self-loop in a 2-node loop and strips stale route offsets", () => {
		const twoLoop: Plan = {
			version: 1,
			title: "Loop",
			groups: [],
			nodes: [
				{ id: "n1", kind: "step", text: "A" },
				{ id: "n2", kind: "step", text: "B" },
			],
			edges: [
				{ from: "n1", to: "n2", route: { "1h": 24 } },
				{ from: "n2", to: "n1" },
			],
		};
		const removed = removeNode(twoLoop, "n2").plan;
		expect(removed.edges).toEqual([]);
		expect(removed.edges.some((e) => e.from === e.to)).toBe(false);

		const linearWithRoute: Plan = {
			...basePlan(),
			edges: [
				{ from: "n1", to: "n2", label: "go", route: { "1h": 30 } },
				{ from: "n2", to: "n3" },
			],
		};
		const spliced = removeNode(linearWithRoute, "n2").plan;
		expect(spliced.edges).toEqual([{ from: "n1", to: "n3", label: "go" }]);
		expect(spliced.edges[0]?.route).toBeUndefined();
	});

	test("addAfter and addBranch with kind 'end' default text to 'End' and wire zero outgoing edges from the new end", () => {
		const p = newPlan("T");
		const afterStep = addAfter(p, "n1").plan; // n1 -> n3 -> n2
		const addedEnd = addAfter(afterStep, "n3", "end");
		const endNode = addedEnd.plan.nodes.find((n) => n.id === addedEnd.select)!;
		expect(endNode.kind).toBe("end");
		expect(endNode.text).toBe("End");
		expect(addedEnd.plan.edges.filter((e) => e.from === endNode.id)).toEqual([]);
		expect(addedEnd.plan.edges.some((e) => e.from === "n3" && e.to === endNode.id)).toBe(true);

		// Adding an end after an existing end creates no outgoing edges either
		const afterExistingEnd = addAfter(p, "n2", "end");
		expect(afterExistingEnd.plan.edges.filter((e) => e.from === afterExistingEnd.select)).toEqual([]);

		// Branching with kind 'end' creates the branch edge into the new end, with no outgoing edge to another end
		const branchedEnd = addBranch(afterStep, "n3", "end")!;
		const branchEndNode = branchedEnd.plan.nodes.find((n) => n.id === branchedEnd.select)!;
		expect(branchEndNode.kind).toBe("end");
		expect(branchEndNode.text).toBe("End");
		expect(branchedEnd.plan.edges.filter((e) => e.from === branchEndNode.id)).toEqual([]);
		expect(branchedEnd.plan.edges.some((e) => e.from === "n3" && e.to === branchEndNode.id && e.label === "no")).toBe(true);
		expect(checkPlan(branchedEnd.plan)).toEqual([]);
	});

	test("duplicateNode preserves custom/unknown fields on clone", () => {
		const p: Plan = {
			...basePlan(),
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "step", text: "Step", customTag: "priority", meta: { owner: "lab" } },
				{ id: "n3", kind: "end", text: "End" },
			],
		};
		const dup = duplicateNode(p, "n2")!;
		const clone = dup.plan.nodes.find((n) => n.id === dup.select)!;
		expect(clone.customTag).toBe("priority");
		expect(clone.meta).toEqual({ owner: "lab" });
		expect(clone.id).not.toBe("n2");
	});

	test("nodeLines, nodeAtLine, and findingLine ignore built.nodes before nodes, support 4-space indent, and handle JSON escapes", () => {
		const plan: Plan = {
			version: 1,
			title: "Escaped & Reordered",
			targets: ["src/Release.ssl"],
			groups: [],
			nodes: [
				{ id: 'n"1', kind: "start", text: "Start" },
				{ id: "n\\2", kind: "step", text: "Step" },
				{ id: "n3", kind: "end", text: "End" },
			],
			edges: [
				{ from: 'n"1', to: "n\\2" },
				{ from: "n\\2", to: "n3" },
			],
			built: {
				units: [{ name: "Run", script: "src/Release.ssl", parameters: [], nodes: ['n"1'], calls: [] }],
				nodes: { 'n"1': "hash1", "n\\2": "hash2", n3: "hash3" },
			},
		};
		// Put `built` BEFORE `nodes` and format with 4-space indentation
		const reordered = {
			version: plan.version,
			title: plan.title,
			built: plan.built,
			targets: plan.targets,
			groups: plan.groups,
			nodes: plan.nodes,
			edges: plan.edges,
		};
		const text = JSON.stringify(reordered, null, 4);
		const lines = text.split("\n");
		const map = nodeLines(text, plan);

		expect(map.size).toBe(3);
		const n1Line = map.get('n"1')!;
		const n2Line = map.get("n\\2")!;
		const n3Line = map.get("n3")!;
		const realNodesStart = lines.findIndex((l) => /^    "nodes": \[/.test(l)) + 1;
		expect(n1Line).toBeGreaterThan(realNodesStart);
		expect(lines[n1Line - 1]).toContain('"id": "n\\"1"');
		expect(lines[n2Line - 1]).toContain('"id": "n\\\\2"');
		expect(lines[n3Line - 1]).toContain('"id": "n3"');

		// nodeAtLine selects the right node inside 4-space spread objects and returns null inside built.nodes or edges
		expect(nodeAtLine(text, plan, n1Line + 1)).toBe('n"1');
		expect(nodeAtLine(text, plan, n2Line + 1)).toBe("n\\2");
		const builtNodesLine = lines.findIndex((l) => l.includes('"hash1"')) + 1;
		expect(nodeAtLine(text, plan, builtNodesLine)).toBeNull();
		const edgesLine = lines.findIndex((l) => /^    "edges": \[/.test(l)) + 1;
		expect(nodeAtLine(text, plan, edgesLine)).toBeNull();
		expect(nodeAtLine(text, plan, edgesLine + 2)).toBeNull();

		// findingLine resolves JSON-escaped node ids, multi-line JSON-escaped edges, and top-level fields
		expect(findingLine(text, plan, { severity: "warning", code: "x", message: "", node: 'n"1' })).toBe(n1Line);
		const edgeLine = findingLine(text, plan, { severity: "warning", code: "x", message: "", edge: { from: 'n"1', to: "n\\2" } });
		expect(edgeLine).toBeGreaterThan(edgesLine);
		expect(lines[edgeLine - 1]).toContain('"from": "n\\"1"');
		const targetsLine = findingLine(text, plan, { severity: "warning", code: "x", message: "", field: "targets" });
		expect(lines[targetsLine - 1]).toContain('"targets":');
	});
});

describe("R3B — built.ts planPaths budget & builtOf validation", () => {
	test("planPaths completes in <50ms on a 20-decision chain ending in a dangling edge", () => {
		const nodes: Plan["nodes"] = [{ id: "s", kind: "start", text: "Start" }];
		const edges: Plan["edges"] = [];
		let prev = "s";
		for (let i = 0; i < 20; i++) {
			const d = `d${i}`;
			const a = `a${i}`;
			const b = `b${i}`;
			const j = `j${i}`;
			nodes.push(
				{ id: d, kind: "decision", text: `Decision ${i}?` },
				{ id: a, kind: "step", text: `Yes ${i}` },
				{ id: b, kind: "step", text: `No ${i}` },
				{ id: j, kind: "step", text: `Join ${i}` },
			);
			edges.push(
				{ from: prev, to: d },
				{ from: d, to: a, label: "yes" },
				{ from: d, to: b, label: "no" },
				{ from: a, to: j },
				{ from: b, to: j },
			);
			prev = j;
		}
		// Dangling edge at the very end previously prevented `paths.length` from ever incrementing, causing O(2^20) freeze.
		edges.push({ from: prev, to: "ghost-missing-node" });

		const plan: Plan = { version: 1, title: "Dense Dangling", groups: [], nodes, edges };
		const t0 = performance.now();
		const result = planPaths(plan);
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(50);
		expect(result.paths.length).toBe(24);
		expect(result.truncated).toBe(true);
	});

	test("planPaths enforces hard step budget on dense cyclic graphs", () => {
		const nodes: Plan["nodes"] = [{ id: "s", kind: "start", text: "Start" }];
		const edges: Plan["edges"] = [];
		for (let i = 0; i < 12; i++) nodes.push({ id: `n${i}`, kind: "step", text: `Step ${i}` });
		edges.push({ from: "s", to: "n0" });
		for (let i = 0; i < 12; i++) {
			for (let j = 0; j < 12; j++) {
				if (i !== j) edges.push({ from: `n${i}`, to: `n${j}` });
			}
		}
		const plan: Plan = { version: 1, title: "Clique", groups: [], nodes, edges };
		const t0 = performance.now();
		const result = planPaths(plan, 24, 5000);
		const elapsed = performance.now() - t0;

		expect(elapsed).toBeLessThan(100);
		expect(result.truncated).toBe(true);
	});

	test("builtOf validates plain unit objects, string-only parameters, and structured tests record", () => {
		const p = basePlan();
		expect(
			builtOf({
				...p,
				built: {
					units: [null, 42, { name: "Ok", script: "a.ssl", parameters: ["a", 1, null, "b"], nodes: ["n2", 5], calls: ["C", false] }],
					nodes: { n2: "h" },
					tests: "invalid-tests-string",
				},
			}),
		).toEqual({
			units: [{ name: "Ok", script: "a.ssl", parameters: ["a", "b"], nodes: ["n2"], calls: ["C"] }],
			nodes: { n2: "h" },
		});

		// Malformed `tests` alone without valid units counts as nothing built
		expect(builtOf({ ...p, built: { units: [], nodes: {}, tests: "bad" } })).toBeNull();
		expect(builtOf({ ...p, built: { units: [], nodes: {}, tests: { hash: "abc" } } })).toBeNull();
		expect(builtOf({ ...p, built: { units: [], nodes: {}, tests: { script: "T.ssl", hash: "abc" } } })).toEqual({
			units: [],
			nodes: {},
			tests: { script: "T.ssl", hash: "abc" },
		});
	});
});

describe("R3B — chart.ts collision-free ELK root/group IDs and finite offsetFor", () => {
	test("offsetFor returns zero for NaN, Infinity, or mismatched orientation", () => {
		expect(offsetFor({ x: Number.NaN, y: 10 }, "DOWN")).toEqual({ x: 0, y: 0 });
		expect(offsetFor({ x: 10, y: Number.POSITIVE_INFINITY }, "DOWN")).toEqual({ x: 0, y: 0 });
		expect(offsetFor({ x: 12, y: -8 }, "DOWN")).toEqual({ x: 12, y: -8 });
		expect(offsetFor({ x: 12, y: -8 }, "RIGHT")).toEqual({ x: 0, y: 0 });
	});

	test("chartGraph avoids ELK ID collisions for 'root', duplicate groups, and node/group ID clashes", () => {
		const plan: Plan = {
			version: 1,
			title: "Collisions",
			groups: [
				{ id: "g1", name: "First Stage" },
				{ id: "g1", name: "Duplicate Stage" },
				{ id: "root", name: "Root Stage" },
			],
			nodes: [
				{ id: "root", kind: "start", text: "Root Node", group: "root" },
				{ id: "__root__", kind: "step", text: "Double Root" },
				{ id: "g1", kind: "step", text: "Node Named g1", group: "g1" },
				{ id: "__grp__:g1", kind: "end", text: "Prefixed Node", group: "g1" },
			],
			edges: [
				{ from: "root", to: "__root__" },
				{ from: "__root__", to: "g1" },
				{ from: "g1", to: "__grp__:g1" },
			],
		};
		const sizes = new Map(plan.nodes.map((n) => [n.id, sizeNode(n.kind, n.text, seven)]));
		const result = chartGraph(plan, sizes);

		// Duplicate group removed (keep first)
		expect(result.groups).toEqual([
			{ id: "g1", name: "First Stage" },
			{ id: "root", name: "Root Stage" },
		]);

		// Root ID does not collide with "root" or "__root__"
		expect(result.graph.id).toBe("__root___");

		// Collect every ELK ID (root, containers, leaf nodes, ports) and ensure 100% uniqueness
		const seen = new Set<string>();
		const walk = (node: any) => {
			expect(seen.has(node.id)).toBe(false);
			seen.add(node.id);
			for (const port of node.ports ?? []) {
				expect(seen.has(port.id)).toBe(false);
				seen.add(port.id);
			}
			for (const c of node.children ?? []) walk(c);
		};
		walk(result.graph);

		// groupElkIds maps both colliding group ELK containers back to their plan group IDs
		const mappedGroupIds = new Set(result.groupElkIds.values());
		expect(mappedGroupIds).toEqual(new Set(["g1", "root"]));
		for (const [elkId, planGroupId] of result.groupElkIds) {
			expect(plan.nodes.some((n) => n.id === elkId)).toBe(false);
			expect(elkId).not.toBe(result.graph.id);
			const container = result.graph.children!.find((c) => c.id === elkId);
			expect(container).toBeDefined();
			expect(container!.children!.every((c) => plan.nodes.find((n) => n.id === c.id)?.group === planGroupId)).toBe(true);
		}
	});
});

describe("R3B — assist.ts Mermaid round-trip, drift, suggestions, overLimit, and clipboard", () => {
	test("Mermaid round-trip handles n1-->n2, ;, %%, |, &, trailing \\, ```, cross-stage edges, and looped stadium Start/End", () => {
		const orig: Plan = {
			version: 1,
			title: "Adversarial Mermaid",
			groups: [
				{ id: "g1", name: "Intake & Parse; Stage 1" },
				{ id: "g2", name: "Finish \\ Close" },
			],
			nodes: [
				{ id: "n1", kind: "start", text: "Start workflow" },
				{ id: "n2", kind: "step", text: 'Check a; b %% c | d & e\nwith ```code``` and trailing \\', group: "g1" },
				{ id: "n3", kind: "decision", text: "Retry & loop?", group: "g1" },
				{ id: "n4", kind: "step", text: "Save result", group: "g2" },
				{ id: "n5", kind: "end", text: "End workflow" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
				{ from: "n3", to: "n1", label: "retry; %% | 100% \\" },
				{ from: "n3", to: "n4", label: "no | continue & save ```ok```" },
				{ from: "n4", to: "n5" },
			],
		};

		const mermaid = planToMermaid(orig);
		// Triple backticks escaped inside diagram so they never break Markdown fences
		expect(mermaid).not.toContain("```");
		// Pipe escaped as #124;, never irreversibly replaced with /
		expect(mermaid).toContain("#124;");

		const imported = mermaidToPlan(mermaid, orig.title)!;
		expect(imported).not.toBeNull();
		expect(imported.groups.map((g) => g.name)).toEqual(orig.groups.map((g) => g.name));

		// Looped stadium Start stays "start" (not misclassified as "call"), End stays "end"
		expect(imported.nodes.find((n) => n.id === "n1")?.kind).toBe("start");
		expect(imported.nodes.find((n) => n.id === "n5")?.kind).toBe("end");
		expect(imported.nodes.find((n) => n.id === "n2")?.text).toBe(orig.nodes[1]!.text);

		// Edge labels round-trip losslessly (including ;, %%, |, &, \, and ```)
		const retryEdge = imported.edges.find((e) => e.from === "n3" && e.to === "n1");
		expect(retryEdge?.label).toBe("retry; %% | 100% \\");
		const contEdge = imported.edges.find((e) => e.from === "n3" && e.to === "n4");
		expect(contEdge?.label).toBe("no | continue & save ```ok```");
	});

	test("mermaidToPlan parses compact arrows (n1-->n2, n1-.->n2, step-1-->step-2), consecutive backslashes, and cross-stage targets", () => {
		const src = [
			"flowchart TD",
			'  subgraph g1["Stage One"]',
			'    step-1["First \\\\"]-->n2',
			'    step-1-.->|go|n3["Third"]',
			"  end",
			'  subgraph g2["Stage Two"]',
			'    n2["Second"]---n4["Fourth"]; n4==>n5(["End"])',
			"  end",
			'  n0(["Start"])-->step-1',
		].join("\n");

		const parsed = mermaidToPlan(src)!;
		expect(parsed).not.toBeNull();
		expect(parsed.nodes.find((n) => n.id === "step-1")?.text).toBe("First \\");
		expect(parsed.nodes.find((n) => n.id === "step-1")?.group).toBe("g1");
		// n2 was referenced as a cross-stage edge target inside g1, then explicitly declared in g2 -> belongs to g2!
		expect(parsed.nodes.find((n) => n.id === "n2")?.group).toBe("g2");
		expect(parsed.nodes.find((n) => n.id === "n2")?.text).toBe("Second");
		expect(parsed.nodes.find((n) => n.id === "n3")?.group).toBe("g1");
		expect(parsed.nodes.find((n) => n.id === "n4")?.group).toBe("g2");
		expect(parsed.nodes.find((n) => n.id === "n0")?.kind).toBe("start");
		expect(parsed.nodes.find((n) => n.id === "n5")?.kind).toBe("end");
		expect(parsed.edges).toContainEqual({ from: "step-1", to: "n2" });
		expect(parsed.edges).toContainEqual({ from: "step-1", to: "n3", label: "go" });
		expect(parsed.edges).toContainEqual({ from: "n2", to: "n4" });
		expect(parsed.edges).toContainEqual({ from: "n4", to: "n5" });
		expect(parsed.edges).toContainEqual({ from: "n0", to: "step-1" });
	});

	test("planToMermaid shares one taken ID set between nodes and groups, and syncPlanMermaidInMarkdown uses longer fences for ```", () => {
		const colliding: Plan = {
			version: 1,
			title: "Clash",
			groups: [{ id: "g1", name: "Stage" }],
			nodes: [
				{ id: "g1", kind: "step", text: "Node g1", group: "g1" },
			],
			edges: [],
		};
		const m = planToMermaid(colliding);
		expect(m).toContain('subgraph g1_2["Stage"]');
		expect(m).toContain('g1["Node g1"]');

		const rawWithTicks = 'flowchart TD\n  a["has ``` ticks"] --> b["done"]';
		const md = syncPlanMermaidInMarkdown("# Spec\n", rawWithTicks);
		expect(md).toContain("````mermaid\n");
		expect(md).toContain("\n````\n<!-- plan-mermaid:end -->");
		// Round-tripping the 4-backtick fenced block extracts the diagram cleanly
		const parsed = mermaidToPlan(md)!;
		expect(parsed).not.toBeNull();
		expect(parsed.nodes.find((n) => n.id === "a")?.text).toBe("has ``` ticks");
	});

	test("mermaidToPlan assigns deterministic auto group IDs without colliding with later nodes", () => {
		const src = [
			"flowchart TD",
			'  subgraph "Alpha"',
			'    a["A"]',
			"  end",
			'  g1["Node named g1"]',
			"  a --> g1",
		].join("\n");
		const p1 = mermaidToPlan(src)!;
		const p2 = mermaidToPlan(src)!;
		expect(p1).toEqual(p2);
		expect(p1.groups[0]!.id).not.toBe("g1");
		expect(p1.nodes.find((n) => n.id === "a")?.group).toBe(p1.groups[0]!.id);
	});

	test("applySuggestion refuses to add an edge when from or to node no longer exists", () => {
		const p = basePlan();
		expect(applySuggestion(p, { type: "edge", key: "edge:n1>ghost", from: "n1", to: "ghost" }, new Map())).toBeNull();
		expect(applySuggestion(p, { type: "edge", key: "edge:ghost>n3", from: "ghost", to: "n3" }, new Map())).toBeNull();
		expect(applySuggestion(p, { type: "edge", key: "edge:n1>n1", from: "n1", to: "n1" }, new Map())).toBeNull();
		const valid = applySuggestion(p, { type: "edge", key: "edge:n1>n3", from: "n1", to: "n3" }, new Map());
		expect(valid?.edges).toContainEqual({ from: "n1", to: "n3" });
	});

	test("manualPlanDrift strips .ssl/.srvscr/.ds extensions so path refs do not emit false-positive drift", () => {
		const p: Plan = {
			version: 1,
			title: "Paths",
			targets: ["Sample/Release.ssl"],
			groups: [],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "call", text: "Call script", ref: "Sample/Release.ssl" },
				{ id: "n3", kind: "call", text: "Read holidays", ref: "src/DueDates/Holidays.ds" },
				{ id: "n4", kind: "end", text: "End" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
				{ from: "n3", to: "n4" },
			],
		};
		const readings = new Map<string, Reading | null>([
			[
				"Sample/Release.ssl",
				{
					name: "Sample.Release",
					procedures: [{ name: "Main", line: 1 }],
					edges: [{ from: "Main", target: "DueDates.Holidays", resolved: true }],
				},
			],
		]);
		expect(manualPlanDrift(p, readings, undefined, ["Sample/Release.ssl"])).toEqual([]);
	});

	test("overLimit handles object-form targets and treats limit <= 0 as disabled", () => {
		const p: Plan = { ...basePlan(), targets: [{ script: "Sample/Obj.ssl" }] as any };
		expect(overLimit(p, [{ name: "A", lines: 500 }], 400)).toEqual([{ script: "Sample/Obj.ssl", lines: 500 }]);
		expect(overLimit(p, [{ name: "A", lines: 500 }], 0)).toEqual([]);
		expect(overLimit(p, [{ name: "A", lines: 500 }], -10)).toEqual([]);
	});

	test("copyPlanSelection and pastePlanSelection preserve custom fields, cap pasted Start nodes, and scope groups across plans", () => {
		const source: Plan = {
			version: 1,
			title: "Source",
			groups: [{ id: "g1", name: "Intake" }],
			nodes: [
				{ id: "n1", kind: "start", text: "S1", custom: "yes" },
				{ id: "n2", kind: "start", text: "S2", group: "g1" },
			],
			edges: [{ from: "n1", to: "n2", customEdge: 99 }],
		};
		const clip = copyPlanSelection(source, new Set(["n1", "n2"]), "/ws/design/A.plan.json")!;

		// Pasting two starts into a plan with NO start keeps only the first as start; second becomes step
		const targetNoStart: Plan = {
			version: 1,
			title: "Target",
			groups: [{ id: "g1", name: "Unrelated Billing Stage" }],
			nodes: [{ id: "m1", kind: "end", text: "Done" }],
			edges: [],
		};
		const pastedOther = pastePlanSelection(targetNoStart, clip, "DOWN", 24, "/ws/design/B.plan.json");
		const [p1, p2] = pastedOther.pastedIds.map((id) => pastedOther.plan.nodes.find((n) => n.id === id)!);
		expect(p1!.kind).toBe("start");
		expect(p1!.custom).toBe("yes");
		expect(p2!.kind).toBe("step");
		// Cross-plan paste does NOT attach g1 to unrelated "Unrelated Billing Stage"
		expect(p2!.group).toBeUndefined();
		expect(pastedOther.plan.edges.find((e) => e.from === p1!.id && e.to === p2!.id)?.customEdge).toBe(99);

		// Cross-plan paste attaches by matching stage name when present
		const targetMatchingName: Plan = {
			version: 1,
			title: "Target2",
			groups: [{ id: "g9", name: "intake" }],
			nodes: [],
			edges: [],
		};
		const pastedMatched = pastePlanSelection(targetMatchingName, clip, "DOWN", 24, "/ws/design/C.plan.json");
		expect(pastedMatched.plan.nodes.find((n) => n.id === pastedMatched.pastedIds[1])?.group).toBe("g9");
	});

	test("decisionsOf and openQuestions safely ignore null/non-object entries and non-string fields", () => {
		const messy: Plan = {
			...basePlan(),
			decisions: [null, 42, { nope: 1 }, { question: "Q1?", answer: "A1" }, { question: "Q2?", answer: 999 }, { question: "Q3?" }] as any,
		};
		expect(decisionsOf(messy).map((d) => d.question)).toEqual(["Q1?", "Q2?", "Q3?"]);
		expect(openQuestions(messy).map((d) => d.question)).toEqual(["Q2?", "Q3?"]);
	});
});

describe("R3B — build.ts bannerFor, assembleScript, scriptOf, judgeUnit, and runFileName", () => {
	test("bannerFor sanitizes ; and newlines and protects $& / $$ / ${2:...} from regex replacement", () => {
		const plan: Plan = {
			...basePlan(),
			goal: "Price $& and $$100; handle ${2:secret}\nsecond line;",
		};
		const banner = bannerFor(plan);
		const lines = banner.split("\n");
		const desc = lines.find((l) => l.startsWith("Description.. : "))!;
		expect(desc).toBe("Description.. : Price $& and $$100, handle ${2:secret} second line,");
		expect(desc).not.toContain(";");
		expect(banner).toContain("Parameters... : -");
		expect(banner).toContain("Returns...... : -");
		// Only one `;` in the entire banner: the closing `*/;`
		expect((banner.match(/;/g) ?? []).length).toBe(1);
	});

	test("assembleScript sanitizes ; and newlines in stage group names and preserves CRLF line endings", () => {
		const plan: Plan = {
			...basePlan(),
			groups: [{ id: "g1", name: "Validate; check\nrules" }],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "step", text: "Work", group: "g1" },
				{ id: "n3", kind: "end", text: "End" },
			],
		};
		const unit: BuildUnit = { name: "DoWork", status: "passed", attempts: 1, nodes: ["n2"], code: ":PROCEDURE DoWork;\n:ENDPROC;" };
		const out = assembleScript("/* Existing;\r\n", "", [unit], plan);
		expect(out).toContain("/* region Validate, check rules;");
		expect(out).not.toContain("/* region Validate;");
		// Every newline is CRLF (zero bare LF)
		expect(out.replace(/\r\n/g, "")).not.toContain("\n");
	});

	test("scriptOf supports object targets and ignores empty unit.script; judgeUnit treats limit 0 as disabled", () => {
		const plan: Plan = { ...basePlan(), targets: [{ script: "Sample/ObjectTarget.ssl" }] as any };
		expect(scriptOf({ name: "P", script: "" }, plan)).toBe("Sample/ObjectTarget.ssl");
		expect(scriptOf({ name: "P", script: "   " }, plan)).toBe("Sample/ObjectTarget.ssl");

		const j: Judged = {
			unit: { name: "P", parameters: [], calls: [] },
			code: ":PROCEDURE P;\n:ENDPROC;",
			before: [],
			after: [],
			existing: [],
			symbols: [{ name: "P", parameters: [] }],
			edges: [],
			planned: [],
			mustCall: [],
			size: { bytes: 999_999, codeLines: 9999 },
			limits: { bytes: 0, codeLines: 0 },
		};
		expect(judgeUnit(j)).toEqual([]);
	});

	test("runFileName distinguishes sibling directories with the same plan filename", () => {
		const a = runFileName("design/a/Release.plan.json");
		const b = runFileName("design/b/Release.plan.json");
		expect(a).not.toBe(b);
		expect(a).toMatch(/^Release-[0-9a-f]+\.run\.json$/);
		expect(b).toMatch(/^Release-[0-9a-f]+\.run\.json$/);
	});
});

describe("R3B — textModel.ts & run.ts context path guards", () => {
	test("matchPathsForChoices does not report uniqueOutcome when matching paths mix an end node with a dead-end step", () => {
		const plan: Plan = {
			version: 1,
			title: "Mixed Outcomes",
			groups: [],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "decision", text: "Which way?" },
				{ id: "n3", kind: "step", text: "Dead end step" },
				{ id: "n4", kind: "end", text: "Done" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3", label: "dead" },
				{ from: "n2", to: "n4", label: "ok" },
			],
		};
		const { paths } = planPaths(plan);
		expect(paths).toHaveLength(2);
		const both = matchPathsForChoices(plan, paths, {});
		expect(both.matchingPathIndices).toEqual([0, 1]);
		expect(both.uniqueOutcome).toBeNull();

		const okOnly = matchPathsForChoices(plan, paths, { n2: "ok" });
		expect(okOnly.uniqueOutcome?.id).toBe("n4");

		const deadOnly = matchPathsForChoices(plan, paths, { n2: "dead" });
		expect(deadOnly.uniqueOutcome).toBeNull();
	});

	test("planTextOutline safely coerces/guards non-string ref, notes, and edge label", () => {
		const messy: Plan = {
			version: 1,
			title: "Messy",
			groups: [],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "step", text: "Work", ref: 123 as any, notes: { bad: 1 } as any },
				{ id: "n3", kind: "end", text: "End" },
			],
			edges: [
				{ from: "n1", to: "n2", label: true as any },
				{ from: "n2", to: "n3", label: null as any },
			],
		};
		const outline = planTextOutline(messy);
		expect(outline.rowById.get("n2")?.node.ref).toBe("123");
		expect(outline.rowById.get("n2")?.node.notes).toBeUndefined();
		expect(outline.rowById.get("n1")?.allOutgoing[0]?.label).toBe("true");
		expect(outline.rowById.get("n2")?.allOutgoing[0]?.label).toBeUndefined();
	});

	test("isAllowedContextPath rejects hidden dotfiles, .git, .ssl-studio, traversal, and absolute paths", () => {
		expect(isAllowedContextPath("Sample/Orders.ssl")).toBe(true);
		expect(isAllowedContextPath("src/DueDates/Holidays.ds")).toBe(true);
		expect(isAllowedContextPath("docs/specs/DueDates.md")).toBe(true);

		expect(isAllowedContextPath(".env")).toBe(false);
		expect(isAllowedContextPath(".env.local")).toBe(false);
		expect(isAllowedContextPath("sub/.env.production")).toBe(false);
		expect(isAllowedContextPath(".git/config")).toBe(false);
		expect(isAllowedContextPath(".ssl-studio/plans/Release.run.json")).toBe(false);
		expect(isAllowedContextPath("src\\.env")).toBe(false);
		expect(isAllowedContextPath("../secret.txt")).toBe(false);
		expect(isAllowedContextPath("src/../../etc/passwd")).toBe(false);
		expect(isAllowedContextPath("/etc/passwd")).toBe(false);
		expect(isAllowedContextPath("C:\\Windows\\win.ini")).toBe(false);
		expect(isAllowedContextPath("")).toBe(false);
		expect(isAllowedContextPath("   ")).toBe(false);
		expect(isAllowedContextPath("src/file\0.ssl")).toBe(false);
	});
});
