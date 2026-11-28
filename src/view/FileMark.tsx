// A file's mark, drawn: one glyph of the icon font in its kind's colour. It is
// decoration beside the name, so a screen reader passes it over.
import type { DocFile } from "../shared/protocol";
import { docIcon, fileIcon } from "./fileIcon";

export function FileMark(props: { name: string; folder?: { open: boolean } }) {
	const icon = () => fileIcon(props.name, props.folder);
	return (
		<span class={`file-mark fm-${icon().kind}`} aria-hidden="true" title={icon().what}>
			{icon().glyph}
		</span>
	);
}

/** A document's mark in the Docs panel: what it is (a ticket, a spec, a catalog), not only that it is Markdown. */
export function DocMark(props: { file: Pick<DocFile, "name" | "group"> & Partial<Pick<DocFile, "kind" | "catalog">> }) {
	const icon = () => docIcon(props.file);
	return (
		<span class={`file-mark fm-${icon().kind}`} aria-hidden="true" title={icon().what}>
			{icon().glyph}
		</span>
	);
}
