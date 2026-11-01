// Path helpers for code that sees paths from more than one source (the Bun
// process, Monaco's Uri.fsPath, the language server's URIs) on Linux, macOS
// and Windows: either separator, and drive letters in either case.

const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\");
const norm = (p: string) => {
	const forward = p.replace(/\\/g, "/").replace(/\/+$/, "");
	return isWindowsPath(p) ? forward.toLowerCase() : forward;
};

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export const dirName = (path: string) => {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const dir = cut <= 0 ? path.slice(0, cut + 1) : path.slice(0, cut);
	return /^[a-zA-Z]:$/.test(dir) ? dir + path[cut] : dir;
};

/** Joins with the separator the base path already uses. */
export const joinPath = (base: string, ...parts: string[]) => [base.replace(/[\\/]+$/, ""), ...parts].join(base.includes("\\") && !base.includes("/") ? "\\" : "/");

export function isInside(root: string, path: string): boolean {
	const r = norm(root);
	const p = norm(path);
	return p === r || p.startsWith(r + "/");
}

/** The path relative to root, with forward slashes; the path itself when outside. */
export function relativeTo(root: string | undefined | null, path: string): string {
	if (!root || !isInside(root, path)) return path;
	return path.replace(/\\/g, "/").slice(root.replace(/[\\/]+$/, "").length + 1);
}
