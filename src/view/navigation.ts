// Back and forward through the places the cursor has been. Which places are
// kept, and what back and forward mean, is src/shared/navHistory.ts; this
// hears where the cursor comes to rest and takes it back there.
import { createEffect, on, onCleanup } from "solid-js";
import { canGoBack, canGoForward, NO_TRAIL, stepTrail, trailRenamed, trailWithout, visited, type Place, type Trail } from "../shared/navHistory";
import { activeEditor } from "./editor/EditorGroup";
import { activeDoc, activePath, notify, openFile, pathChanges, state } from "./state";

let trail: Trail = NO_TRAIL;
/** Steps back or forward that are under way: where they pass and land is on the trail already. */
let stepping = 0;

/** The cursor came to rest somewhere, by the user's hand or by a jump. */
export function noteCursor(place: Place) {
	if (!stepping) trail = visited(trail, place);
}

/** Where the open file's cursor is: line 1 for a file that is not shown as text yet. */
function here(): Place | null {
	const path = activePath();
	if (!path) return null;
	const editor = activeEditor();
	const at = editor && editor.getModel() === activeDoc()?.model ? editor.getPosition() : null;
	return { path, line: at?.lineNumber ?? 1, column: at?.column ?? 1 };
}

/** A file that comes to the front is a place, whichever way it is shown. Called once, from the window. */
export function useNavigation() {
	// Another folder is another trail.
	createEffect(on(() => state.workspace?.root, () => void (trail = NO_TRAIL)));
	// A file or folder renamed: the places in it go with it. Files gone: so are the places in them.
	const renamed = (rename: (path: string) => string) => void (trail = trailRenamed(trail, rename));
	const gone = (isGone: (path: string) => boolean) => void (trail = trailWithout(trail, isGone));
	pathChanges.renamed.add(renamed);
	pathChanges.gone.add(gone);
	onCleanup(() => (pathChanges.renamed.delete(renamed), pathChanges.gone.delete(gone)));
	createEffect(
		on(activePath, () => {
			// After the editor has taken the file and gone to where it was asked to: that is where the cursor is.
			queueMicrotask(() => {
				const place = here();
				if (place) noteCursor(place);
			});
		}),
	);
}

export const canGo = (by: 1 | -1) => (by < 0 ? canGoBack(trail) : canGoForward(trail));

/** One place back, or forward again. A place in a file that is gone is passed over. */
export async function goAlong(by: 1 | -1): Promise<void> {
	// Where the cursor is now is the place to come back to, even if it has not moved far enough to be one by itself.
	const now = here();
	if (now) noteCursor(now);
	const next = stepTrail(trail, by);
	if (!next) return notify(by < 0 ? "There is nowhere to go back to." : "There is nowhere to go forward to.");
	stepping++;
	trail = next.trail;
	try {
		await openFile(next.place.path, { reveal: { line: next.place.line, column: next.place.column } });
	} finally {
		// The editor says where the cursor went as it gets there; a moment later it is the user's again.
		setTimeout(() => stepping--, 0);
	}
	if (activePath() !== next.place.path) {
		// It could not be opened (and the app has said why): its places are no use.
		trail = trailWithout(trail, (path) => path === next.place.path);
	}
}
