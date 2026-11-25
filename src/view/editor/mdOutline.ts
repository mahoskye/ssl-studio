// Shared active Markdown outline state published by MarkdownLiveEditor (in both Read and Live modes)
// and consumed by the Document Outline panel (Objects.tsx).
import { createSignal } from "solid-js";

export type ActiveMarkdownOutline = {
	path: string;
	headings: { id: string; text: string; level: number; line?: number }[];
	activeId: string;
	goTo: (id: string) => void;
};

const [mdOutline, setMdOutline] = createSignal<ActiveMarkdownOutline | null>(null);
export { mdOutline, setMdOutline };
