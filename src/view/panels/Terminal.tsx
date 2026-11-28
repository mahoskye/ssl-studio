// VS Code-aligned Integrated Terminal panel: real PTY shells powered by xterm.js,
// 27-theme WCAG AA live palette sync, split New Terminal / Shell Profile header button,
// multi-terminal tabs rail, inline SearchAddon find bar, copy/paste, and context menus.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { buildXtermTheme, type TerminalInfo, type TerminalProfile } from "../../shared/terminal";
import { backend, on } from "../backend";
import { ask } from "../dialogs";
import { Icon } from "../Icon";
import { Menu, type MenuItem } from "../Menu";
import { chooseFromMenu } from "./RowMenu";
import { notify, state } from "../state";

type TerminalRuntime = {
	id: string;
	term: XTerm;
	fit: FitAddon;
	search: SearchAddon;
	hostEl: HTMLDivElement;
	opened: boolean;
	pendingOutput: string[];
	lastCols: number;
	lastRows: number;
};

const runtimes = new Map<string, TerminalRuntime>();
const [terminals, setTerminals] = createSignal<TerminalInfo[]>([]);
const [activeTerminalId, setActiveTerminalId] = createSignal<string | null>(null);
const [profiles, setProfiles] = createSignal<TerminalProfile[]>([]);
const [tabsRailOverride, setTabsRailOverride] = createSignal<boolean | null>(null);
const [findOpen, setFindOpen] = createSignal(false);
const [findQuery, setFindQuery] = createSignal("");
const [findCaseSensitive, setFindCaseSensitive] = createSignal(false);
const [findRegex, setFindRegex] = createSignal(false);
const [findNotFound, setFindNotFound] = createSignal(false);

let listenersInstalled = false;
let profilesLoaded = false;
let autoCreating = false;
let trackedWorkspaceRoot: string | null = null;
let findInputEl: HTMLInputElement | undefined;

const onMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

function readCssToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
	const raw = styles.getPropertyValue(name).trim();
	return raw || fallback;
}

function readLiveTerminalAppearance() {
	const root = document.documentElement;
	const styles = getComputedStyle(root);
	const theme = buildXtermTheme({
		panelBg: readCssToken(styles, "--panel-bg", "#1e1b18"),
		fg: readCssToken(styles, "--fg", "#ddd6cc"),
		strongFg: readCssToken(styles, "--strong-fg", "#f4efe8"),
		muted: readCssToken(styles, "--muted", "#a3998d"),
		accent: readCssToken(styles, "--accent", "#d48b4b"),
		selected: readCssToken(styles, "--selected", "#35302a"),
		error: readCssToken(styles, "--error", "#e06c6c"),
		warning: readCssToken(styles, "--warning", "#e0b050"),
		info: readCssToken(styles, "--info", "#6ca4e0"),
		ok: readCssToken(styles, "--ok", "#68b87a"),
	});
	const fontFamily = readCssToken(styles, "--code-font", "monospace");
	const baseFont = Number(state.settings.fontSize) || 13;
	const scale = Number(state.settings.uiScale) || 1;
	const fontSize = Math.max(10, Math.min(28, Math.round((baseFont - 1) * scale)));
	return { theme, fontFamily, fontSize };
}

function syncAllTerminalThemes() {
	if (typeof document === "undefined" || runtimes.size === 0) return;
	const { theme, fontFamily, fontSize } = readLiveTerminalAppearance();
	for (const rt of runtimes.values()) {
		rt.term.options.theme = theme;
		rt.term.options.fontFamily = fontFamily;
		rt.term.options.fontSize = fontSize;
		if (rt.opened && rt.hostEl.isConnected && rt.hostEl.clientWidth > 0 && rt.hostEl.clientHeight > 0) {
			fitRuntime(rt);
		}
	}
}

function fitRuntime(rt: TerminalRuntime) {
	if (!rt.opened || !rt.hostEl.isConnected) return;
	if (rt.hostEl.clientWidth < 32 || rt.hostEl.clientHeight < 20) return;
	try {
		rt.fit.fit();
		const { cols, rows } = rt.term;
		if (cols > 0 && rows > 0 && (cols !== rt.lastCols || rows !== rt.lastRows)) {
			rt.lastCols = cols;
			rt.lastRows = rows;
			void backend.terminalResize(rt.id, cols, rows).catch(() => {});
		}
	} catch {
		// Fit can fail transiently while layout settles.
	}
}

function ensureBackendListeners() {
	if (listenersInstalled) return;
	listenersInstalled = true;
	on("terminalData", ({ id, data }) => {
		const rt = runtimes.get(id);
		if (!rt) return;
		if (rt.opened) {
			rt.term.write(data);
		} else {
			rt.pendingOutput.push(data);
			// Cap unmounted pre-open buffer to avoid unbounded growth.
			if (rt.pendingOutput.length > 512) rt.pendingOutput.splice(0, rt.pendingOutput.length - 512);
		}
	});
	on("terminalExit", ({ id, exitCode }) => {
		setTerminals((prev) =>
			prev.map((t) => (t.id === id ? { ...t, alive: false, exitCode } : t)),
		);
		const rt = runtimes.get(id);
		if (!rt) return;
		const codeLabel = exitCode === null ? "" : ` with code ${exitCode}`;
		const msg = `\r\n\x1b[2m[Process exited${codeLabel} — press Enter to restart]\x1b[0m\r\n`;
		if (rt.opened) rt.term.write(msg);
		else rt.pendingOutput.push(msg);
	});
}

async function ensureProfilesLoaded() {
	if (profilesLoaded) return;
	profilesLoaded = true;
	try {
		const list = await backend.terminalProfiles();
		setProfiles(list);
	} catch {
		profilesLoaded = false;
	}
}

async function copySelection(rt: TerminalRuntime) {
	const text = rt.term.getSelection();
	if (!text) return;
	const { copyText } = await import("../commands");
	await copyText(text, "Copied terminal selection.");
}

async function pasteIntoTerminal(rt: TerminalRuntime) {
	const info = terminals().find((t) => t.id === rt.id);
	if (!info?.alive) return;
	try {
		const text = await navigator.clipboard?.readText();
		if (text) void backend.terminalWrite(rt.id, text);
	} catch {
		notify("Could not read from clipboard. Use browser paste (Ctrl+Shift+V / Cmd+V).", "error");
	}
}

function createRuntimeFor(info: TerminalInfo): TerminalRuntime {
	const { theme, fontFamily, fontSize } = readLiveTerminalAppearance();
	const term = new XTerm({
		theme,
		fontFamily,
		fontSize,
		lineHeight: 1.25,
		cursorBlink: true,
		cursorStyle: "block",
		scrollback: 5000,
		allowProposedApi: true,
		convertEol: !info.pty,
		macOptionIsMeta: onMac,
	});
	const fit = new FitAddon();
	const search = new SearchAddon();
	const webLinks = new WebLinksAddon((event, uri) => {
		if (!(event.ctrlKey || event.metaKey)) return;
		window.open(uri, "_blank", "noopener,noreferrer");
	});
	term.loadAddon(fit);
	term.loadAddon(search);
	term.loadAddon(webLinks);

	const hostEl = document.createElement("div");
	hostEl.className = "term-xterm";

	const rt: TerminalRuntime = {
		id: info.id,
		term,
		fit,
		search,
		hostEl,
		opened: false,
		pendingOutput: [],
		lastCols: 0,
		lastRows: 0,
	};

	term.attachCustomKeyEventHandler((ev) => {
		if (ev.type !== "keydown") return true;
		const mod = onMac ? ev.metaKey : ev.ctrlKey;
		const key = ev.key.toLowerCase();

		// Ctrl+F / Cmd+F opens inline terminal search.
		if (mod && !ev.altKey && !ev.shiftKey && key === "f") {
			ev.preventDefault();
			openTerminalFind();
			return false;
		}
		// Copy selection: Ctrl+Shift+C (Linux/Win), Cmd+C (Mac), or Ctrl+C when text is selected.
		if (
			((ev.ctrlKey && ev.shiftKey && !ev.altKey && key === "c") ||
				(onMac && ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && key === "c") ||
				(!onMac && ev.ctrlKey && !ev.shiftKey && !ev.altKey && key === "c" && term.hasSelection()))
		) {
			ev.preventDefault();
			void copySelection(rt);
			return false;
		}
		// Paste: Ctrl+Shift+V (Linux/Win) or Cmd+V (Mac).
		if (
			(ev.ctrlKey && ev.shiftKey && !ev.altKey && key === "v") ||
			(onMac && ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && key === "v")
		) {
			ev.preventDefault();
			void pasteIntoTerminal(rt);
			return false;
		}
		return true;
	});

	term.onData((data) => {
		const current = terminals().find((t) => t.id === info.id);
		if (!current) return;
		if (!current.alive) {
			if (data === "\r" || data === "\n") {
				void restartTerminal(info.id);
			}
			return;
		}
		void backend.terminalWrite(info.id, data).catch(() => {});
	});

	runtimes.set(info.id, rt);
	return rt;
}

function disposeRuntime(id: string) {
	const rt = runtimes.get(id);
	if (!rt) return;
	runtimes.delete(id);
	try {
		rt.term.dispose();
	} catch {
		// Already disposed.
	}
	rt.hostEl.remove();
}

export function resetAllTerminalViews() {
	for (const id of [...runtimes.keys()]) disposeRuntime(id);
	setTerminals([]);
	setActiveTerminalId(null);
	setFindOpen(false);
}

export const terminalCount = () => terminals().length;

export async function createTerminal(profileId?: string, title?: string): Promise<TerminalInfo | null> {
	ensureBackendListeners();
	void ensureProfilesLoaded();
	try {
		const created = await backend.terminalCreate({
			profileId,
			title,
			cols: 80,
			rows: 24,
		});
		createRuntimeFor(created);
		setTerminals((prev) => [...prev, created]);
		setActiveTerminalId(created.id);
		queueMicrotask(() => focusActiveTerminal());
		return created;
	} catch (err: any) {
		notify(`Could not start terminal: ${err?.message ?? String(err)}`, "error");
		return null;
	}
}

export async function killTerminal(id: string) {
	const list = terminals();
	const idx = list.findIndex((t) => t.id === id);
	if (idx < 0) return;
	disposeRuntime(id);
	const remaining = list.filter((t) => t.id !== id);
	setTerminals(remaining);
	if (activeTerminalId() === id) {
		const next = remaining[Math.max(0, idx - 1)] ?? remaining[0] ?? null;
		setActiveTerminalId(next?.id ?? null);
	}
	await backend.terminalKill(id).catch(() => {});
}

export function killActiveTerminal() {
	const id = activeTerminalId();
	if (id) void killTerminal(id);
}

export function clearActiveTerminal() {
	const id = activeTerminalId();
	if (!id) return;
	const rt = runtimes.get(id);
	if (!rt) return;
	rt.term.clear();
	rt.term.focus();
}

export async function restartTerminal(id: string) {
	const existing = terminals().find((t) => t.id === id);
	if (!existing) return;
	const { profileId, title } = existing;
	await killTerminal(id);
	await createTerminal(profileId, title);
}

export async function renameTerminal(id: string) {
	const existing = terminals().find((t) => t.id === id);
	if (!existing) return;
	const next = await ask("Rename terminal", existing.title);
	const trimmed = next?.trim();
	if (!trimmed) return;
	setTerminals((prev) => prev.map((t) => (t.id === id ? { ...t, title: trimmed } : t)));
}

export function focusActiveTerminal() {
	const id = activeTerminalId();
	if (!id) return;
	const rt = runtimes.get(id);
	if (rt?.opened) rt.term.focus();
}

export function openTerminalFind() {
	setFindOpen(true);
	setFindNotFound(false);
	queueMicrotask(() => {
		findInputEl?.focus();
		findInputEl?.select();
	});
}

function runTerminalFind(direction: "next" | "prev") {
	const q = findQuery();
	const id = activeTerminalId();
	const rt = id ? runtimes.get(id) : undefined;
	if (!rt || !q) {
		setFindNotFound(false);
		return;
	}
	const opts = {
		caseSensitive: findCaseSensitive(),
		regex: findRegex(),
		incremental: false,
	};
	const found = direction === "next" ? rt.search.findNext(q, opts) : rt.search.findPrevious(q, opts);
	setFindNotFound(!found);
}

const showTabsRail = createMemo(() => {
	const override = tabsRailOverride();
	if (override !== null) return override;
	return terminals().length >= 2;
});

/**
 * VS Code-style Terminal controls mounted directly in `.bottom-tabs` when Terminal is active:
 * Joined `+ ⌄` New Terminal / Launch Profile split button, Kill, Clear, and More Actions menu.
 */
export function TerminalHeaderActions() {
	createEffect(
		() => true,
		() => {
			ensureBackendListeners();
			void ensureProfilesLoaded();
		},
	);

	const activeInfo = createMemo(() => terminals().find((t) => t.id === activeTerminalId()) ?? null);

	const profileMenuItems = (): MenuItem[] => {
		const list = terminals();
		const profs = profiles();
		const items: MenuItem[] = [];
		if (list.length > 0) {
			for (const t of list) {
				items.push({
					label: t.alive ? t.title : `${t.title} (exited)`,
					checked: t.id === activeTerminalId(),
					run: () => {
						setActiveTerminalId(t.id);
						queueMicrotask(() => focusActiveTerminal());
					},
				});
			}
			items.push("separator");
		}
		if (profs.length > 0) {
			for (const p of profs) {
				items.push({
					label: p.isDefault ? `New ${p.label} (Default)` : `New ${p.label}`,
					run: () => void createTerminal(p.id),
				});
			}
		} else {
			items.push({
				label: "New Default Terminal",
				run: () => void createTerminal(),
			});
		}
		return items;
	};

	const moreMenuItems = (): MenuItem[] => {
		const id = activeTerminalId();
		const rt = id ? runtimes.get(id) : undefined;
		const hasSel = Boolean(rt?.term.hasSelection());
		const hasTerm = Boolean(rt);
		return [
			{
				label: "Find in Terminal…",
				keys: onMac ? "Cmd+F" : "Ctrl+F",
				disabled: !hasTerm,
				why: "Open a terminal first",
				run: openTerminalFind,
			},
			"separator",
			{
				label: "Copy Selection",
				keys: onMac ? "Cmd+C" : "Ctrl+Shift+C",
				disabled: !hasSel,
				why: "Select text in the terminal first",
				run: () => {
					if (rt) void copySelection(rt);
				},
			},
			{
				label: "Paste",
				keys: onMac ? "Cmd+V" : "Ctrl+Shift+V",
				disabled: !hasTerm,
				why: "Open a terminal first",
				run: () => {
					if (rt) void pasteIntoTerminal(rt);
				},
			},
			{
				label: "Select All",
				disabled: !hasTerm,
				why: "Open a terminal first",
				run: () => rt?.term.selectAll(),
			},
			"separator",
			{
				label: "Restart Terminal",
				disabled: !id,
				why: "Open a terminal first",
				run: () => {
					if (id) void restartTerminal(id);
				},
			},
			{
				label: "Rename Terminal…",
				disabled: !id,
				why: "Open a terminal first",
				run: () => {
					if (id) void renameTerminal(id);
				},
			},
			{
				label: "Show Terminal Tabs",
				checked: showTabsRail(),
				run: () => setTabsRailOverride(!showTabsRail()),
			},
		];
	};

	return (
		<div class="bottom-terminal-acts">
			<div class="term-split-btn">
				<button
					type="button"
					class="bottom-action term-new-btn"
					data-terminal-new="true"
					title="New Terminal (Ctrl+Shift+`)"
					aria-label="New Terminal"
					onClick={() => void createTerminal()}
				>
					<Icon name="add" />
				</button>
				<Menu
					floating
					class="bottom-action term-profile-menu"
					label="Launch Terminal Profile or Switch Terminal"
					title="Launch profile or switch active terminal"
					items={profileMenuItems}
				>
					<Icon name="chevron-down" />
				</Menu>
			</div>
			<button
				type="button"
				class="bottom-action"
				data-terminal-kill="true"
				disabled={!activeInfo()}
				title={activeInfo() ? `Kill Terminal (${activeInfo()!.title})` : "Kill Terminal"}
				aria-label="Kill active terminal"
				onClick={killActiveTerminal}
			>
				<Icon name="trash" />
			</button>
			<button
				type="button"
				class="bottom-action"
				data-terminal-clear="true"
				disabled={!activeInfo()}
				title="Clear Terminal"
				aria-label="Clear active terminal"
				onClick={clearActiveTerminal}
			>
				<Icon name="clear-all" />
			</button>
			<Menu
				floating
				class="bottom-action term-more-menu"
				label="More Terminal Actions"
				title="Find, copy, paste, restart, or toggle terminal tabs"
				items={moreMenuItems}
			>
				<Icon name="ellipsis" />
			</Menu>
			<span class="bottom-tab-sep" aria-hidden="true" />
		</div>
	);
}

export function Terminal() {
	const [stageEl, setStageEl] = createSignal<HTMLDivElement | null>(null);
	let fitRaf = 0;

	const scheduleFit = () => {
		if (fitRaf) cancelAnimationFrame(fitRaf);
		fitRaf = requestAnimationFrame(() => {
			fitRaf = 0;
			const id = activeTerminalId();
			const rt = id ? runtimes.get(id) : undefined;
			if (rt) fitRuntime(rt);
		});
	};

	// Reset client runtimes cleanly whenever the open workspace changes.
	createEffect(
		() => state.workspace?.root ?? null,
		(root) => {
			if (trackedWorkspaceRoot !== null && root !== trackedWorkspaceRoot) {
				resetAllTerminalViews();
			}
			trackedWorkspaceRoot = root;
		},
	);

	// Synchronize live 27-theme palette, font size, and uiScale into all active xterm instances.
	createEffect(
		() => [state.settings.theme, state.settings.fontSize, state.settings.uiScale] as const,
		() => {
			requestAnimationFrame(syncAllTerminalThemes);
		},
	);

	// Observe `.term-stage` geometry whenever it is mounted.
	createEffect(
		() => stageEl(),
		(el) => {
			if (!el || typeof ResizeObserver === "undefined") return;
			const observer = new ResizeObserver(scheduleFit);
			observer.observe(el);
			onCleanup(() => observer.disconnect());
		},
	);

	// Mount the active terminal's persistent xterm hostEl into `.term-stage`.
	createEffect(
		() => [stageEl(), activeTerminalId()] as const,
		([el, id]) => {
			if (!el) return;
			el.replaceChildren();
			if (!id) return;
			const rt = runtimes.get(id);
			if (!rt) return;
			el.appendChild(rt.hostEl);
			if (!rt.opened) {
				rt.term.open(rt.hostEl);
				rt.opened = true;
				if (rt.pendingOutput.length) {
					for (const chunk of rt.pendingOutput) rt.term.write(chunk);
					rt.pendingOutput.length = 0;
				}
			}
			syncAllTerminalThemes();
			scheduleFit();
			queueMicrotask(() => rt.term.focus());
		},
	);

	createEffect(
		() => true,
		() => {
			ensureBackendListeners();
			void ensureProfilesLoaded();

			const mq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
			const onScheme = () => requestAnimationFrame(syncAllTerminalThemes);
			mq?.addEventListener?.("change", onScheme);

			// Auto-spawn the first terminal on open, matching VS Code.
			if (terminals().length === 0 && !autoCreating && state.workspace) {
				autoCreating = true;
				void createTerminal().finally(() => {
					autoCreating = false;
				});
			} else {
				scheduleFit();
			}

			onCleanup(() => {
				if (fitRaf) cancelAnimationFrame(fitRaf);
				mq?.removeEventListener?.("change", onScheme);
				setStageEl(null);
			});
		},
	);

	const openStageContextMenu = async (e: MouseEvent) => {
		e.preventDefault();
		const id = activeTerminalId();
		const rt = id ? runtimes.get(id) : undefined;
		const hasSel = Boolean(rt?.term.hasSelection());
		const choice = await chooseFromMenu(
			"Terminal actions",
			[
				{ label: "Copy", value: "copy", keys: onMac ? "Cmd+C" : "Ctrl+Shift+C", disabled: !hasSel },
				{ label: "Paste", value: "paste", keys: onMac ? "Cmd+V" : "Ctrl+Shift+V", disabled: !rt },
				{ label: "Select All", value: "select-all", disabled: !rt },
				"separator",
				{ label: "Find…", value: "find", keys: onMac ? "Cmd+F" : "Ctrl+F", disabled: !rt },
				{ label: "Clear", value: "clear", disabled: !rt },
				"separator",
				{ label: "New Terminal", value: "new" },
				{ label: "Restart Terminal", value: "restart", disabled: !id },
				{ label: "Kill Terminal", value: "kill", danger: true, disabled: !id },
			],
			{ x: e.clientX, y: e.clientY },
		);
		if (!choice) return;
		if (choice === "copy" && rt) void copySelection(rt);
		else if (choice === "paste" && rt) void pasteIntoTerminal(rt);
		else if (choice === "select-all" && rt) rt.term.selectAll();
		else if (choice === "find") openTerminalFind();
		else if (choice === "clear") clearActiveTerminal();
		else if (choice === "new") void createTerminal();
		else if (choice === "restart" && id) void restartTerminal(id);
		else if (choice === "kill" && id) void killTerminal(id);
	};

	const openTabContextMenu = async (info: TerminalInfo, e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const choice = await chooseFromMenu(
			`${info.title} terminal actions`,
			[
				{ label: "Rename…", value: "rename" },
				{ label: "Restart", value: "restart" },
				"separator",
				{ label: "Kill Terminal", value: "kill", danger: true },
			],
			{ x: e.clientX, y: e.clientY },
		);
		if (choice === "rename") void renameTerminal(info.id);
		else if (choice === "restart") void restartTerminal(info.id);
		else if (choice === "kill") void killTerminal(info.id);
	};

	return (
		<div class="term-panel" data-panel="terminal">
			<Show when={findOpen()}>
				<div class="term-find-bar" role="search" aria-label="Find in terminal">
					<input
						ref={findInputEl}
						type="search"
						class={`term-find-input${findNotFound() ? " not-found" : ""}`}
						placeholder="Find in terminal…"
						aria-label="Find in terminal"
						spellcheck="false"
						value={findQuery()}
						onInput={(e) => {
							setFindQuery(e.currentTarget.value);
							setFindNotFound(false);
							if (e.currentTarget.value) runTerminalFind("next");
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								runTerminalFind(e.shiftKey ? "prev" : "next");
							} else if (e.key === "Escape") {
								e.preventDefault();
								setFindOpen(false);
								focusActiveTerminal();
							}
						}}
					/>
					<button
						type="button"
						class={`term-find-btn${findCaseSensitive() ? " active" : ""}`}
						title="Match Case"
						aria-label="Match Case"
						aria-pressed={findCaseSensitive() ? "true" : "false"}
						onClick={() => {
							setFindCaseSensitive((v) => !v);
							runTerminalFind("next");
						}}
					>
						<Icon name="case-sensitive" />
					</button>
					<button
						type="button"
						class={`term-find-btn${findRegex() ? " active" : ""}`}
						title="Use Regular Expression"
						aria-label="Use Regular Expression"
						aria-pressed={findRegex() ? "true" : "false"}
						onClick={() => {
							setFindRegex((v) => !v);
							runTerminalFind("next");
						}}
					>
						<Icon name="regex" />
					</button>
					<button
						type="button"
						class="term-find-btn"
						title="Previous Match (Shift+Enter)"
						aria-label="Previous Match"
						onClick={() => runTerminalFind("prev")}
					>
						<Icon name="arrow-up" />
					</button>
					<button
						type="button"
						class="term-find-btn"
						title="Next Match (Enter)"
						aria-label="Next Match"
						onClick={() => runTerminalFind("next")}
					>
						<Icon name="arrow-down" />
					</button>
					<button
						type="button"
						class="term-find-btn"
						title="Close Find (Escape)"
						aria-label="Close Find"
						onClick={() => {
							setFindOpen(false);
							focusActiveTerminal();
						}}
					>
						<Icon name="close" />
					</button>
				</div>
			</Show>

			<div class="term-body">
				<div
					class="term-stage-wrap"
					onContextMenu={(e) => void openStageContextMenu(e)}
					onMouseDown={() => focusActiveTerminal()}
				>
					<Show
						when={terminals().length > 0}
						fallback={
							<div class="term-empty">
								<span class="term-empty-text">No open terminals.</span>
								<button type="button" class="link term-empty-btn" onClick={() => void createTerminal()}>
									New Terminal
								</button>
							</div>
						}
					>
						<div class="term-stage" ref={(el) => setStageEl(el)} />
					</Show>
				</div>

				<Show when={showTabsRail() && terminals().length > 0}>
					<aside class="term-tabs" role="listbox" aria-label="Open terminals">
						<For each={terminals()} keyed={(t) => t.id}>
							{(item) => {
								const isSelected = () => item().id === activeTerminalId();
								return (
									<div
										role="option"
										tabindex={0}
										aria-selected={isSelected() ? "true" : "false"}
										class={`term-tab-row${isSelected() ? " selected" : ""}${item().alive ? "" : " exited"}`}
										title={`${item().title} — ${item().cwd}`}
										onClick={() => {
											setActiveTerminalId(item().id);
											queueMicrotask(() => focusActiveTerminal());
										}}
										onDblClick={() => void renameTerminal(item().id)}
										onContextMenu={(e) => void openTabContextMenu(item(), e)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												setActiveTerminalId(item().id);
												queueMicrotask(() => focusActiveTerminal());
											} else if (e.key === "Delete") {
												e.preventDefault();
												void killTerminal(item().id);
											}
										}}
									>
										<Icon name="terminal" class="term-tab-icon" />
										<span class="term-tab-name">{item().title}</span>
										<Show when={!item().alive}>
											<span class="term-tab-exit" title={`Exited (${item().exitCode ?? 0})`}>
												{item().exitCode ?? 0}
											</span>
										</Show>
										<div class="term-tab-acts">
											<Show when={!item().alive}>
												<button
													type="button"
													class="term-tab-act"
													title="Restart Terminal"
													aria-label={`Restart ${item().title}`}
													onClick={(e) => {
														e.stopPropagation();
														void restartTerminal(item().id);
													}}
												>
													<Icon name="refresh" />
												</button>
											</Show>
											<button
												type="button"
												class="term-tab-act"
												title="Kill Terminal"
												aria-label={`Kill ${item().title}`}
												onClick={(e) => {
													e.stopPropagation();
													void killTerminal(item().id);
												}}
											>
												<Icon name="trash" />
											</button>
										</div>
									</div>
								);
							}}
						</For>
					</aside>
				</Show>
			</div>
		</div>
	);
}
