import { describe, expect, test } from "bun:test";
import { createMiddleClickGuard, createMiddleCloseTracker, isExplicitPasteKey, MIDDLE_PASTE_WINDOW_MS } from "../src/shared/middleClickGuard";

const key = (over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({
	key: "v",
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	altKey: false,
	...over,
});

describe("middleClickGuard", () => {
	test("allows paste when no middle mouse button event has occurred", () => {
		const guard = createMiddleClickGuard();
		expect(guard.shouldBlockPaste(1000)).toBe(false);
	});

	test("blocks synthesized paste events within the middle-click window", () => {
		const guard = createMiddleClickGuard();
		guard.noteMiddleMouse(1000);
		expect(guard.shouldBlockPaste(1000)).toBe(true);
		expect(guard.shouldBlockPaste(1000 + MIDDLE_PASTE_WINDOW_MS - 1)).toBe(true);
		expect(guard.shouldBlockPaste(1000 + MIDDLE_PASTE_WINDOW_MS)).toBe(true);
	});

	test("allows paste again after the middle-click window elapses", () => {
		const guard = createMiddleClickGuard();
		guard.noteMiddleMouse(1000);
		expect(guard.shouldBlockPaste(1000 + MIDDLE_PASTE_WINDOW_MS + 1)).toBe(false);
	});

	test("explicit keyboard paste immediately unblocks even inside the guard window", () => {
		const guard = createMiddleClickGuard();
		guard.noteMiddleMouse(1000);
		expect(guard.shouldBlockPaste(1010)).toBe(true);
		guard.noteExplicitPaste();
		expect(guard.shouldBlockPaste(1015)).toBe(false);
	});

	test("later middle-mouse events refresh the guard window", () => {
		const guard = createMiddleClickGuard(200);
		guard.noteMiddleMouse(1000);
		guard.noteMiddleMouse(1150);
		expect(guard.shouldBlockPaste(1300)).toBe(true);
		expect(guard.shouldBlockPaste(1351)).toBe(false);
	});
});

describe("isExplicitPasteKey", () => {
	test("recognizes Ctrl+V, Cmd+V, plain-text Shift+V variants, and Shift+Insert", () => {
		expect(isExplicitPasteKey(key({ ctrlKey: true, key: "v" }))).toBe(true);
		expect(isExplicitPasteKey(key({ ctrlKey: true, key: "V" }))).toBe(true);
		expect(isExplicitPasteKey(key({ ctrlKey: true, shiftKey: true, key: "V" }))).toBe(true);
		expect(isExplicitPasteKey(key({ metaKey: true, key: "v" }))).toBe(true);
		expect(isExplicitPasteKey(key({ metaKey: true, shiftKey: true, key: "v" }))).toBe(true);
		expect(isExplicitPasteKey(key({ shiftKey: true, key: "Insert" }))).toBe(true);
	});

	test("ignores non-paste keys and Alt chords", () => {
		expect(isExplicitPasteKey(key({ key: "v" }))).toBe(false);
		expect(isExplicitPasteKey(key({ altKey: true, ctrlKey: true, key: "v" }))).toBe(false);
		expect(isExplicitPasteKey(key({ altKey: true, shiftKey: true, key: "Insert" }))).toBe(false);
		expect(isExplicitPasteKey(key({ key: "Insert" }))).toBe(false);
		expect(isExplicitPasteKey(key({ ctrlKey: true, key: "Insert" }))).toBe(false);
		expect(isExplicitPasteKey(key({ ctrlKey: true, key: "c" }))).toBe(false);
	});
});

describe("createMiddleCloseTracker", () => {
	const fakeTimers = () => {
		let nextId = 1;
		const scheduled = new Map<number, () => void>();
		const schedule = (fn: () => void) => {
			const id = nextId++;
			scheduled.set(id, fn);
			return id as unknown as ReturnType<typeof setTimeout>;
		};
		const cancel = (id: ReturnType<typeof setTimeout>) => {
			scheduled.delete(id as unknown as number);
		};
		const flush = () => {
			for (const [id, fn] of [...scheduled]) {
				scheduled.delete(id);
				fn();
			}
		};
		return { schedule, cancel, flush, count: () => scheduled.size };
	};

	test("closes once on press -> release -> auxClick and cancels the fallback timer", () => {
		const timers = fakeTimers();
		const tracker = createMiddleCloseTracker(timers.schedule, timers.cancel);
		const closed: string[] = [];

		tracker.press("a.ssl");
		expect(closed).toEqual([]);

		tracker.release("a.ssl", () => closed.push("a.ssl"));
		expect(closed).toEqual([]);
		expect(timers.count()).toBe(1);

		tracker.auxClick("a.ssl", () => closed.push("a.ssl"));
		expect(closed).toEqual(["a.ssl"]);
		expect(timers.count()).toBe(0);

		timers.flush();
		expect(closed).toEqual(["a.ssl"]);
	});

	test("closes once via fallback timer when auxClick does not fire", () => {
		const timers = fakeTimers();
		const tracker = createMiddleCloseTracker(timers.schedule, timers.cancel);
		const closed: string[] = [];

		tracker.press("a.ssl");
		tracker.release("a.ssl", () => closed.push("a.ssl"));
		expect(closed).toEqual([]);

		timers.flush();
		expect(closed).toEqual(["a.ssl"]);
		// Late auxClick after timer already ran is a no-op.
		tracker.auxClick("a.ssl", () => closed.push("a.ssl"));
		expect(closed).toEqual(["a.ssl"]);
	});

	test("cancels closing when pointer leaves the tab before mouseup", () => {
		const timers = fakeTimers();
		const tracker = createMiddleCloseTracker(timers.schedule, timers.cancel);
		const closed: string[] = [];

		tracker.press("a.ssl");
		tracker.cancel("a.ssl");
		tracker.release("a.ssl", () => closed.push("a.ssl"));
		tracker.auxClick("a.ssl", () => closed.push("a.ssl"));
		timers.flush();

		expect(closed).toEqual([]);
	});

	test("does not close a different tab than the one pressed", () => {
		const timers = fakeTimers();
		const tracker = createMiddleCloseTracker(timers.schedule, timers.cancel);
		const closed: string[] = [];

		tracker.press("a.ssl");
		tracker.release("b.ssl", () => closed.push("b.ssl"));
		tracker.auxClick("b.ssl", () => closed.push("b.ssl"));
		timers.flush();

		expect(closed).toEqual([]);
	});

	test("dispose cancels pending close timers", () => {
		const timers = fakeTimers();
		const tracker = createMiddleCloseTracker(timers.schedule, timers.cancel);
		const closed: string[] = [];

		tracker.press("a.ssl");
		tracker.release("a.ssl", () => closed.push("a.ssl"));
		tracker.dispose();
		timers.flush();

		expect(closed).toEqual([]);
	});
});
