// A project is a workspace folder with `.ssl-studio/project.toml`, a
// README.md and an AGENTS.md at its root. The IDE writes all three once, from
// the templates below, and after that only reads them: project.toml is edited
// as text, so its comments survive.
import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { decode, decodePart, textOf } from "./encoding";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CATALOG_FILE, catalogStale, fenced, hasCatalogPlace } from "../shared/catalog";
import { parseCsv, tally, type Table } from "../shared/csv";
import { fileLinks, frontPaths, type DocLink } from "../shared/docLinks";
import { checkTables } from "../shared/docTables";
import { frontMatter, many, one, summaryOf, titleOf } from "../shared/frontMatter";
import { findHeadingLine } from "../shared/markdownEdit";
import { buildDocNameIndex, lookupInIndex, namePlaces } from "../shared/namedLinks";
import { areaPath, CATALOG_AREAS, CATALOG_FILES_MAX, catalogItems, catalogTemplate, DOC_FOLDERS, fileItems, isCatalog, isFileArea, isPrompt, OPTIONAL_CATALOGS, SCHEMAS, STATE_FILE, toneOf, type AreaFolders, type DocArea, type FileArea } from "../shared/projectDocs";
import { keysIn, rowsByTicket, ticketColumn } from "../shared/registryTickets";
import { extractTags } from "../shared/tags";
import { tasks as tasksIn, taskTally } from "../shared/tasks";
import { classifyTicketEntries, type ScannedTicketEntry } from "../shared/ticketBundle";
import type { DocAuditResult, DocFile, LinkTo, ManifestFile, NameIn, OpenTaskItem, Project, Settings, WorkspaceDocIssue } from "../shared/protocol";
import { workspaceDir } from "./paths";
import { WorkspaceFiles } from "./workspace";

export const PROJECT_FILE = "project.toml";
const DOC_LIMIT = 500;
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
	const project: Project = { configured: existsSync(path), path, name: basename(root), description: "", docs: "docs", schema: "schema", tests: "tests", code: "src", plans: "design" };
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

/** The settings a project chooses for everyone who opens it. */
export function projectSettings(project: Project): Partial<Settings> {
	return { agentModel: project.agentModel, stylePreset: project.stylePreset };
}

/** The file's name as it is on disk, whatever its case (readme.md, Readme.md). */
function found(root: string, name: string): string | undefined {
	return readdirSync(root).find((f) => f.toLowerCase() === name.toLowerCase());
}

/** The most of a document that is read to learn its title and state. */
const HEAD_BYTES = 64 * 1024;
/** A registry larger than this is listed without being read. */
const REGISTRY_BYTES = 4 * 1024 * 1024;
const MARKDOWN = /\.(md|markdown)$/i;

const headRead = new Map<string, { stamp: string; text: string }>();
const HEAD_KEPT = 2000;

async function head(path: string): Promise<string> {
	try {
		const st = statSync(path);
		const stamp = `${st.size}:${st.mtimeMs}`;
		const kept = headRead.get(path);
		if (kept && kept.stamp === stamp) {
			headRead.delete(path);
			headRead.set(path, kept);
			return kept.text;
		}
		const file = Bun.file(path);
		const decoded = decodePart(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()), file.size > HEAD_BYTES);
		if (headRead.size >= HEAD_KEPT) headRead.delete(headRead.keys().next().value!);
		headRead.set(path, { stamp, text: decoded });
		return decoded;
	} catch {
		return "";
	}
}

/** What a plan says of itself: ticket, title, status, and referenced code/script targets; empty when unreadable. */
async function planSays(path: string): Promise<{ ticket: string; title: string; status: string; codeRefs: string[] }> {
	try {
		const plan = await Bun.file(path).json();
		const word = (value: unknown) => (typeof value === "string" ? value.trim() : "");
		const refs = new Set<string>();
		const pushRef = (val: unknown) => {
			if (typeof val === "string" && val.trim()) refs.add(val.trim().split("\\").join("/"));
			else if (val && typeof val === "object" && "path" in val && typeof (val as { path?: unknown }).path === "string") {
				const p = ((val as { path: string }).path).trim();
				if (p) refs.add(p.split("\\").join("/"));
			}
		};
		if (Array.isArray(plan?.targets)) for (const t of plan.targets) pushRef(t);
		if (Array.isArray(plan?.scripts)) for (const s of plan.scripts) pushRef(s);
		if (Array.isArray(plan?.built?.units)) {
			for (const u of plan.built.units) pushRef((u as { script?: unknown })?.script);
		}
		return { ticket: word(plan?.ticket), title: word(plan?.title), status: word(plan?.status), codeRefs: [...refs] };
	} catch {
		return { ticket: "", title: "", status: "", codeRefs: [] };
	}
}

const CODE_FILE_EXT_RE = /\.(ssl|srvscr|ds|sql|ddl|pks|pkb|xfd|xml|hl7|astm)$/i;
const INLINE_CODE_FILE_RE = /`([A-Za-z0-9_./\\-]+\.(?:ssl|srvscr|ds|sql|ddl|pks|pkb|xfd|xml|hl7|astm))`/gi;
const REGISTRY_CODE_COL_RE = /^(path|file|script|scripts|where|used[\s_-]*by|source|object)$/i;

/** Extracts workspace-relative code/SQL file references from Markdown links, `source:` frontmatter, and inline code mentions. */
function markdownCodeRefs(root: string, path: string, text: string): string[] {
	const refs = new Set<string>();
	const addPath = (raw: string) => {
		const cleaned = raw.trim().split("\\").join("/").replace(/^\.\//, "");
		if (!cleaned) return;
		if (CODE_FILE_EXT_RE.test(cleaned)) refs.add(cleaned);
	};
	const fm = frontMatter(text);
	for (const s of many(fm.values.source)) addPath(s);
	for (const link of linksIn(path, text)) {
		if (!CODE_FILE_EXT_RE.test(link.file)) continue;
		const target = linkTarget(root, path, link.file);
		const rel = relative(root, target).split(sep).join("/");
		if (!rel.startsWith("..") && !isAbsolute(rel)) refs.add(rel);
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

/** How many of a text's tasks are ticked, read once for a text and kept: it is a pass of the renderer over the document. */
const talliesRead = new Map<number | bigint, ReturnType<typeof taskTally>>();
function tallyOf(text: string): ReturnType<typeof taskTally> {
	if (!/\[[ xX]\]/.test(text)) return null;
	const hash = Bun.hash(text);
	if (talliesRead.has(hash)) return talliesRead.get(hash)!;
	const tally = taskTally(text);
	if (talliesRead.size >= 1000) talliesRead.delete(talliesRead.keys().next().value!);
	talliesRead.set(hash, tally);
	return tally;
}

/** What a Markdown document says of itself, for the panel, catalogs, tags, health, and code traceability. */
function described(
	text: string,
	root?: string,
	path?: string,
): Pick<DocFile, "title" | "status" | "summary" | "tickets" | "untouched" | "tasks" | "tags" | "source" | "missingSource" | "supersedes" | "supersededBy" | "blocks" | "blockedBy" | "codeRefs"> {
	const { values } = frontMatter(text);
	const tickets = [...many(values.ticket), ...many(values.tickets)];
	const tasks = tallyOf(text);
	const tags = extractTags(text);
	const source = one(values.source) || undefined;
	let missingSource: string | undefined;
	if (source && root && !/^https?:\/\//i.test(source)) {
		const target = join(root, source);
		const rel = relative(root, target);
		if (!rel.startsWith("..") && !isAbsolute(rel) && !existsSync(target)) missingSource = source;
	}
	const supersedes = many(values.supersedes);
	const supersededBy = many(values["superseded-by"]);
	const blocks = many(values.blocks);
	const blockedBy = many(values["blocked-by"]);
	const codeRefs = root && path ? markdownCodeRefs(root, path, text) : [];
	return {
		title: titleOf(text) || undefined,
		status: one(values.status) || undefined,
		summary: said(summaryOf(text)),
		...(tickets.length ? { tickets } : {}),
		...(isPrompt(summaryOf(text)) ? { untouched: true } : {}),
		...(tasks ? { tasks } : {}),
		...(tags.length ? { tags } : {}),
		...(source ? { source } : {}),
		...(missingSource ? { missingSource } : {}),
		...(supersedes.length ? { supersedes } : {}),
		...(supersededBy.length ? { supersededBy } : {}),
		...(blocks.length ? { blocks } : {}),
		...(blockedBy.length ? { blockedBy } : {}),
		...(codeRefs.length ? { codeRefs } : {}),
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

/** Cached `parseCsv()` per registry file, keyed by path + size + mtimeMs. */
const csvRead = new Map<string, { stamp: string; table: ReturnType<typeof parseCsv> }>();
const CSV_KEPT = 256;

async function cachedParseCsv(path: string, size: number, mtimeMs: number): Promise<ReturnType<typeof parseCsv>> {
	const stamp = `${size}:${mtimeMs}`;
	const kept = csvRead.get(path);
	if (kept && kept.stamp === stamp) return kept.table;
	const table = parseCsv(await textOf(path));
	if (csvRead.size >= CSV_KEPT) csvRead.delete(csvRead.keys().next().value!);
	csvRead.set(path, { stamp, table });
	return table;
}

/** The file a link in a document leads to. A path from the top is from the project's top, as a repository's page reads it. */
const linkTarget = (root: string, path: string, file: string) => (file.startsWith("/") ? join(root, file) : resolve(dirname(path), file));

function brokenLinks(root: string, path: string, text: string, named?: (name: string) => string[]): Pick<DocFile, "broken"> {
	const broken = linksIn(path, text)
		.filter((link) => {
			const target = linkTarget(root, path, link.file);
			// What is outside the project is not this project's to say: it may well be there on another machine.
			const from = relative(root, target);
			return !from.startsWith("..") && !isAbsolute(from) && !existsSync(target);
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

/** A Markdown document larger than this is not read for the links it holds. */
const LINKED_BYTES = 1024 * 1024;
/** No more Markdown documents than this are read when asked what links to a file. */
const LINKING_DOCS = 2000;

/**
 * The links, in the workspace's Markdown documents, that lead to a file or
 * to something in a folder: what a rename leaves pointing at the old name.
 * It asks only where each link leads, not whether anything is there, so it
 * is as true after the rename as before it.
 */
export async function linksTo(files: WorkspaceFiles, target: string): Promise<LinkTo[]> {
	const root = files.root;
	// A file system that does not tell case apart names one file either way.
	const fold = (path: string) => (process.platform === "linux" ? path : path.toLowerCase());
	const wanted = fold(resolve(target));
	const found: LinkTo[] = [];
	let read = 0;
	for (const path of files.files()) {
		if (!MARKDOWN.test(path)) continue;
		if (++read > LINKING_DOCS) break;
		const file = Bun.file(path);
		if (file.size > LINKED_BYTES) continue;
		let text = "";
		try {
			text = decode(new Uint8Array(await file.arrayBuffer())).text;
		} catch {
			continue;
		}
		const leadsThere = (leads: string) => fold(leads) === wanted || fold(leads).startsWith(wanted + sep);
		// A ticket's "specs:" line names files from the project's top: not links, and left behind by a rename all the same.
		for (const named of frontPaths(text)) {
			const leads = join(root, named.value);
			if (leadsThere(leads)) found.push({ path, line: named.line, column: named.column, href: named.value, rest: leads.slice(resolve(target).length), from: "root" });
		}
		if (!text.includes("](") && !text.includes("]:")) continue;
		for (const link of linksIn(path, text, "F")) {
			if (!link.line) continue;
			const leads = linkTarget(root, path, link.file);
			if (leadsThere(leads)) found.push({ path, line: link.line, column: link.column, href: link.href, rest: leads.slice(resolve(target).length), from: link.file.startsWith("/") ? "top" : "doc" });
		}
	}
	return found;
}

/**
 * The links by name in the workspace's Markdown documents, as they stand on
 * disk: what a document is linked from by name, and what a rename may leave
 * meaning nothing. Which document each name means is not asked here.
 */
export async function namesIn(files: WorkspaceFiles): Promise<NameIn[]> {
	const found: NameIn[] = [];
	let read = 0;
	for (const path of files.files()) {
		if (!MARKDOWN.test(path)) continue;
		if (++read > LINKING_DOCS) break;
		let stamp = "";
		try {
			const s = statSync(path);
			if (s.size > LINKED_BYTES) continue;
			stamp = `${s.size}:${s.mtimeMs}`;
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

export async function listDocs(files: WorkspaceFiles, project: Project): Promise<DocFile[]> {
	const root = files.root;
	const list: DocFile[] = [];
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
		const text = actual ? await textOf(path) : "";
		const untouched = actual ? text.includes(PLACEHOLDER[name]!) : undefined;
		const codeRefs = actual ? markdownCodeRefs(root, path, text) : [];
		list.push({ path, name: actual ?? name, group: "project", exists: Boolean(actual), untouched, ...(codeRefs.length ? { codeRefs } : {}), ...brokenLinks(root, path, text, named) });
	}
	list.push({ path: project.path, name: PROJECT_FILE, group: "project", exists: project.configured });
	const docs = join(root, project.docs);
	const state = existsSync(docs) ? found(docs, STATE_FILE) : undefined;
	if (state) {
		const statePath = join(docs, state);
		const text = await head(statePath);
		list.push({ path: statePath, name: state, group: "project", exists: true, ...described(text, root, statePath), ...brokenLinks(root, statePath, text, named) });
	}

	/** The files under a folder that match, by name, up to the limit. */
	const under = (full: string, pattern: RegExp, skip?: (path: string) => boolean) => {
		if (!existsSync(full)) return [];
		const paths: string[] = [];
		// What is skipped does not count towards the limit: a folder of tickets must not crowd out the documents beside it.
		for (const path of files.files(full)) if (pattern.test(path) && !skip?.(path) && paths.push(path) >= DOC_LIMIT) break;
		return paths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
	};
	const area = (name: DocArea) => join(docs, DOC_FOLDERS[name]);
	const templatesDir = join(docs, "templates");
	const inArea = (path: string) =>
		(Object.keys(DOC_FOLDERS) as DocArea[]).some((name) => path.startsWith(area(name) + sep)) ||
		path.startsWith(templatesDir + sep);

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
		const ticketHeads = new Map<string, string>();
		for (const path of files.files(ticketsDir)) {
			const rel = relative(ticketsDir, path).split(sep).join("/");
			let size = 0;
			try {
				size = statSync(path).size;
			} catch {
				// Ignore unreadable entry.
			}
			let frontTicket = "";
			if (MARKDOWN.test(path)) {
				const text = await head(path);
				ticketHeads.set(path, text);
				frontTicket = one(frontMatter(text).values.ticket);
			}
			scanned.push({ path, rel, size, ...(frontTicket ? { frontTicket } : {}) });
		}
		for (const resolved of classifyTicketEntries(scanned)) {
			const path = resolved.entry.path;
			const text = ticketHeads.get(path) ?? (await head(path));
			const { values } = frontMatter(text);
			const name = relative(ticketsDir, path);
			if (resolved.isCatalog) {
				list.push({ path, name, group: "tickets", exists: true, ...described(text, root, path), ...brokenLinks(root, path, text, named) });
				continue;
			}
			const stem = basename(path).replace(MARKDOWN, "");
			const key = one(values.ticket) || (resolved.folderRel && /^(readme|ticket)$/i.test(stem) ? basename(resolved.folderRel) : stem);
			const specs = [...new Set([...many(values.specs), ...many(values.spec)])];
			const plans = [...new Set([...many(values.plans), ...many(values.plan)])];
			const related = [...many(values.related), ...many(values.blocks), ...many(values["blocked-by"]), ...many(values.parent)];
			const missing = [...specs, ...plans].filter((ref) => !existsSync(join(root, ref)));
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
				...described(text, root, path),
				...brokenLinks(root, path, text, named),
				ticket: key,
				parent: one(values.parent) || undefined,
				tickets: related.length ? related : undefined,
				specs: specs.length ? specs : undefined,
				plans: plans.length ? plans : undefined,
				missing: missing.length ? missing : undefined,
				...(ticketFolder ? { ticketFolder, ticketFileCount: resolved.fileCount, ticketFiles: resolved.files } : {}),
			});
		}
	}
	// The specs: those written by hand, and those the planner writes beside a plan.
	for (const path of [...under(area("specs"), MARKDOWN), ...under(join(root, project.plans), /\.spec\.md$/i)]) {
		const fromPlan = !path.startsWith(area("specs") + sep);
		const text = await head(path);
		const said = described(text, root, path);
		// A spec the planner wrote is for the ticket its plan names, and is called what its plan is: it has no
		// heading of its own to be called by, and its first section is not its name.
		const planPath = path.replace(/\.spec\.md$/i, ".plan.json");
		const plan = fromPlan ? await planSays(planPath) : { ticket: "", title: "", status: "", codeRefs: [] };
		const planned = plan.ticket;
		if (fromPlan && plan.title && !one(frontMatter(text).values.title) && !/^#\s+\S/m.test(frontMatter(text).body)) said.title = plan.title;
		const ownTickets = said.tickets?.length ? [...said.tickets] : undefined;
		const pairedPlan = fromPlan && existsSync(planPath) ? { name: basename(planPath), ...(planned ? { ticket: planned } : {}) } : undefined;
		const tickets = planned && !said.tickets?.some((key) => key.toLowerCase() === planned.toLowerCase()) ? [...(said.tickets ?? []), planned] : said.tickets;
		const mergedCodeRefs = [...new Set([...(said.codeRefs ?? []), ...plan.codeRefs])];
		list.push({
			path,
			name: fromPlan ? `${project.plans}/${relative(join(root, project.plans), path)}` : relative(area("specs"), path),
			group: "specs",
			exists: true,
			...said,
			...brokenLinks(root, path, text, named),
			...(tickets?.length ? { tickets } : {}),
			...(ownTickets ? { ownTickets } : {}),
			...(pairedPlan ? { pairedPlan } : {}),
			...(mergedCodeRefs.length ? { codeRefs: mergedCodeRefs } : {}),
		});
	}
	// The knowledge base: decisions, questions, snippets and notes, each kind in its folder.
	for (const path of under(area("knowledge"), /\.(md|markdown|sql|ssl|srvscr|ds|txt|json|toml|csv)$/i)) {
		const name = relative(area("knowledge"), path);
		const kind = name.includes(sep) ? name.split(sep)[0]! : "";
		const text = await head(path);
		list.push({ path, name, group: "knowledge", exists: true, kind, ...(MARKDOWN.test(path) ? { ...described(text, root, path), ...brokenLinks(root, path, text, named) } : snippet(text)) });
	}
	// The registries: tables of values, each row with how far it has come.
	const knownTickets = new Set(list.flatMap((file) => (file.group === "tickets" && file.ticket ? [file.ticket.toLowerCase()] : [])));
	for (const path of under(area("registries"), /\.(md|markdown|csv|tsv)$/i)) {
		const name = relative(area("registries"), path);
		if (MARKDOWN.test(path)) {
			const text = await head(path);
			list.push({ path, name, group: "registries", exists: true, ...described(text, root, path), ...brokenLinks(root, path, text, named) });
			continue;
		}
		let size = 0;
		let mtimeMs = 0;
		try {
			const st = statSync(path);
			size = st.size;
			mtimeMs = st.mtimeMs;
		} catch {
			continue;
		}
		if (size > REGISTRY_BYTES) {
			list.push({ path, name, group: "registries", exists: true, problems: ["It is too large to read here."] });
			continue;
		}
		const table = await cachedParseCsv(path, size, mtimeMs);
		// A row can say which ticket carries it: the ticket's page lists what it has to bring across.
		const forTickets = rowsByTicket(table, knownTickets);
		const regCode = registryCodeInfo(table, knownTickets);
		list.push({
			path,
			name,
			group: "registries",
			exists: true,
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
		const text = await head(path);
		const said = described(text, root, path);
		// Its heading is not a name it is linked by: a plain document is linked by its file's name, as it always was.
		list.push({
			path,
			name: relative(docs, path),
			group: "docs",
			exists: true,
			...(said.title ? { heading: said.title } : {}),
			...(said.summary ? { summary: said.summary } : {}),
			...(said.tags?.length ? { tags: said.tags } : {}),
			...(said.codeRefs?.length ? { codeRefs: said.codeRefs } : {}),
			...brokenLinks(root, path, text, named),
		});
	}
	// What the project's data looks like, each kind in its folder: descriptions in Markdown, and beside them the SQL
	// that makes the tables, a message's own schema, a sample of a file (including STARLIMS lab/interface formats).
	for (const path of under(join(root, project.schema), /\.(md|markdown|sql|ddl|pks|pkb|json|xml|xsd|wsdl|yaml|yml|hl7|astm|edi|avsc|proto|csv|tsv|txt)$/i)) {
		const name = relative(join(root, project.schema), path);
		const folder = name.includes(sep) ? name.split(sep)[0]! : "";
		// A folder that is one of the known kinds in other capitals is that kind: on a disk that does not tell them
		// apart it is the same folder, and nowhere is it a second kind beside it.
		const kind = SCHEMAS.find((known) => known.id === folder.toLowerCase())?.id ?? folder;
		const text = MARKDOWN.test(path) ? await head(path) : "";
		list.push({ path, name, group: "schema", exists: true, kind, ...(MARKDOWN.test(path) ? { ...described(text, root, path), ...brokenLinks(root, path, text, named) } : {}) });
	}
	for (const path of under(join(root, project.plans), /\.(plan\.json|md)$/i)) {
		if (/\.spec\.md$/i.test(path)) continue;
		// A plan says which ticket it is for, its title, and the scripts it targets (ADR 0013).
		const plan = /\.plan\.json$/i.test(path) ? await planSays(path) : null;
		const mdText = MARKDOWN.test(path) ? await head(path) : "";
		list.push({
			path,
			name: relative(join(root, project.plans), path),
			group: "plans",
			exists: true,
			...(plan?.title ? { heading: plan.title } : {}),
			...(plan?.status ? { status: plan.status } : {}),
			...(plan?.ticket ? { tickets: [plan.ticket] } : {}),
			...(plan?.codeRefs.length ? { codeRefs: plan.codeRefs } : {}),
			...(mdText ? { ...described(mdText, root, path), ...brokenLinks(root, path, mdText, named) } : {}),
		});
	}
	// Check broken [[wikilinks]] across Markdown docs using a single O(N) pre-built index.
	const IMAGE_EMBED_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
	const docNameIndex = buildDocNameIndex(list, root);
	for (const doc of list) {
		if (!doc.exists || !MARKDOWN.test(doc.path)) continue;
		try {
			const s = statSync(doc.path);
			if (s.size > LINKED_BYTES) continue;
			const stamp = `${s.size}:${s.mtimeMs}`;
			const namesKey = `H\0${doc.path}`;
			const kept = namesRead.get(namesKey);
			let places: ReturnType<typeof namePlaces>;
			if (kept && kept.stamp === stamp) {
				places = kept.places;
			} else {
				places = namePlaces(await head(doc.path));
				if (namesRead.size >= NAMES_KEPT) namesRead.delete(namesRead.keys().next().value!);
				namesRead.set(namesKey, { stamp, places });
			}
			if (!places.length) continue;
			const brokenWiki: { href: string; line: number; column: number }[] = [];
			for (const place of places) {
				if (IMAGE_EMBED_RE.test(place.name)) continue;
				if (!lookupInIndex(place.name, docNameIndex)) {
					brokenWiki.push({ href: `[[${place.name}]]`, line: place.line, column: place.column });
				}
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
	[/\.sql$/i, "sql"],
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
	const apart = [project.docs, project.plans, ".ssl-studio"]
		.map((folder) => folder.split(/[\\/]/).filter((p) => p && p !== ".").join("/"))
		.filter(Boolean)
		.map((folder) => `${folder}/`);
	const codeAtRoot = project.code.trim() === "." || project.code.trim() === "";
	for (const path of files.files()) {
		const name = relative(files.root, path).split(sep).join("/");
		if (apart.some((folder) => name.startsWith(folder))) continue;
		if (!name.includes("/")) {
			// Skip root project docs (README.md, AGENTS.md) and non-code root files unless code = ".".
			if (!codeAtRoot || !/\.(ssl|srvscr|ds|sql)$/i.test(name)) continue;
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
	const made: string[] = [];
	const wrote = new Map<string, string>();
	const put = async (path: string, content: string) => {
		if (existsSync(path)) return;
		made.push(relative(root, path));
		if (dryRun) return;
		mkdirSync(dirname(path), { recursive: true });
		await Bun.write(path, content);
		wrote.set(path, content);
	};
	await put(project.path, projectToml(project.name));
	if (!found(root, "README.md")) await put(join(root, "README.md"), readme(project));
	if (!found(root, "AGENTS.md")) await put(join(root, "AGENTS.md"), agents(project));
	// A folder that is already there is left as it is. A new one starts as its catalog, which says what the folder is
	// for and lists what comes to be in it: nothing is written once and left to go stale.
	const start = async (dir: string, area: "docs" | "tests" | "code") => {
		if (!existsSync(join(root, dir))) await put(join(root, dir, CATALOG_FILE), catalogTemplate(area));
	};
	await start(project.docs, "docs");
	// The schema folder's names the kinds it can hold; a kind's folder is made with the first thing described in it.
	if (!existsSync(join(root, project.schema))) await put(join(root, project.schema, CATALOG_FILE), withKinds(catalogTemplate("schema")));
	// A folder for the code only where there is none yet: an export brings its own layout. The code before the tests:
	// where a project keeps both in one folder, that folder is its code, and its catalog says so.
	let scripts = false;
	for (const path of new WorkspaceFiles(root).files()) if ((scripts = SCRIPT.test(path))) break;
	if (!scripts) await start(project.code, "code");
	// Tests kept in the code's own folder: the folder is the code's, whichever of the two makes it.
	await start(project.tests, resolve(root, project.tests) === resolve(root, project.code) ? "code" : "tests");
	if (!dryRun) lastSetup.set(root, wrote);
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
		if (!existsSync(path)) continue;
		if ((await Bun.file(path).text()) !== content) {
			kept.push(name(path));
			continue;
		}
		unlinkSync(path);
		removed.push(name(path));
		// The folder it was in, and the one above, when the file was all they held.
		for (let dir = dirname(path); dir !== root && dir.startsWith(root) && !readdirSync(dir).length; dir = dirname(dir)) rmdirSync(dir);
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
};
const auditFileCache = new Map<string, CachedDocAuditEntry>();
const AUDIT_CACHE_MAX = 2000;

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
		for (const m of line.matchAll(/(?<!\!)\[[^\]]+\]\((#[^)\s]+)\)/g)) {
			const before = line.slice(0, m.index ?? 0);
			if ((before.match(/`/g)?.length ?? 0) % 2 === 1) continue;
			const href = m[1]!;
			let anchor = href.slice(1).trim();
			try {
				anchor = decodeURIComponent(anchor);
			} catch {}
			if (anchor && !/^L\d+(?:-L?\d+)?$/i.test(anchor)) {
				out.push({ line: i + 1, column: (m.index ?? 0) + 1, anchor, href });
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
		for (const m of line.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
			// Skip if wrapped in backticks on the line.
			const before = line.slice(0, m.index ?? 0);
			if ((before.match(/`/g)?.length ?? 0) % 2 === 1) continue;
			const raw = m[1]!.replace(/\\\|/g, "|").split("|")[0]!.trim();
			const hash = raw.indexOf("#");
			if (hash < 0) continue;
			const target = raw.slice(0, hash).trim();
			const section = raw.slice(hash + 1).trim();
			if (section) out.push({ line: i + 1, column: (m.index ?? 0) + 2, target, section });
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
	for (let i = startIdx + 1; i < endIdx; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (/^\s*-\s+/.test(line)) {
			if (!inList) out.push({ line: i + 1, message: "YAML list item has no preceding key." });
			continue;
		}
		if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
			inList = /^[A-Za-z0-9_-]+\s*:\s*$/.test(line);
			continue;
		}
		// Allow indented scalar continuation lines under a key, flag unindented malformed lines.
		if (!/^\s+/.test(line)) {
			out.push({ line: i + 1, message: "Malformed YAML frontmatter line (missing ':')." });
		}
	}
	return out;
}

async function readAuditEntry(path: string, checkTableRule: boolean): Promise<CachedDocAuditEntry | null> {
	let stamp = "";
	try {
		const st = statSync(path);
		if (st.size > LINKED_BYTES) return null;
		stamp = `${st.size}:${st.mtimeMs}:${checkTableRule ? 1 : 0}`;
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
	const entry: CachedDocAuditEntry = { stamp, text, links, selfAnchors, wikis, wikiSections, imgRefs, openTasks, tableIssues, yamlIssues };
	if (auditFileCache.size >= AUDIT_CACHE_MAX) auditFileCache.delete(auditFileCache.keys().next().value!);
	auditFileCache.set(path, entry);
	return entry;
}

/**
 * Cached workspace-wide Markdown audit (no 250-file cap):
 * 1. Unused image attachments across `attachmentsFolder` (default `<docs>/attachments`) AND `<tickets>/<KEY>/attachments/` folders,
 *    resolved against actual links, embeds, and HTML `<img>` tags across ALL workspace Markdown files.
 * 2. Open `- [ ]` tasks across active (non-archived, non-catalog, non-done) project documents.
 * 3. Workspace hygiene issues: broken `#heading` anchors, ADR 0008 table-rule findings (non-schema docs), and malformed YAML frontmatter.
 */
export async function docAudit(files: WorkspaceFiles, project: Project, attachmentsFolder?: string): Promise<DocAuditResult> {
	const root = files.root;
	const docsRel = project.docs.replace(/^[./\\]+|[\\/]+$/g, "");
	const schemaRel = project.schema.replace(/^[./\\]+|[\\/]+$/g, "");
	const schemaPrefix = schemaRel && schemaRel !== "." ? `${schemaRel.toLowerCase()}/` : "";
	const customAttachRel = (attachmentsFolder ?? "").trim().replace(/\\/g, "/").replace(/^[./]+|\/+$/g, "");
	const defaultAttachRel = docsRel && docsRel !== "." ? `${docsRel}/attachments` : "attachments";
	const attachPrefixes = new Set<string>([`${(customAttachRel || defaultAttachRel).toLowerCase()}/`]);
	const ticketsRel = docsRel && docsRel !== "." ? `${docsRel}/${DOC_FOLDERS.tickets}` : DOC_FOLDERS.tickets;
	const ticketsAttachRe = new RegExp(`^${ticketsRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase()}/[^/]+/attachments/`, "i");

	const allWsFiles = files.files();
	const candidateImages: string[] = [];
	const allMdFiles: string[] = [];
	for (const p of allWsFiles) {
		const rel = relative(root, p).split(sep).join("/");
		const relLow = rel.toLowerCase();
		if (MARKDOWN.test(p)) {
			allMdFiles.push(p);
		} else if (IMAGE_ASSET_RE.test(p)) {
			if ([...attachPrefixes].some((pref) => relLow.startsWith(pref)) || ticketsAttachRe.test(relLow)) {
				candidateImages.push(p);
			}
		}
	}

	const docsList = await listDocs(files, project);
	const docByPath = new Map<string, DocFile>();
	const fold = (p: string) => (process.platform === "linux" ? resolve(p) : resolve(p).toLowerCase());
	for (const d of docsList) docByPath.set(fold(d.path), d);
	const docNameIndex = buildDocNameIndex(docsList, root);

	const usedImagePaths = new Set<string>();
	const usedImageNames = new Set<string>();
	const mdEntries = new Map<string, CachedDocAuditEntry>();
	const openTasks: OpenTaskItem[] = [];
	const issues: WorkspaceDocIssue[] = [];

	for (const mdPath of allMdFiles) {
		const rel = relative(root, mdPath).split(sep).join("/");
		const relLow = rel.toLowerCase();
		const inSchema = Boolean(schemaPrefix && relLow.startsWith(schemaPrefix));
		const entry = await readAuditEntry(mdPath, !inSchema);
		if (!entry) continue;
		mdEntries.set(fold(mdPath), entry);

		// Collect referenced images from Markdown links/images, HTML <img>, and ![[image]] embeds.
		const markImageRef = (rawRef: string) => {
			let cleaned = rawRef.split(/[?#]/)[0]!.trim();
			try {
				cleaned = decodeURIComponent(cleaned);
			} catch {
				// Keep raw string if invalid percent sequence.
			}
			if (!cleaned || !IMAGE_ASSET_RE.test(cleaned)) return;
			const target = linkTarget(root, mdPath, cleaned);
			usedImagePaths.add(fold(target));
			usedImageNames.add(basename(cleaned).toLowerCase());
		};
		for (const link of entry.links) markImageRef(link.file);
		for (const ref of entry.imgRefs) markImageRef(ref);
		for (const w of entry.wikis) {
			if (IMAGE_ASSET_RE.test(w.name)) usedImageNames.add(basename(w.name).toLowerCase());
		}

		// Surface YAML & ADR 0008 table-rule issues for project docs (excluding catalogs).
		const docMeta = docByPath.get(fold(mdPath));
		if (docMeta && !isCatalog(docMeta)) {
			for (const y of entry.yamlIssues) {
				issues.push({ path: mdPath, line: y.line, kind: "yaml", level: "warn", message: y.message });
			}
			for (const t of entry.tableIssues) {
				issues.push({ path: mdPath, line: t.line, kind: "table", level: "note", message: t.message });
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

	// Second pass: verify `#heading` fragment anchors on Markdown links and `[[doc#Heading]]` wikilinks.
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
			const anchor = link.href.slice(hashIdx + 1).trim();
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
	}

	const unusedAttachments = candidateImages.filter((imgPath) => {
		const f = fold(imgPath);
		if (usedImagePaths.has(f)) return false;
		// Wiki embeds `![[shot.png]]` resolve by basename across attachments folders.
		if (usedImageNames.has(basename(imgPath).toLowerCase())) return false;
		return true;
	});

	return { unusedAttachments, openTasks, issues };
}

