// Active CodeMirror 6 Live Preview handle registry: lets the menu bar, command
// palette, status bar, navigation history, Agent panel, and working-doc actions
// talk to the Markdown Live view with the exact same ergonomics as Monaco.
import { state } from "../state";

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
	insertText(text: string): void;
};

const liveEditors: Record<number, LiveEditorHandle | undefined> = {};

export function registerLiveEditor(group: number, handle: LiveEditorHandle | undefined) {
	if (handle) liveEditors[group] = handle;
	else delete liveEditors[group];
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
	const el = target instanceof Element ? target : document.activeElement;
	if (!el) return false;
	if (el.closest(".cm-editor")) return true;
	if (el.closest(".monaco-editor") && activeLanguage === "markdown") return true;
	return false;
}
