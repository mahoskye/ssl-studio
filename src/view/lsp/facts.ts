// What the language server says of an SSL text, for the parts of the IDE that look for names in one: where its
// comments are, and which words are the language's own. The IDE reads no SSL itself (ADR 0003). An answer is kept
// for the version of the text it was read from, and asked again when the text or the server changes.
import { createSignal } from "solid-js";
import { languageFor } from "../../shared/languages";
import { NO_FACTS, withoutComments, type LexToken, type SslFacts } from "../../shared/lexicalTokens";
import { baseName } from "../../shared/paths";
import type { monaco } from "../editor/monaco";
import { sslCommentSpans } from "../editor/textmate";
import { lspReadyEpoch, session } from "./session";

type Kept = { version: number; epoch: number; asked: Promise<SslFacts>; facts?: SslFacts };
const kept = new WeakMap<monaco.editor.ITextModel, Kept>();
const [arrived, setArrived] = createSignal(0);

const orNull = <T>(asked: Promise<T | null>): Promise<T | null> => asked.catch(() => null);

function entryFor(model: monaco.editor.ITextModel): Kept | null {
	if (model.isDisposed() || model.getLanguageId() !== "ssl") return null;
	const version = model.getVersionId();
	const epoch = lspReadyEpoch();
	const have = kept.get(model);
	if (have && have.version === version && have.epoch === epoch) return have;
	const entry: Kept = { version, epoch, asked: Promise.resolve(NO_FACTS) };
	entry.asked = Promise.all([orNull(session.lexicalTokens(model)), orNull(session.nameTokens(model))]).then(([lexical, names]) => {
		// An answer for a text that has since changed says nothing of the text as it is.
		const facts = model.isDisposed() || model.getVersionId() !== version ? NO_FACTS : { lexical, names };
		entry.facts = facts;
		if (kept.get(model) === entry) setArrived((n) => n + 1);
		return facts;
	});
	kept.set(model, entry);
	return entry;
}

/** What the server says of a model's text as it is now. Each part is null where the server could not say. */
export function sslFacts(model: monaco.editor.ITextModel): Promise<SslFacts> {
	return entryFor(model)?.asked ?? Promise.resolve(NO_FACTS);
}

/**
 * The same, for a reader that cannot wait: what is known now, and undefined while it is being asked. The read is
 * tracked, so a memo that got undefined runs again when the answer has come.
 */
export function sslFactsNow(model: monaco.editor.ITextModel): SslFacts | undefined {
	arrived();
	const entry = entryFor(model);
	return entry ? entry.facts : NO_FACTS;
}

/** A text without its comments (`withoutComments`), with the grammar highlighting reads as what stands in for a server that could not say. */
const plain = (text: string, language: string, lexical: readonly LexToken[] | null | undefined) => withoutComments(text, language, lexical, (lines) => sslCommentSpans(lines));

type Selection = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

function cut(model: monaco.editor.ITextModel, whole: string, selection?: Selection | null): string {
	if (!selection) return whole;
	const from = model.getOffsetAt({ lineNumber: selection.startLineNumber, column: selection.startColumn });
	const to = model.getOffsetAt({ lineNumber: selection.endLineNumber, column: selection.endColumn });
	return whole.slice(Math.min(from, to), Math.max(from, to));
}

/** An open document's text, or a selection of it, without its comments. */
export async function searchableText(model: monaco.editor.ITextModel, selection?: Selection | null): Promise<string> {
	const text = model.getValue();
	const language = model.getLanguageId();
	const lexical = language === "ssl" ? (await sslFacts(model)).lexical : null;
	// The answer is for the text as it was when asked. If the text has moved on, the grammar reads the new one.
	return cut(model, plain(model.getValue(), language, model.getValue() === text ? lexical : null), selection);
}

/** The same for a reader that cannot wait (`sslFactsNow`): the grammar's comments until the server's have come. */
export function searchableTextNow(model: monaco.editor.ITextModel, selection?: Selection | null): string {
	const language = model.getLanguageId();
	const lexical = language === "ssl" ? sslFactsNow(model)?.lexical : null;
	return cut(model, plain(model.getValue(), language, lexical), selection);
}

/** The text of a file that is not open, without its comments. The server is given the text under the file's own name. */
export async function searchableFileText(text: string, path: string): Promise<string> {
	const language = languageFor(path);
	const lexical = language === "ssl" ? await orNull(session.scratchLexical(text, baseName(path))) : null;
	return plain(text, language, lexical);
}
