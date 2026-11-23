// Lazy-loaded theme-aware Mermaid diagram widget for CodeMirror 6 Live & Read views.
// Loads `mermaid` on demand only when a Markdown document contains a ```mermaid fence.
import { EditorSelection } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { liveCallbacksFacet, setRawEditBlockEffect } from "./cmLiveShared";

let mermaidMod: typeof import("mermaid").default | null = null;
let lastConfigKey: string | null = null;
let renderSeq = 0;
/** Serializes `mermaid.initialize()` + `mermaid.render()` so concurrent Light export and Dark Live renders never collide. */
let renderQueue: Promise<unknown> = Promise.resolve();

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
	const next = renderQueue.then(fn, fn);
	renderQueue = next.catch(() => {});
	return next;
}

/** LRU cache of rendered Mermaid SVGs keyed by `${mode}\0${exportFlag}\0${code}` so typing above a diagram never flashes. */
const SVG_CACHE_MAX = 60;
const svgCache = new Map<string, string>();

function cacheSvg(key: string, svg: string) {
	if (svgCache.has(key)) svgCache.delete(key);
	svgCache.set(key, svg);
	if (svgCache.size > SVG_CACHE_MAX) {
		const oldest = svgCache.keys().next().value;
		if (oldest !== undefined) svgCache.delete(oldest);
	}
}

/** Resolves a concrete computed font-family string (never `var(--ui-font)`) so standalone SVG/PNG exports render reliably. */
function resolvedFontFamily(): string {
	const fallback = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
	if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return fallback;
	const target = document.body ?? document.documentElement;
	const computed = getComputedStyle(target).fontFamily?.trim();
	if (computed && !computed.includes("var(")) return computed;
	const uiVar = getComputedStyle(document.documentElement).getPropertyValue("--ui-font").trim();
	if (uiVar && !uiVar.includes("var(")) return uiVar;
	return fallback;
}

function isDarkEditorTheme(): boolean {
	if (typeof document === "undefined") return true;
	// Prefer editor surface polarity (`dataset.editorTheme`) so Split Warm renders light diagrams on paper!
	const scheme = document.documentElement.dataset.editorTheme ?? document.documentElement.dataset.theme ?? document.documentElement.style.colorScheme;
	if (scheme === "light") return false;
	if (scheme === "dark") return true;
	const bg = getComputedStyle(document.documentElement).getPropertyValue("--editor-bg").trim();
	if (bg.startsWith("#") && (bg.length === 7 || bg.length === 4)) {
		const hex = bg.length === 4 ? `#${bg[1]}${bg[1]}${bg[2]}${bg[2]}${bg[3]}${bg[3]}` : bg;
		const r = Number.parseInt(hex.slice(1, 3), 16);
		const g = Number.parseInt(hex.slice(3, 5), 16);
		const b = Number.parseInt(hex.slice(5, 7), 16);
		return 0.299 * r + 0.587 * g + 0.114 * b < 140;
	}
	return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

async function renderMermaidSvg(
	code: string,
	forceMode?: "dark" | "light",
	options?: { forExport?: boolean },
): Promise<{ svg?: string; error?: string }> {
	const trimmed = code.trim();
	const mode = forceMode ?? (isDarkEditorTheme() ? "dark" : "light");
	const forExport = Boolean(options?.forExport);
	const cacheKey = `${mode}\0${forExport ? "export" : "live"}\0${trimmed}`;
	const hit = svgCache.get(cacheKey);
	if (hit) {
		cacheSvg(cacheKey, hit);
		return { svg: hit };
	}
	return runSerialized(async () => {
		const recheck = svgCache.get(cacheKey);
		if (recheck) {
			cacheSvg(cacheKey, recheck);
			return { svg: recheck };
		}
		try {
			if (!mermaidMod) {
				const imported = await import("mermaid");
				mermaidMod = imported.default;
			}
			const font = resolvedFontFamily();
			const configKey = `${mode}:${forExport ? "export" : "live"}:${font}`;
			if (lastConfigKey !== configKey) {
				mermaidMod.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					suppressErrorRendering: true,
					theme: mode === "dark" ? "dark" : "default",
					fontFamily: font,
					...(forExport ? { htmlLabels: false, flowchart: { htmlLabels: false } } : {}),
				});
				lastConfigKey = configKey;
			}
			const id = `ssl-studio-mermaid-${++renderSeq}`;
			const { svg } = await mermaidMod.render(id, trimmed);
			cacheSvg(cacheKey, svg);
			return { svg };
		} catch (e: any) {
			return { error: String(e?.message ?? e) };
		}
	});
}

/** Renders a light-mode export-safe SVG (no `<foreignObject>` HTML labels, resolved font-family) for HTML / Print / Packet exports. */
export async function renderMermaidSvgForExport(code: string, mode: "dark" | "light" = "light"): Promise<string | null> {
	const res = await renderMermaidSvg(code, mode, { forExport: true });
	return res.svg ?? null;
}

/** Rasterizes a Mermaid SVG string into a 2x PNG Blob for pasting into Jira/Confluence/Teams or downloading. */
export async function mermaidSvgToPngBlob(svg: string, mode?: "dark" | "light"): Promise<Blob | null> {
	if (typeof document === "undefined") return null;
	const holder = document.createElement("div");
	holder.innerHTML = svg;
	const svgEl = holder.querySelector("svg");
	if (!svgEl) return null;
	if (!svgEl.getAttribute("xmlns")) svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	const vb = svgEl.viewBox?.baseVal;
	let w = Number.parseFloat(svgEl.getAttribute("width") || "0") || vb?.width || 800;
	let h = Number.parseFloat(svgEl.getAttribute("height") || "0") || vb?.height || 480;
	if (!Number.isFinite(w) || w <= 0) w = 800;
	if (!Number.isFinite(h) || h <= 0) h = 480;
	svgEl.setAttribute("width", String(Math.ceil(w)));
	svgEl.setAttribute("height", String(Math.ceil(h)));
	const xml = new XMLSerializer().serializeToString(svgEl);
	const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
	const dark = mode ? mode === "dark" : isDarkEditorTheme();
	return new Promise<Blob | null>((resolve) => {
		const img = new Image();
		img.onload = () => {
			try {
				const scale = 2;
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, Math.ceil(w * scale));
				canvas.height = Math.max(1, Math.ceil(h * scale));
				const ctx = canvas.getContext("2d");
				if (!ctx) return resolve(null);
				ctx.fillStyle = dark ? "#1e1e1e" : "#ffffff";
				ctx.fillRect(0, 0, canvas.width, canvas.height);
				ctx.scale(scale, scale);
				ctx.drawImage(img, 0, 0, w, h);
				canvas.toBlob((blob) => resolve(blob), "image/png");
			} catch {
				resolve(null);
			}
		};
		img.onerror = () => resolve(null);
		img.src = svgDataUrl;
	});
}

/** Downloads an SVG or PNG blob via an ephemeral anchor link. */
export function downloadMermaidBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copies a rendered Mermaid diagram as PNG to clipboard (re-rendering with `htmlLabels: false` when `code` is provided to prevent canvas taint). */
export async function copyMermaidAsPng(svg: string, code?: string): Promise<"copied" | "downloaded" | "failed"> {
	const mode = isDarkEditorTheme() ? "dark" : "light";
	let exportSvg = svg;
	if (code?.trim()) {
		const rendered = await renderMermaidSvgForExport(code, mode);
		if (rendered) exportSvg = rendered;
	}
	const blob = await mermaidSvgToPngBlob(exportSvg, mode);
	if (!blob) return "failed";
	try {
		if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			return "copied";
		}
	} catch {
		// Fall through to file download when clipboard image write is blocked.
	}
	downloadMermaidBlob(blob, "diagram.png");
	return "downloaded";
}

export class MermaidWidget extends WidgetType {
	constructor(
		private readonly code: string,
		private readonly readOnly: boolean,
		private readonly themeVer: number,
	) {
		super();
	}

	/** Intentionally ignores document offsets (`from`/`to`) so typing above a diagram never tears down & flashes the SVG. */
	eq(other: MermaidWidget): boolean {
		return other.code === this.code && other.readOnly === this.readOnly && other.themeVer === this.themeVer;
	}

	toDOM(view: EditorView): HTMLElement {
		const card = document.createElement("div");
		card.className = "cm-md-mermaid-card";
		card.setAttribute("contenteditable", "false");

		const head = document.createElement("div");
		head.className = "cm-md-mermaid-head";
		const badge = document.createElement("span");
		badge.className = "cm-md-code-lang";
		badge.textContent = "mermaid";

		const actions = document.createElement("span");
		actions.className = "cm-md-code-actions";
		let currentSvg = "";

		const openLightbox = () => {
			if (!currentSvg) return;
			view.state.facet(liveCallbacksFacet)?.onOpenMermaidLightbox?.({ svg: currentSvg, code: this.code });
		};

		const zoomBtn = document.createElement("button");
		zoomBtn.type = "button";
		zoomBtn.className = "cm-md-code-btn";
		zoomBtn.textContent = "Zoom";
		zoomBtn.title = "Open interactive Zoom / Pan diagram lightbox";
		zoomBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			openLightbox();
		});
		actions.append(zoomBtn);

		const svgBtn = document.createElement("button");
		svgBtn.type = "button";
		svgBtn.className = "cm-md-code-btn";
		svgBtn.textContent = "SVG";
		svgBtn.title = "Copy rendered SVG markup";
		svgBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const mode = isDarkEditorTheme() ? "dark" : "light";
			void renderMermaidSvgForExport(this.code, mode).then((exportSvg) => {
				const out = exportSvg || currentSvg;
				if (!out) return;
				view.state.facet(liveCallbacksFacet)?.onCopyCode(out);
				if (!svgBtn.isConnected) return;
				svgBtn.textContent = "Copied";
				setTimeout(() => {
					if (svgBtn.isConnected) svgBtn.textContent = "SVG";
				}, 1400);
			});
		});
		actions.append(svgBtn);

		const pngBtn = document.createElement("button");
		pngBtn.type = "button";
		pngBtn.className = "cm-md-code-btn";
		pngBtn.textContent = "PNG";
		pngBtn.title = "Copy diagram as PNG (for Jira / Confluence / Teams)";
		pngBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!currentSvg && !this.code.trim()) return;
			void copyMermaidAsPng(currentSvg, this.code).then((res) => {
				if (!pngBtn.isConnected) return;
				pngBtn.textContent = res === "copied" ? "Copied" : res === "downloaded" ? "Saved" : "Failed";
				setTimeout(() => {
					if (pngBtn.isConnected) pngBtn.textContent = "PNG";
				}, 1400);
			});
		});
		actions.append(pngBtn);

		if (!this.readOnly) {
			const editBtn = document.createElement("button");
			editBtn.type = "button";
			editBtn.className = "cm-md-code-btn";
			editBtn.textContent = "Edit";
			editBtn.title = "Edit Mermaid diagram source";
			editBtn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const pos = Math.min(view.posAtDOM(card), view.state.doc.length);
				const line = view.state.doc.lineAt(pos);
				view.focus();
				view.dispatch({
					selection: EditorSelection.cursor(line.from),
					effects: setRawEditBlockEffect.of({ from: line.from, to: line.to }),
				});
			});
			actions.append(editBtn);
		}

		const copyBtn = document.createElement("button");
		copyBtn.type = "button";
		copyBtn.className = "cm-md-code-btn";
		copyBtn.textContent = "Source";
		copyBtn.title = "Copy Mermaid source text";
		copyBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			view.state.facet(liveCallbacksFacet)?.onCopyCode(this.code);
			copyBtn.textContent = "Copied";
			setTimeout(() => {
				if (copyBtn.isConnected) copyBtn.textContent = "Source";
			}, 1400);
		});
		actions.append(copyBtn);

		head.append(badge, actions);

		const stage = document.createElement("div");
		stage.className = "cm-md-mermaid-stage";
		stage.title = this.readOnly ? "Click to zoom diagram" : "Double-click to zoom diagram";
		stage.addEventListener(this.readOnly ? "click" : "dblclick", (e) => {
			e.preventDefault();
			e.stopPropagation();
			openLightbox();
		});

		const mode = isDarkEditorTheme() ? "dark" : "light";
		const cached = svgCache.get(`${mode}\0live\0${this.code.trim()}`);
		if (cached) {
			currentSvg = cached;
			stage.innerHTML = cached;
		} else {
			const loading = document.createElement("span");
			loading.className = "cm-md-mermaid-loading";
			loading.textContent = "Rendering diagram…";
			stage.append(loading);
			void renderMermaidSvg(this.code, mode).then(({ svg, error }) => {
				if (!stage.isConnected) return;
				if (svg) {
					currentSvg = svg;
					stage.innerHTML = svg;
				} else {
					stage.textContent = "";
					const err = document.createElement("div");
					err.className = "cm-md-mermaid-error";
					const parsed = extractMermaidErrorLine(error ?? "syntax error");
					err.textContent = parsed.line
						? `Mermaid syntax error on line ${parsed.line}: ${parsed.message}`
						: `Mermaid diagram could not be rendered: ${parsed.message}`;
					const pre = document.createElement("pre");
					pre.textContent = this.code;
					stage.append(err, pre);
				}
			});
		}

		card.append(head, stage);
		return card;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/** Extracts a 1-based diagram line number and clean summary from a Mermaid parser/lexer error message. */
export function extractMermaidErrorLine(rawError: string): { line: number | null; message: string } {
	const text = (rawError || "").replace(/\r\n?/g, "\n").trim();
	if (!text) return { line: null, message: "Syntax error" };
	const lineMatch =
		/(?:parse|lexical|syntax)?\s*error(?:\s+in\s+[^\n:]+)?\s+on\s+line\s+(\d+)/i.exec(text) ??
		/\bline\s+(\d+)\b/i.exec(text);
	const parsedLine = lineMatch ? Number.parseInt(lineMatch[1]!, 10) : NaN;
	const line = Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine : null;
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !/^mermaid version\b/i.test(l) && !/^[-^~]+$/.test(l));
	const summary = lines.slice(0, 2).join(" — ");
	return { line, message: summary.length > 220 ? `${summary.slice(0, 219)}…` : summary || "Syntax error" };
}

type LivePreviewCtrl = {
	view: EditorView;
	code: string;
	themeVer: number;
	bodyStartLine: number;
	closeLine: number;
	lastSvg: string;
	reqSeq: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	statusEl: HTMLSpanElement;
	errEl: HTMLDivElement;
	stageEl: HTMLDivElement;
	zoomBtn: HTMLButtonElement;
	scheduleRender: (immediate?: boolean) => void;
};

type LivePreviewDom = HTMLDivElement & { __mermaidLive?: LivePreviewCtrl };

/**
 * Debounced live preview card rendered directly below a ```` ```mermaid ```` fence while editing it.
 * Uses `updateDOM` to keep the last valid SVG visible with zero flicker as the user types, and surfaces
 * extracted Mermaid syntax error line numbers with 1-click jump back to the offending diagram line.
 */
export class MermaidLivePreviewWidget extends WidgetType {
	constructor(
		private readonly code: string,
		private readonly themeVer: number,
		private readonly bodyStartLine: number,
		private readonly closeLine: number,
	) {
		super();
	}

	eq(other: MermaidLivePreviewWidget): boolean {
		return (
			other.code === this.code &&
			other.themeVer === this.themeVer &&
			other.bodyStartLine === this.bodyStartLine &&
			other.closeLine === this.closeLine
		);
	}

	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		const host = dom as LivePreviewDom;
		const ctrl = host.__mermaidLive;
		if (!ctrl) return false;
		const changed = ctrl.code !== this.code || ctrl.themeVer !== this.themeVer;
		ctrl.view = view;
		ctrl.code = this.code;
		ctrl.themeVer = this.themeVer;
		ctrl.bodyStartLine = this.bodyStartLine;
		ctrl.closeLine = this.closeLine;
		if (changed) ctrl.scheduleRender(false);
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		const card = document.createElement("div") as LivePreviewDom;
		card.className = "cm-md-mermaid-card cm-md-mermaid-live-preview";
		card.setAttribute("contenteditable", "false");

		const head = document.createElement("div");
		head.className = "cm-md-mermaid-head";

		const titleWrap = document.createElement("span");
		titleWrap.className = "cm-md-mermaid-live-title";
		const badge = document.createElement("span");
		badge.className = "cm-md-code-lang";
		badge.textContent = "mermaid";
		const statusEl = document.createElement("span");
		statusEl.className = "cm-md-mermaid-live-status";
		statusEl.textContent = "Live preview";
		titleWrap.append(badge, statusEl);

		const actions = document.createElement("span");
		actions.className = "cm-md-code-actions";

		const zoomBtn = document.createElement("button");
		zoomBtn.type = "button";
		zoomBtn.className = "cm-md-code-btn";
		zoomBtn.textContent = "Zoom";
		zoomBtn.title = "Open interactive Zoom / Pan diagram lightbox";
		zoomBtn.disabled = true;

		const doneBtn = document.createElement("button");
		doneBtn.type = "button";
		doneBtn.className = "cm-md-code-btn";
		doneBtn.textContent = "Done";
		doneBtn.title = "Finish editing Mermaid source and collapse to rendered diagram";

		actions.append(zoomBtn, doneBtn);
		head.append(titleWrap, actions);

		const errEl = document.createElement("div");
		errEl.className = "cm-md-mermaid-err-banner";
		errEl.hidden = true;

		const stageEl = document.createElement("div");
		stageEl.className = "cm-md-mermaid-stage";
		stageEl.title = "Double-click to open diagram zoom viewer";

		card.append(head, errEl, stageEl);

		const ctrl: LivePreviewCtrl = {
			view,
			code: this.code,
			themeVer: this.themeVer,
			bodyStartLine: this.bodyStartLine,
			closeLine: this.closeLine,
			lastSvg: "",
			reqSeq: 0,
			timer: undefined,
			statusEl,
			errEl,
			stageEl,
			zoomBtn,
			scheduleRender: () => {},
		};
		card.__mermaidLive = ctrl;

		const jumpToDiagramLine = (relLine: number) => {
			const doc = ctrl.view.state.doc;
			const targetLineNum = Math.max(1, Math.min(doc.lines, ctrl.bodyStartLine + relLine - 1));
			const ln = doc.line(targetLineNum);
			ctrl.view.focus();
			ctrl.view.dispatch({
				selection: EditorSelection.cursor(ln.from),
				effects: EditorView.scrollIntoView(ln.from, { y: "center" }),
			});
		};

		const showError = (rawError: string) => {
			const parsed = extractMermaidErrorLine(rawError);
			ctrl.errEl.textContent = "";
			const icon = document.createElement("span");
			icon.className = "codicon-glyph";
			icon.setAttribute("aria-hidden", "true");
			icon.textContent = "\uea87";
			ctrl.errEl.append(icon);
			if (parsed.line !== null) {
				const lineBtn = document.createElement("button");
				lineBtn.type = "button";
				lineBtn.className = "cm-md-mermaid-err-line-btn";
				lineBtn.textContent = `Line ${parsed.line}`;
				lineBtn.title = `Jump to diagram line ${parsed.line} (document line ${ctrl.bodyStartLine + parsed.line - 1})`;
				lineBtn.addEventListener("mousedown", (e) => {
					e.preventDefault();
					e.stopPropagation();
					jumpToDiagramLine(parsed.line!);
				});
				ctrl.errEl.append(lineBtn);
			}
			const msg = document.createElement("span");
			msg.className = "cm-md-mermaid-err-msg";
			msg.textContent = parsed.message;
			ctrl.errEl.append(msg);
			ctrl.errEl.hidden = false;
			ctrl.statusEl.textContent = parsed.line !== null ? `Error · line ${parsed.line}` : "Syntax error";
			ctrl.statusEl.classList.add("is-error");
			if (ctrl.lastSvg) {
				ctrl.stageEl.classList.add("is-stale");
			} else {
				ctrl.stageEl.textContent = "";
				ctrl.stageEl.classList.remove("is-stale");
			}
		};

		const applySuccess = (svg: string) => {
			ctrl.lastSvg = svg;
			ctrl.zoomBtn.disabled = false;
			ctrl.errEl.hidden = true;
			ctrl.statusEl.textContent = "Live preview";
			ctrl.statusEl.classList.remove("is-error");
			ctrl.stageEl.classList.remove("is-stale");
			ctrl.stageEl.innerHTML = svg;
		};

		const runRender = (codeSnapshot: string, seq: number) => {
			const trimmed = codeSnapshot.trim();
			if (!trimmed) {
				ctrl.errEl.hidden = true;
				ctrl.statusEl.textContent = "Empty diagram";
				ctrl.statusEl.classList.remove("is-error");
				ctrl.stageEl.classList.remove("is-stale");
				ctrl.stageEl.textContent = "";
				const empty = document.createElement("span");
				empty.className = "cm-md-mermaid-loading";
				empty.textContent = "Type Mermaid syntax above to preview live…";
				ctrl.stageEl.append(empty);
				ctrl.lastSvg = "";
				ctrl.zoomBtn.disabled = true;
				return;
			}
			const mode = isDarkEditorTheme() ? "dark" : "light";
			const cached = svgCache.get(`${mode}\0live\0${trimmed}`);
			if (cached) {
				applySuccess(cached);
				return;
			}
			void renderMermaidSvg(trimmed, mode).then(({ svg, error }) => {
				if (!card.isConnected || seq !== ctrl.reqSeq) return;
				if (svg) applySuccess(svg);
				else showError(error ?? "Syntax error");
			});
		};

		ctrl.scheduleRender = (immediate = false) => {
			clearTimeout(ctrl.timer);
			const seq = ++ctrl.reqSeq;
			const trimmed = ctrl.code.trim();
			const mode = isDarkEditorTheme() ? "dark" : "light";
			if (!trimmed || svgCache.has(`${mode}\0live\0${trimmed}`)) {
				runRender(ctrl.code, seq);
				return;
			}
			ctrl.statusEl.textContent = "Updating…";
			ctrl.statusEl.classList.remove("is-error");
			if (!ctrl.lastSvg) {
				ctrl.stageEl.textContent = "";
				const loading = document.createElement("span");
				loading.className = "cm-md-mermaid-loading";
				loading.textContent = "Rendering preview…";
				ctrl.stageEl.append(loading);
			}
			if (immediate) {
				runRender(ctrl.code, seq);
			} else {
				ctrl.timer = setTimeout(() => {
					ctrl.timer = undefined;
					if (card.isConnected && seq === ctrl.reqSeq) runRender(ctrl.code, seq);
				}, 260);
			}
		};

		zoomBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!ctrl.lastSvg) return;
			ctrl.view.state.facet(liveCallbacksFacet)?.onOpenMermaidLightbox?.({ svg: ctrl.lastSvg, code: ctrl.code });
		});

		stageEl.addEventListener("dblclick", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!ctrl.lastSvg) return;
			ctrl.view.state.facet(liveCallbacksFacet)?.onOpenMermaidLightbox?.({ svg: ctrl.lastSvg, code: ctrl.code });
		});

		doneBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const doc = ctrl.view.state.doc;
			if (ctrl.closeLine < doc.lines) {
				const nextLine = doc.line(ctrl.closeLine + 1);
				ctrl.view.focus();
				ctrl.view.dispatch({
					selection: EditorSelection.cursor(nextLine.from),
					effects: [setRawEditBlockEffect.of(null), EditorView.scrollIntoView(nextLine.from, { y: "nearest" })],
				});
			} else {
				const endPos = doc.length;
				ctrl.view.focus();
				ctrl.view.dispatch({
					changes: { from: endPos, to: endPos, insert: "\n" },
					selection: EditorSelection.cursor(endPos + 1),
					effects: setRawEditBlockEffect.of(null),
					userEvent: "input",
				});
			}
		});

		ctrl.scheduleRender(true);
		return card;
	}

	destroy(dom: HTMLElement): void {
		const ctrl = (dom as LivePreviewDom).__mermaidLive;
		if (ctrl?.timer !== undefined) {
			clearTimeout(ctrl.timer);
			ctrl.timer = undefined;
		}
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export const mermaidLivePreviewTheme = EditorView.baseTheme({
	".cm-md-mermaid-live-preview": {
		marginTop: "6px",
		borderStyle: "dashed",
	},
	".cm-md-mermaid-live-title": {
		display: "inline-flex",
		alignItems: "center",
		gap: "8px",
	},
	".cm-md-mermaid-live-status": {
		fontSize: "var(--text-xs, 11px)",
		color: "var(--editor-muted, var(--muted))",
		fontWeight: "500",
	},
	".cm-md-mermaid-live-status.is-error": {
		color: "var(--error)",
	},
	".cm-md-mermaid-err-banner": {
		display: "flex",
		alignItems: "center",
		gap: "6px",
		padding: "6px 10px",
		borderBottom: "1px solid color-mix(in srgb, var(--error) 35%, transparent)",
		backgroundColor: "color-mix(in srgb, var(--error) 10%, transparent)",
		color: "var(--error)",
		fontFamily: "var(--ui-font)",
		fontSize: "var(--text-xs, 12px)",
		lineHeight: "1.4",
	},
	".cm-md-mermaid-err-line-btn": {
		flex: "none",
		padding: "1px 6px",
		borderRadius: "var(--radius-sm, 4px)",
		border: "1px solid color-mix(in srgb, var(--error) 45%, transparent)",
		backgroundColor: "color-mix(in srgb, var(--error) 14%, transparent)",
		color: "var(--error)",
		fontFamily: "var(--code-font, ui-monospace, monospace)",
		fontSize: "11px",
		fontWeight: "600",
		cursor: "pointer",
	},
	".cm-md-mermaid-err-msg": {
		minWidth: "0",
		overflowWrap: "anywhere",
	},
	".cm-md-mermaid-stage.is-stale": {
		opacity: "0.45",
	},
});
