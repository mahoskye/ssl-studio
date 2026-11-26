// Unified Obsidian-grade CodeMirror 6 engine for BOTH Markdown Live Preview and Read view (ADR 0028).
// Synced 1:1 with the open document's Monaco ITextModel (ADR 0002: plain text stays the single
// source of truth for saves, undo across views, Git, Search, Diagnostics, Agent, and Document Outline).
import { history } from "@codemirror/commands";
import { foldAll as cmFoldAll, foldEffect, foldedRanges, unfoldAll as cmUnfoldAll } from "@codemirror/language";
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Annotation, Compartment, EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, drawSelection, dropCursor, EditorView, highlightSpecialChars } from "@codemirror/view";
import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show, untrack } from "solid-js";
import { Portal } from "@solidjs/web";
import { fenced } from "../../shared/catalog";
import { placeAnchoredMenu, submenuOrInline, type RectBox } from "../../shared/contextMenu";
import { linkLeads, withLinkFile } from "../../shared/docLinks";
import { fenceAtLine, fenceFormatTarget } from "../../shared/fencedFormat";
import { frontMatter, frontMatterInnerSpan, one, quoteYamlScalar } from "../../shared/frontMatter";
import { tagSearchPattern } from "../../shared/tags";
import { buildCalloutBlock, documentHeadings, findHeadingLine, withImageWidth } from "../../shared/markdownEdit";
import type { TableAlign } from "../../shared/markdownTables";
import { docByName, namedLink, nameFor } from "../../shared/namedLinks";
import { baseName, dirName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { DOC_FOLDERS, toneOf } from "../../shared/projectDocs";
import { resolveReadAssistActiveIndex } from "../../shared/readAssist";
import { lineChanges, type LineChange } from "../../shared/lineDiff";
import { gitStatus, gitVersion } from "../git";
import { backend } from "../backend";
import { choose } from "../dialogs";
import { Icon } from "../Icon";
import { Modal, modalOpen } from "../modal";
import { noteCursor } from "../navigation";
import {
	activeMarkdownTab,
	formatCompactHeaderMeta,
	markdownLinksSummary,
	markdownYamlEditorOpen,
	requestMarkdownInspector,
} from "../panels/markdownBridge";
import { isShown } from "../panels/registry";
import { chooseFromMenu, type RowMenuEntry } from "../panels/RowMenu";
import { searchFor } from "../panels/Search";
import { docs } from "../project";
import { exportDocAs, recordDocApproval } from "../projectDocs";
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
import { cmMarkdownCompletion } from "./cmCompletion";
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
import { applyMarkdownFormatToTextarea, focusLiveWidgetAt, guardRenderedLinks, pressBecomes, type MermaidLightboxInfo } from "./cmLiveShared";
import { copyMermaidAsPng, downloadMermaidBlob, mermaidLivePreviewTheme, renderMermaidSvgForExport } from "./cmMermaid";
import { cmMarkdownHighlight, cmStudioTheme } from "./cmTheme";
import { buildFootnoteHoverPreview, buildHoverPreview, type HoverPreviewData } from "./hoverPreview";
import { hydrateImagesInElement, rehydrateImages } from "./imageResolve";
import { formatCodeFence } from "./languages";
import {
	bumpLiveSelection,
	emitSplitScrollSync,
	onSplitScrollSync,
	registerLiveEditor,
	registerReadFind,
	saveMarkdownSyncAnchor,
	takeMarkdownSyncAnchor,
	unregisterLiveEditor,
	unregisterReadFinder,
	type LiveEditorHandle,
} from "./liveBridge";
import { colourCode } from "./markdownCode";
import { buildHeadingWikiLink, hydrateMathInElement } from "./markdownHtml";
import { extractOutgoingLinks } from "./markdownLinks";
import { mdOutline, setMdOutline } from "./mdOutline";
import { monaco } from "./monaco";

type SavedLiveView = { anchor: number; head: number; scrollTop: number; folds?: [number, number][] };
const SAVED_LIVE_VIEWS_MAX = 80;
const savedLiveViews = new Map<string, SavedLiveView>();

function safeDecodeFragment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

type HoverCardState = HoverPreviewData & {
	x: number;
	y: number;
	maxHeight: number;
	anchorRect: RectBox;
};

type SelectionBubbleState = {
	x: number;
	y: number;
	anchorRect: RectBox;
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
	const [hoverCard, setHoverCard] = createSignal<HoverCardState | null>(null);
	const [selBubble, setSelBubble] = createSignal<SelectionBubbleState | null>(null);
	const [tableHud, setTableHud] = createSignal<ActiveTableHud | null>(null);
	const [lightbox, setLightbox] = createSignal<(ImageLightboxInfo & { zoomFull?: boolean }) | null>(null);
	const [mermaidBox, setMermaidBox] = createSignal<(MermaidLightboxInfo & { scale: number; x: number; y: number }) | null>(null);
	let mermaidPan: { startX: number; startY: number; origX: number; origY: number } | null = null;
	/** Whether the pointer moved since it went down in the diagram viewer: the click that ends a pan follows no link. */
	let mermaidDragged = false;
	const [activeHeadingId, setActiveHeadingId] = createSignal("");

	let hostEl!: HTMLDivElement;
	let pageEl!: HTMLDivElement;
	let cmMountEl!: HTMLDivElement;
	let hoverCardEl: HTMLDivElement | undefined;
	let hoverBodyEl: HTMLDivElement | undefined;
	let selBubbleEl: HTMLDivElement | undefined;
	let pointerSelectingInCm = false;
	let cmView: EditorView | undefined;
	const [mountedView, setMountedView] = createSignal<EditorView | undefined>(undefined);
	const modeCompartment = new Compartment();
	let syncingFromCm = false;
	let syncingFromModel = false;
	let applyingHistory = false;
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

	// --- Lightweight Compact Header Metadata (full inspector lives in Document -> Info) ---
	const front = createMemo(() => frontMatter(text()));
	const yamlSpan = createMemo(() => frontMatterInnerSpan(text()));
	const listed = createMemo(() => docs().find((d) => canonical(d.path) === props.path));
	const ticket = createMemo(() => {
		const file = docs().find((d) => d.group === "tickets" && d.ticket && canonical(d.path) === props.path);
		return file?.ticket ?? "";
	});
	const docStatus = createMemo(() => one(front().values.status) || listed()?.status || "");
	const outgoingLinks = createMemo(() =>
		extractOutgoingLinks(text(), props.path, docs(), {
			root: state.workspace?.root,
			broken: listed()?.broken,
		}),
	);
	const compactLinksCounts = createMemo(() => {
		const summary = markdownLinksSummary();
		if (summary && summary.path === canonical(props.path)) {
			return { total: summary.total, broken: summary.broken };
		}
		const out = outgoingLinks();
		return { total: out.length, broken: out.filter((o) => o.broken).length };
	});
	const compactHeader = createMemo(() =>
		formatCompactHeaderMeta({
			ticket: ticket(),
			status: docStatus(),
			totalLinks: compactLinksCounts().total,
			brokenLinks: compactLinksCounts().broken,
		}),
	);
	const isInfoPanelActive = createMemo(() => isShown("objects") && activeMarkdownTab() === "info");

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
			requestMarkdownInspector("yaml");
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

	createEffect(
		() => ({
			activeGroup: state.activeGroup,
			group: props.group,
			path: props.path,
			active: state.groups[state.activeGroup]?.active,
			list: headings(),
			activeId: activeHeadingId(),
		}),
		({ activeGroup, group, path, active, list, activeId }) => {
			if (activeGroup !== group) return;
			if (active !== path) return;
			setMdOutline({
				path,
				headings: list,
				activeId: activeId || (list[0]?.id ?? ""),
				goTo: goToHeading,
			});
		},
	);
	onCleanup(() => {
		const cur = mdOutline();
		if (state.activeGroup === props.group && cur?.path === props.path && cur.goTo === goToHeading) {
			setMdOutline(null);
		}
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

	const readingHighlightEnabled = () => state.settings.markdownReadingHighlight !== false;

	const findCursorUnitIndex = (content: HTMLElement, units: HTMLElement[]): number | null => {
		if (isRead() || !cmView) return null;
		const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const widgetFocused = Boolean(activeEl && activeEl !== content && content.contains(activeEl));
		if (!cmView.hasFocus && !widgetFocused) return null;

		if (widgetFocused && activeEl) {
			let cur: HTMLElement | null = activeEl;
			while (cur && cur.parentElement !== content) cur = cur.parentElement;
			if (cur) {
				const idx = units.indexOf(cur);
				if (idx >= 0) return idx;
			}
		}

		const sel = cmView.state.selection.main;
		const pos = Math.max(sel.from, sel.to);
		try {
			let node: Node | null = cmView.domAtPos(pos).node;
			let el: HTMLElement | null = node instanceof HTMLElement ? node : node?.parentElement ?? null;
			while (el && el.parentElement !== content) el = el.parentElement;
			if (el) {
				const idx = units.indexOf(el);
				if (idx >= 0) return idx;
			}
		} catch {
			// Fall back to coordinate lookup below.
		}

		const coords = cmView.coordsAtPos(pos);
		if (!coords) return null;
		const cursorY = (coords.top + coords.bottom) / 2;
		let idx = 0;
		for (let i = 0; i < units.length; i++) {
			const r = units[i]!.getBoundingClientRect();
			if (r.top <= cursorY) idx = i;
			else break;
		}
		return idx;
	};

	const applyReadAssist = () => {
		assistFrame = 0;
		if (!readingHighlightEnabled() || !cmMountEl || lightbox()) return clearReadAssist();
		const content = cmMountEl.querySelector<HTMLElement>(".cm-content");
		if (!content) return clearReadAssist();

		const units: HTMLElement[] = [];
		for (const child of content.children) {
			if (!(child instanceof HTMLElement)) continue;
			if (child.classList.contains("cm-md-fm-hidden")) continue;
			if (child.getBoundingClientRect().height === 0) continue;
			units.push(child);
		}
		if (!units.length) return clearReadAssist();

		const cursorIndex = findCursorUnitIndex(content, units);
		let pointerIndex: number | null = null;
		if (pointerY !== null) {
			const contentRect = content.getBoundingClientRect();
			// When hovering Properties, "The work for", or empty top header above the body, keep the body bright.
			if (pointerY >= contentRect.top - 6) {
				let hit = 0;
				for (let i = 0; i < units.length; i++) {
					const r = units[i]!.getBoundingClientRect();
					if (r.top <= pointerY) hit = i;
					else break;
				}
				pointerIndex = hit;
			}
		}

		const active = resolveReadAssistActiveIndex({
			enabled: readingHighlightEnabled(),
			unitCount: units.length,
			cursorIndex,
			pointerIndex,
		});
		if (active === null) return clearReadAssist();

		const nextDimmed = new Set<HTMLElement>();
		// Reconcile directly against each element's real DOM classList because CM6 resets
		// `.cm-line` className whenever line decorations update on selection/viewport changes.
		for (let i = 0; i < units.length; i++) {
			const el = units[i]!;
			if (i > active) {
				if (!el.classList.contains("cm-md-read-below")) el.classList.add("cm-md-read-below");
				nextDimmed.add(el);
			} else if (el.classList.contains("cm-md-read-below")) {
				el.classList.remove("cm-md-read-below");
			}
		}
		for (const el of dimmed) {
			if (!nextDimmed.has(el)) el.classList.remove("cm-md-read-below");
		}
		dimmed = nextDimmed;
	};

	const scheduleReadAssist = () => {
		if (!readingHighlightEnabled()) {
			clearReadAssist();
			return;
		}
		if (!assistFrame) assistFrame = requestAnimationFrame(applyReadAssist);
	};
	createEffect(
		() => ({ read: isRead(), enabled: readingHighlightEnabled() }),
		({ enabled }) => {
			if (!enabled) clearReadAssist();
			else if (!assistFrame) assistFrame = requestAnimationFrame(applyReadAssist);
		},
	);
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
			const hash = safeDecodeFragment(href.slice(href.indexOf("#") + 1));
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
			setState((s) => {
				s.treeVersion += 1;
			});
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
		if (clean)
			void save(props.path).then(() =>
				setState((s) => {
					s.treeVersion += 1;
				}),
			);
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
	let hoverSeq = 0;

	const cancelHover = () => {
		hoverSeq++;
		clearTimeout(hoverTimer);
		clearTimeout(hideTimer);
	};

	const scheduleHideHover = () => {
		hoverSeq++;
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
		const heading = !leads.lines && hashIdx >= 0 ? safeDecodeFragment(target.href.slice(hashIdx + 1)).trim() || undefined : undefined;
		return { path: leads.file, line: leads.lines?.line, heading };
	};

	const clampHoverCard = () => {
		const card = hoverCard();
		if (!card || !hoverCardEl) return;
		const box = hoverCardEl.getBoundingClientRect();
		const width = box.width > 0 ? box.width : Math.min(460, window.innerWidth - 24);
		const height = box.height > 0 ? box.height : 220;
		const placed = placeAnchoredMenu(
			card.anchorRect,
			{ width, height },
			{ width: window.innerWidth, height: window.innerHeight },
			12,
			8,
		);
		const clampedMaxH = Math.min(380, placed.maxHeight);
		hoverCardEl.style.left = `${Math.round(placed.left)}px`;
		hoverCardEl.style.top = `${Math.round(placed.top)}px`;
		hoverCardEl.style.maxHeight = `${Math.round(clampedMaxH)}px`;
	};

	const openMeasuredHoverCard = (preview: HoverPreviewData, rect: DOMRect, basePath: string) => {
		const anchorRect: RectBox = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
		const estW = Math.min(460, Math.max(220, window.innerWidth - 24));
		const placed = placeAnchoredMenu(
			anchorRect,
			{ width: estW, height: 220 },
			{ width: window.innerWidth, height: window.innerHeight },
			12,
			8,
		);
		setHoverCard({
			...preview,
			x: Math.round(placed.left),
			y: Math.round(placed.top),
			maxHeight: Math.min(380, Math.round(placed.maxHeight)),
			anchorRect,
		});
		requestAnimationFrame(() => {
			if (hoverBodyEl) {
				hydrateImagesInElement(hoverBodyEl, basePath);
				hydrateMathInElement(hoverBodyEl);
				void colourCode(hoverBodyEl).then(() => requestAnimationFrame(clampHoverCard));
			}
			clampHoverCard();
		});
	};

	const handleHoverLink = (target: HoverTarget) => {
		clearTimeout(hideTimer);
		clearTimeout(hoverTimer);
		const seq = ++hoverSeq;
		hoverTimer = setTimeout(async () => {
			if (seq !== hoverSeq || !target.anchor.isConnected || !cmView) return;
			const resolved = resolveHoverPath(target);
			if (!resolved) return;
			const preview = await buildHoverPreview(resolved.path, {
				heading: resolved.heading,
				line: resolved.line,
				ticket: resolved.ticket,
			});
			if (!preview || seq !== hoverSeq || !target.anchor.isConnected || !cmView) return;
			const rect = target.anchor.getBoundingClientRect();
			openMeasuredHoverCard(preview, rect, resolved.path);
		}, 320);
	};

	const handleHoverFootnote = (fnId: string, anchor: HTMLElement) => {
		clearTimeout(hideTimer);
		clearTimeout(hoverTimer);
		const seq = ++hoverSeq;
		hoverTimer = setTimeout(() => {
			if (seq !== hoverSeq || !anchor.isConnected || !cmView) return;
			const docText = cmView.state.doc.toString();
			const preview =
				buildFootnoteHoverPreview(docText, props.path, fnId) ?? {
					path: props.path,
					relPath: relativeTo(state.workspace?.root, props.path),
					title: `Footnote [${fnId}]`,
					kind: "markdown" as const,
					html: `<p class="md-hover-empty">No definition found for <code>[^${fnId.replace(/[<>&]/g, "")}]</code>.</p>`,
				};
			const rect = anchor.getBoundingClientRect();
			openMeasuredHoverCard(preview, rect, props.path);
		}, 240);
	};

	// --- Floating Selection Formatting Toolbar (Live mode pointer selection) -
	const clampSelectionBubble = () => {
		const b = selBubble();
		if (!b || !selBubbleEl) return;
		const box = selBubbleEl.getBoundingClientRect();
		const width = box.width > 0 ? box.width : 280;
		const height = box.height > 0 ? box.height : 34;
		const margin = 8;
		const gap = 8;
		const centerLeft = b.anchorRect.left + (b.anchorRect.right - b.anchorRect.left) / 2 - width / 2;
		const left = Math.max(margin, Math.min(centerLeft, window.innerWidth - width - margin));
		const aboveTop = b.anchorRect.top - height - gap;
		const belowTop = b.anchorRect.bottom + gap;
		const top =
			aboveTop >= margin
				? aboveTop
				: belowTop + height <= window.innerHeight - margin
					? belowTop
					: Math.max(margin, Math.min(aboveTop, window.innerHeight - height - margin));
		selBubbleEl.style.left = `${Math.round(left)}px`;
		selBubbleEl.style.top = `${Math.round(top)}px`;
	};

	const updateSelectionBubbleFromPointer = () => {
		if (isRead() || !cmView) {
			setSelBubble(null);
			return;
		}
		const activeEl = document.activeElement;
		if (
			activeEl instanceof HTMLElement &&
			activeEl.closest(".cm-tbl-cell-input, .cm-callout-body-input, .cm-callout-title-input, .cm-md-props-yaml, .cm-md-prop-inline-input")
		) {
			setSelBubble(null);
			return;
		}
		if (cmView.state.selection.ranges.length !== 1) {
			setSelBubble(null);
			return;
		}
		const range = cmView.state.selection.main;
		if (range.empty) {
			setSelBubble(null);
			return;
		}
		const selected = cmView.state.sliceDoc(range.from, range.to);
		if (!selected.trim()) {
			setSelBubble(null);
			return;
		}
		const docText = cmView.state.doc.toString();
		const fm = frontMatter(docText);
		const fmEnd = fm.lines > 0 && fm.lines <= cmView.state.doc.lines ? cmView.state.doc.line(fm.lines).to : -1;
		if (range.from <= fmEnd) {
			setSelBubble(null);
			return;
		}
		if (fenced(docText).some(([a, b]) => range.from < b && range.to > a)) {
			setSelBubble(null);
			return;
		}

		const cFrom = cmView.coordsAtPos(range.from);
		const cTo = cmView.coordsAtPos(range.to);
		let anchorRect: RectBox | null = null;
		if (cFrom && cTo) {
			anchorRect = {
				left: Math.min(cFrom.left, cTo.left),
				right: Math.max(cFrom.right, cTo.right),
				top: Math.min(cFrom.top, cTo.top),
				bottom: Math.max(cFrom.bottom, cTo.bottom),
			};
		} else {
			const domSel = window.getSelection();
			if (domSel && domSel.rangeCount > 0) {
				const r = domSel.getRangeAt(0).getBoundingClientRect();
				if (r.width > 0 || r.height > 0) {
					anchorRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
				}
			}
		}
		if (!anchorRect) {
			setSelBubble(null);
			return;
		}
		const estW = 290;
		const estH = 34;
		const placed = placeAnchoredMenu(
			anchorRect,
			{ width: estW, height: estH },
			{ width: window.innerWidth, height: window.innerHeight },
			8,
			8,
		);
		const preferAbove = anchorRect.top - estH - 8 >= 8 ? anchorRect.top - estH - 8 : placed.top;
		setSelBubble({
			x: Math.round(placed.left),
			y: Math.round(preferAbove),
			anchorRect,
		});
		requestAnimationFrame(clampSelectionBubble);
	};

	const wrapSelectionAsWikilink = () => {
		if (!cmView || isRead()) return;
		const r = cmView.state.selection.main;
		if (r.empty) return;
		const raw = cmView.state.sliceDoc(r.from, r.to);
		const trimmed = raw.trim();
		if (!trimmed) return;
		const already = /^\[\[([\s\S]+)\]\]$/.exec(trimmed);
		const insert = already ? already[1]! : `[[${trimmed}]]`;
		cmView.dispatch({
			changes: { from: r.from, to: r.to, insert },
			selection: EditorSelection.range(r.from, r.from + insert.length),
			scrollIntoView: true,
			userEvent: "input.format",
		});
		setSelBubble(null);
		cmView.focus();
	};

	const wrapSelectionAsCallout = () => {
		if (!cmView || isRead()) return;
		const r = cmView.state.selection.main;
		if (r.empty) return;
		const raw = cmView.state.sliceDoc(r.from, r.to);
		const built = buildCalloutBlock("note", undefined, raw);
		const startLn = cmView.state.doc.lineAt(r.from);
		const lead = r.from > startLn.from && cmView.state.sliceDoc(startLn.from, r.from).trim() ? "\n\n" : "";
		const insert = `${lead}${built.insert}`;
		const pos = r.from + lead.length + built.cursorOffset;
		cmView.dispatch({
			changes: { from: r.from, to: r.to, insert },
			selection: EditorSelection.cursor(pos),
			scrollIntoView: true,
			userEvent: "input.callout",
		});
		setSelBubble(null);
		cmView.focus();
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
		setSelBubble(null);
		e.preventDefault();
		if (!cmView) return;

		const linkEl = target?.closest<HTMLElement>("[data-md-href], [data-md-wiki], [data-md-ticket], .cm-md-table-wrap a[href], .cm-md-callout a[href]") ?? null;
		const inFolder = Boolean(state.workspace && isInside(state.workspace.root, props.path));
		const box = hostEl.getBoundingClientRect();
		const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + 24, y: box.top + 24 };

		if (isRead()) {
			const selection = window.getSelection();
			const words = selection && !selection.isCollapsed && hostEl.contains(selection.anchorNode) ? selection.toString() : "";
			const headingEl = target?.closest<HTMLElement>("[data-md-heading-line]") ?? null;
			const clickedHeadingLine = headingEl ? Number(headingEl.dataset.mdHeadingLine) : null;
			const headingList = headings();
			const targetHeading =
				(clickedHeadingLine ? headingList.find((h) => h.line === clickedHeadingLine) : null) ??
				headingList.find((h) => h.id === activeHeadingId()) ??
				headingList[0] ??
				null;
			const COPY = "Copy";
			const OPEN = "Open link";
			const COPY_LINK = "Copy link";
			const COPY_HEADING_LINK = "Copy link to heading";
			const FIND_DOC = "Find in document";
			const PRINT_PDF = "Print / Save as PDF…";
			const EDIT = "Edit in Live view";
			const TO_SOURCE = "Switch to Source view";
			const PATH = "Copy path";
			const RELATIVE = "Copy path in the project";
			const NAME = "Copy file name";
			const SHOW = "Show in the Explorer";
			const items: RowMenuEntry[] = [
				...(words.trim() ? [{ label: COPY, value: COPY, keys: "Ctrl+C" }] : []),
				...(linkEl ? [OPEN, COPY_LINK] : []),
				...(targetHeading ? [COPY_HEADING_LINK] : []),
				"separator",
				{ label: FIND_DOC, value: FIND_DOC, keys: "Ctrl+F" },
				PRINT_PDF,
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
			} else if (picked === COPY_HEADING_LINK && targetHeading) {
				const me = listed();
				const docName = (me ? nameFor(me, docs(), state.workspace?.root) : null) ?? baseName(props.path).replace(/\.(md|markdown)$/i, "");
				const wiki = buildHeadingWikiLink(docName, targetHeading.text);
				await copyText(wiki, `Copied ${wiki}.`);
			} else if (picked === FIND_DOC && cmView) {
				openSearchPanel(cmView);
			} else if (picked === PRINT_PDF) {
				void exportDocAs(props.path, "print");
			} else if (picked === EDIT) {
				setMarkdownMode(props.path, "live", props.group);
				setState((s) => {
					s.activeGroup = props.group;
				});
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
		const EDIT_YAML = yamlSpan() ? "Edit YAML properties…" : "YAML properties…";
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
		const RECORD_APPROVAL = "Record Approval / Bump Version…";
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
					{ label: CHECKBOX, value: CHECKBOX, keys: "Alt+C" },
				],
			},
			{
				label: "Insert",
				children: [
					INSERT_TEMPLATE,
					INSERT_CALLOUT,
					INSERT_TABLE,
					INSERT_IMAGE,
					"separator",
					RECORD_APPROVAL,
					EDIT_YAML,
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
				setState((s) => {
					s.treeVersion += 1;
				});
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
		} else if (picked === EDIT_YAML) {
			if (!yamlSpan() && model) {
				const eol = model.getEOL();
				const stem = baseName(props.path).replace(/\.(md|markdown)$/i, "");
				const starter = `---${eol}title: ${quoteYamlScalar(stem)}${eol}---${eol}${eol}`;
				model.pushStackElement();
				model.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: starter, forceMoveMarkers: true }], () => null);
				model.pushStackElement();
			}
			requestMarkdownInspector("yaml");
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
		else if (picked === RECORD_APPROVAL) void recordDocApproval(props.path);
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
	let lastSyncPos = -1;
	const resetSyncCoalesce = () => {
		lastSyncKind = "";
		lastSyncAt = 0;
		lastSyncPos = -1;
	};
	const pushTransactionToModel = (tr: Transaction) => {
		if (!model || !tr.docChanged || syncingFromModel) return;
		const startDoc = tr.startState.doc;
		const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
		let firstFromA = -1;
		let firstToA = -1;
		let firstInsertLen = 0;
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			const sLine = startDoc.lineAt(fromA);
			const eLine = startDoc.lineAt(toA);
			const insertedText = inserted.toString();
			if (edits.length === 0) {
				firstFromA = fromA;
				firstToA = toA;
				firstInsertLen = insertedText.length;
			}
			edits.push({
				range: new monaco.Range(sLine.number, fromA - sLine.from + 1, eLine.number, toA - eLine.from + 1),
				text: insertedText,
				forceMoveMarkers: true,
			});
		});
		if (!edits.length) return;
		const now = Date.now();
		const kind = tr.isUserEvent("input.type") ? "type" : tr.isUserEvent("delete.backward") ? "del" : "other";
		const contiguous =
			edits.length === 1 &&
			((kind === "type" && firstFromA === lastSyncPos && firstToA === firstFromA) ||
				(kind === "del" && firstToA === lastSyncPos && firstInsertLen === 0));
		const coalesce = (kind === "type" || kind === "del") && kind === lastSyncKind && contiguous && now - lastSyncAt < 450;
		lastSyncKind = kind;
		lastSyncAt = now;
		lastSyncPos = edits.length === 1 ? firstFromA + firstInsertLen : -1;
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
		// The keyboard being here counts too: on a click into the other group the store's `activeGroup` still reads
		// as the old group in this task (it changes at the next flush), and that click was not remembered as a place.
		if (state.activeGroup === props.group || view.hasFocus) {
			setState((s) => {
				s.cursor = { line: lineNumber, column };
			});
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
		const key = `${props.group}:${props.path}`;
		savedLiveViews.delete(key);
		savedLiveViews.set(key, {
			anchor: main.anchor,
			head: main.head,
			scrollTop: hostEl?.scrollTop ?? 0,
			folds,
		});
		while (savedLiveViews.size > SAVED_LIVE_VIEWS_MAX) {
			const oldest = savedLiveViews.keys().next().value;
			if (oldest === undefined) break;
			savedLiveViews.delete(oldest);
		}
	};

	const applyReveal = () => {
		if (state.activeGroup !== props.group) return;
		const r = takeReveal(props.path);
		if (!r) return;
		jumpToLine(r.line, r.column ?? 1, r.endLine, r.endColumn);
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
	onSettled(() => {
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
				EditorState.allowMultipleSelections.of(true),
				modeCompartment.of(modeExtensions(isRead())),
				...(model
					? [
							historyFallbackFacet.of({
								undo: () => {
									if (isRead()) return false;
									resetSyncCoalesce();
									const before = model.getValue();
									applyingHistory = true;
									try {
										model.undo();
									} finally {
										applyingHistory = false;
									}
									return model.getValue() !== before;
								},
								redo: () => {
									if (isRead()) return false;
									resetSyncCoalesce();
									const before = model.getValue();
									applyingHistory = true;
									try {
										model.redo();
									} finally {
										applyingHistory = false;
									}
									return model.getValue() !== before;
								},
							}),
						]
					: [history()]),
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
							setState((s) => {
								s.treeVersion += 1;
							});
							notify(`Saved snippet to ${relativeTo(state.workspace.root, dest)}.`);
						} catch (e: any) {
							notify(`Could not save snippet: ${e?.message ?? e}`, "error");
						}
					},
					onFormatCode: (openLine) => formatCodeBlockAt(openLine),
					onToggleCheckbox: toggleCheckboxAt,
					onOpenImageLightbox: (info) => {
						setSelBubble(null);
						setHoverCard(null);
						setLightbox({ ...info, zoomFull: false });
					},
					onOpenMermaidLightbox: (info) => {
						setSelBubble(null);
						setHoverCard(null);
						mermaidPan = null;
						setMermaidBox({ ...info, scale: 1, x: 0, y: 0 });
					},
					onResizeImage: resizeImageAt,
					isYamlEditorOpen: () => markdownYamlEditorOpen(),
				}),
				liveBlockField,
				liveInlinePlugin,
				liveCodeHighlightPlugin,
				mermaidLivePreviewTheme,
				liveInteractionExtension,
				markdownFoldService,
				cmMarkdownCompletion(() => props.path),
				cmAutoWrapExtension,
				cmSmartPasteExtension(() => props.path),
				cmMarkdownKeymap,
				EditorView.domEventHandlers({
					focus: (_e, view) => {
						setState((s) => {
							s.activeGroup = props.group;
						});
						// Re-evaluate transclusions when returning focus after editing an embedded doc in another tab/split.
						if (view.state.doc.toString().includes("![[")) {
							view.dispatch({ effects: refreshLiveEffect.of(++refreshSeq) });
						}
					},
				}),
				EditorView.updateListener.of((update) => {
					for (const tr of update.transactions) {
						if (tr.docChanged) pushTransactionToModel(tr);
					}
					if (update.selectionSet) bumpLiveSelection();
					if (update.docChanged || (update.selectionSet && update.state.selection.main.empty)) {
						setSelBubble(null);
					}
					if (update.selectionSet || update.focusChanged || update.docChanged || update.viewportChanged || update.geometryChanged) {
						if (update.selectionSet || update.focusChanged || update.docChanged) {
							const userMoved = update.transactions.some((tr) => tr.isUserEvent("select") || tr.isUserEvent("input") || tr.isUserEvent("delete"));
							syncCursorState(update.view, userMoved);
							queueMicrotask(() => updateTableHud(update.view));
						}
						scheduleReadAssist();
					}
					if (update.docChanged) {
						queueMicrotask(() => {
							updateOutlineScrollspy();
						});
					}
				}),
			],
		});

		cmView = new EditorView({ state: editorState, parent: cmMountEl });
		setMountedView(cmView);

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

		// Reflect external Monaco model edits (Undo/Redo, Revert, Status menu, Rename links, Search & Replace, Read-mode checkbox ticks) back into CM6.
		const modelSub = model?.onDidChangeContent(() => {
			if (syncingFromCm || !cmView) return;
			resetSyncCoalesce();
			const next = model.getValue().replace(/\r\n/g, "\n");
			setText(model.getValue());
			const cur = cmView.state.doc.toString();
			if (next === cur) return;
			let start = 0;
			const minLen = Math.min(cur.length, next.length);
			while (start < minLen && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
			let curEnd = cur.length;
			let nextEnd = next.length;
			while (curEnd > start && nextEnd > start && cur.charCodeAt(curEnd - 1) === next.charCodeAt(nextEnd - 1)) {
				curEnd--;
				nextEnd--;
			}
			syncingFromModel = true;
			try {
				const main = cmView.state.selection.main;
				cmView.dispatch({
					changes: { from: start, to: curEnd, insert: next.slice(start, nextEnd) },
					selection: applyingHistory
						? EditorSelection.cursor(nextEnd)
						: EditorSelection.range(Math.min(main.anchor, next.length), Math.min(main.head, next.length)),
					scrollIntoView: applyingHistory,
					annotations: [externalSyncAnnotation.of(true), Transaction.addToHistory.of(false)],
				});
			} finally {
				syncingFromModel = false;
			}
		});

		const stopReveal = revealSignal.listen((path) => {
			if (path === props.path && state.activeGroup === props.group) applyReveal();
		});

		const onKeyDownGlobal = (e: KeyboardEvent) => {
			if (modalOpen()) return;
			if (e.key === "Escape" && selBubble()) {
				setSelBubble(null);
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
		const onMouseUpGlobal = () => {
			if (!pointerSelectingInCm) return;
			pointerSelectingInCm = false;
			requestAnimationFrame(updateSelectionBubbleFromPointer);
		};
		window.addEventListener("keydown", onKeyDownGlobal);
		window.addEventListener("mouseup", onMouseUpGlobal);
		// No click in the rendered document may take the window away; a link no card follows itself (one in a diagram) is followed here.
		const stopLinkGuard = guardRenderedLinks(hostEl, (href) => void followLink(href));

		syncCursorState(cmView, false);
		applyReveal();
		if (!isRead() && state.activeGroup === props.group && !openedForALook(props.path)) {
			queueMicrotask(() => cmView?.focus());
		}

		return () => {
			cancelHover();
			if (scrollSyncRaf) {
				cancelAnimationFrame(scrollSyncRaf);
				scrollSyncRaf = 0;
			}
			saveSyncAnchor();
			saveView();
			stopSplitSync();
			window.removeEventListener("keydown", onKeyDownGlobal);
			window.removeEventListener("mouseup", onMouseUpGlobal);
			stopLinkGuard();
			setMountedView(undefined);
			modelSub?.dispose();
			stopReveal();
			cmView?.destroy();
			cmView = undefined;
		};
	});

	// Single authoritative liveBridge registration for this pane, identity-checked on cleanup across split/mode changes.
	createEffect(
		() => ({ view: mountedView(), at: props.group, read: isRead() }),
		({ view, at, read }) => {
			if (!view) return;
			if (read) {
				const opener = () => {
					if (cmView) openSearchPanel(cmView);
				};
				registerReadFind(at, opener);
				return () => unregisterReadFinder(at, opener);
			}
			const handle = makeHandle(view);
			registerLiveEditor(at, handle);
			return () => unregisterLiveEditor(at, handle);
		},
	);

	// Seamlessly switch between Live and Read modes on the SAME CM6 instance with zero flash or scroll jump!
	createEffect(
		() => isRead(),
		(read) => {
			if (!cmView) return;
			if (read) {
				setSelBubble(null);
			}
			untrack(() =>
				cmView!.dispatch({
					effects: [
						modeCompartment.reconfigure(modeExtensions(read)),
						...(read ? [setRawEditBlockEffect.of(null)] : []),
						refreshLiveEffect.of(++refreshSeq),
					],
				}),
			);
			if (read) {
				setTableHud(null);
			} else {
				queueMicrotask(() => updateTableHud(cmView));
			}
			queueMicrotask(() => {
				updateOutlineScrollspy();
				if (pointerY !== null) scheduleReadAssist();
			});
		},
		{ defer: true },
	);

	// Refresh Live/Read decorations whenever workspace docs, tree version, or broken-link status updates.
	createEffect(
		() => [docs(), state.treeVersion] as const,
		() => {
			if (cmView) untrack(() => cmView!.dispatch({ effects: refreshLiveEffect.of(++refreshSeq) }));
			// A picture inside a card is not a decoration of its own: the refresh above does not draw its card again.
			untrack(() => rehydrateImages());
		},
		{ defer: true },
	);

	// Keep CM6 Git gutter marks synced with `backend.gitBase` and live document edits.
	let gitBaseLines: string[] | null = null;
	let gitDrawTimer: ReturnType<typeof setTimeout> | undefined;
	const redrawGitMarks = () => {
		if (!cmView) return;
		untrack(() => {
			if (!gitBaseLines) {
				cmView!.dispatch({ effects: setGitChangesEffect.of([]) });
				return;
			}
			const changes = lineChanges(gitBaseLines, cmView!.state.doc.toString().split(/\r?\n/));
			cmView!.dispatch({ effects: setGitChangesEffect.of(changes) });
		});
	};
	const hasGitRepo = createMemo(() => Boolean(gitStatus()));
	createEffect(
		() => [props.path, gitVersion(), hasGitRepo()] as const,
		([path, , repo]) => {
			if (!repo || !path || path.startsWith("untitled:")) {
				gitBaseLines = null;
				redrawGitMarks();
				return;
			}
			let stale = false;
			backend.gitBase(path, "index").then(
				(baseText) => {
					if (stale) return;
					gitBaseLines = baseText === null ? null : baseText.split(/\r?\n/);
					redrawGitMarks();
				},
				() => {},
			);
			return () => {
				stale = true;
			};
		},
	);
	createEffect(
		() => text(),
		() => {
			if (!gitBaseLines) return;
			clearTimeout(gitDrawTimer);
			gitDrawTimer = setTimeout(redrawGitMarks, 300);
		},
		{ defer: true },
	);
	onCleanup(() => clearTimeout(gitDrawTimer));

	// Re-tokenize fenced code blocks and callout snippets whenever the active theme changes.
	createEffect(
		() => themeVersion(),
		() => {
			if (cmView) untrack(() => cmView!.dispatch({ effects: refreshLiveEffect.of(++refreshSeq) }));
		},
		{ defer: true },
	);

	return (
		<div
			ref={hostEl}
			class={["cm-md-host", { "cm-md-read": isRead(), "cm-md-live": !isRead() }]}
			tabindex={isRead() ? 0 : undefined}
			aria-label={`${baseName(props.path)}, ${isRead() ? "rendered" : "live preview"}`}
			aria-haspopup="menu"
			onScroll={() => {
				setSelBubble(null);
				updateOutlineScrollspy();
				scheduleReadAssist();
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
							setState((s) => {
								s.cursor = { line: topLine, column: 1 };
							});
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
				scheduleReadAssist();
			}}
			onFocusIn={() => scheduleReadAssist()}
			onFocusOut={() => queueMicrotask(scheduleReadAssist)}
			onContextMenu={(e) => void onContextMenu(e)}
			onKeyDown={(e) => {
				if (isRead() && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f" && cmView) {
					e.preventDefault();
					openSearchPanel(cmView);
				}
			}}
			onMouseDown={(e) => {
				setState((s) => {
					s.activeGroup = props.group;
				});
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
								<button type="button" class={{ active: hud().align === "left" }} title="Align column left" onClick={() => runTableToolbarAction("md-table-align-left")}>
									L
								</button>
								<button type="button" class={{ active: hud().align === "center" }} title="Align column center" onClick={() => runTableToolbarAction("md-table-align-center")}>
									C
								</button>
								<button type="button" class={{ active: hud().align === "right" }} title="Align column right" onClick={() => runTableToolbarAction("md-table-align-right")}>
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
				{/* Whisper-quiet content-first top strip: ticket/status badge on the left, Info & Links triggers on the right. */}
				<div class="cm-md-compact-bar" aria-label="Document metadata and actions">
					<Show when={compactHeader().hasLeftMeta}>
						<button
							type="button"
							class="cm-md-compact-meta"
							title="Open Document Info panel (Properties, Work, Readiness & Links)"
							onClick={() => requestMarkdownInspector("properties")}
						>
							<Show when={compactHeader().ticketLabel}>
								<span class="cm-md-compact-key">{compactHeader().ticketLabel}</span>
							</Show>
							<Show when={compactHeader().statusLabel}>
								<span class={`doc-status tone-${toneOf(compactHeader().statusLabel)}`}>{compactHeader().statusLabel}</span>
							</Show>
						</button>
					</Show>
					<div class="cm-md-compact-actions">
						<button
							type="button"
							class={["cm-md-compact-btn", { active: isInfoPanelActive() }]}
							title="Open Document Info panel (Properties, Work, Export & Links)"
							onClick={() => requestMarkdownInspector()}
						>
							<Icon name="info" />
							<span>Info</span>
						</button>
						<button
							type="button"
							class="cm-md-compact-btn"
							title={compactHeader().linksTitle}
							onClick={() => requestMarkdownInspector("links")}
						>
							<Icon name="references" />
							<span>{compactHeader().linksLabel}</span>
							<Show when={compactHeader().brokenCount > 0}>
								<span class="cm-md-compact-broken">
									<Icon name="warning" />
									<span>{compactHeader().brokenCount}</span>
								</span>
							</Show>
						</button>
					</div>
				</div>

				{/* Unified CodeMirror 6 surface (powers both Live Preview and Read mode). */}
				<div
					ref={cmMountEl}
					class="cm-md-editor-wrap"
					onMouseDown={(e) => {
						if (e.button === 0 && !isRead()) pointerSelectingInCm = true;
						setSelBubble(null);
					}}
					onMouseOver={(e) => {
						const fnEl = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>("[data-md-footnote]");
						if (fnEl?.dataset.mdFootnote) handleHoverFootnote(fnEl.dataset.mdFootnote, fnEl);
					}}
					onMouseOut={(e) => {
						const fnEl = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>("[data-md-footnote]");
						if (fnEl) scheduleHideHover();
					}}
				/>

			</div>

			{/* Floating Selection Formatting Toolbar in Live Mode (pointer-selected prose outside code blocks/frontmatter). */}
			<Show when={!isRead() && selBubble()}>
				{(bubble) => (
					<Portal>
						<div
							ref={selBubbleEl}
							class="cm-md-sel-bubble"
							role="toolbar"
							aria-label="Selection formatting"
							style={{ left: `${bubble().x}px`, top: `${bubble().y}px` }}
							onMouseDown={(e) => e.preventDefault()}
						>
							<button
								type="button"
								class="cm-md-sel-btn cm-md-sel-bold"
								title="Bold (Ctrl+B)"
								onClick={() => {
									if (cmView) runCmAction(cmView, "md-bold");
									setSelBubble(null);
								}}
							>
								B
							</button>
							<button
								type="button"
								class="cm-md-sel-btn cm-md-sel-italic"
								title="Italic (Ctrl+I)"
								onClick={() => {
									if (cmView) runCmAction(cmView, "md-italic");
									setSelBubble(null);
								}}
							>
								I
							</button>
							<button
								type="button"
								class="cm-md-sel-btn cm-md-sel-code"
								title="Inline code (Ctrl+`)"
								onClick={() => {
									if (cmView) runCmAction(cmView, "md-code");
									setSelBubble(null);
								}}
							>
								Code
							</button>
							<button
								type="button"
								class="cm-md-sel-btn cm-md-sel-hl"
								title="Highlight ==text== (Ctrl+Alt+H)"
								onClick={() => {
									if (cmView) runCmAction(cmView, "md-highlight");
									setSelBubble(null);
								}}
							>
								==
							</button>
							<span class="cm-md-sel-sep" aria-hidden="true" />
							<button
								type="button"
								class="cm-md-sel-btn"
								title="Insert Markdown link (Ctrl+K)"
								aria-label="Insert Markdown link"
								onClick={() => {
									if (cmView) runCmAction(cmView, "md-link");
									setSelBubble(null);
								}}
							>
								<Icon name="references" />
								<span>Link</span>
							</button>
							<button
								type="button"
								class="cm-md-sel-btn"
								title="Wrap as [[wikilink]]"
								onClick={wrapSelectionAsWikilink}
							>
								[[ ]]
							</button>
							<button
								type="button"
								class="cm-md-sel-btn"
								title="Wrap selection in callout"
								aria-label="Wrap in callout"
								onClick={wrapSelectionAsCallout}
							>
								<Icon name="quote" />
								<span>Callout</span>
							</button>
						</div>
					</Portal>
				)}
			</Show>

			{/* Obsidian-style Hover Page Preview popover (portaled to body so container-type: inline-size never offsets/clips fixed positioning). */}
			<Show when={hoverCard()}>
				{(card) => (
					<Portal>
						<div
							ref={hoverCardEl}
							class="md-hover-card"
							style={{ left: `${card().x}px`, top: `${card().y}px`, "max-height": `${card().maxHeight}px` }}
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
										if (canonical(target.path) === canonical(props.path) && target.line) {
											scrollToLine(target.line, !isRead());
											return;
										}
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
								ref={(el: HTMLDivElement) => {
									hoverBodyEl = el;
									// The card stands outside the editor's host, so it carries the guard itself; its own click handler below follows the link.
									guardRenderedLinks(el);
								}}
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
										const h = safeDecodeFragment(href.slice(href.indexOf("#") + 1));
										if (h) return void followHeadingInFile(leads.file, h);
									}
									void openFile(leads.file, leads.lines ? { reveal: leads.lines } : {});
								}}
							/>
						</div>
					</Portal>
				)}
			</Show>

			{/* Image Lightbox Modal (hosted inside <Modal> for inert isolation, focus trap, Esc close, and z-index: 80 stacking). */}
			<Show when={lightbox()}>
				{(box) => (
					<Modal
						class="md-lightbox-modal"
						label={`Image preview: ${box().alt || "image"}`}
						onClose={() => setLightbox(null)}
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
							<button type="button" class="md-lightbox-btn" data-autofocus title="Close preview (Esc)" aria-label="Close image preview" onClick={() => setLightbox(null)}>
								<Icon name="close" />
							</button>
						</div>
						<div class={["md-lightbox-stage", { "is-full": Boolean(box().zoomFull) }]} onClick={(e) => e.target === e.currentTarget && setLightbox(null)}>
							<img src={box().src} alt={box().alt} />
						</div>
					</Modal>
				)}
			</Show>
			{/* Mermaid Zoom / Pan Diagram Lightbox Modal (hosted inside <Modal> for inert isolation, focus trap, and custom zoom/pan keys). */}
			<Show when={mermaidBox()}>
				{(box) => (
					<Modal
						class="md-lightbox-modal"
						label="Mermaid diagram zoom viewer"
						onClose={() => {
							mermaidPan = null;
							setMermaidBox(null);
						}}
						onKey={(e) => {
							if (e.ctrlKey || e.metaKey || e.altKey) return false;
							if (e.key === "+" || e.key === "=") {
								e.preventDefault();
								setMermaidBox((c) => (c ? { ...c, scale: Math.min(4, +(c.scale + 0.25).toFixed(2)) } : null));
								return true;
							}
							if (e.key === "-" || e.key === "_") {
								e.preventDefault();
								setMermaidBox((c) => (c ? { ...c, scale: Math.max(0.25, +(c.scale - 0.25).toFixed(2)) } : null));
								return true;
							}
							if (e.key === "0") {
								e.preventDefault();
								setMermaidBox((c) => (c ? { ...c, scale: 1, x: 0, y: 0 } : null));
								return true;
							}
							if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
								e.preventDefault();
								const step = e.shiftKey ? 120 : 48;
								const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
								const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
								setMermaidBox((c) => (c ? { ...c, x: c.x + dx, y: c.y + dy } : null));
								return true;
							}
							return false;
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
							<button
								type="button"
								class="md-lightbox-btn"
								data-autofocus
								title="Close preview (Esc)"
								aria-label="Close diagram preview"
								onClick={() => {
									mermaidPan = null;
									setMermaidBox(null);
								}}
							>
								<Icon name="close" />
							</button>
						</div>
						<div
							class="md-lightbox-stage md-mermaid-lightbox-stage"
							ref={(el: HTMLDivElement) => {
								// A flowchart's `click A href "…"` is a live link in the drawing, and the viewer is outside the editor's host:
								// a click on it took the window to the address. Here it closes the viewer and opens as the editor's links do,
								// unless the click is the end of a drag that panned the drawing.
								guardRenderedLinks(el, (href) => {
									const panned = mermaidDragged;
									mermaidDragged = false;
									if (panned) return;
									mermaidPan = null;
									setMermaidBox(null);
									void followLink(href);
								});
							}}
							onWheel={(e) => {
								e.preventDefault();
								const delta = e.deltaY < 0 ? 0.15 : -0.15;
								setMermaidBox((c) => (c ? { ...c, scale: Math.max(0.25, Math.min(4, +(c.scale + delta).toFixed(2))) } : null));
							}}
							onPointerDown={(e) => {
								if (e.button !== 0) return;
								const cur = mermaidBox();
								if (!cur) return;
								// The pointer is not taken hold of yet (see pressBecomes): let go where it went down, this is a click,
								// and it has to reach the link it is on.
								mermaidPan = { startX: e.clientX, startY: e.clientY, origX: cur.x, origY: cur.y };
								mermaidDragged = false;
							}}
							onPointerMove={(e) => {
								if (!mermaidPan) return;
								const dx = e.clientX - mermaidPan.startX;
								const dy = e.clientY - mermaidPan.startY;
								const became = pressBecomes(dx, dy, e.buttons);
								if (became === "released") {
									mermaidPan = null;
									return;
								}
								if (became === "pan" && !mermaidDragged) {
									mermaidDragged = true;
									// A drag from here on: held, it goes on when the pointer leaves the stage, and its end is no click on a link.
									(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
								}
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
					</Modal>
				)}
			</Show>
		</div>
	);
}
