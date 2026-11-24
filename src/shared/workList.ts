import { isCatalog, toneOf, type Tone } from "./projectDocs";
import type { DocFile } from "./protocol";
import { pathMatchesRef, workLinkOf, type WorkLink } from "./workContext";

// The Work list of the Docs panel (ADR 0012): the tickets with what was
// planned and spec'd for each under it, a ticket that is part of another
// under its parent, the work under way first and what is finished last. Read
// from the listing alone; the panel draws the rows.

export type WorkRow = { file: DocFile; kind: "ticket" | "plan" | "plan-doc" | "spec"; depth: number; link?: WorkLink; archived?: boolean };
export type WorkSort = "status" | "key" | "title";
export type WorkList = {
	rows: WorkRow[];
	/** Archived ticket rows (`tickets/archive/...`), kept separate from active work. */
	archived: WorkRow[];
	/** Tickets at the top of the list, with all under them, that are finished or set aside and were left out. */
	folded: number;
	/** Specs for no ticket in the folder. */
	loose: DocFile[];
};

/** True when a ticket lives under a `tickets/archive/` folder. */
export function isArchivedTicket(file: DocFile): boolean {
	if (file.group !== "tickets") return false;
	const norm = file.path.replace(/\\/g, "/").toLowerCase();
	const nameNorm = file.name.replace(/\\/g, "/").toLowerCase();
	return nameNorm.startsWith("archive/") || norm.includes("/tickets/archive/");
}

/** As many finished tickets as are listed before the rest fold away behind a count. */
export const FINISHED_SHOWN = 3;

const ORDER: Record<Tone, number> = { active: 0, waiting: 1, done: 2, off: 3 };
const same = (a: string | undefined, b: string | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * The rows of the Work list. Under way comes first, then what waits, then
 * what is done or set aside; a ticket with something under way beneath it
 * counts as under way. Finished tickets beyond a few are left out unless
 * `all` asks for them, and counted. Archived tickets live in `archived`.
 */
export function workList(files: readonly DocFile[], _root: string | undefined | null, options: { all?: boolean; sort?: WorkSort } = {}): WorkList {
	const real = files.filter((file) => file.exists && !isCatalog(file));
	const allTickets = real.filter((file) => file.group === "tickets");
	const tickets = allTickets.filter((file) => !isArchivedTicket(file));
	const archivedTickets = allTickets.filter(isArchivedTicket);
	const specs = real.filter((file) => file.group === "specs");
	const plans = real.filter((file) => file.group === "plans");
	const isPlanDoc = (file: DocFile) => /\.plan\.md$/i.test(file.name);
	const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();
	const planDocsByChart = new Map<string, DocFile>();
	for (const p of plans) {
		if (isPlanDoc(p)) planDocsByChart.set(normPath(p.path.replace(/\.plan\.md$/i, ".plan.json")), p);
	}
	const planCharts = plans.filter((file) => !isPlanDoc(file));
	const standalonePlanDocs = plans.filter((file) => isPlanDoc(file) && !planCharts.some((c) => normPath(c.path) === normPath(file.path.replace(/\.plan\.md$/i, ".plan.json"))));
	const specsOf = (ticket: DocFile) => specs.filter((spec) => spec.tickets?.some((key) => same(key, ticket.ticket)) || ticket.specs?.some((path) => pathMatchesRef(spec.path, path, ticket.path)));
	const plansOf = (ticket: DocFile) => {
		const matchedCharts = planCharts.filter((chart) => {
			const pairedDoc = planDocsByChart.get(normPath(chart.path));
			return (
				chart.tickets?.some((key) => same(key, ticket.ticket)) ||
				ticket.plans?.some((path) => pathMatchesRef(chart.path, path, ticket.path)) ||
				Boolean(
					pairedDoc &&
						(pairedDoc.tickets?.some((key) => same(key, ticket.ticket)) ||
							ticket.plans?.some((path) => pathMatchesRef(pairedDoc.path, path, ticket.path))),
				)
			);
		});
		const matchedStandalone = standalonePlanDocs.filter(
			(doc) => doc.tickets?.some((key) => same(key, ticket.ticket)) || ticket.plans?.some((path) => pathMatchesRef(doc.path, path, ticket.path)),
		);
		return { charts: matchedCharts, standalone: matchedStandalone };
	};
	// A ticket is under its parent when the parent is in the folder, and is not its own ancestor.
	const byKey = new Map<string, DocFile>();
	for (const t of tickets) if (t.ticket && !byKey.has(t.ticket.toLowerCase())) byKey.set(t.ticket.toLowerCase(), t);
	const parentOf = (ticket: DocFile) => {
		if (!ticket.parent) return undefined;
		const found = byKey.get(ticket.parent.toLowerCase());
		return found && found !== ticket ? found : undefined;
	};
	/** Whether a ticket is its own ancestor: one of a ring of tickets that name each other. A ticket under such a ring is not. */
	const loopsMemo = new Map<DocFile, boolean>();
	const loops = (ticket: DocFile): boolean => {
		const cached = loopsMemo.get(ticket);
		if (cached !== undefined) return cached;
		const seen = new Set<DocFile>();
		let res = false;
		for (let up = parentOf(ticket); up && !seen.has(up); up = parentOf(up)) {
			if (up === ticket) {
				res = true;
				break;
			}
			seen.add(up);
		}
		loopsMemo.set(ticket, res);
		return res;
	};
	const childrenMap = new Map<DocFile, DocFile[]>();
	const top: DocFile[] = [];
	for (const ticket of tickets) {
		const p = !loops(ticket) ? parentOf(ticket) : undefined;
		if (p) {
			const list = childrenMap.get(p) ?? [];
			list.push(ticket);
			childrenMap.set(p, list);
		} else top.push(ticket);
	}
	const childrenOf = (ticket: DocFile) => childrenMap.get(ticket) ?? [];
	const specsByTicket = new Map<DocFile, DocFile[]>();
	const attachedSpecs = new Set<DocFile>();
	for (const ticket of allTickets) {
		const list = specsOf(ticket);
		specsByTicket.set(ticket, list);
		for (const s of list) attachedSpecs.add(s);
	}
	const plansByTicket = new Map<DocFile, { charts: DocFile[]; standalone: DocFile[] }>();
	for (const ticket of allTickets) plansByTicket.set(ticket, plansOf(ticket));

	const rankMemo = new Map<DocFile, number>();
	/** How far along a ticket is, with what is under it: the least finished of them. */
	const rank = (ticket: DocFile, depth = 0): number => {
		const cached = rankMemo.get(ticket);
		if (cached !== undefined) return cached;
		let min = ORDER[toneOf(ticket.status)];
		if (depth < 8) {
			for (const child of childrenOf(ticket)) {
				const r = rank(child, depth + 1);
				if (r < min) min = r;
			}
		}
		rankMemo.set(ticket, min);
		return min;
	};
	const sortMode = options.sort ?? "status";
	const byOrder = (list: DocFile[]) =>
		list
			.map((ticket, at) => ({ ticket, at, rank: rank(ticket) }))
			.sort((a, b) => {
				if (sortMode === "key") {
					return (a.ticket.ticket ?? a.ticket.name).localeCompare(b.ticket.ticket ?? b.ticket.name, undefined, { numeric: true, sensitivity: "base" });
				}
				if (sortMode === "title") {
					return (a.ticket.title || a.ticket.ticket || a.ticket.name).localeCompare(b.ticket.title || b.ticket.ticket || b.ticket.name, undefined, { numeric: true, sensitivity: "base" });
				}
				return a.rank - b.rank || a.at - b.at;
			});

	const emitPlans = (target: WorkRow[], ticket: DocFile, depth: number, archivedFlag?: boolean) => {
		const found = plansByTicket.get(ticket);
		if (!found) return;
		for (const plan of found.charts) {
			target.push({ file: plan, kind: "plan", depth, link: workLinkOf(ticket, plan, "plan"), ...(archivedFlag ? { archived: true } : {}) });
			const pairedDoc = planDocsByChart.get(normPath(plan.path));
			if (pairedDoc) {
				target.push({ file: pairedDoc, kind: "plan-doc", depth: depth + 1, link: workLinkOf(ticket, pairedDoc, "plan"), ...(archivedFlag ? { archived: true } : {}) });
			}
		}
		for (const doc of found.standalone) {
			target.push({ file: doc, kind: "plan-doc", depth, link: workLinkOf(ticket, doc, "plan"), ...(archivedFlag ? { archived: true } : {}) });
		}
	};

	const rows: WorkRow[] = [];
	const add = (ticket: DocFile, depth: number, parentTicket?: DocFile) => {
		rows.push({ file: ticket, kind: "ticket", depth, ...(parentTicket ? { link: workLinkOf(parentTicket, ticket, "ticket") } : {}) });
		emitPlans(rows, ticket, depth + 1);
		for (const spec of specsByTicket.get(ticket) ?? []) rows.push({ file: spec, kind: "spec", depth: depth + 1, link: workLinkOf(ticket, spec, "spec") });
		if (depth < 8) for (const { ticket: child } of byOrder(childrenOf(ticket))) add(child, depth + 1, ticket);
	};
	const ordered = byOrder(top);
	const finished = ordered.filter((entry) => entry.rank >= ORDER.done);
	const fold = sortMode === "status" && !options.all && finished.length > FINISHED_SHOWN;
	for (const entry of ordered) if (!fold || entry.rank < ORDER.done) add(entry.ticket, 0);

	const archived: WorkRow[] = [];
	for (const ticket of archivedTickets) {
		archived.push({ file: ticket, kind: "ticket", depth: 0, archived: true });
		emitPlans(archived, ticket, 1, true);
		for (const spec of specsByTicket.get(ticket) ?? []) archived.push({ file: spec, kind: "spec", depth: 1, link: workLinkOf(ticket, spec, "spec"), archived: true });
	}
	return { rows, archived, folded: fold ? finished.length : 0, loose: specs.filter((spec) => !attachedSpecs.has(spec)) };
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
