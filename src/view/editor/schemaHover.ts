// Secondary Monaco Hover, Definition, Link, Completion, and CodeLens providers bridging
// SSL/SQL/Markdown/XML/JSON code to documented `schema/` tables/columns, workspace tickets,
// governing plans/ADRs/questions, and comment doc references (ADR 0003: matches identifiers
// strictly against workspace docs, DDL, and starlims-lsp symbols, never parsing SSL: which word is a
// keyword or a name being declared, and where the comments are, is the language server's to say).
import { createEffect, createMemo, createRoot, runWithOwner } from "solid-js";
import { findCodeCitations, type CodeCitation } from "../../shared/codeCitations";
import { parseCsv } from "../../shared/csv";
import { linkBeingWritten } from "../../shared/docLinks";
import { findHeadingLine } from "../../shared/markdownEdit";
import { nameBeingWritten, nameFor } from "../../shared/namedLinks";
import { baseName, dirName, isInside, joinPath, relativeTo, resolvePath } from "../../shared/paths";
import { isCatalog, registryTitle, toneOf } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import {
	extractSchemaColumns,
	extractSchemaPreview,
	findSchemaDocForIdentifier,
	hasSchemaTables,
	referencedSchemaTables,
	schemaDocKeys,
	type SchemaColumnInfo,
} from "../../shared/schemaIndex";
import { ticketMatcher } from "../../shared/ticketRefs";
import { isSslOwnWord, namesByLine, NO_FACTS } from "../../shared/lexicalTokens";
import { codeMatchesRef, docsGoverningFile } from "../../shared/workContext";
import { backend } from "../backend";
import { quickPick, type QuickPickOption } from "../dialogs";
import { docAuditData } from "../docAudit";
import { searchableText, sslFacts } from "../lsp/facts";
import { session } from "../lsp/session";
import { symbols } from "../panels/Objects";
import { docs, isMarkdown } from "../project";
import { activeDoc, activePath, canonical, documents, notify, openFile, state } from "../state";
import { activeEditor } from "./EditorGroup";
import { activeLiveEditor } from "./liveBridge";
import { monaco } from "./monaco";
import { sslCommentSpans } from "./textmate";

const REF_SCHEME = "ssl-studio-schema-ref";
const CODELENS_OPEN_CMD = "ssl-studio.openCodeLensTarget";

type RefTarget = { file: string; line?: number; endLine?: number; heading?: string };

const refUri = (target: string | RefTarget) => {
	const payload: RefTarget = typeof target === "string" ? { file: target } : target;
	return monaco.Uri.from({ scheme: REF_SCHEME, path: "/", query: JSON.stringify(payload) });
};

import { extractCommentSpans, findCommentDocRefsInLines, findCommentDocRefsInSpans, type CommentDocRef, type CommentSpan } from "../../shared/editorDocHelpers";
export { extractCommentSpans, findCommentDocRefsInLines, type CommentDocRef, type CommentSpan };

const SQL_RESERVED_KEYWORDS = new Set([
	"select",
	"from",
	"where",
	"insert",
	"into",
	"values",
	"update",
	"set",
	"delete",
	"create",
	"alter",
	"drop",
	"table",
	"view",
	"index",
	"trigger",
	"procedure",
	"function",
	"join",
	"inner",
	"left",
	"right",
	"full",
	"outer",
	"cross",
	"using",
	"group",
	"order",
	"having",
	"union",
	"all",
	"distinct",
	"and",
	"not",
	"null",
	"between",
	"like",
	"exists",
	"case",
	"when",
	"then",
	"else",
	"end",
	"asc",
	"desc",
	"top",
	"limit",
	"offset",
	"fetch",
	"next",
	"rows",
	"only",
	"begin",
	"commit",
	"rollback",
	"transaction",
	"declare",
	"exec",
	"execute",
	"return",
	"with",
	"grant",
	"revoke",
	"primary",
	"foreign",
	"key",
	"references",
	"default",
	"check",
	"constraint",
	"unique",
	"cast",
	"convert",
	"coalesce",
	"count",
	"sum",
	"avg",
	"min",
	"max",
	"true",
	"false",
	"for",
	"while",
	"elseif",
	"endif",
]);

/**
 * Derives comment spans per line: for SSL strictly from the canonical SSL TextMate
 * grammar (`textmate.ts` COMMENT_TOKEN, ADR 0003), and for SQL via `extractCommentSpans`.
 */
function commentSpansFor(lines: readonly string[], lang: "ssl" | "sql"): CommentSpan[][] {
	if (lang === "ssl") return sslCommentSpans(lines) ?? lines.map(() => []);
	return extractCommentSpans(lines);
}

function findCommentDocRefsFor(
	lines: readonly string[],
	lang: "ssl" | "sql",
	files: readonly DocFile[],
	root?: string | null,
	precomputedSpans?: CommentSpan[][],
): CommentDocRef[] {
	if (lang === "sql" && !precomputedSpans) return findCommentDocRefsInLines(lines, files, root);
	return findCommentDocRefsInSpans(lines, precomputedSpans ?? commentSpansFor(lines, lang), files, root);
}

function findCommentDocRefAt(
	model: monaco.editor.ITextModel,
	position: monaco.Position,
	lang: "ssl" | "sql",
	files: readonly DocFile[],
	root?: string | null,
): CommentDocRef | null {
	const lineNum = position.lineNumber;
	const scanCount = Math.min(lineNum, model.getLineCount());
	if (scanCount > 5000) return null;
	const lines: string[] = [];
	for (let i = 1; i <= scanCount; i++) lines.push(model.getLineContent(i));
	const spans = commentSpansFor(lines, lang)[lineNum - 1];
	if (!spans?.length) return null;
	const offset = position.column - 1;
	if (!spans.some((s) => offset >= s.from && offset <= s.to)) return null;
	const refs = findCommentDocRefsFor(
		lines,
		lang,
		files,
		root,
		lines.map((_, idx) => (idx === lineNum - 1 ? spans : [])),
	);
	return refs.find((r) => r.line === lineNum && offset >= r.from && offset <= r.to) ?? null;
}

const previewCache = new Map<string, { ver: string; value: string }>();
const columnCache = new Map<string, { ver: string; value: SchemaColumnInfo[] }>();
const citationCache = new Map<string, { version: string; citations: CodeCitation[] }>();
const modelSymbolCache = new Map<string, { version: number; symbols: monaco.languages.DocumentSymbol[] }>();

/**
 * Fetches starlims-lsp DocumentSymbols for any open SSL model (including non-active Split Editor panes),
 * cached per canonical path + model versionId (ADR 0003: zero SSL parsing in the IDE).
 */
async function documentSymbolsForModel(model: monaco.editor.ITextModel): Promise<monaco.languages.DocumentSymbol[]> {
	if (model.isDisposed() || model.uri.scheme !== "file" || model.getLanguageId() !== "ssl") return [];
	const filePath = canonical(model.uri.fsPath);
	if (filePath === canonical(activePath() ?? "")) {
		const activeSyms = symbols();
		if (activeSyms.length) return activeSyms;
	}
	const version = model.getVersionId();
	const hit = modelSymbolCache.get(filePath);
	if (hit && hit.version === version) return hit.symbols;
	if (state.lsp.state !== "running") return [];
	let list: monaco.languages.DocumentSymbol[];
	try {
		list = await session.documentSymbols(model);
	} catch {
		return [];
	}
	if (!model.isDisposed() && model.getVersionId() === version) {
		if (modelSymbolCache.has(filePath)) modelSymbolCache.delete(filePath);
		else if (modelSymbolCache.size >= 64) modelSymbolCache.delete(modelSymbolCache.keys().next().value!);
		modelSymbolCache.set(filePath, { version, symbols: list });
	}
	return list;
}

type ParsedPlanSummary = {
	title: string;
	nodeById: Map<string, { id: string; text: string; kind?: string; ref?: string }>;
	units: { name: string; script?: string; nodes: string[] }[];
	targetProcedures: { script: string; procedures: string[] }[];
	callNodes: { id: string; text: string; ref: string }[];
};
const planCache = new Map<string, { version: string; data: ParsedPlanSummary | null }>();

async function readDocText(docPath: string): Promise<string> {
	const open = documents.get(canonical(docPath));
	if (open) return open.model.getValue();
	return backend.read(docPath).then((r) => (r.binary ? "" : r.text), () => "");
}

function docVersionStamp(docPath: string): string {
	const ver = state.treeVersion;
	const open = documents.get(canonical(docPath));
	return open ? `${ver}:open:${open.model.getAlternativeVersionId()}` : `${ver}:disk`;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMentionsAny(text: string, keys: readonly string[]): boolean {
	if (!text || !keys.length) return false;
	for (const k of keys) {
		if (k.length < 3) continue;
		const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(k)}(?![A-Za-z0-9_])`, "i");
		if (re.test(text)) return true;
	}
	return false;
}

async function loadPlanSummary(planDoc: DocFile): Promise<ParsedPlanSummary | null> {
	const verStr = docVersionStamp(planDoc.path);
	const hit = planCache.get(planDoc.path);
	if (hit && hit.version === verStr) return hit.data;
	const raw = await readDocText(planDoc.path);
	let data: ParsedPlanSummary | null = null;
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as {
				title?: string;
				nodes?: { id?: string; text?: string; kind?: string; ref?: string }[];
				targets?: (string | { script?: string; path?: string; procedures?: string[] })[];
				built?: { units?: { name?: string; script?: string; nodes?: string[] }[] };
			};
			const nodeById = new Map<string, { id: string; text: string; kind?: string; ref?: string }>();
			const callNodes: { id: string; text: string; ref: string }[] = [];
			for (const n of parsed.nodes ?? []) {
				if (!n?.id || !n?.text) continue;
				nodeById.set(n.id, { id: n.id, text: n.text, kind: n.kind, ref: n.ref });
				if (n.ref) callNodes.push({ id: n.id, text: n.text, ref: n.ref });
			}
			const units: { name: string; script?: string; nodes: string[] }[] = [];
			for (const u of parsed.built?.units ?? []) {
				if (!u?.name) continue;
				units.push({
					name: u.name,
					script: u.script,
					nodes: Array.isArray(u.nodes) ? u.nodes.filter((x): x is string => typeof x === "string") : [],
				});
			}
			const targetProcedures: { script: string; procedures: string[] }[] = [];
			for (const t of parsed.targets ?? []) {
				if (typeof t === "object" && t && Array.isArray(t.procedures) && t.procedures.length) {
					targetProcedures.push({ script: t.script ?? t.path ?? "", procedures: t.procedures.filter((p): p is string => typeof p === "string") });
				}
			}
			data = { title: parsed.title || planDoc.title || planDoc.name, nodeById, units, targetProcedures, callNodes };
		} catch {
			data = null;
		}
	}
	if (planCache.size > 60) planCache.delete(planCache.keys().next().value!);
	planCache.set(planDoc.path, { version: verStr, data });
	return data;
}

async function loadDocCitations(docPath: string): Promise<CodeCitation[]> {
	const verStr = docVersionStamp(docPath);
	const hit = citationCache.get(docPath);
	if (hit && hit.version === verStr) return hit.citations;
	const text = await readDocText(docPath);
	const citations = text ? findCodeCitations(text) : [];
	if (citationCache.size > 120) citationCache.delete(citationCache.keys().next().value!);
	citationCache.set(docPath, { version: verStr, citations });
	return citations;
}

function citationTargetsFile(docPath: string, cit: CodeCitation, targetFile: string, wsRoot?: string | null): boolean {
	if (!cit.file) return false;
	const cleanTarget = canonical(targetFile);
	if (wsRoot) {
		const resolved = cit.file.startsWith("/")
			? joinPath(wsRoot, ...cit.file.split("/").filter(Boolean))
			: resolvePath(dirName(docPath), cit.file);
		if (isInside(wsRoot, resolved) && canonical(resolved) === cleanTarget) return true;
	}
	return codeMatchesRef(targetFile, cit.file, wsRoot);
}

async function loadRegistryRowsForTable(tableKeys: readonly string[], allDocs: readonly DocFile[]): Promise<string[]> {
	if (!tableKeys.length) return [];
	const regs = allDocs.filter((d) => d.exists && d.group === "registries" && !isCatalog(d) && /\.(csv|tsv)$/i.test(d.name));
	if (!regs.length) return [];
	const keySet = new Set(tableKeys.map((k) => k.toLowerCase()));
	const lines: string[] = [];
	for (const reg of regs) {
		if (lines.length >= 4) break;
		const csvText = await readDocText(reg.path);
		if (!csvText) continue;
		const parsed = parseCsv(csvText);
		const headers = parsed.header.map((c) => c.text.trim().toLowerCase());
		const statusIdx = headers.findIndex((h) => h === "status" || h === "state");
		const ticketIdx = headers.findIndex((h) => h === "ticket" || h === "tickets");
		const kindIdx = headers.findIndex((h) => h === "kind" || h === "type");
		for (const row of parsed.rows) {
			if (lines.length >= 4) break;
			const first = (row[0]?.text ?? "").trim();
			const bareFirst = first.includes(".") ? first.split(".").pop()!.trim() : first;
			const exactFirst = keySet.has(first.toLowerCase()) || keySet.has(bareFirst.toLowerCase());
			const anyCell = exactFirst || row.some((c) => textMentionsAny(c.text, tableKeys));
			if (!anyCell) continue;
			const meta = [
				kindIdx >= 0 ? row[kindIdx]?.text.trim() : "",
				statusIdx >= 0 ? row[statusIdx]?.text.trim() : "",
				ticketIdx >= 0 ? row[ticketIdx]?.text.trim() : "",
			]
				.filter(Boolean)
				.join(" · ");
			const rowLabel = first || row.map((c) => c.text.trim()).filter(Boolean).slice(0, 2).join(" — ");
			lines.push(`- **${registryTitle(reg.name)}** (\`${reg.name}\`): \`${rowLabel}\`${meta ? ` (${meta})` : ""}`);
		}
	}
	return lines;
}

async function loadSchemaMarkdown(docPath: string, doc: DocFile): Promise<string> {
	const allDocs = docs();
	const openRegs = allDocs
		.filter((d) => d.exists && d.group === "registries" && !isCatalog(d) && /\.(csv|tsv)$/i.test(d.name))
		.map((d) => {
			const open = documents.get(canonical(d.path));
			return open ? `${d.path}@${open.model.getAlternativeVersionId()}` : "";
		})
		.filter(Boolean)
		.join("|");
	const cacheVer = `${docVersionStamp(docPath)}:${allDocs.length}:${openRegs}`;
	const hit = previewCache.get(docPath);
	if (hit && hit.ver === cacheVer) return hit.value;
	const text = await readDocText(docPath);
	const preview = text ? extractSchemaPreview(doc, text, 12) : doc.summary || "";
	const rel = state.workspace?.root ? relativeTo(state.workspace.root, docPath).replace(/\\/g, "/") : doc.name;

	// Enrich with governing ADRs/decisions, open questions, and registry rows referencing this table.
	const tableKeys = schemaDocKeys(doc).filter((k) => k.length >= 3);
	const docTickets = new Set((doc.tickets ?? []).map((t) => t.toLowerCase()));
	const matchesTableDoc = (d: DocFile) => {
		const hay = [d.title ?? "", d.summary ?? "", d.name, ...(d.codeRefs ?? [])].join(" ");
		if (textMentionsAny(hay, tableKeys)) return true;
		if (docTickets.size && d.tickets?.some((t) => docTickets.has(t.toLowerCase()))) return true;
		return false;
	};
	const decisions = allDocs
		.filter((d) => d.exists && !isCatalog(d) && d.group === "knowledge" && d.kind === "decisions" && matchesTableDoc(d))
		.slice(0, 3);
	const openQuestions = allDocs
		.filter((d) => d.exists && !isCatalog(d) && d.group === "knowledge" && d.kind === "questions" && toneOf(d.status) === "waiting" && matchesTableDoc(d))
		.slice(0, 3);
	const regRows = await loadRegistryRowsForTable(tableKeys, allDocs);

	const extra: string[] = [];
	if (decisions.length) {
		extra.push(
			"",
			"**Governing decisions:**",
			...decisions.map((d) => `- ${d.title || d.name}${d.status ? ` (${d.status})` : ""}`),
		);
	}
	if (openQuestions.length) {
		extra.push(
			"",
			"**Open questions:**",
			...openQuestions.map((d) => `- ${d.title || d.name}${d.status ? ` (${d.status})` : ""}`),
		);
	}
	if (regRows.length) {
		extra.push("", "**Registry entries:**", ...regRows);
	}

	const markdown = [
		`**Schema: ${doc.title || doc.name}** (\`${rel}\`)`,
		...(preview ? ["", preview] : []),
		...extra,
		"",
		"*Ctrl+Click or F12 to jump directly to this schema doc.*",
	].join("\n");
	if (previewCache.has(docPath)) previewCache.delete(docPath);
	else if (previewCache.size >= 120) previewCache.delete(previewCache.keys().next().value!);
	previewCache.set(docPath, { ver: cacheVer, value: markdown });
	return markdown;
}

async function loadColumnsForDoc(doc: DocFile): Promise<SchemaColumnInfo[]> {
	const cacheVer = docVersionStamp(doc.path);
	const hit = columnCache.get(doc.path);
	if (hit && hit.ver === cacheVer) return hit.value;
	const text = await readDocText(doc.path);
	const columns = text ? extractSchemaColumns(doc, text) : [];
	if (columnCache.has(doc.path)) columnCache.delete(doc.path);
	else if (columnCache.size >= 120) columnCache.delete(columnCache.keys().next().value!);
	columnCache.set(doc.path, { ver: cacheVer, value: columns });
	return columns;
}

let cachedTicketSource: readonly DocFile[] | null = null;
let cachedTicketMap = new Map<string, DocFile>();
let cachedTicketMatch: (text: string) => { from: number; to: number; key: string }[] = () => [];

function ticketIndex() {
	const all = docs();
	if (all !== cachedTicketSource) {
		cachedTicketSource = all;
		cachedTicketMap = new Map();
		const keys: string[] = [];
		for (const d of all) {
			if (!d.exists || d.group !== "tickets" || isCatalog(d) || !d.ticket) continue;
			cachedTicketMap.set(d.ticket.toLowerCase(), d);
			keys.push(d.ticket);
		}
		cachedTicketMatch = ticketMatcher(keys);
	}
	return { map: cachedTicketMap, match: cachedTicketMatch };
}

function findTicketAtPosition(lineText: string, column: number): { doc: DocFile; startColumn: number; endColumn: number } | null {
	const { map, match } = ticketIndex();
	const offset = column - 1;
	for (const m of match(lineText)) {
		if (offset >= m.from && offset <= m.to) {
			const doc = map.get(m.key.toLowerCase());
			if (doc) return { doc, startColumn: m.from + 1, endColumn: m.to + 1 };
		}
	}
	return null;
}

function ticketHoverMarkdown(doc: DocFile): string {
	const rel = state.workspace?.root ? relativeTo(state.workspace.root, doc.path).replace(/\\/g, "/") : doc.name;
	const meta = [
		doc.status ? `Status: **${doc.status}**` : "",
		doc.parent ? `Parent: \`${doc.parent}\`` : "",
		doc.tasks && doc.tasks.total > 0 ? `Checklist: ${doc.tasks.done}/${doc.tasks.total}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return [
		`**${doc.ticket}${doc.title ? `: ${doc.title}` : ""}** (\`${rel}\`)`,
		...(meta ? ["", meta] : []),
		...(doc.summary ? ["", doc.summary] : []),
	].join("\n");
}

function docRefHoverMarkdown(ref: CommentDocRef): string {
	const d = ref.doc;
	const rel = state.workspace?.root ? relativeTo(state.workspace.root, d.path).replace(/\\/g, "/") : d.name;
	const title = d.ticket && d.title && !d.title.startsWith(d.ticket) ? `${d.ticket}: ${d.title}` : d.title || d.heading || d.name;
	const meta = [d.group, d.status ? `status: ${d.status}` : "", ref.heading ? `#${ref.heading}` : "", ref.targetLine ? `line ${ref.targetLine}` : ""]
		.filter(Boolean)
		.join(" · ");
	return [
		`**${title}** (\`${rel}\`)`,
		...(meta ? ["", meta] : []),
		...(d.summary ? ["", d.summary] : []),
		"",
		"*Ctrl+Click or F12 to open this document.*",
	].join("\n");
}

function columnHoverMarkdown(matches: readonly SchemaColumnInfo[]): string {
	const lines: string[] = [];
	for (const col of matches.slice(0, 4)) {
		const rel = state.workspace?.root ? relativeTo(state.workspace.root, col.docPath).replace(/\\/g, "/") : col.docPath;
		const sig = [col.type ? `\`${col.type}\`` : "", col.constraints && col.constraints !== "—" ? col.constraints : ""].filter(Boolean).join(" — ");
		lines.push(`**${col.table}.${col.name}**${sig ? ` (${sig})` : ""}`);
		if (col.notes) lines.push(col.notes);
		lines.push(`*From \`${rel}\`*`);
		lines.push("");
	}
	return lines.join("\n").trim();
}

function qualifierBeforeWord(line: string, wordStartCol: number): string | null {
	const before = line.slice(0, Math.max(0, wordStartCol - 1));
	const m = /(?:^|[^\w$])([A-Za-z_][\w$]*)\.\s*$/.exec(before);
	return m ? m[1]! : null;
}

const PROC_SYMBOL_KINDS = new Set([
	monaco.languages.SymbolKind.Function,
	monaco.languages.SymbolKind.Method,
]);

const HOVER_SYMBOL_KINDS = new Set([
	monaco.languages.SymbolKind.Function,
	monaco.languages.SymbolKind.Method,
	monaco.languages.SymbolKind.Class,
	monaco.languages.SymbolKind.Namespace,
]);

function flattenSymbols(list: readonly monaco.languages.DocumentSymbol[], kinds: ReadonlySet<number>): monaco.languages.DocumentSymbol[] {
	const out: monaco.languages.DocumentSymbol[] = [];
	const walk = (items: readonly monaco.languages.DocumentSymbol[]) => {
		for (const s of items) {
			if (kinds.has(s.kind)) out.push(s);
			if (s.children?.length) walk(s.children);
		}
	};
	walk(list);
	return out;
}

type PlanProcMatch = { planDoc: DocFile; planTitle: string; steps: string[] };

async function planMatchesForProcedure(
	filePath: string,
	procName: string,
	allDocs: readonly DocFile[],
	wsRoot?: string | null,
): Promise<PlanProcMatch[]> {
	const procLower = procName.toLowerCase();
	const gov = docsGoverningFile(allDocs, filePath, wsRoot);
	const planDocs = gov.filter((g) => g.file.group === "plans" && /\.plan\.json$/i.test(g.file.name)).map((g) => g.file);
	if (!planDocs.length) return [];

	const matches: PlanProcMatch[] = [];
	for (const planDoc of planDocs) {
		const summary = await loadPlanSummary(planDoc);
		if (!summary) continue;
		const stepSet = new Set<string>();
		let matched = false;
		for (const unit of summary.units) {
			if (unit.name.toLowerCase() !== procLower) continue;
			if (unit.script && !codeMatchesRef(filePath, unit.script, wsRoot)) continue;
			matched = true;
			for (const id of unit.nodes) {
				const node = summary.nodeById.get(id);
				if (node?.text) stepSet.add(node.text);
			}
		}
		for (const target of summary.targetProcedures) {
			if (target.script && !codeMatchesRef(filePath, target.script, wsRoot)) continue;
			if (target.procedures.some((p) => p.toLowerCase() === procLower)) matched = true;
		}
		for (const call of summary.callNodes) {
			const tail = call.ref.split(".").pop()?.toLowerCase() ?? "";
			if (tail === procLower || call.ref.toLowerCase() === procLower) {
				matched = true;
				stepSet.add(call.text);
			}
		}
		if (matched) {
			matches.push({ planDoc, planTitle: summary.title, steps: [...stepSet].slice(0, 4) });
		}
	}
	return matches;
}

async function buildProcedureHoverMarkdown(
	model: monaco.editor.ITextModel,
	filePath: string,
	word: string,
	lineNumber: number,
	allDocs: readonly DocFile[],
	wsRoot?: string | null,
): Promise<string | null> {
	const rawSyms = await documentSymbolsForModel(model);
	const fileSyms = flattenSymbols(rawSyms, HOVER_SYMBOL_KINDS);
	const wordLower = word.toLowerCase();
	const matchedSym =
		fileSyms.find((s) => s.selectionRange.startLineNumber === lineNumber && s.name.toLowerCase() === wordLower) ??
		fileSyms.find((s) => s.name.toLowerCase() === wordLower);

	const planMatches = await planMatchesForProcedure(filePath, word, allDocs, wsRoot);
	if (!matchedSym && !planMatches.length) return null;

	const gov = docsGoverningFile(allDocs, filePath, wsRoot);
	const wordRe = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(word)}(?![A-Za-z0-9_])`, "i");
	const specificDecisions = allDocs.filter(
		(d) =>
			d.exists &&
			!isCatalog(d) &&
			d.group === "knowledge" &&
			d.kind === "decisions" &&
			(gov.some((g) => g.file === d) || wordRe.test([d.title ?? "", d.summary ?? "", ...(d.codeRefs ?? [])].join(" "))),
	);
	const openQuestions = allDocs.filter(
		(d) =>
			d.exists &&
			!isCatalog(d) &&
			d.group === "knowledge" &&
			d.kind === "questions" &&
			toneOf(d.status) === "waiting" &&
			(gov.some((g) => g.file === d) || wordRe.test([d.title ?? "", d.summary ?? "", ...(d.codeRefs ?? [])].join(" "))),
	);
	const govPrimary = gov.filter((g) => g.file.group === "tickets" || g.file.group === "specs" || g.file.group === "plans");

	// Check drifted/active #L citations covering this procedure's line range.
	const citationLines: string[] = [];
	if (matchedSym) {
		const startL = matchedSym.range.startLineNumber;
		const endL = matchedSym.range.endLineNumber;
		for (const issue of docAuditData().citationIssues ?? []) {
			if (canonical(issue.targetPath) !== canonical(filePath)) continue;
			if (issue.citation.from <= endL && issue.citation.to >= startL) {
				const relDoc = wsRoot ? relativeTo(wsRoot, issue.docPath).replace(/\\/g, "/") : issue.docPath;
				citationLines.push(`- Citation (${issue.kind}): \`${relDoc}\` line ${issue.docLine}`);
			}
		}
	}

	if (!planMatches.length && !specificDecisions.length && !openQuestions.length && !govPrimary.length && !citationLines.length) {
		return null;
	}

	const lines: string[] = [`**Governed symbol: \`${matchedSym?.name ?? word}\`**`];
	if (planMatches.length) {
		lines.push("", "**Plan steps:**");
		for (const pm of planMatches.slice(0, 3)) {
			const stepText = pm.steps.length ? `: ${pm.steps.join(" · ")}` : "";
			lines.push(`- **${pm.planTitle}**${stepText}`);
		}
	}
	if (specificDecisions.length) {
		lines.push("", "**Decisions:**");
		for (const d of specificDecisions.slice(0, 3)) {
			lines.push(`- ${d.title || d.name}${d.status ? ` (${d.status})` : ""}`);
		}
	}
	if (openQuestions.length) {
		lines.push("", "**Open questions:**");
		for (const q of openQuestions.slice(0, 3)) {
			lines.push(`- ${q.title || q.name}${q.status ? ` (${q.status})` : ""}`);
		}
	}
	if (govPrimary.length) {
		const labels = govPrimary.slice(0, 4).map((g) => {
			const d = g.file;
			return d.ticket && d.title && !d.title.startsWith(d.ticket) ? `**${d.ticket}**: ${d.title}` : `**${d.title || d.name}** (${g.reason})`;
		});
		lines.push("", `**Governing docs:** ${labels.join(" · ")}`);
	}
	if (citationLines.length) {
		lines.push("", ...citationLines.slice(0, 3));
	}
	return lines.join("\n");
}

async function definitionLocation(path: string, line = 1): Promise<monaco.languages.Location> {
	const uri = monaco.Uri.file(path);
	await session.ensureModel(uri.toString());
	return { uri, range: new monaco.Range(line, 1, line, 1) };
}

let registered = false;

/** Registers secondary schema/ticket/doc Hover, Definition, Link, Completion & CodeLens providers (runs beside starlims-lsp). */
export function registerSchemaHoverProviders(): void {
	if (registered) return;
	registered = true;

	monaco.editor.registerLinkOpener({
		open(resource) {
			if (resource.scheme !== REF_SCHEME) return false;
			try {
				const place = JSON.parse(resource.query) as RefTarget;
				if (!place.file) return true;
				if (place.line) {
					void openFile(place.file, { reveal: { line: place.line, ...(place.endLine ? { endLine: place.endLine } : {}) } });
				} else if (place.heading) {
					void readDocText(place.file).then((text) => {
						const line = text ? findHeadingLine(text, place.heading!) : null;
						void openFile(place.file, line ? { reveal: { line } } : {});
					});
				} else {
					void openFile(place.file);
				}
			} catch {
				// Ignore malformed internal link.
			}
			return true;
		},
	});

	monaco.editor.registerCommand(CODELENS_OPEN_CMD, (_accessor, target?: RefTarget) => {
		if (!target?.file) return;
		if (target.line) {
			void openFile(target.file, { reveal: { line: target.line, ...(target.endLine ? { endLine: target.endLine } : {}) } });
		} else {
			void openFile(target.file);
		}
	});

	// Hover, Definition, and Completion across SSL, SQL, and Markdown (specs documenting TABLE.COLUMN).
	for (const lang of ["ssl", "sql", "markdown"] as const) {
		monaco.languages.registerHoverProvider(lang, {
			async provideHover(model, position) {
				const lineText = model.getLineContent(position.lineNumber);
				const allDocs = docs();
				const wsRoot = state.workspace?.root;

				// 0. Comment doc-path / [[wikilink]] hover in SSL & SQL
				if (lang === "ssl" || lang === "sql") {
					const commentRef = findCommentDocRefAt(model, position, lang, allDocs, wsRoot);
					if (commentRef) {
						return {
							range: new monaco.Range(position.lineNumber, commentRef.from + 1, position.lineNumber, commentRef.to + 1),
							contents: [{ value: docRefHoverMarkdown(commentRef) }],
						};
					}
				}

				const ticketHit = findTicketAtPosition(lineText, position.column);
				if (ticketHit) {
					return {
						range: new monaco.Range(position.lineNumber, ticketHit.startColumn, position.lineNumber, ticketHit.endColumn),
						contents: [{ value: ticketHoverMarkdown(ticketHit.doc) }],
					};
				}
				const word = model.getWordAtPosition(position);
				if (!word || word.word.length < 2) return null;
				const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

				// 1. Qualified `TABLE.COLUMN` hover
				const qualifier = qualifierBeforeWord(lineText, word.startColumn);
				if (qualifier) {
					const tableDoc = findSchemaDocForIdentifier(qualifier, allDocs);
					if (tableDoc) {
						const cols = await loadColumnsForDoc(tableDoc);
						const qLower = qualifier.toLowerCase();
						const colLower = word.word.toLowerCase();
						const exact = cols.filter(
							(c) => c.name.toLowerCase() === colLower && (c.table.toLowerCase() === qLower || c.table.toLowerCase().endsWith(`.${qLower}`)),
						);
						const hits = exact.length ? exact : cols.filter((c) => c.name.toLowerCase() === colLower);
						if (hits.length) return { range, contents: [{ value: columnHoverMarkdown(hits) }] };
					}
				}

				// 2. SSL procedure / symbol hover BEFORE unscoped bare table/column matches so governed SSL
				// symbols are not shadowed by common column/table names (ID, STATUS, NAME, etc.).
				if (lang === "ssl" && model.uri.scheme === "file") {
					const procMd = await buildProcedureHoverMarkdown(model, canonical(model.uri.fsPath), word.word, position.lineNumber, allDocs, wsRoot);
					if (procMd) return { range, contents: [{ value: procMd }] };
				}

				const wordLower = word.word.toLowerCase();
				// What is left is a table's or a column's hover. A project that describes no table has neither, and the
				// server is not asked about the word. Where it does: a keyword, a member, or a name its statement declares
				// is the language's own, whatever table is called the same.
				if (SQL_RESERVED_KEYWORDS.has(wordLower) || !hasSchemaTables(allDocs) || (lang === "ssl" && isSslOwnWord(await sslFacts(model), position.lineNumber - 1, word.startColumn - 1))) {
					return null;
				}

				// 3. Documented schema table hover (enriched with governing decisions, open questions & registry rows)
				const tableDoc = findSchemaDocForIdentifier(word.word, allDocs);
				if (tableDoc) {
					const value = await loadSchemaMarkdown(tableDoc.path, tableDoc);
					return { range, contents: [{ value }] };
				}

				// 4. Column hover for tables referenced elsewhere in this file. Not for a document closed while the tables were read.
				if (model.isDisposed()) return null;
				if (model.getValueLength() <= 200_000) {
					const refTables = referencedSchemaTables(await searchableText(model), allDocs, 8);
					if (refTables.length) {
						const matches: SchemaColumnInfo[] = [];
						for (const refDoc of refTables) {
							const cols = await loadColumnsForDoc(refDoc);
							for (const col of cols) {
								if (col.name.toLowerCase() === wordLower) matches.push(col);
							}
						}
						if (matches.length) return { range, contents: [{ value: columnHoverMarkdown(matches) }] };
					}
				}

				return null;
			},
		});

		monaco.languages.registerDefinitionProvider(lang, {
			async provideDefinition(model, position) {
				const lineText = model.getLineContent(position.lineNumber);
				const allDocs = docs();
				const wsRoot = state.workspace?.root;

				// 0. Comment doc-path / [[wikilink]] jump in SSL & SQL
				if (lang === "ssl" || lang === "sql") {
					const commentRef = findCommentDocRefAt(model, position, lang, allDocs, wsRoot);
					if (commentRef) {
						let targetLine = commentRef.targetLine ?? 1;
						if (!commentRef.targetLine && commentRef.heading) {
							const text = await readDocText(commentRef.doc.path);
							const found = text ? findHeadingLine(text, commentRef.heading) : null;
							if (found) targetLine = found;
						}
						return definitionLocation(commentRef.doc.path, targetLine);
					}
				}

				const ticketHit = findTicketAtPosition(lineText, position.column);
				if (ticketHit) {
					return definitionLocation(ticketHit.doc.path, 1);
				}
				const word = model.getWordAtPosition(position);
				if (!word || word.word.length < 2) return null;
				const qualifier = qualifierBeforeWord(lineText, word.startColumn);
				if (qualifier) {
					const qDoc = findSchemaDocForIdentifier(qualifier, allDocs);
					if (qDoc) return definitionLocation(qDoc.path, 1);
				}
				if (SQL_RESERVED_KEYWORDS.has(word.word.toLowerCase()) || !hasSchemaTables(allDocs) || (lang === "ssl" && isSslOwnWord(await sslFacts(model), position.lineNumber - 1, word.startColumn - 1))) {
					return null;
				}
				const tableDoc = findSchemaDocForIdentifier(word.word, allDocs);
				if (tableDoc) {
					return definitionLocation(tableDoc.path, 1);
				}
				return null;
			},
		});

		monaco.languages.registerCompletionItemProvider(lang, {
			triggerCharacters: ["."],
			async provideCompletionItems(model, position) {
				const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
				// In Markdown, yield to markdownLinks.ts when completing inside `](` or `[[`.
				if (lang === "markdown" && (linkBeingWritten(lineBefore) !== null || nameBeingWritten(lineBefore) !== null)) {
					return { suggestions: [] };
				}
				const allDocs = docs();

				// 1. After `TABLE.` -> suggest documented columns of that table.
				const dotMatch = /(?:^|[^\w$])([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)?$/.exec(lineBefore);
				if (dotMatch) {
					const tbl = dotMatch[1]!;
					const typed = dotMatch[2] ?? "";
					const tableDoc = findSchemaDocForIdentifier(tbl, allDocs);
					if (!tableDoc) return { suggestions: [] };
					const cols = await loadColumnsForDoc(tableDoc);
					const tblLower = tbl.toLowerCase();
					const scoped = cols.filter((c) => c.table.toLowerCase() === tblLower || c.table.toLowerCase().endsWith(`.${tblLower}`));
					const list = scoped.length ? scoped : cols;
					const range = new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column);
					return {
						suggestions: list.map((col, idx) => ({
							label: col.name,
							kind: monaco.languages.CompletionItemKind.Field,
							detail: [col.type, col.constraints && col.constraints !== "—" ? col.constraints : ""].filter(Boolean).join(" · ") || `${col.table} column`,
							documentation: col.notes || undefined,
							insertText: col.name,
							sortText: `z_col_${String(idx).padStart(4, "0")}`,
							range,
						})),
					};
				}

				// 2. Bare prefix (>= 2 chars) -> suggest documented schema table names + columns of tables referenced in this file.
				const wordMatch = /(?:^|[^\w$])([A-Za-z_][\w$]{1,})$/.exec(lineBefore);
				if (!wordMatch) return { suggestions: [] };
				const prefix = wordMatch[1]!;
				const prefixLower = prefix.toLowerCase();
				const range = new monaco.Range(position.lineNumber, position.column - prefix.length, position.lineNumber, position.column);
				const suggestions: monaco.languages.CompletionItem[] = [];
				const seenTables = new Set<string>();

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
						if (!bare || bare.length < 2 || seenTables.has(lower) || !lower.includes(prefixLower)) continue;
						seenTables.add(lower);
						suggestions.push({
							label: bare,
							kind: monaco.languages.CompletionItemKind.Struct,
							detail: `Schema table (${d.name})`,
							documentation: d.summary || undefined,
							insertText: bare,
							sortText: `z_tbl_${lower}`,
							range,
						});
					}
				}

				if (model.isDisposed()) return { suggestions: [] };
				if (model.getValueLength() <= 200_000 && hasSchemaTables(allDocs)) {
					const refTables = referencedSchemaTables(await searchableText(model), allDocs, 6);
					const seenCols = new Set<string>();
					for (const refDoc of refTables) {
						const cols = await loadColumnsForDoc(refDoc);
						for (const col of cols) {
							const colKey = `${col.table.toLowerCase()}.${col.name.toLowerCase()}`;
							if (seenCols.has(colKey) || !col.name.toLowerCase().includes(prefixLower)) continue;
							seenCols.add(colKey);
							suggestions.push({
								label: col.name,
								kind: monaco.languages.CompletionItemKind.Field,
								detail: `${col.table}${col.type ? ` · ${col.type}` : ""}`,
								documentation: col.notes || undefined,
								insertText: col.name,
								sortText: `z_col_${col.name.toLowerCase()}`,
								range,
							});
						}
					}
				}

				return { suggestions };
			},
		});
	}

	// LinkProvider for SSL & SQL: comment doc paths + [[wikilinks]], ticket keys, and schema table names.
	for (const lang of ["ssl", "sql"] as const) {
		monaco.languages.registerLinkProvider(lang, {
			async provideLinks(model) {
				if (model.getLineCount() > 5000) return { links: [] };
				const allDocs = docs();
				const wsRoot = state.workspace?.root;
				const { map: ticketMap, match: matchTickets } = ticketIndex();

				// Build a single combined regex for documented schema table names (>= 3 chars) so scanning is O(lines).
				const schemaKeySet = new Set<string>();
				for (const d of allDocs) {
					if (!d.exists || d.group !== "schema" || isCatalog(d)) continue;
					for (const k of schemaDocKeys(d)) {
						if (k.length >= 3 && /^[a-z_][\w$]*$/i.test(k)) schemaKeySet.add(k);
					}
				}
				const schemaKeys = [...schemaKeySet].sort((a, b) => b.length - a.length);
				const schemaRe = schemaKeys.length
					? new RegExp(`(?<![A-Za-z0-9_])(${schemaKeys.map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`, "gi")
					: null;

				// Which words are the language's own matters to a table's link alone: with no table to link, the server is
				// not asked. It is asked before the lines are read, so that they are read from the text the answer is of.
				const facts = lang === "ssl" && schemaRe ? await sslFacts(model) : NO_FACTS;
				if (model.isDisposed()) return { links: [] };
				const ownNames = facts.names ? namesByLine(facts.names) : null;
				const lineCount = model.getLineCount();

				const lines: string[] = [];
				for (let lineNum = 1; lineNum <= lineCount; lineNum++) lines.push(model.getLineContent(lineNum));
				const commentRefs = findCommentDocRefsFor(lines, lang, allDocs, wsRoot);
				const commentRefsByLine = new Map<number, CommentDocRef[]>();
				for (const r of commentRefs) {
					const list = commentRefsByLine.get(r.line);
					if (list) list.push(r);
					else commentRefsByLine.set(r.line, [r]);
				}

				const links: monaco.languages.ILink[] = [];
				const MAX_LINKS = 500;
				for (let lineNum = 1; lineNum <= lineCount && links.length < MAX_LINKS; lineNum++) {
					const text = lines[lineNum - 1]!;
					if (!text.trim()) continue;
					const taken: [number, number][] = [];

					// 1. Clickable workspace doc paths & [[wikilinks]] in comments
					for (const ref of commentRefsByLine.get(lineNum) ?? []) {
						if (links.length >= MAX_LINKS) break;
						taken.push([ref.from, ref.to]);
						const rel = wsRoot ? relativeTo(wsRoot, ref.doc.path).replace(/\\/g, "/") : ref.doc.name;
						links.push({
							range: new monaco.Range(lineNum, ref.from + 1, lineNum, ref.to + 1),
							url: refUri({
								file: canonical(ref.doc.path),
								...(ref.targetLine ? { line: ref.targetLine } : {}),
								...(ref.targetEndLine ? { endLine: ref.targetEndLine } : {}),
								...(ref.heading ? { heading: ref.heading } : {}),
							}),
							tooltip: `Open ${ref.doc.title || ref.doc.name} (${rel})`,
						});
					}

					// 2. Ticket keys
					for (const m of matchTickets(text)) {
						if (links.length >= MAX_LINKS) break;
						if (taken.some(([a, b]) => m.from < b && m.to > a)) continue;
						const doc = ticketMap.get(m.key.toLowerCase());
						if (!doc) continue;
						taken.push([m.from, m.to]);
						links.push({
							range: new monaco.Range(lineNum, m.from + 1, lineNum, m.to + 1),
							url: refUri(canonical(doc.path)),
							tooltip: `Open ${doc.ticket}${doc.title ? `: ${doc.title}` : ""}`,
						});
					}

					// 3. Schema table names
					if (schemaRe && links.length < MAX_LINKS) {
						schemaRe.lastIndex = 0;
						for (let m = schemaRe.exec(text); m && links.length < MAX_LINKS; m = schemaRe.exec(text)) {
							const from = m.index;
							const to = from + m[0].length;
							if (taken.some(([a, b]) => from < b && to > a)) continue;
							if (SQL_RESERVED_KEYWORDS.has(m[0].toLowerCase())) continue;
							if (lang === "ssl" && isSslOwnWord(facts, lineNum - 1, from, ownNames?.get(lineNum - 1) ?? (ownNames ? [] : undefined))) continue;
							const doc = findSchemaDocForIdentifier(m[0], allDocs);
							if (!doc) continue;
							const rel = wsRoot ? relativeTo(wsRoot, doc.path).replace(/\\/g, "/") : doc.name;
							links.push({
								range: new monaco.Range(lineNum, from + 1, lineNum, to + 1),
								url: refUri(canonical(doc.path)),
								tooltip: `Open schema ${doc.title || doc.name} (${rel})`,
							});
						}
					}
				}
				return { links };
			},
		});
	}

	// Ticket-key Hover, Definition, and Link providers on config/form/plan languages (.xfd, .plan.json).
	for (const lang of ["xml", "json"] as const) {
		monaco.languages.registerHoverProvider(lang, {
			provideHover(model, position) {
				const ticketHit = findTicketAtPosition(model.getLineContent(position.lineNumber), position.column);
				if (!ticketHit) return null;
				return {
					range: new monaco.Range(position.lineNumber, ticketHit.startColumn, position.lineNumber, ticketHit.endColumn),
					contents: [{ value: ticketHoverMarkdown(ticketHit.doc) }],
				};
			},
		});

		monaco.languages.registerDefinitionProvider(lang, {
			async provideDefinition(model, position) {
				const ticketHit = findTicketAtPosition(model.getLineContent(position.lineNumber), position.column);
				if (!ticketHit) return null;
				return definitionLocation(ticketHit.doc.path, 1);
			},
		});

		monaco.languages.registerLinkProvider(lang, {
			provideLinks(model) {
				const lineCount = model.getLineCount();
				if (lineCount > 5000) return { links: [] };
				const { map: ticketMap, match: matchTickets } = ticketIndex();
				const links: monaco.languages.ILink[] = [];
				const MAX_LINKS = 500;
				for (let lineNum = 1; lineNum <= lineCount && links.length < MAX_LINKS; lineNum++) {
					const text = model.getLineContent(lineNum);
					if (!text.trim()) continue;
					for (const m of matchTickets(text)) {
						const doc = ticketMap.get(m.key.toLowerCase());
						if (!doc) continue;
						links.push({
							range: new monaco.Range(lineNum, m.from + 1, lineNum, m.to + 1),
							url: refUri(canonical(doc.path)),
							tooltip: `Open ${doc.ticket}${doc.title ? `: ${doc.title}` : ""}`,
						});
						if (links.length >= MAX_LINKS) break;
					}
				}
				return { links };
			},
		});
	}

	// SSL/SQL comment-context completion provider: suggests [[wikilinks]], active/open tickets, and docs/ relative paths inside comments.
	for (const commentLang of ["ssl", "sql"] as const) {
		monaco.languages.registerCompletionItemProvider(commentLang, {
			triggerCharacters: ["[", "/"],
			provideCompletionItems(model, position) {
				const lineNum = position.lineNumber;
				if (lineNum > 5000) return { suggestions: [] };
				const lines: string[] = [];
				for (let i = 1; i <= lineNum; i++) lines.push(model.getLineContent(i));
				const spans = commentSpansFor(lines, commentLang)[lineNum - 1];
				const offset = position.column - 1;
				if (!spans?.some((s) => offset >= s.from && offset <= s.to)) {
					return { suggestions: [] };
				}

				const lineText = lines[lineNum - 1] ?? "";
				const before = lineText.slice(0, offset);
				const after = lineText.slice(offset);
				const allDocs = docs().filter((d) => d.exists && !isCatalog(d));
				const wsRoot = state.workspace?.root;
				const activeKey = state.settings.activeTicket?.trim().toLowerCase() ?? "";
				const suggestions: monaco.languages.CompletionItem[] = [];

				// 1. Inside `[[...` or right after `[`: suggest [[wikilinks]] for workspace docs and tickets.
				const wikiMatch = /(\[\[?)([^\]\n]*)$/.exec(before);
				if (wikiMatch) {
					const openBrackets = wikiMatch[1]!;
					const typed = wikiMatch[2] ?? "";
					const typedLower = typed.toLowerCase();
					const startCol = position.column - openBrackets.length - typed.length;
					const hasClosing = after.startsWith("]]");
					const endCol = hasClosing ? position.column + 2 : position.column;
					const range = new monaco.Range(lineNum, startCol, lineNum, endCol);
					const seen = new Set<string>();
					for (const d of allDocs) {
						const wikiName = nameFor(d, allDocs, wsRoot) || baseName(d.path).replace(/\.[^.]+$/, "");
						const lower = wikiName.toLowerCase();
						if (!wikiName || seen.has(lower)) continue;
						const relPath = wsRoot ? relativeTo(wsRoot, d.path).replace(/\\/g, "/") : d.name;
						if (
							typedLower &&
							!lower.includes(typedLower) &&
							!(d.title?.toLowerCase().includes(typedLower) ?? false) &&
							!(d.ticket?.toLowerCase().includes(typedLower) ?? false) &&
							!relPath.toLowerCase().includes(typedLower)
						) {
							continue;
						}
						seen.add(lower);
						const isActiveTicket = Boolean(activeKey && d.ticket?.toLowerCase() === activeKey);
						const isTicket = d.group === "tickets";
						suggestions.push({
							label: `[[${wikiName}]]`,
							filterText: `${wikiName} ${d.title ?? ""} ${d.ticket ?? ""} ${relPath}`,
							kind: isTicket ? monaco.languages.CompletionItemKind.Reference : monaco.languages.CompletionItemKind.File,
							detail: [d.title && d.title !== wikiName ? d.title : "", d.status ? `(${d.status})` : "", relPath].filter(Boolean).join(" · "),
							documentation: d.summary || undefined,
							insertText: `[[${wikiName}]]`,
							sortText: isActiveTicket ? `00_${lower}` : isTicket ? `01_${lower}` : `02_${lower}`,
							range,
						});
						if (suggestions.length >= 80) break;
					}
					return { suggestions };
				}

				// 2. Relative doc path inside comment (e.g. `docs/...`, `design/...`, `schema/...`, `../...`).
				const pathMatch = /(?:^|[\s([{"'`])((?:\.{1,2}\/|(?:docs|design|schema|knowledge)\/)[A-Za-z0-9_./-]*)$/i.exec(before);
				if (pathMatch) {
					const typed = pathMatch[1]!;
					const typedLower = typed.toLowerCase();
					const range = new monaco.Range(lineNum, position.column - typed.length, lineNum, position.column);
					for (const d of allDocs) {
						const relPath = wsRoot ? relativeTo(wsRoot, d.path).replace(/\\/g, "/") : d.name.replace(/\\/g, "/");
						if (!relPath.toLowerCase().includes(typedLower)) continue;
						suggestions.push({
							label: relPath,
							kind: monaco.languages.CompletionItemKind.File,
							detail: [d.title || "", d.status ? `(${d.status})` : ""].filter(Boolean).join(" "),
							documentation: d.summary || undefined,
							insertText: relPath,
							sortText: `10_${relPath.toLowerCase()}`,
							range,
						});
						if (suggestions.length >= 80) break;
					}
					return { suggestions };
				}

				// 3. General comment context: active/open tickets, docs/ relative paths, and [[wikilinks]].
				const tokenMatch = /([A-Za-z0-9_./-]*)$/.exec(before);
				const typed = tokenMatch?.[1] ?? "";
				const typedLower = typed.toLowerCase();
				const range = new monaco.Range(lineNum, position.column - typed.length, lineNum, position.column);

				const tickets = allDocs
					.filter((d) => d.group === "tickets" && d.ticket && toneOf(d.status) !== "done")
					.sort((a, b) => {
						const aActive = a.ticket!.toLowerCase() === activeKey ? 0 : 1;
						const bActive = b.ticket!.toLowerCase() === activeKey ? 0 : 1;
						return aActive - bActive || a.ticket!.localeCompare(b.ticket!, undefined, { numeric: true, sensitivity: "base" });
					});
				for (const t of tickets) {
					const key = t.ticket!;
					if (typedLower && !key.toLowerCase().includes(typedLower) && !(t.title?.toLowerCase().includes(typedLower) ?? false)) continue;
					const isActive = key.toLowerCase() === activeKey;
					suggestions.push({
						label: key,
						filterText: `${key} ${t.title ?? ""}`,
						kind: monaco.languages.CompletionItemKind.Reference,
						detail: [isActive ? "Active ticket" : "Ticket", t.title || "", t.status ? `(${t.status})` : ""].filter(Boolean).join(" · "),
						documentation: t.summary || undefined,
						insertText: key,
						sortText: isActive ? `00_${key}` : `01_${key}`,
						range,
					});
				}

				for (const d of allDocs) {
					const relPath = wsRoot ? relativeTo(wsRoot, d.path).replace(/\\/g, "/") : d.name.replace(/\\/g, "/");
					const wikiName = nameFor(d, allDocs, wsRoot) || baseName(d.path).replace(/\.[^.]+$/, "");
					if (
						typedLower &&
						!relPath.toLowerCase().includes(typedLower) &&
						!wikiName.toLowerCase().includes(typedLower) &&
						!(d.title?.toLowerCase().includes(typedLower) ?? false)
					) {
						continue;
					}
					if (relPath.toLowerCase().startsWith("docs/")) {
						suggestions.push({
							label: relPath,
							kind: monaco.languages.CompletionItemKind.File,
							detail: d.title || d.group,
							documentation: d.summary || undefined,
							insertText: relPath,
							sortText: `02_${relPath.toLowerCase()}`,
							range,
						});
					}
					suggestions.push({
						label: `[[${wikiName}]]`,
						filterText: `${wikiName} ${d.title ?? ""} ${relPath}`,
						kind: monaco.languages.CompletionItemKind.Reference,
						detail: relPath,
						documentation: d.summary || undefined,
						insertText: `[[${wikiName}]]`,
						sortText: `03_${wikiName.toLowerCase()}`,
						range,
					});
					if (suggestions.length >= 80) break;
				}
				return { suggestions };
			},
		});
	}

	// Lightweight SSL CodeLensProvider using starlims-lsp symbols per URI (ADR 0003: zero SSL parsing; works across Split Editor panes).
	const lensEmitter = new monaco.Emitter<monaco.languages.CodeLensProvider>();
	const codeLensProvider: monaco.languages.CodeLensProvider = {
		onDidChange: lensEmitter.event,
		async provideCodeLenses(model) {
			if (model.uri.scheme !== "file") return { lenses: [], dispose: () => {} };
			const filePath = canonical(model.uri.fsPath);
			const fileSyms = await documentSymbolsForModel(model);
			const procs = flattenSymbols(fileSyms, PROC_SYMBOL_KINDS);
			if (!procs.length) return { lenses: [], dispose: () => {} };

			const allDocs = docs();
			const wsRoot = state.workspace?.root;
			const gov = docsGoverningFile(allDocs, filePath, wsRoot);
			const planDocs = gov.filter((g) => g.file.group === "plans" && /\.plan\.json$/i.test(g.file.name)).map((g) => g.file);
			const mdDocs = gov.filter((g) => isMarkdown(g.file.path)).map((g) => g.file);
			const auditIssues = (docAuditData().citationIssues ?? []).filter((c) => canonical(c.targetPath) === filePath);

			// Load plan summaries & doc citations once per provideCodeLenses pass.
			const loadedPlans = await Promise.all(
				planDocs.slice(0, 8).map(async (planDoc) => ({ planDoc, data: await loadPlanSummary(planDoc) })),
			);
			const loadedCitations = await Promise.all(
				mdDocs.slice(0, 12).map(async (doc) => ({
					doc,
					citations: (await loadDocCitations(doc.path)).filter((c) => citationTargetsFile(doc.path, c, filePath, wsRoot)),
				})),
			);

			const lenses: monaco.languages.CodeLens[] = [];
			for (const proc of procs) {
				const startLine = proc.range.startLineNumber;
				const endLine = proc.range.endLineNumber;
				const lensLine = proc.selectionRange.startLineNumber;
				const range = new monaco.Range(lensLine, 1, lensLine, 1);
				const procLower = proc.name.toLowerCase();
				let addedForProc = 0;
				const MAX_PER_PROC = 4;

				// 1. Governing Plan steps referencing this procedure
				for (const { planDoc, data } of loadedPlans) {
					if (addedForProc >= MAX_PER_PROC || !data) continue;
					const stepNames = new Set<string>();
					let matched = false;
					for (const unit of data.units) {
						if (unit.name.toLowerCase() !== procLower) continue;
						if (unit.script && !codeMatchesRef(filePath, unit.script, wsRoot)) continue;
						matched = true;
						for (const id of unit.nodes) {
							const node = data.nodeById.get(id);
							if (node?.text) stepNames.add(node.text);
						}
					}
					for (const t of data.targetProcedures) {
						if (t.script && !codeMatchesRef(filePath, t.script, wsRoot)) continue;
						if (t.procedures.some((p) => p.toLowerCase() === procLower)) matched = true;
					}
					for (const call of data.callNodes) {
						const tail = call.ref.split(".").pop()?.toLowerCase() ?? "";
						if (tail === procLower || call.ref.toLowerCase() === procLower) {
							matched = true;
							stepNames.add(call.text);
						}
					}
					if (!matched) continue;
					const stepSuffix =
						stepNames.size === 1
							? `: ${[...stepNames][0]}`
							: stepNames.size > 1
								? ` (${stepNames.size} steps)`
								: "";
					lenses.push({
						range,
						command: {
							id: CODELENS_OPEN_CMD,
							title: `Plan: ${data.title}${stepSuffix}`,
							tooltip: `Open governing plan ${planDoc.name}`,
							arguments: [{ file: planDoc.path } satisfies RefTarget],
						},
					});
					addedForProc++;
				}

				// 2. Drifted #L citations from docAuditData() overlapping this procedure
				const citedDocPaths = new Set<string>();
				for (const issue of auditIssues) {
					if (addedForProc >= MAX_PER_PROC) break;
					if (issue.citation.from > endLine || issue.citation.to < startLine) continue;
					const docKey = canonical(issue.docPath);
					if (citedDocPaths.has(docKey)) continue;
					citedDocPaths.add(docKey);
					const docEntry = allDocs.find((d) => canonical(d.path) === docKey);
					const label = docEntry?.title || docEntry?.name || (wsRoot ? relativeTo(wsRoot, issue.docPath) : issue.docPath);
					lenses.push({
						range,
						command: {
							id: CODELENS_OPEN_CMD,
							title: `Citation ${issue.kind}: ${label}`,
							tooltip: `Jump to ${label} (line ${issue.docLine}): ${issue.text}`,
							arguments: [{ file: issue.docPath, line: issue.docLine } satisfies RefTarget],
						},
					});
					addedForProc++;
				}

				// 3. Live #L doc citations overlapping this procedure
				for (const { doc, citations } of loadedCitations) {
					if (addedForProc >= MAX_PER_PROC) break;
					const docKey = canonical(doc.path);
					if (citedDocPaths.has(docKey)) continue;
					const hit = citations.find((c) => c.from <= endLine && c.to >= startLine);
					if (!hit) continue;
					citedDocPaths.add(docKey);
					const label = doc.ticket && doc.title && !doc.title.startsWith(doc.ticket) ? `${doc.ticket}: ${doc.title}` : doc.title || doc.name;
					lenses.push({
						range,
						command: {
							id: CODELENS_OPEN_CMD,
							title: `Doc: ${label}`,
							tooltip: `Open citing document ${doc.name} at line ${hit.line}`,
							arguments: [{ file: doc.path, line: hit.line } satisfies RefTarget],
						},
					});
					addedForProc++;
				}
			}

			return { lenses, dispose: () => {} };
		},
	};
	monaco.languages.registerCodeLensProvider("ssl", codeLensProvider);

	// Refresh CodeLenses reactively whenever LSP state/symbols, workspace docs, or doc audit results update.
	runWithOwner(null, () =>
		createRoot(() => {
			const env = createMemo(
				() => [state.workspace?.root, state.lsp.state] as const,
				{ equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
			);
			createEffect(env, () => {
				modelSymbolCache.clear();
				lensEmitter.fire(codeLensProvider);
			});
			createEffect(
				() => [symbols(), docs(), docAuditData()] as const,
				() => {
					lensEmitter.fire(codeLensProvider);
				},
			);
		}),
	);
}

/** Command Palette action: jumps from the identifier under cursor in SSL/SQL/Markdown to its documented schema file. */
export async function openSchemaAtCursor(): Promise<void> {
	const live = activeLiveEditor();
	const liveModel = live ? activeDoc()?.model : undefined;
	const editor = activeEditor();
	const model = liveModel ?? editor?.getModel();
	const pos = live ? live.getPosition() : editor?.getPosition();
	if (model && pos) {
		const word = model.getWordAtPosition(pos);
		if (word) {
			const allDocs = docs();
			const hit = findSchemaDocForIdentifier(word.word, allDocs);
			if (hit) {
				await openFile(hit.path);
				return;
			}
			const qualifier = qualifierBeforeWord(model.getLineContent(pos.lineNumber), word.startColumn);
			if (qualifier) {
				const qHit = findSchemaDocForIdentifier(qualifier, allDocs);
				if (qHit) {
					await openFile(qHit.path);
					return;
				}
			}
			notify(`No documented schema file matches “${word.word}”.`);
			return;
		}
	}
	// Fallback: let user pick from documented schema files via searchable QuickPick (ADR 0032).
	const schemaDocs = docs()
		.filter((d) => d.exists && d.group === "schema" && !/index\.md$/i.test(d.name))
		.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name, undefined, { sensitivity: "base" }));
	if (!schemaDocs.length) return notify("No schema documents exist in this project yet.");
	const items: QuickPickOption<DocFile>[] = schemaDocs.map((d) => ({
		value: d,
		label: d.title || baseName(d.path).replace(/\.[^.]+$/, ""),
		icon: "database",
		badge: d.kind ? { text: d.kind } : undefined,
		detail: relativeTo(state.workspace?.root, d.path).replace(/\\/g, "/"),
		description: d.summary || undefined,
		keywords: [d.title ?? "", d.name, ...(d.schemaObjects ?? [])].filter(Boolean).join(" "),
	}));
	const found = await quickPick<DocFile>({
		title: "Open schema document",
		placeholder: "Filter schema tables, views, or DDL…",
		items,
	});
	if (found) await openFile(found.path);
}

/** Command Palette action: appends the selected constant/setting/table identifier to a CSV registry pre-linked to the active ticket. */
export async function addSelectionToRegistry(): Promise<void> {
	const editor = activeEditor();
	const model = editor?.getModel();
	const sel = editor?.getSelection();
	let itemName = "";
	if (model && sel && !sel.isEmpty()) {
		itemName = model.getValueInRange(sel).trim().replace(/^["'`[]|["'`\]]$/g, "");
	} else if (model && editor?.getPosition()) {
		itemName = model.getWordAtPosition(editor.getPosition()!)?.word ?? "";
	}
	const { docs: allDocs } = await import("../project");
	const { ticketForFile } = await import("../../shared/workContext");
	const { ticketAtHand, addRegistryRowForTicket } = await import("../projectDocs");
	const key =
		state.settings.activeTicket?.trim() ||
		ticketForFile(allDocs(), activePath(), state.workspace?.root) ||
		ticketAtHand() ||
		"";
	if (!key) {
		notify("Set an active ticket (or open a ticket-linked file) first, then add the registry row.");
		return;
	}
	await addRegistryRowForTicket(key, itemName || undefined);
}
