import { marked, type Token } from "marked";
import { fenced } from "./catalog";
import { bodyOffset, frontMatter } from "./frontMatter";
import { baseName, dirName, relativePath, relativeTo } from "./paths";
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

/** The links and images of a Markdown document that name a file, in the order they are written. */
export function fileLinks(text: string): DocLink[] {
	const start = bodyOffset(text);
	const body = text.slice(start);
	if (!/\]\s*[(:[]|<img|<a\s/i.test(body)) return [];
	const found: string[] = [];
	const see = (token: Token) => {
		if ((token.type === "link" || token.type === "image") && typeof token.href === "string" && linkFile(token.href)) found.push(token.href);
	};
	const lines = body.split(/\r?\n/);
	const plain = lines.join("\n");
	let tokens: Token[];
	try {
		tokens = marked.lexer(plain, { gfm: true });
		marked.walkTokens(tokens, see);
	} catch {
		return [];
	}
	if (!found.length) return [];

	// Each link is then placed in the text: the next place that writes it as a link's target. The same words in a
	// block of code, or in a span of it, are an example of a link and not one, and an edit must not land there.
	const closed = fenced(plain);
	let offset = 0;
	for (const token of tokens) {
		if (token.type === "code") closed.push([offset, offset + token.raw.length]);
		offset += token.raw.length;
	}
	const starts: number[] = [];
	offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	const inCode = (index: number) => closed.some(([from, to]) => starts[index]! >= from && starts[index]! < to);
	/** Where a line writes the link at or after a column, and how long it is as written there (a space may be its escape). */
	const place = (index: number, href: string, column = 0): { at: number; length: number } | null => {
		if (inCode(index)) return null;
		const line = lines[index]!;
		let first: { at: number; length: number } | null = null;
		for (const form of new Set([href, href.replace(/ /g, "%20")])) {
			for (let at = line.indexOf(form, column); at >= 0; at = line.indexOf(form, at + 1)) {
				const lead = line.slice(0, at);
				const target = /\]\(\s*<?$/.test(lead) || /^\s{0,3}(?:>\s*)*\[[^\]]+\]:\s*<?$/.test(lead);
				const inSpan = (lead.match(/`/g)?.length ?? 0) % 2 === 1;
				if (!target || inSpan) continue;
				if (!first || at < first.at) first = { at, length: form.length };
				break;
			}
		}
		return first;
	};
	const before = text.slice(0, start).split("\n").length - 1;
	let from = 0;
	let column = 0;
	return found.map((href) => {
		for (let index = from; index < lines.length; index++) {
			const here = place(index, href, index === from ? column : 0);
			if (!here) continue;
			from = index;
			column = here.at + here.length;
			return { href, file: linkFile(href), line: before + index + 1, column: here.at };
		}
		// A reference is written once, and may be used above where it is written.
		for (let index = 0; index < lines.length; index++) {
			const here = place(index, href);
			if (here) return { href, file: linkFile(href), line: before + index + 1, column: here.at };
		}
		return { href, file: linkFile(href), line: 0, column: 0 };
	});
}

/**
 * The text with one link pointed at another file: the file part of the link
 * on that line is rewritten, and what follows "?" or "#" is kept (ADR 0002).
 * Given its column, the link must be there; without one, the first on the
 * line is taken. Null when the link is not where it was read.
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
	for (const written of [href, href.replace(/ /g, "%20")]) {
		const at = column === undefined ? here.indexOf(written) : here.startsWith(written, column) ? column : -1;
		if (at < 0) continue;
		const rest = /[?#].*$/.exec(written)?.[0] ?? "";
		// A link's space is written as its escape; a path in front matter is written as it is.
		return `${text.slice(0, start + at)}${plain ? instead : instead.replace(/ /g, "%20")}${rest}${text.slice(start + at + written.length)}`;
	}
	return null;
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
	for (const edit of [...edits].sort((a, b) => b.line - a.line || (b.column ?? 0) - (a.column ?? 0))) {
		const next = withLinkFile(text, edit.line, edit.href, edit.instead, edit.column, edit.plain);
		if (next === null) continue;
		text = next;
		done++;
	}
	return { text, done };
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
			insert: relativePath(dir, file.path).replace(/ /g, "%20"),
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
