// Side panels and where they dock. Each panel has a home side; the user can
// move any of them to the other side, and the choice is saved with the
// workspace's layout.
import { createSignal } from "solid-js";
import { setState, state, type PanelId } from "../state";

export type Side = "left" | "right";
export const PANELS: { id: PanelId; icon: string; title: string; home: Side }[] = [
	// Every icon is a Codicon, from the font Monaco already ships: one family, drawn the same on every system.
	{ id: "explorer", icon: "\ueaf0", title: "Explorer", home: "left" },
	{ id: "docs", icon: "\ueb9c", title: "Docs: README, AGENTS and the project's documents", home: "left" },
	{ id: "objects", icon: "\ueb17", title: "Objects: the regions and procedures of the open file", home: "left" },
	{ id: "palette", icon: "\ueb5c", title: "Palette: templates to insert", home: "left" },
	{ id: "reference", icon: "\ueaa4", title: "Reference: built-in functions, classes and keywords", home: "left" },
	{ id: "search", icon: "\uea6d", title: "Search", home: "left" },
	{ id: "history", icon: "\uea82", title: "Local history: snapshots kept on save", home: "left" },
	{ id: "agent", icon: "\uec10", title: "Agent", home: "right" },
	{ id: "health", icon: "\ueb31", title: "Health: the open script against the house style", home: "left" },
];

export const sideOf = (id: PanelId): Side => state.settings.layout.dock?.[id] ?? PANELS.find((p) => p.id === id)!.home;
const viewKey = (side: Side) => (side === "left" ? "leftView" : "rightView");
export const isOpen = (id: PanelId) => state.settings.layout[sideOf(id)] && state[viewKey(sideOf(id))] === id;

/** The side whose panel was asked for last: in a window with room for one side panel, that one is shown. */
const [lastShown, setLastShown] = createSignal<Side>("left");
/** A side that is open but has no room in the window as it is (set by the app's layout). */
const [crowdedOut, setCrowdedOut] = createSignal<Side | null>(null);
export { crowdedOut, lastShown, setCrowdedOut };
/** Open, and on screen: a panel the window has no room for is neither pressed nor closed by its button. */
export const isShown = (id: PanelId) => isOpen(id) && crowdedOut() !== sideOf(id);

export function showPanel(id: PanelId) {
	const side = sideOf(id);
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

export function togglePanel(id: PanelId) {
	if (isShown(id)) setState("settings", "layout", sideOf(id), false);
	else showPanel(id);
}

export function movePanel(id: PanelId) {
	const from = sideOf(id);
	const to: Side = from === "left" ? "right" : "left";
	const wasShown = state[viewKey(from)] === id;
	setState("settings", "layout", "dock", (dock) => ({ ...(dock ?? {}), [id]: to }));
	// The side it left shows another of its panels, or closes.
	if (wasShown) {
		const next = PANELS.find((p) => p.id !== id && sideOf(p.id) === from);
		if (next) setState(viewKey(from), next.id);
		else setState("settings", "layout", from, false);
	}
	showPanel(id);
}
