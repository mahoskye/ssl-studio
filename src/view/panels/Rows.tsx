// One mechanism for every list and tree in the panels. The list is a single
// Tab stop that moves with the keyboard (a roving tabindex): Up, Down, Home,
// End and the page keys move, Enter and Space act, Left and Right close and
// open in a tree, letters jump to a row, and the menu key or Shift+F10 opens a
// row's menu. The arithmetic is in rowMoves.ts; this file applies it to the DOM.
import { createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js";
import { isMoveKey, moveIndex, restoreIndex, stopIndex, treeStep, typeAhead, type TreeRow } from "./rowMoves";

export type Point = { x: number; y: number };
type Handlers = { activate(e: KeyboardEvent): void; toggle(): void; key(e: KeyboardEvent): boolean | void; chord(e: KeyboardEvent): boolean | void; menu?: (at: Point) => void };
const handlers = new WeakMap<Element, Handlers>();

const rowsIn = (list: Element) => [...list.querySelectorAll<HTMLElement>("[data-row]")];
const keyOf = (row: HTMLElement) => row.dataset.row ?? "";
const labelOf = (row: HTMLElement) => row.dataset.label ?? row.querySelector(".label")?.textContent ?? row.textContent ?? "";
const treeRow = (row: HTMLElement): TreeRow => ({
	level: Number(row.getAttribute("aria-level") ?? 1),
	expanded: row.hasAttribute("aria-expanded") ? row.getAttribute("aria-expanded") === "true" : undefined,
});

/** How long typed letters are read as one word. */
const TYPE_AHEAD_MS = 700;
/** How long a list waits for a row it was asked to focus, while it reloads. */
const WANTED_MS = 2000;

export type RowsApi = {
	/** Puts the keyboard back in the list: on the row with this key once it is there, else where it last was. */
	focus(key?: string): void;
};

/** The frame around a panel's rows: it scrolls, and it works the keyboard for every Row inside it. */
export function Rows(props: {
	/** What the list holds, for assistive tech. */
	label: string;
	/** "tree" or "listbox" when the rows sit right in it; "group" (the default) when RowGroups inside hold them. */
	role?: "tree" | "listbox" | "group";
	/** In place of "tree", the class that makes it fill the panel and scroll. */
	class?: string;
	/** Hands back the means to put the keyboard in the list. */
	api?: (api: RowsApi) => void;
	onContextMenu?: (e: MouseEvent) => void;
	children: JSX.Element;
}) {
	let el!: HTMLDivElement;
	let stopKey: string | null = null;
	/** Where the keyboard last was in this list. */
	let last: { row: HTMLElement; key: string; index: number } | null = null;
	/** The keyboard is in the list: on `last.row`, or on a row that was redrawn from under it. */
	let held = false;
	let wanted: { key: string; until: number } | null = null;
	let typed = "";
	let typedAt = 0;

	const stopOn = (row: HTMLElement, list: HTMLElement[]) => {
		for (const r of list) {
			const tab = r === row ? 0 : -1;
			if (r.tabIndex !== tab) r.tabIndex = tab;
		}
		stopKey = keyOf(row) || null;
	};
	const focusRow = (row: HTMLElement | undefined, list: HTMLElement[]) => {
		if (!row) return;
		stopOn(row, list);
		row.focus();
		row.scrollIntoView({ block: "nearest" });
	};
	const restore = (list: HTMLElement[]) => {
		if (list.length) focusRow(list[last ? restoreIndex(list.map(keyOf), last.key, last.index) : list.findIndex((r) => r.tabIndex === 0)], list);
		else el.focus();
	};
	/** A row that was asked for takes focus once it is on screen. */
	const settle = (list: HTMLElement[]) => {
		if (!wanted) return;
		if (Date.now() > wanted.until) return void (wanted = null);
		const key = wanted.key;
		const row = key ? list.find((r) => keyOf(r) === key) : undefined;
		if (row) focusRow(row, list);
		// Not there, and the row the keyboard was on has gone: the row now in its place, until the one asked for
		// comes (a file moved to another folder leaves its old place before it is listed in the new one).
		else if (last && !last.row.isConnected) {
			const still = wanted;
			restore(list);
			wanted = key ? still : null;
			return;
		} else if (key || last) return;
		else restore(list);
		wanted = null;
	};
	/** After the rows changed: one of them is the Tab stop, and focus that was in the list stays in it. */
	const sync = () => {
		const list = rowsIn(el);
		if (list.length && !list.some((r) => r.tabIndex === 0)) {
			list[stopIndex(list.map((r) => ({ key: keyOf(r), selected: r.getAttribute("aria-selected") === "true" })), stopKey)]!.tabIndex = 0;
		}
		settle(list);
		const active = document.activeElement;
		const dropped = held && last && !last.row.isConnected && (!active || active === document.body);
		if (list.length && (dropped || active === el)) restore(list);
	};

	const onFocusIn = (e: FocusEvent) => {
		const row = e.target as HTMLElement;
		if (!row.matches?.("[data-row]")) return;
		const list = rowsIn(el);
		stopOn(row, list);
		last = { row, key: keyOf(row), index: list.indexOf(row) };
		held = true;
		wanted = null;
	};
	const onFocusOut = (e: FocusEvent) => {
		const from = last;
		if (!from || e.target !== from.row) return;
		const to = e.relatedTarget as Node | null;
		if (to) {
			if (!el.contains(to)) held = false;
			return;
		}
		// Focus went nowhere: the user clicked on nothing (forget it), or the row was redrawn (sync puts it back).
		setTimeout(() => {
			if (last === from && from.row.isConnected && document.activeElement !== from.row && document.hasFocus()) held = false;
		});
	};
	const onKeyDown = (e: KeyboardEvent) => {
		const target = e.target as HTMLElement;
		const list = rowsIn(el);
		if (target === el) {
			// The list itself holds focus only while it has no row to give it to.
			if (isMoveKey(e.key) && list.length) {
				e.preventDefault();
				focusRow(list[moveIndex(list.length, -1, e.key)], list);
			}
			return;
		}
		const inRow = target.closest<HTMLElement>("[data-row]");
		if (!inRow) return;
		if (inRow !== target) {
			// A control inside a row keeps its own keys, except those that move between rows.
			if (!isMoveKey(e.key)) return;
			e.preventDefault();
			return focusRow(list[moveIndex(list.length, list.indexOf(inRow), e.key)], list);
		}
		const index = list.indexOf(target);
		const row = handlers.get(target);
		if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
			if (!row?.menu) return;
			e.preventDefault();
			const box = target.getBoundingClientRect();
			row.menu({ x: box.left + box.height, y: box.bottom });
			return;
		}
		// A key with Ctrl is the row's own only where the row says so (cut, copy, paste); the rest are the app's.
		if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && row?.chord(e) === true) return void e.preventDefault();
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (isMoveKey(e.key)) {
			e.preventDefault();
			const page = Math.floor(el.clientHeight / Math.max(1, target.offsetHeight)) - 1;
			focusRow(list[moveIndex(list.length, index, e.key, { page })], list);
		} else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
			if (target.getAttribute("role") !== "treeitem") return;
			e.preventDefault();
			const step = treeStep(list.map(treeRow), index, e.key);
			if (step.toggle) row?.toggle();
			else if (step.index !== index) focusRow(list[step.index], list);
		} else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			row?.activate(e);
		} else if (row?.key(e) === true) {
			e.preventDefault();
		} else if (e.key.length === 1 && !e.defaultPrevented) {
			const now = Date.now();
			typed = now - typedAt > TYPE_AHEAD_MS ? e.key : typed + e.key;
			typedAt = now;
			const at = typeAhead(list.map(labelOf), index, typed);
			if (at < 0) return;
			e.preventDefault();
			focusRow(list[at], list);
		}
	};

	onMount(() => {
		const observer = new MutationObserver(sync);
		observer.observe(el, { childList: true, subtree: true });
		onCleanup(() => observer.disconnect());
		sync();
		props.api?.({
			focus(key) {
				wanted = { key: key ?? "", until: Date.now() + WANTED_MS };
				settle(rowsIn(el));
			},
		});
	});

	return (
		<div
			ref={el}
			class={props.class ?? "tree"}
			role={props.role ?? "group"}
			aria-label={props.label}
			tabindex={-1}
			data-rows=""
			onKeyDown={onKeyDown}
			onFocusIn={onFocusIn}
			onFocusOut={onFocusOut}
			onContextMenu={(e) => props.onContextMenu?.(e)}
		>
			{props.children}
		</div>
	);
}

/** One row of a list or a tree. Clicking it and pressing Enter or Space on it do the same thing. */
export function Row(props: {
	/** The same for as long as the row stands for the same thing, so focus follows it through a redraw. */
	key: string;
	/** In place of "tree-row". */
	class?: string;
	classList?: Record<string, boolean | undefined>;
	/** "option" in a listbox (the default), "treeitem" in a tree. */
	role?: "option" | "treeitem";
	/** The list's current choice: the open file, the entry being shown. */
	selected?: boolean;
	/** Depth in a tree, from 1. */
	level?: number;
	/** Open or closed, for a tree row with rows under it; leave out for a leaf. */
	expanded?: boolean;
	/** The whole of what the row says, for when it is cut off. */
	title?: string;
	/** What typed letters match, when it is not the text of the row's `.label`. */
	label?: string;
	style?: JSX.CSSProperties;
	draggable?: boolean;
	onDragStart?: (e: DragEvent) => void;
	onDragEnd?: (e: DragEvent) => void;
	/** Something is dragged over the row, and let go on it. To take it, the row prevents the event's default. */
	onDragOver?: (e: DragEvent) => void;
	onDrop?: (e: DragEvent) => void;
	onActivate?: () => void;
	/** Opens or closes the row: Left and Right in a tree. */
	onToggle?: () => void;
	/** Other keys on the row (F2, Delete). Return true for a key that was used. */
	onKey?: (e: KeyboardEvent) => boolean | void;
	/** Keys pressed with Ctrl (Ctrl+C, Ctrl+V). Return true for a key that was used; the others stay the app's. */
	onChord?: (e: KeyboardEvent) => boolean | void;
	/** The row's menu: right-click, the menu key, Shift+F10. */
	onMenu?: (at: Point) => void;
	onFocus?: () => void;
	/** The pointer has come onto the row. */
	onPoint?: () => void;
	children: JSX.Element;
}) {
	return (
		<div
			ref={(el) =>
				handlers.set(el, {
					activate: () => props.onActivate?.(),
					toggle: () => props.onToggle?.(),
					key: (e) => props.onKey?.(e),
					chord: (e) => props.onChord?.(e),
					menu: props.onMenu && ((at) => props.onMenu?.(at)),
				})
			}
			classList={{ [props.class ?? "tree-row"]: true, ...props.classList }}
			role={props.role ?? "option"}
			tabindex={-1}
			data-row={props.key}
			data-label={props.label}
			aria-selected={props.selected === undefined ? undefined : props.selected ? "true" : "false"}
			aria-level={props.level}
			aria-expanded={props.expanded === undefined ? undefined : props.expanded ? "true" : "false"}
			title={props.title}
			style={props.style}
			draggable={props.draggable}
			onDragStart={(e) => props.onDragStart?.(e)}
			onDragEnd={(e) => props.onDragEnd?.(e)}
			onDragOver={(e) => props.onDragOver?.(e)}
			onDrop={(e) => props.onDrop?.(e)}
			onClick={() => props.onActivate?.()}
			onFocus={() => props.onFocus?.()}
			onMouseEnter={() => props.onPoint?.()}
			onContextMenu={(e) => {
				if (!props.onMenu) return;
				e.preventDefault();
				e.stopPropagation();
				// Opened from the keyboard, the event has no place of its own.
				const box = e.currentTarget.getBoundingClientRect();
				props.onMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + box.height, y: box.bottom });
			}}
		>
			{props.children}
		</div>
	);
}

/**
 * A headed run of rows inside Rows. The heading names the list for assistive
 * tech. With no rows (`rows` false) the heading stands over `empty` instead.
 */
export function RowGroup(props: { head: JSX.Element; headClass?: string; title?: string; rows?: boolean; empty?: JSX.Element; children: JSX.Element }) {
	const id = createUniqueId();
	return (
		<>
			<div class={props.headClass ?? "group-head"} id={id} title={props.title}>
				{props.head}
			</div>
			<Show when={props.rows ?? true} fallback={props.empty}>
				<div role="listbox" aria-labelledby={id}>
					{props.children}
				</div>
			</Show>
		</>
	);
}

/** A button that shows only a glyph: named for assistive tech, with the glyph hidden from it. */
export function IconButton(props: {
	/** The button's name, and its tooltip unless `title` says more. */
	label: string;
	glyph: string;
	title?: string;
	/** For a switch: on or off. */
	pressed?: boolean;
	/** The button opens a menu. */
	menu?: boolean;
	onClick: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void;
}) {
	return (
		<button
			type="button"
			classList={{ on: props.pressed === true }}
			title={props.title ?? props.label}
			aria-label={props.label}
			aria-pressed={props.pressed === undefined ? undefined : props.pressed ? "true" : "false"}
			aria-haspopup={props.menu ? "menu" : undefined}
			onClick={(e) => props.onClick(e)}
		>
			<span aria-hidden="true">{props.glyph}</span>
		</button>
	);
}

/** From a filter box, Down goes into the list under it. Returns true when it did. */
export function focusRowsBelow(from: Element): boolean {
	const list = from.closest(".panel-body")?.querySelector<HTMLElement>("[data-rows]");
	const row = list?.querySelector<HTMLElement>('[data-row][tabindex="0"]') ?? list?.querySelector<HTMLElement>("[data-row]");
	row?.focus();
	return Boolean(row);
}
