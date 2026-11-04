// Review of a proposed text against the current one: local-history restores
// and every agent step go through here. Nothing changes until Accept, and
// Accept is an undoable edit, not a save (ADR 0002).
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { monaco } from "./monaco";

export type Check = { label: string; ok: boolean | null; detail?: string };
export type Review = {
	title: string;
	original: string;
	proposed: string;
	language: string;
	checks?: Check[];
	/** Shown above the diff: the agent's note for this step. */
	note?: string;
	acceptLabel?: string;
	/** Why this cannot be accepted as it stands: a check it must pass has failed. */
	blocked?: string;
	onAccept: (text: string) => void | Promise<void>;
	onReject?: () => void;
};

const [review, setReview] = createSignal<Review | null>(null);
export { review };
export const openReview = (r: Review) => setReview(r);
export const closeReview = () => setReview(null);

export function ReviewView() {
	let host!: HTMLDivElement;
	let proposedModel: monaco.editor.ITextModel;
	const r = review()!;
	onMount(() => {
		const original = monaco.editor.createModel(r.original, r.language);
		proposedModel = monaco.editor.createModel(r.proposed, r.language);
		const editor = monaco.editor.createDiffEditor(host, { automaticLayout: true, renderSideBySide: true, originalEditable: false, readOnly: false });
		editor.setModel({ original, modified: proposedModel });
		onCleanup(() => {
			editor.dispose();
			original.dispose();
			proposedModel.dispose();
		});
	});
	const accept = async () => {
		const text = proposedModel.getValue();
		setReview(null);
		await r.onAccept(text);
	};
	const reject = () => {
		setReview(null);
		r.onReject?.();
	};
	return (
		<div class="diff">
			<div class="diff-bar">
				<strong>{r.title}</strong>
				<span class="hint">current ← → proposed (you can edit the right side)</span>
				<span class="spacer" />
				<button class="primary" disabled={Boolean(r.blocked)} title={r.blocked} onClick={() => void accept()}>
					{r.acceptLabel ?? "Accept"}
				</button>
				<button onClick={reject}>Reject</button>
			</div>
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
										{c.ok === null ? "?" : c.ok ? "✓" : "✗"} {c.label}
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
			<div class="diff-host" ref={host} />
		</div>
	);
}
