// Obsidian-grade Live Preview extensions for CodeMirror 6 (ADR 0028):
// - StateField (`liveBlockField`): multi-line block decorations (collapsed YAML frontmatter,
//   rendered GFM tables, Obsidian callouts, horizontal rules, standalone inline images).
// - ViewPlugin (`liveInlinePlugin`): viewport-scoped token-level reveal for headings, bold,
//   italic, strikethrough, inline code, ==highlight==, #tags, links, [[wikilinks]], ticket
//   mentions, fenced code headers, bullets, clickable task checkboxes, and blockquotes.
// - FoldService (`markdownFoldService`): heading section & nested list folding.
import { foldGutter, foldService, syntaxTree } from "@codemirror/language";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { EditorSelection, EditorState, StateField, Transaction, type ChangeSpec, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { fenced } from "../../shared/catalog";
import { isFenceClose, normalizeFenceLang, parseFenceOpen, stripQuotePrefix } from "../../shared/codeTokens";
import { fenceAtLine, fenceFormatTarget } from "../../shared/fencedFormat";
import { hrefWritten, linkFile, linkLeads } from "../../shared/docLinks";
import { headingAnchor } from "../../shared/docTables";
import { frontMatter } from "../../shared/frontMatter";
import { closedHtmlCommentSpans, commentBlockHideLines, isStandaloneHtmlComment } from "../../shared/htmlComments";
import { lineSegments, parseCalloutHeader, parseImageExpression, type ParsedImageSpec } from "../../shared/markdownEdit";
import { parseMarkdownTable, parseTableRaw } from "../../shared/markdownTables";
import { docByName, namedLink, nameFor } from "../../shared/namedLinks";
import { baseName, dirName, isInside, relativeTo, resolvePath } from "../../shared/paths";
import { isLikelyHexColorTag } from "../../shared/tags";
import { ticketMatcher } from "../../shared/ticketRefs";
import { docs } from "../project";
import { noteCursor } from "../navigation";
import { canonical, documents, notify, openFile, state as appState } from "../state";
import { currentThemeVersion } from "../themes/themes";
import { CalloutWidget } from "./cmLiveCallout";
import { MermaidLivePreviewWidget, MermaidWidget } from "./cmMermaid";
import { buildHoverPreview } from "./hoverPreview";
import { colourCode } from "./markdownCode";
import {
	buildHeadingWikiLink,
	deduplicatedHeadingAnchorsByLine,
	findInlineMathSpans,
	hydrateMathInElement,
	renderKatexHtml,
	renderKatexSync,
} from "./markdownHtml";
import { hydrateImagesInElement } from "./imageResolve";
import {
	liveCallbacksFacet,
	rawEditBlockField,
	readOnlyModeFacet,
	refreshLiveEffect,
	renderInlineHtml,
	searchStateSig,
	setRawEditBlockEffect,
	type HoverTarget,
	type ImageLightboxInfo,
	type LiveCallbacks,
} from "./cmLiveShared";
import { TableWidget } from "./cmLiveTable";
import { parseListLine } from "../../shared/listIndent";
import { IMAGE_FILE_RE, loadImageUrl } from "./imageResolve";

export {
	liveCallbacksFacet,
	rawEditBlockField,
	readOnlyModeFacet,
	refreshLiveEffect,
	setRawEditBlockEffect,
	type HoverTarget,
	type ImageLightboxInfo,
	type LiveCallbacks,
};

const QUOTE_RE = /^([ \t]*>[ \t]?)/;

/** True when in Live mode and any selection cursor or range touches `[from, to]`. Always false in Read mode. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
	if (state.facet(readOnlyModeFacet)) return false;
	for (const r of state.selection.ranges) {
		if (r.from <= to && r.to >= from) return true;
	}
	return false;
}

/** True when the user explicitly clicked `Raw` on a table or callout overlapping `[from, to]`. */
function isRawEditing(state: EditorState, from: number, to: number): boolean {
	if (state.facet(readOnlyModeFacet)) return false;
	const raw = state.field(rawEditBlockField, false);
	return Boolean(raw && from <= raw.to && to >= raw.from);
}

/** True when the CM6 search panel is open and its query matches text inside `[from, to]`. */
function searchMatchesBlock(state: EditorState, from: number, to: number): boolean {
	try {
		if (!searchPanelOpen(state)) return false;
		const q = getSearchQuery(state);
		if (!q.search) return false;
		const slice = state.sliceDoc(from, to);
		if (q.regexp) {
			try {
				return new RegExp(q.search, q.caseSensitive ? "" : "i").test(slice);
			} catch {
				return false;
			}
		}
		if (q.wholeWord) {
			const esc = q.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`\\b${esc}\\b`, q.caseSensitive ? "" : "i").test(slice);
		}
		return q.caseSensitive ? slice.includes(q.search) : slice.toLowerCase().includes(q.search.toLowerCase());
	} catch {
		return false;
	}
}

/** Tables stay interactive widgets in Live mode unless explicitly in `Raw` mode, searched, or mid-typing a 2-line delimiter row. */
function tableShouldStayRaw(state: EditorState, from: number, to: number, startLine: number, endLine: number): boolean {
	if (searchMatchesBlock(state, from, to)) return true;
	if (state.facet(readOnlyModeFacet)) return false;
	if (isRawEditing(state, from, to)) return true;
	if (endLine === startLine + 1 && endLine <= state.doc.lines) {
		const delim = state.doc.line(endLine);
		if (selectionTouches(state, delim.from, delim.to)) return true;
	}
	return false;
}

/** Callouts stay interactive cards in Live mode unless explicitly in `Raw` mode, searched, or mid-typing a 1-line `> [!` header. */
function calloutShouldStayRaw(state: EditorState, from: number, to: number, startLine: number, endLine: number): boolean {
	if (searchMatchesBlock(state, from, to)) return true;
	if (state.facet(readOnlyModeFacet)) return false;
	if (isRawEditing(state, from, to)) return true;
	if (startLine === endLine && selectionTouches(state, from, to)) return true;
	return false;
}

/**
 * Tracks non-overlapping `Decoration.replace` spans so CM6 never throws on overlap. Given the document (the
 * inline plugin gives it), it also refuses a span that runs over a line break: a plugin may not replace one, and
 * the throw comes from CodeMirror's own update, where nothing here can catch it.
 */
class ReplaceGuard {
	private spans: [number, number][] = [];
	constructor(private readonly oneLineIn?: EditorState["doc"]) {}
	canAdd(from: number, to: number): boolean {
		if (from > to) return false;
		if (this.oneLineIn && to > this.oneLineIn.lineAt(from).to) return false;
		for (const [a, b] of this.spans) {
			if (from < b && to > a) return false;
			if (from === to && from >= a && from <= b) return false;
		}
		this.spans.push([from, to]);
		return true;
	}
}

type DocAnalysisCache = {
	text?: string;
	fences?: [number, number][];
	fm?: ReturnType<typeof frontMatter>;
	headingAnchors?: Map<number, string>;
};

/** Per-immutable-Text analysis cache so scroll, foldAll, and keystrokes never rescan the full document per line. */
const docAnalysisCache = new WeakMap<Text, DocAnalysisCache>();

function getDocCache(doc: Text): DocAnalysisCache {
	let entry = docAnalysisCache.get(doc);
	if (!entry) {
		entry = {};
		docAnalysisCache.set(doc, entry);
	}
	return entry;
}

function getDocText(doc: Text): string {
	const entry = getDocCache(doc);
	if (entry.text === undefined) entry.text = doc.toString();
	return entry.text;
}

function getDocFences(doc: Text): [number, number][] {
	const entry = getDocCache(doc);
	if (entry.fences === undefined) entry.fences = fenced(getDocText(doc));
	return entry.fences;
}

function getDocFrontMatter(doc: Text): ReturnType<typeof frontMatter> {
	const entry = getDocCache(doc);
	if (entry.fm === undefined) entry.fm = frontMatter(getDocText(doc));
	return entry.fm;
}

function getDocHeadingAnchors(doc: Text): Map<number, string> {
	const entry = getDocCache(doc);
	if (entry.headingAnchors === undefined) entry.headingAnchors = deduplicatedHeadingAnchorsByLine(getDocText(doc));
	return entry.headingAnchors;
}

function posInRanges(ranges: readonly [number, number][], pos: number): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const [a, b] = ranges[mid]!;
		if (pos < a) hi = mid - 1;
		else if (pos >= b) lo = mid + 1;
		else return true;
	}
	return false;
}

/** Computes frontmatter byte range (`0..endLine.to`) if valid YAML frontmatter exists. */
function frontmatterRange(state: EditorState): { lines: number; from: number; to: number } | null {
	const fm = getDocFrontMatter(state.doc);
	if (!fm.lines || fm.lines > state.doc.lines) return null;
	const endLine = state.doc.line(fm.lines);
	return { lines: fm.lines, from: 0, to: endLine.to };
}

// --- Widgets -----------------------------------------------------------------

class HiddenFrontmatterWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const el = document.createElement("div");
		el.className = "cm-md-fm-hidden";
		el.setAttribute("aria-hidden", "true");
		return el;
	}
}

class HiddenCommentWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const el = document.createElement("div");
		el.className = "cm-md-comment-hidden";
		el.setAttribute("aria-hidden", "true");
		return el;
	}
}

class HrWidget extends WidgetType {
	constructor(private readonly pos: number) {
		super();
	}
	eq(other: HrWidget) {
		return other.pos === this.pos;
	}
	toDOM(view: EditorView) {
		const wrap = document.createElement("div");
		wrap.className = "cm-md-hr-wrap";
		const hr = document.createElement("hr");
		hr.className = "cm-md-hr";
		wrap.appendChild(hr);
		wrap.addEventListener("mousedown", (e) => {
			if (view.state.facet(readOnlyModeFacet)) return;
			e.preventDefault();
			view.focus();
			view.dispatch({ selection: EditorSelection.cursor(Math.min(this.pos, view.state.doc.length)) });
		});
		return wrap;
	}
	ignoreEvent() {
		return true;
	}
}

const activeImageResizeCleanup = new WeakMap<HTMLElement, () => void>();

class ImageWidget extends WidgetType {
	constructor(
		private readonly spec: ParsedImageSpec,
		private readonly from: number,
		private readonly to: number,
		private readonly filePath: string,
		private readonly readMode: boolean,
		private readonly inline = false,
	) {
		super();
	}
	eq(other: ImageWidget) {
		return (
			other.spec.src === this.spec.src &&
			other.spec.alt === this.spec.alt &&
			other.spec.width === this.spec.width &&
			other.spec.height === this.spec.height &&
			other.from === this.from &&
			other.to === this.to &&
			other.filePath === this.filePath &&
			other.readMode === this.readMode &&
			other.inline === this.inline
		);
	}
	toDOM(view: EditorView) {
		const isRead = view.state.facet(readOnlyModeFacet);
		const cb = view.state.facet(liveCallbacksFacet);
		const wrap = document.createElement(this.inline ? "span" : "div");
		wrap.className = this.inline ? "cm-md-image-wrap is-inline" : "cm-md-image-wrap";

		const frame = document.createElement(this.inline ? "span" : "div");
		frame.className = "cm-md-image-frame";

		const img = document.createElement("img");
		img.alt = this.spec.alt || this.spec.src;
		img.loading = "lazy";
		if (this.inline) {
			img.title = isRead ? "Click to view full size" : "Click to view full size · Alt+Click to edit Markdown";
		}
		if (this.spec.width) img.style.width = `${this.spec.width}px`;
		if (this.spec.height) img.style.height = `${this.spec.height}px`;
		frame.appendChild(img);

		let resolvedUrl = "";
		let resolvedPath: string | undefined;

		// Subtle hover pill bar & right-edge drag-to-resize handle on block images.
		if (!this.inline) {
			const tools = document.createElement("div");
			tools.className = "cm-md-image-tools";

			const makeBtn = (label: string, title: string, active: boolean, onClick: () => void) => {
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = active ? "cm-md-img-btn active" : "cm-md-img-btn";
				btn.textContent = label;
				btn.title = title;
				btn.addEventListener("mousedown", (e) => {
					e.preventDefault();
					e.stopPropagation();
					onClick();
				});
				return btn;
			};

			tools.appendChild(
				makeBtn("Zoom", "View full size", false, () => {
					if (resolvedUrl) cb?.onOpenImageLightbox({ src: resolvedUrl, alt: this.spec.alt || this.spec.src, filePath: resolvedPath });
				}),
			);

			if (!isRead) {
				tools.appendChild(makeBtn("320", "Resize image width to 320px", this.spec.width === 320, () => cb?.onResizeImage(this.from, this.to, 320)));
				tools.appendChild(makeBtn("520", "Resize image width to 520px", this.spec.width === 520, () => cb?.onResizeImage(this.from, this.to, 520)));
				tools.appendChild(makeBtn("Full", "Use natural full width", !this.spec.width, () => cb?.onResizeImage(this.from, this.to, null)));
				tools.appendChild(
					makeBtn("Edit", "Edit Markdown image syntax", false, () => {
						view.focus();
						view.dispatch({ selection: EditorSelection.cursor(Math.min(this.from, view.state.doc.length)), scrollIntoView: true });
					}),
				);

				const widthBadge = document.createElement("span");
				widthBadge.className = "cm-md-image-width-badge";
				widthBadge.hidden = true;
				frame.appendChild(widthBadge);

				const handle = document.createElement("div");
				handle.className = "cm-md-image-resize-handle";
				handle.setAttribute("role", "separator");
				handle.setAttribute("aria-orientation", "vertical");
				handle.setAttribute("aria-label", "Resize image width");
				handle.title = "Drag to resize image width";
				handle.addEventListener("mousedown", (e) => {
					if (e.button !== 0) return;
					e.preventDefault();
					e.stopPropagation();
					activeImageResizeCleanup.get(wrap)?.();
					const startX = e.clientX;
					const startW = Math.round(img.getBoundingClientRect().width || this.spec.width || 320);
					const maxW = Math.max(240, Math.round(wrap.getBoundingClientRect().width || 760));
					let nextW = startW;
					frame.classList.add("is-resizing");
					widthBadge.hidden = false;
					widthBadge.textContent = `${startW}px`;

					const cleanup = () => {
						window.removeEventListener("mousemove", onMove);
						window.removeEventListener("mouseup", onUp);
						window.removeEventListener("blur", onCancel);
						if (activeImageResizeCleanup.get(wrap) === cleanup) {
							activeImageResizeCleanup.delete(wrap);
						}
						frame.classList.remove("is-resizing");
						widthBadge.hidden = true;
					};
					const onMove = (ev: MouseEvent) => {
						if (!wrap.isConnected) {
							cleanup();
							return;
						}
						nextW = Math.max(80, Math.min(maxW, Math.round(startW + (ev.clientX - startX))));
						img.style.width = `${nextW}px`;
						widthBadge.textContent = `${nextW}px`;
					};
					const onCancel = () => {
						cleanup();
						img.style.width = this.spec.width ? `${this.spec.width}px` : "";
					};
					const onUp = () => {
						const connected = wrap.isConnected;
						cleanup();
						if (!connected) return;
						if (nextW !== startW) {
							cb?.onResizeImage(this.from, this.to, nextW);
						}
					};
					activeImageResizeCleanup.set(wrap, cleanup);
					window.addEventListener("mousemove", onMove);
					window.addEventListener("mouseup", onUp);
					window.addEventListener("blur", onCancel);
				});
				frame.appendChild(handle);
			}
			frame.appendChild(tools);
		}

		wrap.appendChild(frame);

		if (!this.inline && this.spec.alt) {
			const cap = document.createElement("div");
			cap.className = "cm-md-image-caption";
			cap.textContent = this.spec.alt;
			wrap.appendChild(cap);
		}

		void loadImageUrl(this.spec.src, this.filePath).then((loaded) => {
			if (!wrap.isConnected) return;
			if (loaded) {
				resolvedUrl = loaded.url;
				resolvedPath = loaded.filePath;
				img.src = loaded.url;
			} else {
				img.remove();
				const err = document.createElement(this.inline ? "span" : "div");
				err.className = "cm-md-image-missing";
				err.textContent = `Image not found: ${this.spec.src}`;
				frame.prepend(err);
			}
		});

		(wrap as HTMLElement).addEventListener("mousedown", (e) => {
			if ((e.target as HTMLElement | null)?.closest(".cm-md-image-tools, .cm-md-image-resize-handle")) return;
			e.preventDefault();
			if (isRead || (this.inline && !e.altKey)) {
				if (resolvedUrl) cb?.onOpenImageLightbox({ src: resolvedUrl, alt: this.spec.alt || this.spec.src, filePath: resolvedPath });
				return;
			}
			view.focus();
			view.dispatch({ selection: EditorSelection.cursor(Math.min(this.from, view.state.doc.length)), scrollIntoView: true });
		});
		return wrap;
	}
	destroy(dom: HTMLElement) {
		activeImageResizeCleanup.get(dom)?.();
	}
	ignoreEvent() {
		return true;
	}
}

class BulletWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const span = document.createElement("span");
		span.className = "cm-md-bullet";
		span.setAttribute("aria-hidden", "true");
		return span;
	}
}

class OrderedMarkerWidget extends WidgetType {
	constructor(private readonly marker: string) {
		super();
	}
	eq(other: OrderedMarkerWidget) {
		return other.marker === this.marker;
	}
	toDOM() {
		const span = document.createElement("span");
		span.className = "cm-md-ol-num";
		span.textContent = this.marker;
		span.setAttribute("aria-hidden", "true");
		return span;
	}
}

class CheckboxWidget extends WidgetType {
	constructor(
		private readonly checked: boolean,
		private readonly bracketPos: number,
	) {
		super();
	}
	eq(other: CheckboxWidget) {
		return other.checked === this.checked && other.bracketPos === this.bracketPos;
	}
	toDOM(view: EditorView) {
		const slot = document.createElement("span");
		slot.className = "cm-md-check-slot";
		const input = document.createElement("input");
		input.type = "checkbox";
		input.className = "cm-md-checkbox";
		input.checked = this.checked;
		input.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
		input.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const cb = view.state.facet(liveCallbacksFacet);
			if (cb) {
				cb.onToggleCheckbox(this.bracketPos);
				return;
			}
			const pos = this.bracketPos;
			if (pos + 2 > view.state.doc.length) return;
			const ch = view.state.sliceDoc(pos + 1, pos + 2);
			const next = ch === " " ? "x" : " ";
			view.dispatch({
				changes: { from: pos + 1, to: pos + 2, insert: next },
				userEvent: "input.checkbox",
			});
		});
		input.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		slot.appendChild(input);
		return slot;
	}
	ignoreEvent() {
		return true;
	}
}

class CodeHeaderWidget extends WidgetType {
	constructor(
		private readonly lang: string,
		private readonly linePos: number,
		private readonly openLine: number,
		private readonly canFormat: boolean,
		private readonly readOnly: boolean,
	) {
		super();
	}
	eq(other: CodeHeaderWidget) {
		return (
			other.lang === this.lang &&
			other.linePos === this.linePos &&
			other.openLine === this.openLine &&
			other.canFormat === this.canFormat &&
			other.readOnly === this.readOnly
		);
	}
	toDOM(view: EditorView) {
		const bar = document.createElement("span");
		bar.className = "cm-md-code-header";
		const label = document.createElement("span");
		label.className = "cm-md-code-lang";
		label.textContent = this.lang || "code";

		const actions = document.createElement("span");
		actions.className = "cm-md-code-actions";

		if (this.canFormat && !this.readOnly) {
			const fmtBtn = document.createElement("button");
			fmtBtn.type = "button";
			fmtBtn.className = "cm-md-code-btn cm-md-code-format";
			fmtBtn.textContent = "Format";
			const target = fenceFormatTarget(this.lang);
			fmtBtn.title =
				target?.languageId === "ssl"
					? "Format SSL code block via language server"
					: `Format ${this.lang || target?.languageId || "code"} block`;
			fmtBtn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const cb = view.state.facet(liveCallbacksFacet);
				if (!cb?.onFormatCode || fmtBtn.disabled) return;
				fmtBtn.disabled = true;
				void cb
					.onFormatCode(this.openLine)
					.then((outcome) => {
						if (!fmtBtn.isConnected) return;
						fmtBtn.disabled = false;
						if (outcome === "changed" || outcome === "unchanged") {
							fmtBtn.textContent = outcome === "changed" ? "Formatted" : "Clean";
							setTimeout(() => {
								if (fmtBtn.isConnected) fmtBtn.textContent = "Format";
							}, 1400);
						}
					})
					.catch(() => {
						if (fmtBtn.isConnected) fmtBtn.disabled = false;
					});
			});
			actions.append(fmtBtn);
		}

		const normLang = normalizeFenceLang(this.lang);
		if (normLang === "ssl") {
			const desBtn = document.createElement("button");
			desBtn.type = "button";
			desBtn.className = "cm-md-code-btn";
			desBtn.textContent = "Designer";
			desBtn.title = "Format and copy SSL snippet for STARLIMS Designer";
			desBtn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const cb = view.state.facet(liveCallbacksFacet);
				const current = fenceAtLine(view.state.doc.toString(), this.openLine)?.code ?? "";
				void cb?.onCopyCodeForDesigner?.(current).then(() => {
					if (!desBtn.isConnected) return;
					desBtn.textContent = "Copied";
					setTimeout(() => {
						if (desBtn.isConnected) desBtn.textContent = "Designer";
					}, 1400);
				});
			});
			actions.append(desBtn);
		}
		if (normLang === "ssl" || normLang === "sql") {
			const snipBtn = document.createElement("button");
			snipBtn.type = "button";
			snipBtn.className = "cm-md-code-btn";
			snipBtn.textContent = "Save snippet";
			snipBtn.title = `Save this ${normLang.toUpperCase()} block to docs/knowledge/snippets/`;
			snipBtn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const cb = view.state.facet(liveCallbacksFacet);
				const current = fenceAtLine(view.state.doc.toString(), this.openLine)?.code ?? "";
				void cb?.onSaveCodeSnippet?.(current, normLang);
			});
			actions.append(snipBtn);
		}
		if (normLang && normLang !== "mermaid") {
			const scratchBtn = document.createElement("button");
			scratchBtn.type = "button";
			scratchBtn.className = "cm-md-code-btn";
			scratchBtn.textContent = "Scratch";
			scratchBtn.title = "Open code block in an untitled editor tab (full LSP diagnostics & editing)";
			scratchBtn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const cb = view.state.facet(liveCallbacksFacet);
				const current = fenceAtLine(view.state.doc.toString(), this.openLine)?.code ?? "";
				void cb?.onOpenCodeScratch?.(current, normLang);
			});
			actions.append(scratchBtn);
		}

		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "cm-md-code-btn cm-md-code-copy";
		btn.textContent = "Copy";
		btn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const cb = view.state.facet(liveCallbacksFacet);
			const current = fenceAtLine(view.state.doc.toString(), this.openLine)?.code ?? "";
			cb?.onCopyCode(current);
			btn.textContent = "Copied";
			setTimeout(() => {
				if (btn.isConnected) btn.textContent = "Copy";
			}, 1400);
		});
		actions.append(btn);

		bar.addEventListener("mousedown", (e) => {
			if ((e.target as HTMLElement | null)?.closest("button")) return;
			if (view.state.facet(readOnlyModeFacet)) return;
			e.preventDefault();
			view.focus();
			view.dispatch({ selection: EditorSelection.cursor(Math.min(this.linePos, view.state.doc.length)) });
		});
		bar.append(label, actions);
		return bar;
	}
	ignoreEvent() {
		return true;
	}
}

class HeadingCopyLinkWidget extends WidgetType {
	constructor(
		private readonly headingText: string,
		private readonly filePath: string,
	) {
		super();
	}
	eq(other: HeadingCopyLinkWidget) {
		return other.headingText === this.headingText && other.filePath === this.filePath;
	}
	toDOM() {
		const root = appState.workspace?.root;
		const all = docs();
		const found = all.find((d) => d.exists && canonical(d.path) === canonical(this.filePath));
		const docName =
			(found ? nameFor(found, all, root) : null) ??
			(this.filePath ? baseName(this.filePath).replace(/\.(md|markdown)$/i, "") : "");
		const wikiLink = buildHeadingWikiLink(docName, this.headingText);

		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "cm-md-heading-link";
		btn.setAttribute("contenteditable", "false");
		btn.setAttribute("aria-label", `Copy link ${wikiLink}`);
		btn.title = `Copy link ${wikiLink}`;
		btn.textContent = "#";
		btn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			void import("../commands").then((m) => m.copyText(wikiLink, `Copied ${wikiLink}.`));
			btn.classList.add("is-copied");
			btn.innerHTML = `<span class="codicon-glyph" aria-hidden="true">\ueab2</span>`;
			setTimeout(() => {
				if (!btn.isConnected) return;
				btn.classList.remove("is-copied");
				btn.textContent = "#";
			}, 1200);
		});
		return btn;
	}
	ignoreEvent() {
		return true;
	}
}

class FootnoteRefWidget extends WidgetType {
	constructor(private readonly id: string) {
		super();
	}
	eq(other: FootnoteRefWidget) {
		return other.id === this.id;
	}
	toDOM() {
		const sup = document.createElement("sup");
		sup.className = "cm-md-footnote-ref cm-md-fn-ref-read";
		sup.dataset.mdFootnote = this.id;
		sup.textContent = `[${this.id}]`;
		return sup;
	}
}

class FootnoteDefWidget extends WidgetType {
	constructor(private readonly id: string) {
		super();
	}
	eq(other: FootnoteDefWidget) {
		return other.id === this.id;
	}
	toDOM() {
		const badge = document.createElement("span");
		badge.className = "cm-md-footnote-def cm-md-fn-def-read";
		badge.dataset.mdFnDef = this.id;
		badge.textContent = `${this.id}.`;
		badge.title = `Jump back to reference [${this.id}]`;
		return badge;
	}
}

class HiddenFenceWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const el = document.createElement("span");
		el.className = "cm-md-fence-hidden";
		el.setAttribute("aria-hidden", "true");
		return el;
	}
}

/** Obsidian-style embedded note / heading transclusion (`![[doc]]`, `![[doc#Heading]]`). */
class TransclusionWidget extends WidgetType {
	constructor(
		private readonly inner: string,
		private readonly sourcePath: string,
		private readonly readOnly: boolean,
		private readonly themeVer: number,
		private readonly targetVer: number,
	) {
		super();
	}
	eq(other: TransclusionWidget): boolean {
		return (
			other.inner === this.inner &&
			other.sourcePath === this.sourcePath &&
			other.readOnly === this.readOnly &&
			other.themeVer === this.themeVer &&
			other.targetVer === this.targetVer
		);
	}
	toDOM(view: EditorView): HTMLElement {
		const card = document.createElement("div");
		card.className = "cm-md-embed-card";
		card.setAttribute("contenteditable", "false");
		const root = appState.workspace?.root;
		const bar = this.inner.indexOf("|");
		const rawTarget = (bar < 0 ? this.inner : this.inner.slice(0, bar)).trim();
		const alias = bar < 0 ? undefined : this.inner.slice(bar + 1).trim() || undefined;
		const selfHeading = rawTarget.startsWith("#") ? rawTarget.slice(1).trim() : undefined;
		const parsed = selfHeading ? null : namedLink(this.inner);

		let targetPath: string | null = null;
		let fallbackTargetPath: string | null = null;
		let heading = selfHeading ?? parsed?.heading;
		let isSelfDoc = false;
		if (selfHeading) {
			targetPath = this.sourcePath;
		} else if (parsed && root) {
			const docFound = docByName(parsed.name, docs(), root);
			if (docFound) {
				targetPath = docFound.path;
			} else if (parsed.name.includes("/") || /\.[a-z0-9]{1,8}$/i.test(parsed.name)) {
				// Allow transcluding relative OR workspace-root code/SQL/CSV/fixture files (`![[samples/query.sql]]`, `![[schema/database/demo.sql]]`).
				const relCandidate = resolvePath(dirName(this.sourcePath), parsed.name);
				const rootCandidate = resolvePath(root, parsed.name.replace(/^\/+/, ""));
				if (isInside(root, relCandidate)) {
					targetPath = relCandidate;
					if (isInside(root, rootCandidate) && canonical(rootCandidate) !== canonical(relCandidate)) {
						fallbackTargetPath = rootCandidate;
					}
				} else if (isInside(root, rootCandidate)) {
					targetPath = rootCandidate;
				}
			}
			if (targetPath && !heading && canonical(targetPath) === canonical(this.sourcePath)) {
				isSelfDoc = true;
			}
		}

		let resolvedLine: number | undefined;
		const head = document.createElement("div");
		head.className = "cm-md-embed-head";
		const titleBtn = document.createElement("button");
		titleBtn.type = "button";
		titleBtn.className = "cm-md-embed-title";
		titleBtn.textContent = alias ?? (selfHeading ? `#${selfHeading}` : parsed ? (parsed.words ?? (parsed.heading ? `${parsed.name} › ${parsed.heading}` : parsed.name)) : this.inner);
		titleBtn.title = targetPath ? `Open ${relativeTo(root, targetPath)}` : `No note named “${this.inner}”`;
		titleBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (targetPath) void openFile(targetPath, resolvedLine ? { reveal: { line: resolvedLine } } : {});
			else view.state.facet(liveCallbacksFacet)?.onFollowWiki(this.inner);
		});
		head.append(titleBtn);

		const actions = document.createElement("span");
		actions.className = "cm-md-embed-actions";

		const body = document.createElement("div");
		body.className = "cm-md-embed-body md";
		const setStatusMsg = (cls: string, msg: string) => {
			const p = document.createElement("p");
			p.className = cls;
			p.textContent = msg;
			body.replaceChildren(p);
		};

		const primaryPath = targetPath;
		const secondaryPath = fallbackTargetPath;
		let loadSeq = 0;
		const loadEmbed = () => {
			const seq = ++loadSeq;
			if (isSelfDoc) {
				setStatusMsg("cm-md-embed-missing", "Cannot embed a document inside itself (use ![[#Heading]] to embed a section).");
				return;
			}
			if (!primaryPath) {
				setStatusMsg("cm-md-embed-missing", `Embedded note “${this.inner}” was not found. Click the title to create it.`);
				return;
			}
			setStatusMsg("cm-md-embed-loading", "Loading embedded note…");
			const hostVisited = new Set<string>();
			if (this.sourcePath && !selfHeading) hostVisited.add(canonical(this.sourcePath));
			void (async () => {
				let usedPath = primaryPath;
				let preview = await buildHoverPreview(primaryPath, { heading, maxLines: 120, visited: hostVisited });
				if (seq !== loadSeq || !body.isConnected) return;
				if (!preview && secondaryPath) {
					usedPath = secondaryPath;
					preview = await buildHoverPreview(secondaryPath, { heading, maxLines: 120, visited: hostVisited });
				}
				if (seq !== loadSeq || !body.isConnected) return;
				if (!preview) {
					setStatusMsg("cm-md-embed-missing", `Could not read “${this.inner}”.`);
					return;
				}
				targetPath = usedPath;
				resolvedLine = preview.line;
				titleBtn.textContent = alias ?? (heading ? `${preview.title} › ${heading}` : preview.title);
				titleBtn.title = `Open ${relativeTo(root, usedPath)}`;
				body.innerHTML = preview.html;
				hydrateImagesInElement(body, usedPath);
				hydrateMathInElement(body);
				void colourCode(body);
			})();
		};

		if (primaryPath && !isSelfDoc) {
			const refreshBtn = document.createElement("button");
			refreshBtn.type = "button";
			refreshBtn.className = "cm-md-code-btn cm-md-embed-refresh";
			refreshBtn.title = "Refresh embedded note";
			refreshBtn.setAttribute("aria-label", "Refresh embedded note");
			const refIcon = document.createElement("span");
			refIcon.className = "codicon-glyph";
			refIcon.setAttribute("aria-hidden", "true");
			refIcon.textContent = "\ueb37";
			refreshBtn.appendChild(refIcon);
			refreshBtn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				loadEmbed();
			});
			actions.append(refreshBtn);
		}

		if (!this.readOnly) {
			const editBtn = document.createElement("button");
			editBtn.type = "button";
			editBtn.className = "cm-md-code-btn";
			editBtn.textContent = "Edit";
			editBtn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const pos = Math.min(view.posAtDOM(card), view.state.doc.length);
				view.focus();
				view.dispatch({ selection: EditorSelection.cursor(pos) });
			});
			actions.append(editBtn);
		}
		if (actions.childNodes.length) head.append(actions);
		card.append(head);

		// Safely intercept links and #tags inside embedded notes so clicks never hijack the app window.
		body.addEventListener("click", (e) => {
			const el = e.target instanceof Element ? e.target : null;
			if (!el) return;
			const tagEl = el.closest<HTMLElement>("[data-tag]");
			if (tagEl?.dataset.tag) {
				e.preventDefault();
				e.stopPropagation();
				view.state.facet(liveCallbacksFacet)?.onTagClick(tagEl.dataset.tag);
				return;
			}
			const link = el.closest<HTMLAnchorElement>("a[href]");
			if (!link) return;
			e.preventDefault();
			e.stopPropagation();
			const href = link.getAttribute("href") ?? "";
			if (/^https?:\/\//i.test(href)) {
				void window.open(href, "_blank", "noopener");
				return;
			}
			if (targetPath && root && href) {
				if (href.startsWith("#")) {
					const anc = href.slice(1).trim();
					if (anc) {
						void buildHoverPreview(targetPath, { heading: anc, maxLines: 1 }).then((p) => {
							void openFile(targetPath!, p?.line ? { reveal: { line: p.line } } : {});
						});
					}
					return;
				}
				const hashAt = href.indexOf("#");
				const rawFile = hashAt >= 0 ? href.slice(0, hashAt) : href;
				const rawHash = hashAt >= 0 ? href.slice(hashAt + 1) : "";
				let clean = rawFile.split("?")[0] ?? "";
				try {
					clean = decodeURIComponent(clean);
				} catch {
					// Keep raw path on malformed percent escapes.
				}
				const dest = clean.startsWith("/")
					? resolvePath(root, clean.replace(/^\/+/, ""))
					: resolvePath(dirName(targetPath), clean);
				if (isInside(root, dest)) {
					const lineHash = /^L(\d+)(?:-L?(\d+))?$/i.exec(rawHash.trim());
					if (lineHash) {
						void openFile(dest, { reveal: { line: Number(lineHash[1]), ...(lineHash[2] ? { endLine: Number(lineHash[2]) } : {}) } });
					} else if (rawHash) {
						void buildHoverPreview(dest, { heading: rawHash, maxLines: 1 }).then((p) => {
							void openFile(dest, p?.line ? { reveal: { line: p.line } } : {});
						});
					} else {
						void openFile(dest);
					}
				}
			}
		});

		loadEmbed();
		card.append(body);
		return card;
	}
	ignoreEvent() {
		return true;
	}
}

/** Remembered open/closed state for `<details>` blocks so toggling survives Live <-> Read & edits elsewhere. */
const DETAILS_OPEN_STATE_MAX = 200;
const detailsOpenState = new Map<string, boolean>();

function setDetailsOpen(key: string, open: boolean) {
	detailsOpenState.delete(key);
	detailsOpenState.set(key, open);
	while (detailsOpenState.size > DETAILS_OPEN_STATE_MAX) {
		const oldest = detailsOpenState.keys().next().value;
		if (oldest === undefined) break;
		detailsOpenState.delete(oldest);
	}
}

/** Collapsible `<details><summary>...</summary>...</details>` block widget for Live & Read modes. */
class DetailsWidget extends WidgetType {
	constructor(
		private readonly summaryMd: string,
		private readonly bodyMd: string,
		private readonly defaultOpen: boolean,
		private readonly from: number,
		private readonly to: number,
		private readonly startLine: number,
		private readonly filePath: string,
		private readonly readOnly: boolean,
		private readonly themeVer: number,
	) {
		super();
	}

	eq(other: DetailsWidget): boolean {
		return (
			other.summaryMd === this.summaryMd &&
			other.bodyMd === this.bodyMd &&
			other.defaultOpen === this.defaultOpen &&
			other.from === this.from &&
			other.to === this.to &&
			other.startLine === this.startLine &&
			other.filePath === this.filePath &&
			other.readOnly === this.readOnly &&
			other.themeVer === this.themeVer
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const card = document.createElement("div");
		card.className = "cm-md-details-card";
		card.setAttribute("contenteditable", "false");

		const details = document.createElement("details");
		details.className = "cm-md-details";
		const stateKey = `${this.filePath}:${this.startLine}:${this.summaryMd}`;
		details.open = detailsOpenState.has(stateKey) ? detailsOpenState.get(stateKey)! : this.defaultOpen;
		details.addEventListener("toggle", () => {
			setDetailsOpen(stateKey, details.open);
		});

		const enterRaw = () => {
			if (this.readOnly) return;
			const curFrom = Math.min(this.from, view.state.doc.length);
			const curTo = Math.min(this.to, view.state.doc.length);
			view.focus();
			view.dispatch({
				selection: EditorSelection.cursor(curFrom),
				effects: setRawEditBlockEffect.of({ from: curFrom, to: curTo }),
				scrollIntoView: true,
			});
		};

		const summary = document.createElement("summary");
		summary.className = "cm-md-details-summary";
		const summaryLabel = document.createElement("span");
		summaryLabel.className = "cm-md-details-title";
		summaryLabel.innerHTML = renderInlineHtml(this.summaryMd || "Details", this.filePath, true);
		hydrateMathInElement(summaryLabel);
		summary.appendChild(summaryLabel);

		summary.addEventListener("click", (e) => {
			const target = e.target instanceof Element ? e.target : null;
			if (!target) return;
			const cb = view.state.facet(liveCallbacksFacet);
			const anchor = target.closest<HTMLAnchorElement>("a[href]");
			if (anchor) {
				e.preventDefault();
				e.stopPropagation();
				if (!e.altKey) cb?.onFollowLink(anchor.getAttribute("href") ?? "");
				return;
			}
			const tagEl = target.closest<HTMLElement>(".md-tag, [data-tag]");
			if (tagEl && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				const tag = tagEl.dataset.tag ?? tagEl.textContent?.trim() ?? "";
				if (tag) cb?.onTagClick(tag);
			}
		});

		if (!this.readOnly) {
			const editBtn = document.createElement("button");
			editBtn.type = "button";
			editBtn.className = "cm-md-code-btn cm-md-details-edit";
			editBtn.textContent = "Edit";
			editBtn.title = "Edit raw <details> Markdown source";
			editBtn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				enterRaw();
			});
			editBtn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
			});
			summary.appendChild(editBtn);
		}

		const body = document.createElement("div");
		body.className = "cm-md-details-body md";
		if (this.bodyMd.trim()) {
			body.innerHTML = renderInlineHtml(this.bodyMd, this.filePath, false, false);
			hydrateImagesInElement(body, this.filePath);
			hydrateMathInElement(body);
			void colourCode(body);
		}

		body.addEventListener("click", (e) => {
			const target = e.target instanceof Element ? e.target : null;
			if (!target) return;
			const cb = view.state.facet(liveCallbacksFacet);
			const anchor = target.closest<HTMLAnchorElement>("a[href]");
			if (anchor) {
				e.preventDefault();
				e.stopPropagation();
				if (!e.altKey) {
					cb?.onFollowLink(anchor.getAttribute("href") ?? "");
					return;
				}
				if (!this.readOnly) enterRaw();
				return;
			}
			const tagEl = target.closest<HTMLElement>(".md-tag, [data-tag]");
			if (tagEl && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				const tag = tagEl.dataset.tag ?? tagEl.textContent?.trim() ?? "";
				if (tag) cb?.onTagClick(tag);
				return;
			}
			if (!this.readOnly) {
				const sel = window.getSelection();
				if (sel && !sel.isCollapsed) return;
				e.preventDefault();
				e.stopPropagation();
				enterRaw();
			}
		});

		details.append(summary, body);
		card.appendChild(details);
		return card;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/** Lazy-loaded KaTeX widget for block `$$...$$` and inline `$...$` math expressions. */
class MathWidget extends WidgetType {
	constructor(
		private readonly tex: string,
		private readonly displayMode: boolean,
		private readonly readOnly: boolean,
	) {
		super();
	}

	eq(other: MathWidget): boolean {
		return (
			other.tex === this.tex &&
			other.displayMode === this.displayMode &&
			other.readOnly === this.readOnly
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const el = document.createElement(this.displayMode ? "div" : "span");
		el.className = this.displayMode ? "cm-md-math-block" : "cm-md-math-inline";
		el.setAttribute("contenteditable", "false");
		if (!this.readOnly) el.title = "Click to edit LaTeX math";

		const cached = renderKatexSync(this.tex, this.displayMode);
		if (cached !== null) {
			el.innerHTML = cached;
		} else {
			const pending = document.createElement("code");
			pending.className = "cm-md-math-pending";
			pending.textContent = this.tex;
			el.appendChild(pending);
			void renderKatexHtml(this.tex, this.displayMode).then((html) => {
				if (html && el.isConnected) el.innerHTML = html;
			});
		}

		if (!this.readOnly) {
			el.addEventListener("mousedown", (ev) => {
				const e = ev as MouseEvent;
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const livePos = view.posAtDOM(el);
				const targetPos = Math.min(livePos + (this.displayMode ? 2 : 1), view.state.doc.length);
				view.focus();
				view.dispatch({
					selection: EditorSelection.cursor(targetPos),
					scrollIntoView: true,
				});
			});
		}
		return el;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/** Parses `<details ...><summary>...</summary>...</details>` inner HTML into summary + Markdown body. */
function parseDetailsBlock(raw: string): { defaultOpen: boolean; summaryMd: string; bodyMd: string } | null {
	const openMatch = /^[ \t]*<details(\b[^>]*)>/i.exec(raw);
	const closeIdx = raw.toLowerCase().lastIndexOf("</details>");
	if (!openMatch || closeIdx < openMatch[0].length) return null;
	const defaultOpen = /\bopen\b/i.test(openMatch[1] ?? "");
	let inner = raw.slice(openMatch[0].length, closeIdx);
	let summaryMd = "Details";
	const sumMatch = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
	if (sumMatch) {
		summaryMd = sumMatch[1]!.replace(/\r?\n/g, " ").trim() || "Details";
		inner = inner.slice(sumMatch[0].length);
	}
	return { defaultOpen, summaryMd, bodyMd: inner.trim() };
}

// --- Block StateField (multi-line & block widgets) ---------------------------

function buildBlockDecorations(state: EditorState): DecorationSet {
	const decos: Range<Decoration>[] = [];
	const guard = new ReplaceGuard();
	const cb = state.facet(liveCallbacksFacet);
	const filePath = cb?.filePath() ?? "";
	const fm = frontmatterRange(state);
	const isRead = state.facet(readOnlyModeFacet);

	// 1. YAML Frontmatter: collapsed out of the CM6 body surface; raw YAML editing lives inside the Properties card above.
	// When CM6 Ctrl+F search matches inside frontmatter, reveal the YAML lines cleanly so search never lands on 0px bytes.
	const fmRevealedBySearch = Boolean(fm && searchMatchesBlock(state, fm.from, fm.to));
	if (fm && !fmRevealedBySearch) {
		if (guard.canAdd(fm.from, fm.to)) {
			decos.push(Decoration.replace({ widget: new HiddenFrontmatterWidget(), block: true }).range(fm.from, fm.to));
		}
	} else if (fm && fmRevealedBySearch) {
		for (let n = 1; n <= fm.lines; n++) {
			const ln = state.doc.line(n);
			const cls = ["cm-md-fm-search-line"];
			if (n === 1) cls.push("cm-md-fm-search-first");
			if (n === fm.lines) cls.push("cm-md-fm-search-last");
			decos.push(Decoration.line({ class: cls.join(" ") }).range(ln.from));
		}
	}

	const fmEnd = fm?.to ?? -1;
	const docText = getDocText(state.doc);
	const fences = getDocFences(state.doc);
	const inFence = (pos: number) => posInRanges(fences, pos);
	const linesArray = docText.split("\n");

	// 2. Walk syntax tree for multi-line Table, Callout (Blockquote), HorizontalRule, and CommentBlock nodes.
	const tree = syntaxTree(state);
	const handledTables = new Set<number>();
	const handledCallouts = new Set<number>();
	const handledComments = new Set<number>();
	const applyStandaloneComment = (startNum: number, endNum: number) => {
		for (let k = startNum; k <= endNum; k++) handledComments.add(k);
		const rawFrom = state.doc.line(startNum).from;
		const rawTo = state.doc.line(endNum).to;
		if (!selectionTouches(state, rawFrom, rawTo)) {
			const hidden = commentBlockHideLines(linesArray, startNum, endNum, isRead);
			const hideFrom = state.doc.line(hidden.startLine).from;
			const hideTo = state.doc.line(hidden.endLine).to;
			if (guard.canAdd(hideFrom, hideTo)) {
				decos.push(Decoration.replace({ widget: new HiddenCommentWidget(), block: true }).range(hideFrom, hideTo));
			} else if (guard.canAdd(rawFrom, rawTo)) {
				decos.push(Decoration.replace({ widget: new HiddenCommentWidget(), block: true }).range(rawFrom, rawTo));
			}
		} else {
			for (let k = startNum; k <= endNum; k++) {
				decos.push(Decoration.line({ class: "cm-md-comment-line" }).range(state.doc.line(k).from));
			}
		}
	};
	tree.iterate({
		enter(node) {
			// Skip nodes wholly inside frontmatter; allow container nodes like `Document` (from === 0) to descend!
			if (node.to <= fmEnd) return false;
			if (node.name === "FencedCode") {
				const startLine = state.doc.lineAt(node.from);
				const endLine = state.doc.lineAt(node.to);
				const open = parseFenceOpen(startLine.text);
				if (open && normalizeFenceLang(open.lang) === "mermaid" && endLine.number > startLine.number) {
					const hasClose = isFenceClose(endLine.text, open.fenceChar, open.fenceLen, Boolean(open.quotePrefix.length));
					if (hasClose) {
						const bodyLines: string[] = [];
						for (let k = startLine.number + 1; k < endLine.number; k++) {
							const rawLine = state.doc.line(k).text;
							bodyLines.push(open.quotePrefix.length ? stripQuotePrefix(rawLine, true).text : rawLine);
						}
						const code = bodyLines.join("\n").trim();
						const editingMermaid = !isRead && (selectionTouches(state, node.from, node.to) || isRawEditing(state, node.from, node.to));
						if (!editingMermaid && !searchMatchesBlock(state, node.from, node.to) && guard.canAdd(node.from, node.to)) {
							if (code) {
								decos.push(
									Decoration.replace({
										widget: new MermaidWidget(code, isRead, currentThemeVersion()),
										block: true,
									}).range(node.from, node.to),
								);
							}
						} else if (editingMermaid) {
							decos.push(
								Decoration.widget({
									widget: new MermaidLivePreviewWidget(code, currentThemeVersion(), startLine.number + 1, endLine.number),
									side: 1,
									block: true,
								}).range(endLine.to),
							);
						}
					}
				}
				return false;
			}
			if (node.from <= fmEnd) return;

			if (node.name === "Table") {
				const startLineObj = state.doc.lineAt(node.from);
				const endLineObj = state.doc.lineAt(node.to);
				const startLine = startLineObj.number;
				const endLine = endLineObj.number;
				const blockFrom = startLineObj.from;
				const blockTo = endLineObj.to;
				for (let n = startLine; n <= endLine; n++) handledTables.add(n);
				const raw = state.sliceDoc(blockFrom, blockTo);
				const parsedTable = parseTableRaw(raw);
				const beforeNode = state.sliceDoc(blockFrom, node.from);
				const uniformPrefix = Boolean(
					parsedTable &&
						parsedTable.startLine === 0 &&
						parsedTable.endLine === endLine - startLine &&
						(node.from === blockFrom || beforeNode === parsedTable.prefix),
				);
				if (uniformPrefix && !tableShouldStayRaw(state, blockFrom, blockTo, startLine, endLine) && guard.canAdd(blockFrom, blockTo)) {
					decos.push(
						Decoration.replace({
							widget: new TableWidget(raw, blockFrom, blockTo, startLine, filePath, isRead),
							block: true,
						}).range(blockFrom, blockTo),
					);
				} else {
					// Raw pipe table editing mode: crisp monospace alignment & subtle highlight.
					for (let n = startLine; n <= endLine; n++) {
						const ln = state.doc.line(n);
						const cls = ["cm-md-table-line"];
						if (n === startLine) cls.push("cm-md-table-first", "cm-md-table-header");
						if (n === startLine + 1) cls.push("cm-md-table-delim");
						if (n === endLine) cls.push("cm-md-table-last");
						decos.push(Decoration.line({ class: cls.join(" ") }).range(ln.from));
					}
				}
				return false;
			}

			if (node.name === "Blockquote") {
				const firstLine = state.doc.lineAt(node.from);
				const blockFrom = firstLine.from;
				const beforeNode = state.sliceDoc(blockFrom, node.from);
				// Never replace a callout embedded on the same line after a list marker or outer quote prefix.
				if (!/^[ \t]*$/.test(beforeNode)) return;
				const parsed = parseCalloutHeader(firstLine.text);
				if (!parsed) return;
				const leadPrefix = /^[ \t]*/.exec(firstLine.text)![0];
				const matchesCalloutLine = (txt: string) =>
					leadPrefix.length > 0
						? txt.startsWith(leadPrefix) && txt[leadPrefix.length] === ">"
						: /^[ \t]{0,3}>/.test(txt);
				let endLine = state.doc.lineAt(node.to);
				// Never swallow non-quoted lines (CommonMark lazy continuation) into a callout widget!
				while (endLine.number > firstLine.number && !/^[ \t]{0,3}>/.test(endLine.text)) {
					endLine = state.doc.line(endLine.number - 1);
				}
				const blockTo = endLine.to;
				let uniformPrefix = true;
				for (let n = firstLine.number + 1; n <= endLine.number; n++) {
					if (!matchesCalloutLine(state.doc.line(n).text)) {
						uniformPrefix = false;
						break;
					}
				}
				for (let n = firstLine.number; n <= endLine.number; n++) handledCallouts.add(n);
				if (uniformPrefix && !calloutShouldStayRaw(state, blockFrom, blockTo, firstLine.number, endLine.number) && guard.canAdd(blockFrom, blockTo)) {
					const bodyLines: string[] = [];
					for (let n = firstLine.number + 1; n <= endLine.number; n++) {
						const txt = state.doc.line(n).text;
						const afterLead = leadPrefix ? txt.slice(leadPrefix.length) : txt;
						bodyLines.push(afterLead.replace(/^[ \t]{0,3}>[ \t]?/, ""));
					}
					decos.push(
						Decoration.replace({
							widget: new CalloutWidget(
								parsed,
								bodyLines.join("\n"),
								blockFrom,
								blockTo,
								firstLine.number,
								endLine.number,
								filePath,
								isRead,
								currentThemeVersion(),
								leadPrefix,
							),
							block: true,
						}).range(blockFrom, blockTo),
					);
				} else {
					// Raw callout editing mode: preserve colored left bar and soft tint!
					for (let n = firstLine.number; n <= endLine.number; n++) {
						const ln = state.doc.line(n);
						const cls = ["cm-md-callout-editing", `tone-${parsed.spec.tone}`];
						if (n === firstLine.number) cls.push("cm-md-callout-editing-first");
						if (n === endLine.number) cls.push("cm-md-callout-editing-last");
						decos.push(Decoration.line({ class: cls.join(" ") }).range(ln.from));
					}
				}
				return false;
			}

			if (node.name === "HorizontalRule") {
				if (!selectionTouches(state, node.from, node.to) && guard.canAdd(node.from, node.to)) {
					decos.push(Decoration.replace({ widget: new HrWidget(node.from), block: true }).range(node.from, node.to));
				}
				return false;
			}

			if (node.name === "CommentBlock") {
				const startLine = state.doc.lineAt(node.from);
				const endLine = state.doc.lineAt(node.to);
				if (isStandaloneHtmlComment(state.sliceDoc(startLine.from, endLine.to))) {
					applyStandaloneComment(startLine.number, endLine.number);
				}
				return false;
			}
		},
	});

	// 2b. Line-based fallback for any callouts (`>[!important]`) or GFM tables not yet classified by Lezer's tree.
	const startLineNum = fm ? fm.lines + 1 : 1;
	for (let n = startLineNum; n <= state.doc.lines; n++) {
		const line = state.doc.line(n);
		if (inFence(line.from)) continue;
		// Callout fallback (e.g. immediately following a list or before incremental tree finishes parsing)
		if (!handledCallouts.has(n) && line.text.includes("[!")) {
			const parsed = parseCalloutHeader(line.text);
			if (parsed) {
				const leadPrefix = /^[ \t]*/.exec(line.text)![0];
				const matchesCalloutLine = (txt: string) =>
					leadPrefix.length > 0
						? txt.startsWith(leadPrefix) && txt[leadPrefix.length] === ">"
						: /^[ \t]{0,3}>/.test(txt);
				let endLineNum = n;
				while (endLineNum + 1 <= state.doc.lines && /^[ \t]{0,3}>/.test(state.doc.line(endLineNum + 1).text)) {
					endLineNum++;
				}
				let uniformPrefix = true;
				for (let k = n + 1; k <= endLineNum; k++) {
					if (!matchesCalloutLine(state.doc.line(k).text)) {
						uniformPrefix = false;
						break;
					}
				}
				const from = line.from;
				const to = state.doc.line(endLineNum).to;
				for (let k = n; k <= endLineNum; k++) handledCallouts.add(k);
				if (uniformPrefix && !calloutShouldStayRaw(state, from, to, n, endLineNum) && guard.canAdd(from, to)) {
					const bodyLines: string[] = [];
					for (let k = n + 1; k <= endLineNum; k++) {
						const txt = state.doc.line(k).text;
						const afterLead = leadPrefix ? txt.slice(leadPrefix.length) : txt;
						bodyLines.push(afterLead.replace(/^[ \t]{0,3}>[ \t]?/, ""));
					}
					decos.push(
						Decoration.replace({
							widget: new CalloutWidget(parsed, bodyLines.join("\n"), from, to, n, endLineNum, filePath, isRead, currentThemeVersion(), leadPrefix),
							block: true,
						}).range(from, to),
					);
				} else {
					for (let k = n; k <= endLineNum; k++) {
						const ln = state.doc.line(k);
						const cls = ["cm-md-callout-editing", `tone-${parsed.spec.tone}`];
						if (k === n) cls.push("cm-md-callout-editing-first");
						if (k === endLineNum) cls.push("cm-md-callout-editing-last");
						decos.push(Decoration.line({ class: cls.join(" ") }).range(ln.from));
					}
				}
				n = endLineNum;
				continue;
			}
		}
		// Standalone HTML comment fallback (e.g. EOF `<!-- plan ... -->` or `<!-- /catalog -->` before incremental tree catches up)
		if (!handledComments.has(n) && !handledTables.has(n) && !handledCallouts.has(n) && /^[ \t]*<!--/.test(line.text)) {
			if (isStandaloneHtmlComment(line.text)) {
				applyStandaloneComment(n, n);
				continue;
			}
			// Multi-line standalone comment fallback.
			let endLineNum = n;
			while (endLineNum < state.doc.lines && !state.doc.line(endLineNum).text.includes("-->")) {
				endLineNum++;
				if (inFence(state.doc.line(endLineNum).from)) break;
			}
			if (endLineNum > n && !inFence(state.doc.line(endLineNum).from)) {
				const slice = state.sliceDoc(line.from, state.doc.line(endLineNum).to);
				if (isStandaloneHtmlComment(slice)) {
					applyStandaloneComment(n, endLineNum);
					n = endLineNum;
					continue;
				}
			}
		}
		// GFM table fallback
		if (!handledTables.has(n) && !handledCallouts.has(n) && line.text.includes("|")) {
			const tbl = parseMarkdownTable(linesArray, n - 1);
			if (tbl && tbl.startLine + 1 === n) {
				const endLineNum = tbl.endLine + 1;
				const from = line.from;
				const to = state.doc.line(endLineNum).to;
				for (let k = n; k <= endLineNum; k++) handledTables.add(k);
				if (!tableShouldStayRaw(state, from, to, n, endLineNum) && guard.canAdd(from, to)) {
					const raw = state.sliceDoc(from, to);
					decos.push(
						Decoration.replace({
							widget: new TableWidget(raw, from, to, n, filePath, isRead),
							block: true,
						}).range(from, to),
					);
				} else {
					for (let k = n; k <= endLineNum; k++) {
						const ln = state.doc.line(k);
						const cls = ["cm-md-table-line"];
						if (k === n) cls.push("cm-md-table-first", "cm-md-table-header");
						if (k === n + 1) cls.push("cm-md-table-delim");
						if (k === endLineNum) cls.push("cm-md-table-last");
						decos.push(Decoration.line({ class: cls.join(" ") }).range(ln.from));
					}
				}
				n = endLineNum;
				continue;
			}
		}
	}

	// 2c. Collapsible `<details><summary>...</summary>...</details>` and block display math (`$$...$$`).
	for (let n = startLineNum; n <= state.doc.lines; n++) {
		const line = state.doc.line(n);
		if (inFence(line.from) || handledTables.has(n) || handledCallouts.has(n) || handledComments.has(n)) continue;
		// Collapsible `<details>` block
		if (/^[ \t]*<details(?:\s[^>]*)?>/i.test(line.text)) {
			let depth = 0;
			let endLineNum = -1;
			let innerFence: { ch: string; len: number } | null = null;
			for (let k = n; k <= state.doc.lines; k++) {
				const lnText = state.doc.line(k).text;
				const fmMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(lnText);
				if (fmMatch) {
					if (!innerFence) innerFence = { ch: fmMatch[1]![0]!, len: fmMatch[1]!.length };
					else if (fmMatch[1]![0] === innerFence.ch && fmMatch[1]!.length >= innerFence.len && fmMatch[2]!.trim() === "") innerFence = null;
					continue;
				}
				if (innerFence) continue;
				const opens = lnText.match(/<details(?:\s[^>]*)?>/gi)?.length ?? 0;
				const closes = lnText.match(/<\/details>/gi)?.length ?? 0;
				depth += opens - closes;
				if (depth <= 0 && closes > 0) {
					endLineNum = k;
					break;
				}
			}
			if (endLineNum >= n) {
				const from = line.from;
				const to = state.doc.line(endLineNum).to;
				const parsed = parseDetailsBlock(state.sliceDoc(from, to));
				if (
					parsed &&
					!isRawEditing(state, from, to) &&
					!selectionTouches(state, from, to) &&
					!searchMatchesBlock(state, from, to) &&
					guard.canAdd(from, to)
				) {
					decos.push(
						Decoration.replace({
							widget: new DetailsWidget(
								parsed.summaryMd,
								parsed.bodyMd,
								parsed.defaultOpen,
								from,
								to,
								n,
								filePath,
								isRead,
								currentThemeVersion(),
							),
							block: true,
						}).range(from, to),
					);
				}
				n = endLineNum;
				continue;
			}
		}
		// Block display math: single-line `$$...$$` or multi-line `$$\n...\n$$`
		const singleMath = /^[ \t]*\$\$([^\n$]+?)\$\$[ \t]*$/.exec(line.text);
		if (singleMath && singleMath[1]!.trim()) {
			const from = line.from;
			const to = line.to;
			if (!selectionTouches(state, from, to) && !isRawEditing(state, from, to) && !searchMatchesBlock(state, from, to) && guard.canAdd(from, to)) {
				decos.push(
					Decoration.replace({
						widget: new MathWidget(singleMath[1]!.trim(), true, isRead),
						block: true,
					}).range(from, to),
				);
			}
			continue;
		}
		if (/^[ \t]*\$\$[ \t]*$/.test(line.text)) {
			let closeLine = -1;
			for (let k = n + 1; k <= state.doc.lines; k++) {
				if (/^[ \t]*\$\$[ \t]*$/.test(state.doc.line(k).text)) {
					closeLine = k;
					break;
				}
			}
			if (closeLine > n) {
				const from = line.from;
				const to = state.doc.line(closeLine).to;
				const bodyLines: string[] = [];
				for (let k = n + 1; k < closeLine; k++) bodyLines.push(state.doc.line(k).text);
				const tex = bodyLines.join("\n").trim();
				if (tex && !selectionTouches(state, from, to) && !isRawEditing(state, from, to) && !searchMatchesBlock(state, from, to) && guard.canAdd(from, to)) {
					decos.push(
						Decoration.replace({
							widget: new MathWidget(tex, true, isRead),
							block: true,
						}).range(from, to),
					);
				}
				n = closeLine;
				continue;
			}
		}
	}

	// 3. Standalone image lines (`![alt|400](src)` or `![[image.png|Caption|300]]`) & note transclusions (`![[note]]`, `![[note#Heading]]`).
	const transclusionVer = (rawEmbed: string): number => {
		const root = appState.workspace?.root;
		if (rawEmbed.startsWith("#")) {
			// Self-heading transclusion `![[#Heading]]`: bump whenever this document's own length/version changes.
			const selfOpen = documents.get(canonical(filePath))?.model.getAlternativeVersionId() ?? state.doc.length;
			return appState.treeVersion * 100000 + selfOpen;
		}
		const parsed = namedLink(rawEmbed);
		const found = parsed && root ? docByName(parsed.name, docs(), root) : null;
		let openVer = found ? (documents.get(canonical(found.path))?.model.getAlternativeVersionId() ?? 0) : 0;
		if (!found && parsed && root) {
			const relCand = resolvePath(dirName(filePath), parsed.name);
			const rootCand = resolvePath(root, parsed.name.replace(/^\/+/, ""));
			openVer =
				documents.get(canonical(relCand))?.model.getAlternativeVersionId() ??
				documents.get(canonical(rootCand))?.model.getAlternativeVersionId() ??
				0;
		}
		return appState.treeVersion * 100000 + openVer;
	};
	for (let n = startLineNum; n <= state.doc.lines; n++) {
		const line = state.doc.line(n);
		if (!line.text.includes("![")) continue;
		if (inFence(line.from) || selectionTouches(state, line.from, line.to)) continue;
		const parsed = parseImageExpression(line.text);
		if (parsed) {
			if (parsed.kind === "wiki" && !IMAGE_FILE_RE.test(parsed.src)) {
				const rawEmbed = /^\s*!\[\[([^[\]\n]+)\]\]\s*$/.exec(line.text)?.[1]?.trim();
				if (rawEmbed && !searchMatchesBlock(state, line.from, line.to) && guard.canAdd(line.from, line.to)) {
					decos.push(
						Decoration.replace({
							widget: new TransclusionWidget(rawEmbed, filePath, isRead, currentThemeVersion(), transclusionVer(rawEmbed)),
							block: true,
						}).range(line.from, line.to),
					);
				}
				continue;
			}
			const cleanSpec: ParsedImageSpec = parsed.kind === "md" ? { ...parsed, src: hrefWritten(parsed.src) } : parsed;
			if (cleanSpec.src && !searchMatchesBlock(state, line.from, line.to) && guard.canAdd(line.from, line.to)) {
				decos.push(
					Decoration.replace({
						widget: new ImageWidget(cleanSpec, line.from, line.to, filePath, isRead, false),
						block: true,
					}).range(line.from, line.to),
				);
			}
		} else {
			const rawEmbed = /^\s*!\[\[([^[\]\n]+)\]\]\s*$/.exec(line.text)?.[1]?.trim();
			if (rawEmbed && !IMAGE_FILE_RE.test(rawEmbed.split(/[|#]/)[0] ?? "") && !searchMatchesBlock(state, line.from, line.to) && guard.canAdd(line.from, line.to)) {
				decos.push(
					Decoration.replace({
						widget: new TransclusionWidget(rawEmbed, filePath, isRead, currentThemeVersion(), transclusionVer(rawEmbed)),
						block: true,
					}).range(line.from, line.to),
				);
			}
		}
	}

	return Decoration.set(decos, true);
}

export const liveBlockField = StateField.define<DecorationSet>({
	create(state) {
		return buildBlockDecorations(state);
	},
	update(value, tr) {
		const refreshed = tr.effects.some((e) => e.is(refreshLiveEffect) || e.is(setRawEditBlockEffect));
		const rawChanged = tr.startState.field(rawEditBlockField, false) !== tr.state.field(rawEditBlockField, false);
		const searchChanged = searchStateSig(tr.startState) !== searchStateSig(tr.state);
		if (tr.docChanged || tr.selection || tr.reconfigured || refreshed || rawChanged || searchChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
			return buildBlockDecorations(tr.state);
		}
		return value;
	},
	provide: (f) => EditorView.decorations.from(f),
});

// --- Inline ViewPlugin (viewport-scoped token-level reveal) ------------------

function buildInlineDecorations(view: EditorView): DecorationSet {
	const state = view.state;
	const decos: Range<Decoration>[] = [];
	const guard = new ReplaceGuard(state.doc);
	const cb = state.facet(liveCallbacksFacet);
	const filePath = cb?.filePath() ?? "";
	const here = canonical(filePath);
	const root = appState.workspace?.root;
	const allDocs = docs();
	const fm = frontmatterRange(state);
	const fmEnd = fm?.to ?? -1;
	// Compute deduplicated heading anchors across the full document (`heading`, `heading-1`, `heading-2`)
	// matching `documentHeadings` / `outline.ts` / `markdownHtml.ts` so `data-md-heading-id` never collides.
	const headingAnchorsByLine = getDocHeadingAnchors(state.doc);

	// Broken link targets for this file (from docs listing).
	const brokenFiles = new Set((allDocs.find((d) => canonical(d.path) === here)?.broken ?? []).map((b) => linkFile(b.href)));
	// Ticket keys in this project for prose ticket-mention highlighting.
	const ticketMap = new Map<string, { path: string; about: string }>();
	for (const d of allDocs) {
		if (d.group === "tickets" && d.exists && d.ticket && canonical(d.path) !== here) {
			const title = d.title ?? "";
			const named = title.toLowerCase().startsWith(d.ticket.toLowerCase()) ? title : [d.ticket, title].filter(Boolean).join(": ");
			ticketMap.set(d.ticket, { path: d.path, about: `${named}${d.status ? ` (${d.status})` : ""}` });
		}
	}
	const matchTickets = ticketMap.size ? ticketMatcher([...ticketMap.keys()]) : null;

	// Separate whole-block skips (frontmatter, block widgets, fenced code) from inline-span skips
	// (`InlineCode`, `Link`) so a link or inline code span on a bullet/task line never suppresses the whole line!
	const blockSkipRanges: [number, number][] = [];
	const inlineSkipRanges: [number, number][] = [];
	if (fm) blockSkipRanges.push([0, fm.to + 1]);
	const blockDecos = state.field(liveBlockField, false);
	if (blockDecos) {
		blockDecos.between(0, state.doc.length, (bFrom, bTo, deco) => {
			if (deco.spec.widget && bFrom < bTo) blockSkipRanges.push([bFrom, bTo]);
		});
	}
	const isBlockSkipped = (from: number, to: number) => blockSkipRanges.some(([a, b]) => from < b && to > a);
	const isSkipped = (from: number, to: number) =>
		isBlockSkipped(from, to) || inlineSkipRanges.some(([a, b]) => from < b && to > a);

	const syntaxMark = Decoration.mark({ class: "cm-md-syntax" });
	const hideOrDim = (from: number, to: number, revealed: boolean) => {
		if (from >= to) return;
		if (revealed) {
			decos.push(syntaxMark.range(from, to));
			return;
		}
		// A plugin may not replace a line break (CodeMirror throws, and the throw takes the editor with it), so
		// syntax that runs over one is hidden a line at a time. A link whose `(url "title")` wraps is the case.
		for (const [segFrom, segTo] of lineSegments(from, to, (pos) => state.doc.lineAt(pos).to)) {
			if (guard.canAdd(segFrom, segTo)) decos.push(Decoration.replace({}).range(segFrom, segTo));
		}
	};

	// Pass 1: Syntax tree walk across visible ranges.
	const tree = syntaxTree(state);
	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.to <= fmEnd) return false;

				if (node.name === "Table") {
					const sLineObj = state.doc.lineAt(node.from);
					const eLineObj = state.doc.lineAt(node.to);
					const sLine = sLineObj.number;
					const eLine = eLineObj.number;
					if (isBlockSkipped(sLineObj.from, eLineObj.to)) {
						return false;
					}
					// Dim pipe separators when editing a table in Raw mode for calm readability.
					const pipeMark = Decoration.mark({ class: "cm-md-table-pipe" });
					for (let n = sLine; n <= eLine; n++) {
						const ln = state.doc.line(n);
						for (let i = 0; i < ln.text.length; i++) {
							if (ln.text[i] === "|" && ln.text[i - 1] !== "\\") {
								decos.push(pipeMark.range(ln.from + i, ln.from + i + 1));
							}
						}
					}
					return;
				}

				if (node.name === "Blockquote") {
					const firstLine = state.doc.lineAt(node.from);
					if (!parseCalloutHeader(firstLine.text)) return;
					let endLine = state.doc.lineAt(node.to);
					while (endLine.number > firstLine.number && !/^[ \t]{0,3}>/.test(endLine.text)) {
						endLine = state.doc.line(endLine.number - 1);
					}
					const blockTo = endLine.to;
					if (isBlockSkipped(firstLine.from, blockTo)) {
						// Only skip descending into children when the whole Blockquote node belongs to the callout.
						if (blockTo === node.to) return false;
					}
					return;
				}

				if (node.name === "FencedCode") {
					blockSkipRanges.push([node.from, node.to]);
					const startLine = state.doc.lineAt(node.from);
					const endLine = state.doc.lineAt(node.to);
					const open = parseFenceOpen(startLine.text);
					const lang = open?.lang ?? "";
					const quoted = Boolean(open?.quotePrefix.length);
					const hasClose =
						endLine.number > startLine.number &&
						(open ? isFenceClose(endLine.text, open.fenceChar, open.fenceLen, quoted) : /^[ \t]*[`~]{3,}[ \t]*$/.test(endLine.text));
					// When rendered as a MermaidWidget block decoration, skip line/header decorations.
					if (normalizeFenceLang(lang) === "mermaid" && hasClose && !selectionTouches(state, node.from, node.to) && !isRawEditing(state, node.from, node.to) && !searchMatchesBlock(state, node.from, node.to)) {
						return false;
					}
					const bodyEndLine = hasClose ? endLine.number - 1 : endLine.number;

					for (let n = startLine.number; n <= endLine.number; n++) {
						const ln = state.doc.line(n);
						const classes = ["cm-md-codeblock-line"];
						if (n === startLine.number) classes.push("cm-md-codeblock-first");
						if (n === endLine.number) classes.push("cm-md-codeblock-last");
						decos.push(Decoration.line({ class: classes.join(" ") }).range(ln.from));
					}
					if (!selectionTouches(state, startLine.from, startLine.to) && guard.canAdd(startLine.from, startLine.to)) {
						const canFormat = Boolean(fenceFormatTarget(lang)) && bodyEndLine >= startLine.number + 1;
						decos.push(
							Decoration.replace({
								widget: new CodeHeaderWidget(lang, startLine.from, startLine.number, canFormat, state.facet(readOnlyModeFacet)),
							}).range(startLine.from, startLine.to),
						);
					}
					if (hasClose && !selectionTouches(state, endLine.from, endLine.to) && guard.canAdd(endLine.from, endLine.to)) {
						decos.push(Decoration.replace({ widget: new HiddenFenceWidget() }).range(endLine.from, endLine.to));
					}
					return false;
				}

				if (node.name === "CommentBlock" || node.name === "Comment") {
					if (node.name === "CommentBlock") {
						const startLine = state.doc.lineAt(node.from);
						const endLine = state.doc.lineAt(node.to);
						if (isStandaloneHtmlComment(state.sliceDoc(startLine.from, endLine.to))) {
							// Standalone comment blocks are hidden (or styled when cursor enters) by `liveBlockField`.
							blockSkipRanges.push([node.from, node.to]);
							return false;
						}
					}
					const raw = state.sliceDoc(node.from, node.to);
					const commentMark = Decoration.mark({ class: "cm-md-comment" });
					for (const span of closedHtmlCommentSpans(raw)) {
						const cFrom = node.from + span.from;
						const cTo = node.from + span.to;
						inlineSkipRanges.push([cFrom, cTo]);
						const revealed = selectionTouches(state, cFrom, cTo);
						const firstLn = state.doc.lineAt(cFrom).number;
						const lastLn = state.doc.lineAt(cTo).number;
						for (let lnNum = firstLn; lnNum <= lastLn; lnNum++) {
							const ln = state.doc.line(lnNum);
							const segFrom = Math.max(cFrom, ln.from);
							const segTo = Math.min(cTo, ln.to);
							if (segFrom >= segTo) continue;
							if (revealed) {
								decos.push(commentMark.range(segFrom, segTo));
							} else if (guard.canAdd(segFrom, segTo)) {
								decos.push(Decoration.replace({}).range(segFrom, segTo));
							}
						}
					}
					return false;
				}

				if (node.name === "InlineCode") {
					inlineSkipRanges.push([node.from, node.to]);
					const revealed = selectionTouches(state, node.from, node.to);
					const marks: [number, number][] = [];
					for (let child = node.node.firstChild; child; child = child.nextSibling) {
						if (child.name === "CodeMark") marks.push([child.from, child.to]);
					}
					const contentFrom = marks[0]?.[1] ?? node.from;
					const contentTo = marks[marks.length - 1]?.[0] ?? node.to;
					if (contentFrom < contentTo) {
						decos.push(Decoration.mark({ class: "cm-md-code" }).range(contentFrom, contentTo));
					}
					for (const [mf, mt] of marks) hideOrDim(mf, mt, revealed);
					return false;
				}

				// ATX Headings H1..H6 (tag with deduplicated heading anchor id & hover `#` copy-link widget)
				const hMatch = /^ATXHeading([1-6])$/.exec(node.name);
				if (hMatch) {
					const level = Number(hMatch[1]);
					const line = state.doc.lineAt(node.from);
					const cleanHeading = line.text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/, "").replace(/[ \t]*#*[ \t]*$/, "").trim();
					const anchor = headingAnchorsByLine.get(line.number) ?? headingAnchor(cleanHeading);
					decos.push(
						Decoration.line({
							class: `cm-md-h${level}`,
							attributes: {
								"data-md-heading-line": String(line.number),
								...(anchor ? { "data-md-heading-id": anchor } : {}),
							},
						}).range(line.from),
					);
					if (cleanHeading) {
						decos.push(
							Decoration.widget({
								widget: new HeadingCopyLinkWidget(cleanHeading, filePath),
								side: 1,
							}).range(line.to),
						);
					}
					const revealed = selectionTouches(state, line.from, line.to);
					for (let child = node.node.firstChild; child; child = child.nextSibling) {
						if (child.name === "HeaderMark") {
							// Hide trailing space after opening `##` too so heading sits flush left.
							const isLeading = child.from === node.from;
							const end = isLeading && state.sliceDoc(child.to, child.to + 1) === " " ? child.to + 1 : child.to;
							hideOrDim(child.from, end, revealed);
						}
					}
					return;
				}

				// **Strong**
				if (node.name === "StrongEmphasis") {
					const revealed = selectionTouches(state, node.from, node.to);
					const marks: [number, number][] = [];
					for (let child = node.node.firstChild; child; child = child.nextSibling) {
						if (child.name === "EmphasisMark") marks.push([child.from, child.to]);
					}
					const innerFrom = marks[0]?.[1] ?? node.from;
					const innerTo = marks[marks.length - 1]?.[0] ?? node.to;
					if (innerFrom < innerTo) decos.push(Decoration.mark({ class: "cm-md-strong" }).range(innerFrom, innerTo));
					for (const [mf, mt] of marks) hideOrDim(mf, mt, revealed);
					return;
				}

				// *Italic*
				if (node.name === "Emphasis") {
					const revealed = selectionTouches(state, node.from, node.to);
					const marks: [number, number][] = [];
					for (let child = node.node.firstChild; child; child = child.nextSibling) {
						if (child.name === "EmphasisMark") marks.push([child.from, child.to]);
					}
					const innerFrom = marks[0]?.[1] ?? node.from;
					const innerTo = marks[marks.length - 1]?.[0] ?? node.to;
					if (innerFrom < innerTo) decos.push(Decoration.mark({ class: "cm-md-em" }).range(innerFrom, innerTo));
					for (const [mf, mt] of marks) hideOrDim(mf, mt, revealed);
					return;
				}

				// ~~Strikethrough~~
				if (node.name === "Strikethrough") {
					const revealed = selectionTouches(state, node.from, node.to);
					const marks: [number, number][] = [];
					for (let child = node.node.firstChild; child; child = child.nextSibling) {
						if (child.name === "StrikethroughMark") marks.push([child.from, child.to]);
					}
					const innerFrom = marks[0]?.[1] ?? node.from;
					const innerTo = marks[marks.length - 1]?.[0] ?? node.to;
					if (innerFrom < innerTo) decos.push(Decoration.mark({ class: "cm-md-strike" }).range(innerFrom, innerTo));
					for (const [mf, mt] of marks) hideOrDim(mf, mt, revealed);
					return;
				}

				// [label](url) links
				if (node.name === "Link") {
					const raw = state.sliceDoc(node.from, node.to);
					const urlNode = node.node.getChild("URL");
					const marks: { from: number; to: number; text: string }[] = [];
					for (let child = node.node.firstChild; child; child = child.nextSibling) {
						if (child.name === "LinkMark") marks.push({ from: child.from, to: child.to, text: state.sliceDoc(child.from, child.to) });
					}
					const openBracket = marks.find((m) => m.text === "[");
					const closeBracket = marks.find((m) => m.text === "]");
					if (!openBracket || !closeBracket || !urlNode) return;
					inlineSkipRanges.push([node.from, node.to]);
					const href = hrefWritten(state.sliceDoc(urlNode.from, urlNode.to));
					const file = linkFile(href);
					const isBroken = Boolean(file) && brokenFiles.has(file);
					const leads = linkLeads(href, here, root);
					const tooltip = isBroken
						? `File not found: ${file}`
						: leads && "web" in leads
							? `${leads.web} (Click to open, Alt+Click to edit)`
							: leads && "heading" in leads
								? `Jump to #${leads.heading} (Click to follow, Alt+Click to edit)`
								: leads && "file" in leads
									? `Open ${relativeTo(root, leads.file)} (Click to open, Alt+Click to edit)`
									: raw;
					const revealed = selectionTouches(state, node.from, node.to);
					const labelFrom = openBracket.to;
					const labelTo = closeBracket.from;
					if (labelFrom < labelTo) {
						decos.push(
							Decoration.mark({
								class: isBroken ? "cm-md-link-broken" : "cm-md-link",
								attributes: {
									"data-md-href": href,
									...(revealed ? { "data-md-revealed": "true" } : {}),
									title: tooltip,
								},
							}).range(labelFrom, labelTo),
						);
					}
					hideOrDim(openBracket.from, openBracket.to, revealed);
					hideOrDim(closeBracket.from, node.to, revealed);
					return false;
				}
			},
		});
	}

	// Pass 2: Line-level scans across visible ranges (bullets, checkboxes, blockquotes, ==highlights==, [[wikilinks]], #tags, ticket keys).
	const seenLines = new Set<number>();
	for (const { from, to } of view.visibleRanges) {
		let lineNum = state.doc.lineAt(from).number;
		const endNum = state.doc.lineAt(to).number;
		for (; lineNum <= endNum; lineNum++) {
			if (seenLines.has(lineNum)) continue;
			seenLines.add(lineNum);
			const line = state.doc.line(lineNum);
			if (line.from <= fmEnd || isBlockSkipped(line.from, line.to)) continue;
			const text = line.text;

			// Blockquotes (excluding callouts handled as blocks)
			const qMatch = QUOTE_RE.exec(text);
			if (qMatch && !parseCalloutHeader(text)) {
				decos.push(Decoration.line({ class: "cm-md-quote-line" }).range(line.from));
				const revealed = selectionTouches(state, line.from, line.to);
				hideOrDim(line.from, line.from + qMatch[1]!.length, revealed);
			}

			// Unordered bullets, ordered lists, and task checkboxes with exact hanging-indent alignment
			const listInfo = parseListLine(text);
			if (listInfo) {
				const prefixFrom = line.from + listInfo.quoteLen;
				const prefixTo = line.from + listInfo.markerTo;
				const markerFrom = line.from + listInfo.markerFrom;
				const cursorInPrefix = selectionTouches(state, prefixFrom, Math.max(prefixFrom, prefixTo - 1));
				decos.push(
					Decoration.line({
						class: cursorInPrefix ? "cm-md-list-line cm-md-list-raw" : "cm-md-list-line",
						attributes: {
							style: `--md-list-indent: ${listInfo.indentEm}em; --md-list-hang: ${listInfo.hangEm}em;`,
						},
					}).range(line.from),
				);
				if (listInfo.kind === "task") {
					const bracketPos = line.from + listInfo.bracketOffset!;
					const checked = Boolean(listInfo.checked);
					if (!cursorInPrefix && guard.canAdd(prefixFrom, prefixTo)) {
						decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, bracketPos) }).range(prefixFrom, prefixTo));
					} else if (cursorInPrefix) {
						decos.push(syntaxMark.range(markerFrom, prefixTo));
					}
					if (checked && prefixTo < line.to) {
						decos.push(Decoration.mark({ class: "cm-md-task-done" }).range(prefixTo, line.to));
					}
				} else if (listInfo.kind === "bullet") {
					if (cursorInPrefix) {
						decos.push(syntaxMark.range(markerFrom, markerFrom + listInfo.markerText.length));
					} else if (guard.canAdd(prefixFrom, prefixTo)) {
						decos.push(Decoration.replace({ widget: new BulletWidget() }).range(prefixFrom, prefixTo));
					}
				} else {
					if (cursorInPrefix) {
						decos.push(syntaxMark.range(markerFrom, markerFrom + listInfo.markerText.length));
					} else if (guard.canAdd(prefixFrom, prefixTo)) {
						decos.push(Decoration.replace({ widget: new OrderedMarkerWidget(listInfo.markerText) }).range(prefixFrom, prefixTo));
					}
				}
			}

			// Skip inline scans on heading syntax prefix
			const lineSkips: [number, number][] = [];

			// Inline images inside prose paragraphs (`![alt|120](src)` or `![[img.png|120]]`)
			if (text.includes("![") && !parseImageExpression(text)) {
				for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)\n]+)\)|!\[\[([^[\]\n]+)\]\]/g)) {
					const mFrom = line.from + m.index;
					const mTo = mFrom + m[0].length;
					if (isSkipped(mFrom, mTo)) continue;
					const parsed = parseImageExpression(m[0]);
					if (!parsed) continue;
					if (parsed.kind === "wiki" && !IMAGE_FILE_RE.test(parsed.src)) continue;
					lineSkips.push([mFrom, mTo]);
					const cleanSpec: ParsedImageSpec = parsed.kind === "md" ? { ...parsed, src: hrefWritten(parsed.src) } : parsed;
					if (!selectionTouches(state, mFrom, mTo) && guard.canAdd(mFrom, mTo)) {
						decos.push(
							Decoration.replace({
								widget: new ImageWidget(cleanSpec, mFrom, mTo, filePath, state.facet(readOnlyModeFacet), true),
							}).range(mFrom, mTo),
						);
					}
				}
			}

			// Inline math `$...$` (strictly skipping currency like `$100` / `$100 and $200` and code/links)
			if (text.includes("$")) {
				const isReadMode = state.facet(readOnlyModeFacet);
				for (const span of findInlineMathSpans(text)) {
					const mFrom = line.from + span.from;
					const mTo = line.from + span.to;
					if (isSkipped(mFrom, mTo) || lineSkips.some(([a, b]) => mFrom < b && mTo > a)) continue;
					lineSkips.push([mFrom, mTo]);
					if (!selectionTouches(state, mFrom, mTo) && guard.canAdd(mFrom, mTo)) {
						decos.push(
							Decoration.replace({
								widget: new MathWidget(span.tex, span.display, isReadMode),
							}).range(mFrom, mTo),
						);
					}
				}
			}

			// ==highlight==
			if (text.includes("==")) {
				for (const m of text.matchAll(/==([^\n=](?:[^\n]*?[^\n=])?)==/g)) {
					const mFrom = line.from + m.index;
					const mTo = mFrom + m[0].length;
					if (isSkipped(mFrom, mTo)) continue;
					const revealed = selectionTouches(state, mFrom, mTo);
					decos.push(Decoration.mark({ class: "cm-md-highlight" }).range(mFrom + 2, mTo - 2));
					hideOrDim(mFrom, mFrom + 2, revealed);
					hideOrDim(mTo - 2, mTo, revealed);
				}
			}

			// [[wikilinks]] including [[doc#heading]], [[#heading]], and [[target|alias]] (skip ![[embeds]])
			if (text.includes("[[")) {
				for (const m of text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
					if (m.index > 0 && text[m.index - 1] === "!") continue;
					const mFrom = line.from + m.index;
					const mTo = mFrom + m[0].length;
					if (isSkipped(mFrom, mTo)) continue;
					lineSkips.push([mFrom, mTo]);
					const innerRaw = m[1]!;
					const bar = innerRaw.indexOf("|");
					const targetPart = (bar < 0 ? innerRaw : innerRaw.slice(0, bar)).trim();
					const isSelfHeading = targetPart.startsWith("#") && targetPart.length > 1;
					const parsed = isSelfHeading ? null : namedLink(innerRaw.replace(/\\\|/g, "|"));
					const found = isSelfHeading ? { path: here, title: targetPart.slice(1) } : parsed ? docByName(parsed.name, allDocs, root) : null;
					const cls = found ? "cm-md-link" : "cm-md-link-missing";
					const tooltip = isSelfHeading
						? `Jump to ${targetPart} (Click to jump, Alt+Click to edit)`
						: found
							? `Open ${relativeTo(root, found.path)}${parsed?.heading ? ` › ${parsed.heading}` : ""} (Click to open, Alt+Click to edit)`
							: `No note named “${parsed?.name ?? targetPart}” — click to create it`;
					const revealed = selectionTouches(state, mFrom, mTo);
					if (!revealed && bar >= 0 && bar + 1 < innerRaw.length) {
						// Hide `[[target|` and `]]`, displaying only the clean alias!
						const aliasFrom = mFrom + 2 + bar + 1;
						const aliasTo = mTo - 2;
						hideOrDim(mFrom, aliasFrom, false);
						hideOrDim(aliasTo, mTo, false);
						if (aliasFrom < aliasTo) {
							decos.push(Decoration.mark({ class: cls, attributes: { "data-md-wiki": innerRaw, title: tooltip } }).range(aliasFrom, aliasTo));
						}
					} else {
						hideOrDim(mFrom, mFrom + 2, revealed);
						hideOrDim(mTo - 2, mTo, revealed);
						if (mFrom + 2 < mTo - 2) {
							decos.push(
								Decoration.mark({
									class: cls,
									attributes: {
										"data-md-wiki": innerRaw,
										...(revealed ? { "data-md-revealed": "true" } : {}),
										title: tooltip,
									},
								}).range(mFrom + 2, mTo - 2),
							);
						}
					}
				}
			}

			// Footnote definitions (`[^id]: ...`) and inline footnote refs (`[^id]`)
			const isReadMode = state.facet(readOnlyModeFacet);
			const fnDef = /^([ \t]{0,3})(\[\^([^\]\s]+)\]:)/.exec(text);
			if (fnDef) {
				const dFrom = line.from + fnDef[1]!.length;
				const dTo = dFrom + fnDef[2]!.length;
				if (!isSkipped(dFrom, dTo)) {
					lineSkips.push([dFrom, dTo]);
					if (isReadMode && !searchMatchesBlock(state, dFrom, dTo) && guard.canAdd(dFrom, dTo)) {
						decos.push(Decoration.line({ class: "cm-md-fn-def-line" }).range(line.from));
						decos.push(Decoration.replace({ widget: new FootnoteDefWidget(fnDef[3]!) }).range(dFrom, dTo));
					} else {
						decos.push(Decoration.mark({ class: "cm-md-footnote-def", attributes: { "data-md-fn-def": fnDef[3]! } }).range(dFrom, dTo));
					}
				}
			}
			if (text.includes("[^")) {
				for (const m of text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
					const rFrom = line.from + m.index;
					const rTo = rFrom + m[0].length;
					if (isSkipped(rFrom, rTo) || lineSkips.some(([a, b]) => rFrom < b && rTo > a)) continue;
					lineSkips.push([rFrom, rTo]);
					if (isReadMode && !searchMatchesBlock(state, rFrom, rTo) && guard.canAdd(rFrom, rTo)) {
						decos.push(Decoration.replace({ widget: new FootnoteRefWidget(m[1]!) }).range(rFrom, rTo));
					} else {
						decos.push(
							Decoration.mark({
								class: "cm-md-footnote-ref",
								attributes: {
									"data-md-footnote": m[1]!,
								},
							}).range(rFrom, rTo),
						);
					}
				}
			}

			// #tags in prose (not ATX heading hashes, not CSS hex colors, not inside links/code)
			if (text.includes("#") && !/^[ \t]{0,3}#{1,6}[ \t]/.test(text)) {
				for (const m of text.matchAll(/(^|[\s(])(#[A-Za-z][A-Za-z0-9_/-]*)/g)) {
					const leadLen = m[1]!.length;
					const tag = m[2]!;
					if (isLikelyHexColorTag(tag.slice(1))) continue;
					const tFrom = line.from + m.index + leadLen;
					const tTo = tFrom + tag.length;
					if (isSkipped(tFrom, tTo) || lineSkips.some(([a, b]) => tFrom < b && tTo > a)) continue;
					lineSkips.push([tFrom, tTo]);
					decos.push(
						Decoration.mark({
							class: "cm-md-tag",
							attributes: { "data-md-tag": tag, title: `Search workspace for ${tag}` },
						}).range(tFrom, tTo),
					);
				}
			}

			// Ticket key mentions (`DEMO-101`) outside links, wikilinks, tags, and code
			if (matchTickets) {
				for (const hit of matchTickets(text)) {
					const kFrom = line.from + hit.from;
					const kTo = line.from + hit.to;
					if (isSkipped(kFrom, kTo) || lineSkips.some(([a, b]) => kFrom < b && kTo > a)) continue;
					const info = ticketMap.get(hit.key);
					if (!info) continue;
					decos.push(
						Decoration.mark({
							class: "cm-md-ticket",
							attributes: { "data-md-ticket": hit.key, title: `${info.about} (Click to open, Alt+Click to edit)` },
						}).range(kFrom, kTo),
					);
				}
			}
		}
	}

	return Decoration.set(decos, true);
}

export const liveInlinePlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = buildInlineDecorations(view);
		}
		update(update: ViewUpdate) {
			const refreshed = update.transactions.some(
				(tr) => tr.reconfigured || tr.effects.some((e) => e.is(refreshLiveEffect) || e.is(setRawEditBlockEffect)),
			);
			const rawChanged = update.startState.field(rawEditBlockField, false) !== update.state.field(rawEditBlockField, false);
			const searchChanged = searchStateSig(update.startState) !== searchStateSig(update.state);
			if (
				update.docChanged ||
				update.selectionSet ||
				update.viewportChanged ||
				refreshed ||
				rawChanged ||
				searchChanged ||
				syntaxTree(update.startState) !== syntaxTree(update.state)
			) {
				this.decorations = buildInlineDecorations(update.view);
			}
		}
	},
	{ decorations: (v) => v.decorations },
);

// --- Interactive click & hover handlers --------------------------------------

const liveExtraBaseTheme = EditorView.baseTheme({
	".cm-md-fm-search-line": {
		fontFamily: "var(--code-font, ui-monospace, monospace)",
		fontSize: "0.86em",
		lineHeight: "1.55",
		backgroundColor: "color-mix(in srgb, var(--editor-fg, var(--fg)) 4%, var(--editor-bg, var(--bg)))",
		borderLeft: "2px solid color-mix(in srgb, var(--editor-accent, var(--accent)) 55%, transparent)",
		paddingLeft: "10px",
		paddingRight: "10px",
	},
	".cm-md-fm-search-first": {
		borderTopLeftRadius: "var(--radius-sm, 4px)",
		borderTopRightRadius: "var(--radius-sm, 4px)",
		paddingTop: "4px",
	},
	".cm-md-fm-search-last": {
		borderBottomLeftRadius: "var(--radius-sm, 4px)",
		borderBottomRightRadius: "var(--radius-sm, 4px)",
		paddingBottom: "4px",
		marginBottom: "8px",
	},
	".cm-md-fn-ref-read": {
		verticalAlign: "super",
		fontSize: "0.75em",
		lineHeight: "0",
		padding: "0 2px",
		borderRadius: "3px",
		color: "var(--editor-accent, var(--accent))",
		fontWeight: "600",
		cursor: "pointer",
	},
	".cm-md-fn-ref-read:hover": {
		backgroundColor: "color-mix(in srgb, var(--editor-accent, var(--accent)) 14%, transparent)",
		textDecoration: "underline",
	},
	".cm-md-fn-def-line": {
		paddingLeft: "10px",
		borderLeft: "2px solid color-mix(in srgb, var(--editor-border, var(--border)) 85%, transparent)",
		fontSize: "0.92em",
		color: "var(--editor-muted, var(--muted))",
	},
	".cm-md-fn-def-read": {
		display: "inline-block",
		minWidth: "1.4em",
		marginRight: "4px",
		fontFamily: "var(--ui-font)",
		fontWeight: "700",
		color: "var(--editor-accent, var(--accent))",
		cursor: "pointer",
	},
	".cm-md-fn-def-read:hover": {
		textDecoration: "underline",
	},
});

export const liveInteractionExtension: Extension = [
	liveExtraBaseTheme,
	// Keep user cursor navigation, Backspace, and Live-mode Replace / Replace All cleanly outside hidden YAML frontmatter.
	EditorState.transactionFilter.of((tr) => {
		if (tr.docChanged && tr.isUserEvent("input.replace")) {
			const cb = tr.startState.facet(liveCallbacksFacet);
			const fmStart = frontmatterRange(tr.startState);
			if (fmStart && !cb?.isYamlEditorOpen?.() && !searchMatchesBlock(tr.startState, fmStart.from, fmStart.to)) {
				const kept: ChangeSpec[] = [];
				let skipped = 0;
				tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
					if (fromA <= fmStart.to) {
						skipped++;
					} else {
						kept.push({ from: fromA, to: toA, insert: inserted.toString() });
					}
				});
				if (skipped > 0) {
					queueMicrotask(() =>
						notify(
							`Skipped ${skipped} ${skipped === 1 ? "match" : "matches"} in hidden YAML frontmatter (click Edit YAML to modify properties).`,
						),
					);
					if (!kept.length) return [];
					return {
						changes: kept,
						effects: tr.effects,
						annotations: [Transaction.userEvent.of("input.replace.all")],
					};
				}
			}
		}
		if (tr.isUserEvent("delete.backward")) {
			const fmStart = frontmatterRange(tr.startState);
			if (fmStart && !searchMatchesBlock(tr.startState, fmStart.from, fmStart.to)) {
				const bodyStart = Math.min(tr.startState.doc.length, fmStart.to + 1);
				const prev = tr.startState.selection.main;
				if (prev.empty && prev.head <= bodyStart) return [];
			}
		}
		if (tr.docChanged || !tr.selection) return tr;
		const fm = frontmatterRange(tr.state);
		if (!fm || searchMatchesBlock(tr.state, fm.from, fm.to)) return tr;
		const bodyStart = Math.min(tr.state.doc.length, fm.to + 1);
		if (bodyStart <= fm.to) return tr;
		const main = tr.selection.main;
		if (main.anchor <= fm.to || main.head <= fm.to) {
			return [
				tr,
				{
					selection: EditorSelection.range(
						Math.max(main.anchor, bodyStart),
						Math.max(main.head, bodyStart),
					),
				},
			];
		}
		return tr;
	}),
	EditorView.domEventHandlers({
	mousedown(event, view) {
		if (event.button !== 0 || event.altKey) return false;
		const cb = view.state.facet(liveCallbacksFacet);
		if (!cb) return false;
		const el = event.target instanceof Element ? event.target : null;
		if (!el) return false;

		const wikiEl = el.closest<HTMLElement>("[data-md-wiki]");
		if (wikiEl) {
			if (wikiEl.dataset.mdRevealed === "true" && !event.ctrlKey && !event.metaKey) return false;
			event.preventDefault();
			cb.onFollowWiki(wikiEl.dataset.mdWiki ?? "");
			return true;
		}
		const hrefEl = el.closest<HTMLElement>("[data-md-href]");
		if (hrefEl) {
			if (hrefEl.dataset.mdRevealed === "true" && !event.ctrlKey && !event.metaKey) return false;
			event.preventDefault();
			cb.onFollowLink(hrefEl.dataset.mdHref ?? "");
			return true;
		}
		const ticketEl = el.closest<HTMLElement>("[data-md-ticket]");
		if (ticketEl) {
			event.preventDefault();
			cb.onFollowTicket(ticketEl.dataset.mdTicket ?? "");
			return true;
		}
		const tagEl = el.closest<HTMLElement>("[data-md-tag]");
		if (tagEl) {
			event.preventDefault();
			cb.onTagClick(tagEl.dataset.mdTag ?? "");
			return true;
		}
		const fnEl = el.closest<HTMLElement>("[data-md-footnote]");
		if (fnEl) {
			const id = fnEl.dataset.mdFootnote ?? "";
			if (id) {
				const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const defRe = new RegExp(`^[ \\t]{0,3}\\[\\^${escaped}\\]:`);
				const fmEndLine = frontmatterRange(view.state)?.lines ?? 0;
				let openFence: { ch: string; len: number } | null = null;
				for (let n = fmEndLine + 1; n <= view.state.doc.lines; n++) {
					const ln = view.state.doc.line(n);
					const fm = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(ln.text);
					if (fm) {
						if (!openFence) openFence = { ch: fm[1]![0]!, len: fm[1]!.length };
						else if (fm[1]![0] === openFence.ch && fm[1]!.length >= openFence.len && fm[2]!.trim() === "") openFence = null;
						continue;
					}
					if (openFence) continue;
					if (defRe.test(ln.text)) {
						event.preventDefault();
						const fp = cb?.filePath();
						if (fp) {
							const curLn = view.state.doc.lineAt(view.state.selection.main.head);
							noteCursor({ path: fp, line: curLn.number, column: view.state.selection.main.head - curLn.from + 1 });
						}
						view.dispatch({ selection: EditorSelection.cursor(ln.from), effects: EditorView.scrollIntoView(ln.from, { y: "center" }) });
						return true;
					}
				}
			}
		}
		const fnDefEl = el.closest<HTMLElement>("[data-md-fn-def]");
		if (fnDefEl) {
			const id = fnDefEl.dataset.mdFnDef ?? "";
			if (id) {
				const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const refRe = new RegExp(`\\[\\^${escaped}\\](?!:)`);
				const fmEndLine = frontmatterRange(view.state)?.lines ?? 0;
				let openFence: { ch: string; len: number } | null = null;
				for (let n = fmEndLine + 1; n <= view.state.doc.lines; n++) {
					const ln = view.state.doc.line(n);
					const fm = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(ln.text);
					if (fm) {
						if (!openFence) openFence = { ch: fm[1]![0]!, len: fm[1]!.length };
						else if (fm[1]![0] === openFence.ch && fm[1]!.length >= openFence.len && fm[2]!.trim() === "") openFence = null;
						continue;
					}
					if (openFence) continue;
					const hit = refRe.exec(ln.text);
					if (hit) {
						event.preventDefault();
						const fp = cb?.filePath();
						if (fp) {
							const curLn = view.state.doc.lineAt(view.state.selection.main.head);
							noteCursor({ path: fp, line: curLn.number, column: view.state.selection.main.head - curLn.from + 1 });
						}
						const pos = ln.from + hit.index;
						view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "center" }) });
						return true;
					}
				}
			}
		}
		return false;
	},
	mouseover(event, view) {
		const cb = view.state.facet(liveCallbacksFacet);
		if (!cb) return false;
		const el = event.target instanceof Element ? event.target : null;
		if (!el) return false;
		const wikiEl = el.closest<HTMLElement>("[data-md-wiki]");
		if (wikiEl) {
			cb.onHoverLink({ kind: "wiki", inner: wikiEl.dataset.mdWiki ?? "", anchor: wikiEl });
			return false;
		}
		const hrefEl = el.closest<HTMLElement>("[data-md-href]");
		if (hrefEl) {
			cb.onHoverLink({ kind: "href", href: hrefEl.dataset.mdHref ?? "", anchor: hrefEl });
			return false;
		}
		const ticketEl = el.closest<HTMLElement>("[data-md-ticket]");
		if (ticketEl) {
			cb.onHoverLink({ kind: "ticket", key: ticketEl.dataset.mdTicket ?? "", anchor: ticketEl });
			return false;
		}
		return false;
	},
	mouseout(event, view) {
		const cb = view.state.facet(liveCallbacksFacet);
		if (!cb) return false;
		const el = event.target instanceof Element ? event.target : null;
		if (el?.closest("[data-md-wiki], [data-md-href], [data-md-ticket]")) {
			cb.onHoverLeave();
		}
		return false;
	},
	}),
];

// --- Heading & nested list folding -------------------------------------------

const HEADING_FOLD_RE = /^[ \t]{0,3}(#{1,6})[ \t]+/;
const LIST_FOLD_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;

export const markdownFoldService: Extension = [
	foldService.of((state, lineStart) => {
		const line = state.doc.lineAt(lineStart);
		const text = line.text;
		// Early-return before touching full-document caches when the line is neither a heading nor a list item.
		const hMatch = HEADING_FOLD_RE.exec(text);
		const listMatch = hMatch ? null : LIST_FOLD_RE.exec(text);
		if (!hMatch && !listMatch) return null;

		// Skip lines inside fenced code blocks so `# comments` in bash/python/yaml fences never fold or terminate heading folds.
		const codeFences = getDocFences(state.doc);
		const insideFence = (pos: number) => posInRanges(codeFences, pos);
		if (insideFence(line.from)) return null;

		// 1. ATX Heading folds everything until the next heading of equal or higher level (outside code fences).
		if (hMatch) {
			const level = hMatch[1]!.length;
			let endLine = line.number;
			for (let n = line.number + 1; n <= state.doc.lines; n++) {
				const next = state.doc.line(n);
				if (!insideFence(next.from)) {
					const nh = HEADING_FOLD_RE.exec(next.text);
					if (nh && nh[1]!.length <= level) break;
				}
				endLine = n;
			}
			while (endLine > line.number && !state.doc.line(endLine).text.trim()) endLine--;
			if (endLine > line.number) return { from: line.to, to: state.doc.line(endLine).to };
			return null;
		}

		// 2. Indented list item folds nested child items below it.
		if (listMatch) {
			const baseIndent = listMatch[1]!.replace(/\t/g, "  ").length;
			let endLine = line.number;
			for (let n = line.number + 1; n <= state.doc.lines; n++) {
				const next = state.doc.line(n);
				if (!next.text.trim()) {
					endLine = n;
					continue;
				}
				const indent = (/^[ \t]*/.exec(next.text)![0]).replace(/\t/g, "  ").length;
				if (indent <= baseIndent) break;
				endLine = n;
			}
			while (endLine > line.number && !state.doc.line(endLine).text.trim()) endLine--;
			if (endLine > line.number) return { from: line.to, to: state.doc.line(endLine).to };
		}
		return null;
	}),
	foldGutter({
		markerDOM(open) {
			const el = document.createElement("span");
			el.className = "codicon-glyph";
			el.dataset.folded = open ? "false" : "true";
			el.title = open ? "Fold section" : "Unfold section";
			el.textContent = open ? "\ueab4" : "\ueab6";
			return el;
		},
	}),
];

/** Finds a Markdown link, wikilink, or ticket mention under the given document offset. */
export function linkAtOffset(
	state: EditorState,
	offset: number,
): { kind: "href"; href: string } | { kind: "wiki"; inner: string } | { kind: "ticket"; key: string } | null {
	const line = state.doc.lineAt(offset);
	const col = offset - line.from;
	const text = line.text;

	// Check [[wikilinks]]
	for (const m of text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
		if (col >= m.index && col <= m.index + m[0].length) return { kind: "wiki", inner: m[1]! };
	}
	// Check [label](url)
	for (const m of text.matchAll(/\[([^[\]\n]*)\]\(([^)\n]+)\)/g)) {
		if (col >= m.index && col <= m.index + m[0].length) return { kind: "href", href: hrefWritten(m[2]!) };
	}
	// Check ticket key mentions
	const ticketKeys = docs()
		.filter((d) => d.group === "tickets" && d.exists && d.ticket)
		.map((d) => d.ticket!);
	if (ticketKeys.length) {
		for (const hit of ticketMatcher(ticketKeys)(text)) {
			if (col >= hit.from && col <= hit.to) return { kind: "ticket", key: hit.key };
		}
	}
	return null;
}
