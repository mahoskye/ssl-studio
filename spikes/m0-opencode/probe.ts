// M0 opencode probe: one prompt to a local model through a private
// `opencode serve --stdio`, with shell, web and outside-directory access
// denied for the session. Records every event raw to OUT (outside the repo;
// transcripts are never committed) and prints only shapes and outcomes.
//
//   OUT=/some/scratch/dir bun probe.ts [providerID/modelID]
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const out = process.env.OUT;
if (!out) throw new Error("set OUT to a scratch directory outside the repo");
const [providerID, modelID] = (process.argv[2] ?? "ollama/qwen3:14b").split(/\/(.*)/s);
const work = `${out}/work`;
const outside = `${out}/outside`;
mkdirSync(work, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(`${outside}/note.txt`, "outside the session directory\n");
writeFileSync(`${work}/inside.txt`, "inside the session directory\n");
const eventsFile = `${out}/events.jsonl`;
writeFileSync(eventsFile, "");

// Private server: a fresh password, never printed or stored.
const password = randomBytes(24).toString("base64url");
const server = Bun.spawn(["opencode", "serve", "--stdio", "--port", "0"], {
  env: { ...process.env, OPENCODE_PASSWORD: password },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
const reader = server.stdout.getReader();
let banner = "";
while (!banner.includes("\n")) {
  const { value, done } = await reader.read();
  if (done) throw new Error("server exited before printing its url");
  banner += new TextDecoder().decode(value);
}
const base = JSON.parse(banner.split("\n")[0]).url.replace(/\/$/, "");
const auth = { Authorization: `Basic ${btoa(`opencode:${password}`)}` };

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const info = await api("GET", "/api/info");
console.log("server", info.json?.data?.version ?? info.json?.version ?? info.json);

const models = (await api("GET", "/api/model")).json.data as any[];
const model = models.find((m) => m.providerID === providerID && (m.modelID === modelID || m.id === modelID));
if (!model) console.log(models.filter((m) => m.providerID === providerID).map((m) => [m.id, m.modelID, m.name, m.capabilities?.tools, m.variants?.map((v: any) => v.id)]));
if (!model) throw new Error(`no model ${providerID}/${modelID}`);
const variant = model.variants?.find((v: any) => v.id === "no-thinking")?.id;
console.log("model", model.providerID, model.modelID ?? model.id, "variant", variant, "tools", model.capabilities?.tools);

// Event stream, raw to file; shapes and order kept in memory.
const seen = new Map<string, { count: number; top: string[]; data: string[] }>();
const order: string[] = [];
let sessionID = "";
let idle: () => void;
const finished = new Promise<void>((resolve) => (idle = resolve));
const permissionsAsked: any[] = [];

(async () => {
  const response = await fetch(`${base}/api/event`, { headers: auth });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body!) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      appendFileSync(eventsFile, JSON.stringify(event) + "\n");
      const shape = seen.get(event.type) ?? { count: 0, top: Object.keys(event), data: Object.keys(event.data ?? {}) };
      shape.count++;
      seen.set(event.type, shape);
      if (order.at(-1) !== event.type) order.push(event.type);
      if (event.type === "permission.asked") {
        permissionsAsked.push({ action: event.data?.action, resources: event.data?.resources });
        // Nothing may be approved: reject anything the deny rules let through.
        api("POST", `/api/session/${event.data.sessionID}/permission/${event.data.id}/reply`, { decision: "reject" });
      }
      const sid = event.data?.sessionID;
      if (sessionID && sid === sessionID && /^session\.(idle|execution\.(succeeded|failed|interrupted))$/.test(event.type)) {
        idle();
      }
    }
  }
})();
await Bun.sleep(300);

const created = await api("POST", "/api/session", {
  title: "ssl-studio M0 probe",
  location: { directory: work },
  model: { providerID: model.providerID, id: model.modelID ?? model.id, ...(variant ? { variant } : {}) },
  permissions: ["shell", "webfetch", "websearch", "external_directory", "question"].map((action) => ({
    action,
    resource: "*",
    effect: "deny",
  })),
});
sessionID = created.json.data.id;
console.log("session created", created.status);

const started = Date.now();
const prompt = await api("POST", `/api/session/${sessionID}/prompt`, {
  text: process.env.DIRECT === "read"
    ? [
        "Call the execute tool once with exactly this code, then reply with its output verbatim and nothing else:",
        "```js",
        "console.log('opencode: ' + Object.keys(tools.opencode).join(', '));",
        "console.log('browser: ' + Object.keys(tools.browser).join(', '));",
        "for (const [name, file] of [",
        `  ['read-inside', '${work}/inside.txt'],`,
        `  ['read-outside', '${outside}/note.txt'],`,
        "]) {",
        "  for (const key of ['filePath', 'path']) {",
        "    try { console.log(name + ' ' + key + ' ok ' + JSON.stringify(await tools.opencode.read({ [key]: file })).slice(0, 200)); }",
        "    catch (e) { console.log(name + ' ' + key + ' error ' + String(e).slice(0, 300)); }",
        "  }",
        "}",
        "```",
      ].join("\n")
    : process.env.DIRECT
    ? // Second form: exact code for the execute tool, so the result does not
      // depend on how well a small model plans.
      [
        "Call the execute tool once with exactly this code, then reply with its output verbatim and nothing else:",
        "```js",
        "console.log('tools: ' + Object.keys(tools).join(', '));",
        "const checks = [",
        "  ['shell', () => tools.shell({ command: 'echo probe-shell' })],",
        "  ['bash', () => tools.bash({ command: 'echo probe-shell' })],",
        "  ['fetch', () => fetch('https://example.com').then((r) => r.status)],",
        `  ['read-inside', () => tools.read({ path: '${work}/inside.txt' })],`,
        `  ['read-outside', () => tools.read({ path: '${outside}/note.txt' })],`,
        "];",
        "for (const [name, run] of checks) {",
        "  try { console.log(name + ' ok ' + JSON.stringify(await run()).slice(0, 200)); }",
        "  catch (e) { console.log(name + ' error ' + String(e).slice(0, 300)); }",
        "}",
        "```",
      ].join("\n")
    : [
        "This is a permissions test. Try each step with your tools and report exactly what happened, including any error text:",
        "1. Run the shell command: echo probe-shell",
        "2. Fetch https://example.com",
        `3. Read the file ${outside}/note.txt`,
        "Then answer in one short paragraph.",
      ].join("\n"),
});
console.log("prompt", prompt.status, "returned keys", Object.keys(prompt.json?.data ?? {}));

const timeout = Bun.sleep(300_000).then(() => "timeout");
const outcome = await Promise.race([finished.then(() => "idle"), timeout]);
await Bun.sleep(1500); // let trailing events land
console.log("outcome", outcome, "after", Math.round((Date.now() - started) / 1000), "s");

const messages = (await api("GET", `/api/session/${sessionID}/message?limit=50&order=asc`)).json.data as any[];
writeFileSync(`${out}/messages.json`, JSON.stringify(messages, null, 2));
for (const m of messages) {
  if (m.type !== "assistant") {
    console.log("message", m.type, m.type === "idle" ? JSON.stringify({ outcome: m.outcome, error: m.error }) : "");
    continue;
  }
  console.log("assistant", JSON.stringify({ finish: m.finish, tokens: m.tokens, cost: m.cost, error: m.error }));
  for (const part of m.content ?? []) {
    if (part.type === "tool") {
      const state = part.state ?? {};
      console.log(
        "  tool",
        part.name,
        state.status ?? state.type ?? Object.keys(state),
        JSON.stringify(state.input ?? {}).slice(0, 160),
        String(state.error ?? state.output ?? "").slice(0, 240).replace(/\n/g, " "),
      );
    } else if (part.type === "text") {
      console.log("  text", part.text.slice(0, 600).replace(/\n/g, " "));
    } else {
      console.log("  part", part.type);
    }
  }
}

console.log("\npermission.asked", JSON.stringify(permissionsAsked));
console.log("\nevent order (runs collapsed):", order.join(" > "));
console.log("\nevent shapes:");
for (const [type, s] of seen) console.log(`  ${type} x${s.count}  top=[${s.top}]  data=[${s.data}]`);

await api("DELETE", `/api/session/${sessionID}`);
server.stdin.end();
await Promise.race([server.exited, Bun.sleep(5000)]);
server.kill();
process.exit(0);
