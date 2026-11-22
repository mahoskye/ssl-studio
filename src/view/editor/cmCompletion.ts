// Obsidian-style Markdown autocomplete for CodeMirror 6 Live Preview:
// - `[[`           -> project documents by name (tickets first), auto-closing `]]`
// - `[[doc#` / `[[#` -> live heading autocomplete in the target or current note
// - `](`           -> relative project document paths
// - `> [!`         -> Obsidian callout types (`NOTE`, `TIP`, `WARNING`, ...)
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { fenced } from "../../shared/catalog";
import { linkBeingWritten, linkChoices } from "../../shared/docLinks";
import { CALLOUT_SPECS, documentHeadings } from "../../shared/markdownEdit";
import { docByName, nameBeingWritten, nameChoices } from "../../shared/namedLinks";
import { backend } from "../backend";
import { docs } from "../project";
import { canonical, documents, state } from "../state";

const headingCache = new Map<string, { at: number; text: string }>();

async function readTargetText(path: string): Promise<string> {
	const key = canonical(path);
	const open = documents.get(key);
	if (open) return open.model.getValue();
	const cached = headingCache.get(key);
	if (cached && Date.now() - cached.at < 4000) return cached.text;
	try {
		const res = await backend.read(path);
		headingCache.set(key, { at: Date.now(), text: res.text });
		return res.text;
	} catch {
		return "";
	}
}

function insideBackticks(lineBefore: string): boolean {
	return (lineBefore.match(/`/g)?.length ?? 0) % 2 === 1;
}

function markdownCompletionSource(filePath: () => string) {
	return async (context: CompletionContext): Promise<CompletionResult | null> => {
		const line = context.state.doc.lineAt(context.pos);
		const col = context.pos - line.from;
		const before = line.text.slice(0, col);
		const after = line.text.slice(col);

		// Never suggest Markdown syntax inside fenced code blocks.
		const fullText = context.state.doc.toString();
		if (fenced(fullText).some(([from, to]) => context.pos >= from && context.pos <= to)) return null;

		// 1. Obsidian callout type completion: `> [!` at start of blockquote line.
		const calloutMatch = /^[ \t]{0,3}>[ \t]*\[!([A-Za-z0-9_-]*)$/.exec(before);
		if (calloutMatch) {
			const typed = calloutMatch[1]!;
			const from = context.pos - typed.length;
			const rest = /^[A-Za-z0-9_-]*/.exec(after)![0].length;
			const hasClose = after.slice(rest).startsWith("]");
			const options: Completion[] = Object.values(CALLOUT_SPECS).map((spec, idx) => ({
				label: spec.type.toUpperCase(),
				detail: spec.label,
				type: "keyword",
				boost: 100 - idx,
				apply: hasClose ? spec.type.toUpperCase() : `${spec.type.toUpperCase()}] `,
			}));
			return { from, to: context.pos + rest, options, validFor: /^[A-Za-z0-9_-]*$/ };
		}

		const root = state.workspace?.root;
		const here = canonical(filePath());

		// 2. Wikilink heading completion: `[[doc#heading` or `[[#heading`.
		const headingMatch = /\[\[([^[\]|#\n]*)#([^[\]|#\n]*)$/.exec(before);
		if (headingMatch && !insideBackticks(before.slice(0, headingMatch.index))) {
			const docName = headingMatch[1]!.trim();
			const typed = headingMatch[2]!;
			let targetText = "";
			if (!docName) {
				targetText = fullText;
			} else if (root) {
				const found = docByName(docName, docs(), root);
				if (found) targetText = await readTargetText(found.path);
			}
			const headings = documentHeadings(targetText);
			if (!headings.length) return null;
			const from = context.pos - typed.length;
			const rest = /^[^[\]|#]*/.exec(after)![0].length;
			const closed = /^(?:\|[^[\]]*)?\]\]/.test(after.slice(rest));
			const options: Completion[] = headings.map((h, idx) => ({
				label: h.text,
				detail: `H${h.level}`,
				type: "text",
				boost: 100 - idx,
				apply: closed ? h.text : `${h.text}]]`,
			}));
			return { from, to: context.pos + (closed ? rest : 0), options, validFor: /^[^[\]|#\n]*$/ };
		}

		// 3. Wikilink document name completion: `[[name`.
		const nameTyped = nameBeingWritten(before);
		if (nameTyped !== null && root) {
			const from = context.pos - nameTyped.length;
			const rest = /^[^[\]|#]*/.exec(after)![0].length;
			const closed = /^(?:[|#][^[\]]*)?\]\]/.test(after.slice(rest));
			const all = docs();
			const files = all.filter((f) => canonical(f.path) !== here);
			const choices = nameChoices(files, here, root, all);
			const options: Completion[] = choices.map((choice, idx) => ({
				label: choice.label,
				detail: choice.detail,
				type: "file",
				boost: 1000 - idx,
				apply: closed ? choice.name : `${choice.name}]]`,
			}));
			return { from, to: context.pos + (closed ? rest : 0), options, validFor: /^[^[\]|#\n]*$/ };
		}

		// 4. Relative Markdown link completion: `](path`.
		const linkTyped = linkBeingWritten(before);
		if (linkTyped !== null && root) {
			const from = context.pos - linkTyped.length;
			const rest = /^[^()<>\s]*/.exec(after)![0].length;
			const files = docs().filter((f) => canonical(f.path) !== here);
			const choices = linkChoices(files, here, root);
			const options: Completion[] = choices.map((choice, idx) => ({
				label: choice.label,
				detail: choice.detail,
				type: "file",
				boost: 1000 - idx,
				apply: choice.insert,
			}));
			return { from, to: context.pos + rest, options, validFor: /^[^()<>\s]*$/ };
		}

		return null;
	};
}

export function cmMarkdownCompletion(filePath: () => string): Extension {
	return autocompletion({
		override: [markdownCompletionSource(filePath)],
		activateOnTyping: true,
		icons: false,
		maxRenderedOptions: 40,
	});
}
