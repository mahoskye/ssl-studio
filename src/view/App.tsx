// The window: menu bar, activity bar, side bar, editor groups, bottom panel, status bar.
import { Icon } from "./Icon";
import { batch, createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { docChecks } from "../shared/docChecks";
import { folderParts } from "../shared/docSections";
import { CATALOG_AREAS } from "../shared/projectDocs";
import { badgeText } from "../shared/statusBar";
import { backend } from "./backend";
import { docAuditData } from "./docAudit";
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
import { docs, isMarkdown, isTable, setUpProject, useProject } from "./project";
import { StyleProfile } from "./StyleProfile";
import { AgentPanel } from "./agent/Agent";
import { GraphView, resetGraphState } from "./graph/GraphView";
import { session } from "./lsp/session";
import { QuickPick } from "./QuickPick";
import { SettingsDialog } from "./Settings";
import { MenuBar } from "./MenuBar";
import { useNavigation } from "./navigation";
import { StatusBar } from "./StatusBar";
import { applyFonts, applyTheme, resolveTheme } from "./themes/themes";
import { activePath, dismiss, focusEditor, focusRequest, isTabsReady, markdownMode, notify, openFolder, planMode, rememberTabs, rememberViews, setState, state, tableTextMode, unsavedPaths, type PanelId } from "./state";
import { focusPanel, getOutlineMemory, getPlanPaletteMemory, isPanelAvailable, isPlanChartActive, isShown, lastShown, loadOutlineMemory, loadPlanPaletteMemory, movePanel, narrowHosted, narrowPanels, panelOn, PANELS, recordOutlineActive, recordPlanPaletteActive, setCrowded, setNarrowHosted, setNarrowPanels, setOutlineMemory, setPlanPaletteMemory, sideOf, togglePanel } from "./panels/registry";
import { transitionOutlineAvailability, transitionPanelAvailability } from "./panels/outlineState";
import { isPlanPath } from "./plan/model";
import { Welcome } from "./Welcome";
import { ACTIVITY, BOTTOM_MIN, canFitBothPanels, CENTER_MIN, crowdedSides, dragBottomPanel, dragHorizontalPanel, EDITOR_MIN_HEIGHT, fitPanels, horizontalChrome, LEFT_MIN, RIGHT_MIN } from "./layout";



/**
 * The bar between two parts of the window. Dragged with the mouse, or moved
 * with the arrow keys when it has the keyboard; a double-click or Home puts
 * it back where it started.
 */
function Splitter(props: {
	axis: "x" | "y";
	column?: number;
	extraClass?: string;
	label: string;
	value: number;
	min: number;
	max: number;
	onDragStart?: () => void;
	onDragDelta: (totalDelta: number) => void;
	onDragEnd?: () => void;
	onStep: (stepDelta: number) => void;
	onReset: () => void;
}) {
	const [dragging, setDragging] = createSignal(false);
	let cleanupDrag: (() => void) | null = null;
	onCleanup(() => cleanupDrag?.());
	return (
		<div
			class={`splitter ${props.axis}${props.column === 5 ? " after-editors" : ""}${props.extraClass ? ` ${props.extraClass}` : ""}`}
			classList={{ dragging: dragging() }}
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
				const map: Record<string, number> = props.axis === "x" ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step };
				const delta = map[e.key];
				if (delta !== undefined) (e.preventDefault(), props.onStep(delta));
				else if (e.key === "Home") (e.preventDefault(), props.onReset());
			}}
			onMouseDown={(start) => {
				if (start.button !== 0) return;
				start.preventDefault();
				cleanupDrag?.();
				const origin = props.axis === "x" ? start.clientX : start.clientY;
				const prevCursor = document.body.style.cursor;
				const prevSelect = document.body.style.userSelect;
				document.body.style.cursor = props.axis === "x" ? "col-resize" : "row-resize";
				document.body.style.userSelect = "none";
				setDragging(true);
				props.onDragStart?.();
				const move = (e: MouseEvent) => {
					const now = props.axis === "x" ? e.clientX : e.clientY;
					props.onDragDelta(now - origin);
				};
				const finish = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", finish);
					window.removeEventListener("blur", finish);
					document.body.style.cursor = prevCursor;
					document.body.style.userSelect = prevSelect;
					setDragging(false);
					cleanupDrag = null;
					props.onDragEnd?.();
				};
				cleanupDrag = finish;
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", finish);
				window.addEventListener("blur", finish);
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

function PanelButton(props: { id: PanelId; badge?: string; badgeNote?: string }) {
	const panel = () => PANELS.find((p) => p.id === props.id)!;
	// A panel shows a folder's contents: with no folder open there is nothing to switch to.
	const usable = () => Boolean(state.workspace);
	const name = () => panel().title.split(":")[0]!;
	return (
		<button
			title={usable() ? `${panel().title}${props.badgeNote ? ` — ${props.badgeNote}` : ""}${shortcut(props.id)}\nRight-click, or the command "Move ${sideOf(props.id)} panel", moves it to the ${sideOf(props.id) === "left" ? "right" : "left"} side.` : `${name()}: open a folder first`}
			aria-label={usable() && props.badgeNote ? `${name()}: ${props.badgeNote}` : name()}
			aria-pressed={usable() && isShown(props.id)}
			disabled={!usable()}
			classList={{ active: usable() && isShown(props.id) }}
			onClick={() => togglePanel(props.id)}
			onContextMenu={(e) => (e.preventDefault(), movePanel(props.id))}
		>
			{/* Icons in the private use area are Codicons, drawn with that font. */}
			{/[\ue000-\uf8ff]/.test(panel().icon) ? <span class="codicon-glyph" aria-hidden="true">{panel().icon}</span> : panel().icon}
			<Show when={usable() && props.badge}>
				<span class="activity-badge" aria-hidden="true">
					{props.badge}
				</span>
			</Show>
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
	// Document outline ("objects") defaults to the right side when available and remembers
	// whether the user left it active or inactive across tab switches and sessions.
	let syncingOutline = false;
	createEffect(
		on(
			() => {
				const side = sideOf("objects");
				const key = side === "left" ? "leftView" : "rightView";
				const avail = isPanelAvailable("objects");
				return [state.workspace?.root, isTabsReady(), avail, side, narrowPanels(), !avail && state[key] === "objects"] as const;
			},
			([root, ready, avail, side, narrow], prev) => {
				if (root !== prev?.[0]) loadOutlineMemory(root);
				if (!root || !ready || state.info?.selftest) return;
				const key = side === "left" ? "leftView" : "rightView";
				const current = { open: state.settings.layout[side], view: state[key] };
				const fallback = PANELS.find((p) => p.id !== "objects" && sideOf(p.id) === side && isPanelAvailable(p.id))?.id ?? null;
				const res = transitionOutlineAvailability(
					avail,
					current,
					getOutlineMemory(),
					fallback,
					(id) => sideOf(id) === side && isPanelAvailable(id),
					narrow && side === "right",
				);
				setOutlineMemory(res.memory);
				if (!res.apply) return;
				syncingOutline = true;
				try {
					batch(() => {
						if (res.apply!.view !== undefined) setState(key, res.apply!.view);
						if (res.apply!.open !== undefined) setState("settings", "layout", side, res.apply!.open);
					});
				} finally {
					syncingOutline = false;
				}
			},
		),
	);
	// Record user-driven activation or deactivation of Document outline while it is available.
	createEffect(
		on(
			() => {
				const side = sideOf("objects");
				const key = side === "left" ? "leftView" : "rightView";
				return [state.settings.layout[side], state[key]] as const;
			},
			([open, view], prev) => {
				if (syncingOutline || !state.workspace || !isTabsReady() || state.info?.selftest) return;
				if (!isPanelAvailable("objects")) return;
				if (narrowPanels() && sideOf("objects") === "right") return;
				const nowActive = open && view === "objects";
				const prevSnap = prev && prev[1] !== "objects" ? { open: prev[0], view: prev[1] } : undefined;
				recordOutlineActive(nowActive, nowActive ? prevSnap : null);
			},
		),
	);
	// Plan Palette ("palette") loads by default when viewing a plan chart and remembers
	// whether the user left it active or inactive across tab switches and reloads.
	// Outside plan charts, Palette remains user-openable on SSL, Markdown, and Call Graph views.
	let syncingPlanPalette = false;
	createEffect(
		on(
			() => {
				const side = sideOf("palette");
				const key = side === "left" ? "leftView" : "rightView";
				const inPlan = isPlanChartActive();
				const avail = isPanelAvailable("palette");
				return [state.workspace?.root, isTabsReady(), inPlan, side, narrowPanels(), !avail && state[key] === "palette", avail] as const;
			},
			([root, ready, inPlan, side, narrow, , avail], prev) => {
				if (root !== prev?.[0]) loadPlanPaletteMemory(root);
				if (!root || !ready || state.info?.selftest) return;
				// If Palette is legitimately available outside a plan chart (Markdown, SSL, Call Graph)
				// and we are not just transitioning away from a plan chart, never evict a user-opened Palette.
				if (!inPlan && !prev?.[2] && avail) return;
				const key = side === "left" ? "leftView" : "rightView";
				const current = { open: state.settings.layout[side], view: state[key] };
				const fallback = PANELS.find((p) => p.id !== "palette" && sideOf(p.id) === side && isPanelAvailable(p.id))?.id ?? null;
				const res = transitionPanelAvailability(
					"palette",
					inPlan,
					current,
					getPlanPaletteMemory(),
					fallback,
					(id) => sideOf(id) === side && isPanelAvailable(id),
					narrow && side === "right",
					side === "right",
				);
				setPlanPaletteMemory(res.memory);
				if (!res.apply) return;
				syncingPlanPalette = true;
				try {
					batch(() => {
						if (res.apply!.view !== undefined) setState(key, res.apply!.view);
						if (res.apply!.open !== undefined) setState("settings", "layout", side, res.apply!.open);
					});
				} finally {
					syncingPlanPalette = false;
				}
			},
		),
	);
	// Record user-driven activation or deactivation of Palette while viewing a plan chart.
	createEffect(
		on(
			() => {
				const side = sideOf("palette");
				const key = side === "left" ? "leftView" : "rightView";
				return [state.settings.layout[side], state[key]] as const;
			},
			([open, view], prev) => {
				if (syncingPlanPalette || !state.workspace || !isTabsReady() || state.info?.selftest) return;
				if (!isPlanChartActive()) return;
				if (narrowPanels() && sideOf("palette") === "right") return;
				const nowActive = open && view === "palette";
				const prevSnap = prev && prev[1] !== "palette" ? { open: prev[0], view: prev[1] } : undefined;
				recordPlanPaletteActive(nowActive, nowActive ? prevSnap : null);
			},
		),
	);
	// When other context-gated panels (e.g. Palette outside plan charts) become irrelevant to the open file/view,
	// switch their side cleanly to the first available panel docked on that side (skipped during selftest).
	createEffect(() => {
		if (!state.workspace || state.info?.selftest) return;
		for (const side of ["left", "right"] as const) {
			const key = side === "left" ? "leftView" : "rightView";
			const current = state[key];
			if (current === "objects") continue;
			if (current === "palette" && getPlanPaletteMemory().before !== null) continue;
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
	// Keep Call Graph mounted once opened in the current workspace so pan/zoom, folds, focus, and impact state survive jumps to code/docs.
	const [graphMounted, setGraphMounted] = createSignal(false);
	createEffect(
		on(
			() => state.workspace?.root,
			() => {
				setGraphMounted(false);
				resetGraphState();
			},
		),
	);
	createEffect(() => {
		if (state.workspace && state.centerView === "graph") setGraphMounted(true);
	});
	const layout = () => state.settings.layout;
	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
	// The window's size, to keep the side panels from crowding out the editors.
	const [size, setSize] = createSignal({ width: window.innerWidth, height: window.innerHeight });
	const resized = () => setSize({ width: window.innerWidth, height: window.innerHeight });
	window.addEventListener("resize", resized);
	onCleanup(() => window.removeEventListener("resize", resized));
	const scale = () => clampScale(state.settings.uiScale);
	const gap = () => (size().width <= 780 ? 0 : 5);
	const splitSize = () => Math.max(4, gap());
	const chrome = () => ({ activity: ACTIVITY * scale(), gap: gap(), splitter: splitSize() });
	const isNarrowPair = () => !canFitBothPanels(size().width, chrome());
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
	const fit = () => fitPanels(size().width, layout().left && state.workspace ? layout().leftWidth : 0, rightW(), lastShown(), chrome());
	const usableWidth = () => {
		const f = fit();
		return Math.max(0, size().width - horizontalChrome(f.left > 0, f.right > 0, chrome()));
	};
	const maxLeft = () => Math.max(LEFT_MIN, Math.floor(usableWidth() - CENTER_MIN - fit().right));
	const maxRight = () => Math.max(RIGHT_MIN, Math.floor(usableWidth() - CENTER_MIN - fit().left));
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
			if (isPlanPath(path) && planMode(path) !== "source") return "plan";
			if (isMarkdown(path) && markdownMode(path) !== "source") return "doc";
			if (isTable(path) && !tableTextMode(path)) return "table";
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
	let centerEl: HTMLElement | undefined;
	const [centerH, setCenterH] = createSignal(0);
	const measureCenter = () => {
		if (!centerEl) return;
		const setup = centerEl.querySelector<HTMLElement>(".setup-bar");
		setCenterH(Math.max(0, centerEl.clientHeight - (setup?.offsetHeight ?? 0)));
	};
	onMount(() => {
		measureCenter();
		if (!centerEl || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measureCenter);
		ro.observe(centerEl);
		onCleanup(() => ro.disconnect());
	});
	createEffect(() => {
		// Re-measure when the setup bar appears or is dismissed.
		void (state.project && !state.project.configured && !state.setupDismissed);
		queueMicrotask(measureCenter);
	});
	// Closing the bottom panel clears maximize so reopening shows the editor beside it.
	createEffect(() => {
		if (!layout().bottom && state.bottomMaximized) setState("bottomMaximized", false);
	});
	const verticalChrome = () => (state.settings.menuBar !== false ? 34 : 0) * scale() + 24 * scale() + gap();
	const effectiveCenterH = () => centerH() || Math.max(0, size().height - verticalChrome());
	const maxBottom = () => Math.max(BOTTOM_MIN, Math.floor(effectiveCenterH() - splitSize() - EDITOR_MIN_HEIGHT));
	const bottom = () => (layout().bottom && state.workspace ? Math.max(BOTTOM_MIN, Math.min(layout().bottomHeight, maxBottom())) : 0);

	// VS Code sash drag state: snapshot at drag start so overshooting never drifts,
	// dragging below half minimum snap-closes, and dragging the bottom panel past the
	// editor minimum snaps it to fill the entire center pane.
	const [snapHide, setSnapHide] = createSignal<"left" | "right" | "bottom" | null>(null);
	const [snapMaximize, setSnapMaximize] = createSignal<boolean | null>(null);
	const isBottomMaximized = () => (snapMaximize() !== null ? snapMaximize()! : state.bottomMaximized);
	let hSnap: { side: "left" | "right"; left: number; right: number; usable: number } | null = null;
	let bSnap: { savedHeight: number; centerHeight: number; splitterHeight: number; wasMaximized: boolean } | null = null;

	const applyHorizontal = (side: "left" | "right", startL: number, startR: number, usable: number, delta: number, allowSnap: boolean) => {
		const res = dragHorizontalPanel(side, startL, startR, usable, delta, allowSnap);
		if (res.collapsed) {
			if (side === "left" && startR > 0) setState("settings", "layout", "rightWidth", startR);
			if (side === "right" && startL > 0) setState("settings", "layout", "leftWidth", startL);
			setSnapHide(side);
			return;
		}
		if (snapHide() === side) setSnapHide(null);
		if (startL > 0) setState("settings", "layout", "leftWidth", res.left);
		if (startR > 0) setState("settings", "layout", "rightWidth", res.right);
	};
	const startHorizontalDrag = (side: "left" | "right") => {
		const f = fit();
		hSnap = { side, left: f.left, right: f.right, usable: Math.max(0, size().width - horizontalChrome(f.left > 0, f.right > 0, chrome())) };
	};
	const dragHorizontal = (delta: number) => {
		if (!hSnap) return;
		applyHorizontal(hSnap.side, hSnap.left, hSnap.right, hSnap.usable, delta, true);
	};
	const endHorizontalDrag = () => {
		const snap = hSnap;
		hSnap = null;
		if (!snap) return;
		if (snapHide() === snap.side) {
			setSnapHide(null);
			// Keep pre-drag width so reopening restores the panel as the user had it.
			if (snap.side === "left") {
				setState("settings", "layout", "leftWidth", snap.left);
				if (narrowPanels() && narrowHosted()) setNarrowHosted(null);
				setState("settings", "layout", "left", false);
			} else {
				setState("settings", "layout", "rightWidth", snap.right);
				setState("settings", "layout", "right", false);
			}
			queueMicrotask(() => (!document.activeElement || document.activeElement === document.body) && focusEditor());
		}
	};
	const stepHorizontal = (side: "left" | "right", delta: number) => {
		const f = fit();
		const usable = Math.max(0, size().width - horizontalChrome(f.left > 0, f.right > 0, chrome()));
		applyHorizontal(side, f.left, f.right, usable, delta, false);
	};

	const startBottomDrag = () => {
		bSnap = {
			savedHeight: bottom(),
			centerHeight: effectiveCenterH(),
			splitterHeight: splitSize(),
			wasMaximized: state.bottomMaximized,
		};
	};
	const dragBottom = (delta: number) => {
		if (!bSnap) return;
		const res = dragBottomPanel(bSnap.savedHeight, bSnap.centerHeight, bSnap.splitterHeight, delta, true, bSnap.wasMaximized);
		if (res.collapsed) {
			setSnapMaximize(false);
			setSnapHide("bottom");
			return;
		}
		if (snapHide() === "bottom") setSnapHide(null);
		if (res.maximized) {
			setSnapMaximize(true);
			return;
		}
		setSnapMaximize(false);
		setState("settings", "layout", "bottomHeight", res.height);
	};
	const endBottomDrag = () => {
		const snap = bSnap;
		const maxNow = snapMaximize();
		bSnap = null;
		setSnapMaximize(null);
		if (!snap) return;
		if (snapHide() === "bottom") {
			setSnapHide(null);
			setState("bottomMaximized", false);
			setState("settings", "layout", "bottomHeight", snap.savedHeight);
			setState("settings", "layout", "bottom", false);
			queueMicrotask(() => (!document.activeElement || document.activeElement === document.body) && focusEditor());
			return;
		}
		if (maxNow === true) {
			// Keep pre-drag height so Restore brings the panel back where it was.
			setState("settings", "layout", "bottomHeight", snap.savedHeight);
			setState("bottomMaximized", true);
		} else if (maxNow === false) {
			setState("bottomMaximized", false);
		}
	};
	const stepBottom = (delta: number) => {
		const res = dragBottomPanel(bottom(), effectiveCenterH(), splitSize(), delta, false, state.bottomMaximized);
		setState("bottomMaximized", res.maximized);
		if (!res.maximized) setState("settings", "layout", "bottomHeight", res.height);
	};

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
	const docAreas = createMemo(() => CATALOG_AREAS.filter((area) => area !== "schema" || folderParts(state.project?.schema ?? "schema").length > 0));
	const docCheckList = createMemo(() => docChecks(docs(), docAreas()));
	const healthWarnings = createMemo(
		() => docCheckList().filter((c) => c.level === "warn").length + docAuditData().issues.filter((i) => i.level === "warn").length,
	);
	const healthNotes = createMemo(
		() =>
			docCheckList().filter((c) => c.level === "note").length +
			docAuditData().issues.filter((i) => i.level === "note").length +
			docAuditData().unusedAttachments.length,
	);
	const panelBadge = (id: PanelId) => (id === "health" ? badgeText(healthWarnings()) : "");
	const panelBadgeNote = (id: PanelId) => {
		if (id !== "health") return undefined;
		const w = healthWarnings();
		const n = healthNotes();
		if (!w && !n) return undefined;
		const parts = [];
		if (w) parts.push(`${w} ${w === 1 ? "warning" : "warnings"}`);
		if (n) parts.push(`${n} ${n === 1 ? "note" : "notes"}`);
		return parts.join(", ");
	};

	return (
		<div
			class="app"
			style={{
				"--left": `${snapHide() === "left" ? 0 : fit().left}px`,
				"--right": `${snapHide() === "right" ? 0 : fit().right}px`,
				"--bottom": `${snapHide() === "bottom" ? 0 : bottom()}px`,
			}}
		>
			<Show when={state.settings.menuBar !== false}>
				<MenuBar />
			</Show>
			<nav class="activity" aria-label="Views">
				<For each={PANELS.filter((p) => sideOf(p.id) === "left" && isPanelAvailable(p.id))}>{(p) => <PanelButton id={p.id} badge={panelBadge(p.id)} badgeNote={panelBadgeNote(p.id)} />}</For>
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
				<For each={PANELS.filter((p) => sideOf(p.id) === "right" && isPanelAvailable(p.id))}>{(p) => <PanelButton id={p.id} badge={panelBadge(p.id)} badgeNote={panelBadgeNote(p.id)} />}</For>
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
				<aside class="sidebar" classList={{ "snap-hidden": snapHide() === "left" }} aria-label="Side panel">
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
					min={LEFT_MIN}
					max={maxLeft()}
					onDragStart={() => startHorizontalDrag("left")}
					onDragDelta={dragHorizontal}
					onDragEnd={endHorizontalDrag}
					onStep={(d) => stepHorizontal("left", d)}
					onReset={() => setState("settings", "layout", "leftWidth", Math.min(260, maxLeft()))}
				/>
			</Show>
			<main class="center" ref={centerEl}>
				<Show when={state.project && !state.project.configured && !state.setupDismissed && !state.info?.selftest}>
					<div class="setup-bar" role="status">
						<span>This folder is not set up as a project. Setting it up adds project settings, a README and an AGENTS file; nothing is overwritten.</span>
						<button class="primary" onClick={() => void setUpProject()}>
							Set up project
						</button>
						<button onClick={() => setState("setupDismissed", true)}>Not now</button>
					</div>
				</Show>
				<div class="editors" classList={{ "panel-maximized": layout().bottom && Boolean(state.workspace) && isBottomMaximized() }}>
					<Show when={state.workspace} fallback={<Welcome />}>
						<Show when={graphMounted()}>
							<div
								class="graph-persist-host"
								style={{
									display: state.centerView === "graph" ? "flex" : "none",
									flex: "1",
									"min-width": "0",
									"min-height": "0",
								}}
							>
								<GraphView />
							</div>
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
						extraClass={isBottomMaximized() ? "at-top" : undefined}
						label="Height of the bottom panel"
						value={isBottomMaximized() ? effectiveCenterH() : bottom()}
						min={BOTTOM_MIN}
						max={effectiveCenterH()}
						onDragStart={startBottomDrag}
						onDragDelta={dragBottom}
						onDragEnd={endBottomDrag}
						onStep={stepBottom}
						onReset={() => (setState("bottomMaximized", false), setState("settings", "layout", "bottomHeight", 200))}
					/>
					<section class="bottom" classList={{ "snap-hidden": snapHide() === "bottom", maximized: isBottomMaximized() }} aria-label="Bottom panel">
						<div
							class="bottom-tabs"
							role="tablist"
							aria-label="Bottom panel"
							onDblClick={(e) => {
								if (!(e.target as HTMLElement).closest("button")) setState("bottomMaximized", (m) => !m);
							}}
						>
							<button role="tab" aria-selected={state.bottomView === "problems"} classList={{ active: state.bottomView === "problems" }} onClick={() => setState("bottomView", "problems")}>
								Problems <span class="count">{counts().errors + counts().warnings + counts().other}</span>
							</button>
							<button role="tab" aria-selected={state.bottomView === "output"} classList={{ active: state.bottomView === "output" }} onClick={() => setState("bottomView", "output")}>
								Output
							</button>
							<span class="spacer" />
							<button
								class="bottom-action"
								title={`${isBottomMaximized() ? "Restore panel size" : "Maximize panel size"}${shortcut("toggle-panel-maximize")}`}
								aria-label={isBottomMaximized() ? "Restore panel size" : "Maximize panel size"}
								aria-pressed={isBottomMaximized()}
								onClick={() => setState("bottomMaximized", (m) => !m)}
							>
								<Icon name={isBottomMaximized() ? "chevron-down" : "chevron-up"} />
							</button>
							<button class="bottom-action" title={`Close panel${shortcut("toggle-panel")}`} aria-label="Close the bottom panel" onClick={() => setState("settings", "layout", "bottom", false)}>
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
					min={RIGHT_MIN}
					max={maxRight()}
					onDragStart={() => startHorizontalDrag("right")}
					onDragDelta={dragHorizontal}
					onDragEnd={endHorizontalDrag}
					onStep={(d) => stepHorizontal("right", d)}
					onReset={() => setState("settings", "layout", "rightWidth", Math.min(360, maxRight()))}
				/>
				<aside class="rightbar" classList={{ "snap-hidden": snapHide() === "right" }} aria-label="Right panel">
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
