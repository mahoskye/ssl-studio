// Links by name, as a notebook writes them: [[name]], [[name|the words
// shown]], [[name#a heading]]. The name is a document's, not its path: a
// ticket's key, a file's name without its ending, a path from the project's
// folder, or what the document calls itself. Which document a name means is
// worked out here, in one place, for the text, the page and the list offered
// while a link is written (ADR 0025).
import { DOC_ORDER, linkChoices } from "./docLinks";
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
export function docByName(name: string, files: readonly DocFile[], root?: string | null): DocFile | null {
	const wanted = plain(name);
	if (!wanted) return null;
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
	const tries: ((file: DocFile) => boolean)[] = [
		(file) => Boolean(file.ticket) && plain(file.ticket!) === wanted,
		(file) => fromTop(file) === wanted || withoutEnding(fromTop(file)) === wanted,
		(file) => plain(baseName(file.path)) === wanted || plain(withoutEnding(baseName(file.path))) === wanted,
		(file) => Boolean(file.title) && plain(file.title!) === wanted,
	];
	for (const answers of tries) {
		const found = there.find(answers);
		if (found) return found;
	}
	return null;
}

/** What ends a name where it stands between the brackets: a name that holds one of these cannot be written there. */
const UNWRITABLE = /[[\]|#\n]/;

/**
 * The name to write for a document, so that the name means that document
 * and no other: a ticket's key, else the file's name without its ending,
 * else (where another document answers to that) its path from the project's
 * folder. Null when no name can be written for it: its name holds a bar, a
 * hash or a bracket.
 */
export function nameFor(file: DocFile, files: readonly DocFile[], root?: string | null): string | null {
	const fromTop = relativeTo(root, file.path).split("\\").join("/");
	for (const name of [file.ticket ?? "", withoutEnding(baseName(file.path)), withoutEnding(fromTop), fromTop]) {
		if (name.trim() && !UNWRITABLE.test(name) && docByName(name, files, root) === file) return name;
	}
	return null;
}

/** What has been typed of a link's name, when the cursor is in one: the text after "[[" on this line, up to the cursor. Null anywhere else. */
export function nameBeingWritten(lineToCursor: string): string | null {
	const found = /\[\[([^[\]|#\n]*)$/.exec(lineToCursor);
	if (!found) return null;
	// In a span of code the same characters are an example of a link.
	const lead = lineToCursor.slice(0, found.index);
	return (lead.match(/`/g)?.length ?? 0) % 2 === 1 ? null : found[1]!;
}

/** Each link by name in a piece of plain text, in order: where it starts and ends, and what it holds. */
export function namedLinksIn(text: string): { from: number; to: number; link: NamedLink }[] {
	const found: { from: number; to: number; link: NamedLink }[] = [];
	for (const match of text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
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
	return linkChoices(files, path, root).flatMap((choice) => {
		const file = byPlace.get(choice.detail);
		// Worked out among all the documents, the one being written in too: a name that is this document's own
		// would lead back here, not to the one chosen.
		const name = file && nameFor(file, all, root);
		return name ? [{ label: choice.label, detail: choice.detail, name }] : [];
	});
}
