// History & House-Style Limits settings section (ADR 0052 & ADR 0053):
// surfaces SQLite local history storage metrics + clear action and house-style script thresholds.
import { createEffect, createSignal, Show } from "solid-js";
import { DEFAULT_SETTINGS, type HistoryStats, type Settings, type SettingsScope } from "../../shared/protocol";
import { isSettingDefinedInScope, type SettingsLayers } from "../../shared/settingsSchema";
import { backend } from "../backend";
import { choose } from "../dialogs";
import { Icon } from "../Icon";
import { formatWorkspaceStorageSummary } from "../panels/historyTimeline";
import { historyChanged, notify, state } from "../state";

export function StorageLimitsSection(props: {
	scope: SettingsScope;
	layers: SettingsLayers;
	showLimits: boolean;
	onSave: <K extends keyof Settings>(key: K, value: Settings[K] | null) => Promise<boolean>;
}) {
	const [stats, setStats] = createSignal<HistoryStats | null>(null);
	const [clearing, setClearing] = createSignal(false);

	const loadStats = () => {
		if (!state.workspace) {
			setStats(null);
			return;
		}
		void backend.historyStats().then(
			(s) => setStats(s),
			() => setStats(null),
		);
	};

	createEffect(
		() => state.workspace?.root ?? "",
		() => loadStats(),
	);

	const limits = () => state.settings.limits ?? DEFAULT_SETTINGS.limits;
	const modified = () => isSettingDefinedInScope("limits", props.layers, props.scope);

	const saveLimitField = async (field: keyof Settings["limits"], raw: string) => {
		const parsed = Number(raw.trim());
		const fallback = DEFAULT_SETTINGS.limits[field];
		const clamped = Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
		await props.onSave("limits", { ...limits(), [field]: clamped });
	};

	const clearUnpinned = async () => {
		const picked = await choose(
			"Clear all unpinned local history snapshots for this workspace? Pinned checkpoints will be preserved.",
			["Clear unpinned"],
		);
		if (picked !== "Clear unpinned") return;
		setClearing(true);
		try {
			const removed = await backend.historyClear(undefined, true);
			historyChanged.fire("");
			loadStats();
			notify(removed ? `Removed ${removed} unpinned local snapshots.` : "No unpinned snapshots to clear.");
		} catch (e: any) {
			notify(`Could not clear local history: ${String(e?.message ?? e)}`, "error");
		} finally {
			setClearing(false);
		}
	};

	return (
		<div class="settings-subsection">
			<div class="settings-callout-card">
				<div class="settings-callout-main">
					<Icon name="database" />
					<div>
						<strong>Local History (SQLite)</strong>
						<p>
							{state.workspace
								? `${formatWorkspaceStorageSummary(stats())} · Gzipped content-addressed blobs · 90-day TTL · 128 MB workspace cap.`
								: "Open a workspace to inspect its SQLite local history footprint."}
						</p>
					</div>
				</div>
				<Show when={state.workspace}>
					<button
						type="button"
						disabled={clearing() || !(stats()?.workspaceSnapshots)}
						onClick={() => void clearUnpinned()}
					>
						{clearing() ? "Clearing…" : "Clear Unpinned…"}
					</button>
				</Show>
			</div>

			<Show when={props.showLimits}>
				<div class={["settings-item", { modified: modified() }]}>
					<div class="settings-item-head">
						<span class="settings-item-cat">History &amp; Limits</span>
						<span class="settings-item-title">House-style script limits</span>
						<Show when={modified()}>
							<button
								type="button"
								class="settings-reset-btn"
								title="Reset house-style limits"
								onClick={() => void props.onSave("limits", null)}
							>
								<Icon name="discard" />
							</button>
						</Show>
					</div>
					<p class="settings-item-desc">
						Advisory limits for STARLIMS script bytes, code lines, and changelog entries shown in Status Bar and Health (program decision 0006).
					</p>
					<div class="settings-limits-grid">
						<label class="settings-limit-field">
							<span>Max bytes</span>
							<input
								type="number"
								min="0"
								value={String(limits().bytes)}
								onChange={(e) => void saveLimitField("bytes", e.currentTarget.value)}
							/>
						</label>
						<label class="settings-limit-field">
							<span>Max code lines</span>
							<input
								type="number"
								min="0"
								value={String(limits().codeLines)}
								onChange={(e) => void saveLimitField("codeLines", e.currentTarget.value)}
							/>
						</label>
						<label class="settings-limit-field">
							<span>Changelog entries</span>
							<input
								type="number"
								min="0"
								value={String(limits().historyEntries)}
								onChange={(e) => void saveLimitField("historyEntries", e.currentTarget.value)}
							/>
						</label>
					</div>
				</div>
			</Show>
		</div>
	);
}
