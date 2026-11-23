// Back and forward through the places and screens the user has visited:
// files, cursor jumps, center views (editors/graph/welcome), and right-panel
// switches (e.g. Palette Assistant -> Agent panel -> Mouse 4 back to Palette).
// Pure trail logic lives in src/shared/navHistory.ts; this wires keyboard,
// menu, and application-wide Mouse 4 / Mouse 5 back/forward navigation.
import { createEffect, on, onCleanup } from "solid-js";
import { createMiddleClickGuard, isExplicitPasteKey } from "../shared/middleClickGuard";
import { canGoBack, canGoForward, NO_TRAIL, stepTrail, TRAIL_LENGTH, trailRenamed, trailWithout, visited, type Place, type Trail } from "../shared/navHistory";
import { activeEditor } from "./editor/EditorGroup";
import { activeLiveEditor } from "./editor/liveBridge";
import { isPlanChartActive, narrowHosted, narrowPanels, showPanel } from "./panels/registry";
import { activePlanTab, requestPlanPaletteTab } from "./plan/planBridge";
import { activeDoc, activePath, notify, openFile, pathChanges, setState, state, type PanelId } from "./state";

let trail: Trail = NO_TRAIL;
/** Steps back or forward that are under way: where they pass and land is on the trail already. */
let stepping = 0;

/** Encodes the active screen and right-side panel so panel switches join Back / Forward history. */
function currentViewKey(): string {
	const center = state.centerView;
	const rightId = narrowPanels()
		? (state.settings.layout.left && narrowHosted() ? narrowHosted()! : "")
		: (state.settings.layout.right ? state.rightView : "");
	const planTab = rightId === "palette" && isPlanChartActive() ? `:${activePlanTab()}` : "";
	return `${center}|${rightId}${planTab}`;
}

function parseViewKey(view?: string): { center: "editors" | "graph" | "welcome"; rightId: PanelId | ""; planTab: "design" | "assistant" | null } | null {
	if (!view || !view.includes("|")) return null;
	const [centerRaw, rightRaw = ""] = view.split("|");
	const center = centerRaw === "graph" || centerRaw === "welcome" ? centerRaw : "editors";
	const [rightIdRaw, tabRaw] = rightRaw.split(":");
	const rightId = (rightIdRaw || "") as PanelId | "";
	const planTab = tabRaw === "design" || tabRaw === "assistant" ? tabRaw : null;
	return { center, rightId, planTab };
}

/** The cursor or view came to rest somewhere, by the user's hand or by a jump. */
export function noteCursor(place: Place) {
	if (stepping) return;
	trail = visited(trail, place.view === undefined ? { ...place, view: currentViewKey() } : place);
}

/** Where the window currently stands: active file + cursor + screen/right-panel context. */
function here(): Place | null {
	const path = activePath() ?? "";
	const view = currentViewKey();
	if (!path && state.centerView === "editors") return null;
	if (!path) return { path: "", line: 1, column: 1, view };
	const live = activeLiveEditor();
	if (live && live.path === path) {
		const at = live.getPosition();
		return { path, line: at.lineNumber, column: at.column, view };
	}
	const editor = activeEditor();
	const at = editor && editor.getModel() === activeDoc()?.model ? editor.getPosition() : null;
	return { path, line: at?.lineNumber ?? 1, column: at?.column ?? 1, view };
}

/** Restores the center view, right panel, and Palette plan tab recorded on a navigation stop. */
function restoreView(view?: string) {
	const parsed = parseViewKey(view);
	if (!parsed) return;
	if (state.centerView !== parsed.center) setState("centerView", parsed.center);
	if (parsed.rightId) {
		const currentRight = narrowPanels() ? narrowHosted() : (state.settings.layout.right ? state.rightView : null);
		if (currentRight !== parsed.rightId) showPanel(parsed.rightId);
	}
	if (parsed.planTab) requestPlanPaletteTab(parsed.planTab);
}

/** Tracks active files, panel/screen transitions, and application-wide Mouse 4 / Mouse 5 buttons. Called once from App. */
export function useNavigation() {
	// Another folder is another trail.
	createEffect(on(() => state.workspace?.root, () => void (trail = NO_TRAIL)));
	// A file or folder renamed: the places in it go with it. Files gone: so are the places in them.
	const renamed = (rename: (path: string) => string) => void (trail = trailRenamed(trail, rename));
	const gone = (isGone: (path: string) => boolean) => void (trail = trailWithout(trail, isGone));
	pathChanges.renamed.add(renamed);
	pathChanges.gone.add(gone);
	onCleanup(() => (pathChanges.renamed.delete(renamed), pathChanges.gone.delete(gone)));

	// Record file switches, centerView switches (editors/graph/welcome), and right-panel / plan-tab switches.
	createEffect(
		on([activePath, currentViewKey], () => {
			if (!state.workspace) return;
			queueMicrotask(() => {
				const place = here();
				if (place) noteCursor(place);
			});
		}),
	);

	// Application-wide Mouse 4/5 (Back/Forward) navigation AND Linux middle-click
	// primary-selection paste suppression (so middle-clicking tabs to close them,
	// or middle-clicking in an editor, never dumps clipboard text into documents).
	const middleGuard = createMiddleClickGuard();
	const onMouseDownCapture = (e: MouseEvent) => {
		if (e.button === 3 || e.button === 4) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (e.button === 1) {
			middleGuard.noteMiddleMouse();
			e.preventDefault();
		}
	};
	const onAuxClickCapture = (e: MouseEvent) => {
		if (e.button === 3 || e.button === 4) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (e.button === 1) {
			middleGuard.noteMiddleMouse();
			e.preventDefault();
		}
	};
	const onMouseUpCapture = (e: MouseEvent) => {
		if (e.button === 3 || e.button === 4) {
			e.preventDefault();
			e.stopPropagation();
			void goAlong(e.button === 3 ? -1 : 1);
			return;
		}
		if (e.button === 1) {
			middleGuard.noteMiddleMouse();
			e.preventDefault();
		}
	};
	const onKeyDownCapture = (e: KeyboardEvent) => {
		if (isExplicitPasteKey(e)) middleGuard.noteExplicitPaste();
	};
	const onPasteCapture = (e: ClipboardEvent) => {
		if (middleGuard.shouldBlockPaste()) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	};
	const onBeforeInputCapture = (e: InputEvent) => {
		if ((e.inputType === "insertFromPaste" || e.inputType === "insertFromYank") && middleGuard.shouldBlockPaste()) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	};
	window.addEventListener("mousedown", onMouseDownCapture, true);
	window.addEventListener("auxclick", onAuxClickCapture, true);
	window.addEventListener("mouseup", onMouseUpCapture, true);
	window.addEventListener("keydown", onKeyDownCapture, true);
	window.addEventListener("paste", onPasteCapture, true);
	window.addEventListener("beforeinput", onBeforeInputCapture, true);
	onCleanup(() => {
		window.removeEventListener("mousedown", onMouseDownCapture, true);
		window.removeEventListener("auxclick", onAuxClickCapture, true);
		window.removeEventListener("mouseup", onMouseUpCapture, true);
		window.removeEventListener("keydown", onKeyDownCapture, true);
		window.removeEventListener("paste", onPasteCapture, true);
		window.removeEventListener("beforeinput", onBeforeInputCapture, true);
	});
}

export const canGo = (by: 1 | -1) => (by < 0 ? canGoBack(trail) : canGoForward(trail));

/** One place back, or forward again. A place in a file that can no longer be opened is passed over, for the one beyond it. */
export async function goAlong(by: 1 | -1): Promise<void> {
	// Where the cursor/panel is now is the place to come back to, even if it has not moved far enough to be one by itself.
	const now = here();
	if (now) noteCursor(now);
	for (let tries = 0; tries <= TRAIL_LENGTH; tries++) {
		const from = trail;
		const next = stepTrail(trail, by);
		if (!next) return notify(by < 0 ? "There is nowhere to go back to." : "There is nowhere to go forward to.");
		stepping++;
		trail = next.trail;
		try {
			if (next.place.path) {
				const parsed = parseViewKey(next.place.view);
				const needsFileOpen = activePath() !== next.place.path || (parsed ? parsed.center === "editors" && state.centerView !== "editors" : false) || next.place.line > 1;
				if (needsFileOpen) {
					// In the group that has the file open, this one first: a place in the other group is gone to there, not
					// opened a second time here.
					const groupIndex = state.groups[state.activeGroup]?.tabs.includes(next.place.path)
						? state.activeGroup
						: state.groups.findIndex((group) => group.tabs.includes(next.place.path));
					await openFile(next.place.path, { reveal: { line: next.place.line, column: next.place.column }, ...(groupIndex >= 0 ? { group: groupIndex } : {}) });
				}
			}
			restoreView(next.place.view);
		} finally {
			// Let reactive panel/editor effects settle before recording new stops again.
			setTimeout(() => stepping--, 60);
		}
		if (!next.place.path || activePath() === next.place.path) return;
		// It could not be opened (and the app has said why): its places are no use, and the cursor is where it was.
		trail = trailWithout(from, (path) => path === next.place.path);
	}
}
