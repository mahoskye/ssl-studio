// What the keys do in a Markdown document's text beyond typing. Enter in a
// list starts the next item, and on an item with no words ends the list, as
// a notebook does: the rule is in shared/markdownText.ts, and what it gives
// is one edit of the text at the cursor (ADR 0002).
import { fenced } from "../../shared/catalog";
import { listEnter } from "../../shared/markdownText";
import { monaco } from "./monaco";

/** Enter, when it is typing a line's end: not while a list of suggestions, a snippet or a rename has the key. */
const TYPING = "editorTextFocus && !editorReadonly && editorLangId == 'markdown' && !suggestWidgetVisible && !inlineSuggestionVisible && !inSnippetMode && !renameInputVisible && !parameterHintsVisible";

/**
 * Binds Enter for this editor, and for it alone: as an action of the editor, which the editor keeps to itself and
 * lets go of when asked. (A bare command would be every editor's, and the last one made would answer for all.)
 */
export function continueLists(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
	/** Enter as the editor does it on its own. */
	const plain = () => editor.trigger("keyboard", "type", { text: "\n" });
	return editor.addAction({
		id: "app.markdown-enter",
		label: "Markdown: start the next item of a list",
		// Not listed among the editor's commands for a script, nor for a file that cannot be written.
		precondition: "editorLangId == 'markdown' && !editorReadonly",
		keybindings: [monaco.KeyCode.Enter],
		keybindingContext: TYPING,
		run: () => {
			const model = editor.getModel();
			const selections = editor.getSelections();
			// One cursor with nothing selected: anything else is the editor's own to work out.
			if (!model || selections?.length !== 1 || !selections[0]!.isEmpty()) return plain();
			const at = selections[0]!.getPosition();
			const line = model.getLineContent(at.lineNumber);
			const next = listEnter(line, at.column - 1);
			if (!next) return plain();
			// In a block of code a line that starts with a dash is a line of code.
			const offset = model.getOffsetAt(at);
			if (fenced(model.getValue()).some(([from, to]) => offset >= from && offset <= to)) return plain();
			// The words after the cursor go to the new item without the space that stood between them and the cursor.
			const gap = /^[ \t]*/.exec(line.slice(at.column - 1))![0].length;
			const edit =
				"start" in next
					? { range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column + gap), text: `${model.getEOL()}${next.start}` }
					: { range: new monaco.Range(at.lineNumber, next.keep + 1, at.lineNumber, model.getLineMaxColumn(at.lineNumber)), text: "" };
			const after = "start" in next ? new monaco.Selection(at.lineNumber + 1, next.start.length + 1, at.lineNumber + 1, next.start.length + 1) : new monaco.Selection(at.lineNumber, next.keep + 1, at.lineNumber, next.keep + 1);
			editor.pushUndoStop();
			editor.executeEdits("markdown-list", [edit], [after]);
			editor.pushUndoStop();
			editor.revealPosition(after.getPosition());
		},
	});
}
