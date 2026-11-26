// Pass 3 medium findings in the live Markdown editor: what its rendered cards let into the window, where a click in
// them leads, an edit that started inside a surrogate pair, and a callout rewritten by a click in and out.
// Each test runs the code it names. Two things need a browser and are not proven here: DOMPurify itself (bun has
// no DOM, so the sanitising is tested as the configuration and the rule it is given), and the guard's listeners on
// real elements (they are run here against stand-in nodes and events).
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { withFrontMatter } from "../src/shared/frontMatter";
import { minimalReplace } from "../src/view/lsp/edits";
import { computeMinimalTextChange } from "../src/view/panels/markdownBridge";

// The same headless window and Monaco stand-ins as r4aMarkdownCm6.test.ts, so the editor's modules load under bun.
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
} else {
	if (!(globalThis as any).window.Error) (globalThis as any).window.Error = Error;
	if (!(globalThis as any).window.Map) (globalThis as any).window.Map = Map;
	if (!(globalThis as any).window.Set) (globalThis as any).window.Set = Set;
	if (!(globalThis as any).window.location) (globalThis as any).window.location = { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" };
	if (!(globalThis as any).window.location.protocol) (globalThis as any).window.location.protocol = "http:";
	if (!(globalThis as any).window.location.host) (globalThis as any).window.location.host = "127.0.0.1:5190";
}
if (typeof (globalThis as any).location === "undefined") {
	(globalThis as any).location = (globalThis as any).window.location;
}
if (typeof (globalThis as any).document === "undefined") {
	(globalThis as any).document = {
		documentElement: { dataset: {}, style: {} },
		createElement: () => ({ style: {} }),
		querySelector: () => null,
	};
} else if (typeof (globalThis as any).document.querySelector !== "function") {
	(globalThis as any).document.querySelector = () => null;
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}
if (typeof (globalThis as any).Event === "undefined") {
	(globalThis as any).Event = class {
		constructor(public type: string) {}
	};
}

const noopProxy = (extra: Record<string, any> = {}) =>
	new Proxy(extra, { get: (target, prop) => (prop in target ? target[prop as any] : () => ({ dispose() {} })) });

mock.module("monaco-editor/editor/editor.api", () => ({
	Range: class {
		constructor(
			public startLineNumber: number,
			public startColumn: number,
			public endLineNumber: number,
			public endColumn: number,
		) {}
	},
	Emitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	Uri: { from: () => ({}), file: (p: string) => ({ fsPath: p }) },
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { KeyB: 1, KeyI: 2, KeyX: 3, Backquote: 4, KeyH: 5, KeyK: 6, KeyL: 7, KeyC: 8, Enter: 9, Tab: 10, Backspace: 11 },
	languages: noopProxy({
		CompletionItemKind: { File: 1, Keyword: 2, Text: 3, Snippet: 4, Field: 5, Struct: 6 },
	}),
	editor: noopProxy({ getEditors: () => [], ScrollType: { Immediate: 1 } }),
}));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({
	default: class {},
}));
mock.module(resolve(import.meta.dir, "../src/view/editor/markdownLive.ts"), () => ({
	marksFor: async () => [],
}));

const { clickedLink, guardRenderedLinks, RENDERED_PURIFY_CONFIG, renderedKeepsElement } = await import("../src/view/editor/cmLiveShared");
const { calloutCommitText, CalloutWidget, serializePrefixedCalloutBlock } = await import("../src/view/editor/cmLiveCallout");
const { liveBlockField } = await import("../src/view/editor/cmLivePlugin");

const source = (rel: string) => readFileSync(resolve(import.meta.dir, "..", rel), "utf8");

// --- 1. What rendered Markdown may put into the window -----------------------

describe("rendered Markdown: what its HTML may bring into the window", () => {
	const forbidden = new Set(RENDERED_PURIFY_CONFIG.FORBID_TAGS);

	test("what styles the window, takes input, submits or loads another document is forbidden", () => {
		// The audit's document (a `<style>` and a `<form>` in a callout, a `<style>` in a table cell, an `<svg>` link in `<details>`).
		for (const tag of ["style", "form", "button", "svg"]) expect(forbidden.has(tag)).toBe(true);
		for (const tag of ["select", "textarea", "link", "meta", "base", "iframe", "object", "embed", "script", "math", "area", "map", "dialog"]) {
			expect(forbidden.has(tag)).toBe(true);
		}
		// DOMPurify lower-cases a tag before it looks it up, so the list has to be lower case to match.
		for (const tag of RENDERED_PURIFY_CONFIG.FORBID_TAGS) expect(tag).toBe(tag.toLowerCase());
		for (const attr of ["action", "formaction"]) expect(RENDERED_PURIFY_CONFIG.FORBID_ATTR).toContain(attr);
	});

	test("what a document is written with stays: pictures, links, tables, folds, and the task list's checkbox", () => {
		for (const tag of ["img", "a", "p", "span", "div", "table", "td", "details", "summary", "code", "pre", "kbd", "input"]) {
			expect(forbidden.has(tag)).toBe(false);
		}
		for (const attr of ["src", "href", "class", "id", "alt", "title", "width", "align", "checked", "disabled", "type"]) {
			expect(RENDERED_PURIFY_CONFIG.FORBID_ATTR).not.toContain(attr);
		}
	});

	test("the only <input> kept is a checkbox", () => {
		// marked writes a task as `<input disabled="" type="checkbox">`, and a callout ties each one to its line.
		expect(renderedKeepsElement("input", "checkbox")).toBe(true);
		expect(renderedKeepsElement("INPUT", " Checkbox ")).toBe(true);
		for (const type of ["text", "password", "file", "image", "submit", "button", "hidden", "", null, undefined]) {
			expect(renderedKeepsElement("input", type)).toBe(false);
		}
		// The rule is asked about every node, and says nothing against the rest.
		expect(renderedKeepsElement("img", null)).toBe(true);
		expect(renderedKeepsElement("#text", undefined)).toBe(true);
	});

	test("every renderer of nested Markdown goes through that sanitiser (read from the source: DOMPurify needs a DOM)", () => {
		const shared = source("src/view/editor/cmLiveShared.ts");
		const hover = source("src/view/editor/hoverPreview.ts");
		// The default profile was the defect: a bare `DOMPurify.sanitize(html)` lets <style> and <form> through.
		expect(shared).not.toContain("DOMPurify.sanitize(");
		expect(hover).not.toContain("DOMPurify");
		expect(shared).toContain("const raw = sanitizeRendered(parsed);");
		expect(shared).toContain("sanitizer().sanitize(html, RENDERED_PURIFY_CONFIG)");
		expect(hover.match(/sanitizeRendered\(marked\.parse\(/g)?.length).toBe(2);
		// The checkbox rule is a hook, so it is on a sanitiser of its own and never on the one every other caller shares.
		expect(shared).toContain("DOMPurify(window)");
		expect(shared).not.toContain("DOMPurify.addHook(");
	});
});

// --- 2. Where a click in a rendered card leads -------------------------------

type FakeNode = { nodeType: number; localName?: string; parentElement: FakeNode | null; getAttribute?: (name: string) => string | null };
const el = (localName: string, parentElement: FakeNode | null, attrs: Record<string, string> = {}): FakeNode => ({
	nodeType: 1,
	localName,
	parentElement,
	getAttribute: (name) => attrs[name] ?? null,
});

describe("rendered Markdown: the link a click would follow", () => {
	const root = el("div", el("body", null));

	test("an HTML anchor, from the element clicked inside it", () => {
		const a = el("a", el("p", root), { href: "specs/Due-dates.md#rules" });
		const strong = el("strong", a);
		expect(clickedLink(strong, root)).toBe("specs/Due-dates.md#rules");
		expect(clickedLink(a, root)).toBe("specs/Due-dates.md#rules");
		// A text node is not an element: the search starts at the element it is in.
		expect(clickedLink({ nodeType: 3, parentElement: strong }, root)).toBe("specs/Due-dates.md#rules");
	});

	test("an SVG anchor, which a Mermaid `click A href` draws, has its address in xlink:href", () => {
		const svg = el("svg", root);
		const a = el("a", el("g", svg), { "xlink:href": "https://example.org/a4-svg" });
		const text = el("text", el("g", a));
		// `closest("a[href]")`, which the cards use, does not match this one: it has no `href` attribute.
		expect(a.getAttribute!("href")).toBeNull();
		expect(clickedLink(text, root)).toBe("https://example.org/a4-svg");
		// SVG 2 writes plain `href`, and that is read first.
		expect(clickedLink(el("a", svg, { href: "docs/a.md", "xlink:href": "docs/b.md" }), root)).toBe("docs/a.md");
	});

	test("the area of an image map", () => {
		const area = el("area", el("map", root), { href: "https://example.org/map" });
		expect(clickedLink(area, root)).toBe("https://example.org/map");
	});

	test("nothing that is not in a link, and nothing above the guarded element", () => {
		expect(clickedLink(el("span", el("p", root)), root)).toBeNull();
		expect(clickedLink(null, root)).toBeNull();
		expect(clickedLink(root, root)).toBeNull();
		// An anchor around the guarded element is not the document's.
		const outer = el("a", null, { href: "https://example.org/outer" });
		const inner = el("div", outer);
		expect(clickedLink(el("span", inner), inner)).toBeNull();
		// A link that names no address is still a link (its default is still cancelled), with nothing to follow.
		expect(clickedLink(el("a", root), root)).toBe("");
	});
});

describe("rendered Markdown: the guard on the editor's host and the diagram viewer", () => {
	type Listener = { type: string; fn: (e: any) => void; capture: boolean };
	const makeRoot = () => {
		const listeners: Listener[] = [];
		const node = el("div", null) as FakeNode & { addEventListener: unknown; removeEventListener: unknown };
		node.addEventListener = (type: string, fn: (e: any) => void, capture?: boolean) => void listeners.push({ type, fn, capture: Boolean(capture) });
		node.removeEventListener = (type: string, fn: (e: any) => void, capture?: boolean) => {
			const at = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === Boolean(capture));
			if (at >= 0) listeners.splice(at, 1);
		};
		return { node, listeners };
	};
	/** Sends an event the way the browser does to listeners on one element: those of the capture phase, then the others. */
	const send = (listeners: Listener[], event: { type: string; target: unknown; altKey?: boolean }, stoppedByACard = false) => {
		let prevented = false;
		const e = { altKey: false, ...event, preventDefault: () => void (prevented = true) };
		for (const l of listeners.filter((l) => l.type === event.type && l.capture)) l.fn(e);
		// A card's own handler sits below the host and stops the click before it bubbles back up to it.
		if (!stoppedByACard) for (const l of listeners.filter((l) => l.type === event.type && !l.capture)) l.fn(e);
		return prevented;
	};

	test("a click on a link loses its default before any card sees it, and is followed when no card took it", () => {
		const { node, listeners } = makeRoot();
		const followed: string[] = [];
		guardRenderedLinks(node as never, (href) => void followed.push(href));
		const svgLink = el("text", el("a", el("svg", node), { "xlink:href": "https://example.org/a4-svg" }));

		// The cancelling listeners are in the capture phase: a card that stops the event cannot keep it from them.
		for (const type of ["click", "auxclick", "submit"]) expect(listeners.some((l) => l.type === type && l.capture)).toBe(true);

		expect(send(listeners, { type: "click", target: svgLink })).toBe(true);
		expect(followed).toEqual(["https://example.org/a4-svg"]);

		// A callout's or a table's handler follows its own `a[href]` and stops the click: it is not followed twice.
		const cardLink = el("a", el("td", node), { href: "docs/x.md" });
		expect(send(listeners, { type: "click", target: cardLink }, true)).toBe(true);
		expect(followed).toEqual(["https://example.org/a4-svg"]);
	});

	test("Alt+click and a middle click are cancelled and not followed; a submit is cancelled; other clicks are left alone", () => {
		const { node, listeners } = makeRoot();
		const followed: string[] = [];
		guardRenderedLinks(node as never, (href) => void followed.push(href));
		const link = el("a", el("p", node), { href: "https://example.org/" });

		expect(send(listeners, { type: "click", target: link, altKey: true })).toBe(true);
		expect(send(listeners, { type: "auxclick", target: link })).toBe(true);
		expect(send(listeners, { type: "submit", target: el("form", node) })).toBe(true);
		expect(send(listeners, { type: "click", target: el("area", el("map", node), { href: "" }) })).toBe(true);
		expect(followed).toEqual([]);

		expect(send(listeners, { type: "click", target: el("button", el("p", node)) })).toBe(false);
		expect(send(listeners, { type: "auxclick", target: el("span", node) })).toBe(false);
		expect(followed).toEqual([]);
	});

	test("without a way to follow it only cancels, and what it returns takes it off again", () => {
		const { node, listeners } = makeRoot();
		const stop = guardRenderedLinks(node as never);
		expect(send(listeners, { type: "click", target: el("a", node, { href: "x.md" }) })).toBe(true);
		stop();
		expect(listeners).toEqual([]);
	});

	test("the host, the hover card and the diagram viewer each carry it (read from the source: they are JSX in a window)", () => {
		const editor = source("src/view/editor/MarkdownLiveEditor.tsx");
		expect(editor).toContain("guardRenderedLinks(hostEl, (href) => void followLink(href))");
		expect(editor.match(/guardRenderedLinks\(el/g)?.length).toBe(2);
	});
});

// --- 3. An edit never starts or ends inside a surrogate pair ------------------

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
const cutsPair = (text: string, at: number) => at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));

/**
 * What Monaco's model makes of a single replacement: TextModel.validateRange (textModel.js) widens a range whose
 * start or end has the first unit of a pair just before it, and never touches the text that goes in.
 */
function monacoApply(text: string, start: number, end: number, insert: string): string {
	const lineStart = (at: number) => at === 0 || text[at - 1] === "\n";
	const lineEnd = (at: number) => at >= text.length || text[at] === "\n" || text[at] === "\r";
	const before = (at: number) => (lineStart(at) ? 0 : text.charCodeAt(at - 1));
	const startInside = isHigh(before(start));
	const endInside = !lineEnd(end) && isHigh(before(end));
	if (startInside || endInside) {
		if (start === end) {
			start--;
			end--;
		} else if (startInside && endInside) {
			start--;
			end++;
		} else if (startInside) start--;
		else end++;
	}
	return text.slice(0, start) + insert + text.slice(end);
}

describe("minimal edits and characters outside the basic plane", () => {
	const both = (before: string, after: string) => {
		const a = minimalReplace(before, after)!;
		const b = computeMinimalTextChange(before, after)!;
		// The two helpers are the same rule written twice (state.applyText and the Inspector): they must agree.
		expect({ start: b.start, end: b.endPrev, text: b.insert }).toEqual(a);
		return a;
	};

	test("a status changed from 🔴 to 🟢 replaces the whole character, and Monaco arrives at the new text", () => {
		const before = "---\nstatus: 🔴 blocked\n---\n# Doc\n";
		const after = withFrontMatter(before, "status", "🟢 done")!;
		expect(after).toContain("status: 🟢 done");
		const edit = both(before, after);
		// Unit by unit the texts first differ at offset 13, the second half of the emoji; the edit starts before the first.
		expect(before.indexOf("🔴")).toBe(12);
		expect(edit.start).toBe(12);
		expect(edit.text.startsWith("🟢")).toBe(true);
		expect(monacoApply(before, edit.start, edit.end, edit.text)).toBe(after);
	});

	test("the end of the edit does not cut a pair either", () => {
		// 🔴 (d83d dd34) and 🤴 (d83e dd34) end in the same unit.
		expect(both("a🔴b", "a🤴b")).toEqual({ start: 1, end: 3, text: "🤴" });
		// Deleting the first of two characters that share a first unit is that deletion, not a cut through both.
		expect(both("🔴🟢", "🟢")).toEqual({ start: 0, end: 2, text: "" });
		expect(both("x🔴🟢", "x🔴🔴🟢")).toEqual({ start: 3, end: 3, text: "🔴" });
		expect(both("🔴", "🟢")).toEqual({ start: 0, end: 2, text: "🟢" });
	});

	test("text without such characters is cut exactly as before", () => {
		expect(both("hello world", "hello there world")).toEqual({ start: 6, end: 6, text: "there " });
		expect(both("abc", "aXc")).toEqual({ start: 1, end: 2, text: "X" });
		expect(both("aaa", "aaaa")).toEqual({ start: 3, end: 3, text: "a" });
		expect(minimalReplace("same", "same")).toBeNull();
		expect(computeMinimalTextChange("same", "same")).toBeNull();
	});

	test("fuzz: the edit gives the new text, cuts no pair in either text, and survives Monaco's range rule", () => {
		// mulberry32: the multiplication stays in 32 bits (an LCG multiplied in doubles loses its low bits).
		let seed = 20261124;
		const rnd = (n: number) => {
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) % n;
		};
		// 🔴 🟢 🟡 share their first unit, 🤴 shares its second with 🔴; then letters, a line break, and lone halves.
		const wellFormed = ["a", "b", " ", "\n", "é", "🔴", "🟢", "🟡", "🤴", "𝒳"];
		const withLoneHalves = [...wellFormed, "\ud83d", "\udd34"];
		const problems: string[] = [];
		let astralEdits = 0;
		for (const alphabet of [wellFormed, withLoneHalves]) {
			for (let round = 0; round < 40000; round++) {
				const parts = Array.from({ length: rnd(9) }, () => alphabet[rnd(alphabet.length)]!);
				const changed = [...parts];
				for (let k = 1 + rnd(3); k > 0; k--) {
					const op = rnd(3);
					const at = rnd(changed.length + 1);
					if (op === 0) changed.splice(at, 0, alphabet[rnd(alphabet.length)]!);
					else if (op === 1 && changed.length) changed.splice(Math.min(at, changed.length - 1), 1);
					else if (changed.length) changed[Math.min(at, changed.length - 1)] = alphabet[rnd(alphabet.length)]!;
				}
				const before = parts.join("");
				const after = changed.join("");
				const a = minimalReplace(before, after);
				const b = computeMinimalTextChange(before, after);
				const note = (what: string) => void (problems.length < 5 && problems.push(`${what}: ${JSON.stringify({ before, after, a, b })}`));
				if (before === after) {
					if (a !== null || b !== null) note("an edit for equal texts");
					continue;
				}
				if (!a || !b) {
					note("no edit for different texts");
					continue;
				}
				if (b.start !== a.start || b.endPrev !== a.end || b.insert !== a.text) note("the two helpers disagree");
				if (a.start < 0 || a.start > a.end || a.end > before.length) note("a range out of order");
				if (before.slice(0, a.start) + a.text + before.slice(a.end) !== after) note("the edit does not give the new text");
				if (alphabet !== wellFormed) continue;
				if (/[\ud800-\udfff]/.test(a.text) || /[\ud800-\udfff]/.test(before.slice(a.start, a.end))) astralEdits++;
				if (cutsPair(before, a.start) || cutsPair(before, a.end)) note("the edit cuts a pair of the old text");
				if (cutsPair(after, a.start) || cutsPair(after, a.start + a.text.length)) note("the edit cuts a pair of the new text");
				if (monacoApply(before, a.start, a.end, a.text) !== after) note("Monaco would not arrive at the new text");
			}
		}
		expect(problems).toEqual([]);
		// The fuzz did exercise what it is for.
		expect(astralEdits).toBeGreaterThan(5000);
	});
});

// --- 4. A callout is rewritten only by a change ------------------------------

/** The callout card the live editor builds for a block, as buildBlockDecorations reads it from the document. */
function calloutIn(doc: string) {
	const state = EditorState.create({ doc, selection: EditorSelection.cursor(0), extensions: [markdown({ base: markdownLanguage }), liveBlockField] });
	let found: { from: number; to: number; widget: any } | null = null;
	state.field(liveBlockField).between(0, state.doc.length, (from, to, deco) => {
		if (deco.spec.widget instanceof CalloutWidget) found = { from, to, widget: deco.spec.widget };
	});
	if (!found) throw new Error(`no callout card for ${JSON.stringify(doc)}`);
	const { from, to, widget } = found as { from: number; to: number; widget: any };
	return {
		existing: state.sliceDoc(from, to),
		shown: { type: widget.parsed.spec.type as string, title: widget.parsed.title as string, fold: widget.parsed.fold as "+" | "-" | null, body: widget.bodyMarkdown as string },
		linePrefix: widget.linePrefix as string,
	};
}
const around = (block: string) => `Intro\n\n${block}\n\nAfter`;

describe("a callout card writes what was changed in it, not what it shows", () => {
	// The audit's blocks: each of them was rewritten by a click into the callout and out again.
	const respelt = [
		"> [!NOTE]\n> Useful information that users should know.",
		"> [!WARNING]\n> Urgent info.",
		"> [!warning] Warning\n> body",
		"> [!tip]\n>no space after marker",
		"> [!note] Title\n> first paragraph\n>\n> second paragraph\n>",
		"> [!note]  Two  spaces title\n> body",
		"  > [!NOTE] Indented\n  >body",
	];

	test("a blur with nothing typed writes nothing, however the block is spelt", () => {
		for (const block of [...respelt, "> [!note] Canonical\n> body", "> [!tip]- Folded"]) {
			const { existing, shown, linePrefix } = calloutIn(around(block));
			expect(existing).toBe(block);
			// Leaving the callout (the body's or the title's blur to outside), and moving between its title and body.
			expect(calloutCommitText(shown, shown, existing, false, linePrefix, null)).toBeNull();
			expect(calloutCommitText(shown, shown, existing, true, linePrefix, null)).toBeNull();
		}
	});

	test("those blocks are the ones a write would respell (what the blur used to do)", () => {
		for (const block of respelt) {
			const { existing, shown, linePrefix } = calloutIn(around(block));
			const written = serializePrefixedCalloutBlock(shown.type, shown.title, shown.fold, shown.body, false, linePrefix);
			expect(written).not.toBe(existing);
		}
	});

	test("a header-only callout gets no empty body line from moving between its title and its body", () => {
		const { existing, shown, linePrefix } = calloutIn(around("> [!note] Title"));
		expect(shown.body).toBe("");
		// The write this replaces was `> [!note] Title\n> `: a line added to the file by a click.
		expect(serializePrefixedCalloutBlock(shown.type, shown.title, shown.fold, shown.body, true, linePrefix)).toBe("> [!note] Title\n> ");
		expect(calloutCommitText(shown, shown, existing, true, linePrefix, null)).toBeNull();
	});

	test("a change is written: the body, the title, the type, the fold", () => {
		const { existing, shown, linePrefix } = calloutIn(around("> [!NOTE]\n>text"));
		expect(calloutCommitText(shown, { ...shown, body: "text!" }, existing, true, linePrefix, null)).toBe("> [!note]\n> text!");
		expect(calloutCommitText(shown, { ...shown, title: "Read me" }, existing, true, linePrefix, null)).toBe("> [!note] Read me\n> text");
		expect(calloutCommitText(shown, { ...shown, type: "tip", title: "Tip" }, existing, false, linePrefix, null)).toBe("> [!tip]\n> text");
		expect(calloutCommitText(shown, { ...shown, fold: "-" }, existing, false, linePrefix, null)).toBe("> [!note]-\n> text");
		// A change that comes to the text already there (a space typed after the title) is still no write.
		const canonical = calloutIn(around("> [!note] Title\n> body"));
		expect(calloutCommitText(canonical.shown, { ...canonical.shown, title: "Title " }, canonical.existing, true, "", null)).toBeNull();
	});

	test("typing and leaving: the empty line kept while typing is taken away on the way out", () => {
		// Enter, then Backspace, in the body of a header-only callout, then a click outside.
		let block = "> [!note] Title";
		let typed: string | null = null;
		const type = (body: string) => {
			const { existing, shown, linePrefix } = calloutIn(around(block));
			const written = calloutCommitText(shown, { ...shown, body }, existing, true, linePrefix, typed);
			if (written !== null) {
				block = written;
				typed = written;
			}
		};
		type("\n");
		expect(block).toBe("> [!note] Title\n>\n>");
		type("");
		expect(block).toBe("> [!note] Title\n> ");

		const left = calloutIn(around(block));
		expect(left.shown.body).toBe("");
		// Nothing differs from what the card shows, and still the card's own empty line goes.
		expect(calloutCommitText(left.shown, left.shown, left.existing, false, left.linePrefix, typed)).toBe("> [!note] Title");
		// While the caret only moves to the title, the line stays.
		expect(calloutCommitText(left.shown, left.shown, left.existing, true, left.linePrefix, typed)).toBeNull();
	});

	test("typing, undoing, and leaving leaves the block as it was written", () => {
		const original = "> [!NOTE]\n>text\n>";
		const opened = calloutIn(around(original));
		const typed = calloutCommitText(opened.shown, { ...opened.shown, body: `${opened.shown.body}x` }, opened.existing, true, opened.linePrefix, null);
		expect(typed).toBe("> [!note]\n> text\n> x");
		// Undo puts the document back; the card shows the original again and is left.
		const back = calloutIn(around(original));
		expect(calloutCommitText(back.shown, back.shown, back.existing, false, back.linePrefix, typed)).toBeNull();
	});
});
