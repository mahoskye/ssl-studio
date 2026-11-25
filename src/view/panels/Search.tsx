// Workspace search, results grouped by file; and, from the same box, a
// replace across files. What would be replaced is shown in the results
// before anything is written, and nothing is written until it is confirmed.
// The search, the preview and the replace all find their matches with the
// one expression (src/shared/searchPattern.ts), so they agree.
import { Icon } from "../Icon";
import { FileMark } from "../FileMark";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createAsyncQuery } from "../asyncQuery";
import { monaco } from "../editor/monaco";
import { symbolPath } from "../editor/regions";
import { session } from "../lsp/session";
import type { DocFile, SearchHit } from "../../shared/protocol";
import { backend } from "../backend";
import { choose, quickPick } from "../dialogs";
import { activePath, canonical, documents, fileChangedOnDisk, isUntitled, notify, openFile, save, saveAll, setState, state } from "../state";
import { baseName, isInside, relativeTo } from "../../shared/paths";
import { parseCsv } from "../../shared/csv";
import { createFileFilter, folderPattern } from "../../shared/fileGlob";
import { frontMatter, HEADING, many, one, plainMarkdown } from "../../shared/frontMatter";
import { overlapsProtectedSpan, planLineBreadcrumb, protectedMarkdownSpans, replaceSafeInText, type TextSpan } from "../../shared/menuBar";
import { DOC_FOLDERS, isCatalog, toneOf } from "../../shared/projectDocs";
import { excerptForMatch, matchesOn, REGEX_MAX_LINE_LENGTH, SEARCH_LIMIT, SEARCH_LINE_WINDOW, searchPattern, type SearchOptions } from "../../shared/searchPattern";
import { outline } from "../../shared/outline";
import { workspaceTags } from "../../shared/tags";
import { codeMatchesRef, descendantTickets, scriptsForTicket, ticketForFile, ticketWork } from "../../shared/workContext";
import { recall, remember } from "../graph/canvas";
import { nodeLines, parsePlan } from "../plan/model";
import { docs } from "../project";
import { ticketAtHand } from "../projectDocs";
import { focusRowsBelow, IconButton, Row, RowGroup, Rows } from "./Rows";
import { showPanel } from "./registry";
import {
	byLine,
	markedColumns,
	parseDocFilterTokens,
	resolveSearchQuery,
	searchShortfall,
	segments,
	shortfallBlocksReplace,
	shortfallCount,
	timedOutEmpty,
	type LineHit,
	type ParsedDocFilters,
	type SearchScopeKind,
} from "./searchLines";

const count = (n: number, oneWord: string, manyWord = `${oneWord}s`) => `${n} ${n === 1 ? oneWord : manyWord}`;

/** How much of a line is shown before its first match. */
const LEAD = 12;

/** The row for replacing is open. Kept while the panel is away, as what was typed in it is. */
const [replacing, setReplacing] = createSignal(false);
/** The rows for which files to look in are open. */
const [choosing, setChoosing] = createSignal(false);
const [replacement, setReplacement] = createSignal("");
const [safeDocs, setSafeDocs] = createSignal(true);
const [include, setInclude] = createSignal("");
const [exclude, setExclude] = createSignal("");

/** Shows the Search panel scoped to a specific folder (relative to workspace root). */
export function findInFolder(relFolder: string) {
	setTicketScopeKey(null);
	setInclude(folderPattern(relFolder));
	setChoosing(true);
	showPanel("search");
}

/** Shows the Search panel with its row for replacing open. */
export function showReplace() {
	setReplacing(true);
	showPanel("search");
}

/** Replaces every match in an open file's text (optionally restricted to `allowedLines` and skipping `protectedSpans`), as one undoable step. */
export function replaceInModel(
	model: monaco.editor.ITextModel,
	pattern: RegExp,
	with_: string,
	regex: boolean,
	allowedLines?: ReadonlySet<number>,
	protectedSpans?: ReadonlyMap<number, TextSpan[]>,
): number {
	const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
	for (let line = 1; line <= model.getLineCount(); line++) {
		if (allowedLines && !allowedLines.has(line)) continue;
		const content = model.getLineContent(line);
		if (regex && content.length > REGEX_MAX_LINE_LENGTH) continue;
		const spans = protectedSpans?.get(line);
		for (const match of matchesOn(content, pattern, with_, regex)) {
			if (overlapsProtectedSpan(match.column, match.length, spans)) continue;
			edits.push({ range: new monaco.Range(line, match.column, line, match.column + match.length), text: match.becomes });
		}
	}
	if (!edits.length) return 0;
	model.pushStackElement();
	model.pushEditOperations([], edits, () => null);
	model.pushStackElement();
	return edits.length;
}

/** Scans a single in-memory text buffer using the exact same `searchPattern` + `matchesOn` + windowing walk as backend search. */
export function scanTextBuffer(path: string, text: string, pattern: RegExp, isRegex: boolean, limit: number): SearchHit[] {
	const out: SearchHit[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length && out.length < limit; i++) {
		const line = lines[i]!;
		if (isRegex && line.length > REGEX_MAX_LINE_LENGTH) continue;
		const found = matchesOn(line, pattern, "", isRegex, limit - out.length);
		for (const m of found) {
			const { text: excerpt, textOffset } = excerptForMatch(line, m.column, m.length);
			out.push({ path, line: i + 1, column: m.column, length: m.length, text: excerpt, ...(textOffset > 0 ? { textOffset } : {}) });
			if (out.length >= limit) break;
		}
	}
	return out;
}

const [request, setRequest] = createSignal<({ query: string } & SearchOptions) | null>(null);
/** Shows the Search panel with this searched for: a table cell or code check asks where a value appears in code. */
export function searchFor(query: string, options: SearchOptions = {}) {
	setRequest({ query, ...options });
	showPanel("search");
}

// What was searched for, how, and what was found: kept while the panel is away, with the replacement and the file
// patterns, so that coming back to it is coming back to the same search.
const [typed, setTyped] = createSignal("");
const [hits, setHits] = createSignal<SearchHit[]>([]);
const [regex, setRegex] = createSignal(false);
const [caseSensitive, setCaseSensitive] = createSignal(false);
const [wholeWord, setWholeWord] = createSignal(false);
/** Where the panel stands: nothing asked yet, searching, the last search answered or failed. */
const [status, setStatus] = createSignal<"idle" | "busy" | "done" | "failed">("idle");
const [asked, setAsked] = createSignal("");
const [effectiveAsked, setEffectiveAsked] = createSignal("");
/** The switches and the files the results on screen were found with: a replace uses these, not what has been changed since. */
const [searched, setSearched] = createSignal<SearchOptions & { syntheticQuery?: boolean }>({});
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
/** Document-level Markdown protected-span cache for open editors keyed by canonical path and model version. */
const openMdSpanCache = new Map<string, { version: number; spans: Map<number, TextSpan[]> }>();
let latest = 0;
let lastWorkspaceRoot: string | undefined;

/** Clears workspace-scoped Search state whenever the open workspace changes (A -> B). */
function resetSearchState() {
	latest++;
	replaceBusy = false;
	setReplaceActive(false);
	setHits([]);
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
	setTicketScopeKey(null);
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
		!ticketScopeKey() && (choosing() ? include().trim() === inc && exclude().trim() === exc : !inc && !exc);
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

	type RunOverrides = {
		query?: string;
		regex?: boolean;
		caseSensitive?: boolean;
		wholeWord?: boolean;
		choosing?: boolean;
		include?: string;
		exclude?: string;
		ticketScopeKey?: string | null;
	};

	const run = async (overrides: RunOverrides = {}) => {
		const rawQuery = overrides.query ?? input.value;
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
			return;
		}
		recordHistory(rawQuery);
		historyIdx = -1;
		setStatus("busy");
		setAsked(rawQuery);

		const curChoosing = overrides.choosing ?? choosing();
		const curInclude = overrides.include ?? include();
		const curExclude = overrides.exclude ?? exclude();
		const curTicketScopeKey = overrides.ticketScopeKey !== undefined ? overrides.ticketScopeKey : ticketScopeKey();
		const curRegex = overrides.regex ?? regex();
		const curCaseSensitive = overrides.caseSensitive ?? caseSensitive();
		const curWholeWord = overrides.wholeWord ?? wholeWord();

		const baseInclude = curChoosing ? curInclude : "";
		const baseExclude = curChoosing ? curExclude : "";
		const root = startRoot;
		const activeTicket = curTicketScopeKey && activeTicketScope()?.key === curTicketScopeKey ? activeTicketScope() : null;
		const isScopeActive = (inc: string, exc = "") =>
			!curTicketScopeKey && (curChoosing ? curInclude.trim() === inc && curExclude.trim() === exc : !inc && !exc);
		const scopeKind: SearchScopeKind = isScopeActive("", codeExcludeGlob())
			? "code"
			: isScopeActive(docsIncludeGlob(), "")
				? "docs"
				: activeTicket
					? "ticket"
					: baseInclude.trim() || baseExclude.trim()
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
				setTruncated(false);
				setSearched({ regex: effectiveRegex, caseSensitive: effectiveCase, wholeWord: effectiveWhole, ...(syntheticQuery ? { syntheticQuery: true } : {}) });
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

		const backendOptions: SearchOptions = {
			regex: effectiveRegex,
			caseSensitive: effectiveCase,
			wholeWord: effectiveWhole,
			...(effectiveInclude ? { include: effectiveInclude } : {}),
			...(effectiveExclude ? { exclude: effectiveExclude } : {}),
			...(effectivePaths !== undefined ? { paths: effectivePaths } : {}),
		};
		setSearched({ ...backendOptions, ...(syntheticQuery ? { syntheticQuery: true } : {}) });
		setEffectiveAsked(effectiveQuery);
		setLineFiltered(hasHeadingFilter || hasTaskFilter);

		try {
			// Asked for with whether the scan was cut short: a scan that ran out of time gives only some of what is there.
			const { hits: diskHits, timedOut: ranOutOfTime } = await backend.searchScan(effectiveQuery, backendOptions);
			if (mine !== latest || state.workspace?.root !== startRoot) return;

			// Overlay unsaved dirty open editor buffers so freshly edited unsaved text is always searchable.
			const dirtyPaths = new Set<string>();
			const dirtyHits: SearchHit[] = [];
			const dirtyFilter = createFileFilter(effectiveInclude, effectiveExclude);
			const pathAllowSet = effectivePaths !== undefined ? new Set(effectivePaths.map((p) => p.replace(/\\/g, "/"))) : null;
			let compiledPattern: RegExp | null = null;
			try {
				compiledPattern = searchPattern(effectiveQuery, backendOptions);
			} catch {
				compiledPattern = null;
			}
			if (compiledPattern) {
				for (const [docPath, doc] of documents) {
					const at = canonical(docPath);
					if (!state.dirty[at] || doc.binary) continue;
					if (allowedDocSet && !allowedDocSet.has(at)) continue;
					if (isUntitled(at)) {
						if (effectiveInclude.trim() || pathAllowSet !== null) continue;
					} else if (root && isInside(root, at)) {
						const relPath = relativeTo(root, at).replace(/\\/g, "/");
						if (pathAllowSet !== null && !pathAllowSet.has(relPath)) continue;
						if (!dirtyFilter(relPath)) continue;
					} else {
						continue;
					}
					dirtyPaths.add(at);
					const remaining = Math.max(0, SEARCH_LIMIT - dirtyHits.length);
					if (remaining > 0) {
						dirtyHits.push(...scanTextBuffer(docPath, doc.model.getValue(), compiledPattern, Boolean(effectiveRegex), remaining));
					}
				}
			}

			let merged: SearchHit[] = [
				...diskHits.filter((h) => !dirtyPaths.has(canonical(h.path))),
				...dirtyHits,
			];
			const wasTruncated = diskHits.length >= SEARCH_LIMIT || dirtyHits.length >= SEARCH_LIMIT || merged.length >= SEARCH_LIMIT;

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

	// A search asked for from elsewhere is put in the box and run, as if it had been typed.
	createEffect(
		() => request(),
		(wanted) => {
			if (!wanted || !input) return;
			setRequest(null);
			input.value = wanted.query;
			const nextRegex = Boolean(wanted.regex);
			const nextWhole = Boolean(wanted.wholeWord);
			const nextCase = Boolean(wanted.caseSensitive);
			const nextInc = wanted.include ?? "";
			const nextExc = wanted.exclude ?? "";
			const nextChoosing = Boolean(nextInc.trim() || nextExc.trim());
			setTyped(wanted.query);
			setRegex(nextRegex);
			setWholeWord(nextWhole);
			setCaseSensitive(nextCase);
			setTicketScopeKey(null);
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
			});
		},
	);
	// A switch changes what the results on screen mean, so they are fetched again.
	const flip = (kind: "caseSensitive" | "wholeWord" | "regex", set: (v: boolean) => void, now: boolean) => {
		const next = !now;
		set(next);
		if (status() !== "idle") void run({ [kind]: next });
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

	const dismissLine = (path: string, line: number) =>
		setDismissedLines((prev) => {
			const next = new Set(prev);
			next.add(`${canonical(path)}:${line}`);
			return next;
		});

	const groups = () => {
		const map = new Map<string, LineHit[]>();
		for (const line of byLine(visibleHits())) map.set(line.path, [...(map.get(line.path) ?? []), line]);
		return [...map];
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
						if (trail.length) out.set(`${path}:${line.line}`, trail.join(" › "));
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
	const rel = (path: string) => relativeTo(state.workspace?.root, path);
	const matchesIn = (list: LineHit[]) => list.reduce((n, line) => n + line.matches.length, 0);
	/** The switches that narrow a search, by the names on their buttons: what to try without when nothing is found. */
	const switchesOn = () => [caseSensitive() ? "Aa" : "", wholeWord() ? "ab" : "", regex() ? ".*" : ""].filter(Boolean);
	const narrowed = () => Boolean(searched().include?.trim() || searched().exclude?.trim() || searched().paths !== undefined);

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
		setInclude(inc);
		setExclude(exc);
		setChoosing(nextChoosing);
		if (typed()) void run({ ticketScopeKey: null, include: inc, exclude: exc, choosing: nextChoosing });
	};

	const applyTicketScope = (key: string) => {
		setTicketScopeKey(key);
		setInclude("");
		setExclude("");
		setChoosing(false);
		if (typed()) void run({ ticketScopeKey: key, include: "", exclude: "", choosing: false });
	};

	// --- replacing -------------------------------------------------------------

	/** The expression the results were found with, for showing what each match would become. Null when it cannot be read. */
	const pattern = createMemo(() => {
		try {
			const q = effectiveAsked() || asked();
			return q ? searchPattern(q, searched()) : null;
		} catch {
			return null;
		}
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
		const found = pattern();
		if (!found) return bad;
		const info = safeDocInfo();
		const with_ = replacement();
		const isRegex = Boolean(searched().regex);
		for (const [path, fileLines] of groups()) {
			if (!/\.plan\.json$/i.test(path)) continue;
			const canon = canonical(path);
			const open = documents.get(canon);
			const text = open && !open.binary ? open.model.getValue() : info?.planTexts.get(canon);
			if (!text) continue;
			const res = replaceSafeInText(text, found, with_, isRegex, {
				allowedLines: allowedLinesFor(path, fileLines),
				isPlanJson: true,
				safeDocs: true,
				maxSamples: 0,
			});
			if (res.invalidJson) bad.add(canon);
		}
		return bad;
	});

	/** What each marked match of a line would become, by the column it starts at (using document-level Safe Docs spans). */
	const becomes = (line: LineHit) => {
		const found = pattern();
		if (!found || searched().syntheticQuery) return new Map<number, string>();
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
		for (const match of matchesOn(line.text, found, replacement(), Boolean(searched().regex))) {
			if (overlapsProtectedSpan(match.column, match.length, lineSpans)) continue;
			entries.push([match.column, match.becomes]);
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
		// A list cut short by the match limit or by the scan's time budget is not all there is to replace.
		return shortfallBlocksReplace(shortfall(), SEARCH_LIMIT);
	};
	const executeReplace = async (skipConfirm: boolean) => {
		if (replaceBusy || noReplace(true)) return;
		const startRoot = state.workspace?.root;
		const startSearchId = latest;
		const query = effectiveAsked() || asked();
		const options = searched();
		const with_ = replacement();
		const found = pattern();
		if (!found) return;
		const activeGroups = groups();
		const paths = activeGroups.map(([path]) => path);
		const total = visibleHits().length;
		const protect = safeDocs();

		replaceBusy = true;
		setReplaceActive(true);
		let handoffToPreview = false;
		let ranReplace = false;
		replaceBody: try {
			if (!skipConfirm) {
				const safeTail = protect ? " Safe docs skips YAML keys, Markdown link targets, and invalid .plan.json edits." : "";
				const prompt = `Replace ${count(total, "match", "matches")} in ${count(paths.length, "file")} with ${with_ ? `“${with_}”` : "nothing"}? Each file that is written is first kept as it was in its local history.${safeTail}`;
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
			const onDiskPaths: string[] = [];
			const linesByPath: Record<string, number[]> = {};
			try {
				for (const [path, fileLines] of activeGroups) {
					if (state.workspace?.root !== startRoot) return;
					const at = canonical(path);
					const allowedLines = allowedLinesFor(path, fileLines);
					const isMd = /\.(md|markdown)$/i.test(path);
					const isPlan = /\.plan\.json$/i.test(path);
					const needsSafe = protect && (isMd || isPlan);

					const doc = documents.get(at);
					const tabbed = state.groups.some((group) => group.tabs.includes(at));
					if (!doc || doc.binary || (!tabbed && !state.dirty[at])) {
						// Route all closed-file replacements (including safeDocs and partial lines) through locked backend.replace.
						onDiskPaths.push(path);
						if (allowedLines) linesByPath[path] = [...allowedLines];
						continue;
					}

					const currentValue = doc.model.getValue();
					let mdProtected: Map<number, TextSpan[]> | undefined;
					if (needsSafe) {
						const sim = replaceSafeInText(currentValue, found, with_, Boolean(options.regex), {
							allowedLines,
							isMarkdown: isMd,
							isPlanJson: isPlan,
							safeDocs: protect,
						});
						skippedProtected += sim.skippedProtected;
						if (sim.invalidJson) {
							skippedJson.push(baseName(path));
							continue;
						}
						if (!sim.count) continue;
						if (isMd) mdProtected = protectedMarkdownSpans(currentValue);
					}
					const wasUnsaved = Boolean(state.dirty[at]);
					if (!wasUnsaved) {
						await backend.historyKeep(at).catch(() => {});
						if (state.workspace?.root !== startRoot) return;
					}
					const changed = replaceInModel(doc.model, found, with_, Boolean(options.regex), allowedLines, mdProtected);
					if (!changed) continue;
					done += changed;
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
						...(Object.keys(linesByPath).length ? { linesByPath } : {}),
					};
					const results = await backend.replace(query, with_, replaceOptions, onDiskPaths);
					if (state.workspace?.root !== startRoot) return;
					for (const result of results) {
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
			const differs = done !== total && !failed.length && !skippedProtected && !skippedJson.length
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
			await run();
		}
	};
	const replaceAll = () => executeReplace(false);
	const previewReplace = async () => {
		if (replaceBusy || noReplace(true)) return;
		const startRoot = state.workspace?.root;
		const startSearchId = latest;
		const options = searched();
		const with_ = replacement();
		const found = pattern();
		if (!found) return;
		const activeGroups = groups();
		const protect = safeDocs();

		type PreviewRow = {
			path: string;
			relPath: string;
			count: number;
			skippedProtected: number;
			invalidJson: boolean;
			sampleLine?: number;
			sampleSummary?: string;
		};
		const rows: PreviewRow[] = [];
		let totalMatches = 0;
		let totalProtected = 0;
		let invalidCount = 0;

		replaceBusy = true;
		setReplaceActive(true);
		let applyAfter = false;
		let openTarget: { path: string; line?: number } | null = null;
		try {
			for (const [path, fileLines] of activeGroups) {
				const text = await currentTextFor(path);
				if (state.workspace?.root !== startRoot || latest !== startSearchId) return;
				if (!text) continue;
				const isMd = /\.(md|markdown)$/i.test(path);
				const isPlan = /\.plan\.json$/i.test(path);
				const res = replaceSafeInText(text, found, with_, Boolean(options.regex), {
					allowedLines: allowedLinesFor(path, fileLines),
					isMarkdown: isMd,
					isPlanJson: isPlan,
					safeDocs: protect,
					maxSamples: 1,
				});
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
				title: `Replace preview: ${count(totalMatches, "match", "matches")} in ${count(readyFiles, "file")}`,
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
									]
										.filter(Boolean)
										.join(" · ") || "Local history snapshots kept before writing",
								},
							]
						: []),
					...rows.map((r, idx) => ({
						label: `${r.relPath} (${r.invalidJson ? "invalid JSON" : count(r.count, "change")})`,
						value: r.path,
						file: baseName(r.path),
						danger: r.invalidJson,
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
		if (status() === "failed") return `The search for “${asked()}” failed: ${failure()}${regex() ? " Check the regular expression, or switch .* off." : ""}`;
		if (status() === "idle") {
			return "Type what to find and press Enter. Filters: tag:, status:, ticket:, group:, kind:, heading:, task:open|done, prop:val. Up/Down recalls history.";
		}
		const filterTail = docFilterNote() ? ` [${docFilterNote()}]` : "";
		const dismissedTail = dismissedHitCount() ? ` (${dismissedHitCount()} dismissed)` : "";
		if (!visibleHits().length) {
			if (dismissedHitCount()) return `All ${count(hits().length, "result")} for “${asked()}” were dismissed.`;
			if (timedOut()) return timedOutEmpty(asked(), filterTail);
			return `Nothing found for “${asked()}”${filterTail}${narrowed() && !docFilterNote() ? " in the files chosen" : ""}. Check the spelling${switchesOn().length ? `, or switch ${switchesOn().join(" and ")} off` : ""}${narrowed() ? ", or look in more files" : ""}.`;
		}
		const countText = shortfallCount(shortfall(), count(visibleHits().length, "result"), hits().length, SEARCH_LIMIT);
		return `${countText} in ${count(groups().length, "file")} for “${asked()}”${filterTail}${dismissedTail}${narrowed() && !docFilterNote() ? ", in the files chosen" : ""}`;
	};

	const dismissBtnStyle = {
		flex: "none",
		display: "inline-flex",
		"align-items": "center",
		"justify-content": "center",
		width: "18px",
		height: "18px",
		padding: "0",
		color: "var(--muted)",
		"border-radius": "var(--radius-sm)",
	} as const;

	const HitRow = (props: { line: LineHit }) => {
		const first = () => props.line.matches[0]!;
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
		return (
			<Row
				class="tree-row hit"
				key={`${props.line.path}:${props.line.line}`}
				style={{ "padding-left": "22px" }}
				label={props.line.text.trim()}
				title={`Line ${props.line.line}${props.line.matches.length > 1 ? `, ${props.line.matches.length} matches` : ""}: ${props.line.text.trim()}`}
				// To stay or for a look, a result opens at its match.
				onKeep={() => void openFile(props.line.path, { keep: true, reveal: { line: props.line.line, column: first().column, endLine: props.line.line, endColumn: first().column + first().length } })}
				onActivate={() => void openFile(props.line.path, { preview: true, reveal: { line: props.line.line, column: first().column, endLine: props.line.line, endColumn: first().column + first().length } })}
			>
				<span class="meta">{props.line.line}</span>
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
				<button
					type="button"
					class="search-dismiss"
					style={dismissBtnStyle}
					tabindex={-1}
					title="Dismiss this result from list and Replace all"
					aria-label={`Dismiss match on line ${props.line.line}`}
					onClick={(e) => {
						e.stopPropagation();
						dismissLine(props.line.path, props.line.line);
					}}
				>
					<Icon name="close" />
				</button>
			</Row>
		);
	};

	return (
		<div class="panel-body" data-panel="search">
			<div class="panel-title">
				<span>Search</span>
			</div>
			<form
				class="search-form"
				role="search"
				onSubmit={(e) => (e.preventDefault(), void run())}
				// Trigger search on Enter for search/include/exclude inputs, never for Replace With or checkboxes.
				onKeyDown={(e) => {
					if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return;
					if (e.target.type === "checkbox" || e.target.hasAttribute("data-replace-input")) {
						e.preventDefault();
						return;
					}
					e.preventDefault();
					void run();
				}}
			>
				<div class="search-row">
					<button type="button" class="search-fold" title={replacing() ? "Hide the replace row" : "Replace across files"} aria-label="Replace across files" aria-expanded={replacing() ? "true" : "false"} onClick={() => setReplacing(!replacing())}>
						<Icon name={replacing() ? "chevron-down" : "chevron-right"} />
					</button>
					<input
						ref={(el) => ((input = el), queueMicrotask(() => el.focus()))}
						value={typed()}
						onInput={(e) => {
							historyIdx = -1;
							setTyped(e.currentTarget.value);
						}}
						id="search-input"
						data-autofocus=""
						aria-label="Search the workspace"
						placeholder="Search the workspace"
						onKeyDown={(e) => {
							const el = e.currentTarget;
							const hist = queryHistory();
							if (e.key === "ArrowUp" && hist.length && (historyIdx >= 0 || !el.value || (el.selectionStart === 0 && el.selectionEnd === 0))) {
								e.preventDefault();
								if (historyIdx < 0) historyDraft = el.value;
								historyIdx = Math.min(hist.length - 1, historyIdx + 1);
								const nextVal = hist[historyIdx] ?? "";
								el.value = nextVal;
								setTyped(nextVal);
								return;
							}
							if (e.key === "ArrowDown" && historyIdx >= 0) {
								e.preventDefault();
								historyIdx--;
								const nextVal = historyIdx < 0 ? historyDraft : (hist[historyIdx] ?? "");
								el.value = nextVal;
								setTyped(nextVal);
								return;
							}
							if (e.key === "ArrowDown" && focusRowsBelow(el)) e.preventDefault();
						}}
					/>
					<IconButton label="Match case" glyph="Aa" pressed={caseSensitive()} onClick={() => flip("caseSensitive", setCaseSensitive, caseSensitive())} />
					<IconButton label="Match whole word" title="Whole word" glyph="ab" pressed={wholeWord()} onClick={() => flip("wholeWord", setWholeWord, wholeWord())} />
					<IconButton label="Use a regular expression" title="Regular expression" glyph=".*" pressed={regex()} onClick={() => flip("regex", setRegex, regex())} />
					<IconButton
						label="Choose which files to search"
						title="Which files: to include, to exclude"
						icon="ellipsis"
						pressed={choosing()}
						onClick={() => {
							const nextChoosing = !choosing();
							setChoosing(nextChoosing);
							// Patterns that were narrowing the results stop when their boxes go, and start when they come back.
							if (status() !== "idle" && (include().trim() || exclude().trim())) void run({ choosing: nextChoosing });
						}}
					/>
				</div>
				<Show when={replacing()}>
					<div class="search-row">
						<span class="search-fold" aria-hidden="true" />
						<input data-replace-input="" aria-label="Replace with" placeholder={regex() ? "Replace with ($1 is the first group)" : "Replace with"} value={replacement()} onInput={(e) => setReplacement(e.currentTarget.value)} />
						<button
							type="button"
							class="search-replace"
							aria-disabled={noReplace() ? "true" : undefined}
							title={noReplace() || "Preview affected files and sample before/after changes before replacing"}
							onClick={() => (noReplace() ? notify(`${noReplace()}.`) : void previewReplace())}
						>
							Preview…
						</button>
						{/* Not the button's own "disabled": it keeps the keyboard, and says why it does nothing. */}
						<button type="button" class="search-replace" aria-disabled={noReplace() ? "true" : undefined} title={noReplace() || "Replace every match listed below, after asking"} onClick={() => (noReplace() ? notify(`${noReplace()}.`) : void replaceAll())}>
							Replace all
						</button>
					</div>
					<div class="search-row search-safe-row">
						<span class="search-fold" aria-hidden="true" />
						<label
							class="check search-safe-toggle"
							title="Skip matches in YAML frontmatter keys and Markdown link targets ](...) / [[...]], and validate .plan.json JSON syntax before writing"
						>
							<input type="checkbox" checked={safeDocs()} onChange={(e) => setSafeDocs(e.currentTarget.checked)} />
							<span>Safe docs (protect YAML keys, links & JSON)</span>
						</label>
					</div>
				</Show>
				<Show when={choosing()}>
					<div class="search-row">
						<span class="search-fold" aria-hidden="true" />
						<input aria-label="Files to include" title="Patterns with commas between: *.ssl, src/DueDates, docs/**/*.md. Empty for every file." placeholder="Files to include: *.ssl, src" value={include()} onInput={(e) => (setTicketScopeKey(null), setInclude(e.currentTarget.value))} />
					</div>
					<div class="search-row">
						<span class="search-fold" aria-hidden="true" />
						<input aria-label="Files to exclude" title="Patterns with commas between: tests, *.md. These are left out even when included above." placeholder="Files to exclude: tests, *.md" value={exclude()} onInput={(e) => (setTicketScopeKey(null), setExclude(e.currentTarget.value))} />
					</div>
				</Show>
				<div class="search-scopes" role="group" aria-label="Quick search scope">
					<button type="button" class={{ on: scopeActive("", "") }} title="Search all workspace files" onClick={() => applyScope("", "")}>
						All
					</button>
					<button
						type="button"
						class={{ on: scopeActive("", codeExcludeGlob()) }}
						title="Search code files only (exclude docs, design, schema, and catalogs)"
						onClick={() => applyScope("", codeExcludeGlob())}
					>
						Code
					</button>
					<button
						type="button"
						class={{ on: scopeActive(docsIncludeGlob(), "") }}
						title="Search project documentation, plans, schema, and Markdown files"
						onClick={() => applyScope(docsIncludeGlob(), "")}
					>
						Docs
					</button>
					<Show when={activeTicketScope()}>
						{(scope) => (
							<button
								type="button"
								class={{ on: ticketScopeKey() === scope().key }}
								title={scope().tip}
								onClick={() => applyTicketScope(scope().key)}
							>
								{scope().key}
							</button>
						)}
					</Show>
				</div>
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
			<p class={["hint", { warn: status() === "failed" }]} role="status">
				{summary()}
			</p>
			<Rows label="Search results">
				<For each={groups()} keyed={([path]) => path}>
					{(group) => {
						const path = () => group()[0];
						const list = () => group()[1];
						const places = createMemo(() => byPlace(list()));
						return (
							<RowGroup
								headClass="tree-row file-head"
								title={path()}
								head={
									<>
										<FileMark name={path()} />
										<span class="label">{rel(path())}</span>
										<span class="meta" title={count(matchesIn(list()), "match", "matches") + " in this file"}>
											{matchesIn(list())}
										</span>
										<button
											type="button"
											class="search-dismiss"
											style={dismissBtnStyle}
											tabindex={-1}
											title={`Dismiss ${rel(path())} from results and Replace all`}
											aria-label={`Dismiss ${rel(path())} from results`}
											onClick={(e) => {
												e.stopPropagation();
												dismissFile(path());
											}}
										>
											<Icon name="close" />
										</button>
									</>
								}
							>
								<For each={places()} keyed={([where]) => where}>
									{(place) => {
										const where = () => place()[0];
										const lines = () => place()[1];
										return (
											<Show
												when={where()}
												fallback={
													<For each={lines()} keyed={(line) => `${line.path}:${line.line}`}>
														{(line) => <HitRow line={line()} />}
													</For>
												}
											>
												<div role="group" aria-label={where()}>
													<div class="tree-row place" style={{ "padding-left": "16px" }} title={where()} aria-hidden="true">
														<span class="label">{where()}</span>
													</div>
													<For each={lines()} keyed={(line) => `${line.path}:${line.line}`}>
														{(line) => <HitRow line={line()} />}
													</For>
												</div>
											</Show>
										);
									}}
								</For>
							</RowGroup>
						);
					}}
				</For>
			</Rows>
		</div>
	);
}
