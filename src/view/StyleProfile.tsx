// The style profile editor: the language server's `ssl` settings, per user
// or per workspace, with the house preset (decisions 0002, 0005, 0006).
import { Icon } from "./Icon";
import { createEffect, createMemo, createSignal, createUniqueId, For, onSettled, Show, untrack } from "solid-js";
import { createAsyncQuery } from "./asyncQuery";
import { getPath, HOUSE_STYLE, SERVER_DEFAULTS, RULE_LEVELS, SECTIONS, setPath, type Field, type PathKey } from "../shared/styleProfile";
import { backend } from "./backend";
import { choose } from "./dialogs";
import { diagnostics, session } from "./lsp/session";
import { monaco } from "./editor/monaco";
import { Modal } from "./modal";
import { loadSettings, notify, state } from "./state";

/**
 * A few untidy lines, written for this dialog, that touch what the profile
 * decides: spacing, indentation, blank lines, the case of a built-in and the
 * layout of a SQL string.
 */
const SAMPLE = `:PROCEDURE LateSamples;
:PARAMETERS nDays,sPriority;
:DECLARE aRows,nIndex,sText;
aRows:=sqlexecute("select SAMPLE_ID, DUE_ON from DEMO_SAMPLES where DUE_ON < ? and PRIORITY = ? order by DUE_ON",,,{today()-nDays,sPriority});
sText:="";
:FOR nIndex:=1 :TO alen(aRows);
:IF empty(aRows[nIndex][2]);
:LOOP;
:ENDIF;
sText:=sText+aRows[nIndex][1]+chr(13);
:NEXT;


:RETURN sText;
:ENDPROC;
`;

type LayersState = {
	user: Record<string, any>;
	workspace: Record<string, any>;
	userPreset: "house" | "server" | undefined;
	workspacePreset: "house" | "server" | undefined;
};

const [open, setOpen] = createSignal(false);
export const openStyleProfile = () => setOpen(true);

export function StyleProfile() {
	const [scope, setScope] = createSignal<"user" | "workspace">("user");
	const [layers, setLayers] = createSignal<LayersState>({ user: {}, workspace: {}, userPreset: undefined, workspacePreset: undefined });
	/** Why the settings could not be read: said in the dialog, not swallowed. */
	const [loadError, setLoadError] = createSignal("");
	const titleId = createUniqueId();
	const presetId = createUniqueId();
	let writeChain: Promise<void> = Promise.resolve();
	let pendingWrites = 0;

	const reload = async () => {
		try {
			const s = await backend.settings();
			setLayers({
				user: s.user.ssl ?? {},
				workspace: s.workspace.ssl ?? {},
				userPreset: s.user.stylePreset,
				workspacePreset: s.workspace.stylePreset,
			});
			setLoadError("");
		} catch (e: any) {
			setLoadError(String(e?.message ?? e));
		}
	};
	createEffect(
		() => open(),
		(isOpen) => {
			if (isOpen) void reload();
		},
	);
	createEffect(
		() => !state.workspace && scope() === "workspace",
		(reset) => {
			if (reset) setScope("user");
		},
	);
	const current = () => layers()[scope()];

	const previewTabSize = () => {
		const raw = Number(getPath(state.settings.ssl, "format.indentSize") ?? SERVER_DEFAULTS.format.indentSize);
		return Number.isFinite(raw) ? Math.max(1, Math.min(8, Math.round(raw))) : SERVER_DEFAULTS.format.indentSize;
	};
	const previewInsertSpaces = () => (getPath(state.settings.ssl, "format.indentStyle") ?? SERVER_DEFAULTS.format.indentStyle) === "space";

	// What the profile does, shown: the sample is formatted again whenever a setting changes. The wait lets the
	// change reach the server first (App sends it when the settings change).
	const [preview] = createAsyncQuery(
		() => {
			if (!open() || state.lsp.state !== "running" || !state.workspace) return false as const;
			return [state.workspace.root, JSON.stringify(state.settings.ssl ?? {}), state.settings.theme, state.settings.themeMaterial ?? "", previewTabSize(), previewInsertSpaces()] as const;
		},
		async ([, , , , tabSize, insertSpaces]) => {
			await new Promise((done) => setTimeout(done, 150));
			try {
				const formatted = await session.formatText(SAMPLE, { tabSize, insertSpaces });
				return { html: await monaco.editor.colorize(formatted, "ssl", { tabSize }), error: "" };
			} catch (e: any) {
				return { html: "", error: String(e?.message ?? e) };
			}
		},
	);

	// Serialize writes and apply optimistic updates to `layers()` so rapid clicks chain cleanly instead of overwriting each other.
	const enqueueSave = (targetScope: "user" | "workspace", patch: Record<string, unknown>) => {
		pendingWrites++;
		const task = writeChain.then(async () => {
			try {
				await backend.saveSettings(targetScope, patch);
			} catch (e: any) {
				notify(String(e?.message ?? e), "error");
			} finally {
				pendingWrites--;
				if (pendingWrites === 0) {
					await Promise.all([reload(), loadSettings()]);
				}
			}
		});
		writeChain = task.catch(() => {});
		return task;
	};

	const set = (path: PathKey, value: unknown) => {
		const targetScope = scope();
		let nextSsl: Record<string, any> = {};
		setLayers((prev) => {
			nextSsl = setPath(prev[targetScope], path, value);
			return { ...prev, [targetScope]: nextSsl };
		});
		void enqueueSave(targetScope, { ssl: nextSsl });
	};

	const preset = (stylePreset: "house" | "server") => {
		const targetScope = scope();
		setLayers((prev) => ({
			...prev,
			...(targetScope === "user" ? { userPreset: stylePreset } : { workspacePreset: stylePreset }),
		}));
		void enqueueSave(targetScope, { stylePreset });
	};

	const whose = () => (scope() === "user" ? "my" : "this project's");
	const clearAll = async () => {
		const targetScope = scope();
		const label = targetScope === "user" ? "my" : "this project's";
		const answer = await choose(`Clear all of ${label} overrides? Every value goes back to what it inherits, and this cannot be undone.`, ["Clear overrides"], { danger: "Clear overrides" });
		if (!answer) return;
		setLayers((prev) => ({ ...prev, [targetScope]: {} }));
		await enqueueSave(targetScope, { ssl: {} });
	};

	const userBaseStyle = () => ((layers().userPreset ?? "house") === "server" ? {} : HOUSE_STYLE);
	const effectiveBaseStyle = () => ((layers().workspacePreset ?? state.settings.stylePreset) === "server" ? {} : HOUSE_STYLE);

	/** Displayed value for the selected scope (`user`: baseStyle + user; `workspace`: full effective). */
	const displayed = (path: PathKey) => {
		if (scope() === "user") {
			return getPath(layers().user, path) ?? getPath(userBaseStyle(), path) ?? getPath(SERVER_DEFAULTS, path);
		}
		return getPath(layers().workspace, path) ?? getPath(layers().user, path) ?? getPath(effectiveBaseStyle(), path) ?? getPath(state.settings.ssl, path) ?? getPath(SERVER_DEFAULTS, path);
	};

	/** Fallback value inherited from lower layers, skipping the active scope's own override. */
	const inheritedValue = (path: PathKey) => {
		if (scope() === "user") {
			return getPath(userBaseStyle(), path) ?? getPath(SERVER_DEFAULTS, path);
		}
		return getPath(layers().user, path) ?? getPath(effectiveBaseStyle(), path) ?? getPath(SERVER_DEFAULTS, path);
	};

	/** Non-undefined when viewing user scope and the open workspace overrides this path. */
	const workspaceOverride = (path: PathKey) => (scope() === "user" && state.workspace ? getPath(layers().workspace, path) : undefined);

	const displayedRule = (rule: string): string => {
		const path = ["diagnostics", "rules", rule] as const;
		if (scope() === "user") {
			return getPath(layers().user, path) ?? getPath(userBaseStyle(), path) ?? "default";
		}
		return getPath(layers().workspace, path) ?? getPath(layers().user, path) ?? getPath(effectiveBaseStyle(), path) ?? getPath(state.settings.ssl, path) ?? "default";
	};

	const inheritedRule = (rule: string): string | undefined => {
		const path = ["diagnostics", "rules", rule] as const;
		if (scope() === "workspace") {
			return getPath(layers().user, path) ?? getPath(effectiveBaseStyle(), path);
		}
		return getPath(userBaseStyle(), path);
	};

	const setRule = (rule: string, val: string) => {
		const path = ["diagnostics", "rules", rule] as const;
		if (val === "default") {
			const inherited = inheritedRule(rule);
			// Write explicit "default" when a lower layer (such as HOUSE_STYLE) sets a non-default level,
			// so resetting a rule doesn't silently snap back to "off".
			set(path, inherited && inherited !== "default" ? "default" : undefined);
		} else {
			set(path, val);
		}
	};

	const rules = () => {
		const seen = new Set<string>();
		for (const src of [state.settings.ssl, layers().user, layers().workspace, userBaseStyle()]) {
			for (const k of Object.keys(getPath(src, ["diagnostics", "rules"]) ?? {})) seen.add(k);
		}
		for (const list of Object.values(diagnostics)) for (const d of list ?? []) if (d.code) seen.add(d.code);
		return [...seen].sort();
	};

	const commitNumber = (rawValue: string, field: Extract<Field, { kind: "number" }>): string => {
		const raw = rawValue.trim();
		if (raw === "") {
			set(field.path, undefined);
			return String(inheritedValue(field.path) ?? "");
		}
		const parsed = Number(raw);
		if (!Number.isFinite(parsed)) {
			return String(displayed(field.path) ?? "");
		}
		let clamped = Math.round(parsed);
		if (field.min !== undefined) clamped = Math.max(field.min, clamped);
		if (field.max !== undefined) clamped = Math.min(field.max, clamped);
		set(field.path, clamped);
		return String(clamped);
	};

	const NumberInput = (props: { field: Extract<Field, { kind: "number" }> }) => {
		const displayedText = createMemo(() => String(displayed(props.field.path) ?? ""));
		const [draft, setDraft] = createSignal(untrack(displayedText));
		createEffect(displayedText, (v) => {
			setDraft(v);
		});
		return (
			<input
				type="number"
				min={props.field.min}
				max={props.field.max}
				value={draft()}
				placeholder={String(getPath(SERVER_DEFAULTS, props.field.path) ?? "server default")}
				onInput={(e) => setDraft(e.currentTarget.value)}
				onChange={(e) => {
					const next = commitNumber(e.currentTarget.value, props.field);
					setDraft(next);
					e.currentTarget.value = next;
				}}
			/>
		);
	};

	const Input = (props: { field: Field }) => {
		const f = props.field;
		const own = () => getPath(current(), f.path) !== undefined;
		const wsOverride = () => workspaceOverride(f.path);
		return (
			<label
				class={["profile-field", { own: own() }]}
				title={wsOverride() !== undefined ? `Overridden in this project (${String(wsOverride())})` : own() ? `Set in ${scope()} settings` : "Inherited"}
			>
				<span>
					{f.label}
					<Show when={wsOverride() !== undefined}>
						{" "}
						<span class="hint">(project: {String(wsOverride())})</span>
					</Show>
				</span>
				{f.kind === "boolean" ? (
					<input type="checkbox" checked={Boolean(displayed(f.path))} onChange={(e) => set(f.path, e.currentTarget.checked)} />
				) : f.kind === "number" ? (
					<NumberInput field={f} />
				) : (
					<select
						value={displayed(f.path) ?? ""}
						onChange={(e) => {
							const el = e.currentTarget;
							set(f.path, el.value || undefined);
							onSettled(() => {
								const next = String(untrack(() => displayed(f.path) ?? ""));
								if (el.value !== next) el.value = next;
							});
						}}
					>
						<option value="">server default</option>
						<For each={f.options}>{(o) => <option value={o}>{o}</option>}</For>
					</select>
				)}
				<Show when={own()}>
					<button class="reset" title="Clear: inherit" aria-label={`Clear ${f.label}: inherit`} onClick={(e) => (e.preventDefault(), set(f.path, undefined))}>
						<Icon name="discard" />
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
				<Show when={scope() === "user" && state.workspace && (Object.keys(layers().workspace).length > 0 || (layers().workspacePreset && layers().workspacePreset !== (layers().userPreset ?? "house")))}>
					<p class="hint">
						This project has workspace overrides in effect; fields marked “(project: …)” use this project's value instead of yours.
					</p>
				</Show>
				<Show when={loadError()}>
					<p class="profile-error" role="alert">
						The settings could not be read: {loadError()}
					</p>
				</Show>
				<div class="profile-presets">
					<label for={presetId}>Start from</label>
					<select
						id={presetId}
						value={scope() === "user" ? (layers().userPreset ?? "house") : (layers().workspacePreset ?? state.settings.stylePreset)}
						onChange={(e) => preset(e.currentTarget.value as "house" | "server")}
					>
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
								{(rule) => {
									const path = ["diagnostics", "rules", rule] as const;
									const own = () => getPath(current(), path) !== undefined;
									const wsOverride = () => workspaceOverride(path);
									return (
										<label
											class={["profile-field", { own: own() }]}
											title={wsOverride() !== undefined ? `Overridden in this project (${String(wsOverride())})` : own() ? `Set in ${scope()} settings` : "Inherited"}
										>
											<span>
												{rule}
												<Show when={wsOverride() !== undefined}>
													{" "}
													<span class="hint">(project: {String(wsOverride())})</span>
												</Show>
											</span>
											<select value={displayedRule(rule)} onChange={(e) => setRule(rule, e.currentTarget.value)}>
												<For each={RULE_LEVELS}>{(l) => <option value={l}>{l}</option>}</For>
											</select>
											<Show when={own()}>
												<button class="reset" title="Clear: inherit" aria-label={`Clear ${rule}: inherit`} onClick={(e) => (e.preventDefault(), set(path, undefined))}>
													<Icon name="discard" />
												</button>
											</Show>
										</label>
									);
								}}
							</For>
						</Show>
					</fieldset>
				</div>
				{/* What the profile does to a few untidy lines, as the language server formats them now. */}
				<section class="profile-preview" aria-label="Preview">
					<h3>
						Preview <span class="hint">a sample, formatted with this profile</span>
					</h3>
					<Show when={state.lsp.state === "running" && state.workspace} fallback={<p class="hint">The preview is formatted by the language server, and appears when it is running with a folder open.</p>}>
						<Show when={!preview()?.error} fallback={<p class="hint">The sample could not be formatted: {preview()?.error}</p>}>
							<pre class="block-code" style={{ "tab-size": String(previewTabSize()) }} innerHTML={preview()?.html ?? ""} />
						</Show>
					</Show>
				</section>
				<div class="buttons">
					<button class="primary" onClick={() => setOpen(false)}>
						Done
					</button>
				</div>
			</Modal>
		</Show>
	);
}
