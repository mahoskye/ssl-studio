// Pure workspace #tag extractor and aggregator for Markdown documents.
// Combines YAML frontmatter `tags:` / `tag:` with inline prose `#tags` while
// strictly skipping fenced code blocks, inline code spans, Markdown URLs, and hex colors.
import { fenced } from "./catalog";
import { frontMatter, many } from "./frontMatter";
import { isCatalog } from "./projectDocs";
import type { DocFile } from "./protocol";

const HEX_COLOR_RE = /^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const INLINE_TAG_RE = /(^|[\s([{"'.,;:])#([A-Za-z][A-Za-z0-9_/-]{0,63})(?=$|[\s)\]}"'.,;:!?])/g;

/** Removes inline code spans (`...`, ``...``) and Markdown link destinations `(...#anchor)` from a single line. */
function stripInlineCodeAndUrls(line: string): string {
	// Mask inline backtick code spans (supports arbitrary backtick run lengths).
	let out = "";
	let i = 0;
	while (i < line.length) {
		if (line[i] === "`") {
			let run = 0;
			while (i + run < line.length && line[i + run] === "`") run++;
			const ticks = "`".repeat(run);
			const close = line.indexOf(ticks, i + run);
			if (close >= 0) {
				out += " ".repeat(close + run - i);
				i = close + run;
				continue;
			}
		}
		out += line[i++];
	}
	// Mask `](...)` link targets and `<http...>` autolinks so `#heading` anchors never register as tags.
	return out
		.replace(/\]\([^)\n]*\)/g, "]()")
		.replace(/<https?:\/\/[^>\s]+>/gi, "<>")
		.replace(/https?:\/\/[^\s)>]+/gi, "");
}

/** Normalizes one raw tag (strips leading `#`, whitespace, trailing punctuation). */
export function normalizeTag(raw: string): string {
	const cleaned = raw.trim().replace(/^#+/, "").replace(/\/+$/, "");
	if (!cleaned || !/^[A-Za-z][A-Za-z0-9_/-]{0,63}$/.test(cleaned)) return "";
	if (HEX_COLOR_RE.test(cleaned)) return "";
	return cleaned;
}

/** Extracts all unique tags (YAML `tags:` + inline `#tag` outside code/URLs) from a Markdown document. */
export function extractTags(markdown: string): string[] {
	const seen = new Map<string, string>();
	const add = (raw: string) => {
		const clean = normalizeTag(raw);
		if (!clean) return;
		const key = clean.toLowerCase();
		if (!seen.has(key)) seen.set(key, clean);
	};

	const fm = frontMatter(markdown);
	for (const raw of [...many(fm.values.tags), ...many(fm.values.tag)]) {
		for (const part of raw.split(/[\s,]+/)) add(part);
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
