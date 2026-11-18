// The dialogs waiting to be shown, first in first out. A second request
// while one is open waits its turn; it never replaces the open one, so every
// caller's promise resolves. No DOM: dialogs.tsx draws the one at the head.

export type Answer = { button: string; value: string };

export type Request = {
	title: string;
	/** The text the input starts with, for a prompt. */
	value?: string;
	/** A prompt has a text input; a choice has only buttons. */
	input: boolean;
	/** The buttons before "Cancel", which every dialog has. */
	buttons: string[];
	/** The button that cannot be undone: never the Enter default. */
	danger?: string;
	resolve: (answer: Answer | null) => void;
};

/** The button Enter presses: the first one, unless it is the dangerous one. Null is Cancel. */
export function defaultButton(request: Pick<Request, "buttons" | "danger">): string | null {
	const first = request.buttons[0];
	return first !== undefined && first !== request.danger ? first : null;
}

export class DialogQueue {
	private waiting: Request[] = [];

	/** `show` is told the request to draw, and null when none is left. */
	constructor(private show: (request: Request | null) => void) {}

	get current(): Request | null {
		return this.waiting[0] ?? null;
	}

	get length(): number {
		return this.waiting.length;
	}

	private push(request: Request) {
		this.waiting.push(request);
		if (this.waiting.length === 1) this.show(request);
	}

	/** A prompt: the text entered, or null when cancelled. */
	ask(title: string, value = ""): Promise<string | null> {
		return new Promise((resolve) => this.push({ title, value, input: true, buttons: ["OK"], resolve: (a) => resolve(a && a.button === "OK" ? a.value : null) }));
	}

	/** A choice: the button pressed, or null when cancelled. */
	choose(title: string, buttons: string[], options: { danger?: string } = {}): Promise<string | null> {
		return new Promise((resolve) => this.push({ title, buttons, input: false, danger: options.danger, resolve: (a) => resolve(a?.button ?? null) }));
	}

	/** Answers the open dialog (null cancels it) and shows the next. A request that is not the open one is ignored. */
	finish(request: Request, answer: Answer | null) {
		if (this.waiting[0] !== request) return;
		this.waiting.shift();
		this.show(this.waiting[0] ?? null);
		request.resolve(answer);
	}
}
