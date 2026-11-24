// A catalog is the list a folder of documents is found by: one line for each,
// with its title, its status and what it is about, kept in the folder's
// INDEX.md between two marker comments. The list is written from the
// documents; everything else in the file is the person's and is left as it is.

export const CATALOG_FILE = "INDEX.md";
export const CATALOG_START = "<!-- catalog -->";
export const CATALOG_END = "<!-- /catalog -->";

export type CatalogItem = {
	/** From the catalog's folder, with forward slashes. */
	path: string;
	title: string;
	status?: string;
	summary?: string;
	/** The heading the item is listed under, when the catalog has more than one kind of thing. */
	section?: string;
};

const escapeLink = (text: string) => text.replace(/([\[\]])/g, "\\$1");
/** A path as a link's target: each part written so that nothing in a name ends the link, a round bracket included. */
const linkPath = (path: string) =>
	path
		.split("/")
		.map((part) => encodeURIComponent(part).replace(/[()]/g, (bracket) => `%${bracket.charCodeAt(0).toString(16).toUpperCase()}`))
		.join("/");

/** One item's line: its title as a link, then its status and what it is about. */
export function catalogLine(item: CatalogItem): string {
	const said = [item.status?.trim(), item.summary?.trim()].filter(Boolean).map((part) => (/[.!?…]$/.test(part!) ? part : `${part}.`));
	return `- [${escapeLink(item.title || item.path)}](${linkPath(item.path)})${said.length ? `: ${said.join(" ")}` : ""}`;
}

/** The list itself: the items by path, under their sections where they have them, in the order the sections first appear. */
export function catalogList(items: readonly CatalogItem[]): string {
	if (!items.length) return "Nothing here yet.";
	const byPath = [...items].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
	const sections = [...new Set(items.map((item) => item.section ?? ""))];
	if (sections.length === 1 && !sections[0]) return byPath.map(catalogLine).join("\n");
	return sections
		.map((section) => {
			const lines = byPath.filter((item) => (item.section ?? "") === section).map(catalogLine);
			return `${section ? `### ${section}\n\n` : ""}${lines.join("\n")}`;
		})
		.join("\n\n");
}

/** Where a marker stands on a line of its own, from `from` on: a marker named in a sentence, or in a code span, is not one. -1 when there is none. */
function markerAt(text: string, marker: string, from = 0): number {
	const pattern = new RegExp(`^[ \\t]*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?$`, "gm");
	const shown = fenced(text);
	pattern.lastIndex = from;
	// A marker shown as an example, inside a code fence, is not one either.
	for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
		const at = found.index + found[0].indexOf(marker);
		if (!shown.some(([start, end]) => at >= start && at < end)) return at;
	}
	return -1;
}

/** The stretches of a Markdown text that are inside a code fence, each from its opening line to the end of its closing one. */
export function fenced(text: string): [number, number][] {
	const ranges: [number, number][] = [];
	let open = "";
	let from = 0;
	let offset = 0;
	for (const raw of text.split("\n")) {
		const mark = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(raw.replace(/\r$/, ""));
		if (mark && !open) {
			// A backtick fence's opening line holds no further backtick: "```sql``` is a tag" is a span of code, not a fence.
			if (!(mark[1]![0] === "`" && mark[2]!.includes("`"))) {
				open = mark[1]!;
				from = offset;
			}
		} else if (mark && mark[1]![0] === open[0] && mark[1]!.length >= open.length && !mark[2]!.trim()) {
			ranges.push([from, offset + raw.length]);
			open = "";
		}
		offset += raw.length + 1;
	}
	if (open) ranges.push([from, text.length]);
	return ranges;
}

/** Where the list is in a catalog's text: from the start marker to the end of the end marker. Null when there is no such pair. */
/** Whether a text has the place a catalog's list goes: the marker it opens with. One without is a person's own document. */
export const hasCatalogPlace = (text: string) => markerAt(text, CATALOG_START) >= 0;

export function catalogBlock(text: string): { start: number; end: number; inner: string } | null {
	const start = markerAt(text, CATALOG_START);
	const close = start < 0 ? -1 : markerAt(text, CATALOG_END, start + CATALOG_START.length);
	if (start < 0 || close < 0) return null;
	// The list is compared and shown with plain line ends, whichever the file is written with.
	return { start, end: close + CATALOG_END.length, inner: text.slice(start + CATALOG_START.length, close).replace(/\r\n/g, "\n").trim() };
}

const block = (items: readonly CatalogItem[]) => `${CATALOG_START}\n\n${catalogList(items)}\n\n${CATALOG_END}`;

/** The catalog's text with its list written afresh, in the line ends the file already has. A file with no markers gets the list at its end. */
export function withCatalog(text: string, items: readonly CatalogItem[]): string {
	const eol = (written: string) => (text.includes("\r\n") ? written.replace(/\n/g, "\r\n") : written);
	const at = catalogBlock(text);
	if (at) return text.slice(0, at.start) + eol(block(items)) + text.slice(at.end);
	// A start marker whose end marker has gone: the list after it is the old list, as far as it runs. It is replaced,
	// and what a person wrote after it stays. A second list is never added beside the first.
	const open = markerAt(text, CATALOG_START);
	if (open >= 0) {
		const rest = text.slice(open + CATALOG_START.length);
		// Only what a catalog's list is made of: a line that links to a document, a section's heading as the list writes
		// it, the words for an empty list, and the blank lines between. A heading or a bullet of the person's own ends it.
		const listed = /^(?:[ \t]*\r?\n|- \[(?:\\.|[^\]\n])*\]\([^)\n]*\).*\r?\n?|### .*\r?\n?|Nothing here yet\.[ \t]*\r?\n?)*/.exec(rest)![0];
		const after = rest.slice(listed.length);
		return text.slice(0, open) + eol(block(items)) + (after ? eol("\n\n") + after : eol("\n"));
	}
	const body = text.replace(/\s+$/, "");
	return `${body}${eol(`${body ? "\n\n" : ""}${block(items)}\n`)}`;
}

/** Whether the list no longer says what the documents do: a document added, gone, retitled, or in another state. */
export function catalogStale(text: string, items: readonly CatalogItem[]): boolean {
	const at = catalogBlock(text);
	return !at || at.inner !== catalogList(items);
}
