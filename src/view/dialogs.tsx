// In-app prompts and confirmations: the system webview may not implement
// window.prompt or window.confirm. One is shown at a time; the rest wait
// their turn (dialogQueue.ts).
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { defaultButton, DialogQueue, type Request } from "./dialogQueue";
import { Modal } from "./modal";

const [current, setCurrent] = createSignal<Request | null>(null);
const queue = new DialogQueue(setCurrent);

/** Asks for a line of text. Null when cancelled. */
export function ask(title: string, value = ""): Promise<string | null> {
	return queue.ask(title, value);
}

/**
 * Asks for one of `buttons`; "Cancel" is always offered too and gives null.
 * Enter presses the first button, unless it is the one named in `danger`:
 * a choice that cannot be undone is never the default, and Cancel is.
 */
export function choose(title: string, buttons: string[], options: { danger?: string } = {}): Promise<string | null> {
	return queue.choose(title, buttons, options);
}

function Dialog(props: { request: Request }) {
	const request = props.request;
	const titleId = createUniqueId();
	const inputId = createUniqueId();
	let input: HTMLInputElement | undefined;
	const enter = defaultButton(request);
	const finish = (button: string | null) => queue.finish(request, button ? { button, value: input?.value ?? "" } : null);
	return (
		<Modal
			class="dialog"
			labelledBy={titleId}
			onClose={() => finish(null)}
			onSubmit={(e) => {
				e.preventDefault();
				finish(enter);
			}}
		>
			<Show
				when={request.input}
				fallback={
					<p class="dialog-message" id={titleId}>
						{request.title}
					</p>
				}
			>
				<label for={inputId}>
					<span id={titleId}>{request.title}</span>
					<input id={inputId} ref={input} value={request.value ?? ""} data-autofocus="select" autocomplete="off" spellcheck={false} />
				</label>
			</Show>
			<div class="buttons">
				<For each={request.buttons}>
					{(button) => (
						<button
							type={button === enter ? "submit" : "button"}
							classList={{ primary: button === enter, danger: button === request.danger }}
							data-autofocus={!request.input && button === enter ? "" : undefined}
							onClick={() => button !== enter && finish(button)}
						>
							{button}
						</button>
					)}
				</For>
				<button type="button" classList={{ primary: enter === null }} data-autofocus={!request.input && enter === null ? "" : undefined} onClick={() => finish(null)}>
					Cancel
				</button>
			</div>
		</Modal>
	);
}

export function Dialogs() {
	return (
		<Show when={current()} keyed>
			{(request) => <Dialog request={request} />}
		</Show>
	);
}
