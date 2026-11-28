// Workspace search, results grouped by file; and, from the same box, a
// replace across files. What would be replaced is shown in the results
// before anything is written, and nothing is written until it is confirmed.
// The search, the preview and the replace all find their matches with the
// one expression (src/shared/searchPattern.ts), so they agree.
import { Icon } from "../Icon";
import { FileMark } from "../FileMark";
import { Menu, type MenuItem } from "../Menu";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createAsyncQuery } from "../asyncQuery";
import { monaco } from "../editor/monaco";
import { symbolPath } from "../editor/regions";
import { session } from "../lsp/session";
import type { DocFile, SearchHit } from "../../shared/protocol";
import { backend } from "../backend";
import { choose, quickPick } from "../dialogs";
import { activePath, canonical, displayName, documents, fileChangedOnDisk, isUntitled, notify, openFile, openToSide, save, saveAll, setState, state } from "../state";
import { baseName, isInside, relativeTo } from "../../shared/paths";
import { parseCsv } from "../../shared/csv";
import { createFileFilter, folderPattern } from "../../shared/fileGlob";
import { frontMatter, HEADING, many, one, plainMarkdown } from "../../shared/frontMatter";
import { overlapsProtectedSpan, planLineBreadcrumb, protectedMarkdownSpans, type TextSpan } from "../../shared/menuBar";
import { DOC_FOLDERS, isCatalog, toneOf } from "../../shared/projectDocs";
import {
	applyPreserveCase,
	becomesFound,
	changedSinceSearch,
	folderScope,
	openBatches,
	replacePreviewTitle,
	replaceQuestion,
	replaceSearched,
	searchBoxMoved,
	SEARCH_LIMIT,
	SEARCH_LINE_WINDOW,
	type OpenText,
	type ReplaceEdit,
	type SearchOptions,
} from "../../shared/searchPattern";
import { outline } from "../../shared/outline";
import { workspaceTags } from "../../shared/tags";
import { codeMatchesRef, descendantTickets, scriptsForTicket, ticketForFile, ticketWork } from "../../shared/workContext";
import { recall, remember } from "../graph/canvas";
import { nodeLines, parsePlan } from "../plan/model";
import { docs } from "../project";
import { ticketAtHand } from "../projectDocs";
import { chooseFromMenu, type RowMenuEntry } from "./RowMenu";
import { focusRowsBelow, IconButton, Row, Rows, type Point } from "./Rows";
import { showPanel } from "./registry";
import {
	buildSearchTree,
	byLine,
	collectTreeFolderKeys,
	formatPlaceTrail,
	markedColumns,
	parseDocFilterTokens,
	resolveSearchQuery,
	searchShortfall,
	segments,
	shortfallBlocksReplace,
	shortfallCount,
	splitResultPath,
	stepResultKey,
	timedOutEmpty,
	type LineHit,
	type ParsedDocFilters,
	type SearchFileGroup,
	type SearchScopeKind,
	type SearchTreeNode,
} from "./searchLines";

const count = (n: number, oneWord: string, manyWord = `${oneWord}s`) => `${n} ${n === 1 ? oneWord : manyWord}`;

/** How much of a line is shown before its first match. */
const LEAD = 14;
const VIEW_MODE_KEY = "search.viewMode";

/** The row for replacing is open. Kept while the panel is away, as what was typed in it is. */
const [replacing, setReplacing] = createSignal(false);
/** The rows for which files to look in are open. */
const [choosing, setChoosing] = createSignal(false);
/** Restrict search results to currently open editor tabs (VS Code's Open Editors toggle). */
const [openEditorsOnly, setOpenEditorsOnly] = createSignal(false);
/** Preserve casing of each replaced match (VS Code's Preserve Case `AB`, Alt+P). */
const [preserveCase, setPreserveCase] = createSignal(false);
/** Honor default workspace excludes and `.gitignore` (VS Code's Use Exclude Settings and Ignore Files). */
const [useExcludes, setUseExcludes] = createSignal(true);
/** Tree view (nested compacted folders) vs flat file list, persisted across reloads. */
const [treeView, setTreeView] = createSignal(recall(VIEW_MODE_KEY) === "tree");
const [replacement, setReplacement] = createSignal("");
const [safeDocs, setSafeDocs] = createSignal(true);
const [include, setInclude] = createSignal("");
const [exclude, setExclude] = createSignal("");

/**
 * Shows the Search panel scoped to a specific folder (relative to workspace root). Both boxes are set, and shown:
 * what a scope chosen before was leaving out (the Code scope leaves out the documents) would go on being left out.
 */
export function findInFolder(relFolder: string) {
	const scope = folderScope(relFolder);
	setTicketScopeKey(null);
	setOpenEditorsOnly(false);
	setInclude(scope.include);
	setExclude(scope.exclude);
	setChoosing(true);
	setFocusTick((n) => n + 1);
	showPanel("search");
}

/** Shows the Search panel with its row for replacing open. */
export function showReplace(seed?: string) {
	setReplacing(true);
	if (seed) {
		setRequest({ query: seed, preserveScope: true });
	} else {
		setFocusTick((n) => n + 1);
	}
	showPanel("search");
}

/** Shows Search, seeding from a selection if given or focusing and selecting the query box. */
export function focusSearch(seed?: string) {
	if (seed) {
		setRequest({ query: seed, preserveScope: true });
	} else {
		setFocusTick((n) => n + 1);
	}
	showPanel("search");
}

// The expression that is searched for is never run in the window. A regular expression can take minutes over one
// line ("(a+)+$" on a line of thirty letters), nothing can stop it once it runs, and while it runs here the
// window answers to nothing. It used to be run here for an open file with unsaved changes (to search it), for
// each row of the list (to show what a match would become), and for a replace in an open file. The backend runs
// it now, under its time budget, for the open files too (`backend.searchScan` with their texts); and what a
// replace does here is worked out from what that search found: where each match and its groups lie.

/** Makes the edits of a replace in an open file's text, as one undoable step. Says how many. */
export function replaceInModel(model: monaco.editor.ITextModel, edits: readonly ReplaceEdit[]): number {
	if (!edits.length) return 0;
	model.pushStackElement();
	model.pushEditOperations(
		[],
		edits.map((edit) => ({ range: new monaco.Range(edit.line, edit.column, edit.line, edit.column + edit.length), text: edit.text })),
		() => null,
	);
	model.pushStackElement();
	return edits.length;
}

/**
 * What a replace makes of one file's text, from the matches listed in it and under the Safe Docs guards: the
 * protected parts of a Markdown document are left and counted, and a `.plan.json` that would no longer be JSON is
 * left as it is. Null when the text is not the one that was searched (`replaceSearched`). Every replace worked
 * out in the window comes through here: the preview, the check of a plan, and the replace in an open file.
 */
function replaceGuarded(path: string, text: string, mark: string | undefined, listed: readonly SearchHit[] | undefined, with_: string, regex: boolean, protect: boolean, maxSamples: number) {
	const spans = protect && /\.(md|markdown)$/i.test(path) ? protectedMarkdownSpans(text) : null;
	return replaceSearched(text, mark, listed, with_, regex, {
		skip: spans ? (match) => overlapsProtectedSpan(match.column, match.length, spans.get(match.line)) : undefined,
		json: protect && /\.plan\.json$/i.test(path),
		maxSamples,
		preserveCase: preserveCase(),
	});
}

/** The hits of each file, by the path the search gave it. */
function hitsByPath(hits: readonly SearchHit[]): Map<string, SearchHit[]> {
	const map = new Map<string, SearchHit[]>();
	for (const hit of hits) {
		const list = map.get(hit.path);
		if (list) list.push(hit);
		else map.set(hit.path, [hit]);
	}
	return map;
}

const [request, setRequest] = createSignal<({ query: string; preserveScope?: boolean } & SearchOptions) | null>(null);
const [focusTick, setFocusTick] = createSignal(0);
/** Shows the Search panel with this searched for: a table cell or code check asks where a value appears in code. */
export function searchFor(query: string, options: SearchOptions = {}) {
	setRequest({ query, ...options });
	showPanel("search");
}

// What was searched for, how, and what was found: kept while the panel is away, with the replacement and the file
// patterns, so that coming back to it is coming back to the same search.
const [typed, setTyped] = createSignal("");
const [hits, setHits] = createSignal<SearchHit[]>([]);
/**
 * For each file with a hit, the mark of its text as it was searched (`textMark`). A replace is made in a file
 * only while its text still has that mark: the hits are places in the text that was searched, and so are the
 * rows that were dismissed.
 */
const [marks, setMarks] = createSignal<Record<string, string>>({});
const [regex, setRegex] = createSignal(false);
const [caseSensitive, setCaseSensitive] = createSignal(false);
const [wholeWord, setWholeWord] = createSignal(false);
/** Where the panel stands: nothing asked yet, searching, the last search answered or failed. */
const [status, setStatus] = createSignal<"idle" | "busy" | "done" | "failed">("idle");
const [asked, setAsked] = createSignal("");
const [effectiveAsked, setEffectiveAsked] = createSignal("");
/** The switches and the files the results on screen were found with: a replace uses these, not what has been changed since. */
const [searched, setSearched] = createSignal<SearchOptions & { syntheticQuery?: boolean; openEditorsOnly?: boolean }>({});
const [failure, setFailure] = createSignal("");
const [docFilterNote, setDocFilterNote] = createSignal("");
/** True when post-filters (`heading:` / `task:`) narrowed results to specific lines within files. */
const [lineFiltered, setLineFiltered] = createSignal(false);
/** True when backend/dirty search hit `SEARCH_LIMIT` before post-filtering or deduping. */
const [truncated, setTruncated] = createSignal(false);
/** True when the backend's scan ran out of time: what is listed is only what was found in the files it got to. */
const [timedOut, setTimedOut] = createSignal(false);
/** Active ticket key when scoped to an active ticket via explicit `paths` allowlist. */
const [ticketScopeKey, setTicketScopeKey] = createSignal<string | null>(null);
/** Re-entrancy guard for Replace All and Replace Preview flows. */
const [replaceActive, setReplaceActive] = createSignal(false);
let replaceBusy = false;
/** Per-file and per-line exclusions dismissed from the current result set before Replace All. */
const [dismissedFiles, setDismissedFiles] = createSignal<Set<string>>(new Set());
const [dismissedLines, setDismissedLines] = createSignal<Set<string>>(new Set());
/** Collapsed file and folder rows (`file:<path>`, `dir:<relDir>`) for the current search session. */
const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
/** Key (`path:line`) of the search result currently selected/navigated to. */
const [activeHitKey, setActiveHitKey] = createSignal<string | null>(null);
/** Optional single-file or single-line scope handed to `executeReplace` by inline row Replace buttons. */
let pendingReplaceTarget: { path: string; line?: number } | null = null;
/** Active debounce timer for live typing search, cleared on workspace switch, unmount, or explicit run. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function clearDebounce() {
	if (debounceTimer !== null) {
		clearTimeout(debounceTimer);
		debounceTimer = null;
	}
}
/** Document-level Markdown protected-span cache for open editors keyed by canonical path and model version. */
const openMdSpanCache = new Map<string, { version: number; spans: Map<number, TextSpan[]> }>();
let latest = 0;
let lastWorkspaceRoot: string | undefined;

/** Steps forward (F4) or backward (Shift+F4) through visible search results from anywhere in the IDE. */
export function stepSearchResult(dir: 1 | -1): boolean {
	const skipFiles = dismissedFiles();
	const skipLines = dismissedLines();
	const active = hits().filter((h) => {
		const canon = canonical(h.path);
		return !skipFiles.has(canon) && !skipLines.has(`${canon}:${h.line}`);
	});
	const lines = byLine(active);
	if (!lines.length) return false;
	let ordered: LineHit[];
	if (treeView()) {
		const byPath = new Map<string, LineHit[]>();
		for (const line of lines) {
			const arr = byPath.get(line.path);
			if (arr) arr.push(line);
			else byPath.set(line.path, [line]);
		}
		const root = state.workspace?.root;
		const fileGroups: SearchFileGroup[] = [...byPath].map(([path, fileLines]) => ({
			path,
			relPath: isUntitled(path) ? displayName(path) : relativeTo(root, path),
			lines: fileLines,
			matchCount: fileLines.reduce((n, l) => n + l.matches.length, 0),
		}));
		ordered = [];
		const walk = (nodes: readonly SearchTreeNode[]) => {
			for (const node of nodes) {
				if (node.kind === "folder") walk(node.children);
				else ordered.push(...node.file.lines);
			}
		};
		walk(buildSearchTree(fileGroups));
	} else {
		ordered = lines;
	}
	const keys = ordered.map((l) => `${l.path}:${l.line}`);
	const nextKey = stepResultKey(keys, activeHitKey(), dir);
	if (!nextKey) return false;
	const target = ordered.find((l) => `${l.path}:${l.line}` === nextKey);
	if (!target) return false;
	setActiveHitKey(nextKey);
	// Expand its file (and any ancestor folders in tree view) so the active row is visible in the panel.
	setCollapsed((prev) => {
		if (!prev.size) return prev;
		const next = new Set(prev);
		next.delete(`file:${target.path}`);
		const relPath = isUntitled(target.path) ? "" : relativeTo(state.workspace?.root, target.path).replace(/\\/g, "/");
		const parts = relPath.split("/").slice(0, -1);
		let acc = "";
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			next.delete(`dir:${acc}`);
		}
		return next;
	});
	const first = target.matches[0]!;
	void openFile(target.path, {
		preview: true,
		reveal: { line: target.line, column: first.column, endLine: target.line, endColumn: first.column + first.length },
	});
	return true;
}

/** Copies text to the clipboard using the app's native bridge with browser fallback. */
async function copyTextLocal(text: string, said: string) {
	const copied = (await backend.clipboard(text).catch(() => false)) || (await navigator.clipboard?.writeText(text).then(() => true, () => false));
	notify(copied ? said : `Could not reach the clipboard. It was: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`, copied ? "info" : "error");
}

/** Clears workspace-scoped Search state whenever the open workspace changes (A -> B). */
function resetSearchState() {
	clearDebounce();
	latest++;
	replaceBusy = false;
	pendingReplaceTarget = null;
	setReplaceActive(false);
	setHits([]);
	setMarks({});
	setStatus("idle");
	setAsked("");
	setEffectiveAsked("");
	setSearched({});
	setFailure("");
	setDocFilterNote("");
	setLineFiltered(false);
	setTruncated(false);
	setTimedOut(false);
	setDismissedFiles(new Set<string>());
	setDismissedLines(new Set<string>());
	setCollapsed(new Set<string>());
	setActiveHitKey(null);
	setTicketScopeKey(null);
	setOpenEditorsOnly(false);
	setUseExcludes(true);
	setInclude("");
	setExclude("");
	setChoosing(false);
	openMdSpanCache.clear();
}

// --- Search query history (persisted across reloads, up to 25 queries) -------
const HISTORY_KEY = "search.history";
const HISTORY_MAX = 25;
function loadHistory(): string[] {
	try {
		const parsed = JSON.parse(recall(HISTORY_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, HISTORY_MAX) : [];
	} catch {
		return [];
	}
}
const [queryHistory, setQueryHistory] = createSignal<string[]>(loadHistory());
function recordHistory(q: string) {
	const clean = q.trim();
	if (!clean) return;
	const next = [clean, ...queryHistory().filter((item) => item !== clean)].slice(0, HISTORY_MAX);
	setQueryHistory(next);
	remember(HISTORY_KEY, JSON.stringify(next));
}

// --- Expanded metadata search grammar ----------------------------------------

const normStatus = (s?: string) => (s ?? "").toLowerCase().replace(/[-_]+/g, " ").trim();

const GROUP_ALIASES: Record<string, string> = {
	spec: "specs",
	specs: "specs",
	ticket: "tickets",
	tickets: "tickets",
	plan: "plans",
	plans: "plans",
	registry: "registries",
	registries: "registries",
	schema: "schema",
	schemas: "schema",
	knowledge: "knowledge",
	doc: "docs",
	docs: "docs",
	project: "project",
};

const KIND_ALIASES: Record<string, string> = {
	decision: "decisions",
	decisions: "decisions",
	adr: "decisions",
	question: "questions",
	questions: "questions",
	snippet: "snippets",
	snippets: "snippets",
	database: "database",
	interface: "interfaces",
	interfaces: "interfaces",
	file: "files",
	files: "files",
};

const TASK_OPEN_RE = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)+\[ \]/;
const TASK_DONE_RE = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)+\[[xX]\]/;
const TASK_ANY_RE = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)+\[[ xX]\]/;

function docPropValues(doc: DocFile, key: string): string[] {
	switch (key) {
		case "owner":
			return doc.owner ? [doc.owner] : [];
		case "reviewer":
			return doc.reviewer ? [doc.reviewer] : [];
		case "release":
			return doc.release ? [doc.release] : [];
		case "priority":
			return doc.priority ? [doc.priority] : [];
		case "version":
			return doc.version ? [doc.version] : [];
		case "approved-by":
		case "approvedby":
			return doc.approvedBy ? [doc.approvedBy] : [];
		case "approved-date":
		case "approveddate":
			return doc.approvedDate ? [doc.approvedDate] : [];
		case "change-control":
		case "changecontrol":
			return doc.changeControl ? [doc.changeControl] : [];
		case "gxp-impact":
		case "gxpimpact":
			return doc.gxpImpact ? [doc.gxpImpact] : [];
		case "source":
			return doc.source ? [doc.source] : [];
		case "blocks":
			return doc.blocks ?? [];
		case "blocked-by":
		case "blockedby":
			return doc.blockedBy ?? [];
		case "supersedes":
			return doc.supersedes ?? [];
		case "superseded-by":
		case "supersededby":
			return doc.supersededBy ?? [];
		default:
			return [];
	}
}

function docMatchesMetadata(doc: DocFile, parsed: ParsedDocFilters): boolean {
	if (!doc.exists || isCatalog(doc)) return false;
	if (parsed.tags.length) {
		const dTags = (doc.tags ?? []).map((t) => t.toLowerCase());
		if (!parsed.tags.every((wanted) => dTags.includes(wanted.toLowerCase()))) return false;
	}
	if (parsed.statuses.length) {
		const dNorm = normStatus(doc.status);
		const dTone = toneOf(doc.status);
		if (!parsed.statuses.every((wanted) => dNorm === normStatus(wanted) || dTone === normStatus(wanted))) return false;
	}
	if (parsed.tickets.length) {
		const keys = new Set<string>(
			[
				doc.ticket,
				...(doc.tickets ?? []),
				doc.pairedPlan?.ticket,
				...(doc.forTickets?.map((t) => t.key) ?? []),
			]
				.filter((k): k is string => Boolean(k))
				.map((k) => k.toLowerCase()),
		);
		if (!parsed.tickets.every((wanted) => keys.has(wanted.toLowerCase()))) return false;
	}
	if (parsed.parents.length) {
		const p = (doc.parent ?? "").toLowerCase();
		if (!parsed.parents.every((wanted) => p === wanted.toLowerCase())) return false;
	}
	if (parsed.groups.length) {
		if (!parsed.groups.some((g) => (GROUP_ALIASES[g] ?? g) === doc.group.toLowerCase())) return false;
	}
	if (parsed.kinds.length) {
		const k = (doc.kind ?? "").toLowerCase();
		const g = doc.group.toLowerCase();
		if (!parsed.kinds.some((wanted) => {
			const norm = KIND_ALIASES[wanted] ?? wanted;
			return k === norm || (!k && (GROUP_ALIASES[wanted] ?? wanted) === g);
		})) return false;
	}
	if (parsed.props.length) {
		for (const { key, value } of parsed.props) {
			const vals = docPropValues(doc, key);
			const wanted = value.toLowerCase();
			if (!vals.some((v) => v.toLowerCase() === wanted || v.toLowerCase().includes(wanted))) return false;
		}
	}
	return true;
}

/** Reads a file's text from an open editor buffer when available, else from disk. */
async function currentTextFor(path: string): Promise<string> {
	const at = canonical(path);
	const open = documents.get(at);
	if (open && !open.binary) return open.model.getValue();
	return backend.read(path).then((r) => (r.binary ? "" : r.text), () => "");
}

/** Computes a `Row Key · Column` breadcrumb for a matched line/column inside a CSV/TSV file. */
function csvBreadcrumbForLine(text: string, lineNumber: number, matchCol: number): string {
	const table = parseCsv(text);
	if (!table.header.length) return "";
	// Compute 0-based char offset of each 1-based line start.
	const lineStarts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") lineStarts.push(i + 1);
	}
	const lineStart = lineStarts[lineNumber - 1];
	if (lineStart === undefined) return "";
	const offset = lineStart + Math.max(0, matchCol - 1);

	const colNameAt = (idx: number) => table.header[idx]?.text.trim() || `Col ${idx + 1}`;
	const colInCells = (cells: { start: number; end: number }[]) => {
		let best = 0;
		for (let c = 0; c < cells.length; c++) {
			const cell = cells[c]!;
			if (offset >= cell.start && offset <= cell.end) return c;
			if (cell.start <= offset) best = c;
		}
		return best;
	};

	const headStart = table.header[0]?.start ?? 0;
	const headEnd = table.header[table.header.length - 1]?.end ?? 0;
	if (offset >= headStart && offset <= headEnd) {
		return `Header · ${colNameAt(colInCells(table.header))}`;
	}

	for (let r = 0; r < table.rows.length; r++) {
		const row = table.rows[r]!;
		if (!row.length) continue;
		const rowStart = row[0]!.start;
		const rowEnd = row[row.length - 1]!.end;
		if (offset >= rowStart && offset <= rowEnd) {
			const rawKey = row[0]?.text.trim() || row.find((c) => c.text.trim())?.text.trim() || `Row ${r + 1}`;
			const rowKey = rawKey.length > 28 ? `${rawKey.slice(0, 27)}…` : rawKey;
			return `${rowKey} · ${colNameAt(colInCells(row))}`;
		}
	}
	return "";
}

// The project's folders as patterns, said as any folder to search in is (folderPattern): a folder's name is not a
// pattern, and one that opens with a dot keeps it. "" where the folder is the workspace's own.
const docsGlob = () => folderPattern(state.project?.docs ?? "docs");
const plansGlob = () => folderPattern(state.project?.plans ?? "design");
const schemaGlob = () => folderPattern(state.project?.schema ?? "schema");
/**
 * What a search leaves out to look in code only: the Code scope's own words. The other panels that search the code
 * (a document's "Find in code", a schema name's uses) ask for it here, so that the search they start is the Code
 * scope and its chip lights; each used to write the list for itself, and the lists had come apart.
 */
export const codeExcludeGlob = () =>
	[
		docsGlob() || `${DOC_FOLDERS.tickets}/**, ${DOC_FOLDERS.specs}/**, ${DOC_FOLDERS.knowledge}/**, ${DOC_FOLDERS.registries}/**`,
		plansGlob(),
		schemaGlob(),
		"README.md",
		"AGENTS.md",
		"**/INDEX.md",
	]
		.filter(Boolean)
		.join(", ");
const docsIncludeGlob = () =>
	[
		docsGlob() || `${DOC_FOLDERS.tickets}/**, ${DOC_FOLDERS.specs}/**, ${DOC_FOLDERS.knowledge}/**, ${DOC_FOLDERS.registries}/**`,
		plansGlob(),
		schemaGlob(),
		"*.md",
	]
		.filter(Boolean)
		.join(", ");
/** What a search looks in to look in the project's documents only, or every Markdown file where the documents are the workspace's own folder. */
export const docsFolderGlob = () => docsGlob() || "**/*.md";

export function Search() {
	let input!: HTMLInputElement;
	let historyIdx = -1;
	let historyDraft = "";

	const workspaceRoot = createMemo(() => state.workspace?.root ?? "");
	createEffect(
		() => workspaceRoot(),
		(currentRoot) => {
			if (lastWorkspaceRoot === undefined) {
				lastWorkspaceRoot = currentRoot;
				return;
			}
			if (currentRoot !== lastWorkspaceRoot) {
				lastWorkspaceRoot = currentRoot;
				resetSearchState();
			}
		},
	);

	const [workspaceFiles] = createAsyncQuery(
		() => (state.workspace?.root ? `${state.workspace.root}#${state.treeVersion}` : false),
		() => backend.files().catch(() => [] as string[]),
	);

	const scopeActive = (inc: string, exc = "") =>
		!ticketScopeKey() && !openEditorsOnly() && (choosing() ? include().trim() === inc && exclude().trim() === exc : !inc && !exc);
	const inCodeScope = () => scopeActive("", codeExcludeGlob());
	const inDocsScope = () => scopeActive(docsIncludeGlob(), "");

	const activeTicketScope = createMemo(() => {
		const root = state.workspace?.root;
		const allDocs = docs();
		const key = state.settings.activeTicket?.trim() || ticketForFile(allDocs, activePath(), root) || ticketAtHand();
		if (!key) return null;
		const found = allDocs.find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === key.toLowerCase());
		if (!found) return null;
		const descendants = descendantTickets(allDocs, key);
		const allWs = workspaceFiles() ?? [];
		const pathSet = new Set<string>();
		const addRel = (absPath: string) => {
			if (!root || !isInside(root, absPath)) return;
			const relPath = relativeTo(root, absPath).replace(/\\/g, "/");
			if (relPath) pathSet.add(relPath);
		};
		const addTicketTree = (ticketDoc: typeof found) => {
			addRel(ticketDoc.path);
			if (ticketDoc.ticketFolder) {
				for (const filePath of allWs) {
					if (isInside(ticketDoc.ticketFolder, filePath)) addRel(filePath);
				}
				for (const [docPath] of documents) {
					if (isInside(ticketDoc.ticketFolder, docPath)) addRel(docPath);
				}
			}
			const tKey = ticketDoc.ticket;
			if (!tKey) return;
			for (const group of ticketWork(allDocs, tKey)) {
				if (group.kind === "ticket") continue;
				for (const ref of group.files) addRel(ref.path);
			}
		};
		addTicketTree(found);
		for (const desc of descendants) addTicketTree(desc);
		// Resolve referenced scripts across the ticket & all descendant tickets against real workspace paths.
		const refs = scriptsForTicket(allDocs, key, { includeDescendants: true });
		let resolvedScripts = 0;
		if (refs.length) {
			for (const filePath of allWs) {
				if (refs.some((ref) => codeMatchesRef(filePath, ref, root))) {
					addRel(filePath);
					resolvedScripts++;
				}
			}
		}
		const extras = [
			descendants.length ? `${descendants.length} sub-${descendants.length === 1 ? "ticket" : "tickets"}` : "",
			resolvedScripts ? `${resolvedScripts} ${resolvedScripts === 1 ? "script" : "scripts"}` : "",
		].filter(Boolean);
		return {
			key,
			paths: [...pathSet],
			tip: `Search ${key}${extras.length ? ` (${extras.join(", ")})` : ""}, its folder, and all linked specs/plans/decisions`,
		};
	});

	onCleanup(clearDebounce);

	type RunOverrides = {
		query?: string;
		regex?: boolean;
		caseSensitive?: boolean;
		wholeWord?: boolean;
		choosing?: boolean;
		include?: string;
		exclude?: string;
		ticketScopeKey?: string | null;
		openEditorsOnly?: boolean;
		useExcludes?: boolean;
		record?: boolean;
	};

	const run = async (overrides: RunOverrides = {}) => {
		clearDebounce();
		const rawQuery = overrides.query ?? input.value;
		const prevAsked = asked();
		const mine = ++latest;
		const startRoot = state.workspace?.root;
		setDocFilterNote("");
		setLineFiltered(false);
		setTruncated(false);
		setTimedOut(false);
		setDismissedFiles(new Set<string>());
		setDismissedLines(new Set<string>());
		if (!rawQuery) {
			setHits([]);
			setAsked("");
			setEffectiveAsked("");
			setStatus("idle");
			setMarks({});
			setSearched({});
			setFailure("");
			setCollapsed(new Set<string>());
			setActiveHitKey(null);
			return;
		}
		if (rawQuery !== prevAsked) {
			setCollapsed(new Set<string>());
			setActiveHitKey(null);
		}
		if (overrides.record !== false) recordHistory(rawQuery);
		historyIdx = -1;
		setStatus("busy");
		setAsked(rawQuery);

		const curChoosing = overrides.choosing ?? choosing();
		const curInclude = overrides.include ?? include();
		const curExclude = overrides.exclude ?? exclude();
		const curTicketScopeKey = overrides.ticketScopeKey !== undefined ? overrides.ticketScopeKey : ticketScopeKey();
		const curOpenOnly = overrides.openEditorsOnly ?? openEditorsOnly();
		const curUseExcludes = overrides.useExcludes ?? useExcludes();
		const curRegex = overrides.regex ?? regex();
		const curCaseSensitive = overrides.caseSensitive ?? caseSensitive();
		const curWholeWord = overrides.wholeWord ?? wholeWord();

		const baseInclude = curChoosing ? curInclude : "";
		const baseExclude = curChoosing ? curExclude : "";
		const root = startRoot;
		const activeTicket = curTicketScopeKey && activeTicketScope()?.key === curTicketScopeKey ? activeTicketScope() : null;
		const isScopeActive = (inc: string, exc = "") =>
			!curTicketScopeKey && !curOpenOnly && (curChoosing ? curInclude.trim() === inc && curExclude.trim() === exc : !inc && !exc);
		const scopeKind: SearchScopeKind = isScopeActive("", codeExcludeGlob())
			? "code"
			: isScopeActive(docsIncludeGlob(), "")
				? "docs"
				: activeTicket
					? "ticket"
					: curOpenOnly || baseInclude.trim() || baseExclude.trim()
						? "custom"
						: "all";

		const preParsed = !curRegex && scopeKind !== "code" ? parseDocFilterTokens(rawQuery) : undefined;
		const customMatchedByPath = new Map<string, Record<string, string | string[]>>();
		const keysSeen = new Set<string>();

		if (preParsed?.customProps.length) {
			const mdDocs = docs().filter((d) => d.exists && !isCatalog(d) && /\.(md|markdown)$/i.test(d.path)).slice(0, 200);
			await Promise.all(
				mdDocs.map(async (d) => {
					const text = await currentTextFor(d.path);
					if (!text) return;
					const fm = frontMatter(text).values;
					if (Object.keys(fm).length) {
						customMatchedByPath.set(canonical(d.path), fm);
						for (const k of Object.keys(fm)) keysSeen.add(k.toLowerCase());
					}
				}),
			);
			if (mine !== latest || state.workspace?.root !== startRoot) return;
		}

		const resolved = resolveSearchQuery({
			rawQuery,
			regex: curRegex,
			caseSensitive: curCaseSensitive,
			wholeWord: curWholeWord,
			scope: scopeKind,
			knownCustomKeys: keysSeen,
			parsed: preParsed,
		});

		const { parsed, activeCustomProps, effectiveQuery, effectiveRegex, effectiveCase, effectiveWhole, syntheticQuery, hasDocMetaFilters, hasHeadingFilter, hasTaskFilter } = resolved;
		let effectiveInclude = baseInclude;
		let effectiveExclude = baseExclude;
		let effectivePaths: string[] | undefined = activeTicket ? activeTicket.paths : undefined;

		const filterNotes: string[] = [
			...parsed.tags.map((t) => `tag:${t}`),
			...parsed.statuses.map((s) => `status:${s}`),
			...parsed.tickets.map((t) => `ticket:${t}`),
			...parsed.parents.map((p) => `parent:${p}`),
			...parsed.groups.map((g) => `group:${g}`),
			...parsed.kinds.map((k) => `kind:${k}`),
			...parsed.props.map((p) => `${p.key}:${p.value}`),
			...activeCustomProps.map((p) => `${p.key}:${p.value}`),
			...parsed.headings.map((h) => `heading:${h}`),
			...parsed.tasks.map((t) => `task:${t}`),
		];

		let allowedDocSet: Set<string> | null = null;

		if (hasDocMetaFilters) {
			let matchedDocs = docs().filter((d) => docMatchesMetadata(d, parsed));
			if (activeCustomProps.length) {
				matchedDocs = matchedDocs.filter((d) => {
					const fm = customMatchedByPath.get(canonical(d.path));
					if (!fm) return false;
					return activeCustomProps.every(({ key, value }) => {
						const rawVal = fm[key];
						if (rawVal === undefined) return false;
						const wanted = value.toLowerCase();
						const list = many(rawVal);
						const joined = one(rawVal).toLowerCase();
						return joined === wanted || joined.includes(wanted) || list.some((item) => item.toLowerCase() === wanted || item.toLowerCase().includes(wanted));
					});
				});
			}
			if (hasHeadingFilter || hasTaskFilter) {
				matchedDocs = matchedDocs.filter((d) => /\.(md|markdown)$/i.test(d.path));
			}
			// Intersect with active ticket paths or include/exclude scope instead of overwriting them.
			if (effectivePaths !== undefined) {
				const ticketPathSet = new Set(effectivePaths.map((p) => p.replace(/\\/g, "/")));
				matchedDocs = matchedDocs.filter((d) => ticketPathSet.has(relativeTo(root, d.path).replace(/\\/g, "/")));
			}
			if (baseInclude.trim() || baseExclude.trim()) {
				const scopeFilter = createFileFilter(baseInclude, baseExclude);
				matchedDocs = matchedDocs.filter((d) => scopeFilter(relativeTo(root, d.path).replace(/\\/g, "/")));
			}
			setDocFilterNote(`${filterNotes.join(" ")} (${matchedDocs.length} ${matchedDocs.length === 1 ? "doc" : "docs"})`);
			if (!matchedDocs.length) {
				setHits([]);
				setMarks({});
				setTruncated(false);
				setSearched({ regex: effectiveRegex, caseSensitive: effectiveCase, wholeWord: effectiveWhole, ...(syntheticQuery ? { syntheticQuery: true } : {}), ...(curOpenOnly ? { openEditorsOnly: true } : {}) });
				setStatus("done");
				return;
			}
			allowedDocSet = new Set(matchedDocs.map((d) => canonical(d.path)));
			effectivePaths = matchedDocs.map((d) => relativeTo(root, d.path).replace(/\\/g, "/"));
			effectiveInclude = "";
			effectiveExclude = "";
		} else if (hasHeadingFilter || hasTaskFilter) {
			setDocFilterNote(filterNotes.join(" "));
			if (effectivePaths !== undefined) {
				effectivePaths = effectivePaths.filter((p) => /\.(md|markdown)$/i.test(p));
			} else if (!effectiveInclude.trim()) {
				effectiveInclude = "*.md, *.markdown";
			}
		}

		// Restrict to currently open editor tabs when VS Code's "Search only in Open Editors" toggle is active.
		const openTabSet = curOpenOnly ? new Set(state.groups.flatMap((g) => g.tabs).map(canonical)) : null;
		if (openTabSet) {
			const openFilter = createFileFilter(effectiveInclude, effectiveExclude);
			const openRelPaths: string[] = [];
			let hasOpenUntitled = false;
			for (const tabPath of openTabSet) {
				const doc = documents.get(tabPath);
				if (doc?.binary) continue;
				if (allowedDocSet && !allowedDocSet.has(tabPath)) continue;
				if (isUntitled(tabPath)) {
					if (!baseInclude.trim() && !hasDocMetaFilters && !hasHeadingFilter && !hasTaskFilter) hasOpenUntitled = true;
					continue;
				}
				if (root && isInside(root, tabPath)) {
					const relPath = relativeTo(root, tabPath).replace(/\\/g, "/");
					if (!openFilter(relPath)) continue;
					if ((hasHeadingFilter || hasTaskFilter) && !/\.(md|markdown)$/i.test(relPath)) continue;
					openRelPaths.push(relPath);
				}
			}
			if (effectivePaths !== undefined) {
				const openSet = new Set(openRelPaths);
				effectivePaths = effectivePaths.filter((p) => openSet.has(p.replace(/\\/g, "/")));
			} else {
				effectivePaths = openRelPaths;
			}
			effectiveInclude = "";
			effectiveExclude = "";
			if (!effectivePaths.length && !hasOpenUntitled) {
				setHits([]);
				setMarks({});
				setTruncated(false);
				setSearched({ regex: effectiveRegex, caseSensitive: effectiveCase, wholeWord: effectiveWhole, paths: [], ...(syntheticQuery ? { syntheticQuery: true } : {}), openEditorsOnly: true });
				setEffectiveAsked(effectiveQuery);
				setLineFiltered(hasHeadingFilter || hasTaskFilter);
				setStatus("done");
				return;
			}
		}

		const backendOptions: SearchOptions = {
			regex: effectiveRegex,
			caseSensitive: effectiveCase,
			wholeWord: effectiveWhole,
			...(effectiveInclude ? { include: effectiveInclude } : {}),
			...(effectiveExclude ? { exclude: effectiveExclude } : {}),
			...(effectivePaths !== undefined ? { paths: effectivePaths } : {}),
			...(curUseExcludes ? {} : { useExcludes: false }),
		};
		setSearched({ ...backendOptions, ...(syntheticQuery ? { syntheticQuery: true } : {}), ...(curOpenOnly ? { openEditorsOnly: true } : {}) });
		setEffectiveAsked(effectiveQuery);
		setLineFiltered(hasHeadingFilter || hasTaskFilter);

		try {
			// The open files with unsaved changes go with the search as they are in the editor, so that freshly edited
			// text is searched and not what is on disk of it. The backend searches them, in place of the files of their
			// names: the expression is not run here (see `replaceInModel`).
			const open: OpenText[] = [];
			const dirtyFilter = createFileFilter(effectiveInclude, effectiveExclude);
			const pathAllowSet = effectivePaths !== undefined ? new Set(effectivePaths.map((p) => p.replace(/\\/g, "/"))) : null;
			for (const [docPath, doc] of documents) {
				const at = canonical(docPath);
				if ((!state.dirty[at] && !(openTabSet && isUntitled(at) && openTabSet.has(at))) || doc.binary) continue;
				if (allowedDocSet && !allowedDocSet.has(at)) continue;
				if (openTabSet && !openTabSet.has(at)) continue;
				if (isUntitled(at)) {
					if (openTabSet ? Boolean(baseInclude.trim()) || hasDocMetaFilters || hasHeadingFilter || hasTaskFilter : Boolean(effectiveInclude.trim()) || pathAllowSet !== null) continue;
				} else if (root && isInside(root, at)) {
					const relPath = relativeTo(root, at).replace(/\\/g, "/");
					if (pathAllowSet !== null && !pathAllowSet.has(relPath)) continue;
					if (!dirtyFilter(relPath)) continue;
				} else {
					continue;
				}
				open.push({ path: docPath, text: doc.model.getValue() });
			}

			let merged: SearchHit[] = [];
			let ranOutOfTime = false;
			const found: Record<string, string> = {};
			// One call, but for more unsaved text than a call carries: the rest follows in calls that read no file
			// (`paths: []`), one after another and none once the time has run out.
			for (const [index, batch] of openBatches(open).entries()) {
				// Asked for with whether the scan was cut short: a scan that ran out of time gives only some of what is there.
				const scan = await backend.searchScan(effectiveQuery, index ? { ...backendOptions, paths: [] } : backendOptions, batch);
				if (mine !== latest || state.workspace?.root !== startRoot) return;
				merged = merged.concat(scan.hits);
				Object.assign(found, scan.marks);
				ranOutOfTime = scan.timedOut;
				if (ranOutOfTime) break;
			}
			const wasTruncated = merged.length >= SEARCH_LIMIT;

			// Enforce heading:/task: line-level constraints (only Markdown files & matching heading/task lines).
			if (hasHeadingFilter || hasTaskFilter) {
				const fullLinesCache = new Map<string, string[]>();
				const filtered: SearchHit[] = [];
				for (const h of merged) {
					if (!/\.(md|markdown)$/i.test(h.path)) continue;
					let lineText = h.text;
					if (h.textOffset) {
						const canon = canonical(h.path);
						let lines = fullLinesCache.get(canon);
						if (!lines) {
							const docText = await currentTextFor(h.path);
							if (mine !== latest || state.workspace?.root !== startRoot) return;
							lines = docText.split(/\r?\n/);
							fullLinesCache.set(canon, lines);
						}
						lineText = lines[h.line - 1] ?? h.text;
					}
					if (hasHeadingFilter) {
						const m = HEADING.exec(lineText);
						if (!m) continue;
						const headingPlain = plainMarkdown(m[2]!).toLowerCase();
						if (!parsed.headings.every((wanted) => wanted === "*" || headingPlain.includes(wanted.toLowerCase()))) continue;
					}
					if (hasTaskFilter) {
						const matchesTask = parsed.tasks.every((mode) =>
							mode === "open" ? TASK_OPEN_RE.test(lineText) : mode === "done" ? TASK_DONE_RE.test(lineText) : TASK_ANY_RE.test(lineText),
						);
						if (!matchesTask) continue;
					}
					filtered.push(h);
				}
				merged = filtered;
			}

			if (merged.length > SEARCH_LIMIT) merged = merged.slice(0, SEARCH_LIMIT);
			setTruncated(wasTruncated);
			setTimedOut(ranOutOfTime);
			setMarks(found);
			setHits(merged);
			setStatus("done");
		} catch (e: any) {
			if (mine !== latest || state.workspace?.root !== startRoot) return;
			setHits([]);
			setTruncated(false);
			setTimedOut(false);
			setFailure(String(e?.message ?? e));
			setStatus("failed");
		}
	};

	const scheduleSearch = (overrides: RunOverrides = {}, delayMs?: number) => {
		clearDebounce();
		const q = overrides.query ?? (input ? input.value : typed());
		if (!q) {
			void run({ ...overrides, query: "", record: false });
			return;
		}
		const wait = delayMs ?? (regex() ? 320 : 210);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void run({ ...overrides, record: false });
		}, wait);
	};

	const clearSearch = () => {
		setTyped("");
		if (input) input.value = "";
		void run({ query: "", record: false });
		input?.focus();
	};

	// Focus & select query box when invoked via Ctrl+Shift+F / Replace in files without a selection seed.
	createEffect(
		() => focusTick(),
		(tick) => {
			if (!tick || !input) return;
			queueMicrotask(() => {
				if (!input.isConnected) return;
				input.focus();
				input.select();
			});
		},
	);

	// A search asked for from elsewhere is put in the box and run, as if it had been typed.
	createEffect(
		() => request(),
		(wanted) => {
			if (!wanted || !input) return;
			setRequest(null);
			input.value = wanted.query;
			setTyped(wanted.query);
			queueMicrotask(() => {
				if (!input.isConnected) return;
				input.focus();
				input.select();
			});
			if (wanted.preserveScope) {
				void run({ query: wanted.query });
				return;
			}
			const nextRegex = Boolean(wanted.regex);
			const nextWhole = Boolean(wanted.wholeWord);
			const nextCase = Boolean(wanted.caseSensitive);
			const nextInc = wanted.include ?? "";
			const nextExc = wanted.exclude ?? "";
			const nextChoosing = Boolean(nextInc.trim() || nextExc.trim());
			setRegex(nextRegex);
			setWholeWord(nextWhole);
			setCaseSensitive(nextCase);
			setTicketScopeKey(null);
			setOpenEditorsOnly(false);
			setInclude(nextInc);
			setExclude(nextExc);
			setChoosing(nextChoosing);
			void run({
				query: wanted.query,
				regex: nextRegex,
				wholeWord: nextWhole,
				caseSensitive: nextCase,
				include: nextInc,
				exclude: nextExc,
				choosing: nextChoosing,
				ticketScopeKey: null,
				openEditorsOnly: false,
			});
		},
	);
	// A switch changes what the results on screen mean, so they are fetched again.
	const flip = (kind: "caseSensitive" | "wholeWord" | "regex", set: (v: boolean) => void, now: boolean) => {
		const next = !now;
		set(next);
		if (typed()) void run({ [kind]: next });
	};

	const visibleHits = createMemo(() => {
		const skipFiles = dismissedFiles();
		const skipLines = dismissedLines();
		if (!skipFiles.size && !skipLines.size) return hits();
		return hits().filter((h) => {
			const canon = canonical(h.path);
			return !skipFiles.has(canon) && !skipLines.has(`${canon}:${h.line}`);
		});
	});

	const dismissedHitCount = createMemo(() => Math.max(0, hits().length - visibleHits().length));

	const dismissFile = (path: string) =>
		setDismissedFiles((prev) => {
			const next = new Set(prev);
			next.add(canonical(path));
			return next;
		});

	const dismissFiles = (paths: readonly string[]) =>
		setDismissedFiles((prev) => {
			const next = new Set(prev);
			for (const path of paths) next.add(canonical(path));
			return next;
		});

	const dismissLine = (path: string, line: number) =>
		setDismissedLines((prev) => {
			const next = new Set(prev);
			next.add(`${canonical(path)}:${line}`);
			return next;
		});

	const restoreDismissed = () => {
		setDismissedFiles(new Set<string>());
		setDismissedLines(new Set<string>());
	};

	const rel = (path: string) => (isUntitled(path) ? displayName(path) : relativeTo(state.workspace?.root, path));
	const matchesIn = (list: LineHit[]) => list.reduce((n, line) => n + line.matches.length, 0);

	const groups = createMemo(() => {
		const map = new Map<string, LineHit[]>();
		for (const line of byLine(visibleHits())) map.set(line.path, [...(map.get(line.path) ?? []), line]);
		return [...map];
	});

	const fileGroups = createMemo<SearchFileGroup[]>(() =>
		groups().map(([path, lines]) => ({
			path,
			relPath: rel(path),
			lines,
			matchCount: matchesIn(lines),
		})),
	);

	const searchTree = createMemo<SearchTreeNode[]>(() => (treeView() ? buildSearchTree(fileGroups()) : []));

	const isCollapsed = (key: string) => collapsed().has(key);
	const toggleCollapsed = (key: string) =>
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	const allCollapsibleKeys = createMemo(() => {
		const fileKeys = groups().map(([path]) => `file:${path}`);
		return treeView() ? [...collectTreeFolderKeys(searchTree()), ...fileKeys] : fileKeys;
	});

	const allCollapsed = createMemo(() => {
		const keys = allCollapsibleKeys();
		if (!keys.length) return false;
		const shut = collapsed();
		return keys.every((k) => shut.has(k));
	});

	const toggleCollapseAll = () => {
		const keys = allCollapsibleKeys();
		if (!keys.length) return;
		setCollapsed(allCollapsed() ? new Set<string>() : new Set(keys));
	};

	const toggleViewMode = () => {
		const next = !treeView();
		setTreeView(next);
		remember(VIEW_MODE_KEY, next ? "tree" : "list");
	};

	// Where each line sits: SSL region › procedure (from starlims-lsp via ephemeral scratchSymbols),
	// Markdown # Heading (from shared/outline), or CSV/TSV Row Key · Column (from shared/csv).
	// Keyed on raw `hits()` so dismissing rows never re-reads files, and cleans up on unmount.
	let placesSeq = 0;
	onCleanup(() => placesSeq++);
	const [places] = createAsyncQuery(
		() => ({ root: state.workspace?.root ?? "", hits: hits() }),
		async ({ root: startRoot, hits: rawHits }) => {
			const mine = ++placesSeq;
			const out = new Map<string, string>();
			if (!rawHits.length) return out;
			const list = new Map<string, LineHit[]>();
			for (const line of byLine(rawHits)) {
				const arr = list.get(line.path);
				if (arr) arr.push(line);
				else list.set(line.path, [line]);
			}
			let sslChecked = 0;
			for (const [path, lines] of list) {
				if (mine !== placesSeq || (state.workspace?.root ?? "") !== startRoot) return out;
				if (/\.(md|markdown)$/i.test(path)) {
					const text = await currentTextFor(path);
					if (!text || mine !== placesSeq || (state.workspace?.root ?? "") !== startRoot) continue;
					const mdSymbols = outline("markdown", text);
					for (const line of lines) {
						const trail: string[] = [];
						const walk = (nodes: typeof mdSymbols) => {
							for (const n of nodes) {
								if (line.line >= n.line && line.line <= n.endLine) {
									trail.push(n.name);
									if (n.children?.length) walk(n.children);
									break;
								}
							}
						};
						walk(mdSymbols);
						const label = formatPlaceTrail(trail, { dropRootTitle: true });
						if (label) out.set(`${path}:${line.line}`, label);
					}
					continue;
				}
				if (/\.(csv|tsv)$/i.test(path)) {
					const text = await currentTextFor(path);
					if (!text || mine !== placesSeq || (state.workspace?.root ?? "") !== startRoot) continue;
					for (const line of lines) {
						const crumb = csvBreadcrumbForLine(text, line.line, line.matches[0]?.column ?? 1);
						if (crumb) out.set(`${path}:${line.line}`, crumb);
					}
					continue;
				}
				if (/\.plan\.json$/i.test(path)) {
					const text = await currentTextFor(path);
					if (!text || mine !== placesSeq || (state.workspace?.root ?? "") !== startRoot) continue;
					const parsed = parsePlan(text);
					if (!parsed.plan) continue;
					const nLines = nodeLines(text, parsed.plan);
					const groupById = new Map(parsed.plan.groups.map((g) => [g.id, g.name]));
					const nodeById = new Map(parsed.plan.nodes.map((n) => [n.id, n]));
					const lineToNodeId = new Map<number, string>();
					for (const [id, ln] of nLines) lineToNodeId.set(ln, id);
					for (const line of lines) {
						const directId = lineToNodeId.get(line.line);
						if (directId) {
							const n = nodeById.get(directId);
							if (n) {
								const stage = n.group ? groupById.get(n.group) : undefined;
								const kindLabel =
									n.kind === "decision" ? "Decision" : n.kind === "call" ? "Call" : n.kind === "start" ? "Start" : n.kind === "end" ? "End" : "Step";
								const cleanTxt = n.text.replace(/\s+/g, " ").trim() || directId;
								const shortTxt = cleanTxt.length > 38 ? `${cleanTxt.slice(0, 37)}…` : cleanTxt;
								out.set(`${path}:${line.line}`, `${stage || kindLabel} › ${shortTxt}`);
								continue;
							}
						}
						const crumb = planLineBreadcrumb(text, line.line);
						if (crumb) out.set(`${path}:${line.line}`, crumb);
					}
					continue;
				}
				if (!/\.(ssl|srvscr|ds)$/i.test(path) || sslChecked >= 60) continue;
				sslChecked++;
				const text = await currentTextFor(path);
				if (!text || mine !== placesSeq || (state.workspace?.root ?? "") !== startRoot) continue;
				const symbols = await session.scratchSymbols(text).catch(() => []);
				if (mine !== placesSeq || (state.workspace?.root ?? "") !== startRoot) return out;
				for (const line of lines) {
					out.set(
						`${path}:${line.line}`,
						symbolPath(symbols, line.line)
							.filter((s) => s.kind === monaco.languages.SymbolKind.Namespace || s.kind === monaco.languages.SymbolKind.Function || s.kind === monaco.languages.SymbolKind.Method)
							.map((s) => s.name)
							.join(" › "),
					);
				}
			}
			return out;
		},
	);
	const place = (line: LineHit) => places()?.get(`${line.path}:${line.line}`) ?? "";
	const byPlace = (list: LineHit[]) => {
		const map = new Map<string, LineHit[]>();
		for (const line of list) map.set(place(line), [...(map.get(place(line)) ?? []), line]);
		return [...map];
	};
	/** The switches that narrow a search, by the names on their buttons: what to try without when nothing is found. */
	const switchesOn = () => [caseSensitive() ? "Aa" : "", wholeWord() ? "ab" : "", regex() ? ".*" : ""].filter(Boolean);
	const narrowed = () => Boolean(searched().include?.trim() || searched().exclude?.trim() || searched().paths !== undefined || searched().openEditorsOnly);

	const topTags = createMemo(() => workspaceTags(docs()).slice(0, 4));
	/** Distinct statuses actually present across workspace docs (with sensible fallback if none exist yet). */
	const workspaceStatuses = createMemo(() => {
		const counts = new Map<string, { label: string; count: number }>();
		for (const d of docs()) {
			if (!d.exists || isCatalog(d) || !d.status?.trim()) continue;
			const raw = d.status.trim();
			const norm = normStatus(raw);
			const existing = counts.get(norm);
			if (existing) existing.count++;
			else counts.set(norm, { label: raw, count: 1 });
		}
		const list = [...counts.values()]
			.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
			.slice(0, 8);
		if (list.length) return list;
		return ["open", "in progress", "draft", "done"].map((label) => ({ label, count: 0 }));
	});

	const formatToken = (key: string, val: string) => (/\s/.test(val) ? `${key}:"${val}"` : `${key}:${val}`);
	const toggleQueryToken = (token: string) => {
		const cur = input ? input.value : typed();
		const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(`(?:^|\\s)${esc}(?=\\s|$)`, "i");
		const next = re.test(cur) ? cur.replace(re, " ").replace(/\s+/g, " ").trim() : `${token}${cur.trim() ? ` ${cur.trim()}` : ""}`;
		if (input) input.value = next;
		setTyped(next);
		void run({ query: next });
	};
	const hasQueryToken = (token: string) => {
		const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(?:^|\\s)${esc}(?=\\s|$)`, "i").test(typed());
	};
	const showDocChips = () =>
		!inCodeScope() &&
		(inDocsScope() ||
			Boolean(docFilterNote()) ||
			/\b(?:tag|status|ticket|parent|group|kind|heading|task):/i.test(typed()));

	const applyScope = (inc: string, exc = "") => {
		const nextChoosing = Boolean(inc || exc);
		setTicketScopeKey(null);
		setOpenEditorsOnly(false);
		setInclude(inc);
		setExclude(exc);
		setChoosing(nextChoosing);
		if (typed()) void run({ ticketScopeKey: null, openEditorsOnly: false, include: inc, exclude: exc, choosing: nextChoosing });
	};

	const applyTicketScope = (key: string) => {
		setTicketScopeKey(key);
		setOpenEditorsOnly(false);
		setInclude("");
		setExclude("");
		setChoosing(false);
		if (typed()) void run({ ticketScopeKey: key, openEditorsOnly: false, include: "", exclude: "", choosing: false });
	};

	const toggleOpenEditorsOnly = () => {
		const next = !openEditorsOnly();
		setOpenEditorsOnly(next);
		if (next) setTicketScopeKey(null);
		if (typed()) void run({ openEditorsOnly: next, ...(next ? { ticketScopeKey: null } : {}) });
	};

	const toggleUseExcludes = () => {
		const next = !useExcludes();
		setUseExcludes(next);
		if (typed()) void run({ useExcludes: next });
	};

	const toggleDetails = () => {
		const nextChoosing = !choosing();
		setChoosing(nextChoosing);
		// Patterns that were narrowing the results stop when their boxes go, and start when they come back.
		if (typed() && (include().trim() || exclude().trim())) void run({ choosing: nextChoosing });
	};

	const activeScopeChip = createMemo<{ label: string; title: string; clear: () => void } | null>(() => {
		const ticket = ticketScopeKey();
		if (ticket) {
			return {
				label: ticket,
				title: `Scoped to ${ticket}. Click to search all workspace files.`,
				clear: () => applyScope("", ""),
			};
		}
		if (inCodeScope()) {
			return {
				label: "Code",
				title: "Scoped to code files only. Click to search all workspace files.",
				clear: () => applyScope("", ""),
			};
		}
		if (inDocsScope()) {
			return {
				label: "Docs",
				title: "Scoped to project docs, plans, and schema. Click to search all workspace files.",
				clear: () => applyScope("", ""),
			};
		}
		return null;
	});

	const hasCustomFilter = () => Boolean(activeScopeChip()) || openEditorsOnly() || !useExcludes() || !safeDocs();

	const clearAllFilters = () => {
		setTicketScopeKey(null);
		setOpenEditorsOnly(false);
		setInclude("");
		setExclude("");
		setChoosing(false);
		setCaseSensitive(false);
		setWholeWord(false);
		setRegex(false);
		if (typed()) {
			void run({
				ticketScopeKey: null,
				openEditorsOnly: false,
				include: "",
				exclude: "",
				choosing: false,
				caseSensitive: false,
				wholeWord: false,
				regex: false,
			});
		}
	};

	// --- replacing -------------------------------------------------------------

	/** The matches a replace would make, file by file: what is listed and not dismissed. */
	const listedBy = createMemo(() => hitsByPath(visibleHits()));
	/** Where the groups of a regular expression's match lie, by the match's file, line and column: for what it would become. */
	const groupsAt = createMemo(() => {
		const map = new Map<string, SearchHit>();
		for (const hit of hits()) if (hit.groups || hit.named) map.set(`${hit.path}\n${hit.line}\n${hit.column}`, hit);
		return map;
	});

	// Document-level Safe Docs cache for Markdown protected spans & .plan.json validation during Replace preview.
	let safeCacheSeq = 0;
	onCleanup(() => safeCacheSeq++);
	const [safeDocInfo] = createAsyncQuery(
		() => {
			if (!replacing() || !safeDocs() || searched().syntheticQuery) return null;
			const list = hits();
			if (!list.length) return null;
			const uniquePaths: string[] = [];
			const seen = new Set<string>();
			for (const h of list) {
				if (!/\.(md|markdown)$/i.test(h.path) && !/\.plan\.json$/i.test(h.path)) continue;
				const canon = canonical(h.path);
				if (seen.has(canon)) continue;
				seen.add(canon);
				uniquePaths.push(h.path);
			}
			if (!uniquePaths.length) return null;
			return { root: state.workspace?.root ?? "", paths: uniquePaths };
		},
		async (req) => {
			const mine = ++safeCacheSeq;
			const mdSpans = new Map<string, Map<number, TextSpan[]>>();
			const planTexts = new Map<string, string>();
			for (const path of req.paths) {
				if (mine !== safeCacheSeq || (state.workspace?.root ?? "") !== req.root) return { mdSpans, planTexts };
				const canon = canonical(path);
				const text = await currentTextFor(path);
				if (mine !== safeCacheSeq || (state.workspace?.root ?? "") !== req.root) return { mdSpans, planTexts };
				if (!text) continue;
				if (/\.(md|markdown)$/i.test(path)) mdSpans.set(canon, protectedMarkdownSpans(text));
				else if (/\.plan\.json$/i.test(path)) planTexts.set(canon, text);
			}
			return { mdSpans, planTexts };
		},
	);

	const markdownSpansFor = (path: string): Map<number, TextSpan[]> | undefined => {
		const canon = canonical(path);
		const open = documents.get(canon);
		if (open && !open.binary) {
			const version = open.model.getVersionId();
			const cached = openMdSpanCache.get(canon);
			if (cached && cached.version === version) return cached.spans;
			const spans = protectedMarkdownSpans(open.model.getValue());
			openMdSpanCache.set(canon, { version, spans });
			return spans;
		}
		return safeDocInfo()?.mdSpans.get(canon);
	};

	const allowedLinesFor = (path: string, fileLines: readonly LineHit[]): ReadonlySet<number> | undefined => {
		const at = canonical(path);
		const skipLines = dismissedLines();
		const hasPartialLines = lineFiltered() || [...skipLines].some((k) => k.startsWith(`${at}:`));
		return hasPartialLines ? new Set(fileLines.map((l) => l.line)) : undefined;
	};

	const invalidPlanPaths = createMemo(() => {
		const bad = new Set<string>();
		if (!replacing() || !safeDocs() || searched().syntheticQuery) return bad;
		const info = safeDocInfo();
		for (const [path] of groups()) {
			if (!/\.plan\.json$/i.test(path)) continue;
			const canon = canonical(path);
			const open = documents.get(canon);
			const text = open && !open.binary ? open.model.getValue() : info?.planTexts.get(canon);
			if (!text) continue;
			// A plan changed since the search says nothing here: the replace itself leaves it as it is.
			if (replaceGuarded(path, text, marks()[path], listedBy().get(path), replacement(), Boolean(searched().regex), true, 0)?.invalidJson) bad.add(canon);
		}
		return bad;
	});

	/** What each marked match of a line would become, by the column it starts at (using document-level Safe Docs spans). */
	const becomes = (line: LineHit) => {
		if (searched().syntheticQuery) return new Map<number, string>();
		const canon = canonical(line.path);
		if (safeDocs() && /\.plan\.json$/i.test(line.path) && invalidPlanPaths().has(canon)) {
			return new Map<number, string>();
		}
		let lineSpans: TextSpan[] | undefined;
		if (safeDocs() && /\.(md|markdown)$/i.test(line.path)) {
			const docSpans = markdownSpansFor(line.path);
			if (!docSpans && safeDocInfo.loading) return new Map<number, string>();
			lineSpans = docSpans?.get(line.line);
		}
		const entries: [number, string][] = [];
		const isRegex = Boolean(searched().regex);
		const keepCase = preserveCase();
		const where = isRegex ? groupsAt() : null;
		for (const match of line.matches) {
			if (overlapsProtectedSpan(match.column, match.length, lineSpans)) continue;
			// From where the search found the match and its groups: the expression is not run again here.
			const text = becomesFound(line.text, line.textOffset ?? 0, where?.get(`${line.path}\n${line.line}\n${match.column}`) ?? match, replacement(), isRegex);
			if (text !== undefined) {
				const off = line.textOffset ?? 0;
				const start = match.column - 1 - off;
				const out = keepCase && start >= 0 && start + match.length <= line.text.length ? applyPreserveCase(line.text.slice(start, start + match.length), text) : text;
				entries.push([match.column, out]);
			}
		}
		return new Map(entries);
	};
	/** How the list on screen falls short of all there is to find, when it does: the summary says so and a replace is refused. */
	const shortfall = () => searchShortfall({ hits: hits().length, limit: SEARCH_LIMIT, truncated: truncated(), timedOut: timedOut() });
	/** Why "Replace all" cannot be pressed now; "" when it can. */
	const noReplace = (ignoreReplaceActive = false) => {
		if (status() === "busy" || (!ignoreReplaceActive && replaceActive())) return "The search is still running";
		if (searched().syntheticQuery) return "Enter search text to replace — filter-only queries cannot replace";
		if (status() !== "done" || !visibleHits().length) return "Search for something first: what is found is what is replaced";
		// What is replaced is the text that was searched. With another text typed in the box since, and Enter not
		// pressed, that is no longer the text on screen: nothing is replaced until the box and the list agree again.
		const moved = searchBoxMoved(asked(), typed());
		if (moved) return moved;
		// A list cut short by the match limit or by the scan's time budget is not all there is to replace.
		return shortfallBlocksReplace(shortfall(), SEARCH_LIMIT);
	};
	const executeReplace = async (skipConfirm: boolean) => {
		const target = pendingReplaceTarget;
		pendingReplaceTarget = null;
		if (replaceBusy || noReplace(true)) return;
		const startRoot = state.workspace?.root;
		const startSearchId = latest;
		// What the box held when the list was found: the search made again after the replace is that one.
		const searchedFor = asked();
		const query = effectiveAsked() || searchedFor;
		const options = searched();
		const with_ = replacement();
		const rawGroups = groups();
		const activeGroups = target
			? rawGroups
					.filter(([p]) => p === target.path)
					.map(([p, lines]) => [p, target.line !== undefined ? lines.filter((l) => l.line === target.line) : lines] as [string, LineHit[]])
					.filter(([, lines]) => lines.length > 0)
			: rawGroups;
		if (!activeGroups.length) return;
		const paths = activeGroups.map(([path]) => path);
		const total = target ? activeGroups.reduce((n, [, lines]) => n + matchesIn(lines), 0) : visibleHits().length;
		const protect = safeDocs();
		const keepCase = preserveCase();
		// What was listed and the texts it was found in, as they are now: asked for again after a wait, they could be another search's.
		const listed = target?.line !== undefined
			? hitsByPath(visibleHits().filter((h) => h.path === target.path && h.line === target.line))
			: listedBy();
		const searchedAs = marks();

		replaceBusy = true;
		setReplaceActive(true);
		let handoffToPreview = false;
		let ranReplace = false;
		replaceBody: try {
			if (!skipConfirm) {
				// The question names what is replaced: the text that was searched, with the switches it was searched with.
				const prompt = replaceQuestion({ query, regex: options.regex, caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, replacement: with_, matches: total, files: paths.length, safeDocs: protect });
				if (paths.length > 1) {
					const REPLACE = "Replace all";
					const PREVIEW = "Preview changes…";
					const answer = await choose(prompt, [REPLACE, PREVIEW]);
					if (state.workspace?.root !== startRoot || latest !== startSearchId) return;
					if (answer === PREVIEW) {
						handoffToPreview = true;
						break replaceBody;
					}
					if (answer !== REPLACE) return;
				} else {
					const answer = await choose(prompt, ["Replace"]);
					if (state.workspace?.root !== startRoot || latest !== startSearchId) return;
					if (answer !== "Replace") return;
				}
			}

			ranReplace = true;
			setStatus("busy");
			let done = 0;
			let files = 0;
			let skippedProtected = 0;
			const unsaved: string[] = [];
			const skippedJson: string[] = [];
			const failed: string[] = [];
			/** The files left as they are because their text is no longer the one that was searched. */
			const changed: string[] = [];
			const onDiskPaths: string[] = [];
			const linesByPath: Record<string, number[]> = {};
			const asSearched: Record<string, string> = {};
			try {
				for (const [path, fileLines] of activeGroups) {
					if (state.workspace?.root !== startRoot) return;
					const at = canonical(path);
					const allowedLines = target?.line !== undefined ? new Set([target.line]) : allowedLinesFor(path, fileLines);
					const mark = searchedAs[path];

					const doc = documents.get(at);
					const tabbed = state.groups.some((group) => group.tabs.includes(at));
					if (!doc || doc.binary || (!tabbed && !state.dirty[at])) {
						// Route all closed-file replacements (including safeDocs and partial lines) through locked backend.replace.
						// It is given the mark of the text that was searched, and leaves a file that is no longer that text.
						onDiskPaths.push(path);
						if (allowedLines) linesByPath[path] = [...allowedLines];
						if (mark !== undefined) asSearched[path] = mark;
						continue;
					}

					// An open file is replaced in only while its text is the one that was searched: the matches listed, and
					// the rows dismissed, are places in that text. Typed into since, or changed on disk and loaded again,
					// it has other lines under those numbers: a dismissed match was replaced and the ones kept were left.
					const currentValue = doc.model.getValue();
					const version = doc.model.getVersionId();
					const sim = replaceGuarded(path, currentValue, mark, listed.get(path), with_, Boolean(options.regex), protect, 0);
					if (!sim) {
						changed.push(path);
						continue;
					}
					skippedProtected += sim.skippedProtected;
					if (sim.invalidJson) {
						skippedJson.push(baseName(path));
						continue;
					}
					if (!sim.count) continue;
					const wasUnsaved = Boolean(state.dirty[at]);
					if (!wasUnsaved) {
						// The file as it was goes into local history first, as the question said it would. Where that copy
						// could not be made the file is left and said so: the replace went on without it, and was then saved.
						const notKept = await backend.historyKeep(at).then(
							() => "",
							(e: any) => String(e?.message ?? e),
						);
						if (state.workspace?.root !== startRoot) return;
						if (notKept) {
							failed.push(`${baseName(path)}: its copy for local history was not made (${notKept})`);
							continue;
						}
						// Typed into, or closed, while its copy for local history was made: the edits are for the text before that.
						if (doc.model.isDisposed() || doc.model.getVersionId() !== version) {
							changed.push(path);
							continue;
						}
					}
					const replaced = replaceInModel(doc.model, sim.edits);
					if (!replaced) continue;
					done += replaced;
					files++;
					if (wasUnsaved) unsaved.push(path);
					else {
						const saved = await save(at, { format: false });
						if (state.workspace?.root !== startRoot) return;
						if (!saved) failed.push(`${baseName(path)}: it is changed in the editor, and could not be saved`);
					}
				}
				if (onDiskPaths.length) {
					const replaceOptions: SearchOptions = {
						regex: options.regex,
						caseSensitive: options.caseSensitive,
						wholeWord: options.wholeWord,
						safeDocs: protect,
						asSearched,
						...(keepCase ? { preserveCase: true } : {}),
						...(Object.keys(linesByPath).length ? { linesByPath } : {}),
					};
					const results = await backend.replace(query, with_, replaceOptions, onDiskPaths);
					if (state.workspace?.root !== startRoot) return;
					for (const result of results) {
						if (result.changed) {
							changed.push(result.path);
							continue;
						}
						if (result.skippedProtected) skippedProtected += result.skippedProtected;
						if (result.invalidJson) {
							skippedJson.push(baseName(result.path));
							continue;
						}
						if (result.error) failed.push(`${baseName(result.path)}: ${result.error}`);
						if (!result.count) continue;
						done += result.count;
						files++;
						await fileChangedOnDisk(result.path);
						if (state.workspace?.root !== startRoot) return;
					}
				}
			} catch (e: any) {
				if (state.workspace?.root !== startRoot) return;
				failed.push(String(e?.message ?? e));
			}
			if (state.workspace?.root !== startRoot) return;
			setState((s) => {
				s.treeVersion += 1;
			});
			const protectedNote = skippedProtected
				? ` (${count(skippedProtected, "protected doc match", "protected doc matches")} skipped by Safe docs)`
				: "";
			const differs = done !== total && !failed.length && !skippedProtected && !skippedJson.length && !changed.length
				? ` ${count(total, "match", "matches")} were listed: a file has changed since the search.`
				: "";
			const note = `Replaced ${count(done, "match", "matches")} in ${count(files, "file")}.${protectedNote}${differs}`;
			if (unsaved.length) {
				notify(
					`${note} ${unsaved.length === 1 ? `${baseName(unsaved[0]!)} had unsaved changes: it is changed in the editor and not saved.` : `${unsaved.length} files had unsaved changes: they are changed in the editor and not saved.`}`,
					"info",
					{ label: "Save all", run: () => void saveAll() },
				);
			} else notify(note);
			if (skippedJson.length) {
				notify(`Skipped ${skippedJson.join(", ")}: replacement would break .plan.json JSON syntax.`, "error");
			}
			if (changed.length) notify(changedSinceSearch(changed.map(baseName)), "error");
			if (failed.length) notify(`Not replaced: ${failed.join("; ")}`, "error");
		} finally {
			replaceBusy = false;
			setReplaceActive(false);
		}
		if (handoffToPreview) {
			if (state.workspace?.root === startRoot && latest === startSearchId) await previewReplace();
			return;
		}
		if (ranReplace && state.workspace?.root === startRoot) {
			// The search that was replaced from, made again: not whatever has been typed in the box meanwhile, which
			// nobody pressed Enter on.
			await run({ query: searchedFor });
		}
	};
	const replaceAll = () => executeReplace(false);
	const previewReplace = async () => {
		if (replaceBusy || noReplace(true)) return;
		const startRoot = state.workspace?.root;
		const startSearchId = latest;
		const query = effectiveAsked() || asked();
		const options = searched();
		const with_ = replacement();
		const activeGroups = groups();
		const protect = safeDocs();
		const listed = listedBy();
		const searchedAs = marks();

		type PreviewRow = {
			path: string;
			relPath: string;
			count: number;
			skippedProtected: number;
			invalidJson: boolean;
			/** Its text is no longer the one that was searched: a replace leaves it as it is. */
			changed?: boolean;
			sampleLine?: number;
			sampleSummary?: string;
		};
		const rows: PreviewRow[] = [];
		let totalMatches = 0;
		let totalProtected = 0;
		let invalidCount = 0;
		let changedCount = 0;

		replaceBusy = true;
		setReplaceActive(true);
		let applyAfter = false;
		let openTarget: { path: string; line?: number } | null = null;
		try {
			for (const [path, fileLines] of activeGroups) {
				const text = await currentTextFor(path);
				if (state.workspace?.root !== startRoot || latest !== startSearchId) return;
				const res = replaceGuarded(path, text, searchedAs[path], listed.get(path), with_, Boolean(options.regex), protect, 1);
				// A file that is not the text that was searched any more (or cannot be read now) is shown as that: the
				// replace leaves it as it is, and what it would have become cannot be told from another text.
				if (!res) {
					changedCount++;
					rows.push({
						path,
						relPath: rel(path),
						count: 0,
						skippedProtected: 0,
						invalidJson: false,
						changed: true,
						sampleLine: fileLines[0]?.line,
						sampleSummary: "Skipped: changed since the search. Search again to replace in it",
					});
					continue;
				}
				totalProtected += res.skippedProtected;
				if (res.invalidJson) {
					invalidCount++;
					rows.push({
						path,
						relPath: rel(path),
						count: 0,
						skippedProtected: res.skippedProtected,
						invalidJson: true,
						sampleLine: fileLines[0]?.line,
						sampleSummary: "Skipped: replacement would produce invalid JSON",
					});
					continue;
				}
				if (!res.count && !res.skippedProtected) continue;
				totalMatches += res.count;
				const sample = res.samples[0];
				const trim = (s: string) => (s.length > 36 ? `${s.slice(0, 35)}…` : s);
				rows.push({
					path,
					relPath: rel(path),
					count: res.count,
					skippedProtected: res.skippedProtected,
					invalidJson: false,
					sampleLine: sample?.line ?? fileLines[0]?.line,
					sampleSummary: sample
						? `L${sample.line}: ${trim(sample.before)} -> ${trim(sample.after)}`
						: res.skippedProtected
							? `${count(res.skippedProtected, "match", "matches")} protected by Safe docs`
							: undefined,
				});
			}

			const readyFiles = rows.filter((r) => r.count > 0 && !r.invalidJson).length;
			const APPLY = "__apply__";
			const picked = await quickPick<string>({
				// "Apply" below replaces with no further question, so what is replaced is named here too.
				title: replacePreviewTitle({ query, regex: options.regex, caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, replacement: with_, matches: totalMatches, files: readyFiles }),
				placeholder: "Apply replace or pick a file to inspect…",
				items: [
					...(totalMatches > 0
						? [
								{
									label: `Apply replace (${count(totalMatches, "match", "matches")} in ${count(readyFiles, "file")})`,
									value: APPLY,
									icon: "check" as const,
									detail: [
										totalProtected ? `${totalProtected} protected skipped` : "",
										invalidCount ? `${invalidCount} invalid JSON skipped` : "",
										changedCount ? `${changedCount} changed since the search skipped` : "",
									]
										.filter(Boolean)
										.join(" · ") || "Local history snapshots kept before writing",
								},
							]
						: []),
					...rows.map((r, idx) => ({
						label: `${r.relPath} (${r.invalidJson ? "invalid JSON" : r.changed ? "changed since the search" : count(r.count, "change")})`,
						value: r.path,
						file: baseName(r.path),
						danger: r.invalidJson || r.changed,
						divide: idx === 0 && totalMatches > 0,
						description: r.sampleSummary,
						detail: r.skippedProtected && !r.invalidJson ? `${r.skippedProtected} protected` : undefined,
					})),
				],
				empty: "No eligible matches remain to replace.",
			});
			if (state.workspace?.root !== startRoot || latest !== startSearchId) return;
			if (!picked) return;
			if (picked === APPLY) {
				applyAfter = true;
			} else {
				const targetRow = rows.find((r) => r.path === picked);
				if (targetRow) openTarget = { path: targetRow.path, line: targetRow.sampleLine };
			}
		} finally {
			replaceBusy = false;
			setReplaceActive(false);
		}
		if (applyAfter) {
			if (state.workspace?.root === startRoot && latest === startSearchId) await executeReplace(true);
			return;
		}
		if (openTarget && state.workspace?.root === startRoot) {
			await openFile(openTarget.path, { keep: true, ...(openTarget.line ? { reveal: { line: openTarget.line } } : {}) });
		}
	};

	const summary = () => {
		if (status() === "busy") return "Searching…";
		if (status() === "failed") return failure() || `The search for “${asked()}” failed.`;
		if (status() === "idle") return "";
		const filterTail = docFilterNote() ? ` [${docFilterNote()}]` : "";
		const openTail = searched().openEditorsOnly ? " · open editors" : "";
		const scopeTail = narrowed() && !docFilterNote() && !searched().openEditorsOnly ? " · filtered" : "";
		if (!visibleHits().length) {
			if (dismissedHitCount()) return `All ${count(hits().length, "result")} dismissed`;
			if (timedOut()) return timedOutEmpty(asked(), filterTail);
			return `No results found${filterTail}${openTail}${scopeTail}`;
		}
		const countText = shortfallCount(shortfall(), count(visibleHits().length, "result"), hits().length, SEARCH_LIMIT);
		return `${countText} in ${count(groups().length, "file")}${filterTail}${openTail}${scopeTail}`;
	};

	const replaceInFile = (path: string) => {
		if (noReplace()) return notify(`${noReplace()}.`);
		pendingReplaceTarget = { path };
		void executeReplace(true);
	};

	const replaceInLine = (path: string, line: number) => {
		if (noReplace()) return notify(`${noReplace()}.`);
		pendingReplaceTarget = { path, line };
		void executeReplace(true);
	};

	const openMatch = (line: LineHit, keep: boolean) => {
		const first = line.matches[0]!;
		setActiveHitKey(`${line.path}:${line.line}`);
		if (asked()) recordHistory(asked());
		void openFile(line.path, {
			...(keep ? { keep: true } : { preview: true }),
			reveal: { line: line.line, column: first.column, endLine: line.line, endColumn: first.column + first.length },
		});
	};

	const openMatchToSide = async (line: LineHit) => {
		const first = line.matches[0]!;
		setActiveHitKey(`${line.path}:${line.line}`);
		if (asked()) recordHistory(asked());
		await openToSide(line.path);
		await openFile(line.path, {
			group: state.activeGroup,
			keep: true,
			reveal: { line: line.line, column: first.column, endLine: line.line, endColumn: first.column + first.length },
		});
	};

	const openHitMenu = async (line: LineHit, at: Point) => {
		const first = line.matches[0]!;
		const canReplace = replacing() && !noReplace();
		const entries: RowMenuEntry[] = [
			{ label: "Open Match", value: "open", keys: "Enter" },
			{ label: "Open to the Side", value: "side" },
			"separator",
			{ label: "Copy Line", value: "copy-line" },
			{ label: "Copy Match", value: "copy-match" },
			{ label: "Copy Path", value: "copy-path" },
			{ label: "Copy Relative Path", value: "copy-rel" },
			"separator",
			...(canReplace ? [{ label: "Replace", value: "replace" }] : []),
			{ label: "Dismiss", value: "dismiss", keys: "Del" },
		];
		const picked = await chooseFromMenu(`Match on line ${line.line}`, entries, at);
		if (!picked) return;
		if (picked === "open") openMatch(line, true);
		else if (picked === "side") void openMatchToSide(line);
		else if (picked === "copy-line") void copyTextLocal(line.text.trim(), "Copied matched line.");
		else if (picked === "copy-match") {
			const off = line.textOffset ?? 0;
			const start = Math.max(0, first.column - 1 - off);
			const matched = line.text.slice(start, start + first.length);
			void copyTextLocal(matched, `Copied “${matched}”.`);
		} else if (picked === "copy-path") void copyTextLocal(`${line.path}:${line.line}`, `Copied ${baseName(line.path)}:${line.line}`);
		else if (picked === "copy-rel") void copyTextLocal(`${rel(line.path)}:${line.line}`, `Copied ${rel(line.path)}:${line.line}`);
		else if (picked === "replace") replaceInLine(line.path, line.line);
		else if (picked === "dismiss") dismissLine(line.path, line.line);
	};

	const openFileMenu = async (path: string, lines: readonly LineHit[], at: Point) => {
		const canReplace = replacing() && !noReplace();
		const entries: RowMenuEntry[] = [
			{ label: "Open File", value: "open" },
			{ label: "Open to the Side", value: "side" },
			...(!isUntitled(path) ? [{ label: "Reveal in Explorer", value: "reveal" }] : []),
			"separator",
			{ label: "Copy Path", value: "copy-path" },
			{ label: "Copy Relative Path", value: "copy-rel" },
			{ label: "Copy File Name", value: "copy-name" },
			{ label: "Copy All Matches in File", value: "copy-all" },
			"separator",
			...(canReplace ? [{ label: "Replace in File", value: "replace" }] : []),
			{ label: "Dismiss", value: "dismiss", keys: "Del" },
		];
		const picked = await chooseFromMenu(`Results in ${baseName(path)}`, entries, at);
		if (!picked) return;
		if (picked === "open") void openFile(path, { keep: true });
		else if (picked === "side") void openToSide(path);
		else if (picked === "reveal") void import("./Explorer").then((m) => m.showInExplorer(path));
		else if (picked === "copy-path") void copyTextLocal(path, `Copied ${path}`);
		else if (picked === "copy-rel") void copyTextLocal(rel(path), `Copied ${rel(path)}`);
		else if (picked === "copy-name") void copyTextLocal(displayName(path), `Copied ${displayName(path)}`);
		else if (picked === "copy-all") {
			const dump = lines.map((l) => `${l.line}: ${l.text.trim()}`).join("\n");
			void copyTextLocal(dump, `Copied ${count(lines.length, "matched line", "matched lines")}.`);
		} else if (picked === "replace") replaceInFile(path);
		else if (picked === "dismiss") dismissFile(path);
	};

	const openFolderMenu = async (relDir: string, filePaths: readonly string[], at: Point) => {
		const entries: RowMenuEntry[] = [
			{ label: "Find in Folder…", value: "find" },
			{ label: "Copy Relative Path", value: "copy-rel" },
			"separator",
			{ label: "Dismiss Folder", value: "dismiss", keys: "Del" },
		];
		const picked = await chooseFromMenu(`Folder ${relDir}`, entries, at);
		if (!picked) return;
		if (picked === "find") {
			findInFolder(relDir);
			if (typed()) void run({ include: folderScope(relDir).include, exclude: "", choosing: true, ticketScopeKey: null, openEditorsOnly: false });
		} else if (picked === "copy-rel") void copyTextLocal(relDir, `Copied ${relDir}`);
		else if (picked === "dismiss") dismissFiles(filePaths);
	};

	const onSearchShortcut = (e: KeyboardEvent) => {
		if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
			const k = e.key.toLowerCase();
			if (k === "c") {
				e.preventDefault();
				e.stopPropagation();
				flip("caseSensitive", setCaseSensitive, caseSensitive());
				return true;
			}
			if (k === "w") {
				e.preventDefault();
				e.stopPropagation();
				flip("wholeWord", setWholeWord, wholeWord());
				return true;
			}
			if (k === "r") {
				e.preventDefault();
				e.stopPropagation();
				flip("regex", setRegex, regex());
				return true;
			}
			if (k === "p" && replacing()) {
				e.preventDefault();
				e.stopPropagation();
				setPreserveCase(!preserveCase());
				return true;
			}
		}
		if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.key === "Enter" && replacing()) {
			e.preventDefault();
			e.stopPropagation();
			if (noReplace()) notify(`${noReplace()}.`);
			else void replaceAll();
			return true;
		}
		return false;
	};

	const IndentGuides = (props: { depth: number }) => (
		<Show when={props.depth > 0}>
			<For each={Array.from({ length: props.depth }, (_, i) => i)}>
				{(idx) => <span class="search-guide" style={{ left: `${12 + idx * 14}px` }} aria-hidden="true" />}
			</For>
		</Show>
	);

	const HitRow = (props: { line: LineHit; depth: number }) => {
		const rowKey = () => `${props.line.path}:${props.line.line}`;
		/** The line's parts, each marked match with the column it starts at. */
		const parts = () => {
			const columns = markedColumns(props.line);
			let mark = 0;
			return segments(props.line, LEAD).map((part) => ({ ...part, column: part.match ? columns[mark++] : undefined }));
		};
		// A line cut short for the list (or a synthetic filter-only query) cannot say what a match near its cut would become: it is only marked.
		const after = createMemo(() =>
			replacing() && !searched().syntheticQuery && !props.line.textOffset && props.line.text.length < SEARCH_LINE_WINDOW
				? becomes(props.line)
				: null,
		);
		const canReplace = () => replacing() && !noReplace();
		return (
			<Row
				class="tree-row hit"
				classList={{ selected: activeHitKey() === rowKey() }}
				role="treeitem"
				level={props.depth + 1}
				selected={activeHitKey() === rowKey()}
				key={rowKey()}
				style={{ "padding-left": `${8 + props.depth * 14}px` }}
				label={props.line.text.trim()}
				title={`Line ${props.line.line}${props.line.matches.length > 1 ? `, ${props.line.matches.length} matches` : ""}: ${props.line.text.trim()}`}
				// To stay or for a look, a result opens at its match.
				onKeep={() => openMatch(props.line, true)}
				onActivate={() => openMatch(props.line, false)}
				onKey={(e) => {
					if (e.key === "Delete") {
						dismissLine(props.line.path, props.line.line);
						return true;
					}
				}}
				onMenu={(at) => void openHitMenu(props.line, at)}
			>
				<IndentGuides depth={props.depth} />
				<span class="search-line-num">{props.line.line}</span>
				<span class="label">
					{/* A dozen characters of what comes before: in a side panel's width, more would push the match itself out of sight. */}
					<For each={parts()}>
						{(part) =>
							!part.match ? (
								part.text
							) : (
								<Show when={after()?.has(part.column!)} fallback={<mark>{part.text}</mark>}>
									{/* What is there now, struck out, and what would stand in its place. */}
									<del>{part.text}</del>
									<span class="visually-hidden"> becomes </span>
									<ins>{after()?.get(part.column!) ?? ""}</ins>
									<span class="visually-hidden"> </span>
								</Show>
							)
						}
					</For>
				</span>
				<span class="search-row-actions">
					<Show when={canReplace()}>
						<button
							type="button"
							class="search-row-act"
							tabindex={-1}
							title={`Replace match on line ${props.line.line}`}
							aria-label={`Replace match on line ${props.line.line}`}
							onClick={(e) => {
								e.stopPropagation();
								replaceInLine(props.line.path, props.line.line);
							}}
						>
							<Icon name="replace" />
						</button>
					</Show>
					<button
						type="button"
						class="search-dismiss search-row-act"
						tabindex={-1}
						title="Dismiss (Delete)"
						aria-label={`Dismiss match on line ${props.line.line}`}
						onClick={(e) => {
							e.stopPropagation();
							dismissLine(props.line.path, props.line.line);
						}}
					>
						<Icon name="close" />
					</button>
				</span>
			</Row>
		);
	};

	const FilePlaces = (props: { list: LineHit[]; depth: number }) => {
		const grouped = createMemo(() => byPlace(props.list));
		return (
			<For each={grouped()} keyed={([where]) => where}>
				{(entry) => {
					const where = () => entry()[0];
					const lines = () => entry()[1];
					return (
						<Show
							when={where()}
							fallback={
								<For each={lines()} keyed={(line) => `${line.path}:${line.line}`}>
									{(line) => <HitRow line={line()} depth={props.depth} />}
								</For>
							}
						>
							<div class="tree-row place" style={{ "padding-left": `${8 + props.depth * 14}px` }} title={where()} aria-hidden="true">
								<IndentGuides depth={props.depth} />
								<span class="label">{where()}</span>
							</div>
							<For each={lines()} keyed={(line) => `${line.path}:${line.line}`}>
								{(line) => <HitRow line={line()} depth={props.depth} />}
							</For>
						</Show>
					);
				}}
			</For>
		);
	};

	const FileGroupView = (props: { path: string; relPath: string; list: LineHit[]; depth: number; showDir: boolean }) => {
		const foldKey = () => `file:${props.path}`;
		const open = () => !isCollapsed(foldKey());
		const split = () => splitResultPath(props.relPath);
		const canReplace = () => replacing() && !noReplace();
		return (
			<>
				<Row
					class="tree-row file-head"
					role="treeitem"
					level={props.depth + 1}
					expanded={open()}
					key={foldKey()}
					style={{ "padding-left": `${6 + props.depth * 14}px` }}
					label={split().name}
					title={props.path}
					onActivate={() => toggleCollapsed(foldKey())}
					onKeep={() => {
						void openFile(props.path, { keep: true });
						return true;
					}}
					onToggle={() => toggleCollapsed(foldKey())}
					onKey={(e) => {
						if (e.key === "Delete") {
							dismissFile(props.path);
							return true;
						}
					}}
					onMenu={(at) => void openFileMenu(props.path, props.list, at)}
				>
					<IndentGuides depth={props.depth} />
					<Icon name={open() ? "chevron-down" : "chevron-right"} class="twisty" />
					<FileMark name={props.path} />
					<span class="search-file-label">
						<span class="search-file-name">{split().name}</span>
						<Show when={props.showDir && split().dir}>
							<span class="search-file-dir">{split().dir}</span>
						</Show>
					</span>
					<span class="search-count-badge" title={`${count(matchesIn(props.list), "match", "matches")} in ${split().name}`}>
						{matchesIn(props.list)}
					</span>
					<span class="search-row-actions">
						<Show when={canReplace()}>
							<button
								type="button"
								class="search-row-act"
								tabindex={-1}
								title={`Replace all in ${split().name}`}
								aria-label={`Replace all matches in ${split().name}`}
								onClick={(e) => {
									e.stopPropagation();
									replaceInFile(props.path);
								}}
							>
								<Icon name="replace-all" />
							</button>
						</Show>
						<button
							type="button"
							class="search-dismiss search-row-act"
							tabindex={-1}
							title={`Dismiss ${props.relPath} (Delete)`}
							aria-label={`Dismiss ${props.relPath} from results`}
							onClick={(e) => {
								e.stopPropagation();
								dismissFile(props.path);
							}}
						>
							<Icon name="close" />
						</button>
					</span>
				</Row>
				<Show when={open()}>
					<FilePlaces list={props.list} depth={props.depth + 1} />
				</Show>
			</>
		);
	};

	const TreeNodeView = (props: { node: SearchTreeNode; depth: number }) => (
		<Show
			when={props.node.kind === "folder" ? props.node : null}
			fallback={(() => {
				const file = () => (props.node as Extract<SearchTreeNode, { kind: "file" }>).file;
				return <FileGroupView path={file().path} relPath={file().relPath} list={file().lines} depth={props.depth} showDir={false} />;
			})()}
		>
			{(folder) => {
				const open = () => !isCollapsed(folder().key);
				return (
					<>
						<Row
							class="tree-row search-folder-head"
							role="treeitem"
							level={props.depth + 1}
							expanded={open()}
							key={folder().key}
							style={{ "padding-left": `${6 + props.depth * 14}px` }}
							label={folder().name}
							title={`${folder().relDir} (${count(folder().matchCount, "result")} in ${count(folder().fileCount, "file")})`}
							onActivate={() => toggleCollapsed(folder().key)}
							onToggle={() => toggleCollapsed(folder().key)}
							onKey={(e) => {
								if (e.key === "Delete") {
									dismissFiles(folder().filePaths);
									return true;
								}
							}}
							onMenu={(at) => void openFolderMenu(folder().relDir, folder().filePaths, at)}
						>
							<IndentGuides depth={props.depth} />
							<Icon name={open() ? "chevron-down" : "chevron-right"} class="twisty" />
							<FileMark name={folder().name} folder={{ open: open() }} />
							<span class="search-folder-name">{folder().name}</span>
							<span class="search-count-badge" title={`${count(folder().matchCount, "result")} in ${count(folder().fileCount, "file")}`}>
								{folder().matchCount}
							</span>
							<span class="search-row-actions">
								<button
									type="button"
									class="search-dismiss search-row-act"
									tabindex={-1}
									title={`Dismiss ${folder().relDir} (Delete)`}
									aria-label={`Dismiss folder ${folder().relDir} from results`}
									onClick={(e) => {
										e.stopPropagation();
										dismissFiles(folder().filePaths);
									}}
								>
									<Icon name="close" />
								</button>
							</span>
						</Row>
						<Show when={open()}>
							<For each={folder().children} keyed={(child) => child.key}>
								{(child) => <TreeNodeView node={child()} depth={props.depth + 1} />}
							</For>
						</Show>
					</>
				);
			}}
		</Show>
	);

	const hasAnyQueryOrResults = () => Boolean(typed() || hits().length || status() !== "idle");

	const filterMenuItems = (): MenuItem[] => {
		const ticket = activeTicketScope();
		const items: MenuItem[] = [
			{ label: "All files", checked: scopeActive("", ""), run: () => applyScope("", "") },
			{ label: "Code only", checked: inCodeScope(), run: () => applyScope("", codeExcludeGlob()) },
			{ label: "Docs only", checked: inDocsScope(), run: () => applyScope(docsIncludeGlob(), "") },
		];
		if (ticket) {
			items.push({
				label: `This ticket (${ticket.key})`,
				checked: ticketScopeKey() === ticket.key,
				run: () => applyTicketScope(ticket.key),
			});
		}
		const replaceBlock = noReplace();
		items.push(
			"separator",
			{
				label: "Safe docs (protect YAML, links & JSON)",
				checked: safeDocs(),
				run: () => setSafeDocs(!safeDocs()),
			},
			{
				label: "Preview replace changes…",
				disabled: Boolean(replaceBlock),
				why: replaceBlock || undefined,
				run: () => void previewReplace(),
			},
		);
		if (hasCustomFilter() || include().trim() || exclude().trim()) {
			items.push("separator", {
				label: "Clear Scope & Options",
				run: () => {
					setTicketScopeKey(null);
					setOpenEditorsOnly(false);
					setInclude("");
					setExclude("");
					setChoosing(false);
					setUseExcludes(true);
					setSafeDocs(true);
					if (typed()) {
						void run({
							ticketScopeKey: null,
							openEditorsOnly: false,
							include: "",
							exclude: "",
							choosing: false,
							useExcludes: true,
						});
					}
				},
			});
		}
		return items;
	};

	return (
		<div class="panel-body" data-panel="search">
			<div class="panel-title">
				<span>Search</span>
				<div class="search-title-actions">
					<IconButton
						label="Refresh search"
						title="Refresh"
						icon="refresh"
						disabled={!typed() && status() === "idle"}
						onClick={() => void run({ query: typed() })}
					/>
					<IconButton
						label="Clear search results"
						title="Clear Search Results"
						icon="clear-all"
						disabled={!hasAnyQueryOrResults()}
						onClick={clearSearch}
					/>
					<Menu
						floating
						class={hasCustomFilter() ? "docs-filter-menu on" : "docs-filter-menu"}
						label={hasCustomFilter() ? "Search scope and options: a scope or option is active" : "Search scope and options"}
						title="Scope (All, Code, Docs, Ticket), Safe docs & Replace preview"
						items={filterMenuItems}
					>
						<Icon name={hasCustomFilter() ? "filter-filled" : "filter"} />
					</Menu>
					<IconButton
						label={treeView() ? "View search results as list" : "View search results as tree"}
						title={treeView() ? "View as List" : "View as Tree"}
						icon={treeView() ? "list-flat" : "list-tree"}
						disabled={!groups().length}
						onClick={toggleViewMode}
					/>
					<IconButton
						label={allCollapsed() ? "Expand all results" : "Collapse all results"}
						title={allCollapsed() ? "Expand All" : "Collapse All"}
						icon={allCollapsed() ? "expand-all" : "collapse-all"}
						disabled={!groups().length}
						onClick={toggleCollapseAll}
					/>
				</div>
			</div>
			<form
				class="search-form"
				role="search"
				onSubmit={(e) => (e.preventDefault(), void run())}
				// Trigger search on Enter for search/include/exclude inputs, never for Replace With or checkboxes.
				onKeyDown={(e) => {
					if (onSearchShortcut(e)) return;
					if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return;
					if (e.target.type === "checkbox" || e.target.hasAttribute("data-replace-input")) {
						e.preventDefault();
						return;
					}
					e.preventDefault();
					void run();
				}}
			>
				<div class="search-widget">
					<button
						type="button"
						class="search-fold"
						title={replacing() ? "Toggle Replace (Hide)" : "Toggle Replace"}
						aria-label="Replace across files"
						aria-expanded={replacing() ? "true" : "false"}
						onClick={() => setReplacing(!replacing())}
					>
						<Icon name={replacing() ? "chevron-down" : "chevron-right"} />
					</button>
					<div class="search-inputs">
						<div class="search-row">
							<div class={["search-input-box", { invalid: status() === "failed" }]}>
								<input
									ref={(el) => ((input = el), queueMicrotask(() => el.focus()))}
									value={typed()}
									onInput={(e) => {
										historyIdx = -1;
										const val = e.currentTarget.value;
										setTyped(val);
										scheduleSearch({ query: val });
									}}
									onBlur={() => {
										if (typed().trim() && asked() === typed()) recordHistory(typed());
									}}
									id="search-input"
									data-autofocus=""
									spellcheck="false"
									autocomplete="off"
									aria-label="Search"
									placeholder="Search"
									onKeyDown={(e) => {
										const el = e.currentTarget;
										const hist = queryHistory();
										if (
											(e.key === "ArrowUp" || (e.altKey && e.key === "ArrowUp")) &&
											hist.length &&
											(e.altKey || historyIdx >= 0 || !el.value || (el.selectionStart === 0 && el.selectionEnd === 0))
										) {
											e.preventDefault();
											if (historyIdx < 0) historyDraft = el.value;
											historyIdx = Math.min(hist.length - 1, historyIdx + 1);
											const nextVal = hist[historyIdx] ?? "";
											el.value = nextVal;
											setTyped(nextVal);
											scheduleSearch({ query: nextVal }, 120);
											return;
										}
										if ((e.key === "ArrowDown" || (e.altKey && e.key === "ArrowDown")) && historyIdx >= 0) {
											e.preventDefault();
											historyIdx--;
											const nextVal = historyIdx < 0 ? historyDraft : (hist[historyIdx] ?? "");
											el.value = nextVal;
											setTyped(nextVal);
											scheduleSearch({ query: nextVal }, 120);
											return;
										}
										if (e.key === "ArrowDown" && focusRowsBelow(el)) e.preventDefault();
									}}
								/>
								<div class="search-inline-toggles">
									<IconButton
										label="Match case"
										title="Match Case (Alt+C)"
										icon="case-sensitive"
										pressed={caseSensitive()}
										onClick={() => flip("caseSensitive", setCaseSensitive, caseSensitive())}
									/>
									<IconButton
										label="Match whole word"
										title="Match Whole Word (Alt+W)"
										icon="whole-word"
										pressed={wholeWord()}
										onClick={() => flip("wholeWord", setWholeWord, wholeWord())}
									/>
									<IconButton
										label="Use a regular expression"
										title="Use Regular Expression (Alt+R)"
										icon="regex"
										pressed={regex()}
										onClick={() => flip("regex", setRegex, regex())}
									/>
								</div>
							</div>
						</div>
						<Show when={replacing()}>
							<div class="search-row search-replace-row">
								<div class="search-input-box">
									<input
										data-replace-input=""
										spellcheck="false"
										autocomplete="off"
										aria-label="Replace"
										placeholder="Replace"
										title={regex() ? "Replace ($1 for capture group, $& for whole match)" : "Replace"}
										value={replacement()}
										onInput={(e) => setReplacement(e.currentTarget.value)}
									/>
									<div class="search-inline-toggles">
										<IconButton
											label="Preserve Case"
											title="Preserve Case (Alt+P)"
											icon="preserve-case"
											pressed={preserveCase()}
											onClick={() => setPreserveCase(!preserveCase())}
										/>
									</div>
								</div>
								{/* Not the button's own "disabled": it keeps the keyboard, and says why it does nothing. */}
								<button
									type="button"
									class="search-replace search-replace-icon"
									aria-label="Replace all"
									aria-disabled={noReplace() ? "true" : undefined}
									title={noReplace() || "Replace All (Ctrl+Alt+Enter)"}
									onClick={() => (noReplace() ? notify(`${noReplace()}.`) : void replaceAll())}
								>
									<Icon name="replace-all" />
								</button>
							</div>
						</Show>
					</div>
				</div>
				<Show when={!choosing()}>
					<div class="search-details-seam">
						<Show when={activeScopeChip() || openEditorsOnly() || !useExcludes()}>
							<div class="docs-filter-chips" role="group" aria-label="Active search scope">
								<Show when={activeScopeChip()}>
									{(chip) => (
										<button type="button" class="docs-tag-active" title={chip().title} onClick={chip().clear}>
											<span>{chip().label}</span>
											<Icon name="close" />
										</button>
									)}
								</Show>
								<Show when={openEditorsOnly()}>
									<button type="button" class="docs-tag-active" title="Searching open editors only. Click to search all files." onClick={toggleOpenEditorsOnly}>
										<span>Open Editors</span>
										<Icon name="close" />
									</button>
								</Show>
								<Show when={!useExcludes()}>
									<button type="button" class="docs-tag-active" title="Searching ignored and excluded files. Click to restore default excludes." onClick={toggleUseExcludes}>
										<span>Ignored included</span>
										<Icon name="close" />
									</button>
								</Show>
							</div>
						</Show>
						<button
							type="button"
							class="search-details-toggle"
							aria-label="Toggle Search Details"
							aria-expanded="false"
							title="Toggle Search Details (files to include/exclude)"
							onClick={toggleDetails}
						>
							<Icon name="ellipsis" />
						</button>
					</div>
				</Show>
				<Show when={choosing()}>
					<div class="search-details">
						<div class="search-detail-field">
							<div class="search-field-head">
								<label class="search-field-label" for="search-include-input">
									files to include
								</label>
								<button
									type="button"
									class="search-details-toggle"
									aria-label="Toggle Search Details"
									aria-expanded="true"
									title="Hide files to include/exclude"
									onClick={toggleDetails}
								>
									<Icon name="ellipsis" />
								</button>
							</div>
							<div class="search-input-box">
								<input
									id="search-include-input"
									spellcheck="false"
									autocomplete="off"
									aria-label="Files to include"
									title="Patterns with commas between: *.ssl, src/DueDates, docs/**/*.md. Empty for every file."
									placeholder="e.g. *.ssl, src/**/include"
									value={include()}
									onInput={(e) => {
										const val = e.currentTarget.value;
										setTicketScopeKey(null);
										setInclude(val);
										if (typed()) scheduleSearch({ ticketScopeKey: null, include: val }, 280);
									}}
								/>
								<div class="search-inline-toggles">
									<IconButton
										label="Search only in Open Editors"
										title="Search only in Open Editors"
										icon="book"
										pressed={openEditorsOnly()}
										onClick={toggleOpenEditorsOnly}
									/>
								</div>
							</div>
						</div>
						<div class="search-detail-field">
							<label class="search-field-label" for="search-exclude-input">
								files to exclude
							</label>
							<div class="search-input-box">
								<input
									id="search-exclude-input"
									spellcheck="false"
									autocomplete="off"
									aria-label="Files to exclude"
									title="Patterns with commas between: tests, *.md. These are left out even when included above."
									placeholder=""
									value={exclude()}
									onInput={(e) => {
										const val = e.currentTarget.value;
										setTicketScopeKey(null);
										setExclude(val);
										if (typed()) scheduleSearch({ ticketScopeKey: null, exclude: val }, 280);
									}}
								/>
								<div class="search-inline-toggles">
									<IconButton
										label="Use Exclude Settings and Ignore Files"
										title={
											useExcludes()
												? "Use Exclude Settings and Ignore Files (On — skipping .gitignore, dist, build, node_modules)"
												: "Use Exclude Settings and Ignore Files (Off — searching ignored and excluded files)"
										}
										icon="exclude"
										pressed={useExcludes()}
										onClick={toggleUseExcludes}
									/>
								</div>
							</div>
						</div>
						<Show when={activeScopeChip()}>
							{(chip) => (
								<div class="docs-filter-chips" role="group" aria-label="Active search scope">
									<button type="button" class="docs-tag-active" title={chip().title} onClick={chip().clear}>
										<span>{chip().label}</span>
										<Icon name="close" />
									</button>
								</div>
							)}
						</Show>
					</div>
				</Show>
				<Show when={showDocChips()}>
					<div class="search-doc-tokens" role="group" aria-label="Document metadata filter chips">
						<For each={topTags()}>
							{(bucket) => {
								const tok = formatToken("tag", bucket.tag);
								return (
									<button
										type="button"
										class={{ on: hasQueryToken(tok) }}
										title={`Filter Docs by #${bucket.tag} (${bucket.count})`}
										onClick={() => toggleQueryToken(tok)}
									>
										#{bucket.tag}
									</button>
								);
							}}
						</For>
						<For each={workspaceStatuses()}>
							{(st) => {
								const tok = formatToken("status", st.label);
								return (
									<button
										type="button"
										class={{ on: hasQueryToken(tok) }}
										title={`Filter Docs by ${tok}${st.count ? ` (${st.count})` : ""}`}
										onClick={() => toggleQueryToken(tok)}
									>
										status:{st.label}
									</button>
								);
							}}
						</For>
						<button
							type="button"
							class={{ on: hasQueryToken("task:open") }}
							title="Match unchecked checklist tasks (- [ ])"
							onClick={() => toggleQueryToken("task:open")}
						>
							task:open
						</button>
					</div>
				</Show>
			</form>
			<div class={["search-progress", { busy: status() === "busy" }]} aria-hidden="true">
				<div class="search-progress-bar" />
			</div>
			<Show when={status() === "failed"}>
				<div class="search-error-banner" role="alert">
					<Icon name="error" />
					<span>{summary()}</span>
				</div>
			</Show>
			<Show when={status() !== "failed" && status() !== "idle"}>
				<div class="search-status-bar" role="status">
					<span class="search-status-text">{summary()}</span>
					<Show when={dismissedHitCount() > 0}>
						<button type="button" class="link search-status-action" onClick={restoreDismissed}>
							Restore {dismissedHitCount()}
						</button>
					</Show>
					<Show when={status() === "done" && !visibleHits().length && !dismissedHitCount() && (narrowed() || switchesOn().length > 0)}>
						<button type="button" class="link search-status-action" onClick={clearAllFilters}>
							Clear filters
						</button>
					</Show>
				</div>
			</Show>
			<div class="search-results-wrap" onKeyDown={(e) => void onSearchShortcut(e)}>
				<Rows role="tree" label="Search results" class="tree search-results">
					<Show
						when={treeView()}
						fallback={
							<For each={fileGroups()} keyed={(fg) => fg.path}>
								{(fg) => <FileGroupView path={fg().path} relPath={fg().relPath} list={fg().lines} depth={0} showDir={true} />}
							</For>
						}
					>
						<For each={searchTree()} keyed={(node) => node.key}>
							{(node) => <TreeNodeView node={node()} depth={0} />}
						</For>
					</Show>
				</Rows>
			</div>
		</div>
	);
}
