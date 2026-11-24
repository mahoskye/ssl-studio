// LSP base protocol framing: `Content-Length: n\r\n\r\n<n bytes of JSON>`.

export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function frame(body: string): string {
	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function parseContentLength(header: string): number | null {
	let length: number | null = null;
	for (const line of header.split("\r\n")) {
		const match = /^content-length:[ \t]*(\d+)[ \t]*$/i.exec(line);
		if (!match) continue;
		const value = Number(match[1]);
		if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MESSAGE_BYTES) return null;
		if (length !== null && length !== value) return null;
		length = value;
	}
	return length;
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

	return (chunk: Uint8Array) => {
		if (chunk.byteLength === 0) return;
		buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
		while (true) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) {
				if (buffer.length > MAX_HEADER_BYTES) {
					// Preserve only the last 3 bytes in case "\r\n\r\n" straddles the boundary.
					buffer = Buffer.from(buffer.subarray(buffer.length - 3));
				}
				return;
			}
			if (headerEnd > MAX_HEADER_BYTES) {
				// Oversized header block: discard through terminator and resync.
				advance(headerEnd + 4);
				continue;
			}
			const length = parseContentLength(buffer.subarray(0, headerEnd).toString("latin1"));
			if (length === null) {
				// Not a valid header we understand (or oversized Content-Length): drop it rather than stall/OOM.
				advance(headerEnd + 4);
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
