// Configurable font stacks (ADR 0027, docs/UI-DESIGN.md Section 7).
// Defaults strictly to system-ui and ui-monospace; users may pick a curated
// house candidate or any locally installed font family in Settings.

export const DEFAULT_UI_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
export const DEFAULT_CODE_FONT = 'ui-monospace, "Cascadia Code", Menlo, Consolas, monospace';

export type FontPreset = { id: string; label: string };

export const UI_FONT_PRESETS: readonly FontPreset[] = [
	{ id: "", label: "System default" },
	{ id: "IBM Plex Sans", label: "IBM Plex Sans" },
	{ id: "Inter", label: "Inter" },
];

export const CODE_FONT_PRESETS: readonly FontPreset[] = [
	{ id: "", label: "System default" },
	{ id: "JetBrains Mono", label: "JetBrains Mono" },
	{ id: "IBM Plex Mono", label: "IBM Plex Mono" },
	{ id: "Cascadia Code", label: "Cascadia Code" },
];

export const READ_FONT_PRESETS: readonly FontPreset[] = [
	{ id: "", label: "Match interface font" },
	{ id: "Source Serif 4", label: "Source Serif 4" },
	{ id: "Newsreader", label: "Newsreader" },
];

const CSS_WIDE_KEYWORDS = /^(inherit|initial|unset|revert|revert-layer|default)$/i;
const CSS_GENERIC_FAMILIES = /^(system-ui|-apple-system|sans-serif|serif|monospace|ui-sans-serif|ui-serif|ui-monospace|cursive|fantasy|emoji|math|fangsong)$/i;
const UNSAFE_FONT_CHARS = /[\x00-\x1f\x7f\\;{}()<>:]/g;

/** Normalizes a user-chosen font name or stack and appends the safe fallback stack. */
export function resolveFontStack(configured: string | undefined, fallback: string): string {
	const raw = (configured ?? "").replace(UNSAFE_FONT_CHARS, "").trim();
	if (!raw) return fallback;
	const parts: string[] = [];
	for (const segment of raw.split(",")) {
		let name = segment.trim();
		if (name.length >= 2 && ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'")))) {
			name = name.slice(1, -1).trim();
		}
		name = name.replace(/["']/g, "").replace(/\s+/g, " ").trim();
		if (!name || CSS_WIDE_KEYWORDS.test(name)) continue;
		if (CSS_GENERIC_FAMILIES.test(name)) {
			parts.push(name.toLowerCase());
		} else {
			parts.push(`"${name}"`);
		}
	}
	return parts.length ? `${parts.join(", ")}, ${fallback}` : fallback;
}
