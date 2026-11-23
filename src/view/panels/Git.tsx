// Source control: what has changed since the last commit, what of it is
// staged for the next one, and the commit itself. A row shows its change
// beside what git has of the file; its menu stages it, takes it out again,
// or lets its changes go (after asking). Everything stays on this machine:
// there is no fetch, pull or push here.
import { Icon } from "../Icon";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { changeLetter, changeWord, commitProblem, GIT_ACTIONS, rowActions, stagedOf, unstagedOf, type GitFile } from "../../shared/gitStatus";
import { baseName, dirName, isInside, relativeTo, resolvePath } from "../../shared/paths";
import type { DocFile } from "../../shared/protocol";
import { docsGoverningFile, ticketsForFile } from "../../shared/workContext";
import { backend } from "../backend";
import { docAuditData } from "../docAudit";
import { FileMark } from "../FileMark";
import { branchText, commit, discard, gitFailure, gitStatus, gitVersion, refreshGit, showChange, stage, unstage } from "../git";
import { docs } from "../project";
import { staleCatalogSummary, ticketAtHand, updateCatalogs } from "../projectDocs";
import { activePath, canonical, notify, openFile, state } from "../state";
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

const CODE_OR_SQL_RE = /\.(ssl|srvscr|ds|sql|ddl|pks|pkb|xfd|xml|js|ts|html|css)$/i;

function formatCommitDate(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function GitPanel() {
	const staged = () => (gitStatus() ? stagedOf(gitStatus()!) : []);
	const changes = () => (gitStatus() ? unstagedOf(gitStatus()!) : []);
	/** Files staged above the workspace's folder: not listed, and in the commit all the same. */
	const above = () => gitStatus()?.stagedOutside ?? 0;
	const [driftOpen, setDriftOpen] = createSignal(false);
	const [commitsOpen, setCommitsOpen] = createSignal(false);
	const activeTicketKey = () => state.settings.activeTicket?.trim() || "";

	// Non-blocking doc-drift advisory for staged code/SQL files: untouched governing docs,
	// drifted #L code citations pointing into staged files, and out-of-sync INDEX.md catalogs.
	const docDrift = createMemo(() => {
		const root = state.workspace?.root;
		const stFiles = staged();
		if (!root || !stFiles.length) {
			return { governing: [] as { file: DocFile; reason: string; unstaged?: GitFile }[], citations: [] as NonNullable<ReturnType<typeof docAuditData>["citationIssues"]>, staleCatalogCount: 0, total: 0 };
		}
		const allDocs = docs();
		const stagedSet = new Set(stFiles.map((f) => canonical(f.path)));
		const unstagedByPath = new Map(changes().map((f) => [canonical(f.path), f]));
		const stagedCode = stFiles.filter((f) => CODE_OR_SQL_RE.test(f.path));

		const govMap = new Map<string, { file: DocFile; reason: string; unstaged?: GitFile }>();
		for (const cf of stagedCode) {
			for (const g of docsGoverningFile(allDocs, cf.path, root)) {
				const k = canonical(g.file.path);
				if (stagedSet.has(k) || govMap.has(k)) continue;
				govMap.set(k, { file: g.file, reason: g.reason, unstaged: unstagedByPath.get(k) });
			}
		}
		const citations = (docAuditData().citationIssues ?? []).filter((ci) => stagedSet.has(canonical(ci.targetPath)));
		const catSummary = staleCatalogSummary();
		const staleCatalogCount = catSummary.stale.length + catSummary.missing.length;
		const governing = [...govMap.values()];
		const total = governing.length + citations.length + (staleCatalogCount > 0 ? 1 : 0);
		return { governing, citations, staleCatalogCount, total };
	});

	const [ticketCommits] = createResource(
		() => {
			const root = state.workspace?.root;
			const key = activeTicketKey();
			const hasRepo = Boolean(gitStatus());
			return root && key && hasRepo ? { key, v: gitVersion() } : null;
		},
		async ({ key }) => backend.gitTicketLog(key, 15).catch(() => []),
	);
	const problem = () => (busy() ? "The commit is being made" : commitProblem(gitStatus() ?? null, message()));
	const folder = (path: string) => {
		const dir = relativeTo(state.workspace?.root, dirName(path));
		return dir === dirName(path) || !dir ? "" : dir;
	};
	/** Candidate ticket prefixes inferred from staged files first, then active focus / changed files, then active file. */
	const suggestedTickets = createMemo(() => {
		const allDocs = docs();
		const root = state.workspace?.root;
		const keys: string[] = [];
		const add = (k: string) => {
			if (k && !keys.some((x) => x.toLowerCase() === k.toLowerCase())) keys.push(k);
		};
		for (const f of staged()) {
			for (const k of ticketsForFile(allDocs, f.path, root)) add(k);
		}
		if (state.settings.activeTicket?.trim()) add(state.settings.activeTicket.trim());
		if (!keys.length) {
			for (const f of changes()) {
				for (const k of ticketsForFile(allDocs, f.path, root)) add(k);
			}
		}
		if (!keys.length) {
			for (const k of ticketsForFile(allDocs, activePath(), root)) add(k);
			if (!keys.length) add(ticketAtHand());
		}
		return keys.slice(0, 4);
	});
	const messageMentionsKey = (key: string) => {
		const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(?<![A-Za-z0-9_-])${esc}(?![A-Za-z0-9_-])`, "i").test(message());
	};
	const prependTicketKey = (key: string) => {
		setMessage((cur) => {
			const trimmed = cur.trimStart();
			// Combine cleanly if message already opens with `<KEY[, KEY2]>: ...`
			const m = /^([A-Za-z][A-Za-z0-9_-]*-\d+(?:\s*,\s*[A-Za-z][A-Za-z0-9_-]*-\d+)*):(\s*.*)$/s.exec(trimmed);
			if (m) return `${m[1]}, ${key}:${m[2]}`;
			return `${key}: ${trimmed}`;
		});
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
				<Show when={docDrift().total > 0}>
					<div class="git-drift" role="region" aria-label="Documentation drift advisory">
						<button
							type="button"
							class="git-drift-toggle"
							aria-expanded={driftOpen()}
							title="Non-blocking reminder: governing docs, code citations, or folder indexes affected by your staged files"
							onClick={() => setDriftOpen((v) => !v)}
						>
							<Icon name={driftOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
							<Icon name="note" class="git-drift-icon" />
							<span class="git-drift-title">
								Doc drift · {docDrift().total} {docDrift().total === 1 ? "note" : "notes"}
							</span>
						</button>
						<Show when={driftOpen()}>
							<div class="git-drift-body">
								<Show when={docDrift().governing.length > 0}>
									<p class="git-drift-sub">Untouched governing docs</p>
									<ul class="git-drift-list">
										<For each={docDrift().governing.slice(0, 8)}>
											{(item) => (
												<li>
													<span class="git-drift-label" title={`${relativeTo(state.workspace?.root, item.file.path)} (${item.reason})`}>
														{item.file.ticket ? `${item.file.ticket}: ` : ""}
														{item.file.title || item.file.name}
														<span class="meta"> · {item.reason}</span>
													</span>
													<span class="git-drift-acts">
														<button type="button" class="link" onClick={() => void openFile(item.file.path, { keep: true })}>
															Open
														</button>
														<Show when={item.unstaged}>
															{(gf) => (
																<button type="button" class="link" title="Stage this modified doc for the commit" onClick={() => void stage([gf()])}>
																	Stage
																</button>
															)}
														</Show>
													</span>
												</li>
											)}
										</For>
									</ul>
								</Show>
								<Show when={docDrift().citations.length > 0}>
									<p class="git-drift-sub">Drifted #L citations into staged files</p>
									<ul class="git-drift-list">
										<For each={docDrift().citations.slice(0, 6)}>
											{(ci) => (
												<li>
													<span class="git-drift-label" title={ci.text}>
														{baseName(ci.docPath)}:{ci.docLine} <span class="meta">({ci.kind})</span>
													</span>
													<span class="git-drift-acts">
														<button type="button" class="link" onClick={() => void openFile(ci.docPath, { reveal: { line: ci.docLine }, keep: true })}>
															Open
														</button>
													</span>
												</li>
											)}
										</For>
									</ul>
								</Show>
								<Show when={docDrift().staleCatalogCount > 0}>
									<div class="git-drift-catalog">
										<span>
											{docDrift().staleCatalogCount === 1
												? "1 INDEX.md catalog out of sync"
												: `${docDrift().staleCatalogCount} INDEX.md catalogs out of sync`}
										</span>
										<button
											type="button"
											class="link"
											title="Manually reconcile out-of-date INDEX.md catalogs (ADR 0031)"
											onClick={() => void updateCatalogs()}
										>
											Update catalogs
										</button>
									</div>
								</Show>
							</div>
						</Show>
					</div>
				</Show>
				<form class="git-commit" onSubmit={(e) => (e.preventDefault(), void make())}>
					<Show when={suggestedTickets().length > 0}>
						<div class="git-ticket-chips">
							<For each={suggestedTickets()}>
								{(key) => (
									<Show when={!messageMentionsKey(key)}>
										<button
											type="button"
											class="git-ticket-chip"
											title={`Add ${key} to commit message prefix`}
											onClick={() => prependTicketKey(key)}
										>
											+ {key}:
										</button>
									</Show>
								)}
							</For>
						</div>
					</Show>
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
				<Show when={activeTicketKey()}>
					{(key) => (
						<section class="git-ticket-log" aria-label={`Commits mentioning ${key()}`}>
							<button
								type="button"
								class="group-head git-head foldable git-ticket-log-head"
								aria-expanded={commitsOpen()}
								onClick={() => setCommitsOpen((v) => !v)}
							>
								<Icon name={commitsOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
								<span class="label">Ticket commits · {key()}</span>
								<span class="count">{ticketCommits.loading ? "…" : (ticketCommits()?.length ?? 0)}</span>
							</button>
							<Show when={commitsOpen()}>
								<div class="git-ticket-log-body">
									<Show
										when={!ticketCommits.loading && (ticketCommits()?.length ?? 0) > 0}
										fallback={
											<p class="hint">
												{ticketCommits.loading ? "Loading local commits…" : `No local commits mentioning ${key()} yet.`}
											</p>
										}
									>
										<ul class="git-commit-list">
											<For each={ticketCommits()}>
												{(c) => (
													<li class="git-commit-item">
														<div class="git-commit-line" title={`${c.sha}\n${c.author} · ${new Date(c.time).toLocaleString()}\n${c.subject}`}>
															<code class="git-commit-sha">{c.shortSha}</code>
															<span class="git-commit-subj">{c.subject}</span>
															<span class="meta git-commit-date">{formatCommitDate(c.time)}</span>
														</div>
														<Show when={c.files.length > 0}>
															<ul class="git-commit-files">
																<For each={c.files.slice(0, 8)}>
																	{(f) => {
																		const openCommitFile = () => {
																			const root = state.workspace?.root;
																			if (!root) return;
																			const full = resolvePath(root, f.path);
																			if (isInside(root, full)) void openFile(full, { preview: true });
																		};
																		const stClass = f.status.startsWith("A")
																			? "added"
																			: f.status.startsWith("D")
																				? "deleted"
																				: "modified";
																		return (
																			<li>
																				<button type="button" class="git-commit-file-btn" title={f.path} onClick={openCommitFile}>
																					<span class={`git-letter ${stClass}`}>{f.status[0] ?? "M"}</span>
																					<span class="label">{f.path}</span>
																				</button>
																			</li>
																		);
																	}}
																</For>
																<Show when={c.files.length > 8}>
																	<li class="meta">… and {c.files.length - 8} more</li>
																</Show>
															</ul>
														</Show>
													</li>
												)}
											</For>
										</ul>
									</Show>
								</div>
							</Show>
						</section>
					)}
				</Show>
			</Show>
		</div>
	);
}
