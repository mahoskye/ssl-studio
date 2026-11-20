// A file's mark, drawn: one glyph of the icon font in its kind's colour. It is
// decoration beside the name, so a screen reader passes it over.
import { fileIcon } from "./fileIcon";

export function FileMark(props: { name: string; folder?: { open: boolean } }) {
	const icon = () => fileIcon(props.name, props.folder);
	return (
		<span class={`file-mark fm-${icon().kind}`} aria-hidden="true" title={icon().what}>
			{icon().glyph}
		</span>
	);
}
