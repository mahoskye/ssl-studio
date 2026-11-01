// Monaco's "go to definition" and peek navigation open files through the
// app's tabs instead of nowhere.
import { monaco } from "./monaco";
import { openFile } from "../state";

monaco.editor.registerEditorOpener({
	openCodeEditor(_source, resource, selectionOrPosition) {
		if (resource.scheme !== "file") return false;
		const s = selectionOrPosition as any;
		const reveal = !s
			? undefined
			: "startLineNumber" in s
				? { line: s.startLineNumber, column: s.startColumn, endLine: s.endLineNumber, endColumn: s.endColumn }
				: { line: s.lineNumber, column: s.column };
		void openFile(resource.fsPath, { reveal });
		return true;
	},
});
