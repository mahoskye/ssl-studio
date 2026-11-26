// Solid 2.0 async query primitive built on createSignal + two-phase createEffect.
// Provides explicit loading/error/latest state and automatic stale-run cancellation
// for panel/editor queries without requiring surrounding <Loading>/<Errored> boundaries.
import { createEffect, createMemo, createSignal, untrack, type Accessor } from "solid-js";

export type AsyncQuery<T> = Accessor<T | undefined> & {
	readonly loading: boolean;
	readonly error: unknown;
	readonly latest: T | undefined;
};

export type AsyncQueryActions<T> = {
	refetch: () => void;
	mutate: (v: T | undefined) => void;
};

export function createAsyncQuery<T>(fetcher: () => Promise<T> | T): [AsyncQuery<T>, AsyncQueryActions<T>];
export function createAsyncQuery<S, T>(
	source: Accessor<S | false | null | undefined>,
	fetcher: (source: S) => Promise<T> | T,
): [AsyncQuery<T>, AsyncQueryActions<T>];
export function createAsyncQuery<S, T>(
	sourceOrFetcher: (() => Promise<T> | T) | Accessor<S | false | null | undefined>,
	maybeFetcher?: (source: S) => Promise<T> | T,
): [AsyncQuery<T>, AsyncQueryActions<T>] {
	const [value, setValue] = createSignal<T | undefined>(undefined);
	const [latest, setLatest] = createSignal<T | undefined>(undefined);
	// Without a gating source the query always starts fetching on mount.
	// With a source, avoid reading `source()` untracked here (STRICT_READ_UNTRACKED);
	// the effect sets `loading(true)` on the first flush when the source is truthy.
	const [loading, setLoading] = createSignal(!maybeFetcher);
	const [error, setError] = createSignal<unknown>(undefined);
	const [bump, setBump] = createSignal(0);
	let seq = 0;

	const src = maybeFetcher ? createMemo(() => (sourceOrFetcher as Accessor<S | false | null | undefined>)()) : null;

	/** What the effect below last began a run for: the source's value, and the count of refetches. */
	const [begun, setBegun] = createSignal<readonly [unknown, number] | undefined>(undefined);
	/**
	 * Whether what is asked for now has not been begun yet. The effect sets `loading` when it runs, and that is after
	 * everything that reads `loading` in the same update has read it: for that moment the query said it was not
	 * loading while it held the answer to the question before, or none. A reader that acts once on "not loading"
	 * acted then: the quick pick took an Enter that was waiting for the symbols as answered by an empty list, and
	 * dropped it. Said from the source itself, `loading` is true from the update in which the question changes.
	 */
	const awaited = createMemo(() => {
		const key = src ? src() : true;
		const count = bump();
		if (key === false || key === null || key === undefined) return false;
		const last = begun();
		return !last || last[0] !== key || last[1] !== count;
	});

	if (maybeFetcher && src) {
		createEffect(
			() => [src(), bump()] as const,
			([key, count]) => {
				const runId = ++seq;
				if (key === false || key === null || key === undefined) {
					setLoading(false);
					setError(undefined);
					setValue(undefined);
					setLatest(undefined);
					return;
				}
				setBegun([key, count] as const);
				setLoading(true);
				setError(undefined);
				let cancelled = false;
				let task: Promise<T>;
				try {
					task = Promise.resolve(maybeFetcher(key));
				} catch (err) {
					if (runId !== seq) return;
					setValue(undefined);
					setError(() => err);
					setLoading(false);
					return;
				}
				task.then(
					(res) => {
						if (cancelled || runId !== seq) return;
						setValue(() => res);
						setLatest(() => res);
						setLoading(false);
					},
					(err) => {
						if (cancelled || runId !== seq) return;
						setValue(undefined);
						setError(() => err);
						setLoading(false);
					},
				);
				return () => {
					cancelled = true;
				};
			},
		);
	} else {
		const fetcher = sourceOrFetcher as () => Promise<T> | T;
		createEffect(
			() => bump(),
			(count) => {
				const runId = ++seq;
				setBegun([true, count] as const);
				setLoading(true);
				setError(undefined);
				let cancelled = false;
				let task: Promise<T>;
				try {
					task = Promise.resolve(fetcher());
				} catch (err) {
					if (runId !== seq) return;
					setValue(undefined);
					setError(() => err);
					setLoading(false);
					return;
				}
				task.then(
					(res) => {
						if (cancelled || runId !== seq) return;
						setValue(() => res);
						setLatest(() => res);
						setLoading(false);
					},
					(err) => {
						if (cancelled || runId !== seq) return;
						setValue(undefined);
						setError(() => err);
						setLoading(false);
					},
				);
				return () => {
					cancelled = true;
				};
			},
		);
	}

	const read = (() => value()) as AsyncQuery<T>;
	Object.defineProperties(read, {
		loading: { get: () => loading() || awaited() },
		error: { get: () => error() },
		latest: { get: () => latest() },
	});
	return [
		read,
		{
			refetch: () => {
				if (src) {
					const k = untrack(src);
					if (k === false || k === null || k === undefined) return;
				}
				setBump((n) => n + 1);
			},
			mutate: (v) => {
				++seq;
				setLoading(false);
				setError(undefined);
				setValue(() => v);
				setLatest(() => v);
			},
		},
	];
}
