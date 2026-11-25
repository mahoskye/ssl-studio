// Back and forward through the places and screens the user has visited:
// files, cursor jumps, center views (editors/graph/welcome), and right-panel
// switches (e.g. Palette Assistant -> Agent panel -> Mouse 4 back to Palette).
// Pure trail logic lives in src/shared/navHistory.ts; this wires keyboard,
// menu, and application-wide Mouse 4 / Mouse 5 back/forward navigation.
import { createEffect, createMemo, onSettled, snapshot } from "solid-js";
import { createMiddleClickGuard, isExplicitPasteKey } from "../shared/middleClickGuard";
import { canGoBack, canGoForward, NO_TRAIL, stepTrail, TRAIL_LENGTH, trailRenamed, trailWithout, visited, type Place, type Trail } from "../shared/navHistory";
import { resolvePlanMode } from "../shared/viewModes";
import { activeEditor } from "./editor/EditorGroup";
import { activeLiveEditor } from "./editor/liveBridge";
import { activeGraphBridge } from "./graph/graphBridge";
import { modalOpen } from "./modal";
import { narrowHosted, narrowPanels, showPanel } from "./panels/registry";
import { isPlanPath } from "./plan/model";
import { activePlanTab, requestPlanPaletteTab } from "./plan/planBridge";
import { activePath, documents, notify, openFile, pathChanges, setState, state, type PanelId } from "./state";

let trail: Trail = NO_TRAIL;
/** Steps back or forward that are under way: where they pass and land is on the trail already. */
let stepping = 0;

function isPlanChartActiveIn(src: typeof state): boolean {
	if (src.centerView !== "editors") return false;
	const group = src.groups[src.activeGroup];
	const path = group?.active ?? null;
	if (!path || !isPlanPath(path)) return false;
	if (resolvePlanMode(group?.planMode, src.planViewMode) === "source") return false;
	const doc = documents.get(path);
	return Boolean(doc && !doc.binary);
}

/** Encodes the active screen and right-side panel so panel switches join Back / Forward history. */
function viewKeyFrom(src: typeof state): string {
	const center = src.centerView;
	const rightId = narrowPanels()
		? (src.settings.layout.left && narrowHosted() ? narrowHosted()! : "")
		: (src.settings.layout.right ? src.rightView : "");
	const planTab = rightId === "palette" && isPlanChartActiveIn(src) ? `:${activePlanTab()}` : "";
	return `${center}|${rightId}${planTab}`;
}

function currentViewKey(): string {
	return viewKeyFrom(state);
}

function parseViewKey(view?: string): {
	center: "editors" | "graph" | "welcome";
	graphFocus: string | null;
	rightId: PanelId | "";
	planTab: "design" | "assistant" | null;
} | null {
	if (!view) return null;
	const [centerPart = "", rightRaw = ""] = view.split("|");
	const hashAt = centerPart.indexOf("#");
	const centerRaw = hashAt >= 0 ? centerPart.slice(0, hashAt) : centerPart;
	const graphFocus = hashAt >= 0 ? centerPart.slice(hashAt + 1) || null : null;
	if (centerRaw !== "editors" && centerRaw !== "graph" && centerRaw !== "welcome") return null;
	const [rightIdRaw, tabRaw] = rightRaw.split(":");
	const rightId = (rightIdRaw || "") as PanelId | "";
	const planTab = tabRaw === "design" || tabRaw === "assistant" ? tabRaw : null;
	return { center: centerRaw, graphFocus, rightId, planTab };
}

function isGraphViewKey(view?: string): boolean {
	if (!view) return false;
	return view === "graph" || view.startsWith("graph|") || view.startsWith("graph#");
}

/** The cursor or view came to rest somewhere, by the user's hand or by a jump. */
export function noteCursor(place: Place) {
	if (stepping) return;
	trail = visited(trail, place.view === undefined ? { ...place, view: viewKeyFrom(snapshot(state)) } : place);
}

/** Where the window currently stands: active file + cursor + screen/right-panel context. */
function here(): Place | null {
	const cur = snapshot(state);
	const view = viewKeyFrom(cur);
	// Non-editor center screens (Call Graph, Welcome) must not stamp a background editor's
	// file path or cursor line > 1, which would mistakenly trigger `openFile` on Back/Forward.
	if (cur.centerView === "graph" || cur.centerView === "welcome") {
		return { path: "", line: 1, column: 1, view };
	}
	const path = cur.groups[cur.activeGroup]?.active ?? "";
	if (!path) return null;
	const live = activeLiveEditor();
	if (live && live.path === path) {
		const at = live.getPosition();
		return { path, line: at.lineNumber, column: at.column, view };
	}
	const editor = activeEditor();
	const at = editor && editor.getModel() === documents.get(path)?.model ? editor.getPosition() : null;
	return { path, line: at?.lineNumber ?? 1, column: at?.column ?? 1, view };
}

/** Restores the center view, optional graph focus node, right panel, and Palette plan tab recorded on a navigation stop. */
function restoreView(view?: string, fallbackGraphFocus?: string) {
	const parsed = parseViewKey(view);
	if (!parsed) return;
	const cur = snapshot(state);
	if (cur.centerView !== parsed.center) {
		setState((s) => {
			s.centerView = parsed.center;
		});
	}
	if (parsed.center === "graph") {
		const focusId = parsed.graphFocus || fallbackGraphFocus;
		if (focusId) queueMicrotask(() => activeGraphBridge()?.focusTarget(focusId));
	}
	if (parsed.rightId) {
		const currentRight = narrowPanels() ? narrowHosted() : (cur.settings.layout.right ? cur.rightView : null);
		if (currentRight !== parsed.rightId) showPanel(parsed.rightId);
	}
	if (parsed.planTab) requestPlanPaletteTab(parsed.planTab);
}

/** Tracks active files, panel/screen transitions, and application-wide Mouse 4 / Mouse 5 buttons. Called once from App. */
export function useNavigation() {
	// Another folder is another trail.
	const root = createMemo(() => state.workspace?.root);
	createEffect(root, () => {
		trail = NO_TRAIL;
	});

	// Record file switches, centerView switches (editors/graph/welcome), and right-panel / plan-tab switches.
	const locationKey = createMemo(
		() => [activePath(), currentViewKey(), state.workspace?.root] as const,
		{ equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] },
	);
	createEffect(locationKey, ([, , wsRoot]) => {
		if (!wsRoot) return;
		queueMicrotask(() => {
			if (snapshot(state).workspace?.root !== wsRoot) return;
			const place = here();
			if (place) noteCursor(place);
		});
	});

	onSettled(() => {
		// A file or folder renamed: the places in it go with it. Files gone: so are the places in them.
		const renamed = (rename: (path: string) => string) => void (trail = trailRenamed(trail, rename));
		const gone = (isGone: (path: string) => boolean) => void (trail = trailWithout(trail, isGone));
		pathChanges.renamed.add(renamed);
		pathChanges.gone.add(gone);

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
				if (modalOpen()) return;
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
		return () => {
			pathChanges.renamed.delete(renamed);
			pathChanges.gone.delete(gone);
			window.removeEventListener("mousedown", onMouseDownCapture, true);
			window.removeEventListener("auxclick", onAuxClickCapture, true);
			window.removeEventListener("mouseup", onMouseUpCapture, true);
			window.removeEventListener("keydown", onKeyDownCapture, true);
			window.removeEventListener("paste", onPasteCapture, true);
			window.removeEventListener("beforeinput", onBeforeInputCapture, true);
		};
	});
}

export const canGo = (by: 1 | -1) => (by < 0 ? canGoBack(trail) : canGoForward(trail));

/** One place back, or forward again. A place in a file that can no longer be opened is passed over, for the one beyond it. */
export async function goAlong(by: 1 | -1): Promise<void> {
	const startRoot = snapshot(state).workspace?.root;
	if (!startRoot) return;
	// Where the cursor/panel is now is the place to come back to, even if it has not moved far enough to be one by itself.
	const now = here();
	if (now) noteCursor(now);
	for (let tries = 0; tries <= TRAIL_LENGTH; tries++) {
		if (state.workspace?.root !== startRoot) return;
		const from = trail;
		const next = stepTrail(trail, by);
		if (!next) return notify(by < 0 ? "There is nowhere to go back to." : "There is nowhere to go forward to.");
		stepping++;
		trail = next.trail;
		let isGraphPlace = false;
		try {
			const parsed = parseViewKey(next.place.view);
			isGraphPlace = isGraphViewKey(next.place.view) || parsed?.center === "graph";
			if (isGraphPlace) {
				// Returning to the Call Graph must never open an editor file (which forces centerView="editors").
				const focusId =
					parsed?.graphFocus ||
					(next.place as Place & { graphFocus?: string }).graphFocus ||
					(next.place.path || undefined);
				if (snapshot(state).centerView !== "graph") {
					setState((s) => {
						s.centerView = "graph";
					});
				}
				restoreView(next.place.view, focusId);
			} else {
				if (next.place.path) {
					const cur = here();
					const curState = snapshot(state);
					const curActive = curState.groups[curState.activeGroup]?.active ?? null;
					const sameFile = curActive === next.place.path;
					const movedCursor = sameFile && (!cur || cur.line !== next.place.line || cur.column !== next.place.column);
					const needsFileOpen =
						!sameFile ||
						(parsed ? parsed.center === "editors" && curState.centerView !== "editors" : false) ||
						movedCursor;
					if (needsFileOpen) {
						// In the group that has the file open, this one first: a place in the other group is gone to there, not
						// opened a second time here.
						const groupIndex = curState.groups[curState.activeGroup]?.tabs.includes(next.place.path)
							? curState.activeGroup
							: curState.groups.findIndex((group) => group.tabs.includes(next.place.path));
						await openFile(next.place.path, { reveal: { line: next.place.line, column: next.place.column }, ...(groupIndex >= 0 ? { group: groupIndex } : {}) });
						if (state.workspace?.root !== startRoot) return;
					}
				}
				restoreView(next.place.view);
			}
		} finally {
			// Let reactive panel/editor effects settle before recording new stops again.
			setTimeout(() => stepping--, 60);
		}
		const afterState = snapshot(state);
		if (afterState.workspace?.root !== startRoot) return;
		const afterActive = afterState.groups[afterState.activeGroup]?.active ?? null;
		if (isGraphPlace || !next.place.path || afterActive === next.place.path) return;
		// It could not be opened (and the app has said why): its places are no use, and the cursor is where it was.
		trail = trailWithout(from, (path) => path === next.place.path);
	}
}
