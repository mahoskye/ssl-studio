// Lightweight reactive bridge between the active PlanView chart and the
// context-aware Palette panel (Design | Assistant tabs). Every edit invoked
// through this bridge applies an undoable text edit to the plan's Monaco model (ADR 0002).
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { BuiltUnit, PlanPath } from "./built";
import type { CodeIndicator, LayoutDirection } from "./chart";
import type { NodeKind, Plan, PlanNode, PlanTestInput, PlanTestPatch } from "./model";
import type { TextTestBuilderRequest } from "./PlanTextView";

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
	/** These three take the node's id: the selected node when it is left out. A field's text is for the node it was typed for. */
	setNodeText: (value: string, id?: string) => void;
	setNodeKind: (kind: NodeKind) => void;
	setNodeField: (field: "notes" | "ref", value: string, id?: string) => void;
	setNodeRef: (value: string) => void;
	setNodeGroup: (groupName: string, id?: string) => void;
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

/**
 * The "Build in Text" request a plan's view holds for its text view: made once, and taken once. The text view is
 * built anew each time the plan is switched to Text, and the request used to stay where it was, so every later
 * switch opened the test builder again on the same step, over whatever was there. The text view says which
 * request it has taken up, and that one is gone; one made since stays.
 */
export function builderRequests() {
	const [pending, setPending] = createSignal<TextTestBuilderRequest | null>(null);
	let seq = 0;
	return {
		pending,
		ask: (opts?: Omit<TextTestBuilderRequest, "seq">) => void setPending({ ...opts, seq: ++seq }),
		taken: (req: TextTestBuilderRequest) => void setPending((cur) => (cur?.seq === req.seq ? null : cur)),
	};
}

/**
 * A Palette field while it is typed in: its draft, and which node (or plan) the typing is for.
 *
 * The plan is given the text when the field is left (the browser's change event). Until then the text is only in
 * the field, and a field that was never left lost it: a click on the chart that does not move focus (a port, a
 * Shift+click) or a key that moves the selection put the next node's text in the field, and what had been typed
 * for the first node was gone. The field therefore remembers the key it was typed under (`resetKey`: the node's
 * id) and hands the text over with that key: when the key changes under it, when the field is taken away (a
 * microtask later, because that happens inside an update; a plan view that is gone by then takes no edit), and
 * when a save or a close asks for what is pending (`hold` is `holdsPendingEdit`, passed in so that this file
 * needs nothing of the app's state).
 */
export function pendingField(
	props: { readonly value: string; readonly resetKey?: string; readonly onCommit: (value: string, key: string) => void },
	options: { hold: (commit: () => void, typed?: () => boolean) => () => void },
) {
	const [draft, setDraft] = createSignal(untrack(() => props.value));
	/** The key the text not yet handed over was typed under, and the text; no key when there is none. */
	let typedFor: string | null = null;
	let typed = "";
	const hand = (key: string, text: string) => {
		typedFor = null;
		props.onCommit(text, key);
	};
	const shown = createMemo(() => ({ key: props.resetKey ?? "", value: props.value }), { equals: (a, b) => a.key === b.key && a.value === b.value });
	createEffect(shown, (next) => {
		if (typedFor !== null && typedFor !== next.key) hand(typedFor, typed);
		// What the plan holds is shown again: nothing typed is left to hand over.
		typedFor = null;
		setDraft(next.value);
	});
	onCleanup(
		options.hold(
			() => {
				if (typedFor !== null) hand(typedFor, typed);
			},
			// Whether there is text not yet handed over: a field that is merely shown holds none.
			() => typedFor !== null,
		),
	);
	onCleanup(() => {
		if (typedFor === null) return;
		const [key, text, commit] = [typedFor, typed, props.onCommit];
		typedFor = null;
		queueMicrotask(() => commit(text, key));
	});
	return {
		draft,
		/** A keystroke: the draft, kept with the key it is typed under. */
		type(text: string) {
			typedFor = untrack(() => props.resetKey ?? "");
			typed = text;
			setDraft(text);
		},
		/**
		 * The field was left: its text goes to what it was typed for. With nothing typed since the plan's value was
		 * last shown there is nothing to hand over, and what the field shows by now may be another node's text.
		 */
		commit(text: string) {
			if (typedFor !== null) hand(typedFor, text);
		},
		/** Escape: what was typed is given up, and the plan's value is shown again. */
		revert(): string {
			typedFor = null;
			const value = untrack(() => props.value);
			setDraft(value);
			return value;
		},
		/** Shows a value in the field that the plan holds, after a commit that changed nothing there. */
		show(value: string) {
			setDraft(value);
		},
	};
}

export function registerPlanBridge(bridge: ActivePlanBridge): () => void {
	setActivePlanBridge(bridge);
	return () => {
		setActivePlanBridge((cur) => (cur === bridge ? null : cur));
	};
}
