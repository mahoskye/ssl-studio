// LSP base protocol framing: `Content-Length: n\r\n\r\n<n bytes of JSON>`.

export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function frame(body: string): string {
	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

const LENGTH_NAME = "content-length:";

/**
 * The length a block of headers gives the body after it, or null where it gives none that can be trusted: no
 * `Content-Length` line in it, one whose value is not a plain number or is more than a message may be, or two
 * that disagree. A value that could not be read used to be passed over as if its line were not there, so a block
 * saying `-5` and then `7`, or `5, 7` and then `7`, was read as seven bytes. Two lines that agree are one length.
 */
function parseContentLength(header: string): number | null {
	let length: number | null = null;
	for (const line of header.split("\r\n")) {
		if (line.slice(0, LENGTH_NAME.length).toLowerCase() !== LENGTH_NAME) continue;
		const digits = /^[ \t]*(\d+)[ \t]*$/.exec(line.slice(LENGTH_NAME.length));
		if (!digits) return null;
		const value = Number(digits[1]);
		if (!Number.isSafeInteger(value) || value > MAX_MESSAGE_BYTES) return null;
		if (length !== null && length !== value) return null;
		length = value;
	}
	return length;
}

/**
 * Where the next `Content-Length:` header starts at or after `from`, in any case, or -1. Right after a hyphen it
 * is the end of a longer name (`X-Content-Length:`), which is another header and no length.
 */
function nextLengthHeader(buffer: Buffer, from: number): number {
	const last = LENGTH_NAME.length - 1;
	// The name ends in a colon however it is spelled, so each colon is a place to look, and is looked at once.
	for (let colon = buffer.indexOf(0x3a, from + last); colon >= 0; colon = buffer.indexOf(0x3a, colon + 1)) {
		const start = colon - last;
		if ((buffer[colon - 1]! | 0x20) !== 0x68) continue;
		if (start > 0 && buffer[start - 1] === 0x2d) continue;
		if (buffer.toString("latin1", start, colon + 1).toLowerCase() === LENGTH_NAME) return start;
	}
	return -1;
}

/** Feeds chunks in, calls `onMessage` with each complete message body. */
export function createFrameReader(onMessage: (body: string) => void) {
	let buffer = Buffer.alloc(0);

	const advance = (offset: number) => {
		if (offset >= buffer.length) {
			buffer = Buffer.alloc(0);
			return;
		}
		const tail = buffer.subarray(offset);
		// Release a large backing ArrayBuffer when only a small remainder is left.
		if (tail.buffer.byteLength > 64 * 1024 && tail.length * 4 < tail.buffer.byteLength) {
			buffer = Buffer.from(tail);
		} else {
			buffer = tail;
		}
	};

	/**
	 * Drops bytes that are not a frame, up to the next place a frame can start: a `Content-Length:` header at or
	 * after `from`. With none in sight only a tail is kept, in which one may have begun, and false is returned:
	 * there is nothing to read until more arrives. Dropping only through the end of the bad headers is not enough:
	 * the body they announced is still to come, it ends without a line break, and the next frame's header then
	 * reads as `{...}Content-Length: 8`, which is no header either. Every message after one bad header was lost.
	 *
	 * `refusedEnd` is where the headers just refused end. A `Content-Length` line of their own is no place a frame
	 * starts: of two lines that disagree (`Content-Length: 5`, then `Content-Length: 7`) the second was taken for
	 * the next frame's, and seven bytes were read as a message by a length the line before it contradicts. One
	 * that begins in the middle of a line still is such a place: bytes that were no frame, and then a frame's own.
	 */
	const resync = (from: number, refusedEnd = 0): boolean => {
		let next = nextLengthHeader(buffer, from);
		while (next >= 0 && next < refusedEnd && buffer[next - 2] === 0x0d && buffer[next - 1] === 0x0a) next = nextLengthHeader(buffer, next + 1);
		if (next >= 0) {
			advance(next);
			return true;
		}
		// One byte more than the name can lack: the byte before it says whether it is a name of its own.
		advance(Math.max(0, buffer.length - LENGTH_NAME.length));
		return false;
	};

	return (chunk: Uint8Array) => {
		if (chunk.byteLength === 0) return;
		buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
		while (true) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) {
				if (buffer.length <= MAX_HEADER_BYTES) return;
				// Too much for headers and no end to them: only a header that starts in the last of it can still be one.
				resync(buffer.length - MAX_HEADER_BYTES);
				return;
			}
			if (headerEnd > MAX_HEADER_BYTES) {
				// Too long to be headers, but a frame's own may be the end of it, after bytes that were not a frame.
				if (!resync(headerEnd - MAX_HEADER_BYTES)) return;
				continue;
			}
			const length = parseContentLength(buffer.subarray(0, headerEnd).toString("latin1"));
			if (length === null) {
				// Not headers we understand, a length too large to hold, or two lengths: read on from the next place a
				// frame can start, which is none of these headers' own lines.
				if (!resync(1, headerEnd)) return;
				continue;
			}
			const start = headerEnd + 4;
			const end = start + length;
			if (buffer.length < end) return;
			const body = buffer.subarray(start, end).toString("utf8");
			advance(end);
			onMessage(body);
		}
	};
}
