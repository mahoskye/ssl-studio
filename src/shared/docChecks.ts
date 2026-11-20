import { CATALOG_FILE } from "./catalog";
import { linkFile, type LinkEdit } from "./docLinks";
import { CATALOG_AREAS, DOC_FOLDERS, isCatalog, isFileArea, registryTitle, toneOf, type CatalogArea } from "./projectDocs";
import type { DocFile } from "./protocol";

// What the documents of the work need from someone (ADR 0012): a catalog
// that no longer says what its folder holds, a registry that does not read as
// a table, a document nobody has written yet, a ticket or a spec that names
// something that is not there. Read from the listing alone, so it costs
// nothing to ask again.

export type DocCheck = {
	/** "warn" is something wrong; "note" is something to know and perhaps act on. */
	level: "warn" | "note";
	text: string;
	/** The document to open. */
	path: string;
	/** The line of it to go to, where the check is about one place. */
	line?: number;
	/**
	 * What would put it right, where the IDE can: write the catalogs afresh, start the ticket of this key, or point
	 * each link at the one file of its name that the project has elsewhere.
	 */
	fix?: { kind: "catalogs" } | { kind: "ticket"; key: string; related?: string } | { kind: "links"; mends: LinkMend[] };
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
export function docChecks(files: readonly DocFile[], areas: readonly CatalogArea[] = CATALOG_AREAS): DocCheck[] {
	const checks: DocCheck[] = [];
	const inGroup = (area: CatalogArea) => files.filter((file) => (file.group as string) === area && file.exists);
	const tickets = inGroup("tickets").filter((file) => !isCatalog(file));
	const specs = inGroup("specs").filter((file) => !isCatalog(file));
	const here = (key: string) => tickets.some((ticket) => ticket.ticket && same(ticket.ticket, key));

	// A registry that does not read as a table: the rows it counts cannot be trusted.
	for (const file of inGroup("registries")) for (const problem of file.problems ?? []) checks.push({ level: "warn", text: `${registryTitle(file.name)}: ${problem}`, path: file.path });

	// A ticket's spec that is not where the ticket says.
	for (const ticket of tickets) for (const spec of ticket.missing ?? []) checks.push({ level: "warn", text: `${ticket.ticket} names a spec that is not there: ${spec}`, path: ticket.path });

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
		else if (!catalog && ASKED_FOR.includes(area) && all.length && !(area === "specs" && all.every((file) => file.name.includes(".spec.")))) without.push(all[0]!);
	}
	const folders = (of: DocFile[]) => listed(of.map((file) => FOLDER_SAID[areaOf(file)]));
	if (stale.length) checks.push({ level: "warn", text: stale.length === 1 ? `The catalog of ${folders(stale)} is out of date.` : `The catalogs of ${folders(stale)} are out of date.`, path: stale[0]!.path, fix: { kind: "catalogs" } });
	if (without.length) checks.push({ level: "note", text: `${opening(folders(without))} ${without.length === 1 ? "has" : "have"} no catalog (${CATALOG_FILE}).`, path: without[0]!.path, fix: { kind: "catalogs" } });

	// A link to a file that is not there: the document it led to was moved, renamed or never written. A catalog
	// that is out of date is said above, and writing it afresh mends its list.
	for (const file of files) {
		if (!file.exists || !file.broken?.length || stale.includes(file)) continue;
		const names = [...new Set(file.broken.map((link) => linkFile(link.href)))];
		const shown = names.slice(0, LINKS_NAMED);
		const more = names.length - shown.length;
		// A file of the same name elsewhere in the project is where it went: the link can be pointed there.
		const mends = file.broken.flatMap((link) => (link.instead && link.line ? [{ line: link.line, column: link.column, href: link.href, instead: link.instead }] : []));
		checks.push({
			level: "warn",
			text: names.length === 1 ? `${called(file)} links to a file that is not there: ${names[0]}` : `${called(file)} links to ${names.length} files that are not there: ${shown.join(", ")}${more ? ` and ${more} more` : ""}`,
			path: file.path,
			...(file.broken[0]!.line ? { line: file.broken[0]!.line } : {}),
			...(mends.length ? { fix: { kind: "links" as const, mends } } : {}),
		});
	}

	// A document still as its template left it.
	for (const file of files) if (file.exists && file.untouched && file.group !== "project") checks.push({ level: "note", text: `Not written yet: ${file.ticket ? `${file.ticket} ` : ""}${file.title || file.name}`, path: file.path });

	// A ticket that is finished while a spec for it is not.
	for (const ticket of tickets) {
		if (toneOf(ticket.status) !== "done" || !ticket.ticket) continue;
		for (const spec of specs) {
			if (!spec.tickets?.some((key) => same(key, ticket.ticket!)) || !spec.status) continue;
			if (toneOf(spec.status) === "active" || toneOf(spec.status) === "waiting") checks.push({ level: "note", text: `${ticket.ticket} is ${ticket.status}; its spec is ${spec.status}: ${spec.title || spec.name}`, path: spec.path });
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

	// What is not yet known.
	const open = files.filter((file) => file.exists && file.group === "knowledge" && file.kind === "questions" && toneOf(file.status) === "waiting" && !isCatalog(file));
	if (open.length) checks.push({ level: "note", text: `${count(open.length, "question is", "questions are")} open${open.length === 1 ? `: ${open[0]!.title || open[0]!.name}` : "."}`, path: open[0]!.path });

	return checks.sort((a, b) => Number(b.level === "warn") - Number(a.level === "warn"));
}

/** The checks in a line, for a heading: "2 to fix, 3 to know". Empty when there is nothing. */
export function checksSummary(checks: readonly DocCheck[]): string {
	const wrong = checks.filter((check) => check.level === "warn").length;
	const notes = checks.length - wrong;
	return [wrong ? `${wrong} to fix` : "", notes ? `${notes} to know` : ""].filter(Boolean).join(", ");
}
