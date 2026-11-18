// A reply rendered as Markdown, the way the reading view renders a document
// (editor/MarkdownView.tsx): marked, then DOMPurify, then the columns that
// must not wrap (ADR 0008), by the same step (editor/markdownHtml.ts).
import DOMPurify from "dompurify";
import { marked } from "marked";
import { finishMarkdown } from "../editor/markdownHtml";
import { isInside, resolvePath } from "../../shared/paths";
import { openFile, state } from "../state";

/**
 * A reply is a model's words, and may repeat text it was shown. Nothing in it
 * may load from the network or take input: an image address can carry data out.
 */
const FORBIDDEN = ["img", "picture", "source", "video", "audio", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "style", "svg", "math"];

/** Clean HTML for a reply. While it is still being written, an open fence renders as code to its end. */
export function renderReply(text: string): string {
	const html = marked.parse(text, { async: false, gfm: true }) as string;
	return finishMarkdown(DOMPurify.sanitize(html, { FORBID_TAGS: FORBIDDEN }));
}

/** A link in a reply never navigates the app: a workspace file opens as a tab, a web link opens outside. */
export function followReplyLink(e: MouseEvent) {
	const link = (e.target as HTMLElement).closest("a");
	if (!link) return;
	e.preventDefault();
	const href = link.getAttribute("href") ?? "";
	if (/^https?:/i.test(href)) return void window.open(href, "_blank", "noopener");
	if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
	const root = state.workspace?.root;
	if (!root) return;
	let relative: string;
	try {
		relative = decodeURIComponent(href.split(/[?#]/)[0]!);
	} catch {
		return;
	}
	// A reply has no folder of its own: its paths are read from the workspace's root.
	const target = resolvePath(root, relative);
	if (isInside(root, target)) void openFile(target);
}
