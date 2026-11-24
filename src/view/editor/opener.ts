// Monaco's "go to definition" and peek navigation open files through the
// app's tabs instead of nowhere.
import { monaco } from "./monaco";
import { openFile } from "../state";
import { editorGroupOf } from "./EditorGroup";

monaco.editor.registerEditorOpener({
	openCodeEditor(source, resource, selectionOrPosition) {
		if (resource.scheme !== "file") return false;
		const s = selectionOrPosition as any;
		const reveal = !s
			? undefined
			: "startLineNumber" in s
				? { line: s.startLineNumber, column: s.startColumn, endLine: s.endLineNumber, endColumn: s.endColumn }
				: { line: s.lineNumber, column: s.column };
		const group = editorGroupOf(source);
		void openFile(resource.fsPath, { group, reveal });
		return true;
	},
});
