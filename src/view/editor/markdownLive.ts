// A Markdown text drawn as it is written ("live preview"), in the text editor
// itself: a heading is larger, strong words are strong, a link's words look
// like a link, a task's box can be ticked with a click, and the markup (the
// #s, the stars, a link's brackets and address) is put out of the way on
// every line the cursor is not on. Put the cursor on a line and its markup is
// there to edit.
//
// Nothing here changes the text (ADR 0002): what the text is made of comes
// from src/shared/markdownLive.ts, and this only styles those places. The one
// edit it makes is the one the user asks for by clicking a task's box, and
// that is one character.
//
// The sizes, weights and faces are said twice, on purpose. The style sheet
// (markdownLive.css) is what draws them. The decoration's own options tell
// the editor that a stretch is not in its usual face, so that it measures
// the line as drawn and makes the cursor as tall as the text it is in. The
// two must agree.
import { HEADING_SIZES, headingStep, liveMarks, type LiveKind, type LiveMark } from "../../shared/markdownLive";
import { monaco } from "./monaco";
import LiveWorker from "./markdownLive.worker?worker";
import "./markdownLive.css";

/** A text this short is read on the spot, quickly enough not to be felt. A longer one is read aside from the window. */
const READ_HERE = 8000;
/** How long the typing has to pause before a long text is read again, in milliseconds. */
const PAUSE = 150;

/**
 * The marks a document was last drawn with, and the text they were read from. A long document that comes back to
 * the front is drawn with them at once, before its place is put back: its headings' taller lines are part of where
 * that place is.
 */
const kept = new WeakMap<monaco.editor.ITextModel, { version: number; marks: LiveMark[] }>();

let aside: Worker | null | undefined;
let asked = 0;
/** How many readings the reader aside has answered: for the self-test, which must know it was the reader and not the window. */
let answered = 0;
export const readingsAnsweredAside = () => answered;
const waiting = new Map<number, (marks: LiveMark[] | null) => void>();
/**
 * Reads a text aside from the window, and gives its marks when they are ready; null when no reading aside could be
 * had, and the caller reads it on the spot.
 */
function readAside(text: string): Promise<LiveMark[] | null> {
	if (aside === undefined) {
		try {
			aside = new LiveWorker();
			aside.onmessage = (e: MessageEvent<{ id: number; marks: LiveMark[] }>) => {
				answered++;
				waiting.get(e.data.id)?.(e.data.marks);
				waiting.delete(e.data.id);
			};
			// A reader that fails is given up for good: every text waiting on it, and every one after, is read on the spot.
			aside.onerror = () => {
				aside = null;
				for (const answer of waiting.values()) answer(null);
				waiting.clear();
			};
		} catch {
			aside = null;
		}
	}
	const reader = aside;
	if (!reader) return Promise.resolve(null);
	return new Promise((resolve) => {
		const id = ++asked;
		waiting.set(id, resolve);
		reader.postMessage({ id, text });
	});
}

/**
 * The marks of a document's text as it is now, for whoever else needs to know what its text is made of: what was
 * last read when the text has not changed since, read otherwise (aside from the window when it is long).
 */
export async function marksFor(model: monaco.editor.ITextModel): Promise<LiveMark[]> {
	const had = kept.get(model);
	if (had?.version === model.getVersionId()) return had.marks;
	const text = model.getValue();
	return text.length <= READ_HERE ? liveMarks(text) : ((await readAside(text)) ?? liveMarks(text));
}

/** The face prose is set in: the app's own, not the code's. */
export const PROSE_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** How much taller than the text's a heading's line is, step by step with HEADING_SIZES. */
const HEADING_LINES = [1.9, 1.7, 1.5, 1.3, 1.2];
const HEADING: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

type Options = monaco.editor.IModelDecorationOptions;

/**
 * How each kind of text is drawn: its own stretch, and for some a whole line's ground behind it. `mono` is the
 * code's own face, for what must keep its columns.
 */
function styleOf(kind: LiveKind, size: number, mono: string, room: number): { text?: Options; line?: Options } {
	const level = HEADING[kind];
	if (level) {
		// The largest size the line has room for: its own, or a smaller step.
		const step = headingStep(level, room);
		return { text: { inlineClassName: `md-live-heading md-live-size-${step + 1}`, fontSize: `${size * HEADING_SIZES[step]!}px`, fontWeight: "600", lineHeight: HEADING_LINES[step] } };
	}
	switch (kind) {
		case "strong":
			return { text: { inlineClassName: "md-live-strong", fontWeight: "700" } };
		case "em":
			return { text: { inlineClassName: "md-live-em", fontStyle: "italic" } };
		case "strike":
			return { text: { inlineClassName: "md-live-strike" } };
		case "code":
			return { text: { inlineClassName: "md-live-code md-live-mono", fontFamily: mono } };
		case "link":
			return { text: { inlineClassName: "md-live-link" } };
		case "bullet":
			return { text: { inlineClassName: "md-live-bullet" } };
		case "box":
			return { text: { inlineClassName: "md-live-box md-live-mono", fontFamily: mono } };
		case "done":
			return { text: { inlineClassName: "md-live-done" } };
		case "quote":
			return { text: { inlineClassName: "md-live-quoted" }, line: { isWholeLine: true, className: "md-live-quote" } };
		case "codeblock":
			return { text: { inlineClassName: "md-live-mono", fontFamily: mono }, line: { isWholeLine: true, className: "md-live-codeblock" } };
		case "table":
			return { text: { inlineClassName: "md-live-mono", fontFamily: mono } };
		case "rule":
			return { text: { inlineClassName: "md-live-faint" }, line: { isWholeLine: true, className: "md-live-rule" } };
		case "front":
			return { text: { inlineClassName: "md-live-faint md-live-mono", fontFamily: mono } };
		default:
			return {};
	}
}

/** Markup on a line the cursor is on: there to edit, and quiet. */
const SHOWN: Options = { inlineClassName: "md-live-syntax" };
/** Markup on every other line: out of the way. It takes no room; it is shown again as soon as the cursor comes to its line. */
const HIDDEN: Options = { inlineClassName: "md-live-hidden", fontSize: "0px" };

/**
 * The decorations for what a text is made of: everything but the markup, which changes with the cursor and is drawn
 * apart. `room` says how many times larger than the text a line could be drawn and still fit.
 */
export function decorationsOf(marks: readonly LiveMark[], size: number, mono: string, room: (line: number) => number = () => Number.POSITIVE_INFINITY): monaco.editor.IModelDeltaDecoration[] {
	const out: monaco.editor.IModelDeltaDecoration[] = [];
	/** Where a line's opening markup ends: a heading's own stretch starts after it, so that the two do not ask for two sizes. */
	const afterMarkup = new Map<number, number>();
	for (const mark of marks) if (mark.kind === "syntax" && mark.start === 1) afterMarkup.set(mark.line, mark.end);
	for (const mark of marks) {
		if (mark.kind === "syntax") continue;
		const style = styleOf(mark.kind, size, mono, HEADING[mark.kind] ? room(mark.line) : 0);
		const start = HEADING[mark.kind] ? (afterMarkup.get(mark.line) ?? mark.start) : mark.start;
		if (style.text) out.push({ range: new monaco.Range(mark.line, start, mark.line, mark.end), options: style.text });
		if (style.line) out.push({ range: new monaco.Range(mark.line, 1, mark.line, 1), options: style.line });
	}
	return out;
}

/** The decorations for the markup: shown, dimmed, on the lines being written (`active`), and out of the way on the rest. */
export function markupOf(marks: readonly LiveMark[], active: ReadonlySet<number>): monaco.editor.IModelDeltaDecoration[] {
	return marks.filter((mark) => mark.kind === "syntax").map((mark) => ({ range: new monaco.Range(mark.line, mark.start, mark.line, mark.end), options: active.has(mark.line) ? SHOWN : HIDDEN }));
}

/** The lines a set of selections touches. */
function linesOf(selections: readonly monaco.Selection[] | null): Set<number> {
	const lines = new Set<number>();
	for (const selection of selections ?? []) for (let line = selection.startLineNumber; line <= selection.endLineNumber; line++) lines.add(line);
	return lines;
}

/**
 * Draws an editor's Markdown as it is written, for as long as `on` says so (the file is Markdown, shown as text,
 * and live preview has not been switched off). The caller sets the editor's own options for prose (its face, its
 * wrapping) and says when `on` may have changed (`redraw`); this draws the marks, and ticks a task's box when it
 * is clicked. `stop` ends it.
 */
export function drawMarkdownLive(editor: monaco.editor.IStandaloneCodeEditor, on: () => boolean): { redraw: () => void; stop: () => void } {
	/** What the text is made of: drawn again only when the text has been read again. */
	const drawn = editor.createDecorationsCollection();
	/** Its markup, shown or hidden: drawn again when the cursor comes to other lines too. */
	const markup = editor.createDecorationsCollection();
	/** The code's own face, as the editor had it before prose took it over. The style rules take it from here. */
	const mono = editor.getOption(monaco.editor.EditorOption.fontFamily);
	document.documentElement.style.setProperty("--md-live-mono", mono);
	/** The marks as they were last read. Between a change and the next reading they are of the text as it was. */
	let marks: LiveMark[] = [];
	let active = "";
	let waitingFrame = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** A reading aside is under way; and the text changed again while it was. */
	let busy = false;
	let again = false;
	let stopped = false;
	/** The width the text had when it was last drawn. */
	let across = editor.getLayoutInfo().contentWidth;
	/** For measuring how wide a line is in the heading's face at the text's size. */
	const ruler = document.createElement("canvas").getContext("2d");
	/** How many times larger than the text a line could be drawn before it ran past the editor's edge. */
	const roomFor = (model: monaco.editor.ITextModel) => {
		const size = editor.getOption(monaco.editor.EditorOption.fontSize);
		const layout = editor.getLayoutInfo();
		const width = layout.contentWidth - layout.verticalScrollbarWidth - 8;
		if (ruler) ruler.font = `600 ${size}px ${PROSE_FONT}`;
		return (line: number) => {
			const drawnWidth = line <= model.getLineCount() ? (ruler?.measureText(model.getLineContent(line)).width ?? 0) : 0;
			return drawnWidth > 0 && width > 0 ? width / drawnWidth : Number.POSITIVE_INFINITY;
		};
	};
	/** The editor's own colouring of Markdown makes words bold and slanted by its own reading: here this reading draws them. */
	const own = (is: boolean) => editor.getContainerDomNode().classList.toggle("md-live-on", is);

	/**
	 * A click with the key held that follows a link is under way. The cursor goes to the line as the button goes
	 * down, and the link is followed where the pointer is as it comes up: were the line's markup brought out in
	 * between, the link would have moved from under the pointer. So until the button is up the lines being written
	 * are taken to be those they were (`writtenThen`), whoever asks.
	 */
	let pointing = false;
	let writtenThen: ReadonlySet<number> = new Set<number>();
	/**
	 * The lines being written: those the cursor or a selection is on, while the keyboard is in the editor or in one of
	 * its own boxes. The find box is one: the match it goes to is selected, and its line shows its markup, so that a
	 * match inside markup can be seen.
	 */
	const written = () => (pointing ? writtenThen : (writtenThen = editor.hasWidgetFocus() ? linesOf(editor.getSelections()) : new Set<number>()));
	/** What the text was last drawn from: the reading, the text's size and the width. From the same, it would be drawn the same. */
	let drawnFrom: { marks: LiveMark[]; size: number; width: number } | undefined;
	/**
	 * Does what changes the heights of lines with what is at the top of the view held where it is: headings above it
	 * growing taller, or coming back down, would otherwise push the text under the reader's eye. Putting the drawing
	 * on and taking it off both hold, so that going one way and back ends where it began.
	 */
	const held = (change: () => void) => {
		const first = editor.getVisibleRanges()[0]?.startLineNumber;
		const top = editor.getScrollTop();
		const before = first ? editor.getTopForLineNumber(first) : 0;
		change();
		const shift = first ? editor.getTopForLineNumber(first) - before : 0;
		if (shift) editor.setScrollTop(top + shift);
	};
	const clear = () => {
		marks = [];
		active = "";
		drawnFrom = undefined;
		held(() => {
			drawn.clear();
			markup.clear();
		});
		own(false);
	};
	/** Draws a reading of the text. */
	const apply = (model: monaco.editor.ITextModel, read: LiveMark[], version = model.getVersionId()) => {
		marks = read;
		kept.set(model, { version, marks: read });
		const lines = written();
		active = [...lines].join(",");
		const size = editor.getOption(monaco.editor.EditorOption.fontSize);
		drawnFrom = { marks: read, size, width: editor.getLayoutInfo().contentWidth };
		held(() => {
			drawn.set(decorationsOf(marks, size, mono, roomFor(model)));
			markup.set(markupOf(marks, lines));
		});
	};
	/** Reads the text and draws it: on the spot when it is short, aside from the window when it is long. */
	const read = () => {
		const model = editor.getModel();
		if (stopped) return;
		if (!model || !on()) return clear();
		own(true);
		const text = model.getValue();
		if (text.length <= READ_HERE) return apply(model, liveMarks(text));
		// Read already, as it is now: drawn from that, unless that is what is drawn, at this size and width. Drawing
		// it twice would be to take the lines' heights away and give them back under a view that has just been put
		// where it was.
		const had = kept.get(model);
		if (had?.version === model.getVersionId()) {
			const same = drawnFrom?.marks === had.marks && drawnFrom.size === editor.getOption(monaco.editor.EditorOption.fontSize) && drawnFrom.width === editor.getLayoutInfo().contentWidth;
			return same ? undefined : apply(model, had.marks);
		}
		// One reading at a time: a text that changes while it is being read is read again when that reading is in.
		if (busy) return void (again = true);
		busy = true;
		const version = model.getVersionId();
		void readAside(text).then((marksRead) => {
			busy = false;
			if (stopped) return;
			const now = editor.getModel();
			const current = now === model && model.getVersionId() === version;
			// With no reading aside to be had, it is read here after all.
			if (current && on()) apply(model, marksRead ?? liveMarks(text));
			if (again || !current) {
				again = false;
				read();
			}
		});
	};
	/**
	 * After the text changed: once, when the typing pauses. For a frame when the text is short; a little longer for a
	 * long one, which is read aside. What is drawn moves with the text meanwhile: the editor carries it along.
	 */
	const later = () => {
		cancelAnimationFrame(waitingFrame);
		clearTimeout(timer);
		if ((editor.getModel()?.getValueLength() ?? 0) <= READ_HERE) waitingFrame = requestAnimationFrame(read);
		else timer = setTimeout(read, PAUSE);
	};
	/** The button is up, or the click was called off, or the window was left: the markup follows the cursor again. */
	const pointed = () => {
		window.removeEventListener("mouseup", pointed, true);
		window.removeEventListener("pointercancel", pointed, true);
		window.removeEventListener("blur", pointed);
		// After the editor has heard of the button coming up, which it does in this same turn.
		setTimeout(() => {
			pointing = false;
			if (!stopped) moved();
		}, 0);
	};
	/** Heard on the way down to the editor, which moves the cursor before it tells anyone of the click. */
	const pointerDown = (e: PointerEvent) => {
		if (pointing || !on() || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
		pointing = true;
		// Heard on the window: the button may come up outside the editor. The window's own blur only (it is not heard
		// on the way down): the editor taking the keyboard from a button or a panel is not the click called off.
		window.addEventListener("mouseup", pointed, true);
		window.addEventListener("pointercancel", pointed, true);
		window.addEventListener("blur", pointed);
	};
	editor.getContainerDomNode().addEventListener("pointerdown", pointerDown, true);
	/**
	 * After the cursor moved, or the keyboard came or went: the markup of the lines now being written is shown, and
	 * of the rest hidden. Where each piece of markup is now is asked of the editor, which has carried it along with
	 * every edit: the marks as last read may be of the text as it was.
	 */
	const moved = () => {
		const lines = written();
		const now = [...lines].join(",");
		if (now === active) return;
		active = now;
		markup.set(
			markup
				.getRanges()
				.filter((range) => !range.isEmpty())
				.map((range) => ({ range, options: lines.has(range.startLineNumber) ? SHOWN : HIDDEN })),
		);
	};
	const listeners = [
		// Another file: what was drawn was the other's. One that was drawn before is drawn at once with what it was
		// drawn with, here and now, since its place is put back as soon as this returns; if its text has changed since,
		// that is near enough until it has been read again.
		editor.onDidChangeModel(() => {
			clear();
			const model = editor.getModel();
			const had = model && on() ? kept.get(model) : undefined;
			if (model && had && had.version !== model.getVersionId()) {
				own(true);
				apply(model, had.marks, had.version);
			}
			read();
		}),
		editor.onDidChangeModelContent(later),
		editor.onDidChangeModelLanguage(read),
		editor.onDidChangeCursorSelection(moved),
		// A heading is drawn at the size its line has room for. The room changes with the editor's width, heard here,
		// and with the text's size, which the caller says by asking for a redraw.
		editor.onDidLayoutChange((layout) => {
			if (layout.contentWidth === across) return;
			across = layout.contentWidth;
			later();
		}),
		editor.onDidFocusEditorWidget(moved),
		// Heard as well: coming back to the text from one of the editor's own boxes is not always told as a new focus.
		editor.onDidFocusEditorText(moved),
		editor.onDidBlurEditorWidget(moved),
		// A click on a task's box ticks it, or takes the tick away: one character of the text changes. One click of
		// the main button, on the box itself (not beside it), with no key held.
		editor.onMouseDown((e) => {
			const at = e.target.position;
			if (!at || !on() || !e.event.leftButton || e.event.detail !== 1 || e.event.ctrlKey || e.event.metaKey || e.event.shiftKey || e.event.altKey) return;
			if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !e.target.element?.closest(".md-live-box")) return;
			const model = editor.getModel();
			if (!model || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
			// The box is found in the line as it is now, at the place clicked: not in marks that may be of the text as it was.
			const line = model.getLineContent(at.lineNumber);
			let open = -1;
			for (let i = Math.min(at.column - 1, line.length - 1); i >= Math.max(0, at.column - 4) && open < 0; i--) if (/^\[[ xX]\]/.test(line.slice(i, i + 3))) open = i;
			if (open < 0) return;
			const inside = new monaco.Range(at.lineNumber, open + 2, at.lineNumber, open + 3);
			const ticked = line[open + 1] !== " ";
			e.event.preventDefault();
			e.event.stopPropagation();
			model.pushStackElement();
			model.pushEditOperations([], [{ range: inside, text: ticked ? " " : "x" }], () => null);
			model.pushStackElement();
		}),
	];
	read();
	return {
		redraw: read,
		stop: () => {
			stopped = true;
			editor.getContainerDomNode().removeEventListener("pointerdown", pointerDown, true);
			window.removeEventListener("mouseup", pointed, true);
			window.removeEventListener("pointercancel", pointed, true);
			window.removeEventListener("blur", pointed);
			cancelAnimationFrame(waitingFrame);
			clearTimeout(timer);
			listeners.forEach((listener) => listener.dispose());
			drawn.clear();
			markup.clear();
			own(false);
		},
	};
}
