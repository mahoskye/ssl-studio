import { CATALOG_FILE } from "./catalog";
import { linkFile, type LinkEdit } from "./docLinks";
import { headingAnchor } from "./docTables";
import { documentHeadings } from "./markdownEdit";
import { dirName, resolvePath } from "./paths";
import { CATALOG_AREAS, DOC_FOLDERS, isCatalog, isFileArea, registryTitle, toneOf, type CatalogArea } from "./projectDocs";
import type { DocFile } from "./protocol";
import { pathMatchesRef } from "./workContext";

// What the documents of the work need from someone (ADR 0012): a catalog
// that no longer says what its folder holds, a registry that does not read as
// a table, a document nobody has written yet, a ticket or a spec that names
// something that is not there. Read from the listing alone, so it costs
// nothing to ask again.

/** A broken `[[wikilink]]` to rewrite: where it stands, its current name, and the suggested replacement name. */
export type WikiLinkMend = { line: number; column: number; name: string; href: string; instead: string };

export type DocCheckFix =
	| { kind: "catalogs" }
	| { kind: "ticket"; key: string; related?: string }
	| { kind: "links"; mends: LinkMend[] }
	| { kind: "mend-wikilinks"; mends: WikiLinkMend[] }
	| { kind: "reciprocal-adr"; path: string; field: "supersedes" | "superseded-by"; value: string }
	| { kind: "record-approval"; path: string };

export type DocCheck = {
	/** "warn" is something wrong; "note" is something to know and perhaps act on. */
	level: "warn" | "note";
	text: string;
	/** The document to open. */
	path: string;
	/** The line of it to go to, where the check is about one place. */
	line?: number;
	/**
	 * What would put it right, where the IDE can: write the catalogs afresh, start the ticket of this key, point
	 * broken path links or wikilinks at a matching file, add a reciprocal ADR link, or record controlled-doc approval.
	 */
	fix?: DocCheckFix;
};

/** A link to rewrite: where it is, as written, and the file to name in its place. */
export type LinkMend = LinkEdit;

/** A catalogued folder as a check names it: the schema folder is the project's own, wherever it lies. */
const FOLDER_SAID: Record<CatalogArea, string> = { tickets: `${DOC_FOLDERS.tickets}/`, specs: `${DOC_FOLDERS.specs}/`, knowledge: `${DOC_FOLDERS.knowledge}/`, registries: `${DOC_FOLDERS.registries}/`, schema: "the schema folder", docs: "the docs folder", tests: "the tests folder", code: "the code folder" };
/** The folders a catalog is asked for when they hold documents and have none. The docs, code and tests folders are not asked: theirs comes with "Set up project" or "Start folder catalogs", and a project may do without. */
const ASKED_FOR: readonly CatalogArea[] = ["tickets", "specs", "knowledge", "registries", "schema"];
/** A sentence's first letter, where it opens with words and not with a folder's name. */
const opening = (text: string) => (text.startsWith("the ") ? `T${text.slice(1)}` : text);
/** How many of a document's broken links a check names before it counts the rest. */
const LINKS_NAMED = 2;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** A document in a few words: a ticket by its key, anything else by its title. */
const called = (file: DocFile) => file.ticket || file.title || (file.group === "registries" ? registryTitle(file.name) : file.name);
/** "a", "a and b", "a, b and c". */
const listed = (words: string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What needs attention among the working documents, the worst first. `areas` are the folders that have catalogs
 * here: all of them, but for a project whose schema folder is its own folder, which is no folder to catalogue.
 */
export function docChecks(
	files: readonly DocFile[],
	areas: readonly CatalogArea[] = CATALOG_AREAS,
	options?: { incomingLinks?: ReadonlySet<string>; root?: string },
): DocCheck[] {
	const checks: DocCheck[] = [];
	const inGroup = (area: CatalogArea) => files.filter((file) => (file.group as string) === area && file.exists);
	const tickets = inGroup("tickets").filter((file) => !isCatalog(file));
	const specs = inGroup("specs").filter((file) => !isCatalog(file));
	const here = (key: string) => tickets.some((ticket) => ticket.ticket && same(ticket.ticket, key));

	// A registry that does not read as a table: the rows it counts cannot be trusted.
	for (const file of inGroup("registries")) for (const problem of file.problems ?? []) checks.push({ level: "warn", text: `${registryTitle(file.name)}: ${problem}`, path: file.path });

	// A ticket's spec or plan that is not where the ticket says.
	for (const ticket of tickets) {
		for (const ref of ticket.missing ?? []) {
			const kind = /\.plan\.(json|md)$/i.test(ref) ? "plan" : "spec";
			checks.push({ level: "warn", text: `${ticket.ticket} names a ${kind} that is not there: ${ref}`, path: ticket.path });
		}
	}

	// A catalog that no longer says what its folder holds, or a folder with documents and no catalog.
	// One update writes them all, so they are said together.
	const stale: DocFile[] = [];
	const without: DocFile[] = [];
	/** The folder a catalog is of: said by the catalog where its group does not say (the tests' and the code's). */
	const areaOf = (file: DocFile) => (file.catalog?.area ?? file.group) as CatalogArea;
	for (const area of areas) {
		// The tests' and the code's catalogs are listed with the project's files and say which folder's they are; any
		// other folder's is the one at the top of its own list, not one a person keeps deeper in.
		const all = isFileArea(area) ? [] : inGroup(area);
		const catalog = isFileArea(area) ? files.find((file) => file.exists && isCatalog(file) && file.catalog?.area === area) : all.find((file) => isCatalog(file) && !/[\\/]/.test(file.name));
		if (catalog?.catalog?.stale) stale.push(catalog);
		else if (!catalog && ASKED_FOR.includes(area) && all.length) without.push(all[0]!);
	}
	const folders = (of: DocFile[]) => listed(of.map((file) => FOLDER_SAID[areaOf(file)]));
	if (stale.length) checks.push({ level: "warn", text: stale.length === 1 ? `The catalog of ${folders(stale)} is out of date.` : `The catalogs of ${folders(stale)} are out of date.`, path: stale[0]!.path, fix: { kind: "catalogs" } });
	if (without.length) checks.push({ level: "note", text: `${opening(folders(without))} ${without.length === 1 ? "has" : "have"} no catalog (${CATALOG_FILE}).`, path: without[0]!.path, fix: { kind: "catalogs" } });

	// A link to a file that is not there: the document it led to was moved, renamed or never written. A catalog
	// that is out of date is said above, and writing it afresh mends its list.
	const isWikiHref = (href: string) => /^!?\[\[.*\]\]$/.test(href);
	for (const file of files) {
		if (!file.exists || !file.broken?.length || stale.includes(file)) continue;
		const pathBroken = file.broken.filter((link) => !isWikiHref(link.href));
		const wikiBroken = file.broken.filter((link) => isWikiHref(link.href));
		if (pathBroken.length) {
			const names = [...new Set(pathBroken.map((link) => linkFile(link.href)))];
			const shown = names.slice(0, LINKS_NAMED);
			const more = names.length - shown.length;
			// A file of the same name elsewhere in the project is where it went: the link can be pointed there.
			const mends = pathBroken.flatMap((link) => (link.instead && link.line ? [{ line: link.line, column: link.column, href: link.href, instead: link.instead }] : []));
			checks.push({
				level: "warn",
				text: names.length === 1 ? `${called(file)} links to a file that is not there: ${names[0]}` : `${called(file)} links to ${names.length} files that are not there: ${shown.join(", ")}${more ? ` and ${more} more` : ""}`,
				path: file.path,
				...(pathBroken[0]!.line ? { line: pathBroken[0]!.line } : {}),
				...(mends.length ? { fix: { kind: "links" as const, mends } } : {}),
			});
		}
		if (wikiBroken.length) {
			const names = [...new Set(wikiBroken.map((link) => link.href.replace(/^!?\[\[|\]\]$/g, "")))];
			const shown = names.slice(0, LINKS_NAMED);
			const more = names.length - shown.length;
			const wikiMends: WikiLinkMend[] = wikiBroken.flatMap((link) => {
				if (!link.instead || !link.line) return [];
				const name = link.href.replace(/^!?\[\[|\]\]$/g, "");
				return [{ line: link.line, column: link.column, name, href: link.href, instead: link.instead }];
			});
			checks.push({
				level: "warn",
				text: names.length === 1 ? `${called(file)} links to a note that is not there: ${names[0]}` : `${called(file)} links to ${names.length} notes that are not there: ${shown.join(", ")}${more ? ` and ${more} more` : ""}`,
				path: file.path,
				...(wikiBroken[0]!.line ? { line: wikiBroken[0]!.line } : {}),
				...(wikiMends.length ? { fix: { kind: "mend-wikilinks" as const, mends: wikiMends } } : {}),
			});
		}
	}

	// A document still as its template left it.
	for (const file of files) if (file.exists && file.untouched && file.group !== "project") checks.push({ level: "note", text: `Not written yet: ${file.ticket ? `${file.ticket} ` : ""}${file.title || file.name}`, path: file.path });

	// Duplicate ticket keys across files cause ambiguous lookup/import behavior.
	const keyGroups = new Map<string, DocFile[]>();
	for (const t of tickets) {
		if (!t.ticket) continue;
		const k = t.ticket.toLowerCase();
		keyGroups.set(k, [...(keyGroups.get(k) ?? []), t]);
	}
	for (const group of keyGroups.values()) {
		if (group.length > 1) {
			checks.push({
				level: "warn",
				text: `Duplicate ticket key ${group[0]!.ticket} in ${group.length} files (${group.map((g) => g.name).join(", ")}).`,
				path: group[1]!.path,
			});
		}
	}

	// Circular parent chains among tickets.
	const byKey = new Map<string, DocFile>();
	for (const t of tickets) {
		if (!t.ticket) continue;
		const k = t.ticket.toLowerCase();
		if (!byKey.has(k) || (!byKey.get(k)!.parent && t.parent)) byKey.set(k, t);
	}
	const reportedCycle = new Set<string>();
	for (const t of tickets) {
		if (!t.ticket || !t.parent || reportedCycle.has(t.ticket.toLowerCase())) continue;
		const seen = new Set<string>([t.ticket.toLowerCase()]);
		let cur = byKey.get(t.parent.toLowerCase());
		while (cur?.ticket) {
			const k = cur.ticket.toLowerCase();
			if (k === t.ticket.toLowerCase()) {
				for (const member of seen) reportedCycle.add(member);
				checks.push({ level: "warn", text: `${t.ticket} is part of a circular parent chain (${[...seen].join(" → ")}).`, path: t.path });
				break;
			}
			if (seen.has(k)) break;
			seen.add(k);
			cur = cur.parent ? byKey.get(cur.parent.toLowerCase()) : undefined;
		}
	}

	// A ticket that is finished while a spec, sub-ticket, open question, or registry row for it is not.
	const questions = files.filter((file) => file.exists && file.group === "knowledge" && file.kind === "questions" && !isCatalog(file));
	const registries = inGroup("registries").filter((file) => !isCatalog(file));
	for (const ticket of tickets) {
		if (toneOf(ticket.status) !== "done" || !ticket.ticket) continue;
		for (const spec of specs) {
			if (!spec.tickets?.some((key) => same(key, ticket.ticket!)) || !spec.status) continue;
			if (toneOf(spec.status) === "active" || toneOf(spec.status) === "waiting") checks.push({ level: "note", text: `${ticket.ticket} is ${ticket.status}; its spec is ${spec.status}: ${spec.title || spec.name}`, path: spec.path });
		}
		const openChildren = tickets.filter((child) => child !== ticket && child.parent && same(child.parent, ticket.ticket!) && (toneOf(child.status) === "active" || toneOf(child.status) === "waiting"));
		if (openChildren.length) {
			checks.push({
				level: "note",
				text: `${ticket.ticket} is ${ticket.status}, with ${count(openChildren.length, "sub-ticket")} still open (${openChildren.slice(0, 2).map((c) => c.ticket).join(", ")}${openChildren.length > 2 ? ", …" : ""}).`,
				path: openChildren[0]!.path,
			});
		}
		const openQs = questions.filter((q) => toneOf(q.status) === "waiting" && q.tickets?.some((k) => same(k, ticket.ticket!)));
		if (openQs.length) {
			checks.push({
				level: "note",
				text: `${ticket.ticket} is ${ticket.status}, with ${count(openQs.length, "open question")} tied to it.`,
				path: openQs[0]!.path,
			});
		}
		for (const reg of registries) {
			const hit = reg.forTickets?.find((r) => same(r.key, ticket.ticket!));
			if (hit && hit.done !== undefined && hit.done < hit.rows) {
				checks.push({
					level: "note",
					text: `${ticket.ticket} is ${ticket.status}; ${registryTitle(reg.name)} still has ${hit.rows - hit.done} of ${hit.rows} rows unfinished.`,
					path: reg.path,
				});
			}
		}
	}

	// Orphaned hand-written specs not linked to any ticket (when the project uses tickets).
	if (tickets.length) {
		for (const spec of specs) {
			if (spec.tickets?.length) continue;
			const matchedByTicket = tickets.some((t) => t.specs?.some((ref) => pathMatchesRef(spec.path, ref, t.path)));
			if (!matchedByTicket) {
				checks.push({ level: "note", text: `Spec has no linked ticket: ${spec.title || spec.name}`, path: spec.path });
			}
		}
	}

	// A ticket or a spec that is finished while something it lists as to do is not ticked.
	for (const file of [...tickets, ...specs]) {
		if (toneOf(file.status) !== "done" || !file.tasks || file.tasks.done >= file.tasks.total) continue;
		const left = file.tasks.total - file.tasks.done;
		checks.push({ level: "note", text: `${called(file)} is ${file.status}, with ${left} of its ${file.tasks.total} ${file.tasks.total === 1 ? "item" : "items"} not ticked.`, path: file.path });
	}

	// A ticket named by another, or by a spec, a decision or a question, that is not among the tickets.
	const named = new Map<string, DocFile>();
	for (const file of files) {
		if (!file.exists || isCatalog(file) || !["tickets", "specs", "knowledge", "plans", "registries"].includes(file.group)) continue;
		for (const key of file.tickets ?? []) if (!here(key) && ![...named.keys()].some((seen) => same(seen, key))) named.set(key, file);
	}
	for (const [key, by] of named) checks.push({ level: "note", text: `${key} is not among the tickets; ${called(by)} names it.`, path: by.path, fix: { kind: "ticket", key, ...(by.ticket ? { related: by.ticket } : {}) } });

	// Missing `source:` file on schema/reference docs.
	for (const file of files) {
		if (!file.exists || !file.missingSource) continue;
		checks.push({
			level: "warn",
			text: `${called(file)} names a source file that is not there: ${file.missingSource}`,
			path: file.path,
		});
	}

	// Circular `blocks:` / `blocked-by:` dependency chains among tickets.
	const depEdges = new Map<string, Set<string>>();
	const addEdge = (from: string, to: string) => {
		const fk = from.toLowerCase();
		const tk = to.toLowerCase();
		let set = depEdges.get(fk);
		if (!set) {
			set = new Set();
			depEdges.set(fk, set);
		}
		set.add(tk);
	};
	for (const t of tickets) {
		if (!t.ticket) continue;
		for (const b of t.blocks ?? []) addEdge(t.ticket, b);
		for (const b of t.blockedBy ?? []) addEdge(b, t.ticket);
	}
	const blockReported = new Set<string>();
	for (const t of tickets) {
		if (!t.ticket) continue;
		const start = t.ticket.toLowerCase();
		if (blockReported.has(start)) continue;
		const stack: { node: string; trail: string[] }[] = [{ node: start, trail: [t.ticket] }];
		const visited = new Set<string>();
		while (stack.length) {
			const cur = stack.pop()!;
			for (const nxt of depEdges.get(cur.node) ?? []) {
				if (nxt === start) {
					for (const member of cur.trail) blockReported.add(member.toLowerCase());
					checks.push({
						level: "warn",
						text: `${t.ticket} is in a circular blocks/blocked-by dependency (${[...cur.trail, t.ticket].join(" → ")}).`,
						path: t.path,
					});
					stack.length = 0;
					break;
				}
				if (!visited.has(nxt) && byKey.has(nxt)) {
					visited.add(nxt);
					stack.push({ node: nxt, trail: [...cur.trail, byKey.get(nxt)!.ticket!] });
				}
			}
		}
	}

	// Asymmetric or unresolved `supersedes:` / `superseded-by:` references among decisions.
	const decisions = files.filter((file) => file.exists && file.group === "knowledge" && file.kind === "decisions" && !isCatalog(file));
	if (decisions.length) {
		const decId = (d: DocFile) => d.name.replace(/^.*[\\/]/, "").replace(/\.(md|markdown)$/i, "");
		const decStem = (d: DocFile) => decId(d).toLowerCase();
		const findDec = (ref: string) => {
			const clean = ref.replace(/^\[\[|\]\]$/g, "").replace(/\.(md|markdown)$/i, "").trim().toLowerCase();
			return decisions.find((d) => decStem(d) === clean || (d.title && d.title.toLowerCase() === clean));
		};
		for (const dec of decisions) {
			for (const ref of dec.supersedes ?? []) {
				const target = findDec(ref);
				if (!target) {
					checks.push({ level: "warn", text: `${called(dec)} supersedes a decision that is not there: ${ref}`, path: dec.path });
				} else if (target !== dec && !target.supersededBy?.some((back) => findDec(back) === dec)) {
					checks.push({
						level: "note",
						text: `${called(dec)} supersedes ${called(target)}, which does not list superseded-by back.`,
						path: target.path,
						fix: { kind: "reciprocal-adr", path: target.path, field: "superseded-by", value: decId(dec) },
					});
				}
			}
			for (const ref of dec.supersededBy ?? []) {
				const target = findDec(ref);
				if (!target) {
					checks.push({ level: "warn", text: `${called(dec)} is superseded by a decision that is not there: ${ref}`, path: dec.path });
				} else if (target !== dec) {
					if (!target.supersedes?.some((back) => findDec(back) === dec)) {
						checks.push({
							level: "note",
							text: `${called(dec)} says it is superseded by ${called(target)}, which does not list supersedes back.`,
							path: target.path,
							fix: { kind: "reciprocal-adr", path: target.path, field: "supersedes", value: decId(dec) },
						});
					}
					if (toneOf(dec.status) === "done") {
						checks.push({
							level: "note",
							text: `${called(dec)} is superseded by ${called(target)} but is still marked "${dec.status}".`,
							path: dec.path,
						});
					}
				}
			}
			if (dec.status?.trim().toLowerCase() === "superseded" && !(dec.supersededBy?.length)) {
				checks.push({
					level: "note",
					text: `${called(dec)} is marked superseded but does not list superseded-by.`,
					path: dec.path,
				});
			}
		}
		// Circular `supersedes:` chains among decisions (including self-loops).
		const supEdges = new Map<DocFile, Set<DocFile>>();
		const addSupEdge = (from: DocFile, to: DocFile) => {
			let set = supEdges.get(from);
			if (!set) {
				set = new Set();
				supEdges.set(from, set);
			}
			set.add(to);
		};
		for (const dec of decisions) {
			for (const ref of dec.supersedes ?? []) {
				const target = findDec(ref);
				if (target) addSupEdge(dec, target);
			}
			for (const ref of dec.supersededBy ?? []) {
				const target = findDec(ref);
				if (target) addSupEdge(target, dec);
			}
		}
		const supReported = new Set<DocFile>();
		for (const dec of decisions) {
			if (supReported.has(dec)) continue;
			const stack: { node: DocFile; trail: DocFile[] }[] = [{ node: dec, trail: [dec] }];
			const visited = new Set<DocFile>();
			while (stack.length) {
				const cur = stack.pop()!;
				for (const nxt of supEdges.get(cur.node) ?? []) {
					if (nxt === dec) {
						for (const member of cur.trail) supReported.add(member);
						checks.push({
							level: "warn",
							text: `${called(dec)} is in a circular supersedes chain (${[...cur.trail, dec].map(called).join(" → ")}).`,
							path: dec.path,
						});
						stack.length = 0;
						break;
					}
					if (!visited.has(nxt)) {
						visited.add(nxt);
						stack.push({ node: nxt, trail: [...cur.trail, nxt] });
					}
				}
			}
		}
	}

	// Broader orphan detection: `.plan.json` files not linked to any ticket (neither `plan.ticket` nor any ticket's `plans:`).
	const orphanPlans = files.filter((f) => {
		if (!f.exists || f.group !== "plans" || !/\.plan\.json$/i.test(f.name)) return false;
		if (f.tickets?.length) return false;
		const normName = f.name.replace(/\\/g, "/").toLowerCase();
		const linkedToTicket = tickets.some((t) =>
			t.plans?.some((ref) => pathMatchesRef(f.path, ref, t.path) || ref.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase() === normName),
		);
		return !linkedToTicket;
	});
	if (orphanPlans.length && tickets.length) {
		checks.push({
			level: "note",
			text: `${count(orphanPlans.length, "plan has", "plans have")} no ticket linked${orphanPlans.length === 1 ? `: ${orphanPlans[0]!.heading || orphanPlans[0]!.name}` : "."}`,
			path: orphanPlans[0]!.path,
		});
	}

	// What is not yet known.
	const open = files.filter((file) => file.exists && file.group === "knowledge" && file.kind === "questions" && toneOf(file.status) === "waiting" && !isCatalog(file));
	if (open.length) checks.push({ level: "note", text: `${count(open.length, "question is", "questions are")} open${open.length === 1 ? `: ${open[0]!.title || open[0]!.name}` : "."}`, path: open[0]!.path });

	if (options?.incomingLinks) {
		for (const orphan of orphanDocChecks(files, options.incomingLinks, { root: options.root })) {
			checks.push({ level: orphan.level, text: orphan.message, path: orphan.path });
		}
	}

	return checks.sort((a, b) => Number(b.level === "warn") - Number(a.level === "warn"));
}

const normPath = (p: string) => p.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
const isArchivedDoc = (file: DocFile) => /(?:^|[\\/])archive[\\/]/i.test(file.path) || /(?:^|[\\/])archive[\\/]/i.test(file.name);
const isReservedDocName = (file: DocFile) => {
	const base = (file.name.split(/[\\/]/).pop() ?? file.name).toLowerCase();
	return base === "readme.md" || base === "agents.md" || base === "state.md" || base === "index.md";
};

const KNOWLEDGE_LABEL: Record<string, string> = {
	decisions: "decision",
	questions: "question",
	reference: "reference note",
	snippets: "snippet",
	prompts: "prompt",
};

/**
 * Flags unreferenced `knowledge/` (`decisions`, `questions`, `reference`, `snippets`, `prompts`),
 * `schema/`, and `docs/*.md` files that have zero incoming links, zero ticket associations, and
 * zero code references. Never flags `README.md`, `AGENTS.md`, `STATE.md`, `INDEX.md`, or archived docs.
 */
export function orphanDocChecks(
	files: readonly DocFile[],
	incomingLinks: ReadonlySet<string>,
	options?: { root?: string },
): { path: string; line: number; kind: "orphan"; level: "note"; message: string }[] {
	const linkedNorm = new Set<string>();
	for (const p of incomingLinks) {
		const n = normPath(p);
		if (n) linkedNorm.add(n);
	}
	const rootPrefix = options?.root ? `${normPath(options.root)}/` : "";
	const metaRefs = new Set<string>();
	const addMetaRef = (raw?: string, fromPath?: string) => {
		if (!raw) return;
		const rawNorm = normPath(raw.split(/[?#]/)[0] ?? "");
		if (!rawNorm) return;
		if (fromPath && /^\.{1,2}\//.test(rawNorm)) {
			metaRefs.add(normPath(resolvePath(dirName(fromPath), rawNorm)));
			return;
		}
		const clean = rawNorm.replace(/^\.?\/+/, "");
		if (clean) {
			metaRefs.add(clean);
			if (rootPrefix) metaRefs.add(`${rootPrefix}${clean}`);
		}
	};
	for (const doc of files) {
		if (!doc.exists) continue;
		if (doc.source && !/^https?:\/\//i.test(doc.source)) addMetaRef(doc.source, doc.path);
		for (const p of doc.nodeDocs ?? []) addMetaRef(p, doc.path);
		for (const p of doc.specs ?? []) addMetaRef(p, doc.path);
		for (const p of doc.plans ?? []) addMetaRef(p, doc.path);
	}

	const isLinkedByMeta = (filePath: string) => {
		const full = normPath(filePath);
		if (linkedNorm.has(full) || metaRefs.has(full)) return true;
		for (const ref of metaRefs) {
			if (full === ref || full.endsWith(`/${ref}`)) return true;
		}
		for (const link of linkedNorm) {
			if (full.endsWith(`/${link}`) || link.endsWith(`/${full}`)) return true;
		}
		return false;
	};

	const out: { path: string; line: number; kind: "orphan"; level: "note"; message: string }[] = [];
	for (const file of files) {
		if (!file.exists || isCatalog(file) || isReservedDocName(file) || isArchivedDoc(file)) continue;
		if (file.group !== "knowledge" && file.group !== "schema" && file.group !== "docs") continue;
		if (file.group === "docs" && !/\.(md|markdown)$/i.test(file.name)) continue;
		if (file.tickets?.length || file.codeRefs?.length) continue;
		if (file.group === "knowledge" && file.kind === "decisions" && (file.supersedes?.length || file.supersededBy?.length)) continue;
		if (isLinkedByMeta(file.path)) continue;

		const kindLabel =
			file.group === "schema"
				? "schema doc"
				: file.group === "docs"
					? "document"
					: KNOWLEDGE_LABEL[(file.kind ?? "").toLowerCase()] ?? "knowledge note";
		out.push({
			path: file.path,
			line: 1,
			kind: "orphan",
			level: "note",
			message: `Unreferenced ${kindLabel}: ${called(file)} has no incoming links, tickets, or code references.`,
		});
	}
	return out;
}

/** Finds duplicate Markdown ATX headings (same anchor slug / text) within a single document. */
export function findDuplicateHeadings(text: string): { heading: string; line: number; firstLine: number }[] {
	const headings = documentHeadings(text);
	const firstByKey = new Map<string, number>();
	const dupes: { heading: string; line: number; firstLine: number }[] = [];
	for (const h of headings) {
		const key = headingAnchor(h.text) || h.text.trim().toLowerCase();
		if (!key) continue;
		const firstLine = firstByKey.get(key);
		if (firstLine !== undefined) {
			dupes.push({ heading: h.text, line: h.line, firstLine });
		} else {
			firstByKey.set(key, h.line);
		}
	}
	return dupes;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses `YYYY-MM-DD` (or ISO-8601 prefix) into UTC midnight ms epoch; null if invalid. */
function parseIsoDateMs(raw: string | undefined): number | null {
	const s = raw?.trim();
	if (!s) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(s);
	if (!m) return null;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	const ms = Date.UTC(y, mo - 1, d);
	const check = new Date(ms);
	if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
	return ms;
}

export type StaleDocIssue = {
	path: string;
	line: number;
	kind: "stale";
	level: "warn" | "note";
	message: string;
	fix?: { kind: "record-approval"; path: string };
};

/**
 * Surfaces stale documentation hygiene notes & warnings:
 * - Prefers explicit frontmatter dates (`asked`, `date`, `approved-date`) when older than `mtime`
 *   so a fresh `git clone` never masks aged questions, templates, or SOPs.
 * - Untouched templates older than 7 days
 * - Open questions older than 30 days
 * - `STATE.md` older than 14 days
 * - Controlled documents (`version`, `change-control`, `gxp-impact`, or `status: approved`) missing approval metadata
 * - Periodic review deadlines (`review-due: YYYY-MM-DD`): past due (`warn`) or due within 30 days (`note`)
 */
export function staleDocChecks(docs: readonly DocFile[], nowMs = Date.now()): StaleDocIssue[] {
	const out: StaleDocIssue[] = [];
	const nowDate = new Date(nowMs);
	const todayUtcMs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());

	for (const doc of docs) {
		if (!doc.exists || isCatalog(doc) || isArchivedDoc(doc)) continue;
		const mtimeMs = typeof doc.mtime === "number" && doc.mtime > 0 ? doc.mtime : null;
		const explicitMs = parseIsoDateMs(doc.asked) ?? parseIsoDateMs(doc.date) ?? parseIsoDateMs(doc.approvedDate);
		const effectiveMs =
			explicitMs !== null && (mtimeMs === null || explicitMs < mtimeMs) ? explicitMs : mtimeMs;
		const ageMs = effectiveMs !== null ? Math.max(0, nowMs - effectiveMs) : null;
		const ageDays = ageMs !== null ? Math.floor(ageMs / DAY_MS) : null;

		// 1. Untouched templates older than 7 days
		if (doc.untouched && doc.group !== "project" && ageMs !== null && ageMs > 7 * DAY_MS) {
			out.push({
				path: doc.path,
				line: 1,
				kind: "stale",
				level: "note",
				message: `Untouched template (${ageDays} days old): ${called(doc)}.`,
			});
		}

		// 2. Open questions older than 30 days
		if (doc.group === "knowledge" && doc.kind === "questions" && toneOf(doc.status) === "waiting" && ageMs !== null && ageMs > 30 * DAY_MS) {
			out.push({
				path: doc.path,
				line: 1,
				kind: "stale",
				level: "note",
				message: `Open question untouched for ${ageDays} days: ${called(doc)}.`,
			});
		}

		// 3. STATE.md older than 14 days
		if (doc.group === "project" && /^state\.md$/i.test(doc.name) && ageMs !== null && ageMs > 14 * DAY_MS) {
			out.push({
				path: doc.path,
				line: 1,
				kind: "stale",
				level: "note",
				message: `STATE.md has not been updated in ${ageDays} days.`,
			});
		}

		// 4. Controlled documents missing approval metadata (`approved-by` / `approved-date`)
		const hasGxpImpact = Boolean(doc.gxpImpact && !/^(?:none|no|n\/a|false)$/i.test(doc.gxpImpact.trim()));
		const isControlled = Boolean(doc.version || doc.changeControl || hasGxpImpact || /^approved$/i.test(doc.status?.trim() ?? ""));
		if (isControlled && (!doc.approvedBy || !doc.approvedDate)) {
			const missing: string[] = [];
			if (!doc.approvedBy) missing.push("approved-by");
			if (!doc.approvedDate) missing.push("approved-date");
			out.push({
				path: doc.path,
				line: 1,
				kind: "stale",
				level: "note",
				message: `Controlled document ${called(doc)} is missing ${missing.join(" and ")}.`,
				fix: { kind: "record-approval", path: doc.path },
			});
		}

		// 5. Periodic review due date (`review-due: YYYY-MM-DD`) on active/controlled docs
		const reviewDueMs = parseIsoDateMs(doc.reviewDue);
		if (reviewDueMs !== null && toneOf(doc.status) !== "off") {
			const daysUntil = Math.round((reviewDueMs - todayUtcMs) / DAY_MS);
			if (daysUntil < 0) {
				const overdue = -daysUntil;
				out.push({
					path: doc.path,
					line: 1,
					kind: "stale",
					level: "warn",
					message: `Review past due by ${count(overdue, "day")} (${doc.reviewDue}): ${called(doc)}.`,
				});
			} else if (daysUntil <= 30) {
				out.push({
					path: doc.path,
					line: 1,
					kind: "stale",
					level: "note",
					message:
						daysUntil === 0
							? `Review due today (${doc.reviewDue}): ${called(doc)}.`
							: `Review due in ${count(daysUntil, "day")} (${doc.reviewDue}): ${called(doc)}.`,
				});
			}
		}
	}
	return out;
}

/** The checks in a line, for a heading: "2 to fix, 3 to know". Empty when there is nothing. */
export function checksSummary(checks: readonly DocCheck[]): string {
	const wrong = checks.filter((check) => check.level === "warn").length;
	const notes = checks.length - wrong;
	return [wrong ? `${wrong} to fix` : "", notes ? `${notes} to know` : ""].filter(Boolean).join(", ");
}
