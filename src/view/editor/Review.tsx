// Review of a proposed text against the current one: local-history restores
// and every agent step go through here. Nothing changes until Accept, and
// Accept is an undoable edit, not a save (ADR 0002). The review stays open
// until the accept has worked, so a failed write loses nothing.
import { Icon } from "../Icon";
import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { choose } from "../dialogs";
import { canonical, keepTab, state, notify } from "../state";
import { isInside, joinPath, relativeTo } from "../../shared/paths";
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

export function ReviewView() {
	let root!: HTMLDivElement;
	let host!: HTMLDivElement;
	let editor: monaco.editor.IStandaloneDiffEditor | undefined;
	let proposedModel: monaco.editor.ITextModel | undefined;
	let untouched = 0;
	const r = untrack(review)!;
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal("");
	/** The lines the proposal adds and takes away, once the diff has been worked out. */
	const [size, setSize] = createSignal("");
	const label = r.acceptLabel ?? "Accept";
	const file = r.path ? relativeTo(state.workspace?.root, r.path) : "";
	const effect = r.effect ?? `"${label}" applies the right side.`;

	onMount(() => {
		const original = monaco.editor.createModel(r.original, r.language);
		const proposed = (proposedModel = monaco.editor.createModel(r.proposed, r.language));
		const diff = (editor = monaco.editor.createDiffEditor(host, { automaticLayout: true, renderSideBySide: true, originalEditable: false, readOnly: Boolean(r.compare), fontSize: state.settings.fontSize }));
		diff.setModel({ original, modified: proposed });
		// Ctrl+F12 goes to the definition here as it does in the editor: each side is told it is in a web view,
		// which is where the editor keeps that key (see EditorGroup.tsx).
		for (const side of [diff.getOriginalEditor(), diff.getModifiedEditor()]) side.createContextKey("isWeb", true);
		// How large the change is, kept up to date as the right side is edited.
		const sized = diff.onDidUpdateDiff(() => setSize(changeSize(diff.getLineChanges())));
		onCleanup(() => sized.dispose());
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
	// Both sides follow the Font size setting, as the editors do.
	createEffect(() => {
		const fontSize = state.settings.fontSize;
		editor?.updateOptions({ fontSize });
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
					<p class="review-effect">{r.compare ? (r.effect ?? "The two are shown side by side. Nothing here changes either.") : `${effect} Reject (Esc) changes nothing.`}</p>
				</div>
				<div class="review-actions">
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
			{/* What each side is, over it: the two halves are the diff's own. */}
			<div class="diff-sides" aria-hidden="true">
				<span>{r.compare?.left ?? "Now"}</span>
				<span>
					{r.compare?.right ?? "Proposed"} <Show when={!r.compare}><span class="hint">you can edit this side</span></Show>
					<span class="diff-size">{size()}</span>
				</span>
			</div>
			<p class="visually-hidden" role="status">
				{size()}
			</p>
			<div class="diff-host" ref={host} />
		</div>
	);
}
