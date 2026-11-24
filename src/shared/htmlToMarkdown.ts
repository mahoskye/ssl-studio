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
		if (Object.hasOwn(ENTITIES, lower)) return ENTITIES[lower]!;
		if (lower.startsWith("#x")) {
			const n = Number.parseInt(lower.slice(2), 16);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
		}
		if (lower.startsWith("#")) {
			const n = Number.parseInt(lower.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
		}
		return m;
	});
}

const DANGEROUS_URL_SCHEME_RE = /^(?:javascript|vbscript|data):/i;

function isSafeUrl(url: string): boolean {
	if (!url) return false;
	const cleaned = url.replace(/[\u0000-\u0020]+/g, "");
	return !DANGEROUS_URL_SCHEME_RE.test(cleaned);
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
	const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, "i");
	const m = re.exec(tag);
	return decodeHtmlEntities((m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim());
}

/** True when an HTML clipboard fragment carries real semantic formatting worth converting. */
export function looksLikeRichHtml(html: string): boolean {
	if (!html || html.length < 6) return false;
	// Exclude plain VS Code / Monaco / editor HTML wrappers that only emit styled <div><span> lines.
	const stripped = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<meta[^>]*>/gi, "");
	return /<(h[1-6]|table|ul|ol|li|a\s+[^>]*href|strong|b\b|em|i\b|code|pre|blockquote|img\s+[^>]*src|del|s\b|hr|details)\b/i.test(stripped);
}

/**
 * Replaces outermost balanced `<tag ...>...</tag>` blocks for any tag in `tagNames`
 * (case-insensitive) in a single linear pass, preserving arbitrarily nested same-name tags
 * and tolerating optional whitespace before `>` in closing tags (`</tag >`).
 */
function replaceBalancedTags(
	html: string,
	tagNames: readonly string[],
	replacer: (tag: string, attrs: string, inner: string) => string,
): string {
	const tagRe = new RegExp(`<(\\/?)(${tagNames.join("|")})(?=[\\s>/])([^>]*)>`, "gi");
	let out = "";
	let cursor = 0;
	let rootTag: string | null = null;
	let rootAttrs = "";
	let rootStart = 0;
	let innerStart = 0;
	let depth = 0;

	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(html)) !== null) {
		const isClose = m[1] === "/";
		const tag = m[2]!.toLowerCase();
		const attrs = m[3] ?? "";
		const isSelfClose = !isClose && /\/\s*$/.test(attrs);

		if (rootTag === null) {
			if (isClose) continue;
			if (isSelfClose) {
				out += html.slice(cursor, m.index) + replacer(tag, attrs, "");
				cursor = m.index + m[0].length;
				continue;
			}
			rootTag = tag;
			rootAttrs = attrs;
			rootStart = m.index;
			innerStart = m.index + m[0].length;
			depth = 1;
		} else if (tag === rootTag) {
			if (isClose) {
				depth--;
				if (depth === 0) {
					out += html.slice(cursor, rootStart) + replacer(rootTag, rootAttrs, html.slice(innerStart, m.index));
					cursor = m.index + m[0].length;
					rootTag = null;
				}
			} else if (!isSelfClose) {
				depth++;
			}
		}
	}
	if (cursor === 0) return html;
	return out + html.slice(cursor);
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

function convertInlineInner(html: string, slots: string[]): string {
	let s = html;
	const stash = (value: string) => {
		if (!value) return "";
		const idx = slots.push(value) - 1;
		return `\x00INL${idx}\x00`;
	};
	// Line breaks
	s = s.replace(/<br\s*\/?>/gi, "\n");
	// Inline code first so inner tags/asterisks stay untouched
	s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, inner: string) => {
		const text = stripTags(inner).replace(/\r\n?/g, "\n").replace(/\n/g, " ");
		const fence = text.includes("`") ? "``" : "`";
		return stash(`${fence}${text}${fence}`);
	});
	// Images (quote-aware tag match so `>` inside quoted attrs cannot truncate tag; reject dangerous URL schemes)
	s = s.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
		const rawSrc = attrOf(tag, "src");
		const src = isSafeUrl(rawSrc) ? rawSrc : "";
		const alt = attrOf(tag, "alt");
		return stash(src ? `![${alt}](${src})` : alt ? `[Image: ${alt}]` : "");
	});
	// Links (quote-aware attrs; reject dangerous URL schemes)
	s = s.replace(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
		const rawHref = attrOf(`<a ${attrs}>`, "href");
		const href = isSafeUrl(rawHref) ? rawHref : "";
		const label = convertInlineInner(inner, slots).replace(/\s+/g, " ").trim();
		if (!href) return stash(label);
		if (!label) return stash(href);
		if (label === href) return stash(`<${href}>`);
		return stash(`[${label}](${href})`);
	});
	// Emphasis, bold, strike, mark
	s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => {
		const t = convertInlineInner(inner, slots).trim();
		return t ? stash(`**${t}**`) : "";
	});
	s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => {
		const t = convertInlineInner(inner, slots).trim();
		return t ? stash(`*${t}*`) : "";
	});
	s = s.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => {
		const t = convertInlineInner(inner, slots).trim();
		return t ? stash(`~~${t}~~`) : "";
	});
	s = s.replace(/<mark\b[^>]*>([\s\S]*?)<\/mark\s*>/gi, (_m, inner: string) => {
		const t = convertInlineInner(inner, slots).trim();
		return t ? stash(`==${t}==`) : "";
	});
	// Task checkboxes
	s = s.replace(/<input\b[^>]*type=["']?checkbox["']?[^>]*>/gi, (tag) => stash(/\bchecked\b/i.test(tag) ? "[x] " : "[ ] "));
	// Remaining tags
	s = s.replace(/<[^>]+>/g, "");
	s = decodeHtmlEntities(s);
	return s;
}

function convertInline(html: string): string {
	const slots: string[] = [];
	let s = convertInlineInner(html, slots);
	for (let pass = 0; pass < 32 && s.includes("\x00INL"); pass++) {
		s = s.replace(/\x00INL(\d+)\x00/g, (_m, idx: string) => slots[Number(idx)] ?? "");
	}
	return s;
}

function convertList(listHtml: string, ordered: boolean, depth = 0): string {
	const indent = "  ".repeat(depth);
	const out: string[] = [];
	let itemIdx = 1;

	const emitItem = (rawItem: string) => {
		const nestedBlocks: string[] = [];
		const strippedItem = replaceBalancedTags(rawItem, ["ul", "ol"], (tag, _attrs, inner) => {
			nestedBlocks.push(convertList(inner, tag === "ol", depth + 1));
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
	};

	// Match top-level <li> elements inside this list by tracking nested <li> depth.
	const liRe = /<(\/?)li(?=[\s>/])[^>]*>/gi;
	let nest = 0;
	let itemStart = -1;
	let m: RegExpExecArray | null;
	while ((m = liRe.exec(listHtml)) !== null) {
		const isClose = m[1] === "/";
		if (!isClose) {
			if (nest === 0) itemStart = m.index + m[0].length;
			nest++;
		} else if (nest > 0) {
			nest--;
			if (nest === 0 && itemStart >= 0) {
				emitItem(listHtml.slice(itemStart, m.index));
				itemStart = -1;
			}
		}
	}
	if (nest > 0 && itemStart >= 0) {
		emitItem(listHtml.slice(itemStart));
	}
	return out.join("\n");
}

let blockSlotSeq = 0;

function htmlToMarkdownInner(html: string): string {
	if (!html) return "";
	let s = html
		.replace(/\r\n?/g, "\n")
		.replace(/<!--StartFragment-->|<!--EndFragment-->/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|head|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, "");

	// Extract full HTML body when present
	const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(s);
	if (bodyMatch) s = bodyMatch[1]!;

	const callId = ++blockSlotSeq;
	const slots: string[] = [];
	const stash = (md: string) => {
		const idx = slots.push(md) - 1;
		return `\n\n\x00B${callId}_${idx}\x00\n\n`;
	};
	const slotRe = new RegExp(`\\x00B${callId}_(\\d+)\\x00`, "g");
	const restore = (text: string) => text.replace(slotRe, (_m, idx: string) => slots[Number(idx)] ?? "");

	// Preformatted code blocks first
	s = s.replace(/<pre\b[^>]*>\s*(?:<code\b([^>]*)>)?([\s\S]*?)(?:<\/code\s*>)?\s*<\/pre\s*>/gi, (_m, codeAttrs: string | undefined, inner: string) => {
		const cls = codeAttrs ? attrOf(`<code ${codeAttrs}>`, "class") : "";
		const langMatch = /\b(?:language|lang)-([a-z0-9_+-]+)\b/i.exec(cls);
		const lang = langMatch?.[1]?.toLowerCase() ?? "";
		const body = stripTags(inner).replace(/^\n+|\n+$/g, "");
		return stash(`\`\`\`${lang}\n${body}\n\`\`\``);
	});

	// Tables
	s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (tbl) => stash(convertTable(tbl).trim()));

	// Details/summary (balanced tag matching so nested <details> preserve outer content)
	s = replaceBalancedTags(s, ["details"], (_tag, _attrs, inner) => {
		const firstNested = /<details(?=[\s>/])/i.exec(inner)?.index ?? inner.length;
		const headSlice = inner.slice(0, firstNested);
		const sumMatch = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(headSlice);
		const summary = sumMatch ? convertInline(sumMatch[1]!).trim() : "Details";
		const withoutSummary = sumMatch ? inner.slice(0, sumMatch.index) + inner.slice(sumMatch.index + sumMatch[0].length) : inner;
		const body = restore(htmlToMarkdownInner(withoutSummary)).trim();
		return stash(`<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`);
	});

	// Blockquotes & Confluence/Jira info/warning panels (balanced tag matching for nested blockquotes)
	s = replaceBalancedTags(s, ["blockquote"], (_tag, _attrs, inner) => {
		const body = restore(htmlToMarkdownInner(inner)).trim();
		if (!body) return "";
		const quoted = body
			.split("\n")
			.map((l) => (l.trim() ? `> ${l}` : ">"))
			.join("\n");
		return stash(quoted);
	});

	// Lists (outermost ul/ol with balanced tag matching so nested lists keep every item)
	s = replaceBalancedTags(s, ["ul", "ol"], (tag, _attrs, inner) => {
		const rendered = restore(convertList(inner, tag === "ol", 0));
		return rendered ? stash(rendered) : "";
	});

	// Headings
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, lvl: string, inner: string) => {
		const title = convertInline(inner).replace(/\s+/g, " ").trim();
		return title ? stash(`${"#".repeat(Number(lvl))} ${title}`) : "";
	});

	// Horizontal rules
	s = s.replace(/<hr\b[^>]*\/?>/gi, () => stash("---"));

	// Paragraphs & block divs
	s = s.replace(/<\/(p|div|section|article|header|footer|aside|main)\s*>/gi, "\n\n");
	s = s.replace(/<(p|div|section|article|header|footer|aside|main)\b[^>]*>/gi, "\n");

	// Convert remaining inline markup
	s = convertInline(s);

	// Restore stashed blocks
	s = restore(s);

	// Normalize blank lines and trailing whitespace
	return s
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Converts HTML (clipboard fragments, Confluence/Azure DevOps exports, or standalone HTML docs)
 * into clean GitHub-Flavored Markdown. Pure, dependency-free, safe on untrusted markup.
 */
export function htmlToMarkdown(html: string): string {
	if (!html) return "";
	return htmlToMarkdownInner(html.replace(/\x00/g, ""));
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
