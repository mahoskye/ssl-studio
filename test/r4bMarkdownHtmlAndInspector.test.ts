import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { marked } from "marked";
import {
	expandTransclusionsMarkdown,
	extractFootnoteDefinition,
	finishMarkdown,
	renderCalloutsHtml,
	transformCalloutsDom,
	type TransclusionLoader,
} from "../src/view/editor/markdownHtml";
import {
	freshResourceValue,
	hasUnclosedFrontMatter,
	resolveSqlSourcePath,
	safeDecodeUriComponent,
} from "../src/view/panels/markdownBridge";

// ---------------------------------------------------------------------------
// Minimal HTML5-faithful DOM harness so we can test `finishMarkdown`,
// `transformCalloutsDom`, `renderMath`, `renderHighlights`, and `renderTags`
// directly under Bun without external DOM dependencies.
// Crucially, `serializeNode` mirrors HTML5 / DOMPurify's `innerHTML` behavior:
// `<` and `>` inside double-quoted attribute values are serialized literally
// (not re-escaped as `&lt;` / `&gt;`), reproducing the exact browser output
// that triggered the P0 callout XSS bypass.
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&apos;/gi, "'")
		.replace(/&amp;/gi, "&");
}

function escapeText(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
	// Per HTML5 fragment serialization, only `&` and `"` are escaped in quoted attributes;
	// `<` and `>` remain literal, matching real browsers & DOMPurify!
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

class MiniNode {
	nodeType: number;
	parentNode: MiniParent | null = null;
	ownerDocument: MiniDocument;
	constructor(nodeType: number, ownerDocument: MiniDocument) {
		this.nodeType = nodeType;
		this.ownerDocument = ownerDocument;
	}
	get parentElement(): MiniElement | null {
		return this.parentNode instanceof MiniElement ? this.parentNode : null;
	}
	get nextSibling(): MiniNode | null {
		if (!this.parentNode) return null;
		const idx = this.parentNode.childNodes.indexOf(this);
		return idx >= 0 && idx + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[idx + 1]! : null;
	}
	get textContent(): string {
		return "";
	}
	set textContent(_v: string) {}
	replaceWith(...nodes: (MiniNode | string)[]) {
		const parent = this.parentNode;
		if (!parent) return;
		const idx = parent.childNodes.indexOf(this);
		if (idx < 0) return;
		const expanded: MiniNode[] = [];
		for (const n of nodes) {
			if (typeof n === "string") expanded.push(this.ownerDocument.createTextNode(n));
			else if (n instanceof MiniFragment) {
				while (n.childNodes.length) {
					const c = n.childNodes.shift()!;
					c.parentNode = null;
					expanded.push(c);
				}
			} else {
				n.detach();
				expanded.push(n);
			}
		}
		this.parentNode = null;
		for (const c of expanded) c.parentNode = parent;
		parent.childNodes.splice(idx, 1, ...expanded);
	}
	detach() {
		if (!this.parentNode) return;
		const idx = this.parentNode.childNodes.indexOf(this);
		if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
		this.parentNode = null;
	}
}

class MiniText extends MiniNode {
	data: string;
	constructor(data: string, doc: MiniDocument) {
		super(3, doc);
		this.data = data;
	}
	get nodeValue(): string {
		return this.data;
	}
	override get textContent(): string {
		return this.data;
	}
	override set textContent(v: string) {
		this.data = v;
	}
}

class MiniComment extends MiniNode {
	data: string;
	constructor(data: string, doc: MiniDocument) {
		super(8, doc);
		this.data = data;
	}
}

class MiniParent extends MiniNode {
	childNodes: MiniNode[] = [];
	get firstChild(): MiniNode | null {
		return this.childNodes[0] ?? null;
	}
	get children(): MiniElement[] {
		return this.childNodes.filter((n): n is MiniElement => n instanceof MiniElement);
	}
	override get textContent(): string {
		return this.childNodes.map((n) => n.textContent).join("");
	}
	override set textContent(v: string) {
		for (const c of this.childNodes) c.parentNode = null;
		this.childNodes = [];
		if (v) this.appendChild(this.ownerDocument.createTextNode(v));
	}
	appendChild(node: MiniNode): MiniNode {
		if (node instanceof MiniFragment) {
			while (node.childNodes.length) {
				const c = node.childNodes.shift()!;
				c.parentNode = this;
				this.childNodes.push(c);
			}
			return node;
		}
		node.detach();
		node.parentNode = this;
		this.childNodes.push(node);
		return node;
	}
	append(...items: (MiniNode | string)[]) {
		for (const item of items) {
			this.appendChild(typeof item === "string" ? this.ownerDocument.createTextNode(item) : item);
		}
	}
	replaceChild(next: MiniNode, old: MiniNode): MiniNode {
		const idx = this.childNodes.indexOf(old);
		if (idx < 0) return old;
		next.detach();
		old.parentNode = null;
		next.parentNode = this;
		this.childNodes[idx] = next;
		return old;
	}
	querySelectorAll(selector: string): MiniElement[] {
		const out: MiniElement[] = [];
		const visit = (node: MiniParent) => {
			for (const c of node.childNodes) {
				if (c instanceof MiniElement) {
					if (matchesSelectorList(c, selector)) out.push(c);
					visit(c);
				}
			}
		};
		visit(this);
		return out;
	}
	querySelector(selector: string): MiniElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
}

class MiniFragment extends MiniParent {
	constructor(doc: MiniDocument) {
		super(11, doc);
	}
}

function matchesCompound(el: MiniElement, sel: string): boolean {
	let rest = sel.trim();
	if (!rest) return false;
	const tagMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(rest);
	if (tagMatch) {
		if (el.tagName !== tagMatch[0].toUpperCase()) return false;
		rest = rest.slice(tagMatch[0].length);
	}
	while (rest.length > 0) {
		if (rest[0] === ".") {
			const clsMatch = /^\.([A-Za-z0-9_-]+)/.exec(rest);
			if (!clsMatch || !el.classList.contains(clsMatch[1]!)) return false;
			rest = rest.slice(clsMatch[0].length);
		} else if (rest[0] === "[") {
			const attrMatch = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
			if (!attrMatch) return false;
			const val = el.getAttribute(attrMatch[1]!);
			if (val === null) return false;
			if (attrMatch[2] !== undefined && val !== attrMatch[2]) return false;
			rest = rest.slice(attrMatch[0].length);
		} else {
			return false;
		}
	}
	return true;
}

function matchesSingleSelector(el: MiniElement, sel: string): boolean {
	const parts = sel.trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return false;
	if (!matchesCompound(el, parts[parts.length - 1]!)) return false;
	let cur = el.parentElement;
	for (let i = parts.length - 2; i >= 0; i--) {
		let matched = false;
		while (cur) {
			if (matchesCompound(cur, parts[i]!)) {
				matched = true;
				cur = cur.parentElement;
				break;
			}
			cur = cur.parentElement;
		}
		if (!matched) return false;
	}
	return true;
}

function matchesSelectorList(el: MiniElement, selector: string): boolean {
	return selector.split(",").some((part) => matchesSingleSelector(el, part));
}

class MiniElement extends MiniParent {
	tagName: string;
	attrs = new Map<string, string>();
	dataset: Record<string, string>;
	classList: {
		add: (...cls: string[]) => void;
		contains: (cls: string) => boolean;
	};
	constructor(tag: string, doc: MiniDocument) {
		super(1, doc);
		this.tagName = tag.toUpperCase();
		const self = this;
		this.dataset = new Proxy(
			{},
			{
				get(_t, prop: string) {
					const attr = `data-${prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
					return self.attrs.get(attr);
				},
				set(_t, prop: string, val: string) {
					const attr = `data-${prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
					self.attrs.set(attr, String(val));
					return true;
				},
			},
		);
		this.classList = {
			add(...cls: string[]) {
				const set = new Set((self.attrs.get("class") ?? "").split(/\s+/).filter(Boolean));
				for (const c of cls) if (c) set.add(c);
				self.attrs.set("class", [...set].join(" "));
			},
			contains(cls: string) {
				return (self.attrs.get("class") ?? "").split(/\s+/).includes(cls);
			},
		};
	}
	get className(): string {
		return this.attrs.get("class") ?? "";
	}
	set className(v: string) {
		this.attrs.set("class", v);
	}
	get id(): string {
		return this.attrs.get("id") ?? "";
	}
	set id(v: string) {
		this.attrs.set("id", v);
	}
	get title(): string {
		return this.attrs.get("title") ?? "";
	}
	set title(v: string) {
		this.attrs.set("title", v);
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name.toLowerCase(), value);
	}
	getAttribute(name: string): string | null {
		return this.attrs.get(name.toLowerCase()) ?? null;
	}
	closest(selector: string): MiniElement | null {
		let cur: MiniElement | null = this;
		while (cur) {
			if (matchesSelectorList(cur, selector)) return cur;
			cur = cur.parentElement;
		}
		return null;
	}
	get innerHTML(): string {
		return this.childNodes.map(serializeNode).join("");
	}
	set innerHTML(html: string) {
		for (const c of this.childNodes) c.parentNode = null;
		this.childNodes = [];
		parseHtmlInto(html, this, this.ownerDocument);
	}
}

class MiniTemplateElement extends MiniElement {
	content: MiniFragment;
	constructor(doc: MiniDocument) {
		super("template", doc);
		this.content = new MiniFragment(doc);
	}
	override get innerHTML(): string {
		return this.content.childNodes.map(serializeNode).join("");
	}
	override set innerHTML(html: string) {
		for (const c of this.content.childNodes) c.parentNode = null;
		this.content.childNodes = [];
		parseHtmlInto(html, this.content, this.ownerDocument);
	}
}

class MiniDocument {
	createElement(tag: string): MiniElement {
		return tag.toLowerCase() === "template" ? new MiniTemplateElement(this) : new MiniElement(tag, this);
	}
	createTextNode(text: string): MiniText {
		return new MiniText(text, this);
	}
	createDocumentFragment(): MiniFragment {
		return new MiniFragment(this);
	}
	createTreeWalker(root: MiniParent, whatToShow: number) {
		const all: MiniNode[] = [];
		const visit = (node: MiniParent) => {
			for (const c of node.childNodes) {
				if (whatToShow === 4) {
					if (c instanceof MiniText) all.push(c);
				} else {
					all.push(c);
				}
				if (c instanceof MiniParent) visit(c);
			}
		};
		visit(root);
		let idx = 0;
		return {
			nextNode: () => (idx < all.length ? all[idx++]! : null),
		};
	}
}

function serializeNode(node: MiniNode): string {
	if (node instanceof MiniText) return escapeText(node.data);
	if (node instanceof MiniComment) return `<!--${node.data}-->`;
	if (node instanceof MiniElement) {
		const tag = node.tagName.toLowerCase();
		let attrs = "";
		for (const [k, v] of node.attrs) attrs += ` ${k}="${escapeAttr(v)}"`;
		if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
		return `<${tag}${attrs}>${node.childNodes.map(serializeNode).join("")}</${tag}>`;
	}
	return "";
}

function parseHtmlInto(html: string, root: MiniParent, doc: MiniDocument) {
	const stack: MiniParent[] = [root];
	const cur = () => stack[stack.length - 1]!;
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt < 0) {
			if (i < html.length) cur().appendChild(doc.createTextNode(decodeEntities(html.slice(i))));
			break;
		}
		if (lt > i) {
			cur().appendChild(doc.createTextNode(decodeEntities(html.slice(i, lt))));
			i = lt;
		}
		if (html.startsWith("<!--", i)) {
			const end = html.indexOf("-->", i + 4);
			const next = end < 0 ? html.length : end + 3;
			cur().appendChild(new MiniComment(html.slice(i + 4, end < 0 ? html.length : end), doc));
			i = next;
			continue;
		}
		if (html[i + 1] === "/" && i + 2 < html.length && /[A-Za-z]/.test(html[i + 2]!)) {
			let nameEnd = i + 3;
			while (nameEnd < html.length && /[A-Za-z0-9:-]/.test(html[nameEnd]!)) nameEnd++;
			const gt = html.indexOf(">", nameEnd);
			if (gt >= 0) {
				const tag = html.slice(i + 2, nameEnd).toUpperCase();
				for (let s = stack.length - 1; s >= 1; s--) {
					if ((stack[s] as MiniElement).tagName === tag) {
						stack.length = s;
						break;
					}
				}
				i = gt + 1;
				continue;
			}
		}
		if (i + 1 < html.length && /[A-Za-z]/.test(html[i + 1]!)) {
			let nameEnd = i + 2;
			while (nameEnd < html.length && /[A-Za-z0-9:-]/.test(html[nameEnd]!)) nameEnd++;
			if (nameEnd < html.length && /[\t\n\f\r />]/.test(html[nameEnd]!)) {
				const tag = html.slice(i + 1, nameEnd).toLowerCase();
				const el = doc.createElement(tag);
				let j = nameEnd;
				let closedAt = -1;
				let selfClosing = false;
				while (j < html.length) {
					while (j < html.length && /[\t\n\f\r ]/.test(html[j]!)) j++;
					if (j >= html.length) break;
					if (html[j] === ">") {
						closedAt = j;
						break;
					}
					if (html[j] === "/" && html[j + 1] === ">") {
						selfClosing = true;
						closedAt = j + 1;
						break;
					}
					const attrStart = j;
					while (j < html.length && !/[\t\n\f\r =/>]/.test(html[j]!)) j++;
					const attrName = html.slice(attrStart, j).toLowerCase();
					while (j < html.length && /[\t\n\f\r ]/.test(html[j]!)) j++;
					let attrVal = "";
					if (html[j] === "=") {
						j++;
						while (j < html.length && /[\t\n\f\r ]/.test(html[j]!)) j++;
						if (html[j] === '"' || html[j] === "'") {
							const q = html[j]!;
							j++;
							const endQ = html.indexOf(q, j);
							if (endQ < 0) {
								j = html.length;
								break;
							}
							attrVal = decodeEntities(html.slice(j, endQ));
							j = endQ + 1;
						} else {
							const vStart = j;
							while (j < html.length && !/[\t\n\f\r >]/.test(html[j]!)) j++;
							attrVal = decodeEntities(html.slice(vStart, j));
						}
					} else if (html[j] === "/") {
						j++;
					}
					if (attrName) el.setAttribute(attrName, attrVal);
				}
				if (closedAt >= 0) {
					cur().appendChild(el);
					if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(el);
					i = closedAt + 1;
					continue;
				}
			}
		}
		cur().appendChild(doc.createTextNode("<"));
		i++;
	}
}

function withDom<T>(fn: (doc: MiniDocument) => T): T {
	const prevDoc = (globalThis as any).document;
	const prevNF = (globalThis as any).NodeFilter;
	const doc = new MiniDocument();
	(globalThis as any).document = doc;
	(globalThis as any).NodeFilter = { SHOW_TEXT: 4 };
	try {
		return fn(doc);
	} finally {
		if (prevDoc === undefined) delete (globalThis as any).document;
		else (globalThis as any).document = prevDoc;
		if (prevNF === undefined) delete (globalThis as any).NodeFilter;
		else (globalThis as any).NodeFilter = prevNF;
	}
}

function withoutDom<T>(fn: () => T): T {
	const prevDoc = (globalThis as any).document;
	delete (globalThis as any).document;
	try {
		return fn();
	} finally {
		if (prevDoc !== undefined) (globalThis as any).document = prevDoc;
	}
}

/**
 * Simulates browser `DOMPurify.sanitize` HTML5 round-trip serialization on trusted marked output:
 * parses marked HTML into DOM and serializes via HTML5 `innerHTML`, which leaves literal `<`/`>`
 * inside quoted attribute values (`title="<blockquote>..."`, `title="<br><img ...>"`, etc.).
 */
function simulateDomPurifyRoundTrip(rawHtml: string): string {
	const doc = new MiniDocument();
	const tpl = doc.createElement("template") as MiniTemplateElement;
	tpl.innerHTML = rawHtml;
	return tpl.innerHTML;
}

/** Parses HTML with the HTML5 parser and asserts zero live XSS elements or inline event handlers exist. */
function assertNoLiveXss(html: string) {
	const doc = new MiniDocument();
	const tpl = doc.createElement("template") as MiniTemplateElement;
	tpl.innerHTML = html;
	const allEls: MiniElement[] = [];
	const walk = (parent: MiniParent) => {
		for (const child of parent.childNodes) {
			if (child instanceof MiniElement) {
				allEls.push(child);
				walk(child);
			}
		}
	};
	walk(tpl.content);
	expect(allEls.filter((e) => e.tagName === "IMG")).toHaveLength(0);
	expect(allEls.filter((e) => e.tagName === "SVG")).toHaveLength(0);
	expect(allEls.filter((e) => e.tagName === "SCRIPT")).toHaveLength(0);
	for (const el of allEls) {
		for (const attrName of el.attrs.keys()) {
			expect(attrName.startsWith("on")).toBe(false);
		}
	}
	return tpl.content;
}

// ---------------------------------------------------------------------------
// 1. P0 Stored XSS bypass regression tests (markdownHtml.ts)
// ---------------------------------------------------------------------------

describe("Round 4B — P0 Stored XSS fix in callout transformation", () => {
	const XSS_PAYLOADS = [
		{
			name: "link title spoofing a callout blockquote",
			md: '[click](https://example.com "<blockquote><p>[!note] x<br><img src=x onerror=alert(1)></p></blockquote>")',
			expectCallout: false,
		},
		{
			name: "callout title link attribute containing <br><img onerror>",
			md: '> [!note] [x](https://x "<br><img src=x onerror=alert(1)>")',
			expectCallout: true,
		},
		{
			name: "callout title link attribute containing </p><svg onload>",
			md: '> [!note] [x](https://x "</p><svg onload=alert(1)>")',
			expectCallout: true,
		},
		{
			name: "callout title link attribute with newline and angle bracket",
			md: '> [!note] [x](https://x "a>b\\n<img src=x onerror=alert(1)>")\n> Safe body text',
			expectCallout: true,
		},
	];

	for (const payload of XSS_PAYLOADS) {
		for (const breaks of [false, true]) {
			test(`${payload.name} (breaks=${breaks}) emits zero live <img>/<svg>/on* through finishMarkdown & renderCalloutsHtml`, () => {
				const markedHtml = marked.parse(payload.md, { async: false, gfm: true, breaks }) as string;
				// Test BOTH marked's entity-encoded output AND the browser DOMPurify round-trip
				// where `<` and `>` are literal inside `title="..."`.
				for (const candidate of [markedHtml, simulateDomPurifyRoundTrip(markedHtml)]) {
					// 1) finishMarkdown (real DOM path via transformCalloutsDom)
					const finished = withDom(() => finishMarkdown(candidate, { anchors: true }));
					const dom = assertNoLiveXss(finished);
					if (payload.expectCallout) {
						expect(dom.querySelectorAll(".md-callout").length).toBe(1);
						const link = dom.querySelector("a");
						expect(link).not.toBeNull();
						expect(link!.textContent).toBe("x");
					} else {
						expect(dom.querySelectorAll(".md-callout").length).toBe(0);
						const link = dom.querySelector("a");
						expect(link).not.toBeNull();
						expect(link!.textContent).toBe("click");
					}

					// 2) renderCalloutsHtml with DOM available
					const domDirect = withDom(() => renderCalloutsHtml(candidate));
					assertNoLiveXss(domDirect);

					// 3) renderCalloutsHtml in non-DOM / SSR tokenizer fallback
					const ssrDirect = withoutDom(() => renderCalloutsHtml(candidate));
					assertNoLiveXss(ssrDirect);
				}
			});
		}
	}

	test("HTML comments containing spoofed callout markup never produce live elements", () => {
		const raw = '<!-- <blockquote><p>[!note] x<br><img src=x onerror=alert(1)></p></blockquote> --><p>Safe</p>';
		assertNoLiveXss(withDom(() => finishMarkdown(raw)));
		assertNoLiveXss(withoutDom(() => renderCalloutsHtml(raw)));
	});
});

// ---------------------------------------------------------------------------
// 2. Normal callouts, nested callouts, foldables & inline formatting
// ---------------------------------------------------------------------------

describe("Round 4B — Callout DOM & SSR rendering fidelity", () => {
	test("renders nested callouts, collapsible [!note]-, open [!tip]+, and inline formatting in titles accurately", () => {
		const md = [
			"> [!note] **Bold** and `code` title",
			"> Outer body line",
			">",
			"> > [!warning]- Collapsed *inner* title",
			"> > Inner body line",
			"",
			"> [!tip]+ Expanded tip",
			"> Tip body",
			"",
			"> [!caution]",
			"> Default title body",
		].join("\n");

		for (const breaks of [false, true]) {
			const html = marked.parse(md, { async: false, gfm: true, breaks }) as string;

			// DOM path (`finishMarkdown` -> `transformCalloutsDom`)
			const finished = withDom(() => finishMarkdown(html));
			const root = assertNoLiveXss(finished);
			const callouts = root.querySelectorAll(".md-callout");
			expect(callouts.length).toBe(4);
			expect(root.querySelector(".md-callout-title strong")?.textContent).toBe("Bold");
			expect(root.querySelector(".md-callout-title code")?.textContent).toBe("code");
			expect(root.querySelector("details.is-foldable .md-callout-title em")?.textContent).toBe("inner");
			const details = root.querySelectorAll("details");
			expect(details.length).toBe(2);
			expect(details[0]!.getAttribute("open")).toBeNull();
			expect(details[1]!.getAttribute("open")).not.toBeNull();
			expect(finished).toContain("Outer body line");
			expect(finished).toContain("Inner body line");
			expect(finished).toContain("Tip body");
			expect(finished).toContain("Caution");
			expect(finished).toContain("Default title body");

			// Non-DOM SSR path (`renderCalloutsHtml`)
			const ssr = withoutDom(() => renderCalloutsHtml(html));
			const ssrRoot = assertNoLiveXss(ssr);
			expect(ssrRoot.querySelectorAll(".md-callout").length).toBe(4);
			expect(ssrRoot.querySelector(".md-callout-title strong")?.textContent).toBe("Bold");
			expect(ssrRoot.querySelector(".md-callout-title code")?.textContent).toBe("code");
			expect(ssrRoot.querySelector("details.is-foldable .md-callout-title em")?.textContent).toBe("inner");
		}
	});

	test("transformCalloutsDom preserves <pre><code> blockquotes and regular quotes with nested callouts", () => {
		const raw = [
			"<pre><code><blockquote><p>[!note] Literal</p></blockquote></code></pre>",
			"<blockquote><p>Regular quote</p><blockquote><p>[!info] Nested<br>Inside quote</p></blockquote></blockquote>",
		].join("\n");
		const out = withDom((doc) => {
			const tpl = doc.createElement("template") as MiniTemplateElement;
			tpl.innerHTML = raw;
			transformCalloutsDom(tpl.content as unknown as ParentNode);
			return tpl.innerHTML;
		});
		const root = assertNoLiveXss(out);
		expect(root.querySelector("pre code blockquote")).not.toBeNull();
		expect(root.querySelectorAll(".md-callout").length).toBe(1);
		expect(out).toContain("Regular quote");
		expect(out).toContain("Inside quote");
	});
});

// ---------------------------------------------------------------------------
// 3. Math / highlight / tag exclusions & KaTeX recovery
// ---------------------------------------------------------------------------

describe("Round 4B — Math, highlight, tag, form-element exclusions & KaTeX retry", () => {
	test("math nodes ($a == b == c$ and $x #foo$) are never rewritten by renderHighlights or renderTags", () => {
		const input = [
			"<p>Inline math $a == b == c$ and ==prose highlight== plus $x #foo$ and #prose-tag.</p>",
			'<p><span class="katex"><math><annotation>y == z == w #ignored-tag</annotation></math></span></p>',
			"<textarea>==inside textarea==</textarea>",
			"<select><option>==inside option==</option></select>",
		].join("");

		const out = withDom(() => finishMarkdown(input));
		const root = assertNoLiveXss(out);

		// Only the real prose highlight becomes <mark class="md-highlight">
		const marks = root.querySelectorAll("mark");
		expect(marks.map((m) => m.textContent)).toEqual(["prose highlight"]);

		// Only the real prose tag becomes .md-tag
		const tags = root.querySelectorAll(".md-tag");
		expect(tags.map((t) => t.textContent)).toEqual(["#prose-tag"]);

		// Math nodes retain their raw expressions intact
		const mathNodes = root.querySelectorAll(".md-math");
		expect(mathNodes.map((m) => m.dataset.math)).toEqual(["a == b == c", "x #foo"]);
		expect(root.querySelector("annotation")?.textContent).toBe("y == z == w #ignored-tag");
		expect(root.querySelector("textarea")?.textContent).toBe("==inside textarea==");
		expect(root.querySelector("option")?.textContent).toBe("==inside option==");
	});

	test("loadKatex resets katexLoading on failure and renderMath attaches .catch(() => {})", () => {
		const src = readFileSync(resolve(import.meta.dir, "../src/view/editor/markdownHtml.ts"), "utf8");
		expect(src).toMatch(/\.catch\(\(err\)\s*=>\s*\{\s*katexLoading\s*=\s*null;\s*throw err;\s*\}\)/);
		expect(src).toContain("void loadKatex().catch(() => {});");
	});
});

// ---------------------------------------------------------------------------
// 4. Fence scanner hardening against backticks in info strings
// ---------------------------------------------------------------------------

describe("Round 4B — Fence scanners reject backticks in backtick fence info strings", () => {
	test("extractFootnoteDefinition is not swallowed by a line starting with ```inline```", () => {
		const md = [
			"Body referencing[^1].",
			"",
			"```inline``` is an inline code span, not an opening fence.",
			"",
			"[^1]: Footnote after inline triple-backtick span.",
		].join("\n");
		expect(extractFootnoteDefinition(md, "1")).toEqual({
			text: "Footnote after inline triple-backtick span.",
			line: 5,
		});

		// A genuine fenced code block still hides decoy footnotes, while tilde fences allow backticks in info strings.
		const fenced = [
			"~~~md `note`",
			"[^1]: inside tilde fence",
			"~~~",
			"[^1]: real after tilde fence",
		].join("\n");
		expect(extractFootnoteDefinition(fenced, "1")).toEqual({
			text: "real after tilde fence",
			line: 4,
		});
	});

	test("expandTransclusionsMarkdown is not swallowed by a line starting with ```inline```", async () => {
		const loader: TransclusionLoader = async (inner) => {
			if (inner !== "child") return null;
			return { key: "/ws/child.md", docKey: "/ws/child.md", title: "Child Note", path: "/ws/child.md", markdown: "Child body" };
		};
		const md = [
			"```inline``` code span at start of line",
			"",
			"![[child]]",
		].join("\n");
		const out = await expandTransclusionsMarkdown(md, "/ws/root.md", loader);
		expect(out).toContain("> [!note] Child Note");
		expect(out).toContain("> Child body");
	});
});

// ---------------------------------------------------------------------------
// 5. Document Inspector & bridge pure helpers + source invariants
// ---------------------------------------------------------------------------

describe("Round 4B — Markdown bridge pure helpers", () => {
	test("safeDecodeUriComponent decodes valid escapes and falls back cleanly on malformed % sequences", () => {
		expect(safeDecodeUriComponent("My%20Heading%20%231")).toBe("My Heading #1");
		expect(safeDecodeUriComponent("%E0%A4%A")).toBe("%E0%A4%A");
		expect(safeDecodeUriComponent("100%-done")).toBe("100%-done");
	});

	test("resolveSqlSourcePath resolves leading-/, relative, and workspace paths while blocking traversal", () => {
		const root = "/ws/project";
		const doc = "/ws/project/schema/database/USERS.md";

		expect(resolveSqlSourcePath("/schema/database/USERS.sql", doc, root)).toBe("/ws/project/schema/database/USERS.sql");
		expect(resolveSqlSourcePath("///schema/database/USERS.sql", doc, root)).toBe("/ws/project/schema/database/USERS.sql");
		expect(resolveSqlSourcePath("schema/database/USERS.sql", doc, root)).toBe("/ws/project/schema/database/USERS.sql");
		expect(resolveSqlSourcePath("./USERS.sql", doc, root)).toBe("/ws/project/schema/database/USERS.sql");
		expect(resolveSqlSourcePath("../ddl/USERS.sql", doc, root)).toBe("/ws/project/schema/ddl/USERS.sql");
		expect(resolveSqlSourcePath("../../../../etc/passwd.sql", doc, root)).toBe("");
		expect(resolveSqlSourcePath("  ", doc, root)).toBe("");
	});

	test("hasUnclosedFrontMatter detects unclosed --- on line 1, with BOM, and after <!-- template -->", () => {
		expect(hasUnclosedFrontMatter("---\ntitle: Unclosed\nbody")).toBe(true);
		expect(hasUnclosedFrontMatter("\uFEFF---\ntitle: BOM Unclosed\n")).toBe(true);
		expect(hasUnclosedFrontMatter("<!-- template: ticket -->\n---\ntitle: Unclosed after template\n")).toBe(true);
		expect(hasUnclosedFrontMatter("<!-- template: ticket -->\n---\ntitle: Closed\n---\n# Body")).toBe(false);
		expect(hasUnclosedFrontMatter("---\ntitle: Closed with dots\n...\n# Body")).toBe(false);
		expect(hasUnclosedFrontMatter("<!-- template: ticket -->\n# Plain heading")).toBe(false);
		expect(hasUnclosedFrontMatter("# Plain document")).toBe(false);
	});

	test("freshResourceValue rejects loading and mismatched-key stale resource snapshots", () => {
		const snapA = { key: "/ws\0/ws/DocA.md", value: ["backlink-from-A"] };
		expect(freshResourceValue(false, snapA, "/ws\0/ws/DocA.md")).toEqual(["backlink-from-A"]);
		expect(freshResourceValue(true, snapA, "/ws\0/ws/DocA.md")).toBeUndefined();
		expect(freshResourceValue(false, snapA, "/ws\0/ws/DocB.md")).toBeUndefined();
		expect(freshResourceValue(false, snapA, null)).toBeUndefined();
		expect(freshResourceValue(false, undefined, "/ws\0/ws/DocA.md")).toBeUndefined();
	});
});

describe("Round 4B — MarkdownInspector.tsx source-level regression invariants", () => {
	const inspectorSrc = readFileSync(resolve(import.meta.dir, "../src/view/panels/MarkdownInspector.tsx"), "utf8");

	test("inline property <input> is extracted out of any tracked IIFE and reads initial isDate via untrack()", () => {
		expect(inspectorSrc).not.toContain("const ed = editingProp()!;");
		expect(inspectorSrc).toContain("const isDate = untrack(() => Boolean(editingProp()?.isDate));");
		expect(inspectorSrc).toContain("<InlinePropInput propKey={rowProps.fact.key} />");
	});

	test("all four createResource hooks are key-gated via freshResourceValue and unlinkedMentions waits for linked", () => {
		expect(inspectorSrc).toContain("freshResourceValue(allWorkspaceFiles.loading, allWorkspaceFiles(), state.workspace?.root)");
		expect(inspectorSrc).toContain("freshResourceValue(schemaUsages.loading, schemaUsages(), schemaUsageKey())");
		expect(inspectorSrc).toContain("freshResourceValue(linked.loading, linked(), linksResourceKey())");
		expect(inspectorSrc).toContain("freshResourceValue(unlinkedMentions.loading, unlinkedMentions(), key)");
		expect(inspectorSrc).toContain("if (linked.loading || !backlinksRes || backlinksRes.path !== p || backlinksRes.root !== root) return null;");
		expect(inspectorSrc).toContain("setMarkdownLinksSummary(null);");
	});

	test("linkifyUnlinkedMention captures wasDirty BEFORE pushEditOperations and verifies mention ownership", () => {
		const fnMatch = /const linkifyUnlinkedMention = async[\s\S]*?\n\t\};/.exec(inspectorSrc);
		expect(fnMatch).not.toBeNull();
		const fnBody = fnMatch![0];
		const wasDirtyIdx = fnBody.indexOf("const wasDirty = Boolean(state.dirty[key]);");
		const pushEditIdx = fnBody.indexOf("pushEditOperations");
		const saveIdx = fnBody.indexOf("if (!wasDirty) await save(key);");
		expect(wasDirtyIdx).toBeGreaterThan(-1);
		expect(pushEditIdx).toBeGreaterThan(wasDirtyIdx);
		expect(saveIdx).toBeGreaterThan(pushEditIdx);
		expect(fnBody).toContain("computeMinimalTextChange");
		expect(fnBody).toContain("canonical(forPath) !== origPath");
		expect(fnBody).toContain("if (path() !== origPath) return;");
	});

	test("hoverFileButton guards async preview with monotonic hoverSeq across cancel, hide, path switch & cleanup", () => {
		expect(inspectorSrc).toContain("let hoverSeq = 0;");
		expect(inspectorSrc).toContain("const seq = ++hoverSeq;");
		expect(inspectorSrc).toContain("if (seq !== hoverSeq || !preview) return;");
		expect(inspectorSrc).toMatch(/const cancelHover = \(\) => \{\s*hoverSeq\+\+;/);
		expect(inspectorSrc).toMatch(/const scheduleHideHover = \(\) => \{\s*hoverSeq\+\+;/);
	});

	test("async property pickers check origPath and isRead after awaiting user input", () => {
		const scalarMatch = /const editScalarPropertyInteractive = async[\s\S]*?\n\t\};/.exec(inspectorSrc);
		expect(scalarMatch).not.toBeNull();
		expect(scalarMatch![0]).toContain("const origPath = path();");
		expect(scalarMatch![0]).toContain("if (path() !== origPath || isRead()) return;");

		const addMatch = /const addPropertyValueInteractive = async[\s\S]*?\n\t\};/.exec(inspectorSrc);
		expect(addMatch).not.toBeNull();
		expect(addMatch![0]).toContain("const origPath = path();");
		expect(addMatch![0]).toContain("if (!val || path() !== origPath || isRead()) return;");
		expect(addMatch![0]).toContain("hasUnclosedFrontMatter(cur)");
		expect(addMatch![0]).toContain("addToFrontMatterList(cur, key, val)");
	});

	test("zero bare decodeURIComponent calls remain and removePropertyValue delegates to removeFrontMatterKey", () => {
		expect(inspectorSrc).not.toContain("decodeURIComponent(");
		expect(inspectorSrc).toContain("safeDecodeUriComponent(");
		expect(inspectorSrc).toContain("resolveSqlSourcePath(rawSource, p, root)");
		expect(inspectorSrc).toContain("removeFrontMatterKey(cur, key)");
		expect(inspectorSrc).toContain("hasUnclosedFrontMatter(cur)");
	});
});
