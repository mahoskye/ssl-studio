// One wrapper for every modal: the dialogs, the quick pick, Settings and the
// style profile. It names the dialog, takes the keyboard when it opens and
// gives it back when it closes, keeps Tab inside, closes on Escape or a click
// on the overlay, and makes the rest of the app inert meanwhile.
import { createSignal, onSettled } from "solid-js";
import { dynamic, Portal, type JSX } from "@solidjs/web";
import { rowMenuOpen } from "./panels/RowMenu";

type Open = {
	overlay: () => HTMLElement | undefined;
	dialog: () => HTMLElement | undefined;
	close: () => void;
	key: (e: KeyboardEvent) => boolean | void;
};

/** The open modals, the one on top last. */
const stack: Open[] = [];
const [depth, setDepth] = createSignal(0);

/** True while a modal is open. The keymap stands down: only the modal's own keys work. */
export const modalOpen = () => depth() > 0;

let focusFallback: () => void = () => {};
/** Where the keyboard goes on close when what had it before is gone: the active editor. */
export const setFocusFallback = (focus: () => void) => (focusFallback = focus);

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const focusable = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);

/** Tab and Shift+Tab go round inside the dialog, never out to the page behind. */
function keepInside(e: KeyboardEvent, dialog: HTMLElement) {
	const items = focusable(dialog);
	const first = items[0];
	const last = items[items.length - 1];
	const active = document.activeElement;
	if (!first || !last) {
		e.preventDefault();
		dialog.focus();
	} else if (!dialog.contains(active) || (e.shiftKey && (active === first || active === dialog))) {
		e.preventDefault();
		(e.shiftKey ? last : first).focus();
	} else if (!e.shiftKey && active === last) {
		e.preventDefault();
		first.focus();
	}
}

// One listener for all modals, ahead of the keymap's (commands.ts) and of
// anything in the page: the modal on top sees the key first.
if (typeof window !== "undefined") {
	window.addEventListener(
		"keydown",
		(e) => {
			if (e.isComposing || e.keyCode === 229) return;
			const top = stack[stack.length - 1];
			if (!top) return;
			// A menu opened over the dialog (a right-click in one of its boxes) has the keys while it is open: Escape shuts
			// the menu, not the dialog under it.
			// Only the keys the menu uses. Tab is one of them: it shuts the menu and moves nothing, in a dialog as elsewhere.
			if (rowMenuOpen() && ((e.target instanceof Element && e.target.closest(".row-menu")) || ["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key))) return;
			if (top.key(e)) return;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopImmediatePropagation();
				top.close();
			} else if (e.key === "Tab") {
				const dialog = top.dialog();
				if (dialog) keepInside(e, dialog);
			} else if (e.key === "Enter") {
				// A click on a dialog's own padding leaves the focus on the dialog, where
				// Enter would do nothing. It still means the dialog's default button.
				const dialog = top.dialog();
				const on = e.target as HTMLElement | null;
				if (dialog instanceof HTMLFormElement && on && dialog.contains(on) && !on.closest("button, input, textarea, select, a[href], [contenteditable], [role=option]")) {
					e.preventDefault();
					dialog.requestSubmit();
				}
			}
		},
		true,
	);
}

const KEEP_INTERACTIVE_SELECTOR = ".row-menu-host, .row-menu-shade, .toasts";

function isRowMenuPortalWrapper(el: HTMLElement): boolean {
	for (const child of el.children) {
		if (child instanceof HTMLElement && child.classList.contains("row-menu-host")) return true;
	}
	return false;
}

function isolateNode(el: HTMLElement, activeOverlay: HTMLElement, made: HTMLElement[]) {
	if (el === activeOverlay || el.contains(activeOverlay)) return;
	if (el.matches(KEEP_INTERACTIVE_SELECTOR) || isRowMenuPortalWrapper(el)) return;
	if (el.querySelector(KEEP_INTERACTIVE_SELECTOR)) {
		for (const child of el.children) {
			if (child instanceof HTMLElement) isolateNode(child, activeOverlay, made);
		}
		return;
	}
	if (!el.inert) {
		el.inert = true;
		made.push(el);
	}
}

/**
 * Makes everything outside `overlay` inert up to `document.body`, skipping
 * `.row-menu-host`, `.row-menu-shade`, and `.toasts` so context menus inside
 * dialogs and toast notifications remain interactive. Returns the elements made inert.
 */
export function isolateOutsideOverlay(overlay: HTMLElement): HTMLElement[] {
	const made: HTMLElement[] = [];
	if (typeof document === "undefined" || !document.body) return made;
	for (let node: HTMLElement | null = overlay; node && node !== document.body; node = node.parentElement) {
		for (const sibling of node.parentElement?.children ?? []) {
			if (sibling !== node && sibling instanceof HTMLElement) {
				isolateNode(sibling, overlay, made);
			}
		}
	}
	return made;
}

let isolated: HTMLElement[] = [];

function syncIsolation() {
	for (const el of isolated) el.inert = false;
	isolated = [];
	const topOverlay = stack[stack.length - 1]?.overlay();
	if (!topOverlay || !topOverlay.isConnected) return;
	isolated = isolateOutsideOverlay(topOverlay);
}

export function Modal(props: {
	/** The dialog's own classes: "dialog", "dialog settings", "quickpick". */
	class: string;
	/** Near the top of the window, as the quick pick is, not centred. */
	top?: boolean;
	/** The id of the visible title; or `label` when there is none. */
	labelledBy?: string;
	label?: string;
	/** Escape, or a click on the overlay. */
	onClose: () => void;
	/** Makes the dialog a form: Enter in an input submits it. */
	onSubmit?: (e: SubmitEvent) => void;
	/** A key the modal wants before Escape and Tab get their usual meaning; true says it was handled. */
	onKey?: (e: KeyboardEvent) => boolean | void;
	children: JSX.Element;
}) {
	// What had the keyboard before, read before anything of the modal exists.
	const previous = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
	let overlay: HTMLDivElement | undefined;
	let dialog: HTMLElement | undefined;
	const entry: Open = { overlay: () => overlay, dialog: () => dialog, close: () => props.onClose(), key: (e) => props.onKey?.(e) };

	onSettled(() => {
		stack.push(entry);
		setDepth(stack.length);
		syncIsolation();
		// The element marked `data-autofocus`, else the first control, else the dialog itself.
		const target = dialog?.querySelector<HTMLElement>("[data-autofocus]") ?? (dialog && focusable(dialog)[0]) ?? dialog;
		target?.focus();
		if (target instanceof HTMLInputElement && target.dataset.autofocus === "select") target.select();
		return () => {
			const at = stack.indexOf(entry);
			const wasTop = at === stack.length - 1;
			const containedFocus = Boolean(overlay && typeof document !== "undefined" && overlay.contains(document.activeElement));
			if (at >= 0) stack.splice(at, 1);
			setDepth(stack.length);
			syncIsolation();
			if (!wasTop && !containedFocus) return;
			// Back to what had the keyboard; when that is gone or cannot take it, the underlying modal or the editor.
			if (previous && previous !== document.body && previous.isConnected && !previous.closest("[inert]")) previous.focus();
			if (!previous || (typeof document !== "undefined" && document.activeElement !== previous)) {
				const nextTop = stack[stack.length - 1]?.dialog();
				if (nextTop && nextTop.isConnected) nextTop.focus();
				else focusFallback();
			}
		};
	});

	const DialogTag = dynamic(() => (props.onSubmit ? "form" : "div") as "div");

	const renderOverlay = () => (
		<div class={["overlay", { top: props.top }]} ref={overlay} onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
			<DialogTag
				ref={(el: HTMLElement) => {
					dialog = el;
				}}
				class={props.class}
				role="dialog"
				aria-modal="true"
				aria-labelledby={props.labelledBy}
				aria-label={props.labelledBy ? undefined : props.label}
				tabindex="-1"
				onSubmit={(e: SubmitEvent) => props.onSubmit?.(e)}
			>
				{props.children}
			</DialogTag>
		</div>
	);

	return typeof document !== "undefined" && document.body ? <Portal mount={document.body}>{renderOverlay()}</Portal> : renderOverlay();
}
