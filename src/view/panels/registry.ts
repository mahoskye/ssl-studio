// Side panels and where they dock. Each panel has a home side; the user can
// move any of them to the other side, and the choice is saved with the
// workspace's layout.
import { setState, state, type PanelId } from "../state";

export type Side = "left" | "right";
export const PANELS: { id: PanelId; icon: string; title: string; home: Side }[] = [
	{ id: "explorer", icon: "🗀", title: "Explorer (Ctrl+Shift+E)", home: "left" },
	{ id: "objects", icon: "◇", title: "Objects", home: "left" },
	{ id: "palette", icon: "▤", title: "Palette", home: "left" },
	{ id: "reference", icon: "📖", title: "Reference", home: "left" },
	{ id: "search", icon: "⌕", title: "Search (Ctrl+Shift+F)", home: "left" },
	{ id: "history", icon: "⟲", title: "Local history", home: "left" },
	{ id: "agent", icon: "✦", title: "Agent", home: "right" },
	{ id: "health", icon: "♥", title: "Health", home: "right" },
];

export const sideOf = (id: PanelId): Side => state.settings.layout.dock?.[id] ?? PANELS.find((p) => p.id === id)!.home;
const viewKey = (side: Side) => (side === "left" ? "leftView" : "rightView");
export const isOpen = (id: PanelId) => state.settings.layout[sideOf(id)] && state[viewKey(sideOf(id))] === id;

export function showPanel(id: PanelId) {
	const side = sideOf(id);
	setState(viewKey(side), id);
	setState("settings", "layout", side, true);
}

export function togglePanel(id: PanelId) {
	if (isOpen(id)) setState("settings", "layout", sideOf(id), false);
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
