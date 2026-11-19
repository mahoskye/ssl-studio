// The menu bar across the top of the window: File, Edit, Selection, View, Go
// and Help. What each menu holds is data (src/shared/menuBar.ts); this draws
// it, gives it the keyboard, and runs what is chosen.
//
// The keyboard, as a menu bar has it everywhere: F10 goes to the bar, Alt and
// a menu's first letter opens that menu, Left and Right go from menu to menu,
// Up and Down through a menu, a letter to the next entry that starts with it,
// Enter runs, Escape closes the menu and then leaves the bar. Leaving puts the
// keyboard back where it was.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { letterItem, MENU_BAR, missing, stepMenu, type BarEntry, type Has } from "../shared/menuBar";
import type { ToolStatus } from "../shared/protocol";
import { copyText, keysFor, onOpenMenu, openSettings, runCommand } from "./commands";
import { activeEditor } from "./editor/EditorGroup";
import { review } from "./editor/Review";
import { nextItem, type MenuItem } from "./Menu";
import { canGo } from "./navigation";
import { isPlanPath } from "./plan/model";
import { isMarkdown, isTable } from "./project";
import { activeDoc, activePath, documents, focusEditor, notify, state } from "./state";

/** What the window has now, for the entries that need something before they can run. */
function has(): Has {
	const path = activePath();
	const group = state.groups[state.activeGroup];
	// A plan opens as its chart, a document as its page, a script perhaps as blocks: none of them is the text.
	const asText = (file: string) => (isPlanPath(file) ? Boolean(state.planText[file]) : isMarkdown(file) || isTable(file) ? Boolean(state.mdText[file]) : !(group?.mode === "blocks" && documents.get(file)?.model.getLanguageId() === "ssl"));
	return { folder: Boolean(state.workspace), file: Boolean(path), text: Boolean(path) && state.centerView === "editors" && !review() && asText(path!) };
}

type KeyService = { lookupKeybinding(id: string): { getLabel(): string | null } | undefined };

/** The keys the text editor has for one of its own commands, as it names them: they differ from system to system. */
function editorKeys(id: string): string {
	// The editor has no public way to ask. Without this the menu shows no keys, and still runs the command.
	const service = (activeEditor() as unknown as { _standaloneKeybindingService?: KeyService } | undefined)?._standaloneKeybindingService;
	try {
		// Its "UpArrow" is this app's "Up": one name for a key, whichever list it is read in.
		return (service?.lookupKeybinding(id)?.getLabel() ?? "").replace(/(Up|Down|Left|Right)Arrow/g, "$1");
	} catch {
		return "";
	}
}

function runEditor(id: string, shown: boolean) {
	const editor = activeEditor();
	if (!editor) return;
	// Behind blocks or a rendered page the text is not on screen, but what was done to it can still be undone.
	if (!shown) return void (id === "undo" ? activeDoc()?.model.undo() : id === "redo" ? activeDoc()?.model.redo() : undefined);
	editor.focus();
	editor.trigger("menu", id, null);
}

function about() {
	const tool = (name: string, status?: ToolStatus) => `${name} ${status?.ok ? (status.version ?? "found") : "not found"}`;
	const text = [`SSL Studio ${state.info?.app ?? ""}`.trim(), tool("language server", state.info?.lsp), tool("opencode", state.info?.opencode)].join(" · ");
	notify(text, "info", { label: "Copy", run: () => void copyText(text, "Copied what this is.") });
}

const PASTE = "editor.action.clipboardPasteAction";

/** A menu's entries as they are now: with the keys they have, and those that cannot run saying why. */
function itemsOf(entries: readonly BarEntry[]): MenuItem[] {
	const now = has();
	return entries.map((entry): MenuItem => {
		if (entry === "separator") return "separator";
		// A web view that may not read the clipboard cannot paste from a menu; the key still does.
		const why = missing(entry, now) || ("editor" in entry && entry.editor === PASTE && !navigator.clipboard?.readText ? "This window cannot read the clipboard: paste with the keyboard" : "");
		const can = { disabled: Boolean(why), why };
		// Back and forward have somewhere to go, or they do not.
		if ("command" in entry) {
			const way = ({ "go-back": -1, "go-forward": 1 } as Record<string, 1 | -1>)[entry.command];
			const nowhere = way && !why && !canGo(way) ? (way < 0 ? "Nowhere to go back to yet" : "Nowhere to go forward to") : "";
			return { label: entry.label, keys: keysFor(entry.command), run: () => runCommand(entry.command), disabled: Boolean(why || nowhere), why: why || nowhere };
		}
		if ("editor" in entry) return { label: entry.label, keys: editorKeys(entry.editor), run: () => runEditor(entry.editor, now.text), ...can };
		return { label: entry.label, run: entry.does === "about" ? about : () => openSettings("keyboard"), ...can };
	});
}

/**
 * Whether the pointer itself moved. A web view also reports a move when the page changes under a pointer at rest
 * (a menu opens, the window is resized): that is not the user pointing at something, and must not take the menu
 * from the keyboard.
 */
let pointerAt = "";
let pointed = false;
/** Hears every move in the window before what is under the pointer does, and says whether it was a real one. */
function track(e: MouseEvent) {
	const at = `${e.screenX},${e.screenY}`;
	pointed = at !== pointerAt;
	pointerAt = at;
}

export function MenuBar() {
	/** The menu that is open, by its place in the bar. */
	const [open, setOpen] = createSignal<number | null>(null);
	const [items, setItems] = createSignal<MenuItem[]>([]);
	/** The one name Tab stops on: the bar is one stop, and the arrow keys go along it. */
	const [stop, setStop] = createSignal(0);
	let bar!: HTMLDivElement;
	let list: HTMLDivElement | undefined;
	/** What had the keyboard before the bar took it. */
	let before: HTMLElement | null = null;

	const names = () => [...bar.querySelectorAll<HTMLElement>(".menubar-name")];
	const rows = () => (open() === null ? [] : [...(list?.querySelectorAll<HTMLElement>("[data-item]") ?? [])]);
	const outside = (e: MouseEvent) => {
		if (!bar.contains(e.target as Node)) shut("nowhere");
	};

	/** Opens a menu. From the keyboard the first entry has the keyboard; from the mouse the menu's name keeps it. */
	const show = (index: number, keyboard: boolean) => {
		const loaded = itemsOf(MENU_BAR[index]!.entries);
		setItems(loaded);
		setOpen(index);
		setStop(index);
		document.addEventListener("mousedown", outside, true);
		names()[index]?.focus();
		if (keyboard) queueMicrotask(() => rows()[nextItem(loaded, -1, 1)]?.focus());
	};
	/** The keyboard goes back to what had it; to the editor when that is gone. */
	const leave = () => {
		const to = before;
		before = null;
		if (to?.isConnected && to !== document.body) to.focus();
		else focusEditor();
	};
	const shut = (to: "before" | "name" | "nowhere") => {
		const at = open();
		setOpen(null);
		document.removeEventListener("mousedown", outside, true);
		if (to === "name" && at !== null) names()[at]?.focus();
		else if (to === "before") leave();
	};
	onMount(() => {
		onOpenMenu((index) => (index === undefined ? names()[stop()]?.focus() : show(index, true)));
		window.addEventListener("mousemove", track, true);
	});
	onCleanup(() => {
		onOpenMenu(null);
		document.removeEventListener("mousedown", outside, true);
		window.removeEventListener("mousemove", track, true);
	});

	/** A menu that would run past the window's edge is moved back inside it. */
	const place = (el: HTMLDivElement) => {
		list = el;
		queueMicrotask(() => {
			const over = el.getBoundingClientRect().right - document.documentElement.clientWidth;
			if (over > 0) el.style.left = `${-over}px`;
		});
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const at = open();
		const all = items();
		const on = rows().indexOf(document.activeElement as HTMLElement);
		const menu = at ?? names().indexOf(document.activeElement as HTMLElement);
		if (menu < 0) return;
		const beside = (by: 1 | -1) => {
			const to = stepMenu(menu, by);
			if (at !== null) return show(to, true);
			setStop(to);
			names()[to]?.focus();
		};
		const to = (index: number) => rows()[index]?.focus();
		if (e.key === "ArrowRight") beside(1);
		else if (e.key === "ArrowLeft") beside(-1);
		else if (e.key === "ArrowDown") at === null ? show(menu, true) : to(nextItem(all, on, 1));
		else if (e.key === "ArrowUp") {
			if (at !== null) to(nextItem(all, on < 0 ? all.length : on, -1));
			else {
				show(menu, false);
				queueMicrotask(() => to(nextItem(items(), items().length, -1)));
			}
		} else if (e.key === "Home" && at !== null) to(nextItem(all, -1, 1));
		else if (e.key === "End" && at !== null) to(nextItem(all, all.length, -1));
		else if (e.key === "Escape") at === null ? leave() : shut("name");
		else if (e.key === "Tab" && at !== null) shut("before");
		else if (e.key.length === 1 && e.key !== " " && at !== null) {
			const found = letterItem(
				all.map((item) => (item === "separator" || item.disabled ? null : item.label)),
				e.key,
				on,
			);
			if (found >= 0) to(found);
		} else return;
		e.preventDefault();
		e.stopPropagation();
	};

	return (
		<div
			class="menubar"
			role="menubar"
			aria-label="Menus"
			ref={bar}
			onKeyDown={onKey}
			onFocusIn={(e) => {
				const from = e.relatedTarget as HTMLElement | null;
				if (from && !bar.contains(from)) before = from;
			}}
			onFocusOut={(e) => {
				// The keyboard went somewhere else: an open menu does not stay behind.
				if (bar.contains(e.relatedTarget as Node | null)) return;
				if (open() !== null) shut("nowhere");
				before = null;
			}}
		>
			<For each={MENU_BAR}>
				{(menu, index) => (
					<span class="menu">
						<button
							class="menubar-name"
							classList={{ open: open() === index() }}
							role="menuitem"
							aria-haspopup="menu"
							aria-expanded={open() === index()}
							title={`${menu.name} (Alt+${menu.letter.toUpperCase()})`}
							tabindex={stop() === index() ? 0 : -1}
							// A press does not move the keyboard by itself in every web view: the click does it, and says how it came.
							onMouseDown={(e) => e.preventDefault()}
							onClick={(e) => {
								if (open() === index()) return shut("before");
								// Enter and Space arrive as a click that no pointer made.
								show(index(), e.detail === 0);
							}}
							onMouseMove={() => pointed && open() !== null && open() !== index() && show(index(), false)}
						>
							{menu.name}
						</button>
						<Show when={open() === index()}>
							{/* A press on the menu's own ground, or on an entry that cannot run, leaves the keyboard where it is and the menu open. */}
							<div class="menu-pop" role="menu" aria-label={menu.name} ref={place} onMouseDown={(e) => e.preventDefault()}>
								<For each={items()}>
									{(item) =>
										item === "separator" ? (
											<div class="menu-sep" role="separator" data-item />
										) : (
											<button
												class="menu-item"
												role="menuitem"
												data-item
												tabindex={-1}
												disabled={item.disabled}
												title={item.disabled ? item.why : undefined}
												// The pointer and the arrow keys move the same mark: there is one entry at hand, not two.
												onMouseMove={(e) => pointed && document.activeElement !== e.currentTarget && e.currentTarget.focus({ preventScroll: true })}
												onClick={() => {
													shut("before");
													item.run();
												}}
											>
												<span class="menu-label">{item.label}</span>
												<Show when={item.keys}>
													<span class="menu-keys">{item.keys}</span>
												</Show>
											</button>
										)
									}
								</For>
							</div>
						</Show>
					</span>
				)}
			</For>
		</div>
	);
}
