// ADR 0009: the app's window does not close over unsaved work. The app's
// side of that: it says no while the view reports unsaved files, tells the
// view to ask, and quits when the view says the user has decided.
import { describe, expect, test } from "bun:test";
import { createBackend, type Host } from "../src/bun/backend";

function app() {
	const events: string[] = [];
	let quits = 0;
	const host: Host = {
		app: "test",
		kind: "app",
		emit: (event) => void events.push(event),
		pick: async () => null,
		trash: async () => undefined,
		quit: () => void quits++,
	};
	const backend = createBackend(host);
	return { backend, events, quits: () => quits };
}

describe("closing the window", () => {
	test("with nothing unsaved, the window may close and nobody is asked", () => {
		const { backend, events } = app();
		expect(backend.mayClose()).toBe(true);
		expect(events).toEqual([]);
		backend.dispose();
	});

	test("with unsaved files it may not, and the view is told to ask", async () => {
		const { backend, events } = app();
		await backend.api.unsavedChanged(2);
		expect(backend.mayClose()).toBe(false);
		expect(events).toEqual(["closeRequested"]);
		backend.dispose();
	});

	test("once everything is saved, it may close again", async () => {
		const { backend } = app();
		await backend.api.unsavedChanged(1);
		await backend.api.unsavedChanged(0);
		expect(backend.mayClose()).toBe(true);
		backend.dispose();
	});

	test("the view's decision closes the app, whatever was unsaved", async () => {
		const { backend, quits } = app();
		await backend.api.unsavedChanged(3);
		await backend.api.closeWindow();
		expect(backend.mayClose()).toBe(true);
		await new Promise((r) => setTimeout(r, 80));
		expect(quits()).toBe(1);
		backend.dispose();
	});

	test("a count that is not a number counts as nothing unsaved", async () => {
		const { backend } = app();
		await backend.api.unsavedChanged(Number.NaN);
		expect(backend.mayClose()).toBe(true);
		backend.dispose();
	});
});
