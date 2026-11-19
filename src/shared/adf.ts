// A ticket system of the Jira Cloud kind gives a description as a tree of
// nodes (a "doc" with paragraphs, headings, lists, code), not as text. This
// writes that tree as Markdown: the same headings, lists, code and links, and
// every word as it was. A node it does not know is written as the words it
// holds, never dropped.

type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: { type?: string; attrs?: Record<string, unknown> }[]; content?: Node[] };

const isNode = (value: unknown): value is Node => Boolean(value) && typeof value === "object";
const kids = (node: Node): Node[] => (Array.isArray(node.content) ? node.content.filter(isNode) : []);
const said = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

/** A fence, or a run of backticks, longer than any the text holds. */
const ticks = (text: string, least: number) => "`".repeat(Math.max(least, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));
/** All the words under a node, as they are: what a block of code holds. */
const words = (node: Node): string => (typeof node.text === "string" ? node.text : node.type === "hardBreak" ? "\n" : kids(node).map(words).join(""));

/**
 * Words as Markdown reads them back: a character that would be taken for a
 * mark ("*", "`", a "_" at a word's edge, a "<" that opens a tag) is written
 * as itself. An underscore inside a word is left: it is not a mark there.
 */
function literal(text: string): string {
	const word = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9]/.test(ch);
	let out = "";
	for (let at = 0; at < text.length; at++) {
		const ch = text[at]!;
		const next = text[at + 1];
		if (ch === "\\" && next !== undefined && /[!-/:-@[-`{-~]/.test(next)) out += "\\\\";
		else if (ch === "*" || ch === "`") out += `\\${ch}`;
		else if (ch === "_" && !(word(text[at - 1]) && word(next))) out += "\\_";
		else if (ch === "<" && next !== undefined && /[A-Za-z/!?]/.test(next)) out += "\\<";
		else if (ch === "]" && (next === "(" || next === "[")) out += "\\]";
		else if (ch === "~" && next === "~") out += "\\~";
		else out += ch;
	}
	return out;
}

/** Text with the marks it carries: code, bold, italic, struck through, a link. */
function marked(node: Node): string {
	const text = node.text ?? "";
	const marks = (node.marks ?? []).map((mark) => mark.type);
	if (marks.includes("code")) {
		const fence = ticks(text, 1);
		// A backtick at either end needs room to be told from the fence.
		const padded = /^`|`$/.test(text) ? ` ${text} ` : text;
		return `${fence}${padded}${fence}`;
	}
	// A mark sits against the words, with the space around them outside it.
	const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
	if (!body) return text;
	let out = literal(body);
	if (marks.includes("strike")) out = `~~${out}~~`;
	if (marks.includes("em")) out = `*${out}*`;
	if (marks.includes("strong")) out = `**${out}**`;
	const link = (node.marks ?? []).find((mark) => mark.type === "link");
	const href = said(link?.attrs?.href);
	if (href) out = `[${out}](${href.replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`;
	return `${lead}${out}${trail}`;
}

/** A card for a page: the page's address. One that holds its page as data and not as an address is said to have been there. */
const card = (node: Node) => (said(node.attrs?.url) ? `<${said(node.attrs!.url)}>` : node.attrs?.data ? "*(a linked page, not brought across)*" : "");

/** The nodes of a line, side by side. */
function inline(nodes: Node[]): string {
	return nodes
		.map((node) => {
			switch (node.type) {
				case "text":
					return marked(node);
				case "hardBreak":
					return "\n";
				case "mention":
				case "emoji":
				case "status":
					// By what it shows; failing that, by whatever it has that names it.
					return literal(said(node.attrs?.text) || said(node.attrs?.shortName) || said(node.attrs?.displayName) || said(node.attrs?.id));
				case "inlineCard":
				case "blockCard":
				case "embedCard":
					return card(node);
				case "date": {
					const when = Number(said(node.attrs?.timestamp));
					return Number.isFinite(when) && when > 0 ? new Date(when).toISOString().slice(0, 10) : "";
				}
				case "media":
				case "mediaInline":
					// What was attached stays in the ticket system: the words say something was there.
					return "*(an attachment, not brought across)*";
				default:
					return typeof node.text === "string" ? literal(node.text) : kids(node).length ? inline(kids(node)) : literal(said(node.attrs?.text)) || card(node);
			}
		})
		.join("")
		.replace(/\n+$/, "")
		.replace(/\n/g, "  \n");
}

/**
 * Lines that would read as a heading, a list, a quotation or a rule, and are
 * none: the mark each begins with is written as itself. Every line of a
 * paragraph, since a line break inside one starts a line too.
 */
const plain = (text: string) =>
	text
		.split("\n")
		.map((line) =>
			line
				.replace(/^(\s*)(#{1,6}(?=\s|$)|>|[-+](?=\s|$))/, "$1\\$2")
				.replace(/^(\s*\d+)([.)])(?=\s|$)/, "$1\\$2")
				.replace(/^(\s*)((?:-{3,}|={1,}|_{3,})\s*)$/, "$1\\$2"),
		)
		.join("\n");
const indented = (text: string, by: string) =>
	text
		.split("\n")
		.map((line, at) => (at && line ? by + line : line))
		.join("\n");

/** One block: a paragraph, a heading, a list, code, a quotation, a table. */
function block(node: Node): string {
	switch (node.type) {
		case "paragraph":
			return plain(inline(kids(node)));
		case "heading":
			return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${inline(kids(node)).replace(/\s*\n\s*/g, " ")}`;
		case "bulletList":
			return kids(node)
				.map((item) => `- ${indented(blocks(kids(item)), "  ")}`)
				.join("\n");
		case "orderedList": {
			const first = Number(node.attrs?.order) || 1;
			return kids(node)
				.map((item, at) => {
					const mark = `${first + at}. `;
					return `${mark}${indented(blocks(kids(item)), " ".repeat(mark.length))}`;
				})
				.join("\n");
		}
		case "taskList":
			return kids(node)
				.map((item) => (item.type === "taskList" ? indented(`  ${block(item)}`, "  ") : `- [${item.attrs?.state === "DONE" ? "x" : " "}] ${inline(kids(item))}`))
				.join("\n");
		case "codeBlock": {
			const text = words(node).replace(/\n+$/, "");
			const fence = ticks(text, 3);
			return `${fence}${said(node.attrs?.language).replace(/[^\w+#.-]/g, "")}\n${text}\n${fence}`;
		}
		case "blockquote":
		case "panel":
			// A line keeps what it ends with: two spaces there are a line break.
			return blocks(kids(node))
				.split("\n")
				.map((line) => (line ? `> ${line}` : ">"))
				.join("\n");
		case "rule":
			return "---";
		case "table": {
			const rows = kids(node).map((row) => kids(row).map((cell) => blocks(kids(cell)).replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|")));
			if (!rows.length) return "";
			const width = Math.max(...rows.map((row) => row.length));
			const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, at) => cells[at] ?? "").join(" | ")} |`;
			return [line(rows[0]!), line(Array.from({ length: width }, () => "---")), ...rows.slice(1).map(line)].join("\n");
		}
		case "mediaSingle":
		case "mediaGroup": {
			// What was attached stays in the ticket system; what is written under it is words, and comes across.
			const caption = kids(node)
				.filter((kid) => kid.type === "caption")
				.map((kid) => inline(kids(kid)))
				.filter(Boolean)
				.join(" ");
			return `*(an attachment, not brought across)*${caption ? `\n\n${plain(caption)}` : ""}`;
		}
		case "blockCard":
		case "embedCard":
		case "inlineCard":
			return card(node);
		case "expand":
		case "nestedExpand":
			return [said(node.attrs?.title) ? `**${said(node.attrs!.title)}**` : "", blocks(kids(node))].filter(Boolean).join("\n\n");
		default:
			// A node of a kind not known here: its blocks if it has any, its words if it has those.
			if (typeof node.text === "string") return marked(node);
			return kids(node).some((kid) => kid.type === "text" || kid.type === "hardBreak") ? inline(kids(node)) : blocks(kids(node));
	}
}

/** Blocks one under another, a blank line between them; an item of a list keeps its lines together. */
function blocks(nodes: Node[]): string {
	return nodes
		.map(block)
		.filter((text) => text.trim())
		.join("\n\n");
}

/** Whether a value is such a tree: a node with nodes under it. */
export const isAdf = (value: unknown): boolean => isNode(value) && (value.type === "doc" || Array.isArray(value.content));

/** A document tree as Markdown. "" for what is not one. */
export function adfToMarkdown(value: unknown): string {
	if (!isNode(value)) return "";
	return (value.type === "doc" || !value.type ? blocks(kids(value)) : block(value)).trim();
}
