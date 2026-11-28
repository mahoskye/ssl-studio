// VS Code-aligned Output panel: channel selector dropdown (All Channels,
// SSL Studio, STARLIMS Language Server, Agent & MCP, Git, Documents & Audit),
// Clear Output, Auto-Scroll Lock, Word Wrap, Copy Output, and ADR 0050 filtering.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import {
	countOutputByChannel,
	DEFAULT_OUTPUT_LEVEL_FILTER,
	filterOutputEntries,
	formatOutputForCopy,
	isOutputLevelFiltered,
	OUTPUT_CHANNEL_MAP,
	OUTPUT_CHANNELS,
	type OutputChannelSelection,
	type OutputLevel,
	type OutputLevelFilter,
} from "../../shared/outputChannels";
import { FilterBox, filterKey, filterMenuItem, filterToggle } from "../FilterBox";
import { Icon } from "../Icon";
import { Menu } from "../Menu";
import { clearOutput, state } from "../state";

/** How far from its end, in pixels, the Output still counts as showing it. */
const NEAR_END = 40;

/**
 * Whether the Output keeps to its end as lines arrive. It does from when it is opened (what was last written is
 * what it is opened for) until it is scrolled away from the end, and again once it is scrolled back.
 *
 * Where the view stands is taken when it is scrolled, which is before the next line arrives. It was measured after
 * the line was in: a line of three rows or more had by then put the end further off than counts as near, so the
 * view was taken to be scrolled up and never followed again.
 */
export function endFollower() {
	let following = true;
	return {
		/** The view was scrolled, by hand or to its end from here: whether it shows its end now. */
		scrolled(box: { scrollHeight: number; scrollTop: number; clientHeight: number }) {
			following = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_END;
		},
		/** Whether a line that has just arrived is to be shown. */
		following: () => following,
	};
}

// Shared reactive state between `.bottom-tabs` Output header actions and the Output log view.
const [selectedChannel, setSelectedChannel] = createSignal<OutputChannelSelection>("all");
const [levelFilter, setLevelFilter] = createSignal<OutputLevelFilter>({ ...DEFAULT_OUTPUT_LEVEL_FILTER });
const [outputQuery, setOutputQuery] = createSignal("");
const [scrollLocked, setScrollLocked] = createSignal(false);
const [wordWrap, setWordWrap] = createSignal(true);
const [showTimestamps, setShowTimestamps] = createSignal(true);
const outputFilterBox = filterToggle(outputQuery, setOutputQuery);

export function selectOutputChannel(channel: OutputChannelSelection) {
	setSelectedChannel(channel);
}

const isOutputFiltering = () => isOutputLevelFiltered(levelFilter()) || Boolean(outputQuery().trim());

const toggleLevel = (lvl: OutputLevel) => {
	setLevelFilter((prev) => ({ ...prev, [lvl]: !prev[lvl] }));
};

const clearOutputFilters = () => {
	outputFilterBox.clear();
	setLevelFilter({ ...DEFAULT_OUTPUT_LEVEL_FILTER });
};

const visibleOutputEntries = () =>
	filterOutputEntries(state.outputEntries, {
		channel: selectedChannel(),
		levels: levelFilter(),
		query: outputQuery(),
	});

const copyVisibleOutput = async () => {
	const entries = visibleOutputEntries();
	const text = formatOutputForCopy(entries, {
		showTimestamps: showTimestamps(),
		showChannelTag: selectedChannel() === "all",
	});
	const { copyText } = await import("../commands");
	await copyText(text ? `${text}\n` : "", entries.length ? `Copied ${entries.length} output ${entries.length === 1 ? "line" : "lines"}.` : "Output is empty.");
};

/**
 * VS Code-style Output controls mounted directly in `.bottom-tabs` when Output is active:
 * Custom themed channel dropdown, Clear Output, Scroll Lock toggle, and Filter/Options menu (ADR 0050).
 */
export function OutputHeaderActions() {
	const channelCounts = createMemo(() => countOutputByChannel(state.outputEntries));
	const selectedChannelLabel = () => {
		const ch = selectedChannel();
		return ch === "all" ? "All Channels" : OUTPUT_CHANNEL_MAP[ch].label;
	};
	const clearTargetLabel = () => {
		const ch = selectedChannel();
		return ch === "all" ? "All Output" : OUTPUT_CHANNEL_MAP[ch].label;
	};

	return (
		<div class="bottom-output-acts">
			<span class="output-channel-picker" data-output-channel="true">
				<Menu
					floating
					class="output-channel-menu"
					label={`Output channel: ${selectedChannelLabel()}`}
					title={`Select Output channel (${selectedChannelLabel()})`}
					items={() => {
						const counts = channelCounts();
						return [
							{
								label: "All Channels",
								keys: counts.all ? String(counts.all) : undefined,
								checked: selectedChannel() === "all",
								run: () => setSelectedChannel("all"),
							},
							"separator",
							...OUTPUT_CHANNELS.map((ch) => ({
								label: ch.label,
								keys: counts[ch.id] ? String(counts[ch.id]) : undefined,
								checked: selectedChannel() === ch.id,
								run: () => setSelectedChannel(ch.id),
							})),
						];
					}}
				>
					<span class="output-channel-label">{selectedChannelLabel()}</span>
					<Icon name="chevron-down" class="output-channel-chevron" />
				</Menu>
			</span>
			<button
				type="button"
				class="bottom-action"
				data-output-clear="true"
				title={`Clear ${clearTargetLabel()}`}
				aria-label={`Clear ${clearTargetLabel()}`}
				onClick={() => clearOutput(selectedChannel())}
			>
				<Icon name="clear-all" />
			</button>
			<button
				type="button"
				data-output-lock="true"
				class={`bottom-action${scrollLocked() ? " active" : ""}`}
				title={scrollLocked() ? "Turn Auto Scrolling On" : "Turn Auto Scrolling Off"}
				aria-label={scrollLocked() ? "Turn Auto Scrolling On" : "Turn Auto Scrolling Off"}
				aria-pressed={scrollLocked() ? "true" : "false"}
				onClick={() => setScrollLocked((v) => !v)}
			>
				<Icon name={scrollLocked() ? "lock" : "unlock"} />
			</button>
			<Menu
				floating
				class={isOutputFiltering() ? "bottom-action docs-filter-menu on" : "bottom-action docs-filter-menu"}
				label={isOutputFiltering() ? "Filter Output: a filter is on" : "Filter Output"}
				title="Filter Output, word wrap, timestamps, or copy (Ctrl+F)"
				items={() => [
					filterMenuItem(outputFilterBox, undefined, "Filter Output…"),
					"separator",
					{ label: "Show Errors", checked: levelFilter().error, run: () => toggleLevel("error") },
					{ label: "Show Warnings", checked: levelFilter().warn, run: () => toggleLevel("warn") },
					{ label: "Show Info", checked: levelFilter().info, run: () => toggleLevel("info") },
					"separator",
					{ label: "Word Wrap", checked: wordWrap(), run: () => setWordWrap((v) => !v) },
					{ label: "Show Timestamps", checked: showTimestamps(), run: () => setShowTimestamps((v) => !v) },
					{ label: "Copy Output", run: () => void copyVisibleOutput() },
					...(isOutputFiltering()
						? [
								"separator" as const,
								{ label: "Clear Filters", run: clearOutputFilters },
							]
						: []),
				]}
			>
				<Icon name={isOutputFiltering() ? "filter-filled" : "filter"} />
			</Menu>
			<span class="bottom-tab-sep" aria-hidden="true" />
		</div>
	);
}

export function Output() {
	let box: HTMLDivElement | undefined;
	// A new line is followed while the view is at the end (unless scroll-locked).
	const end = endFollower();

	const entries = createMemo(visibleOutputEntries);
	const channelTotal = createMemo(() => {
		const ch = selectedChannel();
		return ch === "all" ? state.outputEntries.length : state.outputEntries.filter((e) => e.channel === ch).length;
	});

	createEffect(
		() => [entries().length, selectedChannel(), scrollLocked()] as const,
		([_len, _ch, locked]) => {
			if (!locked && box && end.following()) {
				queueMicrotask(() => {
					if (box && !scrollLocked()) box.scrollTop = box.scrollHeight;
				});
			}
		},
	);

	const hiddenLevelChips = createMemo(() => {
		const lv = levelFilter();
		const chips: { level: OutputLevel; label: string }[] = [];
		if (!lv.error) chips.push({ level: "error", label: "Errors hidden" });
		if (!lv.warn) chips.push({ level: "warn", label: "Warnings hidden" });
		if (!lv.info) chips.push({ level: "info", label: "Info hidden" });
		return chips;
	});

	return (
		<div class="output-wrap" onKeyDown={(e) => filterKey(e, outputFilterBox)}>
			<Show when={outputFilterBox.shown() || hiddenLevelChips().length > 0}>
				<div class="output-filter-bar">
					<FilterBox
						toggle={outputFilterBox}
						label="Filter output log lines"
						placeholder="Filter output…"
						value={outputQuery()}
						onInput={setOutputQuery}
					/>
					<Show when={hiddenLevelChips().length > 0}>
						<div class="docs-filter-chips" role="group" aria-label="Active Output level filters">
							<For each={hiddenLevelChips()}>
								{(chip) => (
									<button type="button" class="docs-tag-active" title={`Show ${chip.level} entries again`} onClick={() => toggleLevel(chip.level)}>
										<span>{chip.label}</span>
										<Icon name="close" />
									</button>
								)}
							</For>
						</div>
					</Show>
					<Show when={isOutputFiltering()}>
						<span class="output-filter-count">
							{entries().length} of {channelTotal()}
						</span>
					</Show>
				</div>
			</Show>

			<div
				class={`output${wordWrap() ? " wrap" : " nowrap"}`}
				role="log"
				aria-live="off"
				aria-label={selectedChannel() === "all" ? "All output logs" : `${OUTPUT_CHANNEL_MAP[selectedChannel() as keyof typeof OUTPUT_CHANNEL_MAP].label} output`}
				ref={box}
				onScroll={(e) => end.scrolled(e.currentTarget)}
			>
				<Show
					when={entries().length > 0}
					fallback={
						<div class="output-empty-state">
							<Show
								when={isOutputFiltering() && channelTotal() > 0}
								fallback={
									<Show
										when={selectedChannel() !== "all"}
										fallback={
											<span class="output-empty">
												Nothing here yet. Output keeps workspace events, language server logs, Agent &amp; MCP status, Git activity, and document audit summaries.
											</span>
										}
									>
										<span class="output-empty">
											No entries in <strong>{OUTPUT_CHANNEL_MAP[selectedChannel() as keyof typeof OUTPUT_CHANNEL_MAP].label}</strong> yet.{" "}
											{OUTPUT_CHANNEL_MAP[selectedChannel() as keyof typeof OUTPUT_CHANNEL_MAP].description}
										</span>
										<Show when={state.outputEntries.length > 0}>
											<button type="button" class="link output-empty-link" onClick={() => setSelectedChannel("all")}>
												Show All Channels ({state.outputEntries.length})
											</button>
										</Show>
									</Show>
								}
							>
								<span class="output-empty">No output lines match the current filter.</span>
								<button type="button" class="link output-empty-link" onClick={clearOutputFilters}>
									Clear filter
								</button>
							</Show>
						</div>
					}
				>
					<For each={entries()} keyed={(e) => e.id}>
						{(entry) => (
							<div class={`output-line level-${entry().level}`} data-output-entry-channel={entry().channel}>
								<Show when={showTimestamps()}>
									<span class="output-time">{entry().time}</span>
								</Show>
								<Show when={selectedChannel() === "all"}>
									<span class={`output-ch ch-${entry().channel}`} title={OUTPUT_CHANNEL_MAP[entry().channel].label}>
										{OUTPUT_CHANNEL_MAP[entry().channel].shortLabel}
									</span>
								</Show>
								<span class="output-text">{entry().text}</span>
							</div>
						)}
					</For>
				</Show>
			</div>
		</div>
	);
}
