// A ticket system of the Jira Cloud kind gives a description as a tree of
// nodes (a "doc" with paragraphs, headings, lists, code), not as text. This
// writes that tree as Markdown: the same headings, lists, code and links, and
// every word as it was. A node it does not know is written as the words it
// holds, never dropped.

import { withAddresses } from "./markdownText";

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
 * mark is written as itself. A backslash, a star, a backtick, a tilde and
 * an opening bracket always; an underscore at a word's edge (inside a word
 * it is not a mark); a "<" that would open a tag, and an "&" that would
 * open a named character, as the characters they are.
 */
function literal(text: string): string {
	const word = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
	let out = "";
	for (let at = 0; at < text.length; at++) {
		const ch = text[at]!;
		const next = text[at + 1];
		if (ch === "\\" || ch === "*" || ch === "`" || ch === "~" || ch === "[" || ch === "]") out += `\\${ch}`;
		else if (ch === "_" && !(word(text[at - 1]) && word(next))) out += "\\_";
		else if (ch === "<" && next !== undefined && /[A-Za-z/!?]/.test(next)) out += "&lt;";
		else if (ch === "&" && /^&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/.test(text.slice(at, at + 40))) out += "&amp;";
		else out += ch;
	}
	return out;
}

/** Whether these words are in a table's cell, where a pipe ends the cell wherever it stands. */
let inCell = false;
/**
 * Code written with a tag: for a table's cell, where Markdown's own code
 * cannot hold a pipe. What is between the tags is still read as Markdown,
 * so its marks are written as themselves, and a pipe as the character it is.
 */
const codeTag = (text: string) => `<code>${literal(text).replace(/\|/g, "&#124;")}</code>`;

/** Allows only http(s), mailto, or safe relative URLs; percent-encodes delimiters/whitespace. */
function safeUrl(raw: string): string {
	const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
	if (!clean || clean.startsWith("//")) return "";
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(clean);
	if (scheme && !/^(?:https?|mailto)$/i.test(scheme[1]!)) return "";
	return clean.replace(/[()\s<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** Text with the marks it carries: code, bold, italic, struck through, a link. */
function marked(node: Node): string {
	const text = node.text ?? "";
	const marks = (node.marks ?? []).map((mark) => mark.type);
	const link = (node.marks ?? []).find((mark) => mark.type === "link");
	const href = safeUrl(said(link?.attrs?.href));
	if (marks.includes("code")) {
		const fence = ticks(text, 1);
		// A backtick at either end needs room to be told from the fence.
		const code = inCell ? codeTag(text) : `${fence}${/^`|`$/.test(text) ? ` ${text} ` : text}${fence}`;
		return href ? `[${code}](${href})` : code;
	}
	// A mark sits against the words, with the space around them outside it.
	const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
	if (!body) return text;
	// An address is written as one; inside a link's own words it is words, since a link cannot hold a link.
	let out = href ? literal(body) : withAddresses(body, literal);
	// Stars and tildes mark words only where a word meets them, and not through each other: around words that
	// begin or end with a mark of their own ("Note:", "~2 hours"), or under more than one mark, the same is said
	// with a tag, which holds wherever it stands.
	const styles = (["strike", "em", "strong"] as const).filter((style) => marks.includes(style));
	const stars = styles.length === 1 && /^[\p{L}\p{N}]/u.test(body) && /[\p{L}\p{N}]$/u.test(body);
	for (const style of styles) {
		const [star, tag] = style === "strike" ? ["~~", "del"] : style === "em" ? ["*", "em"] : ["**", "strong"];
		out = stars ? `${star}${out}${star}` : `<${tag}>${out}</${tag}>`;
	}
	if (href) out = `[${out}](${href})`;
	return `${lead}${out}${trail}`;
}

/** The same words under the same marks, written as two nodes: one run of words. Two runs side by side would end and begin with the same mark. */
function joined(nodes: Node[]): Node[] {
	const same = (a: Node, b: Node) => a.type === "text" && b.type === "text" && JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);
	const out: Node[] = [];
	for (const node of nodes) {
		const last = out[out.length - 1];
		if (last && same(last, node)) out[out.length - 1] = { ...last, text: `${last.text ?? ""}${node.text ?? ""}` };
		else out.push(node);
	}
	return out;
}

/** A card for a page: the page's address. One that holds its page as data and not as an address is said to have been there. */
const card = (node: Node) => {
	const raw = said(node.attrs?.url);
	if (raw) {
		const safe = safeUrl(raw);
		if (!safe) return "";
		return /^(?:https?:\/\/|mailto:)/i.test(safe) ? `<${safe}>` : `[${literal(raw)}](${safe})`;
	}
	return node.attrs?.data ? "*(a linked page, not brought across)*" : "";
};

/** The nodes of a line, side by side. */
function inline(nodes: Node[]): string {
	return joined(nodes)
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
					if (!Number.isFinite(when) || when <= 0) return "";
					const d = new Date(when);
					return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
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
				// A line of dashes or of "=" alone would make a heading of the line above it, however few they are.
				.replace(/^(\s*)((?:-+|=+|_{3,})\s*)$/, "$1\\$2"),
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
			// Space before a paragraph's first word is nothing on a page; four of them here would make it code.
			return plain(inline(kids(node)).replace(/^[ \t]+/, ""));
		case "heading":
			// A "#" that ends a heading would be taken for the heading's own closing mark.
			return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${inline(kids(node))
				.replace(/\s*\n\s*/g, " ")
				.replace(/#+\s*$/, (end) => end.replace(/#/g, "\\#"))}`;
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
			// A line keeps what it ends with: two spaces there are a line break.
			return blocks(kids(node))
				.split("\n")
				.map((line) => (line ? `> ${line}` : ">"))
				.join("\n");
		case "panel": {
			const pt = said(node.attrs?.panelType).toLowerCase();
			const kind = pt === "warning" ? "warning" : pt === "error" ? "danger" : pt === "success" ? "success" : pt === "info" ? "info" : "note";
			const bodyLines = blocks(kids(node))
				.split("\n")
				.map((line) => (line ? `> ${line}` : ">"));
			return [`> [!${kind}]`, ...bodyLines].join("\n");
		}
		case "rule":
			return "---";
		case "table": {
			// A cell is one line: what is on several lines in it is written with a break between, code a line at a
			// time. Code there is written as a tag: Markdown's own code cannot hold a pipe in a cell.
			const inCells = (kid: Node) => {
				const prev = inCell;
				inCell = true;
				try {
					return kid.type === "codeBlock"
						? words(kid)
								.replace(/\n+$/, "")
								.split("\n")
								.map((line) => (line ? codeTag(line) : ""))
								.join("<br>")
						: block(kid).replace(/\s*\n+\s*/g, "<br>");
				} finally {
					inCell = prev;
				}
			};
			const rows = kids(node).map((row) =>
				kids(row).map((cell) =>
					kids(cell)
						.map(inCells)
						.filter(Boolean)
						.join("<br>")
						.replace(/\|/g, "\\|"),
				),
			);
			if (!rows.length) return "";
			const width = Math.max(...rows.map((row) => row.length));
			if (width === 0) return "";
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
		case "nestedExpand": {
			const title = said(node.attrs?.title).replace(/\s*[\r\n]+\s*/g, " ").trim();
			return [title ? `**${literal(title)}**` : "", blocks(kids(node))].filter(Boolean).join("\n\n");
		}
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
