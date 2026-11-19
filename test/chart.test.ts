import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateWidth } from "../src/view/graph/canvas";
import { backEdges, chartGraph, cycleEdge, describeEdge, describeNode, KEYS, labelPoint, LINE, NO_WORDS, onDiamond, routeOf, sizeNode, statusMark, statusWords, wrapText } from "../src/view/plan/chart";
import { parsePlan, type NodeKind, type Plan } from "../src/view/plan/model";

const read = (path: string) => parsePlan(readFileSync(join(import.meta.dir, "..", path), "utf8")).plan!;
// A chart with a loop, kept here so that the demo project's own plan can change without changing what is tested.
const dueDates = read("test/data/loop.plan.json");
const release = read("fixtures/workspace/design/Release.plan.json");
/** Seven pixels a letter: a measure a test can do sums with. */
const seven = (s: string) => s.length * 7;
const plan = (nodes: [string, NodeKind?][], edges: [string, string][], extra: Partial<Plan> = {}): Plan => ({
	version: 1,
	title: "t",
	groups: [],
	nodes: nodes.map(([id, kind]) => ({ id, kind: kind ?? "step", text: id })),
	edges: edges.map(([from, to]) => ({ from, to })),
	...extra,
});
const named = (p: Plan, set: Set<number>) => [...set].map((i) => `${p.edges[i]!.from}>${p.edges[i]!.to}`).sort();

describe("a node's words", () => {
	test("wrap to a measured width, between words", () => {
		expect(wrapText("Read the samples that have no due date", 140, seven)).toEqual(["Read the samples", "that have no due", "date"]);
		for (const line of wrapText("Read the samples that have no due date", 140, seven)) expect(seven(line)).toBeLessThanOrEqual(140);
	});
	test("lose nothing and keep their order", () => {
		const text = "Return how many were set, and which were skipped and why";
		expect(wrapText(text, 90, seven).join(" ")).toBe(text);
	});
	test("never break inside a word", () => {
		expect(wrapText("Supercalifragilisticexpialidocious step", 70, seven)).toEqual(["Supercalifragilisticexpialidocious", "step"]);
	});
	test("a long dotted name breaks after its dots, and nowhere else", () => {
		expect(wrapText("DueDates.DueRule.DueDate", 100, seven)).toEqual(["DueDates.", "DueRule.", "DueDate"]);
		expect(wrapText("Call DueDates.DueRule.DueDate now", 130, seven)).toEqual(["Call DueDates.", "DueRule.DueDate", "now"]);
		expect(wrapText("src/DueDates/Set_Sample-Dates.ssl", 100, seven).join("")).toBe("src/DueDates/Set_Sample-Dates.ssl");
	});
	test("a name that fits is left whole", () => {
		expect(wrapText("DueDates.DueRule.DueDate", 200, seven)).toEqual(["DueDates.DueRule.DueDate"]);
	});
	test("no words yet says so", () => {
		expect(wrapText("   ", 200, seven)).toEqual([NO_WORDS]);
	});
});

describe("a node's size", () => {
	const kinds: NodeKind[] = ["start", "end", "step", "call", "decision"];
	const long = "LoadSampleDueDateTurnaroundRulesForEveryPriority";
	test("is never narrower than its words", () => {
		for (const kind of kinds)
			for (const text of ["Go", "Read the samples that have no due date", long, `Call ${long} and then ${long}`]) {
				const size = sizeNode(kind, text, seven);
				expect(size.width).toBeGreaterThan(Math.max(...size.lines.map(seven)));
				expect(size.height).toBeGreaterThan(size.lines.length * LINE);
			}
	});
	test("a call grows to hold a long procedure name, clear of its two bars", () => {
		const short = sizeNode("call", "Check the id", seven);
		const size = sizeNode("call", long, seven);
		expect(short.width).toBe(190);
		expect(size.lines).toEqual([long]);
		// The bars stand 10 in from each side.
		expect((size.width - seven(long)) / 2).toBeGreaterThanOrEqual(20);
	});
	test("a decision's words fit inside its diamond, however many lines", () => {
		for (const text of ["More?", "Has it a received date and a turnaround?", "Has the sample got a received date and a turnaround and an instrument that is available today?", long]) {
			const size = sizeNode("decision", text, seven);
			const words = { width: Math.max(...size.lines.map(seven)), height: size.lines.length * LINE };
			expect(words.width / size.width + words.height / size.height).toBeLessThanOrEqual(1);
		}
	});
	test("ordinary words keep the shapes their usual width", () => {
		const measure = (s: string) => estimateWidth(s, 13);
		expect(sizeNode("step", "Begin a transaction", measure)).toEqual({ lines: ["Begin a transaction"], width: 190, height: 37 });
		expect(sizeNode("start", "A sample id arrives", measure).width).toBe(170);
		expect(sizeNode("decision", "Is the id usable?", measure).width).toBe(230);
	});
});

describe("loops", () => {
	test("the demo plan's loop closes with the two edges back to its decision", () => {
		expect(named(dueDates, backEdges(dueDates.nodes, dueDates.edges))).toEqual(["n11>n6", "n12>n6"]);
	});
	test("a plan with no loop has none", () => {
		expect(backEdges(release.nodes, release.edges).size).toBe(0);
	});
	test("two ways to one node are not a loop", () => {
		const p = plan([["a", "start"], ["b"], ["c"], ["d", "end"]], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"], ["b", "c"]]);
		expect(backEdges(p.nodes, p.edges).size).toBe(0);
	});
	test("the walk starts at the start, wherever the plan lists it", () => {
		const p = plan([["c"], ["b"], ["a", "start"]], [["c", "a"], ["b", "c"], ["a", "b"]]);
		expect(named(p, backEdges(p.nodes, p.edges))).toEqual(["c>a"]);
	});
	test("nested loops, a loop to itself, and a loop nothing leads to", () => {
		const p = plan(
			[["a", "start"], ["b"], ["c"], ["d", "end"], ["x"], ["y"]],
			[["a", "b"], ["b", "c"], ["c", "b"], ["c", "a"], ["c", "d"], ["b", "b"], ["x", "y"], ["y", "x"]],
		);
		expect(named(p, backEdges(p.nodes, p.edges))).toEqual(["b>b", "c>a", "c>b", "y>x"]);
	});
	test("an edge to nothing is passed over", () => {
		const p = plan([["a", "start"], ["b"]], [["a", "nowhere"], ["a", "b"], ["b", "a"]]);
		expect(named(p, backEdges(p.nodes, p.edges))).toEqual(["b>a"]);
	});
});

describe("what ELK is asked", () => {
	const sizes = (p: Plan) => new Map(p.nodes.map((n) => [n.id, sizeNode(n.kind, n.text, seven)]));
	/** The node each end of an ELK edge is on, a port standing for its node. */
	const ends = (p: Plan) => {
		const { graph } = chartGraph(p, sizes(p));
		const owner = new Map<string, string>();
		const walk = (n: (typeof graph)["children"] extends (infer T)[] | undefined ? T : never) => {
			for (const port of n.ports ?? []) owner.set(port.id, n.id);
			for (const c of n.children ?? []) walk(c);
		};
		for (const c of graph.children ?? []) walk(c);
		return graph.edges.map((e) => ({ from: owner.get(e.sources[0]!) ?? e.sources[0]!, to: owner.get(e.targets[0]!) ?? e.targets[0]! }));
	};
	const acyclic = (edges: { from: string; to: string }[]) => {
		const left = new Set(edges.flatMap((e) => [e.from, e.to]));
		let open = edges.filter((e) => e.from !== e.to);
		while (left.size) {
			const free = [...left].filter((id) => !open.some((e) => e.to === id));
			if (!free.length) return false;
			for (const id of free) left.delete(id);
			open = open.filter((e) => !free.includes(e.from));
		}
		return true;
	};
	test("a loop's closing edges are given reversed, so they cannot set the layers", () => {
		const { reversed, edges } = chartGraph(dueDates, sizes(dueDates));
		expect([...reversed].map((i) => `${edges[i]!.from}>${edges[i]!.to}`).sort()).toEqual(["n11>n6", "n12>n6"]);
		const given = ends(dueDates);
		expect(given).toContainEqual({ from: "n6", to: "n11" });
		expect(given).toContainEqual({ from: "n6", to: "n12" });
		expect(given).toContainEqual({ from: "n6", to: "n7" });
	});
	test("what ELK gets has no cycle left in it, whatever the plan", () => {
		expect(acyclic(dueDates.edges)).toBe(false);
		expect(acyclic(ends(dueDates))).toBe(true);
		const tangled = plan([["a", "start"], ["b", "decision"], ["c"], ["d", "end"]], [["a", "b"], ["b", "c"], ["c", "b"], ["c", "a"], ["b", "d"], ["d", "a"], ["c", "c"]]);
		expect(acyclic(ends(tangled))).toBe(true);
	});
	const find = (graph: ReturnType<typeof chartGraph>["graph"], id: string) => [...(graph.children ?? []), ...(graph.children ?? []).flatMap((c) => c.children ?? [])].find((n) => n.id === id)!;
	/** The side of a node each of its edges meets it by: "n6>n7" leaves n6 by `from` and reaches n7 by `to`. */
	const sides = (p: Plan, loopTip?: "EAST" | "WEST") => {
		const { graph, edges, reversed } = chartGraph(p, sizes(p), loopTip);
		const side = (node: string, port: string) => find(graph, node).ports?.find((q) => q.id === port)?.layoutOptions?.["elk.port.side"];
		return new Map(edges.map((e, i) => [`${e.from}>${e.to}`, reversed.has(i) ? { from: side(e.from, graph.edges[i]!.targets[0]!), to: side(e.to, graph.edges[i]!.sources[0]!) } : { from: side(e.from, graph.edges[i]!.sources[0]!), to: side(e.to, graph.edges[i]!.targets[0]!) }]));
	};
	test("a reversed edge leaves the top of the node it returns to and reaches the bottom of the node it leaves", () => {
		const { graph } = chartGraph(dueDates, sizes(dueDates));
		expect(sides(dueDates).get("n12>n6")).toEqual({ from: "SOUTH", to: "NORTH" });
		expect(find(graph, "n6").layoutOptions).toEqual({ "elk.portConstraints": "FIXED_SIDE" });
		expect(find(graph, "n8").ports).toBeUndefined();
	});
	test("a decision is met at its points: in at the top, on at the bottom, the other way out of a side", () => {
		const met = sides(dueDates);
		expect(met.get("n5>n6")).toEqual({ from: undefined, to: "NORTH" });
		expect(met.get("n6>n7")).toEqual({ from: "SOUTH", to: "NORTH" });
		expect(met.get("n6>n13")).toEqual({ from: "EAST", to: undefined });
		expect(met.get("n7>n12")).toEqual({ from: "EAST", to: undefined });
	});
	test("every way into a decision shares the one point at its top", () => {
		const { graph, edges } = chartGraph(dueDates, sizes(dueDates));
		const into = edges.map((e, i) => ({ e, i })).filter(({ e }) => e.to === "n6");
		expect(into.length).toBe(3);
		expect(find(graph, "n6").ports!.filter((p) => p.layoutOptions?.["elk.port.side"] === "NORTH").length).toBe(1);
	});
	test("the way on goes down even when the way that closes a loop was drawn first, and the loop takes the side asked for", () => {
		// n11's first way out closes the loop; its second goes on.
		expect(sides(dueDates).get("n11>n12")!.from).toBe("SOUTH");
		expect(sides(dueDates).get("n11>n6")!.from).toBe("EAST");
		expect(sides(dueDates, "WEST").get("n11>n6")!.from).toBe("WEST");
		expect(chartGraph(dueDates, sizes(dueDates)).sided).toBe(true);
		expect(chartGraph(release, sizes(release)).sided).toBe(false);
	});
	test("a third way out takes the other side", () => {
		const p = plan([["a", "start"], ["d", "decision"], ["x"], ["y"], ["z"]], [["a", "d"], ["d", "x"], ["d", "y"], ["d", "z"]]);
		expect(["d>x", "d>y", "d>z"].map((k) => sides(p).get(k)!.from)).toEqual(["SOUTH", "EAST", "WEST"]);
	});
	test("a loop to itself is left for ELK to draw", () => {
		const p = plan([["a", "start"], ["b"]], [["a", "b"], ["b", "b"]]);
		const { graph, reversed } = chartGraph(p, sizes(p));
		expect(reversed.size).toBe(0);
		expect(graph.edges[1]).toEqual({ id: "e1", sources: ["b"], targets: ["b"] });
	});
	test("each node goes in at its measured size, grouped as the plan groups it", () => {
		const { graph } = chartGraph(dueDates, sizes(dueDates));
		const group = graph.children!.find((c) => c.id === "g2")!;
		expect(group.children!.map((c) => c.id)).toEqual(["n7", "n8", "n9", "n10", "n11", "n12"]);
		const n9 = group.children!.find((c) => c.id === "n9")!;
		expect({ width: n9.width, height: n9.height }).toEqual({ width: sizes(dueDates).get("n9")!.width, height: sizes(dueDates).get("n9")!.height });
	});
	test("a second node with a used id, an edge to nothing and an empty group are not drawn", () => {
		const p = plan([["a", "start"], ["a"], ["b"]], [["a", "b"], ["b", "gone"]], { groups: [{ id: "g1", name: "Empty" }] });
		const { graph, nodes, edges, groups } = chartGraph(p, sizes(p));
		expect(nodes.map((n) => n.kind)).toEqual(["start", "step"]);
		expect(edges.length).toBe(1);
		expect(groups).toEqual([]);
		expect(graph.children!.map((c) => c.id)).toEqual(["a", "b"]);
	});
	test("a port never takes a node's id", () => {
		const p = plan([["port:1:in", "start"], ["b"]], [["port:1:in", "b"], ["b", "port:1:in"]]);
		const { graph } = chartGraph(p, sizes(p));
		const ports = graph.children!.flatMap((c) => c.ports ?? []).map((x) => x.id);
		expect(ports.length).toBe(2);
		for (const id of ports) expect(p.nodes.some((n) => n.id === id)).toBe(false);
	});
});

describe("an edge as drawn", () => {
	const box = { x: 100, y: 100, width: 200, height: 80 };
	test("meets a decision at its outline, not at the box around it", () => {
		expect(onDiamond({ x: 200, y: 100 }, box)).toEqual({ x: 200, y: 100 });
		expect(onDiamond({ x: 250, y: 100 }, box)).toEqual({ x: 250, y: 120 });
		expect(onDiamond({ x: 150, y: 180 }, box)).toEqual({ x: 150, y: 160 });
		expect(onDiamond({ x: 100, y: 120 }, box)).toEqual({ x: 150, y: 120 });
		expect(onDiamond({ x: 300, y: 140 }, box)).toEqual({ x: 300, y: 140 });
	});
	test("a point that is not on the box is left alone", () => {
		expect(onDiamond({ x: 200, y: 60 }, box)).toEqual({ x: 200, y: 60 });
	});
	test("a reversed route runs from the edge's start to its end", () => {
		const elk = [{ x: 250, y: 100 }, { x: 250, y: 60 }, { x: 500, y: 60 }, { x: 500, y: 400 }];
		expect(routeOf(elk, true, undefined, box)).toEqual([{ x: 500, y: 400 }, { x: 500, y: 60 }, { x: 250, y: 60 }, { x: 250, y: 120 }]);
		expect(routeOf(elk, false, box, undefined)[0]).toEqual({ x: 250, y: 120 });
		expect(routeOf([], true, box, box)).toEqual([]);
	});
	test("a label sits on the first stretch with room for it, by the node the edge leaves", () => {
		const route = [{ x: 219, y: 571 }, { x: 219, y: 597 }, { x: 414, y: 597 }, { x: 414, y: 668 }];
		expect(labelPoint(route, 30)).toEqual({ x: 316.5, y: 597 });
		expect(labelPoint([{ x: 142, y: 570 }, { x: 142, y: 906 }], 30)).toEqual({ x: 142, y: 738 });
	});
	test("with no room anywhere, the longest stretch has it", () => {
		expect(labelPoint([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 20 }], 40)).toEqual({ x: 15, y: 10 });
		expect(labelPoint([], 40)).toEqual({ x: 0, y: 0 });
	});
});

describe("choosing an edge from the keyboard", () => {
	const edges = dueDates.edges;
	test("goes round a decision's ways out, in the plan's order", () => {
		const first = cycleEdge(edges, "n6", null);
		expect(first).toEqual({ from: "n6", to: "n7" });
		const second = cycleEdge(edges, "n6", first);
		expect(second).toEqual({ from: "n6", to: "n13" });
		expect(cycleEdge(edges, "n6", second)).toEqual(first);
	});
	test("goes backwards too", () => {
		expect(cycleEdge(edges, "n6", null, -1)).toEqual({ from: "n6", to: "n13" });
		expect(cycleEdge(edges, "n6", { from: "n6", to: "n7" }, -1)).toEqual({ from: "n6", to: "n13" });
	});
	test("an edge chosen on another node does not count", () => {
		expect(cycleEdge(edges, "n11", { from: "n6", to: "n13" })).toEqual({ from: "n11", to: "n6" });
	});
	test("a node with one way out keeps it, and an end has none", () => {
		const only = cycleEdge(edges, "n1", null);
		expect(cycleEdge(edges, "n1", only)).toEqual(only);
		expect(cycleEdge(edges, "n14", null)).toBeNull();
	});
	test("every edge of the plan can be reached", () => {
		const reached = new Set<string>();
		for (const node of dueDates.nodes) {
			let at = cycleEdge(edges, node.id, null);
			for (let i = 0; at && i < 10; i++) {
				reached.add(`${at.from}>${at.to}`);
				at = cycleEdge(edges, node.id, at);
			}
		}
		expect(reached.size).toBe(edges.length);
	});
});

describe("a node's state in words and as a mark", () => {
	test("passed, changed and stuck each have a mark of their own", () => {
		expect(statusMark({ unit: "passed" })).toBe("passed");
		expect(statusMark({ changed: true })).toBe("changed");
		expect(statusMark({ unit: "stuck" })).toBe("stuck");
		expect(new Set([statusMark({ unit: "passed" }), statusMark({ changed: true }), statusMark({ unit: "stuck" })]).size).toBe(3);
	});
	test("the most pressing wins, and an untouched node has none", () => {
		expect(statusMark({ unit: "stuck", changed: true, gone: true })).toBe("stuck");
		expect(statusMark({ unit: "passed", gone: true })).toBe("gone");
		expect(statusMark({ unit: "passed", changed: true })).toBe("changed");
		expect(statusMark({ unit: "running" })).toBe("running");
		expect(statusMark({ unit: "skipped" })).toBe("skipped");
		expect(statusMark({ unit: "kept" })).toBeNull();
		expect(statusMark({})).toBeNull();
	});
	test("a node is named by its words, its kind and its state", () => {
		expect(describeNode({ text: "Is the id usable?", kind: "decision" })).toBe("Is the id usable?, decision");
		expect(describeNode({ text: "Check the id", kind: "call", ref: "IsUsableId" }, { unit: "passed", built: true })).toBe("Check the id, call to IsUsableId, passed, has code");
		expect(describeNode({ text: "Mark the sample released", kind: "step" }, { unit: "stuck", findings: 2 })).toBe("Mark the sample released, step, stuck, 2 findings");
		expect(describeNode({ text: " ", kind: "step" }, { suggested: true })).toBe(`${NO_WORDS}, step, suggested by the agent`);
	});
	test("everything that is so is said", () => {
		expect(statusWords({ unit: "passed", changed: true, findings: 1 })).toEqual(["passed", "changed since it was built", "1 finding"]);
		expect(statusWords({ gone: true, built: true })).toEqual(["its procedure has gone from the code"]);
		expect(statusWords({})).toEqual([]);
	});
	test("an edge is named by where it runs and its label", () => {
		expect(describeEdge(dueDates, { from: "n6", to: "n13" })).toBe('Way out of "Is there another sample?" to "Commit the transaction", labelled no');
		expect(describeEdge(dueDates, { from: "n1", to: "n2" })).toBe('Way out of "Run, with no parameters" to "Read the holidays", no label');
		const unlabelled = { ...dueDates, edges: dueDates.edges.map((e) => (e.from === "n6" && e.to === "n13" ? { from: e.from, to: e.to } : e)) };
		expect(describeEdge(unlabelled, { from: "n6", to: "n13" })).toContain("a decision's branch needs one");
	});
});

describe("the chart's keys", () => {
	const keys = KEYS.map(([key]) => key);
	test("Tab is not one of them: it moves on to the next control", () => {
		expect(keys.some((key) => /tab/i.test(key))).toBe(false);
	});
	test("a branch, an edge and a connection each have a key", () => {
		expect(KEYS.find(([key]) => key === "B")?.[1]).toContain("branch");
		expect(KEYS.find(([key]) => key.startsWith("E,"))?.[1]).toContain("way out");
		expect(KEYS.find(([key]) => key === "C")?.[1]).toContain("Connect");
	});
	test("no key is listed twice", () => {
		expect(new Set(keys).size).toBe(keys.length);
	});
});

import { crossings } from "../src/view/plan/chart";

describe("ways that cross", () => {
	test("two ways that pass through each other cross once", () => {
		expect(crossings([[{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 5, y: -5 }, { x: 5, y: 5 }]])).toBe(1);
	});
	test("ways that meet at an end, or run side by side, do not cross", () => {
		const down = [{ x: 0, y: 0 }, { x: 0, y: 10 }];
		expect(crossings([down, [{ x: -5, y: 10 }, { x: 0, y: 10 }]])).toBe(0);
		expect(crossings([down, [{ x: 4, y: 0 }, { x: 4, y: 10 }]])).toBe(0);
	});
	test("a way does not cross itself, and each crossing of two ways counts", () => {
		const zigzag = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
		expect(crossings([zigzag])).toBe(0);
		expect(crossings([zigzag, [{ x: 5, y: -5 }, { x: 5, y: 15 }]])).toBe(2);
	});
});
