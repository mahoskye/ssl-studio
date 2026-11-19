// A file is bytes, and which characters they are is the file's own business:
// UTF-8 with or without a mark at its start, UTF-16 either way round, or the
// one-byte Windows encoding that older tools on Windows write. A file is read
// as what it is and written back as what it was, so that an edit changes the
// characters edited and nothing else.

export type Encoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "windows-1252";

/** What the bytes are written in: by the mark they open with; failing a mark, UTF-8 where they read as it, else Windows-1252. */
export function encodingOf(bytes: Uint8Array): Encoding {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8-bom";
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return "utf-8";
	} catch {
		return "windows-1252";
	}
}

/** The bytes as text, and what they were written in. The mark that says which is not part of the text. */
export function decode(bytes: Uint8Array): { text: string; encoding: Encoding } {
	const encoding = encodingOf(bytes);
	if (encoding === "utf-8") return { text: Buffer.from(bytes).toString("utf8"), encoding };
	if (encoding === "utf-8-bom") return { text: Buffer.from(bytes.subarray(3)).toString("utf8"), encoding };
	if (encoding === "windows-1252") return { text: new TextDecoder("windows-1252").decode(bytes), encoding };
	const body = Buffer.from(bytes.subarray(2));
	// Two bytes to a character: one left over is a file cut short, or not text at all.
	if (body.length % 2) throw new Error("It opens as UTF-16 and has a byte left over: it is cut short, or it is not text.");
	return { text: (encoding === "utf-16be" ? body.swap16() : body).toString("utf16le"), encoding };
}

/** Each character of the one-byte Windows encoding, by the byte that writes it. */
let oneByte: Map<string, number> | undefined;
function byteOf(ch: string): number | undefined {
	if (!oneByte) {
		const reader = new TextDecoder("windows-1252");
		oneByte = new Map(Array.from({ length: 256 }, (_, byte) => [reader.decode(new Uint8Array([byte])), byte] as const));
	}
	return oneByte.get(ch);
}

/** The text as bytes in that encoding, its mark first where it has one. Throws where the encoding cannot write a character of the text. */
export function encode(text: string, encoding: Encoding): Uint8Array {
	if (encoding === "utf-8") return Buffer.from(text, "utf8");
	if (encoding === "utf-8-bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
	if (encoding === "utf-16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
	if (encoding === "utf-16be") return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
	const bytes = new Uint8Array(text.length);
	for (let at = 0; at < text.length; at++) {
		const byte = byteOf(text[at]!);
		// Written as UTF-8 instead, every other character of the file would change for whatever reads it next.
		if (byte === undefined) throw new Error(`It is saved in Windows-1252, which has no way to write “${String.fromCodePoint(text.codePointAt(at)!)}”. Take that character out, or save the file as UTF-8 from another editor first.`);
		bytes[at] = byte;
	}
	return bytes;
}
