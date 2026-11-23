// A small menu: a button that opens a list of actions under (or above, when
// near the bottom of the window) it. For the actions that otherwise live only
// in the command palette, where nobody who does not already know their names
// will find them.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { placeAnchoredMenu } from "../shared/contextMenu";
import { Icon } from "./Icon";

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
	 * For a menu inside something that cuts off what runs past its edge (a side panel or bottom bar):
	 * rendered in a Portal and placed cleanly inside the viewport, flipping upward when near the bottom.
	 */
	floating?: boolean;
	items: () => MenuItem[] | Promise<MenuItem[]>;
	children: any;
}) {
	const [items, setItems] = createSignal<MenuItem[] | null>(null);
	let button!: HTMLButtonElement;
	let list: HTMLDivElement | undefined;
	const focusAt = (index: number) => list?.querySelectorAll<HTMLElement>("[data-item]")[index]?.focus();
	const close = (refocus = true) => {
		setItems(null);
		document.removeEventListener("mousedown", outside, true);
		window.removeEventListener("resize", reposition);
		if (refocus) button.focus();
	};
	const outside = (e: MouseEvent) => {
		if (!list?.contains(e.target as Node) && !button.contains(e.target as Node)) close(false);
	};
	const reposition = () => {
		if (!list || !button.isConnected) return;
		// Clear previous constraints so window resizes re-measure natural dimensions cleanly.
		list.style.maxHeight = "";
		list.style.top = "";
		list.style.bottom = "";
		const from = button.getBoundingClientRect();
		const box = list.getBoundingClientRect();
		const naturalH = Math.max(box.height, list.scrollHeight);
		const naturalW = Math.min(Math.max(box.width, list.offsetWidth, 200), Math.min(360, window.innerWidth - 16));
		if (props.floating) {
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
			// Guard non-floating menus too if they would overflow the bottom of the viewport.
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
	const open = async () => {
		const loaded = await props.items();
		setItems(loaded);
		document.addEventListener("mousedown", outside, true);
		window.addEventListener("resize", reposition);
		queueMicrotask(() => {
			reposition();
			focusAt(nextItem(loaded, -1, 1));
		});
	};
	onCleanup(() => {
		document.removeEventListener("mousedown", outside, true);
		window.removeEventListener("resize", reposition);
	});
	const onKey = (e: KeyboardEvent) => {
		const all = items();
		if (!all) return;
		const at = [...(list?.querySelectorAll("[data-item]") ?? [])].indexOf(document.activeElement as Element);
		const to = { ArrowDown: () => nextItem(all, at, 1), ArrowUp: () => nextItem(all, at, -1), Home: () => nextItem(all, -1, 1), End: () => nextItem(all, all.length, -1) }[e.key];
		if (to) {
			e.preventDefault();
			focusAt(to());
		} else if (e.key === "Escape" || e.key === "Tab") {
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	};

	const renderPopup = (all: () => MenuItem[]) => (
		<div
			class="menu-pop"
			classList={{ "menu-pop-floating": Boolean(props.floating) }}
			role="menu"
			aria-label={props.label}
			ref={(el) => (list = el)}
			onKeyDown={onKey}
		>
			<For each={all()}>
				{(item) =>
					item === "separator" ? (
						<div class="menu-sep" role="separator" data-item />
					) : (
						<button
							class="menu-item"
							role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
							aria-checked={item.checked !== undefined ? item.checked : undefined}
							data-item
							tabindex={-1}
							disabled={item.disabled}
							title={item.disabled ? item.why : undefined}
							onClick={() => {
								close();
								item.run();
							}}
						>
							<Show when={item.checked !== undefined}>
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
		<span class={`menu ${props.class ?? ""}`}>
			<button ref={button} title={props.title} aria-label={props.label} aria-haspopup="menu" aria-expanded={items() !== null} onClick={() => (items() ? close() : void open())}>
				{props.children}
			</button>
			<Show when={items()}>
				{(all) =>
					props.floating ? <Portal>{renderPopup(all)}</Portal> : renderPopup(all)
				}
			</Show>
		</span>
	);
}
