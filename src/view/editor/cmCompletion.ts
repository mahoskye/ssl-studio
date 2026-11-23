// Obsidian-style Markdown autocomplete for CodeMirror 6 Live Preview:
// - `[[`           -> project documents by name (tickets first), auto-closing `]]`
// - `[[doc#` / `[[#` -> live heading autocomplete in the target or current note
// - `](`           -> relative project document paths
// - `> [!`         -> Obsidian callout types (`NOTE`, `TIP`, `WARNING`, ...)
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { fenced } from "../../shared/catalog";
import { linkBeingWritten, linkChoices } from "../../shared/docLinks";
import { CALLOUT_PRESETS, CALLOUT_SPECS, documentHeadings } from "../../shared/markdownEdit";
import { docByName, nameBeingWritten, nameChoices } from "../../shared/namedLinks";
import { baseName, relativeTo } from "../../shared/paths";
import { extractTags, workspaceTags } from "../../shared/tags";
import { backend } from "../backend";
import { docs } from "../project";
import { canonical, documents, state } from "../state";
import { listWorkspaceImages } from "./imageResolve";

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

		// 0. Fenced code block language completion on an opening fence line: ```<lang>
		const fenceOpenMatch = /^[ \t]{0,3}(`{3,}|~{3,})([A-Za-z0-9_+-]*)$/.exec(before);
		if (fenceOpenMatch && after.trim() === "") {
			const priorLines = context.state.doc.sliceString(0, line.from).split(/\r?\n/);
			let openChar: string | null = null;
			let openLen = 0;
			for (const l of priorLines) {
				const m = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(l);
				if (!m) continue;
				const ch = m[1]![0]!;
				const len = m[1]!.length;
				if (!openChar) {
					openChar = ch;
					openLen = len;
				} else if (ch === openChar && len >= openLen && m[2]!.trim() === "") {
					openChar = null;
					openLen = 0;
				}
			}
			if (!openChar) {
				const typed = fenceOpenMatch[2]!;
				const from = context.pos - typed.length;
				const langs: [string, string][] = [
					["ssl", "STARLIMS Scripting Language"],
					["sql", "SQL query / DDL"],
					["tsql", "SQL Server T-SQL"],
					["plsql", "Oracle PL/SQL"],
					["mermaid", "Mermaid diagram"],
					["json", "JSON payload"],
					["xml", "XML / HL7 / XFD"],
					["yaml", "YAML configuration"],
					["javascript", "JavaScript"],
					["typescript", "TypeScript"],
					["csv", "CSV table"],
					["markdown", "Markdown"],
					["diff", "Unified diff"],
					["bash", "Shell script"],
				];
				return {
					from,
					to: context.pos,
					options: langs.map(([lang, detail], idx) => ({
						label: lang,
						detail,
						type: "keyword",
						boost: 100 - idx,
					})),
					validFor: /^[A-Za-z0-9_+-]*$/,
				};
			}
		}

		// Never suggest Markdown syntax inside fenced code blocks.
		const fullText = context.state.doc.toString();
		if (fenced(fullText).some(([from, to]) => context.pos >= from && context.pos <= to)) return null;

		// 1. Obsidian callout type completion: `> [!` or `>[!` at start of blockquote line.
		const calloutMatch = /^[ \t]{0,3}>[ \t]*\[!([A-Za-z0-9_-]*)$/.exec(before);
		if (calloutMatch) {
			const typed = calloutMatch[1]!;
			const from = context.pos - typed.length;
			const rest = /^[A-Za-z0-9_-]*/.exec(after)![0].length;
			const hasClose = after.slice(rest).startsWith("]");
			const presetMap = new Map(CALLOUT_PRESETS.map((p, idx) => [p.type, { about: p.about, idx }]));
			const options: Completion[] = Object.values(CALLOUT_SPECS).map((spec, idx) => {
				const preset = presetMap.get(spec.type);
				return {
					label: spec.type.toUpperCase(),
					detail: preset ? preset.about : spec.label,
					type: "keyword",
					boost: preset ? 200 - preset.idx : 100 - idx,
					apply: hasClose ? spec.type.toUpperCase() : `${spec.type.toUpperCase()}] `,
				};
			});
			return { from, to: context.pos + rest, options, validFor: /^[A-Za-z0-9_-]*$/ };
		}

		const root = state.workspace?.root;
		const here = canonical(filePath());

		// 1b. Obsidian embed completion: `![[name` -> workspace images AND project documents (transclusion).
		const imgEmbedMatch = /!\[\[([^[\]|#\n]*)$/.exec(before);
		if (imgEmbedMatch && root && !insideBackticks(before.slice(0, imgEmbedMatch.index))) {
			const typed = imgEmbedMatch[1]!;
			const images = await listWorkspaceImages();
			const all = docs();
			const docOpts = nameChoices(all.filter((f) => canonical(f.path) !== here), here, root, all);
			const from = context.pos - typed.length;
			const rest = /^[^[\]|#]*/.exec(after)![0].length;
			const closed = /^(?:\|[^[\]]*)?\]\]/.test(after.slice(rest));
			const options: Completion[] = [
				...images.map((imgPath, idx) => {
					const name = baseName(imgPath);
					const rel = relativeTo(root, imgPath);
					return {
						label: name,
						detail: rel,
						type: "file",
						boost: 600 - idx,
						apply: closed ? name : `${name}]]`,
					};
				}),
				...docOpts.map((choice, idx) => ({
					label: choice.label,
					detail: `Embed · ${choice.detail}`,
					type: "text",
					boost: 400 - idx,
					apply: closed ? choice.name : `${choice.name}]]`,
				})),
			];
			if (options.length) return { from, to: context.pos + (closed ? rest : 0), options, validFor: /^[^[\]|#\n]*$/ };
		}

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

		// 5. #tag completion from tags across this document + all workspace docs (skipping fenced code blocks & hex colors).
		const tagMatch = /(?:^|[\s(])#([A-Za-z][A-Za-z0-9_/-]*)$/.exec(before);
		if (tagMatch && !/^[ \t]{0,3}#/.test(before) && !insideBackticks(before.slice(0, tagMatch.index))) {
			const fences = fenced(fullText);
			if (fences.some(([a, b]) => context.pos >= a && context.pos <= b)) return null;
			const typed = tagMatch[1]!;
			const typedLower = typed.toLowerCase();
			const byLower = new Map<string, { tag: string; count: number }>();
			for (const bucket of workspaceTags(docs())) {
				byLower.set(bucket.tag.toLowerCase(), { tag: bucket.tag, count: bucket.count });
			}
			for (const localTag of extractTags(fullText)) {
				const k = localTag.toLowerCase();
				if (!byLower.has(k)) byLower.set(k, { tag: localTag, count: 1 });
			}
			const options: Completion[] = [...byLower.values()]
				.filter((entry) => entry.tag.toLowerCase() !== typedLower)
				.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }))
				.map((entry) => ({
					label: `#${entry.tag}`,
					detail: entry.count > 1 ? `${entry.count} docs` : undefined,
					apply: entry.tag,
					type: "keyword",
				}));
			if (options.length) {
				const from = context.pos - typed.length;
				return {
					from,
					options,
					validFor: /^[A-Za-z0-9_/-]*$/,
				};
			}
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
