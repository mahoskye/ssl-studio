import { describe, expect, test } from "bun:test";
import { encodingName, eolName, imageType, lineEnds, looksBinary, sizeText, SNIFF_BYTES } from "../src/shared/fileKind";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("a picture by its name", () => {
	test("the kinds a web view shows", () => {
		expect(imageType("/w/picture.png")).toBe("image/png");
		expect(imageType("Photo.JPG")).toBe("image/jpeg");
		expect(imageType("a.jpeg")).toBe("image/jpeg");
		expect(imageType("a.gif")).toBe("image/gif");
		expect(imageType("a.webp")).toBe("image/webp");
		expect(imageType("a.bmp")).toBe("image/bmp");
		expect(imageType("favicon.ico")).toBe("image/x-icon");
	});

	test("an SVG is text, and so is everything else", () => {
		expect(imageType("drawing.svg")).toBeNull();
		expect(imageType("DueRules.ssl")).toBeNull();
		expect(imageType("png")).toBeNull();
		expect(imageType("notes.png.md")).toBeNull();
	});
});

describe("bytes that are not text", () => {
	test("a zero byte says so", () => {
		expect(looksBinary(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d))).toBe(true);
		expect(looksBinary(bytes(0x41, 0, 0x42))).toBe(true);
	});

	test("text has none, in UTF-8 or in a one-byte encoding", () => {
		expect(looksBinary(text(":PROCEDURE Übung;\r\n"))).toBe(false);
		expect(looksBinary(bytes(0x63, 0x61, 0x66, 0xe9))).toBe(false);
		expect(looksBinary(bytes())).toBe(false);
	});

	test("UTF-16 with its mark is text, though half of it is zero bytes", () => {
		expect(looksBinary(bytes(0xff, 0xfe, 0x41, 0x00, 0x42, 0x00))).toBe(false);
		expect(looksBinary(bytes(0xfe, 0xff, 0x00, 0x41, 0x00, 0x42))).toBe(false);
	});

	test("UTF-16 without its mark is still text: letters, each beside a zero byte, the zeros all on one side", () => {
		expect(looksBinary(new Uint8Array(Buffer.from("SELECT 1 FROM x", "utf16le")))).toBe(false);
		expect(looksBinary(new Uint8Array(Buffer.from("SELECT 1 FROM x", "utf16le").swap16()))).toBe(false);
		// Zero bytes on both sides, or only a few of them, are bytes.
		expect(looksBinary(bytes(0x41, 0x00, 0x00, 0x42, 0x43, 0x00))).toBe(true);
		expect(looksBinary(new Uint8Array([...text("a long line of plain text with one "), 0, ...text("zero byte in it")]))).toBe(true);
		expect(looksBinary(bytes(0x41, 0x00))).toBe(true);
	});

	test("only the start is looked at", () => {
		const long = new Uint8Array(SNIFF_BYTES + 10).fill(0x41);
		long[SNIFF_BYTES + 5] = 0;
		expect(looksBinary(long)).toBe(false);
		long[SNIFF_BYTES - 1] = 0;
		expect(looksBinary(long)).toBe(true);
	});
});

describe("what a file is, in words", () => {
	test("what it is written in", () => {
		expect(encodingName("utf-8")).toBe("UTF-8");
		expect(encodingName("utf-8-bom")).toBe("UTF-8 with BOM");
		expect(encodingName("utf-16le")).toBe("UTF-16 LE");
		expect(encodingName("utf-16be")).toBe("UTF-16 BE");
		expect(encodingName("windows-1252")).toBe("Windows-1252");
		expect(encodingName("something-else")).toBe("something-else");
	});

	test("how large it is", () => {
		expect(sizeText(0)).toBe("0 bytes");
		expect(sizeText(1)).toBe("1 byte");
		expect(sizeText(1023)).toBe("1023 bytes");
		expect(sizeText(1024)).toBe("1 KB");
		expect(sizeText(12 * 1024 + 400)).toBe("12 KB");
		expect(sizeText(1024 * 1024)).toBe("1.0 MB");
		expect(sizeText(1.44 * 1024 * 1024)).toBe("1.4 MB");
	});

	test("which line ends it has", () => {
		expect(eolName("\n")).toBe("LF");
		expect(eolName("\r\n")).toBe("CRLF");
	});

	test("the line ends of a text are the kind it has most of", () => {
		expect(lineEnds("a\nb\n")).toBe("\n");
		expect(lineEnds("a\r\nb\r\n")).toBe("\r\n");
		expect(lineEnds("a\r\nb\r\nc\n")).toBe("\r\n");
		expect(lineEnds("a\r\nb\nc\n")).toBe("\n");
		expect(lineEnds("a\r\nb\n")).toBe("\n");
		expect(lineEnds("no line end")).toBe("\n");
		expect(lineEnds("")).toBe("\n");
	});
});
