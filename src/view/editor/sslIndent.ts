// Indentation as a script is typed, asked of the language server's formatter (shared/formatterIndent.ts,
// ADR 0036). After Enter the new line is put where the formatter would put a line there; after a ";" the
// statement it ends is put where the formatter puts it, which is what takes ":ENDIF;" back out.
//
// Only the line's leading spaces and tabs are changed, and only if the text asked about is still the text: an
// answer comes a moment after the key, and what was typed in that moment is not undone by it.
import { columnAfterIndent, newLineIndent, newLineQuestion, ownLineIndent, ownLineQuestion, typedForIndent } from "../../shared/formatterIndent";
import { session } from "../lsp/session";
import { state } from "../state";
import { monaco } from "./monaco";

export function installFormatterIndent(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
	let asked = 0;
	let applying = false;

	async function indent(model: monaco.editor.ITextModel, typed: "line" | "end", mine: number) {
		const selections = editor.getSelections();
		// One cursor, in the editor the key was pressed in: several cursors are several lines, each asked for apart.
		if (!selections || selections.length !== 1 || !selections[0]!.isEmpty() || editor.getModel() !== model) return;
		const at = selections[0]!.getPosition();
		const line = at.lineNumber;
		const lineEnd = () => new monaco.Range(1, 1, line, model.getLineMaxColumn(line));
		const lineStart = new monaco.Range(1, 1, line, 1);
		// A ";" with more of the line after it has not ended the line: the statement is still being written.
		if (typed === "end" && model.getLineContent(line).slice(at.column - 1).trim()) return;
		const about = model.getValueInRange(typed === "line" ? lineStart : lineEnd());
		const options = model.getOptions();
		let formatted: string;
		try {
			formatted = await session.formatText(typed === "line" ? newLineQuestion(about) : ownLineQuestion(about), { tabSize: options.tabSize, insertSpaces: options.insertSpaces }, model.uri.path);
		} catch {
			// No server to ask, or it would not format this: the line stays as the editor left it.
			return;
		}
		if (mine !== asked || model.isDisposed() || editor.getModel() !== model || line > model.getLineCount()) return;
		if (model.getValueInRange(typed === "line" ? lineStart : lineEnd()) !== about) return;
		const text = model.getLineContent(line);
		const now = typed === "line" ? newLineIndent(formatted) : ownLineIndent(formatted, text);
		const was = /^[ \t]*/.exec(text)![0];
		if (now === null || now === was) return;
		const cursors = editor.getSelections() ?? [];
		const shift = (lineNumber: number, column: number) => (lineNumber === line ? columnAfterIndent(column, was, now) : column);
		const moved = cursors.map((s) => new monaco.Selection(s.selectionStartLineNumber, shift(s.selectionStartLineNumber, s.selectionStartColumn), s.positionLineNumber, shift(s.positionLineNumber, s.positionColumn)));
		applying = true;
		try {
			editor.executeEdits("indent", [{ range: new monaco.Range(line, 1, line, was.length + 1), text: now }], () => moved);
		} finally {
			applying = false;
		}
	}

	return editor.onDidChangeModelContent((event) => {
		if (applying || event.isUndoing || event.isRedoing || event.isFlush) return;
		const model = editor.getModel();
		if (!model || model.getLanguageId() !== "ssl" || !editor.hasTextFocus()) return;
		if (state.settings.indentOnType === false || state.lsp.state !== "running") return;
		const typed = typedForIndent(event.changes);
		if (!typed) return;
		const mine = ++asked;
		// The cursor is put after what was typed once the change is made: it is read then.
		queueMicrotask(() => void indent(model, typed, mine));
	});
}
