// The menu of one row or surface: right-click, the menu key, or Shift+F10.
// Supports section separators, nested submenus (with hover intent, viewport
// edge flipping, and full ADR 0010 keyboard navigation), shortcut hints,
// checkmarks, disabled entries, and danger styling for destructive actions.
//
// Nothing in the root menu is marked when it opens, so Enter alone does
// nothing: an action runs only when the user moved to it or clicked it.
//
// A menu for a text box (`box`) leaves the keyboard in the box: a box that
// saves or shuts when the keyboard leaves it (a table's cell, a block's text)
// must not do so because its own menu opened.
import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
	normalizeMenuEntries,
	placeMenu,
	placeSubmenu,
	type RectBox,
	type ResolvedMenuEntry,
	type ResolvedMenuLeaf,
	type ResolvedMenuSub,
	type RowMenuAction,
	type RowMenuEntry,
	type RowMenuSubmenu,
} from "../../shared/contextMenu";
import { Icon } from "../Icon";
import { isModifierKey } from "../keys";
import { isMoveKey, moveIndex, typeAhead } from "./rowMoves";
import type { Point } from "./Rows";

export type { RowMenuAction, RowMenuEntry, RowMenuSubmenu };

type Open = {
	label: string;
	items: ResolvedMenuEntry[];
	at: Point;
	opener: Element | null;
	keep: boolean;
	resolve: (item: string | null) => void;
};

type OpenSub = {
	entry: ResolvedMenuSub;
	parentIdx: number;
	rect: RectBox;
	triggerEl: HTMLButtonElement;
	focusFirst: boolean;
};

const [open, setOpen] = createSignal<Open | null>(null);

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
export function chooseFromMenu(
	label: string,
	items: RowMenuEntry[],
	at: Point,
	options: { /** The text box the menu is for: the keyboard is put in it, and stays in it. */ box?: HTMLElement } = {},
): Promise<string | null> {
	finish(null);
	const normalized = normalizeMenuEntries(items);
	if (!normalized.length) return Promise.resolve(null);
	// The menu is tied to the box it was asked for, which is not always what has the keyboard (a right-click on one
	// box while another's menu was open does not move it).
	options.box?.focus();
	return new Promise((resolve) =>
		setOpen({
			label,
			items: normalized,
			at,
			opener: options.box ?? document.activeElement,
			keep: Boolean(options.box),
			resolve,
		}),
	);
}

/** True while a row's menu is open: a dialog under it leaves the menu's own keys to it. */
export const rowMenuOpen = () => open() !== null;

const hasCheckedEntry = (entries: readonly ResolvedMenuEntry[]) =>
	entries.some((e) => e !== "separator" && e.kind === "item" && e.checked !== undefined);

export function RowMenu() {
	onCleanup(() => finish(null));
	return (
		<Show when={open()} keyed>
			{(menu) => {
				let hostEl: HTMLDivElement | undefined;
				/** Open submenu chain: index 0 is a child of root (depth 0), index 1 of depth 1, etc. */
				const [trail, setTrail] = createSignal<OpenSub[]>([]);
				let openTimer: ReturnType<typeof setTimeout> | null = null;
				let closeTimer: ReturnType<typeof setTimeout> | null = null;

				const clearOpenTimer = () => {
					if (openTimer) {
						clearTimeout(openTimer);
						openTimer = null;
					}
				};
				const clearCloseTimer = () => {
					if (closeTimer) {
						clearTimeout(closeTimer);
						closeTimer = null;
					}
				};
				const clearTimers = () => {
					clearOpenTimer();
					clearCloseTimer();
				};
				onCleanup(clearTimers);

				const openSubAt = (depth: number, parentIdx: number, entry: ResolvedMenuSub, triggerEl: HTMLButtonElement, focusFirst: boolean) => {
					clearTimers();
					const r = triggerEl.getBoundingClientRect();
					const rect: RectBox = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
					setTrail((prev) => [...prev.slice(0, depth), { entry, parentIdx, rect, triggerEl, focusFirst }]);
				};

				const closeFrom = (depth: number, refocusTrigger = false) => {
					clearTimers();
					const closing = trail()[depth];
					setTrail((prev) => (prev.length > depth ? prev.slice(0, depth) : prev));
					if (refocusTrigger && closing?.triggerEl.isConnected) closing.triggerEl.focus();
				};

				const scheduleOpenSub = (depth: number, parentIdx: number, entry: ResolvedMenuSub, triggerEl: HTMLButtonElement) => {
					clearCloseTimer();
					const current = trail()[depth];
					if (current && current.parentIdx === parentIdx) return;
					clearOpenTimer();
					const delay = current ? 45 : 95;
					openTimer = setTimeout(() => {
						openTimer = null;
						if (triggerEl.isConnected) openSubAt(depth, parentIdx, entry, triggerEl, false);
					}, delay);
				};

				const scheduleCloseSub = (depth: number) => {
					clearOpenTimer();
					if (trail().length <= depth) return;
					clearCloseTimer();
					closeTimer = setTimeout(() => {
						closeTimer = null;
						setTrail((prev) => (prev.length > depth ? prev.slice(0, depth) : prev));
					}, 160);
				};

				const placeRoot = (el: HTMLDivElement) => {
					const box = el.getBoundingClientRect();
					const placed = placeMenu(menu.at, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight });
					el.style.left = `${placed.left}px`;
					el.style.top = `${placed.top}px`;
					el.style.maxHeight = `${placed.maxHeight}px`;
					if (!menu.keep) el.focus();
				};

				const placeSub = (el: HTMLDivElement, sub: OpenSub, depth: number) => {
					const box = el.getBoundingClientRect();
					const placed = placeSubmenu(sub.rect, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight });
					el.style.left = `${placed.left}px`;
					el.style.top = `${placed.top}px`;
					el.style.maxHeight = `${placed.maxHeight}px`;
					el.style.zIndex = `${51 + depth}`;
					if (sub.focusFirst) {
						el.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
					}
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
				const actionable = menu.items.filter(
					(entry): entry is ResolvedMenuLeaf => entry !== "separator" && entry.kind === "item" && !entry.disabled,
				);
				/** What the hidden line says. Filled a moment after it is on the page: a line that arrives already filled is not always read out. */
				const [said, setSaid] = createSignal("");
				if (menu.keep) {
					const saying = setTimeout(
						() => setSaid(`${menu.label}: ${actionable.map((e) => e.label).join(", ")}. Up and Down choose, Enter takes one, Escape closes.`),
						60,
					);
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
					const onLeave = () => finish(null);
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

				const onPanelKeyDown = (depth: number, entries: ResolvedMenuEntry[], e: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
					const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
					const active = document.activeElement as HTMLButtonElement | null;
					const at = active ? items.indexOf(active) : -1;
					if (e.key === "Tab") {
						e.preventDefault();
						e.stopPropagation();
						finish(null);
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						if (depth > 0) closeFrom(depth - 1, true);
						else finish(null);
					} else if (e.key === "ArrowLeft" && depth > 0) {
						e.preventDefault();
						e.stopPropagation();
						closeFrom(depth - 1, true);
					} else if (e.key === "ArrowRight") {
						const rawIdx = active?.dataset.subIdx;
						if (rawIdx !== undefined) {
							const entryIdx = Number(rawIdx);
							const entry = entries[entryIdx];
							if (entry && entry !== "separator" && entry.kind === "submenu") {
								e.preventDefault();
								e.stopPropagation();
								openSubAt(depth, entryIdx, entry, active!, true);
							}
						}
					} else if (isMoveKey(e.key)) {
						e.preventDefault();
						const nextIdx = moveIndex(items.length, at, e.key, { wrap: true });
						const nextBtn = items[nextIdx];
						if (nextBtn) {
							nextBtn.focus();
							const openSub = trail()[depth];
							if (openSub && nextBtn.dataset.subIdx !== String(openSub.parentIdx)) {
								closeFrom(depth, false);
							}
						}
					} else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
						const labels = items.map((i) => i.querySelector(".menu-label")?.textContent ?? i.textContent ?? "");
						const nextIdx = typeAhead(labels, at, e.key);
						if (nextIdx >= 0) {
							items[nextIdx]?.focus();
							const openSub = trail()[depth];
							if (openSub && items[nextIdx]?.dataset.subIdx !== String(openSub.parentIdx)) {
								closeFrom(depth, false);
							}
						}
					}
				};

				const renderItems = (entries: ResolvedMenuEntry[], depth: number) => {
					const showChecks = hasCheckedEntry(entries);
					return (
						<For each={entries}>
							{(entry, entryIdx) => {
								if (entry === "separator") return <div class="menu-sep" role="separator" />;
								if (entry.kind === "submenu") {
									const isOpen = () => trail()[depth]?.parentIdx === entryIdx();
									return (
										<button
											type="button"
											class="menu-item menu-sub-trigger"
											classList={{ "sub-open": isOpen(), danger: Boolean(entry.danger) }}
											role="menuitem"
											aria-haspopup="menu"
											aria-expanded={isOpen()}
											data-sub-idx={String(entryIdx())}
											tabindex={-1}
											onMouseEnter={(e) => !menu.keep && scheduleOpenSub(depth, entryIdx(), entry, e.currentTarget)}
											onMouseMove={(e) => {
												if (menu.keep) return;
												if (pointerMoved(e)) scheduleOpenSub(depth, entryIdx(), entry, e.currentTarget);
											}}
											onClick={(e) => {
												e.stopPropagation();
												openSubAt(depth, entryIdx(), entry, e.currentTarget, true);
											}}
										>
											<Show when={showChecks}>
												<span class="menu-check" aria-hidden="true" />
											</Show>
											<span class="menu-label">{entry.label}</span>
											<Icon name="chevron-right" class="menu-sub-arrow" />
										</button>
									);
								}
								const idx = depth === 0 ? actionable.indexOf(entry) : -1;
								return (
									<button
										type="button"
										class="menu-item"
										classList={{ marked: depth === 0 && idx >= 0 && marked() === idx, danger: Boolean(entry.danger) }}
										id={depth === 0 && idx >= 0 ? `${id}-${idx}` : undefined}
										role="menuitem"
										aria-checked={entry.checked !== undefined ? entry.checked : undefined}
										disabled={entry.disabled}
										tabindex={-1}
										onMouseEnter={() => {
											if (!menu.keep) scheduleCloseSub(depth);
										}}
										onMouseMove={(e) => {
											if (menu.keep) {
												if (idx >= 0 && pointerMoved(e) && marked() !== idx) setMarked(idx);
											} else if (pointerMoved(e)) {
												scheduleCloseSub(depth);
											}
										}}
										onClick={() => !entry.disabled && finish(entry.value)}
									>
										<Show when={showChecks}>
											<span class="menu-check" aria-hidden="true">
												<Show when={entry.checked}>
													<Icon name="check" />
												</Show>
											</span>
										</Show>
										<span class="menu-label">{entry.label}</span>
										<Show when={entry.keys}>
											<span class="menu-keys">{entry.keys}</span>
										</Show>
									</button>
								);
							}}
						</For>
					);
				};

				return (
					<Portal>
						{/* A press beside a menu that left the keyboard in its box shuts the menu and leaves the keyboard there still. */}
						<div
							class="row-menu-shade"
							onMouseDown={(e) => (menu.keep && e.preventDefault(), finish(null))}
							onContextMenu={(e) => (e.preventDefault(), finish(null))}
						/>
						<div
							ref={hostEl}
							class="row-menu-host"
							onFocusOut={(e) => {
								// Moving focus between root and submenu stays inside hostEl; focus leaving the whole menu closes it.
								const to = e.relatedTarget as Node | null;
								if (to && !hostEl?.contains(to)) finish(null, false);
							}}
						>
							<div
								ref={(el) => queueMicrotask(() => placeRoot(el))}
								class="menu-pop row-menu"
								classList={{ kept: menu.keep }}
								role="menu"
								aria-label={menu.label}
								tabindex={-1}
								style={{ left: `${menu.at.x}px`, top: `${menu.at.y}px` }}
								onKeyDown={(e) => onPanelKeyDown(0, menu.items, e)}
								onMouseDown={(e) => menu.keep && e.preventDefault()}
								onMouseEnter={() => clearCloseTimer()}
								// The pointer's mark goes with the pointer: Enter typed in the box must not take an entry it only passed over.
								onMouseLeave={() => menu.keep && setMarked(-1)}
							>
								{renderItems(menu.items, 0)}
							</div>
							<For each={trail()}>
								{(sub, levelIdx) => {
									const depth = () => levelIdx() + 1;
									return (
										<div
											ref={(el) => queueMicrotask(() => placeSub(el, sub, depth()))}
											class="menu-pop row-menu row-submenu"
											role="menu"
											aria-label={sub.entry.label}
											tabindex={-1}
											style={{ left: `${sub.rect.right - 4}px`, top: `${sub.rect.top - 5}px` }}
											onKeyDown={(e) => onPanelKeyDown(depth(), sub.entry.children, e)}
											onMouseEnter={() => clearCloseTimer()}
										>
											{renderItems(sub.entry.children, depth())}
										</div>
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
