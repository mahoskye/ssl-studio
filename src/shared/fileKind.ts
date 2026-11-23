// What a file is, before anything tries to show it: a picture, bytes that
// are not text, or text. A file that is not text is never put in an editor,
// where it would show as lines of nothing readable and could be saved back
// as something else. No DOM and no file system: bytes and names in, words out.

/** The pictures a web view shows, by the end of their name. An SVG is text, and is edited as text. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	ico: "image/x-icon",
	avif: "image/avif",
};

/** The kind of picture a file is by its name ("image/png"), or null when it is not one this can show. */
export function imageType(path: string): string | null {
	const dot = path.lastIndexOf(".");
	return dot < 0 ? null : (IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null);
}

/** As much of a file as is looked at to tell bytes from text. */
export const SNIFF_BYTES = 8000;

/**
 * Whether bytes are not text: a zero byte among the first of them, which no
 * text has. Text in UTF-16 is half zero bytes and says so with the mark it
 * opens with; without the mark it is taken for bytes, as other tools take it.
 */
export function looksBinary(bytes: Uint8Array): boolean {
	const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
	if (utf16) return false;
	const end = Math.min(bytes.length, SNIFF_BYTES);
	// Zero bytes, counted by whether they stand first or second of each pair.
	const zeros = [0, 0];
	for (let at = 0; at < end; at++) if (bytes[at] === 0) zeros[at % 2]!++;
	if (!zeros[0] && !zeros[1]) return false;
	// UTF-16 without its mark: plain letters, each beside a zero byte, the zeros all on one side. It is text, and
	// it opens as it did before bytes were told from text here (its letters with marks between), to be saved back
	// byte for byte.
	const oneSide = (zeros[0] === 0) !== (zeros[1] === 0);
	return !(oneSide && end >= 4 && zeros[0]! + zeros[1]! >= end * 0.4);
}

/** What a file is written in, as it is said to a person. */
export function encodingName(encoding: string): string {
	return ({ "utf-8": "UTF-8", "utf-8-bom": "UTF-8 with BOM", "utf-16le": "UTF-16 LE", "utf-16be": "UTF-16 BE", "windows-1252": "Windows-1252" } as Record<string, string>)[encoding] ?? encoding;
}

/** A size as a person reads it: "340 bytes", "12 KB", "1.4 MB". */
export function sizeText(bytes: number): string {
	if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The line ends a text has: the kind it has most of, as an editor takes a text with both. "\n" for a text with
 * none.
 */
export function lineEnds(text: string): "\n" | "\r\n" {
	let both = 0;
	let all = 0;
	for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
		all++;
		if (text[at - 1] === "\r") both++;
	}
	return both > all / 2 ? "\r\n" : "\n";
}

/** Line ends as they are named: the two a file can have here. */
export const eolName = (eol: string) => (eol === "\r\n" ? "CRLF" : "LF");
