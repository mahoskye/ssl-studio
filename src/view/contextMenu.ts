// A right-click anywhere in the window.
//
// Where the app has a menu for what was clicked (a file's row, a tab, the
// code, a rendered document), that menu has opened already and has stopped the
// web view's own. Everywhere else the web view would open its own: "Back",
// "Reload", "Inspect". It looks like nothing else here, and nothing in it is
// for this window. So it never opens: a text box gets the app's menu for a
// text box, selected words get "Copy", and anything else gets no menu.
import { askedByKey, boxMenu } from "../shared/menuBar";
import { copyText } from "./commands";
import { runInBox } from "./MenuBar";
import { chooseFromMenu } from "./panels/RowMenu";
import type { Point } from "./panels/Rows";

const NAMES = { cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select all" } as const;

/** A box that text is typed into. Not the text editor's own hidden one: the code has the editor's menu. */
function typedInto(el: Element | null): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
	const box = el?.closest<HTMLElement>("input, textarea, [contenteditable=''], [contenteditable=true]");
	if (!box || box.matches(".inputarea, .ime-text-area, .native-edit-context, input[type=checkbox], input[type=radio], input[type=button], input[type=range], input[type=color], input[type=file]")) return null;
	return box;
}

/** Whether anything in the box is selected, and whether it holds anything at all. */
function stateOf(box: HTMLElement) {
	if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
		let selected = false;
		try {
			selected = box.selectionStart !== null && box.selectionStart !== box.selectionEnd;
		} catch {
			// A kind of box that has no selection to ask about (a number, a date).
		}
		return { selected, filled: box.value !== "", editable: !box.readOnly && !box.disabled };
	}
	const selection = window.getSelection();
	return { selected: Boolean(selection && !selection.isCollapsed && box.contains(selection.anchorNode)), filled: (box.textContent ?? "") !== "", editable: true };
}

/** Where a menu opens when the event has no place of its own (the menu key): under what has the keyboard. */
function placeOf(e: MouseEvent, on: Element | null): Point {
	if (e.clientX || e.clientY || !on) return { x: e.clientX, y: e.clientY };
	const at = on.getBoundingClientRect();
	return { x: at.left + 8, y: at.bottom };
}

/**
 * Where the selected words themselves are drawn. Asked of each run of text, not of the selection whole: that also
 * gives the full box of every paragraph inside it, and the empty space beside a short line is not the words.
 */
function wordBoxes(range: Range): DOMRect[] {
	const root = range.commonAncestorContainer;
	if (root.nodeType === Node.TEXT_NODE) return [...range.getClientRects()];
	const boxes: DOMRect[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!range.intersectsNode(node)) continue;
		const part = document.createRange();
		part.selectNodeContents(node);
		if (node === range.startContainer) part.setStart(node, range.startOffset);
		if (node === range.endContainer) part.setEnd(node, range.endOffset);
		boxes.push(...part.getClientRects());
	}
	return boxes;
}

export function installContextMenu() {
	// When the menu's key and a pointer's button were last pressed: what tells a menu asked for by key from a click.
	let keyAt = 0;
	let pressAt = 0;
	window.addEventListener("keydown", (e) => (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && (keyAt = e.timeStamp), true);
	window.addEventListener("mousedown", (e) => (pressAt = e.timeStamp), true);
	window.addEventListener("contextmenu", (e) => {
		// The app's own menu for this place is open already.
		if (e.defaultPrevented) return;
		e.preventDefault();
		const on = e.target instanceof Element ? e.target : null;
		const at = placeOf(e, on);
		const box = typedInto(on);
		if (box) {
			const items = boxMenu({ ...stateOf(box), canPaste: Boolean(navigator.clipboard?.readText) });
			if (!items.length) return;
			// The keyboard stays in the box: one that saves or shuts when it loses the keyboard is not to do so for its menu.
			void chooseFromMenu("Actions for this text box", items.map((item) => NAMES[item]), at, { box }).then((picked) => {
				const name = items.find((item) => NAMES[item] === picked);
				if (name && box.isConnected) void runInBox(box, name);
			});
			return;
		}
		// Words selected on the page (a message, a line of output), when the click was on them: on one of the boxes the
		// selection is drawn in, not merely somewhere in what holds it. From the keyboard, the selection only has to be
		// in what holds the keyboard.
		const selection = window.getSelection();
		const words = selection?.toString() ?? "";
		if (!on || !selection || selection.isCollapsed || !selection.rangeCount || !words.trim()) return;
		// A click is told from the menu's key by which was pressed last, not by the event: a web view may give the
		// key's menu the right button and a place of its own choosing, which need not lie on the words.
		const pointed = !askedByKey(keyAt, pressAt, e.timeStamp);
		const onWords = pointed ? wordBoxes(selection.getRangeAt(0)).some((rect) => e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) : selection.containsNode(on, true);
		if (!onWords) return;
		void chooseFromMenu("Actions for the selected text", [NAMES.copy], at).then((picked) => picked === NAMES.copy && void copyText(words, "Copied the selected text."));
	});
}
