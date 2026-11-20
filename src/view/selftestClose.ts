// Self-test of the close guard in the desktop app (`hutch run selftest-close`,
// ADR 0009; Linux and Windows). The view makes an edit and leaves it unsaved; the runner
// (scripts/selftest.ts --close) then presses the window's close button from
// outside, twice. The first time the question is cancelled and the window has
// to stay; the second time the file is saved and the app has to close itself.
// Each stage is written to the report, which the runner reads while this runs.
import { backend } from "./backend";
import { monaco } from "./editor/monaco";
import { activeDoc, openFile, state, unsavedPaths } from "./state";

/** The line the edit adds, which the runner looks for on disk after the save. */
export const CLOSE_MARK = "/* selftest: an edit left unsaved;";

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
const buttons = () => [...(dialog()?.querySelectorAll("button") ?? [])];
const press = (label: string) => {
	const button = buttons().find((b) => b.textContent?.trim() === label);
	if (!button) throw new Error(`the question has no “${label}” button`);
	button.click();
};

export async function selftestClose() {
	const report: Record<string, unknown> = { close: true, host: state.info?.host };
	const note = (stage: string, more: Record<string, unknown> = {}) => backend.selftestNote(Object.assign(report, more, { stage }));
	try {
		await until(() => state.workspace);
		const file = (await backend.files()).find((p) => p.endsWith(".ssl"));
		if (!file) throw new Error("the workspace has no SSL file");
		await openFile(file);
		const doc = await until(() => activeDoc());
		doc.model.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: `${CLOSE_MARK}\n` }]);
		await until(() => unsavedPaths().length === 1);
		// The backend refuses the close by this count; the app keeps it current, and this waits for it.
		await backend.unsavedChanged(unsavedPaths().length);
		await note("unsaved", { file });

		// The runner presses close. The window must still be here, asking.
		await until(dialog);
		const question = dialog()!.querySelector(".dialog-message")?.textContent ?? "";
		const offered = buttons().map((b) => b.textContent?.trim());
		press("Cancel");
		await until(() => !dialog());
		await note("kept", { question, offered, stillUnsaved: unsavedPaths().length === 1, editKept: doc.model.getValue().startsWith(CLOSE_MARK) });

		// The runner presses close again. Saving is the answer this time, and the app closes itself.
		await until(dialog);
		await note("saving");
		press("Save all");
	} catch (e: any) {
		await note("failed", { error: String(e?.stack ?? e) });
	}
}
