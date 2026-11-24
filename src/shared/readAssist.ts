// Pure priority helper for Markdown reading highlight (Live & Read modes).
// When the editor cursor is active in Live mode, the cursor sets a minimum lit floor:
// - cursor at line 20, mouse at line 30 -> lit up to line 30 (reading ahead)
// - cursor at line 20, mouse at line 10 -> stays lit up to line 20 (cursor floor)

/**
 * Computes the last bright (un-dimmed) unit index, or `null` when nothing should be dimmed.
 * - `cursorIndex`: active cursor/selection unit index when the Live editor has focus (`null` in Read mode or when unfocused).
 * - `pointerIndex`: unit index under the mouse pointer (`null` when mouse is outside or above content).
 */
export function resolveReadAssistActiveIndex(options: {
	enabled: boolean;
	unitCount: number;
	cursorIndex: number | null;
	pointerIndex: number | null;
}): number | null {
	if (!options.enabled || options.unitCount <= 0) return null;
	const clamp = (idx: number) => Math.max(0, Math.min(options.unitCount - 1, idx));
	if (options.cursorIndex !== null && options.pointerIndex !== null) {
		return clamp(Math.max(options.cursorIndex, options.pointerIndex));
	}
	if (options.cursorIndex !== null) return clamp(options.cursorIndex);
	if (options.pointerIndex !== null) return clamp(options.pointerIndex);
	return null;
}
