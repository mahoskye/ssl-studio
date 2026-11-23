// What git says has changed, read from its own machine-readable answer
// (`git status --porcelain=v2 --branch -z`): the branch, and each file that
// differs, with what is staged for the next commit and what is not. No
// process and no file system: git's text in, a list out.
import type { RowMenuEntry } from "./contextMenu";

/** How a file differs. "conflict" is a merge git could not finish for it. */
export type Change = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflict";

export type GitFile = {
	/** From the repository's top folder, with forward slashes, as git names it. */
	path: string;
	/** What of it is staged: in the next commit as things stand. */
	staged: Change | null;
	/** What of it is not staged: in the folder, and not yet in the next commit. */
	unstaged: Change | null;
	/** The name it had, for a file that was renamed. */
	from?: string;
};

export type GitStatus = {
	/** The branch's name; for a commit checked out by itself, the start of its id. */
	branch: string;
	/** A commit is checked out by itself, not a branch. */
	detached: boolean;
	/** The repository has no commit yet. */
	initial: boolean;
	/** The branch this one follows, when it follows one. */
	upstream?: string;
	/** Commits here that the followed branch does not have, and the other way round. */
	ahead: number;
	behind: number;
	files: GitFile[];
	/** Files staged above the workspace's folder, which are not listed here: a commit takes them too. */
	stagedOutside?: number;
};

const LETTERS: Record<string, Change> = { M: "modified", T: "modified", A: "added", D: "deleted", R: "renamed", C: "added", U: "conflict" };
const change = (letter: string): Change | null => LETTERS[letter] ?? null;

/** git's answer as a status. Lines it does not know are passed over: a newer git may say more. */
export function parseStatus(text: string): GitStatus {
	const status: GitStatus = { branch: "", detached: false, initial: false, ahead: 0, behind: 0, files: [] };
	let oid = "";
	const entries = text.split("\0");
	for (let at = 0; at < entries.length; at++) {
		const entry = entries[at]!;
		if (entry.startsWith("# branch.oid ")) {
			oid = entry.slice(13);
			status.initial = oid === "(initial)";
		} else if (entry.startsWith("# branch.head ")) {
			status.branch = entry.slice(14);
			status.detached = status.branch === "(detached)";
		} else if (entry.startsWith("# branch.upstream ")) status.upstream = entry.slice(18);
		else if (entry.startsWith("# branch.ab ")) {
			const found = /\+(\d+) -(\d+)/.exec(entry);
			status.ahead = Number(found?.[1] ?? 0);
			status.behind = Number(found?.[2] ?? 0);
		} else if (entry.startsWith("1 ")) {
			// 1 XY sub mH mI mW hH hI path: the path is the rest, spaces and all.
			const parts = entry.split(" ");
			status.files.push({ path: parts.slice(8).join(" "), staged: change(parts[1]![0]!), unstaged: change(parts[1]![1]!) });
		} else if (entry.startsWith("2 ")) {
			// 2 XY sub mH mI mW hH hI Xscore path, and the name it had as the entry after.
			const parts = entry.split(" ");
			status.files.push({ path: parts.slice(9).join(" "), staged: change(parts[1]![0]!), unstaged: change(parts[1]![1]!), from: entries[++at] });
		} else if (entry.startsWith("u ")) {
			const parts = entry.split(" ");
			status.files.push({ path: parts.slice(10).join(" "), staged: null, unstaged: "conflict" });
		} else if (entry.startsWith("? ")) status.files.push({ path: entry.slice(2), staged: null, unstaged: "untracked" });
	}
	if (status.detached) status.branch = oid.slice(0, 7);
	return status;
}

/** The files with something staged, and those with something not staged. A file may be in both. */
export const stagedOf = (status: GitStatus) => status.files.filter((file) => file.staged);
export const unstagedOf = (status: GitStatus) => status.files.filter((file) => file.unstaged);

/** One letter for a change, as git and every editor write it. */
export const changeLetter = (kind: Change) => ({ added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U", conflict: "!" })[kind];
/** The change in a word, for a tooltip and for what reads the screen aloud. */
export const changeWord = (kind: Change) => ({ added: "new", modified: "changed", deleted: "removed", renamed: "renamed", untracked: "new, not yet followed by git", conflict: "in conflict" })[kind];

/** The branch as the status bar says it: its name, and how far it is from the branch it follows. */
export function branchLabel(status: GitStatus): string {
	const far = [status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" ");
	return `${status.branch || "no branch"}${far ? ` ${far}` : ""}`;
}

/** Why a commit cannot be made now; "" when it can. */
export function commitProblem(status: GitStatus | null, message: string): string {
	if (!status) return "This folder is not in a git repository";
	if (status.files.some((file) => file.unstaged === "conflict")) return "A file is in conflict: settle it first";
	if (!stagedOf(status).length && !status.stagedOutside) return "Nothing is staged: stage the changes to commit";
	if (!message.trim()) return "Say what the commit does first";
	return "";
}

/** What can be done to a changed file from its row, by name. */
export const GIT_ACTIONS = {
	show: "Show the change",
	open: "Open the file",
	stage: "Stage",
	unstage: "Unstage",
	discard: "Discard changes…",
	trash: "Move to trash…",
	copyPath: "Copy path",
	copyRelative: "Copy path in the project",
	copyName: "Copy name",
	showInExplorer: "Show in the Explorer",
} as const;

/**
 * What a row's menu offers. A removed file has nothing to open. Only what is not staged can be let go, and a
 * file in conflict is not let go from here; a file git does not follow has nothing to go back to, so it goes to
 * the trash.
 */
export function rowActions(file: GitFile, staged: boolean): string[] {
	const kind = staged ? file.staged : file.unstaged;
	const letGo = staged || kind === "conflict" ? [] : [kind === "untracked" ? GIT_ACTIONS.trash : GIT_ACTIONS.discard];
	return [GIT_ACTIONS.show, ...(kind === "deleted" ? [] : [GIT_ACTIONS.open]), staged ? GIT_ACTIONS.unstage : GIT_ACTIONS.stage, ...letGo];
}

/** Sectioned context-menu entries for a Git row: inspect, index, path/reveal, and isolated destructive discard. */
export function rowMenuEntries(file: GitFile, staged: boolean, inWorkspace = true): RowMenuEntry[] {
	const kind = staged ? file.staged : file.unstaged;
	const deleted = kind === "deleted";
	const letGo = staged || kind === "conflict" ? null : kind === "untracked" ? GIT_ACTIONS.trash : GIT_ACTIONS.discard;
	return [
		GIT_ACTIONS.show,
		...(deleted ? [] : [GIT_ACTIONS.open]),
		"separator",
		staged ? GIT_ACTIONS.unstage : GIT_ACTIONS.stage,
		"separator",
		{
			label: "Copy path",
			children: [
				GIT_ACTIONS.copyPath,
				...(inWorkspace ? [GIT_ACTIONS.copyRelative] : []),
				GIT_ACTIONS.copyName,
			],
		},
		...(deleted || !inWorkspace ? [] : [GIT_ACTIONS.showInExplorer]),
		...(letGo ? (["separator", { label: letGo, value: letGo, danger: true }] as RowMenuEntry[]) : []),
	];
}
