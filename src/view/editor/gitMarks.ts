// The marks in an editor's margin for the lines that differ from what git
// has of the file: new lines, changed lines, and places where lines were
// taken out. Compared with what is staged (failing that, the last commit),
// so that staging a change clears its marks. Which lines differ is worked
// out in src/shared/lineDiff.ts; this draws them and keeps them current.
import { createEffect, on, onCleanup } from "solid-js";
import { lineChanges } from "../../shared/lineDiff";
import { backend } from "../backend";
import { gitStatus, gitVersion } from "../git";
import { documents, isUntitled } from "../state";
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
		const out: monaco.editor.IModelDeltaDecoration[] = [];
		for (const change of lineChanges(base, model.getLinesContent())) {
			// Lines taken out leave no line to mark: the mark is on the line before, or above the first.
			const start = Math.min(Math.max(change.line, 1), last);
			const end = Math.min(Math.max(change.endLine, start), last);
			if (change.kind === "removed") {
				const kind = change.line < 1 ? "removed-above" : "removed";
				out.push({ range: new monaco.Range(start, 1, start, 1), options: { isWholeLine: true, linesDecorationsClassName: `git-mark ${kind}` } });
				continue;
			}
			// Mark hunk endpoints so consecutive lines join seamlessly into one unbroken vertical bar
			// (solid filled for added; continuous hollow/framed rail for modified, per ADR 0010 & ADR 0027).
			if (start === end) {
				out.push({ range: new monaco.Range(start, 1, start, 1), options: { isWholeLine: true, linesDecorationsClassName: `git-mark ${change.kind} hunk-single` } });
			} else {
				out.push({ range: new monaco.Range(start, 1, start, 1), options: { isWholeLine: true, linesDecorationsClassName: `git-mark ${change.kind} hunk-start` } });
				if (end - start > 1) {
					out.push({ range: new monaco.Range(start + 1, 1, end - 1, 1), options: { isWholeLine: true, linesDecorationsClassName: `git-mark ${change.kind} hunk-mid` } });
				}
				out.push({ range: new monaco.Range(end, 1, end, 1), options: { isWholeLine: true, linesDecorationsClassName: `git-mark ${change.kind} hunk-end` } });
			}
		}
		marks.set(out);
	};

	// The file shown, and what git has of it, either of which may change.
	createEffect(
		on([active, gitVersion, () => Boolean(gitStatus())], ([path, , repository], before) => {
			// Another file has other marks. The same file keeps the ones it has until git has answered again: asked
			// on every save, an answer that says the same would otherwise make them blink.
			if (path !== before?.[0] || !repository) {
				clearTimeout(timer);
				timer = undefined;
				base = null;
				marks.clear();
			}
			if (!path || !repository || isUntitled(path) || documents.get(path)?.binary) return;
			let stale = false;
			onCleanup(() => (stale = true));
			backend.gitBase(path, "index").then(
				(text) => {
					if (stale) return;
					base = text === null ? null : text.split(/\r?\n/);
					draw();
				},
				() => {
					if (stale) return;
					clearTimeout(timer);
					timer = undefined;
					base = null;
					marks.clear();
				},
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
