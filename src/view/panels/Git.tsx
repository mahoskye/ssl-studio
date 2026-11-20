// Source control: what has changed since the last commit, what of it is
// staged for the next one, and the commit itself. A row shows its change
// beside what git has of the file; its menu stages it, takes it out again,
// or lets its changes go (after asking). Everything stays on this machine:
// there is no fetch, pull or push here.
import { Icon } from "../Icon";
import { createSignal, For, Show } from "solid-js";
import { changeLetter, changeWord, commitProblem, GIT_ACTIONS, rowActions, stagedOf, unstagedOf, type GitFile } from "../../shared/gitStatus";
import { baseName, dirName, relativeTo } from "../../shared/paths";
import { FileMark } from "../FileMark";
import { branchText, commit, discard, gitFailure, gitStatus, refreshGit, showChange, stage, unstage } from "../git";
import { notify, openFile, state } from "../state";
import { chooseFromMenu } from "./RowMenu";
import { IconButton, Row, RowGroup, Rows, type Point } from "./Rows";

const { show: SHOW, open: OPEN, stage: STAGE, unstage: UNSTAGE, discard: DISCARD, trash: TRASH } = GIT_ACTIONS;

/** What the next commit is to say. Kept while the panel is away: a message half written is not lost to a look at another panel. */
const [message, setMessage] = createSignal("");
const [busy, setBusy] = createSignal(false);

/** As many files as a list shows: a folder of thousands that git was never told to ignore must not become thousands of rows. */
const ROWS_SHOWN = 500;
const More = (props: { count: number }) => (
	<Show when={props.count > 0}>
		<p class="hint">
			And {props.count} more, not listed. "Stage all" and "Unstage all" act on every one of them.
		</p>
	</Show>
);

export function GitPanel() {
	const staged = () => (gitStatus() ? stagedOf(gitStatus()!) : []);
	const changes = () => (gitStatus() ? unstagedOf(gitStatus()!) : []);
	/** Files staged above the workspace's folder: not listed, and in the commit all the same. */
	const above = () => gitStatus()?.stagedOutside ?? 0;
	const problem = () => (busy() ? "The commit is being made" : commitProblem(gitStatus() ?? null, message()));
	const folder = (path: string) => {
		const dir = relativeTo(state.workspace?.root, dirName(path));
		return dir === dirName(path) || !dir ? "" : dir;
	};
	const act = async (action: string | null, file: GitFile) => {
		if (action === OPEN) await openFile(file.path, { keep: true });
		else if (action === SHOW) await showChange(file, false);
		else if (action === STAGE) await stage([file]);
		else if (action === UNSTAGE) await unstage([file]);
		else if (action === DISCARD || action === TRASH) await discard(file);
	};
	const menu = async (file: GitFile, isStaged: boolean, at: Point) => {
		const action = await chooseFromMenu(`Actions for ${baseName(file.path)}`, rowActions(file, isStaged), at);
		if (action === SHOW) await showChange(file, isStaged);
		else await act(action, file);
	};
	const make = async () => {
		if (problem()) return notify(`${problem()}.`);
		setBusy(true);
		const made = await commit(message().trim());
		setBusy(false);
		if (made) setMessage("");
	};
	const FileRow = (props: { file: GitFile; staged: boolean }) => {
		const kind = () => (props.staged ? props.file.staged : props.file.unstaged)!;
		const name = () => baseName(props.file.path);
		return (
			<Row
				class="tree-row git-row"
				key={`${props.staged ? "staged" : "changed"}:${props.file.path}`}
				label={name()}
				title={`${relativeTo(state.workspace?.root, props.file.path)}: ${changeWord(kind())}${props.file.from ? `, was ${relativeTo(state.workspace?.root, props.file.from)}` : ""}. Enter shows the change; the menu key has more.`}
				onActivate={() => void showChange(props.file, props.staged)}
				onMenu={(at) => void menu(props.file, props.staged, at)}
			>
				<FileMark name={name()} />
				<span class="label" classList={{ gone: kind() === "deleted" }}>
					{name()}
					<Show when={folder(props.file.path)}>
						<span class="git-folder">{folder(props.file.path)}</span>
					</Show>
				</span>
				{/* The same steps as the row's menu, for the pointer: out of the keyboard's way, which has the menu key. */}
				<span class="git-acts" onClick={(e) => e.stopPropagation()}>
					<Show when={!props.staged && kind() !== "conflict"}>
						<button type="button" tabindex={-1} title={kind() === "untracked" ? "Move to trash…" : "Discard changes…"} aria-label={`${kind() === "untracked" ? "Move to trash" : "Discard the changes to"} ${name()}`} onClick={() => void discard(props.file)}>
							<Icon name="discard" />
						</button>
					</Show>
					<button type="button" tabindex={-1} title={props.staged ? "Unstage" : "Stage"} aria-label={`${props.staged ? "Unstage" : "Stage"} ${name()}`} onClick={() => void (props.staged ? unstage([props.file]) : stage([props.file]))}>
						<Icon name={props.staged ? "remove" : "add"} />
					</button>
				</span>
				<span class={`git-letter ${kind()}`} aria-label={changeWord(kind())}>
					{changeLetter(kind())}
				</span>
			</Row>
		);
	};
	return (
		<div class="panel-body" data-panel="git">
			<div class="panel-title">
				<span>Source control</span>
				<IconButton label="Ask git again" title="Refresh" icon="refresh" onClick={() => void refreshGit()} />
			</div>
			<Show when={gitFailure()}>
				<p class="hint warn" role="alert">
					git could not be asked: {gitFailure()}
				</p>
			</Show>
			<Show when={gitStatus() === undefined && !gitFailure()}>
				<p class="hint" role="status">
					Asking git…
				</p>
			</Show>
			{/* What changed after a step, for whoever cannot see the lists move. */}
			<p class="visually-hidden" role="status">
				{gitStatus() ? `${staged().length} staged, ${changes().length} not staged` : ""}
			</p>
			<Show when={gitStatus() === null}>
				<p class="hint">This folder is not in a git repository, or git is not installed. Once it is, what has changed since the last commit is listed here.</p>
			</Show>
			<Show when={gitStatus()}>
				<p class="hint git-branch" title={gitStatus()!.upstream ? `Follows ${gitStatus()!.upstream}. Nothing here fetches or pushes: that is done with git itself.` : "This branch follows no other. Nothing here fetches or pushes."}>
					On <strong>{branchText()}</strong>
					{gitStatus()!.initial ? ", with no commit yet" : ""}
				</p>
				<form class="git-commit" onSubmit={(e) => (e.preventDefault(), void make())}>
					<textarea
						aria-label="What the commit does"
						placeholder="What the commit does (Ctrl+Enter commits)"
						rows={3}
						value={message()}
						onInput={(e) => setMessage(e.currentTarget.value)}
						onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void make())}
					/>
					{/* Not the button's own "disabled": it keeps the keyboard, and says why it does nothing. */}
					<button type="submit" class="primary" aria-disabled={problem() ? "true" : undefined} title={problem() || `Commit the ${staged().length + above()} staged ${staged().length + above() === 1 ? "file" : "files"}`}>
						Commit
					</button>
				</form>
				<Show when={above()}>
					<p class="hint warn" role="status">
						{above()} more staged {above() === 1 ? "file is" : "files are"} above this folder in the repository, and not listed here. A commit takes {above() === 1 ? "it" : "them"} too.
					</p>
				</Show>
				<Show when={!gitStatus()!.files.length}>
					<p class="hint">Nothing has changed in this folder since the last commit.</p>
				</Show>
				<Show when={gitStatus()!.files.length}>
					<Rows label="Changed files">
						<Show when={staged().length}>
							<RowGroup
								headClass="group-head git-head"
								head={
									<>
										<span class="label">Staged for the commit</span>
										<span class="count">{staged().length}</span>
										<IconButton label="Unstage all" title="Take every file out of the commit" icon="remove" onClick={() => void unstage(staged())} />
									</>
								}
							>
								<For each={staged().slice(0, ROWS_SHOWN)}>{(file) => <FileRow file={file} staged={true} />}</For>
							</RowGroup>
							<More count={staged().length - ROWS_SHOWN} />
						</Show>
						<Show when={changes().length}>
							<RowGroup
								headClass="group-head git-head"
								head={
									<>
										<span class="label">Changes</span>
										<span class="count">{changes().length}</span>
										<IconButton label="Stage all" title="Put every change into the commit" icon="add" onClick={() => void stage(changes())} />
									</>
								}
							>
								<For each={changes().slice(0, ROWS_SHOWN)}>{(file) => <FileRow file={file} staged={false} />}</For>
							</RowGroup>
							<More count={changes().length - ROWS_SHOWN} />
						</Show>
					</Rows>
				</Show>
			</Show>
		</div>
	);
}
