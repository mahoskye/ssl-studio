// Which files a search looks in, said the way people say it in an editor:
// "*.ssl", "src", "tests/**", "*.md, *.txt", "docs/{specs,tickets}". A list
// of patterns, with commas between; a file is among them when any one
// pattern is it. No file system: a path from the workspace's folder in,
// yes or no out.
//
// A pattern with no slash names a file or a folder wherever it is: "*.ssl"
// is every SSL file, "Legacy" is everything in any folder called Legacy. A
// pattern with a slash is read from the workspace's folder: "src/DueDates"
// is that folder and all that is in it. "*" is anything but a slash, "**"
// anything at all, "?" one character, "{a,b}" either. Case is not told apart.

/** The patterns of a list: split at the commas that are not inside braces, blanks dropped. */
export function patternsOf(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let now = "";
	for (const ch of list) {
		if (ch === "{") depth++;
		else if (ch === "}") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			out.push(now);
			now = "";
		} else now += ch;
	}
	out.push(now);
	return out.map((pattern) => pattern.trim()).filter(Boolean);
}

/** Collapses consecutive stars and repeated `**\/` runs to avoid exponential regex backtracking. */
function collapseGlobs(pattern: string): string {
	let out = pattern.replace(/\*{3,}/g, "**");
	let prev = "";
	while (out !== prev) {
		prev = out;
		out = out.replace(/(?:\*\*\/)+(?=\*\*)/g, "");
		out = out.replace(/\/\*\*\/\*\*(?=\/|$)/g, "/**");
	}
	return out;
}

/** One pattern as an expression for a whole path, or for one part of a path. */
function expression(rawPattern: string): string {
	const pattern = collapseGlobs(rawPattern);
	let out = "";
	for (let at = 0; at < pattern.length; at++) {
		const ch = pattern[at]!;
		if (ch === "*" && pattern[at + 1] === "*") {
			// "**/" is any run of folders, none included; "**" alone is anything.
			if (pattern[at + 2] === "/") {
				out += "(?:.*/)?";
				at += 2;
			} else {
				out += ".*";
				at += 1;
			}
		} else if (ch === "*") out += "[^/]*";
		else if (ch === "?") out += "[^/]";
		else if (ch === "{") {
			let depth = 1;
			let end = -1;
			const parts: string[] = [];
			let partStart = at + 1;
			for (let j = at + 1; j < pattern.length; j++) {
				const cj = pattern[j]!;
				if (cj === "{") depth++;
				else if (cj === "}") {
					depth--;
					if (depth === 0) {
						parts.push(pattern.slice(partStart, j));
						end = j;
						break;
					}
				} else if (cj === "," && depth === 1) {
					parts.push(pattern.slice(partStart, j));
					partStart = j + 1;
				}
			}
			if (end < 0) out += "\\{";
			else {
				out += `(?:${parts.map((part) => expression(part.trim())).join("|")})`;
				at = end;
			}
		} else out += ch.replace(/[.+^$()|[\]\\}]/, "\\$&");
	}
	return out;
}

/**
 * Says whether a file is among the patterns of a list. `path` is the file's
 * path from the workspace's folder, with either kind of slash. An empty list
 * names no file: whether that means "every file" or "no file" is the
 * caller's to say.
 */
export function globMatcher(list: string): (path: string) => boolean {
	const tests = patternsOf(list)
		.map((raw) => {
			const pattern = raw.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
			if (!pattern) return null;
			if (!pattern.includes("/")) {
				// A name: any part of the path may be it, the file's own name or a folder above it.
				const part = new RegExp(`^${expression(pattern)}$`, "i");
				return (path: string) => path.split("/").some((each) => part.test(each));
			}
			// A path: from the workspace's folder, itself or anything in it.
			const anchored = pattern.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
			if (!anchored) return null;
			const whole = new RegExp(`^${expression(anchored)}(?:/.*)?$`, "i");
			return (path: string) => whole.test(path);
		})
		.filter((fn): fn is (path: string) => boolean => fn !== null);
	return (path) => {
		const plain = path.replace(/\\/g, "/").replace(/^\/+/, "");
		return tests.some((test) => test(plain));
	};
}

/**
 * Precompiles an include/exclude file filter once so multi-file scans do not
 * reparse patterns or recompile regular expressions on every file.
 */
export function createFileFilter(include = "", exclude = ""): (path: string) => boolean {
	const includeMatch = patternsOf(include).length ? globMatcher(include) : null;
	const excludeMatch = patternsOf(exclude).length ? globMatcher(exclude) : null;
	if (!includeMatch && !excludeMatch) return () => true;
	return (path: string) => {
		if (includeMatch && !includeMatch(path)) return false;
		if (excludeMatch && excludeMatch(path)) return false;
		return true;
	};
}

/** Whether a search looks in a file: among the included when any are named, and not among the excluded. */
export function fileChosen(path: string, include = "", exclude = ""): boolean {
	return createFileFilter(include, exclude)(path);
}
