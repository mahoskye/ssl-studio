// Ctrl+Tab goes to the tab used before this one, and with Ctrl held, on
// through the ones before that. The order is kept for each editor group;
// while Ctrl is held the tabs that pass by are looked at, not used, and the
// one that is showing when Ctrl is let go is the one that was gone to.
import { batch } from "solid-js";
import { ofOpen, stepped, used, walkHolds } from "../shared/tabOrder";
import { focusEditor, pathChanges, revealSignal, setState, state } from "./state";

const orders = new Map<number, string[]>();
let stepping: { group: number; order: string[]; at: number } | null = null;
let modDown = false;
let subscribed = false;
let installed = false;

function ensureSubscribed() {
	if (subscribed) return;
	subscribed = true;
	pathChanges.renamed.add((rename) => {
		for (const [group, list] of orders) {
			const updated: string[] = [];
			for (const p of list) {
				const mapped = rename(p);
				if (!updated.includes(mapped)) updated.push(mapped);
			}
			orders.set(group, updated);
		}
		if (stepping) {
			const updated: string[] = [];
			let nextAt = stepping.at;
			for (let i = 0; i < stepping.order.length; i++) {
				const mapped = rename(stepping.order[i]!);
				const existing = updated.indexOf(mapped);
				if (existing >= 0) {
					if (i === stepping.at) nextAt = existing;
					else if (i < stepping.at) nextAt--;
				} else {
					if (i === stepping.at) nextAt = updated.length;
					updated.push(mapped);
				}
			}
			stepping.order = updated;
			stepping.at = Math.max(0, Math.min(nextAt, Math.max(0, updated.length - 1)));
		}
	});
}

/** Clears all MRU history and any active walk (called on workspace switch). */
export function resetRecentTabs() {
	orders.clear();
	stepping = null;
}

/** Drops MRU history for a closed split group and shifts higher group indices down. */
export function removeRecentGroup(removedIndex: number) {
	const next = new Map<number, string[]>();
	for (const [idx, list] of orders) {
		if (idx < removedIndex) next.set(idx, list);
		else if (idx > removedIndex) next.set(idx - 1, list);
	}
	orders.clear();
	for (const [idx, list] of next) orders.set(idx, list);
	if (stepping) {
		if (stepping.group === removedIndex) stepping = null;
		else if (stepping.group > removedIndex) stepping.group--;
	}
}

/** A tab was shown in a group. Passing by one on the way to another does not count as using it. */
export function tabShown(group: number, path: string) {
	ensureSubscribed();
	if (!stepping) orders.set(group, used(orders.get(group) ?? [], path));
}

function settle() {
	if (!stepping) return;
	const { group } = stepping;
	stepping = null;
	// The tab showing when the key is let go is the one that was gone to, however it came to show.
	const showing = state.groups[group]?.active;
	if (showing) tabShown(group, showing);
}

/** To the tab used before this one (`by` 1), or the other way round the order (`by` -1). */
export function stepRecent(by: 1 | -1, hold?: boolean) {
	ensureSubscribed();
	const index = state.activeGroup;
	const group = state.groups[index];
	if (!group?.active) return;
	// A walk that a closed tab, or a tab shown some other way, has overtaken is over: this step starts from what shows now.
	if (!stepping || stepping.group !== index || !walkHolds(stepping.order, stepping.at, group.tabs, group.active)) {
		stepping = { group: index, order: ofOpen(used(orders.get(index) ?? [], group.active), group.tabs), at: 0 };
	}
	const next = stepped(stepping.order, stepping.at, by);
	if (!next) return void (stepping = null);
	stepping.at = next.at;
	// Activate the already-open tab synchronously so rapid Ctrl+Tab steps advance A -> B -> C without racing async openFile.
	batch(() => {
		setState("groups", index, "active", next.path);
		if (state.centerView !== "editors") setState("centerView", "editors");
		if (state.bottomMaximized) setState("bottomMaximized", false);
	});
	revealSignal.fire(next.path);
	focusEditor();
	// Run from the command list there is no key to let go: the step is the whole of it.
	if (!(hold ?? modDown)) settle();
}

export function installRecentTabs() {
	ensureSubscribed();
	if (installed) return;
	installed = true;
	window.addEventListener(
		"keydown",
		(e) => {
			modDown = Boolean(e.ctrlKey || e.metaKey || e.altKey || e.key === "Control" || e.key === "Meta" || e.key === "Alt");
		},
		true,
	);
	window.addEventListener(
		"keyup",
		(e) => {
			const anyMod = Boolean(e.ctrlKey || e.metaKey || e.altKey);
			const releasedMod = e.key === "Control" || e.key === "Meta" || e.key === "Alt";
			const otherModStillHeld =
				(e.key !== "Control" && e.ctrlKey) || (e.key !== "Meta" && e.metaKey) || (e.key !== "Alt" && e.altKey);
			if (!anyMod || (releasedMod && !otherModStillHeld)) {
				modDown = false;
				settle();
			} else {
				modDown = true;
			}
		},
		true,
	);
	// A key let go while the window was elsewhere is never heard.
	window.addEventListener("blur", () => {
		modDown = false;
		settle();
	});
}
