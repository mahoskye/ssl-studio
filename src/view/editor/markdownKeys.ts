// What the keys do in a Markdown document's text in Monaco Source mode (matching
// CodeMirror 6 Live Preview 1:1): smart list Enter/Tab/Backspace and Obsidian
// inline formatting shortcuts (Ctrl+B, Ctrl+I, Ctrl+Shift+X, Ctrl+`, Ctrl+Alt+H,
// Ctrl+K, Alt+C / Ctrl+Alt+Enter). Every rule lives in shared/markdownEdit.ts and
// shared/markdownText.ts and mutates only the touched ranges (ADR 0002).
import { fenced } from "../../shared/catalog";
import {
	insertLinkEdit,
	smartListBackspace,
	smartListIndent,
	toggleCheckboxLine,
	toggleInlineWrap,
} from "../../shared/markdownEdit";
import { listEnter } from "../../shared/markdownText";
import { monaco } from "./monaco";

/** Enter, when it is typing a line's end: not while a list of suggestions, a snippet or a rename has the key. */
const TYPING =
	"editorTextFocus && !editorReadonly && editorLangId == 'markdown' && !suggestWidgetVisible && !inlineSuggestionVisible && !inSnippetMode && !renameInputVisible && !parameterHintsVisible";
const MD_EDITABLE = "editorLangId == 'markdown' && !editorReadonly";

/** Applies an offset-based TextEditResult from `shared/markdownEdit.ts` onto a Monaco model cleanly. */
function applyOffsetEdit(
	editor: monaco.editor.IStandaloneCodeEditor,
	source: string,
	compute: (text: string, from: number, to: number) => { changeFrom: number; changeTo: number; insert: string; selFrom: number; selTo: number },
) {
	const model = editor.getModel();
	const sel = editor.getSelection();
	if (!model || !sel) return;
	const text = model.getValue();
	const from = model.getOffsetAt(sel.getStartPosition());
	const to = model.getOffsetAt(sel.getEndPosition());
	const res = compute(text, from, to);
	const startPos = model.getPositionAt(res.changeFrom);
	const endPos = model.getPositionAt(res.changeTo);
	const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
	editor.pushUndoStop();
	editor.executeEdits(source, [{ range, text: res.insert, forceMoveMarkers: true }]);
	const s1 = model.getPositionAt(res.selFrom);
	const s2 = model.getPositionAt(res.selTo);
	editor.setSelection(new monaco.Selection(s1.lineNumber, s1.column, s2.lineNumber, s2.column));
	editor.pushUndoStop();
	editor.focus();
}

/** Runs an Obsidian Markdown formatting action (`md-bold`, `md-italic`, etc.) on a Monaco editor. */
export function runMonacoMarkdownAction(editor: monaco.editor.IStandaloneCodeEditor, id: string): boolean {
	const model = editor.getModel();
	if (!model || model.getLanguageId() !== "markdown") return false;
	switch (id) {
		case "md-bold":
			applyOffsetEdit(editor, "md-bold", (t, a, b) => toggleInlineWrap(t, a, b, "**"));
			return true;
		case "md-italic":
			applyOffsetEdit(editor, "md-italic", (t, a, b) => toggleInlineWrap(t, a, b, "*"));
			return true;
		case "md-strike":
			applyOffsetEdit(editor, "md-strike", (t, a, b) => toggleInlineWrap(t, a, b, "~~"));
			return true;
		case "md-code":
			applyOffsetEdit(editor, "md-code", (t, a, b) => toggleInlineWrap(t, a, b, "`"));
			return true;
		case "md-highlight":
			applyOffsetEdit(editor, "md-highlight", (t, a, b) => toggleInlineWrap(t, a, b, "=="));
			return true;
		case "md-link":
			applyOffsetEdit(editor, "md-link", insertLinkEdit);
			return true;
		case "md-checkbox": {
			const sel = editor.getSelection();
			if (!sel) return false;
			const startLine = sel.startLineNumber;
			const endLine = sel.endColumn === 1 && sel.endLineNumber > startLine ? sel.endLineNumber - 1 : sel.endLineNumber;
			const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
			for (let n = startLine; n <= endLine; n++) {
				const line = model.getLineContent(n);
				const next = toggleCheckboxLine(line);
				if (next !== line) {
					edits.push({ range: new monaco.Range(n, 1, n, model.getLineMaxColumn(n)), text: next, forceMoveMarkers: true });
				}
			}
			if (edits.length) {
				editor.pushUndoStop();
				editor.executeEdits("md-checkbox", edits);
				editor.pushUndoStop();
			}
			editor.focus();
			return true;
		}
		case "md-insert-footnote": {
			const sel = editor.getSelection();
			if (!sel) return false;
			const full = model.getValue();
			let maxNum = 0;
			for (const m of full.matchAll(/\[\^(\d+)\]/g)) {
				const n = Number(m[1]);
				if (Number.isFinite(n) && n > maxNum) maxNum = n;
			}
			const ref = `[^${maxNum + 1}]`;
			const eol = model.getEOL();
			const lastLine = model.getLineCount();
			const lastCol = model.getLineMaxColumn(lastLine);
			const sep = full.endsWith(`${eol}${eol}`) ? "" : full.endsWith(eol) ? eol : `${eol}${eol}`;
			const def = `${sep}${ref}: `;
			editor.pushUndoStop();
			editor.executeEdits("md-insert-footnote", [
				{ range: sel, text: ref, forceMoveMarkers: true },
				{ range: new monaco.Range(lastLine, lastCol, lastLine, lastCol), text: def, forceMoveMarkers: true },
			]);
			const newLast = model.getLineCount();
			const newEndCol = model.getLineMaxColumn(newLast);
			const endPos = { lineNumber: newLast, column: newEndCol };
			editor.setPosition(endPos);
			editor.revealPositionInCenterIfOutsideViewport(endPos);
			editor.pushUndoStop();
			editor.focus();
			return true;
		}
		default:
			return false;
	}
}

/**
 * Binds Obsidian-style Markdown editing keys (Enter, Tab/Shift-Tab on lists, Backspace
 * on block markers, and Ctrl+B/I/K/L/Shift+X/`/Alt+H formatting) for this Monaco editor
 * in Source mode so Source and Live Preview share identical text-editing ergonomics.
 */
export function continueLists(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
	const disposables: monaco.IDisposable[] = [];
	const plainEnter = () => editor.trigger("keyboard", "type", { text: "\n" });

	disposables.push(
		editor.addAction({
			id: "app.markdown-enter",
			label: "Markdown: start the next item of a list",
			precondition: MD_EDITABLE,
			keybindings: [monaco.KeyCode.Enter],
			keybindingContext: TYPING,
			run: () => {
				const model = editor.getModel();
				const selections = editor.getSelections();
				if (!model || selections?.length !== 1 || !selections[0]!.isEmpty()) return plainEnter();
				const at = selections[0]!.getPosition();
				const line = model.getLineContent(at.lineNumber);
				const next = listEnter(line, at.column - 1);
				if (!next) return plainEnter();
				const offset = model.getOffsetAt(at);
				if (fenced(model.getValue()).some(([from, to]) => offset >= from && offset <= to)) return plainEnter();
				const gap = /^[ \t]*/.exec(line.slice(at.column - 1))![0].length;
				const edit =
					"start" in next
						? { range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column + gap), text: `${model.getEOL()}${next.start}` }
						: { range: new monaco.Range(at.lineNumber, next.keep + 1, at.lineNumber, model.getLineMaxColumn(at.lineNumber)), text: "" };
				const after =
					"start" in next
						? new monaco.Selection(at.lineNumber + 1, next.start.length + 1, at.lineNumber + 1, next.start.length + 1)
						: new monaco.Selection(at.lineNumber, next.keep + 1, at.lineNumber, next.keep + 1);
				editor.pushUndoStop();
				editor.executeEdits("markdown-list", [edit], [after]);
				editor.pushUndoStop();
				editor.revealPosition(after.getPosition());
			},
		}),
	);

	// Smart Tab / Shift+Tab on Markdown lists in Source mode.
	const bindListIndent = (direction: "indent" | "outdent", key: number) =>
		editor.addAction({
			id: `app.markdown-${direction}`,
			label: `Markdown: ${direction} list item`,
			precondition: MD_EDITABLE,
			keybindings: [key],
			keybindingContext: TYPING,
			run: () => {
				const model = editor.getModel();
				const sel = editor.getSelection();
				if (!model || !sel) return;
				const startLine = sel.startLineNumber;
				const endLine = sel.endColumn === 1 && sel.endLineNumber > startLine ? sel.endLineNumber - 1 : sel.endLineNumber;
				const fences = fenced(model.getValue());
				let anyList = false;
				const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
				let colDelta = 0;
				for (let n = startLine; n <= endLine; n++) {
					const offset = model.getOffsetAt({ lineNumber: n, column: 1 });
					if (fences.some(([a, b]) => offset >= a && offset < b)) continue;
					const line = model.getLineContent(n);
					const res = smartListIndent(line, direction);
					if (res) {
						anyList = true;
						if (res.text !== line) {
							edits.push({ range: new monaco.Range(n, 1, n, model.getLineMaxColumn(n)), text: res.text, forceMoveMarkers: true });
							if (n === sel.positionLineNumber) colDelta = res.delta;
						}
					}
				}
				if (!anyList) {
					editor.trigger("keyboard", direction === "indent" ? "tab" : "outdent", null);
					return;
				}
				if (edits.length) {
					editor.pushUndoStop();
					editor.executeEdits(`markdown-${direction}`, edits);
					if (sel.isEmpty()) {
						const pos = sel.getPosition();
						editor.setPosition({ lineNumber: pos.lineNumber, column: Math.max(1, pos.column + colDelta) });
					}
					editor.pushUndoStop();
				}
			},
		});

	disposables.push(bindListIndent("indent", monaco.KeyCode.Tab));
	disposables.push(bindListIndent("outdent", monaco.KeyMod.Shift | monaco.KeyCode.Tab));

	// Smart Backspace right after a list/heading/quote marker in Source mode.
	disposables.push(
		editor.addAction({
			id: "app.markdown-backspace",
			label: "Markdown: strip list or heading marker",
			precondition: MD_EDITABLE,
			keybindings: [monaco.KeyCode.Backspace],
			keybindingContext: TYPING,
			run: () => {
				const model = editor.getModel();
				const selections = editor.getSelections();
				if (!model || selections?.length !== 1 || !selections[0]!.isEmpty()) {
					editor.trigger("keyboard", "deleteLeft", null);
					return;
				}
				const at = selections[0]!.getPosition();
				const line = model.getLineContent(at.lineNumber);
				const cut = smartListBackspace(line, at.column - 1);
				const offset = model.getOffsetAt(at);
				if (!cut || fenced(model.getValue()).some(([a, b]) => offset >= a && offset <= b)) {
					editor.trigger("keyboard", "deleteLeft", null);
					return;
				}
				editor.pushUndoStop();
				editor.executeEdits(
					"markdown-backspace",
					[{ range: new monaco.Range(at.lineNumber, cut.from + 1, at.lineNumber, cut.to + 1), text: "" }],
					[new monaco.Selection(at.lineNumber, cut.from + 1, at.lineNumber, cut.from + 1)],
				);
				editor.pushUndoStop();
			},
		}),
	);

	// Obsidian inline formatting shortcuts in Source mode too!
	const formatBindings: [id: string, label: string, keys: number[]][] = [
		["md-bold", "Markdown: Bold", [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB]],
		["md-italic", "Markdown: Italic", [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI]],
		["md-strike", "Markdown: Strikethrough", [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyX]],
		["md-code", "Markdown: Inline code", [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backquote]],
		["md-highlight", "Markdown: Highlight", [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyH]],
		["md-link", "Markdown: Insert link", [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK]],
		[
			"md-checkbox",
			"Markdown: Toggle checkbox",
			[monaco.KeyMod.Alt | monaco.KeyCode.KeyC, monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Enter],
		],
	];
	for (const [id, label, keybindings] of formatBindings) {
		disposables.push(
			editor.addAction({
				id: `app.${id}`,
				label,
				precondition: MD_EDITABLE,
				keybindings,
				keybindingContext: "editorTextFocus && !editorReadonly && editorLangId == 'markdown'",
				run: () => void runMonacoMarkdownAction(editor, id),
			}),
		);
	}

	return { dispose: () => disposables.forEach((d) => d.dispose()) };
}
