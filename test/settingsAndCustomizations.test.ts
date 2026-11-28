import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CustomizationsStore } from "../src/bun/customizations";
import { dirs } from "../src/bun/paths";
import { SettingsStore, USER_ONLY_SETTINGS } from "../src/bun/settings";
import {
	canonicalMcpSignature,
	customizationTemplate,
	mergeMcpIntoOpencodeConfig,
	parseCustomAgentDocument,
	parseInstructionDocument,
	parseMcpConfigJson,
	parsePromptFileDocument,
	parseSkillDocument,
	sanitizeCustomizationSlug,
	type McpServerEntry,
} from "../src/shared/agentCustomizations";
import { contrast, TEXT } from "../src/shared/contrast";
import { allOklchThemes } from "../src/shared/oklchTheme";
import {
	countModifiedSettings,
	isSettingDefinedInScope,
	parseSettingsQuery,
	SETTINGS_SCHEMA,
	SETTINGS_SCHEMA_MAP,
	settingMatchesQuery,
	settingScopeNote,
	USER_ONLY_SETTING_KEYS,
} from "../src/shared/settingsSchema";
import { ICON } from "../src/view/icons";
import { matchWords } from "../src/view/quickRank";
import dark from "../src/view/themes/studio-dark.json";
import light from "../src/view/themes/studio-light.json";

const rootTmp = mkdtempSync(join(tmpdir(), "ssl-settings-cust-"));
afterAll(() => {
	rmSync(rootTmp, { recursive: true, force: true });
});

const repoRead = (rel: string) => readFileSync(resolve(import.meta.dir, "..", rel), "utf8").replace(/\r\n/g, "\n");

function parseHex(h: string): [number, number, number] {
	return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function toHex(r: number, g: number, b: number): string {
	const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
	return `#${c(r)}${c(g)}${c(b)}`;
}
function mixSrgb(fg: string, pct: number, bg: string): string {
	const [r1, g1, b1] = parseHex(fg);
	const [r2, g2, b2] = parseHex(bg);
	const t = pct / 100;
	return toHex(r1 * t + r2 * (1 - t), g1 * t + g2 * (1 - t), b1 * t + b2 * (1 - t));
}

function withSandboxDirs<T>(fn: (env: { config: string; data: string; state: string; home: string; ws: string }) => Promise<T> | T): Promise<T> {
	const prev = { ...dirs };
	const box = mkdtempSync(join(rootTmp, "box-"));
	const config = join(box, "config");
	const data = join(box, "data");
	const state = join(box, "state");
	const home = join(box, "home");
	const ws = join(box, "ws");
	mkdirSync(config, { recursive: true });
	mkdirSync(data, { recursive: true });
	mkdirSync(state, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(ws, { recursive: true });
	dirs.config = config;
	dirs.data = data;
	dirs.state = state;
	return Promise.resolve()
		.then(() => fn({ config, data, state, home, ws }))
		.finally(() => {
			dirs.config = prev.config;
			dirs.data = prev.data;
			dirs.state = prev.state;
		});
}

describe("Declarative settings schema & raw JSON settings file APIs (ADR 0053)", () => {
	test("USER_ONLY_SETTING_KEYS stays strictly aligned with backend USER_ONLY_SETTINGS", () => {
		expect([...USER_ONLY_SETTING_KEYS].map(String).sort()).toEqual([...USER_ONLY_SETTINGS].sort());
	});

	test("parseSettingsQuery parses @modified, @user, @workspace, and @security filters alongside text", () => {
		expect(parseSettingsQuery("@modified font")).toEqual({
			raw: "@modified font",
			text: "font",
			modifiedOnly: true,
			scopeFilter: null,
			userOnly: false,
		});
		expect(parseSettingsQuery("@workspace @security lsp")).toEqual({
			raw: "@workspace @security lsp",
			text: "lsp",
			modifiedOnly: false,
			scopeFilter: "workspace",
			userOnly: true,
		});
		expect(parseSettingsQuery("  @USER  ")).toEqual({
			raw: "  @USER  ",
			text: "",
			modifiedOnly: false,
			scopeFilter: "user",
			userOnly: false,
		});
	});

	test("modified detection, counts, scope hints, and query filtering behave like VS Code", () => {
		const layers = {
			user: { fontSize: 15, lspPath: "/opt/starlims-lsp", keys: { "ctrl+j": "format" } },
			workspace: { fontSize: 16, wordWrap: true },
		};
		expect(isSettingDefinedInScope("fontSize", layers, "user")).toBe(true);
		expect(isSettingDefinedInScope("fontSize", layers, "workspace")).toBe(true);
		expect(isSettingDefinedInScope("minimap", layers, "user")).toBe(false);
		expect(countModifiedSettings(layers, "user")).toBe(3); // fontSize + lspPath + 1 key
		expect(countModifiedSettings(layers, "workspace")).toBe(2); // fontSize + wordWrap

		expect(settingScopeNote("fontSize", layers, "user", true)).toEqual({ text: "Also modified in Workspace", tone: "accent" });
		expect(settingScopeNote("fontSize", layers, "workspace", true)).toEqual({ text: "Overrides User setting", tone: "accent" });
		expect(settingScopeNote("lspPath", layers, "workspace", true)?.tone).toBe("lock");
		expect(settingScopeNote("minimap", layers, "user", true)).toBeNull();

		const modQuery = parseSettingsQuery("@modified");
		expect(settingMatchesQuery(SETTINGS_SCHEMA_MAP.get("wordWrap")!, modQuery, layers, "workspace", matchWords)).toBe(true);
		expect(settingMatchesQuery(SETTINGS_SCHEMA_MAP.get("minimap")!, modQuery, layers, "workspace", matchWords)).toBe(false);
		expect(SETTINGS_SCHEMA.some((s) => s.key === "agentModel" && s.category === "agent")).toBe(true);
		expect(SETTINGS_SCHEMA.some((s) => s.key === "limits" && s.category === "storage")).toBe(true);
	});

	test("SettingsStore readFile() and writeFile() validate JSON and strip USER_ONLY_SETTINGS in workspace scope", async () => {
		await withSandboxDirs(async ({ ws }) => {
			const store = new SettingsStore(() => ws);
			const initial = await store.readFile("workspace");
			expect(initial.exists).toBe(false);
			expect(initial.inWorkspace).toBe(true);
			expect(initial.text).toBe("{\n}\n");

			// Invalid JSON syntax reports line/column error.
			await expect(store.writeFile("user", '{\n  "fontSize": \n}')).rejects.toThrow(/Invalid JSON at line/);
			await expect(store.writeFile("user", "[1, 2]")).rejects.toThrow(/JSON object/);

			// Workspace save strips USER_ONLY_SETTINGS and returns stripped keys.
			const wsRes = await store.writeFile("workspace", JSON.stringify({ fontSize: 16, lspPath: "/evil/lsp", agentModel: "openai/gpt-4" }));
			expect(wsRes.strippedUserOnly.sort()).toEqual(["agentModel", "lspPath"]);
			expect(wsRes.effective.fontSize).toBe(16);
			expect(wsRes.effective.lspPath).toBeUndefined();

			// User save preserves USER_ONLY_SETTINGS cleanly.
			const userRes = await store.writeFile("user", JSON.stringify({ lspPath: "/usr/local/bin/starlims-lsp", agentModel: "ollama/qwen" }));
			expect(userRes.strippedUserOnly).toEqual([]);
			expect(userRes.effective.lspPath).toBe("/usr/local/bin/starlims-lsp");
			expect(userRes.effective.agentModel).toBe("ollama/qwen");
		});
	});
});

describe("Agent Customizations parsers, templates, discovery, and MCP trust security (ADR 0053)", () => {
	test("sanitizeCustomizationSlug blocks traversal and normalizes names safely", () => {
		expect(sanitizeCustomizationSlug("SSL SQL Audit")).toBe("ssl-sql-audit");
		expect(sanitizeCustomizationSlug("../../etc/passwd")).toBe("etc-passwd");
		expect(sanitizeCustomizationSlug("..")).toBe("");
		expect(sanitizeCustomizationSlug("   ")).toBe("");
	});

	test("parsers extract frontmatter from generated Skill, Custom Agent, Instruction, and Prompt templates", () => {
		const skillDoc = customizationTemplate({ kind: "skill", scope: "workspace", name: "Starlims Migration", description: "Check schema changes" });
		const skill = parseSkillDocument(skillDoc, "fallback");
		expect(skill.name).toBe("starlims-migration");
		expect(skill.description).toBe("Check schema changes");
		expect(skill.body).toContain("# Starlims Migration");

		const agentDoc = customizationTemplate({ kind: "agent", scope: "workspace", name: "SSL Reviewer", description: "Strict SSL reviews" });
		const agent = parseCustomAgentDocument(agentDoc, "fallback");
		expect(agent.name).toBe("SSL Reviewer");
		expect(agent.description).toBe("Strict SSL reviews");

		const ruleDoc = customizationTemplate({ kind: "instruction", scope: "workspace", name: "SQL Guards", applyTo: "**/*.sql" });
		const rule = parseInstructionDocument(ruleDoc, "sql-guards");
		expect(rule.applyTo).toBe("**/*.sql");
		expect(rule.lines).toBeGreaterThan(3);

		const promptDoc = customizationTemplate({ kind: "prompt", scope: "workspace", name: "Audit Rule" });
		const prompt = parsePromptFileDocument(promptDoc, "audit-rule");
		expect(prompt.command).toBe("/audit-rule");
		expect(prompt.title).toBe("Audit Rule");
	});

	test("parseMcpConfigJson supports VS Code servers and mcpServers formats while blocking prototype pollution", () => {
		const parsedA = parseMcpConfigJson(JSON.stringify({
			servers: {
				docs: { command: "npx", args: ["-y", "@org/docs-mcp"], allowTools: true },
				__proto__: { command: "evil" },
			},
		}));
		expect(Object.keys(parsedA)).toEqual(["docs"]);
		expect(parsedA.docs!.transport).toBe("stdio");
		expect(parsedA.docs!.allowTools).toBe(true);

		const parsedB = parseMcpConfigJson(JSON.stringify({
			mcpServers: {
				remoteApi: { type: "http", url: "https://mcp.internal.example/v1" },
			},
		}));
		expect(parsedB.remoteApi!.transport).toBe("http");
		expect(parsedB.remoteApi!.url).toBe("https://mcp.internal.example/v1");
	});

	test("mergeMcpIntoOpencodeConfig excludes untrusted and disabled servers and preserves existing provider config", () => {
		const entries: McpServerEntry[] = [
			{ id: "untrusted-ws", transport: "stdio", command: "node", args: ["evil.js"], scope: "workspace", sourceFile: "/ws/.ssl-studio/mcp.json", trusted: false, fingerprint: "a".repeat(64) },
			{ id: "disabled-user", transport: "http", url: "https://a.example", disabled: true, scope: "user", sourceFile: "/u/mcp.json", trusted: true, fingerprint: "b".repeat(64) },
			{ id: "trusted-docs", transport: "stdio", command: "bun", args: ["run", "docs-mcp"], allowTools: true, scope: "user", sourceFile: "/u/mcp.json", trusted: true, fingerprint: "c".repeat(64) },
		];
		const baseCfg = JSON.stringify({ provider: { ollama: { url: "http://127.0.0.1:11434" } } });
		const merged = mergeMcpIntoOpencodeConfig(baseCfg, entries);
		expect(merged.activeToolServers).toEqual(["trusted-docs"]);
		const parsed = JSON.parse(merged.configJson!);
		expect(parsed.provider.ollama.url).toBe("http://127.0.0.1:11434");
		expect(Object.keys(parsed.mcp)).toEqual(["trusted-docs"]);
		expect(parsed.mcp["trusted-docs"].command).toEqual(["bun", "run", "docs-mcp"]);

		// When all servers are untrusted or disabled, base config is untouched and zero MCP tools are enabled.
		const none = mergeMcpIntoOpencodeConfig(baseCfg, [entries[0]!, entries[1]!]);
		expect(none.configJson).toBe(baseCfg);
		expect(none.activeToolServers).toEqual([]);
	});

	test("CustomizationsStore discovers all 5 kinds, enforces allowed path confinement, and revokes MCP trust on tamper", async () => {
		await withSandboxDirs(async ({ home, ws }) => {
			writeFileSync(join(ws, "AGENTS.md"), "# Project Instructions\nAlways verify diffs.\n");
			mkdirSync(join(ws, "docs", "knowledge", "prompts"), { recursive: true });
			writeFileSync(join(ws, "docs", "knowledge", "prompts", "check-nulls.md"), "# Check Null Guards\nInspect all IIF calls.\n");

			const store = new CustomizationsStore(() => ws, () => home);

			// Create workspace skill, user custom agent, workspace rule, and user prompt.
			const createdSkill = await store.create({ kind: "skill", scope: "workspace", name: "ssl-guards", description: "Null guard rules" });
			const createdAgent = await store.create({ kind: "agent", scope: "user", name: "GxP Auditor", description: "Compliance checks" });
			await store.create({ kind: "instruction", scope: "workspace", name: "ssl-sql", applyTo: "**/*.sql" });
			await store.create({ kind: "prompt", scope: "user", name: "quick-audit" });

			// Add User MCP server (trusted automatically) and Workspace MCP server (UNTRUSTED by default!).
			await store.saveMcpServer("user", { id: "local-ref", transport: "http", url: "https://ref.local/mcp", allowTools: true });
			await store.saveMcpServer("workspace", { id: "ws-runner", transport: "stdio", command: "bun", args: ["run", "mcp.ts"], allowTools: true });

			const snap1 = store.list();
			expect(snap1.instructions.map((i) => i.name)).toContain("AGENTS.md");
			expect(snap1.instructions.some((i) => i.applyTo === "**/*.sql")).toBe(true);
			expect(snap1.skills.map((s) => s.name)).toEqual(["ssl-guards"]);
			expect(snap1.agents.map((a) => a.name)).toEqual(["GxP Auditor"]);
			expect(snap1.prompts.map((p) => p.command)).toContain("/check-nulls");
			expect(snap1.prompts.map((p) => p.command)).toContain("/quick-audit");

			const userMcp = snap1.mcpServers.find((m) => m.id === "local-ref")!;
			const wsMcp1 = snap1.mcpServers.find((m) => m.id === "ws-runner")!;
			expect(userMcp.trusted).toBe(true);
			expect(wsMcp1.trusted).toBe(false);

			// Explicitly trust workspace MCP server fingerprint.
			await store.setMcpTrust(wsMcp1.id, wsMcp1.fingerprint, true);
			const wsMcpTrusted = store.list().mcpServers.find((m) => m.id === "ws-runner")!;
			expect(wsMcpTrusted.trusted).toBe(true);

			// Tampering with workspace mcp.json args MUST invalidate the fingerprint and revoke trust automatically!
			await store.saveMcpServer("workspace", { id: "ws-runner", transport: "stdio", command: "bun", args: ["run", "tampered.ts"], allowTools: true });
			const wsMcpTampered = store.list().mcpServers.find((m) => m.id === "ws-runner")!;
			expect(wsMcpTampered.fingerprint).not.toBe(wsMcp1.fingerprint);
			expect(wsMcpTampered.trusted).toBe(false);
			expect(canonicalMcpSignature(ws, wsMcpTampered)).toContain("tampered.ts");

			// Path confinement rejects reading/saving/deleting files outside allowed customization directories.
			expect(() => store.read("/etc/passwd")).toThrow(/outside allowed customization folders/);
			await expect(store.save(join(ws, "Secret.ssl"), "x")).rejects.toThrow(/outside allowed customization folders/);
			await expect(store.remove(join(ws, "AGENTS.md"))).resolves.toBe(true);

			// Deleting SKILL.md removes its dedicated skill folder cleanly.
			expect(await store.remove(createdSkill.path)).toBe(true);
			expect(existsSync(join(ws, ".agents", "skills", "ssl-guards"))).toBe(false);

			// Reading and editing user agent works safely inside user config dir.
			const readAgent = store.read(createdAgent.path);
			expect(readAgent.scope).toBe("user");
			await store.save(createdAgent.path, readAgent.text + "\n- Extra rule\n");
			expect(store.read(createdAgent.path).text).toContain("Extra rule");
		});
	});
});

describe("Settings & Agent Customizations — 27-theme WCAG AA contrast & wiring", () => {
	test("all Settings and Customizations pills, banners, and active controls pass WCAG AA (>= 4.5:1) across all 27 built-in themes", () => {
		const allThemes = [
			...allOklchThemes().map((t) => ({ name: t.name, s: t.studio })),
			...(
				[
					["Classic Dark", dark],
					["Classic Light", light],
				] as const
			).map(([name, t]) => ({
				name,
				s: {
					sideBg: t.colors["sideBar.background"]!,
					fg: t.colors["sideBar.foreground"]!,
					strongFg: t.colors["tab.activeForeground"]!,
					accent: t.colors["focusBorder"]!,
					buttonBg: t.colors["button.background"]!,
					buttonFg: t.colors["button.foreground"]!,
					warning: t.colors["editorWarning.foreground"]!,
					error: t.colors["editorError.foreground"]!,
					ok: t.colors["testing.iconPassed"]!,
				},
			})),
		];
		expect(allThemes.length).toBe(27);

		for (const { name, s } of allThemes) {
			expect(contrast(s.buttonFg, s.buttonBg), `${name} active tab/toggle/primary button`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.accent, 16, s.sideBg)), `${name} accent pill`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.warning, 16, s.sideBg)), `${name} lock/trust-required pill`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.ok, 16, s.sideBg)), `${name} trusted ok pill`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.warning, 12, s.sideBg)), `${name} security lock banner`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.error, 12, s.sideBg)), `${name} error alert banner`).toBeGreaterThanOrEqual(TEXT);
		}
	});

	test("Codicons, App centerView tabs, and Agent panel composer integrations are wired cleanly", () => {
		for (const name of ["extensions", "file-code", "globe", "hubot", "json", "keyboard", "lock", "plug", "shield", "terminal", "unlock"] as const) {
			expect(ICON[name]).toBeTruthy();
		}
		const appSrc = repoRead("src/view/App.tsx");
		expect(appSrc).toContain('state.centerView === "settings"');
		expect(appSrc).toContain('state.centerView === "customizations"');
		expect(appSrc).toContain("<SettingsView />");
		expect(appSrc).toContain("<CustomizationsView />");
		expect(appSrc).toContain("<CustomizationsHost />");

		const agentSrc = repoRead("src/view/agent/Agent.tsx");
		expect(agentSrc).toContain('openCustomizations("skills")');
		expect(agentSrc).toContain("+ Skill…");
		expect(agentSrc).toContain("pickSkill");
		expect(agentSrc).toContain("pickCustomAgent");
	});
});
