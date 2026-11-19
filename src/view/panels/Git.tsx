// Source control: what has changed since the last commit, what of it is
// staged for the next one, and the commit itself. A row shows its change
// beside what git has of the file; its menu stages it, takes it out again,
// or lets its changes go (after asking). Everything stays on this machine:
// there is no fetch, pull or push here.
import { createSignal, For, Show } from "solid-js";
import { changeLetter, changeWord, commitProblem, GIT_ACTIONS, rowActions, stagedOf, unstagedOf, type GitFile } from "../../shared/gitStatus";
import { baseName, dirName, relativeTo } from "../../shared/paths";
import { FileMark } from "../FileMark";
import { branchText, commit, discard, gitFailure, gitStatus, refreshGit, showChange, stage, unstage } from "../git";
import { notify, openFile, state } from "../state";
import { chooseFromMenu } from "./RowMenu";
import { IconButton, Row, RowGroup, Rows, type Point } from "./Rows";

const { show: SHOW, open: OPEN, stage: STAGE, unstage: UNSTAGE, discard: DISCARD, trash: TRASH } = GIT_ACTIONS;

export function GitPanel() {
	const [message, setMessage] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const staged = () => (gitStatus() ? stagedOf(gitStatus()!) : []);
	const changes = () => (gitStatus() ? unstagedOf(gitStatus()!) : []);
	const problem = () => (busy() ? "The commit is being made" : commitProblem(gitStatus() ?? null, message()));
	const folder = (path: string) => {
		const dir = relativeTo(state.workspace?.root, dirName(path));
		return dir === dirName(path) || !dir ? "" : dir;
	};
	const act = async (action: string | null, file: GitFile) => {
		if (action === OPEN) await openFile(file.path);
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
				<IconButton label="Ask git again" title="Refresh" glyph="⟳" onClick={() => void refreshGit()} />
			</div>
			<Show when={gitFailure()}>
				<p class="hint warn" role="alert">
					git could not be asked: {gitFailure()}
				</p>
			</Show>
			<Show when={gitStatus() === undefined && !gitFailure()}>
				<p class="hint">Asking git…</p>
			</Show>
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
					<button type="submit" class="primary" aria-disabled={problem() ? "true" : undefined} title={problem() || `Commit the ${staged().length} staged ${staged().length === 1 ? "file" : "files"}`}>
						Commit
					</button>
				</form>
				<Show when={!gitStatus()!.files.length}>
					<p class="hint">Nothing has changed since the last commit.</p>
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
										<IconButton label="Unstage all" title="Take every file out of the commit" glyph="−" onClick={() => void unstage(staged())} />
									</>
								}
							>
								<For each={staged()}>{(file) => <FileRow file={file} staged={true} />}</For>
							</RowGroup>
						</Show>
						<Show when={changes().length}>
							<RowGroup
								headClass="group-head git-head"
								head={
									<>
										<span class="label">Changes</span>
										<span class="count">{changes().length}</span>
										<IconButton label="Stage all" title="Put every change into the commit" glyph="＋" onClick={() => void stage(changes())} />
									</>
								}
							>
								<For each={changes()}>{(file) => <FileRow file={file} staged={false} />}</For>
							</RowGroup>
						</Show>
					</Rows>
				</Show>
			</Show>
		</div>
	);
}
