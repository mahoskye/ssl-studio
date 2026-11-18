// The style profile editor: the language server's `ssl` settings, per user
// or per workspace, with the house preset (decisions 0002, 0005, 0006).
import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";
import { getPath, SERVER_DEFAULTS, RULE_LEVELS, SECTIONS, setPath, type Field } from "../shared/styleProfile";
import { backend } from "./backend";
import { choose } from "./dialogs";
import { diagnostics } from "./lsp/session";
import { Modal } from "./modal";
import { loadSettings, notify, state } from "./state";

const [open, setOpen] = createSignal(false);
export const openStyleProfile = () => setOpen(true);

export function StyleProfile() {
	const [scope, setScope] = createSignal<"user" | "workspace">("user");
	const [layers, setLayers] = createSignal<{ user: any; workspace: any }>({ user: {}, workspace: {} });
	/** Why the settings could not be read: said in the dialog, not swallowed. */
	const [loadError, setLoadError] = createSignal("");
	const titleId = createUniqueId();
	const presetId = createUniqueId();
	const reload = async () => {
		try {
			const s = await backend.settings();
			setLayers({ user: s.user.ssl ?? {}, workspace: s.workspace.ssl ?? {} });
			setLoadError("");
		} catch (e: any) {
			setLoadError(String(e?.message ?? e));
		}
	};
	createEffect(() => open() && void reload());
	const current = () => layers()[scope()];
	const write = async (ssl: any) => {
		try {
			await backend.saveSettings(scope(), { ssl });
			await reload();
			await loadSettings();
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	};
	const preset = async (stylePreset: "house" | "server") => {
		try {
			await backend.saveSettings(scope(), { stylePreset });
			await loadSettings();
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	};
	const whose = () => (scope() === "user" ? "my" : "this project's");
	const clearAll = async () => {
		const answer = await choose(`Clear all of ${whose()} overrides? Every value goes back to what it inherits, and this cannot be undone.`, ["Clear overrides"], { danger: "Clear overrides" });
		if (answer) await write({});
	};
	const set = (path: string, value: unknown) => void write(setPath(current(), path, value));
	const effective = (path: string) => getPath(state.settings.ssl, path) ?? getPath(SERVER_DEFAULTS, path);
	const rules = () => {
		const seen = new Set<string>(Object.keys(getPath(state.settings.ssl, "diagnostics.rules") ?? {}));
		for (const list of Object.values(diagnostics)) for (const d of list ?? []) if (d.code) seen.add(d.code);
		return [...seen].sort();
	};
	const Input = (props: { field: Field }) => {
		const f = props.field;
		const own = () => getPath(current(), f.path) !== undefined;
		return (
			<label class="profile-field" classList={{ own: own() }} title={own() ? `Set in ${scope()} settings` : "Inherited"}>
				<span>{f.label}</span>
				{f.kind === "boolean" ? (
					<input type="checkbox" checked={Boolean(effective(f.path))} onChange={(e) => set(f.path, e.currentTarget.checked)} />
				) : f.kind === "number" ? (
					<input type="number" min={f.min} max={f.max} value={effective(f.path) ?? ""} placeholder={String(getPath(SERVER_DEFAULTS, f.path) ?? "server default")} onChange={(e) => set(f.path, e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value))} />
				) : (
					<select value={effective(f.path) ?? ""} onChange={(e) => set(f.path, e.currentTarget.value || undefined)}>
						<option value="">server default</option>
						<For each={f.options}>{(o) => <option value={o}>{o}</option>}</For>
					</select>
				)}
				<Show when={own()}>
					<button class="reset" title="Clear: inherit" aria-label={`Clear ${f.label}: inherit`} onClick={(e) => (e.preventDefault(), set(f.path, undefined))}>
						↺
					</button>
				</Show>
			</label>
		);
	};
	return (
		<Show when={open()}>
			<Modal class="dialog profile" labelledBy={titleId} onClose={() => setOpen(false)}>
				<div class="profile-head">
					<h2 id={titleId}>Style profile</h2>
					<span class="spacer" />
					<select aria-label="Whose profile this is" value={scope()} onChange={(e) => setScope(e.currentTarget.value as any)}>
						<option value="user">For me (every project)</option>
						<option value="workspace" disabled={!state.workspace}>
							For this project
						</option>
					</select>
				</div>
				<p class="hint">
					These are the language server's own settings; it formats and checks with them. Workspace values override yours; both live outside the code.
				</p>
				<Show when={loadError()}>
					<p class="profile-error" role="alert">
						The settings could not be read: {loadError()}
					</p>
				</Show>
				<div class="profile-presets">
					<label for={presetId}>Start from</label>
					<select id={presetId} value={state.settings.stylePreset} onChange={(e) => void preset(e.currentTarget.value as "house" | "server")}>
						<option value="house">the house style</option>
						<option value="server">the server's defaults</option>
					</select>
					<button onClick={() => void clearAll()} disabled={!Object.keys(current()).length}>
						Clear {whose()} overrides
					</button>
				</div>
				<div class="profile-sections">
					<For each={SECTIONS}>
						{(section) => (
							<fieldset>
								<legend>{section.title}</legend>
								<For each={section.fields}>{(f) => <Input field={f} />}</For>
							</fieldset>
						)}
					</For>
					<fieldset>
						<legend>Rules</legend>
						<Show when={rules().length} fallback={<p class="hint">Rules appear here once the server reports them in an open file.</p>}>
							<For each={rules()}>
								{(rule) => (
									<label class="profile-field">
										<span>{rule}</span>
										<select value={getPath(state.settings.ssl, `diagnostics.rules.${rule}`) ?? "default"} onChange={(e) => set(`diagnostics.rules.${rule}`, e.currentTarget.value === "default" ? undefined : e.currentTarget.value)}>
											<For each={RULE_LEVELS}>{(l) => <option value={l}>{l}</option>}</For>
										</select>
									</label>
								)}
							</For>
						</Show>
					</fieldset>
				</div>
				<div class="buttons">
					<button class="primary" onClick={() => setOpen(false)}>
						Done
					</button>
				</div>
			</Modal>
		</Show>
	);
}
