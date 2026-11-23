// App state: the workspace, open documents, editor groups and panels.
// Documents are Monaco models; the text in them is the source of truth
// (ADR 0002).
import { batch, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { DEFAULT_SETTINGS, type Info, type LspState, type Project, type Settings, type SettingsPatch, type ThemeFile, type Workspace } from "../shared/protocol";
import { backend, on } from "./backend";
import { monaco } from "./editor/monaco";
import { languageFor, setFormattingHost } from "./editor/languages";
import { DEFAULT_SQL_DIALECT } from "../shared/format";
import { getPath, SERVER_DEFAULTS } from "../shared/styleProfile";
import { session } from "./lsp/session";
import { changedRanges, minimalReplace } from "./lsp/edits";
import { ask, choose } from "./dialogs";
import { closeComparison, openReview } from "./editor/Review";
import { baseName, isInside, joinPath, plainFileError } from "../shared/paths";
import { lineEnds } from "../shared/fileKind";
import { isPlanPath } from "./plan/model";
import { recheckPlans, trackPlan } from "./plan/check";
import { trackDoc, trackJson, trackToml, trackXml } from "./docCheck";
import { recall, remember } from "./graph/canvas";
import { packTabs, packViews, tabsKey, unpackTabs, unpackViews, viewsKey } from "./editor/sessionTabs";
import { movedAcross, othersOf, placed, previewed, rightOf, withPin } from "../shared/tabOrder";

export type Group = { tabs: string[]; active: string | null; mode?: "text" | "blocks"; /** The tabs that stay: first in the row, and not closed with the others. */ pinned?: string[]; /** The tab opened for a look (one click in a list): the next such file takes its place. Shown in italics. */ preview?: string | null };
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
};

export const [state, setState] = createStore({
	workspace: null as Workspace | null,
	/** The open folder's project settings; null until a folder is open. */
	project: null as Project | null,
	/** The "set up project" offer was turned down for this folder. */
	setupDismissed: false,
	info: null as Info | null,
	lsp: { state: "stopped" } as LspState,
	settings: DEFAULT_SETTINGS as Settings,
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
	/** Plans shown as raw JSON source; a plan opens as its chart. */
	planText: {} as Record<string, boolean>,
	/** Plan view mode per file: Source (raw JSON), Text (readable outline & focus), Chart (visual flowchart). */
	planMode: {} as Record<string, "source" | "text" | "chart">,
	/** Markdown shown as text; a Markdown file opens rendered. */
	mdText: {} as Record<string, boolean>,
	/** Obsidian-style Markdown view mode per file: Source (raw), Live (formatted edit), Read (rendered page). */
	mdMode: {} as Record<string, "source" | "live" | "read">,
	messages: [] as Message[],
	output: [] as string[],
	cursor: { line: 1, column: 1 },
	/** Bumped when the tree should reload a folder. */
	treeVersion: 0,
	quickPick: null as null | "files" | "commands" | "symbols",
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
		text = plainFileError(text, state.workspace?.root);
	}
	setState("messages", (list) => [...list.filter((m) => m.text !== text).slice(-4), { id, kind, text, action }]);
	// A note that offers something to do stays long enough to do it.
	if (kind !== "error") setTimeout(() => dismiss(id), action ? 20000 : 4000);
}

export const dismiss = (id: number) => setState("messages", (list) => list.filter((m) => m.id !== id));

export function log(line: string) {
	setState("output", (list) => [...list.slice(-499), `${new Date().toLocaleTimeString()}  ${line}`]);
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
	if (!state.settings.layout.left) setState("settings", "layout", "left", true);
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

/** Files with edits that are not on disk. */
export const unsavedPaths = () => Object.keys(state.dirty).filter((path) => state.dirty[path]);

/**
 * Before anything that would drop every open document. Says whether to go on:
 * nothing unsaved, everything saved, or the user chose to discard.
 */
export async function settleUnsaved(what: string): Promise<boolean> {
	const unsaved = unsavedPaths();
	if (!unsaved.length) return true;
	const names = unsaved.slice(0, 3).map(baseName).join(", ") + (unsaved.length > 3 ? ` and ${unsaved.length - 3} more` : "");
	const answer = await choose(`${unsaved.length === 1 ? "1 file has" : `${unsaved.length} files have`} unsaved changes (${names}). ${what}`, ["Save all", "Discard changes"], { danger: "Discard changes" });
	if (answer === "Save all") return saveAll();
	return answer === "Discard changes";
}

export async function openFolder(path?: string) {
	if (!(await settleUnsaved("Opening another folder closes them."))) return;
	const workspace = await guarded(() => backend.openFolder(path));
	if (!workspace) return;
	setTabsReady(false);
	for (const doc of docs.values()) doc.model.dispose();
	docs.clear();
	batch(() => {
		setState("workspace", workspace);
		setState("groups", [{ tabs: [], active: null }]);
		setState("activeGroup", 0);
		setState("dirty", {});
		setState("conflicts", {});
		// What was said about the folder that is gone is no longer news.
		setState("messages", []);
		setState("centerView", "editors");
		setState("treeVersion", (v) => v + 1);
		setState("project", null);
		setState("setupDismissed", false);
	});
	await Promise.all([loadSettings(true), loadProject()]);
	setState("info", await backend.info());
	setState("lsp", await backend.lspState());
	void session.start(workspace.root);
	log(`opened ${workspace.root}`);
	await restoreTabs();
}

// --- the tabs a folder was left with ---------------------------------------------

/** False while a folder is being opened: its tabs are not yet the ones to remember. */
const [tabsReady, setTabsReady] = createSignal(false);
export const isTabsReady = tabsReady;

/** Keeps which files are open in this folder, for the next time it is opened. */
export function rememberTabs() {
	const root = state.workspace?.root;
	if (!root || !tabsReady()) return;
	// Floating untitled buffers are not persisted across workspace sessions.
	const savedGroups = state.groups.map((g) => {
		const tabs = g.tabs.filter((p) => !isUntitled(p));
		return { ...g, tabs, active: g.active && !isUntitled(g.active) ? g.active : (tabs[0] ?? null) };
	});
	remember(tabsKey(root), packTabs(savedGroups, state.activeGroup));
}

/** The side panels there are, and the bottom ones: what a kept choice must be one of. */
const LEFT_VIEWS: readonly PanelId[] = ["explorer", "objects", "palette", "reference", "search", "history", "health", "agent", "docs", "git"];
const BOTTOM_VIEWS: readonly BottomView[] = ["problems", "output"];

/** Keeps which side panel, bottom panel and right panel are showing in this folder, for the next time it is opened. */
export function rememberViews() {
	const root = state.workspace?.root;
	if (root && tabsReady()) remember(viewsKey(root), packViews(state.leftView, state.bottomView, state.rightView));
}

/**
 * Opens again what was open in this folder last time. A file that has gone
 * since, or is no longer inside the folder, is passed over without a word.
 */
export async function restoreTabs() {
	const root = state.workspace?.root;
	// A self-test starts from nothing open, and leaves nothing behind for the next run.
	if (state.info?.selftest || state.info?.selftestClose) return;
	try {
		// The panels first: they are there at once, and the files take a moment to read.
		const views = root ? unpackViews(recall(viewsKey(root)), LEFT_VIEWS, BOTTOM_VIEWS) : {};
		if (views.left) setState("leftView", views.left as PanelId);
		if (views.bottom) setState("bottomView", views.bottom as BottomView);
		// Where it is no longer docked on the right, the window's layout shows another that is (App.tsx).
		if (views.right) setState("rightView", views.right as PanelId);
		const saved = root ? unpackTabs(recall(tabsKey(root))) : null;
		if (!root || !saved) return;
		for (const [index, group] of saved.groups.entries()) {
			const tabs: string[] = [];
			for (const path of group.tabs) {
				if (!isInside(root, path)) continue;
				try {
					tabs.push((await loadDoc(path)).path);
				} catch {
					// Gone, or not readable any more.
				}
			}
			// The folder may have been changed for another while these were read.
			if (state.workspace?.root !== root) return;
			// And a file may have gone while the others were read: it is no longer there to have a tab.
			for (const path of [...tabs]) if (!docs.has(path)) tabs.splice(tabs.indexOf(path), 1);
			if (!tabs.length && index > 0) continue;
			const active = group.active && tabs.includes(canonical(group.active)) ? canonical(group.active) : (tabs[tabs.length - 1] ?? null);
			setState("groups", (groups) => {
				const next = groups.map((g) => ({ ...g }));
				while (next.length <= index) next.push({ tabs: [], active: null });
				const pinned = (group.pinned ?? []).map(canonical).filter((path) => tabs.includes(path));
				// The pinned stand first, also before a tab that was opened while these were being read.
				const all = [...new Set([...next[index]!.tabs, ...tabs])];
				next[index] = { ...next[index]!, tabs: [...pinned, ...all.filter((tab) => !pinned.includes(tab))], active: next[index]!.active ?? active, ...(pinned.length ? { pinned } : {}) };
				return next;
			});
		}
		setState("activeGroup", Math.min(saved.activeGroup, state.groups.length - 1));
	} finally {
		setTabsReady(true);
		rememberTabs();
		rememberViews();
	}
}

export async function loadProject() {
	const project = await guarded(() => backend.project());
	if (project) setState("project", project);
}

/**
 * Reads the settings. `fresh` is for a folder that has just been opened: everything is taken as it is on disk. A
 * later reading (a setting saved, project.toml changed) keeps the layout on screen, which is the view's own and may
 * not be on disk yet (see saveSetting).
 */
export async function loadSettings(fresh = false) {
	const [{ effective }, themes] = await Promise.all([backend.settings(), backend.themes()]);
	const { layout: onDisk, ...rest } = effective;
	batch(() => {
		setState("settings", fresh ? effective : rest);
		setState("themes", themes);
	});
}

/**
 * The settings whose whole value is worked out here from the one on screen and saved whole: the shortcuts, the
 * regions' colours, the models marked as the user's own. Two such changes in one moment (two shortcuts cleared by
 * one gesture) would each be worked out from the value before either, and the later would write the earlier away,
 * however orderly the saving. So the new value is on screen at once, where the next change is worked out from it.
 */
const WORKED_OUT_HERE = ["keys", "regionColors", "agentOwnModels"] as const;
/** How many saves of settings have been asked for: tells the answer to the last from the answers before it. */
let settingsAsked = 0;
/** How many of them have not answered yet, and whether one of those that have, failed. */
let settingsOut = 0;
let settingFailed = false;

/**
 * Saves a setting, and answers with the settings as the save left them (nothing when it failed, which has been
 * said): what to ask whether the setting took, since what is on screen may by then be a later save's.
 */
export async function saveSetting(patch: SettingsPatch, scope: "user" | "workspace" = "user"): Promise<Settings | undefined> {
	const mine = ++settingsAsked;
	settingsOut++;
	const atOnce: Record<string, unknown> = {};
	for (const key of WORKED_OUT_HERE) if (patch[key] !== undefined && patch[key] !== null) atOnce[key] = patch[key];
	if (Object.keys(atOnce).length) setState("settings", atOnce as Partial<Settings>);
	const effective = await guarded(() => backend.saveSettings(scope, patch));
	settingsOut--;
	if (!effective) settingFailed = true;
	// Saves land, and answer, in the order they were asked for, and each answer is the settings as they then are:
	// the answer to a save asked for after this one holds this one's change too, and this older answer is not put
	// over what has been shown since.
	if (effective && mine === settingsAsked) {
		// What comes back is the settings as they are on disk. The layout is the view's own, and is saved a moment
		// after it changes (App.tsx): the one on disk may be older, and must not come back over the one on screen.
		const { layout: onDisk, ...rest } = effective;
		setState("settings", "layout" in patch ? effective : rest);
	}
	// A save that failed has said so. What is on screen may then hold a value shown at once that was never saved,
	// or lack one from an answer passed over above: it is put back to what is on disk, once every save asked for
	// has answered (sooner, and a save still on its way would land after the reading and be passed over). Not if
	// another save is asked for while the disk is read: its own answer is the newer.
	if (!settingsOut && settingFailed) {
		settingFailed = false;
		const asked = settingsAsked;
		const disk = await backend.settings().then(
			(read) => read.effective,
			() => undefined,
		);
		if (disk && asked === settingsAsked) {
			const { layout: onDisk, ...rest } = disk;
			setState("settings", rest);
		}
	}
	return effective;
}

// --- documents ---------------------------------------------------------------

/** True for floating untitled buffers that have not been saved to disk yet. */
export const isUntitled = (path: string | null | undefined): path is string => Boolean(path && path.startsWith("untitled:"));
export const displayName = (path: string) => (isUntitled(path) ? path.slice("untitled:".length) : baseName(path));

export type PlanViewMode = "source" | "text" | "chart";

/** Plan view mode per file (Source | Text | Chart). Defaults to Chart (or Source if legacy planText is set). */
export function planMode(path: string): PlanViewMode {
	const explicit = state.planMode[path];
	if (explicit) return explicit;
	return state.planText[path] ? "source" : "chart";
}

export function setPlanMode(path: string, mode: PlanViewMode) {
	batch(() => {
		setState("planMode", path, mode);
		setState("planText", path, mode === "source");
	});
}

/** Obsidian-style Markdown mode per file (Source | Live | Read). Defaults to Live (or Source when livePreview is disabled). */
export function markdownMode(path: string): "source" | "live" | "read" {
	const explicit = state.mdMode[path];
	if (explicit) return explicit;
	return state.settings.livePreview === false ? "source" : "live";
}
export function setMarkdownMode(path: string, mode: "source" | "live" | "read") {
	batch(() => {
		setState("mdMode", path, mode);
		setState("mdText", path, mode !== "read");
	});
}

/** One spelling per file: Monaco's (on Windows it lowercases the drive letter). Untitled paths stay as-is. */
export const canonical = (path: string) => (isUntitled(path) ? path : monaco.Uri.file(path).fsPath);

/** Opens a floating untitled buffer (Untitled-1, Untitled-2, ...) that stays in memory until saved. */
export function newUntitled(group = state.activeGroup, language = "plaintext"): string {
	let n = 1;
	while (docs.has(`untitled:Untitled-${n}`)) n++;
	const path = `untitled:Untitled-${n}`;
	const uri = monaco.Uri.parse(path);
	const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel("", language, uri);
	const doc: Doc = { path, model, savedVersion: model.getAlternativeVersionId(), savedText: "", mtime: 0 };
	docs.set(path, doc);
	model.onDidChangeContent(() => {
		const dirty = model.getAlternativeVersionId() !== doc.savedVersion && model.getValue() !== doc.savedText;
		setState("dirty", path, dirty);
	});
	closeComparison();
	batch(() => {
		setState(
			"groups",
			group,
			produce((g: Group) => {
				if (!g.tabs.includes(path)) g.tabs.push(path);
				g.active = path;
			}),
		);
		setState("activeGroup", group);
		setState("centerView", "editors");
	});
	focusEditor();
	return path;
}

/** Makes a model the open document for a path, and follows its edits. */
function attach(path: string, text: string, saved: { text: string; mtime: number }): Doc {
	const uri = monaco.Uri.file(path);
	const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, languageFor(path), uri);
	const doc: Doc = { path, model, savedVersion: text === saved.text ? model.getAlternativeVersionId() : -1, savedText: saved.text, mtime: saved.mtime };
	docs.set(path, doc);
	model.onDidChangeContent(() => {
		const dirty = model.getAlternativeVersionId() !== doc.savedVersion && model.getValue() !== doc.savedText;
		setState("dirty", path, dirty);
		// A file that is being written in is not one that was only looked at: its tab stays. Asked a moment later: a
		// reload from disk is an edit too, and says the file is unchanged once it is done.
		if (dirty) queueMicrotask(() => state.dirty[path] && keepTab(path));
	});
	session.track(model);
	if (isPlanPath(path)) trackPlan(model);
	if (/\.(md|markdown)$/i.test(path)) trackDoc(model, path);
	// A plan's own check says where it cannot be read (plan/check.ts): one source of findings to a document.
	else if (/\.json$/i.test(path) && !isPlanPath(path)) trackJson(model);
	else if (/\.toml$/i.test(path)) trackToml(model);
	else if (languageFor(path) === "xml") trackXml(model);
	return doc;
}

async function loadDoc(path: string): Promise<Doc> {
	path = canonical(path);
	const existing = docs.get(path);
	if (existing) return existing;
	const file = await backend.read(path);
	// Two callers may have asked for the same file while it was being read.
	const known = docs.get(path);
	if (known) return known;
	const doc = attach(path, file.text, file);
	doc.encoding = file.encoding;
	doc.binary = file.binary;
	return doc;
}

session.sslSettings = () => JSON.parse(JSON.stringify(state.settings.ssl ?? {}));

setFormattingHost({
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
	if (!state.workspace || !isInside(state.workspace.root, path)) return null;
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
const heldOpen = (path: string) => Boolean(state.dirty[path] || state.conflicts[path]);

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
	const look = options.preview ? ++looks : 0;
	// What was only read (a definition peeked at) had no tab to keep it true, and the file may have changed, gone, or
	// been made anew since. It is let go, and the file is read as it is now: nothing of the old reading is left to undo.
	letGoIfOnlyRead(path);
	const doc = await guarded(() => loadDoc(path));
	if (!doc) return;
	// Another file was clicked for a look while this one was being read: that one is what is wanted now. Without this
	// the slower read would land last and take the tab of the file clicked last.
	if (look && look !== looks) return letGoIfOnlyRead(path);
	const group = options.group ?? state.activeGroup;
	if (options.reveal) pendingReveal.set(path, options.reveal);
	closeComparison();
	/** The tab that gave its place to this one: it was only looked at. */
	let replaced: string | null = null as string | null;
	// Said for as long as the editors hear of the change, which is within this batch.
	lookedAt = options.preview ? path : null;
	batch(() => {
		setState(
			"groups",
			group,
			produce((g: Group) => {
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
			}),
		);
		setState("activeGroup", group);
		// The call graph covers the editors: a file opened behind it would look like nothing happened.
		setState("centerView", "editors");
		// A maximized bottom panel covers the editors too: opening a file restores it so the file is visible.
		if (state.bottomMaximized) setState("bottomMaximized", false);
	});
	lookedAt = null;
	// What was only looked at and has no tab left is let go. It has no unsaved changes: a tab that shows some never gives way.
	if (replaced && !state.groups.some((g) => g.tabs.includes(replaced!))) letGoIfOnlyRead(replaced);
	revealSignal.fire(path);
	// Opened to stay (a double click, Enter in a list of files): the keyboard goes to it, also when it was already
	// showing for a look and the editor had no change of file to hear of.
	if (options.keep) focusEditor();
}

/** Keeps a tab that was opened for a look: in one group, or in every group that has it so. */
export function keepTab(path: string, group?: number) {
	state.groups.forEach((g, index) => (group === undefined || group === index) && g.preview === path && setState("groups", index, "preview", null));
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
export async function closeTab(path: string, group = state.activeGroup, options: { discard?: boolean; pinned?: boolean } = {}): Promise<boolean> {
	if (!state.groups[group]?.tabs.includes(path)) return true;
	// A pinned tab stays until it is let go: a close by key or by pointer says so and leaves it.
	if (state.groups[group]!.pinned?.includes(path) && !options.pinned) {
		notify(`${baseName(path)} is pinned. Unpin it to close it: right-click its tab.`);
		return false;
	}
	const lastView = state.groups.filter((g) => g.tabs.includes(path)).length === 1;
	if (state.dirty[path] && lastView && !options.discard) {
		const answer = await choose(`${displayName(path)} has unsaved changes.`, ["Save", "Discard changes"], { danger: "Discard changes" });
		if (!answer) return false;
		// A save that failed has already said why: the tab stays, with the edits in it.
		if (answer === "Save" && !(await save(path))) return false;
	}
	if (lastView && !isUntitled(path)) closedTabs.push(path);
	batch(() => {
		setState(
			"groups",
			group,
			produce((g: Group) => {
				const index = g.tabs.indexOf(path);
				g.tabs.splice(index, 1);
				if (g.pinned) g.pinned = g.pinned.filter((p) => p !== path);
				if (g.preview === path) g.preview = null;
				if (g.active === path) g.active = g.tabs[Math.min(index, g.tabs.length - 1)] ?? null;
			}),
		);
		if (state.groups.length > 1 && !state.groups[group]!.tabs.length) {
			setState("groups", (groups) => groups.filter((_, i) => i !== group));
			setState("activeGroup", 0);
		}
	});
	if (!state.groups.some((g) => g.tabs.includes(path))) {
		const doc = docs.get(path);
		if (doc) {
			docs.delete(path);
			doc.model.dispose();
			batch(() => {
				setState("dirty", path, undefined!);
				setState("conflicts", path, undefined!);
			});
		}
	}
	return true;
}

/** The tabs of the active group, to step through. */
function stepTab(by: number) {
	const group = state.groups[state.activeGroup];
	if (!group?.active || group.tabs.length < 2) return;
	const next = group.tabs[(group.tabs.indexOf(group.active) + by + group.tabs.length) % group.tabs.length]!;
	setState("groups", state.activeGroup, "active", next);
	revealSignal.fire(next);
	focusEditor();
}
export const nextTab = () => stepTab(1);
export const previousTab = () => stepTab(-1);

/** Closes every tab of a group but one and the pinned. */
export async function closeOtherTabs(keep = activePath(), group = state.activeGroup) {
	const g = state.groups[group];
	for (const path of othersOf(g?.tabs ?? [], g?.pinned ?? [], keep)) if (!(await closeTab(path, group))) return;
}

/** Closes the tabs after one in its row, the pinned left alone. */
export async function closeTabsToRight(path = activePath(), group = state.activeGroup) {
	const g = state.groups[group];
	if (!path || !g) return;
	for (const other of rightOf(g.tabs, g.pinned ?? [], path)) if (!(await closeTab(other, group))) return;
}

/** Closes every tab that is not pinned: of one group, or of them all. */
export async function closeAllTabs(only?: number) {
	for (let group = only ?? state.groups.length - 1; group >= (only ?? 0); group--) {
		const g = state.groups[group];
		for (const path of othersOf(g?.tabs ?? [], g?.pinned ?? [], null)) if (!(await closeTab(path, group))) return;
	}
}

/** Told when a tab is about to leave its group for another: the group keeps where the cursor was in it, to hand on. */
export const tabLeaving = new Set<(group: number, path: string) => void>();

/** Moves the open tab to the other group, making one when there is only one. The keyboard's way to do what a drag does. */
export function sendTabAcross() {
	const path = activePath();
	if (!path) return;
	const from = state.activeGroup;
	if (state.groups.length === 1) setState("groups", (groups) => [...groups, { tabs: [], active: null }]);
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
	const next = movedAcross(state.groups as Group[], path, from, to, before);
	const fields = (g: Group) => ({ tabs: g.tabs, active: g.active, ...(g.pinned ? { pinned: g.pinned } : {}) });
	batch(() => {
		if (next.groups.length < state.groups.length) {
			// The group it left is gone: the one it came to is changed where it stands, so that its editor stays.
			setState("groups", to, fields(next.groups[next.active]!));
			setState("groups", (groups) => groups.filter((_, i) => i !== from));
		} else next.groups.forEach((g, i) => (i === from || i === to) && setState("groups", i, fields(g)));
		setState("activeGroup", next.active);
	});
	if (from !== to) revealSignal.fire(path);
	focusEditor();
}

/** The open tab one place along its row, left or right, among the pinned or among the others. */
export function shiftTab(by: 1 | -1, group = state.activeGroup) {
	const g = state.groups[group];
	const path = g?.active;
	if (!g || !path) return;
	const at = g.tabs.indexOf(path);
	const before = by < 0 ? (g.tabs[at - 1] ?? path) : (g.tabs[at + 2] ?? null);
	keepTab(path, group);
	setState("groups", group, "tabs", placed(g.tabs, g.pinned ?? [], path, before));
}

/** Pins a tab, or lets a pinned one go. */
export function togglePin(path = activePath(), group = state.activeGroup) {
	const g = state.groups[group];
	if (!path || !g?.tabs.includes(path)) return;
	keepTab(path, group);
	const next = withPin(g.tabs, g.pinned ?? [], path, !g.pinned?.includes(path));
	batch(() => {
		setState("groups", group, "tabs", next.tabs);
		setState("groups", group, "pinned", next.pinned);
	});
	rememberTabs();
}

export async function reopenClosedTab() {
	for (let path = closedTabs.pop(); path; path = closedTabs.pop()) {
		if (state.groups.some((g) => g.tabs.includes(path!))) continue;
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
	if (!doc || isUntitled(path) || state.dirty[path] || state.groups.some((g) => g.tabs.includes(path))) return;
	docs.delete(path);
	doc.model.dispose();
	if (state.conflicts[path]) setState("conflicts", path, undefined!);
}

/** A file or folder was renamed in the Explorer: its open tabs follow it, with their edits. */
export function fileRenamed(oldPath: string, newPath: string) {
	oldPath = canonical(oldPath);
	newPath = canonical(newPath);
	pathChanges.renamed.forEach((told) => told((path) => (path === oldPath ? newPath : isInside(oldPath, path) ? newPath + path.slice(oldPath.length) : path)));
	// What was only read at the new path, or under it, before its file went is not what has come to be there.
	for (const path of [...docs.keys()]) if (path === newPath || isInside(newPath, path)) letGoIfOnlyRead(path);
	for (const [path, doc] of [...docs]) {
		if (path !== oldPath && !isInside(oldPath, path)) continue;
		const target = path === oldPath ? newPath : newPath + path.slice(oldPath.length);
		const dirty = Boolean(state.dirty[path]);
		const text = doc.model.getValue();
		docs.delete(path);
		const moved = attach(target, text, { text: doc.savedText, mtime: doc.mtime });
		moved.encoding = doc.encoding;
		moved.binary = doc.binary;
		batch(() => {
			setState(
				"groups",
				produce((groups: Group[]) => {
					for (const g of groups) {
						g.tabs = g.tabs.map((tab) => (tab === path ? target : tab));
						if (g.pinned) g.pinned = g.pinned.map((tab) => (tab === path ? target : tab));
						if (g.preview === path) g.preview = target;
						if (g.active === path) g.active = target;
					}
				}),
			);
			setState("dirty", path, undefined!);
			setState("conflicts", path, undefined!);
			setState("dirty", target, dirty || moved.savedVersion === -1);
			if (state.planText[path]) setState("planText", target, true);
			if (state.planMode[path]) setState("planMode", target, state.planMode[path]!);
			if (state.mdText[path]) setState("mdText", target, true);
			if (state.mdMode[path]) setState("mdMode", target, state.mdMode[path]!);
		});
		doc.model.dispose();
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
	for (const group of state.groups) for (const tab of group.tabs) if (there(tab)) return { kind: "tab", path: tab };
	for (const other of docs.keys()) if (there(other) && state.dirty[other]) return { kind: "unsaved", path: other };
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
	// A file whose unsaved edits stay open is still somewhere to go.
	pathChanges.gone.forEach((told) => told((path) => (path === removed || isInside(removed, path)) && !state.dirty[path]));
	for (const path of [...docs.keys()]) {
		if (path !== removed && !isInside(removed, path)) continue;
		if (state.dirty[path]) {
			notify(`${baseName(path)} was moved to the trash. Its unsaved edits are still open: save to put the file back.`, "error");
			continue;
		}
		// From the last group back: a group left empty goes, and those after it move up a place.
		for (let i = state.groups.length - 1; i >= 0; i--) if (state.groups[i]?.tabs.includes(path)) void closeTab(path, i, { discard: true, pinned: true });
		letGoIfOnlyRead(path);
	}
}

/** Opens a file in the group beside the one at hand, which is made if there is none. */
export async function openToSide(path: string) {
	// With nothing open there is no side to open it to: it opens where a file would.
	if (state.groups.length === 1 && !state.groups[0]!.tabs.length) return openFile(path, { keep: true });
	const made = state.groups.length === 1;
	if (made) setState("groups", (groups) => [...groups, { tabs: [], active: null }]);
	await openFile(path, { group: state.activeGroup === 0 ? 1 : 0, keep: true });
	// A file that could not be read opened nothing: the group made for it is not left standing empty.
	if (made && state.groups.length === 2 && !state.groups[1]!.tabs.length) {
		batch(() => {
			setState("groups", (groups) => groups.slice(0, 1));
			setState("activeGroup", 0);
		});
	}
}

export function split() {
	const path = activePath();
	if (path) void openToSide(path);
}

/**
 * The file on disk is not the one these edits started from. Nothing is written
 * until the user has chosen; says whether to go on and write.
 */
async function settleConflict(doc: Doc): Promise<boolean> {
	let disk;
	try {
		disk = await backend.read(doc.path);
	} catch {
		return true; // Deleted or moved on disk: saving puts it back.
	}
	if (disk.mtime === doc.mtime) return true;
	// Bytes where there was text have no text to compare: they are a change, whatever the empty text of them equals.
	const turnedBytes = Boolean(disk.binary) && !doc.binary;
	if (!turnedBytes && (disk.text === doc.savedText || disk.text === doc.model.getValue())) return true;
	const name = baseName(doc.path);
	const answer = await choose(`${name} changed on disk after you opened it. Saving would replace what is there.`, ["Compare", "Overwrite the file on disk", "Reload from disk"], { danger: "Overwrite the file on disk" });
	if (answer === "Overwrite the file on disk") return true;
	if (answer === "Reload from disk") await revert(doc.path);
	if (answer === "Compare") {
		openReview({
			title: `${name}: the file on disk, against your edits`,
			original: disk.text,
			proposed: doc.model.getValue(),
			language: doc.model.getLanguageId(),
			note: "Left: the file as it is on disk now. Right: your edits, which you can change here. Accept keeps the right side and saves it over the file.",
			acceptLabel: "Keep mine and save",
			onAccept: async (text) => {
				applyText(doc.path, text);
				doc.mtime = disk.mtime;
				doc.savedText = disk.text;
				await save(doc.path);
			},
		});
	}
	return false;
}

/** Says whether the file is on disk as it is in the editor. */
export async function save(path = activePath(), options: { /** False to leave the lines as they are, whatever the setting says. */ format?: boolean } = {}): Promise<Saved> {
	if (!path) return false;
	const doc = docs.get(path);
	if (!doc) return false;
	// First save of a floating untitled buffer: ask for a path, write to disk, and promote the tab.
	if (isUntitled(path)) {
		const root = state.workspace?.root;
		const suggested = `${displayName(path)}.ssl`;
		const entered = (await ask(root ? "Save file as (relative to workspace, or absolute path)" : "Save file as (absolute path)", suggested))?.trim();
		if (!entered) return false;
		const isAbs = entered.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entered);
		if (!isAbs && !root) return notify("Open a folder or enter an absolute file path to save.", "error"), false;
		const target = canonical(isAbs ? entered : joinPath(root!, ...entered.split(/[\\/]/).filter(Boolean)));
		const text = doc.model.getValue();
		const created = await guarded(async () => {
			await backend.create(target, "file").catch(() => undefined);
			return backend.write(target, text, true);
		});
		if (!created) return false;
		const realDoc = attach(target, text, { text, mtime: created.mtime });
		realDoc.encoding = "utf-8";
		batch(() => {
			for (let gi = 0; gi < state.groups.length; gi++) {
				setState(
					"groups",
					gi,
					produce((g: Group) => {
						const idx = g.tabs.indexOf(path);
						if (idx >= 0) {
							if (g.tabs.includes(target)) g.tabs.splice(idx, 1);
							else g.tabs[idx] = target;
						}
						if (g.active === path) g.active = target;
						if (g.pinned) g.pinned = g.pinned.map((p) => (p === path ? target : p));
						if (g.preview === path) g.preview = null;
					}),
				);
			}
			setState("dirty", path, undefined!);
			setState("dirty", target, false);
			setState("treeVersion", (v) => v + 1);
		});
		docs.delete(path);
		doc.model.dispose();
		session.saved(realDoc.model);
		historyChanged.fire(target);
		return true;
	}
	// A picture, or other bytes: there is no text of it here to save.
	if (doc.binary) return notify(`${baseName(path)} is not text: there is nothing of it to save here.`), false;
	if (!(await settleConflict(doc))) return false;
	if (options.format !== false && state.settings.formatOnSave && doc.model.getLanguageId() === "ssl" && state.lsp.state === "running") {
		await formatChanged(doc);
	}
	const text = doc.model.getValue();
	// "It was read as text": a file that holds a zero byte the user typed is still theirs to save.
	const result = await guarded(() => backend.write(path, text, true));
	if (!result) return false;
	doc.savedText = text;
	doc.savedVersion = doc.model.getAlternativeVersionId();
	doc.mtime = result.mtime;
	batch(() => {
		setState("dirty", path, false);
		setState("conflicts", path, undefined!);
		setState("treeVersion", (v) => v + 1);
	});
	session.saved(doc.model);
	historyChanged.fire(path);
	// project.toml chooses the docs folders, and the model and style for this project.
	if (state.project && path === canonical(state.project.path)) await Promise.all([loadProject(), loadSettings()]);
	return true;
}

export const historyChanged = (() => {
	const listeners = new Set<(path: string) => void>();
	return {
		fire: (path: string) => listeners.forEach((l) => l(path)),
		listen: (l: (path: string) => void) => (listeners.add(l), () => listeners.delete(l)),
	};
})();

/** Format on save formats only the lines changed since the last save (ARCHITECTURE). */
async function formatChanged(doc: Doc) {
	const eol = doc.model.getEOL();
	let ranges = changedRanges(doc.savedText.split(/\r?\n/), doc.model.getValue().split(eol));
	if (!ranges.length) return;
	try {
		// A lone line formats without its block's indentation: widen each range
		// to the procedure the server says it is in.
		ranges = widenToProcedures(ranges, await session.documentSymbols(doc.model).catch(() => []));
		const edits = await session.formatRanges(doc.model, ranges, doc.model.getOptions());
		if (edits.length) doc.model.pushEditOperations([], edits, () => null);
	} catch (e: any) {
		log(`format on save skipped: ${e?.message ?? e}`);
	}
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

/** Replaces a document's text with one undoable edit over the part that changed. */
export function applyText(path: string, text: string) {
	const doc = docs.get(path);
	if (!doc) return;
	const edit = minimalReplace(doc.model.getValue(), text.replace(/\r?\n/g, doc.model.getEOL()));
	if (!edit) return;
	doc.model.pushStackElement();
	doc.model.pushEditOperations(
		[],
		[{ range: monaco.Range.fromPositions(doc.model.getPositionAt(edit.start), doc.model.getPositionAt(edit.end)), text: edit.text }],
		() => null,
	);
	doc.model.pushStackElement();
}

/** Says whether every file was saved: it stops at the first that could not be. */
export async function saveAll(): Promise<Saved> {
	for (const path of unsavedPaths()) if (!(await save(path))) return false;
	return true;
}

export async function revert(path: string) {
	const doc = docs.get(path);
	if (!doc) return;
	const file = await guarded(() => backend.read(path));
	// The document may have been let go, or moved away, while the file was read.
	if (!file || docs.get(path) !== doc) return;
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
	batch(() => {
		setState("dirty", path, false);
		setState("conflicts", path, undefined!);
		setState("kindVersion", (v) => v + 1);
	});
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
	setState("treeVersion", (v) => v + 1);
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
		told(false);
		// Deleted or moved: a copy open in a tab is kept, and one that was only read is not.
		letGoIfOnlyRead(path);
		return;
	}
	told(true);
	// It may have been let go, or moved away, while the file was read.
	if (!doc || docs.get(path) !== doc) return;
	// A picture, or other bytes, has no text to compare: a later date on it is the change.
	if (doc.binary && file.binary) {
		if (file.mtime !== doc.mtime) {
			doc.mtime = file.mtime;
			doc.binary = file.binary;
			setState("kindVersion", (v) => v + 1);
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
	if (state.dirty[path]) {
		if (!state.conflicts[path]) notify(`${baseName(path)} changed on disk while you have unsaved edits. Saving will ask which to keep.`, "error");
		setState("conflicts", path, true);
	} else {
		await revert(path);
		log(`reloaded ${path} after an external change`);
	}
}

// The desktop window was asked to close with edits that are not on disk.
on("closeRequested", async () => {
	if (await settleUnsaved("Closing the window would lose them.")) await backend.closeWindow();
});

on("lspState", (lsp) => {
	setState("lsp", lsp);
	if (lsp.message) log(lsp.message);
});
