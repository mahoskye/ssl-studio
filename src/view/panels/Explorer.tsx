// The workspace tree, loaded a folder at a time, with a size badge on files
// near or over the house size limit. What can be done to a file or a folder
// is on its menu (right-click, the menu key, Shift+F10), on F2 and Delete,
// and in the command palette.
import { FileMark } from "../FileMark";
import { batch, createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { Entry } from "../../shared/protocol";
import { level } from "../../shared/houseStyle";
import { backend } from "../backend";
import { ask, choose } from "../dialogs";
import { activePath, canonical, fileRemoved, fileRenamed, notify, openFile, setState, state } from "../state";
import { baseName, dirName, isInside, joinPath } from "../../shared/paths";
import { folderFor, holdsRoot, menuFor, nameProblem, NEW_FILE, NEW_FOLDER, openFolders, RENAME, retarget, TRASH, without } from "./explorerMenu";
import { chooseFromMenu } from "./RowMenu";
import { IconButton, Row, Rows, type Point, type RowsApi } from "./Rows";
import { recall, remember } from "../graph/canvas";

const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
const toggle = (path: string) =>
	setExpanded((set) => {
		const next = new Set(set);
		next.has(path) ? next.delete(path) : next.add(path);
		return next;
	});
/** The row the keyboard is on, for the palette's commands. Forgotten once focus goes to work somewhere else. */
const [focused, setFocused] = createSignal<Entry | null>(null);
/** The tree on screen, to put the keyboard back in after a dialog. */
let tree: RowsApi | undefined;

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const indent = (depth: number) => ({ "padding-left": `${8 + depth * 14}px` });
const refresh = () => setState("treeVersion", (v) => v + 1);
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
					<span class="label">This folder could not be read: {props.listing.error}. Press Enter here, or ⟳ above, to try again.</span>
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
	return (
		<>
			<Row
				role="treeitem"
				key={props.entry.path}
				level={props.depth + 1}
				expanded={isDir() ? open() : undefined}
				selected={selected()}
				classList={{ selected: selected() }}
				style={indent(props.depth)}
				title={props.entry.path}
				onActivate={() => (isDir() ? toggle(props.entry.path) : void openFile(props.entry.path))}
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
					{isDir() ? (open() ? "▾" : "▸") : ""}
				</span>
				<FileMark name={props.entry.name} folder={isDir() ? { open: open() } : undefined} />
				<span class="label">{props.entry.name}</span>
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
	await backend.create(path, kind);
	setExpanded((set) => new Set(set).add(parent));
	refresh();
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
	await backend.rename(entry.path, to);
	// Open tabs follow the file, so saving one does not bring the old name back.
	fileRenamed(entry.path, to);
	setExpanded((set) => new Set(retarget(set, entry.path, to)));
	refresh();
	return to;
}

async function trash(entry: Entry): Promise<string | null> {
	if (!state.workspace || holdsRoot(state.workspace.root, entry.path)) return notify("The workspace folder itself cannot be moved to the trash from here.", "error"), null;
	const what = entry.kind === "dir" ? `the folder ${entry.name} and everything in it` : entry.name;
	if ((await choose(`Move ${what} to the trash?`, [TRASH], { danger: TRASH })) !== TRASH) return null;
	await backend.trash(entry.path);
	fileRemoved(entry.path);
	setExpanded((set) => new Set(without(set, entry.path)));
	refresh();
	// Its row is going: the keyboard lands on the row that takes its place.
	return "";
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
		if (action === NEW_FILE) back = await create(parent, "file");
		else if (action === NEW_FOLDER) back = await create(parent, "dir");
		else if (action === RENAME) back = await rename(entry);
		else if (action === TRASH) back = await trash(entry);
		else return;
	} catch (e) {
		notify(errorText(e), "error");
	}
	// A new file opens in the editor, which takes the keyboard itself.
	const to = back === null ? where.home : where.follow && action !== NEW_FILE ? back : undefined;
	if (to !== undefined) tree?.focus(to);
}

async function entryMenu(entry: Entry, at: Point) {
	const root = state.workspace?.root;
	if (!root) return;
	const isRoot = holdsRoot(root, entry.path);
	const action = await chooseFromMenu(isRoot ? "New in the workspace folder" : `Actions for ${entry.name}`, menuFor(entry.kind, entry.path, root), at);
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
	// A row stays "the focused row" while a dialog, the palette or its own menu has the keyboard, and no longer.
	const forget = (e: FocusEvent) => !(e.target as Element | null)?.closest?.(".explorer, .overlay, .quickpick, .row-menu") && setFocused(null);
	onMount(() => document.addEventListener("focusin", forget));
	// The folders that were open in this workspace are open again next time. A self-test starts from a closed tree.
	const keeps = () => !state.info?.selftest && !state.info?.selftestClose;
	createEffect(
		on(
			() => state.workspace?.root,
			(root) => {
				if (!root || !keeps()) return;
				setExpanded(new Set(openFolders(recall(`tree:${root}`), root)));
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
	return (
		<div class="panel-body explorer" data-panel="explorer">
			<div class="panel-title">
				<span>{state.workspace?.name}</span>
				<IconButton
					label="New file or folder"
					glyph="＋"
					menu
					onClick={(e) => {
						const box = e.currentTarget.getBoundingClientRect();
						rootMenu({ x: box.left, y: box.bottom });
					}}
				/>
				<IconButton label="Refresh the file list" title="Refresh" glyph="⟳" onClick={refresh} />
			</div>
			<Show when={!read()}>
				<p class="hint">Reading the folder…</p>
			</Show>
			<Show when={read() && !root.error && !root.entries.length}>
				<p class="hint">This folder is empty. Use ＋ to add a file or a folder.</p>
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
	);
}
