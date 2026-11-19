// A project is a workspace folder with `.ssl-studio/project.toml`, a
// README.md and an AGENTS.md at its root. The IDE writes all three once, from
// the templates below, and after that only reads them: project.toml is edited
// as text, so its comments survive.
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { CATALOG_FILE, catalogStale } from "../shared/catalog";
import { parseCsv, tally } from "../shared/csv";
import { frontMatter, many, one, summaryOf, titleOf } from "../shared/frontMatter";
import { catalogItems, DOC_FOLDERS, isCatalog, STATE_FILE, type DocArea } from "../shared/projectDocs";
import type { DocFile, ManifestFile, Project, Settings } from "../shared/protocol";
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
	const name = text(value)?.replace(/[\\/]+$/, "");
	return name && !isAbsolute(name) && !name.split(/[\\/]/).includes("..") ? name : fallback;
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
		return await Bun.file(path).slice(0, HEAD_BYTES).text();
	} catch {
		return "";
	}
}

/** What a Markdown document says of itself, for the panel and the catalogs. */
function described(text: string): Pick<DocFile, "title" | "status" | "summary" | "tickets"> {
	const { values } = frontMatter(text);
	const tickets = [...many(values.ticket), ...many(values.tickets)];
	return { title: titleOf(text) || undefined, status: one(values.status) || undefined, summary: summaryOf(text) || undefined, ...(tickets.length ? { tickets } : {}) };
}

/** A snippet's title and what it is for: the first two lines of the comment it opens with. */
function snippet(text: string): Pick<DocFile, "title" | "summary"> {
	const said = (line: string | undefined) => /^\s*(?:--+|\/\*+|#+|\/\/+|\*)?\s*(.+?)\s*(?:\*\/|;)?\s*$/.exec(line ?? "")?.[1];
	const lines = text.split(/\r?\n/).filter((line) => line.trim());
	const commented = (line: string | undefined) => /^\s*(--|\/\*|#|\/\/)/.test(line ?? "");
	if (!commented(lines[0])) return {};
	// The second line is part of the comment when it is marked as one, or the comment is a block still open.
	const second = commented(lines[1]) || (/^\s*\/\*/.test(lines[0]!) && !/(\*\/|;)\s*$/.test(lines[0]!)) ? said(lines[1]) : undefined;
	return { title: said(lines[0]), summary: second };
}

export async function listDocs(files: WorkspaceFiles, project: Project): Promise<DocFile[]> {
	const root = files.root;
	const list: DocFile[] = [];
	for (const name of Object.keys(PLACEHOLDER)) {
		const actual = found(root, name);
		const path = join(root, actual ?? name);
		const untouched = actual ? (await Bun.file(path).text()).includes(PLACEHOLDER[name]!) : undefined;
		list.push({ path, name: actual ?? name, group: "project", exists: Boolean(actual), untouched });
	}
	list.push({ path: project.path, name: PROJECT_FILE, group: "project", exists: project.configured });
	const docs = join(root, project.docs);
	const state = existsSync(docs) ? found(docs, STATE_FILE) : undefined;
	if (state) list.push({ path: join(docs, state), name: state, group: "project", exists: true, ...described(await head(join(docs, state))) });

	/** The files under a folder that match, by name, up to the limit. */
	const under = (full: string, pattern: RegExp) => {
		if (!existsSync(full)) return [];
		const paths: string[] = [];
		for (const path of files.files(full)) if (pattern.test(path) && paths.push(path) >= DOC_LIMIT) break;
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
		list.push({ path, name, group: "tickets", exists: true, ...described(text), ...(isCatalog({ name }) ? {} : { ticket: key, tickets: related.length ? related : undefined, specs: specs.length ? specs : undefined }) });
	}
	// The specs: those written by hand, and those the planner writes beside a plan.
	for (const path of [...under(area("specs"), MARKDOWN), ...under(join(root, project.plans), /\.spec\.md$/i)]) {
		const fromPlan = !path.startsWith(area("specs") + sep);
		list.push({ path, name: fromPlan ? `${project.plans}/${relative(join(root, project.plans), path)}` : relative(area("specs"), path), group: "specs", exists: true, ...described(await head(path)) });
	}
	// The knowledge base: decisions, questions, snippets and notes, each kind in its folder.
	for (const path of under(area("knowledge"), /\.(md|markdown|sql|ssl|srvscr|ds|txt|json|toml|csv)$/i)) {
		const name = relative(area("knowledge"), path);
		const kind = name.includes(sep) ? name.split(sep)[0]! : "";
		const text = await head(path);
		list.push({ path, name, group: "knowledge", exists: true, kind, ...(MARKDOWN.test(path) ? described(text) : snippet(text)) });
	}
	// The registries: tables of values, each row with how far it has come.
	for (const path of under(area("registries"), /\.(md|markdown|csv|tsv)$/i)) {
		const name = relative(area("registries"), path);
		if (MARKDOWN.test(path)) {
			list.push({ path, name, group: "registries", exists: true, ...described(await head(path)) });
			continue;
		}
		const file = Bun.file(path);
		if (file.size > REGISTRY_BYTES) {
			list.push({ path, name, group: "registries", exists: true, problems: ["It is too large to read here."] });
			continue;
		}
		const table = parseCsv(await file.text());
		list.push({ path, name, group: "registries", exists: true, rows: table.rows.length, tally: tally(table) ?? undefined, problems: table.problems.length ? table.problems : undefined });
	}
	// Everything else in the docs folder.
	for (const path of under(docs, MARKDOWN)) {
		if (inArea(path) || (state && path === join(docs, state))) continue;
		list.push({ path, name: relative(docs, path), group: "docs", exists: true });
	}
	for (const path of under(join(root, project.schema), /\.(md|markdown|sql)$/i)) list.push({ path, name: relative(join(root, project.schema), path), group: "schema", exists: true });
	for (const path of under(join(root, project.plans), /\.(plan\.json|md)$/i)) {
		if (/\.spec\.md$/i.test(path)) continue;
		list.push({ path, name: relative(join(root, project.plans), path), group: "plans", exists: true });
	}
	// Each catalog says whether its list is still what the documents are.
	for (const name of Object.keys(DOC_FOLDERS) as DocArea[]) {
		if (!existsSync(area(name))) continue;
		const catalog = list.find((file) => file.path === join(area(name), found(area(name), CATALOG_FILE) ?? CATALOG_FILE));
		if (catalog) catalog.catalog = { stale: catalogStale(await Bun.file(catalog.path).text(), catalogItems(name, list, docs)) };
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
	await start(project.schema, "Schema", "The tables this project reads and writes: one Markdown file for each table or area, with its columns, types and keys, and a line on what it is for. `.sql` files are listed too.");
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
schema = "schema"  # the tables the project uses; also in the Docs panel
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
| \`${project.docs}/\` | Notes and decisions |
| \`${project.schema}/\` | The tables the project reads and writes |
| \`${project.tests}/\` | Test scripts and what they need |
| \`${project.plans}/\` | Plans (\`*.plan.json\`) and tidy notes |

## Working on it

Open this folder in SSL Studio. The Docs panel lists this file, \`AGENTS.md\`
and everything under \`${project.docs}/\` and \`${project.schema}/\`.
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
- \`${project.schema}/\`: the tables the project reads and writes. Check a table here before writing SQL for it.
- \`${project.tests}/\`: test scripts and what they need.
- \`${project.plans}/\`: plans and tidy notes.
`;
