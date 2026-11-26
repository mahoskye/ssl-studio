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

/**
 * Where a marker stands on a line of its own, from `from` on: a marker named in a sentence, or in a code span, is not
 * one. -1 when there is none. With `underOpenFence` false, a marker under a code fence that is never closed is
 * passed over like one inside a closed fence; otherwise it is read (see `fences`).
 */
function markerAt(text: string, marker: string, from = 0, underOpenFence = true): number {
	const pattern = new RegExp(`^[ \\t]*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?$`, "gm");
	const shown = underOpenFence ? fences(text).closed : fenced(text);
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
	const { closed, open } = fences(text);
	return open < 0 ? closed : [...closed, [open, text.length]];
}

/**
 * The code fences of a text: those that are closed, and where one that is never closed opens (-1 when every fence
 * is closed). A fence left open runs to the end of the text, and everything under it is code to a Markdown reader.
 * A catalog's markers are read under one all the same. Passed over there like the markers of an example, they left
 * the catalog with no place for its list: each update wrote one more list at the end of the file, under the same
 * open fence, where the next update passed it over again, and the catalog was never up to date.
 */
function fences(text: string): { closed: [number, number][]; open: number } {
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
	return { closed: ranges, open: open ? from : -1 };
}

/**
 * The line (from 1) of a code fence that is never closed and that the catalog's list stands under; 0 when the list
 * stands under no such fence. The list is written there like anywhere else, and is shown as code until the fence is
 * closed: whoever writes the catalog says so.
 */
export function catalogUnderOpenFence(text: string): number {
	const { open } = fences(text);
	const start = markerAt(text, CATALOG_START);
	return open >= 0 && start > open ? text.slice(0, open).split("\n").length : 0;
}

/** Where the list is in a catalog's text: from the start marker to the end of the end marker. Null when there is no such pair. */
/** Whether a text has the place a catalog's list goes: the marker it opens with. One without is a person's own document. */
export const hasCatalogPlace = (text: string) => markerAt(text, CATALOG_START) >= 0;

export function catalogBlock(text: string): { start: number; end: number; inner: string } | null {
	const start = markerAt(text, CATALOG_START);
	// An end marker under a fence left open ends the list only where the list opens under that fence too. After a
	// start marker that stands above the fence it is an example, as it always was: taken for the list's end, all the
	// person wrote between the two would be written over.
	const close = start < 0 ? -1 : markerAt(text, CATALOG_END, start + CATALOG_START.length, start > fences(text).open);
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
	// A start marker whose end marker has gone. What follows it may be the old list, the person's own words, or one
	// after the other, and no line says which it is: a bullet that links to a document, or a third-level heading, is
	// what the list writes and what a person writes. So the only lines taken up are those the fresh list says again
	// (and the words for an empty list); from the first line that is anything else, everything stays as it is, under
	// the new end marker. That can leave a line of the old list that is out of date standing there, for the person
	// to take out. Taking every line shaped like the list's did worse: it took a heading and a bullet a person had
	// written under the list. A second start marker is never added beside the first.
	const open = markerAt(text, CATALOG_START);
	if (open >= 0) {
		const rest = text.slice(open + CATALOG_START.length);
		const fresh = new Set(catalogList(items).split("\n"));
		let taken = 0;
		while (taken < rest.length) {
			const lineEnd = rest.indexOf("\n", taken);
			const next = lineEnd < 0 ? rest.length : lineEnd + 1;
			const line = rest.slice(taken, next).trimEnd();
			if (line && !fresh.has(line) && line !== "Nothing here yet.") break;
			taken = next;
		}
		const after = rest.slice(taken);
		return text.slice(0, open) + eol(block(items)) + (after ? eol("\n\n") + after : eol("\n"));
	}
	const body = text.replace(/\s+$/, "");
	return `${body}${eol(`${body ? "\n\n" : ""}${block(items)}\n`)}`;
}

/**
 * Whether a catalog has the line its list opens with and not the one it closes with. `withCatalog` then cannot
 * tell the old list from the person's words under it and keeps all of it, so whoever writes the catalog says so.
 */
export const catalogEndMissing = (text: string) => hasCatalogPlace(text) && catalogBlock(text) === null;

/** Whether the list no longer says what the documents do: a document added, gone, retitled, or in another state. */
export function catalogStale(text: string, items: readonly CatalogItem[]): boolean {
	const at = catalogBlock(text);
	return !at || at.inner !== catalogList(items);
}
