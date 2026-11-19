// The marks in an editor's margin for the lines that differ from what git
// has of the file: new lines, changed lines, and places where lines were
// taken out. Compared with what is staged (failing that, the last commit),
// so that staging a change clears its marks. Which lines differ is worked
// out in src/shared/lineDiff.ts; this draws them and keeps them current.
import { createEffect, on, onCleanup } from "solid-js";
import { lineChanges } from "../../shared/lineDiff";
import { backend } from "../backend";
import { gitStatus, gitVersion } from "../git";
import { documents } from "../state";
import { monaco } from "./monaco";

/** How long after the last key the marks are worked out again. */
const SETTLE_MS = 300;

/** Draws the marks in one editor, for the file its group shows. Called where the editor is made. */
export function useGitMarks(editor: monaco.editor.IStandaloneCodeEditor, active: () => string | null) {
	const marks = editor.createDecorationsCollection();
	/** The file's lines as git has them; null when git has nothing of it, or there is no repository. */
	let base: string[] | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const draw = () => {
		const model = editor.getModel();
		if (!model || !base) return marks.clear();
		const last = model.getLineCount();
		marks.set(
			lineChanges(base, model.getLinesContent()).map((change) => {
				// Lines taken out leave no line to mark: the mark is on the line before, or above the first.
				const line = Math.min(Math.max(change.line, 1), last);
				const kind = change.kind === "removed" ? (change.line < 1 ? "removed-above" : "removed") : change.kind;
				return { range: new monaco.Range(line, 1, Math.min(Math.max(change.endLine, line), last), 1), options: { isWholeLine: true, linesDecorationsClassName: `git-mark ${kind}` } };
			}),
		);
	};

	// The file shown, and what git has of it, either of which may change.
	createEffect(
		on([active, gitVersion, () => Boolean(gitStatus())], ([path, , repository]) => {
			base = null;
			marks.clear();
			if (!path || !repository || documents.get(path)?.binary) return;
			let stale = false;
			onCleanup(() => (stale = true));
			backend.gitBase(path, "index").then(
				(text) => {
					if (stale) return;
					base = text === null ? null : text.split(/\r?\n/);
					draw();
				},
				() => {},
			);
		}),
	);
	const typed = editor.onDidChangeModelContent(() => {
		clearTimeout(timer);
		timer = setTimeout(draw, SETTLE_MS);
	});
	onCleanup(() => {
		clearTimeout(timer);
		typed.dispose();
		marks.clear();
	});
}
