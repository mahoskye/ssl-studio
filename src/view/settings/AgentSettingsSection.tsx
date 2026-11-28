// Agent & AI settings section inside the VS Code-style Settings Editor (ADR 0053):
// exposes agentModel, agentOwnModels, agentServerUrl, and agentServerConfig with
// clear User-only security lock guidance plus direct entry points to Agent Customizations & MCP.
import { createEffect, createSignal, Show, untrack } from "solid-js";
import type { Settings, SettingsScope } from "../../shared/protocol";
import {
	isSettingDefinedInScope,
	SETTINGS_SCHEMA_MAP,
	type SettingsLayers,
} from "../../shared/settingsSchema";
import { openCustomizations } from "../commands";
import { Icon } from "../Icon";
import { notify, state } from "../state";

function FieldInput(props: {
	id: string;
	placeholder: string;
	value: string;
	disabled?: boolean;
	multiline?: boolean;
	onCommit: (value: string) => Promise<boolean>;
}) {
	const [draft, setDraft] = createSignal(untrack(() => props.value));
	createEffect(
		() => props.value,
		(v) => {
			setDraft(v);
		},
	);
	const commit = async () => {
		const ok = await props.onCommit(draft());
		if (!ok) setDraft(untrack(() => props.value));
	};
	return (
		<Show
			when={props.multiline}
			fallback={
				<input
					id={props.id}
					type="text"
					autocomplete="off"
					spellcheck="false"
					disabled={props.disabled}
					placeholder={props.placeholder}
					value={draft()}
					onInput={(e) => setDraft(e.currentTarget.value)}
					onChange={() => void commit()}
					onKeyDown={(e) => {
						if (e.isComposing || e.keyCode === 229) return;
						if (e.key === "Enter") {
							e.preventDefault();
							e.currentTarget.blur();
						}
					}}
				/>
			}
		>
			<textarea
				id={props.id}
				class="settings-agent-json"
				rows={4}
				spellcheck="false"
				disabled={props.disabled}
				placeholder={props.placeholder}
				value={draft()}
				onInput={(e) => setDraft(e.currentTarget.value)}
				onChange={() => void commit()}
			/>
		</Show>
	);
}

export function AgentSettingsSection(props: {
	scope: SettingsScope;
	layers: SettingsLayers;
	visibleKeys: ReadonlySet<keyof Settings>;
	onSaveUser: <K extends keyof Settings>(key: K, value: Settings[K] | null) => Promise<boolean>;
	onSwitchToUser: () => void;
}) {
	const lockedInWorkspace = () => props.scope === "workspace";
	const meta = (key: keyof Settings) => SETTINGS_SCHEMA_MAP.get(key)!;
	const isMod = (key: keyof Settings) => isSettingDefinedInScope(key, props.layers, "user");

	const ownModelsText = () => (state.settings.agentOwnModels ?? []).join(", ");

	return (
		<div class="settings-subsection">
			<div class="settings-callout-cards">
				<div class="settings-callout-card">
					<div class="settings-callout-main">
						<Icon name="sparkle" />
						<div>
							<strong>Agent Customizations</strong>
							<p>Browse and author Instructions (<code>AGENTS.md</code>, rules), Skills (<code>SKILL.md</code>), Custom Agents, and Prompt Files.</p>
						</div>
					</div>
					<button type="button" onClick={() => openCustomizations("skills")}>
						Configure…
					</button>
				</div>
				<div class="settings-callout-card">
					<div class="settings-callout-main">
						<Icon name="plug" />
						<div>
							<strong>MCP Servers</strong>
							<p>Manage local <code>stdio</code> and remote MCP servers in <code>mcp.json</code> with explicit workspace trust checks.</p>
						</div>
					</div>
					<button type="button" onClick={() => openCustomizations("mcp")}>
						Manage MCP…
					</button>
				</div>
			</div>

			<Show when={lockedInWorkspace()}>
				<div class="settings-lock-banner" role="note">
					<Icon name="lock" />
					<span>
						Agent server URLs, billing trust, and default model overrides are <strong>User-only</strong> for security and cannot be changed in Workspace settings.
					</span>
					<button type="button" class="link" onClick={props.onSwitchToUser}>
						Switch to User settings
					</button>
				</div>
			</Show>

			<Show when={props.visibleKeys.has("agentModel")}>
				<div class={["settings-item", { modified: isMod("agentModel") && !lockedInWorkspace(), locked: lockedInWorkspace() }]}>
					<div class="settings-item-head">
						<span class="settings-item-cat">Agent &amp; AI</span>
						<label class="settings-item-title" for="set-agent-model">{meta("agentModel").label}</label>
						<Show when={lockedInWorkspace()}>
							<span class="settings-pill lock"><Icon name="lock" /> User only</span>
						</Show>
						<Show when={!lockedInWorkspace() && isMod("agentModel")}>
							<button
								type="button"
								class="settings-reset-btn"
								title="Reset Default agent model"
								onClick={() => void props.onSaveUser("agentModel", null)}
							>
								<Icon name="discard" />
							</button>
						</Show>
					</div>
					<p class="settings-item-desc">{meta("agentModel").description}</p>
					<div class="settings-item-control wide">
						<FieldInput
							id="set-agent-model"
							disabled={lockedInWorkspace()}
							placeholder="e.g. ollama/qwen2.5-coder:32b"
							value={state.settings.agentModel ?? ""}
							onCommit={(raw) => props.onSaveUser("agentModel", raw.trim() || null)}
						/>
					</div>
				</div>
			</Show>

			<Show when={props.visibleKeys.has("agentOwnModels")}>
				<div class={["settings-item", { modified: isMod("agentOwnModels") && !lockedInWorkspace(), locked: lockedInWorkspace() }]}>
					<div class="settings-item-head">
						<span class="settings-item-cat">Agent &amp; AI</span>
						<label class="settings-item-title" for="set-agent-own-models">{meta("agentOwnModels").label}</label>
						<Show when={lockedInWorkspace()}>
							<span class="settings-pill lock"><Icon name="lock" /> User only</span>
						</Show>
						<Show when={!lockedInWorkspace() && isMod("agentOwnModels")}>
							<button
								type="button"
								class="settings-reset-btn"
								title="Reset Self-hosted models"
								onClick={() => void props.onSaveUser("agentOwnModels", null)}
							>
								<Icon name="discard" />
							</button>
						</Show>
					</div>
					<p class="settings-item-desc">{meta("agentOwnModels").description}</p>
					<div class="settings-item-control wide">
						<FieldInput
							id="set-agent-own-models"
							disabled={lockedInWorkspace()}
							placeholder="e.g. vllm/qwen3-coder, litellm/internal-ssl"
							value={ownModelsText()}
							onCommit={(raw) => {
								const list = raw
									.split(",")
									.map((item) => item.trim())
									.filter(Boolean);
								return props.onSaveUser("agentOwnModels", list.length ? list : null);
							}}
						/>
					</div>
				</div>
			</Show>

			<Show when={props.visibleKeys.has("agentServerUrl")}>
				<div class={["settings-item", { modified: isMod("agentServerUrl") && !lockedInWorkspace(), locked: lockedInWorkspace() }]}>
					<div class="settings-item-head">
						<span class="settings-item-cat">Agent &amp; AI</span>
						<label class="settings-item-title" for="set-agent-server-url">{meta("agentServerUrl").label}</label>
						<Show when={lockedInWorkspace()}>
							<span class="settings-pill lock"><Icon name="lock" /> User only</span>
						</Show>
						<Show when={!lockedInWorkspace() && isMod("agentServerUrl")}>
							<button
								type="button"
								class="settings-reset-btn"
								title="Reset External opencode server URL"
								onClick={() => void props.onSaveUser("agentServerUrl", null)}
							>
								<Icon name="discard" />
							</button>
						</Show>
					</div>
					<p class="settings-item-desc">{meta("agentServerUrl").description}</p>
					<div class="settings-item-control wide">
						<FieldInput
							id="set-agent-server-url"
							disabled={lockedInWorkspace()}
							placeholder="Leave empty to run private opencode server"
							value={state.settings.agentServerUrl ?? ""}
							onCommit={(raw) => props.onSaveUser("agentServerUrl", raw.trim() || null)}
						/>
					</div>
				</div>
			</Show>

			<Show when={props.visibleKeys.has("agentServerConfig")}>
				<div class={["settings-item", { modified: isMod("agentServerConfig") && !lockedInWorkspace(), locked: lockedInWorkspace() }]}>
					<div class="settings-item-head">
						<span class="settings-item-cat">Agent &amp; AI</span>
						<label class="settings-item-title" for="set-agent-server-cfg">{meta("agentServerConfig").label}</label>
						<Show when={lockedInWorkspace()}>
							<span class="settings-pill lock"><Icon name="lock" /> User only</span>
						</Show>
						<Show when={!lockedInWorkspace() && isMod("agentServerConfig")}>
							<button
								type="button"
								class="settings-reset-btn"
								title="Reset Private opencode JSON config"
								onClick={() => void props.onSaveUser("agentServerConfig", null)}
							>
								<Icon name="discard" />
							</button>
						</Show>
					</div>
					<p class="settings-item-desc">{meta("agentServerConfig").description}</p>
					<div class="settings-item-control wide">
						<FieldInput
							id="set-agent-server-cfg"
							multiline
							disabled={lockedInWorkspace()}
							placeholder='{ "provider": { ... } }'
							value={state.settings.agentServerConfig ?? ""}
							onCommit={async (raw) => {
								const trimmed = raw.trim();
								if (trimmed) {
									try {
										const parsed = JSON.parse(trimmed);
										if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
											notify("Private opencode config must be a JSON object.", "error");
											return false;
										}
									} catch (e: any) {
										notify(`Invalid JSON for opencode config: ${String(e?.message ?? e)}`, "error");
										return false;
									}
								}
								return props.onSaveUser("agentServerConfig", trimmed || null);
							}}
						/>
					</div>
				</div>
			</Show>
		</div>
	);
}
