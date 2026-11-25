import { describe, expect, test } from "bun:test";
import { createEffect, createMemo, createRoot, createSignal, createStore, flush, snapshot } from "solid-js";
import { createAsyncQuery } from "../src/view/asyncQuery";

describe("SolidJS 2.0 runtime & createAsyncQuery", () => {
	test("bun test resolves real reactive Solid 2 browser build with flush() and draft stores", () => {
		createRoot((dispose) => {
			const [n, setN] = createSignal(2);
			const doubled = createMemo(() => n() * 2);
			const seen: number[] = [];
			createEffect(
				() => doubled(),
				(v) => {
					seen.push(v);
				},
			);
			flush();
			expect(seen).toEqual([4]);

			setN(5);
			expect(n()).toBe(2); // deferred until flush
			flush();
			expect(n()).toBe(5);
			expect(doubled()).toBe(10);
			expect(seen).toEqual([4, 10]);

			const [store, setStore] = createStore<{ dirty: Record<string, boolean> }>({ dirty: { "a.ssl": true } });
			const aDirty = createMemo(() => Boolean(store.dirty["a.ssl"]));
			const bDirty = createMemo(() => Boolean(store.dirty["b.ssl"]));
			expect(aDirty()).toBe(true);
			expect(bDirty()).toBe(false);

			setStore((s) => {
				s.dirty = { "b.ssl": true };
			});
			expect(Object.keys(snapshot(store).dirty)).toEqual(["b.ssl"]);
			flush();
			expect(aDirty()).toBe(false);
			expect(bDirty()).toBe(true);
			dispose();
		});
	});

	test("createAsyncQuery fetches, cancels stale runs, supports refetch, and clears on falsy key", async () => {
		await createRoot(async (dispose) => {
			const [key, setKey] = createSignal<string | false>("a");
			const calls: string[] = [];
			const resolvers = new Map<string, (v: string) => void>();

			const [data, { refetch }] = createAsyncQuery(key, (k) => {
				calls.push(k);
				return new Promise<string>((r) => resolvers.set(`${k}:${calls.length}`, r));
			});
			flush();
			expect(data.loading).toBe(true);
			await Promise.resolve();
			expect(calls).toEqual(["a"]);

			// Supersede "a" with "b" before "a" resolves — stale "a" result must be dropped.
			setKey("b");
			flush();
			await Promise.resolve();
			expect(calls).toEqual(["a", "b"]);
			resolvers.get("a:1")?.("stale-a");
			await Promise.resolve();
			await Promise.resolve();
			expect(data()).toBeUndefined();
			expect(data.loading).toBe(true);

			resolvers.get("b:2")?.("fresh-b");
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(data()).toBe("fresh-b");
			expect(data.latest).toBe("fresh-b");
			expect(data.loading).toBe(false);

			// Refetch re-runs same key
			refetch();
			flush();
			await Promise.resolve();
			expect(calls).toEqual(["a", "b", "b"]);
			resolvers.get("b:3")?.("refetched-b");
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(data()).toBe("refetched-b");

			// Falsy key clears value and loading
			setKey(false);
			flush();
			expect(data()).toBeUndefined();
			expect(data.loading).toBe(false);
			dispose();
		});
	});
});
