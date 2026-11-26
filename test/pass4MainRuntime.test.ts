// Pass 4, "already on main", P10: the packaged app runs on the Bun that Electrobun bundles (1.4.4) and the tests
// ran on another (1.3.3). The two read TOML with different readers, which throw different things: the older one
// an error with its place, the newer one a sentence and no place. What the IDE said of a mistake in project.toml
// was made from the older one's error, so the app that ships marked the file's last line under the reader's own
// words. These tests hold what is said to the text alone, and they pass on both runtimes: where the two readers
// do not agree on what TOML is, the test says so and is skipped on the one it cannot be true on.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProject, tomlProblem } from "../src/bun/project";

/**
 * Whether this is the reader the app ships with. Bun 1.3.3's takes for TOML a good deal that is not (a value with
 * no quotes, a line that is no key, a table started twice, a value on the line after its key) and refuses dates;
 * the one in 1.4.4 does neither.
 */
const SHIPPED_READER = Bun.semver.order(Bun.version, "1.4.0") >= 0;

const ONE_TO_A_LINE = "A key is followed by = and a value, one to a line.";
const NO_VALUE = "The value is missing: it comes after the =, on the same line.";
const NOT_CLOSED = "This string is not closed.";
const OPEN_LIST = "The [ on this line is not closed with ], or something inside it does not read.";
const BAD_VALUE = "This value does not read: a number or a date has a fixed form, and any other text goes in quotes.";
const NO_KEY = "A line starts with a key: a name, then = and its value.";
const LONG = " The file is long: the mistake is on this line or further down.";

/** What is said of each text, as `line:column message`: one line to compare, so a failure names the text. */
const said = (texts: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(texts).map(([name, text]) => {
			const problem = tomlProblem(text);
			return [name, problem ? `${problem.line}:${problem.column} ${problem.message}` : "reads"];
		}),
	);

/** Runs with a reader that is not the runtime's in its place, and puts the runtime's back. */
function withReader<T>(reader: (text: string, real: (text: string) => unknown) => unknown, run: () => T): T {
	const real = Bun.TOML.parse;
	(Bun.TOML as { parse: unknown }).parse = (text: string) => reader(text, (given) => real.call(Bun.TOML, given));
	try {
		return run();
	} finally {
		(Bun.TOML as { parse: unknown }).parse = real;
	}
}

describe("a mistake in a TOML document, on the runtime that ships and on the one before it", () => {
	test("each kind a person makes is said in plain words, on its own line, though more lines follow it", () => {
		expect(
			said({
				"no value": "a = 1\nb = \nc = 3\n",
				"no value, on the last line": "a = 1\nb = \n",
				"no value, with Windows line ends": "a = 1\r\nb = \r\nc = 3\r\n",
				"no value, on an indented line": "a = 1\n\tb = \nc = 3\n",
				"a string not closed": 'a = 1\nb = "unclosed\nc = 3\n',
				"a string in single quotes not closed": "a = 1\nb = 'unclosed\nc = 3\n",
				"a string that goes on, indented, on the next line": 'a = 1\nb = "first\n  second"\nc = 3\n',
				"a string of several lines never closed": 'a = 1\nb = """\ntext\nc = 3\n',
				"a list not closed": "a = 1\nb = [1, 2\nc = 3\n",
				"a list of several lines not closed": 'a = 1\nb = [\n  "x",\n  "y"\nc = 3\n',
				"a list of several lines with no comma between two of its values": 'a = 1\nb = [\n  "x"\n  "y",\n]\nc = 3\n',
				"a table in braces not closed": "a = 1\nb = { x = 1\nc = 3\n",
				"a key set twice": "a = 1\nb = 2\na = 3\nc = 4\n",
				"a key set twice in its table": "[t]\na = 1\nb = 2\na = 3\nc = 4\n",
				"two values on a line": "a = 1\nb = 1 2\nc = 3\n",
				"something after the value": "a = 1\nb = 2 ;\nc = 3\n",
				"a date that cannot be": "a = 1\nb = 2024-13-45\nc = 3\n",
				"a number with two points": "a = 1\nb = 1.2.3\nc = 3\n",
				"a number with letters after it": "a = 1\nb = 12abc\nc = 3\n",
				"a number with a comma for its point": "a = 1\nb = 1,5\nc = 3\n",
				"a key with no = after it": "a = 1\nb 2\nc = 3\n",
				"a line that starts with =": "a = 1\n= 2\nc = 3\n",
			}),
		).toEqual({
			"no value": `2:5 ${NO_VALUE}`,
			"no value, on the last line": `2:5 ${NO_VALUE}`,
			"no value, with Windows line ends": `2:5 ${NO_VALUE}`,
			"no value, on an indented line": `2:6 ${NO_VALUE}`,
			"a string not closed": `2:14 ${NOT_CLOSED}`,
			"a string in single quotes not closed": `2:14 ${NOT_CLOSED}`,
			"a string that goes on, indented, on the next line": `2:11 ${NOT_CLOSED}`,
			"a string of several lines never closed": `2:8 ${NOT_CLOSED}`,
			"a list not closed": `2:10 ${OPEN_LIST}`,
			"a list of several lines not closed": `2:6 ${OPEN_LIST}`,
			"a list of several lines with no comma between two of its values": `2:6 ${OPEN_LIST}`,
			"a table in braces not closed": "2:12 The { on this line is not closed with }.",
			"a key set twice": "3:1 a is set twice.",
			"a key set twice in its table": "4:1 a is set twice.",
			"two values on a line": `2:7 ${ONE_TO_A_LINE}`,
			"something after the value": `2:7 ${ONE_TO_A_LINE}`,
			"a date that cannot be": `2:9 ${BAD_VALUE}`,
			"a number with two points": `2:8 ${BAD_VALUE}`,
			"a number with letters after it": `2:7 ${BAD_VALUE}`,
			"a number with a comma for its point": `2:6 ${BAD_VALUE}`,
			"a key with no = after it": `2:1 ${ONE_TO_A_LINE}`,
			"a line that starts with =": `2:1 ${NO_KEY}`,
		});
	});

	// Only on the reader that ships: the older one takes every one of these texts for TOML, or reads on past the
	// mistake to a later line (the next test), so there is nothing the same to say of them on it.
	test.skipIf(!SHIPPED_READER)("what only the reader that ships refuses is said as plainly (Bun 1.4 and later)", () => {
		expect(
			said({
				"no value, a table after it": '[project]\nname = \n\n[folders]\ndocs = "docs"\n',
				"no value, a comment after the =": "a = 1\nb = # later\nc = 3\n",
				"a value with no quotes": '[style]\npreset = house\n\n[folders]\ndocs = "docs"\n',
				"True for true": "a = 1\nb = True\nc = 3\n",
				"a table's name not closed": "a = 1\n[x\nb = 2\n",
				"a table's name not closed, on the last line": "a = 1\n[x",
				"a table-in-a-list's name not closed": "a = 1\n[[x]\nb = 2\n",
				"a list not closed, a table after it": 'a = 1\nb = ["x", "y"\n[t]\nc = 3\n',
				"a list of several lines with a value that is no value": 'a = 1\nb = [\n  "x",\n  y,\n]\nc = 3\n',
				"a stray character": "a = 1\n?\nc = 3\n",
				"a stray line of words": "a = 1\njust some words\nc = 3\n",
				"a colon for the =": 'a = 1\nb: "x"\nc = 3\n',
				"two keys on a line": "a = 1\nb = 1 c = 2\nd = 3\n",
				"a table started twice": "[x]\na = 1\n[y]\nb = 1\n[x]\nc = 1\n",
				"a key that is then a table": "[x]\na = 1\n[x.a]\nb = 1\n",
				"a key set twice, the second time to a list of several lines": 'folders = ["a"]\nfolders = [\n  "b",\n]\n',
				"a backslash that starts no code": 'a = 1\nb = "work\\docs"\nc = 3\n',
				"a Windows path in double quotes": 'a = 1\nb = "C:\\Users\\me"\nc = 3\n',
				"a number that starts with a nought": "a = 1\nb = 01\nc = 3\n",
				"a time that cannot be": "a = 1\nb = 2024-02-20T25:00:00\nc = 3\n",
			}),
		).toEqual({
			"no value, a table after it": `2:8 ${NO_VALUE}`,
			"no value, a comment after the =": `2:1 ${NO_VALUE}`,
			"a value with no quotes": '2:1 "house" does not read as a value: text goes in quotes.',
			"True for true": '2:1 "True" does not read as a value: text goes in quotes.',
			"a table's name not closed": `2:3 ${OPEN_LIST}`,
			"a table's name not closed, on the last line": `2:3 ${OPEN_LIST}`,
			"a table-in-a-list's name not closed": `2:5 ${OPEN_LIST}`,
			"a list not closed, a table after it": `2:14 ${OPEN_LIST}`,
			"a list of several lines with a value that is no value": `2:6 ${OPEN_LIST}`,
			"a stray character": `2:1 ${NO_KEY}`,
			"a stray line of words": `2:1 ${ONE_TO_A_LINE}`,
			"a colon for the =": `2:1 ${ONE_TO_A_LINE}`,
			"two keys on a line": `2:7 ${ONE_TO_A_LINE}`,
			"a table started twice": "5:1 The table x is started twice.",
			"a key that is then a table": "3:1 a is set twice.",
			"a key set twice, the second time to a list of several lines": "2:1 folders is set twice.",
			"a backslash that starts no code": "2:1 A backslash in a string in double quotes starts a code. Write it twice, or put the string in single quotes.",
			"a Windows path in double quotes": "2:1 A backslash in a string in double quotes starts a code. Write it twice, or put the string in single quotes.",
			"a number that starts with a nought": `2:6 ${BAD_VALUE}`,
			"a time that cannot be": `2:15 ${BAD_VALUE}`,
		});
		// Words with no plain form here are not passed off as one: a plain sentence, then the reader's own.
		expect(tomlProblem("a = 1\nb = [1 2]\nc = 3\n")).toEqual({ message: "This line does not read as TOML (the reader says: Expected ',' or ']' in an array but found '2').", line: 2, column: 1 });
	});

	// Only on the older reader: a record of why a run on it says nothing of what the app does with these files.
	test.skipIf(SHIPPED_READER)("the reader before it takes several mistakes for TOML, so nothing is marked there (Bun 1.3 only)", () => {
		expect(
			said({
				"no value, a table after it": '[project]\nname = \n\n[folders]\ndocs = "docs"\n',
				"a value with no quotes": '[style]\npreset = house\n\n[folders]\ndocs = "docs"\n',
				"a stray character": "a = 1\n?\nc = 3\n",
				"a table started twice": "[x]\na = 1\n[y]\nb = 1\n[x]\nc = 1\n",
				"a backslash that starts no code": 'a = 1\nb = "work\\docs"\nc = 3\n',
				// It reads a table's name with no ] when the text ends there, so the line after is the first it refuses.
				"a table's name not closed": "a = 1\n[x\nb = 2\n",
			}),
		).toEqual({
			"no value, a table after it": "reads",
			"a value with no quotes": "reads",
			"a stray character": "reads",
			"a table started twice": "reads",
			"a backslash that starts no code": "reads",
			"a table's name not closed": "3:1 close bracket was expected here, not b.",
		});
		// And it refuses what is right: a date.
		expect(tomlProblem("due = 2026-01-15\n")).not.toBeNull();
	});

	test("what is right is not marked, plain or unusual", () => {
		const right: Record<string, string> = {
			"as the template writes it": '# note\n\n[project]\nname = "Due dates"\ndescription = "Sets due dates. A demo."\n\n[folders]\ndocs = "docs"      # notes\ncode = "src"\n\n[agent]\n# model = "ollama/qwen3:14b"\n\n[style]\npreset = "house"\n',
			"Windows line ends": '[project]\r\nname = "P"\r\n[folders]\r\ndocs = "notes"\r\n',
			"no line end at the end": '[project]\nname = "P"',
			"strings in single quotes, with backslashes": "[folders]\ndocs = 'my docs'\ncode = 'C:\\work\\src'\n",
			"a string of several lines": '[project]\ndescription = """\nFirst line.\nSecond line.\n"""\n',
			"a string of several lines in single quotes": "[project]\ndescription = '''\nFirst 'line'.\n'''\n",
			"keys with points and keys in quotes": 'project.name = "P"\n"folders".docs = "d"\n',
			"tables in braces": 'project = { name = "P", description = "D" }\n',
			"a table under one not yet started": '[agent.limits]\nturns = 3\n[agent]\nmodel = "ollama/x"\n',
			"tables in a list": '[[agent.models]]\nid = "a"\n[[agent.models]]\nid = "b"\n',
			"a list of several lines, with comments and a comma after the last": 'tags = [\n  "one", # first\n  "two",\n]\n',
			"lists in a list": 'a = [[1, 2], ["x"], []]\n',
			"numbers and true and false": "a = 1_000\nb = 0x1F\nc = -1.5e3\nd = true\ne = false\n",
			"comments alone": "# nothing here yet\n",
			"tables with nothing in them": "[project]\n[folders]\n",
		};
		// Dates are TOML, and the older reader refuses them: it marked a right document (ADR 0018), which the reader
		// that ships does not.
		if (SHIPPED_READER) right["dates and times"] = "d = 2024-02-20\ne = 2024-02-20T10:30:00Z\nf = 10:30:00\n";
		expect(said(right)).toEqual(Object.fromEntries(Object.keys(right).map((name) => [name, "reads"])));
	});
});

describe("where a TOML mistake is, found from the text and not from what the reader throws", () => {
	/** A reader that takes any text without an exclamation mark, and throws what it is given for one with. */
	const refusing = (thrown: () => unknown) => (text: string) => {
		if (text.includes("!")) throw thrown();
		return {};
	};
	const text = "a = 1\nb = 2\n!\nc = 3\nd = 4\n";

	test("a place the error carries is not taken for the mistake's: not its line, and not a position", () => {
		// As the runtime that ships throws: a SyntaxError whose `line` is a line of the program that called the reader.
		// It was read as the mistake's, and held to the text's length, so the mark was on the last line.
		const withLine = () => Object.assign(new SyntaxError("TOML Parse error: Frobnication is not allowed here"), { line: 2031, column: 18 });
		expect(withReader(refusing(withLine), () => tomlProblem(text))).toEqual({ message: "This line does not read as TOML (the reader says: Frobnication is not allowed here).", line: 3, column: 1 });
		// As the one before it throws, were its place wrong: it is not asked for.
		const withPosition = () => Object.assign(new Error("Frobnication"), { position: { line: 5, column: 9 } });
		expect(withReader(refusing(withPosition), () => tomlProblem(text))).toMatchObject({ line: 3, column: 1 });
		const many = () => new AggregateError([Object.assign(new Error("Cannot redefine key 'b'"), { position: { line: 1, column: 1 } }), new Error("and more")], "Failed to parse toml");
		expect(withReader(refusing(many), () => tomlProblem(text))).toEqual({ message: "b is set twice.", line: 3, column: 1 });
	});

	test("words never seen before get a plain sentence with the reader's after it, and no words get the sentence", () => {
		const of = (thrown: unknown) => withReader(refusing(() => thrown), () => tomlProblem(text));
		expect(of(new Error("E4012 unexpected token kind 7"))).toEqual({ message: "This line does not read as TOML (the reader says: E4012 unexpected token kind 7).", line: 3, column: 1 });
		expect(of("a bare string")).toEqual({ message: "This line does not read as TOML (the reader says: a bare string).", line: 3, column: 1 });
		for (const nothing of [null, undefined, {}, new Error(""), { message: 7 }, 404]) expect(of(nothing)).toEqual({ message: "This line does not read as TOML.", line: 3, column: 1 });
	});

	test("a list or a string of several lines above the mistake is not taken for it", () => {
		// Halving the text lands in the middle of the list, where no beginning of the text reads: the mistake is
		// looked for past it all the same.
		expect(tomlProblem('x = 1\na = [\n  1,\n  2,\n  3,\n]\nc = \n')).toEqual({ message: NO_VALUE, line: 7, column: 5 });
		expect(tomlProblem('x = 1\nabout = """\none\ntwo\nthree\nfour\n"""\n\n# a comment\nc = 1 2\nd = 1\n')).toEqual({ message: ONE_TO_A_LINE, line: 10, column: 7 });
		// Wherever it is in a file of lists, tables and comments, it is the line that is marked, and no other.
		const lines: string[] = [];
		for (let i = 1; lines.length < 160; i++) {
			if (i % 7 === 0) lines.push(`list_${i} = [`, '  "one",', '  "two", # the second', "]");
			else if (i % 11 === 0) lines.push("", `[table_${i}]`, "# what follows is this table's");
			else if (i % 13 === 0) lines.push(`long_${i} = """`, "a line", "another = line", '"""');
			else lines.push(`key_${i} = "value ${i}"`);
		}
		const mistakes = lines.map((line, at) => (/^key_/.test(line) ? at : -1)).filter((at) => at >= 0);
		expect(mistakes.length).toBeGreaterThan(60);
		for (const at of mistakes.filter((_, nth) => nth % 6 === 0)) {
			const broken = [...lines.slice(0, at), lines[at]!.replace(/".*"$/, '"not closed'), ...lines.slice(at + 1)].join("\n") + "\n";
			expect(tomlProblem(broken)).toMatchObject({ message: NOT_CLOSED, line: at + 1 });
		}
	});

	test("the reader is asked a bounded number of times, and past that the line is said to be the best one known", () => {
		const file = (count: number, mistake: number) => Array.from({ length: count }, (_, at) => (at + 1 === mistake ? `key_${at + 1} = ` : `key_${at + 1} = "value number ${at + 1} of the file"`)).join("\n") + "\n";
		const asked = (text: string) => {
			let times = 0;
			let handed = 0;
			const problem = withReader(
				(given, real) => {
					times += 1;
					handed += given.length;
					return real(given);
				},
				() => tomlProblem(text),
			);
			return { problem, times, handed };
		};
		// A file that reads is read once.
		expect(asked(file(300, 0))).toMatchObject({ problem: null, times: 1 });
		// Three hundred lines, the mistake in the middle: every beginning after it is asked about, and no more than that.
		const mid = asked(file(300, 150));
		expect(mid.problem).toEqual({ message: NO_VALUE, line: 150, column: 11 });
		expect(mid.times).toBeLessThan(300);
		// Three thousand: the line is found by halving, the rest cannot all be asked about, and the message says so.
		const long = asked(file(3000, 1500));
		expect(long.problem).toMatchObject({ line: 1500, column: 1 });
		expect(long.problem!.message.endsWith(LONG)).toBe(true);
		expect(long.times).toBeLessThan(300);
		expect(long.handed).toBeLessThan(10_000_000);
		// The words before that are the reader's, put plainly; on the reader that ships they are those of the mistake.
		if (SHIPPED_READER) expect(long.problem!.message).toBe(NO_VALUE + LONG);
		// Past half a million characters the text is read once and no more: no place is known, so the mark is at the
		// top and the message says why.
		const vast = asked(file(13000, 6500));
		expect(vast.handed).toBeGreaterThan(500_000);
		expect(vast.times).toBe(1);
		expect(vast.problem).toMatchObject({ line: 1, column: 1 });
		expect(vast.problem!.message.endsWith(" The file is too long for the place to be looked for.")).toBe(true);
	});
});

describe("a project.toml that does not read", () => {
	const made: string[] = [];
	const project = (text: string | Buffer) => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-runtime-"));
		made.push(root);
		mkdirSync(join(root, ".ssl-studio"));
		writeFileSync(join(root, ".ssl-studio", "project.toml"), text);
		return readProject(root);
	};
	afterAll(() => {
		for (const root of made) rmSync(root, { recursive: true, force: true });
	});

	test("is told as the editor tells it, with its line, and the defaults apply", async () => {
		// The Docs panel shows this after "project.toml could not be read, so the defaults apply:". It was the
		// reader's own sentence: "Unterminated basic string (single-line)" on one runtime, "TOML Parse error:
		// Unterminated string; newlines must be escaped in basic strings" on the other.
		const broken = await project('[project]\nname = "Due dates\n\n[folders]\ndocs = "notes"\n');
		expect(broken).toMatchObject({ configured: true, docs: "docs", error: "line 2: This string is not closed." });
		expect((await project('[project]\nname = "P"\nname = "Q"\n')).error).toBe("line 3: name is set twice.");
		expect((await project('[project]\nname = "P"\n[folders]\ndocs = "notes"\n')).error).toBeUndefined();
	});

	// What the stricter reader means for a project: these files loaded on Bun 1.3 (two of them wrongly, without a
	// word) and are refused whole by the app that ships. Refused, they must at least be told plainly.
	test.skipIf(!SHIPPED_READER)("what the reader that ships refuses is refused whole, and told (Bun 1.4 and later)", async () => {
		const bare = await project('[project]\nname = "P"\n\n[style]\npreset = house\n');
		expect(bare).toMatchObject({ error: 'line 5: "house" does not read as a value: text goes in quotes.' });
		expect(bare.stylePreset).toBeUndefined();
		expect(bare.name).not.toBe("P");
		expect((await project('[project]\nname = \n\n[folders]\ndocs = "notes"\n')).error).toBe(`line 2: ${NO_VALUE}`);
		expect((await project('[folders]\ndocs = "work\\docs"\n')).error).toBe("line 2: A backslash in a string in double quotes starts a code. Write it twice, or put the string in single quotes.");
		expect((await project('[project]\nname = "P"\n[folders]\ndocs = "notes"\n[project]\ndescription = "D"\n')).error).toBe("line 5: The table project is started twice.");
	});

	test("a file saved with a byte order mark is read like any other", async () => {
		// The mark never reaches the TOML reader: Bun.file's text() drops it. The older reader, handed one, returns an
		// empty document and no error, so a project saved by an editor that writes the mark would lose its settings.
		expect(await project(Buffer.from('\uFEFF[project]\nname = "Marked"\n[folders]\ndocs = "notes"\n'))).toMatchObject({ name: "Marked", docs: "notes" });
	});
});
