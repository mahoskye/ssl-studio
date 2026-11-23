// Lazy-loaded theme-aware Mermaid diagram widget for CodeMirror 6 Live & Read views.
// Loads `mermaid` on demand only when a Markdown document contains a ```mermaid fence.
import { EditorSelection } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { liveCallbacksFacet, setRawEditBlockEffect } from "./cmLiveShared";

let mermaidMod: typeof import("mermaid").default | null = null;
let lastThemeMode: "dark" | "light" | null = null;
let renderSeq = 0;

/** LRU cache of rendered Mermaid SVGs keyed by `${mode}\0${code}` so typing above a diagram never flashes. */
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

async function renderMermaidSvg(code: string, forceMode?: "dark" | "light"): Promise<{ svg?: string; error?: string }> {
	const trimmed = code.trim();
	const mode = forceMode ?? (isDarkEditorTheme() ? "dark" : "light");
	const cacheKey = `${mode}\0${trimmed}`;
	const hit = svgCache.get(cacheKey);
	if (hit) {
		cacheSvg(cacheKey, hit);
		return { svg: hit };
	}
	try {
		if (!mermaidMod) {
			const imported = await import("mermaid");
			mermaidMod = imported.default;
		}
		if (lastThemeMode !== mode) {
			mermaidMod.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				suppressErrorRendering: true,
				theme: mode === "dark" ? "dark" : "default",
				fontFamily: "var(--ui-font, system-ui, sans-serif)",
			});
			lastThemeMode = mode;
		}
		const id = `ssl-studio-mermaid-${++renderSeq}`;
		const { svg } = await mermaidMod.render(id, trimmed);
		cacheSvg(cacheKey, svg);
		return { svg };
	} catch (e: any) {
		return { error: String(e?.message ?? e) };
	}
}

/** Renders a light-mode SVG string for standalone HTML / Print / Ticket Release Packet exports. */
export async function renderMermaidSvgForExport(code: string): Promise<string | null> {
	const res = await renderMermaidSvg(code, "light");
	return res.svg ?? null;
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
		copyBtn.textContent = "Copy";
		copyBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			view.state.facet(liveCallbacksFacet)?.onCopyCode(this.code);
			copyBtn.textContent = "Copied";
			setTimeout(() => {
				if (copyBtn.isConnected) copyBtn.textContent = "Copy";
			}, 1400);
		});
		actions.append(copyBtn);

		head.append(badge, actions);

		const stage = document.createElement("div");
		stage.className = "cm-md-mermaid-stage";

		const mode = isDarkEditorTheme() ? "dark" : "light";
		const cached = svgCache.get(`${mode}\0${this.code.trim()}`);
		if (cached) {
			stage.innerHTML = cached;
		} else {
			const loading = document.createElement("span");
			loading.className = "cm-md-mermaid-loading";
			loading.textContent = "Rendering diagram…";
			stage.append(loading);
			void renderMermaidSvg(this.code, mode).then(({ svg, error }) => {
				if (!stage.isConnected) return;
				if (svg) {
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
