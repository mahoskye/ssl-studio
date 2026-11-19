// A ticket system of the Jira kind keeps a description in its own wiki
// markup, and exports it that way. Left as it is in a Markdown document, a
// numbered list ("# first") reads as a heading and code ("{code}") as stray
// braces. This turns the common marks into Markdown's, a line at a time, and
// leaves every word as it was. What it does not know it leaves alone.

/** The language a block of code names: "{code:sql}", "{code:title=Query|language=sql}". */
const languageOf = (said: string) => {
	const named = /(?:^|[|:])(?:language=)?([a-z][a-z0-9+#-]*)$/i.exec(said.split("|").find((part) => !part.includes("=") || /^language=/i.test(part)) ?? "");
	return named ? named[1]!.toLowerCase() : "";
};

/** One line that is not code, its marks turned into Markdown's. `top` is the largest heading the text uses. */
function line(text: string, top: number): string {
	const heading = /^h([1-6])\.\s+(.*)$/.exec(text);
	// Under a ticket's own headings: the largest heading a description uses is the document's third level, and the
	// others keep their distance from it.
	if (heading) return `${"#".repeat(Math.min(6, 3 + Number(heading[1]) - top))} ${inline(heading[2]!)}`;
	const numbered = /^(#+)\s+(.*)$/.exec(text);
	if (numbered) return `${"   ".repeat(numbered[1]!.length - 1)}1. ${inline(numbered[2]!)}`;
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

/** The marks inside a line. */
function inline(text: string): string {
	return text
		.replace(/\{\{([^}\n]+)\}\}/g, "`$1`")
		.replace(/\[([^\]|\n]+)\|([a-z][a-z0-9+.-]*:[^\]|\s]+)(?:\|[^\]\n]*)?\]/gi, "[$1]($2)")
		.replace(/\[(https?:\/\/[^\]|\s]+)\]/gi, "<$1>")
		.replace(/\{color(?::[^}\n]*)?\}/gi, "")
		.replace(/\{anchor:[^}\n]*\}/gi, "");
}

/** A text in wiki markup as Markdown: its blocks of code fenced and left as written, its other lines' marks changed. */
export function wikiToMarkdown(text: string): string {
	const out: string[] = [];
	let quoting = false;
	const plain = (part: string) => {
		for (const raw of part.split("\n")) {
			// "{quote}" opens and closes a quotation, on a line of its own or around one.
			const pieces = raw.split(/\{quote\}/i);
			pieces.forEach((piece, index) => {
				if (index > 0) quoting = !quoting;
				if (pieces.length > 1 && !piece.trim()) return;
				const said = line(piece, top);
				out.push(quoting ? said.split("\n").map((each) => `> ${each}`.trimEnd()).join("\n") : said);
			});
		}
	};
	const source = text.replace(/\r\n/g, "\n");
	const block = /\{(code|noformat)(?::([^}\n]*))?\}([\s\S]*?)\{\1\}/gi;
	// The largest heading used outside code: 1 when there is none.
	const top = Math.min(6, ...[...source.replace(block, "").matchAll(/^h([1-6])\.\s/gm)].map((found) => Number(found[1])));
	block.lastIndex = 0;
	let at = 0;
	for (let found = block.exec(source); found; found = block.exec(source)) {
		const before = source.slice(at, found.index);
		if (before.replace(/\n+$/, "")) plain(before.replace(/\n+$/, ""));
		const body = found[3]!.replace(/^\n+|\n+$/g, "");
		// A fence longer than any run of backticks the code holds.
		const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((run) => run[0].length + 1)));
		out.push("", `${fence}${found[1]!.toLowerCase() === "code" ? languageOf(found[2] ?? "") : ""}`, body, fence, "");
		at = found.index + found[0].length;
	}
	const rest = source.slice(at).replace(/^\n+/, at ? "" : "$&");
	if (rest) plain(rest);
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
