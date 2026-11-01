// Settings: theme, editor, format on save, the language server's path.
import { createSignal, For, Show } from "solid-js";
import { backend } from "./backend";
import { commands, keysFor, onOpenSettings } from "./commands";
import { loadSettings, notify, saveSetting, state } from "./state";

export function SettingsDialog() {
	const [open, setOpen] = createSignal(false);
	const [capturing, setCapturing] = createSignal<string | null>(null);
	window.addEventListener(
		"keydown",
		(e) => {
			const id = capturing();
			if (!id || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
			e.preventDefault();
			e.stopPropagation();
			setCapturing(null);
			if (e.key === "Escape") return;
			const key = `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${e.altKey ? "alt+" : ""}${e.shiftKey ? "shift+" : ""}${e.key.toLowerCase()}`;
			// Unbind the command's old keys, bind the new one.
			const keys = { ...state.settings.keys };
			for (const k of keysFor(id).toLowerCase().split(", ").filter(Boolean)) keys[k] = "";
			keys[key] = id;
			void saveSetting({ keys });
		},
		true,
	);
	onOpenSettings(() => setOpen(true));
	const importTheme = async () => {
		try {
			const theme = await backend.importTheme();
			if (!theme) return notify("Theme import needs the app's file dialog; copy the theme into ~/.config/ssl-studio/themes/ instead.");
			await loadSettings();
			await saveSetting({ theme: theme.id });
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	};
	return (
		<Show when={open()}>
			<div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
				<div class="dialog settings" role="dialog" aria-label="Settings">
					<h2>Settings</h2>
					<label>
						Theme
						<select value={state.settings.theme} onChange={(e) => void saveSetting({ theme: e.currentTarget.value })}>
							<option value="system">Follow the system</option>
							<option value="dark">Studio Dark</option>
							<option value="light">Studio Light</option>
							<For each={state.themes}>{(t) => <option value={t.id}>{t.name}</option>}</For>
						</select>
					</label>
					<button onClick={() => void importTheme()}>Import a VS Code theme…</button>
					<label>
						Font size
						<input type="number" min="8" max="32" value={state.settings.fontSize} onChange={(e) => void saveSetting({ fontSize: Number(e.currentTarget.value) || 13 })} />
					</label>
					<label class="check">
						<input type="checkbox" checked={state.settings.formatOnSave} onChange={(e) => void saveSetting({ formatOnSave: e.currentTarget.checked })} />
						Format changed lines on save
					</label>
					<label class="check">
						<input type="checkbox" checked={state.settings.minimap} onChange={(e) => void saveSetting({ minimap: e.currentTarget.checked })} />
						Minimap
					</label>
					<label>
						starlims-lsp path (empty: find it)
						<input value={state.settings.lspPath ?? ""} onChange={(e) => void saveSetting({ lspPath: e.currentTarget.value || undefined })} />
					</label>
					<details class="shortcuts">
						<summary>Keyboard shortcuts</summary>
						<For each={commands}>
							{(c) => (
								<div class="shortcut-row">
									<span>{c.label}</span>
									<span class="hint">{capturing() === c.id ? "press keys…" : keysFor(c.id) || "—"}</span>
									<button onClick={() => setCapturing(c.id)}>Set</button>
								</div>
							)}
						</For>
						<button onClick={() => void saveSetting({ keys: {} })}>Reset to defaults</button>
					</details>
					<p class="hint">
						Language server: {state.info?.lsp.path ?? "not found"} {state.info?.lsp.message ? `— ${state.info.lsp.message}` : ""}
					</p>
					<div class="buttons">
						<button class="primary" onClick={() => setOpen(false)}>
							Done
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
}
