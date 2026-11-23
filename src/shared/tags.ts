// Pure workspace #tag extractor and aggregator for Markdown documents.
// Combines YAML frontmatter `tags:` / `tag:` with inline prose `#tags` while
// strictly skipping fenced code blocks, inline code spans, Markdown URLs, and hex colors.
import { fenced } from "./catalog";
import { frontMatter, many } from "./frontMatter";
import { isCatalog } from "./projectDocs";
import type { DocFile } from "./protocol";

const HEX_COLOR_RE = /^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CSS_LETTER_HEX = new Set(["fff", "eee", "ddd", "ccc", "bbb", "aaa", "ffffff", "eeeeee", "dddddd", "cccccc", "bbbbbb", "aaaaaa"]);
export const INLINE_TAG_RE = /(^|[\s([{"'.,;:])#([A-Za-z][A-Za-z0-9_/-]{0,63})(?=$|[\s)\]}"'.,;:!?])/g;

/** True when a prose `#token` looks like a CSS hex color rather than a real tag (preserves `#cab`, `#dba`, `#cda`, `#cafe`, etc.). */
export function isLikelyHexColorTag(tag: string): boolean {
	if (!HEX_COLOR_RE.test(tag)) return false;
	return /[0-9]/.test(tag) || CSS_LETTER_HEX.has(tag.toLowerCase());
}

/** Removes inline code spans (CommonMark backtick-run rules), wikilinks, HTML tags/comments, reference defs, and URLs. */
function stripInlineCodeAndUrls(line: string): string {
	// Skip reference-link definitions (`[top]: #overview`).
	if (/^[ \t]{0,3}\[[^\]]+\]:[ \t]*\S/.test(line)) return "";
	let out = "";
	let i = 0;
	while (i < line.length) {
		if (line[i] === "`") {
			let run = 0;
			while (i + run < line.length && line[i + run] === "`") run++;
			let j = i + run;
			let closed = -1;
			while (j < line.length) {
				if (line[j] !== "`") {
					j++;
					continue;
				}
				let cRun = 0;
				while (j + cRun < line.length && line[j + cRun] === "`") cRun++;
				if (cRun === run) {
					closed = j + cRun;
					break;
				}
				j += cRun;
			}
			if (closed >= 0) {
				out += " ".repeat(closed - i);
				i = closed;
				continue;
			}
			out += line.slice(i, i + run);
			i += run;
			continue;
		}
		out += line[i++];
	}
	return out
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/\[\[[^[\]\n]*\]\]/g, " ")
		.replace(/<[^>\n]+>/g, " ")
		.replace(/\]\([^)\n]*\)/g, "]()")
		.replace(/https?:\/\/[^\s)>]+/gi, "");
}

/** Normalizes one raw tag (strips leading `#`, whitespace, trailing punctuation). YAML frontmatter tags never get hex-filtered. */
export function normalizeTag(raw: string, options?: { fromYaml?: boolean }): string {
	const cleaned = raw.trim().replace(/^#+/, "").replace(/\/+$/, "");
	if (!cleaned || !/^[A-Za-z][A-Za-z0-9_/-]{0,63}$/.test(cleaned)) return "";
	if (!options?.fromYaml && isLikelyHexColorTag(cleaned)) return "";
	return cleaned;
}

/** Extracts all unique tags (YAML `tags:` + inline `#tag` outside code/URLs/wikilinks/HTML) from a Markdown document. */
export function extractTags(markdown: string): string[] {
	const seen = new Map<string, string>();
	const add = (raw: string, fromYaml = false) => {
		const clean = normalizeTag(raw, { fromYaml });
		if (!clean) return;
		const key = clean.toLowerCase();
		if (!seen.has(key)) seen.set(key, clean);
	};

	const fm = frontMatter(markdown);
	for (const raw of [...many(fm.values.tags), ...many(fm.values.tag)]) {
		for (const part of raw.split(/[\s,]+/)) add(part, true);
	}

	const lines = markdown.split(/\r?\n/);
	const fences = fenced(markdown);
	let offset = 0;
	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx]!;
		const start = offset;
		offset += line.length + (markdown[start + line.length] === "\r" ? 2 : 1);
		if (idx < fm.lines) continue;
		if (!line.includes("#")) continue;
		if (fences.some(([from, to]) => start >= from && start < to)) continue;
		// Skip Markdown ATX headings (`# Title`, `## Sub`).
		if (/^[ \t]{0,3}#{1,6}[ \t]+/.test(line)) continue;
		const searchable = stripInlineCodeAndUrls(line);
		for (const m of searchable.matchAll(INLINE_TAG_RE)) {
			add(m[2]!);
		}
	}
	return [...seen.values()];
}

export type TagBucket = {
	tag: string;
	count: number;
	files: DocFile[];
};

/** Aggregates tags across all workspace documents, sorted by frequency descending then alphabetically. */
export function workspaceTags(files: readonly DocFile[]): TagBucket[] {
	const map = new Map<string, TagBucket>();
	for (const file of files) {
		if (!file.exists || isCatalog(file) || !file.tags?.length) continue;
		for (const tag of file.tags) {
			const key = tag.toLowerCase();
			let bucket = map.get(key);
			if (!bucket) {
				bucket = { tag, count: 0, files: [] };
				map.set(key, bucket);
			}
			bucket.count++;
			bucket.files.push(file);
		}
	}
	return [...map.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
}
