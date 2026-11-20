// The open folder as a project: its settings (.ssl-studio/project.toml) and
// its documents. The Bun process reads them (src/bun/project.ts); the Docs
// and Health panels show them.
import { createEffect, createSignal, on } from "solid-js";
import type { DocFile } from "../shared/protocol";
import { folderParts, folderSaid, typedDocument, typedParts } from "../shared/docSections";
import { joinPath } from "../shared/paths";
import { backend } from "./backend";
import { ask, choose } from "./dialogs";
import { showPanel } from "./panels/registry";
import { fileRemoved, heldFromBefore, loadProject, loadSettings, notify, openFile, setState, state } from "./state";

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
export const newDoc = () => newDocIn();

/**
 * A new Markdown file in one of the project's folders (the docs folder, when
 * none is named), opened as text. A name with a folder before it ("guides/Intro")
 * puts the document in that folder, which is made when it is not there.
 * Returns whether a document was made.
 */
export async function newDocIn(folder?: string): Promise<boolean> {
	if (!state.workspace || !state.project) return notify("Open a folder first."), false;
	const into = folderParts(folder ?? state.project.docs);
	// A slash in the name is a folder, not part of the name: said, since it is not what a title's slash means.
	const typed = (await ask(`Name of the new document in ${folderSaid(into.join("/"))} (a folder may come first: guides/Intro)`))?.trim();
	if (!typed) return false;
	const named = typedDocument(typed);
	if ("problem" in named) return notify(named.problem, "error"), false;
	const path = joinPath(state.workspace.root, ...into, ...named.folders, named.file);
	if (await heldFromBefore(path)) return false;
	try {
		await backend.create(path, "file");
		await backend.write(path, `# ${named.title}\n`);
	} catch (e: any) {
		return notify(String(e?.message ?? e), "error"), false;
	}
	setState("treeVersion", (v) => v + 1);
	setState("mdText", path, true);
	await openFile(path);
	return true;
}

/**
 * A new folder in one of the project's folders, asked for from the heading of
 * its list in the Docs panel. That list shows documents, so an empty folder is
 * not in it: where a document can be named straight into the folder (`first`),
 * its name is asked for next (a plain document, or what `first` itself starts:
 * a list's own kind of document), and otherwise a notice says where the folder is.
 * Answers whether a folder was made.
 */
export async function newFolderIn(folder: string, first: boolean | ((made: string) => Promise<boolean>)): Promise<boolean> {
	if (!state.workspace || !state.project) return notify("Open a folder first."), false;
	const into = folderParts(folder);
	const typed = (await ask(`Name of the new folder in ${folderSaid(into.join("/"))}`))?.trim();
	if (!typed) return false;
	const named = typedParts(typed);
	if ("problem" in named) return notify(named.problem, "error"), false;
	const made = [...into, ...named.parts].join("/");
	try {
		await backend.create(joinPath(state.workspace.root, ...into, ...named.parts), "dir");
	} catch (e: any) {
		return notify(String(e?.message ?? e), "error"), false;
	}
	setState("treeVersion", (v) => v + 1);
	if (first && (await (typeof first === "function" ? first(made) : newDocIn(made)))) return true;
	notify(`Made the folder ${made}/. It is empty, so this list does not show it yet; the Explorer does.`);
	return true;
}
