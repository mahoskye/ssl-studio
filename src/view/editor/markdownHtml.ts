// What is done to Markdown's HTML after it is cleaned, wherever it is shown:
// a document in the reading view, a reply in the Agent panel.
import { MAX_SHORT, headingAnchor } from "../../shared/docTables";
import { parseCalloutHeader } from "../../shared/markdownEdit";
import { namedLinksIn } from "../../shared/namedLinks";
import { ticketMatcher } from "../../shared/ticketRefs";

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
		const matches = [...text.matchAll(/(^|[\s(])(#[A-Za-z][A-Za-z0-9_/-]*)/g)];
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

/** `html` must already be sanitised. Anchors are for a document; a reply has no links into itself. */
export function finishMarkdown(html: string, options: { anchors?: boolean; tickets?: readonly TicketRef[]; named?: NameResolver } = {}): string {
	const names = options.named && html.includes("[[") ? options.named : undefined;
	const hasExtra = html.includes("==") || html.includes("#") || html.includes("[!");
	if (!options.anchors && !options.tickets?.length && !names && !html.includes("<table") && !hasExtra) return html;
	const holder = document.createElement("template");
	holder.innerHTML = html;
	if (options.anchors) anchorHeadings(holder);
	if (html.includes("[!")) renderCallouts(holder);
	if (names) linkNames(holder, names);
	if (options.tickets?.length) linkTickets(holder, options.tickets);
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
