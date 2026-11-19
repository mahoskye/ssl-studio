// Whether a JSON document can be read, and where it stops being readable.
// JSON.parse says that it failed; where, and in what words, differs from one
// engine to the next, and the system's webview is not the same on every
// machine. This reads the text itself and says the first thing wrong with it.

export type JsonProblem = { /** Where in the text, from 0. */ offset: number; /** How many characters are wrong; at least 1. */ length: number; message: string };

/** The first thing that keeps the text from being JSON; null when it is JSON. An empty document is not a problem: it is not written yet. */
export function jsonProblem(text: string): JsonProblem | null {
	let i = 0;
	const n = text.length;
	class Wrong extends Error {
		constructor(
			public offset: number,
			public length: number,
			message: string,
		) {
			super(message);
		}
	}
	const fail = (message: string, at = i, length = 1): never => {
		throw new Wrong(Math.min(at, Math.max(0, n - 1)), Math.max(1, length), message);
	};
	const space = () => {
		while (i < n && " \t\r\n".includes(text[i]!)) i++;
		if (text.startsWith("//", i) || text.startsWith("/*", i)) fail("JSON has no comments.", i, 2);
	};
	const word = () => {
		const start = i;
		while (i < n && /[A-Za-z0-9_$.+-]/.test(text[i]!)) i++;
		return text.slice(start, i);
	};
	const string = () => {
		const start = i++;
		while (i < n) {
			const c = text[i]!;
			if (c === '"') return void i++;
			if (c === "\n" || c === "\r") fail("This string is not closed before the line ends.", start, i - start);
			if (c === "\\") {
				const next = text[i + 1] ?? "";
				if (next === "u") {
					if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("\\u is followed by four hexadecimal digits.", i, 2);
					i += 6;
					continue;
				}
				if (!'"\\/bfnrt'.includes(next) || !next) fail(`\\${next} is not an escape JSON knows.`, i, 2);
				i += 2;
				continue;
			}
			if (c < " ") fail("A tab or another control character inside a string is written as an escape, such as \\t.", i);
			i++;
		}
		fail("This string is never closed.", start, n - start);
	};
	const value = (): void => {
		space();
		if (i >= n) fail("A value is missing here.", n - 1);
		const c = text[i]!;
		if (c === "{") {
			const open = i++;
			space();
			if (text[i] === "}") return void i++;
			for (;;) {
				space();
				if (i >= n) fail("This { is never closed.", open);
				if (text[i] === "}") fail("A comma is followed by another name, not by }.", i);
				if (text[i] === "'") fail("A name is written in double quotes.", i);
				if (text[i] !== '"') fail("A name in double quotes is expected here.", i, Math.max(1, word().length));
				string();
				space();
				if (text[i] !== ":") fail("A colon is expected after the name.");
				i++;
				value();
				space();
				if (text[i] === ",") {
					i++;
					continue;
				}
				if (text[i] === "}") return void i++;
				if (i >= n) fail("This { is never closed.", open);
				fail("A comma or } is expected here.");
			}
		}
		if (c === "[") {
			const open = i++;
			space();
			if (text[i] === "]") return void i++;
			for (;;) {
				space();
				if (text[i] === "]") fail("A comma is followed by another value, not by ].", i);
				value();
				space();
				if (text[i] === ",") {
					i++;
					continue;
				}
				if (text[i] === "]") return void i++;
				if (i >= n) fail("This [ is never closed.", open);
				fail("A comma or ] is expected here.");
			}
		}
		if (c === '"') return string();
		if (c === "'") fail("A string is written in double quotes.");
		const start = i;
		const got = word();
		if (!got) fail(`${c} cannot start a value.`);
		if (got === "true" || got === "false" || got === "null") return;
		if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(got)) return;
		fail(/^[-+.\d]/.test(got) ? `${got} is not a number as JSON writes one.` : `${got} is not a value: a string is in double quotes, and the only bare words are true, false and null.`, start, got.length);
	};
	try {
		space();
		if (i >= n) return null;
		value();
		space();
		if (i < n) fail("The document ends here: there is more after its one value.", i, Math.min(n - i, 20));
		return null;
	} catch (e) {
		if (e instanceof Wrong) return { offset: e.offset, length: e.length, message: e.message };
		throw e;
	}
}
