// The `uiScale` setting: the size of the whole interface. 1 is as designed.
export const UI_SCALE = { min: 0.8, max: 1.6, step: 0.1, normal: 1 } as const;

/** A scale inside the allowed range, to two decimals; anything that is not a number is 1. */
export function clampScale(value: unknown): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : UI_SCALE.normal;
	return Math.round(Math.min(UI_SCALE.max, Math.max(UI_SCALE.min, n)) * 100) / 100;
}

/** One step larger (1) or smaller (-1), stopping at the ends of the range. */
export const stepScale = (current: unknown, by: 1 | -1): number => clampScale(clampScale(current) + by * UI_SCALE.step);
