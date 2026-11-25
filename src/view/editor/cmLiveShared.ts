// Shared CodeMirror 6 facets, effects, inline HTML renderer, widget focus helper,
// and inline-formatting helpers used across cmLivePlugin.ts, cmLiveTable.ts,
// cmLiveCallout.ts, cmKeymap.ts, and MarkdownLiveEditor.tsx.
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { Facet, StateEffect, StateField, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { linkWritten } from "../../shared/docLinks";
import { insertLinkEdit, toggleCheckboxLine, toggleInlineWrap } from "../../shared/markdownEdit";
import { docByName } from "../../shared/namedLinks";
import { dirName, relativePath } from "../../shared/paths";
import { docs } from "../project";
import { canonical, state as appState } from "../state";
import { finishMarkdown, type NameResolver, type TicketRef } from "./markdownHtml";

export type HoverTarget =
	| { kind: "href"; href: string; anchor: HTMLElement }
	| { kind: "wiki"; inner: string; anchor: HTMLElement }
	| { kind: "ticket"; key: string; anchor: HTMLElement }
	| { kind: "file"; path: string; line?: number; ticket?: string; anchor: HTMLElement };

export type ImageLightboxInfo = {
	src: string;
	alt: string;
	filePath?: string;
};

export type MermaidLightboxInfo = {
	svg: string;
	code: string;
};

export type LiveCallbacks = {
	filePath: () => string;
	onFollowLink: (href: string) => void;
	onFollowWiki: (inner: string) => void;
	onFollowTicket: (key: string) => void;
	onTagClick: (tag: string) => void;
	onHoverLink: (target: HoverTarget) => void;
	onHoverLeave: () => void;
	onCopyCode: (code: string) => void;
	onCopyCodeForDesigner?: (code: string) => Promise<void>;
	onOpenCodeScratch?: (code: string, lang: string) => Promise<void>;
	onSaveCodeSnippet?: (code: string, lang: string) => Promise<void>;
	onFormatCode?: (openLine: number) => Promise<"changed" | "unchanged" | "error">;
	onToggleCheckbox: (bracketPos: number) => void;
	onOpenImageLightbox: (info: ImageLightboxInfo) => void;
	onOpenMermaidLightbox?: (info: MermaidLightboxInfo) => void;
	onResizeImage: (from: number, to: number, width: number | null) => void;
	isYamlEditorOpen?: () => boolean;
};

export const liveCallbacksFacet = Facet.define<LiveCallbacks, LiveCallbacks | null>({
	combine: (values) => values[0] ?? null,
});

/** Optional fallback undo/redo backed by Monaco's model so Undo persists across Live <-> Read <-> Source switches. */
export type HistoryFallback = { undo(): boolean; redo(): boolean };

export const historyFallbackFacet = Facet.define<HistoryFallback, HistoryFallback | null>({
	combine: (values) => values[0] ?? null,
});

/** True when the unified CM6 view is in Read mode (never reveals raw Markdown syntax). */
export const readOnlyModeFacet = Facet.define<boolean, boolean>({
	combine: (values) => values.some(Boolean),
});

/** Effect dispatched whenever workspace `docs()` or broken-link status changes. */
export const refreshLiveEffect = StateEffect.define<number>();
/** Effect explicitly dropping a single table, callout, mermaid, or details block into raw Markdown mode. */
export const setRawEditBlockEffect = StateEffect.define<{ from: number; to: number } | null>();

/**
 * Tracks a block range `[from, to]` that the user explicitly opted to edit as raw Markdown
 * (via the `Raw` button on a Table or Callout). Automatically clears once the selection leaves it.
 */
export const rawEditBlockField = StateField.define<{ from: number; to: number } | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setRawEditBlockEffect)) return e.value;
		if (!value) return null;
		const mapped = {
			from: tr.changes.mapPos(value.from, -1),
			to: tr.changes.mapPos(value.to, 1),
		};
		if (tr.selection) {
			const touches = tr.state.selection.ranges.some((r) => r.from <= mapped.to && r.to >= mapped.from);
			if (!touches) return null;
		}
		return mapped;
	},
});

export type TableWidgetHost = HTMLDivElement & {
	__liveTableFocus?: (pos: number, opts?: { select?: boolean }) => boolean;
};

/** Stable fingerprint of active CM6 search state so block, inline, and code-highlight plugins stay synced. */
export function searchStateSig(state: EditorState): string {
	try {
		if (!searchPanelOpen(state)) return "";
		const q = getSearchQuery(state);
		return `1:${q.caseSensitive ? 1 : 0}:${q.regexp ? 1 : 0}:${q.wholeWord ? 1 : 0}:${q.search}`;
	} catch {
		return "";
	}
}

export type CalloutWidgetHost = HTMLDivElement & {
	__liveCalloutFocus?: (pos: number, opts?: { suppressEnter?: boolean }) => boolean;
};

/**
 * If document offset `pos` falls inside a rendered interactive Table or Callout widget in `view`,
 * opens and focuses that exact table cell or callout title/body editor in place.
 */
export function focusLiveWidgetAt(view: EditorView, pos: number, opts?: { select?: boolean; suppressEnter?: boolean }): boolean {
	if (view.state.facet(readOnlyModeFacet)) return false;
	const tables = view.dom.querySelectorAll<TableWidgetHost>(".cm-md-table-card");
	for (const el of tables) {
		if (el.__liveTableFocus?.(pos, opts)) return true;
	}
	const callouts = view.dom.querySelectorAll<CalloutWidgetHost>(".cm-md-callout");
	for (const el of callouts) {
		if (el.__liveCalloutFocus?.(pos, opts)) return true;
	}
	return false;
}

/**
 * Applies standard Markdown inline formatting shortcuts (`Ctrl+B`, `Ctrl+I`, `Ctrl+K`,
 * `Ctrl+L`, `Ctrl+Shift+X`, ``Ctrl+` ``, `Ctrl+Alt+H`) directly inside a table cell or
 * callout body `<textarea>`, firing an `input` event so changes commit immediately.
 */
export function applyMarkdownFormatToTextarea(el: HTMLTextAreaElement, actionId: string): boolean {
	const val = el.value;
	const start = el.selectionStart ?? 0;
	const end = el.selectionEnd ?? start;
	const markers: Record<string, string> = {
		"md-bold": "**",
		"md-italic": "*",
		"md-strike": "~~",
		"md-code": "`",
		"md-highlight": "==",
	};

	if (actionId in markers) {
		const res = toggleInlineWrap(val, start, end, markers[actionId]!);
		el.setRangeText(res.insert, res.changeFrom, res.changeTo, "select");
		el.setSelectionRange(res.selFrom, res.selTo);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}
	if (actionId === "md-link") {
		const res = insertLinkEdit(val, start, end);
		el.setRangeText(res.insert, res.changeFrom, res.changeTo, "select");
		el.setSelectionRange(res.selFrom, res.selTo);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}
	if (actionId === "md-checkbox" && el.classList.contains("cm-callout-body-input")) {
		const lineStart = start === 0 ? 0 : val.lastIndexOf("\n", start - 1) + 1;
		const lineEndRaw = val.indexOf("\n", end);
		const lineEnd = lineEndRaw < 0 ? val.length : lineEndRaw;
		const chunk = val.slice(lineStart, lineEnd);
		const nextChunk = chunk
			.split("\n")
			.map((ln) => toggleCheckboxLine(ln))
			.join("\n");
		const delta = nextChunk.length - chunk.length;
		el.setRangeText(nextChunk, lineStart, lineEnd, "end");
		if (start === end) el.setSelectionRange(Math.max(lineStart, start + delta), Math.max(lineStart, start + delta));
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}
	return false;
}

/**
 * Tags a document's own HTML may not bring into the window when its Markdown is rendered in a callout, a table
 * cell, a `<details>` block, an embedded note or a hover card. DOMPurify's defaults stop script and let these
 * through: a `<style>` in a callout restyled the whole app (a document outlined the status bar in red), and a
 * `<form>` with its button stood in a table cell. Kept out: what styles or re-points the window, what takes
 * input or sends it, what loads another document, what opens over the page or links from an image, and drawings
 * (`<svg>`, `<math>`), which bring links and styles of their own. A picture is an `<img>`, which stays. An
 * `<input>` is not listed because a task list's checkbox is one: renderedKeepsElement decides it.
 */
const RENDERED_FORBID_TAGS = [
	"style", "link", "meta", "base",
	"form", "button", "select", "option", "optgroup", "datalist", "textarea",
	"script", "iframe", "frame", "frameset", "object", "embed",
	"dialog", "area", "map",
	"svg", "math",
];

/** Attributes that send, or open something over the page, on the elements that are left. */
const RENDERED_FORBID_ATTR = ["action", "formaction", "ping", "usemap", "popover", "popovertarget", "command", "commandfor"];

export const RENDERED_PURIFY_CONFIG = { FORBID_TAGS: RENDERED_FORBID_TAGS, FORBID_ATTR: RENDERED_FORBID_ATTR };

/**
 * Whether an element the lists above let through stays. The one `<input>` rendered Markdown needs is the
 * checkbox of a task list (`- [ ] item`), which a callout finds and ties to its line of the document. Any other
 * is a field to type in, and the document has no use for what is typed.
 */
export function renderedKeepsElement(tag: string, type: string | null | undefined): boolean {
	return tag.toLowerCase() !== "input" || (type ?? "").trim().toLowerCase() === "checkbox";
}

let renderedSanitizer: typeof DOMPurify | undefined;

/** A sanitiser of the rendered documents' own: the rule above is a hook, and a hook on the shared one would run for every other caller of it. */
function sanitizer(): typeof DOMPurify {
	if (!renderedSanitizer) {
		renderedSanitizer = typeof window === "undefined" ? DOMPurify : DOMPurify(window);
		if (renderedSanitizer !== DOMPurify && renderedSanitizer.isSupported) {
			renderedSanitizer.addHook("uponSanitizeElement", (node, data) => {
				const type = (node as Partial<Element>).getAttribute?.("type");
				if (!renderedKeepsElement(data.tagName, type)) node.parentNode?.removeChild(node);
			});
		}
	}
	return renderedSanitizer;
}

/** The HTML of a document's rendered Markdown, with what may not stand in the window taken out. */
export function sanitizeRendered(html: string): string {
	return sanitizer().sanitize(html, RENDERED_PURIFY_CONFIG);
}

/**
 * The address of the link a click on `target` would follow: that of the nearest anchor it stands in, HTML or SVG
 * (a Mermaid flowchart's `click A href "…"` draws an `<a xlink:href>`), or of the area of an image map. As
 * written, and "" for a link that names none; null when the target stands in no link below `within`.
 */
export function clickedLink(target: unknown, within?: unknown): string | null {
	const from = target as Node | null;
	let el: Element | null = !from ? null : from.nodeType === 1 ? (from as Element) : (from.parentElement ?? null);
	for (; el && el !== within; el = el.parentElement) {
		if (el.localName === "a" || el.localName === "area") return el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
	}
	return null;
}

/**
 * Keeps a click in rendered Markdown from taking the window somewhere else. The handlers of the callout, table,
 * `<details>` and embed cards each stop an `a[href]`; an SVG anchor, an image map's area, a link in a diagram and
 * a form's submit went past them, and the window left the app for the address. So, before any of them (in the
 * capture phase), the click on a link, the middle click that would open it in a new window, and every submit
 * lose what the browser would do. A link no card took for itself then reaches `follow` as the click bubbles up,
 * to be opened the way the editor opens its links; with Alt held it is left alone, as the cards leave theirs.
 * Returns what takes the guard off again.
 */
export function guardRenderedLinks(root: HTMLElement, follow?: (href: string) => void): () => void {
	const cancel = (e: Event) => {
		if (e.type === "submit" || clickedLink(e.target, root) !== null) e.preventDefault();
	};
	const open = (e: MouseEvent) => {
		const href = clickedLink(e.target, root);
		if (href && !e.altKey) follow?.(href);
	};
	root.addEventListener("click", cancel, true);
	root.addEventListener("auxclick", cancel, true);
	root.addEventListener("submit", cancel, true);
	root.addEventListener("click", open);
	return () => {
		root.removeEventListener("click", cancel, true);
		root.removeEventListener("auxclick", cancel, true);
		root.removeEventListener("submit", cancel, true);
		root.removeEventListener("click", open);
	};
}

/** Builds `finishMarkdown` options and sanitizes nested HTML for Table cells and Callout bodies. */
export function renderInlineHtml(markdown: string, filePath: string, inlineOnly = false, breaks = false): string {
	const root = appState.workspace?.root;
	const all = docs();
	const here = canonical(filePath);
	const tickets: TicketRef[] = all
		.filter((d) => d.group === "tickets" && d.exists && d.ticket && canonical(d.path) !== here)
		.map((d) => {
			const title = d.title ?? "";
			const named = title.toLowerCase().startsWith(d.ticket!.toLowerCase()) ? title : [d.ticket, title].filter(Boolean).join(": ");
			return { key: d.ticket!, href: linkWritten(relativePath(dirName(here), d.path)), about: `${named}${d.status ? ` (${d.status})` : ""}` };
		});
	const named: NameResolver = (name) => {
		const found = docByName(name, all, root);
		if (!found) return null;
		const title = found.title ?? "";
		return {
			href: linkWritten(relativePath(dirName(here), found.path)),
			about: [found.ticket && !title.toLowerCase().startsWith(found.ticket.toLowerCase()) ? found.ticket : "", title || found.name].filter(Boolean).join(": "),
		};
	};
	const parsed = inlineOnly
		? (marked.parseInline(markdown, { async: false, gfm: true, breaks }) as string)
		: (marked.parse(markdown, { async: false, gfm: true, breaks }) as string);
	const raw = sanitizeRendered(parsed);
	return finishMarkdown(raw, { tickets, named });
}
