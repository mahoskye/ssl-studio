// A file that is not text, in the place where the editor would be: a picture
// is shown with zoom and copy/open actions; other bytes say what they are,
// how large, and offer OS open/reveal/copy controls. There is nothing here to
// type into, so nothing here can damage the file.
import { createEffect, createResource, createSignal, on, Show } from "solid-js";
import { sizeText } from "../../shared/fileKind";
import { baseName, relativeTo } from "../../shared/paths";
import { backend } from "../backend";
import { Icon } from "../Icon";
import { documents, notify, state } from "../state";

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

export function FileView(props: { path: string }) {
	const file = () => documents.get(props.path)?.binary;
	const name = () => baseName(props.path);
	const [picture] = createResource(
		() => (file()?.image ? props.path : false),
		(path) => backend.image(path),
	);
	/** The picture's own size in pixels, known once it is drawn. */
	const [pixels, setPixels] = createSignal("");
	const [natural, setNatural] = createSignal<{ w: number; h: number } | null>(null);
	/** Null means "Fit" inside the viewport; a number is an explicit scale factor. */
	const [zoom, setZoom] = createSignal<number | null>(null);

	createEffect(
		on(
			() => props.path,
			() => {
				setZoom(null);
				setPixels("");
				setNatural(null);
			},
		),
	);

	const stepZoom = (dir: -1 | 1) => {
		const cur = zoom() ?? 1;
		if (dir > 0) {
			const next = ZOOM_STEPS.find((z) => z > cur + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
			setZoom(next);
		} else {
			const next = [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001) ?? ZOOM_STEPS[0]!;
			setZoom(next);
		}
	};

	const openExternally = () => {
		void backend.openExternal(props.path).catch((e: any) => notify(`Could not open externally: ${e?.message ?? e}`, "error"));
	};
	const revealInFolder = () => {
		void backend.revealInFileManager(props.path).catch((e: any) => notify(`Could not reveal in folder: ${e?.message ?? e}`, "error"));
	};
	const copyFilePath = () => {
		void import("../commands").then((m) => m.copyText(props.path, "Copied file path."));
	};
	const copyMarkdownEmbed = () => {
		const root = state.workspace?.root;
		const rel = root ? relativeTo(root, props.path).replace(/\\/g, "/") : name();
		const encoded = rel
			.split("/")
			.map((seg) => encodeURIComponent(seg))
			.join("/");
		const alt = name().replace(/\.[^.]+$/, "");
		const embed = `![${alt}](/${encoded})`;
		void import("../commands").then((m) => m.copyText(embed, `Copied Markdown embed: ${embed}`));
	};

	const facts = () => [name(), pixels(), sizeText(file()?.size ?? 0)].filter(Boolean).join(" · ");
	const imgStyle = () => {
		const z = zoom();
		const nat = natural();
		if (z === null || !nat) return undefined;
		return {
			width: `${Math.max(16, Math.round(nat.w * z))}px`,
			"max-width": "none",
			"max-height": "none",
		};
	};

	return (
		<div class="file-view" tabindex={0} role="group" aria-label={`${name()}, ${file()?.image ? "a picture" : "not text"}`}>
			<Show
				when={file()?.image}
				fallback={
					<div class="file-note">
						<p class="file-what">{name()} is not text.</p>
						<p>It holds {sizeText(file()?.size ?? 0)} that do not read as text, so it is not shown here, and nothing here changes it. Open it with the program it belongs to.</p>
						<div class="file-actions" role="group" aria-label="File actions">
							<button type="button" class="primary" title="Open with your system's default application" onClick={openExternally}>
								<Icon name="go-to-file" /> Open externally
							</button>
							<button type="button" title="Reveal this file in your system's file manager" onClick={revealInFolder}>
								<Icon name="folder" /> Reveal in folder
							</button>
							<button type="button" title="Copy the full path to the clipboard" onClick={copyFilePath}>
								<Icon name="copy" /> Copy path
							</button>
						</div>
					</div>
				}
			>
				<div class="file-toolbar" role="toolbar" aria-label="Image controls">
					<div class="file-toolbar-group" role="group" aria-label="Zoom">
						<button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => stepZoom(-1)}>
							<Icon name="zoom-out" />
						</button>
						<button
							type="button"
							classList={{ active: zoom() === null }}
							title="Fit image to window"
							onClick={() => setZoom(null)}
						>
							{zoom() === null ? "Fit" : `${Math.round(zoom()! * 100)}%`}
						</button>
						<button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => stepZoom(1)}>
							<Icon name="zoom-in" />
						</button>
					</div>
					<span class="file-toolbar-sep" aria-hidden="true" />
					<button type="button" title="Open image with your system's default application" onClick={openExternally}>
						<Icon name="go-to-file" /> Open externally
					</button>
					<button type="button" title="Reveal image in your system's file manager" onClick={revealInFolder}>
						<Icon name="folder" /> Reveal in folder
					</button>
					<button type="button" title="Copy the full path to the clipboard" onClick={copyFilePath}>
						<Icon name="copy" /> Copy path
					</button>
					<button type="button" title="Copy Markdown image embed (![name](/path))" onClick={copyMarkdownEmbed}>
						<Icon name="file-media" /> Copy Markdown embed
					</button>
				</div>
				<Show when={!picture.error} fallback={<p class="file-note warn">{name()} could not be shown: {String((picture.error as Error)?.message ?? picture.error)}</p>}>
					<Show when={picture()} fallback={<p class="hint">Reading the picture…</p>}>
						{(read) => (
							<div class="file-picture" classList={{ zoomed: zoom() !== null }}>
								<img
									src={`data:${read().type};base64,${read().base64}`}
									alt={name()}
									style={imgStyle()}
									onLoad={(e) => {
										const img = e.currentTarget;
										setNatural({ w: img.naturalWidth, h: img.naturalHeight });
										setPixels(`${img.naturalWidth} × ${img.naturalHeight} pixels`);
									}}
									onError={() => setPixels("it could not be drawn")}
								/>
							</div>
						)}
					</Show>
				</Show>
				<p class="file-facts">{facts()}</p>
			</Show>
		</div>
	);
}
