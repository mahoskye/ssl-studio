import { parseCsv } from "./csv";
import { frontMatter } from "./frontMatter";
import { isCatalog, registryTitle, toneOf } from "./projectDocs";
import type { DocFile } from "./protocol";
import { keysIn, ticketColumn } from "./registryTickets";

// The work a question is about, for an agent that cannot read the folder
// (ADR 0012): the ticket, the tickets it is related to, what nobody has
// answered yet and what was already decided. Read from the documents' listing
// and their text, and kept short: a local model's context is small.

export type Work = {
	ticket: DocFile;
	/** Parent epic/ticket when `ticket.parent` resolves to a ticket in the folder. */
	parentEpic?: DocFile;
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
	/** Optional project-wide schema docs for opt-in context injection. */
	schemas?: DocFile[];
	/** Registries with rows mentioning this ticket. */
	registries?: DocFile[];
	/** Project `STATE.md` document if present. */
	stateDoc?: DocFile;
};

export type WorkTextOptions = {
	specs?: boolean;
	includeSchema?: boolean;
	includeRegistries?: boolean;
	includeState?: boolean;
	/** Specific files from the ticket folder (`{ path, rel }`) whose full text should be attached. */
	ticketFiles?: { path: string; rel: string }[];
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
	const parentEpic = ticket.parent ? tickets.find((file) => same(file.ticket, ticket.parent)) : undefined;
	const forIt = (file: DocFile) => Boolean(file.tickets?.some((named) => same(named, key)));
	const forNone = (file: DocFile) => !file.tickets?.length;
	const knowledge = (kind: string) => real.filter((file) => file.group === "knowledge" && file.kind === kind);
	const decided = knowledge("decisions").filter((file) => toneOf(file.status) === "done");
	const related = tickets.filter(
		(file) =>
			file !== ticket &&
			(ticket.tickets?.some((named) => same(named, file.ticket)) ||
				forIt(file) ||
				same(file.parent, key) ||
				same(ticket.parent, file.ticket)),
	);
	const forRelated = (file: DocFile) => Boolean(file.tickets?.some((named) => related.some((other) => same(other.ticket, named))));
	const schemas = real.filter((file) => file.group === "schema");
	const registries = real.filter((file) => file.group === "registries" && forIt(file));
	const stateDoc = real.find((file) => file.group === "project" && /^state\.md$/i.test(file.name));
	return {
		ticket,
		parentEpic,
		specs: real.filter((file) => file.group === "specs" && (forIt(file) || Boolean(ticket.specs?.some((path) => pathMatchesRef(file.path, path))))),
		related,
		open: knowledge("questions").filter((file) => toneOf(file.status) === "waiting" && (forIt(file) || forNone(file) || forRelated(file))),
		answered: knowledge("questions").filter((file) => toneOf(file.status) === "done" && forIt(file)),
		decisions: [...decided.filter(forIt), ...decided.filter((file) => !forIt(file))].slice(0, DECISIONS_SENT),
		schemas,
		registries,
		stateDoc,
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
	// A registry names the ticket of each row: it is not about the first of them.
	if (here?.tickets?.length && here.group !== "tickets" && here.group !== "registries") return here.tickets[0]!;
	const underWay = real.filter((file) => file.group === "tickets" && file.ticket && file.status && toneOf(file.status) === "active");
	return underWay.length === 1 ? underWay[0]!.ticket! : "";
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What is sent, in a few words: "DEMO-103, 1 spec, 1 open question, 2 decisions". */
export function workLabel(work: Work, options: WorkTextOptions = {}): string {
	return [
		work.ticket.ticket ?? work.ticket.name,
		options.specs !== false && work.specs.length ? count(work.specs.length, "spec") : "",
		work.related.length ? count(work.related.length, "related ticket") : "",
		work.open.length ? count(work.open.length, "open question") : "",
		work.answered.length ? count(work.answered.length, "answer") : "",
		work.decisions.length ? count(work.decisions.length, "decision") : "",
		options.includeSchema && work.schemas?.length ? "schema" : "",
		options.includeRegistries && work.registries?.length ? count(work.registries.length, "registry", "registries") : "",
		options.includeState && work.stateDoc ? "STATE.md" : "",
		options.ticketFiles?.length ? count(options.ticketFiles.length, "ticket file") : "",
	]
		.filter(Boolean)
		.join(", ");
}

/** The longest a ticket's own words are sent, and a spec's, in characters. */
export const TICKET_CHARS = 3000;
export const SPEC_CHARS = 3000;
const ANSWER_CHARS = 400;
const EXTRA_FILE_CHARS = 3500;
/** Hard upper character cap across the whole assembled work context so local Ollama models never OOM. */
export const MAX_WORK_PROMPT_CHARS = 18_000;

export function cut(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const spaceAt = text.lastIndexOf(" ", limit);
	// Never let lastIndexOf return -1 (spaceless minified JSON/XML/HL7) and slice(0, -1) the entire file!
	const end = spaceAt > limit * 0.5 ? spaceAt : limit;
	return `${text.slice(0, end)} … (cut short)`;
}
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
export async function workText(work: Work, readFile: (path: string) => Promise<string | null>, options: WorkTextOptions = {}): Promise<string> {
	// A prompt has plain line ends, whichever the files are written with.
	const read = async (path: string) => (await readFile(path))?.replace(/\r\n/g, "\n") ?? null;
	const parts: string[] = ["THE WORK THIS IS FOR, from the project's own documents:"];
	const ticket = work.ticket;
	parts.push(`TICKET ${ticket.ticket}: ${ticket.title || ticket.name}${ticket.status ? ` (${ticket.status})` : ""}`);
	const asked = await read(ticket.path);
	if (asked !== null && body(asked)) parts.push(cut(body(asked), TICKET_CHARS));
	if (work.parentEpic) {
		const epicBody = await read(work.parentEpic.path);
		parts.push(
			"",
			`PARENT EPIC ${work.parentEpic.ticket}: ${work.parentEpic.title || work.parentEpic.name}${work.parentEpic.status ? ` (${work.parentEpic.status})` : ""}`,
			...(epicBody !== null && body(epicBody) ? [cut(body(epicBody), 1200)] : []),
		);
	}
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
	if (options.includeState && work.stateDoc) {
		const st = await read(work.stateDoc.path);
		if (st !== null && body(st)) parts.push("", "PROJECT STATE (STATE.md):", cut(body(st), 1500));
	}
	if (options.includeSchema && work.schemas?.length) {
		const shown = work.schemas.slice(0, 25);
		const extraSchemas = work.schemas.length - shown.length;
		parts.push(
			"",
			"PROJECT SCHEMA (summary):",
			...shown.map(line),
			...(extraSchemas > 0 ? [`- … and ${extraSchemas} more schema docs`] : []),
		);
	}
	if (options.includeRegistries && work.registries?.length && ticket.ticket) {
		const ticketLower = ticket.ticket.toLowerCase();
		const knownSet = new Set([ticketLower]);
		for (const reg of work.registries) {
			const csvText = await read(reg.path);
			if (!csvText) continue;
			const parsed = parseCsv(csvText);
			const tCol = ticketColumn(parsed);
			if (tCol < 0) continue;
			const matched = parsed.rows.filter((cells) =>
				keysIn(cells[tCol]?.text ?? "", knownSet).some((k) => k.toLowerCase() === ticketLower),
			);
			if (!matched.length) continue;
			const headers = parsed.header.map((c) => c.text.trim());
			parts.push(
				"",
				`REGISTRY ${registryTitle(reg.name)} (rows for ${ticket.ticket}):`,
				headers.join(" | "),
				...matched.slice(0, 15).map((r) => headers.map((_, i) => (r[i]?.text ?? "").replace(/\s+/g, " ")).join(" | ")),
				...(matched.length > 15 ? [`… and ${matched.length - 15} more rows`] : []),
			);
		}
	}
	if (options.ticketFiles?.length) {
		for (const tf of options.ticketFiles) {
			const content = await read(tf.path);
			if (content !== null) {
				parts.push("", `ATTACHED TICKET FILE ${tf.rel}:`, cut(content, EXTRA_FILE_CHARS));
			}
		}
	}
	if (ticket.ticketFiles?.length) {
		const shown = ticket.ticketFiles.slice(0, 25);
		const total = ticket.ticketFileCount ?? ticket.ticketFiles.length;
		const more = Math.max(0, total - shown.length);
		parts.push(
			"",
			"TICKET FOLDER FILES (reference docs, code samples, and fixtures kept beside this ticket):",
			...shown.map((f) => `- ${f.rel}`),
			...(more > 0 ? [`- … and ${more} more`] : []),
		);
	}
	const assembled = parts.join("\n");
	return assembled.length <= MAX_WORK_PROMPT_CHARS ? assembled : cut(assembled, MAX_WORK_PROMPT_CHARS);
}

/** Explains how a document or related ticket is associated with a ticket. */
export type WorkLink = {
	/** Short inline label shown on the ticket page (e.g. `ticket specs:`, `plan "ticket": "DEMO-101"`). */
	reason: string;
	/** Plain-English hover explanation showing the exact file/field so the pattern can be replicated. */
	detail: string;
};

/** One document linked to a ticket, paired with how it got associated. */
export type WorkItem = { file: DocFile; reason: string; detail: string };

/** One kind of thing tied to a ticket, with the documents of that kind. */
export type WorkGroup = {
	kind: "plan" | "spec" | "subticket" | "ticket" | "question" | "answer" | "decision" | "reference" | "schema" | "registry";
	name: string;
	files: DocFile[];
	items: WorkItem[];
};

const pathMatchesRef = (filePath: string, ref: string) => {
	const full = slashes(filePath).toLowerCase();
	const clean = slashes(ref).replace(/^\.\//, "").toLowerCase();
	return full === clean || full.endsWith(`/${clean}`);
};

/** Explains how `file` is associated with `ticket`, directly from the project's document metadata. */
export function workLinkOf(ticket: DocFile, file: DocFile, kind: WorkGroup["kind"]): WorkLink {
	const key = ticket.ticket ?? ticket.name;
	if (kind === "plan") {
		const inPlanJson = Boolean(file.tickets?.some((named) => same(named, key)));
		const inTicketPlans = Boolean(ticket.plans?.some((ref) => pathMatchesRef(file.path, ref)));
		if (inPlanJson && inTicketPlans) {
			return {
				reason: `plan "ticket" · ticket plans:`,
				detail: `Linked both by "ticket": "${key}" inside ${file.name} and by plans: in ${ticket.name}.`,
			};
		}
		if (inTicketPlans) {
			return {
				reason: "ticket plans:",
				detail: `Listed under plans: in ${ticket.name}'s YAML frontmatter.`,
			};
		}
		return {
			reason: `plan "ticket": "${key}"`,
			detail: `Linked by "ticket": "${key}" inside ${file.name} (editable in the Plan panel's Ticket field, or via plans: on this ticket).`,
		};
	}

	if (kind === "spec") {
		const inTicketSpecs = Boolean(ticket.specs?.some((ref) => pathMatchesRef(file.path, ref)));
		const own = file.ownTickets ?? (file.pairedPlan ? [] : (file.tickets ?? []));
		const inSpecFm = own.some((named) => same(named, key));
		const viaPlan = Boolean(file.pairedPlan && same(file.pairedPlan.ticket, key));
		const reasons: string[] = [];
		const details: string[] = [];
		if (inTicketSpecs) {
			reasons.push("ticket specs:");
			details.push(`Listed under specs: in ${ticket.name}'s YAML frontmatter`);
		}
		if (inSpecFm) {
			reasons.push(`spec ticket: ${key}`);
			details.push(`Declares ticket: ${key} in ${file.name}'s YAML frontmatter`);
		}
		if (viaPlan && file.pairedPlan) {
			const planStem = file.pairedPlan.name.replace(/\.plan\.json$/i, "");
			reasons.push(`paired with ${planStem}`);
			details.push(`Companion .spec.md beside ${file.pairedPlan.name} ("ticket": "${key}")`);
		}
		if (!reasons.length) {
			reasons.push(`ticket: ${key}`);
			details.push(`Associated with ${key}.`);
		}
		return { reason: reasons.join(" · "), detail: `${details.join("; ")}.` };
	}

	if (kind === "ticket" || kind === "subticket") {
		const otherKey = file.ticket ?? file.name;
		if (same(file.parent, key)) {
			return {
				reason: `sub-ticket (parent: ${key})`,
				detail: `${otherKey} declares parent: ${key} in its frontmatter, nesting it under ${key} in the Work list.`,
			};
		}
		if (same(ticket.parent, otherKey)) {
			return {
				reason: `parent ticket`,
				detail: `${key} declares parent: ${otherKey} in its frontmatter.`,
			};
		}
		const thisNamesOther = Boolean(ticket.tickets?.some((named) => same(named, otherKey)));
		const otherNamesThis = Boolean(file.tickets?.some((named) => same(named, key)));
		if (thisNamesOther && otherNamesThis) {
			return {
				reason: "related: (both)",
				detail: `${key} and ${otherKey} both name each other in their frontmatter.`,
			};
		}
		if (thisNamesOther) {
			return {
				reason: "ticket related:",
				detail: `Listed under related: / blocks: in ${ticket.name}'s YAML frontmatter.`,
			};
		}
		return {
			reason: `${otherKey} names ${key}`,
			detail: `${otherKey} lists ${key} in its related: / blocks: frontmatter.`,
		};
	}

	if (kind === "registry") {
		return {
			reason: "Ticket column",
			detail: `Rows in ${file.name} list ${key} in their Ticket column.`,
		};
	}

	return {
		reason: `doc ticket: ${key}`,
		detail: `${file.name} declares ticket: ${key} (or tickets: [${key}, ...]) in its YAML frontmatter.`,
	};
}

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
	const real = files.filter((file) => file.exists && !isCatalog(file));
	const forIt = (file: DocFile) => Boolean(file.tickets?.some((named) => same(named, key)));
	const plans = real.filter(
		(file) =>
			file.group === "plans" &&
			(forIt(file) || Boolean(work.ticket.plans?.some((ref) => pathMatchesRef(file.path, ref)))),
	);
	const subtickets = work.related.filter((file) => same(file.parent, key));
	const related = work.related.filter((file) => !same(file.parent, key));
	// UI lists EVERY decision, question, reference note, and schema linked to this ticket
	// (no `done`-only filter or LLM 12-item budget cap that would hide `proposed` ADRs or active questions).
	const allQuestions = real.filter((file) => file.group === "knowledge" && file.kind === "questions" && forIt(file));
	const answered = allQuestions.filter((file) => toneOf(file.status) === "done");
	const openQuestions = allQuestions.filter((file) => toneOf(file.status) !== "done" && toneOf(file.status) !== "off");
	const decisions = real.filter((file) => file.group === "knowledge" && file.kind === "decisions" && forIt(file));
	const references = real.filter(
		(file) => file.group === "knowledge" && file.kind !== "decisions" && file.kind !== "questions" && forIt(file),
	);
	const schemas = real.filter((file) => file.group === "schema" && forIt(file));
	const make = (kind: WorkGroup["kind"], name: string, groupFiles: DocFile[]): WorkGroup => ({
		kind,
		name,
		files: groupFiles,
		items: groupFiles.map((file) => ({ file, ...workLinkOf(work.ticket, file, kind) })),
	});
	const groups: WorkGroup[] = [
		make("plan", "Plans", plans),
		make("spec", "Specs", work.specs),
		make("subticket", "Sub-tickets", subtickets),
		make("ticket", "Related tickets", related),
		make("question", "Open questions", openQuestions),
		make("answer", "Answered", answered),
		make("decision", "Decisions", decisions),
		make("reference", "Notes & snippets", references),
		make("schema", "Schema", schemas),
		// Linked CSV registries with rows mentioning this ticket in their Ticket column.
		make(
			"registry",
			"Registries",
			real.filter((file) => file.group === "registries" && forIt(file)),
		),
	];
	return groups.filter((group) => group.files.length);
}

/**
 * Cycle-safe BFS of every descendant ticket nested under `key` via `parent:`
 * (direct sub-tickets, grandchildren, etc.) so epic rollups, readiness gates,
 * and deployment manifests cover the entire hierarchy.
 */
export function descendantTickets(files: readonly DocFile[], key: string): DocFile[] {
	const rootKey = key.trim().toLowerCase();
	if (!rootKey) return [];
	const tickets = files.filter((f) => f.exists && !isCatalog(f) && f.group === "tickets" && f.ticket);
	const seen = new Set<string>([rootKey]);
	const queue = [rootKey];
	const out: DocFile[] = [];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const t of tickets) {
			if (!t.parent || t.parent.toLowerCase() !== cur) continue;
			const k = t.ticket!.toLowerCase();
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(t);
			queue.push(k);
		}
	}
	return out;
}

/** For a non-ticket document (spec, plan, decision, question), returns every ticket linked to it and why. */
export function docLinkedTickets(
	files: readonly DocFile[],
	docPath: string,
): { ticket: DocFile; key: string; reason: string; detail: string }[] {
	const clean = slashes(docPath).toLowerCase();
	const real = files.filter((file) => file.exists && !isCatalog(file));
	const tickets = real.filter((file) => file.group === "tickets" && file.ticket);
	const doc = real.find((file) => slashes(file.path).toLowerCase() === clean);
	if (!doc) {
		// Companion Markdown notes inside a ticket bundle folder link straight back to their ticket (ADR 0030).
		const owners: { ticket: DocFile; key: string; reason: string; detail: string }[] = [];
		for (const t of tickets) {
			if (!t.ticketFolder) continue;
			const folder = slashes(t.ticketFolder).toLowerCase().replace(/\/+$/, "");
			if (clean !== slashes(t.path).toLowerCase() && clean.startsWith(`${folder}/`)) {
				owners.push({
					ticket: t,
					key: t.ticket!,
					reason: "in ticket folder",
					detail: `Kept inside ${t.ticket!}'s ticket folder.`,
				});
			}
		}
		return owners;
	}
	if (doc.group === "tickets") return [];
	const kind: WorkGroup["kind"] | null =
		doc.group === "plans"
			? "plan"
			: doc.group === "specs"
				? "spec"
				: doc.group === "registries"
					? "registry"
					: doc.group === "schema"
						? "schema"
						: doc.group === "knowledge"
							? doc.kind === "decisions"
								? "decision"
								: doc.kind === "questions"
									? "question"
									: "reference"
							: null;
	if (!kind) return [];
	const out: { ticket: DocFile; key: string; reason: string; detail: string }[] = [];
	for (const t of tickets) {
		const key = t.ticket!;
		const linked =
			kind === "spec"
				? Boolean(doc.tickets?.some((k) => same(k, key)) || t.specs?.some((ref) => pathMatchesRef(doc.path, ref)))
				: kind === "plan"
					? Boolean(doc.tickets?.some((k) => same(k, key)) || t.plans?.some((ref) => pathMatchesRef(doc.path, ref)))
					: Boolean(doc.tickets?.some((k) => same(k, key)));
		if (linked) {
			out.push({ ticket: t, key, ...workLinkOf(t, doc, kind) });
		}
	}
	return out;
}

// --- Unified Code <-> Plan <-> Spec <-> Ticket <-> Registry Traceability -----

export type GoverningDoc = {
	file: DocFile;
	reason: string;
	line?: number;
};

const stripExt = (p: string) => p.replace(/\.[^./\\]+$/, "");
const relFromRoot = (filePath: string, root?: string | null) => {
	const full = slashes(filePath).replace(/^\/+/, "");
	if (!root) return full;
	const top = slashes(root).replace(/^\/+/, "").replace(/\/+$/, "");
	return full.toLowerCase().startsWith(`${top.toLowerCase()}/`) ? full.slice(top.length + 1) : full;
};

/**
 * True when a workspace code/SQL file (`filePath`) matches a reference (`ref`) written as:
 * - workspace-relative path (`src/DueDates/SetSampleDueDates.ssl`),
 * - `/` path suffix (`DueDates/SetSampleDueDates.ssl`),
 * - STARLIMS dotted module name (`DueDates.DueDateConstants`, `DueDates.Holidays`), or
 * - bare script stem (`SetSampleDueDates`).
 */
export function codeMatchesRef(filePath: string, ref: string, root?: string | null): boolean {
	const clean = slashes(ref).trim().replace(/^\/+/, "").replace(/^\.\//, "").toLowerCase();
	if (!clean) return false;
	const full = slashes(filePath).toLowerCase();
	const rel = relFromRoot(filePath, root).toLowerCase();
	if (rel === clean || full === clean || rel.endsWith(`/${clean}`) || full.endsWith(`/${clean}`)) return true;

	const base = rel.slice(rel.lastIndexOf("/") + 1);
	const stem = stripExt(base);
	const relNoExt = stripExt(rel);

	// Extensionless slash path (e.g. `DueDates/WorkCalendar` -> `src/DueDates/WorkCalendar.ssl`).
	if (clean.includes("/")) {
		if (relNoExt === clean || relNoExt.endsWith(`/${clean}`)) return true;
		// When the reference explicitly includes a folder path, NEVER fall back to bare basename matching across other folders.
		return false;
	}
	if (clean === base) return true;
	if (!clean.includes(".")) {
		return clean === stem;
	}
	// STARLIMS dotted module or 3-part procedure name (`DueDates.DueDateConstants`, `DueDates.DueDateSummary.Combine`).
	if (!/\.(ssl|srvscr|ds|sql|ddl|pks|pkb|xfd|xml|hl7|astm|md|markdown|json|csv|tsv|ya?ml|toml|txt|html?|css|tsx?|jsx?)$/i.test(clean)) {
		const segments = clean.split(".").filter(Boolean);
		const dottedAsPath = segments.join("/");
		if (relNoExt === dottedAsPath || relNoExt.endsWith(`/${dottedAsPath}`)) return true;
		// 3-part `Category.Script.Procedure`: strip trailing `.Procedure` and match `Category/Script`.
		if (segments.length >= 3) {
			const parentPath = segments.slice(0, -1).join("/");
			if (relNoExt === parentPath || relNoExt.endsWith(`/${parentPath}`)) return true;
		}
	}
	return false;
}

const GOV_RANK: Record<string, number> = {
	plans: 0,
	specs: 1,
	tickets: 2,
	knowledge: 3,
	schema: 4,
	docs: 5,
	registries: 6,
	project: 7,
};

/**
 * Unified reverse-traceability lookup: returns every governing Plan, Spec, Ticket,
 * Decision/Question, Schema doc, and CSV Registry that covers `filePath` (an SSL script,
 * Data Source, SQL DDL, or any workspace file). Demotes/hides `INDEX.md` catalogs when
 * real governing documents exist.
 */
export function docsGoverningFile(
	files: readonly DocFile[],
	filePath: string,
	root?: string | null,
	incomingLinks: readonly { path: string; line?: number }[] = [],
): GoverningDoc[] {
	if (!filePath) return [];
	const targetCanon = slashes(filePath).toLowerCase();
	const existing = files.filter((f) => f.exists);
	const byPath = new Map(existing.map((f) => [slashes(f.path).toLowerCase(), f]));
	const tickets = existing.filter((f) => f.group === "tickets" && !isCatalog(f) && f.ticket);

	const hits = new Map<string, GoverningDoc>();
	const add = (file: DocFile, reason: string, line?: number) => {
		const key = slashes(file.path).toLowerCase();
		if (key === targetCanon) return;
		const prev = hits.get(key);
		if (!prev) {
			hits.set(key, { file, reason, ...(line ? { line } : {}) });
		} else if (!prev.line && line) {
			prev.line = line;
		}
	};

	// 1. Direct code/SQL references (`plan.targets`, `built.units`, Markdown links/backticks, `source:`, CSV registries).
	const matchedPlans: DocFile[] = [];
	const matchedSpecs: DocFile[] = [];
	const matchedRegistries: DocFile[] = [];
	for (const file of existing) {
		if (slashes(file.path).toLowerCase() === targetCanon) continue;
		if (file.source && codeMatchesRef(filePath, file.source, root)) {
			add(file, file.group === "schema" ? "schema source:" : "source:");
			continue;
		}
		if (file.codeRefs?.some((ref) => codeMatchesRef(filePath, ref, root))) {
			const reason =
				file.group === "plans"
					? "plan target"
					: file.group === "registries"
						? "registry entry"
						: file.group === "specs"
							? "spec reference"
							: "mentions script";
			add(file, reason);
			if (file.group === "plans") matchedPlans.push(file);
			if (file.group === "specs") matchedSpecs.push(file);
			if (file.group === "registries") matchedRegistries.push(file);
		}
		if (file.group === "tickets" && file.ticketFolder) {
			const folder = slashes(file.ticketFolder).toLowerCase().replace(/\/+$/, "");
			if (targetCanon.startsWith(`${folder}/`)) {
				add(file, "ticket folder");
			}
		}
	}

	// 2. Direct incoming Markdown links (`backend.linksTo(filePath)`).
	for (const link of incomingLinks) {
		const doc = byPath.get(slashes(link.path).toLowerCase());
		if (!doc) continue;
		add(doc, "links here", link.line);
		if (doc.group === "plans" && !matchedPlans.includes(doc)) matchedPlans.push(doc);
		if (doc.group === "specs" && !matchedSpecs.includes(doc)) matchedSpecs.push(doc);
	}

	// 3. Transitive links: matched plans -> paired specs & owning tickets; matched specs & registries -> owning tickets.
	const linkedTicketKeys = new Set<string>();
	for (const plan of matchedPlans) {
		for (const k of plan.tickets ?? []) linkedTicketKeys.add(k.toLowerCase());
		const specPath = plan.path.replace(/\.plan\.json$/i, ".spec.md").toLowerCase();
		const pairedSpec = byPath.get(slashes(specPath));
		if (pairedSpec) {
			add(pairedSpec, "paired spec");
			if (!matchedSpecs.includes(pairedSpec)) matchedSpecs.push(pairedSpec);
		}
		for (const t of tickets) {
			if (t.plans?.some((ref) => pathMatchesRef(plan.path, ref))) {
				linkedTicketKeys.add(t.ticket!.toLowerCase());
			}
		}
	}
	for (const spec of matchedSpecs) {
		for (const k of spec.tickets ?? []) linkedTicketKeys.add(k.toLowerCase());
		for (const t of tickets) {
			if (t.specs?.some((ref) => pathMatchesRef(spec.path, ref))) {
				linkedTicketKeys.add(t.ticket!.toLowerCase());
			}
		}
	}
	for (const reg of matchedRegistries) {
		if (!reg.ticketCodeRefs) continue;
		for (const [k, scripts] of Object.entries(reg.ticketCodeRefs)) {
			if (scripts.some((s) => codeMatchesRef(filePath, s, root))) linkedTicketKeys.add(k.toLowerCase());
		}
	}
	for (const t of tickets) {
		if (linkedTicketKeys.has(t.ticket!.toLowerCase())) {
			add(t, "governing ticket");
		}
	}

	const all = [...hits.values()];
	const isManifestOnly = (item: GoverningDoc) =>
		item.file.group === "registries" && /^files\.(csv|tsv)$/i.test(item.file.name);
	// Hide INDEX.md catalogs when real governing documents exist; also suppress bare `files.csv` manifest noise when it is the sole non-substantive hit.
	const substantive = all.filter((item) => !isCatalog(item.file) && !isManifestOnly(item));
	const nonCatalog = all.filter((item) => !isCatalog(item.file));
	const chosen = substantive.length ? substantive : nonCatalog.length && !nonCatalog.every(isManifestOnly) ? nonCatalog : [];
	return chosen.sort(
		(a, b) =>
			(GOV_RANK[a.file.group] ?? 9) - (GOV_RANK[b.file.group] ?? 9) ||
			a.file.name.localeCompare(b.file.name, undefined, { sensitivity: "base" }),
	);
}

/**
 * Returns every script/code reference tied to a ticket across its plans, specs,
 * ticket body, linked notes/decisions/questions, and CSV registry rows.
 */
export function scriptsForTicket(files: readonly DocFile[], key: string): string[] {
	const groups = ticketWork(files, key);
	const work = workFor(files, key);
	if (!work) return [];
	const refs = new Set<string>();
	const addRefs = (list?: readonly string[]) => {
		for (const ref of list ?? []) {
			const clean = ref.trim();
			if (clean) refs.add(clean);
		}
	};
	addRefs(work.ticket.codeRefs);
	for (const group of groups) {
		if (group.kind === "registry") {
			for (const reg of group.files) {
				addRefs(reg.ticketCodeRefs?.[key.toLowerCase()]);
			}
		} else {
			for (const doc of group.files) addRefs(doc.codeRefs);
		}
	}
	return [...refs];
}

/**
 * Returns the specific ticket governing `filePath` (whether `filePath` is a Markdown doc,
 * a ticket bundle companion file, a plan, or a code/SQL script governed by a plan/spec/ticket).
 * Unlike `ticketAtHand()`, NEVER blindly falls back to an unrelated active ticket when `filePath`
 * has no association with any ticket!
 */
/**
 * Returns ALL ticket keys governing `filePath` (active tickets first), for multi-ticket
 * commit-prefix chips in Git and traceability views.
 */
export function ticketsForFile(
	files: readonly DocFile[],
	filePath?: string | null,
	root?: string | null,
	incomingLinks: readonly { path: string; line?: number }[] = [],
): string[] {
	if (!filePath) return [];
	const real = files.filter((f) => f.exists && !isCatalog(f));
	const clean = slashes(filePath).toLowerCase();
	const here = real.find((f) => slashes(f.path).toLowerCase() === clean);
	if (here) {
		if (here.group === "tickets" && here.ticket) return [here.ticket];
		if (here.group !== "registries" && here.tickets?.length) return [...here.tickets];
		return [];
	}
	const owner = real.find(
		(f) => f.group === "tickets" && f.ticket && f.ticketFolder && clean.startsWith(`${slashes(f.ticketFolder).toLowerCase().replace(/\/+$/, "")}/`),
	);
	if (owner?.ticket) return [owner.ticket];

	const gov = docsGoverningFile(files, filePath, root, incomingLinks);
	const tickets = real.filter((f) => f.group === "tickets" && f.ticket);
	const byKey = new Map(tickets.map((t) => [t.ticket!.toLowerCase(), t]));
	const candidates: DocFile[] = [];
	const seen = new Set<string>();
	const pushKey = (k: string) => {
		const kl = k.toLowerCase();
		if (seen.has(kl)) return;
		const t = byKey.get(kl);
		if (t) {
			seen.add(kl);
			candidates.push(t);
		}
	};
	for (const g of gov) {
		if (g.file.group === "tickets" && g.file.ticket) pushKey(g.file.ticket);
		else if (g.file.group === "plans" || g.file.group === "specs") {
			for (const k of g.file.tickets ?? []) pushKey(k);
		} else if (g.file.group === "registries" && g.file.ticketCodeRefs) {
			for (const [k, scripts] of Object.entries(g.file.ticketCodeRefs)) {
				if (scripts.some((s) => codeMatchesRef(filePath, s, root))) pushKey(k);
			}
		}
	}
	candidates.sort((a, b) => {
		const aActive = toneOf(a.status) === "active" ? 0 : 1;
		const bActive = toneOf(b.status) === "active" ? 0 : 1;
		return aActive - bActive || (a.ticket ?? "").localeCompare(b.ticket ?? "", undefined, { numeric: true });
	});
	return candidates.map((t) => t.ticket!);
}

export function ticketForFile(
	files: readonly DocFile[],
	filePath?: string | null,
	root?: string | null,
	incomingLinks: readonly { path: string; line?: number }[] = [],
): string {
	return ticketsForFile(files, filePath, root, incomingLinks)[0] ?? "";
}
