// A project is a workspace folder with `.ssl-studio/project.toml`, a
// README.md and an AGENTS.md at its root. The IDE writes all three once, from
// the templates below, and after that only reads them: project.toml is edited
// as text, so its comments survive.
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { decode, decodePart, textOf } from "./encoding";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CATALOG_FILE, catalogStale } from "../shared/catalog";
import { parseCsv, tally } from "../shared/csv";
import { fileLinks, frontPaths, type DocLink } from "../shared/docLinks";
import { frontMatter, many, one, summaryOf, titleOf } from "../shared/frontMatter";
import { namePlaces } from "../shared/namedLinks";
import { catalogItems, DOC_FOLDERS, isCatalog, isPrompt, SCHEMAS, STATE_FILE, type DocArea } from "../shared/projectDocs";
import { rowsByTicket } from "../shared/registryTickets";
import { taskTally } from "../shared/tasks";
import type { DocFile, LinkTo, ManifestFile, NameIn, Project, Settings } from "../shared/protocol";
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

async function head(path: string): Promise<string> {
	try {
		const file = Bun.file(path);
		return decodePart(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()), file.size > HEAD_BYTES);
	} catch {
		return "";
	}
}

/** What a plan says of itself: the ticket it is for and its title; "" for what it does not say, or when it cannot be read. */
async function planSays(path: string): Promise<{ ticket: string; title: string }> {
	try {
		const plan = await Bun.file(path).json();
		const word = (value: unknown) => (typeof value === "string" ? value.trim() : "");
		return { ticket: word(plan?.ticket), title: word(plan?.title) };
	} catch {
		return { ticket: "", title: "" };
	}
}
const planTicket = async (path: string) => (await planSays(path)).ticket;

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

/** What a Markdown document says of itself, for the panel and the catalogs. */
function described(text: string): Pick<DocFile, "title" | "status" | "summary" | "tickets" | "untouched" | "tasks"> {
	const { values } = frontMatter(text);
	const tickets = [...many(values.ticket), ...many(values.tickets)];
	const tasks = tallyOf(text);
	return { title: titleOf(text) || undefined, status: one(values.status) || undefined, summary: said(summaryOf(text)), ...(tickets.length ? { tickets } : {}), ...(isPrompt(summaryOf(text)) ? { untouched: true } : {}), ...(tasks ? { tasks } : {}) };
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
const LINKS_KEPT = 1000;
function linksIn(path: string, text: string): DocLink[] {
	const hash = Bun.hash(text);
	const kept = linksRead.get(path);
	if (kept && kept.hash === hash) return kept.links;
	const links = fileLinks(text);
	// The oldest goes when there are too many: a Map keeps the order things were put in.
	if (linksRead.size >= LINKS_KEPT) linksRead.delete(linksRead.keys().next().value!);
	linksRead.delete(path);
	linksRead.set(path, { hash, links });
	return links;
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
		for (const link of linksIn(path, text)) {
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
		const file = Bun.file(path);
		if (file.size > LINKED_BYTES) continue;
		let text = "";
		try {
			text = decode(new Uint8Array(await file.arrayBuffer())).text;
		} catch {
			continue;
		}
		for (const place of namePlaces(text)) found.push({ path, ...place });
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
			for (const file of files.files()) names.set(basename(file).toLowerCase(), [...(names.get(basename(file).toLowerCase()) ?? []), file]);
		}
		return names.get(name.toLowerCase()) ?? [];
	};
	for (const name of Object.keys(PLACEHOLDER)) {
		const actual = found(root, name);
		const path = join(root, actual ?? name);
		const text = actual ? await textOf(path) : "";
		const untouched = actual ? text.includes(PLACEHOLDER[name]!) : undefined;
		list.push({ path, name: actual ?? name, group: "project", exists: Boolean(actual), untouched, ...brokenLinks(root, path, text, named) });
	}
	list.push({ path: project.path, name: PROJECT_FILE, group: "project", exists: project.configured });
	const docs = join(root, project.docs);
	const state = existsSync(docs) ? found(docs, STATE_FILE) : undefined;
	if (state) {
		const text = await head(join(docs, state));
		list.push({ path: join(docs, state), name: state, group: "project", exists: true, ...described(text), ...brokenLinks(root, join(docs, state), text, named) });
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
	const inArea = (path: string) => (Object.keys(DOC_FOLDERS) as DocArea[]).some((name) => path.startsWith(area(name) + sep));

	// The tickets that drive the work.
	for (const path of under(area("tickets"), MARKDOWN)) {
		const text = await head(path);
		const { values } = frontMatter(text);
		const name = relative(area("tickets"), path);
		const key = one(values.ticket) || basename(path).replace(MARKDOWN, "");
		const specs = many(values.specs);
		const related = [...many(values.related), ...many(values.blocks), ...many(values["blocked-by"]), ...many(values.parent)];
		const missing = specs.filter((spec) => !existsSync(join(root, spec)));
		list.push({ path, name, group: "tickets", exists: true, ...described(text), ...brokenLinks(root, path, text, named), ...(isCatalog({ name }) ? {} : { ticket: key, parent: one(values.parent) || undefined, tickets: related.length ? related : undefined, specs: specs.length ? specs : undefined, missing: missing.length ? missing : undefined }) });
	}
	// The specs: those written by hand, and those the planner writes beside a plan.
	for (const path of [...under(area("specs"), MARKDOWN), ...under(join(root, project.plans), /\.spec\.md$/i)]) {
		const fromPlan = !path.startsWith(area("specs") + sep);
		const text = await head(path);
		const said = described(text);
		// A spec the planner wrote is for the ticket its plan names, and is called what its plan is: it has no
		// heading of its own to be called by, and its first section is not its name.
		const plan = fromPlan ? await planSays(path.replace(/\.spec\.md$/i, ".plan.json")) : { ticket: "", title: "" };
		const planned = plan.ticket;
		if (fromPlan && plan.title && !one(frontMatter(text).values.title) && !/^#\s+\S/m.test(frontMatter(text).body)) said.title = plan.title;
		const tickets = planned && !said.tickets?.some((key) => key.toLowerCase() === planned.toLowerCase()) ? [...(said.tickets ?? []), planned] : said.tickets;
		list.push({ path, name: fromPlan ? `${project.plans}/${relative(join(root, project.plans), path)}` : relative(area("specs"), path), group: "specs", exists: true, ...said, ...brokenLinks(root, path, text, named), ...(tickets?.length ? { tickets } : {}) });
	}
	// The knowledge base: decisions, questions, snippets and notes, each kind in its folder.
	for (const path of under(area("knowledge"), /\.(md|markdown|sql|ssl|srvscr|ds|txt|json|toml|csv)$/i)) {
		const name = relative(area("knowledge"), path);
		const kind = name.includes(sep) ? name.split(sep)[0]! : "";
		const text = await head(path);
		list.push({ path, name, group: "knowledge", exists: true, kind, ...(MARKDOWN.test(path) ? { ...described(text), ...brokenLinks(root, path, text, named) } : snippet(text)) });
	}
	// The registries: tables of values, each row with how far it has come.
	for (const path of under(area("registries"), /\.(md|markdown|csv|tsv)$/i)) {
		const name = relative(area("registries"), path);
		if (MARKDOWN.test(path)) {
			const text = await head(path);
			list.push({ path, name, group: "registries", exists: true, ...described(text), ...brokenLinks(root, path, text, named) });
			continue;
		}
		const file = Bun.file(path);
		if (file.size > REGISTRY_BYTES) {
			list.push({ path, name, group: "registries", exists: true, problems: ["It is too large to read here."] });
			continue;
		}
		const table = parseCsv(await textOf(path));
		// A row can say which ticket carries it: the ticket's page lists what it has to bring across.
		const forTickets = rowsByTicket(table, new Set(list.flatMap((file) => (file.group === "tickets" && file.ticket ? [file.ticket.toLowerCase()] : []))));
		list.push({ path, name, group: "registries", exists: true, rows: table.rows.length, tally: tally(table) ?? undefined, problems: table.problems.length ? table.problems : undefined, ...(forTickets.length ? { tickets: forTickets.map((rows) => rows.key), forTickets } : {}) });
	}
	// Everything else in the docs folder.
	for (const path of under(docs, MARKDOWN, inArea)) {
		if (state && path === join(docs, state)) continue;
		list.push({ path, name: relative(docs, path), group: "docs", exists: true, ...brokenLinks(root, path, await head(path), named) });
	}
	// What the project's data looks like, each kind in its folder: descriptions in Markdown, and beside them the SQL
	// that makes the tables, a message's own schema, a sample of a file.
	for (const path of under(join(root, project.schema), /\.(md|markdown|sql|json|xml|xsd|wsdl|yaml|yml|hl7|csv|tsv|txt)$/i)) {
		const name = relative(join(root, project.schema), path);
		const folder = name.includes(sep) ? name.split(sep)[0]! : "";
		// A folder that is one of the known kinds in other capitals is that kind: on a disk that does not tell them
		// apart it is the same folder, and nowhere is it a second kind beside it.
		const kind = SCHEMAS.find((known) => known.id === folder.toLowerCase())?.id ?? folder;
		const text = MARKDOWN.test(path) ? await head(path) : "";
		list.push({ path, name, group: "schema", exists: true, kind, ...(MARKDOWN.test(path) ? { ...described(text), ...brokenLinks(root, path, text, named) } : {}) });
	}
	for (const path of under(join(root, project.plans), /\.(plan\.json|md)$/i)) {
		if (/\.spec\.md$/i.test(path)) continue;
		// A plan says which ticket it is for (ADR 0013): the Docs panel shows it under that ticket.
		const ticket = /\.plan\.json$/i.test(path) ? await planTicket(path) : "";
		list.push({ path, name: relative(join(root, project.plans), path), group: "plans", exists: true, ...(ticket ? { tickets: [ticket] } : {}), ...(MARKDOWN.test(path) ? brokenLinks(root, path, await head(path), named) : {}) });
	}
	// Each catalog says whether its list is still what the documents are.
	for (const name of Object.keys(DOC_FOLDERS) as DocArea[]) {
		if (!existsSync(area(name))) continue;
		const catalog = list.find((file) => file.path === join(area(name), found(area(name), CATALOG_FILE) ?? CATALOG_FILE));
		if (catalog) catalog.catalog = { stale: catalogStale(await textOf(catalog.path), catalogItems(name, list, docs)) };
	}
	return list;
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
	const apart = [project.docs, project.plans, ".ssl-studio"].map((folder) => `${folder.split(/[\\/]/).join("/")}/`);
	for (const path of files.files()) {
		const name = relative(files.root, path).split(sep).join("/");
		if (!name.includes("/") || apart.some((folder) => name.startsWith(folder))) continue;
		const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
		let lines = bytes.length ? 1 : 0;
		for (const byte of bytes) if (byte === 10) lines++;
		if (bytes.length && bytes[bytes.length - 1] === 10) lines--;
		rows.push({ path: name, kind: KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? "other", bytes: bytes.length, lines, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
	}
	return rows.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base", numeric: true }));
}

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
	// A folder that is already there is left as it is: no README is added to it.
	const start = async (dir: string, title: string, about: string) => {
		if (!existsSync(join(root, dir))) await put(join(root, dir, "README.md"), `# ${title}\n\n${about}\n`);
	};
	await start(project.docs, "Docs", "Notes and decisions about this project. Every Markdown file here shows in the Docs panel.");
	// The schema folder with a folder for each kind of thing it describes, each saying what goes in it.
	if (!existsSync(join(root, project.schema))) {
		await put(join(root, project.schema, "README.md"), `# Schema\n\nWhat this project's data looks like, each kind in its own folder. Another folder made here is a kind of the project's own.\n\n${SCHEMAS.map((kind) => `- [${kind.name}](${kind.id}/README.md): ${kind.about.split(":")[0]!.toLowerCase()}.`).join("\n")}\n`);
		for (const kind of SCHEMAS) await put(join(root, project.schema, kind.id, "README.md"), `# ${kind.name}\n\n${kind.about}\n`);
	}
	await start(project.tests, "Tests", "Test scripts, and the sample requests and data they need.");
	// A folder for the code only where there is none yet: an export brings its own layout.
	let scripts = false;
	for (const path of new WorkspaceFiles(root).files()) if ((scripts = SCRIPT.test(path))) break;
	if (!scripts) await start(project.code, "Code", "The project's scripts and data sources.");
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
- Each of those four folders has an \`INDEX.md\`: its catalog. Find a document there, and do not edit the list between its markers.
- \`${project.schema}/\`: what the project's data looks like: the tables it reads and writes (under \`database/\`, where the folder is kept by kind), the messages it exchanges with other systems (\`interfaces/\`) and the files it reads or writes (\`files/\`). Check a table there before writing SQL for it.
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

