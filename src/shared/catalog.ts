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
const linkPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

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

/** Where the list is in a catalog's text: from the start marker to the end of the end marker. Null when there are no markers. */
export function catalogBlock(text: string): { start: number; end: number; inner: string } | null {
	const start = text.indexOf(CATALOG_START);
	const close = start < 0 ? -1 : text.indexOf(CATALOG_END, start + CATALOG_START.length);
	if (start < 0 || close < 0) return null;
	return { start, end: close + CATALOG_END.length, inner: text.slice(start + CATALOG_START.length, close).trim() };
}

const block = (items: readonly CatalogItem[]) => `${CATALOG_START}\n\n${catalogList(items)}\n\n${CATALOG_END}`;

/** The catalog's text with its list written afresh. A file with no markers gets the list at its end. */
export function withCatalog(text: string, items: readonly CatalogItem[]): string {
	const at = catalogBlock(text);
	if (at) return text.slice(0, at.start) + block(items) + text.slice(at.end);
	const body = text.replace(/\s+$/, "");
	return `${body}${body ? "\n\n" : ""}${block(items)}\n`;
}

/** Whether the list no longer says what the documents do: a document added, gone, retitled, or in another state. */
export function catalogStale(text: string, items: readonly CatalogItem[]): boolean {
	const at = catalogBlock(text);
	return !at || at.inner !== catalogList(items);
}
