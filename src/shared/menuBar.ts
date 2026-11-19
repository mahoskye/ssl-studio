// The menu bar's menus, as data: which entries each menu has, in which order,
// what each one runs and what it needs before it can run. No DOM and no app
// state; the bar itself (src/view/MenuBar.tsx) draws this and runs it.
//
// The menus are the ones an editor is expected to have (File, Edit, Selection,
// View, Go, Help), and hold what is already a command here or in the text
// editor: a menu is a way to find a command, not a second place to keep one.

/** What has to be there before an entry can run. */
export type Needs = "folder" | "file" | "text";

/** What the window has now. `text` is a file shown as text, which the text editor's own commands act on. */
export type Has = { folder: boolean; file: boolean; text: boolean };

export type BarEntry =
	| "separator"
	/** One of the app's commands, by its id. */
	| { label: string; command: string; needs?: Needs }
	/** One of the text editor's own commands, by its id there. */
	| { label: string; editor: string; needs: "file" | "text" }
	/** Something only the bar does. */
	| { label: string; does: "shortcuts" | "about" };

/** A menu: its name, the letter Alt opens it with, and its entries. */
export type BarMenu = { name: string; letter: string; entries: BarEntry[] };

const text = (label: string, editor: string): BarEntry => ({ label, editor, needs: "text" });
const forFile = (label: string, command: string): BarEntry => ({ label, command, needs: "file" });
const forFolder = (label: string, command: string): BarEntry => ({ label, command, needs: "folder" });

export const MENU_BAR: BarMenu[] = [
	{
		name: "File",
		letter: "f",
		entries: [
			forFolder("New file or folder…", "new-file"),
			{ label: "Open folder…", command: "open-folder" },
			"separator",
			forFile("Save", "save"),
			forFile("Save all", "save-all"),
			forFile("Revert file", "revert"),
			"separator",
			forFolder("Rename…", "rename-file"),
			forFolder("Move to trash…", "trash-file"),
			forFile("Copy path", "copy-path"),
			forFile("Copy path in the project", "copy-relative-path"),
			"separator",
			forFile("Close tab", "close"),
			forFile("Close other tabs", "close-others"),
			forFile("Close all tabs", "close-all"),
			forFolder("Reopen closed tab", "reopen-tab"),
			"separator",
			forFolder("Project settings", "project-settings"),
			{ label: "Settings…", command: "settings" },
		],
	},
	{
		name: "Edit",
		letter: "e",
		entries: [
			{ label: "Undo", editor: "undo", needs: "file" },
			{ label: "Redo", editor: "redo", needs: "file" },
			"separator",
			text("Cut", "editor.action.clipboardCutAction"),
			text("Copy", "editor.action.clipboardCopyAction"),
			text("Paste", "editor.action.clipboardPasteAction"),
			"separator",
			text("Find", "actions.find"),
			text("Replace", "editor.action.startFindReplaceAction"),
			forFolder("Find in files", "search"),
			"separator",
			text("Toggle line comment", "editor.action.commentLine"),
			text("Toggle block comment", "editor.action.blockComment"),
			{ label: "Format document", command: "format", needs: "text" },
			{ label: "Wrap in region…", command: "wrap-region", needs: "text" },
			{ label: "Copy for Designer", command: "copy-designer", needs: "text" },
		],
	},
	{
		name: "Selection",
		letter: "s",
		entries: [
			text("Select all", "editor.action.selectAll"),
			text("Expand selection", "editor.action.smartSelect.expand"),
			text("Shrink selection", "editor.action.smartSelect.shrink"),
			"separator",
			text("Copy line up", "editor.action.copyLinesUpAction"),
			text("Copy line down", "editor.action.copyLinesDownAction"),
			text("Move line up", "editor.action.moveLinesUpAction"),
			text("Move line down", "editor.action.moveLinesDownAction"),
			"separator",
			text("Add cursor above", "editor.action.insertCursorAbove"),
			text("Add cursor below", "editor.action.insertCursorBelow"),
			text("Add next occurrence", "editor.action.addSelectionToNextFindMatch"),
			text("Select all occurrences", "editor.action.selectHighlights"),
		],
	},
	{
		name: "View",
		letter: "v",
		entries: [
			{ label: "All commands…", command: "command-palette" },
			"separator",
			forFolder("Explorer", "explorer"),
			forFolder("Search", "search"),
			forFolder("Docs", "docs"),
			forFolder("Objects", "objects"),
			forFolder("Palette", "palette"),
			forFolder("Reference", "reference"),
			forFolder("Local history", "history"),
			forFolder("Health", "health"),
			forFolder("Agent", "agent"),
			"separator",
			forFolder("Problems", "problems"),
			forFolder("Output", "output"),
			forFolder("Call graph", "graph"),
			"separator",
			forFolder("Toggle side bar", "toggle-sidebar"),
			forFolder("Toggle bottom panel", "toggle-panel"),
			{ label: "Hide the menu bar", command: "toggle-menu-bar" },
			"separator",
			forFile("Split editor", "split"),
			forFile("Toggle blocks view", "blocks"),
			{ label: "Toggle word wrap", command: "word-wrap" },
			"separator",
			{ label: "Zoom in", command: "zoom-in" },
			{ label: "Zoom out", command: "zoom-out" },
			{ label: "Reset zoom", command: "zoom-reset" },
		],
	},
	{
		name: "Go",
		letter: "g",
		entries: [
			forFolder("Back", "go-back"),
			forFolder("Forward", "go-forward"),
			"separator",
			forFolder("Go to file…", "quick-open"),
			forFolder("Go to symbol in the workspace…", "symbols"),
			text("Go to symbol in the file…", "editor.action.quickOutline"),
			text("Go to line…", "editor.action.gotoLine"),
			"separator",
			text("Go to definition", "editor.action.revealDefinition"),
			text("Go to references", "editor.action.goToReferences"),
			text("Go to bracket", "editor.action.jumpToBracket"),
			"separator",
			text("Next problem", "editor.action.marker.nextInFiles"),
			text("Previous problem", "editor.action.marker.prevInFiles"),
			"separator",
			forFile("Tab used before", "recent-tab"),
			forFile("Next tab", "next-tab"),
			forFile("Previous tab", "previous-tab"),
		],
	},
	{
		name: "Help",
		letter: "h",
		entries: [
			{ label: "All commands…", command: "command-palette" },
			{ label: "Keyboard shortcuts…", does: "shortcuts" },
			{ label: "The text editor's commands…", command: "editor-commands", needs: "text" },
			"separator",
			{ label: "About SSL Studio", does: "about" },
		],
	},
];

const WHY: Record<Needs, string> = {
	folder: "Open a folder first",
	file: "Open a file first",
	text: "For a file shown as text",
};

/** Why an entry cannot run now, in a few words; "" when it can. */
export function missing(entry: BarEntry, has: Has): string {
	if (entry === "separator" || !("needs" in entry) || !entry.needs) return "";
	// A file shown as text is a file, and a file is in a folder or on its own: each is asked for by name.
	if (entry.needs === "text" && !has.file) return WHY.file;
	return has[entry.needs] ? "" : WHY[entry.needs];
}

/** The menu Alt and a letter opens: its place in the bar, or -1. */
export const menuForLetter = (letter: string, menus: readonly BarMenu[] = MENU_BAR) => menus.findIndex((menu) => menu.letter === letter.toLowerCase());

/** The menu beside one, going round at the ends. */
export const stepMenu = (at: number, by: 1 | -1, count = MENU_BAR.length) => (((at + by) % count) + count) % count;

/**
 * The entry a typed letter goes to: the next one after `from` whose name
 * starts with it, going round; `from` itself when it is the only one, and -1
 * when none does. An entry the keyboard cannot land on (a separator, one that
 * cannot run now) is given as null.
 */
export function letterItem(labels: readonly (string | null)[], letter: string, from: number): number {
	const wanted = letter.toLowerCase();
	for (let step = 1; step <= labels.length; step++) {
		const at = (((from + step) % labels.length) + labels.length) % labels.length;
		if (labels[at]?.toLowerCase().startsWith(wanted)) return at;
	}
	return -1;
}
