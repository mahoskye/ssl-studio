import { jsonProblem } from "./jsonCheck";

// A JSON document laid out afresh: one value to a line, indented by its
// depth. Every string and number is written exactly as it was: nothing is
// parsed into a number and printed again, so a long number, an escape or a
// key written twice comes out as it went in. Only the space between things
// changes.

/** The document laid out afresh; null when it is not JSON, and is left as it is. */
export function formatJson(text: string, indent = "\t"): string | null {
	if (!text.trim() || jsonProblem(text)) return null;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	let out = "";
	let depth = 0;
	const line = () => `${eol}${indent.repeat(depth)}`;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j;
		} else if (c === "{" || c === "[") {
			// An empty object or list stays on its line.
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j]!)) j++;
			if (text[j] === (c === "{" ? "}" : "]")) {
				out += c + text[j];
				i = j;
			} else {
				depth++;
				out += c + line();
			}
		} else if (c === "}" || c === "]") {
			depth = Math.max(0, depth - 1);
			out += line() + c;
		} else if (c === ",") out += c + line();
		else if (c === ":") out += ": ";
		else if (!/\s/.test(c)) out += c;
	}
	return `${out}${eol}`;
}
