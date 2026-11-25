// A ticket system of the Jira kind keeps a description in its own wiki
// markup, and exports it that way. Left as it is in a Markdown document, a
// numbered list ("# first") reads as a heading and code ("{code}") as stray
// braces. This turns the common marks into Markdown's, a line at a time, and
// leaves every word as it was. What it does not know it leaves alone.

import { addressAndRest } from "./markdownText";

/** What a block of code says of itself: "{code:sql}", "{code:title=Query.sql|language=sql}". */
function codeSays(said: string): { language: string; title: string } {
	const parts = said.split("|").map((part) => part.trim());
	const value = (name: string) => parts.find((part) => part.toLowerCase().startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
	const bare = parts.find((part) => part && !part.includes("=")) ?? "";
	const language = (value("language") || bare).toLowerCase();
	return { language: /^[a-z][a-z0-9+#-]*$/.test(language) ? language : "", title: value("title") };
}

/** A run of backticks longer than any the text holds, and never fewer than `least`. */
const ticks = (text: string, least: number) => "`".repeat(Math.max(least, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));

/** Words between the things a line holds whole: their marks turned into Markdown's. */
function words(text: string): string {
	return (
		text
			// A backslash that is a backslash (in a path, before a mark the wiki does not escape) would hide the mark
			// after it in Markdown, and be hidden with it.
			.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\")
			// A word in angle brackets is a word: left as it is, a page would take it for a tag and show nothing.
			.replace(/<(?=[A-Za-z/!?])/g, "&lt;")
			// "*bold*" is bold there, and italic in Markdown: written as Markdown's bold. Only where it stands as a
			// word of its own; "*.sql,*.ssl" and "a * b" are stars.
			.replace(/(^|[\s([{>|])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=$|[\s)\]}|]|[.,;:!?](?:\s|$))/g, "$1\uE000$2\uE000")
			// Every other star and tilde is itself: Markdown would take a pair of them for italics or a strike.
			.replace(/[*~]/g, "\\$&")
			.replace(/\uE000/g, "**")
	);
}

/** Allows only http(s), mailto, or safe relative URLs; percent-encodes `< > ( )` and whitespace. */
function safeWikiUrl(raw: string): string {
	const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
	if (!clean || clean.startsWith("//")) return "";
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(clean);
	if (scheme && !/^(?:https?|mailto)$/i.test(scheme[1]!)) return "";
	return clean.replace(/[()\s<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** Escapes Markdown/HTML control chars in panel and code-block titles without mangling interior underscores. */
function escapeTitle(raw: string): string {
	const text = raw.replace(/\s*[\r\n]+\s*/g, " ").trim();
	const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		const next = text[i + 1];
		if (ch === "\\" || ch === "*" || ch === "`" || ch === "~" || ch === "[" || ch === "]") out += `\\${ch}`;
		else if (ch === "_" && !(isWord(text[i - 1]) && isWord(next))) out += "\\_";
		else if (ch === "<" && next !== undefined && /[A-Za-z/!?]/.test(next)) out += "&lt;";
		else out += ch;
	}
	return out;
}

/**
 * What a line holds whole, and is written as it is or as Markdown's own
 * form of it: text in backticks, one of the wiki's own marks written with a
 * backslash (which says "this is itself" there as it does in Markdown), a link with
 * its words, an address in brackets, and an address in the sentence.
 */
const WHOLE = /(`[^`\n]+`)|(\\[*_\-+^~?{}[\]|!#\\])|\[([^\]|\n]+)\|((?:https?:\/\/|mailto:|javascript:|vbscript:|data:)[^\]|\n]+|[a-z][a-z0-9+.-]*:[^\]|\s]+)(?:\|[^\]\n]*)?\]|\[(https?:\/\/[^\]|\s]+)\]|(https?:\/\/[^\s<>]+)/gi;

/** The marks inside a stretch of a line that is not code. */
function prose(text: string): string {
	// Colour has no words: taken off first, so that what it wraps is read for what it is.
	const plain = text.replace(/\{color(?::[^}\n]*)?\}/gi, "").replace(/\{anchor:[^}\n]*\}/gi, "");
	let out = "";
	let at = 0;
	for (const found of plain.matchAll(WHOLE)) {
		out += words(plain.slice(at, found.index));
		if (found[1] ?? found[2]) out += found[1] ?? found[2];
		else if (found[3]) {
			const safe = safeWikiUrl(found[4]!);
			out += safe ? `[${words(found[3])}](${safe})` : words(found[3]);
		} else if (found[5]) {
			const safe = safeWikiUrl(found[5]);
			out += safe ? `<${safe}>` : words(found[5]);
		} else {
			const [address, rest] = addressAndRest(found[6]!);
			out += `<${address}>${words(rest)}`;
		}
		at = found.index + found[0].length;
	}
	return out + words(plain.slice(at));
}

/** The marks inside a line: "{{code}}" is code, left as written; the rest is prose. */
function inline(text: string): string {
	return text
		.split(/(\{\{[^}\n]+\}\})/)
		.map((part, at) => {
			if (at % 2 === 0) return prose(part);
			const code = part.slice(2, -2);
			const fence = ticks(code, 1);
			return `${fence}${/^`|`$/.test(code) ? ` ${code} ` : code}${fence}`;
		})
		.join("");
}

/** One line that is not code, its marks turned into Markdown's. `top` is the largest heading the text uses. */
function line(text: string, top: number): string {
	const heading = /^h([1-6])\.\s+(.*)$/.exec(text);
	// Under a ticket's own headings: the largest heading a description uses is the document's third level, and the
	// others keep their distance from it.
	if (heading) return `${"#".repeat(Math.min(6, Math.max(3, 3 + Number(heading[1]) - top)))} ${inline(heading[2]!)}`;
	// A rule is four dashes there; with a line of words above it, three would make that line a heading.
	if (/^-{4,}\s*$/.test(text)) return "\n---\n";
	// Fewer dashes, or a line of "=", are words there, and under a line of words Markdown would make a heading of it.
	if (/^(?:-{1,3}|=+)\s*$/.test(text)) return `\\${text}`;
	const numbered = /^(#+)\s+(.*)$/.exec(text);
	if (numbered) return `${"   ".repeat(numbered[1]!.length - 1)}1. ${inline(numbered[2]!)}`;
	const mixed = /^([*#]{2,})\s+(.*)$/.exec(text);
	if (mixed && mixed[1]!.includes("*") && mixed[1]!.includes("#")) {
		const last = mixed[1]![mixed[1]!.length - 1];
		const indent = "  ".repeat(mixed[1]!.length - 1);
		return last === "#" ? `${indent}1. ${inline(mixed[2]!)}` : `${indent}- ${inline(mixed[2]!)}`;
	}
	const bullet = /^(\*+|-{2,})\s+(.*)$/.exec(text);
	if (bullet) return `${"  ".repeat(bullet[1]!.length - 1)}- ${inline(bullet[2]!)}`;
	const quoted = /^bq\.\s+(.*)$/.exec(text);
	if (quoted) return `> ${inline(quoted[1]!)}`;
	// A table's heading row: "||a||b||" is "| a | b |" with the rule Markdown wants under it.
	const head = /^\|\|(.+?)\|\|\s*$/.exec(text);
	if (head) {
		const cells = head[1]!.split("||").map((cell) => inline(cell.trim()));
		return `| ${cells.join(" | ")} |\n| ${cells.map(() => "---").join(" | ")} |`;
	}
	return inline(text);
}

/** A text in wiki markup as Markdown: its blocks of code fenced and left as written, its other lines' marks changed. */
export function wikiToMarkdown(text: string): string {
	const out: string[] = [];
	/** A line is put down. Words straight after a quotation would be read as more of it: a blank line ends it. */
	const put = (said: string) => {
		const last = out[out.length - 1];
		if (last?.startsWith(">") && said && !said.startsWith(">")) out.push("");
		out.push(said);
	};
	/** A blank line, where the last line is not one already. */
	const gap = () => {
		if (out.length && out[out.length - 1] !== "") out.push("");
	};
	let quoting = false;
	const plain = (part: string) => {
		for (const raw of part.split("\n")) {
			// "{quote}" opens and closes a quotation, on a line of its own or around one.
			const pieces = raw.split(/\{quote\}/i);
			pieces.forEach((piece, index) => {
				if (index > 0) quoting = !quoting;
				if (pieces.length > 1 && !piece.trim()) return;
				const said = line(piece, top);
				put(
					quoting
						? said
								.split("\n")
								.map((each) => (each ? `> ${each}` : ">"))
								.join("\n")
						: said,
				);
			});
		}
	};
	const source = text.replace(/\r\n/g, "\n");
	const block = /\{(code|noformat|panel)(?::([^}\n]*))?\}([\s\S]*?)\{\1\}/gi;
	// The largest heading used outside code, wherever a line of it starts: 6 when there is none, and nothing is a heading.
	const top = Math.min(6, ...[...source.replace(block, "").matchAll(/(?:^|\{quote\})h([1-6])\.\s/gim)].map((found) => Number(found[1])));
	block.lastIndex = 0;
	let at = 0;
	for (let found = block.exec(source); found; found = block.exec(source)) {
		const before = source.slice(at, found.index).replace(/\n+$/, "");
		if (before) plain(before);
		const tag = found[1]!.toLowerCase();
		const body = found[3]!.replace(/^\n+|\n+$/g, "");
		if (tag === "panel") {
			const says = codeSays(found[2] ?? "");
			const safeTitle = says.title ? escapeTitle(says.title) : "";
			const heading = safeTitle ? `> [!note] ${safeTitle}` : "> [!note]";
			const inner = wikiToMarkdown(body);
			gap();
			out.push(
				heading,
				...inner.split("\n").map((l) => (l ? `> ${l}` : ">")),
				"",
			);
			at = found.index + found[0].length;
			continue;
		}
		// What is between the marks is code, every line and every blank line of it.
		const says = tag === "code" ? codeSays(found[2] ?? "") : { language: "", title: "" };
		const fence = ticks(body, 3);
		gap();
		// A block's title is words of the ticket's: kept, above the block.
		if (says.title) out.push(`**${escapeTitle(says.title)}**`, "");
		out.push(`${fence}${says.language}`, body, fence, "");
		at = found.index + found[0].length;
	}
	const rest = at ? source.slice(at).replace(/^\n+/, "") : source;
	if (rest) plain(rest);
	return out.join("\n").trim();
}
