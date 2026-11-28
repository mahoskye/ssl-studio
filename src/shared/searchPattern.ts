// What a search looks for, as the expression that finds it: the words as
// typed or as a regular expression, in any case or the case given, anywhere
// or as a whole word. The search across files and the replace across files
// find the same places because they are given the same expression.

import { folderPattern } from "./fileGlob";

/** As many results as a search gives back. With this many there may be more, and a replace would not know of them. */
export const SEARCH_LIMIT = 2000;
/** Maximum characters kept per search hit excerpt. */
export const SEARCH_LINE_WINDOW = 400;
/** Maximum single line length scanned or replaced with user-supplied regexes (guards against ReDoS on minified bundles). */
export const REGEX_MAX_LINE_LENGTH = 20_000;
/** The longest text of an open file that is sent to be searched, in characters: what the search reads of a file on disk, at most. */
export const SEARCH_MAX_TEXT = 4 * 1024 * 1024;
/** As much text of open files as one call of the search carries, in characters: a message to the backend has a largest size, and one over it ends the connection. */
export const SEARCH_OPEN_BATCH = 8 * 1024 * 1024;

/**
 * An open file as it is in the editor, unsaved changes and all, for a search to look in place of the file of
 * that name on disk. Without a text the file on disk is only left out: its text is too large to search, or
 * comes in a call of its own (`openBatches`).
 */
export type OpenText = { path: string; text?: string };

export type SearchOptions = {
	regex?: boolean;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	/** The files to look in, as a list of patterns (src/shared/fileGlob.ts); every file, when empty. */
	include?: string;
	/** The files to leave out, as a list of patterns. */
	exclude?: string;
	/** Explicit workspace-relative normalized path allowlist (matched verbatim, avoiding glob/comma splitting). */
	paths?: string[];
	/** Safe Docs guard for replace: skips YAML frontmatter keys, Markdown link targets, and invalid .plan.json edits. */
	safeDocs?: boolean;
	/** Adapts each replacement string to match the casing pattern of the text it replaces (VS Code Preserve Case). */
	preserveCase?: boolean;
	/** Honor default workspace excludes and root `.gitignore` when true (default); set false to search excluded files too. */
	useExcludes?: boolean;
	/** Per-file 1-based allowed line numbers for partial-line replace (keyed by path). */
	linesByPath?: Record<string, number[]>;
	/**
	 * For a replace, the mark (`textMark`) of each file's text as the search read it, keyed by path. Given, a file
	 * is replaced in only while its text is still that one: the lines allowed and the matches confirmed are those
	 * of the text that was searched, and in a file changed since they are other lines and other matches.
	 */
	asSearched?: Record<string, string>;
};

/**
 * A short mark of a text, to tell later whether a text is still the one that was searched. Two texts with the
 * same lines have the same mark whatever ends their lines ("\r\n" or "\n"): the editor keeps a text with one kind
 * of line end where the file may have both, and a search and a replace go by the lines, not by their ends.
 * Not a secret and not proof against someone who means to deceive it: it is for a file that was edited meanwhile.
 */
export function textMark(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	let length = 0;
	for (let at = 0; at < text.length; at++) {
		const unit = text.charCodeAt(at);
		if (unit === 13 && text.charCodeAt(at + 1) === 10) continue;
		h1 = Math.imul(h1 ^ unit, 2654435761);
		h2 = Math.imul(h2 ^ unit, 1597334677);
		length++;
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return `${length}:${(h2 >>> 0).toString(36)}.${(h1 >>> 0).toString(36)}`;
}

/**
 * The open files' texts for a search, in as many calls as keeps each within `most` characters. The first call is
 * the one that reads the files on disk, so it names every open file, with or without its text: each is left out
 * of what is read from disk. A text too large to search (`SEARCH_MAX_TEXT`) is in no call.
 */
export function openBatches(open: readonly OpenText[], most = SEARCH_OPEN_BATCH): OpenText[][] {
	const batches: OpenText[][] = [[]];
	let size = 0;
	for (const each of open) {
		if (each.text === undefined || each.text.length > SEARCH_MAX_TEXT) continue;
		if (size + each.text.length > most && batches[batches.length - 1]!.length) {
			batches.push([]);
			size = 0;
		}
		batches[batches.length - 1]!.push({ path: each.path, text: each.text });
		size += each.text.length;
	}
	const first = new Set(batches[0]!.map((each) => each.path));
	for (const each of open) if (!first.has(each.path)) batches[0]!.push({ path: each.path });
	return batches;
}

/**
 * Windows a long line to at most `maxLen` characters around a 1-based `column` so matches
 * near or beyond `maxLen` remain visible in search excerpts.
 */
export function excerptForMatch(
	line: string,
	column1Based: number,
	length = 0,
	maxLen = SEARCH_LINE_WINDOW,
	lead = 100,
): { text: string; textOffset: number } {
	if (line.length <= maxLen) return { text: line, textOffset: 0 };
	const matchStart = Math.max(0, column1Based - 1);
	const matchEnd = matchStart + Math.max(1, length);
	if (matchEnd <= maxLen - 40) return { text: line.slice(0, maxLen), textOffset: 0 };
	const offset = Math.max(0, Math.min(matchStart - lead, line.length - maxLen));
	return { text: line.slice(offset, offset + maxLen), textOffset: offset };
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const WORD = "[\\p{L}\\p{N}_]";
/** Where a whole word may start: before a letter that has none before it, or before a mark. */
const STARTS = `(?:(?<!${WORD})(?=${WORD})|(?!${WORD}))`;
/** Where a whole word may end: after a letter that has none after it, or after a mark. */
const ENDS = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD}))`;
/** The same two places with the plain letters only, for an expression that cannot be read the Unicode way. */
const PLAIN = "[A-Za-z0-9_]";
const PLAIN_STARTS = `(?:(?<!${PLAIN})(?=${PLAIN})|(?!${PLAIN}))`;
const PLAIN_ENDS = `(?:(?<=${PLAIN})(?!${PLAIN})|(?<!${PLAIN}))`;

/**
 * The expression for a search. A whole word is one with no letter, digit or
 * underscore beside its own first and last letters: "Due" is not found in
 * "DueDate" nor in "Is_Due". What begins or ends with a mark (":RETURN") is
 * whole on that side wherever it stands. Throws what the expression's own
 * reader throws when it cannot be read.
 *
 * Knowing every alphabet's letters needs the stricter, Unicode way of
 * reading an expression, which refuses some that are otherwise fine ("a\-b",
 * "a{"). Such an expression is not refused for asking for whole words: it is
 * read the way it reads without, and a word's edge is then a plain letter's.
 */
export function searchPattern(query: string, options: SearchOptions = {}): RegExp {
	const source = options.regex ? query : literal(query);
	const flags = `g${options.caseSensitive ? "" : "i"}`;
	if (!options.wholeWord) return new RegExp(source, flags);
	try {
		return new RegExp(`${STARTS}(?:${source})${ENDS}`, `${flags}u`);
	} catch (strict) {
		if (!options.regex) throw strict;
		// What cannot be read either way is the expression's own fault, and says so as it would without whole words.
		new RegExp(source, flags);
		return new RegExp(`${PLAIN_STARTS}(?:${source})${PLAIN_ENDS}`, flags);
	}
}

/** What of a match its replacement is made from: the whole match first, then its groups, and its named groups. */
type Matched = { readonly [index: number]: string | undefined; readonly length: number; readonly groups?: Record<string, string | undefined> };

/**
 * Where one group of a regular expression matched on its line: from this character to before that one, counted
 * from 0. Null for a group that took no part in the match.
 */
export type Span = [number, number] | null;
/**
 * Where the groups of a match lie, by number (the first group first) and by name. Only a search that is to be
 * replaced from has them (`withGroups`): with them what the match becomes is worked out where the expression
 * itself may not be run (`becomesFound`).
 */
export type Groups = { groups?: Span[]; named?: Record<string, Span> };
/** A match as a search found it: its line and its column, both counted from 1, and its length. */
export type Found = { line: number; column: number; length: number } & Groups;

/** The same expression, saying of each match where its groups lie (`matchesOn` then gives them). */
export function withGroups(pattern: RegExp): RegExp {
	return pattern.hasIndices ? pattern : new RegExp(pattern.source, `${pattern.flags}d`);
}

const hasUpper = (text: string) => text !== text.toLowerCase();
const hasLower = (text: string) => text !== text.toUpperCase();

function applySingleCase(matched: string, replacement: string): string {
	if (!matched || !replacement) return replacement;
	const upper = hasUpper(matched);
	const lower = hasLower(matched);
	if (!upper && !lower) return replacement;
	if (!upper) return replacement.toLowerCase();
	if (!lower) return replacement.toUpperCase();
	const firstMatchedLetter = matched.match(/\p{L}/u)?.[0];
	if (!firstMatchedLetter) return replacement;
	const startsUpper = firstMatchedLetter === firstMatchedLetter.toUpperCase() && firstMatchedLetter !== firstMatchedLetter.toLowerCase();
	const repMatch = /\p{L}/u.exec(replacement);
	if (!repMatch) return replacement;
	const idx = repMatch.index;
	const lead = replacement.slice(0, idx);
	const first = repMatch[0]!;
	const rest = replacement.slice(idx + first.length);
	const repAllUpper = hasUpper(replacement) && !hasLower(replacement);
	if (startsUpper) {
		const restMatched = matched.slice(matched.indexOf(firstMatchedLetter) + firstMatchedLetter.length);
		const pureTitle = !hasUpper(restMatched);
		return lead + first.toUpperCase() + (pureTitle && repAllUpper ? rest.toLowerCase() : rest);
	}
	return lead + first.toLowerCase() + (repAllUpper ? rest.toLowerCase() : rest);
}

/**
 * Adapts `replacement` to mirror the casing style of `matched` (VS Code Preserve Case `AB`):
 * all-lowercase, ALL-UPPERCASE, Title/PascalCase, camelCase, and matching `-` / `_` segments.
 */
export function applyPreserveCase(matched: string, replacement: string): string {
	if (!matched || !replacement) return replacement;
	for (const sep of ["-", "_"] as const) {
		if (matched.includes(sep) && replacement.includes(sep)) {
			const mParts = matched.split(sep);
			const rParts = replacement.split(sep);
			if (mParts.length === rParts.length) {
				return rParts.map((part, i) => applySingleCase(mParts[i]!, part)).join(sep);
			}
		}
	}
	return applySingleCase(matched, replacement);
}

/**
 * What one match becomes. For words as typed, the replacement as typed. For
 * a regular expression, the replacement with its marks filled in from the
 * match: "$1" to "$99" the groups, "$<name>" a named group, "$&" the whole
 * match, "$$" a dollar. A group the expression does not have is left as it
 * was written. When `preserveCase` is on, the casing of the matched text is
 * carried onto the replacement.
 */
export function replacementFor(match: Matched, replacement: string, regex: boolean, preserveCase = false): string {
	const raw = !regex
		? replacement
		: replacement.replace(/\$(?:(\$)|(&)|<([^>]+)>|(\d{1,2}))/g, (written, dollar, whole, name, digits: string | undefined) => {
				if (dollar) return "$";
				if (whole) return match[0] ?? "";
				if (name !== undefined) return match.groups && name in match.groups ? (match.groups[name] ?? "") : written;
				// "$12" is group 12 where there is one, else group 1 and a "2".
				const two = Number(digits);
				if (two >= 1 && two < match.length) return match[two] ?? "";
				const one = Number(digits![0]);
				return digits!.length === 2 && one >= 1 && one < match.length ? (match[one] ?? "") + digits![1] : written;
			});
	return preserveCase ? applyPreserveCase(match[0] ?? "", raw) : raw;
}

/**
 * Every match on one line, left to right, with what it becomes. The same walk a search makes.
 *
 * `clock` is for a walk with a time to be done by: after a match that came later than `until` the walk stops and
 * sets `late`. A regular expression can be long in finding each of many matches on one line, and a caller that
 * looks at its clock only between lines was held by that line for as long as it took.
 */
export function matchesOn(
	line: string,
	pattern: RegExp,
	replacement: string,
	regex: boolean,
	maxMatches = Infinity,
	clock?: { until: number; late?: boolean },
	preserveCase = false,
): ({ column: number; length: number; becomes: string } & Groups)[] {
	const out: ({ column: number; length: number; becomes: string } & Groups)[] = [];
	if (maxMatches <= 0) return out;
	pattern.lastIndex = 0;
	let match: RegExpExecArray | null;
	while (out.length < maxMatches && (match = pattern.exec(line))) {
		const each: (typeof out)[number] = { column: match.index + 1, length: match[0].length, becomes: replacementFor(match, replacement, regex, preserveCase) };
		if (match.indices && match.length > 1) {
			const span = (pair: [number, number] | undefined): Span => (pair ? [pair[0], pair[1]] : null);
			each.groups = Array.from(match.indices, span).slice(1);
			const named = match.indices.groups;
			if (named) each.named = Object.fromEntries(Object.entries(named).map(([name, pair]) => [name, span(pair)]));
		}
		out.push(each);
		// After a match of nothing the walk steps on by a whole character. A character outside the first plane is
		// two units of the string: one step would land between its halves, to split it in two or never get past it.
		if (!match[0].length) pattern.lastIndex = match.index + ((line.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1);
		if (clock && performance.now() > clock.until) {
			clock.late = true;
			break;
		}
	}
	return out;
}

/**
 * What a match that a search found becomes, worked out from where the search says it and its groups lie, with no
 * second run of the expression. The window works out a replace this way: a regular expression can take minutes
 * over one line, nothing can stop it once it runs, and run in the window it froze the window. `text` is the
 * match's line, or the part of it from `offset` on; undefined when the match or one of its groups lies outside it.
 */
export function becomesFound(
	text: string,
	offset: number,
	found: Omit<Found, "line">,
	replacement: string,
	regex: boolean,
	preserveCase = false,
): string | undefined {
	if (!regex && !preserveCase) return replacement;
	let outside = false;
	const part = (from: number, to: number) => {
		if (from < offset || to > offset + text.length || to < from) outside = true;
		return outside ? "" : text.slice(from - offset, to - offset);
	};
	if (!regex) {
		const matched = part(found.column - 1, found.column - 1 + found.length);
		return outside ? undefined : applyPreserveCase(matched, replacement);
	}
	const group = (span: Span) => (span ? part(span[0], span[1]) : undefined);
	const match: (string | undefined)[] & { groups?: Record<string, string | undefined> } = [
		part(found.column - 1, found.column - 1 + found.length),
		...(found.groups ?? []).map(group),
	];
	if (found.named) match.groups = Object.fromEntries(Object.entries(found.named).map(([name, span]) => [name, group(span)]));
	return outside ? undefined : replacementFor(match, replacement, true, preserveCase);
}

/**
 * A text with the matches a search found in it replaced, and nothing else of it touched: the expression is not
 * run again (`becomesFound`), so what is replaced is what was listed. `skip` says which matches to leave (a
 * protected part of a document), and they are counted. The line ends stay as they are.
 *
 * Null when a match does not lie in the text as it is given, on a line it has not got or past the end of one:
 * this is not the text the matches were found in, and nothing is to be made of it.
 */
export function replaceFound(
	text: string,
	found: readonly Found[],
	replacement: string,
	regex: boolean,
	options: { skip?: (match: Found) => boolean; maxSamples?: number; preserveCase?: boolean } = {},
): {
	text: string;
	count: number;
	skipped: number;
	edits: { line: number; column: number; length: number; text: string }[];
	samples: { line: number; before: string; after: string }[];
} | null {
	const byLine = new Map<number, Found[]>();
	for (const each of found) {
		const list = byLine.get(each.line);
		if (list) list.push(each);
		else byLine.set(each.line, [each]);
	}
	// The lines and what ends each of them, turn about, as `replaceIn` has them.
	const parts = text.split(/(\r?\n)/);
	const maxSamples = options.maxSamples ?? 5;
	const keepCase = Boolean(options.preserveCase);
	const edits: { line: number; column: number; length: number; text: string }[] = [];
	const samples: { line: number; before: string; after: string }[] = [];
	let skipped = 0;
	for (const lineNumber of [...byLine.keys()].sort((a, b) => a - b)) {
		const at = (lineNumber - 1) * 2;
		if (!Number.isInteger(lineNumber) || lineNumber < 1 || at >= parts.length) return null;
		const line = parts[at]!;
		let out = "";
		let from = 0;
		let end = 0;
		for (const each of byLine.get(lineNumber)!.sort((a, b) => a.column - b.column)) {
			const start = each.column - 1;
			if (!Number.isInteger(start) || start < end || each.length < 0 || start + each.length > line.length) return null;
			end = start + each.length;
			if (options.skip?.(each)) {
				skipped++;
				continue;
			}
			const becomes = becomesFound(line, 0, each, replacement, regex, keepCase);
			if (becomes === undefined) return null;
			out += line.slice(from, start) + becomes;
			from = end;
			edits.push({ line: lineNumber, column: each.column, length: each.length, text: becomes });
		}
		const next = out + line.slice(from);
		if (samples.length < maxSamples && next !== line) samples.push({ line: lineNumber, before: line.trim(), after: next.trim() });
		parts[at] = next;
	}
	return { text: parts.join(""), count: edits.length, skipped, edits, samples };
}

/** One edit of a replace in an open file: the match's line and column, both counted from 1, its length, and what it becomes. */
export type ReplaceEdit = { line: number; column: number; length: number; text: string };

/**
 * What a replace makes of a text that was searched, from the matches listed in it: the text after, how many
 * matches, and the edits that make it so. Null when `text` is no longer the text that was searched (its mark is
 * not the one the search took, `textMark`): the matches listed, and the rows taken out of the list, are places in
 * that text. Replaced by its line numbers in a text with a line added above them since, a match the user had
 * taken out was replaced and the ones kept were left.
 *
 * `skip` leaves out protected matches, which are counted (`skippedProtected`). With `json`, a result that is no
 * longer a JSON object is not accepted (`invalidJson`, and nothing replaced). Both as `replaceSafeInText` has them.
 */
export function replaceSearched(
	text: string,
	mark: string | undefined,
	listed: readonly Found[] | undefined,
	replacement: string,
	regex: boolean,
	options: { skip?: (match: Found) => boolean; json?: boolean; maxSamples?: number; preserveCase?: boolean } = {},
): { text: string; count: number; skippedProtected: number; invalidJson: boolean; samples: { line: number; before: string; after: string }[]; edits: ReplaceEdit[] } | null {
	if (mark === undefined || textMark(text) !== mark) return null;
	const done = replaceFound(text, listed ?? [], replacement, regex, options);
	if (!done) return null;
	if (options.json && done.count > 0) {
		const left = { text, count: 0, skippedProtected: done.skipped, invalidJson: true, samples: done.samples, edits: [] };
		try {
			const parsed = JSON.parse(done.text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return left;
		} catch {
			return left;
		}
	}
	return { text: done.text, count: done.count, skippedProtected: done.skipped, invalidJson: false, samples: done.samples, edits: done.edits };
}

/** What the Search panel says of the files a replace left as they are, their text no longer being the one that was searched. */
export function changedSinceSearch(names: readonly string[]): string {
	if (names.length === 1) return `Not replaced in ${names[0]}: it has changed since the search. Search again to replace in it.`;
	const shown = names.slice(0, 5).join(", ");
	return `Not replaced in ${names.length} files (${shown}${names.length > 5 ? ", …" : ""}): they have changed since the search. Search again to replace in them.`;
}

/**
 * Which files a search of one folder looks in: the folder, as a pattern, and nothing left out. "Find in folder…"
 * set where to look and left what was being left out as it stood. After the Code scope, which leaves out the
 * documents, the plans and the schema, a search of one of those folders found nothing, and did not say why.
 */
export function folderScope(folder: string): { include: string; exclude: string } {
	return { include: folderPattern(folder), exclude: "" };
}

/** A text as a question shows it: whole, or with its middle left out where it is longer than a question can hold. */
const shown = (text: string, most = 120) => (text.length <= most ? text : `${text.slice(0, most - 40)} … ${text.slice(-30)}`);

/**
 * What was searched for, said as it was searched: the text between quotes, called a regular expression where it
 * was read as one, with the switches that were on by the names on their buttons.
 */
export function searchedWords(query: string, options: Pick<SearchOptions, "regex" | "caseSensitive" | "wholeWord"> = {}): string {
	const switches = [options.caseSensitive ? "match case" : "", options.wholeWord ? "whole word" : ""].filter(Boolean).join(", ");
	return `${options.regex ? "the regular expression " : ""}“${shown(query)}”${switches ? ` (${switches})` : ""}`;
}

/** What a replace is asked to confirm: the text that was searched and how, what it becomes, and in how much. */
export type ReplaceAsked = Pick<SearchOptions, "regex" | "caseSensitive" | "wholeWord"> & { query: string; replacement: string; matches: number; files: number };

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const becomes = (replacement: string) => (replacement ? `“${shown(replacement)}”` : "nothing");

/**
 * The question a replace across files asks before anything is written. It names the text that is replaced, as it
 * was searched, and what it becomes: it used to give only the number of matches and what they become, and the
 * text replaced is the one that was searched, which the search box need not hold any more.
 */
export function replaceQuestion(asked: ReplaceAsked & { safeDocs?: boolean }): string {
	const safeTail = asked.safeDocs ? " Safe docs skips YAML keys, Markdown link targets, and invalid .plan.json edits." : "";
	return `Replace ${counted(asked.matches, "match", "matches")} of ${searchedWords(asked.query, asked)} in ${counted(asked.files, "file", "files")} with ${becomes(asked.replacement)}? Each file that is written is first kept as it was in its local history.${safeTail}`;
}

/** The same said as the title of the preview, from which the replace can be made with no further question. */
export function replacePreviewTitle(asked: ReplaceAsked): string {
	return `Replace preview: ${searchedWords(asked.query, asked)} becomes ${becomes(asked.replacement)}, ${counted(asked.matches, "match", "matches")} in ${counted(asked.files, "file", "files")}`;
}

/**
 * Why nothing is replaced while the search box holds another text than the one the list was found for; "" while
 * it holds that one. What is replaced is what was searched: with a new text typed and Enter not pressed,
 * "Replace all" replaced the old one, which was no longer in the box and which the question did not name.
 */
export function searchBoxMoved(searched: string, inBox: string): string {
	return searched === inBox ? "" : `What is listed was found for “${shown(searched)}”, and the search box holds another text now: press Enter in it to search again first`;
}

/**
 * A text with every match replaced, and how many there were. Matches are
 * looked for a line at a time, as the search looks for them, so what is
 * replaced is what was found; the line ends stay as they are.
 */
export function replaceIn(text: string, query: string, replacement: string, options: SearchOptions = {}): { text: string; count: number } {
	const pattern = searchPattern(query, options);
	const isRegex = Boolean(options.regex);
	const keepCase = Boolean(options.preserveCase);
	let count = 0;
	// The lines and what ends each of them, turn about: only the lines are searched.
	const parts = text.split(/(\r?\n)/);
	for (let at = 0; at < parts.length; at += 2) {
		const line = parts[at]!;
		if (isRegex && line.length > REGEX_MAX_LINE_LENGTH) continue;
		const found = matchesOn(line, pattern, replacement, isRegex, Infinity, undefined, keepCase);
		if (!found.length) continue;
		count += found.length;
		let out = "";
		let from = 0;
		for (const each of found) {
			out += line.slice(from, each.column - 1) + each.becomes;
			from = each.column - 1 + each.length;
		}
		parts[at] = out + line.slice(from);
	}
	return { text: parts.join(""), count };
}
