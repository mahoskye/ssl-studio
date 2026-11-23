// Pure context-menu data structures, normalization, and viewport placement.
// Shared by RowMenu.tsx and tested directly without a DOM.

export type RowMenuAction = {
	label: string;
	value?: string;
	keys?: string;
	danger?: boolean;
	disabled?: boolean;
	checked?: boolean;
};

export type RowMenuSubmenu = {
	label: string;
	children: RowMenuEntry[];
	danger?: boolean;
};

export type RowMenuEntry = string | "separator" | RowMenuAction | RowMenuSubmenu;

export type ResolvedMenuLeaf = {
	kind: "item";
	label: string;
	value: string;
	keys?: string;
	danger?: boolean;
	disabled?: boolean;
	checked?: boolean;
};

export type ResolvedMenuSub = {
	kind: "submenu";
	label: string;
	children: ResolvedMenuEntry[];
	danger?: boolean;
};

export type ResolvedMenuEntry = "separator" | ResolvedMenuLeaf | ResolvedMenuSub;

export type RectBox = { left: number; right: number; top: number; bottom: number };
export type SizeBox = { width: number; height: number };

export function isSubmenuEntry(entry: RowMenuEntry): entry is RowMenuSubmenu {
	return typeof entry === "object" && entry !== null && "children" in entry && Array.isArray(entry.children);
}

/** True when a resolved entry list has at least one actionable leaf item (directly or in a submenu). */
function hasActionable(entries: readonly ResolvedMenuEntry[]): boolean {
	return entries.some((e) => e !== "separator" && (e.kind === "item" || hasActionable(e.children)));
}

/**
 * Normalizes a menu entry tree:
 * - resolves string entries into leaf items
 * - recursively normalizes submenus and drops empty submenus
 * - removes leading, trailing, and duplicate adjacent separators
 */
export function normalizeMenuEntries(items: readonly RowMenuEntry[]): ResolvedMenuEntry[] {
	const raw: ResolvedMenuEntry[] = [];
	for (const entry of items) {
		if (entry === "separator") {
			raw.push("separator");
		} else if (typeof entry === "string") {
			raw.push({ kind: "item", label: entry, value: entry });
		} else if (isSubmenuEntry(entry)) {
			const children = normalizeMenuEntries(entry.children);
			if (hasActionable(children)) {
				raw.push({ kind: "submenu", label: entry.label, children, danger: entry.danger });
			}
		} else {
			raw.push({
				kind: "item",
				label: entry.label,
				value: entry.value ?? entry.label,
				keys: entry.keys,
				danger: entry.danger,
				disabled: entry.disabled,
				checked: entry.checked,
			});
		}
	}

	const cleaned: ResolvedMenuEntry[] = [];
	for (const entry of raw) {
		if (entry === "separator") {
			if (cleaned.length === 0 || cleaned[cleaned.length - 1] === "separator") continue;
		}
		cleaned.push(entry);
	}
	while (cleaned.length > 0 && cleaned[cleaned.length - 1] === "separator") cleaned.pop();
	return cleaned;
}

/**
 * Helper for conditional submenus: when `children` has only 1 actionable item,
 * returns that single item inline (avoiding single-item submenus); when 2+,
 * returns a submenu entry; when 0, returns an empty array.
 */
export function submenuOrInline(label: string, children: readonly RowMenuEntry[]): RowMenuEntry[] {
	const normalized = normalizeMenuEntries(children);
	const nonSep = normalized.filter((e) => e !== "separator");
	if (nonSep.length === 0) return [];
	if (nonSep.length === 1) {
		const only = nonSep[0]!;
		if (only.kind === "item") {
			return [{ label: only.label, value: only.value, keys: only.keys, danger: only.danger, disabled: only.disabled, checked: only.checked }];
		}
		return [{ label: only.label, children: children.slice(), danger: only.danger }];
	}
	return [{ label, children: children.slice() }];
}

/** Flattens every leaf item's value in display order (including inside submenus). */
export function menuItemValues(entries: readonly RowMenuEntry[]): string[] {
	const out: string[] = [];
	for (const entry of normalizeMenuEntries(entries)) {
		if (entry === "separator") continue;
		if (entry.kind === "item") out.push(entry.value);
		else out.push(...menuItemValues(entry.children));
	}
	return out;
}

/** Places a root menu panel inside the viewport with breathing room on every edge. */
export function placeMenu(
	at: { x: number; y: number },
	size: SizeBox,
	viewport: SizeBox,
	margin = 8,
): { left: number; top: number; maxHeight: number } {
	const maxHeight = Math.max(120, viewport.height - margin * 2);
	const clampedH = Math.min(size.height, maxHeight);
	const left = Math.max(margin, Math.min(at.x, viewport.width - size.width - margin));
	const top = Math.max(margin, Math.min(at.y, viewport.height - clampedH - margin));
	return { left, top, maxHeight };
}

/**
 * Places a submenu panel beside its parent trigger row: opens to the right when
 * there is room, flips left near the right viewport edge, and clamps vertically
 * inside the viewport.
 */
export function placeSubmenu(
	parentRect: RectBox,
	size: SizeBox,
	viewport: SizeBox,
	overlap = 4,
	margin = 8,
	padTop = 5,
): { left: number; top: number; side: "right" | "left"; maxHeight: number } {
	const maxHeight = Math.max(120, viewport.height - margin * 2);
	const clampedH = Math.min(size.height, maxHeight);
	const rightCandidate = parentRect.right - overlap;
	const leftCandidate = parentRect.left + overlap - size.width;
	const fitsRight = rightCandidate + size.width <= viewport.width - margin;
	const fitsLeft = leftCandidate >= margin;

	let side: "right" | "left";
	let left: number;
	if (fitsRight) {
		side = "right";
		left = rightCandidate;
	} else if (fitsLeft) {
		side = "left";
		left = leftCandidate;
	} else {
		const spaceRight = viewport.width - parentRect.right;
		const spaceLeft = parentRect.left;
		side = spaceRight >= spaceLeft ? "right" : "left";
		left = Math.max(margin, Math.min(side === "right" ? rightCandidate : leftCandidate, viewport.width - size.width - margin));
	}

	const top = Math.max(margin, Math.min(parentRect.top - padTop, viewport.height - clampedH - margin));
	return { left, top, side, maxHeight };
}

/**
 * Places a button-anchored dropdown menu inside the viewport. Opens downward
 * when room permits; otherwise flips cleanly upward above the trigger button
 * (e.g., Agent's Prompts button near the bottom edge) and clamps horizontally.
 */
export function placeAnchoredMenu(
	anchor: RectBox,
	size: SizeBox,
	viewport: SizeBox,
	margin = 8,
	gap = 4,
): { left: number; top: number; maxHeight: number; direction: "down" | "up" } {
	const spaceBelow = Math.max(0, viewport.height - anchor.bottom - margin - gap);
	const spaceAbove = Math.max(0, anchor.top - margin - gap);

	let direction: "down" | "up";
	let maxHeight: number;
	let top: number;
	if (size.height <= spaceBelow) {
		direction = "down";
		maxHeight = Math.max(120, spaceBelow);
		top = anchor.bottom + gap;
	} else if (spaceAbove >= size.height || spaceAbove > spaceBelow) {
		direction = "up";
		maxHeight = Math.max(120, spaceAbove);
		const usedH = Math.min(size.height, maxHeight);
		top = Math.max(margin, anchor.top - usedH - gap);
	} else {
		direction = "down";
		maxHeight = Math.max(100, spaceBelow);
		top = Math.max(margin, Math.min(anchor.bottom + gap, viewport.height - Math.min(size.height, maxHeight) - margin));
	}

	const maxW = Math.max(160, viewport.width - margin * 2);
	const usedW = Math.min(size.width, maxW);
	// Prefer aligning right edge with trigger right edge when it fits (standard for right-aligned toolbar buttons),
	// else align left edge with trigger left edge, always clamped inside viewport.
	let left: number;
	if (anchor.right - usedW >= margin && anchor.right <= viewport.width - margin) {
		left = anchor.right - usedW;
	} else if (anchor.left + usedW <= viewport.width - margin) {
		left = Math.max(margin, anchor.left);
	} else {
		left = Math.max(margin, Math.min(anchor.left, viewport.width - usedW - margin));
	}

	return { left, top, maxHeight, direction };
}

/**
 * True when a `choose()` request represents a multi-item selection list rather
 * than a compact binary/ternary confirmation (ADR 0032 — VS Code QuickPick).
 */
export function shouldUseQuickPick(buttons: readonly string[], details?: Record<string, string>): boolean {
	if (buttons.length > 3) return true;
	if (details && Object.keys(details).length > 0 && buttons.length >= 2) return true;
	return buttons.some((b) => b.length > 34);
}
