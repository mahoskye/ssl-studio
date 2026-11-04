// A stand-in for `opencode serve --stdio --port 0` (v2.2.5), for tests: the
// endpoints and event shapes recorded in docs/spikes/opencode-api.md (M0).
// Replies come from FAKE_REPLY; no model is involved.
const password = process.env.OPENCODE_PASSWORD ?? "";
const version = process.env.FAKE_VERSION ?? "2.2.5";
const reply = process.env.FAKE_REPLY ?? "Fake reply.";
const started = Date.now();
const SKILLS = ["ssl-new-procedure", "ssl-unit-test", "ssl-tidy-context", "ssl-tidy-guards", "ssl-tidy-structure", "ssl-tidy-clarity", "ssl-tidy-comments", "ssl-tidy-verify"];
const sessions = new Map<string, any>();
const streams = new Set<ReadableStreamDefaultController>();
let n = 0;

const send = (type: string, data: unknown) => {
	const text = `data: ${JSON.stringify({ id: `evt_${++n}`, type, created: Date.now(), data })}\n\n`;
	for (const s of streams) s.enqueue(new TextEncoder().encode(text));
};

function run(sessionID: string, text: string) {
	const messageID = `msg_${++n}`;
	const answer = process.env.FAKE_MODE === "tidy" ? tidyReply(text) : process.env.FAKE_MODE === "plan" ? planReply(text) : reply.replace("{prompt}", text);
	setTimeout(() => {
		send("session.execution.started", { sessionID });
		if (process.env.FAKE_MODE === "loop") {
			// A model trying again and again to call something that cannot help.
			for (let i = 0; i < 5; i++) send("session.tool.called", { sessionID, assistantMessageID: messageID, id: `call_${i}`, input: { code: "await tools.write()" } });
			sessions.get(sessionID).interruptWanted = true;
			return;
		}
		if (process.env.FAKE_MODE === "escape") {
			// Code mode reaching for a helper that asks no permission.
			send("session.tool.called", { sessionID, assistantMessageID: messageID, id: "call_1", input: { code: "await tools.opencode.worktree_create({ name: 'x' })" }, executed: false });
			sessions.get(sessionID).interruptWanted = true;
			return;
		}
		send("session.step.started", { sessionID, agent: "build", model: sessions.get(sessionID).model, assistantMessageID: messageID, started: Date.now() });
		for (const delta of answer.match(/.{1,20}/gs) ?? []) send("session.text.delta", { sessionID, assistantMessageID: messageID, ordinal: 0, delta });
		send("session.text.ended", { sessionID, assistantMessageID: messageID, ordinal: 0, text: answer });
		const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } };
		send("session.step.ended", { sessionID, assistantMessageID: messageID, finish: "stop", rawFinish: "stop", tokens, cost: 0 });
		sessions.get(sessionID).messages.push(
			{ type: "user", text },
			{ type: "assistant", content: [{ type: "text", text: answer }], tokens, cost: 0 },
			{ type: "idle", outcome: "succeeded" },
		);
		send("session.execution.succeeded", { sessionID });
	}, 20);
}

/** FAKE_MODE=plan: asks to read something, then asks and suggests; a spec that accounts for the sample's nodes. */
function planReply(text: string) {
	if (text.startsWith("PLAN STAGE: refine")) {
		if (!text.includes("CONTEXT YOU ASKED FOR")) return '<<<CONTEXT\n[{"procedure":"IsUsableId"},{"file":"Regions.ssl"},{"element":"Empty"},{"file":"nope.ssl"}]\n>>>CONTEXT';
		const asked = text.includes("Which table holds") ? "" : '<<<QUESTIONS\n[{"question":"Which table holds the status?","node":"n4","answers":["SAMPLES","ORDERS"]},{"question":"How is the lab told?","node":"n5"}]\n>>>QUESTIONS\n';
		return `${asked}<<<CHART\n{"nodes":[{"id":"a","kind":"step","text":"Report the failure","why":"The chart does not say what happens when the update fails."}],"edges":[{"from":"n3","to":"a","label":"locked"},{"from":"a","to":"n6"}],"changes":[{"id":"n5","notes":"Only after the commit.","why":"A failed notice should not undo the release."}]}\n>>>CHART`;
	}
	if (text.startsWith("PLAN STAGE: spec") && text.includes("THIS IS A CHANGE TO WHAT IS ALREADY BUILT")) {
		// Only what changed, as the prompt asks: nodes it names, in the unit that carries most of them.
		const named = [...text.split("WHAT IS BUILT:")[1]!.matchAll(/^- (n\d+):/gm)].map((m) => m[1]!);
		const units = [{ name: "ReleaseSample", script: "Sample/Release.ssl", parameters: ["sSampleId"], nodes: ["n1", "n2", "n3", "n4", ...named.filter((n) => !["n1", "n2", "n3", "n4"].includes(n))], calls: ["IsUsableId"], lines: 40 }];
		return `<<<SPEC\n# Release a sample\n\n## Prior art\n\nReleaseSample is built. It changes for the new step.\n>>>SPEC\n<<<UNITS\n${JSON.stringify(units)}\n>>>UNITS\n<<<MAP\n${JSON.stringify(named.map((node) => ({ node, becomes: "part of ReleaseSample" })))}\n>>>MAP\n<<<QUESTIONS\n[]\n>>>QUESTIONS`;
	}
	if (text.startsWith("PLAN STAGE: spec")) {
		const map = process.env.FAKE_SPEC_INCOMPLETE ? [{ node: "n1", becomes: "the parameters" }] : ["n1", "n2", "n3", "n4", "n5", "n6"].map((node) => ({ node, becomes: "part of ReleaseSample" }));
		const units = [{ name: "ReleaseSample", script: "Sample/Release.ssl", parameters: ["sSampleId"], nodes: ["n1", "n2", "n3", "n4"], calls: ["IsUsableId"], lines: Number(process.env.FAKE_SPEC_LINES ?? 40) }, ...(process.env.FAKE_BUILD_HARD ? [{ name: "NeverRight", script: "Sample/Release.ssl", parameters: ["sSampleId"], nodes: ["n5"], calls: [] }, { name: "AfterHard", script: "Sample/Release.ssl", parameters: ["sSampleId"], nodes: ["n6"], calls: ["NeverRight"] }, { name: "AskFirst", script: "Sample/Other.ssl", parameters: ["sSampleId"], nodes: [], calls: [] }] : [])];
		return `<<<SPEC\n# Release a sample\n\n## Prior art\n\nIsUsableId already checks the id.\n\n## Procedures\n\nReleaseSample(sSampleId).\n>>>SPEC\n<<<UNITS\n${JSON.stringify(units)}\n>>>UNITS\n<<<MAP\n${JSON.stringify(map)}\n>>>MAP\n<<<QUESTIONS\n[]\n>>>QUESTIONS`;
	}
	// A unit: wrong first, as models are, then right after the findings come back.
	const unit = /^PLAN STAGE: build (\w+)/.exec(text)?.[1];
	if (unit) {
		if (text.includes("YOU ASKED:") === false && unit === "AskFirst") return '<<<QUESTIONS\n[{"question":"Which group is told?"}]\n>>>QUESTIONS';
		const fixed = text.includes("THESE ARE WRONG WITH IT") || text.includes("ALREADY EXISTS, as below");
		const body = fixed || unit === "AskFirst" ? `:RETURN ExecFunction("Regions.IsUsableId", {sSampleId});` : `/* Placeholder: implement actual logic here;\n:RETURN Gone(sSampleId);`;
		if (unit === "NeverRight") return "```ssl\n:PROCEDURE NeverRight;\n:PARAMETERS sSampleId;\n/* TODO later;\n:RETURN 1;\n:ENDPROC;\n```";
		return `\`\`\`ssl\n/*\n    ${unit}.\n\n    sSampleId - the id\n;\n:PROCEDURE ${unit};\n:PARAMETERS sSampleId;\n${body}\n:ENDPROC;\n\`\`\``;
	}
	// A test script: one path short at first, then one test for each path it was given.
	if (text.startsWith("PLAN STAGE: tests")) {
		const count = text.match(/^Path \d+:/gm)?.length ?? 0;
		const fixed = text.includes("THESE ARE WRONG WITH IT");
		const tests = Array.from({ length: fixed ? count : Math.max(0, count - 1) }, (_, i) => `:PROCEDURE TestPath${i + 1};\n/* Path ${i + 1}: as the chart has it;\n:RETURN {"Path ${i + 1}", .T.};\n:ENDPROC;`);
		return `\`\`\`ssl\n/* Tests for the plan. Run by calling RunTests;\n\n:PROCEDURE RunTests;\n:RETURN {};\n:ENDPROC;\n\n${tests.join("\n\n")}\n\`\`\``;
	}
	if (text.startsWith("PLAN STAGE: second opinion")) return "Each step of the chart is carried out, as far as this reader can tell.";
	return "Fake reply.";
}

/** FAKE_MODE=tidy: a context note for step 1, the file with one added comment otherwise. */
function tidyReply(text: string) {
	if (text.includes("Run step 1 ")) return "```markdown\n# Context\n\nFake note: no callers found.\n```";
	if (text.includes("Run step 6 ")) return "```markdown\nFake verification: every change re-checked.\n```";
	const file = /```ssl\n([\s\S]*?)\n```/.exec(text)?.[1] ?? "";
	const step = /Run step (\d)/.exec(text)?.[1];
	return `\`\`\`ssl\n/* Tidied by the fake, step ${step};\n${file}\n\`\`\`\n\n\`\`\`markdown\nStep ${step}: added a comment.\n\`\`\``;
}

// Heartbeats as SSE comments, as opencode sends them.
setInterval(() => {
	for (const s of streams) s.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
}, 3000);

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.headers.get("authorization") !== `Basic ${btoa(`opencode:${password}`)}`) return new Response("unauthorized", { status: 401 });
		const path = url.pathname;
		if (path === "/api/info") return Response.json({ data: { version } });
		if (path === "/api/model")
			return Response.json({
				data: [
					{ id: "openrouter/paid", modelID: "paid-model", providerID: "openrouter", name: "Paid", capabilities: { tools: true }, variants: [] },
					{ id: "ollama/qwen3:14b", modelID: "qwen3:14b", providerID: "ollama", name: "Qwen3 14B", capabilities: { tools: true }, variants: [{ id: "no-thinking" }] },
				],
			});
		// A real server fills this in stages after it starts: nothing, the built-ins, then all.
		if (path === "/api/skill") {
			const after = Number(process.env.FAKE_SKILLS_AFTER_MS ?? 0);
			const age = Date.now() - started;
			const ids = age >= after ? SKILLS : age >= after / 2 ? ["opencode", "report"] : [];
			return Response.json({ data: ids.map((id) => ({ id, name: id })) });
		}
		if (path === "/api/event")
			return new Response(
				new ReadableStream({
					start(controller) {
						streams.add(controller);
						controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`));
					},
					cancel(controller) {
						streams.delete(controller as any);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		if (path === "/api/session" && req.method === "POST") {
			const body = await req.json();
			const id = `ses_${++n}`;
			sessions.set(id, { ...body, id, messages: [], prompts: [] });
			return Response.json({ data: { id } });
		}
		if (path === "/test/sessions") return Response.json([...sessions.values()]);
		const m = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path);
		if (m) {
			const session = sessions.get(m[1]!);
			if (!session) return new Response("no session", { status: 404 });
			if (m[2] === "/prompt") {
				const body = await req.json();
				session.prompts.push(body);
				run(session.id, body.text);
				return Response.json({ data: { id: `inb_${++n}`, sessionID: session.id, type: "user", payload: { text: body.text }, delivery: "queue" } });
			}
			if (m[2]?.startsWith("/message")) return Response.json({ data: session.messages });
			if (m[2] === "/interrupt") {
				session.interrupted = true;
				if (session.interruptWanted) setTimeout(() => send("session.execution.interrupted", { sessionID: session.id }), 10);
				return Response.json({ interrupted: true });
			}
			if (!m[2] && req.method === "DELETE") return new Response(null, { status: 204 });
		}
		return new Response("not found", { status: 404 });
	},
});

console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
// Stop when stdin closes, as `serve --stdio` does.
(async () => {
	for await (const _ of Bun.stdin.stream()) {
	}
	process.exit(0);
})();
