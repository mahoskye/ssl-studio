import { relativeTo } from "./paths";
import { isCatalog, toneOf, type Tone } from "./projectDocs";
import type { DocFile } from "./protocol";

// The Work list of the Docs panel (ADR 0012): the tickets with what was
// planned and spec'd for each under it, a ticket that is part of another
// under its parent, the work under way first and what is finished last. Read
// from the listing alone; the panel draws the rows.

export type WorkRow = { file: DocFile; kind: "ticket" | "plan" | "spec"; depth: number };
export type WorkList = {
	rows: WorkRow[];
	/** Tickets at the top of the list, with all under them, that are finished or set aside and were left out. */
	folded: number;
	/** Specs for no ticket in the folder. */
	loose: DocFile[];
};

/** As many finished tickets as are listed before the rest fold away behind a count. */
export const FINISHED_SHOWN = 3;

const ORDER: Record<Tone, number> = { active: 0, waiting: 1, done: 2, off: 3 };
const same = (a: string | undefined, b: string | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * The rows of the Work list. Under way comes first, then what waits, then
 * what is done or set aside; a ticket with something under way beneath it
 * counts as under way. Finished tickets beyond a few are left out unless
 * `all` asks for them, and counted.
 */
export function workList(files: readonly DocFile[], root: string | undefined | null, options: { all?: boolean } = {}): WorkList {
	const real = files.filter((file) => file.exists && !isCatalog(file));
	const tickets = real.filter((file) => file.group === "tickets");
	const specs = real.filter((file) => file.group === "specs");
	const plans = real.filter((file) => file.group === "plans");
	const rel = (path: string) => relativeTo(root, path).split("\\").join("/");
	const specsOf = (ticket: DocFile) => specs.filter((spec) => spec.tickets?.some((key) => same(key, ticket.ticket)) || ticket.specs?.some((path) => path === rel(spec.path)));
	const plansOf = (ticket: DocFile) => plans.filter((plan) => plan.tickets?.some((key) => same(key, ticket.ticket)));
	// A ticket is under its parent when the parent is in the folder, and is not its own ancestor.
	const parentOf = (ticket: DocFile) => tickets.find((other) => other !== ticket && same(other.ticket, ticket.parent));
	/** Whether a ticket is its own ancestor: one of a ring of tickets that name each other. A ticket under such a ring is not. */
	const loops = (ticket: DocFile) => {
		const seen = new Set<DocFile>();
		for (let up = parentOf(ticket); up && !seen.has(up); up = parentOf(up)) {
			if (up === ticket) return true;
			seen.add(up);
		}
		return false;
	};
	const childrenOf = (ticket: DocFile) => tickets.filter((other) => !loops(other) && parentOf(other) === ticket);
	const top = tickets.filter((ticket) => loops(ticket) || !parentOf(ticket));
	/** How far along a ticket is, with what is under it: the least finished of them. */
	const rank = (ticket: DocFile, depth = 0): number => Math.min(ORDER[toneOf(ticket.status)], ...(depth < 8 ? childrenOf(ticket).map((child) => rank(child, depth + 1)) : []));
	const byRank = (list: DocFile[]) => list.map((ticket, at) => ({ ticket, at, rank: rank(ticket) })).sort((a, b) => a.rank - b.rank || a.at - b.at);

	const rows: WorkRow[] = [];
	const add = (ticket: DocFile, depth: number) => {
		rows.push({ file: ticket, kind: "ticket", depth });
		for (const plan of plansOf(ticket)) rows.push({ file: plan, kind: "plan", depth: depth + 1 });
		for (const spec of specsOf(ticket)) rows.push({ file: spec, kind: "spec", depth: depth + 1 });
		if (depth < 8) for (const { ticket: child } of byRank(childrenOf(ticket))) add(child, depth + 1);
	};
	const ordered = byRank(top);
	const finished = ordered.filter((entry) => entry.rank >= ORDER.done);
	const fold = !options.all && finished.length > FINISHED_SHOWN;
	for (const entry of ordered) if (!fold || entry.rank < ORDER.done) add(entry.ticket, 0);
	return { rows, folded: fold ? finished.length : 0, loose: specs.filter((spec) => !tickets.some((ticket) => specsOf(ticket).includes(spec))) };
}

/** A row of the Work list as it is drawn: whether anything is under it, and whether that is shut away. */
export type ShownRow = WorkRow & { parent: boolean; shut: boolean };

/**
 * The rows as they are shown when some tickets are shut: what is under a
 * shut ticket, at any depth, is left out. Each row says whether it has
 * anything under it, so that it can offer to shut or open.
 */
export function shownRows(rows: readonly WorkRow[], shut: (row: WorkRow) => boolean): ShownRow[] {
	const out: ShownRow[] = [];
	/** The depth of the shut row whose rows are being passed over. */
	let under = Number.POSITIVE_INFINITY;
	rows.forEach((row, at) => {
		if (row.depth > under) return;
		under = Number.POSITIVE_INFINITY;
		const parent = (rows[at + 1]?.depth ?? 0) > row.depth;
		const isShut = parent && shut(row);
		if (isShut) under = row.depth;
		out.push({ ...row, parent, shut: isShut });
	});
	return out;
}
