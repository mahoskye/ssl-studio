import { CATALOG_FILE, type CatalogItem } from "./catalog";
import { baseName, joinPath, relativePath } from "./paths";
import type { DocFile, DocGroup } from "./protocol";

// What a project's documents are, beyond its README: the tickets that drive
// the work, the specs written from them, a knowledge base of decisions,
// questions and things kept for use, and the registries a migration is
// checked against (ADR 0012). All of it is under the project's docs folder;
// this says where, and what a new one of each starts as.

/** The folders under the docs folder, each with its catalog. */
export const DOC_FOLDERS = { tickets: "tickets", specs: "specs", knowledge: "knowledge", registries: "registries" } as const;
export type DocArea = keyof typeof DOC_FOLDERS;

/** The project's state, in plain words: at the top of the docs folder. */
export const STATE_FILE = "STATE.md";

export type KnowledgeKind = { id: "decisions" | "questions" | "snippets" | "reference"; name: string; one: string; about: string };
/** The kinds of thing the knowledge base keeps, each in its own folder. */
export const KNOWLEDGE: readonly KnowledgeKind[] = [
	{ id: "decisions", name: "Decisions", one: "decision", about: "What was decided, and why: one decision in a file." },
	{ id: "questions", name: "Questions", one: "question", about: "What is not yet known, and what was answered: one question in a file." },
	{ id: "snippets", name: "Snippets", one: "snippet", about: "SQL queries and pieces of SSL kept for use." },
	{ id: "reference", name: "Reference", one: "reference note", about: "How something works: one subject in a file." },
];

export type RegistryKind = { id: string; file: string; title: string; about: string; columns: readonly string[] };
/** The registries a project is offered. Each is a table of values with a `status` column to say how far each row has come. */
export const REGISTRIES: readonly RegistryKind[] = [
	{ id: "settings", file: "settings.csv", title: "Application settings", about: "Each setting the application reads: its name, its value, where it is set.", columns: ["name", "value", "where", "status", "note"] },
	{ id: "files", file: "files.csv", title: "File manifest", about: "Each file of the project, with its size and a checksum, to check that all of it came across.", columns: ["path", "kind", "bytes", "lines", "sha256", "status", "note"] },
	{ id: "database", file: "database.csv", title: "Database objects", about: "Each table, view, procedure and sequence the project reads or writes.", columns: ["object", "kind", "used by", "status", "note"] },
	{ id: "interfaces", file: "interfaces.csv", title: "Interfaces", about: "Each system the application sends to or reads from: instruments, other applications, files dropped in a folder.", columns: ["interface", "direction", "how", "status", "note"] },
	{ id: "jobs", file: "jobs.csv", title: "Scheduled jobs", about: "Each job that runs on its own: when it runs and what it calls.", columns: ["job", "runs", "calls", "status", "note"] },
	{ id: "reports", file: "reports.csv", title: "Reports and labels", about: "Each report, label and printed form, and what reads it.", columns: ["report", "kind", "used by", "status", "note"] },
	{ id: "roles", file: "roles.csv", title: "Roles and access", about: "Each role, and what it may do. Roles, not people.", columns: ["role", "may do", "status", "note"] },
];

/** The words a status is usually one of, by what they come to: a row that is finished, under way, waiting, or set aside. */
const TONES: Record<string, readonly string[]> = {
	done: ["done", "accepted", "answered", "verified", "migrated", "closed", "resolved", "complete", "completed", "approved", "built"],
	active: ["in progress", "doing", "started", "under way", "building", "review", "in review", "testing"],
	waiting: ["open", "to do", "todo", "planned", "ready", "draft", "proposed", "new", "found", "pending", ""],
	off: ["dropped", "superseded", "rejected", "blocked", "gone", "not needed", "won't do", "wontfix", "cancelled", "canceled"],
};
export type Tone = "done" | "active" | "waiting" | "off";
/** What a status comes to. A word that is none of those known is taken as under way. */
export function toneOf(status: string | undefined): Tone {
	const word = (status ?? "").trim().toLowerCase();
	for (const [tone, words] of Object.entries(TONES)) if (words.includes(word)) return tone as Tone;
	return "active";
}

/** A name for a file from a title: its letters and digits, the rest as single dashes. */
export const slug = (title: string) =>
	title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");

/** A ticket's key as a file name: "LIMS-123", whatever case and spaces it was typed with. */
export const ticketKey = (typed: string) => typed.trim().toUpperCase().replace(/\s+/g, "-").replace(/[^A-Z0-9_-]/g, "");

/**
 * The lines a new document starts with, where its own words go. One still
 * there says nothing about the document: it is not its summary.
 */
export const PROMPTS = {
	ticket: "Paste the ticket's description here, in its own words.",
	spec: "One sentence on what this builds, and for whom.",
	decision: "What made a decision necessary.",
	question: "What cannot be done, or decided, until this is known.",
	reference: "One sentence on what this explains.",
	sql: "What it is for, and what to change before running it.",
	ssl: "What it is for, and what to change before using it.",
} as const;
/** Whether a line is one a template wrote, not yet replaced. */
export const isPrompt = (line: string | undefined) => Object.values(PROMPTS).some((prompt) => prompt === (line ?? "").trim());

const fence = (pairs: [string, string | undefined][]) => `---\n${pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n`;
const quoted = (text: string) => (/[:#\[\]{}"',]|^\s|\s$/.test(text) ? JSON.stringify(text) : text);
/** A value as it is written in front matter: quoted when it holds what would be read as something else. */
export const frontValue = quoted;

export const ticketTemplate = (ticket: { key: string; title: string; source?: string; related?: readonly string[]; status?: string; type?: string; parent?: string; description?: string }) => `${fence([
	["ticket", ticket.key],
	["title", quoted(ticket.title)],
	["type", ticket.type ? quoted(ticket.type) : undefined],
	["source", ticket.source || undefined],
	["status", ticket.status ? quoted(ticket.status) : "open"],
	["parent", ticket.parent || undefined],
	["related", `[${(ticket.related ?? []).join(", ")}]`],
])}
# ${ticket.key}: ${ticket.title}

## What is asked

${ticket.description?.trim() || PROMPTS.ticket}

## What done looks like

-

## Notes

`;

export const specTemplate = (spec: { title: string; ticket?: string }) => `${fence([
	["title", quoted(spec.title)],
	["ticket", spec.ticket || undefined],
	["status", "draft"],
])}
# ${spec.title}

${PROMPTS.spec}

## What it does

-

## What it does not do

-

## How it is checked

-
`;

export const decisionTemplate = (decision: { title: string; date: string; ticket?: string }) => `${fence([
	["title", quoted(decision.title)],
	["status", "proposed"],
	["date", decision.date],
	["ticket", decision.ticket || undefined],
])}
# ${decision.title}

## Context

${PROMPTS.decision}

## Decision

What was decided.

## Consequences

What follows from it, good and bad.
`;

export const questionTemplate = (question: { title: string; date: string; ticket?: string }) => `${fence([
	["title", quoted(question.title)],
	["status", "open"],
	["asked", question.date],
	["ticket", question.ticket || undefined],
])}
# ${question.title}

## Why it matters

${PROMPTS.question}

## Answer

Not answered yet. When it is: the answer, who gave it and when, and set the status to answered.
`;

export const referenceTemplate = (note: { title: string }) => `# ${note.title}

${PROMPTS.reference}
`;

/** A snippet starts with a comment that says what it is for: the catalog reads its first line as the title. */
export const snippetTemplate = (snippet: { title: string; language: "sql" | "ssl" }) =>
	// An SSL comment runs to its first semicolon: one in the title would end it early.
	snippet.language === "sql" ? `-- ${snippet.title}\n-- ${PROMPTS.sql}\n\nSELECT 1;\n` : `/* ${snippet.title.replace(/;/g, ",")}\n   ${PROMPTS.ssl}\n;\n`;

export const stateTemplate = (name: string, date: string) => `# Where ${name} stands

As of ${date}. Written to be read aloud to someone who is not an engineer: no
file names, no code.

## Where things stand

One paragraph.

## What works now

-

## What is half-built

-

## What is blocked, and on what

-

## What is next

-
`;

const CATALOG_NOTE = "The list between the two markers is written by SSL Studio from the files here (Docs panel, Update catalogs). Write anything else you like around it.";

/** A catalog as it starts: what the folder is for, and an empty list between its markers. */
export const catalogTemplate = (area: DocArea) => {
	const head: Record<DocArea, [string, string]> = {
		tickets: ["Tickets", "The tickets that drive the work: one file for each, with what was asked, its state and the tickets it is related to."],
		specs: ["Specs", "What is to be built, written from the tickets: one spec in a file, with its state. Specs the planner writes beside a plan are listed here too."],
		knowledge: ["Knowledge base", "What the project has learned: decisions, questions, snippets kept for use, and notes on how things work."],
		registries: ["Registries", "What a migration is checked against: tables of the application's settings, its files and its database objects, each row with how far it has come."],
	};
	return `# ${head[area][0]}\n\n${head[area][1]}\n\n${CATALOG_NOTE}\n\n<!-- catalog -->\n\nNothing here yet.\n\n<!-- /catalog -->\n`;
};

/** A registry's name: what it is called when it is one of those offered, its file's name otherwise. */
export const registryTitle = (file: string) => REGISTRIES.find((r) => r.file.toLowerCase() === baseName(file).toLowerCase())?.title ?? baseName(file).replace(/\.[^.]+$/, "");

/** How far a registry is, in a few words: "12 rows", or "8 of 12 done". */
export function progress(file: Pick<DocFile, "rows" | "tally">): string {
	const rows = file.rows ?? 0;
	if (!file.tally) return `${rows} ${rows === 1 ? "row" : "rows"}`;
	const done = file.tally.by.filter(([status]) => toneOf(status) === "done").reduce((n, [, count]) => n + count, 0);
	return `${done} of ${file.tally.total} done`;
}

/** The same in as little room as it can be said: "8/12", or "12" for a table with no status. */
export function progressShort(file: Pick<DocFile, "rows" | "tally">): string {
	if (!file.tally) return String(file.rows ?? 0);
	const done = file.tally.by.filter(([status]) => toneOf(status) === "done").reduce((n, [, count]) => n + count, 0);
	return `${done}/${file.tally.total}`;
}

/** Whether a file is its folder's catalog. */
export const isCatalog = (file: Pick<DocFile, "name">) => baseName(file.name).toLowerCase() === CATALOG_FILE.toLowerCase();

const AREA_GROUP: Record<DocArea, DocGroup> = { tickets: "tickets", specs: "specs", knowledge: "knowledge", registries: "registries" };

/**
 * What an area's catalog lists: each of its documents, with the way to it
 * from the catalog's folder. A ticket goes by its key and title, a registry by
 * how far it is, and the knowledge base under the kinds of thing it keeps.
 */
export function catalogItems(area: DocArea, files: readonly DocFile[], docsFolder: string): CatalogItem[] {
	const folder = joinPath(docsFolder, DOC_FOLDERS[area]);
	// The knowledge base lists its kinds in their own order, whatever the files' names.
	const order = (file: DocFile) => (area === "knowledge" ? (KNOWLEDGE.findIndex((k) => k.id === file.kind) + 1 || KNOWLEDGE.length + 1) : 0);
	return files
		.filter((file) => file.group === AREA_GROUP[area] && file.exists && !isCatalog(file))
		.sort((a, b) => order(a) - order(b))
		.map((file): CatalogItem => {
			const path = relativePath(folder, file.path);
			const named = file.title || baseName(file.name).replace(/\.(md|markdown|csv|tsv)$/i, "");
			if (area === "tickets") return { path, title: file.ticket && !named.startsWith(file.ticket) ? `${file.ticket}: ${named}` : named, status: file.status, summary: file.summary };
			// A note kept beside the registries is a document, not a table of none.
			if (area === "registries" && file.rows === undefined && !file.problems) return { path, title: named, status: file.status, summary: file.summary };
			if (area === "registries") return { path, title: registryTitle(file.name), status: progress(file) };
			if (area === "knowledge") return { path, title: named, status: file.status, summary: file.summary, section: KNOWLEDGE.find((k) => k.id === file.kind)?.name ?? "Other" };
			return { path, title: named, status: file.status, summary: file.tickets?.length ? `For ${file.tickets.join(", ")}.${file.summary ? ` ${file.summary}` : ""}` : file.summary };
		});
}

/** The most lines of code a question or a decision takes with it: enough to say what it is about, not a copy of the file. */
export const CODE_LINES_KEPT = 40;

/**
 * The part of a question or a decision that says which code it is about: a
 * link to the lines, which opens them, and the lines as they were when it was
 * written. `link` is the way to the file from the document's folder.
 */
export function codeSection(code: { file: string; link: string; from: number; to: number; text: string; language: string; date: string }): string {
	const lines = code.text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
	const kept = lines.slice(0, CODE_LINES_KEPT);
	const where = code.from === code.to ? `line ${code.from}` : `lines ${code.from} to ${code.to}`;
	const anchor = code.from === code.to ? `#L${code.from}` : `#L${code.from}-L${code.to}`;
	// A fence longer than any run of backticks in the code, so the code cannot close it.
	const fence = "`".repeat(Math.max(3, ...(code.text.match(/`+/g) ?? []).map((run) => run.length + 1)));
	return `\n## In the code\n\n[${code.file}, ${where}](${code.link.split("/").map(encodeURIComponent).join("/")}${anchor}), as it was on ${code.date}:\n\n${fence}${code.language}\n${kept.join("\n")}\n${fence}\n${lines.length > kept.length ? `\nThe first ${kept.length} of ${lines.length} lines.\n` : ""}`;
}

/** The lines a link to code asks for: "#L12" or "#L12-L18". Null when the link names none. */
export function linkedLines(href: string): { line: number; endLine?: number } | null {
	const found = /#L(\d+)(?:-L?(\d+))?$/i.exec(href);
	if (!found) return null;
	const line = Number(found[1]);
	const endLine = found[2] ? Number(found[2]) : undefined;
	return line > 0 ? { line, ...(endLine && endLine >= line ? { endLine } : {}) } : null;
}

/**
 * The states a document of each kind is usually in, in the order it moves
 * through them: what a status is chosen from. Any other word can still be
 * written in the text.
 */
export function statusChoices(file: { group?: string; kind?: string } | undefined): string[] {
	if (file?.group === "tickets") return ["open", "in progress", "done", "blocked", "dropped"];
	if (file?.group === "specs") return ["draft", "ready", "in progress", "done", "superseded"];
	if (file?.group === "knowledge" && file.kind === "decisions") return ["proposed", "accepted", "superseded", "rejected"];
	if (file?.group === "knowledge" && file.kind === "questions") return ["open", "answered"];
	return ["draft", "in progress", "done"];
}

/**
 * Whether a document is one a filter is looking for: every word typed is in
 * its title, its name, its ticket's key, its state, what it is about, or the
 * tickets it is for. "open holiday" finds the open question about holidays.
 */
export function docMatches(file: Pick<DocFile, "name" | "title" | "ticket" | "status" | "summary" | "tickets" | "kind">, filter: string): boolean {
	const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const said = [file.title, file.name, file.ticket, file.status, file.summary, file.kind, ...(file.tickets ?? [])].filter(Boolean).join("\n").toLowerCase();
	return words.every((word) => said.includes(word));
}
