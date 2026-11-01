// App state: the workspace, open documents, editor groups and panels.
// Documents are Monaco models; the text in them is the source of truth
// (ADR 0002).
import { batch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { DEFAULT_SETTINGS, type Info, type LspState, type Settings, type ThemeFile, type Workspace } from "../shared/protocol";
import { backend, on } from "./backend";
import { languageFor, monaco } from "./editor/monaco";
import { session } from "./lsp/session";
import { changedRanges, minimalReplace } from "./lsp/edits";
import { choose } from "./dialogs";

export type Group = { tabs: string[]; active: string | null; mode?: "text" | "blocks" };
export type PanelId = "explorer" | "objects" | "palette" | "reference" | "search" | "history" | "health" | "agent";
/** @deprecated names kept for readers: both sides hold any panel. */
export type LeftView = PanelId;
export type RightView = PanelId;
export type BottomView = "problems" | "output";
export type Message = { id: number; kind: "info" | "error"; text: string };

type Doc = { path: string; model: monaco.editor.ITextModel; savedVersion: number; savedText: string; mtime: number };

export const [state, setState] = createStore({
	workspace: null as Workspace | null,
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
export function notify(text: string, kind: Message["kind"] = "info") {
	const id = nextMessage++;
	setState("messages", (list) => [...list, { id, kind, text }]);
	setTimeout(() => setState("messages", (list) => list.filter((m) => m.id !== id)), kind === "error" ? 8000 : 4000);
}

export function log(line: string) {
	setState("output", (list) => [...list.slice(-499), `${new Date().toLocaleTimeString()}  ${line}`]);
}

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

export async function openFolder(path?: string) {
	const workspace = await guarded(() => backend.openFolder(path));
	if (!workspace) return;
	for (const doc of docs.values()) doc.model.dispose();
	docs.clear();
	batch(() => {
		setState("workspace", workspace);
		setState("groups", [{ tabs: [], active: null }]);
		setState("activeGroup", 0);
		setState("dirty", {});
		setState("treeVersion", (v) => v + 1);
	});
	await loadSettings();
	setState("info", await backend.info());
	setState("lsp", await backend.lspState());
	void session.start(workspace.root);
	log(`opened ${workspace.root}`);
}

export async function loadSettings() {
	const [{ effective }, themes] = await Promise.all([backend.settings(), backend.themes()]);
	batch(() => {
		setState("settings", effective);
		setState("themes", themes);
	});
}

export async function saveSetting(patch: Partial<Settings>, scope: "user" | "workspace" = "user") {
	const effective = await guarded(() => backend.saveSettings(scope, patch));
	if (effective) setState("settings", effective);
}

// --- documents ---------------------------------------------------------------

async function loadDoc(path: string): Promise<Doc> {
	const existing = docs.get(path);
	if (existing) return existing;
	const file = await backend.read(path);
	const uri = monaco.Uri.file(path);
	const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(file.text, languageFor(path), uri);
	const doc: Doc = { path, model, savedVersion: model.getAlternativeVersionId(), savedText: file.text, mtime: file.mtime };
	docs.set(path, doc);
	model.onDidChangeContent(() => setState("dirty", path, model.getAlternativeVersionId() !== doc.savedVersion));
	session.track(model);
	return doc;
}

session.sslSettings = () => JSON.parse(JSON.stringify(state.settings.ssl ?? {}));

/** Models for files the language server points at (peek, rename) without opening a tab. */
session.ensureModel = async (uri) => {
	const path = monaco.Uri.parse(uri).fsPath;
	if (!state.workspace || !path.startsWith(state.workspace.root)) return null;
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

export async function closeTab(path: string, group = state.activeGroup) {
	const lastView = state.groups.filter((g) => g.tabs.includes(path)).length === 1;
	if (state.dirty[path] && lastView) {
		const answer = await choose(`${path.split("/").pop()} has unsaved changes.`, ["Save", "Discard"]);
		if (!answer) return;
		if (answer === "Save") await save(path);
	}
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
			setState("dirty", path, undefined!);
		}
	}
}

export function split() {
	const path = activePath();
	if (!path) return;
	if (state.groups.length === 1) setState("groups", (groups) => [...groups, { tabs: [], active: null }]);
	void openFile(path, { group: state.activeGroup === 0 ? 1 : 0 });
}

export async function save(path = activePath()) {
	if (!path) return;
	const doc = docs.get(path);
	if (!doc) return;
	if (state.settings.formatOnSave && doc.model.getLanguageId() === "ssl" && state.lsp.state === "running") {
		await formatChanged(doc);
	}
	const text = doc.model.getValue();
	const result = await guarded(() => backend.write(path, text));
	if (!result) return;
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

export async function saveAll() {
	for (const [path, dirty] of Object.entries(state.dirty)) if (dirty) await save(path);
}

export async function revert(path: string) {
	const doc = docs.get(path);
	if (!doc) return;
	const file = await backend.read(path);
	doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: file.text }], () => null);
	doc.savedText = file.text;
	doc.savedVersion = doc.model.getAlternativeVersionId();
	doc.mtime = file.mtime;
	batch(() => {
		setState("dirty", path, false);
		setState("conflicts", path, undefined!);
	});
}

on("fileChanged", async ({ path }) => {
	setState("treeVersion", (v) => v + 1);
	const doc = docs.get(path);
	if (!doc) return;
	let file;
	try {
		file = await backend.read(path);
	} catch {
		return; // Deleted or moved: keep the open copy.
	}
	if (file.text === doc.model.getValue()) return;
	if (state.dirty[path]) {
		setState("conflicts", path, true);
		notify(`${path.split("/").pop()} changed on disk while you have unsaved edits.`, "error");
	} else {
		await revert(path);
		log(`reloaded ${path} after an external change`);
	}
});

on("lspState", (lsp) => {
	setState("lsp", lsp);
	if (lsp.message) log(lsp.message);
});
