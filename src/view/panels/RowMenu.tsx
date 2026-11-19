// The menu of one row: the things that can be done to a file or a folder. It
// opens at the pointer, or under the row when the keyboard asked for it.
// Nothing in it is marked when it opens, so Enter alone does nothing: an
// action runs only when the user moved to it or clicked it. It wears the
// classes of the app's other menu (Menu.tsx), so the two look alike.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { isMoveKey, moveIndex, typeAhead } from "./rowMoves";
import type { Point } from "./Rows";

type Open = { label: string; items: string[]; at: Point; opener: Element | null; resolve: (item: string | null) => void };
const [open, setOpen] = createSignal<Open | null>(null);

function finish(item: string | null, refocus = true) {
	const menu = open();
	if (!menu) return;
	setOpen(null);
	// Focus goes back to where it was; a dialog that follows takes it from there, and gives it back.
	if (refocus && menu.opener instanceof HTMLElement && menu.opener.isConnected) menu.opener.focus();
	menu.resolve(item);
}

/**
 * Shows the menu and resolves with the item chosen, or null when it was
 * closed (Escape, Tab, a click elsewhere). <RowMenu /> is on screen for the whole app (App.tsx).
 */
export function chooseFromMenu(label: string, items: string[], at: Point): Promise<string | null> {
	finish(null);
	return new Promise((resolve) => setOpen({ label, items, at, opener: document.activeElement, resolve }));
}

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
					el.focus();
				};
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
						<div class="row-menu-shade" onMouseDown={() => finish(null)} onContextMenu={(e) => (e.preventDefault(), finish(null))} />
						<div
							ref={(el) => queueMicrotask(() => place(el))}
							class="menu-pop row-menu"
							role="menu"
							aria-label={menu.label}
							tabindex={-1}
							style={{ left: `${menu.at.x}px`, top: `${menu.at.y}px` }}
							onKeyDown={onKeyDown}
							onFocusOut={(e) => {
								// Something else took the keyboard (the command palette, say): the menu goes, and does not take it back.
								const to = e.relatedTarget as Node | null;
								if (to && !e.currentTarget.contains(to)) finish(null, false);
							}}
						>
							<For each={menu.items}>
								{(item) => (
									<button type="button" class="menu-item" role="menuitem" tabindex={-1} onClick={() => finish(item)}>
										{item}
									</button>
								)}
							</For>
						</div>
					</Portal>
				);
			}}
		</Show>
	);
}
