import { describe, expect, test } from "bun:test";
import {
	blockquoteEnter,
	buildCalloutBlock,
	documentHeadings,
	findHeadingLine,
	insertLinkEdit,
	parseCalloutHeader,
	parseImageExpression,
	pasteUrlOverSelection,
	serializeCalloutBlock,
	smartListBackspace,
	smartListIndent,
	toggleCheckboxLine,
	toggleInlineWrap,
	withImageWidth,
} from "../src/shared/markdownEdit";

const apply = (text: string, edit: ReturnType<typeof toggleInlineWrap>) => ({
	text: text.slice(0, edit.changeFrom) + edit.insert + text.slice(edit.changeTo),
	sel: [edit.selFrom, edit.selTo] as [number, number],
});

describe("Obsidian inline wrap toggling", () => {
	test("wraps and unwraps selected text cleanly for bold, italic, code, strike, highlight", () => {
		const wrapped = apply("hello world", toggleInlineWrap("hello world", 6, 11, "**"));
		expect(wrapped).toEqual({ text: "hello **world**", sel: [8, 13] });
		const unwrapped = apply(wrapped.text, toggleInlineWrap(wrapped.text, 8, 13, "**"));
		expect(unwrapped).toEqual({ text: "hello world", sel: [6, 11] });
		// Unwraps when markers themselves are included in the selection.
		const unwrappedIncl = apply(wrapped.text, toggleInlineWrap(wrapped.text, 6, 15, "**"));
		expect(unwrappedIncl).toEqual({ text: "hello world", sel: [6, 11] });
		// Highlight ==text== and inline `code`.
		expect(apply("key fact", toggleInlineWrap("key fact", 0, 8, "==")).text).toBe("==key fact==");
		expect(apply("run foo", toggleInlineWrap("run foo", 4, 7, "`")).text).toBe("run `foo`");
	});

	test("keeps outer spaces outside markers", () => {
		expect(apply("hello world ", toggleInlineWrap("hello world ", 5, 12, "**"))).toEqual({
			text: "hello **world** ",
			sel: [8, 13],
		});
	});

	test("toggles the word under a collapsed cursor, or inserts empty markers on blank space", () => {
		const boldWord = apply("hello world", toggleInlineWrap("hello world", 8, 8, "**"));
		expect(boldWord).toEqual({ text: "hello **world**", sel: [10, 10] });
		const unboldWord = apply(boldWord.text, toggleInlineWrap(boldWord.text, 10, 10, "**"));
		expect(unboldWord).toEqual({ text: "hello world", sel: [8, 8] });
		expect(apply("hello ", toggleInlineWrap("hello ", 6, 6, "**"))).toEqual({ text: "hello ****", sel: [8, 8] });
	});

	test("italic * inside bold **word** wraps as ***word*** instead of breaking bold", () => {
		const res = apply("**word**", toggleInlineWrap("**word**", 2, 6, "*"));
		expect(res.text).toBe("***word***");
	});
});

describe("Obsidian checkbox cycling (Ctrl+L)", () => {
	test("cycles plain text -> unchecked -> checked -> unchecked and converts bullets", () => {
		expect(toggleCheckboxLine("Write spec")).toBe("- [ ] Write spec");
		expect(toggleCheckboxLine("  Indented")).toBe("  - [ ] Indented");
		expect(toggleCheckboxLine("- Bullet item")).toBe("- [ ] Bullet item");
		expect(toggleCheckboxLine("* Star item")).toBe("* [ ] Star item");
		expect(toggleCheckboxLine("- [ ] Task")).toBe("- [x] Task");
		expect(toggleCheckboxLine("- [x] Task")).toBe("- [ ] Task");
		expect(toggleCheckboxLine("> - [ ] Quoted task")).toBe("> - [x] Quoted task");
	});
});

describe("Links and smart URL paste", () => {
	test("insertLinkEdit handles selected text, selected URL, and empty cursor", () => {
		expect(apply("see spec", insertLinkEdit("see spec", 4, 8))).toEqual({ text: "see [spec]()", sel: [11, 11] });
		expect(apply("https://example.com", insertLinkEdit("https://example.com", 0, 19))).toEqual({
			text: "[](https://example.com)",
			sel: [1, 1],
		});
		expect(apply("go ", insertLinkEdit("go ", 3, 3))).toEqual({ text: "go []()", sel: [4, 4] });
	});

	test("pasteUrlOverSelection wraps selected prose with pasted URL", () => {
		expect(pasteUrlOverSelection("the spec", "https://example.com/spec")).toBe("[the spec](https://example.com/spec)");
		expect(pasteUrlOverSelection("", "https://example.com")).toBeNull();
		expect(pasteUrlOverSelection("the spec", "not a url")).toBeNull();
		expect(pasteUrlOverSelection("https://old.test", "https://new.test")).toBeNull();
	});
});

describe("Smart list indent and Backspace", () => {
	test("indents and outdents list lines from anywhere on the line", () => {
		expect(smartListIndent("- item", "indent")).toEqual({ text: "  - item", delta: 2 });
		expect(smartListIndent("  - item", "outdent")).toEqual({ text: "- item", delta: -2 });
		expect(smartListIndent("- item", "outdent")).toEqual({ text: "- item", delta: 0 });
		expect(smartListIndent("plain prose", "indent")).toBeNull();
	});

	test("smart Backspace strips task, bullet, heading, and quote prefixes cleanly", () => {
		expect(smartListBackspace("- [ ] task", 6)).toEqual({ from: 2, to: 6 });
		expect(smartListBackspace("- item", 2)).toEqual({ from: 0, to: 2 });
		expect(smartListBackspace("  - item", 4)).toEqual({ from: 2, to: 4 });
		expect(smartListBackspace("## Heading", 3)).toEqual({ from: 0, to: 3 });
		expect(smartListBackspace("> Quote", 2)).toEqual({ from: 0, to: 2 });
		expect(smartListBackspace("- item", 5)).toBeNull();
	});
});

describe("Headings & Callouts", () => {
	test("extracts headings outside frontmatter and fenced code blocks with unique anchors", () => {
		const doc = ["---", "title: Demo", "---", "# Top", "", "```md", "# Not a heading", "```", "", "## Details", "## Details"].join("\n");
		expect(documentHeadings(doc)).toEqual([
			{ level: 1, text: "Top", anchor: "top", line: 4 },
			{ level: 2, text: "Details", anchor: "details", line: 10 },
			{ level: 2, text: "Details", anchor: "details-1", line: 11 },
		]);
		expect(findHeadingLine(doc, "details-1")).toBe(11);
		expect(findHeadingLine(doc, "Top")).toBe(4);
	});

	test("parses Obsidian/GitHub callout headers including no-space >[!important], custom titles, and fold flags", () => {
		expect(parseCalloutHeader("> [!NOTE]")).toMatchObject({ title: "Note", fold: null, spec: { tone: "info" } });
		expect(parseCalloutHeader(">[!important]")).toMatchObject({ title: "Important", fold: null, spec: { tone: "accent" } });
		expect(parseCalloutHeader(">[!important] Action required")).toMatchObject({ title: "Action required", fold: null, spec: { tone: "accent" } });
		expect(parseCalloutHeader("> [!WARNING]- Watch out")).toMatchObject({ title: "Watch out", fold: "-", spec: { tone: "warning" } });
		expect(parseCalloutHeader("> [!TIP]+ Quick hint")).toMatchObject({ title: "Quick hint", fold: "+", spec: { tone: "ok" } });
		expect(parseCalloutHeader("> plain blockquote")).toBeNull();
	});

	test("builds callout blocks and continues/exits callouts cleanly on Enter", () => {
		expect(buildCalloutBlock("important", "Key deadline")).toEqual({
			insert: "> [!important] Key deadline\n> ",
			cursorOffset: "> [!important] Key deadline\n> ".length,
		});
		expect(buildCalloutBlock("warning", "", "Line one\nLine two").insert).toBe("> [!warning]\n> Line one\n> Line two");
		expect(blockquoteEnter(">[!important] Title", 19)).toEqual({ start: "> " });
		expect(blockquoteEnter("> body line", 11)).toEqual({ start: "> " });
		expect(blockquoteEnter("> ", 2)).toEqual({ keep: 0 });
		expect(blockquoteEnter("plain line", 5)).toBeNull();

		// Interactive callout serialization (type, custom/default title, fold flag, multiline body).
		expect(serializeCalloutBlock("important", "Important", null, "First line\n\n- [ ] Check")).toBe(
			"> [!important]\n> First line\n>\n> - [ ] Check",
		);
		expect(serializeCalloutBlock("warning", "Pre-flight check", "+", "Confirm backups.")).toBe(
			"> [!warning]+ Pre-flight check\n> Confirm backups.",
		);
		expect(serializeCalloutBlock("tip", "Tip", "-", "")).toBe("> [!tip]-");
		expect(serializeCalloutBlock("tip", "Tip", null, "", true)).toBe("> [!tip]\n> ");
		// Trims trailing blank lines on blur/close while keeping internal paragraph breaks intact.
		expect(serializeCalloutBlock("note", "Note", null, "Para 1\n\nPara 2\n\n")).toBe("> [!note]\n> Para 1\n>\n> Para 2");
		expect(serializeCalloutBlock("note", "Note", null, "Para 1\n", true)).toBe("> [!note]\n> Para 1\n>");
	});

	test("parses and resizes Markdown and Obsidian image expressions", () => {
		expect(parseImageExpression("![Flow diagram|420](assets/flow.png)")).toEqual({
			src: "assets/flow.png",
			alt: "Flow diagram",
			width: 420,
			height: undefined,
			kind: "md",
		});
		expect(parseImageExpression("![[shot.png|Sample grid|320x200]]")).toEqual({
			src: "shot.png",
			alt: "Sample grid",
			width: 320,
			height: 200,
			kind: "wiki",
		});
		expect(parseImageExpression("![[diagram.png|500]]")).toEqual({
			src: "diagram.png",
			alt: "",
			width: 500,
			height: undefined,
			kind: "wiki",
		});
		expect(withImageWidth("![Flow diagram](assets/flow.png)", 320)).toBe("![Flow diagram|320](assets/flow.png)");
		expect(withImageWidth("![Flow diagram|320](assets/flow.png)", null)).toBe("![Flow diagram](assets/flow.png)");
		expect(withImageWidth("![[shot.png|Caption|520]]", 320)).toBe("![[shot.png|Caption|320]]");
		expect(withImageWidth("![[shot.png|Caption|520]]", null)).toBe("![[shot.png|Caption]]");
	});
});
