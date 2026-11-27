// The menu bar's menus, as data: which entries each menu has, in which order,
// what each one runs and what it needs before it can run. No DOM and no app
// state; the bar itself (src/view/MenuBar.tsx) draws this and runs it.
//
// The menus are the ones an editor is expected to have (File, Edit, Selection,
// View, Go, Help), and hold what is already a command here or in the text
// editor: a menu is a way to find a command, not a second place to keep one.
import { matchesOn, REGEX_MAX_LINE_LENGTH } from "./searchPattern";

/** What has to be there before an entry can run. */
export type Needs = "folder" | "file" | "text";

/** What the window has now. `text` is a file shown as text, which the text editor's own commands act on. */
export type Has = { folder: boolean; file: boolean; text: boolean };

export type BarEntry =
	| "separator"
	/** One of the app's commands, by its id. */
	| { label: string; command: string; needs?: Needs }
	/** One of the text editor's own commands, by its id there. */
	| { label: string; editor: string; needs: "file" | "text" };

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
			forFolder("New untitled file", "new-untitled"),
			forFolder("New file or folder…", "new-file"),
			{ label: "Open folder…", command: "open-folder" },
			"separator",
			forFolder("New ticket…", "new-ticket"),
			forFolder("New spec…", "new-spec"),
			forFolder("New plan…", "new-plan"),
			forFolder("New note from template…", "md-new-from-template"),
			forFolder("New decision…", "new-decision"),
			forFolder("New question…", "new-question"),
			forFolder("New table…", "new-table"),
			"separator",
			forFolder("Import tickets…", "import-tickets"),
			forFolder("Import Word / HTML doc…", "import-legacy-doc"),
			forFolder("Generate table doc from SQL…", "generate-schema-doc"),
			forFolder("Generate Mermaid ER diagram…", "generate-er-diagram"),
			forFolder("Import Mermaid flowchart as Plan…", "import-mermaid-plan"),
			forFile("Link document to ticket…", "link-doc-to-ticket"),
			forFile("Set document status…", "set-doc-status"),
			forFile("Record document approval…", "record-doc-approval"),
			forFolder("Generate test execution protocol…", "generate-test-protocol"),
			forFolder("Release readiness overview…", "release-readiness"),
			forFolder("Update catalogs", "update-catalogs"),
			forFolder("Close out active ticket…", "closeout-ticket"),
			forFolder("Onboard existing workspace…", "onboard-workspace"),
			"separator",
			forFile("Save", "save"),
			forFile("Save all", "save-all"),
			forFile("Revert file", "revert"),
			"separator",
			forFile("Export as standalone HTML…", "export-doc-html"),
			forFile("Export as Word (.docx)…", "export-docx"),
			forFile("Print / Save as PDF…", "print-doc"),
			forFile("Copy as Jira / Confluence markup", "copy-doc-jira"),
			forFile("Copy as HTML", "copy-doc-html"),
			forFolder("Export ticket release packet…", "export-ticket-packet"),
			forFolder("Export deployment manifest…", "export-deployment-manifest"),
			forFolder("Export Release Bundle…", "export-release-bundle"),
			forFolder("Export Traceability Matrix (RTM)…", "export-rtm"),
			"separator",
			forFolder("Rename…", "rename-file"),
			forFolder("Move to trash…", "trash-file"),
			forFile("Copy path", "copy-path"),
			forFile("Copy path in the project", "copy-relative-path"),
			forFile("Copy file name", "copy-file-name"),
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
			forFolder("Replace in files…", "replace-in-files"),
			forFolder("Find references in Docs", "find-in-docs"),
			"separator",
			text("Toggle line comment", "editor.action.commentLine"),
			text("Toggle block comment", "editor.action.blockComment"),
			{ label: "Format document", command: "format", needs: "text" },
			{ label: "Wrap in region…", command: "wrap-region", needs: "text" },
			{ label: "Copy for Designer", command: "copy-designer", needs: "text" },
			"separator",
			{ label: "Insert template…", command: "md-insert-template", needs: "text" },
			{ label: "Insert / update table of contents", command: "md-toc", needs: "text" },
			{ label: "Format code block", command: "md-format-code-block", needs: "text" },
			{ label: "Rename heading across workspace…", command: "rename-heading", needs: "text" },
			forFolder("Rename tag across workspace…", "rename-tag"),
			{ label: "Copy Markdown code citation", command: "copy-code-citation", needs: "text" },
			{ label: "Copy Markdown code citation + excerpt", command: "copy-code-citation-excerpt", needs: "text" },
			{ label: "Add selection to registry…", command: "add-selection-to-registry", needs: "text" },
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
			text("Duplicate selection", "editor.action.duplicateSelection"),
			text("Join lines", "editor.action.joinLines"),
			"separator",
			text("Add cursor above", "editor.action.insertCursorAbove"),
			text("Add cursor below", "editor.action.insertCursorBelow"),
			text("Add cursors to line ends", "editor.action.insertCursorAtEndOfEachLineSelected"),
			text("Add next occurrence", "editor.action.addSelectionToNextFindMatch"),
			text("Select all occurrences", "editor.action.selectHighlights"),
			text("Select to bracket", "editor.action.selectToBracket"),
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
			forFolder("Document outline", "objects"),
			forFolder("Palette", "palette"),
			forFolder("Reference", "reference"),
			forFolder("Source control", "git"),
			forFolder("History", "history"),
			forFolder("Health", "health"),
			forFolder("Agent", "agent"),
			"separator",
			forFolder("Problems", "problems"),
			forFolder("Output", "output"),
			forFolder("Call graph", "graph"),
			"separator",
			forFolder("Toggle side bar", "toggle-sidebar"),
			forFolder("Toggle bottom panel", "toggle-panel"),
			forFolder("Toggle maximized panel", "toggle-panel-maximize"),
			forFolder("Toggle right panel", "toggle-right-panel"),
			{ label: "Hide the menu bar", command: "toggle-menu-bar" },
			forFolder("Reset the layout", "reset-layout"),
			"separator",
			forFile("Split editor", "split"),
			forFile("Toggle blocks view", "blocks"),
			forFile("Toggle Markdown Live / Read view", "toggle-markdown-mode"),
			forFile("Split Read preview to side", "split-markdown-read"),
			{ label: "Toggle Markdown reading highlight", command: "toggle-markdown-reading-highlight" },
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
			forFile("Go to symbol in file…", "quick-outline"),
			{ label: "Go to line…", command: "go-to-line", needs: "text" },
			"separator",
			forFolder("Switch active working ticket…", "switch-active-ticket"),
			forFolder("Open active ticket to side", "open-active-ticket-side"),
			forFile("Open governing doc…", "open-governing-doc"),
			forFile("Open schema doc at cursor…", "open-schema-at-cursor"),
			forFile("Open link at cursor", "open-link"),
			forFile("Git line blame (commit & ticket)", "git-blame-line"),
			"separator",
			forFile("Fold all headings", "md-fold-all"),
			forFile("Unfold all headings", "md-unfold-all"),
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
			{ label: "Keyboard shortcuts…", command: "keyboard-shortcuts" },
			"separator",
			{ label: "About SSL Studio", command: "about" },
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

/**
 * What the text editor's commands are called in a text box: the six a box
 * has of its own. With the keyboard in a box (a search, the agent's prompt),
 * the Edit menu works on the box, not on the code behind it.
 */
export const FIELD_COMMANDS: Readonly<Record<string, "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll">> = {
	undo: "undo",
	redo: "redo",
	"editor.action.clipboardCutAction": "cut",
	"editor.action.clipboardCopyAction": "copy",
	"editor.action.clipboardPasteAction": "paste",
	"editor.action.selectAll": "selectAll",
};

/**
 * What a right-click on a text box offers, of the box's own commands: only
 * what would do something now. Nothing to cut from a box that cannot be typed
 * in, nothing to copy with nothing selected, no paste where the window may not
 * read the clipboard, nothing to select in an empty box.
 */
export function boxMenu(box: { selected: boolean; editable: boolean; filled: boolean; canPaste: boolean }): ("cut" | "copy" | "paste" | "selectAll")[] {
	return [...(box.selected && box.editable ? (["cut"] as const) : []), ...(box.selected ? (["copy"] as const) : []), ...(box.editable && box.canPaste ? (["paste"] as const) : []), ...(box.filled ? (["selectAll"] as const) : [])];
}

/**
 * Whether a menu was asked for by its key (the menu key, Shift+F10) and not
 * by the pointer: the key was pressed after the last press of a pointer, and
 * a moment ago. The web view's own event does not say: some give a menu
 * asked for by key the right button and a place, as if it were a click.
 * Times are the events' own, in milliseconds; 0 for one that never happened.
 */
export const askedByKey = (keyAt: number, pressAt: number, now: number, within = 1000): boolean => keyAt > 0 && keyAt >= pressAt && now - keyAt <= within;

/** The menu Alt and a letter opens: its place in the bar, or -1. */
export const menuForLetter = (letter: string, menus: readonly BarMenu[] = MENU_BAR) => menus.findIndex((menu) => menu.letter === letter.toLowerCase());

/** The menu beside one, going round at the ends. */
export const stepMenu = (at: number, by: 1 | -1, count = MENU_BAR.length) => (((at + by) % count) + count) % count;

/**
 * The entry a typed letter goes to: the next one after `from` whose name
 * starts with it, going round; `from` itself when it is the only one, and -1
 * when none does. What the keyboard cannot land on (a separator) is given as
 * null.
 */
export function letterItem(labels: readonly (string | null)[], letter: string, from: number): number {
	const wanted = letter.toLowerCase();
	for (let step = 1; step <= labels.length; step++) {
		const at = (((from + step) % labels.length) + labels.length) % labels.length;
		if (labels[at]?.toLowerCase().startsWith(wanted)) return at;
	}
	return -1;
}

// --- Pure Round 6 workspace helpers (ER diagram merge, Agent review/tests, Safe replace, Plan breadcrumbs, Git branch check) ---

/**
 * Non-destructively replaces the first fenced Mermaid `erDiagram` block inside
 * `existingMarkdown` while preserving YAML frontmatter, headings, and hand-written
 * prose outside the fence (ADR 0002). Returns `{ text, replaced: false }` when no
 * existing `erDiagram` fence is found.
 */
export function replaceErDiagramBlock(existingMarkdown: string, newDiagram: string): { text: string; replaced: boolean } {
	const eol = existingMarkdown.includes("\r\n") ? "\r\n" : "\n";
	const lines = existingMarkdown.split(/\r?\n/);
	const replacementLines = newDiagram.replace(/\r\n/g, "\n").trimEnd().split("\n");

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
			// Skip leading blank lines, %% comments, and optional Mermaid YAML frontmatter (`--- ... ---`).
			let bodyIdx = i + 1;
			while (bodyIdx < closeIdx && (!lines[bodyIdx]!.trim() || lines[bodyIdx]!.trim().startsWith("%%"))) bodyIdx++;
			if (bodyIdx < closeIdx && lines[bodyIdx]!.trim() === "---") {
				let fmEnd = bodyIdx + 1;
				while (fmEnd < closeIdx && lines[fmEnd]!.trim() !== "---") fmEnd++;
				if (fmEnd < closeIdx) {
					bodyIdx = fmEnd + 1;
					while (bodyIdx < closeIdx && (!lines[bodyIdx]!.trim() || lines[bodyIdx]!.trim().startsWith("%%"))) bodyIdx++;
				}
			}
			if (bodyIdx < closeIdx && /^erDiagram\b/i.test(lines[bodyIdx]!.trim())) {
				const merged = [...lines.slice(0, i), ...replacementLines, ...lines.slice(closeIdx + 1)];
				return { text: merged.join(eol), replaced: true };
			}
		}
		i = closeIdx + 1;
	}
	return { text: existingMarkdown, replaced: false };
}

export type FencedBlockLike = { lang: string; code: string };

export type ReviewBlockChoice = {
	label: string;
	detail?: string;
	block: FencedBlockLike | null;
};

export type MarkdownReviewPlan =
	| { mode: "use-full" }
	| { mode: "use-block"; block: FencedBlockLike }
	| { mode: "pick"; choices: ReviewBlockChoice[] };

const MARKDOWN_REVIEW_FENCE_RE = /^(markdown|md|diff|patch)$/i;

/**
 * Decides how to extract proposed content from an Agent reply for ReviewView.
 * For Markdown targets, an inner `ssl`/`sql`/`mermaid` fence is NEVER auto-extracted
 * as a full-file replacement; multi-block Markdown replies put "Use full Markdown reply"
 * first so prose + inner snippets remain intact.
 */
export function planMarkdownReviewExtraction(targetLang: string, blocks: readonly FencedBlockLike[]): MarkdownReviewPlan {
	const lang = targetLang.toLowerCase();
	if (!blocks.length) return { mode: "use-full" };
	if (blocks.length === 1) {
		const only = blocks[0]!;
		if (lang === "markdown" && !MARKDOWN_REVIEW_FENCE_RE.test(only.lang)) {
			return { mode: "use-full" };
		}
		return { mode: "use-block", block: only };
	}

	const ranked = [...blocks].sort((a, b) => {
		const aMatch = lang === "markdown" ? (MARKDOWN_REVIEW_FENCE_RE.test(a.lang) ? 0 : 1) : a.lang.toLowerCase() === lang ? 0 : 1;
		const bMatch = lang === "markdown" ? (MARKDOWN_REVIEW_FENCE_RE.test(b.lang) ? 0 : 1) : b.lang.toLowerCase() === lang ? 0 : 1;
		return aMatch - bMatch || b.code.length - a.code.length;
	});

	const blockChoices: ReviewBlockChoice[] = ranked.map((b, i) => {
		const lines = b.code.split("\n").length;
		const first = (b.code.split("\n")[0] ?? "").trim().slice(0, 48);
		return {
			label: `Block ${i + 1} (${b.lang || "text"}, ${lines} ${lines === 1 ? "line" : "lines"})`,
			detail: first || undefined,
			block: b,
		};
	});

	if (lang === "markdown") {
		return {
			mode: "pick",
			choices: [
				{
					label: "Use full Markdown reply",
					detail: "Keep prose and inner code fences intact",
					block: null,
				},
				...blockChoices,
			],
		};
	}

	return {
		mode: "pick",
		choices: [
			...blockChoices,
			{
				label: "Use full reply text",
				detail: "Compare the entire reply text",
				block: null,
			},
		],
	};
}

export type ReviewFormat = "markdown" | "csv" | "code";
export type ReviewLayout = "split" | "inline" | "rendered" | "table";

/** Storage key for per-format ReviewView diff layout persistence. */
export function reviewLayoutKey(format: ReviewFormat): string {
	if (format === "markdown") return "review.layout.markdown";
	if (format === "csv") return "review.layout.csv";
	return "review.layout";
}

/** Resolves initial ReviewView layout for a format: Markdown defaults to "rendered", CSV to "table", code to "split". */
export function initialReviewLayout(format: ReviewFormat, saved: string | null | undefined): ReviewLayout {
	if (format === "markdown") {
		return saved === "split" || saved === "inline" || saved === "rendered" ? saved : "rendered";
	}
	if (format === "csv") {
		return saved === "split" || saved === "inline" || saved === "table" ? saved : "table";
	}
	return saved === "inline" ? "inline" : "split";
}

/**
 * The shell's keys that are keys for editing in Sublime Text, each with the shell command it is the default key
 * of (ADR 0034). While a text editor has the keyboard such a key is the editor's: Ctrl+Shift+D duplicates,
 * Ctrl+J joins lines, Ctrl+Shift+M selects to the bracket. Anywhere else it is the shell's, as in VS Code.
 *
 * `macKey` is the press on a Mac, as `keyNamesForPlatform` names it first: Sublime Text's key there is on Cmd for
 * the first two and on Ctrl itself for the third, and Cmd+Shift+M stays the shell's.
 */
export const EDITING_KEYS_OVER_SHELL: readonly { key: string; macKey: string; command: string }[] = [
	{ key: "ctrl+shift+d", macKey: "cmd+shift+d", command: "docs" },
	{ key: "ctrl+j", macKey: "cmd+j", command: "toggle-panel" },
	{ key: "ctrl+shift+m", macKey: "ctrl+shift+m", command: "problems" },
];

/** How long the code editor waits for the second key of one of its two-key shortcuts, in milliseconds. */
export const EDITOR_CHORD_WAIT = 5000;

/**
 * Whether a press is the first key of the code editor's two-key shortcuts: Ctrl+K (Cmd+K on a Mac), as in VS Code
 * and in Sublime Text. The key after it is the editor's, whatever the shell has on that key: Ctrl+K Ctrl+0
 * unfolds, and is not "focus the side panel".
 */
export function startsEditorChord(pressed: readonly string[], mac = false): boolean {
	return pressed[0] === (mac ? "cmd+k" : "ctrl+k");
}

/**
 * Returns true when the global capture-phase keydown handler should stand aside and let
 * the focused editor/table widget handle the shortcut (table Alt+Arrow column reorder, and
 * Sublime Text's editing keys in a text editor: `EDITING_KEYS_OVER_SHELL`).
 *
 * A key stands aside only while it runs the command it is the default key of. Given to another command by the
 * user, it is theirs and runs that command everywhere; with its command moved to another key, nothing of the
 * shell's is on it and the editor has it anyway.
 */
export function shouldLetEditorHandleKey(info: {
	id?: string;
	pressed: readonly string[];
	inTable: boolean;
	inLiveMarkdown: boolean;
	/** The keyboard is in the code editor's text (not in its find box, or another of its own boxes). */
	inCodeEditor?: boolean;
	mac?: boolean;
}): boolean {
	if (
		info.inTable &&
		(info.id === "go-back" || info.id === "go-forward") &&
		info.pressed.some((k) => k === "alt+arrowleft" || k === "alt+arrowright")
	) {
		return true;
	}
	if (info.inLiveMarkdown || info.inCodeEditor) {
		const press = info.pressed[0];
		return EDITING_KEYS_OVER_SHELL.some((own) => own.command === info.id && press === (info.mac ? own.macKey : own.key));
	}
	return false;
}

export type ExtractedPlanTestCase = {
	title: string;
	node?: string;
	given?: string;
	expect?: string;
	notes?: string;
};

function cleanMdInline(raw: string): string {
	return raw
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function splitPipeCells(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const out: string[] = [];
	let cur = "";
	for (let i = 0; i < trimmed.length; i++) {
		if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (trimmed[i] === "|") {
			out.push(cur.trim());
			cur = "";
		} else {
			cur += trimmed[i]!;
		}
	}
	out.push(cur.trim());
	return out;
}

function stripFencedCodeForParsing(markdown: string): string[] {
	const rawLines = markdown.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let active: { ch: string; len: number } | null = null;
	for (const line of rawLines) {
		if (!active) {
			const open = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
			if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
				active = { ch: open[1]![0]!, len: open[1]!.length };
				out.push("");
				continue;
			}
			out.push(line);
		} else {
			if (new RegExp(`^[ \\t]{0,3}${active.ch}{${active.len},}[ \\t]*$`).test(line)) {
				active = null;
			}
			out.push("");
		}
	}
	return out;
}

/**
 * Extracts structured `PlanTestCase` candidates from Markdown replies containing either
 * test-case pipe tables (Title/Case + Given/Expect) or bulleted/checklist/heading
 * Given / When / Expect test descriptions.
 */
export function extractPlanTestCasesFromMarkdown(markdown: string): ExtractedPlanTestCase[] {
	const lines = stripFencedCodeForParsing(markdown);
	const out: ExtractedPlanTestCase[] = [];
	const seen = new Set<string>();

	const pushCase = (tc: ExtractedPlanTestCase) => {
		const title = cleanMdInline(tc.title).replace(/^[\d.)\-–—:\s]+/, "").replace(/[:–—-]+$/, "").trim();
		if (!title || title.length < 2) return;
		const key = title.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push({
			title,
			...(tc.node?.trim() ? { node: cleanMdInline(tc.node) } : {}),
			...(tc.given?.trim() ? { given: cleanMdInline(tc.given) } : {}),
			...(tc.expect?.trim() ? { expect: cleanMdInline(tc.expect) } : {}),
			...(tc.notes?.trim() ? { notes: cleanMdInline(tc.notes) } : {}),
		});
	};

	const combineGivenWhen = (given?: string, when?: string): string | undefined => {
		const g = given?.trim() ?? "";
		const w = when?.trim() ?? "";
		if (g && w) return `${g}; When: ${w}`;
		return g || (w ? `When: ${w}` : undefined);
	};

	// 1. Parse Markdown pipe tables whose headers indicate test cases.
	for (let i = 0; i + 2 < lines.length; i++) {
		const headLine = lines[i]!.trim();
		const sepLine = lines[i + 1]!.trim();
		if (!headLine.includes("|") || !/^\|?\s*:?-{2,}/.test(sepLine)) continue;
		const headers = splitPipeCells(headLine).map((h) => cleanMdInline(h).toLowerCase());
		const findCol = (re: RegExp) => headers.findIndex((h) => re.test(h));
		const idCol = findCol(/^(?:id|tc|case\s*id|#)$/);
		const titleCol = findCol(/^(?:title|test(?:\s+case)?|case|scenario|name|check)$/);
		const nodeCol = findCol(/^(?:node|step|stage)$/);
		const givenCol = findCol(/^(?:given|input|inputs|precondition|preconditions|setup)$/);
		const whenCol = findCol(/^(?:when|action|trigger)$/);
		const expectCol = findCol(/^(?:expect(?:ed)?(?:\s+(?:result|outcome|output))?|result|outcome|assertion)$/);
		const notesCol = findCol(/^(?:notes?|remarks?|comments?)$/);

		if ((titleCol < 0 && idCol < 0) || (givenCol < 0 && expectCol < 0)) continue;
		let j = i + 2;
		while (j < lines.length && lines[j]!.trim().includes("|")) {
			const cells = splitPipeCells(lines[j]!);
			const rawTitle = titleCol >= 0 ? (cells[titleCol] ?? "") : "";
			const rawId = idCol >= 0 ? (cells[idCol] ?? "") : "";
			const title = rawTitle || rawId;
			const given = combineGivenWhen(givenCol >= 0 ? cells[givenCol] : undefined, whenCol >= 0 ? cells[whenCol] : undefined);
			const expect = expectCol >= 0 ? cells[expectCol] : undefined;
			const node = nodeCol >= 0 ? cells[nodeCol] : undefined;
			const notes = notesCol >= 0 ? cells[notesCol] : undefined;
			if (title && (given || expect)) {
				pushCase({ title, node, given, expect, notes });
			}
			j++;
		}
		i = j - 1;
	}

	// 2. Parse structured bullet / checklist / heading Given / When / Expect blocks.
	let cur: { title: string; node?: string; given?: string; when?: string; expect?: string; notes?: string } | null = null;
	const flush = () => {
		if (cur && (cur.given || cur.when || cur.expect)) {
			pushCase({
				title: cur.title,
				node: cur.node,
				given: combineGivenWhen(cur.given, cur.when),
				expect: cur.expect,
				notes: cur.notes,
			});
		}
		cur = null;
	};

	const fieldRe =
		/^(?:[ \t]*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?(?:\*\*|__)?(Given|When|Expect(?:ed(?:\s+(?:result|outcome|output))?)?|Node|Step|Notes?)(?:\s*[:\-–—]\s*(?:\*\*|__)\s*|(?:\*\*|__)?\s*[:\-–—]\s*)(.+)$/i;

	const parseInlineSegments = (body: string) => {
		const givenM = /\b(?:Given|Input)\s*:\s*([^;]+?)(?=(?:\s*[;|]\s*|\s+)(?:When|Expect(?:ed)?|Node|Notes?)\s*:|$)/i.exec(body);
		const whenM = /\bWhen\s*:\s*([^;]+?)(?=(?:\s*[;|]\s*|\s+)(?:Given|Expect(?:ed)?|Node|Notes?)\s*:|$)/i.exec(body);
		const expectM = /\bExpect(?:ed(?:\s+(?:result|outcome))?)?\s*:\s*([^;]+?)(?=(?:\s*[;|]\s*|\s+)(?:Given|When|Node|Notes?)\s*:|$)/i.exec(body);
		const nodeM = /\b(?:Node|Step)\s*:\s*([^;]+?)(?=(?:\s*[;|]\s*|\s+)(?:Given|When|Expect(?:ed)?|Notes?)\s*:|$)/i.exec(body);
		return {
			given: givenM?.[1]?.trim(),
			when: whenM?.[1]?.trim(),
			expect: expectM?.[1]?.trim(),
			node: nodeM?.[1]?.trim(),
		};
	};

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;

		// Check if line is a field inside the current block (e.g. `- **Given:** ...` or `Expect: ...`).
		const fm = fieldRe.exec(rawLine);
		if (fm) {
			const label = fm[1]!.toLowerCase();
			const val = fm[2]!.trim();
			if (!cur) cur = { title: val.slice(0, 60) };
			if (label === "given") cur.given = cur.given ? `${cur.given}; ${val}` : val;
			else if (label === "when") cur.when = cur.when ? `${cur.when}; ${val}` : val;
			else if (label.startsWith("expect")) cur.expect = cur.expect ? `${cur.expect}; ${val}` : val;
			else if (label === "node" || label === "step") cur.node = val;
			else if (label.startsWith("note")) cur.notes = cur.notes ? `${cur.notes}; ${val}` : val;
			continue;
		}

		// Heading starting a new test case block (`### 1. Rush sample turnaround`).
		const hm = /^#{2,6}\s+(.+)$/.exec(trimmed);
		if (hm) {
			flush();
			cur = { title: hm[1]!.trim() };
			continue;
		}

		// Top-level bullet / numbered / checkbox item.
		const bm = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(rawLine);
		if (bm) {
			const indent = bm[1]!.length;
			const content = bm[2]!.trim();
			// Single-line compact format: `- [ ] **Title** — Given: ...; Expect: ...`
			if (/\b(?:Given|When|Expect(?:ed)?)\s*:/i.test(content)) {
				flush();
				const firstMarker = /\b(?:Given|When|Expect(?:ed)?|Node|Step)\s*:/i.exec(content);
				const lead = firstMarker ? content.slice(0, firstMarker.index).replace(/[\s\-–—:|]+$/, "").trim() : "";
				const segs = parseInlineSegments(content);
				if (segs.given || segs.when || segs.expect) {
					pushCase({
						title: lead || segs.expect || segs.given || "Test case",
						node: segs.node,
						given: combineGivenWhen(segs.given, segs.when),
						expect: segs.expect,
					});
				}
				continue;
			}
			// Parent list item opening a multi-line test block.
			if (indent <= 2) {
				flush();
				cur = { title: content };
			}
		}
	}
	flush();

	return out.slice(0, 50);
}

/**
 * Formats an Agent conversation cleanly as Markdown for export into Questions, Decisions,
 * or ticket notes — stripping `(with ...)` context suffixes and internal status notes.
 */
export function formatAgentThreadMarkdown(
	entries: readonly { role: "user" | "agent" | "note"; text: string }[],
	options?: { title?: string; ticket?: string },
): string {
	const qa = entries.filter((e) => (e.role === "user" || e.role === "agent") && e.text.trim().length > 0);
	if (!qa.length) return "";
	const stripCtx = (raw: string) => raw.replace(/\s{2}\(with [^)]+\)\s*$/, "").trim();
	const parts: string[] = [];
	if (options?.title?.trim()) {
		parts.push(`## ${options.title.trim()}${options.ticket ? ` (${options.ticket})` : ""}`);
	}
	let qNum = 0;
	for (const entry of qa) {
		if (entry.role === "user") {
			qNum++;
			const q = stripCtx(entry.text);
			parts.push(`### Question ${qNum}\n\n${q}`);
		} else {
			parts.push(`#### Answer\n\n${entry.text.trim()}`);
		}
	}
	return `${parts.join("\n\n")}\n`;
}

export type TextSpan = { start: number; end: number };

/**
 * Computes 0-based character spans per 1-based line number that Safe Replace must skip
 * in Markdown documents: YAML frontmatter keys (`key:`) and delimiter lines, inline
 * Markdown link targets `](...)`, reference link URLs, and wikilink targets `[[Target]]`
 * (or `[[Target|` when aliased).
 */
export function protectedMarkdownSpans(text: string): Map<number, TextSpan[]> {
	const lines = text.split(/\r?\n/);
	const out = new Map<number, TextSpan[]>();
	const add = (lineNum: number, start: number, end: number) => {
		if (end <= start) return;
		const list = out.get(lineNum) ?? [];
		list.push({ start, end });
		out.set(lineNum, list);
	};

	// 1. YAML frontmatter delimiters & keys
	let bodyStartIdx = 0;
	if (lines.length >= 2 && /^---[ \t]*$/.test(lines[0]!)) {
		let fmEndIdx = -1;
		for (let i = 1; i < lines.length; i++) {
			if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i]!)) {
				fmEndIdx = i;
				break;
			}
		}
		if (fmEndIdx > 0) {
			add(1, 0, lines[0]!.length);
			add(fmEndIdx + 1, 0, lines[fmEndIdx]!.length);
			for (let i = 1; i < fmEndIdx; i++) {
				const km = /^([ \t]*[A-Za-z0-9_.-]+[ \t]*:)/.exec(lines[i]!);
				if (km) add(i + 1, 0, km[1]!.length);
			}
			bodyStartIdx = fmEndIdx + 1;
		}
	}

	// 2. Body lines: link targets `](...)`, reference link URLs, and `[[wikilink]]` targets (outside fenced code).
	let fence: { ch: string; len: number } | null = null;
	for (let idx = bodyStartIdx; idx < lines.length; idx++) {
		const line = lines[idx]!;
		const lineNum = idx + 1;
		if (!fence) {
			const open = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
			if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
				fence = { ch: open[1]![0]!, len: open[1]!.length };
				continue;
			}
		} else {
			if (new RegExp(`^[ \\t]{0,3}${fence.ch}{${fence.len},}[ \\t]*$`).test(line)) fence = null;
			continue;
		}

		// Reference link definition: `[ref]: https://...`
		const refDef = /^([ \t]{0,3}\[[^\]]+\]:[ \t]+)(\S+)/.exec(line);
		if (refDef) {
			add(lineNum, refDef[1]!.length, refDef[1]!.length + refDef[2]!.length);
		}

		// Walk inline code, inline link targets `](...)`, and wikilinks `[[...]]`.
		let i = 0;
		const n = line.length;
		while (i < n) {
			// Skip inline code spans so literal code brackets don't mis-parse as links.
			if (line[i] === "`") {
				let ticks = 0;
				while (i + ticks < n && line[i + ticks] === "`") ticks++;
				const close = line.indexOf("`".repeat(ticks), i + ticks);
				if (close >= 0) {
					i = close + ticks;
					continue;
				}
				i += ticks;
				continue;
			}
			// Wikilink `[[Target]]` or `[[Target|Alias]]`
			if (line[i] === "[" && line[i + 1] === "[") {
				const close = line.indexOf("]]", i + 2);
				if (close > i + 2) {
					const inner = line.slice(i + 2, close);
					const pipe = inner.indexOf("|");
					if (pipe >= 0) {
						// Protect target path up through the pipe, keeping visible alias replaceable.
						add(lineNum, i, i + 2 + pipe + 1);
					} else {
						add(lineNum, i, close + 2);
					}
					i = close + 2;
					continue;
				}
			}
			// Inline Markdown link target `](...)` (respecting balanced nested parens)
			if (line[i] === "]" && line[i + 1] === "(") {
				let j = i + 2;
				let depth = 1;
				while (j < n && depth > 0) {
					if (line[j] === "\\" && j + 1 < n) {
						j += 2;
						continue;
					}
					if (line[j] === "(") depth++;
					else if (line[j] === ")") depth--;
					j++;
				}
				if (depth === 0) {
					add(lineNum, i, j);
					i = j;
					continue;
				}
			}
			i++;
		}
	}
	return out;
}

/** True when a 1-based match `(column, length)` overlaps any protected 0-based `[start, end)` span. */
export function overlapsProtectedSpan(column1Based: number, length: number, spans: readonly TextSpan[] | undefined): boolean {
	if (!spans?.length) return false;
	const mStart = column1Based - 1;
	if (length === 0) {
		return spans.some((s) => mStart >= s.start && mStart <= s.end);
	}
	const mEnd = mStart + length;
	return spans.some((s) => mStart < s.end && mEnd > s.start);
}

export type SafeReplaceOptions = {
	allowedLines?: ReadonlySet<number>;
	isMarkdown?: boolean;
	isPlanJson?: boolean;
	safeDocs?: boolean;
	maxSamples?: number;
};

export type SafeReplaceResult = {
	text: string;
	count: number;
	skippedProtected: number;
	invalidJson: boolean;
	samples: { line: number; before: string; after: string }[];
};

/**
 * Performs Search & Replace on raw file text with optional Safe Docs guards:
 * skips YAML frontmatter keys, Markdown link targets `](...)` and `[[...]]`,
 * and validates `.plan.json` JSON syntax before accepting the rewritten text.
 */
export function replaceSafeInText(
	text: string,
	pattern: RegExp,
	with_: string,
	regex: boolean,
	options: SafeReplaceOptions = {},
): SafeReplaceResult {
	const protectedMap = options.safeDocs && options.isMarkdown ? protectedMarkdownSpans(text) : null;
	const parts = text.split(/(\r?\n)/);
	const maxSamples = options.maxSamples ?? 5;
	let replaced = 0;
	let skippedProtected = 0;
	const samples: { line: number; before: string; after: string }[] = [];

	for (let at = 0; at < parts.length; at += 2) {
		const lineNumber = at / 2 + 1;
		if (options.allowedLines && !options.allowedLines.has(lineNumber)) continue;
		const line = parts[at]!;
		if (regex && line.length > REGEX_MAX_LINE_LENGTH) continue;
		const found = matchesOn(line, pattern, with_, regex);
		if (!found.length) continue;
		const lineSpans = protectedMap?.get(lineNumber);
		const usable = lineSpans
			? found.filter((m) => {
					if (overlapsProtectedSpan(m.column, m.length, lineSpans)) {
						skippedProtected++;
						return false;
					}
					return true;
				})
			: found;
		if (!usable.length) continue;
		replaced += usable.length;
		let out = "";
		let from = 0;
		for (const each of usable) {
			out += line.slice(from, each.column - 1) + each.becomes;
			from = each.column - 1 + each.length;
		}
		const nextLine = out + line.slice(from);
		if (samples.length < maxSamples && nextLine !== line) {
			samples.push({ line: lineNumber, before: line.trim(), after: nextLine.trim() });
		}
		parts[at] = nextLine;
	}

	const nextText = parts.join("");
	if (options.safeDocs && options.isPlanJson && replaced > 0) {
		try {
			const parsed = JSON.parse(nextText);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { text, count: 0, skippedProtected, invalidJson: true, samples };
			}
		} catch {
			return { text, count: 0, skippedProtected, invalidJson: true, samples };
		}
	}
	return { text: nextText, count: replaced, skippedProtected, invalidJson: false, samples };
}

const PLAN_KIND_LABELS: Record<string, string> = {
	start: "Start",
	end: "End",
	step: "Step",
	decision: "Decision",
	call: "Call",
};

function trimCrumb(text: string, limit = 38): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

/**
 * Maps a 1-based line number inside a `.plan.json` file to a human-readable
 * breadcrumb such as `Validation › Check due date` or `Test › Skips Sunday`.
 */
export function planLineBreadcrumb(text: string, line: number): string {
	if (line < 1) return "";
	let raw: Record<string, unknown>;
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
		raw = parsed as Record<string, unknown>;
	} catch {
		return "";
	}

	const lines = text.split(/\r?\n/);
	if (line > lines.length) return "";

	// Locate which top-level JSON key encloses `line`.
	let section = "";
	let sectionStart = 0;
	for (let i = 0; i < line; i++) {
		const m = /^\s{0,2}"(\w+)"\s*:/.exec(lines[i]!);
		if (m) {
			section = m[1]!;
			sectionStart = i;
		}
	}
	if (!section) return "";

	const groups = Array.isArray(raw.groups) ? (raw.groups as { id?: string; name?: string }[]) : [];
	const nodes = Array.isArray(raw.nodes) ? (raw.nodes as { id?: string; kind?: string; text?: string; group?: string }[]) : [];
	const tests = Array.isArray(raw.tests) ? (raw.tests as { id?: string; title?: string }[]) : [];
	const groupById = new Map(groups.filter((g) => g?.id && g?.name).map((g) => [g.id!, g.name!]));
	const nodeById = new Map(nodes.filter((n) => n?.id).map((n) => [n.id!, n]));
	const testById = new Map(tests.filter((t) => t?.id).map((t) => [t.id!, t]));

	if (section === "nodes") {
		let bestId: string | null = null;
		for (let i = sectionStart; i < line; i++) {
			const m = /"id"\s*:\s*"([^"]+)"/.exec(lines[i]!);
			if (m && nodeById.has(m[1]!)) bestId = m[1]!;
		}
		if (bestId) {
			const n = nodeById.get(bestId)!;
			const stage = n.group ? groupById.get(n.group) : undefined;
			const prefix = stage || PLAN_KIND_LABELS[n.kind ?? ""] || "Step";
			const label = n.text?.trim() || bestId;
			return `${prefix} › ${trimCrumb(label)}`;
		}
		return "Steps";
	}

	if (section === "tests") {
		let bestId: string | null = null;
		for (let i = sectionStart; i < line; i++) {
			const m = /"id"\s*:\s*"([^"]+)"/.exec(lines[i]!);
			if (m && testById.has(m[1]!)) bestId = m[1]!;
		}
		if (bestId) {
			const t = testById.get(bestId)!;
			return `Test › ${trimCrumb(t.title?.trim() || bestId)}`;
		}
		return "Tests";
	}

	if (section === "groups") {
		let bestId: string | null = null;
		for (let i = sectionStart; i < line; i++) {
			const m = /"id"\s*:\s*"([^"]+)"/.exec(lines[i]!);
			if (m && groupById.has(m[1]!)) bestId = m[1]!;
		}
		return bestId ? `Stage › ${trimCrumb(groupById.get(bestId)!)}` : "Stages";
	}

	if (section === "edges") {
		for (let i = line - 1; i >= sectionStart; i--) {
			const fm = /"from"\s*:\s*"([^"]+)"/.exec(lines[i]!);
			const tm = /"to"\s*:\s*"([^"]+)"/.exec(lines[i]!);
			if (fm && tm) {
				const fromName = trimCrumb(nodeById.get(fm[1]!)?.text?.trim() || fm[1]!, 28);
				const toName = trimCrumb(nodeById.get(tm[1]!)?.text?.trim() || tm[1]!, 28);
				return `Edge › ${fromName} -> ${toName}`;
			}
		}
		return "Edges";
	}

	if (section === "decisions") {
		for (let i = line - 1; i >= sectionStart; i--) {
			const qm = /"question"\s*:\s*"([^"]+)"/.exec(lines[i]!);
			if (qm) return `Decision › ${trimCrumb(qm[1]!)}`;
		}
		return "Decisions";
	}

	if (section === "built") {
		for (let i = line - 1; i >= sectionStart; i--) {
			const nm = /"name"\s*:\s*"([^"]+)"/.exec(lines[i]!);
			if (nm) return `Built › ${trimCrumb(nm[1]!)}`;
		}
		return "Built";
	}

	return `Plan › ${section}`;
}

export type BranchTicketMismatch = {
	branchTicket: string;
	activeTicket: string;
};

/**
 * Detects when the checked-out Git branch names a ticket key (e.g. `feature/DEMO-101-fix`)
 * that differs from the workspace's active working ticket (`DEMO-102`).
 */
export function detectBranchTicketMismatch(
	branch: string | null | undefined,
	activeTicket: string | null | undefined,
): BranchTicketMismatch | null {
	const rawBranch = branch?.trim() ?? "";
	const rawActive = activeTicket?.trim() ?? "";
	if (!rawBranch || !rawActive) return null;
	const found: string[] = [];
	const re = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,15}-\d+)(?=$|[^A-Za-z0-9])/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(rawBranch))) {
		found.push(m[1]!);
	}
	if (!found.length) return null;
	if (found.some((k) => k.toLowerCase() === rawActive.toLowerCase())) return null;
	return { branchTicket: found[0]!.toUpperCase(), activeTicket: rawActive };
}
