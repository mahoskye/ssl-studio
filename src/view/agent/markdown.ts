// A reply rendered as Markdown, the way the reading view renders a document:
// marked, then DOMPurify, then the columns that must not wrap (ADR 0008), by the
// same step (editor/markdownHtml.ts), plus clickable [[wikilinks]], ticket keys,
// and file#L12 / file#heading anchors.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { findHeadingLine } from "../../shared/markdownEdit";
import { docByName, namedLink } from "../../shared/namedLinks";
import { isInside, resolvePath } from "../../shared/paths";
import { backend } from "../backend";
import { finishMarkdown, type NameResolver, type TicketRef } from "../editor/markdownHtml";
import { searchFor } from "../panels/Search";
import { docs } from "../project";
import { canonical, documents, openFile, state } from "../state";

/**
 * A reply is a model's words, and may repeat text it was shown. Nothing in it
 * may load from the network or take input: an image address can carry data out.
 */
const FORBIDDEN = [
	"img", "picture", "source", "video", "audio", "iframe", "object", "embed",
	"form", "input", "button", "select", "textarea", "style", "svg", "math",
	"canvas", "dialog", "area", "track",
];

const FORBIDDEN_ATTRS = [
	"style", "background", "poster", "src", "srcset", "ping",
	"action", "formaction", "popover", "popovertarget", "command", "commandfor",
];

export const REPLY_PURIFY_CONFIG = {
	FORBID_TAGS: FORBIDDEN,
	FORBID_ATTR: FORBIDDEN_ATTRS,
	ALLOW_DATA_ATTR: false,
	ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ticket|wiki|file-ref):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
};

const WORKSPACE_FILE_EXT = "(?:ssl|srvscr|ds|sql|ddl|pks|pkb|xfd|hl7|astm|ini|config|svg|md|markdown|csv|tsv|json|toml|ya?ml|xml|xsd|txt|ts|tsx|js|css)";
const SINGLE_FILE_COLON_LINK_RE = new RegExp(`\\[([^\\]]+)\\]\\(([^\\s()/:]+\\.${WORKSPACE_FILE_EXT}:\\d+(?:-\\d+)?)\\)`, "gi");
const BACKTICK_PATH_RE = new RegExp("`([A-Za-z0-9_./\\\\ -]+\\." + WORKSPACE_FILE_EXT + "(?::\\d+(?:-\\d+)?|#L\\d+(?:-L?\\d+)?)?)`", "gi");

/** Finds `[label](url)` Markdown link ranges on a line so backtick auto-linkification never nests links inside links. */
function existingLinkRanges(line: string): [number, number][] {
	const ranges: [number, number][] = [];
	for (const m of line.matchAll(/\[[^\]]+\]\([^)\n]+\)/g)) {
		if (m.index !== undefined) ranges.push([m.index, m.index + m[0].length]);
	}
	return ranges;
}

/**
 * Protects single-filename `:line` links (`[foo.ssl:42](foo.ssl:42)`) and backticked workspace paths
 * from being mangled as unknown URI schemes by DOMPurify, turning them into clickable `file-ref://` links.
 */
export function rewriteFileLinksBeforeParse(text: string): string {
	// Skip fenced code blocks while rewriting prose lines.
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let fence: { ch: string; len: number } | null = null;
	const out: string[] = [];
	for (const line of lines) {
		const fm = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fm) {
			const ch = fm[1]![0]!;
			const len = fm[1]!.length;
			const info = fm[2]!;
			if (!fence) {
				// Per CommonMark §4.5, a backtick fence's info string cannot contain backticks
				// (lines like ```` ```foo.ssl``` ```` are inline code spans, not opening fences).
				if (!(ch === "`" && info.includes("`"))) {
					fence = { ch, len };
					out.push(line);
					continue;
				}
			} else if (ch === fence.ch && len >= fence.len && info.trim() === "") {
				fence = null;
				out.push(line);
				continue;
			}
		}
		if (fence) {
			out.push(line);
			continue;
		}
		let next = line.replace(SINGLE_FILE_COLON_LINK_RE, (_, label: string, ref: string) => `[${label}](file-ref://${encodeURIComponent(ref)})`);
		// Linkify standalone backticked workspace file paths (skipping anything inside existing `[...](...)` links or multi-backtick code spans).
		const linkSpans = next.includes("](") ? existingLinkRanges(next) : [];
		next = next.replace(BACKTICK_PATH_RE, (full, ref: string, offset: number, whole: string) => {
			if ((offset > 0 && whole[offset - 1] === "`") || whole[offset + full.length] === "`") return full;
			if (linkSpans.some(([from, to]) => offset >= from && offset < to)) return full;
			const trimmed = ref.trim();
			if (!trimmed || /^\s|\s$/.test(ref)) return full;
			return `[\`${trimmed}\`](file-ref://${encodeURIComponent(trimmed)})`;
		});
		out.push(next);
	}
	return out.join("\n");
}

/** Clean HTML for a reply. Resolves [[wikilinks]], ticket keys, and workspace file paths as safe clickable links. */
export function renderReply(text: string): string {
	const root = state.workspace?.root;
	const all = docs();
	const tickets: TicketRef[] = [];
	for (const d of all) {
		if (d.exists && d.group === "tickets" && d.ticket) {
			tickets.push({
				key: d.ticket,
				href: `ticket:${encodeURIComponent(d.ticket)}`,
				about: [d.ticket, d.title, d.status ? `(${d.status})` : ""].filter(Boolean).join(" — "),
			});
		}
	}
	const named: NameResolver = (name) => {
		const parsed = namedLink(name);
		if (!parsed) return null;
		const found = root ? docByName(parsed.name, all, root) : null;
		if (!found) return null;
		return {
			href: `wiki:${encodeURIComponent(name)}`,
			about: [found.title || found.name, found.status ? `(${found.status})` : ""].filter(Boolean).join(" "),
		};
	};
	const prepared = rewriteFileLinksBeforeParse(text);
	const html = marked.parse(prepared, { async: false, gfm: true }) as string;
	const clean = DOMPurify.sanitize(html, REPLY_PURIFY_CONFIG);
	return finishMarkdown(clean, { tickets: tickets.length ? tickets : undefined, named });
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** A link in a reply never navigates the app: workspace files, [[wikilinks]], ticket keys, #tags, and #L10-L20 / #heading anchors open cleanly. */
export async function followReplyLink(e: MouseEvent) {
	const targetEl = e.target as HTMLElement | null;
	if (!targetEl) return;

	// Inline #tag badge click -> launch workspace Search with clean scope so stale Code filters don't hide docs.
	const tagEl = targetEl.closest<HTMLElement>(".md-tag");
	if (tagEl) {
		const tag = tagEl.dataset.tag || tagEl.textContent?.trim() || "";
		if (tag) {
			e.preventDefault();
			searchFor(tag.startsWith("#") ? tag : `#${tag}`, { include: "", exclude: "", wholeWord: true });
		}
		return;
	}

	const link = targetEl.closest("a");
	if (!link) return;
	e.preventDefault();
	let href = link.getAttribute("href") ?? "";
	const root = state.workspace?.root;
	if (/^https?:/i.test(href)) return void window.open(href, "_blank", "noopener");

	// Ticket key link injected by finishMarkdown (`data-ticket` or `ticket:` href)
	const rawTicket = link.getAttribute("data-ticket") || (/^ticket:(.+)$/i.exec(href)?.[1] ?? "");
	if (rawTicket) {
		const ticketKey = safeDecode(rawTicket);
		const found = docs().find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === ticketKey.toLowerCase());
		if (found) void openFile(found.path);
		return;
	}

	// Wikilink (`wiki:...`)
	if (href.startsWith("wiki:") && root) {
		const inner = safeDecode(href.slice(5));
		const parsed = namedLink(inner);
		if (!parsed) return;
		const found = docByName(parsed.name, docs(), root);
		if (!found) return;
		if (parsed.heading) {
			const open = documents.get(canonical(found.path));
			const text = open ? open.model.getValue() : await backend.read(found.path).then((r) => r.text, () => "");
			const line = findHeadingLine(text, parsed.heading);
			void openFile(found.path, line ? { reveal: { line } } : {});
		} else {
			void openFile(found.path);
		}
		return;
	}

	// Internal `file-ref://` links generated from `file.ssl:42` or backticked paths (decoded once only).
	let alreadyDecoded = false;
	if (href.startsWith("file-ref://")) {
		href = safeDecode(href.slice("file-ref://".length));
		alreadyDecoded = true;
	}

	if (!href || href.startsWith("#")) return;
	// Ignore external URI schemes (mailto:, ftp:, etc.) while allowing bare filename:line (`SetSampleDueDates.ssl:42`).
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[^/:\\]+\.[a-z0-9]{1,8}:\d+/i.test(href)) return;
	if (!root) return;

	const hashAt = href.indexOf("#");
	const rawPath = hashAt >= 0 ? href.slice(0, hashAt) : href;
	const rawHash = hashAt >= 0 ? href.slice(hashAt + 1) : "";
	const rawPathNoQuery = rawPath.split("?")[0]!;
	let relative = (alreadyDecoded ? rawPathNoQuery : safeDecode(rawPathNoQuery)).replace(/\\/g, "/");

	let lineNum: number | undefined;
	let endLineNum: number | undefined;
	const colonRange = /:(\d+)(?:-(\d+))?$/.exec(relative);
	if (colonRange) {
		lineNum = Number(colonRange[1]);
		if (colonRange[2]) endLineNum = Number(colonRange[2]);
		relative = relative.slice(0, colonRange.index);
	}

	let target = resolvePath(root, relative);
	if (!isInside(root, target)) return;

	// If bare filename (no slash) didn't match a root file directly, look up matching workspace file by basename.
	if (!relative.includes("/")) {
		const allFiles = await backend.files().catch(() => []);
		const targetLow = canonical(target);
		const rootMatch = allFiles.find((f) => canonical(f) === targetLow);
		if (rootMatch && isInside(root, rootMatch)) {
			target = rootMatch;
		} else {
			const lower = relative.toLowerCase();
			const exact = allFiles.find((f) => f.replace(/\\/g, "/").toLowerCase().endsWith(`/${lower}`));
			if (exact && isInside(root, exact)) target = exact;
		}
	}

	if (!lineNum && rawHash) {
		const lineHash = /^L(\d+)(?:-L?(\d+))?$/i.exec(rawHash.trim());
		if (lineHash) {
			lineNum = Number(lineHash[1]);
			if (lineHash[2]) endLineNum = Number(lineHash[2]);
		} else {
			const open = documents.get(canonical(target));
			const text = open ? open.model.getValue() : await backend.read(target).then((r) => r.text, () => "");
			const foundLine = findHeadingLine(text, safeDecode(rawHash));
			if (foundLine) lineNum = foundLine;
		}
	}
	void openFile(target, lineNum ? { reveal: { line: lineNum, ...(endLineNum ? { endLine: endLineNum } : {}) } } : {});
}
