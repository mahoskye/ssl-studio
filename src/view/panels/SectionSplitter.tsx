// Reusable vertical splitter between stacked sections inside a side panel
// (Explorer Open Editors / Workspace / Outline, Palette preview, Reference detail).
// Pointer-draggable and keyboard-accessible (ArrowUp/ArrowDown, Home/double-click reset).
import { createSignal, onCleanup } from "solid-js";

export function SectionSplitter(props: {
	label: string;
	value: number;
	min: number;
	max: number;
	onDrag: (deltaY: number) => void;
	onReset: () => void;
}) {
	const [dragging, setDragging] = createSignal(false);
	let cleanupDrag: (() => void) | null = null;
	onCleanup(() => cleanupDrag?.());
	return (
		<div
			class="section-splitter"
			classList={{ dragging: dragging() }}
			role="separator"
			tabindex={0}
			aria-orientation="horizontal"
			aria-label={props.label}
			aria-valuenow={Math.round(props.value)}
			aria-valuemin={props.min}
			aria-valuemax={props.max}
			title={`${props.label}: drag, or use Up/Down arrows. Double-click or Home to reset.`}
			onDblClick={props.onReset}
			onKeyDown={(e) => {
				const step = e.shiftKey ? 64 : 16;
				if (e.key === "ArrowUp") (e.preventDefault(), props.onDrag(-step));
				else if (e.key === "ArrowDown") (e.preventDefault(), props.onDrag(step));
				else if (e.key === "Home") (e.preventDefault(), props.onReset());
			}}
			onMouseDown={(start) => {
				if (start.button !== 0) return;
				start.preventDefault();
				cleanupDrag?.();
				let last = start.clientY;
				const prevCursor = document.body.style.cursor;
				const prevSelect = document.body.style.userSelect;
				document.body.style.cursor = "row-resize";
				document.body.style.userSelect = "none";
				setDragging(true);
				const move = (e: MouseEvent) => {
					props.onDrag(e.clientY - last);
					last = e.clientY;
				};
				const finish = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", finish);
					window.removeEventListener("blur", finish);
					document.body.style.cursor = prevCursor;
					document.body.style.userSelect = prevSelect;
					setDragging(false);
					cleanupDrag = null;
				};
				cleanupDrag = finish;
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", finish);
				window.addEventListener("blur", finish);
			}}
		/>
	);
}
