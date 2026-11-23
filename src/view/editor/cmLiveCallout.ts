// Obsidian+ in-place Live Callout Card Widget for CodeMirror 6 (ADR 0002 & ADR 0028).
// - In Live mode: stays rendered as a styled callout card while editing!
//   * Click the icon/type badge to switch callout type (`Important`, `Note`, `Tip`, `Warning`, ...)
//   * Click the title to rename inline (`Enter` or `ArrowDown` jumps to body)
//   * Click the body to edit clean unprefixed Markdown (no manual `> ` prefixes needed!)
//   * Smart list & task continuation inside the callout body (`Enter` continues `- ` / `- [ ] `)
//   * Toggle collapsible (`+` / `-`) or drop to `Raw` Markdown with one click
// - Uses CM6 `WidgetType.updateDOM` so typing never flickers or loses focus.
// - In Read mode: renders cleanly read-only with interactive checkboxes, fold toggle, links & selection.
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import {
	CALLOUT_PRESETS,
	CALLOUT_SPECS,
	serializeCalloutBlock,
	type ParsedCallout,
} from "../../shared/markdownEdit";
import { listEnter } from "../../shared/markdownText";
import {
	historyFallbackFacet,
	liveCallbacksFacet,
	renderInlineHtml,
	setRawEditBlockEffect,
	type CalloutWidgetHost,
} from "./cmLiveShared";
import { hydrateImagesInElement } from "./imageResolve";
import { colourCode } from "./markdownCode";

const TASK_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([ xX])\]([ \t]?)/;

/** Remembered callout fold toggles so collapsing/expanding persists across Live <-> Read switches. */
const calloutFoldState = new Map<string, boolean>();

type CalloutController = {
	view: EditorView;
	parsed: ParsedCallout;
	bodyMarkdown: string;
	from: number;
	to: number;
	startLine: number;
	endLine: number;
	filePath: string;
	readMode: boolean;
	editingBody: boolean;
	pickerOpen: boolean;
	folded: boolean;
	selfDispatching: boolean;
	suppressEnterUntil: number;
	root: CalloutDomElement;
	headEl: HTMLDivElement;
	typeBtn: HTMLButtonElement;
	iconEl: HTMLSpanElement;
	titleSpan: HTMLSpanElement;
	titleInput: HTMLInputElement;
	actionsEl: HTMLDivElement;
	foldableBtn: HTMLButtonElement;
	rawBtn: HTMLButtonElement;
	foldBtn: HTMLButtonElement;
	pickerEl: HTMLDivElement;
	bodyEl: HTMLDivElement;
	bodyTextarea: HTMLTextAreaElement | null;
	syncAll: () => void;
	openBodyEditor: (target?: boolean | { cursorOffset?: number }) => void;
	closeBodyEditor: (commit?: boolean) => void;
};

type CalloutDomElement = CalloutWidgetHost & { __calloutCtrl?: CalloutController };

function fitTextarea(el: HTMLTextAreaElement) {
	el.style.height = "auto";
	el.style.height = `${Math.max(26, el.scrollHeight)}px`;
}

function caretOnFirstLine(el: HTMLTextAreaElement): boolean {
	return !el.value.slice(0, el.selectionStart).includes("\n");
}

function runHistory(view: EditorView, dir: "undo" | "redo") {
	if (dir === "undo") {
		if (undoDepth(view.state) > 0) undo(view);
		else view.state.facet(historyFallbackFacet)?.undo();
	} else {
		if (redoDepth(view.state) > 0) redo(view);
		else view.state.facet(historyFallbackFacet)?.redo();
	}
}

export class CalloutWidget extends WidgetType {
	constructor(
		private readonly parsed: ParsedCallout,
		private readonly bodyMarkdown: string,
		private readonly from: number,
		private readonly to: number,
		private readonly startLine: number,
		private readonly endLine: number,
		private readonly filePath: string,
		private readonly readMode: boolean,
		private readonly themeVer: number = 0,
	) {
		super();
	}

	eq(other: CalloutWidget) {
		return (
			other.parsed.spec.type === this.parsed.spec.type &&
			other.parsed.title === this.parsed.title &&
			other.parsed.fold === this.parsed.fold &&
			other.bodyMarkdown === this.bodyMarkdown &&
			other.from === this.from &&
			other.to === this.to &&
			other.startLine === this.startLine &&
			other.endLine === this.endLine &&
			other.filePath === this.filePath &&
			other.readMode === this.readMode &&
			other.themeVer === this.themeVer
		);
	}

	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		const el = dom as CalloutDomElement;
		const ctrl = el.__calloutCtrl;
		if (!ctrl) return false;

		ctrl.view = view;
		ctrl.parsed = this.parsed;
		ctrl.bodyMarkdown = this.bodyMarkdown;
		ctrl.from = this.from;
		ctrl.to = this.to;
		ctrl.startLine = this.startLine;
		ctrl.endLine = this.endLine;
		ctrl.filePath = this.filePath;
		ctrl.readMode = this.readMode;

		if (this.readMode) {
			ctrl.pickerOpen = false;
			if (ctrl.editingBody) ctrl.closeBodyEditor(false);
		}

		ctrl.syncAll();
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		const root = document.createElement("div") as CalloutDomElement;
		root.className = `cm-md-callout tone-${this.parsed.spec.tone}`;
		root.dataset.calloutType = this.parsed.spec.type;
		root.dataset.editing = "false";

		const headEl = document.createElement("div");
		headEl.className = "cm-md-callout-head";

		const typeBtn = document.createElement("button");
		typeBtn.type = "button";
		typeBtn.className = "cm-callout-type-btn";
		typeBtn.title = "Change callout type";
		typeBtn.setAttribute("aria-label", "Change callout type");

		const iconEl = document.createElement("span");
		iconEl.className = "cm-md-callout-icon";
		iconEl.setAttribute("aria-hidden", "true");
		typeBtn.appendChild(iconEl);

		const titleSpan = document.createElement("span");
		titleSpan.className = "cm-md-callout-title";

		const titleInput = document.createElement("input");
		titleInput.type = "text";
		titleInput.className = "cm-callout-title-input";
		titleInput.setAttribute("aria-label", "Callout title");
		titleInput.spellcheck = true;

		const actionsEl = document.createElement("div");
		actionsEl.className = "cm-callout-actions";

		const foldableBtn = document.createElement("button");
		foldableBtn.type = "button";
		foldableBtn.className = "cm-callout-action-btn";

		const rawBtn = document.createElement("button");
		rawBtn.type = "button";
		rawBtn.className = "cm-callout-action-btn";
		rawBtn.textContent = "Raw";
		rawBtn.title = "Edit raw Markdown blockquote syntax";

		actionsEl.append(foldableBtn, rawBtn);

		const foldBtn = document.createElement("button");
		foldBtn.type = "button";
		foldBtn.className = "cm-md-callout-fold";

		headEl.append(typeBtn, titleSpan, titleInput, actionsEl, foldBtn);

		const pickerEl = document.createElement("div");
		pickerEl.className = "cm-callout-type-picker";
		pickerEl.hidden = true;

		const bodyEl = document.createElement("div");
		bodyEl.className = "cm-md-callout-body";

		root.append(headEl, pickerEl, bodyEl);

		const foldKey = () => `${ctrl.filePath}:${ctrl.startLine}:${ctrl.parsed.spec.type}:${ctrl.parsed.title}`;

		const ctrl: CalloutController = {
			view,
			parsed: this.parsed,
			bodyMarkdown: this.bodyMarkdown,
			from: this.from,
			to: this.to,
			startLine: this.startLine,
			endLine: this.endLine,
			filePath: this.filePath,
			readMode: this.readMode,
			editingBody: false,
			pickerOpen: false,
			folded: calloutFoldState.has(`${this.filePath}:${this.startLine}:${this.parsed.spec.type}:${this.parsed.title}`)
				? calloutFoldState.get(`${this.filePath}:${this.startLine}:${this.parsed.spec.type}:${this.parsed.title}`)!
				: this.parsed.fold === "-",
			selfDispatching: false,
			suppressEnterUntil: 0,
			root,
			headEl,
			typeBtn,
			iconEl,
			titleSpan,
			titleInput,
			actionsEl,
			foldableBtn,
			rawBtn,
			foldBtn,
			pickerEl,
			bodyEl,
			bodyTextarea: null,
			syncAll: () => {},
			openBodyEditor: () => {},
			closeBodyEditor: () => {},
		};
		root.__calloutCtrl = ctrl;

		let onOutsideClick: ((e: MouseEvent) => void) | null = null;
		const setPickerOpen = (open: boolean) => {
			ctrl.pickerOpen = open;
			if (onOutsideClick) {
				window.removeEventListener("mousedown", onOutsideClick, true);
				onOutsideClick = null;
			}
			if (open) {
				onOutsideClick = (ev: MouseEvent) => {
					if (!root.isConnected) {
						window.removeEventListener("mousedown", onOutsideClick!, true);
						onOutsideClick = null;
						return;
					}
					if (ev.target instanceof Node && !root.contains(ev.target)) {
						setPickerOpen(false);
					}
				};
				window.addEventListener("mousedown", onOutsideClick, true);
			}
			renderPicker();
		};

		const commitCallout = (patch: { type?: string; title?: string; fold?: "+" | "-" | null; body?: string; keepEmptyBodyLine?: boolean }) => {
			const nextType = patch.type ?? ctrl.parsed.spec.type;
			const nextTitle = patch.title ?? (document.activeElement === titleInput ? titleInput.value : ctrl.parsed.title);
			const nextFold = patch.fold !== undefined ? patch.fold : ctrl.parsed.fold;
			const nextBody = patch.body ?? (ctrl.bodyTextarea ? ctrl.bodyTextarea.value : ctrl.bodyMarkdown);
			const keepEmpty = patch.keepEmptyBodyLine ?? (ctrl.editingBody || document.activeElement === titleInput || ctrl.pickerOpen);
			const serialized = serializeCalloutBlock(nextType, nextTitle, nextFold, nextBody, keepEmpty);
			const curFrom = Math.min(ctrl.from, ctrl.view.state.doc.length);
			const curTo = Math.min(ctrl.to, ctrl.view.state.doc.length);
			const existing = ctrl.view.state.sliceDoc(curFrom, curTo);
			if (serialized === existing) return;
			ctrl.selfDispatching = true;
			try {
				ctrl.view.dispatch({
					changes: { from: curFrom, to: curTo, insert: serialized },
					userEvent: "input.callout",
				});
			} finally {
				ctrl.selfDispatching = false;
			}
		};

		const exitBelow = (createLineIfEof: boolean) => {
			if (ctrl.editingBody) ctrl.closeBodyEditor(true);
			const doc = ctrl.view.state.doc;
			const endLn = doc.lineAt(Math.min(ctrl.to, doc.length)).number;
			if (endLn < doc.lines) {
				const after1 = doc.line(endLn + 1);
				// If a blank separator sits between this callout and a line below, land on that next line (or the blank line if it's the end).
				const target = !after1.text.trim() && endLn + 2 <= doc.lines ? doc.line(endLn + 2) : after1;
				ctrl.view.focus();
				ctrl.view.dispatch({ selection: EditorSelection.cursor(target.from), scrollIntoView: true });
			} else if (createLineIfEof) {
				const endPos = doc.length;
				ctrl.view.focus();
				ctrl.view.dispatch({
					changes: { from: endPos, to: endPos, insert: "\n\n" },
					selection: EditorSelection.cursor(endPos + 2),
					scrollIntoView: true,
					userEvent: "input",
				});
			} else {
				// Escape at EOF: close callout cleanly without adding extra newlines or dirtying the document.
				if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) {
					document.activeElement.blur();
				}
			}
		};

		const renderBodyPreview = () => {
			bodyEl.innerHTML = "";
			const trimmed = ctrl.bodyMarkdown.trim();
			if (!trimmed) {
				if (!ctrl.readMode) {
					const placeholder = document.createElement("div");
					placeholder.className = "cm-callout-placeholder";
					placeholder.textContent = "Click to add callout text…";
					bodyEl.appendChild(placeholder);
				}
				return;
			}
			bodyEl.innerHTML = renderInlineHtml(ctrl.bodyMarkdown, ctrl.filePath, false, true);
			hydrateImagesInElement(bodyEl, ctrl.filePath);
			void colourCode(bodyEl);

			const boxes = [...bodyEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
			if (boxes.length) {
				const cb = ctrl.view.state.facet(liveCallbacksFacet);
				const taskBrackets: number[] = [];
				for (let n = ctrl.startLine + 1; n <= Math.min(ctrl.endLine, ctrl.view.state.doc.lines); n++) {
					const ln = ctrl.view.state.doc.line(n);
					const tm = TASK_RE.exec(ln.text);
					if (tm) {
						taskBrackets.push(ln.from + tm[1]!.length + tm[2]!.length + tm[3]!.length);
					}
				}
				if (taskBrackets.length === boxes.length) {
					boxes.forEach((box, idx) => {
						box.disabled = false;
						box.className = "cm-md-checkbox";
						box.addEventListener("mousedown", (e) => {
							e.preventDefault();
							e.stopPropagation();
							cb?.onToggleCheckbox(taskBrackets[idx]!);
						});
						box.addEventListener("click", (e) => {
							e.preventDefault();
							e.stopPropagation();
						});
					});
				}
			}
		};

		const renderPicker = () => {
			pickerEl.hidden = ctrl.readMode || !ctrl.pickerOpen;
			if (pickerEl.hidden) return;
			pickerEl.innerHTML = "";
			for (const preset of CALLOUT_PRESETS) {
				const spec = CALLOUT_SPECS[preset.type]!;
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = `cm-callout-pick tone-${spec.tone}`;
				if (ctrl.parsed.spec.type === preset.type) btn.classList.add("active");
				btn.title = preset.about;

				const ic = document.createElement("span");
				ic.className = "cm-md-callout-icon";
				ic.setAttribute("aria-hidden", "true");
				ic.textContent = spec.icon;

				const lbl = document.createElement("span");
				lbl.textContent = preset.label;
				btn.append(ic, lbl);

				btn.addEventListener("mousedown", (e) => {
					e.preventDefault();
					e.stopPropagation();
				});
				btn.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					const wasDefaultTitle = ctrl.parsed.title.toLowerCase() === ctrl.parsed.spec.label.toLowerCase();
					setPickerOpen(false);
					commitCallout({
						type: preset.type,
						title: wasDefaultTitle ? spec.label : ctrl.parsed.title,
					});
				});
				pickerEl.appendChild(btn);
			}
		};

		ctrl.closeBodyEditor = (commit = true) => {
			const val = ctrl.bodyTextarea?.value;
			ctrl.editingBody = false;
			ctrl.bodyTextarea = null;
			root.dataset.editing = "false";
			if (commit && val !== undefined) {
				commitCallout({ body: val, keepEmptyBodyLine: false });
			}
			renderBodyPreview();
		};

		ctrl.openBodyEditor = (target: boolean | { cursorOffset?: number } = true) => {
			if (ctrl.readMode) return;
			if (ctrl.folded) {
				ctrl.folded = false;
				calloutFoldState.set(foldKey(), false);
				bodyEl.style.display = "";
				root.classList.remove("is-folded");
			}
			const placeCaret = (el: HTMLTextAreaElement) => {
				if (typeof target === "object" && target.cursorOffset !== undefined) {
					const off = Math.max(0, Math.min(el.value.length, target.cursorOffset));
					el.setSelectionRange(off, off);
				} else if (target === true) {
					el.setSelectionRange(el.value.length, el.value.length);
				} else {
					el.setSelectionRange(0, 0);
				}
			};
			if (ctrl.editingBody && ctrl.bodyTextarea?.isConnected) {
				ctrl.bodyTextarea.focus();
				placeCaret(ctrl.bodyTextarea);
				return;
			}
			ctrl.editingBody = true;
			root.dataset.editing = "true";
			bodyEl.innerHTML = "";

			const ta = document.createElement("textarea");
			ta.className = "cm-callout-body-input";
			ta.rows = 1;
			ta.spellcheck = true;
			ta.placeholder = "Write callout text, lists, or - [ ] tasks… (Ctrl+Enter or Esc to finish)";
			ta.value = ctrl.bodyMarkdown;

			ta.addEventListener("beforeinput", (e) => {
				if (
					performance.now() < ctrl.suppressEnterUntil &&
					(e.inputType === "insertLineBreak" || e.inputType === "insertParagraph" || e.data === "\n" || e.data === "\r")
				) {
					e.preventDefault();
					e.stopPropagation();
				}
			});

			ta.addEventListener("keypress", (e) => {
				if (performance.now() < ctrl.suppressEnterUntil && e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					e.stopPropagation();
				}
			});

			ta.addEventListener("input", () => {
				fitTextarea(ta);
				commitCallout({ body: ta.value, keepEmptyBodyLine: true });
			});

			ta.addEventListener("mousedown", (e) => e.stopPropagation());

			ta.addEventListener("keydown", (e) => {
				if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
					e.preventDefault();
					e.stopPropagation();
					commitCallout({ body: ta.value, keepEmptyBodyLine: true });
					runHistory(ctrl.view, e.shiftKey ? "redo" : "undo");
					return;
				}
				if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "y") {
					e.preventDefault();
					e.stopPropagation();
					commitCallout({ body: ta.value, keepEmptyBodyLine: true });
					runHistory(ctrl.view, "redo");
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					setPickerOpen(false);
					exitBelow(false);
					return;
				}
				if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
					ctrl.suppressEnterUntil = performance.now() + 80;
					e.preventDefault();
					e.stopPropagation();
					setPickerOpen(false);
					exitBelow(true);
					return;
				}
				if (e.key === "ArrowUp" && !e.shiftKey && ta.selectionStart === 0 && caretOnFirstLine(ta)) {
					e.preventDefault();
					e.stopPropagation();
					commitCallout({ body: ta.value, keepEmptyBodyLine: true });
					titleInput.focus();
					titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
					return;
				}
				// Smart Markdown list & task continuation inside the callout body!
				if (e.key === "Enter" && !e.shiftKey && ta.selectionStart === ta.selectionEnd) {
					const pos = ta.selectionStart;
					const lineStart = ta.value.lastIndexOf("\n", pos - 1) + 1;
					const lineEndRaw = ta.value.indexOf("\n", pos);
					const lineEnd = lineEndRaw < 0 ? ta.value.length : lineEndRaw;
					const lineText = ta.value.slice(lineStart, lineEnd);
					const col = pos - lineStart;
					const next = listEnter(lineText, col);
					if (next) {
						ctrl.suppressEnterUntil = performance.now() + 80;
						e.preventDefault();
						e.stopPropagation();
						if ("start" in next) {
							ta.setRangeText(`\n${next.start}`, pos, pos, "end");
						} else {
							ta.setRangeText("", lineStart + next.keep, lineEnd, "end");
						}
						fitTextarea(ta);
						commitCallout({ body: ta.value, keepEmptyBodyLine: true });
						return;
					}
				}
				e.stopPropagation();
			});

			ta.addEventListener("blur", (e) => {
				const nextEl = e.relatedTarget instanceof Node ? e.relatedTarget : null;
				const stayInCallout = Boolean(nextEl && root.contains(nextEl));
				commitCallout({ body: ta.value, keepEmptyBodyLine: stayInCallout });
				if (stayInCallout) return;
				// Defer preview swap by 1 frame so clicking a line below the callout lands on the exact clicked line first!
				requestAnimationFrame(() => {
					if (document.activeElement && root.contains(document.activeElement)) return;
					if (ctrl.bodyTextarea === ta) ctrl.closeBodyEditor(false);
				});
			});

			ctrl.bodyTextarea = ta;
			bodyEl.appendChild(ta);

			const focusNow = () => {
				if (!ta.isConnected || ctrl.bodyTextarea !== ta) return;
				fitTextarea(ta);
				ta.focus();
				placeCaret(ta);
			};
			if (root.isConnected) focusNow();
			else requestAnimationFrame(focusNow);
		};

		ctrl.syncAll = () => {
			root.className = `cm-md-callout tone-${ctrl.parsed.spec.tone}${ctrl.folded ? " is-folded" : ""}${ctrl.readMode ? " is-read" : ""}`;
			root.dataset.calloutType = ctrl.parsed.spec.type;
			iconEl.textContent = ctrl.parsed.spec.icon;
			typeBtn.disabled = ctrl.readMode;
			typeBtn.title = ctrl.readMode ? ctrl.parsed.spec.label : `Type: ${ctrl.parsed.spec.label} — click to change`;

			titleSpan.hidden = !ctrl.readMode;
			titleSpan.textContent = ctrl.parsed.title;

			titleInput.hidden = ctrl.readMode;
			if (!ctrl.selfDispatching && titleInput.value !== ctrl.parsed.title) {
				titleInput.value = ctrl.parsed.title;
			}
			titleInput.placeholder = ctrl.parsed.spec.label;

			actionsEl.hidden = ctrl.readMode;
			foldableBtn.textContent = ctrl.parsed.fold === "+" ? "Fold: open" : ctrl.parsed.fold === "-" ? "Fold: shut" : "Foldable";
			foldableBtn.title = "Cycle collapsible state (always open → collapsible open → collapsible closed)";

			const hasFold = Boolean(ctrl.parsed.fold);
			foldBtn.hidden = !hasFold;
			if (hasFold) {
				foldBtn.textContent = ctrl.folded ? "\ueab6" : "\ueab4";
				foldBtn.setAttribute("aria-label", ctrl.folded ? "Expand callout" : "Collapse callout");
			}

			renderPicker();

			const showBody = !ctrl.folded && (!ctrl.readMode || Boolean(ctrl.bodyMarkdown.trim()));
			bodyEl.style.display = showBody ? "" : "none";

			if (ctrl.editingBody && ctrl.bodyTextarea?.isConnected) {
				if (!ctrl.selfDispatching && ctrl.bodyTextarea.value !== ctrl.bodyMarkdown) {
					ctrl.bodyTextarea.value = ctrl.bodyMarkdown;
					fitTextarea(ctrl.bodyTextarea);
				}
			} else {
				renderBodyPreview();
			}
		};

		// Programmatic focus entrypoint (e.g. after inserting a callout from Palette, template, or Enter on header).
		root.__liveCalloutFocus = (pos, opts) => {
			if (ctrl.readMode) return false;
			if (pos < ctrl.from || pos > ctrl.to) return false;
			if (opts?.suppressEnter) ctrl.suppressEnterUntil = performance.now() + 80;
			const doc = ctrl.view.state.doc;
			const clamped = Math.min(pos, doc.length);
			const line = doc.lineAt(clamped);
			if (line.number === ctrl.startLine && ctrl.endLine === ctrl.startLine) {
				titleInput.focus();
				titleInput.select();
			} else if (line.number === ctrl.startLine) {
				titleInput.focus();
				titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
			} else {
				// Compute exact caret offset inside `ctrl.bodyMarkdown` corresponding to document offset `pos`.
				let bodyOffset = 0;
				for (let n = ctrl.startLine + 1; n < line.number && n <= doc.lines; n++) {
					const stripped = doc.line(n).text.replace(/^[ \t]{0,3}>[ \t]?/, "");
					bodyOffset += stripped.length + 1;
				}
				const prefixMatch = /^[ \t]{0,3}>[ \t]?/.exec(line.text);
				const colInBody = Math.max(0, clamped - line.from - (prefixMatch?.[0].length ?? 0));
				ctrl.openBodyEditor({ cursorOffset: bodyOffset + colInBody });
			}
			root.scrollIntoView({ block: "nearest" });
			return true;
		};

		// --- Header interactions ---
		typeBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		typeBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (ctrl.readMode) return;
			setPickerOpen(!ctrl.pickerOpen);
		});

		titleInput.addEventListener("mousedown", (e) => e.stopPropagation());
		titleInput.addEventListener("input", () => {
			commitCallout({ title: titleInput.value, keepEmptyBodyLine: true });
		});
		titleInput.addEventListener("keydown", (e) => {
			if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
				e.preventDefault();
				e.stopPropagation();
				commitCallout({ title: titleInput.value });
				runHistory(ctrl.view, e.shiftKey ? "redo" : "undo");
				return;
			}
			if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "y") {
				e.preventDefault();
				e.stopPropagation();
				commitCallout({ title: titleInput.value });
				runHistory(ctrl.view, "redo");
				return;
			}
			if (e.key === "Enter" || e.key === "ArrowDown") {
				if (e.key === "Enter") ctrl.suppressEnterUntil = performance.now() + 80;
				e.preventDefault();
				e.stopPropagation();
				commitCallout({ title: titleInput.value, keepEmptyBodyLine: true });
				ctrl.openBodyEditor(e.key === "Enter");
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setPickerOpen(false);
				commitCallout({ title: titleInput.value, keepEmptyBodyLine: false });
				exitBelow(false);
				return;
			}
			e.stopPropagation();
		});
		titleInput.addEventListener("blur", (e) => {
			const nextEl = e.relatedTarget instanceof Node ? e.relatedTarget : null;
			const stayInCallout = Boolean(nextEl && root.contains(nextEl));
			commitCallout({ title: titleInput.value, keepEmptyBodyLine: stayInCallout || ctrl.editingBody });
		});

		foldableBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		foldableBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (ctrl.readMode) return;
			const nextFold: "+" | "-" | null = ctrl.parsed.fold === null ? "+" : ctrl.parsed.fold === "+" ? "-" : null;
			ctrl.folded = nextFold === "-";
			calloutFoldState.set(foldKey(), ctrl.folded);
			commitCallout({ fold: nextFold, keepEmptyBodyLine: ctrl.editingBody });
		});

		rawBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		rawBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (ctrl.readMode) return;
			setPickerOpen(false);
			if (ctrl.editingBody) ctrl.closeBodyEditor(true);
			const fromPos = Math.min(ctrl.from, ctrl.view.state.doc.length);
			const toPos = Math.min(ctrl.to, ctrl.view.state.doc.length);
			ctrl.view.focus();
			ctrl.view.dispatch({
				effects: setRawEditBlockEffect.of({ from: fromPos, to: toPos }),
				selection: EditorSelection.cursor(fromPos),
				scrollIntoView: true,
			});
		});

		foldBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			ctrl.folded = !ctrl.folded;
			calloutFoldState.set(foldKey(), ctrl.folded);
			ctrl.syncAll();
		});

		// --- Body click & hover ---
		bodyEl.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			const target = e.target as HTMLElement | null;
			if (target?.closest("input[type='checkbox'], .cm-callout-body-input")) {
				e.stopPropagation();
				return;
			}
			const cb = ctrl.view.state.facet(liveCallbacksFacet);
			const anchor = target?.closest<HTMLAnchorElement>("a[href]");
			const tag = target?.closest<HTMLElement>(".md-tag");
			const img = target?.closest<HTMLImageElement>("img");
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
			if (img && ctrl.readMode && img.src) {
				e.preventDefault();
				e.stopPropagation();
				cb?.onOpenImageLightbox({ src: img.src, alt: img.alt || "" });
				return;
			}
			if (ctrl.readMode) return;
			e.preventDefault();
			e.stopPropagation();
			ctrl.openBodyEditor(true);
		});

		bodyEl.addEventListener("mouseover", (e) => {
			const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
			if (anchor) ctrl.view.state.facet(liveCallbacksFacet)?.onHoverLink({ kind: "href", href: anchor.getAttribute("href") ?? "", anchor });
		});
		bodyEl.addEventListener("mouseout", (e) => {
			const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
			if (anchor) ctrl.view.state.facet(liveCallbacksFacet)?.onHoverLeave();
		});

		ctrl.syncAll();
		return root;
	}

	ignoreEvent() {
		return true;
	}
}
