// What the call graph and a plan's chart share: the maths of a view that pans
// and zooms, the arrow keys' nearest node, the width of a line of text, and a
// choice a view remembers. The maths is pure, and tested without a window.

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = Point & Size;
export type View = { x: number; y: number; scale: number };

export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The smallest text Fit may leave on screen, in pixels (ADR 0007: legible first). */
export const LEGIBLE_PX = 11;

/** The smallest scale at which text of this size can still be read. Never above 100 %. */
export const legibleScale = (fontPx: number, legiblePx = LEGIBLE_PX) => Math.min(1, legiblePx / fontPx);

/**
 * The view that shows the content whole, or as much of it as stays legible.
 * It never enlarges past 100 % and never shrinks below `floor`. Content that
 * fits is centred across and starts at the top; content that does not starts
 * at its near edge, or keeps `anchor` (a point of the content) in sight, and
 * the rest is reached by panning.
 */
export function fitView(content: Size, box: Size, options: { floor: number; margin?: number; anchor?: Point }): View {
	const margin = options.margin ?? 20;
	const across = (box.width - 2 * margin) / (content.width || 1);
	const down = (box.height - 2 * margin) / (content.height || 1);
	const scale = clamp(Math.min(across, down), Math.min(1, options.floor), 1);
	const place = (length: number, room: number, anchor: number | undefined, centre: boolean) => {
		const size = length * scale;
		if (size + 2 * margin <= room) return centre ? (room - size) / 2 : margin;
		const wanted = anchor === undefined ? margin : room / 2 - anchor * scale;
		return clamp(wanted, room - margin - size, margin);
	};
	return { x: place(content.width, box.width, options.anchor?.x, true), y: place(content.height, box.height, options.anchor?.y, false), scale };
}

/** Zooms by a factor, keeping the content under `point` (in the view's own pixels) where it is. */
export function zoomAt(view: View, point: Point, factor: number, min: number, max: number): View {
	const scale = clamp(view.scale * factor, min, max);
	const k = scale / view.scale;
	return { scale, x: point.x - (point.x - view.x) * k, y: point.y - (point.y - view.y) * k };
}

/** Pans, as little as it takes, so a rectangle of the content is in sight. A rectangle larger than the view shows its start. */
export function reveal(view: View, rect: Rect, box: Size, margin = 24): View {
	const shift = (start: number, length: number, offset: number, room: number) => {
		const low = start * view.scale + offset;
		const high = (start + length) * view.scale + offset;
		if (low < margin) return margin - low;
		if (high > room - margin) return Math.max(room - margin - high, margin - low);
		return 0;
	};
	const dx = shift(rect.x, rect.width, view.x, box.width);
	const dy = shift(rect.y, rect.height, view.y, box.height);
	return dx || dy ? { ...view, x: view.x + dx, y: view.y + dy } : view;
}

/** The nearest box in a direction, for the arrow keys: one straight ahead beats a nearer one off to the side. */
export function nearest<T extends Rect>(boxes: readonly T[], here: T, dx: number, dy: number): T | undefined {
	const cx = (b: Rect) => b.x + b.width / 2;
	const cy = (b: Rect) => b.y + b.height / 2;
	let best: T | undefined;
	let score = Infinity;
	for (const b of boxes) {
		if (b === here) continue;
		const along = (cx(b) - cx(here)) * dx + (cy(b) - cy(here)) * dy;
		if (along <= 0) continue;
		const across = Math.abs((cx(b) - cx(here)) * dy) + Math.abs((cy(b) - cy(here)) * dx);
		if (along + across * 2 < score) (score = along + across * 2), (best = b);
	}
	return best;
}

// --- the width of text ---------------------------------------------------------

export type Measure = (text: string) => number;

const NARROW = new Set("iljtfrI.,:;'|!()[]{} ");
const WIDE = new Set("mwMW@%");

/**
 * A width for text when nothing can measure it: in a test, or before a view is
 * on screen. Proportions of a common sans-serif face, erring on the wide side,
 * so a box sized by it is not too small.
 */
export function estimateWidth(text: string, fontPx: number): number {
	let em = 0;
	for (const ch of text) em += NARROW.has(ch) ? 0.34 : WIDE.has(ch) ? 0.9 : /[A-Z0-9_]/.test(ch) ? 0.68 : 0.56;
	return em * fontPx;
}

/** Measures with a 2D canvas in the given CSS font, and estimates where there is none. */
export function canvasMeasure(font: string, fontPx: number): Measure {
	let context: CanvasRenderingContext2D | null | undefined;
	const seen = new Map<string, number>();
	return (text) => {
		const known = seen.get(text);
		if (known !== undefined) return known;
		if (context === undefined) {
			try {
				context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
				if (context) context.font = font;
			} catch {
				context = null;
			}
		}
		const width = context ? context.measureText(text).width : 0;
		if (!(width > 0)) return text ? estimateWidth(text, fontPx) : 0;
		seen.set(text, width);
		return width;
	};
}

// --- a choice a view remembers ----------------------------------------------------

const PREFIX = "ssl-studio.";

/** What was chosen last time, or null: nothing chosen yet, or the webview keeps no storage. */
export function recall(key: string): string | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage.getItem(PREFIX + key);
	} catch {
		return null;
	}
}

export function remember(key: string, value: string) {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(PREFIX + key, value);
	} catch {
		// Storage is full or forbidden: the choice lasts as long as the window.
	}
}

// --- lines as they are drawn ------------------------------------------------------

const at = (p: Point) => `${round(p.x)},${round(p.y)}`;
const round = (n: number) => Math.round(n * 10) / 10;

/**
 * A route of straight stretches drawn with its corners rounded, so the eye
 * follows it round a bend where a sharp corner reads as a crossing. A corner
 * is rounded by `radius`, or by half its shorter stretch where that is less.
 */
export function roundedPath(points: readonly Point[], radius = 8): string {
	if (points.length < 2) return "";
	let d = `M${at(points[0]!)}`;
	for (let i = 1; i < points.length - 1; i++) {
		const [before, corner, after] = [points[i - 1]!, points[i]!, points[i + 1]!];
		const into = Math.hypot(corner.x - before.x, corner.y - before.y);
		const out = Math.hypot(after.x - corner.x, after.y - corner.y);
		const r = Math.min(radius, into / 2, out / 2);
		if (!(r > 0.5)) {
			d += ` L${at(corner)}`;
			continue;
		}
		const start = { x: corner.x + ((before.x - corner.x) * r) / into, y: corner.y + ((before.y - corner.y) * r) / into };
		const end = { x: corner.x + ((after.x - corner.x) * r) / out, y: corner.y + ((after.y - corner.y) * r) / out };
		d += ` L${at(start)} Q${at(corner)} ${at(end)}`;
	}
	return `${d} L${at(points[points.length - 1]!)}`;
}

/**
 * A route ELK made as a spline: its start, then control points in threes
 * (two handles and the point they lead to), drawn as the curve it is. Points
 * that do not come in threes are joined straight.
 */
export function splinePath(points: readonly Point[]): string {
	if (points.length < 2) return "";
	let d = `M${at(points[0]!)}`;
	let i = 1;
	for (; i + 2 < points.length; i += 3) d += ` C${at(points[i]!)} ${at(points[i + 1]!)} ${at(points[i + 2]!)}`;
	for (; i < points.length; i++) d += ` L${at(points[i]!)}`;
	return d;
}

/** The point a given length along a spline (as `splinePath` draws it), from its start; its end when the spline is shorter. */
export function splinePoint(points: readonly Point[], length: number, steps = 12): Point {
	if (!points.length) return { x: 0, y: 0 };
	let here = points[0]!;
	let left = length;
	const walk = (to: Point): Point | null => {
		const step = Math.hypot(to.x - here.x, to.y - here.y);
		if (step >= left && step > 0) return { x: here.x + ((to.x - here.x) * left) / step, y: here.y + ((to.y - here.y) * left) / step };
		left -= step;
		here = to;
		return null;
	};
	let i = 1;
	for (; i + 2 < points.length; i += 3) {
		const [p0, p1, p2, p3] = [here, points[i]!, points[i + 1]!, points[i + 2]!];
		for (let k = 1; k <= steps; k++) {
			const t = k / steps;
			const u = 1 - t;
			const found = walk({
				x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
				y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
			});
			if (found) return found;
		}
	}
	for (; i < points.length; i++) {
		const found = walk(points[i]!);
		if (found) return found;
	}
	return here;
}

// --- the map of a picture larger than its view -------------------------------------

/** The part of the content a view shows, in the content's own units. */
export function seen(view: View, box: Size): Rect {
	return { x: -view.x / view.scale, y: -view.y / view.scale, width: box.width / view.scale, height: box.height / view.scale };
}

/** The view, at the scale it has, with a point of the content in its middle. */
export function centredOn(view: View, point: Point, box: Size): View {
	return { ...view, x: box.width / 2 - point.x * view.scale, y: box.height / 2 - point.y * view.scale };
}

/** Whether some of the content is out of sight: only then is a map of it worth its room. */
export function outOfSight(content: Size, view: View, box: Size, slack = 1): boolean {
	const part = seen(view, box);
	return part.x > slack || part.y > slack || part.x + part.width < content.width - slack || part.y + part.height < content.height - slack;
}

/** The scale at which the content fits a map of at most this size. */
export const mapScale = (content: Size, max: Size) => Math.min(max.width / (content.width || 1), max.height / (content.height || 1));

/** How much of a picture a view shows when it is fitted: 1 when all of it fits at full size, less as it must shrink. */
export function fitShare(content: Size, box: Size, margin = 20): number {
	if (!(content.width > 0) || !(content.height > 0)) return 1;
	return Math.max(0, Math.min(1, (box.width - 2 * margin) / content.width, (box.height - 2 * margin) / content.height));
}
