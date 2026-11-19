// The project's working documents, made and kept from here: the tickets that
// drive the work, the specs, the knowledge base, the registries, and the
// catalog each of those folders is found by (ADR 0012). What these write is
// text like any other: an open file is changed through the editor, so it can
// be undone, and a file that exists is never written over.
import { CATALOG_FILE, catalogStale, withCatalog } from "../shared/catalog";
import { csvRow } from "../shared/csv";
import { localDay } from "../shared/dates";
import { parseCsv } from "../shared/csv";
import { frontMatter, one, withFrontMatter } from "../shared/frontMatter";
import { importSummary, ticketsFromJson, ticketsFromTable, type Imported, type ImportedTicket } from "../shared/ticketImport";
import { manifestSummary, mergeManifest } from "../shared/manifest";
import { baseName, dirName, isInside, joinPath, relativePath, relativeTo } from "../shared/paths";
import { activeEditor } from "./editor/EditorGroup";
import {
	catalogItems,
	catalogTemplate,
	codeSection,
	decisionTemplate,
	DOC_FOLDERS,
	KNOWLEDGE,
	questionTemplate,
	referenceTemplate,
	REGISTRIES,
	slug,
	snippetTemplate,
	specTemplate,
	STATE_FILE,
	stateTemplate,
	ticketKey,
	ticketTemplate,
	toneOf,
	frontValue,
	isCatalog,
	type DocArea,
	type KnowledgeKind,
} from "../shared/projectDocs";
import type { DocFile, LinkTo } from "../shared/protocol";
import { backend } from "./backend";
import { ask, choose } from "./dialogs";
import { createdObjects } from "../shared/outline";
import { toggleTask } from "../shared/tasks";
import type { LinkMend } from "../shared/docChecks";
import { ownLinkEdits, withLinkFiles, type LinkEdit } from "../shared/docLinks";
import { parsePlan, isPlanPath } from "./plan/model";
import { docs, isMarkdown } from "./project";
import { ticketAtHand as listedTicketAtHand, workFor, workLabel, workText } from "../shared/workContext";
import { activeDoc, activePath, applyText, canonical, documents, notify, openFile, save, setState, state } from "./state";

const today = () => localDay();
const root = () => state.workspace?.root ?? "";
// "." is the project's own folder: no part of a path, or the same file would have two spellings.
const docsFolder = () => joinPath(root(), ...(state.project?.docs ?? "docs").split(/[\\/]/).filter((part) => part && part !== "."));
const areaFolder = (area: DocArea) => joinPath(docsFolder(), DOC_FOLDERS[area]);
const ready = () => (state.workspace && state.project ? true : (notify("Open a folder first."), false));

/** A file's text as it stands: in the editor if it is open there, on disk otherwise, null when there is no such file. */
async function current(path: string): Promise<string | null> {
	const open = documents.get(canonical(path));
	if (open) return open.model.getValue();
	try {
		return (await backend.read(path)).text;
	} catch {
		return null;
	}
}

/**
 * Writes a file's text: through the editor when it is open there, where the
 * change can be undone. An open file that had nothing unsaved is saved with
 * the change, so what the folder says and what the editor shows stay the
 * same; one with unsaved work of the person's is left for them to save.
 */
async function put(path: string, text: string, existed: boolean) {
	const open = canonical(path);
	if (documents.get(open)) {
		const clean = !state.dirty[open];
		applyText(open, text);
		if (clean) await save(open);
		return;
	}
	if (!existed) await backend.create(path, "file");
	await backend.write(path, text);
}

/** Writes an area's catalog afresh from its documents; makes the catalog where there is none. True when it changed. */
async function writeCatalog(area: DocArea, files: readonly DocFile[]): Promise<boolean> {
	// The catalog the folder already has, however its name is cased: a second one is not made beside it.
	const path = files.find((file) => file.group === area && file.exists && isCatalog(file) && !file.name.includes("/") && !file.name.includes("\\"))?.path ?? joinPath(areaFolder(area), CATALOG_FILE);
	const items = catalogItems(area, files, docsFolder());
	const before = await current(path);
	if (before === null && !items.length) return false;
	if (before !== null && !catalogStale(before, items)) return false;
	await put(path, withCatalog(before ?? catalogTemplate(area), items), before !== null);
	return true;
}

/** Makes a document from its template, lists it in its folder's catalog, and opens it as text. A file already there is opened, not replaced. */
async function start(path: string, text: string, area?: DocArea) {
	if ((await current(path)) !== null) {
		notify(`${relativeTo(root(), path)} is already there: opened.`);
		return openFile(path);
	}
	try {
		await backend.create(path, "file");
		await backend.write(path, text);
		if (area) await writeCatalog(area, await backend.docs());
	} catch (e: any) {
		return notify(String(e?.message ?? e), "error");
	}
	setState("treeVersion", (v) => v + 1);
	if (isMarkdown(path)) setState("mdText", canonical(path), true);
	await openFile(path);
}

/** The ticket the open document is, or is for, as it stands in the editor: a document's front matter, or a plan's own. */
function ticketOfOpen(): string {
	const path = activePath();
	const doc = activeDoc();
	if (!path || !doc) return "";
	if (isPlanPath(path)) {
		const ticket = parsePlan(doc.model.getValue()).plan?.ticket;
		return typeof ticket === "string" ? ticket.trim() : "";
	}
	if (!isMarkdown(path)) return "";
	const { values } = frontMatter(doc.model.getValue());
	return one(values.ticket).split(",")[0]?.trim() ?? "";
}

/** The ticket at hand: the open document's, or else the one ticket that is under way. "" when it cannot be told. */
export const ticketAtHand = (): string => ticketOfOpen() || listedTicketAtHand(docs(), activePath());

/**
 * The work a ticket is, as text for an agent that cannot read the folder, and
 * what that text holds in a few words. Null when the ticket is not among the
 * project's tickets.
 */
export async function workPrompt(key: string, options: { specs?: boolean } = {}): Promise<{ text: string; label: string } | null> {
	const work = key ? workFor(docs(), key) : null;
	if (!work) return null;
	return { text: await workText(work, current, options), label: workLabel(work, options) };
}

/** A ticket: the work as it was asked for. Its key names its file. */
export async function newTicket(known?: string, related?: string) {
	if (!ready()) return;
	const key = ticketKey(known ?? (await ask("The ticket's key, as in LIMS-123")) ?? "");
	if (!key) return;
	const title = (await ask(`${key}: its title, as the ticket has it`))?.trim();
	if (!title) return;
	const source = (await ask(`${key}: a link to the ticket (leave empty for none)`))?.trim();
	await start(joinPath(areaFolder("tickets"), `${key}.md`), ticketTemplate({ key, title, source: source || undefined, related: related ? [related] : undefined }), "tickets");
}

/**
 * Tickets from an export of a ticket system: a table (CSV) or what its API
 * returns (JSON). A ticket not here yet gets its file; one already here has
 * its state, title and kind brought up to date in its front matter, and
 * nothing else in it is touched. Read from the open document when that is
 * such a file, or from a path.
 */
export async function importTickets() {
	if (!ready()) return;
	const exported = /\.(csv|tsv|json)$/i;
	const open = activePath();
	// Both spelled the one way the editor spells a path: a drive's letter is lowered there.
	const inFolder = open && exported.test(open) && !canonical(open).startsWith(canonical(areaFolder("registries"))) ? relativeTo(root(), open) : "";
	let typed: string;
	let from: string;
	let text: string | null;
	// In the app, with no export open, the system's own dialog finds the file: a download is not in the project.
	if (!inFolder && state.info?.host === "app") {
		let picked: { path: string; text: string } | null;
		try {
			picked = await backend.pickExport();
		} catch (e: any) {
			return notify(String(e?.message ?? e), "error");
		}
		if (!picked) return;
		[typed, from, text] = [baseName(picked.path), picked.path, picked.text];
	} else {
		typed = (await ask("The exported file (CSV or JSON): its path in this folder, or its whole path anywhere", inFolder))?.trim() ?? "";
		if (!typed) return;
		const whole = /^([A-Za-z]:[\\/]|\/)/.test(typed);
		from = whole ? typed : joinPath(root(), ...typed.split(/[\\/]/));
		// In the folder it is read as the editor has it; anywhere else, from the disk.
		text = !whole || isInside(root(), from) ? await current(from) : await backend.readExport(from).catch((e: any) => (notify(String(e?.message ?? e), "error"), null));
		if (text === null) return whole && !isInside(root(), from) ? undefined : notify(`${typed} could not be read.`, "error");
		// From outside the folder it is called by its name: the way there is long, and not the point.
		if (whole && !isInside(root(), from)) typed = baseName(from);
	}
	let read: Imported;
	if (/\.json$/i.test(from)) {
		try {
			read = ticketsFromJson(JSON.parse(text));
		} catch (e: any) {
			// What JSON itself could not read, and what the reader of tickets fell over, are two things to say.
			return notify(e instanceof SyntaxError ? `${typed} is not JSON that can be read: ${e.message}` : `${typed} could not be read as tickets: ${e?.message ?? e}`, "error");
		}
	} else {
		try {
			read = ticketsFromTable(parseCsv(text));
		} catch (e: any) {
			return notify(`${typed} could not be read as a table of tickets: ${e?.message ?? e}`, "error");
		}
	}
	if (read.problem) return notify(`${typed}: ${read.problem}`, "error");
	if (!read.tickets.length) return notify(importSummary({ made: 0, updated: 0, same: 0, skipped: read.skipped, pulls: read.pulls }));
	// A ticket that is in the export twice is one ticket: the last of its rows is the one that stands.
	const once = new Map(read.tickets.map((ticket) => [ticket.key.toLowerCase(), ticket]));
	read = { ...read, tickets: [...once.values()] };
	const path = (ticket: ImportedTicket) => joinPath(areaFolder("tickets"), `${ticket.key}.md`);
	const before = await Promise.all(read.tickets.map((ticket) => current(path(ticket))));
	const here = before.filter((was) => was !== null).length;
	const go = "Import";
	const said = `${read.tickets.length} ${read.tickets.length === 1 ? "ticket" : "tickets"} in ${typed}: ${read.tickets.length - here} new, ${here} already here. Those here keep what was written in them; their state, title and kind are brought up to date.`;
	if ((await choose(said, [go])) !== go) return;
	const counts = { made: 0, updated: 0, same: 0, skipped: read.skipped, pulls: read.pulls };
	try {
		for (const [at, ticket] of read.tickets.entries()) {
			const was = before[at]!;
			if (was === null) {
				await put(path(ticket), ticketTemplate(ticket), false);
				counts.made++;
				continue;
			}
			// Only what the ticket system knows better: what a person wrote in the file stays.
			const { values } = frontMatter(was);
			let now = was;
			for (const [key, value] of [["status", ticket.status], ["title", ticket.title], ["type", ticket.type]] as const) {
				if (!value || one(values[key]).toLowerCase() === value.toLowerCase()) continue;
				now = withFrontMatter(now, key, frontValue(value)) ?? now;
			}
			if (now === was) counts.same++;
			else {
				await put(path(ticket), now, true);
				counts.updated++;
			}
		}
		await writeCatalog("tickets", await backend.docs());
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
	setState("treeVersion", (v) => v + 1);
	notify(importSummary(counts));
	if (counts.made === 1 && read.tickets.length === 1) await openFile(path(read.tickets[0]!));
}

/** A spec: what is to be built, written from a ticket. */
export async function newSpec() {
	if (!ready()) return;
	const title = (await ask("What the spec is for, in a few words"))?.trim();
	if (!title || !slug(title)) return;
	const ticket = ticketKey((await ask("The ticket it is for (leave empty for none)", ticketAtHand())) ?? "");
	await start(joinPath(areaFolder("specs"), `${slug(title)}.md`), specTemplate({ title, ticket: ticket || undefined }), "specs");
}

/**
 * The code a new question or decision is about: what is selected in the
 * editor, when it is in a file that is not one of the project's documents.
 * Null when nothing is selected.
 */
function codeAtHand(): { path: string; from: number; to: number; text: string; language: string } | null {
	const path = activePath();
	const editor = activeEditor();
	const model = editor?.getModel();
	const selection = editor?.getSelection();
	if (!path || !editor || !model || !selection || selection.isEmpty()) return null;
	if (isMarkdown(path) || canonical(path).startsWith(canonical(docsFolder()))) return null;
	// Whole lines: a selection that stops at a line's start does not take that line.
	const to = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
	const language = model.getLanguageId();
	return { path, from: selection.startLineNumber, to, text: model.getValueInRange({ startLineNumber: selection.startLineNumber, startColumn: 1, endLineNumber: to, endColumn: model.getLineMaxColumn(to) }), language: language === "plaintext" ? "" : language };
}

/** Something for the knowledge base: a decision, a question, a snippet or a reference note. */
export async function newKnowledge(kind: KnowledgeKind["id"]) {
	if (!ready()) return;
	const what = KNOWLEDGE.find((k) => k.id === kind)!;
	const folder = joinPath(areaFolder("knowledge"), kind);
	// Read before anything is asked: a dialog takes the keyboard, and the selection with it.
	const code = kind === "questions" || kind === "decisions" ? codeAtHand() : null;
	const aboutCode = code ? ` (about ${code.from === code.to ? `line ${code.from}` : `lines ${code.from} to ${code.to}`} of ${baseName(code.path)})` : "";
	const title = (await ask(kind === "questions" ? `The question, as you would ask it${aboutCode}` : kind === "snippets" ? "What the snippet is for, in a few words" : `The ${what.one}, in a few words${aboutCode}`))?.trim();
	if (!title || !slug(title)) return;
	if (kind === "snippets") {
		const language = await choose("A snippet of what?", ["SQL", "SSL"]);
		if (!language) return;
		return start(joinPath(folder, `${slug(title)}.${language.toLowerCase()}`), snippetTemplate({ title, language: language === "SQL" ? "sql" : "ssl" }), "knowledge");
	}
	if (kind === "reference") return start(joinPath(folder, `${slug(title)}.md`), referenceTemplate({ title }), "knowledge");
	// Only what the open document says: a decision is not put to a ticket on a guess.
	const ticket = ticketOfOpen() || undefined;
	// Started with code selected, it is about that code: it says where, and keeps the lines as they were.
	const about = code ? codeSection({ file: relativeTo(root(), code.path).split("\\").join("/"), link: relativePath(folder, code.path), from: code.from, to: code.to, text: code.text, language: code.language, date: today() }) : "";
	if (kind === "questions") return start(joinPath(folder, `${slug(title)}.md`), questionTemplate({ title, date: today(), ticket }) + about, "knowledge");
	// Decisions are numbered, so that one can be named by its number and they list in the order they were made.
	const taken = (await backend.docs()).filter((d) => d.group === "knowledge" && d.kind === "decisions").map((d) => Number(/^(\d+)/.exec(baseName(d.name))?.[1] ?? 0));
	const number = String(Math.max(0, ...taken) + 1).padStart(4, "0");
	await start(joinPath(folder, `${number}-${slug(title)}.md`), decisionTemplate({ title, date: today(), ticket }) + about, "knowledge");
}

/** A row for each object the schema folder's SQL creates: object, kind, used by (empty), status, and where it was found. */
async function schemaRows(): Promise<string> {
	const rows: string[] = [];
	const seen = new Set<string>();
	try {
		for (const file of (await backend.docs()).filter((d) => d.group === "schema" && d.exists && /\.sql$/i.test(d.name))) {
			const text = await current(file.path);
			if (text === null) continue;
			for (const made of createdObjects(text)) {
				if (seen.has(made.object.toLowerCase())) continue;
				seen.add(made.object.toLowerCase());
				rows.push(csvRow([made.object, made.kind, "", "found", `From ${relativeTo(root(), file.path).split("\\").join("/")}`]));
			}
		}
	} catch {
		// The registry starts empty: what the schema says is a convenience, not a condition.
	}
	return rows.length ? `${rows.join("\n")}\n` : "";
}

/** A registry: a table of what a migration must carry across, each row with how far it has come. */
export async function newRegistry() {
	if (!ready()) return;
	const other = "Another…";
	const picked = await choose("A registry of what?", [...REGISTRIES.map((r) => r.title), other], { details: { ...Object.fromEntries(REGISTRIES.map((r) => [r.title, r.about])), [other]: "A table of your own: you name its columns." } });
	if (!picked) return;
	const kind = REGISTRIES.find((r) => r.title === picked);
	if (kind?.id === "files") return updateManifest();
	// The database objects start from what the project's schema already says, where it is kept as SQL.
	if (kind?.id === "database") return start(joinPath(areaFolder("registries"), kind.file), `${csvRow(kind.columns)}\n${await schemaRows()}`, "registries");
	if (kind) return start(joinPath(areaFolder("registries"), kind.file), `${csvRow(kind.columns)}\n`, "registries");
	const name = (await ask("What the registry lists, in a word or two"))?.trim();
	if (!name || !slug(name)) return;
	const columns = (await ask("Its columns, separated by commas. A status column says how far each row has come.", "name, status, note"))?.split(",").map((c) => c.trim()).filter(Boolean);
	if (!columns?.length) return;
	await start(joinPath(areaFolder("registries"), `${slug(name).toLowerCase()}.csv`), `${csvRow(columns)}\n`, "registries");
}

/**
 * Sets a document's status: the one line of its front matter, through the
 * editor, so it can be undone. The catalog of its folder is written afresh,
 * since it says each document's state.
 */
export async function setStatus(path: string, status: string) {
	// Front matter is a Markdown document's: a query or a table kept in the same folder has none to set.
	if (!isMarkdown(path)) return notify("Only a Markdown document has a status to set.", "error");
	const before = await current(path);
	if (before === null) return;
	let after = withFrontMatter(before, "status", frontValue(status));
	if (after === null) return notify("The status could not be set here: it is written as a list. Change it in the text.", "error");
	// A question that is answered says when, once: the day is part of the answer.
	const question = docs().some((d) => d.group === "knowledge" && d.kind === "questions" && canonical(d.path) === canonical(path));
	if (question && toneOf(status) === "done" && !one(frontMatter(after).values.answered)) after = withFrontMatter(after, "answered", today()) ?? after;
	if (after === before) return;
	try {
		await put(path, after, true);
		// The catalog that lists it: a spec the planner wrote is beside its plan, and is listed with the specs.
		const listing = await backend.docs();
		const group = listing.find((d) => canonical(d.path) === canonical(path))?.group;
		const area = (Object.keys(DOC_FOLDERS) as DocArea[]).find((name) => name === group);
		if (area) await writeCatalog(area, listing);
		setState("treeVersion", (v) => v + 1);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/**
 * Ticks or unticks the nth task of a document: the one character between its
 * brackets, through the editor. Its folder's catalog does not change: a
 * catalog says a document's state, not how far through its list it is.
 */
export async function tickTask(path: string, index: number) {
	const before = await current(path);
	const after = before === null ? null : toggleTask(before, index);
	if (after === null || after === before) return;
	try {
		await put(path, after, true);
		setState("treeVersion", (v) => v + 1);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/**
 * Points a document's links at where their files are now: each link's file
 * part, on its line, through the editor so it can be undone.
 */
export async function mendLinks(path: string, mends: readonly LinkMend[]) {
	const before = await current(path);
	if (before === null) return;
	const { text: after, done } = withLinkFiles(before, mends);
	// The listing may be older than the text: a link that is no longer where it was is left to the person.
	if (!done) return notify("The link is not where it was: the document has changed since. Mend it in the text.", "error");
	try {
		await put(path, after, true);
		setState("treeVersion", (v) => v + 1);
		notify(done === 1 && mends.length === 1 ? `The link now leads to ${mends[0]!.instead}.` : `${done} ${done === 1 ? "link now leads" : "links now lead"} to where ${done === 1 ? "its file is" : "their files are"}.`);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/**
 * After a file or a folder is renamed: the links that led to the old name
 * are found, and on the person's word pointed at the new one. Each is the
 * link's file part on its line, through the editor where the document is
 * open, so it can be undone there.
 */
export async function followRename(from: string, to: string) {
	if (!state.workspace) return;
	let links: LinkTo[];
	try {
		links = await backend.linksTo(from);
	} catch {
		return;
	}
	// A document moved to another folder has links of its own to write from where it is now. What it says of the
	// old name is among them, so its own places are not counted twice.
	const moved = dirName(canonical(from)) !== dirName(canonical(to)) && isMarkdown(to) ? ((await current(to)) ?? "") : "";
	const own = moved ? ownLinkEdits(moved, canonical(from), canonical(to)) : [];
	if (moved) links = links.filter((link) => canonical(link.path) !== canonical(to));
	if (!links.length && !own.length) return;

	const edits = new Map<string, LinkEdit[]>();
	for (const link of links) {
		const target = `${to}${link.rest}`;
		// What is written from the project's top stays written from the top; a path in front matter is written as it is.
		const fromTop = relativeTo(root(), target);
		const instead = link.from === "root" ? fromTop : link.from === "top" ? `/${fromTop}` : relativePath(dirName(link.path), target);
		edits.set(link.path, [...(edits.get(link.path) ?? []), { line: link.line, column: link.column, href: link.href, instead, plain: link.from === "root" }]);
	}
	if (own.length) edits.set(to, own);

	const total = links.length + own.length;
	const holders = [...new Set(links.map((link) => link.path))];
	const where = holders.length === 1 ? relativeTo(root(), holders[0]!) : `${holders.length} documents`;
	// A ticket's "specs:" line is counted with the links: it names the file as a link does.
	const said = [
		links.length ? `${links.length === 1 ? "One place" : `${links.length} places`} in ${where} still ${links.length === 1 ? "says" : "say"} the old name, ${baseName(from)}.` : "",
		own.length ? `${own.length === 1 ? "One link" : `${own.length} links`} in ${baseName(to)} ${own.length === 1 ? "is" : "are"} written from where it was.` : "",
	]
		.filter(Boolean)
		.join(" ");
	const go = total === 1 ? "Update it" : "Update them";
	if ((await choose(said, [go])) !== go) return;
	let done = 0;
	for (const [path, changes] of edits) {
		const before = await current(path);
		if (before === null) continue;
		const changed = withLinkFiles(before, changes);
		if (!changed.done) continue;
		try {
			await put(path, changed.text, true);
			done += changed.done;
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	}
	setState("treeVersion", (v) => v + 1);
	if (done) notify(`${done} ${done === 1 ? "place was" : "places were"} written anew for ${baseName(to)}.`);
	const left = total - done;
	if (left > 0) notify(`${left} of them ${left === 1 ? "is" : "are"} not where ${left === 1 ? "it was" : "they were"}: the document has changed since. Mend ${left === 1 ? "it" : "them"} in the text.`, "error");
}

/** Where the project stands, in plain words. */
export async function newState() {
	if (!ready()) return;
	await start(joinPath(docsFolder(), STATE_FILE), stateTemplate(state.project!.name, today()));
}

/** Writes every catalog afresh from the documents in its folder. */
export async function updateCatalogs() {
	if (!ready()) return;
	try {
		const files = await backend.docs();
		const changed: string[] = [];
		for (const area of Object.keys(DOC_FOLDERS) as DocArea[]) if (await writeCatalog(area, files)) changed.push(`${DOC_FOLDERS[area]}/${CATALOG_FILE}`);
		setState("treeVersion", (v) => v + 1);
		notify(changed.length ? `Updated ${changed.join(", ")}.` : "Every catalog already says what its folder holds.");
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}

/** Writes the file manifest afresh from the folder: what is new, what has changed, what has gone. A person's status and notes are kept. */
export async function updateManifest() {
	if (!ready()) return;
	const path = joinPath(areaFolder("registries"), REGISTRIES.find((r) => r.id === "files")!.file);
	try {
		const own = relativeTo(root(), path).split("\\").join("/");
		const files = (await backend.manifest()).filter((file) => file.path !== own);
		const before = await current(path);
		const change = mergeManifest(before, files);
		if (before !== change.text) await put(path, change.text, before !== null);
		await writeCatalog("registries", await backend.docs());
		setState("treeVersion", (v) => v + 1);
		notify(manifestSummary(change));
		await openFile(path);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
	}
}
