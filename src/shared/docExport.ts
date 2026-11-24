// Pure stakeholder export & formatting helpers for SSL Studio documents:
// - Markdown -> Jira / Confluence wiki markup
// - Clean standalone print-ready HTML (PDF-ready via hidden iframe / browser print)
// - STARLIMS Release Readiness Gate evaluator
// - Ticket Release Packet assembler (ticket + readiness + specs + plans + sub-tickets + decisions + questions + registries + folder manifest)
import { csvRow } from "./csv";
import { frontMatter, one } from "./frontMatter";
import { isCatalog, registryTitle, toneOf } from "./projectDocs";
import type { DocFile } from "./protocol";
import { codeMatchesRef, descendantTickets, scriptsForTicket, ticketWork, workFor } from "./workContext";

const attachmentBasename = (rawPath: string): string => {
	const clean = rawPath.trim().split(/[?#]/)[0] ?? rawPath.trim();
	if (/^https?:\/\//i.test(clean)) return clean;
	let decoded = clean;
	try {
		decoded = decodeURIComponent(clean);
	} catch {
		// Keep raw path when percent-encoding is partial.
	}
	const norm = decoded.replace(/\\/g, "/").replace(/\/+$/, "");
	const slash = norm.lastIndexOf("/");
	return slash >= 0 ? norm.slice(slash + 1) : norm;
};

/** Escapes HTML special characters for safe interpolation inside exported HTML shells. */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Splits a GFM pipe table row on unescaped `|` outside backtick code spans. */
function splitMarkdownTableCells(row: string): string[] {
	let s = row.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	let inCode = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (ch === "\\" && !inCode && s[i + 1] === "|") {
			cur += "|";
			i++;
			continue;
		}
		if (ch === "`") {
			inCode = !inCode;
			cur += ch;
			continue;
		}
		if (ch === "|" && !inCode) {
			cells.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	cells.push(cur.trim());
	return cells;
}

/**
 * Converts GFM / Obsidian Markdown into clean Jira & Confluence wiki markup.
 * Handles YAML frontmatter stripping, fenced code blocks, callouts, headings,
 * pipe tables (with escaped pipes & inline code), lists (2/4-space or tab nesting),
 * links, wikilinks, highlights, and inline emphasis cleanly.
 */
export function markdownToJira(markdown: string): string {
	const raw = frontMatter(markdown).body.replace(/\r\n/g, "\n");
	const lines = raw.split("\n");
	const out: string[] = [];
	let i = 0;
	const listStack: { width: number; mark: "*" | "#" }[] = [];
	const listPrefix = (indentStr: string, mark: "*" | "#"): string => {
		const width = indentStr.replace(/\t/g, "    ").length;
		while (listStack.length > 0 && width < listStack[listStack.length - 1]!.width) {
			listStack.pop();
		}
		if (!listStack.length || width > listStack[listStack.length - 1]!.width) {
			listStack.push({ width, mark });
		} else {
			listStack[listStack.length - 1]!.mark = mark;
		}
		return listStack.map((item) => item.mark).join("");
	};

	const inline = (line: string, inTableCell = false): string => {
		// Strip HTML comments (e.g. <!-- toc -->) from prose.
		let s = line.replace(/<!--[\s\S]*?-->/g, "");
		// Protect inline code spans of ANY backtick run length (`...`, ``a `b` c``) before transforming emphasis/links.
		const spans: string[] = [];
		let masked = "";
		let ci = 0;
		while (ci < s.length) {
			if (s[ci] === "`") {
				let run = 0;
				while (ci + run < s.length && s[ci + run] === "`") run++;
				let j = ci + run;
				let close = -1;
				while (j < s.length) {
					if (s[j] !== "`") {
						j++;
						continue;
					}
					let cRun = 0;
					while (j + cRun < s.length && s[j + cRun] === "`") cRun++;
					if (cRun === run) {
						close = j;
						break;
					}
					j += cRun;
				}
				if (close >= 0) {
					let code = s.slice(ci + run, close);
					if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && /[^ ]/.test(code)) {
						code = code.slice(1, -1);
					}
					if (inTableCell) code = code.replace(/\|/g, "\\|");
					const token = `\u0000CODE${spans.length}\u0000`;
					spans.push(`{{${code}}}`);
					masked += token;
					ci = close + run;
					continue;
				}
				masked += s.slice(ci, ci + run);
				ci += run;
				continue;
			}
			masked += s[ci++];
		}
		s = masked;
		// Wiki embeds: only image extensions become Jira `!file.png!` (attachment basename only); note/heading embeds become readable labels.
		s = s.replace(/!\[\[([^[\]|#]+)(#[^[\]|]+)?(?:\|([^[\]]+))?\]\]/g, (_, target: string, hash?: string, alias?: string) => {
			const cleanTarget = target.trim();
			if (/\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(cleanTarget)) return `!${attachmentBasename(cleanTarget)}!`;
			return alias?.trim() || `${cleanTarget}${hash ? ` › ${hash.slice(1).trim()}` : ""}`;
		});
		// Wikilinks [[Target#Heading|Alias]], [[#Heading]], [[Target#Heading]], or [[Target]]
		s = s.replace(/\[\[([^[\]|]*)(?:\|([^[\]]+))?\]\]/g, (_, target: string, alias?: string) => {
			if (alias?.trim()) return alias.trim();
			const rawTarget = target.trim();
			const hashIdx = rawTarget.indexOf("#");
			if (hashIdx >= 0) {
				const docPart = rawTarget.slice(0, hashIdx).trim();
				const headingPart = rawTarget.slice(hashIdx + 1).trim();
				if (!docPart) return headingPart;
				return headingPart ? `${docPart} — ${headingPart}` : docPart;
			}
			return rawTarget;
		});
		// Markdown images ![alt](url) -> !filename.png! (basename for local paths; keep full remote http(s) URLs)
		s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, _alt: string, url: string) => `!${attachmentBasename(url)}!`);
		// Markdown links [text](url) -> [text|url] (protect from table-cell pipe escaping)
		const protectedTokens: string[] = [];
		const hold = (val: string) => {
			const tok = `\u0000FMT${protectedTokens.length}\u0000`;
			protectedTokens.push(val);
			return tok;
		};
		s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) => hold(`[${label}|${url}]`));
		if (inTableCell) s = s.replace(/(?<!\\)\|/g, "\\|");
		// Protect bold & bold-italic BEFORE single-* italic conversion so bold doesn't clash with italic.
		s = s.replace(/\*\*\*(?=\S)([^*\n]*?\S)\*\*\*/g, (_, body: string) => hold(`*_${body}_*`));
		s = s.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, (_, body: string) => hold(`*${body}*`));
		s = s.replace(/(^|[^\w])__(?=\S)([^_\n]*?\S)__(?=[^\w]|$)/g, (_, pre: string, body: string) => `${pre}${hold(`*${body}*`)}`);
		// Italic *text* -> Jira _text_ (require non-whitespace immediately inside `*...*` so `SELECT * FROM a * b` stays verbatim!)
		s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?=[^\w*]|$)/g, (_, pre: string, body: string) => `${pre}_${body}_`);
		// Strikethrough ~~text~~ -> -text-
		s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, "-$1-");
		// Highlight ==text== -> {color:#b45309}*text*{color}
		s = s.replace(/==(?=\S)([^=\n]*?\S)==/g, "{color:#b45309}*$1*{color}");
		// Restore held tokens & inline code spans
		s = s.replace(/\u0000FMT(\d+)\u0000/g, (_, idx: string) => protectedTokens[Number(idx)] ?? "");
		return s.replace(/\u0000CODE(\d+)\u0000/g, (_, idx: string) => spans[Number(idx)] ?? "");
	};

	while (i < lines.length) {
		const line = lines[i]!;

		// Fenced code blocks (supports info-string args like ```sql title="x") -> {code:lang}...{code}
		const fence = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)(?:[ \t]+.*)?$/.exec(line);
		if (fence && !(fence[1]![0] === "`" && line.slice(line.indexOf(fence[1]!) + fence[1]!.length).includes("`"))) {
			listStack.length = 0;
			const delim = fence[1]![0]!;
			const len = fence[1]!.length;
			const lang = fence[2]!.toLowerCase();
			const jiraLang =
				lang === "ssl" || lang === "srvscr" || lang === "ds" || lang === "mermaid" || lang === "mmd"
					? "none"
					: lang === "tsql" || lang === "plsql"
						? "sql"
						: lang === "xfd"
							? "xml"
							: lang === "jsonc"
								? "json"
								: lang;
			i++;
			const codeLines: string[] = [];
			while (i < lines.length) {
				const closeRe = new RegExp(`^[ \\t]{0,3}${delim}{${len},}[ \\t]*$`);
				if (closeRe.test(lines[i]!)) {
					i++;
					break;
				}
				codeLines.push(lines[i]!);
				i++;
			}
			out.push(jiraLang ? `{code:${jiraLang}}` : "{code}");
			out.push(...codeLines);
			out.push("{code}");
			continue;
		}

		// Skip single-line AND multi-line HTML comments (e.g. <!-- toc --> / <!-- /catalog --> / multi-line notes).
		if (/^[ \t]*<!--/.test(line)) {
			if (/-->[ \t]*$/.test(line)) {
				i++;
				continue;
			}
			i++;
			while (i < lines.length && !/-->/.test(lines[i]!)) i++;
			if (i < lines.length) i++;
			continue;
		}

		// Obsidian / GitHub callout block -> {panel:title=...}...{panel} (recursively converts nested lists, checklists, code blocks).
		const callout = /^[ \t]{0,3}>[ \t]*\[!([A-Za-z0-9_-]+)\][+-]?[ \t]*(.*)$/.exec(line);
		if (callout) {
			listStack.length = 0;
			const kind = callout[1]!.toUpperCase();
			const title = callout[2]!.trim() || kind;
			i++;
			const rawBody: string[] = [];
			while (i < lines.length && /^[ \t]{0,3}>/.test(lines[i]!)) {
				rawBody.push(lines[i]!.replace(/^[ \t]{0,3}>[ \t]?/, ""));
				i++;
			}
			const converted = rawBody.length ? markdownToJira(rawBody.join("\n")).trimEnd() : "";
			out.push(`{panel:title=${title}}`);
			if (converted) out.push(converted);
			out.push("{panel}");
			continue;
		}

		// Standard blockquote (recursively converts nested lists/code)
		if (/^[ \t]{0,3}>[ \t]?/.test(line)) {
			listStack.length = 0;
			const rawBody: string[] = [];
			while (i < lines.length && /^[ \t]{0,3}>/.test(lines[i]!)) {
				rawBody.push(lines[i]!.replace(/^[ \t]{0,3}>[ \t]?/, ""));
				i++;
			}
			const converted = rawBody.length ? markdownToJira(rawBody.join("\n")).trimEnd() : "";
			out.push("{quote}", ...(converted ? [converted] : []), "{quote}");
			continue;
		}

		// GFM pipe table
		if (line.includes("|") && i + 1 < lines.length && /^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/.test(lines[i + 1]!)) {
			listStack.length = 0;
			const splitRow = (row: string) => splitMarkdownTableCells(row).map((c) => inline(c, true));
			const headers = splitRow(line);
			out.push(`||${headers.join("||")}||`);
			i += 2;
			while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
				const cells = splitRow(lines[i]!);
				out.push(`|${cells.map((c) => c || " ").join("|")}|`);
				i++;
			}
			continue;
		}

		// ATX headings #..###### -> h1..h6.
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			listStack.length = 0;
			out.push(`h${heading[1]!.length}. ${inline(heading[2]!.replace(/\s+#+\s*$/, "").trim())}`);
			i++;
			continue;
		}

		// Horizontal rule
		if (/^[ \t]*(?:[-*_][ \t]*){3,}$/.test(line)) {
			listStack.length = 0;
			out.push("----");
			i++;
			continue;
		}

		// Task list items -> * (/) or * (-)
		const task = /^([ \t]*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
		if (task) {
			const prefix = listPrefix(task[1]!, "*");
			const mark = task[2]!.toLowerCase() === "x" ? "(/)" : "(-)";
			out.push(`${prefix} ${mark} ${inline(task[3]!)}`);
			i++;
			continue;
		}

		// Unordered lists
		const ul = /^([ \t]*)[-*+]\s+(.*)$/.exec(line);
		if (ul) {
			const prefix = listPrefix(ul[1]!, "*");
			out.push(`${prefix} ${inline(ul[2]!)}`);
			i++;
			continue;
		}

		// Ordered lists
		const ol = /^([ \t]*)\d+[.)]\s+(.*)$/.exec(line);
		if (ol) {
			const prefix = listPrefix(ol[1]!, "#");
			out.push(`${prefix} ${inline(ol[2]!)}`);
			i++;
			continue;
		}

		if (!line.trim()) listStack.length = 0;
		out.push(inline(line));
		i++;
	}

	return out.join("\n").trim() + "\n";
}

const EXPORT_META_FIELDS: readonly [string, string][] = [
	["ticket", "Ticket"],
	["status", "Status"],
	["type", "Type"],
	["priority", "Priority"],
	["release", "Release"],
	["version", "Version"],
	["owner", "Owner"],
	["reviewer", "Reviewer"],
	["approved-by", "Approved by"],
	["approved-date", "Approved date"],
	["change-control", "Change control"],
	["gxp-impact", "GxP impact"],
	["parent", "Parent"],
	["with", "System"],
	["direction", "Direction"],
	["tags", "Tags"],
	["date", "Date"],
	["asked", "Asked"],
	["answered", "Answered"],
	["supersedes", "Supersedes"],
	["superseded-by", "Superseded by"],
	["source", "Source"],
];

/** Extracts curated governance & document properties from YAML frontmatter for HTML/PDF/DOCX metadata headers. */
export function extractExportMeta(markdown: string): Record<string, string> {
	const { values } = frontMatter(markdown);
	const out: Record<string, string> = {};
	for (const [key, label] of EXPORT_META_FIELDS) {
		const val = one(values[key]);
		if (val) out[label] = val;
	}
	return out;
}

/** Renders a clean print-friendly HTML metadata header card when frontmatter properties exist. */
export function renderFrontMatterSummaryHtml(meta: Record<string, string>): string {
	const entries = Object.entries(meta).filter(([k, v]) => k.trim() && v.trim());
	if (!entries.length) return "";
	const items = entries
		.map(([k, v]) => `<div class="doc-meta-item"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
		.join("");
	return `<section class="doc-meta-card" aria-label="Document properties"><dl class="doc-meta-grid">${items}</dl></section>`;
}

/** Escapes a string safely for interpolation inside a CSS `content: "..."` literal within `<style>`. */
function escapeCssString(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\r?\n/g, " ")
		.replace(/</g, "\\3c ")
		.replace(/>/g, "\\3e ");
}

function lookupMetaField(meta: Record<string, string> | undefined, ...keys: string[]): string {
	if (!meta) return "";
	const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");
	const wanted = new Set(keys.map(norm));
	for (const [k, v] of Object.entries(meta)) {
		if (wanted.has(norm(k)) && v.trim()) return v.trim();
	}
	return "";
}

/**
 * Wraps sanitized rendered HTML in a clean standalone print-ready HTML document
 * suitable for saving, emailing, or Print -> Save as PDF.
 */
export function buildPrintableHtml(
	title: string,
	bodyHtml: string,
	subtitle?: string,
	metaHtml?: string,
	meta?: Record<string, string>,
): string {
	const pageTitle = lookupMetaField(meta, "title") || title;
	const version = lookupMetaField(meta, "version");
	const status = lookupMetaField(meta, "status");
	const changeControl = lookupMetaField(meta, "change-control", "change control", "changeControl");
	const generatedDate = lookupMetaField(meta, "date", "generated", "approved-date");
	const verLabel = version ? (/^v/i.test(version) ? version : `v${version}`) : "";
	const topRight = [verLabel, status, changeControl].filter(Boolean).join(" · ");
	const bottomLeft = generatedDate || subtitle || "";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 24px 56px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14.5px;
    line-height: 1.62;
    color: #18181b;
    background: #ffffff;
  }
  main { max-width: 820px; margin: 0 auto; }
  header.doc-banner { margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid #e4e4e7; }
  header.doc-banner h1 { margin: 0; font-size: 1.75rem; line-height: 1.25; border-bottom: none; padding-bottom: 0; }
  header.doc-banner p { margin: 6px 0 0; font-size: 0.9rem; color: #52525b; }
  .doc-meta-card {
    margin: 0 0 20px;
    padding: 10px 14px;
    border: 1px solid #e4e4e7;
    border-radius: 6px;
    background: #fafafa;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px 16px;
    margin: 0;
  }
  .doc-meta-item { min-width: 0; }
  .doc-meta-item dt {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: #71717a;
    margin: 0 0 1px;
  }
  .doc-meta-item dd {
    margin: 0;
    font-size: 0.88rem;
    color: #18181b;
    overflow-wrap: anywhere;
  }
  h1, h2, h3, h4, h5, h6 { color: #09090b; margin-top: 1.5em; margin-bottom: 0.5em; line-height: 1.3; break-after: avoid; page-break-after: avoid; }
  h1 { font-size: 1.65rem; border-bottom: 1px solid #e4e4e7; padding-bottom: 0.25em; }
  h2 { font-size: 1.3rem; border-bottom: 1px solid #f4f4f5; padding-bottom: 0.2em; }
  h3 { font-size: 1.08rem; }
  p, ul, ol, blockquote, pre, table, figure { margin: 0 0 1em; }
  a { color: #1d4ed8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; background: #f4f4f5; padding: 0.12em 0.35em; border-radius: 4px; }
  pre { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 14px; overflow-x: auto; break-inside: avoid; page-break-inside: avoid; }
  pre code { background: none; padding: 0; font-size: 0.86em; }
  blockquote { margin-left: 0; padding: 8px 14px; border-left: 3px solid #94a3b8; background: #f8fafc; color: #334155; break-inside: avoid; page-break-inside: avoid; }
  .md-callout { margin: 0 0 1em; padding: 10px 14px; border-radius: 6px; border: 1px solid #cbd5e1; border-left: 4px solid #2563eb; background: #eff6ff; break-inside: avoid; page-break-inside: avoid; }
  .md-callout.tone-warning, .md-callout.tone-warn, .md-callout-warning, .md-callout-caution { border-left-color: #d97706; background: #fffbeb; }
  .md-callout.tone-danger, .md-callout.tone-error, .md-callout-danger, .md-callout-failure, .md-callout-bug { border-left-color: #dc2626; background: #fef2f2; }
  .md-callout.tone-tip, .md-callout.tone-ok, .md-callout.tone-success, .md-callout.tone-done, .md-callout-tip, .md-callout-success, .md-callout-check { border-left-color: #16a34a; background: #f0fdf4; }
  .md-callout.tone-accent, .md-callout.tone-important { border-left-color: #7c3aed; background: #f5f3ff; }
  .md-callout.tone-quote, .md-callout.tone-muted, .md-callout-quote { border-left-color: #64748b; background: #f8fafc; }
  .md-callout-head, .md-callout-title { display: flex; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 4px; color: #0f172a; }
  .md-callout-icon { font-style: normal; font-weight: 700; }
  .md-callout > :last-child { margin-bottom: 0; }
  .md-footnotes { margin-top: 28px; padding-top: 12px; border-top: 1px solid #e4e4e7; font-size: 0.88em; color: #3f3f46; }
  .md-footnotes ol { padding-left: 1.4em; margin: 0; }
  .md-footnotes li { margin-bottom: 4px; }
  sup.md-fn-ref a { text-decoration: none; font-weight: 600; }
  mark, .md-highlight { background: #fef08a; color: #18181b; padding: 0.05em 0.25em; border-radius: 3px; }
  .md-tag { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 0.84em; background: #f4f4f5; color: #3f3f46; border: 1px solid #e4e4e7; }
  .md-mermaid-export { text-align: center; padding: 12px; border: 1px solid #e4e4e7; border-radius: 6px; background: #ffffff; break-inside: avoid; page-break-inside: avoid; }
  /* Compact KaTeX standalone HTML / Print layout CSS */
  .md-math-display, .katex-display { display: block; margin: 1em 0; text-align: center; overflow-x: auto; overflow-y: hidden; }
  .katex { font: normal 1.08em/1.2 KaTeX_Main, "Cambria Math", "STIX Two Math", "Times New Roman", Georgia, serif; text-indent: 0; text-rendering: auto; }
  .katex .katex-mathml { position: absolute; clip: rect(1px, 1px, 1px, 1px); padding: 0; border: 0; height: 1px; width: 1px; overflow: hidden; }
  .katex .katex-html { display: inline-block; }
  .katex .base { position: relative; display: inline-block; white-space: nowrap; width: min-content; }
  .katex .strut { display: inline-block; }
  .katex .mathnormal, .katex .mathit { font-style: italic; }
  .katex .mathbf, .katex .textbf { font-weight: 700; }
  .katex .mathrm, .katex .textrm { font-style: normal; }
  .katex .mathtt, .katex .texttt { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .katex .mbin { margin: 0 0.22em; }
  .katex .mrel { margin: 0 0.28em; }
  .katex .mpunct { margin-right: 0.16em; }
  .katex .mfrac { display: inline-flex; flex-direction: column; align-items: center; vertical-align: middle; margin: 0 0.12em; }
  .katex .mfrac .frac-line { display: inline-block; width: 100%; border-bottom: 0.06em solid currentColor; }
  .katex .msupsub { text-align: left; }
  .katex .vlist-t { display: inline-table; table-layout: fixed; border-collapse: collapse; }
  .katex .vlist-t2 { margin-right: -2px; }
  .katex .vlist-r { display: table-row; }
  .katex .vlist { display: table-cell; vertical-align: bottom; position: relative; }
  .katex .vlist > span { display: block; height: 0; position: relative; }
  .katex .vlist > span > span { display: inline-block; }
  .katex .pstrut { overflow: hidden; width: 0; display: inline-block; }
  .katex .vlist-s { display: table-cell; vertical-align: bottom; font-size: 1px; width: 2px; min-width: 2px; }
  .katex .sizing.reset-size6.size3, .katex .fontsize-ensurer.reset-size6.size3 { font-size: 0.7em; }
  .katex .sizing.reset-size6.size1, .katex .fontsize-ensurer.reset-size6.size1 { font-size: 0.5em; }
  .katex .sqrt > .root { margin-left: 0.28em; margin-right: -0.55em; }
  .katex .delimsizing, .katex .nulldelimiter { display: inline-block; }
  .katex .mspace { display: inline-block; }
  .katex .overline .overline-line { border-bottom: 0.04em solid currentColor; display: inline-block; width: 100%; }
  .katex .underline .underline-line { border-bottom: 0.04em solid currentColor; display: inline-block; width: 100%; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  th, td { border: 1px solid #e4e4e7; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f4f4f5; font-weight: 600; }
  hr { border: 0; border-top: 1px solid #e4e4e7; margin: 24px 0; }
  img, svg { max-width: 100%; height: auto; break-inside: avoid; page-break-inside: avoid; }
  @page {
    margin: 18mm 14mm 18mm 14mm;
    @top-left {
      content: "${escapeCssString(pageTitle)}";
      font-size: 8.5pt;
      color: #71717a;
    }
    @top-right {
      content: "${escapeCssString(topRight)}";
      font-size: 8.5pt;
      color: #71717a;
    }
    @bottom-left {
      content: "${escapeCssString(bottomLeft)}";
      font-size: 8.5pt;
      color: #71717a;
    }
    @bottom-right {
      content: "Page " counter(page) " of " counter(pages);
      font-size: 8.5pt;
      color: #71717a;
    }
  }
  @media print {
    body { padding: 0; font-size: 11pt; }
    main { max-width: none; }
    a { color: #18181b; text-decoration: underline; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    pre, blockquote, .md-callout, .md-mermaid-export, .doc-meta-card { break-inside: avoid; page-break-inside: avoid; }
    h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
  }
</style>
</head>
<body>
<main>
${subtitle ? `<header class="doc-banner"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></header>` : ""}
${metaHtml ?? ""}
${bodyHtml}
</main>
</body>
</html>`;
}

/** Escapes pipes/newlines and clips plain visible cell text cleanly so generated Markdown tables respect ADR 0008. */
function clipTableCell(text: string, maxLen: number): string {
	const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
	const visibleLen = cleaned.replace(/[`*_~]/g, "").length;
	if (visibleLen <= maxLen) return cleaned.replace(/\|/g, "\\|");
	let cut = cleaned.slice(0, Math.max(1, maxLen - 1)).trimEnd();
	if ((cut.match(/`/g)?.length ?? 0) % 2 === 1) {
		const lastTick = cut.lastIndexOf("`");
		if (lastTick > 0) cut = cut.slice(0, lastTick).trimEnd();
	}
	return `${cut}…`.replace(/\|/g, "\\|");
}

// --- IQ/OQ/PQ Validation Test Execution Evidence -----------------------------

export type TestRunPhase = "IQ" | "OQ" | "PQ";
export type TestRunResult = "pass" | "fail" | "partial";

export type TestRunCaseOutcome = {
	caseId: string;
	result: string;
	evidence: string;
	notes: string;
};

export type TestRunSummary = {
	path: string;
	title?: string;
	ticket: string;
	phase: TestRunPhase;
	environment: string;
	gitSha: string;
	executedBy: string;
	executedDate: string;
	result: TestRunResult;
	cases: TestRunCaseOutcome[];
};

export type TestExecutionProtocolInput = {
	ticketKey: string;
	ticketTitle?: string;
	phase: TestRunPhase;
	environment: string;
	gitSha?: string;
	executedBy?: string;
	executedDate?: string;
	projectName?: string;
	planTests?: readonly { name: string; given?: string; expect?: string; plan?: string }[];
	checklistItems?: readonly string[];
	testScripts?: readonly string[];
	changeControl?: string;
};

/** Returns true when a validation test run was executed against a different Git SHA than `currentGitSha`. */
export function isTestRunStale(run: Pick<TestRunSummary, "gitSha">, currentGitSha?: string | null): boolean {
	const a = (run.gitSha ?? "").trim().toLowerCase();
	const b = (currentGitSha ?? "").trim().toLowerCase();
	if (!a || !b) return false;
	if (a.startsWith(b) || b.startsWith(a)) return false;
	return true;
}

function normalizeTestRunPhase(raw: string | undefined): TestRunPhase | null {
	const u = (raw ?? "").trim().toUpperCase();
	if (u === "IQ" || u.startsWith("IQ ") || u.startsWith("IQ-") || u.startsWith("IQ—")) return "IQ";
	if (u === "OQ" || u.startsWith("OQ ") || u.startsWith("OQ-") || u.startsWith("OQ—")) return "OQ";
	if (u === "PQ" || u.startsWith("PQ ") || u.startsWith("PQ-") || u.startsWith("PQ—")) return "PQ";
	return null;
}

function normalizeTestRunResult(raw: string | undefined): TestRunResult | null {
	const l = (raw ?? "").trim().toLowerCase();
	if (!l) return null;
	if (/^(?:pass|passed|ok|complete|completed|verified)$/.test(l)) return "pass";
	if (/^(?:fail|failed|error|rejected)$/.test(l)) return "fail";
	if (/^(?:partial|pending|in progress|blocked|draft|incomplete|mixed)$/.test(l)) return "partial";
	return null;
}

/**
 * Pure parser for IQ/OQ/PQ Validation Test Run Markdown documents.
 * Extracts frontmatter governance fields (`ticket`, `phase`, `environment`, `git-sha`,
 * `executed-by`, `executed-date`, `result`) and per-case outcomes from an ADR-0008
 * 4-column table (`Case | Result | Evidence | Notes`).
 * Returns `null` for documents that are not validation test runs.
 */
export function parseTestRunDocument(path: string, text: string): TestRunSummary | null {
	const { values, body } = frontMatter(text);
	const rawType = (one(values.type) ?? "").trim().toLowerCase();
	const explicitPhase = normalizeTestRunPhase(one(values.phase)) ?? normalizeTestRunPhase(rawType);
	const isTaggedTestRun =
		explicitPhase !== null ||
		rawType === "test-run" ||
		rawType === "test_run" ||
		rawType === "testrun" ||
		rawType === "validation" ||
		rawType === "validation-run";

	// Extract per-case outcomes from any ADR-0008 `Case | Result | Evidence | Notes` pipe table outside fenced code.
	const lines = body.replace(/\r\n/g, "\n").split("\n");
	const cases: TestRunCaseOutcome[] = [];
	let foundCaseTable = false;
	let fenceChar = "";
	let fenceLen = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
		if (f) {
			if (!fenceChar) {
				fenceChar = f[1]![0]!;
				fenceLen = f[1]!.length;
			} else if (f[1]![0] === fenceChar && f[1]!.length >= fenceLen && /^[ \t]*$/.test(line.slice(f[0].length))) {
				fenceChar = "";
				fenceLen = 0;
			}
			continue;
		}
		if (fenceChar) continue;

		if (line.includes("|") && i + 1 < lines.length && /^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/.test(lines[i + 1]!)) {
			const headers = splitMarkdownTableCells(line).map((h) => h.trim().toLowerCase());
			const caseIdx = headers.findIndex((h) => h === "case" || h === "case id" || h === "caseid" || h === "test case" || h === "id");
			const resultIdx = headers.findIndex((h) => h === "result" || h === "status" || h === "outcome" || h === "verdict");
			const evidenceIdx = headers.findIndex((h) => h === "evidence" || h === "artifact" || h === "proof");
			const notesIdx = headers.findIndex((h) => h === "notes" || h === "note" || h === "details" || h === "comments");

			if (caseIdx >= 0 && resultIdx >= 0) {
				foundCaseTable = true;
				i += 2;
				while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
					const cells = splitMarkdownTableCells(lines[i]!);
					const caseId = (cells[caseIdx] ?? "").replace(/^`(.+)`$/, "$1").trim();
					const caseResult = (cells[resultIdx] ?? "").trim();
					const evidence = evidenceIdx >= 0 ? (cells[evidenceIdx] ?? "").trim() : "";
					const notes = notesIdx >= 0 ? (cells[notesIdx] ?? "").trim() : "";
					if (caseId || caseResult || evidence || notes) {
						cases.push({ caseId, result: caseResult, evidence, notes });
					}
					i++;
				}
				i--;
			}
		}
	}

	if (!isTaggedTestRun && !foundCaseTable) return null;

	const firstTicket =
		one(values.ticket) ||
		(Array.isArray(values.tickets) ? String(values.tickets[0] ?? "").trim() : one(values.tickets)) ||
		"";
	const environment = one(values.environment) || one(values.env) || "";
	const gitSha = one(values["git-sha"]) || one(values.gitSha) || one(values.git_sha) || one(values.sha) || one(values.commit) || "";
	const executedBy = one(values["executed-by"]) || one(values.executedBy) || one(values.executed_by) || one(values.tester) || "";
	const executedDate = one(values["executed-date"]) || one(values.executedDate) || one(values.executed_date) || one(values.date) || "";
	const headingTitle = /^[ \t]{0,3}#[ \t]+(.+)$/m.exec(body)?.[1]?.trim();
	const title = one(values.title) || headingTitle || undefined;

	// Infer result from case rows when frontmatter omits `result`, or honor explicit frontmatter result.
	let result: TestRunResult = normalizeTestRunResult(one(values.result) || one(values.outcome) || one(values.verdict)) ?? "partial";
	const hasExplicitResult = normalizeTestRunResult(one(values.result) || one(values.outcome) || one(values.verdict)) !== null;
	if (!hasExplicitResult && cases.length > 0) {
		const caseStatuses = cases.map((c) => c.result.trim().toLowerCase());
		if (caseStatuses.some((s) => /^(?:fail|failed|error|no)$/.test(s))) {
			result = "fail";
		} else if (caseStatuses.every((s) => /^(?:pass|passed|ok|yes)$/.test(s))) {
			result = "pass";
		} else {
			result = "partial";
		}
	}

	return {
		path,
		...(title ? { title } : {}),
		ticket: firstTicket,
		phase: explicitPhase ?? "OQ",
		environment,
		gitSha,
		executedBy,
		executedDate,
		result,
		cases,
	};
}

/**
 * Generates a pre-populated IQ/OQ/PQ Validation Test Execution Protocol Markdown document
 * from `plan.tests`, ticket checklist items, `testScripts`, `gitSha`, `phase`, and `environment`.
 * All generated tables strictly conform to ADR 0008 (<= 4 columns, short non-last cells).
 */
export function assembleTestExecutionProtocol(input: TestExecutionProtocolInput): string {
	const date = input.executedDate?.trim() || new Date().toISOString().slice(0, 10);
	const sha = input.gitSha?.trim() ?? "";
	const title = `${input.ticketKey} ${input.phase} Validation Test Run`;
	const fmLines: string[] = [
		"---",
		`title: ${JSON.stringify(title)}`,
		"type: test-run",
		`ticket: ${input.ticketKey}`,
		`phase: ${input.phase}`,
		`environment: ${input.environment}`,
		`git-sha: ${sha}`,
		`executed-by: ${input.executedBy?.trim() ?? ""}`,
		`executed-date: ${date}`,
		...(input.changeControl?.trim() ? [`change-control: ${input.changeControl.trim()}`] : []),
		"result: partial",
		"status: draft",
		"---",
	];

	const parts: string[] = [
		...fmLines,
		"",
		`# ${input.ticketKey}: ${input.phase} Validation Test Run`,
		"",
		`_${[
			input.projectName?.trim() || "",
			input.ticketTitle?.trim() || "",
			`Env: ${input.environment}`,
			sha ? `Git SHA \`${sha.slice(0, 12)}\`` : "",
		]
			.filter(Boolean)
			.join(" · ")}_`,
		"",
		"> [!important] Validation Protocol",
		"> Record objective evidence (screenshots, query output, audit IDs) for every executed case before QA sign-off.",
		"",
	];

	const uniqueScripts = [...new Set((input.testScripts ?? []).map((s) => s.trim()).filter(Boolean))];
	if (uniqueScripts.length) {
		parts.push("## Linked Automated Test Scripts", "");
		for (const s of uniqueScripts) parts.push(`- \`${s}\``);
		parts.push("");
	}

	const rows: [string, string, string, string][] = [];
	let tcNum = 1;
	for (const pt of input.planTests ?? []) {
		const id = `TC-${String(tcNum++).padStart(2, "0")}`;
		const detail = [pt.name.trim(), pt.given?.trim() ? `Given ${pt.given.trim()}` : "", pt.expect?.trim() ? `Expect ${pt.expect.trim()}` : ""]
			.filter(Boolean)
			.join(" — ");
		rows.push([id, "pending", "", clipTableCell(detail || "Plan test case", 98)]);
	}
	for (const item of input.checklistItems ?? []) {
		const clean = item.replace(/^[-*+]\s+\[[ xX]\]\s+/, "").trim();
		if (!clean) continue;
		const id = `TC-${String(tcNum++).padStart(2, "0")}`;
		rows.push([id, "pending", "", clipTableCell(clean, 98)]);
	}
	let tsNum = 1;
	for (const script of uniqueScripts) {
		const id = `TS-${String(tsNum++).padStart(2, "0")}`;
		rows.push([id, "pending", "", clipTableCell(`Run automated test script \`${script}\``, 98)]);
	}
	if (!rows.length) {
		rows.push(["TC-01", "pending", "", "Verify primary ticket acceptance behavior"]);
	}

	parts.push("## Test Case Execution", "", "| Case | Result | Evidence | Notes |", "| --- | --- | --- | --- |");
	for (const [cid, res, ev, notes] of rows) {
		parts.push(`| ${clipTableCell(cid, 20)} | ${clipTableCell(res, 20)} | ${clipTableCell(ev, 20)} | ${notes} |`);
	}
	parts.push("", "## Deviations & Sign-Off", "", "- **Deviations:** None", "- **QA Reviewer:** ", "- **Sign-Off Date:** ", "");
	return parts.join("\n");
}

function summarizeTicketTestRuns(
	runs: readonly TestRunSummary[],
	currentGitSha?: string | null,
): {
	badge: string;
	ok: boolean;
	level: "pass" | "warn";
	detail: string;
	stale: boolean;
	primaryPath: string;
	runLines: string[];
} | null {
	if (!runs.length) return null;
	const sorted = runs.slice().sort((a, b) => (b.executedDate || "").localeCompare(a.executedDate || ""));
	const phases = [...new Set(runs.map((r) => r.phase))].join("/");
	const failed = sorted.filter((r) => r.result === "fail");
	const freshPassed = sorted.filter((r) => r.result === "pass" && !isTestRunStale(r, currentGitSha));
	const stalePassed = sorted.filter((r) => r.result === "pass" && isTestRunStale(r, currentGitSha));

	const runLines = sorted.map((r) => {
		const staleFlag = isTestRunStale(r, currentGitSha);
		const shaPart = r.gitSha ? ` @ ${r.gitSha.slice(0, 12)}` : "";
		const whoPart = r.executedBy ? ` by ${r.executedBy}` : "";
		const datePart = r.executedDate ? ` (${r.executedDate})` : "";
		const envPart = r.environment ? ` (${r.environment})` : "";
		return `${r.phase}${envPart}: ${r.result.toUpperCase()}${staleFlag ? " [STALE SHA]" : ""}${shaPart}${whoPart}${datePart}`;
	});

	if (failed.length) {
		const f = failed[0]!;
		const badge = `${f.phase} FAIL`.slice(0, 20);
		return {
			badge,
			ok: false,
			level: "warn",
			detail: `${f.phase} failed${f.environment ? ` in ${f.environment}` : ""}${f.executedDate ? ` (${f.executedDate})` : ""}`,
			stale: isTestRunStale(f, currentGitSha),
			primaryPath: f.path,
			runLines,
		};
	}
	if (freshPassed.length) {
		const p = freshPassed[0]!;
		const badge = `${phases} PASS`.length <= 20 ? `${phases} PASS` : "PASS";
		return {
			badge,
			ok: true,
			level: "pass",
			detail: `${phases} passed${p.environment ? ` in ${p.environment}` : ""}${p.gitSha ? ` @ ${p.gitSha.slice(0, 8)}` : ""}`,
			stale: false,
			primaryPath: p.path,
			runLines,
		};
	}
	if (stalePassed.length) {
		const s = stalePassed[0]!;
		const badge = `${s.phase} STALE`.slice(0, 20);
		return {
			badge,
			ok: false,
			level: "warn",
			detail: `${s.phase} passed on stale SHA ${s.gitSha.slice(0, 8)} (current ${(currentGitSha ?? "").slice(0, 8)}) — re-run required`,
			stale: true,
			primaryPath: s.path,
			runLines,
		};
	}
	const latest = sorted[0]!;
	const stale = isTestRunStale(latest, currentGitSha);
	const badge = `${latest.phase} PARTIAL`.slice(0, 20);
	return {
		badge,
		ok: false,
		level: "warn",
		detail: `${latest.phase} validation partial/incomplete${stale ? ` (stale SHA ${latest.gitSha.slice(0, 8)})` : ""}`,
		stale,
		primaryPath: latest.path,
		runLines,
	};
}

// --- STARLIMS Release Readiness Gate -----------------------------------------

export type ReadinessCheck = {
	label: string;
	ok: boolean;
	level: "pass" | "warn" | "note";
	detail: string;
	path?: string;
};

export type ReadinessReport = {
	key: string;
	ready: boolean;
	pass: number;
	total: number;
	checks: ReadinessCheck[];
};

export type TicketReadinessOptions = {
	gitFiles?: readonly { path: string }[];
	root?: string | null;
	testRuns?: readonly TestRunSummary[];
	currentGitSha?: string | null;
};

export type TicketReadinessInput = TicketReadinessOptions;

/** Evaluates a ticket's transport / CAB release readiness from workspace docs, registries, validation runs, and optional Git changes. */
export function evaluateTicketReadiness(
	files: readonly DocFile[],
	key: string,
	options?: TicketReadinessInput,
): ReadinessReport | null {
	const work = workFor(files, key);
	if (!work) return null;
	const checks: ReadinessCheck[] = [];
	const ticket = work.ticket;

	// 1. Ticket checklist tasks
	if (ticket.tasks && ticket.tasks.total > 0) {
		const ok = ticket.tasks.done >= ticket.tasks.total;
		checks.push({
			label: "Acceptance checklist",
			ok,
			level: ok ? "pass" : "warn",
			detail: `${ticket.tasks.done}/${ticket.tasks.total} items checked`,
			path: ticket.path,
		});
	}

	// 2. Sub-tickets done — walks recursive descendants (epic -> story -> task), excluding dropped/cancelled.
	const subtickets = descendantTickets(files, key);
	const activeSubtickets = subtickets.filter((s) => toneOf(s.status) !== "off");
	if (activeSubtickets.length) {
		const open = activeSubtickets.filter((s) => toneOf(s.status) !== "done");
		checks.push({
			label: "Sub-tickets",
			ok: open.length === 0,
			level: open.length === 0 ? "pass" : "warn",
			detail: open.length === 0 ? `All ${activeSubtickets.length} done` : `${open.length} of ${activeSubtickets.length} still open (${open[0]!.ticket ?? open[0]!.name})`,
			path: open[0]?.path ?? activeSubtickets[0]!.path,
		});
	}

	// 2b. Unresolved blockers (`blocked-by`) — including external/unimported blocker keys.
	if (ticket.blockedBy?.length) {
		const byTicketKey = new Map(files.filter((f) => f.exists && f.group === "tickets" && f.ticket).map((f) => [f.ticket!.toLowerCase(), f]));
		const unresolvedLabels: string[] = [];
		let firstPath: string | undefined;
		for (const bk of ticket.blockedBy) {
			const b = byTicketKey.get(bk.toLowerCase());
			if (!b) {
				unresolvedLabels.push(`${bk} (not in workspace)`);
				if (!firstPath) firstPath = ticket.path;
			} else if (toneOf(b.status) !== "done" && toneOf(b.status) !== "off") {
				unresolvedLabels.push(`${b.ticket} (${b.status || "open"})`);
				if (!firstPath) firstPath = b.path;
			}
		}
		if (unresolvedLabels.length) {
			checks.push({
				label: "Blockers",
				ok: false,
				level: "warn",
				detail: `Blocked by ${unresolvedLabels.join(", ")}`,
				path: firstPath,
			});
		}
	}

	// Collect scope across the ticket itself AND any active sub-tickets (for Epics).
	const scopeKeys = [key, ...activeSubtickets.map((s) => s.ticket).filter((k): k is string => Boolean(k))];
	const scopeKeySet = new Set(scopeKeys.map((k) => k.toLowerCase()));
	const scopeWorks = scopeKeys.map((k) => workFor(files, k)).filter((w): w is NonNullable<typeof w> => Boolean(w));
	const scopeGroups = scopeKeys.flatMap((k) => ticketWork(files, k));
	const dedupeDocs = (list: DocFile[]) => {
		const seen = new Set<string>();
		const out: DocFile[] = [];
		for (const d of list) {
			const k = d.path.toLowerCase();
			if (!seen.has(k)) {
				seen.add(k);
				out.push(d);
			}
		}
		return out;
	};

	// 3. Linked specs status (including sub-ticket specs)
	const allSpecs = dedupeDocs(scopeWorks.flatMap((w) => w.specs));
	if (allSpecs.length) {
		const open = allSpecs.filter((s) => {
			const t = toneOf(s.status);
			return t === "active" || t === "waiting";
		});
		const formallyApproved = allSpecs.filter((s) => Boolean(s.approvedBy?.trim()));
		checks.push({
			label: "Specifications",
			ok: open.length === 0,
			level: open.length === 0 ? "pass" : "warn",
			detail:
				open.length === 0
					? formallyApproved.length === allSpecs.length
						? `${allSpecs.length} formally approved`
						: formallyApproved.length > 0
							? `${allSpecs.length} settled (${formallyApproved.length}/${allSpecs.length} formally approved)`
							: `${allSpecs.length} settled (no formal approved-by recorded)`
					: `${open.length} still ${open[0]!.status} (${open[0]!.title || open[0]!.name})`,
			path: open[0]?.path ?? allSpecs[0]!.path,
		});
	}

	// 3b. Controlled-document governance & explicit approval check (ISO-17025 / GxP)
	const controlledCandidates = dedupeDocs([ticket, ...activeSubtickets, ...allSpecs]);
	const hasHighGxp = (d: DocFile) => Boolean(d.gxpImpact?.trim() && !/^(?:none|no|n\/a|low|false|0)$/i.test(d.gxpImpact.trim()));
	const hasGovMeta = (d: DocFile) =>
		Boolean(d.approvedBy || d.approvedDate || d.reviewer || d.changeControl || d.gxpImpact || d.version);
	const governedDocs = controlledCandidates.filter(hasGovMeta);
	const unverifiedApprovedSpecs = allSpecs.filter(
		(s) => (s.status ?? "").trim().toLowerCase() === "approved" && !s.approvedBy?.trim(),
	);
	if (governedDocs.length || unverifiedApprovedSpecs.length) {
		const missingHighGxp = governedDocs.filter((d) => (hasHighGxp(d) || Boolean(d.changeControl?.trim())) && !d.approvedBy?.trim());
		const incompleteApproval = governedDocs.filter((d) => Boolean(d.approvedBy?.trim()) !== Boolean(d.approvedDate?.trim()));
		const approvedDocs = governedDocs.filter((d) => Boolean(d.approvedBy?.trim() && d.approvedDate?.trim()));
		if (missingHighGxp.length) {
			const first = missingHighGxp[0]!;
			checks.push({
				label: "Controlled approval",
				ok: false,
				level: "warn",
				detail: `Missing formal approved-by sign-off on ${first.ticket ?? first.title ?? first.name}${first.changeControl ? ` (${first.changeControl})` : ""}`,
				path: first.path,
			});
		} else if (incompleteApproval.length) {
			const first = incompleteApproval[0]!;
			checks.push({
				label: "Controlled approval",
				ok: false,
				level: "note",
				detail: `Incomplete approval metadata on ${first.ticket ?? first.title ?? first.name} (needs both approved-by and approved-date)`,
				path: first.path,
			});
		} else if (unverifiedApprovedSpecs.length) {
			const first = unverifiedApprovedSpecs[0]!;
			checks.push({
				label: "Controlled approval",
				ok: false,
				level: "note",
				detail: `${first.title || first.name} is marked approved without approved-by / approved-date metadata`,
				path: first.path,
			});
		} else if (approvedDocs.length) {
			const primary = approvedDocs[0]!;
			checks.push({
				label: "Controlled approval",
				ok: true,
				level: "pass",
				detail:
					approvedDocs.length === 1
						? `Approved by ${primary.approvedBy} on ${primary.approvedDate}`
						: `${approvedDocs.length} controlled docs formally approved`,
				path: primary.path,
			});
		}
	}

	// 4. Open questions (across ticket & sub-tickets)
	const openQuestions = dedupeDocs(scopeGroups.filter((g) => g.kind === "question").flatMap((g) => g.files));
	checks.push({
		label: "Open questions",
		ok: openQuestions.length === 0,
		level: openQuestions.length === 0 ? "pass" : "warn",
		detail: openQuestions.length === 0 ? "None open" : `${openQuestions.length} unanswered (${openQuestions[0]!.title || openQuestions[0]!.name})`,
		path: openQuestions[0]?.path,
	});

	// 5. Linked CSV registries (settings, database, interfaces, etc., rolled up across sub-tickets)
	const registries = dedupeDocs(scopeGroups.filter((g) => g.kind === "registry").flatMap((g) => g.files));
	if (registries.length) {
		let totalRows = 0;
		let trackedRows = 0;
		let doneRows = 0;
		let firstPending: DocFile | undefined;
		let brokenReg: DocFile | undefined;
		for (const reg of registries) {
			if (reg.problems?.length && !brokenReg) brokenReg = reg;
			for (const entry of reg.forTickets ?? []) {
				if (!scopeKeySet.has(entry.key.toLowerCase())) continue;
				totalRows += entry.rows;
				if (entry.done !== undefined) {
					trackedRows += entry.rows;
					doneRows += entry.done;
					if (entry.done < entry.rows && !firstPending) firstPending = reg;
				}
			}
		}
		if (brokenReg) {
			checks.push({
				label: "Registry syntax",
				ok: false,
				level: "warn",
				detail: `${registryTitle(brokenReg.name)} has CSV errors: ${brokenReg.problems![0]}`,
				path: brokenReg.path,
			});
		}
		if (totalRows > 0) {
			if (trackedRows === 0) {
				checks.push({
					label: "Registry rows",
					ok: false,
					level: "note",
					detail: `${totalRows} ${totalRows === 1 ? "row" : "rows"} (no status column to verify)`,
					path: registries[0]!.path,
				});
			} else {
				const ok = doneRows >= trackedRows;
				checks.push({
					label: "Registry rows",
					ok,
					level: ok ? "pass" : "warn",
					detail: ok ? `${doneRows}/${trackedRows} verified or migrated` : `${doneRows}/${trackedRows} done — ${firstPending ? registryTitle(firstPending.name) : "pending rows"}`,
					path: firstPending?.path ?? registries[0]!.path,
				});
			}
		}
	}

	// 5b. Test scripts (`plan.built.tests` / `testScripts`) and business test cases (`plan.tests` / `planTests`)
	const allPlans = dedupeDocs(scopeGroups.filter((g) => g.kind === "plan").flatMap((g) => g.files));
	const scopeTestScripts = [
		...new Set(
			[ticket, ...activeSubtickets, ...allSpecs, ...allPlans].flatMap((d) => d.testScripts ?? []).map((s) => s.trim()).filter(Boolean),
		),
	];
	const scopePlanTests = allPlans.flatMap((p) => p.planTests ?? []);
	if (scopeTestScripts.length > 0 || scopePlanTests.length > 0 || allPlans.length > 0) {
		const hasTests = scopeTestScripts.length > 0 || scopePlanTests.length > 0;
		const summaryBits = [
			scopeTestScripts.length ? `${scopeTestScripts.length} ${scopeTestScripts.length === 1 ? "test script" : "test scripts"}` : "",
			scopePlanTests.length ? `${scopePlanTests.length} ${scopePlanTests.length === 1 ? "plan test case" : "plan test cases"}` : "",
		].filter(Boolean);
		checks.push({
			label: "Test coverage",
			ok: hasTests,
			level: hasTests ? "pass" : "note",
			detail: hasTests ? summaryBits.join(", ") : "No linked test scripts or plan business test cases yet",
			path: allPlans[0]?.path ?? ticket.path,
		});
	}

	// 5c. IQ/OQ/PQ Validation Test Execution Evidence (when testRuns are supplied)
	if (options?.testRuns?.length) {
		const matchingRuns = options.testRuns.filter((r) => scopeKeySet.has(r.ticket.trim().toLowerCase()));
		const summary = summarizeTicketTestRuns(matchingRuns, options.currentGitSha);
		if (summary) {
			checks.push({
				label: "Validation runs",
				ok: summary.ok,
				level: summary.level,
				detail: summary.detail,
				path: summary.primaryPath,
			});
		}
	}

	// 6. Broken links / missing refs / missingSource across ticket, sub-tickets & linked docs
	const scopeDocs = dedupeDocs([ticket, ...activeSubtickets, ...scopeGroups.flatMap((g) => (g.kind === "registry" ? [] : g.files))]).filter((d) => !isCatalog(d));
	const withBroken = scopeDocs.find((d) => (d.broken?.length ?? 0) > 0 || (d.missing?.length ?? 0) > 0 || Boolean(d.missingSource));
	checks.push({
		label: "Document links",
		ok: !withBroken,
		level: !withBroken ? "pass" : "warn",
		detail: !withBroken
			? "No broken links or missing refs"
			: withBroken.missingSource
				? `Missing source file (${withBroken.missingSource}) in ${withBroken.ticket ?? withBroken.title ?? withBroken.name}`
				: `Broken link or missing ref in ${withBroken.ticket ?? withBroken.title ?? withBroken.name}`,
		path: withBroken?.path,
	});

	// 7. Uncommitted Git changes touching this ticket's (or sub-tickets') scripts/docs (advisory note)
	if (options?.gitFiles) {
		const scriptRefs = [...new Set(scopeKeys.flatMap((k) => scriptsForTicket(files, k)))];
		const scopePaths = new Set(scopeDocs.map((d) => d.path.replace(/\\/g, "/").toLowerCase()));
		const bundlePrefixes = [ticket, ...activeSubtickets]
			.map((t) => (t.ticketFolder ? `${t.ticketFolder.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}/` : ""))
			.filter(Boolean);
		const dirty = options.gitFiles.filter((gf) => {
			const norm = gf.path.replace(/\\/g, "/").toLowerCase();
			if (scopePaths.has(norm)) return true;
			if (bundlePrefixes.some((bp) => norm.startsWith(bp))) return true;
			return scriptRefs.some((ref) => codeMatchesRef(gf.path, ref, options.root));
		});
		checks.push({
			label: "Working tree",
			ok: dirty.length === 0,
			level: dirty.length === 0 ? "pass" : "note",
			detail: dirty.length === 0 ? "All ticket scripts & docs committed" : `${dirty.length} uncommitted ${dirty.length === 1 ? "file" : "files"} tied to ${key}`,
			path: dirty[0]?.path,
		});
	}

	const pass = checks.filter((c) => c.ok).length;
	const hasWarn = checks.some((c) => c.level === "warn");
	return {
		key,
		ready: !hasWarn,
		pass,
		total: checks.length,
		checks,
	};
}

export type PlanBusinessTest = {
	name: string;
	given?: string;
	expect?: string;
	plan?: string;
	ticket?: string;
};

export type TicketPacketInput = {
	projectName: string;
	generatedOn: string;
	ticketKey: string;
	ticketTitle: string;
	status?: string;
	parent?: string;
	release?: string;
	priority?: string;
	version?: string;
	owner?: string;
	reviewer?: string;
	approvedBy?: string;
	approvedDate?: string;
	changeControl?: string;
	gxpImpact?: string;
	ticketBody: string;
	specs: { title: string; status?: string; body: string }[];
	plans: { name: string; title?: string; status?: string; scripts?: string[]; testScripts?: string[]; planTests?: { name: string; given?: string; expect?: string }[] }[];
	testScripts?: string[];
	planTests?: PlanBusinessTest[];
	subtickets?: { key: string; title: string; status?: string }[];
	related?: { key: string; title: string; status?: string }[];
	decisions: { title: string; status?: string; body: string }[];
	questions: { title: string; status?: string; body: string }[];
	references?: { title: string; status?: string; body: string }[];
	schemas?: { title: string; status?: string; body: string }[];
	registries: { title: string; headers: string[]; rows: string[][] }[];
	ticketFiles: { rel: string }[];
	totalTicketFiles?: number;
	readiness?: ReadinessReport | null;
	testRuns?: readonly TestRunSummary[];
	currentGitSha?: string;
};

/** Demotes ATX headings inside an embedded Markdown body so its highest heading starts at `minLevel` (respecting fenced code blocks). */
export function demoteMarkdownHeadings(markdown: string, minLevel: number): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let fenceChar = "";
	let fenceLen = 0;
	let shallowest = 7;
	for (const line of lines) {
		const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
		if (f) {
			if (!fenceChar) {
				fenceChar = f[1]![0]!;
				fenceLen = f[1]!.length;
			} else if (f[1]![0] === fenceChar && f[1]!.length >= fenceLen && /^[ \t]*$/.test(line.slice(f[0].length))) {
				fenceChar = "";
				fenceLen = 0;
			}
			continue;
		}
		if (fenceChar) continue;
		const h = /^[ \t]{0,3}(#{1,6})[ \t]+/.exec(line);
		if (h && h[1]!.length < shallowest) shallowest = h[1]!.length;
	}
	if (shallowest >= minLevel || shallowest > 6) return markdown;
	const shift = minLevel - shallowest;
	fenceChar = "";
	fenceLen = 0;
	return lines
		.map((line) => {
			const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
			if (f) {
				if (!fenceChar) {
					fenceChar = f[1]![0]!;
					fenceLen = f[1]!.length;
				} else if (f[1]![0] === fenceChar && f[1]!.length >= fenceLen && /^[ \t]*$/.test(line.slice(f[0].length))) {
					fenceChar = "";
					fenceLen = 0;
				}
				return line;
			}
			if (fenceChar) return line;
			return line.replace(/^([ \t]{0,3})(#{1,6})([ \t]+)/, (_, indent: string, hashes: string, sp: string) => `${indent}${"#".repeat(Math.min(6, hashes.length + shift))}${sp}`);
		})
		.join("\n");
}

/** Applies `replaceFn` only to segments outside inline backtick code spans of any run length. */
function replaceOutsideInlineCode(line: string, replaceFn: (segment: string) => string): string {
	let out = "";
	let plainStart = 0;
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\\" && i + 1 < line.length) {
			i += 2;
			continue;
		}
		if (line[i] === "`") {
			let run = 0;
			while (i + run < line.length && line[i + run] === "`") run++;
			let j = i + run;
			let close = -1;
			while (j < line.length) {
				if (line[j] !== "`") {
					j++;
					continue;
				}
				let cRun = 0;
				while (j + cRun < line.length && line[j + cRun] === "`") cRun++;
				if (cRun === run) {
					close = j;
					break;
				}
				j += cRun;
			}
			if (close >= 0) {
				if (i > plainStart) out += replaceFn(line.slice(plainStart, i));
				out += line.slice(i, close + run);
				i = close + run;
				plainStart = i;
				continue;
			}
			i += run;
			continue;
		}
		i++;
	}
	if (plainStart < line.length) out += replaceFn(line.slice(plainStart));
	return out;
}

const isFootnoteWordChar = (ch: string | undefined) => Boolean(ch && /[A-Za-z0-9_]/.test(ch));

function isSafeFootnoteUrl(rawUrl: string): boolean {
	const clean = rawUrl.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
	if (!clean || clean.startsWith("//")) return false;
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(clean);
	if (scheme) return /^(?:https?|mailto)$/i.test(scheme[1]!);
	return true;
}

function findInlineDelimClose(text: string, start: number, delim: string, wordBounded = false): number {
	if (start >= text.length || /\s/.test(text[start]!)) return -1;
	let i = start;
	while (i <= text.length - delim.length) {
		if (text[i] === "\\" && i + 1 < text.length) {
			i += 2;
			continue;
		}
		if (text[i] === "`") {
			let run = 0;
			while (i + run < text.length && text[i + run] === "`") run++;
			const end = text.indexOf("`".repeat(run), i + run);
			if (end >= 0) {
				i = end + run;
				continue;
			}
			i += run;
			continue;
		}
		if (text.startsWith(delim, i) && i > start && !/\s/.test(text[i - 1]!)) {
			if (wordBounded && isFootnoteWordChar(text[i + delim.length])) {
				i++;
				continue;
			}
			return i;
		}
		i++;
	}
	return -1;
}

function findInlineBracketClose(text: string, openIdx: number): number {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		if (text[i] === "\\" && i + 1 < text.length) {
			i++;
			continue;
		}
		if (text[i] === "[") depth++;
		else if (text[i] === "]") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function parseInlineLinkDest(text: string, openParenIdx: number): { url: string; end: number } | null {
	if (text[openParenIdx] !== "(") return null;
	let i = openParenIdx + 1;
	while (i < text.length && /\s/.test(text[i]!)) i++;
	if (i >= text.length) return null;
	let url = "";
	if (text[i] === "<") {
		const closeAngle = text.indexOf(">", i + 1);
		if (closeAngle < 0) return null;
		url = text.slice(i + 1, closeAngle).trim();
		i = closeAngle + 1;
	} else {
		let depth = 0;
		const start = i;
		while (i < text.length) {
			const ch = text[i]!;
			if (ch === "\\" && i + 1 < text.length) {
				i += 2;
				continue;
			}
			if (ch === "(") depth++;
			else if (ch === ")") {
				if (depth === 0) break;
				depth--;
			} else if (/\s/.test(ch) && depth === 0) break;
			i++;
		}
		url = text.slice(start, i).trim();
	}
	while (i < text.length && /\s/.test(text[i]!)) i++;
	if (text[i] === '"' || text[i] === "'") {
		const q = text[i]!;
		i++;
		while (i < text.length && text[i] !== q) {
			if (text[i] === "\\" && i + 1 < text.length) i += 2;
			else i++;
		}
		if (i < text.length) i++;
		while (i < text.length && /\s/.test(text[i]!)) i++;
	}
	if (text[i] !== ")") return null;
	return { url, end: i + 1 };
}

/**
 * Pure, XSS-safe inline Markdown-to-HTML renderer for HTML footnote definitions.
 * Handles inline code spans, safe links `[text](url)`, autolinks, `**bold**`, `*italic*`,
 * `~~strike~~`, and `==highlight==`, while HTML-escaping all raw text and blocking unsafe URL schemes.
 */
function renderFootnoteInlineHtml(text: string): string {
	let out = "";
	let plain = "";
	const flush = () => {
		if (plain) {
			out += escapeHtml(plain);
			plain = "";
		}
	};

	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;

		if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!~|=<>]/.test(text[i + 1]!)) {
			plain += text[i + 1]!;
			i += 2;
			continue;
		}

		// Inline code span (any backtick run length)
		if (ch === "`") {
			let run = 0;
			while (i + run < text.length && text[i + run] === "`") run++;
			let j = i + run;
			let close = -1;
			while (j < text.length) {
				if (text[j] !== "`") {
					j++;
					continue;
				}
				let cRun = 0;
				while (j + cRun < text.length && text[j + cRun] === "`") cRun++;
				if (cRun === run) {
					close = j;
					break;
				}
				j += cRun;
			}
			if (close >= 0) {
				let inner = text.slice(i + run, close);
				if (inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ") && /[^ ]/.test(inner)) {
					inner = inner.slice(1, -1);
				}
				flush();
				out += `<code>${escapeHtml(inner)}</code>`;
				i = close + run;
				continue;
			}
			plain += text.slice(i, i + run);
			i += run;
			continue;
		}

		// Markdown link `[label](url)`
		if (ch === "[") {
			const closeBr = findInlineBracketClose(text, i);
			if (closeBr >= 0 && text[closeBr + 1] === "(") {
				const dest = parseInlineLinkDest(text, closeBr + 1);
				if (dest) {
					const labelHtml = renderFootnoteInlineHtml(text.slice(i + 1, closeBr));
					flush();
					if (isSafeFootnoteUrl(dest.url)) {
						const extAttrs = /^https?:\/\//i.test(dest.url) ? ' target="_blank" rel="noopener noreferrer"' : "";
						out += `<a href="${escapeHtml(dest.url)}"${extAttrs}>${labelHtml}</a>`;
					} else {
						out += labelHtml;
					}
					i = dest.end;
					continue;
				}
			}
		}

		// Autolink `<https://...>` or `<mailto:...>`
		if (ch === "<") {
			const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(text.slice(i));
			if (m && isSafeFootnoteUrl(m[1]!)) {
				const url = m[1]!;
				const label = url.startsWith("mailto:") ? url.slice(7) : url;
				flush();
				const extAttrs = /^https?:\/\//i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : "";
				out += `<a href="${escapeHtml(url)}"${extAttrs}>${escapeHtml(label)}</a>`;
				i += m[0].length;
				continue;
			}
		}

		// Bold-italic `***...***` or `___...___`
		if ((ch === "*" && text.startsWith("***", i)) || (ch === "_" && text.startsWith("___", i) && !isFootnoteWordChar(text[i - 1]))) {
			const delim = ch.repeat(3);
			const close = findInlineDelimClose(text, i + 3, delim, ch === "_");
			if (close >= 0) {
				flush();
				out += `<strong><em>${renderFootnoteInlineHtml(text.slice(i + 3, close))}</em></strong>`;
				i = close + 3;
				continue;
			}
		}

		// Bold `**...**` or `__...__`
		if ((ch === "*" && text.startsWith("**", i)) || (ch === "_" && text.startsWith("__", i) && !isFootnoteWordChar(text[i - 1]))) {
			const delim = ch.repeat(2);
			const close = findInlineDelimClose(text, i + 2, delim, ch === "_");
			if (close >= 0) {
				flush();
				out += `<strong>${renderFootnoteInlineHtml(text.slice(i + 2, close))}</strong>`;
				i = close + 2;
				continue;
			}
		}

		// Strikethrough `~~...~~`
		if (ch === "~" && text.startsWith("~~", i)) {
			const close = findInlineDelimClose(text, i + 2, "~~");
			if (close >= 0) {
				flush();
				out += `<del>${renderFootnoteInlineHtml(text.slice(i + 2, close))}</del>`;
				i = close + 2;
				continue;
			}
		}

		// Highlight `==...==`
		if (ch === "=" && text.startsWith("==", i)) {
			const close = findInlineDelimClose(text, i + 2, "==");
			if (close >= 0) {
				flush();
				out += `<mark>${renderFootnoteInlineHtml(text.slice(i + 2, close))}</mark>`;
				i = close + 2;
				continue;
			}
		}

		// Italic `*...*` or `_..._`
		if (ch === "*" || (ch === "_" && !isFootnoteWordChar(text[i - 1]))) {
			const close = findInlineDelimClose(text, i + 1, ch, ch === "_");
			if (close >= 0) {
				flush();
				out += `<em>${renderFootnoteInlineHtml(text.slice(i + 1, close))}</em>`;
				i = close + 1;
				continue;
			}
		}

		plain += ch;
		i++;
	}

	flush();
	return out;
}

/**
 * Converts GFM footnotes (`[^id]` references and `[^id]: definition` blocks outside fenced code
 * and inline backtick code spans) into clean superscript links + a bottom `<section class="md-footnotes">`
 * block with safe inline Markdown rendering for HTML/PDF exports, or strips/inlines them cleanly for Jira markup.
 */
export function transformMarkdownFootnotes(markdown: string, target: "html" | "jira"): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const defs = new Map<string, string>();
	const kept: string[] = [];
	let fenceChar = "";
	let fenceLen = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
		if (f) {
			if (!fenceChar) {
				fenceChar = f[1]![0]!;
				fenceLen = f[1]!.length;
			} else if (f[1]![0] === fenceChar && f[1]!.length >= fenceLen && /^[ \t]*$/.test(line.slice(f[0].length))) {
				fenceChar = "";
				fenceLen = 0;
			}
			kept.push(line);
			continue;
		}
		if (fenceChar) {
			kept.push(line);
			continue;
		}
		const dm = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line);
		if (dm) {
			const id = dm[1]!;
			const parts = [dm[2]!.trim()];
			while (i + 1 < lines.length && /^(?: {2,}|\t)\S/.test(lines[i + 1]!)) {
				parts.push(lines[++i]!.trim());
			}
			defs.set(id, parts.filter(Boolean).join(" "));
			continue;
		}
		kept.push(line);
	}
	if (!defs.size) return markdown;

	const order: string[] = [];
	const numOf = (id: string) => {
		let idx = order.indexOf(id);
		if (idx < 0) {
			order.push(id);
			idx = order.length - 1;
		}
		return idx + 1;
	};
	fenceChar = "";
	fenceLen = 0;
	const replaced = kept.map((line) => {
		const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
		if (f) {
			if (!fenceChar) {
				fenceChar = f[1]![0]!;
				fenceLen = f[1]!.length;
			} else if (f[1]![0] === fenceChar && f[1]!.length >= fenceLen && /^[ \t]*$/.test(line.slice(f[0].length))) {
				fenceChar = "";
				fenceLen = 0;
			}
			return line;
		}
		if (fenceChar) return line;
		return replaceOutsideInlineCode(line, (seg) =>
			seg.replace(/\[\^([^\]\s]+)\]/g, (full, id: string) => {
				if (!defs.has(id)) return full;
				const n = numOf(id);
				if (target === "jira") return `^[${n}]^`;
				return `<sup class="md-fn-ref"><a href="#fn-${encodeURIComponent(id)}" id="fnref-${encodeURIComponent(id)}">${n}</a></sup>`;
			}),
		);
	});
	// Also append any defined-but-unreferenced footnotes so nothing is dropped.
	for (const id of defs.keys()) numOf(id);

	if (target === "jira") {
		const footLines = order.map((id, idx) => `${idx + 1}. ${defs.get(id) ?? ""}`);
		return `${replaced.join("\n").trimEnd()}\n\n----\n\n${footLines.join("\n")}\n`;
	}
	const items = order
		.map(
			(id) =>
				`<li id="fn-${escapeHtml(id)}">${renderFootnoteInlineHtml(defs.get(id) ?? "")} <a href="#fnref-${escapeHtml(id)}" aria-label="Back to content">↩</a></li>`,
		)
		.join("");
	return `${replaced.join("\n").trimEnd()}\n\n<section class="md-footnotes"><ol>${items}</ol></section>\n`;
}

/**
 * Adds minimal inline styles to tables, code blocks, and callouts in HTML fragments
 * copied to the clipboard (`html-copy`) so Word, Outlook, Teams, and Confluence Cloud
 * preserve borders, shading, and callout accents without a `<style>` tag.
 */
export function inlineExportStyles(html: string): string {
	return html
		.replace(/<table(?=[ >])/g, '<table style="border-collapse:collapse;width:100%;margin:0 0 12px;font-size:13.5px;"')
		.replace(/<th(?=[ >])/g, '<th style="border:1px solid #d4d4d8;background:#f4f4f5;padding:6px 10px;text-align:left;font-weight:600;"')
		.replace(/<td(?=[ >])/g, '<td style="border:1px solid #d4d4d8;padding:6px 10px;text-align:left;vertical-align:top;"')
		.replace(/<pre(?=[ >])/g, '<pre style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;font-family:Consolas,Menlo,monospace;font-size:12.5px;overflow-x:auto;"')
		.replace(/<blockquote(?=[ >])/g, '<blockquote style="margin:0 0 12px;padding:8px 14px;border-left:3px solid #94a3b8;background:#f8fafc;color:#334155;"')
		.replace(/<div class="([^"]*md-callout[^"]*)"/g, (_, cls: string) => {
			let border = "#2563eb";
			let bg = "#eff6ff";
			if (/tone-warn|tone-warning/.test(cls)) (border = "#d97706"), (bg = "#fffbeb");
			else if (/tone-danger|tone-error/.test(cls)) (border = "#dc2626"), (bg = "#fef2f2");
			else if (/tone-ok|tone-tip|tone-success|tone-done/.test(cls)) (border = "#16a34a"), (bg = "#f0fdf4");
			else if (/tone-accent|tone-important/.test(cls)) (border = "#7c3aed"), (bg = "#f5f3ff");
			else if (/tone-quote|tone-muted/.test(cls)) (border = "#64748b"), (bg = "#f8fafc");
			return `<div class="${cls}" style="margin:0 0 12px;padding:10px 14px;border:1px solid #cbd5e1;border-left:4px solid ${border};border-radius:6px;background:${bg};"`;
		});
}

/** Assembles a complete stakeholder release packet Markdown dossier for a ticket. */
export function assembleTicketPacketMarkdown(input: TicketPacketInput): string {
	const escCell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
	const embedBody = (raw: string, minLevel: number) => {
		const cleaned = frontMatter(raw).body.replace(/^\s*#\s+.*\r?\n/, "").trim();
		return cleaned ? demoteMarkdownHeadings(cleaned, minLevel) : "";
	};
	const parts: string[] = [
		`# ${input.ticketKey}: ${input.ticketTitle}`,
		"",
		"| Field | Value |",
		"| --- | --- |",
		`| Project | ${escCell(input.projectName)} |`,
		`| Ticket | ${escCell(input.ticketKey)} |`,
		`| Status | ${escCell(input.status || "—")} |`,
		...(input.parent ? [`| Parent | ${escCell(input.parent)} |`] : []),
		...(input.release ? [`| Release | ${escCell(input.release)} |`] : []),
		...(input.priority ? [`| Priority | ${escCell(input.priority)} |`] : []),
		...(input.version ? [`| Version | ${escCell(input.version)} |`] : []),
		...(input.owner ? [`| Owner | ${escCell(input.owner)} |`] : []),
		...(input.reviewer ? [`| Reviewer | ${escCell(input.reviewer)} |`] : []),
		...(input.approvedBy
			? [`| Approved by | ${escCell(input.approvedDate ? `${input.approvedBy} (${input.approvedDate})` : input.approvedBy)} |`]
			: []),
		...(input.changeControl ? [`| Change control | ${escCell(input.changeControl)} |`] : []),
		...(input.gxpImpact ? [`| GxP impact | ${escCell(input.gxpImpact)} |`] : []),
		`| Generated | ${escCell(input.generatedOn)} |`,
		"",
	];

	if (input.readiness && input.readiness.checks.length) {
		parts.push(
			"## Release Readiness Gate",
			"",
			`Status: **${input.readiness.ready ? "Ready for release" : "Attention needed"}** (${input.readiness.pass}/${input.readiness.total} checks passing)`,
			"",
			"| Check | Status | Details |",
			"| --- | --- | --- |",
		);
		for (const c of input.readiness.checks) {
			const badge = c.level === "pass" ? "PASS" : c.level === "warn" ? "WARN" : "NOTE";
			parts.push(`| ${escCell(c.label)} | ${badge} | ${escCell(c.detail)} |`);
		}
		parts.push("");
	}

	const cleanBody = embedBody(input.ticketBody, 3);
	if (cleanBody) {
		parts.push("## Summary & Requirements", "", cleanBody, "");
	}

	if (input.subtickets?.length) {
		parts.push("## Sub-tickets", "", "| Ticket | Status | Title |", "| --- | --- | --- |");
		for (const s of input.subtickets) {
			parts.push(`| ${escCell(s.key)} | ${escCell(s.status || "—")} | ${escCell(s.title)} |`);
		}
		parts.push("");
	}

	if (input.related?.length) {
		parts.push("## Related Tickets", "", "| Ticket | Status | Title |", "| --- | --- | --- |");
		for (const r of input.related) {
			parts.push(`| ${escCell(r.key)} | ${escCell(r.status || "—")} | ${escCell(r.title)} |`);
		}
		parts.push("");
	}

	if (input.specs.length) {
		parts.push("## Specifications", "");
		for (const spec of input.specs) {
			parts.push(`### ${spec.title}${spec.status ? ` (${spec.status})` : ""}`, "");
			const b = embedBody(spec.body, 4);
			if (b) parts.push(b, "");
		}
	}

	if (input.plans.length) {
		parts.push("## Plans", "", "| Plan | Status | Target scripts |", "| --- | --- | --- |");
		for (const p of input.plans) {
			const scriptCell = p.scripts?.length ? p.scripts.join(", ") : "—";
			parts.push(`| ${escCell(p.title || p.name)} | ${escCell(p.status || "—")} | ${escCell(scriptCell)} |`);
		}
		parts.push("");
	}

	// Verification & Test Coverage (from plan.built.tests / testScripts and plan.tests business cases)
	const allTestScripts = [
		...new Set([
			...(input.testScripts ?? []),
			...input.plans.flatMap((p) => p.testScripts ?? []),
		].map((s) => s.trim()).filter(Boolean)),
	];
	const allPlanTests: PlanBusinessTest[] = [
		...(input.planTests ?? []),
		...input.plans.flatMap((p) =>
			(p.planTests ?? []).map((t) => ({ ...t, plan: p.title || p.name })),
		),
	];
	const dedupedPlanTests: PlanBusinessTest[] = [];
	const seenPlanTests = new Set<string>();
	for (const pt of allPlanTests) {
		const k = `${(pt.plan ?? "").toLowerCase()}::${pt.name.toLowerCase()}`;
		if (seenPlanTests.has(k)) continue;
		seenPlanTests.add(k);
		dedupedPlanTests.push(pt);
	}
	if (allTestScripts.length || dedupedPlanTests.length) {
		parts.push("## Test Coverage & Verification", "");
		if (allTestScripts.length) {
			parts.push("### Linked Test Scripts", "");
			for (const ts of allTestScripts) {
				parts.push(`- \`${ts}\``);
			}
			parts.push("");
		}
		if (dedupedPlanTests.length) {
			parts.push("### Business Test Cases", "", "| Case | Plan | Expected |", "| --- | --- | --- |");
			for (const pt of dedupedPlanTests) {
				const detail = [pt.given ? `Given ${pt.given}` : "", pt.expect || ""].filter(Boolean).join(" -> ") || "—";
				parts.push(`| ${clipTableCell(pt.name, 20)} | ${clipTableCell(pt.plan || "—", 20)} | ${clipTableCell(detail, 100)} |`);
			}
			parts.push("");
		}
	}

	if (input.testRuns?.length) {
		const summary = summarizeTicketTestRuns(input.testRuns, input.currentGitSha);
		parts.push("## Validation Evidence", "");
		if (summary) {
			parts.push(`Overall status: **${summary.badge}** — ${summary.detail}`, "");
		}
		parts.push("| Phase | Env | Result | Run & SHA |", "| --- | --- | --- | --- |");
		for (const run of input.testRuns) {
			const stale = isTestRunStale(run, input.currentGitSha);
			const resLabel = stale ? `${run.result.toUpperCase()} (STALE)` : run.result.toUpperCase();
			const detail = [
				run.gitSha ? `SHA ${run.gitSha.slice(0, 12)}` : "",
				run.executedBy ? `by ${run.executedBy}` : "",
				run.executedDate || "",
				stale ? "stale vs HEAD" : "",
			]
				.filter(Boolean)
				.join(" · ") || "—";
			parts.push(`| ${clipTableCell(run.phase, 20)} | ${clipTableCell(run.environment || "—", 20)} | ${clipTableCell(resLabel, 20)} | ${clipTableCell(detail, 100)} |`);
		}
		parts.push("");
		for (const run of input.testRuns) {
			if (!run.cases.length) continue;
			const stale = isTestRunStale(run, input.currentGitSha);
			parts.push(
				`### ${run.phase} (${run.environment || "—"}) — ${run.result.toUpperCase()}${stale ? " (STALE SHA)" : ""}`,
				"",
				"| Case | Result | Evidence | Notes |",
				"| --- | --- | --- | --- |",
			);
			for (const c of run.cases) {
				parts.push(`| ${clipTableCell(c.caseId || "—", 20)} | ${clipTableCell(c.result || "—", 20)} | ${clipTableCell(c.evidence || "—", 20)} | ${clipTableCell(c.notes || "—", 100)} |`);
			}
			parts.push("");
		}
	}

	if (input.decisions.length) {
		parts.push("## Decisions", "");
		for (const d of input.decisions) {
			parts.push(`### ${d.title}${d.status ? ` (${d.status})` : ""}`, "");
			const b = embedBody(d.body, 4);
			if (b) parts.push(b, "");
		}
	}

	if (input.questions.length) {
		parts.push("## Questions & Answers", "");
		for (const q of input.questions) {
			parts.push(`### ${q.title}${q.status ? ` (${q.status})` : ""}`, "");
			const b = embedBody(q.body, 4);
			if (b) parts.push(b, "");
		}
	}

	if (input.references?.length) {
		parts.push("## Reference Notes", "");
		for (const ref of input.references) {
			parts.push(`### ${ref.title}${ref.status ? ` (${ref.status})` : ""}`, "");
			const b = embedBody(ref.body, 4);
			if (b) parts.push(b, "");
		}
	}

	if (input.schemas?.length) {
		parts.push("## Schema & Data Contracts", "");
		for (const sc of input.schemas) {
			parts.push(`### ${sc.title}${sc.status ? ` (${sc.status})` : ""}`, "");
			const b = embedBody(sc.body, 4);
			if (b) parts.push(b, "");
		}
	}

	if (input.registries.length) {
		parts.push("## Affected Registry Items", "");
		for (const reg of input.registries) {
			if (!reg.rows.length) continue;
			parts.push(`### ${reg.title}`, "");
			parts.push(`| ${reg.headers.map(escCell).join(" | ")} |`);
			parts.push(`| ${reg.headers.map(() => "---").join(" | ")} |`);
			for (const row of reg.rows) {
				parts.push(`| ${reg.headers.map((_, idx) => escCell(row[idx] ?? "")).join(" | ")} |`);
			}
			parts.push("");
		}
	}

	if (input.ticketFiles.length) {
		const total = Math.max(input.ticketFiles.length, input.totalTicketFiles ?? 0);
		parts.push("## Ticket Folder Artifacts", "");
		for (const f of input.ticketFiles) {
			parts.push(`- \`${f.rel}\``);
		}
		if (total > input.ticketFiles.length) {
			parts.push(`- … and ${total - input.ticketFiles.length} more files inside this ticket folder`);
		}
		parts.push("");
	}

	return parts.join("\n").trimEnd() + "\n";
}

// --- Ordered STARLIMS Deployment Runbook (FK-Topological & Drift Checks) -----

export type DeploymentRunbookTableDep = {
	name: string;
	dependsOn?: readonly string[];
	path?: string;
	kind?: string;
};

export type DeploymentRunbookChecksumDrift = {
	path: string;
	expectedSha256: string;
	actualSha256: string;
	status?: string;
};

export type DeploymentRunbookInput = {
	jobs?: readonly { name: string; schedule?: string; calls?: string; status?: string }[];
	sqlArtifacts?: readonly DeploymentManifestSql[];
	sqlTables?: readonly DeploymentRunbookTableDep[];
	settings?: readonly { name: string; value?: string; where?: string; status?: string }[];
	roles?: readonly { role: string; mayDo?: string; status?: string }[];
	scripts?: readonly DeploymentManifestScript[];
	reports?: readonly { name: string; kind?: string; usedBy?: string; status?: string }[];
	interfaces?: readonly { name: string; direction?: string; how?: string; status?: string }[];
	testScripts?: readonly { ref: string; ticket?: string }[];
	planTests?: readonly PlanBusinessTest[];
	registries?: readonly DeploymentManifestRegistry[];
	checksums?: readonly { path: string; sha256: string }[];
	fileManifestRows?: readonly { path: string; sha256: string; status?: string }[];
	checksumDrifts?: readonly DeploymentRunbookChecksumDrift[];
};

const normPathKey = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").trim().toLowerCase();

/**
 * Orders SQL tables in foreign-key dependency order (parent tables before child tables)
 * using Kahn's topological sort with deterministic lexicographical tie-breaking and
 * graceful cycle fallback (never throws or drops tables on circular FKs).
 */
export function orderSqlTablesTopologically(
	tables: readonly { name: string; dependsOn?: readonly string[] }[],
): string[] {
	type Node = { key: string; name: string; deps: Set<string>; dependents: Set<string>; inDegree: number };
	const nodes = new Map<string, Node>();
	const bareToKeys = new Map<string, string[]>();

	const bareOf = (n: string) => {
		const idx = n.lastIndexOf(".");
		return idx >= 0 ? n.slice(idx + 1) : n;
	};

	for (const t of tables) {
		const clean = t.name.trim();
		if (!clean) continue;
		const key = clean.toLowerCase();
		if (!nodes.has(key)) {
			nodes.set(key, { key, name: clean, deps: new Set(), dependents: new Set(), inDegree: 0 });
			const bare = bareOf(key);
			const list = bareToKeys.get(bare) ?? [];
			list.push(key);
			bareToKeys.set(bare, list);
		}
	}

	const resolveRef = (raw: string): string | null => {
		const k = raw.trim().toLowerCase();
		if (!k) return null;
		if (nodes.has(k)) return k;
		const bare = bareOf(k);
		const hits = bareToKeys.get(bare);
		if (hits && hits.length === 1) return hits[0]!;
		return null;
	};

	for (const t of tables) {
		const childKey = t.name.trim().toLowerCase();
		const child = nodes.get(childKey);
		if (!child) continue;
		for (const rawDep of t.dependsOn ?? []) {
			const parentKey = resolveRef(rawDep);
			if (!parentKey || parentKey === childKey) continue;
			if (!child.deps.has(parentKey)) {
				child.deps.add(parentKey);
				nodes.get(parentKey)!.dependents.add(childKey);
				child.inDegree++;
			}
		}
	}

	const cmpNames = (a: string, b: string) =>
		nodes.get(a)!.name.localeCompare(nodes.get(b)!.name, undefined, { numeric: true, sensitivity: "base" });

	const remaining = new Set<string>(nodes.keys());
	const result: string[] = [];

	const drainReady = () => {
		const ready = [...remaining].filter((k) => nodes.get(k)!.inDegree === 0).sort(cmpNames);
		while (ready.length > 0) {
			const cur = ready.shift()!;
			if (!remaining.has(cur)) continue;
			remaining.delete(cur);
			result.push(nodes.get(cur)!.name);
			let added = false;
			for (const depKey of nodes.get(cur)!.dependents) {
				if (!remaining.has(depKey)) continue;
				const depNode = nodes.get(depKey)!;
				depNode.inDegree--;
				if (depNode.inDegree === 0) {
					ready.push(depKey);
					added = true;
				}
			}
			if (added) ready.sort(cmpNames);
		}
	};

	drainReady();

	// Graceful cycle fallback: deterministically break cycles by minimal remaining in-degree, then name.
	while (remaining.size > 0) {
		const pick = [...remaining].sort((a, b) => {
			const diff = nodes.get(a)!.inDegree - nodes.get(b)!.inDegree;
			return diff !== 0 ? diff : cmpNames(a, b);
		})[0]!;
		remaining.delete(pick);
		result.push(nodes.get(pick)!.name);
		for (const depKey of nodes.get(pick)!.dependents) {
			if (!remaining.has(depKey)) continue;
			nodes.get(depKey)!.inDegree = Math.max(0, nodes.get(depKey)!.inDegree - 1);
		}
		drainReady();
	}

	return result;
}

/**
 * Compares `files.csv` rows marked `verified` against current artifact SHA-256 checksums
 * and reports any verified file whose hash has drifted.
 */
export function detectChecksumDrift(
	fileManifestRows: readonly { path: string; sha256: string; status?: string }[],
	currentChecksums: readonly { path: string; sha256: string }[],
): DeploymentRunbookChecksumDrift[] {
	if (!fileManifestRows.length || !currentChecksums.length) return [];
	const currentByPath = new Map<string, string>();
	for (const c of currentChecksums) {
		const key = normPathKey(c.path);
		const sha = c.sha256.trim().toLowerCase();
		if (key && sha) currentByPath.set(key, sha);
	}
	const drifts: DeploymentRunbookChecksumDrift[] = [];
	const seen = new Set<string>();
	for (const row of fileManifestRows) {
		const status = (row.status ?? "").trim().toLowerCase();
		if (status !== "verified") continue;
		const key = normPathKey(row.path);
		const expected = row.sha256.trim().toLowerCase();
		if (!key || !expected || seen.has(key)) continue;
		const actual = currentByPath.get(key);
		if (!actual) continue;
		if (actual !== expected && !actual.startsWith(expected) && !expected.startsWith(actual)) {
			seen.add(key);
			drifts.push({
				path: row.path.replace(/\\/g, "/").trim(),
				expectedSha256: expected,
				actualSha256: actual,
				status: row.status,
			});
		}
	}
	return drifts;
}

function scriptPromotionRank(s: DeploymentManifestScript): number {
	const ref = s.ref.trim().toLowerCase();
	const kind = s.kind.trim().toLowerCase();
	if (ref.endsWith(".ssl") || ref.endsWith(".srvscr") || kind.includes("ssl") || kind.includes("server script")) return 1;
	if (ref.endsWith(".ds") || kind.includes("data source")) return 2;
	if (ref.endsWith(".xfd") || kind.includes("xfd") || kind.includes("form")) return 3;
	return 4;
}

/**
 * Assembles an ordered STARLIMS Deployment Execution Runbook (`## Deployment Execution Runbook`)
 * following STARLIMS promotion dependency order:
 * 1. Pre-flight backup & pause affected scheduled jobs (`jobs.csv`)
 * 2. Database DDL in FK-topological order (parent tables -> child tables -> views/procs/packages)
 * 3. Configuration & Access (`settings.csv`, `roles.csv`)
 * 4. Application Code (`.ssl`/`.srvscr` -> `.ds` -> `.xfd` -> `reports.csv`)
 * 5. Resume scheduled jobs & enable interfaces (`interfaces.csv`)
 * 6. Post-deploy verification (`testScripts` + `planTests`)
 * Plus `files.csv` verified SHA-256 checksum drift warnings when detected.
 */
export function assembleDeploymentRunbook(input: DeploymentRunbookInput): string {
	// Extract registry-backed items automatically when registries are passed.
	const jobs = [...(input.jobs ?? [])];
	const settings = [...(input.settings ?? [])];
	const roles = [...(input.roles ?? [])];
	const reports = [...(input.reports ?? [])];
	const interfaces = [...(input.interfaces ?? [])];
	const manifestRows = [...(input.fileManifestRows ?? [])];

	const findCol = (headers: readonly string[], names: readonly string[]) => {
		const lower = headers.map((h) => h.trim().toLowerCase());
		for (const n of names) {
			const idx = lower.indexOf(n);
			if (idx >= 0) return idx;
		}
		return -1;
	};

	for (const reg of input.registries ?? []) {
		const t = reg.title.trim().toLowerCase();
		const statusIdx = findCol(reg.headers, ["status", "state"]);
		if (t.includes("job")) {
			const nameIdx = Math.max(0, findCol(reg.headers, ["job", "name"]));
			const runsIdx = findCol(reg.headers, ["runs", "schedule", "cron"]);
			const callsIdx = findCol(reg.headers, ["calls", "script"]);
			for (const r of reg.rows) {
				const name = (r[nameIdx] ?? "").trim();
				if (name && !jobs.some((j) => j.name.toLowerCase() === name.toLowerCase())) {
					jobs.push({
						name,
						schedule: runsIdx >= 0 ? (r[runsIdx] ?? "").trim() : undefined,
						calls: callsIdx >= 0 ? (r[callsIdx] ?? "").trim() : undefined,
						status: statusIdx >= 0 ? (r[statusIdx] ?? "").trim() : undefined,
					});
				}
			}
		} else if (t.includes("setting")) {
			const nameIdx = Math.max(0, findCol(reg.headers, ["name", "setting", "key"]));
			const valIdx = findCol(reg.headers, ["value", "val"]);
			const whereIdx = findCol(reg.headers, ["where", "scope", "section"]);
			for (const r of reg.rows) {
				const name = (r[nameIdx] ?? "").trim();
				if (name && !settings.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
					settings.push({
						name,
						value: valIdx >= 0 ? (r[valIdx] ?? "").trim() : undefined,
						where: whereIdx >= 0 ? (r[whereIdx] ?? "").trim() : undefined,
						status: statusIdx >= 0 ? (r[statusIdx] ?? "").trim() : undefined,
					});
				}
			}
		} else if (t.includes("role") || t.includes("access")) {
			const roleIdx = Math.max(0, findCol(reg.headers, ["role", "name"]));
			const mayDoIdx = findCol(reg.headers, ["may do", "permissions", "access", "note"]);
			for (const r of reg.rows) {
				const role = (r[roleIdx] ?? "").trim();
				if (role && !roles.some((x) => x.role.toLowerCase() === role.toLowerCase())) {
					roles.push({
						role,
						mayDo: mayDoIdx >= 0 ? (r[mayDoIdx] ?? "").trim() : undefined,
						status: statusIdx >= 0 ? (r[statusIdx] ?? "").trim() : undefined,
					});
				}
			}
		} else if (t.includes("report") || t.includes("label")) {
			const nameIdx = Math.max(0, findCol(reg.headers, ["report", "name", "label"]));
			const kindIdx = findCol(reg.headers, ["kind", "type"]);
			const usedIdx = findCol(reg.headers, ["used by", "caller"]);
			for (const r of reg.rows) {
				const name = (r[nameIdx] ?? "").trim();
				if (name && !reports.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
					reports.push({
						name,
						kind: kindIdx >= 0 ? (r[kindIdx] ?? "").trim() : undefined,
						usedBy: usedIdx >= 0 ? (r[usedIdx] ?? "").trim() : undefined,
						status: statusIdx >= 0 ? (r[statusIdx] ?? "").trim() : undefined,
					});
				}
			}
		} else if (t.includes("interface")) {
			const nameIdx = Math.max(0, findCol(reg.headers, ["interface", "name", "system"]));
			const dirIdx = findCol(reg.headers, ["direction", "dir"]);
			const howIdx = findCol(reg.headers, ["how", "protocol", "transport"]);
			for (const r of reg.rows) {
				const name = (r[nameIdx] ?? "").trim();
				if (name && !interfaces.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
					interfaces.push({
						name,
						direction: dirIdx >= 0 ? (r[dirIdx] ?? "").trim() : undefined,
						how: howIdx >= 0 ? (r[howIdx] ?? "").trim() : undefined,
						status: statusIdx >= 0 ? (r[statusIdx] ?? "").trim() : undefined,
					});
				}
			}
		} else if (t.includes("file manifest") || t === "files" || t === "files.csv") {
			const pathIdx = Math.max(0, findCol(reg.headers, ["path", "file"]));
			const shaIdx = findCol(reg.headers, ["sha256", "sha-256", "checksum", "hash"]);
			if (shaIdx >= 0) {
				for (const r of reg.rows) {
					const p = (r[pathIdx] ?? "").trim();
					const sha = (r[shaIdx] ?? "").trim();
					if (p && sha) {
						manifestRows.push({ path: p, sha256: sha, status: statusIdx >= 0 ? (r[statusIdx] ?? "").trim() : undefined });
					}
				}
			}
		}
	}

	// Merge explicit + auto-detected verified checksum drifts.
	const drifts: DeploymentRunbookChecksumDrift[] = [...(input.checksumDrifts ?? [])];
	const seenDrift = new Set(drifts.map((d) => normPathKey(d.path)));
	for (const d of detectChecksumDrift(manifestRows, input.checksums ?? [])) {
		const k = normPathKey(d.path);
		if (!seenDrift.has(k)) {
			seenDrift.add(k);
			drifts.push(d);
		}
	}

	const parts: string[] = ["## Deployment Execution Runbook", ""];

	if (drifts.length) {
		parts.push(
			"> [!warning] Checksum Drift Detected",
			`> ${drifts.length} artifact${drifts.length === 1 ? "" : "s"} marked \`verified\` in \`files.csv\` changed SHA-256 hash since verification. Re-verify before promoting to target environment.`,
			"",
			"| Recorded | Current | Artifact |",
			"| --- | --- | --- |",
		);
		for (const d of drifts) {
			parts.push(
				`| \`${clipTableCell(d.expectedSha256.slice(0, 12), 20)}\` | \`${clipTableCell(d.actualSha256.slice(0, 12), 20)}\` | \`${clipTableCell(d.path, 98)}\` |`,
			);
		}
		parts.push("");
	}

	// 1. Pre-flight backup & pause affected scheduled jobs
	parts.push(
		"### 1. Pre-Flight Backup & Pause Scheduled Jobs",
		"",
		"- [ ] Export pre-deployment STARLIMS backup package (XFD/SSL/DS) and confirm database restore snapshot.",
	);
	if (jobs.length) {
		for (const j of jobs) {
			const extra = [j.schedule ? `schedule: ${j.schedule}` : "", j.calls ? `calls: ${j.calls}` : ""].filter(Boolean).join(", ");
			parts.push(`- [ ] Pause scheduled job \`${j.name}\`${extra ? ` (${extra})` : ""}.`);
		}
	} else {
		parts.push("- [ ] Confirm no conflicting STARLIMS scheduled jobs are active during the maintenance window.");
	}
	parts.push("");

	// 2. Database DDL in FK-topological order (parent tables -> child tables -> views/procs/packages)
	parts.push("### 2. Database DDL (FK-Topological Order)", "");
	const tableDepByLower = new Map<string, DeploymentRunbookTableDep>();
	for (const td of input.sqlTables ?? []) {
		if (td.name.trim()) tableDepByLower.set(td.name.trim().toLowerCase(), td);
	}
	const orderedTableNames = orderSqlTablesTopologically(input.sqlTables ?? []);
	const orderedTableSet = new Set(orderedTableNames.map((n) => n.toLowerCase()));
	const tableSqlItems: { label: string; path?: string }[] = [];
	const nonTableSqlItems: { label: string; kind: string; path?: string }[] = [];

	// Map sqlArtifacts to matching tables or views/procs/packages
	const sqlByTableLower = new Map<string, DeploymentManifestSql>();
	for (const sql of input.sqlArtifacts ?? []) {
		const srcLower = sql.source.trim().toLowerCase();
		const srcBare = srcLower.includes(".") ? srcLower.slice(srcLower.lastIndexOf(".") + 1) : srcLower;
		if (orderedTableSet.has(srcLower)) {
			sqlByTableLower.set(srcLower, sql);
		} else if (orderedTableSet.has(srcBare)) {
			sqlByTableLower.set(srcBare, sql);
		} else if (/\btable\b/i.test(sql.kind)) {
			tableSqlItems.push({ label: sql.source || sql.path, path: sql.path });
		} else {
			nonTableSqlItems.push({ label: sql.source || sql.path, kind: sql.kind || "DDL", path: sql.path });
		}
	}

	const ddlLines: string[] = [];
	for (const tblName of orderedTableNames) {
		const key = tblName.toLowerCase();
		const dep = tableDepByLower.get(key);
		const linkedSql = sqlByTableLower.get(key);
		const sqlPath = dep?.path || linkedSql?.path;
		ddlLines.push(`- [ ] Apply table DDL \`${tblName}\`${sqlPath ? ` (\`${sqlPath}\`)` : ""}.`);
	}
	for (const t of tableSqlItems) {
		ddlLines.push(`- [ ] Apply table DDL \`${t.label}\`${t.path && t.path !== t.label ? ` (\`${t.path}\`)` : ""}.`);
	}
	// Order non-table DDL deterministically: views -> functions -> procedures -> packages -> triggers -> other
	const nonTableRank = (kind: string) => {
		const k = kind.toLowerCase();
		if (k.includes("view")) return 1;
		if (k.includes("func")) return 2;
		if (k.includes("proc")) return 3;
		if (k.includes("pack")) return 4;
		if (k.includes("trig")) return 5;
		return 6;
	};
	nonTableSqlItems.sort((a, b) => nonTableRank(a.kind) - nonTableRank(b.kind) || a.label.localeCompare(b.label));
	for (const obj of nonTableSqlItems) {
		ddlLines.push(`- [ ] Apply ${obj.kind} \`${obj.label}\`${obj.path && obj.path !== obj.label ? ` (\`${obj.path}\`)` : ""}.`);
	}
	if (ddlLines.length) parts.push(...ddlLines, "");
	else parts.push("- [ ] No database DDL changes in scope.", "");

	// 3. Configuration & Access (`settings.csv`, `roles.csv`)
	parts.push("### 3. Configuration & Access", "");
	if (settings.length || roles.length) {
		for (const s of settings) {
			parts.push(`- [ ] Apply setting \`${s.name}\`${s.value ? ` = \`${s.value}\`` : ""}${s.where ? ` (${s.where})` : ""}.`);
		}
		for (const r of roles) {
			parts.push(`- [ ] Update role \`${r.role}\`${r.mayDo ? ` — ${r.mayDo}` : ""}.`);
		}
		parts.push("");
	} else {
		parts.push("- [ ] No application settings or role access changes in scope.", "");
	}

	// 4. Application Code (`.ssl`/`.srvscr` -> `.ds` -> `.xfd` -> `reports.csv`)
	parts.push("### 4. Application Code & Reports", "");
	const uniqueScripts = new Map<string, DeploymentManifestScript>();
	for (const s of input.scripts ?? []) {
		const k = normPathKey(s.ref);
		if (k && !uniqueScripts.has(k)) uniqueScripts.set(k, s);
	}
	const orderedScripts = [...uniqueScripts.values()].sort(
		(a, b) => scriptPromotionRank(a) - scriptPromotionRank(b) || a.ref.localeCompare(b.ref),
	);
	if (orderedScripts.length || reports.length) {
		for (const s of orderedScripts) {
			parts.push(`- [ ] Import ${s.kind || classifyDeploymentArtifact(s.ref)} \`${s.ref}\`${s.ticket ? ` (${s.ticket})` : ""}.`);
		}
		for (const rep of reports) {
			parts.push(`- [ ] Deploy report/label \`${rep.name}\`${rep.kind ? ` (${rep.kind})` : ""}${rep.usedBy ? ` — used by ${rep.usedBy}` : ""}.`);
		}
		parts.push("");
	} else {
		parts.push("- [ ] No application scripts, forms, or reports in scope.", "");
	}

	// 5. Resume scheduled jobs & enable interfaces (`interfaces.csv`)
	parts.push("### 5. Resume Scheduled Jobs & Enable Interfaces", "");
	if (jobs.length || interfaces.length) {
		for (const j of jobs) {
			parts.push(`- [ ] Resume scheduled job \`${j.name}\` and confirm clean first run.`);
		}
		for (const iface of interfaces) {
			const meta = [iface.direction, iface.how].filter(Boolean).join(" / ");
			parts.push(`- [ ] Enable & verify interface \`${iface.name}\`${meta ? ` (${meta})` : ""}.`);
		}
		parts.push("");
	} else {
		parts.push("- [ ] Confirm background services and interfaces report healthy status.", "");
	}

	// 6. Post-deploy verification (`testScripts` + `planTests`)
	parts.push("### 6. Post-Deploy Verification", "");
	const uniqueTestScripts = new Map<string, { ref: string; ticket?: string }>();
	for (const ts of input.testScripts ?? []) {
		const k = normPathKey(ts.ref);
		if (k && !uniqueTestScripts.has(k)) uniqueTestScripts.set(k, ts);
	}
	if (uniqueTestScripts.size || (input.planTests?.length ?? 0) > 0) {
		for (const ts of uniqueTestScripts.values()) {
			parts.push(`- [ ] Execute test script \`${ts.ref}\`${ts.ticket ? ` (${ts.ticket})` : ""}.`);
		}
		for (const pt of input.planTests ?? []) {
			parts.push(`- [ ] Verify business test **${pt.name}**${pt.expect ? ` — expect: ${pt.expect}` : ""}.`);
		}
		parts.push("");
	} else {
		parts.push("- [ ] Run post-deploy smoke checks and confirm STARLIMS audit trail entries.", "");
	}

	return parts.join("\n").trimEnd();
}

// --- STARLIMS Deployment / Transport Manifest --------------------------------

export type DeploymentManifestScript = {
	ref: string;
	kind: string;
	ticket: string;
};

export type DeploymentManifestSql = {
	path: string;
	kind: string;
	source: string;
	/** Owning ticket or sub-ticket key (defaults to parent ticketKey when omitted). */
	ticket?: string;
};

export type DeploymentManifestRegistry = {
	title: string;
	headers: string[];
	rows: string[][];
};

export type DeploymentManifestInput = {
	projectName: string;
	generatedOn: string;
	ticketKey: string;
	ticketTitle: string;
	status?: string;
	parent?: string;
	release?: string;
	headSha?: string;
	changeControl?: string;
	approvedBy?: string;
	approvedDate?: string;
	gxpImpact?: string;
	targetEnvironment?: string;
	scopeTickets: { key: string; title: string; status?: string }[];
	scripts: DeploymentManifestScript[];
	testScripts?: { ref: string; ticket: string }[];
	planTests?: PlanBusinessTest[];
	sqlArtifacts: DeploymentManifestSql[];
	registries: DeploymentManifestRegistry[];
	checksums?: { path: string; sha256: string }[];
	readiness?: ReadinessReport | null;
	rollbackNotes?: string[];
	/** When `true` or a `DeploymentRunbookInput`, emits an ordered STARLIMS `## Deployment Execution Runbook` section. */
	runbook?: DeploymentRunbookInput | boolean;
};

/** Classifies a STARLIMS code/artifact reference by extension or name for deployment manifests. */
export function classifyDeploymentArtifact(ref: string): string {
	const lower = ref.toLowerCase();
	if (lower.endsWith(".ssl") || lower.endsWith(".srvscr")) return "SSL Script";
	if (lower.endsWith(".ds")) return "Data Source";
	if (lower.endsWith(".xfd")) return "XFD Form";
	if (lower.endsWith(".sql") || lower.endsWith(".ddl") || lower.endsWith(".pks") || lower.endsWith(".pkb")) return "SQL / DDL";
	if (lower.endsWith(".hl7") || lower.endsWith(".astm")) return "Interface";
	if (lower.endsWith(".xml") || lower.endsWith(".json") || lower.endsWith(".config")) return "Config / Schema";
	return "Code / Object";
}

/**
 * Assembles a STARLIMS promotion / transport manifest (Markdown) aggregating a
 * ticket or epic's full blast radius: descendant tickets, SSL scripts, SQL/DDL,
 * test scripts, affected registry items, checksums, rollback notes, and DEV -> QA -> UAT -> PROD sign-off.
 */
export function assembleDeploymentManifestMarkdown(input: DeploymentManifestInput): string {
	const escCell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
	const parts: string[] = [
		`# Deployment Manifest — ${input.ticketKey}: ${input.ticketTitle}`,
		"",
		"| Field | Value |",
		"| --- | --- |",
		`| Project | ${escCell(input.projectName)} |`,
		`| Scope | ${escCell(input.scopeTickets.map((t) => t.key).join(", ") || input.ticketKey)} |`,
		`| Status | ${escCell(input.status || "—")} |`,
		...(input.parent ? [`| Parent | ${escCell(input.parent)} |`] : []),
		...(input.release ? [`| Release | ${escCell(input.release)} |`] : []),
		...(input.changeControl ? [`| Change Control | ${escCell(input.changeControl)} |`] : []),
		...(input.gxpImpact ? [`| GxP Impact | ${escCell(input.gxpImpact)} |`] : []),
		...(input.headSha ? [`| HEAD Commit | \`${escCell(input.headSha.slice(0, 12))}\` |`] : []),
		...(input.approvedBy
			? [`| Approved By | ${escCell(input.approvedDate ? `${input.approvedBy} (${input.approvedDate})` : input.approvedBy)} |`]
			: []),
		`| Generated | ${escCell(input.generatedOn)} |`,
		"",
	];

	if (input.readiness && input.readiness.checks.length) {
		parts.push(
			"## Readiness Gate",
			"",
			`Status: **${input.readiness.ready ? "Ready for promotion" : "Attention needed"}** (${input.readiness.pass}/${input.readiness.total} checks passing)`,
			"",
			"| Check | Status | Details |",
			"| --- | --- | --- |",
		);
		for (const c of input.readiness.checks) {
			const badge = c.level === "pass" ? "PASS" : c.level === "warn" ? "WARN" : "NOTE";
			parts.push(`| ${escCell(c.label)} | ${badge} | ${escCell(c.detail)} |`);
		}
		parts.push("");
	}

	if (input.scopeTickets.length > 1) {
		parts.push("## Included Tickets", "", "| Ticket | Status | Title |", "| --- | --- | --- |");
		for (const t of input.scopeTickets) {
			parts.push(`| ${escCell(t.key)} | ${escCell(t.status || "—")} | ${escCell(t.title)} |`);
		}
		parts.push("");
	}

	parts.push("## Code & Application Artifacts", "");
	if (input.scripts.length) {
		parts.push("| Type | Ticket | Artifact |", "| --- | --- | --- |");
		for (const s of input.scripts) {
			parts.push(`| ${escCell(s.kind)} | ${escCell(s.ticket)} | \`${escCell(s.ref)}\` |`);
		}
		parts.push("");
	} else {
		parts.push("_No SSL scripts or application code references linked yet._", "");
	}

	if (input.testScripts?.length || input.planTests?.length) {
		parts.push("## Verification & Test Artifacts", "");
		if (input.testScripts?.length) {
			parts.push("| Ticket | Test Script |", "| --- | --- |");
			for (const ts of input.testScripts) {
				parts.push(`| ${escCell(ts.ticket)} | \`${escCell(ts.ref)}\` |`);
			}
			parts.push("");
		}
		if (input.planTests?.length) {
			parts.push("| Case | Plan | Expected |", "| --- | --- | --- |");
			for (const pt of input.planTests) {
				const detail = [pt.given ? `Given ${pt.given}` : "", pt.expect || ""].filter(Boolean).join(" -> ") || "—";
				parts.push(`| ${escCell(pt.name)} | ${escCell(pt.plan || "—")} | ${escCell(detail)} |`);
			}
			parts.push("");
		}
	}

	if (input.sqlArtifacts.length) {
		parts.push("## Database & Schema Artifacts", "", "| Kind | Source | Artifact |", "| --- | --- | --- |");
		for (const sql of input.sqlArtifacts) {
			parts.push(`| ${escCell(sql.kind)} | ${escCell(sql.source)} | \`${escCell(sql.path)}\` |`);
		}
		parts.push("");
	}

	if (input.registries.length) {
		parts.push("## Configuration & Registry Changes", "");
		for (const reg of input.registries) {
			if (!reg.rows.length) continue;
			parts.push(`### ${reg.title}`, "");
			parts.push(`| ${reg.headers.map(escCell).join(" | ")} |`);
			parts.push(`| ${reg.headers.map(() => "---").join(" | ")} |`);
			for (const row of reg.rows) {
				parts.push(`| ${reg.headers.map((_, idx) => escCell(row[idx] ?? "")).join(" | ")} |`);
			}
			parts.push("");
		}
	}

	if (input.checksums?.length) {
		parts.push("## Artifact Checksums", "", "| SHA-256 | Artifact |", "| --- | --- |");
		for (const c of input.checksums) {
			parts.push(`| \`${escCell(c.sha256.slice(0, 16))}\` | \`${escCell(c.path)}\` |`);
		}
		parts.push("");
	}

	if (input.runbook) {
		const rbInput: DeploymentRunbookInput = {
			scripts: input.scripts,
			sqlArtifacts: input.sqlArtifacts,
			registries: input.registries,
			testScripts: input.testScripts,
			planTests: input.planTests,
			checksums: input.checksums,
			...(typeof input.runbook === "object" ? input.runbook : {}),
		};
		parts.push(assembleDeploymentRunbook(rbInput), "");
	}

	parts.push("## Rollback Plan", "");
	if (input.rollbackNotes?.length) {
		for (const note of input.rollbackNotes) {
			parts.push(note.trim(), "");
		}
	} else {
		parts.push(
			"- [ ] Export pre-deployment XFD/SSL backup package from target environment before importing.",
			"- [ ] Confirm database DDL changes have a tested reverse script or snapshot restore point.",
			"- [ ] Verify affected settings, jobs, and interfaces can be restored to prior values if smoke checks fail.",
			"",
		);
	}

	parts.push(
		"## Promotion Sign-Off",
		"",
		"| Audit Field | Value |",
		"| --- | --- |",
		`| HEAD Commit SHA | ${input.headSha ? `\`${escCell(input.headSha)}\`` : "—"} |`,
		`| Change Control / CAB | ${escCell(input.changeControl || "—")} |`,
		`| Target Environment | ${escCell(input.targetEnvironment || "DEV -> QA -> UAT -> PROD")} |`,
		`| Date / Time | ${escCell(input.generatedOn)} |`,
		`| Artifact Checksums | ${input.checksums?.length ? `${input.checksums.length} SHA-256 verified` : "See files.csv manifest"} |`,
		"",
		"| Stage | Target | Verified By | Sign-Off |",
		"| --- | --- | --- | --- |",
		"| DEV | Development | | [ ] Pending |",
		"| QA | Quality Assurance | | [ ] Pending |",
		"| UAT | User Acceptance | | [ ] Pending |",
		"| PROD | Production | | [ ] Pending |",
		"",
	);

	return parts.join("\n").trimEnd() + "\n";
}

/** Assembles a flat CSV transport manifest suitable for CAB / ServiceNow / Excel import. */
export function assembleDeploymentManifestCsv(input: DeploymentManifestInput): string {
	const rows: string[] = [csvRow(["Category", "Artifact", "Ticket", "Status", "Notes"], ",")];
	for (const s of input.scripts) {
		rows.push(csvRow([s.kind, s.ref, s.ticket, "planned", ""], ","));
	}
	for (const ts of input.testScripts ?? []) {
		rows.push(csvRow(["Test Script", ts.ref, ts.ticket, "planned", ""], ","));
	}
	for (const sql of input.sqlArtifacts) {
		rows.push(csvRow([sql.kind, sql.path, sql.ticket?.trim() || input.ticketKey, "planned", sql.source], ","));
	}
	for (const reg of input.registries) {
		const lowerHeaders = reg.headers.map((h) => h.trim().toLowerCase());
		const statusIdx = lowerHeaders.findIndex((h) => h === "status" || h === "state");
		const ticketIdx = lowerHeaders.findIndex((h) => h === "ticket" || h === "tickets");
		const notesIdx = lowerHeaders.findIndex((h) => h === "notes" || h === "note" || h === "comment" || h === "description");
		for (const r of reg.rows) {
			const item = r[0] ?? "";
			const rawTicket = ticketIdx >= 0 ? (r[ticketIdx] ?? "").trim() : "";
			const t = rawTicket || input.ticketKey;
			const st = statusIdx >= 0 ? (r[statusIdx] ?? "") : "";
			const extra =
				notesIdx >= 0 && r[notesIdx]
					? r[notesIdx]!
					: reg.headers
							.map((h, i) => (i === 0 || i === statusIdx || i === ticketIdx || !r[i] ? "" : `${h}: ${r[i]}`))
							.filter(Boolean)
							.join("; ");
			rows.push(csvRow([`Registry: ${reg.title}`, item, t, st, extra], ","));
		}
	}
	return `${rows.join("\n")}\n`;
}

// --- Multi-Ticket Release Bundle & Stakeholder Release Notes -----------------

export type ReleaseBundleTicket = {
	key: string;
	title: string;
	type?: string;
	status?: string;
	release?: string;
	priority?: string;
	summary?: string;
	approvedBy?: string;
	approvedDate?: string;
	changeControl?: string;
	readiness?: ReadinessReport | null;
};

export type ReleaseBundleCommit = {
	sha: string;
	shortSha: string;
	author: string;
	subject: string;
	time?: number;
	files?: { status: string; path: string }[];
};

export type ReleaseBundleInput = {
	projectName: string;
	releaseName: string;
	generatedOn: string;
	headSha?: string;
	gitRange?: { from: string; to: string };
	changeControl?: string;
	targetEnvironment?: string;
	tickets: ReleaseBundleTicket[];
	scripts: DeploymentManifestScript[];
	testScripts?: { ref: string; ticket: string }[];
	planTests?: PlanBusinessTest[];
	sqlArtifacts: DeploymentManifestSql[];
	registries: DeploymentManifestRegistry[];
	checksums?: { path: string; sha256: string }[];
	runbook?: DeploymentRunbookInput | boolean;
	rollbackNotes?: { ticket: string; source?: string; body: string }[];
	commits?: ReleaseBundleCommit[];
};

function deduplicateReleaseBundleArtifacts(input: ReleaseBundleInput) {
	// 1. Deduplicate scripts (merging owning ticket keys per artifact).
	const scriptMap = new Map<string, { ref: string; kind: string; tickets: string[] }>();
	for (const s of input.scripts) {
		const norm = s.ref.replace(/\\/g, "/").trim().toLowerCase();
		if (!norm) continue;
		const existing = scriptMap.get(norm);
		if (existing) {
			if (s.ticket && !existing.tickets.some((t) => t.toLowerCase() === s.ticket.toLowerCase())) existing.tickets.push(s.ticket);
		} else {
			scriptMap.set(norm, { ref: s.ref.replace(/\\/g, "/").trim(), kind: s.kind, tickets: s.ticket ? [s.ticket] : [] });
		}
	}

	// 2. Deduplicate test scripts.
	const testScriptMap = new Map<string, { ref: string; tickets: string[] }>();
	for (const ts of input.testScripts ?? []) {
		const norm = ts.ref.replace(/\\/g, "/").trim().toLowerCase();
		if (!norm) continue;
		const existing = testScriptMap.get(norm);
		if (existing) {
			if (ts.ticket && !existing.tickets.some((t) => t.toLowerCase() === ts.ticket.toLowerCase())) existing.tickets.push(ts.ticket);
		} else {
			testScriptMap.set(norm, { ref: ts.ref.replace(/\\/g, "/").trim(), tickets: ts.ticket ? [ts.ticket] : [] });
		}
	}

	// 2b. Deduplicate plan business tests.
	const dedupedPlanTests: PlanBusinessTest[] = [];
	const seenPlanTests = new Set<string>();
	for (const pt of input.planTests ?? []) {
		const k = `${(pt.plan ?? "").trim().toLowerCase()}::${pt.name.trim().toLowerCase()}`;
		if (!pt.name.trim() || seenPlanTests.has(k)) continue;
		seenPlanTests.add(k);
		dedupedPlanTests.push(pt);
	}

	// 3. Deduplicate SQL artifacts.
	const sqlMap = new Map<string, { path: string; kind: string; sources: string[]; tickets: string[] }>();
	for (const sql of input.sqlArtifacts) {
		const norm = sql.path.replace(/\\/g, "/").trim().toLowerCase();
		if (!norm) continue;
		const srcLabel = sql.ticket && sql.source && !sql.source.includes(sql.ticket) ? `${sql.ticket} (${sql.source})` : sql.source || sql.ticket || "";
		const existing = sqlMap.get(norm);
		if (existing) {
			if (srcLabel && !existing.sources.includes(srcLabel)) existing.sources.push(srcLabel);
			if (sql.ticket && !existing.tickets.some((t) => t.toLowerCase() === sql.ticket!.toLowerCase())) existing.tickets.push(sql.ticket);
		} else {
			sqlMap.set(norm, {
				path: sql.path.replace(/\\/g, "/").trim(),
				kind: sql.kind,
				sources: srcLabel ? [srcLabel] : [],
				tickets: sql.ticket ? [sql.ticket] : [],
			});
		}
	}

	// 4. Deduplicate registries by title and normalized row values.
	const regMap = new Map<string, { title: string; headers: string[]; rows: string[][]; seenRows: Set<string> }>();
	for (const reg of input.registries) {
		const key = reg.title.toLowerCase();
		let bucket = regMap.get(key);
		if (!bucket) {
			bucket = { title: reg.title, headers: reg.headers, rows: [], seenRows: new Set() };
			regMap.set(key, bucket);
		}
		for (const row of reg.rows) {
			const sig = row.map((c) => (c ?? "").trim().toLowerCase()).join("\u0000");
			if (bucket.seenRows.has(sig)) continue;
			bucket.seenRows.add(sig);
			bucket.rows.push(row);
		}
	}

	// 5. Deduplicate checksums by normalized path.
	const checksumMap = new Map<string, { path: string; sha256: string }>();
	for (const c of input.checksums ?? []) {
		const norm = normPathKey(c.path);
		if (!norm || !c.sha256.trim()) continue;
		if (!checksumMap.has(norm)) checksumMap.set(norm, { path: c.path.replace(/\\/g, "/").trim(), sha256: c.sha256.trim() });
	}

	// 6. Deduplicate rollback notes by normalized body.
	const dedupedRollbacks: { ticket: string; source?: string; body: string }[] = [];
	const seenRollback = new Set<string>();
	for (const rb of input.rollbackNotes ?? []) {
		const sig = rb.body.trim().replace(/\s+/g, " ").toLowerCase();
		if (!sig || seenRollback.has(sig)) continue;
		seenRollback.add(sig);
		dedupedRollbacks.push(rb);
	}

	return { scriptMap, testScriptMap, dedupedPlanTests, sqlMap, regMap, checksumMap, dedupedRollbacks };
}

/**
 * Assembles a deduplicated multi-ticket STARLIMS Release Bundle (Markdown) combining
 * scripts, test scripts, business tests, SQL/DDL objects, registries, artifact checksums,
 * optional ordered deployment runbook, rollback instructions, and optional Git range commits across N tickets.
 */
export function assembleReleaseBundleMarkdown(input: ReleaseBundleInput): string {
	const escCell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
	const { scriptMap, testScriptMap, dedupedPlanTests, sqlMap, regMap, checksumMap, dedupedRollbacks } =
		deduplicateReleaseBundleArtifacts(input);

	const parts: string[] = [
		`# Release Bundle — ${input.releaseName}`,
		"",
		"| Field | Value |",
		"| --- | --- |",
		`| Project | ${escCell(input.projectName)} |`,
		`| Release | ${escCell(input.releaseName)} |`,
		`| Tickets | ${input.tickets.length} (${escCell(input.tickets.map((t) => t.key).join(", ") || "—")}) |`,
		...(input.changeControl ? [`| Change Control | ${escCell(input.changeControl)} |`] : []),
		...(input.targetEnvironment ? [`| Target Env | ${escCell(input.targetEnvironment)} |`] : []),
		...(input.headSha ? [`| HEAD Commit | \`${escCell(input.headSha.slice(0, 12))}\` |`] : []),
		...(input.gitRange ? [`| Git Range | \`${escCell(input.gitRange.from)}..${escCell(input.gitRange.to)}\` |`] : []),
		`| Generated | ${escCell(input.generatedOn)} |`,
		"",
	];

	if (input.tickets.length) {
		parts.push("## Included Tickets", "", "| Ticket | Status | Priority | Title |", "| --- | --- | --- | --- |");
		for (const t of input.tickets) {
			parts.push(`| ${clipTableCell(t.key, 20)} | ${clipTableCell(t.status || "—", 20)} | ${clipTableCell(t.priority || "—", 20)} | ${clipTableCell(t.title, 100)} |`);
		}
		parts.push("");

		const withReadiness = input.tickets.filter((t) => t.readiness);
		if (withReadiness.length) {
			parts.push("## Readiness Summary", "", "| Ticket | Gate | Passing | Attention |", "| --- | --- | --- | --- |");
			for (const t of withReadiness) {
				const r = t.readiness!;
				const warns = r.checks.filter((c) => c.level === "warn").map((c) => c.label).join(", ");
				parts.push(
					`| ${clipTableCell(t.key, 20)} | ${r.ready ? "READY" : "WARN"} | ${r.pass}/${r.total} | ${clipTableCell(warns || "All clear", 100)} |`,
				);
			}
			parts.push("");
		}
	}

	parts.push("## Code & Application Artifacts", "");
	if (scriptMap.size) {
		parts.push("| Type | Tickets | Artifact |", "| --- | --- | --- |");
		for (const item of scriptMap.values()) {
			parts.push(`| ${clipTableCell(item.kind, 20)} | ${clipTableCell(item.tickets.join(", ") || "—", 20)} | \`${escCell(item.ref)}\` |`);
		}
		parts.push("");
	} else {
		parts.push("_No SSL scripts or application code references linked in this release._", "");
	}

	if (testScriptMap.size || dedupedPlanTests.length) {
		parts.push("## Verification & Test Scripts", "");
		if (testScriptMap.size) {
			parts.push("| Tickets | Test Script |", "| --- | --- |");
			for (const ts of testScriptMap.values()) {
				parts.push(`| ${clipTableCell(ts.tickets.join(", ") || "—", 20)} | \`${escCell(ts.ref)}\` |`);
			}
			parts.push("");
		}
		if (dedupedPlanTests.length) {
			parts.push("### Business Test Cases", "", "| Case | Plan | Expected |", "| --- | --- | --- |");
			for (const pt of dedupedPlanTests) {
				const detail = [pt.given ? `Given ${pt.given}` : "", pt.expect || ""].filter(Boolean).join(" -> ") || "—";
				parts.push(`| ${clipTableCell(pt.name, 20)} | ${clipTableCell(pt.plan || "—", 20)} | ${clipTableCell(detail, 100)} |`);
			}
			parts.push("");
		}
	}

	if (sqlMap.size) {
		parts.push("## Database & Schema Artifacts", "", "| Kind | Source | Artifact |", "| --- | --- | --- |");
		for (const sql of sqlMap.values()) {
			parts.push(`| ${clipTableCell(sql.kind, 20)} | ${clipTableCell(sql.sources.join(", ") || "—", 20)} | \`${escCell(sql.path)}\` |`);
		}
		parts.push("");
	}

	const nonEmptyRegs = [...regMap.values()].filter((r) => r.rows.length > 0);
	if (nonEmptyRegs.length) {
		parts.push("## Configuration & Registry Changes", "");
		for (const reg of nonEmptyRegs) {
			parts.push(`### ${reg.title}`, "");
			parts.push(`| ${reg.headers.map(escCell).join(" | ")} |`);
			parts.push(`| ${reg.headers.map(() => "---").join(" | ")} |`);
			for (const row of reg.rows) {
				parts.push(`| ${reg.headers.map((_, idx) => escCell(row[idx] ?? "")).join(" | ")} |`);
			}
			parts.push("");
		}
	}

	if (checksumMap.size) {
		parts.push("## Artifact Checksums", "", "| SHA-256 | Artifact |", "| --- | --- |");
		for (const c of checksumMap.values()) {
			parts.push(`| \`${clipTableCell(c.sha256.slice(0, 16), 20)}\` | \`${clipTableCell(c.path, 98)}\` |`);
		}
		parts.push("");
	}

	if (input.commits?.length) {
		parts.push("## Git Commits in Range", "", "| Commit | Author | Subject |", "| --- | --- | --- |");
		for (const c of input.commits) {
			parts.push(`| \`${clipTableCell(c.shortSha, 20)}\` | ${clipTableCell(c.author || "—", 20)} | ${clipTableCell(c.subject, 100)} |`);
		}
		parts.push("");
	}

	if (input.runbook) {
		const dedupedScriptsForRb: DeploymentManifestScript[] = [...scriptMap.values()].map((s) => ({
			ref: s.ref,
			kind: s.kind,
			ticket: s.tickets.join(", "),
		}));
		const dedupedTestsForRb = [...testScriptMap.values()].map((ts) => ({
			ref: ts.ref,
			ticket: ts.tickets.join(", "),
		}));
		const rbInput: DeploymentRunbookInput = {
			scripts: dedupedScriptsForRb,
			sqlArtifacts: input.sqlArtifacts,
			registries: nonEmptyRegs.map((r) => ({ title: r.title, headers: r.headers, rows: r.rows })),
			testScripts: dedupedTestsForRb,
			planTests: dedupedPlanTests,
			checksums: [...checksumMap.values()],
			...(typeof input.runbook === "object" ? input.runbook : {}),
		};
		parts.push(assembleDeploymentRunbook(rbInput), "");
	}

	parts.push("## Rollback Plan", "");
	if (dedupedRollbacks.length) {
		for (const rb of dedupedRollbacks) {
			const header = rb.source ? `**${rb.ticket} (${rb.source}):**` : `**${rb.ticket}:**`;
			parts.push(header, "", rb.body.trim(), "");
		}
	} else {
		parts.push(
			"- [ ] Export pre-deployment XFD/SSL backup package from target environment before importing.",
			"- [ ] Confirm database DDL changes have a tested reverse script or snapshot restore point.",
			"- [ ] Verify affected settings, jobs, and interfaces can be restored to prior values if smoke checks fail.",
			"",
		);
	}

	parts.push(
		"## Promotion Sign-Off",
		"",
		"| Stage | Target | Verified By | Sign-Off |",
		"| --- | --- | --- | --- |",
		"| DEV | Development | | [ ] Pending |",
		"| QA | Quality Assurance | | [ ] Pending |",
		"| UAT | User Acceptance | | [ ] Pending |",
		"| PROD | Production | | [ ] Pending |",
		"",
	);

	return parts.join("\n").trimEnd() + "\n";
}

/**
 * Assembles a deduplicated flat CSV Release Bundle suitable for CAB / ServiceNow / Excel import.
 * Columns: Release, Category, Artifact, Tickets, Status, SHA-256, Notes.
 */
export function assembleReleaseBundleCsv(input: ReleaseBundleInput): string {
	const { scriptMap, testScriptMap, dedupedPlanTests, sqlMap, regMap, checksumMap } =
		deduplicateReleaseBundleArtifacts(input);
	const shaOf = (p: string) => checksumMap.get(normPathKey(p))?.sha256 ?? "";
	const release = input.releaseName;
	const rows: string[] = [csvRow(["Release", "Category", "Artifact", "Tickets", "Status", "SHA-256", "Notes"], ",")];

	for (const s of scriptMap.values()) {
		rows.push(csvRow([release, s.kind, s.ref, s.tickets.join("; "), "planned", shaOf(s.ref), ""], ","));
	}
	for (const ts of testScriptMap.values()) {
		rows.push(csvRow([release, "Test Script", ts.ref, ts.tickets.join("; "), "planned", shaOf(ts.ref), ""], ","));
	}
	for (const pt of dedupedPlanTests) {
		const note = [pt.plan ? `Plan: ${pt.plan}` : "", pt.given ? `Given ${pt.given}` : "", pt.expect ? `Expect ${pt.expect}` : ""]
			.filter(Boolean)
			.join("; ");
		rows.push(csvRow([release, "Business Test", pt.name, pt.ticket ?? "", "planned", "", note], ","));
	}
	for (const sql of sqlMap.values()) {
		rows.push(csvRow([release, sql.kind, sql.path, sql.tickets.join("; "), "planned", shaOf(sql.path), sql.sources.join("; ")], ","));
	}
	for (const reg of regMap.values()) {
		const lowerHeaders = reg.headers.map((h) => h.trim().toLowerCase());
		const statusIdx = lowerHeaders.findIndex((h) => h === "status" || h === "state");
		const ticketIdx = lowerHeaders.findIndex((h) => h === "ticket" || h === "tickets");
		const shaIdx = lowerHeaders.findIndex((h) => h === "sha256" || h === "sha-256" || h === "checksum");
		const notesIdx = lowerHeaders.findIndex((h) => h === "notes" || h === "note" || h === "comment" || h === "description");
		for (const r of reg.rows) {
			const item = r[0] ?? "";
			const t = ticketIdx >= 0 ? (r[ticketIdx] ?? "").trim() : "";
			const st = statusIdx >= 0 ? (r[statusIdx] ?? "").trim() : "";
			const sha = shaIdx >= 0 && r[shaIdx] ? r[shaIdx]!.trim() : shaOf(item);
			const extra =
				notesIdx >= 0 && r[notesIdx]
					? r[notesIdx]!
					: reg.headers
							.map((h, i) => (i === 0 || i === statusIdx || i === ticketIdx || i === shaIdx || !r[i] ? "" : `${h}: ${r[i]}`))
							.filter(Boolean)
							.join("; ");
			rows.push(csvRow([release, `Registry: ${reg.title}`, item, t, st, sha, extra], ","));
		}
	}
	return `${rows.join("\n")}\n`;
}

/**
 * Assembles stakeholder-ready Release Notes grouped by ticket type / status / release,
 * plus Git commit highlights and upgrade/migration notes.
 */
export function assembleReleaseNotesMarkdown(input: ReleaseBundleInput): string {
	const parts: string[] = [
		`# Release Notes — ${input.releaseName}`,
		"",
		`_${input.projectName} · Released ${input.generatedOn}${input.headSha ? ` · Commit \`${input.headSha.slice(0, 8)}\`` : ""}_`,
		"",
	];

	const bucketOf = (t: ReleaseBundleTicket): string => {
		const ty = (t.type ?? "").trim().toLowerCase();
		if (/bug|defect|fix|incident|hotfix/.test(ty)) return "Bug Fixes";
		if (/epic/.test(ty)) return "Initiatives & Epics";
		if (/story|feature|enhancement|improvement/.test(ty)) return "Features & Enhancements";
		if (/task|sub-?task|chore|spike/.test(ty)) return "Tasks & Maintenance";
		if (t.release && t.release.toLowerCase() !== input.releaseName.toLowerCase()) return `Release: ${t.release}`;
		const tone = toneOf(t.status);
		if (tone === "done") return "Delivered Changes";
		return "In-Scope Changes";
	};

	const bucketOrder = [
		"Initiatives & Epics",
		"Features & Enhancements",
		"Bug Fixes",
		"Tasks & Maintenance",
		"Delivered Changes",
		"In-Scope Changes",
	];
	const grouped = new Map<string, ReleaseBundleTicket[]>();
	for (const t of input.tickets) {
		const b = bucketOf(t);
		const list = grouped.get(b) ?? [];
		list.push(t);
		grouped.set(b, list);
	}
	const orderedKeys = [
		...bucketOrder.filter((k) => grouped.has(k)),
		...[...grouped.keys()].filter((k) => !bucketOrder.includes(k)),
	];

	for (const heading of orderedKeys) {
		const items = grouped.get(heading)!;
		parts.push(`## ${heading}`, "");
		for (const t of items) {
			const statusTag = t.status ? ` _(${t.status})_` : "";
			const summaryPart = t.summary ? ` — ${t.summary}` : "";
			parts.push(`- **${t.key}**: ${t.title}${statusTag}${summaryPart}`);
		}
		parts.push("");
	}

	if (input.commits?.length) {
		parts.push(
			`## Commit Highlights${input.gitRange ? ` (\`${input.gitRange.from}..${input.gitRange.to}\`)` : ""}`,
			"",
		);
		for (const c of input.commits.slice(0, 40)) {
			parts.push(`- \`${c.shortSha}\` ${c.subject}${c.author ? ` _(${c.author})_` : ""}`);
		}
		if (input.commits.length > 40) {
			parts.push(`- _… and ${input.commits.length - 40} more commits in range_`);
		}
		parts.push("");
	}

	const uniqueSqlCount = new Set(input.sqlArtifacts.map((s) => s.path.toLowerCase())).size;
	const uniqueRegRows = input.registries.reduce((sum, r) => sum + r.rows.length, 0);
	if (uniqueSqlCount > 0 || uniqueRegRows > 0 || (input.rollbackNotes?.length ?? 0) > 0) {
		parts.push("## Deployment & Upgrade Notes", "");
		if (uniqueSqlCount > 0) {
			parts.push(`- **Database / Schema:** ${uniqueSqlCount} SQL/schema ${uniqueSqlCount === 1 ? "artifact" : "artifacts"} included; apply before importing application scripts.`);
		}
		if (uniqueRegRows > 0) {
			parts.push(`- **Configuration / Registries:** ${uniqueRegRows} tracked registry ${uniqueRegRows === 1 ? "change" : "changes"} across ${input.registries.map((r) => r.title).join(", ")}.`);
		}
		if (input.rollbackNotes?.length) {
			parts.push(`- **Rollback Guidance:** Ticket-specific rollback steps are included in the companion Release Bundle.`);
		}
		parts.push("");
	}

	return parts.join("\n").trimEnd() + "\n";
}

// --- Requirements Traceability Matrix (RTM) ----------------------------------

export type RtmOptions = {
	testRuns?: readonly TestRunSummary[];
	currentGitSha?: string | null;
};

export type RtmInput = {
	docs: readonly DocFile[];
	tickets?: readonly DocFile[];
	headSha?: string | null;
	testRuns?: readonly TestRunSummary[];
	currentGitSha?: string | null;
};

export type RtmRow = {
	ticket: string;
	title: string;
	status: string;
	release: string;
	priority: string;
	acceptanceCriteria: string;
	specs: string[];
	plans: string[];
	codeScripts: string[];
	testScripts: string[];
	planTests: string[];
	decisions: string[];
	registries: string[];
	approval: string;
	changeControl: string;
	headSha: string;
	/** Concise IQ/OQ/PQ execution status badge (e.g. `OQ PASS`, `OQ FAIL`, `OQ STALE`, `PARTIAL`). */
	validationStatus?: string;
	/** Human-readable per-run validation evidence lines for CSV & Markdown trace details. */
	validationRuns?: string[];
	/** True when the ticket's passing validation run(s) were executed against a stale Git SHA. */
	validationStale?: boolean;
};

/**
 * Builds Requirements Traceability Matrix rows linking every selected ticket to its
 * acceptance criteria progress, specs, plans, code scripts, test scripts, plan business
 * test cases, decisions, registries, formal approvals, validation runs, and HEAD Git SHA.
 */
export function buildRtmRows(input: RtmInput): RtmRow[];
export function buildRtmRows(
	docs: readonly DocFile[],
	tickets?: readonly DocFile[],
	headSha?: string | null,
	options?: RtmOptions,
): RtmRow[];
export function buildRtmRows(
	docsOrInput: readonly DocFile[] | RtmInput,
	ticketsArg?: readonly DocFile[],
	headShaArg?: string | null,
	optionsArg?: RtmOptions,
): RtmRow[] {
	const isInputObj = !Array.isArray(docsOrInput);
	const docs = isInputObj ? (docsOrInput as RtmInput).docs : (docsOrInput as readonly DocFile[]);
	const tickets = isInputObj ? (docsOrInput as RtmInput).tickets : ticketsArg;
	const headSha = isInputObj ? (docsOrInput as RtmInput).headSha : headShaArg;
	const testRuns = isInputObj ? (docsOrInput as RtmInput).testRuns : optionsArg?.testRuns;
	const effectiveGitSha = (isInputObj ? (docsOrInput as RtmInput).currentGitSha : optionsArg?.currentGitSha) ?? headSha;

	const selected = (
		tickets?.length
			? tickets
			: docs.filter((d) => d.exists && d.group === "tickets" && !isCatalog(d) && d.ticket)
	)
		.filter((d) => d.exists && d.group === "tickets" && d.ticket)
		.slice()
		.sort((a, b) => (a.ticket ?? "").localeCompare(b.ticket ?? "", undefined, { numeric: true, sensitivity: "base" }));

	const shortSha = (effectiveGitSha ?? headSha) ? (effectiveGitSha ?? headSha)!.trim().slice(0, 12) : "";
	const rows: RtmRow[] = [];

	for (const t of selected) {
		const key = t.ticket!;
		const groups = ticketWork(docs, key);
		const specDocs = groups.find((g) => g.kind === "spec")?.files ?? [];
		const planDocs = groups.find((g) => g.kind === "plan")?.files ?? [];
		const decisionDocs = groups.find((g) => g.kind === "decision")?.files ?? [];
		const registryDocs = groups.find((g) => g.kind === "registry")?.files ?? [];

		const testScripts = [
			...new Set(
				[t, ...specDocs, ...planDocs]
					.flatMap((d) => d.testScripts ?? [])
					.map((s) => s.trim())
					.filter(Boolean),
			),
		];
		const testScriptSet = new Set(testScripts.map((s) => s.toLowerCase()));
		const codeScripts = scriptsForTicket(docs, key).filter((s) => !testScriptSet.has(s.toLowerCase()));
		const planTests = [
			...new Set(
				planDocs
					.flatMap((p) => p.planTests ?? [])
					.map((pt) => pt.name.trim())
					.filter(Boolean),
			),
		];

		const registries = registryDocs.map((reg) => {
			const entry = reg.forTickets?.find((ft) => ft.key.toLowerCase() === key.toLowerCase());
			const name = registryTitle(reg.name);
			if (!entry) return name;
			return entry.done !== undefined ? `${name} (${entry.done}/${entry.rows})` : `${name} (${entry.rows})`;
		});

		const approverDoc = t.approvedBy ? t : specDocs.find((s) => Boolean(s.approvedBy));
		const approval = approverDoc?.approvedBy
			? approverDoc.approvedDate
				? `${approverDoc.approvedBy} (${approverDoc.approvedDate})`
				: approverDoc.approvedBy
			: "—";
		const changeControl = t.changeControl || specDocs.find((s) => Boolean(s.changeControl))?.changeControl || "";

		let validationFields: Pick<RtmRow, "validationStatus" | "validationRuns" | "validationStale"> = {};
		if (testRuns?.length) {
			const childKeys = descendantTickets(docs, key)
				.filter((d) => toneOf(d.status) !== "off" && d.ticket)
				.map((d) => d.ticket!.toLowerCase());
			const ticketKeys = new Set([key.toLowerCase(), ...childKeys]);
			const matched = testRuns.filter((r) => ticketKeys.has(r.ticket.trim().toLowerCase()));
			const summary = summarizeTicketTestRuns(matched, effectiveGitSha);
			if (summary) {
				validationFields = {
					validationStatus: summary.badge,
					validationRuns: summary.runLines,
					validationStale: summary.stale,
				};
			} else {
				validationFields = {
					validationStatus: "—",
					validationRuns: [],
					validationStale: false,
				};
			}
		}

		rows.push({
			ticket: key,
			title: t.title || t.name,
			status: t.status || "—",
			release: t.release || "",
			priority: t.priority || "",
			acceptanceCriteria: t.tasks && t.tasks.total > 0 ? `${t.tasks.done}/${t.tasks.total}` : "—",
			specs: specDocs.map((s) => s.title || s.name),
			plans: planDocs.map((p) => p.heading || p.title || p.name),
			codeScripts,
			testScripts,
			planTests,
			decisions: decisionDocs.map((d) => d.title || d.name),
			registries,
			approval,
			changeControl,
			headSha: shortSha,
			...validationFields,
		});
	}
	return rows;
}

/** Formats Requirements Traceability Matrix rows as an audit-ready CSV export. */
export function assembleRtmCsv(rows: readonly RtmRow[]): string {
	const hasValidation = rows.some((r) => Boolean(r.validationStatus || r.validationRuns?.length));
	const baseHeaders = [
		"Ticket",
		"Title",
		"Status",
		"Release",
		"Priority",
		"Acceptance Criteria",
		"Specs",
		"Plans",
		"Code Scripts",
		"Test Scripts",
		"Business Tests",
		"Decisions",
		"Registries",
		"Approval",
		"Change Control",
		"Git SHA",
	];
	const headers = hasValidation ? [...baseHeaders, "Validation Status", "Validation Runs"] : baseHeaders;
	const out: string[] = [csvRow(headers, ",")];
	for (const r of rows) {
		const baseCols = [
			r.ticket,
			r.title,
			r.status,
			r.release,
			r.priority,
			r.acceptanceCriteria,
			r.specs.join("; "),
			r.plans.join("; "),
			r.codeScripts.join("; "),
			r.testScripts.join("; "),
			r.planTests.join("; "),
			r.decisions.join("; "),
			r.registries.join("; "),
			r.approval,
			r.changeControl,
			r.headSha,
		];
		const cols = hasValidation ? [...baseCols, r.validationStatus ?? "", (r.validationRuns ?? []).join("; ")] : baseCols;
		out.push(csvRow(cols, ","));
	}
	return `${out.join("\n")}\n`;
}

/**
 * Formats Requirements Traceability Matrix rows as ADR-0008-compliant Markdown
 * (4-column summary overview table + per-ticket traceability breakdown sections).
 */
export function assembleRtmMarkdown(rows: readonly RtmRow[], projectName: string): string {
	const sha = rows.find((r) => r.headSha)?.headSha ?? "";
	const hasValidation = rows.some((r) => Boolean(r.validationStatus && r.validationStatus !== "—"));
	const parts: string[] = [
		`# Requirements Traceability Matrix — ${projectName}`,
		"",
		`_${rows.length} ${rows.length === 1 ? "ticket" : "tickets"} traced${sha ? ` · HEAD \`${sha}\`` : ""}_`,
		"",
	];

	if (!rows.length) {
		parts.push("_No tickets found to trace._", "");
		return parts.join("\n");
	}

	if (hasValidation) {
		parts.push("## Summary", "", "| Ticket | Status | Validation | Title |", "| --- | --- | --- | --- |");
		for (const r of rows) {
			parts.push(
				`| ${clipTableCell(r.ticket, 20)} | ${clipTableCell(r.status, 20)} | ${clipTableCell(r.validationStatus || "—", 20)} | ${clipTableCell(r.title, 100)} |`,
			);
		}
	} else {
		parts.push("## Summary", "", "| Ticket | Status | AC | Title |", "| --- | --- | --- | --- |");
		for (const r of rows) {
			parts.push(
				`| ${clipTableCell(r.ticket, 20)} | ${clipTableCell(r.status, 20)} | ${clipTableCell(r.acceptanceCriteria, 20)} | ${clipTableCell(r.title, 100)} |`,
			);
		}
	}
	parts.push("", "## Traceability Details", "");

	const listOrDash = (items: readonly string[], code = false) =>
		items.length ? items.map((x) => (code ? `\`${x}\`` : x)).join(", ") : "—";

	for (const r of rows) {
		parts.push(`### ${r.ticket}: ${r.title}`, "");
		parts.push("| Attribute | Trace |", "| --- | --- |");
		parts.push(
			`| Status | ${clipTableCell(`${r.status}${r.release ? ` · Release: ${r.release}` : ""}${r.priority ? ` · Priority: ${r.priority}` : ""}`, 100)} |`,
		);
		parts.push(`| Acceptance | ${clipTableCell(r.acceptanceCriteria, 100)} |`);
		parts.push(`| Specs | ${clipTableCell(listOrDash(r.specs), 100)} |`);
		parts.push(`| Plans | ${clipTableCell(listOrDash(r.plans), 100)} |`);
		parts.push(`| Code Scripts | ${clipTableCell(listOrDash(r.codeScripts, true), 100)} |`);
		parts.push(`| Test Scripts | ${clipTableCell(listOrDash(r.testScripts, true), 100)} |`);
		if (r.planTests.length) parts.push(`| Business Tests | ${clipTableCell(listOrDash(r.planTests), 100)} |`);
		if (r.decisions.length) parts.push(`| Decisions | ${clipTableCell(listOrDash(r.decisions), 100)} |`);
		if (r.registries.length) parts.push(`| Registries | ${clipTableCell(listOrDash(r.registries), 100)} |`);
		if (r.validationStatus || r.validationRuns?.length) {
			const valText = r.validationRuns?.length ? r.validationRuns.join("; ") : (r.validationStatus ?? "—");
			parts.push(`| Validation | ${clipTableCell(valText, 100)} |`);
		}
		parts.push(
			`| Approval | ${clipTableCell(`${r.approval}${r.changeControl ? ` · ${r.changeControl}` : ""}`, 100)} |`,
		);
		if (r.headSha) parts.push(`| Git SHA | \`${clipTableCell(r.headSha, 98)}\` |`);
		if (r.validationRuns && r.validationRuns.length > 1) {
			parts.push("");
			for (const line of r.validationRuns) parts.push(`- ${line}`);
		}
		parts.push("");
	}

	return parts.join("\n").trimEnd() + "\n";
}
