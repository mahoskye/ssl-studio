// How large a picture an unfolding would draw, and whether that is asked about first.
//
// The layout runs on the window's own thread, so nothing answers while it runs: an unfolding too large to lay out
// in a moment stops the window. One that large is asked about before it is laid out, and is not what the graph
// opens with next time. Pure, so it can be tested.
import { fold, FOLD_ABOVE, FOLD_DIRS_ABOVE, isDir, isFold, visible, withoutUnresolved, type FoldedDirs, type Graph, type GraphEdge } from "./model";

/**
 * More nodes than this in one picture, and laying it out is asked about first. One pass over a workspace whose calls
 * stay mostly inside their own scripts was measured at about 0.6 s for 250 procedures, 2.4 s for 720 and 38 s for
 * 1,440 in a Chromium window. Run under Bun (JavaScriptCore, the engine the system web view has on Linux and
 * macOS) the same pictures took about three times as long, and one whose calls mostly cross between scripts three
 * times as long again. Up to here the wait is a second or two; past it the time grows faster than the count.
 */
export const ASK_ABOVE = 250;

export type Shown = { nodes: ReadonlySet<string>; edges: readonly GraphEdge[] };
/** A picture's size: every node it draws, and how many of them are procedures (the rest are folded scripts, folded folders and scripts' top levels). */
export type PictureSize = { nodes: number; procedures: number };

/** What is drawn of the shown nodes with these scripts and folders folded: the picture the layout would be given. */
export function pictureSize(shown: Shown, folded: ReadonlySet<string>, dirs?: FoldedDirs): PictureSize {
	const drawn = fold(shown, folded, dirs).nodes;
	let procedures = 0;
	for (const id of drawn) if (!isFold(id) && !isDir(id) && !id.endsWith("#")) procedures++;
	return { nodes: drawn.size, procedures };
}

/**
 * Whether a picture of this many nodes is asked about before it is laid out: more than `ASK_ABOVE`, and more than
 * the largest picture already said yes to (`agreed`; 0 when none has been), so that unfolding one more script of a
 * picture that was agreed to does not ask again.
 */
export const asksFirst = (nodes: number, agreed = 0) => nodes > Math.max(ASK_ABOVE, agreed);

const drawnWords = (size: PictureSize) => `${size.nodes} nodes${size.procedures ? `, ${size.procedures} of them procedures` : ""}`;

/** The question put before an unfolding that is asked about: `what` is the unfolding ("Unfold all"). */
export const unfoldQuestion = (what: string, size: PictureSize) =>
	`${what}? That draws ${size.nodes} nodes at once${size.procedures ? `, ${size.procedures} of them procedures` : ""}. Laying them out may take a while, and the window does not answer until it is done.`;

/** What is said when the folds kept from last time are not taken up because they would draw too much. */
export const openedFoldedNote = (size: PictureSize) =>
	`The call graph was left unfolded to ${drawnWords(size)}: more than is laid out without asking. It is opened folded; unfold what you need.`;

/**
 * The folds a graph opens with. What was kept from last time, when anything was and it is no more than is laid out
 * without asking. Kept folds that would draw more than that are not taken up: the window stopped answering as the
 * graph opened, at every visit, before "Fold all" could be reached; everything is folded instead, and `refused`
 * says how large the picture left behind was. With nothing kept, the opening picture: a large workspace's scripts
 * folded, and of many scripts in several folders, the folders too.
 */
export function openingFolds(
	graph: Graph,
	kept: { scripts: string[]; folders: string[] } | null,
	folderOf: (path: string) => string,
	withUnresolved = true,
): { scripts: string[]; folders: string[]; refused?: PictureSize } {
	const folders = [...new Set(graph.scripts.map((s) => folderOf(s.path)).filter(Boolean))];
	if (kept) {
		const whole = visible(graph, { mode: "all", depth: 1 });
		const size = pictureSize(withUnresolved ? whole : withoutUnresolved(graph, whole), new Set(kept.scripts), { folded: new Set(kept.folders), of: folderOf });
		if (!asksFirst(size.nodes)) return kept;
		return { scripts: graph.scripts.map((s) => s.path), folders: folders.length > 1 ? folders : [], refused: size };
	}
	return {
		scripts: graph.nodes.length > FOLD_ABOVE ? graph.scripts.map((s) => s.path) : [],
		folders: graph.scripts.length > FOLD_DIRS_ABOVE && folders.length > 1 ? folders : [],
	};
}
