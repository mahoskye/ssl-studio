// Links by name, as a notebook writes them: [[name]], [[name|the words
// shown]], [[name#a heading]]. The name is a document's, not its path: a
// ticket's key, a file's name without its ending, a path from the project's
// folder, or what the document calls itself. Which document a name means is
// worked out here, in one place, for the text, the page and the list offered
// while a link is written (ADR 0025).
import { fenced } from "./catalog";
import { DOC_ORDER, linkChoices } from "./docLinks";
import { frontMatter } from "./frontMatter";
import { baseName, relativeTo } from "./paths";
import type { DocFile } from "./protocol";

/** What stands between the two pairs of brackets: the name, a heading after "#", and the words to show after "|". */
export type NamedLink = { name: string; heading?: string; words?: string };

/** Reads what stands between the brackets. Null when there is no name to go by (a heading alone is of this document). */
export function namedLink(inner: string): NamedLink | null {
	const bar = inner.indexOf("|");
	const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
	const words = bar < 0 ? "" : inner.slice(bar + 1).trim();
	const hash = target.indexOf("#");
	const name = (hash < 0 ? target : target.slice(0, hash)).trim();
	const heading = hash < 0 ? "" : target.slice(hash + 1).trim();
	if (!name) return null;
	return { name, ...(heading ? { heading } : {}), ...(words ? { words } : {}) };
}

/** A name as it is compared: without regard to capitals, to the space around it, or to which way its slashes lean. */
const plain = (name: string) => name.trim().toLowerCase().split("\\").join("/");
/** A file's name without its ending: "Late samples.md" is "Late samples". */
const withoutEnding = (name: string) => name.replace(/\.[^./\\]+$/, "");

/**
 * The document a name means, among the project's documents that exist. A
 * ticket's key comes first, since a key is what people write; then a path
 * from the project's folder, with or without the file's ending, which is
 * exact; then a file's name, with or without its ending; then what the
 * document calls itself. Where two documents answer in the same way, the
 * first in the order links are offered in is meant (tickets, specs, what was
 * learned, and so on). Null when no document answers.
 */
export type DocNameIndex = {
	byTicket: Map<string, DocFile>;
	byPath: Map<string, DocFile>;
	byBase: Map<string, DocFile>;
	byTitle: Map<string, DocFile>;
};

/** Pre-indexes documents once in DOC_ORDER priority so repeated `docByName` / `nameChoices` lookups are O(1). */
export function buildDocNameIndex(files: readonly DocFile[], root?: string | null): DocNameIndex {
	const order: readonly string[] = DOC_ORDER;
	const there = files
		.filter((file) => file.exists)
		.map((file, index) => ({ file, index }))
		.sort((a, b) => order.indexOf(a.file.group) - order.indexOf(b.file.group) || a.index - b.index)
		.map(({ file }) => file);
	const top = root ? plain(root).replace(/\/+$/, "") : "";
	const fromTop = (file: DocFile) => {
		const path = plain(file.path);
		return top && path.startsWith(`${top}/`) ? path.slice(top.length + 1) : path;
	};
	const byTicket = new Map<string, DocFile>();
	const byPath = new Map<string, DocFile>();
	const byBase = new Map<string, DocFile>();
	const byTitle = new Map<string, DocFile>();
	const put = (map: Map<string, DocFile>, key: string, file: DocFile) => {
		if (key && !map.has(key)) map.set(key, file);
	};
	for (const file of there) {
		if (file.ticket) put(byTicket, plain(file.ticket), file);
		const rel = fromTop(file);
		put(byPath, rel, file);
		put(byPath, withoutEnding(rel), file);
		const base = plain(baseName(file.path));
		put(byBase, base, file);
		put(byBase, plain(withoutEnding(baseName(file.path))), file);
		if (file.title) put(byTitle, plain(file.title), file);
	}
	return { byTicket, byPath, byBase, byTitle };
}

export function lookupInIndex(name: string, index: DocNameIndex): DocFile | null {
	const wanted = plain(name);
	if (!wanted) return null;
	return index.byTicket.get(wanted) ?? index.byPath.get(wanted) ?? index.byBase.get(wanted) ?? index.byTitle.get(wanted) ?? null;
}

export function docByName(name: string, files: readonly DocFile[], root?: string | null): DocFile | null {
	const wanted = plain(name);
	if (!wanted) return null;
	return lookupInIndex(wanted, buildDocNameIndex(files, root));
}

/** What ends a name where it stands between the brackets: a name that holds one of these cannot be written there. */
const UNWRITABLE = /[[\]|#\n]/;

export function nameForIndexed(file: DocFile, index: DocNameIndex, root?: string | null): string | null {
	const fromTop = relativeTo(root, file.path).split("\\").join("/");
	for (const name of [file.ticket ?? "", withoutEnding(baseName(file.path)), withoutEnding(fromTop), fromTop]) {
		if (name.trim() && !UNWRITABLE.test(name) && lookupInIndex(name, index) === file) return name;
	}
	return null;
}

/**
 * The name to write for a document, so that the name means that document
 * and no other: a ticket's key, else the file's name without its ending,
 * else (where another document answers to that) its path from the project's
 * folder. Null when no name can be written for it: its name holds a bar, a
 * hash or a bracket.
 */
export function nameFor(file: DocFile, files: readonly DocFile[], root?: string | null): string | null {
	return nameForIndexed(file, buildDocNameIndex(files, root), root);
}

/** What has been typed of a link's name, when the cursor is in one: the text after "[[" on this line, up to the cursor. Null anywhere else. */
export function nameBeingWritten(lineToCursor: string): string | null {
	const found = /\[\[([^[\]|#\n]*)$/.exec(lineToCursor);
	if (!found) return null;
	// In a span of code the same characters are an example of a link.
	const lead = lineToCursor.slice(0, found.index);
	return (lead.match(/`/g)?.length ?? 0) % 2 === 1 ? null : found[1]!;
}

/** Each link by name in a piece of plain text, in order: where it starts and ends, and what it holds. Skips `![[embeds]]`. */
export function namedLinksIn(text: string): { from: number; to: number; link: NamedLink }[] {
	const found: { from: number; to: number; link: NamedLink }[] = [];
	for (const match of text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
		if (match.index > 0 && text[match.index - 1] === "!") continue;
		const link = namedLink(match[1]!);
		if (link) found.push({ from: match.index, to: match.index + match[0].length, link });
	}
	return found;
}

/**
 * The project's documents as a link by name would call each: offered when
 * "[[" is typed, in the order a link by path offers them. What is written is
 * a name that means that document and no other, and says no more of where
 * the document is than it has to. A document no name can be written for is
 * not offered. `files` are the documents to offer; `all` are the project's,
 * where the caller has left some out of what is offered.
 */
export function nameChoices(files: readonly DocFile[], path: string, root: string, all: readonly DocFile[] = files): { label: string; detail: string; name: string }[] {
	const byPlace = new Map(files.map((file) => [relativeTo(root, file.path).split("\\").join("/"), file]));
	const index = buildDocNameIndex(all, root);
	return linkChoices(files, path, root).flatMap((choice) => {
		const file = byPlace.get(choice.detail);
		// Worked out among all the documents, the one being written in too: a name that is this document's own
		// would lead back here, not to the one chosen.
		const name = file && nameForIndexed(file, index, root);
		return name ? [{ label: choice.label, detail: choice.detail, name }] : [];
	});
}

/** A link by name as it stands in a document's text: its line (from 1), the column its name starts at (from 0), the name as written, and whether it is a `![[embed]]`. */
export type NamePlace = { line: number; column: number; name: string; embed?: boolean };

/**
 * Where the links by name of a Markdown text stand, in order. What a
 * document opens with between its two rules is not prose, and neither is a
 * fenced block of code or a span of code on the line: the same brackets
 * there are left alone. A bar after a backslash is the bar, as a table's
 * row has to write it. (Code set in by four spaces, and a fence inside a
 * list or a quote, are not known to be code here.)
 */
/** Computes inline code spans (`...`, ``...``) on a single Markdown line following CommonMark backtick-run rules. */
function inlineCodeRanges(line: string): [number, number][] {
	const ranges: [number, number][] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] !== "`") {
			i++;
			continue;
		}
		let run = 0;
		while (i + run < line.length && line[i + run] === "`") run++;
		let j = i + run;
		let closed = -1;
		while (j < line.length) {
			if (line[j] !== "`") {
				j++;
				continue;
			}
			let closeRun = 0;
			while (j + closeRun < line.length && line[j + closeRun] === "`") closeRun++;
			if (closeRun === run) {
				closed = j + closeRun;
				break;
			}
			j += closeRun;
		}
		if (closed >= 0) {
			ranges.push([i, closed]);
			i = closed;
		} else {
			i += run;
		}
	}
	return ranges;
}

export function namePlaces(text: string): NamePlace[] {
	if (!text.includes("[[")) return [];
	const lines = text.split(/\r?\n/);
	const fences = fenced(text);
	const opening = frontMatter(text).lines;
	const found: NamePlace[] = [];
	let offset = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const start = offset;
		// The line's end is one character or two: found in the text, not assumed.
		offset += line.length + (text[start + line.length] === "\r" ? 2 : 1);
		if (index < opening || !line.includes("[[")) continue;
		if (fences.some(([from, to]) => start >= from && start < to)) continue;
		const codeSpans = line.includes("`") ? inlineCodeRanges(line) : [];
		for (const match of line.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
			if (codeSpans.some(([from, to]) => match.index >= from && match.index < to)) continue;
			const link = namedLink(match[1]!.replace(/\\\|/g, "|"));
			const embed = match.index > 0 && line[match.index - 1] === "!";
			if (link) found.push({ line: index + 1, column: match.index + 2 + match[1]!.indexOf(link.name), name: link.name, ...(embed ? { embed: true } : {}) });
		}
	}
	return found;
}

/** A name to write in place of another, where a link by name stands: the place, the name there now, and the name instead. */
export type NameEdit = NamePlace & { instead: string };

/**
 * The text with each of these names written anew, and how many were: a
 * name is written over only where it still stands as it was read, so an
 * edit never lands in a text that has changed since. Only the name is
 * touched: the brackets, a heading after "#" and the words after "|" stay
 * as they are (ADR 0002).
 */
export function withNames(text: string, edits: readonly NameEdit[]): { text: string; done: number } {
	const parts = text.split(/(\r?\n)/);
	let done = 0;
	// From the line's end back, so that an edit does not move the place of the one before it.
	for (const edit of [...edits].sort((a, b) => b.line - a.line || b.column - a.column)) {
		const at = (edit.line - 1) * 2;
		const line = parts[at];
		// The name must stand there whole: the two brackets before it, and after it the end of the link, a bar or a hash.
		if (line === undefined || !line.startsWith(edit.name, edit.column) || !/\[\[\s*$/.test(line.slice(0, edit.column)) || !/^\s*(?:\]\]|#|\\?\|)/.test(line.slice(edit.column + edit.name.length))) continue;
		parts[at] = line.slice(0, edit.column) + edit.instead + line.slice(edit.column + edit.name.length);
		done++;
	}
	return { text: parts.join(""), done };
}

/**
 * After files were moved or renamed: the links by name that no longer mean
 * the document they meant, each with a name to write instead. `before` and
 * `after` are the project's documents as they were and as they are, and
 * `moved` says where a path went. A name that still means its document (a
 * ticket's key, what it calls itself) is left as it is. One that now means
 * another document is among them, whether its own document moved or the
 * renamed file took its name. A document that is no longer among the
 * project's documents, or that no name can be written for, is left.
 */
export function namesToFollow<Place extends NamePlace>(places: readonly Place[], before: readonly DocFile[], after: readonly DocFile[], moved: (path: string) => string, root?: string | null): (Place & { instead: string })[] {
	const follow: (Place & { instead: string })[] = [];
	const beforeIdx = buildDocNameIndex(before, root);
	const afterIdx = buildDocNameIndex(after, root);
	const afterByPath = new Map(after.map((file) => [file.path, file]));
	// Each name is asked once, however many places write it.
	const instead = new Map<string, string | null>();
	for (const place of places) {
		if (!instead.has(place.name)) {
			const was = lookupInIndex(place.name, beforeIdx);
			const went = was ? moved(was.path) : "";
			const target = was ? afterByPath.get(went) : undefined;
			const name = target && lookupInIndex(place.name, afterIdx) !== target ? nameForIndexed(target, afterIdx, root) : null;
			instead.set(place.name, name && name !== place.name ? name : null);
		}
		const name = instead.get(place.name);
		if (name) follow.push({ ...place, instead: name });
	}
	return follow;
}

/** A document that links to another: its path, the line of its first link there, and how many places link. */
export type LinkedFrom = { path: string; line: number; places: number };

/**
 * The documents a document is linked from: by path (`byPath`, the links
 * that lead to it) and by name (`byName`, every link by name there is, of
 * which those that mean this document count). Its own links to itself are
 * left out. In the order links are offered in, then by path.
 */
export function linkedFrom(here: string, byPath: readonly { path: string; line: number }[], byName: readonly (NamePlace & { path: string })[], files: readonly DocFile[], root?: string | null): LinkedFrom[] {
	const holders = new Map<string, LinkedFrom>();
	const add = (path: string, line: number) => {
		if (path === here) return;
		const had = holders.get(path);
		if (had) {
			had.places++;
			had.line = Math.min(had.line, line);
		} else holders.set(path, { path, line, places: 1 });
	};
	for (const link of byPath) add(link.path, link.line);
	const me = files.find((file) => file.path === here);
	const idx = buildDocNameIndex(files, root);
	// Each name is asked once, however many places write it.
	const meant = new Map<string, DocFile | null>();
	for (const place of byName) {
		if (!meant.has(place.name)) meant.set(place.name, lookupInIndex(place.name, idx));
		if (me && meant.get(place.name) === me) add(place.path, place.line);
	}
	const order: readonly string[] = DOC_ORDER;
	const groupByPath = new Map(files.map((file) => [file.path, file.group]));
	const rank = (path: string) => {
		const group = groupByPath.get(path);
		const at = group ? order.indexOf(group) : -1;
		return at < 0 ? order.length : at;
	};
	return [...holders.values()].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

