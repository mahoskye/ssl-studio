// LSP base protocol framing: `Content-Length: n\r\n\r\n<n bytes of JSON>`.

export function frame(body: string): string {
	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Feeds chunks in, calls `onMessage` with each complete message body. */
export function createFrameReader(onMessage: (body: string) => void) {
	let buffer = Buffer.alloc(0);
	return (chunk: Uint8Array) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const match = /Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("latin1"));
			if (!match) {
				// Not a header we understand: drop it rather than stall forever.
				buffer = buffer.subarray(headerEnd + 4);
				continue;
			}
			const start = headerEnd + 4;
			const end = start + Number(match[1]);
			if (buffer.length < end) return;
			onMessage(buffer.subarray(start, end).toString("utf8"));
			buffer = buffer.subarray(end);
		}
	};
}
