// How large a picture an unfolding would draw, and whether that is asked about first.
//
// The layout runs on the window's own thread, so nothing answers while it runs: an unfolding too large to lay out
// in a moment stops the window. One that large is asked about before it is laid out, and is not what the graph
// opens with next time. Pure, so it can be tested.
import { fold, FOLD_ABOVE, FOLD_DIRS_ABOVE, isDir, isFold, visible, withoutUnresolved, type Filter, type FoldedDirs, type Graph, type GraphEdge } from "./model";

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

/** The size of a picture, from the nodes it draws. */
export function sizeOf(drawn: ReadonlySet<string>): PictureSize {
	let procedures = 0;
	for (const id of drawn) if (!isFold(id) && !isDir(id) && !id.endsWith("#")) procedures++;
	return { nodes: drawn.size, procedures };
}

/** What is drawn of the shown nodes with these scripts and folders folded: the picture the layout would be given. */
export function pictureSize(shown: Shown, folded: ReadonlySet<string>, dirs?: FoldedDirs): PictureSize {
	return sizeOf(fold(shown, folded, dirs).nodes);
}

/**
 * Whether a picture of this many nodes is asked about before it is laid out: more than `ASK_ABOVE`, and more than
 * the largest picture already said yes to (`agreed`; 0 when none has been), so that unfolding one more script of a
 * picture that was agreed to does not ask again.
 */
export const asksFirst = (nodes: number, agreed = 0) => nodes > Math.max(ASK_ABOVE, agreed);

const drawnWords = (size: PictureSize) => `${size.nodes} nodes${size.procedures ? `, ${size.procedures} of them procedures` : ""}`;

/** The question put before a picture that is asked about: `what` is the unfolding ("Unfold all"), or the change of what is shown (`shownWords`). */
export const unfoldQuestion = (what: string, size: PictureSize) =>
	`${what}? That draws ${size.nodes} nodes at once${size.procedures ? `, ${size.procedures} of them procedures` : ""}. Laying them out may take a while, and the window does not answer until it is done.`;

/**
 * What is chosen of a picture, as far as it decides which nodes are drawn of a workspace's calls: what is shown
 * (every call, the calls between scripts, or those around a focus), the scripts and folders that are folded,
 * whether the targets that did not resolve are drawn, and the ticket the picture is narrowed to, if it is.
 */
export type Chosen = { filter: Filter; scripts: ReadonlySet<string>; folders: ReadonlySet<string>; unresolved: boolean; ticket: string | null };

/** A choice as one string: two choices with the same string draw the same picture of the same calls. */
export const chosenKey = (c: Chosen) =>
	JSON.stringify([c.filter.mode, c.filter.mode === "around" ? [c.filter.focus ?? "", c.filter.depth, c.filter.direction ?? "both"] : null, [...c.scripts].sort(), [...c.folders].sort(), c.unresolved, c.ticket]);

/**
 * What a change of what is shown is called in the question put before it (`unfoldQuestion`): in the words of the
 * control that makes it where one choice of the bar is what changed, and as the picture it is otherwise.
 */
export function shownWords(before: Chosen | null, now: Chosen): string {
	if (before && before.filter.mode !== now.filter.mode) {
		if (now.filter.mode === "all") return "Show every call";
		if (now.filter.mode === "cross") return "Show calls between scripts";
	}
	if (before && !before.unresolved && now.unresolved) return "Show unresolved targets";
	return "Show this picture";
}

/**
 * The one check every picture passes before it is laid out, whichever way it was reached. `next` is given each
 * picture that is about to be laid out: the choice it is of (`chosenKey`), that choice as the view can put it back
 * (`chosen`), how many nodes it draws, and the largest picture already said yes to. It answers "draw", "ask" (the
 * picture is not laid out; `asked` then has what a no goes back to, and `answer` takes the answer) or "wait" (a
 * question is open: nothing is laid out, and nothing more is asked, until it is answered). `rests` is told what
 * is chosen whenever nothing is to be laid out of it (the list is shown): a no goes back to that too.
 *
 * The question used to be asked by the three fold actions and by nothing else. Every other way to a large picture
 * laid it out unasked: "Calls between scripts", "Unfold all" (a small picture, so no question), then "Every call"
 * drew 1,440 nodes, and the window did not answer for as long as that took. The Show list, the depth and the
 * direction around a focus, a focus on a procedure with hundreds of callers, the unresolved targets, the ticket
 * filter taken off (from the bar or from the Palette) and the switch from the list to the graph were all such
 * ways. The layout is where they meet, so the check is there, and a way added later passes it too.
 *
 * Not asked about: a picture of the choice that was last laid out. Only the calls have changed then (a refresh),
 * and there is nothing to go back to.
 */
export function layoutGate<S>() {
	/** The choice whose picture was last let through to the layout. */
	let laid: string | null = null;
	/** What was chosen when a picture was last let through, or when there was last nothing to lay out. */
	let before: S | null = null;
	/** The picture a question is open about, and what a no to it goes back to. */
	let asking: { nodes: number; back: S | null } | null = null;
	return {
		/** A workspace's graph opens: nothing of it has been laid out, and nothing was chosen before. */
		opens() {
			laid = null;
			before = null;
			asking = null;
		},
		rests(chosen: S) {
			if (!asking) before = chosen;
		},
		next(key: string, chosen: S, nodes: number, agreed: number): "draw" | "ask" | "wait" {
			if (asking) return "wait";
			if (key !== laid && asksFirst(nodes, agreed)) {
				asking = { nodes, back: before };
				return "ask";
			}
			laid = key;
			before = chosen;
			return "draw";
		},
		/** The question is not put after all (the view is not on screen): nothing is open, and the picture is held back until it is given to `next` again. */
		unasked() {
			asking = null;
		},
		/** What a no to the open question goes back to; null when nothing was chosen before it, or no question is open. */
		asked: (): S | null => asking?.back ?? null,
		/**
		 * The answer to the open question. Yes: how many nodes are now agreed to; the picture passes when it is
		 * given to `next` again. No: what to go back to (null when nothing was chosen before). Null when no
		 * question is open any more: the workspace was changed while it was asked.
		 */
		answer(yes: boolean): { agreed: number } | { back: S | null } | null {
			const asked = asking;
			asking = null;
			if (!asked) return null;
			return yes ? { agreed: asked.nodes } : { back: asked.back };
		},
	};
}

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

/**
 * How large the picture is that the graph opens with: every call, with the folds `openingFolds` gave. That
 * picture is laid out without asking: it is what was kept when that is small enough and everything folded
 * otherwise, and there is nothing less to draw. So it counts as said yes to, however large it is (a workspace of
 * hundreds of scripts in one folder), and coming back to it is not asked about.
 */
export function openingSize(graph: Graph, folds: { scripts: string[]; folders: string[] }, folderOf: (path: string) => string, withUnresolved = true): PictureSize {
	const whole = visible(graph, { mode: "all", depth: 1 });
	return pictureSize(withUnresolved ? whole : withoutUnresolved(graph, whole), new Set(folds.scripts), { folded: new Set(folds.folders), of: folderOf });
}
