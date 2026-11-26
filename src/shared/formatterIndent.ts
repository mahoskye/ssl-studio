// What indentation a line of a script is to have, asked of the formatter (ADR 0036).
//
// The language server's formatter is the one thing that knows how SSL is indented: which keywords open a block,
// which close one, how a statement that runs on is lined up, and whether the house style writes tabs or spaces.
// Rules for that written here, or in a language configuration, would be a second account of it that drifts. So
// the editor asks: the text above a new line is given to the formatter with a line of its own added at the foot,
// and where the formatter puts that line is where the new line goes.
//
// These are the question and the reading of the answer, with no editor and no server in them.

/** The statement added at the foot of the text: a name no script has, and the `;` that ends a statement. */
export const INDENT_PROBE = "sslStudioIndentProbe;";
/**
 * What stands before the probe on its line. No formatter indents with this, so a probe that still has it was
 * never read as code: it stood inside a string or a comment, which a formatter leaves as it finds them. A new
 * line there is text of the string or the comment, and is not indented.
 */
const UNREAD = " \t \t ";

const leading = (line: string) => /^[ \t]*/.exec(line)![0];
/** A line as a formatter leaves it recognisable: without its spacing and its letter case. */
const key = (line: string) => line.replace(/\s+/g, "").toLowerCase();
/** The last line of a text that has anything on it. */
function lastWritten(text: string): string | null {
	const lines = text.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim()) return lines[i]!;
	return null;
}
const ended = (text: string) => (text && !/\n$/.test(text) ? `${text}\n` : text);

/** The text to have formatted to learn the indentation of a new line under `above` (the text of the lines before it). */
export function newLineQuestion(above: string): string {
	return `${ended(above.replace(/\r\n/g, "\n"))}${UNREAD}${INDENT_PROBE}\n`;
}

/**
 * The indentation of the new line, from the formatter's answer to `newLineQuestion`. Null where there is none
 * to give: the line is inside a string or a comment, or the formatter did not leave the probe a line of its own.
 */
export function newLineIndent(formatted: string): string | null {
	const line = lastWritten(formatted);
	if (line === null || line.trim() !== INDENT_PROBE) return null;
	const indent = leading(line);
	return indent === UNREAD ? null : indent;
}

/** The text to have formatted to learn the indentation of its own last line: the text through the end of that line. */
export function ownLineQuestion(through: string): string {
	return ended(through.replace(/\r\n/g, "\n"));
}

/**
 * The indentation the formatter gives `line`, the last line of the text it was asked about. Null where the
 * formatter's last line is not that line any more (it joined it to another, or broke it in two): then it has
 * said nothing about this line as it stands.
 */
export function ownLineIndent(formatted: string, line: string): string | null {
	const last = lastWritten(formatted);
	if (last === null || !key(line) || key(last) !== key(line)) return null;
	return leading(last);
}

/**
 * Where a cursor stands on a line whose indentation `was` has become `now`: at the end of the new indentation
 * if it stood in the old one's last place, within the new one if it stood within the old, and as far along the
 * text as it was otherwise. Columns are from 1.
 */
export function columnAfterIndent(column: number, was: string, now: string): number {
	if (column > was.length + 1) return column + now.length - was.length;
	return column === was.length + 1 ? now.length + 1 : Math.min(column, now.length + 1);
}

/** What was typed, by the changes one keystroke made: a new line, a `;`, or neither of them. */
export function typedForIndent(changes: readonly { text: string; rangeLength: number }[]): "line" | "end" | null {
	if (changes.length === 1 && changes[0]!.text === ";" && changes[0]!.rangeLength === 0) return "end";
	// Enter writes the line break and the indentation it keeps; it may also take away the spaces a line was left
	// with by the Enter before it.
	const breaks = changes.filter((change) => /^\r?\n[ \t]*$/.test(change.text));
	return breaks.length === 1 && changes.every((change) => change === breaks[0] || change.text === "") ? "line" : null;
}
