import { describe, expect, test } from "bun:test";
import { checkTables } from "../src/shared/docTables";
import type { DocFile } from "../src/shared/protocol";
import {
	computeImpactAnalysis,
	foldId,
	formatImpactMarkdown,
	fromCallGraph,
	procId,
	ticketSubgraphFilter,
	type Graph,
} from "../src/view/graph/model";
import {
	checkPlanDocs,
	checkPlanRefs,
	manualPlanDrift,
	planHash,
	planToMermaid,
	printSpec,
	refMatchesWorkspace,
	stageRegionDrift,
	syncPlanMermaidInMarkdown,
} from "../src/view/plan/assist";
import type { Reading } from "../src/view/plan/built";
import type { Plan } from "../src/view/plan/model";

const samplePlan = (): Plan => ({
	version: 1,
	title: "Sample Due Date Flow",
	ticket: "DEMO-101",
	targets: ["src/DueDates/SetSampleDueDates.ssl"],
	groups: [
		{ id: "g1", name: "Intake & Validation" },
		{ id: "g2", name: "Persistence" },
		{ id: "g_empty", name: "Unused Stage" },
	],
	nodes: [
		{ id: "n1", kind: "start", text: "Receive sample batch" },
		{ id: "n2", kind: "step", text: 'Load "rush" rules <v2>\nfrom table', group: "g1", ref: "DueDates.DueRules.RuleFor" },
		{ id: "n3", kind: "decision", text: "Is rush sample?", group: "g1" },
		{ id: "n4", kind: "call", text: "DueDates.Holidays", ref: "DueDates.Holidays", group: "g2" },
		{ id: "n5", kind: "step", text: "Save calculated due date", group: "g2" },
		{ id: "n6", kind: "end", text: "Return summary" },
	],
	edges: [
		{ from: "n1", to: "n2" },
		{ from: "n2", to: "n3" },
		{ from: "n3", to: "n4", label: "yes" },
		{ from: "n3", to: "n5", label: "no | standard" },
		{ from: "n4", to: "n5" },
		{ from: "n5", to: "n6" },
	],
});

describe("Wave 4.2 — planToMermaid", () => {
	test("emits deterministic flowchart TD with subgraphs, accurate node shapes, escaped labels, and labeled edges", () => {
		const plan = samplePlan();
		const m1 = planToMermaid(plan);
		const m2 = planToMermaid(plan, "DOWN");
		expect(m1).toBe(m2);
		expect(m1.startsWith("flowchart TD\n")).toBe(true);

		// Stadium shapes for start/end
		expect(m1).toContain('  n1(["Receive sample batch"])');
		expect(m1).toContain('  n6(["Return summary"])');

		// Subgraphs for non-empty stages only (empty group omitted)
		expect(m1).toContain('  subgraph g1["Intake & Validation"]');
		expect(m1).toContain('  subgraph g2["Persistence"]');
		expect(m1).not.toContain("Unused Stage");

		// Escaped double quotes, angle brackets, and newline -> <br/>
		expect(m1).toContain('    n2["Load #quot;rush#quot; rules &lt;v2&gt;<br/>from table"]');
		// Diamond for decision, subroutine for call, rectangle for step
		expect(m1).toContain('    n3{"Is rush sample?"}');
		expect(m1).toContain('    n4[["DueDates.Holidays"]]');
		expect(m1).toContain('    n5["Save calculated due date"]');

		// Plain labeled edge + punctuation-escaped labeled edge
		expect(m1).toContain("  n3 -->|yes| n4");
		expect(m1).toContain('  n3 -->|"no / standard"| n5');
		expect(m1).toContain("  n1 --> n2");
	});

	test("supports horizontal LR direction and safely prefixes reserved Mermaid IDs", () => {
		const plan: Plan = {
			version: 1,
			title: "Reserved IDs",
			groups: [{ id: "end", name: "Closing" }],
			nodes: [
				{ id: "start-1", kind: "start", text: "Begin" },
				{ id: "end", kind: "step", text: "Wrap up", group: "end" },
				{ id: "class", kind: "end", text: "Done" },
			],
			edges: [
				{ from: "start-1", to: "end" },
				{ from: "end", to: "class" },
				{ from: "end", to: "ghost" },
			],
		};
		const out = planToMermaid(plan, "RIGHT");
		expect(out.startsWith("flowchart LR\n")).toBe(true);
		expect(out).toContain('  subgraph stage_end["Closing"]');
		expect(out).toContain('    node_end["Wrap up"]');
		expect(out).toContain('  node_class(["Done"])');
		expect(out).toContain("  start_1 --> node_end");
		expect(out).toContain("  node_end --> node_class");
		expect(out).not.toContain("ghost");
	});
});

describe("Wave 4.2 — syncPlanMermaidInMarkdown", () => {
	test("appends a ## Flow section with markers on first sync and wraps raw Mermaid in a fence", () => {
		const doc = "# Due Date Spec\n\nBusiness rules go here.\n";
		const diagram = planToMermaid(samplePlan());
		const synced = syncPlanMermaidInMarkdown(doc, diagram, "DueDates.plan.json");

		expect(synced.startsWith(doc)).toBe(true);
		expect(synced).toContain("## Flow\n\n_Synced from `DueDates.plan.json`._\n\n<!-- plan-mermaid:start -->\n```mermaid\nflowchart TD\n");
		expect(synced.endsWith("```\n<!-- plan-mermaid:end -->\n")).toBe(true);
	});

	test("handles empty documents without leading blank lines", () => {
		const synced = syncPlanMermaidInMarkdown("", "flowchart TD\n  n1([\"Start\"])");
		expect(synced.startsWith("## Flow\n\n<!-- plan-mermaid:start -->")).toBe(true);
	});

	test("surgically replaces content between markers while preserving surrounding text, $ literals, and CRLF", () => {
		const before = [
			"# Release Spec",
			"",
			"Intro stays untouched.",
			"",
			"## Flow",
			"",
			"<!-- plan-mermaid:start -->",
			"```mermaid",
			"flowchart TD",
			'  n1(["Old start"])',
			"```",
			"<!-- plan-mermaid:end -->",
			"",
			"## Appendix",
			"",
			"Closing prose stays untouched.",
			"",
		].join("\r\n");

		const updatedDiagram = 'flowchart LR\n  n1(["Cost $100 & $&"]) --> n2(["Done"])';
		const after = syncPlanMermaidInMarkdown(before, updatedDiagram);

		// Preserves CRLF everywhere (zero bare LF)
		expect(after.replace(/\r\n/g, "")).not.toContain("\n");
		expect(after).toContain("Intro stays untouched.\r\n\r\n## Flow\r\n\r\n<!-- plan-mermaid:start -->\r\n```mermaid\r\n");
		expect(after).toContain('  n1(["Cost $100 & $&"]) --> n2(["Done"])\r\n```\r\n<!-- plan-mermaid:end -->');
		expect(after).toContain("\r\n\r\n## Appendix\r\n\r\nClosing prose stays untouched.\r\n");
		expect(after).not.toContain("Old start");
	});
});

describe("Wave 4.1 — Call Graph Impact Analysis, Markdown Formatting & Ticket Subgraph", () => {
	function buildWorkspaceGraph(): Graph {
		const u = (p: string) => `file:///w/${p}`;
		const loc = (p: string, l = 0) => ({ uri: u(p), range: { start: { line: l, character: 0 }, end: { line: l + 5, character: 0 } } });
		return fromCallGraph(
			{
				nodes: [
					{ id: u("src/UI/OrderScreen.ssl"), kind: "script", name: "UI.OrderScreen", location: loc("src/UI/OrderScreen.ssl") },
					{ id: `${u("src/UI/OrderScreen.ssl")}#OnSave`, kind: "procedure", name: "OnSave", container: u("src/UI/OrderScreen.ssl"), location: loc("src/UI/OrderScreen.ssl", 10) },
					{ id: u("src/Orders/SubmitOrder.ssl"), kind: "script", name: "Orders.SubmitOrder", location: loc("src/Orders/SubmitOrder.ssl") },
					{ id: `${u("src/Orders/SubmitOrder.ssl")}#Submit`, kind: "procedure", name: "Submit", container: u("src/Orders/SubmitOrder.ssl"), location: loc("src/Orders/SubmitOrder.ssl", 12) },
					{ id: u("src/DueDates/SetSampleDueDates.ssl"), kind: "script", name: "DueDates.SetSampleDueDates", location: loc("src/DueDates/SetSampleDueDates.ssl") },
					{ id: `${u("src/DueDates/SetSampleDueDates.ssl")}#Calculate`, kind: "procedure", name: "Calculate", container: u("src/DueDates/SetSampleDueDates.ssl"), location: loc("src/DueDates/SetSampleDueDates.ssl", 15) },
					{ id: `${u("src/DueDates/SetSampleDueDates.ssl")}#Helper`, kind: "procedure", name: "Helper", container: u("src/DueDates/SetSampleDueDates.ssl"), location: loc("src/DueDates/SetSampleDueDates.ssl", 40) },
					{ id: u("src/DueDates/WorkCalendar.ssl"), kind: "script", name: "DueDates.WorkCalendar", location: loc("src/DueDates/WorkCalendar.ssl") },
					{ id: `${u("src/DueDates/WorkCalendar.ssl")}#NextWorkDay`, kind: "procedure", name: "NextWorkDay", container: u("src/DueDates/WorkCalendar.ssl"), location: loc("src/DueDates/WorkCalendar.ssl", 20) },
					{ id: u("src/DueDates/Holidays.ds"), kind: "dataSource", name: "DueDates.Holidays", location: loc("src/DueDates/Holidays.ds", 0) },
					{ id: u("src/Billing/Invoice.ssl"), kind: "script", name: "Billing.Invoice", location: loc("src/Billing/Invoice.ssl") },
					{ id: `${u("src/Billing/Invoice.ssl")}#PostInvoice`, kind: "procedure", name: "PostInvoice", container: u("src/Billing/Invoice.ssl"), location: loc("src/Billing/Invoice.ssl", 5) },
					{ id: "unresolved:MissingProc", kind: "unresolved", name: "MissingProc" },
				],
				edges: [
					// OnSave (entry) -> Submit -> Calculate -> NextWorkDay -> Holidays.ds
					{ from: `${u("src/UI/OrderScreen.ssl")}#OnSave`, to: `${u("src/Orders/SubmitOrder.ssl")}#Submit`, kind: "ExecFunction", resolved: true },
					{ from: `${u("src/Orders/SubmitOrder.ssl")}#Submit`, to: `${u("src/DueDates/SetSampleDueDates.ssl")}#Calculate`, kind: "ExecFunction", resolved: true },
					{ from: `${u("src/DueDates/SetSampleDueDates.ssl")}#Calculate`, to: `${u("src/DueDates/SetSampleDueDates.ssl")}#Helper`, kind: "DoProc", resolved: true },
					{ from: `${u("src/DueDates/SetSampleDueDates.ssl")}#Helper`, to: `${u("src/DueDates/WorkCalendar.ssl")}#NextWorkDay`, kind: "ExecFunction", resolved: true },
					{ from: `${u("src/DueDates/WorkCalendar.ssl")}#NextWorkDay`, to: u("src/DueDates/Holidays.ds"), kind: "RunDS", resolved: true },
					{ from: `${u("src/DueDates/SetSampleDueDates.ssl")}#Calculate`, to: "unresolved:MissingProc", kind: "DoProc", resolved: false },
					// Unrelated branch
					{ from: `${u("src/Billing/Invoice.ssl")}#PostInvoice`, to: `${u("src/Orders/SubmitOrder.ssl")}#Submit`, kind: "ExecFunction", resolved: true },
				],
			},
			(uri) => uri.replace("file://", ""),
		);
	}

	test("computeImpactAnalysis walks multi-hop callers, flags 0-caller entry points, and separates downstream callees & data sources", () => {
		const g = buildWorkspaceGraph();
		const seed = procId("/w/src/DueDates/SetSampleDueDates.ssl", "Calculate");
		const report = computeImpactAnalysis(g, [seed], 4);

		// Upstream callers: Submit (hop 1, NOT entry point), OnSave & PostInvoice (hop 2, BOTH entry points)
		expect(report.upstream.map((n) => [n.name, n.hop, Boolean(n.entryPoint)])).toEqual([
			["Submit", 1, false],
			["PostInvoice", 2, true],
			["OnSave", 2, true],
		]);
		expect(report.entryPoints.map((n) => n.name).sort()).toEqual(["OnSave", "PostInvoice"]);
		expect(report.upstreamByHop.map((b) => [b.hop, b.nodes.length])).toEqual([
			[1, 1],
			[2, 2],
		]);

		// Downstream callees exclude unresolved targets and separate `.ds` data sources
		expect(report.downstream.map((n) => [n.name, n.hop])).toEqual([
			["Helper", 1],
			["NextWorkDay", 2],
		]);
		expect(report.dataSources.map((n) => [n.name, n.hop])).toEqual([["DueDates.Holidays", 3]]);
	});

	test("computeImpactAnalysis handles cycles safely and supports multi-root ticket script seeds", () => {
		const g: Graph = {
			scripts: [
				{ path: "/w/A.ssl", bytes: 100, procedures: [{ name: "A1", startLine: 1, endLine: 5 }] },
				{ path: "/w/B.ssl", bytes: 100, procedures: [{ name: "B1", startLine: 1, endLine: 5 }] },
				{ path: "/w/C.ssl", bytes: 100, procedures: [{ name: "C1", startLine: 1, endLine: 5 }] },
				{ path: "/w/Entry.ssl", bytes: 100, procedures: [{ name: "Run", startLine: 1, endLine: 5 }] },
			],
			nodes: [
				{ id: "/w/A.ssl#A1", name: "A1", path: "/w/A.ssl", line: 1 },
				{ id: "/w/B.ssl#B1", name: "B1", path: "/w/B.ssl", line: 1 },
				{ id: "/w/C.ssl#C1", name: "C1", path: "/w/C.ssl", line: 1 },
				{ id: "/w/Entry.ssl#Run", name: "Run", path: "/w/Entry.ssl", line: 1 },
			],
			edges: [
				// Cycle A1 <-> B1 -> C1 -> A1, plus Entry.Run -> A1
				{ from: "/w/A.ssl#A1", to: "/w/B.ssl#B1", crossScript: true, sites: [] },
				{ from: "/w/B.ssl#B1", to: "/w/C.ssl#C1", crossScript: true, sites: [] },
				{ from: "/w/C.ssl#C1", to: "/w/A.ssl#A1", crossScript: true, sites: [] },
				{ from: "/w/Entry.ssl#Run", to: "/w/A.ssl#A1", crossScript: true, sites: [] },
			],
			topLevel: [],
		};

		// Multi-root ticket spanning A.ssl and B.ssl (passed as script sentinel + foldId)
		const report = computeImpactAnalysis(g, ["/w/A.ssl#", foldId("/w/B.ssl")], 6);
		expect(report.seeds.map((s) => s.name)).toEqual(["A1", "B1"]);
		// Upstream finds C1 (hop 1, has caller B1 -> not entry) and Run (hop 1, 0 callers -> entry)
		expect(report.upstream.map((n) => [n.name, n.hop, Boolean(n.entryPoint)])).toEqual([
			["C1", 1, false],
			["Run", 1, true],
		]);
		// Downstream finds C1 (hop 1), stops cleanly without revisiting seeds A1/B1
		expect(report.downstream.map((n) => [n.name, n.hop])).toEqual([["C1", 1]]);
	});

	test("formatImpactMarkdown produces crisp ADR 0008-compliant Markdown even with very long names", () => {
		const g = buildWorkspaceGraph();
		const report = computeImpactAnalysis(g, ["/w/src/DueDates/SetSampleDueDates.ssl#"], 4);
		report.targetLabel = "DEMO-101 (Due Dates)";
		report.schemaTables = [{ name: "DEMO_HOLIDAYS", path: "schema/database/DEMO_HOLIDAYS.md" }];
		report.governingDocs = [
			{
				label: "DEMO-101: Very long ticket title describing the entire holiday and rush sample turnaround SLA workflow across labs",
				group: "tickets",
				path: "/w/docs/tickets/DEMO-101.md",
				reason: "governing ticket",
			},
			{
				label: "Due Date Calculation Spec",
				group: "specs",
				path: "/w/docs/specs/DueDates.md",
				reason: "spec reference",
			},
		];
		report.testScripts = ["tests/TestDueDates.ssl"];

		const md = formatImpactMarkdown(report);
		expect(md).toContain("## Impact Analysis: DEMO-101 (Due Dates)");
		expect(md).toContain("### Upstream Callers");
		expect(md).toContain("### Downstream Callees & Data Sources");
		expect(md).toContain("### Schema Tables");
		expect(md).toContain("`DEMO_HOLIDAYS`");
		expect(md).toContain("### Governing Docs & Tickets");
		expect(md).toContain("### Test Scripts");
		expect(md).toContain("`tests/TestDueDates.ssl`");
		expect(md).toContain("Entry point");
		expect(md).toContain("Data source");

		// Strict ADR 0008 table verification (<= 4 cols, <= 16 heading, <= 20 short cols, <= 100 last col)
		expect(checkTables(md)).toEqual([]);
	});

	test("ticketSubgraphFilter isolates ticket scripts with or without 1-hop neighbors", () => {
		const g = buildWorkspaceGraph();
		const ticketPaths = new Set(["/w/src/DueDates/SetSampleDueDates.ssl"]);

		const strict = ticketSubgraphFilter(g, ticketPaths, false);
		expect([...strict].sort()).toEqual([
			"/w/src/DueDates/SetSampleDueDates.ssl#Calculate",
			"/w/src/DueDates/SetSampleDueDates.ssl#Helper",
		]);

		const withOneHop = ticketSubgraphFilter(g, ticketPaths, true);
		expect(withOneHop.has("/w/src/DueDates/SetSampleDueDates.ssl#Calculate")).toBe(true);
		expect(withOneHop.has("/w/src/DueDates/SetSampleDueDates.ssl#Helper")).toBe(true);
		// 1-hop upstream caller and 1-hop downstream callee included
		expect(withOneHop.has("/w/src/Orders/SubmitOrder.ssl#Submit")).toBe(true);
		expect(withOneHop.has("/w/src/DueDates/WorkCalendar.ssl#NextWorkDay")).toBe(true);
		// 2-hop upstream callers and 2-hop downstream data sources excluded
		expect(withOneHop.has("/w/src/UI/OrderScreen.ssl#OnSave")).toBe(false);
		expect(withOneHop.has("/w/src/Billing/Invoice.ssl#PostInvoice")).toBe(false);
		expect(withOneHop.has("/w/src/DueDates/Holidays.ds#DueDates.Holidays")).toBe(false);
	});
});

describe("Wave 1.5 — Plan docs, targets, refs, and lightweight drift validation", () => {
	const mkDoc = (partial: Partial<DocFile> & Pick<DocFile, "path" | "name" | "group">): DocFile => ({
		exists: true,
		...partial,
	});

	test("checkPlanDocs validates node.docs paths, plan.targets, ticket links, and stale companion specs", () => {
		const plan: Plan = {
			...samplePlan(),
			ticket: "DEMO-999",
			targets: ["src/DueDates/SetSampleDueDates.ssl", "src/DueDates/MissingTarget.ssl"],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{
					id: "n2",
					kind: "step",
					text: "Apply rules",
					docs: [
						"docs/knowledge/decisions/0001-holidays.md",
						"docs/knowledge/questions/missing-q.md",
						"DEMO-101",
					],
				},
				{ id: "n3", kind: "end", text: "End" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
			],
		};

		const workspaceDocs: DocFile[] = [
			mkDoc({ path: "/w/docs/tickets/DEMO-101.md", name: "DEMO-101.md", group: "tickets", ticket: "DEMO-101" }),
			mkDoc({
				path: "/w/docs/knowledge/decisions/0001-holidays.md",
				name: "decisions/0001-holidays.md",
				group: "knowledge",
				kind: "decisions",
			}),
		];
		const workspaceFiles = [
			"/w/src/DueDates/SetSampleDueDates.ssl",
			"/w/docs/tickets/DEMO-101.md",
			"/w/docs/knowledge/decisions/0001-holidays.md",
		];
		const staleSpec = printSpec("Old spec", [], [], "deadbeef");

		const findings = checkPlanDocs(plan, {
			tickets: [{ ticket: "DEMO-101" }],
			specText: staleSpec,
			docs: workspaceDocs,
			workspaceFiles,
			root: "/w",
		});

		expect(findings.map((f) => f.code).sort()).toEqual([
			"plan-missing-doc",
			"plan-missing-target",
			"plan-stale-spec",
			"plan-unknown-ticket",
		]);
		expect(findings.find((f) => f.code === "plan-missing-doc")?.node).toBe("n2");
		expect(findings.find((f) => f.code === "plan-missing-doc")?.message).toContain("missing-q.md");
		expect(findings.find((f) => f.code === "plan-missing-target")?.field).toBe("targets");
		expect(findings.find((f) => f.code === "plan-missing-target")?.message).toContain("MissingTarget.ssl");

		// Clean plan produces zero findings
		const cleanPlan: Plan = {
			...plan,
			ticket: "DEMO-101",
			targets: ["src/DueDates/SetSampleDueDates.ssl"],
			nodes: plan.nodes.map((n) => (n.id === "n2" ? { ...n, docs: ["docs/knowledge/decisions/0001-holidays.md", "DEMO-101"] } : n)),
		};
		const freshSpec = printSpec("Fresh spec", [], [], planHash(cleanPlan));
		expect(
			checkPlanDocs(cleanPlan, {
				tickets: [{ ticket: "DEMO-101" }],
				specText: freshSpec,
				docs: workspaceDocs,
				workspaceFiles,
				root: "/w",
			}),
		).toEqual([]);
	});

	test("checkPlanRefs validates n.ref on step, decision, and call nodes alike", () => {
		const plan: Plan = {
			version: 1,
			title: "All Kinds",
			groups: [],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "step", text: "Step with ref", ref: "Orders.MissingStep" },
				{ id: "n3", kind: "decision", text: "Decision with ref?", ref: "Orders.MissingCheck" },
				{ id: "n4", kind: "call", text: "Call with ref", ref: "Orders.MissingCall" },
				{ id: "n5", kind: "step", text: "Valid step", ref: "Orders.ValidProc" },
				{ id: "n6", kind: "end", text: "End" },
			],
			edges: [],
		};
		const findings = checkPlanRefs(plan, (ref) => ref === "Orders.ValidProc");
		expect(findings.map((f) => [f.node, f.code])).toEqual([
			["n2", "plan-unresolved-ref"],
			["n3", "plan-unresolved-ref"],
			["n4", "plan-unresolved-ref"],
		]);
	});

	test("refMatchesWorkspace verifies qualified Script.Proc qualifiers and accepts valid .ds data sources", () => {
		const symbols = [
			{ name: "Helper", kind: 12, path: "/w/src/RightScript.ssl" },
			{ name: "RuleFor", kind: 12, path: "/w/src/DueDates/DueRules.ssl" },
			{ name: "ScratchOnly", kind: 12, path: "/w/.ssl-studio/scratch-1.ssl" },
		];
		const files = [
			"/w/src/RightScript.ssl",
			"/w/src/DueDates/DueRules.ssl",
			"/w/src/DueDates/Holidays.ds",
			"/w/src/Orders.GetOpen.ds",
		];

		// Qualified Script.Proc must match both script and procedure
		expect(refMatchesWorkspace("RightScript.Helper", symbols, files, "/w")).toBe(true);
		expect(refMatchesWorkspace("WrongScript.Helper", symbols, files, "/w")).toBe(false);
		expect(refMatchesWorkspace("DueDates.DueRules.RuleFor", symbols, files, "/w")).toBe(true);
		expect(refMatchesWorkspace("OtherCat.DueRules.RuleFor", symbols, files, "/w")).toBe(false);

		// Unqualified procedure matches symbol; scratch files ignored
		expect(refMatchesWorkspace("Helper", symbols, files, "/w")).toBe(true);
		expect(refMatchesWorkspace("ScratchOnly", symbols, files, "/w")).toBe(false);

		// Valid `.ds` data source references pass cleanly
		expect(refMatchesWorkspace("DueDates.Holidays", [], files, "/w")).toBe(true);
		expect(refMatchesWorkspace("Orders.GetOpen", [], files, "/w")).toBe(true);
		expect(refMatchesWorkspace("src/DueDates/Holidays.ds", [], files, "/w")).toBe(true);
		expect(refMatchesWorkspace("DueDates.NoSuchDS", [], files, "/w")).toBe(false);
	});

	test("stageRegionDrift and manualPlanDrift detect missing stage regions and unimplemented refs on manual plans", () => {
		const plan: Plan = {
			version: 1,
			title: "Manual Plan",
			targets: ["src/DueDates/SetSampleDueDates.ssl"],
			groups: [
				{ id: "g1", name: "Validation" },
				{ id: "g2", name: "Persistence" },
			],
			nodes: [
				{ id: "n1", kind: "start", text: "Start" },
				{ id: "n2", kind: "step", text: "Check rules", group: "g1", ref: "DueDates.DueRules.RuleFor" },
				{ id: "n3", kind: "call", text: "Run missing helper", group: "g2", ref: "DueDates.MissingHelper" },
				{ id: "n4", kind: "end", text: "End" },
			],
			edges: [
				{ from: "n1", to: "n2" },
				{ from: "n2", to: "n3" },
				{ from: "n3", to: "n4" },
			],
		};

		const regions = new Set(["validation"]); // Persistence region missing in SSL file
		const regDrift = stageRegionDrift(plan, regions, ["src/DueDates/SetSampleDueDates.ssl"]);
		expect(regDrift).toHaveLength(1);
		expect(regDrift[0]).toMatchObject({ kind: "orphan", unit: "Persistence", node: "n3", severity: "info" });

		const readings = new Map<string, Reading | null>([
			[
				"src/DueDates/SetSampleDueDates.ssl",
				{
					name: "DueDates.SetSampleDueDates",
					procedures: [{ name: "Main", line: 10 }],
					edges: [{ from: "Main", target: "DueDates.DueRules.RuleFor", resolved: true }],
				},
			],
		]);
		const drift = manualPlanDrift(plan, readings, regions, ["src/DueDates/SetSampleDueDates.ssl"]);
		expect(drift.map((d) => [d.kind, d.node])).toEqual([
			["orphan", "n3"],
			["missing-call", "n3"],
		]);
	});
});
