// App state: the workspace, open documents, editor groups and panels.
// Documents are Monaco models; the text in them is the source of truth
// (ADR 0002).
import { createSignal, createStore, flush, onFlush, reconcile, snapshot } from "solid-js";
import { DEFAULT_SETTINGS, type Info, type KeptText, type LspState, type Project, type Settings, type SettingsPatch, type ThemeFile, type Workspace } from "../shared/protocol";
import { backend, on } from "./backend";
import { removeRecentGroup, resetRecentTabs } from "./recentTabs";
import { monaco } from "./editor/monaco";
import { languageFor, setFormattingHost } from "./editor/languages";
import { DEFAULT_SQL_DIALECT, isSqlLanguage } from "../shared/format";
import { isDataSourceName } from "../shared/lexicalTokens";
import { sqlBodyStart } from "../shared/sqlDataSource";
import { getPath, SERVER_DEFAULTS } from "../shared/styleProfile";
import { session } from "./lsp/session";
import { changedRanges, minimalReplace } from "./lsp/edits";
import { ask, choose } from "./dialogs";
import { closeComparison, closeReview, openReview } from "./editor/Review";
import { syncWorkspaceThreads } from "./agent/store";
import { resetTidy } from "./agent/tidy";
import { clearEditorViewStates } from "./editor/EditorGroup";
import { invalidateImageCache } from "./editor/imageResolve";
import { baseName, isInside, joinPath, plainFileError } from "../shared/paths";
import { lineEnds } from "../shared/fileKind";
import { tableTextToWrite } from "../shared/csv";
import { isPlanPath } from "./plan/model";
import { recheckPlans, trackPlan } from "./plan/check";
import { trackDoc, trackJson, trackToml, trackXml } from "./docCheck";
import { recall, remember } from "./graph/canvas";
import { packTabs, packViews, tabsKey, unpackTabs, unpackViews, viewsKey } from "./editor/sessionTabs";
import { movedAcross, othersOf, placed, previewed, rightOf, withPin } from "../shared/tabOrder";
import {
	MARKDOWN_MODE_KEY,
	PLAN_MODE_KEY,
	TABLE_TEXT_MODE_KEY,
	parseMarkdownViewMode,
	parsePlanViewMode,
	parseTableTextMode,
	resolveMarkdownMode,
	resolvePlanMode,
	resolveTableTextMode,
	shouldUpdateDefaultMode,
	type MarkdownViewMode,
	type PlanViewMode,
} from "../shared/viewModes";

export type { MarkdownViewMode, PlanViewMode };

export type Group = {
	tabs: string[];
	active: string | null;
	mode?: "text" | "blocks";
	/** Per-group Markdown view mode (maintained by file type across all Markdown tabs in the group). */
	mdMode?: MarkdownViewMode;
	/** Per-group Plan view mode (maintained by file type across all Plan tabs in the group). */
	planMode?: PlanViewMode;
	/** Per-group CSV/TSV table text mode (maintained by file type across all tabular tabs in the group). */
	tableText?: boolean;
	/** The tabs that stay: first in the row, and not closed with the others. */
	pinned?: string[];
	/** The tab opened for a look (one click in a list): the next such file takes its place. Shown in italics. */
	preview?: string | null;
};
export type PanelId = "explorer" | "objects" | "palette" | "reference" | "search" | "history" | "health" | "agent" | "docs" | "git";
/** @deprecated names kept for readers: both sides hold any panel. */
export type LeftView = PanelId;
export type RightView = PanelId;
export type BottomView = "problems" | "output";
export type Message = { id: number; kind: "info" | "error"; text: string; action?: { label: string; run: () => void } };
/** What "Save" was able to do: a caller that goes on to close or discard must check it. */
export type Saved = boolean;

type Doc = {
	path: string;
	model: monaco.editor.ITextModel;
	savedVersion: number;
	savedText: string;
	mtime: number;
	/** What the file's text is written in, as the backend read it. */
	encoding?: string;
	/** The file is not text: a picture, or other bytes. Its model is empty, is never shown and is never saved. */
	binary?: { size: number; image?: string };
	/** Stops any active non-SSL document validator (plan/doc/json/toml/xml) on language switch or dispose. */
	validatorDispose?: () => void;
	/** Of a data source read as SQL: the line (from 0) its SQL starts on (ADR 0038). Not set for one that is SSL. */
	sqlBodyLine?: number;
	/** The language mode was chosen by hand. Nothing changes it then but another choice. */
	languageChosen?: boolean;
};

const [state, setStore] = createStore({
	workspace: null as Workspace | null,
	/** The open folder's project settings; null until a folder is open. */
	project: null as Project | null,
	/** The "set up project" offer was turned down for this folder. */
	setupDismissed: false,
	info: null as Info | null,
	lsp: { state: "stopped" } as LspState,
	settings: structuredClone(DEFAULT_SETTINGS) as Settings,
	themes: [] as ThemeFile[],
	groups: [{ tabs: [], active: null }] as Group[],
	activeGroup: 0,
	dirty: {} as Record<string, boolean>,
	/** Files changed on disk while open with unsaved edits. */
	conflicts: {} as Record<string, boolean>,
	leftView: "explorer" as LeftView,
	bottomView: "problems" as BottomView,
	bottomMaximized: false,
	rightView: "health" as RightView,
	centerView: "editors" as "editors" | "graph" | "welcome",
	/** Persisted default Plan view mode (Source | Text | Chart), shared across all Plan documents. */
	planViewMode: parsePlanViewMode(recall(PLAN_MODE_KEY)) as PlanViewMode | null,
	/** Persisted default CSV/TSV view mode (`true` = Text, `false` = Table), shared across all tabular files. */
	tableTextDefault: parseTableTextMode(recall(TABLE_TEXT_MODE_KEY)) as boolean | null,
	/** Persisted default Markdown view mode (Source | Live | Read), shared across all Markdown documents. */
	mdViewMode: parseMarkdownViewMode(recall(MARKDOWN_MODE_KEY)) as MarkdownViewMode | null,
	messages: [] as Message[],
	output: [] as string[],
	cursor: { line: 1, column: 1 },
	/** Bumped when the tree should reload a folder. */
	treeVersion: 0,
	quickPick: null as null | "files" | "commands" | "symbols" | "outline",
	/** Counts up when an open file turns out to be text where it was not, or the other way round, or a picture changed on disk: what shows it looks again. */
	kindVersion: 0,
});

const docs = new Map<string, Doc>();
export const documents = docs;

let nextMessage = 1;
/**
 * A passing note goes away by itself. An error stays until it is dismissed,
 * and is written to Output, so it can be read again and copied.
 */
export function notify(text: string, kind: Message["kind"] = "info", action?: Message["action"]) {
	const id = nextMessage++;
	// The log keeps what was said; the note says it as a person would, with the path as the project names it.
	if (kind === "error") {
		log(`error: ${text}`);
		text = plainFileError(text, snapshot(state).workspace?.root);
	}
	setState((s) => {
		s.messages = [...s.messages.filter((m) => m.text !== text).slice(-4), { id, kind, text, action }];
	});
	// A note that offers something to do stays long enough to do it.
	if (kind !== "error") setTimeout(() => dismiss(id), action ? 20000 : 4000);
}

export const dismiss = (id: number) =>
	setState((s) => {
		s.messages = s.messages.filter((m) => m.id !== id);
	});

export function log(line: string) {
	setState((s) => {
		s.output = [...s.output.slice(-499), `${new Date().toLocaleTimeString()}  ${line}`];
	});
}

/** Asks the editor, or the open side panel, to take the keyboard. */
export const focusRequest = (() => {
	const listeners = new Set<(target: "editor" | "side") => void>();
	return {
		fire: (target: "editor" | "side") => listeners.forEach((l) => l(target)),
		listen: (l: (target: "editor" | "side") => void) => (listeners.add(l), () => listeners.delete(l)),
	};
})();
export const focusEditor = () => focusRequest.fire("editor");
export const focusSidePanel = () => {
	const cur = snapshot(state);
	if (!cur.workspace) return;
	if (!cur.settings.layout.left) setState((s) => { s.settings.layout.left = true; });
	focusRequest.fire("side");
};

export const activePath = () => state.groups[state.activeGroup]?.active ?? null;
export const activeDoc = () => {
	const path = activePath();
	return path ? docs.get(path) : undefined;
};

async function guarded<T>(work: () => Promise<T>): Promise<T | undefined> {
	try {
		return await work();
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
		return undefined;
	}
}

// --- workspace -------------------------------------------------------------

/** Files with edits that are not on disk (reactive). */
export const unsavedPaths = () => Object.keys(state.dirty).filter((path) => state.dirty[path]);

/** Files with edits that are not on disk (unflushed snapshot, for imperative guards and saves). */
export const snapshotUnsavedPaths = () => {
	const dirty = snapshot(state).dirty;
	return Object.keys(dirty).filter((path) => dirty[path]);
};

/** The views that keep typed text outside the document, each by how it puts that text in, with how it says whether it has any (where it can). */
const pendingEdits = new Map<() => void, (() => boolean) | undefined>();
/** Whether the backend was last told that such a view may have text now. */
let holdingTold = false;

/**
 * Tells the backend whether a view is there that may hold text still being typed. The desktop window closes on the
 * backend's own count of unsaved files, and what is typed in an open cell is in no file yet: with nothing else
 * unsaved the count was 0, the window closed at once, and the text went with it, unasked. Told that such a view is
 * there, the backend asks the view first (`closeRequested`, below), which puts the text in its document and counts
 * then. With no such view the window closes on the count as before. A view that does not say whether it has text
 * (`typed`) is taken to have some for as long as it is there: asked for nothing, the view answers at once.
 */
function tellHolding() {
	let holding = false;
	for (const typed of pendingEdits.values()) {
		try {
			if (!typed || typed()) holding = true;
		} catch {
			holding = true;
		}
		if (holding) break;
	}
	if (holding === holdingTold) return;
	holdingTold = holding;
	void backend.typingChanged(holding).catch(() => undefined);
}

// A view that says whether it has typed text is asked again after what can change the answer: a key, text put in a
// field, a field left. A moment after, when the view has heard of it too.
let holdingAsked = false;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	const askAgain = () => {
		if (holdingAsked || ![...pendingEdits.values()].some(Boolean)) return;
		holdingAsked = true;
		setTimeout(() => {
			holdingAsked = false;
			tellHolding();
		}, 0);
	};
	for (const type of ["keydown", "input", "focusout"]) window.addEventListener(type, askAgain, true);
}

/**
 * A view that keeps what is being typed outside the document until it is committed (a table's open cell) says
 * here how to put it in, and with `typed`, where it can, whether it has any such text now. Returns how to take that
 * back, for when the view goes.
 */
export function holdsPendingEdit(commit: () => void, typed?: () => boolean): () => void {
	pendingEdits.set(commit, typed);
	tellHolding();
	return () => {
		pendingEdits.delete(commit);
		tellHolding();
	};
}

/**
 * Puts what is still being typed in such a view into its document. Before a save, a close of a tab, and the
 * question about unsaved changes: the document does not have the text until then, so a save wrote the file
 * without it, and a close found nothing unsaved, asked nothing, and dropped it.
 */
export function commitPendingEdits() {
	for (const commit of [...pendingEdits.keys()]) {
		try {
			commit();
		} catch (e) {
			log(`what was being typed could not be put in the document: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	// What was typed is in its document now: a view that says so is no longer one the window waits for.
	tellHolding();
}

/** What each group shows: its tab, and the view that tab is in. When it changes, the view that was there is taken away. */
const shownIn = (s: typeof state) => `${s.centerView}\n${s.groups.map((g) => [g.active, g.mode, g.mdMode, g.planMode, g.tableText].join("\t")).join("\n")}`;

export { state };

/**
 * Changes the app's state. A change of what a group shows (another tab, another view of the same file, another
 * centre view) puts what is still being typed there into its document: the view is taken away with the
 * change, and the text was only in its field. The step by Ctrl+PageDown did this itself, and every other way of
 * leaving a tab did not: Ctrl+Tab, a click on another tab, Go back, a new file, Table to Text. Each lost the
 * text without a word, and the document was not marked unsaved. It is done here, for every way there is or will
 * be, and before the views are drawn again: the view that held the text is still there to hand it over.
 */
export const setState: typeof setStore = ((change: (s: typeof state) => unknown) => {
	let leaves = false;
	(setStore as (change: (s: typeof state) => unknown) => void)((s) => {
		const before = shownIn(s);
		const result = change(s);
		leaves = shownIn(s) !== before;
		return result;
	});
	if (leaves) commitPendingEdits();
}) as typeof setStore;

/**
 * Before anything that would drop every open document. Says whether to go on:
 * nothing unsaved, everything saved, or the user chose to discard.
 */
export async function settleUnsaved(what: string): Promise<boolean> {
	commitPendingEdits();
	const unsaved = snapshotUnsavedPaths();
	if (!unsaved.length) return true;
	// By the name on its tab: a document with no file yet is "Untitled-1", not the path the app knows it by.
	const names = namesOf(unsaved);
	const answer = await choose(`${unsaved.length === 1 ? "1 file has" : `${unsaved.length} files have`} unsaved changes (${names}). ${what}`, ["Save all", "Discard changes"], { danger: "Discard changes" });
	if (answer === "Save all") return saveAll();
	return answer === "Discard changes";
}

// --- unsaved text, kept while the folder is not open (ADR 0042) ---------------------

/** How long after a change a document's unsaved text is kept, in milliseconds: a second, as VS Code has it. */
export const KEEP_AFTER = 1000;
/**
 * Which text of each document the backend was last given to keep, as the document's version then, with the file
 * as those edits found it: for the open folder. What is asked to be kept is only what has changed since, and what
 * was kept for a document that is no longer unsaved is asked to be forgotten. The version is one document's own:
 * a file closed and opened again is another document, whose versions count from the start again.
 */
const keptVersions = new Map<string, { model: monaco.editor.ITextModel; version: number }>();
/** Whether the backend has this document's text as it is now. */
const isKept = (path: string) => {
	const doc = docs.get(path);
	const was = keptVersions.get(path);
	return Boolean(doc && was && was.model === doc.model && was.version === doc.model.getAlternativeVersionId());
};
const keptBases = new Map<string, { text: string; mtime: number }>();
/** Counts the folders opened: what a keep learned of one folder is not put on record for the next. */
let keptEpoch = 0;
/** The unsaved text kept for the open folder that no document has taken up yet, by path (restoreTabs). */
const keptPending = new Map<string, KeptText>();
/** The keep that is waiting to be asked for, and when it is due. */
let keepTimer: ReturnType<typeof setTimeout> | undefined;
let keepDue = 0;
/** The keeps asked for, one after another: each reads the documents as they are when its turn comes. */
let keeping: Promise<unknown> = Promise.resolve();

/** No record of anything kept: the folder is another, and what was kept was that folder's. (Exported for the tests.) */
export function forgetKeptRecord() {
	keptEpoch++;
	keptVersions.clear();
	keptBases.clear();
	keptPending.clear();
	clearTimeout(keepTimer);
	keepTimer = undefined;
}

/** What there is to keep and to forget just now, with what the record of it would then be. Null with nothing to do. */
function unsavedToKeep(skip?: (path: string) => boolean) {
	const cur = snapshot(state);
	const root = cur.workspace?.root;
	if (!root) return null;
	const keep: KeptText[] = [];
	const versions = new Map<string, { model: monaco.editor.ITextModel; version: number }>();
	const bases = new Map<string, { text: string; mtime: number }>();
	for (const path of snapshotUnsavedPaths()) {
		const doc = docs.get(path);
		if (!doc || doc.model.isDisposed() || doc.binary || skip?.(path)) continue;
		const base = keptBases.get(path);
		const sameBase = isUntitled(path) || (base !== undefined && base.mtime === doc.mtime && base.text === doc.savedText);
		if (isKept(path) && sameBase) continue;
		versions.set(path, { model: doc.model, version: doc.model.getAlternativeVersionId() });
		const text = doc.model.getValue();
		if (isUntitled(path)) keep.push({ path, text, language: doc.model.getLanguageId() });
		else {
			// The file as these edits found it goes along once: the backend keeps it with the text until it is told another.
			bases.set(path, { text: doc.savedText, mtime: doc.mtime });
			keep.push(sameBase ? { path, text } : { path, text, saved: { text: doc.savedText, mtime: doc.mtime } });
		}
	}
	const drop = [...keptVersions.keys()].filter((path) => !cur.dirty[path] || !docs.has(path) || skip?.(path));
	return keep.length || drop.length ? { root, keep, drop, versions, bases } : null;
}

/**
 * Has the backend keep the text of every document that is unsaved, as it is now, and forget what it kept for those
 * that no longer are. Answers null when all of it is kept, and else why it is not. `skip` names documents whose
 * text is not to be kept and is forgotten: those the user has just chosen to discard.
 */
export function keepUnsaved(skip?: (path: string) => boolean): Promise<string | null> {
	clearTimeout(keepTimer);
	keepTimer = undefined;
	const run = async (): Promise<string | null> => {
		const todo = unsavedToKeep(skip);
		if (!todo) return null;
		const epoch = keptEpoch;
		try {
			await backend.unsavedKeep(todo.root, todo.keep, todo.drop);
		} catch (e: any) {
			return String(e?.message ?? e);
		}
		if (epoch === keptEpoch) {
			for (const path of todo.drop) {
				keptVersions.delete(path);
				keptBases.delete(path);
			}
			for (const [path, version] of todo.versions) keptVersions.set(path, version);
			for (const [path, base] of todo.bases) keptBases.set(path, base);
		}
		return null;
	};
	const done = keeping.then(run, run);
	keeping = done.catch(() => undefined);
	return done;
}

/**
 * Asks for the unsaved text to be kept a moment from now. A change to a document asks for it within the second,
 * and a further change does not put that off: however long the typing goes on, what a crash can take is the last
 * second of it. `after` 0 is for when other files are unsaved than before (one saved, one discarded): at once.
 */
export function keepUnsavedSoon(after = KEEP_AFTER) {
	const due = Date.now() + after;
	if (keepTimer !== undefined) {
		if (due >= keepDue) return;
		clearTimeout(keepTimer);
	}
	keepDue = due;
	keepTimer = setTimeout(() => {
		keepTimer = undefined;
		void keepUnsaved();
	}, after);
}

/**
 * As the page goes (a reload, a browser tab closed): what is unsaved is sent to be kept, now, without waiting for
 * a keep that is under way, since nothing after this is sure to run. Nothing is asked: the text comes back with
 * the folder (ADR 0042).
 */
export function keepUnsavedOnLeave() {
	commitPendingEdits();
	const todo = unsavedToKeep();
	if (todo) void backend.unsavedKeep(todo.root, todo.keep, todo.drop).catch(() => undefined);
}

/**
 * Before the folder is left with every open document in it (the window closing, another folder opened): what is
 * unsaved is kept for when the folder is opened again, and nothing is asked (ADR 0042). Only where it could not
 * be kept is the question of ADR 0009 asked, since going on would then lose it. Says whether to go on.
 */
export async function leaveUnsavedKept(what: string): Promise<boolean> {
	commitPendingEdits();
	if ((await keepUnsaved()) === null) return true;
	if (!(await settleUnsaved(`They could not be kept for next time. ${what}`))) return false;
	// Saved, or given up: what was kept of them before the keeping failed is not to come back as unsaved. Asked
	// for as it can be: where the folder cannot be written, it cannot be cleared either.
	const givenUp = new Set(snapshotUnsavedPaths());
	await keepUnsaved((path) => givenUp.has(path));
	return true;
}

/** The names of a few files, and how many more there are. */
const namesOf = (paths: readonly string[]) => paths.slice(0, 3).map(displayName).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");

let openSeq = 0;

type KeptForFolder = { root: string; write: () => unknown; timer: ReturnType<typeof setTimeout> | undefined };
/** What is waiting to be written for the open folder (keepForFolder). */
const keptForFolder = new Set<KeptForFolder>();
/** How many folders are being opened just now, and what waits to see which folder that leaves open. */
let foldersOpening = 0;
const afterFolderOpened: (() => void)[] = [];

/**
 * Asks for something to be written for the open folder a moment from now, once: the window's layout, which is
 * saved a little after it stops changing (App.tsx). Answers with how to call it off, for when a newer one is
 * asked for. The backend writes into the folder it is in itself, and it is in the next folder before the view has
 * heard that the folder was opened: sent from a plain timer in that gap, the layout of the folder being left was
 * written into the settings of the one being opened. So `write` runs only while its folder is the open one, here
 * and in the backend. Opening another folder writes it first, while the backend is still in this one
 * (openFolder), and one that comes due while a folder is being opened waits to see which folder is left open:
 * its own, and it is written; another, and it is dropped.
 */
export function keepForFolder(root: string, write: () => unknown, after = 600): () => void {
	const kept: KeptForFolder = { root, write, timer: undefined };
	const due = () => {
		kept.timer = undefined;
		if (!keptForFolder.has(kept)) return;
		if (foldersOpening) return void afterFolderOpened.push(due);
		keptForFolder.delete(kept);
		if (snapshot(state).workspace?.root === root) void writeKept(kept);
	};
	kept.timer = setTimeout(due, after);
	keptForFolder.add(kept);
	return () => {
		clearTimeout(kept.timer);
		keptForFolder.delete(kept);
	};
}

/** Runs one such write to its end. A write says its own failures; one that throws all the same is kept in Output. */
async function writeKept(kept: KeptForFolder) {
	try {
		await kept.write();
	} catch (e) {
		log(`what is kept for ${baseName(kept.root)} could not be written: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Writes now what is waiting to be written for the open folder, and answers when all of it has been: asked before
 * the backend is sent to another folder. Nothing when nothing waits. What already waits on another folder being
 * opened stays waiting: the backend may no longer be in its folder.
 */
function writeKeptForFolder(): Promise<void> | undefined {
	const root = snapshot(state).workspace?.root;
	const waiting = [...keptForFolder].filter((kept) => kept.timer !== undefined);
	if (!waiting.length) return undefined;
	for (const kept of waiting) {
		clearTimeout(kept.timer);
		keptForFolder.delete(kept);
	}
	return Promise.all(waiting.filter((kept) => kept.root === root).map(writeKept)).then(() => {});
}

export async function openFolder(path?: string) {
	// Leaving a folder asks nothing: what is unsaved in it is kept, and comes back when it is opened again (ADR 0042).
	if (!(await leaveUnsavedKept("Opening another folder closes them."))) return;
	// What is unsaved here and not kept by now was asked about and is to be dropped, as it stands now (see below).
	const versionOf = (path: string) => docs.get(path)?.model.getAlternativeVersionId();
	const droppedByChoice = new Map(
		snapshotUnsavedPaths()
			.filter((path) => !isKept(path))
			.map((path) => [path, versionOf(path)]),
	);
	const seq = ++openSeq;
	// From here until the folder is open, or the opening is called off, nothing kept for a folder is sent on its
	// own (keepForFolder): what waits is written now, while the backend is still in this folder.
	foldersOpening++;
	try {
		const written = writeKeptForFolder();
		if (written) await written;
		// Another folder was asked for while that was written: its own opening goes on, and this one is dropped.
		if (seq === openSeq) await switchFolder(path, seq, droppedByChoice, versionOf);
	} finally {
		if (!--foldersOpening) for (const due of afterFolderOpened.splice(0)) due();
	}
}

/** The rest of openFolder: sends the backend to the folder, and makes it the view's. */
async function switchFolder(path: string | undefined, seq: number, droppedByChoice: Map<string, number | undefined>, versionOf: (path: string) => number | undefined) {
	const curBeforeOpen = snapshot(state);
	const prevRoot = curBeforeOpen.workspace?.root ?? null;
	const prevLspRunning = curBeforeOpen.lsp.state === "running";
	// Clear prior LSP session state before the backend restarts the server for the new folder,
	// so an early `lspState: running` notification cannot re-initialize against the old root.
	session.reset();
	const workspace = await guarded(() => backend.openFolder(path));
	if (seq !== openSeq) return;
	if (!workspace) {
		if (prevRoot) {
			session.setRoot(prevRoot);
			if (prevLspRunning || snapshot(state).lsp.state === "running") {
				// Spawn a fresh language server process: starlims-lsp ignores a second
				// `initialize` on an already-initialized process, so calling
				// `session.start(prevRoot)` directly would deadlock forever.
				void restartLsp();
			}
		}
		return;
	}
	// Typed in while the folder was being chosen or opened: what is unsaved was kept before these edits were made,
	// and from here every open document is dropped. They are kept as the rest was, for the folder being left, which
	// the backend still takes them for though it is in the new one by now.
	// Not what was asked about above: a file the user chose to discard is dropped, unless it was typed in again.
	commitPendingEdits();
	const dropped = (path: string) => droppedByChoice.has(path) && droppedByChoice.get(path) === versionOf(path);
	const notKept = () => snapshotUnsavedPaths().filter((path) => !dropped(path) && !isKept(path));
	if (prevRoot && notKept().length) {
		await keepUnsaved(dropped);
		if (seq !== openSeq) return;
		// And where they could not be kept: the backend is in the new folder, where the edited files cannot be saved,
		// so it is sent back to the folder they belong to and the open is called off.
		const editedMeanwhile = notKept();
		if (editedMeanwhile.length && canonical(workspace.root) !== canonical(prevRoot)) {
			const back = await guarded(() => backend.openFolder(prevRoot));
			if (seq !== openSeq) return;
			if (back) {
				session.setRoot(prevRoot);
				void restartLsp();
				const names = editedMeanwhile.length === 1 ? displayName(editedMeanwhile[0]!) : `${editedMeanwhile.length} files`;
				notify(`${baseName(workspace.root)} was not opened: ${names} changed while it was being opened, and the changes could not be kept. Save or discard them, then open the folder again.`, "error");
				return;
			}
		}
	}
	closeReview();
	resetTidy();
	syncWorkspaceThreads(canonical(workspace.root));
	settingsAsked++;
	settingFailed = false;
	setTabsReadyFlag(false);
	closedTabs.length = 0;
	pendingReveal.clear();
	resetRecentTabs();
	const oldDocs = [...docs.values()];
	docs.clear();
	// What was kept of those documents is the folder's that was left: none of it is on record for this one.
	forgetKeptRecord();
	// The notices go below, and with them the one that a settings file does not read. It was kept on record as said,
	// so the reading for this folder passed it over: opening a folder from the Welcome page, the ordinary start,
	// took the notice away for good while the person's own settings stayed unused. The record goes with the
	// notices, and the reading that follows says again what still stands.
	settingsProblemsSaid = [];
	setState((s) => {
		s.workspace = workspace;
		s.groups = [{ tabs: [], active: null }];
		s.activeGroup = 0;
		s.dirty = {};
		s.conflicts = {};
		s.bottomMaximized = false;
		// What was said about the folder that is gone is no longer news.
		s.messages = [];
		s.centerView = "editors";
		s.treeVersion += 1;
		s.project = null;
		s.setupDismissed = false;
	});
	// Commit cleared groups before disposing old Monaco models so editors detach first.
	flush();
	clearEditorViewStates();
	invalidateImageCache();
	for (const doc of oldDocs) disposeDoc(doc);
	await Promise.all([loadSettings(true), loadProject()]);
	if (seq !== openSeq) return;
	const info = await backend.info();
	if (seq !== openSeq) return;
	setState((s) => {
		s.info = info;
	});
	const lsp = await backend.lspState();
	if (seq !== openSeq) return;
	setState((s) => {
		reconcile(lsp, null)(s.lsp);
	});
	session.setRoot(workspace.root);
	if (lsp.state === "running") void session.start(workspace.root).catch(() => {});
	log(`opened ${workspace.root}`);
	await restoreTabs();
}

/** Restarts the language server (re-resolving `lspPath`) and refreshes `state.info` so Settings and StatusBar stay current. */
export async function restartLsp(): Promise<void> {
	const seq = openSeq;
	await guarded(async () => {
		await backend.lspRestart();
		const next = await backend.info();
		if (next && seq === openSeq) setState((s) => { s.info = next; });
	});
}

// --- the tabs a folder was left with ---------------------------------------------

/** False while a folder is being opened: its tabs are not yet the ones to remember. */
const [tabsReady, setTabsReady] = createSignal(false);
let tabsReadyNow = false;
const setTabsReadyFlag = (v: boolean) => {
	tabsReadyNow = v;
	setTabsReady(v);
};
export const isTabsReady = tabsReady;

/** Keeps which files are open in this folder, for the next time it is opened. */
export function rememberTabs() {
	const cur = snapshot(state);
	const root = cur.workspace?.root;
	if (!root || !tabsReadyNow) return;
	// A document with no file yet has its place among the tabs too: it comes back there if it has text that was
	// kept (ADR 0042), and one left empty has nothing to come back with and is passed over (restoreTabs).
	remember(tabsKey(root), packTabs(cur.groups, cur.activeGroup));
}

/** The side panels there are, and the bottom ones: what a kept choice must be one of. */
const LEFT_VIEWS: readonly PanelId[] = ["explorer", "objects", "palette", "reference", "search", "history", "health", "agent", "docs", "git"];
const BOTTOM_VIEWS: readonly BottomView[] = ["problems", "output"];

/** Keeps which side panel, bottom panel and right panel are showing in this folder, for the next time it is opened. */
export function rememberViews() {
	const cur = snapshot(state);
	const root = cur.workspace?.root;
	if (root && tabsReadyNow) remember(viewsKey(root), packViews(cur.leftView, cur.bottomView, cur.rightView));
}

/**
 * Opens again what was open in this folder last time. A file that has gone
 * since, or is no longer inside the folder, is passed over without a word.
 */
const SKIP_TABS_ONCE = "ssl-studio.skipTabsOnce";

/**
 * Reloads the window with no tabs reopened. The way out when a restored tab is what keeps failing: the error card
 * (main.tsx) offers it, since a plain reload would open the same tab and fail the same way.
 */
export function reloadWithoutTabs() {
	try {
		sessionStorage.setItem(SKIP_TABS_ONCE, "1");
	} catch {
		// No session storage: the reload still happens, with the tabs.
	}
	window.location.reload();
	// Still here a moment later: the reload did not happen. The request goes with it, so that a later, ordinary
	// reload reopens the tabs as usual.
	setTimeout(() => {
		try {
			sessionStorage.removeItem(SKIP_TABS_ONCE);
		} catch {
			// Nothing was stored.
		}
	}, 2000);
}

function takeSkipTabsOnce(): boolean {
	try {
		const asked = sessionStorage.getItem(SKIP_TABS_ONCE) === "1";
		sessionStorage.removeItem(SKIP_TABS_ONCE);
		return asked;
	} catch {
		return false;
	}
}

export async function restoreTabs() {
	const curStart = snapshot(state);
	const root = curStart.workspace?.root;
	// A self-test starts from no tabs remembered, and leaves none behind for the next run. What was unsaved when
	// the folder was left comes back in one too (ADR 0042): the check of the close reads it (selftestClose.ts).
	if (curStart.info?.selftest || curStart.info?.selftestClose) {
		if (root && (await recallUnsaved(root))) await openKeptPending(root);
		return;
	}
	// Asked for once, by the error card: the panels come back, the files do not, and what is remembered below is
	// then the empty set, so the tab that failed is not reopened next time either.
	const skipTabs = takeSkipTabsOnce();
	setTabsReadyFlag(false);
	try {
		// What was unsaved when the folder was left, before any of its files is read: a file that is opened below
		// opens with the text it was left with.
		if (root && !(await recallUnsaved(root))) return;
		// The panels first: they are there at once, and the files take a moment to read.
		const views = root ? unpackViews(recall(viewsKey(root)), LEFT_VIEWS, BOTTOM_VIEWS) : {};
		if (views.left || views.bottom || views.right) {
			setState((s) => {
				if (views.left) s.leftView = views.left as PanelId;
				if (views.bottom) s.bottomView = views.bottom as BottomView;
				// Where it is no longer docked on the right, the window's layout shows another that is (App.tsx).
				if (views.right) s.rightView = views.right as PanelId;
			});
		}
		if (root && skipTabs && keptPending.size) {
			// The files do not come back this once, and so neither do those with unsaved text: one of them may be
			// the tab that failed. Their text stays kept, and that it is there is said.
			const pending = [...keptPending.keys()];
			notify(`Unsaved text is kept for ${namesOf(pending)}. It comes back when ${pending.length === 1 ? "the file" : "a file"} is opened.`, "info", { label: "Open", run: () => void openKeptPending(root) });
		}
		const saved = root && !skipTabs ? unpackTabs(recall(tabsKey(root))) : null;
		if (root && !saved && !skipTabs) await openKeptPending(root);
		if (!root || !saved) return;
		for (const [index, group] of saved.groups.entries()) {
			const tabs: string[] = [];
			for (const path of group.tabs) {
				// A document with no file yet comes back where it was, if it was left with text.
				if (isUntitled(path)) {
					const kept = keptPending.get(path);
					if (kept && attachUntitledKept(kept)) tabs.push(path);
					continue;
				}
				if (!isInside(root, path)) continue;
				try {
					const loaded = (await loadDoc(path, true)).path;
					if (snapshot(state).workspace?.root !== root) {
						letGoIfOnlyRead(loaded);
						return;
					}
					tabs.push(loaded);
				} catch {
					// Gone, or not readable any more.
				}
			}
			// The folder may have been changed for another while these were read.
			if (snapshot(state).workspace?.root !== root) return;
			// And a file may have gone while the others were read: it is no longer there to have a tab.
			for (const path of [...tabs]) if (!docs.has(path)) tabs.splice(tabs.indexOf(path), 1);
			if (!tabs.length && index > 0) continue;
			const active = group.active && tabs.includes(canonical(group.active)) ? canonical(group.active) : (tabs[tabs.length - 1] ?? null);
			setState((s) => {
				while (s.groups.length <= index) s.groups.push({ tabs: [], active: null });
				const pinned = (group.pinned ?? []).map(canonical).filter((path) => tabs.includes(path));
				// The pinned stand first, also before a tab that was opened while these were being read.
				const curGroup = s.groups[index]!;
				const all = [...new Set([...curGroup.tabs, ...tabs])];
				s.groups[index] = {
					...curGroup,
					tabs: [...pinned, ...all.filter((tab) => !pinned.includes(tab))],
					active: curGroup.active ?? active,
					...(pinned.length ? { pinned } : {}),
				};
			});
		}
		// Drop empty leading groups if Group 0's files were all deleted while a later group still has tabs.
		setState((s) => {
			if (s.groups.length > 1 && s.groups.some((g) => !g.tabs.length) && s.groups.some((g) => g.tabs.length > 0)) {
				const keptIndices: number[] = [];
				s.groups.forEach((g, i) => {
					if (g.tabs.length > 0) keptIndices.push(i);
				});
				const mappedActive = keptIndices.indexOf(saved.activeGroup);
				s.groups = s.groups.filter((g) => g.tabs.length > 0);
				s.activeGroup = mappedActive >= 0 ? mappedActive : 0;
			} else {
				s.activeGroup = Math.min(saved.activeGroup, s.groups.length - 1);
			}
		});
		// Unsaved text of a file that had no tab among those (the tabs are remembered by the window, the text by the
		// app: one may be there without the other) gets a tab of its own.
		await openKeptPending(root);
	} finally {
		if (snapshot(state).workspace?.root === root) {
			sayKeptRestored();
			setTabsReadyFlag(true);
			rememberTabs();
			rememberViews();
		}
	}
}

/**
 * Asks the backend for the unsaved text it kept for this folder, and puts it where a file that is opened finds it
 * (loadDoc). Says whether the folder is still the open one. Text that cannot be asked for is not lost by that: it
 * stays kept, and the files open as they are on disk.
 */
async function recallUnsaved(root: string): Promise<boolean> {
	const epoch = keptEpoch;
	let kept: KeptText[] = [];
	try {
		kept = (await backend.unsavedKept()) ?? [];
	} catch (e) {
		log(`the unsaved text kept for ${baseName(root)} could not be read: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (epoch !== keptEpoch || snapshot(state).workspace?.root !== root) return false;
	for (const each of Array.isArray(kept) ? kept : []) {
		if (!each || typeof each.path !== "string" || typeof each.text !== "string") continue;
		const path = canonical(each.path);
		if (isUntitled(path) || isInside(root, path)) keptPending.set(path, { ...each, path });
	}
	return true;
}

/** What came back unsaved from last time with something to say of it: the file changed on disk since, or is gone. */
let keptRestored: { path: string; file: "changed" | "gone" }[] = [];

/** Says it, once for all the files a folder came back with. */
function sayKeptRestored() {
	const of = (file: "changed" | "gone") => keptRestored.filter((each) => each.file === file).map((each) => each.path);
	const changed = of("changed");
	const gone = of("gone");
	keptRestored = [];
	if (changed.length) notify(`${namesOf(changed)} changed on disk while ${changed.length === 1 ? "its" : "their"} unsaved text was kept. The unsaved text is open: saving will ask which to keep.`, "error");
	if (gone.length) notify(`${namesOf(gone)} ${gone.length === 1 ? "is" : "are"} no longer on disk. ${gone.length === 1 ? "Its" : "Their"} unsaved text is open: save to put the ${gone.length === 1 ? "file" : "files"} back.`, "error");
}

/** Opens a tab for each unsaved text that no document has taken up yet, in the group at hand. */
async function openKeptPending(root: string) {
	for (const kept of [...keptPending.values()]) {
		if (snapshot(state).workspace?.root !== root) return;
		if (keptPending.get(kept.path) !== kept) continue;
		let path: string;
		if (isUntitled(kept.path)) {
			if (!attachUntitledKept(kept)) continue;
			path = kept.path;
		} else {
			try {
				path = (await loadDoc(kept.path, true)).path;
			} catch {
				continue;
			}
			if (snapshot(state).workspace?.root !== root) return void letGoIfOnlyRead(path);
			// The file has that text by now: nothing of it is unsaved, and it needs no tab for it.
			if (!snapshot(state).dirty[path]) {
				letGoIfOnlyRead(path);
				continue;
			}
		}
		setState((s) => {
			const g = s.groups[s.activeGroup] ?? s.groups[0];
			if (!g || s.groups.some((each) => each.tabs.includes(path))) return;
			g.tabs.push(path);
			g.active ??= path;
		});
	}
	if (snapshot(state).workspace?.root === root) sayKeptRestored();
}

export async function loadProject() {
	const startRoot = snapshot(state).workspace?.root;
	const project = await guarded(() => backend.project());
	if (project && snapshot(state).workspace?.root === startRoot) setState((s) => { s.project = project; });
}

/**
 * Reads the settings. `fresh` is for a folder that has just been opened: everything is taken as it is on disk. A
 * later reading (a setting saved, project.toml changed) keeps the layout on screen, which is the view's own and may
 * not be on disk yet (see saveSetting).
 */
/**
 * The settings files last said to be unreadable. Settings are read often, and a file broken by hand stays broken
 * until it is mended: each is said when it is first found so, and again only once it has read well in between.
 */
let settingsProblemsSaid: readonly string[] = [];

/** A reading's word on which settings files do not read: those not yet said are said, and those that read again are forgotten. */
function saySettingsProblems(problems: readonly string[]) {
	for (const problem of problems) if (!settingsProblemsSaid.includes(problem)) notify(problem, "error");
	settingsProblemsSaid = problems;
}

/** Asks the backend once more which settings files do not read, for the record alone: the settings on screen are not touched. */
async function recheckSettingsProblems() {
	const startRoot = snapshot(state).workspace?.root;
	const read = await backend.settings().catch(() => null);
	if (read && snapshot(state).workspace?.root === startRoot) saySettingsProblems(read.problems ?? []);
}

export async function loadSettings(fresh = false) {
	const startRoot = snapshot(state).workspace?.root;
	const [{ effective, problems = [] }, themes] = await Promise.all([backend.settings(), backend.themes()]);
	if (snapshot(state).workspace?.root !== startRoot) return;
	// A settings file with a slip in it gives none of its settings. Without a word here the app started with the
	// defaults and the person's own settings seemed lost, until the next change of a setting was refused.
	saySettingsProblems(problems);
	knownSaved = { root: startRoot, settings: structuredClone(effective) };
	const { layout: _onDisk, ...rest } = effective;
	setState((s) => {
		reconcile(fresh ? effective : { ...rest, layout: snapshot(s.settings.layout) }, null)(s.settings);
		s.themes = themes;
	});
}

/**
 * The settings whose whole value is worked out here from the one on screen and saved whole: the shortcuts, the
 * regions' colours, the models marked as the user's own. Two such changes in one moment (two shortcuts cleared by
 * one gesture) would each be worked out from the value before either, and the later would write the earlier away,
 * however orderly the saving. So the new value is on screen at once, where the next change is worked out from it.
 */
const WORKED_OUT_HERE = ["keys", "editorKeys", "markdownKeys", "regionColors", "agentOwnModels"] as const;
/** How many saves of settings have been asked for: tells the answer to the last from the answers before it. */
let settingsAsked = 0;
/** How many of them have not answered yet, and whether one of those that have, failed. */
let settingsOut = 0;
let settingFailed = false;
/**
 * The settings as they were last known to be saved, and the folder they were read in: from the last reading of
 * them, or the last save that answered. What a failed save is put back to when the disk cannot be read either.
 * A copy: the settings on screen are changed in place, and must not take this with them.
 */
let knownSaved: { root: string | undefined; settings: Settings } | null = null;

/**
 * Saves a setting, and answers with the settings as the save left them (nothing when it failed, which has been
 * said): what to ask whether the setting took, since what is on screen may by then be a later save's.
 */
export async function saveSetting(patch: SettingsPatch, scope: "user" | "workspace" = "user"): Promise<Settings | undefined> {
	const startRoot = snapshot(state).workspace?.root;
	// Snapshot and clone before incrementing settingsOut so a proxy or uncloneable input never leaks settingsOut > 0.
	const immediate: Partial<Record<(typeof WORKED_OUT_HERE)[number], unknown>> = {};
	let hasImmediate = false;
	for (const key of WORKED_OUT_HERE) {
		if (patch[key] !== undefined && patch[key] !== null) {
			immediate[key] = structuredClone(snapshot(patch[key]));
			hasImmediate = true;
		}
	}
	const plainPatch = snapshot(patch);
	const mine = ++settingsAsked;
	settingsOut++;
	let effective: Settings | undefined;
	try {
		if (hasImmediate) {
			setState((s) => {
				for (const key of WORKED_OUT_HERE) {
					if (key in immediate) {
						const val = immediate[key];
						const target = (s.settings as any)[key];
						if (target && typeof target === "object" && val && typeof val === "object" && Array.isArray(target) === Array.isArray(val)) {
							reconcile(val, null)(target);
						} else {
							(s.settings as any)[key] = val;
						}
					}
				}
			});
			// Preserve the WORKED_OUT_HERE synchronous visibility contract across back-to-back writes in one tick.
			flush();
		}
		effective = await guarded(() => backend.saveSettings(scope, plainPatch));
	} finally {
		settingsOut--;
	}
	const sameWorkspace = snapshot(state).workspace?.root === startRoot;
	if (!effective && sameWorkspace) settingFailed = true;
	// Whether or not it is shown (below): an answer is the settings as the save left them on disk.
	if (effective && sameWorkspace) knownSaved = { root: startRoot, settings: structuredClone(effective) };
	// A file on record as not reading may be the one this save has just written, which then reads again: a file
	// that does not is never written over. Left on record, the same slip made in it later was taken for the one
	// already said, and was not said. Only a reading tells which files still do not read.
	if (effective && sameWorkspace && settingsProblemsSaid.length) void recheckSettingsProblems();
	// Saves land, and answer, in the order they were asked for, and each answer is the settings as they then are:
	// the answer to a save asked for after this one holds this one's change too, and this older answer is not put
	// over what has been shown since.
	if (effective && sameWorkspace && mine === settingsAsked) {
		// What comes back is the settings as they are on disk. The layout is the view's own, and is saved a moment
		// after it changes (App.tsx): the one on disk may be older, and must not come back over the one on screen.
		const { layout: _onDisk, ...rest } = effective;
		setState((s) => {
			reconcile("layout" in patch ? effective : { ...rest, layout: snapshot(s.settings.layout) }, null)(s.settings);
		});
	}
	// A save that failed has said so. What is on screen may then hold a value shown at once that was never saved,
	// or lack one from an answer passed over above: it is put back to what is on disk, once every save asked for
	// has answered (sooner, and a save still on its way would land after the reading and be passed over). Not if
	// another save is asked for while the disk is read: its own answer is the newer.
	if (!settingsOut && settingFailed) {
		settingFailed = false;
		const asked = settingsAsked;
		const curRoot = snapshot(state).workspace?.root;
		let unread = "";
		const disk = await backend.settings().then(
			(read) => read.effective,
			(e) => void (unread = String(e?.message ?? e)),
		);
		if (asked === settingsAsked && snapshot(state).workspace?.root === curRoot) {
			if (disk) knownSaved = { root: curRoot, settings: structuredClone(disk) };
			// The disk could not be read either: what was last known to be saved is what is shown, and that is said.
			// Left as it was, the value that was never saved stayed on screen as though it had been.
			const saved = disk ?? (knownSaved && knownSaved.root === curRoot ? structuredClone(knownSaved.settings) : undefined);
			if (saved) {
				const { layout: _onDisk, ...rest } = saved;
				setState((s) => {
					reconcile({ ...rest, layout: snapshot(s.settings.layout) }, null)(s.settings);
				});
			}
			if (!disk) notify(`The settings could not be read back after the save failed (${unread || "no answer"}). ${saved ? "What is shown is what was last known to be saved." : "What is shown may not be what is saved."}`, "error");
		}
	}
	return effective;
}

// --- documents ---------------------------------------------------------------

/** True for floating untitled buffers that have not been saved to disk yet. */
export const isUntitled = (path: string | null | undefined): path is string => Boolean(path && path.startsWith("untitled:"));
export const displayName = (path: string) => (isUntitled(path) ? path.slice("untitled:".length) : baseName(path));

/** Plan view mode by file type per group (Source | Text | Chart). Defaults to Chart. */
export function planMode(_path: string, group?: number): PlanViewMode {
	const g = group ?? state.activeGroup;
	return resolvePlanMode(state.groups[g]?.planMode, state.planViewMode);
}

export function setPlanMode(_path: string, mode: PlanViewMode, group?: number) {
	setState((s) => {
		const g = group ?? s.activeGroup;
		if (s.groups[g]) s.groups[g]!.planMode = mode;
		if (shouldUpdateDefaultMode(group, s.groups.length)) {
			s.planViewMode = mode;
			remember(PLAN_MODE_KEY, mode);
		}
	});
}

/** Obsidian-style Markdown mode by file type per group (Source | Live | Read). Allows Live + Read split side-by-side while keeping mode across documents. */
export function markdownMode(_path: string, group?: number): MarkdownViewMode {
	const g = group ?? state.activeGroup;
	return resolveMarkdownMode(state.groups[g]?.mdMode, state.mdViewMode, state.settings.livePreview);
}
export function setMarkdownMode(_path: string, mode: MarkdownViewMode, group?: number) {
	setState((s) => {
		const g = group ?? s.activeGroup;
		if (s.groups[g]) s.groups[g]!.mdMode = mode;
		if (shouldUpdateDefaultMode(group, s.groups.length)) {
			s.mdViewMode = mode;
			remember(MARKDOWN_MODE_KEY, mode);
		}
	});
}

/** Syncs Source <-> Live when the user toggles the "Markdown live preview" setting (preserving Read mode). */
export function syncLivePreviewMode(enabled: boolean) {
	const from: MarkdownViewMode = enabled ? "source" : "live";
	const to: MarkdownViewMode = enabled ? "live" : "source";
	setState((s) => {
		if (s.mdViewMode === from) {
			s.mdViewMode = to;
			remember(MARKDOWN_MODE_KEY, to);
		}
		for (const g of s.groups) {
			if (g.mdMode === from) g.mdMode = to;
		}
	});
}

/** Table/CSV view mode by file type per group (`true` = plain text, `false` = interactive table). */
export function tableTextMode(_path: string, group?: number): boolean {
	const g = group ?? state.activeGroup;
	return resolveTableTextMode(state.groups[g]?.tableText, state.tableTextDefault);
}

export function setTableTextMode(_path: string, text: boolean, group?: number) {
	setState((s) => {
		const g = group ?? s.activeGroup;
		if (s.groups[g]) s.groups[g]!.tableText = text;
		if (shouldUpdateDefaultMode(group, s.groups.length)) {
			s.tableTextDefault = text;
			remember(TABLE_TEXT_MODE_KEY, String(text));
		}
	});
}

/** One spelling per file: Monaco's (on Windows it lowercases the drive letter). Untitled paths stay as-is. */
export const canonical = (path: string) => (isUntitled(path) ? path : monaco.Uri.file(path).fsPath);

/**
 * What Tab writes in a script: what the script is indented with already, and where it has no indentation yet (a
 * new script, an empty one), what the house style says. Left to the editor's own defaults, a new script was
 * indented with four spaces under a house style of tabs, and the formatter then rewrote every line typed.
 */
function setHouseIndent(model: monaco.editor.ITextModel) {
	if (model.isDisposed() || model.getLanguageId() !== "ssl") return;
	const ssl = snapshot(state).settings.ssl;
	const size = Number(getPath(ssl, "format.indentSize") ?? SERVER_DEFAULTS.format.indentSize);
	const spaces = (getPath(ssl, "format.indentStyle") ?? SERVER_DEFAULTS.format.indentStyle) === "space";
	model.detectIndentation(spaces, Number.isInteger(size) && size > 0 ? size : 4);
}

/** The same for every script that is open, when the house style has changed. */
export function setHouseIndentEverywhere() {
	for (const doc of docs.values()) setHouseIndent(doc.model);
}

/** Opens a floating untitled buffer (Untitled-1, Untitled-2, ...) that stays in memory until saved. */
export function newUntitled(group = snapshot(state).activeGroup, language = "plaintext"): string {
	const cur = snapshot(state);
	if (!cur.workspace) {
		notify("Open a folder first.");
		return "";
	}
	const targetGroup = Math.max(0, Math.min(group, Math.max(0, cur.groups.length - 1)));
	if (!cur.groups[targetGroup]) return "";
	let n = 1;
	// Not a name that unsaved text is still kept under, either: the two would be one document the next time.
	while (docs.has(`untitled:Untitled-${n}`) || keptPending.has(`untitled:Untitled-${n}`)) n++;
	const path = `untitled:Untitled-${n}`;
	attachUntitled(path, "", language);
	closeComparison();
	setState((s) => {
		const g = s.groups[targetGroup];
		if (g) {
			if (!g.tabs.includes(path)) g.tabs.push(path);
			g.active = path;
		}
		s.activeGroup = targetGroup;
		s.centerView = "editors";
	});
	onFlush(() => {
		const cur = snapshot(state);
		if (cur.centerView !== "editors" || cur.groups[cur.activeGroup]?.active !== path) return;
		focusEditor();
	});
	return path;
}

/** Makes a model the open document for a name that has no file yet, and follows its edits. With text, it is unsaved from the start. */
function attachUntitled(path: string, text: string, language: string): Doc {
	const uri = monaco.Uri.parse(path);
	const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, language, uri);
	const doc: Doc = { path, model, savedVersion: text === "" ? model.getAlternativeVersionId() : -1, savedText: "", mtime: 0 };
	docs.set(path, doc);
	model.onDidChangeContent(() => {
		const dirty = model.getAlternativeVersionId() !== doc.savedVersion && model.getValue() !== doc.savedText;
		setState((s) => {
			s.dirty[path] = dirty;
		});
		keepUnsavedSoon();
	});
	// A script not yet saved is the language server's to read as well: it is told of it here, or when the
	// document is made a script by its language mode (setDocumentLanguage).
	session.track(model);
	setHouseIndent(model);
	doc.validatorDispose = attachValidator(model, path, language);
	return doc;
}

/**
 * A document with no file yet, as it was left: the text that was kept for it, unsaved (ADR 0042). Says whether
 * it is there now. Its text is on record as kept, so that it is not written again until it changes.
 */
function attachUntitledKept(kept: KeptText): boolean {
	if (keptPending.get(kept.path) === kept) keptPending.delete(kept.path);
	if (docs.has(kept.path)) return true;
	if (!kept.text) return false;
	const doc = attachUntitled(kept.path, kept.text, kept.language || "plaintext");
	keptVersions.set(kept.path, { model: doc.model, version: doc.model.getAlternativeVersionId() });
	setState((s) => {
		s.dirty[kept.path] = true;
	});
	return true;
}

function disposeDoc(doc: Doc) {
	doc.validatorDispose?.();
	doc.validatorDispose = undefined;
	if (!doc.model.isDisposed()) doc.model.dispose();
}

/**
 * Attaches the non-SSL document validator matching `languageId` (or plan path) using a scoped model
 * proxy so switching language mode cleanly stops timers, listeners, and markers without disposing the model.
 */
function attachValidator(model: monaco.editor.ITextModel, path: string, languageId: string): (() => void) | undefined {
	if (model.isDisposed()) return undefined;
	const wantsPlan = isPlanPath(path) && languageId === "json";
	const wantsDoc = languageId === "markdown";
	// A plan's own check says where it cannot be read (plan/check.ts): one source of findings to a document.
	const wantsJson = languageId === "json" && !wantsPlan && !/\.jsonc$/i.test(path);
	const wantsToml = languageId === "toml";
	const wantsXml = languageId === "xml";
	if (!wantsPlan && !wantsDoc && !wantsJson && !wantsToml && !wantsXml) return undefined;

	let stopped = false;
	let cleaning = false;
	const cleanups: (() => void)[] = [];
	const onDispose = (cb: () => void): monaco.IDisposable => {
		cleanups.push(cb);
		return {
			dispose: () => {
				const idx = cleanups.indexOf(cb);
				if (idx >= 0) cleanups.splice(idx, 1);
			},
		};
	};
	const scoped = new Proxy(model, {
		get(target, prop) {
			// During synchronous cleanup, report the underlying model's real disposal state so
			// `publishFindings(model, owner, null)` still clears Monaco markers on language switch;
			// afterward report disposed so any in-flight async validator (TOML/Plan) drops stale results.
			if (prop === "isDisposed") return () => (stopped && !cleaning) || target.isDisposed();
			if (prop === "onWillDispose") return onDispose;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	let returnedDispose: (() => void) | undefined;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		realDisposeSub.dispose();
		cleaning = true;
		try {
			for (const fn of cleanups.splice(0)) fn();
			returnedDispose?.();
		} finally {
			cleaning = false;
		}
	};
	const realDisposeSub = model.onWillDispose(() => stop());
	let raw: unknown;
	if (wantsPlan) raw = trackPlan(scoped);
	else if (wantsDoc) raw = trackDoc(scoped, path);
	else if (wantsJson) raw = trackJson(scoped);
	else if (wantsToml) raw = trackToml(scoped);
	else if (wantsXml) raw = trackXml(scoped);
	if (typeof raw === "function") returnedDispose = raw as () => void;
	else if (raw && typeof (raw as monaco.IDisposable).dispose === "function") returnedDispose = () => (raw as monaco.IDisposable).dispose();
	if (!cleanups.length && !returnedDispose) {
		realDisposeSub.dispose();
		return undefined;
	}
	return stop;
}

/** Makes a model the open document for a path, and follows its edits. */
function attach(path: string, text: string, saved: { text: string; mtime: number }): Doc {
	const uri = monaco.Uri.file(path);
	// A data source that is SQL from its first line opens as SQL. One with SSL directives above its SQL is seen
	// for what it is once the language server has said what it read (`readDataSource`).
	const sqlFrom = isDataSourceName(path) ? sqlBodyStart(text, null) : null;
	const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, sqlFrom === null ? languageFor(path) : "sql", uri);
	const doc: Doc = { path, model, savedVersion: text === saved.text ? model.getAlternativeVersionId() : -1, savedText: saved.text, mtime: saved.mtime };
	if (sqlFrom !== null) doc.sqlBodyLine = sqlFrom;
	docs.set(path, doc);
	model.onDidChangeContent(() => {
		const dirty = model.getAlternativeVersionId() !== doc.savedVersion && model.getValue() !== doc.savedText;
		setState((s) => {
			s.dirty[path] = dirty;
		});
		// A file that is being written in is not one that was only looked at: its tab stays. Asked a moment later: a
		// reload from disk is an edit too, and says the file is unchanged once it is done.
		if (dirty) queueMicrotask(() => snapshot(state).dirty[path] && keepTab(path));
		// And what is unsaved of it is kept, within the second (ADR 0042).
		keepUnsavedSoon();
	});
	session.track(model);
	setHouseIndent(model);
	doc.validatorDispose = attachValidator(model, path, model.getLanguageId());
	if (isDataSourceName(path)) followDataSource(doc);
	return doc;
}

/** The language mode a document has when none is chosen for it: by its name, and for a data source by what it holds. */
function detectedLanguage(doc: Doc): string {
	return isDataSourceName(doc.path) && doc.sqlBodyLine !== undefined ? "sql" : languageFor(doc.path);
}

/** The same for an open document's path: what "Auto Detect" in the language picker goes back to. */
export const detectedLanguageOf = (path: string): string => {
	const doc = docs.get(canonical(path));
	return doc ? detectedLanguage(doc) : languageFor(path);
};

/**
 * Reads an open data source as SQL or as SSL, and shows it in that language mode (ADR 0038).
 *
 * The language server says what it read as SSL (its lexical tokens): nothing of an SQL data source, or its
 * directives alone. What stands below that is the IDE's to read, and is SQL if it opens with an SQL statement
 * (`sqlBodyStart`). With no server to say, only a file that is SQL from its first line is taken for SQL. A mode
 * chosen by hand is left as chosen.
 */
async function readDataSource(doc: Doc): Promise<void> {
	const model = doc.model;
	if (model.isDisposed() || doc.binary || !isDataSourceName(doc.path)) return;
	const version = model.getVersionId();
	const lexical = await session.lexicalTokens(model).catch(() => null);
	if (model.isDisposed() || model.getVersionId() !== version || docs.get(doc.path) !== doc) return;
	const body = sqlBodyStart(model.getValue(), lexical);
	doc.sqlBodyLine = body ?? undefined;
	if (doc.languageChosen) return;
	const now = model.getLanguageId();
	const want = body === null ? "ssl" : isSqlLanguage(now) ? now : "sql";
	if (now !== want && (now === "ssl" || isSqlLanguage(now))) setDocumentLanguage(doc.path, want, false);
}

/** Reads a data source when it is opened, and again a moment after it is written in. */
function followDataSource(doc: Doc) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const written = doc.model.onDidChangeContent(() => {
		clearTimeout(timer);
		timer = setTimeout(() => void readDataSource(doc), 400);
	});
	doc.model.onWillDispose(() => {
		clearTimeout(timer);
		written.dispose();
	});
	void readDataSource(doc);
}

// The server has started, or started again: what it reads of each open data source can be asked now.
session.onReady(() => {
	for (const doc of docs.values()) if (isDataSourceName(doc.path)) void readDataSource(doc);
});

/**
 * The open document for a file, read from disk if it is not open yet. `forTab` is for a file that is being opened
 * in a tab: it opens with the unsaved text that was kept for it, if there is any (ADR 0042). A file that is only
 * read (a definition peeked at) is read as it is on disk, and the kept text waits for its tab.
 */
async function loadDoc(path: string, forTab = false): Promise<Doc> {
	path = canonical(path);
	const existing = docs.get(path);
	if (existing) return existing;
	const kept = forTab ? keptPending.get(path) : undefined;
	let file: Awaited<ReturnType<typeof backend.read>> | null = null;
	let unread = "";
	try {
		file = await backend.read(path);
	} catch (e: any) {
		// A file that is gone, or does not read, still has the text that was kept for it.
		if (!kept) throw e;
		unread = String(e?.message ?? e);
	}
	// Two callers may have asked for the same file while it was being read.
	const known = docs.get(path);
	if (known) return known;
	if (kept && keptPending.get(path) === kept) {
		keptPending.delete(path);
		return attachKept(path, kept, file);
	}
	if (!file) throw new Error(unread);
	const doc = attach(path, file.text, file);
	doc.encoding = file.encoding;
	doc.binary = file.binary;
	return doc;
}

/**
 * A file's document as it was left: the unsaved text that was kept for it, over the file as those edits found it
 * (ADR 0042). It is as if the app had stayed open, so what happened to the file meanwhile is met as it is in an
 * open document: a file that changed on disk is marked, and saving asks which to keep (ADR 0009); one that is gone
 * is put back by saving. A file that has the kept text already has nothing unsaved, and opens as it is.
 */
function attachKept(path: string, kept: KeptText, file: { text: string; mtime: number; encoding?: string; binary?: { size: number; image?: string } } | null): Doc {
	if (file && !file.binary && file.text === kept.text) {
		const doc = attach(path, file.text, file);
		doc.encoding = file.encoding;
		// On record as kept, and not unsaved: the next keep forgets it.
		keptVersions.set(path, { model: doc.model, version: doc.model.getAlternativeVersionId() });
		keepUnsavedSoon(0);
		return doc;
	}
	const same = Boolean(file && !file.binary && kept.saved && file.text === kept.saved.text);
	// With the file as it was, its date now: a file that was only touched has not changed under these edits. With
	// another file there, a date that is not its own, so that saving asks whatever the two dates are.
	const mtime = same ? file!.mtime : kept.saved && kept.saved.mtime !== file?.mtime ? kept.saved.mtime : -1;
	const base = { text: kept.saved?.text ?? "", mtime };
	const doc = attach(path, kept.text, base);
	if (file && !file.binary) doc.encoding = file.encoding;
	// The backend has this text already, with this file under it.
	keptVersions.set(path, { model: doc.model, version: doc.model.getAlternativeVersionId() });
	if (kept.saved) keptBases.set(path, { text: kept.saved.text, mtime: kept.saved.mtime });
	setState((s) => {
		s.dirty[path] = true;
		if (file && !same) s.conflicts[path] = true;
	});
	if (!same) keptRestored.push({ path, file: file ? "changed" : "gone" });
	return doc;
}

session.sslSettings = () => snapshot(state).settings.ssl ?? {};

setFormattingHost({
	sqlBodyLine: async (model) => {
		const doc = model.uri.scheme === "file" ? docs.get(canonical(model.uri.fsPath)) : undefined;
		if (!doc) return undefined;
		// Read again now: the text may have been written in since it was last read.
		await readDataSource(doc);
		return doc.sqlBodyLine;
	},
	options: () => ({
		printWidth: Number(getPath(state.settings.ssl, "format.maxLineLength") ?? SERVER_DEFAULTS.format.maxLineLength),
		sqlDialect: state.settings.sqlDialect ?? DEFAULT_SQL_DIALECT,
		sqlKeywordCase: getPath(state.settings.ssl, "format.sql.keywordCase") ?? SERVER_DEFAULTS.format.sql.keywordCase,
	}),
	formatSsl: async (code) => {
		if (state.lsp.state !== "running") {
			return { ok: false, error: "Start or restart the language server to format SSL code.", lspOffline: true };
		}
		try {
			const indentStyle = getPath(state.settings.ssl, "format.indentStyle") ?? SERVER_DEFAULTS.format.indentStyle;
			const tabSize = Number(getPath(state.settings.ssl, "format.indentSize") ?? SERVER_DEFAULTS.format.indentSize);
			const input = code.replace(/\r\n/g, "\n");
			const normalized = input.endsWith("\n") ? input : `${input}\n`;
			const formatted = await session.formatText(normalized, { tabSize, insertSpaces: indentStyle === "space" });
			return { ok: true, text: formatted };
		} catch (err: any) {
			return { ok: false, error: String(err?.message ?? err) };
		}
	},
	onError: (error, path) => notify(`Could not format ${displayName(path)}: ${error}`, "error"),
	onNotice: (message) => notify(message),
});

/** Models for files the language server points at (peek, rename) without opening a tab. */
session.ensureModel = async (uri) => {
	const path = monaco.Uri.parse(uri).fsPath;
	const ws = snapshot(state).workspace;
	if (!ws || !isInside(ws.root, path)) return null;
	try {
		return (await loadDoc(path)).model;
	} catch {
		return null;
	}
};

export type Reveal = { line: number; column?: number; endLine?: number; endColumn?: number };
const pendingReveal = new Map<string, Reveal>();
export const takeReveal = (path: string) => {
	const reveal = pendingReveal.get(path);
	pendingReveal.delete(path);
	return reveal;
};

/** Each look asked for, counted: one that is still being read when a later one is asked for gives way to it. */
let looks = 0;
/** A document that is not to be given up without a question: it has unsaved changes, or differs from its file on disk. */
const heldOpen = (path: string) => {
	const cur = snapshot(state);
	return Boolean(cur.dirty[path] || cur.conflicts[path]);
};

/** The file being brought to the front for a look, while it is: a click on its row in a list, whether or not it had a tab. */
let lookedAt: string | null = null;
/**
 * Whether a file is coming to the front only to be looked at. Such a file leaves the keyboard where it is, on the
 * row that was clicked, so that the keys that follow (Delete, F2, copy, the arrows) are still the list's. (A look
 * that goes to a place in the file, as a search result's does, still puts the keyboard at that place.)
 */
export const openedForALook = (path: string) => lookedAt === path;

/**
 * Opens a file in a tab and brings it to the front. With `preview` it is opened for a look, as one click in a list
 * does: it takes the place of the tab last opened that way, and its own tab is given up to the next. With `keep` a
 * tab it has for a look becomes one that stays (a double click, "Open" on a menu). With neither, a file that has no
 * tab gets one that stays, and one that has a tab keeps it as it is: going to a place in a file looked at (a symbol,
 * a problem, back and forward) is still looking at it. Editing a tab, pinning it or moving it keeps it too.
 */
export async function openFile(path: string, options: { group?: number; reveal?: Reveal; preview?: boolean; keep?: boolean } = {}) {
	path = canonical(path);
	const startRoot = snapshot(state).workspace?.root;
	const look = ++looks;
	// What was only read (a definition peeked at) had no tab to keep it true, and the file may have changed, gone, or
	// been made anew since. It is let go, and the file is read as it is now: nothing of the old reading is left to undo.
	letGoIfOnlyRead(path);
	const doc = await guarded(() => loadDoc(path, true));
	if (!doc) return;
	const curAfterRead = snapshot(state);
	// The folder changed while this file was being read: let the loaded model go instead of opening it in the new workspace.
	if (curAfterRead.workspace?.root !== startRoot) return letGoIfOnlyRead(path);
	// Another file was opened (for a look or to stay) while this preview was being read: that one is what is wanted now.
	// Without this the slower preview read would land last and steal focus or take the tab of the file opened last.
	if (options.preview && look !== looks) return letGoIfOnlyRead(path);
	const group = Math.max(0, Math.min(options.group ?? curAfterRead.activeGroup, Math.max(0, curAfterRead.groups.length - 1)));
	if (options.reveal) pendingReveal.set(path, options.reveal);
	closeComparison();
	/** The tab that gave its place to this one: it was only looked at. */
	let replaced: string | null = null as string | null;
	// Said for as long as the editors hear of the change during the pending flush.
	lookedAt = options.preview ? path : null;
	setState((s) => {
		const g = s.groups[group];
		if (g) {
			if (g.tabs.includes(path)) {
				// A tab opened for a look, and now opened to stay, is kept.
				if (options.keep && g.preview === path) g.preview = null;
			} else if (options.preview && !heldOpen(path)) {
				// A tab that shows unsaved changes, or a file changed on disk, is never the one that gives way.
				const next = previewed(g.tabs, g.pinned ?? [], g.preview, path, heldOpen);
				g.tabs = next.tabs;
				g.preview = path;
				replaced = next.replaced;
			} else g.tabs.push(path);
			g.active = path;
		}
		s.activeGroup = group;
		// The call graph covers the editors: a file opened behind it would look like nothing happened.
		s.centerView = "editors";
		// A maximized bottom panel covers the editors too: opening a file restores it so the file is visible.
		if (s.bottomMaximized) s.bottomMaximized = false;
	});
	// What was only looked at and has no tab left is let go. It has no unsaved changes: a tab that shows some never gives way.
	if (replaced && !snapshot(state).groups.some((g) => g.tabs.includes(replaced!))) {
		// The editors hear of the change of tab first, as they do when a tab is closed: the one showing this file
		// keeps its place in it (cursor, scroll) while it still has the model, so the file comes back where it was left.
		flush();
		letGoIfOnlyRead(replaced);
	}
	onFlush(() => {
		const wasLook = openedForALook(path);
		if (lookedAt === path) lookedAt = null;
		const cur = snapshot(state);
		if (cur.centerView !== "editors" || cur.groups[cur.activeGroup]?.active !== path) return;
		revealSignal.fire(path);
		// Opened to stay (a double click, Enter in a list of files): the keyboard goes to it, also when it was already
		// showing for a look and the editor had no change of file to hear of.
		if (options.keep && !wasLook) focusEditor();
	});
}

/** Keeps a tab that was opened for a look: in one group, or in every group that has it so. */
export function keepTab(path: string, group?: number) {
	setState((s) => {
		s.groups.forEach((g, index) => {
			if ((group === undefined || group === index) && g.preview === path) g.preview = null;
		});
	});
}

/** Lets an already-visible editor scroll to a new reveal. */
export const revealSignal = (() => {
	const listeners = new Set<(path: string) => void>();
	return {
		fire: (path: string) => listeners.forEach((l) => l(path)),
		listen: (l: (path: string) => void) => (listeners.add(l), () => listeners.delete(l)),
	};
})();

/** Tabs closed in this session, newest last, for "Reopen closed tab". */
const closedTabs: string[] = [];

/** Says whether the tab closed: a refused or failed save keeps it open. */
export async function closeTab(path: string, group = snapshot(state).activeGroup, options: { discard?: boolean; pinned?: boolean } = {}): Promise<boolean> {
	// A cell still being typed in is an unsaved change like any other: in the document before it is asked about.
	commitPendingEdits();
	const curBefore = snapshot(state);
	if (!curBefore.groups[group]?.tabs.includes(path)) return true;
	// A pinned tab stays until it is let go: a close by key or by pointer says so and leaves it.
	if (curBefore.groups[group]!.pinned?.includes(path) && !options.pinned) {
		notify(`${baseName(path)} is pinned. Unpin it to close it: right-click its tab.`);
		return false;
	}
	let closePath = path;
	const lastView = curBefore.groups.filter((g) => g.tabs.includes(path)).length === 1;
	if (curBefore.dirty[path] && lastView && !options.discard) {
		const answer = await choose(`${displayName(path)} has unsaved changes.`, ["Save", "Discard changes"], { danger: "Discard changes" });
		if (!answer) return false;
		// A save that failed has already said why: the tab stays, with the edits in it.
		if (answer === "Save") {
			let promoted: string | null = null;
			if (!(await save(path, { onPromoted: (target) => (promoted = target) }))) return false;
			if (promoted) closePath = promoted;
		}
	}
	const curNow = snapshot(state);
	if (!curNow.groups[group]?.tabs.includes(closePath)) return true;
	const closingLastView = curNow.groups.filter((g) => g.tabs.includes(closePath)).length === 1;
	if (closingLastView && !isUntitled(closePath)) closedTabs.push(closePath);
	let removedGroup = false;
	setState((s) => {
		const g = s.groups[group];
		if (!g) return;
		const index = g.tabs.indexOf(closePath);
		if (index < 0) return;
		g.tabs.splice(index, 1);
		if (g.pinned) g.pinned = g.pinned.filter((p) => p !== closePath);
		if (g.preview === closePath) g.preview = null;
		if (g.active === closePath) g.active = g.tabs[Math.min(index, g.tabs.length - 1)] ?? null;
		if (s.groups.length > 1 && !g.tabs.length) {
			s.groups.splice(group, 1);
			s.activeGroup = 0;
			removedGroup = true;
		}
	});
	if (removedGroup) removeRecentGroup(group);
	clearEditorViewStates(closePath, group);
	if (!snapshot(state).groups.some((g) => g.tabs.includes(closePath))) {
		flush();
		clearEditorViewStates(closePath);
		const doc = docs.get(closePath);
		if (doc) {
			docs.delete(closePath);
			disposeDoc(doc);
			setState((s) => {
				delete s.dirty[closePath];
				delete s.conflicts[closePath];
			});
		}
		if (isUntitled(closePath)) {
			pathChanges.gone.forEach((told) => told((p) => p === closePath));
		}
	}
	return true;
}

/** The tabs of the active group, to step through. */
function stepTab(by: number) {
	// What is being typed in the view about to be left (a table cell, a field of a plan step) goes into its document
	// first. A tab left by the keyboard does not take the focus out of the field as a click does, so nothing
	// committed it, and the text went with the view.
	commitPendingEdits();
	const cur = snapshot(state);
	const group = cur.groups[cur.activeGroup];
	if (!group?.active || group.tabs.length < 2) return;
	const next = group.tabs[(group.tabs.indexOf(group.active) + by + group.tabs.length) % group.tabs.length]!;
	setState((s) => {
		if (s.groups[cur.activeGroup]) s.groups[cur.activeGroup]!.active = next;
	});
	onFlush(() => {
		const cur = snapshot(state);
		if (cur.centerView !== "editors" || cur.groups[cur.activeGroup]?.active !== next) return;
		revealSignal.fire(next);
		focusEditor();
	});
}
export const nextTab = () => stepTab(1);
export const previousTab = () => stepTab(-1);

/** Closes every tab of a group but one and the pinned. */
export async function closeOtherTabs(keep?: string | null, group?: number) {
	const cur = snapshot(state);
	const targetGroup = group ?? cur.activeGroup;
	const g = cur.groups[targetGroup];
	const targetKeep = keep !== undefined ? keep : (g?.active ?? null);
	for (const path of othersOf(g?.tabs ?? [], g?.pinned ?? [], targetKeep)) if (!(await closeTab(path, targetGroup))) return;
}

/** Closes the tabs after one in its row, the pinned left alone. */
export async function closeTabsToRight(path?: string | null, group?: number) {
	const cur = snapshot(state);
	const targetGroup = group ?? cur.activeGroup;
	const g = cur.groups[targetGroup];
	const targetPath = path !== undefined ? path : (g?.active ?? null);
	if (!targetPath || !g) return;
	for (const other of rightOf(g.tabs, g.pinned ?? [], targetPath)) if (!(await closeTab(other, targetGroup))) return;
}

/** Closes every tab that is not pinned: of one group, or of them all. */
export async function closeAllTabs(only?: number) {
	const cur = snapshot(state);
	for (let group = only ?? cur.groups.length - 1; group >= (only ?? 0); group--) {
		const g = snapshot(state).groups[group];
		for (const path of othersOf(g?.tabs ?? [], g?.pinned ?? [], null)) if (!(await closeTab(path, group))) return;
	}
}

/** Told when a tab is about to leave its group for another: the group keeps where the cursor was in it, to hand on. */
export const tabLeaving = new Set<(group: number, path: string) => void>();

/** Moves the open tab to the other group, making one when there is only one. The keyboard's way to do what a drag does. */
export function sendTabAcross() {
	const cur = snapshot(state);
	const path = cur.groups[cur.activeGroup]?.active ?? null;
	if (!path) return;
	if (cur.groups.length === 1 && cur.groups[0]!.tabs.length <= 1) return;
	const from = cur.activeGroup;
	if (cur.groups.length === 1) setState((s) => { s.groups.push({ tabs: [], active: null }); });
	moveTab(path, from, from === 0 ? 1 : 0, null);
}

/**
 * A tab moved by hand: along its row, or to another group's row, to stand
 * before `before` (last, with null). The file stays open as it is, edits and
 * all; a group left with no tabs closes.
 */
export function moveTab(path: string, from: number, to: number, before: string | null) {
	// A tab that is put somewhere by hand is one to keep.
	keepTab(path);
	if (from !== to) tabLeaving.forEach((told) => told(from, path));
	const curGroups = snapshot(state).groups as Group[];
	const next = movedAcross(curGroups, path, from, to, before);
	const removedGroup = next.groups.length < curGroups.length;
	setState((s) => {
		const apply = (target: Group, src: Group) => {
			target.tabs = src.tabs;
			target.active = src.active;
			if (src.pinned) target.pinned = src.pinned;
			else delete target.pinned;
		};
		if (removedGroup) {
			// The group it left is gone: the one it came to is changed where it stands, so that its editor stays.
			if (s.groups[to]) apply(s.groups[to]!, next.groups[next.active]!);
			s.groups.splice(from, 1);
		} else {
			next.groups.forEach((g, i) => {
				if ((i === from || i === to) && s.groups[i]) apply(s.groups[i]!, g);
			});
		}
		s.activeGroup = next.active;
	});
	if (removedGroup) removeRecentGroup(from);
	const targetActive = next.groups[next.active]?.active ?? null;
	onFlush(() => {
		const cur = snapshot(state);
		if (!targetActive || cur.centerView !== "editors" || cur.groups[cur.activeGroup]?.active !== targetActive) return;
		if (from !== to) revealSignal.fire(path);
		focusEditor();
	});
}

/** The open tab one place along its row, left or right, among the pinned or among the others. */
export function shiftTab(by: 1 | -1, group = snapshot(state).activeGroup) {
	const g = snapshot(state).groups[group];
	const path = g?.active;
	if (!g || !path) return;
	const at = g.tabs.indexOf(path);
	const before = by < 0 ? (g.tabs[at - 1] ?? path) : (g.tabs[at + 2] ?? null);
	keepTab(path, group);
	setState((s) => {
		if (s.groups[group]) s.groups[group]!.tabs = placed(g.tabs, g.pinned ?? [], path, before);
	});
}

/** Pins a tab, or lets a pinned one go. */
export function togglePin(path?: string | null, group?: number) {
	const cur = snapshot(state);
	const targetGroup = group ?? cur.activeGroup;
	const g = cur.groups[targetGroup];
	const targetPath = path !== undefined ? path : (g?.active ?? null);
	if (!targetPath || !g?.tabs.includes(targetPath)) return;
	keepTab(targetPath, targetGroup);
	const next = withPin(g.tabs, g.pinned ?? [], targetPath, !g.pinned?.includes(targetPath));
	setState((s) => {
		if (s.groups[targetGroup]) {
			s.groups[targetGroup]!.tabs = next.tabs;
			s.groups[targetGroup]!.pinned = next.pinned;
		}
	});
	rememberTabs();
}

export async function reopenClosedTab() {
	for (let path = closedTabs.pop(); path; path = closedTabs.pop()) {
		if (snapshot(state).groups.some((g) => g.tabs.includes(path!))) continue;
		try {
			await loadDoc(path);
		} catch {
			continue; // Gone from disk since it was closed: try the one before.
		}
		return openFile(path);
	}
	notify("No closed tab to reopen.");
}

/** Told when files are renamed or go, for whatever keeps paths of its own: the places to go back to. */
export const pathChanges = {
	renamed: new Set<(rename: (path: string) => string) => void>(),
	gone: new Set<(gone: (path: string) => boolean) => void>(),
};

/**
 * Lets go of a document that was only read (a search's results, a definition peeked at): it has no tab, so nobody
 * is shown it and nothing else would let it go. One with a tab, or with edits nobody saved, is left alone. Kept
 * past its file, it would be taken for the text of whatever comes to be at that path next.
 */
function letGoIfOnlyRead(path: string) {
	const doc = docs.get(path);
	const cur = snapshot(state);
	if (!doc || isUntitled(path) || cur.dirty[path] || cur.groups.some((g) => g.tabs.includes(path))) return;
	docs.delete(path);
	disposeDoc(doc);
	if (cur.conflicts[path]) setState((s) => { delete s.conflicts[path]; });
}

/** A file or folder was renamed in the Explorer: its open tabs follow it, with their edits. */
export function fileRenamed(oldPath: string, newPath: string) {
	oldPath = canonical(oldPath);
	newPath = canonical(newPath);
	if (oldPath === newPath) return;
	pathChanges.renamed.forEach((told) => told((path) => (path === oldPath ? newPath : isInside(oldPath, path) ? newPath + path.slice(oldPath.length) : path)));
	// What was only read at the new path, or under it, before its file went is not what has come to be there.
	for (const path of [...docs.keys()]) if (path === newPath || isInside(newPath, path)) letGoIfOnlyRead(path);
	const affected = [...docs].filter(([path]) => path === oldPath || isInside(oldPath, path));
	if (!affected.length) {
		invalidateImageCache(oldPath);
		invalidateImageCache(newPath);
		return;
	}
	const curDirty = snapshot(state).dirty;
	const moves: { path: string; target: string; dirty: boolean; doc: Doc; staleTarget?: Doc; kindChanged: boolean; moved: Doc }[] = [];
	for (const [path, doc] of affected) {
		const target = path === oldPath ? newPath : newPath + path.slice(oldPath.length);
		const dirty = Boolean(curDirty[path]);
		const text = doc.model.getValue();
		docs.delete(path);
		const prevTarget = docs.get(target);
		let moved: Doc;
		let staleTarget: Doc | undefined;
		let kindChanged = false;
		if (prevTarget && prevTarget !== doc && !prevTarget.model.isDisposed()) {
			// Reuse the live Monaco model at `target` in place so any editor displaying `target` never sees its model disposed.
			kindChanged = Boolean(prevTarget.binary) !== Boolean(doc.binary) || Boolean(prevTarget.binary && doc.binary);
			prevTarget.encoding = doc.encoding;
			prevTarget.binary = doc.binary;
			prevTarget.savedText = doc.savedText;
			prevTarget.mtime = doc.mtime;
			prevTarget.model.setEOL(doc.model.getEOL() === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
			if (prevTarget.model.getValue() !== text) {
				prevTarget.model.pushEditOperations([], [{ range: prevTarget.model.getFullModelRange(), text }], () => null);
			}
			prevTarget.savedVersion = !dirty && text === doc.savedText ? prevTarget.model.getAlternativeVersionId() : -1;
			moved = prevTarget;
		} else {
			if (prevTarget && prevTarget !== doc) {
				docs.delete(target);
				staleTarget = prevTarget;
			}
			moved = attach(target, text, { text: doc.savedText, mtime: doc.mtime });
			moved.encoding = doc.encoding;
			moved.binary = doc.binary;
		}
		moves.push({ path, target, dirty, doc, staleTarget, kindChanged, moved });
	}
	const anyKindChanged = moves.some((m) => m.kindChanged);
	setState((s) => {
		for (const { path, target, dirty, moved } of moves) {
			for (const g of s.groups) {
				const hadPath = g.tabs.includes(path);
				const hadTarget = g.tabs.includes(target);
				g.tabs = [...new Set(g.tabs.map((tab) => (tab === path ? target : tab)))];
				if (g.pinned) g.pinned = [...new Set(g.pinned.map((tab) => (tab === path ? target : tab)))];
				if (g.preview === path) g.preview = hadTarget ? null : target;
				else if (hadPath && g.preview === target) g.preview = null;
				if (g.active === path) g.active = target;
			}
			delete s.dirty[path];
			delete s.conflicts[path];
			delete s.conflicts[target];
			s.dirty[target] = dirty || moved.savedVersion === -1;
		}
		if (anyKindChanged) s.kindVersion += 1;
	});
	// Commit updated tabs before disposing old Monaco models so editors detach first.
	flush();
	for (const { path, target, doc, staleTarget } of moves) {
		clearEditorViewStates(path);
		invalidateImageCache(path);
		invalidateImageCache(target);
		if (staleTarget) disposeDoc(staleTarget);
		disposeDoc(doc);
	}
}

const isScript = (path: string) => /\.(srvscr|ssl|ds)(\.txt)?$/i.test(path);

/**
 * Tells the language server of scripts that have come to be at a path, or under it, without being written by a
 * save: after a move (`from` is where they were, which it is told are gone) or a copy. It hears of files only as
 * they are named to it, and a folder's move names none of the scripts in it.
 */
export async function scriptsCameTo(to: string, from?: string, kind: "file" | "dir" = "dir") {
	to = canonical(to);
	// One file is itself, a script or not: only a folder's scripts have to be looked for.
	const found = kind === "file" ? [to] : (await backend.files().catch(() => [] as string[])).map(canonical);
	const here = found.filter((path) => (path === to || isInside(to, path)) && isScript(path));
	for (const path of here) {
		if (from) session.fileChanged(canonical(from) + path.slice(to.length), false);
		session.fileChanged(path, true);
	}
	if (here.length) recheckPlans();
}

/**
 * What is held at a path, or under it: a tab, or edits nobody saved in a document that has no tab (a rename across
 * files changes scripts that are not open). A file that was only read (for a search's results, a definition) is
 * neither, and does not count.
 */
function heldAt(path: string): { kind: "tab" | "unsaved"; path: string } | null {
	const at = canonical(path);
	const there = (other: string) => other === at || isInside(at, other);
	const cur = snapshot(state);
	for (const group of cur.groups) for (const tab of group.tabs) if (there(tab)) return { kind: "tab", path: tab };
	for (const other of docs.keys()) if (there(other) && cur.dirty[other]) return { kind: "unsaved", path: other };
	return null;
}

/**
 * A path nothing is at on disk may still have a tab on it, or edits nobody saved: a file that was removed, kept
 * for them. A file put there (moved, copied or made new) would be taken for it. Says so, and says true, when that
 * is so. Where something is there on disk the path is simply taken, and whoever writes there says that instead.
 */
export async function heldFromBefore(to: string): Promise<boolean> {
	const held = heldAt(to);
	if (!held) return false;
	// Asked of the disk itself, which knows whether two spellings of a name are one file, and of names no list shows.
	const onDisk = await backend.sizes([to]).then(
		(sizes) => to in sizes,
		() => false,
	);
	if (onDisk) return false;
	if (held.kind === "tab") notify(`${baseName(held.path)} is still open in a tab from before it was removed. Close that tab first, then try again.`, "error");
	else
		notify(`${baseName(held.path)} was removed while it held changes nobody saved. Open it to save them or to give them up: the name is free once they are given up.`, "error", {
			label: "Open it",
			run: () => void openFile(held.path),
		});
	return true;
}

/** A file or folder went to the trash: its tabs close, except those holding edits nobody saved. */
export function fileRemoved(removed: string) {
	removed = canonical(removed);
	const dirtyNow = snapshot(state).dirty;
	// A file whose unsaved edits stay open is still somewhere to go.
	pathChanges.gone.forEach((told) => told((path) => (path === removed || isInside(removed, path)) && !dirtyNow[path]));
	for (const path of [...docs.keys()]) {
		if (path !== removed && !isInside(removed, path)) continue;
		const cur = snapshot(state);
		if (cur.dirty[path]) {
			notify(`${baseName(path)} was moved to the trash. Its unsaved edits are still open: save to put the file back.`, "error");
			continue;
		}
		// From the last group back: a group left empty goes, and those after it move up a place.
		for (let i = cur.groups.length - 1; i >= 0; i--) {
			if (snapshot(state).groups[i]?.tabs.includes(path)) void closeTab(path, i, { discard: true, pinned: true });
		}
		letGoIfOnlyRead(path);
	}
}

/** Opens a file in the group beside the one at hand, which is made if there is none. */
export async function openToSide(path: string) {
	const curBefore = snapshot(state);
	// With nothing open there is no side to open it to: it opens where a file would.
	if (curBefore.groups.length === 1 && !curBefore.groups[0]!.tabs.length) return openFile(path, { keep: true });
	const made = curBefore.groups.length === 1;
	if (made) setState((s) => { s.groups.push({ tabs: [], active: null }); });
	await openFile(path, { group: curBefore.activeGroup === 0 ? 1 : 0, keep: true });
	// A file that could not be read opened nothing: the group made for it is not left standing empty.
	const curAfter = snapshot(state);
	if (made && curAfter.groups.length === 2 && !curAfter.groups[1]!.tabs.length) {
		setState((s) => {
			s.groups = s.groups.slice(0, 1);
			s.activeGroup = 0;
		});
		removeRecentGroup(1);
	}
}

export function split() {
	const cur = snapshot(state);
	const path = cur.groups[cur.activeGroup]?.active ?? null;
	if (path) void openToSide(path);
}

/**
 * The file on disk is not the one these edits started from. Nothing is written
 * until the user has chosen; says whether to go on and write.
 */
async function settleConflict(doc: Doc, unasked?: (why: string, asks?: boolean) => void): Promise<boolean> {
	let disk;
	try {
		disk = await backend.read(doc.path);
	} catch {
		return docs.get(doc.path) === doc && !doc.model.isDisposed(); // Deleted or moved on disk: saving puts it back.
	}
	if (docs.get(doc.path) !== doc || doc.model.isDisposed()) return false;
	if (disk.mtime === doc.mtime) return true;
	// Bytes where there was text have no text to compare: they are a change, whatever the empty text of them equals.
	const turnedBytes = Boolean(disk.binary) && !doc.binary;
	if (!turnedBytes && (disk.text === doc.savedText || disk.text === doc.model.getValue())) return true;
	// Where nothing can be asked (see `saveAllUnasked`) the file on disk stays as it is, and that is the answer.
	if (unasked) return unasked("it changed on disk after it was opened, and which of the two to keep cannot be asked here", true), false;
	const name = baseName(doc.path);
	const answer = await choose(`${name} changed on disk after you opened it. Saving would replace what is there.`, ["Compare", "Overwrite the file on disk", "Reload from disk"], { danger: "Overwrite the file on disk" });
	if (docs.get(doc.path) !== doc || doc.model.isDisposed()) return false;
	if (answer === "Overwrite the file on disk") return true;
	if (answer === "Reload from disk") await revert(doc.path);
	if (answer === "Compare") void reviewConflict(doc, disk);
	return false;
}

/** The same text, line ends apart: a review's right side has the line ends of its left, whatever the document has. */
const sameButLineEnds = (a: string, b: string) => a === b || a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/**
 * The review of a file that changed on disk, against the edits made here: `disk` is the file as it was just read,
 * and `shown` what stands on the right, which is the document unless it is given.
 *
 * "Keep mine and save" acts on the document and the file as they are when it is chosen, not as they were when the
 * review opened. It wrote the text the review was opened with: a property set in the Info panel, a table action or
 * a replace made while the review stood open was undone by it without a word, and whether the text went into the
 * document and the save went through was not looked at, so a save that failed closed the review as if it had not.
 * Now, if the document or the file is no longer what the review shows, nothing is applied and the review is opened
 * again on both as they are. One case cannot be shown in two columns: the document changed elsewhere and the right
 * side was edited here too. Then the review stays as it is and says so, for the edits made in it to be copied out.
 */
function reviewConflict(doc: Doc, disk: { text: string; mtime: number; binary?: unknown }, shown = doc.model.getValue()): Promise<boolean> {
	const name = baseName(doc.path);
	/** The document's text that the right side stands for: as the review found it, then as the review left it. */
	let known = doc.model.getValue();
	const openAsText = () => docs.get(doc.path) === doc && !doc.model.isDisposed() && !doc.binary;
	return openReview({
		title: `${name}: the file on disk, against your edits`,
		original: disk.text,
		proposed: shown,
		language: doc.model.getLanguageId(),
		note: "Left: the file as it is on disk now. Right: your edits, which you can change here. Accept keeps the right side and saves it over the file.",
		acceptLabel: "Keep mine and save",
		onAccept: async (text) => {
			// What is still being typed in a cell or a field is part of the document as it is now.
			commitPendingEdits();
			if (!openAsText()) throw new Error(`${name} is no longer open as text`);
			// The file as it is now. Gone from the disk, there is nothing there to lose: the save puts it back.
			const now = await backend.read(doc.path).catch(() => null);
			if (!openAsText()) throw new Error(`${name} is no longer open as text`);
			const docChanged = doc.model.getValue() !== known;
			const diskChanged = Boolean(now) && (Boolean(now!.binary) !== Boolean(disk.binary) || now!.text !== disk.text);
			if (docChanged || diskChanged) {
				// Edited here: the right side is not the document the review was opened on. (It may have been given so:
				// the right side of a review before this one, kept when the file changed again.)
				if (docChanged && !sameButLineEnds(text, known)) {
					throw new Error(`${name} was also changed outside this review, and keeping the right side as it stands would undo that. Copy what you changed here, close the review, and save again`);
				}
				const where = docChanged ? (diskChanged ? "in the app and on disk" : "in the app") : "on disk again";
				notify(`${name} changed ${where} while the review was open. Nothing was saved: the review now shows both sides as they are.`);
				// The review that is being accepted gives way to the next without a question (reviewFlow).
				await reviewConflict(doc, now ?? disk, docChanged ? undefined : text);
				return;
			}
			if (!applyText(doc.path, text)) throw new Error(`${name} is no longer open as text`);
			known = doc.model.getValue();
			// The save that follows starts from the file as it is: it was looked at here, and is not asked about again.
			if (now) {
				doc.mtime = now.mtime;
				doc.savedText = now.text;
			}
			// Why it was not saved has been said by the save itself. The review stays open, and says that it was not.
			if (!(await save(doc.path))) throw new Error(`${name} was not saved: the right side is in the document now, unsaved`);
		},
	});
}

/** Says whether the file is on disk as it is in the editor. */
export async function save(
	path?: string | null,
	options: {
		/** False to leave the lines as they are, whatever the setting says. */
		format?: boolean;
		/** Receives the promoted file path when saving an untitled buffer. */
		onPromoted?: (target: string) => void;
		/**
		 * For where no question can be asked and no notice is seen (`saveAllUnasked`): a file that needs a question is
		 * not saved, and this is told why any file was not, in words that follow its name. `asks` when it is for want
		 * of a question.
		 */
		unasked?: (why: string, asks?: boolean) => void;
	} = {},
): Promise<Saved> {
	// What is being typed in an open cell is part of what is saved.
	commitPendingEdits();
	const curStart = snapshot(state);
	const resolvedPath = path === undefined ? (curStart.groups[curStart.activeGroup]?.active ?? null) : path;
	if (!resolvedPath) return false;
	path = resolvedPath;
	const doc = docs.get(path);
	if (!doc || doc.model.isDisposed()) return options.unasked?.("it is no longer open"), false;
	// First save of a floating untitled buffer: ask for a path, write to disk, and promote the tab.
	if (isUntitled(path)) {
		if (options.unasked) return options.unasked("it has no file name yet, and one cannot be asked for here", true), false;
		const root = snapshot(state).workspace?.root;
		const suggested = `${displayName(path)}.ssl`;
		const entered = (await ask(root ? "Save file as (relative to workspace, or absolute path)" : "Save file as (absolute path)", suggested))?.trim();
		if (!entered) return false;
		if (docs.get(path) !== doc || doc.model.isDisposed()) return false;
		const isAbs = entered.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entered);
		if (!isAbs && !root) return notify("Open a folder or enter an absolute file path to save.", "error"), false;
		const target = canonical(isAbs ? entered : joinPath(root!, ...entered.split(/[\\/]/).filter(Boolean)));
		const onDisk = await backend
			.sizes([target])
			.then((sizes) => Boolean(sizes && (target in sizes || Object.keys(sizes).some((k) => canonical(k) === target))))
			.catch(() => false);
		if (docs.get(path) !== doc || doc.model.isDisposed()) return false;
		const existingBefore = docs.get(target);
		const isOpen = Boolean(existingBefore && !existingBefore.model.isDisposed());
		const isDirtyTarget = Boolean(snapshot(state).dirty[target]);
		if (onDisk || isOpen || isDirtyTarget) {
			const prompt = isDirtyTarget
				? `${baseName(target)} is already open with unsaved edits. Overwriting it will replace both those edits and the file on disk.`
				: `${baseName(target)} already exists. Overwriting it will replace its contents.`;
			const answer = await choose(prompt, ["Overwrite"], { danger: "Overwrite" });
			if (answer !== "Overwrite") return false;
			if (docs.get(path) !== doc || doc.model.isDisposed()) return false;
		}
		const version = doc.model.getAlternativeVersionId();
		const text = doc.model.getValue();
		const created = await guarded(async () => {
			await backend.create(target, "file").catch(() => undefined);
			return backend.write(target, text, true);
		});
		if (!created) return false;
		if (docs.get(path) !== doc || doc.model.isDisposed()) return false;
		const currentText = doc.model.getValue();
		const stillDirty = doc.model.getAlternativeVersionId() !== version && currentText !== text;
		const existing = docs.get(target);
		let realDoc: Doc;
		let wasBinary = false;
		if (existing && !existing.model.isDisposed()) {
			wasBinary = Boolean(existing.binary);
			existing.encoding = "utf-8";
			existing.binary = undefined;
			existing.savedText = text;
			existing.mtime = created.mtime;
			const nextEol = currentText.includes("\n")
				? lineEnds(currentText) === "\r\n"
					? monaco.editor.EndOfLineSequence.CRLF
					: monaco.editor.EndOfLineSequence.LF
				: doc.model.getEOL() === "\r\n"
					? monaco.editor.EndOfLineSequence.CRLF
					: monaco.editor.EndOfLineSequence.LF;
			existing.model.setEOL(nextEol);
			if (existing.model.getValue() !== currentText) {
				existing.model.pushEditOperations([], [{ range: existing.model.getFullModelRange(), text: currentText }], () => null);
			}
			existing.savedVersion = stillDirty ? -1 : existing.model.getAlternativeVersionId();
			realDoc = existing;
		} else {
			realDoc = attach(target, currentText, { text, mtime: created.mtime });
			realDoc.encoding = "utf-8";
		}
		setState((s) => {
			for (const g of s.groups) {
				const idx = g.tabs.indexOf(path);
				if (idx >= 0) {
					if (g.tabs.includes(target)) g.tabs.splice(idx, 1);
					else g.tabs[idx] = target;
				}
				if (g.active === path) g.active = target;
				if (g.pinned) g.pinned = [...new Set(g.pinned.map((p) => (p === path ? target : p)))];
				if (g.preview === path || (idx >= 0 && g.preview === target)) g.preview = null;
			}
			delete s.dirty[path];
			s.dirty[target] = stillDirty;
			delete s.conflicts[target];
			s.treeVersion += 1;
			if (wasBinary) s.kindVersion += 1;
		});
		// Commit the promoted tab before disposing the untitled Monaco model so editors detach first.
		flush();
		pathChanges.renamed.forEach((told) => told((p) => (p === path ? target : p)));
		clearEditorViewStates(path);
		if (wasBinary) invalidateImageCache(target);
		if (docs.get(path) === doc) docs.delete(path);
		disposeDoc(doc);
		session.saved(realDoc.model);
		historyChanged.fire(target);
		options.onPromoted?.(target);
		return true;
	}
	// A picture, or other bytes: there is no text of it here to save.
	if (doc.binary) return notify(`${baseName(path)} is not text: there is nothing of it to save here.`), options.unasked?.("it is not text"), false;
	if (!(await settleConflict(doc, options.unasked))) return false;
	if (docs.get(path) !== doc || doc.model.isDisposed()) return false;
	const curBeforeFormat = snapshot(state);
	if (options.format !== false && curBeforeFormat.settings.formatOnSave && doc.model.getLanguageId() === "ssl" && curBeforeFormat.lsp.state === "running") {
		await formatChanged(doc);
		if (docs.get(path) !== doc || doc.model.isDisposed()) return false;
	}
	const version = doc.model.getAlternativeVersionId();
	// A table Excel wrote keeps its bare LF inside cells: the model made every line end of it CRLF when it was opened.
	const text = tableTextToWrite(path, doc.model.getValue(), doc.savedText);
	// "It was read as text": a file that holds a zero byte the user typed is still theirs to save.
	let result: { mtime: number };
	try {
		result = await backend.write(path, text, true);
	} catch (e: any) {
		// Said as a notice, as every failure is, and told to whoever cannot see one.
		const message = String(e?.message ?? e);
		notify(message, "error");
		options.unasked?.(plainFileError(message, snapshot(state).workspace?.root));
		return false;
	}
	if (!result) return false;
	if (docs.get(path) !== doc || doc.model.isDisposed()) return false;
	doc.savedText = text;
	doc.savedVersion = version;
	doc.mtime = result.mtime;
	const stillDirty = doc.model.getAlternativeVersionId() !== version && doc.model.getValue() !== text;
	setState((s) => {
		s.dirty[path] = stillDirty;
		delete s.conflicts[path];
		s.treeVersion += 1;
	});
	session.saved(doc.model);
	historyChanged.fire(path);
	// project.toml chooses the docs folders, and the model and style for this project.
	const curProj = snapshot(state).project;
	if (curProj && path === canonical(curProj.path)) await Promise.all([loadProject(), loadSettings()]);
	return true;
}

export const historyChanged = (() => {
	const listeners = new Set<(path: string) => void>();
	return {
		fire: (path: string) => listeners.forEach((l) => l(path)),
		listen: (l: (path: string) => void) => (listeners.add(l), () => listeners.delete(l)),
	};
})();

/**
 * The size, in characters, up to which a save formats the whole document to take the changed lines from. The
 * server formats a script of this size in a few tenths of a second; a larger one is asked for its ranges alone.
 */
const FORMAT_WHOLE_UP_TO = 400_000;

/**
 * Format on save formats only the lines changed since the last save (ARCHITECTURE), and leaves them as "Format
 * document" would: they are taken from a format of the whole document (`formatRangesAsDocument`).
 */
async function formatChanged(doc: Doc) {
	if (doc.model.isDisposed()) return;
	const eol = doc.model.getEOL();
	const version = doc.model.getAlternativeVersionId();
	let ranges = changedRanges(doc.savedText.split(/\r?\n/), doc.model.getValue().split(eol));
	if (!ranges.length) return;
	try {
		// A lone line formats without its block's indentation: widen each range
		// to the procedure the server says it is in.
		ranges = widenToProcedures(ranges, await session.documentSymbols(doc.model).catch(() => []));
		if (doc.model.isDisposed() || doc.model.getAlternativeVersionId() !== version) return;
		// Where the whole document is too large to format on every save, or its formatted text cannot be set beside
		// it, the ranges are formatted on their own: the server then leaves out its whole-document passes.
		const whole = doc.model.getValueLength() <= FORMAT_WHOLE_UP_TO ? await session.formatRangesAsDocument(doc.model, ranges, doc.model.getOptions()) : null;
		if (doc.model.isDisposed() || doc.model.getAlternativeVersionId() !== version) return;
		const edits = whole ?? (await session.formatRanges(doc.model, ranges, doc.model.getOptions(), true));
		if (doc.model.isDisposed() || doc.model.getAlternativeVersionId() !== version) return;
		if (edits.length) applyAsOneStep(doc.model, edits, "format-on-save");
	} catch (e: any) {
		log(`format on save skipped: ${e?.message ?? e}`);
	}
}

/**
 * Edits made for the user and not by them, as one step of undo of their own. Without the stops on either side
 * the formatting of a save joined the typing before it, and one undo took both away: the formatting, and the
 * last words typed.
 *
 * They go through an editor that shows the document, where there is one, so that the step holds where the cursor
 * was and undo puts it back there.
 */
function applyAsOneStep(model: monaco.editor.ITextModel, edits: monaco.editor.IIdentifiedSingleEditOperation[], source: string) {
	const showing = monaco.editor.getEditors().filter((editor) => editor.getModel() === model);
	const editor = showing.find((candidate) => candidate.hasTextFocus()) ?? showing[0];
	if (editor) {
		editor.pushUndoStop();
		// False from an editor that may not be written in (a read-only view of the file): the model takes them.
		if (editor.executeEdits(source, edits)) return void editor.pushUndoStop();
	}
	model.pushStackElement();
	model.pushEditOperations([], edits, () => null);
	model.pushStackElement();
}

const PROCEDURE_KINDS = new Set([monaco.languages.SymbolKind.Function, monaco.languages.SymbolKind.Method, monaco.languages.SymbolKind.Constructor]);
const MAX_WIDENED_LINES = 600;

export function widenToProcedures(ranges: [number, number][], symbols: monaco.languages.DocumentSymbol[]): [number, number][] {
	const procedures: [number, number][] = [];
	const walk = (list: monaco.languages.DocumentSymbol[]) => {
		for (const s of list) {
			if (PROCEDURE_KINDS.has(s.kind)) procedures.push([s.range.startLineNumber - 1, s.range.endLineNumber - 1]);
			else walk(s.children ?? []);
		}
	};
	walk(symbols);
	const widened = ranges.map(([start, end]): [number, number] => {
		const p = procedures.find(([ps, pe]) => ps <= start && end <= pe && pe - ps < MAX_WIDENED_LINES);
		return p ? [p[0], p[1]] : [start, end];
	});
	return widened
		.sort((a, b) => a[0] - b[0])
		.reduce<[number, number][]>((out, r) => {
			const last = out.at(-1);
			if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
			else out.push([...r]);
			return out;
		}, []);
}

/**
 * Switches an open text document's Monaco language mode (VS Code "Change Language Mode") and updates LSP & reactive views.
 * `chosen` says a person picked the mode: it then stays until they pick another, unless what they picked is the
 * mode the document would have anyway, which is to go back to having it worked out.
 */
export function setDocumentLanguage(path: string, languageId: string, chosen = true): boolean {
	const doc = docs.get(canonical(path));
	if (!doc || doc.binary || doc.model.isDisposed()) return false;
	if (chosen) doc.languageChosen = languageId !== detectedLanguage(doc);
	const prev = doc.model.getLanguageId();
	if (prev === languageId) return false;
	doc.validatorDispose?.();
	doc.validatorDispose = undefined;
	monaco.editor.setModelLanguage(doc.model, languageId);
	// The server is told of what it reads in the new mode, and no longer of what it does not. A data source shown
	// as SQL it reads still, so its findings there are kept.
	if (session.reads(doc.model)) session.track(doc.model);
	else session.untrack(doc.model);
	if (languageId === "ssl") setHouseIndent(doc.model);
	else doc.validatorDispose = attachValidator(doc.model, doc.path, languageId);
	setState((s) => {
		s.kindVersion += 1;
	});
	return true;
}

/** Replaces a document's text with one undoable edit over the part that changed. */
export function applyText(path: string, text: string): boolean {
	const doc = docs.get(path);
	if (!doc || doc.model.isDisposed()) return false;
	const edit = minimalReplace(doc.model.getValue(), text.replace(/\r?\n/g, doc.model.getEOL()));
	if (!edit) return true;
	doc.model.pushStackElement();
	doc.model.pushEditOperations(
		[],
		[{ range: monaco.Range.fromPositions(doc.model.getPositionAt(edit.start), doc.model.getPositionAt(edit.end)), text: edit.text }],
		() => null,
	);
	doc.model.pushStackElement();
	return true;
}

/** Says whether every file was saved: it stops at the first that could not be. */
export async function saveAll(): Promise<Saved> {
	// First, so that a file whose only change is a cell still being typed in is among the unsaved ones.
	commitPendingEdits();
	for (const path of snapshotUnsavedPaths()) if (!(await save(path))) return false;
	return true;
}

/** A file that could not be saved where nothing can be asked, and why, in words that follow its name. */
export type NotSaved = { path: string; why: string; /** It needs a question, which only the editor can ask. */ asks?: boolean };

/**
 * Saves every unsaved file without asking anything, and answers with those it could not save and why. For the
 * card that stands in the app's place when its view has failed (main.tsx): the dialogs and the notices are part
 * of what the card replaced, so `saveAll` from there said nothing when a save failed, and never came back from a
 * file that needs a question (one changed on disk, one with no name yet). Here such a file is left as it is and
 * named, every other file is still tried, and nothing is formatted first: that asks the language server, and this
 * is the way out when something is already wrong.
 */
export async function saveAllUnasked(): Promise<NotSaved[]> {
	commitPendingEdits();
	const notSaved: NotSaved[] = [];
	for (const path of snapshotUnsavedPaths()) {
		let why = "";
		let asks = false;
		let saved = false;
		try {
			saved = await save(path, { format: false, unasked: (reason, question) => ((why = reason), (asks = Boolean(question))) });
		} catch (e: any) {
			why = String(e?.message ?? e);
		}
		if (!saved) notSaved.push({ path, why: why || "it could not be saved", ...(asks ? { asks } : {}) });
	}
	return notSaved;
}

/**
 * What the card says of files `saveAllUnasked` could not save: a line that counts them, a line for each, and what
 * to do about those that need a question. A reason that names its file itself (what the file system said of it)
 * stands alone on its line; any other follows the file's name.
 */
export function notSavedText(notSaved: readonly NotSaved[]): string {
	if (!notSaved.length) return "";
	const line = (file: NotSaved) => {
		const name = displayName(file.path);
		const why = `${file.why.replace(/\.$/, "")}.`;
		return why.includes(name) ? why : `${name}: ${why}`;
	};
	const lines = [notSaved.length === 1 ? "1 file was not saved:" : `${notSaved.length} files were not saved:`, ...notSaved.map(line)];
	if (notSaved.some((file) => file.asks)) lines.push("“Try again” may bring the editor back, where that can be asked.");
	return lines.join("\n");
}

function applyFileToDoc(path: string, doc: Doc, file: { text: string; mtime: number; encoding?: string; binary?: { size: number; image?: string } }) {
	doc.encoding = file.encoding;
	doc.binary = file.binary;
	// The line ends go back to the file's too: put in as an edit, the text would take on whichever kind the editor
	// has now, and a change of line ends would survive the revert unseen.
	// A text of one line has no line end to go back to: the editor keeps the kind it gave it when it was opened.
	if (file.text.includes("\n")) doc.model.setEOL(lineEnds(file.text) === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
	doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: file.text }], () => null);
	doc.savedText = file.text;
	doc.savedVersion = doc.model.getAlternativeVersionId();
	doc.mtime = file.mtime;
	setState((s) => {
		s.dirty[path] = false;
		delete s.conflicts[path];
		s.kindVersion += 1;
	});
}

export async function revert(path: string) {
	if (isUntitled(path)) return;
	const doc = docs.get(path);
	if (!doc || doc.model.isDisposed()) return;
	const file = await guarded(() => backend.read(path));
	// The document may have been let go, or moved away, while the file was read.
	if (!file || docs.get(path) !== doc || doc.model.isDisposed()) return;
	applyFileToDoc(path, doc, file);
}

on("fileChanged", ({ path }) => fileChangedOnDisk(path));

/** Files the app itself is about to change on disk, and will see to afterwards: what the watcher says of them meanwhile is not news. */
const awaited = new Set<string>();
/** Brackets a change the app makes to a file on disk by some way other than a save (a discard): no alarm is raised for it. */
export async function changingOnDisk<T>(path: string, change: () => Promise<T>): Promise<T> {
	const at = canonical(path);
	awaited.add(at);
	try {
		return await change();
	} finally {
		awaited.delete(at);
	}
}

/** A file was changed on disk by something other than a save here: the tree, the language server and an open copy follow. */
export async function fileChangedOnDisk(changed: string) {
	const path = canonical(changed);
	if (awaited.has(path)) return;
	const startRoot = snapshot(state).workspace?.root;
	invalidateImageCache(path);
	setState((s) => {
		s.treeVersion += 1;
	});
	const doc = docs.get(path);
	// The kinds of file the server asks to be told about.
	const script = isScript(path);
	if (!doc && !script) return;
	const told = (exists: boolean) => {
		if (!script) return;
		session.fileChanged(path, exists);
		recheckPlans();
	};
	let file;
	try {
		file = await backend.read(path);
	} catch {
		if (snapshot(state).workspace?.root === startRoot) {
			told(false);
			// Deleted or moved: a copy open in a tab is kept, and one that was only read is not.
			letGoIfOnlyRead(path);
		}
		return;
	}
	const cur = snapshot(state);
	if (!cur.workspace || cur.workspace.root !== startRoot || !isInside(cur.workspace.root, path)) return;
	told(true);
	// It may have been let go, or moved away, while the file was read.
	if (!doc || docs.get(path) !== doc || doc.model.isDisposed()) return;
	// A picture, or other bytes, has no text to compare: a later date on it is the change.
	if (doc.binary && file.binary) {
		if (file.mtime !== doc.mtime) {
			doc.mtime = file.mtime;
			doc.binary = file.binary;
			setState((s) => {
				s.kindVersion += 1;
			});
		}
		return;
	}
	// Text that turned into bytes, or bytes into text, is a change whatever the two texts are (bytes have none).
	const turned = Boolean(file.binary) !== Boolean(doc.binary);
	if (!turned && file.text === doc.model.getValue()) return;
	// The file is as these edits found it (it was only moved, or touched): nothing on disk has changed under them.
	if (!turned && file.text === doc.savedText) {
		doc.mtime = file.mtime;
		return;
	}
	if (cur.dirty[path]) {
		if (!cur.conflicts[path]) notify(`${baseName(path)} changed on disk while you have unsaved edits. Saving will ask which to keep.`, "error");
		setState((s) => {
			s.conflicts[path] = true;
		});
	} else if (!cur.dirty[path] && cur.workspace && isInside(cur.workspace.root, path)) {
		applyFileToDoc(path, doc, file);
		log(`reloaded ${path} after an external change`);
	}
}

// The backend has something to say that no call's answer carries (a save whose copy for local history was not made).
on("notice", (said) => {
	if (typeof said?.text === "string" && said.text) notify(said.text, said.kind === "error" ? "error" : "info");
});

// The desktop window was asked to close with edits that are not on disk, or with a view open that may hold text
// still being typed: `leaveUnsavedKept` puts that text in its document, has what is unsaved kept, and the app is
// closed without a question (ADR 0042). It asks only where the text could not be kept.
let closePromptOpen = false;
on("closeRequested", async () => {
	if (closePromptOpen) return;
	closePromptOpen = true;
	try {
		if (await leaveUnsavedKept("Closing the window would lose them.")) await backend.closeWindow();
	} finally {
		closePromptOpen = false;
	}
});

on("lspState", (lsp) => {
	setState((s) => {
		reconcile(lsp, null)(s.lsp);
	});
	if (lsp.message) log(lsp.message);
});
