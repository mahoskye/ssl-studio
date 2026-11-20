// Reads a Markdown text for its marks, aside from the window (see markdownLive.ts). The reading is the same
// one, from src/shared/markdownLive.ts: it only runs here so that a long text, which takes long to read, does
// not hold up the keys.
import { liveMarks } from "../../shared/markdownLive";

self.onmessage = (e: MessageEvent<{ id: number; text: string }>) => {
	self.postMessage({ id: e.data.id, marks: liveMarks(e.data.text) });
};
