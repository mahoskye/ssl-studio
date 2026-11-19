import { frontMatter } from "./frontMatter";
import { isCatalog, toneOf } from "./projectDocs";
import type { DocFile } from "./protocol";

// The work a question is about, for an agent that cannot read the folder
// (ADR 0012): the ticket, the tickets it is related to, what nobody has
// answered yet and what was already decided. Read from the documents' listing
// and their text, and kept short: a local model's context is small.

export type Work = {
	ticket: DocFile;
	/** The specs written for it. */
	specs: DocFile[];
	/** The tickets it names, and those that name it, that are in the folder. */
	related: DocFile[];
	/** Questions nobody has answered: for this ticket, for a ticket it is related to, or for no ticket. */
	open: DocFile[];
	/** Questions for this ticket that were answered. */
	answered: DocFile[];
	/** Decisions that stand: those made for this ticket first. A decision holds for the project, whichever ticket it was made for. */
	decisions: DocFile[];
};

const same = (a: string | undefined, b: string | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const slashes = (path: string) => path.split("\\").join("/");

/** The most decisions sent with a ticket: the ones for it first. */
export const DECISIONS_SENT = 12;

/** What bears on a ticket, among the project's documents. Null when the ticket is not in the folder. */
export function workFor(files: readonly DocFile[], key: string): Work | null {
	const real = files.filter((file) => file.exists && !isCatalog(file));
	const tickets = real.filter((file) => file.group === "tickets");
	const ticket = tickets.find((file) => same(file.ticket, key));
	if (!ticket) return null;
	const forIt = (file: DocFile) => Boolean(file.tickets?.some((named) => same(named, key)));
	const forNone = (file: DocFile) => !file.tickets?.length;
	const knowledge = (kind: string) => real.filter((file) => file.group === "knowledge" && file.kind === kind);
	const decided = knowledge("decisions").filter((file) => toneOf(file.status) === "done");
	const related = tickets.filter((file) => file !== ticket && (ticket.tickets?.some((named) => same(named, file.ticket)) || forIt(file)));
	const forRelated = (file: DocFile) => Boolean(file.tickets?.some((named) => related.some((other) => same(other.ticket, named))));
	return {
		ticket,
		specs: real.filter((file) => file.group === "specs" && (forIt(file) || ticket.specs?.some((path) => slashes(file.path).endsWith(`/${slashes(path)}`)))),
		related,
		open: knowledge("questions").filter((file) => toneOf(file.status) === "waiting" && (forIt(file) || forNone(file) || forRelated(file))),
		answered: knowledge("questions").filter((file) => toneOf(file.status) === "done" && forIt(file)),
		decisions: [...decided.filter(forIt), ...decided.filter((file) => !forIt(file))].slice(0, DECISIONS_SENT),
	};
}

/**
 * The ticket a document is about: its own key when it is a ticket, the first
 * ticket it says it is for otherwise. With no such document, the one ticket
 * that is under way, when there is exactly one. "" when it cannot be told.
 */
export function ticketAtHand(files: readonly DocFile[], path?: string | null): string {
	const real = files.filter((file) => file.exists && !isCatalog(file));
	const here = path ? real.find((file) => slashes(file.path).toLowerCase() === slashes(path).toLowerCase()) : undefined;
	if (here?.group === "tickets" && here.ticket) return here.ticket;
	if (here?.tickets?.length && here.group !== "tickets") return here.tickets[0]!;
	const underWay = real.filter((file) => file.group === "tickets" && file.ticket && file.status && toneOf(file.status) === "active");
	return underWay.length === 1 ? underWay[0]!.ticket! : "";
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What is sent, in a few words: "DEMO-103, 1 spec, 1 open question, 2 decisions". */
export function workLabel(work: Work, options: { specs?: boolean } = {}): string {
	return [
		work.ticket.ticket ?? work.ticket.name,
		options.specs !== false && work.specs.length ? count(work.specs.length, "spec") : "",
		work.related.length ? count(work.related.length, "related ticket") : "",
		work.open.length ? count(work.open.length, "open question") : "",
		work.answered.length ? count(work.answered.length, "answer") : "",
		work.decisions.length ? count(work.decisions.length, "decision") : "",
	]
		.filter(Boolean)
		.join(", ");
}

/** The longest a ticket's own words are sent, and a spec's, in characters. */
export const TICKET_CHARS = 3000;
export const SPEC_CHARS = 3000;
const ANSWER_CHARS = 400;

const cut = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, text.lastIndexOf(" ", limit))} … (cut short)`);
/** A document's own words: without its front matter and its first heading, which the line above it already says. */
const body = (text: string) => frontMatter(text).body.replace(/^\s*#\s+.*\r?\n/, "").trim();
/** One section of a document, by its heading: "Answer". */
const section = (text: string, heading: string) => new RegExp(`^#{1,6}\\s+${heading}\\s*$\\r?\\n([\\s\\S]*?)(?=^#{1,6}\\s|(?![\\s\\S]))`, "im").exec(text)?.[1]?.trim() ?? "";
const line = (file: DocFile) => `- ${file.ticket && !file.title?.startsWith(file.ticket) ? `${file.ticket}: ` : ""}${file.title || file.name}${file.status ? ` (${file.status})` : ""}${file.summary ? `. ${file.summary}` : ""}`;

/**
 * The work as text for a prompt. `read` gives a file's text, or null when it
 * cannot be read: the document is then said by its title alone. The specs are
 * left out for an agent that is about to write one.
 */
export async function workText(work: Work, readFile: (path: string) => Promise<string | null>, options: { specs?: boolean } = {}): Promise<string> {
	// A prompt has plain line ends, whichever the files are written with.
	const read = async (path: string) => (await readFile(path))?.replace(/\r\n/g, "\n") ?? null;
	const parts: string[] = ["THE WORK THIS IS FOR, from the project's own documents:"];
	const ticket = work.ticket;
	parts.push(`TICKET ${ticket.ticket}: ${ticket.title || ticket.name}${ticket.status ? ` (${ticket.status})` : ""}`);
	const asked = await read(ticket.path);
	if (asked !== null && body(asked)) parts.push(cut(body(asked), TICKET_CHARS));
	if (work.related.length) parts.push("", "RELATED TICKETS:", ...work.related.map(line));
	if (options.specs !== false) {
		for (const spec of work.specs) {
			const text = await read(spec.path);
			parts.push("", `SPEC ${spec.title || spec.name}${spec.status ? ` (${spec.status})` : ""}:`, text !== null && body(text) ? cut(body(text), SPEC_CHARS) : "(it could not be read)");
		}
	}
	if (work.open.length) parts.push("", "QUESTIONS NOBODY HAS ANSWERED YET (do not guess the answer; say what depends on it):", ...work.open.map(line));
	if (work.answered.length) {
		parts.push("", "QUESTIONS THAT WERE ANSWERED:");
		for (const question of work.answered) {
			const text = await read(question.path);
			const answer = text === null ? "" : section(text, "Answer");
			parts.push(`- ${question.title || question.name}${answer ? ` Answer: ${cut(answer.replace(/\s+/g, " "), ANSWER_CHARS)}` : ""}`);
		}
	}
	if (work.decisions.length) parts.push("", "DECISIONS ALREADY MADE (keep to them):", ...work.decisions.map(line));
	return parts.join("\n");
}

/** One kind of thing tied to a ticket, with the documents of that kind. */
export type WorkGroup = { kind: "plan" | "spec" | "ticket" | "question" | "answer" | "decision"; name: string; files: DocFile[] };

/**
 * Everything in the folder that is tied to a ticket, for the ticket's own
 * page: the plans drawn for it, the specs written for it, the tickets around
 * it, what is asked and not yet known, what was answered, and what was
 * decided for it. A decision made for another ticket still stands, and is
 * sent to an agent, but is not this ticket's work: it is not listed here.
 * Groups with nothing in them are left out.
 */
export function ticketWork(files: readonly DocFile[], key: string): WorkGroup[] {
	const work = workFor(files, key);
	if (!work) return [];
	const forIt = (file: DocFile) => Boolean(file.tickets?.some((named) => same(named, key)));
	const plans = files.filter((file) => file.exists && file.group === "plans" && forIt(file));
	const groups: WorkGroup[] = [
		{ kind: "plan", name: "Plans", files: plans },
		{ kind: "spec", name: "Specs", files: work.specs },
		{ kind: "ticket", name: "Related tickets", files: work.related },
		{ kind: "question", name: "Open questions", files: work.open.filter(forIt) },
		{ kind: "answer", name: "Answered", files: work.answered },
		{ kind: "decision", name: "Decisions", files: work.decisions.filter(forIt) },
	];
	return groups.filter((group) => group.files.length);
}
