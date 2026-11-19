// While a link is written in a Markdown document, the project's documents
// are offered: "](" and the list is there, each by what it is called, and
// the path written is the way to it from this document.
import { linkBeingWritten, linkChoices } from "../../shared/docLinks";
import { monaco } from "./monaco";
import { docs } from "../project";
import { canonical, state } from "../state";

export function registerMarkdownLinks() {
	monaco.languages.registerCompletionItemProvider("markdown", {
		triggerCharacters: ["("],
		provideCompletionItems(model, position) {
			const typed = linkBeingWritten(model.getLineContent(position.lineNumber).slice(0, position.column - 1));
			const root = state.workspace?.root;
			if (typed === null || !root) return { suggestions: [] };
			const range = new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column);
			return {
				suggestions: linkChoices(docs(), canonical(model.uri.fsPath), root).map((choice, index) => ({
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
