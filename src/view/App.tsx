// The window: activity bar, side bar, editor groups, bottom panel, status bar.
import { createEffect, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { backend } from "./backend";
import { Dialogs } from "./dialogs";
import { review, ReviewView } from "./editor/Review";
import { EditorGroup } from "./editor/EditorGroup";
import { commands } from "./commands";
import { Explorer } from "./panels/Explorer";
import { History } from "./panels/History";
import { Objects, useSymbols } from "./panels/Objects";
import { Output, Problems, counts } from "./panels/Problems";
import { Search } from "./panels/Search";
import { Palette } from "./panels/Palette";
import { Reference } from "./panels/Reference";
import { Health } from "./panels/Health";
import { StyleProfile } from "./StyleProfile";
import { AgentPanel } from "./agent/Agent";
import { GraphView } from "./graph/GraphView";
import { session } from "./lsp/session";
import { QuickPick } from "./QuickPick";
import { SettingsDialog } from "./Settings";
import { StatusBar } from "./StatusBar";
import { applyTheme, resolveTheme } from "./themes/themes";
import { openFolder, setState, state, type PanelId } from "./state";
import { isOpen, movePanel, PANELS, sideOf, togglePanel } from "./panels/registry";
import { Welcome } from "./Welcome";



function Splitter(props: { axis: "x" | "y"; column?: number; onDrag: (delta: number) => void }) {
	return (
		<div
			class={`splitter ${props.axis}`}
			style={props.column ? { "grid-column": String(props.column) } : undefined}
			onMouseDown={(start) => {
				start.preventDefault();
				let last = props.axis === "x" ? start.clientX : start.clientY;
				const move = (e: MouseEvent) => {
					const now = props.axis === "x" ? e.clientX : e.clientY;
					props.onDrag(now - last);
					last = now;
				};
				const up = () => (window.removeEventListener("mousemove", move), window.removeEventListener("mouseup", up));
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			}}
		/>
	);
}

function useTheme() {
	const media = matchMedia("(prefers-color-scheme: light)");
	const apply = () => applyTheme(resolveTheme(state.settings.theme, state.themes));
	createEffect(on([() => state.settings.theme, () => state.themes], apply));
	media.addEventListener("change", apply);
	onCleanup(() => media.removeEventListener("change", apply));
}

function useLayoutPersistence() {
	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(
		on(
			() => JSON.stringify(state.settings.layout),
			(layout, previous) => {
				if (previous === undefined || !state.workspace) return;
				clearTimeout(timer);
				timer = setTimeout(() => void backend.saveSettings("workspace", { layout: JSON.parse(layout) }), 600);
			},
		),
	);
}

/** One panel by id, whichever side it is docked on. */
function Panel(props: { id: PanelId }) {
	return (
		<Switch>
			<Match when={props.id === "explorer"}>
				<Explorer />
			</Match>
			<Match when={props.id === "objects"}>
				<Objects />
			</Match>
			<Match when={props.id === "palette"}>
				<Palette />
			</Match>
			<Match when={props.id === "reference"}>
				<Reference />
			</Match>
			<Match when={props.id === "search"}>
				<Search />
			</Match>
			<Match when={props.id === "history"}>
				<History />
			</Match>
			<Match when={props.id === "health"}>
				<Health />
			</Match>
			<Match when={props.id === "agent"}>
				<AgentPanel />
			</Match>
		</Switch>
	);
}

function PanelButton(props: { id: PanelId }) {
	const panel = () => PANELS.find((p) => p.id === props.id)!;
	return (
		<button
			title={`${panel().title} (right-click: move to the ${sideOf(props.id) === "left" ? "right" : "left"} side)`}
			classList={{ active: isOpen(props.id) }}
			onClick={() => togglePanel(props.id)}
			onContextMenu={(e) => (e.preventDefault(), movePanel(props.id))}
		>
			{panel().icon}
		</button>
	);
}

export function App() {
	useTheme();
	// A changed style profile goes to the language server, which re-checks.
	createEffect(on(() => JSON.stringify(state.settings.ssl), (_now, before) => before !== undefined && session.configure()));
	useSymbols();
	useLayoutPersistence();
	const layout = () => state.settings.layout;
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	return (
		<div class="app" style={{ "--left": `${layout().left ? layout().leftWidth : 0}px`, "--right": `${layout().right ? layout().rightWidth : 0}px`, "--bottom": `${layout().bottom ? layout().bottomHeight : 0}px` }}>
			<nav class="activity" aria-label="Views">
				<For each={PANELS.filter((p) => sideOf(p.id) === "left")}>{(p) => <PanelButton id={p.id} />}</For>
				<button title="Graph of calls (Ctrl+Shift+G)" classList={{ active: state.centerView === "graph" }} onClick={() => setState("centerView", state.centerView === "graph" ? "editors" : "graph")}>
					⌬
				</button>
				<span class="spacer" />
				<For each={PANELS.filter((p) => sideOf(p.id) === "right")}>{(p) => <PanelButton id={p.id} />}</For>
				<button title="Command palette (Ctrl+Shift+P)" onClick={() => setState("quickPick", "commands")}>
					⌘
				</button>
				<button title="Settings (Ctrl+,)" onClick={() => commands.find((c) => c.id === "settings")!.run()}>
					⚙
				</button>
			</nav>
			<Show when={layout().left && state.workspace}>
				<aside class="sidebar">
					<Panel id={state.leftView} />
				</aside>
				<Splitter axis="x" column={3} onDrag={(d) => setState("settings", "layout", "leftWidth", (w) => clamp(w + d, 160, 700))} />
			</Show>
			<main class="center">
				<div class="editors">
					<Show when={state.workspace} fallback={<Welcome />}>
						<Show when={state.centerView === "graph"}>
							<GraphView />
						</Show>
						<Show when={state.centerView === "editors"}>
							<Show when={review()} keyed fallback={<For each={state.groups}>{(_, i) => <EditorGroup index={i()} />}</For>}>
								{(_r) => <ReviewView />}
							</Show>
						</Show>
					</Show>
				</div>
				<Show when={layout().bottom && state.workspace}>
					<Splitter axis="y" onDrag={(d) => setState("settings", "layout", "bottomHeight", (h) => clamp(h - d, 80, 600))} />
					<section class="bottom">
						<div class="bottom-tabs">
							<button classList={{ active: state.bottomView === "problems" }} onClick={() => setState("bottomView", "problems")}>
								Problems <span class="count">{counts().errors + counts().warnings + counts().other}</span>
							</button>
							<button classList={{ active: state.bottomView === "output" }} onClick={() => setState("bottomView", "output")}>
								Output
							</button>
							<span class="spacer" />
							<button title="Close panel (Ctrl+J)" onClick={() => setState("settings", "layout", "bottom", false)}>
								×
							</button>
						</div>
						<Switch>
							<Match when={state.bottomView === "problems"}>
								<Problems />
							</Match>
							<Match when={state.bottomView === "output"}>
								<Output />
							</Match>
						</Switch>
					</section>
				</Show>
			</main>
			<Show when={layout().right && state.workspace}>
				<Splitter axis="x" column={5} onDrag={(d) => setState("settings", "layout", "rightWidth", (w) => clamp(w - d, 220, 800))} />
				<aside class="rightbar">
					<Panel id={state.rightView} />
				</aside>
			</Show>
			<StatusBar />
			<div class="toasts" aria-live="polite">
				<For each={state.messages}>{(m) => <div class={`toast ${m.kind}`}>{m.text}</div>}</For>
			</div>
			<QuickPick />
			<SettingsDialog />
			<StyleProfile />
			<Dialogs />
		</div>
	);
}

export { openFolder };
