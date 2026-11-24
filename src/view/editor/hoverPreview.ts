// Multi-format Obsidian-style Hover Page Preview renderer for Markdown Live & Read views:
// - Markdown (.md, .markdown): frontmatter status/ticket chips + rendered prose with callouts, tables, tags & highlights
// - Flowcharts (.plan.json): title, goal, stage/step/decision/test summary, and plain-English flow outline
// - Registries (.csv, .tsv): ticket-filtered rows (when hovered from a ticket's "The work for" section) or table preview
// - Code / text files (.ssl, .sql, .json, .toml, ...): clean syntax-ready code snippet
import DOMPurify from "dompurify";
import { marked } from "marked";
import { parseCsv } from "../../shared/csv";
import { frontMatter, one } from "../../shared/frontMatter";
import { findHeadingLine } from "../../shared/markdownEdit";
import { docByName, namedLink } from "../../shared/namedLinks";
import { baseName, dirName, isInside, relativePath, relativeTo, resolvePath } from "../../shared/paths";
import { registryTitle, toneOf } from "../../shared/projectDocs";
import { keysIn } from "../../shared/registryTickets";
import { backend } from "../backend";
import { isPlanPath, parsePlan } from "../plan/model";
import { docs } from "../project";
import { canonical, documents, state } from "../state";
import { languageFor } from "./languages";
import { resolveCodeLanguage } from "./markdownCode";
import {
	expandTransclusionsMarkdown,
	extractFootnoteDefinition,
	finishMarkdown,
	MAX_TRANSCLUSION_DEPTH,
	type NameResolver,
	type TicketRef,
	type TransclusionLoader,
	type TransclusionLoaderResult,
} from "./markdownHtml";

export { expandTransclusionsMarkdown, MAX_TRANSCLUSION_DEPTH, type TransclusionLoader, type TransclusionLoaderResult };

export type HoverPreviewData = {
	path: string;
	title: string;
	relPath: string;
	kind: "markdown" | "plan" | "table" | "code";
	status?: string;
	statusTone?: string;
	badge?: string;
	html: string;
	line?: number;
};

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function readText(path: string): Promise<string> {
	const key = canonical(path);
	const open = documents.get(key);
	if (open) return open.model.getValue();
	try {
		const res = await backend.read(path);
		return res.binary ? "" : res.text;
	} catch {
		return "";
	}
}

function renderPlanPreview(raw: string, path: string): Omit<HoverPreviewData, "path" | "relPath"> | null {
	const parsed = parsePlan(raw);
	if (!parsed.plan) return null;
	const plan = parsed.plan;
	const steps = plan.nodes.filter((n) => n.kind === "step" || n.kind === "call").length;
	const decisions = plan.nodes.filter((n) => n.kind === "decision").length;
	const stages = plan.groups.length;
	const tests = plan.tests?.length ?? 0;
	const goal = typeof plan.goal === "string" ? plan.goal.trim() : "";
	const ticket = typeof plan.ticket === "string" ? plan.ticket.trim() : "";

	const stats: string[] = [];
	if (steps) stats.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
	if (decisions) stats.push(`${decisions} ${decisions === 1 ? "decision" : "decisions"}`);
	if (stages) stats.push(`${stages} ${stages === 1 ? "stage" : "stages"}`);
	if (tests) stats.push(`${tests} ${tests === 1 ? "test" : "tests"}`);

	const groupNames = new Map(plan.groups.map((g) => [g.id, g.name]));
	const shownNodes = plan.nodes.filter((n) => n.kind !== "start").slice(0, 8);
	const listHtml = shownNodes.length
		? `<ul class="md-hover-plan-list">${shownNodes
				.map((n) => {
					const stage = n.group ? groupNames.get(n.group) : "";
					const tag = n.kind === "decision" ? "Decision" : n.kind === "end" ? "End" : "Step";
					return `<li><span class="md-hover-step-kind kind-${esc(n.kind)}">${tag}</span><span>${esc(n.text || n.id)}</span>${stage ? `<span class="md-hover-step-stage">${esc(stage)}</span>` : ""}</li>`;
				})
				.join("")}${plan.nodes.length - 1 > shownNodes.length ? `<li class="md-hover-more">+${plan.nodes.length - 1 - shownNodes.length} more steps</li>` : ""}</ul>`
		: "";

	const html = [
		goal ? `<p class="md-hover-goal">${esc(goal)}</p>` : "",
		stats.length ? `<div class="md-hover-stats">${stats.map((s) => `<span>${esc(s)}</span>`).join("")}</div>` : "",
		listHtml,
	]
		.filter(Boolean)
		.join("");

	return {
		title: plan.title || baseName(path).replace(/\.plan\.json$/i, ""),
		kind: "plan",
		badge: ticket || "Plan",
		html: html || `<p class="md-hover-empty">Empty process flowchart.</p>`,
	};
}

function renderCsvPreview(raw: string, path: string, filterTicket?: string): Omit<HoverPreviewData, "path" | "relPath"> | null {
	const table = parseCsv(raw);
	if (!table.header.length) return null;
	const ticketCol = table.header.findIndex((h) => h.text.trim().toLowerCase() === "ticket" || h.text.trim().toLowerCase() === "tickets");
	let rows = table.rows;
	let note = `${table.rows.length} ${table.rows.length === 1 ? "row" : "rows"}`;

	if (filterTicket && ticketCol >= 0) {
		const wanted = filterTicket.toLowerCase();
		const known = new Set(docs().flatMap((d) => (d.exists && d.group === "tickets" && d.ticket ? [d.ticket.toLowerCase()] : [])));
		known.add(wanted);
		const matching = table.rows.filter((r) =>
			keysIn(r[ticketCol]?.text ?? "", known).some((k) => k.toLowerCase() === wanted),
		);
		if (matching.length) {
			rows = matching;
			note = `${matching.length} of ${table.rows.length} rows for ${filterTicket}`;
		}
	}

	const maxCols = Math.min(table.header.length, 4);
	const headers = table.header.slice(0, maxCols);
	const shown = rows.slice(0, 6);
	const headHtml = `<tr>${headers.map((h) => `<th>${esc(h.text)}</th>`).join("")}</tr>`;
	const bodyHtml = shown
		.map((r) => `<tr>${headers.map((_, i) => `<td>${esc((r[i]?.text ?? "").slice(0, 60))}</td>`).join("")}</tr>`)
		.join("");
	const more = rows.length > shown.length ? `<p class="md-hover-more">+${rows.length - shown.length} more rows</p>` : "";

	return {
		title: registryTitle(path),
		kind: "table",
		badge: note,
		html: `<div class="md-hover-table-wrap"><table><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table></div>${more}`,
	};
}

/** Closes any unclosed fenced code block left open by slicing a preview to N lines. */
function closeDanglingFence(slice: string): string {
	let openFence: string | null = null;
	for (const line of slice.split(/\r?\n/)) {
		const trimmed = line.trimStart();
		if (!openFence) {
			const m = /^(`{3,}|~{3,})/.exec(trimmed);
			if (m) openFence = m[1]![0]!.repeat(m[1]!.length);
		} else if (trimmed.startsWith(openFence) && new RegExp(`^${openFence[0]}{${openFence.length},}\\s*$`).test(trimmed)) {
			openFence = null;
		}
	}
	return openFence ? `${slice}\n${openFence}` : slice;
}

/** Extracts just the requested heading section (stopping at the next heading of equal or higher level outside fenced code). */
function sliceHeadingSection(raw: string, startLine: number): string {
	const lines = raw.split(/\r?\n/);
	const headingLine = lines[startLine - 1] ?? "";
	const m = /^\s*(#{1,6})\s+/.exec(headingLine);
	const level = m ? m[1]!.length : 6;
	let openFence: string | null = null;
	let endIdx = lines.length;
	for (let i = startLine; i < lines.length; i++) {
		const trimmed = lines[i]!.trimStart();
		if (!openFence) {
			const fm = /^(`{3,}|~{3,})/.exec(trimmed);
			if (fm) {
				openFence = fm[1]![0]!.repeat(fm[1]!.length);
				continue;
			}
			const hm = /^#{1,6}(?=\s)/.exec(trimmed);
			if (hm && hm[0].length <= level) {
				endIdx = i;
				break;
			}
		} else if (trimmed.startsWith(openFence) && new RegExp(`^${openFence[0]}{${openFence.length},}\\s*$`).test(trimmed)) {
			openFence = null;
		}
	}
	return lines.slice(startLine - 1, endIdx).join("\n");
}

function buildFinishMarkdownOptions(path: string): { tickets: TicketRef[]; named: NameResolver } {
	const allDocs = docs();
	const wsRoot = state.workspace?.root;
	const tickets: TicketRef[] = allDocs
		.filter((d) => d.exists && d.group === "tickets" && d.ticket && canonical(d.path) !== canonical(path))
		.map((d) => ({
			key: d.ticket!,
			href: relativePath(dirName(path), d.path),
			about: [d.ticket, d.title, d.status ? `(${d.status})` : ""].filter(Boolean).join(" "),
		}));
	const named: NameResolver = (name) => {
		const found = docByName(name, allDocs, wsRoot);
		if (!found) return null;
		return {
			href: relativePath(dirName(path), found.path),
			about: found.title || found.name,
		};
	};
	return { tickets, named };
}

async function resolveWorkspaceEmbed(inner: string, fromPath: string): Promise<TransclusionLoaderResult | null> {
	const root = state.workspace?.root;
	const bar = inner.indexOf("|");
	const rawTarget = (bar < 0 ? inner : inner.slice(0, bar)).trim();
	const alias = bar < 0 ? undefined : inner.slice(bar + 1).trim() || undefined;
	const selfHeading = rawTarget.startsWith("#") ? rawTarget.slice(1).trim() : undefined;
	const parsed = selfHeading ? null : namedLink(inner);

	let targetPath: string | null = null;
	let fallbackPath: string | null = null;
	const heading = selfHeading ?? parsed?.heading;
	if (selfHeading) {
		targetPath = fromPath;
	} else if (parsed && root) {
		const found = docByName(parsed.name, docs(), root);
		if (found) {
			targetPath = found.path;
		} else if (parsed.name.includes("/") || /\.[a-z0-9]{1,8}$/i.test(parsed.name)) {
			const relCand = resolvePath(dirName(fromPath), parsed.name);
			const rootCand = resolvePath(root, parsed.name.replace(/^\/+/, ""));
			if (isInside(root, relCand)) {
				targetPath = relCand;
				if (isInside(root, rootCand) && canonical(rootCand) !== canonical(relCand)) fallbackPath = rootCand;
			} else if (isInside(root, rootCand)) {
				targetPath = rootCand;
			}
		}
	}
	if (!targetPath) return null;

	let usedPath = targetPath;
	let raw = await readText(targetPath);
	if (!raw.trim() && fallbackPath) {
		usedPath = fallbackPath;
		raw = await readText(fallbackPath);
	}
	if (!raw.trim()) return null;

	const docKey = canonical(usedPath);
	const key = heading ? `${docKey}#${heading.toLowerCase()}` : docKey;
	if (!/\.(md|markdown)$/i.test(usedPath)) {
		const ext = /\.([A-Za-z0-9_#-]+)$/.exec(usedPath)?.[1] ?? "";
		const lang = resolveCodeLanguage(ext) || ext;
		const codeLines = raw.split(/\r?\n/).slice(0, 32).join("\n");
		return {
			key,
			docKey,
			title: alias ?? baseName(usedPath),
			path: usedPath,
			markdown: `\`\`\`${lang}\n${codeLines}\n\`\`\``,
		};
	}

	const fm = frontMatter(raw);
	let body = fm.body;
	if (heading) {
		const ln = findHeadingLine(raw, heading);
		if (!ln) return null;
		body = sliceHeadingSection(raw, ln);
	}
	const bodyLines = body.split(/\r?\n/);
	const clipped = closeDanglingFence(bodyLines.slice(0, 40).join("\n"));
	const fmTitle = one(fm.values.title);
	const titleBase = fmTitle || baseName(usedPath).replace(/\.(md|markdown)$/i, "");
	return {
		key,
		docKey,
		title: alias ?? (heading ? `${titleBase} › ${heading}` : titleBase),
		path: usedPath,
		markdown: clipped,
	};
}

async function renderMarkdownPreview(
	raw: string,
	path: string,
	options: { heading?: string; line?: number; maxLines?: number; depth?: number; maxDepth?: number; visited?: ReadonlySet<string> },
): Promise<Omit<HoverPreviewData, "path" | "relPath">> {
	const fm = frontMatter(raw);
	let snippet = fm.body;
	let resolvedLine = options.line;
	let headingMissing = false;
	if (options.heading) {
		const ln = findHeadingLine(raw, options.heading);
		if (ln) {
			resolvedLine = ln;
			snippet = sliceHeadingSection(raw, ln);
		} else {
			headingMissing = true;
		}
	} else if (options.line && options.line > 1) {
		const lines = raw.split(/\r?\n/);
		const start = Math.max(fm.lines, options.line - 2);
		snippet = lines.slice(start).join("\n");
	}
	const maxLines = options.maxLines ?? 28;
	const snippetLines = snippet.split(/\r?\n/);
	const omitted = Math.max(0, snippetLines.length - maxLines);
	let previewMd = closeDanglingFence(snippetLines.slice(0, maxLines).join("\n"));
	if (!headingMissing && previewMd.includes("![[")) {
		const selfKey = options.heading ? `${canonical(path)}#${options.heading.toLowerCase()}` : canonical(path);
		const visited = new Set(options.visited ?? []);
		visited.add(selfKey);
		if (!options.heading) visited.add(canonical(path));
		previewMd = await expandTransclusionsMarkdown(previewMd, path, resolveWorkspaceEmbed, {
			depth: options.depth ?? 0,
			maxDepth: options.maxDepth ?? MAX_TRANSCLUSION_DEPTH,
			visited,
		});
	}
	const cleanHtml = headingMissing
		? `<p class="md-hover-empty">Heading “${esc(options.heading ?? "")}” not found in this document.</p>`
		: DOMPurify.sanitize(marked.parse(previewMd, { async: false, gfm: true }) as string);
	const { tickets, named } = buildFinishMarkdownOptions(path);
	const rendered = headingMissing ? cleanHtml : finishMarkdown(cleanHtml, { tickets, named });
	const moreFooter = !headingMissing && omitted > 0 ? `<p class="md-hover-more">… ${omitted} more line${omitted === 1 ? "" : "s"}</p>` : "";
	const html = rendered ? `${rendered}${moreFooter}` : `<p class="md-hover-empty">Empty document.</p>`;
	const fmTitle = one(fm.values.title);
	const fmTicket = one(fm.values.ticket);
	const fmStatus = one(fm.values.status);
	const title = fmTicket && fmTitle && !fmTitle.toLowerCase().startsWith(fmTicket.toLowerCase()) ? `${fmTicket}: ${fmTitle}` : fmTitle || baseName(path).replace(/\.(md|markdown)$/i, "");
	return {
		title,
		kind: "markdown",
		status: fmStatus || undefined,
		statusTone: fmStatus ? toneOf(fmStatus) : undefined,
		badge: !fmTitle && fmTicket ? fmTicket : undefined,
		html,
		line: resolvedLine,
	};
}

/** Builds a rich Markdown hover card preview for a footnote reference (`[^1]`). */
export function buildFootnoteHoverPreview(rawDoc: string, docPath: string, footnoteId: string): HoverPreviewData | null {
	const def = extractFootnoteDefinition(rawDoc, footnoteId);
	if (!def) return null;
	const cleanHtml = def.text
		? DOMPurify.sanitize(marked.parse(def.text, { async: false, gfm: true }) as string)
		: `<p class="md-hover-empty">Empty footnote definition.</p>`;
	const { tickets, named } = buildFinishMarkdownOptions(docPath);
	const html = def.text ? finishMarkdown(cleanHtml, { tickets, named }) : cleanHtml;
	return {
		path: docPath,
		relPath: relativeTo(state.workspace?.root, docPath),
		title: `Footnote [${footnoteId}]`,
		kind: "markdown",
		badge: `Line ${def.line}`,
		html,
		line: def.line,
	};
}

function renderCodePreview(raw: string, path: string, line?: number, maxLines = 20): Omit<HoverPreviewData, "path" | "relPath"> {
	const allLines = raw.split(/\r?\n/);
	const start = line && line > 1 ? Math.max(0, line - 3) : 0;
	const slice = allLines.slice(start, start + maxLines);
	const more = allLines.length > start + slice.length ? `\n… (${allLines.length - start - slice.length} more lines)` : "";
	const byFile = languageFor(path);
	const ext = /\.([A-Za-z0-9_#-]+)$/.exec(path)?.[1];
	const lang = byFile !== "plaintext" ? byFile : resolveCodeLanguage(ext);
	const cls = lang ? ` class="language-${esc(lang)}"` : "";
	return {
		title: baseName(path),
		kind: "code",
		html: `<pre class="md-hover-code"><code${cls}>${esc(slice.join("\n") + more)}</code></pre>`,
		line,
	};
}

/** Builds a rich hover preview card for any workspace document (Markdown, Plan, CSV/TSV registry, or code). */
export async function buildHoverPreview(
	path: string,
	options: {
		heading?: string;
		line?: number;
		ticket?: string;
		maxLines?: number;
		depth?: number;
		maxDepth?: number;
		visited?: ReadonlySet<string>;
	} = {},
): Promise<HoverPreviewData | null> {
	const raw = await readText(path);
	if (!raw.trim()) return null;
	const relPath = relativeTo(state.workspace?.root, path);

	if (/\.(md|markdown)$/i.test(path)) {
		return { path, relPath, ...(await renderMarkdownPreview(raw, path, options)) };
	}
	if (isPlanPath(path)) {
		const planPreview = renderPlanPreview(raw, path);
		return planPreview ? { path, relPath, ...planPreview } : null;
	}
	if (/\.(csv|tsv)$/i.test(path)) {
		const csvPreview = renderCsvPreview(raw, path, options.ticket);
		return csvPreview ? { path, relPath, ...csvPreview } : null;
	}
	return { path, relPath, ...renderCodePreview(raw, path, options.line, options.maxLines ?? 20) };
}
