// Stamps `data-severity` ("error" | "warning" | "info" | "hint") onto Monaco's
// `.monaco-hover .hover-row` diagnostic rows so CSS can style errors, warnings,
// and info callouts with distinct color, iconography, and visual hierarchy above
// reference help hints.
import { monaco } from "./monaco";

export type HoverSeverity = "error" | "warning" | "info" | "hint";

export type MarkerLike = {
	message: string;
	severity: number;
	source?: string;
	code?: string | { value: string };
};

export function severityName(severity: number): HoverSeverity {
	if (severity >= 8) return "error";
	if (severity >= 4) return "warning";
	if (severity >= 2) return "info";
	return "hint";
}

function markerDetailLabel(marker: MarkerLike): string {
	const codeVal = typeof marker.code === "string" ? marker.code : marker.code?.value;
	if (marker.source && codeVal) return `${marker.source}(${codeVal})`;
	if (marker.source) return marker.source;
	if (codeVal) return `(${codeVal})`;
	return "";
}

/** Matches a rendered Monaco `.marker.hover-contents` row back to its model marker severity. */
export function matchMarkerSeverity(messageText: string, detailText: string, markers: readonly MarkerLike[]): HoverSeverity {
	const msg = messageText.trim();
	const detail = detailText.trim();
	if (!msg || !markers.length) return "warning";

	let bestExact = -1;
	let bestMsg = -1;
	for (const m of markers) {
		if (m.message.trim() !== msg) continue;
		if (m.severity > bestMsg) bestMsg = m.severity;
		if (detail && markerDetailLabel(m) === detail && m.severity > bestExact) {
			bestExact = m.severity;
		}
	}
	if (bestExact >= 0) return severityName(bestExact);
	if (bestMsg >= 0) return severityName(bestMsg);
	return "warning";
}

/**
 * Watches an editor's overflow widgets container for Monaco diagnostic hover rows
 * (`.marker.hover-contents`) and stamps `data-severity` onto their parent `.hover-row`
 * without mutating Monaco's internal spans. Reattaches across `setModel` because
 * `editor.getDomNode()` is null until the first model mounts a Monaco view.
 */
export function observeMarkerHoverSeverity(editor: monaco.editor.ICodeEditor): () => void {
	if (typeof MutationObserver === "undefined") return () => {};
	let observer: MutationObserver | null = null;
	let observedEl: Element | null = null;

	const stamp = () => {
		const model = editor.getModel();
		const root = editor.getDomNode();
		if (!model || !root) return;
		const markerNodes = root.querySelectorAll<HTMLElement>(".monaco-hover .marker.hover-contents");
		if (!markerNodes.length) return;
		const markers = monaco.editor.getModelMarkers({ resource: model.uri });
		for (const el of markerNodes) {
			const row = el.closest<HTMLElement>(".hover-row");
			if (!row) continue;
			const spans = el.querySelectorAll<HTMLElement>(":scope > span");
			const msg = spans[0]?.textContent ?? el.textContent ?? "";
			const detail = spans[1]?.textContent ?? "";
			const sev = matchMarkerSeverity(msg, detail, markers);
			if (row.dataset.severity !== sev) row.dataset.severity = sev;
		}
	};

	const attach = () => {
		const root = editor.getDomNode();
		const target = root?.querySelector(".overflowingContentWidgets") ?? root ?? null;
		if (target === observedEl) {
			stamp();
			return;
		}
		observer?.disconnect();
		observer = null;
		observedEl = target;
		if (!target) return;
		observer = new MutationObserver(stamp);
		observer.observe(target, { childList: true, subtree: true });
		stamp();
	};

	const sub = editor.onDidChangeModel(attach);
	attach();
	return () => {
		sub.dispose();
		observer?.disconnect();
		observer = null;
		observedEl = null;
	};
}
