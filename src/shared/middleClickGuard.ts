// Guard against Linux X11/Wayland middle-click primary-selection paste when
// middle-clicking tabs to close them or clicking inside editors (Monaco / CM6).
// Explicit pastes (Ctrl+V, Cmd+V, Shift+Insert, or menu Paste) are never blocked.

/** Time window (ms) after a middle mouse button event during which browser-synthesized paste events are suppressed. */
export const MIDDLE_PASTE_WINDOW_MS = 250;

export type MiddleClickGuard = {
	/** Call on capture-phase mousedown / mouseup / auxclick with `button === 1`. */
	noteMiddleMouse(now?: number): void;
	/** Call on explicit keyboard paste (Ctrl+V, Cmd+V, Shift+Insert) so a fast paste right after closing a tab is allowed. */
	noteExplicitPaste(): void;
	/** Returns true when a `paste` or `beforeinput (insertFromPaste)` event should be suppressed as a middle-click paste. */
	shouldBlockPaste(now?: number): boolean;
};

export function createMiddleClickGuard(windowMs = MIDDLE_PASTE_WINDOW_MS): MiddleClickGuard {
	let lastMiddleAt = -Infinity;
	return {
		noteMiddleMouse(now = performance.now()) {
			lastMiddleAt = now;
		},
		noteExplicitPaste() {
			lastMiddleAt = -Infinity;
		},
		shouldBlockPaste(now = performance.now()) {
			return now - lastMiddleAt >= 0 && now - lastMiddleAt <= windowMs;
		},
	};
}

/** True for explicit keyboard paste shortcuts (`Ctrl+V`, `Ctrl+Shift+V`, `Cmd+V`, `Cmd+Shift+V`, `Shift+Insert`). */
export function isExplicitPasteKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
	if (e.altKey) return false;
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return true;
	if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === "Insert") return true;
	return false;
}

export type MiddleCloseTracker = {
	/** Record middle-button mousedown on a tab. */
	press(key: string): void;
	/** Cancel an in-progress middle press (e.g. pointer left the tab before release, or another button was pressed). */
	cancel(key?: string): void;
	/** Record middle-button mouseup on a tab: defers close until `auxclick` (with a macrotask fallback if `auxclick` does not fire). */
	release(key: string, onClose: () => void): void;
	/** Record `auxclick` on a tab: closes immediately if this tab was pressed, canceling any fallback timer. */
	auxClick(key: string, onClose: () => void): void;
	/** Cancel any pending timer when the tab strip unmounts. */
	dispose(): void;
};

/**
 * Coordinates middle-click tab closing so tabs stay mounted through `mousedown`
 * and `mouseup` (preventing Linux primary-selection paste from landing in a
 * newly focused editor beneath the tab) while closing exactly once on `auxclick`
 * or immediately after `mouseup` in environments that do not fire `auxclick`.
 */
export function createMiddleCloseTracker(
	schedule: (fn: () => void) => ReturnType<typeof setTimeout> = (fn) => setTimeout(fn, 0),
	cancelTimer: (id: ReturnType<typeof setTimeout>) => void = (id) => clearTimeout(id),
): MiddleCloseTracker {
	let pressed: string | null = null;
	let pending: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;

	const clearPending = () => {
		if (pending) {
			cancelTimer(pending.timer);
			pending = null;
		}
	};

	return {
		press(key: string) {
			pressed = key;
		},
		cancel(key?: string) {
			if (key === undefined || pressed === key) pressed = null;
		},
		release(key: string, onClose: () => void) {
			if (pressed !== key) return;
			pressed = null;
			clearPending();
			const timer = schedule(() => {
				if (pending?.key === key) {
					pending = null;
					onClose();
				}
			});
			pending = { key, timer };
		},
		auxClick(key: string, onClose: () => void) {
			if (pending?.key === key) {
				clearPending();
				onClose();
				return;
			}
			if (pressed === key) {
				pressed = null;
				clearPending();
				onClose();
			}
		},
		dispose() {
			pressed = null;
			clearPending();
		},
	};
}
