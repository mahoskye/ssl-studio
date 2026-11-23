// Workspace search, results grouped by file; and, from the same box, a
// replace across files. What would be replaced is shown in the results
// before anything is written, and nothing is written until it is confirmed.
// The search, the preview and the replace all find their matches with the
// one expression (src/shared/searchPattern.ts), so they agree.
import { Icon } from "../Icon";
import { FileMark } from "../FileMark";
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { symbolPath } from "../editor/regions";
import { session } from "../lsp/session";
import type { DocFile, SearchHit } from "../../shared/protocol";
import { backend } from "../backend";
import { choose } from "../dialogs";
import { activePath, canonical, documents, fileChangedOnDisk, isUntitled, notify, openFile, save, saveAll, setState, state } from "../state";
import { baseName, isInside, relativeTo } from "../../shared/paths";
import { parseCsv } from "../../shared/csv";
import { fileChosen } from "../../shared/fileGlob";
import { frontMatter, HEADING, many, one, plainMarkdown } from "../../shared/frontMatter";
import { DOC_FOLDERS, isCatalog, toneOf } from "../../shared/projectDocs";
import { matchesOn, SEARCH_LIMIT, searchPattern, type SearchOptions } from "../../shared/searchPattern";
import { outline } from "../../shared/outline";
import { tagSearchPattern, workspaceTags } from "../../shared/tags";
import { codeMatchesRef, descendantTickets, scriptsForTicket, ticketForFile, ticketWork } from "../../shared/workContext";
import { recall, remember } from "../graph/canvas";
import { docs } from "../project";
import { ticketAtHand } from "../projectDocs";
import { focusRowsBelow, IconButton, Row, RowGroup, Rows } from "./Rows";
import { showPanel } from "./registry";
import { byLine, markedColumns, segments, type LineHit } from "./searchLines";

const count = (n: number, oneWord: string, manyWord = `${oneWord}s`) => `${n} ${n === 1 ? oneWord : manyWord}`;

/** How much of a line is shown before its first match. */
const LEAD = 12;

/** The row for replacing is open. Kept while the panel is away, as what was typed in it is. */
const [replacing, setReplacing] = createSignal(false);
/** The rows for which files to look in are open. */
const [choosing, setChoosing] = createSignal(false);
const [replacement, setReplacement] = createSignal("");
const [include, setInclude] = createSignal("");
const [exclude, setExclude] = createSignal("");

/** Shows the Search panel scoped to a specific folder (relative to workspace root). */
export function findInFolder(relFolder: string) {
	const cleaned = relFolder.replace(/^[./\\]+|[\\/]+$/g, "").replace(/\\/g, "/");
	setInclude(cleaned ? `${cleaned}/**` : "");
	setChoosing(true);
	showPanel("search");
}

/** Shows the Search panel with its row for replacing open. */
export function showReplace() {
	setReplacing(true);
	showPanel("search");
}

/** Replaces every match in an open file's text (optionally restricted to `allowedLines`), as one step that undo takes back. */
function replaceInModel(model: monaco.editor.ITextModel, pattern: RegExp, with_: string, regex: boolean, allowedLines?: ReadonlySet<number>): number {
	const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
	for (let line = 1; line <= model.getLineCount(); line++) {
		if (allowedLines && !allowedLines.has(line)) continue;
		for (const match of matchesOn(model.getLineContent(line), pattern, with_, regex)) {
			edits.push({ range: new monaco.Range(line, match.column, line, match.column + match.length), text: match.becomes });
		}
	}
	if (!edits.length) return 0;
	model.pushStackElement();
	model.pushEditOperations([], edits, () => null);
	model.pushStackElement();
	return edits.length;
}

/** Replaces matches only on `allowedLines` (1-based) in raw file text, preserving original line endings. */
function replaceLinesInText(text: string, pattern: RegExp, with_: string, regex: boolean, allowedLines: ReadonlySet<number>): { text: string; count: number } {
	let replaced = 0;
	const parts = text.split(/(\r?\n)/);
	for (let at = 0; at < parts.length; at += 2) {
		const lineNumber = at / 2 + 1;
		if (!allowedLines.has(lineNumber)) continue;
		const line = parts[at]!;
		const found = matchesOn(line, pattern, with_, regex);
		if (!found.length) continue;
		replaced += found.length;
		let out = "";
		let from = 0;
		for (const each of found) {
			out += line.slice(from, each.column - 1) + each.becomes;
			from = each.column - 1 + each.length;
		}
		parts[at] = out + line.slice(from);
	}
	return { text: parts.join(""), count: replaced };
}

/** Scans a single in-memory text buffer using the exact same `searchPattern` + `matchesOn` walk as backend search. */
function scanTextBuffer(path: string, text: string, pattern: RegExp, isRegex: boolean, limit: number): SearchHit[] {
	const out: SearchHit[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length && out.length < limit; i++) {
		const line = lines[i]!;
		const found = matchesOn(line, pattern, "", isRegex);
		for (const m of found) {
			out.push({ path, line: i + 1, column: m.column, length: m.length, text: line });
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
const [searched, setSearched] = createSignal<SearchOptions>({});
const [failure, setFailure] = createSignal("");
const [docFilterNote, setDocFilterNote] = createSignal("");
/** True when post-filters (`heading:` / `task:`) narrowed results to specific lines within files. */
const [lineFiltered, setLineFiltered] = createSignal(false);
/** Per-file and per-line exclusions dismissed from the current result set before Replace All. */
const [dismissedFiles, setDismissedFiles] = createSignal<Set<string>>(new Set());
const [dismissedLines, setDismissedLines] = createSignal<Set<string>>(new Set());
let latest = 0;

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

type ParsedDocFilters = {
	text: string;
	tags: string[];
	statuses: string[];
	tickets: string[];
	parents: string[];
	groups: string[];
	kinds: string[];
	headings: string[];
	tasks: ("open" | "done" | "all")[];
	props: { key: string; value: string }[];
	/** Unknown lowercase `key:val` tokens that might be custom YAML frontmatter properties. */
	customProps: { key: string; value: string; raw: string }[];
};

const KNOWN_DOC_PROP_KEYS = new Set([
	"owner",
	"reviewer",
	"release",
	"priority",
	"version",
	"approved-by",
	"approvedby",
	"approved-date",
	"approveddate",
	"change-control",
	"changecontrol",
	"gxp-impact",
	"gxpimpact",
	"source",
	"blocks",
	"blocked-by",
	"blockedby",
	"supersedes",
	"superseded-by",
	"supersededby",
]);

const NON_PROP_SCHEMES = new Set(["http", "https", "file", "mailto", "data", "ftp", "ssh", "git"]);

/** Extracts structured metadata filter tokens from a search query string (supports quoted values). */
function parseDocFilterTokens(raw: string): ParsedDocFilters {
	const tags: string[] = [];
	const statuses: string[] = [];
	const tickets: string[] = [];
	const parents: string[] = [];
	const groups: string[] = [];
	const kinds: string[] = [];
	const headings: string[] = [];
	const tasks: ("open" | "done" | "all")[] = [];
	const props: { key: string; value: string }[] = [];
	const customProps: { key: string; value: string; raw: string }[] = [];

	const rest = raw
		.replace(/(?:^|\s)([A-Za-z][A-Za-z0-9_-]{1,}):(?:"([^"]+)"|'([^']+)'|(\S+))/g, (full, rawKey: string, dq?: string, sq?: string, bare?: string) => {
			const val = (dq ?? sq ?? bare ?? "").trim();
			if (!val) return full;
			const key = rawKey.toLowerCase();
			if (NON_PROP_SCHEMES.has(key) || val.startsWith("//") || val.startsWith("\\")) return full;
			if (key === "tag") {
				const clean = val.replace(/^#+/, "");
				if (!clean) return full;
				tags.push(clean);
				return " ";
			}
			if (key === "status") {
				statuses.push(val);
				return " ";
			}
			if (key === "ticket") {
				tickets.push(val);
				return " ";
			}
			if (key === "parent") {
				parents.push(val);
				return " ";
			}
			if (key === "group") {
				groups.push(val.toLowerCase());
				return " ";
			}
			if (key === "kind") {
				kinds.push(val.toLowerCase());
				return " ";
			}
			if (key === "heading") {
				headings.push(val);
				return " ";
			}
			if (key === "task") {
				const v = val.toLowerCase();
				if (v === "open" || v === "todo" || v === "unchecked") tasks.push("open");
				else if (v === "done" || v === "closed" || v === "checked") tasks.push("done");
				else if (v === "all" || v === "any") tasks.push("all");
				else return full;
				return " ";
			}
			if (KNOWN_DOC_PROP_KEYS.has(key)) {
				props.push({ key, value: val });
				return " ";
			}
			// Keep arbitrary lowercase `prop:val` as a candidate custom frontmatter property (avoid SSL `Me:sField`).
			if (rawKey === key && !/[A-Z]/.test(rawKey)) {
				customProps.push({ key, value: val, raw: full.trim() });
				return " ";
			}
			return full;
		})
		.replace(/\s+/g, " ")
		.trim();

	return { text: rest, tags, statuses, tickets, parents, groups, kinds, headings, tasks, props, customProps };
}

const normStatus = (s?: string) => (s ?? "").toLowerCase().replace(/[-_]+/g, " ").trim();
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** Reads a file's text from an open dirty editor buffer when available, else from disk. */
async function currentTextFor(path: string): Promise<string> {
	const at = canonical(path);
	const open = documents.get(at);
	if (open && !open.binary && state.dirty[at]) return open.model.getValue();
	return backend.read(path).then((r) => r.text, () => "");
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

export function Search() {
	let input!: HTMLInputElement;
	let historyIdx = -1;
	let historyDraft = "";

	const [workspaceFiles] = createResource(
		() => (state.workspace?.root ? `${state.workspace.root}#${state.treeVersion}` : false),
		() => backend.files().catch(() => [] as string[]),
	);

	const cleanDir = (dir?: string) => (dir ?? "").replace(/^[./\\]+|[\\/]+$/g, "").replace(/\\/g, "/");
	const docsRel = () => cleanDir(state.project?.docs ?? "docs");
	const plansRel = () => cleanDir(state.project?.plans ?? "design");
	const schemaRel = () => cleanDir(state.project?.schema ?? "schema");
	const codeExcludeGlob = () =>
		[
			docsRel() ? `${docsRel()}/**` : `${DOC_FOLDERS.tickets}/**, ${DOC_FOLDERS.specs}/**, ${DOC_FOLDERS.knowledge}/**, ${DOC_FOLDERS.registries}/**`,
			plansRel() ? `${plansRel()}/**` : "",
			schemaRel() ? `${schemaRel()}/**` : "",
			"README.md",
			"AGENTS.md",
			"**/INDEX.md",
		]
			.filter(Boolean)
			.join(", ");
	const docsIncludeGlob = () =>
		[
			docsRel() ? `${docsRel()}/**` : `${DOC_FOLDERS.tickets}/**, ${DOC_FOLDERS.specs}/**, ${DOC_FOLDERS.knowledge}/**, ${DOC_FOLDERS.registries}/**`,
			plansRel() ? `${plansRel()}/**` : "",
			schemaRel() ? `${schemaRel()}/**` : "",
			"*.md",
		]
			.filter(Boolean)
			.join(", ");
	const scopeActive = (inc: string, exc = "") => (choosing() ? include().trim() === inc && exclude().trim() === exc : !inc && !exc);

	const run = async () => {
		const rawQuery = input.value;
		const mine = ++latest;
		setDocFilterNote("");
		setLineFiltered(false);
		setDismissedFiles(new Set<string>());
		setDismissedLines(new Set<string>());
		if (!rawQuery) {
			setHits([]);
			setStatus("idle");
			return;
		}
		recordHistory(rawQuery);
		historyIdx = -1;
		setStatus("busy");
		setAsked(rawQuery);

		const parsed = !regex()
			? parseDocFilterTokens(rawQuery)
			: { text: rawQuery, tags: [], statuses: [], tickets: [], parents: [], groups: [], kinds: [], headings: [], tasks: [], props: [], customProps: [] };

		const baseInclude = choosing() ? include() : "";
		const baseExclude = choosing() ? exclude() : "";
		const root = state.workspace?.root;

		// Resolve candidate custom frontmatter `prop:val` tokens: keep as metadata filter when in Docs scope,
		// when combined with other metadata tokens, or when any workspace doc defines that frontmatter key.
		let activeCustomProps: { key: string; value: string }[] = [];
		let freeText = parsed.text;
		const hasKnownDocFilters = Boolean(
			parsed.tags.length ||
				parsed.statuses.length ||
				parsed.tickets.length ||
				parsed.parents.length ||
				parsed.groups.length ||
				parsed.kinds.length ||
				parsed.props.length,
		);
		const inDocsScope = scopeActive(docsIncludeGlob(), "");
		const customMatchedByPath = new Map<string, Record<string, string | string[]>>();

		if (parsed.customProps.length) {
			const mdDocs = docs().filter((d) => d.exists && !isCatalog(d) && /\.(md|markdown)$/i.test(d.path)).slice(0, 200);
			const keysSeen = new Set<string>();
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
			if (mine !== latest) return;
			const literalRestored: string[] = [];
			for (const cp of parsed.customProps) {
				if (inDocsScope || hasKnownDocFilters || keysSeen.has(cp.key)) {
					activeCustomProps.push({ key: cp.key, value: cp.value });
				} else {
					literalRestored.push(cp.raw);
				}
			}
			if (literalRestored.length) {
				freeText = `${freeText ? `${freeText} ` : ""}${literalRestored.join(" ")}`.trim();
			}
		}

		let effectiveQuery = freeText;
		let effectiveRegex = regex();
		let effectiveWhole = wholeWord();
		let effectiveCase = caseSensitive();
		let effectiveInclude = baseInclude;
		const effectiveExclude = baseExclude;

		const hasDocMetaFilters = hasKnownDocFilters || activeCustomProps.length > 0;
		const hasHeadingFilter = parsed.headings.length > 0;
		const hasTaskFilter = parsed.tasks.length > 0;

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
			// Intersect with active include/exclude scope (e.g. Active Ticket or custom include globs) instead of overwriting it!
			if (baseInclude.trim() || baseExclude.trim()) {
				matchedDocs = matchedDocs.filter((d) => {
					const relPath = relativeTo(root, d.path).replace(/\\/g, "/");
					return fileChosen(relPath, baseInclude, baseExclude);
				});
			}
			setDocFilterNote(`${filterNotes.join(" ")} (${matchedDocs.length} ${matchedDocs.length === 1 ? "doc" : "docs"})`);
			if (!matchedDocs.length) {
				setHits([]);
				setSearched({ regex: effectiveRegex, caseSensitive: effectiveCase, wholeWord: effectiveWhole });
				setStatus("done");
				return;
			}
			allowedDocSet = new Set(matchedDocs.map((d) => canonical(d.path)));
			effectiveInclude = matchedDocs.map((d) => relativeTo(root, d.path).replace(/\\/g, "/")).join(", ");
		} else if (hasHeadingFilter || hasTaskFilter) {
			setDocFilterNote(filterNotes.join(" "));
			if (!effectiveInclude.trim()) {
				effectiveInclude = "*.md, *.markdown";
			}
		}

		// Choose default search pattern when only metadata/heading/task tokens were entered with no free text.
		if (!effectiveQuery) {
			if (hasHeadingFilter) {
				const first = parsed.headings[0]!;
				effectiveQuery = first === "*" ? "^\\s{0,3}#{1,6}\\s+\\S" : `^\\s{0,3}#{1,6}\\s+.*${escapeRegex(first)}`;
				effectiveRegex = true;
				effectiveWhole = false;
			} else if (hasTaskFilter) {
				const mode = parsed.tasks[0]!;
				effectiveQuery =
					mode === "open"
						? "^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)+\\[ \\]"
						: mode === "done"
							? "^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)+\\[[xX]\\]"
							: "^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)+\\[[ xX]\\]";
				effectiveRegex = true;
				effectiveWhole = false;
			} else if (parsed.tags.length) {
				effectiveQuery = tagSearchPattern(parsed.tags[0]!);
				effectiveRegex = true;
				effectiveWhole = false;
			} else if (parsed.statuses.length) {
				effectiveQuery = "^status\\s*:";
				effectiveRegex = true;
				effectiveCase = false;
				effectiveWhole = false;
			} else if (parsed.tickets.length) {
				effectiveQuery = escapeRegex(parsed.tickets[0]!);
				effectiveRegex = true;
				effectiveCase = false;
				effectiveWhole = false;
			} else if (parsed.parents.length) {
				effectiveQuery = "^parent\\s*:";
				effectiveRegex = true;
				effectiveCase = false;
				effectiveWhole = false;
			} else if (parsed.props.length || activeCustomProps.length) {
				const firstKey = (parsed.props[0] ?? activeCustomProps[0])!.key;
				effectiveQuery = `^${escapeRegex(firstKey)}\\s*:`;
				effectiveRegex = true;
				effectiveCase = false;
				effectiveWhole = false;
			} else {
				effectiveQuery = "^(?:title\\s*:|#{1,6}\\s+)";
				effectiveRegex = true;
				effectiveCase = false;
				effectiveWhole = false;
			}
		}

		const options: SearchOptions = {
			regex: effectiveRegex,
			caseSensitive: effectiveCase,
			wholeWord: effectiveWhole,
			...(effectiveInclude || effectiveExclude ? { include: effectiveInclude, exclude: effectiveExclude } : {}),
		};
		setSearched(options);
		setEffectiveAsked(effectiveQuery);
		setLineFiltered(hasHeadingFilter || hasTaskFilter);

		try {
			const diskHits = await backend.search(effectiveQuery, options);
			if (mine !== latest) return;

			// Overlay unsaved dirty open editor buffers so freshly edited unsaved text is always searchable.
			const dirtyPaths = new Set<string>();
			const dirtyHits: SearchHit[] = [];
			let compiledPattern: RegExp | null = null;
			try {
				compiledPattern = searchPattern(effectiveQuery, options);
			} catch {
				compiledPattern = null;
			}
			if (compiledPattern) {
				for (const [docPath, doc] of documents) {
					const at = canonical(docPath);
					if (!state.dirty[at] || doc.binary) continue;
					if (allowedDocSet && !allowedDocSet.has(at)) continue;
					if (isUntitled(at)) {
						if (effectiveInclude.trim()) continue;
					} else if (root && isInside(root, at)) {
						const relPath = relativeTo(root, at).replace(/\\/g, "/");
						if (!fileChosen(relPath, effectiveInclude, effectiveExclude)) continue;
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

			// Enforce heading:/task: line-level constraints (only Markdown files & matching heading/task lines).
			if (hasHeadingFilter || hasTaskFilter) {
				merged = merged.filter((h) => {
					if (!/\.(md|markdown)$/i.test(h.path)) return false;
					if (hasHeadingFilter) {
						const m = HEADING.exec(h.text);
						if (!m) return false;
						const headingPlain = plainMarkdown(m[2]!).toLowerCase();
						if (!parsed.headings.every((wanted) => wanted === "*" || headingPlain.includes(wanted.toLowerCase()))) return false;
					}
					if (hasTaskFilter) {
						const matchesTask = parsed.tasks.every((mode) =>
							mode === "open" ? TASK_OPEN_RE.test(h.text) : mode === "done" ? TASK_DONE_RE.test(h.text) : TASK_ANY_RE.test(h.text),
						);
						if (!matchesTask) return false;
					}
					return true;
				});
			}

			if (merged.length > SEARCH_LIMIT) merged = merged.slice(0, SEARCH_LIMIT);
			setHits(merged);
			setStatus("done");
		} catch (e: any) {
			if (mine !== latest) return;
			setHits([]);
			setFailure(String(e?.message ?? e));
			setStatus("failed");
		}
	};

	// A search asked for from elsewhere is put in the box and run, as if it had been typed.
	createEffect(() => {
		const wanted = request();
		if (!wanted || !input) return;
		setRequest(null);
		input.value = wanted.query;
		setTyped(wanted.query);
		setRegex(Boolean(wanted.regex));
		setWholeWord(Boolean(wanted.wholeWord));
		setCaseSensitive(Boolean(wanted.caseSensitive));
		const nextInc = wanted.include ?? "";
		const nextExc = wanted.exclude ?? "";
		setInclude(nextInc);
		setExclude(nextExc);
		setChoosing(Boolean(nextInc.trim() || nextExc.trim()));
		void run();
	});
	// A switch changes what the results on screen mean, so they are fetched again.
	const flip = (set: (v: boolean) => void, now: boolean) => {
		set(!now);
		if (status() !== "idle") void run();
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

	// Where each line sits: SSL region › procedure (from starlims-lsp), Markdown # Heading (from shared/outline),
	// or CSV/TSV Row Key · Column (from shared/csv). Reads dirty open buffers when present so line numbers stay exact.
	let placesSeq = 0;
	const [places] = createResource(groups, async (list) => {
		const mine = ++placesSeq;
		const out = new Map<string, string>();
		let sslChecked = 0;
		for (const [path, lines] of list) {
			if (mine !== placesSeq) return out;
			if (/\.(md|markdown)$/i.test(path)) {
				const text = await currentTextFor(path);
				if (!text || mine !== placesSeq) continue;
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
				if (!text || mine !== placesSeq) continue;
				for (const line of lines) {
					const crumb = csvBreadcrumbForLine(text, line.line, line.matches[0]?.column ?? 1);
					if (crumb) out.set(`${path}:${line.line}`, crumb);
				}
				continue;
			}
			if (!/\.(ssl|srvscr|ds)$/i.test(path) || sslChecked >= 60) continue;
			sslChecked++;
			const model = await session.ensureModel(monaco.Uri.file(path).toString());
			if (mine !== placesSeq) return out;
			if (!model || model.getLanguageId() !== "ssl") continue;
			const symbols = await session.documentSymbols(model).catch(() => []);
			if (mine !== placesSeq) return out;
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
	});
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
	const narrowed = () => Boolean(searched().include?.trim() || searched().exclude?.trim());

	const activeTicketScope = createMemo(() => {
		const root = state.workspace?.root;
		const allDocs = docs();
		const key = state.settings.activeTicket?.trim() || ticketForFile(allDocs, activePath(), root) || ticketAtHand();
		if (!key) return null;
		const found = allDocs.find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === key.toLowerCase());
		if (!found) return null;
		const descendants = descendantTickets(allDocs, key);
		const globs = new Set<string>();
		const addTicketTree = (ticketDoc: typeof found) => {
			globs.add(relativeTo(root, ticketDoc.path).replace(/\\/g, "/"));
			if (ticketDoc.ticketFolder) {
				globs.add(`${relativeTo(root, ticketDoc.ticketFolder).replace(/\\/g, "/")}/**`);
			}
			const tKey = ticketDoc.ticket;
			if (!tKey) return;
			for (const group of ticketWork(allDocs, tKey)) {
				if (group.kind === "ticket") continue;
				for (const ref of group.files) {
					globs.add(relativeTo(root, ref.path).replace(/\\/g, "/"));
				}
			}
		};
		addTicketTree(found);
		for (const desc of descendants) addTicketTree(desc);
		// Resolve referenced scripts across the ticket & all descendant tickets against real workspace paths.
		const refs = scriptsForTicket(allDocs, key, { includeDescendants: true });
		let resolvedScripts = 0;
		if (refs.length) {
			const allWs = workspaceFiles() ?? [];
			for (const filePath of allWs) {
				if (refs.some((ref) => codeMatchesRef(filePath, ref, root))) {
					globs.add(relativeTo(root, filePath).replace(/\\/g, "/"));
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
			glob: [...globs].filter(Boolean).join(", "),
			tip: `Search ${key}${extras.length ? ` (${extras.join(", ")})` : ""}, its folder, and all linked specs/plans/decisions`,
		};
	});

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
		if (next) void run();
	};
	const hasQueryToken = (token: string) => {
		const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(?:^|\\s)${esc}(?=\\s|$)`, "i").test(typed());
	};
	const showDocChips = () =>
		scopeActive(docsIncludeGlob(), "") ||
		Boolean(docFilterNote()) ||
		/\b(?:tag|status|ticket|parent|group|kind|heading|task):/i.test(typed());

	const applyScope = (inc: string, exc = "") => {
		setInclude(inc);
		setExclude(exc);
		setChoosing(Boolean(inc || exc));
		if (typed().trim()) void run();
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
	/** What each marked match of a line would become, by the column it starts at. */
	const becomes = (line: LineHit) => {
		const found = pattern();
		return new Map(found ? matchesOn(line.text, found, replacement(), Boolean(searched().regex)).map((match) => [match.column, match.becomes] as const) : []);
	};
	/** Why "Replace all" cannot be pressed now; "" when it can. */
	const noReplace = () => {
		if (status() === "busy") return "The search is still running";
		if (status() !== "done" || !visibleHits().length) return "Search for something first: what is found is what is replaced";
		if (hits().length >= SEARCH_LIMIT) return `There are ${SEARCH_LIMIT} results or more, and only the first are listed: narrow the search before replacing`;
		return "";
	};
	const replaceAll = async () => {
		if (noReplace()) return;
		const query = effectiveAsked() || asked();
		const options = searched();
		const with_ = replacement();
		const found = pattern();
		if (!found) return;
		const activeGroups = groups();
		const paths = activeGroups.map(([path]) => path);
		const total = visibleHits().length;
		const answer = await choose(
			`Replace ${count(total, "match", "matches")} in ${count(paths.length, "file")} with ${with_ ? `“${with_}”` : "nothing"}? Each file that is written is first kept as it was in its local history.`,
			["Replace"],
		);
		if (answer !== "Replace") return;
		setStatus("busy");
		let done = 0;
		let files = 0;
		const unsaved: string[] = [];
		const failed: string[] = [];
		const onDiskFull: string[] = [];
		const skipLines = dismissedLines();
		const restrictByLine = lineFiltered();
		try {
			for (const [path, fileLines] of activeGroups) {
				const at = canonical(path);
				const hasPartialLines =
					restrictByLine ||
					[...skipLines].some((k) => k.startsWith(`${at}:`));
				const allowedLines = hasPartialLines ? new Set(fileLines.map((l) => l.line)) : undefined;

				const doc = documents.get(at);
				const tabbed = state.groups.some((group) => group.tabs.includes(at));
				if (!doc || doc.binary || (!tabbed && !state.dirty[at])) {
					if (!allowedLines) {
						onDiskFull.push(path);
						continue;
					}
					// File on disk with specific dismissed/filtered lines: replace only allowed lines safely.
					try {
						const read = await backend.read(path);
						if (read.binary) continue;
						await backend.historyKeep(path).catch(() => {});
						const res = replaceLinesInText(read.text, found, with_, Boolean(options.regex), allowedLines);
						if (!res.count) continue;
						await backend.write(path, res.text, true);
						done += res.count;
						files++;
						await fileChangedOnDisk(path);
					} catch (err: any) {
						failed.push(`${baseName(path)}: ${err?.message ?? err}`);
					}
					continue;
				}
				const wasUnsaved = Boolean(state.dirty[at]);
				if (!wasUnsaved) await backend.historyKeep(at).catch(() => {});
				const changed = replaceInModel(doc.model, found, with_, Boolean(options.regex), allowedLines);
				if (!changed) continue;
				done += changed;
				files++;
				if (wasUnsaved) unsaved.push(path);
				else if (!(await save(at, { format: false }))) failed.push(`${baseName(path)}: it is changed in the editor, and could not be saved`);
			}
			for (const result of onDiskFull.length ? await backend.replace(query, with_, options, onDiskFull) : []) {
				if (result.error) failed.push(`${baseName(result.path)}: ${result.error}`);
				if (!result.count) continue;
				done += result.count;
				files++;
				await fileChangedOnDisk(result.path);
			}
		} catch (e: any) {
			failed.push(String(e?.message ?? e));
		}
		setState("treeVersion", (v) => v + 1);
		const differs = done !== total && !failed.length ? ` ${count(total, "match", "matches")} were listed: a file has changed since the search.` : "";
		const note = `Replaced ${count(done, "match", "matches")} in ${count(files, "file")}.${differs}`;
		if (unsaved.length) {
			notify(
				`${note} ${unsaved.length === 1 ? `${baseName(unsaved[0]!)} had unsaved changes: it is changed in the editor and not saved.` : `${unsaved.length} files had unsaved changes: they are changed in the editor and not saved.`}`,
				"info",
				{ label: "Save all", run: () => void saveAll() },
			);
		} else notify(note);
		if (failed.length) notify(`Not replaced: ${failed.join("; ")}`, "error");
		await run();
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
			return `Nothing found for “${asked()}”${filterTail}${narrowed() && !docFilterNote() ? " in the files chosen" : ""}. Check the spelling${switchesOn().length ? `, or switch ${switchesOn().join(" and ")} off` : ""}${narrowed() ? ", or look in more files" : ""}.`;
		}
		return `${hits().length >= SEARCH_LIMIT ? `The first ${SEARCH_LIMIT} results` : count(visibleHits().length, "result")} in ${count(groups().length, "file")} for “${asked()}”${filterTail}${dismissedTail}${narrowed() && !docFilterNote() ? ", in the files chosen" : ""}`;
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
		// A line cut short for the list cannot say what a match near its cut would become: it is only marked.
		const after = createMemo(() => (replacing() && props.line.text.length < 400 ? becomes(props.line) : null));
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
							) : after()?.has(part.column!) ? (
								// What is there now, struck out, and what would stand in its place.
								<>
									<del>{part.text}</del>
									<span class="visually-hidden"> becomes </span>
									<ins>{after()!.get(part.column!)}</ins>
									<span class="visually-hidden"> </span>
								</>
							) : (
								<mark>{part.text}</mark>
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
				// With more than one box a form no longer sends itself on Enter: each box asks for the search.
				onKeyDown={(e) => e.key === "Enter" && e.target instanceof HTMLInputElement && (e.preventDefault(), void run())}
			>
				<div class="search-row">
					<button type="button" class="search-fold" title={replacing() ? "Hide the replace row" : "Replace across files"} aria-label="Replace across files" aria-expanded={replacing()} onClick={() => setReplacing(!replacing())}>
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
					<IconButton label="Match case" glyph="Aa" pressed={caseSensitive()} onClick={() => flip(setCaseSensitive, caseSensitive())} />
					<IconButton label="Match whole word" title="Whole word" glyph="ab" pressed={wholeWord()} onClick={() => flip(setWholeWord, wholeWord())} />
					<IconButton label="Use a regular expression" title="Regular expression" glyph=".*" pressed={regex()} onClick={() => flip(setRegex, regex())} />
					<IconButton
						label="Choose which files to search"
						title="Which files: to include, to exclude"
						icon="ellipsis"
						pressed={choosing()}
						onClick={() => {
							setChoosing(!choosing());
							// Patterns that were narrowing the results stop when their boxes go, and start when they come back.
							if (status() !== "idle" && (include().trim() || exclude().trim())) void run();
						}}
					/>
				</div>
				<Show when={replacing()}>
					<div class="search-row">
						<span class="search-fold" aria-hidden="true" />
						<input aria-label="Replace with" placeholder={regex() ? "Replace with ($1 is the first group)" : "Replace with"} value={replacement()} onInput={(e) => setReplacement(e.currentTarget.value)} />
						{/* Not the button's own "disabled": it keeps the keyboard, and says why it does nothing. */}
						<button type="button" class="search-replace" aria-disabled={noReplace() ? "true" : undefined} title={noReplace() || "Replace every match listed below, after asking"} onClick={() => (noReplace() ? notify(`${noReplace()}.`) : void replaceAll())}>
							Replace all
						</button>
					</div>
				</Show>
				<Show when={choosing()}>
					<div class="search-row">
						<span class="search-fold" aria-hidden="true" />
						<input aria-label="Files to include" title="Patterns with commas between: *.ssl, src/DueDates, docs/**/*.md. Empty for every file." placeholder="Files to include: *.ssl, src" value={include()} onInput={(e) => setInclude(e.currentTarget.value)} />
					</div>
					<div class="search-row">
						<span class="search-fold" aria-hidden="true" />
						<input aria-label="Files to exclude" title="Patterns with commas between: tests, *.md. These are left out even when included above." placeholder="Files to exclude: tests, *.md" value={exclude()} onInput={(e) => setExclude(e.currentTarget.value)} />
					</div>
				</Show>
				<div class="search-scopes" role="group" aria-label="Quick search scope">
					<button type="button" classList={{ on: scopeActive("", "") }} title="Search all workspace files" onClick={() => applyScope("", "")}>
						All
					</button>
					<button
						type="button"
						classList={{ on: scopeActive("", codeExcludeGlob()) }}
						title="Search code files only (exclude docs, design, schema, and catalogs)"
						onClick={() => applyScope("", codeExcludeGlob())}
					>
						Code
					</button>
					<button
						type="button"
						classList={{ on: scopeActive(docsIncludeGlob(), "") }}
						title="Search project documentation, plans, schema, and Markdown files"
						onClick={() => applyScope(docsIncludeGlob(), "")}
					>
						Docs
					</button>
					<Show when={activeTicketScope()}>
						{(scope) => (
							<button
								type="button"
								classList={{ on: scopeActive(scope().glob, "") }}
								title={scope().tip}
								onClick={() => applyScope(scope().glob, "")}
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
										classList={{ on: hasQueryToken(tok) }}
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
										classList={{ on: hasQueryToken(tok) }}
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
							classList={{ on: hasQueryToken("task:open") }}
							title="Match unchecked checklist tasks (- [ ])"
							onClick={() => toggleQueryToken("task:open")}
						>
							task:open
						</button>
					</div>
				</Show>
			</form>
			<p class="hint" classList={{ warn: status() === "failed" }} role="status">
				{summary()}
			</p>
			<Rows label="Search results">
				<For each={groups()}>
					{([path, list]) => (
						<RowGroup
							headClass="tree-row file-head"
							title={path}
							head={
								<>
									<FileMark name={path} />
									<span class="label">{rel(path)}</span>
									<span class="meta" title={count(matchesIn(list), "match", "matches") + " in this file"}>
										{matchesIn(list)}
									</span>
									<button
										type="button"
										class="search-dismiss"
										style={dismissBtnStyle}
										tabindex={-1}
										title={`Dismiss ${rel(path)} from results and Replace all`}
										aria-label={`Dismiss ${rel(path)} from results`}
										onClick={(e) => {
											e.stopPropagation();
											dismissFile(path);
										}}
									>
										<Icon name="close" />
									</button>
								</>
							}
						>
							<For each={byPlace(list)}>
								{([where, lines]) => (
									<Show when={where} fallback={<For each={lines}>{(line) => <HitRow line={line} />}</For>}>
										<div role="group" aria-label={where}>
											<div class="tree-row place" style={{ "padding-left": "16px" }} title={where} aria-hidden="true">
												<span class="label">{where}</span>
											</div>
											<For each={lines}>{(line) => <HitRow line={line} />}</For>
										</div>
									</Show>
								)}
							</For>
						</RowGroup>
					)}
				</For>
			</Rows>
		</div>
	);
}
