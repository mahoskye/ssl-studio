// Reusable vertical splitter between stacked sections inside a side panel
// (Explorer Open Editors / Workspace / Outline, Palette preview, Reference detail).
// Pointer-draggable and keyboard-accessible (ArrowUp/ArrowDown, Home/double-click reset).
export function SectionSplitter(props: {
	label: string;
	value: number;
	min: number;
	max: number;
	onDrag: (deltaY: number) => void;
	onReset: () => void;
}) {
	return (
		<div
			class="section-splitter"
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
				start.preventDefault();
				let last = start.clientY;
				const move = (e: MouseEvent) => {
					props.onDrag(e.clientY - last);
					last = e.clientY;
				};
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			}}
		/>
	);
}
