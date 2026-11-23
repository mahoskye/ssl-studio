// Unified Obsidian-grade CodeMirror 6 engine for BOTH Markdown Live Preview and Read view (ADR 0028).
// Synced 1:1 with the open document's Monaco ITextModel (ADR 0002: plain text stays the single
// source of truth for saves, undo across views, Git, Search, Diagnostics, Agent, and Document Outline).
import { history } from "@codemirror/commands";
import { foldAll as cmFoldAll, foldEffect, foldedRanges, unfoldAll as cmUnfoldAll } from "@codemirror/language";
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Annotation, Compartment, EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, drawSelection, dropCursor, EditorView, highlightSpecialChars } from "@codemirror/view";
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { localDay } from "../../shared/dates";
import { evaluateTicketReadiness } from "../../shared/docExport";
import { linkLeads, withLinkFile } from "../../shared/docLinks";
import { fenceAtLine, fenceFormatTarget } from "../../shared/fencedFormat";
import {
	addToFrontMatterList,
	formatFrontMatterInnerReplacement,
	frontMatter,
	frontMatterInnerSpan,
	one,
	quoteYamlScalar,
	removeFromFrontMatterList,
	stripEmptyFrontMatter,
	withFrontMatter,
} from "../../shared/frontMatter";
import { tagSearchPattern, workspaceTags } from "../../shared/tags";
import { documentHeadings, findHeadingLine, withImageWidth } from "../../shared/markdownEdit";
import type { TableAlign } from "../../shared/markdownTables";
import { docByName, linkedFrom, namedLink, nameFor } from "../../shared/namedLinks";
import { baseName, dirName, isInside, joinPath, relativeTo, resolvePath } from "../../shared/paths";
import { DOC_FOLDERS, isCatalog, registryTitle, statusChoices, toneOf } from "../../shared/projectDocs";
import { rowsLine } from "../../shared/registryTickets";
import { descendantTickets, docLinkedTickets, ticketWork } from "../../shared/workContext";
import { lineChanges, type LineChange } from "../../shared/lineDiff";
import { gitStatus, gitVersion } from "../git";
import { backend } from "../backend";
import { ask, choose } from "../dialogs";
import { Icon } from "../Icon";
import { Menu } from "../Menu";
import { noteCursor } from "../navigation";
import { submenuOrInline } from "../../shared/contextMenu";
import { chooseFromMenu, type RowMenuEntry } from "../panels/RowMenu";
import { searchFor } from "../panels/Search";
import { docs } from "../project";
import {
	addRegistryRowForTicket,
	closeoutTicket,
	createTicketFolder,
	exportDeploymentManifest,
	exportDocAs,
	exportTicketPacket,
	isArchivedTicket,
	linkDocumentToTicket,
	linkNonTicketToTicket,
	newKnowledge,
	newSpec,
	newTicket,
	newTicketFile,
	promoteQuestionToDecision,
	setStatus,
	unarchiveTicket,
	unlinkDocumentFromTicket,
} from "../projectDocs";
import {
	canonical,
	documents,
	notify,
	openFile,
	openedForALook,
	revealSignal,
	save,
	setMarkdownMode,
	setState,
	state,
	takeReveal,
} from "../state";
import { insertCalloutInteractive, insertImageInteractive, insertMarkdownTemplate } from "../templater";
import { themeVersion } from "../themes/themes";
import { liveCodeHighlightPlugin } from "./cmCodeHighlight";
import { cmMarkdownCompletion, createTextareaCompleter, type TextareaCompleter } from "./cmCompletion";
import {
	activeTableAtCursor,
	cmAutoWrapExtension,
	cmMarkdownKeymap,
	cmSearchTop,
	cmSmartPasteExtension,
	historyFallbackFacet,
	runCmAction,
	runTableAction,
} from "./cmKeymap";
import "./cmLive.css";
import {
	linkAtOffset,
	liveBlockField,
	liveCallbacksFacet,
	liveInlinePlugin,
	liveInteractionExtension,
	markdownFoldService,
	rawEditBlockField,
	readOnlyModeFacet,
	refreshLiveEffect,
	setRawEditBlockEffect,
	type HoverTarget,
	type ImageLightboxInfo,
} from "./cmLivePlugin";
import { applyMarkdownFormatToTextarea, focusLiveWidgetAt, type MermaidLightboxInfo } from "./cmLiveShared";
import { copyMermaidAsPng, downloadMermaidBlob, renderMermaidSvgForExport } from "./cmMermaid";
import { cmMarkdownHighlight, cmStudioTheme } from "./cmTheme";
import { buildHoverPreview, type HoverPreviewData } from "./hoverPreview";
import { hydrateImagesInElement } from "./imageResolve";
import { formatCodeFence } from "./languages";
import {
	bumpLiveSelection,
	emitSplitScrollSync,
	onSplitScrollSync,
	registerLiveEditor,
	registerReadFind,
	saveMarkdownSyncAnchor,
	takeMarkdownSyncAnchor,
	type LiveEditorHandle,
} from "./liveBridge";
import { colourCode } from "./markdownCode";
import { hydrateMathInElement } from "./markdownHtml";
import {
	extractLineContextSnippet,
	extractOutgoingLinks,
	findUnlinkedMentions,
	linkifyMentionInText,
	mentionTermsForDoc,
	type OutgoingLinkItem,
	type UnlinkedMentionItem,
} from "./markdownLinks";
import { mdOutline, setMdOutline } from "./mdOutline";
import { monaco } from "./monaco";
import { askRows } from "./tableRows";

type SavedLiveView = { anchor: number; head: number; scrollTop: number; folds?: [number, number][] };
const savedLiveViews = new Map<string, SavedLiveView>();

type HoverCardState = HoverPreviewData & {
	x: number;
	y: number;
};

type ActiveTableHud = {
	row: number;
	col: number;
	rowCount: number;
	colCount: number;
	align: TableAlign;
	canDeleteRow: boolean;
	canMoveRowUp: boolean;
	canMoveRowDown: boolean;
	canDeleteCol: boolean;
	canMoveColLeft: boolean;
	canMoveColRight: boolean;
};

/** Marks programmatic model->CM6 syncs so Read mode's transaction filter permits them. */
const externalSyncAnnotation = Annotation.define<boolean>();

/** Subtle left-edge Git gutter marks inside CM6 Live Preview (matching Monaco gitMarks). */
const setGitChangesEffect = StateEffect.define<LineChange[]>();
const gitMarksField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setGitChangesEffect)) {
				const builder = new RangeSetBuilder<Decoration>();
				const last = tr.state.doc.lines;
				const seen = new Set<number>();
				for (const change of e.value) {
					const start = Math.min(Math.max(change.line, 1), last);
					const end = change.kind === "removed" ? start : Math.min(Math.max(change.endLine, start), last);
					const cls = change.kind === "added" ? "cm-git-added" : change.kind === "removed" ? "cm-git-removed" : "cm-git-modified";
					for (let ln = start; ln <= end; ln++) {
						if (seen.has(ln)) continue;
						seen.add(ln);
						const line = tr.state.doc.line(ln);
						builder.add(line.from, line.from, Decoration.line({ class: cls }));
					}
				}
				return builder.finish();
			}
		}
		return tr.docChanged ? value.map(tr.changes) : value;
	},
	provide: (f) => EditorView.decorations.from(f),
});

async function readFileText(path: string): Promise<string> {
	const key = canonical(path);
	const open = documents.get(key);
	if (open) return open.model.getValue();
	try {
		return (await backend.read(path)).text;
	} catch {
		return "";
	}
}

export function MarkdownLiveEditor(props: { path: string; group: number; mode?: "live" | "read" }) {
	const doc = documents.get(props.path);
	const model = doc?.model;
	const isRead = () => props.mode === "read";
	const [text, setText] = createSignal(model?.getValue() ?? "");
	const [propsOpen, setPropsOpen] = createSignal(true);
	const [editYaml, setEditYaml] = createSignal(false);
	const [workGuideOpen, setWorkGuideOpen] = createSignal(false);
	const [backlinksOpen, setBacklinksOpen] = createSignal(true);
	const [linksTab, setLinksTab] = createSignal<"backlinks" | "outgoing" | "unlinked">("backlinks");
	const [linksForcedVisible, setLinksForcedVisible] = createSignal(false);
	const [linksRefresh, setLinksRefresh] = createSignal(0);
	const [hoverCard, setHoverCard] = createSignal<HoverCardState | null>(null);
	const [tableHud, setTableHud] = createSignal<ActiveTableHud | null>(null);
	const [lightbox, setLightbox] = createSignal<(ImageLightboxInfo & { zoomFull?: boolean }) | null>(null);
	const [mermaidBox, setMermaidBox] = createSignal<(MermaidLightboxInfo & { scale: number; x: number; y: number }) | null>(null);
	let mermaidPan: { startX: number; startY: number; origX: number; origY: number } | null = null;
	const [activeHeadingId, setActiveHeadingId] = createSignal("");

	let hostEl!: HTMLDivElement;
	let pageEl!: HTMLDivElement;
	let cmMountEl!: HTMLDivElement;
	let linksSectionEl: HTMLElement | undefined;
	let yamlInputEl: HTMLTextAreaElement | undefined;
	let yamlCompleter: TextareaCompleter | undefined;
	let yamlEditBtnEl: HTMLButtonElement | undefined;
	let hoverBodyEl: HTMLDivElement | undefined;
	let cmView: EditorView | undefined;
	const modeCompartment = new Compartment();
	let syncingFromCm = false;
	let syncingFromModel = false;
	let refreshSeq = 0;
	let lastTopLine = 1;
	let scrollSyncRaf = 0;
	let suppressSplitSyncUntil = 0;

	const modeExtensions = (read: boolean): Extension => [
		readOnlyModeFacet.of(read),
		EditorState.readOnly.of(read),
		EditorView.editable.of(!read),
		...(read
			? [
					EditorState.transactionFilter.of((tr) => {
						if (!tr.docChanged) return tr;
						if (tr.annotation(externalSyncAnnotation)) return tr;
						return [];
					}),
				]
			: []),
	];

	// --- Frontmatter Properties, Ticket Work & Backlinks ---------------------
	const front = createMemo(() => frontMatter(text()));
	const yamlSpan = createMemo(() => frontMatterInnerSpan(text()));
	const facts = createMemo(() =>
		Object.entries(front().values)
			.filter(([key, value]) => key !== "title" && (Array.isArray(value) ? value.length : value))
			.map(([key, value]) => ({ key, values: Array.isArray(value) ? value : [value] })),
	);

	const resizeYamlInput = (el: HTMLTextAreaElement | undefined) => {
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.max(44, el.scrollHeight)}px`;
	};

	// Keep the inline raw YAML textarea synced with external model edits (Status dropdown, Ctrl+Z, Revert) without jumping caret on typing.
	createEffect(() => {
		const open = editYaml();
		const inner = yamlSpan()?.inner ?? "";
		if (!open) return;
		queueMicrotask(() => {
			if (!yamlInputEl) return;
			if (yamlInputEl.value !== inner) yamlInputEl.value = inner;
			resizeYamlInput(yamlInputEl);
		});
	});

	// Re-measure wrapped YAML textarea height if the editor pane resizes horizontally.
	createEffect(() => {
		if (!editYaml() || typeof ResizeObserver === "undefined") return;
		let ro: ResizeObserver | undefined;
		const frame = requestAnimationFrame(() => {
			if (!yamlInputEl) return;
			resizeYamlInput(yamlInputEl);
			ro = new ResizeObserver(() => resizeYamlInput(yamlInputEl));
			ro.observe(yamlInputEl);
		});
		onCleanup(() => {
			cancelAnimationFrame(frame);
			ro?.disconnect();
		});
	});

	const applyYamlInnerEdit = (nextInner: string) => {
		if (cmView) {
			const cur = cmView.state.doc.toString();
			const span = frontMatterInnerSpan(cur);
			if (!span) return;
			const replacement = formatFrontMatterInnerReplacement(nextInner, "\n");
			if (cur.slice(span.start, span.end) === replacement) return;
			cmView.dispatch({
				changes: { from: span.start, to: span.end, insert: replacement },
				userEvent: "input.yaml",
			});
			return;
		}
		if (!model) return;
		const cur = model.getValue();
		const span = frontMatterInnerSpan(cur);
		if (!span) return;
		const replacement = formatFrontMatterInnerReplacement(nextInner, span.eol);
		if (cur.slice(span.start, span.end) === replacement) return;
		const from = model.getPositionAt(span.start);
		const to = model.getPositionAt(span.end);
		model.pushEditOperations(
			[],
			[{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: replacement }],
			() => null,
		);
	};

	const focusYamlLine = (docLineNum = 2, column = 1) => {
		queueMicrotask(() => {
			if (!yamlInputEl) return;
			yamlInputEl.focus();
			const lines = yamlInputEl.value.split("\n");
			const innerLineIdx = Math.max(0, Math.min(lines.length - 1, docLineNum - 2));
			let offset = 0;
			for (let i = 0; i < innerLineIdx; i++) offset += lines[i]!.length + 1;
			offset += Math.min(lines[innerLineIdx]!.length, Math.max(0, column - 1));
			yamlInputEl.setSelectionRange(offset, offset);
			yamlInputEl.scrollIntoView({ block: "nearest" });
		});
	};
	const ticketFile = (key: string) => {
		const found = docs().find((d) => d.group === "tickets" && d.exists && d.ticket?.toLowerCase() === key.trim().toLowerCase());
		if (found) return found.path;
		if (!state.workspace || !state.project) return "";
		const parts = state.project.docs.split(/[\\/]/).filter((p) => p && p !== ".");
		return joinPath(state.workspace.root, ...parts, DOC_FOLDERS.tickets, `${key.trim()}.md`);
	};
	const targetOf = (key: string, value: string): { file?: string; web?: string; display?: string } => {
		if (/^https?:\/\//i.test(value)) return { web: value };
		const wiki = /^\[\[([^[\]]+)\]\]$/.exec(value.trim());
		if (wiki && state.workspace) {
			const parsed = namedLink(wiki[1]!);
			const found = parsed ? docByName(parsed.name, docs(), state.workspace.root) : null;
			if (found) return { file: found.path, display: parsed?.words || parsed?.name || value };
		}
		if (["ticket", "tickets", "related", "parent", "blocks", "blocked-by"].includes(key)) return { file: ticketFile(value) };
		if (["supersedes", "superseded-by"].includes(key) && state.workspace) {
			const found = docByName(value.trim(), docs(), state.workspace.root);
			if (found) return { file: found.path, display: found.title || value };
		}
		if (["specs", "spec", "plan", "plans", "source"].includes(key) && state.workspace) {
			const clean = value.trim().replace(/\\/g, "/");
			if (!clean) return {};
			const resolved = clean.startsWith("./") || clean.startsWith("../")
				? resolvePath(dirName(props.path), clean)
				: resolvePath(state.workspace.root, clean.replace(/^\/+/, ""));
			return isInside(state.workspace.root, resolved) ? { file: resolved } : {};
		}
		return {};
	};

	const LIST_PROP_KEYS = new Set(["tags", "tickets", "related", "blocks", "blocked-by", "specs", "plans"]);
	const EDITABLE_LINK_KEYS = new Set(["parent", "ticket", "source", "supersedes", "superseded-by"]);

	const applyDocTextUpdate = (nextText: string) => {
		if (cmView) {
			const cur = cmView.state.doc.toString();
			const norm = nextText.replace(/\r\n/g, "\n");
			if (cur === norm) return;
			// Find minimal changed slice so CM6 preserves scroll & non-frontmatter widgets.
			let start = 0;
			while (start < cur.length && start < norm.length && cur[start] === norm[start]) start++;
			let endCur = cur.length;
			let endNorm = norm.length;
			while (endCur > start && endNorm > start && cur[endCur - 1] === norm[endNorm - 1]) {
				endCur--;
				endNorm--;
			}
			cmView.dispatch({ changes: { from: start, to: endCur, insert: norm.slice(start, endNorm) }, userEvent: "input.yaml" });
			return;
		}
		if (!model) return;
		const full = model.getFullModelRange();
		model.pushEditOperations([], [{ range: full, text: nextText }], () => null);
	};

	const pickValueForProperty = async (key: string): Promise<string | null> => {
		const root = state.workspace?.root;
		const all = docs().filter((d) => d.exists && !isCatalog(d));
		const CUSTOM = "Enter custom value…";
		if (key === "status") {
			const choices = statusChoices(listed());
			return await choose("Choose status", [...choices]);
		}
		if (key === "direction") {
			return await choose("Message direction", ["in", "out", "both"]);
		}
		if (key === "type") {
			const picked = await choose("Ticket type", ["Task", "Story", "Bug", "Epic", "Sub-task", CUSTOM]);
			if (!picked) return null;
			return picked === CUSTOM ? (await ask("Custom ticket type:"))?.trim() || null : picked;
		}
		if (key === "date" || key === "asked" || key === "answered") {
			return (await ask(`Value for ${key} (YYYY-MM-DD):`, localDay()))?.trim() || null;
		}
		if (["ticket", "tickets", "parent", "related", "blocks", "blocked-by"].includes(key)) {
			const tks = all.filter((d) => d.group === "tickets" && d.ticket).map((d) => d.ticket!);
			if (tks.length) {
				const picked = await choose(`Choose ticket for ${key}:`, [...tks, CUSTOM]);
				if (!picked) return null;
				if (picked !== CUSTOM) return picked;
			}
			return (await ask(`Value for ${key}:`))?.trim() || null;
		}
		if (key === "supersedes" || key === "superseded-by") {
			const decisions = all.filter((d) => d.group === "knowledge" && d.kind === "decisions" && canonical(d.path) !== props.path);
			if (decisions.length) {
				const stems = decisions.map((d) => baseName(d.path).replace(/\.(md|markdown)$/i, ""));
				const details = Object.fromEntries(decisions.map((d, i) => [stems[i]!, d.title || d.name]));
				const picked = await choose(`Choose decision for ${key}:`, [...stems, CUSTOM], { details });
				if (!picked) return null;
				if (picked !== CUSTOM) return picked;
			}
			return (await ask(`Decision stem for ${key}:`))?.trim() || null;
		}
		if (key === "tags") {
			const existingTags = workspaceTags(all).map((t) => t.tag);
			if (existingTags.length) {
				const picked = await choose("Choose tag (or enter a new one)", [...existingTags, CUSTOM]);
				if (!picked) return null;
				if (picked !== CUSTOM) return picked;
			}
			return (await ask("New tag name (without #)"))?.trim().replace(/^#+/, "") || null;
		}
		if ((key === "specs" || key === "plans") && root) {
			const grp = key === "specs" ? "specs" : "plans";
			const items = all.filter((d) => d.group === grp).map((d) => relativeTo(root, d.path).replace(/\\/g, "/"));
			if (items.length) {
				const picked = await choose(`Choose ${grp === "specs" ? "spec" : "plan"}`, [...items, CUSTOM]);
				if (!picked) return null;
				if (picked !== CUSTOM) return picked;
			}
		}
		if (key === "source") {
			const grp = listed()?.group;
			if (grp === "tickets") {
				return (await ask("Ticket URL (https://…):", one(front().values.source) || "https://"))?.trim() || null;
			}
			if (grp === "schema" && root) {
				const sqls = all
					.filter((d) => d.group === "schema" && /\.(sql|ddl|pks|pkb|json|xml|xsd)$/i.test(d.name))
					.map((d) => relativeTo(root, d.path).replace(/\\/g, "/"));
				if (sqls.length) {
					const picked = await choose("Choose source schema file", [...sqls, CUSTOM]);
					if (!picked) return null;
					if (picked !== CUSTOM) return picked;
				}
			}
			return (await ask("Value for source:", one(front().values.source)))?.trim() || null;
		}
		return (await ask(`Value for ${key}:`))?.trim() || null;
	};

	const isListProperty = (key: string) => LIST_PROP_KEYS.has(key) || Array.isArray(front().values[key]);

	const editScalarPropertyInteractive = async (key: string, currentVal: string) => {
		if (isRead()) return;
		const nextVal =
			key === "status" ||
			key === "parent" ||
			key === "source" ||
			key === "ticket" ||
			key === "supersedes" ||
			key === "superseded-by" ||
			key === "direction" ||
			key === "type"
				? await pickValueForProperty(key)
				: (await ask(`Edit ${key}:`, currentVal))?.trim() || null;
		if (!nextVal || nextVal === currentVal) return;
		const cur = model?.getValue() ?? text();
		const next = withFrontMatter(cur, key, nextVal);
		if (next && next !== cur) applyDocTextUpdate(next);
	};

	const commonKeysForDoc = (): string[] => {
		const doc = listed();
		if (doc?.group === "knowledge" && doc.kind === "decisions") {
			return ["status", "ticket", "tickets", "supersedes", "superseded-by", "date", "summary", "tags", "Custom property…"];
		}
		if (doc?.group === "knowledge" && doc.kind === "questions") {
			return ["status", "ticket", "tickets", "asked", "answered", "summary", "tags", "Custom property…"];
		}
		if (doc?.group === "schema" && doc.kind === "interfaces") {
			return ["status", "with", "direction", "version", "source", "ticket", "summary", "tags", "Custom property…"];
		}
		if (doc?.group === "tickets") {
			return ["status", "type", "summary", "source", "parent", "blocks", "blocked-by", "related", "specs", "plans", "tags", "Custom property…"];
		}
		return ["status", "ticket", "tickets", "parent", "related", "blocks", "blocked-by", "tags", "specs", "plans", "source", "summary", "Custom property…"];
	};

	const addPropertyValueInteractive = async (explicitKey?: string) => {
		if (isRead()) return;
		const COMMON_KEYS = commonKeysForDoc();
		let key = explicitKey;
		if (!key) {
			const picked = await choose("Add or update YAML property", COMMON_KEYS);
			if (!picked) return;
			if (picked === "Custom property…") {
				key = (await ask("Property name (e.g. owner, version, system)"))?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
				if (!key) return;
			} else {
				key = picked;
			}
		}
		const val = await pickValueForProperty(key);
		if (!val) return;
		const cur = model?.getValue() ?? text();
		// Guard against unclosed `---` frontmatter so we don't prepend a duplicate YAML block.
		if (!frontMatterInnerSpan(cur)) {
			if (/^\s*---\s*$/m.test(cur.split(/\r?\n/)[0] ?? "")) {
				notify("Fix the unclosed YAML frontmatter block (missing closing ---) before adding properties.", "error");
				return;
			}
			const eol = cur.includes("\r\n") ? "\r\n" : "\n";
			const safe = quoteYamlScalar(val);
			const lineVal = LIST_PROP_KEYS.has(key) ? `[${safe}]` : safe;
			applyDocTextUpdate(`---${eol}${key}: ${lineVal}${eol}---${eol}${eol}${cur}`);
			return;
		}
		const next = isListProperty(key) ? addToFrontMatterList(cur, key, val) : withFrontMatter(cur, key, val);
		if (next && next !== cur) applyDocTextUpdate(next);
		else if (next === null) notify(`Could not update property "${key}" — click Edit YAML to edit its raw block.`, "error");
	};

	const removePropertyValue = (key: string, value: string, totalValues: number) => {
		if (isRead()) return;
		const cur = model?.getValue() ?? text();
		if (totalValues > 1 || isListProperty(key)) {
			const next = removeFromFrontMatterList(cur, key, value);
			if (next && next !== cur) {
				const cleaned = stripEmptyFrontMatter(next);
				applyDocTextUpdate(cleaned);
				if (!frontMatterInnerSpan(cleaned)) setEditYaml(false);
				return;
			}
		}
		// Remove single scalar key line cleanly from YAML inner block (matching frontMatter()'s last-wins semantics).
		const span = frontMatterInnerSpan(cur);
		if (!span) return;
		const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const lines = span.inner.split(/\r?\n/);
		const idx = lines.findLastIndex((l) => new RegExp(`^${keyEsc}\\s*:`, "i").test(l));
		if (idx < 0) return;
		let endIdx = idx + 1;
		while (endIdx < lines.length && /^[ \t]*-\s+/.test(lines[endIdx]!)) endIdx++;
		lines.splice(idx, endIdx - idx);
		const replacement = formatFrontMatterInnerReplacement(lines.join("\n"), span.eol);
		const nextDoc = stripEmptyFrontMatter(`${cur.slice(0, span.start)}${replacement}${cur.slice(span.end)}`);
		applyDocTextUpdate(nextDoc);
		if (!frontMatterInnerSpan(nextDoc)) setEditYaml(false);
	};
	const go = (target: { file?: string; web?: string }) =>
		target.web ? void window.open(target.web, "_blank", "noopener") : target.file ? void openFile(target.file) : undefined;

	const listed = createMemo(() => docs().find((d) => canonical(d.path) === props.path));
	const ticket = createMemo(() => {
		const file = docs().find((d) => d.group === "tickets" && d.ticket && canonical(d.path) === props.path);
		return file?.ticket ?? "";
	});
	const work = createMemo(() => (ticket() ? ticketWork(docs(), ticket()) : []));
	const readiness = createMemo(() =>
		ticket() ? evaluateTicketReadiness(docs(), ticket(), { gitFiles: gitStatus()?.files, root: state.workspace?.root }) : null,
	);
	const [readinessOpen, setReadinessOpen] = createSignal(false);
	// Reverse Schema -> Code & Registries usages card for documented `schema/` files (Wave 3.1).
	const schemaIdent = createMemo(() => {
		const doc = listed();
		if (!doc || doc.group !== "schema" || isCatalog(doc)) return "";
		return baseName(doc.path).replace(/\.(md|markdown)$/i, "").trim();
	});
	const [schemaUsagesOpen, setSchemaUsagesOpen] = createSignal(false);
	const [schemaUsages] = createResource(
		() => {
			const ident = schemaIdent();
			const root = state.workspace?.root;
			return ident && root ? { ident, root, version: state.treeVersion } : null;
		},
		async ({ ident, root }) => {
			const cleanDir = (dir?: string) => (dir ?? "").replace(/^[./\\]+|[\\/]+$/g, "").replace(/\\/g, "/");
			const dRel = cleanDir(state.project?.docs ?? "docs");
			const pRel = cleanDir(state.project?.plans ?? "design");
			const sRel = cleanDir(state.project?.schema ?? "schema");
			const exclude = [dRel ? `${dRel}/**` : "", pRel ? `${pRel}/**` : "", sRel ? `${sRel}/**` : "", "README.md", "AGENTS.md", "**/INDEX.md"]
				.filter(Boolean)
				.join(", ");
			const hits = await backend.search(ident, { wholeWord: true, exclude }).catch(() => []);
			const byFile = new Map<string, { path: string; rel: string; line: number; count: number }>();
			for (const h of hits) {
				const k = canonical(h.path);
				const prev = byFile.get(k);
				if (!prev) byFile.set(k, { path: h.path, rel: relativeTo(root, h.path).replace(/\\/g, "/"), line: h.line, count: 1 });
				else prev.count++;
			}
			// Also find CSV registry docs whose `codeRefs` mention this table/object (e.g. `database.csv`).
			const regHits = docs()
				.filter(
					(d) =>
						d.exists &&
						d.group === "registries" &&
						!isCatalog(d) &&
						d.codeRefs?.some((ref) => ref.toLowerCase() === ident.toLowerCase() || ref.toLowerCase().endsWith(`.${ident.toLowerCase()}`)),
				)
				.map((d) => ({ path: d.path, rel: registryTitle(d.name), line: 1, count: 0 }));
			return { code: [...byFile.values()], registries: regHits };
		},
	);
	const exportMenuItems = () => [
		{ label: "Copy as rich HTML", run: () => void exportDocAs(props.path, "html-copy") },
		{ label: "Copy as Jira / Confluence markup", run: () => void exportDocAs(props.path, "jira-copy") },
		"separator" as const,
		{ label: "Print / Save as PDF…", run: () => void exportDocAs(props.path, "print") },
		{ label: "Export standalone HTML…", run: () => void exportDocAs(props.path, "html-download") },
		{ label: "Export as Word (.docx)…", run: () => void exportDocAs(props.path, "docx") },
		...(ticket()
			? [
					"separator" as const,
					{ label: `Export ${ticket()} packet (HTML)…`, run: () => void exportTicketPacket(props.path, ticket(), "html") },
					{ label: `Export ${ticket()} packet (Word .docx)…`, run: () => void exportTicketPacket(props.path, ticket(), "docx") },
					{ label: `Export ${ticket()} packet (Markdown)…`, run: () => void exportTicketPacket(props.path, ticket(), "markdown") },
					"separator" as const,
					{ label: `Deployment manifest (Markdown)…`, run: () => void exportDeploymentManifest(props.path, ticket(), "markdown") },
					{ label: `Deployment manifest (CSV)…`, run: () => void exportDeploymentManifest(props.path, ticket(), "csv") },
					{ label: `Deployment manifest (HTML)…`, run: () => void exportDeploymentManifest(props.path, ticket(), "html") },
					{ label: `Deployment manifest (Word .docx)…`, run: () => void exportDeploymentManifest(props.path, ticket(), "docx") },
				]
			: []),
	];
	const workRollup = createMemo(() => {
		const me = listed();
		const groups = work();
		if (!ticket() || !me) return [];
		const allDocs = docs();
		const parts: string[] = [];
		const descendants = descendantTickets(allDocs, ticket());
		const activeSubs = descendants.filter((s) => toneOf(s.status) !== "off");
		if (activeSubs.length) {
			const done = activeSubs.filter((s) => toneOf(s.status) === "done").length;
			parts.push(`${done}/${activeSubs.length} sub-tickets done`);
		}
		const scopeDocs = [me, ...activeSubs];
		const taskTotal = scopeDocs.reduce((sum, d) => sum + (d.tasks?.total ?? 0), 0);
		const taskDone = scopeDocs.reduce((sum, d) => sum + (d.tasks?.done ?? 0), 0);
		if (taskTotal > 0) parts.push(`${taskDone}/${taskTotal} checklist items`);
		const openQs = groups.find((g) => g.kind === "question")?.files.length ?? 0;
		if (openQs > 0) parts.push(`${openQs} open ${openQs === 1 ? "question" : "questions"}`);
		const scopeKeySet = new Set(scopeDocs.map((d) => d.ticket?.toLowerCase()).filter(Boolean) as string[]);
		const regRows = allDocs
			.filter((d) => d.exists && d.group === "registries" && !isCatalog(d) && d.forTickets?.length)
			.reduce(
				(acc, reg) => {
					for (const hit of reg.forTickets ?? []) {
						if (scopeKeySet.has(hit.key.toLowerCase())) {
							acc.total += hit.rows;
							acc.done += hit.done ?? 0;
						}
					}
					return acc;
				},
				{ total: 0, done: 0 },
			);
		if (regRows.total > 0) parts.push(`${regRows.done}/${regRows.total} registry rows done`);
		return parts;
	});
	const linkedTickets = createMemo(() => (!ticket() ? docLinkedTickets(docs(), props.path) : []));

	// Only re-scan workspace backlinks when this path changes or the set of project docs changes
	// (avoids triggering 2× workspace scans per open Markdown tab on every unrelated `.ssl` save).
	const docsFingerprint = createMemo(() => {
		const list = docs();
		return `${list.length}:${list.map((d) => `${d.path}|${d.title ?? ""}|${d.broken?.length ?? 0}`).join("\n")}`;
	});
	const [linked] = createResource(
		() => ({ path: props.path, sig: docsFingerprint(), root: state.workspace?.root, rev: linksRefresh() }),
		async ({ path, root }) => {
			if (!root) return [];
			const files = docs();
			try {
				const [byPath, byName] = await Promise.all([backend.linksTo(path), backend.namesIn()]);
				const hits = linkedFrom(
					canonical(path),
					byPath.map((link) => ({ path: canonical(link.path), line: link.line })),
					byName.map((place) => ({ ...place, path: canonical(place.path) })),
					files.map((file) => ({ ...file, path: canonical(file.path) })),
					root,
				);
				return await Promise.all(
					hits.map(async (item) => {
						const content = await readFileText(item.path);
						return { ...item, snippet: extractLineContextSnippet(content, item.line) };
					}),
				);
			} catch {
				return [];
			}
		},
	);

	// Outgoing links in this document (resolved links, broken links, transclusions, ticket refs, web links).
	const outgoingLinks = createMemo<OutgoingLinkItem[]>(() =>
		extractOutgoingLinks(text(), props.path, docs(), {
			root: state.workspace?.root,
			broken: listed()?.broken,
		}),
	);
	const brokenOutgoingCount = createMemo(() => outgoingLinks().filter((o) => o.broken).length);

	// Unlinked plain-text mentions of this document's title/ticket in other workspace Markdown docs.
	const [unlinkedMentions] = createResource(
		() => {
			const root = state.workspace?.root;
			const me = listed();
			const title = me?.title || one(front().values.title) || "";
			const tKey = ticket();
			const stem = baseName(props.path).replace(/\.(md|markdown)$/i, "");
			const linkedPaths = (linked() ?? []).map((b) => canonical(b.path));
			return root ? { path: props.path, root, title, ticket: tKey, stem, sig: docsFingerprint(), linkedPaths, rev: linksRefresh() } : null;
		},
		async (src) => {
			if (!src) return [] as UnlinkedMentionItem[];
			const terms = mentionTermsForDoc({ title: src.title, ticket: src.ticket, stem: src.stem });
			if (!terms.length) return [] as UnlinkedMentionItem[];
			const linkedSet = new Set(src.linkedPaths.map((p) => canonical(p)));
			const allMd = new Map<string, { path: string; name: string; title?: string }>();
			for (const d of docs()) {
				if (!d.exists || !/\.(md|markdown)$/i.test(d.path)) continue;
				const k = canonical(d.path);
				if (k === canonical(src.path) || linkedSet.has(k)) continue;
				allMd.set(k, { path: d.path, name: d.name, title: d.title });
			}
			if (!allMd.size) return [] as UnlinkedMentionItem[];
			const candidatePaths = new Set<string>();
			for (const term of terms.slice(0, 2)) {
				const hits = await backend.search(term, { wholeWord: true, caseSensitive: false }).catch(() => []);
				for (const h of hits) {
					const k = canonical(h.path);
					if (allMd.has(k)) candidatePaths.add(k);
					if (candidatePaths.size >= 24) break;
				}
				if (candidatePaths.size >= 24) break;
			}
			if (!candidatePaths.size) return [] as UnlinkedMentionItem[];
			const candidates = await Promise.all(
				[...candidatePaths].map(async (k) => {
					const info = allMd.get(k)!;
					return { ...info, text: await readFileText(info.path) };
				}),
			);
			return findUnlinkedMentions(
				{ path: src.path, title: src.title, ticket: src.ticket, stem: src.stem },
				candidates,
				linkedSet,
			);
		},
	);

	const totalLinksCount = createMemo(
		() => (linked()?.length ?? 0) + outgoingLinks().length + (unlinkedMentions()?.length ?? 0),
	);

	const linkifyUnlinkedMention = async (mention: UnlinkedMentionItem) => {
		const root = state.workspace?.root;
		const me = listed();
		const wikiName = (me ? nameFor(me, docs(), root) : null) ?? baseName(props.path).replace(/\.(md|markdown)$/i, "");
		if (!wikiName) return;
		const key = canonical(mention.path);
		const openDoc = documents.get(key);
		const curText = openDoc ? openDoc.model.getValue() : await readFileText(mention.path);
		const next = linkifyMentionInText(curText, mention.line, mention.column, mention.matchedText, wikiName);
		if (!next || next === curText) {
			notify("That mention moved or was already updated.");
			setLinksRefresh((v) => v + 1);
			return;
		}
		try {
			if (openDoc) {
				openDoc.model.pushStackElement();
				openDoc.model.pushEditOperations([], [{ range: openDoc.model.getFullModelRange(), text: next, forceMoveMarkers: true }], () => null);
				openDoc.model.pushStackElement();
				if (!state.dirty[key]) await save(key);
			} else {
				await backend.historyKeep(mention.path).catch(() => {});
				await backend.write(mention.path, next);
			}
			setState("treeVersion", (v) => v + 1);
			setLinksRefresh((v) => v + 1);
			notify(`Linked mention in ${called(key)}.`);
		} catch (err: any) {
			notify(`Could not link mention: ${err?.message ?? err}`, "error");
		}
	};

	const openLinksInspector = () => {
		setLinksForcedVisible(true);
		setBacklinksOpen(true);
		if ((linked()?.length ?? 0) === 0) {
			if (outgoingLinks().length > 0) setLinksTab("outgoing");
			else if ((unlinkedMentions()?.length ?? 0) > 0) setLinksTab("unlinked");
		}
		requestAnimationFrame(() => {
			linksSectionEl?.scrollIntoView({ behavior: "smooth", block: "start" });
		});
	};

	const called = (path: string) => {
		const file = docs().find((d) => canonical(d.path) === path);
		if (!file) return relativeTo(state.workspace?.root, path);
		const title = file.title || file.name;
		return file.ticket && !title.toLowerCase().startsWith(file.ticket.toLowerCase()) ? `${file.ticket}: ${title}` : title;
	};

	// --- Document Outline (published for BOTH Read and Live modes) -----------
	const headings = createMemo(() =>
		documentHeadings(text()).map((h) => ({ id: h.anchor, text: h.text, level: h.level, line: h.line })),
	);

	const scrollToLine = (line: number, focus = false, column = 1, endLine?: number, endColumn?: number) => {
		if (!cmView) return;
		const docObj = cmView.state.doc;
		const ln = Math.max(1, Math.min(line, docObj.lines));
		if (ln <= front().lines && yamlSpan()) {
			if (isRead()) {
				hostEl?.scrollTo({ top: 0, behavior: "smooth" });
				return;
			}
			setEditYaml(true);
			hostEl?.scrollTo({ top: 0, behavior: "smooth" });
			if (focus) focusYamlLine(ln, column);
			return;
		}
		const startLine = docObj.line(ln);
		const from = Math.min(startLine.to, startLine.from + Math.max(0, column - 1));
		let to = from;
		if (endLine !== undefined) {
			const eln = Math.max(1, Math.min(endLine, docObj.lines));
			const endLineObj = docObj.line(eln);
			to = Math.min(endLineObj.to, endLineObj.from + Math.max(0, (endColumn ?? 1) - 1));
		}
		if (isRead()) {
			const block = cmView.lineBlockAt(startLine.from);
			if (hostEl && cmMountEl) {
				const mountTop = cmMountEl.offsetTop;
				hostEl.scrollTo({ top: Math.max(0, mountTop + block.top - 18), behavior: "smooth" });
			}
			return;
		}
		cmView.dispatch({
			selection: EditorSelection.range(from, to),
			effects: EditorView.scrollIntoView(from, { y: "center" }),
		});
		if (focus) {
			cmView.focus();
			requestAnimationFrame(() => {
				if (cmView) focusLiveWidgetAt(cmView, from);
			});
		}
	};

	const jumpToLine = (line: number, column = 1, endLine?: number, endColumn?: number) => scrollToLine(line, !isRead(), column, endLine, endColumn);

	const goToHeading = (id: string) => {
		const hit = headings().find((h) => h.id === id);
		if (!hit) return;
		setActiveHeadingId(hit.id);
		scrollToLine(hit.line, !isRead());
	};

	const updateOutlineScrollspy = () => {
		if (!hostEl || !cmView) return;
		const list = headings();
		if (!list.length) return setActiveHeadingId("");
		// Use CM6's layout geometry (`lineBlockAt`) rather than querying virtualized DOM nodes,
		// so long sections whose heading scrolled out of the DOM viewport stay accurately highlighted.
		const hostRect = hostEl.getBoundingClientRect();
		const cmTopInHost = cmView.contentDOM.getBoundingClientRect().top - hostRect.top;
		const threshold = 40;
		let currentId = list[0]!.id;
		const lineCount = cmView.state.doc.lines;
		for (const h of list) {
			if (h.line < 1 || h.line > lineCount) continue;
			const block = cmView.lineBlockAt(cmView.state.doc.line(h.line).from);
			if (cmTopInHost + block.top > threshold) break;
			currentId = h.id;
		}
		setActiveHeadingId(currentId);
	};

	createEffect(() => {
		const active = state.groups[state.activeGroup]?.active;
		if (active !== props.path) return;
		const list = headings();
		setMdOutline({
			path: props.path,
			headings: list,
			activeId: activeHeadingId() || (list[0]?.id ?? ""),
			goTo: goToHeading,
		});
	});
	onCleanup(() => {
		if (mdOutline()?.path === props.path) setMdOutline(null);
	});

	// --- Unified Pointer-Y Reading Assist (smooth across empty margins/gaps in BOTH Live & Read) ---
	let pointerY: number | null = null;
	let assistFrame = 0;
	let dimmed = new Set<HTMLElement>();

	const clearReadAssist = () => {
		if (assistFrame) {
			cancelAnimationFrame(assistFrame);
			assistFrame = 0;
		}
		for (const el of dimmed) el.classList.remove("cm-md-read-below");
		dimmed.clear();
	};

	const applyReadAssist = () => {
		assistFrame = 0;
		if (pointerY === null || !cmMountEl || lightbox()) return clearReadAssist();
		const content = cmMountEl.querySelector<HTMLElement>(".cm-content");
		if (!content) return clearReadAssist();
		const contentRect = content.getBoundingClientRect();
		// When hovering Properties, "The work for", or empty top header above the body, keep the body bright.
		if (pointerY < contentRect.top - 6) return clearReadAssist();

		const units: HTMLElement[] = [];
		for (const child of content.children) {
			if (!(child instanceof HTMLElement)) continue;
			if (child.classList.contains("cm-md-fm-hidden")) continue;
			if (child.getBoundingClientRect().height === 0) continue;
			units.push(child);
		}
		const backlinksEl = pageEl?.querySelector<HTMLElement>(".cm-md-backlinks");
		if (backlinksEl && backlinksEl.getBoundingClientRect().height > 0) units.push(backlinksEl);
		if (!units.length) return clearReadAssist();

		let active = -1;
		for (let i = 0; i < units.length; i++) {
			const r = units[i]!.getBoundingClientRect();
			if (r.top <= pointerY) active = i;
			else break;
		}
		if (active < 0) active = 0;

		const nextDimmed = new Set<HTMLElement>();
		for (let i = active + 1; i < units.length; i++) nextDimmed.add(units[i]!);
		for (const el of dimmed) if (!nextDimmed.has(el)) el.classList.remove("cm-md-read-below");
		for (const el of nextDimmed) if (!dimmed.has(el)) el.classList.add("cm-md-read-below");
		dimmed = nextDimmed;
	};

	const scheduleReadAssist = () => {
		if (!assistFrame) assistFrame = requestAnimationFrame(applyReadAssist);
	};
	onCleanup(clearReadAssist);

	// --- Raw Table Toolbar HUD (shown ONLY when explicitly editing a table in `Raw` pipe mode;
	//     interactive Live Table Grid uses its own zero-jump bottom `.cm-tbl-bar` inside the table card) ---
	const updateTableHud = (view?: EditorView) => {
		const v = view ?? cmView;
		if (!v || isRead()) {
			setTableHud(null);
			return;
		}
		if (!v.state.field(rawEditBlockField, false)) {
			setTableHud(null);
			return;
		}
		const ctx = activeTableAtCursor(v);
		if (!ctx) {
			setTableHud(null);
			return;
		}
		const { table, row, col } = ctx;
		setTableHud({
			row,
			col,
			rowCount: table.rows.length,
			colCount: table.alignments.length,
			align: table.alignments[col] ?? "none",
			canDeleteRow: row > 0 && table.rows.length > 1,
			canMoveRowUp: row > 1,
			canMoveRowDown: row > 0 && row < table.rows.length - 1,
			canDeleteCol: table.alignments.length > 1,
			canMoveColLeft: col > 0,
			canMoveColRight: col < table.alignments.length - 1,
		});
	};

	const runTableToolbarAction = (actionId: string) => {
		if (!cmView || isRead()) return;
		runTableAction(cmView, actionId);
		cmView.focus();
		queueMicrotask(() => updateTableHud(cmView));
	};

	// --- Navigation, Link Following, Checkbox Toggling & Note Creation -------
	const followHeadingInFile = async (targetPath: string, heading: string) => {
		const content = await readFileText(targetPath);
		const line = findHeadingLine(content, heading);
		if (canonical(targetPath) === props.path && line) {
			jumpToLine(line);
			return;
		}
		await openFile(targetPath, line ? { reveal: { line } } : {});
	};

	const followLink = async (href: string) => {
		const leads = linkLeads(href, props.path, state.workspace?.root);
		if (!leads) return;
		if ("web" in leads) return void window.open(leads.web, "_blank", "noopener");
		if ("heading" in leads) {
			const line = findHeadingLine(cmView?.state.doc.toString() ?? text(), leads.heading);
			if (line) jumpToLine(line);
			return;
		}
		if (!leads.lines && href.includes("#")) {
			const hash = decodeURIComponent(href.slice(href.indexOf("#") + 1));
			if (hash) return void followHeadingInFile(leads.file, hash);
		}
		await openFile(leads.file, leads.lines ? { reveal: leads.lines } : {});
	};

	const followWiki = async (innerRaw: string) => {
		const bar = innerRaw.indexOf("|");
		const targetPart = (bar < 0 ? innerRaw : innerRaw.slice(0, bar)).trim();
		if (targetPart.startsWith("#")) {
			const heading = targetPart.slice(1).trim();
			const line = findHeadingLine(cmView?.state.doc.toString() ?? text(), heading);
			if (line) jumpToLine(line);
			return;
		}
		const parsed = namedLink(innerRaw.replace(/\\\|/g, "|"));
		if (!parsed) return;
		const root = state.workspace?.root;
		const found = docByName(parsed.name, docs(), root);
		if (found) {
			if (parsed.heading) return void followHeadingInFile(found.path, parsed.heading);
			await openFile(found.path);
			return;
		}
		// Unresolved wikilink: offer to create the note right away (Obsidian workflow).
		if (!root) return;
		const safeName = parsed.name.replace(/[\\/:*?"<>|]+/g, "-").trim();
		if (!safeName) return;
		const fileName = /\.md$/i.test(safeName) ? safeName : `${safeName}.md`;
		const dest = joinPath(dirName(props.path), fileName);
		if (!isInside(root, dest)) return;
		const picked = await choose(`No note named “${parsed.name}” exists yet. Create ${relativeTo(root, dest)}?`, ["Create note"]);
		if (picked !== "Create note") return;
		try {
			await backend.create(dest, "file");
			await backend.write(dest, `# ${parsed.name.replace(/\.md$/i, "")}\n\n`);
			setState("treeVersion", (v) => v + 1);
			await openFile(dest);
		} catch (e: any) {
			notify(`Could not create note: ${e?.message ?? e}`, "error");
		}
	};

	const followTicket = (key: string) => {
		const found = docs().find((d) => d.group === "tickets" && d.exists && d.ticket?.toLowerCase() === key.toLowerCase());
		if (found) void openFile(found.path);
	};

	/** Toggles a `[ ]` / `[x]` checkbox at document offset `bracketPos`, working in BOTH Live and Read modes. */
	const toggleCheckboxAt = (bracketPos: number) => {
		if (!cmView) return;
		if (bracketPos + 2 > cmView.state.doc.length) return;
		const ch = cmView.state.sliceDoc(bracketPos + 1, bracketPos + 2);
		const next = ch === " " ? "x" : " ";
		if (!isRead()) {
			cmView.dispatch({
				changes: { from: bracketPos + 1, to: bracketPos + 2, insert: next },
				userEvent: "input.checkbox",
			});
			return;
		}
		if (!model) return;
		const clean = !state.dirty[props.path];
		const ln = cmView.state.doc.lineAt(bracketPos + 1);
		const col = bracketPos + 1 - ln.from + 1;
		model.pushStackElement();
		model.pushEditOperations(
			[],
			[
				{
					range: new monaco.Range(ln.number, col, ln.number, col + 1),
					text: next,
					forceMoveMarkers: true,
				},
			],
			() => null,
		);
		model.pushStackElement();
		if (clean) void save(props.path).then(() => setState("treeVersion", (v) => v + 1));
	};

	const resizeImageAt = (from: number, to: number, width: number | null) => {
		if (!cmView || isRead()) return;
		if (from < 0 || to > cmView.state.doc.length || from >= to) return;
		const raw = cmView.state.sliceDoc(from, to);
		const next = withImageWidth(raw, width);
		if (next === raw) return;
		cmView.dispatch({
			changes: { from, to, insert: next },
			userEvent: "input.image",
		});
	};

	// --- Obsidian Hover Page Preview (Prose + Properties + Work + Backlinks) -
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let cardHovered = false;

	const cancelHover = () => {
		clearTimeout(hoverTimer);
		clearTimeout(hideTimer);
	};

	const scheduleHideHover = () => {
		clearTimeout(hoverTimer);
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			if (!cardHovered) setHoverCard(null);
		}, 180);
	};

	const resolveHoverPath = (target: HoverTarget): { path: string; heading?: string; line?: number; ticket?: string } | null => {
		const root = state.workspace?.root;
		if (target.kind === "file") {
			return { path: target.path, line: target.line, ticket: target.ticket };
		}
		if (target.kind === "ticket") {
			const found = docs().find((d) => d.group === "tickets" && d.exists && d.ticket?.toLowerCase() === target.key.toLowerCase());
			return found ? { path: found.path } : null;
		}
		if (target.kind === "wiki") {
			const bar = target.inner.indexOf("|");
			const part = (bar < 0 ? target.inner : target.inner.slice(0, bar)).trim();
			if (part.startsWith("#")) return { path: props.path, heading: part.slice(1).trim() };
			const parsed = namedLink(target.inner.replace(/\\\|/g, "|"));
			if (!parsed) return null;
			const found = docByName(parsed.name, docs(), root);
			return found ? { path: found.path, heading: parsed.heading } : null;
		}
		const leads = linkLeads(target.href, props.path, root);
		if (!leads || "web" in leads) return null;
		if ("heading" in leads) return { path: props.path, heading: leads.heading };
		const hashIdx = target.href.indexOf("#");
		const heading = !leads.lines && hashIdx >= 0 ? decodeURIComponent(target.href.slice(hashIdx + 1)).trim() || undefined : undefined;
		return { path: leads.file, line: leads.lines?.line, heading };
	};

	const handleHoverLink = (target: HoverTarget) => {
		clearTimeout(hideTimer);
		clearTimeout(hoverTimer);
		const rect = target.anchor.getBoundingClientRect();
		hoverTimer = setTimeout(async () => {
			const resolved = resolveHoverPath(target);
			if (!resolved) return;
			const preview = await buildHoverPreview(resolved.path, {
				heading: resolved.heading,
				line: resolved.line,
				ticket: resolved.ticket,
			});
			if (!preview) return;
			const cardWidth = Math.min(460, window.innerWidth - 32);
			const x = Math.max(16, Math.min(rect.left, window.innerWidth - cardWidth - 16));
			const preferBelow = rect.bottom + 10;
			const y = preferBelow + 260 < window.innerHeight ? preferBelow : Math.max(16, rect.top - 280);
			setHoverCard({ ...preview, x, y });
			queueMicrotask(() => {
				if (hoverBodyEl) {
					hydrateImagesInElement(hoverBodyEl, resolved.path);
					hydrateMathInElement(hoverBodyEl);
					void colourCode(hoverBodyEl);
				}
			});
		}, 320);
	};

	const hoverFileButton = (path: string | undefined, anchor: HTMLElement, extra: { line?: number; ticket?: string } = {}) => {
		if (!path) return;
		handleHoverLink({ kind: "file", path, line: extra.line, ticket: extra.ticket, anchor });
	};

	const formatCodeBlockAt = async (lineNumber: number): Promise<"changed" | "unchanged" | "error"> => {
		if (!cmView || isRead()) return "error";
		const docText = cmView.state.doc.toString();
		const fence = fenceAtLine(docText, lineNumber);
		if (!fence || fence.bodyStartLine > fence.bodyEndLine) return "unchanged";
		const res = await formatCodeFence(fence, props.path, "\n");
		if (!res.ok) {
			notify(`Could not format ${fence.rawLang || "code"} block: ${res.error}`, "error");
			return "error";
		}
		if (!res.changed) return "unchanged";
		if (!cmView || cmView.state.doc.toString() !== docText) return "unchanged";
		const from = cmView.state.doc.line(fence.bodyStartLine).from;
		const to = cmView.state.doc.line(fence.bodyEndLine).to;
		cmView.dispatch({
			changes: { from, to, insert: res.body },
			userEvent: "input.format",
		});
		return "changed";
	};

	// --- Right-Click Context Menu (tailored for Live vs Read) ----------------
	const onContextMenu = async (e: MouseEvent) => {
		const target = e.target instanceof Element ? e.target : null;
		if (target?.closest("input, textarea, .menu-pop")) return;
		e.preventDefault();
		if (!cmView) return;

		const linkEl = target?.closest<HTMLElement>("[data-md-href], [data-md-wiki], [data-md-ticket], .cm-md-table-wrap a[href], .cm-md-callout a[href]") ?? null;
		const inFolder = Boolean(state.workspace && isInside(state.workspace.root, props.path));
		const box = hostEl.getBoundingClientRect();
		const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + 24, y: box.top + 24 };

		if (isRead()) {
			const selection = window.getSelection();
			const words = selection && !selection.isCollapsed && hostEl.contains(selection.anchorNode) ? selection.toString() : "";
			const COPY = "Copy";
			const OPEN = "Open link";
			const COPY_LINK = "Copy link";
			const EDIT = "Edit in Live view";
			const TO_SOURCE = "Switch to Source view";
			const PATH = "Copy path";
			const RELATIVE = "Copy path in the project";
			const NAME = "Copy file name";
			const SHOW = "Show in the Explorer";
			const items: RowMenuEntry[] = [
				...(words.trim() ? [{ label: COPY, value: COPY, keys: "Ctrl+C" }] : []),
				...(linkEl ? [OPEN, COPY_LINK] : []),
				"separator",
				{ label: EDIT, value: EDIT, keys: "Ctrl+E" },
				TO_SOURCE,
				"separator",
				...submenuOrInline("Copy path", [PATH, ...(inFolder ? [RELATIVE] : []), NAME]),
				...(inFolder ? [SHOW] : []),
			];
			const picked = await chooseFromMenu(`Actions for ${baseName(props.path)}`, items, at);
			if (!picked) return;
			const { copyPath, copyText } = await import("../commands");
			if (picked === COPY) await copyText(words, "Copied the selected text.");
			else if (picked === OPEN && linkEl) {
				if (linkEl.dataset.mdWiki) void followWiki(linkEl.dataset.mdWiki);
				else if (linkEl.dataset.mdHref) void followLink(linkEl.dataset.mdHref);
				else if (linkEl.dataset.mdTicket) followTicket(linkEl.dataset.mdTicket);
				else if (linkEl.getAttribute("href")) void followLink(linkEl.getAttribute("href")!);
			} else if (picked === COPY_LINK && linkEl) {
				const raw = linkEl.dataset.mdHref ?? linkEl.getAttribute("href") ?? linkEl.dataset.mdWiki ?? linkEl.dataset.mdTicket ?? "";
				await copyText(raw, "Copied the link.");
			} else if (picked === EDIT) {
				setMarkdownMode(props.path, "live", props.group);
				setState("activeGroup", props.group);
				queueMicrotask(() => cmView?.focus());
			} else if (picked === TO_SOURCE) {
				saveSyncAnchor();
				setMarkdownMode(props.path, "source", props.group);
			} else if (picked === SHOW) (await import("../panels/Explorer")).showInExplorer(props.path);
			else await copyPath(picked === PATH ? "whole" : picked === NAME ? "name" : "relative", props.path);
			return;
		}

		const main = cmView.state.selection.main;
		const hasSelection = !main.empty;
		const clickPos = e.clientX || e.clientY ? cmView.posAtCoords({ x: e.clientX, y: e.clientY }) : null;
		const clickLine = cmView.state.doc.lineAt(clickPos ?? main.head).number;
		const clickedFence = fenceAtLine(cmView.state.doc.toString(), clickLine);
		const canFormatFence = Boolean(clickedFence && fenceFormatTarget(clickedFence.rawLang) && clickedFence.bodyStartLine <= clickedFence.bodyEndLine);
		const cursorLink = linkAtOffset(cmView.state, clickPos ?? main.head);
		const clickedHref = linkEl?.dataset.mdHref ?? linkEl?.getAttribute("href") ?? (cursorLink?.kind === "href" ? cursorLink.href : undefined);
		const brokenHit = clickedHref
			? listed()?.broken?.find((b) => b.href === clickedHref && b.line === clickLine) ??
				listed()?.broken?.find((b) => b.href === clickedHref)
			: undefined;
		const brokenLeads = brokenHit ? linkLeads(brokenHit.href, props.path, state.workspace?.root) : null;
		const missingTargetPath =
			brokenLeads && "file" in brokenLeads && state.workspace?.root && isInside(state.workspace.root, brokenLeads.file)
				? brokenLeads.file
				: null;

		const OPEN_LINK = "Open link";
		const FIX_BROKEN = brokenHit?.instead ? `Fix broken link to ${brokenHit.instead}` : "";
		const CREATE_MISSING = missingTargetPath ? `Create missing file ${relativeTo(state.workspace?.root, missingTargetPath).replace(/\\/g, "/")}` : "";
		const ADD_PROPS = "YAML properties…";
		const FORMAT_BLOCK = clickedFence?.rawLang ? `Format ${clickedFence.rawLang} code block` : "Format code block";
		const FORMAT_DOC = "Format document";
		const CUT = "Cut";
		const COPY = "Copy";
		const PASTE = "Paste";
		const PASTE_PLAIN = "Paste as plain text";
		const SELECT_ALL = "Select all";
		const INSERT_TEMPLATE = "Template…";
		const INSERT_CALLOUT = "Callout…";
		const INSERT_TABLE = "Table";
		const INSERT_IMAGE = "Image…";
		const BOLD = "Bold";
		const ITALIC = "Italic";
		const CODE = "Inline code";
		const STRIKE = "Strikethrough";
		const HIGHLIGHT = "Highlight";
		const LINK = "Insert link";
		const CHECKBOX = "Toggle checkbox";
		const ASK_AGENT = "Ask the Agent About This…";
		const TO_READ = "Switch to Read view";
		const TO_SOURCE = "Switch to Source view";
		const PATH = "Copy path";
		const RELATIVE = "Copy path in the project";
		const NAME = "Copy file name";
		const SHOW = "Show in the Explorer";

		const contextual: RowMenuEntry[] = [
			...(FIX_BROKEN ? [FIX_BROKEN] : []),
			...(CREATE_MISSING ? [CREATE_MISSING] : []),
			...(linkEl || cursorLink ? [OPEN_LINK] : []),
			...(canFormatFence ? [FORMAT_BLOCK] : []),
		];

		const items: RowMenuEntry[] = [
			...contextual,
			"separator",
			...(hasSelection
				? [
						{ label: CUT, value: CUT, keys: "Ctrl+X" },
						{ label: COPY, value: COPY, keys: "Ctrl+C" },
					]
				: []),
			{ label: PASTE, value: PASTE, keys: "Ctrl+V" },
			{ label: PASTE_PLAIN, value: PASTE_PLAIN, keys: "Ctrl+Shift+V" },
			{ label: SELECT_ALL, value: SELECT_ALL, keys: "Ctrl+A" },
			"separator",
			{
				label: "Format",
				children: [
					{ label: BOLD, value: BOLD, keys: "Ctrl+B" },
					{ label: ITALIC, value: ITALIC, keys: "Ctrl+I" },
					{ label: CODE, value: CODE, keys: "Ctrl+`" },
					{ label: STRIKE, value: STRIKE, keys: "Ctrl+Shift+X" },
					{ label: HIGHLIGHT, value: HIGHLIGHT, keys: "Ctrl+Alt+H" },
					"separator",
					{ label: LINK, value: LINK, keys: "Ctrl+K" },
					{ label: CHECKBOX, value: CHECKBOX, keys: "Ctrl+L" },
				],
			},
			{
				label: "Insert",
				children: [
					INSERT_TEMPLATE,
					INSERT_CALLOUT,
					INSERT_TABLE,
					INSERT_IMAGE,
					...(!yamlSpan() ? (["separator", ADD_PROPS] as RowMenuEntry[]) : []),
				],
			},
			{ label: FORMAT_DOC, value: FORMAT_DOC, keys: "Ctrl+Shift+I" },
			"separator",
			ASK_AGENT,
			"separator",
			{
				label: "View",
				children: [
					{ label: TO_READ, value: TO_READ, keys: "Ctrl+E" },
					TO_SOURCE,
				],
			},
			...submenuOrInline("Copy path", [PATH, ...(inFolder ? [RELATIVE] : []), NAME]),
			...(inFolder ? [SHOW] : []),
		];

		const picked = await chooseFromMenu(`Actions for ${baseName(props.path)}`, items, at);
		if (!picked || !cmView) return;

		if (picked === FIX_BROKEN && brokenHit?.instead) {
			const cur = cmView.state.doc.toString();
			const fixed = withLinkFile(cur, brokenHit.line || clickLine, brokenHit.href, brokenHit.instead, brokenHit.column);
			if (fixed !== null && fixed !== cur) {
				cmView.dispatch({ changes: { from: 0, to: cur.length, insert: fixed }, userEvent: "input.fix" });
				notify(`Fixed broken link to ${brokenHit.instead}.`);
			}
		} else if (picked === CREATE_MISSING && missingTargetPath) {
			try {
				await backend.create(missingTargetPath, "file");
				if (/\.(md|markdown)$/i.test(missingTargetPath)) {
					const titleStem = baseName(missingTargetPath).replace(/\.(md|markdown)$/i, "");
					await backend.write(missingTargetPath, `# ${titleStem}\n\n`);
				}
				setState("treeVersion", (v) => v + 1);
				await openFile(missingTargetPath);
			} catch (err: any) {
				notify(`Could not create file: ${err?.message ?? err}`, "error");
			}
		} else if (picked === OPEN_LINK) {
			if (linkEl?.dataset.mdWiki) void followWiki(linkEl.dataset.mdWiki);
			else if (linkEl?.dataset.mdHref) void followLink(linkEl.dataset.mdHref);
			else if (linkEl?.dataset.mdTicket) followTicket(linkEl.dataset.mdTicket);
			else if (linkEl?.getAttribute("href")) void followLink(linkEl.getAttribute("href")!);
			else if (cursorLink?.kind === "wiki") void followWiki(cursorLink.inner);
			else if (cursorLink?.kind === "href") void followLink(cursorLink.href);
			else if (cursorLink?.kind === "ticket") followTicket(cursorLink.key);
		} else if (picked === ADD_PROPS) {
			const eol = model?.getEOL() ?? "\n";
			const stem = baseName(props.path).replace(/\.(md|markdown)$/i, "");
			const starter = `---${eol}title: ${quoteYamlScalar(stem)}${eol}---${eol}${eol}`;
			if (model) {
				model.pushStackElement();
				model.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: starter, forceMoveMarkers: true }], () => null);
				model.pushStackElement();
				setPropsOpen(true);
				setEditYaml(true);
				focusYamlLine(2, 1);
			}
		} else if (picked === FORMAT_BLOCK && clickedFence) {
			void formatCodeBlockAt(clickedFence.openLine).then((out) => {
				if (out === "unchanged") notify("Code block is already formatted.");
			});
		} else if (picked === FORMAT_DOC) void import("../commands").then((m) => m.runCommand("format"));
		else if (picked === CUT) runCmAction(cmView, "editor.action.clipboardCutAction");
		else if (picked === COPY) runCmAction(cmView, "editor.action.clipboardCopyAction");
		else if (picked === PASTE) runCmAction(cmView, "editor.action.clipboardPasteAction");
		else if (picked === PASTE_PLAIN) runCmAction(cmView, "md-paste-plain");
		else if (picked === SELECT_ALL) runCmAction(cmView, "editor.action.selectAll");
		else if (picked === INSERT_TEMPLATE) void insertMarkdownTemplate();
		else if (picked === INSERT_CALLOUT) void insertCalloutInteractive();
		else if (picked === INSERT_TABLE) runCmAction(cmView, "md-table-insert");
		else if (picked === INSERT_IMAGE) void insertImageInteractive();
		else if (picked === BOLD) runCmAction(cmView, "md-bold");
		else if (picked === ITALIC) runCmAction(cmView, "md-italic");
		else if (picked === CODE) runCmAction(cmView, "md-code");
		else if (picked === STRIKE) runCmAction(cmView, "md-strike");
		else if (picked === HIGHLIGHT) runCmAction(cmView, "md-highlight");
		else if (picked === LINK) runCmAction(cmView, "md-link");
		else if (picked === CHECKBOX) runCmAction(cmView, "md-checkbox");
		else if (picked === ASK_AGENT) void import("../commands").then((m) => m.runCommand("agent-ask"));
		else if (picked === TO_READ) setMarkdownMode(props.path, "read", props.group);
		else if (picked === TO_SOURCE) {
			saveSyncAnchor();
			setMarkdownMode(props.path, "source", props.group);
		}
		else if (picked === PATH || picked === RELATIVE || picked === NAME) {
			await (await import("../commands")).copyPath(picked === PATH ? "whole" : picked === NAME ? "name" : "relative", props.path);
		} else if (picked === SHOW) void import("../panels/Explorer").then((m) => m.showInExplorer(props.path));
	};

	// --- Sync CM6 Transaction -> Monaco ITextModel (CRLF-safe, typing-coalesced undo) ---
	let lastSyncKind = "";
	let lastSyncAt = 0;
	const pushTransactionToModel = (tr: Transaction) => {
		if (!model || !tr.docChanged || syncingFromModel) return;
		const startDoc = tr.startState.doc;
		const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			const sLine = startDoc.lineAt(fromA);
			const eLine = startDoc.lineAt(toA);
			edits.push({
				range: new monaco.Range(sLine.number, fromA - sLine.from + 1, eLine.number, toA - eLine.from + 1),
				text: inserted.toString(),
				forceMoveMarkers: true,
			});
		});
		if (!edits.length) return;
		const now = Date.now();
		const kind = tr.isUserEvent("input.type") ? "type" : tr.isUserEvent("delete.backward") ? "del" : "other";
		const coalesce = (kind === "type" || kind === "del") && kind === lastSyncKind && now - lastSyncAt < 450;
		lastSyncKind = kind;
		lastSyncAt = now;
		syncingFromCm = true;
		try {
			if (!coalesce) model.pushStackElement();
			model.pushEditOperations([], edits, () => null);
			if (kind === "other") model.pushStackElement();
			setText(model.getValue());
		} finally {
			syncingFromCm = false;
		}
	};

	const syncCursorState = (view: EditorView, userMoved: boolean) => {
		if (isRead()) return;
		const head = view.state.selection.main.head;
		const line = view.state.doc.lineAt(head);
		const lineNumber = line.number;
		const column = head - line.from + 1;
		if (state.activeGroup === props.group) {
			setState("cursor", { line: lineNumber, column });
			if (userMoved) noteCursor({ path: props.path, line: lineNumber, column });
		}
	};

	const currentTopLine = (view: EditorView): number => {
		if (!hostEl) return Math.max(1, lastTopLine);
		const hostRect = hostEl.getBoundingClientRect();
		const contentRect = view.contentDOM.getBoundingClientRect();
		if (hostRect.height === 0 && contentRect.height === 0) {
			return Math.max(1, Math.min(lastTopLine, view.state.doc.lines));
		}
		const relY = Math.max(0, hostRect.top - contentRect.top + 4);
		const block = view.lineBlockAtHeight(relY);
		const lineNum = view.state.doc.lineAt(block.from).number;
		lastTopLine = lineNum;
		return lineNum;
	};

	const saveSyncAnchor = () => {
		if (!cmView) return;
		const topLine = currentTopLine(cmView);
		if (isRead()) {
			saveMarkdownSyncAnchor(props.group, props.path, { line: topLine, column: 1, topLine });
			return;
		}
		const head = cmView.state.selection.main.head;
		const ln = cmView.state.doc.lineAt(head);
		saveMarkdownSyncAnchor(props.group, props.path, {
			line: ln.number,
			column: head - ln.from + 1,
			topLine,
		});
	};

	const saveView = () => {
		if (!cmView) return;
		const main = cmView.state.selection.main;
		const folds: [number, number][] = [];
		foldedRanges(cmView.state).between(0, cmView.state.doc.length, (from, to) => {
			folds.push([from, to]);
		});
		savedLiveViews.set(`${props.group}:${props.path}`, {
			anchor: main.anchor,
			head: main.head,
			scrollTop: hostEl?.scrollTop ?? 0,
			folds,
		});
	};

	const applyReveal = () => {
		const r = takeReveal(props.path);
		if (!r) return;
		jumpToLine(r.line, r.column ?? 1, r.endLine, r.endColumn);
	};

	const toggleEditYaml = () => {
		if (isRead() || !yamlSpan()) return;
		const next = !editYaml();
		if (!next) {
			yamlCompleter?.dispose();
			yamlCompleter = undefined;
		}
		setEditYaml(next);
		if (next) {
			focusYamlLine(2, 1);
		} else {
			yamlEditBtnEl?.focus();
		}
	};

	const makeHandle = (view: EditorView): LiveEditorHandle => ({
		path: props.path,
		focus: () => view.focus(),
		hasFocus: () => view.hasFocus,
		getPosition: () => {
			const headPos = view.state.selection.main.head;
			const ln = view.state.doc.lineAt(headPos);
			return { lineNumber: ln.number, column: headPos - ln.from + 1 };
		},
		getSelection: () => {
			const r = view.state.selection.main;
			const s = view.state.doc.lineAt(r.from);
			const e = view.state.doc.lineAt(r.to);
			return {
				startLineNumber: s.number,
				startColumn: r.from - s.from + 1,
				endLineNumber: e.number,
				endColumn: r.to - e.from + 1,
				isEmpty: () => r.empty,
			};
		},
		getSelectedText: () => {
			const r = view.state.selection.main;
			return view.state.sliceDoc(r.from, r.to);
		},
		reveal: (range) => jumpToLine(range.line, range.column ?? 1, range.endLine, range.endColumn),
		runAction: (id) => {
			const active = document.activeElement;
			if (active && view.dom.contains(active)) {
				if (
					active instanceof HTMLTextAreaElement &&
					(active.classList.contains("cm-tbl-cell-input") || active.classList.contains("cm-callout-body-input"))
				) {
					if (applyMarkdownFormatToTextarea(active, id)) return true;
				}
				if (active.classList.contains("cm-callout-title-input") && id.startsWith("md-")) return false;
			}
			const done = runCmAction(view, id);
			queueMicrotask(() => updateTableHud(view));
			return done;
		},
		openLinkAtCursor: () => {
			const found = linkAtOffset(view.state, view.state.selection.main.head);
			if (!found) return false;
			if (found.kind === "wiki") void followWiki(found.inner);
			else if (found.kind === "href") void followLink(found.href);
			else followTicket(found.key);
			return true;
		},
		insertText: (str, cursorOffset, opts) => {
			const r = view.state.selection.main;
			let from = r.from;
			let to = r.to;
			let lead = "";
			let trail = "";
			const body = opts?.asBlock && str.endsWith("\n") ? str.slice(0, -1) : str;
			if (opts?.asBlock && r.empty) {
				const doc = view.state.doc;
				const ln = doc.lineAt(from);
				if (ln.text.trim()) {
					from = ln.to;
					to = ln.to;
					lead = "\n\n";
				} else if (ln.number > 1 && doc.line(ln.number - 1).text.trim()) {
					lead = "\n";
				}
				if (ln.number < doc.lines && doc.line(ln.number + 1).text.trim()) {
					trail = "\n";
				}
			}
			const insert = `${lead}${body}${trail}`;
			const relCursor = cursorOffset !== undefined ? Math.max(0, Math.min(body.length, cursorOffset)) : body.length;
			const pos = from + lead.length + relCursor;
			view.focus();
			view.dispatch({
				changes: { from, to, insert },
				selection: EditorSelection.cursor(pos),
				scrollIntoView: true,
				userEvent: "input",
			});
			if (!focusLiveWidgetAt(view, pos)) {
				requestAnimationFrame(() => focusLiveWidgetAt(view, pos));
			}
			queueMicrotask(() => updateTableHud(view));
		},
		getTopLine: () => currentTopLine(view),
		foldAll: () => {
			cmFoldAll(view);
		},
		unfoldAll: () => {
			cmUnfoldAll(view);
		},
	});

	// --- Lifecycle & Bidirectional Binding -----------------------------------
	onMount(() => {
		const initial = (model?.getValue() ?? "").replace(/\r\n/g, "\n");
		const syncAnchor = takeMarkdownSyncAnchor(props.group, props.path);
		const saved = savedLiveViews.get(`${props.group}:${props.path}`);
		const fm = frontMatter(initial);
		const initialLines = initial.split("\n");
		const lineColOffset = (lineNum: number, colNum: number): number => {
			const clampedLine = Math.max(1, Math.min(lineNum, initialLines.length));
			let pos = 0;
			for (let i = 0; i < clampedLine - 1; i++) pos += initialLines[i]!.length + 1;
			const lineLen = initialLines[clampedLine - 1]?.length ?? 0;
			return Math.min(initial.length, pos + Math.max(0, Math.min(colNum - 1, lineLen)));
		};
		const defaultCursor =
			fm.lines > 0 && fm.lines < initialLines.length
				? (() => {
						let pos = 0;
						let startIdx = fm.lines;
						while (startIdx < initialLines.length - 1 && !initialLines[startIdx]!.trim()) startIdx++;
						for (let i = 0; i < startIdx && i < initialLines.length; i++) pos += initialLines[i]!.length + 1;
						return Math.min(pos, initial.length);
					})()
				: 0;

		const anchorPos = syncAnchor
			? syncAnchor.line <= fm.lines && fm.lines > 0
				? defaultCursor
				: lineColOffset(syncAnchor.line, syncAnchor.column)
			: saved
				? Math.min(saved.anchor, initial.length)
				: defaultCursor;
		const headPos = syncAnchor
			? anchorPos
			: saved
				? Math.min(saved.head, initial.length)
				: defaultCursor;

		const editorState = EditorState.create({
			doc: initial,
			selection: EditorSelection.range(anchorPos, headPos),
			extensions: [
				modeCompartment.of(modeExtensions(isRead())),
				history(),
				historyFallbackFacet.of({
					undo: () => {
						if (!model) return false;
						const before = model.getValue();
						model.undo();
						return model.getValue() !== before;
					},
					redo: () => {
						if (!model) return false;
						const before = model.getValue();
						model.redo();
						return model.getValue() !== before;
					},
				}),
				cmSearchTop,
				drawSelection(),
				dropCursor(),
				highlightSpecialChars(),
				EditorView.lineWrapping,
				markdown({ base: markdownLanguage, addKeymap: false, pasteURLAsLink: false }),
				cmStudioTheme,
				cmMarkdownHighlight,
				rawEditBlockField,
				gitMarksField,
				liveCallbacksFacet.of({
					filePath: () => props.path,
					onFollowLink: (href) => void followLink(href),
					onFollowWiki: (inner) => void followWiki(inner),
					onFollowTicket: followTicket,
					onTagClick: (tag) => searchFor(tagSearchPattern(tag), { regex: true }),
					onHoverLink: handleHoverLink,
					onHoverLeave: scheduleHideHover,
					onCopyCode: (code) => {
						void import("../commands").then((m) => m.copyText(code, "Copied code block."));
					},
					onCopyCodeForDesigner: async (code) => {
						const { session } = await import("../lsp/session");
						let out = code;
						if (state.lsp.state === "running") {
							out = await session.formatText(code, { tabSize: 4, insertSpaces: true }).catch(() => code);
						}
						const { copyText } = await import("../commands");
						await copyText(out, "Copied SSL code block, formatted, for Designer.");
					},
					onOpenCodeScratch: async (code, lang) => {
						const { newUntitled } = await import("../state");
						const scratchPath = newUntitled(state.activeGroup, lang);
						documents.get(scratchPath)?.model.setValue(code);
					},
					onSaveCodeSnippet: async (code, lang) => {
						const { ask } = await import("../dialogs");
						const { slug, snippetTemplate } = await import("../../shared/projectDocs");
						const title = (await ask(`Save ${lang.toUpperCase()} snippet to docs/knowledge/snippets/ as`))?.trim();
						if (!title || !slug(title) || !state.workspace || !state.project) return;
						const ext = lang === "sql" ? "sql" : "ssl";
						const docsParts = state.project.docs.split(/[\\/]/).filter((p) => p && p !== ".");
						const dest = joinPath(state.workspace.root, ...docsParts, DOC_FOLDERS.knowledge, "snippets", `${slug(title)}.${ext}`);
						const header = snippetTemplate({ title, language: ext });
						try {
							await backend.create(dest, "file");
							await backend.write(dest, `${header.replace(/\n*$/, "\n\n")}${code}\n`);
							setState("treeVersion", (v) => v + 1);
							notify(`Saved snippet to ${relativeTo(state.workspace.root, dest)}.`);
						} catch (e: any) {
							notify(`Could not save snippet: ${e?.message ?? e}`, "error");
						}
					},
					onFormatCode: (openLine) => formatCodeBlockAt(openLine),
					onToggleCheckbox: toggleCheckboxAt,
					onOpenImageLightbox: (info) => setLightbox({ ...info, zoomFull: false }),
					onOpenMermaidLightbox: (info) => setMermaidBox({ ...info, scale: 1, x: 0, y: 0 }),
					onResizeImage: resizeImageAt,
					isYamlEditorOpen: () => editYaml(),
				}),
				liveBlockField,
				liveInlinePlugin,
				liveCodeHighlightPlugin,
				liveInteractionExtension,
				markdownFoldService,
				cmMarkdownCompletion(() => props.path),
				cmAutoWrapExtension,
				cmSmartPasteExtension(() => props.path),
				cmMarkdownKeymap,
				EditorView.domEventHandlers({
					focus: () => {
						setState("activeGroup", props.group);
					},
				}),
				EditorView.updateListener.of((update) => {
					for (const tr of update.transactions) {
						if (tr.docChanged) pushTransactionToModel(tr);
					}
					if (update.selectionSet) bumpLiveSelection();
					if (update.selectionSet || update.focusChanged || update.docChanged) {
						const userMoved = update.transactions.some((tr) => tr.isUserEvent("select") || tr.isUserEvent("input") || tr.isUserEvent("delete"));
						syncCursorState(update.view, userMoved);
						queueMicrotask(() => updateTableHud(update.view));
					}
					if (update.docChanged) {
						queueMicrotask(() => {
							updateOutlineScrollspy();
							if (pointerY !== null) scheduleReadAssist();
						});
					}
				}),
			],
		});

		cmView = new EditorView({ state: editorState, parent: cmMountEl });

		// Restore persisted heading/list folds before measuring scroll offsets.
		if (saved?.folds?.length) {
			const docLen = cmView.state.doc.length;
			const foldEffects = saved.folds
				.filter(([from, to]) => from >= 0 && to <= docLen && from < to)
				.map(([from, to]) => foldEffect.of({ from, to }));
			if (foldEffects.length) cmView.dispatch({ effects: foldEffects });
		}

		if (syncAnchor && hostEl) {
			requestAnimationFrame(() => {
				if (!cmView || !hostEl) return;
				if (syncAnchor.topLine !== undefined) {
					if (syncAnchor.topLine <= Math.max(1, fm.lines + 1)) {
						hostEl.scrollTop = 0;
					} else {
						const ln = Math.max(1, Math.min(syncAnchor.topLine, cmView.state.doc.lines));
						const block = cmView.lineBlockAt(cmView.state.doc.line(ln).from);
						hostEl.scrollTop = Math.max(0, (cmMountEl?.offsetTop ?? 0) + block.top);
					}
					lastTopLine = syncAnchor.topLine;
				} else {
					cmView.dispatch({ effects: EditorView.scrollIntoView(headPos, { y: "center" }) });
				}
				updateOutlineScrollspy();
			});
		} else if (saved && hostEl) {
			queueMicrotask(() => {
				if (hostEl) hostEl.scrollTop = saved.scrollTop;
				updateOutlineScrollspy();
			});
		} else {
			queueMicrotask(updateOutlineScrollspy);
		}

		// Subscribe to split Read preview scroll sync from another group viewing the same Markdown file.
		const stopSplitSync = onSplitScrollSync((payload) => {
			if (!isRead() || !cmView || !hostEl) return;
			if (payload.sourceGroup === props.group) return;
			if (canonical(payload.path) !== canonical(props.path)) return;
			suppressSplitSyncUntil = performance.now() + 260;
			const maxScroll = Math.max(0, hostEl.scrollHeight - hostEl.clientHeight);
			let targetTop: number;
			if (payload.ratio <= 0.002) {
				targetTop = 0;
			} else if (payload.ratio >= 0.998) {
				targetTop = maxScroll;
			} else {
				const ln = Math.max(1, Math.min(payload.topLine, cmView.state.doc.lines));
				if (ln <= front().lines + 1 && payload.ratio < 0.05) {
					targetTop = 0;
				} else {
					const block = cmView.lineBlockAt(cmView.state.doc.line(ln).from);
					targetTop = Math.min(maxScroll, Math.max(0, (cmMountEl?.offsetTop ?? 0) + block.top));
				}
			}
			if (Math.abs(hostEl.scrollTop - targetTop) > 2) {
				const behavior: ScrollBehavior = Math.abs(hostEl.scrollTop - targetTop) > 160 ? "smooth" : "auto";
				hostEl.scrollTo({ top: targetTop, behavior });
			}
		});

		const openReadSearch = () => {
			if (!cmView) return;
			openSearchPanel(cmView);
		};
		if (!isRead()) registerLiveEditor(props.group, makeHandle(cmView));
		else registerReadFind(props.group, openReadSearch);

		// Reflect external Monaco model edits (Revert, Status menu, Rename links, Search & Replace, Read-mode checkbox ticks) back into CM6.
		const modelSub = model?.onDidChangeContent(() => {
			if (syncingFromCm || !cmView) return;
			const next = model.getValue().replace(/\r\n/g, "\n");
			setText(model.getValue());
			const cur = cmView.state.doc.toString();
			if (next === cur) return;
			syncingFromModel = true;
			try {
				const main = cmView.state.selection.main;
				cmView.dispatch({
					changes: { from: 0, to: cur.length, insert: next },
					selection: EditorSelection.range(Math.min(main.anchor, next.length), Math.min(main.head, next.length)),
					annotations: [externalSyncAnnotation.of(true), Transaction.addToHistory.of(false)],
				});
			} finally {
				syncingFromModel = false;
			}
		});

		const stopReveal = revealSignal.listen((path) => {
			if (path === props.path) applyReveal();
		});

		const onKeyDownGlobal = (e: KeyboardEvent) => {
			if (e.key === "Escape" && mermaidBox()) {
				e.preventDefault();
				setMermaidBox(null);
				return;
			}
			if (e.key === "Escape" && lightbox()) {
				e.preventDefault();
				setLightbox(null);
				return;
			}
			if (e.key === "Escape" && cmView && searchPanelOpen(cmView.state)) {
				e.preventDefault();
				closeSearchPanel(cmView);
				return;
			}
			if (
				isRead() &&
				(e.ctrlKey || e.metaKey) &&
				!e.altKey &&
				!e.shiftKey &&
				e.key.toLowerCase() === "f" &&
				cmView &&
				state.activeGroup === props.group &&
				state.centerView === "editors"
			) {
				const activeEl = document.activeElement;
				const inOtherInput =
					activeEl instanceof HTMLElement &&
					!activeEl.closest(".cm-md-host") &&
					activeEl.matches("input, textarea, [contenteditable=''], [contenteditable=true]");
				if (!inOtherInput) {
					e.preventDefault();
					openSearchPanel(cmView);
				}
			}
		};
		window.addEventListener("keydown", onKeyDownGlobal);

		syncCursorState(cmView, false);
		applyReveal();
		if (!isRead() && state.activeGroup === props.group && !openedForALook(props.path)) {
			queueMicrotask(() => cmView?.focus());
		}

		onCleanup(() => {
			cancelHover();
			if (scrollSyncRaf) {
				cancelAnimationFrame(scrollSyncRaf);
				scrollSyncRaf = 0;
			}
			yamlCompleter?.dispose();
			yamlCompleter = undefined;
			saveSyncAnchor();
			saveView();
			stopSplitSync();
			window.removeEventListener("keydown", onKeyDownGlobal);
			registerLiveEditor(props.group, undefined);
			registerReadFind(props.group, undefined);
			modelSub?.dispose();
			stopReveal();
			cmView?.destroy();
			cmView = undefined;
		});
	});

	// Seamlessly switch between Live and Read modes on the SAME CM6 instance with zero flash or scroll jump!
	createEffect(
		on(
			isRead,
			(read) => {
				if (!cmView) return;
				if (read && editYaml()) {
					yamlCompleter?.dispose();
					yamlCompleter = undefined;
					setEditYaml(false);
				}
				cmView.dispatch({
					effects: [
						modeCompartment.reconfigure(modeExtensions(read)),
						...(read ? [setRawEditBlockEffect.of(null)] : []),
						refreshLiveEffect.of(++refreshSeq),
					],
				});
				if (read) {
					setTableHud(null);
					registerLiveEditor(props.group, undefined);
					registerReadFind(props.group, () => {
						if (cmView) openSearchPanel(cmView);
					});
				} else {
					registerReadFind(props.group, undefined);
					registerLiveEditor(props.group, makeHandle(cmView));
					queueMicrotask(() => updateTableHud(cmView));
				}
				queueMicrotask(() => {
					updateOutlineScrollspy();
					if (pointerY !== null) scheduleReadAssist();
				});
			},
			{ defer: true },
		),
	);

	// Refresh Live/Read decorations whenever workspace docs / broken-link status updates.
	createEffect(
		on(
			docs,
			() => {
				if (cmView) cmView.dispatch({ effects: refreshLiveEffect.of(++refreshSeq) });
			},
			{ defer: true },
		),
	);

	// Keep CM6 Git gutter marks synced with `backend.gitBase` and live document edits.
	let gitBaseLines: string[] | null = null;
	let gitDrawTimer: ReturnType<typeof setTimeout> | undefined;
	const redrawGitMarks = () => {
		if (!cmView) return;
		if (!gitBaseLines) {
			cmView.dispatch({ effects: setGitChangesEffect.of([]) });
			return;
		}
		const changes = lineChanges(gitBaseLines, cmView.state.doc.toString().split(/\r?\n/));
		cmView.dispatch({ effects: setGitChangesEffect.of(changes) });
	};
	createEffect(
		on([() => props.path, gitVersion, () => Boolean(gitStatus())], ([path, , repo]) => {
			if (!repo || !path || path.startsWith("untitled:")) {
				gitBaseLines = null;
				redrawGitMarks();
				return;
			}
			let stale = false;
			onCleanup(() => (stale = true));
			backend.gitBase(path, "index").then(
				(baseText) => {
					if (stale) return;
					gitBaseLines = baseText === null ? null : baseText.split(/\r?\n/);
					redrawGitMarks();
				},
				() => {},
			);
		}),
	);
	createEffect(
		on(
			text,
			() => {
				if (!gitBaseLines) return;
				clearTimeout(gitDrawTimer);
				gitDrawTimer = setTimeout(redrawGitMarks, 300);
			},
			{ defer: true },
		),
	);
	onCleanup(() => clearTimeout(gitDrawTimer));

	// Re-tokenize fenced code blocks and callout snippets whenever the active theme changes.
	createEffect(
		on(
			themeVersion,
			() => {
				if (cmView) cmView.dispatch({ effects: refreshLiveEffect.of(++refreshSeq) });
			},
			{ defer: true },
		),
	);

	// Re-register handle if group index shifts (e.g. closing an earlier split group).
	createEffect(
		on(
			() => props.group,
			() => {
				if (!cmView) return;
				if (isRead()) {
					registerReadFind(props.group, () => {
						if (cmView) openSearchPanel(cmView);
					});
				} else {
					registerLiveEditor(props.group, makeHandle(cmView));
				}
			},
			{ defer: true },
		),
	);

	return (
		<div
			ref={hostEl}
			class="cm-md-host"
			classList={{ "cm-md-read": isRead(), "cm-md-live": !isRead() }}
			tabIndex={isRead() ? 0 : undefined}
			aria-label={`${baseName(props.path)}, ${isRead() ? "rendered" : "live preview"}`}
			aria-haspopup="menu"
			onScroll={() => {
				updateOutlineScrollspy();
				if (pointerY !== null) scheduleReadAssist();
				if (tableHud()) updateTableHud();
				if (!scrollSyncRaf) {
					scrollSyncRaf = requestAnimationFrame(() => {
						scrollSyncRaf = 0;
						if (!cmView || !hostEl) return;
						const topLine = currentTopLine(cmView);
						const maxScroll = Math.max(1, hostEl.scrollHeight - hostEl.clientHeight);
						const ratio = Math.max(0, Math.min(1, hostEl.scrollTop / maxScroll));
						if (!isRead()) {
							if (performance.now() >= suppressSplitSyncUntil) {
								emitSplitScrollSync(props.group, props.path, topLine, ratio);
							}
						} else if (state.activeGroup === props.group) {
							setState("cursor", { line: topLine, column: 1 });
						}
					});
				}
			}}
			onMouseMove={(e) => {
				pointerY = e.clientY;
				scheduleReadAssist();
			}}
			onMouseLeave={() => {
				pointerY = null;
				clearReadAssist();
			}}
			onContextMenu={(e) => void onContextMenu(e)}
			onKeyDown={(e) => {
				if (isRead() && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f" && cmView) {
					e.preventDefault();
					openSearchPanel(cmView);
				}
			}}
			onMouseDown={(e) => {
				setState("activeGroup", props.group);
				// In Live mode, clicking empty page margin below editor puts cursor at the end (Obsidian feel).
				if (!isRead() && (e.target === hostEl || e.target === pageEl)) {
					if (!cmView) return;
					const rect = cmMountEl.getBoundingClientRect();
					if (e.clientY > rect.bottom) {
						e.preventDefault();
						cmView.focus();
						cmView.dispatch({ selection: EditorSelection.cursor(cmView.state.doc.length) });
					}
				}
			}}
		>
			{/* Sticky Contextual Advanced Tables Toolbar (Live mode when cursor is inside a table — never overlaps table rows or viewport edges). */}
			<Show when={!isRead() && tableHud()}>
				{(hud) => (
					<div class="cm-md-table-toolbar-wrap">
						<div
							class="cm-md-table-toolbar"
							role="toolbar"
							aria-label="Table editing controls"
							onMouseDown={(e) => e.preventDefault()}
						>
							<span class="cm-tbl-pos" title="Use Tab / Shift+Tab to move across cells and Enter for next row">
								<Icon name="table" />
								<span>
									{hud().row <= 0 ? "Header" : `Row ${hud().row}`} · Col {hud().col + 1}
								</span>
							</span>
							<span class="cm-tbl-sep" aria-hidden="true" />
							<div class="cm-tbl-group" role="group" aria-label="Rows">
								<button type="button" title="Insert row above" onClick={() => runTableToolbarAction("md-table-row-above")}>
									<Icon name="add" />
									<span>Row above</span>
								</button>
								<button type="button" title="Insert row below" onClick={() => runTableToolbarAction("md-table-row-below")}>
									<Icon name="add" />
									<span>Row below</span>
								</button>
								<button type="button" title="Move row up" disabled={!hud().canMoveRowUp} aria-label="Move row up" onClick={() => runTableToolbarAction("md-table-row-up")}>
									<Icon name="arrow-up" />
								</button>
								<button type="button" title="Move row down" disabled={!hud().canMoveRowDown} aria-label="Move row down" onClick={() => runTableToolbarAction("md-table-row-down")}>
									<Icon name="arrow-down" />
								</button>
								<button type="button" class="danger" title="Delete current row" disabled={!hud().canDeleteRow} aria-label="Delete row" onClick={() => runTableToolbarAction("md-table-row-del")}>
									<Icon name="trash" />
								</button>
							</div>
							<span class="cm-tbl-sep" aria-hidden="true" />
							<div class="cm-tbl-group" role="group" aria-label="Columns">
								<button type="button" title="Insert column to the left" onClick={() => runTableToolbarAction("md-table-col-left")}>
									<Icon name="add" />
									<span>Col left</span>
								</button>
								<button type="button" title="Insert column to the right" onClick={() => runTableToolbarAction("md-table-col-right")}>
									<Icon name="add" />
									<span>Col right</span>
								</button>
								<button type="button" title="Move column left" disabled={!hud().canMoveColLeft} aria-label="Move column left" onClick={() => runTableToolbarAction("md-table-col-move-left")}>
									<Icon name="arrow-left" />
								</button>
								<button type="button" title="Move column right" disabled={!hud().canMoveColRight} aria-label="Move column right" onClick={() => runTableToolbarAction("md-table-col-move-right")}>
									<Icon name="arrow-right" />
								</button>
								<button type="button" class="danger" title="Delete current column" disabled={!hud().canDeleteCol} aria-label="Delete column" onClick={() => runTableToolbarAction("md-table-col-del")}>
									<Icon name="close" />
								</button>
							</div>
							<span class="cm-tbl-sep" aria-hidden="true" />
							<div class="cm-tbl-group" role="group" aria-label="Column alignment">
								<button type="button" classList={{ active: hud().align === "left" }} title="Align column left" onClick={() => runTableToolbarAction("md-table-align-left")}>
									L
								</button>
								<button type="button" classList={{ active: hud().align === "center" }} title="Align column center" onClick={() => runTableToolbarAction("md-table-align-center")}>
									C
								</button>
								<button type="button" classList={{ active: hud().align === "right" }} title="Align column right" onClick={() => runTableToolbarAction("md-table-align-right")}>
									R
								</button>
							</div>
							<span class="cm-tbl-sep" aria-hidden="true" />
							<div class="cm-tbl-group" role="group" aria-label="Sort and format">
								<button type="button" title="Sort rows A to Z by this column" onClick={() => runTableToolbarAction("md-table-sort-asc")}>
									<Icon name="sort-precedence" />
									<span>A–Z</span>
								</button>
								<button type="button" title="Sort rows Z to A by this column" onClick={() => runTableToolbarAction("md-table-sort-desc")}>
									<span>Z–A</span>
								</button>
								<button type="button" title="Align pipes and pad columns" onClick={() => runTableToolbarAction("md-table-format")}>
									<span>Format</span>
								</button>
								<button
									type="button"
									title="Return to interactive table grid"
									onClick={() => {
										if (!cmView) return;
										const pos = cmView.state.selection.main.head;
										cmView.dispatch({ effects: setRawEditBlockEffect.of(null) });
										requestAnimationFrame(() => {
											if (cmView) focusLiveWidgetAt(cmView, pos);
											updateTableHud(cmView);
										});
									}}
								>
									<Icon name="table" />
									<span>Grid</span>
								</button>
							</div>
						</div>
					</div>
				)}
			</Show>

			<div ref={pageEl} class="cm-md-page">
				{/* Inline Obsidian Properties card for YAML frontmatter (unified across Live & Read, with inline raw YAML editing). */}
				<Show
					when={facts().length > 0 || Boolean(yamlSpan())}
					fallback={
						<div class="cm-md-doc-bar" aria-label="Document actions">
							<Show when={!isRead()}>
								<button
									type="button"
									class="cm-md-props-edit"
									title="Add YAML frontmatter properties (status, ticket, tags, …)"
									onClick={() => void addPropertyValueInteractive()}
								>
									<Icon name="add" />
									<span>Properties</span>
								</button>
							</Show>
							<button
								type="button"
								class="cm-md-props-edit cm-md-links-pill"
								title={
									brokenOutgoingCount() > 0
										? `Jump to Links inspector (${brokenOutgoingCount()} broken outgoing)`
										: "Jump to Links inspector (Backlinks, Outgoing, Unlinked mentions)"
								}
								onClick={openLinksInspector}
							>
								<Icon name="references" />
								<span>Links ({totalLinksCount()})</span>
								<Show when={brokenOutgoingCount() > 0}>
									<span
										style={{
											color: "var(--error)",
											display: "inline-flex",
											"align-items": "center",
											gap: "2px",
											"font-weight": "600",
										}}
									>
										<Icon name="warning" />
										<span>{brokenOutgoingCount()}</span>
									</span>
								</Show>
							</button>
							<Menu
								floating
								class="cm-md-props-menu"
								label="Copy or export this document"
								title="Copy as HTML or Jira markup, print to PDF, or export standalone HTML"
								items={exportMenuItems}
							>
								<span>Export</span>
								<Icon name="chevron-down" />
							</Menu>
						</div>
					}
				>
					<section class="cm-md-props" aria-label="Document properties">
						<div class="cm-md-props-head">
							<button
								type="button"
								class="cm-md-props-toggle"
								aria-expanded={propsOpen()}
								onClick={() => setPropsOpen((v) => !v)}
							>
								<Icon name={propsOpen() ? "chevron-down" : "chevron-right"} />
								<span>Properties</span>
							</button>
							<div class="cm-md-props-actions">
								<Show when={!isRead()}>
									<button
										type="button"
										class="cm-md-props-edit"
										title="Add or update a YAML property without editing raw YAML"
										onClick={() => void addPropertyValueInteractive()}
									>
										<Icon name="add" />
										<span>Property</span>
									</button>
								</Show>
								<Show when={listed()?.group === "knowledge" && listed()?.kind === "questions" && toneOf(listed()?.status) === "done"}>
									<button
										type="button"
										class="cm-md-props-edit"
										title="Create a numbered Decision ADR pre-filled with this question and answer"
										onClick={() => void promoteQuestionToDecision(props.path)}
									>
										Promote to decision
									</button>
								</Show>
								<button
									type="button"
									class="cm-md-props-edit cm-md-links-pill"
									title={
										brokenOutgoingCount() > 0
											? `Jump to Links inspector (${brokenOutgoingCount()} broken outgoing)`
											: "Jump to Links inspector (Backlinks, Outgoing, Unlinked mentions)"
									}
									onClick={openLinksInspector}
								>
									<Icon name="references" />
									<span>Links ({totalLinksCount()})</span>
									<Show when={brokenOutgoingCount() > 0}>
										<span
											style={{
												color: "var(--error)",
												display: "inline-flex",
												"align-items": "center",
												gap: "2px",
												"font-weight": "600",
											}}
										>
											<Icon name="warning" />
											<span>{brokenOutgoingCount()}</span>
										</span>
									</Show>
								</button>
								<Menu
									floating
									class="cm-md-props-menu"
									label="Copy or export this document"
									title="Copy as HTML or Jira markup, print to PDF, or export standalone HTML"
									items={exportMenuItems}
								>
									<span>Export</span>
									<Icon name="chevron-down" />
								</Menu>
								<Show when={!isRead() && yamlSpan()}>
									<button
										ref={yamlEditBtnEl}
										type="button"
										class="cm-md-props-edit"
										classList={{ active: editYaml() }}
										aria-expanded={editYaml()}
										title={editYaml() ? "Hide raw YAML frontmatter (Esc)" : "Edit raw YAML frontmatter"}
										onClick={toggleEditYaml}
									>
										{editYaml() ? "Hide YAML" : "Edit YAML"}
									</button>
								</Show>
							</div>
						</div>
						<Show when={propsOpen() && facts().length > 0}>
							<dl class="cm-md-props-list">
								<For each={facts()}>
									{(fact) => (
										<div>
											<dt>{fact.key}</dt>
											<dd>
												<For each={fact.values}>
													{(value) => {
														const target = targetOf(fact.key, value);
														return (
															<span class="cm-md-prop-chip">
																<Show
																	when={target.file || target.web}
																	fallback={
																		<Show
																			when={fact.key === "tags" || fact.key === "tag"}
																			fallback={
																				<Show
																					when={fact.key === "status" && listed()}
																					fallback={
																						<Show
																							when={!isRead() && !isListProperty(fact.key)}
																							fallback={
																								<span classList={{ "doc-status": fact.key === "status", [`tone-${toneOf(value)}`]: fact.key === "status" }}>
																									{value}
																								</span>
																							}
																						>
																							<button
																								type="button"
																								class="cm-md-prop-scalar-btn"
																								classList={{ "doc-status": fact.key === "status", [`tone-${toneOf(value)}`]: fact.key === "status" }}
																								title={`Click to edit ${fact.key}`}
																								onClick={() => void editScalarPropertyInteractive(fact.key, value)}
																							>
																								{value}
																							</button>
																						</Show>
																					}
																				>
																					<Menu
																						class="md-status"
																						label={`Status: ${value}. Change it`}
																						title="Change the status"
																						items={() =>
																							statusChoices(listed()).map((status) => ({
																								label: status,
																								disabled: status.toLowerCase() === value.toLowerCase(),
																								why: "It is this already",
																								run: () => void setStatus(props.path, status),
																							}))
																						}
																					>
																						<span class={`doc-status tone-${toneOf(value)}`}>{value}</span>
																						<Icon name="chevron-down" />
																					</Menu>
																				</Show>
																			}
																		>
																			<button
																				type="button"
																				class="cm-md-prop-tag"
																				title={`Search workspace for #${value.replace(/^#+/, "")}`}
																				onClick={() => searchFor(tagSearchPattern(value), { regex: true })}
																			>
																				#{value.replace(/^#+/, "")}
																			</button>
																		</Show>
																	}
																>
																	<button
																		class="link"
																		title={target.web ?? target.file}
																		onClick={() => go(target)}
																		onMouseEnter={(e) => hoverFileButton(target.file, e.currentTarget, { ticket: ticket() || undefined })}
																		onMouseLeave={scheduleHideHover}
																	>
																		{target.display ?? value}
																	</button>
																	<Show
																		when={
																			!isRead() &&
																			EDITABLE_LINK_KEYS.has(fact.key) &&
																			!(fact.key === "ticket" && listed()?.group === "tickets")
																		}
																	>
																		<button
																			type="button"
																			class="cm-md-prop-edit"
																			title={`Edit ${fact.key}`}
																			aria-label={`Edit ${fact.key}`}
																			onClick={() => void editScalarPropertyInteractive(fact.key, value)}
																		>
																			<Icon name="edit" />
																		</button>
																	</Show>
																</Show>
																<Show when={!isRead() && !(fact.key === "status" && listed()) && fact.key !== "title" && !(fact.key === "ticket" && listed()?.group === "tickets")}>
																	<button
																		type="button"
																		class="cm-md-prop-rm"
																		title={`Remove ${value} from ${fact.key}`}
																		aria-label={`Remove ${value} from ${fact.key}`}
																		onClick={() => removePropertyValue(fact.key, value, fact.values.length)}
																	>
																		<Icon name="close" />
																	</button>
																</Show>
															</span>
														);
													}}
												</For>
												<Show when={!isRead() && isListProperty(fact.key)}>
													<button
														type="button"
														class="cm-md-prop-add"
														title={`Add another value to ${fact.key}`}
														aria-label={`Add value to ${fact.key}`}
														onClick={() => void addPropertyValueInteractive(fact.key)}
													>
														<Icon name="add" />
													</button>
												</Show>
											</dd>
										</div>
									)}
								</For>
							</dl>
						</Show>
						<Show when={!isRead() && editYaml() && yamlSpan()}>
							{(span) => (
								<div class="cm-md-props-yaml-wrap">
									<div class="cm-md-props-yaml-fence" aria-hidden="true">---</div>
									<textarea
										ref={(el) => {
											yamlCompleter?.dispose();
											yamlInputEl = el;
											el.value = span().inner;
											yamlCompleter = createTextareaCompleter(el, {
												mode: "yaml",
												filePath: () => props.path,
												getListedDoc: () => listed(),
												onApply: () => {
													resizeYamlInput(el);
													applyYamlInnerEdit(el.value);
												},
											});
											queueMicrotask(() => resizeYamlInput(el));
										}}
										class="cm-md-props-yaml"
										aria-label="Raw YAML frontmatter"
										spellcheck={false}
										rows={2}
										onInput={(e) => {
											const el = e.currentTarget;
											resizeYamlInput(el);
											applyYamlInnerEdit(el.value);
											yamlCompleter?.update();
										}}
										onBlur={() => {
											yamlCompleter?.close();
										}}
										onKeyDown={(e) => {
											if (yamlCompleter?.handleKeyDown(e)) return;
											if (e.key === "Escape") {
												e.preventDefault();
												e.stopPropagation();
												yamlCompleter?.dispose();
												yamlCompleter = undefined;
												setEditYaml(false);
												yamlEditBtnEl?.focus();
											} else if (e.key === "Tab" && !e.shiftKey) {
												e.preventDefault();
												const el = e.currentTarget;
												const s = el.selectionStart;
												const end = el.selectionEnd;
												const next = `${el.value.slice(0, s)}  ${el.value.slice(end)}`;
												el.value = next;
												el.setSelectionRange(s + 2, s + 2);
												resizeYamlInput(el);
												applyYamlInnerEdit(next);
											} else if ((e.ctrlKey || e.metaKey) && !e.altKey) {
												const k = e.key.toLowerCase();
												if (k === "z" && !e.shiftKey) {
													e.preventDefault();
													model?.undo();
												} else if (k === "y" || (k === "z" && e.shiftKey)) {
													e.preventDefault();
													model?.redo();
												}
											}
										}}
									/>
									<div class="cm-md-props-yaml-fence" aria-hidden="true">---</div>
								</div>
							)}
						</Show>
					</section>
				</Show>

				{/* Ticket work summary (specs, plans, registries, decisions, questions tied to this ticket — with link origins, quick-link actions, and hover previews). */}
				<Show when={ticket()}>
					<section class="md-work" aria-label={`The work for ${ticket()}`}>
						<div class="md-work-head">
							<h2>The work for {ticket()}</h2>
							<div class="md-work-actions">
								<button
									type="button"
									class="md-work-btn"
									title={`Create a new spec for ${ticket()}`}
									onClick={() => void newSpec()}
								>
									<Icon name="add" />
									<span>Spec</span>
								</button>
								<button
									type="button"
									class="md-work-btn"
									title={`Create a new plan for ${ticket()}`}
									onClick={() => void import("../commands").then((m) => m.runCommand("new-plan"))}
								>
									<Icon name="add" />
									<span>Plan</span>
								</button>
								<button
									type="button"
									class="md-work-btn"
									title={`Link an existing spec, plan, ticket, decision, or question to ${ticket()}`}
									onClick={() => void linkDocumentToTicket(props.path, ticket())}
								>
									<Icon name="references" />
									<span>Link…</span>
								</button>
								<Show
									when={listed()?.ticketFolder}
									fallback={
										<button
											type="button"
											class="md-work-btn"
											title={`Move ${ticket()} into its own folder (docs/tickets/${ticket()}/) for reference docs, code samples, and fixtures`}
											onClick={() => void createTicketFolder(props.path)}
										>
											<Icon name="new-folder" />
											<span>Folder</span>
										</button>
									}
								>
									{(folder) => (
										<button
											type="button"
											class="md-work-btn"
											title={`Create a new reference note, sample, or fixture inside ${relativeTo(state.workspace?.root, folder())}/`}
											onClick={() => void newTicketFile(folder(), ticket())}
										>
											<Icon name="new-file" />
											<span>File</span>
										</button>
									)}
								</Show>
								<Menu
									floating
									class="md-work-btn"
									label={`More work items for ${ticket()}`}
									title={`Create a sub-ticket, decision, question, or registry row for ${ticket()}`}
									items={() => [
										{ label: "New sub-ticket…", run: () => void newTicket(undefined, undefined, { parent: ticket() }) },
										{ label: "New decision…", run: () => void newKnowledge("decisions", { ticket: ticket() }) },
										{ label: "New question…", run: () => void newKnowledge("questions", { ticket: ticket() }) },
										{ label: "Add registry row…", run: () => void addRegistryRowForTicket(ticket()) },
										"separator",
										{ label: "Export deployment manifest (Markdown)…", run: () => void exportDeploymentManifest(props.path, ticket(), "markdown") },
										{ label: "Export deployment manifest (CSV)…", run: () => void exportDeploymentManifest(props.path, ticket(), "csv") },
										{ label: "Export deployment manifest (Word .docx)…", run: () => void exportDeploymentManifest(props.path, ticket(), "docx") },
										{ label: "Export release packet (HTML)…", run: () => void exportTicketPacket(props.path, ticket(), "html") },
										{ label: "Export release packet (Word .docx)…", run: () => void exportTicketPacket(props.path, ticket(), "docx") },
										"separator",
										{ label: "Close out ticket…", run: () => void closeoutTicket(props.path, ticket()) },
										...(listed() && isArchivedTicket(listed())
											? [{ label: "Unarchive ticket…", run: () => void unarchiveTicket(listed()!) }]
											: []),
									]}
								>
									<Icon name="add" />
									<span>More</span>
									<Icon name="chevron-down" />
								</Menu>
								<button
									type="button"
									class="md-work-btn md-work-guide-btn"
									classList={{ active: workGuideOpen() }}
									aria-expanded={workGuideOpen()}
									title="Show how documents and plans associate with a ticket"
									onClick={() => setWorkGuideOpen((v) => !v)}
								>
									<Icon name="question" />
									<span>How links work</span>
								</button>
							</div>
						</div>
						<Show when={workGuideOpen()}>
							<div class="md-work-guide">
								<p class="md-work-guide-intro">
									Everything under <strong>{ticket()}</strong> in the Work list and here comes straight from the files — no hidden metadata:
								</p>
								<dl class="md-work-guide-list">
									<div>
										<dt>Specs</dt>
										<dd>
											Add <code>specs: [path/to/spec.md]</code> on this ticket, add <code>ticket: {ticket()}</code> in the spec&apos;s frontmatter, or place a <code>.spec.md</code> beside a linked <code>.plan.json</code>.
										</dd>
									</div>
									<div>
										<dt>Plans</dt>
										<dd>
											Set <code>&quot;ticket&quot;: &quot;{ticket()}&quot;</code> in the plan (via the Plan panel&apos;s Ticket field) or add <code>plans: [design/Name.plan.json]</code> on this ticket.
										</dd>
									</div>
									<div>
										<dt>Decisions &amp; Questions</dt>
										<dd>
											Add <code>ticket: {ticket()}</code> (or <code>tickets: [{ticket()}, …]</code>) in that document&apos;s YAML frontmatter.
										</dd>
									</div>
									<div>
										<dt>Tickets</dt>
										<dd>
											Use <code>parent: {ticket()}</code> on another ticket to nest it under {ticket()} in Work, or <code>related: [OTHER-1]</code> on either ticket.
										</dd>
									</div>
									<div>
										<dt>Registries</dt>
										<dd>
											Any CSV row whose <code>Ticket</code> column lists <code>{ticket()}</code> appears under <em>Registries</em> and opens filtered to those rows.
										</dd>
									</div>
									<div>
										<dt>Ticket folder</dt>
										<dd>
											Place reference docs, existing code samples, and fixtures inside <code>docs/tickets/{ticket()}/</code> — click the folder under <em>Ticket files</em> to browse them in a focused Explorer view without cluttering the Work sidebar.
										</dd>
									</div>
								</dl>
							</div>
						</Show>
						<Show when={workRollup().length > 0}>
							<div class="md-work-rollup" aria-label="Work progress summary">
								<For each={workRollup()}>{(part) => <span>{part}</span>}</For>
							</div>
						</Show>
						<Show
							when={work().length > 0 || Boolean(listed()?.ticketFolder)}
							fallback={
								<p class="md-work-empty">
									No specs, plans, or notes linked yet. Use <strong>Spec</strong>, <strong>Plan</strong>, <strong>Link…</strong>, or <strong>Folder</strong> above, or open <strong>How links work</strong> to wire them in YAML.
								</p>
							}
						>
							<For each={work()}>
								{(group) => (
									<div class="md-work-group">
										<h3>{group.name}</h3>
										<ul>
											<For each={group.items}>
												{(item) => {
													const file = item.file;
													return (
														<li>
															<button
																class="link"
																title={[file.path, `Linked via: ${item.detail}`, group.kind === "registry" ? `Opens the table at the rows for ${ticket()}.` : ""].filter(Boolean).join("\n")}
																onClick={() => {
																	if (group.kind === "registry") askRows(file.path, ticket());
																	void openFile(file.path);
																}}
																onMouseEnter={(e) =>
																	hoverFileButton(file.path, e.currentTarget, {
																		ticket: group.kind === "registry" ? ticket() : undefined,
																	})
																}
																onMouseLeave={scheduleHideHover}
															>
																{file.ticket && !file.title?.startsWith(file.ticket) ? `${file.ticket}: ` : ""}
																{group.kind === "registry" ? registryTitle(file.name) : file.title || file.name.replace(/\.plan\.json$/i, "")}
															</button>
															<Show when={group.kind === "registry" && file.forTickets?.find((rows) => rows.key.toLowerCase() === ticket().toLowerCase())}>
																{(rows) => <span class="md-work-note">{rowsLine(rows())}</span>}
															</Show>
															<Show when={file.status}>
																<span class={`doc-status tone-${toneOf(file.status)}`}>{file.status}</span>
															</Show>
															<span class="md-work-via" title={item.detail}>
																{item.reason}
															</span>
															<Show when={group.kind !== "registry"}>
																<button
																	type="button"
																	class="md-work-unlink"
																	title={`Unlink ${file.ticket ?? file.title ?? file.name} from ${ticket()}`}
																	aria-label={`Unlink ${file.ticket ?? file.title ?? file.name}`}
																	onClick={() => void unlinkDocumentFromTicket(props.path, ticket(), file)}
																>
																	<Icon name="close" />
																</button>
															</Show>
														</li>
													);
												}}
											</For>
										</ul>
									</div>
								)}
							</For>
							<Show when={listed()?.ticketFolder}>
								{(folder) => {
									const count = () => listed()?.ticketFileCount ?? listed()?.ticketFiles?.length ?? 0;
									const relFolder = () => relativeTo(state.workspace?.root, folder()).split("\\").join("/");
									const openScoped = () =>
										void import("../panels/Explorer").then((m) => m.browseFolderInExplorer(folder(), `${ticket()} files`));
									return (
										<div class="md-work-group md-work-files">
											<h3>Ticket files</h3>
											<ul>
												<li class="md-work-file-row">
													<button
														type="button"
														class="link md-work-folder-link"
														title={`Browse ${relFolder()}/ in a focused Explorer view`}
														onClick={openScoped}
													>
														<Icon name="folder" />
														<span>{relFolder()}/</span>
													</button>
													<span class="md-work-note">
														{count() === 0 ? "No extra files" : `${count()} ${count() === 1 ? "file" : "files"}`}
													</span>
													<span class="md-work-via" title="Opens this ticket's folder in a focused Explorer view">
														Explorer
													</span>
												</li>
											</ul>
										</div>
									);
								}}
							</Show>
							<Show when={readiness()}>
								{(rep) => (
									<div class="md-readiness">
										<button
											type="button"
											class="md-readiness-toggle"
											aria-expanded={readinessOpen()}
											title="STARLIMS transport & release readiness checklist for this ticket"
											onClick={() => setReadinessOpen((v) => !v)}
										>
											<Icon name={readinessOpen() ? "chevron-down" : "chevron-right"} />
											<span>Release readiness</span>
											<span class={`md-readiness-badge ${rep().ready ? "ready" : "pending"}`}>
												{rep().pass}/{rep().total} {rep().ready ? "ready" : "checks"}
											</span>
										</button>
										<Show when={readinessOpen()}>
											<ul class="md-readiness-list">
												<For each={rep().checks}>
													{(chk) => (
														<li class={`md-readiness-row level-${chk.level}`}>
															<Icon name={chk.level === "pass" ? "check" : chk.level === "warn" ? "warning" : "info"} />
															<strong>{chk.label}:</strong>
															<Show
																when={chk.path && !chk.ok}
																fallback={<span class="md-readiness-detail">{chk.detail}</span>}
															>
																<button
																	type="button"
																	class="link"
																	title="Open referenced document"
																	onClick={() => void openFile(chk.path!)}
																>
																	{chk.detail}
																</button>
															</Show>
														</li>
													)}
												</For>
											</ul>
										</Show>
									</div>
								)}
							</Show>
						</Show>
					</section>
				</Show>

				{/* Non-ticket linked documents (specs, decisions, questions, reference, schema): show linked tickets + unlink + Link to ticket action. */}
				<Show when={linkedTickets().length > 0 || (!ticket() && listed() && !isCatalog(listed()!) && ["specs", "knowledge", "schema"].includes(listed()!.group))}>
					<section class="md-linked-tickets" aria-label="Linked tickets">
						<div class="md-linked-head">
							<h2>Linked tickets</h2>
							<button
								type="button"
								class="md-work-btn"
								title="Link this document to a ticket"
								onClick={() => void linkNonTicketToTicket(props.path)}
							>
								<Icon name="references" />
								<span>Link to ticket…</span>
							</button>
						</div>
						<Show
							when={linkedTickets().length > 0}
							fallback={<p class="md-work-empty">Not linked to a ticket yet.</p>}
						>
							<ul>
								<For each={linkedTickets()}>
									{(entry) => (
										<li>
											<button
												class="link"
												title={[entry.ticket.path, `Linked via: ${entry.detail}`].join("\n")}
												onClick={() => void openFile(entry.ticket.path)}
												onMouseEnter={(e) => hoverFileButton(entry.ticket.path, e.currentTarget)}
												onMouseLeave={scheduleHideHover}
											>
												<strong>{entry.key}</strong>
												<Show when={entry.ticket.title && !entry.ticket.title.toLowerCase().startsWith(entry.key.toLowerCase())}>
													{`: ${entry.ticket.title}`}
												</Show>
											</button>
											<Show when={entry.ticket.status}>
												<span class={`doc-status tone-${toneOf(entry.ticket.status)}`}>{entry.ticket.status}</span>
											</Show>
											<span class="md-work-via" title={entry.detail}>
												{entry.reason}
											</span>
											<Show when={entry.reason !== "in ticket folder" && listed()}>
												<button
													type="button"
													class="md-work-unlink"
													title={`Unlink from ${entry.key}`}
													aria-label={`Unlink from ${entry.key}`}
													onClick={() => void unlinkDocumentFromTicket(entry.ticket.path, entry.key, listed()!)}
												>
													<Icon name="close" />
												</button>
											</Show>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</section>
				</Show>

				{/* Reverse Schema -> Code & Registries bridge: shows scripts, data sources, SQL, and database.csv rows referencing this schema table. */}
				<Show when={schemaIdent() && ((schemaUsages()?.code.length ?? 0) + (schemaUsages()?.registries.length ?? 0) > 0) ? schemaUsages() : undefined}>
					{(usages) => {
						const totalRefs = () => usages().code.length + usages().registries.length;
						return (
							<section class="md-linked-tickets md-schema-usages" aria-label="Used in code and registries">
								<div class="md-linked-head">
									<button
										type="button"
										class="md-readiness-toggle"
										aria-expanded={schemaUsagesOpen()}
										onClick={() => setSchemaUsagesOpen((v) => !v)}
									>
										<Icon name={schemaUsagesOpen() ? "chevron-down" : "chevron-right"} />
										<span>Used in code &amp; registries</span>
										<span class="doc-status tone-active">{totalRefs()}</span>
									</button>
								</div>
								<Show when={schemaUsagesOpen()}>
									<ul>
										<For each={usages().registries}>
											{(r) => (
												<li>
													<button class="link" onClick={() => void openFile(r.path)}>
														{r.rel}
													</button>
													<span class="md-work-via">registry</span>
												</li>
											)}
										</For>
										<For each={usages().code}>
											{(c) => (
												<li>
													<button class="link" title={`${c.rel}:${c.line}`} onClick={() => void openFile(c.path, { reveal: { line: c.line } })}>
														{c.rel}
													</button>
													<span class="md-work-via">
														L{c.line}
														{c.count > 1 ? ` · ${c.count} refs` : ""}
													</span>
												</li>
											)}
										</For>
									</ul>
								</Show>
							</section>
						);
					}}
				</Show>

				{/* Unified CodeMirror 6 surface (powers both Live Preview and Read mode). */}
				<div ref={cmMountEl} class="cm-md-editor-wrap" />

				{/* Compact 3-tab Links Inspector (Backlinks with context snippets, Outgoing links, Unlinked mentions). */}
				<Show when={linksForcedVisible() || totalLinksCount() > 0}>
					<section ref={linksSectionEl} class="cm-md-backlinks cm-md-links-inspector" aria-label="Document links inspector">
						<div
							class="cm-md-links-head"
							style={{
								display: "flex",
								"flex-wrap": "wrap",
								"align-items": "center",
								gap: "6px 12px",
							}}
						>
							<button
								type="button"
								class="cm-md-backlinks-toggle"
								aria-expanded={backlinksOpen()}
								onClick={() => setBacklinksOpen((v) => !v)}
							>
								<Icon name={backlinksOpen() ? "chevron-down" : "chevron-right"} />
								<span>Links</span>
							</button>
							<div
								class="cm-md-links-tabs"
								role="tablist"
								aria-label="Links inspector tabs"
								style={{ display: "inline-flex", "flex-wrap": "wrap", gap: "4px" }}
							>
								<button
									type="button"
									role="tab"
									class="md-work-btn"
									classList={{ active: linksTab() === "backlinks" }}
									aria-selected={linksTab() === "backlinks"}
									onClick={() => {
										setLinksTab("backlinks");
										setBacklinksOpen(true);
									}}
								>
									<span>Backlinks ({linked()?.length ?? 0})</span>
								</button>
								<button
									type="button"
									role="tab"
									class="md-work-btn"
									classList={{ active: linksTab() === "outgoing" }}
									aria-selected={linksTab() === "outgoing"}
									onClick={() => {
										setLinksTab("outgoing");
										setBacklinksOpen(true);
									}}
								>
									<span>Outgoing ({outgoingLinks().length})</span>
									<Show when={brokenOutgoingCount() > 0}>
										<span
											style={{
												color: "var(--error)",
												display: "inline-flex",
												"align-items": "center",
												gap: "2px",
												"font-weight": "600",
											}}
											title={`${brokenOutgoingCount()} broken outgoing ${brokenOutgoingCount() === 1 ? "link" : "links"}`}
										>
											<Icon name="warning" />
											<span>{brokenOutgoingCount()}</span>
										</span>
									</Show>
								</button>
								<button
									type="button"
									role="tab"
									class="md-work-btn"
									classList={{ active: linksTab() === "unlinked" }}
									aria-selected={linksTab() === "unlinked"}
									onClick={() => {
										setLinksTab("unlinked");
										setBacklinksOpen(true);
									}}
								>
									<span>Unlinked mentions ({unlinkedMentions()?.length ?? 0})</span>
								</button>
							</div>
						</div>
						<Show when={backlinksOpen()}>
							<Show when={linksTab() === "backlinks"}>
								<Show
									when={(linked()?.length ?? 0) > 0}
									fallback={<p class="md-work-empty">No other workspace documents link here yet.</p>}
								>
									<ul>
										<For each={linked()}>
											{(from) => (
												<li style={{ "flex-direction": "column", "align-items": "stretch", gap: "3px" }}>
													<div style={{ display: "flex", "flex-wrap": "wrap", "align-items": "baseline", gap: "4px 10px" }}>
														<button
															class="link"
															title={relativeTo(state.workspace?.root, from.path)}
															onClick={() => void openFile(from.path, { reveal: { line: from.line } })}
															onMouseEnter={(e) => hoverFileButton(from.path, e.currentTarget, { line: from.line })}
															onMouseLeave={scheduleHideHover}
														>
															{called(from.path)}
														</button>
														<span class="md-work-via">L{from.line}</span>
														<Show when={from.places > 1}>
															<span class="md-work-note">{from.places} places</span>
														</Show>
													</div>
													<Show when={from.snippet}>
														<div
															class="cm-md-link-snippet"
															style={{
																"font-size": "var(--text-xs, 12px)",
																color: "var(--editor-muted, var(--muted))",
																"line-height": "1.45",
																"padding-left": "10px",
																"border-left": "2px solid color-mix(in srgb, var(--editor-border, var(--border)) 80%, transparent)",
																"overflow-wrap": "anywhere",
															}}
														>
															{from.snippet}
														</div>
													</Show>
												</li>
											)}
										</For>
									</ul>
								</Show>
							</Show>
							<Show when={linksTab() === "outgoing"}>
								<Show
									when={outgoingLinks().length > 0}
									fallback={<p class="md-work-empty">No outgoing links, embeds, or ticket references in this document.</p>}
								>
									<ul>
										<For each={outgoingLinks()}>
											{(item) => (
												<li>
													<button
														type="button"
														class="link"
														title={
															item.broken
																? `Broken link on line ${item.line}: ${item.target}`
																: item.resolvedPath
																	? relativeTo(state.workspace?.root, item.resolvedPath)
																	: item.target
														}
														onClick={() => {
															if (item.kind === "web") {
																void window.open(item.target, "_blank", "noopener");
															} else if (item.broken) {
																jumpToLine(item.line);
															} else if (item.resolvedPath) {
																if (item.heading) void followHeadingInFile(item.resolvedPath, item.heading);
																else void openFile(item.resolvedPath, item.targetLine ? { reveal: { line: item.targetLine } } : {});
															} else if (item.kind === "wiki" || item.kind === "embed") {
																void followWiki(item.target);
															} else {
																void followLink(item.target);
															}
														}}
														onMouseEnter={(e) => {
															if (item.resolvedPath && !item.broken) {
																hoverFileButton(item.resolvedPath, e.currentTarget, { line: item.targetLine });
															}
														}}
														onMouseLeave={scheduleHideHover}
													>
														{item.label}
													</button>
													<span class="md-work-via">{item.kind}</span>
													<button
														type="button"
														class="md-work-btn"
														title={`Jump to line ${item.line} in this document`}
														onClick={() => jumpToLine(item.line)}
													>
														L{item.line}
													</button>
													<Show when={item.broken}>
														<span
															style={{
																display: "inline-flex",
																"align-items": "center",
																gap: "4px",
																padding: "1px 6px",
																"border-radius": "999px",
																"font-size": "11px",
																"font-weight": "600",
																color: "var(--error)",
																background: "color-mix(in srgb, var(--error) 14%, transparent)",
															}}
														>
															<Icon name="warning" />
															<span>Broken</span>
														</span>
													</Show>
													<Show when={item.broken && item.instead && !isRead()}>
														<button
															type="button"
															class="md-work-btn"
															title={`Update broken link to ${item.instead}`}
															onClick={() => {
																if (!cmView || !item.instead) return;
																const cur = cmView.state.doc.toString();
																const fixed = withLinkFile(cur, item.line, item.target, item.instead);
																if (fixed !== null && fixed !== cur) {
																	cmView.dispatch({ changes: { from: 0, to: cur.length, insert: fixed }, userEvent: "input.fix" });
																	notify(`Fixed broken link to ${item.instead}.`);
																}
															}}
														>
															<Icon name="wand" />
															<span>Fix</span>
														</button>
													</Show>
												</li>
											)}
										</For>
									</ul>
								</Show>
							</Show>
							<Show when={linksTab() === "unlinked"}>
								<Show
									when={(unlinkedMentions()?.length ?? 0) > 0}
									fallback={<p class="md-work-empty">No unlinked plain-text mentions found in other workspace docs.</p>}
								>
									<ul>
										<For each={unlinkedMentions()}>
											{(m) => (
												<li style={{ "flex-direction": "column", "align-items": "stretch", gap: "3px" }}>
													<div style={{ display: "flex", "flex-wrap": "wrap", "align-items": "center", gap: "4px 10px" }}>
														<button
															type="button"
															class="link"
															title={`Open ${relativeTo(state.workspace?.root, m.path)} at line ${m.line}`}
															onClick={() => void openFile(m.path, { reveal: { line: m.line, column: m.column + 1 } })}
															onMouseEnter={(e) => hoverFileButton(m.path, e.currentTarget, { line: m.line })}
															onMouseLeave={scheduleHideHover}
														>
															{called(canonical(m.path))}
														</button>
														<span class="md-work-via">L{m.line}</span>
														<button
															type="button"
															class="md-work-btn"
															title={`Convert "${m.matchedText}" into a [[wikilink]] in ${called(canonical(m.path))}`}
															onClick={() => void linkifyUnlinkedMention(m)}
														>
															<Icon name="references" />
															<span>Link</span>
														</button>
													</div>
													<Show when={m.snippet}>
														<div
															class="cm-md-link-snippet"
															style={{
																"font-size": "var(--text-xs, 12px)",
																color: "var(--editor-muted, var(--muted))",
																"line-height": "1.45",
																"padding-left": "10px",
																"border-left": "2px solid color-mix(in srgb, var(--editor-border, var(--border)) 80%, transparent)",
																"overflow-wrap": "anywhere",
															}}
														>
															{m.snippet}
														</div>
													</Show>
												</li>
											)}
										</For>
									</ul>
								</Show>
							</Show>
						</Show>
					</section>
				</Show>
			</div>

			{/* Obsidian-style Hover Page Preview popover (portaled to body so container-type: inline-size never offsets/clips fixed positioning). */}
			<Show when={hoverCard()}>
				{(card) => (
					<Portal>
						<div
							class="md-hover-card"
							style={{ left: `${card().x}px`, top: `${card().y}px` }}
							onMouseEnter={() => {
								cardHovered = true;
								clearTimeout(hideTimer);
							}}
							onMouseLeave={() => {
								cardHovered = false;
								scheduleHideHover();
							}}
						>
							<div class="md-hover-head">
								<button
									type="button"
									class="md-hover-title"
									title={`Open ${card().relPath}`}
									onClick={() => {
										const target = card();
										setHoverCard(null);
										void openFile(target.path, target.line ? { reveal: { line: target.line } } : {});
									}}
								>
									{card().title}
								</button>
								<Show when={card().status}>
									<span class={`doc-status tone-${card().statusTone ?? "active"}`}>{card().status}</span>
								</Show>
								<Show when={card().badge}>
									<span class="md-hover-badge">{card().badge}</span>
								</Show>
								<span class="md-hover-path">{card().relPath}</span>
							</div>
							<div
								ref={hoverBodyEl}
								class="md-hover-body md"
								innerHTML={card().html}
								onClick={(e) => {
									const a = (e.target as HTMLElement | null)?.closest?.("a");
									if (!a) return;
									e.preventDefault();
									const href = a.getAttribute("href");
									const basePath = card().path;
									setHoverCard(null);
									if (!href) return;
									const leads = linkLeads(href, basePath, state.workspace?.root);
									if (!leads) return;
									if ("web" in leads) return void window.open(leads.web, "_blank", "noopener");
									if ("heading" in leads) return void followHeadingInFile(basePath, leads.heading);
									if (!leads.lines && href.includes("#")) {
										const h = decodeURIComponent(href.slice(href.indexOf("#") + 1));
										if (h) return void followHeadingInFile(leads.file, h);
									}
									void openFile(leads.file, leads.lines ? { reveal: leads.lines } : {});
								}}
							/>
						</div>
					</Portal>
				)}
			</Show>

			{/* Image Lightbox Modal (portaled to body so it covers tab strips & panels cleanly). */}
			<Show when={lightbox()}>
				{(box) => (
					<Portal>
						<div
							class="md-lightbox-backdrop"
							role="dialog"
							aria-modal="true"
							aria-label={`Image preview: ${box().alt || "image"}`}
							onClick={(e) => {
								if (e.target === e.currentTarget) setLightbox(null);
							}}
						>
							<div class="md-lightbox-bar">
								<span class="md-lightbox-caption">{box().alt || (box().filePath ? baseName(box().filePath!) : "Image preview")}</span>
								<Show when={box().filePath}>
									<span class="md-lightbox-path">{relativeTo(state.workspace?.root, box().filePath!)}</span>
								</Show>
								<span class="spacer" />
								<button
									type="button"
									class="md-lightbox-btn"
									title={box().zoomFull ? "Fit image to window" : "View at 100% actual size"}
									onClick={() => setLightbox((cur) => (cur ? { ...cur, zoomFull: !cur.zoomFull } : null))}
								>
									<Icon name={box().zoomFull ? "zoom-out" : "zoom-in"} />
									<span>{box().zoomFull ? "Fit" : "100%"}</span>
								</button>
								<Show when={box().filePath}>
									<button
										type="button"
										class="md-lightbox-btn"
										title="Open image file in a tab"
										onClick={() => {
											const p = box().filePath!;
											setLightbox(null);
											void openFile(p);
										}}
									>
										<Icon name="go-to-file" />
										<span>Open file</span>
									</button>
								</Show>
								<button type="button" class="md-lightbox-btn" title="Close preview (Esc)" aria-label="Close image preview" onClick={() => setLightbox(null)}>
									<Icon name="close" />
								</button>
							</div>
							<div class="md-lightbox-stage" classList={{ "is-full": Boolean(box().zoomFull) }} onClick={(e) => e.target === e.currentTarget && setLightbox(null)}>
								<img src={box().src} alt={box().alt} />
							</div>
						</div>
					</Portal>
				)}
			</Show>
			{/* Mermaid Zoom / Pan Diagram Lightbox Modal */}
			<Show when={mermaidBox()}>
				{(box) => (
					<Portal>
						<div
							ref={(el) => queueMicrotask(() => el.focus())}
							tabIndex={-1}
							class="md-lightbox-backdrop"
							role="dialog"
							aria-modal="true"
							aria-label="Mermaid diagram zoom viewer"
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation();
									setMermaidBox(null);
									return;
								}
								if (e.key === "+" || e.key === "=") {
									e.preventDefault();
									setMermaidBox((c) => (c ? { ...c, scale: Math.min(4, +(c.scale + 0.25).toFixed(2)) } : null));
								} else if (e.key === "-" || e.key === "_") {
									e.preventDefault();
									setMermaidBox((c) => (c ? { ...c, scale: Math.max(0.25, +(c.scale - 0.25).toFixed(2)) } : null));
								} else if (e.key === "0") {
									e.preventDefault();
									setMermaidBox((c) => (c ? { ...c, scale: 1, x: 0, y: 0 } : null));
								} else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
									e.preventDefault();
									const step = e.shiftKey ? 120 : 48;
									const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
									const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
									setMermaidBox((c) => (c ? { ...c, x: c.x + dx, y: c.y + dy } : null));
								}
							}}
							onClick={(e) => {
								if (e.target === e.currentTarget) setMermaidBox(null);
							}}
						>
							<div class="md-lightbox-bar">
								<span class="md-lightbox-caption">Mermaid diagram</span>
								<span class="md-lightbox-path">{Math.round(box().scale * 100)}% · scroll or +/- to zoom, drag or arrows to pan, 0 to reset</span>
								<span class="spacer" />
								<button
									type="button"
									class="md-lightbox-btn"
									title="Zoom out (-)"
									onClick={() => setMermaidBox((c) => (c ? { ...c, scale: Math.max(0.25, +(c.scale - 0.25).toFixed(2)) } : null))}
								>
									<Icon name="zoom-out" />
								</button>
								<button
									type="button"
									class="md-lightbox-btn"
									title="Zoom in (+)"
									onClick={() => setMermaidBox((c) => (c ? { ...c, scale: Math.min(4, +(c.scale + 0.25).toFixed(2)) } : null))}
								>
									<Icon name="zoom-in" />
								</button>
								<button
									type="button"
									class="md-lightbox-btn"
									title="Reset zoom and pan (0)"
									onClick={() => setMermaidBox((c) => (c ? { ...c, scale: 1, x: 0, y: 0 } : null))}
								>
									<Icon name="refresh" />
									<span>Reset</span>
								</button>
								<button
									type="button"
									class="md-lightbox-btn"
									title="Copy standalone SVG markup"
									onClick={() =>
										void (async () => {
											const isDark = document.documentElement.dataset.editorTheme !== "light" && document.documentElement.dataset.theme !== "light";
											const exportSvg = (await renderMermaidSvgForExport(box().code, isDark ? "dark" : "light")) || box().svg;
											const { copyText } = await import("../commands");
											await copyText(exportSvg, "Copied Mermaid SVG.");
										})()
									}
								>
									<Icon name="copy" />
									<span>Copy SVG</span>
								</button>
								<button
									type="button"
									class="md-lightbox-btn"
									title="Download standalone SVG file"
									onClick={() =>
										void (async () => {
											const stem = baseName(props.path).replace(/\.(md|markdown)$/i, "");
											const isDark = document.documentElement.dataset.editorTheme !== "light" && document.documentElement.dataset.theme !== "light";
											const exportSvg = (await renderMermaidSvgForExport(box().code, isDark ? "dark" : "light")) || box().svg;
											downloadMermaidBlob(new Blob([exportSvg], { type: "image/svg+xml;charset=utf-8" }), `${stem}-diagram.svg`);
											notify(`Saved ${stem}-diagram.svg.`);
										})()
									}
								>
									<span>Save SVG</span>
								</button>
								<button
									type="button"
									class="md-lightbox-btn"
									title="Copy diagram as PNG (falls back to download)"
									onClick={() =>
										void copyMermaidAsPng(box().svg, box().code).then((res) =>
											notify(
												res === "copied"
													? "Copied diagram PNG to clipboard."
													: res === "downloaded"
														? "Downloaded diagram.png."
														: "Could not render diagram PNG.",
												res === "failed" ? "error" : "info",
											),
										)
									}
								>
									<span>Copy PNG</span>
								</button>
								<button type="button" class="md-lightbox-btn" title="Close preview (Esc)" aria-label="Close diagram preview" onClick={() => setMermaidBox(null)}>
									<Icon name="close" />
								</button>
							</div>
							<div
								class="md-lightbox-stage md-mermaid-lightbox-stage"
								onWheel={(e) => {
									e.preventDefault();
									const delta = e.deltaY < 0 ? 0.15 : -0.15;
									setMermaidBox((c) => (c ? { ...c, scale: Math.max(0.25, Math.min(4, +(c.scale + delta).toFixed(2))) } : null));
								}}
								onPointerDown={(e) => {
									if (e.button !== 0) return;
									const cur = mermaidBox();
									if (!cur) return;
									mermaidPan = { startX: e.clientX, startY: e.clientY, origX: cur.x, origY: cur.y };
									(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
								}}
								onPointerMove={(e) => {
									if (!mermaidPan) return;
									const dx = e.clientX - mermaidPan.startX;
									const dy = e.clientY - mermaidPan.startY;
									setMermaidBox((c) => (c ? { ...c, x: mermaidPan!.origX + dx, y: mermaidPan!.origY + dy } : null));
								}}
								onPointerUp={() => {
									mermaidPan = null;
								}}
								onPointerCancel={() => {
									mermaidPan = null;
								}}
							>
								<div
									class="md-mermaid-lightbox-canvas"
									style={{ transform: `translate(${box().x}px, ${box().y}px) scale(${box().scale})` }}
									innerHTML={box().svg}
								/>
							</div>
						</div>
					</Portal>
				)}
			</Show>
		</div>
	);
}
