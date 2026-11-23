import { marked, type Token } from "marked";
import { fenced } from "./catalog";
import { bodyOffset, frontMatter } from "./frontMatter";
import { baseName, dirName, isInside, joinPath, relativePath, relativeTo, resolvePath } from "./paths";
import { linkedLines } from "./projectDocs";
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

/**
 * A link's address as a renderer reads it, from how it stands in the text
 * between the link's round brackets: without the angle brackets that let it
 * hold a space, and with a backslash before a mark of punctuation taken as
 * the mark alone.
 */
export const hrefWritten = (raw: string) =>
	raw
		.trim()
		.replace(/^<(.*)>$/, "$1")
		.replace(/\\([!-/:-@[-`{-~])/g, "$1");

/** Where a link leads: out to the web, to a heading of its own document, or to a file of the project (at lines, when it names them). */
export type LinkLeads = { web: string } | { heading: string } | { file: string; lines?: { line: number; endLine?: number } };

/**
 * Where a link written in the document at `from` leads, for following it.
 * A path from the top is from the project's top, as a repository's page
 * reads it; any other is from the document's own folder. Null for a link
 * that leads nowhere the app goes: mail, another host's files, or a file
 * outside the project.
 */
export function linkLeads(href: string, from: string, root: string | null | undefined): LinkLeads | null {
	const written = href.trim();
	if (/^https?:/i.test(written)) return { web: written };
	if (written.startsWith("#")) {
		try {
			return { heading: decodeURIComponent(written.slice(1)) };
		} catch {
			return { heading: written.slice(1) };
		}
	}
	const file = linkFile(written);
	if (!file || !root) return null;
	const target = file.startsWith("/") ? joinPath(root, ...file.split("/").filter(Boolean)) : resolvePath(dirName(from), file);
	if (!isInside(root, target)) return null;
	const lines = linkedLines(written);
	return { file: target, ...(lines ? { lines } : {}) };
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
/** A name no document writes, put where a link's target may be, to ask the renderer which link's it is. */
const marker = (n: number) => `ssl-studio-place-${n}.x`;
const MARKER = /^ssl-studio-place-(\d+)\.x$/;

/** The lines with each of these places written over: each line once, however many places it holds. */
function written(lines: readonly string[], over: readonly [Spot, string][]): string {
	const byLine = new Map<number, [Spot, string][]>();
	for (const entry of over) byLine.set(entry[0].line, [...(byLine.get(entry[0].line) ?? []), entry]);
	return lines
		.map((line, at) => {
			const here = byLine.get(at);
			if (!here) return line;
			const parts: string[] = [];
			let from = 0;
			for (const [spot, text] of here.sort((a, b) => a[0].at - b[0].at)) {
				parts.push(line.slice(from, spot.at), text);
				from = spot.at + spot.length;
			}
			parts.push(line.slice(from));
			return parts.join("");
		})
		.join("\n");
}

/**
 * Whether what stands before a place is what stands before a link's target:
 * "](" or "]:", then spaces if any, then "<" if any. A target is never
 * written anywhere else, so the same words in a sentence are not a place.
 */
function afterOpening(line: string, column: number, above = ""): boolean {
	let at = column - 1;
	if (line[at] === "<") at--;
	while (at >= 0 && (line[at] === " " || line[at] === "\t" || line[at] === ">")) at--;
	if (at >= 0) return (line[at] === "(" || line[at] === ":") && line[at - 1] === "]";
	// Nothing before it on its own line: the opening may end the line above.
	return /\](?:\(|:)[ \t]*$/.test(above);
}

/**
 * Everywhere the text writes one of these targets where a link's target is
 * written: after "](" or "]:", and before ")", ">", a space or the line's
 * end. Where two overlap, the longer stands.
 */
function candidates(lines: readonly string[], targets: readonly string[]): Spot[] {
	const found: Spot[] = [];
	const longest = [...new Set(targets)].sort((a, b) => b.length - a.length);
	lines.forEach((line, at) => {
		if (!line.includes("]") && !/\](?:\(|:)[ \t]*$/.test(lines[at - 1] ?? "")) return;
		const taken: [number, number][] = [];
		for (const target of longest) {
			for (let column = line.indexOf(target); column >= 0; column = line.indexOf(target, column + 1)) {
				const after = line[column + target.length];
				if (!(after === undefined || /[\s)>]/.test(after)) || !afterOpening(line, column, lines[at - 1])) continue;
				if (taken.some(([from, to]) => column < to && column + target.length > from)) continue;
				taken.push([column, column + target.length]);
				found.push({ line: at, at: column, length: target.length });
			}
		}
	});
	return found;
}

/**
 * The links and images of a Markdown document that name a file, each once,
 * in the order they are written.
 *
 * Where each is in the text is asked of the renderer. Every place that
 * writes one of the targets as a target is written over with a name of its
 * own, the links are read again, and a link's place is the one whose name
 * the renderer now reads as its target. The answer is then asked once more,
 * with only the places it gave written over: a place is kept only if the
 * renderer still reads its name for that link. The same words in code, in a
 * comment or after a backslash are an example of a link, and no link reads
 * their name: an edit never lands there, and nothing here has to know what
 * code or a comment looks like to be sure of it.
 */
export function fileLinks(text: string): DocLink[] {
	const start = bodyOffset(text);
	const body = text.slice(start);
	if (!/\]\s*[(:[]/.test(body)) return [];
	const lines = body.split(/\r?\n/);
	const found = targets(lines.join("\n"));
	if (!found?.length) return [];

	/** For each link, the place whose name the renderer reads as its target when these places are written over. */
	const ask = (spots: readonly Spot[]): (Spot | undefined)[] | null => {
		const read = targets(written(lines, spots.map((spot, n) => [spot, marker(n)])));
		if (!read || read.length !== found.length) return null;
		return found.map((href, index) => {
			const named = MARKER.exec(read[index]!);
			const spot = named ? spots[Number(named[1])] : undefined;
			// The place must hold this link's own target: a name read back for another's is not an answer.
			return spot && spot.length === href.length && lines[spot.line]!.startsWith(href, spot.at) ? spot : undefined;
		});
	};
	const all = candidates(lines, found);
	let places = ask(all);
	if (!places) {
		// Writing over a place that is no link changed what the renderer takes for links: asked again without the
		// places in fenced code, which is where an example of a link most often is.
		const fences = fenced(lines.join("\n"));
		const starts: number[] = [];
		let offset = 0;
		for (const line of lines) {
			starts.push(offset);
			offset += line.length + 1;
		}
		places = ask(all.filter((spot) => !fences.some(([from, to]) => starts[spot.line]! >= from && starts[spot.line]! < to)));
	}
	// Asked once more, of the answers alone: what was read with every place written over must hold with only these.
	const chosen = [...new Map((places ?? []).flatMap((spot) => (spot ? [[`${spot.line}:${spot.at}`, spot] as const] : []))).values()];
	const again = chosen.length ? ask(chosen) : null;
	const same = (a: Spot | undefined, b: Spot | undefined) => Boolean(a && b && a.line === b.line && a.at === b.at);

	// Each place once, in the order its first link is written; a link with no place is listed, and never edited.
	const before = text.slice(0, start).split("\n").length - 1;
	const seen = new Set<string>();
	const links: DocLink[] = [];
	found.forEach((href, index) => {
		const placed = places && again && same(places[index], again[index]) ? places[index] : undefined;
		const key = placed ? `${placed.line}:${placed.at}` : `none:${href}`;
		if (seen.has(key)) return;
		seen.add(key);
		links.push({ href, file: linkFile(href), line: placed ? before + placed.line + 1 : 0, column: placed ? placed.at : 0 });
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
 * When `movedDir` is supplied (an entire folder moved together), links whose
 * target lies inside `movedDir.from` moved with the folder and stay intact.
 */
export function ownLinkEdits(
	text: string,
	from: string,
	to: string,
	moved?: { from: string; to: string } | readonly { from: string; to: string }[],
): LinkEdit[] {
	const [was, now] = [dirName(from), dirName(to)];
	const moves = moved ? (Array.isArray(moved) ? [...moved] : [moved]) : [];
	if (was === now && !moves.length) return [];
	// Longest `from` first so exact file moves (e.g. `OLD/OLD.md -> NEW/NEW.md`) take precedence over their containing folder move (`OLD -> NEW`).
	moves.sort((a, b) => b.from.length - a.from.length);
	return fileLinks(text).flatMap((link) => {
		if (!link.line || link.file.startsWith("/")) return [];
		const target = resolvePath(was, link.file);
		let dest = target === from ? to : target;
		for (const m of moves) {
			if (target === m.from) {
				dest = m.to;
				break;
			}
			if (isInside(m.from, target)) {
				dest = m.to + target.slice(m.from.length);
				break;
			}
		}
		const instead = relativePath(now, dest);
		// What would be written is compared with what is: a folder written with its slash reads the same without it.
		const asWritten = link.href.replace(/[?#].*$/, "");
		return instead === link.file || linkWritten(instead, asWritten) === asWritten ? [] : [{ line: link.line, column: link.column, href: link.href, instead }];
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

/** The kinds of document in the order links offer them, the work first: a link in a working document is most often to a ticket, a spec or something learned. */
export const DOC_ORDER = ["tickets", "specs", "knowledge", "registries", "plans", "docs", "schema", "project"] as const;

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
	const order: readonly string[] = DOC_ORDER;
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
