// A project is a workspace folder with `.ssl-studio/project.toml`, a
// README.md and an AGENTS.md at its root. The IDE writes all three once, from
// the templates below, and after that only reads them: project.toml is edited
// as text, so its comments survive.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { DocFile, Project, Settings } from "../shared/protocol";
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
	const collect = (dir: string, group: DocFile["group"], pattern: RegExp) => {
		const full = join(root, dir);
		if (!existsSync(full)) return;
		const paths: string[] = [];
		for (const path of files.files(full)) if (pattern.test(path) && paths.push(path) >= DOC_LIMIT) break;
		for (const path of paths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
			list.push({ path, name: relative(full, path), group, exists: true });
		}
	};
	collect(project.docs, "docs", /\.(md|markdown)$/i);
	collect(project.schema, "schema", /\.(md|markdown|sql)$/i);
	collect(project.plans, "plans", /\.(plan\.json|md)$/i);
	return list;
}

/** Writes what a project needs and does not have. Never overwrites. */
export async function setupProject(root: string): Promise<string[]> {
	const project = await readProject(root);
	const made: string[] = [];
	const put = async (path: string, content: string) => {
		if (existsSync(path)) return;
		mkdirSync(dirname(path), { recursive: true });
		await Bun.write(path, content);
		made.push(relative(root, path));
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
	return made;
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
