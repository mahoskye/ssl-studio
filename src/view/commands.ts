// App commands: the command palette lists them, the keyboard runs them.
import { ask } from "./dialogs";
import { activeEditor } from "./editor/EditorGroup";
import { backend, inApp } from "./backend";
import { monaco } from "./editor/monaco";
import { session } from "./lsp/session";
import { symbols } from "./panels/Objects";
import { symbolPath } from "./editor/regions";
import { openStyleProfile } from "./StyleProfile";
import { movePanel, showPanel } from "./panels/registry";
import { insertTemplate } from "./panels/Palette";
import { TEMPLATES } from "../shared/houseStyle";
import { askAbout } from "./agent/Agent";
import { startTidy } from "./agent/tidy";
import { joinPath } from "../shared/paths";
import { isPlanPath, newPlan, printPlan } from "./plan/model";
import { activePath, closeTab, notify, openFile, openFolder, revert, save, saveAll, setState, split, state } from "./state";

export type Command = { id: string; label: string; keys?: string; run: () => void };

const toggle = (key: "left" | "bottom" | "right") => setState("settings", "layout", key, (v) => !v);

export const commands: Command[] = [
	{ id: "open-folder", label: "Open folder…", keys: "Ctrl+O", run: () => void openFolderCommand() },
	{ id: "quick-open", label: "Go to file…", keys: "Ctrl+P", run: () => setState("quickPick", "files") },
	{ id: "symbols", label: "Go to symbol in workspace…", keys: "Ctrl+T", run: () => setState("quickPick", "symbols") },
	{ id: "save", label: "Save", keys: "Ctrl+S", run: () => void save() },
	{ id: "save-all", label: "Save all", keys: "Ctrl+Alt+S", run: () => void saveAll() },
	{ id: "revert", label: "Revert file to disk", run: () => activePath() && void revert(activePath()!) },
	{ id: "close", label: "Close editor", keys: "Ctrl+W", run: () => activePath() && void closeTab(activePath()!) },
	{ id: "split", label: "Split editor", keys: "Ctrl+\\", run: split },
	{ id: "blocks", label: "Toggle blocks view (a plan: its chart)", keys: "Ctrl+Shift+B", run: toggleVisual },
	{ id: "new-plan", label: "New plan…", run: () => void newPlanCommand() },
	{ id: "copy-designer", label: "Copy for Designer (selection, procedure or file, formatted)", keys: "Ctrl+Shift+C", run: () => void copyForDesigner() },
	{ id: "wrap-region", label: "Wrap the selected lines in a region…", run: () => void wrapInRegion() },
	{ id: "graph", label: "Show the call graph", keys: "Ctrl+Shift+G", run: () => setState("centerView", state.centerView === "graph" ? "editors" : "graph") },
	{ id: "format", label: "Format document", keys: "Ctrl+Shift+I", run: () => void activeEditor()?.getAction("editor.action.formatDocument")?.run() },
	{ id: "search", label: "Search the workspace", keys: "Ctrl+Shift+F", run: () => showPanel("search") },
	{ id: "explorer", label: "Show Explorer", keys: "Ctrl+Shift+E", run: () => showPanel("explorer") },
	{ id: "objects", label: "Show Objects", run: () => showPanel("objects") },
	{ id: "history", label: "Show local history", run: () => showPanel("history") },
	{ id: "toggle-sidebar", label: "Toggle side bar", keys: "Ctrl+B", run: () => toggle("left") },
	{ id: "toggle-panel", label: "Toggle bottom panel", keys: "Ctrl+J", run: () => toggle("bottom") },
	{ id: "problems", label: "Show problems", keys: "Ctrl+Shift+M", run: () => (setState("bottomView", "problems"), setState("settings", "layout", "bottom", true)) },
	{ id: "output", label: "Show output", run: () => (setState("bottomView", "output"), setState("settings", "layout", "bottom", true)) },
	{ id: "style-profile", label: "Style profile…", run: () => openStyleProfile() },
	{ id: "palette", label: "Show the template palette", run: () => showPanel("palette") },
	{ id: "reference", label: "Show the SSL reference", run: () => showPanel("reference") },
	{ id: "health", label: "Show script health", run: () => showPanel("health") },
	{ id: "insert-banner", label: "Insert the file banner", run: () => insertTemplate(TEMPLATES.find((t) => t.id === "banner")!) },
	{ id: "insert-procedure", label: "Insert a procedure", run: () => insertTemplate(TEMPLATES.find((t) => t.id === "procedure")!) },
	{ id: "agent", label: "Show the agent", run: () => showPanel("agent") },
	{ id: "agent-ask", label: "Ask the agent about the selection…", keys: "Ctrl+Shift+A", run: () => void askCommand() },
	{ id: "tidy", label: "Tidy this file with the agent", run: () => (startTidy(), showPanel("agent")) },
	{ id: "move-panel", label: "Move the open left panel to the right", run: () => state.settings.layout.left && movePanel(state.leftView) },
	{ id: "move-panel-back", label: "Move the open right panel to the left", run: () => state.settings.layout.right && movePanel(state.rightView) },
	{ id: "lsp-restart", label: "Restart the language server", run: () => void backend.lspRestart() },
	{ id: "settings", label: "Settings…", keys: "Ctrl+,", run: () => openSettings() },
	{ id: "editor-commands", label: "Editor commands…", keys: "F1", run: () => activeEditor()?.trigger("app", "editor.action.quickCommand", null) },
];

let settingsOpener: () => void = () => {};
export const onOpenSettings = (open: () => void) => (settingsOpener = open);
const openSettings = () => settingsOpener();

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

/** The selection, else the procedure at the cursor, else the file: formatted, then copied. */
function toggleVisual() {
	const path = activePath();
	if (isPlanPath(path)) setState("planText", path!, (text) => !text);
	else setState("groups", state.activeGroup, "mode", (m) => (m === "blocks" ? "text" : "blocks"));
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

export const DEFAULT_KEYS: Record<string, string> = {
	"ctrl+o": "open-folder",
	"ctrl+p": "quick-open",
	"ctrl+t": "symbols",
	"ctrl+shift+p": "palette",
	"ctrl+s": "save",
	"ctrl+alt+s": "save-all",
	"ctrl+w": "close",
	"ctrl+\\": "split",
	"ctrl+shift+f": "search",
	"ctrl+shift+e": "explorer",
	"ctrl+b": "toggle-sidebar",
	"ctrl+j": "toggle-panel",
	"ctrl+shift+m": "problems",
	"ctrl+,": "settings",
	"ctrl+shift+a": "agent-ask",
	"ctrl+shift+b": "blocks",
	"ctrl+shift+g": "graph",
	"ctrl+shift+c": "copy-designer",
	"ctrl+shift+i": "format",
};

/** The default shortcuts with the user's overrides ("" unbinds). */
export function keymap(): Record<string, string> {
	const map: Record<string, string> = { ...DEFAULT_KEYS };
	for (const [key, id] of Object.entries(state.settings.keys ?? {})) {
		if (id) map[key.toLowerCase()] = id;
		else delete map[key.toLowerCase()];
	}
	return map;
}

export const keysFor = (id: string) =>
	Object.entries(keymap())
		.filter(([, c]) => c === id)
		.map(([k]) => k.replace(/\b\w/g, (c) => c.toUpperCase()))
		.join(", ");

export function installKeys() {
	window.addEventListener(
		"keydown",
		(e) => {
			const key = `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${e.altKey ? "alt+" : ""}${e.shiftKey ? "shift+" : ""}${e.key.toLowerCase()}`;
			const id = keymap()[key];
			if (!id) return;
			e.preventDefault();
			e.stopPropagation();
			if (id === "palette") setState("quickPick", "commands");
			else commands.find((c) => c.id === id)?.run();
		},
		true,
	);
}
