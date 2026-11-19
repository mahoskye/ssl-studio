// The menu bar across the top of the window: File, Edit, Selection, View, Go
// and Help. What each menu holds is data (src/shared/menuBar.ts); this draws
// it, gives it the keyboard, and runs what is chosen.
//
// The keyboard, as a menu bar has it everywhere: F10 goes to the bar, Alt and
// a menu's first letter opens that menu, Left and Right go from menu to menu,
// Up and Down through a menu, a letter to the next entry that starts with it,
// Enter runs, Escape closes the menu and then leaves the bar. Leaving puts the
// keyboard back where it was.
//
// An entry that cannot run now is still an entry: the keyboard lands on it,
// and the menu's last line says why it cannot.
import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { FIELD_COMMANDS, letterItem, MENU_BAR, missing, stepMenu, type BarEntry, type Has } from "../shared/menuBar";
import { keysFor, onOpenMenu, runCommand } from "./commands";
import { activeEditor } from "./editor/EditorGroup";
import { review } from "./editor/Review";
import { nextItem, type MenuItem } from "./Menu";
import { canGo } from "./navigation";
import { isPlanPath } from "./plan/model";
import { isMarkdown, isTable } from "./project";
import { activeDoc, activePath, documents, focusEditor, state } from "./state";

/** A file is in front, not the call graph or a review of changes. */
const inFront = () => state.centerView === "editors" && !review();

/** What the window has now, for the entries that need something before they can run. */
function has(): Has {
	const path = activePath();
	const group = state.groups[state.activeGroup];
	// A plan opens as its chart, a document as its page, a script perhaps as blocks: none of them is the text.
	const asText = (file: string) => (isPlanPath(file) ? Boolean(state.planText[file]) : isMarkdown(file) || isTable(file) ? Boolean(state.mdText[file]) : !(group?.mode === "blocks" && documents.get(file)?.model.getLanguageId() === "ssl"));
	return { folder: Boolean(state.workspace), file: Boolean(path), text: Boolean(path) && inFront() && asText(path!) };
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

/** A box that text is typed into, other than the code editor: a search, a filter, the agent's prompt. */
function textBox(el: Element | null): HTMLElement | null {
	if (!(el instanceof HTMLElement) || el.closest(".monaco-editor")) return null;
	return el.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, [contenteditable=''], [contenteditable=true]") ? el : null;
}

/** One of a text box's own six commands, run in the box. */
async function runInBox(box: HTMLElement, name: (typeof FIELD_COMMANDS)[string]) {
	box.focus();
	if (name !== "paste") return void document.execCommand(name);
	// A page may not paste by itself; it may read the clipboard where the web view allows, and type what it read.
	const text = await navigator.clipboard.readText().catch(() => null);
	if (text === null) return;
	box.focus();
	document.execCommand("insertText", false, text);
}

const PASTE = "editor.action.clipboardPasteAction";
const NO_PASTE = "This window cannot read the clipboard: paste with the keyboard";

/** A menu's entries as they are now, with the keys they have. One that cannot run says why. `box` is the text box the keyboard was in. */
function itemsOf(entries: readonly BarEntry[], box: HTMLElement | null): MenuItem[] {
	const now = has();
	return entries.map((entry): MenuItem => {
		if (entry === "separator") return "separator";
		if ("command" in entry) {
			const way = ({ "go-back": -1, "go-forward": 1 } as Record<string, 1 | -1>)[entry.command];
			const nowhere = way && !canGo(way) ? (way < 0 ? "Nowhere to go back to yet" : "Nowhere to go forward to") : "";
			return { label: entry.label, keys: keysFor(entry.command), run: () => runCommand(entry.command), why: missing(entry, now) || nowhere };
		}
		// A web view that may not read the clipboard cannot paste from a menu; the key still does.
		const noPaste = entry.editor === PASTE && !navigator.clipboard?.readText ? NO_PASTE : "";
		const inBox = FIELD_COMMANDS[entry.editor];
		// With the keyboard in a text box, the box's own commands work on the box, and the code's are not for it.
		if (box) return inBox ? { label: entry.label, keys: editorKeys(entry.editor), run: () => void runInBox(box, inBox), why: noPaste } : { label: entry.label, keys: editorKeys(entry.editor), run: () => {}, why: "For the code: the keyboard is in a text box" };
		// Undo and redo reach text that is not shown as text (blocks, a page), but not a file that is behind something else.
		const behind = !now.text && now.file && !inFront() ? "The file is not in front" : "";
		return { label: entry.label, keys: editorKeys(entry.editor), run: () => runEditor(entry.editor, now.text), why: missing(entry, now) || behind || noPaste };
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
	/** The entry the keyboard is on, for the line that says why it cannot run. */
	const [onItem, setOnItem] = createSignal(-1);
	/** The one name Tab stops on: the bar is one stop, and the arrow keys go along it. */
	const [stop, setStop] = createSignal(0);
	const whyId = createUniqueId();
	let bar!: HTMLDivElement;
	let list: HTMLDivElement | undefined;
	/** What had the keyboard before the bar took it. */
	let before: HTMLElement | null = null;
	/** The bar is moving the keyboard itself: what it hears of that is not the user leaving. */
	let moving = false;

	const names = () => [...bar.querySelectorAll<HTMLElement>(".menubar-name")];
	const rows = () => (open() === null ? [] : [...(list?.querySelectorAll<HTMLElement>("[data-item]") ?? [])]);
	const why = () => {
		const item = items()[onItem()];
		return open() !== null && item && item !== "separator" ? (item.why ?? "") : "";
	};
	const outside = (e: MouseEvent) => {
		if (!bar.contains(e.target as Node)) shut("nowhere");
	};

	/** Opens a menu. From the keyboard the first entry has the keyboard; from the mouse the menu's name keeps it. */
	const show = (index: number, keyboard: boolean) => {
		// What has the keyboard now, when it is not the bar already: a text box there has the Edit menu to itself.
		const from = bar.contains(document.activeElement) ? before : (document.activeElement as HTMLElement | null);
		const loaded = itemsOf(MENU_BAR[index]!.entries, textBox(from));
		moving = true;
		setItems(loaded);
		setOnItem(-1);
		setOpen(index);
		setStop(index);
		document.addEventListener("mousedown", outside, true);
		names()[index]?.focus();
		moving = false;
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
		// Taking the menu away takes the entry that had the keyboard with it: that is not the keyboard leaving the bar.
		moving = true;
		setOpen(null);
		document.removeEventListener("mousedown", outside, true);
		if (to === "name" && at !== null) names()[at]?.focus();
		moving = false;
		if (to === "before") leave();
		else if (to === "nowhere") before = null;
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
	const pick = (item: Exclude<MenuItem, "separator">) => {
		// One that cannot run stays where it is, saying why.
		if (item.why) return;
		shut("before");
		item.run();
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
				all.map((item) => (item === "separator" ? null : item.label)),
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
				if (moving || bar.contains(e.relatedTarget as Node | null)) return;
				// The keyboard went somewhere else: an open menu does not stay behind.
				if (open() !== null) shut("nowhere");
				else before = null;
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
							{/* A press on the menu's own ground leaves the keyboard where it is and the menu open. */}
							<div class="menu-pop" role="menu" aria-label={menu.name} ref={place} onMouseDown={(e) => e.preventDefault()}>
								<For each={items()}>
									{(item, at) =>
										item === "separator" ? (
											<div class="menu-sep" role="separator" data-item />
										) : (
											<button
												class="menu-item"
												role="menuitem"
												data-item
												tabindex={-1}
												// Not the button's own "disabled": the keyboard must be able to land on it to hear why.
												aria-disabled={item.why ? "true" : undefined}
												aria-describedby={item.why ? whyId : undefined}
												title={item.why || undefined}
												onFocus={() => setOnItem(at())}
												// The pointer and the arrow keys move the same mark: there is one entry at hand, not two.
												onMouseMove={(e) => pointed && document.activeElement !== e.currentTarget && e.currentTarget.focus({ preventScroll: true })}
												onClick={() => pick(item)}
											>
												<span class="menu-label">{item.label}</span>
												<Show when={item.keys}>
													<span class="menu-keys">{item.keys}</span>
												</Show>
											</button>
										)
									}
								</For>
								{/* Why the entry at hand cannot run. Always there, so that what reads the screen aloud hears it change. */}
								<div class="menu-why" id={whyId} role="status" classList={{ shown: Boolean(why()) }}>
									{why()}
								</div>
							</div>
						</Show>
					</span>
				)}
			</For>
		</div>
	);
}
