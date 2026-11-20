// A map of a picture that is larger than its view: the call graph and a plan's
// chart share it. It shows the whole picture small, with the part in view
// outlined; a click or a drag on it moves the view there. It is a pointer's
// convenience and is hidden from a screen reader: the arrow keys already move
// through the picture node by node.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { centredOn, mapScaleIn, outOfSight, seen, type Rect, type Size, type View } from "./canvas";

// How large the map is and where it sits is canvas.ts's (mapScaleIn, mapArea): what moves the view clear of it reads the same.

export type MapBox = Rect & { /** What it is, for its shade: a frame around others, or a node. */ kind: "frame" | "node" | "mark" };

export function Minimap(props: { content: Size; boxes: readonly MapBox[]; view: View; /** The element the picture is drawn in: its size is the view's. */ host: () => Element | undefined; onMove: (view: View) => void }) {
	const [box, setBox] = createSignal<Size>({ width: 0, height: 0 });
	onMount(() => {
		const host = props.host();
		if (!host) return;
		const measure = () => {
			const rect = host.getBoundingClientRect();
			setBox({ width: rect.width, height: rect.height });
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(host);
		onCleanup(() => observer.disconnect());
	});
	const k = () => mapScaleIn(props.content, box());
	const part = () => seen(props.view, box());
	let dragging = false;
	const moveTo = (e: MouseEvent & { currentTarget: SVGSVGElement }) => {
		const rect = e.currentTarget.getBoundingClientRect();
		props.onMove(centredOn(props.view, { x: (e.clientX - rect.left) / k(), y: (e.clientY - rect.top) / k() }, box()));
	};
	return (
		<Show when={box().width > 0 && props.content.width > 0 && outOfSight(props.content, props.view, box())}>
			<svg
				class="picture-map"
				aria-hidden="true"
				width={Math.ceil(props.content.width * k())}
				height={Math.ceil(props.content.height * k())}
				viewBox={`0 0 ${props.content.width} ${props.content.height}`}
				onMouseDown={(e) => {
					e.stopPropagation();
					dragging = true;
					moveTo(e);
				}}
				onMouseMove={(e) => dragging && moveTo(e)}
				onMouseUp={() => (dragging = false)}
				onMouseLeave={() => (dragging = false)}
				onClick={(e) => e.stopPropagation()}
				onWheel={(e) => e.stopPropagation()}
			>
				<title>The whole picture. The outline is the part in view: click or drag to move it.</title>
				<For each={props.boxes}>{(b) => <rect class={`mm-${b.kind}`} x={b.x} y={b.y} width={b.width} height={b.height} rx={2 / k()} />}</For>
				<rect class="mm-view" x={part().x} y={part().y} width={part().width} height={part().height} rx={3 / k()} stroke-width={1.5 / k()} />
			</svg>
		</Show>
	);
}
