// WCAG 2 contrast between two colours, for the tests that hold the themes to it
// (ADR 0007: a rule a machine can check gets a test).

/** Relative luminance of "#rrggbb". */
export function luminance(hex: string): number {
	const value = hex.replace("#", "");
	const channel = (at: number) => {
		const c = parseInt(value.slice(at, at + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** The contrast ratio, from 1 (the same) to 21 (black on white). */
export function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** Text needs this much against what it is on. */
export const TEXT = 4.5;
/** The edge of a control, and other things that are not text, need this much. */
export const BOUNDARY = 3;
