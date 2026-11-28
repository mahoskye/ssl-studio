// The app's console as the self-test passes it on, with one known line explained.
//
// In a WebKit web view (the Linux app), Monaco's clipboard service starts a clipboard write on every click and key
// press in the editor, so that a later copy counts as one the user asked for, and logs "ERR" when the write is
// refused. A click or key press the self-test sends by script is no user gesture, so WebKit refuses at once and the
// log gets a block like this, one per event:
//
//   [webview:1] [console.error] %c  ERR color: #f33 write@[native code]
//   e@views://main/assets/editor.api-SLXcqcUo.js:473:79629
//   dispatchEvent@[native code]
//   b@views://main/assets/selftest-CAsyEbYj.js:2:2072
//
// It is the self-test's doing, not a failure. Such a block is told apart by its stack: the refused call is the
// clipboard's `write`, and a frame of the self-test's own code sent the event. The first is explained in a line of
// its own, the rest are counted, and the end of the run says how many there were and from which self-test. Any other
// ERR block is passed on whole, with a line under it saying it was not explained.

/** What a block's stack says: a clipboard write refused, and the self-test file that sent the event, if one did. */
export type ErrBlock = { clipboard: boolean; scriptedBy: string | null };

/** A console line from the web view that opens an ERR block. */
const ERR_START = /\[console\.error\].*\bERR\b/;
/** One frame of a JavaScriptCore stack: `name@url:line:col`, `name@[native code]`, or an unnamed or `global code` one. */
const FRAME = /^(?:[^\s@]*|\w+ code)@(?:\[native code\]|\S+:\d+:\d+)$/;
/** A frame in one of the self-test's own bundles (selftest, selftestDocs, selftestCycle, selftestClose). */
const SELFTEST_FRAME = /\/assets\/(selftest[A-Za-z]*)-[\w-]+\.js:\d+:\d+$/;

/** Reads an ERR block's stack. Its first frame is at the end of the block's first line. */
export function readErrBlock(lines: string[]): ErrBlock {
	const first = lines[0]?.match(/([^\s@]*@(?:\[native code\]|\S+))$/)?.[1] ?? "";
	const frames = [first, ...lines.slice(1)];
	const scripted = frames.map((frame) => frame.match(SELFTEST_FRAME)?.[1]).find(Boolean);
	return { clipboard: first === "write@[native code]", scriptedBy: scripted ?? null };
}

export const CLIPBOARD_NOTE =
	"selftest: [expected] That ERR is Monaco's clipboard workaround for WebKit. It starts a clipboard write on each click and key press in the editor, and WebKit refuses one for a click or key press the self-test sends by script, which is no user gesture. Not a failure. Later ones are counted, not shown.";
export const UNEXPLAINED_NOTE = "selftest: [not explained] the editor logged the ERR above, and it did not come from a click or key press the self-test sent by script.";

/**
 * Counts what was explained over a whole run (the close check starts the app twice), and gives each of the app's
 * streams a reader of its own, since a block must not be split between two.
 */
export function consoleNotes() {
	const scripted = new Map<string, number>();
	let unexplained = 0;
	const close = (block: string[]): string[] => {
		const read = readErrBlock(block);
		if (read.clipboard && read.scriptedBy) {
			const total = [...scripted.values()].reduce((sum, n) => sum + n, 0);
			scripted.set(read.scriptedBy, (scripted.get(read.scriptedBy) ?? 0) + 1);
			// The first is shown by its first line, as the app logged it, and explained; its stack is left out.
			return total === 0 ? [block[0], CLIPBOARD_NOTE] : [];
		}
		unexplained++;
		return [...block, UNEXPLAINED_NOTE];
	};
	return {
		/** A reader for one stream: give it each line, and it gives back the lines to show in its place. */
		reader() {
			let block: string[] | null = null;
			return {
				push(raw: string): string[] {
					const line = raw.replace(/\r$/, "");
					const out: string[] = [];
					if (block) {
						if (FRAME.test(line)) {
							block.push(line);
							return out;
						}
						out.push(...close(block));
						block = null;
					}
					if (ERR_START.test(line)) block = [line];
					else out.push(line);
					return out;
				},
				/** At the end of the stream: a block still open is closed. */
				end(): string[] {
					const out = block ? close(block) : [];
					block = null;
					return out;
				},
			};
		},
		/** What the run's end says about the ERR blocks, or nothing when there were none. */
		summary(): string[] {
			const lines: string[] = [];
			const total = [...scripted.values()].reduce((sum, n) => sum + n, 0);
			if (total) {
				const from = [...scripted].map(([file, n]) => `${file} ${n}`).join(", ");
				lines.push(`selftest: ${total} clipboard ERR ${total === 1 ? "block" : "blocks"} from clicks and key presses the self-test sent by script (${from}): expected, not a failure.`);
			}
			if (unexplained) lines.push(`selftest: ${unexplained} editor ERR ${unexplained === 1 ? "block" : "blocks"} not explained: read ${unexplained === 1 ? "it" : "them"} above.`);
			return lines;
		},
	};
}

/**
 * Passes one of the app's streams on, line by line, through a reader. Resolves when the stream ends. Text is
 * written as it comes, but a line is held until it is whole, and an ERR block until a line that is no frame of it.
 */
export async function passOn(stream: ReadableStream<Uint8Array>, reader: ReturnType<ReturnType<typeof consoleNotes>["reader"]>, write: (text: string) => void) {
	const decoder = new TextDecoder();
	let rest = "";
	const emit = (lines: string[]) => lines.length && write(lines.map((line) => `${line}\n`).join(""));
	for await (const chunk of stream) {
		const text = rest + decoder.decode(chunk, { stream: true });
		const lines = text.split("\n");
		rest = lines.pop() ?? "";
		for (const line of lines) emit(reader.push(line));
	}
	rest += decoder.decode();
	if (rest) emit(reader.push(rest));
	emit(reader.end());
}
