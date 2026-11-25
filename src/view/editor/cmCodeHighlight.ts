// CodeMirror 6 ViewPlugin that applies Monaco / TextMate editor syntax colours
// (`.mtk*` token classes) to fenced code blocks in both Live and Read Markdown
// views (ADR 0003 & ADR 0028).
//
// Zero-flicker design:
// - Synchronous LRU cache hits apply immediately inside `update()`.
// - During active typing inside a code block, existing decorations map through
//   `update.changes` so tokens stay coloured without flashing monochrome while
//   Monaco asynchronously re-tokenizes the updated block.
import { syntaxTree } from "@codemirror/language";
import { StateEffect, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isFenceClose, parseFenceOpen, stripQuotePrefix } from "../../shared/codeTokens";
import { frontMatter } from "../../shared/frontMatter";
import { currentThemeVersion, syncCodeTokenStyles } from "../themes/themes";
import { liveBlockField } from "./cmLivePlugin";
import { rawEditBlockField, refreshLiveEffect, searchStateSig, setRawEditBlockEffect } from "./cmLiveShared";
import { getCachedCodeTokens, resolveCodeLanguage, tokenizeCodeBlock } from "./markdownCode";

/** Dispatched once async Monaco tokenization completes for one or more visible code fences. */
export const codeHighlightReadyEffect = StateEffect.define<number>();

const MAX_BLOCK_LINES = 2000;
const MAX_BLOCK_CHARS = 100_000;
const TYPING_DEBOUNCE_MS = 35;

type VisibleFence = {
	bodyFrom: number;
	bodyTo: number;
	bodyStart: number;
	bodyEnd: number;
	langId: string;
	codeText: string;
	offsets: number[];
};

type MissingJob = {
	langId: string;
	codeText: string;
	themeVer: number;
};

function frontmatterEnd(state: EditorState): number {
	const fm = frontMatter(state.doc.toString());
	if (!fm.lines || fm.lines > state.doc.lines) return 0;
	return state.doc.line(fm.lines).to;
}

function collectVisibleFences(view: EditorView): VisibleFence[] {
	const { state } = view;
	const fmEnd = frontmatterEnd(state);
	const skippedWidgets: [number, number][] = [];
	const blockDecos = state.field(liveBlockField, false);
	if (blockDecos) {
		blockDecos.between(0, state.doc.length, (from, to, deco) => {
			if (deco.spec.widget && from < to) skippedWidgets.push([from, to]);
		});
	}
	const isWidgetCovered = (from: number, to: number) => skippedWidgets.some(([a, b]) => from >= a && to <= b);

	const out: VisibleFence[] = [];
	const seen = new Set<number>();
	const tree = syntaxTree(state);

	for (const range of view.visibleRanges) {
		tree.iterate({
			from: range.from,
			to: range.to,
			enter(node) {
				if (node.to <= fmEnd) return false;
				if (node.name !== "FencedCode") return;
				if (seen.has(node.from)) return false;
				seen.add(node.from);
				if (isWidgetCovered(node.from, node.to)) return false;

				const startLine = state.doc.lineAt(node.from);
				const endLine = state.doc.lineAt(node.to);
				const open = parseFenceOpen(startLine.text);
				if (!open || !open.lang) return false;
				const langId = resolveCodeLanguage(open.lang);
				if (!langId) return false;

				const quoted = open.quotePrefix.length > 0;
				const hasClose = endLine.number > startLine.number && isFenceClose(endLine.text, open.fenceChar, open.fenceLen, quoted);
				const bodyStart = startLine.number + 1;
				const bodyEnd = hasClose ? endLine.number - 1 : endLine.number;
				if (bodyStart > bodyEnd) return false;
				if (bodyEnd - bodyStart + 1 > MAX_BLOCK_LINES) return false;

				const lines: string[] = [];
				const offsets: number[] = [];
				let totalChars = 0;
				for (let n = bodyStart; n <= bodyEnd; n++) {
					const stripped = stripQuotePrefix(state.doc.line(n).text, quoted);
					totalChars += stripped.text.length + 1;
					if (totalChars > MAX_BLOCK_CHARS) return false;
					lines.push(stripped.text);
					offsets.push(stripped.offset);
				}

				const bodyFrom = state.doc.line(bodyStart).from;
				const bodyTo = state.doc.line(bodyEnd).to;
				out.push({
					bodyFrom,
					bodyTo,
					bodyStart,
					bodyEnd,
					langId,
					codeText: lines.join("\n"),
					offsets,
				});
				return false;
			},
		});
	}
	return out;
}

function lineOverlapsVisible(view: EditorView, from: number, to: number): boolean {
	for (const r of view.visibleRanges) {
		if (from <= r.to && to >= r.from) return true;
	}
	return false;
}

export const liveCodeHighlightPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet = Decoration.none;
		private destroyed = false;
		private debounceTimer: ReturnType<typeof setTimeout> | undefined;
		private requestSeq = 0;
		private readySeq = 0;
		private lastThemeVer = -1;
		private lastBlockLangs = new Map<number, string>();

		constructor(view: EditorView) {
			this.rebuild(view, false, false);
		}

		update(update: ViewUpdate) {
			if (update.docChanged) {
				// Preserve token positions across keystrokes so editing never flashes monochrome.
				this.decorations = this.decorations.map(update.changes);
			}
			const refreshed = update.transactions.some(
				(tr) =>
					tr.reconfigured ||
					tr.effects.some(
						(e) =>
							e.is(refreshLiveEffect) ||
							e.is(codeHighlightReadyEffect) ||
							e.is(setRawEditBlockEffect),
					),
			);
			const rawChanged = update.startState.field(rawEditBlockField, false) !== update.state.field(rawEditBlockField, false);
			const searchChanged = searchStateSig(update.startState) !== searchStateSig(update.state);
			if (
				update.docChanged ||
				update.viewportChanged ||
				refreshed ||
				rawChanged ||
				searchChanged ||
				syntaxTree(update.startState) !== syntaxTree(update.state)
			) {
				this.rebuild(update.view, update.docChanged, update.docChanged);
			}
		}

		private rebuild(view: EditorView, preserveMapped: boolean, debounce: boolean) {
			const themeVer = currentThemeVersion();
			const sameTheme = this.lastThemeVer === themeVer;
			const fences = collectVisibleFences(view);
			const decos: Range<Decoration>[] = [];
			const missing: MissingJob[] = [];
			const nextLangs = new Map<number, string>();

			for (const block of fences) {
				const cached = getCachedCodeTokens(block.codeText, block.langId, themeVer);
				if (cached) {
					nextLangs.set(block.bodyStart, block.langId);
					const lineCount = Math.min(cached.length, block.bodyEnd - block.bodyStart + 1);
					for (let i = 0; i < lineCount; i++) {
						const spans = cached[i];
						if (!spans?.length) continue;
						const ln = view.state.doc.line(block.bodyStart + i);
						if (!lineOverlapsVisible(view, ln.from, ln.to)) continue;
						const lineOffset = block.offsets[i] ?? 0;
						for (const span of spans) {
							const from = ln.from + lineOffset + span.from;
							const to = Math.min(ln.to, ln.from + lineOffset + span.to);
							if (from >= ln.from && from < to && to <= ln.to) {
								decos.push(Decoration.mark({ class: `cm-md-code-tok ${span.className}` }).range(from, to));
							}
						}
					}
				} else {
					missing.push({ langId: block.langId, codeText: block.codeText, themeVer });
					if (preserveMapped && sameTheme && this.lastBlockLangs.get(block.bodyStart) === block.langId) {
						nextLangs.set(block.bodyStart, block.langId);
						this.decorations.between(block.bodyFrom, block.bodyTo, (from, to, value) => {
							const clampedFrom = Math.max(block.bodyFrom, from);
							const clampedTo = Math.min(block.bodyTo, to);
							if (clampedFrom < clampedTo) decos.push(value.range(clampedFrom, clampedTo));
						});
					}
				}
			}

			this.lastThemeVer = themeVer;
			this.lastBlockLangs = nextLangs;
			this.decorations = Decoration.set(decos, true);

			if (decos.length && typeof document !== "undefined" && !document.getElementById("studio-code-tokens")) {
				syncCodeTokenStyles();
			}

			if (missing.length) {
				this.schedule(view, missing, debounce);
			} else if (this.debounceTimer !== undefined) {
				clearTimeout(this.debounceTimer);
				this.debounceTimer = undefined;
			}
		}

		private schedule(view: EditorView, jobs: MissingJob[], debounce: boolean) {
			if (this.debounceTimer !== undefined) {
				clearTimeout(this.debounceTimer);
				this.debounceTimer = undefined;
			}
			const deduped = new Map<string, MissingJob>();
			for (const job of jobs) {
				deduped.set(`${job.themeVer}\u0000${job.langId}\u0000${job.codeText}`, job);
			}
			const list = [...deduped.values()];
			const req = ++this.requestSeq;

			const run = () => {
				this.debounceTimer = undefined;
				void Promise.all(list.map((job) => tokenizeCodeBlock(job.codeText, job.langId, job.themeVer))).then((results) => {
					if (this.destroyed || this.requestSeq !== req) return;
					if (!results.some(Boolean)) return;
					view.dispatch({ effects: codeHighlightReadyEffect.of(++this.readySeq) });
				});
			};

			if (debounce) {
				this.debounceTimer = setTimeout(run, TYPING_DEBOUNCE_MS);
			} else {
				run();
			}
		}

		destroy() {
			this.destroyed = true;
			if (this.debounceTimer !== undefined) {
				clearTimeout(this.debounceTimer);
				this.debounceTimer = undefined;
			}
		}
	},
	{ decorations: (v) => v.decorations },
);
