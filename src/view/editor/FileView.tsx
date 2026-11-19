// A file that is not text, in the place where the editor would be: a picture
// is shown, with its size; other bytes say what they are and how large. There
// is nothing here to type into, so nothing here can damage the file.
import { createResource, createSignal, Show } from "solid-js";
import { sizeText } from "../../shared/fileKind";
import { baseName } from "../../shared/paths";
import { backend } from "../backend";
import { documents } from "../state";

export function FileView(props: { path: string }) {
	const file = () => documents.get(props.path)?.binary;
	const name = () => baseName(props.path);
	const [picture] = createResource(
		() => (file()?.image ? props.path : false),
		(path) => backend.image(path),
	);
	/** The picture's own size in pixels, known once it is drawn. */
	const [pixels, setPixels] = createSignal("");
	const facts = () => [name(), pixels(), sizeText(file()?.size ?? 0)].filter(Boolean).join(" · ");
	return (
		<div class="file-view" tabindex={0} role="group" aria-label={`${name()}, ${file()?.image ? "a picture" : "not text"}`}>
			<Show
				when={file()?.image}
				fallback={
					<div class="file-note">
						<p class="file-what">{name()} is not text.</p>
						<p>It holds {sizeText(file()?.size ?? 0)} that do not read as text, so it is not shown here, and nothing here changes it. Open it with the program it belongs to.</p>
					</div>
				}
			>
				<Show when={!picture.error} fallback={<p class="file-note warn">{name()} could not be shown: {String((picture.error as Error)?.message ?? picture.error)}</p>}>
					<Show when={picture()} fallback={<p class="hint">Reading the picture…</p>}>
						{(read) => (
							<div class="file-picture">
								<img src={`data:${read().type};base64,${read().base64}`} alt={name()} onLoad={(e) => setPixels(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight} pixels`)} onError={() => setPixels("it could not be drawn")} />
							</div>
						)}
					</Show>
				</Show>
				<p class="file-facts">{facts()}</p>
			</Show>
		</div>
	);
}
