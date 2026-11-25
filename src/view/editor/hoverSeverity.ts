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
	startLineNumber?: number;
	endLineNumber?: number;
};

export function severityName(severity: number): HoverSeverity {
	if (severity >= 8) return "error";
	if (severity >= 4) return "warning";
	if (severity >= 2) return "info";
	return "hint";
}

const normalizeSpace = (s: string) => s.replace(/\s+/g, " ").trim();

const readText = (node: { innerText?: string; textContent?: string | null } | null | undefined): string =>
	node?.innerText || node?.textContent || "";

function markerDetailLabels(marker: MarkerLike): string[] {
	const codeVal = typeof marker.code === "string" ? marker.code : marker.code?.value;
	const src = marker.source ? normalizeSpace(marker.source) : "";
	const code = codeVal ? normalizeSpace(codeVal) : "";
	if (src && code) return [`${src}(${code})`, `${src}${code}`, `${src} (${code})`, `${src} ${code}`];
	if (src) return [src];
	if (code) return [`(${code})`, code];
	return [];
}

function matchIn(msg: string, detail: string, markers: readonly MarkerLike[]): HoverSeverity | null {
	let bestExact = -1;
	let bestMsg = -1;
	for (const m of markers) {
		if (normalizeSpace(m.message) !== msg) continue;
		if (m.severity > bestMsg) bestMsg = m.severity;
		if (detail && markerDetailLabels(m).includes(detail) && m.severity > bestExact) {
			bestExact = m.severity;
		}
	}
	if (bestExact >= 0) return severityName(bestExact);
	if (bestMsg >= 0) return severityName(bestMsg);
	return null;
}

function findMarkerSeverity(
	messageText: string,
	detailText: string,
	markers: readonly MarkerLike[],
	lineNumber?: number | null,
): HoverSeverity | null {
	const msg = normalizeSpace(messageText);
	const detail = normalizeSpace(detailText);
	if (!msg || !markers.length) return null;

	if (lineNumber != null && lineNumber > 0) {
		const scoped = markers.filter(
			(m) =>
				m.startLineNumber !== undefined &&
				m.endLineNumber !== undefined &&
				lineNumber >= m.startLineNumber &&
				lineNumber <= m.endLineNumber,
		);
		if (scoped.length) {
			const hit = matchIn(msg, detail, scoped);
			if (hit) return hit;
		}
	}

	return matchIn(msg, detail, markers);
}

/** Matches a rendered Monaco `.marker.hover-contents` row back to its model marker severity. */
export function matchMarkerSeverity(
	messageText: string,
	detailText: string,
	markers: readonly MarkerLike[],
	lineNumber?: number | null,
	fallback: HoverSeverity = "warning",
): HoverSeverity {
	return findMarkerSeverity(messageText, detailText, markers, lineNumber) ?? fallback;
}

/** Reads Monaco 0.58+'s `.marker-severity` codicon span when present as an exact/fallback severity signal. */
export function severityFromIcon(iconEl: Element | null | undefined): HoverSeverity | null {
	if (!iconEl) return null;
	const hasClass = (cls: string) =>
		iconEl.classList?.contains?.(cls) ??
		(typeof iconEl.className === "string" && iconEl.className.split(/\s+/).includes(cls));
	if (hasClass("codicon-error")) return "error";
	if (hasClass("codicon-warning")) return "warning";
	if (hasClass("severity-ignore")) return "hint";
	if (hasClass("codicon-info")) {
		const aria = iconEl.getAttribute?.("aria-label")?.trim().toLowerCase();
		return aria === "hint" ? "hint" : "info";
	}
	return null;
}

/** Resolves the severity of a rendered Monaco `.marker.hover-contents` DOM node (both Monaco 0.58+ and legacy layouts). */
export function resolveMarkerHoverSeverity(
	el: HTMLElement,
	markers: readonly MarkerLike[],
	lineNumber?: number | null,
): HoverSeverity {
	const msgContainer = el.querySelector?.<HTMLElement>(":scope > .marker-message") ?? null;
	const spans = msgContainer
		? msgContainer.querySelectorAll<HTMLElement>(":scope > span")
		: el.querySelectorAll<HTMLElement>(":scope > span:not(.marker-severity)");
	const msg = readText(spans[0]) || readText(msgContainer) || readText(el);
	const detail = readText(spans[1]);
	const iconSev = severityFromIcon(el.querySelector?.(":scope > .marker-severity"));
	// Monaco 0.58+ renders unambiguous codicons for Error, Warning, and Hint (`severity-ignore`);
	// match against model markers for legacy DOM and for `codicon-info` (distinguishing Hint vs Info,
	// without ever upgrading a `codicon-info` row to Error or Warning).
	if (iconSev === "error" || iconSev === "warning" || iconSev === "hint") return iconSev;
	const candidates = iconSev === "info" ? markers.filter((m) => m.severity <= 2) : markers;
	return matchMarkerSeverity(msg, detail, candidates, lineNumber, iconSev ?? "warning");
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
	let hoveredLine: number | null = null;

	const stamp = () => {
		const model = editor.getModel();
		const root = editor.getDomNode();
		if (!model || !root) return;
		const markerNodes = root.querySelectorAll<HTMLElement>(".monaco-hover .marker.hover-contents");
		if (!markerNodes.length) return;
		const markers = monaco.editor.getModelMarkers({ resource: model.uri });
		const line = hoveredLine ?? editor.getPosition()?.lineNumber ?? null;
		for (const el of markerNodes) {
			const row = el.closest<HTMLElement>(".hover-row");
			if (!row) continue;
			const sev = resolveMarkerHoverSeverity(el, markers, line);
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

	const moveSub = editor.onMouseMove?.((e) => {
		hoveredLine = e.target?.position?.lineNumber ?? null;
	});
	const leaveSub = editor.onMouseLeave?.(() => {
		hoveredLine = null;
	});
	const cursorSub = editor.onDidChangeCursorPosition?.(() => {
		hoveredLine = null;
	});
	const sub = editor.onDidChangeModel(() => {
		hoveredLine = null;
		attach();
	});
	attach();
	return () => {
		moveSub?.dispose();
		leaveSub?.dispose();
		cursorSub?.dispose();
		sub.dispose();
		observer?.disconnect();
		observer = null;
		observedEl = null;
	};
}
