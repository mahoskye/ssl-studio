import { marked, type Token } from "marked";
import { bodyOffset } from "./frontMatter";

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
	try {
		marked.walkTokens(marked.lexer(body.replace(/\r\n/g, "\n"), { gfm: true }), see);
	} catch {
		return [];
	}
	// Each is placed at the next line that holds it, as written or with its spaces escaped.
	const before = text.slice(0, start).split("\n").length - 1;
	const lines = body.split(/\r?\n/);
	/** Where a line holds the link at or after a column, and where it ends there; null when it does not. */
	const held = (line: string, href: string, column = 0) => {
		for (const written of [href, href.replace(/ /g, "%20")]) {
			const at = line.indexOf(written, column);
			if (at >= 0) return at + written.length;
		}
		return null;
	};
	let from = 0;
	let column = 0;
	return found.map((href) => {
		for (let index = from; index < lines.length; index++) {
			const end = held(lines[index]!, href, index === from ? column : 0);
			if (end === null) continue;
			from = index;
			column = end;
			return { href, file: linkFile(href), line: before + index + 1 };
		}
		// A reference is written once, and may be used above where it is written.
		const at = lines.findIndex((line) => held(line, href) !== null);
		return { href, file: linkFile(href), line: at < 0 ? 0 : before + at + 1 };
	});
}

/**
 * The text with one link pointed at another file: the file part of the link
 * on that line is rewritten, and what follows "?" or "#" is kept (ADR 0002).
 * Null when the link is not on that line as it was read.
 */
export function withLinkFile(text: string, line: number, href: string, instead: string): string | null {
	let start = 0;
	for (let at = 1; at < line; at++) {
		const end = text.indexOf("\n", start);
		if (end < 0) return null;
		start = end + 1;
	}
	const end = text.indexOf("\n", start);
	const here = text.slice(start, end < 0 ? text.length : end);
	for (const written of [href, href.replace(/ /g, "%20")]) {
		const at = here.indexOf(written);
		if (at < 0) continue;
		const rest = /[?#].*$/.exec(written)?.[0] ?? "";
		return `${text.slice(0, start + at)}${instead.replace(/ /g, "%20")}${rest}${text.slice(start + at + written.length)}`;
	}
	return null;
}
