// Raw JSON editor view for User (`~/.config/ssl-studio/settings.json`) and
// Workspace (`.ssl-studio/settings.json`) settings, toggled via `{}` in the
// Settings Editor header (ADR 0053).
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { jsonProblem } from "../../shared/jsonCheck";
import type { SettingsScope } from "../../shared/protocol";
import { backend } from "../backend";
import { Icon } from "../Icon";
import { loadSettings, notify, openFile, state } from "../state";

export function SettingsJsonEditor(props: {
	scope: SettingsScope;
	onSaved: () => Promise<void> | void;
	onSwitchToUi: () => void;
}) {
	const [filePath, setFilePath] = createSignal("");
	const [exists, setExists] = createSignal(false);
	const [inWorkspace, setInWorkspace] = createSignal(false);
	const [originalText, setOriginalText] = createSignal("{\n}\n");
	const [draft, setDraft] = createSignal("{\n}\n");
	const [loading, setLoading] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal("");
	let reqSeq = 0;

	const reload = async (scope: SettingsScope) => {
		const seq = ++reqSeq;
		setLoading(true);
		setError("");
		try {
			const res = await backend.settingsFile(scope);
			if (seq !== reqSeq) return;
			setFilePath(res.path);
			setExists(res.exists);
			setInWorkspace(res.inWorkspace);
			setOriginalText(res.text);
			setDraft(res.text);
		} catch (e: any) {
			if (seq !== reqSeq) return;
			setError(String(e?.message ?? e));
		} finally {
			if (seq === reqSeq) setLoading(false);
		}
	};

	createEffect(
		() => [props.scope, state.workspace?.root ?? ""] as const,
		([scope]) => {
			void reload(scope);
		},
	);

	const dirty = createMemo(() => draft() !== originalText());

	const liveProblem = createMemo(() => {
		const text = draft();
		if (!text.trim()) return "";
		try {
			const parsed: unknown = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return "Root value must be a JSON object ({ ... }).";
			}
			return "";
		} catch (e: any) {
			const found = jsonProblem(text);
			if (!found) return String(e?.message ?? e);
			const before = text.slice(0, found.offset);
			const line = before.split("\n").length;
			const col = found.offset - (before.lastIndexOf("\n") + 1) + 1;
			return `Line ${line}, column ${col}: ${found.message}`;
		}
	});

	const formatJson = () => {
		if (liveProblem()) return;
		try {
			const parsed = JSON.parse(draft().trim() ? draft() : "{}");
			setDraft(JSON.stringify(parsed, null, 2) + "\n");
		} catch {
			// Guarded by liveProblem.
		}
	};

	const saveJson = async () => {
		if (saving() || liveProblem()) return;
		setSaving(true);
		setError("");
		try {
			const res = await backend.saveSettingsFile(props.scope, draft());
			await loadSettings();
			await props.onSaved();
			await reload(props.scope);
			if (res.strippedUserOnly.length) {
				notify(
					`Saved workspace settings. Ignored user-only security keys: ${res.strippedUserOnly.join(", ")}.`,
				);
			} else {
				notify(`Saved ${props.scope === "workspace" ? "Workspace" : "User"} settings.json.`);
			}
		} catch (e: any) {
			setError(String(e?.message ?? e));
		} finally {
			setSaving(false);
		}
	};

	const openInMonaco = () => {
		const path = filePath();
		if (!path || !inWorkspace()) return;
		void openFile(path);
	};

	return (
		<div class="settings-json-view">
			<div class="settings-json-bar">
				<div class="settings-json-meta">
					<Icon name="json" />
					<span class="settings-json-path" title={filePath()}>
						{filePath() || (props.scope === "workspace" ? ".ssl-studio/settings.json" : "settings.json")}
					</span>
					<Show when={!exists()}>
						<span class="settings-pill muted">New file on save</span>
					</Show>
					<Show when={dirty()}>
						<span class="settings-pill accent">Modified</span>
					</Show>
				</div>
				<div class="settings-json-acts">
					<button type="button" disabled={Boolean(liveProblem()) || loading()} onClick={formatJson}>
						Format
					</button>
					<button type="button" disabled={!dirty() || loading()} onClick={() => setDraft(originalText())}>
						Revert
					</button>
					<Show when={inWorkspace() && exists()}>
						<button type="button" title="Open .ssl-studio/settings.json in Monaco" onClick={openInMonaco}>
							<Icon name="go-to-file" />
							<span>Open File</span>
						</button>
					</Show>
					<button
						type="button"
						class="primary"
						disabled={saving() || loading() || Boolean(liveProblem()) || !dirty()}
						onClick={() => void saveJson()}
					>
						{saving() ? "Saving…" : "Save JSON"}
					</button>
				</div>
			</div>

			<Show when={props.scope === "workspace"}>
				<p class="settings-json-note">
					<Icon name="lock" />
					<span>
						Security keys (<code>lspPath</code>, <code>agentServerUrl</code>, <code>agentServerConfig</code>,{" "}
						<code>agentOwnModels</code>, <code>agentModel</code>, and keybindings) are ignored in Workspace settings and must be set in{" "}
						<strong>User</strong> settings.
					</span>
				</p>
			</Show>

			<Show when={liveProblem() || error()}>
				<p class="settings-note" role="alert">
					{liveProblem() || error()}
				</p>
			</Show>

			<textarea
				class="settings-json-editor"
				aria-label={`${props.scope === "workspace" ? "Workspace" : "User"} settings.json`}
				spellcheck="false"
				disabled={loading()}
				value={draft()}
				onInput={(e) => setDraft(e.currentTarget.value)}
				onKeyDown={(e) => {
					if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
						e.preventDefault();
						void saveJson();
					}
				}}
			/>

			<div class="settings-json-foot">
				<span>Press Ctrl+S to save.</span>
				<button type="button" class="link" onClick={props.onSwitchToUi}>
					Back to Settings UI
				</button>
			</div>
		</div>
	);
}
