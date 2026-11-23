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
					err.textContent = `Mermaid diagram could not be rendered: ${error ?? "syntax error"}`;
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
