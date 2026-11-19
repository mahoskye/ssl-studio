// What is done to Markdown's HTML after it is cleaned, wherever it is shown:
// a document in the reading view, a reply in the Agent panel.
import { MAX_SHORT, headingAnchor } from "../../shared/docTables";
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

/** `html` must already be sanitised. Anchors are for a document; a reply has no links into itself. */
export function finishMarkdown(html: string, options: { anchors?: boolean; tickets?: readonly TicketRef[] } = {}): string {
	if (!options.anchors && !options.tickets?.length && !html.includes("<table")) return html;
	const holder = document.createElement("template");
	holder.innerHTML = html;
	if (options.anchors) anchorHeadings(holder);
	if (options.tickets?.length) linkTickets(holder, options.tickets);
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
