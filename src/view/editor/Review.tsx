// Review of a proposed text against the current one: local-history restores
// and every agent step go through here. Nothing changes until Accept, and
// Accept is an undoable edit, not a save (ADR 0002). The review stays open
// until the accept has worked, so a failed write loses nothing.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { parseCsv } from "../../shared/csv";
import { DEFAULT_CODE_FONT, resolveFontStack } from "../../shared/fonts";
import { frontMatter } from "../../shared/frontMatter";
import { Icon } from "../Icon";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { choose } from "../dialogs";
import { canonical, keepTab, state, notify } from "../state";
import { baseName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { recall, remember } from "../graph/canvas";
import { CenterTabStrip } from "./CenterTabStrip";
import { finishMarkdown } from "./markdownHtml";
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
	/** What accepting will do, as a sentence for the header: "Accepting puts the right side into the editor. The file is not saved." */
	effect?: string;
	/** Why this cannot be accepted as it stands: a check it must pass has failed. */
	blocked?: string;
	/**
	 * Two texts to look at side by side, with nothing to accept: a file against what git has of it. The names of the
	 * two sides. Neither side can be edited, and the one button closes.
	 */
	compare?: { left: string; right: string };
	/** May fail: the review then stays open and shows the error. */
	onAccept: (text: string) => void | Promise<void>;
	onReject?: () => void | Promise<void>;
};

const [review, setReview] = createSignal<Review | null>(null);
export { review };

const flow = reviewFlow<Review>({
	current: () => untrack(review),
	show: setReview,
	// Looked up when asked, not when this module loads: state.ts and this file import each other.
	choose: (title, buttons) => choose(title, buttons),
	fail: (text) => notify(text, "error"),
});

/**
 * Opens a review. When another one is open the user is asked first: replacing
 * rejects the open one (its `onReject` runs). Resolves false when the user kept
 * the open one, so this one was not shown.
 */
export const openReview = (r: Review): Promise<boolean> => {
	// A comparison holds nothing that could be lost: the next thing to look at takes its place without a question.
	if (untrack(review)?.compare) setReview(null);
	// What is accepted here is written into the file's document: a tab it has for a look is kept, so that the next
	// file clicked does not take the document away under the review. A comparison writes nothing, and keeps nothing.
	if (!r.compare && r.path && state.workspace) keepTab(canonical(isInside(state.workspace.root, r.path) ? r.path : joinPath(state.workspace.root, ...r.path.split(/[\\/]/))));
	return flow.open(r);
};
export const closeReview = () => setReview(null);
/** A comparison gives way to a file that is opened: it holds nothing to lose, and would otherwise stand in front of the file. */
export const closeComparison = () => void (untrack(review)?.compare && setReview(null));

type CsvDiffRow = {
	kind: "same" | "added" | "removed" | "modified";
	oldCells?: string[];
	newCells?: string[];
};

/** Renders Markdown safely for side-by-side Rendered Review panes (stripping frontmatter into a dedicated summary block). */
function renderReviewMarkdown(text: string): { fm: string; html: string } {
	const parsed = frontMatter(text);
	const fmRaw = parsed.lines > 0 ? text.split(/\r?\n/).slice(0, parsed.lines).join("\n").trim() : "";
	const rawHtml = marked.parse(parsed.body, { async: false, gfm: true }) as string;
	const clean = DOMPurify.sanitize(rawHtml, {
		FORBID_TAGS: ["iframe", "object", "embed", "script", "style", "form", "input", "textarea", "select"],
	});
	return { fm: fmRaw, html: finishMarkdown(clean, { anchors: true }) };
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
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal("");
	/** The lines the proposal adds and takes away, once the diff has been worked out. */
	const [size, setSize] = createSignal("");
	/** Live proposed text synced from Monaco so Rendered / Table views reflect in-review edits. */
	const [liveProposed, setLiveProposed] = createSignal(r.proposed);
	/** Explicit diff layout (ADR 0027): never silently flips behind the column headers. */
	const [diffLayout, setDiffLayout] = createSignal<"split" | "inline" | "rendered" | "table">(recall("review.layout") === "inline" ? "inline" : "split");
	const [csvOnlyChanged, setCsvOnlyChanged] = createSignal(false);
	const chooseLayout = (next: "split" | "inline" | "rendered" | "table") => {
		setDiffLayout(next);
		if (next === "split" || next === "inline") remember("review.layout", next);
	};
	const isCodeDiff = () => diffLayout() === "split" || diffLayout() === "inline";
	const renderedOrig = createMemo(() => (isMdReview && diffLayout() === "rendered" ? renderReviewMarkdown(r.original) : null));
	const renderedProp = createMemo(() => (isMdReview && diffLayout() === "rendered" ? renderReviewMarkdown(liveProposed()) : null));
	const csvDiff = createMemo(() => (isCsvReview && diffLayout() === "table" ? diffCsvTables(r.original, liveProposed()) : null));
	const label = r.acceptLabel ?? "Accept";
	const file = r.path ? relativeTo(state.workspace?.root, r.path) : "";
	const tabTitle = r.path ? (r.compare ? `${baseName(r.path)} (diff)` : `Review: ${baseName(r.path)}`) : r.title;
	const effect = r.effect ?? `"${label}" applies the right side.`;

	onMount(() => {
		const original = monaco.editor.createModel(r.original, r.language);
		const proposed = (proposedModel = monaco.editor.createModel(r.proposed, r.language));
		const diff = (editor = monaco.editor.createDiffEditor(host, {
			automaticLayout: true,
			renderSideBySide: diffLayout() !== "inline",
			useInlineViewWhenSpaceIsLimited: false,
			originalEditable: false,
			readOnly: Boolean(r.compare),
			fontSize: state.settings.fontSize,
			selectionClipboard: false,
		}));
		diff.setModel({ original, modified: proposed });
		// Ctrl+F12 goes to the definition here as it does in the editor: each side is told it is in a web view,
		// which is where the editor keeps that key (see EditorGroup.tsx).
		for (const side of [diff.getOriginalEditor(), diff.getModifiedEditor()]) side.createContextKey("isWeb", true);
		// How large the change is, kept up to date as the right side is edited.
		const sized = diff.onDidUpdateDiff(() => setSize(changeSize(diff.getLineChanges())));
		const synced = proposed.onDidChangeContent(() => setLiveProposed(proposed.getValue()));
		onCleanup(() => {
			sized.dispose();
			synced.dispose();
		});
		untouched = proposed.getAlternativeVersionId();
		// Escape needs the keyboard in here. Typing somewhere else (the agent's composer) is left alone.
		const focused = document.activeElement;
		if (!focused || focused === document.body || root.contains(focused)) diff.getModifiedEditor().focus();
		onCleanup(() => {
			editor = undefined;
			diff.dispose();
			original.dispose();
			proposed.dispose();
		});
	});
	// Both sides follow the Font size, Code font, and explicit Side-by-Side / Inline layout choice.
	createEffect(() => {
		const fontSize = state.settings.fontSize;
		const fontFamily = state.settings.codeFont?.trim() ? resolveFontStack(state.settings.codeFont, DEFAULT_CODE_FONT) : undefined;
		const sideBySide = diffLayout() !== "inline";
		editor?.updateOptions({
			fontSize,
			renderSideBySide: sideBySide,
			useInlineViewWhenSpaceIsLimited: false,
			...(fontFamily ? { fontFamily } : {}),
		});
		if (isCodeDiff()) queueMicrotask(() => editor?.layout());
	});

	// Undoing every edit counts as not edited: the version id goes back with the text.
	const edited = () => Boolean(proposedModel && !proposedModel.isDisposed() && proposedModel.getAlternativeVersionId() !== untouched);
	const accept = async () => {
		if (busy() || r.blocked || !proposedModel) return;
		setBusy(true);
		setError("");
		const failed = await flow.accept(r, proposedModel.getValue());
		setBusy(false);
		if (failed !== null) setError(failed);
	};
	const reject = () => {
		if (!busy()) void flow.reject(r, edited());
	};
	// Monaco takes Escape first when it has a use for it (a find box, a selection) and stops it there.
	const onKey = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || e.defaultPrevented) return;
		e.preventDefault();
		reject();
	};

	return (
		<CenterTabStrip title={tabTitle} tooltip={r.path ?? r.title} icon="split-horizontal" onClose={reject}>
			<div class="diff" ref={root} onKeyDown={onKey}>
				<div class="diff-bar review-bar">
					<div class="review-head">
						<div class="review-what">
							<strong>{r.title}</strong>
							<Show when={file}>
								<span class="review-path" title={r.path}>
									{file}
								</span>
							</Show>
						</div>
						<p class="review-effect">
							{r.compare
								? (r.effect ?? (diffLayout() === "split" ? "The two are shown side by side. Nothing here changes either." : "Shown inline. Nothing here changes either."))
								: `${effect} Reject (Esc) changes nothing.`}
						</p>
					</div>
					<div class="review-actions">
						<div class="mode-switch diff-layout-switch" role="group" aria-label="Diff layout">
							<button classList={{ on: diffLayout() === "split" }} aria-pressed={diffLayout() === "split"} title="Show original and proposed side by side" onClick={() => chooseLayout("split")}>
								Side-by-Side
							</button>
							<button classList={{ on: diffLayout() === "inline" }} aria-pressed={diffLayout() === "inline"} title="Show changes inline in one column" onClick={() => chooseLayout("inline")}>
								Inline
							</button>
							<Show when={isMdReview}>
								<button
									classList={{ on: diffLayout() === "rendered" }}
									aria-pressed={diffLayout() === "rendered"}
									title="Show rendered Markdown side by side"
									onClick={() => chooseLayout("rendered")}
								>
									Rendered
								</button>
							</Show>
							<Show when={isCsvReview}>
								<button
									classList={{ on: diffLayout() === "table" }}
									aria-pressed={diffLayout() === "table"}
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
								<button class="primary" title="Close this comparison (Esc)" onClick={reject}>
									Close
								</button>
							}
						>
							<button class="primary" disabled={Boolean(r.blocked) || busy()} title={r.blocked ?? (busy() ? "Accepting…" : effect)} onClick={() => void accept()}>
								{label}
							</button>
							<button disabled={busy()} title={busy() ? "Wait for the accept to finish." : "Reject: close this review and change nothing (Esc)"} onClick={reject}>
								Reject
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
						<span>{r.compare?.left ?? "Now"}</span>
						<span>
							{r.compare?.right ?? "Proposed"}{" "}
							<Show when={!r.compare && diffLayout() === "split"}>
								<span class="hint">you can edit this side</span>
							</Show>
							<span class="diff-size">{size()}</span>
						</span>
					</div>
				</Show>
				<Show when={diffLayout() === "inline"}>
					<div class="diff-sides inline" aria-hidden="true">
						<span class="diff-inline-label">
							{r.compare?.left ?? "Now"}
							<Icon name="arrow-right" class="diff-inline-sep" />
							{r.compare?.right ?? "Proposed"}
							<Show when={!r.compare}>
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
				<Show when={diffLayout() === "rendered" && renderedOrig() && renderedProp()}>
					<div class="review-rendered-split" onClick={(e) => {
						if ((e.target as HTMLElement | null)?.closest("a")) e.preventDefault();
					}}>
						<div class="review-rendered-pane">
							<Show when={renderedOrig()!.fm}>
								<pre class="review-md-fm">{renderedOrig()!.fm}</pre>
							</Show>
							<div class="md" innerHTML={renderedOrig()!.html} />
						</div>
						<div class="review-rendered-pane">
							<Show when={renderedProp()!.fm}>
								<pre class="review-md-fm">{renderedProp()!.fm}</pre>
							</Show>
							<div class="md" innerHTML={renderedProp()!.html} />
						</div>
					</div>
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
															<th classList={{ "csv-cell-changed": h.changed }}>
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
																		<td classList={{ "csv-cell-changed": cellChanged() }}>
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
