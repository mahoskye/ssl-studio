import { describe, expect, test } from "bun:test";
import { HEADING_SIZES, headingStep, liveMarks, LONGEST_LEXED, LONGEST_LINE, type LiveMark } from "../src/shared/markdownLive";

/** A text's marks as "kind line:start-end what", `what` being the characters marked. */
const said = (text: string) => {
	const lines = text.split(/\r?\n/);
	return liveMarks(text).map((m: LiveMark) => `${m.kind} ${m.line}:${m.start}-${m.end} ${JSON.stringify(lines[m.line - 1]!.slice(m.start - 1, m.end - 1))}${m.href === undefined ? "" : ` -> ${m.href}`}`);
};
const kinds = (text: string) => liveMarks(text).map((m) => m.kind);
/** A text as it is seen on lines the cursor is not on: the markup taken out. */
const seen = (text: string) => {
	const marks = liveMarks(text);
	return text
		.split(/\r?\n/)
		.map((line, at) => {
			const hidden = new Set<number>();
			for (const m of marks) if (m.kind === "syntax" && m.line === at + 1) for (let c = m.start; c < m.end; c++) hidden.add(c);
			return [...line].filter((_, i) => !hidden.has(i + 1)).join("");
		})
		.join("\n");
};

describe("a heading", () => {
	test("is its whole line, with the #s and the space after them as markup", () => {
		expect(said("## What is asked")).toEqual(['h2 1:1-17 "## What is asked"', 'syntax 1:1-4 "## "']);
	});

	test("has six levels, and a seventh # makes a paragraph", () => {
		expect(kinds("# a")[0]).toBe("h1");
		expect(kinds("###### a")[0]).toBe("h6");
		expect(kinds("####### a")).toEqual([]);
	});

	test("needs the space: a tag is not a heading", () => {
		expect(kinds("#tag")).toEqual([]);
	});

	test("closing #s are markup too, and what is inside is still read", () => {
		expect(seen("# The **plan** #")).toBe("The plan");
		expect(kinds("# The **plan** #")).toEqual(["h1", "syntax", "syntax", "strong", "syntax", "syntax"]);
		// A # that no space sets off is part of the words.
		expect(seen("# C#")).toBe("C#");
	});

	test("with no words it keeps its #s: they are all there is of it", () => {
		expect(seen("## ")).toBe("## ");
		expect(seen("#")).toBe("#");
	});
});

describe("words in a line", () => {
	test("strong, emphasised and struck words each have their marks on both sides", () => {
		expect(said("a **b** c")).toEqual(['syntax 1:3-5 "**"', 'strong 1:5-6 "b"', 'syntax 1:6-8 "**"']);
		expect(said("a *b* c")).toEqual(['syntax 1:3-4 "*"', 'em 1:4-5 "b"', 'syntax 1:5-6 "*"']);
		expect(said("a ~~b~~ c")).toEqual(['syntax 1:3-5 "~~"', 'strike 1:5-6 "b"', 'syntax 1:6-8 "~~"']);
		expect(seen("a __b__ and _c_")).toBe("a b and c");
	});

	test("one inside the other is both", () => {
		expect(said("**a *b* c**")).toEqual(['syntax 1:1-3 "**"', 'strong 1:3-10 "a *b* c"', 'syntax 1:5-6 "*"', 'em 1:6-7 "b"', 'syntax 1:7-8 "*"', 'syntax 1:10-12 "**"']);
		expect(seen("*a **b** c*")).toBe("a b c");
		expect(seen("***both***")).toBe("both");
		expect(kinds("***both***").filter((k) => k !== "syntax").sort()).toEqual(["em", "strong"]);
	});

	test("a star with a space after it, or with nothing to close it, is a star", () => {
		expect(kinds("2 * 3 * 4")).toEqual([]);
		expect(kinds("a *b c")).toEqual([]);
		expect(kinds("a ** b ** c")).toEqual([]);
	});

	test("stars are paired as the renderer pairs them, the nearest opener first", () => {
		// The first star opens nothing that closes: the words between the last two are the emphasised ones.
		expect(seen("Use *.ssl files and *all* of them")).toBe("Use *.ssl files and all of them");
		// A run after a space cannot close, and one before a letter after a bracket cannot either.
		expect(seen("call f(*args, **kwargs) and g(**opts)")).toBe("call f(*args, **kwargs) and g(**opts)");
	});

	test("an underscore inside a word is a letter", () => {
		expect(kinds("the snake_case_name stays")).toEqual([]);
		expect(seen("nDays_left and _this_")).toBe("nDays_left and this");
		// At a word's edge they are markup, as the renderer has it too: such a name is written as code.
		expect(seen("__init__.py is a file")).toBe("init.py is a file");
		expect(seen("`__init__.py` is a file")).toBe("__init__.py is a file");
	});

	test("code is not looked into, and a backslash keeps a mark a character", () => {
		expect(said("use `a * b * c` here")).toEqual(['syntax 1:5-6 "`"', 'code 1:6-15 "a * b * c"', 'syntax 1:15-16 "`"']);
		expect(kinds("\\*not\\* this")).toEqual([]);
		expect(said("``a ` b``")).toEqual(['syntax 1:1-3 "``"', 'code 1:3-8 "a ` b"', 'syntax 1:8-10 "``"']);
		// Ticks of another length do not close it.
		expect(kinds("`a `` b")).toEqual([]);
	});

	test("an address written out is not looked into", () => {
		expect(seen("see https://example.test/org/repo/blob/main/pkg/__init__.py now")).toBe("see https://example.test/org/repo/blob/main/pkg/__init__.py now");
		expect(seen("at www.example.test/a*b*c and *so* on")).toBe("at www.example.test/a*b*c and so on");
		expect(seen("<https://example.test/a_b_c> and a <span title=\"*x*\">tag</span>")).toBe("<https://example.test/a_b_c> and a <span title=\"*x*\">tag</span>");
	});
});

describe("a link", () => {
	test("is its words, with where it leads; the brackets and the address are markup", () => {
		expect(said("see [the spec](docs/specs/a.md) now")).toEqual(['syntax 1:5-6 "["', 'link 1:6-14 "the spec" -> docs/specs/a.md', 'syntax 1:14-32 "](docs/specs/a.md)"']);
	});

	test("a picture is a link with its ! as markup", () => {
		expect(said("![chart](c.png)")).toEqual(['syntax 1:1-3 "!["', 'link 1:3-8 "chart" -> c.png', 'syntax 1:8-16 "](c.png)"']);
	});

	test("between two pairs of brackets it leads to what is named, and shows the words after the bar", () => {
		expect(said("[[DEMO-103]]")).toEqual(['syntax 1:1-3 "[["', 'link 1:3-11 "DEMO-103" -> DEMO-103', 'syntax 1:11-13 "]]"']);
		expect(said("[[DEMO-103|the report]]")).toEqual(['syntax 1:1-12 "[[DEMO-103|"', 'link 1:12-22 "the report" -> DEMO-103', 'syntax 1:22-24 "]]"']);
	});

	test("with no words to show it stays as written: a picture with no description is still there", () => {
		expect(seen("text ![](docs/img/shot.png) more")).toBe("text ![](docs/img/shot.png) more");
		expect(seen("[](x) and [[a|]]")).toBe("[](x) and [[a|]]");
	});

	test("round brackets inside the address are part of it, and its characters are not read as markup", () => {
		expect(seen("[wiki](https://example.test/wiki/Foo_(bar)) after")).toBe("wiki after");
		expect(seen("[a](x_y_z) and [b](p*q*r)")).toBe("a and b");
	});

	test("brackets with no address are brackets", () => {
		expect(kinds("an array [1, 2] and a[0]")).toEqual([]);
	});
});

describe("lists, quotes and rules", () => {
	test("a bullet or a number is marked, and what follows is read", () => {
		expect(said("- a **b**")).toEqual(['bullet 1:1-2 "-"', 'syntax 1:5-7 "**"', 'strong 1:7-8 "b"', 'syntax 1:8-10 "**"']);
		expect(said("  12. twelve")).toEqual(['bullet 1:3-6 "12."']);
	});

	test("a task has its box, and a ticked one has its words marked as done", () => {
		expect(said("- [ ] to do")).toEqual(['bullet 1:1-2 "-"', 'box 1:3-6 "[ ]"']);
		expect(said("- [x] did it")).toEqual(['bullet 1:1-2 "-"', 'box 1:3-6 "[x]"', 'done 1:6-13 " did it"']);
	});

	test("a quote is its whole line, the > as markup", () => {
		expect(said("> said *so*")).toEqual(['quote 1:1-12 "> said *so*"', 'syntax 1:1-3 "> "', 'syntax 1:8-9 "*"', 'em 1:9-11 "so"', 'syntax 1:11-12 "*"']);
		// A quote with nothing in it keeps its mark.
		expect(seen(">")).toBe(">");
	});

	test("a rule is a rule, not a bullet or emphasis", () => {
		expect(kinds("---")).toEqual(["rule"]);
		expect(kinds("* * *")).toEqual(["rule"]);
	});
});

describe("code, wherever it stands, is left as written", () => {
	test("a block of code, fences and all, with nothing inside it read", () => {
		expect(said("```ssl\n:IF a * b * c;\n```\n*after*")).toEqual(['codeblock 1:1-7 "```ssl"', 'codeblock 2:1-15 ":IF a * b * c;"', 'codeblock 3:1-4 "```"', 'syntax 4:1-2 "*"', 'em 4:2-7 "after"', 'syntax 4:7-8 "*"']);
	});

	test("a block of code left open runs to the end", () => {
		expect(kinds("~~~\n# not a heading")).toEqual(["codeblock", "codeblock"]);
	});

	test("a fence under a bullet, set in as far as it likes", () => {
		const text = "1. step\n\n    ```ssl\n    n := a*b*c;\n    ```\n\nthen *this*";
		expect(seen(text)).toBe("1. step\n\n    ```ssl\n    n := a*b*c;\n    ```\n\nthen this");
		expect(kinds(text).filter((k) => k === "codeblock").length).toBe(3);
	});

	test("a fence inside a quote", () => {
		expect(seen("> ```ssl\n> nA := nB*nC*nD;\n> ```")).toBe("> ```ssl\n> nA := nB*nC*nD;\n> ```");
	});

	test("code set in from the edge after a blank line", () => {
		expect(seen("words\n\n    indented *code* with __init__\n\nwords *again*")).toBe("words\n\n    indented *code* with __init__\n\nwords again");
		// Under a bullet a line set in is the bullet's own.
		expect(seen("- a\n\n    more of *a*")).toBe("- a\n\n    more of a");
	});

	test("ticks with more text after them on the line are code within the line, not a fence", () => {
		expect(seen("```inline``` then *this*\nand *that*")).toBe("inline then this\nand that");
	});

	test("a block of HTML", () => {
		expect(seen("<pre>\na*b*c\n\nd_e_f\n</pre>\n*after*")).toBe("<pre>\na*b*c\n\nd_e_f\n</pre>\nafter");
		expect(seen("<div>\na *b* c\n\n*after*")).toBe("<div>\na *b* c\n\nafter");
	});
});

describe("what else is left as written", () => {
	test("the lines a document opens with to say things of itself", () => {
		expect(said("---\nstatus: open\n---\n# Title")).toEqual(['front 1:1-4 "---"', 'front 2:1-13 "status: open"', 'front 3:1-4 "---"', 'h1 4:1-8 "# Title"', 'syntax 4:1-3 "# "']);
		// With nothing to close them they are a rule and a paragraph.
		expect(kinds("---\nstatus: open")).toEqual(["rule"]);
	});

	test("a table's rows keep their columns, and each cell is read by itself", () => {
		expect(said("| a | **b** |\n| --- | --- |").slice(0, 4)).toEqual(['table 1:1-14 "| a | **b** |"', 'syntax 1:7-9 "**"', 'strong 1:9-10 "b"', 'syntax 1:10-12 "**"']);
		expect(seen("| a*b | c*d |\n| --- | --- |\n| e*f | g*h |")).toBe("| a*b | c*d |\n| --- | --- |\n| e*f | g*h |");
		// With no bar at the row's start it is a table all the same, as the renderer has it.
		expect(seen("n*m | rows*cols\n--- | ---\n1*2 | 3*4")).toBe("n*m | rows*cols\n--- | ---\n1*2 | 3*4");
		// And inside a quote or under a bullet.
		expect(seen("> | a*b | c*d |\n> | --- | --- |")).toBe("| a*b | c*d |\n| --- | --- |");
		// One line with bars and no line of dashes under it is a paragraph, here as on the page.
		expect(seen("| a*b | c*d |")).toBe("| ab | cd |");
	});

	test("a comment, or a tag, on the line above does not swallow what follows", () => {
		const text = "<!-- keep -->\n```js\nconst a = b*c*d\n\nconst e = _f_\n```\n<!-- end -->\n\n## Next *one*\n\nprose *here*";
		expect(seen(text)).toBe("<!-- keep -->\n```js\nconst a = b*c*d\n\nconst e = _f_\n```\n<!-- end -->\n\nNext one\n\nprose here");
		expect(kinds(text).filter((k) => k === "codeblock").length).toBe(4);
		expect(seen("<a name=\"install\"></a>\n## Install *it*")).toBe("<a name=\"install\"></a>\nInstall it");
	});

	test("code set in from the edge under a heading or a rule, with no blank line between", () => {
		expect(seen("## Example\n    n := a*b*c;")).toBe("Example\n    n := a*b*c;");
		expect(seen("---\n    n := a*b*c;")).toBe("---\n    n := a*b*c;");
	});

	test("code set in under a bullet's words, and after a list has ended", () => {
		expect(seen("- step one\n\n        n := a*b*c;")).toBe("- step one\n\n        n := a*b*c;");
		expect(seen("- a\n\n<!-- end -->\n\n    code *x*")).toBe("- a\n\n<!-- end -->\n\n    code *x*");
	});

	test("a heading said by the line under it", () => {
		expect(said("Title *one*\n=====")).toEqual(['h1 1:1-12 "Title *one*"', 'syntax 1:7-8 "*"', 'em 1:8-11 "one"', 'syntax 1:11-12 "*"', 'rule 2:1-6 "====="']);
	});

	test("round brackets after square ones are a link's only when an address could stand in them", () => {
		expect(seen("handlers[name](event, data) and [sic](as written)")).toBe("handlers[name](event, data) and [sic](as written)");
		expect(seen("[a](x.md \"a title\") and [b](<a b.md>)")).toBe("a and b");
	});

	test("lines that end with a carriage return are read the same", () => {
		expect(said("# a\r\n**b**")).toEqual(['h1 1:1-4 "# a"', 'syntax 1:1-3 "# "', 'syntax 2:1-3 "**"', 'strong 2:3-4 "b"', 'syntax 2:4-6 "**"']);
	});

	test("a line of nothing but markup stays in sight", () => {
		for (const only of ["**", "****", "` `", "> ", "[[ ]]", "~~~~"]) expect(seen(only)).toBe(only);
	});
});

describe("whatever the text", () => {
	const texts = [
		"",
		"*",
		"**",
		"[",
		"[[",
		"`",
		"\\",
		"![",
		"- [",
		"#",
		"> ",
		"[a](",
		"[[a|",
		"# **a** #",
		"> - [x] **a** _b_ `c` [d](e) [[f|g]]",
		"| *a* | [b](c) | `d` |",
		"***a** b* ~~c~~ __d__ _e_",
		"a\\*b* [x\\](y) `z",
		"```\n*a*\n```\n\n    b_c_d\n\n<pre>\n*e*\n</pre>\n*f*",
	];

	test("every mark is inside its line, in order, and markup never overlaps markup", () => {
		for (const text of texts) {
			const lines = text.split(/\r?\n/);
			const marks = liveMarks(text);
			for (const mark of marks) {
				expect(mark.start).toBeGreaterThanOrEqual(1);
				expect(mark.end).toBeGreaterThan(mark.start);
				expect(mark.end).toBeLessThanOrEqual(lines[mark.line - 1]!.length + 1);
			}
			const syntax = marks.filter((mark) => mark.kind === "syntax");
			for (const a of syntax) for (const b of syntax) if (a !== b && a.line === b.line) expect(a.end <= b.start || b.end <= a.start).toBe(true);
		}
	});

	test("no line that has something to see is left with nothing to see", () => {
		for (const text of texts) {
			const before = text.split(/\r?\n/);
			const after = seen(text).split("\n");
			before.forEach((line, at) => expect(Boolean(after[at]!.trim())).toBe(Boolean(line.trim())));
		}
	});

	test("a very long line is drawn plain, and one full of marks that open nothing does not hold things up", () => {
		expect(kinds(`${"*a* ".repeat(LONGEST_LINE / 4 + 1)}`)).toEqual([]);
		const started = performance.now();
		for (const piece of [" *a", " **a", " _a", "~~a ", "[[a ", "[a "]) liveMarks(piece.repeat(Math.floor(LONGEST_LINE / piece.length) - 1));
		liveMarks(`# a${" ".repeat(200_000)}`);
		liveMarks(Array.from({ length: 20_000 }, (_, i) => `line ${i} with **strong** and *em* and \`code\``).join("\n"));
		expect(performance.now() - started).toBeLessThan(2000);
	});
});

describe("the renderer's reading of the blocks", () => {
	test("is kept when a link is written by name: the line that says where it leads is not one of the renderer's pieces", () => {
		const text = "See the [spec].\n\n    nTotal := nA*nB*nC;\n\n[spec]: docs/specs/a.md\n\nand *more*";
		expect(seen(text)).toBe("See the [spec].\n\n    nTotal := nA*nB*nC;\n\n[spec]: docs/specs/a.md\n\nand more");
	});

	test("is kept when lines start with tabs, which the renderer counts as four spaces", () => {
		expect(seen("\tn := a*b*c;")).toBe("\tn := a*b*c;");
		const text = "```\n\tn := 1;\n\t\tm := 2;\n```\n\n    run *.ssl __all__\n\nthen *this*";
		expect(seen(text)).toBe("```\n\tn := 1;\n\t\tm := 2;\n```\n\n    run *.ssl __all__\n\nthen this");
	});

	test("lays each block on its own lines, whatever stands between them", () => {
		const text = "[a]: x\n[b]: y\n\n\ta*b*c\n\n[c]: z\n# Title *one*\n\n    d*e*f\n";
		expect(seen(text)).toBe("[a]: x\n[b]: y\n\n\ta*b*c\n\n[c]: z\nTitle one\n\n    d*e*f\n");
	});
});

describe("a text too long to ask the renderer about", () => {
	test("is read by this file's own rules, and a fence is still code", () => {
		const filler = "words and more words\n".repeat(Math.ceil(LONGEST_LEXED / 21) + 1);
		const text = `${filler}\n\`\`\`\nn := a*b*c;\n\`\`\`\n\nthen *this*`;
		expect(text.length).toBeGreaterThan(LONGEST_LEXED);
		const lines = seen(text).split("\n");
		expect(lines.slice(-5)).toEqual(["```", "n := a*b*c;", "```", "", "then this"]);
	});
});

describe("the size a heading is drawn at", () => {
	test("is its own step when the line has room for it", () => {
		expect(HEADING_SIZES[headingStep(1, 3)]).toBe(1.8);
		expect(HEADING_SIZES[headingStep(2, 3)]).toBe(1.5);
		expect(HEADING_SIZES[headingStep(4, 1.1)]).toBe(1.1);
	});

	test("comes down a step at a time until it fits, and never below the text's own size", () => {
		expect(HEADING_SIZES[headingStep(1, 1.6)]).toBe(1.5);
		expect(HEADING_SIZES[headingStep(1, 1.2)]).toBe(1.1);
		expect(HEADING_SIZES[headingStep(1, 0.4)]).toBe(1);
		// A line that already wraps at the text's size has no room at all.
		expect(HEADING_SIZES[headingStep(2, 0)]).toBe(1);
	});

	test("a fifth and a sixth heading are the text's size, and a level out of range is taken as the nearest", () => {
		expect(HEADING_SIZES[headingStep(5, 9)]).toBe(1);
		expect(HEADING_SIZES[headingStep(6, 9)]).toBe(1);
		expect(HEADING_SIZES[headingStep(0, 9)]).toBe(1.8);
		expect(HEADING_SIZES[headingStep(9, 9)]).toBe(1);
	});
});
