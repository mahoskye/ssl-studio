// Source control: what git says has changed in the workspace, kept up to
// date, and the steps of making a commit. Everything is asked of the
// backend, which asks the user's own git (src/bun/git.ts); nothing here
// leaves this machine.
import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { branchLabel, changeWord, type GitFile, type GitStatus } from "../shared/gitStatus";
import { baseName, relativeTo } from "../shared/paths";
import { backend } from "./backend";
import { choose } from "./dialogs";
import { openReview } from "./editor/Review";
import { languageFor } from "./editor/languages";
import { canonical, documents, fileChangedOnDisk, fileRemoved, notify, setState, state } from "./state";

/** What git says: null outside a repository (or with no git), undefined before it was first asked. */
const [status, setStatus] = createSignal<GitStatus | null | undefined>(undefined);
/** Why git could not be asked, when it could not. */
const [failure, setFailure] = createSignal("");
/** Counts up whenever what git has of the files may have changed: the marks in the editors' margins are read again. */
const [gitVersion, setGitVersion] = createSignal(0);
export { failure as gitFailure, gitVersion, status as gitStatus };

let asking = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Asks git again, now. Answers that come back out of order are dropped. */
export async function refreshGit(): Promise<void> {
	clearTimeout(timer);
	const mine = ++asking;
	if (!state.workspace) return void setStatus(undefined);
	try {
		const next = await backend.gitStatus();
		if (mine !== asking) return;
		setFailure("");
		setStatus(next);
	} catch (e: any) {
		if (mine !== asking) return;
		setFailure(String(e?.message ?? e));
	}
	setGitVersion((v) => v + 1);
}

/** Asks git again soon: a run of saves or file changes is one question. */
export function refreshGitSoon() {
	clearTimeout(timer);
	timer = setTimeout(() => void refreshGit(), 400);
}

/** Keeps the status in step with the workspace: when a folder opens, when files change, and when the window is come back to. Called once, from the window. */
export function useGit() {
	createEffect(on(() => state.workspace?.root, () => void refreshGit()));
	// A save, a new file, a rename, a change on disk: each moves the tree's version.
	createEffect(on(() => state.treeVersion, refreshGitSoon, { defer: true }));
	// A commit made in a terminal is not heard of: coming back to the window asks again.
	const focused = () => state.workspace && refreshGitSoon();
	window.addEventListener("focus", focused);
	onCleanup(() => window.removeEventListener("focus", focused));
}

export const branchText = () => (status() ? branchLabel(status()!) : "");
export const changedCount = () => status()?.files.length ?? 0;

const failed = (what: string) => (e: any) => notify(`${what}: ${String(e?.message ?? e)}`, "error");

export const stage = (files: GitFile[]) => backend.gitStage(files.map((file) => file.path)).then(refreshGit, failed("Not staged"));
export const unstage = (files: GitFile[]) => backend.gitUnstage(files.map((file) => file.path)).then(refreshGit, failed("Not unstaged"));

/** Commits what is staged. True when it was made. */
export async function commit(message: string): Promise<boolean> {
	try {
		const said = await backend.gitCommit(message);
		notify(`Committed: ${said}`);
		await refreshGit();
		return true;
	} catch (e: any) {
		// git's own words: a check its repository runs may have refused the commit, and says why.
		notify(`Not committed. git said: ${String(e?.message ?? e)}`, "error");
		await refreshGit();
		return false;
	}
}

/** Lets a file's unstaged changes go, after asking. An open copy of it follows what is then on disk. */
export async function discard(file: GitFile): Promise<void> {
	const name = baseName(file.path);
	const untracked = file.unstaged === "untracked";
	const open = documents.get(canonical(file.path));
	const unsaved = Boolean(open && state.dirty[canonical(file.path)]);
	const DISCARD = untracked ? "Move to trash" : "Discard changes";
	const what = untracked
		? `${name} is new, and git has nothing of it to go back to. Move it to the trash?`
		: `Discard the changes to ${name} that are not staged? The file goes back to what git has of it${unsaved ? ", and the unsaved changes in the editor go with them" : ""}. The file as it is now is kept in its local history.`;
	if ((await choose(what, [DISCARD], { danger: DISCARD })) !== DISCARD) return;
	try {
		await backend.gitDiscard(file.path);
	} catch (e) {
		return failed("Not discarded")(e);
	}
	if (untracked) fileRemoved(file.path);
	else if (open) {
		// The editor's copy goes back with the file, unsaved changes included: that is what was asked.
		setState("dirty", canonical(file.path), false);
		await fileChangedOnDisk(file.path);
	}
	setState("treeVersion", (v) => v + 1);
	await refreshGit();
}

/** Shows a change: the file as git has it beside the file as it is. `staged` is the change that is staged for the next commit. */
export async function showChange(file: GitFile, staged: boolean): Promise<void> {
	const root = state.workspace?.root;
	const name = relativeTo(root, file.path);
	const kind = staged ? file.staged : file.unstaged;
	try {
		// Staged: the last commit against what is staged. Not staged: what is staged against the folder.
		const before = kind === "untracked" || kind === "added" ? "" : ((await backend.gitBase(file.from && staged ? file.from : file.path, staged ? "head" : "index")) ?? "");
		let after = "";
		if (staged) after = file.staged === "deleted" ? "" : ((await backend.gitBase(file.path, "index")) ?? "");
		else if (file.unstaged !== "deleted") {
			const open = documents.get(canonical(file.path));
			const read = open ? null : await backend.read(file.path);
			if (read?.binary) return notify(`${baseName(file.path)} is not text: there is nothing of it to compare.`);
			after = open ? open.model.getValue() : read!.text;
		}
		await openReview({
			title: `${baseName(file.path)}: ${kind ? changeWord(kind) : "changed"}${staged ? ", staged" : ""}`,
			path: file.path,
			original: before,
			proposed: after,
			language: languageFor(file.path),
			compare: staged ? { left: "The last commit", right: "Staged for the next commit" } : { left: file.staged ? "As it is staged" : "The last commit", right: "As it is now" },
			effect: `${name} against what git has of it. Nothing here changes either: edit the file in its own tab.`,
			onAccept: () => {},
		});
	} catch (e) {
		failed(`${baseName(file.path)} could not be compared`)(e);
	}
}
