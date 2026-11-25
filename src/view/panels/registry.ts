// Side panels and where they dock. Each panel has a home side; the user can
// move any of them to the other side, and the choice is saved with the
// workspace's layout.
import { createSignal } from "solid-js";
import { hasOutline } from "../../shared/outline";
import { recall, remember } from "../graph/canvas";
import { dockedView } from "../layout";
import { isPlanPath } from "../plan/model";
import { activeDoc, activePath, focusEditor, planMode, setState, state, type PanelId } from "../state";
import { formatOutlineActive, observeOutlineState, outlineKey, parseOutlineActive, planPaletteKey, type OutlineMemory, type SideSnapshot } from "./outlineState";

/** True when the active editor tab is a Plan file shown as its visual chart. */
export const isPlanChartActive = (): boolean => {
	if (state.centerView !== "editors") return false;
	const path = activePath();
	if (!path || !isPlanPath(path) || planMode(path) === "source") return false;
	const doc = activeDoc();
	return Boolean(doc && !doc.binary);
};

export type Side = "left" | "right";
export const PANELS: { id: PanelId; icon: string; title: string; home: Side; when?: () => boolean }[] = [
	// Every icon is a Codicon, from the font Monaco already ships: one family, drawn the same on every system.
	{ id: "explorer", icon: "\ueaf0", title: "Explorer", home: "left" },
	{ id: "docs", icon: "\ueb9c", title: "Docs: README, AGENTS and the project's documents", home: "left" },
	{
		id: "objects",
		icon: "\ueb86",
		title: "Document outline: headings, regions and procedures of the open file",
		home: "right",
		when: () => {
			void state.kindVersion;
			if (state.centerView !== "editors") return false;
			const path = activePath();
			if (!path || isPlanPath(path)) return false;
			const doc = activeDoc();
			if (!doc || doc.binary) return false;
			return doc.model.getLanguageId() === "ssl" || hasOutline(doc.model.getLanguageId());
		},
	},
	{
		id: "palette",
		icon: "\ueb5c",
		title: "Palette: templates, callouts, plan shapes, or call graph controls",
		home: "left",
		when: () => {
			void state.kindVersion;
			if (state.centerView === "graph") return true;
			if (state.centerView !== "editors") return false;
			const path = activePath();
			if (!path) return false;
			const doc = activeDoc();
			if (!doc || doc.binary) return false;
			const lang = doc.model.getLanguageId();
			return (isPlanPath(path) && planMode(path) !== "source") || lang === "ssl" || lang === "markdown";
		},
	},
	{ id: "reference", icon: "\ueaa4", title: "Reference: built-in functions, classes and keywords", home: "left" },
	{ id: "search", icon: "\uea6d", title: "Search", home: "left" },
	{ id: "git", icon: "\uea68", title: "Source control: what has changed, and the next commit", home: "left" },
	{ id: "history", icon: "\uea82", title: "History: local snapshots and Git commits", home: "left" },
	{ id: "agent", icon: "\uec10", title: "Agent", home: "right" },
	{ id: "health", icon: "\ueb31", title: "Health: the open script against the house style", home: "left" },
];

/** Whether a panel is relevant to the current document/view context (shown in the rail). */
export const isPanelAvailable = (id: PanelId): boolean => {
	const panel = PANELS.find((p) => p.id === id);
	return panel?.when ? panel.when() : true;
};

export const sideOf = (id: PanelId): Side => state.settings.layout.dock?.[id] ?? PANELS.find((p) => p.id === id)!.home;
const viewKey = (side: Side) => (side === "left" ? "leftView" : "rightView");
export const isOpen = (id: PanelId) => state.settings.layout[sideOf(id)] && state[viewKey(sideOf(id))] === id;

/** The side whose panel was asked for last: in a window with room for one side panel, that one is shown. */
const [lastShown, setLastShown] = createSignal<Side>("left");
/** A side that is open but has no room in the window as it is (set by the app's layout). */
const [crowded, setCrowded] = createSignal<{ left: boolean; right: boolean }>({ left: false, right: false }, { equals: (a, b) => a.left === b.left && a.right === b.right });
/** True when the window cannot fit both left and right panels beside the editor (narrow layout). */
const [narrowPanels, setNarrowPanels] = createSignal(false);
/** A right-docked panel temporarily hosted inside the left island slot during narrow layout (ADR 0027). */
const [narrowHosted, setNarrowHosted] = createSignal<PanelId | null>(null);
export { lastShown, narrowHosted, narrowPanels, setCrowded, setNarrowHosted, setNarrowPanels };
/** Whether a side is open but has no room: said of each side by itself, since in a narrow window it can be both. */
export const crowdedOut = (side: Side) => crowded()[side];
/** Open, and on screen: a panel the window has no room for is neither pressed nor closed by its button. */
export const isShown = (id: PanelId) => {
	const hosted = narrowHosted();
	if (narrowPanels() && hosted) return hosted === id && state.settings.layout.left && !crowdedOut("left");
	return isOpen(id) && !crowdedOut(sideOf(id));
};

/** Remembered active/inactive preference for Document outline ("objects"), defaulting to active. */
let outlineMemory: OutlineMemory = { active: true, before: null };
export const getOutlineMemory = () => outlineMemory;
export const setOutlineMemory = (next: OutlineMemory) => (outlineMemory = next);
export function loadOutlineMemory(root: string | undefined) {
	outlineMemory = { active: parseOutlineActive(root ? recall(outlineKey(root)) : null), before: null };
}
export function recordOutlineActive(active: boolean, before?: SideSnapshot | null) {
	outlineMemory = active ? { active: true, before: before !== undefined ? before : outlineMemory.before } : observeOutlineState(false, outlineMemory);
	const root = state.workspace?.root;
	if (root) remember(outlineKey(root), formatOutlineActive(outlineMemory.active));
}
export function resetOutlineActive() {
	recordOutlineActive(true, null);
}

/** Remembered active/inactive preference for Plan Palette ("palette" when viewing a plan chart), defaulting to active. */
let planPaletteMemory: OutlineMemory = { active: true, before: null };
export const getPlanPaletteMemory = () => planPaletteMemory;
export const setPlanPaletteMemory = (next: OutlineMemory) => (planPaletteMemory = next);
export function loadPlanPaletteMemory(root: string | undefined) {
	planPaletteMemory = { active: parseOutlineActive(root ? recall(planPaletteKey(root)) : null), before: null };
}
export function recordPlanPaletteActive(active: boolean, before?: SideSnapshot | null) {
	planPaletteMemory = active ? { active: true, before: before !== undefined ? before : planPaletteMemory.before } : observeOutlineState(false, planPaletteMemory);
	const root = state.workspace?.root;
	if (root) remember(planPaletteKey(root), formatOutlineActive(planPaletteMemory.active));
}
export function resetPlanPaletteActive() {
	recordPlanPaletteActive(true, null);
}

export function showPanel(id: PanelId) {
	const side = sideOf(id);
	// In narrow layout, right-docked panels open cleanly inside the left island slot without mutating dock settings.
	if (side === "right" && narrowPanels()) {
		if (id === "objects" && isPanelAvailable("objects")) recordOutlineActive(true);
		else if (narrowHosted() === "objects" && isPanelAvailable("objects")) recordOutlineActive(false, null);
		if (id === "palette" && isPlanChartActive()) recordPlanPaletteActive(true);
		else if (narrowHosted() === "palette" && isPlanChartActive()) recordPlanPaletteActive(false, null);
		setNarrowHosted(id);
		setLastShown("left");
		setState("rightView", id);
		setState("settings", "layout", "left", true);
		setTimeout(() => focusPanel(id), 0);
		return;
	}
	setNarrowHosted(null);
	setLastShown(side);
	setState(viewKey(side), id);
	setState("settings", "layout", side, true);
	// Once the panel is drawn. Asking for a panel that is already showing still takes the keyboard to it.
	setTimeout(() => focusPanel(id), 0);
}

/**
 * Moves the keyboard into a panel: to the control it marks with
 * `data-autofocus` (a search or filter box), else to its list, else to its
 * first text box. Never to a button or a select, where a stray key would act.
 */
export function focusPanel(id: PanelId) {
	if (!isShown(id)) return;
	const host = document.querySelector<HTMLElement>(`[data-panel="${id}"]`) ?? document.querySelector<HTMLElement>(sideOf(id) === "left" ? ".sidebar" : ".rightbar");
	const list = host?.querySelector<HTMLElement>("[data-rows]");
	const target =
		host?.querySelector<HTMLElement>("[data-autofocus]") ??
		list?.querySelector<HTMLElement>('[data-row][tabindex="0"]') ??
		list?.querySelector<HTMLElement>("[data-row]") ??
		list ??
		host?.querySelector<HTMLElement>("textarea, input:not([type=checkbox]):not([type=radio])");
	if (!target) return;
	target.focus();
	if (target instanceof HTMLInputElement) target.select();
}

/** The panel a side shows, or would show: null when no available panel is docked on it. */
export const panelOn = (side: Side): PanelId | null =>
	dockedView(
		state[viewKey(side)],
		PANELS.filter((panel) => sideOf(panel.id) === side && isPanelAvailable(panel.id)).map((panel) => panel.id),
	);

/**
 * Shows or hides a side as a part of the window. The keyboard stays where it is, unless it was in the side that
 * went: then it goes to the editor. A side that is open but has no room is brought back, not shut.
 */
export function toggleSide(side: Side) {
	if (side === "right" && narrowPanels()) {
		if (narrowHosted() && state.settings.layout.left && !crowdedOut("left")) {
			setNarrowHosted(null);
			setState("settings", "layout", "left", false);
			queueMicrotask(() => (!document.activeElement || document.activeElement === document.body) && focusEditor());
			return;
		}
		const target = panelOn("right");
		if (target) showPanel(target);
		return;
	}
	if (side === "left" && narrowPanels() && narrowHosted() && state.settings.layout.left && !crowdedOut("left")) {
		setNarrowHosted(null);
		return;
	}
	if (state.settings.layout[side] && !crowdedOut(side)) {
		setState("settings", "layout", side, false);
		queueMicrotask(() => (!document.activeElement || document.activeElement === document.body) && focusEditor());
		return;
	}
	setLastShown(side);
	setState("settings", "layout", side, true);
}

export function togglePanel(id: PanelId) {
	if (isShown(id)) {
		if (narrowPanels() && narrowHosted() === id) {
			if (id === "objects" && isPanelAvailable("objects")) recordOutlineActive(false, null);
			if (id === "palette" && isPlanChartActive()) recordPlanPaletteActive(false, null);
			setNarrowHosted(null);
			setState("settings", "layout", "left", false);
		} else {
			setState("settings", "layout", sideOf(id), false);
		}
	} else {
		showPanel(id);
	}
}

export function movePanel(id: PanelId) {
	if (narrowHosted() === id) setNarrowHosted(null);
	const from = sideOf(id);
	const to: Side = from === "left" ? "right" : "left";
	const wasShown = state[viewKey(from)] === id;
	setState("settings", "layout", "dock", (dock) => ({ ...(dock ?? {}), [id]: to }));
	// The side it left shows another of its panels, or closes.
	if (wasShown) {
		const next = PANELS.find((p) => p.id !== id && sideOf(p.id) === from && isPanelAvailable(p.id));
		if (next) setState(viewKey(from), next.id);
		else setState("settings", "layout", from, false);
	}
	showPanel(id);
}
