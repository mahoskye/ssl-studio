// Pure DOM-free HTML -> Markdown and Excel/TSV -> Markdown table converters.
// Used by CM6 smart clipboard paste, Azure DevOps ticket import, and HTML/Confluence doc import.

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	hellip: "…",
	bull: "•",
	copy: "©",
	reg: "®",
	trade: "™",
};

export function decodeHtmlEntities(input: string): string {
	return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
		const lower = code.toLowerCase();
		if (lower in ENTITIES) return ENTITIES[lower]!;
		if (lower.startsWith("#x")) {
			const n = Number.parseInt(lower.slice(2), 16);
			return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
		}
		if (lower.startsWith("#")) {
			const n = Number.parseInt(lower.slice(1), 10);
			return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
		}
		return m;
	});
}

function stripTags(html: string): string {
	return decodeHtmlEntities(html.replace(/<[^>]+>/g, ""));
}

function escapePipeCell(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\n+/g, "<br>")
		.replace(/\|/g, "\\|")
		.trim();
}

function attrOf(tag: string, name: string): string {
	const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
	const m = re.exec(tag);
	return decodeHtmlEntities((m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim());
}

/** True when an HTML clipboard fragment carries real semantic formatting worth converting. */
export function looksLikeRichHtml(html: string): boolean {
	if (!html || html.length < 6) return false;
	// Exclude plain VS Code / Monaco / editor HTML wrappers that only emit styled <div><span> lines.
	const stripped = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<meta[^>]*>/gi, "");
	return /<(h[1-6]|table|ul|ol|li|a\s+[^>]*href|strong|b\b|em|i\b|code|pre|blockquote|img\s+[^>]*src|del|s\b|hr|details)\b/i.test(stripped);
}

function convertTable(tableHtml: string): string {
	const rows: { cells: string[]; isHeader: boolean }[] = [];
	const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
	let trMatch: RegExpExecArray | null;
	while ((trMatch = trRe.exec(tableHtml)) !== null) {
		const rowBody = trMatch[1] ?? "";
		const cells: string[] = [];
		let thCount = 0;
		const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
		let cellMatch: RegExpExecArray | null;
		while ((cellMatch = cellRe.exec(rowBody)) !== null) {
			if (cellMatch[1]!.toLowerCase() === "th") thCount++;
			const inner = convertInline(cellMatch[2] ?? "");
			cells.push(escapePipeCell(inner));
		}
		if (cells.length) rows.push({ cells, isHeader: thCount === cells.length });
	}
	if (!rows.length) return "";
	const width = Math.max(...rows.map((r) => r.cells.length));
	const pad = (cells: string[]) => {
		const out = cells.slice();
		while (out.length < width) out.push("");
		return `| ${out.join(" | ")} |`;
	};
	const header = rows[0]!.cells;
	const sep = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
	const body = rows.slice(1).map((r) => pad(r.cells));
	return `\n\n${pad(header)}\n${sep}${body.length ? `\n${body.join("\n")}` : ""}\n\n`;
}

function convertInline(html: string): string {
	let s = html;
	// Line breaks
	s = s.replace(/<br\s*\/?>/gi, "\n");
	// Inline code first so inner tags/asterisks stay untouched
	const codeSlots: string[] = [];
	s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
		const text = stripTags(inner).replace(/\r\n?/g, "\n").replace(/\n/g, " ");
		const fence = text.includes("`") ? "``" : "`";
		const idx = codeSlots.push(`${fence}${text}${fence}`) - 1;
		return `\x00CODE${idx}\x00`;
	});
	// Images
	s = s.replace(/<img\b[^>]*>/gi, (tag) => {
		const src = attrOf(tag, "src");
		const alt = attrOf(tag, "alt");
		return src ? `![${alt}](${src})` : alt ? `[Image: ${alt}]` : "";
	});
	// Links
	s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
		const href = attrOf(`<a ${attrs}>`, "href");
		const label = convertInline(inner).replace(/\s+/g, " ").trim();
		if (!href || href.startsWith("javascript:")) return label;
		if (!label) return href;
		if (label === href) return `<${href}>`;
		return `[${label}](${href})`;
	});
	// Emphasis, bold, strike, mark
	s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
		const t = convertInline(inner).trim();
		return t ? `**${t}**` : "";
	});
	s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
		const t = convertInline(inner).trim();
		return t ? `*${t}*` : "";
	});
	s = s.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
		const t = convertInline(inner).trim();
		return t ? `~~${t}~~` : "";
	});
	s = s.replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi, (_m, inner: string) => {
		const t = convertInline(inner).trim();
		return t ? `==${t}==` : "";
	});
	// Task checkboxes
	s = s.replace(/<input\b[^>]*type=["']?checkbox["']?[^>]*>/gi, (tag) => (/\bchecked\b/i.test(tag) ? "[x] " : "[ ] "));
	// Remaining tags
	s = s.replace(/<[^>]+>/g, "");
	s = decodeHtmlEntities(s);
	s = s.replace(/\x00CODE(\d+)\x00/g, (_m, idx: string) => codeSlots[Number(idx)] ?? "");
	return s;
}

function convertList(listHtml: string, ordered: boolean, depth = 0): string {
	const indent = "  ".repeat(depth);
	const out: string[] = [];
	let itemIdx = 1;
	// Match top-level <li> elements inside this list by tracking nested list depth.
	let pos = 0;
	const lower = listHtml.toLowerCase();
	while (pos < listHtml.length) {
		const liStart = lower.indexOf("<li", pos);
		if (liStart < 0) break;
		const tagEnd = listHtml.indexOf(">", liStart);
		if (tagEnd < 0) break;
		let scan = tagEnd + 1;
		let nest = 1;
		while (scan < listHtml.length && nest > 0) {
			const nextOpen = lower.indexOf("<li", scan);
			const nextClose = lower.indexOf("</li>", scan);
			if (nextClose < 0) {
				scan = listHtml.length;
				break;
			}
			if (nextOpen >= 0 && nextOpen < nextClose) {
				const ch = lower[nextOpen + 3];
				if (ch === ">" || ch === " " || ch === "\t" || ch === "\n") nest++;
				scan = nextOpen + 3;
			} else {
				nest--;
				if (nest === 0) {
					const rawItem = listHtml.slice(tagEnd + 1, nextClose);
					const nestedBlocks: string[] = [];
					const strippedItem = rawItem.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag: string, inner: string) => {
						nestedBlocks.push(convertList(inner, tag.toLowerCase() === "ol", depth + 1));
						return "";
					});
					const text = convertInline(strippedItem)
						.replace(/\s*\n\s*/g, " ")
						.replace(/\s{2,}/g, " ")
						.trim();
					const marker = ordered ? `${itemIdx++}. ` : "- ";
					if (text) out.push(`${indent}${marker}${text}`);
					for (const nb of nestedBlocks) {
						if (nb.trim()) out.push(nb);
					}
					scan = nextClose + 5;
					break;
				}
				scan = nextClose + 5;
			}
		}
		pos = scan;
	}
	return out.join("\n");
}

/**
 * Converts HTML (clipboard fragments, Confluence/Azure DevOps exports, or standalone HTML docs)
 * into clean GitHub-Flavored Markdown. Pure, dependency-free, safe on untrusted markup.
 */
export function htmlToMarkdown(html: string): string {
	if (!html) return "";
	let s = html
		.replace(/\r\n?/g, "\n")
		.replace(/<!--StartFragment-->|<!--EndFragment-->/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|head|noscript|svg)\b[\s\S]*?<\/\1>/gi, "");

	// Extract full HTML body when present
	const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s);
	if (bodyMatch) s = bodyMatch[1]!;

	const slots: string[] = [];
	const stash = (md: string) => {
		const idx = slots.push(md) - 1;
		return `\n\n\x00BLOCK${idx}\x00\n\n`;
	};

	// Preformatted code blocks first
	s = s.replace(/<pre\b[^>]*>\s*(?:<code\b([^>]*)>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi, (_m, codeAttrs: string | undefined, inner: string) => {
		const cls = codeAttrs ? attrOf(`<code ${codeAttrs}>`, "class") : "";
		const langMatch = /\b(?:language|lang)-([a-z0-9_+-]+)\b/i.exec(cls);
		const lang = langMatch?.[1]?.toLowerCase() ?? "";
		const body = stripTags(inner).replace(/^\n+|\n+$/g, "");
		return stash(`\`\`\`${lang}\n${body}\n\`\`\``);
	});

	// Tables
	s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tbl) => stash(convertTable(tbl).trim()));

	// Details/summary
	s = s.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, (_m, inner: string) => {
		const sumMatch = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
		const summary = sumMatch ? convertInline(sumMatch[1]!).trim() : "Details";
		const body = htmlToMarkdown(inner.replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, "")).trim();
		return stash(`<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`);
	});

	// Blockquotes & Confluence/Jira info/warning panels
	s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
		const body = htmlToMarkdown(inner).trim();
		if (!body) return "";
		const quoted = body
			.split("\n")
			.map((l) => (l.trim() ? `> ${l}` : ">"))
			.join("\n");
		return stash(quoted);
	});

	// Lists (outermost ul/ol)
	s = s.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag: string, inner: string) => {
		const rendered = convertList(inner, tag.toLowerCase() === "ol", 0);
		return rendered ? stash(rendered) : "";
	});

	// Headings
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => {
		const title = convertInline(inner).replace(/\s+/g, " ").trim();
		return title ? stash(`${"#".repeat(Number(lvl))} ${title}`) : "";
	});

	// Horizontal rules
	s = s.replace(/<hr\b[^>]*\/?>/gi, () => stash("---"));

	// Paragraphs & block divs
	s = s.replace(/<\/(p|div|section|article|header|footer|aside|main)>/gi, "\n\n");
	s = s.replace(/<(p|div|section|article|header|footer|aside|main)\b[^>]*>/gi, "\n");

	// Convert remaining inline markup
	s = convertInline(s);

	// Restore stashed blocks
	s = s.replace(/\x00BLOCK(\d+)\x00/g, (_m, idx: string) => slots[Number(idx)] ?? "");

	// Normalize blank lines and trailing whitespace
	return s
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Converts multi-row tab-separated clipboard text (e.g. copied from Excel or TableView)
 * into a clean GitHub-Flavored Markdown table. Returns null when text does not look like TSV.
 */
export function tsvToMarkdownTable(text: string): string | null {
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	if (!normalized || !normalized.includes("\t") || !normalized.includes("\n")) return null;
	const lines = normalized.split("\n").filter((l) => l.length > 0);
	if (lines.length < 2) return null;
	const rows = lines.map((line) => line.split("\t"));
	const colCount = rows[0]!.length;
	if (colCount < 2) return null;
	// Require consistent column count across at least 75% of rows (and never single-column prose with leading tab indents).
	const matching = rows.filter((r) => r.length === colCount).length;
	if (matching / rows.length < 0.75) return null;
	if (rows.every((r) => r[0] === "")) return null; // tab-indented code block, not TSV!

	const padRow = (cells: string[]) => {
		const out = cells.slice(0, colCount).map((c) => escapePipeCell(c));
		while (out.length < colCount) out.push("");
		return `| ${out.join(" | ")} |`;
	};
	const header = padRow(rows[0]!);
	const sep = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
	const body = rows.slice(1).map(padRow);
	return [header, sep, ...body].join("\n");
}
