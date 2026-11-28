// Pure shared terminal types, resize guards, keyboard-yield rules, and
// 27-theme WCAG AA xterm.js palette synthesis (no DOM or Node imports).
import { contrast, luminance, TEXT } from "./contrast";

export type TerminalProfile = {
	id: string;
	label: string;
	shell: string;
	args?: string[];
	isDefault?: boolean;
};

export type TerminalInfo = {
	id: string;
	title: string;
	profileId: string;
	shell: string;
	cwd: string;
	pid?: number;
	pty: boolean;
	alive: boolean;
	exitCode?: number | null;
};

export type TerminalCreateRequest = {
	profileId?: string;
	cwd?: string;
	cols?: number;
	rows?: number;
	title?: string;
};

export type TerminalThemeInput = {
	panelBg: string;
	fg: string;
	strongFg: string;
	muted: string;
	accent: string;
	selected: string;
	error: string;
	warning: string;
	info: string;
	ok: string;
};

export type XtermPalette = {
	background: string;
	foreground: string;
	cursor: string;
	cursorAccent: string;
	selectionBackground: string;
	selectionInactiveBackground: string;
	black: string;
	red: string;
	green: string;
	yellow: string;
	blue: string;
	magenta: string;
	cyan: string;
	white: string;
	brightBlack: string;
	brightRed: string;
	brightGreen: string;
	brightYellow: string;
	brightBlue: string;
	brightMagenta: string;
	brightCyan: string;
	brightWhite: string;
};

/** Clamps terminal dimensions to safe integer ranges before sending PTY resize ioctls. */
export function clampTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
	const c = Number.isFinite(cols) ? Math.round(cols) : 80;
	const r = Number.isFinite(rows) ? Math.round(rows) : 24;
	return {
		cols: Math.max(20, Math.min(400, c)),
		rows: Math.max(4, Math.min(150, r)),
	};
}

/**
 * Commands allowed to intercept keystrokes while the integrated Terminal holds keyboard focus.
 * Every other shortcut (Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+R, Ctrl+W, Ctrl+A, Ctrl+E, Ctrl+K, Alt+B/F,
 * menu-bar Alt+F/E/V, etc.) flows directly to the running shell PTY, matching VS Code.
 */
const TERMINAL_ESCAPE_COMMANDS = new Set([
	"terminal",
	"terminal-new",
	"terminal-find",
	"toggle-panel",
	"toggle-panel-maximize",
	"command-palette",
	"zoom-in",
	"zoom-out",
	"zoom-reset",
]);

export function shouldTerminalAllowShellCommand(commandId: string | undefined): boolean {
	return Boolean(commandId && TERMINAL_ESCAPE_COMMANDS.has(commandId));
}

function parseHexRgb(hex: string): [number, number, number] | null {
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const raw = m[1]!;
	if (raw.length === 3) {
		return [
			parseInt(raw[0]! + raw[0]!, 16),
			parseInt(raw[1]! + raw[1]!, 16),
			parseInt(raw[2]! + raw[2]!, 16),
		];
	}
	return [
		parseInt(raw.slice(0, 2), 16),
		parseInt(raw.slice(2, 4), 16),
		parseInt(raw.slice(4, 6), 16),
	];
}

function toHex(r: number, g: number, b: number): string {
	const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
	return `#${byte(r)}${byte(g)}${byte(b)}`;
}

function blendHex(a: string, b: string, weightA: number): string {
	const ca = parseHexRgb(a);
	const cb = parseHexRgb(b);
	if (!ca || !cb) return a;
	const w = Math.max(0, Math.min(1, weightA));
	return toHex(
		ca[0] * w + cb[0] * (1 - w),
		ca[1] * w + cb[1] * (1 - w),
		ca[2] * w + cb[2] * (1 - w),
	);
}

/** Gently pushes `color` toward `target` until it clears `minContrast` against `bg`. */
function ensureContrast(color: string, bg: string, target: string, minContrast = TEXT): string {
	const cur = contrast(color, bg);
	if (Number.isNaN(cur) || cur >= minContrast) return color;
	for (let step = 1; step <= 20; step++) {
		const candidate = blendHex(target, color, step / 20);
		if (contrast(candidate, bg) >= minContrast) return candidate;
	}
	return target;
}

/**
 * Builds a complete 16-color xterm.js theme harmonized with SSL Studio's active theme tokens.
 * Ensures primary text and ANSI semantic colors maintain WCAG AA contrast (>= 4.5:1) against
 * `--panel-bg` in both dark and light themes across all 27 built-in themes.
 */
export function buildXtermTheme(tokens: TerminalThemeInput): XtermPalette {
	const bg = tokens.panelBg || "#1e1b18";
	const bgLum = luminance(bg);
	const isDark = Number.isNaN(bgLum) ? true : bgLum < 0.32;
	const liftTarget = isDark ? "#f6f4f0" : "#151311";

	const fg = ensureContrast(tokens.fg, bg, liftTarget, TEXT);
	const strong = ensureContrast(tokens.strongFg, bg, liftTarget, TEXT);
	const muted = ensureContrast(tokens.muted, bg, liftTarget, TEXT);

	const red = ensureContrast(tokens.error, bg, liftTarget, TEXT);
	const green = ensureContrast(tokens.ok, bg, liftTarget, TEXT);
	const yellow = ensureContrast(tokens.warning, bg, liftTarget, TEXT);
	const blue = ensureContrast(tokens.info, bg, liftTarget, TEXT);
	const magentaBase = isDark ? "#d09ce8" : "#7c3f9e";
	const cyanBase = isDark ? "#68c7c4" : "#0e6f73";
	const magenta = ensureContrast(magentaBase, bg, liftTarget, TEXT);
	const cyan = ensureContrast(cyanBase, bg, liftTarget, TEXT);

	const brightRed = ensureContrast(blendHex(red, liftTarget, 0.8), bg, liftTarget, TEXT);
	const brightGreen = ensureContrast(blendHex(green, liftTarget, 0.8), bg, liftTarget, TEXT);
	const brightYellow = ensureContrast(blendHex(yellow, liftTarget, 0.8), bg, liftTarget, TEXT);
	const brightBlue = ensureContrast(blendHex(blue, liftTarget, 0.8), bg, liftTarget, TEXT);
	const brightMagenta = ensureContrast(blendHex(magenta, liftTarget, 0.8), bg, liftTarget, TEXT);
	const brightCyan = ensureContrast(blendHex(cyan, liftTarget, 0.8), bg, liftTarget, TEXT);

	// ANSI black / brightBlack / white / brightWhite preserve terminal color semantics while
	// keeping secondary (brightBlack) comments/prompts readable on both dark and light surfaces.
	const black = isDark ? blendHex(bg, "#000000", 0.55) : strong;
	const brightBlack = muted;
	const white = isDark ? fg : blendHex(bg, "#ffffff", 0.65);
	const brightWhite = isDark ? strong : blendHex(bg, "#ffffff", 0.35);

	const cursor = ensureContrast(tokens.accent, bg, liftTarget, 3.0);
	const selectionBg = blendHex(tokens.selected, tokens.accent, 0.72);
	const selectionInactiveBg = blendHex(tokens.selected, bg, 0.65);

	return {
		background: bg,
		foreground: fg,
		cursor,
		cursorAccent: bg,
		selectionBackground: selectionBg,
		selectionInactiveBackground: selectionInactiveBg,
		black,
		red,
		green,
		yellow,
		blue,
		magenta,
		cyan,
		white,
		brightBlack,
		brightRed,
		brightGreen,
		brightYellow,
		brightBlue,
		brightMagenta,
		brightCyan,
		brightWhite,
	};
}

/** Strips common ANSI escape sequences so plain-text checks or accessibility announcements stay readable. */
export function shortShellName(shellPath: string): string {
	const cleaned = shellPath.replace(/\\/g, "/").replace(/\/+$/, "");
	const base = cleaned.slice(cleaned.lastIndexOf("/") + 1);
	return base.replace(/\.(exe|cmd|bat)$/i, "") || "shell";
}
