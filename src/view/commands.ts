// App commands: the command list shows them, the keyboard runs them.
// A command's keys are in DEFAULT_KEYS and nowhere else; the user's own are
// in the `keys` setting.
import { ask } from "./dialogs";
import { activeEditor } from "./editor/EditorGroup";
import { backend, inApp } from "./backend";
import { monaco } from "./editor/monaco";
import { session } from "./lsp/session";
import { symbols } from "./panels/Objects";
import { symbolPath } from "./editor/regions";
import { openStyleProfile } from "./StyleProfile";
import { movePanel, showPanel } from "./panels/registry";
import { explorerDelete, explorerNewFile, explorerRename } from "./panels/Explorer";
import { insertTemplate } from "./panels/Palette";
import { TEMPLATES } from "../shared/houseStyle";
import { askAbout } from "./agent/Agent";
import { startTidy } from "./agent/tidy";
import { joinPath } from "../shared/paths";
import { isPlanPath, newPlan, printPlan } from "./plan/model";
import { isMarkdown, isTable, newDoc, setUpProject, undoSetUp } from "./project";
import { newKnowledge, newRegistry, newSpec, newState, newTicket, updateCatalogs, updateManifest } from "./projectDocs";
import { displayKey, effectiveKeys, isModifierKey, keyNames, keysOf } from "./keys";
import { modalOpen, setFocusFallback } from "./modal";
import { noteUsed } from "./quickRank";
import { stepScale, UI_SCALE } from "./uiScale";
import {
	activePath,
	closeAllTabs,
	closeOtherTabs,
	closeTab,
	focusEditor,
	focusSidePanel,
	nextTab,
	notify,
	openFile,
	openFolder,
	previousTab,
	reopenClosedTab,
	revert,
	save,
	saveAll,
	saveSetting,
	setState,
	split,
	state,
} from "./state";

/** `label` is a verb phrase; `detail` is the quieter second line that explains it. */
export type Command = { id: string; label: string; detail?: string; run: () => void };

const toggle = (key: "left" | "bottom" | "right") => setState("settings", "layout", key, (v) => !v);
const showBottom = (view: "problems" | "output") => (setState("bottomView", view), setState("settings", "layout", "bottom", true));
/** The `uiScale` setting, one step up or down, or back to 1. */
const zoom = (by: 1 | -1 | 0) => void saveSetting({ uiScale: by ? stepScale(state.settings.uiScale, by) : UI_SCALE.normal });

export const commands: Command[] = [
	// Files and tabs
	{ id: "open-folder", label: "Open folder…", run: () => void openFolderCommand() },
	{ id: "quick-open", label: "Go to file…", run: () => setState("quickPick", "files") },
	{ id: "symbols", label: "Go to symbol…", detail: "Anywhere in the workspace", run: () => setState("quickPick", "symbols") },
	{ id: "command-palette", label: "Show all commands", run: () => setState("quickPick", "commands") },
	{ id: "new-file", label: "New file or folder…", detail: "In the Explorer's folder, or beside the open file", run: () => void explorerNewFile() },
	{ id: "rename-file", label: "Rename…", detail: "The Explorer's file, or the open one", run: () => void explorerRename() },
	{ id: "trash-file", label: "Move to trash…", detail: "The Explorer's file, or the open one", run: () => void explorerDelete() },
	{ id: "save", label: "Save", run: () => void save() },
	{ id: "save-all", label: "Save all", run: () => void saveAll() },
	{ id: "revert", label: "Revert file", detail: "Back to what is on disk", run: () => activePath() && void revert(activePath()!) },
	{ id: "close", label: "Close tab", run: () => activePath() && void closeTab(activePath()!) },
	{ id: "close-others", label: "Close other tabs", run: () => void closeOtherTabs() },
	{ id: "close-all", label: "Close all tabs", run: () => void closeAllTabs() },
	{ id: "reopen-tab", label: "Reopen closed tab", run: () => void reopenClosedTab() },
	{ id: "next-tab", label: "Next tab", run: nextTab },
	{ id: "previous-tab", label: "Previous tab", run: previousTab },
	{ id: "split", label: "Split editor", run: split },
	{ id: "focus-editor", label: "Focus editor", run: focusEditor },
	{ id: "focus-side-panel", label: "Focus side panel", run: focusSidePanel },
	// The code
	{ id: "blocks", label: "Toggle blocks view", detail: "A plan shows its chart; Markdown shows rendered", run: toggleVisual },
	{ id: "format", label: "Format document", run: () => void activeEditor()?.getAction("editor.action.formatDocument")?.run() },
	{ id: "copy-designer", label: "Copy for Designer", detail: "Selection, procedure or file, formatted", run: () => void copyForDesigner() },
	{ id: "wrap-region", label: "Wrap in region…", detail: "The selected lines", run: () => void wrapInRegion() },
	{ id: "insert-banner", label: "Insert file banner", run: () => insertTemplate(TEMPLATES.find((t) => t.id === "banner")!) },
	{ id: "insert-procedure", label: "Insert procedure", run: () => insertTemplate(TEMPLATES.find((t) => t.id === "procedure")!) },
	{ id: "editor-commands", label: "Show editor commands…", detail: "The text editor's own list", run: () => activeEditor()?.trigger("app", "editor.action.quickCommand", null) },
	// The project
	{ id: "setup-project", label: "Set up project", detail: "Settings, README, AGENTS", run: () => void setUpProject() },
	{ id: "undo-setup-project", label: "Undo set up project", detail: "Removes what it created and nobody has changed since", run: () => void undoSetUp() },
	{ id: "project-settings", label: "Open project settings", detail: "project.toml", run: () => void openProjectSettings() },
	{ id: "new-doc", label: "New document…", run: () => void newDoc() },
	{ id: "new-plan", label: "New plan…", run: () => void newPlanCommand() },
	{ id: "new-ticket", label: "New ticket…", detail: "The work as it was asked for", run: () => void newTicket() },
	{ id: "new-spec", label: "New spec…", detail: "What is to be built, for a ticket", run: () => void newSpec() },
	{ id: "new-decision", label: "New decision…", detail: "In the knowledge base", run: () => void newKnowledge("decisions") },
	{ id: "new-question", label: "New question…", detail: "In the knowledge base", run: () => void newKnowledge("questions") },
	{ id: "new-snippet", label: "New snippet…", detail: "SQL or SSL kept for use", run: () => void newKnowledge("snippets") },
	{ id: "new-reference", label: "New reference note…", detail: "How something works", run: () => void newKnowledge("reference") },
	{ id: "new-registry", label: "New registry…", detail: "Settings, files, database objects", run: () => void newRegistry() },
	{ id: "project-state", label: "Project state…", detail: "Where the project stands, in plain words", run: () => void newState() },
	{ id: "update-catalogs", label: "Update catalogs", detail: "Write each INDEX.md's list afresh", run: () => void updateCatalogs() },
	{ id: "update-manifest", label: "Update file manifest", detail: "Sizes and checksums of the project's files", run: () => void updateManifest() },
	// Panels: one form, "Show" and the panel's name
	{ id: "explorer", label: "Show Explorer", run: () => showPanel("explorer") },
	{ id: "docs", label: "Show Docs", run: () => showPanel("docs") },
	{ id: "objects", label: "Show Objects", run: () => showPanel("objects") },
	{ id: "palette", label: "Show Palette", detail: "Templates to insert", run: () => showPanel("palette") },
	{ id: "reference", label: "Show Reference", detail: "Built-in functions, classes and keywords", run: () => showPanel("reference") },
	{ id: "search", label: "Show Search", run: () => showPanel("search") },
	{ id: "history", label: "Show Local history", run: () => showPanel("history") },
	{ id: "health", label: "Show Health", detail: "The script against the house style", run: () => showPanel("health") },
	{ id: "agent", label: "Show Agent", run: () => showPanel("agent") },
	{ id: "problems", label: "Show Problems", run: () => showBottom("problems") },
	{ id: "output", label: "Show Output", run: () => showBottom("output") },
	{ id: "graph", label: "Show Call graph", detail: "Again to go back to the editors", run: () => setState("centerView", state.centerView === "graph" ? "editors" : "graph") },
	{ id: "toggle-sidebar", label: "Toggle side bar", run: () => toggle("left") },
	{ id: "toggle-panel", label: "Toggle bottom panel", run: () => toggle("bottom") },
	{ id: "move-panel", label: "Move left panel to the right", detail: "The one that is open", run: () => state.settings.layout.left && movePanel(state.leftView) },
	{ id: "move-panel-back", label: "Move right panel to the left", detail: "The one that is open", run: () => state.settings.layout.right && movePanel(state.rightView) },
	// The agent
	{ id: "agent-ask", label: "Ask the agent…", detail: "About the selection", run: () => void askCommand() },
	{ id: "tidy", label: "Tidy file with the agent", run: () => (startTidy(), showPanel("agent")) },
	// The IDE
	{ id: "style-profile", label: "Edit style profile…", detail: "How the language server formats and checks", run: () => openStyleProfile() },
	{ id: "lsp-restart", label: "Restart language server", run: () => void backend.lspRestart() },
	{ id: "zoom-in", label: "Zoom in", detail: "A larger interface", run: () => zoom(1) },
	{ id: "zoom-out", label: "Zoom out", detail: "A smaller interface", run: () => zoom(-1) },
	{ id: "zoom-reset", label: "Reset zoom", run: () => zoom(0) },
	{ id: "settings", label: "Open settings…", run: () => openSettings() },
];

/** The commands run from the command list this session, newest first (ten are kept). */
let recent: string[] = [];
export const recentCommands = () => recent;

/** Runs a command by id. `remember` puts it among the recently used, for the command list. */
export function runCommand(id: string, options: { remember?: boolean } = {}) {
	const command = commands.find((c) => c.id === id);
	if (!command) return;
	if (options.remember) recent = noteUsed(recent, id);
	command.run();
}

let settingsOpener: () => void = () => {};
export const onOpenSettings = (open: () => void) => (settingsOpener = open);
export const openSettings = () => settingsOpener();

/** Puts the selected lines inside a new comment region (a frame in blocks mode). */
async function wrapInRegion() {
	const editor = activeEditor();
	const model = editor?.getModel();
	const selection = editor?.getSelection();
	if (!editor || !model || !selection) return;
	const name = await ask("Name of the new region");
	if (!name) return;
	const start = selection.startLineNumber;
	const end = selection.endColumn === 1 && selection.endLineNumber > start ? selection.endLineNumber - 1 : selection.endLineNumber;
	const eol = model.getEOL();
	model.pushStackElement();
	model.pushEditOperations(
		[],
		[
			{ range: new monaco.Range(start, 1, start, 1), text: `/* region ${name};${eol}${eol}` },
			{ range: new monaco.Range(end, model.getLineMaxColumn(end), end, model.getLineMaxColumn(end)), text: `${eol}${eol}/* endregion;` },
		],
		() => null,
	);
	model.pushStackElement();
	editor.focus();
}

/** Blocks for a script; for a plan its chart, for Markdown the rendered page. */
function toggleVisual() {
	const path = activePath();
	if (isPlanPath(path)) setState("planText", path!, (text) => !text);
	else if (isMarkdown(path) || isTable(path)) setState("mdText", path!, (text) => !text);
	else setState("groups", state.activeGroup, "mode", (m) => (m === "blocks" ? "text" : "blocks"));
}

async function openProjectSettings() {
	if (!state.project) return notify("Open a folder first.");
	if (!state.project.configured) return setUpProject();
	await openFile(state.project.path);
}

/** A new plan in `design/`, beside the tidy notes, opened as its chart (ADR 0005). */
async function newPlanCommand() {
	if (!state.workspace) return notify("Open a folder first.");
	const name = (await ask("Name of the new plan"))?.trim();
	if (!name) return;
	const path = joinPath(state.workspace.root, "design", `${name.replace(/\.plan\.json$/i, "").replace(/[\\/:*?"<>|]+/g, "-")}.plan.json`);
	const exists = await backend.read(path).then(
		() => true,
		() => false,
	);
	if (!exists) {
		await backend.write(path, printPlan(newPlan(name)));
		setState("treeVersion", (v) => v + 1);
	}
	await openFile(path);
}

/** The selection, else the procedure at the cursor, else the file: formatted, then copied. */
async function copyForDesigner() {
	const editor = activeEditor();
	const model = editor?.getModel();
	if (!editor || !model) return;
	const selection = editor.getSelection();
	let text: string;
	let what: string;
	if (selection && !selection.isEmpty()) {
		text = model.getValueInRange(selection);
		what = "selection";
	} else {
		const path = symbolPath(symbols(), editor.getPosition()!.lineNumber);
		const proc = [...path].reverse().find((s) => s.kind === monaco.languages.SymbolKind.Function || s.kind === monaco.languages.SymbolKind.Method);
		text = proc ? model.getValueInRange(new monaco.Range(proc.range.startLineNumber, 1, proc.range.endLineNumber, model.getLineMaxColumn(proc.range.endLineNumber))) : model.getValue();
		what = proc ? `procedure ${proc.name}` : "file";
	}
	if (model.getLanguageId() === "ssl" && state.lsp.state === "running") {
		const options = model.getOptions();
		text = await session.formatText(text, { tabSize: options.tabSize, insertSpaces: options.insertSpaces }).catch(() => text);
	}
	const copied = (await backend.clipboard(text).catch(() => false)) || (await navigator.clipboard?.writeText(text).then(() => true, () => false));
	notify(copied ? `Copied the ${what}, formatted, for Designer.` : "Could not reach the clipboard.", copied ? "info" : "error");
}

async function askCommand() {
	const question = await ask("Ask the agent about the selection");
	if (!question) return;
	showPanel("agent");
	await askAbout(question, true);
}

async function openFolderCommand() {
	if (inApp) return openFolder();
	// A browser tab has no folder dialog: ask for a path instead.
	const path = await ask("Folder to open (absolute path)", state.workspace?.root ?? "");
	if (path) await openFolder(path);
}

/**
 * Every default shortcut: the one place a command's keys are written down.
 * A command may have more than one (a key that differs between layouts).
 */
export const DEFAULT_KEYS: Record<string, string> = {
	"ctrl+o": "open-folder",
	"ctrl+p": "quick-open",
	"ctrl+t": "symbols",
	"ctrl+shift+p": "command-palette",
	"ctrl+s": "save",
	"ctrl+alt+s": "save-all",
	"ctrl+w": "close",
	"ctrl+shift+t": "reopen-tab",
	"ctrl+pagedown": "next-tab",
	"ctrl+pageup": "previous-tab",
	"ctrl+\\": "split",
	// Where the backslash needs AltGr, Ctrl with it arrives as Ctrl+Alt.
	"ctrl+alt+\\": "split",
	"ctrl+1": "focus-editor",
	"ctrl+0": "focus-side-panel",
	"ctrl+shift+f": "search",
	"ctrl+shift+e": "explorer",
	"ctrl+b": "toggle-sidebar",
	"ctrl+j": "toggle-panel",
	"ctrl+shift+m": "problems",
	"ctrl+,": "settings",
	// Not Ctrl+Shift+A: that is the editor's block comment on Linux.
	"ctrl+shift+h": "agent-ask",
	"ctrl+shift+b": "blocks",
	"ctrl+shift+g": "graph",
	"ctrl+shift+c": "copy-designer",
	"ctrl+shift+i": "format",
	"ctrl+=": "zoom-in",
	// The plus key itself, where it needs no Shift, and the number pad's.
	"ctrl++": "zoom-in",
	"ctrl+-": "zoom-out",
	"ctrl+shift+0": "zoom-reset",
	f1: "editor-commands",
};

/** The default shortcuts with the user's overrides ("" unbinds). */
export function keymap(): Record<string, string> {
	return effectiveKeys(DEFAULT_KEYS, state.settings.keys ?? {});
}

/** A command's shortcuts as they are shown: "Ctrl+Shift+P", several joined by ", ". */
export const keysFor = (id: string) => keysOf(id, keymap()).map(displayKey).join(", ");

export function installKeys() {
	setFocusFallback(focusEditor);
	window.addEventListener(
		"keydown",
		(e) => {
			// A modal has the keyboard: only its own keys work, and a shortcut
			// being recorded in Settings runs nothing.
			// AltGr is typing a character (a backslash on many layouts), never a shortcut.
			if (modalOpen() || isModifierKey(e.key) || e.getModifierState("AltGraph")) return;
			const map = keymap();
			const id = keyNames(e)
				.map((name) => map[name])
				.find(Boolean);
			if (!id) return;
			e.preventDefault();
			e.stopPropagation();
			runCommand(id);
		},
		true,
	);
}
