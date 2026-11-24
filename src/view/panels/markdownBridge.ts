// Lightweight reactive bridge between Markdown editors (Live, Read, Source)
// and the shared right-hand Document panel (Info | Outline tabs).
// Pure helpers here have zero browser/Monaco dependencies so they can be unit-tested directly.
import { createSignal } from "solid-js";
import { GOVERNANCE_PROPERTY_KEYS } from "../editor/markdownHtml";
import { recall, remember } from "../graph/canvas";

export type MarkdownPanelTab = "info" | "outline";
export type MarkdownInspectorFocus = "properties" | "yaml" | "work" | "links";
export type MarkdownLinksTab = "backlinks" | "outgoing" | "unlinked";

export type MarkdownPanelTabRequest = {
	tab: MarkdownPanelTab;
	focus?: MarkdownInspectorFocus;
	seq: number;
};

export type MarkdownLinksSummary = {
	path: string;
	backlinks: number;
	outgoing: number;
	unlinked: number;
	broken: number;
	total: number;
};

export type InspectorPropertyFact = {
	key: string;
	values: string[];
};

export type CompactHeaderMeta = {
	ticketLabel: string;
	statusLabel: string;
	hasLeftMeta: boolean;
	linksLabel: string;
	brokenCount: number;
	linksTitle: string;
};

export const MD_PANEL_TAB_KEY = "md.panel.tab";

const GOVERNANCE_KEY_SET: ReadonlySet<string> = new Set(GOVERNANCE_PROPERTY_KEYS.map((k) => k.toLowerCase()));

/** Parses a persisted Markdown panel tab value, returning null when unset or invalid. */
export function parseMarkdownPanelTab(raw: string | null | undefined): MarkdownPanelTab | null {
	if (raw === "info" || raw === "outline") return raw;
	return null;
}

/**
 * Resolves which Document panel tab should show for a Markdown file:
 * - Honors whatever tab the user explicitly chose last (`stored`).
 * - Otherwise defaults to `"info"` when the document has frontmatter or is a ticket,
 *   and `"outline"` for plain prose/reference Markdown files without frontmatter.
 */
export function defaultMarkdownPanelTab(hasMetaOrTicket: boolean, stored?: string | null): MarkdownPanelTab {
	const parsed = parseMarkdownPanelTab(stored);
	if (parsed) return parsed;
	return hasMetaOrTicket ? "info" : "outline";
}

/** Normalizes frontmatter key/value pairs for display in the Properties section (excluding `title` and empties). */
export function extractDisplayProperties(values: Record<string, string | string[]>): InspectorPropertyFact[] {
	const out: InspectorPropertyFact[] = [];
	for (const [key, raw] of Object.entries(values)) {
		if (key === "title") continue;
		const list = Array.isArray(raw) ? raw.filter((v) => v.length > 0) : raw ? [raw] : [];
		if (list.length > 0) out.push({ key, values: list });
	}
	return out;
}

/** Splits display properties into document metadata vs controlled-document governance fields. */
export function groupPropertiesForInspector(
	facts: readonly InspectorPropertyFact[],
	governanceKeys: ReadonlySet<string> = GOVERNANCE_KEY_SET,
): { primary: InspectorPropertyFact[]; governance: InspectorPropertyFact[] } {
	const primary: InspectorPropertyFact[] = [];
	const governance: InspectorPropertyFact[] = [];
	for (const fact of facts) {
		if (governanceKeys.has(fact.key.toLowerCase())) governance.push(fact);
		else primary.push(fact);
	}
	return { primary, governance };
}

/** Formats the whisper-quiet top metadata strip inside the Markdown editor canvas. */
export function formatCompactHeaderMeta(input: {
	ticket?: string | null;
	status?: string | null;
	totalLinks: number;
	brokenLinks: number;
}): CompactHeaderMeta {
	const ticketLabel = (input.ticket ?? "").trim();
	const statusLabel = (input.status ?? "").trim();
	const total = Math.max(0, Math.floor(input.totalLinks));
	const brokenCount = Math.max(0, Math.floor(input.brokenLinks));
	const linksLabel = `Links (${total})`;
	const linksTitle =
		brokenCount > 0
			? `Open Links inspector (${brokenCount} broken outgoing ${brokenCount === 1 ? "link" : "links"})`
			: "Open Links inspector (Backlinks, Outgoing, Unlinked mentions)";
	return {
		ticketLabel,
		statusLabel,
		hasLeftMeta: Boolean(ticketLabel || statusLabel),
		linksLabel,
		brokenCount,
		linksTitle,
	};
}

/** Picks the most helpful Links tab when jumping to the Links section from the editor. */
export function chooseDefaultLinksTab(counts: {
	backlinks: number;
	outgoing: number;
	unlinked: number;
	brokenOutgoing: number;
	backlinksLoading?: boolean;
}): MarkdownLinksTab {
	if (counts.brokenOutgoing > 0) return "outgoing";
	if (counts.backlinksLoading) return "backlinks";
	if (counts.backlinks > 0) return "backlinks";
	if (counts.outgoing > 0) return "outgoing";
	if (counts.unlinked > 0) return "unlinked";
	return "backlinks";
}

/** Computes a minimal single-slice text diff for undo-preserving Monaco model updates (ADR 0002). */
export function computeMinimalTextChange(
	prev: string,
	next: string,
): { start: number; endPrev: number; insert: string } | null {
	if (prev === next) return null;
	let start = 0;
	const minLen = Math.min(prev.length, next.length);
	while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
	let endPrev = prev.length;
	let endNext = next.length;
	while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
		endPrev--;
		endNext--;
	}
	return { start, endPrev, insert: next.slice(start, endNext) };
}

// --- Reactive bridge signals -------------------------------------------------

const initialStored = parseMarkdownPanelTab(recall(MD_PANEL_TAB_KEY));
const [activeMarkdownTab, setActiveMarkdownTab] = createSignal<MarkdownPanelTab>(initialStored ?? "info");
const [hasSavedMarkdownTab, setHasSavedMarkdownTab] = createSignal<boolean>(initialStored !== null);
const [markdownPanelTabRequest, setMarkdownPanelTabRequest] = createSignal<MarkdownPanelTabRequest | null>(null);
const [markdownYamlEditorOpen, setMarkdownYamlEditorOpen] = createSignal<boolean>(false);
const [markdownLinksSummary, setMarkdownLinksSummary] = createSignal<MarkdownLinksSummary | null>(null);

let reqSeq = 0;
let panelOpener: (() => void) | null = null;

export {
	activeMarkdownTab,
	hasSavedMarkdownTab,
	markdownLinksSummary,
	markdownPanelTabRequest,
	markdownYamlEditorOpen,
	setActiveMarkdownTab,
	setMarkdownLinksSummary,
	setMarkdownYamlEditorOpen,
};

/** Registers a synchronous callback to open the Document ("objects") side panel. */
export function registerMarkdownPanelOpener(opener: () => void): void {
	panelOpener = opener;
}

/** User-initiated switch between Info and Outline tabs, persisted across sessions. */
export function chooseMarkdownPanelTab(tab: MarkdownPanelTab): void {
	setActiveMarkdownTab(tab);
	setHasSavedMarkdownTab(true);
	remember(MD_PANEL_TAB_KEY, tab);
}

/** Opens the right-hand Document panel onto the Info tab and optionally focuses a section. */
export function requestMarkdownInspector(focus?: MarkdownInspectorFocus): void {
	setActiveMarkdownTab("info");
	setMarkdownPanelTabRequest({ tab: "info", focus, seq: ++reqSeq });
	if (panelOpener) {
		panelOpener();
	} else if (typeof document !== "undefined") {
		void import("./registry").then((m) => m.showPanel("objects"));
	}
}

/** Opens the right-hand Document panel onto either Markdown tab (`info` or `outline`). */
export function requestMarkdownPanelTab(tab: MarkdownPanelTab, focus?: MarkdownInspectorFocus): void {
	setActiveMarkdownTab(tab);
	setMarkdownPanelTabRequest({ tab, focus, seq: ++reqSeq });
	if (panelOpener) {
		panelOpener();
	} else if (typeof document !== "undefined") {
		void import("./registry").then((m) => m.showPanel("objects"));
	}
}
