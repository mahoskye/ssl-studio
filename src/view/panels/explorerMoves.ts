// Moving and copying in the Explorer: what a paste or a drop would do, what
// the copy is called, and what is refused. Pure, so it can be tested; the
// panel asks here before it touches a file.
import { baseName, dirName, isInside } from "../../shared/paths";

/** What was cut or copied in the tree. It is the app's own, not the system's clipboard: a path there is only text. */
export type Clip = { path: string; kind: "file" | "dir"; cut: boolean };

/** The folder a paste or a drop goes into: the row itself when it is a folder, else the folder it is in. */
export const folderOf = (onto: { path: string; kind: "file" | "dir" }) => (onto.kind === "dir" ? onto.path : dirName(onto.path));

/**
 * A name for a copy that is not taken: "DueRules copy.ssl", then
 * "DueRules copy 2.ssl". The word goes before the first dot, so that what a
 * file is (".plan.json", ".spec.md") stays whole; a name that begins with a
 * dot keeps its dot. A folder's name has no such end: the word goes last.
 */
export function copyName(name: string, taken: (name: string) => boolean, kind: "file" | "dir" = "file"): string {
	const dot = kind === "dir" ? -1 : name.indexOf(".", 1);
	const stem = dot < 0 ? name : name.slice(0, dot);
	const rest = dot < 0 ? "" : name.slice(dot);
	for (let n = 1; ; n++) {
		const next = `${stem} copy${n > 1 ? ` ${n}` : ""}${rest}`;
		if (!taken(next)) return next;
	}
}

/** Why something cannot be moved into a folder, or "" when it can. */
export function moveProblem(from: string, into: string, root: string): string {
	if (isInside(from, root)) return "The workspace folder itself cannot be moved from here.";
	if (!isInside(root, into)) return "That folder is outside the workspace.";
	if (isInside(from, into)) return `${baseName(from)} cannot be moved into itself.`;
	if (dirName(from) === into) return `${baseName(from)} is already in ${baseName(into)}.`;
	return "";
}

/** Why something cannot be copied into a folder, or "" when it can. A copy beside the original is fine: it gets a new name. */
export function copyProblem(from: string, into: string, root: string): string {
	if (isInside(from, root)) return "The workspace folder itself cannot be copied from here.";
	if (!isInside(root, into)) return "That folder is outside the workspace.";
	if (isInside(from, into)) return `${baseName(from)} cannot be copied into itself.`;
	return "";
}
