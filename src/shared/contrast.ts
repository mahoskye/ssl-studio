// WCAG 2.1/2.2 contrast between two colours, for the tests that hold the themes
// to it (ADR 0007: a rule a machine can check gets a test).

type RGBA = { r: number; g: number; b: number; a: number };

function parseHex(hex: string): RGBA | null {
	if (typeof hex !== "string") return null;
	const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
	if (!match) return null;
	const raw = match[1]!;
	if (raw.length === 3 || raw.length === 4) {
		return {
			r: parseInt(raw[0]! + raw[0]!, 16),
			g: parseInt(raw[1]! + raw[1]!, 16),
			b: parseInt(raw[2]! + raw[2]!, 16),
			a: raw.length === 4 ? parseInt(raw[3]! + raw[3]!, 16) : 255,
		};
	}
	return {
		r: parseInt(raw.slice(0, 2), 16),
		g: parseInt(raw.slice(2, 4), 16),
		b: parseInt(raw.slice(4, 6), 16),
		a: raw.length === 8 ? parseInt(raw.slice(6, 8), 16) : 255,
	};
}

function channelLuminance(byte: number): number {
	const c = byte / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbLuminance(r: number, g: number, b: number): number {
	return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** Relative luminance of "#rgb", "#rgba", "#rrggbb", or "#rrggbbaa" (NaN if invalid). */
export function luminance(hex: string): number {
	const rgba = parseHex(hex);
	if (!rgba) return NaN;
	return rgbLuminance(rgba.r, rgba.g, rgba.b);
}

/**
 * The WCAG contrast ratio, from 1 (the same) to 21 (black on white).
 * When the foreground `a` has alpha < 255 (#rgba or #rrggbbaa), it is
 * alpha-composited over the background `b` before computing luminance.
 * Returns NaN if either colour is not a valid hex colour.
 */
export function contrast(a: string, b: string): number {
	const fg = parseHex(a);
	const bg = parseHex(b);
	if (!fg || !bg) return NaN;
	let fgR = fg.r;
	let fgG = fg.g;
	let fgB = fg.b;
	if (fg.a < 255) {
		const alpha = fg.a / 255;
		fgR = fg.r * alpha + bg.r * (1 - alpha);
		fgG = fg.g * alpha + bg.g * (1 - alpha);
		fgB = fg.b * alpha + bg.b * (1 - alpha);
	}
	const l1 = rgbLuminance(fgR, fgG, fgB);
	const l2 = rgbLuminance(bg.r, bg.g, bg.b);
	const hi = Math.max(l1, l2);
	const lo = Math.min(l1, l2);
	return (hi + 0.05) / (lo + 0.05);
}

/** Text needs this much against what it is on. */
export const TEXT = 4.5;
/** The edge of a control, and other things that are not text, need this much. */
export const BOUNDARY = 3;

/**
 * Picks the higher-contrast readable foreground ("#ffffff" vs warm studio ink "#171411")
 * against `bg`, falling back to "#000000" only if a mid-tone custom background needs
 * extra contrast to clear WCAG AA (>= 4.5:1).
 */
export function pickAccentFg(bg: string): string {
	const white = "#ffffff";
	const ink = "#171411";
	const cw = contrast(white, bg);
	const ci = contrast(ink, bg);
	if (Number.isNaN(cw) || Number.isNaN(ci)) return white;
	if (cw >= ci && cw >= TEXT) return white;
	if (ci >= cw && ci >= TEXT) return ink;
	return cw >= contrast("#000000", bg) ? white : "#000000";
}
