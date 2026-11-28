// A filter that is out of sight until it is asked for (ADR 0050). A list's
// own menu offers "Filter…" (and Ctrl+F in the list does the same): the box
// then shows with the keyboard in it. Left empty, it goes again when the
// keyboard leaves it or on Escape. While it holds text it stays, so whatever
// is hiding rows is always in sight and can be cleared.
import { createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { MenuItem } from "./Menu";

export type FilterToggle = {
	/** Whether the box is drawn: asked for, or holding text. */
	shown: () => boolean;
	/** Shows the box and puts the keyboard in it, its text selected. */
	open: () => void;
	/** Empties the box and puts it away. */
	clear: () => void;
	/** Puts an empty box away; a box with text stays. */
	settle: () => void;
	/** The box's element, while it is drawn. */
	bind: (el: HTMLInputElement) => void;
};

export function filterToggle(text: () => string, setText: (value: string) => void): FilterToggle {
	const [asked, setAsked] = createSignal(false);
	let input: HTMLInputElement | undefined;
	let focusOnDraw = false;
	const focus = (el: HTMLInputElement) => {
		el.focus();
		el.select();
	};
	return {
		shown: () => asked() || text() !== "",
		open: () => {
			if (input?.isConnected) {
				setAsked(true);
				// A menu that ran this puts the keyboard back on its own button first.
				queueMicrotask(() => input?.isConnected && focus(input));
				return;
			}
			focusOnDraw = true;
			setAsked(true);
		},
		clear: () => {
			setText("");
			setAsked(false);
		},
		settle: () => {
			if (text() === "") setAsked(false);
		},
		bind: (el) => {
			input = el;
			if (!focusOnDraw) return;
			focusOnDraw = false;
			queueMicrotask(() => el.isConnected && focus(el));
		},
	};
}

/** The menu item that shows a list's filter; `before` runs first (to open a folded section, say). */
export const filterMenuItem = (toggle: FilterToggle, before?: () => void, label = "Filter…"): MenuItem => ({
	label,
	keys: "Ctrl+F",
	run: () => {
		before?.();
		toggle.open();
	},
});

/**
 * Ctrl+F (Cmd+F) inside a list shows its filter, as in VS Code's trees. A key typed in a text box is the box's own.
 * True when the key was taken.
 */
export function filterKey(e: KeyboardEvent, toggle: FilterToggle): boolean {
	if (e.key.toLowerCase() !== "f" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
	const at = e.target as HTMLElement | null;
	if (at?.closest("input, textarea, select, [contenteditable='true'], .monaco-editor, .cm-editor")) return false;
	e.preventDefault();
	e.stopPropagation();
	toggle.open();
	return true;
}

/**
 * The box itself. Escape empties it, and on an empty box puts it away and moves the keyboard to the list below.
 * `onKeyDown` gets every other key (the arrow down into the list, for one).
 */
export function FilterBox(props: {
	toggle: FilterToggle;
	value: string;
	onInput: (value: string) => void;
	label: string;
	placeholder: string;
	class?: string;
	style?: JSX.CSSProperties;
	onKeyDown?: (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => void;
	/** Where the keyboard goes when an empty box is put away with Escape. */
	onDismiss?: (box: HTMLInputElement) => void;
}) {
	return (
		<Show when={props.toggle.shown()}>
			<input
				ref={props.toggle.bind}
				class={props.class ?? "filter"}
				type="search"
				aria-label={props.label}
				placeholder={props.placeholder}
				autocomplete="off"
				spellcheck={false}
				value={props.value}
				style={props.style}
				onInput={(e) => props.onInput(e.currentTarget.value)}
				onBlur={() => props.toggle.settle()}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						if (e.currentTarget.value !== "") {
							props.onInput("");
							return;
						}
						const box = e.currentTarget;
						props.onDismiss?.(box);
						props.toggle.clear();
						return;
					}
					props.onKeyDown?.(e);
				}}
			/>
		</Show>
	);
}
