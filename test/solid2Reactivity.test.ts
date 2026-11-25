import { describe, expect, test } from "bun:test";
import { createEffect, createMemo, createRoot, createSignal, createStore, flush, snapshot } from "solid-js";
import { createAsyncQuery } from "../src/view/asyncQuery";

describe("SolidJS 2.0 runtime & createAsyncQuery", () => {
	test("bun test resolves real reactive Solid 2 browser build with flush() and draft stores", () => {
		const seen: number[] = [];
		const ctx = createRoot((dispose) => {
			const [n, setN] = createSignal(2);
			const doubled = createMemo(() => n() * 2);
			createEffect(
				() => doubled(),
				(v) => {
					seen.push(v);
				},
			);
			const [store, setStore] = createStore<{ dirty: Record<string, boolean> }>({ dirty: { "a.ssl": true } });
			const aDirty = createMemo(() => Boolean(store.dirty["a.ssl"]));
			const bDirty = createMemo(() => Boolean(store.dirty["b.ssl"]));
			return { n, setN, doubled, store, setStore, aDirty, bDirty, dispose };
		});
		try {
			flush();
			expect(seen).toEqual([4]);

			ctx.setN(5);
			expect(ctx.n()).toBe(2); // deferred until flush
			flush();
			expect(ctx.n()).toBe(5);
			expect(ctx.doubled()).toBe(10);
			expect(seen).toEqual([4, 10]);

			expect(ctx.aDirty()).toBe(true);
			expect(ctx.bDirty()).toBe(false);

			ctx.setStore((s) => {
				s.dirty = { "b.ssl": true };
			});
			expect(Object.keys(snapshot(ctx.store).dirty)).toEqual(["b.ssl"]);
			flush();
			expect(ctx.aDirty()).toBe(false);
			expect(ctx.bDirty()).toBe(true);
		} finally {
			ctx.dispose();
		}
	});

	test("createAsyncQuery fetches, cancels stale runs, supports refetch, and clears on falsy key", async () => {
		const calls: string[] = [];
		const resolvers = new Map<string, (v: string) => void>();
		const ctx = createRoot((dispose) => {
			const [key, setKey] = createSignal<string | false>("a");
			const [data, { refetch }] = createAsyncQuery(key, (k) => {
				calls.push(k);
				return new Promise<string>((r) => resolvers.set(`${k}:${calls.length}`, r));
			});
			return { setKey, data, refetch, dispose };
		});
		try {
			flush();
			expect(ctx.data.loading).toBe(true);
			await Promise.resolve();
			expect(calls).toEqual(["a"]);

			// Supersede "a" with "b" before "a" resolves — stale "a" result must be dropped.
			ctx.setKey("b");
			flush();
			await Promise.resolve();
			expect(calls).toEqual(["a", "b"]);
			resolvers.get("a:1")?.("stale-a");
			await Promise.resolve();
			await Promise.resolve();
			expect(ctx.data()).toBeUndefined();
			expect(ctx.data.loading).toBe(true);

			resolvers.get("b:2")?.("fresh-b");
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(ctx.data()).toBe("fresh-b");
			expect(ctx.data.latest).toBe("fresh-b");
			expect(ctx.data.loading).toBe(false);

			// Refetch re-runs same key
			ctx.refetch();
			flush();
			await Promise.resolve();
			expect(calls).toEqual(["a", "b", "b"]);
			resolvers.get("b:3")?.("refetched-b");
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(ctx.data()).toBe("refetched-b");

			// Falsy key clears value and loading
			ctx.setKey(false);
			flush();
			expect(ctx.data()).toBeUndefined();
			expect(ctx.data.latest).toBeUndefined();
			expect(ctx.data.loading).toBe(false);
		} finally {
			ctx.dispose();
		}
	});
});
