// The editor's comment commands, for a script. The editor takes a language's two comment tokens for brackets
// round the selection, which is wrong where the close token is the one every statement ends with: of two
// statements selected only the first became comment (shared/commentToggle.ts has the rule that is right).
//
// The commands keep their names, keys and places in the menus: each is replaced, in a code editor, by one that
// does the same for every other language and the right thing for SSL.
import { lineRange, toggleComments, withEdits, type CommentEdit, type TextRange } from "../../shared/commentToggle";
import { notify } from "../state";
import { monaco, sslCommentTokens } from "./monaco";
import { sslCommentSpans } from "./textmate";

type How = { of: "lines" | "selection"; how: "toggle" | "comment" | "uncomment" };
/** The editor's four comment commands, and what each asks for. */
const COMMANDS: Record<string, How> = {
	"editor.action.commentLine": { of: "lines", how: "toggle" },
	"editor.action.addCommentLine": { of: "lines", how: "comment" },
	"editor.action.removeCommentLine": { of: "lines", how: "uncomment" },
	"editor.action.blockComment": { of: "selection", how: "toggle" },
};

/**
 * Runs a comment command on a script's selections. False where it is not this command's to run (another
 * language, or the grammar or the language configuration not read yet): the editor's own command runs then.
 */
export function toggleSslComment(editor: monaco.editor.ICodeEditor, { of, how }: How): boolean {
	const model = editor.getModel();
	const tokens = sslCommentTokens();
	if (!model || model.getLanguageId() !== "ssl" || !tokens) return false;
	const lines = model.getLinesContent();
	const spans = sslCommentSpans(lines);
	if (!spans) return false;
	// Each selection's lines, or with "toggle block comment" what is selected; a cursor alone is its line.
	const ranges: TextRange[] = [];
	for (const selection of [...(editor.getSelections() ?? [])].sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn)) {
		const picked: TextRange = {
			start: { line: selection.startLineNumber - 1, column: selection.startColumn - 1 },
			end: { line: selection.endLineNumber - 1, column: selection.endColumn - 1 },
		};
		const range = of === "lines" || selection.isEmpty() ? lineRange(lines, picked) : picked;
		const last = ranges.at(-1);
		// Two cursors on one line, or two selections that share a line, are one request for that line.
		if (last && (range.start.line < last.end.line || (range.start.line === last.end.line && range.start.column <= last.end.column))) continue;
		ranges.push(range);
	}
	const seen = new Set<string>();
	const edits: CommentEdit[] = [];
	for (const range of ranges) {
		for (const edit of toggleComments(lines, spans, tokens, range, how)) {
			// Two cursors in one comment both ask for that comment to be taken away: once is enough.
			const key = `${edit.start.line}:${edit.start.column}:${edit.end.line}:${edit.end.column}:${edit.text}`;
			if (!seen.has(key)) edits.push(edit);
			seen.add(key);
		}
	}
	if (!edits.length) return true;
	// The grammar is asked whether each opener written would be a comment where it stands. One inside a string
	// would not be: it would change the string and comment nothing, so nothing is written, and the reason is said.
	const result = withEdits(lines, edits, tokens);
	const after = sslCommentSpans(result.lines);
	const stray = result.openers.find((place) => !after?.[place.line]?.some((span) => span.from <= place.column && place.column < span.to));
	if (stray) {
		notify(`Line ${stray.line + 1} is inside a string: a comment cannot start there. Select from the start of the statement.`);
		return true;
	}
	editor.pushUndoStop();
	editor.executeEdits(
		"comment",
		edits.map((edit) => ({ range: new monaco.Range(edit.start.line + 1, edit.start.column + 1, edit.end.line + 1, edit.end.column + 1), text: edit.text })),
	);
	editor.pushUndoStop();
	return true;
}

let routed = false;

/**
 * Puts the comment commands for scripts in place of a code editor's own. Each is known to the editor by its own
 * id still, so the menus, the command list and `trigger` run the new one; the keys run it too, since the
 * commands the keys are bound to are sent to the editor that has the keyboard (done once, for every editor).
 */
export function installCommentCommands(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
	if (!routed) {
		routed = true;
		for (const id of Object.keys(COMMANDS)) {
			monaco.editor.registerCommand(id, () => {
				void monaco.editor
					.getEditors()
					.find((candidate) => candidate.hasTextFocus())
					?.getAction(id)
					?.run();
			});
		}
	}
	const placed = Object.entries(COMMANDS).flatMap(([id, how]) => {
		const own = editor.getAction(id);
		if (!own) return [];
		return [
			editor.addAction({
				id,
				label: own.label,
				precondition: "!editorReadonly",
				run: (target) => (toggleSslComment(target, how) ? undefined : own.run()),
			}),
		];
	});
	return { dispose: () => placed.forEach((action) => action.dispose()) };
}
