// The open folder as a project: its settings (.ssl-studio/project.toml) and
// its documents. The Bun process reads them (src/bun/project.ts); the Docs
// and Health panels show them.
import { createEffect, createSignal, on } from "solid-js";
import type { DocFile } from "../shared/protocol";
import { joinPath } from "../shared/paths";
import { backend } from "./backend";
import { ask } from "./dialogs";
import { showPanel } from "./panels/registry";
import { loadProject, loadSettings, notify, openFile, setState, state } from "./state";

const [docs, setDocs] = createSignal<DocFile[]>([]);
export { docs };

export const isMarkdown = (path: string | null | undefined) => Boolean(path && /\.(md|markdown)$/i.test(path));

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

/** Writes project.toml, README.md and AGENTS.md where they are missing, and shows them. */
export async function setUpProject() {
	if (!state.workspace) return notify("Open a folder first.");
	let made: string[];
	try {
		made = await backend.setupProject();
	} catch (e: any) {
		return notify(String(e?.message ?? e), "error");
	}
	await Promise.all([loadProject(), loadSettings()]);
	setState("treeVersion", (v) => v + 1);
	notify(made.length ? `Created ${made.join(", ")}.` : "This project already has its settings, README and AGENTS files.");
	showPanel("docs");
	const readme = (await backend.docs()).find((d) => d.group === "project" && /^readme\.md$/i.test(d.name));
	if (readme?.exists) await openFile(readme.path);
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
