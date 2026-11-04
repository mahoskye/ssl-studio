import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/bun/agent";

const fake = ["bun", join(import.meta.dir, "fake-opencode.ts")];
const root = mkdtempSync(join(tmpdir(), "ssl-studio-agent-"));
let agent: Agent | undefined;
afterEach(() => agent?.dispose());

function make(env: Record<string, string> = {}) {
	const events: { type: string; data: any }[] = [];
	Object.assign(process.env, env);
	agent = new Agent((type, data) => events.push({ type, data }), () => root, fake);
	return { agent, events };
}

test("asks on a fresh session with deny rules and a local model", async () => {
	const { agent, events } = make({ FAKE_REPLY: "```ssl\n:RETURN 1;\n```", FAKE_VERSION: "2.2.5" });
	const reply = await agent.ask({ text: "tidy this", skills: ["ssl-tidy-context"], keep: true });
	expect(reply.outcome).toBe("succeeded");
	expect(reply.text).toBe("```ssl\n:RETURN 1;\n```");
	expect(reply.tokens).toEqual({ input: 100, output: 20 });
	expect(events.filter((e) => e.type === "session.text.delta").map((e) => e.data.delta).join("")).toBe(reply.text);

	const base = (agent as any).base as string;
	const sessions = await fetch(`${base}/test/sessions`, { headers: { Authorization: (agent as any).auth } }).then((r) => r.json());
	expect(sessions[0].model).toEqual({ providerID: "ollama", id: "qwen3:14b" });
	expect(sessions[0].location).toEqual({ directory: root });
	expect(sessions[0].permissions.map((p: any) => `${p.action}:${p.effect}`)).toEqual([
		"shell:deny",
		"webfetch:deny",
		"websearch:deny",
		"external_directory:deny",
		"question:deny",
		"edit:deny",
	]);
	expect(sessions[0].prompts[0].skills).toEqual([{ id: "ssl-tidy-context" }]);
});

test("lists local models first and never defaults to a paid one", async () => {
	const { agent } = make({ FAKE_VERSION: "2.2.5" });
	const models = await agent.models();
	expect(models[0]).toMatchObject({ providerID: "ollama", local: true });
	expect(models.find((m) => m.providerID === "openrouter")!.local).toBe(false);
});

test("refuses a version outside the range", async () => {
	const { agent, events } = make({ FAKE_VERSION: "2.4.0" });
	await expect(agent.call("start", [])).rejects.toThrow(/outside the supported range/);
	expect(events.at(-1)).toMatchObject({ type: "status", data: { state: "failed" } });
});

test("a turn that reaches for an unguarded helper is interrupted", async () => {
	const { agent, events } = make({ FAKE_VERSION: "2.2.5", FAKE_MODE: "escape" });
	const reply = await agent.ask({ text: "make a worktree", keep: true });
	process.env.FAKE_MODE = "";
	expect(reply.outcome).toBe("interrupted");
	expect(reply.error).toMatch(/worktree_create/);
	expect(events.find((e) => e.type === "guard")?.data.tool).toBe("worktree_create");
	const base = (agent as any).base as string;
	const sessions = await fetch(`${base}/test/sessions`, { headers: { Authorization: (agent as any).auth } }).then((r) => r.json());
	expect(sessions[0].interrupted).toBe(true);
});

test("waits for a new server's skills, which arrive in stages", async () => {
	const { agent } = make({ FAKE_SKILLS_AFTER_MS: "1000", FAKE_REPLY: "ok", FAKE_VERSION: "2.2.5" });
	try {
		// Asked at once: nothing yet, then only the built-ins, then all.
		const reply = await agent.ask({ text: "tidy this", skills: ["ssl-tidy-guards"] });
		expect(reply.outcome).toBe("succeeded");
	} finally {
		delete process.env.FAKE_SKILLS_AFTER_MS;
	}
});

test("the full list is the one that has stopped growing", async () => {
	const { agent } = make({ FAKE_SKILLS_AFTER_MS: "1000", FAKE_VERSION: "2.2.5" });
	try {
		expect((await agent.skills()).map((s) => s.id)).toContain("ssl-tidy-context");
	} finally {
		delete process.env.FAKE_SKILLS_AFTER_MS;
	}
});

test("refuses to run a step whose skill is missing, rather than run it without", async () => {
	const { agent } = make({ FAKE_REPLY: "ok", FAKE_VERSION: "2.2.5" });
	await expect(agent.ask({ text: "plan this", skills: ["ssl-no-such-skill"] })).rejects.toThrow("ssl-no-such-skill");
});

test("stops a turn that keeps calling tools, when told to", async () => {
	const { agent } = make({ FAKE_VERSION: "2.2.5", FAKE_MODE: "loop" });
	try {
		const reply = await agent.ask({ text: "write the unit", toolLimit: 2 });
		expect(reply.outcome).toBe("interrupted");
		expect(reply.error).toMatch(/kept calling tools/);
	} finally {
		delete process.env.FAKE_MODE;
	}
});
