// Pure stakeholder export & formatting helpers for SSL Studio documents:
// - Markdown -> Jira / Confluence wiki markup
// - Clean standalone print-ready HTML (PDF-ready via hidden iframe / browser print)
// - STARLIMS Release Readiness Gate evaluator
// - Ticket Release Packet assembler (ticket + readiness + specs + plans + sub-tickets + decisions + questions + registries + folder manifest)
import { frontMatter } from "./frontMatter";
import { isCatalog, registryTitle, toneOf } from "./projectDocs";
import type { DocFile } from "./protocol";
import { codeMatchesRef, scriptsForTicket, ticketWork, workFor } from "./workContext";

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
	let listIndents: number[] = [];

	const listDepth = (indentStr: string): number => {
		const width = indentStr.replace(/\t/g, "    ").length;
		if (!listIndents.length) {
			listIndents = [width];
			return 1;
		}
		while (listIndents.length > 1 && width < listIndents[listIndents.length - 1]!) {
			listIndents.pop();
		}
		if (width > listIndents[listIndents.length - 1]!) {
			listIndents.push(width);
		}
		return listIndents.length;
	};

	const inline = (line: string): string => {
		// Protect inline code spans before transforming emphasis/links.
		const spans: string[] = [];
		let s = line.replace(/`([^`]+)`/g, (_, code: string) => {
			const token = `\u0000CODE${spans.length}\u0000`;
			spans.push(`{{${code}}}`);
			return token;
		});
		// Wikilinks [[Target|Alias]] or [[Target]]
		s = s.replace(/\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g, (_, target: string, alias?: string) => (alias ? alias.trim() : target.trim()));
		// Markdown images ![alt](url) -> !url!
		s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, _alt: string, url: string) => `!${url}!`);
		// Markdown links [text](url) -> [text|url]
		s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) => `[${label}|${url}]`);
		// Protect bold & bold-italic BEFORE single-* italic conversion so bold doesn't clash with italic.
		const protectedTokens: string[] = [];
		const hold = (val: string) => {
			const tok = `\u0000FMT${protectedTokens.length}\u0000`;
			protectedTokens.push(val);
			return tok;
		};
		s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, (_, body: string) => hold(`*_${body}_*`));
		s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_, body: string) => hold(`*${body}*`));
		s = s.replace(/(^|[^\w])__([^_\n]+?)__(?=[^\w]|$)/g, (_, pre: string, body: string) => `${pre}${hold(`*${body}*`)}`);
		// Italic *text* -> Jira _text_
		s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?=[^\w*]|$)/g, (_, pre: string, body: string) => `${pre}_${body}_`);
		// Strikethrough ~~text~~ -> -text-
		s = s.replace(/~~([^~\n]+?)~~/g, "-$1-");
		// Highlight ==text== -> {color:#b45309}*text*{color}
		s = s.replace(/==([^=\n]+?)==/g, "{color:#b45309}*$1*{color}");
		// Restore held tokens & inline code spans
		s = s.replace(/\u0000FMT(\d+)\u0000/g, (_, idx: string) => protectedTokens[Number(idx)] ?? "");
		return s.replace(/\u0000CODE(\d+)\u0000/g, (_, idx: string) => spans[Number(idx)] ?? "");
	};

	while (i < lines.length) {
		const line = lines[i]!;

		// Fenced code blocks -> {code:lang}...{code}
		const fence = /^[ \t]{0,3}(`{3,}|~{3,})([A-Za-z0-9_+-]*)[ \t]*$/.exec(line);
		if (fence) {
			listIndents = [];
			const delim = fence[1]![0]!;
			const len = fence[1]!.length;
			const lang = fence[2]!.toLowerCase();
			const jiraLang = lang === "ssl" ? "none" : lang === "tsql" || lang === "plsql" ? "sql" : lang;
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

		// Obsidian / GitHub callout block -> {panel:title=...}...{panel}
		const callout = /^[ \t]{0,3}>[ \t]*\[!([A-Za-z0-9_-]+)\][+-]?[ \t]*(.*)$/.exec(line);
		if (callout) {
			listIndents = [];
			const kind = callout[1]!.toUpperCase();
			const title = callout[2]!.trim() || kind;
			i++;
			const bodyLines: string[] = [];
			while (i < lines.length && /^[ \t]{0,3}>/.test(lines[i]!)) {
				bodyLines.push(inline(lines[i]!.replace(/^[ \t]{0,3}>[ \t]?/, "")));
				i++;
			}
			out.push(`{panel:title=${title}}`);
			out.push(...bodyLines);
			out.push("{panel}");
			continue;
		}

		// Standard blockquote
		if (/^[ \t]{0,3}>[ \t]?/.test(line)) {
			listIndents = [];
			const bodyLines: string[] = [];
			while (i < lines.length && /^[ \t]{0,3}>/.test(lines[i]!)) {
				bodyLines.push(inline(lines[i]!.replace(/^[ \t]{0,3}>[ \t]?/, "")));
				i++;
			}
			out.push("{quote}", ...bodyLines, "{quote}");
			continue;
		}

		// GFM pipe table
		if (line.includes("|") && i + 1 < lines.length && /^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/.test(lines[i + 1]!)) {
			listIndents = [];
			const splitRow = (row: string) => splitMarkdownTableCells(row).map((c) => inline(c));
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
			listIndents = [];
			out.push(`h${heading[1]!.length}. ${inline(heading[2]!.replace(/\s+#+\s*$/, "").trim())}`);
			i++;
			continue;
		}

		// Horizontal rule
		if (/^[ \t]*(?:[-*_][ \t]*){3,}$/.test(line)) {
			listIndents = [];
			out.push("----");
			i++;
			continue;
		}

		// Task list items -> * (/) or * (-)
		const task = /^([ \t]*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
		if (task) {
			const depth = listDepth(task[1]!);
			const mark = task[2]!.toLowerCase() === "x" ? "(/)" : "(-)";
			out.push(`${"*".repeat(depth)} ${mark} ${inline(task[3]!)}`);
			i++;
			continue;
		}

		// Unordered lists
		const ul = /^([ \t]*)[-*+]\s+(.*)$/.exec(line);
		if (ul) {
			const depth = listDepth(ul[1]!);
			out.push(`${"*".repeat(depth)} ${inline(ul[2]!)}`);
			i++;
			continue;
		}

		// Ordered lists
		const ol = /^([ \t]*)\d+[.)]\s+(.*)$/.exec(line);
		if (ol) {
			const depth = listDepth(ol[1]!);
			out.push(`${"#".repeat(depth)} ${inline(ol[2]!)}`);
			i++;
			continue;
		}

		if (!line.trim()) listIndents = [];
		out.push(inline(line));
		i++;
	}

	return out.join("\n").trim() + "\n";
}

/**
 * Wraps sanitized rendered HTML in a clean standalone print-ready HTML document
 * suitable for saving, emailing, or Print -> Save as PDF.
 */
export function buildPrintableHtml(title: string, bodyHtml: string, subtitle?: string): string {
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
  header.doc-banner { margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #e4e4e7; }
  header.doc-banner h1 { margin: 0; font-size: 1.75rem; line-height: 1.25; }
  header.doc-banner p { margin: 6px 0 0; font-size: 0.9rem; color: #52525b; }
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
  .md-callout-warning, .md-callout-caution { border-left-color: #d97706; background: #fffbeb; }
  .md-callout-danger, .md-callout-failure, .md-callout-bug { border-left-color: #dc2626; background: #fef2f2; }
  .md-callout-tip, .md-callout-success, .md-callout-check { border-left-color: #16a34a; background: #f0fdf4; }
  .md-callout-title { font-weight: 600; margin-bottom: 4px; color: #0f172a; }
  .md-callout > :last-child { margin-bottom: 0; }
  mark, .md-highlight { background: #fef08a; color: #18181b; padding: 0.05em 0.25em; border-radius: 3px; }
  .md-tag { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 0.84em; background: #f4f4f5; color: #3f3f46; border: 1px solid #e4e4e7; }
  .md-mermaid-export { text-align: center; padding: 12px; border: 1px solid #e4e4e7; border-radius: 6px; background: #ffffff; break-inside: avoid; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; break-inside: avoid; page-break-inside: avoid; }
  th, td { border: 1px solid #e4e4e7; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f4f4f5; font-weight: 600; }
  hr { border: 0; border-top: 1px solid #e4e4e7; margin: 24px 0; }
  img, svg { max-width: 100%; height: auto; break-inside: avoid; page-break-inside: avoid; }
  @media print {
    body { padding: 0; font-size: 11pt; }
    main { max-width: none; }
    a { color: #18181b; text-decoration: underline; }
    pre, blockquote, table, .md-callout, .md-mermaid-export { break-inside: avoid; page-break-inside: avoid; }
    h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
  }
</style>
</head>
<body>
<main>
${subtitle ? `<header class="doc-banner"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></header>` : ""}
${bodyHtml}
</main>
</body>
</html>`;
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

/** Evaluates a ticket's transport / CAB release readiness from workspace docs, registries, and optional Git changes. */
export function evaluateTicketReadiness(
	files: readonly DocFile[],
	key: string,
	options?: { gitFiles?: readonly { path: string }[]; root?: string | null },
): ReadinessReport | null {
	const work = workFor(files, key);
	if (!work) return null;
	const groups = ticketWork(files, key);
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

	// 2. Sub-tickets done
	const subtickets = groups.find((g) => g.kind === "subticket")?.files ?? [];
	if (subtickets.length) {
		const open = subtickets.filter((s) => toneOf(s.status) !== "done");
		checks.push({
			label: "Sub-tickets",
			ok: open.length === 0,
			level: open.length === 0 ? "pass" : "warn",
			detail: open.length === 0 ? `All ${subtickets.length} done` : `${open.length} of ${subtickets.length} still open (${open[0]!.ticket ?? open[0]!.name})`,
			path: open[0]?.path ?? subtickets[0]!.path,
		});
	}

	// 3. Linked specs status
	if (work.specs.length) {
		const open = work.specs.filter((s) => {
			const t = toneOf(s.status);
			return t === "active" || t === "waiting";
		});
		checks.push({
			label: "Specifications",
			ok: open.length === 0,
			level: open.length === 0 ? "pass" : "warn",
			detail: open.length === 0 ? `${work.specs.length} approved / settled` : `${open.length} still ${open[0]!.status} (${open[0]!.title || open[0]!.name})`,
			path: open[0]?.path ?? work.specs[0]!.path,
		});
	}

	// 4. Open questions
	const openQuestions = groups.find((g) => g.kind === "question")?.files ?? [];
	checks.push({
		label: "Open questions",
		ok: openQuestions.length === 0,
		level: openQuestions.length === 0 ? "pass" : "warn",
		detail: openQuestions.length === 0 ? "None open" : `${openQuestions.length} unanswered (${openQuestions[0]!.title || openQuestions[0]!.name})`,
		path: openQuestions[0]?.path,
	});

	// 5. Linked CSV registries (settings, database, interfaces, etc.)
	const registries = groups.find((g) => g.kind === "registry")?.files ?? [];
	if (registries.length) {
		let totalRows = 0;
		let doneRows = 0;
		let firstPending: DocFile | undefined;
		for (const reg of registries) {
			const entry = reg.forTickets?.find((r) => r.key.toLowerCase() === key.toLowerCase());
			if (!entry) continue;
			totalRows += entry.rows;
			const d = entry.done ?? entry.rows;
			doneRows += d;
			if (d < entry.rows && !firstPending) firstPending = reg;
		}
		if (totalRows > 0) {
			const ok = doneRows >= totalRows;
			checks.push({
				label: "Registry rows",
				ok,
				level: ok ? "pass" : "warn",
				detail: ok ? `${doneRows}/${totalRows} verified or migrated` : `${doneRows}/${totalRows} done — ${firstPending ? registryTitle(firstPending.name) : "pending rows"}`,
				path: firstPending?.path ?? registries[0]!.path,
			});
		}
	}

	// 6. Broken links / missing refs across ticket + linked docs
	const scopeDocs = [ticket, ...groups.flatMap((g) => (g.kind === "registry" ? [] : g.files))].filter((d) => !isCatalog(d));
	const withBroken = scopeDocs.find((d) => (d.broken?.length ?? 0) > 0 || (d.missing?.length ?? 0) > 0);
	checks.push({
		label: "Document links",
		ok: !withBroken,
		level: !withBroken ? "pass" : "warn",
		detail: !withBroken ? "No broken links or missing refs" : `Broken link or missing ref in ${withBroken.ticket ?? withBroken.title ?? withBroken.name}`,
		path: withBroken?.path,
	});

	// 7. Uncommitted Git changes touching this ticket's scripts/docs (advisory note)
	if (options?.gitFiles) {
		const scriptRefs = scriptsForTicket(files, key);
		const scopePaths = new Set(scopeDocs.map((d) => d.path.replace(/\\/g, "/").toLowerCase()));
		const dirty = options.gitFiles.filter((gf) => {
			const norm = gf.path.replace(/\\/g, "/").toLowerCase();
			if (scopePaths.has(norm)) return true;
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

export type TicketPacketInput = {
	projectName: string;
	generatedOn: string;
	ticketKey: string;
	ticketTitle: string;
	status?: string;
	parent?: string;
	ticketBody: string;
	specs: { title: string; status?: string; body: string }[];
	plans: { name: string; title?: string; status?: string; scripts?: string[] }[];
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
};

/** Assembles a complete stakeholder release packet Markdown dossier for a ticket. */
export function assembleTicketPacketMarkdown(input: TicketPacketInput): string {
	const escCell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
	const parts: string[] = [
		`# ${input.ticketKey}: ${input.ticketTitle}`,
		"",
		"| Field | Value |",
		"| --- | --- |",
		`| Project | ${escCell(input.projectName)} |`,
		`| Ticket | ${escCell(input.ticketKey)} |`,
		`| Status | ${escCell(input.status || "—")} |`,
		...(input.parent ? [`| Parent | ${escCell(input.parent)} |`] : []),
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

	const cleanBody = frontMatter(input.ticketBody).body.replace(/^\s*#\s+.*\r?\n/, "").trim();
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
			const b = frontMatter(spec.body).body.replace(/^\s*#\s+.*\r?\n/, "").trim();
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

	if (input.decisions.length) {
		parts.push("## Decisions", "");
		for (const d of input.decisions) {
			parts.push(`### ${d.title}${d.status ? ` (${d.status})` : ""}`, "");
			const b = frontMatter(d.body).body.replace(/^\s*#\s+.*\r?\n/, "").trim();
			if (b) parts.push(b, "");
		}
	}

	if (input.questions.length) {
		parts.push("## Questions & Answers", "");
		for (const q of input.questions) {
			parts.push(`### ${q.title}${q.status ? ` (${q.status})` : ""}`, "");
			const b = frontMatter(q.body).body.replace(/^\s*#\s+.*\r?\n/, "").trim();
			if (b) parts.push(b, "");
		}
	}

	if (input.references?.length) {
		parts.push("## Reference Notes", "");
		for (const ref of input.references) {
			parts.push(`### ${ref.title}${ref.status ? ` (${ref.status})` : ""}`, "");
			const b = frontMatter(ref.body).body.replace(/^\s*#\s+.*\r?\n/, "").trim();
			if (b) parts.push(b, "");
		}
	}

	if (input.schemas?.length) {
		parts.push("## Schema & Data Contracts", "");
		for (const sc of input.schemas) {
			parts.push(`### ${sc.title}${sc.status ? ` (${sc.status})` : ""}`, "");
			const b = frontMatter(sc.body).body.replace(/^\s*#\s+.*\r?\n/, "").trim();
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
