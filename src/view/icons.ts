// The app's small graphics (drawn by Icon.tsx): every one a Codicon, from the font the text editor
// already ships. A symbol typed as text ("●", "＋", "⟳") is drawn by whichever
// font the system happens to find it in, and no two systems find the same: a
// dot comes out as an oval, a plus twice as wide as its button. These are one
// family, drawn the same everywhere.

/** The Codicons used, by the names the family gives them. */
export const ICON = {
	add: "",
	"arrow-down": "",
	"arrow-left": "",
	"arrow-up": "",
	check: "",
	"chevron-down": "",
	"chevron-left": "",
	"chevron-right": "",
	"circle-outline": "",
	"circle-small": "",
	"circle-small-filled": "",
	close: "",
	dash: "",
	discard: "",
	ellipsis: "",
	error: "",
	eye: "",
	gear: "",
	"go-to-file": "",
	info: "",
	layout: "",
	"layout-panel": "",
	"layout-panel-off": "",
	"layout-sidebar-left": "",
	"layout-sidebar-left-off": "",
	"layout-sidebar-right": "",
	"layout-sidebar-right-off": "",
	"pass-filled": "",
	refresh: "",
	remove: "",
	"symbol-class": "",
	"symbol-constant": "",
	"symbol-key": "",
	"symbol-method": "",
	"symbol-namespace": "",
	"symbol-string": "",
	"symbol-structure": "",
	"symbol-variable": "",
	sync: "",
	trash: "",
	warning: "",
} as const;

export type IconName = keyof typeof ICON;
