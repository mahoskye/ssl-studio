// VS Code-aligned Agent Customizations Hub (ADR 0053):
// Manage Instructions (AGENTS.md & rules), Agent Skills (SKILL.md), Custom Agents
// (*.agent.md), Prompt Files (*.prompt.md & docs/knowledge/prompts), and MCP Servers
// (User + Workspace mcp.json with explicit SHA-256 fingerprint trust gate).
import { createEffect, createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import type {
	AgentCustomizationsSnapshot,
	CustomizationKind,
	CustomizationScope,
	McpServerConfig,
	McpServerEntry,
	McpTransport,
} from "../../shared/agentCustomizations";
import { backend } from "../backend";
import { onOpenCustomizations, openSettings, type CustomizationsTab } from "../commands";
import { ask, choose } from "../dialogs";
import { closeComparison } from "../editor/Review";
import { Icon, type IconName } from "../Icon";
import { Modal } from "../modal";
import { matchWords } from "../quickRank";
import { notify, openFile, setState, state } from "../state";

type ScopeFilter = "all" | CustomizationScope;

const [activeTab, setActiveTab] = createSignal<CustomizationsTab>("skills");
const [modalOpen, setModalOpen] = createSignal(false);
const [reloadNonce, setReloadNonce] = createSignal(0);

/** Notifies Agent panel and Customizations hub whenever customization files or MCP servers change. */
export const customizationsVersion = reloadNonce;
export function bumpCustomizationsVersion() {
	setReloadNonce((n) => n + 1);
}

const TABS: { id: CustomizationsTab; label: string; icon: IconName; subtitle: string }[] = [
	{ id: "instructions", label: "Instructions", icon: "book", subtitle: "Always-on project rules (AGENTS.md, .agents/rules/*.md, .github/instructions/)" },
	{ id: "skills", label: "Skills", icon: "extensions", subtitle: "Open-standard SKILL.md bundles discovered from .agents/skills/ and User skills" },
	{ id: "agents", label: "Custom Agents", icon: "hubot", subtitle: "Reusable *.agent.md personas with dedicated instructions, skills, and model hints" },
	{ id: "prompts", label: "Prompt Files", icon: "note", subtitle: "Reusable /slash prompts from docs/knowledge/prompts/ and .agents/prompts/" },
	{ id: "mcp", label: "MCP Servers", icon: "plug", subtitle: "Model Context Protocol servers in User & Workspace mcp.json with explicit trust gating" },
];

type EditorDrawerState = {
	path: string;
	scope: CustomizationScope;
	original: string;
	draft: string;
	saving: boolean;
};

type McpFormState = {
	editingExisting: boolean;
	scope: CustomizationScope;
	id: string;
	transport: McpTransport;
	command: string;
	argsText: string;
	url: string;
	disabled: boolean;
	allowTools: boolean;
};

function CustomizationsWorkspace(props: { embedded: boolean }) {
	const [data, setData] = createSignal<AgentCustomizationsSnapshot | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal("");
	const [query, setQuery] = createSignal("");
	const [scopeFilter, setScopeFilter] = createSignal<ScopeFilter>("all");
	const [drawer, setDrawer] = createSignal<EditorDrawerState | null>(null);
	const [mcpForm, setMcpForm] = createSignal<McpFormState | null>(null);
	let loadSeq = 0;

	const load = async () => {
		const seq = ++loadSeq;
		setLoading(true);
		setError("");
		try {
			const snap = await backend.customizations();
			if (seq !== loadSeq) return;
			setData(snap);
		} catch (e: any) {
			if (seq !== loadSeq) return;
			setError(String(e?.message ?? e));
		} finally {
			if (seq === loadSeq) setLoading(false);
		}
	};

	createEffect(
		() => [state.workspace?.root ?? "", reloadNonce(), state.centerView === "customizations" || modalOpen()] as const,
		([, , visible]) => {
			if (visible) void load();
		},
	);

	const matchesFilter = (scope: CustomizationScope, ...fields: (string | undefined)[]) => {
		if (scopeFilter() !== "all" && scope !== scopeFilter()) return false;
		const q = query().trim();
		if (!q) return true;
		return matchWords(q, fields.filter(Boolean).join(" ")) > 0;
	};

	const instructions = createMemo(() =>
		(data()?.instructions ?? []).filter((i) => matchesFilter(i.scope, i.name, i.relPath, i.applyTo, i.description)),
	);
	const skills = createMemo(() =>
		(data()?.skills ?? []).filter((s) => matchesFilter(s.scope, s.name, s.description, s.relPath, s.source)),
	);
	const agents = createMemo(() =>
		(data()?.agents ?? []).filter((a) => matchesFilter(a.scope, a.name, a.description, a.model, ...a.skills)),
	);
	const prompts = createMemo(() =>
		(data()?.prompts ?? []).filter((p) => matchesFilter(p.scope, p.command, p.title, p.description, p.relPath)),
	);
	const mcpServers = createMemo(() =>
		(data()?.mcpServers ?? []).filter((m) => matchesFilter(m.scope, m.id, m.transport, m.command, m.url)),
	);

	const tabCount = (tab: CustomizationsTab): number => {
		const d = data();
		if (!d) return 0;
		switch (tab) {
			case "instructions":
				return d.instructions.length;
			case "skills":
				return d.skills.length;
			case "agents":
				return d.agents.length;
			case "prompts":
				return d.prompts.length;
			case "mcp":
				return d.mcpServers.length;
		}
	};

	const openInlineEditor = async (path: string) => {
		try {
			const res = await backend.customizationRead(path);
			setDrawer({ path: res.path, scope: res.scope, original: res.text, draft: res.text, saving: false });
		} catch (e: any) {
			notify(`Could not open customization file: ${String(e?.message ?? e)}`, "error");
		}
	};

	const saveDrawer = async () => {
		const cur = drawer();
		if (!cur || cur.saving) return;
		setDrawer({ ...cur, saving: true });
		try {
			await backend.customizationSave(cur.path, cur.draft);
			setDrawer({ ...cur, original: cur.draft, saving: false });
			bumpCustomizationsVersion();
			notify("Saved customization file.");
		} catch (e: any) {
			setDrawer({ ...cur, saving: false });
			notify(`Could not save file: ${String(e?.message ?? e)}`, "error");
		}
	};

	const createItem = async (kind: CustomizationKind) => {
		const defaultScope: CustomizationScope =
			scopeFilter() === "user" ? "user" : state.workspace ? "workspace" : "user";
		let scope: CustomizationScope = defaultScope;
		if (state.workspace && scopeFilter() === "all") {
			const pickedScope = await choose(
				`Where should the new ${kind} be saved?`,
				["Workspace (.agents/)", "User (~/.config/ssl-studio/)"],
			);
			if (!pickedScope) return;
			scope = pickedScope.startsWith("Workspace") ? "workspace" : "user";
		}
		const labelMap: Record<CustomizationKind, string> = {
			skill: "Skill name (lowercase kebab-case, e.g. starlims-sql-audit)",
			agent: "Custom Agent name (e.g. SSL Code Reviewer)",
			instruction: "Instruction rule name (e.g. sql-security)",
			prompt: "Prompt command name (e.g. review-script)",
		};
		const name = await ask(labelMap[kind], "");
		if (!name || !name.trim()) return;
		let applyTo: string | undefined;
		if (kind === "instruction") {
			const glob = await ask("Optional applyTo file glob (leave empty to apply to all files, e.g. **/*.ssl)", "");
			if (glob === null) return;
			applyTo = glob.trim() || undefined;
		}
		try {
			const created = await backend.customizationCreate({ kind, scope, name: name.trim(), applyTo });
			bumpCustomizationsVersion();
			notify(`Created ${kind} “${name.trim()}”.`);
			if (scope === "workspace") {
				void openFile(created.path);
			} else {
				void openInlineEditor(created.path);
			}
		} catch (e: any) {
			notify(`Could not create ${kind}: ${String(e?.message ?? e)}`, "error");
		}
	};

	const deleteItem = async (path: string, title: string) => {
		const picked = await choose(`Delete “${title}”? This removes the file from disk and cannot be undone.`, ["Delete"]);
		if (picked !== "Delete") return;
		try {
			await backend.customizationDelete(path);
			if (drawer()?.path === path) setDrawer(null);
			bumpCustomizationsVersion();
			notify(`Deleted “${title}”.`);
		} catch (e: any) {
			notify(`Could not delete “${title}”: ${String(e?.message ?? e)}`, "error");
		}
	};

	// --- MCP management --------------------------------------------------------

	const openNewMcpForm = () => {
		setMcpForm({
			editingExisting: false,
			scope: scopeFilter() === "workspace" && state.workspace ? "workspace" : "user",
			id: "",
			transport: "stdio",
			command: "",
			argsText: "",
			url: "",
			disabled: false,
			allowTools: false,
		});
	};

	const openEditMcpForm = (entry: McpServerEntry) => {
		setMcpForm({
			editingExisting: true,
			scope: entry.scope,
			id: entry.id,
			transport: entry.transport,
			command: entry.command ?? "",
			argsText: (entry.args ?? []).join(" "),
			url: entry.url ?? "",
			disabled: Boolean(entry.disabled),
			allowTools: Boolean(entry.allowTools),
		});
	};

	const submitMcpForm = async (e: Event) => {
		e.preventDefault();
		const form = mcpForm();
		if (!form) return;
		const args = form.argsText
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		const cfg: McpServerConfig = {
			id: form.id.trim(),
			transport: form.transport,
			...(form.transport === "stdio"
				? { command: form.command.trim(), ...(args.length ? { args } : {}) }
				: { url: form.url.trim() }),
			...(form.disabled ? { disabled: true } : {}),
			...(form.allowTools ? { allowTools: true } : {}),
		};
		try {
			await backend.mcpSave(form.scope, cfg);
			setMcpForm(null);
			bumpCustomizationsVersion();
			notify(
				form.scope === "workspace"
					? `Saved workspace MCP server “${cfg.id}”. Trust it explicitly below before enabling.`
					: `Saved user MCP server “${cfg.id}”.`,
			);
		} catch (err: any) {
			notify(`Could not save MCP server: ${String(err?.message ?? err)}`, "error");
		}
	};

	const toggleMcpField = async (entry: McpServerEntry, patch: Partial<Pick<McpServerConfig, "disabled" | "allowTools">>) => {
		const next: McpServerConfig = {
			id: entry.id,
			transport: entry.transport,
			command: entry.command,
			args: entry.args,
			env: entry.env,
			url: entry.url,
			headers: entry.headers,
			disabled: patch.disabled ?? entry.disabled,
			allowTools: patch.allowTools ?? entry.allowTools,
		};
		try {
			await backend.mcpSave(entry.scope, next);
			bumpCustomizationsVersion();
		} catch (err: any) {
			notify(`Could not update MCP server: ${String(err?.message ?? err)}`, "error");
		}
	};

	const toggleMcpTrust = async (entry: McpServerEntry) => {
		if (entry.scope !== "workspace") return;
		if (!entry.trusted) {
			const targetDesc =
				entry.transport === "stdio"
					? `Command: ${[entry.command, ...(entry.args ?? [])].filter(Boolean).join(" ")}`
					: `URL: ${entry.url}`;
			const picked = await choose(
				`Trust workspace MCP server “${entry.id}”?\n\n${targetDesc}\n\nTrust is bound to this exact configuration fingerprint; any change in the repository revokes trust automatically.`,
				["Trust server"],
			);
			if (picked !== "Trust server") return;
		}
		try {
			await backend.mcpSetTrust(entry.id, entry.fingerprint, !entry.trusted);
			bumpCustomizationsVersion();
			notify(!entry.trusted ? `Trusted workspace MCP server “${entry.id}”.` : `Revoked trust for “${entry.id}”.`);
		} catch (err: any) {
			notify(`Could not update MCP trust: ${String(err?.message ?? err)}`, "error");
		}
	};

	const deleteMcp = async (entry: McpServerEntry) => {
		const picked = await choose(`Remove MCP server “${entry.id}” from ${entry.scope} mcp.json?`, ["Remove server"]);
		if (picked !== "Remove server") return;
		try {
			await backend.mcpDelete(entry.scope, entry.id);
			bumpCustomizationsVersion();
			notify(`Removed MCP server “${entry.id}”.`);
		} catch (err: any) {
			notify(`Could not remove MCP server: ${String(err?.message ?? err)}`, "error");
		}
	};

	const currentTabMeta = () => TABS.find((t) => t.id === activeTab())!;

	return (
		<div class={["cust-workspace", { embedded: props.embedded }]} data-view="customizations">
			{/* Top toolbar */}
			<div class="cust-topbar">
				<div class="cust-search-wrap">
					<Icon name="search" class="settings-search-icon" />
					<input
						class="cust-search"
						aria-label="Filter customizations"
						placeholder="Filter customizations…"
						autocomplete="off"
						spellcheck="false"
						value={query()}
						onInput={(e) => setQuery(e.currentTarget.value)}
					/>
					<Show when={query()}>
						<button type="button" class="settings-search-clear" title="Clear filter" aria-label="Clear filter" onClick={() => setQuery("")}>
							<Icon name="close" />
						</button>
					</Show>
				</div>
				<div class="cust-scope-group" role="group" aria-label="Filter by scope">
					{(
						[
							["all", "All"],
							["workspace", "Workspace"],
							["user", "User"],
						] as const
					).map(([id, label]) => (
						<button
							type="button"
							class={["cust-scope-btn", { active: scopeFilter() === id }]}
							aria-pressed={scopeFilter() === id ? "true" : "false"}
							disabled={id === "workspace" && !state.workspace}
							onClick={() => setScopeFilter(id)}
						>
							{label}
						</button>
					))}
				</div>
				<div class="cust-top-actions">
					<button type="button" class="settings-icon-action" title="Refresh customizations" onClick={() => void load()}>
						<Icon name="refresh" />
					</button>
					<button type="button" class="settings-icon-action" title="Open Settings" onClick={() => openSettings()}>
						<Icon name="gear" />
						<span>Settings</span>
					</button>
				</div>
			</div>

			<Show when={error()}>
				<p class="settings-note" role="alert">
					{error()}
				</p>
			</Show>

			<div class="cust-split">
				{/* Left category navigation */}
				<nav class="cust-nav" aria-label="Customization sections">
					<For each={TABS}>
						{(tab) => (
							<button
								type="button"
								class={["cust-nav-item", { active: activeTab() === tab.id }]}
								onClick={() => {
									setActiveTab(tab.id);
									setMcpForm(null);
								}}
							>
								<Icon name={tab.icon} />
								<span class="cust-nav-label">{tab.label}</span>
								<span class="settings-toc-count">{tabCount(tab.id)}</span>
							</button>
						)}
					</For>
				</nav>

				{/* Right content pane */}
				<div class="cust-content">
					<div class="cust-section-head">
						<div class="cust-section-title">
							<h3>
								<Icon name={currentTabMeta().icon} />
								<span>{currentTabMeta().label}</span>
							</h3>
							<p>{currentTabMeta().subtitle}</p>
						</div>
						<Show when={activeTab() === "instructions"}>
							<button type="button" class="primary" onClick={() => void createItem("instruction")}>
								<Icon name="add" />
								<span>New Rule…</span>
							</button>
						</Show>
						<Show when={activeTab() === "skills"}>
							<button type="button" class="primary" onClick={() => void createItem("skill")}>
								<Icon name="add" />
								<span>New Skill…</span>
							</button>
						</Show>
						<Show when={activeTab() === "agents"}>
							<button type="button" class="primary" onClick={() => void createItem("agent")}>
								<Icon name="add" />
								<span>New Agent…</span>
							</button>
						</Show>
						<Show when={activeTab() === "prompts"}>
							<button type="button" class="primary" onClick={() => void createItem("prompt")}>
								<Icon name="add" />
								<span>New Prompt…</span>
							</button>
						</Show>
						<Show when={activeTab() === "mcp"}>
							<button type="button" class="primary" onClick={openNewMcpForm}>
								<Icon name="add" />
								<span>Add MCP Server…</span>
							</button>
						</Show>
					</div>

					{/* Inline Editor Drawer (for User files or quick inspection) */}
					<Show when={drawer()}>
						{(d) => (
							<div class="cust-drawer" role="region" aria-label="Edit customization file">
								<div class="cust-drawer-head">
									<div class="cust-drawer-meta">
										<Icon name="file-code" />
										<span class="cust-drawer-path" title={d().path}>{d().path}</span>
										<Show when={d().draft !== d().original}>
											<span class="settings-pill accent">Unsaved</span>
										</Show>
									</div>
									<div class="cust-drawer-acts">
										<button
											type="button"
											disabled={d().draft === d().original || d().saving}
											onClick={() => setDrawer({ ...d(), draft: d().original })}
										>
											Revert
										</button>
										<button
											type="button"
											class="primary"
											disabled={d().draft === d().original || d().saving}
											onClick={() => void saveDrawer()}
										>
											{d().saving ? "Saving…" : "Save"}
										</button>
										<button type="button" title="Close editor" aria-label="Close editor" onClick={() => setDrawer(null)}>
											<Icon name="close" />
										</button>
									</div>
								</div>
								<textarea
									class="cust-drawer-editor"
									spellcheck="false"
									value={d().draft}
									onInput={(e) => setDrawer({ ...d(), draft: e.currentTarget.value })}
									onKeyDown={(e) => {
										if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
											e.preventDefault();
											void saveDrawer();
										}
									}}
								/>
							</div>
						)}
					</Show>

					{/* 1. Instructions */}
					<Show when={activeTab() === "instructions"}>
						<div class="cust-list">
							<For
								each={instructions()}
								fallback={
									<p class="settings-empty">
										{loading() ? "Scanning instructions…" : "No instruction files found yet. Add AGENTS.md or create a scoped rule under .agents/rules/."}
									</p>
								}
							>
								{(item) => (
									<div class="cust-card">
										<div class="cust-card-head">
											<span class="cust-card-title">{item.name}</span>
											<span class={`settings-pill ${item.scope === "workspace" ? "accent" : "muted"}`}>
												{item.scope === "workspace" ? "Workspace" : "User"}
											</span>
											<Show when={item.applyTo}>
												<span class="settings-pill mono">applyTo: {item.applyTo}</span>
											</Show>
										</div>
										<Show when={item.description}>
											<p class="cust-card-desc">{item.description}</p>
										</Show>
										<div class="cust-card-foot">
											<span class="cust-card-path" title={item.path}>{item.relPath} · {item.lines} lines</span>
											<div class="cust-card-acts">
												<Show when={item.scope === "workspace"}>
													<button type="button" onClick={() => void openFile(item.path)}>
														<Icon name="go-to-file" />
														<span>Open</span>
													</button>
												</Show>
												<button type="button" onClick={() => void openInlineEditor(item.path)}>
													<Icon name="edit" />
													<span>Edit</span>
												</button>
												<Show when={item.kind === "rule"}>
													<button type="button" title="Delete rule" aria-label={`Delete ${item.name}`} onClick={() => void deleteItem(item.path, item.name)}>
														<Icon name="trash" />
													</button>
												</Show>
											</div>
										</div>
									</div>
								)}
							</For>
						</div>
					</Show>

					{/* 2. Skills */}
					<Show when={activeTab() === "skills"}>
						<div class="cust-list">
							<For
								each={skills()}
								fallback={
									<p class="settings-empty">
										{loading() ? "Scanning skills…" : "No Agent Skills (SKILL.md) found yet. Create one to standardize recurring STARLIMS workflows."}
									</p>
								}
							>
								{(skill) => (
									<div class="cust-card">
										<div class="cust-card-head">
											<span class="cust-card-title">{skill.name}</span>
											<span class={`settings-pill ${skill.scope === "workspace" ? "accent" : "muted"}`}>
												{skill.scope === "workspace" ? "Workspace" : "User"}
											</span>
											<span class="settings-pill muted">{skill.source}</span>
											<Show when={skill.hasScripts}>
												<span class="settings-pill mono">scripts/</span>
											</Show>
											<Show when={skill.hasReferences}>
												<span class="settings-pill mono">references/</span>
											</Show>
										</div>
										<p class="cust-card-desc">{skill.description}</p>
										<div class="cust-card-foot">
											<span class="cust-card-path" title={skill.path}>{skill.relPath}</span>
											<div class="cust-card-acts">
												<Show when={skill.scope === "workspace"}>
													<button type="button" onClick={() => void openFile(skill.path)}>
														<Icon name="go-to-file" />
														<span>Open</span>
													</button>
												</Show>
												<button type="button" onClick={() => void openInlineEditor(skill.path)}>
													<Icon name="edit" />
													<span>Edit</span>
												</button>
												<button type="button" title="Delete skill" aria-label={`Delete skill ${skill.name}`} onClick={() => void deleteItem(skill.path, skill.name)}>
													<Icon name="trash" />
												</button>
											</div>
										</div>
									</div>
								)}
							</For>
						</div>
					</Show>

					{/* 3. Custom Agents */}
					<Show when={activeTab() === "agents"}>
						<div class="cust-list">
							<For
								each={agents()}
								fallback={
									<p class="settings-empty">
										{loading() ? "Scanning custom agents…" : "No Custom Agents (*.agent.md) defined yet. Create a specialist persona like SSL Reviewer or Migration Auditor."}
									</p>
								}
							>
								{(agent) => (
									<div class="cust-card">
										<div class="cust-card-head">
											<span class="cust-card-title">{agent.name}</span>
											<span class={`settings-pill ${agent.scope === "workspace" ? "accent" : "muted"}`}>
												{agent.scope === "workspace" ? "Workspace" : "User"}
											</span>
											<Show when={agent.model}>
												<span class="settings-pill mono">{agent.model}</span>
											</Show>
										</div>
										<p class="cust-card-desc">{agent.description}</p>
										<Show when={agent.skills.length > 0}>
											<div class="cust-tags">
												<For each={agent.skills}>{(sk) => <span class="settings-pill mono">skill:{sk}</span>}</For>
											</div>
										</Show>
										<div class="cust-card-foot">
											<span class="cust-card-path" title={agent.path}>{agent.relPath}</span>
											<div class="cust-card-acts">
												<Show when={agent.scope === "workspace"}>
													<button type="button" onClick={() => void openFile(agent.path)}>
														<Icon name="go-to-file" />
														<span>Open</span>
													</button>
												</Show>
												<button type="button" onClick={() => void openInlineEditor(agent.path)}>
													<Icon name="edit" />
													<span>Edit</span>
												</button>
												<button type="button" title="Delete custom agent" aria-label={`Delete agent ${agent.name}`} onClick={() => void deleteItem(agent.path, agent.name)}>
													<Icon name="trash" />
												</button>
											</div>
										</div>
									</div>
								)}
							</For>
						</div>
					</Show>

					{/* 4. Prompt Files */}
					<Show when={activeTab() === "prompts"}>
						<div class="cust-list">
							<For
								each={prompts()}
								fallback={
									<p class="settings-empty">
										{loading() ? "Scanning prompt files…" : "No prompt files found. Create reusable /slash prompts under .agents/prompts/ or docs/knowledge/prompts/."}
									</p>
								}
							>
								{(prompt) => (
									<div class="cust-card">
										<div class="cust-card-head">
											<span class="settings-pill mono accent">{prompt.command}</span>
											<span class="cust-card-title">{prompt.title}</span>
											<span class={`settings-pill ${prompt.scope === "workspace" ? "accent" : "muted"}`}>
												{prompt.scope === "workspace" ? "Workspace" : "User"}
											</span>
											<span class="settings-pill muted">{prompt.source}</span>
										</div>
										<Show when={prompt.description}>
											<p class="cust-card-desc">{prompt.description}</p>
										</Show>
										<div class="cust-card-foot">
											<span class="cust-card-path" title={prompt.path}>{prompt.relPath}</span>
											<div class="cust-card-acts">
												<Show when={prompt.scope === "workspace"}>
													<button type="button" onClick={() => void openFile(prompt.path)}>
														<Icon name="go-to-file" />
														<span>Open</span>
													</button>
												</Show>
												<button type="button" onClick={() => void openInlineEditor(prompt.path)}>
													<Icon name="edit" />
													<span>Edit</span>
												</button>
												<Show when={prompt.source !== "knowledge"}>
													<button type="button" title="Delete prompt" aria-label={`Delete prompt ${prompt.title}`} onClick={() => void deleteItem(prompt.path, prompt.title)}>
														<Icon name="trash" />
													</button>
												</Show>
											</div>
										</div>
									</div>
								)}
							</For>
						</div>
					</Show>

					{/* 5. MCP Servers */}
					<Show when={activeTab() === "mcp"}>
						<div class="settings-lock-banner" role="note">
							<Icon name="shield" />
							<span>
								<strong>Security boundary:</strong> Workspace MCP servers (<code>.ssl-studio/mcp.json</code>) are untrusted by default and never executed until you explicitly trust their exact SHA-256 fingerprint. Any change to command, args, env, or URL automatically revokes trust.
							</span>
						</div>

						<Show when={mcpForm()}>
							{(form) => (
								<form class="cust-mcp-form" onSubmit={(e) => void submitMcpForm(e)}>
									<h4>{form().editingExisting ? `Edit MCP Server: ${form().id}` : "Add MCP Server"}</h4>
									<div class="cust-mcp-grid">
										<label>
											<span>Server ID</span>
											<input
												type="text"
												required
												disabled={form().editingExisting}
												placeholder="e.g. starlims-docs"
												value={form().id}
												onInput={(e) => setMcpForm({ ...form(), id: e.currentTarget.value })}
											/>
										</label>
										<label>
											<span>Scope</span>
											<select
												disabled={form().editingExisting}
												value={form().scope}
												onChange={(e) => setMcpForm({ ...form(), scope: e.currentTarget.value as CustomizationScope })}
											>
												<option value="user">User (~/.config/ssl-studio/mcp.json)</option>
												<Show when={Boolean(state.workspace)}>
													<option value="workspace">Workspace (.ssl-studio/mcp.json)</option>
												</Show>
											</select>
										</label>
										<label>
											<span>Transport</span>
											<select
												value={form().transport}
												onChange={(e) => setMcpForm({ ...form(), transport: e.currentTarget.value as McpTransport })}
											>
												<option value="stdio">Local stdio command</option>
												<option value="http">Remote HTTP (Streamable)</option>
												<option value="sse">Remote SSE</option>
											</select>
										</label>
									</div>
									<Show
										when={form().transport === "stdio"}
										fallback={
											<label class="cust-mcp-field">
												<span>Server URL</span>
												<input
													type="url"
													required
													placeholder="https://mcp.example.internal/mcp"
													value={form().url}
													onInput={(e) => setMcpForm({ ...form(), url: e.currentTarget.value })}
												/>
											</label>
										}
									>
										<div class="cust-mcp-grid">
											<label>
												<span>Command</span>
												<input
													type="text"
													required
													placeholder="e.g. npx, bun, python3"
													value={form().command}
													onInput={(e) => setMcpForm({ ...form(), command: e.currentTarget.value })}
												/>
											</label>
											<label>
												<span>Arguments (space-separated)</span>
												<input
													type="text"
													placeholder="e.g. -y @modelcontextprotocol/server-filesystem ."
													value={form().argsText}
													onInput={(e) => setMcpForm({ ...form(), argsText: e.currentTarget.value })}
												/>
											</label>
										</div>
									</Show>
									<label class="settings-check">
										<input
											type="checkbox"
											checked={form().allowTools}
											onChange={(e) => setMcpForm({ ...form(), allowTools: e.currentTarget.checked })}
										/>
										<span>Allow agent sessions to read MCP resources &amp; invoke tools from this server (when trusted &amp; enabled)</span>
									</label>
									<div class="cust-mcp-form-acts">
										<button type="submit" class="primary">
											Save Server
										</button>
										<button type="button" onClick={() => setMcpForm(null)}>
											Cancel
										</button>
									</div>
								</form>
							)}
						</Show>

						<div class="cust-list">
							<For
								each={mcpServers()}
								fallback={
									<p class="settings-empty">
										{loading() ? "Loading MCP servers…" : "No MCP servers configured yet. Click “Add MCP Server…” to connect local tools or documentation resources."}
									</p>
								}
							>
								{(entry) => (
									<div class={["cust-card", "cust-mcp-card", { untrusted: !entry.trusted, disabled: entry.disabled }]}>
										<div class="cust-card-head">
											<Icon name={entry.transport === "stdio" ? "terminal" : "globe"} />
											<span class="cust-card-title">{entry.id}</span>
											<span class="settings-pill mono">{entry.transport}</span>
											<span class={`settings-pill ${entry.scope === "workspace" ? "accent" : "muted"}`}>
												{entry.scope === "workspace" ? "Workspace" : "User"}
											</span>
											<Show
												when={entry.trusted}
												fallback={
													<span class="settings-pill lock">
														<Icon name="lock" /> Trust required
													</span>
												}
											>
												<span class="settings-pill ok">
													<Icon name="shield" /> Trusted
												</span>
											</Show>
											<Show when={entry.disabled}>
												<span class="settings-pill muted">Disabled</span>
											</Show>
										</div>
										<p class="cust-card-cmd">
											{entry.transport === "stdio"
												? [entry.command, ...(entry.args ?? [])].filter(Boolean).join(" ")
												: entry.url}
										</p>
										<Show when={!entry.trusted && entry.trustReason}>
											<p class="cust-trust-warn">{entry.trustReason}</p>
										</Show>
										<div class="cust-card-foot">
											<div class="cust-mcp-toggles">
												<label class="settings-check">
													<input
														type="checkbox"
														checked={!entry.disabled}
														onChange={(e) => void toggleMcpField(entry, { disabled: !e.currentTarget.checked })}
													/>
													<span>Enabled</span>
												</label>
												<label class="settings-check">
													<input
														type="checkbox"
														checked={Boolean(entry.allowTools)}
														disabled={!entry.trusted || Boolean(entry.disabled)}
														onChange={(e) => void toggleMcpField(entry, { allowTools: e.currentTarget.checked })}
													/>
													<span>Allow MCP tools</span>
												</label>
											</div>
											<div class="cust-card-acts">
												<Show when={entry.scope === "workspace"}>
													<button
														type="button"
														class={entry.trusted ? undefined : "primary"}
														onClick={() => void toggleMcpTrust(entry)}
													>
														<Icon name={entry.trusted ? "unlock" : "shield"} />
														<span>{entry.trusted ? "Revoke Trust" : "Trust Server…"}</span>
													</button>
												</Show>
												<button type="button" onClick={() => openEditMcpForm(entry)}>
													<Icon name="edit" />
													<span>Edit</span>
												</button>
												<button type="button" title="Remove MCP server" aria-label={`Remove ${entry.id}`} onClick={() => void deleteMcp(entry)}>
													<Icon name="trash" />
												</button>
											</div>
										</div>
									</div>
								)}
							</For>
						</div>
					</Show>
				</div>
			</div>
		</div>
	);
}

/** Full-pane Agent Customizations editor tab mounted in `App.tsx` inside `<CenterTabStrip>`. */
export function CustomizationsView() {
	return <CustomizationsWorkspace embedded={true} />;
}

/** Opens the Agent Customizations hub directly (safe for panels/agent without importing commands.ts). */
export function openCustomizationsHub(tab?: CustomizationsTab) {
	if (tab) setActiveTab(tab);
	if (state.workspace) {
		closeComparison();
		setModalOpen(false);
		setState((s) => {
			s.centerView = "customizations";
		});
	} else {
		setModalOpen(true);
	}
}

/** Registers `openCustomizations()` and renders a `<Modal>` fallback when no workspace is open. */
export function CustomizationsHost() {
	const titleId = createUniqueId();
	onOpenCustomizations((tab) => openCustomizationsHub(tab));
	const close = () => setModalOpen(false);
	return (
		<Show when={modalOpen() && !state.workspace}>
			<Modal class="dialog settings settings-modal" labelledBy={titleId} onClose={close}>
				<div class="settings-modal-head">
					<h2 id={titleId}>Agent Customizations</h2>
					<button type="button" class="primary" onClick={close}>
						Done
					</button>
				</div>
				<CustomizationsWorkspace embedded={false} />
			</Modal>
		</Show>
	);
}
