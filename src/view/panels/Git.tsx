// Source control: what has changed since the last commit, what of it is
// staged for the next one, and the commit itself. A row shows its change
// beside what git has of the file; its menu stages it, takes it out again,
// or lets its changes go (after asking). Everything stays on this machine:
// there is no fetch, pull or push here.
import { Icon } from "../Icon";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { createAsyncQuery } from "../asyncQuery";
import { changeLetter, changeWord, commitProblem, GIT_ACTIONS, rowMenuEntries, stagedOf, unstagedOf, type GitFile } from "../../shared/gitStatus";
import { draftCommitMessage, formatTicketChangelog } from "../../shared/markdownDiff";
import { detectBranchTicketMismatch } from "../../shared/menuBar";
import type { RowMenuEntry } from "../../shared/contextMenu";
import { baseName, dirName, isInside, relativeTo, resolvePath } from "../../shared/paths";
import type { DocFile, TicketGitCommit } from "../../shared/protocol";
import { codeMatchesRef, docsGoverningFile, ticketsForFile, ticketWork } from "../../shared/workContext";
import { backend } from "../backend";
import { docAuditData } from "../docAudit";
import { languageFor } from "../editor/languages";
import { openComparison } from "../editor/Review";
import { FileMark } from "../FileMark";
import { branchText, commit, discard, gitFailure, gitStatus, gitVersion, isOwnRepository, refreshGit, showChange, stage, unstage } from "../git";
import { docs } from "../project";
import { appendNoteToTicket, staleCatalogSummary, ticketAtHand, updateCatalogs, updateManifest } from "../projectDocs";
import { activePath, canonical, notify, openFile, state } from "../state";
import { chooseFromMenu } from "./RowMenu";
import { IconButton, Row, RowGroup, Rows, type Point } from "./Rows";

const { show: SHOW, open: OPEN, stage: STAGE, unstage: UNSTAGE, discard: DISCARD, trash: TRASH, copyPath: COPY_PATH, copyRelative: COPY_RELATIVE, copyName: COPY_NAME, showInExplorer: SHOW_EXPLORER } = GIT_ACTIONS;

/** What the next commit is to say. Kept while the panel is away: a message half written is not lost to a look at another panel. */
const [message, setMessage] = createSignal("");
const [busy, setBusy] = createSignal(false);
let messageRoot: string | undefined;
let commitDiffReq = 0;

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

/** What a folder with a repository of its own is called in the list, where a file has its change. */
const OWN_REPOSITORY = "a repository of its own";
/**
 * What the menu offers for such a folder. It has no change to show, no text to open and nothing to go back to: a
 * file's menu offered it "Move to trash…", which took the whole folder with its own history.
 */
const ownRepositoryMenu = (inWorkspace: boolean): RowMenuEntry[] => [
	STAGE,
	"separator",
	{ label: "Copy path", children: [COPY_PATH, ...(inWorkspace ? [COPY_RELATIVE] : []), COPY_NAME] },
	...(inWorkspace ? [SHOW_EXPLORER] : []),
];

function formatCommitDate(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function GitPanel() {
	// git is asked again each time the panel is shown: a folder that has become a repository since (`git init` in a
	// terminal, a clone that finished) is found on a look at this panel, not only when the app is started again.
	onSettled(() => {
		void refreshGit();
	});
	createEffect(
		() => state.workspace?.root,
		(root) => {
			if (root !== messageRoot) {
				messageRoot = root;
				setMessage("");
			}
		},
	);
	const staged = () => (gitStatus() ? stagedOf(gitStatus()!) : []);
	const changes = () => (gitStatus() ? unstagedOf(gitStatus()!) : []);
	/** Files staged above the workspace's folder: not listed, and in the commit all the same. */
	const above = () => gitStatus()?.stagedOutside ?? 0;
	const [driftOpen, setDriftOpen] = createSignal(false);
	const [commitsOpen, setCommitsOpen] = createSignal(false);
	const [commitScope, setCommitScope] = createSignal<"active" | "file">("active");
	const activeTicketKey = () => state.settings.activeTicket?.trim() || "";
	const fileTicketKey = createMemo(() => {
		const fromFile = ticketsForFile(docs(), activePath(), state.workspace?.root)[0];
		return fromFile || ticketAtHand() || "";
	});
	const displayedCommitTicket = createMemo(() =>
		commitScope() === "file" ? fileTicketKey() || activeTicketKey() : activeTicketKey() || fileTicketKey(),
	);
	const branchMismatch = createMemo(() => detectBranchTicketMismatch(gitStatus()?.branch, activeTicketKey()));
	const runGitCmd = async (id: string) => {
		const { runCommand } = await import("../commands");
		runCommand(id);
	};

	// Non-blocking pre-commit doc readiness advisory for staged changes:
	// untouched governing docs, drifted #L citations, stale/unstaged companion .plan.md for .plan.json,
	// broken links/anchors/YAML issues in staged .md files, open ticket tasks & questions,
	// newly added .ssl/.sql/.ds files missing from files.csv/database.csv, and stale INDEX.md catalogs.
	const docDrift = createMemo(() => {
		const root = state.workspace?.root;
		const stFiles = staged();
		type EmptyDrift = {
			governing: { file: DocFile; reason: string; unstaged?: GitFile }[];
			citations: NonNullable<ReturnType<typeof docAuditData>["citationIssues"]>;
			stalePlanSpecs: { planName: string; specPath: string; reason: string; unstaged?: GitFile }[];
			mdIssues: { path: string; line: number; label: string; detail: string }[];
			openTasks: ReturnType<typeof docAuditData>["openTasks"];
			openQuestions: DocFile[];
			unregisteredAdded: { path: string; rel: string; targetReg: DocFile; missingIn: string }[];
			hasFilesReg: boolean;
			staleCatalogCount: number;
			total: number;
		};
		if (!root || !stFiles.length) {
			return {
				governing: [],
				citations: [],
				stalePlanSpecs: [],
				mdIssues: [],
				openTasks: [],
				openQuestions: [],
				unregisteredAdded: [],
				hasFilesReg: false,
				staleCatalogCount: 0,
				total: 0,
			} as EmptyDrift;
		}
		const allDocs = docs();
		const docsByCanon = new Map(allDocs.filter((d) => d.exists).map((d) => [canonical(d.path), d]));
		const stagedSet = new Set(stFiles.map((f) => canonical(f.path)));
		const unstagedByPath = new Map(changes().map((f) => [canonical(f.path), f]));
		const stagedCode = stFiles.filter((f) => CODE_OR_SQL_RE.test(f.path));

		// 1. Untouched governing docs for staged code/SQL files
		const govMap = new Map<string, { file: DocFile; reason: string; unstaged?: GitFile }>();
		for (const cf of stagedCode) {
			for (const g of docsGoverningFile(allDocs, cf.path, root)) {
				const k = canonical(g.file.path);
				if (stagedSet.has(k) || govMap.has(k)) continue;
				govMap.set(k, { file: g.file, reason: g.reason, unstaged: unstagedByPath.get(k) });
			}
		}

		// 2. Drifted #L code citations pointing into staged files
		const audit = docAuditData();
		const citations = (audit.citationIssues ?? []).filter((ci) => stagedSet.has(canonical(ci.targetPath)));

		// 3. Staged .plan.json files whose companion .plan.md is stale or unstaged
		const stalePlanSpecs: EmptyDrift["stalePlanSpecs"] = [];
		for (const sf of stFiles) {
			if (sf.staged === "deleted" || !sf.path.toLowerCase().endsWith(".plan.json")) continue;
			const specPath = sf.path.replace(/\.plan\.json$/i, ".plan.md");
			const specKey = canonical(specPath);
			if (stagedSet.has(specKey)) continue;
			const unstagedSpec = unstagedByPath.get(specKey);
			const specDoc = docsByCanon.get(specKey);
			const planDoc = docsByCanon.get(canonical(sf.path));
			if (unstagedSpec) {
				stalePlanSpecs.push({ planName: baseName(sf.path), specPath, reason: "modified, unstaged", unstaged: unstagedSpec });
			} else if (specDoc?.exists) {
				const older = Boolean(planDoc?.mtime && specDoc.mtime && planDoc.mtime > specDoc.mtime);
				stalePlanSpecs.push({
					planName: baseName(sf.path),
					specPath: specDoc.path,
					reason: older ? "plan doc older than plan" : "not staged with plan",
				});
			}
		}

		// 4. Broken links / anchors / YAML issues inside staged .md files
		const stagedMdSet = new Set(
			stFiles
				.filter((f) => f.staged !== "deleted" && /\.(md|markdown)$/i.test(f.path))
				.map((f) => canonical(f.path)),
		);
		const mdIssues: EmptyDrift["mdIssues"] = [];
		if (stagedMdSet.size) {
			for (const d of allDocs) {
				if (!d.exists || !stagedMdSet.has(canonical(d.path)) || !d.broken?.length) continue;
				for (const b of d.broken) {
					mdIssues.push({
						path: d.path,
						line: b.line,
						label: `${baseName(d.path)}:${b.line}`,
						detail: `broken link (${b.href})`,
					});
				}
			}
			for (const iss of audit.issues) {
				if (!stagedMdSet.has(canonical(iss.path))) continue;
				if (iss.kind === "orphan" || iss.kind === "stale") continue;
				mdIssues.push({
					path: iss.path,
					line: iss.line,
					label: `${baseName(iss.path)}:${iss.line}`,
					detail: `${iss.kind}: ${iss.message}`,
				});
			}
		}

		// 5. Open checklist tasks (- [ ]) and open Questions on ticket(s) touched by staged changes
		const stagedTicketKeys: string[] = [];
		const stagedTicketSet = new Set<string>();
		for (const sf of stFiles) {
			for (const k of ticketsForFile(allDocs, sf.path, root)) {
				const kl = k.toLowerCase();
				if (stagedTicketSet.has(kl)) continue;
				stagedTicketSet.add(kl);
				stagedTicketKeys.push(k);
			}
		}
		const ticketScopePaths = new Set<string>();
		const openQuestionsMap = new Map<string, DocFile>();
		for (const k of stagedTicketKeys) {
			const tDoc = allDocs.find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === k.toLowerCase());
			if (tDoc) ticketScopePaths.add(canonical(tDoc.path));
			for (const grp of ticketWork(allDocs, k)) {
				if (grp.kind === "spec") {
					for (const sp of grp.files) ticketScopePaths.add(canonical(sp.path));
				} else if (grp.kind === "question") {
					for (const q of grp.files) {
						const qk = canonical(q.path);
						if (!openQuestionsMap.has(qk)) openQuestionsMap.set(qk, q);
					}
				}
			}
		}
		const openTasks = stagedTicketSet.size
			? audit.openTasks.filter(
					(t) => (t.ticket && stagedTicketSet.has(t.ticket.toLowerCase())) || ticketScopePaths.has(canonical(t.path)),
				)
			: [];
		const openQuestions = [...openQuestionsMap.values()];

		// 6. Newly added (.ssl / .sql / .ds) files not yet listed in files.csv or database.csv
		const filesReg = allDocs.find((d) => d.exists && d.group === "registries" && /^files\.(csv|tsv)$/i.test(d.name));
		const dbReg = allDocs.find((d) => d.exists && d.group === "registries" && /^database\.(csv|tsv)$/i.test(d.name));
		const unregisteredAdded: EmptyDrift["unregisteredAdded"] = [];
		if (filesReg || dbReg) {
			for (const sf of stFiles) {
				if (sf.staged !== "added" || !/\.(ssl|sql|ds)$/i.test(sf.path)) continue;
				const inFiles = Boolean(filesReg?.codeRefs?.some((ref) => codeMatchesRef(sf.path, ref, root)));
				const inDb = Boolean(dbReg?.codeRefs?.some((ref) => codeMatchesRef(sf.path, ref, root)));
				if (inFiles || inDb) continue;
				const isSql = /\.sql$/i.test(sf.path);
				const targetReg = (isSql && dbReg) || filesReg || dbReg!;
				const missingIn =
					isSql && filesReg && dbReg
						? "files.csv / database.csv"
						: isSql && dbReg
							? dbReg.name
							: filesReg
								? filesReg.name
								: dbReg!.name;
				unregisteredAdded.push({
					path: sf.path,
					rel: relativeTo(root, sf.path).replace(/\\/g, "/"),
					targetReg,
					missingIn,
				});
			}
		}

		const catSummary = staleCatalogSummary();
		const staleCatalogCount = catSummary.stale.length + catSummary.missing.length;
		const governing = [...govMap.values()];
		const total =
			governing.length +
			citations.length +
			stalePlanSpecs.length +
			mdIssues.length +
			openTasks.length +
			openQuestions.length +
			unregisteredAdded.length +
			(staleCatalogCount > 0 ? 1 : 0);
		return {
			governing,
			citations,
			stalePlanSpecs,
			mdIssues,
			openTasks,
			openQuestions,
			unregisteredAdded,
			hasFilesReg: Boolean(filesReg),
			staleCatalogCount,
			total,
		};
	});

	const [ticketCommits] = createAsyncQuery(
		() => {
			const root = state.workspace?.root;
			const key = displayedCommitTicket();
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
		else if (action === COPY_PATH || action === COPY_RELATIVE || action === COPY_NAME) {
			await (await import("../commands")).copyPath(action === COPY_PATH ? "whole" : action === COPY_NAME ? "name" : "relative", file.path);
		} else if (action === SHOW_EXPLORER) {
			(await import("./Explorer")).showInExplorer(file.path);
		}
	};
	const menu = async (file: GitFile, isStaged: boolean, at: Point) => {
		const inWorkspace = Boolean(state.workspace && isInside(state.workspace.root, file.path));
		const entries = !isStaged && isOwnRepository(file) ? ownRepositoryMenu(inWorkspace) : rowMenuEntries(file, isStaged, inWorkspace);
		const action = await chooseFromMenu(`Actions for ${baseName(file.path)}`, entries, at);
		if (action === SHOW) await showChange(file, isStaged);
		else await act(action, file);
	};
	const make = async () => {
		if (problem()) return notify(`${problem()}.`);
		const submitted = message();
		const root = state.workspace?.root;
		setBusy(true);
		let made = false;
		try {
			made = await commit(submitted.trim());
		} finally {
			setBusy(false);
		}
		if (made && state.workspace?.root === root && message() === submitted) setMessage("");
	};
	const stageAll = async () => {
		const all = changes();
		// A folder with a repository of its own is not one of the files. Given to git in the one command with them,
		// one that has no commit yet made git refuse the lot ("does not have a commit checked out"): nothing was
		// staged. One that has a commit was put into the commit as a pointer to it, unasked.
		const own = all.filter(isOwnRepository);
		const stageable = all.filter((f) => f.unstaged !== "conflict").filter((f) => !isOwnRepository(f));
		const skipped = all.length - stageable.length - own.length;
		if (stageable.length) await stage(stageable);
		if (own.length) {
			notify(
				own.length === 1
					? `Left out ${baseName(own[0]!.path)}: a folder with a git repository of its own is not staged with the files. Stage it from its own row if that is meant.`
					: `Left out ${own.length} folders with git repositories of their own: they are not staged with the files. Stage one from its own row if that is meant.`,
			);
		}
		if (skipped > 0) {
			notify(
				skipped === 1
					? "Skipped 1 conflicted file: resolve merge conflicts before staging it."
					: `Skipped ${skipped} conflicted files: resolve merge conflicts before staging them.`,
			);
		}
	};
	const draftMessage = () => {
		const st = staged();
		if (!st.length) return notify("Stage files first to draft a commit message.");
		const primaryKey = suggestedTickets()[0] || activeTicketKey() || "";
		const ticketDoc = primaryKey
			? docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === primaryKey.toLowerCase())
			: undefined;
		const drafted = draftCommitMessage({
			staged: st,
			root: state.workspace?.root,
			ticketKey: primaryKey || undefined,
			ticketTitle: ticketDoc?.title,
		});
		if (drafted) setMessage(drafted);
	};
	type CommitFileEntry = TicketGitCommit["files"][number];
	const openCommitFileDiff = async (commitItem: TicketGitCommit, f: CommitFileEntry) => {
		const root = state.workspace?.root;
		if (!root) return;
		const req = ++commitDiffReq;
		const stale = () => req !== commitDiffReq || state.workspace?.root !== root;
		const outside = f.inWorkspace === false;
		const repoPath = f.repoPath || (outside ? f.path : undefined);
		let targetPath: string;
		if (outside) {
			targetPath = root;
		} else {
			const full = resolvePath(root, f.path);
			if (!isInside(root, full)) return;
			targetPath = full;
		}
		const displayPath = outside ? (repoPath ?? f.path) : targetPath;
		try {
			const { before, after } = await backend.gitCommitFile(targetPath, commitItem.sha, repoPath);
			if (stale()) return;
			if (before === null && after === null) {
				notify(`Could not read text diff for ${f.path} at commit ${commitItem.shortSha}.`, "error");
				return;
			}
			await openComparison({
				title: `${commitItem.shortSha}: ${baseName(f.path)}`,
				path: displayPath,
				before: before ?? "",
				after: after ?? "",
				beforeLabel: before === null ? "(not in parent)" : `${commitItem.shortSha}~1`,
				afterLabel: after === null ? "(deleted)" : commitItem.shortSha,
				language: languageFor(displayPath),
				effect: `${commitItem.shortSha} (${commitItem.subject}) — commit diff for ${f.path}. Nothing here changes the file.`,
			});
		} catch (e: any) {
			if (stale()) return;
			notify(`Could not open commit diff for ${f.path}: ${String(e?.message ?? e)}`, "error");
		}
	};
	const openCommitCurrentFile = (f: CommitFileEntry) => {
		const root = state.workspace?.root;
		if (!root) return;
		if (f.inWorkspace === false) {
			notify(`${f.path} is outside the open workspace folder.`);
			return;
		}
		const full = resolvePath(root, f.path);
		if (isInside(root, full)) void openFile(full, { keep: true });
	};
	const commitFileMenu = async (commitItem: TicketGitCommit, f: CommitFileEntry, at: Point) => {
		const VIEW_DIFF = "View commit diff";
		const OPEN_CUR = "Open current file";
		const entries = f.inWorkspace === false ? [VIEW_DIFF] : [VIEW_DIFF, OPEN_CUR];
		const action = await chooseFromMenu(baseName(f.path), entries, at);
		if (action === VIEW_DIFF) await openCommitFileDiff(commitItem, f);
		else if (action === OPEN_CUR) openCommitCurrentFile(f);
	};
	const buildTicketChangelog = (key: string): string => {
		const list = ticketCommits() ?? [];
		if (!list.length) return "";
		const tDoc = docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === key.toLowerCase());
		return formatTicketChangelog(key, list, { title: tDoc?.title });
	};
	const copyTicketChangelog = async (key: string) => {
		const md = buildTicketChangelog(key);
		if (!md) return notify(`No local commits mentioning ${key} to copy.`);
		await (await import("../commands")).copyText(md, `Copied ${key} changelog.`);
	};
	const appendTicketChangelog = async (key: string) => {
		const md = buildTicketChangelog(key);
		if (!md) return notify(`No local commits mentioning ${key} to append.`);
		await appendNoteToTicket(key, md);
	};
	const FileRow = (props: { file: GitFile; staged: boolean }) => {
		const kind = () => (props.staged ? props.file.staged : props.file.unstaged)!;
		const name = () => baseName(props.file.path);
		/** Not a file: a folder with a repository of its own, which git here lists as one new name. */
		const own = () => !props.staged && isOwnRepository(props.file);
		return (
			<Row
				class="tree-row git-row"
				key={`${props.staged ? "staged" : "changed"}:${props.file.path}`}
				label={name()}
				title={
					own()
						? `${relativeTo(state.workspace?.root, props.file.path)}: a folder with a git repository of its own. git here does not look inside it, and it is not discarded or moved to the trash from this list. The menu key has more.`
						: `${relativeTo(state.workspace?.root, props.file.path)}: ${changeWord(kind())}${props.file.from ? `, was ${relativeTo(state.workspace?.root, props.file.from)}` : ""}. Enter shows the change; the menu key has more.`
				}
				onActivate={() => void showChange(props.file, props.staged)}
				onMenu={(at) => void menu(props.file, props.staged, at)}
			>
				<FileMark name={name()} folder={own() ? { open: false } : undefined} />
				<span class={["label", { gone: kind() === "deleted" }]}>
					{name()}
					<Show when={own()}>
						<span class="git-folder">{OWN_REPOSITORY}</span>
					</Show>
					<Show when={folder(props.file.path)}>
						<span class="git-folder">{folder(props.file.path)}</span>
					</Show>
				</span>
				{/* The same steps as the row's menu, for the pointer: out of the keyboard's way, which has the menu key. */}
				<span class="git-acts" onClick={(e) => e.stopPropagation()}>
					<Show when={!props.staged && kind() !== "conflict" && !own()}>
						<button type="button" tabindex={-1} title={kind() === "untracked" ? "Move to trash…" : "Discard changes…"} aria-label={`${kind() === "untracked" ? "Move to trash" : "Discard the changes to"} ${name()}`} onClick={() => void discard(props.file)}>
							<Icon name="discard" />
						</button>
					</Show>
					<button type="button" tabindex={-1} title={props.staged ? "Unstage" : "Stage"} aria-label={`${props.staged ? "Unstage" : "Stage"} ${name()}`} onClick={() => void (props.staged ? unstage([props.file]) : stage([props.file]))}>
						<Icon name={props.staged ? "remove" : "add"} />
					</button>
				</span>
				<span class={`git-letter ${kind()}`} aria-label={own() ? OWN_REPOSITORY : changeWord(kind())}>
					{changeLetter(kind())}
				</span>
			</Row>
		);
	};
	return (
		<div class="panel-body" data-panel="git">
			<div class="panel-title">
				<span>Source control</span>
				<Show when={gitStatus()}>
					<IconButton label="Switch branch" title="Switch Git branch…" icon="git-branch" onClick={() => void runGitCmd("git-switch-branch")} />
					<IconButton label="Git stash" title="Stash changes / pop stash…" icon="layers" onClick={() => void runGitCmd("git-stash")} />
					<IconButton label="Line blame" title="Show Git commit & ticket for the current line" icon="eye" onClick={() => void runGitCmd("git-blame-line")} />
				</Show>
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
				<Show when={branchMismatch()}>
					{(mismatch) => (
						<div class="git-branch-mismatch" role="status" aria-label="Branch and active ticket mismatch">
							<div class="git-branch-mismatch-msg">
								<Icon name="warning" />
								<span>
									Branch is <strong>{mismatch().branchTicket}</strong>, active ticket is <strong>{mismatch().activeTicket}</strong>.
								</span>
							</div>
							<div class="git-branch-mismatch-acts">
								<button type="button" class="link" onClick={() => void runGitCmd("git-switch-branch")}>
									Switch branch…
								</button>
								<button type="button" class="link" onClick={() => void runGitCmd("git-stash")}>
									Stash…
								</button>
							</div>
						</div>
					)}
				</Show>
				<Show when={docDrift().total > 0}>
					<div class="git-drift" role="region" aria-label="Documentation drift advisory">
						<button
							type="button"
							class="git-drift-toggle"
							aria-expanded={driftOpen() ? "true" : "false"}
							title="Non-blocking pre-commit checklist: governing docs, open ticket tasks/questions, plan specs, staged Markdown issues, registries, citations, and catalogs"
							onClick={() => setDriftOpen((v) => !v)}
						>
							<Icon name={driftOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
							<Icon name="note" class="git-drift-icon" />
							<span class="git-drift-title">
								Doc readiness · {docDrift().total} {docDrift().total === 1 ? "note" : "notes"}
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
								<Show when={docDrift().stalePlanSpecs.length > 0}>
									<p class="git-drift-sub">Staged plans with stale or unstaged plan docs</p>
									<ul class="git-drift-list">
										<For each={docDrift().stalePlanSpecs.slice(0, 6)}>
											{(item) => (
												<li>
													<span class="git-drift-label" title={`${relativeTo(state.workspace?.root, item.specPath)} (${item.reason})`}>
														{baseName(item.specPath)} <span class="meta">· {item.reason}</span>
													</span>
													<span class="git-drift-acts">
														<button type="button" class="link" onClick={() => void openFile(item.specPath, { keep: true })}>
															Open
														</button>
														<Show when={item.unstaged}>
															{(gf) => (
																<button type="button" class="link" title="Stage companion plan doc alongside plan" onClick={() => void stage([gf()])}>
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
								<Show when={docDrift().mdIssues.length > 0}>
									<p class="git-drift-sub">Issues in staged Markdown ({docDrift().mdIssues.length})</p>
									<ul class="git-drift-list">
										<For each={docDrift().mdIssues.slice(0, 6)}>
											{(iss) => (
												<li>
													<span class="git-drift-label" title={`${iss.label}: ${iss.detail}`}>
														{iss.label} <span class="meta">· {iss.detail}</span>
													</span>
													<span class="git-drift-acts">
														<button type="button" class="link" onClick={() => void openFile(iss.path, { reveal: { line: iss.line }, keep: true })}>
															Open
														</button>
													</span>
												</li>
											)}
										</For>
										<Show when={docDrift().mdIssues.length > 6}>
											<li class="meta">… and {docDrift().mdIssues.length - 6} more</li>
										</Show>
									</ul>
								</Show>
								<Show when={docDrift().openTasks.length > 0}>
									<p class="git-drift-sub">Open ticket tasks ({docDrift().openTasks.length})</p>
									<ul class="git-drift-list">
										<For each={docDrift().openTasks.slice(0, 6)}>
											{(t) => (
												<li>
													<span class="git-drift-label" title={`${t.name}:${t.line} — ${t.text}`}>
														{t.ticket ? `${t.ticket}: ` : ""}{t.text}
													</span>
													<span class="git-drift-acts">
														<button type="button" class="link" onClick={() => void openFile(t.path, { reveal: { line: t.line }, keep: true })}>
															Open
														</button>
													</span>
												</li>
											)}
										</For>
										<Show when={docDrift().openTasks.length > 6}>
											<li class="meta">… and {docDrift().openTasks.length - 6} more</li>
										</Show>
									</ul>
								</Show>
								<Show when={docDrift().openQuestions.length > 0}>
									<p class="git-drift-sub">Open ticket questions ({docDrift().openQuestions.length})</p>
									<ul class="git-drift-list">
										<For each={docDrift().openQuestions.slice(0, 6)}>
											{(q) => (
												<li>
													<span class="git-drift-label" title={relativeTo(state.workspace?.root, q.path)}>
														{q.title || q.name}
													</span>
													<span class="git-drift-acts">
														<button type="button" class="link" onClick={() => void openFile(q.path, { keep: true })}>
															Open
														</button>
													</span>
												</li>
											)}
										</For>
									</ul>
								</Show>
								<Show when={docDrift().unregisteredAdded.length > 0}>
									<p class="git-drift-sub">New scripts/SQL missing from registries</p>
									<ul class="git-drift-list">
										<For each={docDrift().unregisteredAdded.slice(0, 6)}>
											{(u) => (
												<li>
													<span class="git-drift-label" title={`${u.rel} is not yet listed in ${u.missingIn}`}>
														{baseName(u.path)} <span class="meta">· missing in {u.missingIn}</span>
													</span>
													<span class="git-drift-acts">
														<button type="button" class="link" onClick={() => void openFile(u.targetReg.path, { keep: true })}>
															Open
														</button>
													</span>
												</li>
											)}
										</For>
										<Show when={docDrift().hasFilesReg}>
											<li>
												<span class="meta">Refresh files.csv manifest to include newly added files</span>
												<span class="git-drift-acts">
													<button type="button" class="link" onClick={() => void updateManifest()}>
														Update manifest
													</button>
												</span>
											</li>
										</Show>
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
					<div style={{ display: "flex", "align-items": "center", gap: "var(--space-2)", "flex-wrap": "wrap" }}>
						{/* Not the button's own "disabled": it keeps the keyboard, and says why it does nothing. */}
						<button type="submit" class="primary" aria-disabled={problem() ? "true" : undefined} title={problem() || `Commit the ${staged().length + above()} staged ${staged().length + above() === 1 ? "file" : "files"}`}>
							Commit
						</button>
						<button
							type="button"
							style={{ display: "inline-flex", "align-items": "center", gap: "4px" }}
							aria-disabled={!staged().length ? "true" : undefined}
							title={staged().length ? "Build a commit message from the staged files and active ticket" : "Stage files first to draft a commit message"}
							onClick={draftMessage}
						>
							<Icon name="sparkle" />
							<span>Draft commit message</span>
						</button>
					</div>
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
										<IconButton label="Stage all" title="Put every non-conflicted change into the commit" icon="add" onClick={() => void stageAll()} />
									</>
								}
							>
								<For each={changes().slice(0, ROWS_SHOWN)}>{(file) => <FileRow file={file} staged={false} />}</For>
							</RowGroup>
							<More count={changes().length - ROWS_SHOWN} />
						</Show>
					</Rows>
				</Show>
				<Show when={displayedCommitTicket()}>
					{(key) => (
						<section class="git-ticket-log" aria-label={`Commits mentioning ${key()}`}>
							<div class="group-head git-head git-ticket-log-head" style={{ display: "flex", "align-items": "center", gap: "var(--space-2)" }}>
								<button
									type="button"
									class="foldable"
									style={{
										flex: 1,
										display: "flex",
										"align-items": "center",
										gap: "var(--space-2)",
										padding: 0,
										background: "transparent",
										border: 0,
										color: "inherit",
										font: "inherit",
										"text-align": "left",
										"min-width": 0,
									}}
									aria-expanded={commitsOpen() ? "true" : "false"}
									onClick={() => setCommitsOpen((v) => !v)}
								>
									<Icon name={commitsOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
									<span class="label">Ticket commits · {key()}</span>
									<span class="count">{ticketCommits.loading ? "…" : (ticketCommits()?.length ?? 0)}</span>
								</button>
								<Show when={!ticketCommits.loading && (ticketCommits()?.length ?? 0) > 0}>
									<IconButton
										label="Copy ticket changelog"
										title={`Copy ${key()} commits as a Markdown bullet list`}
										icon="copy"
										onClick={() => void copyTicketChangelog(key())}
									/>
									<IconButton
										label="Append to ticket"
										title={`Append ${key()} commit changelog to the ticket document`}
										icon="note"
										onClick={() => void appendTicketChangelog(key())}
									/>
								</Show>
							</div>
							<Show when={commitsOpen()}>
								<div class="git-ticket-scope" role="group" aria-label="Ticket commit filter source">
									<button
										type="button"
										class={{ on: Boolean(activeTicketKey()) && (commitScope() === "active" || !fileTicketKey()) }}
										disabled={!activeTicketKey()}
										title={activeTicketKey() ? `Show commits mentioning active ticket ${activeTicketKey()}` : "No active ticket set"}
										onClick={() => setCommitScope("active")}
									>
										Active ticket{activeTicketKey() ? ` (${activeTicketKey()})` : ""}
									</button>
									<button
										type="button"
										class={{ on: Boolean(fileTicketKey()) && (commitScope() === "file" || !activeTicketKey()) }}
										disabled={!fileTicketKey()}
										title={fileTicketKey() ? `Show commits mentioning current file's ticket ${fileTicketKey()}` : "Current file is not linked to a ticket"}
										onClick={() => setCommitScope("file")}
									>
										Current file{fileTicketKey() ? ` (${fileTicketKey()})` : ""}
									</button>
								</div>
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
																		const stClass = f.status.startsWith("A")
																			? "added"
																			: f.status.startsWith("D")
																				? "deleted"
																				: "modified";
																		return (
																			<li>
																				<button
																					type="button"
																					class="git-commit-file-btn"
																					title={`${f.path} — Click to view commit diff (${c.shortSha}~1..${c.shortSha}); right-click for more`}
																					onClick={() => void openCommitFileDiff(c, f)}
																					onContextMenu={(e) => {
																						e.preventDefault();
																						e.stopPropagation();
																						const box = e.currentTarget.getBoundingClientRect();
																						void commitFileMenu(
																							c,
																							f,
																							e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + 16, y: box.bottom },
																						);
																					}}
																					onKeyDown={(e) => {
																						if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
																							e.preventDefault();
																							const box = e.currentTarget.getBoundingClientRect();
																							void commitFileMenu(c, f, { x: box.left + 16, y: box.bottom });
																						}
																					}}
																				>
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
