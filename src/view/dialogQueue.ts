// The dialogs and pickers waiting to be shown, first in first out. A second
// request while one is open waits its turn; it never replaces the open one,
// and two overlays can never mount on top of each other simultaneously, so
// every caller's promise resolves cleanly in FIFO order. No DOM: dialogs.tsx
// draws the single overlay at the head.

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
	/** What each button is, in a line under it. With these the buttons are a list, one under another: for more choices than fit in a row. */
	details?: Record<string, string>;
	resolve: (answer: Answer | null) => void;
};

export type DialogRequest = Request & { kind: "dialog" };

export type QuickPickItemData<T = string> = {
	label: string;
	value: T;
	detail?: string;
	description?: string;
	icon?: string;
	file?: string;
	badge?: { text: string; tone?: string };
	checked?: boolean;
	danger?: boolean;
	divide?: boolean;
	keywords?: string;
};

export type QuickPickQueueOptions<T = string> = {
	title: string;
	placeholder?: string;
	items: QuickPickItemData<T>[];
	empty?: string;
	searchable?: boolean;
};

export type QuickPickRequest<T = any> = {
	kind: "pick";
	title: string;
	placeholder: string;
	items: QuickPickItemData<T>[];
	empty: string;
	searchable: boolean;
	resolve: (value: T | null) => void;
};

export type QuickPickManyQueueOptions<T = string> = {
	title: string;
	placeholder?: string;
	items: QuickPickItemData<T>[];
	initialSelected?: T[];
	empty?: string;
	confirmLabel?: string;
};

export type QuickPickManyRequest<T = any> = {
	kind: "pick-many";
	title: string;
	placeholder: string;
	items: QuickPickItemData<T>[];
	initialSelected?: T[];
	empty: string;
	confirmLabel: string;
	resolve: (values: T[] | null) => void;
};

export type FileBrowserPinnedItem = {
	path: string;
	rel: string;
	detail?: string;
};

export type FileBrowserQueueOptions = {
	title?: string;
	root: string;
	initialDir?: string;
	pinned?: FileBrowserPinnedItem[];
	pinnedLabel?: string;
	exclude?: Set<string> | Iterable<string>;
};

export type FileBrowserRequest = {
	kind: "file";
	title: string;
	root: string;
	initialDir: string;
	pinned: FileBrowserPinnedItem[];
	pinnedLabel: string;
	exclude: Set<string>;
	resolve: (picked: { path: string; rel: string } | null) => void;
};

export type DialogOverlay = DialogRequest | QuickPickRequest | QuickPickManyRequest | FileBrowserRequest;

/** The button Enter presses: the first one, unless it is the dangerous one. Null is Cancel. */
export function defaultButton(request: Pick<Request, "buttons" | "danger">): string | null {
	const first = request.buttons[0];
	return first !== undefined && first !== request.danger ? first : null;
}

export class DialogQueue {
	private waiting: DialogOverlay[] = [];
	private lastShownDialog: Request | null = null;

	/**
	 * `show` is told the dialog request to draw (and null when the head is not a
	 * modal dialog or none is left). Optional `onOverlay` receives every overlay
	 * kind (dialog, QuickPick, multi-select QuickPick, workspace file browser)
	 * from the same single FIFO queue.
	 */
	constructor(
		private show: (request: Request | null) => void,
		private onOverlay?: (overlay: DialogOverlay | null) => void,
	) {}

	/** Creates a queue driven solely by a unified overlay observer (used by `dialogs.tsx`). */
	static unified(onOverlay: (overlay: DialogOverlay | null) => void): DialogQueue {
		return new DialogQueue(() => {}, onOverlay);
	}

	/** The open prompt/choice dialog at the head of the queue, or null if none (or another overlay kind is open). */
	get current(): Request | null {
		const head = this.waiting[0];
		return head?.kind === "dialog" ? head : null;
	}

	/** The single active overlay at the head of the unified FIFO queue, or null when idle. */
	get active(): DialogOverlay | null {
		return this.waiting[0] ?? null;
	}

	get length(): number {
		return this.waiting.length;
	}

	private emitHead() {
		const head = this.waiting[0] ?? null;
		const nextDialog = head?.kind === "dialog" ? head : null;
		if (nextDialog !== this.lastShownDialog) {
			this.lastShownDialog = nextDialog;
			this.show(nextDialog);
		}
		this.onOverlay?.(head);
	}

	private push(overlay: DialogOverlay) {
		this.waiting.push(overlay);
		if (this.waiting.length === 1) this.emitHead();
	}

	/** A prompt: the text entered, or null when cancelled. */
	ask(title: string, value = ""): Promise<string | null> {
		return new Promise((resolve) =>
			this.push({
				kind: "dialog",
				title,
				value,
				input: true,
				buttons: ["OK"],
				resolve: (a) => resolve(a && a.button === "OK" ? a.value : null),
			}),
		);
	}

	/** A choice: the button pressed, or null when cancelled. */
	choose(title: string, buttons: string[], options: { danger?: string; details?: Record<string, string> } = {}): Promise<string | null> {
		return new Promise((resolve) =>
			this.push({
				kind: "dialog",
				title,
				buttons,
				input: false,
				danger: options.danger,
				details: options.details,
				resolve: (a) => resolve(a?.button ?? null),
			}),
		);
	}

	/** A single-select QuickPick list: the picked value, or null when cancelled. */
	quickPick<T = string>(options: QuickPickQueueOptions<T>): Promise<T | null> {
		return new Promise((resolve) =>
			this.push({
				kind: "pick",
				title: options.title,
				placeholder: options.placeholder ?? "Type to filter…",
				items: options.items,
				empty: options.empty ?? "No matching items.",
				searchable: options.searchable ?? true,
				resolve,
			}),
		);
	}

	/** A multi-select QuickPick list: the confirmed array of values, or null when cancelled. */
	quickPickMany<T = string>(options: QuickPickManyQueueOptions<T>): Promise<T[] | null> {
		return new Promise((resolve) =>
			this.push({
				kind: "pick-many",
				title: options.title,
				placeholder: options.placeholder ?? "Type to filter…",
				items: options.items,
				...(options.initialSelected !== undefined ? { initialSelected: options.initialSelected } : {}),
				empty: options.empty ?? "No matching items.",
				confirmLabel: options.confirmLabel ?? "Confirm",
				resolve,
			}),
		);
	}

	/** A workspace file browser: the picked `{ path, rel }`, or null when cancelled. */
	browseWorkspaceFile(options: FileBrowserQueueOptions): Promise<{ path: string; rel: string } | null> {
		const exclude = options.exclude instanceof Set ? options.exclude : new Set(options.exclude ?? []);
		return new Promise((resolve) =>
			this.push({
				kind: "file",
				title: options.title ?? "Select a file",
				root: options.root,
				initialDir: options.initialDir ?? options.root,
				pinned: options.pinned ?? [],
				pinnedLabel: options.pinnedLabel ?? "Suggested files",
				exclude,
				resolve,
			}),
		);
	}

	/** Answers the open dialog (null cancels it) and shows the next. A request that is not the open one is ignored. */
	finish(request: Request, answer: Answer | null) {
		if (this.waiting[0] !== request) return;
		this.waiting.shift();
		this.emitHead();
		request.resolve(answer);
	}

	/** Answers any open overlay at the head of the queue and advances to the next. Non-head overlays are ignored. */
	finishOverlay(overlay: DialogRequest, value: Answer | null): void;
	finishOverlay<T>(overlay: QuickPickRequest<T>, value: T | null): void;
	finishOverlay<T>(overlay: QuickPickManyRequest<T>, value: T[] | null): void;
	finishOverlay(overlay: FileBrowserRequest, value: { path: string; rel: string } | null): void;
	finishOverlay(overlay: DialogOverlay, value: any): void;
	finishOverlay(overlay: DialogOverlay, value: any): void {
		if (this.waiting[0] !== overlay) return;
		this.waiting.shift();
		this.emitHead();
		(overlay.resolve as (v: any) => void)(value);
	}
}
