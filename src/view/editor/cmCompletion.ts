// Obsidian-style Markdown autocomplete for CodeMirror 6 Live Preview:
// - `/`            -> slash commands (/table, /callout, /mermaid, /ssl, /sql, /details, /toc, /footnote, /template, /date, /hr)
// - `[[`           -> project documents by name (tickets first), auto-closing `]]`
// - `[[doc#` / `[[#` -> live heading autocomplete in the target or current note
// - `![[`          -> workspace images & document transclusions
// - `](`           -> relative project document & code paths
// - `> [!`         -> Obsidian callout types (`NOTE`, `TIP`, `WARNING`, ...)
// - ```` ``` ````  -> fenced code block languages
// - `#tag`         -> workspace + document tags
// - `TABLE.` / `TABLE` / `TICKET-` -> STARLIMS schema tables/columns & workspace ticket keys
// - Plus lightweight `<textarea>` completion popover for Live Table cells, Callout bodies, and inline YAML.
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorSelection, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fenced } from "../../shared/catalog";
import { normalizeFenceLang, parseFenceOpen } from "../../shared/codeTokens";
import { localDay } from "../../shared/dates";
import { linkBeingWritten, linkChoices, linkWritten } from "../../shared/docLinks";
import { CALLOUT_PRESETS, CALLOUT_SPECS, documentHeadings, generateToc } from "../../shared/markdownEdit";
import { createEmptyTable } from "../../shared/markdownTables";
import { docByName, nameBeingWritten, nameChoices } from "../../shared/namedLinks";
import { baseName, dirName, relativePath, relativeTo } from "../../shared/paths";
import { isCatalog, statusChoices } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { extractSchemaColumns, findSchemaDocForIdentifier } from "../../shared/schemaIndex";
import { extractTags, isLikelyHexColorTag, workspaceTags } from "../../shared/tags";
import { backend } from "../backend";
import { docs } from "../project";
import { canonical, documents, state } from "../state";
import { focusLiveWidgetAt } from "./cmLiveShared";
import { listWorkspaceImages } from "./imageResolve";

export type SlashCommandDef = {
	name: string;
	detail: string;
	block?: boolean;
	focusWidget?: boolean;
	action?: "template" | "footnote";
};

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
	{ name: "table", detail: "Insert 3x2 Markdown table", block: true, focusWidget: true },
	{ name: "callout", detail: "Insert Obsidian callout card", block: true, focusWidget: true },
	{ name: "mermaid", detail: "Insert Mermaid diagram block", block: true },
	{ name: "ssl", detail: "Insert STARLIMS SSL code block", block: true },
	{ name: "sql", detail: "Insert SQL code block", block: true },
	{ name: "details", detail: "Insert collapsible details block", block: true },
	{ name: "toc", detail: "Insert Table of Contents", block: true },
	{ name: "footnote", detail: "Insert sequential footnote", action: "footnote" },
	{ name: "template", detail: "Insert Markdown template…", action: "template" },
	{ name: "date", detail: "Insert today's ISO date" },
	{ name: "hr", detail: "Insert horizontal divider", block: true },
];

export type SlashSnippetResult = {
	insert: string;
	selFrom: number;
	selTo: number;
	appendEnd?: string;
	block?: boolean;
	focusWidget?: boolean;
	action?: "template" | "footnote";
};

/** Pure snippet builder for Markdown `/` slash commands (tested directly in unit tests). */
export function buildSlashCommandSnippet(
	name: string,
	opts: { docText?: string; today?: string } = {},
): SlashSnippetResult | null {
	const key = name.trim().toLowerCase().replace(/^\/+/, "");
	switch (key) {
		case "table": {
			const tbl = createEmptyTable(3, 2);
			return {
				insert: `${tbl.text}\n`,
				selFrom: tbl.cursorOffset,
				selTo: tbl.cursorOffset + "Column 1".length,
				block: true,
				focusWidget: true,
			};
		}
		case "callout": {
			const insert = "> [!important]\n> ";
			return { insert, selFrom: insert.length, selTo: insert.length, block: true, focusWidget: true };
		}
		case "mermaid": {
			const line2 = "    A[Start] --> B[End]";
			const insert = `\`\`\`mermaid\nflowchart LR\n${line2}\n\`\`\``;
			const selFrom = insert.indexOf("A[Start]");
			const selTo = selFrom + "A[Start] --> B[End]".length;
			return { insert, selFrom, selTo, block: true };
		}
		case "ssl": {
			const insert = "```ssl\n\n```";
			return { insert, selFrom: 7, selTo: 7, block: true };
		}
		case "sql": {
			const insert = "```sql\n\n```";
			return { insert, selFrom: 7, selTo: 7, block: true };
		}
		case "details": {
			const insert = "<details>\n<summary>Details</summary>\n\nContent\n\n</details>";
			const selFrom = "<details>\n<summary>".length;
			return { insert, selFrom, selTo: selFrom + "Details".length, block: true };
		}
		case "toc": {
			const toc = generateToc(opts.docText ?? "");
			const insert = toc ? `<!-- toc -->\n\n${toc}\n\n<!-- /toc -->` : "<!-- toc -->\n\n<!-- /toc -->";
			return { insert, selFrom: insert.length, selTo: insert.length, block: true };
		}
		case "footnote": {
			const docText = opts.docText ?? "";
			let maxNum = 0;
			for (const m of docText.matchAll(/\[\^(\d+)\]/g)) {
				const n = Number(m[1]);
				if (Number.isFinite(n) && n > maxNum) maxNum = n;
			}
			const nextNum = maxNum + 1;
			const ref = `[^${nextNum}]`;
			const sep = docText.endsWith("\n\n") ? "" : docText.endsWith("\n") ? "\n" : "\n\n";
			return {
				insert: ref,
				selFrom: ref.length,
				selTo: ref.length,
				appendEnd: `${sep}${ref}: `,
				action: "footnote",
			};
		}
		case "template":
			return { insert: "", selFrom: 0, selTo: 0, action: "template" };
		case "date": {
			const today = opts.today ?? localDay();
			return { insert: today, selFrom: today.length, selTo: today.length };
		}
		case "hr": {
			const insert = "---\n\n";
			return { insert, selFrom: insert.length, selTo: insert.length, block: true };
		}
		default:
			return null;
	}
}

const HEADING_CACHE_MAX = 60;
const headingCache = new Map<string, { at: number; text: string }>();
const CODE_LINK_EXT_RE = /\.(ssl|ds|sql|xfd)$/i;
let codeFilesCache: { at: number; treeVer: number; root: string; files: string[] } | null = null;

async function listWorkspaceCodeFiles(root: string): Promise<string[]> {
	const now = Date.now();
	const ver = state.treeVersion;
	if (codeFilesCache && codeFilesCache.root === root && codeFilesCache.treeVer === ver && now - codeFilesCache.at < 5000) {
		return codeFilesCache.files;
	}
	try {
		const all = await backend.files();
		const filtered = all.filter((p) => CODE_LINK_EXT_RE.test(p));
		codeFilesCache = { at: now, treeVer: ver, root, files: filtered };
		return filtered;
	} catch {
		return codeFilesCache?.root === root ? codeFilesCache.files : [];
	}
}

async function readTargetText(path: string): Promise<string> {
	const key = canonical(path);
	const open = documents.get(key);
	if (open) return open.model.getValue();
	const cached = headingCache.get(key);
	if (cached && Date.now() - cached.at < 4000) {
		headingCache.delete(key);
		headingCache.set(key, cached);
		return cached.text;
	}
	try {
		const res = await backend.read(path);
		headingCache.delete(key);
		headingCache.set(key, { at: Date.now(), text: res.text });
		while (headingCache.size > HEADING_CACHE_MAX) {
			const oldest = headingCache.keys().next().value;
			if (oldest === undefined) break;
			headingCache.delete(oldest);
		}
		return res.text;
	} catch {
		return "";
	}
}

function insideBackticks(lineBefore: string): boolean {
	return (lineBefore.match(/`/g)?.length ?? 0) % 2 === 1;
}

/** Returns the normalized language of the enclosing fenced code block at `pos`, or null if outside fences. */
function enclosingFenceLang(docText: string, pos: number): string | null {
	const fences = fenced(docText);
	const hit = fences.find(([from, to]) => pos >= from && pos <= to);
	if (!hit) return null;
	const firstNl = docText.indexOf("\n", hit[0]);
	const openLine = docText.slice(hit[0], firstNl < 0 ? hit[1] : firstNl);
	const parsed = parseFenceOpen(openLine);
	return normalizeFenceLang(parsed?.lang ?? "");
}

/** Collects documented STARLIMS schema table names from workspace `docs()`. */
function collectSchemaTableOptions(allDocs: readonly DocFile[], prefixLower: string): Completion[] {
	const seen = new Set<string>();
	const options: Completion[] = [];
	for (const d of allDocs) {
		if (!d.exists || d.group !== "schema" || isCatalog(d)) continue;
		const candidates = [
			...(d.schemaObjects ?? []),
			...(d.title && /^[A-Za-z_][\w$.]{1,64}$/.test(d.title.trim()) ? [d.title.trim()] : []),
			(d.name.split(/[\\/]/).pop() ?? d.name).replace(/\.(md|markdown|sql|ddl|pks|pkb)$/i, ""),
		];
		for (const rawName of candidates) {
			const bare = rawName.includes(".") ? rawName.split(".").pop()! : rawName;
			const lower = bare.toLowerCase();
			if (!bare || bare.length < 2 || seen.has(lower)) continue;
			if (prefixLower && !lower.includes(prefixLower)) continue;
			seen.add(lower);
			const isPrefix = lower.startsWith(prefixLower);
			options.push({
				label: bare,
				detail: `Schema · ${d.name}`,
				type: "class",
				boost: isPrefix ? 120 : 60,
			});
		}
	}
	return options;
}

/** Collects workspace ticket key completions matching an uppercase typed prefix (e.g. `DEMO-`). */
function collectTicketOptions(allDocs: readonly DocFile[], typed: string, explicit: boolean): Completion[] {
	const upper = typed.toUpperCase();
	const options: Completion[] = [];
	let idx = 0;
	for (const d of allDocs) {
		if (!d.exists || d.group !== "tickets" || isCatalog(d) || !d.ticket) continue;
		const keyUpper = d.ticket.toUpperCase();
		if (!keyUpper.startsWith(upper)) continue;
		if (!explicit && keyUpper === upper) continue;
		options.push({
			label: d.ticket,
			detail: d.title ? `${d.title}${d.status ? ` (${d.status})` : ""}` : d.status || "Ticket",
			type: "constant",
			boost: 220 - Math.min(idx++, 100),
		});
	}
	return options;
}

function applySlashCommand(view: EditorView, cmd: SlashCommandDef, from: number, to: number) {
	const docText = view.state.doc.toString();
	const spec = buildSlashCommandSnippet(cmd.name, { docText });
	if (!spec) return;
	if (spec.action === "template") {
		view.dispatch({
			changes: { from, to, insert: "" },
			selection: EditorSelection.cursor(from),
			userEvent: "input.complete",
		});
		void import("../templater").then((m) => m.insertMarkdownTemplate());
		return;
	}
	if (spec.action === "footnote" && spec.appendEnd) {
		const docLen = view.state.doc.length;
		const defCursor = docLen + spec.insert.length - (to - from) + spec.appendEnd.length;
		view.dispatch({
			changes: [
				{ from, to, insert: spec.insert },
				{ from: docLen, to: docLen, insert: spec.appendEnd },
			],
			selection: EditorSelection.cursor(defCursor),
			scrollIntoView: true,
			userEvent: "input.complete",
		});
		return;
	}
	const line = view.state.doc.lineAt(from);
	const beforeOnLine = line.text.slice(0, from - line.from);
	const lead = spec.block && beforeOnLine.trim() ? "\n\n" : "";
	const insert = `${lead}${spec.insert}`;
	const selFrom = from + lead.length + spec.selFrom;
	const selTo = from + lead.length + spec.selTo;
	view.dispatch({
		changes: { from, to, insert },
		selection: EditorSelection.range(selFrom, selTo),
		scrollIntoView: true,
		userEvent: "input.complete",
	});
	if (spec.focusWidget) {
		const select = selFrom !== selTo;
		if (!focusLiveWidgetAt(view, selFrom, { select })) {
			requestAnimationFrame(() => focusLiveWidgetAt(view, selFrom, { select }));
		}
	}
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

		const fullText = context.state.doc.toString();
		const allDocs = docs();
		const fenceLang = enclosingFenceLang(fullText, context.pos);

		// 0b. Qualified STARLIMS schema `TABLE.column` completion (works in Markdown prose, inline code, and sql/ssl fences).
		if (fenceLang === null || fenceLang === "sql" || fenceLang === "tsql" || fenceLang === "plsql" || fenceLang === "ssl") {
			const dotMatch = /(?:^|[^\w$./:])([A-Za-z_][\w$]{1,})\.([A-Za-z_][\w$]*)?$/.exec(before);
			if (dotMatch && !/https?:\/\/\S*$/.test(before) && linkBeingWritten(before) === null && nameBeingWritten(before) === null) {
				const tbl = dotMatch[1]!;
				const typed = dotMatch[2] ?? "";
				const tableDoc = findSchemaDocForIdentifier(tbl, allDocs);
				if (tableDoc) {
					const raw = await readTargetText(tableDoc.path);
					const cols = raw ? extractSchemaColumns(tableDoc, raw) : [];
					const tblLower = tbl.toLowerCase();
					const scoped = cols.filter((c) => c.table.toLowerCase() === tblLower || c.table.toLowerCase().endsWith(`.${tblLower}`));
					const list = scoped.length ? scoped : cols;
					if (list.length) {
						return {
							from: context.pos - typed.length,
							to: context.pos,
							options: list.map((col, idx) => ({
								label: col.name,
								detail: [col.type, col.table].filter(Boolean).join(" · "),
								info: col.notes || undefined,
								type: "property",
								boost: 120 - Math.min(idx, 100),
							})),
							validFor: /^[A-Za-z0-9_$]*$/,
						};
					}
				}
			}
		}

		// Inside sql/ssl fenced code blocks, also allow bare schema table completion.
		if (fenceLang !== null) {
			if (fenceLang === "sql" || fenceLang === "tsql" || fenceLang === "plsql" || fenceLang === "ssl") {
				const wordMatch = /(?:^|[^\w$])([A-Za-z_][\w$]{1,})$/.exec(before);
				if (wordMatch) {
					const prefix = wordMatch[1]!;
					if (prefix.length >= 3 || prefix.includes("_") || context.explicit) {
						const opts = collectSchemaTableOptions(allDocs, prefix.toLowerCase());
						if (opts.length) {
							return {
								from: context.pos - prefix.length,
								to: context.pos,
								options: opts,
								validFor: /^[A-Za-z0-9_$]*$/,
							};
						}
					}
				}
			}
			return null;
		}

		// 0c. `/` Slash commands at start of line or after whitespace (outside code/URLs).
		const slashMatch = /(?:^|[ \t])\/([a-z0-9_-]*)$/i.exec(before);
		if (slashMatch && !insideBackticks(before.slice(0, slashMatch.index))) {
			const typed = slashMatch[1]!;
			const from = context.pos - typed.length - 1;
			const options: Completion[] = SLASH_COMMANDS.map((cmd, idx) => ({
				label: `/${cmd.name}`,
				detail: cmd.detail,
				type: "keyword",
				boost: 150 - idx,
				apply: (view, _completion, applyFrom, applyTo) => applySlashCommand(view, cmd, applyFrom, applyTo),
			}));
			return {
				from,
				to: context.pos,
				options,
				validFor: /^\/[a-z0-9_-]*$/i,
			};
		}

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
			const docOpts = nameChoices(allDocs.filter((f) => canonical(f.path) !== here), here, root, allDocs);
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
				const found = docByName(docName, allDocs, root);
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
			const files = allDocs.filter((f) => canonical(f.path) !== here);
			const choices = nameChoices(files, here, root, allDocs);
			const options: Completion[] = choices.map((choice, idx) => ({
				label: choice.label,
				detail: choice.detail,
				type: "file",
				boost: 1000 - idx,
				apply: closed ? choice.name : `${choice.name}]]`,
			}));
			return { from, to: context.pos + (closed ? rest : 0), options, validFor: /^[^[\]|#\n]*$/ };
		}

		// 4. Relative Markdown link completion: `](path` (docs first, then workspace `.ssl`/`.ds`/`.sql`/`.xfd` code files).
		const linkTyped = linkBeingWritten(before);
		if (linkTyped !== null && root) {
			const from = context.pos - linkTyped.length;
			const rest = /^[^()<>\s]*/.exec(after)![0].length;
			const files = allDocs.filter((f) => canonical(f.path) !== here);
			const choices = linkChoices(files, here, root);
			const docPathSet = new Set(files.map((f) => canonical(f.path)));
			const options: Completion[] = choices.map((choice, idx) => ({
				label: choice.label,
				detail: choice.detail,
				type: "file",
				boost: 1000 - Math.min(idx, 500),
				apply: choice.insert,
			}));
			const codeFiles = await listWorkspaceCodeFiles(root);
			const hereDir = dirName(here);
			let codeIdx = 0;
			for (const cf of codeFiles) {
				const canonCf = canonical(cf);
				if (canonCf === here || docPathSet.has(canonCf)) continue;
				const rel = relativeTo(root, cf).replace(/\\/g, "/");
				const insert = linkWritten(relativePath(hereDir, cf).replace(/\\/g, "/"));
				options.push({
					label: baseName(cf),
					detail: rel,
					type: "file",
					boost: 200 - Math.min(codeIdx++, 200),
					apply: insert,
				});
			}
			return { from, to: context.pos + rest, options, validFor: /^[^()<>\s]*$/ };
		}

		// 5. #tag completion from tags across this document + all workspace docs (skipping fenced code blocks & hex colors).
		const tagMatch = /(?:^|[\s(])#([A-Za-z][A-Za-z0-9_/-]*)$/.exec(before);
		if (tagMatch && !/^[ \t]{0,3}#/.test(before) && !insideBackticks(before.slice(0, tagMatch.index))) {
			const typed = tagMatch[1]!;
			const typedLower = typed.toLowerCase();
			const byLower = new Map<string, { tag: string; count: number }>();
			for (const bucket of workspaceTags(allDocs)) {
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

		// 6. STARLIMS domain completions: bare ticket keys (e.g. `DEMO-`) and documented schema tables (`DEMO_HOLIDAYS`).
		const domainOptions: Completion[] = [];
		let domainFrom = -1;
		let domainValid = /^[A-Za-z0-9_$-]*$/;

		const ticketMatch = /(?:^|[\s([{"'`])([A-Z][A-Z0-9]{1,11}-?[0-9]*)$/.exec(before);
		if (ticketMatch) {
			const typed = ticketMatch[1]!;
			if (typed.includes("-") || typed.length >= 3 || context.explicit) {
				const tOpts = collectTicketOptions(allDocs, typed, context.explicit);
				if (tOpts.length) {
					domainFrom = context.pos - typed.length;
					domainOptions.push(...tOpts);
				}
			}
		}

		const schemaWord = /(?:^|[\s([{"'`,])([A-Za-z_][\w$]{1,})$/.exec(before);
		if (schemaWord) {
			const prefix = schemaWord[1]!;
			if (prefix.includes("_") || prefix.length >= 3 || context.explicit) {
				const sOpts = collectSchemaTableOptions(allDocs, prefix.toLowerCase());
				if (sOpts.length) {
					const sFrom = context.pos - prefix.length;
					if (domainFrom < 0 || domainFrom === sFrom) {
						domainFrom = sFrom;
						domainOptions.push(...sOpts);
					}
				}
			}
		}

		if (domainOptions.length && domainFrom >= 0) {
			return {
				from: domainFrom,
				to: context.pos,
				options: domainOptions,
				validFor: domainValid,
			};
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

// --- Lightweight Popover Completion for Live Table, Callout & Inline YAML `<textarea>`s ---

export type TextareaCompletionItem = {
	label: string;
	detail?: string;
	insert: string;
};

export type TextareaCompletionMatch = {
	from: number;
	to: number;
	items: TextareaCompletionItem[];
};

const YAML_KEY_SUGGESTIONS: readonly [string, string][] = [
	["status", "Document / ticket status"],
	["ticket", "Primary ticket key"],
	["tickets", "Linked ticket keys"],
	["type", "Ticket type (Task, Story, Bug…)"],
	["summary", "One-line summary"],
	["tags", "Workspace tags list"],
	["parent", "Parent epic or ticket"],
	["related", "Related tickets"],
	["blocks", "Tickets blocked by this"],
	["blocked-by", "Blocking tickets"],
	["specs", "Linked spec paths"],
	["plans", "Linked plan paths"],
	["source", "Ticket URL or schema SQL path"],
	["date", "ISO date (YYYY-MM-DD)"],
	["asked", "Question asked date"],
	["answered", "Question answered date"],
	["supersedes", "Earlier ADR stem"],
	["superseded-by", "Newer ADR stem"],
	["with", "External interface system"],
	["direction", "in | out | both"],
	["version", "Document version"],
	["owner", "Document owner"],
	["reviewer", "Document reviewer"],
	["release", "Target release / sprint"],
	["priority", "Priority level"],
];

/** Pure completion resolver for Table cells, Callout bodies, and inline YAML `<textarea>` editors. */
export function computeTextareaCompletions(opts: {
	mode: "markdown" | "yaml";
	value: string;
	caret: number;
	filePath: string;
	explicit?: boolean;
	docs: readonly DocFile[];
	root?: string | null;
	listedDoc?: DocFile;
}): TextareaCompletionMatch | null {
	const { mode, value, caret, filePath, explicit = false, docs: allDocs, root, listedDoc } = opts;
	const lineStart = caret === 0 ? 0 : value.lastIndexOf("\n", caret - 1) + 1;
	const lineEndRaw = value.indexOf("\n", caret);
	const lineEnd = lineEndRaw < 0 ? value.length : lineEndRaw;
	const before = value.slice(lineStart, caret);
	const after = value.slice(caret, lineEnd);

	if (mode === "yaml") {
		// 1. YAML key name at start of line (no colon yet).
		const keyMatch = /^([ \t]*)([A-Za-z0-9_-]*)$/.exec(before);
		if (keyMatch && !after.includes(":") && (keyMatch[2]!.length > 0 || explicit)) {
			const typed = keyMatch[2]!.toLowerCase();
			const items = YAML_KEY_SUGGESTIONS.filter(([k]) => k.startsWith(typed) || k.includes(typed))
				.slice(0, 10)
				.map(([k, detail]) => ({ label: k, detail, insert: `${k}: ` }));
			if (items.length) return { from: caret - keyMatch[2]!.length, to: caret, items };
			return null;
		}

		// 2. YAML value position: either `key: val`, `key: [a, val`, or indented `- val` under `key:`.
		let yamlKey = "";
		let typedVal = "";
		const scalarOrFlow = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*:[ \t]*(?:\[[^\]\n]*,[ \t]*|\[[ \t]*)?([^,\][\s]*)$/.exec(before);
		if (scalarOrFlow) {
			yamlKey = scalarOrFlow[1]!.toLowerCase();
			typedVal = scalarOrFlow[2] ?? "";
		} else {
			const listItem = /^[ \t]*-[ \t]+([^\s]*)$/.exec(before);
			if (listItem) {
				typedVal = listItem[1] ?? "";
				const priorLines = value.slice(0, lineStart).split("\n");
				for (let i = priorLines.length - 1; i >= 0; i--) {
					const m = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*:/.exec(priorLines[i]!);
					if (m) {
						yamlKey = m[1]!.toLowerCase();
						break;
					}
					if (priorLines[i]!.trim() && !/^[ \t]*-/.test(priorLines[i]!)) break;
				}
			}
		}
		if (!yamlKey) return null;
		const typedLower = typedVal.toLowerCase();
		let candidates: TextareaCompletionItem[] = [];
		if (yamlKey === "status") {
			candidates = statusChoices(listedDoc).map((s) => ({ label: s, detail: "Status", insert: s }));
		} else if (["ticket", "tickets", "parent", "related", "blocks", "blocked-by"].includes(yamlKey)) {
			candidates = allDocs
				.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket)
				.map((d) => ({ label: d.ticket!, detail: d.title || d.status, insert: d.ticket! }));
		} else if (yamlKey === "tags" || yamlKey === "tag") {
			candidates = workspaceTags(allDocs).map((t) => ({
				label: t.tag,
				detail: t.count > 1 ? `${t.count} docs` : "tag",
				insert: t.tag,
			}));
		} else if (yamlKey === "direction") {
			candidates = ["in", "out", "both"].map((d) => ({ label: d, detail: "Direction", insert: d }));
		} else if (yamlKey === "type") {
			candidates = ["Task", "Story", "Bug", "Epic", "Sub-task"].map((t) => ({ label: t, detail: "Type", insert: t }));
		} else if (yamlKey === "priority") {
			candidates = ["high", "medium", "low", "critical"].map((p) => ({ label: p, detail: "Priority", insert: p }));
		} else if ((yamlKey === "specs" || yamlKey === "plans") && root) {
			const grp = yamlKey === "specs" ? "specs" : "plans";
			candidates = allDocs
				.filter((d) => d.exists && d.group === grp && !isCatalog(d))
				.map((d) => {
					const rel = relativeTo(root, d.path).replace(/\\/g, "/");
					return { label: d.title || baseName(d.path), detail: rel, insert: rel };
				});
		} else if (yamlKey === "supersedes" || yamlKey === "superseded-by") {
			candidates = allDocs
				.filter((d) => d.exists && d.group === "knowledge" && d.kind === "decisions")
				.map((d) => {
					const stem = baseName(d.path).replace(/\.(md|markdown)$/i, "");
					return { label: stem, detail: d.title || d.name, insert: stem };
				});
		} else if (yamlKey === "date" || yamlKey === "asked" || yamlKey === "answered") {
			const today = localDay();
			candidates = [{ label: today, detail: "Today", insert: today }];
		}

		const filtered = candidates
			.filter(
				(c) =>
					(!typedLower || c.label.toLowerCase().includes(typedLower) || c.insert.toLowerCase().includes(typedLower)) &&
					(explicit || c.insert.toLowerCase() !== typedLower),
			)
			.slice(0, 10);
		if (!filtered.length) return null;
		return { from: caret - typedVal.length, to: caret, items: filtered };
	}

	// Markdown widget mode (`TableWidget` cell / `CalloutWidget` body): `[[wikilinks`, `#tags`, and bare `TICKET-` keys.
	const here = canonical(filePath);
	const nameTyped = nameBeingWritten(before);
	if (nameTyped !== null && root) {
		const rest = /^[^[\]|#]*/.exec(after)![0].length;
		const closed = /^(?:[|#][^[\]]*)?\]\]/.test(after.slice(rest));
		const files = allDocs.filter((f) => canonical(f.path) !== here);
		const q = nameTyped.toLowerCase();
		const items = nameChoices(files, here, root, allDocs)
			.filter((c) => !q || c.label.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q))
			.slice(0, 10)
			.map((c) => ({ label: c.label, detail: c.detail, insert: closed ? c.name : `${c.name}]]` }));
		if (items.length) return { from: caret - nameTyped.length, to: caret + (closed ? rest : 0), items };
		return null;
	}

	const tagMatch = /(?:^|[\s(])#([A-Za-z][A-Za-z0-9_/-]*)$/.exec(before);
	if (tagMatch && !/^[ \t]{0,3}#/.test(before) && !insideBackticks(before.slice(0, tagMatch.index))) {
		const typed = tagMatch[1]!;
		if (isLikelyHexColorTag(typed)) return null;
		const q = typed.toLowerCase();
		const items = workspaceTags(allDocs)
			.filter((t) => t.tag.toLowerCase().includes(q) && (explicit || t.tag.toLowerCase() !== q))
			.slice(0, 10)
			.map((t) => ({ label: `#${t.tag}`, detail: t.count > 1 ? `${t.count} docs` : undefined, insert: t.tag }));
		if (items.length) return { from: caret - typed.length, to: caret, items };
		return null;
	}

	const ticketMatch = /(?:^|[\s([{"'`])([A-Z][A-Z0-9]{1,11}-?[0-9]*)$/.exec(before);
	if (ticketMatch) {
		const typed = ticketMatch[1]!;
		if (typed.includes("-") || typed.length >= 3 || explicit) {
			const upper = typed.toUpperCase();
			const items = allDocs
				.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket && d.ticket.toUpperCase().startsWith(upper) && (explicit || d.ticket.toUpperCase() !== upper))
				.slice(0, 8)
				.map((d) => ({ label: d.ticket!, detail: d.title || d.status, insert: d.ticket! }));
			if (items.length) return { from: caret - typed.length, to: caret, items };
		}
	}

	return null;
}

export type TextareaCompleter = {
	update: (explicit?: boolean) => void;
	handleKeyDown: (e: KeyboardEvent) => boolean;
	close: () => void;
	isOpen: () => boolean;
	dispose: () => void;
};

/**
 * Attaches a compact keyboard-accessible completion popover to a `<textarea>` (Table cell,
 * Callout body, or inline YAML editor). Call `handleKeyDown(e)` at the top of the textarea's
 * keydown listener, `update()` on input, and `close()` / `dispose()` on blur/teardown.
 */
export function createTextareaCompleter(
	ta: HTMLTextAreaElement,
	opts: {
		mode: "markdown" | "yaml";
		filePath: () => string;
		getListedDoc?: () => DocFile | undefined;
		onApply?: () => void;
	},
): TextareaCompleter {
	let popEl: HTMLDivElement | null = null;
	let current: TextareaCompletionMatch | null = null;
	let activeIdx = 0;

	const close = () => {
		current = null;
		activeIdx = 0;
		if (popEl) {
			popEl.remove();
			popEl = null;
		}
	};

	const applyItem = (item: TextareaCompletionItem) => {
		if (!current) return;
		const { from, to } = current;
		close();
		ta.setRangeText(item.insert, from, to, "end");
		const pos = from + item.insert.length;
		ta.setSelectionRange(pos, pos);
		opts.onApply?.();
	};

	const render = () => {
		if (!current || !current.items.length || !ta.isConnected || typeof document === "undefined") {
			close();
			return;
		}
		if (!popEl) {
			popEl = document.createElement("div");
			popEl.className = "cm-widget-ac";
			popEl.setAttribute("role", "listbox");
			Object.assign(popEl.style, {
				position: "fixed",
				zIndex: "58",
				minWidth: "200px",
				maxWidth: "360px",
				maxHeight: "210px",
				overflowY: "auto",
				padding: "4px",
				borderRadius: "var(--radius-md, 6px)",
				border: "1px solid var(--input-border, var(--border))",
				background: "var(--side-bg, var(--bg))",
				color: "var(--side-fg, var(--fg))",
				boxShadow: "var(--shadow, 0 8px 24px rgba(0,0,0,0.28))",
				fontFamily: "var(--ui-font, system-ui, sans-serif)",
				fontSize: "var(--text-sm, 12px)",
			});
			document.body.appendChild(popEl);
		}
		popEl.textContent = "";
		current.items.forEach((item, idx) => {
			const row = document.createElement("div");
			row.className = "cm-widget-ac-item";
			row.setAttribute("role", "option");
			row.setAttribute("aria-selected", idx === activeIdx ? "true" : "false");
			Object.assign(row.style, {
				display: "flex",
				alignItems: "baseline",
				gap: "8px",
				padding: "4px 8px",
				borderRadius: "var(--radius-sm, 4px)",
				cursor: "pointer",
				background: idx === activeIdx ? "var(--selected, rgba(128,128,128,0.22))" : "transparent",
				color: idx === activeIdx ? "var(--strong-fg, inherit)" : "inherit",
			});
			const lbl = document.createElement("span");
			lbl.textContent = item.label;
			lbl.style.fontWeight = "500";
			lbl.style.whiteSpace = "nowrap";
			row.appendChild(lbl);
			if (item.detail) {
				const det = document.createElement("span");
				det.textContent = item.detail;
				Object.assign(det.style, {
					marginLeft: "auto",
					fontSize: "11px",
					color: "var(--muted)",
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
				});
				row.appendChild(det);
			}
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				applyItem(item);
			});
			row.addEventListener("mouseenter", () => {
				if (activeIdx !== idx) {
					activeIdx = idx;
					render();
				}
			});
			popEl!.appendChild(row);
		});

		const rect = ta.getBoundingClientRect();
		const popW = Math.min(360, Math.max(220, rect.width));
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 8));
		const spaceBelow = window.innerHeight - rect.bottom;
		const top = spaceBelow >= 140 ? rect.bottom + 4 : Math.max(8, rect.top - Math.min(210, current.items.length * 28 + 12) - 4);
		popEl.style.left = `${left}px`;
		popEl.style.top = `${top}px`;
		popEl.style.minWidth = `${Math.min(popW, 240)}px`;
	};

	const update = (explicit = false) => {
		if (!ta.isConnected || ta.selectionStart !== ta.selectionEnd) {
			close();
			return;
		}
		const match = computeTextareaCompletions({
			mode: opts.mode,
			value: ta.value,
			caret: ta.selectionStart ?? 0,
			filePath: opts.filePath(),
			explicit,
			docs: docs(),
			root: state.workspace?.root,
			listedDoc: opts.getListedDoc?.(),
		});
		if (!match || !match.items.length) {
			close();
			return;
		}
		current = match;
		activeIdx = Math.min(activeIdx, match.items.length - 1);
		render();
	};

	const handleKeyDown = (e: KeyboardEvent): boolean => {
		if ((e.ctrlKey || e.metaKey) && e.code === "Space") {
			e.preventDefault();
			e.stopPropagation();
			update(true);
			return true;
		}
		if (!current || !current.items.length) return false;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			e.stopPropagation();
			activeIdx = (activeIdx + 1) % current.items.length;
			render();
			return true;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			e.stopPropagation();
			activeIdx = (activeIdx - 1 + current.items.length) % current.items.length;
			render();
			return true;
		}
		if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			e.stopPropagation();
			const picked = current.items[activeIdx];
			if (picked) applyItem(picked);
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
			return true;
		}
		return false;
	};

	return {
		update,
		handleKeyDown,
		close,
		isOpen: () => Boolean(current && current.items.length),
		dispose: close,
	};
}
