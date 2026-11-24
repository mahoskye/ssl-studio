// Path helpers for code that sees paths from more than one source (the Bun
// process, Monaco's Uri.fsPath, the language server's URIs) on Linux, macOS
// and Windows: either separator, and drive letters in either case.

const isWindowsPath = (p: string) => /^[a-zA-Z]:(?:[\\/]|$)/.test(p) || p.includes("\\") || /^\/\/[^/]/.test(p);

type CollapsedPath = {
	prefix: string;
	segments: string[];
	windows: boolean;
};

/** Parses a path into its immutable root prefix and collapsed segments, preserving original casing. */
function parseCollapsed(p: string): CollapsedPath {
	const windows = isWindowsPath(p);
	const forward = p.replace(/\\/g, "/");
	let prefix = "";
	let rest = forward;
	const drive = /^[a-zA-Z]:(?=\/|$)/.exec(forward);
	if (drive) {
		prefix = `${drive[0]}/`;
		rest = forward.slice(drive[0].length);
	} else if (forward.startsWith("//") && forward[2] !== "/") {
		// Pin UNC `//server/share` as an immutable prefix so `..` segments cannot escape the share root.
		const parts = forward.slice(2).split("/");
		const server = parts[0] ?? "";
		const share = parts[1] ?? "";
		if (server && share) {
			prefix = `//${server}/${share}`;
			rest = parts.slice(2).join("/");
		} else if (server) {
			prefix = `//${server}`;
			rest = "";
		} else {
			prefix = "//";
			rest = "";
		}
	} else if (forward.startsWith("/")) {
		prefix = "/";
		rest = forward.slice(1);
	}
	const segments: string[] = [];
	for (const part of rest.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
			else if (!prefix) segments.push("..");
		} else {
			segments.push(part);
		}
	}
	return { prefix, segments, windows };
}

/** Normalizes separators, collapses `.` and `..` segments, and lowercases Windows paths. */
function collapsePath(p: string): string {
	const { prefix, segments, windows } = parseCollapsed(p);
	const normPrefix = windows ? prefix.toLowerCase() : prefix;
	const normSegments = windows ? segments.map((s) => s.toLowerCase()) : segments;
	if (!normPrefix) return normSegments.join("/");
	if (normPrefix.endsWith("/")) return normPrefix + normSegments.join("/");
	return normSegments.length ? `${normPrefix}/${normSegments.join("/")}` : normPrefix;
}

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export const dirName = (path: string): string => {
	if (!path) return "";
	if (/^\/+$/.test(path)) return "/";
	const winRoot = /^([a-zA-Z]:)([\\/])[\\/]*$/.exec(path);
	if (winRoot) return winRoot[1]! + winRoot[2]!;
	const uncRoot = /^([\\/]{2}[^\\/]+[\\/][^\\/]+)[\\/]*$/.exec(path);
	if (uncRoot) return uncRoot[1]!;

	const trimmed = path.replace(/[\\/]+$/, "");
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (cut < 0) return "";
	if (cut === 0) return trimmed[0]!;
	const dir = trimmed.slice(0, cut);
	if (/^[a-zA-Z]:$/.test(dir)) return dir + trimmed[cut]!;
	const dirWinRoot = /^([a-zA-Z]:)([\\/])[\\/]*$/.exec(dir);
	if (dirWinRoot) return dirWinRoot[1]! + dirWinRoot[2]!;
	if (/^\/+$/.test(dir)) return "/";
	const uncPrefix = /^([\\/]{2}[^\\/]+[\\/][^\\/]+)[\\/]*$/.exec(dir);
	if (uncPrefix) return uncPrefix[1]!;
	return dir.replace(/[\\/]+$/, "");
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
	const r = parseCollapsed(root);
	const p = parseCollapsed(path);
	return p.segments.slice(r.segments.length).join("/");
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
	const from = parseCollapsed(fromDir);
	const target = parseCollapsed(to);
	const win = from.windows || target.windows;
	const norm = (s: string) => (win ? s.toLowerCase() : s);
	if (norm(from.prefix) !== norm(target.prefix)) return to;
	let same = 0;
	while (same < from.segments.length && same < target.segments.length && norm(from.segments[same]!) === norm(target.segments[same]!)) {
		same++;
	}
	return [...from.segments.slice(same).map(() => ".."), ...target.segments.slice(same)].join("/");
}

/** The folders no listing of a workspace shows: version control, what is installed or built, and the app's own. */
export const UNLISTED = [".git", "node_modules", ".ssl-studio", ".hutch", "dist", "build"] as const;
