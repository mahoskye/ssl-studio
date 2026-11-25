import { createEffect, createMemo, createSignal, untrack } from "solid-js";

/**
 * A field's draft: what is being typed, which follows `source` when the source's value changes and only then.
 *
 * The effect reads the source through a memo. An effect applies again whenever its compute re-runs, whether or
 * not the value it computed is the same, so a source that was merely worked out again (a plan re-parsed after an
 * unrelated edit hands every row a new object holding the same text) put the saved text back over the typing.
 * The memo stops there what did not change.
 *
 * Returns the draft, its setter, and the source as the memo reads it (for a snap-back after a commit).
 */
export function createDraft(source: () => string) {
	const committed = createMemo(source);
	const [draft, setDraft] = createSignal(untrack(committed));
	createEffect(committed, (v) => {
		setDraft(v);
	});
	return [draft, setDraft, committed] as const;
}
