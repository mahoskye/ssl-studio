// What the Explorer offers for a file or a folder, and what it refuses. Pure,
// so it can be tested.
import type { RowMenuEntry } from "../../shared/contextMenu";
import { dirName, isInside } from "../../shared/paths";

export const OPEN = "Open";
export const OPEN_SIDE = "Open to the side";
export const NEW_FILE = "New file";
export const NEW_FOLDER = "New folder";
export const FIND_IN_FOLDER = "Find in folder…";
export const RENAME = "Rename";
/** One wording for the menu, the confirmation and its button. */
export const TRASH = "Move to trash";
export const CUT = "Cut";
export const COPY = "Copy";
export const PASTE = "Paste";
export const COPY_PATH = "Copy path";
export const COPY_RELATIVE = "Copy path in the project";
export const COPY_NAME = "Copy name";
export const SCHEMA_FROM_SQL = "Generate / sync schema doc from SQL…";
export const OPEN_GOVERNING_DOC = "Open governing doc…";
export const ATTACH_TO_AGENT = "Attach to Agent";
export type Action =
	| typeof OPEN
	| typeof OPEN_SIDE
	| typeof NEW_FILE
	| typeof NEW_FOLDER
	| typeof FIND_IN_FOLDER
	| typeof CUT
	| typeof COPY
	| typeof PASTE
	| typeof RENAME
	| typeof TRASH
	| typeof COPY_PATH
	| typeof COPY_RELATIVE
	| typeof COPY_NAME
	| typeof SCHEMA_FROM_SQL
	| typeof OPEN_GOVERNING_DOC
	| typeof ATTACH_TO_AGENT;
export type MenuEntry = RowMenuEntry;
export type ExplorerMenuExtra = { sql?: boolean; governingCount?: number; attachable?: boolean };

/** True for the workspace folder and for anything that holds it: never renamed or trashed from here. */
export const holdsRoot = (root: string, path: string) => isInside(path, root);

/**
 * The menu for an entry (flat action list kept for pure checks). The workspace folder gets only what adds to it:
 * it is never cut, copied, renamed or trashed from here.
 */
export function menuFor(kind: "file" | "dir", path: string, root: string, canPaste = false): Action[] {
	const paste: Action[] = canPaste ? [PASTE] : [];
	if (holdsRoot(root, path)) return [NEW_FILE, NEW_FOLDER, ...paste, COPY_PATH];
	const own: Action[] = [CUT, COPY, ...paste, COPY_PATH, COPY_RELATIVE, COPY_NAME, RENAME, TRASH];
	return kind === "dir" ? [NEW_FILE, NEW_FOLDER, ...own] : own;
}

/**
 * Sectioned Explorer context menu with dividers, a Copy path submenu,
 * shortcut hints, and isolated destructive actions.
 */
export function menuEntriesFor(kind: "file" | "dir", path: string, root: string, canPaste = false, extra?: ExplorerMenuExtra): MenuEntry[] {
	const item = (value: Action, label: string = value, keys?: string, danger?: boolean): MenuEntry => ({ label, value, keys, danger });
	const paste: MenuEntry[] = canPaste ? [item(PASTE, PASTE, "Ctrl+V")] : [];
	if (holdsRoot(root, path)) {
		return [
			item(NEW_FILE, "New file…"),
			item(NEW_FOLDER, "New folder…"),
			"separator",
			item(FIND_IN_FOLDER),
			...(paste.length ? (["separator", ...paste] as MenuEntry[]) : []),
			"separator",
			item(COPY_PATH),
		];
	}
	const clipGroup: MenuEntry[] = [item(CUT, CUT, "Ctrl+X"), item(COPY, COPY, "Ctrl+C"), ...paste];
	const pathSubmenu: MenuEntry = {
		label: "Copy path",
		children: [item(COPY_PATH), item(COPY_RELATIVE), item(COPY_NAME)],
	};
	const renameItem = item(RENAME, RENAME, "F2");
	const trashItem = item(TRASH, TRASH, "Delete", true);
	if (kind === "dir") {
		return [
			item(NEW_FILE, "New file…"),
			item(NEW_FOLDER, "New folder…"),
			"separator",
			item(FIND_IN_FOLDER),
			"separator",
			...clipGroup,
			"separator",
			pathSubmenu,
			"separator",
			renameItem,
			"separator",
			trashItem,
		];
	}
	const docGroup: MenuEntry[] = [];
	if (extra?.sql) docGroup.push(item(SCHEMA_FROM_SQL));
	if ((extra?.governingCount ?? 0) > 0) {
		docGroup.push(item(OPEN_GOVERNING_DOC, extra!.governingCount === 1 ? "Open governing doc" : `Open governing doc (${extra!.governingCount})…`));
	}
	if (extra?.attachable) docGroup.push(item(ATTACH_TO_AGENT));
	return [
		item(OPEN),
		item(OPEN_SIDE),
		...(docGroup.length ? (["separator", ...docGroup] as MenuEntry[]) : []),
		"separator",
		...clipGroup,
		"separator",
		pathSubmenu,
		"separator",
		renameItem,
		"separator",
		trashItem,
	];
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
