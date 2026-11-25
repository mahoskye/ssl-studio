// The rule for tables in documentation (ADR 0008), as numbers and one check.
// The rendered view uses the numbers to decide which columns never wrap; the
// tests use the check on the documents this repository writes.
import { marked } from "marked";

/** A table has at most this many columns. */
export const MAX_COLUMNS = 4;
/** A heading is a word or two. */
export const MAX_HEADING = 16;
/** A short value: a name, a code, a number, a date. Every column but the last holds these. */
export const MAX_SHORT = 20;
/** The last column may hold a phrase or one sentence. */
export const MAX_TEXT = 100;

export type TableFinding = { line: number; message: string };

/** Strips Markdown links/images `[label](url)` handling balanced inner parentheses in destinations. */
function stripMarkdownLinks(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const isImg = text[i] === "!" && text[i + 1] === "[";
		if (isImg || text[i] === "[") {
			const openBr = isImg ? i + 1 : i;
			let brDepth = 0;
			let closeBr = -1;
			for (let k = openBr; k < text.length; k++) {
				if (text[k] === "\\" && k + 1 < text.length) {
					k++;
					continue;
				}
				if (text[k] === "[") brDepth++;
				else if (text[k] === "]") {
					brDepth--;
					if (brDepth === 0) {
						closeBr = k;
						break;
					}
				}
			}
			if (closeBr >= 0 && text[closeBr + 1] === "(") {
				let p = closeBr + 2;
				let parenDepth = 0;
				let closeParen = -1;
				while (p < text.length) {
					const ch = text[p]!;
					if (ch === "\\" && p + 1 < text.length) {
						p += 2;
						continue;
					}
					if (ch === "(") parenDepth++;
					else if (ch === ")") {
						if (parenDepth === 0) {
							closeParen = p;
							break;
						}
						parenDepth--;
					}
					p++;
				}
				if (closeParen >= 0) {
					out += text.slice(openBr + 1, closeBr);
					i = closeParen + 1;
					continue;
				}
			}
		}
		out += text[i++];
	}
	return out;
}

/** What a cell shows, without its Markdown: `code`, [links](there), and [[Target|Alias]] count as their visible text. */
export const cellText = (markdown: string) =>
	stripMarkdownLinks(
		markdown
			.replace(/!?\[\[[^[\]|]+\\?\|([^\]]+)\]\]/g, "$1")
			.replace(/!?\[\[([^\]]+)\]\]/g, "$1"),
	)
		.replace(/[`*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** Where each table breaks the rule. Lines are 1-based and point at the table's heading row. */
export function checkTables(markdown: string): TableFinding[] {
	// marked.lexer normalizes token.raw to LF, so normalize CRLF before locating line offsets.
	const plain = markdown.replace(/\r\n/g, "\n");
	const findings: TableFinding[] = [];
	let offset = 0;
	const walk = (tokens: any[], isTopLevel = false) => {
		for (const token of tokens) {
			let tokenStart = -1;
			if (isTopLevel && typeof token.raw === "string" && token.raw.length > 0) {
				tokenStart = plain.indexOf(token.raw, offset);
			}
			if (token.type === "table") {
				let at = tokenStart >= 0 ? tokenStart : plain.indexOf(token.raw, offset);
				if (at >= 0) {
					offset = at + token.raw.length;
				} else {
					// Inside blockquotes/lists, `marked` strips `> ` / leading indent from `token.raw`.
					const firstLine = String(token.raw ?? "").split("\n")[0]?.trim() ?? "";
					if (firstLine) {
						let pos = offset;
						for (const rawLine of plain.slice(offset).split("\n")) {
							const stripped = rawLine.replace(/^(?:[ \t]*>[ \t]*)+/, "").trim();
							if (stripped === firstLine) {
								at = pos;
								offset = pos + rawLine.length + 1;
								break;
							}
							pos += rawLine.length + 1;
						}
					}
				}
				check(token, plain.slice(0, Math.max(at, 0)).split("\n").length);
				continue;
			}
			if (isTopLevel && token.type === "code") {
				if (tokenStart >= 0) offset = tokenStart + token.raw.length;
				continue;
			}
			if (Array.isArray(token.tokens)) walk(token.tokens, false);
			if (Array.isArray(token.items)) walk(token.items, false);
			if (isTopLevel && tokenStart >= 0) {
				offset = Math.max(offset, tokenStart + token.raw.length);
			}
		}
	};
	const check = (table: any, line: number) => {
		const say = (message: string) => findings.push({ line, message });
		const heads: string[] = table.header.map((h: any) => cellText(h.text));
		const last = heads.length - 1;
		if (heads.length > MAX_COLUMNS) say(`A table has at most ${MAX_COLUMNS} columns; this one has ${heads.length}.`);
		heads.forEach((head, i) => {
			const name = head || `column ${i + 1}`;
			if (!head) say(`Column ${i + 1} has no heading.`);
			if (head.length > MAX_HEADING) say(`The heading "${head}" is ${head.length} characters; a heading has at most ${MAX_HEADING}.`);
			const longest = Math.max(0, ...table.rows.map((row: any) => cellText(row[i]?.text ?? "").length));
			if (i < last && longest > MAX_SHORT) say(`"${name}" holds a value of ${longest} characters; only the last column holds text, and the others at most ${MAX_SHORT}.`);
			if (i === last && longest > MAX_TEXT) say(`"${name}" holds ${longest} characters in one cell; a cell has at most ${MAX_TEXT}.`);
		});
	};
	walk(marked.lexer(plain), true);
	return findings;
}

/** A heading's anchor, as a link to it is usually written: "## What is here" is #what-is-here. */
export const headingAnchor = (text: string) =>
	text
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s+/g, "-");
