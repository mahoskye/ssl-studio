// Active CodeMirror 6 Live Preview handle registry: lets the menu bar, command
// palette, status bar, navigation history, Agent panel, and working-doc actions
// talk to the Markdown Live view with the exact same ergonomics as Monaco.
import { createSignal } from "solid-js";
import { state } from "../state";

const [liveSelectionVersion, setLiveSelectionVersion] = createSignal(0);
/** Reactive counter bumped when a mounted CM6 Live Preview selection changes. */
export { liveSelectionVersion };
export const bumpLiveSelection = () => setLiveSelectionVersion((v) => v + 1);

export type LivePosition = { lineNumber: number; column: number };
export type LiveSelection = {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
	isEmpty(): boolean;
};

export type LiveEditorHandle = {
	readonly path: string;
	focus(): void;
	hasFocus(): boolean;
	getPosition(): LivePosition;
	getSelection(): LiveSelection;
	getSelectedText(): string;
	reveal(range: { line: number; column?: number; endLine?: number; endColumn?: number }): void;
	runAction(id: string): boolean;
	openLinkAtCursor(): boolean;
	insertText(text: string, cursorOffset?: number, opts?: { asBlock?: boolean }): void;
	getTopLine?(): number;
	foldAll?(): void;
	unfoldAll?(): void;
};

const liveEditors: Record<number, LiveEditorHandle | undefined> = {};
const readFinders: Record<number, (() => void) | undefined> = {};
const tableFinders: Record<number, ((replace?: boolean) => void) | undefined> = {};
const tableColumnJumpers: Record<number, ((colIndex: number) => void) | undefined> = {};

export type MarkdownSyncAnchor = { line: number; column: number; topLine?: number; at: number };
const syncAnchors = new Map<string, MarkdownSyncAnchor>();

/** Saves cursor/scroll position before toggling between Markdown Live/Read and Source modes. */
export function saveMarkdownSyncAnchor(group: number, path: string, anchor: { line: number; column: number; topLine?: number }) {
	syncAnchors.set(`${group}:${path}`, { ...anchor, at: Date.now() });
}

/** Reads and consumes a recent (<3s) Live<->Source cursor/scroll handoff anchor. */
export function takeMarkdownSyncAnchor(group: number, path: string): MarkdownSyncAnchor | null {
	const key = `${group}:${path}`;
	const found = syncAnchors.get(key);
	if (!found) return null;
	syncAnchors.delete(key);
	return Date.now() - found.at < 3000 ? found : null;
}

type SplitScrollPayload = { sourceGroup: number; path: string; topLine: number; ratio: number };
const splitScrollListeners = new Set<(payload: SplitScrollPayload) => void>();

/** Broadcasts vertical scroll position so a split Read preview of the same Markdown file stays in sync. */
export function emitSplitScrollSync(sourceGroup: number, path: string, topLine: number, ratio: number) {
	for (const fn of splitScrollListeners) fn({ sourceGroup, path, topLine, ratio });
}

export function onSplitScrollSync(listener: (payload: SplitScrollPayload) => void): () => void {
	splitScrollListeners.add(listener);
	return () => splitScrollListeners.delete(listener);
}

export function registerTableFind(group: number, opener: ((replace?: boolean) => void) | undefined) {
	if (opener) tableFinders[group] = opener;
	else delete tableFinders[group];
}

/** Opens the TableView Find/Replace bar on the active group when a CSV/TSV table is visible. */
export function openTableFind(replace = false): boolean {
	const fn = tableFinders[state.activeGroup];
	if (!fn) return false;
	fn(replace);
	return true;
}

export function hasTableFind(): boolean {
	return Boolean(tableFinders[state.activeGroup]);
}

export function registerTableColumnJump(group: number, jumper: ((colIndex: number) => void) | undefined) {
	if (jumper) tableColumnJumpers[group] = jumper;
	else delete tableColumnJumpers[group];
}

export function jumpToTableColumn(colIndex: number): boolean {
	const fn = tableColumnJumpers[state.activeGroup];
	if (!fn) return false;
	fn(colIndex);
	return true;
}

export function registerLiveEditor(group: number, handle: LiveEditorHandle | undefined) {
	if (handle) liveEditors[group] = handle;
	else delete liveEditors[group];
}

/** Identity-checked unregistration: clears `group` only when `handle` is still the registered instance. */
export function unregisterLiveEditor(group: number, handle: LiveEditorHandle): boolean {
	if (liveEditors[group] !== handle) return false;
	delete liveEditors[group];
	return true;
}

export function registerReadFind(group: number, opener: (() => void) | undefined) {
	if (opener) readFinders[group] = opener;
	else delete readFinders[group];
}

/** Identity-checked unregistration: clears `group` only when `opener` is still the registered instance. */
export function unregisterReadFinder(group: number, opener: () => void): boolean {
	if (readFinders[group] !== opener) return false;
	delete readFinders[group];
	return true;
}

/** Any group's Read-mode find opener by group index. */
export const readFinderAt = (group: number): (() => void) | undefined => readFinders[group];

/** Opens the CM6 Find panel on the active group when it is in Read-only Markdown view. */
export function openReadFind(): boolean {
	const fn = readFinders[state.activeGroup];
	if (!fn) return false;
	fn();
	return true;
}

/** The active group's live Markdown editor, when it is mounted and showing Markdown Live mode. */
export const activeLiveEditor = (): LiveEditorHandle | undefined => liveEditors[state.activeGroup];

/** Any group's live Markdown editor by group index. */
export const liveEditorAt = (group: number): LiveEditorHandle | undefined => liveEditors[group];

/**
 * True when keyboard focus is inside a Markdown text editor (either CodeMirror 6
 * Live Preview or Monaco in Source mode on a Markdown file), so text-editing
 * shortcuts like Ctrl+B (Bold) take precedence over non-editing window shortcuts.
 */
export function isInMarkdownTextEditor(target: EventTarget | null, activeLanguage?: string): boolean {
	const el = typeof Element !== "undefined" && target instanceof Element ? target : typeof document !== "undefined" ? document.activeElement : null;
	if (!el) return false;
	if (el.closest(".cm-panels, .cm-md-table-wrap, .find-widget, .rename-input")) return false;
	if (el.closest("input, textarea:not(.inputarea)")) return false;
	if (el.closest(".cm-editor") && !el.closest(".cm-md-read")) return true;
	if (el.closest(".monaco-editor") && activeLanguage === "markdown") return true;
	return false;
}
