// Lightweight reactive bridge between the active PlanView chart and the
// context-aware Palette panel (Design | Assistant tabs). Every edit invoked
// through this bridge applies an undoable text edit to the plan's Monaco model (ADR 0002).
import { createSignal } from "solid-js";
import type { BuiltUnit, PlanPath } from "./built";
import type { CodeIndicator, LayoutDirection } from "./chart";
import type { NodeKind, Plan, PlanNode, PlanTestInput, PlanTestPatch } from "./model";

export type PlanStageSummary = {
	id: string;
	name: string;
	count: number;
	firstNodeId?: string;
};

export type ScheduledBuildScope =
	| { kind: "plan"; label?: string }
	| { kind: "stage"; label: string }
	| { kind: "node"; id: string; label: string }
	| { kind: "tests"; label?: string };

export type ActivePlanBridge = {
	path: string;
	planUri: () => string | undefined;
	plan: () => Plan | undefined;
	text: () => string;
	selectedId: () => string | null;
	selectedNode: () => PlanNode | undefined;
	selectedLinks: () => BuiltUnit[];
	builtUnits: () => BuiltUnit[];
	groupName: () => string;
	linking: () => boolean;
	layoutDir: () => LayoutDirection;
	stages: () => PlanStageSummary[];
	codeStateOf: (id: string) => CodeIndicator;
	codeStatusCounts: () => Record<CodeIndicator, number>;
	nodesByCodeState: (kind: CodeIndicator) => PlanNode[];
	allPaths: () => { paths: PlanPath[]; truncated: boolean };
	activePathIndex: () => number | null;
	setActivePathIndex: (index: number | null) => void;
	stepActivePath: (by: 1 | -1) => void;
	scheduledNotice: () => string | null;
	clearScheduledNotice: () => void;
	triggerScheduledBuild: (scope: ScheduledBuildScope) => void;
	openAssistant: () => void;
	setPlanField: (field: "title" | "goal" | "ticket", value: string) => void;
	setTargets: (value: string) => void;
	addTestCase: (input: PlanTestInput) => void;
	updateTestCase: (id: string, patch: PlanTestPatch) => void;
	removeTestCase: (id: string) => void;
	setNodeText: (value: string) => void;
	setNodeKind: (kind: NodeKind) => void;
	setNodeField: (field: "notes" | "ref", value: string) => void;
	setNodeRef: (value: string) => void;
	setNodeGroup: (groupName: string) => void;
	renameStage: (groupId: string) => void;
	openCodeUnit: (unit: BuiltUnit) => void;
	openReference: (ref: string) => void;
	openScript: (script: string, line?: number) => void;
	selectNode: (id: string) => void;
	clearSelection: () => void;
	setWalkedPath: (nodes: string[] | null) => void;
	addStep: () => void;
	addDecision: () => void;
	addBranch: () => void;
	addCall: () => void;
	addStageGroup: () => void;
	toggleConnect: () => void;
	toggleLayoutDir: () => void;
	jumpToNode: (id: string) => void;
	peekNode: (id: string | null, opts?: { pan?: boolean }) => void;
	openTextTestBuilder: (opts?: { nodeId?: string; journeyIndex?: number; testId?: string }) => void;
};

const [activePlanBridge, setActivePlanBridge] = createSignal<ActivePlanBridge | null>(null);
const [activePlanTab, setActivePlanTab] = createSignal<"design" | "assistant">("design");
const [planPaletteTabRequest, setPlanPaletteTabRequest] = createSignal<{ tab: "design" | "assistant"; seq: number } | null>(null);
let tabSeq = 0;

export { activePlanBridge, activePlanTab, planPaletteTabRequest, setActivePlanTab };

export function requestPlanPaletteTab(tab: "design" | "assistant") {
	setActivePlanTab(tab);
	setPlanPaletteTabRequest({ tab, seq: ++tabSeq });
}

export function registerPlanBridge(bridge: ActivePlanBridge): () => void {
	setActivePlanBridge(bridge);
	return () => {
		if (activePlanBridge() === bridge) setActivePlanBridge(null);
	};
}
