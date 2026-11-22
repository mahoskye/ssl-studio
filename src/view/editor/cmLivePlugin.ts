// Obsidian-grade Live Preview extensions for CodeMirror 6 (ADR 0028):
// - StateField (`liveBlockField`): multi-line block decorations (collapsed YAML frontmatter,
//   rendered GFM tables, Obsidian callouts, horizontal rules, standalone inline images).
// - ViewPlugin (`liveInlinePlugin`): viewport-scoped token-level reveal for headings, bold,
//   italic, strikethrough, inline code, ==highlight==, #tags, links, [[wikilinks]], ticket
//   mentions, fenced code headers, bullets, clickable task checkboxes, and blockquotes.
// - FoldService (`markdownFoldService`): heading section & nested list folding.
import { foldGutter, foldService, syntaxTree } from "@codemirror/language";
import { EditorSelection, Facet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { fenced } from "../../shared/catalog";
import { hrefWritten, linkFile, linkLeads, linkWritten } from "../../shared/docLinks";
import { frontMatter } from "../../shared/frontMatter";
import { parseCalloutHeader, type ParsedCallout } from "../../shared/markdownEdit";
import { docByName, namedLink } from "../../shared/namedLinks";
import { dirName, isInside, joinPath, relativePath, relativeTo, resolvePath } from "../../shared/paths";
import { ticketMatcher } from "../../shared/ticketRefs";
import { backend } from "../backend";
import { docs } from "../project";
import { canonical, state as appState } from "../state";
import { finishMarkdown, type NameResolver, type TicketRef } from "./markdownHtml";

export type HoverTarget =
	| { kind: "href"; href: string; anchor: HTMLElement }
	| { kind: "wiki"; inner: string; anchor: HTMLElement }
	| { kind: "ticket"; key: string; anchor: HTMLElement };

export type LiveCallbacks = {
	filePath: () => string;
	onFollowLink: (href: string) => void;
	onFollowWiki: (inner: string) => void;
	onFollowTicket: (key: string) => void;
	onTagClick: (tag: string) => void;
	onHoverLink: (target: HoverTarget) => void;
	onHoverLeave: () => void;
	onCopyCode: (code: string) => void;
};

export const liveCallbacksFacet = Facet.define<LiveCallbacks, LiveCallbacks | null>({
	combine: (values) => values[0] ?? null,
});

/** Effect dispatched whenever workspace `docs()` or broken-link status changes. */
export const refreshLiveEffect = StateEffect.define<number>();
/** Effect toggling raw YAML frontmatter visibility inside the editor. */
export const setEditYamlEffect = StateEffect.define<boolean>();

export const editYamlField = StateField.define<boolean>({
	create: () => false,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setEditYamlEffect)) return e.value;
		return value;
	},
});

const RULE_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TASK_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([ xX])\]([ \t]?)/;
const BULLET_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*)([-*+])([ \t]+)/;
const QUOTE_RE = /^([ \t]*>[ \t]?)/;
const IMG_MD_RE = /^[ \t]*!\[([^\]]*)\]\(([^)\n]+)\)[ \t]*$/;
const IMG_WIKI_RE = /^[ \t]*!\[\[([^[\]\n]+)\]\][ \t]*$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

/** True when any selection cursor or range touches `[from, to]`. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
	for (const r of state.selection.ranges) {
		if (r.from <= to && r.to >= from) return true;
	}
	return false;
}

/** Tracks non-overlapping `Decoration.replace` spans so CM6 never throws on overlap. */
class ReplaceGuard {
	private spans: [number, number][] = [];
	canAdd(from: number, to: number): boolean {
		if (from > to) return false;
		for (const [a, b] of this.spans) {
			if (from < b && to > a) return false;
			if (from === to && from >= a && from <= b) return false;
		}
		this.spans.push([from, to]);
		return true;
	}
}

/** Computes frontmatter byte range (`0..endLine.to`) if valid YAML frontmatter exists. */
function frontmatterRange(state: EditorState): { lines: number; from: number; to: number } | null {
	const fm = frontMatter(state.doc.toString());
	if (!fm.lines || fm.lines > state.doc.lines) return null;
	const endLine = state.doc.line(fm.lines);
	return { lines: fm.lines, from: 0, to: endLine.to };
}

/** Builds `finishMarkdown` options for nested HTML widgets (tables, callouts). */
function renderInlineHtml(markdown: string, filePath: string): string {
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
	const raw = DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }) as string);
	return finishMarkdown(raw, { tickets, named });
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

class TableWidget extends WidgetType {
	constructor(
		private readonly raw: string,
		private readonly startLine: number,
		private readonly filePath: string,
	) {
		super();
	}
	eq(other: TableWidget) {
		return other.raw === this.raw && other.startLine === this.startLine && other.filePath === this.filePath;
	}
	toDOM(view: EditorView) {
		const wrap = document.createElement("div");
		wrap.className = "cm-md-table-wrap";
		wrap.innerHTML = renderInlineHtml(this.raw, this.filePath);
		const cb = view.state.facet(liveCallbacksFacet);
		wrap.addEventListener("mousedown", (e) => {
			const target = e.target as HTMLElement | null;
			const anchor = target?.closest<HTMLAnchorElement>("a[href]");
			const tag = target?.closest<HTMLElement>(".md-tag");
			if (anchor && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				cb?.onFollowLink(anchor.getAttribute("href") ?? "");
				return;
			}
			if (tag && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				const label = tag.dataset.tag ?? tag.textContent?.trim() ?? "";
				if (label) cb?.onTagClick(label);
				return;
			}
			// Jump straight to the exact Markdown line of the clicked table row.
			e.preventDefault();
			const tr = target?.closest("tr");
			const rows = [...wrap.querySelectorAll("tr")];
			const rowIdx = tr ? rows.indexOf(tr) : 0;
			// Row 0 is header (startLine); row 1+ is body (skipping separator line at startLine + 1).
			const lineNum = Math.min(view.state.doc.lines, this.startLine + (rowIdx <= 0 ? 0 : rowIdx + 1));
			const line = view.state.doc.line(lineNum);
			view.focus();
			view.dispatch({ selection: EditorSelection.cursor(line.from), scrollIntoView: true });
		});
		wrap.addEventListener("mouseover", (e) => {
			const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
			if (anchor) cb?.onHoverLink({ kind: "href", href: anchor.getAttribute("href") ?? "", anchor });
		});
		wrap.addEventListener("mouseout", (e) => {
			const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
			if (anchor) cb?.onHoverLeave();
		});
		return wrap;
	}
	ignoreEvent() {
		return true;
	}
}

class CalloutWidget extends WidgetType {
	constructor(
		private readonly parsed: ParsedCallout,
		private readonly bodyMarkdown: string,
		private readonly startLine: number,
		private readonly filePath: string,
	) {
		super();
	}
	eq(other: CalloutWidget) {
		return (
			other.parsed.spec.type === this.parsed.spec.type &&
			other.parsed.title === this.parsed.title &&
			other.parsed.fold === this.parsed.fold &&
			other.bodyMarkdown === this.bodyMarkdown &&
			other.startLine === this.startLine &&
			other.filePath === this.filePath
		);
	}
	toDOM(view: EditorView) {
		const card = document.createElement("div");
		card.className = `cm-md-callout tone-${this.parsed.spec.tone}`;
		const head = document.createElement("div");
		head.className = "cm-md-callout-head";

		const icon = document.createElement("span");
		icon.className = "cm-md-callout-icon";
		icon.setAttribute("aria-hidden", "true");
		icon.textContent = this.parsed.spec.icon;
		head.appendChild(icon);

		const title = document.createElement("span");
		title.textContent = this.parsed.title;
		head.appendChild(title);

		let folded = this.parsed.fold === "-";
		let foldBtn: HTMLButtonElement | null = null;
		const body = document.createElement("div");
		body.className = "cm-md-callout-body";
		if (this.bodyMarkdown.trim()) body.innerHTML = renderInlineHtml(this.bodyMarkdown, this.filePath);
		if (folded) body.style.display = "none";

		if (this.parsed.fold) {
			foldBtn = document.createElement("button");
			foldBtn.type = "button";
			foldBtn.className = "cm-md-callout-fold";
			foldBtn.setAttribute("aria-label", folded ? "Expand callout" : "Collapse callout");
			foldBtn.textContent = folded ? "\ueab6" : "\ueab4";
			foldBtn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				folded = !folded;
				body.style.display = folded ? "none" : "";
				foldBtn!.textContent = folded ? "\ueab6" : "\ueab4";
				foldBtn!.setAttribute("aria-label", folded ? "Expand callout" : "Collapse callout");
			});
			head.appendChild(foldBtn);
		}

		card.appendChild(head);
		if (this.bodyMarkdown.trim()) card.appendChild(body);

		const cb = view.state.facet(liveCallbacksFacet);
		card.addEventListener("mousedown", (e) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest(".cm-md-callout-fold")) return;
			const anchor = target?.closest<HTMLAnchorElement>("a[href]");
			const tag = target?.closest<HTMLElement>(".md-tag");
			if (anchor && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				cb?.onFollowLink(anchor.getAttribute("href") ?? "");
				return;
			}
			if (tag && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				const label = tag.dataset.tag ?? tag.textContent?.trim() ?? "";
				if (label) cb?.onTagClick(label);
				return;
			}
			e.preventDefault();
			const targetLine = Math.min(view.state.doc.lines, target?.closest(".cm-md-callout-body") ? this.startLine + 1 : this.startLine);
			const line = view.state.doc.line(targetLine);
			view.focus();
			view.dispatch({ selection: EditorSelection.cursor(line.to), scrollIntoView: true });
		});
		card.addEventListener("mouseover", (e) => {
			const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
			if (anchor) cb?.onHoverLink({ kind: "href", href: anchor.getAttribute("href") ?? "", anchor });
		});
		card.addEventListener("mouseout", (e) => {
			const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
			if (anchor) cb?.onHoverLeave();
		});
		return card;
	}
	ignoreEvent() {
		return true;
	}
}

const imageUrlCache = new Map<string, string>();

class ImageWidget extends WidgetType {
	constructor(
		private readonly src: string,
		private readonly alt: string,
		private readonly pos: number,
		private readonly filePath: string,
	) {
		super();
	}
	eq(other: ImageWidget) {
		return other.src === this.src && other.alt === this.alt && other.pos === this.pos && other.filePath === this.filePath;
	}
	toDOM(view: EditorView) {
		const wrap = document.createElement("div");
		wrap.className = "cm-md-image-wrap";
		const img = document.createElement("img");
		img.alt = this.alt || this.src;
		wrap.appendChild(img);
		if (this.alt) {
			const cap = document.createElement("div");
			cap.className = "cm-md-image-caption";
			cap.textContent = this.alt;
			wrap.appendChild(cap);
		}
		if (/^https?:\/\//i.test(this.src) || /^data:image\//i.test(this.src)) {
			img.src = this.src;
		} else {
			const root = appState.workspace?.root;
			const target = root
				? this.src.startsWith("/")
					? joinPath(root, ...this.src.split("/").filter(Boolean))
					: resolvePath(dirName(this.filePath), this.src)
				: "";
			if (target && root && isInside(root, target)) {
				const cached = imageUrlCache.get(target);
				if (cached) {
					img.src = cached;
				} else {
					void backend
						.image(target)
						.then(({ type, base64 }) => {
							const dataUrl = `data:${type};base64,${base64}`;
							imageUrlCache.set(target, dataUrl);
							img.src = dataUrl;
						})
						.catch(() => {
							img.remove();
							const err = document.createElement("div");
							err.className = "cm-md-image-caption";
							err.textContent = `Image not found: ${this.src}`;
							wrap.prepend(err);
						});
				}
			}
		}
		wrap.addEventListener("mousedown", (e) => {
			e.preventDefault();
			view.focus();
			view.dispatch({ selection: EditorSelection.cursor(Math.min(this.pos, view.state.doc.length)), scrollIntoView: true });
		});
		return wrap;
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
		const input = document.createElement("input");
		input.type = "checkbox";
		input.className = "cm-md-checkbox";
		input.checked = this.checked;
		input.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
		input.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const pos = this.bracketPos;
			if (pos + 2 > view.state.doc.length) return;
			const ch = view.state.sliceDoc(pos + 1, pos + 2);
			const next = ch === " " ? "x" : " ";
			view.dispatch({
				changes: { from: pos + 1, to: pos + 2, insert: next },
				userEvent: "input.checkbox",
			});
		});
		return input;
	}
	ignoreEvent() {
		return true;
	}
}

class CodeHeaderWidget extends WidgetType {
	constructor(
		private readonly lang: string,
		private readonly code: string,
		private readonly linePos: number,
	) {
		super();
	}
	eq(other: CodeHeaderWidget) {
		return other.lang === this.lang && other.code === this.code && other.linePos === this.linePos;
	}
	toDOM(view: EditorView) {
		const bar = document.createElement("span");
		bar.className = "cm-md-code-header";
		const label = document.createElement("span");
		label.className = "cm-md-code-lang";
		label.textContent = this.lang || "code";
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "cm-md-code-copy";
		btn.textContent = "Copy";
		btn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const cb = view.state.facet(liveCallbacksFacet);
			cb?.onCopyCode(this.code);
			btn.textContent = "Copied";
			setTimeout(() => {
				if (btn.isConnected) btn.textContent = "Copy";
			}, 1400);
		});
		bar.addEventListener("mousedown", (e) => {
			if ((e.target as HTMLElement | null)?.closest("button")) return;
			e.preventDefault();
			view.focus();
			view.dispatch({ selection: EditorSelection.cursor(Math.min(this.linePos, view.state.doc.length)) });
		});
		bar.append(label, btn);
		return bar;
	}
	ignoreEvent() {
		return true;
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

// --- Block StateField (multi-line & block widgets) ---------------------------

function buildBlockDecorations(state: EditorState): DecorationSet {
	const decos: Range<Decoration>[] = [];
	const guard = new ReplaceGuard();
	const cb = state.facet(liveCallbacksFacet);
	const filePath = cb?.filePath() ?? "";
	const fm = frontmatterRange(state);
	const editYaml = state.field(editYamlField, false) ?? false;

	// 1. YAML Frontmatter: hidden into zero-height block widget unless editing YAML or cursor enters it.
	if (fm) {
		const cursorInFm = selectionTouches(state, fm.from, fm.to);
		if (!editYaml && !cursorInFm) {
			if (guard.canAdd(fm.from, fm.to)) {
				decos.push(Decoration.replace({ widget: new HiddenFrontmatterWidget(), block: true }).range(fm.from, fm.to));
			}
		} else {
			for (let n = 1; n <= fm.lines; n++) {
				decos.push(Decoration.line({ class: "cm-md-frontmatter-line" }).range(state.doc.line(n).from));
			}
		}
	}

	const fmEnd = fm?.to ?? -1;
	const docText = state.doc.toString();
	const fences = fenced(docText);
	const inFence = (pos: number) => fences.some(([a, b]) => pos >= a && pos < b);

	// 2. Walk syntax tree for multi-line Table, Callout (Blockquote), and HorizontalRule nodes.
	const tree = syntaxTree(state);
	tree.iterate({
		enter(node) {
			if (node.from <= fmEnd) return false;
			if (node.name === "FencedCode") return false;

			if (node.name === "Table") {
				if (!selectionTouches(state, node.from, node.to) && guard.canAdd(node.from, node.to)) {
					const raw = state.sliceDoc(node.from, node.to);
					const startLine = state.doc.lineAt(node.from).number;
					decos.push(Decoration.replace({ widget: new TableWidget(raw, startLine, filePath), block: true }).range(node.from, node.to));
				}
				return false;
			}

			if (node.name === "Blockquote") {
				const firstLine = state.doc.lineAt(node.from);
				const parsed = parseCalloutHeader(firstLine.text);
				if (!parsed) return;
				if (!selectionTouches(state, node.from, node.to) && guard.canAdd(node.from, node.to)) {
					const endLine = state.doc.lineAt(node.to);
					const bodyLines: string[] = [];
					for (let n = firstLine.number + 1; n <= endLine.number; n++) {
						bodyLines.push(state.doc.line(n).text.replace(/^[ \t]{0,3}>[ \t]?/, ""));
					}
					decos.push(
						Decoration.replace({
							widget: new CalloutWidget(parsed, bodyLines.join("\n"), firstLine.number, filePath),
							block: true,
						}).range(node.from, node.to),
					);
				}
				return false;
			}

			if (node.name === "HorizontalRule") {
				if (!selectionTouches(state, node.from, node.to) && guard.canAdd(node.from, node.to)) {
					decos.push(Decoration.replace({ widget: new HrWidget(node.from), block: true }).range(node.from, node.to));
				}
				return false;
			}
		},
	});

	// 3. Standalone image lines (`![alt](src)` or `![[image.png]]`).
	const startLineNum = fm ? fm.lines + 1 : 1;
	for (let n = startLineNum; n <= state.doc.lines; n++) {
		const line = state.doc.line(n);
		if (!line.text.includes("![")) continue;
		if (inFence(line.from) || selectionTouches(state, line.from, line.to)) continue;
		let src = "";
		let alt = "";
		const md = IMG_MD_RE.exec(line.text);
		if (md) {
			alt = md[1]!.trim();
			src = hrefWritten(md[2]!);
		} else {
			const wiki = IMG_WIKI_RE.exec(line.text);
			if (wiki) {
				const parts = wiki[1]!.split("|");
				const target = parts[0]!.trim();
				if (IMAGE_EXT_RE.test(target)) {
					src = target;
					alt = parts[1]?.trim() ?? "";
				}
			}
		}
		if (src && guard.canAdd(line.from, line.to)) {
			decos.push(Decoration.replace({ widget: new ImageWidget(src, alt, line.from, filePath), block: true }).range(line.from, line.to));
		}
	}

	return Decoration.set(decos, true);
}

export const liveBlockField = StateField.define<DecorationSet>({
	create(state) {
		return buildBlockDecorations(state);
	},
	update(value, tr) {
		const refreshed = tr.effects.some((e) => e.is(refreshLiveEffect) || e.is(setEditYamlEffect));
		if (tr.docChanged || tr.selection || refreshed || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
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
	const guard = new ReplaceGuard();
	const cb = state.facet(liveCallbacksFacet);
	const filePath = cb?.filePath() ?? "";
	const here = canonical(filePath);
	const root = appState.workspace?.root;
	const allDocs = docs();
	const fm = frontmatterRange(state);
	const fmEnd = fm?.to ?? -1;

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

	// Track code-block and callout ranges so inline regex passes skip them.
	const skipRanges: [number, number][] = [];
	if (fm) skipRanges.push([0, fm.to + 1]);
	const isSkipped = (from: number, to: number) => skipRanges.some(([a, b]) => from < b && to > a);

	const syntaxMark = Decoration.mark({ class: "cm-md-syntax" });
	const hideOrDim = (from: number, to: number, revealed: boolean) => {
		if (from >= to) return;
		if (revealed) {
			decos.push(syntaxMark.range(from, to));
		} else if (guard.canAdd(from, to)) {
			decos.push(Decoration.replace({}).range(from, to));
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
					if (!selectionTouches(state, node.from, node.to)) {
						skipRanges.push([node.from, node.to]);
						return false;
					}
					return;
				}

				if (node.name === "FencedCode") {
					skipRanges.push([node.from, node.to]);
					const startLine = state.doc.lineAt(node.from);
					const endLine = state.doc.lineAt(node.to);
					const openText = startLine.text;
					const closeText = endLine.text;
					const langMatch = /^[ \t]*[`~]{3,}[ \t]*([^\s`~]*)/.exec(openText);
					const lang = langMatch?.[1] ?? "";
					const hasClose = endLine.number > startLine.number && /^[ \t]*[`~]{3,}[ \t]*$/.test(closeText);
					const codeLines: string[] = [];
					const bodyEndLine = hasClose ? endLine.number - 1 : endLine.number;
					for (let n = startLine.number + 1; n <= bodyEndLine; n++) codeLines.push(state.doc.line(n).text);
					const codeText = codeLines.join("\n");

					for (let n = startLine.number; n <= endLine.number; n++) {
						const ln = state.doc.line(n);
						const classes = ["cm-md-codeblock-line"];
						if (n === startLine.number) classes.push("cm-md-codeblock-first");
						if (n === endLine.number) classes.push("cm-md-codeblock-last");
						decos.push(Decoration.line({ class: classes.join(" ") }).range(ln.from));
					}
					if (!selectionTouches(state, startLine.from, startLine.to) && guard.canAdd(startLine.from, startLine.to)) {
						decos.push(Decoration.replace({ widget: new CodeHeaderWidget(lang, codeText, startLine.from) }).range(startLine.from, startLine.to));
					}
					if (hasClose && !selectionTouches(state, endLine.from, endLine.to) && guard.canAdd(endLine.from, endLine.to)) {
						decos.push(Decoration.replace({ widget: new HiddenFenceWidget() }).range(endLine.from, endLine.to));
					}
					return false;
				}

				if (node.name === "InlineCode") {
					skipRanges.push([node.from, node.to]);
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

				// ATX Headings H1..H6
				const hMatch = /^ATXHeading([1-6])$/.exec(node.name);
				if (hMatch) {
					const level = Number(hMatch[1]);
					const line = state.doc.lineAt(node.from);
					decos.push(Decoration.line({ class: `cm-md-h${level}` }).range(line.from));
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
					skipRanges.push([node.from, node.to]);
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
			if (line.from <= fmEnd || isSkipped(line.from, line.to)) continue;
			const text = line.text;

			// Blockquotes (excluding callouts handled as blocks)
			const qMatch = QUOTE_RE.exec(text);
			if (qMatch && !parseCalloutHeader(text)) {
				decos.push(Decoration.line({ class: "cm-md-quote-line" }).range(line.from));
				const revealed = selectionTouches(state, line.from, line.to);
				hideOrDim(line.from, line.from + qMatch[1]!.length, revealed);
			}

			// Task checkboxes `- [ ] ` / `- [x] `
			const taskMatch = TASK_RE.exec(text);
			if (taskMatch) {
				const lead = taskMatch[1]!;
				const marker = taskMatch[2]!;
				const gap = taskMatch[3]!;
				const mark = taskMatch[4]!;
				const trail = taskMatch[5]!;
				const replaceFrom = line.from + lead.length;
				const bracketPos = replaceFrom + marker.length + gap.length;
				const replaceTo = bracketPos + 3 + trail.length;
				const checked = mark.toLowerCase() === "x";
				const cursorInBox = selectionTouches(state, replaceFrom, replaceTo);
				if (!cursorInBox && guard.canAdd(replaceFrom, replaceTo)) {
					decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, bracketPos) }).range(replaceFrom, replaceTo));
				}
				if (checked && replaceTo < line.to) {
					decos.push(Decoration.mark({ class: "cm-md-task-done" }).range(replaceTo, line.to));
				}
			} else if (!RULE_RE.test(text)) {
				// Unordered list bullets `- ` / `* ` / `+ `
				const bMatch = BULLET_RE.exec(text);
				if (bMatch) {
					const lead = bMatch[1]!;
					const bulletFrom = line.from + lead.length;
					const bulletTo = bulletFrom + bMatch[2]!.length;
					if (!selectionTouches(state, bulletFrom, bulletTo + 1) && guard.canAdd(bulletFrom, bulletTo)) {
						decos.push(Decoration.replace({ widget: new BulletWidget() }).range(bulletFrom, bulletTo));
					}
				}
			}

			// Skip inline scans on heading syntax prefix
			const lineSkips: [number, number][] = [];

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

			// [[wikilinks]] including [[doc#heading]], [[#heading]], and [[target|alias]]
			if (text.includes("[[")) {
				for (const m of text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
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

			// #tags in prose (not ATX heading hashes, not inside links/code)
			if (text.includes("#") && !/^[ \t]{0,3}#{1,6}[ \t]/.test(text)) {
				for (const m of text.matchAll(/(^|[\s(])(#[A-Za-z][A-Za-z0-9_/-]*)/g)) {
					const leadLen = m[1]!.length;
					const tag = m[2]!;
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
			const refreshed = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLiveEffect) || e.is(setEditYamlEffect)));
			if (
				update.docChanged ||
				update.selectionSet ||
				update.viewportChanged ||
				refreshed ||
				syntaxTree(update.startState) !== syntaxTree(update.state)
			) {
				this.decorations = buildInlineDecorations(update.view);
			}
		}
	},
	{ decorations: (v) => v.decorations },
);

// --- Interactive click & hover handlers --------------------------------------

export const liveInteractionExtension: Extension = EditorView.domEventHandlers({
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
});

// --- Heading & nested list folding -------------------------------------------

export const markdownFoldService: Extension = [
	foldService.of((state, lineStart) => {
		const line = state.doc.lineAt(lineStart);
		const text = line.text;
		// 1. ATX Heading folds everything until the next heading of equal or higher level.
		const hMatch = /^[ \t]{0,3}(#{1,6})[ \t]+/.exec(text);
		if (hMatch) {
			const level = hMatch[1]!.length;
			let endLine = line.number;
			for (let n = line.number + 1; n <= state.doc.lines; n++) {
				const next = state.doc.line(n);
				const nh = /^[ \t]{0,3}(#{1,6})[ \t]+/.exec(next.text);
				if (nh && nh[1]!.length <= level) break;
				endLine = n;
			}
			while (endLine > line.number && !state.doc.line(endLine).text.trim()) endLine--;
			if (endLine > line.number) return { from: line.to, to: state.doc.line(endLine).to };
			return null;
		}
		// 2. Indented list item folds nested child items below it.
		const listMatch = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(text);
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
