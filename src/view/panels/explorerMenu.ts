// What the Explorer offers for a file or a folder, and what it refuses. Pure,
// so it can be tested.
import { dirName, isInside } from "../../shared/paths";

export const NEW_FILE = "New file";
export const NEW_FOLDER = "New folder";
export const RENAME = "Rename";
/** One wording for the menu, the confirmation and its button. */
export const TRASH = "Move to trash";
export type Action = typeof NEW_FILE | typeof NEW_FOLDER | typeof RENAME | typeof TRASH;

/** True for the workspace folder and for anything that holds it: never renamed or trashed from here. */
export const holdsRoot = (root: string, path: string) => isInside(path, root);

/** The menu for an entry. The workspace folder gets only the two that add to it. */
export function menuFor(kind: "file" | "dir", path: string, root: string): Action[] {
	if (holdsRoot(root, path)) return [NEW_FILE, NEW_FOLDER];
	return kind === "dir" ? [NEW_FILE, NEW_FOLDER, RENAME, TRASH] : [RENAME, TRASH];
}

/** Why a typed name cannot be used, or "" when it can. */
export function nameProblem(name: string): string {
	const parts = name.trim().split(/[\\/]/);
	if (!name.trim()) return "A name is needed.";
	if (parts.some((part) => !part || part === "." || part === "..")) return `“${name.trim()}” is not a name that can be used here.`;
	return "";
}

/** The folder a new file goes in: the focused row's (itself, when it is a folder), else the active file's, else the workspace's. */
export function folderFor(focused: { path: string; kind: "file" | "dir" } | null, active: string | null, root: string): string {
	if (focused) return focused.kind === "dir" ? focused.path : dirName(focused.path);
	return active && isInside(root, active) && active !== root ? dirName(active) : root;
}

/** Paths as they are after `from` was renamed to `to`: the path itself and everything under it follow. */
export function retarget(paths: Iterable<string>, from: string, to: string): string[] {
	return [...paths].map((path) => (path === from ? to : isInside(from, path) ? to + path.slice(from.length) : path));
}

/** Paths left after `removed` went: it and everything under it are dropped. */
export function without(paths: Iterable<string>, removed: string): string[] {
	return [...paths].filter((path) => !isInside(removed, path));
}

/** The open folders as they were kept, read with suspicion: only paths inside the workspace count. */
export function openFolders(kept: string | null, root: string): string[] {
	try {
		const list: unknown = JSON.parse(kept ?? "[]");
		return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string" && isInside(root, p)) : [];
	} catch {
		return [];
	}
}
