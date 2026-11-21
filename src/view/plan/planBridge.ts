// Lightweight reactive bridge between the active PlanView chart and the
// context-aware Palette panel (ADR 0027). Every action invoked through this
// bridge applies an undoable text edit to the plan's Monaco model (ADR 0002).
import { createSignal } from "solid-js";

export type PlanStageSummary = {
	id: string;
	name: string;
	count: number;
	firstNodeId?: string;
};

export type ActivePlanBridge = {
	path: string;
	title: string;
	selectedId: () => string | null;
	linking: () => boolean;
	stages: () => PlanStageSummary[];
	addStep: () => void;
	addDecision: () => void;
	addBranch: () => void;
	addCall: () => void;
	addStageGroup: () => void;
	toggleConnect: () => void;
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
