// The main window's first frame: 1400 by 900 near the top left, made to fit
// the screen's work area (without the taskbar or dock) on smaller screens.

export type Rect = { x: number; y: number; width: number; height: number };

const WANTED = { width: 1400, height: 900, x: 80, y: 60 };

export function fitWindow(workArea: Rect): Rect {
	// An unknown screen reports an empty work area: keep the wanted frame.
	if (workArea.width <= 0 || workArea.height <= 0) return { ...WANTED };
	const width = Math.min(WANTED.width, workArea.width);
	const height = Math.min(WANTED.height, workArea.height);
	return {
		width,
		height,
		x: workArea.x + Math.min(WANTED.x, workArea.width - width),
		y: workArea.y + Math.min(WANTED.y, workArea.height - height),
	};
}
