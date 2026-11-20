// What a key press is called, which presses may be shortcuts, and how a
// shortcut is moved from one command to another. No DOM and no app state:
// the keymap in commands.ts and the recorder in Settings.tsx both use it.

/** The fields of a KeyboardEvent this needs; a plain object does for a test. */
export type KeyPress = {
	key: string;
	code?: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	getModifierState?: (key: string) => boolean;
};

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "CapsLock", "NumLock", "ScrollLock", "Fn", "Dead", "Process", "Unidentified"]);
/** A key that is only ever held with another: on its own it is not a shortcut. */
export const isModifierKey = (key: string) => MODIFIER_KEYS.has(key);

const modifiers = (e: KeyPress) => `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${e.altKey ? "alt+" : ""}${e.shiftKey ? "shift+" : ""}`;

/**
 * The names a press goes by ("ctrl+shift+p"), the preferred one first.
 * A digit key is named by its digit, whatever Shift or the layout makes of
 * it: Ctrl+Shift+0 is "ctrl+shift+0", not "ctrl+shift+)". Not under AltGr,
 * where the key is typing a character.
 */
export function keyNames(e: KeyPress): string[] {
	const raw = modifiers(e) + (e.key === " " ? "space" : e.key.toLowerCase());
	const digit = /^Digit(\d)$/.exec(e.code ?? "")?.[1];
	const typing = e.getModifierState?.("AltGraph") || (e.ctrlKey && e.altKey);
	return digit && e.key !== digit && !typing ? [modifiers(e) + digit, raw] : [raw];
}

type Parsed = { ctrl: boolean; alt: boolean; shift: boolean; key: string };
function parse(name: string): Parsed {
	const out: Parsed = { ctrl: false, alt: false, shift: false, key: name };
	for (const mod of ["ctrl", "alt", "shift"] as const) {
		if (out.key.startsWith(mod + "+") && out.key.length > mod.length + 1) {
			out[mod] = true;
			out.key = out.key.slice(mod.length + 1);
		}
	}
	return out;
}

const KEY_LABELS: Record<string, string> = { pagedown: "PageDown", pageup: "PageUp", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", escape: "Esc", space: "Space" };

/** "ctrl+shift+p" as it is shown: "Ctrl+Shift+P". */
export function displayKey(name: string): string {
	const p = parse(name);
	const key = KEY_LABELS[p.key] ?? p.key.charAt(0).toUpperCase() + p.key.slice(1);
	return `${p.ctrl ? "Ctrl+" : ""}${p.alt ? "Alt+" : ""}${p.shift ? "Shift+" : ""}${key}`;
}

/** The keys text is edited with: a shortcut on one of them would take it away everywhere. */
const EDITING_KEYS = new Set(["ctrl+c", "ctrl+x", "ctrl+v", "ctrl+z", "ctrl+shift+z", "ctrl+y", "ctrl+a"]);

/**
 * Whether a key may be a shortcut. It needs Ctrl or Alt, or to be a function
 * key: a bare or shifted key would swallow that letter wherever it is typed.
 */
export function bindable(name: string): { ok: true } | { ok: false; why: string } {
	const p = parse(name.toLowerCase());
	if (/^f([1-9]|1\d|2[0-4])$/.test(p.key)) return { ok: true };
	if (!p.ctrl && !p.alt) return { ok: false, why: `${displayKey(name)} cannot be a shortcut: it needs Ctrl or Alt, or a function key.` };
	if (EDITING_KEYS.has(name.toLowerCase())) return { ok: false, why: `${displayKey(name)} cannot be a shortcut: text is edited with it.` };
	return { ok: true };
}

/** The defaults with the user's overrides applied; an override of "" unbinds a default. */
export function effectiveKeys(defaults: Record<string, string>, overrides: Record<string, string> = {}): Record<string, string> {
	const map: Record<string, string> = { ...defaults };
	for (const [key, id] of Object.entries(overrides)) {
		if (id) map[key.toLowerCase()] = id;
		else delete map[key.toLowerCase()];
	}
	return map;
}

/** Every key that runs a command, in the keymap's order. */
export const keysOf = (id: string, map: Record<string, string>): string[] =>
	Object.entries(map)
		.filter(([, command]) => command === id)
		.map(([key]) => key);

/** The command a key runs now, other than `id` itself: what a rebind would take the key from. */
export function conflict(key: string, id: string, map: Record<string, string>): string | undefined {
	const owner = map[key.toLowerCase()];
	return owner && owner !== id ? owner : undefined;
}

function normalized(overrides: Record<string, string>) {
	return Object.fromEntries(Object.entries(overrides).map(([key, id]) => [key.toLowerCase(), id]));
}

function release(next: Record<string, string>, defaults: Record<string, string>, key: string) {
	if (defaults[key]) next[key] = "";
	else delete next[key];
}

/** New overrides in which `id` has no shortcut at all. */
export function unbind(defaults: Record<string, string>, overrides: Record<string, string>, id: string): Record<string, string> {
	const next = normalized(overrides);
	for (const key of keysOf(id, effectiveKeys(defaults, next))) release(next, defaults, key);
	return next;
}

/**
 * New overrides in which `key` runs `id` and nothing else does: the
 * command's old keys are let go, and the key is taken from whatever had it.
 */
export function rebind(defaults: Record<string, string>, overrides: Record<string, string>, id: string, key: string): Record<string, string> {
	key = key.toLowerCase();
	const next = unbind(defaults, overrides, id);
	if (defaults[key] === id) delete next[key];
	else next[key] = id;
	return next;
}
