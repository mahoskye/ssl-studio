// App commands: the command list shows them, the keyboard runs them.
// A command's keys are in DEFAULT_KEYS and nowhere else; the user's own are
// in the `keys` setting.
import { ask, choose, quickPick } from "./dialogs";
import { activeEditor, lastActiveMarkdownPath } from "./editor/EditorGroup";
import { formatFenceInModel, formatNonSslModel, hadRecentFormatError, languageName } from "./editor/languages";
import { pickLanguageMode } from "./editor/languagePicker";
import { activeLiveEditor, isInMarkdownTextEditor, saveMarkdownSyncAnchor } from "./editor/liveBridge";
import { linkWritten } from "../shared/docLinks";
import { folderParts } from "../shared/docSections";
import { canFormatNonSsl } from "../shared/format";
import { isCatalog, registryTitle, statusChoices, toneOf } from "../shared/projectDocs";
import { generateMermaidErDiagram, parseCreateTables, type SqlTableDef } from "../shared/sqlSchema";
import { workspaceTags } from "../shared/tags";
import { docsGoverningFile } from "../shared/workContext";
import { runMonacoMarkdownAction } from "./editor/markdownKeys";
import { backend, inApp } from "./backend";
import { monaco } from "./editor/monaco";
import { session } from "./lsp/session";
import { symbols } from "./panels/Objects";
import { symbolPath } from "./editor/regions";
import { openStyleProfile } from "./StyleProfile";
import { movePanel, panelOn, resetOutlineActive, resetPlanPaletteActive, showPanel, toggleSide } from "./panels/registry";
import { explorerDelete, explorerNewFile, explorerRename, showInExplorer } from "./panels/Explorer";
import { insertTemplate } from "./panels/Palette";
import { TEMPLATES } from "../shared/houseStyle";
import { askAbout, attachFileToAgent } from "./agent/Agent";
import { startTidy } from "./agent/tidy";
import { baseName, dirName, isInside, joinPath, relativePath, relativeTo } from "../shared/paths";
import { defaultLayout, type DocFile, type Settings } from "../shared/protocol";
import { menuForLetter, replaceErDiagramBlock, shouldLetEditorHandleKey } from "../shared/menuBar";
import { installRecentTabs, stepRecent } from "./recentTabs";
import { goAlong } from "./navigation";
import { isPlanPath, newPlan, printPlan, type Plan } from "./plan/model";
import { docs, isMarkdown, isTable, newDoc, setUpProject, undoSetUp } from "./project";
import {
	archiveTicket,
	closeoutTicket,
	createTicketFolder,
	exportDeploymentManifest,
	exportDocAs,
	exportReleaseBundle,
	exportRtm,
	exportTicketPacket,
	generateSchemaDocFromSql,
	importLegacyDoc,
	importTickets,
	isArchivedTicket,
	linkDocumentToTicket,
	linkNonTicketToTicket,
	newKnowledge,
	newRegistry,
	newSchema,
	newSpec,
	newState,
	newTicket,
	newTicketFile,
	onboardBrownfieldWorkspace,
	pickActiveTicket,
	promoteQuestionToDecision,
	renameHeadingAcrossWorkspace,
	renameTagAcrossWorkspace,
	setStatus,
	startFolderCatalogs,
	ticketAtHand,
	unarchiveTicket,
	updateCatalogs,
	updateManifest,
} from "./projectDocs";
import { insertCalloutInteractive, insertImageInteractive, insertMarkdownTemplate, manageTemplates, newNoteFromTemplate } from "./templater";
import { displayKey, effectiveKeys, isModifierKey, keyNames, keysOf } from "./keys";
import { modalOpen, setFocusFallback } from "./modal";
import { noteUsed } from "./quickRank";
import { stepScale, UI_SCALE } from "./uiScale";
import {
	activeDoc,
	activePath,
	applyText,
	canonical,
	closeAllTabs,
	closeOtherTabs,
	closeTab,
	closeTabsToRight,
	displayName,
	documents,
	newUntitled,
	focusEditor,
	focusSidePanel,
	keepTab,
	markdownMode,
	nextTab,
	notify,
	openFile,
	openFolder,
	openToSide,
	planMode,
	previousTab,
	reopenClosedTab,
	revert,
	sendTabAcross,
	setMarkdownMode,
	setPlanMode,
	setTableTextMode,
	shiftTab,
	save,
	saveAll,
	saveSetting,
	setState,
	split,
	state,
	syncLivePreviewMode,
	tableTextMode,
	togglePin,
} from "./state";

/** `label` is a verb phrase; `detail` is the quieter second line that explains it. */
export type Command = { id: string; label: string; detail?: string; run: () => void };

const toggle = (key: "bottom") => setState("settings", "layout", key, (v) => !v);
/** Shows or hides a side of the window. A side no panel is docked on has nothing to show, and says so. */
function toggleSideOf(side: "left" | "right") {
	if (!state.workspace) return;
	if (!panelOn(side)) return notify(`No panel is docked on the ${side}. Right-click a panel's button to move it there.`);
	toggleSide(side);
}
/**
 * The layout as a folder first opens with: what was moved goes home, what was resized is its first size. The menu
 * bar is shown. A side that was showing a panel now docked on the other one shows one of its own (App.tsx).
 * Showing the bar saves a setting; what comes back from a save leaves the layout on screen alone (state.ts).
 */
function resetLayout() {
	setState("bottomMaximized", false);
	resetOutlineActive();
	resetPlanPaletteActive();
	setState("settings", "layout", { ...defaultLayout(), dock: {} });
	if (state.settings.menuBar === false) void switchSetting("menuBar", true, (settings) => settings.menuBar !== false);
}
function toggleMaximizeBottom() {
	if (!state.workspace) return;
	if (!state.settings.layout.bottom) {
		setState("settings", "layout", "bottom", true);
		setState("bottomMaximized", true);
		return;
	}
	setState("bottomMaximized", (m) => !m);
}
const showBottom = (view: "problems" | "output") => (setState("bottomView", view), setState("settings", "layout", "bottom", true));
/** Puts text on the clipboard: by the app's own way where there is one, by the web view's otherwise. */
export async function copyText(text: string, said: string) {
	const copied = (await backend.clipboard(text).catch(() => false)) || (await navigator.clipboard?.writeText(text).then(() => true, () => false));
	// What could not be copied is shown, so that it can be copied by hand.
	notify(copied ? said : `Could not reach the clipboard. It was: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`, copied ? "info" : "error");
}

/** A file's path, whole or from the project's folder, with the slashes the system writes; or its name alone. */
export async function copyPath(kind: "whole" | "relative" | "name", path = activePath()) {
	if (!path) return notify("No file is open to copy the path of.");
	if (kind === "name") return copyText(baseName(path), `Copied ${baseName(path)}`);
	const root = state.workspace?.root;
	// The path from the folder is kept with forward slashes; where the folder's own are the other kind, so are these.
	const backward = Boolean(root && root.includes("\\") && !root.includes("/"));
	const text = kind === "relative" && root ? (backward ? relativeTo(root, path).replace(/\//g, "\\") : relativeTo(root, path)) : path;
	await copyText(text, `Copied ${text}`);
}

/** Follows the link the text cursor is in. Works in both CodeMirror 6 Live Preview and Monaco Source mode. */
function openLinkAtCursor() {
	const live = activeLiveEditor();
	if (live) {
		live.openLinkAtCursor();
		return;
	}
	const editor = activeEditor();
	if (editor?.getDomNode()?.offsetParent) void editor.getAction("editor.action.openLink")?.run();
}

/** Runs an Obsidian Markdown formatting action in whichever text engine (CodeMirror Live or Monaco Source) is active. */
function runMarkdownEdit(id: string) {
	const live = activeLiveEditor();
	if (live) {
		live.runAction(id);
		return;
	}
	const editor = activeEditor();
	if (editor?.getDomNode()?.offsetParent) runMonacoMarkdownAction(editor, id);
}

/** Obsidian Ctrl+E: toggles a Markdown document between Live Preview (or Source) and Read view in the active group. */
function toggleMarkdownMode() {
	const path = activePath();
	if (!path || !isMarkdown(path)) return;
	const g = state.activeGroup;
	const currentMode = markdownMode(path, g);
	const next = currentMode === "read" ? (state.settings.livePreview === false ? "source" : "live") : "read";
	if (currentMode === "source" && next !== "source") {
		const editor = activeEditor();
		if (editor?.getModel()) {
			const pos = editor.getPosition();
			const topLine = editor.getVisibleRanges()[0]?.startLineNumber ?? pos?.lineNumber ?? 1;
			saveMarkdownSyncAnchor(g, path, {
				line: pos?.lineNumber ?? 1,
				column: pos?.column ?? 1,
				topLine,
			});
		}
	}
	setMarkdownMode(path, next, g);
	if (next !== "read") queueMicrotask(focusEditor);
}

function foldMarkdownHeadings(fold: boolean) {
	const path = activePath();
	if (!path || !isMarkdown(path)) return notify("Open a Markdown document first.");
	const live = activeLiveEditor();
	if (live) {
		if (fold) live.foldAll?.();
		else live.unfoldAll?.();
		return;
	}
	const editor = activeEditor();
	if (editor?.getDomNode()?.offsetParent) {
		void editor.getAction(fold ? "editor.foldAll" : "editor.unfoldAll")?.run();
		return;
	}
	notify("Switch to Live or Source mode to fold Markdown headings.");
}

/** Splits the active Markdown document to the side group in Read view while keeping this group editable. */
async function splitMarkdownRead() {
	const path = activePath();
	if (!path || !isMarkdown(path)) return notify("Open a Markdown document first.");
	const other = state.activeGroup === 0 ? 1 : 0;
	await openToSide(path);
	setMarkdownMode(path, "read", other);
}

/** Opens the workspace's active working ticket in the side editor group beside SSL code. */
async function openActiveTicketToSide() {
	const key = state.settings.activeTicket?.trim() || ticketAtHand();
	if (!key) return notify("No active ticket is set. Use Ticket: Switch active working ticket… first.");
	const doc = docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === key.toLowerCase());
	if (!doc) return notify(`Ticket ${key} was not found.`, "error");
	await openToSide(doc.path);
}

/**
 * Switches a setting that is on or off. Where the project's own settings hold it, yours would not be seen while
 * the project's is in the way: it is switched there. Says whether it is now as asked.
 */
async function switchSetting(key: "wordWrap" | "menuBar" | "livePreview" | "markdownReadingHighlight", to: boolean, now: (settings: Settings) => boolean): Promise<boolean> {
	// Asked of what each save left, not of what is on screen: the screen may by then show a later save's settings,
	// and a save that was refused has left nothing to ask.
	let left = await saveSetting({ [key]: to });
	if (left && now(left) !== to && state.workspace) left = await saveSetting({ [key]: to }, "workspace");
	return Boolean(left) && now(left!) === to;
}

/** What this is, and what it found to work with: for a report of a fault, and to know which version is running. */
function about() {
	const tool = (name: string, status?: { ok: boolean; version?: string }) => `${name} ${status?.ok ? (status.version ?? "found") : "not found"}`;
	const text = [`SSL Studio ${state.info?.app ?? ""}`.trim(), tool("language server", state.info?.lsp), tool("opencode", state.info?.opencode)].join(" · ");
	notify(text, "info", { label: "Copy", run: () => void copyText(text, "Copied what this is.") });
}

/** The `uiScale` setting, one step up or down, or back to 1. */
const zoom = (by: 1 | -1 | 0) => void saveSetting({ uiScale: by ? stepScale(state.settings.uiScale, by) : UI_SCALE.normal });

export const commands: Command[] = [
	// Files and tabs
	{ id: "open-folder", label: "Open folder…", run: () => void openFolderCommand() },
	{ id: "quick-open", label: "Go to file…", run: () => setState("quickPick", "files") },
	{ id: "quick-outline", label: "Go to symbol in file…", detail: "Procedures, regions, headings, or sections in the active file", run: () => (activePath() ? setState("quickPick", "outline") : notify("Open a file first.")) },
	{ id: "symbols", label: "Go to symbol…", detail: "Anywhere in the workspace", run: () => setState("quickPick", "symbols") },
	{ id: "command-palette", label: "Show all commands", run: () => setState("quickPick", "commands") },
	{ id: "new-untitled", label: "New untitled file", detail: "A floating buffer that stays in memory until saved", run: () => void newUntitled() },
	{ id: "new-file", label: "New file or folder…", detail: "In the Explorer's folder, or beside the open file", run: () => void explorerNewFile() },
	{ id: "rename-file", label: "Rename…", detail: "The Explorer's file, or the open one", run: () => void explorerRename() },
	{ id: "trash-file", label: "Move to trash…", detail: "The Explorer's file, or the open one", run: () => void explorerDelete() },
	{ id: "save", label: "Save", run: () => void save() },
	{ id: "save-all", label: "Save all", run: () => void saveAll() },
	{ id: "revert", label: "Revert file", detail: "Back to what is on disk", run: () => activePath() && void revert(activePath()!) },
	{ id: "close", label: "Close tab", run: () => activePath() && void closeTab(activePath()!) },
	{ id: "close-others", label: "Close other tabs", detail: "The pinned ones stay", run: () => void closeOtherTabs() },
	{ id: "close-right", label: "Close tabs to the right", run: () => void closeTabsToRight() },
	{ id: "close-all", label: "Close all tabs", detail: "The pinned ones stay", run: () => void closeAllTabs() },
	{ id: "keep-tab", label: "Keep tab open", detail: "A tab opened for a look by one click, in italics: it stays when the next file is clicked", run: () => activePath() && keepTab(activePath()!, state.activeGroup) },
	{ id: "pin-tab", label: "Pin or unpin tab", detail: "A pinned tab stays first, and is not closed with the others", run: () => togglePin() },
	{ id: "reopen-tab", label: "Reopen closed tab", run: () => void reopenClosedTab() },
	{ id: "recent-tab", label: "Go to the tab used before", detail: "And with Ctrl held, on through the ones before that", run: () => stepRecent(1) },
	{ id: "recent-tab-back", label: "Go back through the tabs used", run: () => stepRecent(-1) },
	{ id: "go-back", label: "Go back", detail: "To where the cursor was before: another file, or far off in this one", run: () => void goAlong(-1) },
	{ id: "go-forward", label: "Go forward", detail: "Again to where “Go back” came from", run: () => void goAlong(1) },
	{ id: "next-tab", label: "Next tab", run: nextTab },
	{ id: "previous-tab", label: "Previous tab", run: previousTab },
	{ id: "move-tab-left", label: "Move tab left", detail: "One place along its row; the pinned stay first", run: () => shiftTab(-1) },
	{ id: "move-tab-right", label: "Move tab right", run: () => shiftTab(1) },
	{ id: "move-tab-across", label: "Move tab to the other group", detail: "Out of this group and into the one beside it, which is made if there is none", run: sendTabAcross },
	{ id: "split", label: "Split editor", run: split },
	{ id: "copy-path", label: "Copy path", detail: "The open file's whole path", run: () => void copyPath("whole") },
	{ id: "copy-relative-path", label: "Copy path in the project", detail: "The open file's path from the project's folder", run: () => void copyPath("relative") },
	{ id: "copy-file-name", label: "Copy file name", detail: "The open file's name, without its folder", run: () => void copyPath("name") },
	{ id: "word-wrap", label: "Toggle word wrap", detail: "Long lines wrapped at the editor's edge, or not", run: () => void switchSetting("wordWrap", !state.settings.wordWrap, (settings) => Boolean(settings.wordWrap)) },
	{ id: "live-preview", label: "Toggle Markdown live preview", detail: "A document drawn as it is written, or as its plain text", run: () => { const next = state.settings.livePreview === false; syncLivePreviewMode(next); void switchSetting("livePreview", next, (settings) => settings.livePreview !== false); } },
	{ id: "toggle-markdown-reading-highlight", label: "Toggle Markdown reading highlight", detail: "Subtly dim lines below the active cursor or mouse pointer in Markdown Live and Read views", run: () => void switchSetting("markdownReadingHighlight", state.settings.markdownReadingHighlight === false, (settings) => settings.markdownReadingHighlight !== false) },
	{ id: "toggle-markdown-mode", label: "Toggle Markdown Live / Read view", detail: "Switch a Markdown note between Live Preview editing and Reading view", run: toggleMarkdownMode },
	{ id: "split-markdown-read", label: "Markdown: Split Read preview to side", detail: "Keep editing in this group while previewing Read view side-by-side", run: () => void splitMarkdownRead() },
	{ id: "md-insert-footnote", label: "Markdown: Insert footnote", detail: "Insert the next numbered [^N] footnote reference and definition", run: () => runMarkdownEdit("md-insert-footnote") },
	{ id: "md-bold", label: "Markdown: Toggle bold", detail: "Wrap or unwrap selection with ** (Ctrl+B in Markdown)", run: () => runMarkdownEdit("md-bold") },
	{ id: "md-italic", label: "Markdown: Toggle italic", detail: "Wrap or unwrap selection with * (Ctrl+I in Markdown)", run: () => runMarkdownEdit("md-italic") },
	{ id: "md-strike", label: "Markdown: Toggle strikethrough", detail: "Wrap or unwrap selection with ~~ (Ctrl+Shift+X in Markdown)", run: () => runMarkdownEdit("md-strike") },
	{ id: "md-code", label: "Markdown: Toggle inline code", detail: "Wrap or unwrap selection with ` (Ctrl+` in Markdown)", run: () => runMarkdownEdit("md-code") },
	{ id: "md-highlight", label: "Markdown: Toggle highlight", detail: "Wrap or unwrap selection with == (Ctrl+Alt+H in Markdown)", run: () => runMarkdownEdit("md-highlight") },
	{ id: "md-link", label: "Markdown: Insert link", detail: "Insert [label](url) at selection (Ctrl+K in Markdown)", run: () => runMarkdownEdit("md-link") },
	{ id: "md-checkbox", label: "Markdown: Toggle checkbox", detail: "Cycle task checkbox on the current line(s) (Ctrl+L in Markdown)", run: () => runMarkdownEdit("md-checkbox") },
	{ id: "md-insert-template", label: "Markdown: Insert template…", detail: "Expand a workspace or built-in Templater template at the cursor", run: () => void insertMarkdownTemplate() },
	{ id: "md-new-from-template", label: "Markdown: New note from template…", detail: "Create a new note from a customizable Templater template", run: () => void newNoteFromTemplate() },
	{ id: "md-manage-templates", label: "Markdown: Customize or create template…", detail: "Copy a built-in template or create a custom one in docs/templates/", run: () => void manageTemplates() },
	{ id: "md-insert-callout", label: "Markdown: Insert callout…", detail: "Insert or wrap selection in > [!important], [!note], [!warning], …", run: () => void insertCalloutInteractive() },
	{ id: "md-insert-table", label: "Markdown: Insert table", detail: "Insert a formatted 3×2 table with Tab/Enter cell navigation", run: () => runMarkdownEdit("md-table-insert") },
	{ id: "md-format-table", label: "Markdown: Format table", detail: "Align pipes and pad columns on the table at the cursor", run: () => runMarkdownEdit("md-table-format") },
	{ id: "md-format-code-block", label: "Markdown: Format code block", detail: "Format the fenced code block at the cursor (SSL, SQL, JS/TS, XML/XFD, JSON, HTML, CSS, YAML)", run: () => void formatActiveCodeBlock() },
	{ id: "md-insert-image", label: "Markdown: Insert image…", detail: "Pick a workspace image or enter a URL (or paste/drop directly)", run: () => void insertImageInteractive() },
	{ id: "md-toc", label: "Markdown: Insert / update table of contents", detail: "Insert or refresh a <!-- toc --> section list from the document's headings", run: () => void upsertMarkdownToc() },
	{ id: "md-fold-all", label: "Markdown: Fold all headings", detail: "Collapse all foldable Markdown headings in the active editor", run: () => foldMarkdownHeadings(true) },
	{ id: "md-unfold-all", label: "Markdown: Unfold all headings", detail: "Expand all folded Markdown headings in the active editor", run: () => foldMarkdownHeadings(false) },
	{ id: "md-copy-heading-link", label: "Markdown: Copy link to current heading", detail: "Copy a [[doc#Heading]] wikilink for the heading at or above the cursor", run: () => void copyCurrentHeadingLink() },
	{ id: "rename-heading", label: "Markdown: Rename heading across workspace…", detail: "Rename a heading and rewrite #anchor / [[Doc#Heading]] links across the project", run: () => void renameHeadingAcrossWorkspace() },
	{ id: "open-link", label: "Open the link at the cursor", detail: "In a document's text: the file, heading or page its link leads to", run: openLinkAtCursor },
	{ id: "focus-editor", label: "Focus editor", run: focusEditor },
	{ id: "focus-side-panel", label: "Focus side panel", run: focusSidePanel },
	// The code
	{ id: "blocks", label: "Toggle blocks view", detail: "A plan shows its chart; Markdown shows rendered", run: toggleVisual },
	{ id: "change-language-mode", label: "Change Language Mode…", detail: "Select syntax highlighting and language mode for the active code editor", run: () => void pickLanguageMode() },
	{ id: "format", label: "Format document", detail: "SSL via language server; SQL, JS/TS, XML/XFD, HTML, CSS, JSON, YAML & Markdown", run: () => void formatActiveDocument() },
	{ id: "copy-designer", label: "Copy for Designer", detail: "Selection, procedure or file, formatted", run: () => void copyForDesigner() },
	{ id: "copy-code-citation", label: "Copy Markdown code citation", detail: "Copy a [file#L10-L25](path#L10-L25) link for the active file and selection", run: () => void copyCodeCitation(false) },
	{ id: "copy-code-citation-excerpt", label: "Copy Markdown code citation + excerpt", detail: "Copy a Markdown code citation followed by a fenced excerpt of the selected lines", run: () => void copyCodeCitation(true) },
	{ id: "find-in-docs", label: "Find references in Docs", detail: "Search for the selected text, word at cursor, or file stem across docs/", run: () => void findReferencesInDocs() },
	{ id: "wrap-region", label: "Wrap in region…", detail: "The selected lines", run: () => void wrapInRegion() },
	{ id: "insert-banner", label: "Insert file banner", run: () => insertTemplate(TEMPLATES.find((t) => t.id === "banner")!) },
	{ id: "insert-procedure", label: "Insert procedure", run: () => insertTemplate(TEMPLATES.find((t) => t.id === "procedure")!) },
	{ id: "editor-commands", label: "Show editor commands…", detail: "The text editor's own list", run: () => (activeLiveEditor() ? setState("quickPick", "commands") : activeEditor()?.trigger("app", "editor.action.quickCommand", null)) },
	// The project
	{ id: "setup-project", label: "Set up project", detail: "Settings, README, AGENTS", run: () => void setUpProject() },
	{ id: "undo-setup-project", label: "Undo set up project", detail: "Removes what it created and nobody has changed since", run: () => void undoSetUp() },
	{ id: "project-settings", label: "Open project settings", detail: "project.toml", run: () => void openProjectSettings() },
	{ id: "new-doc", label: "New document…", run: () => void newDoc() },
	{ id: "new-plan", label: "New plan…", run: () => void newPlanCommand() },
	{ id: "new-ticket", label: "New ticket…", detail: "The work as it was asked for", run: () => void newTicket() },
	{ id: "import-tickets", label: "Import tickets…", detail: "From a ticket system's export: a CSV table or its API's JSON", run: () => void importTickets() },
	{ id: "new-spec", label: "New spec…", detail: "What is to be built, for a ticket", run: () => void newSpec() },
	{ id: "new-decision", label: "New decision…", detail: "In the knowledge base; about the selected code, when there is some", run: () => void newKnowledge("decisions") },
	{ id: "new-question", label: "New question…", detail: "In the knowledge base; about the selected code, when there is some", run: () => void newKnowledge("questions") },
	{ id: "new-snippet", label: "New snippet…", detail: "SQL or SSL kept for use", run: () => void newKnowledge("snippets") },
	{ id: "new-prompt", label: "New prompt…", detail: "A question or an instruction for the agent, kept to be put to it again", run: () => void newKnowledge("prompts") },
	{ id: "new-reference", label: "New reference note…", detail: "How something works", run: () => void newKnowledge("reference") },
	{ id: "new-registry", label: "New registry…", detail: "Settings, files, database objects", run: () => void newRegistry() },
	{ id: "new-table", label: "New table…", detail: "A table the project reads or writes, described in the schema folder", run: () => void newSchema("database") },
	{ id: "new-message", label: "New interface message…", detail: "What is exchanged with an instrument or another system, described in the schema folder", run: () => void newSchema("interfaces") },
	{ id: "new-layout", label: "New file layout…", detail: "A file the project reads or writes, described in the schema folder", run: () => void newSchema("files") },
	{ id: "generate-schema-doc", label: "Generate table doc from SQL…", detail: "Turn CREATE TABLE DDL under schema/ into a Markdown column reference", run: () => void generateSchemaDocFromSql() },
	{ id: "generate-er-diagram", label: "Schema: Generate Mermaid ER Diagram…", detail: "Parse workspace SQL DDL into a Mermaid erDiagram block", run: () => void generateErDiagramCommand() },
	{ id: "open-schema-at-cursor", label: "Schema: Open schema doc for table at cursor…", detail: "Jump from a table or message name in SSL/SQL to its documented schema/ file", run: () => void import("./editor/schemaHover").then((m) => m.openSchemaAtCursor()) },
	{ id: "add-selection-to-registry", label: "Registry: Add selection to registry for active ticket…", detail: "Append the selected constant, setting, or table name to a CSV registry linked to the active ticket", run: () => void import("./editor/schemaHover").then((m) => m.addSelectionToRegistry()) },
	{ id: "switch-active-ticket", label: "Ticket: Switch active working ticket…", detail: "Set or clear the workspace active ticket coordinating Agent, Git, Search, Docs & Graph", run: () => void pickActiveTicket() },
	{ id: "open-active-ticket-side", label: "Ticket: Open active ticket to side", detail: "Pin the active working ticket beside your code in a split editor", run: () => void openActiveTicketToSide() },
	{ id: "open-governing-doc", label: "Docs: Open governing doc for active file…", detail: "Jump from the active code or SQL file to a governing plan, spec, ticket, decision, or schema doc", run: () => void openGoverningDocCommand() },
	{ id: "rename-tag", label: "Docs: Rename tag across workspace…", detail: "Rename a #tag across YAML frontmatter and Markdown prose", run: () => void renameTagCommand() },
	{ id: "promote-question", label: "Docs: Promote answered question to decision…", detail: "Turn an answered knowledge/questions note into a numbered ADR decision", run: () => void promoteQuestionCommand() },
	{ id: "link-doc-to-ticket", label: "Docs: Link current document to ticket…", detail: "Link the open document to a ticket, or link a document to the open ticket", run: () => void linkDocToTicketCommand() },
	{ id: "archive-ticket", label: "Docs: Archive active ticket…", detail: "Move the active ticket (and its folder, if any) into tickets/archive/", run: () => void archiveActiveTicketCommand() },
	{ id: "unarchive-ticket", label: "Docs: Unarchive ticket…", detail: "Restore an archived ticket from tickets/archive/ back into active tickets/", run: () => void unarchiveTicketCommand() },
	{ id: "set-doc-status", label: "Docs: Change status of active document…", detail: "Update the YAML frontmatter status of the open Markdown document", run: () => void setDocStatusCommand() },
	{ id: "create-ticket-folder", label: "Docs: Create / add file to ticket folder…", detail: "Promote a ticket into a bundle folder or add a companion file inside it", run: () => void createOrAddTicketFolderCommand() },
	{ id: "import-legacy-doc", label: "Docs: Import Word (.docx) or HTML Document…", detail: "Import a Word (.docx), HTML, or Markdown file into workspace Markdown with images", run: () => void importLegacyDoc() },
	{ id: "onboard-workspace", label: "Project: Onboard Existing Workspace…", detail: "Scan existing scripts, SQL DDL, and docs to seed project setup and registries", run: () => void onboardBrownfieldWorkspace() },
	{ id: "export-release-bundle", label: "Docs: Export Multi-Ticket Release Bundle…", detail: "Bundle multiple tickets by release, status, or key into a Release Bundle or Release Notes", run: () => void exportReleaseBundle() },
	{ id: "export-rtm", label: "Docs: Export Requirements Traceability Matrix (RTM)…", detail: "Export CSV, Markdown, HTML, or Word traceability matrix linking tickets, specs, plans, code & tests", run: () => void exportRtm() },
	{ id: "record-doc-approval", label: "Docs: Record Approval / Bump Version…", detail: "Record reviewer approval, bump semantic version, and stamp approval date on a governing doc", run: () => void runProjectDocAction("recordDocApproval") },
	{ id: "generate-test-protocol", label: "Docs: Generate Test Execution Protocol (IQ/OQ/PQ)…", detail: "Generate a structured validation test execution protocol from ticket specs and plan tests", run: () => void runProjectDocAction("generateTestExecutionProtocol") },
	{ id: "release-readiness", label: "Docs: Release Readiness Overview…", detail: "Review ticket completion, approvals, test runs, and deployment readiness across the project", run: () => void runProjectDocAction("openReleaseReadiness") },
	{ id: "clone-ticket", label: "Ticket: Clone Ticket…", detail: "Clone an existing ticket's template, checklist, and metadata under a new key", run: () => void runProjectDocAction("cloneTicket") },
	{ id: "split-ticket", label: "Ticket: Split Checklist into Sub-Ticket…", detail: "Extract checked or selected checklist items from a ticket into a linked child sub-ticket", run: () => void runProjectDocAction("splitTicketSubticket") },
	{ id: "import-mermaid-plan", label: "Plan: Import Mermaid Flowchart as Plan…", detail: "Convert a Mermaid flowchart from the active document or clipboard into a .plan.json chart", run: () => void importMermaidPlanCommand() },
	{ id: "git-blame-line", label: "Git: Show Line Commit & Ticket (Blame)", detail: "Show the commit, author, date, and ticket that last modified the current line", run: () => void gitBlameLineCommand() },
	{ id: "git-switch-branch", label: "Git: Switch Branch…", detail: "Switch to another local Git branch", run: () => void gitSwitchBranchCommand() },
	{ id: "git-stash", label: "Git: Stash Changes / Pop Stash…", detail: "Stash working tree changes, pop the latest stash, or inspect saved stashes", run: () => void gitStashCommand() },
	{ id: "project-state", label: "Project state…", detail: "Where the project stands, in plain words", run: () => void newState() },
	{ id: "update-catalogs", label: "Update catalogs", detail: "Write each INDEX.md's list afresh", run: () => void updateCatalogs() },
	{ id: "start-catalogs", label: "Start folder catalogs", detail: "An INDEX.md for the docs, code and tests folders, where one has none", run: () => void startFolderCatalogs() },
	{ id: "update-manifest", label: "Update file manifest", detail: "Sizes and checksums of the project's files", run: () => void updateManifest() },
	{ id: "copy-doc-html", label: "Copy document as HTML", detail: "Copy the open Markdown document as clean rich HTML", run: () => { const p = activePath(); if (!p || !isMarkdown(p)) return notify("Open a Markdown document first."); void exportDocAs(p, "html-copy"); } },
	{ id: "copy-doc-jira", label: "Copy document as Jira / Confluence markup", detail: "Convert the open Markdown document to Jira wiki syntax", run: () => { const p = activePath(); if (!p || !isMarkdown(p)) return notify("Open a Markdown document first."); void exportDocAs(p, "jira-copy"); } },
	{ id: "export-doc-html", label: "Export document as standalone HTML…", detail: "Download a print-ready HTML version of the open Markdown document", run: () => { const p = activePath(); if (!p || !isMarkdown(p)) return notify("Open a Markdown document first."); void exportDocAs(p, "html-download"); } },
	{ id: "export-docx", label: "Export as Word (.docx)…", detail: "Save the open Markdown document as a Word (.docx) file", run: () => { const p = activePath(); if (!p || !isMarkdown(p)) return notify("Open a Markdown document first."); void exportDocAs(p, "docx"); } },
	{ id: "print-doc", label: "Print / Save document as PDF…", detail: "Open a clean printable version of the active Markdown document", run: () => { const p = activePath(); if (!p || !isMarkdown(p)) return notify("Open a Markdown document first."); void exportDocAs(p, "print"); } },
	{ id: "export-ticket-packet", label: "Export ticket release packet…", detail: "Bundle the active ticket, specs, plans, decisions, questions, and registry rows", run: async () => {
		const key = ticketAtHand();
		if (!key) return notify("Open or activate a ticket first.");
		const ticketDoc = docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === key.toLowerCase());
		if (!ticketDoc) return notify(`Ticket ${key} was not found.`, "error");
		const fmt = await quickPick<"html" | "docx" | "markdown">({
			title: `Export release packet for ${key}`,
			placeholder: "Choose export format…",
			items: [
				{ label: "HTML (.html)", value: "html", detail: "Standalone printable webpage", icon: "file" },
				{ label: "Word (.docx)", value: "docx", detail: "Microsoft Word document", icon: "file" },
				{ label: "Markdown (.md)", value: "markdown", detail: "Combined Markdown packet", icon: "file" },
			],
		});
		if (!fmt) return;
		await exportTicketPacket(ticketDoc.path, key, fmt);
	} },
	{ id: "export-deployment-manifest", label: "Export deployment / transport manifest…", detail: "Aggregate scripts, SQL/DDL, local Git commits, registry rows, rollback checklist & DEV->PROD sign-off", run: async () => {
		const key = ticketAtHand();
		if (!key) return notify("Open or activate a ticket first.");
		const ticketDoc = docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === key.toLowerCase());
		if (!ticketDoc) return notify(`Ticket ${key} was not found.`, "error");
		const fmt = await quickPick<"markdown" | "docx" | "csv" | "html">({
			title: `Export deployment manifest for ${key}`,
			placeholder: "Choose export format…",
			items: [
				{ label: "Markdown (.md)", value: "markdown", detail: "Transport runbook & checklist", icon: "file" },
				{ label: "Word (.docx)", value: "docx", detail: "Microsoft Word sign-off packet", icon: "file" },
				{ label: "CSV (.csv)", value: "csv", detail: "Tabular object transport sheet", icon: "table" },
				{ label: "HTML (.html)", value: "html", detail: "Standalone printable manifest", icon: "file" },
			],
		});
		if (!fmt) return;
		await exportDeploymentManifest(ticketDoc.path, key, fmt);
	} },
	{ id: "closeout-ticket", label: "Ticket: Close out active ticket…", detail: "Review readiness, mark done, record milestone in STATE.md / README.md & check catalogs", run: () => {
		const key = ticketAtHand();
		if (!key) return notify("Open or activate a ticket first.");
		const ticketDoc = docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === key.toLowerCase());
		if (!ticketDoc) return notify(`Ticket ${key} was not found.`, "error");
		void closeoutTicket(ticketDoc.path, key);
	} },
	// Panels: one form, "Show" and the panel's name
	{ id: "explorer", label: "Show Explorer", run: () => showPanel("explorer") },
	{ id: "docs", label: "Show Docs", run: () => showPanel("docs") },
	{ id: "objects", label: "Show Document outline", detail: "Headings, regions and procedures of the open file", run: () => showPanel("objects") },
	{ id: "palette", label: "Show Palette", detail: "Templates, process shapes and graph controls", run: () => showPanel("palette") },
	{ id: "reference", label: "Show Reference", detail: "Built-in functions, classes and keywords", run: () => showPanel("reference") },
	{ id: "search", label: "Show Search", run: () => showPanel("search") },
	{ id: "replace-in-files", label: "Replace in files…", detail: "In Search: what would change is shown first, and nothing is written until it is confirmed", run: () => void import("./panels/Search").then((search) => search.showReplace()) },
	{ id: "git", label: "Show Source control", detail: "What has changed since the last commit, and the next commit", run: () => showPanel("git") },
	{ id: "history", label: "Show History", detail: "Local snapshots on save and Git commit history", run: () => showPanel("history") },
	{ id: "health", label: "Show Health", detail: "The script against the house style", run: () => showPanel("health") },
	{ id: "agent", label: "Show Agent", run: () => showPanel("agent") },
	{ id: "problems", label: "Show Problems", run: () => showBottom("problems") },
	{ id: "output", label: "Show Output", run: () => showBottom("output") },
	{ id: "graph", label: "Show Call graph", detail: "Again to go back to the editors", run: () => setState("centerView", state.centerView === "graph" ? "editors" : "graph") },
	{ id: "projects", label: "Show Projects", detail: "Switch to another recent folder, or go back to the editors", run: () => setState("centerView", state.centerView === "welcome" ? "editors" : "welcome") },
	{ id: "toggle-sidebar", label: "Toggle side bar", run: () => toggleSideOf("left") },
	{ id: "toggle-panel", label: "Toggle bottom panel", run: () => toggle("bottom") },
	{ id: "toggle-panel-maximize", label: "Toggle maximized panel", detail: "Expand the bottom panel to fill the center pane, or restore its size", run: toggleMaximizeBottom },
	{ id: "toggle-right-panel", label: "Toggle right panel", detail: "The panel docked on the right: the Agent, unless another was moved there", run: () => toggleSideOf("right") },
	{ id: "reset-layout", label: "Reset the layout", detail: "Every panel back on its own side and at its first size", run: resetLayout },
	{ id: "menu-bar", label: "Focus the menu bar", detail: "Then the arrow keys. Alt and a menu's first letter opens that menu", run: () => void (openMenu() || notify(MENU_HIDDEN)) },
	{ id: "toggle-menu-bar", label: "Toggle menu bar", detail: "File, Edit, Selection, View, Go and Help across the top of the window", run: () => void toggleMenuBar() },
	{ id: "move-panel", label: "Move left panel to the right", detail: "The one that is open", run: () => state.settings.layout.left && movePanel(state.leftView) },
	{ id: "move-panel-back", label: "Move right panel to the left", detail: "The one that is open", run: () => state.settings.layout.right && movePanel(state.rightView) },
	// The agent
	{ id: "agent-ask", label: "Ask the agent…", detail: "About the selection", run: () => void askCommand() },
	{ id: "attach-file-to-agent", label: "Agent: Attach active file to Agent", detail: "Attach the open workspace file to the next Agent turn context", run: () => { const p = activePath(); if (!p) return notify("Open a file first."); attachFileToAgent(p); } },
	{ id: "show-in-explorer", label: "Explorer: Reveal active file in Explorer", detail: "Highlight and scroll to the open file in the Explorer tree", run: () => { const p = activePath(); if (!p) return notify("Open a file first."); showInExplorer(p); } },
	{ id: "tidy", label: "Tidy file with the agent", run: () => (startTidy(), showPanel("agent")) },
	// The IDE
	{ id: "style-profile", label: "Edit style profile…", detail: "How the language server formats and checks", run: () => openStyleProfile() },
	{ id: "lsp-restart", label: "Restart language server", run: () => void backend.lspRestart() },
	{ id: "zoom-in", label: "Zoom in", detail: "A larger interface", run: () => zoom(1) },
	{ id: "zoom-out", label: "Zoom out", detail: "A smaller interface", run: () => zoom(-1) },
	{ id: "zoom-reset", label: "Reset zoom", run: () => zoom(0) },
	{ id: "settings", label: "Open settings…", run: () => openSettings() },
	{ id: "keyboard-shortcuts", label: "Show keyboard shortcuts…", detail: "Every command's keys, to look up and to change", run: () => openSettings("keyboard") },
	{ id: "about", label: "About SSL Studio", detail: "Its version, and the language server's and the agent's", run: about },
];

/** The commands run from the command list this session, newest first (ten are kept). */
let recent: string[] = [];
export const recentCommands = () => recent;

/** Formats the single fenced code block enclosing the cursor in a Markdown document (Live or Source). */
async function formatActiveCodeBlock() {
	const path = activePath();
	const doc = activeDoc();
	if (!path || !doc || doc.binary || doc.model.getLanguageId() !== "markdown") {
		return notify("Place the cursor inside a fenced code block in a Markdown document.");
	}
	const live = activeLiveEditor();
	const line = live ? live.getPosition().lineNumber : (activeEditor()?.getPosition()?.lineNumber ?? 1);
	const outcome = await formatFenceInModel(doc.model, line);
	if (outcome === "none") notify("Place the cursor inside a fenced code block to format it.");
	else if (outcome === "unchanged") notify("Code block is already formatted.");
}

/** Formats the active document via starlims-lsp (for SSL) or the non-SSL Prettier/SQL formatter. */
async function formatActiveDocument() {
	const path = activePath();
	const doc = activeDoc();
	if (!path || !doc || doc.binary) return notify("Open a text file to format.");
	if (isPlanPath(path)) return notify("Plan files keep their own layout.");
	const languageId = doc.model.getLanguageId();
	if (languageId === "ssl") {
		if (state.lsp.state !== "running") {
			return notify("The language server is not running; restart it to format SSL files.", "error");
		}
		const editor = activeEditor();
		if (!editor) return;
		await editor.getAction("editor.action.formatDocument")?.run();
		return;
	}
	if (!canFormatNonSsl(languageId, path)) {
		return notify(`No formatter is configured for ${languageName(languageId)} files.`);
	}
	if (activeLiveEditor()) {
		const outcome = await formatNonSslModel(doc.model);
		if (outcome === "unchanged") notify(`${displayName(path)} is already formatted.`);
		return;
	}
	const editor = activeEditor();
	if (!editor) return;
	const before = doc.model.getAlternativeVersionId();
	await editor.getAction("editor.action.formatDocument")?.run();
	if (doc.model.getAlternativeVersionId() === before && !hadRecentFormatError(doc.model)) {
		notify(`${displayName(path)} is already formatted.`);
	}
}

/** Runs a command by id. `remember` puts it among the recently used, for the command list. */
export function runCommand(id: string, options: { remember?: boolean } = {}) {
	const command = commands.find((c) => c.id === id);
	if (!command) return;
	if (options.remember) recent = noteUsed(recent, id);
	command.run();
}

let settingsOpener: (query?: string) => void = () => {};
export const onOpenSettings = (open: (query?: string) => void) => (settingsOpener = open);
/** Opens Settings; with `query`, showing only what matches it ("keyboard" for the shortcuts). */
export const openSettings = (query?: string) => settingsOpener(query);

const MENU_HIDDEN = "The menu bar is hidden. “Toggle menu bar” in the command list brings it back.";
let menuOpener: ((index?: number) => void) | null = null;
/** The menu bar says how it is given the keyboard; null when it is taken off the window. */
export const onOpenMenu = (open: ((index?: number) => void) | null) => (menuOpener = open);
/** Gives the menu bar the keyboard, or opens one of its menus. False when the bar is hidden. */
export function openMenu(index?: number): boolean {
	menuOpener?.(index);
	return menuOpener !== null;
}

async function toggleMenuBar() {
	const hide = state.settings.menuBar !== false;
	const done = await switchSetting("menuBar", !hide, (settings) => settings.menuBar !== false);
	// What was hidden says how it is brought back: the menu that hid it is gone with it.
	if (hide && done) notify(MENU_HIDDEN);
	// And so is whatever in the bar had the keyboard: it goes to the editor.
	if (hide && done && (!document.activeElement || document.activeElement === document.body)) focusEditor();
}

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

/** Blocks for a script; for a plan toggles Chart/Text, for Markdown toggles Live/Read, for a table toggles Table/Text. */
function toggleVisual() {
	const path = activePath();
	const g = state.activeGroup;
	if (isPlanPath(path)) setPlanMode(path!, planMode(path!, g) === "chart" ? "text" : "chart", g);
	else if (isMarkdown(path)) toggleMarkdownMode();
	else if (isTable(path)) setTableTextMode(path!, !tableTextMode(path!, g), g);
	else setState("groups", g, "mode", (m) => (m === "blocks" ? "text" : "blocks"));
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
		// A plan started from a ticket, or from a document that is for one, is for that ticket.
		const ticket = ticketAtHand();
		await backend.write(path, printPlan(ticket ? { ...newPlan(name), ticket } : newPlan(name)));
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

async function upsertMarkdownToc() {
	const path = activePath();
	const doc = activeDoc();
	if (!path || !doc || !isMarkdown(path)) return notify("Open a Markdown document first.");
	const { upsertTocBlock } = await import("../shared/markdownEdit");
	const before = doc.model.getValue();
	const { text, updated } = upsertTocBlock(before);
	if (!updated) return notify("No H2–H4 headings found (or table of contents is already up to date).");
	const { applyText } = await import("./state");
	applyText(path, text);
	notify("Updated table of contents.");
}

async function copyCurrentHeadingLink() {
	const path = activePath();
	const doc = activeDoc();
	if (!path || !doc || !isMarkdown(path)) return notify("Open a Markdown document first.");
	const { documentHeadings } = await import("../shared/markdownEdit");
	const headings = documentHeadings(doc.model.getValue());
	if (!headings.length) return notify("This document has no headings.");
	const line = activeLiveEditor()?.getPosition().lineNumber ?? activeEditor()?.getPosition()?.lineNumber ?? state.cursor.line;
	const hit = [...headings].reverse().find((h) => h.line <= line) ?? headings[0]!;
	const stem = path.replace(/^.*[\\/]/, "").replace(/\.(md|markdown)$/i, "");
	await copyText(`[[${stem}#${hit.text}]]`, `Copied [[${stem}#${hit.text}]].`);
}

/** Searches the project's docs folder for the selected text, symbol at cursor, or current file stem. */
async function findReferencesInDocs() {
	const path = activePath();
	let query = "";
	const live = activeLiveEditor();
	if (live) {
		const selected = live.getSelectedText().trim();
		if (selected) {
			query = selected;
		} else {
			const model = activeDoc()?.model;
			if (model) query = model.getWordAtPosition(live.getPosition())?.word ?? "";
		}
	} else {
		const editor = activeEditor();
		const model = editor?.getModel();
		const sel = editor?.getSelection();
		if (model && sel && !sel.isEmpty()) {
			query = model.getValueInRange(sel).trim();
		} else if (model && editor?.getPosition()) {
			query = model.getWordAtPosition(editor.getPosition()!)?.word ?? "";
		}
	}
	if (!query && path) {
		query = baseName(path).replace(/\.[^.]+$/, "");
	}
	if (!query) return notify("Open a file or select a symbol to search in Docs.");
	const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "").replace(/\\/g, "/");
	const include = docsRel && docsRel !== "." ? `${docsRel}/**` : "**/*.md";
	const { searchFor } = await import("./panels/Search");
	searchFor(query, { include });
}

/** Copies a Markdown code citation `[file#L10-L25](path#L10-L25)` (and optional fenced code excerpt) relative to the last active Markdown doc or workspace root. */
async function copyCodeCitation(withExcerpt: boolean) {
	const path = activePath();
	const doc = activeDoc();
	if (!path || !doc || doc.binary) return notify("Open a text file first to copy a Markdown code citation.");
	let fromLine = 1;
	let toLine = 1;
	const live = activeLiveEditor();
	if (live) {
		const sel = live.getSelection();
		if (!sel.isEmpty()) {
			fromLine = sel.startLineNumber;
			toLine = sel.endColumn === 1 && sel.endLineNumber > fromLine ? sel.endLineNumber - 1 : sel.endLineNumber;
		} else {
			fromLine = live.getPosition().lineNumber;
			toLine = fromLine;
		}
	} else {
		const editor = activeEditor();
		const sel = editor?.getSelection();
		if (sel && !sel.isEmpty()) {
			fromLine = sel.startLineNumber;
			toLine = sel.endColumn === 1 && sel.endLineNumber > fromLine ? sel.endLineNumber - 1 : sel.endLineNumber;
		} else {
			fromLine = editor?.getPosition()?.lineNumber ?? state.cursor.line ?? 1;
			toLine = fromLine;
		}
	}

	const wsRoot = state.workspace?.root;
	const otherMd = state.groups.find((g, idx) => idx !== state.activeGroup && g.active && isMarkdown(g.active))?.active ?? null;
	const mdBase = otherMd ?? (lastActiveMarkdownPath() && lastActiveMarkdownPath() !== path ? lastActiveMarkdownPath() : null);
	let relHref: string;
	if (mdBase) {
		relHref = relativePath(dirName(mdBase), path).split("\\").join("/");
	} else if (wsRoot) {
		relHref = `/${relativeTo(wsRoot, path).split("\\").join("/")}`;
	} else {
		relHref = baseName(path);
	}
	const lineRef = fromLine === toLine ? `#L${fromLine}` : `#L${fromLine}-L${toLine}`;
	const label = `${wsRoot ? relativeTo(wsRoot, path).split("\\").join("/") : baseName(path)}${lineRef}`;
	const citation = `[${label}](${linkWritten(relHref)}${lineRef})`;

	if (!withExcerpt) {
		await copyText(citation, `Copied citation ${label}.`);
		return;
	}
	const model = doc.model;
	const clampedFrom = Math.max(1, Math.min(fromLine, model.getLineCount()));
	const clampedTo = Math.max(clampedFrom, Math.min(toLine, model.getLineCount()));
	const excerpt = model.getValueInRange({
		startLineNumber: clampedFrom,
		startColumn: 1,
		endLineNumber: clampedTo,
		endColumn: model.getLineMaxColumn(clampedTo),
	});
	const lang = model.getLanguageId();
	const fenceLang = lang === "plaintext" ? "" : lang;
	let maxTicks = 2;
	for (const m of excerpt.matchAll(/`+/g)) {
		if (m[0].length > maxTicks) maxTicks = m[0].length;
	}
	const fence = "`".repeat(maxTicks + 1);
	await copyText(`${citation}\n\n${fence}${fenceLang}\n${excerpt}\n${fence}\n`, `Copied citation and excerpt for ${label}.`);
}

async function askCommand() {
	const question = await ask("Ask the agent about the selection");
	if (!question) return;
	showPanel("agent");
	const { currentAgentContext } = await import("./agent/Agent");
	const ctx = currentAgentContext();
	await askAbout(question, true, ctx.includeWork, { ticket: ctx.ticket, workOptions: ctx.workOptions });
}

async function openFolderCommand() {
	if (inApp) return openFolder();
	// A browser tab has no folder dialog: ask for a path instead.
	const path = await ask("Folder to open (absolute path)", state.workspace?.root ?? "");
	if (path) await openFolder(path);
}

async function generateErDiagramCommand() {
	const wsRoot = state.workspace?.root;
	if (!wsRoot) return notify("Open a folder first.");
	const active = activePath();
	const activeIsSql = Boolean(active && /\.(sql|ddl)$/i.test(active));
	const schemaSqlPaths = docs()
		.filter((d) => d.exists && d.group === "schema" && /\.(sql|ddl)$/i.test(d.name))
		.map((d) => d.path);
	const allWorkspaceSql = schemaSqlPaths.length
		? schemaSqlPaths
		: (await backend.files().catch(() => [])).filter((p) => /\.(sql|ddl)$/i.test(p));

	let sourcePaths: string[] = [];
	if (activeIsSql && active) {
		const others = allWorkspaceSql.filter((p) => canonical(p) !== canonical(active));
		if (others.length) {
			const ACTIVE_ONLY = `Active file only (${baseName(active)})`;
			const ALL_SQL = `All workspace SQL files (${others.length + 1})`;
			const scope = await choose("Generate Mermaid ER diagram from:", [ACTIVE_ONLY, ALL_SQL]);
			if (!scope) return;
			sourcePaths = scope === ACTIVE_ONLY ? [active] : [active, ...others];
		} else {
			sourcePaths = [active];
		}
	} else {
		sourcePaths = allWorkspaceSql;
	}
	if (!sourcePaths.length) return notify("No .sql or .ddl files were found in this workspace.");

	// Sort deterministically (`numeric: true`) and concatenate all DDL before parsing so
	// `ALTER TABLE` / `ADD CONSTRAINT ... FOREIGN KEY` migrations in `02_alters.sql` / `03_fks.sql` apply cleanly.
	const orderedPaths = [...new Map(sourcePaths.map((p) => [canonical(p), p])).values()].sort((a, b) =>
		relativeTo(wsRoot, a).localeCompare(relativeTo(wsRoot, b), undefined, { numeric: true, sensitivity: "base" }),
	);
	const sqlChunks: string[] = [];
	for (const p of orderedPaths) {
		const open = documents.get(canonical(p));
		const text = open ? open.model.getValue() : await backend.read(p).then((r) => (r.binary ? "" : r.text), () => "");
		if (text.trim()) sqlChunks.push(text.trimEnd());
	}
	if (!sqlChunks.length) return notify("No readable SQL content was found in the selected files.");

	const parsedTables = parseCreateTables(sqlChunks.join("\n;\n"), { includeStandaloneAlter: true });
	// Deduplicate by table name while keeping the most complete/latest definition if a table was re-created across files.
	const mergedByName = new Map<string, SqlTableDef>();
	for (const tbl of parsedTables) {
		const key = tbl.tableName.toLowerCase();
		const prev = mergedByName.get(key);
		if (!prev) {
			mergedByName.set(key, tbl);
		} else {
			const cols = [...prev.columns];
			for (const col of tbl.columns) {
				const idx = cols.findIndex((c) => c.name.toLowerCase() === col.name.toLowerCase());
				if (idx >= 0) cols[idx] = col;
				else cols.push(col);
			}
			const fks = [...(prev.foreignKeys ?? [])];
			for (const fk of tbl.foreignKeys ?? []) {
				const dup = fks.some(
					(e) =>
						e.column.toLowerCase() === fk.column.toLowerCase() &&
						e.refTable.toLowerCase() === fk.refTable.toLowerCase() &&
						(e.refColumn ?? "").toLowerCase() === (fk.refColumn ?? "").toLowerCase(),
				);
				if (!dup) fks.push(fk);
			}
			mergedByName.set(key, { tableName: tbl.tableName, columns: cols, ...(fks.length ? { foreignKeys: fks } : {}) });
		}
	}
	const tables = [...mergedByName.values()];
	if (!tables.length) return notify("No CREATE TABLE definitions were found in the SQL files.");

	const diagram = generateMermaidErDiagram(tables);
	const canInsert = Boolean(active && isMarkdown(active) && (activeLiveEditor() || activeEditor()?.getDomNode()?.offsetParent));
	const picked = await quickPick<"copy" | "insert" | "save">({
		title: `Mermaid ER diagram (${tables.length} ${tables.length === 1 ? "table" : "tables"})`,
		placeholder: "Choose what to do with the generated diagram…",
		items: [
			{ label: "Copy to clipboard", value: "copy", detail: "Copy fenced ```mermaid erDiagram block", icon: "copy" },
			...(canInsert
				? [{ label: "Insert at cursor", value: "insert" as const, detail: `Insert into ${displayName(active!)}`, icon: "edit" as const }]
				: []),
			{
				label: "Save to schema/database/ER-Diagram.md",
				value: "save",
				detail: "Updates existing erDiagram fence without overwriting hand-written notes",
				icon: "database",
			},
		],
	});
	if (!picked) return;
	if (picked === "copy") {
		await copyText(diagram, `Copied Mermaid ER diagram (${tables.length} ${tables.length === 1 ? "table" : "tables"}).`);
		return;
	}
	if (picked === "insert") {
		const live = activeLiveEditor();
		if (live) {
			live.insertText(`${diagram}\n`, undefined, { asBlock: true });
			notify("Inserted Mermaid ER diagram.");
			return;
		}
		const editor = activeEditor();
		const model = editor?.getModel();
		const sel = editor?.getSelection();
		if (editor && model && sel) {
			model.pushStackElement();
			model.pushEditOperations([], [{ range: sel, text: `${diagram}\n` }], () => null);
			model.pushStackElement();
			editor.focus();
			notify("Inserted Mermaid ER diagram.");
		}
		return;
	}

	const schemaParts = folderParts(state.project?.schema ?? "schema");
	const dest = joinPath(wsRoot, ...schemaParts, "database", "ER-Diagram.md");
	const destKey = canonical(dest);
	const openDest = documents.get(destKey);
	const existing = openDest
		? openDest.model.getValue()
		: await backend.read(dest).then((r) => (r.binary ? null : r.text), () => null);

	let nextText = `# Database ER Diagram\n\n${diagram}\n`;
	let modeNote = "Saved Mermaid ER diagram to";
	if (existing !== null) {
		const merged = replaceErDiagramBlock(existing, diagram);
		if (merged.replaced) {
			nextText = merged.text;
			modeNote = "Updated Mermaid ER diagram in";
		} else {
			const APPEND = "Append ER diagram";
			const REPLACE = "Replace entire file";
			const answer = await choose(
				`${relativeTo(wsRoot, dest)} already exists without a Mermaid erDiagram block. How should it be updated?`,
				[APPEND, REPLACE],
				{ danger: REPLACE },
			);
			if (!answer) return;
			if (answer === APPEND) {
				const eol = existing.includes("\r\n") ? "\r\n" : "\n";
				const normDiagram = diagram.replace(/\r?\n/g, eol);
				const sep = existing.endsWith("\n") ? eol : `${eol}${eol}`;
				nextText = `${existing}${sep}${normDiagram}${eol}`;
				modeNote = "Appended Mermaid ER diagram to";
			} else {
				modeNote = "Replaced Mermaid ER diagram in";
			}
		}
	}

	if (openDest) {
		const wasClean = !state.dirty[destKey];
		applyText(destKey, nextText);
		if (wasClean) await save(destKey, { format: false });
	} else {
		if (existing !== null) await backend.historyKeep(dest).catch(() => {});
		await backend.write(dest, nextText);
	}
	setState("treeVersion", (v) => v + 1);
	await openFile(dest);
	notify(`${modeNote} ${relativeTo(wsRoot, dest)}.`);
}

async function renameTagCommand() {
	if (!state.workspace) return notify("Open a folder first.");
	const buckets = workspaceTags(docs());
	if (!buckets.length) {
		const typed = (await ask("Tag to rename across workspace (without #)"))?.trim();
		if (typed) await renameTagAcrossWorkspace(typed);
		return;
	}
	const picked = await quickPick<string>({
		title: "Rename tag across workspace",
		placeholder: "Filter tags…",
		items: buckets.map((b) => ({
			label: `#${b.tag}`,
			value: b.tag,
			detail: `${b.count} ${b.count === 1 ? "doc" : "docs"}`,
			icon: "tag",
		})),
	});
	if (picked) await renameTagAcrossWorkspace(picked);
}

async function promoteQuestionCommand() {
	if (!state.workspace) return notify("Open a folder first.");
	const p = activePath();
	const allDocs = docs();
	const activeListed = p ? allDocs.find((d) => d.exists && canonical(d.path) === canonical(p)) : undefined;
	if (activeListed?.group === "knowledge" && activeListed.kind === "questions") {
		await promoteQuestionToDecision(activeListed.path);
		return;
	}
	const questions = allDocs
		.filter((d) => d.exists && !isCatalog(d) && d.group === "knowledge" && d.kind === "questions")
		.sort((a, b) => Number(toneOf(b.status) === "done") - Number(toneOf(a.status) === "done") || a.name.localeCompare(b.name));
	if (!questions.length) return notify("No question documents exist in this project yet.");
	const chosen = await quickPick<DocFile>({
		title: "Promote question to decision (ADR)",
		placeholder: "Filter questions…",
		items: questions.map((q) => ({
			label: q.title || q.name,
			value: q,
			detail: relativeTo(state.workspace?.root, q.path),
			badge: q.status ? { text: q.status, tone: toneOf(q.status) } : undefined,
			icon: "question",
		})),
	});
	if (chosen) await promoteQuestionToDecision(chosen.path);
}

async function linkDocToTicketCommand() {
	const p = activePath();
	if (!p) return notify("Open a document first.");
	const listed = docs().find((d) => d.exists && canonical(d.path) === canonical(p));
	if (listed?.group === "tickets" && listed.ticket) {
		await linkDocumentToTicket(listed.path, listed.ticket);
		return;
	}
	if (isMarkdown(p)) {
		await linkNonTicketToTicket(p);
		return;
	}
	notify("Open a Markdown document or ticket to link it.");
}

async function archiveActiveTicketCommand() {
	if (!state.workspace) return notify("Open a folder first.");
	const allDocs = docs();
	const p = activePath();
	const openTicket = p
		? allDocs.find((d) => d.exists && d.group === "tickets" && !isCatalog(d) && canonical(d.path) === canonical(p) && !isArchivedTicket(d))
		: undefined;
	if (openTicket) {
		await archiveTicket(openTicket);
		return;
	}
	const key = ticketAtHand();
	const activeTicket = key
		? allDocs.find((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket?.toLowerCase() === key.toLowerCase() && !isArchivedTicket(d))
		: undefined;
	if (activeTicket) {
		await archiveTicket(activeTicket);
		return;
	}
	const candidates = allDocs.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket && !isArchivedTicket(d));
	if (!candidates.length) return notify("No active tickets found to archive.");
	const chosen = await quickPick<DocFile>({
		title: "Archive ticket",
		placeholder: "Filter active tickets…",
		items: candidates.map((t) => ({
			label: `${t.ticket}: ${t.title || t.name}`,
			value: t,
			detail: t.name,
			badge: t.status ? { text: t.status, tone: toneOf(t.status) } : undefined,
			icon: "checklist",
		})),
	});
	if (chosen) await archiveTicket(chosen);
}

async function unarchiveTicketCommand() {
	if (!state.workspace) return notify("Open a folder first.");
	const allDocs = docs();
	const p = activePath();
	const openArchived = p
		? allDocs.find((d) => d.exists && d.group === "tickets" && !isCatalog(d) && canonical(d.path) === canonical(p) && isArchivedTicket(d))
		: undefined;
	if (openArchived) {
		await unarchiveTicket(openArchived);
		return;
	}
	const archived = allDocs.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && isArchivedTicket(d));
	if (!archived.length) return notify("No archived tickets were found in tickets/archive/.");
	const chosen = await quickPick<DocFile>({
		title: "Unarchive ticket",
		placeholder: "Filter archived tickets…",
		items: archived.map((t) => ({
			label: `${t.ticket || t.name}${t.title ? `: ${t.title}` : ""}`,
			value: t,
			detail: relativeTo(state.workspace?.root, t.path),
			badge: t.status ? { text: t.status, tone: toneOf(t.status) } : undefined,
			icon: "checklist",
		})),
	});
	if (chosen) await unarchiveTicket(chosen);
}

async function setDocStatusCommand() {
	const p = activePath();
	if (!p || !isMarkdown(p)) return notify("Open a Markdown document first.");
	const listed = docs().find((d) => d.exists && canonical(d.path) === canonical(p));
	const choices = statusChoices(listed);
	const CUSTOM = "__custom__";
	const picked = await quickPick<string>({
		title: `Change status for ${listed?.title || displayName(p)}`,
		placeholder: "Select or search status…",
		items: [
			...choices.map((s) => ({
				label: s,
				value: s,
				checked: Boolean(listed?.status && listed.status.toLowerCase() === s.toLowerCase()),
				badge: { text: s, tone: toneOf(s) },
			})),
			{ label: "Custom status…", value: CUSTOM, icon: "edit", divide: true },
		],
	});
	if (!picked) return;
	const nextStatus = picked === CUSTOM ? (await ask("New status"))?.trim() : picked;
	if (!nextStatus) return;
	await setStatus(p, nextStatus);
}

async function createOrAddTicketFolderCommand() {
	if (!state.workspace) return notify("Open a folder first.");
	const allDocs = docs();
	const p = activePath();
	let target = p
		? allDocs.find((d) => d.exists && d.group === "tickets" && !isCatalog(d) && canonical(d.path) === canonical(p))
		: undefined;
	if (!target) {
		const key = ticketAtHand();
		if (key) {
			target = allDocs.find((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket?.toLowerCase() === key.toLowerCase());
		}
	}
	if (!target) {
		const tickets = allDocs.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket && !isArchivedTicket(d));
		if (!tickets.length) return notify("No tickets exist in this project yet.");
		target =
			(await quickPick<DocFile>({
				title: "Ticket folder: choose ticket",
				placeholder: "Filter active tickets…",
				items: tickets.map((t) => ({
					label: `${t.ticket}: ${t.title || t.name}`,
					value: t,
					detail: t.ticketFolder ? "Add file to folder" : "Create folder",
					badge: t.status ? { text: t.status, tone: toneOf(t.status) } : undefined,
					icon: "folder",
				})),
			})) ?? undefined;
	}
	if (!target) return;
	if (target.ticketFolder) {
		await newTicketFile(target.ticketFolder, target.ticket || baseName(target.path));
		return;
	}
	const made = await createTicketFolder(target.path);
	if (made) {
		const ADD_FILE = "Add companion file now…";
		const answer = await choose(`Created ticket folder for ${target.ticket || baseName(target.path)}.`, [ADD_FILE, "Done"]);
		if (answer === ADD_FILE) await newTicketFile(made, target.ticket || baseName(target.path));
	}
}

async function openGoverningDocCommand() {
	const p = activePath();
	if (!p) return notify("Open a file first.");
	const incoming = await backend.linksTo(p).catch(() => []);
	const gov = docsGoverningFile(docs(), p, state.workspace?.root, incoming);
	if (!gov.length) return notify("No governing documents are linked to this file yet.");
	if (gov.length === 1) {
		const only = gov[0]!;
		await openFile(only.file.path, only.line ? { reveal: { line: only.line } } : {});
		return;
	}
	const chosen = await quickPick<(typeof gov)[number]>({
		title: `Governing documents for ${displayName(p)}`,
		placeholder: "Filter governing docs…",
		items: gov.map((entry) => {
			const d = entry.file;
			const title =
				d.group === "registries"
					? registryTitle(d.name)
					: d.ticket && d.title && !d.title.startsWith(d.ticket)
						? `${d.ticket}: ${d.title}`
						: d.title || d.heading || d.name;
			const kind = d.group === "knowledge" && d.kind ? d.kind : d.group;
			return {
				label: title,
				value: entry,
				detail: `${kind} · ${entry.reason}`,
				badge: d.status ? { text: d.status, tone: toneOf(d.status) } : undefined,
				file: d.name,
			};
		}),
	});
	if (chosen) await openFile(chosen.file.path, chosen.line ? { reveal: { line: chosen.line } } : {});
}

type R6ProjectDocsApi = {
	recordDocApproval?: (targetPath?: string) => Promise<unknown>;
	generateTestExecutionProtocol?: (ticketPath?: string) => Promise<unknown>;
	openReleaseReadiness?: () => Promise<unknown>;
	cloneTicket?: (targetPath?: string) => Promise<unknown>;
	splitTicketSubticket?: (targetPath?: string) => Promise<unknown>;
};

async function runProjectDocAction(name: keyof R6ProjectDocsApi) {
	const mod = (await import("./projectDocs")) as unknown as R6ProjectDocsApi;
	const fn = mod[name];
	if (typeof fn !== "function") {
		notify(`Action "${name}" is not available in this build.`, "error");
		return;
	}
	await fn();
}

/** Extracts fenced Mermaid flowchart blocks from Markdown text with 1-based start/end lines. */
function findMermaidBlocks(markdown: string): { code: string; startLine: number; endLine: number }[] {
	const lines = markdown.split(/\r?\n/);
	const out: { code: string; startLine: number; endLine: number }[] = [];
	let i = 0;
	while (i < lines.length) {
		const open = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(lines[i]!);
		if (!open) {
			i++;
			continue;
		}
		const ch = open[1]![0]!;
		const len = open[1]!.length;
		const info = open[2]!.trim();
		if (ch === "`" && info.includes("`")) {
			i++;
			continue;
		}
		const lang = (info.split(/\s+/)[0] ?? "").toLowerCase();
		const closeRe = new RegExp(`^[ \\t]{0,3}${ch}{${len},}[ \\t]*$`);
		let closeIdx = -1;
		for (let j = i + 1; j < lines.length; j++) {
			if (closeRe.test(lines[j]!)) {
				closeIdx = j;
				break;
			}
		}
		if (closeIdx < 0) break;
		if (lang === "mermaid" || lang === "mmd") {
			const code = lines.slice(i + 1, closeIdx).join("\n").trim();
			if (code) out.push({ code, startLine: i + 1, endLine: closeIdx + 1 });
		}
		i = closeIdx + 1;
	}
	return out;
}

async function importMermaidPlanCommand() {
	const wsRoot = state.workspace?.root;
	if (!wsRoot) return notify("Open a folder first.");

	let mermaidSource = "";
	const p = activePath();
	const doc = activeDoc();
	const cursorLine = activeLiveEditor()?.getPosition().lineNumber ?? activeEditor()?.getPosition()?.lineNumber ?? state.cursor.line ?? 1;

	if (p && doc && !doc.binary) {
		const raw = doc.model.getValue();
		if (isMarkdown(p)) {
			const blocks = findMermaidBlocks(raw);
			const atCursor = blocks.find((b) => cursorLine >= b.startLine && cursorLine <= b.endLine);
			if (atCursor) {
				mermaidSource = atCursor.code;
			} else if (blocks.length === 1) {
				mermaidSource = blocks[0]!.code;
			} else if (blocks.length > 1) {
				const PASTE = "__paste__";
				const picked = await quickPick<string>({
					title: `Import Mermaid flowchart from ${displayName(p)}`,
					placeholder: "Choose a Mermaid block…",
					items: [
						...blocks.map((b, idx) => ({
							label: `Diagram ${idx + 1} (lines ${b.startLine}–${b.endLine})`,
							value: b.code,
							detail: (b.code.split("\n")[0] ?? "").trim().slice(0, 48),
							icon: "graph" as const,
						})),
						{ label: "Paste Mermaid flowchart source…", value: PASTE, icon: "edit", divide: true },
					],
				});
				if (!picked) return;
				if (picked !== PASTE) mermaidSource = picked;
			}
		} else if (/\.(mmd|mermaid)$/i.test(p)) {
			mermaidSource = raw.trim();
		}
	}

	if (!mermaidSource) {
		const clip = (await navigator.clipboard?.readText().catch(() => ""))?.trim() ?? "";
		const clipHasFlow = /^\s*(?:flowchart|graph)\s+(?:TD|TB|BT|RL|LR)\b/im.test(clip);
		const entered = await ask(
			"Mermaid flowchart source to import as a .plan.json",
			clipHasFlow ? clip : "flowchart TD\n  A([Start]) --> B[Step]\n  B --> C([End])",
		);
		if (!entered?.trim()) return;
		mermaidSource = entered.trim();
	}

	const defaultTitle = p ? baseName(p).replace(/\.[^.]+$/, "") : "Imported Plan";
	const title = (await ask("Name of the imported plan", defaultTitle))?.trim();
	if (!title) return;

	const assist = (await import("./plan/assist")) as unknown as {
		mermaidToPlan?: (source: string, title?: string) => Plan | { plan: Plan; warnings?: string[] } | null;
	};
	if (typeof assist.mermaidToPlan !== "function") {
		notify("Mermaid flowchart import is not available in this build.", "error");
		return;
	}
	const converted = assist.mermaidToPlan(mermaidSource, title);
	const wrappedPlan =
		converted && typeof converted === "object" && "plan" in converted && (converted as { plan?: unknown }).plan
			? ((converted as { plan: Plan }).plan)
			: null;
	const plan: Plan | null =
		wrappedPlan && Array.isArray(wrappedPlan.nodes)
			? wrappedPlan
			: converted && typeof converted === "object" && "nodes" in converted && Array.isArray((converted as Plan).nodes)
				? (converted as Plan)
				: null;
	if (!plan || !Array.isArray(plan.nodes) || !plan.nodes.length) {
		return notify("Could not parse a Mermaid flowchart from that source.", "error");
	}
	const ticket = ticketAtHand();
	const finalPlan: Plan = ticket && !plan.ticket ? { ...plan, ticket } : plan;

	const planDir = folderParts(state.project?.plans ?? "design");
	const safeStem = title.replace(/\.plan\.json$/i, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "imported-plan";
	const dest = joinPath(wsRoot, ...planDir, `${safeStem}.plan.json`);
	const exists = await backend.read(dest).then(
		() => true,
		() => false,
	);
	if (exists) {
		const OVERWRITE = "Overwrite existing plan";
		const answer = await choose(`${relativeTo(wsRoot, dest)} already exists. Overwrite it?`, [OVERWRITE], { danger: OVERWRITE });
		if (answer !== OVERWRITE) return;
		await backend.historyKeep(dest).catch(() => {});
	}
	await backend.write(dest, printPlan(finalPlan));
	setState("treeVersion", (v) => v + 1);
	await openFile(dest, { keep: true });
	notify(`Imported Mermaid flowchart to ${relativeTo(wsRoot, dest)} (${finalPlan.nodes.length} nodes).`);
}

async function gitBlameLineCommand() {
	const root = state.workspace?.root;
	const p = activePath();
	if (!root || !p || !isInside(root, p)) return notify("Open a workspace file first.");
	const line = activeLiveEditor()?.getPosition().lineNumber ?? activeEditor()?.getPosition()?.lineNumber ?? state.cursor.line ?? 1;
	const blame = await backend.gitBlameLine(p, line).catch(() => null);
	if (!blame) {
		return notify(`No Git blame info for ${baseName(p)}:${line} (outside Git or untracked file).`);
	}
	if (/^0+$/.test(blame.sha)) {
		return notify(`Line ${line} of ${baseName(p)} has uncommitted local changes.`);
	}
	const ticketMatch = blame.ticket || /\b([A-Za-z][A-Za-z0-9]{1,15}-\d+)\b/.exec(blame.summary)?.[1];
	const ticketDoc = ticketMatch
		? docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === ticketMatch.toLowerCase())
		: undefined;
	const action = await quickPick<"diff" | "ticket" | "copy">({
		title: `${baseName(p)}:${line} · ${blame.shortSha} (${blame.author}, ${blame.date})`,
		placeholder: blame.summary || "Choose an action for this commit…",
		items: [
			{
				label: `Open commit diff in Review (${blame.shortSha})`,
				value: "diff",
				detail: blame.summary,
				icon: "split-horizontal",
			},
			...(ticketMatch
				? [
						{
							label: `Open ticket ${ticketMatch}`,
							value: "ticket" as const,
							detail: ticketDoc?.title || "Search workspace for ticket",
							icon: "checklist" as const,
						},
					]
				: []),
			{
				label: `Copy commit SHA (${blame.shortSha})`,
				value: "copy",
				detail: blame.sha,
				icon: "copy",
			},
		],
	});
	if (!action) return;
	if (action === "copy") {
		await copyText(blame.sha, `Copied commit ${blame.shortSha}.`);
		return;
	}
	if (action === "ticket" && ticketMatch) {
		if (ticketDoc) {
			await openFile(ticketDoc.path, { keep: true });
		} else {
			const { searchFor } = await import("./panels/Search");
			searchFor(ticketMatch);
		}
		return;
	}
	if (action === "diff") {
		try {
			const { before, after } = await backend.gitCommitFile(p, blame.sha);
			if (before === null && after === null) {
				return notify(`Could not read text diff for ${baseName(p)} at ${blame.shortSha}.`, "error");
			}
			const [{ openComparison }, { languageFor }] = await Promise.all([import("./editor/Review"), import("./editor/languages")]);
			await openComparison({
				title: `${blame.shortSha}: ${baseName(p)}`,
				path: p,
				before: before ?? "",
				after: after ?? "",
				beforeLabel: before === null ? "(not in parent)" : `${blame.shortSha}~1`,
				afterLabel: after === null ? "(deleted)" : blame.shortSha,
				language: languageFor(p),
				effect: `${blame.shortSha} (${blame.author}, ${blame.date}) — ${blame.summary}. Nothing here changes the file.`,
			});
		} catch (e: any) {
			notify(`Could not open commit diff: ${String(e?.message ?? e)}`, "error");
		}
	}
}

async function gitSwitchBranchCommand() {
	if (!state.workspace) return notify("Open a folder first.");
	const info = await backend.gitBranches().catch(() => null);
	if (!info) return notify("This folder is not in a Git repository.");
	if (!info.branches.length) return notify("No local Git branches were found.");
	const picked = await quickPick<string>({
		title: `Switch Git branch (current: ${info.current || "detached"})`,
		placeholder: "Filter local branches…",
		items: info.branches.map((b) => ({
			label: b.name,
			value: b.name,
			checked: b.current,
			icon: "git-branch",
			detail: b.upstream ? `tracks ${b.upstream}` : undefined,
			description: b.lastSubject,
		})),
	});
	if (!picked) return;
	if (picked === info.current) return notify(`Already on branch ${picked}.`);
	const res = await backend.gitCheckout(picked).catch((e: any) => ({ ok: false, message: String(e?.message ?? e) }));
	const { refreshGit } = await import("./git");
	await refreshGit();
	setState("treeVersion", (v) => v + 1);
	notify(res.message || (res.ok ? `Switched to branch ${picked}.` : `Could not switch to branch ${picked}.`), res.ok ? "info" : "error");
}

async function gitStashCommand() {
	if (!state.workspace) return notify("Open a folder first.");
	const listed = await backend.gitStash("list").catch(() => null);
	if (!listed || !listed.ok) {
		return notify(listed?.message || "This folder is not in a Git repository.", "error");
	}
	const entries = listed.entries ?? [];
	const action = await quickPick<"push" | "pop" | "list">({
		title: "Git stash",
		placeholder: "Choose a stash action…",
		items: [
			{
				label: "Stash working changes (push)…",
				value: "push",
				detail: "Save uncommitted changes with an optional message",
				icon: "layers",
			},
			{
				label: "Pop latest stash",
				value: "pop",
				detail: entries[0] ? `${entries[0].ref}: ${entries[0].message}` : "Apply and remove the latest stash entry",
				icon: "discard",
			},
			{
				label: `List stashes (${entries.length})`,
				value: "list",
				detail: entries.length ? "Inspect saved local stash entries" : "No stashes saved",
				icon: "list-flat",
			},
		],
	});
	if (!action) return;
	const { refreshGit } = await import("./git");
	if (action === "push") {
		const defaultMsg = ticketAtHand() ? `${ticketAtHand()}: WIP` : "";
		const msg = await ask("Stash message (optional)", defaultMsg);
		if (msg === null) return;
		const res = await backend.gitStash("push", msg.trim() || undefined).catch((e: any) => ({ ok: false, message: String(e?.message ?? e) }));
		await refreshGit();
		setState("treeVersion", (v) => v + 1);
		notify(res.message || (res.ok ? "Stashed working changes." : "Could not stash changes."), res.ok ? "info" : "error");
		return;
	}
	if (action === "pop") {
		const res = await backend.gitStash("pop").catch((e: any) => ({ ok: false, message: String(e?.message ?? e) }));
		await refreshGit();
		setState("treeVersion", (v) => v + 1);
		notify(res.message || (res.ok ? "Popped latest stash." : "Could not pop stash."), res.ok ? "info" : "error");
		return;
	}
	if (!entries.length) {
		notify("No local Git stashes exist.");
		return;
	}
	await quickPick<string>({
		title: `Local Git stashes (${entries.length})`,
		placeholder: "Filter stashes…",
		items: entries.map((e) => ({
			label: e.ref,
			value: e.ref,
			description: e.message,
			icon: "layers",
		})),
	});
}

/**
 * Every default shortcut: the one place a command's keys are written down.
 * A command may have more than one (a key that differs between layouts).
 */
const KEYS: Record<string, string> = {
	"ctrl+o": "open-folder",
	"ctrl+p": "quick-open",
	"ctrl+shift+o": "quick-outline",
	"ctrl+t": "symbols",
	"ctrl+shift+p": "command-palette",
	"ctrl+n": "new-untitled",
	"ctrl+s": "save",
	"ctrl+alt+s": "save-all",
	"ctrl+w": "close",
	"ctrl+shift+t": "reopen-tab",
	"ctrl+tab": "recent-tab",
	"ctrl+shift+tab": "recent-tab-back",
	"alt+arrowleft": "go-back",
	"alt+arrowright": "go-forward",
	"alt+z": "word-wrap",
	"alt+shift+c": "copy-path",
	"ctrl+pagedown": "next-tab",
	"ctrl+pageup": "previous-tab",
	"ctrl+shift+pagedown": "move-tab-right",
	"ctrl+shift+pageup": "move-tab-left",
	"ctrl+\\": "split",
	// Where the backslash needs AltGr, Ctrl with it arrives as Ctrl+Alt.
	"ctrl+alt+\\": "split",
	"ctrl+1": "focus-editor",
	"ctrl+0": "focus-side-panel",
	"ctrl+shift+f": "search",
	"ctrl+shift+e": "explorer",
	"ctrl+shift+d": "docs",
	"ctrl+alt+g": "git",
	"ctrl+alt+k": "switch-active-ticket",
	"ctrl+alt+o": "open-active-ticket-side",
	"alt+shift+d": "open-schema-at-cursor",
	"ctrl+alt+enter": "open-link",
	"ctrl+e": "toggle-markdown-mode",
	"ctrl+alt+t": "md-insert-template",
	"ctrl+alt+n": "md-new-from-template",
	"ctrl+b": "toggle-sidebar",
	"ctrl+alt+b": "toggle-right-panel",
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
	f10: "menu-bar",
};

/** On a Mac, Alt with an arrow moves the cursor by a word, in the editor and in every box: those keys stay the text's. */
const NOT_ON_A_MAC = new Set(["alt+arrowleft", "alt+arrowright"]);
/** macOS VS Code defaults for Go Back / Go Forward (ADR 0032). */
const MAC_DEFAULT_KEYS: Record<string, string> = {
	"ctrl+-": "go-back",
	"ctrl+shift+-": "go-forward",
	"ctrl+shift+_": "go-forward",
};
const onMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
export const DEFAULT_KEYS: Record<string, string> = onMac
	? { ...Object.fromEntries(Object.entries(KEYS).filter(([key]) => !NOT_ON_A_MAC.has(key))), ...MAC_DEFAULT_KEYS }
	: KEYS;

/** The default shortcuts with the user's overrides ("" unbinds). */
export function keymap(): Record<string, string> {
	return effectiveKeys(DEFAULT_KEYS, state.settings.keys ?? {});
}

/** A command's shortcuts as they are shown: "Ctrl+Shift+P", several joined by ", ". */
export const keysFor = (id: string) => keysOf(id, keymap()).map(displayKey).join(", ");

/**
 * Text-editing shortcuts that take precedence over non-editing window shortcuts
 * (e.g. Ctrl+B = Bold instead of Toggle side bar) whenever focus is inside a
 * Markdown text editor (CodeMirror 6 Live Preview or Monaco Source mode).
 */
const MARKDOWN_TEXT_KEYS: Record<string, string> = {
	"ctrl+b": "md-bold",
	"ctrl+i": "md-italic",
	"ctrl+shift+x": "md-strike",
	"ctrl+`": "md-code",
	"ctrl+alt+h": "md-highlight",
	"ctrl+k": "md-link",
	"ctrl+l": "md-checkbox",
};

export function installKeys() {
	setFocusFallback(focusEditor);
	installRecentTabs();
	window.addEventListener(
		"keydown",
		(e) => {
			// A modal has the keyboard: only its own keys work, and a shortcut
			// being recorded in Settings runs nothing.
			// AltGr is typing a character (a backslash on many layouts), never a shortcut.
			if (modalOpen() || isModifierKey(e.key) || e.getModifierState("AltGraph")) return;
			const pressed = keyNames(e);
			// Text-editing controls supersede conflicting chrome shortcuts inside Markdown editors.
			if (isInMarkdownTextEditor(e.target, activeDoc()?.model.getLanguageId())) {
				const mdCmd = pressed.map((name) => MARKDOWN_TEXT_KEYS[name]).find(Boolean);
				if (mdCmd) {
					e.preventDefault();
					e.stopPropagation();
					runMarkdownEdit(mdCmd);
					return;
				}
			}
			const map = keymap();
			let id = pressed.map((name) => map[name]).find(Boolean);
			// On macOS, Cmd+- stays Zoom Out while Ctrl+- runs VS Code Go Back.
			if (onMac && id === "go-back" && e.metaKey && !e.ctrlKey && e.key === "-") id = "zoom-out";
			const targetEl = e.target instanceof Element ? e.target : document.activeElement;
			const inTable = Boolean(targetEl?.closest(".cm-md-table-wrap, .table-view"));
			const inLiveMarkdown = Boolean(targetEl?.closest(".cm-editor") && !targetEl.closest(".cm-md-read"));
			if (shouldLetEditorHandleKey({ id, pressed, inTable, inLiveMarkdown })) return;
			if (id === "toggle-markdown-mode" && !isMarkdown(activePath())) return;
			// Alt and a menu's first letter opens that menu, where no shortcut has the key. Not with Ctrl or Shift, and not
			// where Alt and a letter types a character: the key is then that character, not the letter.
			const menu = !id && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.length === 1 ? menuForLetter(e.key) : -1;
			if (!id && (menu < 0 || !openMenu(menu))) return;
			e.preventDefault();
			e.stopPropagation();
			if (id) runCommand(id);
		},
		true,
	);
}
