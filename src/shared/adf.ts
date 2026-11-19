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
	let out = body;
	if (marks.includes("strike")) out = `~~${out}~~`;
	if (marks.includes("em")) out = `*${out}*`;
	if (marks.includes("strong")) out = `**${out}**`;
	const link = (node.marks ?? []).find((mark) => mark.type === "link");
	const href = said(link?.attrs?.href);
	if (href) out = `[${out}](${href.replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`;
	return `${lead}${out}${trail}`;
}

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
					return said(node.attrs?.text) || said(node.attrs?.shortName);
				case "inlineCard":
				case "blockCard":
				case "embedCard":
					return said(node.attrs?.url) ? `<${said(node.attrs!.url)}>` : "";
				case "date": {
					const when = Number(said(node.attrs?.timestamp));
					return Number.isFinite(when) && when > 0 ? new Date(when).toISOString().slice(0, 10) : "";
				}
				case "media":
				case "mediaInline":
					// What was attached stays in the ticket system: the words say something was there.
					return "*(an attachment, not brought across)*";
				default:
					return typeof node.text === "string" ? node.text : inline(kids(node));
			}
		})
		.join("")
		.replace(/\n+$/, "")
		.replace(/\n/g, "  \n");
}

/** A line that would read as a heading, a list or a quotation, and is none: its first mark is written as itself. */
const plain = (text: string) => text.replace(/^(\s*)(#{1,6}(?=\s)|>|[-+*](?=\s)|\d+[.)](?=\s))/, "$1\\$2");
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
			return blocks(kids(node))
				.split("\n")
				.map((line) => `> ${line}`.trimEnd())
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
		case "mediaGroup":
			return "*(an attachment, not brought across)*";
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
	// A list's items sit on following lines, not a blank line apart: a list read back is one list.
	return (value.type === "doc" || !value.type ? blocks(kids(value)) : block(value)).replace(/\n{3,}/g, "\n\n").trim();
}
