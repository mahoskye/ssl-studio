// Obsidian-grade Live Preview extensions for CodeMirror 6 (ADR 0028):
// - StateField (`liveBlockField`): multi-line block decorations (collapsed YAML frontmatter,
//   rendered GFM tables, Obsidian callouts, horizontal rules, standalone inline images).
// - ViewPlugin (`liveInlinePlugin`): viewport-scoped token-level reveal for headings, bold,
//   italic, strikethrough, inline code, ==highlight==, #tags, links, [[wikilinks]], ticket
//   mentions, fenced code headers, bullets, clickable task checkboxes, and blockquotes.
// - FoldService (`markdownFoldService`): heading section & nested list folding.
import { foldGutter, foldService, syntaxTree } from "@codemirror/language";
import { EditorSelection, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { fenced } from "../../shared/catalog";
import { hrefWritten, linkFile, linkLeads } from "../../shared/docLinks";
import { headingAnchor } from "../../shared/docTables";
import { frontMatter } from "../../shared/frontMatter";
import { parseCalloutHeader, parseImageExpression, type ParsedImageSpec } from "../../shared/markdownEdit";
import { parseMarkdownTable } from "../../shared/markdownTables";
import { docByName, namedLink } from "../../shared/namedLinks";
import { relativeTo } from "../../shared/paths";
import { ticketMatcher } from "../../shared/ticketRefs";
import { docs } from "../project";
import { canonical, state as appState } from "../state";
import { CalloutWidget } from "./cmLiveCallout";
import {
	editYamlField,
	liveCallbacksFacet,
	rawEditBlockField,
	readOnlyModeFacet,
	refreshLiveEffect,
	setEditYamlEffect,
	setRawEditBlockEffect,
	type HoverTarget,
	type ImageLightboxInfo,
	type LiveCallbacks,
} from "./cmLiveShared";
import { TableWidget } from "./cmLiveTable";
import { IMAGE_FILE_RE, loadImageUrl } from "./imageResolve";

export {
	editYamlField,
	liveCallbacksFacet,
	rawEditBlockField,
	readOnlyModeFacet,
	refreshLiveEffect,
	setEditYamlEffect,
	setRawEditBlockEffect,
	type HoverTarget,
	type ImageLightboxInfo,
	type LiveCallbacks,
};

const RULE_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TASK_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([ xX])\]([ \t]?)/;
const BULLET_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*)([-*+])([ \t]+)/;
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

/** Tables stay interactive widgets in Live mode unless explicitly in `Raw` mode (or mid-typing a brand-new 2-line delimiter row). */
function tableShouldStayRaw(state: EditorState, from: number, to: number, startLine: number, endLine: number): boolean {
	if (state.facet(readOnlyModeFacet)) return false;
	if (isRawEditing(state, from, to)) return true;
	if (endLine === startLine + 1 && endLine <= state.doc.lines) {
		const delim = state.doc.line(endLine);
		if (selectionTouches(state, delim.from, delim.to)) return true;
	}
	return false;
}

/** Callouts stay interactive cards in Live mode unless explicitly in `Raw` mode (or mid-typing a brand-new 1-line `> [!` header). */
function calloutShouldStayRaw(state: EditorState, from: number, to: number, startLine: number, endLine: number): boolean {
	if (state.facet(readOnlyModeFacet)) return false;
	if (isRawEditing(state, from, to)) return true;
	if (startLine === endLine && selectionTouches(state, from, to)) return true;
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
		if (this.spec.width) img.style.width = `${this.spec.width}px`;
		if (this.spec.height) img.style.height = `${this.spec.height}px`;
		frame.appendChild(img);

		let resolvedUrl = "";
		let resolvedPath: string | undefined;

		// Subtle hover pill bar (Zoom always; Resize + Edit in Live mode).
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

		wrap.addEventListener("mousedown", (e) => {
			if ((e.target as HTMLElement | null)?.closest(".cm-md-image-tools")) return;
			e.preventDefault();
			if (isRead) {
				if (resolvedUrl) cb?.onOpenImageLightbox({ src: resolvedUrl, alt: this.spec.alt || this.spec.src, filePath: resolvedPath });
				return;
			}
			view.focus();
			view.dispatch({ selection: EditorSelection.cursor(Math.min(this.from, view.state.doc.length)), scrollIntoView: true });
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
			if (view.state.facet(readOnlyModeFacet)) return;
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
	const isRead = state.facet(readOnlyModeFacet);
	const editYaml = !isRead && (state.field(editYamlField, false) ?? false);

	// 1. YAML Frontmatter: hidden into zero-height block widget unless editing YAML or cursor enters it in Live mode.
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
	const linesArray = docText.split("\n");

	// 2. Walk syntax tree for multi-line Table, Callout (Blockquote), and HorizontalRule nodes.
	const tree = syntaxTree(state);
	const handledTables = new Set<number>();
	const handledCallouts = new Set<number>();
	tree.iterate({
		enter(node) {
			// Skip nodes wholly inside frontmatter; allow container nodes like `Document` (from === 0) to descend!
			if (node.to <= fmEnd) return false;
			if (node.name === "FencedCode") return false;
			if (node.from <= fmEnd) return;

			if (node.name === "Table") {
				const startLine = state.doc.lineAt(node.from).number;
				const endLine = state.doc.lineAt(node.to).number;
				for (let n = startLine; n <= endLine; n++) handledTables.add(n);
				if (!tableShouldStayRaw(state, node.from, node.to, startLine, endLine) && guard.canAdd(node.from, node.to)) {
					const raw = state.sliceDoc(node.from, node.to);
					decos.push(
						Decoration.replace({
							widget: new TableWidget(raw, node.from, node.to, startLine, filePath, isRead),
							block: true,
						}).range(node.from, node.to),
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
				const parsed = parseCalloutHeader(firstLine.text);
				if (!parsed) return;
				let endLine = state.doc.lineAt(node.to);
				// Never swallow non-quoted lines (CommonMark lazy continuation) into a callout widget!
				while (endLine.number > firstLine.number && !/^[ \t]{0,3}>/.test(endLine.text)) {
					endLine = state.doc.line(endLine.number - 1);
				}
				const blockTo = endLine.to;
				for (let n = firstLine.number; n <= endLine.number; n++) handledCallouts.add(n);
				if (!calloutShouldStayRaw(state, node.from, blockTo, firstLine.number, endLine.number) && guard.canAdd(node.from, blockTo)) {
					const bodyLines: string[] = [];
					for (let n = firstLine.number + 1; n <= endLine.number; n++) {
						bodyLines.push(state.doc.line(n).text.replace(/^[ \t]{0,3}>[ \t]?/, ""));
					}
					decos.push(
						Decoration.replace({
							widget: new CalloutWidget(parsed, bodyLines.join("\n"), node.from, blockTo, firstLine.number, endLine.number, filePath, isRead),
							block: true,
						}).range(node.from, blockTo),
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
				let endLineNum = n;
				while (endLineNum + 1 <= state.doc.lines && /^[ \t]{0,3}>/.test(state.doc.line(endLineNum + 1).text)) {
					endLineNum++;
				}
				const from = line.from;
				const to = state.doc.line(endLineNum).to;
				for (let k = n; k <= endLineNum; k++) handledCallouts.add(k);
				if (!calloutShouldStayRaw(state, from, to, n, endLineNum) && guard.canAdd(from, to)) {
					const bodyLines: string[] = [];
					for (let k = n + 1; k <= endLineNum; k++) {
						bodyLines.push(state.doc.line(k).text.replace(/^[ \t]{0,3}>[ \t]?/, ""));
					}
					decos.push(
						Decoration.replace({
							widget: new CalloutWidget(parsed, bodyLines.join("\n"), from, to, n, endLineNum, filePath, isRead),
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

	// 3. Standalone image lines (`![alt|400](src)` or `![[image.png|Caption|300]]`).
	for (let n = startLineNum; n <= state.doc.lines; n++) {
		const line = state.doc.line(n);
		if (!line.text.includes("![")) continue;
		if (inFence(line.from) || selectionTouches(state, line.from, line.to)) continue;
		const parsed = parseImageExpression(line.text);
		if (!parsed) continue;
		if (parsed.kind === "wiki" && !IMAGE_FILE_RE.test(parsed.src)) continue;
		const cleanSpec: ParsedImageSpec = parsed.kind === "md" ? { ...parsed, src: hrefWritten(parsed.src) } : parsed;
		if (cleanSpec.src && guard.canAdd(line.from, line.to)) {
			decos.push(
				Decoration.replace({
					widget: new ImageWidget(cleanSpec, line.from, line.to, filePath, isRead, false),
					block: true,
				}).range(line.from, line.to),
			);
		}
	}

	return Decoration.set(decos, true);
}

export const liveBlockField = StateField.define<DecorationSet>({
	create(state) {
		return buildBlockDecorations(state);
	},
	update(value, tr) {
		const refreshed = tr.effects.some((e) => e.is(refreshLiveEffect) || e.is(setEditYamlEffect) || e.is(setRawEditBlockEffect));
		const rawChanged = tr.startState.field(rawEditBlockField, false) !== tr.state.field(rawEditBlockField, false);
		if (tr.docChanged || tr.selection || tr.reconfigured || refreshed || rawChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
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
					const sLine = state.doc.lineAt(node.from).number;
					const eLine = state.doc.lineAt(node.to).number;
					if (!tableShouldStayRaw(state, node.from, node.to, sLine, eLine)) {
						blockSkipRanges.push([node.from, node.to]);
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
					if (!calloutShouldStayRaw(state, node.from, blockTo, firstLine.number, endLine.number)) {
						blockSkipRanges.push([node.from, blockTo]);
						// Only skip descending into children when the whole Blockquote node belongs to the callout.
						if (blockTo === node.to) return false;
					}
					return;
				}

				if (node.name === "FencedCode") {
					blockSkipRanges.push([node.from, node.to]);
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

				// ATX Headings H1..H6 (tag with heading anchor id for Document Outline scrollspy)
				const hMatch = /^ATXHeading([1-6])$/.exec(node.name);
				if (hMatch) {
					const level = Number(hMatch[1]);
					const line = state.doc.lineAt(node.from);
					const cleanHeading = line.text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/, "").replace(/[ \t]*#*[ \t]*$/, "").trim();
					const anchor = headingAnchor(cleanHeading);
					decos.push(
						Decoration.line({
							class: `cm-md-h${level}`,
							attributes: {
								"data-md-heading-line": String(line.number),
								...(anchor ? { "data-md-heading-id": anchor } : {}),
							},
						}).range(line.from),
					);
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
					if (selectionTouches(state, bulletFrom, bulletTo + 1)) {
						decos.push(syntaxMark.range(bulletFrom, bulletTo));
					} else if (guard.canAdd(bulletFrom, bulletTo)) {
						decos.push(Decoration.replace({ widget: new BulletWidget() }).range(bulletFrom, bulletTo));
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
			const refreshed = update.transactions.some(
				(tr) => tr.reconfigured || tr.effects.some((e) => e.is(refreshLiveEffect) || e.is(setEditYamlEffect) || e.is(setRawEditBlockEffect)),
			);
			const rawChanged = update.startState.field(rawEditBlockField, false) !== update.state.field(rawEditBlockField, false);
			if (
				update.docChanged ||
				update.selectionSet ||
				update.viewportChanged ||
				refreshed ||
				rawChanged ||
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
