// Review of a proposed text against the current one: local-history restores
// and every agent step go through here. Nothing changes until Accept, and
// Accept is an undoable edit, not a save (ADR 0002). The review stays open
// until the accept has worked, so a failed write loses nothing.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { parseCsv } from "../../shared/csv";
import { DEFAULT_CODE_FONT, resolveFontStack } from "../../shared/fonts";
import { frontMatter } from "../../shared/frontMatter";
import { diffMarkdownBlocks, diffPlainTextHtml, type MarkdownDiffRow } from "../../shared/markdownDiff";
import { initialReviewLayout, reviewLayoutKey, type ReviewFormat, type ReviewLayout } from "../../shared/menuBar";
import { Icon } from "../Icon";
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { choose } from "../dialogs";
import { canonical, keepTab, state, notify } from "../state";
import { baseName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { recall, remember } from "../graph/canvas";
import { CenterTabStrip } from "./CenterTabStrip";
import { observeMarkerHoverSeverity } from "./hoverSeverity";
import { languageFor } from "./languages";
import { finishMarkdown, hydrateMathInElement } from "./markdownHtml";
import { monaco } from "./monaco";
import { changeSize, reviewFlow } from "./reviewFlow";

/** `ok: null` is a check that could not be made, or a fact to keep in mind: it is never shown as a pass. */
export type Check = { label: string; ok: boolean | null; detail?: string };
export type Review = {
	/** What is being reviewed, in a few words: "Tidy 2/6 Guards", "Snapshot 12:04". */
	title: string;
	/** The file under review, absolute or relative to the workspace. Shown beside the title. */
	path?: string;
	original: string;
	proposed: string;
	language: string;
	checks?: Check[];
	/** Shown above the diff: the agent's note for this step. */
	note?: string;
	/** The accept button's words when "Accept" would not say enough: "Restore this snapshot". */
	acceptLabel?: string;
	/** The reject/cancel button's words when "Reject" would not say enough: "Close". */
	rejectLabel?: string;
	/** What accepting will do, as a sentence for the header: "Accepting puts the right side into the editor. The file is not saved." */
	effect?: string;
	/** Why this cannot be accepted as it stands: a check it must pass has failed. */
	blocked?: string;
	/** Custom column titles for actionable reviews (e.g. left: "Snapshot 14:02", right: "Current"). */
	sides?: { left: string; right: string };
	/** Which side Accept passes to `onAccept` (defaults to "proposed"). When "original", right side is read-only. */
	acceptSide?: "proposed" | "original";
	/** Force both sides read-only even on actionable reviews. */
	readOnly?: boolean;
	/**
	 * Two texts to look at side by side, with nothing to accept: a file against what git has of it. The names of the
	 * two sides. Neither side can be edited, and the one button closes.
	 */
	compare?: { left: string; right: string };
	/** True when replacing this review loses nothing (read-only comparisons) and needs no prompt. */
	replaceable?: boolean;
	/** May fail: the review then stays open and shows the error. */
	onAccept: (text: string) => void | Promise<void>;
	onReject?: () => void | Promise<void>;
};

export type ComparisonInput = {
	title: string;
	path?: string;
	before: string;
	after: string;
	beforeLabel: string;
	afterLabel: string;
	language?: string;
	effect?: string;
};

const [review, setReview] = createSignal<Review | null>(null);
/** Synchronous mirror of `review()` so Solid 2 deferred writes never cause stale read-after-write in `reviewFlow` or `closeComparison`. */
let currentReview: Review | null = null;
export { review };

const flow = reviewFlow<Review>({
	current: () => currentReview,
	show: (r) => {
		currentReview = r;
		setReview(r);
	},
	// Looked up when asked, not when this module loads: state.ts and this file import each other.
	choose: (title, buttons) => choose(title, buttons),
	fail: (text) => notify(text, "error"),
	replaceable: (r) => Boolean(r.replaceable || r.compare),
});

/**
 * Opens a review. When another one is open the user is asked first: replacing
 * rejects the open one (its `onReject` runs). Resolves false when the user kept
 * the open one, so this one was not shown.
 */
export const openReview = (r: Review): Promise<boolean> => {
	// What is accepted here is written into the file's document: a tab it has for a look is kept, so that the next
	// file clicked does not take the document away under the review. A comparison writes nothing, and keeps nothing.
	if (!r.compare && r.path && state.workspace) keepTab(canonical(isInside(state.workspace.root, r.path) ? r.path : joinPath(state.workspace.root, ...r.path.split(/[\\/]/))));
	return flow.open(r);
};
/** Force-closes any open review without prompting, notifying its owner via `onReject`. */
export const closeReview = () => flow.close();
/** A comparison gives way to a file that is opened: it holds nothing to lose, and would otherwise stand in front of the file. */
export const closeComparison = () => void (currentReview?.compare && flow.close());

/** Opens a read-only side-by-side comparison (`before` on the left vs `after` on the right) in ReviewView. */
export function openComparison(input: ComparisonInput): Promise<boolean> {
	return openReview({
		title: input.title,
		path: input.path,
		original: input.before,
		proposed: input.after,
		language: input.language ?? (input.path ? languageFor(input.path) : "plaintext"),
		compare: { left: input.beforeLabel, right: input.afterLabel },
		replaceable: true,
		effect: input.effect ?? `${input.beforeLabel} compared with ${input.afterLabel}. Nothing here changes either.`,
		onAccept: () => {},
	});
}
export const compareTexts = openComparison;

type CsvDiffRow = {
	kind: "same" | "added" | "removed" | "modified";
	oldCells?: string[];
	newCells?: string[];
};

const FORBID_TAGS = [
	"script",
	"style",
	"iframe",
	"object",
	"embed",
	"form",
	"input",
	"button",
	"textarea",
	"select",
	"img",
	"picture",
	"source",
	"video",
	"audio",
	"svg",
	"math",
	"canvas",
	"dialog",
	"area",
	"track",
];
const FORBID_ATTR = [
	"style",
	"background",
	"poster",
	"src",
	"srcset",
	"ping",
	"action",
	"formaction",
	"popover",
	"popovertarget",
	"command",
	"commandfor",
];
const REVIEW_PURIFY_CONFIG = { FORBID_TAGS, FORBID_ATTR, ALLOW_DATA_ATTR: false };

function escapeHtmlText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMarkdownBlockHtml(source: string, preRendered?: boolean): string {
	const rawHtml = preRendered ? source : (marked.parse(source, { async: false, gfm: true }) as string);
	const clean = DOMPurify.sanitize(rawHtml, REVIEW_PURIFY_CONFIG);
	return preRendered ? clean : finishMarkdown(clean, { anchors: false });
}

type RenderedMdDiffRow = {
	kind: MarkdownDiffRow["kind"];
	blockKind: MarkdownDiffRow["blockKind"];
	leftHtml: string;
	rightHtml: string;
};

type RenderedMdDiff = {
	fmBeforeHtml: string;
	fmAfterHtml: string;
	fmChanged: boolean;
	rows: RenderedMdDiffRow[];
	stats: { same: number; added: number; removed: number; modified: number };
};

/** Computes aligned, sanitized left/right Rendered Markdown diff blocks + frontmatter diff. */
function buildRenderedMarkdownDiff(beforeText: string, afterText: string): RenderedMdDiff {
	const beforeFmParsed = frontMatter(beforeText);
	const afterFmParsed = frontMatter(afterText);
	const fmBeforeRaw = beforeFmParsed.lines > 0 ? beforeText.split(/\r?\n/).slice(0, beforeFmParsed.lines).join("\n").trim() : "";
	const fmAfterRaw = afterFmParsed.lines > 0 ? afterText.split(/\r?\n/).slice(0, afterFmParsed.lines).join("\n").trim() : "";
	const fmChanged = fmBeforeRaw !== fmAfterRaw;

	let fmBeforeHtml = "";
	let fmAfterHtml = "";
	if (fmBeforeRaw || fmAfterRaw) {
		if (!fmChanged) {
			fmBeforeHtml = escapeHtmlText(fmBeforeRaw);
			fmAfterHtml = escapeHtmlText(fmAfterRaw);
		} else if (fmBeforeRaw && fmAfterRaw) {
			const fmDiff = diffPlainTextHtml(fmBeforeRaw, fmAfterRaw);
			fmBeforeHtml = DOMPurify.sanitize(fmDiff.before, REVIEW_PURIFY_CONFIG);
			fmAfterHtml = DOMPurify.sanitize(fmDiff.after, REVIEW_PURIFY_CONFIG);
		} else if (fmBeforeRaw) {
			fmBeforeHtml = `<del class="md-diff-del">${escapeHtmlText(fmBeforeRaw)}</del>`;
		} else {
			fmAfterHtml = `<ins class="md-diff-ins">${escapeHtmlText(fmAfterRaw)}</ins>`;
		}
	}

	const diff = diffMarkdownBlocks(beforeFmParsed.body, afterFmParsed.body);
	const rows: RenderedMdDiffRow[] = diff.rows.map((row) => {
		if (row.kind === "same") {
			const html = renderMarkdownBlockHtml(row.after ?? row.before ?? "");
			return { kind: row.kind, blockKind: row.blockKind, leftHtml: html, rightHtml: html };
		}
		if (row.kind === "added") {
			return { kind: row.kind, blockKind: row.blockKind, leftHtml: "", rightHtml: renderMarkdownBlockHtml(row.after ?? "") };
		}
		if (row.kind === "removed") {
			return { kind: row.kind, blockKind: row.blockKind, leftHtml: renderMarkdownBlockHtml(row.before ?? ""), rightHtml: "" };
		}
		return {
			kind: row.kind,
			blockKind: row.blockKind,
			leftHtml: renderMarkdownBlockHtml(row.beforeHighlighted ?? row.before ?? "", row.preRendered),
			rightHtml: renderMarkdownBlockHtml(row.afterHighlighted ?? row.after ?? "", row.preRendered),
		};
	});

	return { fmBeforeHtml, fmAfterHtml, fmChanged, rows, stats: diff.stats };
}

/** Computes a structured row/cell diff between two CSV/TSV texts. Uses col-0 key alignment when keys are unique, else positional LCS. */
function diffCsvTables(originalText: string, proposedText: string): {
	headers: { old: string; cur: string; changed: boolean }[];
	rows: CsvDiffRow[];
	stats: { added: number; removed: number; modified: number; same: number };
} {
	const left = parseCsv(originalText);
	const right = parseCsv(proposedText);
	const leftHeaders = left.header.map((c) => c.text);
	const rightHeaders = right.header.map((c) => c.text);
	const colCount = Math.max(leftHeaders.length, rightHeaders.length);
	const headers = Array.from({ length: colCount }, (_, i) => {
		const o = leftHeaders[i] ?? "";
		const n = rightHeaders[i] ?? "";
		return { old: o, cur: n, changed: o !== n };
	});

	const pad = (cells: { text: string }[]) => Array.from({ length: colCount }, (_, i) => cells[i]?.text ?? "");
	const oldRows = left.rows.map(pad);
	const newRows = right.rows.map(pad);

	const uniqueKeys = (rows: string[][]) => {
		if (!rows.length) return true;
		const seen = new Set<string>();
		for (const r of rows) {
			const k = (r[0] ?? "").trim().toLowerCase();
			if (!k || seen.has(k)) return false;
			seen.add(k);
		}
		return true;
	};

	const diffRows: CsvDiffRow[] = [];
	const stats = { added: 0, removed: 0, modified: 0, same: 0 };

	if ((oldRows.length > 0 || newRows.length > 0) && uniqueKeys(oldRows) && uniqueKeys(newRows)) {
		const oldByKey = new Map(oldRows.map((r) => [r[0]!.trim().toLowerCase(), r]));
		const matchedOld = new Set<string>();
		for (const nr of newRows) {
			const k = nr[0]!.trim().toLowerCase();
			const or = oldByKey.get(k);
			if (!or) {
				diffRows.push({ kind: "added", newCells: nr });
				stats.added++;
			} else {
				matchedOld.add(k);
				const same = or.every((v, i) => v === nr[i]);
				if (same) {
					diffRows.push({ kind: "same", oldCells: or, newCells: nr });
					stats.same++;
				} else {
					diffRows.push({ kind: "modified", oldCells: or, newCells: nr });
					stats.modified++;
				}
			}
		}
		for (const or of oldRows) {
			const k = or[0]!.trim().toLowerCase();
			if (!matchedOld.has(k)) {
				diffRows.push({ kind: "removed", oldCells: or });
				stats.removed++;
			}
		}
	} else {
		const maxLen = Math.max(oldRows.length, newRows.length);
		for (let i = 0; i < maxLen; i++) {
			const or = oldRows[i];
			const nr = newRows[i];
			if (or && nr) {
				const same = or.every((v, idx) => v === nr[idx]);
				if (same) {
					diffRows.push({ kind: "same", oldCells: or, newCells: nr });
					stats.same++;
				} else {
					diffRows.push({ kind: "modified", oldCells: or, newCells: nr });
					stats.modified++;
				}
			} else if (nr) {
				diffRows.push({ kind: "added", newCells: nr });
				stats.added++;
			} else if (or) {
				diffRows.push({ kind: "removed", oldCells: or });
				stats.removed++;
			}
		}
	}
	return { headers, rows: diffRows, stats };
}

export function ReviewView() {
	let root!: HTMLDivElement;
	let host!: HTMLDivElement;
	let editor: monaco.editor.IStandaloneDiffEditor | undefined;
	let proposedModel: monaco.editor.ITextModel | undefined;
	let untouched = 0;
	const r = untrack(review)!;
	const isMdReview = /\.(md|markdown)$/i.test(r.path ?? "") || r.language === "markdown";
	const isCsvReview = /\.(csv|tsv)$/i.test(r.path ?? "");
	const reviewFormat: ReviewFormat = isMdReview ? "markdown" : isCsvReview ? "csv" : "code";
	const layoutKey = reviewLayoutKey(reviewFormat);
	const [busy, setBusy] = createSignal(false);
	const [rejecting, setRejecting] = createSignal(false);
	const [error, setError] = createSignal("");
	/** The lines the proposal adds and takes away, once the diff has been worked out. */
	const [size, setSize] = createSignal("");
	/** Live proposed text synced from Monaco so Rendered / Table views reflect in-review edits. */
	const [liveProposed, setLiveProposed] = createSignal(r.proposed);
	/** Explicit per-format diff layout (ADR 0027): Markdown defaults to Rendered, CSV to Table, code to Split. */
	const [diffLayout, setDiffLayout] = createSignal<ReviewLayout>(initialReviewLayout(reviewFormat, recall(layoutKey)));
	const [mdOnlyChanged, setMdOnlyChanged] = createSignal(false);
	const [csvOnlyChanged, setCsvOnlyChanged] = createSignal(false);
	const chooseLayout = (next: ReviewLayout) => {
		setDiffLayout(next);
		remember(layoutKey, next);
	};
	const isCodeDiff = () => diffLayout() === "split" || diffLayout() === "inline";
	const renderedDiff = createMemo(() => (isMdReview && diffLayout() === "rendered" ? buildRenderedMarkdownDiff(r.original, liveProposed()) : null));
	const csvDiff = createMemo(() => (isCsvReview && diffLayout() === "table" ? diffCsvTables(r.original, liveProposed()) : null));
	const isReadOnly = Boolean(r.compare || r.readOnly || r.acceptSide === "original");
	const leftLabel = r.compare?.left ?? r.sides?.left ?? "Now";
	const rightLabel = r.compare?.right ?? r.sides?.right ?? "Proposed";
	const label = r.acceptLabel ?? "Accept";
	const rejectLabel = r.rejectLabel ?? "Reject";
	const file = () => (r.path ? relativeTo(state.workspace?.root, r.path) : "");
	const tabTitle = r.path ? (r.compare ? `${baseName(r.path)} (diff)` : `Review: ${baseName(r.path)}`) : r.title;
	const effect = r.effect ?? `"${label}" applies the ${r.acceptSide === "original" ? "left" : "right"} side.`;

	// Bidirectional block-aligned vertical scroll sync between Rendered Markdown diff panes.
	let leftPaneEl: HTMLDivElement | undefined;
	let rightPaneEl: HTMLDivElement | undefined;
	let syncingFrom: "left" | "right" | null = null;
	let syncFrame = 0;
	const syncRenderedScroll = (from: "left" | "right") => {
		const src = from === "left" ? leftPaneEl : rightPaneEl;
		const dst = from === "left" ? rightPaneEl : leftPaneEl;
		if (!src || !dst) return;
		if (syncingFrom && syncingFrom !== from) return;
		syncingFrom = from;
		if (syncFrame) cancelAnimationFrame(syncFrame);

		const maxSrc = Math.max(0, src.scrollHeight - src.clientHeight);
		const maxDst = Math.max(0, dst.scrollHeight - dst.clientHeight);
		if (maxSrc <= 0 || maxDst <= 0) {
			dst.scrollTop = 0;
		} else if (src.scrollTop <= 1) {
			dst.scrollTop = 0;
		} else if (src.scrollTop >= maxSrc - 2) {
			dst.scrollTop = maxDst;
		} else {
			const srcBlocks = [...src.querySelectorAll<HTMLElement>("[data-block-idx]")];
			const dstBlocks = [...dst.querySelectorAll<HTMLElement>("[data-block-idx]")];
			let synced = false;
			if (srcBlocks.length && srcBlocks.length === dstBlocks.length) {
				const top = src.scrollTop;
				let anchorIdx = srcBlocks.length - 1;
				for (let i = 0; i < srcBlocks.length; i++) {
					const el = srcBlocks[i]!;
					if (el.offsetTop + el.offsetHeight > top) {
						anchorIdx = i;
						break;
					}
				}
				const sEl = srcBlocks[anchorIdx]!;
				const dEl = dstBlocks[anchorIdx]!;
				const frac = Math.max(0, Math.min(1, (top - sEl.offsetTop) / Math.max(1, sEl.offsetHeight)));
				dst.scrollTop = Math.min(maxDst, Math.max(0, dEl.offsetTop + frac * dEl.offsetHeight));
				synced = true;
			}
			if (!synced) {
				dst.scrollTop = (src.scrollTop / maxSrc) * maxDst;
			}
		}

		syncFrame = requestAnimationFrame(() => {
			syncFrame = 0;
			syncingFrom = null;
		});
	};

	onSettled(() => {
		const original = monaco.editor.createModel(r.original, r.language);
		const proposed = (proposedModel = monaco.editor.createModel(r.proposed, r.language));
		if (r.original.includes("\n")) proposed.setEOL(original.getEndOfLineSequence());
		const diff = (editor = monaco.editor.createDiffEditor(host, {
			automaticLayout: true,
			renderSideBySide: diffLayout() !== "inline",
			useInlineViewWhenSpaceIsLimited: false,
			originalEditable: false,
			readOnly: isReadOnly,
			fontSize: state.settings.fontSize,
			fixedOverflowWidgets: true,
			selectionClipboard: false,
		}));
		diff.setModel({ original, modified: proposed });
		// Ctrl+F12 goes to the definition here as it does in the editor: each side is told it is in a web view,
		// which is where the editor keeps that key (see EditorGroup.tsx).
		for (const side of [diff.getOriginalEditor(), diff.getModifiedEditor()]) side.createContextKey("isWeb", true);
		// How large the change is, kept up to date as the right side is edited.
		const sized = diff.onDidUpdateDiff(() => setSize(changeSize(diff.getLineChanges())));
		const synced = proposed.onDidChangeContent(() => setLiveProposed(proposed.getValue()));
		const stopHoverSevs = [diff.getOriginalEditor(), diff.getModifiedEditor()].map((side) => observeMarkerHoverSeverity(side));
		untouched = proposed.getAlternativeVersionId();
		// Escape needs the keyboard in here. Typing somewhere else (the agent's composer) is left alone.
		const focused = document.activeElement;
		if (!focused || focused === document.body || root.contains(focused)) {
			if (isCodeDiff()) diff.getModifiedEditor().focus();
			else root.focus();
		}
		return () => {
			if (syncFrame) cancelAnimationFrame(syncFrame);
			sized.dispose();
			synced.dispose();
			for (const stop of stopHoverSevs) stop();
			editor = undefined;
			proposedModel = undefined;
			diff.dispose();
			original.dispose();
			proposed.dispose();
		};
	});
	// Both sides follow the Font size, Code font, and explicit Side-by-Side / Inline layout choice.
	createEffect(
		() => ({
			fontSize: state.settings.fontSize,
			fontFamily: state.settings.codeFont?.trim() ? resolveFontStack(state.settings.codeFont, DEFAULT_CODE_FONT) : undefined,
			sideBySide: diffLayout() !== "inline",
			codeDiff: isCodeDiff(),
		}),
		({ fontSize, fontFamily, sideBySide, codeDiff }) => {
			editor?.updateOptions({
				fontSize,
				renderSideBySide: sideBySide,
				useInlineViewWhenSpaceIsLimited: false,
				...(fontFamily ? { fontFamily } : {}),
			});
			if (codeDiff) queueMicrotask(() => editor?.layout());
		},
	);

	// Undoing every edit counts as not edited: the version id goes back with the text.
	const edited = () => !isReadOnly && Boolean(proposedModel && !proposedModel.isDisposed() && proposedModel.getAlternativeVersionId() !== untouched);
	let isBusy = false;
	let isRejecting = false;
	const accept = async () => {
		if (isBusy || isRejecting || busy() || rejecting() || r.blocked || !proposedModel) return;
		isBusy = true;
		setBusy(true);
		setError("");
		try {
			const nextText = r.acceptSide === "original" ? r.original : proposedModel.getValue();
			const failed = await flow.accept(r, nextText);
			if (failed !== null) setError(failed);
		} finally {
			isBusy = false;
			setBusy(false);
		}
	};
	const reject = async () => {
		if (isBusy || isRejecting || busy() || rejecting()) return;
		isRejecting = true;
		setRejecting(true);
		try {
			await flow.reject(r, edited());
		} finally {
			isRejecting = false;
			setRejecting(false);
		}
	};
	// Monaco takes Escape first when it has a use for it (a find box, a selection) and stops it there.
	const onKey = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || e.defaultPrevented) return;
		e.preventDefault();
		void reject();
	};

	return (
		<CenterTabStrip title={tabTitle} tooltip={r.path ?? r.title} icon="split-horizontal" onClose={() => void reject()}>
			<div class="diff" ref={root} tabindex={-1} onKeyDown={onKey}>
				<div class="diff-bar review-bar">
					<div class="review-head">
						<div class="review-what">
							<strong>{r.title}</strong>
							<Show when={file()}>
								<span class="review-path" title={r.path}>
									{file()}
								</span>
							</Show>
						</div>
						<p class="review-effect">
							{r.compare
								? (r.effect ??
									(diffLayout() === "rendered"
										? "Shown rendered side by side. Nothing here changes either."
										: diffLayout() === "table"
											? "Shown as a structured table diff. Nothing here changes either."
											: diffLayout() === "split"
												? "The two are shown side by side. Nothing here changes either."
												: "Shown inline. Nothing here changes either."))
								: `${effect} ${rejectLabel} (Esc) changes nothing.`}
						</p>
					</div>
					<div class="review-actions">
						<div class="mode-switch diff-layout-switch" role="group" aria-label="Diff layout">
							<button class={{ on: diffLayout() === "split" }} aria-pressed={diffLayout() === "split" ? "true" : "false"} title="Show left and right versions side by side" onClick={() => chooseLayout("split")}>
								Side-by-Side
							</button>
							<button class={{ on: diffLayout() === "inline" }} aria-pressed={diffLayout() === "inline" ? "true" : "false"} title="Show changes inline in one column" onClick={() => chooseLayout("inline")}>
								Inline
							</button>
							<Show when={isMdReview}>
								<button
									class={{ on: diffLayout() === "rendered" }}
									aria-pressed={diffLayout() === "rendered" ? "true" : "false"}
									title="Show rendered Markdown diff side by side with inline highlights"
									onClick={() => chooseLayout("rendered")}
								>
									Rendered
								</button>
							</Show>
							<Show when={isCsvReview}>
								<button
									class={{ on: diffLayout() === "table" }}
									aria-pressed={diffLayout() === "table" ? "true" : "false"}
									title="Show structured CSV/TSV row and cell diff"
									onClick={() => chooseLayout("table")}
								>
									Table
								</button>
							</Show>
						</div>
						<Show
							when={!r.compare}
							fallback={
								<button class="primary" title="Close this comparison (Esc)" onClick={() => void reject()}>
									Close
								</button>
							}
						>
							<button class="primary" disabled={Boolean(r.blocked) || busy() || rejecting()} title={r.blocked ?? (busy() ? "Accepting…" : effect)} onClick={() => void accept()}>
								{label}
							</button>
							<button disabled={busy() || rejecting()} title={busy() ? "Wait for the accept to finish." : `${rejectLabel}: close this review and change nothing (Esc)`} onClick={() => void reject()}>
								{rejectLabel}
							</button>
						</Show>
					</div>
				</div>
				<Show when={error()}>
					<p class="review-error" role="alert">
						Not accepted: {error().replace(/\.$/, "")}. Nothing was lost: the proposed text is still here. Try again, or reject.
					</p>
				</Show>
				<Show when={r.checks?.length || r.note || r.blocked}>
					<div class="review-info">
						<Show when={r.blocked}>
							<p class="review-blocked">{r.blocked}</p>
						</Show>
						<Show when={r.checks?.length}>
							<ul class="checks">
								<For each={r.checks}>
									{(c) => (
										<li class={c.ok === null ? "unknown" : c.ok ? "pass" : "fail"} title={c.detail}>
											{c.ok === null ? "?" : <Icon name={c.ok ? "check" : "close"} />}
											{/* The mark is for the eye: what it says is said in words too. */}
											<span class="visually-hidden">{c.ok === null ? "Not known:" : c.ok ? "Passed:" : "Failed:"}</span> {c.label}
											<Show when={c.detail}>
												<span class="hint"> {c.detail}</span>
											</Show>
										</li>
									)}
								</For>
							</ul>
						</Show>
						<Show when={r.note}>
							<pre class="review-note">{r.note}</pre>
						</Show>
					</div>
				</Show>
				{/* Column headers bound strictly to the active diff layout (Defect B11 fix). */}
				<Show when={diffLayout() === "split" || diffLayout() === "rendered"}>
					<div class="diff-sides" aria-hidden="true">
						<span>{leftLabel}</span>
						<span>
							{rightLabel}{" "}
							<Show when={!isReadOnly && diffLayout() === "split"}>
								<span class="hint">you can edit this side</span>
							</Show>
							<span class="diff-size">{size()}</span>
						</span>
					</div>
				</Show>
				<Show when={diffLayout() === "inline"}>
					<div class="diff-sides inline" aria-hidden="true">
						<span class="diff-inline-label">
							{leftLabel}
							<Icon name="arrow-right" class="diff-inline-sep" />
							{rightLabel}
							<Show when={!isReadOnly}>
								<span class="hint">you can edit the proposed lines</span>
							</Show>
						</span>
						<span class="diff-size">{size()}</span>
					</div>
				</Show>
				<p class="visually-hidden" role="status">
					{size()}
				</p>
				<div class="diff-host" ref={host} style={{ display: isCodeDiff() ? undefined : "none" }} />
				<Show when={diffLayout() === "rendered" && renderedDiff()}>
					{(diff) => {
						const visibleRows = () => (mdOnlyChanged() ? diff().rows.filter((row) => row.kind !== "same") : diff().rows);
						const showFm = () => Boolean((diff().fmBeforeHtml || diff().fmAfterHtml) && (!mdOnlyChanged() || diff().fmChanged));
						const hasAnyVisible = () => visibleRows().length > 0 || showFm();
						createEffect(
							() => (diffLayout() === "rendered" ? visibleRows() : null),
							(rows) => {
								if (!rows?.length) return;
								let alive = true;
								queueMicrotask(() => {
									if (!alive) return;
									if (leftPaneEl?.isConnected) hydrateMathInElement(leftPaneEl);
									if (rightPaneEl?.isConnected) hydrateMathInElement(rightPaneEl);
								});
								return () => {
									alive = false;
								};
							},
						);
						return (
							<div class="review-md-wrap">
								<style>{`
									.review-md-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--editor-bg, var(--bg)); }
									.md-diff-block { position: relative; padding: var(--space-2) var(--space-3); margin-bottom: var(--space-2); border-radius: var(--radius-sm); border-left: 3px solid transparent; }
									.md-diff-block > :first-child { margin-top: 0; }
									.md-diff-block > :last-child { margin-bottom: 0; }
									.md-diff-block.md-diff-added { background: color-mix(in srgb, var(--ok) 10%, transparent); border-left-color: var(--ok); }
									.md-diff-block.md-diff-removed { background: color-mix(in srgb, var(--error) 10%, transparent); border-left-color: var(--error); }
									.md-diff-block.md-diff-modified { background: color-mix(in srgb, var(--warning) 8%, transparent); border-left-color: var(--warning); }
									.md-diff-del { background: color-mix(in srgb, var(--error) 22%, transparent); color: var(--error); text-decoration: line-through; padding: 0 2px; border-radius: 2px; }
									.md-diff-ins { background: color-mix(in srgb, var(--ok) 22%, transparent); color: var(--ok); text-decoration: none; border-bottom: 1.5px solid var(--ok); padding: 0 2px; border-radius: 2px; font-weight: 500; }
									.md-diff-placeholder { min-height: 28px; padding: var(--space-2) var(--space-3); margin-bottom: var(--space-2); border: 1px dashed var(--border); border-radius: var(--radius-sm); color: var(--muted); font-size: var(--text-xs); font-style: italic; display: flex; align-items: center; opacity: 0.78; }
								`}</style>
								<div class="review-csv-bar">
									<span class="review-csv-stats">
										<span class="csv-stat added">+{diff().stats.added} added</span>
										<span class="csv-stat removed">−{diff().stats.removed} removed</span>
										<span class="csv-stat modified">~{diff().stats.modified} modified</span>
										<span class="meta">{diff().stats.same} unchanged</span>
										<Show when={diff().fmChanged}>
											<span class="csv-stat modified">frontmatter changed</span>
										</Show>
									</span>
									<label class="check review-csv-toggle">
										<input type="checkbox" checked={mdOnlyChanged()} onChange={(e) => setMdOnlyChanged(e.currentTarget.checked)} />
										<span>Changed sections only</span>
									</label>
								</div>
								<Show
									when={hasAnyVisible()}
									fallback={<p class="hint" style={{ padding: "var(--space-5)" }}>No Markdown differences between the two versions.</p>}
								>
									<div
										class="review-rendered-split"
										onClick={(e) => {
											if ((e.target as HTMLElement | null)?.closest("a")) e.preventDefault();
										}}
									>
										<div
											class="review-rendered-pane"
											ref={(el) => (leftPaneEl = el)}
											onScroll={() => syncRenderedScroll("left")}
										>
											<Show when={showFm()}>
												<Show
													when={diff().fmBeforeHtml}
													fallback={<div class="md-diff-placeholder" data-block-idx="fm" aria-hidden="true">Frontmatter added</div>}
												>
													<pre class="review-md-fm" data-block-idx="fm" innerHTML={diff().fmBeforeHtml} />
												</Show>
											</Show>
											<For each={visibleRows()}>
												{(row, idx) => (
													<Show
														when={row.kind !== "added"}
														fallback={<div class="md-diff-placeholder" data-block-idx={String(idx())} aria-hidden="true">Added</div>}
													>
														<div class={`md-diff-block md-diff-${row.kind}`} data-block-idx={String(idx())}>
															<div class="md" innerHTML={row.leftHtml} />
														</div>
													</Show>
												)}
											</For>
										</div>
										<div
											class="review-rendered-pane"
											ref={(el) => (rightPaneEl = el)}
											onScroll={() => syncRenderedScroll("right")}
										>
											<Show when={showFm()}>
												<Show
													when={diff().fmAfterHtml}
													fallback={<div class="md-diff-placeholder" data-block-idx="fm" aria-hidden="true">Frontmatter removed</div>}
												>
													<pre class="review-md-fm" data-block-idx="fm" innerHTML={diff().fmAfterHtml} />
												</Show>
											</Show>
											<For each={visibleRows()}>
												{(row, idx) => (
													<Show
														when={row.kind !== "removed"}
														fallback={<div class="md-diff-placeholder" data-block-idx={String(idx())} aria-hidden="true">Removed</div>}
													>
														<div class={`md-diff-block md-diff-${row.kind}`} data-block-idx={String(idx())}>
															<div class="md" innerHTML={row.rightHtml} />
														</div>
													</Show>
												)}
											</For>
										</div>
									</div>
								</Show>
							</div>
						);
					}}
				</Show>
				<Show when={diffLayout() === "table" && csvDiff()}>
					{(diff) => {
						const visibleRows = () => (csvOnlyChanged() ? diff().rows.filter((row) => row.kind !== "same") : diff().rows);
						return (
							<div class="review-csv-wrap">
								<div class="review-csv-bar">
									<span class="review-csv-stats">
										<span class="csv-stat added">+{diff().stats.added} added</span>
										<span class="csv-stat removed">−{diff().stats.removed} removed</span>
										<span class="csv-stat modified">~{diff().stats.modified} modified</span>
										<span class="meta">{diff().stats.same} unchanged</span>
									</span>
									<label class="check review-csv-toggle">
										<input type="checkbox" checked={csvOnlyChanged()} onChange={(e) => setCsvOnlyChanged(e.currentTarget.checked)} />
										<span>Changed rows only</span>
									</label>
								</div>
								<div class="review-csv-scroll">
									<Show
										when={visibleRows().length > 0}
										fallback={<p class="hint" style={{ padding: "var(--space-5)" }}>No row differences between the two tables.</p>}
									>
										<table class="review-csv-table">
											<thead>
												<tr>
													<th class="csv-diff-gutter" aria-label="Change" />
													<For each={diff().headers}>
														{(h) => (
															<th class={{ "csv-cell-changed": h.changed }}>
																<Show when={h.changed} fallback={h.cur || h.old}>
																	<del class="csv-diff-old">{h.old || "(empty)"}</del>
																	<span class="csv-diff-arrow" aria-hidden="true">
																		<Icon name="arrow-right" />
																	</span>
																	<ins class="csv-diff-new">{h.cur || "(empty)"}</ins>
																</Show>
															</th>
														)}
													</For>
												</tr>
											</thead>
											<tbody>
												<For each={visibleRows().slice(0, 500)}>
													{(row) => (
														<tr class={`csv-row-${row.kind}`}>
															<td class="csv-diff-gutter">
																{row.kind === "added" ? "+" : row.kind === "removed" ? "-" : row.kind === "modified" ? "~" : ""}
															</td>
															<For each={diff().headers}>
																{(_, colIdx) => {
																	const oldVal = () => row.oldCells?.[colIdx()] ?? "";
																	const newVal = () => row.newCells?.[colIdx()] ?? "";
																	const cellChanged = () => row.kind === "modified" && oldVal() !== newVal();
																	return (
																		<td class={{ "csv-cell-changed": cellChanged() }}>
																			<Show
																				when={cellChanged()}
																				fallback={row.kind === "removed" ? oldVal() : newVal()}
																			>
																				<del class="csv-diff-old">{oldVal() || "(empty)"}</del>
																				<span class="csv-diff-arrow" aria-hidden="true">
																					<Icon name="arrow-right" />
																				</span>
																				<ins class="csv-diff-new">{newVal() || "(empty)"}</ins>
																			</Show>
																		</td>
																	);
																}}
															</For>
														</tr>
													)}
												</For>
											</tbody>
										</table>
									</Show>
									<Show when={visibleRows().length > 500}>
										<p class="hint" style={{ padding: "var(--space-4)" }}>Showing first 500 of {visibleRows().length} rows.</p>
									</Show>
								</div>
							</div>
						);
					}}
				</Show>
			</div>
		</CenterTabStrip>
	);
}
