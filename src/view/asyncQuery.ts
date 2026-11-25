// Solid 2.0 async query primitive built on createSignal + two-phase createEffect.
// Provides explicit loading/error/latest state and automatic stale-run cancellation
// for panel/editor queries without requiring surrounding <Loading>/<Errored> boundaries.
import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";

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

	if (maybeFetcher) {
		const src = createMemo(() => (sourceOrFetcher as Accessor<S | false | null | undefined>)());
		createEffect(
			() => [src(), bump()] as const,
			([key]) => {
				const runId = ++seq;
				if (key === false || key === null || key === undefined) {
					setLoading(false);
					setError(undefined);
					setValue(undefined);
					setLatest(undefined);
					return;
				}
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
			() => {
				const runId = ++seq;
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
		loading: { get: () => loading() },
		error: { get: () => error() },
		latest: { get: () => latest() },
	});
	return [
		read,
		{
			refetch: () => setBump((n) => n + 1),
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
