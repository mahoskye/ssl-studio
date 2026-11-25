// Source control: what git says has changed in the workspace, kept up to
// date, and the steps of making a commit. Everything is asked of the
// backend, which asks the user's own git (src/bun/git.ts); nothing here
// leaves this machine.
import { createEffect, createMemo, createSignal, onSettled, snapshot } from "solid-js";
import { branchLabel, changeWord, type GitFile, type GitStatus } from "../shared/gitStatus";
import { baseName, isInside, relativeTo } from "../shared/paths";
import { backend } from "./backend";
import { choose } from "./dialogs";
import { openReview } from "./editor/Review";
import { languageFor } from "./editor/languages";
import { canonical, changingOnDisk, documents, fileChangedOnDisk, fileRemoved, historyChanged, notify, revert, setState, state } from "./state";

/** What git says: null outside a repository (or with no git), undefined before it was first asked. */
const [status, setStatus] = createSignal<GitStatus | null | undefined>(undefined);
/** Why git could not be asked, when it could not. */
const [failure, setFailure] = createSignal("");
/** Counts up whenever what git has of the files may have changed: the marks in the editors' margins are read again. */
const [gitVersion, setGitVersion] = createSignal(0);
export { failure as gitFailure, gitVersion, status as gitStatus };

let asking = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let statusRoot: string | undefined;
/** `state.treeVersion` value bumped by `discard()` right before its direct `refreshGit()` call, so the deferred effect does not trigger a duplicate status poll. */
let suppressedTreeVersion = -1;

/** Asks git again, now. Answers that come back out of order are dropped. */
export async function refreshGit(): Promise<void> {
	clearTimeout(timer);
	const mine = ++asking;
	const root = snapshot(state).workspace?.root;
	if (!root) {
		statusRoot = undefined;
		setFailure("");
		setStatus(undefined);
		return;
	}
	if (statusRoot !== root) {
		setStatus(undefined);
		setFailure("");
	}
	try {
		const next = await backend.gitStatus();
		if (mine !== asking || snapshot(state).workspace?.root !== root) return;
		statusRoot = root;
		setFailure("");
		setStatus(next);
	} catch (e: any) {
		if (mine !== asking || snapshot(state).workspace?.root !== root) return;
		if (statusRoot !== root) setStatus(undefined);
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
	const root = createMemo(() => state.workspace?.root);
	createEffect(root, () => {
		statusRoot = undefined;
		setStatus(undefined);
		setFailure("");
		void refreshGit();
	});
	// A save, a new file, a rename, a change on disk: each moves the tree's version.
	createEffect(
		() => state.treeVersion,
		(version) => {
			if (version === suppressedTreeVersion) {
				suppressedTreeVersion = -1;
				return;
			}
			refreshGitSoon();
		},
		{ defer: true },
	);
	// A commit made in a terminal is not heard of: coming back to the window asks again.
	onSettled(() => {
		const focused = () => snapshot(state).workspace && refreshGitSoon();
		window.addEventListener("focus", focused);
		return () => {
			suppressedTreeVersion = -1;
			clearTimeout(timer);
			window.removeEventListener("focus", focused);
		};
	});
}

export const branchText = () => (status() ? branchLabel(status()!) : "");
export const changedCount = () => status()?.files.length ?? 0;

const failed = (what: string) => (e: any) => notify(`${what}: ${String(e?.message ?? e)}`, "error");

export async function stage(files: GitFile[]): Promise<void> {
	if (!files.length) return;
	await backend.gitStage(files.map((file) => file.path)).then(
		async () => {
			await refreshGit();
			// git stages what is on disk: edits that are only in the editor are not in it, and that is said.
			const unsaved = files.filter((file) => state.dirty[canonical(file.path)]);
			if (unsaved.length) notify(`${unsaved.length === 1 ? `${baseName(unsaved[0]!.path)} has` : `${unsaved.length} of these files have`} unsaved changes: what is staged is what is saved.`);
		},
		failed("Not staged"),
	);
}

/** Paths to pass to `gitUnstage`, including rename origins (`file.from`) so staged renames unstage cleanly. */
export function unstagePaths(files: readonly GitFile[], root?: string | null): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const add = (p: string) => {
		if (!p || seen.has(p)) return;
		seen.add(p);
		paths.push(p);
	};
	for (const file of files) {
		add(file.path);
		if (file.from && (!root || isInside(root, file.from))) add(file.from);
	}
	return paths;
}

export async function unstage(files: GitFile[]): Promise<void> {
	const paths = unstagePaths(files, state.workspace?.root);
	if (!paths.length) return;
	await backend.gitUnstage(paths).then(refreshGit, failed("Not unstaged"));
}

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
	const root = state.workspace?.root;
	const canon = canonical(file.path);
	const name = baseName(file.path);
	const untracked = file.unstaged === "untracked";
	const open = documents.get(canon);
	const unsaved = Boolean(open && state.dirty[canon]);
	const DISCARD = untracked ? "Move to trash" : "Discard changes";
	const what = untracked
		? `${name} is new, and git has nothing of it to go back to. Move it to the trash?`
		: `Discard the changes to ${name} that are not staged? The file goes back to what git has of it${unsaved ? ", and the unsaved changes in the editor go with them" : ""}. Where it is text, the file as it is now on disk is kept in its local history.`;
	if ((await choose(what, [DISCARD], { danger: DISCARD })) !== DISCARD) return;
	if (state.workspace?.root !== root) return;
	try {
		// The file changes under the editor's copy on purpose: no "changed on disk" is raised while it does.
		await changingOnDisk(file.path, () => backend.gitDiscard(file.path));
	} catch (e) {
		return failed("Not discarded")(e);
	}
	if (state.workspace?.root !== root) return;
	const onDisk = await backend.sizes([file.path]).then(
		(sizes) => (sizes ? file.path in sizes : !untracked),
		() => !untracked,
	);
	if (state.workspace?.root !== root) return;
	if (!onDisk) {
		fileRemoved(file.path);
	} else if (documents.get(canon)) {
		// Reload cleanly from disk (unsaved changes included) without closing the open tab.
		await revert(canon);
	} else {
		await fileChangedOnDisk(file.path);
	}
	historyChanged.fire(canon);
	setState((s) => {
		s.treeVersion += 1;
		suppressedTreeVersion = s.treeVersion;
	});
	await refreshGit();
}

let showingChange = 0;

/** Shows a change: the file as git has it beside the file as it is. `staged` is the change that is staged for the next commit. */
export async function showChange(file: GitFile, staged: boolean): Promise<void> {
	const root = state.workspace?.root;
	const req = ++showingChange;
	const stale = () => req !== showingChange || state.workspace?.root !== root;
	const name = relativeTo(root, file.path);
	const kind = staged ? file.staged : file.unstaged;
	try {
		// A file in conflict has three texts in git, not one: which to show beside it is settled with git's own tools.
		if (kind === "conflict") return notify(`${baseName(file.path)} is in conflict: there is no one earlier text to show beside it. Open the file to see git's marks in it.`);
		// Staged: the last commit against what is staged. Not staged: what is staged against the folder.
		const was = kind === "untracked" || kind === "added" ? "" : await backend.gitBase(file.from && staged ? file.from : file.path, staged ? "head" : "index");
		if (stale()) return;
		const staging = staged && file.staged !== "deleted" ? await backend.gitBase(file.path, "index") : "";
		if (stale()) return;
		// git has it, and not as text: bytes are not shown side by side.
		if (was === null || staging === null) return notify(`${baseName(file.path)} is not text in git: there is nothing of it to compare.`);
		const before = was;
		let after = "";
		if (staged) after = staging;
		else if (file.unstaged !== "deleted") {
			const open = documents.get(canonical(file.path));
			if (open?.binary) return notify(`${baseName(file.path)} is not text: there is nothing of it to compare.`);
			const usableOpen = open && !open.model.isDisposed() ? open : null;
			const read = usableOpen ? null : await backend.read(file.path);
			if (stale()) return;
			if (read?.binary) return notify(`${baseName(file.path)} is not text: there is nothing of it to compare.`);
			after = usableOpen ? usableOpen.model.getValue() : read!.text;
		}
		if (stale()) return;
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
		if (stale()) return;
		failed(`${baseName(file.path)} could not be compared`)(e);
	}
}
