// The window: menu bar, activity bar, side bar, editor groups, bottom panel, status bar.
import { Icon } from "./Icon";
import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { backend } from "./backend";
import { Dialogs } from "./dialogs";
import { RowMenu } from "./panels/RowMenu";
import { review, ReviewView } from "./editor/Review";
import { CenterTabStrip } from "./editor/CenterTabStrip";
import { EditorGroup } from "./editor/EditorGroup";
import { commands, keysFor } from "./commands";
import { clampScale } from "./uiScale";
import { Explorer } from "./panels/Explorer";
import { History } from "./panels/History";
import { GitPanel } from "./panels/Git";
import { useGit } from "./git";
import { Objects, useSymbols } from "./panels/Objects";
import { Output, Problems, counts } from "./panels/Problems";
import { Search } from "./panels/Search";
import { Palette } from "./panels/Palette";
import { Reference } from "./panels/Reference";
import { Health } from "./panels/Health";
import { Docs } from "./panels/Docs";
import { setUpProject, useProject } from "./project";
import { StyleProfile } from "./StyleProfile";
import { AgentPanel } from "./agent/Agent";
import { GraphView } from "./graph/GraphView";
import { session } from "./lsp/session";
import { QuickPick } from "./QuickPick";
import { SettingsDialog } from "./Settings";
import { MenuBar } from "./MenuBar";
import { useNavigation } from "./navigation";
import { StatusBar } from "./StatusBar";
import { applyFonts, applyTheme, resolveTheme } from "./themes/themes";
import { activePath, dismiss, focusRequest, notify, openFolder, rememberTabs, rememberViews, setState, state, unsavedPaths, type PanelId } from "./state";
import { focusPanel, isPanelAvailable, isShown, lastShown, movePanel, narrowHosted, narrowPanels, panelOn, PANELS, setCrowded, setNarrowHosted, setNarrowPanels, sideOf, togglePanel } from "./panels/registry";
import { isPlanPath } from "./plan/model";
import { isMarkdown, isTable } from "./project";
import { Welcome } from "./Welcome";
import { ACTIVITY, CENTER_MIN, crowdedSides, fitPanels, LEFT_MIN, RIGHT_MIN } from "./layout";



/**
 * The bar between two parts of the window. Dragged with the mouse, or moved
 * with the arrow keys when it has the keyboard; a double-click or Home puts
 * it back where it started.
 */
function Splitter(props: { axis: "x" | "y"; column?: number; label: string; value: number; min: number; max: number; onDrag: (delta: number) => void; onReset: () => void }) {
	return (
		<div
			class={`splitter ${props.axis}${props.column === 5 ? " after-editors" : ""}`}
			role="separator"
			tabindex={0}
			aria-orientation={props.axis === "x" ? "vertical" : "horizontal"}
			aria-label={props.label}
			aria-valuenow={Math.round(props.value)}
			aria-valuemin={props.min}
			aria-valuemax={props.max}
			title={`${props.label}: drag, or use the arrow keys. Double-click to reset.`}
			style={props.column ? { "grid-column": String(props.column) } : undefined}
			onDblClick={props.onReset}
			onKeyDown={(e) => {
				const step = e.shiftKey ? 64 : 16;
				const delta = ({ ArrowLeft: -step, ArrowUp: -step, ArrowRight: step, ArrowDown: step } as Record<string, number>)[e.key];
				if (delta !== undefined) (e.preventDefault(), props.onDrag(delta));
				else if (e.key === "Home") (e.preventDefault(), props.onReset());
			}}
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

/** A command's shortcut as it is now, for a tooltip: it stays true after a rebind. */
const shortcut = (id: string) => (keysFor(id) ? ` (${keysFor(id)})` : "");

function useTheme() {
	const media = matchMedia("(prefers-color-scheme: light)");
	// In the desktop app the system is asked for its preference; in a browser the browser's answer is the system's.
	const system = () => (state.info?.host === "app" ? state.info.systemDark : undefined);
	const apply = () => applyTheme(resolveTheme(state.settings.theme, state.themes, system(), state.settings.themeMaterial));
	createEffect(on([() => state.settings.theme, () => state.settings.themeMaterial, () => state.themes, system], apply));
	media.addEventListener("change", apply);
	onCleanup(() => media.removeEventListener("change", apply));
	createEffect(() => applyFonts({ uiFont: state.settings.uiFont, codeFont: state.settings.codeFont, readFont: state.settings.readFont }));
}

function useLayoutPersistence() {
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The folder whose layout was last refused a save, which has been said: said again for another folder. */
	let layoutRefused: string | null = null;
	createEffect(
		on(
			() => JSON.stringify(state.settings.layout),
			(layout, previous) => {
				// The self-test opens the fixture itself, not a copy: it leaves no trace in it.
				if (previous === undefined || !state.workspace || state.info?.selftest) return;
				clearTimeout(timer);
				timer = setTimeout(
					() =>
						void backend.saveSettings("workspace", { layout: JSON.parse(layout) }).then(
							() => (layoutRefused = null),
							(e) => {
								// The folder's settings file cannot be written (it does not read as settings, say). Said once
								// for a folder, not at every move of a panel; said again after a save has gone through.
								const root = state.workspace?.root ?? "";
								if (layoutRefused !== root) notify(`The window's layout is not being kept for this folder: ${String(e?.message ?? e)}`, "error");
								layoutRefused = root;
							},
						),
					600,
				);
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
			<Match when={props.id === "docs"}>
				<Docs />
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
			<Match when={props.id === "git"}>
				<GitPanel />
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
	// A panel shows a folder's contents: with no folder open there is nothing to switch to.
	const usable = () => Boolean(state.workspace);
	const name = () => panel().title.split(":")[0]!;
	return (
		<button
			title={usable() ? `${panel().title}${shortcut(props.id)}\nRight-click, or the command "Move ${sideOf(props.id)} panel", moves it to the ${sideOf(props.id) === "left" ? "right" : "left"} side.` : `${name()}: open a folder first`}
			aria-label={name()}
			aria-pressed={usable() && isShown(props.id)}
			disabled={!usable()}
			classList={{ active: usable() && isShown(props.id) }}
			onClick={() => togglePanel(props.id)}
			onContextMenu={(e) => (e.preventDefault(), movePanel(props.id))}
		>
			{/* Icons in the private use area are Codicons, drawn with that font. */}
			{/[\ue000-\uf8ff]/.test(panel().icon) ? <span class="codicon-glyph" aria-hidden="true">{panel().icon}</span> : panel().icon}
		</button>
	);
}

export function App() {
	useTheme();
	// A changed style profile goes to the language server, which re-checks.
	createEffect(on(() => JSON.stringify(state.settings.ssl), (_now, before) => before !== undefined && session.configure()));
	useSymbols();
	useProject();
	useNavigation();
	useGit();
	useLayoutPersistence();
	// Each side shows a panel that is docked on it. One that was moved away, or put back by "Reset the layout", or
	// was never chosen (the app has only just started) gives way to one that is docked there; with none, the side closes.
	createEffect(() => {
		for (const side of ["left", "right"] as const) {
			const key = side === "left" ? "leftView" : "rightView";
			const view = panelOn(side);
			if (view === null) state.settings.layout[side] && setState("settings", "layout", side, false);
			else if (view !== state[key]) setState(key, view);
		}
	});
	// When a context-gated panel (Document outline, Palette) becomes irrelevant to the open file/view,
	// switch its side cleanly to the first available panel docked on that side (skipped during selftest).
	createEffect(() => {
		if (!state.workspace || state.info?.selftest) return;
		for (const side of ["left", "right"] as const) {
			const key = side === "left" ? "leftView" : "rightView";
			const current = state[key];
			if (!isPanelAvailable(current)) {
				const fallback = PANELS.find((p) => sideOf(p.id) === side && isPanelAvailable(p.id));
				if (fallback) setState(key, fallback.id);
				else if (state.settings.layout[side]) setState("settings", "layout", side, false);
			}
		}
		const hosted = narrowHosted();
		if (hosted && !isPanelAvailable(hosted)) setNarrowHosted(null);
	});
	// Which files are open is kept with the folder, so that it opens next time as it was left.
	createEffect(on(() => JSON.stringify([state.groups.map((g) => [g.tabs, g.active]), state.activeGroup]), rememberTabs));
	// And so are the side panel, the bottom panel and the right panel that were showing.
	createEffect(on(() => [state.leftView, state.bottomView, state.rightView], rememberViews));
	// The app is told how much is unsaved, so that it can refuse to close its window until the user has been asked.
	createEffect(() => void backend.unsavedChanged(unsavedPaths().length).catch(() => undefined));
	// A review takes the editors' place: one opened while the call graph is showing must not open behind it.
	createEffect(() => review() && setState("centerView", "editors"));
	const layout = () => state.settings.layout;
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	// The window's size, to keep the side panels from crowding out the editors.
	const [size, setSize] = createSignal({ width: window.innerWidth, height: window.innerHeight });
	const resized = () => setSize({ width: window.innerWidth, height: window.innerHeight });
	window.addEventListener("resize", resized);
	onCleanup(() => window.removeEventListener("resize", resized));
	const scale = () => clampScale(state.settings.uiScale);
	// The activity bar grows with the interface size; the panels' widths are the user's own pixels.
	const availWidth = () => size().width - ACTIVITY * (scale() - 1);
	const isNarrowPair = () => availWidth() < ACTIVITY + CENTER_MIN + LEFT_MIN + RIGHT_MIN;
	createEffect(() => {
		const narrow = isNarrowPair();
		setNarrowPanels(narrow);
		if (narrow) {
			if (state.workspace && layout().right && !narrowHosted() && (lastShown() === "right" || !layout().left)) {
				setNarrowHosted(state.rightView);
				setState("settings", "layout", "left", true);
			}
		} else {
			const hosted = narrowHosted();
			if (hosted) {
				setNarrowHosted(null);
				if (sideOf(hosted) === "right") {
					setState("rightView", hosted);
					setState("settings", "layout", "right", true);
				}
			}
		}
	});
	// In narrow layout, right-docked panels are hosted in the left slot so the right column never crowds or overflows.
	const rightW = () => (layout().right && state.workspace && !narrowPanels() ? layout().rightWidth : 0);
	const fit = () => fitPanels(availWidth(), layout().left && state.workspace ? layout().leftWidth : 0, rightW(), lastShown());
	// A side that is open and got no room: its button is not pressed, and pressing it brings the panel back.
	createEffect(() => setCrowded(state.workspace ? crowdedSides({ left: layout().left, right: layout().right && !narrowPanels() }, fit()) : { left: false, right: false }));

	// Per-mode bottom panel memory (ADR 0027): default open in Code, hidden in Graph/Plan/Docs/Table/Review/Welcome.
	type ModeKey = "code" | "plan" | "graph" | "doc" | "table" | "review" | "welcome";
	const activeMode = (): ModeKey => {
		if (state.centerView === "graph") return "graph";
		if (state.centerView === "welcome") return "welcome";
		if (review()) return "review";
		const path = activePath();
		if (path) {
			if (isPlanPath(path) && !state.planText[path]) return "plan";
			if (isMarkdown(path) && !state.mdText[path]) return "doc";
			if (isTable(path) && !state.mdText[path]) return "table";
		}
		return "code";
	};
	const bottomByMode: Record<ModeKey, boolean> = { code: true, plan: false, graph: false, doc: false, table: false, review: false, welcome: false };
	let syncingBottomMode = false;
	createEffect(
		on(activeMode, (mode, prev) => {
			if (!state.workspace) return;
			if (prev === undefined) {
				bottomByMode[mode] = state.settings.layout.bottom;
				return;
			}
			const want = bottomByMode[mode];
			if (state.settings.layout.bottom !== want) {
				syncingBottomMode = true;
				setState("settings", "layout", "bottom", want);
				queueMicrotask(() => (syncingBottomMode = false));
			}
		}),
	);
	createEffect(
		on(
			() => state.settings.layout.bottom,
			(open) => {
				if (!syncingBottomMode && state.workspace) bottomByMode[activeMode()] = open;
			},
		),
	);
	const bottom = () => (layout().bottom ? Math.min(layout().bottomHeight, Math.max(80, size().height - 200)) : 0);
	// The interface's size scales the type and spacing scales in style.css; the code's size is its own setting.
	createEffect(() => {
		document.documentElement.style.setProperty("--ui-scale", String(scale()));
		document.documentElement.style.setProperty("--code-size", `${clamp(Number(state.settings.fontSize) || 13, 8, 40)}px`);
	});
	onCleanup(
		focusRequest.listen((target) => {
			// The panel's search box or its list, never a button: a stray key must not press something.
			if (target === "side") queueMicrotask(() => focusPanel(state.leftView));
		}),
	);
	return (
		<div class="app" style={{ "--left": `${fit().left}px`, "--right": `${fit().right}px`, "--bottom": `${bottom()}px` }}>
			<Show when={state.settings.menuBar !== false}>
				<MenuBar />
			</Show>
			<nav class="activity" aria-label="Views">
				<For each={PANELS.filter((p) => sideOf(p.id) === "left" && isPanelAvailable(p.id))}>{(p) => <PanelButton id={p.id} />}</For>
				<button
					title={state.workspace ? `Call graph${shortcut("graph")}` : "Call graph: open a folder first"}
					aria-label="Call graph"
					aria-pressed={state.centerView === "graph"}
					disabled={!state.workspace}
					classList={{ active: Boolean(state.workspace) && state.centerView === "graph" }}
					onClick={() => setState("centerView", state.centerView === "graph" ? "editors" : "graph")}
				>
					<span class="codicon-glyph" aria-hidden="true">
						{"\uebb9"}
					</span>
				</button>
				<span class="spacer" />
				<Show when={PANELS.some((p) => sideOf(p.id) === "right" && isPanelAvailable(p.id))}>
					<span class="activity-divider" aria-hidden="true" />
				</Show>
				<For each={PANELS.filter((p) => sideOf(p.id) === "right" && isPanelAvailable(p.id))}>{(p) => <PanelButton id={p.id} />}</For>
				<button title={`All commands${shortcut("command-palette")}`} aria-label="All commands" onClick={() => setState("quickPick", "commands")}>
					<span class="codicon-glyph" aria-hidden="true">
						{"\ueb94"}
					</span>
				</button>
				<button title={`Settings${shortcut("settings")}`} aria-label="Settings" onClick={() => commands.find((c) => c.id === "settings")!.run()}>
					<span class="codicon-glyph" aria-hidden="true">
						{"\ueaf8"}
					</span>
				</button>
			</nav>
			<Show when={fit().left > 0 && state.workspace}>
				<aside class="sidebar" aria-label="Side panel">
					<Show when={narrowPanels() && narrowHosted()}>
						{(hostedId) => (
							<div class="narrow-dock-bar">
								<span class="narrow-dock-pill" title="Normally docked in the right panel; shown here while the window is narrow.">
									Right
								</span>
								<span class="spacer" />
								<button
									class="link narrow-dock-back"
									title="Back to left panel"
									onClick={() => setNarrowHosted(null)}
								>
									Back
								</button>
								<button
									class="narrow-dock-move"
									title="Dock this panel permanently on the left"
									onClick={() => movePanel(hostedId())}
								>
									Dock left
								</button>
							</div>
						)}
					</Show>
					<Panel id={(narrowPanels() && narrowHosted()) || state.leftView} />
				</aside>
				<Splitter
					axis="x"
					column={3}
					label="Width of the side panel"
					value={fit().left}
					min={160}
					max={700}
					onDrag={(d) => setState("settings", "layout", "leftWidth", (w) => clamp(Math.min(w, fit().left) + d, 160, 700))}
					onReset={() => setState("settings", "layout", "leftWidth", 260)}
				/>
			</Show>
			<main class="center">
				<Show when={state.project && !state.project.configured && !state.setupDismissed && !state.info?.selftest}>
					<div class="setup-bar" role="status">
						<span>This folder is not set up as a project. Setting it up adds project settings, a README and an AGENTS file; nothing is overwritten.</span>
						<button class="primary" onClick={() => void setUpProject()}>
							Set up project
						</button>
						<button onClick={() => setState("setupDismissed", true)}>Not now</button>
					</div>
				</Show>
				<div class="editors">
					<Show when={state.workspace} fallback={<Welcome />}>
						<Show when={state.centerView === "graph"}>
							<GraphView />
						</Show>
						<Show when={state.centerView === "welcome"}>
							<CenterTabStrip title="Projects" tooltip="Switch workspace or open a recent folder" icon="home" onClose={() => setState("centerView", "editors")}>
								<Welcome />
							</CenterTabStrip>
						</Show>
						<Show when={state.centerView === "editors"}>
							<Show when={review()} keyed fallback={<For each={state.groups}>{(_, i) => <EditorGroup index={i()} />}</For>}>
								{(_r) => <ReviewView />}
							</Show>
						</Show>
					</Show>
				</div>
				<Show when={layout().bottom && state.workspace}>
					<Splitter
						axis="y"
						label="Height of the bottom panel"
						value={bottom()}
						min={80}
						max={600}
						onDrag={(d) => setState("settings", "layout", "bottomHeight", (h) => clamp(Math.min(h, bottom()) - d, 80, 600))}
						onReset={() => setState("settings", "layout", "bottomHeight", 200)}
					/>
					<section class="bottom" aria-label="Bottom panel">
						<div class="bottom-tabs" role="tablist" aria-label="Bottom panel">
							<button role="tab" aria-selected={state.bottomView === "problems"} classList={{ active: state.bottomView === "problems" }} onClick={() => setState("bottomView", "problems")}>
								Problems <span class="count">{counts().errors + counts().warnings + counts().other}</span>
							</button>
							<button role="tab" aria-selected={state.bottomView === "output"} classList={{ active: state.bottomView === "output" }} onClick={() => setState("bottomView", "output")}>
								Output
							</button>
							<span class="spacer" />
							<button title={`Close panel${shortcut("toggle-panel")}`} aria-label="Close the bottom panel" onClick={() => setState("settings", "layout", "bottom", false)}>
								<Icon name="close" />
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
			<Show when={fit().right > 0 && state.workspace}>
				<Splitter
					axis="x"
					column={5}
					label="Width of the right panel"
					value={fit().right}
					min={220}
					max={800}
					onDrag={(d) => setState("settings", "layout", "rightWidth", (w) => clamp(Math.min(w, fit().right) - d, 220, 800))}
					onReset={() => setState("settings", "layout", "rightWidth", 360)}
				/>
				<aside class="rightbar" aria-label="Right panel">
					<Panel id={state.rightView} />
				</aside>
			</Show>
			<StatusBar />
			{/* A passing note is announced politely and goes by itself. An error interrupts, stays until dismissed, and is in Output. */}
			<div class="toasts" aria-live="polite">
				<For each={state.messages}>
					{(m) => (
						<div class={`toast ${m.kind}`} role={m.kind === "error" ? "alert" : "status"}>
							<span class="toast-text">{m.text}</span>
							<Show when={m.action}>
								{(action) => (
									<button class="link toast-action" onClick={() => (dismiss(m.id), action().run())}>
										{action().label}
									</button>
								)}
							</Show>
							<button class="toast-close" title="Dismiss" aria-label="Dismiss this message" onClick={() => dismiss(m.id)}>
								<Icon name="close" />
							</button>
						</div>
					)}
				</For>
			</div>
			<QuickPick />
			{/* One menu for every list's rows, whichever panel is showing: the Explorer's files, the working documents, Health's checks. */}
			<RowMenu />
			<SettingsDialog />
			<StyleProfile />
			<Dialogs />
		</div>
	);
}

export { openFolder };
