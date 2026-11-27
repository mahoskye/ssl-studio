// ADR 0042: the app's window closes over unsaved work without a question, and the work is kept. The app's side
// of the close: with unsaved files it says no this once and sends for the view, which has their text kept and
// then closes the app. It asks nothing itself. (What is kept, and where: unsaved.test.ts. What the view does when
// sent for: pass4LowsViewCore.test.ts, B9-4.)
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend, VIEW_ANSWERS_WITHIN, type Host } from "../src/bun/backend";
import { dirs } from "../src/bun/paths";

function app(folder?: string) {
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
	const backend = createBackend(host, folder);
	return { backend, events, quits: () => quits };
}

/** The clock in the test's hands, for as long as the work takes. */
async function atTime<T>(work: (pass: (ms: number) => void) => Promise<T>): Promise<T> {
	const clock = Date.now;
	let now = 1_000_000;
	Date.now = () => now;
	try {
		return await work((ms) => void (now += ms));
	} finally {
		Date.now = clock;
	}
}

describe("closing the window", () => {
	test("with nothing unsaved, the window may close and the view is not sent for", () => {
		const { backend, events } = app();
		expect(backend.mayClose()).toBe(true);
		expect(events).toEqual([]);
		backend.dispose();
	});

	test("with unsaved files it does not close at once: the view is sent for, to have their text kept", async () => {
		const { backend, events } = app();
		await backend.api.unsavedChanged(2);
		expect(backend.mayClose()).toBe(false);
		expect(events).toEqual(["closeRequested"]);
		backend.dispose();
	});

	test("the view, done keeping, closes the app, whatever is unsaved", async () => {
		const { backend, quits } = app();
		await backend.api.unsavedChanged(3);
		expect(backend.mayClose()).toBe(false);
		await backend.api.closeWindow();
		expect(backend.mayClose()).toBe(true);
		await new Promise((r) => setTimeout(r, 80));
		expect(quits()).toBe(1);
		backend.dispose();
	});

	test("once everything is saved, it closes at once again", async () => {
		const { backend, events } = app();
		await backend.api.unsavedChanged(1);
		await backend.api.unsavedChanged(0);
		expect(backend.mayClose()).toBe(true);
		expect(events).toEqual([]);
		backend.dispose();
	});

	test("a count that is not a number counts as nothing unsaved", async () => {
		const { backend } = app();
		await backend.api.unsavedChanged(Number.NaN);
		expect(backend.mayClose()).toBe(true);
		backend.dispose();
	});

	test("a view that never answers does not hold the window: a later request closes it, on what was kept as typed", async () => {
		const { backend, events } = app();
		await atTime(async (pass) => {
			await backend.api.unsavedChanged(1);
			expect(backend.mayClose()).toBe(false);
			// Pressed again at once (a double click): the view has had no time, and is sent for again.
			pass(50);
			expect(backend.mayClose()).toBe(false);
			expect(events).toEqual(["closeRequested", "closeRequested"]);
			// Never heard from since, and sent for long enough ago: it is not there to answer.
			pass(VIEW_ANSWERS_WITHIN + 1);
			expect(backend.mayClose()).toBe(true);
			expect(events.length).toBe(2);
		});
		backend.dispose();
	});

	test("a view that is heard from is waited for: its word starts the wait again", async () => {
		const { backend } = app();
		await atTime(async (pass) => {
			await backend.api.unsavedChanged(1);
			expect(backend.mayClose()).toBe(false);
			pass(VIEW_ANSWERS_WITHIN + 1);
			await backend.api.unsavedChanged(2);
			expect(backend.mayClose()).toBe(false);
		});
		backend.dispose();
	});

	test("while unsaved text cannot be kept, the window is never let go over a view that says nothing", async () => {
		// The app's state folder is a file here, so nothing can be written under it.
		const sandbox = mkdtempSync(join(tmpdir(), "ssl-studio-close-nokeep-"));
		const before = { ...dirs };
		const folder = join(sandbox, "ws");
		mkdirSync(folder);
		writeFileSync(join(folder, "a.ssl"), "one\n");
		writeFileSync(join(sandbox, "state"), "not a folder");
		Object.assign(dirs, { config: join(sandbox, "config"), data: join(sandbox, "data"), state: join(sandbox, "state") });
		const said = console.error;
		console.error = () => {};
		try {
			const { backend, events } = app(folder);
			await backend.ready;
			await atTime(async (pass) => {
				await backend.api.unsavedChanged(1);
				const root = (await backend.api.workspace())!.root;
				await expect(backend.api.unsavedKeep(root, [{ path: join(root, "a.ssl"), text: "two\n", saved: { text: "one\n", mtime: 1 } }], [])).rejects.toThrow();
				// Said to the person, once, and not again for the same cause.
				await expect(backend.api.unsavedKeep(root, [{ path: join(root, "a.ssl"), text: "three\n" }], [])).rejects.toThrow();
				expect(events.filter((event) => event === "notice").length).toBe(1);
				expect(backend.mayClose()).toBe(false);
				pass(10 * VIEW_ANSWERS_WITHIN);
				expect(backend.mayClose()).toBe(false);
			});
			backend.dispose();
		} finally {
			console.error = said;
			Object.assign(dirs, before);
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});

// A self-test (`hutch run selftest-cycle`) ends by telling the app it is done. Nobody is there to answer a question,
// and a run that left edits unsaved stood with it until its time limit: a plan built and rebuilt leaves two.
describe("a self-test that is done", () => {
	const REPORT = "SSL_STUDIO_SELFTEST";
	const before = process.env[REPORT];
	const folder = mkdtempSync(join(tmpdir(), "ssl-studio-close-"));
	afterEach(() => {
		if (before === undefined) delete process.env[REPORT];
		else process.env[REPORT] = before;
	});
	afterAll(() => rmSync(folder, { recursive: true, force: true }));

	test("writes its report and closes the app without asking, whatever it left unsaved", async () => {
		const report = join(folder, "selftest.json");
		process.env[REPORT] = report;
		const { backend, events, quits } = app();
		await backend.api.unsavedChanged(2);
		await backend.api.selftestDone({ ok: true });
		expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({ ok: true });
		expect(backend.mayClose()).toBe(true);
		expect(events).toEqual([]);
		await new Promise((r) => setTimeout(r, 400));
		expect(quits()).toBe(1);
		backend.dispose();
	});

	test("is nothing outside a self-test: the view is still sent for, to have unsaved work kept", async () => {
		delete process.env[REPORT];
		const { backend, events, quits } = app();
		await backend.api.unsavedChanged(2);
		await backend.api.selftestDone({ ok: true });
		expect(backend.mayClose()).toBe(false);
		expect(events).toEqual(["closeRequested"]);
		await new Promise((r) => setTimeout(r, 400));
		expect(quits()).toBe(0);
		backend.dispose();
	});
});
