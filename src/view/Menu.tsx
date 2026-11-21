// A small menu: a button that opens a list of actions under it. For the
// actions that otherwise live only in the command palette, where nobody who
// does not already know their names will find them.
import { createSignal, For, onCleanup, Show } from "solid-js";
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
	 * For a menu inside something that cuts off what runs past its edge (a side panel): the list is placed by the
	 * window, under its button and inside the window, and is not cut off.
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
		if (refocus) button.focus();
	};
	const outside = (e: MouseEvent) => {
		if (!list?.contains(e.target as Node) && !button.contains(e.target as Node)) close(false);
	};
	const open = async () => {
		const loaded = await props.items();
		setItems(loaded);
		document.addEventListener("mousedown", outside, true);
		queueMicrotask(() => {
			if (props.floating && list) {
				const from = button.getBoundingClientRect();
				const edge = 8;
				list.style.position = "fixed";
				list.style.right = "auto";
				list.style.top = `${from.bottom}px`;
				// Under the button, its right edge on the button's where there is room, and inside the window always.
				list.style.left = `${Math.max(edge, Math.min(from.right - list.offsetWidth, window.innerWidth - list.offsetWidth - edge))}px`;
				list.style.maxHeight = `${Math.max(120, window.innerHeight - from.bottom - edge)}px`;
				list.style.overflowY = "auto";
			}
			focusAt(nextItem(loaded, -1, 1));
		});
	};
	onCleanup(() => document.removeEventListener("mousedown", outside, true));
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
	return (
		<span class={`menu ${props.class ?? ""}`}>
			<button ref={button} title={props.title} aria-label={props.label} aria-haspopup="menu" aria-expanded={items() !== null} onClick={() => (items() ? close() : void open())}>
				{props.children}
			</button>
			<Show when={items()}>
				{(all) => (
					<div class="menu-pop" role="menu" aria-label={props.label} ref={list} onKeyDown={onKey}>
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
				)}
			</Show>
		</span>
	);
}
