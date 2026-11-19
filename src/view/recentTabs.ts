// Ctrl+Tab goes to the tab used before this one, and with Ctrl held, on
// through the ones before that. The order is kept for each editor group;
// while Ctrl is held the tabs that pass by are looked at, not used, and the
// one that is showing when Ctrl is let go is the one that was gone to.
import { ofOpen, stepped, used, walkHolds } from "../shared/tabOrder";
import { openFile, state } from "./state";

const orders = new Map<number, string[]>();
let stepping: { group: number; order: string[]; at: number } | null = null;
let ctrlDown = false;

/** A tab was shown in a group. Passing by one on the way to another does not count as using it. */
export function tabShown(group: number, path: string) {
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
export function stepRecent(by: 1 | -1) {
	const index = state.activeGroup;
	const group = state.groups[index];
	if (!group?.active) return;
	// A walk that a closed tab, or a tab shown some other way, has overtaken is over: this step starts from what shows now.
	if (!stepping || stepping.group !== index || !walkHolds(stepping.order, stepping.at, group.tabs, group.active)) stepping = { group: index, order: ofOpen(used(orders.get(index) ?? [], group.active), group.tabs), at: 0 };
	const next = stepped(stepping.order, stepping.at, by);
	if (!next) return void (stepping = null);
	stepping.at = next.at;
	void openFile(next.path, { group: index });
	// Run from the command list there is no key to let go: the step is the whole of it.
	if (!ctrlDown) settle();
}

export function installRecentTabs() {
	window.addEventListener("keydown", (e) => e.key === "Control" && (ctrlDown = true), true);
	window.addEventListener(
		"keyup",
		(e) => {
			if (e.key !== "Control") return;
			ctrlDown = false;
			settle();
		},
		true,
	);
	// A key let go while the window was elsewhere is never heard.
	window.addEventListener("blur", () => {
		ctrlDown = false;
		settle();
	});
}
