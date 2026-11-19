// App state: the workspace, open documents, editor groups and panels.
// Documents are Monaco models; the text in them is the source of truth
// (ADR 0002).
import { batch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { DEFAULT_SETTINGS, type Info, type LspState, type Project, type Settings, type SettingsPatch, type ThemeFile, type Workspace } from "../shared/protocol";
import { backend, on } from "./backend";
import { monaco } from "./editor/monaco";
import { languageFor } from "./editor/languages";
import { session } from "./lsp/session";
import { changedRanges, minimalReplace } from "./lsp/edits";
import { choose } from "./dialogs";
import { openReview } from "./editor/Review";
import { baseName, isInside } from "../shared/paths";
import { isPlanPath } from "./plan/model";
import { recheckPlans, trackPlan } from "./plan/check";
import { trackDoc, trackJson } from "./docCheck";
import { recall, remember } from "./graph/canvas";
import { packTabs, packViews, tabsKey, unpackTabs, unpackViews, viewsKey } from "./editor/sessionTabs";

export type Group = { tabs: string[]; active: string | null; mode?: "text" | "blocks" };
export type PanelId = "explorer" | "objects" | "palette" | "reference" | "search" | "history" | "health" | "agent" | "docs";
/** @deprecated names kept for readers: both sides hold any panel. */
export type LeftView = PanelId;
export type RightView = PanelId;
export type BottomView = "problems" | "output";
export type Message = { id: number; kind: "info" | "error"; text: string; action?: { label: string; run: () => void } };
/** What "Save" was able to do: a caller that goes on to close or discard must check it. */
export type Saved = boolean;

type Doc = { path: string; model: monaco.editor.ITextModel; savedVersion: number; savedText: string; mtime: number };

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
	rightView: "health" as RightView,
	centerView: "editors" as "editors" | "graph",
	/** Plans shown as text; a plan opens as its chart. */
	planText: {} as Record<string, boolean>,
	/** Markdown shown as text; a Markdown file opens rendered. */
	mdText: {} as Record<string, boolean>,
	messages: [] as Message[],
	output: [] as string[],
	cursor: { line: 1, column: 1 },
	/** Bumped when the tree should reload a folder. */
	treeVersion: 0,
	quickPick: null as null | "files" | "commands" | "symbols",
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
	setState("messages", (list) => [...list.filter((m) => m.text !== text).slice(-4), { id, kind, text, action }]);
	if (kind === "error") log(`error: ${text}`);
	// A note that offers something to do stays long enough to do it.
	else setTimeout(() => dismiss(id), action ? 20000 : 4000);
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
	tabsReady = false;
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
	await Promise.all([loadSettings(), loadProject()]);
	setState("info", await backend.info());
	setState("lsp", await backend.lspState());
	void session.start(workspace.root);
	log(`opened ${workspace.root}`);
	await restoreTabs();
}

// --- the tabs a folder was left with ---------------------------------------------

/** False while a folder is being opened: its tabs are not yet the ones to remember. */
let tabsReady = false;

/** Keeps which files are open in this folder, for the next time it is opened. */
export function rememberTabs() {
	const root = state.workspace?.root;
	if (root && tabsReady) remember(tabsKey(root), packTabs(state.groups, state.activeGroup));
}

/** The side panels there are, and the bottom ones: what a kept choice must be one of. */
const LEFT_VIEWS: readonly PanelId[] = ["explorer", "objects", "palette", "reference", "search", "history", "health", "agent", "docs"];
const BOTTOM_VIEWS: readonly BottomView[] = ["problems", "output"];

/** Keeps which side panel and which bottom panel are showing in this folder, for the next time it is opened. */
export function rememberViews() {
	const root = state.workspace?.root;
	if (root && tabsReady) remember(viewsKey(root), packViews(state.leftView, state.bottomView));
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
			if (!tabs.length && index > 0) continue;
			const active = group.active && tabs.includes(canonical(group.active)) ? canonical(group.active) : (tabs[tabs.length - 1] ?? null);
			setState("groups", (groups) => {
				const next = groups.map((g) => ({ ...g }));
				while (next.length <= index) next.push({ tabs: [], active: null });
				next[index] = { ...next[index]!, tabs: [...new Set([...next[index]!.tabs, ...tabs])], active: next[index]!.active ?? active };
				return next;
			});
		}
		setState("activeGroup", Math.min(saved.activeGroup, state.groups.length - 1));
	} finally {
		tabsReady = true;
		rememberTabs();
		rememberViews();
	}
}

export async function loadProject() {
	const project = await guarded(() => backend.project());
	if (project) setState("project", project);
}

export async function loadSettings() {
	const [{ effective }, themes] = await Promise.all([backend.settings(), backend.themes()]);
	batch(() => {
		setState("settings", effective);
		setState("themes", themes);
	});
}

export async function saveSetting(patch: SettingsPatch, scope: "user" | "workspace" = "user") {
	const effective = await guarded(() => backend.saveSettings(scope, patch));
	if (effective) setState("settings", effective);
}

// --- documents ---------------------------------------------------------------

/** One spelling per file: Monaco's (on Windows it lowercases the drive letter). */
export const canonical = (path: string) => monaco.Uri.file(path).fsPath;

/** Makes a model the open document for a path, and follows its edits. */
function attach(path: string, text: string, saved: { text: string; mtime: number }): Doc {
	const uri = monaco.Uri.file(path);
	const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, languageFor(path), uri);
	const doc: Doc = { path, model, savedVersion: text === saved.text ? model.getAlternativeVersionId() : -1, savedText: saved.text, mtime: saved.mtime };
	docs.set(path, doc);
	model.onDidChangeContent(() => setState("dirty", path, model.getAlternativeVersionId() !== doc.savedVersion));
	session.track(model);
	if (isPlanPath(path)) trackPlan(model);
	if (/\.(md|markdown)$/i.test(path)) trackDoc(model);
	// A plan's own check says where it cannot be read (plan/check.ts): one source of findings to a document.
	else if (/\.json$/i.test(path) && !isPlanPath(path)) trackJson(model);
	return doc;
}

async function loadDoc(path: string): Promise<Doc> {
	path = canonical(path);
	const existing = docs.get(path);
	if (existing) return existing;
	const file = await backend.read(path);
	// Two callers may have asked for the same file while it was being read.
	return docs.get(path) ?? attach(path, file.text, file);
}

session.sslSettings = () => JSON.parse(JSON.stringify(state.settings.ssl ?? {}));

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

export async function openFile(path: string, options: { group?: number; reveal?: Reveal } = {}) {
	path = canonical(path);
	const doc = await guarded(() => loadDoc(path));
	if (!doc) return;
	const group = options.group ?? state.activeGroup;
	if (options.reveal) pendingReveal.set(path, options.reveal);
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
		// The call graph covers the editors: a file opened behind it would look like nothing happened.
		setState("centerView", "editors");
	});
	revealSignal.fire(path);
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
export async function closeTab(path: string, group = state.activeGroup, options: { discard?: boolean } = {}): Promise<boolean> {
	if (!state.groups[group]?.tabs.includes(path)) return true;
	const lastView = state.groups.filter((g) => g.tabs.includes(path)).length === 1;
	if (state.dirty[path] && lastView && !options.discard) {
		const answer = await choose(`${baseName(path)} has unsaved changes.`, ["Save", "Discard changes"], { danger: "Discard changes" });
		if (!answer) return false;
		// A save that failed has already said why: the tab stays, with the edits in it.
		if (answer === "Save" && !(await save(path))) return false;
	}
	if (lastView) closedTabs.push(path);
	batch(() => {
		setState(
			"groups",
			group,
			produce((g: Group) => {
				const index = g.tabs.indexOf(path);
				g.tabs.splice(index, 1);
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

export async function closeOtherTabs() {
	const group = state.activeGroup;
	const keep = activePath();
	for (const path of [...(state.groups[group]?.tabs ?? [])]) if (path !== keep && !(await closeTab(path, group))) return;
}

export async function closeAllTabs() {
	for (let group = state.groups.length - 1; group >= 0; group--) {
		for (const path of [...(state.groups[group]?.tabs ?? [])]) if (!(await closeTab(path, group))) return;
	}
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

/** A file or folder was renamed in the Explorer: its open tabs follow it, with their edits. */
export function fileRenamed(oldPath: string, newPath: string) {
	oldPath = canonical(oldPath);
	newPath = canonical(newPath);
	for (const [path, doc] of [...docs]) {
		if (path !== oldPath && !isInside(oldPath, path)) continue;
		const target = path === oldPath ? newPath : newPath + path.slice(oldPath.length);
		const dirty = Boolean(state.dirty[path]);
		const text = doc.model.getValue();
		docs.delete(path);
		const moved = attach(target, text, { text: doc.savedText, mtime: doc.mtime });
		batch(() => {
			setState(
				"groups",
				produce((groups: Group[]) => {
					for (const g of groups) {
						g.tabs = g.tabs.map((tab) => (tab === path ? target : tab));
						if (g.active === path) g.active = target;
					}
				}),
			);
			setState("dirty", path, undefined!);
			setState("conflicts", path, undefined!);
			setState("dirty", target, dirty || moved.savedVersion === -1);
			if (state.planText[path]) setState("planText", target, true);
			if (state.mdText[path]) setState("mdText", target, true);
		});
		doc.model.dispose();
	}
}

/** A file or folder went to the trash: its tabs close, except those holding edits nobody saved. */
export function fileRemoved(removed: string) {
	removed = canonical(removed);
	for (const path of [...docs.keys()]) {
		if (path !== removed && !isInside(removed, path)) continue;
		if (state.dirty[path]) {
			notify(`${baseName(path)} was moved to the trash. Its unsaved edits are still open: save to put the file back.`, "error");
			continue;
		}
		state.groups.forEach((g, i) => g.tabs.includes(path) && void closeTab(path, i, { discard: true }));
	}
}

export function split() {
	const path = activePath();
	if (!path) return;
	if (state.groups.length === 1) setState("groups", (groups) => [...groups, { tabs: [], active: null }]);
	void openFile(path, { group: state.activeGroup === 0 ? 1 : 0 });
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
	if (disk.mtime === doc.mtime || disk.text === doc.savedText || disk.text === doc.model.getValue()) return true;
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
export async function save(path = activePath()): Promise<Saved> {
	if (!path) return false;
	const doc = docs.get(path);
	if (!doc) return false;
	if (!(await settleConflict(doc))) return false;
	if (state.settings.formatOnSave && doc.model.getLanguageId() === "ssl" && state.lsp.state === "running") {
		await formatChanged(doc);
	}
	const text = doc.model.getValue();
	const result = await guarded(() => backend.write(path, text));
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
	if (!file) return;
	doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: file.text }], () => null);
	doc.savedText = file.text;
	doc.savedVersion = doc.model.getAlternativeVersionId();
	doc.mtime = file.mtime;
	batch(() => {
		setState("dirty", path, false);
		setState("conflicts", path, undefined!);
	});
}

on("fileChanged", async ({ path: changed }) => {
	const path = canonical(changed);
	setState("treeVersion", (v) => v + 1);
	const doc = docs.get(path);
	// The kinds of file the server asks to be told about.
	const script = /\.(srvscr|ssl|ds)(\.txt)?$/i.test(path);
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
		return; // Deleted or moved: keep the open copy.
	}
	told(true);
	if (!doc) return;
	if (file.text === doc.model.getValue()) return;
	if (state.dirty[path]) {
		if (!state.conflicts[path]) notify(`${baseName(path)} changed on disk while you have unsaved edits. Saving will ask which to keep.`, "error");
		setState("conflicts", path, true);
	} else {
		await revert(path);
		log(`reloaded ${path} after an external change`);
	}
});

// The desktop window was asked to close with edits that are not on disk.
on("closeRequested", async () => {
	if (await settleUnsaved("Closing the window would lose them.")) await backend.closeWindow();
});

on("lspState", (lsp) => {
	setState("lsp", lsp);
	if (lsp.message) log(lsp.message);
});
