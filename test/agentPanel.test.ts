// The Agent panel's and the review's decisions (src/view/agent/logic.ts,
// src/view/editor/reviewFlow.ts), run against the recorded fake of opencode
// where opencode is involved. No model, no DOM.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/bun/agent";
import { attempt, composerSend, decideModel, MINE, NOT_SENT, stepAction, Turns, USE_IT, type StepState } from "../src/view/agent/logic";
import { KEEP, LOSE_EDITS, REPLACE, reviewFlow, type Reviewable } from "../src/view/editor/reviewFlow";

const fake = ["bun", join(import.meta.dir, "fake-opencode.ts")];
const root = mkdtempSync(join(tmpdir(), "ssl-studio-agent-panel-"));
let agent: Agent | undefined;
afterEach(() => {
	agent?.dispose();
	agent = undefined;
	delete process.env.FAKE_MODE;
	delete process.env.FAKE_REPLY;
});

/** The adapter on the fake, with the panel's turn tracker fed its events, as store.ts feeds it. */
function make(env: Record<string, string> = {}) {
	const events: { type: string; data: any }[] = [];
	Object.assign(process.env, { FAKE_VERSION: "2.2.5", ...env });
	const made = new Agent(
		(type, data) => {
			events.push({ type, data });
			turns.event(type, data as any);
		},
		() => root,
		fake,
	);
	const turns = new Turns((sessionID) => made.call("interrupt", [sessionID]));
	agent = made;
	return { agent: made, events, turns };
}

const until = async (ready: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!ready() && Date.now() < end) await Bun.sleep(10);
	return ready();
};

describe("Stop this reply (item 1)", () => {
	test("stops a turn that has written nothing yet", async () => {
		const { agent, events, turns } = make({ FAKE_MODE: "wait" });
		turns.begin();
		const asking = agent.ask({ text: "think for a long time", keep: true });
		// The turn is running, and no text has come: the old tracker knew of no session to stop here.
		expect(await until(() => events.some((e) => e.type === "session.execution.started"))).toBe(true);
		expect(events.some((e) => e.type === "session.text.delta")).toBe(false);
		expect(await turns.stop()).toBe("stopped");
		const reply = await asking;
		turns.end();
		expect(reply.outcome).toBe("interrupted");
		expect(turns.busy).toBe(false);
		expect(turns.stopping).toBe(false);
	});

	test("pressed before opencode has a session, it stops the turn as soon as there is one", async () => {
		const { agent, events, turns } = make({ FAKE_MODE: "wait" });
		turns.begin();
		const asking = agent.ask({ text: "think for a long time", keep: true });
		// The server is still starting: nothing to interrupt, so the stop is remembered.
		expect(events.some((e) => e.type === "session")).toBe(false);
		expect(await turns.stop()).toBe("waiting");
		expect(turns.stopping).toBe(true);
		const reply = await asking;
		turns.end();
		expect(reply.outcome).toBe("interrupted");
		expect(events.some((e) => e.type === "session.text.delta")).toBe(false);
	});

	test("does nothing when no reply is in flight, and does not stop the next one", async () => {
		const { agent, turns } = make({ FAKE_REPLY: "ok" });
		expect(await turns.stop()).toBe("idle");
		turns.begin();
		const reply = await agent.ask({ text: "hello" });
		turns.end();
		expect(reply.outcome).toBe("succeeded");
		expect(reply.text).toBe("ok");
	});

	test("a kept session is known before its first event", async () => {
		const sent: string[] = [];
		const turns = new Turns(async (id) => void sent.push(id));
		turns.begin("ses_kept");
		expect(await turns.stop()).toBe("stopped");
		expect(sent).toEqual(["ses_kept"]);
		// The interrupt landed before the prompt and did nothing: it goes again when the turn starts.
		turns.event("session.execution.started", { sessionID: "ses_kept" });
		expect(sent).toEqual(["ses_kept", "ses_kept"]);
		turns.event("session.execution.interrupted", { sessionID: "ses_kept" });
		turns.end();
		turns.begin();
		turns.event("session.execution.started", { sessionID: "ses_next" });
		expect(sent).toEqual(["ses_kept", "ses_kept"]);
	});
});

describe("choosing a model (item 2)", () => {
	test("declining a paid model saves nothing, so the list must go back", async () => {
		const { agent } = make();
		const models = await agent.models();
		const asked: string[] = [];
		const declined = await decideModel("openrouter/paid-model", models, async (title) => (asked.push(title), null));
		expect(declined).toBeNull();
		expect(asked[0]).toMatch(/not a local model and may cost money/);
	});

	test("a paid model is used only on a yes, and a local one is not asked about", async () => {
		const { agent } = make();
		const models = await agent.models();
		expect(await decideModel("openrouter/paid-model", models, async () => USE_IT)).toEqual({ model: "openrouter/paid-model", own: false });
		expect(await decideModel("openrouter/paid-model", models, async () => MINE)).toEqual({ model: "openrouter/paid-model", own: true });
		expect(await decideModel("openrouter/paid-model", models, async () => "Cancel")).toBeNull();
		let asked = 0;
		expect(await decideModel("ollama/qwen3:14b", models, async () => (asked++, null))).toEqual({ model: "ollama/qwen3:14b", own: false });
		expect(asked).toBe(0);
	});
});

describe("Send while the agent is busy (item 4)", () => {
	test("keeps the draft and says why it was not sent", async () => {
		const { agent, events, turns } = make({ FAKE_MODE: "wait" });
		turns.begin();
		const asking = agent.ask({ text: "first question", keep: true });
		await until(() => events.some((e) => e.type === "session.execution.started"));
		expect(composerSend("  a second question\nover two lines ", turns.busy)).toEqual({ send: null, draft: "  a second question\nover two lines ", why: NOT_SENT });
		await turns.stop();
		await asking;
		turns.end();
		// The reply has ended: the same draft now goes out, and only then is it cleared.
		expect(composerSend("  a second question\nover two lines ", turns.busy)).toEqual({ send: "a second question\nover two lines", draft: "" });
	});

	test("an empty draft sends nothing and says nothing", () => {
		expect(composerSend("  \n", false)).toEqual({ send: null, draft: "  \n" });
	});
});

describe("a failure nobody waits for (item 9)", () => {
	test("is shown, written to Output, and leaves the step where it can be tried again", async () => {
		const { agent } = make({ FAKE_REPLY: "ok" });
		const shown: { text: string; kind: string }[] = [];
		const logged: string[] = [];
		let step: StepState = "running";
		// A step whose skill opencode does not have: the adapter refuses, as it does in the app.
		const result = await attempt(
			"Tidy step 2 (Guards) did not finish",
			() => agent.ask({ text: "tidy", skills: ["ssl-no-such-skill"] }),
			{ notify: (text, kind) => shown.push({ text, kind }), log: (line) => logged.push(line) },
			() => (step = "failed"),
		);
		expect(result).toBeUndefined();
		expect(step as StepState).toBe("failed");
		expect(shown).toHaveLength(1);
		expect(shown[0]!.kind).toBe("error");
		expect(shown[0]!.text).toMatch(/^Tidy step 2 \(Guards\) did not finish: .*ssl-no-such-skill/);
		expect(logged.join("\n")).toContain("Tidy step 2 (Guards) did not finish");
		expect(stepAction(step, { busy: false, reviewOpen: false })).toEqual({ label: "Try again", disabled: false });
	});

	test("work that succeeds is left alone", async () => {
		const shown: string[] = [];
		expect(await attempt("x", async () => 7, { notify: (text) => shown.push(text), log: (line) => shown.push(line) })).toBe(7);
		expect(shown).toEqual([]);
	});

	test("a step's button says what it does, and why it cannot be pressed", () => {
		const idle = { busy: false, reviewOpen: false };
		expect(stepAction("pending", idle)).toEqual({ label: "Run", disabled: false });
		expect(stepAction("rejected", idle).label).toBe("Try again");
		expect(stepAction("accepted", idle).label).toBe("Run again");
		expect(stepAction("unchanged", idle).label).toBe("Run again");
		const running = stepAction("running", idle);
		expect(running.disabled).toBe(true);
		expect(running.title).toBeTruthy();
		const busy = stepAction("failed", { busy: true, reviewOpen: false });
		expect(busy).toMatchObject({ label: "Try again", disabled: true });
		expect(busy.title).toBeTruthy();
		// A step under review is never a dead end: its proposal can be shown again.
		expect(stepAction("review", { busy: false, reviewOpen: false })).toMatchObject({ label: "Show review", disabled: false });
		expect(stepAction("review", { busy: false, reviewOpen: true })).toMatchObject({ disabled: true });
		expect(stepAction("review", { busy: false, reviewOpen: true }).title).toBeTruthy();
	});
});

describe("a review (items 12 to 14)", () => {
	type R = Reviewable & { name: string };
	function setup(answers: (string | null)[] = []) {
		let current: R | null = null;
		const asked: string[] = [];
		const failures: string[] = [];
		const flow = reviewFlow<R>({
			current: () => current,
			show: (r) => (current = r),
			choose: async (title) => (asked.push(title), answers.shift() ?? null),
			fail: (text) => failures.push(text),
		});
		return { flow, asked, failures, current: () => current };
	}
	const make = (name: string, parts: Partial<Reviewable> = {}): R & { rejected: number } => {
		const r = { name, title: name, rejected: 0, onAccept: async () => {}, onReject: () => void r.rejected++, ...parts };
		return r;
	};

	test("stays open when the accept fails, and closes when it works", async () => {
		const s = setup();
		const written: string[] = [];
		let disk = "full";
		const r = make("Tidy 1/6 Context", {
			onAccept: async (text) => {
				if (disk === "full") throw new Error("No space left on device");
				written.push(text);
			},
		});
		expect(await s.flow.open(r)).toBe(true);
		expect(await s.flow.accept(r, "the reviewed text")).toBe("No space left on device");
		// Nothing was written, the review is still there with its text, and the user was told.
		expect(s.current()).toBe(r);
		expect(written).toEqual([]);
		expect(s.failures).toHaveLength(1);
		expect(s.failures[0]).toMatch(/was not accepted: No space left on device/);
		expect(r.rejected).toBe(0);
		disk = "ok";
		expect(await s.flow.accept(r, "the reviewed text")).toBeNull();
		expect(written).toEqual(["the reviewed text"]);
		expect(s.current()).toBeNull();
	});

	test("the review is still open while the accept runs", async () => {
		const s = setup();
		let during: R | null = null;
		const r = make("Spec", { onAccept: async () => void (during = s.current()) });
		await s.flow.open(r);
		await s.flow.accept(r, "text");
		expect(during as R | null).toBe(r);
	});

	test("an accept that opens the next review hands over without a question", async () => {
		const s = setup();
		const next = make("Build: B.ssl");
		const first = make("Build: A.ssl", { onAccept: async () => void (await s.flow.open(next)) });
		await s.flow.open(first);
		expect(await s.flow.accept(first, "text")).toBeNull();
		expect(s.asked).toEqual([]);
		expect(s.current()).toBe(next);
		expect(first.rejected).toBe(0);
	});

	test("a new review asks before it replaces an open one", async () => {
		const s = setup([KEEP, REPLACE]);
		const tidy = make("Tidy 2/6 Guards");
		const snapshot = make("Snapshot 12:04");
		await s.flow.open(tidy);
		// Kept: the new one is not shown, and nobody's reject runs.
		expect(await s.flow.open(snapshot)).toBe(false);
		expect(s.current()).toBe(tidy);
		expect(tidy.rejected + snapshot.rejected).toBe(0);
		// Replaced: the open one is told it was dropped.
		expect(await s.flow.open(snapshot)).toBe(true);
		expect(s.current()).toBe(snapshot);
		expect(tidy.rejected).toBe(1);
		expect(s.asked).toHaveLength(2);
		expect(s.asked[0]).toContain("Tidy 2/6 Guards");
	});

	test("closing the question leaves the open review alone", async () => {
		const s = setup([null]);
		const open = make("Spec");
		await s.flow.open(open);
		expect(await s.flow.open(make("Snapshot"))).toBe(false);
		expect(s.current()).toBe(open);
		expect(open.rejected).toBe(0);
	});

	test("showing the open review again asks nothing", async () => {
		const s = setup();
		const r = make("Tidy 3/6 Structure");
		await s.flow.open(r);
		expect(await s.flow.open(r)).toBe(true);
		expect(s.asked).toEqual([]);
	});

	test("reject asks only when the proposed side was edited", async () => {
		const s = setup([KEEP, LOSE_EDITS]);
		const r = make("Tidy 4/6 Clarity");
		await s.flow.open(r);
		expect(await s.flow.reject(r, true)).toBe(false);
		expect(s.current()).toBe(r);
		expect(r.rejected).toBe(0);
		expect(await s.flow.reject(r, true)).toBe(true);
		expect(s.current()).toBeNull();
		expect(r.rejected).toBe(1);

		const plain = make("Snapshot");
		await s.flow.open(plain);
		expect(await s.flow.reject(plain, false)).toBe(true);
		expect(s.asked).toHaveLength(2);
		expect(plain.rejected).toBe(1);
	});

	test("a reject whose own clean-up fails is reported, not thrown", async () => {
		const s = setup();
		const r = make("Build: A.ssl", { onReject: async () => Promise.reject(new Error("plan not open")) });
		await s.flow.open(r);
		expect(await s.flow.reject(r, false)).toBe(true);
		await Bun.sleep(0);
		expect(s.failures[0]).toMatch(/plan not open/);
	});
});

import { changeSize } from "../src/view/editor/reviewFlow";

test("a proposed change says how large it is", () => {
	const change = (o: [number, number], m: [number, number]) => ({ originalStartLineNumber: o[0], originalEndLineNumber: o[1], modifiedStartLineNumber: m[0], modifiedEndLineNumber: m[1] });
	// One line taken away: the other side has no lines there (an end of 0).
	expect(changeSize([change([6, 6], [5, 0])])).toBe("1 line removed or changed");
	expect(changeSize([change([3, 0], [4, 6])])).toBe("3 lines added or changed");
	expect(changeSize([change([2, 3], [2, 2]), change([9, 0], [8, 8])])).toBe("2 lines added or changed, 2 lines removed or changed");
	expect(changeSize([])).toBe("No lines differ");
	// Not worked out yet.
	expect(changeSize(null)).toBe("");
});

import { groupModels } from "../src/view/agent/logic";

describe("the models to choose from, under headings", () => {
	const model = (providerID: string, name: string, local = false) => ({ providerID, id: name.toLowerCase(), name, local });

	test("those on this machine come first, under one heading whichever provider serves them", () => {
		const groups = groupModels([model("zeta", "Big"), model("ollama", "qwen3:14b", true), model("local", "granite", true), model("alpha", "Small")]);
		expect(groups.map((g) => g.label)).toEqual(["On this machine", "alpha: may cost money", "zeta: may cost money"]);
		expect(groups[0]!.models.map((m) => m.name)).toEqual(["granite", "qwen3:14b"]);
		expect(groups[0]!.local).toBe(true);
	});

	test("a provider's models are by name, numbers in their order", () => {
		const groups = groupModels([model("p", "GPT-10"), model("p", "GPT-9"), model("p", "claude")]);
		expect(groups[0]!.models.map((m) => m.name)).toEqual(["claude", "GPT-9", "GPT-10"]);
	});

	test("with no local model there is no heading for them, and with no model no heading at all", () => {
		expect(groupModels([model("p", "A")]).map((g) => g.label)).toEqual(["p: may cost money"]);
		expect(groupModels([])).toEqual([]);
	});
});


import { composeQuestion } from "../src/view/agent/logic";

describe("a question as it is sent", () => {
	test("on its own, it is the question and nothing else", () => {
		expect(composeQuestion("Why?")).toBe("Why?");
	});

	test("with code, the code follows it, and the agent is told it cannot read files", () => {
		const text = composeQuestion("Why?", { file: "src/A.ssl", label: "lines 3-9", code: ":RETURN 1;" });
		expect(text).toBe("Why?\n\nAbout this code from src/A.ssl, lines 3-9:\n```ssl\n:RETURN 1;\n```\n\nYou cannot read files in this session; answer from the code above.");
	});

	test("with the work it is for, the work comes first and the question is marked", () => {
		const text = composeQuestion("Which cases?", null, "THE WORK THIS IS FOR:\nTICKET A-1: First");
		expect(text).toBe("THE WORK THIS IS FOR:\nTICKET A-1: First\n\nTHE QUESTION:\nWhich cases?\n\nYou cannot read files in this session; answer from the documents above.");
		expect(composeQuestion("Q", { file: "a.ssl", label: "lines 1-2", code: "x" }, "WORK")).toEndWith("answer from the code and the documents above.");
	});
});
