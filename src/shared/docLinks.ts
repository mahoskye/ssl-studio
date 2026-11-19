import { marked, type Token } from "marked";
import { fenced } from "./catalog";
import { bodyOffset, frontMatter } from "./frontMatter";
import { baseName, dirName, relativePath, relativeTo, resolvePath } from "./paths";
import type { DocFile } from "./protocol";

// The links of a Markdown document that lead to a file: a catalog's line for
// a ticket, a decision's link to the spec it settles, a question's link to
// the lines it asks about. A file that is moved or renamed leaves them
// pointing at nothing, and nothing says so until someone clicks one.
//
// Which words are a link is the renderer's to say: a link in a code block is
// not one, and a reference written apart from its text is. So they are read
// with the renderer's own lexer.

export type DocLink = {
	/** The link as written: "../specs/Due-dates.md#how-it-is-checked". */
	href: string;
	/** The file it leads to, as written, without what follows "?" or "#": "../specs/Due-dates.md". */
	file: string;
	/** Its line in the text, from 1; 0 when it could not be placed. */
	line: number;
	/** Where it starts in that line, from 0. */
	column: number;
};

/** A link that leaves the files: the web, a mail address, a drive, another host. */
const ELSEWHERE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** The file a link names, as written: without its "?" and "#" parts, and with "%20" read as a space. "" when it names none. */
export function linkFile(href: string): string {
	const file = href.trim().split(/[?#]/)[0]!;
	if (!file || ELSEWHERE.test(file)) return "";
	try {
		return decodeURIComponent(file);
	} catch {
		// A "%" that is not an escape is part of the name.
		return file;
	}
}

/** A character of a file's name that a link cannot hold as it is: written as its escape. */
const escaped = (segment: string) => segment.replace(/[% \t#?()<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
const unescaped = (segment: string) => {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
};

/**
 * A path as a link writes it: a space, "#", "?" and the like as their
 * escapes, so that the link reads back as that path. `was` is how the link
 * wrote the path it named before: each part of the new path that is the
 * same as before, from either end, is written as it was, so a rename
 * changes only the part that was renamed.
 */
export function linkWritten(path: string, was = ""): string {
	const parts = path.split("/");
	const before = was.split("/");
	const old = before.map(unescaped);
	let head = 0;
	while (was && head < parts.length && head < old.length && parts[head] === old[head]) head++;
	let tail = 0;
	while (was && tail < parts.length - head && tail < old.length - head && parts[parts.length - 1 - tail] === old[old.length - 1 - tail]) tail++;
	let written = parts.map((part, index) => (index < head ? before[index]! : parts.length - index <= tail ? before[before.length - (parts.length - index)]! : escaped(part))).join("/");
	// The document's own folder has a name too, and a folder that was written with its slash keeps it.
	if (!written) written = ".";
	if (was.endsWith("/") && !written.endsWith("/")) written += "/";
	// A name with a colon near its start would read as a kind of address.
	return ELSEWHERE.test(written) ? `./${written}` : written;
}

/** The targets of a Markdown text's links and images that name a file, in the order the renderer has them. Null when it cannot be read. */
function targets(plain: string): string[] | null {
	const found: string[] = [];
	try {
		marked.walkTokens(marked.lexer(plain, { gfm: true }), (token: Token) => {
			if ((token.type === "link" || token.type === "image") && typeof token.href === "string" && linkFile(token.href)) found.push(token.href);
		});
	} catch {
		return null;
	}
	return found;
}

/** A place in the body: a line, from 0, and a stretch of it. */
type Spot = { line: number; at: number; length: number };
const keyOf = (spot: Spot) => `${spot.line}:${spot.at}`;
/** A name no document writes, put where a link's target is thought to be, to ask the renderer whether it is. */
const marker = (n: number) => `ssl-studio-place-${n}.x`;
/** How many more times a document is read to place the links the first reading could not. */
const RETRIES = 60;

/** The lines with each of these places written over. */
function written(lines: readonly string[], over: readonly [Spot, string][]): string {
	const copy = [...lines];
	for (const [spot, text] of [...over].sort((a, b) => b[0].line - a[0].line || b[0].at - a[0].at)) copy[spot.line] = `${copy[spot.line]!.slice(0, spot.at)}${text}${copy[spot.line]!.slice(spot.at + spot.length)}`;
	return copy.join("\n");
}

/**
 * The links and images of a Markdown document that name a file, each once,
 * in the order they are written.
 *
 * Where each is in the text is first guessed, and then asked of the renderer:
 * the guessed place is written over with a name of our own, and the place
 * is the link's only if the renderer then reads that name as the link's
 * target. The same words in code, in a comment or after a backslash are an
 * example of a link, and an edit must never land there; nothing here has to
 * know what code or a comment looks like to be sure of it.
 */
export function fileLinks(text: string): DocLink[] {
	const start = bodyOffset(text);
	const body = text.slice(start);
	if (!/\]\s*[(:[]/.test(body)) return [];
	const lines = body.split(/\r?\n/);
	const found = targets(lines.join("\n"));
	if (!found?.length) return [];

	// A guess: the next place that writes it as a link's own target; failing that, where a reference is defined.
	const fences = fenced(lines.join("\n"));
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	const inFence = (index: number) => fences.some(([from, to]) => starts[index]! >= from && starts[index]! < to);
	const guess = (index: number, href: string, column: number, lead: RegExp): Spot | null => {
		if (inFence(index)) return null;
		const line = lines[index]!;
		for (let at = line.indexOf(href, column); at >= 0; at = line.indexOf(href, at + 1)) {
			const before = line.slice(0, at);
			const after = line[at + href.length];
			const whole = after === undefined || /[\s)>]/.test(after);
			const inSpan = (before.match(/`/g)?.length ?? 0) % 2 === 1;
			if (whole && !inSpan && lead.test(before)) return { line: index, at, length: href.length };
		}
		return null;
	};
	const INLINE = /\]\(\s*<?$/;
	const DEFINED = /^\s{0,3}(?:>\s*)*\[[^\]]+\]:\s*<?$/;
	let from = 0;
	let column = 0;
	const spots: (Spot | null)[] = found.map((href) => {
		for (let index = from; index < lines.length; index++) {
			const here = guess(index, href, index === from ? column : 0, INLINE);
			if (!here) continue;
			from = index;
			column = here.at + here.length;
			return here;
		}
		for (let index = 0; index < lines.length; index++) {
			const here = guess(index, href, 0, DEFINED);
			if (here) return here;
		}
		return null;
	});

	// The renderer is asked about every guess at once: each place is written over, and the links are read again.
	const distinct = [...new Map(spots.flatMap((spot) => (spot ? [[keyOf(spot), spot] as const] : []))).values()];
	const names = new Map(distinct.map((spot, n) => [keyOf(spot), marker(n)]));
	const read = targets(written(lines, distinct.map((spot) => [spot, names.get(keyOf(spot))!])));
	const sure = spots.map((spot, index) => Boolean(spot && read && read.length === found.length && read[index] === names.get(keyOf(spot))));

	// What that did not settle is tried a place at a time: wherever the words are written, until the renderer says yes.
	let tries = RETRIES;
	const ask = (index: number, spot: Spot) => {
		if (tries-- <= 0) return false;
		const again = targets(written(lines, [[spot, marker(0)]]));
		return Boolean(again && again.length === found.length && again[index] === marker(0));
	};
	found.forEach((href, index) => {
		if (sure[index]) return;
		spots[index] = null;
		const taken = new Set(spots.flatMap((spot, other) => (spot && sure[other] ? [keyOf(spot)] : [])));
		const places: Spot[] = [];
		lines.forEach((line, at) => {
			for (let column = line.indexOf(href); column >= 0; column = line.indexOf(href, column + 1)) places.push({ line: at, at: column, length: href.length });
		});
		// A place that is already another link's is tried last: two uses of one reference share where it is defined.
		for (const place of [...places.filter((p) => !taken.has(keyOf(p))), ...places.filter((p) => taken.has(keyOf(p)))]) {
			if (tries <= 0) break;
			if (!ask(index, place)) continue;
			spots[index] = place;
			sure[index] = true;
			break;
		}
	});

	// Each place once, in the order its first link is written; a link with no place is listed, and never edited.
	const before = text.slice(0, start).split("\n").length - 1;
	const seen = new Set<string>();
	const links: DocLink[] = [];
	found.forEach((href, index) => {
		const spot = sure[index] ? spots[index] : null;
		const key = spot ? keyOf(spot) : `none:${href}`;
		if (seen.has(key)) return;
		seen.add(key);
		links.push({ href, file: linkFile(href), line: spot ? before + spot.line + 1 : 0, column: spot ? spot.at : 0 });
	});
	return links;
}

/**
 * The text with one link pointed at another file: the file part of the link
 * on that line is rewritten, and what follows "?" or "#" is kept (ADR 0002).
 * Of the path, only the parts that differ are written anew. A path in front
 * matter (`plain`) is not a link: it is written as it is, whole. Given its
 * column, the link must be there; without one, the first on the line is
 * taken. Null when the link is not where it was read.
 */
export function withLinkFile(text: string, line: number, href: string, instead: string, column?: number, plain = false): string | null {
	let start = 0;
	for (let at = 1; at < line; at++) {
		const end = text.indexOf("\n", start);
		if (end < 0) return null;
		start = end + 1;
	}
	const end = text.indexOf("\n", start);
	const here = text.slice(start, end < 0 ? text.length : end);
	const at = column === undefined ? here.indexOf(href) : here.startsWith(href, column) ? column : -1;
	if (at < 0) return null;
	const rest = plain ? "" : (/[?#].*$/.exec(href)?.[0] ?? "");
	const anew = plain ? instead : `${linkWritten(instead, href.slice(0, href.length - rest.length))}${rest}`;
	return `${text.slice(0, start + at)}${anew}${text.slice(start + at + href.length)}`;
}

/** A link to rewrite: where it is, as it was read, and the file to name in its place. */
export type LinkEdit = { line: number; column?: number; href: string; instead: string; /** Written as it is, with no escape: a path in front matter. */ plain?: boolean };

/**
 * The text with each of these links pointed at its new file, and how many
 * were: the last in the text first, so that one edit does not move the
 * place of the next. A link that is no longer where it was read is left.
 */
export function withLinkFiles(text: string, edits: readonly LinkEdit[]): { text: string; done: number } {
	let done = 0;
	// Each place once: the same edit said twice would be made twice where the new name begins with the old.
	const once = [...new Map(edits.map((edit) => [`${edit.line}:${edit.column ?? ""}:${edit.href}`, edit])).values()];
	for (const edit of once.sort((a, b) => b.line - a.line || (b.column ?? 0) - (a.column ?? 0))) {
		const next = withLinkFile(text, edit.line, edit.href, edit.instead, edit.column, edit.plain);
		if (next === null) continue;
		text = next;
		done++;
	}
	return { text, done };
}

/**
 * A document that is moved to another folder has links of its own, written
 * from where it was: each is to be written from where it is now. A link from
 * the project's top, and one that already reads the same, is left.
 */
export function ownLinkEdits(text: string, from: string, to: string): LinkEdit[] {
	const [was, now] = [dirName(from), dirName(to)];
	if (was === now) return [];
	return fileLinks(text).flatMap((link) => {
		if (!link.line || link.file.startsWith("/")) return [];
		const target = resolvePath(was, link.file);
		// A link to itself follows it.
		const instead = relativePath(now, target === from ? to : target);
		return instead === link.file ? [] : [{ line: link.line, column: link.column, href: link.href, instead }];
	});
}

/** The keys of a document's front matter whose values are files, named from the project's top: a ticket's specs, a spec's plan. */
const PATH_KEYS = new Set(["spec", "specs", "plan", "plans"]);

/**
 * The files a document's front matter names ("specs: [design/Due.spec.md]"),
 * each with its place in the text: not links, but a rename leaves them
 * naming the old file all the same.
 */
export function frontPaths(text: string): { value: string; line: number; column: number }[] {
	const count = frontMatter(text).lines;
	if (!count) return [];
	const found: { value: string; line: number; column: number }[] = [];
	let key = "";
	text
		.split(/\r?\n/)
		.slice(0, count)
		.forEach((line, index) => {
			const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
			const item = pair ? null : /^\s*-\s+(.*)$/.exec(line);
			if (pair) key = pair[1]!.toLowerCase();
			const rest = pair?.[2] ?? item?.[1];
			if (rest === undefined || !PATH_KEYS.has(key)) return;
			const at = line.length - rest.length;
			for (const match of rest.matchAll(/"([^"]*)"|'([^']*)'|([^\s,[\]"'#][^,[\]]*)/g)) {
				const quoted = match[1] !== undefined || match[2] !== undefined;
				const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
				if (value) found.push({ value, line: index + 1, column: at + match.index + (quoted ? 1 : 0) });
			}
		});
	return found;
}

/** A document to link to, as it is offered while a link is written: what it is called, where it is, and what to write. */
export type LinkChoice = { label: string; detail: string; insert: string };

/**
 * The project's documents as a link in one of them would name each: offered
 * when "](" is typed, so the path is not typed from memory. A ticket is
 * called by its key and its title; the path written is from the document
 * the link is in, a space as its escape.
 */
export function linkChoices(files: readonly DocFile[], path: string, root: string): LinkChoice[] {
	const dir = dirName(path);
	// The work first: a link in a working document is most often to a ticket, a spec or something learned.
	const order = ["tickets", "specs", "knowledge", "registries", "plans", "docs", "schema", "project"];
	return files
		.filter((file) => file.exists && file.path !== path)
		.map((file, index) => ({ file, index }))
		.sort((a, b) => order.indexOf(a.file.group) - order.indexOf(b.file.group) || a.index - b.index)
		.map(({ file }) => ({
			label: file.ticket ? [file.ticket, file.title].filter(Boolean).join(" ") : file.title || baseName(file.path),
			detail: relativeTo(root, file.path).split("\\").join("/"),
			insert: linkWritten(relativePath(dir, file.path)),
		}));
}

/** What has been typed of a link's target, when the cursor is in one: the text after "](" on this line, up to the cursor. Null anywhere else. */
export function linkBeingWritten(lineToCursor: string): string | null {
	const found = /\]\(<?([^()<>\s]*)$/.exec(lineToCursor);
	if (!found) return null;
	// In a span of code the same characters are an example of a link.
	const lead = lineToCursor.slice(0, found.index);
	return (lead.match(/`/g)?.length ?? 0) % 2 === 1 ? null : found[1]!;
}
