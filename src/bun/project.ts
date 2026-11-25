// A project is a workspace folder with `.ssl-studio/project.toml`, a
// README.md and an AGENTS.md at its root. The IDE writes all three once, from
// the templates below, and after that only reads them: project.toml is edited
// as text, so its comments survive.
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { decode, decodePart, textOf } from "./encoding";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CATALOG_FILE, catalogStale, fenced, hasCatalogPlace } from "../shared/catalog";
import { checkCodeCitations } from "../shared/codeCitations";
import { parseCsv, tally, type Table } from "../shared/csv";
import { findDuplicateHeadings, orphanDocChecks, staleDocChecks } from "../shared/docChecks";
import { fileLinks, frontPaths, type DocLink } from "../shared/docLinks";
import { checkTables } from "../shared/docTables";
import { frontMatter, many, one, summaryOf, titleOf } from "../shared/frontMatter";
import { documentHeadings, findHeadingLine } from "../shared/markdownEdit";
import { buildDocNameIndex, lookupInIndex, nameForIndexed, namePlaces } from "../shared/namedLinks";
import { areaPath, CATALOG_AREAS, CATALOG_FILES_MAX, catalogItems, catalogTemplate, DOC_FOLDERS, fileItems, isCatalog, isFileArea, isPrompt, OPTIONAL_CATALOGS, SCHEMAS, STATE_FILE, toneOf, type AreaFolders, type DocArea, type FileArea } from "../shared/projectDocs";
import { keysIn, rowsByTicket, ticketColumn } from "../shared/registryTickets";
import { findUndocumentedSqlRefs, schemaDocKeys } from "../shared/schemaIndex";
import { diffSqlAgainstSchemaMarkdown, extractSqlObjects } from "../shared/sqlSchema";
import { extractTags } from "../shared/tags";
import { tasks as tasksIn, taskTally } from "../shared/tasks";
import { classifyTicketEntries, type ScannedTicketEntry } from "../shared/ticketBundle";
import type { AuditCitationIssue, DocAuditResult, DocFile, LinkTo, ManifestFile, NameIn, OpenTaskItem, Project, SchemaDriftItem, Settings, UndocumentedSchemaRef, WorkspaceDocIssue } from "../shared/protocol";
import { workspaceDir } from "./paths";
import { isLocalModelRef } from "./agent";
import { assertPathInsideRoot, isPathInsideRoot, withSep, WorkspaceFiles } from "./workspace";

export const PROJECT_FILE = "project.toml";
export const DOC_LIMIT = 500;
export const SCHEMA_DOC_LIMIT = 2000;
const SCRIPT = /\.(ssl|srvscr|ds)$/i;
/** Sentences only the templates hold: a file that still has one has not been written yet. */
const PLACEHOLDER: Record<string, string> = {
	"README.md": "Say what this project is for, in a sentence or two.",
	"AGENTS.md": "Say what the scripts here do and who uses them.",
};

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
/** A folder inside the project: relative, and never climbing out of it. */
const folder = (value: unknown, fallback: string) => {
	const said = text(value);
	if (!said || isAbsolute(said)) return fallback;
	// "./docs" and "docs/" are "docs": one spelling, so that a path made from it is the path the files have.
	const parts = said.split(/[\\/]+/).filter((part) => part && part !== ".");
	if (parts.includes("..")) return fallback;
	return parts.length ? parts.join("/") : ".";
};

export async function readProject(root: string): Promise<Project> {
	const path = join(workspaceDir(root), PROJECT_FILE);
	const inside = isPathInsideRoot(root, path, true);
	const project: Project = { configured: inside && existsSync(path), path, name: basename(root), description: "", docs: "docs", schema: "schema", tests: "tests", code: "src", plans: "design" };
	if (!inside) {
		project.error = `outside the workspace: ${path}`;
		return project;
	}
	if (!project.configured) return project;
	try {
		const toml = Bun.TOML.parse(await Bun.file(path).text()) as Record<string, any>;
		project.name = text(toml.project?.name) ?? project.name;
		project.description = text(toml.project?.description) ?? "";
		for (const key of ["docs", "schema", "tests", "code"] as const) project[key] = folder(toml.folders?.[key], project[key]);
		project.agentModel = text(toml.agent?.model);
		const preset = text(toml.style?.preset);
		if (preset === "house" || preset === "server") project.stylePreset = preset;
	} catch (e: any) {
		project.error = String(e?.message ?? e);
	}
	return project;
}

/** The settings a project chooses for everyone who opens it. Never emits a non-local (potentially paid) model. */
export function projectSettings(project: Project): Partial<Settings> {
	return {
		...(isLocalModelRef(project.agentModel) ? { agentModel: project.agentModel } : {}),
		stylePreset: project.stylePreset,
	};
}

/** The file's name as it is on disk, whatever its case (readme.md, Readme.md). */
function found(root: string, name: string): string | undefined {
	try {
		return readdirSync(root).find((f) => f.toLowerCase() === name.toLowerCase());
	} catch {
		return undefined;
	}
}

/** High-resolution cache stamp capturing size, mtime, ctime, and inode to prevent same-ms / same-size stale cache hits. */
const fileStamp = (st: { size: number; mtimeMs: number; ctimeMs: number; ino: number }) =>
	`${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;

const ESCAPES_RELATIVE = /^\.\.(?:[\\/]|$)/;
const foldFsPath = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
const isUnderDir = (path: string, dir: string) => foldFsPath(path).startsWith(withSep(foldFsPath(dir)));

/** Lexical + realpath containment check ensuring `target` stays inside `root` (blocks `..`, escaping symlinks, and dangling symlink escapes). */
export function isInsideWorkspace(root: string, target: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	const rel = relative(resolvedRoot, resolvedTarget);
	if (ESCAPES_RELATIVE.test(rel) || isAbsolute(rel)) return false;
	return isPathInsideRoot(resolvedRoot, resolvedTarget, false);
}

/** Checks workspace containment BEFORE probing existence, then verifies realpath containment to avoid outside-root oracles. */
function existsInWorkspace(root: string, target: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	const rel = relative(resolvedRoot, resolvedTarget);
	if (ESCAPES_RELATIVE.test(rel) || isAbsolute(rel)) return false;
	if (!isPathInsideRoot(resolvedRoot, resolvedTarget, false)) return false;
	return existsSync(resolvedTarget);
}

/** The most of a small snippet that is read for its header comment. */
const HEAD_BYTES = 64 * 1024;
/** Maximum bytes read per file when indexing Markdown metadata/tasks/links or SQL schema objects (1 MB). */
const INDEX_BYTES = 1024 * 1024;
/** A registry larger than this is listed without being read. */
const REGISTRY_BYTES = 4 * 1024 * 1024;
const MARKDOWN = /\.(md|markdown)$/i;

const headRead = new Map<string, { stamp: string; text: string }>();
const HEAD_KEPT = 2000;

async function head(path: string, maxBytes = HEAD_BYTES): Promise<string> {
	try {
		const st = statSync(path);
		const stamp = `${fileStamp(st)}:${maxBytes}`;
		const kept = headRead.get(path);
		if (kept && kept.stamp === stamp) {
			headRead.delete(path);
			headRead.set(path, kept);
			return kept.text;
		}
		const file = Bun.file(path);
		const decoded = decodePart(new Uint8Array(await file.slice(0, maxBytes).arrayBuffer()), file.size > maxBytes);
		// Keep raw text cache bounded to smaller heads; 1 MB files use summary caches below.
		if (maxBytes <= HEAD_BYTES) {
			if (headRead.size >= HEAD_KEPT) headRead.delete(headRead.keys().next().value!);
			headRead.set(path, { stamp, text: decoded });
		}
		return decoded;
	} catch {
		return "";
	}
}

const sqlObjectsCache = new Map<string, { stamp: string; objects: string[] }>();
const SQL_OBJECTS_KEPT = 4000;

async function cachedSqlObjects(path: string): Promise<string[] | undefined> {
	try {
		const st = statSync(path);
		const stamp = fileStamp(st);
		const kept = sqlObjectsCache.get(path);
		if (kept && kept.stamp === stamp) {
			sqlObjectsCache.delete(path);
			sqlObjectsCache.set(path, kept);
			return kept.objects.length ? kept.objects : undefined;
		}
		const text = await head(path, INDEX_BYTES);
		const set = new Set<string>();
		if (text) {
			for (const o of extractSqlObjects(text, { includeAlter: true })) {
				if (o.name) set.add(o.name);
				if (o.bareName) set.add(o.bareName);
			}
		}
		const objects = [...set];
		if (sqlObjectsCache.size >= SQL_OBJECTS_KEPT) sqlObjectsCache.delete(sqlObjectsCache.keys().next().value!);
		sqlObjectsCache.set(path, { stamp, objects });
		return objects.length ? objects : undefined;
	} catch {
		return undefined;
	}
}

/** Safe file modification time (ms epoch) for staleness checks. */
function mtimeOf(path: string): number | undefined {
	try {
		return Math.round(statSync(path).mtimeMs);
	} catch {
		return undefined;
	}
}

/** What a plan says of itself: ticket, title, status, targets, test scripts/cases, and node docs; empty when unreadable. */
async function planSays(path: string): Promise<{
	ticket: string;
	title: string;
	status: string;
	codeRefs: string[];
	testScripts: string[];
	planTests: { name: string; given?: string; expect?: string }[];
	nodeDocs: string[];
}> {
	try {
		const plan = await Bun.file(path).json();
		const word = (value: unknown) => (typeof value === "string" ? value.trim() : "");
		const refs = new Set<string>();
		const testScriptSet = new Set<string>();
		const nodeDocSet = new Set<string>();
		const pushInto = (set: Set<string>, val: unknown) => {
			if (typeof val === "string" && val.trim()) set.add(val.trim().split("\\").join("/"));
			else if (val && typeof val === "object") {
				const rec = val as { path?: unknown; script?: unknown };
				if (typeof rec.path === "string" && rec.path.trim()) set.add(rec.path.trim().split("\\").join("/"));
				if (typeof rec.script === "string" && rec.script.trim()) set.add(rec.script.trim().split("\\").join("/"));
			}
		};
		if (Array.isArray(plan?.targets)) {
			for (const t of plan.targets) {
				pushInto(refs, t);
				pushInto(nodeDocSet, t);
			}
		}
		if (Array.isArray(plan?.scripts)) for (const s of plan.scripts) pushInto(refs, s);
		if (Array.isArray(plan?.built?.units)) {
			for (const u of plan.built.units) pushInto(refs, (u as { script?: unknown })?.script);
		}
		if (typeof plan?.built?.tests?.script === "string") pushInto(testScriptSet, plan.built.tests.script);
		if (Array.isArray(plan?.testScripts)) for (const ts of plan.testScripts) pushInto(testScriptSet, ts);
		if (Array.isArray(plan?.nodes)) {
			for (const node of plan.nodes) {
				if (Array.isArray((node as { docs?: unknown })?.docs)) {
					for (const d of (node as { docs: unknown[] }).docs) pushInto(nodeDocSet, d);
				}
			}
		}
		const planTests: { name: string; given?: string; expect?: string }[] = [];
		if (Array.isArray(plan?.tests)) {
			for (const tc of plan.tests) {
				if (!tc || typeof tc !== "object") continue;
				const rec = tc as { title?: unknown; name?: unknown; given?: unknown; expect?: unknown };
				const name = word(rec.title) || word(rec.name);
				if (!name) continue;
				const given = word(rec.given);
				const expect = word(rec.expect);
				planTests.push({ name, ...(given ? { given } : {}), ...(expect ? { expect } : {}) });
			}
		}
		return {
			ticket: word(plan?.ticket),
			title: word(plan?.title),
			status: word(plan?.status),
			codeRefs: [...refs],
			testScripts: [...testScriptSet],
			planTests,
			nodeDocs: [...nodeDocSet],
		};
	} catch {
		return { ticket: "", title: "", status: "", codeRefs: [], testScripts: [], planTests: [], nodeDocs: [] };
	}
}

const CODE_FILE_EXT_RE = /\.(ssl|srvscr|ds|sql|ddl|pks|pkb|xfd|xml|hl7|astm)$/i;
const INLINE_CODE_FILE_RE = /`([A-Za-z0-9_./\\-]+\.(?:ssl|srvscr|ds|sql|ddl|pks|pkb|xfd|xml|hl7|astm))`/gi;
const REGISTRY_CODE_COL_RE = /^(path|file|script|scripts|where|used[\s_-]*by|source|object)$/i;

/** Extracts workspace-relative code/SQL file references from Markdown links, `source:` frontmatter, and inline code mentions. */
function markdownCodeRefs(root: string, path: string, text: string, precomputedLinks?: readonly DocLink[]): string[] {
	const refs = new Set<string>();
	const addPath = (raw: string) => {
		const cleaned = raw.trim().split("\\").join("/").replace(/^\.\//, "");
		if (!cleaned) return;
		if (CODE_FILE_EXT_RE.test(cleaned)) refs.add(cleaned);
	};
	const fm = frontMatter(text);
	for (const s of many(fm.values.source)) addPath(s);
	for (const link of precomputedLinks ?? linksIn(path, text)) {
		if (!CODE_FILE_EXT_RE.test(link.file)) continue;
		const target = linkTarget(root, path, link.file);
		const rel = relative(root, target).split(sep).join("/");
		if (!ESCAPES_RELATIVE.test(rel) && !isAbsolute(rel)) refs.add(rel);
	}
	if (text.includes("`")) {
		const fences = fenced(text);
		const lines = text.split(/\r?\n/);
		let offset = 0;
		for (let i = 0; i < lines.length; i++) {
			const ln = lines[i]!;
			const start = offset;
			offset += ln.length + (text[start + ln.length] === "\r" ? 2 : 1);
			if (i < fm.lines || !ln.includes("`")) continue;
			if (fences.some(([from, to]) => start >= from && start < to)) continue;
			for (const m of ln.matchAll(INLINE_CODE_FILE_RE)) addPath(m[1]!);
		}
	}
	return [...refs];
}

/** Extracts code/script tokens referenced by a CSV registry (and per-ticket script lists when a ticket column exists). */
function registryCodeInfo(
	table: Table,
	knownTickets: ReadonlySet<string>,
): { codeRefs: string[]; ticketCodeRefs?: Record<string, string[]> } {
	const codeCols: number[] = [];
	table.header.forEach((cell, idx) => {
		if (REGISTRY_CODE_COL_RE.test(cell.text.trim())) codeCols.push(idx);
	});
	if (!codeCols.length) return { codeRefs: [] };
	const allRefs = new Set<string>();
	const byTicket = new Map<string, Set<string>>();
	const tCol = ticketColumn(table);
	for (const row of table.rows) {
		const rowRefs: string[] = [];
		for (const ci of codeCols) {
			const raw = row[ci]?.text ?? "";
			for (const part of raw.split(/[,;]+/)) {
				const tok = part.trim().split("\\").join("/").replace(/^\.\//, "");
				if (!tok || tok.length > 180) continue;
				// Ignore pure numbers/dates/status words; keep paths, dotted module names, or identifier-like script names.
				if (!/[A-Za-z]/.test(tok) || /\s/.test(tok)) continue;
				rowRefs.push(tok);
				if (allRefs.size < 500) allRefs.add(tok);
			}
		}
		if (tCol >= 0 && rowRefs.length) {
			for (const k of keysIn(row[tCol]?.text ?? "", knownTickets)) {
				const kl = k.toLowerCase();
				let set = byTicket.get(kl);
				if (!set) {
					set = new Set();
					byTicket.set(kl, set);
				}
				for (const r of rowRefs) set.add(r);
			}
		}
	}
	const ticketCodeRefs: Record<string, string[]> = {};
	for (const [k, set] of byTicket) ticketCodeRefs[k] = [...set];
	return { codeRefs: [...allRefs], ...(byTicket.size ? { ticketCodeRefs } : {}) };
}

/** A summary, unless it is a line a template wrote and nobody has replaced. */
const said = (summary: string | undefined) => (summary && !isPrompt(summary) ? summary : undefined);

/** Drops standalone plain-prose paragraphs on large docs (>16 KB) before `taskTally` to avoid quadratic `marked.lexer` scanning. */
function compactForTaskScan(text: string): string {
	if (text.length <= 16_384) return text;
	const fm = frontMatter(text);
	const lines = fm.body.split(/\r?\n/);
	const kept: string[] = [];
	let block: string[] = [];
	let fenceChar = "";
	let fenceLen = 0;
	let inHtmlComment = false;
	const INTERESTING = /[\[\]`~<>]/;
	const LIST_START = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;
	const flushBlock = (keepAlways: boolean) => {
		if (!block.length) return;
		if (keepAlways || block.some((l) => INTERESTING.test(l) || LIST_START.test(l))) {
			if (kept.length) kept.push("");
			kept.push(...block);
		}
		block = [];
	};
	for (const line of lines) {
		if (!fenceChar && !inHtmlComment && !line.trim()) {
			flushBlock(false);
			continue;
		}
		if (!fenceChar) {
			const fmFence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
			if (fmFence) {
				fenceChar = fmFence[1]![0]!;
				fenceLen = fmFence[1]!.length;
			}
		} else {
			const fmFence = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
			if (fmFence && fmFence[1]![0] === fenceChar && fmFence[1]!.length >= fenceLen) {
				fenceChar = "";
				fenceLen = 0;
			}
		}
		if (!fenceChar) {
			if (!inHtmlComment && line.includes("<!--") && !line.includes("-->")) inHtmlComment = true;
			else if (inHtmlComment && line.includes("-->")) inHtmlComment = false;
		}
		block.push(line);
	}
	flushBlock(Boolean(fenceChar || inHtmlComment));
	return kept.join("\n");
}

/** How many of a text's tasks are ticked, read once for a text and kept: it is a pass of the renderer over the document. */
const talliesRead = new Map<number | bigint, ReturnType<typeof taskTally>>();
function tallyOf(text: string): ReturnType<typeof taskTally> {
	if (!/\[[ xX]\]/.test(text)) return null;
	const hash = Bun.hash(text);
	if (talliesRead.has(hash)) return talliesRead.get(hash)!;
	const tally = taskTally(compactForTaskScan(text));
	if (talliesRead.size >= 1000) talliesRead.delete(talliesRead.keys().next().value!);
	talliesRead.set(hash, tally);
	return tally;
}

type DescribedMeta = Pick<
	DocFile,
	| "title"
	| "status"
	| "summary"
	| "tickets"
	| "untouched"
	| "tasks"
	| "tags"
	| "release"
	| "priority"
	| "version"
	| "owner"
	| "reviewer"
	| "approvedBy"
	| "approvedDate"
	| "changeControl"
	| "gxpImpact"
	| "asked"
	| "date"
	| "effectiveDate"
	| "reviewDue"
	| "docKind"
	| "mtime"
	| "headings"
	| "source"
	| "missingSource"
	| "supersedes"
	| "supersededBy"
	| "blocks"
	| "blockedBy"
	| "codeRefs"
>;

function checkMissingSource(source: string | undefined, root?: string, path?: string): string | undefined {
	if (!source || !root || /^https?:\/\//i.test(source)) return undefined;
	const clean = source.split(/[?#]/)[0]!.trim();
	if (!clean) return undefined;
	const target = path && /^\.{1,2}[\\/]/.test(clean) ? resolve(dirname(path), clean) : join(root, clean);
	const rel = relative(resolve(root), resolve(target));
	if (ESCAPES_RELATIVE.test(rel) || isAbsolute(rel)) return undefined;
	return !existsInWorkspace(root, target) ? source : undefined;
}

/** What a Markdown document says of itself, for the panel, catalogs, tags, governance, health, and code traceability. */
function described(
	text: string,
	root?: string,
	path?: string,
	fmArg?: ReturnType<typeof frontMatter>,
	precomputedLinks?: readonly DocLink[],
): DescribedMeta {
	const fm = fmArg ?? frontMatter(text);
	const { values } = fm;
	const tickets = [...many(values.ticket), ...many(values.tickets)];
	const tasks = tallyOf(text);
	const tags = extractTags(text);
	const release = one(values.release) || one(values.milestone) || one(values.sprint) || undefined;
	const priority = one(values.priority) || undefined;
	const version = one(values.version) || undefined;
	const owner = one(values.owner) || undefined;
	const reviewer = one(values.reviewer) || undefined;
	const approvedBy = one(values["approved-by"]) || one(values.approvedby) || undefined;
	const approvedDate = one(values["approved-date"]) || one(values.approveddate) || undefined;
	const changeControl = one(values["change-control"]) || one(values.cr) || undefined;
	const gxpImpact = one(values["gxp-impact"]) || one(values.gxp) || undefined;
	const asked = one(values.asked) || undefined;
	const date = one(values.date) || undefined;
	const effectiveDate = one(values["effective-date"]) || one(values.effectivedate) || undefined;
	const reviewDue = one(values["review-due"]) || one(values.reviewdue) || undefined;
	const phase = one(values.phase);
	const explicitDocKind = one(values["doc-kind"]) || one(values.dockind) || undefined;
	const isTestRun =
		Boolean(path && /(?:^|[\\/])test-runs[\\/].+\.(?:md|markdown)$/i.test(path)) ||
		/^(?:IQ|OQ|PQ)(?:\/(?:IQ|OQ|PQ))*$/i.test(phase);
	const docKind = explicitDocKind || (isTestRun ? "test-run" : undefined);
	const mtime = path ? mtimeOf(path) : undefined;
	const headings = documentHeadings(text)
		.slice(0, 60)
		.map((h) => ({ level: h.level, text: h.text, slug: h.anchor, line: h.line }));
	const source = one(values.source) || undefined;
	const missingSource = checkMissingSource(source, root, path);
	const supersedes = many(values.supersedes);
	const supersededBy = many(values["superseded-by"]);
	const blocks = many(values.blocks);
	const blockedBy = many(values["blocked-by"]);
	const codeRefs = root && path ? markdownCodeRefs(root, path, text, precomputedLinks) : [];
	return {
		title: titleOf(text) || undefined,
		status: one(values.status) || undefined,
		summary: said(summaryOf(text)),
		...(tickets.length ? { tickets } : {}),
		...(isPrompt(summaryOf(text)) ? { untouched: true } : {}),
		...(tasks ? { tasks } : {}),
		...(tags.length ? { tags } : {}),
		...(release ? { release } : {}),
		...(priority ? { priority } : {}),
		...(version ? { version } : {}),
		...(owner ? { owner } : {}),
		...(reviewer ? { reviewer } : {}),
		...(approvedBy ? { approvedBy } : {}),
		...(approvedDate ? { approvedDate } : {}),
		...(changeControl ? { changeControl } : {}),
		...(gxpImpact ? { gxpImpact } : {}),
		...(asked ? { asked } : {}),
		...(date ? { date } : {}),
		...(effectiveDate ? { effectiveDate } : {}),
		...(reviewDue ? { reviewDue } : {}),
		...(docKind ? { docKind } : {}),
		...(mtime !== undefined ? { mtime } : {}),
		...(headings.length ? { headings } : {}),
		...(source ? { source } : {}),
		...(missingSource ? { missingSource } : {}),
		...(supersedes.length ? { supersedes } : {}),
		...(supersededBy.length ? { supersededBy } : {}),
		...(blocks.length ? { blocks } : {}),
		...(blockedBy.length ? { blockedBy } : {}),
		...(codeRefs.length ? { codeRefs } : {}),
	};
}

type CachedMdSummary = {
	stamp: string;
	meta: Omit<DescribedMeta, "missingSource">;
	links: DocLink[];
	names: ReturnType<typeof namePlaces>;
	frontTicket: string;
	frontParent: string;
	frontSpecs: string[];
	frontPlans: string[];
	frontRelated: string[];
	fmTitle: string;
	hasH1: boolean;
	schemaObjects?: string[];
};

const mdSummaryCache = new Map<string, CachedMdSummary>();
const MD_SUMMARY_KEPT = 4000;

async function cachedMdSummary(root: string, path: string): Promise<CachedMdSummary | null> {
	let stamp = "";
	try {
		const st = statSync(path);
		stamp = fileStamp(st);
	} catch {
		return null;
	}
	const key = `${root}\0${path}`;
	const kept = mdSummaryCache.get(key);
	if (kept && kept.stamp === stamp) {
		mdSummaryCache.delete(key);
		mdSummaryCache.set(key, kept);
		return kept;
	}
	const text = await head(path, INDEX_BYTES);
	const fm = frontMatter(text);
	const { values } = fm;
	const links = linksIn(path, text, "F");
	const fullDesc = described(text, root, path, fm, links);
	const { missingSource: _ignoreMissing, ...meta } = fullDesc;
	const names = namePlaces(text);
	const schemaSet = new Set<string>();
	for (const line of fm.body.split(/\r?\n/)) {
		const m = /^#{1,3}\s+`?([A-Za-z_][\w$.]{1,64})`?\s*$/.exec(line.trim());
		if (m) schemaSet.add(m[1]!);
	}
	const entry: CachedMdSummary = {
		stamp,
		meta,
		links,
		names,
		frontTicket: one(values.ticket),
		frontParent: one(values.parent),
		frontSpecs: [...new Set([...many(values.specs), ...many(values.spec)])],
		frontPlans: [...new Set([...many(values.plans), ...many(values.plan)])],
		frontRelated: [...many(values.related), ...many(values.blocks), ...many(values["blocked-by"]), ...many(values.parent)],
		fmTitle: one(values.title),
		hasH1: /^#\s+\S/m.test(fm.body),
		...(schemaSet.size ? { schemaObjects: [...schemaSet] } : {}),
	};
	if (mdSummaryCache.size >= MD_SUMMARY_KEPT) mdSummaryCache.delete(mdSummaryCache.keys().next().value!);
	mdSummaryCache.set(key, entry);
	return entry;
}

function describedWithLiveSource(summary: CachedMdSummary, root: string, path: string): DescribedMeta {
	const missingSource = checkMissingSource(summary.meta.source, root, path);
	return {
		...summary.meta,
		...(missingSource ? { missingSource } : {}),
	};
}

/**
 * The links of a Markdown document that lead to a file of the project that is
 * not there: a document moved or renamed since the link was written.
 */
/**
 * A document's links, read once for a text and kept: reading them is two
 * passes of the renderer over the document, and the listing is asked for
 * again whenever anything in the folder changes.
 */
const linksRead = new Map<string, { hash: number | bigint; links: DocLink[] }>();
const LINKS_KEPT = 4000;
function linksIn(path: string, text: string, scope: "H" | "F" = "H"): DocLink[] {
	const key = `${scope}\0${path}`;
	const hash = Bun.hash(text);
	const kept = linksRead.get(key);
	if (kept && kept.hash === hash) {
		// Touch for LRU eviction order.
		linksRead.delete(key);
		linksRead.set(key, kept);
		return kept.links;
	}
	const links = fileLinks(text);
	if (linksRead.size >= LINKS_KEPT) linksRead.delete(linksRead.keys().next().value!);
	linksRead.delete(key);
	linksRead.set(key, { hash, links });
	return links;
}

/** Cached `namePlaces()` per Markdown file, keyed by path + size + mtimeMs. */
const namesRead = new Map<string, { stamp: string; places: ReturnType<typeof namePlaces> }>();
const NAMES_KEPT = 4000;

/** Cached `parseCsv()` per registry file, keyed by path + file stamp. */
const csvRead = new Map<string, { stamp: string; table: ReturnType<typeof parseCsv> }>();
const CSV_KEPT = 256;

async function cachedParseCsv(path: string, stamp: string): Promise<ReturnType<typeof parseCsv>> {
	const kept = csvRead.get(path);
	if (kept && kept.stamp === stamp) return kept.table;
	const table = parseCsv(await textOf(path));
	if (csvRead.size >= CSV_KEPT) csvRead.delete(csvRead.keys().next().value!);
	csvRead.set(path, { stamp, table });
	return table;
}

/** The file a link in a document leads to. A path from the top is from the project's top, as a repository's page reads it. */
const linkTarget = (root: string, path: string, file: string) => (file.startsWith("/") ? join(root, file) : resolve(dirname(path), file));

function brokenLinksFrom(root: string, path: string, links: readonly DocLink[], named?: (name: string) => string[]): Pick<DocFile, "broken"> {
	const broken = links
		.filter((link) => {
			const target = linkTarget(root, path, link.file);
			// What is outside the project is not this project's to say: it may well be there on another machine.
			const from = relative(resolve(root), resolve(target));
			return !ESCAPES_RELATIVE.test(from) && !isAbsolute(from) && !existsInWorkspace(root, target);
		})
		.map(({ href, file, line, column }) => {
			// One file of that name elsewhere in the project is where it went, most likely. Two, and it is not ours to pick.
			// The document itself is not where its own link was meant to lead.
			const moved = (named?.(basename(file)) ?? []).filter((candidate) => candidate !== path);
			const instead = moved.length === 1 ? relative(dirname(path), moved[0]!).split(sep).join("/") : "";
			return { href, line, column, ...(instead ? { instead } : {}) };
		});
	return broken.length ? { broken } : {};
}

function brokenLinks(root: string, path: string, text: string, named?: (name: string) => string[]): Pick<DocFile, "broken"> {
	return brokenLinksFrom(root, path, linksIn(path, text), named);
}

/** True when a workspace file lives inside a frozen `docs/exports/` or nested `exports/` snapshot folder. */
function isInExportsDir(root: string, filePath: string): boolean {
	const rel = relative(root, filePath).split(sep).join("/").toLowerCase();
	return /(?:^|\/)exports\//.test(rel);
}

/** Computes 1-based line and 0-based column from a character offset using precomputed line starts. */
function lineColAt(lineStarts: readonly number[], offset: number): { line: number; column: number } {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineStarts[mid]! <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo + 1, column: offset - lineStarts[lo]! };
}

function computeLineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

/** A Markdown document larger than this is not read for the links it holds. */
const LINKED_BYTES = 1024 * 1024;
/** No more documents per category than this are read when asked what links to a file. */
const LINKING_DOCS = 2000;
const REGISTRY_FILE_RE = /(?:^|\/)registries\/.+\.(?:csv|tsv)$/i;
const CODE_COMMENT_FILE_RE = /\.(ssl|srvscr|ds|sql)$/i;
const COMMENT_PATH_RE = /(?:(?:\.\.?\/|\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:#[A-Za-z0-9_.-]+)?)/g;

/**
 * The links across the workspace's Markdown documents, `.plan.json` files (`targets`, `node.docs`,
 * `built.units[].script`, `built.tests.script`, `scripts`, `testScripts`), CSV/TSV registries under
 * `registries/`, and comment-only lines/blocks in `.ssl`/`.srvscr`/`.ds`/`.sql` files that lead
 * to a file or into a folder: what a rename leaves pointing at the old name.
 * Skips frozen `docs/exports/` and `*\/exports/` snapshot folders.
 */
export async function linksTo(files: WorkspaceFiles, target: string): Promise<LinkTo[]> {
	const root = files.root;
	// A file system that does not tell case apart names one file either way.
	const fold = (path: string) => (process.platform === "linux" ? path : path.toLowerCase());
	const resolvedTarget = resolve(target);
	const wanted = fold(resolvedTarget);
	const targetRel = relative(root, resolvedTarget).split(sep).join("/");
	const found: LinkTo[] = [];
	const PLAN_JSON = /\.plan\.json$/i;
	const leadsThere = (leads: string) => fold(leads) === wanted || fold(leads).startsWith(wanted + sep);

	let docRead = 0;
	let codeRead = 0;
	for (const path of files.files()) {
		if (isInExportsDir(root, path)) continue;
		const rel = relative(root, path).split(sep).join("/");
		const isMd = MARKDOWN.test(path);
		const isPlan = !isMd && PLAN_JSON.test(path);
		const isReg = !isMd && !isPlan && REGISTRY_FILE_RE.test(rel);
		const isCode = !isMd && !isPlan && !isReg && CODE_COMMENT_FILE_RE.test(path);
		if (!isMd && !isPlan && !isReg && !isCode) continue;

		if (isCode) {
			if (codeRead >= LINKING_DOCS) continue;
			codeRead++;
		} else {
			if (docRead >= LINKING_DOCS) continue;
			docRead++;
		}

		const file = Bun.file(path);
		if (file.size > (isReg ? REGISTRY_BYTES : LINKED_BYTES)) continue;
		let text = "";
		try {
			text = decode(new Uint8Array(await file.arrayBuffer())).text;
		} catch {
			continue;
		}

		if (isPlan) {
			try {
				const plan = JSON.parse(text) as {
					targets?: unknown[];
					scripts?: unknown[];
					testScripts?: unknown[];
					built?: { units?: { script?: unknown }[]; tests?: { script?: unknown } };
					nodes?: { docs?: unknown[] }[];
				};
				const refs: string[] = [];
				const collect = (val: unknown) => {
					if (typeof val === "string" && val.trim()) refs.push(val.trim());
					else if (val && typeof val === "object") {
						const rec = val as { path?: unknown; script?: unknown };
						if (typeof rec.path === "string" && rec.path.trim()) refs.push(rec.path.trim());
						if (typeof rec.script === "string" && rec.script.trim()) refs.push(rec.script.trim());
					}
				};
				if (Array.isArray(plan?.targets)) for (const t of plan.targets) collect(t);
				if (Array.isArray(plan?.scripts)) for (const s of plan.scripts) collect(s);
				if (Array.isArray(plan?.testScripts)) for (const ts of plan.testScripts) collect(ts);
				if (Array.isArray(plan?.built?.units)) {
					for (const u of plan.built.units) collect(u?.script);
				}
				if (typeof plan?.built?.tests?.script === "string") collect(plan.built.tests.script);
				if (Array.isArray(plan?.nodes)) {
					for (const n of plan.nodes) {
						if (Array.isArray(n?.docs)) for (const d of n.docs) collect(d);
					}
				}
				const lines = text.split(/\r?\n/);
				const usedPlaces = new Set<string>();
				for (const rawRef of refs) {
					const filePart = rawRef.split(/[?#]/)[0]!.trim();
					if (!filePart) continue;
					const isRel = /^\.{1,2}[\\/]/.test(filePart);
					const leads = isRel ? resolve(dirname(path), filePart) : join(root, filePart);
					if (!leadsThere(leads)) continue;
					const quoted = JSON.stringify(rawRef);
					const inner = quoted.slice(1, -1);
					let hitLine = -1;
					let hitCol = -1;
					let hitHref = rawRef;
					outer: for (let li = 0; li < lines.length; li++) {
						const ln = lines[li]!;
						let searchFrom = 0;
						while (searchFrom <= ln.length) {
							const idx = ln.indexOf(quoted, searchFrom);
							if (idx < 0) break;
							const col = idx + 1;
							const placeKey = `${li + 1}:${col}`;
							if (!usedPlaces.has(placeKey) && ln.startsWith(inner, col)) {
								usedPlaces.add(placeKey);
								hitLine = li + 1;
								hitCol = col;
								hitHref = inner;
								break outer;
							}
							searchFrom = idx + quoted.length;
						}
						// Fallback for alternate JSON escapes (`\/`, `\uXXXX`, etc.).
						for (const m of ln.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
							const col = (m.index ?? 0) + 1;
							const placeKey = `${li + 1}:${col}`;
							if (usedPlaces.has(placeKey)) continue;
							try {
								if (JSON.parse(m[0]) === rawRef) {
									usedPlaces.add(placeKey);
									hitLine = li + 1;
									hitCol = col;
									hitHref = m[1]!;
									break outer;
								}
							} catch {
								// Skip malformed literal.
							}
						}
					}
					if (hitLine < 0) continue;
					found.push({
						path,
						line: hitLine,
						column: hitCol,
						href: hitHref,
						rest: leads.slice(resolvedTarget.length),
						from: isRel ? "doc" : "root",
						kind: "plan",
					});
				}
			} catch {
				// Ignore malformed plan JSON cleanly.
			}
			continue;
		}

		if (isReg) {
			const table = parseCsv(text);
			const lineStarts = computeLineStarts(text);
			for (const row of table.rows) {
				for (const cell of row) {
					const raw = cell.text.trim();
					if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;
					const normalized = raw.split("\\").join("/");
					const isTop = normalized.startsWith("/");
					const isRel = /^\.{1,2}\//.test(normalized);
					const leads = isTop ? join(root, normalized) : isRel ? resolve(dirname(path), normalized) : join(root, normalized);
					if (!leadsThere(leads)) continue;
					const slice = text.slice(cell.start, cell.end);
					const innerOffset = slice.indexOf(raw);
					if (innerOffset < 0) continue;
					const { line, column } = lineColAt(lineStarts, cell.start + innerOffset);
					found.push({
						path,
						line,
						column,
						href: raw,
						rest: leads.slice(resolvedTarget.length),
						from: isTop ? "top" : isRel ? "doc" : "root",
						kind: "registry",
					});
				}
			}
			continue;
		}

		if (isCode) {
			// Respect ADR 0003: never parse SSL syntax — only inspect comment-only lines/blocks.
			const isSql = /\.sql$/i.test(path);
			const lines = text.split(/\r?\n/);
			let inBlock = false;
			for (let li = 0; li < lines.length; li++) {
				const rawLine = lines[li]!;
				const trimmed = rawLine.trim();
				let commentOnly = false;
				let commentSlice = rawLine;
				if (isSql) {
					if (inBlock) {
						const closeIdx = rawLine.indexOf("*/");
						if (closeIdx >= 0) {
							inBlock = false;
							if (!rawLine.slice(closeIdx + 2).trim()) {
								commentOnly = true;
								commentSlice = rawLine.slice(0, closeIdx);
							}
						} else {
							commentOnly = true;
						}
					} else if (trimmed.startsWith("--")) {
						commentOnly = true;
					} else if (trimmed.startsWith("/*")) {
						const openIdx = rawLine.indexOf("/*");
						const closeIdx = rawLine.indexOf("*/", openIdx + 2);
						if (closeIdx >= 0) {
							if (!rawLine.slice(closeIdx + 2).trim()) {
								commentOnly = true;
								commentSlice = rawLine.slice(0, closeIdx);
							}
						} else {
							inBlock = true;
							commentOnly = true;
						}
					}
				} else {
					// SSL / .srvscr / .ds: `/* ... ;` (or `/* ... */`) and `// ...` comment-only lines/blocks.
					if (inBlock) {
						const semiIdx = rawLine.indexOf(";");
						const starIdx = rawLine.indexOf("*/");
						const closeIdx =
							semiIdx >= 0 && starIdx >= 0 ? Math.min(semiIdx, starIdx) : semiIdx >= 0 ? semiIdx : starIdx;
						const closeLen = closeIdx === starIdx && starIdx >= 0 ? 2 : 1;
						if (closeIdx >= 0) {
							inBlock = false;
							if (!rawLine.slice(closeIdx + closeLen).trim()) {
								commentOnly = true;
								commentSlice = rawLine.slice(0, closeIdx);
							}
						} else {
							commentOnly = true;
						}
					} else if (trimmed.startsWith("//")) {
						commentOnly = true;
					} else if (trimmed.startsWith("/*")) {
						const openIdx = rawLine.indexOf("/*");
						const semiIdx = rawLine.indexOf(";", openIdx + 2);
						const starIdx = rawLine.indexOf("*/", openIdx + 2);
						const closeIdx =
							semiIdx >= 0 && starIdx >= 0 ? Math.min(semiIdx, starIdx) : semiIdx >= 0 ? semiIdx : starIdx;
						const closeLen = closeIdx === starIdx && starIdx >= 0 ? 2 : 1;
						if (closeIdx >= 0) {
							if (!rawLine.slice(closeIdx + closeLen).trim()) {
								commentOnly = true;
								commentSlice = rawLine.slice(0, closeIdx);
							}
						} else {
							inBlock = true;
							commentOnly = true;
						}
					}
				}
				if (!commentOnly) continue;
				const seenCols = new Set<number>();
				const tryPushToken = (rawTok: string, col: number) => {
					const before = rawLine.slice(Math.max(0, col - 8), col);
					if (/(?:https?:|ftp:|file:)?\/\/$/i.test(before)) return;
					const filePart = rawTok.split(/[?#]/)[0]!.replace(/\.+$/, "");
					if (!filePart || seenCols.has(col)) return;
					const isTop = filePart.startsWith("/");
					const isRel = /^\.{1,2}\//.test(filePart);
					const leads = isTop ? join(root, filePart) : isRel ? resolve(dirname(path), filePart) : join(root, filePart);
					if (!leadsThere(leads)) return;
					seenCols.add(col);
					found.push({
						path,
						line: li + 1,
						column: col,
						href: filePart,
						rest: leads.slice(resolvedTarget.length),
						from: isTop ? "top" : isRel ? "doc" : "root",
						kind: "code",
					});
				};
				for (const m of commentSlice.matchAll(COMMENT_PATH_RE)) {
					tryPushToken(m[0]!, m.index ?? 0);
				}
				// Also match workspace-relative paths containing spaces when written verbatim in a comment.
				if (targetRel.includes(" ") && commentSlice.includes(targetRel)) {
					let fromIdx = 0;
					while (fromIdx <= commentSlice.length) {
						const idx = commentSlice.indexOf(targetRel, fromIdx);
						if (idx < 0) break;
						tryPushToken(targetRel, idx);
						fromIdx = idx + targetRel.length;
					}
				}
			}
			continue;
		}

		// Markdown: front matter path keys ("specs:", "plans:", "source:") and Markdown body links.
		for (const named of frontPaths(text)) {
			const isRel = /^\.{1,2}[\\/]/.test(named.value);
			const leads = isRel ? resolve(dirname(path), named.value) : join(root, named.value);
			if (leadsThere(leads)) found.push({ path, line: named.line, column: named.column, href: named.value, rest: leads.slice(resolvedTarget.length), from: isRel ? "doc" : "root", kind: "markdown" });
		}
		if (!text.includes("](") && !text.includes("]:")) continue;
		for (const link of linksIn(path, text, "F")) {
			if (!link.line) continue;
			const leads = linkTarget(root, path, link.file);
			if (leadsThere(leads)) found.push({ path, line: link.line, column: link.column, href: link.href, rest: leads.slice(resolvedTarget.length), from: link.file.startsWith("/") ? "top" : "doc", kind: "markdown" });
		}
	}
	return found;
}

/**
 * The links by name in the workspace's Markdown documents, as they stand on
 * disk: what a document is linked from by name, and what a rename may leave
 * meaning nothing. Which document each name means is not asked here.
 * Skips frozen `docs/exports/` and `*\/exports/` snapshot folders.
 */
export async function namesIn(files: WorkspaceFiles): Promise<NameIn[]> {
	const root = files.root;
	const found: NameIn[] = [];
	let read = 0;
	for (const path of files.files()) {
		if (!MARKDOWN.test(path) || isInExportsDir(root, path)) continue;
		if (++read > LINKING_DOCS) break;
		let stamp = "";
		try {
			const s = statSync(path);
			if (s.size > LINKED_BYTES) continue;
			stamp = fileStamp(s);
		} catch {
			continue;
		}
		const namesKey = `F\0${path}`;
		const kept = namesRead.get(namesKey);
		let places: ReturnType<typeof namePlaces>;
		if (kept && kept.stamp === stamp) {
			places = kept.places;
		} else {
			let text = "";
			try {
				text = decode(new Uint8Array(await Bun.file(path).arrayBuffer())).text;
			} catch {
				continue;
			}
			places = namePlaces(text);
			if (namesRead.size >= NAMES_KEPT) namesRead.delete(namesRead.keys().next().value!);
			namesRead.set(namesKey, { stamp, places });
		}
		for (const place of places) found.push({ path, ...place });
	}
	return found;
}

/** A snippet's title and what it is for: the first two lines of the comment it opens with. */
function snippet(text: string): Pick<DocFile, "title" | "summary" | "untouched"> {
	const words = (line: string | undefined) => /^\s*(?:--+|\/\*+|#+|\/\/+|\*)?\s*(.+?)\s*(?:\*\/|;)?\s*$/.exec(line ?? "")?.[1];
	const lines = text.split(/\r?\n/).filter((line) => line.trim());
	const commented = (line: string | undefined) => /^\s*(--|\/\*|#|\/\/)/.test(line ?? "");
	if (!commented(lines[0])) return {};
	// The second line is part of the comment when it is marked as one, or the comment is a block still open.
	const second = commented(lines[1]) || (/^\s*\/\*/.test(lines[0]!) && !/(\*\/|;)\s*$/.test(lines[0]!)) ? words(lines[1]) : undefined;
	return { title: words(lines[0]), summary: said(second), ...(isPrompt(second) ? { untouched: true } : {}) };
}

const SCHEMA_FILE_RE = /\.(md|markdown|sql|ddl|pks|pkb|ds|json|xml|xsd|wsdl|yaml|yml|hl7|astm|edi|avsc|proto|csv|tsv|txt)$/i;
const KNOWLEDGE_FILE_RE = /\.(md|markdown|sql|ssl|srvscr|ds|txt|json|toml|csv)$/i;
const REGISTRY_DOC_RE = /\.(md|markdown|csv|tsv)$/i;
const PLAN_DOC_RE = /\.(plan\.json|md)$/i;

/** Bounded Levenshtein edit distance (returns `maxDist + 1` as soon as distance exceeds `maxDist`). */
function boundedLevenshtein(a: string, b: string, maxDist: number): number {
	const al = a.length;
	const bl = b.length;
	if (Math.abs(al - bl) > maxDist) return maxDist + 1;
	if (a === b) return 0;
	let prev = Array.from({ length: bl + 1 }, (_, j) => j);
	let curr = new Array<number>(bl + 1);
	for (let i = 1; i <= al; i++) {
		curr[0] = i;
		let rowMin = curr[0]!;
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= bl; j++) {
			const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
			const val = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
			curr[j] = val;
			if (val < rowMin) rowMin = val;
		}
		if (rowMin > maxDist) return maxDist + 1;
		[prev, curr] = [curr, prev];
	}
	return prev[bl]!;
}

/**
 * Lightweight scan of workspace doc folders returning any folder that exceeds
 * its deterministic cap (`SCHEMA_DOC_LIMIT = 2000` for `schema/`, `DOC_LIMIT = 500`
 * for other folders), together with exact `total` file counts.
 */
export function docsTruncated(
	files: WorkspaceFiles,
	project: Project,
	options?: { templatesFolder?: string },
): { folder: string; limit: number; total: number }[] {
	const root = files.root;
	const docs = join(root, project.docs);
	const area = (name: DocArea) => join(docs, DOC_FOLDERS[name]);
	const templatesDir = join(docs, "templates");
	const exportsDir = join(docs, "exports");
	const customTemplatesRel = (options?.templatesFolder ?? "").trim().replace(/\\/g, "/").replace(/^[./]+|\/+$/g, "");
	const customTemplatesDir = customTemplatesRel ? join(root, customTemplatesRel) : "";
	const inArea = (path: string) =>
		(Object.keys(DOC_FOLDERS) as DocArea[]).some((name) => isUnderDir(path, area(name))) ||
		isUnderDir(path, templatesDir) ||
		isUnderDir(path, exportsDir) ||
		Boolean(customTemplatesDir && isUnderDir(path, customTemplatesDir));

	const out: { folder: string; limit: number; total: number }[] = [];
	const seen = new Set<string>();
	const check = (full: string, pattern: RegExp, limit: number, skip?: (path: string) => boolean) => {
		if (!existsSync(full)) return;
		let total = 0;
		for (const path of files.files(full)) {
			if (!pattern.test(path) || skip?.(path)) continue;
			total++;
		}
		if (total > limit) {
			const rel = relative(root, full).split(sep).join("/") || ".";
			if (seen.has(rel.toLowerCase())) return;
			seen.add(rel.toLowerCase());
			out.push({ folder: rel, limit, total });
		}
	};

	check(area("specs"), MARKDOWN, DOC_LIMIT);
	check(join(root, project.plans), /\.spec\.md$/i, DOC_LIMIT);
	check(area("knowledge"), KNOWLEDGE_FILE_RE, DOC_LIMIT);
	check(area("registries"), REGISTRY_DOC_RE, DOC_LIMIT);
	check(docs, MARKDOWN, DOC_LIMIT, inArea);
	check(join(root, project.schema), SCHEMA_FILE_RE, SCHEMA_DOC_LIMIT);
	check(join(root, project.plans), PLAN_DOC_RE, DOC_LIMIT);
	return out;
}

export async function listDocs(
	files: WorkspaceFiles,
	project: Project,
	options?: {
		templatesFolder?: string;
		truncatedOut?: { folder: string; limit: number; total?: number }[];
		truncatedWithTotalsOut?: { folder: string; limit: number; total: number }[];
	},
): Promise<DocFile[]> {
	const root = files.root;
	const list: DocFile[] = [];
	const seenTruncated = new Set<string>();
	const recordTruncated = (full: string, limit: number, total: number) => {
		if (!options?.truncatedOut && !options?.truncatedWithTotalsOut) return;
		const rel = relative(root, full).split(sep).join("/") || ".";
		if (seenTruncated.has(rel.toLowerCase())) return;
		seenTruncated.add(rel.toLowerCase());
		options?.truncatedOut?.push({ folder: rel, limit });
		options?.truncatedWithTotalsOut?.push({ folder: rel, limit, total });
	};
	// The project's files by name, read once and only when a link leads nowhere.
	let names: Map<string, string[]> | undefined;
	const named = (name: string) => {
		if (!names) {
			names = new Map();
			for (const file of files.files()) {
				const k = basename(file).toLowerCase();
				let bucket = names.get(k);
				if (!bucket) {
					bucket = [];
					names.set(k, bucket);
				}
				bucket.push(file);
			}
		}
		return names.get(name.toLowerCase()) ?? [];
	};
	for (const name of Object.keys(PLACEHOLDER)) {
		const actual = found(root, name);
		const path = join(root, actual ?? name);
		// A README that is a link to a file outside the workspace is there by name, and is listed, but it is not read
		// through: its headings and links are another project's, and opening it is refused in the same way.
		const text = actual && isInsideWorkspace(root, path) ? await textOf(path) : "";
		const untouched = actual ? text.includes(PLACEHOLDER[name]!) : undefined;
		const codeRefs = actual ? markdownCodeRefs(root, path, text) : [];
		const headings = actual
			? documentHeadings(text)
					.slice(0, 60)
					.map((h) => ({ level: h.level, text: h.text, slug: h.anchor, line: h.line }))
			: [];
		const mtime = actual ? mtimeOf(path) : undefined;
		list.push({
			path,
			name: actual ?? name,
			group: "project",
			exists: Boolean(actual),
			untouched,
			...(mtime !== undefined ? { mtime } : {}),
			...(headings.length ? { headings } : {}),
			...(codeRefs.length ? { codeRefs } : {}),
			...brokenLinks(root, path, text, named),
		});
	}
	list.push({ path: project.path, name: PROJECT_FILE, group: "project", exists: project.configured, ...(project.configured ? { mtime: mtimeOf(project.path) } : {}) });
	const docs = join(root, project.docs);
	// The state file is read from the docs folder directly, not through the workspace's listing: it is held to the
	// workspace here, or a docs folder that is a link elsewhere had its state file listed with its title and summary.
	const state = isFolder(docs) && isInsideWorkspace(root, docs) ? found(docs, STATE_FILE) : undefined;
	if (state && isInsideWorkspace(root, join(docs, state))) {
		const statePath = join(docs, state);
		const summary = await cachedMdSummary(root, statePath);
		if (summary) {
			list.push({ path: statePath, name: state, group: "project", exists: true, ...describedWithLiveSource(summary, root, statePath), ...brokenLinksFrom(root, statePath, summary.links, named) });
		}
	}

	/** The files under a folder that match, sorted deterministically BEFORE applying the cap. */
	const under = (full: string, pattern: RegExp, skip?: (path: string) => boolean, limit = DOC_LIMIT) => {
		if (!existsSync(full)) return [];
		const paths: string[] = [];
		// What is skipped does not count towards the limit: a folder of tickets must not crowd out the documents beside it.
		for (const path of files.files(full)) {
			if (!pattern.test(path) || skip?.(path)) continue;
			paths.push(path);
		}
		paths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
		if (paths.length > limit) {
			recordTruncated(full, limit, paths.length);
			return paths.slice(0, limit);
		}
		return paths;
	};
	const area = (name: DocArea) => join(docs, DOC_FOLDERS[name]);
	const templatesDir = join(docs, "templates");
	const exportsDir = join(docs, "exports");
	const customTemplatesRel = (options?.templatesFolder ?? "").trim().replace(/\\/g, "/").replace(/^[./]+|\/+$/g, "");
	const customTemplatesDir = customTemplatesRel ? join(root, customTemplatesRel) : "";
	const inArea = (path: string) =>
		(Object.keys(DOC_FOLDERS) as DocArea[]).some((name) => isUnderDir(path, area(name))) ||
		isUnderDir(path, templatesDir) ||
		isUnderDir(path, exportsDir) ||
		Boolean(customTemplatesDir && isUnderDir(path, customTemplatesDir));

	// Keep summaries indexed during this listing pass so the broken-wikilink check reuses them with zero extra I/O.
	const passSummaries = new Map<string, CachedMdSummary>();
	const loadMdSummary = async (path: string) => {
		const existing = passSummaries.get(path);
		if (existing) return existing;
		const summary = await cachedMdSummary(root, path);
		if (summary) passSummaries.set(path, summary);
		return summary;
	};

	// The tickets that drive the work: flat Markdown files (docs/tickets/LIMS-123.md)
	// and self-contained ticket bundle folders (docs/tickets/LIMS-123/LIMS-123.md plus
	// reference docs, existing code samples, and fixtures beside it — ADR 0030).
	const ticketsDir = area("tickets");
	if (existsSync(ticketsDir)) {
		// Cache direct subdirectories of ticketsDir once (avoids 2× readdirSync per flat ticket).
		const ticketSubdirs = new Map<string, string>();
		try {
			for (const d of readdirSync(ticketsDir, { withFileTypes: true })) {
				if (d.isDirectory()) ticketSubdirs.set(d.name.toLowerCase(), d.name);
			}
		} catch {
			// Ignore unreadable tickets directory.
		}
		const scanned: ScannedTicketEntry[] = [];
		const ticketPaths = [...files.files(ticketsDir)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
		for (const path of ticketPaths) {
			const rel = relative(ticketsDir, path).split(sep).join("/");
			let size = 0;
			try {
				size = statSync(path).size;
			} catch {
				// Ignore unreadable entry.
			}
			let frontTicket = "";
			if (MARKDOWN.test(path)) {
				const summary = await loadMdSummary(path);
				frontTicket = summary?.frontTicket ?? "";
			}
			scanned.push({ path, rel, size, ...(frontTicket ? { frontTicket } : {}) });
		}
		for (const resolved of classifyTicketEntries(scanned)) {
			const path = resolved.entry.path;
			const summary = await loadMdSummary(path);
			if (!summary) continue;
			const name = relative(ticketsDir, path);
			if (resolved.isCatalog) {
				list.push({ path, name, group: "tickets", exists: true, ...describedWithLiveSource(summary, root, path), ...brokenLinksFrom(root, path, summary.links, named) });
				continue;
			}
			const stem = basename(path).replace(MARKDOWN, "");
			const key = summary.frontTicket || (resolved.folderRel && /^(readme|ticket)$/i.test(stem) ? basename(resolved.folderRel) : stem);
			const specs = summary.frontSpecs;
			const plans = summary.frontPlans;
			const related = summary.frontRelated;
			const missing = [...specs, ...plans].filter((ref) => {
				const filePart = ref.split(/[?#]/)[0]!.trim();
				if (!filePart) return false;
				const target = /^\.{1,2}[\\/]/.test(filePart) ? resolve(dirname(path), filePart) : join(root, filePart);
				return !existsInWorkspace(root, target);
			});
			// Also detect an empty sibling folder matching this flat ticket's key/stem (O(1) map lookup).
			let ticketFolder = resolved.folderRel ? join(ticketsDir, resolved.folderRel) : undefined;
			if (!ticketFolder) {
				const sibling = ticketSubdirs.get(key.toLowerCase()) ?? ticketSubdirs.get(stem.toLowerCase());
				if (sibling) ticketFolder = join(ticketsDir, sibling);
			}
			list.push({
				path,
				name,
				group: "tickets",
				exists: true,
				...describedWithLiveSource(summary, root, path),
				...brokenLinksFrom(root, path, summary.links, named),
				ticket: key,
				parent: summary.frontParent || undefined,
				tickets: related.length ? related : undefined,
				specs: specs.length ? specs : undefined,
				plans: plans.length ? plans : undefined,
				missing: missing.length ? missing : undefined,
				...(ticketFolder ? { ticketFolder, ticketFileCount: resolved.fileCount, ticketFiles: resolved.files } : {}),
			});
		}
	}
	// The specs: behavior and design specifics kept under docs/specs/ (ADR 0033).
	for (const path of under(area("specs"), MARKDOWN)) {
		const summary = await loadMdSummary(path);
		if (!summary) continue;
		const said = describedWithLiveSource(summary, root, path);
		list.push({
			path,
			name: relative(area("specs"), path),
			group: "specs",
			exists: true,
			...said,
			...brokenLinksFrom(root, path, summary.links, named),
		});
	}
	// The knowledge base: decisions, questions, snippets and notes, each kind in its folder.
	for (const path of under(area("knowledge"), KNOWLEDGE_FILE_RE)) {
		const name = relative(area("knowledge"), path);
		const kind = name.includes(sep) ? name.split(sep)[0]! : "";
		if (MARKDOWN.test(path)) {
			const summary = await loadMdSummary(path);
			if (!summary) continue;
			list.push({
				path,
				name,
				group: "knowledge",
				exists: true,
				kind,
				...describedWithLiveSource(summary, root, path),
				...brokenLinksFrom(root, path, summary.links, named),
			});
		} else {
			const text = await head(path);
			const mtime = mtimeOf(path);
			list.push({
				path,
				name,
				group: "knowledge",
				exists: true,
				kind,
				...(mtime !== undefined ? { mtime } : {}),
				...snippet(text),
			});
		}
	}
	// The registries: tables of values, each row with how far it has come.
	const knownTickets = new Set(list.flatMap((file) => (file.group === "tickets" && file.ticket ? [file.ticket.toLowerCase()] : [])));
	for (const path of under(area("registries"), REGISTRY_DOC_RE)) {
		const name = relative(area("registries"), path);
		if (MARKDOWN.test(path)) {
			const summary = await loadMdSummary(path);
			if (!summary) continue;
			list.push({ path, name, group: "registries", exists: true, ...describedWithLiveSource(summary, root, path), ...brokenLinksFrom(root, path, summary.links, named) });
			continue;
		}
		let size = 0;
		let mtimeMs = 0;
		let csvStamp = "";
		try {
			const st = statSync(path);
			size = st.size;
			mtimeMs = st.mtimeMs;
			csvStamp = fileStamp(st);
		} catch {
			continue;
		}
		if (size > REGISTRY_BYTES) {
			list.push({ path, name, group: "registries", exists: true, problems: ["It is too large to read here."] });
			continue;
		}
		const table = await cachedParseCsv(path, csvStamp);
		// A row can say which ticket carries it: the ticket's page lists what it has to bring across.
		const forTickets = rowsByTicket(table, knownTickets);
		const regCode = registryCodeInfo(table, knownTickets);
		list.push({
			path,
			name,
			group: "registries",
			exists: true,
			mtime: Math.round(mtimeMs),
			rows: table.rows.length,
			tally: tally(table) ?? undefined,
			problems: table.problems.length ? table.problems : undefined,
			...(forTickets.length ? { tickets: forTickets.map((rows) => rows.key), forTickets } : {}),
			...(regCode.ticketCodeRefs ? { ticketCodeRefs: regCode.ticketCodeRefs } : {}),
			...(regCode.codeRefs.length ? { codeRefs: regCode.codeRefs } : {}),
		});
	}
	// Everything else in the docs folder.
	for (const path of under(docs, MARKDOWN, inArea)) {
		if (state && path === join(docs, state)) continue;
		// What it calls itself and what it is about: its line in the docs folder's catalog.
		const summary = await loadMdSummary(path);
		if (!summary) continue;
		const said = describedWithLiveSource(summary, root, path);
		// Its heading is not a name it is linked by: a plain document is linked by its file's name, as it always was.
		list.push({
			path,
			name: relative(docs, path),
			group: "docs",
			exists: true,
			...(said.title ? { heading: said.title } : {}),
			...(said.summary ? { summary: said.summary } : {}),
			...(said.status ? { status: said.status } : {}),
			...(said.tickets?.length ? { tickets: said.tickets } : {}),
			...(said.tasks ? { tasks: said.tasks } : {}),
			...(said.untouched ? { untouched: true } : {}),
			...(said.tags?.length ? { tags: said.tags } : {}),
			...(said.release ? { release: said.release } : {}),
			...(said.priority ? { priority: said.priority } : {}),
			...(said.version ? { version: said.version } : {}),
			...(said.owner ? { owner: said.owner } : {}),
			...(said.reviewer ? { reviewer: said.reviewer } : {}),
			...(said.approvedBy ? { approvedBy: said.approvedBy } : {}),
			...(said.approvedDate ? { approvedDate: said.approvedDate } : {}),
			...(said.changeControl ? { changeControl: said.changeControl } : {}),
			...(said.gxpImpact ? { gxpImpact: said.gxpImpact } : {}),
			...(said.asked ? { asked: said.asked } : {}),
			...(said.date ? { date: said.date } : {}),
			...(said.effectiveDate ? { effectiveDate: said.effectiveDate } : {}),
			...(said.reviewDue ? { reviewDue: said.reviewDue } : {}),
			...(said.docKind ? { docKind: said.docKind } : {}),
			...(said.mtime !== undefined ? { mtime: said.mtime } : {}),
			...(said.headings?.length ? { headings: said.headings } : {}),
			...(said.source ? { source: said.source } : {}),
			...(said.missingSource ? { missingSource: said.missingSource } : {}),
			...(said.codeRefs?.length ? { codeRefs: said.codeRefs } : {}),
			...brokenLinksFrom(root, path, summary.links, named),
		});
	}
	// What the project's data looks like, each kind in its folder: descriptions in Markdown, and beside them the SQL
	// that makes the tables, a message's own schema, a sample of a file (including STARLIMS lab/interface formats).
	for (const path of under(join(root, project.schema), SCHEMA_FILE_RE, undefined, SCHEMA_DOC_LIMIT)) {
		const name = relative(join(root, project.schema), path);
		const folder = name.includes(sep) ? name.split(sep)[0]! : "";
		// A folder that is one of the known kinds in other capitals is that kind: on a disk that does not tell them
		// apart it is the same folder, and nowhere is it a second kind beside it.
		const kind = SCHEMAS.find((known) => known.id === folder.toLowerCase())?.id ?? folder;
		const isMd = MARKDOWN.test(path);
		const isSql = /\.(sql|ddl|pks|pkb)$/i.test(path);
		if (isMd) {
			const summary = await loadMdSummary(path);
			if (!summary) continue;
			list.push({
				path,
				name,
				group: "schema",
				exists: true,
				kind,
				...(summary.schemaObjects ? { schemaObjects: summary.schemaObjects } : {}),
				...describedWithLiveSource(summary, root, path),
				...brokenLinksFrom(root, path, summary.links, named),
			});
		} else {
			const schemaObjects = isSql ? await cachedSqlObjects(path) : undefined;
			const mtime = mtimeOf(path);
			list.push({
				path,
				name,
				group: "schema",
				exists: true,
				kind,
				...(mtime !== undefined ? { mtime } : {}),
				...(schemaObjects ? { schemaObjects } : {}),
			});
		}
	}
	for (const path of under(join(root, project.plans), PLAN_DOC_RE)) {
		// A plan says which ticket it is for, its title, and the scripts it targets (ADR 0013).
		// A companion `*.plan.md` is the plan doc written beside `<Name>.plan.json` (ADR 0033).
		const isJsonPlan = /\.plan\.json$/i.test(path);
		const isPlanDoc = /\.plan\.md$/i.test(path);
		const plan = isJsonPlan ? await planSays(path) : null;
		const mdSummary = MARKDOWN.test(path) ? await loadMdSummary(path) : null;
		const mtime = mdSummary ? undefined : mtimeOf(path);
		if (isPlanDoc && mdSummary) {
			const said = describedWithLiveSource(mdSummary, root, path);
			const chartPath = path.replace(/\.plan\.md$/i, ".plan.json");
			const chartExists = existsSync(chartPath);
			const paired = chartExists
				? await planSays(chartPath)
				: { ticket: "", title: "", status: "", codeRefs: [], testScripts: [], planTests: [], nodeDocs: [] };
			if (paired.title && !mdSummary.fmTitle && !mdSummary.hasH1) said.title = paired.title;
			const ownTickets = said.tickets?.length ? [...said.tickets] : undefined;
			const pairedPlan = chartExists ? { name: basename(chartPath), ...(paired.ticket ? { ticket: paired.ticket } : {}) } : undefined;
			const tickets =
				paired.ticket && !said.tickets?.some((key) => key.toLowerCase() === paired.ticket.toLowerCase())
					? [...(said.tickets ?? []), paired.ticket]
					: said.tickets;
			const mergedCodeRefs = [...new Set([...(said.codeRefs ?? []), ...paired.codeRefs])];
			list.push({
				path,
				name: relative(join(root, project.plans), path),
				group: "plans",
				exists: true,
				...said,
				...brokenLinksFrom(root, path, mdSummary.links, named),
				...(tickets?.length ? { tickets } : {}),
				...(ownTickets ? { ownTickets } : {}),
				...(pairedPlan ? { pairedPlan } : {}),
				...(mergedCodeRefs.length ? { codeRefs: mergedCodeRefs } : {}),
			});
			continue;
		}
		list.push({
			path,
			name: relative(join(root, project.plans), path),
			group: "plans",
			exists: true,
			...(mtime !== undefined ? { mtime } : {}),
			...(plan?.title ? { heading: plan.title } : {}),
			...(plan?.status ? { status: plan.status } : {}),
			...(plan?.ticket ? { tickets: [plan.ticket] } : {}),
			...(plan?.codeRefs.length ? { codeRefs: plan.codeRefs } : {}),
			...(plan?.testScripts.length ? { testScripts: plan.testScripts } : {}),
			...(plan?.planTests.length ? { planTests: plan.planTests } : {}),
			...(plan?.nodeDocs.length ? { nodeDocs: plan.nodeDocs } : {}),
			...(mdSummary ? { ...describedWithLiveSource(mdSummary, root, path), ...brokenLinksFrom(root, path, mdSummary.links, named) } : {}),
		});
	}
	// Check broken [[wikilinks]] and ![[embeds]] across Markdown docs using O(N) pre-built indexes,
	// populating fuzzy/basename candidate `instead` suggestions so Health can 1-click mend them.
	const IMAGE_EMBED_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
	const docNameIndex = buildDocNameIndex(list, root);
	const wsImageNames = new Set<string>();
	const wsImageList: string[] = [];
	for (const p of files.files()) {
		if (IMAGE_EMBED_RE.test(p)) {
			const base = basename(p);
			wsImageNames.add(base.toLowerCase());
			wsImageList.push(base);
		}
	}
	const normWikiKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
	const stemOfDoc = (d: DocFile) => basename(d.path).replace(/\.[^./\\]+$/, "");
	const candidateDocs = list.filter((d) => d.exists && !isCatalog(d)).map((d) => ({
		doc: d,
		stem: stemOfDoc(d),
		stemNorm: normWikiKey(stemOfDoc(d)),
		ticketNorm: d.ticket ? normWikiKey(d.ticket) : "",
		titleNorm: d.title ? normWikiKey(d.title) : "",
	}));
	const suggestWikiInstead = (place: ReturnType<typeof namePlaces>[number], sourceDoc: DocFile): string | undefined => {
		const raw = place.name.trim();
		if (!raw) return undefined;
		if (IMAGE_EMBED_RE.test(raw)) {
			const base = basename(raw);
			const moved = named(base).filter((c) => c !== sourceDoc.path);
			if (moved.length === 1) return basename(moved[0]!);
			const qNorm = normWikiKey(base.replace(/\.[^.]+$/, ""));
			if (qNorm.length >= 3) {
				const uniqueImgs = [...new Set(wsImageList)];
				const normHits = uniqueImgs.filter((img) => normWikiKey(img.replace(/\.[^.]+$/, "")) === qNorm);
				if (normHits.length === 1) return normHits[0]!;
			}
			return undefined;
		}
		const baseNoExt = basename(raw).replace(/\.(md|markdown)$/i, "").trim();
		if (!baseNoExt) return undefined;
		// 1. Path-moved basename match (e.g. `[[old-dir/Due-soon-report]]` -> `Due-soon-report`)
		if (raw.includes("/") || raw.includes("\\") || /\.(md|markdown)$/i.test(raw)) {
			const exactHits = candidateDocs.filter(
				(c) =>
					c.doc.path !== sourceDoc.path &&
					(c.stem.toLowerCase() === baseNoExt.toLowerCase() || (c.doc.ticket && c.doc.ticket.toLowerCase() === baseNoExt.toLowerCase())),
			);
			if (exactHits.length === 1) {
				const suggested = nameForIndexed(exactHits[0]!.doc, docNameIndex, root);
				if (suggested && suggested !== raw) return suggested;
			}
		}
		// 2. Punctuation/separator/case normalized match (`DueSoonReport` / `due_soon_report` -> `Due-soon-report`)
		const qNorm = normWikiKey(baseNoExt);
		if (qNorm.length >= 2) {
			const normHits = candidateDocs.filter(
				(c) =>
					c.doc.path !== sourceDoc.path &&
					(c.ticketNorm === qNorm || c.stemNorm === qNorm || (c.titleNorm && c.titleNorm === qNorm)),
			);
			if (normHits.length === 1) {
				const suggested = nameForIndexed(normHits[0]!.doc, docNameIndex, root);
				if (suggested && suggested !== raw) return suggested;
			}
		}
		// 3. Guarded Levenshtein fuzzy match for typos (never suggest a different ticket number like DEMO-103 for DEMO-104)
		if (qNorm.length >= 4 && !/^[A-Za-z]{2,12}-\d+$/.test(baseNoExt)) {
			const maxDist = qNorm.length >= 7 ? 2 : 1;
			const qDigits = qNorm.replace(/\D+/g, "");
			const sameDigits = (norm: string) => norm.replace(/\D+/g, "") === qDigits;
			let bestDist = maxDist + 1;
			let bestDoc: DocFile | null = null;
			let tied = false;
			for (const c of candidateDocs) {
				if (c.doc.path === sourceDoc.path) continue;
				// A name that differs in a digit is another note (the next release's, the second test plan), not a
				// slip of the hand: only a name with the same digits is offered.
				const dStem = c.stemNorm && sameDigits(c.stemNorm) ? boundedLevenshtein(qNorm, c.stemNorm, maxDist) : maxDist + 1;
				const dTitle = c.titleNorm && sameDigits(c.titleNorm) ? boundedLevenshtein(qNorm, c.titleNorm, maxDist) : maxDist + 1;
				const dist = Math.min(dStem, dTitle);
				if (dist > maxDist) continue;
				if (dist < bestDist) {
					bestDist = dist;
					bestDoc = c.doc;
					tied = false;
				} else if (dist === bestDist && bestDoc !== c.doc) {
					tied = true;
				}
			}
			if (bestDoc && !tied) {
				const suggested = nameForIndexed(bestDoc, docNameIndex, root);
				if (suggested && suggested !== raw) return suggested;
			}
		}
		// 4. Non-doc file embed moved elsewhere in the workspace (`![[old/query.sql]]`)
		if (place.embed || /[\\/]|\.[a-z0-9]{1,8}$/i.test(raw)) {
			const moved = named(basename(raw)).filter((c) => c !== sourceDoc.path);
			if (moved.length === 1) return relative(dirname(sourceDoc.path), moved[0]!).split(sep).join("/");
		}
		return undefined;
	};

	for (const doc of list) {
		if (!doc.exists || !MARKDOWN.test(doc.path)) continue;
		try {
			const summary = passSummaries.get(doc.path) ?? (await cachedMdSummary(root, doc.path));
			const places = summary?.names ?? [];
			if (!places.length) continue;
			const brokenWiki: { href: string; line: number; column: number; instead?: string }[] = [];
			for (const place of places) {
				if (IMAGE_EMBED_RE.test(place.name)) {
					const direct = linkTarget(root, doc.path, place.name);
					const fromRoot = join(root, place.name);
					const hasFile = existsInWorkspace(root, direct) || existsInWorkspace(root, fromRoot) || (!place.name.includes("/") && !place.name.includes("\\") && wsImageNames.has(basename(place.name).toLowerCase()));
					if (!hasFile) {
						const instead = suggestWikiInstead(place, doc);
						brokenWiki.push({ href: `${place.embed ? "!" : ""}[[${place.name}]]`, line: place.line, column: place.column, ...(instead ? { instead } : {}) });
					}
					continue;
				}
				if (lookupInIndex(place.name, docNameIndex)) continue;
				// Valid file transclusions / companion embeds (e.g. `![[samples/query.sql]]`, `![[notes.md]]`, `![[src/Mod/Script.ssl]]`) resolve on disk.
				if (place.embed || /[\\/]|\.[a-z0-9]{1,8}$/i.test(place.name)) {
					const relTarget = linkTarget(root, doc.path, place.name);
					const rootTarget = join(root, place.name);
					if (existsInWorkspace(root, relTarget) || existsInWorkspace(root, rootTarget)) continue;
				}
				const instead = suggestWikiInstead(place, doc);
				brokenWiki.push({ href: `${place.embed ? "!" : ""}[[${place.name}]]`, line: place.line, column: place.column, ...(instead ? { instead } : {}) });
			}
			if (brokenWiki.length) doc.broken = [...(doc.broken ?? []), ...brokenWiki];
		} catch {
			// Skip unreadable files cleanly.
		}
	}
	// Each catalog says whether its list is still what the documents are.
	const folders = projectFolders(root, project);
	const seen: string[] = [];
	for (const name of CATALOG_AREAS) {
		const folder = areaPath(name, folders);
		if (!isFolder(folder) || !catalogued(name, folder, root, seen)) continue;
		seen.push(resolve(folder));
		const file = join(folder, found(folder, CATALOG_FILE) ?? CATALOG_FILE);
		if (!existsSync(file)) continue;
		const text = await textOf(file);
		// In a folder that may do without a catalog, a file of that name with no place for the list is a person's own
		// document: it is not marked, and nothing is written into it.
		if (OPTIONAL_CATALOGS.includes(name) && !hasCatalogPlace(text)) continue;
		if (isFileArea(name)) {
			// The code's and the tests' catalogs are listed with the project's own files: those folders have no list of
			// their own in the panel. A folder with more files than a catalog lists is not said to be out of date.
			const paths = catalogFiles(files, folder);
			list.push({ path: file, name: relative(root, file).split(sep).join("/"), group: "project", exists: true, ...brokenLinks(root, file, text, named), catalog: { stale: paths ? catalogStale(text, fileItems(paths)) : false, area: name } });
			continue;
		}
		// The entry of this area's group: a schema folder inside the docs folder is listed with the documents too.
		const catalog = list.find((entry) => entry.group === name && entry.path === file);
		if (catalog) catalog.catalog = { stale: catalogStale(text, catalogItems(name, list, folders)), area: name };
	}
	return list;
}

/** The project's folders that have catalogs, as whole paths. */
export const projectFolders = (root: string, project: Project): AreaFolders => ({ docs: join(root, project.docs), schema: join(root, project.schema), tests: join(root, project.tests), code: join(root, project.code) });

/** True for a folder that is there: a setting that names a file is no folder to list. */
const isFolder = (path: string) => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/**
 * Whether a folder is one to catalogue as this area: the schema, code and tests folders are not when they are the
 * project's own folder (a list of everything in the project is no catalog), nor is a folder that an area before it
 * already is (where the tests are kept in the code's own folder, that folder has the code's catalog).
 */
function catalogued(area: (typeof CATALOG_AREAS)[number], folder: string, root: string, seen: readonly string[]): boolean {
	if ((area === "schema" || isFileArea(area)) && resolve(folder) === resolve(root)) return false;
	return !seen.includes(resolve(folder));
}

/**
 * The files of a tests or code folder, from that folder, with "/" between their parts. Null when there are more
 * than a catalog lists. Not among them: its own catalog, what a save leaves for a moment, and what a system or a
 * tool keeps for itself (a name or a folder that opens with a dot).
 */
export function catalogFiles(files: WorkspaceFiles, folder: string): string[] | null {
	const paths: string[] = [];
	for (const path of files.files(folder)) {
		const name = relative(folder, path).split(sep).join("/");
		if (name.toLowerCase() === CATALOG_FILE.toLowerCase() || name.endsWith(".ssl-studio-tmp") || name.split("/").some((part) => part.startsWith("."))) continue;
		if (paths.push(name) > CATALOG_FILES_MAX) return null;
	}
	return paths;
}

/** The same for the backend's answer: null too where the folder is not one to catalogue. */
export function catalogFilesOf(files: WorkspaceFiles, project: Project, area: FileArea): string[] | null {
	const folders = projectFolders(files.root, project);
	const seen: string[] = [];
	for (const name of CATALOG_AREAS) {
		const folder = areaPath(name, folders);
		if (!isFolder(folder) || !catalogued(name, folder, files.root, seen)) {
			if (name === area) return null;
			continue;
		}
		if (name === area) return catalogFiles(files, folder);
		seen.push(resolve(folder));
	}
	return null;
}

/** What kind of file one is, for the manifest: by what its name ends with. */
const KINDS: [RegExp, string][] = [
	[/\.(ssl|srvscr)$/i, "script"],
	[/\.ds$/i, "data source"],
	[/\.xfd$/i, "form"],
	[/\.(sql|ddl|pks|pkb)$/i, "sql"],
	[/\.(hl7|astm|edi)$/i, "interface"],
	[/\.plan\.json$/i, "plan"],
	[/\.(md|markdown|txt)$/i, "document"],
	[/\.(json|toml|ya?ml|xml|ini|csv|tsv|config)$/i, "data"],
];

/**
 * Every file that is the project's work, with its size, its lines and a
 * checksum: what a file manifest is written from. The documents about the
 * work are not in it (the docs and plans folders, the files at the root, the
 * IDE's own folder): they change as the work is written up, and are not what
 * a migration carries across.
 */
export async function fileManifest(files: WorkspaceFiles, project: Project): Promise<ManifestFile[]> {
	const rows: ManifestFile[] = [];
	const docsNorm = project.docs.split(/[\\/]/).filter((p) => p && p !== ".").join("/");
	const apartList = [docsNorm, project.plans.split(/[\\/]/).filter((p) => p && p !== ".").join("/"), ".ssl-studio"];
	// When `project.docs === "."`, explicitly exclude doc sub-areas so tickets/specs/knowledge/registries/exports never enter `files.csv`.
	if (!docsNorm) {
		apartList.push(...Object.values(DOC_FOLDERS), "exports", "templates", "attachments");
	}
	const apart = apartList.filter(Boolean).map((folder) => `${folder}/`);
	const codeAtRoot = project.code.trim() === "." || project.code.trim() === "";
	for (const path of files.files()) {
		const name = relative(files.root, path).split(sep).join("/");
		if (apart.some((folder) => name.startsWith(folder))) continue;
		if (!name.includes("/")) {
			// Skip root project docs (README.md, AGENTS.md) and non-code root files unless code = ".".
			if (!codeAtRoot || !/\.(ssl|srvscr|ds|xfd|sql|ddl|pks|pkb)$/i.test(name)) continue;
		}
		const stat = Bun.file(path);
		if (stat.size > 32 * 1024 * 1024) continue;
		const bytes = new Uint8Array(await stat.arrayBuffer());
		let lines = bytes.length ? 1 : 0;
		for (const byte of bytes) if (byte === 10) lines++;
		if (bytes.length && bytes[bytes.length - 1] === 10) lines--;
		rows.push({ path: name, kind: KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? "other", bytes: bytes.length, lines, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
	}
	return rows.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base", numeric: true }));
}

/** The schema's catalog as a new project gets it: the kinds it can hold, said above the list. */
const withKinds = (catalog: string) =>
	// Under what the folder is for, and before the line that says the list below is the app's: these are not that list.
	catalog.replace(/\n\n(The list between the two markers)/, `\n\n${SCHEMAS.map((kind) => `- \`${kind.id}/\`: ${kind.about}`).join("\n")}\n\n$1`);

/**
 * Writes what a project needs and does not have. Never overwrites. With
 * `dryRun` nothing is written: the answer is what would be, for the user to
 * see before agreeing.
 */
export async function setupProject(root: string, dryRun = false): Promise<string[]> {
	const project = await readProject(root);
	// What is to be written is worked out and checked first, and only then written. A target that turns out to be
	// outside the folder (through a link, or a path in project.toml) used to be found half-way, with the first
	// files already written and nothing recorded for Undo to take back.
	const plan: [path: string, content: string][] = [];
	const want = (path: string, content: string) => {
		if (!existsSync(path)) plan.push([path, content]);
	};
	want(project.path, projectToml(project.name));
	if (!found(root, "README.md")) want(join(root, "README.md"), readme(project));
	if (!found(root, "AGENTS.md")) want(join(root, "AGENTS.md"), agents(project));
	// A folder that is already there is left as it is, also one that is a link to a folder somewhere else: nothing is
	// written in it. A new one starts as its catalog, which says what the folder is for and lists what comes to be
	// in it: nothing is written once and left to go stale.
	const start = (dir: string, area: "docs" | "tests" | "code" | "schema") => {
		const dirFull = join(root, dir);
		// There already, or about to be: a folder made on the way to another area's catalog inside it is not a new one.
		if (existsSync(dirFull) || plan.some(([path]) => path.startsWith(dirFull + sep))) return;
		// The schema folder's names the kinds it can hold; a kind's folder is made with the first thing described in it.
		want(join(dirFull, CATALOG_FILE), area === "schema" ? withKinds(catalogTemplate("schema")) : catalogTemplate(area));
	};
	start(project.docs, "docs");
	start(project.schema, "schema");
	// A folder for the code only where there is none yet: an export brings its own layout. The code before the tests:
	// where a project keeps both in one folder, that folder is its code, and its catalog says so.
	let scripts = false;
	for (const path of new WorkspaceFiles(root).files()) if ((scripts = SCRIPT.test(path))) break;
	if (!scripts) start(project.code, "code");
	// Tests kept in the code's own folder: the folder is the code's, whichever of the two makes it.
	start(project.tests, resolve(root, project.tests) === resolve(root, project.code) ? "code" : "tests");
	// Two areas in one folder ask for the same catalog: the first asked for is the one written.
	const targets = plan.filter(([path], i) => plan.findIndex(([other]) => other === path) === i);
	// Every target and the folder it goes in, before the first write. A link that leads nowhere counts as outside.
	for (const [path] of targets) {
		assertPathInsideRoot(root, dirname(path), false);
		assertPathInsideRoot(root, path, true);
	}
	const made = targets.map(([path]) => relative(root, path));
	if (dryRun) return made;
	const wrote = new Map<string, string>();
	try {
		for (const [path, content] of targets) {
			// Never overwrites: something may have come to be there since the plan was made.
			if (existsSync(path)) continue;
			const dir = dirname(path);
			assertPathInsideRoot(root, dir, false);
			mkdirSync(dir, { recursive: true });
			assertPathInsideRoot(root, path, true);
			await Bun.write(path, content);
			wrote.set(path, content);
		}
	} finally {
		// Also when a write failed part of the way: what was written before it can still be taken back.
		lastSetup.set(root, wrote);
	}
	return made;
}

/** What the last "Set up project" wrote in each folder, exactly as written, for taking it back. */
const lastSetup = new Map<string, Map<string, string>>();

/**
 * Takes back the last "Set up project" in this folder: each file it wrote is
 * removed if it still says what was written, and so is a folder it left
 * empty. A file someone has changed since is theirs, and stays. Says what
 * was removed and what was kept.
 */
export async function undoSetup(root: string): Promise<{ removed: string[]; kept: string[] }> {
	const wrote = lastSetup.get(root);
	lastSetup.delete(root);
	const removed: string[] = [];
	const kept: string[] = [];
	const name = (path: string) => relative(root, path);
	for (const [path, content] of wrote ?? []) {
		assertPathInsideRoot(root, path, true);
		if (!existsSync(path)) continue;
		if (lstatSync(path).isSymbolicLink()) {
			kept.push(name(path));
			continue;
		}
		if ((await Bun.file(path).text()) !== content) {
			kept.push(name(path));
			continue;
		}
		assertPathInsideRoot(root, path, true);
		unlinkSync(path);
		removed.push(name(path));
		// The folder it was in, and the one above, when the file was all they held.
		for (let dir = dirname(path); isPathInsideRoot(root, dir, true); dir = dirname(dir)) {
			if (lstatSync(dir).isSymbolicLink() || readdirSync(dir).length) break;
			rmdirSync(dir);
		}
	}
	return { removed, kept };
}

export const projectToml = (name: string) => `# SSL Studio project settings. Edit this file by hand: the IDE reads it and
# never rewrites it. Window layout and region colours are in settings.json.

[project]
name = ${JSON.stringify(name)}
description = ""

[folders]
# Where things are, relative to this project. Plans and tidy notes are always
# in design/.
docs = "docs"      # notes and decisions; the Docs panel lists the Markdown here
schema = "schema"  # what the data looks like: tables, messages, file layouts
tests = "tests"    # test scripts and what they need
code = "src"       # the scripts and data sources ("." when they are at the root)

[agent]
# The model for new agent sessions in this project, as "provider/model".
# Leave it out to use your own default.
# model = "ollama/qwen3:14b"

[style]
# "house" for the house style, "server" for the language server's defaults.
# preset = "house"
`;

export const readme = (project: Project) => `# ${project.name}

${PLACEHOLDER["README.md"]}

## What is here

| Folder | What it holds |
| --- | --- |
| \`${project.code}/\` | Scripts and data sources |
| \`${project.docs}/\` | Notes, tickets, specs, the knowledge base, registries |
| \`${project.schema}/\` | What the data looks like: tables, messages, file layouts |
| \`${project.tests}/\` | Test scripts and what they need |
| \`${project.plans}/\` | Plans (\`*.plan.json\`) and tidy notes |

## Working on it

Open this folder in SSL Studio. The Docs panel lists this file, \`AGENTS.md\`
and everything under \`${project.docs}/\` and \`${project.schema}/\`: the
tickets the work comes from with their specs, the knowledge base, and the
registries, each folder with its catalog (\`INDEX.md\`).
`;

export const agents = (project: Project) => `# Instructions for agents working on ${project.name}

Agents read this file before they work in this project. Keep it short and
specific to this project.

## What this project is

${PLACEHOLDER["AGENTS.md"]}

## Rules

- Follow the house style. The language server reports what breaks it.
- Keep each script under the size limits the Health panel shows.
- Do not rename a procedure or change its parameters unless asked.
- A table in the docs has at most four columns, short values in every column
  but the last, and at most one sentence in a cell.

## Where things are

- \`${project.code}/\`: scripts and data sources.
- \`${project.docs}/\`: notes and decisions.
- \`${project.docs}/tickets/\`: the tickets that drive the work, one file each. Read the ticket before starting on it.
- \`${project.docs}/specs/\`: what is to be built, written from the tickets.
- \`${project.docs}/knowledge/\`: decisions, questions, snippets, prompts and notes. Look here before deciding again; write a question here when something is not known.
- \`${project.docs}/registries/\`: tables of the settings, files and database objects a migration must carry across.
- Each of those four folders has an \`INDEX.md\`: its catalog. The docs, schema, code and tests folders have one too, where the project keeps one. Find a document or a file there, and do not edit the list between its markers.
- \`${project.schema}/\`: what the project's data looks like: the tables it reads and writes (under \`database/\`, where the folder is kept by kind), the messages it exchanges with other systems and what was agreed with them (\`interfaces/\`, a folder for each system) and the files it reads or writes (\`files/\`). Its \`INDEX.md\` is its catalog, kept like the others. Check a table there before writing SQL for it.
- \`${project.tests}/\`: test scripts and what they need.
- \`${project.plans}/\`: plans and tidy notes.
`;

/** What a TOML reader's own words come to, where they are a parser's and not a person's. */
const TOML_WORDS: [RegExp, (found: RegExpExecArray) => string][] = [
	[/^Expected t_equal\b/i, () => "A key is followed by = and a value, one to a line."],
	[/^Unexpected end of file/i, () => "The file ends in the middle of a value: something is not finished or not closed."],
	[/^Unterminated .*string/i, () => "This string is not closed."],
	[/^Cannot redefine key '(.+)'/i, (found) => `${found[1]} is set twice.`],
	[/^Expected (?:t_)?(\w+) but found (?:t_)?(.+)$/i, (found) => `${found[1]!.replace(/_/g, " ")} was expected here, not ${found[2]!.replace(/_/g, " ")}.`],
];

/**
 * The first thing that keeps a text from being TOML, and where; null when it
 * can be read. Read by the runtime's own TOML reader, the one project.toml is
 * read with, so what is marked is what would not load.
 */
export function tomlProblem(text: string): { message: string; line: number; column: number } | null {
	if (!text.trim()) return null;
	try {
		Bun.TOML.parse(text);
		return null;
	} catch (e: any) {
		const first = e?.errors?.[0] ?? e;
		const said = String(first?.message ?? e?.message ?? e);
		const worded = TOML_WORDS.map(([pattern, words]) => [pattern.exec(said), words] as const).find(([found]) => found);
		const lines = text.split(/\r?\n/).length;
		const line = Math.min(Math.max(Number(first?.position?.line ?? e?.line ?? 1), 1), lines);
		return { message: worded ? worded[1](worded[0]!) : said, line, column: Math.max(Number(first?.position?.column ?? 1), 1) };
	}
}

/** The kinds of file a ticket system exports, as a file dialog takes them. */
export const EXPORT_TYPES = "csv,tsv,json";
/** An export larger than this is not read. */
const EXPORT_BYTES = 20 * 1024 * 1024;

/**
 * The text of a ticket export at a path the person named: anywhere on the
 * machine, since an export is downloaded and not written in the project.
 * Only a table or JSON, and only of a size worth reading.
 */
export async function readExport(path: string): Promise<string> {
	// As a person writes a path: in quotes when it was copied from a file manager, from "~" for their own folder.
	path = path.trim().replace(/^(["'])(.*)\1$/, "$2");
	if (/^~[\\/]/.test(path)) path = join(homedir(), path.slice(2));
	if (!/\.(csv|tsv|json)$/i.test(path)) throw new Error("An export is a .csv, .tsv or .json file.");
	if (!isAbsolute(path)) throw new Error(`${path} is not a whole path.`);
	const file = Bun.file(path);
	if (!(await file.exists())) throw new Error(`${path} is not there.`);
	if (file.size > EXPORT_BYTES) throw new Error(`${path} is too large to read here: more than 20 MB.`);
	// Read as what it is written in: a table saved from a spreadsheet on Windows is seldom UTF-8.
	return decode(new Uint8Array(await file.arrayBuffer())).text;
}

const IMAGE_ASSET_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const HTML_IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
const WIKI_EMBED_IMG_RE = /!\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;

type CachedDocAuditEntry = {
	stamp: string;
	text: string;
	links: DocLink[];
	selfAnchors: { line: number; column: number; anchor: string; href: string }[];
	wikis: ReturnType<typeof namePlaces>;
	wikiSections: { line: number; column: number; target: string; section: string }[];
	imgRefs: string[];
	openTasks: { line: number; offset: number; text: string }[];
	tableIssues: { line: number; message: string }[];
	yamlIssues: { line: number; message: string }[];
	duplicateHeadings: { heading: string; line: number; firstLine: number }[];
};
const auditFileCache = new Map<string, CachedDocAuditEntry>();
const AUDIT_CACHE_MAX = 2000;

function inlineCodeRanges(line: string): [number, number][] {
	const ranges: [number, number][] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] !== "`") {
			i++;
			continue;
		}
		let run = 0;
		while (i + run < line.length && line[i + run] === "`") run++;
		let j = i + run;
		let closed = -1;
		while (j < line.length) {
			if (line[j] !== "`") {
				j++;
				continue;
			}
			let cRun = 0;
			while (j + cRun < line.length && line[j + cRun] === "`") cRun++;
			if (cRun === run) {
				closed = j + cRun;
				break;
			}
			j += cRun;
		}
		if (closed >= 0) {
			ranges.push([i, closed]);
			i = closed;
		} else i += run;
	}
	return ranges;
}

function extractSelfAnchors(text: string): { line: number; column: number; anchor: string; href: string }[] {
	if (!text.includes("](#")) return [];
	const lines = text.split(/\r?\n/);
	const fences = fenced(text);
	const opening = frontMatter(text).lines;
	const out: { line: number; column: number; anchor: string; href: string }[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const start = offset;
		offset += line.length + (text[start + line.length] === "\r" ? 2 : 1);
		if (i < opening || !line.includes("](#")) continue;
		if (fences.some(([from, to]) => start >= from && start < to)) continue;
		const codeSpans = line.includes("`") ? inlineCodeRanges(line) : [];
		for (const m of line.matchAll(/(?<!\!)\[[^\]]+\]\((#[^)\s]+)\)/g)) {
			const idx = m.index ?? 0;
			if (codeSpans.some(([a, b]) => idx >= a && idx < b)) continue;
			const href = m[1]!;
			let anchor = href.slice(1).trim();
			try {
				anchor = decodeURIComponent(anchor);
			} catch {}
			if (anchor && !/^L\d+(?:-L?\d+)?$/i.test(anchor)) {
				out.push({ line: i + 1, column: idx + 1, anchor, href });
			}
		}
	}
	return out;
}

function extractWikiSections(text: string): { line: number; column: number; target: string; section: string }[] {
	if (!text.includes("[[") || !text.includes("#")) return [];
	const lines = text.split(/\r?\n/);
	const fences = fenced(text);
	const opening = frontMatter(text).lines;
	const out: { line: number; column: number; target: string; section: string }[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const start = offset;
		offset += line.length + (text[start + line.length] === "\r" ? 2 : 1);
		if (i < opening || !line.includes("[[") || !line.includes("#")) continue;
		if (fences.some(([from, to]) => start >= from && start < to)) continue;
		const codeSpans = line.includes("`") ? inlineCodeRanges(line) : [];
		for (const m of line.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
			const idx = m.index ?? 0;
			if (codeSpans.some(([a, b]) => idx >= a && idx < b)) continue;
			const raw = m[1]!.replace(/\\\|/g, "|").split("|")[0]!.trim();
			const hash = raw.indexOf("#");
			if (hash < 0) continue;
			const target = raw.slice(0, hash).trim();
			const section = raw.slice(hash + 1).trim();
			if (section) out.push({ line: i + 1, column: idx + 2, target, section });
		}
	}
	return out;
}

function yamlSyntaxIssues(text: string): { line: number; message: string }[] {
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	let startIdx = 0;
	if (/^\s*<!--\s*template\b[\s\S]*?-->\s*$/i.test(lines[0] ?? "")) startIdx = 1;
	if ((lines[startIdx] ?? "").trim() !== "---") return [];
	const endIdx = lines.findIndex((l, i) => i > startIdx && /^(---|\.\.\.)\s*$/.test(l));
	if (endIdx < 0) {
		const looksLikeYaml = lines.slice(startIdx + 1, startIdx + 7).some((l) => /^[A-Za-z0-9_-]+\s*:/.test(l));
		return looksLikeYaml ? [{ line: startIdx + 1, message: "Unclosed YAML frontmatter block (missing closing ---)." }] : [];
	}
	const out: { line: number; message: string }[] = [];
	let inList = false;
	let inBlockScalar = false;
	let blockIndent = 0;
	for (let i = startIdx + 1; i < endIdx; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (inBlockScalar) {
			const indent = /^([ \t]*)/.exec(line)![1]!.length;
			if (indent > blockIndent) continue;
			inBlockScalar = false;
		}
		if (trimmed.startsWith("#")) continue;
		if (/^\s*-\s+/.test(line)) {
			if (!inList) out.push({ line: i + 1, message: "YAML list item has no preceding key." });
			continue;
		}
		if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
			const afterColon = line.slice(line.indexOf(":") + 1).trim();
			if (/^[|>][+-]?\d*(?:\s+#.*)?$/.test(afterColon)) {
				inBlockScalar = true;
				blockIndent = /^([ \t]*)/.exec(line)![1]!.length;
				inList = false;
			} else {
				inList = /^[A-Za-z0-9_-]+\s*:\s*(?:#.*)?$/.test(line);
			}
			continue;
		}
		// Allow indented scalar continuation lines under a key, flag unindented malformed lines.
		if (!/^\s+/.test(line)) {
			out.push({ line: i + 1, message: "Malformed YAML frontmatter line (missing ':')." });
		}
	}
	return out;
}

function buildAuditEntryFromText(path: string, text: string, stamp: string, checkTableRule: boolean): CachedDocAuditEntry {
	const links = linksIn(path, text, "F");
	const selfAnchors = extractSelfAnchors(text);
	const wikis = namePlaces(text);
	const wikiSections = extractWikiSections(text);
	const imgRefs: string[] = [];
	for (const m of text.matchAll(HTML_IMG_SRC_RE)) {
		const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
		if (raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) imgRefs.push(raw);
	}
	for (const m of text.matchAll(WIKI_EMBED_IMG_RE)) {
		const raw = (m[1] ?? "").trim();
		if (raw && IMAGE_ASSET_RE.test(raw)) imgRefs.push(raw);
	}
	const openTasks = tasksIn(text)
		.filter((t) => !t.done && t.line > 0)
		.map((t) => ({ line: t.line, offset: t.offset, text: t.text }));
	const tableIssues = checkTableRule
		? checkTables(text).map((f) => ({ line: f.line, message: f.message }))
		: [];
	const yamlIssues = yamlSyntaxIssues(text);
	const duplicateHeadings = findDuplicateHeadings(text);
	return { stamp, text, links, selfAnchors, wikis, wikiSections, imgRefs, openTasks, tableIssues, yamlIssues, duplicateHeadings };
}

async function readAuditEntry(path: string, checkTableRule: boolean, overrideText?: string): Promise<CachedDocAuditEntry | null> {
	if (overrideText !== undefined) {
		return buildAuditEntryFromText(path, overrideText, "dirty", checkTableRule);
	}
	let stamp = "";
	try {
		const st = statSync(path);
		if (st.size > LINKED_BYTES) return null;
		stamp = `${fileStamp(st)}:${checkTableRule ? 1 : 0}`;
	} catch {
		return null;
	}
	const cached = auditFileCache.get(path);
	if (cached && cached.stamp === stamp) {
		auditFileCache.delete(path);
		auditFileCache.set(path, cached);
		return cached;
	}
	let text = "";
	try {
		text = decode(new Uint8Array(await Bun.file(path).arrayBuffer())).text;
	} catch {
		return null;
	}
	const entry = buildAuditEntryFromText(path, text, stamp, checkTableRule);
	if (auditFileCache.size >= AUDIT_CACHE_MAX) auditFileCache.delete(auditFileCache.keys().next().value!);
	auditFileCache.set(path, entry);
	return entry;
}

/**
 * Cached workspace-wide Markdown audit (no 250-file cap):
 * 1. Unused image attachments across `attachmentsFolder` (default `<docs>/attachments`) AND `<tickets>/<KEY>/attachments/` (including depth-2 & `archive/` bundles),
 *    resolved against actual links, embeds, and HTML `<img>` tags across ALL workspace Markdown files.
 * 2. Open `- [ ]` tasks across active (non-archived, non-catalog, non-done) project documents.
 * 3. Workspace hygiene issues: broken `#heading` anchors, ADR 0008 table-rule findings (non-schema docs), malformed YAML frontmatter, and `#L` code citation drift.
 */
export async function docAudit(
	files: WorkspaceFiles,
	project: Project,
	attachmentsFolder?: string,
	options?: { templatesFolder?: string; dirtyBuffers?: Record<string, string> },
): Promise<DocAuditResult> {
	const root = files.root;
	const docsRel = project.docs.replace(/^[./\\]+|[\\/]+$/g, "");
	const schemaRel = project.schema.replace(/^[./\\]+|[\\/]+$/g, "");
	const schemaPrefix = schemaRel && schemaRel !== "." ? `${schemaRel.toLowerCase()}/` : "";
	const customAttachRel = (attachmentsFolder ?? "").trim().replace(/\\/g, "/").replace(/^[./]+|\/+$/g, "");
	const defaultAttachRel = docsRel && docsRel !== "." ? `${docsRel}/attachments` : "attachments";
	const attachPrefixes = new Set<string>([`${(customAttachRel || defaultAttachRel).toLowerCase()}/`]);
	const ticketsRel = docsRel && docsRel !== "." ? `${docsRel}/${DOC_FOLDERS.tickets}` : DOC_FOLDERS.tickets;
	// Match depth-1 (`tickets/KEY/attachments/`), depth-2 (`tickets/sprint-1/KEY/attachments/`), and archived (`tickets/archive/KEY/attachments/`).
	const ticketsAttachRe = new RegExp(`^${ticketsRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase()}/(?:[^/]+/){1,2}attachments/`, "i");

	const allWsFiles = files.files();
	const candidateImages: string[] = [];
	const allMdFiles: string[] = [];
	const allSqlQueryFiles: string[] = [];
	const SQL_OR_DS_RE = /\.(sql|ds)$/i;
	for (const p of allWsFiles) {
		const rel = relative(root, p).split(sep).join("/");
		const relLow = rel.toLowerCase();
		if (MARKDOWN.test(p)) {
			allMdFiles.push(p);
		} else if (SQL_OR_DS_RE.test(p) && !relLow.startsWith(".ssl-studio/")) {
			allSqlQueryFiles.push(p);
		} else if (IMAGE_ASSET_RE.test(p)) {
			if ([...attachPrefixes].some((pref) => relLow.startsWith(pref)) || ticketsAttachRe.test(relLow)) {
				candidateImages.push(p);
			}
		}
	}

	const truncatedFolders: { folder: string; limit: number }[] = [];
	const docsList = await listDocs(files, project, { templatesFolder: options?.templatesFolder, truncatedOut: truncatedFolders });
	const docByPath = new Map<string, DocFile>();
	const fold = (p: string) => (process.platform === "linux" ? resolve(p) : resolve(p).toLowerCase());
	for (const d of docsList) docByPath.set(fold(d.path), d);
	const docNameIndex = buildDocNameIndex(docsList, root);

	const dirtyMap = new Map<string, string>();
	for (const [k, v] of Object.entries(options?.dirtyBuffers ?? {})) {
		dirtyMap.set(fold(k), v);
	}

	const usedImagePaths = new Set<string>();
	const usedImageNames = new Set<string>();
	const incomingDocPaths = new Set<string>();
	const mdEntries = new Map<string, CachedDocAuditEntry>();
	const openTasks: OpenTaskItem[] = [];
	const issues: WorkspaceDocIssue[] = [];
	const citationIssues: AuditCitationIssue[] = [];
	const schemaDrift: SchemaDriftItem[] = [];

	for (const mdPath of allMdFiles) {
		const rel = relative(root, mdPath).split(sep).join("/");
		const relLow = rel.toLowerCase();
		const inSchema = Boolean(schemaPrefix && relLow.startsWith(schemaPrefix));
		const foldedMd = fold(mdPath);
		const entry = await readAuditEntry(mdPath, !inSchema, dirtyMap.get(foldedMd));
		if (!entry) continue;
		mdEntries.set(foldedMd, entry);

		// Collect referenced images from Markdown links/images, HTML <img>, and ![[image]] embeds.
		// Only bare basename embeds (`![[shot.png]]`, no `/` or `\`) populate `usedImageNames`, so an explicit
		// relative link `attachments/shot.png` never masks an unrelated orphan `shot.png` in another folder.
		const markImageRef = (rawRef: string, allowBasenameMatch = false) => {
			let cleaned = rawRef.split(/[?#]/)[0]!.trim();
			try {
				cleaned = decodeURIComponent(cleaned);
			} catch {
				// Keep raw string if invalid percent sequence.
			}
			if (!cleaned || !IMAGE_ASSET_RE.test(cleaned)) return;
			const target = linkTarget(root, mdPath, cleaned);
			usedImagePaths.add(fold(target));
			if (allowBasenameMatch && !cleaned.includes("/") && !cleaned.includes("\\")) {
				usedImageNames.add(basename(cleaned).toLowerCase());
			}
		};
		for (const link of entry.links) markImageRef(link.file, false);
		for (const ref of entry.imgRefs) markImageRef(ref, !ref.includes("/") && !ref.includes("\\"));
		for (const w of entry.wikis) {
			if (IMAGE_ASSET_RE.test(w.name)) markImageRef(w.name, true);
		}

		// Surface YAML, duplicate-heading, & ADR 0008 table-rule issues for project docs (excluding catalogs).
		const docMeta = docByPath.get(foldedMd);
		const sourceIsCatalog = Boolean(docMeta && isCatalog(docMeta));
		if (!sourceIsCatalog) {
			for (const link of entry.links) {
				if (link.file) incomingDocPaths.add(linkTarget(root, mdPath, link.file));
			}
			for (const w of entry.wikis) {
				if (IMAGE_ASSET_RE.test(w.name)) continue;
				const hit = lookupInIndex(w.name, docNameIndex);
				if (hit) incomingDocPaths.add(hit.path);
				else if (/[\\/]|\.[a-z0-9]{1,8}$/i.test(w.name)) {
					incomingDocPaths.add(linkTarget(root, mdPath, w.name));
				}
			}
			for (const fp of frontPaths(entry.text)) {
				const leads = /^\.{1,2}[\\/]/.test(fp.value) ? resolve(dirname(mdPath), fp.value) : join(root, fp.value);
				incomingDocPaths.add(leads);
			}
		}
		if (docMeta && !isCatalog(docMeta)) {
			for (const y of entry.yamlIssues) {
				issues.push({ path: mdPath, line: y.line, kind: "yaml", level: "warn", message: y.message });
			}
			for (const t of entry.tableIssues) {
				issues.push({ path: mdPath, line: t.line, kind: "table", level: "note", message: t.message });
			}
			for (const dup of entry.duplicateHeadings) {
				issues.push({
					path: mdPath,
					line: dup.line,
					kind: "duplicate-heading",
					level: "note",
					message: `Duplicate heading "${dup.heading}" (first defined on line ${dup.firstLine}).`,
				});
			}
			// Aggregate open `- [ ]` tasks for active (non-archived, non-done/off) docs.
			const isArchived = /(?:^|\/)archive\//i.test(rel);
			const tone = docMeta.status ? toneOf(docMeta.status) : "active";
			if (!isArchived && tone !== "done" && tone !== "off" && entry.openTasks.length) {
				for (const t of entry.openTasks) {
					openTasks.push({
						path: mdPath,
						name: docMeta.name,
						...(docMeta.title ? { title: docMeta.title } : {}),
						...(docMeta.ticket ? { ticket: docMeta.ticket } : {}),
						group: docMeta.group,
						line: t.line,
						offset: t.offset,
						text: t.text,
					});
				}
			}
		}
	}

	// Second pass: verify `#heading` fragment anchors on Markdown links and `[[doc#Heading]]` wikilinks,
	// AND verify `#L10-L20` code citations across all workspace project docs (case-insensitive, uncapped).
	const targetReadCache = new Map<string, string | null>();
	const readTarget = async (targetPath: string): Promise<string | null> => {
		const f = fold(targetPath);
		if (!isInsideWorkspace(root, targetPath)) {
			targetReadCache.set(f, null);
			return null;
		}
		if (dirtyMap.has(f)) return dirtyMap.get(f)!;
		if (targetReadCache.has(f)) return targetReadCache.get(f)!;
		try {
			const s = statSync(targetPath);
			if (s.size > LINKED_BYTES) {
				targetReadCache.set(f, null);
				return null;
			}
			const txt = decode(new Uint8Array(await Bun.file(targetPath).arrayBuffer())).text;
			targetReadCache.set(f, txt);
			return txt;
		} catch {
			targetReadCache.set(f, null);
			return null;
		}
	};

	for (const mdPath of allMdFiles) {
		const docMeta = docByPath.get(fold(mdPath));
		if (!docMeta || isCatalog(docMeta)) continue;
		const entry = mdEntries.get(fold(mdPath));
		if (!entry) continue;
		// Same-document Markdown `#anchor` links (`[section](#missing)`).
		for (const a of entry.selfAnchors) {
			if (findHeadingLine(entry.text, a.anchor) === null) {
				issues.push({
					path: mdPath,
					line: a.line,
					column: a.column,
					kind: "anchor",
					level: "warn",
					message: `Heading "#${a.anchor}" was not found in ${basename(mdPath)}.`,
					href: a.href,
				});
			}
		}
		// Standard Markdown links with `#anchor` (e.g. `[x](spec.md#bad)`).
		for (const link of entry.links) {
			const hashIdx = link.href.indexOf("#");
			if (hashIdx < 0) continue;
			let anchor = link.href.slice(hashIdx + 1).trim();
			try {
				anchor = decodeURIComponent(anchor);
			} catch {
				// keep raw
			}
			if (!anchor || /^L\d+(?:-L?\d+)?$/i.test(anchor)) continue;
			const targetPath = link.file ? linkTarget(root, mdPath, link.file) : mdPath;
			if (!MARKDOWN.test(targetPath)) continue;
			const targetEntry = mdEntries.get(fold(targetPath));
			if (!targetEntry) continue;
			if (findHeadingLine(targetEntry.text, anchor) === null) {
				issues.push({
					path: mdPath,
					line: link.line,
					column: link.column,
					kind: "anchor",
					level: "warn",
					message: `Heading "#${anchor}" was not found in ${link.file || basename(mdPath)}.`,
					href: link.href,
				});
			}
		}
		// Wikilinks with `#Heading` (e.g. `[[Spec#Bad]]` or `[[#Bad]]`).
		for (const w of entry.wikiSections) {
			const targetDoc = w.target ? lookupInIndex(w.target, docNameIndex) : docMeta;
			if (!targetDoc || !MARKDOWN.test(targetDoc.path)) continue;
			const targetEntry = mdEntries.get(fold(targetDoc.path));
			if (!targetEntry) continue;
			if (findHeadingLine(targetEntry.text, w.section) === null) {
				issues.push({
					path: mdPath,
					line: w.line,
					column: w.column,
					kind: "anchor",
					level: "warn",
					message: `Heading "#${w.section}" was not found in ${w.target || basename(mdPath)}.`,
					href: `[[${w.target}#${w.section}]]`,
				});
			}
		}
		// `#L10-L20` code citation drift check (case-insensitive pre-filter, uncapped).
		if (/#l\d+/i.test(entry.text)) {
			const foundCits = await checkCodeCitations(mdPath, entry.text, root, readTarget);
			for (const ci of foundCits) {
				citationIssues.push(ci);
				issues.push({
					path: ci.docPath,
					line: ci.docLine,
					kind: "citation",
					level: ci.level,
					message: ci.text,
					href: ci.citation.href,
				});
			}
		}
	}

	// Third pass: schema DDL drift checks against Markdown schema docs with `source: *.sql`.
	for (const doc of docsList) {
		if (!doc.exists || doc.group !== "schema" || isCatalog(doc) || !MARKDOWN.test(doc.path)) continue;
		if (!doc.source || doc.missingSource || /^https?:\/\//i.test(doc.source)) continue;
		const cleanSrc = doc.source.split(/[?#]/)[0]!.trim();
		if (!cleanSrc) continue;
		const sqlPath = /^\.{1,2}[\\/]/.test(cleanSrc) ? resolve(dirname(doc.path), cleanSrc) : join(root, cleanSrc);
		if (!/\.(sql|ddl|pks|pkb)$/i.test(sqlPath) || !existsInWorkspace(root, sqlPath)) continue;
		const sqlText = await readTarget(sqlPath);
		const mdText = mdEntries.get(fold(doc.path))?.text ?? (await readTarget(doc.path));
		if (sqlText === null || mdText === null) continue;
		for (const diff of diffSqlAgainstSchemaMarkdown(sqlText, mdText)) {
			schemaDrift.push({
				schemaPath: doc.path,
				sqlPath,
				table: diff.table,
				added: diff.added,
				modified: diff.modified,
				dropped: diff.dropped,
			});
			const summaryParts = [
				diff.added.length ? `+${diff.added.length} added` : "",
				diff.modified.length ? `~${diff.modified.length} modified` : "",
				diff.dropped.length ? `-${diff.dropped.length} dropped` : "",
			].filter(Boolean);
			issues.push({
				path: doc.path,
				line: 1,
				kind: "schema-drift",
				level: "warn",
				message: `Schema drift in ${diff.table} vs ${basename(sqlPath)} (${summaryParts.join(", ")}).`,
			});
		}
	}

	// Fourth pass: scan `.sql` and STARLIMS `.ds` files for references to undocumented tables.
	const knownTables = new Set<string>();
	for (const doc of docsList) {
		if (!doc.exists || isCatalog(doc)) continue;
		if (doc.group === "schema") {
			for (const k of schemaDocKeys(doc)) knownTables.add(k);
		} else if (doc.group === "registries" && /(^|[\\/])database\.(csv|tsv)$/i.test(doc.name)) {
			for (const ref of doc.codeRefs ?? []) {
				const clean = ref.trim().toLowerCase();
				if (!clean) continue;
				knownTables.add(clean);
				if (clean.includes(".")) knownTables.add(clean.split(".").pop()!);
			}
		}
	}
	const sqlQueryInputs: { path: string; text: string }[] = [];
	for (const qPath of allSqlQueryFiles) {
		const txt = await readTarget(qPath);
		if (txt) sqlQueryInputs.push({ path: qPath, text: txt });
	}
	const undocumentedRefs: UndocumentedSchemaRef[] = findUndocumentedSqlRefs(sqlQueryInputs, knownTables);

	// Fifth pass: workspace orphan docs and stale hygiene checks.
	for (const orphan of orphanDocChecks(docsList, incomingDocPaths, { root })) {
		issues.push(orphan);
	}
	for (const stale of staleDocChecks(docsList)) {
		issues.push(stale);
	}

	const unusedAttachments = candidateImages.filter((imgPath) => {
		const f = fold(imgPath);
		if (usedImagePaths.has(f)) return false;
		// Wiki embeds `![[shot.png]]` resolve by basename across attachments folders.
		if (usedImageNames.has(basename(imgPath).toLowerCase())) return false;
		return true;
	});

	return { unusedAttachments, openTasks, issues, citationIssues, schemaDrift, undocumentedRefs, truncatedFolders };
}

