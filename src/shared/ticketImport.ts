import type { Table } from "./csv";
import { marked, type Token, type Tokens } from "marked";
import { adfToMarkdown, isAdf } from "./adf";
import { ticketKey } from "./projectDocs";
import { wikiToMarkdown } from "./wikiMarkup";

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
	/** Directional blocking links when present in the export. */
	blocks?: string[];
	blockedBy?: string[];
	/** What was asked, in the ticket's own words. */
	description: string;
};

export type Imported = {
	tickets: ImportedTicket[];
	/** Rows or entries with no key or no title: not tickets. */
	skipped: number;
	/** Entries that are pull requests: a system that lists them among its issues gives them out together. */
	pulls?: number;
	/** Why nothing could be read, when nothing could. */
	problem?: string;
};

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

/**
 * A description as Markdown. One from a system of the Jira kind is in that
 * system's wiki markup, and is turned into Markdown; any other is taken as
 * it is. It is not guessed from the text: Markdown that holds "{{ }}" for a
 * template of its own is not wiki markup.
 */
const described = (text: string, wiki: boolean) => (text && wiki ? wikiToMarkdown(text) : underSections(text));

/**
 * Where what the renderer read ends in the text, starting at `at`: the same
 * characters, a tab in the text standing for the four spaces the renderer
 * makes of it. -1 when the text does not read that way.
 */
function readAs(text: string, at: number, raw: string): number {
	let from = at;
	for (let i = 0; i < raw.length; ) {
		if (text[from] === raw[i]) {
			from++;
			i++;
		} else if (text[from] === "\t" && raw.startsWith("    ", i)) {
			from++;
			i += 4;
		} else return -1;
	}
	return from;
}

/**
 * Markdown that goes under a ticket's own "What is asked": its headings are
 * moved down together, so that the largest of them is the document's third
 * level and the ticket keeps the one title it has.
 *
 * Which lines are headings is the renderer's to say: a line of dashes under
 * a list item, under code or under a tag is not one, and looks just like
 * one. So the headings are those the renderer's own lexer gives, at the top
 * of the document. Only the marks of a heading change; one written with a
 * line under it is written with marks before it, its words as they were.
 */
function underSections(text: string): string {
	if (!/^ {0,3}#|^ {0,3}(=+|-+)[ \t]*$/m.test(text)) return text;
	let tokens: Token[];
	try {
		tokens = marked.lexer(text, { gfm: true });
	} catch {
		return text;
	}
	const heads: { from: number; raw: string; depth: number }[] = [];
	let at = 0;
	for (const token of tokens) {
		// The renderer reads a tab that begins a line as four spaces: what it read is found in the text all the same.
		const end = readAs(text, at, token.raw);
		// It read the text some other way than it is written: nothing is changed.
		if (end < 0) return text;
		if (token.type === "heading") heads.push({ from: at, raw: text.slice(at, end), depth: (token as Tokens.Heading).depth });
		at = end;
	}
	const down = 3 - Math.min(3, ...heads.map((head) => head.depth));
	if (!down) return text;
	for (const head of heads.reverse()) {
		const marks = "#".repeat(Math.min(6, head.depth + down));
		const marked = /^( {0,3})#{1,6}/.exec(head.raw);
		let anew: string;
		if (marked) anew = `${marked[1]}${marks}${head.raw.slice(marked[0].length)}`;
		else {
			// Words over a line of "=" or "-": the words, with the marks before. Over several lines the words have
			// line breaks of their own that marks before them would lose: such a heading is left as it is written.
			const ends = /\n*$/.exec(head.raw)![0];
			const lines = head.raw.slice(0, head.raw.length - ends.length).split("\n");
			if (lines.length !== 2) continue;
			// A "#" that ends the words would be taken for the heading's own closing mark.
			anew = `${marks} ${lines[0]!.trim().replace(/#+$/, (end) => end.replace(/#/g, "\\#"))}${ends}`;
		}
		text = `${text.slice(0, head.from)}${anew}${text.slice(head.from + head.raw.length)}`;
	}
	return text;
}

/**
 * A state as a person writes it: one of a system's own words in capitals
 * ("OPEN", "NOT_PLANNED") is the word. Any other is left as it was written:
 * "QA" and "UAT" are names, not shouting.
 */
const SHOUTED = new Set(["OPEN", "CLOSED", "REOPENED", "MERGED", "COMPLETED", "NOT_PLANNED", "DUPLICATE", "DRAFT"]);
const stated = (status: string) => (SHOUTED.has(status) ? status.toLowerCase().replace(/_/g, " ") : status);

/** The tickets in a table: one for each row that has a key and a title. */
export function ticketsFromTable(table: Table): Imported {
	const key = column(table, ["issue key", "key", "ticket", "work item id", "id", "number", "issue id"]);
	const title = column(table, ["summary", "title", "subject", "name"]);
	if (key < 0 || title < 0) return { tickets: [], skipped: table.rows.length, problem: `It has no column for a ticket's ${key < 0 ? "key (Issue key, Key, ID)" : "title (Summary, Title)"}.` };
	const status = column(table, ["status", "state"]);
	const type = column(table, ["issue type", "work item type", "type"]);
	const description = column(table, ["description", "details", "body"]);
	const source = column(table, ["url", "issue url", "link"]);
	// What a ticket is part of, the nearest first: its parent, then the larger piece of work it belongs to. An export
	// has a column for each, most of them empty in any one row.
	const parents = ["parent key", "parent", "parent id", "parent link", "epic link"].map((name) => column(table, [name])).filter((at) => at >= 0 && at !== key);
	const links = linkColumns(table).filter((at) => !parents.includes(at) && at !== key);
	// An export of the Jira kind gives a parent by the system's own number ("Parent id") and each ticket's number
	// beside its key ("Issue id"): the parent's key is the key of the row with that number.
	const number = column(table, ["issue id"]);
	const byNumber = new Map(number >= 0 && number !== key ? table.rows.flatMap((cells) => (clean(cells[number]?.text) && clean(cells[key]?.text) ? [[clean(cells[number]!.text), ticketKey(clean(cells[key]!.text))] as const] : [])) : []);
	const keyed = (own: string, keys: string[]) => likeOwn(own, keys.map((found) => (/^\d+$/.test(found) && !/^\d+$/.test(own) ? (byNumber.get(found) ?? found) : found)));
	// Its descriptions are in that system's wiki markup.
	const wiki = column(table, ["issue key"]) >= 0;
	const tickets: ImportedTicket[] = [];
	let skipped = 0;
	for (const cells of table.rows) {
		const at = (index: number) => (index < 0 ? "" : clean(cells[index]?.text));
		const own = ticketKey(at(key));
		if (!own || !at(title)) {
			skipped++;
			continue;
		}
		const above = parents.map((index) => keyed(own, keysIn(at(index)))[0]).find(Boolean);
		tickets.push({
			key: own,
			title: at(title).replace(/\s+/g, " "),
			status: stated(at(status)) || undefined,
			type: at(type) || undefined,
			source: /^https?:\/\//i.test(at(source)) ? at(source) : undefined,
			parent: above && above.toLowerCase() !== own.toLowerCase() ? above : undefined,
			related: unique(keyed(own, links.flatMap((index) => keysIn(at(index)))), [own, above ?? ""]),
			description: described(at(description), wiki),
		});
	}
	return { tickets, skipped };
}

/** A description as text: text as it is, a tree of nodes (a rich-text document) written as Markdown. */
const flat = (value: unknown): string => (typeof value === "string" ? value : isAdf(value) ? adfToMarkdown(value) : "");
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
 * The page a person opens for an issue: the one named as such ("html_url"),
 * or its "url" when that is a page and not the API's own address for it.
 */
const pageOf = (issue: Record<string, unknown>) => {
	const page = [issue.html_url, issue.url].find((value): value is string => typeof value === "string" && /^https?:\/\//i.test(value) && !/^https?:\/\/api\.|\/rest\/api\/|\/api\/v\d/i.test(value));
	return page;
};
/** A closed issue that says why it was closed without being done is that, not "closed": not planned, a duplicate. */
const closedAs = (fields: Record<string, unknown>) => {
	const why = named(fields.state_reason ?? fields.stateReason).toLowerCase().replace(/_/g, " ");
	return why === "not planned" || why === "duplicate" ? why : "";
};

/** The page a person opens for a ticket, from the address the API gives for it: ".../rest/api/2/issue/10011" is ".../browse/KEY". */
const browseLink = (self: unknown, key: string) => {
	const found = typeof self === "string" ? /^(https?:\/\/.+?)\/rest\/api\/[^/]+\/issue\/[^/]+$/i.exec(self) : null;
	return found ? `${found[1]}/browse/${key}` : undefined;
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
	let pulls = 0;
	for (const entry of list) {
		const issue = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
		// A pull request listed among the issues is a change, not something asked for.
		if (issue.pull_request && typeof issue.pull_request === "object") {
			pulls++;
			continue;
		}
		const fields = (issue.fields && typeof issue.fields === "object" ? issue.fields : issue) as Record<string, unknown>;
		const own = ticketKey(keyOf(issue.key ?? issue.number ?? issue.id ?? ""));
		const title = clean(named(fields.summary ?? fields.title)).replace(/\s+/g, " ");
		if (!own || !title) {
			skipped++;
			continue;
		}
		// Parent: prefer `fields.parent`, then Jira Server/DC `fields.epic` / `fields.epicLink` / epic custom field string matching the same key prefix.
		const ownPrefix = /^([A-Za-z][A-Za-z0-9_]*)-/.exec(own)?.[1]?.toLowerCase() ?? "";
		let epicFallback = keyOf(fields.epic ?? fields.epicLink);
		if (!epicFallback && ownPrefix) {
			for (const [k, v] of Object.entries(fields)) {
				if (!/^customfield_\d+$/i.test(k) || typeof v !== "string") continue;
				const cand = ticketKey(v);
				if (cand && cand.toLowerCase().startsWith(`${ownPrefix}-`) && cand.toLowerCase() !== own.toLowerCase()) {
					epicFallback = cand;
					break;
				}
			}
		}
		const above = likeOwn(own, [ticketKey(keyOf(fields.parent) || epicFallback)].filter(Boolean))[0] ?? "";
		const rawIssueLinks = Array.isArray(fields.issuelinks) ? (fields.issuelinks as Record<string, unknown>[]) : [];
		const blocksRaw: string[] = [];
		const blockedByRaw: string[] = [];
		const links: string[] = [];
		for (const link of rawIssueLinks) {
			const typeObj = (link?.type && typeof link.type === "object" ? link.type : {}) as Record<string, unknown>;
			const outward = keyOf(link?.outwardIssue);
			const inward = keyOf(link?.inwardIssue);
			const outName = String(typeObj.outward ?? typeObj.name ?? "").toLowerCase();
			const inName = String(typeObj.inward ?? typeObj.name ?? "").toLowerCase();
			if (outward) {
				links.push(outward);
				if (/\bblocks\b/.test(outName)) blocksRaw.push(outward);
			}
			if (inward) {
				links.push(inward);
				if (/\bblocked by\b/.test(inName)) blockedByRaw.push(inward);
			}
		}
		// Under one name or the other, and as a key or as a link to one.
		const under = [fields.subtasks, fields["sub-tasks"]].flatMap((list) => (Array.isArray(list) ? list : []));
		const subtasks = under.flatMap((task) => [keyOf(task), keyOf((task as Record<string, unknown>)?.outwardIssue)]);
		const related = Array.isArray(fields.related) ? fields.related.map(keyOf) : [];
		const blocks = unique(likeOwn(own, blocksRaw.map(ticketKey)), [own, above]);
		const blockedBy = unique(likeOwn(own, blockedByRaw.map(ticketKey)), [own, above]);
		tickets.push({
			key: own,
			title,
			status: closedAs(fields) || stated(named(fields.status ?? fields.state)) || undefined,
			type: named(fields.issuetype ?? fields.type) || undefined,
			source: pageOf(issue) ?? browseLink(issue.self, own),
			parent: above && above.toLowerCase() !== own.toLowerCase() ? above : undefined,
			related: unique(likeOwn(own, [...links, ...subtasks, ...related].filter(Boolean).map(ticketKey)), [own, above]),
			...(blocks.length ? { blocks } : {}),
			...(blockedBy.length ? { blockedBy } : {}),
			// An API of the Jira kind gives the fields under "fields", and a description that is text in its wiki markup.
			// What was asked is under one name or another: "description", or an issue's "body".
			description: described(clean(flat(fields.description ?? fields.body ?? fields.details)), typeof fields.description === "string" && fields !== issue),
		});
	}
	return { tickets, skipped, ...(pulls ? { pulls } : {}) };
}

/** What an import came to, in a sentence. */
export function importSummary(counts: { made: number; updated: number; same: number; skipped: number; pulls?: number }): string {
	const n = (count: number, what: string) => (count ? `${count} ${what}` : "");
	const parts = [n(counts.made, "new"), n(counts.updated, "updated"), n(counts.same, "as they were")].filter(Boolean);
	const total = counts.made + counts.updated + counts.same;
	const pulls = counts.pulls ? ` ${counts.pulls} pull ${counts.pulls === 1 ? "request was" : "requests were"} passed over: a change is not a ticket.` : "";
	if (!total) return `${counts.skipped ? `No tickets: ${counts.skipped} ${counts.skipped === 1 ? "row has" : "rows have"} no key or no title.` : "No tickets there."}${pulls}`;
	return `${total} ${total === 1 ? "ticket" : "tickets"}: ${parts.join(", ")}.${counts.skipped ? ` ${counts.skipped} without a key or a title ${counts.skipped === 1 ? "was" : "were"} passed over.` : ""}${pulls}`;
}
