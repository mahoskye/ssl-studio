// Links in a Markdown document's text. While one is written, the project's
// documents are offered: "](" and the list is there, each by what it is
// called, and the path written is the way to it from this document. Once it
// is written it can be followed from the text, as it can from the page:
// Ctrl+click, or "Open the link at the cursor".
import { fenced } from "../../shared/catalog";
import { hrefWritten, linkBeingWritten, linkChoices, linkLeads } from "../../shared/docLinks";
import { headingAnchor } from "../../shared/docTables";
import { relativeTo } from "../../shared/paths";
import { marksFor } from "./markdownLive";
import { monaco } from "./monaco";
import { docs } from "../project";
import { canonical, openFile, state } from "../state";

/** How a link to a place in the project is told to the editor, which only follows addresses: one of the app's own. */
const OWN = "ssl-studio-link";
type Place = { file: string; line?: number; endLine?: number };
const address = (place: Place) => monaco.Uri.from({ scheme: OWN, path: "/", query: JSON.stringify(place) });

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

	// A link leads where it leads from anywhere in it: its words, and its address when that is in sight. Between two
	// pairs of brackets it is drawn and not followed: such a link names no path, and the project's links do.
	monaco.languages.registerLinkProvider("markdown", {
		async provideLinks(model) {
			// A text that is no file of the project (a proposal under review) has no place to lead from.
			if (model.uri.scheme !== "file") return { links: [] };
			const marks = await marksFor(model);
			if (model.isDisposed()) return { links: [] };
			const here = canonical(model.uri.fsPath);
			const root = state.workspace?.root;
			const links: monaco.languages.ILink[] = [];
			/**
			 * The line of the heading a link to "#its-name" means, named as the page names it: by its words, and a
			 * second heading of the same words by "-1" after them. Worked out only when there is such a link.
			 */
			let headings: Map<string, number> | undefined;
			const headingLine = (name: string) => {
				if (!headings) {
					headings = new Map();
					const used = new Map<string, number>();
					for (const mark of marks) {
						if (!/^h[1-6]$/.test(mark.kind) || mark.line > model.getLineCount() || [...headings.values()].includes(mark.line)) continue;
						const anchor = headingAnchor(
							model
								.getLineContent(mark.line)
								.replace(/^\s*#{1,6}\s+/, "")
								.replace(/\s+#+\s*$/, ""),
						);
						if (!anchor) continue;
						const count = used.get(anchor) ?? 0;
						used.set(anchor, count + 1);
						headings.set(count ? `${anchor}-${count}` : anchor, mark.line);
					}
				}
				return headings.get(name) ?? headings.get(headingAnchor(name));
			};
			for (const mark of marks) {
				if (mark.kind !== "link" || !mark.href || mark.line > model.getLineCount()) continue;
				// The marks may be of the text as it was a moment ago: the link must still be where they say.
				if (model.getLineContent(mark.line).slice(mark.end - 1, mark.end + 1) !== "](") continue;
				const leads = linkLeads(hrefWritten(mark.href), here, root);
				if (!leads) continue;
				// From its opening bracket to the bracket that closes its address: the markup either side of its words.
				const before = marks.find((other) => other.kind === "syntax" && other.line === mark.line && other.end === mark.start);
				const after = marks.find((other) => other.kind === "syntax" && other.line === mark.line && other.start === mark.end);
				const range = new monaco.Range(mark.line, before?.start ?? mark.start, mark.line, after?.end ?? mark.end);
				if ("web" in leads) links.push({ range, url: leads.web });
				else if ("heading" in leads) {
					const line = headingLine(leads.heading);
					if (line) links.push({ range, url: address({ file: here, line }), tooltip: "Go to the heading" });
				} else links.push({ range, url: address({ file: leads.file, ...leads.lines }), tooltip: `Open ${relativeTo(root, leads.file)}` });
			}
			return { links };
		},
	});
	monaco.editor.registerLinkOpener({
		open(resource) {
			if (resource.scheme !== OWN) return false;
			try {
				const place = JSON.parse(resource.query) as Place;
				// A line of the document the link is in is gone to in the editor it was followed in: with the document in
				// two groups, the other one stays where it is. (Lines from one to another are shown as any file's are.)
				const from = monaco.editor.getEditors().find((editor) => editor.hasWidgetFocus());
				const model = from?.getModel();
				if (from && model && place.line && !place.endLine && model.uri.scheme === "file" && canonical(model.uri.fsPath) === place.file) {
					from.setPosition({ lineNumber: place.line, column: 1 });
					from.revealLineNearTop(place.line, monaco.editor.ScrollType.Immediate);
					from.focus();
				} else void openFile(place.file, place.line ? { reveal: { line: place.line, ...(place.endLine ? { endLine: place.endLine } : {}) } } : {});
			} catch {
				// Not one of the addresses made above: nothing to open.
			}
			return true;
		},
	});
}
