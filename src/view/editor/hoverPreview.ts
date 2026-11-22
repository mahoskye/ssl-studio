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
import { baseName, relativeTo } from "../../shared/paths";
import { registryTitle, toneOf } from "../../shared/projectDocs";
import { backend } from "../backend";
import { isPlanPath, parsePlan } from "../plan/model";
import { canonical, documents, state } from "../state";
import { finishMarkdown } from "./markdownHtml";

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
		const matching = table.rows.filter((r) => (r[ticketCol]?.text ?? "").toLowerCase().includes(wanted));
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

function renderMarkdownPreview(raw: string, path: string, options: { heading?: string; line?: number }): Omit<HoverPreviewData, "path" | "relPath"> {
	const fm = frontMatter(raw);
	let snippet = fm.body;
	if (options.heading) {
		const ln = findHeadingLine(raw, options.heading);
		if (ln) snippet = raw.split(/\r?\n/).slice(ln - 1).join("\n");
	} else if (options.line && options.line > 1) {
		const lines = raw.split(/\r?\n/);
		const start = Math.max(fm.lines, options.line - 2);
		snippet = lines.slice(start).join("\n");
	}
	const previewMd = snippet.split(/\r?\n/).slice(0, 28).join("\n");
	const cleanHtml = DOMPurify.sanitize(marked.parse(previewMd, { async: false, gfm: true }) as string);
	const html = finishMarkdown(cleanHtml);
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
		html: html || `<p class="md-hover-empty">Empty document.</p>`,
		line: options.line,
	};
}

function renderCodePreview(raw: string, path: string, line?: number): Omit<HoverPreviewData, "path" | "relPath"> {
	const allLines = raw.split(/\r?\n/);
	const start = line && line > 1 ? Math.max(0, line - 3) : 0;
	const slice = allLines.slice(start, start + 20);
	const more = allLines.length > start + slice.length ? `\n… (${allLines.length - start - slice.length} more lines)` : "";
	return {
		title: baseName(path),
		kind: "code",
		html: `<pre class="md-hover-code"><code>${esc(slice.join("\n") + more)}</code></pre>`,
		line,
	};
}

/** Builds a rich hover preview card for any workspace document (Markdown, Plan, CSV/TSV registry, or code). */
export async function buildHoverPreview(
	path: string,
	options: { heading?: string; line?: number; ticket?: string } = {},
): Promise<HoverPreviewData | null> {
	const raw = await readText(path);
	if (!raw.trim()) return null;
	const relPath = relativeTo(state.workspace?.root, path);

	if (/\.(md|markdown)$/i.test(path)) {
		return { path, relPath, ...renderMarkdownPreview(raw, path, options) };
	}
	if (isPlanPath(path)) {
		const planPreview = renderPlanPreview(raw, path);
		return planPreview ? { path, relPath, ...planPreview } : null;
	}
	if (/\.(csv|tsv)$/i.test(path)) {
		const csvPreview = renderCsvPreview(raw, path, options.ticket);
		return csvPreview ? { path, relPath, ...csvPreview } : null;
	}
	return { path, relPath, ...renderCodePreview(raw, path, options.line) };
}
