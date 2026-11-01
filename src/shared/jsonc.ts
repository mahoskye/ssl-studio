/** JSON with comments and trailing commas, as VS Code theme files are. */
export function parseJsonc(text: string): any {
	let out = "";
	let i = 0;
	// Skips whitespace and comments from `j`; returns the next significant index.
	const skip = (j: number) => {
		while (j < text.length) {
			if (/\s/.test(text[j]!)) j++;
			else if (text.startsWith("//", j)) while (j < text.length && text[j] !== "\n") j++;
			else if (text.startsWith("/*", j)) {
				const end = text.indexOf("*/", j + 2);
				j = end < 0 ? text.length : end + 2;
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
		} else if (text.startsWith("//", i) || text.startsWith("/*", i)) {
			i = skip(i);
		} else if (c === "," && "}]".includes(text[skip(i + 1)] ?? "")) {
			i++;
		} else {
			out += c;
			i++;
		}
	}
	return JSON.parse(out);
}
