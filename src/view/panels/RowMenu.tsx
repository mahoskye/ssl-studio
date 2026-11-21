// The menu of one row: the things that can be done to a file or a folder. It
// opens at the pointer, or under the row when the keyboard asked for it.
// Nothing in it is marked when it opens, so Enter alone does nothing: an
// action runs only when the user moved to it or clicked it. It wears the
// classes of the app's other menu (Menu.tsx), so the two look alike.
//
// A menu for a text box (`box`) leaves the keyboard in the box: a box that
// saves or shuts when the keyboard leaves it (a table's cell, a block's text)
// must not do so because its own menu opened. The keys then come to the menu
// from the window: Up and Down mark an entry, Enter takes the marked one (and
// does nothing with none marked, here as above), Escape and Tab shut the
// menu, and any other key shuts it and is typed in the box. The box names the
// marked entry to assistive tech, and a line says the menu has opened.
import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { isModifierKey } from "../keys";
import { isMoveKey, moveIndex, typeAhead } from "./rowMoves";
import type { Point } from "./Rows";

export type RowMenuEntry = string | "separator" | { label: string; value?: string; keys?: string };
type ResolvedEntry = "separator" | { label: string; value: string; keys?: string };
type Open = { label: string; items: ResolvedEntry[]; at: Point; opener: Element | null; keep: boolean; resolve: (item: string | null) => void };
const [open, setOpen] = createSignal<Open | null>(null);

const normalizeEntry = (entry: RowMenuEntry): ResolvedEntry =>
	entry === "separator" ? "separator" : typeof entry === "string" ? { label: entry, value: entry } : { label: entry.label, value: entry.value ?? entry.label, keys: entry.keys };

function finish(item: string | null, refocus = true) {
	const menu = open();
	if (!menu) return;
	setOpen(null);
	// Focus goes back to where it was; a dialog that follows takes it from there, and gives it back.
	// A menu that left the keyboard where it was has nothing to give back.
	if (refocus && !menu.keep && menu.opener instanceof HTMLElement && menu.opener.isConnected) menu.opener.focus();
	menu.resolve(item);
}

/**
 * Shows the menu and resolves with the item chosen, or null when it was
 * closed (Escape, Tab, a click elsewhere). <RowMenu /> is on screen for the whole app (App.tsx).
 */
export function chooseFromMenu(label: string, items: RowMenuEntry[], at: Point, options: { /** The text box the menu is for: the keyboard is put in it, and stays in it. */ box?: HTMLElement } = {}): Promise<string | null> {
	finish(null);
	// The menu is tied to the box it was asked for, which is not always what has the keyboard (a right-click on one
	// box while another's menu was open does not move it).
	options.box?.focus();
	return new Promise((resolve) => setOpen({ label, items: items.map(normalizeEntry), at, opener: options.box ?? document.activeElement, keep: Boolean(options.box), resolve }));
}

/** True while a row's menu is open: a dialog under it leaves the menu's own keys to it. */
export const rowMenuOpen = () => open() !== null;

export function RowMenu() {
	onCleanup(() => finish(null));
	return (
		<Show when={open()} keyed>
			{(menu) => {
				const place = (el: HTMLDivElement) => {
					// Kept inside the window, then given the keyboard.
					const box = el.getBoundingClientRect();
					el.style.left = `${Math.max(0, Math.min(menu.at.x, window.innerWidth - box.width))}px`;
					el.style.top = `${Math.max(0, Math.min(menu.at.y, window.innerHeight - box.height))}px`;
					if (!menu.keep) el.focus();
				};
				/** The entry the arrow keys or the pointer have marked, in a menu that does not hold the keyboard. */
				const [marked, setMarked] = createSignal(-1);
				const id = createUniqueId();
				/**
				 * Where the pointer last was over the menu. A web view also reports a move when a menu opens under a pointer
				 * at rest (one kept inside the window's edge does): that marks nothing, or Enter would take an entry nobody chose.
				 */
				let pointerAt: string | null = null;
				const pointerMoved = (e: MouseEvent) => {
					const at = `${e.screenX},${e.screenY}`;
					const moved = pointerAt !== null && pointerAt !== at;
					pointerAt = at;
					return moved;
				};
				const actionable = menu.items.filter((entry): entry is Exclude<ResolvedEntry, "separator"> => entry !== "separator");
				/** What the hidden line says. Filled a moment after it is on the page: a line that arrives already filled is not always read out. */
				const [said, setSaid] = createSignal("");
				if (menu.keep) {
					const saying = setTimeout(() => setSaid(`${menu.label}: ${actionable.map((e) => e.label).join(", ")}. Up and Down choose, Enter takes one, Escape closes.`), 60);
					onCleanup(() => clearTimeout(saying));
				}
				if (menu.keep) {
					const onWindowKey = (e: KeyboardEvent) => {
						const used = () => (e.preventDefault(), e.stopPropagation());
						// A key with Ctrl, Alt or Shift is not the menu's: it shuts the menu and does what it does in the box.
						if (e.ctrlKey || e.metaKey || e.altKey || (e.shiftKey && e.key !== "Tab")) return void (isModifierKey(e.key) || finish(null));
						if (e.key === "Escape") (used(), finish(null));
						else if (e.key === "ArrowDown" || e.key === "ArrowUp") (used(), setMarked(moveIndex(actionable.length, marked(), e.key, { wrap: true })));
						// Enter alone takes nothing, and does not go on to the box or the dialog under the menu.
						else if (e.key === "Enter") (used(), marked() >= 0 && finish(actionable[marked()]!.value));
						// Tab shuts the menu and goes nowhere: the keyboard stays in the box.
						else if (e.key === "Tab") (used(), finish(null));
						// Anything else is for the box: the menu goes, and the key is typed.
						else if (!isModifierKey(e.key)) finish(null);
					};
					// The box lost the keyboard some other way (another window came forward): its menu goes too. A box taken
					// off the page may say nothing; the menu then stays until a key or a click, and acts on nothing.
					const onLeave = () => finish(null);
					// The box says which entry is marked, to what reads the screen aloud: the keyboard never leaves it. A box
					// that names something of its own there (a list's chosen row) names it again whenever no entry is marked,
					// and what it names is read afresh each time: its owner may have changed it while the menu was open.
					const ATTR = "aria-activedescendant";
					const ours = (value: string | null) => Boolean(value?.startsWith(`${id}-`));
					let own: string | null = menu.opener?.getAttribute(ATTR) ?? null;
					const name = (at: number) => {
						const box = menu.opener;
						if (!box) return;
						const now = box.getAttribute(ATTR);
						if (!ours(now)) own = now;
						if (at >= 0) box.setAttribute(ATTR, `${id}-${at}`);
						else if (own === null) box.removeAttribute(ATTR);
						else box.setAttribute(ATTR, own);
					};
					createEffect(() => name(marked()));
					onMount(() => {
						window.addEventListener("keydown", onWindowKey, true);
						menu.opener?.addEventListener("blur", onLeave);
					});
					onCleanup(() => {
						window.removeEventListener("keydown", onWindowKey, true);
						menu.opener?.removeEventListener("blur", onLeave);
						name(-1);
					});
				}
				const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
					const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
					const at = items.indexOf(document.activeElement as HTMLElement);
					if (e.key === "Escape" || e.key === "Tab") {
						e.preventDefault();
						e.stopPropagation();
						finish(null);
					} else if (isMoveKey(e.key)) {
						e.preventDefault();
						items[moveIndex(items.length, at, e.key, { wrap: true })]?.focus();
					} else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
						// A letter goes to the next item that starts with it.
						items[typeAhead(items.map((i) => i.textContent ?? ""), at, e.key)]?.focus();
					}
				};
				return (
					<Portal>
						{/* A press beside a menu that left the keyboard in its box shuts the menu and leaves the keyboard there still. */}
						<div class="row-menu-shade" onMouseDown={(e) => (menu.keep && e.preventDefault(), finish(null))} onContextMenu={(e) => (e.preventDefault(), finish(null))} />
						<div
							ref={(el) => queueMicrotask(() => place(el))}
							class="menu-pop row-menu"
							classList={{ kept: menu.keep }}
							role="menu"
							aria-label={menu.label}
							tabindex={-1}
							style={{ left: `${menu.at.x}px`, top: `${menu.at.y}px` }}
							onKeyDown={onKeyDown}
							onMouseDown={(e) => menu.keep && e.preventDefault()}
							// The pointer's mark goes with the pointer: Enter typed in the box must not take an entry it only passed over.
							onMouseLeave={() => menu.keep && setMarked(-1)}
							onFocusOut={(e) => {
								// Something else took the keyboard (the command palette, say): the menu goes, and does not take it back.
								const to = e.relatedTarget as Node | null;
								if (to && !e.currentTarget.contains(to)) finish(null, false);
							}}
						>
							<For each={menu.items}>
								{(entry) => {
									if (entry === "separator") return <div class="menu-sep" role="separator" />;
									const idx = actionable.indexOf(entry);
									return (
										<button
											type="button"
											class="menu-item"
											classList={{ marked: marked() === idx }}
											id={`${id}-${idx}`}
											role="menuitem"
											tabindex={-1}
											// The pointer and the arrow keys move the one mark.
											onMouseMove={(e) => menu.keep && pointerMoved(e) && marked() !== idx && setMarked(idx)}
											onClick={() => finish(entry.value)}
										>
											<span class="menu-label">{entry.label}</span>
											<Show when={entry.keys}>
												<span class="menu-keys">{entry.keys}</span>
											</Show>
										</button>
									);
								}}
							</For>
						</div>
						{/* The keyboard is not in the menu, so nothing reads it out by itself: this says it has opened, and how it is worked. Beside the menu, not in it: a menu holds entries only. */}
						<Show when={menu.keep}>
							<div class="visually-hidden" role="status">
								{said()}
							</div>
						</Show>
					</Portal>
				);
			}}
		</Show>
	);
}
