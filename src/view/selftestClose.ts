// Self-test of closing over unsaved text in the desktop app (`hutch run selftest-close`, ADR 0042; Linux and
// Windows). The runner (scripts/selftest.ts --close) starts the app twice on one copy of the workspace, with the
// app's own files kept between the two.
//
// The first time the view edits a file, writes in a document that has no file yet, and leaves both unsaved. The
// runner presses the window's close button from outside, and the app has to close by itself and ask nothing. The
// second time both documents have to be back, unsaved, with the text they were left with; the file is then saved,
// and the runner closes the window once more, over the document that still has no file.
//
// Each stage is written to the report, which the runner reads while this runs.
import { backend } from "./backend";
import { monaco } from "./editor/monaco";
import { activePath, documents, newUntitled, openFile, save, state, unsavedPaths } from "./state";

/** The line the first edit adds: kept as it is typed, a second after. */
export const CLOSE_MARK = "/* selftest: an edit left unsaved;";
/** The line the second edit adds, just before the window is closed: kept by the close itself. */
export const CLOSE_MARK_LATE = "/* selftest: typed just before the close;";
/** What the runner adds to the edited file's name, for a file that says: the text was kept as typed, go on. */
export const CLOSE_TOLD = ".selftest-kept";
/** What is written in the document that has no file yet. */
export const CLOSE_UNTITLED = "selftest: a document with no file yet\n";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => T | undefined | null | false, ms = 30_000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = get();
		if (value) return value;
		await wait(100);
	}
	throw new Error("timed out waiting");
}

const dialog = () => document.querySelector<HTMLElement>(".dialog");
const isUntitled = (path: string) => path.startsWith("untitled:");

export async function selftestClose() {
	const report: Record<string, unknown> = { close: true, host: state.info?.host };
	const note = (stage: string, more: Record<string, unknown> = {}) => backend.selftestNote(Object.assign(report, more, { stage }));
	// A question is what must not come: one that does is written down, with what it asks.
	const watch = setInterval(() => {
		const asked = dialog()?.querySelector(".dialog-message")?.textContent;
		if (asked && !report.asked) void note(String(report.stage ?? "started"), { asked });
	}, 100);
	try {
		await until(() => state.workspace);
		// Started again: what was left unsaved is here before this runs (restoreTabs, awaited in main.tsx).
		if (unsavedPaths().length) return await reopened(note);
		const file = (await backend.files()).find((p) => p.endsWith(".ssl"));
		if (!file) throw new Error("the workspace has no SSL file");
		await openFile(file);
		const path = await until(() => activePath());
		const doc = documents.get(path)!;
		doc.model.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: `${CLOSE_MARK}\n` }]);
		const untitled = newUntitled();
		documents.get(untitled)!.model.setValue(CLOSE_UNTITLED);
		await until(() => unsavedPaths().length === 2);
		// The backend goes to the view before a close by this count; the app keeps it current, and this waits for it.
		await backend.unsavedChanged(unsavedPaths().length);
		await note("unsaved", { file: path, untitled });

		// The runner waits for both texts to be kept as they were typed, and says so by a file it puts beside this one.
		await toldToGoOn(path, "the text was kept as it was typed");
		// One more line, and no time for it to be kept as typed: the close has to keep it.
		doc.model.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: `${CLOSE_MARK_LATE}\n` }]);
		await note("typed");
	} catch (e: any) {
		clearInterval(watch);
		// With what the app had to say, and what was on screen: a step that did not come back is waiting on one of them.
		await note("failed", { error: `${e?.message ?? e}\n${e?.stack ?? ""}`, lsp: state.lsp.state, output: state.output.slice(-12), onScreen: dialog()?.textContent ?? null });
	}
}

/** Waits for the runner's word to go on: a file it puts beside the edited one, once it has looked at what it wanted to see. */
async function toldToGoOn(path: string, what: string) {
	const told = `${path}${CLOSE_TOLD}`;
	for (const end = Date.now() + 30_000; !Object.keys((await backend.sizes([told])) ?? {}).length; await wait(200)) {
		if (Date.now() > end) throw new Error(`the runner did not say that ${what}`);
	}
}

/** The second start: what came back, then the file saved. The runner closes the window over what is left. */
async function reopened(note: (stage: string, more?: Record<string, unknown>) => Promise<void>) {
	const unsaved = unsavedPaths();
	const file = unsaved.find((path) => !isUntitled(path));
	const untitled = unsaved.find(isUntitled);
	const tabs = state.groups.flatMap((g) => g.tabs);
	await note("restored", {
		unsaved,
		file,
		untitled,
		fileText: file ? documents.get(file)?.model.getValue().slice(0, 200) : undefined,
		untitledText: untitled ? documents.get(untitled)?.model.getValue() : undefined,
		untitledLanguage: untitled ? documents.get(untitled)?.model.getLanguageId() : undefined,
		tabs,
		conflicts: Object.keys(state.conflicts).filter((path) => state.conflicts[path]),
		messages: state.messages.map((m) => m.text),
	});
	if (!file) throw new Error("no file came back unsaved");
	// The runner looks at the file on disk first: it has to be as it was, with the edits only in the app.
	await toldToGoOn(file, "it has seen the file on disk before the save");
	const saved = await Promise.race([save(file), wait(20_000).then(() => "no answer in 20 s")]);
	if (saved !== true) throw new Error(`the file that came back was not saved: ${saved}`);
	await until(() => unsavedPaths().length === (untitled ? 1 : 0));
	await backend.unsavedChanged(unsavedPaths().length);
	await note("saved", { saved, stillUnsaved: unsavedPaths() });
}
