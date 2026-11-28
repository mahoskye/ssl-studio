// Backend discovery, safe read/write/create/delete, and MCP trust management
// for VS Code-aligned Agent Customizations (ADR 0053).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
	canonicalMcpSignature,
	customizationTemplate,
	parseCustomAgentDocument,
	parseInstructionDocument,
	parseMcpConfigJson,
	parsePromptFileDocument,
	parseSkillDocument,
	sanitizeCustomizationSlug,
	type AgentCustomizationsSnapshot,
	type CreateCustomizationRequest,
	type CustomAgentItem,
	type CustomizationScope,
	type InstructionItem,
	type McpServerConfig,
	type McpServerEntry,
	type PromptFileItem,
	type SkillItem,
} from "../shared/agentCustomizations";
import { renameReplacing } from "./atomic";
import { dirs } from "./paths";
import { Serial } from "./serial";

const MAX_FILE_BYTES = 512 * 1024;
const mcpSerial = new Serial();
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function fold(p: string): string {
	return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

function isInsideDir(root: string, candidate: string): boolean {
	const r = resolve(root);
	const c = resolve(candidate);
	const fr = fold(r);
	const fc = fold(c);
	return fc === fr || fc.startsWith(fr.endsWith(sep) ? fr : fr + sep);
}

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function readTextSafe(filePath: string): { text: string; size: number } | null {
	try {
		const st = statSync(filePath);
		if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
		return { text: readFileSync(filePath, "utf8"), size: st.size };
	} catch {
		return null;
	}
}

async function atomicWriteText(target: string, text: string): Promise<void> {
	mkdirSync(dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await Bun.write(temp, text);
		await renameReplacing(temp, target);
	} catch (err) {
		try {
			rmSync(temp, { force: true });
		} catch {
			// Best-effort temp cleanup.
		}
		throw err;
	}
}

function listMarkdownFiles(dir: string, suffix = ".md"): string[] {
	if (!existsSync(dir)) return [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		if (!e.isFile()) continue;
		if (!e.name.toLowerCase().endsWith(suffix)) continue;
		out.push(join(dir, e.name));
	}
	return out.sort((a, b) => a.localeCompare(b));
}

export class CustomizationsStore {
	constructor(
		private readonly getRoot: () => string | null,
		private readonly getHome: () => string = homedir,
	) {}

	private userConfigDir(): string {
		return dirs.config;
	}

	private userAgentsDir(): string {
		return join(this.getHome(), ".agents");
	}

	private userMcpPath(): string {
		return join(this.userConfigDir(), "mcp.json");
	}

	private userMcpTrustPath(): string {
		return join(this.userConfigDir(), "mcp-trust.json");
	}

	private workspaceMcpPath(root: string): string {
		return join(root, ".ssl-studio", "mcp.json");
	}

	private allowedRoots(): Array<{ dir: string; scope: CustomizationScope }> {
		const userBase = this.userConfigDir();
		const homeAgents = this.userAgentsDir();
		const list: Array<{ dir: string; scope: CustomizationScope }> = [
			{ dir: join(userBase, "skills"), scope: "user" },
			{ dir: join(userBase, "agents"), scope: "user" },
			{ dir: join(userBase, "prompts"), scope: "user" },
			{ dir: join(userBase, "rules"), scope: "user" },
			{ dir: join(homeAgents, "skills"), scope: "user" },
			{ dir: join(homeAgents, "agents"), scope: "user" },
			{ dir: join(homeAgents, "prompts"), scope: "user" },
			{ dir: join(homeAgents, "rules"), scope: "user" },
		];
		const root = this.getRoot();
		if (root) {
			list.push(
				{ dir: join(root, "AGENTS.md"), scope: "workspace" },
				{ dir: join(root, ".agents"), scope: "workspace" },
				{ dir: join(root, ".github"), scope: "workspace" },
				{ dir: join(root, "docs", "knowledge", "prompts"), scope: "workspace" },
			);
		}
		return list;
	}

	private resolveAllowedPath(rawPath: string): { path: string; scope: CustomizationScope } {
		const resolved = resolve(rawPath);
		for (const root of this.allowedRoots()) {
			if (isInsideDir(root.dir, resolved)) {
				return { path: resolved, scope: root.scope };
			}
		}
		throw new Error(`Path is outside allowed customization folders: ${rawPath}`);
	}

	private readTrustMap(): Record<string, string> {
		const raw = readTextSafe(this.userMcpTrustPath());
		if (!raw) return {};
		try {
			const parsed = JSON.parse(raw.text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) out[k] = v;
			}
			return out;
		} catch {
			return {};
		}
	}

	private trustKey(root: string, serverId: string): string {
		const normRoot = toPosix(resolve(root)).replace(/\/+$/, "");
		return `${sha256(CASE_INSENSITIVE ? normRoot.toLowerCase() : normRoot).slice(0, 16)}:${serverId}`;
	}

	private collectSkills(
		baseDir: string,
		scope: CustomizationScope,
		source: SkillItem["source"],
		relBase: string,
		seen: Set<string>,
		out: SkillItem[],
	): void {
		if (!existsSync(baseDir)) return;
		let dirsList;
		try {
			dirsList = readdirSync(baseDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of dirsList) {
			if (!entry.isDirectory()) continue;
			const dirPath = join(baseDir, entry.name);
			const skillFile = join(dirPath, "SKILL.md");
			const content = readTextSafe(skillFile);
			if (!content) continue;
			const dedupKey = `${scope}:${fold(resolve(skillFile))}`;
			if (seen.has(dedupKey)) continue;
			seen.add(dedupKey);
			const parsed = parseSkillDocument(content.text, entry.name);
			out.push({
				id: `${scope}:${source}:${parsed.name}`,
				name: parsed.name,
				description: parsed.description,
				path: skillFile,
				dirPath,
				relPath: toPosix(relative(relBase, skillFile)),
				scope,
				source,
				hasScripts: existsSync(join(dirPath, "scripts")),
				hasReferences: existsSync(join(dirPath, "references")),
			});
		}
	}

	private collectAgents(
		baseDir: string,
		scope: CustomizationScope,
		source: CustomAgentItem["source"],
		relBase: string,
		seen: Set<string>,
		out: CustomAgentItem[],
	): void {
		for (const file of listMarkdownFiles(baseDir, ".md")) {
			const low = basename(file).toLowerCase();
			if (low === "readme.md" || low === "index.md") continue;
			const content = readTextSafe(file);
			if (!content) continue;
			const dedupKey = `${scope}:${fold(resolve(file))}`;
			if (seen.has(dedupKey)) continue;
			seen.add(dedupKey);
			const stem = basename(file).replace(/\.agent\.md$/i, "").replace(/\.md$/i, "");
			const parsed = parseCustomAgentDocument(content.text, stem);
			out.push({
				id: `${scope}:${source}:${stem}`,
				name: parsed.name,
				description: parsed.description,
				path: file,
				relPath: toPosix(relative(relBase, file)),
				scope,
				source,
				...(parsed.model ? { model: parsed.model } : {}),
				skills: parsed.skills,
				tools: parsed.tools,
			});
		}
	}

	private collectPrompts(
		baseDir: string,
		scope: CustomizationScope,
		source: PromptFileItem["source"],
		relBase: string,
		seen: Set<string>,
		out: PromptFileItem[],
	): void {
		for (const file of listMarkdownFiles(baseDir, ".md")) {
			const low = basename(file).toLowerCase();
			if (low === "readme.md" || low === "index.md") continue;
			const content = readTextSafe(file);
			if (!content) continue;
			const dedupKey = `${scope}:${fold(resolve(file))}`;
			if (seen.has(dedupKey)) continue;
			seen.add(dedupKey);
			const stem = basename(file).replace(/\.prompt\.md$/i, "").replace(/\.md$/i, "");
			const parsed = parsePromptFileDocument(content.text, stem);
			out.push({
				id: `${scope}:${source}:${stem}`,
				name: stem,
				title: parsed.title,
				command: parsed.command,
				description: parsed.description,
				path: file,
				relPath: toPosix(relative(relBase, file)),
				scope,
				source,
			});
		}
	}

	private collectInstructions(root: string | null): InstructionItem[] {
		const out: InstructionItem[] = [];
		const addFile = (filePath: string, scope: CustomizationScope, kind: InstructionItem["kind"], relBase: string) => {
			const content = readTextSafe(filePath);
			if (!content) return;
			const stem = basename(filePath).replace(/\.instructions\.md$/i, "").replace(/\.md$/i, "");
			const parsed = parseInstructionDocument(content.text, basename(filePath));
			out.push({
				id: `${scope}:${toPosix(relative(relBase, filePath))}`,
				name: kind === "agents-md" ? "AGENTS.md" : kind === "copilot-instructions" ? "copilot-instructions.md" : parsed.name || stem,
				path: filePath,
				relPath: toPosix(relative(relBase, filePath)),
				scope,
				kind,
				...(parsed.applyTo ? { applyTo: parsed.applyTo } : {}),
				...(parsed.description ? { description: parsed.description } : {}),
				lines: parsed.lines,
				size: content.size,
			});
		};

		if (root) {
			addFile(join(root, "AGENTS.md"), "workspace", "agents-md", root);
			addFile(join(root, ".github", "copilot-instructions.md"), "workspace", "copilot-instructions", root);
			for (const file of listMarkdownFiles(join(root, ".agents", "rules"), ".md")) {
				addFile(file, "workspace", "rule", root);
			}
			for (const file of listMarkdownFiles(join(root, ".github", "instructions"), ".md")) {
				addFile(file, "workspace", "rule", root);
			}
		}

		const userBase = this.userConfigDir();
		for (const file of listMarkdownFiles(join(userBase, "rules"), ".md")) {
			addFile(file, "user", "rule", userBase);
		}
		return out;
	}

	private collectMcpServers(root: string | null): McpServerEntry[] {
		const out: McpServerEntry[] = [];
		const trustMap = this.readTrustMap();
		const userMcpPath = this.userMcpPath();
		const userText = readTextSafe(userMcpPath);
		if (userText) {
			const parsed = parseMcpConfigJson(userText.text);
			for (const cfg of Object.values(parsed)) {
				const fingerprint = sha256(canonicalMcpSignature("user", cfg));
				out.push({
					...cfg,
					scope: "user",
					sourceFile: userMcpPath,
					trusted: true,
					fingerprint,
				});
			}
		}

		if (root) {
			const seenWs = new Set<string>();
			const wsCandidates = [this.workspaceMcpPath(root), join(root, ".mcp.json")];
			for (const file of wsCandidates) {
				const text = readTextSafe(file);
				if (!text) continue;
				const parsed = parseMcpConfigJson(text.text);
				for (const cfg of Object.values(parsed)) {
					if (seenWs.has(cfg.id)) continue;
					seenWs.add(cfg.id);
					const fingerprint = sha256(canonicalMcpSignature(resolve(root), cfg));
					const trusted = trustMap[this.trustKey(root, cfg.id)] === fingerprint;
					out.push({
						...cfg,
						scope: "workspace",
						sourceFile: file,
						trusted,
						...(!trusted
							? {
									trustReason:
										cfg.transport === "stdio"
											? "Workspace stdio command requires explicit user trust before running."
											: "Workspace remote MCP server requires explicit user trust before connecting.",
								}
							: {}),
						fingerprint,
					});
				}
			}
		}

		return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
	}

	/** Discovers all instructions, skills, custom agents, prompt files, and MCP servers across workspace and user scopes. */
	list(): AgentCustomizationsSnapshot {
		const root = this.getRoot();
		const userBase = this.userConfigDir();
		const homeAgents = this.userAgentsDir();

		const skills: SkillItem[] = [];
		const seenSkills = new Set<string>();
		if (root) {
			this.collectSkills(join(root, ".agents", "skills"), "workspace", "agents", root, seenSkills, skills);
			this.collectSkills(join(root, ".github", "skills"), "workspace", "github", root, seenSkills, skills);
		}
		this.collectSkills(join(userBase, "skills"), "user", "ssl-studio", userBase, seenSkills, skills);
		this.collectSkills(join(homeAgents, "skills"), "user", "agents", homeAgents, seenSkills, skills);
		skills.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));

		const agents: CustomAgentItem[] = [];
		const seenAgents = new Set<string>();
		if (root) {
			this.collectAgents(join(root, ".agents", "agents"), "workspace", "agents", root, seenAgents, agents);
			this.collectAgents(join(root, ".github", "agents"), "workspace", "github", root, seenAgents, agents);
		}
		this.collectAgents(join(userBase, "agents"), "user", "ssl-studio", userBase, seenAgents, agents);
		this.collectAgents(join(homeAgents, "agents"), "user", "agents", homeAgents, seenAgents, agents);
		agents.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));

		const prompts: PromptFileItem[] = [];
		const seenPrompts = new Set<string>();
		if (root) {
			this.collectPrompts(join(root, "docs", "knowledge", "prompts"), "workspace", "knowledge", root, seenPrompts, prompts);
			this.collectPrompts(join(root, ".agents", "prompts"), "workspace", "agents", root, seenPrompts, prompts);
			this.collectPrompts(join(root, ".github", "prompts"), "workspace", "github", root, seenPrompts, prompts);
		}
		this.collectPrompts(join(userBase, "prompts"), "user", "ssl-studio", userBase, seenPrompts, prompts);
		this.collectPrompts(join(homeAgents, "prompts"), "user", "agents", homeAgents, seenPrompts, prompts);
		prompts.sort((a, b) => a.scope.localeCompare(b.scope) || a.command.localeCompare(b.command));

		const instructions = this.collectInstructions(root);
		const mcpServers = this.collectMcpServers(root);

		return {
			instructions,
			skills,
			agents,
			prompts,
			mcpServers,
			paths: {
				userDir: userBase,
				userMcp: this.userMcpPath(),
				...(root ? { workspaceDir: join(root, ".agents"), workspaceMcp: this.workspaceMcpPath(root) } : {}),
			},
		};
	}

	/** Reads a customization file inside an allowed customization root. */
	read(rawPath: string): { path: string; text: string; scope: CustomizationScope } {
		const { path, scope } = this.resolveAllowedPath(rawPath);
		const content = readTextSafe(path);
		if (!content) throw new Error(`Customization file could not be read: ${basename(path)}`);
		return { path, text: content.text, scope };
	}

	/** Atomically saves edits to an existing customization file inside an allowed customization root. */
	async save(rawPath: string, text: string): Promise<void> {
		const { path } = this.resolveAllowedPath(rawPath);
		if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
			throw new Error("Customization file exceeds maximum size (512 KB).");
		}
		await atomicWriteText(path, text);
	}

	/** Creates a new skill, custom agent, instruction rule, or prompt file from a clean template. */
	async create(req: CreateCustomizationRequest): Promise<{ path: string }> {
		const slug = sanitizeCustomizationSlug(req.name);
		if (!slug) throw new Error("Enter a valid name containing letters or numbers.");
		const root = this.getRoot();
		if (req.scope === "workspace" && !root) {
			throw new Error("Open a workspace folder first to create a workspace customization.");
		}
		const base = req.scope === "workspace" ? join(root!, ".agents") : this.userConfigDir();
		let target: string;
		switch (req.kind) {
			case "skill":
				target = join(base, "skills", slug, "SKILL.md");
				break;
			case "agent":
				target = join(base, "agents", `${slug}.agent.md`);
				break;
			case "instruction":
				target = join(base, "rules", `${slug}.md`);
				break;
			case "prompt":
				target = join(base, "prompts", `${slug}.prompt.md`);
				break;
		}
		// Double-check allowed root containment.
		this.resolveAllowedPath(target);
		if (existsSync(target)) {
			throw new Error(`A ${req.kind} named "${slug}" already exists at ${target}.`);
		}
		await atomicWriteText(target, customizationTemplate(req));
		return { path: target };
	}

	/** Deletes a customization file (or skill folder when deleting its SKILL.md) inside an allowed root. */
	async remove(rawPath: string): Promise<boolean> {
		const { path } = this.resolveAllowedPath(rawPath);
		if (!existsSync(path)) return false;
		if (basename(path) === "SKILL.md" && basename(dirname(dirname(path))) === "skills") {
			// Remove the dedicated skill folder containing SKILL.md.
			rmSync(dirname(path), { recursive: true, force: true });
			return true;
		}
		if (extname(path).toLowerCase() !== ".md") {
			throw new Error("Only Markdown customization files can be removed here.");
		}
		rmSync(path, { force: true });
		return true;
	}

	/** Saves (creates or updates) an MCP server definition in User or Workspace `mcp.json`. */
	async saveMcpServer(scope: CustomizationScope, server: McpServerConfig): Promise<void> {
		const id = server.id.trim();
		if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) {
			throw new Error("MCP server ID must contain only letters, numbers, dots, hyphens, or underscores.");
		}
		if (server.transport === "stdio" && !server.command?.trim()) {
			throw new Error("A stdio MCP server requires a command.");
		}
		if ((server.transport === "http" || server.transport === "sse") && !server.url?.trim()) {
			throw new Error("A remote MCP server requires a URL.");
		}
		if (server.url?.trim()) {
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(server.url.trim());
			} catch {
				throw new Error(`Invalid MCP server URL: ${server.url}`);
			}
			if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
				throw new Error(`MCP server URL must use http: or https: (got ${parsedUrl.protocol}).`);
			}
		}
		const root = this.getRoot();
		if (scope === "workspace" && !root) {
			throw new Error("Open a workspace folder first to save a workspace MCP server.");
		}
		const target = scope === "workspace" ? this.workspaceMcpPath(root!) : this.userMcpPath();
		await mcpSerial.run(target, async () => {
			const existingRaw = readTextSafe(target);
			const map = existingRaw ? parseMcpConfigJson(existingRaw.text) : {};
			map[id] = {
				id,
				transport: server.transport,
				...(server.transport === "stdio"
					? {
							command: server.command!.trim(),
							...(server.args?.length ? { args: server.args } : {}),
							...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
						}
					: {
							url: server.url!.trim(),
							...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
						}),
				...(server.disabled ? { disabled: true } : {}),
				...(server.allowTools ? { allowTools: true } : {}),
			};
			const serversObj: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
				const { id: _ignored, ...rest } = v;
				serversObj[k] = rest;
			}
			await atomicWriteText(target, JSON.stringify({ servers: serversObj }, null, 2) + "\n");
		});
	}

	/** Removes an MCP server from User or Workspace `mcp.json`. */
	async deleteMcpServer(scope: CustomizationScope, id: string): Promise<boolean> {
		const root = this.getRoot();
		if (scope === "workspace" && !root) return false;
		const target = scope === "workspace" ? this.workspaceMcpPath(root!) : this.userMcpPath();
		return mcpSerial.run(target, async () => {
			const existingRaw = readTextSafe(target);
			if (!existingRaw) return false;
			const map = parseMcpConfigJson(existingRaw.text);
			if (!(id in map)) return false;
			delete map[id];
			const serversObj: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
				const { id: _ignored, ...rest } = v;
				serversObj[k] = rest;
			}
			await atomicWriteText(target, JSON.stringify({ servers: serversObj }, null, 2) + "\n");
			return true;
		});
	}

	/** Explicitly trusts or revokes trust for a workspace MCP server's exact SHA-256 fingerprint in User config. */
	async setMcpTrust(id: string, fingerprint: string, trusted: boolean): Promise<void> {
		const root = this.getRoot();
		if (!root) throw new Error("No workspace open.");
		if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid MCP trust fingerprint.");
		const trustFile = this.userMcpTrustPath();
		const key = this.trustKey(root, id);
		await mcpSerial.run(trustFile, async () => {
			const map = this.readTrustMap();
			if (trusted) map[key] = fingerprint;
			else delete map[key];
			await atomicWriteText(trustFile, JSON.stringify(map, null, 2) + "\n");
		});
	}
}
