// What is done to Markdown's HTML after it is cleaned, wherever it is shown:
// a document in the reading view, a reply in the Agent panel.
import { MAX_SHORT, headingAnchor } from "../../shared/docTables";
import { parseCalloutHeader } from "../../shared/markdownEdit";
import { namedLinksIn } from "../../shared/namedLinks";
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
		katexLoading = Promise.all([import("katex"), cssImport]).then(([mod]) => {
			katexMod = mod.default ?? (mod as unknown as KatexModule);
			return katexMod;
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
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeValue?.includes("==") && !node.parentElement?.closest("code, pre, script, style")) nodes.push(node as Text);
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

/** Turns `#tag` mentions in prose (outside code, links, and headings) into clickable `.md-tag` pills. */
function renderTags(holder: HTMLTemplateElement) {
	const walker = document.createTreeWalker(holder.content, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeValue?.includes("#") && !node.parentElement?.closest(`${UNLINKED}, h1, h2, h3, h4, h5, h6`)) nodes.push(node as Text);
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

/** Upgrades Obsidian/GitHub callout blockquotes (`> [!NOTE] Title`) into styled `.md-callout` cards. */
function renderCallouts(holder: HTMLTemplateElement) {
	for (const quote of [...holder.content.querySelectorAll("blockquote")]) {
		const firstP = quote.firstElementChild;
		if (!firstP || firstP.tagName !== "P") continue;
		const firstText = firstP.textContent ?? "";
		const newline = firstText.indexOf("\n");
		const headerLine = newline < 0 ? firstText : firstText.slice(0, newline);
		const parsed = parseCalloutHeader(`> ${headerLine}`);
		if (!parsed) continue;

		const card = document.createElement("div");
		card.className = `md-callout tone-${parsed.spec.tone}`;
		const head = document.createElement("div");
		head.className = "md-callout-head";
		const icon = document.createElement("span");
		icon.className = "md-callout-icon";
		icon.setAttribute("aria-hidden", "true");
		icon.textContent = parsed.spec.icon;
		const title = document.createElement("span");
		title.textContent = parsed.title;
		head.append(icon, title);
		card.appendChild(head);

		// Remove the `[!TYPE]...` header text from the first paragraph, keeping any lines below it.
		if (newline < 0) {
			firstP.remove();
		} else {
			// Walk leading text nodes in firstP to strip only up to and including the first newline.
			let remaining = newline + 1;
			while (firstP.firstChild && remaining > 0) {
				const child = firstP.firstChild;
				if (child.nodeType === Node.TEXT_NODE) {
					const val = child.nodeValue ?? "";
					if (val.length <= remaining) {
						remaining -= val.length;
						child.remove();
					} else {
						child.nodeValue = val.slice(remaining);
						remaining = 0;
					}
				} else if (child.nodeName === "BR") {
					child.remove();
					remaining = 0;
				} else {
					const len = (child.textContent ?? "").length;
					if (len <= remaining) {
						remaining -= len;
						child.remove();
					} else {
						remaining = 0;
					}
				}
			}
			if (!(firstP.textContent ?? "").trim() && !firstP.children.length) firstP.remove();
		}

		const body = document.createElement("div");
		body.className = "md-callout-body";
		while (quote.firstChild) body.appendChild(quote.firstChild);
		if (body.childNodes.length) card.appendChild(body);
		quote.replaceWith(card);
	}
}

/** Renders safe `$...$` and `$$...$$` math spans in prose text nodes (skipping code, links, and currency). */
function renderMath(holder: HTMLTemplateElement) {
	const walker = document.createTreeWalker(holder.content, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeValue?.includes("$") && !node.parentElement?.closest(UNLINKED)) nodes.push(node as Text);
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
				void loadKatex();
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
	if (options.anchors) anchorHeadings(holder);
	if (html.includes("[!")) renderCallouts(holder);
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
