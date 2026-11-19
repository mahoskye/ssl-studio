// The open folder as a project: its settings (.ssl-studio/project.toml) and
// its documents. The Bun process reads them (src/bun/project.ts); the Docs
// and Health panels show them.
import { createEffect, createSignal, on } from "solid-js";
import type { DocFile } from "../shared/protocol";
import { joinPath } from "../shared/paths";
import { backend } from "./backend";
import { ask, choose } from "./dialogs";
import { showPanel } from "./panels/registry";
import { fileRemoved, loadProject, loadSettings, notify, openFile, setState, state } from "./state";

const [docs, setDocs] = createSignal<DocFile[]>([]);
export { docs };

export const isMarkdown = (path: string | null | undefined) => Boolean(path && /\.(md|markdown)$/i.test(path));
/** A table of values: a registry, or any other CSV or TSV file. */
export const isTable = (path: string | null | undefined) => Boolean(path && /\.(csv|tsv)$/i.test(path));

/** What the project should have and does not, in words for the user. */
export function projectGaps(): { file: DocFile; problem: string }[] {
	return docs()
		.filter((d) => d.group === "project" && (!d.exists || d.untouched))
		.map((file) => ({ file, problem: file.exists ? "not written yet" : "missing" }));
}

/** Keeps the document list current: call once, inside the app's root. */
export function useProject() {
	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(
		on([() => state.workspace?.root, () => state.treeVersion], ([root]) => {
			clearTimeout(timer);
			if (!root) return setDocs([]);
			// A save or a burst of file events asks once.
			timer = setTimeout(() => void backend.docs().then(setDocs, () => setDocs([])), 150);
		}),
	);
}

/** The sentence that asks before "Set up project" writes anything. */
export const setupQuestion = (folder: string, files: string[]) =>
	`Set up ${folder} as a project? ${files.length === 1 ? "This file" : `These ${files.length} files`} will be created, and nothing that exists is changed:\n${files.map((f) => `  ${f}`).join("\n")}`;

/**
 * Writes project.toml, README.md and AGENTS.md where they are missing, and
 * shows them. It says what it will create first, and writes only on a yes.
 */
export async function setUpProject() {
	if (!state.workspace) return notify("Open a folder first.");
	let made: string[];
	try {
		const planned = await backend.setupPreview();
		if (!planned.length) return notify("This project already has its settings, README and AGENTS files.");
		// The self-test presses the button on a copy of the workspace and has nobody to ask.
		if (!state.info?.selftest && (await choose(setupQuestion(state.workspace.name, planned), [`Create ${planned.length === 1 ? "the file" : `${planned.length} files`}`])) === null) return;
		made = await backend.setupProject();
	} catch (e: any) {
		return notify(String(e?.message ?? e), "error");
	}
	await Promise.all([loadProject(), loadSettings()]);
	setState("treeVersion", (v) => v + 1);
	notify(made.length ? `Created ${made.join(", ")}.` : "This project already has its settings, README and AGENTS files.", "info", made.length ? { label: "Undo", run: () => void undoSetUp() } : undefined);
	showPanel("docs");
	const readme = (await backend.docs()).find((d) => d.group === "project" && /^readme\.md$/i.test(d.name));
	if (readme?.exists) await openFile(readme.path);
}

/**
 * Takes back the last "Set up project": the files it created go, except any
 * that have been changed since, which are someone's work now.
 */
export async function undoSetUp() {
	if (!state.workspace) return notify("Open a folder first.");
	const root = state.workspace.root;
	let result: { removed: string[]; kept: string[] };
	try {
		result = await backend.setupUndo();
	} catch (e: any) {
		return notify(String(e?.message ?? e), "error");
	}
	for (const file of result.removed) fileRemoved(joinPath(root, ...file.split(/[\\/]/)));
	await Promise.all([loadProject(), loadSettings()]);
	setState("treeVersion", (v) => v + 1);
	if (!result.removed.length && !result.kept.length) return notify("Nothing to undo: no project was set up here in this session.");
	notify(`${result.removed.length ? `Removed ${result.removed.join(", ")}.` : "Nothing was removed."}${result.kept.length ? ` Kept, because ${result.kept.length === 1 ? "it has" : "they have"} been changed since: ${result.kept.join(", ")}.` : ""}`);
}

/** A new Markdown file in the project's docs folder, opened as text. */
export async function newDoc() {
	if (!state.workspace || !state.project) return notify("Open a folder first.");
	const title = (await ask(`Name of the new document in ${state.project.docs}/`))?.trim();
	if (!title) return;
	const file = title.replace(/\.md$/i, "").replace(/[\\/:*?"<>|]+/g, "-");
	const path = joinPath(state.workspace.root, ...state.project.docs.split(/[\\/]/), `${file}.md`);
	try {
		await backend.create(path, "file");
		await backend.write(path, `# ${title.replace(/\.md$/i, "")}\n`);
	} catch (e: any) {
		return notify(String(e?.message ?? e), "error");
	}
	setState("treeVersion", (v) => v + 1);
	setState("mdText", path, true);
	await openFile(path);
}
