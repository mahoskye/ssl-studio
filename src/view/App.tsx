// The window: activity bar, side bar, editor groups, bottom panel, status bar.
import { createEffect, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { backend } from "./backend";
import { Dialogs } from "./dialogs";
import { DiffView } from "./editor/DiffView";
import { EditorGroup } from "./editor/EditorGroup";
import { commands } from "./commands";
import { Explorer } from "./panels/Explorer";
import { History } from "./panels/History";
import { Objects, useSymbols } from "./panels/Objects";
import { Output, Problems, counts } from "./panels/Problems";
import { Search } from "./panels/Search";
import { QuickPick } from "./QuickPick";
import { SettingsDialog } from "./Settings";
import { StatusBar } from "./StatusBar";
import { applyTheme, resolveTheme } from "./themes/themes";
import { openFolder, setState, state, type LeftView } from "./state";
import { Welcome } from "./Welcome";

const VIEWS: { id: LeftView; icon: string; title: string }[] = [
	{ id: "explorer", icon: "🗀", title: "Explorer (Ctrl+Shift+E)" },
	{ id: "objects", icon: "◇", title: "Objects" },
	{ id: "search", icon: "⌕", title: "Search (Ctrl+Shift+F)" },
	{ id: "history", icon: "⟲", title: "Local history" },
];

function Splitter(props: { axis: "x" | "y"; onDrag: (delta: number) => void }) {
	return (
		<div
			class={`splitter ${props.axis}`}
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

export function App() {
	useTheme();
	useSymbols();
	useLayoutPersistence();
	const layout = () => state.settings.layout;
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	return (
		<div class="app" style={{ "--left": `${layout().left ? layout().leftWidth : 0}px`, "--bottom": `${layout().bottom ? layout().bottomHeight : 0}px` }}>
			<nav class="activity" aria-label="Views">
				<For each={VIEWS}>
					{(view) => (
						<button
							title={view.title}
							classList={{ active: layout().left && state.leftView === view.id }}
							onClick={() => {
								if (layout().left && state.leftView === view.id) setState("settings", "layout", "left", false);
								else (setState("leftView", view.id), setState("settings", "layout", "left", true));
							}}
						>
							{view.icon}
						</button>
					)}
				</For>
				<span class="spacer" />
				<button title="Command palette (Ctrl+Shift+P)" onClick={() => setState("quickPick", "commands")}>
					⌘
				</button>
				<button title="Settings (Ctrl+,)" onClick={() => commands.find((c) => c.id === "settings")!.run()}>
					⚙
				</button>
			</nav>
			<Show when={layout().left && state.workspace}>
				<aside class="sidebar">
					<Switch>
						<Match when={state.leftView === "explorer"}>
							<Explorer />
						</Match>
						<Match when={state.leftView === "objects"}>
							<Objects />
						</Match>
						<Match when={state.leftView === "search"}>
							<Search />
						</Match>
						<Match when={state.leftView === "history"}>
							<History />
						</Match>
					</Switch>
				</aside>
				<Splitter axis="x" onDrag={(d) => setState("settings", "layout", "leftWidth", (w) => clamp(w + d, 160, 700))} />
			</Show>
			<main class="center">
				<div class="editors">
					<Show when={state.workspace} fallback={<Welcome />}>
						<Show when={state.diffWith} fallback={<For each={state.groups}>{(_, i) => <EditorGroup index={i()} />}</For>}>
							<DiffView />
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
			<StatusBar />
			<div class="toasts" aria-live="polite">
				<For each={state.messages}>{(m) => <div class={`toast ${m.kind}`}>{m.text}</div>}</For>
			</div>
			<QuickPick />
			<SettingsDialog />
			<Dialogs />
		</div>
	);
}

export { openFolder };
