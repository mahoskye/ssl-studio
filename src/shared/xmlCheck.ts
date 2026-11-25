// Where an XML document stops being well formed. The reading is the
// browser's own XML reader, in the view; this is only what it said, taken
// apart: "error on line 3 at column 7: Opening and ending tag mismatch".

export type XmlProblem = { line: number; column: number; message: string };

/** A text that is meant as XML: it opens with a tag, a declaration or a comment. A ".config" file of another kind is not judged. */
export function looksLikeXml(text: string): boolean {
	return /^\uFEFF?\s*</.test(text);
}

/** What the readers say of a closing tag that is not the one that was opened, each in its own words. */
const MISMATCH: [RegExp, (found: RegExpExecArray) => string][] = [
	[/^Unexpected closing tag: (\S+) != (\S+)$/i, (found) => `The closing tag </${found[1]}> does not match <${found[2]}>, which is open here.`],
	[/^Opening and ending tag mismatch: (\S+) line (\d+) and (\S+)$/i, (found) => `The closing tag </${found[3]}> does not match <${found[1]}>, opened on line ${found[2]}.`],
];

function formatXmlMessage(raw: string): string {
	// The page the reader draws around its error ends with a sentence of its own, at times with no break before it.
	const message = raw
		.replace(/Below is a rendering of the page up to the first error\.?\s*$/i, "")
		.trim()
		.replace(/\s+/g, " ");
	const worded = MISMATCH.map(([pattern, words]) => [pattern.exec(message), words] as const).find(([match]) => match);
	if (worded) return worded[1](worded[0]!);
	return message ? `${message[0]!.toUpperCase()}${message.slice(1)}${/[.!?]$/.test(message) ? "" : "."}` : "This is not well-formed XML.";
}

/** What the reader's error says, as a place and a sentence. The place is 1 and 1 when it names none. */
export function xmlProblem(said: string): XmlProblem {
	const found = /error on line (\d+) at column (\d+):\s*([^\r\n]*)/i.exec(said);
	if (found) {
		return {
			line: Math.max(Number(found[1]), 1),
			column: Math.max(Number(found[2]), 1),
			message: formatXmlMessage(found[3]!),
		};
	}
	// Gecko / Firefox DOMParser format:
	// "XML Parsing Error: <msg>\nLocation: ...\nLine Number <line>, Column <col>:"
	const geckoMsg = /XML Parsing Error:\s*([^\r\n]+)/i.exec(said);
	const geckoPos = /Line Number (\d+),\s*Column (\d+)/i.exec(said);
	if (geckoMsg || geckoPos) {
		return {
			line: geckoPos ? Math.max(Number(geckoPos[1]), 1) : 1,
			column: geckoPos ? Math.max(Number(geckoPos[2]), 1) : 1,
			message: formatXmlMessage(geckoMsg?.[1] ?? ""),
		};
	}
	return { line: 1, column: 1, message: "This is not well-formed XML." };
}
