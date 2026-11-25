// The Agent panel's decisions, kept free of the DOM, Monaco and the app's
// state, so the tests can run them against the recorded fake of opencode
// (test/agentPanel.test.ts). store.ts, tidy.ts and Agent.tsx supply the
// dialogs, the toasts and the backend.

export const errorText = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? e);

const ENDED = /^session\.execution\.(succeeded|failed|interrupted)$/;

/**
 * The turn in flight, known from the moment a prompt is sent and not from its
 * first token: a local model can think for minutes before it writes anything,
 * and that wait has to be something the user can stop.
 */
export class Turns {
	private asking = 0;
	private live = new Set<string>();
	private wanted = false;

	constructor(private interrupt: (sessionID: string) => Promise<unknown>) {}

	/** A prompt is on its way, or its turn is running. */
	get busy() {
		return this.asking > 0;
	}

	/** Stop was asked for and the turn has not ended yet. */
	get stopping() {
		return this.wanted;
	}

	/** An ask starts. A kept session is known at once; a new one when the adapter reports it. */
	begin(sessionID?: string) {
		this.asking++;
		if (sessionID) this.live.add(sessionID);
	}

	/** The ask returned, however it went. */
	end() {
		this.asking = Math.max(0, this.asking - 1);
		if (this.asking) return;
		this.live.clear();
		this.wanted = false;
	}

	/** One of the adapter's events (src/bun/agent.ts sends them for the IDE's own sessions only). */
	event(type: string, data: { sessionID?: string } | null | undefined) {
		const sessionID = data?.sessionID;
		if (!sessionID || !this.asking) return;
		if (ENDED.test(type)) return void this.live.delete(sessionID);
		if (type !== "session" && !type.startsWith("session.")) return;
		const fresh = !this.live.has(sessionID);
		this.live.add(sessionID);
		// Stop was pressed before there was anything to stop. An interrupt that
		// lands before the prompt does nothing, so it is sent again when the turn starts.
		if (this.wanted && (fresh || /\.started$/.test(type))) void this.interrupt(sessionID).catch(() => {});
	}

	/**
	 * Stops the turn. "waiting" means opencode has no session for it yet (it is
	 * starting, or checking skills): the turn is stopped as soon as it has one.
	 */
	async stop(): Promise<"stopped" | "waiting" | "idle"> {
		if (!this.asking) return "idle";
		this.wanted = true;
		const sessions = [...this.live];
		await Promise.all(sessions.map((sessionID) => this.interrupt(sessionID).catch(() => {})));
		return sessions.length ? "stopped" : "waiting";
	}
}

export const USE_IT = "Use it";
export const MINE = "It runs on my own machine";

type ModelLike = { providerID: string; id: string; name: string; local: boolean };
export const modelRef = (m: { providerID: string; id: string }) => `${m.providerID}/${m.id}`;

/** The models of one heading in the list to choose from. */
export type ModelGroup<M> = { label: string; local: boolean; models: M[] };

/**
 * The models under headings, for a list that may be hundreds long: those on
 * this machine first, under one heading whichever provider serves them, then
 * each other provider by name with its own. Within a heading, by name.
 */
export function groupModels<M extends ModelLike>(models: readonly M[]): ModelGroup<M>[] {
	const byName = (a: M, b: M) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
	const local = models.filter((m) => m.local).sort(byName);
	const providers = [...new Set(models.filter((m) => !m.local).map((m) => m.providerID))].sort((a, b) => a.localeCompare(b));
	return [
		...(local.length ? [{ label: "On this machine", local: true, models: local }] : []),
		...providers.map((id) => ({ label: `${id}: may cost money`, local: false, models: models.filter((m) => !m.local && m.providerID === id).sort(byName) })),
	];
}

/**
 * What choosing a model comes to: the model to save, or null when the user
 * backed out of a paid one, in which case nothing is saved and the list must
 * go back to showing the model still in use.
 */
export async function decideModel(ref: string, models: ModelLike[], choose: (title: string, buttons: string[], options?: { danger?: string }) => Promise<string | null>): Promise<{ model: string; own: boolean } | null> {
	const trimmed = ref.trim();
	if (trimmed === "") return { model: "", own: false };
	const lower = trimmed.toLowerCase();
	const model = models.find((m) => modelRef(m).toLowerCase() === lower);
	if (model?.local) return { model: modelRef(model), own: false };
	const title = model
		? `${model.name} (${model.providerID}) is not a local model and may cost money. Use it for new agent sessions?`
		: `${trimmed} is not confirmed as a local model and may cost money. Use it for new agent sessions?`;
	const answer = await choose(title, [USE_IT, MINE], { danger: USE_IT });
	if (answer !== USE_IT && answer !== MINE) return null;
	// Remembered for this user: the model counts as local from now on, and is not asked about again.
	return { model: model ? modelRef(model) : trimmed, own: answer === MINE };
}

function fenceLangFor(file: string): string {
	const lower = file.toLowerCase();
	if (/\.(ssl|srvscr|ds)$/.test(lower)) return "ssl";
	if (/\.sql$/.test(lower)) return "sql";
	if (/\.(md|markdown)$/.test(lower)) return "markdown";
	if (/\.(json|jsonc)$/.test(lower)) return "json";
	if (/\.(xml|xfd|xsd|xsl|wsdl|config|svg)$/.test(lower)) return "xml";
	if (/\.(csv|tsv)$/.test(lower)) return "csv";
	if (/\.ya?ml$/.test(lower)) return "yaml";
	if (/\.toml$/.test(lower)) return "toml";
	if (/\.tsx?$/.test(lower)) return "typescript";
	if (/\.jsx?$/.test(lower)) return "javascript";
	if (/\.html?$/.test(lower)) return "html";
	if (/\.css$/.test(lower)) return "css";
	return "ssl";
}

/**
 * A question as it is sent: the work it is for, then the question, then the
 * code it is about. The agent has no file tools here, and is told so.
 */
export function composeQuestion(question: string, code?: { file: string; label: string; code: string } | null, work?: string): string {
	const parts = [...(work ? [work, "", "THE QUESTION:"] : []), question];
	if (code) parts.push("", `About this code from ${code.file}, ${code.label}:`, `\`\`\`${fenceLangFor(code.file)}`, code.code, "```");
	if (code || work) parts.push("", `You cannot read files in this session; answer from ${code && work ? "the code and the documents above" : code ? "the code above" : "the documents above"}.`);
	return parts.join("\n");
}

/**
 * What to say when a prompt looks cut: a model's context limit drops what
 * does not fit with no error, and the count of tokens it took gives it away.
 * In a kept conversation it is the start that goes: the ticket, the earlier
 * questions. Null when nothing looks cut.
 */
export function cutNote(cut: boolean, kept: boolean): string | null {
	if (!cut) return null;
	return `This prompt looks cut off: the model took in exactly as much as its context holds, or less than it was sent, so it missed part of it${kept ? ", most likely the start of this conversation: the ticket and the earlier questions" : ""}. With Ollama, set a larger context (docs/INSTALL.md)${kept ? ", or start a new conversation" : ""}.`;
}

export const NOT_SENT = "Not sent: the agent is still working on the last request. Your question is kept here. Send it when the reply ends, or stop the reply.";

/** What Send does with the draft. The draft is cleared only when it goes out. */
export function composerSend(draft: string, busy: boolean): { send: string | null; draft: string; why?: string } {
	const question = draft.trim();
	if (!question) return { send: null, draft };
	if (busy) return { send: null, draft, why: NOT_SENT };
	return { send: question, draft: "" };
}

export type StepState = "pending" | "running" | "review" | "accepted" | "rejected" | "unchanged" | "failed";

/** A tidy step's button: what it says, and why it cannot be pressed when it cannot. */
export function stepAction(step: StepState, at: { busy: boolean; reviewOpen: boolean }): { label: string; disabled: boolean; title?: string } {
	if (step === "running") return { label: "Running…", disabled: true, title: "This step is running. Stop this reply to cancel it." };
	if (step === "review")
		return at.reviewOpen
			? { label: "In review", disabled: true, title: "This step's proposal is open for review. Accept or reject it there." }
			: { label: "Show review", disabled: false, title: "Open this step's proposal for review again" };
	const label = step === "pending" ? "Run" : step === "failed" || step === "rejected" ? "Try again" : "Run again";
	return at.busy ? { label, disabled: true, title: "The agent is still working on the last request." } : { label, disabled: false };
}

export type Reporter = { notify: (text: string, kind: "info" | "error") => void; log: (line: string) => void };

/**
 * Runs work whose promise nobody waits for (a button's handler). A failure is
 * shown, written to Output, and handed to `failed`, which puts whatever was
 * "running" into a state the user can try again from.
 */
export async function attempt<T>(what: string, work: () => T | Promise<T>, io: Reporter, failed?: (message: string) => void): Promise<T | undefined> {
	try {
		return await work();
	} catch (e) {
		const message = errorText(e);
		failed?.(message);
		// An error toast is written to Output by `notify` itself. What is added here is where it
		// came from, on one line: the first frames of the stack, when there is one.
		io.notify(`${what}: ${message}`, "error");
		const frames = e instanceof Error && e.stack ? e.stack.split("\n").map((line) => line.trim()).filter((line) => line && !line.includes(message)).slice(0, 3) : [];
		io.log(`${what}${frames.length ? ` (${frames.join(" < ")})` : ""}`);
		return undefined;
	}
}

export type ContextSliceBreakdown = { label: string; chars: number; status: "pending" | "edited" | "sent" };

export type PreparedContextResult = {
	text: string;
	labels: string[];
	slices: Map<string, string>;
	breakdown: ContextSliceBreakdown[];
};

/** Fast deterministic content fingerprint so mid-session edits to tickets/specs/files trigger an automatic delta re-send. */
export function hashContextText(s: string): string {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return `${s.length}:${h.toString(36)}`;
}

/**
 * Incrementally enforces `maxChars` as context slices are added so slices that
 * do not fit are never added to `slices` / `labels` or permanently marked sent.
 */
export function createContextAccumulator(
	alreadySent: ReadonlyMap<string, string>,
	maxChars: number,
	truncate: (text: string, limit: number) => string,
) {
	const parts: string[] = [];
	const labels: string[] = [];
	const slices = new Map<string, string>();
	const breakdown: ContextSliceBreakdown[] = [];
	let usedChars = 0;

	const addSlice = (key: string, label: string, content: string): boolean => {
		const trimmed = content.trim();
		if (!trimmed) return false;
		const h = hashContextText(trimmed);
		const prev = alreadySent.get(key);
		if (prev === h) {
			breakdown.push({ label, chars: 0, status: "sent" });
			return false;
		}
		const sep = parts.length ? 2 : 0; // "\n\n"
		const remaining = maxChars - usedChars - sep;
		let piece = trimmed;
		if (piece.length > remaining) {
			if (parts.length > 0 || maxChars <= 0) return false;
			piece = truncate(trimmed, maxChars);
		}
		parts.push(piece);
		usedChars += sep + piece.length;
		labels.push(prev ? `${label} (updated)` : label);
		slices.set(key, h);
		breakdown.push({ label, chars: piece.length, status: prev ? "edited" : "pending" });
		return true;
	};

	const finish = (): PreparedContextResult => ({
		text: parts.join("\n\n"),
		labels,
		slices,
		breakdown,
	});

	return { addSlice, finish };
}

export type FencedBlock = { lang: string; code: string };

/**
 * Fence-depth-aware Markdown block extractor supporting ``` and ~~~ fences and
 * nested blocks. Preserves line-1 indentation and trailing spaces in diff hunks
 * by stripping only a single leading/trailing newline rather than `.trim()`.
 */
export function extractFencedBlocks(markdown: string): FencedBlock[] {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const blocks: FencedBlock[] = [];
	let active: { ch: string; len: number; lang: string; lines: string[] } | null = null;
	for (const line of lines) {
		if (!active) {
			const m = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
			if (m) {
				const ch = m[1]![0]!;
				const info = m[2]!.trim();
				if (ch === "`" && info.includes("`")) continue;
				active = { ch, len: m[1]!.length, lang: (info.split(/\s+/)[0] ?? "").toLowerCase(), lines: [] };
			}
		} else {
			const isClose = new RegExp(`^[ \\t]{0,3}${active.ch}{${active.len},}[ \\t]*$`).test(line);
			if (isClose) {
				const code = active.lines.join("\n").replace(/^\r?\n/, "").replace(/\r?\n$/, "");
				if (code.trim().length > 0) blocks.push({ lang: active.lang, code });
				active = null;
			} else {
				active.lines.push(line);
			}
		}
	}
	return blocks;
}

type ParsedDiffHeader = { ok: true; path: string | null; isAbsolute: boolean } | { ok: false };

function parseDiffHeaderPath(raw: string, gitPrefix: "a/" | "b/"): ParsedDiffHeader {
	let s = raw.split("\t")[0]!.trim();
	if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
		s = s.slice(1, -1).replace(/\\(["\\])/g, "$1");
	}
	if (!s || s.includes("\0")) return { ok: false };
	if (s === "/dev/null") return { ok: true, path: null, isAbsolute: false };
	let norm = s.replace(/\\/g, "/");
	if (norm.startsWith(gitPrefix)) norm = norm.slice(gitPrefix.length);
	while (norm.startsWith("./")) norm = norm.slice(2);
	if (!norm) return { ok: false };
	const segments = norm.split("/").filter((seg) => seg.length > 0);
	if (!segments.length || segments.some((seg) => seg === "..")) return { ok: false };
	const isAbsolute = norm.startsWith("/") || /^[A-Za-z]:\//.test(norm);
	return { ok: true, path: norm, isAbsolute };
}

function diffHeaderMatchesTarget(header: { path: string; isAbsolute: boolean }, targetPath: string): boolean {
	const targetNorm = targetPath.replace(/\\/g, "/").toLowerCase();
	const hdrNorm = header.path.toLowerCase();
	if (header.isAbsolute) {
		return targetNorm === hdrNorm;
	}
	const targetRel = targetNorm.replace(/^\/+/, "");
	return targetRel === hdrNorm || targetRel.endsWith(`/${hdrNorm}`);
}

/**
 * Applies a single-file unified diff onto `original`; returns `null` if the diff
 * spans multiple files, targets a mismatched or traversal path, has invalid hunk
 * counts, applies `@@ -0,0` to a non-empty file, or fails to match context.
 * Preserves the original file's CRLF/LF line endings.
 */
export function applySimpleUnifiedDiff(original: string, diffText: string, targetPath?: string): string | null {
	const eol = original.includes("\r\n") ? "\r\n" : "\n";
	const hasTrailingNewline = original.endsWith("\n");
	const normalizedOrig = original.replace(/\r\n/g, "\n");
	const origLines =
		normalizedOrig === ""
			? []
			: hasTrailingNewline
				? normalizedOrig.slice(0, -1).split("\n")
				: normalizedOrig.split("\n");
	const diffLines = diffText.replace(/\r\n/g, "\n").split("\n");

	type Hunk = {
		oldStart: number;
		oldCount: number;
		newStart: number;
		newCount: number;
		lines: string[];
		seenOld: number;
		seenNew: number;
		noNewlineAfterNew: boolean;
	};

	const hunks: Hunk[] = [];
	let cur: Hunk | null = null;
	let lastCompleted: Hunk | null = null;
	let sawDiffGit = false;
	let oldHeader: { path: string | null; isAbsolute: boolean } | undefined;
	let newHeader: { path: string | null; isAbsolute: boolean } | undefined;

	for (let i = 0; i < diffLines.length; i++) {
		const line = diffLines[i]!;
		if (cur !== null) {
			if (/^diff --git\s+/.test(line)) return null;
			if (/^---\s+(?:a\/|\/dev\/null)/.test(line) && /^\+\+\+\s+(?:b\/|\/dev\/null)/.test(diffLines[i + 1] ?? "")) {
				return null;
			}
			if (/^@@\s+-\d+/.test(line)) return null;
			if (/^\\ No newline at end of file/i.test(line)) {
				const prevLine = cur.lines.at(-1);
				if (prevLine && (prevLine[0] === "+" || prevLine[0] === " ")) cur.noNewlineAfterNew = true;
				continue;
			}
			if (line.startsWith(" ") || line === "") {
				if (cur.seenOld >= cur.oldCount || cur.seenNew >= cur.newCount) return null;
				cur.lines.push(line === "" ? " " : line);
				cur.seenOld++;
				cur.seenNew++;
			} else if (line.startsWith("-")) {
				if (cur.seenOld >= cur.oldCount) return null;
				cur.lines.push(line);
				cur.seenOld++;
			} else if (line.startsWith("+")) {
				if (cur.seenNew >= cur.newCount) return null;
				cur.lines.push(line);
				cur.seenNew++;
			} else {
				return null;
			}
			if (cur.seenOld === cur.oldCount && cur.seenNew === cur.newCount) {
				lastCompleted = cur;
				cur = null;
			}
			continue;
		}

		const h = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(?:.*)?$/.exec(line);
		if (h) {
			const oldStart = Number(h[1]);
			const oldCount = h[2] !== undefined ? Number(h[2]) : 1;
			const newStart = Number(h[3]);
			const newCount = h[4] !== undefined ? Number(h[4]) : 1;
			if (oldCount === 0 && newCount === 0) return null;
			cur = { oldStart, oldCount, newStart, newCount, lines: [], seenOld: 0, seenNew: 0, noNewlineAfterNew: false };
			hunks.push(cur);
			lastCompleted = null;
			continue;
		}

		if (/^\\ No newline at end of file/i.test(line)) {
			if (!lastCompleted) return null;
			const prevLine = lastCompleted.lines.at(-1);
			if (prevLine && (prevLine[0] === "+" || prevLine[0] === " ")) lastCompleted.noNewlineAfterNew = true;
			continue;
		}

		if (line === "") continue;

		// Only file headers before the first hunk are permitted; any headers or trailing diff lines after a hunk reject multi-file/malformed diffs.
		if (hunks.length > 0) return null;

		if (/^diff --git\s+/.test(line)) {
			if (sawDiffGit || oldHeader !== undefined || newHeader !== undefined) return null;
			sawDiffGit = true;
			continue;
		}
		if (/^(?:index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/.test(line)) {
			continue;
		}
		const oldM = /^---\s+(.+)$/.exec(line);
		if (oldM) {
			if (oldHeader !== undefined) return null;
			const parsed = parseDiffHeaderPath(oldM[1]!, "a/");
			if (!parsed.ok) return null;
			oldHeader = { path: parsed.path, isAbsolute: parsed.isAbsolute };
			continue;
		}
		const newM = /^\+\+\+\s+(.+)$/.exec(line);
		if (newM) {
			if (newHeader !== undefined) return null;
			const parsed = parseDiffHeaderPath(newM[1]!, "b/");
			if (!parsed.ok) return null;
			newHeader = { path: parsed.path, isAbsolute: parsed.isAbsolute };
			continue;
		}
		return null;
	}

	if (cur !== null || !hunks.length) return null;

	const headerToCheck = newHeader?.path ? newHeader : oldHeader?.path ? oldHeader : undefined;
	if (headerToCheck && headerToCheck.path) {
		if (headerToCheck.isAbsolute && !targetPath) return null;
		if (targetPath && !diffHeaderMatchesTarget({ path: headerToCheck.path, isAbsolute: headerToCheck.isAbsolute }, targetPath)) {
			return null;
		}
	}

	const result = [...origLines];
	let delta = 0;
	for (const hunk of hunks) {
		const expectedOld = hunk.lines.filter((l) => l[0] === " " || l[0] === "-").map((l) => l.slice(1));
		const nextNew = hunk.lines.filter((l) => l[0] === " " || l[0] === "+").map((l) => l.slice(1));
		if (hunk.oldCount === 0) {
			if (hunk.oldStart === 0 && original.length > 0) return null;
			const pos = (hunk.oldStart === 0 ? 0 : hunk.oldStart) + delta;
			if (pos < 0 || pos > result.length) return null;
			result.splice(pos, 0, ...nextNew);
			delta += nextNew.length;
			continue;
		}
		if (hunk.oldStart === 0) return null;
		const at = hunk.oldStart - 1 + delta;
		const matchesAt = (pos: number) =>
			pos >= 0 &&
			pos + expectedOld.length <= result.length &&
			expectedOld.every((line, idx) => result[pos + idx] === line);
		let pos = at;
		if (!matchesAt(pos)) {
			// Search within +/-15 lines for shifted hunk context.
			let found = -1;
			for (let off = 1; off <= 15; off++) {
				if (matchesAt(at - off)) {
					found = at - off;
					break;
				}
				if (matchesAt(at + off)) {
					found = at + off;
					break;
				}
			}
			if (found < 0) return null;
			pos = found;
		}
		result.splice(pos, expectedOld.length, ...nextNew);
		delta += nextNew.length - expectedOld.length;
	}

	if (result.length === 0) return "";
	const lastHunk = hunks[hunks.length - 1]!;
	const finalTrailing = lastHunk.noNewlineAfterNew ? false : hasTrailingNewline;
	return result.join(eol) + (finalTrailing ? eol : "");
}
