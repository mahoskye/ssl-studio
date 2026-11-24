// A box that finds one of many by name, for the call graph's procedures and a
// plan's steps: type part of a name, and the ones that match are listed under
// the box. The arrow keys move through them and Enter, or a click, chooses.
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { matching, type Choice } from "./model";

export function Finder(props: {
	choices: readonly Choice[];
	/** What the box is for, read out and shown on hover. */
	label: string;
	title: string;
	placeholder: string;
	/** What to say when nothing matches what was typed. */
	none: (typed: string) => string;
	onChoose: (id: string) => void;
	/** Exposes a focus callback for canvas Ctrl+F shortcuts. */
	onRef?: (focus: () => void) => void;
	/** Called when Escape is pressed on an already-empty box to return focus cleanly. */
	onEscape?: () => void;
}) {
	const listId = createUniqueId();
	const [text, setText] = createSignal("");
	const [at, setAt] = createSignal(0);
	let inputEl: HTMLInputElement | undefined;
	const found = createMemo(() => matching(props.choices, text()));
	const here = () => Math.min(at(), found().length - 1);
	const choose = (id: string) => {
		setText("");
		props.onChoose(id);
	};
	return (
		<span class="graph-find-box">
			<input
				ref={(el) => {
					inputEl = el;
					props.onRef?.(() => {
						el.focus();
						el.select();
					});
				}}
				class="graph-find"
				type="search"
				role="combobox"
				aria-label={props.label}
				aria-expanded={found().length > 0}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={found().length ? `${listId}-${here()}` : undefined}
				title={props.title}
				placeholder={props.placeholder}
				autocomplete="off"
				spellcheck={false}
				value={text()}
				onInput={(e) => (setText(e.currentTarget.value), setAt(0))}
				onBlur={() => setText("")}
				onKeyDown={(e) => {
					const list = found();
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						if (list.length) setAt((now) => (Math.min(now, list.length - 1) + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
					} else if (e.key === "Enter") {
						e.preventDefault();
						const pick = list[here()];
						if (pick) choose(pick.id);
					} else if (e.key === "Escape") {
						if (text()) {
							// The first Escape empties the box; it is not the view's Escape yet.
							e.preventDefault();
							e.stopPropagation();
							setText("");
						} else {
							e.preventDefault();
							e.stopPropagation();
							inputEl?.blur();
							props.onEscape?.();
						}
					}
				}}
			/>
			<Show when={text().trim()}>
				<ul class="graph-find-list" id={listId} role="listbox" aria-label="What matches">
					<For each={found()} fallback={<li class="none">{props.none(text().trim())}</li>}>
						{(c, i) => (
							// The pointer chooses on its way down, before the box loses the keyboard and the list goes.
							<li id={`${listId}-${i()}`} role="option" aria-selected={i() === here()} classList={{ on: i() === here() }} onMouseDown={(e) => (e.preventDefault(), choose(c.id))} onMouseEnter={() => setAt(i())}>
								<span class="label">{c.name}</span>
								<span class="hint">{c.where}</span>
							</li>
						)}
					</For>
				</ul>
			</Show>
		</span>
	);
}
