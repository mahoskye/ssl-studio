// The rest of the suite runs Solid's development build (test/setupSolid.ts puts it in place of the server stub),
// which is stricter than the one a release ships: it throws where production goes on. These tests run the
// reactive core the release ships, by its path, and hold it to the timing the view's code is written against.
// When a Solid upgrade changes one of these, the code that leans on it is named beside the test.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Taken from the modules the production entry point is made of, not from the entry point itself: the preload has
// put the development build in place of that one file (it is what "@solidjs/signals" resolves to), while the
// modules behind it are untouched and are the code a release runs.
const prod = (file: string) => import(pathToFileURL(resolve(import.meta.dir, "../node_modules/@solidjs/signals/dist/prod", file)).href);
await prod("core/effect.js");
const { createEffect, createMemo, createSignal } = (await prod("signals.js")) as typeof import("@solidjs/signals");
const { createRoot } = (await prod("core/owner.js")) as typeof import("@solidjs/signals");
const { flush } = (await prod("core/scheduler.js")) as typeof import("@solidjs/signals");
const { createStore, snapshot } = (await prod("store/index.js")) as typeof import("@solidjs/signals");

/** Runs `body` under an owner and disposes it afterwards. */
function scoped<T>(body: () => T): T {
	let dispose!: () => void;
	try {
		return createRoot((d) => {
			dispose = d;
			return body();
		});
	} finally {
		dispose();
	}
}

describe("the Solid build a release ships", () => {
	test("is the production one, not the development build the other tests use", async () => {
		const pkg = await Bun.file(resolve(import.meta.dir, "../node_modules/@solidjs/signals/package.json")).json();
		expect(pkg.exports["."].default).toBe("./dist/prod/index.js");
		const dev = await import("@solidjs/signals");
		expect(createSignal).not.toBe(dev.createSignal);
		expect(createStore).not.toBe(dev.createStore);
	});

	test("a signal read after a write gives the old value until the next flush", () => {
		// state.ts and the editors read `snapshot(state)` in handlers for this reason.
		scoped(() => {
			const [n, setN] = createSignal(1);
			setN(2);
			expect(n()).toBe(1);
			flush();
			expect(n()).toBe(2);
		});
	});

	test("a store read after a write gives the old value, while its snapshot has the new one", () => {
		// closeTab, save and the unsaved-changes question read the snapshot: they see a `dirty` flag set a moment ago.
		scoped(() => {
			const [store, setStore] = createStore({ dirty: {} as Record<string, boolean>, active: 0 });
			setStore((s) => {
				s.dirty["/ws/a.csv"] = true;
				s.active = 1;
			});
			expect(store.active).toBe(0);
			expect(store.dirty["/ws/a.csv"]).toBeUndefined();
			expect(snapshot(store).active).toBe(1);
			expect(snapshot(store).dirty["/ws/a.csv"]).toBe(true);
			flush();
			expect(store.active).toBe(1);
		});
	});

	test("a setter given a function works on the value still waiting to be flushed", () => {
		// Two store writes in one handler build on each other (state.ts: nextTab twice, shiftTab twice).
		scoped(() => {
			const [n, setN] = createSignal(1);
			setN((v) => v + 1);
			setN((v) => v + 1);
			flush();
			expect(n()).toBe(3);
			const [store, setStore] = createStore({ tabs: ["a"] });
			setStore((s) => void s.tabs.push("b"));
			setStore((s) => void s.tabs.push(`c after ${s.tabs.length}`));
			flush();
			expect(snapshot(store).tabs).toEqual(["a", "b", "c after 2"]);
		});
	});

	test("an effect applies again whenever its compute runs again, equal value or not; a memo in between stops that", () => {
		// src/view/draft.ts (createDraft) reads its source through a memo for this reason.
		scoped(() => {
			const [row, setRow] = createSignal({ text: "saved" });
			const direct: string[] = [];
			const throughMemo: string[] = [];
			createEffect(
				() => row().text,
				(text) => void direct.push(text),
			);
			const text = createMemo(() => row().text);
			createEffect(text, (value) => void throughMemo.push(value));
			flush();
			expect(direct).toEqual(["saved"]);
			expect(throughMemo).toEqual(["saved"]);
			// A new object holding the same text, as a plan re-parsed after an unrelated edit hands every row.
			setRow({ text: "saved" });
			flush();
			expect(direct).toEqual(["saved", "saved"]);
			expect(throughMemo).toEqual(["saved"]);
		});
	});

	test("a write inside a computation does not throw here, where the development build refuses it", () => {
		// The development build's refusal is what the other tests rely on to catch such a write: it is not a
		// guarantee of the build that ships, so a write in a memo or an effect's compute has to be caught there.
		scoped(() => {
			const [n, setN] = createSignal(1);
			const memo = createMemo(() => {
				setN(5);
				return 1;
			});
			expect(() => memo()).not.toThrow();
			flush();
			expect(n()).toBe(5);
		});
	});
});
