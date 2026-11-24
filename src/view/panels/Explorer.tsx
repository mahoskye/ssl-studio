// The workspace tree, loaded a folder at a time, with a size badge on files
// near or over the house size limit. What can be done to a file or a folder
// is on its menu (right-click, the menu key, Shift+F10), on F2 and Delete,
// on Ctrl+X, Ctrl+C and Ctrl+V, and in the command palette. A row dragged
// onto a folder is moved there, after asking.
import { Icon } from "../Icon";
import { FileMark } from "../FileMark";
import { batch, createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { DocFile, Entry } from "../../shared/protocol";
import { level } from "../../shared/houseStyle";
import { backend } from "../backend";
import { ask, choose, quickPick } from "../dialogs";
import { activePath, canonical, closeAllTabs, closeTab, fileRemoved, fileRenamed, focusEditor, heldFromBefore, isUntitled, notify, openFile, openToSide, saveAll, scriptsCameTo, setState, state } from "../state";
import { closeComparison } from "../editor/Review";
import { baseName, dirName, isInside, joinPath, relativeTo, resolvePath } from "../../shared/paths";
import { imageType, looksBinary } from "../../shared/fileKind";
import { htmlToMarkdown } from "../../shared/htmlToMarkdown";
import { ATTACH_TO_AGENT, COPY, COPY_NAME, COPY_PATH, COPY_RELATIVE, CUT, FIND_IN_FOLDER, folderFor, holdsRoot, menuEntriesFor, nameProblem, NEW_FILE, NEW_FOLDER, OPEN, OPEN_GOVERNING_DOC, OPEN_SIDE, openFolders, PASTE, RENAME, retarget, SCHEMA_FROM_SQL, TRASH, without } from "./explorerMenu";
import { copyName, copyProblem, folderOf, moveProblem, type Clip } from "./explorerMoves";
import { chooseFromMenu } from "./RowMenu";
import { showPanel } from "./registry";
import { findInFolder } from "./Search";
import { catalogsKeptFor, followRename, generateSchemaDocFromSql, renameTicket, trashTicket } from "../projectDocs";
import { docs } from "../project";
import { isCatalog } from "../../shared/projectDocs";
import { buildDocNameIndex, lookupInIndex } from "../../shared/namedLinks";
import { docsGoverningFile, ticketWork } from "../../shared/workContext";
import { gitStatus } from "../git";
import { changeLetter } from "../../shared/gitStatus";
import { focusRowsBelow, IconButton, Row, Rows, type Point, type RowsApi } from "./Rows";
import { outlineAnyOpen, outlineHasExpandable, outlineMenuItems, SymbolOutline, toggleOutlineCollapseAll } from "./Objects";
import { SectionSplitter } from "./SectionSplitter";
import { Menu } from "../Menu";
import { recall, remember } from "../graph/canvas";

/** Optional subfolder scope for Explorer (e.g. browsing a ticket bundle folder without workspace clutter). */
const [scopedFolder, setScopedFolder] = createSignal<{ path: string; label?: string } | null>(null);

/** Updates or clears Explorer's active subfolder scope when that folder is renamed, archived, or trashed. */
export function retargetScopedFolder(from: string, to: string | null, label?: string) {
	const cur = scopedFolder();
	if (!cur) return;
	const curCanon = canonical(cur.path);
	const fromCanon = canonical(from);
	if (curCanon === fromCanon || isInside(fromCanon, curCanon)) {
		if (!to) {
			setScopedFolder(null);
		} else {
			const nextPath = curCanon === fromCanon ? to : to + curCanon.slice(fromCanon.length);
			setScopedFolder({ path: nextPath, label: label ?? cur.label });
		}
	}
}

const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
const toggle = (path: string) =>
	setExpanded((set) => {
		const next = new Set(set);
		next.has(path) ? next.delete(path) : next.add(path);
		return next;
	});
/** The workspace whose open folders were last brought back from what was kept. */
let recalledFor: string | undefined;
/** The last workspace root observed by Explorer, used to clear stale cut/copy state on workspace switch. */
let lastWorkspaceRoot: string | undefined;
/** Whether the Workspace tree accordion is expanded (module-level so `showInExplorer` can open it before mount). */
const [wsOpen, setWsOpen] = createSignal(recall("explorer.workspace") !== "closed");
/** Monotonic sequence & active timer for `showInExplorer` / `browseFolderInExplorer` focus retry loops. */
let focusSearchSeq = 0;
let focusSearchTimer: ReturnType<typeof setTimeout> | null = null;
function cancelExplorerFocusSearch() {
	focusSearchSeq++;
	if (focusSearchTimer !== null) {
		clearTimeout(focusSearchTimer);
		focusSearchTimer = null;
	}
}
/** The row the keyboard is on, for the palette's commands. Forgotten once focus goes to work somewhere else. */
const [focused, setFocused] = createSignal<Entry | null>(null);
/** The tree on screen, to put the keyboard back in after a dialog. */
let tree: RowsApi | undefined;
/** What was cut or copied in the tree, until something else is, or a cut is pasted. */
const [clip, setClip] = createSignal<Clip | null>(null);
/** The row being dragged. */
let dragging: Entry | null = null;
/** The folder a drag would move it into, were it let go now. */
const [dropInto, setDropInto] = createSignal<string | null>(null);

type GitStatusSnapshot = NonNullable<ReturnType<typeof gitStatus>>;
type GitChangeKind = NonNullable<GitStatusSnapshot["files"][number]["unstaged"] | GitStatusSnapshot["files"][number]["staged"]>;
const gitKindCache = new WeakMap<GitStatusSnapshot, Map<string, GitChangeKind>>();

/** Builds/caches a canonical-path -> git-change Map per status snapshot so each tree row looks up status in O(1). */
export function gitKindMapFor(st: GitStatusSnapshot | null | undefined): Map<string, GitChangeKind> {
	if (!st) return new Map();
	let map = gitKindCache.get(st);
	if (!map) {
		map = new Map();
		for (const f of st.files) {
			const key = canonical(f.path);
			if (map.has(key)) continue;
			const kind = f.unstaged ?? f.staged ?? null;
			if (kind) map.set(key, kind);
		}
		gitKindCache.set(st, map);
	}
	return map;
}

/** Clamps a recalled splitter height into `[min, max]`, falling back when missing or non-numeric. */
export function clampExplorerHeight(raw: string | null, min: number, max: number, fallback: number): number {
	if (raw === null || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export const OPEN_EDITORS_MIN_H = 56;
export const OPEN_EDITORS_MAX_H = 360;

/** Computes the next Open Editors height when dragging the splitter, aligned with SectionSplitter min/max. */
export function resizeOpenEditorsHeight(current: number, cap: number, delta: number): number {
	const safeCap = Math.max(OPEN_EDITORS_MIN_H, cap);
	const base = delta < 0 ? Math.min(current, safeCap) : Math.max(current, OPEN_EDITORS_MIN_H);
	return Math.max(OPEN_EDITORS_MIN_H, Math.min(OPEN_EDITORS_MAX_H, base + delta));
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const indent = (depth: number) => ({ "padding-left": `${8 + depth * 14}px` });
const refresh = () => setState("treeVersion", (v) => v + 1);
/**
 * The tree has changed by the app's own hand: it is read again, and the catalog of a folder that has one and holds
 * one of these files is written afresh, so that it goes on saying what the folder holds.
 */
const changed = (...paths: string[]): Promise<void> => {
	refresh();
	return catalogsKeptFor(paths);
};
const errorText = (e: any) => String(e?.message ?? e);

type Listing = { path: string; error: string; entries: Entry[] };

/**
 * A folder's entries, read again when the tree is refreshed. An entry that is
 * still there keeps its row, so focus and the open folders under it stay put.
 */
function useListing(source: () => readonly [string, number] | false | null | undefined) {
	const [listing, setListing] = createStore<Listing>({ path: "", error: "", entries: [] });
	createEffect(
		on(source, (key) => {
			if (!key) return;
			let stale = false;
			onCleanup(() => (stale = true));
			const [path] = key;
			backend.list(path).then(
				(entries) => {
					if (stale) return;
					if (listing.path !== path) return setListing({ path, error: "", entries });
					batch(() => {
						setListing("error", "");
						setListing("entries", reconcile(entries, { key: "path" }));
					});
				},
				(e) => !stale && setListing({ path, error: errorText(e), entries: [] }),
			);
		}),
	);
	return listing;
}

function Listed(props: { listing: Listing; path: string; depth: number }) {
	return (
		<>
			<Show when={props.listing.error}>
				<Row role="treeitem" key={`${props.path}?error`} level={props.depth + 1} class="tree-row tree-note warn" style={indent(props.depth)} onActivate={refresh}>
					<span class="label">This folder could not be read: {props.listing.error}. Press Enter here, or Refresh above, to try again.</span>
				</Row>
			</Show>
			<For each={props.listing.entries}>{(entry) => <EntryRow entry={entry} depth={props.depth} />}</For>
		</>
	);
}

function EntryRow(props: { entry: Entry; depth: number }) {
	const isDir = () => props.entry.kind === "dir";
	const open = () => isDir() && expanded().has(props.entry.path);
	const listing = useListing(() => open() && ([props.entry.path, state.treeVersion] as const));
	const read = () => open() && listing.path === props.entry.path;
	const selected = () => activePath() === canonical(props.entry.path);
	const size = () => level(props.entry.size, state.settings.limits.bytes);
	const entry = (): Entry => ({ ...props.entry });
	const isCut = () => clip()?.cut === true && clip()?.path === props.entry.path;
	const isDirty = () => !isDir() && Boolean(state.dirty[canonical(props.entry.path)]);
	const gitKind = () => (isDir() ? null : (gitKindMapFor(gitStatus()).get(canonical(props.entry.path)) ?? null));
	return (
		<>
			<Row
				role="treeitem"
				key={props.entry.path}
				level={props.depth + 1}
				expanded={isDir() ? open() : undefined}
				selected={selected()}
				classList={{ selected: selected(), cut: isCut(), "drop-into": isDir() && dropInto() === props.entry.path }}
				style={indent(props.depth)}
				title={props.entry.path}
				draggable={true}
				onDragStart={(e) => {
					dragging = entry();
					// Its own kind of thing: dropped on the text, or outside the app, it is nothing.
					e.dataTransfer?.setData("application/x-ssl-studio-file", props.entry.path);
					if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				}}
				onDragEnd={() => {
					dragging = null;
					setDropInto(null);
				}}
				onDragOver={(e) => {
					e.stopPropagation();
					dragOver(e, folderOf(props.entry));
				}}
				onDrop={(e) => {
					e.stopPropagation();
					void dropOn(e, folderOf(props.entry));
				}}
				onChord={(e) => {
					// By the key's place as well as its letter: on a keyboard that writes other letters, Ctrl+C is still that key.
					const action = ({ x: CUT, c: COPY, v: PASTE } as Record<string, string>)[e.key.toLowerCase()] ?? ({ KeyX: CUT, KeyC: COPY, KeyV: PASTE } as Record<string, string>)[e.code];
					if (!action) return false;
					void act(action, entry(), { home: props.entry.path, follow: true });
					return true;
				}}
				// One click opens a file for a look: the next file clicked takes its tab. A double click keeps it.
				onActivate={() => (isDir() ? toggle(props.entry.path) : void openFile(props.entry.path, { preview: true }))}
				onKeep={() => !isDir() && void openFile(props.entry.path, { keep: true })}
				onToggle={() => toggle(props.entry.path)}
				onFocus={() => setFocused(entry())}
				onMenu={(at) => void entryMenu(entry(), at)}
				onKey={(e) => {
					if (e.key !== "F2" && e.key !== "Delete") return false;
					void act(e.key === "F2" ? RENAME : TRASH, entry(), { home: props.entry.path, follow: true });
					return true;
				}}
			>
				<span class="twisty" aria-hidden="true">
					<Show when={isDir()}>
						<Icon name={open() ? "chevron-down" : "chevron-right"} />
					</Show>
				</span>
				<FileMark name={props.entry.name} folder={isDir() ? { open: open() } : undefined} />
				<span class="label">{props.entry.name}</span>
				<Show when={isCut()}>
					<span class="visually-hidden"> (cut, waiting to be pasted)</span>
				</Show>
				<Show when={read() && listing.error}>
					<span class="meta warn" title={listing.error}>
						not readable
					</span>
				</Show>
				<Show when={read() && !listing.error && !listing.entries.length}>
					<span class="meta">empty</span>
				</Show>
				<Show when={!isDir() && size() !== "ok"}>
					<span class={`badge ${size()}`} title={`${size() === "over" ? "Over" : "Near"} the house size limit of ${kb(state.settings.limits.bytes)} for a script (program decision 0006)`}>
						{kb(props.entry.size)}
					</span>
				</Show>
				<Show when={isDirty()}>
					<span class="tree-dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" />
				</Show>
				<Show when={gitKind()}>
					{(kind) => (
						<span class={`tree-git-badge git-letter ${kind()}`} title={`Git: ${kind()}`} aria-label={`Git: ${kind()}`}>
							{changeLetter(kind())}
						</span>
					)}
				</Show>
			</Row>
			<Show when={open()}>
				<div role="group">
					<Listed listing={listing} path={props.entry.path} depth={props.depth + 1} />
				</div>
			</Show>
		</>
	);
}

/** Asks for a name and makes the file or folder. Returns the path the keyboard should go back to. */
async function create(parent: string, kind: "file" | "dir"): Promise<string | null> {
	const name = (await ask(`${kind === "file" ? NEW_FILE : NEW_FOLDER} in ${baseName(parent)}`))?.trim();
	if (!name) return null;
	const problem = nameProblem(name);
	if (problem) return notify(problem, "error"), null;
	const path = joinPath(parent, name);
	if (await heldFromBefore(path)) return null;
	await backend.create(path, kind);
	setExpanded((set) => new Set(set).add(parent));
	void changed(path);
	if (kind === "file") void openFile(path);
	return path;
}

/** Finds a ticket DocFile whose primary file or dedicated bundle folder matches `entry.path`. */
function ticketDocForEntry(entry: Entry) {
	const entryCanon = canonical(entry.path);
	return docs().find(
		(d) =>
			d.exists &&
			d.group === "tickets" &&
			!isCatalog(d) &&
			(canonical(d.path) === entryCanon || Boolean(d.ticketFolder && canonical(d.ticketFolder) === entryCanon)),
	);
}

async function rename(entry: Entry): Promise<string | null> {
	if (!state.workspace || holdsRoot(state.workspace.root, entry.path)) return notify("The workspace folder itself cannot be renamed from here.", "error"), null;
	// Delegate ticket files and bundle folders with a ticket key to bundle-aware `renameTicket` so sibling folders and references stay in sync.
	const ticketDoc = ticketDocForEntry(entry);
	if (ticketDoc?.ticket) {
		await renameTicket(ticketDoc);
		return null;
	}
	const name = (await ask(`Rename ${entry.name}`, entry.name))?.trim();
	if (!name || name === entry.name) return null;
	const problem = nameProblem(name);
	if (problem) return notify(problem, "error"), null;
	const to = joinPath(dirName(entry.path), name);
	if (await heldFromBefore(to)) return null;
	// Snapshot docs before renaming so followNames has the exact pre-rename metadata without racing docs() refresh.
	const beforeDocs = docs().slice();
	await backend.rename(entry.path, to);
	// Open tabs follow the file, so saving one does not bring the old name back.
	fileRenamed(entry.path, to);
	setExpanded((set) => new Set(retarget(set, entry.path, to)));
	setClip((held) => held && { ...held, path: retarget([held.path], entry.path, to)[0]! });
	retargetScopedFolder(entry.path, to, scopedFolder() && canonical(scopedFolder()!.path) === canonical(entry.path) ? baseName(to) : undefined);
	void scriptsCameTo(to, entry.path, entry.kind);
	void changed(entry.path, to);
	void followRename(entry.path, to, beforeDocs);
	return to;
}

async function trash(entry: Entry): Promise<string | null> {
	if (!state.workspace || holdsRoot(state.workspace.root, entry.path)) return notify("The workspace folder itself cannot be moved to the trash from here.", "error"), null;
	// Delegate ticket bundle files/folders to `trashTicket` so Layout 1 & Layout 2 folders are never stranded on disk.
	const ticketDoc = ticketDocForEntry(entry);
	if (ticketDoc?.ticketFolder) {
		await trashTicket(ticketDoc);
		return "";
	}
	const what = entry.kind === "dir" ? `the folder ${entry.name} and everything in it` : entry.name;
	// Pre-delete impact check: Markdown path links, [[wikilinks]], and unified governing docs (plans/specs/tickets/registries).
	const entryCanon = canonical(entry.path);
	const isSelf = (p: string) => canonical(p) === entryCanon || isInside(entry.path, p);
	const allDocs = docs();
	const root = state.workspace.root;
	const [incoming, allNames] = await Promise.all([
		backend.linksTo(entry.path).catch(() => []),
		backend.namesIn().catch(() => []),
	]);
	const referencingDocs = new Set<string>();
	for (const l of incoming) {
		if (!isSelf(l.path)) referencingDocs.add(canonical(l.path));
	}
	const nameIdx = buildDocNameIndex(allDocs, root);
	for (const n of allNames) {
		if (isSelf(n.path)) continue;
		const resolved = lookupInIndex(n.name, nameIdx);
		if (resolved && isSelf(resolved.path)) referencingDocs.add(canonical(n.path));
	}
	for (const g of docsGoverningFile(allDocs, entry.path, root)) {
		if (!isSelf(g.file.path)) referencingDocs.add(canonical(g.file.path));
	}
	// Also cross-check indexed `.plan.json` `nodeDocs` references so plan links are always flagged before deletion.
	for (const d of allDocs) {
		if (!d.exists || !d.nodeDocs?.length || isSelf(d.path)) continue;
		for (const ref of d.nodeDocs) {
			const cleanRef = ref.replace(/\\/g, "/").replace(/^\/+/, "");
			const abs = resolvePath(root, cleanRef);
			if (isSelf(abs)) {
				referencingDocs.add(canonical(d.path));
				break;
			}
		}
	}
	// If trashing a ticket or ticket bundle folder, also include specs, plans, sub-tickets, decisions, questions, and registry rows referencing that ticket.
	const matchedTickets = allDocs.filter(
		(d) => d.exists && d.group === "tickets" && d.ticket && (isSelf(d.path) || (d.ticketFolder && isSelf(d.ticketFolder))),
	);
	let siblingNote = "";
	for (const t of matchedTickets) {
		for (const group of ticketWork(allDocs, t.ticket!)) {
			for (const ref of group.files) {
				if (!isSelf(ref.path)) referencingDocs.add(canonical(ref.path));
			}
		}
		if (t.ticketFolder && !isSelf(t.ticketFolder)) {
			const relSibling = relativeTo(root, t.ticketFolder).split("\\").join("/");
			siblingNote = ` Note: sibling ticket folder ${relSibling}/ will remain on disk.`;
		}
	}
	const referencingPlans = [...referencingDocs].filter((p) => /\.plan\.json$/i.test(p));
	const referencingOtherDocs = [...referencingDocs].filter((p) => !/\.plan\.json$/i.test(p));
	const planNames =
		referencingPlans.slice(0, 3).map(baseName).join(", ") +
		(referencingPlans.length > 3 ? ` and ${referencingPlans.length - 3} more` : "");
	const impactParts: string[] = [];
	if (referencingOtherDocs.length) {
		impactParts.push(
			`${referencingOtherDocs.length} ${referencingOtherDocs.length === 1 ? "project document" : "project documents"}`,
		);
	}
	if (referencingPlans.length) {
		impactParts.push(`${referencingPlans.length} ${referencingPlans.length === 1 ? "plan" : "plans"} (${planNames})`);
	}
	const impact =
		(impactParts.length
			? ` Warning: referenced by ${impactParts.join(" and ")}${referencingOtherDocs.length ? " (links, wikilinks, specs, or registries)" : ""}.`
			: "") + siblingNote;
	if ((await choose(`Move ${what} to the trash?${impact}`, [TRASH], { danger: TRASH })) !== TRASH) return null;
	await backend.trash(entry.path);
	fileRemoved(entry.path);
	// What was cut or copied and is now in the trash is no longer there to paste.
	setClip((held) => (held && without([held.path], entry.path).length ? held : null));
	setExpanded((set) => new Set(without(set, entry.path)));
	setScopedFolder((cur) => (cur && without([cur.path], entry.path).length ? cur : null));
	void changed(entry.path);
	// Its row is going: the keyboard lands on the row that takes its place.
	return "";
}

/** Moves a file or folder into another folder, under its own name. Returns where it is now. */
async function moveInto(from: { path: string; kind: "file" | "dir" }, into: string, options: { ask: boolean }): Promise<string | null> {
	const root = state.workspace?.root;
	if (!root) return null;
	const problem = moveProblem(from.path, into, root);
	if (problem) return notify(problem), null;
	const name = baseName(from.path);
	// A drop is easily made by a slip of the hand: it asks. A paste was asked for twice already.
	if (options.ask && (await choose(`Move ${from.kind === "dir" ? `the folder ${name} and everything in it` : name} into ${baseName(into)}?`, ["Move"])) !== "Move") return null;
	const to = joinPath(into, name);
	if (await heldFromBefore(to)) return null;
	const beforeDocs = docs().slice();
	await backend.rename(from.path, to);
	fileRenamed(from.path, to);
	setExpanded((set) => new Set([...retarget(set, from.path, to), into]));
	retargetScopedFolder(from.path, to);
	void scriptsCameTo(to, from.path, from.kind);
	void changed(from.path, to);
	void followRename(from.path, to, beforeDocs);
	return to;
}

/** Copies a file or folder into a folder: under its own name, or as "… copy" where that name is taken. */
async function copyInto(from: { path: string; kind: "file" | "dir" }, into: string): Promise<string | null> {
	const root = state.workspace?.root;
	if (!root) return null;
	const problem = copyProblem(from.path, into, root);
	if (problem) return notify(problem), null;
	// Names are compared without case: on Windows and on a Mac, two that differ only by case are one file.
	const there = new Set((await backend.list(into)).map((entry) => entry.name.toLowerCase()));
	const taken = (name: string) => there.has(name.toLowerCase());
	const name = baseName(from.path);
	const to = joinPath(into, taken(name) ? copyName(name, taken, from.kind) : name);
	if (await heldFromBefore(to)) return null;
	await backend.copy(from.path, to);
	setExpanded((set) => new Set(set).add(into));
	void scriptsCameTo(to, undefined, from.kind);
	void changed(to);
	// The copy is of the file on disk: edits nobody saved are not in it, and that is said.
	const unsaved = Object.keys(state.dirty).filter((path) => state.dirty[path] && (path === canonical(from.path) || isInside(from.path, path)));
	if (unsaved.length) notify(`The copy is of what is saved: the unsaved changes in ${unsaved.length === 1 ? baseName(unsaved[0]!) : `${unsaved.length} files`} are not in it.`);
	return to;
}

/** Puts what was cut or copied into the row's folder (the row itself, when it is one). */
async function paste(onto: Entry): Promise<string | null> {
	const held = clip();
	if (!held) return notify("Nothing was cut or copied in the Explorer."), null;
	const into = folderOf(onto);
	if (!held.cut) return copyInto(held, into);
	try {
		const to = await moveInto(held, into, { ask: false });
		if (to) setClip(null);
		return to;
	} catch (e) {
		// What was cut is let go only when it is no longer where it was; a move refused for another reason (the
		// name is taken there) leaves it cut, to be pasted somewhere else.
		const still = await backend.list(dirName(held.path)).then(
			(entries) => entries.some((entry) => entry.path === held.path),
			() => false,
		);
		if (!still) setClip(null);
		throw e;
	}
}

/**
 * One action on one entry. Afterwards the keyboard goes to what the action
 * made or renamed (`follow`), or back to the row it came from (`home`) when
 * nothing came of it. With neither, focus is left alone.
 */
async function act(action: string | null, entry: Entry, where: { home?: string; follow: boolean }) {
	const parent = entry.kind === "dir" ? entry.path : dirName(entry.path);
	let back: string | null = null;
	try {
		if (action === OPEN) {
			void openFile(entry.path);
			return;
		}
		if (action === OPEN_SIDE) {
			void openToSide(entry.path);
			return;
		}
		if (action === FIND_IN_FOLDER) {
			const rel = state.workspace ? relativeTo(state.workspace.root, entry.kind === "dir" ? entry.path : dirName(entry.path)) : "";
			findInFolder(rel === "." ? "" : rel);
			return;
		}
		if (action === SCHEMA_FROM_SQL) {
			await generateSchemaDocFromSql(entry.path);
			back = entry.path;
		} else if (action === OPEN_GOVERNING_DOC) {
			const governing = docsGoverningFile(docs(), entry.path, state.workspace?.root);
			if (!governing.length) {
				notify(`No governing documents found for ${entry.name}.`);
				back = entry.path;
			} else if (governing.length === 1) {
				await openFile(governing[0]!.file.path, { keep: true });
				return;
			} else {
				const picked = await quickPick<DocFile>({
					title: `Open governing doc for ${entry.name}`,
					placeholder: "Filter governing documents…",
					items: governing.map((g) => {
						const title =
							g.file.ticket && g.file.title && !g.file.title.startsWith(g.file.ticket)
								? `${g.file.ticket}: ${g.file.title}`
								: g.file.ticket || g.file.title || g.file.name;
						const rel = state.workspace ? relativeTo(state.workspace.root, g.file.path).replace(/\\/g, "/") : g.file.path;
						return {
							value: g.file,
							label: title,
							description: g.reason,
							detail: rel,
							keywords: [title, g.reason, rel, g.file.ticket ?? ""].filter(Boolean).join(" "),
						};
					}),
				});
				if (picked) {
					await openFile(picked.path, { keep: true });
					return;
				}
				back = entry.path;
			}
		} else if (action === ATTACH_TO_AGENT) {
			(await import("../agent/Agent")).attachFileToAgent(entry.path);
			return;
		} else if (action === NEW_FILE) back = await create(parent, "file");
		else if (action === NEW_FOLDER) back = await create(parent, "dir");
		else if (action === RENAME) back = await rename(entry);
		else if (action === TRASH) back = await trash(entry);
		else if (action === CUT || action === COPY) {
			if (state.workspace && holdsRoot(state.workspace.root, entry.path)) notify(`The workspace folder itself cannot be ${action === CUT ? "cut" : "copied"} from here.`);
			else {
				setClip({ path: entry.path, kind: entry.kind, cut: action === CUT });
				// Said, since nothing on screen shows a copy, and a cut row is only dimmed.
				notify(action === CUT ? `${entry.name} is cut: paste it into a folder to move it there.` : `${entry.name} is copied: paste it into a folder.`);
			}
			back = entry.path;
		} else if (action === PASTE) back = await paste(entry);
		else if (action === COPY_PATH || action === COPY_RELATIVE || action === COPY_NAME) {
			// The commands are loaded when asked for, because commands.ts imports this file.
			await (await import("../commands")).copyPath(action === COPY_PATH ? "whole" : action === COPY_NAME ? "name" : "relative", entry.path);
			back = entry.path;
		} else return;
	} catch (e) {
		notify(errorText(e), "error");
	}
	// A new file opens in the editor, which takes the keyboard itself.
	const to = back === null ? where.home : where.follow && action !== NEW_FILE ? back : undefined;
	if (to !== undefined) tree?.focus(to);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** Client-side size limit for external OS file drops before reading bytes into memory. */
export const MAX_DROP_FILE_BYTES = 20 * 1024 * 1024;

/** Sanitizes a dropped file's name: removes control chars, path/Windows-illegal chars, leading/trailing dots & spaces. */
export function sanitizeDropName(raw: string): string {
	const cleaned = raw
		.replace(/[\u0000-\u001f\u007f]+/g, "")
		.replace(/[\\/:*?"<>|]+/g, "-")
		.replace(/^[\s.]+/, "")
		.replace(/[\s.]+$/, "");
	return cleaned || "imported";
}

/** Decodes dropped text bytes strictly as UTF-8, falling back to Windows-1252 so legacy STARLIMS files never get U+FFFD corruption. */
export function decodeDroppedText(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (e) {
		if (e instanceof TypeError) {
			return new TextDecoder("windows-1252").decode(bytes);
		}
		throw e;
	}
}

function isExternalFileDrag(e: DragEvent): boolean {
	if (dragging) return false;
	const types = e.dataTransfer?.types;
	return Boolean(types && [...types].includes("Files"));
}

async function importExternalFiles(files: File[], into: string): Promise<void> {
	const root = state.workspace?.root;
	if (!root || (canonical(into) !== canonical(root) && !isInside(root, into))) {
		notify("Drop files inside the workspace folder.", "error");
		return;
	}
	const configuredAttach = state.settings.attachmentsFolder?.trim();
	const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "").replace(/\\/g, "/");
	const attachmentsDir = configuredAttach
		? resolvePath(root, configuredAttach.replace(/\\/g, "/").replace(/^\/+/, ""))
		: joinPath(root, ...(docsRel && docsRel !== "." ? docsRel.split("/") : ["docs"]), "attachments");

	const existing = new Set((await backend.list(into).catch(() => [])).map((entry) => entry.name.toLowerCase()));
	const taken = (name: string) => existing.has(name.toLowerCase());
	const reserveName = (wanted: string) => {
		const finalName = taken(wanted) ? copyName(wanted, taken, "file") : wanted;
		existing.add(finalName.toLowerCase());
		return finalName;
	};
	const existsOnDisk = async (path: string): Promise<boolean> => {
		try {
			const sizes = await backend.sizes([path]);
			return path in sizes;
		} catch {
			return false;
		}
	};
	const reserveAvailableDest = async (wanted: string): Promise<{ name: string; path: string } | null> => {
		let candidate = reserveName(wanted);
		for (let attempt = 0; attempt < 50; attempt++) {
			const destPath = joinPath(into, candidate);
			if (await existsOnDisk(destPath)) {
				existing.add(candidate.toLowerCase());
				candidate = reserveName(wanted);
				continue;
			}
			if (await heldFromBefore(destPath)) return null;
			return { name: candidate, path: destPath };
		}
		throw new Error(`could not find an unused file name for ${wanted}`);
	};

	const imported: string[] = [];
	const errors: string[] = [];
	let extractedImages = 0;

	for (const file of files) {
		if (file.size > MAX_DROP_FILE_BYTES) {
			errors.push(`${file.name}: exceeds the ${Math.round(MAX_DROP_FILE_BYTES / (1024 * 1024))} MB drop size limit`);
			continue;
		}
		const safeName = sanitizeDropName(file.name);
		try {
			if (/\.docx$/i.test(safeName)) {
				const stem = safeName.replace(/\.docx$/i, "") || "imported";
				const dest = await reserveAvailableDest(`${stem}.md`);
				if (!dest) continue;
				const docxNameForBackend = `${dest.name.replace(/\.md$/i, "")}.docx`;
				const bytes = new Uint8Array(await file.arrayBuffer());
				const res = await backend.importDocxBytes({
					fileName: docxNameForBackend,
					base64: bytesToBase64(bytes),
					destDir: into,
					attachmentsDir,
				});
				imported.push(res.path);
				extractedImages += res.images.length;
			} else if (/\.html?$/i.test(safeName)) {
				const stem = safeName.replace(/\.html?$/i, "") || "imported";
				const dest = await reserveAvailableDest(`${stem}.md`);
				if (!dest) continue;
				const bytes = new Uint8Array(await file.arrayBuffer());
				const md = htmlToMarkdown(decodeDroppedText(bytes));
				await backend.write(dest.path, md.endsWith("\n") ? md : `${md}\n`, true);
				imported.push(dest.path);
			} else if (imageType(safeName)) {
				const dest = await reserveAvailableDest(safeName);
				if (!dest) continue;
				const bytes = new Uint8Array(await file.arrayBuffer());
				await backend.writeImage(dest.path, bytesToBase64(bytes));
				imported.push(dest.path);
			} else {
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (looksBinary(bytes)) {
					errors.push(`${file.name}: binary files other than images and .docx cannot be dropped here`);
					continue;
				}
				const dest = await reserveAvailableDest(safeName);
				if (!dest) continue;
				const text = decodeDroppedText(bytes);
				await backend.write(dest.path, text, true);
				imported.push(dest.path);
			}
		} catch (e: any) {
			errors.push(`${file.name}: ${errorText(e)}`);
		}
	}

	if (imported.length) {
		setExpanded((set) => new Set(set).add(into));
		void changed(...imported);
		const imgNote = extractedImages ? ` (${extractedImages} ${extractedImages === 1 ? "image" : "images"} extracted)` : "";
		if (imported.length === 1) {
			const rel = relativeTo(root, imported[0]!).replace(/\\/g, "/");
			notify(`Imported ${rel}${imgNote}.`);
			if (!imageType(imported[0]!)) void openFile(imported[0]!, { keep: true });
			else tree?.focus(imported[0]!);
		} else {
			notify(`Imported ${imported.length} files into ${baseName(into)}${imgNote}.`);
			tree?.focus(imported[0]!);
		}
	}
	if (errors.length) notify(`Could not import: ${errors.join("; ")}`, "error");
}

/** A row or external OS file is dragged over a folder: highlight when it can be moved or imported there. */
function dragOver(e: DragEvent, into: string) {
	const root = state.workspace?.root;
	if (!root) return setDropInto(null);
	if (isExternalFileDrag(e)) {
		if (canonical(into) !== canonical(root) && !isInside(root, into)) return setDropInto(null);
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		setDropInto(into);
		return;
	}
	if (!dragging || moveProblem(dragging.path, into, root)) return setDropInto(null);
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	setDropInto(into);
}

async function dropOn(e: DragEvent, into: string) {
	const from = dragging;
	dragging = null;
	setDropInto(null);
	if (!from) {
		const dropped = e.dataTransfer?.files;
		if (!dropped?.length) return;
		e.preventDefault();
		await importExternalFiles(Array.from(dropped), into);
		return;
	}
	e.preventDefault();
	try {
		const to = await moveInto(from, into, { ask: true });
		tree?.focus(to ?? from.path);
	} catch (error) {
		notify(errorText(error), "error");
	}
}

const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|docx?|xlsx?|pptx?|zip|7z|tar|gz|rar|exe|dll|so|dylib|bin|sdp|woff2?|ttf|otf|mp3|mp4|wav|avi|mov)$/i;

async function entryMenu(entry: Entry, at: Point) {
	const root = state.workspace?.root;
	if (!root) return;
	const scope = scopedFolder();
	const viewRoot = scope?.path ?? root;
	const isRoot = holdsRoot(viewRoot, entry.path);
	const title = isRoot ? (scope ? `New in ${baseName(viewRoot)}` : "New in the workspace folder") : `Actions for ${entry.name}`;
	const extra =
		entry.kind === "file" && !isRoot
			? {
					sql: /\.(sql|ddl|pks|pkb)$/i.test(entry.name),
					governingCount: docsGoverningFile(docs(), entry.path, root).length,
					attachable: !BINARY_EXT_RE.test(entry.name),
				}
			: undefined;
	const action = await chooseFromMenu(title, menuEntriesFor(entry.kind, entry.path, viewRoot, clip() !== null, extra), at);
	await act(action, entry, { home: isRoot ? undefined : entry.path, follow: true });
}

/** What Rename and Move to trash in the command palette act on: the row the keyboard is on, else the active file. */
function target(verb: string): { entry: Entry; where: { home?: string; follow: boolean } } | null {
	const root = state.workspace?.root;
	const row = focused();
	const path = activePath();
	if (!root) notify("Open a folder first.");
	else if (row) return { entry: row, where: { home: row.path, follow: true } };
	else if (path && isInside(root, path)) return { entry: { name: baseName(path), path, kind: "file", size: 0 }, where: { follow: false } };
	else notify(`Nothing to ${verb}: put the keyboard on a row in the Explorer, or open a file from this folder.`);
	return null;
}

/** Renames a file named from elsewhere (a row of the Docs panel): the tree's own steps, asking and all. */
export const renameFile = (path: string) => act(RENAME, { path, name: baseName(path), kind: "file", size: 0 }, { follow: false });
/** Moves a file named from elsewhere to the trash, after asking. */
export const trashFile = (path: string) => act(TRASH, { path, name: baseName(path), kind: "file", size: 0 }, { follow: false });

/** Shows a file's or a folder's row in the Explorer, the folders above it opened, and puts the keyboard on it. */
export function showInExplorer(path: string) {
	const root = state.workspace?.root;
	if (!root || !isInside(root, path)) return notify("That file is not in this folder.");
	// If Explorer is scoped to a subfolder that doesn't contain `path` (or IS `path`), step back to the full workspace first.
	const scope = scopedFolder();
	if (scope && (canonical(path) === canonical(scope.path) || !isInside(scope.path, path))) setScopedFolder(null);
	const viewRoot = scopedFolder()?.path ?? root;
	// The folder itself has no row of its own: its rows are shown, and the keyboard goes where it last was among them.
	const top = isInside(path, viewRoot);
	const above: string[] = [];
	const viewRootCanon = canonical(viewRoot);
	for (let dir = dirName(path); !top && canonical(dir) !== viewRootCanon && isInside(viewRoot, dir); dir = dirName(dir)) above.push(dir);
	setExpanded((set) => new Set([...set, ...above]));
	setWsOpen(true);
	remember("explorer.workspace", "open");
	cancelExplorerFocusSearch();
	const seq = ++focusSearchSeq;
	showPanel("explorer");
	// The rows above it are read from the disk as they open: the row is looked for until it is there.
	let tries = 0;
	const look = () => {
		if (seq !== focusSearchSeq) return;
		focusSearchTimer = null;
		if (document.querySelector(`[data-panel="explorer"] [data-row${top ? "" : `="${CSS.escape(path)}"`}]`) || tries++ > 20) return void tree?.focus(top ? undefined : path);
		focusSearchTimer = setTimeout(look, 100);
	};
	look();
}

/** Opens Explorer focused directly on `folderPath` (e.g. a ticket bundle folder) with an easy back button to All files. */
export function browseFolderInExplorer(folderPath: string, label?: string) {
	const root = state.workspace?.root;
	if (!root || !isInside(root, folderPath)) return notify("That folder is not in this workspace.");
	setWsOpen(true);
	remember("explorer.workspace", "open");
	setScopedFolder({ path: folderPath, label });
	cancelExplorerFocusSearch();
	const seq = ++focusSearchSeq;
	showPanel("explorer");
	let tries = 0;
	const look = () => {
		if (seq !== focusSearchSeq) return;
		focusSearchTimer = null;
		if (document.querySelector(`[data-panel="explorer"] .explorer-scope-bar`) || tries++ > 20) {
			tree?.focus();
			return;
		}
		focusSearchTimer = setTimeout(look, 60);
	};
	look();
}

/** Command palette: a new file beside the focused row (inside it, for a folder), else beside the active file. */
export async function explorerNewFile(): Promise<void> {
	const root = state.workspace?.root;
	if (!root) return notify("Open a folder first.");
	const viewRoot = scopedFolder()?.path ?? root;
	const row = focused();
	const active = activePath();
	const scopedActive = active && isInside(viewRoot, active) ? active : null;
	const folder = folderFor(row, scopedActive, viewRoot);
	await act(NEW_FILE, { name: baseName(folder), path: folder, kind: "dir", size: 0 }, { home: row?.path, follow: false });
}

/** Command palette: rename the focused row, else the active file. */
export async function explorerRename(): Promise<void> {
	const on = target("rename");
	if (on) await act(RENAME, on.entry, on.where);
}

/** Command palette: move the focused row, else the active file, to the trash (after asking). */
export async function explorerDelete(): Promise<void> {
	const on = target("move to the trash");
	if (on) await act(TRASH, on.entry, on.where);
}

export function Explorer() {
	const activeRootPath = () => scopedFolder()?.path ?? state.workspace?.root ?? "";
	const activeRootName = () => scopedFolder()?.label ?? (scopedFolder() ? baseName(scopedFolder()!.path) : state.workspace?.name ?? "");
	const root = useListing(() => (activeRootPath() ? ([activeRootPath(), state.treeVersion] as const) : null));
	const read = () => Boolean(activeRootPath()) && root.path === activeRootPath();
	const rootMenu = (at: Point) => activeRootPath() && void entryMenu({ name: activeRootName(), path: activeRootPath(), kind: "dir", size: 0 }, at);
	// A row stays "the focused row" while a dialog, the palette, its own menu or the menu bar has the keyboard, and no longer.
	const forget = (e: FocusEvent) => !(e.target as Element | null)?.closest?.(".explorer, .overlay, .quickpick, .row-menu, .menubar") && setFocused(null);
	onMount(() => document.addEventListener("focusin", forget));
	// The folders that were open in this workspace are open again next time. A self-test starts from a closed tree.
	const keeps = () => !state.info?.selftest && !state.info?.selftestClose;
	createEffect(
		on(
			() => state.workspace?.root,
			(root) => {
				if (root !== lastWorkspaceRoot) {
					lastWorkspaceRoot = root;
					setClip(null);
				}
				const cur = scopedFolder();
				if (cur && (!root || !isInside(root, cur.path))) setScopedFolder(null);
				if (!root) {
					recalledFor = undefined;
					setExpanded(new Set<string>());
					return;
				}
				// Once for a workspace, not each time the panel comes back: what was opened while another panel was
				// showing (the folders above a file another panel asked to be shown here) is not shut again by the
				// panel's return. Folders opened before the first showing are kept beside the ones remembered.
				if (!keeps() || recalledFor === root) return;
				recalledFor = root;
				setExpanded((set) => new Set([...openFolders(recall(`tree:${root}`), root), ...[...set].filter((path) => isInside(root, path))]));
			},
		),
	);
	createEffect(() => {
		const root = state.workspace?.root;
		const open = [...expanded()];
		if (root && keeps()) remember(`tree:${root}`, JSON.stringify(open));
	});
	onCleanup(() => {
		document.removeEventListener("focusin", forget);
		cancelExplorerFocusSearch();
		setFocused(null);
		tree = undefined;
	});
	const [openEdOpen, setOpenEdOpen] = createSignal(recall("explorer.openEditors") !== "closed");
	const [openEdH, setOpenEdH] = createSignal(clampExplorerHeight(recall("explorer.openEditors.h"), OPEN_EDITORS_MIN_H, OPEN_EDITORS_MAX_H, 120));
	const toggleOpenEd = () => {
		const next = !openEdOpen();
		setOpenEdOpen(next);
		remember("explorer.openEditors", next ? "open" : "closed");
	};
	const openEdCap = () => Math.max(OPEN_EDITORS_MIN_H, openEditorRows().length * 26 + 16);
	const resizeOpenEd = (delta: number) => {
		const next = resizeOpenEditorsHeight(openEdH(), openEdCap(), delta);
		setOpenEdH(next);
		remember("explorer.openEditors.h", String(Math.round(next)));
	};
	const resetOpenEd = () => {
		setOpenEdH(120);
		remember("explorer.openEditors.h", "120");
	};

	const [outlineFilter, setOutlineFilter] = createSignal("");
	createEffect(() => {
		if (scopedFolder()) setWsOpen(true);
	});
	const toggleWs = () => {
		const next = !wsOpen();
		setWsOpen(next);
		if (!next) tree = undefined;
		remember("explorer.workspace", next ? "open" : "closed");
	};

	const [outlineOpen, setOutlineOpen] = createSignal(recall("explorer.outline") !== "closed");
	const [outlineH, setOutlineH] = createSignal(clampExplorerHeight(recall("explorer.outline.h"), 80, 480, 210));
	const toggleOutline = () => {
		const next = !outlineOpen();
		setOutlineOpen(next);
		remember("explorer.outline", next ? "open" : "closed");
	};
	const resizeOutline = (delta: number) => {
		const next = Math.max(80, Math.min(480, outlineH() - delta));
		setOutlineH(next);
		remember("explorer.outline.h", String(Math.round(next)));
	};
	const resetOutline = () => {
		setOutlineH(210);
		remember("explorer.outline.h", "210");
	};

	const openEditorRows = () =>
		state.groups.flatMap((g, groupIndex) =>
			g.tabs.map((path) => ({
				path,
				groupIndex,
				active: state.activeGroup === groupIndex && g.active === path && state.centerView === "editors",
				dirty: Boolean(state.dirty[path]),
				name: path.startsWith("untitled:") ? path.slice("untitled:".length) : baseName(path),
				folder: path.startsWith("untitled:") ? "" : (() => {
					const rel = state.workspace ? relativeTo(state.workspace.root, dirName(path)) : "";
					return rel === "." ? "" : rel;
				})(),
			})),
		);
	const anyDirty = () => Object.values(state.dirty).some(Boolean);
	const anyOpen = () => {
		const base = activeRootPath();
		if (!base) return false;
		if (!scopedFolder()) return expanded().size > 0;
		for (const p of expanded()) if (p !== base && isInside(base, p)) return true;
		return false;
	};
	const toggleAllFolders = () => {
		const base = activeRootPath();
		if (!base) return;
		if (anyOpen()) {
			if (!scopedFolder()) setExpanded(new Set<string>());
			else setExpanded((set) => new Set([...set].filter((p) => !isInside(base, p))));
		} else {
			const dirs = root.entries.filter((e) => e.kind === "dir").map((e) => e.path);
			setExpanded((set) => new Set([...set, ...dirs]));
		}
	};
	const newInTarget = (kind: "file" | "dir") => {
		const base = activeRootPath();
		if (!base) return;
		const row = focused();
		const targetRow = row && isInside(base, row.path) ? row : null;
		const folder = folderFor(targetRow, scopedFolder() ? null : activePath(), base);
		setWsOpen(true);
		void act(kind === "file" ? NEW_FILE : NEW_FOLDER, { name: baseName(folder), path: folder, kind: "dir", size: 0 }, { home: targetRow?.path, follow: false });
	};
	return (
		<div
			class="panel-body explorer"
			data-panel="explorer"
			classList={{ "drop-root": dropInto() !== null && dropInto() === activeRootPath() }}
			// Below the rows, or between them: the active root folder (workspace or scoped ticket folder).
			onDragOver={(e) => activeRootPath() && dragOver(e, activeRootPath())}
			onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropInto(null)}
			onDrop={(e) => activeRootPath() && void dropOn(e, activeRootPath())}
		>
			<div class="panel-title">
				<span>Explorer</span>
			</div>

			{/* VS Code-style Open Editors accordion section */}
			<section class="explorer-section explorer-open-editors" classList={{ open: openEdOpen() }} aria-label="Open editors">
				<div class="explorer-section-head">
					<button class="explorer-section-toggle" aria-expanded={openEdOpen()} onClick={toggleOpenEd}>
						<Icon name={openEdOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
						<span class="explorer-section-title">Open editors</span>
					</button>
					<div class="explorer-section-actions">
						<Show when={anyDirty()}>
							<IconButton label="Save all" title="Save all unsaved files" icon="save-all" onClick={() => void saveAll()} />
						</Show>
						<Show when={openEditorRows().length}>
							<IconButton label="Close all editors" title="Close all open editors" icon="close-all" onClick={() => void closeAllTabs()} />
						</Show>
					</div>
				</div>
				<Show when={openEdOpen()}>
					<div class="explorer-section-body" style={{ height: `${Math.min(openEdH(), openEdCap())}px` }}>
						<Show when={openEditorRows().length} fallback={<p class="hint explorer-empty-hint">No open editors.</p>}>
							<div class="tree explorer-open-list" role="list" aria-label="Open editors">
								<For each={openEditorRows()}>
									{(item) => {
										const activateOpenEditor = () => {
											closeComparison();
											if (state.bottomMaximized) setState("bottomMaximized", false);
											setState("centerView", "editors");
											setState("activeGroup", item.groupIndex);
											setState("groups", item.groupIndex, "active", item.path);
											focusEditor();
										};
										return (
											<div
												class="tree-row open-editor-row"
												role="listitem"
												tabindex={0}
												classList={{ selected: item.active, dirty: item.dirty }}
												title={isUntitled(item.path) ? `${item.name} (unsaved buffer)` : item.path}
												onClick={activateOpenEditor}
												onKeyDown={(e) => {
													if (e.target !== e.currentTarget) return;
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														activateOpenEditor();
													}
												}}
											>
												<button
													class="open-editor-close"
													title={`Close ${item.name}`}
													aria-label={`Close ${item.name}`}
													onClick={(e) => {
														e.stopPropagation();
														void closeTab(item.path, item.groupIndex);
													}}
												>
													<Show when={item.dirty} fallback={<Icon name="close" />}>
														<span class="open-editor-dot" aria-hidden="true" />
														<Icon name="close" class="open-editor-x" />
													</Show>
												</button>
												<FileMark name={item.name} />
												<span class="label">{item.name}</span>
												<Show when={item.folder}>
													<span class="meta open-editor-folder">{item.folder}</span>
												</Show>
											</div>
										);
									}}
								</For>
							</div>
						</Show>
					</div>
				</Show>
			</section>
			<Show when={openEdOpen() && openEditorRows().length > 0}>
				<SectionSplitter
					label="Height of Open editors"
					value={Math.min(openEdH(), openEdCap())}
					min={OPEN_EDITORS_MIN_H}
					max={OPEN_EDITORS_MAX_H}
					onDrag={resizeOpenEd}
					onReset={resetOpenEd}
				/>
			</Show>

			{/* Collapsible Workspace root section (or focused subfolder scope, e.g. a ticket bundle folder) */}
			<section class="explorer-section explorer-workspace" classList={{ open: wsOpen(), scoped: Boolean(scopedFolder()) }} aria-label={`Folder ${activeRootName()}`}>
				<div class="explorer-section-head">
					<button class="explorer-section-toggle" aria-expanded={wsOpen()} onClick={toggleWs}>
						<Icon name={wsOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
						<span class="explorer-section-title">{activeRootName()}</span>
					</button>
					<div class="explorer-section-actions">
						<IconButton label="New file" title="New file…" icon="new-file" onClick={() => newInTarget("file")} />
						<IconButton label="New folder" title="New folder…" icon="new-folder" onClick={() => newInTarget("dir")} />
						<IconButton label="Refresh explorer" title="Refresh" icon="refresh" onClick={refresh} />
						<IconButton
							label={anyOpen() ? "Collapse all folders" : "Expand top-level folders"}
							title={anyOpen() ? "Collapse all folders" : "Expand top-level folders"}
							icon={anyOpen() ? "collapse-all" : "expand-all"}
							onClick={toggleAllFolders}
						/>
					</div>
				</div>
				<Show when={scopedFolder()}>
					{(scope) => {
						const scopedTicket = () =>
							docs().find((d) => d.exists && d.group === "tickets" && d.ticketFolder && canonical(d.ticketFolder) === canonical(scope().path));
						const relScope = () => relativeTo(state.workspace?.root, scope().path).split("\\").join("/");
						return (
							<div class="explorer-scope-bar" role="region" aria-label={`Focused on ${activeRootName()}`}>
								<button
									type="button"
									class="explorer-scope-back"
									title="Back to full workspace folder"
									onClick={() => setScopedFolder(null)}
								>
									<Icon name="arrow-left" />
									<span>All files</span>
								</button>
								<span class="explorer-scope-path" title={scope().path}>
									{relScope()}/
								</span>
								<div class="explorer-scope-acts">
									<Show when={scopedTicket()}>
										{(t) => (
											<IconButton
												label={`Open ${t().ticket ?? t().name}`}
												title={`Open primary ticket ${t().ticket ?? t().name}`}
												icon="go-to-file"
												onClick={() => void openFile(t().path)}
											/>
										)}
									</Show>
									<IconButton
										label={`Search inside ${relScope()}`}
										title={`Search inside ${relScope()}/`}
										icon="search"
										onClick={() => findInFolder(relScope())}
									/>
								</div>
							</div>
						);
					}}
				</Show>
				<Show when={wsOpen()}>
					<div class="explorer-workspace-body">
						<Show when={!read()}>
							<p class="hint">Reading the folder…</p>
						</Show>
						<Show when={read() && !root.error && !root.entries.length}>
							<p class="hint">This folder is empty. Use New file above to add one.</p>
						</Show>
						<Rows
							role="tree"
							label={`Files in ${activeRootName() || "the workspace"}`}
							api={(rows) => (tree = rows)}
							onContextMenu={(e) => {
								e.preventDefault();
								rootMenu({ x: e.clientX, y: e.clientY });
							}}
						>
							<Listed listing={root} path={activeRootPath()} depth={0} />
						</Rows>
					</div>
				</Show>
			</section>

			{/* Resizable & collapsible Outline section with VS Code-style options menu + collapse/expand toggle */}
			<Show when={outlineOpen()}>
				<SectionSplitter
					label="Height of Outline"
					value={outlineH()}
					min={80}
					max={480}
					onDrag={resizeOutline}
					onReset={resetOutline}
				/>
			</Show>
			<section class="explorer-section explorer-outline" classList={{ open: outlineOpen() }} aria-label="Outline">
				<div class="explorer-section-head">
					<button class="explorer-section-toggle" aria-expanded={outlineOpen()} onClick={toggleOutline}>
						<Icon name={outlineOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
						<span class="explorer-section-title">Outline</span>
					</button>
					<div class="explorer-section-actions">
						<Menu floating label="Outline options" title="Outline options: follow cursor, sort order" class="outline-more" items={outlineMenuItems}>
							<Icon name="ellipsis" />
						</Menu>
						<Show when={outlineHasExpandable()}>
							<IconButton
								label={outlineAnyOpen() ? "Collapse all outline items" : "Expand all outline items"}
								title={outlineAnyOpen() ? "Collapse all" : "Expand all"}
								icon={outlineAnyOpen() ? "collapse-all" : "expand-all"}
								onClick={toggleOutlineCollapseAll}
							/>
						</Show>
					</div>
				</div>
				<Show when={outlineOpen()}>
					<div class="explorer-outline-body" style={{ height: `${outlineH()}px` }}>
						<input
							class="filter"
							aria-label="Filter outline"
							placeholder="Filter outline…"
							value={outlineFilter()}
							style={{ margin: "4px 8px 4px", "flex-shrink": "0" }}
							onInput={(e) => setOutlineFilter(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "ArrowDown" && focusRowsBelow(e.currentTarget)) e.preventDefault();
								else if (e.key === "Escape" && outlineFilter()) {
									e.preventDefault();
									setOutlineFilter("");
								}
							}}
						/>
						<SymbolOutline compact filter={outlineFilter()} label="Outline of the open file" />
					</div>
				</Show>
			</section>
		</div>
	);
}
