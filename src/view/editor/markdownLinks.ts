// Links in a Markdown document's text. While one is written, the project's
// documents are offered: "](" and the list is there, each by what it is
// called, and the path written is the way to it from this document. Once it
// is written it can be followed from the text, as it can from the page:
// Ctrl+click, or "Open the link at the cursor".
// Also hosts pure outgoing-link, backlink-snippet, and unlinked-mention helpers
// for the Markdown Links Inspector (Wave 4.6) and Source-mode completion parity (Wave 2.2).
import { fenced } from "../../shared/catalog";
import { fileLinks, hrefWritten, linkBeingWritten, linkChoices, linkLeads } from "../../shared/docLinks";
import { headingAnchor } from "../../shared/docTables";
import { frontMatter } from "../../shared/frontMatter";
import { CALLOUT_PRESETS, CALLOUT_SPECS, documentHeadings } from "../../shared/markdownEdit";
import { buildDocNameIndex, docByName, lookupInIndex, nameBeingWritten, nameChoices, namedLink, namePlaces } from "../../shared/namedLinks";
import { baseName, relativeTo } from "../../shared/paths";
import { isCatalog } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { extractTags, isLikelyHexColorTag, workspaceTags } from "../../shared/tags";
import { ticketMatcher } from "../../shared/ticketRefs";
import { backend } from "../backend";
import { docs } from "../project";
import { canonical, documents, openFile, state } from "../state";
import { listWorkspaceImages } from "./imageResolve";
import { marksFor } from "./markdownLive";
import { monaco } from "./monaco";

/** Languages offered on opening ```` ```<lang> ```` fences in Source mode (matching CM6 Live). */
export const SOURCE_FENCE_LANGS: readonly [string, string][] = [
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

export type SourceCompletionKind =
	| { kind: "fence"; typed: string }
	| { kind: "callout"; typed: string; restLen: number; hasClose: boolean }
	| { kind: "embed"; typed: string; restLen: number; closed: boolean }
	| { kind: "wiki-heading"; docName: string; typed: string; restLen: number; closed: boolean }
	| { kind: "wiki"; typed: string; restLen: number; closed: boolean }
	| { kind: "link"; typed: string; restLen: number }
	| { kind: "tag"; typed: string };

function insideBackticks(lineBefore: string): boolean {
	return (lineBefore.match(/`/g)?.length ?? 0) % 2 === 1;
}

/** True when prior lines before the current line leave an unclosed code fence open. */
export function hasUnclosedPriorFence(textBeforeLine: string): boolean {
	if (!textBeforeLine) return false;
	let openChar: string | null = null;
	let openLen = 0;
	for (const l of textBeforeLine.split(/\r?\n/)) {
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
	return openChar !== null;
}

/**
 * Pure classifier for Monaco Source-mode Markdown completions (parity with CM6 Live):
 * detects ```` ```lang ````, `> [!callout`, `![[embed`, `[[doc#heading`, `[[doc`, `](path`, and `#tag`.
 */
export function classifySourceCompletion(
	before: string,
	after: string,
	inOpenFence = false,
): SourceCompletionKind | null {
	// 0. Opening fenced code block language: ```<lang>
	const fenceOpen = /^[ \t]{0,3}(`{3,}|~{3,})([A-Za-z0-9_+-]*)$/.exec(before);
	if (fenceOpen && after.trim() === "" && !inOpenFence) {
		return { kind: "fence", typed: fenceOpen[2]! };
	}
	if (inOpenFence) return null;

	// 1. Obsidian callout type: `> [!` or `>[!`
	const callout = /^[ \t]{0,3}>[ \t]*\[!([A-Za-z0-9_-]*)$/.exec(before);
	if (callout) {
		const restLen = /^[A-Za-z0-9_-]*/.exec(after)![0].length;
		const hasClose = after.slice(restLen).startsWith("]");
		return { kind: "callout", typed: callout[1]!, restLen, hasClose };
	}

	// 2. Embed completion: `![[name`
	const embed = /!\[\[([^[\]|#\n]*)$/.exec(before);
	if (embed && !insideBackticks(before.slice(0, embed.index))) {
		const restLen = /^[^[\]|#]*/.exec(after)![0].length;
		const closed = /^(?:\|[^[\]]*)?\]\]/.test(after.slice(restLen));
		return { kind: "embed", typed: embed[1]!, restLen, closed };
	}

	// 3. Wikilink heading completion: `[[doc#heading` or `[[#heading`
	const wikiHeading = /\[\[([^[\]|#\n]*)#([^[\]|#\n]*)$/.exec(before);
	if (wikiHeading && !insideBackticks(before.slice(0, wikiHeading.index))) {
		const restLen = /^[^[\]|#]*/.exec(after)![0].length;
		const closed = /^(?:\|[^[\]]*)?\]\]/.test(after.slice(restLen));
		return {
			kind: "wiki-heading",
			docName: wikiHeading[1]!.trim(),
			typed: wikiHeading[2]!,
			restLen,
			closed,
		};
	}

	// 4. Relative Markdown link: `](path`
	const linkTyped = linkBeingWritten(before);
	if (linkTyped !== null) {
		const restLen = /^[^()<>\s]*/.exec(after)![0].length;
		return { kind: "link", typed: linkTyped, restLen };
	}

	// 5. Wikilink document name: `[[name`
	const nameTyped = nameBeingWritten(before);
	if (nameTyped !== null) {
		const restLen = /^[^[\]|#]*/.exec(after)![0].length;
		const closed = /^(?:[|#][^[\]]*)?\]\]/.test(after.slice(restLen));
		return { kind: "wiki", typed: nameTyped, restLen, closed };
	}

	// 6. Prose `#tag` (not ATX headings and not hex color literals)
	const tag = /(?:^|[\s(])#([A-Za-z][A-Za-z0-9_/-]*)$/.exec(before);
	if (tag && !/^[ \t]{0,3}#/.test(before) && !insideBackticks(before.slice(0, tag.index)) && !isLikelyHexColorTag(tag[1]!)) {
		return { kind: "tag", typed: tag[1]! };
	}

	return null;
}

// --- Links Inspector Pure Helpers (Backlink snippets, Outgoing links, Unlinked mentions) ---

export type OutgoingLinkKind = "link" | "wiki" | "embed" | "ticket" | "web" | "heading";

export type OutgoingLinkItem = {
	kind: OutgoingLinkKind;
	label: string;
	target: string;
	line: number;
	resolvedPath?: string;
	heading?: string;
	targetLine?: number;
	broken: boolean;
	instead?: string;
};

export type UnlinkedMentionItem = {
	path: string;
	title: string;
	line: number;
	column: number;
	matchedText: string;
	snippet: string;
};

/** Extracts a concise single-line context snippet around 1-based `lineNumber` from file text. */
export function extractLineContextSnippet(content: string, lineNumber: number, maxLen = 140): string {
	if (!content) return "";
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	const idx = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
	let raw = lines[idx]?.trim() ?? "";
	if (!raw && idx + 1 < lines.length) raw = lines[idx + 1]?.trim() ?? "";
	if (!raw && idx > 0) raw = lines[idx - 1]?.trim() ?? "";
	const compact = raw.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLen) return compact;
	return `${compact.slice(0, maxLen - 1).trimEnd()}…`;
}

function inlineExclusionRanges(line: string): [number, number][] {
	const spans: [number, number][] = [];
	// Inline code spans
	let i = 0;
	while (i < line.length) {
		if (line[i] !== "`") {
			i++;
			continue;
		}
		let run = 0;
		while (i + run < line.length && line[i + run] === "`") run++;
		let j = i + run;
		let closed = -1;
		while (j < line.length) {
			if (line[j] !== "`") {
				j++;
				continue;
			}
			let closeRun = 0;
			while (j + closeRun < line.length && line[j + closeRun] === "`") closeRun++;
			if (closeRun === run) {
				closed = j + closeRun;
				break;
			}
			j += closeRun;
		}
		if (closed >= 0) {
			spans.push([i, closed]);
			i = closed;
		} else {
			i += run;
		}
	}
	// Wikilinks / embeds
	for (const m of line.matchAll(/!?\[\[[^[\]\n]+\]\]/g)) {
		spans.push([m.index, m.index + m[0].length]);
	}
	// Markdown links / images
	for (const m of line.matchAll(/!?\[[^\]\n]*\]\([^)\n]+\)/g)) {
		spans.push([m.index, m.index + m[0].length]);
	}
	// Bare URLs
	for (const m of line.matchAll(/https?:\/\/\S+/gi)) {
		spans.push([m.index, m.index + m[0].length]);
	}
	return spans;
}

function overlapsRange(from: number, to: number, spans: readonly [number, number][]): boolean {
	return spans.some(([a, b]) => from < b && to > a);
}

const ASSET_OR_CODE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|pdf|sql|ssl|ds|csv|txt|xml|json|xfd)$/i;

/**
 * Extracts all outgoing links from a Markdown document:
 * - Relative/workspace file links (marking broken ones + rename suggestions)
 * - `[[wikilinks]]` and `![[embeds]]` (resolved or broken)
 * - Bare workspace ticket references (e.g. `DEMO-101`)
 * - External `https://` web links
 */
export function extractOutgoingLinks(
	markdown: string,
	herePath: string,
	files: readonly DocFile[],
	options: { root?: string | null; broken?: readonly { href: string; line: number; instead?: string }[] } = {},
): OutgoingLinkItem[] {
	const root = options.root;
	const brokenList = options.broken ?? [];
	const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();
	const hereNorm = normPath(herePath);
	const byNormPath = new Map<string, DocFile>();
	for (const f of files) {
		if (f.exists) byNormPath.set(normPath(f.path), f);
	}
	const nameIdx = buildDocNameIndex(files, root);

	const out: OutgoingLinkItem[] = [];
	const seen = new Set<string>();
	const pushUnique = (item: OutgoingLinkItem) => {
		const key = `${item.kind}:${item.line}:${item.target.toLowerCase()}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(item);
	};

	// 1. Markdown file links (`[text](path)` / `![alt](path)`)
	for (const link of fileLinks(markdown)) {
		const brokenHit =
			brokenList.find((b) => b.href === link.href && b.line === link.line) ??
			brokenList.find((b) => b.href === link.href);
		const leads = linkLeads(link.href, herePath, root);
		let resolvedPath: string | undefined;
		let targetLine: number | undefined;
		let heading: string | undefined;
		if (leads && "file" in leads) {
			resolvedPath = leads.file;
			targetLine = leads.lines?.line;
			if (!leads.lines && link.href.includes("#")) {
				const hash = link.href.slice(link.href.indexOf("#") + 1);
				try {
					heading = decodeURIComponent(hash) || undefined;
				} catch {
					heading = hash || undefined;
				}
			}
		}
		const targetDoc = resolvedPath ? byNormPath.get(normPath(resolvedPath)) : undefined;
		const label = targetDoc?.title
			? targetDoc.ticket && !targetDoc.title.toLowerCase().startsWith(targetDoc.ticket.toLowerCase())
				? `${targetDoc.ticket}: ${targetDoc.title}`
				: targetDoc.title
			: link.file || link.href;
		pushUnique({
			kind: "link",
			label,
			target: link.href,
			line: link.line || 1,
			resolvedPath,
			heading,
			targetLine,
			broken: Boolean(brokenHit),
			instead: brokenHit?.instead,
		});
	}

	// 2. Wikilinks (`[[doc]]`) and transclusions (`![[embed]]`)
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	for (const place of namePlaces(markdown)) {
		const found = lookupInIndex(place.name, nameIdx);
		const lineText = lines[place.line - 1] ?? "";
		let fullInner = place.name;
		let heading: string | undefined;
		const sliceFrom = Math.max(0, place.column - 2);
		const wikiRe = /\[\[([^[\]\n]+)\]\]/.exec(lineText.slice(sliceFrom));
		if (wikiRe) {
			fullInner = wikiRe[1]!;
			heading = namedLink(fullInner.replace(/\\\|/g, "|"))?.heading;
		}
		const isAssetEmbed = Boolean(place.embed && ASSET_OR_CODE_EXT_RE.test(place.name));
		const broken = found ? false : !isAssetEmbed;
		const label = found?.title
			? found.ticket && !found.title.toLowerCase().startsWith(found.ticket.toLowerCase())
				? `${found.ticket}: ${found.title}`
				: found.title
			: heading
				? `${place.name} #${heading}`
				: place.name;
		pushUnique({
			kind: place.embed ? "embed" : "wiki",
			label,
			target: fullInner,
			line: place.line,
			resolvedPath: found?.path,
			heading,
			broken,
		});
	}

	// 3. Prose web links & bare workspace ticket references (skipping frontmatter, code fences, inline code & existing links)
	const fmLines = frontMatter(markdown).lines;
	const fences = fenced(markdown);
	const ticketMap = new Map<string, DocFile>();
	for (const f of files) {
		if (f.exists && f.group === "tickets" && !isCatalog(f) && f.ticket && normPath(f.path) !== hereNorm) {
			ticketMap.set(f.ticket.toLowerCase(), f);
		}
	}
	const matchTickets = ticketMap.size ? ticketMatcher([...ticketMap.values()].map((d) => d.ticket!)) : null;

	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const lineText = lines[i]!;
		const lineStart = offset;
		offset += lineText.length + 1;
		if (i < fmLines) continue;
		if (fences.some(([a, b]) => lineStart >= a && lineStart < b)) continue;
		const lineNum = i + 1;

		// Web links `[label](https://...)`
		if (lineText.includes("http")) {
			for (const m of lineText.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gi)) {
				const label = m[1]!.trim();
				const url = m[2]!.trim();
				pushUnique({ kind: "web", label: label || url, target: url, line: lineNum, broken: false });
			}
		}

		// Bare ticket mentions outside links/wikilinks/inline code
		if (matchTickets) {
			const exclusions = inlineExclusionRanges(lineText);
			for (const hit of matchTickets(lineText)) {
				if (overlapsRange(hit.from, hit.to, exclusions)) continue;
				const tDoc = ticketMap.get(hit.key.toLowerCase());
				if (!tDoc) continue;
				const title = tDoc.title && !tDoc.title.toLowerCase().startsWith(hit.key.toLowerCase()) ? `${hit.key}: ${tDoc.title}` : tDoc.title || hit.key;
				pushUnique({
					kind: "ticket",
					label: title,
					target: hit.key,
					line: lineNum,
					resolvedPath: tDoc.path,
					broken: false,
				});
			}
		}
	}

	return out.sort((a, b) => a.line - b.line || a.label.localeCompare(b.label));
}

const GENERIC_DOC_TERMS = new Set([
	"index",
	"readme",
	"agents",
	"notes",
	"overview",
	"changelog",
	"todo",
	"state",
	"summary",
	"draft",
	"untitled",
	"decisions",
	"questions",
	"tickets",
	"specs",
	"plans",
	"schema",
	"docs",
]);

/** Extracts high-signal search terms (ticket key, title, non-generic file stem) for finding unlinked mentions. */
export function mentionTermsForDoc(target: { title?: string; ticket?: string; stem?: string }): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	const add = (raw: string | undefined, minLen: number) => {
		const t = raw?.trim();
		if (!t || t.length < minLen) return;
		const low = t.toLowerCase();
		if (GENERIC_DOC_TERMS.has(low) || seen.has(low)) return;
		seen.add(low);
		terms.push(t);
	};
	add(target.ticket, 3);
	let cleanTitle = target.title?.trim() ?? "";
	if (target.ticket && cleanTitle.toLowerCase().startsWith(`${target.ticket.toLowerCase()}:`)) {
		cleanTitle = cleanTitle.slice(target.ticket.length + 1).trim();
	}
	add(cleanTitle, 4);
	add(target.stem, 4);
	if (
		target.stem &&
		/[-_]/.test(target.stem) &&
		target.stem.toLowerCase() !== target.ticket?.trim().toLowerCase() &&
		!/^[A-Z][A-Z0-9]+-\d+$/i.test(target.stem)
	) {
		add(target.stem.replace(/[-_]+/g, " "), 5);
	}
	return terms.sort((a, b) => b.length - a.length);
}

/**
 * Finds plain-text mentions of `target`'s ticket key, title, or stem in other workspace Markdown docs
 * that do not already link to `target`, skipping YAML frontmatter, code fences, inline code, and existing links.
 */
export function findUnlinkedMentions(
	target: { path: string; title?: string; ticket?: string; stem?: string },
	candidates: readonly { path: string; name: string; title?: string; text: string }[],
	alreadyLinkedPaths: ReadonlySet<string>,
	opts: { maxPerFile?: number; maxTotal?: number } = {},
): UnlinkedMentionItem[] {
	const terms = mentionTermsForDoc(target);
	if (!terms.length) return [];
	const maxPerFile = opts.maxPerFile ?? 3;
	const maxTotal = opts.maxTotal ?? 30;
	const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();
	const targetNorm = normPath(target.path);
	const linkedNorms = new Set([...alreadyLinkedPaths].map(normPath));
	const pattern = new RegExp(
		`(?<![A-Za-z0-9_-])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_-])`,
		"gi",
	);

	const out: UnlinkedMentionItem[] = [];
	for (const cand of candidates) {
		if (out.length >= maxTotal) break;
		const cNorm = normPath(cand.path);
		if (cNorm === targetNorm || linkedNorms.has(cNorm)) continue;
		const text = cand.text.replace(/\r\n?/g, "\n");
		const fmLines = frontMatter(text).lines;
		const fences = fenced(text);
		const lines = text.split("\n");
		let offset = 0;
		let fileCount = 0;
		for (let i = 0; i < lines.length && fileCount < maxPerFile && out.length < maxTotal; i++) {
			const lineText = lines[i]!;
			const lineStart = offset;
			offset += lineText.length + 1;
			if (i < fmLines || !lineText.trim()) continue;
			if (fences.some(([a, b]) => lineStart >= a && lineStart < b)) continue;
			const exclusions = inlineExclusionRanges(lineText);
			pattern.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = pattern.exec(lineText)) !== null) {
				const from = m.index;
				const to = from + m[0].length;
				if (overlapsRange(from, to, exclusions)) continue;
				out.push({
					path: cand.path,
					title: cand.title || cand.name,
					line: i + 1,
					column: from,
					matchedText: m[0],
					snippet: extractLineContextSnippet(text, i + 1),
				});
				fileCount++;
				break;
			}
		}
	}
	return out;
}

/** Replaces a single plain-text unlinked mention at `(line, column)` with a `[[wikilink]]` (preserving display alias if wording differs). */
export function linkifyMentionInText(
	text: string,
	line: number,
	column: number,
	matchedText: string,
	wikiName: string,
): string | null {
	const parts = text.split(/(\r?\n)/);
	const idx = (line - 1) * 2;
	const row = parts[idx];
	if (row === undefined || !row.startsWith(matchedText, column)) return null;
	const replacement = wikiName.toLowerCase() === matchedText.toLowerCase() ? `[[${wikiName}]]` : `[[${wikiName}|${matchedText}]]`;
	parts[idx] = `${row.slice(0, column)}${replacement}${row.slice(column + matchedText.length)}`;
	return parts.join("");
}

/** How a link to a place in the project is told to the editor, which only follows addresses: one of the app's own. */
const OWN = "ssl-studio-link";
type Place = { file: string; line?: number; endLine?: number };
const address = (place: Place) => monaco.Uri.from({ scheme: OWN, path: "/", query: JSON.stringify(place) });

async function readDocTextForCompletion(path: string): Promise<string> {
	const open = documents.get(canonical(path));
	if (open) return open.model.getValue();
	return backend.read(path).then((r) => (r.binary ? "" : r.text), () => "");
}

export function registerMarkdownLinks() {
	monaco.languages.registerCompletionItemProvider("markdown", {
		triggerCharacters: ["(", "[", "#", "!", "`"],
		async provideCompletionItems(model, position) {
			const line = model.getLineContent(position.lineNumber);
			const before = line.slice(0, position.column - 1);
			const after = line.slice(position.column - 1);
			const fullText = model.getValue();
			const offset = model.getOffsetAt(position);
			const lineStartOffset = offset - (position.column - 1);
			const inOpenFence = hasUnclosedPriorFence(fullText.slice(0, lineStartOffset));

			const ctx = classifySourceCompletion(before, after, inOpenFence);
			if (!ctx) return { suggestions: [] };

			// Opening code fence language completion (` ```lang `)
			if (ctx.kind === "fence") {
				const range = new monaco.Range(position.lineNumber, position.column - ctx.typed.length, position.lineNumber, position.column);
				return {
					suggestions: SOURCE_FENCE_LANGS.map(([lang, detail], idx) => ({
						label: { label: lang, description: detail },
						kind: monaco.languages.CompletionItemKind.Keyword,
						insertText: lang,
						sortText: String(idx).padStart(4, "0"),
						range,
					})),
				};
			}

			// Outside code fence opening lines, never suggest Markdown link/callout/tag syntax inside fenced code blocks.
			if (fenced(fullText).some(([from, to]) => offset >= from && offset <= to)) return { suggestions: [] };

			// Callout type completion: `> [!type`
			if (ctx.kind === "callout") {
				const range = new monaco.Range(position.lineNumber, position.column - ctx.typed.length, position.lineNumber, position.column + ctx.restLen);
				const presetMap = new Map(CALLOUT_PRESETS.map((p, idx) => [p.type, { about: p.about, idx }]));
				const specs = Object.values(CALLOUT_SPECS);
				return {
					suggestions: specs.map((spec, idx) => {
						const preset = presetMap.get(spec.type);
						const rank = preset ? preset.idx : 100 + idx;
						return {
							label: { label: spec.type.toUpperCase(), description: preset ? preset.about : spec.label },
							kind: monaco.languages.CompletionItemKind.Keyword,
							insertText: ctx.hasClose ? spec.type.toUpperCase() : `${spec.type.toUpperCase()}] `,
							sortText: String(rank).padStart(4, "0"),
							range,
						};
					}),
				};
			}

			// Prose `#tag` completion
			if (ctx.kind === "tag") {
				const range = new monaco.Range(position.lineNumber, position.column - ctx.typed.length, position.lineNumber, position.column);
				const byLower = new Map<string, { tag: string; count: number }>();
				for (const bucket of workspaceTags(docs())) {
					byLower.set(bucket.tag.toLowerCase(), { tag: bucket.tag, count: bucket.count });
				}
				for (const localTag of extractTags(fullText)) {
					const k = localTag.toLowerCase();
					if (!byLower.has(k)) byLower.set(k, { tag: localTag, count: 1 });
				}
				const sorted = [...byLower.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
				return {
					suggestions: sorted.map((entry, idx) => ({
						label: { label: `#${entry.tag}`, description: entry.count > 1 ? `${entry.count} docs` : undefined },
						kind: monaco.languages.CompletionItemKind.Keyword,
						insertText: entry.tag,
						filterText: entry.tag,
						sortText: String(idx).padStart(4, "0"),
						range,
					})),
				};
			}

			// Wikilink heading completion: `[[doc#heading` or `[[#heading`
			if (ctx.kind === "wiki-heading") {
				const root = state.workspace?.root;
				let targetText = "";
				if (!ctx.docName) {
					targetText = fullText;
				} else if (root) {
					const found = docByName(ctx.docName, docs(), root);
					if (found) targetText = await readDocTextForCompletion(found.path);
				}
				const headings = documentHeadings(targetText);
				if (!headings.length) return { suggestions: [] };
				const range = new monaco.Range(
					position.lineNumber,
					position.column - ctx.typed.length,
					position.lineNumber,
					position.column + (ctx.closed ? ctx.restLen : 0),
				);
				return {
					suggestions: headings.map((h, idx) => ({
						label: { label: h.text, description: `H${h.level}` },
						kind: monaco.languages.CompletionItemKind.Text,
						insertText: ctx.closed ? h.text : `${h.text}]]`,
						sortText: String(idx).padStart(4, "0"),
						range,
					})),
				};
			}

			const root = state.workspace?.root;
			if (!root) return { suggestions: [] };
			const here = canonical(model.uri.fsPath);
			const all = docs();
			const files = all.filter((file) => canonical(file.path) !== here);

			// Embed completion: `![[name` -> workspace images + project docs
			if (ctx.kind === "embed") {
				const range = new monaco.Range(
					position.lineNumber,
					position.column - ctx.typed.length,
					position.lineNumber,
					position.column + (ctx.closed ? ctx.restLen : 0),
				);
				const images = await listWorkspaceImages();
				const docChoices = nameChoices(files, here, root, all);
				return {
					suggestions: [
						...images.map((imgPath, idx) => {
							const name = baseName(imgPath);
							const rel = relativeTo(root, imgPath);
							return {
								label: { label: name, description: rel },
								kind: monaco.languages.CompletionItemKind.File,
								insertText: ctx.closed ? name : `${name}]]`,
								filterText: `${name} ${rel}`,
								sortText: `0_${String(idx).padStart(4, "0")}`,
								range,
							};
						}),
						...docChoices.map((choice, idx) => ({
							label: { label: choice.label, description: `Embed · ${choice.detail}` },
							kind: monaco.languages.CompletionItemKind.Text,
							insertText: ctx.closed ? choice.name : `${choice.name}]]`,
							filterText: `${choice.label} ${choice.detail} ${choice.name}`,
							sortText: `1_${String(idx).padStart(4, "0")}`,
							range,
						})),
					],
				};
			}

			// Wikilink document name completion: `[[name`
			if (ctx.kind === "wiki") {
				const range = new monaco.Range(
					position.lineNumber,
					position.column - ctx.typed.length,
					position.lineNumber,
					position.column + (ctx.closed ? ctx.restLen : 0),
				);
				return {
					suggestions: nameChoices(files, here, root, all).map((choice, index) => ({
						label: { label: choice.label, description: choice.detail },
						kind: monaco.languages.CompletionItemKind.File,
						insertText: ctx.closed ? choice.name : `${choice.name}]]`,
						filterText: `${choice.label} ${choice.detail} ${choice.name}`,
						sortText: String(index).padStart(5, "0"),
						range,
					})),
				};
			}

			// Relative Markdown link completion: `](path`
			const range = new monaco.Range(position.lineNumber, position.column - ctx.typed.length, position.lineNumber, position.column + ctx.restLen);
			return {
				suggestions: linkChoices(files, here, root).map((choice, index) => ({
					label: { label: choice.label, description: choice.detail },
					kind: monaco.languages.CompletionItemKind.File,
					insertText: choice.insert,
					filterText: `${choice.label} ${choice.detail} ${choice.insert}`,
					sortText: String(index).padStart(5, "0"),
					range,
				})),
			};
		},
	});

	// A link leads where it leads from anywhere in it: its words, and its address when that is in sight. Between two
	// pairs of brackets it names a document, and leads to the one the name means (ADR 0025).
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
				const closes = model.getLineContent(mark.line).slice(mark.end - 1, mark.end + 1);
				if (closes !== "](" && closes !== "]]") continue;
				// From its opening bracket to the bracket that closes it: the markup either side of its words.
				const before = marks.find((other) => other.kind === "syntax" && other.line === mark.line && other.end === mark.start);
				const after = marks.find((other) => other.kind === "syntax" && other.line === mark.line && other.start === mark.end);
				const range = new monaco.Range(mark.line, before?.start ?? mark.start, mark.line, after?.end ?? mark.end);
				if (closes === "]]") {
					// A link by name leads to the document the name means; one that names none is drawn and leads nowhere.
					// In a table's row the bar is written after a backslash, which is no part of the name.
					const named = namedLink(mark.href.replace(/\\$/, ""));
					const found = named && docByName(named.name, docs(), root);
					if (found) links.push({ range, url: address({ file: canonical(found.path) }), tooltip: `Open ${relativeTo(root, found.path)}` });
					continue;
				}
				const leads = linkLeads(hrefWritten(mark.href), here, root);
				if (!leads) continue;
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
