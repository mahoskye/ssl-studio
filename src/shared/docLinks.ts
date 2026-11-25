import { marked, type Token } from "marked";
import { fenced } from "./catalog";
import { bodyOffset, frontMatter, plainMarkdown } from "./frontMatter";
import { baseName, dirName, isInside, relativePath, relativeTo, resolvePath } from "./paths";
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
	const target = file.startsWith("/") ? resolvePath(root, file.replace(/^\/+/, "")) : resolvePath(dirName(from), file);
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

/**
 * Drops standalone plain-prose paragraphs (outside fenced code blocks and HTML blocks)
 * that cannot contain or affect Markdown links, preventing `marked.lexer` quadratic
 * scanning on large (100 KB–1 MB) Markdown documents while preserving exact link tokens.
 */
function compactForLinkScan(plain: string): string {
	if (plain.length <= 16_384) return plain;
	const lines = plain.split("\n");
	const kept: string[] = [];
	let block: string[] = [];
	let fenceChar = "";
	let fenceLen = 0;
	let inHtmlComment = false;
	const INTERESTING = /[\[\]`~<>]/;
	const LIST_START = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;

	const flushBlock = (keepAlways: boolean) => {
		if (!block.length) return;
		if (keepAlways || block.some((l) => INTERESTING.test(l) || LIST_START.test(l))) {
			if (kept.length) kept.push("");
			kept.push(...block);
		}
		block = [];
	};

	for (const line of lines) {
		if (!fenceChar && !inHtmlComment && !line.trim()) {
			flushBlock(false);
			continue;
		}
		if (!fenceChar) {
			const fm = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
			if (fm) {
				fenceChar = fm[1]![0]!;
				fenceLen = fm[1]!.length;
			}
		} else {
			const fm = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
			if (fm && fm[1]![0] === fenceChar && fm[1]!.length >= fenceLen) {
				fenceChar = "";
				fenceLen = 0;
			}
		}
		if (!fenceChar) {
			if (!inHtmlComment && line.includes("<!--") && !line.includes("-->")) inHtmlComment = true;
			else if (inHtmlComment && line.includes("-->")) inHtmlComment = false;
		}
		block.push(line);
	}
	flushBlock(Boolean(fenceChar || inHtmlComment));
	return kept.join("\n");
}

/** The targets of a Markdown text's links and images that name a file, in the order the renderer has them. Null when it cannot be read. */
function targets(plain: string): string[] | null {
	const found: string[] = [];
	try {
		marked.walkTokens(marked.lexer(compactForLinkScan(plain), { gfm: true }), (token: Token) => {
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
	const targetSet = new Set(longest);
	lines.forEach((line, at) => {
		const prevEndsOpen = /\](?:\(|:)[ \t]*$/.test(lines[at - 1] ?? "");
		if (!line.includes("]") && !prevEndsOpen) return;
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
		// Also locate raw backslash-escaped link destinations (e.g. `foo\(1\).md`) whose unescaped `hrefWritten` matches a target.
		if (line.includes("\\")) {
			const openings: { pos: number; angle: boolean }[] = [];
			if (prevEndsOpen) {
				let p = 0;
				while (p < line.length && (line[p] === " " || line[p] === "\t" || line[p] === ">")) p++;
				if (line[p] === "<") openings.push({ pos: p + 1, angle: true });
				else if (p < line.length) openings.push({ pos: p, angle: false });
			}
			const openRe = /\](?:\(|:)[ \t]*/g;
			let om: RegExpExecArray | null;
			while ((om = openRe.exec(line)) !== null) {
				const p = om.index + om[0].length;
				if (line[p] === "<") openings.push({ pos: p + 1, angle: true });
				else if (p < line.length) openings.push({ pos: p, angle: false });
			}
			for (const { pos, angle } of openings) {
				let end = pos;
				if (angle) {
					while (end < line.length) {
						if (line[end] === "\\" && end + 1 < line.length) {
							end += 2;
							continue;
						}
						if (line[end] === ">") break;
						end++;
					}
					if (line[end] !== ">") continue;
				} else {
					let parenDepth = 0;
					while (end < line.length) {
						const ch = line[end]!;
						if (ch === "\\" && end + 1 < line.length) {
							end += 2;
							continue;
						}
						if (ch === "(") parenDepth++;
						else if (ch === ")") {
							if (parenDepth === 0) break;
							parenDepth--;
						} else if (ch === " " || ch === "\t") {
							break;
						}
						end++;
					}
				}
				const raw = line.slice(pos, end);
				if (!raw || !raw.includes("\\")) continue;
				if (!targetSet.has(hrefWritten(raw))) continue;
				if (taken.some(([from, to]) => pos < to && end > from)) continue;
				taken.push([pos, end]);
				found.push({ line: at, at: pos, length: raw.length });
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
			// The place must hold this link's own target (exact or backslash-escaped): a name read back for another's is not an answer.
			if (!spot) return undefined;
			const raw = lines[spot.line]!.slice(spot.at, spot.at + spot.length);
			return raw === href || hrefWritten(raw) === href ? spot : undefined;
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
		const rawHref = placed ? lines[placed.line]!.slice(placed.at, placed.at + placed.length) : href;
		links.push({ href: rawHref, file: linkFile(href), line: placed ? before + placed.line + 1 : 0, column: placed ? placed.at : 0 });
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
	let prevStart = -1;
	for (let at = 1; at < line; at++) {
		const end = text.indexOf("\n", start);
		if (end < 0) return null;
		prevStart = start;
		start = end + 1;
	}
	const end = text.indexOf("\n", start);
	const here = text.slice(start, end < 0 ? text.length : end);
	const prevLine = prevStart >= 0 ? text.slice(prevStart, start - 1).replace(/\r$/, "") : "";
	let at = -1;
	if (column !== undefined) {
		at = here.startsWith(href, column) ? column : -1;
	} else if (plain) {
		at = here.indexOf(href);
	} else {
		for (let pos = here.indexOf(href); pos >= 0; pos = here.indexOf(href, pos + 1)) {
			const after = here[pos + href.length];
			const validMd = afterOpening(here, pos, prevLine) && (after === undefined || /[\s)>]/.test(after));
			const validWiki = pos >= 2 && here.slice(pos - 2, pos) === "[[" && (after === "]" || after === "|" || after === "#");
			if (validMd || validWiki) {
				at = pos;
				break;
			}
		}
	}
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
	const isWin = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\");
	const cleanPath = (p: string) => {
		const f = p.replace(/\\/g, "/").replace(/(?!^)\/+/g, "/");
		return f.length > 1 && !/^[a-zA-Z]:\/$/.test(f) ? f.replace(/\/+$/, "") : f;
	};
	const samePath = (a: string, b: string) => {
		const na = cleanPath(a);
		const nb = cleanPath(b);
		return isWin(a) || isWin(b) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
	};
	const relForMove = (fromDir: string, toPath: string): string => {
		if (!isWin(fromDir) && !isWin(toPath)) return relativePath(fromDir, toPath);
		const fromSegs = fromDir.split(/[\\/]/).filter(Boolean);
		const toSegs = toPath.split(/[\\/]/).filter(Boolean);
		let same = 0;
		while (same < fromSegs.length && same < toSegs.length && fromSegs[same]!.toLowerCase() === toSegs[same]!.toLowerCase()) same++;
		return [...fromSegs.slice(same).map(() => ".."), ...toSegs.slice(same)].join("/");
	};

	const [was, now] = [cleanPath(dirName(from)), cleanPath(dirName(to))];
	const rawMoves = moved ? (Array.isArray(moved) ? [...moved] : [moved]) : [];
	if (samePath(was, now) && !rawMoves.length) return [];
	const moves = rawMoves.map((m) => ({
		from: cleanPath(m.from),
		to: cleanPath(m.to),
		fromSegs: cleanPath(m.from).split("/").filter(Boolean),
	}));
	// Longest `from` first so exact file moves (e.g. `OLD/OLD.md -> NEW/NEW.md`) take precedence over their containing folder move (`OLD -> NEW`).
	moves.sort((a, b) => b.from.length - a.from.length);
	const destinationOf = (target: string): string => {
		const targetNorm = cleanPath(target);
		let dest = samePath(targetNorm, from) ? cleanPath(to) : targetNorm;
		for (const m of moves) {
			if (samePath(targetNorm, m.from)) {
				dest = m.to;
				break;
			}
			if (isInside(m.from, targetNorm)) {
				const targetSegs = targetNorm.split("/").filter(Boolean);
				const suffix = targetSegs.slice(m.fromSegs.length).join("/");
				dest = suffix ? (m.to.endsWith("/") ? `${m.to}${suffix}` : `${m.to}/${suffix}`) : m.to;
				break;
			}
		}
		return dest;
	};
	const frontEdits: LinkEdit[] = frontPaths(text).flatMap((named) => {
		const relVal = named.value.replace(/\\/g, "/");
		if (!/^\.{1,2}\//.test(relVal)) return [];
		const target = resolvePath(was, relVal);
		const dest = destinationOf(target);
		let instead = relForMove(now, dest);
		if (!instead) instead = ".";
		else if (!instead.startsWith(".")) instead = `./${instead}`;
		return instead === relVal ? [] : [{ line: named.line, column: named.column, href: named.value, instead, plain: true }];
	});
	const bodyEdits: LinkEdit[] = fileLinks(text).flatMap((link) => {
		if (!link.line || link.file.startsWith("/")) return [];
		const target = resolvePath(was, link.file);
		const dest = destinationOf(target);
		const instead = relForMove(now, dest);
		// What would be written is compared with what is: a folder written with its slash reads the same without it.
		const asWritten = link.href.replace(/[?#].*$/, "");
		return instead === link.file || linkWritten(instead, asWritten) === asWritten ? [] : [{ line: link.line, column: link.column, href: link.href, instead }];
	});
	return [...frontEdits, ...bodyEdits];
}

/** The keys of a document's front matter whose values are files, named from the project's top: a ticket's specs, a spec's plan, a schema doc's SQL source. */
const PATH_KEYS = new Set(["spec", "specs", "plan", "plans", "source"]);

/** Strips an outside-quote YAML inline comment (` # ...`) without changing leading character offsets. */
function stripYamlInlineComment(raw: string): string {
	let quote = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (quote) {
			if (quote === '"' && ch === "\\" && i + 1 < raw.length) {
				i++;
				continue;
			}
			if (quote === "'" && ch === "'" && raw[i + 1] === "'") {
				i++;
				continue;
			}
			if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) {
			return raw.slice(0, i);
		}
	}
	return raw;
}

/**
 * The files a document's front matter names ("specs: [docs/specs/Due.md]"),
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
			const cleanRest = stripYamlInlineComment(rest);
			for (const match of cleanRest.matchAll(/"([^"]*)"|'([^']*)'|([^\s,[\]"'#][^,[\]]*)/g)) {
				const quoted = match[1] !== undefined || match[2] !== undefined;
				const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
				if (value && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
					found.push({ value, line: index + 1, column: at + match.index + (quoted ? 1 : 0) });
				}
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

/** Splits a single Markdown line into plain and CommonMark §6.1 equal-length backtick inline-code spans. */
function splitInlineCodeSpans(line: string): { text: string; isCode: boolean }[] {
	const out: { text: string; isCode: boolean }[] = [];
	let plainStart = 0;
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\\" && i + 1 < line.length) {
			i += 2;
			continue;
		}
		if (line[i] === "`") {
			let run = 1;
			while (i + run < line.length && line[i + run] === "`") run++;
			let j = i + run;
			let closeStart = -1;
			while (j < line.length) {
				if (line[j] === "`") {
					let cRun = 1;
					while (j + cRun < line.length && line[j + cRun] === "`") cRun++;
					if (cRun === run) {
						closeStart = j;
						break;
					}
					j += cRun;
				} else {
					j++;
				}
			}
			if (closeStart >= 0) {
				if (i > plainStart) out.push({ text: line.slice(plainStart, i), isCode: false });
				const closeEnd = closeStart + run;
				out.push({ text: line.slice(i, closeEnd), isCode: true });
				i = closeEnd;
				plainStart = i;
				continue;
			}
			// No matching closing backtick run: treat opening ticks as literal prose.
			i += run;
			continue;
		}
		i++;
	}
	if (plainStart < line.length) out.push({ text: line.slice(plainStart), isCode: false });
	return out;
}

/** Verifies optional whitespace + optional Markdown link title (`"..."`, `'...'`, `(...)`) followed by closing `)`. Returns index of `)` or -1. */
function scanLinkCloseAfterDest(seg: string, destEnd: number): number {
	let p = destEnd;
	while (p < seg.length && (seg[p] === " " || seg[p] === "\t")) p++;
	if (seg[p] === ")") return p;
	if (p === destEnd) return -1;
	const q = seg[p];
	if (q === '"' || q === "'") {
		p++;
		while (p < seg.length) {
			if (seg[p] === "\\" && p + 1 < seg.length) {
				p += 2;
				continue;
			}
			if (seg[p] === q) {
				p++;
				break;
			}
			p++;
		}
		if (seg[p - 1] !== q) return -1;
	} else if (q === "(") {
		p++;
		while (p < seg.length) {
			if (seg[p] === "\\" && p + 1 < seg.length) {
				p += 2;
				continue;
			}
			if (seg[p] === "(") return -1;
			if (seg[p] === ")") {
				p++;
				break;
			}
			p++;
		}
		if (seg[p - 1] !== ")") return -1;
	} else {
		return -1;
	}
	while (p < seg.length && (seg[p] === " " || seg[p] === "\t")) p++;
	return seg[p] === ")" ? p : -1;
}

/**
 * Rewrites Markdown `#anchor` links (`[text](path#old-anchor)` / `[text](#old-anchor)`)
 * and wikilink/embed heading fragments (`[[Target#Old Heading]]`, `![[Target#Old Heading|Alias]]`)
 * in a single document when a heading is renamed (ADR 0002, ADR 0017).
 * Skips YAML frontmatter and fenced code blocks.
 */
export function rewriteHeadingReferences(
	markdown: string,
	options: {
		isSameDoc: boolean;
		matchesDocHref: (hrefPath: string) => boolean;
		matchesWikiTarget: (name: string) => boolean;
		oldHeading: string;
		oldAnchor: string;
		newHeading: string;
		newAnchor: string;
	},
): { text: string; count: number } {
	const fmLines = frontMatter(markdown).lines;
	const lines = markdown.split(/(\r?\n)/);
	const oldSlug = options.oldAnchor.toLowerCase();
	const oldHeadingLower = options.oldHeading.trim().toLowerCase();
	let count = 0;
	let fenceChar = "";
	let fenceLen = 0;
	const slugOf = (words: string) =>
		words
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s-]/gu, "")
			.replace(/\s+/g, "-");
	// A heading's words name the first heading that has them. A later heading with the same words has a numbered
	// anchor (`notes-1`), and a link written with the words alone, `#notes` or `[[#Notes]]`, leads to the first:
	// when the later one is renamed such a link is not its own, and when a heading is renamed to words an earlier
	// one has, only its anchor says which of the two is meant.
	const oldIsFirst = slugOf(plainMarkdown(options.oldHeading).trim()) === oldSlug;
	const newIsFirst = slugOf(plainMarkdown(options.newHeading).trim()) === options.newAnchor.toLowerCase();

	const matchesAnchor = (rawFragment: string) => {
		let decoded = rawFragment;
		try {
			decoded = decodeURIComponent(rawFragment);
		} catch {
			// keep raw
		}
		const trimmed = decoded.trim();
		if (trimmed.toLowerCase() === oldSlug) return true;
		if (oldIsFirst && trimmed.toLowerCase() === oldHeadingLower) return true;
		return slugOf(trimmed) === oldSlug;
	};

	const rewriteMarkdownLinks = (seg: string): { text: string; changed: boolean } => {
		let out = "";
		let cursor = 0;
		let changed = false;
		let i = 0;
		while (i < seg.length) {
			const openIdx = seg.indexOf("](", i);
			if (openIdx < 0) break;
			// Ensure `]` is not escaped by an odd number of backslashes.
			let bs = 0;
			for (let k = openIdx - 1; k >= 0 && seg[k] === "\\"; k--) bs++;
			if (bs % 2 === 1) {
				i = openIdx + 2;
				continue;
			}
			let destStart = openIdx + 2;
			while (destStart < seg.length && (seg[destStart] === " " || seg[destStart] === "\t")) destStart++;
			if (destStart >= seg.length) break;

			let innerStart: number;
			let innerEnd: number;
			let closeParen: number;

			if (seg[destStart] === "<") {
				let gt = destStart + 1;
				while (gt < seg.length) {
					if (seg[gt] === "\\" && gt + 1 < seg.length) {
						gt += 2;
						continue;
					}
					if (seg[gt] === "<") {
						gt = -1;
						break;
					}
					if (seg[gt] === ">") break;
					gt++;
				}
				if (gt < 0 || seg[gt] !== ">") {
					i = openIdx + 2;
					continue;
				}
				closeParen = scanLinkCloseAfterDest(seg, gt + 1);
				if (closeParen < 0) {
					i = openIdx + 2;
					continue;
				}
				innerStart = destStart + 1;
				innerEnd = gt;
			} else {
				let p = destStart;
				let parenDepth = 0;
				while (p < seg.length) {
					const ch = seg[p]!;
					if (ch === "\\" && p + 1 < seg.length) {
						p += 2;
						continue;
					}
					if (ch === "(") parenDepth++;
					else if (ch === ")") {
						if (parenDepth === 0) break;
						parenDepth--;
					} else if (ch === " " || ch === "\t") {
						break;
					}
					p++;
				}
				if (parenDepth !== 0) {
					i = openIdx + 2;
					continue;
				}
				closeParen = scanLinkCloseAfterDest(seg, p);
				if (closeParen < 0) {
					i = openIdx + 2;
					continue;
				}
				innerStart = destStart;
				innerEnd = p;
			}

			const rawDest = seg.slice(innerStart, innerEnd);
			const hashIdx = rawDest.indexOf("#");
			if (hashIdx >= 0 && hashIdx + 1 < rawDest.length) {
				const pathPart = rawDest.slice(0, hashIdx);
				const frag = rawDest.slice(hashIdx + 1);
				const targetMatch =
					pathPart === ""
						? options.isSameDoc
						: options.matchesDocHref(pathPart) || options.matchesDocHref(hrefWritten(pathPart));
				if (targetMatch && matchesAnchor(frag)) {
					const fragStart = innerStart + hashIdx + 1;
					out += seg.slice(cursor, fragStart) + options.newAnchor;
					cursor = innerEnd;
					count++;
					changed = true;
				}
			}
			i = closeParen + 1;
		}
		if (!changed) return { text: seg, changed: false };
		return { text: out + seg.slice(cursor), changed: true };
	};

	for (let idx = 0; idx < lines.length; idx += 2) {
		const lineNum = idx / 2;
		const line = lines[idx]!;
		if (lineNum < fmLines) continue;
		const fm = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
		if (fm) {
			const ch = fm[1]![0]!;
			const len = fm[1]!.length;
			const rest = line.slice(fm[0].length);
			if (!fenceChar) {
				// Per CommonMark §4.5, a backtick fence info string cannot contain backticks.
				if (!(ch === "`" && rest.includes("`"))) {
					fenceChar = ch;
					fenceLen = len;
					continue;
				}
			} else {
				if (ch === fenceChar && len >= fenceLen && /^[ \t]*$/.test(rest)) {
					fenceChar = "";
					fenceLen = 0;
				}
				continue;
			}
		}
		if (fenceChar) continue;

		// Split out CommonMark inline code spans so we never rewrite examples inside backticks.
		const segs = splitInlineCodeSpans(line);
		let changed = false;
		for (const part of segs) {
			if (part.isCode) continue;
			// 1. Markdown links: `[label](path#anchor)`, `[label](foo_(bar).md#anchor)`, `[label](<my file.md#anchor> "Title")`
			const mdRes = rewriteMarkdownLinks(part.text);
			let seg = mdRes.text;
			if (mdRes.changed) changed = true;
			// 2. Wikilinks / embeds: `[[Target#Heading]]`, `[[#Heading]]`, `![[Target#Heading|Alias]]`
			seg = seg.replace(/(!?\[\[)([^[\]|#]*)#([^[\]|]+)((?:\\?\|[^[\]]*)?\]\])/g, (full, open: string, target: string, frag: string, rest: string) => {
				const t = target.trim();
				const targetMatch = t === "" ? options.isSameDoc : options.matchesWikiTarget(t);
				if (!targetMatch || !matchesAnchor(frag)) return full;
				count++;
				changed = true;
				const replacement = !newIsFirst || (frag.trim().toLowerCase() === oldSlug && frag.includes("-") && !frag.includes(" ")) ? options.newAnchor : options.newHeading;
				return `${open}${target}#${replacement}${rest}`;
			});
			part.text = seg;
		}
		if (changed) lines[idx] = segs.map((s) => s.text).join("");
	}

	return { text: count ? lines.join("") : markdown, count };
}

/** A file that is shown as a picture where it is embedded: found as a picture is, never as a document by its name. */
const PICTURE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
export const isPictureName = (name: string) => PICTURE.test(name);

/**
 * The file a bare name (`shot.png`, with no folder) in an embed or a link by name leads to from the document
 * that holds it, as the page finds it (the order is the one of `resolveImageTarget` in the view): the file of
 * that name beside the document; then, for a picture, the attachment folders (the configured one, the
 * document's own attachments, assets and images, the docs folder's, the project's assets and images) and at
 * last the file of that name nearest the document; for any other file, the one at the project's top. Null
 * where no file answers. Two tickets may each keep an `attachments/shot.png`: which of them a name means
 * depends on the document it is written in, so a rename of the one must not be followed in the other.
 */
export function bareNameTarget(
	name: string,
	holder: string,
	files: readonly string[],
	where: { root: string; docs?: string | null; attachments?: string | null },
): string | null {
	const byLower = new Map(files.map((file) => [file.toLowerCase(), file]));
	const within = (dir: string) => byLower.get(resolvePath(dir, name).toLowerCase()) ?? null;
	const docDir = dirName(holder);
	const beside = within(docDir);
	if (beside) return beside;
	if (!PICTURE.test(name)) return within(where.root);
	const docsDir = resolvePath(where.root, where.docs || "docs");
	const docsRoot = isInside(where.root, docsDir) ? docsDir : resolvePath(where.root, "docs");
	const configured = where.attachments?.trim() ? resolvePath(where.root, where.attachments.trim()) : null;
	const folders = [
		...(configured && isInside(where.root, configured) ? [configured] : []),
		...["attachments", "assets", "images"].map((folder) => resolvePath(docDir, folder)),
		...["attachments", "assets", "images"].map((folder) => resolvePath(docsRoot, folder)),
		resolvePath(where.root, "assets"),
		resolvePath(where.root, "images"),
	];
	for (const folder of folders) {
		const hit = within(folder);
		if (hit) return hit;
	}
	const wanted = name.toLowerCase();
	const named = files.filter((file) => baseName(file).toLowerCase() === wanted);
	if (!named.length) return null;
	return named.sort((a, b) => relativePath(docDir, a).length - relativePath(docDir, b).length)[0]!;
}
