// App commands: the command palette lists them, the keyboard runs them.
import { ask } from "./dialogs";
import { activeEditor } from "./editor/EditorGroup";
import { backend, inApp } from "./backend";
import { activePath, closeTab, openFolder, revert, save, saveAll, setState, split, state } from "./state";

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
	{ id: "format", label: "Format document", keys: "Ctrl+Shift+I", run: () => void activeEditor()?.getAction("editor.action.formatDocument")?.run() },
	{ id: "search", label: "Search the workspace", keys: "Ctrl+Shift+F", run: () => (setState("leftView", "search"), setState("settings", "layout", "left", true)) },
	{ id: "explorer", label: "Show Explorer", keys: "Ctrl+Shift+E", run: () => (setState("leftView", "explorer"), setState("settings", "layout", "left", true)) },
	{ id: "objects", label: "Show Objects", run: () => (setState("leftView", "objects"), setState("settings", "layout", "left", true)) },
	{ id: "history", label: "Show local history", run: () => (setState("leftView", "history"), setState("settings", "layout", "left", true)) },
	{ id: "toggle-sidebar", label: "Toggle side bar", keys: "Ctrl+B", run: () => toggle("left") },
	{ id: "toggle-panel", label: "Toggle bottom panel", keys: "Ctrl+J", run: () => toggle("bottom") },
	{ id: "problems", label: "Show problems", keys: "Ctrl+Shift+M", run: () => (setState("bottomView", "problems"), setState("settings", "layout", "bottom", true)) },
	{ id: "output", label: "Show output", run: () => (setState("bottomView", "output"), setState("settings", "layout", "bottom", true)) },
	{ id: "lsp-restart", label: "Restart the language server", run: () => void backend.lspRestart() },
	{ id: "settings", label: "Settings…", keys: "Ctrl+,", run: () => openSettings() },
	{ id: "editor-commands", label: "Editor commands…", keys: "F1", run: () => activeEditor()?.trigger("app", "editor.action.quickCommand", null) },
];

let settingsOpener: () => void = () => {};
export const onOpenSettings = (open: () => void) => (settingsOpener = open);
const openSettings = () => settingsOpener();

async function openFolderCommand() {
	if (inApp) return openFolder();
	// A browser tab has no folder dialog: ask for a path instead.
	const path = await ask("Folder to open (absolute path)", state.workspace?.root ?? "");
	if (path) await openFolder(path);
}

const KEYS: Record<string, string> = {
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
};

export function installKeys() {
	window.addEventListener(
		"keydown",
		(e) => {
			const key = `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${e.altKey ? "alt+" : ""}${e.shiftKey ? "shift+" : ""}${e.key.toLowerCase()}`;
			const id = KEYS[key];
			if (!id) return;
			e.preventDefault();
			e.stopPropagation();
			if (id === "palette") setState("quickPick", "commands");
			else commands.find((c) => c.id === id)?.run();
		},
		true,
	);
}
