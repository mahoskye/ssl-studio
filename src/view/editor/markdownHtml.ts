// What is done to Markdown's HTML after it is cleaned, wherever it is shown:
// a document in the reading view, a reply in the Agent panel.
import DOMPurify from "dompurify";
import { csvRow } from "../../shared/csv";
import { MAX_SHORT, headingAnchor } from "../../shared/docTables";
import { frontMatter } from "../../shared/frontMatter";
import { documentHeadings, parseCalloutHeader } from "../../shared/markdownEdit";
import { cellValueForEdit, type MarkdownTable } from "../../shared/markdownTables";
import { namedLinksIn } from "../../shared/namedLinks";
import { dirName, isInside, resolvePath } from "../../shared/paths";
import { isLikelyHexColorTag } from "../../shared/tags";
import { ticketMatcher } from "../../shared/ticketRefs";

type KatexModule = typeof import("katex").default;

let katexMod: KatexModule | null = null;
let katexLoading: Promise<KatexModule> | null = null;
const KATEX_CACHE_MAX = 160;
const katexCache = new Map<string, string>();

/** Lazy-loads KaTeX + its stylesheet on first math expression (matching cmMermaid.ts's on-demand pattern). */
export function loadKatex(): Promise<KatexModule> {
	if (katexMod) return Promise.resolve(katexMod);
	if (!katexLoading) {
		const cssImport =
			// @ts-expect-error Vite bundles the KaTeX CSS dynamically at runtime (no .d.ts shipped for .css).
			import("katex/dist/katex.min.css");
		katexLoading = Promise.all([import("katex"), cssImport])
			.then(([mod]) => {
				katexMod = mod.default ?? (mod as unknown as KatexModule);
				return katexMod;
			})
			.catch((err) => {
				katexLoading = null;
				throw err;
			});
	}
	return katexLoading;
}

/** Returns cached/rendered KaTeX HTML synchronously when KaTeX is already loaded, or null before first load. */
export function renderKatexSync(tex: string, displayMode: boolean): string | null {
	const key = `${displayMode ? "D" : "I"}\0${tex}`;
	const hit = katexCache.get(key);
	if (hit !== undefined) {
		katexCache.delete(key);
		katexCache.set(key, hit);
		return hit;
	}
	if (!katexMod) return null;
	try {
		const html = katexMod.renderToString(tex, {
			displayMode,
			throwOnError: false,
			strict: false,
			trust: false,
		});
		if (katexCache.size >= KATEX_CACHE_MAX) {
			const oldest = katexCache.keys().next().value;
			if (oldest !== undefined) katexCache.delete(oldest);
		}
		katexCache.set(key, html);
		return html;
	} catch {
		return null;
	}
}

/** Asynchronously loads KaTeX on demand and renders a LaTeX expression to HTML. */
export async function renderKatexHtml(tex: string, displayMode: boolean): Promise<string | null> {
	const cached = renderKatexSync(tex, displayMode);
	if (cached !== null) return cached;
	try {
		await loadKatex();
		return renderKatexSync(tex, displayMode);
	} catch {
		return null;
	}
}

export type InlineMathSpan = { from: number; to: number; tex: string; display: boolean };

/**
 * Finds inline `$...$` (and single-line `$$...$$`) math spans on one line of prose while
 * strictly skipping currency like `$100` or `$100 and $200` (requires non-space immediately
 * inside delimiters and no digit immediately after closing `$`).
 */
export function findInlineMathSpans(text: string): InlineMathSpan[] {
	if (!text.includes("$")) return [];
	const spans: InlineMathSpan[] = [];
	const escaped = (idx: number) => {
		let bs = 0;
		for (let k = idx - 1; k >= 0 && text[k] === "\\"; k--) bs++;
		return bs % 2 === 1;
	};
	let i = 0;
	while (i < text.length) {
		if (text[i] !== "$" || escaped(i)) {
			i++;
			continue;
		}
		// Inline display math `$$...$$` on a single line
		if (text[i + 1] === "$") {
			let j = i + 2;
			let close = -1;
			while (j < text.length - 1) {
				if (text[j] === "$" && text[j + 1] === "$" && !escaped(j)) {
					close = j;
					break;
				}
				j++;
			}
			if (close > i + 2) {
				const tex = text.slice(i + 2, close).trim();
				if (tex) {
					spans.push({ from: i, to: close + 2, tex, display: true });
					i = close + 2;
					continue;
				}
			}
			i += 2;
			continue;
		}
		// Single `$`: reject if preceded by a digit or followed immediately by whitespace.
		const prev = i > 0 ? text[i - 1]! : "";
		const next = text[i + 1];
		if ((prev && /\d/.test(prev)) || !next || /\s/.test(next) || next === "$") {
			i++;
			continue;
		}
		// Search for matching closing `$` on this line.
		let j = i + 1;
		let close = -1;
		while (j < text.length) {
			if (text[j] === "$" && !escaped(j)) {
				if (text[j + 1] === "$") {
					// Double dollar inside cannot close a single `$`
					break;
				}
				const beforeClose = text[j - 1]!;
				const afterClose = text[j + 1];
				// Require non-whitespace right before closing `$` AND no digit right after closing `$`.
				if (!/\s/.test(beforeClose) && (!afterClose || !/\d/.test(afterClose))) {
					close = j;
					break;
				}
				// Currency-like `$100 and $200` has space before or digit after — abandon this opening `$`.
				break;
			}
			j++;
		}
		if (close > i + 1) {
			const tex = text.slice(i + 1, close);
			if (tex.trim()) {
				spans.push({ from: i, to: close + 1, tex, display: false });
				i = close + 1;
				continue;
			}
		}
		i++;
	}
	return spans;
}

/** A ticket of the project, as a document's page links to it: where it is from that document, and what it is in a line. */
export type TicketRef = { key: string; href: string; about: string };

/**
 * A ticket's key written in the prose becomes a link to that ticket, with
 * what the ticket is in its tooltip. Text that is already a link, and code,
 * are left as written.
 */
/** Where a ticket's key is left as written: what is a link already, code, and elements that hold text and no markup. */
const UNLINKED = "a, code, pre, textarea, option, select, button, script, style";
/** Math containers whose text nodes must never be rewritten by highlight or tag scanners. */
const MATH_EXCLUDED = ".md-math, .katex, math, annotation";

function linkTickets(holder: HTMLTemplateElement, tickets: readonly TicketRef[]) {
	const by = new Map(tickets.map((ticket) => [ticket.key, ticket]));
	const mentionsIn = ticketMatcher([...by.keys()]);
	const walker = document.createTreeWalker(holder.content, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement?.closest(UNLINKED)) nodes.push(node as Text);
	for (const node of nodes) {
		const text = node.data;
		const mentions = mentionsIn(text);
		if (!mentions.length) continue;
		const parts = document.createDocumentFragment();
		let at = 0;
		for (const mention of mentions) {
			const ticket = by.get(mention.key)!;
			parts.append(text.slice(at, mention.from));
			const link = document.createElement("a");
			link.className = "ticket-ref";
			link.setAttribute("href", ticket.href);
			link.title = ticket.about;
			link.textContent = text.slice(mention.from, mention.to);
			parts.append(link);
			at = mention.to;
		}
		parts.append(text.slice(at));
		node.replaceWith(parts);
	}
}

/** Where a link by name leads from the document being shown, and what the document it names is in a line. Null when no document answers to the name. */
export type NameResolver = (name: string) => { href: string; about: string } | null;

/**
 * A link by name written in the prose ([[name]], [[name|words]]) becomes a
 * link to the document the name means, showing the words or the name. One
 * that names no document stays as written, marked, with why in its tooltip.
 * Done before a ticket's key is linked, so that a key between the brackets is
 * one link and not a link inside brackets.
 */
function linkNames(holder: HTMLTemplateElement, resolve: NameResolver) {
	const walker = document.createTreeWalker(holder.content, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue?.includes("[[") && !node.parentElement?.closest(UNLINKED)) nodes.push(node as Text);
	for (const node of nodes) {
		const text = node.data;
		const found = namedLinksIn(text);
		if (!found.length) continue;
		const parts = document.createDocumentFragment();
		let at = 0;
		for (const { from, to, link } of found) {
			parts.append(text.slice(at, from));
			const leads = resolve(link.name);
			if (leads) {
				const anchor = document.createElement("a");
				anchor.className = "named-ref";
				anchor.setAttribute("href", link.heading ? `${leads.href}#${headingAnchor(link.heading)}` : leads.href);
				anchor.title = leads.about;
				anchor.textContent = link.words ?? (link.heading ? `${link.name} › ${link.heading}` : link.name);
				parts.append(anchor);
			} else {
				const missing = document.createElement("span");
				missing.className = "named-missing";
				missing.title = `No document of the project is called “${link.name}”.`;
				missing.textContent = text.slice(from, to);
				parts.append(missing);
			}
			at = to;
		}
		parts.append(text.slice(at));
		node.replaceWith(parts);
	}
}

/** Gives each heading the anchor a link in the same document can point at. */
function anchorHeadings(holder: HTMLTemplateElement) {
	const used = new Map<string, number>();
	for (const heading of holder.content.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
		const anchor = headingAnchor(heading.textContent ?? "");
		if (!anchor) continue;
		const count = used.get(anchor) ?? 0;
		used.set(anchor, count + 1);
		heading.id = count ? `${anchor}-${count}` : anchor;
	}
}

/**
 * Marks the columns that hold only short values, so they are never wrapped: a
 * date or an id stays whole, and the column of text takes the wrapping (ADR 0008).
 */
function markShortColumns(holder: HTMLTemplateElement) {
	for (const table of holder.content.querySelectorAll("table")) {
		const rows = [...table.querySelectorAll("tr")].map((row) => [...row.children] as HTMLElement[]);
		const body = rows.filter((cells) => cells[0]?.tagName === "TD");
		for (let i = 0; i < (rows[0]?.length ?? 0); i++) {
			const short = body.every((cells) => (cells[i]?.textContent ?? "").trim().length <= MAX_SHORT);
			if (short) for (const cells of rows) cells[i]?.classList.add("short");
		}
	}
}

/** Turns Obsidian `==highlight==` markers in prose into `<mark class="md-highlight">`. */
function renderHighlights(holder: HTMLTemplateElement) {
	const walker = document.createTreeWalker(holder.content, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	const excluded = `code, pre, textarea, option, select, script, style, ${MATH_EXCLUDED}`;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeValue?.includes("==") && !node.parentElement?.closest(excluded)) nodes.push(node as Text);
	}
	for (const node of nodes) {
		const text = node.data;
		const matches = [...text.matchAll(/==([^\n=](?:[^\n]*?[^\n=])?)==/g)];
		if (!matches.length) continue;
		const parts = document.createDocumentFragment();
		let at = 0;
		for (const m of matches) {
			parts.append(text.slice(at, m.index));
			const mark = document.createElement("mark");
			mark.className = "md-highlight";
			mark.textContent = m[1]!;
			parts.append(mark);
			at = m.index + m[0].length;
		}
		parts.append(text.slice(at));
		node.replaceWith(parts);
	}
}

/** Turns `#tag` mentions in prose (outside code, links, headings, and math) into clickable `.md-tag` pills. */
function renderTags(holder: HTMLTemplateElement) {
	const walker = document.createTreeWalker(holder.content, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	const excluded = `${UNLINKED}, h1, h2, h3, h4, h5, h6, ${MATH_EXCLUDED}`;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeValue?.includes("#") && !node.parentElement?.closest(excluded)) nodes.push(node as Text);
	}
	for (const node of nodes) {
		const text = node.data;
		const matches = [...text.matchAll(/(^|[\s(])(#[A-Za-z][A-Za-z0-9_/-]*)/g)].filter((m) => !isLikelyHexColorTag(m[2]!.slice(1)));
		if (!matches.length) continue;
		const parts = document.createDocumentFragment();
		let at = 0;
		for (const m of matches) {
			const leadLen = m[1]!.length;
			const tagStart = m.index + leadLen;
			const tag = m[2]!;
			parts.append(text.slice(at, tagStart));
			const pill = document.createElement("span");
			pill.className = "md-tag";
			pill.dataset.tag = tag;
			pill.title = `Search workspace for ${tag}`;
			pill.textContent = tag;
			parts.append(pill);
			at = tagStart + tag.length;
		}
		parts.append(text.slice(at));
		node.replaceWith(parts);
	}
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CALLOUT_MARKER_PREFIX_RE = /^[ \t]*\[!([A-Za-z0-9_-]+)\]([+-])?(?:[ \t]+|$)/;
const VOID_HTML_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

function escHtmlText(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeBasicEntities(s: string): string {
	return s
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&apos;/gi, "'")
		.replace(/&amp;/gi, "&");
}

function canUseRealDom(): boolean {
	if (typeof document === "undefined" || typeof document.createElement !== "function" || typeof document.createTextNode !== "function") {
		return false;
	}
	const t = document.createElement("template") as HTMLTemplateElement | undefined;
	return Boolean(t && t.content && typeof t.content.querySelectorAll === "function");
}

/**
 * DOM-based callout transformer operating strictly on parsed `<blockquote>` elements
 * deepest-first. Never regex-slices serialized HTML strings, so attribute payloads like
 * `title="<br><img ...>"` or `title="</p><svg ...>"` cannot break out of attributes.
 */
export function transformCalloutsDom(root: ParentNode): void {
	const blockquotes = [...root.querySelectorAll("blockquote")].reverse();
	for (const bq of blockquotes) {
		if (!bq.parentNode) continue;
		if (bq.closest("pre, code")) continue;

		// Locate the first non-whitespace child; it must be a `<p>` element.
		let firstP: Element | null = null;
		for (let n = bq.firstChild; n; n = n.nextSibling) {
			if (n.nodeType === TEXT_NODE && !(n.textContent ?? "").trim()) continue;
			if (n.nodeType === ELEMENT_NODE && (n as Element).tagName.toUpperCase() === "P") {
				firstP = n as Element;
			}
			break;
		}
		if (!firstP) continue;

		// Non-destructively scan direct children of `firstP` up to the first `<br>` element
		// or `\r?\n` in a direct Text node (never inspecting inside element attributes).
		const pChildren = [...firstP.childNodes];
		let breakIdx = -1;
		let breakTextOffset = -1;
		let breakTextLen = 0;
		let breakWasBr = false;
		let firstLinePlain = "";

		for (let i = 0; i < pChildren.length; i++) {
			const child = pChildren[i]!;
			if (child.nodeType === ELEMENT_NODE && (child as Element).tagName.toUpperCase() === "BR") {
				breakIdx = i;
				breakWasBr = true;
				break;
			}
			if (child.nodeType === TEXT_NODE) {
				const raw = child.textContent ?? "";
				const nl = /\r?\n/.exec(raw);
				if (nl) {
					firstLinePlain += raw.slice(0, nl.index);
					breakIdx = i;
					breakTextOffset = nl.index;
					breakTextLen = nl[0].length;
					break;
				}
				firstLinePlain += raw;
				continue;
			}
			firstLinePlain += child.textContent ?? "";
		}

		const headerEnd = breakIdx < 0 ? pChildren.length : breakTextOffset >= 0 ? breakIdx + 1 : breakIdx;
		let firstTextIdx = -1;
		for (let i = 0; i < headerEnd; i++) {
			const c = pChildren[i]!;
			if (c.nodeType === TEXT_NODE && (c.textContent ?? "").length === 0) continue;
			if (c.nodeType === TEXT_NODE) firstTextIdx = i;
			break;
		}
		if (firstTextIdx < 0) continue;

		const firstRaw = pChildren[firstTextIdx]!.textContent ?? "";
		const firstSeg = firstTextIdx === breakIdx && breakTextOffset >= 0 ? firstRaw.slice(0, breakTextOffset) : firstRaw;
		const markerMatch = CALLOUT_MARKER_PREFIX_RE.exec(firstSeg);
		if (!markerMatch) continue;
		const parsed = parseCalloutHeader(`> ${firstLinePlain}`);
		if (!parsed) continue;

		const doc = bq.ownerDocument ?? document;

		// Build sanitized callout title DOM nodes by stripping only the `[!type][+-]?` prefix
		// from the first Text node and moving the remaining existing sanitized nodes intact.
		const titleNodes: Node[] = [];
		for (let i = firstTextIdx; i < headerEnd; i++) {
			if (i === firstTextIdx) {
				const restOfFirst = firstSeg.slice(markerMatch[0].length);
				if (restOfFirst) titleNodes.push(doc.createTextNode(restOfFirst));
			} else if (i === breakIdx && breakTextOffset >= 0) {
				const beforeNl = (pChildren[i]!.textContent ?? "").slice(0, breakTextOffset);
				if (beforeNl) titleNodes.push(doc.createTextNode(beforeNl));
			} else {
				titleNodes.push(pChildren[i]!);
			}
		}
		while (titleNodes.length > 0 && titleNodes[titleNodes.length - 1]!.nodeType === TEXT_NODE) {
			const last = titleNodes[titleNodes.length - 1]!;
			const trimmed = (last.textContent ?? "").replace(/[ \t]+$/, "");
			if (trimmed) {
				last.textContent = trimmed;
				break;
			}
			titleNodes.pop();
		}
		const hasCustomTitle = titleNodes.some(
			(n) =>
				(n.textContent ?? "").trim().length > 0 ||
				(n.nodeType === ELEMENT_NODE &&
					((n as Element).tagName.toUpperCase() === "IMG" || Boolean((n as Element).querySelector?.("img")))),
		);

		// Collect body nodes following the header break inside `firstP`.
		const afterBreakNodes: Node[] = [];
		if (breakIdx >= 0) {
			if (breakTextOffset >= 0) {
				const tail = (pChildren[breakIdx]!.textContent ?? "").slice(breakTextOffset + breakTextLen);
				if (tail) afterBreakNodes.push(doc.createTextNode(tail));
			}
			for (let i = breakIdx + 1; i < pChildren.length; i++) {
				afterBreakNodes.push(pChildren[i]!);
			}
			if (breakWasBr && afterBreakNodes.length > 0 && afterBreakNodes[0]!.nodeType === TEXT_NODE) {
				const cleaned = (afterBreakNodes[0]!.textContent ?? "").replace(/^\r?\n/, "");
				if (cleaned) afterBreakNodes[0]!.textContent = cleaned;
				else afterBreakNodes.shift();
			}
		}
		const hasAfterBody = afterBreakNodes.some(
			(n) => n.nodeType === ELEMENT_NODE || (n.textContent ?? "").trim().length > 0,
		);

		// Collect remaining sibling nodes inside `bq` after `firstP` (any nested blockquotes are already transformed).
		const restNodes: Node[] = [];
		for (let n = firstP.nextSibling; n; n = n.nextSibling) restNodes.push(n);
		while (restNodes.length > 0 && restNodes[0]!.nodeType === TEXT_NODE && !(restNodes[0]!.textContent ?? "").trim()) {
			restNodes.shift();
		}
		while (
			restNodes.length > 0 &&
			restNodes[restNodes.length - 1]!.nodeType === TEXT_NODE &&
			!(restNodes[restNodes.length - 1]!.textContent ?? "").trim()
		) {
			restNodes.pop();
		}
		const hasRestBody = restNodes.some(
			(n) => n.nodeType === ELEMENT_NODE || (n.textContent ?? "").trim().length > 0,
		);

		const isFoldable = parsed.fold === "+" || parsed.fold === "-";
		const container = doc.createElement(isFoldable ? "details" : "div");
		container.className = isFoldable
			? `md-callout tone-${parsed.spec.tone} is-foldable`
			: `md-callout tone-${parsed.spec.tone}`;
		if (parsed.fold === "+") container.setAttribute("open", "");

		const head = doc.createElement(isFoldable ? "summary" : "div");
		head.className = "md-callout-head";

		const iconEl = doc.createElement("span");
		iconEl.className = "md-callout-icon";
		iconEl.setAttribute("aria-hidden", "true");
		iconEl.textContent = parsed.spec.icon;

		const titleEl = doc.createElement("span");
		titleEl.className = "md-callout-title";
		if (hasCustomTitle) {
			for (const n of titleNodes) titleEl.appendChild(n);
		} else {
			titleEl.textContent = parsed.spec.label;
		}

		head.appendChild(iconEl);
		head.appendChild(titleEl);
		container.appendChild(head);

		if (hasAfterBody || hasRestBody) {
			const bodyEl = doc.createElement("div");
			bodyEl.className = "md-callout-body";
			if (hasAfterBody) {
				const bodyP = doc.createElement("p");
				for (const n of afterBreakNodes) bodyP.appendChild(n);
				bodyEl.appendChild(bodyP);
			}
			if (hasRestBody) {
				for (const n of restNodes) bodyEl.appendChild(n);
			}
			container.appendChild(bodyEl);
		}

		bq.parentNode.replaceChild(container, bq);
	}
}

type HtmlToken =
	| { type: "start"; tag: string; raw: string; selfClosing: boolean }
	| { type: "end"; tag: string; raw: string }
	| { type: "comment"; raw: string }
	| { type: "other"; raw: string }
	| { type: "text"; raw: string };

/**
 * Quote-aware HTML5-style tokenizer used solely for the non-DOM / SSR fallback of
 * `renderCalloutsHtml`. Tags inside attribute values (`title="<br><img ...>"`) and
 * HTML comments are opaque and never tokenized as markup.
 */
function tokenizeHtml(html: string): HtmlToken[] {
	const tokens: HtmlToken[] = [];
	const pushText = (chunk: string) => {
		if (!chunk) return;
		const prev = tokens[tokens.length - 1];
		if (prev && prev.type === "text") prev.raw += chunk;
		else tokens.push({ type: "text", raw: chunk });
	};

	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt < 0) {
			pushText(html.slice(i));
			break;
		}
		if (lt > i) {
			pushText(html.slice(i, lt));
			i = lt;
		}

		// HTML comment: `<!-- ... -->`
		if (html.startsWith("<!--", i)) {
			const end = html.indexOf("-->", i + 4);
			const next = end < 0 ? html.length : end + 3;
			tokens.push({ type: "comment", raw: html.slice(i, next) });
			i = next;
			continue;
		}

		// Declaration / doctype / processing instruction: `<!...>` or `<?...>`
		const nextCh = html[i + 1];
		if (nextCh === "!" || nextCh === "?") {
			const gt = html.indexOf(">", i + 2);
			const next = gt < 0 ? html.length : gt + 1;
			tokens.push({ type: "other", raw: html.slice(i, next) });
			i = next;
			continue;
		}

		// End tag: `</tagName ...>`
		if (nextCh === "/" && i + 2 < html.length && /[A-Za-z]/.test(html[i + 2]!)) {
			let nameEnd = i + 3;
			while (nameEnd < html.length && /[A-Za-z0-9:-]/.test(html[nameEnd]!)) nameEnd++;
			const gt = html.indexOf(">", nameEnd);
			if (gt >= 0) {
				tokens.push({ type: "end", tag: html.slice(i + 2, nameEnd).toLowerCase(), raw: html.slice(i, gt + 1) });
				i = gt + 1;
				continue;
			}
			pushText(html.slice(i));
			break;
		}

		// Start tag: `<tagName ...attributes... [/]>`
		if (nextCh && /[A-Za-z]/.test(nextCh)) {
			let nameEnd = i + 2;
			while (nameEnd < html.length && /[A-Za-z0-9:-]/.test(html[nameEnd]!)) nameEnd++;
			if (nameEnd < html.length && /[\t\n\f\r />]/.test(html[nameEnd]!)) {
				let j = nameEnd;
				let closedAt = -1;
				while (j < html.length) {
					while (j < html.length && /[\t\n\f\r ]/.test(html[j]!)) j++;
					if (j >= html.length) break;
					if (html[j] === ">") {
						closedAt = j;
						break;
					}
					if (html[j] === "/" && html[j + 1] === ">") {
						closedAt = j + 1;
						break;
					}
					while (j < html.length && !/[\t\n\f\r =/>]/.test(html[j]!)) j++;
					while (j < html.length && /[\t\n\f\r ]/.test(html[j]!)) j++;
					if (html[j] === "=") {
						j++;
						while (j < html.length && /[\t\n\f\r ]/.test(html[j]!)) j++;
						if (html[j] === '"' || html[j] === "'") {
							const q = html[j]!;
							j++;
							const endQ = html.indexOf(q, j);
							if (endQ < 0) {
								j = html.length;
								break;
							}
							j = endQ + 1;
						} else {
							while (j < html.length && !/[\t\n\f\r >]/.test(html[j]!)) j++;
						}
					} else if (html[j] === "/") {
						j++;
					}
				}
				if (closedAt >= 0) {
					const tag = html.slice(i + 1, nameEnd).toLowerCase();
					const raw = html.slice(i, closedAt + 1);
					const selfClosing = VOID_HTML_TAGS.has(tag) || /\/\s*>$/.test(raw);
					tokens.push({ type: "start", tag, raw, selfClosing });
					i = closedAt + 1;
					if (!selfClosing && (tag === "script" || tag === "style")) {
						const closeRe = new RegExp(`</${tag}(?=[\\t\\n\\f\\r >])[^>]*>`, "i");
						const closeMatch = closeRe.exec(html.slice(i));
						if (closeMatch) {
							if (closeMatch.index > 0) {
								tokens.push({ type: "other", raw: html.slice(i, i + closeMatch.index) });
							}
							tokens.push({ type: "end", tag, raw: closeMatch[0] });
							i += closeMatch.index + closeMatch[0].length;
						} else {
							tokens.push({ type: "other", raw: html.slice(i) });
							i = html.length;
						}
					}
					continue;
				}
			}
		}

		pushText("<");
		i++;
	}

	return tokens;
}

function transformCalloutTokens(tokens: HtmlToken[]): string {
	let out = "";
	let skipTag: "pre" | "code" | null = null;
	let skipDepth = 0;
	let bqDepth = 0;
	let bqOpenRaw = "";
	let bqInner: HtmlToken[] = [];

	for (const tok of tokens) {
		if (bqDepth === 0) {
			if (skipTag) {
				if (tok.type === "start" && !tok.selfClosing && tok.tag === skipTag) skipDepth++;
				else if (tok.type === "end" && tok.tag === skipTag) {
					skipDepth--;
					if (skipDepth <= 0) {
						skipTag = null;
						skipDepth = 0;
					}
				}
				out += tok.raw;
				continue;
			}
			if (tok.type === "start" && !tok.selfClosing && (tok.tag === "pre" || tok.tag === "code")) {
				skipTag = tok.tag;
				skipDepth = 1;
				out += tok.raw;
				continue;
			}
			if (tok.type === "start" && !tok.selfClosing && tok.tag === "blockquote") {
				bqDepth = 1;
				bqOpenRaw = tok.raw;
				bqInner = [];
				continue;
			}
			out += tok.raw;
			continue;
		}

		// Inside a top-level blockquote: track balanced nested blockquotes (ignoring tags inside pre/code).
		if (skipTag) {
			if (tok.type === "start" && !tok.selfClosing && tok.tag === skipTag) skipDepth++;
			else if (tok.type === "end" && tok.tag === skipTag) {
				skipDepth--;
				if (skipDepth <= 0) {
					skipTag = null;
					skipDepth = 0;
				}
			}
			bqInner.push(tok);
			continue;
		}
		if (tok.type === "start" && !tok.selfClosing && (tok.tag === "pre" || tok.tag === "code")) {
			skipTag = tok.tag;
			skipDepth = 1;
			bqInner.push(tok);
			continue;
		}
		if (tok.type === "start" && !tok.selfClosing && tok.tag === "blockquote") {
			bqDepth++;
			bqInner.push(tok);
			continue;
		}
		if (tok.type === "end" && tok.tag === "blockquote") {
			bqDepth--;
			if (bqDepth === 0) {
				out += transformSingleBlockquoteTokens(bqInner, bqOpenRaw, tok.raw);
				bqOpenRaw = "";
				bqInner = [];
			} else {
				bqInner.push(tok);
			}
			continue;
		}
		bqInner.push(tok);
	}

	if (bqDepth > 0) {
		out += bqOpenRaw;
		for (const tok of bqInner) out += tok.raw;
	}
	return out;
}

function transformSingleBlockquoteTokens(innerTokens: HtmlToken[], openRaw: string, closeRaw: string): string {
	const fallback = () => `${openRaw}${transformCalloutTokens(innerTokens)}${closeRaw}`;

	// First non-whitespace token inside the blockquote must be `<p>`.
	let idx = 0;
	while (idx < innerTokens.length && innerTokens[idx]!.type === "text" && !innerTokens[idx]!.raw.trim()) idx++;
	const firstTok = innerTokens[idx];
	if (!firstTok || firstTok.type !== "start" || firstTok.selfClosing || firstTok.tag !== "p") return fallback();

	// Find the matching `</p>` token.
	let pDepth = 1;
	let pEndIdx = -1;
	for (let k = idx + 1; k < innerTokens.length; k++) {
		const t = innerTokens[k]!;
		if (t.type === "start" && !t.selfClosing && t.tag === "p") pDepth++;
		else if (t.type === "end" && t.tag === "p") {
			pDepth--;
			if (pDepth === 0) {
				pEndIdx = k;
				break;
			}
		}
	}
	if (pEndIdx < 0) return fallback();

	const pTokens = innerTokens.slice(idx + 1, pEndIdx);
	const restTokens = innerTokens.slice(pEndIdx + 1);

	// Split direct content of `<p>` at the earliest `<br>` or `\r?\n` at inline depth 0.
	const headerTokens: HtmlToken[] = [];
	const afterBreakTokens: HtmlToken[] = [];
	let inlineDepth = 0;
	let breakWasBr = false;
	for (let k = 0; k < pTokens.length; k++) {
		const t = pTokens[k]!;
		if (t.type === "start") {
			if (inlineDepth === 0 && t.tag === "br") {
				breakWasBr = true;
				for (let m = k + 1; m < pTokens.length; m++) afterBreakTokens.push(pTokens[m]!);
				break;
			}
			if (!t.selfClosing) inlineDepth++;
			headerTokens.push(t);
		} else if (t.type === "end") {
			if (inlineDepth > 0) inlineDepth--;
			headerTokens.push(t);
		} else if (t.type === "text" && inlineDepth === 0) {
			const nl = /\r?\n/.exec(t.raw);
			if (nl) {
				const before = t.raw.slice(0, nl.index);
				const after = t.raw.slice(nl.index + nl[0].length);
				if (before) headerTokens.push({ type: "text", raw: before });
				if (after) afterBreakTokens.push({ type: "text", raw: after });
				for (let m = k + 1; m < pTokens.length; m++) afterBreakTokens.push(pTokens[m]!);
				break;
			}
			headerTokens.push(t);
		} else {
			headerTokens.push(t);
		}
	}
	if (inlineDepth !== 0) return fallback();

	const firstHeader = headerTokens[0];
	if (!firstHeader || firstHeader.type !== "text") return fallback();
	const markerMatch = CALLOUT_MARKER_PREFIX_RE.exec(firstHeader.raw);
	if (!markerMatch) return fallback();

	const firstLinePlain = headerTokens
		.filter((t): t is { type: "text"; raw: string } => t.type === "text")
		.map((t) => decodeBasicEntities(t.raw))
		.join("");
	const parsed = parseCalloutHeader(`> ${firstLinePlain}`);
	if (!parsed) return fallback();

	const titleTokens: HtmlToken[] = [];
	const strippedFirst = firstHeader.raw.slice(markerMatch[0].length);
	if (strippedFirst) titleTokens.push({ type: "text", raw: strippedFirst });
	for (let k = 1; k < headerTokens.length; k++) titleTokens.push(headerTokens[k]!);
	while (titleTokens.length > 0 && titleTokens[titleTokens.length - 1]!.type === "text") {
		const last = titleTokens[titleTokens.length - 1] as { type: "text"; raw: string };
		const trimmed = last.raw.replace(/[ \t]+$/, "");
		if (trimmed) {
			titleTokens[titleTokens.length - 1] = { type: "text", raw: trimmed };
			break;
		}
		titleTokens.pop();
	}
	const hasCustomTitle = titleTokens.some(
		(t) => (t.type === "text" && t.raw.trim().length > 0) || (t.type === "start" && t.tag === "img"),
	);
	const titleHtml = hasCustomTitle ? titleTokens.map((t) => t.raw).join("") : escHtmlText(parsed.spec.label);

	if (breakWasBr && afterBreakTokens[0]?.type === "text") {
		const cleaned = afterBreakTokens[0].raw.replace(/^\r?\n/, "");
		if (cleaned) afterBreakTokens[0] = { type: "text", raw: cleaned };
		else afterBreakTokens.shift();
	}
	const afterHtml = afterBreakTokens.map((t) => t.raw).join("");
	const hasAfterBody = afterBreakTokens.some((t) => t.type === "start" || (t.type === "text" && t.raw.trim().length > 0));
	const restHtml = transformCalloutTokens(restTokens).trim();
	const bodyParts: string[] = [];
	if (hasAfterBody) bodyParts.push(`<p>${afterHtml}</p>`);
	if (restHtml) bodyParts.push(restHtml);
	const bodyHtml = bodyParts.join("\n");

	const tone = escHtmlText(parsed.spec.tone);
	const icon = escHtmlText(parsed.spec.icon);
	const bodyEl = bodyHtml ? `<div class="md-callout-body">${bodyHtml}</div>` : "";

	if (parsed.fold === "+" || parsed.fold === "-") {
		const openAttr = parsed.fold === "+" ? " open" : "";
		return `<details class="md-callout tone-${tone} is-foldable"${openAttr}><summary class="md-callout-head"><span class="md-callout-icon" aria-hidden="true">${icon}</span><span class="md-callout-title">${titleHtml}</span></summary>${bodyEl}</details>`;
	}
	return `<div class="md-callout tone-${tone}"><div class="md-callout-head"><span class="md-callout-icon" aria-hidden="true">${icon}</span><span class="md-callout-title">${titleHtml}</span></div>${bodyEl}</div>`;
}

/**
 * Transforms Obsidian/GitHub callout blockquotes (`> [!NOTE] Title`, foldable `> [!TIP]+` /
 * `> [!TIP]-` -> `<details>`/`<summary>`, and nested `> > [!WARNING]`) into styled `.md-callout`
 * cards while preserving `<pre>` / `<code>` verbatim. Uses real DOM + DOMPurify when available
 * and a quote-aware HTML5 tokenizer otherwise so attribute payloads can never escape.
 */
export function renderCalloutsHtml(html: string): string {
	if (!/<blockquote(?=\s|>|\/)/i.test(html) || !html.includes("[!")) return html;
	if (canUseRealDom()) {
		const safe = DOMPurify.isSupported ? DOMPurify.sanitize(html) : html;
		const holder = document.createElement("template");
		holder.innerHTML = safe;
		transformCalloutsDom(holder.content);
		return holder.innerHTML;
	}
	return transformCalloutTokens(tokenizeHtml(html));
}

/** Renders safe `$...$` and `$$...$$` math spans in prose text nodes (skipping code, links, and currency). */
function renderMath(holder: HTMLTemplateElement) {
	const walker = document.createTreeWalker(holder.content, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	const excluded = `${UNLINKED}, ${MATH_EXCLUDED}`;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeValue?.includes("$") && !node.parentElement?.closest(excluded)) nodes.push(node as Text);
	}
	for (const node of nodes) {
		const text = node.data;
		const spans = findInlineMathSpans(text);
		if (!spans.length) continue;
		const parts = document.createDocumentFragment();
		let at = 0;
		for (const span of spans) {
			parts.append(text.slice(at, span.from));
			const el = document.createElement(span.display ? "div" : "span");
			el.className = span.display ? "md-math md-math-display" : "md-math md-math-inline";
			el.dataset.math = span.tex;
			el.dataset.display = span.display ? "1" : "0";
			const rendered = renderKatexSync(span.tex, span.display);
			if (rendered !== null) {
				el.innerHTML = rendered;
			} else {
				el.textContent = span.tex;
				void loadKatex().catch(() => {});
			}
			parts.append(el);
			at = span.to;
		}
		parts.append(text.slice(at));
		node.replaceWith(parts);
	}
}

/** Hydrates any pending `.md-math[data-math]` elements inside a mounted DOM subtree once KaTeX loads. */
export function hydrateMathInElement(root: HTMLElement): void {
	const nodes = root.querySelectorAll<HTMLElement>(".md-math[data-math]");
	if (!nodes.length) return;
	for (const el of nodes) {
		if (el.querySelector(".katex")) continue;
		const tex = el.dataset.math ?? "";
		if (!tex) continue;
		const display = el.dataset.display === "1";
		const cached = renderKatexSync(tex, display);
		if (cached !== null) {
			el.innerHTML = cached;
		} else {
			void renderKatexHtml(tex, display).then((html) => {
				if (html && el.isConnected) el.innerHTML = html;
			});
		}
	}
}

/** `html` must already be sanitised. Anchors are for a document; a reply has no links into itself. */
export function finishMarkdown(html: string, options: { anchors?: boolean; tickets?: readonly TicketRef[]; named?: NameResolver } = {}): string {
	const names = options.named && html.includes("[[") ? options.named : undefined;
	const hasExtra = html.includes("==") || html.includes("#") || html.includes("[!") || html.includes("$");
	if (!options.anchors && !options.tickets?.length && !names && !html.includes("<table") && !hasExtra) return html;
	const holder = document.createElement("template");
	holder.innerHTML = html;
	if (html.includes("[!")) transformCalloutsDom(holder.content);
	if (options.anchors) anchorHeadings(holder);
	if (names) linkNames(holder, names);
	if (options.tickets?.length) linkTickets(holder, options.tickets);
	if (html.includes("$")) renderMath(holder);
	if (html.includes("==")) renderHighlights(holder);
	if (html.includes("#")) renderTags(holder);
	markShortColumns(holder);
	return holder.innerHTML;
}

export type OutlineEntry = { id: string; text: string; level: 1 | 2 | 3 };

/** The headings of a finished document (its anchors already set), down to the third level: what a list of its sections shows. */
export function outlineOf(html: string): OutlineEntry[] {
	const holder = document.createElement("template");
	holder.innerHTML = html;
	return [...holder.content.querySelectorAll<HTMLElement>("h1, h2, h3")]
		.filter((h) => h.id && (h.textContent ?? "").trim())
		.map((h) => ({ id: h.id, text: (h.textContent ?? "").trim(), level: Number(h.tagName[1]) as 1 | 2 | 3 }));
}

// --- Pure Markdown Anchor, Footnote, Governance & Metadata Helpers -----------

/** Maps 1-based heading line numbers to deduplicated anchors (`heading`, `heading-1`, `heading-2`) matching `documentHeadings` & `anchorHeadings`. */
export function deduplicatedHeadingAnchorsByLine(markdown: string): Map<number, string> {
	const out = new Map<number, string>();
	for (const h of documentHeadings(markdown)) {
		out.set(h.line, h.anchor);
	}
	return out;
}

/** Builds a clean Obsidian wikilink targeting a document heading (`[[Doc#Heading]]` or `[[#Heading]]`). */
export function buildHeadingWikiLink(docName: string, headingText: string): string {
	const cleanDoc = docName.trim();
	const cleanHead = headingText.trim();
	return cleanDoc ? `[[${cleanDoc}#${cleanHead}]]` : `[[#${cleanHead}]]`;
}

/** Extracts the full Markdown definition text & 1-based line number of `[^id]: ...`, skipping frontmatter and code fences. */
export function extractFootnoteDefinition(markdown: string, id: string): { text: string; line: number } | null {
	const cleanId = id.trim();
	if (!cleanId || !markdown.includes("[^")) return null;
	const escaped = cleanId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const defRe = new RegExp(`^[ \\t]{0,3}\\[\\^${escaped}\\]:[ \\t]*(.*)$`);
	const fm = frontMatter(markdown);
	const lines = markdown.split(/\r?\n/);
	let openFence: { ch: string; len: number } | null = null;
	for (let i = fm.lines; i < lines.length; i++) {
		const raw = lines[i]!;
		const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
		if (fenceMatch) {
			const ch = fenceMatch[1]![0]!;
			const len = fenceMatch[1]!.length;
			const info = fenceMatch[2]!;
			if (!openFence) {
				if (ch !== "`" || !info.includes("`")) {
					openFence = { ch, len };
					continue;
				}
			} else if (ch === openFence.ch && len >= openFence.len && info.trim() === "") {
				openFence = null;
				continue;
			}
		}
		if (openFence) continue;
		const m = defRe.exec(raw);
		if (!m) continue;
		const bodyLines: string[] = [m[1]!.trim()];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j]!;
			if (/^(?: {2,}|\t)/.test(next)) {
				bodyLines.push(next.replace(/^(?: {2,4}|\t)/, ""));
			} else if (!next.trim() && j + 1 < lines.length && /^(?: {2,}|\t)\S/.test(lines[j + 1]!)) {
				bodyLines.push("");
			} else {
				break;
			}
		}
		const text = bodyLines.join("\n").trim();
		return { text, line: i + 1 };
	}
	return null;
}

/** Frontmatter keys treated as ISO `YYYY-MM-DD` date values in the Properties bar. */
export const DATE_PROPERTY_KEYS: ReadonlySet<string> = new Set([
	"created",
	"updated",
	"due",
	"asked",
	"answered",
	"date",
	"approved-date",
	"effective-date",
	"review-due",
]);

/** Curated controlled-document governance property keys (ISO-17025 / GxP). */
export const GOVERNANCE_PROPERTY_KEYS = [
	"version",
	"owner",
	"reviewer",
	"approved-by",
	"approved-date",
	"effective-date",
	"review-due",
	"change-control",
	"gxp-impact",
] as const;

const TICKET_REF_PROP_KEYS = new Set(["ticket", "tickets", "parent", "related", "blocks", "blocked-by"]);
const FILE_REF_PROP_KEYS = new Set(["specs", "spec", "plans", "plan"]);

/** Strict ISO-8601 calendar date validation (`YYYY-MM-DD`, rejecting impossible dates like `2026-02-30`). */
export function isValidIsoDate(raw: string): boolean {
	const trimmed = raw.trim();
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
	if (!m) return false;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;
	const d = new Date(Date.UTC(year, month - 1, day));
	return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day;
}

/** Increments a controlled document version (`1.0` -> `1.1` minor, `2.0` major; supports `v` prefix and 3-part semver). */
export function bumpSemanticVersion(raw: string | undefined, kind: "minor" | "major" = "minor"): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return kind === "major" ? "2.0" : "1.0";
	const m = /^(v?)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i.exec(trimmed);
	if (!m) return kind === "major" ? "2.0" : "1.0";
	const prefix = m[1] ?? "";
	const major = Number(m[2]);
	const minor = m[3] !== undefined ? Number(m[3]) : 0;
	const hasPatch = m[4] !== undefined;
	if (kind === "major") {
		return hasPatch ? `${prefix}${major + 1}.0.0` : `${prefix}${major + 1}.0`;
	}
	return hasPatch ? `${prefix}${major}.${minor + 1}.0` : `${prefix}${major}.${minor + 1}`;
}

export type PropertyValidationIssue = {
	kind: "unknown-ticket" | "missing-file" | "invalid-date";
	label: string;
	message: string;
};

/**
 * Validates a single frontmatter property value for quiet inline warning pills:
 * - Unknown ticket keys on `ticket` / `tickets` / `parent` / `related` / `blocks` / `blocked-by`
 * - Missing workspace files on `specs` / `spec` / `plans` / `plan`
 * - Malformed calendar dates on ISO date keys (`DATE_PROPERTY_KEYS`)
 */
export function validateFrontmatterProperty(
	key: string,
	value: string,
	ctx: {
		knownTickets: ReadonlySet<string>;
		existingFiles: ReadonlySet<string>;
		workspaceRoot?: string;
		docPath?: string;
	},
): PropertyValidationIssue | null {
	const k = key.trim().toLowerCase();
	const val = value.trim();
	if (!val) return null;

	if (DATE_PROPERTY_KEYS.has(k)) {
		if (!isValidIsoDate(val)) {
			return {
				kind: "invalid-date",
				label: "Invalid date",
				message: `Expected an ISO date (YYYY-MM-DD) for "${key}", got "${val}".`,
			};
		}
		return null;
	}

	if (TICKET_REF_PROP_KEYS.has(k)) {
		if (/^https?:\/\//i.test(val) || /^\[\[.*\]\]$/.test(val)) return null;
		if (!ctx.workspaceRoot && ctx.knownTickets.size === 0) return null;
		if (!ctx.knownTickets.has(val.toLowerCase())) {
			return {
				kind: "unknown-ticket",
				label: "Unknown ticket",
				message: `Ticket "${val}" does not match any ticket in this workspace.`,
			};
		}
		return null;
	}

	if (FILE_REF_PROP_KEYS.has(k)) {
		if (/^https?:\/\//i.test(val) || /^\[\[.*\]\]$/.test(val)) return null;
		if (!ctx.workspaceRoot) return null;
		const clean = val.replace(/\\/g, "/");
		const resolved =
			clean.startsWith("./") || clean.startsWith("../")
				? resolvePath(dirName(ctx.docPath || ctx.workspaceRoot), clean)
				: resolvePath(ctx.workspaceRoot, clean.replace(/^\/+/, ""));
		const normResolved = resolved.replace(/\\/g, "/").toLowerCase();
		if (!isInside(ctx.workspaceRoot, resolved) || !ctx.existingFiles.has(normResolved)) {
			return {
				kind: "missing-file",
				label: "Missing file",
				message: `Workspace file "${val}" was not found.`,
			};
		}
		return null;
	}

	return null;
}

// --- Pure Sublime Text Line-Editing Helpers (shared with cmKeymap.ts) --------

export type PureLineEdit = {
	changeFrom: number;
	changeTo: number;
	insert: string;
	selFrom: number;
	selTo: number;
};

/**
 * Sublime Text `Ctrl+Shift+D`:
 * - Non-empty selection: duplicates the selected text immediately after it and selects the new copy.
 * - Collapsed cursor: duplicates the current line directly below, preserving column offset.
 */
export function computeDuplicateLineOrSelection(doc: string, from: number, to: number): PureLineEdit {
	const a = Math.max(0, Math.min(from, to, doc.length));
	const b = Math.max(a, Math.min(Math.max(from, to), doc.length));
	if (b > a) {
		const selected = doc.slice(a, b);
		return { changeFrom: b, changeTo: b, insert: selected, selFrom: b, selTo: b + selected.length };
	}
	const lineStart = a === 0 ? 0 : doc.lastIndexOf("\n", a - 1) + 1;
	const lineEndRaw = doc.indexOf("\n", a);
	const lineEnd = lineEndRaw < 0 ? doc.length : lineEndRaw;
	const lineText = doc.slice(lineStart, lineEnd);
	const col = a - lineStart;
	const insert = `\n${lineText}`;
	const nextCursor = lineEnd + 1 + col;
	return { changeFrom: lineEnd, changeTo: lineEnd, insert, selFrom: nextCursor, selTo: nextCursor };
}

/**
 * Sublime Text `Ctrl+J`:
 * - Single line (collapsed or single-line selection): joins the current line with the next line using a single space.
 * - Multi-line selection: joins all spanned lines cleanly with single spaces.
 */
export function computeJoinLines(doc: string, from: number, to: number): PureLineEdit | null {
	const a = Math.max(0, Math.min(from, to, doc.length));
	const b = Math.max(a, Math.min(Math.max(from, to), doc.length));
	const startLineStart = a === 0 ? 0 : doc.lastIndexOf("\n", a - 1) + 1;
	const effectiveTo = b > a && doc[b - 1] === "\n" ? b - 1 : b;
	const spansMultipleLines = effectiveTo > a && doc.slice(a, effectiveTo).includes("\n");

	if (!spansMultipleLines) {
		const line1End = doc.indexOf("\n", startLineStart);
		if (line1End < 0) return null;
		const line2EndRaw = doc.indexOf("\n", line1End + 1);
		const line2End = line2EndRaw < 0 ? doc.length : line2EndRaw;
		const first = doc.slice(startLineStart, line1End).replace(/[ \t]+$/, "");
		const second = doc.slice(line1End + 1, line2End).replace(/^[ \t]+/, "");
		const sep = first.length > 0 && second.length > 0 ? " " : "";
		const joined = `${first}${sep}${second}`;
		const cursor = startLineStart + first.length + sep.length;
		return { changeFrom: startLineStart, changeTo: line2End, insert: joined, selFrom: cursor, selTo: cursor };
	}

	const lastLineEndRaw = doc.indexOf("\n", effectiveTo);
	const lastLineEnd = lastLineEndRaw < 0 ? doc.length : lastLineEndRaw;
	const parts = doc.slice(startLineStart, lastLineEnd).split("\n");
	let acc = parts[0]!.replace(/[ \t]+$/, "");
	for (let i = 1; i < parts.length; i++) {
		const isLast = i === parts.length - 1;
		const next = isLast ? parts[i]!.replace(/^[ \t]+/, "") : parts[i]!.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
		if (!next) continue;
		acc = acc.length > 0 ? `${acc} ${next}` : next;
	}
	const endPos = startLineStart + acc.length;
	return { changeFrom: startLineStart, changeTo: lastLineEnd, insert: acc, selFrom: endPos, selTo: endPos };
}

/** Sublime Text `Ctrl+Enter`: inserts an indented blank line directly below the current line without splitting text. */
export function computeInsertLineBelow(doc: string, head: number): PureLineEdit {
	const pos = Math.max(0, Math.min(head, doc.length));
	const lineStart = pos === 0 ? 0 : doc.lastIndexOf("\n", pos - 1) + 1;
	const lineEndRaw = doc.indexOf("\n", pos);
	const lineEnd = lineEndRaw < 0 ? doc.length : lineEndRaw;
	const indent = /^[ \t]*/.exec(doc.slice(lineStart, lineEnd))![0];
	const insert = `\n${indent}`;
	const nextCursor = lineEnd + insert.length;
	return { changeFrom: lineEnd, changeTo: lineEnd, insert, selFrom: nextCursor, selTo: nextCursor };
}

/** Sublime Text `Ctrl+Shift+Enter`: inserts an indented blank line directly above the current line without splitting text. */
export function computeInsertLineAbove(doc: string, head: number): PureLineEdit {
	const pos = Math.max(0, Math.min(head, doc.length));
	const lineStart = pos === 0 ? 0 : doc.lastIndexOf("\n", pos - 1) + 1;
	const lineEndRaw = doc.indexOf("\n", pos);
	const lineEnd = lineEndRaw < 0 ? doc.length : lineEndRaw;
	const indent = /^[ \t]*/.exec(doc.slice(lineStart, lineEnd))![0];
	const insert = `${indent}\n`;
	const nextCursor = lineStart + indent.length;
	return { changeFrom: lineStart, changeTo: lineStart, insert, selFrom: nextCursor, selTo: nextCursor };
}

/** Sublime Text / Monaco `Ctrl+L`: selects the full current line and expands to the next line on repeated presses. */
export function computeSelectLine(doc: string, from: number, to: number): { from: number; to: number } {
	const a = Math.max(0, Math.min(from, to, doc.length));
	const b = Math.max(a, Math.min(Math.max(from, to), doc.length));
	const startLineStart = a === 0 ? 0 : doc.lastIndexOf("\n", a - 1) + 1;
	const lineEndInclusive = (pos: number) => {
		const nl = doc.indexOf("\n", pos);
		return nl < 0 ? doc.length : nl + 1;
	};
	if (a === b) return { from: startLineStart, to: lineEndInclusive(a) };
	if (a === startLineStart && (b === doc.length || doc[b - 1] === "\n")) {
		if (b >= doc.length) return { from: a, to: b };
		return { from: a, to: lineEndInclusive(b) };
	}
	const endCheck = b > a && doc[b - 1] === "\n" ? b - 1 : b;
	return { from: startLineStart, to: lineEndInclusive(endCheck) };
}

// --- Pure Live Table TSV / CSV & Range Helpers (shared with cmLiveTable.ts) --

export type TableCellRange = {
	minRow: number;
	maxRow: number;
	minCol: number;
	maxCol: number;
};

/** Normalizes two cell coordinates into an inclusive rectangular cell range. */
export function normalizeTableRange(
	a: { row: number; col: number },
	b: { row: number; col: number },
): TableCellRange {
	return {
		minRow: Math.min(a.row, b.row),
		maxRow: Math.max(a.row, b.row),
		minCol: Math.min(a.col, b.col),
		maxCol: Math.max(a.col, b.col),
	};
}

function sliceTableMatrix(table: MarkdownTable, range?: TableCellRange | null): string[][] {
	const maxR = table.rows.length - 1;
	const maxC = table.alignments.length - 1;
	if (maxR < 0 || maxC < 0) return [];
	const r0 = range ? Math.max(0, Math.min(maxR, range.minRow)) : 0;
	const r1 = range ? Math.max(r0, Math.min(maxR, range.maxRow)) : maxR;
	const c0 = range ? Math.max(0, Math.min(maxC, range.minCol)) : 0;
	const c1 = range ? Math.max(c0, Math.min(maxC, range.maxCol)) : maxC;
	const out: string[][] = [];
	for (let r = r0; r <= r1; r++) {
		const row: string[] = [];
		for (let c = c0; c <= c1; c++) {
			row.push(cellValueForEdit(table.rows[r]?.[c] ?? ""));
		}
		out.push(row);
	}
	return out;
}

/** Serializes a Markdown table (or rectangular cell selection) as Excel/Sheets-ready TSV. */
export function serializeTableToTsv(table: MarkdownTable, range?: TableCellRange | null): string {
	return sliceTableMatrix(table, range)
		.map((row) => row.map((cell) => cell.replace(/[\t\r\n]+/g, " ")).join("\t"))
		.join("\n");
}

/** Serializes a Markdown table (or rectangular cell selection) as RFC-4180 CSV. */
export function serializeTableToCsv(table: MarkdownTable, range?: TableCellRange | null): string {
	return sliceTableMatrix(table, range)
		.map((row) => csvRow(row, ","))
		.join("\n");
}

// --- Pure Bounded Recursive Transclusion Expander (shared with hoverPreview.ts) ---

const EMBED_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
export const MAX_TRANSCLUSION_DEPTH = 2;

export type TransclusionLoaderResult = {
	key: string;
	docKey: string;
	title: string;
	path: string;
	markdown: string;
};

export type TransclusionLoader = (inner: string, fromPath: string) => Promise<TransclusionLoaderResult | null>;

/**
 * Recursively expands standalone Obsidian `![[note]]` / `![[note#Heading]]` transclusions
 * inside Markdown with strict depth limiting (`maxDepth = 2`) and cycle detection (`visited`),
 * while leaving fenced code blocks and image embeds untouched.
 */
export async function expandTransclusionsMarkdown(
	md: string,
	sourcePath: string,
	loader: TransclusionLoader,
	options: { depth?: number; maxDepth?: number; visited?: ReadonlySet<string> } = {},
): Promise<string> {
	if (!md.includes("![[")) return md;
	const depth = options.depth ?? 0;
	const maxDepth = options.maxDepth ?? MAX_TRANSCLUSION_DEPTH;
	const visited = options.visited ?? new Set<string>();
	const lines = md.split(/\r?\n/);
	const out: string[] = [];
	let openFence: { ch: string; len: number } | null = null;

	for (const line of lines) {
		const fm = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fm) {
			const ch = fm[1]![0]!;
			const len = fm[1]!.length;
			const info = fm[2]!;
			if (!openFence) {
				if (ch !== "`" || !info.includes("`")) {
					openFence = { ch, len };
					out.push(line);
					continue;
				}
			} else if (ch === openFence.ch && len >= openFence.len && info.trim() === "") {
				openFence = null;
				out.push(line);
				continue;
			}
		}
		if (openFence) {
			out.push(line);
			continue;
		}

		const embedMatch = /^[ \t]*!\[\[([^[\]\n]+)\]\][ \t]*$/.exec(line);
		if (!embedMatch) {
			out.push(line);
			continue;
		}
		const inner = embedMatch[1]!.trim();
		const bar = inner.indexOf("|");
		const targetPart = (bar < 0 ? inner : inner.slice(0, bar)).trim();
		const targetBase = targetPart.split("#")[0]?.trim() ?? "";
		if (EMBED_IMAGE_EXT_RE.test(targetBase)) {
			out.push(line);
			continue;
		}

		if (depth >= maxDepth) {
			out.push(`> *Embedded: [[${targetPart || inner}]] (max embed depth reached)*`);
			continue;
		}

		const loaded = await loader(inner, sourcePath);
		if (!loaded) {
			out.push(line);
			continue;
		}
		const headingRequested = targetPart.includes("#");
		if (visited.has(loaded.key) || (!headingRequested && visited.has(loaded.docKey))) {
			out.push(`> *Circular embed skipped: ${loaded.title}*`);
			continue;
		}

		const nextVisited = new Set(visited);
		nextVisited.add(loaded.key);
		if (!headingRequested) nextVisited.add(loaded.docKey);

		const expandedBody = await expandTransclusionsMarkdown(loaded.markdown, loaded.path, loader, {
			depth: depth + 1,
			maxDepth,
			visited: nextVisited,
		});
		const quotedBody = expandedBody
			.trim()
			.split(/\r?\n/)
			.map((l) => (l.length ? `> ${l}` : ">"))
			.join("\n");
		out.push(`> [!note] ${loaded.title}${quotedBody ? `\n${quotedBody}` : ""}`);
	}
	return out.join("\n");
}
