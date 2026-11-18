// How a review opens, is accepted and is rejected. Kept free of the DOM and
// Monaco so it can be tested (test/agentPanel.test.ts); Review.tsx supplies
// the signal that holds the review, the dialog and the toast.

export type Reviewable = {
	title: string;
	onAccept: (text: string) => void | Promise<void>;
	onReject?: () => void | Promise<void>;
};

export type ReviewIO<R> = {
	current: () => R | null;
	show: (review: R | null) => void;
	choose: (title: string, buttons: string[]) => Promise<string | null>;
	/** A failure the user has to see. */
	fail: (text: string) => void;
};

export const KEEP = "Keep reviewing";
export const REPLACE = "Replace";
export const LOSE_EDITS = "Reject and lose my edits";

const errorText = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? e);

export function reviewFlow<R extends Reviewable>(io: ReviewIO<R>) {
	/** The review whose accept is running. */
	let accepting: R | null = null;
	/** Opens wait their turn: the dialog can hold one question at a time. */
	let queue: Promise<unknown> = Promise.resolve();

	/** Tells a review's owner it was dropped. A failure in there is shown, not thrown at whoever dropped it. */
	const drop = (review: R) => {
		const failed = (e: unknown) => io.fail(`"${review.title}" was rejected, but its clean-up failed: ${errorText(e)}`);
		try {
			const result = review.onReject?.();
			if (result instanceof Promise) result.catch(failed);
		} catch (e) {
			failed(e);
		}
	};

	async function open(next: R): Promise<boolean> {
		const current = io.current();
		// A review that is being accepted is done with: what its accept opens follows it without a question.
		if (current && current !== next && current !== accepting) {
			const answer = await io.choose(`"${current.title}" is still open for review. Replace it with "${next.title}"? Replacing rejects the one that is open.`, [KEEP, REPLACE]);
			if (answer !== REPLACE) return false;
			// It may have been accepted or rejected while the question was up.
			if (io.current() === current) drop(current);
		}
		io.show(next);
		return true;
	}

	return {
		/** Shows a review. False: another review is open and the user kept it, so this one was not shown. */
		open(next: R): Promise<boolean> {
			const result = queue.then(() => open(next));
			queue = result.catch(() => {});
			return result;
		},

		/**
		 * Accepts: the review closes only once `onAccept` has finished. When it
		 * fails the review stays open with the text in it, and the error comes
		 * back to be shown; null means it was accepted.
		 */
		async accept(review: R, text: string): Promise<string | null> {
			if (accepting) return accepting === review ? "It is being accepted." : `"${accepting.title}" is still being accepted.`;
			accepting = review;
			try {
				await review.onAccept(text);
			} catch (e) {
				const message = errorText(e);
				io.fail(`"${review.title}" was not accepted: ${message}${io.current() === review ? ". The review is still open, with the text as you left it." : ""}`);
				return message;
			} finally {
				accepting = null;
			}
			if (io.current() === review) io.show(null);
			return null;
		},

		/** Rejects, after asking when the proposed side was edited. False: the user kept reviewing. */
		async reject(review: R, edited: boolean): Promise<boolean> {
			if (accepting === review) return false;
			if (edited) {
				const answer = await io.choose(`You edited the proposed text of "${review.title}". Rejecting loses those edits.`, [KEEP, LOSE_EDITS]);
				if (answer !== LOSE_EDITS) return false;
			}
			if (io.current() !== review) return false;
			io.show(null);
			drop(review);
			return true;
		},
	};
}
