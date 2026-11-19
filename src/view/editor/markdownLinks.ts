// While a link is written in a Markdown document, the project's documents
// are offered: "](" and the list is there, each by what it is called, and
// the path written is the way to it from this document.
import { fenced } from "../../shared/catalog";
import { linkBeingWritten, linkChoices } from "../../shared/docLinks";
import { monaco } from "./monaco";
import { docs } from "../project";
import { canonical, state } from "../state";

export function registerMarkdownLinks() {
	monaco.languages.registerCompletionItemProvider("markdown", {
		triggerCharacters: ["("],
		provideCompletionItems(model, position) {
			const line = model.getLineContent(position.lineNumber);
			const typed = linkBeingWritten(line.slice(0, position.column - 1));
			const root = state.workspace?.root;
			if (typed === null || !root) return { suggestions: [] };
			// In a block of code the same characters are a call, or an example of a link.
			const offset = model.getOffsetAt(position);
			if (fenced(model.getValue()).some(([from, to]) => offset >= from && offset <= to)) return { suggestions: [] };
			// What is chosen takes the place of the whole target the cursor is in: what was typed, and what follows it.
			const rest = /^[^()<>\s]*/.exec(line.slice(position.column - 1))![0].length;
			const range = new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column + rest);
			// The document itself is not offered, however its path is cased or slashed.
			const here = canonical(model.uri.fsPath);
			const files = docs().filter((file) => canonical(file.path) !== here);
			return {
				suggestions: linkChoices(files, here, root).map((choice, index) => ({
					label: { label: choice.label, description: choice.detail },
					kind: monaco.languages.CompletionItemKind.File,
					insertText: choice.insert,
					// What is typed may be part of its name, its ticket's key or its path.
					filterText: `${choice.label} ${choice.detail} ${choice.insert}`,
					// In the order the Docs panel lists them: tickets first.
					sortText: String(index).padStart(5, "0"),
					range,
				})),
			};
		},
	});
}
