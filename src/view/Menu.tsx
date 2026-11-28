// A small menu: a button that opens a list of actions under (or above, when
// near the bottom of the window) it. For the actions that otherwise live only
// in the command palette, where nobody who does not already know their names
// will find them.
import { createEffect, createSignal, For, onCleanup, onFlush, Show } from "solid-js";
import { Portal } from "@solidjs/web";
import { placeAnchoredMenu } from "../shared/contextMenu";
import { Icon } from "./Icon";
import { modalOpen } from "./modal";

export type MenuItem = { label: string; keys?: string; checked?: boolean; run: () => void; disabled?: boolean; why?: string } | "separator";

/** The next item the arrow keys land on: separators and disabled items are stepped over. */
export function nextItem(items: MenuItem[], from: number, by: 1 | -1): number {
	for (let step = 1; step <= items.length; step++) {
		const at = (((from + by * step) % items.length) + items.length) % items.length;
		const item = items[at];
		if (item !== "separator" && item && !item.disabled) return at;
	}
	return from;
}

export function Menu(props: {
	label: string;
	title: string;
	class?: string;
	/**
	 * Rendered in a Portal by default (`true`) so menus inside clipping containers
	 * (toolbars, side panels, tab bars, properties bars, bottom bars) clamp cleanly
	 * inside the viewport and flip upward when near the bottom edge. Pass
	 * `floating={false}` to opt out.
	 */
	floating?: boolean;
	items: () => MenuItem[] | Promise<MenuItem[]>;
	children: any;
}) {
	const isFloating = () => props.floating !== false;
	const [items, setItems] = createSignal<MenuItem[] | null>(null);
	let button!: HTMLButtonElement;
	let list: HTMLDivElement | undefined;
	let openSeq = 0;
	let disposed = false;
	const focusAt = (index: number) => {
		const target = index >= 0 ? list?.querySelectorAll<HTMLElement>("[data-item]")[index] : undefined;
		if (target && !target.hasAttribute("disabled") && target.getAttribute("role") !== "separator") {
			target.focus();
		} else {
			list?.focus();
		}
	};
	const detachListeners = () => {
		document.removeEventListener("mousedown", outside, true);
		window.removeEventListener("resize", reposition);
		window.removeEventListener("blur", onBlur);
		window.removeEventListener("scroll", onScroll, true);
	};
	const close = (refocus = true) => {
		openSeq++;
		setItems(null);
		list = undefined;
		detachListeners();
		if (refocus && button.isConnected) button.focus();
	};
	const outside = (e: MouseEvent) => {
		if (!list?.contains(e.target as Node) && !button.contains(e.target as Node)) close(false);
	};
	const onBlur = () => close(false);
	const onScroll = (e: Event) => {
		if (list && e.target instanceof Node && list.contains(e.target)) return;
		close(false);
	};
	const onFocusOut = (e: FocusEvent) => {
		if (items() === null) return;
		const to = e.relatedTarget as Node | null;
		if (to && !list?.contains(to) && !button.contains(to)) close(false);
	};
	createEffect(
		() => modalOpen() && items() !== null,
		(shouldClose) => {
			if (shouldClose) close(false);
		},
	);
	const reposition = () => {
		if (!list || !button.isConnected) return;
		// Clear previous constraints so window resizes re-measure natural dimensions cleanly.
		list.style.maxHeight = "";
		list.style.maxWidth = "";
		list.style.top = "";
		list.style.bottom = "";
		list.style.left = "";
		list.style.right = "";
		const from = button.getBoundingClientRect();
		const box = list.getBoundingClientRect();
		const naturalH = Math.max(box.height, list.scrollHeight);
		const naturalW = Math.min(Math.max(box.width, list.offsetWidth, from.width, 200), Math.min(360, window.innerWidth - 16));
		if (isFloating()) {
			const placed = placeAnchoredMenu(
				{ left: from.left, right: from.right, top: from.top, bottom: from.bottom },
				{ width: naturalW, height: naturalH },
				{ width: window.innerWidth, height: window.innerHeight },
			);
			list.style.position = "fixed";
			list.style.right = "auto";
			list.style.bottom = "auto";
			list.style.left = `${placed.left}px`;
			list.style.top = `${placed.top}px`;
			list.style.maxHeight = `${placed.maxHeight}px`;
			list.style.maxWidth = `${Math.min(360, window.innerWidth - 16)}px`;
			list.style.overflowY = "auto";
			list.style.overflowX = "hidden";
		} else {
			// Guard non-floating menus vertically AND horizontally inside the viewport.
			const maxW = Math.min(360, Math.max(160, window.innerWidth - 16));
			list.style.maxWidth = `${maxW}px`;
			const rect = list.getBoundingClientRect();
			const parentLeft = (list.offsetParent as HTMLElement | null)?.getBoundingClientRect().left ?? from.left;
			const targetLeft = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
			if (Math.abs(targetLeft - rect.left) > 0.5) {
				list.style.right = "auto";
				list.style.left = `${targetLeft - parentLeft}px`;
			}
			const spaceBelow = window.innerHeight - from.bottom - 8;
			const spaceAbove = from.top - 8;
			if (naturalH > spaceBelow && spaceAbove > spaceBelow) {
				list.style.top = "auto";
				list.style.bottom = "calc(100% + 4px)";
				list.style.maxHeight = `${Math.max(120, spaceAbove - 4)}px`;
				list.style.overflowY = "auto";
			} else if (naturalH > spaceBelow) {
				list.style.maxHeight = `${Math.max(120, spaceBelow)}px`;
				list.style.overflowY = "auto";
			}
		}
	};
	const open = async (focus: "first" | "last" = "first") => {
		const seq = ++openSeq;
		let loaded: MenuItem[];
		try {
			loaded = await props.items();
		} catch {
			if (seq === openSeq && items() !== null) close(false);
			return;
		}
		if (disposed || seq !== openSeq || !button.isConnected || modalOpen()) return;
		setItems(loaded);
		document.addEventListener("mousedown", outside, true);
		window.addEventListener("resize", reposition);
		window.addEventListener("blur", onBlur);
		window.addEventListener("scroll", onScroll, true);
		onFlush(() => {
			if (disposed || seq !== openSeq) return;
			reposition();
			focusAt(focus === "last" ? nextItem(loaded, loaded.length, -1) : nextItem(loaded, -1, 1));
		});
	};
	onCleanup(() => {
		disposed = true;
		openSeq++;
		detachListeners();
	});
	const onKey = (e: KeyboardEvent) => {
		const all = items();
		if (!all) return;
		const at = [...(list?.querySelectorAll("[data-item]") ?? [])].indexOf(document.activeElement as Element);
		const to = {
			ArrowDown: () => nextItem(all, at, 1),
			ArrowUp: () => nextItem(all, at < 0 ? all.length : at, -1),
			Home: () => nextItem(all, -1, 1),
			End: () => nextItem(all, all.length, -1),
		}[e.key];
		if (to) {
			e.preventDefault();
			focusAt(to());
		} else if (e.key === "Escape" || e.key === "Tab") {
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	};

	// In a menu where some items carry a tick, every item keeps the tick's room, so their words start in one column.
	const anyTicks = (all: MenuItem[]) => all.some((item) => item !== "separator" && item.checked !== undefined);
	const renderPopup = (all: () => MenuItem[]) => (
		<div
			class={["menu-pop", { "menu-pop-floating": isFloating() }]}
			role="menu"
			aria-label={props.label}
			tabindex={-1}
			ref={(el) => {
				list = el;
			}}
			onKeyDown={onKey}
			onFocusOut={onFocusOut}
		>
			<For each={all()}>
				{(item) =>
					item === "separator" ? (
						<div class="menu-sep" role="separator" data-item />
					) : (
						<button
							class="menu-item"
							role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
							aria-checked={item.checked !== undefined ? (item.checked ? "true" : "false") : undefined}
							data-item
							tabindex={-1}
							disabled={item.disabled}
							title={item.disabled ? item.why : undefined}
							onClick={() => {
								close();
								item.run();
							}}
						>
							<Show when={item.checked !== undefined || anyTicks(all())}>
								<span class="menu-check" aria-hidden="true">
									<Show when={item.checked}>
										<Icon name="check" />
									</Show>
								</span>
							</Show>
							<span class="menu-label">{item.label}</span>
							<Show when={item.keys}>
								<span class="menu-keys">{item.keys}</span>
							</Show>
						</button>
					)
				}
			</For>
		</div>
	);

	return (
		<span class={["menu", props.class]}>
			<button
				ref={button}
				title={props.title}
				aria-label={props.label}
				aria-haspopup="menu"
				aria-expanded={items() !== null ? "true" : "false"}
				onClick={() => (items() ? close() : void open())}
				onFocusOut={onFocusOut}
				onKeyDown={(e) => {
					if (e.key === "Escape" && items()) {
						e.preventDefault();
						e.stopPropagation();
						close();
					} else if (e.key === "ArrowDown" && !items()) {
						e.preventDefault();
						e.stopPropagation();
						void open("first");
					} else if (e.key === "ArrowUp" && !items()) {
						e.preventDefault();
						e.stopPropagation();
						void open("last");
					}
				}}
			>
				{props.children}
			</button>
			<Show when={items()}>
				{(all) =>
					isFloating() ? <Portal>{renderPopup(all)}</Portal> : renderPopup(all)
				}
			</Show>
		</span>
	);
}
