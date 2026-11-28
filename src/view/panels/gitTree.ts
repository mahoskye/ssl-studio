// Pure helpers for the VS Code-aligned Source Control panel:
// compacted folder trees for staged/unstaged changes, commit subject-line
// length validation, ref decoration parsing, and relative timestamps.
import type { GitFile } from "../../shared/gitStatus";

export type GitTreeFile = {
	file: GitFile;
	relPath: string;
};

export type GitTreeNode =
	| {
			kind: "folder";
			/** Stable fold key (`<section>:dir:<relDir>`). */
			key: string;
			/** Compacted folder display label (e.g. `src/DueDates`). */
			name: string;
			/** Workspace-relative POSIX folder path (e.g. `src/DueDates`). */
			relDir: string;
			/** Total changed files inside this folder subtree. */
			count: number;
			/** All GitFile entries inside this folder subtree (for folder-level Stage/Unstage/Discard). */
			files: GitFile[];
			children: GitTreeNode[];
	  }
	| {
			kind: "file";
			key: string;
			name: string;
			file: GitFile;
			relPath: string;
	  };

type DirBuild = {
	name: string;
	relDir: string;
	dirs: Map<string, DirBuild>;
	files: GitTreeFile[];
};

const normRel = (p: string) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

/**
 * Organizes Git file entries into a compacted VS Code-style folder tree:
 * single-child folder chains collapse (`src/DueDates`), folders sort before files,
 * and each folder carries its descendant `GitFile[]` for folder-level actions.
 */
export function buildGitFileTree(entries: readonly GitTreeFile[], section: string): GitTreeNode[] {
	const root: DirBuild = { name: "", relDir: "", dirs: new Map(), files: [] };
	for (const entry of entries) {
		const parts = normRel(entry.relPath).split("/").filter(Boolean);
		if (parts.length <= 1) {
			root.files.push(entry);
			continue;
		}
		let cur = root;
		let acc = "";
		for (let i = 0; i < parts.length - 1; i++) {
			const seg = parts[i]!;
			acc = acc ? `${acc}/${seg}` : seg;
			let child = cur.dirs.get(seg);
			if (!child) {
				child = { name: seg, relDir: acc, dirs: new Map(), files: [] };
				cur.dirs.set(seg, child);
			}
			cur = child;
		}
		cur.files.push(entry);
	}

	const finalizeDir = (dir: DirBuild): Extract<GitTreeNode, { kind: "folder" }> => {
		let cur = dir;
		let label = dir.name;
		while (cur.files.length === 0 && cur.dirs.size === 1) {
			const only = [...cur.dirs.values()][0]!;
			label = `${label}/${only.name}`;
			cur = only;
		}
		const folderChildren = [...cur.dirs.values()]
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
			.map(finalizeDir);
		const fileChildren: Extract<GitTreeNode, { kind: "file" }>[] = [...cur.files]
			.sort((a, b) => {
				const na = normRel(a.relPath).split("/").pop() ?? a.relPath;
				const nb = normRel(b.relPath).split("/").pop() ?? b.relPath;
				return na.localeCompare(nb, undefined, { sensitivity: "base" });
			})
			.map((entry) => ({
				kind: "file",
				key: `${section}:file:${entry.file.path}`,
				name: normRel(entry.relPath).split("/").pop() ?? entry.relPath,
				file: entry.file,
				relPath: entry.relPath,
			}));
		const children: GitTreeNode[] = [...folderChildren, ...fileChildren];
		const files = [...folderChildren.flatMap((c) => c.files), ...fileChildren.map((c) => c.file)];
		return {
			kind: "folder",
			key: `${section}:dir:${cur.relDir}`,
			name: label,
			relDir: cur.relDir,
			count: files.length,
			files,
			children,
		};
	};

	const topFolders = [...root.dirs.values()]
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
		.map(finalizeDir);
	const topFiles: Extract<GitTreeNode, { kind: "file" }>[] = [...root.files]
		.sort((a, b) => {
			const na = normRel(a.relPath).split("/").pop() ?? a.relPath;
			const nb = normRel(b.relPath).split("/").pop() ?? b.relPath;
			return na.localeCompare(nb, undefined, { sensitivity: "base" });
		})
		.map((entry) => ({
			kind: "file",
			key: `${section}:file:${entry.file.path}`,
			name: normRel(entry.relPath).split("/").pop() ?? entry.relPath,
			file: entry.file,
			relPath: entry.relPath,
		}));
	return [...topFolders, ...topFiles];
}

/** Collects every folder key in a Git file tree (for Collapse All / Expand All). */
export function collectGitTreeFolderKeys(nodes: readonly GitTreeNode[]): string[] {
	const out: string[] = [];
	const walk = (list: readonly GitTreeNode[]) => {
		for (const node of list) {
			if (node.kind === "folder") {
				out.push(node.key);
				walk(node.children);
			}
		}
	};
	walk(nodes);
	return out;
}

export type CommitSubjectMetrics = {
	length: number;
	level: "ok" | "warn" | "over";
	/** Remaining characters before the 50-char recommended subject limit (negative when past 50). */
	remaining50: number;
};

/** Measures the commit subject (first line) against VS Code's 50/72-character guidelines. */
export function commitSubjectMetrics(message: string): CommitSubjectMetrics {
	const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
	const length = firstLine.length;
	const level = length > 72 ? "over" : length > 50 ? "warn" : "ok";
	return { length, level, remaining50: 50 - length };
}

export type GitRefBadge = {
	label: string;
	kind: "head" | "branch" | "remote" | "tag";
};

const KNOWN_REMOTE_PREFIX = /^(?:origin|upstream)\//;

/** Parses `git log --format=%D` (short or full) ref decorations into structured badges for the Graph list. */
export function parseGitDecorations(raw: string): GitRefBadge[] {
	const clean = raw.trim();
	if (!clean) return [];
	const out: GitRefBadge[] = [];
	for (const part of clean.split(",")) {
		const token = part.trim();
		if (!token) continue;
		if (token.startsWith("HEAD -> ")) {
			const target = token.slice("HEAD -> ".length).trim().replace(/^refs\/heads\//, "");
			out.push({ label: target, kind: "head" });
		} else if (token === "HEAD") {
			out.push({ label: "HEAD", kind: "head" });
		} else if (token.startsWith("tag: ")) {
			const tag = token.slice("tag: ".length).trim().replace(/^refs\/tags\//, "");
			out.push({ label: tag, kind: "tag" });
		} else if (token.includes(" -> ")) {
			// Skip redundant symbolic pointers like `origin/HEAD -> origin/main`.
			continue;
		} else if (token.startsWith("refs/remotes/")) {
			out.push({ label: token.slice("refs/remotes/".length), kind: "remote" });
		} else if (token.startsWith("refs/heads/")) {
			out.push({ label: token.slice("refs/heads/".length), kind: "branch" });
		} else if (KNOWN_REMOTE_PREFIX.test(token)) {
			out.push({ label: token, kind: "remote" });
		} else {
			out.push({ label: token, kind: "branch" });
		}
	}
	return out;
}

/** Formats a commit timestamp into a compact VS Code Graph relative age (`just now`, `5m`, `2h`, `3d`, `Nov 12`). */
export function formatRelativeCommitTime(ms: number, now = Date.now()): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	const diffSec = Math.max(0, Math.floor((now - ms) / 1000));
	if (diffSec < 60) return "now";
	const mins = Math.floor(diffSec / 60);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	const days = Math.floor(hrs / 24);
	if (days < 7) return `${days}d`;
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	return sameYear
		? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
		: d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
