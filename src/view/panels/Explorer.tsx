// The workspace tree, loaded a folder at a time, with a size badge on files
// near or over the house size limit. What can be done to a file or a folder
// is on its menu (right-click, the menu key, Shift+F10), on F2 and Delete,
// on Ctrl+X, Ctrl+C and Ctrl+V, and in the command palette. A row dragged
// onto a folder is moved there, after asking.
import { Icon } from "../Icon";
import { FileMark } from "../FileMark";
import { batch, createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { Entry } from "../../shared/protocol";
import { level } from "../../shared/houseStyle";
import { backend } from "../backend";
import { ask, choose } from "../dialogs";
import { activePath, canonical, closeAllTabs, closeTab, fileRemoved, fileRenamed, heldFromBefore, isUntitled, notify, openFile, openToSide, saveAll, scriptsCameTo, setState, state } from "../state";
import { closeComparison } from "../editor/Review";
import { baseName, dirName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { COPY, COPY_NAME, COPY_PATH, COPY_RELATIVE, CUT, FIND_IN_FOLDER, folderFor, holdsRoot, menuEntriesFor, nameProblem, NEW_FILE, NEW_FOLDER, OPEN, OPEN_SIDE, openFolders, PASTE, RENAME, retarget, TRASH, without } from "./explorerMenu";
import { copyName, copyProblem, folderOf, moveProblem, type Clip } from "./explorerMoves";
import { chooseFromMenu } from "./RowMenu";
import { showPanel } from "./registry";
import { findInFolder } from "./Search";
import { catalogsKeptFor, followRename } from "../projectDocs";
import { IconButton, Row, Rows, type Point, type RowsApi } from "./Rows";
import { outlineAnyOpen, outlineHasExpandable, outlineMenuItems, SymbolOutline, toggleOutlineCollapseAll } from "./Objects";
import { SectionSplitter } from "./SectionSplitter";
import { Menu } from "../Menu";
import { recall, remember } from "../graph/canvas";

const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
const toggle = (path: string) =>
	setExpanded((set) => {
		const next = new Set(set);
		next.has(path) ? next.delete(path) : next.add(path);
		return next;
	});
/** The workspace whose open folders were last brought back from what was kept. */
let recalledFor: string | undefined;
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

async function rename(entry: Entry): Promise<string | null> {
	if (!state.workspace || holdsRoot(state.workspace.root, entry.path)) return notify("The workspace folder itself cannot be renamed from here.", "error"), null;
	const name = (await ask(`Rename ${entry.name}`, entry.name))?.trim();
	if (!name || name === entry.name) return null;
	const problem = nameProblem(name);
	if (problem) return notify(problem, "error"), null;
	const to = joinPath(dirName(entry.path), name);
	if (await heldFromBefore(to)) return null;
	await backend.rename(entry.path, to);
	// Open tabs follow the file, so saving one does not bring the old name back.
	fileRenamed(entry.path, to);
	setExpanded((set) => new Set(retarget(set, entry.path, to)));
	setClip((held) => held && { ...held, path: retarget([held.path], entry.path, to)[0]! });
	void scriptsCameTo(to, entry.path, entry.kind);
	const listed = changed(entry.path, to);
	// Documents that link to the old name are offered the new one. Not waited for: the row is renamed either way.
	void listed.then(() => followRename(entry.path, to));
	return to;
}

async function trash(entry: Entry): Promise<string | null> {
	if (!state.workspace || holdsRoot(state.workspace.root, entry.path)) return notify("The workspace folder itself cannot be moved to the trash from here.", "error"), null;
	const what = entry.kind === "dir" ? `the folder ${entry.name} and everything in it` : entry.name;
	if ((await choose(`Move ${what} to the trash?`, [TRASH], { danger: TRASH })) !== TRASH) return null;
	await backend.trash(entry.path);
	fileRemoved(entry.path);
	// What was cut or copied and is now in the trash is no longer there to paste.
	setClip((held) => (held && without([held.path], entry.path).length ? held : null));
	setExpanded((set) => new Set(without(set, entry.path)));
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
	await backend.rename(from.path, to);
	fileRenamed(from.path, to);
	setExpanded((set) => new Set([...retarget(set, from.path, to), into]));
	void scriptsCameTo(to, from.path, from.kind);
	// The catalog first, as in a rename: its own line for the file is written afresh, not asked about.
	void changed(from.path, to).then(() => followRename(from.path, to));
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
		if (action === NEW_FILE) back = await create(parent, "file");
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

/** A row is dragged over a folder: it may be let go there when it could be moved there. */
function dragOver(e: DragEvent, into: string) {
	const root = state.workspace?.root;
	if (!dragging || !root || moveProblem(dragging.path, into, root)) return setDropInto(null);
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	setDropInto(into);
}

async function dropOn(e: DragEvent, into: string) {
	const from = dragging;
	dragging = null;
	setDropInto(null);
	if (!from) return;
	e.preventDefault();
	try {
		const to = await moveInto(from, into, { ask: true });
		tree?.focus(to ?? from.path);
	} catch (error) {
		notify(errorText(error), "error");
	}
}

async function entryMenu(entry: Entry, at: Point) {
	const root = state.workspace?.root;
	if (!root) return;
	const isRoot = holdsRoot(root, entry.path);
	const action = await chooseFromMenu(isRoot ? "New in the workspace folder" : `Actions for ${entry.name}`, menuEntriesFor(entry.kind, entry.path, root, clip() !== null), at);
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
	// The folder itself has no row of its own: its rows are shown, and the keyboard goes where it last was among them.
	const top = isInside(path, root);
	const above: string[] = [];
	for (let dir = dirName(path); !top && dir !== root && isInside(root, dir); dir = dirName(dir)) above.push(dir);
	setExpanded((set) => new Set([...set, ...above]));
	showPanel("explorer");
	// The rows above it are read from the disk as they open: the row is looked for until it is there.
	let tries = 0;
	const look = () => {
		if (document.querySelector(`[data-panel="explorer"] [data-row${top ? "" : `="${CSS.escape(path)}"`}]`) || tries++ > 20) return void tree?.focus(top ? undefined : path);
		setTimeout(look, 100);
	};
	look();
}

/** Command palette: a new file beside the focused row (inside it, for a folder), else beside the active file. */
export async function explorerNewFile(): Promise<void> {
	const root = state.workspace?.root;
	if (!root) return notify("Open a folder first.");
	const row = focused();
	const folder = folderFor(row, activePath(), root);
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
	const root = useListing(() => state.workspace && ([state.workspace.root, state.treeVersion] as const));
	const read = () => root.path === state.workspace?.root;
	const rootMenu = (at: Point) => state.workspace && void entryMenu({ name: state.workspace.name, path: state.workspace.root, kind: "dir", size: 0 }, at);
	// A row stays "the focused row" while a dialog, the palette, its own menu or the menu bar has the keyboard, and no longer.
	const forget = (e: FocusEvent) => !(e.target as Element | null)?.closest?.(".explorer, .overlay, .quickpick, .row-menu, .menubar") && setFocused(null);
	onMount(() => document.addEventListener("focusin", forget));
	// The folders that were open in this workspace are open again next time. A self-test starts from a closed tree.
	const keeps = () => !state.info?.selftest && !state.info?.selftestClose;
	createEffect(
		on(
			() => state.workspace?.root,
			(root) => {
				// Once for a workspace, not each time the panel comes back: what was opened while another panel was
				// showing (the folders above a file another panel asked to be shown here) is not shut again by the
				// panel's return. Folders opened before the first showing are kept beside the ones remembered.
				if (!root || !keeps() || recalledFor === root) return;
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
		setFocused(null);
		tree = undefined;
	});
	const [openEdOpen, setOpenEdOpen] = createSignal(recall("explorer.openEditors") !== "closed");
	const savedOpenEdH = Number(recall("explorer.openEditors.h"));
	const [openEdH, setOpenEdH] = createSignal(Number.isFinite(savedOpenEdH) && savedOpenEdH >= 56 ? savedOpenEdH : 120);
	const toggleOpenEd = () => {
		const next = !openEdOpen();
		setOpenEdOpen(next);
		remember("explorer.openEditors", next ? "open" : "closed");
	};
	const resizeOpenEd = (delta: number) => {
		const next = Math.max(56, Math.min(360, openEdH() + delta));
		setOpenEdH(next);
		remember("explorer.openEditors.h", String(Math.round(next)));
	};
	const resetOpenEd = () => {
		setOpenEdH(120);
		remember("explorer.openEditors.h", "120");
	};

	const [wsOpen, setWsOpen] = createSignal(recall("explorer.workspace") !== "closed");
	const toggleWs = () => {
		const next = !wsOpen();
		setWsOpen(next);
		remember("explorer.workspace", next ? "open" : "closed");
	};

	const [outlineOpen, setOutlineOpen] = createSignal(recall("explorer.outline") !== "closed");
	const savedOutlineH = Number(recall("explorer.outline.h"));
	const [outlineH, setOutlineH] = createSignal(Number.isFinite(savedOutlineH) && savedOutlineH >= 80 ? savedOutlineH : 210);
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
	const anyOpen = () => expanded().size > 0;
	const toggleAllFolders = () => {
		if (anyOpen()) setExpanded(new Set<string>());
		else setExpanded(new Set(root.entries.filter((e) => e.kind === "dir").map((e) => e.path)));
	};
	const newInTarget = (kind: "file" | "dir") => {
		const wsRoot = state.workspace?.root;
		if (!wsRoot) return;
		const folder = folderFor(focused(), activePath(), wsRoot);
		setWsOpen(true);
		void act(kind === "file" ? NEW_FILE : NEW_FOLDER, { name: baseName(folder), path: folder, kind: "dir", size: 0 }, { home: focused()?.path, follow: false });
	};
	return (
		<div
			class="panel-body explorer"
			data-panel="explorer"
			classList={{ "drop-root": dropInto() !== null && dropInto() === state.workspace?.root }}
			// Below the rows, or between them: the workspace folder itself.
			onDragOver={(e) => state.workspace && dragOver(e, state.workspace.root)}
			onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropInto(null)}
			onDrop={(e) => state.workspace && void dropOn(e, state.workspace.root)}
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
					<div class="explorer-section-body" style={{ height: `${Math.min(openEdH(), Math.max(44, openEditorRows().length * 26 + 16))}px` }}>
						<Show when={openEditorRows().length} fallback={<p class="hint explorer-empty-hint">No open editors.</p>}>
							<div class="tree explorer-open-list" role="list" aria-label="Open editors">
								<For each={openEditorRows()}>
									{(item) => (
										<div
											class="tree-row open-editor-row"
											role="listitem"
											classList={{ selected: item.active, dirty: item.dirty }}
											title={isUntitled(item.path) ? `${item.name} (unsaved buffer)` : item.path}
											onClick={() => {
												closeComparison();
												setState("centerView", "editors");
												setState("activeGroup", item.groupIndex);
												setState("groups", item.groupIndex, "active", item.path);
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
									)}
								</For>
							</div>
						</Show>
					</div>
				</Show>
			</section>
			<Show when={openEdOpen() && openEditorRows().length > 0}>
				<SectionSplitter
					label="Height of Open editors"
					value={openEdH()}
					min={56}
					max={360}
					onDrag={resizeOpenEd}
					onReset={resetOpenEd}
				/>
			</Show>

			{/* Collapsible Workspace root section (architected for future multi-root workspace support) */}
			<section class="explorer-section explorer-workspace" classList={{ open: wsOpen() }} aria-label={`Workspace ${state.workspace?.name ?? ""}`}>
				<div class="explorer-section-head">
					<button class="explorer-section-toggle" aria-expanded={wsOpen()} onClick={toggleWs}>
						<Icon name={wsOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
						<span class="explorer-section-title">{state.workspace?.name}</span>
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
							label={`Files in ${state.workspace?.name ?? "the workspace"}`}
							api={(rows) => (tree = rows)}
							onContextMenu={(e) => {
								e.preventDefault();
								rootMenu({ x: e.clientX, y: e.clientY });
							}}
						>
							<Listed listing={root} path={state.workspace?.root ?? ""} depth={0} />
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
						<SymbolOutline compact label="Outline of the open file" />
					</div>
				</Show>
			</section>
		</div>
	);
}
