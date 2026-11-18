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

/** What a cell shows, without its Markdown: `code` and [links](there) count as their text. */
export const cellText = (markdown: string) =>
	markdown
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** Where each table breaks the rule. Lines are 1-based and point at the table's heading row. */
export function checkTables(markdown: string): TableFinding[] {
	const findings: TableFinding[] = [];
	let offset = 0;
	const walk = (tokens: any[]) => {
		for (const token of tokens) {
			if (token.type === "table") {
				const at = markdown.indexOf(token.raw, offset);
				if (at >= 0) offset = at;
				check(token, markdown.slice(0, Math.max(at, 0)).split("\n").length);
			}
			if (Array.isArray(token.tokens)) walk(token.tokens);
			if (Array.isArray(token.items)) walk(token.items);
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
	walk(marked.lexer(markdown));
	return findings;
}
