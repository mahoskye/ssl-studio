// Lightweight reactive bridge between the active PlanView chart and the
// context-aware Palette panel (Design | Assistant tabs). Every edit invoked
// through this bridge applies an undoable text edit to the plan's Monaco model (ADR 0002).
import { createSignal } from "solid-js";
import type { BuiltUnit } from "./built";
import type { LayoutDirection } from "./chart";
import type { NodeKind, Plan, PlanNode } from "./model";

export type PlanStageSummary = {
	id: string;
	name: string;
	count: number;
	firstNodeId?: string;
};

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
	setPlanField: (field: "title" | "goal" | "ticket", value: string) => void;
	setTargets: (value: string) => void;
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
};

const [activePlanBridge, setActivePlanBridge] = createSignal<ActivePlanBridge | null>(null);

export { activePlanBridge };

export function registerPlanBridge(bridge: ActivePlanBridge): () => void {
	setActivePlanBridge(bridge);
	return () => {
		if (activePlanBridge() === bridge) setActivePlanBridge(null);
	};
}
