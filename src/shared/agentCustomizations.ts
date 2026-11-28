// Shared types, frontmatter parsers, templates, and MCP trust helpers for
// VS Code-aligned Agent Customizations (Instructions, Skills, Custom Agents,
// Prompt Files, and MCP Servers — ADR 0053).
import { frontMatter } from "./frontMatter";

export type CustomizationScope = "workspace" | "user";
export type CustomizationKind = "instruction" | "skill" | "agent" | "prompt";

export type InstructionItem = {
	id: string;
	name: string;
	path: string;
	relPath: string;
	scope: CustomizationScope;
	kind: "agents-md" | "rule" | "copilot-instructions";
	applyTo?: string;
	description?: string;
	lines: number;
	size: number;
};

export type SkillItem = {
	id: string;
	name: string;
	description: string;
	path: string;
	dirPath: string;
	relPath: string;
	scope: CustomizationScope;
	source: "agents" | "ssl-studio" | "github";
	hasScripts: boolean;
	hasReferences: boolean;
};

export type CustomAgentItem = {
	id: string;
	name: string;
	description: string;
	path: string;
	relPath: string;
	scope: CustomizationScope;
	source: "agents" | "ssl-studio" | "github";
	model?: string;
	skills: string[];
	tools: string[];
};

export type PromptFileItem = {
	id: string;
	name: string;
	title: string;
	command: string;
	description: string;
	path: string;
	relPath: string;
	scope: CustomizationScope;
	source: "knowledge" | "agents" | "ssl-studio" | "github";
};

export type McpTransport = "stdio" | "http" | "sse";

export type McpServerConfig = {
	id: string;
	transport: McpTransport;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	disabled?: boolean;
	allowTools?: boolean;
};

export type McpServerEntry = McpServerConfig & {
	scope: CustomizationScope;
	sourceFile: string;
	trusted: boolean;
	trustReason?: string;
	fingerprint: string;
};

export type AgentCustomizationsSnapshot = {
	instructions: InstructionItem[];
	skills: SkillItem[];
	agents: CustomAgentItem[];
	prompts: PromptFileItem[];
	mcpServers: McpServerEntry[];
	paths: {
		userDir: string;
		userMcp: string;
		workspaceDir?: string;
		workspaceMcp?: string;
	};
};

export type CreateCustomizationRequest = {
	kind: CustomizationKind;
	scope: CustomizationScope;
	name: string;
	description?: string;
	applyTo?: string;
};

/** Normalizes a customization name into a safe lowercase kebab-case slug (prevents path traversal). */
export function sanitizeCustomizationSlug(raw: string): string {
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	if (!cleaned || cleaned === "." || cleaned === "..") return "";
	return cleaned;
}

function firstString(value: string | string[] | undefined): string {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) return String(value[0] ?? "").trim();
	return "";
}

function stringList(value: string | string[] | undefined): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	if (typeof value === "string") {
		return value
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
	}
	return [];
}

function firstHeading(body: string): string {
	const m = /^\s*#\s+(.+?)\s*$/m.exec(body);
	return m?.[1]?.trim() ?? "";
}

function firstSummaryLine(body: string): string {
	for (const line of body.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#") || t.startsWith("<!--") || t.startsWith(">") || t.startsWith("```") || t.startsWith("---")) continue;
		return t.slice(0, 160);
	}
	return "";
}

/** Parses `SKILL.md` frontmatter and body into structured skill metadata (`agentskills.io` standard). */
export function parseSkillDocument(text: string, fallbackName: string): { name: string; description: string; body: string } {
	const parsed = frontMatter(text);
	const name = firstString(parsed.values.name) || fallbackName;
	const description = firstString(parsed.values.description) || firstSummaryLine(parsed.body) || "No description provided.";
	return { name, description, body: parsed.body.trim() };
}

/** Parses `*.agent.md` frontmatter (name, description, preferred model, attached skills, tools). */
export function parseCustomAgentDocument(
	text: string,
	fallbackName: string,
): { name: string; description: string; model?: string; skills: string[]; tools: string[]; body: string } {
	const parsed = frontMatter(text);
	const name = firstString(parsed.values.name) || firstHeading(parsed.body) || fallbackName;
	const description = firstString(parsed.values.description) || firstSummaryLine(parsed.body) || "Custom agent persona.";
	const model = firstString(parsed.values.model) || undefined;
	const skills = stringList(parsed.values.skills);
	const tools = stringList(parsed.values.tools);
	return { name, description, ...(model ? { model } : {}), skills, tools, body: parsed.body.trim() };
}

/** Parses an instruction/rule file (`AGENTS.md`, `.agents/rules/*.md`, `*.instructions.md`). */
export function parseInstructionDocument(
	text: string,
	fallbackName: string,
): { name: string; applyTo?: string; description?: string; lines: number } {
	const parsed = frontMatter(text);
	const name = firstString(parsed.values.name) || firstHeading(parsed.body) || fallbackName;
	const applyTo = firstString(parsed.values.applyto ?? parsed.values["apply-to"] ?? parsed.values.globs) || undefined;
	const description = firstString(parsed.values.description) || firstSummaryLine(parsed.body) || undefined;
	const lines = text ? text.replace(/\r\n?/g, "\n").split("\n").length : 0;
	return { name, ...(applyTo ? { applyTo } : {}), ...(description ? { description } : {}), lines };
}

/** Parses a prompt file (`*.prompt.md` or `docs/knowledge/prompts/*.md`) into title, slash command, and body. */
export function parsePromptFileDocument(
	text: string,
	fallbackSlug: string,
): { title: string; command: string; description: string; body: string } {
	const parsed = frontMatter(text);
	const rawName = firstString(parsed.values.name) || fallbackSlug;
	const slug = sanitizeCustomizationSlug(rawName) || sanitizeCustomizationSlug(fallbackSlug) || "prompt";
	const title = firstString(parsed.values.title) || firstHeading(parsed.body) || rawName;
	const description = firstString(parsed.values.description) || firstSummaryLine(parsed.body) || "";
	const body = parsed.body.replace(/^\s*#\s+[^\r\n]+\r?\n+/, "").trim();
	return { title, command: `/${slug}`, description, body };
}

/** Canonical serialization used to fingerprint a workspace MCP server for tamper-evident trust verification. */
export function canonicalMcpSignature(workspaceRoot: string, server: McpServerConfig): string {
	const envEntries = server.env
		? Object.entries(server.env)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, v])
		: [];
	const headerEntries = server.headers
		? Object.entries(server.headers)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, v])
		: [];
	return JSON.stringify({
		v: 1,
		root: workspaceRoot,
		id: server.id,
		transport: server.transport,
		command: server.command ?? "",
		args: server.args ?? [],
		env: envEntries,
		url: server.url ?? "",
		headers: headerEntries,
	});
}

/** Parses a `mcp.json` document supporting both `{ "servers": { ... } }` (VS Code) and `{ "mcpServers": { ... } }` (standard). */
export function parseMcpConfigJson(text: string): Record<string, McpServerConfig> {
	if (!text.trim()) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const obj = raw as Record<string, unknown>;
	const table =
		(obj.servers && typeof obj.servers === "object" && !Array.isArray(obj.servers) ? obj.servers : null) ??
		(obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers) ? obj.mcpServers : null);
	if (!table) return {};

	const out: Record<string, McpServerConfig> = {};
	for (const [id, entry] of Object.entries(table as Record<string, unknown>)) {
		if (!id.trim() || id === "__proto__" || id === "constructor" || id === "prototype") continue;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const rec = entry as Record<string, unknown>;
		const command = typeof rec.command === "string" && rec.command.trim() ? rec.command.trim() : undefined;
		const url = typeof rec.url === "string" && rec.url.trim() ? rec.url.trim() : undefined;
		const rawType = typeof rec.type === "string" ? rec.type.toLowerCase() : typeof rec.transport === "string" ? rec.transport.toLowerCase() : "";
		const transport: McpTransport =
			rawType === "http" || rawType === "streamable-http"
				? "http"
				: rawType === "sse"
					? "sse"
					: command
						? "stdio"
						: url
							? "http"
							: "stdio";
		const args = Array.isArray(rec.args) ? rec.args.filter((a): a is string => typeof a === "string") : undefined;
		const env =
			rec.env && typeof rec.env === "object" && !Array.isArray(rec.env)
				? Object.fromEntries(Object.entries(rec.env).filter(([, v]) => typeof v === "string") as [string, string][])
				: undefined;
		const headers =
			rec.headers && typeof rec.headers === "object" && !Array.isArray(rec.headers)
				? Object.fromEntries(Object.entries(rec.headers).filter(([, v]) => typeof v === "string") as [string, string][])
				: undefined;
		out[id.trim()] = {
			id: id.trim(),
			transport,
			...(command ? { command } : {}),
			...(args?.length ? { args } : {}),
			...(env && Object.keys(env).length ? { env } : {}),
			...(url ? { url } : {}),
			...(headers && Object.keys(headers).length ? { headers } : {}),
			...(rec.disabled === true ? { disabled: true } : {}),
			...(rec.allowTools === true ? { allowTools: true } : {}),
		};
	}
	return out;
}

/** Merges trusted, enabled MCP servers into an `OPENCODE_CONFIG_CONTENT` JSON string without mutating global opencode config. */
export function mergeMcpIntoOpencodeConfig(
	baseConfigJson: string | undefined,
	servers: readonly McpServerEntry[],
): { configJson: string | undefined; activeToolServers: string[] } {
	const active = servers.filter((s) => s.trusted && !s.disabled);
	if (!active.length) {
		return { configJson: baseConfigJson, activeToolServers: [] };
	}
	let base: Record<string, unknown> = {};
	if (baseConfigJson?.trim()) {
		try {
			const parsed = JSON.parse(baseConfigJson);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				base = { ...(parsed as Record<string, unknown>) };
			}
		} catch {
			// Preserve raw baseConfigJson untouched if it isn't valid JSON.
			return { configJson: baseConfigJson, activeToolServers: [] };
		}
	}
	const existingMcp =
		base.mcp && typeof base.mcp === "object" && !Array.isArray(base.mcp)
			? { ...(base.mcp as Record<string, unknown>) }
			: {};
	const activeToolServers: string[] = [];
	for (const server of active) {
		if (server.transport === "stdio" && server.command) {
			existingMcp[server.id] = {
				type: "local",
				command: [server.command, ...(server.args ?? [])],
				...(server.env && Object.keys(server.env).length ? { environment: server.env } : {}),
				enabled: true,
			};
			if (server.allowTools) activeToolServers.push(server.id);
		} else if ((server.transport === "http" || server.transport === "sse") && server.url) {
			existingMcp[server.id] = {
				type: "remote",
				url: server.url,
				...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
				enabled: true,
			};
			if (server.allowTools) activeToolServers.push(server.id);
		}
	}
	if (!Object.keys(existingMcp).length) {
		return { configJson: baseConfigJson, activeToolServers };
	}
	base.mcp = existingMcp;
	return { configJson: JSON.stringify(base), activeToolServers };
}

/** Generates a clean starter template when creating a new customization file from the UI. */
export function customizationTemplate(req: CreateCustomizationRequest): string {
	const slug = sanitizeCustomizationSlug(req.name) || "custom";
	const title = req.name.trim() || slug;
	const desc = req.description?.trim();
	switch (req.kind) {
		case "skill":
			return [
				"---",
				`name: ${slug}`,
				`description: ${desc || "Describe what this skill helps with and when the agent should use it."}`,
				"---",
				"",
				`# ${title}`,
				"",
				"## When to use",
				"",
				"- State the STARLIMS or workspace task this skill covers.",
				"",
				"## Steps",
				"",
				"1. Inspect the relevant scripts, tables, or docs first.",
				"2. Follow project conventions and verify before finishing.",
				"",
			].join("\n");
		case "agent":
			return [
				"---",
				`name: ${title}`,
				`description: ${desc || "Specialized agent persona for focused STARLIMS development tasks."}`,
				"skills: []",
				"tools: []",
				"---",
				"",
				`# ${title}`,
				"",
				"You are a focused specialist assistant working inside SSL Studio.",
				"",
				"## Priorities",
				"",
				"- Preserve text as the source of truth and propose clean, minimal diffs.",
				"- Explain assumptions and point out edge cases or missing context.",
				"",
			].join("\n");
		case "instruction":
			return [
				"---",
				`description: ${desc || "Project coding standard or workflow guideline."}`,
				...(req.applyTo?.trim() ? [`applyTo: "${req.applyTo.trim()}"`] : []),
				"---",
				"",
				`# ${title}`,
				"",
				"- Write concise, enforceable instructions for the agent.",
				"",
			].join("\n");
		case "prompt":
			return [
				"---",
				`name: ${slug}`,
				`title: ${title}`,
				`description: ${desc || "Reusable prompt template invoked with /" + slug + "."}`,
				"---",
				"",
				`# ${title}`,
				"",
				"Review the active script and summarize:",
				"1. Input validation and error handling gaps",
				"2. Potential SQL or null-handling risks",
				"3. Concrete improvements matching house style",
				"",
			].join("\n");
	}
}
