import type { Table } from "./csv";
import { ticketKey } from "./projectDocs";

// Tickets as a ticket system gives them out: a table exported from it (Jira's
// CSV, a work-item list), or the JSON its API returns. Read here into what a
// ticket file holds (ADR 0012): the key, the title, the state, what kind of
// ticket it is, the tickets it is tied to, and what was asked. People are left
// out on purpose: who reported a ticket and who it is assigned to are not what
// the work is, and a project's folder is often shared more widely than the
// ticket system.

export type ImportedTicket = {
	key: string;
	title: string;
	status?: string;
	/** What kind of ticket: Bug, Story, Task. */
	type?: string;
	/** A link to the ticket, when the export has one. */
	source?: string;
	/** The ticket it is part of. */
	parent?: string;
	/** The tickets it is tied to, the parent not among them. */
	related: string[];
	/** What was asked, in the ticket's own words. */
	description: string;
};

export type Imported = { tickets: ImportedTicket[]; /** Rows or entries with no key or no title: not tickets. */ skipped: number; /** Why nothing could be read, when nothing could. */ problem?: string };

const KEY_LIKE = /^[A-Za-z][A-Za-z0-9_]*-\d+$|^\d+$/;
const clean = (text: string | undefined) => (text ?? "").replace(/\r\n/g, "\n").trim();
const keysIn = (text: string) =>
	text
		.split(/[\s,;|]+/)
		.map((word) => word.trim())
		.filter((word) => KEY_LIKE.test(word))
		.map(ticketKey);
const unique = (keys: string[], not: string[]) => [...new Set(keys)].filter((key) => !not.some((other) => other.toLowerCase() === key.toLowerCase()));

/** A column's name as it is looked up: a ticket system writes a field of its own as "Custom field (Epic Link)". */
const headerName = (header: string) => header.trim().replace(/^custom field \((.*)\)$/i, "$1").trim().toLowerCase();
/** The first column whose name is one of these, in this order of preference; -1 when none is. */
const column = (table: Table, names: string[]) => names.map((name) => table.header.findIndex((cell) => headerName(cell.text) === name)).find((at) => at >= 0) ?? -1;
/**
 * The keys among these that are the same kind of key as the ticket's own. An
 * export gives a parent or a link as a key in one column and as the ticket
 * system's own number in another: for a ticket called DEMO-103, 10002 is not
 * a ticket anyone could find.
 */
const likeOwn = (own: string, keys: string[]) => (/^\d+$/.test(own) ? keys : keys.filter((key) => !/^\d+$/.test(key)));
/** Every column whose name says it ties one ticket to another: a system writes one for each kind of link, and one for each link. */
const linkColumns = (table: Table) => table.header.map((cell, at) => (/issue link|linked issue|related|relates|blocks|blocked|depends|duplicat|sub-?tasks?$/i.test(cell.text) ? at : -1)).filter((at) => at >= 0);

/** The tickets in a table: one for each row that has a key and a title. */
export function ticketsFromTable(table: Table): Imported {
	const key = column(table, ["issue key", "key", "ticket", "work item id", "id", "number", "issue id"]);
	const title = column(table, ["summary", "title", "subject", "name"]);
	if (key < 0 || title < 0) return { tickets: [], skipped: table.rows.length, problem: `It has no column for a ticket's ${key < 0 ? "key (Issue key, Key, ID)" : "title (Summary, Title)"}.` };
	const status = column(table, ["status", "state"]);
	const type = column(table, ["issue type", "work item type", "type"]);
	const description = column(table, ["description", "details", "body"]);
	const source = column(table, ["url", "issue url", "link"]);
	const parent = column(table, ["parent key", "parent", "parent id", "epic link"]);
	const links = linkColumns(table).filter((at) => at !== parent && at !== key);
	const tickets: ImportedTicket[] = [];
	let skipped = 0;
	for (const cells of table.rows) {
		const at = (index: number) => (index < 0 ? "" : clean(cells[index]?.text));
		const own = ticketKey(at(key));
		if (!own || !at(title)) {
			skipped++;
			continue;
		}
		const above = likeOwn(own, keysIn(at(parent)))[0];
		tickets.push({
			key: own,
			title: at(title).replace(/\s+/g, " "),
			status: at(status) || undefined,
			type: at(type) || undefined,
			source: /^https?:\/\//i.test(at(source)) ? at(source) : undefined,
			parent: above && above.toLowerCase() !== own.toLowerCase() ? above : undefined,
			related: unique(likeOwn(own, links.flatMap((index) => keysIn(at(index)))), [own, above ?? ""]),
			description: at(description),
		});
	}
	return { tickets, skipped };
}

/** The words of a description that is a tree of nodes (a rich-text document): its text, a paragraph to a line. */
function flat(node: unknown): string {
	if (typeof node === "string") return node;
	if (!node || typeof node !== "object") return "";
	const { type, text, content } = node as { type?: string; text?: unknown; content?: unknown };
	if (typeof text === "string") return text;
	const inner = Array.isArray(content) ? content.map(flat) : [];
	if (type === "hardBreak") return "\n";
	if (type === "listItem") return `- ${inner.join("").trim()}\n`;
	if (type === "paragraph" || type === "heading" || type === "codeBlock" || type === "blockquote") return `${inner.join("")}\n\n`;
	return inner.join("");
}
const named = (value: unknown) => (typeof value === "string" ? value : value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string" ? (value as { name: string }).name : "");
/** A ticket's key from what stands for one: the key itself, a number (a system that numbers its tickets), or an object that holds one. */
const keyOf = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (!value || typeof value !== "object") return "";
	const held = value as { key?: unknown; number?: unknown; id?: unknown };
	return typeof held.key === "string" ? held.key : typeof held.number === "number" ? String(held.number) : typeof held.id === "number" ? String(held.id) : "";
};

/**
 * The tickets in what a ticket system's API returns: one issue, a list of
 * them, or an object with a list under `issues`. An issue has a `key` and its
 * `fields` (or the fields beside the key).
 */
export function ticketsFromJson(value: unknown): Imported {
	const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { issues?: unknown }).issues) ? (value as { issues: unknown[] }).issues : value && typeof value === "object" ? [value] : [];
	if (!list.length) return { tickets: [], skipped: 0, problem: "It holds no issues: neither a list, nor an object with a key or a list named issues." };
	const tickets: ImportedTicket[] = [];
	let skipped = 0;
	for (const entry of list) {
		const issue = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
		const fields = (issue.fields && typeof issue.fields === "object" ? issue.fields : issue) as Record<string, unknown>;
		const own = ticketKey(keyOf(issue.key ?? issue.number ?? issue.id ?? ""));
		const title = clean(named(fields.summary ?? fields.title)).replace(/\s+/g, " ");
		if (!own || !title) {
			skipped++;
			continue;
		}
		const above = ticketKey(keyOf(fields.parent));
		const links = Array.isArray(fields.issuelinks) ? fields.issuelinks.flatMap((link) => [keyOf((link as Record<string, unknown>)?.outwardIssue), keyOf((link as Record<string, unknown>)?.inwardIssue)]) : [];
		// Under one name or the other, and as a key or as a link to one.
		const under = [fields.subtasks, fields["sub-tasks"]].flatMap((list) => (Array.isArray(list) ? list : []));
		const subtasks = under.flatMap((task) => [keyOf(task), keyOf((task as Record<string, unknown>)?.outwardIssue)]);
		const related = Array.isArray(fields.related) ? fields.related.map(keyOf) : [];
		tickets.push({
			key: own,
			title,
			status: named(fields.status ?? fields.state) || undefined,
			type: named(fields.issuetype ?? fields.type) || undefined,
			source: typeof issue.url === "string" && /^https?:\/\//i.test(issue.url) ? issue.url : undefined,
			parent: above && above.toLowerCase() !== own.toLowerCase() ? above : undefined,
			related: unique([...links, ...subtasks, ...related].filter(Boolean).map(ticketKey), [own, above]),
			description: clean(flat(fields.description)).replace(/\n{3,}/g, "\n\n"),
		});
	}
	return { tickets, skipped };
}

/** What an import came to, in a sentence. */
export function importSummary(counts: { made: number; updated: number; same: number; skipped: number }): string {
	const n = (count: number, what: string) => (count ? `${count} ${what}` : "");
	const parts = [n(counts.made, "new"), n(counts.updated, "updated"), n(counts.same, "as they were")].filter(Boolean);
	const total = counts.made + counts.updated + counts.same;
	if (!total) return counts.skipped ? `No tickets: ${counts.skipped} ${counts.skipped === 1 ? "row has" : "rows have"} no key or no title.` : "No tickets there.";
	return `${total} ${total === 1 ? "ticket" : "tickets"}: ${parts.join(", ")}.${counts.skipped ? ` ${counts.skipped} without a key or a title ${counts.skipped === 1 ? "was" : "were"} passed over.` : ""}`;
}
