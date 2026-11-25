// One of the app's small graphics: see icons.ts for which there are, and why they are not typed as text.
import { ICON, type IconName } from "./icons";

export type { IconName };

/** One of them, for the eye only: what it means is said by the label of whatever it is in. */
export function Icon(props: { name: IconName; class?: string }) {
	return (
		<span class={`codicon-glyph${props.class ? ` ${props.class}` : ""}`} aria-hidden="true">
			{ICON[props.name]}
		</span>
	);
}
