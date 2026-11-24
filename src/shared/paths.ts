// Path helpers for code that sees paths from more than one source (the Bun
// process, Monaco's Uri.fsPath, the language server's URIs) on Linux, macOS
// and Windows: either separator, and drive letters in either case.

const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\");

/** Normalizes separators, collapses `.` and `..` segments, and lowercases Windows paths. */
function collapsePath(p: string): string {
	const forward = p.replace(/\\/g, "/");
	const lower = isWindowsPath(p) ? forward.toLowerCase() : forward;
	let prefix = "";
	let rest = lower;
	const drive = /^[a-zA-Z]:(?=\/|$)/.exec(lower);
	if (drive) {
		prefix = `${drive[0].toLowerCase()}/`;
		rest = lower.slice(drive[0].length);
	} else if (lower.startsWith("//") && lower[2] !== "/") {
		prefix = "//";
		rest = lower.slice(2);
	} else if (lower.startsWith("/")) {
		prefix = "/";
		rest = lower.slice(1);
	}
	const out: string[] = [];
	for (const part of rest.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
			else if (!prefix) out.push("..");
		} else {
			out.push(part);
		}
	}
	return prefix + out.join("/");
}

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export const dirName = (path: string) => {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const dir = cut <= 0 ? path.slice(0, cut + 1) : path.slice(0, cut);
	return /^[a-zA-Z]:$/.test(dir) ? dir + path[cut] : dir;
};

/** Joins with the separator the base path already uses. */
export const joinPath = (base: string, ...parts: string[]) => [base.replace(/[\\/]+$/, ""), ...parts].join(base.includes("\\") && !base.includes("/") ? "\\" : "/");

/** `relative` applied to `dir`, "." and ".." included, with the separator `dir` uses. */
export function resolvePath(dir: string, relative: string): string {
	const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
	for (const part of relative.split(/[\\/]/)) {
		if (!part || part === ".") continue;
		if (part !== "..") parts.push(part);
		else if (parts.length > 1) parts.pop();
	}
	const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
	if (parts.length === 1 && parts[0] === "") return "/";
	if (parts.length === 1 && /^[a-zA-Z]:$/.test(parts[0]!)) return parts[0]! + sep;
	return parts.join(sep);
}

export function isInside(root: string, path: string): boolean {
	if (!root || !path) return false;
	const r = collapsePath(root);
	const p = collapsePath(path);
	if (!r || !p) return false;
	if (p === r) return true;
	return r.endsWith("/") ? p.startsWith(r) : p.startsWith(r + "/");
}

/** The path relative to root, with forward slashes; the path itself when outside. */
export function relativeTo(root: string | undefined | null, path: string): string {
	if (!root || !isInside(root, path)) return path;
	return path.replace(/\\/g, "/").slice(root.replace(/[\\/]+$/, "").length + 1);
}

/**
 * What the file system said of opening or reading a file, in plain words,
 * with the path as the project names it: "docs/specs/Notes.md is not there."
 * Only that sentence, whole and alone, is reworded: a message that says
 * more, or is about making, moving or removing something, is returned as
 * it was.
 */
export function plainFileError(message: string, root?: string | null): string {
	const found = /^(?:Error: )?(ENOENT|EACCES|EPERM|EISDIR): [^,\n]+, (open|read|stat|lstat|scandir) '(.+)'$/.exec(message.trim());
	// "rename 'a' -> 'b'" names two paths, and which of them is missing is not ours to guess.
	if (!found || found[3]!.includes("' -> '")) return message;
	const path = relativeTo(root, found[3]!);
	if (found[1] === "ENOENT") return `${path} is not there.`;
	if (found[1] === "EISDIR") return `${path} is a folder, not a file.`;
	return `${path} cannot be ${found[2] === "scandir" ? "listed" : "opened"}: permission was refused.`;
}

/** The way from one folder to a file, with forward slashes: "../design/A.plan.md". Both are whole paths. */
export function relativePath(fromDir: string, to: string): string {
	const split = (path: string) => path.split(/[\\/]/).filter(Boolean);
	const [from, target] = [split(fromDir), split(to)];
	// A drive's letter is the same drive in either case: one side may have come through a URI, which lowers it.
	const alike = (a: string, b: string) => a === b || (/^[A-Za-z]:$/.test(a) && a.toLowerCase() === b.toLowerCase());
	let same = 0;
	while (same < from.length && same < target.length && alike(from[same]!, target[same]!)) same++;
	return [...from.slice(same).map(() => ".."), ...target.slice(same)].join("/");
}

/** The folders no listing of a workspace shows: version control, what is installed or built, and the app's own. */
export const UNLISTED = [".git", "node_modules", ".ssl-studio", ".hutch", "dist", "build"] as const;
