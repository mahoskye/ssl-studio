// In-app prompts and confirmations: the system webview may not implement
// window.prompt or window.confirm.
import { createSignal, For, Show } from "solid-js";

type Ask = { title: string; value?: string; buttons: string[]; input: boolean; resolve: (r: { button: string; value: string } | null) => void };
const [current, setCurrent] = createSignal<Ask | null>(null);

export function ask(title: string, value = ""): Promise<string | null> {
	return new Promise((resolve) =>
		setCurrent({ title, value, input: true, buttons: ["OK"], resolve: (r) => resolve(r && r.button === "OK" ? r.value : null) }),
	);
}

export function choose(title: string, buttons: string[]): Promise<string | null> {
	return new Promise((resolve) => setCurrent({ title, buttons, input: false, resolve: (r) => resolve(r?.button ?? null) }));
}

export function Dialogs() {
	let input!: HTMLInputElement;
	const finish = (button: string | null) => {
		const dialog = current();
		setCurrent(null);
		dialog?.resolve(button ? { button, value: input?.value ?? "" } : null);
	};
	return (
		<Show when={current()}>
			{(dialog) => (
				<div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
					<form
						class="dialog"
						onSubmit={(e) => {
							e.preventDefault();
							finish(dialog().buttons[0]!);
						}}
						onKeyDown={(e) => e.key === "Escape" && finish(null)}
					>
						<label>{dialog().title}</label>
						<Show when={dialog().input}>
							<input ref={(el) => ((input = el), queueMicrotask(() => (el.focus(), el.select())))} value={dialog().value} />
						</Show>
						<div class="buttons">
							<For each={dialog().buttons}>
								{(button, i) => (
									<button type={i() === 0 ? "submit" : "button"} class={i() === 0 ? "primary" : ""} ref={(el) => !dialog().input && i() === 0 && queueMicrotask(() => el.focus())} onClick={() => i() > 0 && finish(button)}>
										{button}
									</button>
								)}
							</For>
							<button type="button" onClick={() => finish(null)}>
								Cancel
							</button>
						</div>
					</form>
				</div>
			)}
		</Show>
	);
}
