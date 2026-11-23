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
/** Effect toggling raw YAML frontmatter visibility inside the editor. */
export const setEditYamlEffect = StateEffect.define<boolean>();
/** Effect explicitly dropping a single table or callout block into raw Markdown mode. */
export const setRawEditBlockEffect = StateEffect.define<{ from: number; to: number } | null>();

export const editYamlField = StateField.define<boolean>({
	create: () => false,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setEditYamlEffect)) return e.value;
		return value;
	},
});

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
		const lineStart = val.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
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
	const raw = DOMPurify.sanitize(parsed);
	return finishMarkdown(raw, { tickets, named });
}
