import { describe, expect, test } from "bun:test";
import {
	alignPlanNodes,
	batchOffsetPlanNodes,
	buildDriftAgentDraft,
	buildPlanAgentDraft,
	buildStageAgentDraft,
	buildStepAgentDraft,
	buildTestsAgentDraft,
	copyPlanSelection,
	findMatchingPlanNodeLine,
	marqueeNodeIds,
	mermaidToPlan,
	pastePlanSelection,
	planToMermaid,
	type NodeRect,
} from "../src/view/plan/assist";
import { parsePlan, printPlan, type Plan } from "../src/view/plan/model";

const samplePlan = (): Plan => ({
	version: 1,
	title: "Sample Approval Flow",
	ticket: "DEMO-101",
	targets: ["src/Samples/ApproveSample.ssl"],
	groups: [
		{ id: "g1", name: "Intake" },
		{ id: "g2", name: "Review" },
	],
	nodes: [
		{ id: "n1", kind: "start", text: "Receive sample" },
		{ id: "n2", kind: "step", text: 'Check "rush" flag <v1>\non sample', group: "g1", ref: "Samples.CheckRush", docs: ["docs/specs/rush-rules.md"] },
		{ id: "n3", kind: "decision", text: "Needs supervisor?", group: "g1" },
		{ id: "n4", kind: "call", text: "Samples.NotifyLead", ref: "Samples.NotifyLead", group: "g2" },
		{ id: "n5", kind: "step", text: "Mark approved", group: "g2" },
		{ id: "n6", kind: "end", text: "Done" },
	],
	edges: [
		{ from: "n1", to: "n2" },
		{ from: "n2", to: "n3" },
		{ from: "n3", to: "n4", label: "yes" },
		{ from: "n3", to: "n5", label: "no" },
		{ from: "n4", to: "n5" },
		{ from: "n5", to: "n6" },
	],
});

describe("Round 6 — mermaidToPlan", () => {
	test("parses flowchart TD with subgraphs, shapes [step], {decision}, ((start/end)), ([call]), and labeled edges", () => {
		const src = [
			"```mermaid",
			"flowchart TD",
			"  %% synthetic approval workflow",
			"  s((Start request))",
			'  subgraph g_val["Validation"]',
			"    v[Validate sample fields]",
			"    d{Is urgent?}",
			"  end",
			"  subgraph Dispatch",
			"    c([Samples.NotifyLead])",
			"    ok[Log approval]",
			"  end",
			"  e((Complete))",
			"  s --> v",
			"  v --> d",
			"  d -->|yes| c",
			"  d -- no --> ok",
			"  c -.->|sent| ok",
			"  ok ==> e",
			"  classDef hot fill:#f99",
			"```",
		].join("\n");

		const plan = mermaidToPlan(src, "Imported Approval");
		expect(plan).not.toBeNull();
		expect(plan!.version).toBe(1);
		expect(plan!.title).toBe("Imported Approval");

		// Stages parsed cleanly from subgraphs
		expect(plan!.groups.map((g) => g.name)).toEqual(["Validation", "Dispatch"]);

		const byText = (t: string) => plan!.nodes.find((n) => n.text === t);
		expect(byText("Start request")?.kind).toBe("start");
		expect(byText("Validate sample fields")?.kind).toBe("step");
		expect(byText("Validate sample fields")?.group).toBe(plan!.groups[0]!.id);
		expect(byText("Is urgent?")?.kind).toBe("decision");
		expect(byText("Is urgent?")?.group).toBe(plan!.groups[0]!.id);
		expect(byText("Samples.NotifyLead")?.kind).toBe("call");
		expect(byText("Samples.NotifyLead")?.ref).toBe("Samples.NotifyLead");
		expect(byText("Samples.NotifyLead")?.group).toBe(plan!.groups[1]!.id);
		expect(byText("Log approval")?.kind).toBe("step");
		expect(byText("Complete")?.kind).toBe("end");

		// Labeled & unlabeled edges preserved
		const yesEdge = plan!.edges.find((e) => e.from === byText("Is urgent?")!.id && e.to === byText("Samples.NotifyLead")!.id);
		expect(yesEdge?.label).toBe("yes");
		const noEdge = plan!.edges.find((e) => e.from === byText("Is urgent?")!.id && e.to === byText("Log approval")!.id);
		expect(noEdge?.label).toBe("no");
		const sentEdge = plan!.edges.find((e) => e.from === byText("Samples.NotifyLead")!.id && e.to === byText("Log approval")!.id);
		expect(sentEdge?.label).toBe("sent");
		const endEdge = plan!.edges.find((e) => e.from === byText("Log approval")!.id && e.to === byText("Complete")!.id);
		expect(endEdge).toBeDefined();

		// Printed JSON parses cleanly as a valid Plan
		const reparsed = parsePlan(printPlan(plan!));
		expect(reparsed.error).toBeUndefined();
		expect(reparsed.plan?.nodes.length).toBe(6);
	});

	test("supports graph LR, inline declarations, chained edges, and & fan-out", () => {
		const src = [
			"graph LR",
			"  A((Begin)) --> B[Fetch record] --> C{Valid?}",
			"  C -->|yes| D([Rules.Apply]) & E[Audit log]",
			"  D --> F((Finish))",
			"  E --> F",
		].join("\n");

		const plan = mermaidToPlan(src);
		expect(plan).not.toBeNull();
		expect(plan!.nodes.length).toBe(6);
		const dNode = plan!.nodes.find((n) => n.text === "Rules.Apply");
		expect(dNode?.kind).toBe("call");
		expect(dNode?.ref).toBe("Rules.Apply");
		const cNode = plan!.nodes.find((n) => n.text === "Valid?");
		expect(cNode?.kind).toBe("decision");
		const yesTargets = plan!.edges.filter((e) => e.from === cNode!.id && e.label === "yes").map((e) => e.to);
		expect(yesTargets.length).toBe(2);
	});

	test("round-trips planToMermaid -> mermaidToPlan preserving stages, shapes, escaped text, and edges", () => {
		const orig = samplePlan();
		const mermaid = planToMermaid(orig, "DOWN");
		const imported = mermaidToPlan(mermaid, orig.title);
		expect(imported).not.toBeNull();
		expect(imported!.groups.map((g) => g.name)).toEqual(["Intake", "Review"]);

		const byText = (t: string) => imported!.nodes.find((n) => n.text === t);
		expect(byText("Receive sample")?.kind).toBe("start");
		expect(byText('Check "rush" flag <v1>\non sample')?.kind).toBe("step");
		expect(byText("Needs supervisor?")?.kind).toBe("decision");
		expect(byText("Samples.NotifyLead")?.kind).toBe("call");
		expect(byText("Samples.NotifyLead")?.ref).toBe("Samples.NotifyLead");
		expect(byText("Mark approved")?.kind).toBe("step");
		expect(byText("Done")?.kind).toBe("end");
		expect(imported!.edges.length).toBe(orig.edges.length);

		const yesEdge = imported!.edges.find(
			(e) => e.from === byText("Needs supervisor?")!.id && e.to === byText("Samples.NotifyLead")!.id,
		);
		expect(yesEdge?.label).toBe("yes");
	});

	test("returns null for empty or non-flowchart Mermaid sources", () => {
		expect(mermaidToPlan("")).toBeNull();
		expect(mermaidToPlan("sequenceDiagram\n  A->>B: ping")).toBeNull();
		expect(mermaidToPlan("flowchart TD\n  %% only comments")).toBeNull();
	});
});

describe("Round 6 — Plan multi-select, marquee, align, distribute, and copy/paste", () => {
	const rects: NodeRect[] = [
		{ id: "n2", x: 100, y: 120, width: 140, height: 48 },
		{ id: "n3", x: 260, y: 200, width: 120, height: 60 },
		{ id: "n4", x: 420, y: 150, width: 160, height: 48 },
		{ id: "n5", x: 700, y: 400, width: 140, height: 48 },
	];

	test("marqueeNodeIds selects intersecting nodes regardless of drag direction", () => {
		const forward = marqueeNodeIds(rects, { x: 90, y: 100, width: 360, height: 140 });
		const backward = marqueeNodeIds(rects, { x: 450, y: 240, width: -360, height: -140 });
		expect(forward).toEqual(["n2", "n3", "n4"]);
		expect(backward).toEqual(["n2", "n3", "n4"]);
		expect(marqueeNodeIds(rects, { x: 0, y: 0, width: 20, height: 20 })).toEqual([]);
	});

	test("batchOffsetPlanNodes shifts only selected nodes and preserves layout direction", () => {
		const orig = samplePlan();
		const shifted = batchOffsetPlanNodes(orig, new Set(["n2", "n4"]), 24, -12, "DOWN");
		expect(shifted.nodes.find((n) => n.id === "n2")?.offset).toEqual({ x: 24, y: -12 });
		expect(shifted.nodes.find((n) => n.id === "n4")?.offset).toEqual({ x: 24, y: -12 });
		expect(shifted.nodes.find((n) => n.id === "n3")?.offset).toBeUndefined();

		const shiftedRight = batchOffsetPlanNodes(orig, new Set(["n2"]), 12, 36, "RIGHT");
		expect(shiftedRight.nodes.find((n) => n.id === "n2")?.offset).toEqual({ x: 12, y: 36, dir: "RIGHT" });
	});

	test("alignPlanNodes supports left, center, top, distribute-h, and distribute-v", () => {
		const orig = samplePlan();
		const three = new Set(["n2", "n3", "n4"]);

		const alignedLeft = alignPlanNodes(orig, three, rects, "left", "DOWN");
		expect(alignedLeft.nodes.find((n) => n.id === "n2")?.offset).toBeUndefined();
		expect(alignedLeft.nodes.find((n) => n.id === "n3")?.offset?.x).toBe(-160);
		expect(alignedLeft.nodes.find((n) => n.id === "n4")?.offset?.x).toBe(-320);

		const alignedTop = alignPlanNodes(orig, three, rects, "top", "DOWN");
		expect(alignedTop.nodes.find((n) => n.id === "n2")?.offset).toBeUndefined();
		expect(alignedTop.nodes.find((n) => n.id === "n3")?.offset?.y).toBe(-80);
		expect(alignedTop.nodes.find((n) => n.id === "n4")?.offset?.y).toBe(-30);

		const alignedCenter = alignPlanNodes(orig, new Set(["n2", "n3"]), rects, "center", "DOWN");
		// n2 x=100..240 (cx=170), n3 x=260..380 (cx=320) -> minX=100, maxX=380 -> targetCx=240; n2 moves +70, n3 moves -80
		expect(alignedCenter.nodes.find((n) => n.id === "n2")?.offset?.x).toBe(70);
		expect(alignedCenter.nodes.find((n) => n.id === "n3")?.offset?.x).toBe(-80);

		const distRects: NodeRect[] = [
			{ id: "n2", x: 0, y: 0, width: 100, height: 40 },
			{ id: "n3", x: 120, y: 30, width: 100, height: 40 },
			{ id: "n4", x: 400, y: 200, width: 100, height: 40 },
		];
		const distH = alignPlanNodes(orig, three, distRects, "distribute-h", "DOWN");
		// Total width span = 500, sum widths = 300, gap = 100 -> n3 desired x = 200 -> dx = +80
		expect(distH.nodes.find((n) => n.id === "n3")?.offset?.x).toBe(80);

		const distV = alignPlanNodes(orig, three, distRects, "distribute-v", "DOWN");
		// Total height span = 240, sum heights = 120, gap = 60 -> n3 desired y = 100 -> dy = +70
		expect(distV.nodes.find((n) => n.id === "n3")?.offset?.y).toBe(70);
	});

	test("copyPlanSelection and pastePlanSelection clone selected steps and internal edges with fresh IDs and offset", () => {
		const orig = samplePlan();
		// Selecting n2 + n3 preserves internal edge n2->n3 and drops external edges n1->n2 and n3->n4
		const clip = copyPlanSelection(orig, new Set(["n2", "n3"]));
		expect(clip).not.toBeNull();
		expect(clip!.nodes.map((n) => n.id)).toEqual(["n2", "n3"]);
		expect(clip!.edges).toEqual([{ from: "n2", to: "n3" }]);

		const pasted = pastePlanSelection(orig, clip!, "DOWN", 36);
		expect(pasted.pastedIds.length).toBe(2);
		expect(pasted.plan.nodes.length).toBe(orig.nodes.length + 2);
		const [newN2, newN3] = pasted.pastedIds;
		expect(orig.nodes.some((n) => n.id === newN2 || n.id === newN3)).toBe(false);
		expect(pasted.plan.nodes.find((n) => n.id === newN2)?.offset).toEqual({ x: 36, y: 36 });
		expect(pasted.plan.edges.some((e) => e.from === newN2 && e.to === newN3)).toBe(true);

		// Copying a Start node converts the pasted copy to a regular step when Start already exists
		const startClip = copyPlanSelection(orig, new Set(["n1"]));
		const pastedStart = pastePlanSelection(orig, startClip!, "DOWN", 24);
		expect(pastedStart.plan.nodes.find((n) => n.id === pastedStart.pastedIds[0])?.kind).toBe("step");
	});
});

describe("Round 6 — Call Graph to Plan reveal & Agent draft builders", () => {
	test("findMatchingPlanNodeLine locates matching built unit or node.ref line in .plan.json", () => {
		const plan: Plan = {
			...samplePlan(),
			built: {
				units: [
					{
						name: "ApproveBatch",
						script: "src/Samples/ApproveSample.ssl",
						nodes: ["n5"],
					},
				],
			},
		};
		const raw = printPlan(plan);

		const lineByUnit = findMatchingPlanNodeLine(raw, "/ws/src/Samples/ApproveSample.ssl", "ApproveBatch", "/ws");
		expect(lineByUnit).not.toBeNull();
		expect(raw.split("\n")[lineByUnit! - 1]).toContain('"n5"');

		const lineByRef = findMatchingPlanNodeLine(raw, "/ws/src/Samples/NotifyLead.ssl", "NotifyLead", "/ws");
		expect(lineByRef).not.toBeNull();
		expect(raw.split("\n")[lineByRef! - 1]).toContain('"n4"');

		expect(findMatchingPlanNodeLine(raw, "/ws/src/Other/Unrelated.ssl", "Nope", "/ws")).toBeNull();
		expect(findMatchingPlanNodeLine("{ invalid json", "/ws/src/a.ssl")).toBeNull();
	});

	test("Agent draft builders include scoped context without scheduled placeholder text", () => {
		const plan = samplePlan();
		const stepDraft = buildStepAgentDraft(plan, "n2", { planLabel: "design/approval.plan.json" });
		expect(stepDraft).toContain("Sample Approval Flow");
		expect(stepDraft).toContain("Samples.CheckRush");
		expect(stepDraft).toContain("docs/specs/rush-rules.md");
		expect(stepDraft).toContain("Receive sample");
		expect(stepDraft).toContain("Needs supervisor?");
		expect(stepDraft).not.toContain("AGENT-INTEGRATION");
		expect(stepDraft).not.toContain("(scheduled)");

		const stageDraft = buildStageAgentDraft(plan, "g1", { planLabel: "design/approval.plan.json" });
		expect(stageDraft).toContain("Intake");
		expect(stageDraft).toContain("Needs supervisor?");

		const driftDraft = buildDriftAgentDraft(
			plan,
			[{ kind: "gone", unit: "ApproveBatch", node: "n5", message: "Procedure missing from script.", severity: "warning" }],
			{ planLabel: "design/approval.plan.json" },
		);
		expect(driftDraft).toContain("ApproveBatch");
		expect(driftDraft).toContain("Procedure missing from script.");

		const planDraft = buildPlanAgentDraft(plan, { planLabel: "design/approval.plan.json" });
		expect(planDraft).toContain("Sample Approval Flow");
		expect(planDraft).toContain("DEMO-101");

		const testsDraft = buildTestsAgentDraft(plan, { planLabel: "design/approval.plan.json" });
		expect(testsDraft).toContain("STARLIMS SSL unit test script");
		expect(testsDraft).toContain("Sample Approval Flow");
	});
});
