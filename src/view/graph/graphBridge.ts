// Reactive bridge between the active Call Graph view and the context-coupled
// Palette panel so Graph controls, scope filters, folding actions, and legend
// items live cleanly in Palette while Call Graph is active.
import { createSignal } from "solid-js";

export type GraphLegendEntry = {
	shape: "box" | "line";
	cls: string;
	words: string;
};

export type GraphTargetEntry = {
	id: string;
	label: string;
	meta: string;
};

export type ActiveGraphBridge = {
	mode: () => "graph" | "list";
	setMode: (next: "graph" | "list") => void;
	filterMode: () => "all" | "cross" | "around";
	setFilterMode: (next: "all" | "cross") => void;
	folding: () => boolean;
	allFolded: () => boolean;
	anyFolded: () => boolean;
	foldAll: (all: boolean) => void;
	gathered: () => boolean;
	toggleGathered: () => void;
	unresolved: () => boolean;
	unresolvedCount: () => number;
	toggleUnresolved: () => void;
	fit: () => void;
	refresh: () => void;
	tally: () => string;
	legend: () => GraphLegendEntry[];
	targets: () => GraphTargetEntry[];
	focusTarget: (id: string) => void;
};

const [activeGraphBridge, setActiveGraphBridge] = createSignal<ActiveGraphBridge | null>(null);
export { activeGraphBridge };

export function registerGraphBridge(bridge: ActiveGraphBridge): () => void {
	setActiveGraphBridge(bridge);
	return () => {
		setActiveGraphBridge((cur) => (cur === bridge ? null : cur));
	};
}
