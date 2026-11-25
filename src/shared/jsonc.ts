/** JSON with comments and trailing commas, as VS Code theme files are. */
export function parseJsonc(raw: string): any {
	const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
	let out = "";
	let i = 0;
	// Skips whitespace and comments from `j`; returns the next significant index.
	const skip = (j: number) => {
		while (j < text.length) {
			if (/\s/.test(text[j]!)) j++;
			else if (text.startsWith("//", j)) {
				while (j < text.length && text[j] !== "\n") j++;
			} else if (text.startsWith("/*", j)) {
				const end = text.indexOf("*/", j + 2);
				if (end < 0) throw new SyntaxError("Unterminated block comment");
				j = end + 2;
			} else break;
		}
		return j;
	};
	while (i < text.length) {
		const c = text[i]!;
		if (c === '"') {
			const start = i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
			out += text.slice(start, ++i);
		} else if (text.startsWith("//", i)) {
			while (i < text.length && text[i] !== "\n") i++;
			if (i < text.length) i++;
			out += "\n";
		} else if (text.startsWith("/*", i)) {
			const end = text.indexOf("*/", i + 2);
			if (end < 0) throw new SyntaxError("Unterminated block comment");
			out += " ";
			i = end + 2;
		} else if (c === ",") {
			const next = text[skip(i + 1)];
			if (next === "}" || next === "]") {
				i++;
			} else {
				out += c;
				i++;
			}
		} else {
			out += c;
			i++;
		}
	}
	return JSON.parse(out);
}
