// Workspace, language server and opencode status, cursor, and the size meter
// for the current script (program decision 0006).
import { Icon } from "./Icon";
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { docChecks } from "../shared/docChecks";
import { folderParts } from "../shared/docSections";
import { markdownStats } from "../shared/markdownEdit";
import { CATALOG_AREAS } from "../shared/projectDocs";
import { docAuditData, useDocAudit } from "./docAudit";
import { docs } from "./project";
import { pickActiveTicket } from "./projectDocs";
import { level, countHistoryEntries, type SizeReport } from "../shared/houseStyle";
import { backend } from "./backend";
import { measure } from "./editor/textmate";
import { symbols } from "./panels/Objects";
import { counts } from "./panels/Problems";
import { showPanel } from "./panels/registry";
import { monaco } from "./editor/monaco";
import { symbolPath } from "./editor/regions";
import { languageName } from "./editor/languages";
import { encodingName, eolName } from "../shared/fileKind";
import { chooseFromMenu } from "./panels/RowMenu";
import { branchText, changedCount, gitStatus } from "./git";
import { activeDoc, activePath, displayName, markdownMode, notify, setState, state } from "./state";
import { activeLiveEditor } from "./editor/liveBridge";
import { review } from "./editor/Review";

const [size, setSize] = createSignal<SizeReport | null>(null);
export { size };

function useSizeMeter() {
	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(
		on(activePath, () => {
			const doc = activeDoc();
			setSize(null);
			if (!doc || doc.model.getLanguageId() !== "ssl") return;
			const update = () => {
				const text = doc.model.getValue();
				const { codeLines, bannerLines } = measure(text);
				setSize({ bytes: new TextEncoder().encode(text).length, codeLines, historyEntries: countHistoryEntries(bannerLines) });
			};
			update();
			const sub = doc.model.onDidChangeContent(() => {
				clearTimeout(timer);
				timer = setTimeout(update, 500);
			});
			onCleanup(() => sub.dispose());
		}),
	);
}

/** Opens the text editor's "go to line". Works in both CodeMirror Live Preview and Monaco. */
async function goToLine() {
	const live = activeLiveEditor();
	if (live) {
		live.runAction("editor.action.gotoLine");
		return;
	}
	const { activeEditor } = await import("./editor/EditorGroup");
	const editor = activeEditor();
	if (!editor) return;
	editor.focus();
	await editor.getAction("editor.action.gotoLine")?.run();
}

/** The open file's line ends, as the editor has them now: they change with the text, and by hand. */
const [eol, setEol] = createSignal("");
function useLineEnds() {
	createEffect(
		on(activePath, () => {
			const doc = activeDoc();
			setEol(doc && !doc.binary ? doc.model.getEOL() : "");
			if (!doc || doc.binary) return;
			const sub = doc.model.onDidChangeContent(() => setEol(doc.model.getEOL()));
			onCleanup(() => sub.dispose());
		}),
	);
}

const LF = "LF: one character, as on Linux and macOS";
const CRLF = "CRLF: two characters, as on Windows";

/** Changes every line end of the open file to the other kind. It is an edit: it can be undone, and is kept by saving. */
async function chooseLineEnds(at: { x: number; y: number }) {
	const doc = activeDoc();
	if (!doc || doc.binary) return;
	const now = eolName(doc.model.getEOL());
	const picked = await chooseFromMenu(
		`Line ends of this file, now ${now}`,
		[
			{ label: LF, value: LF, checked: now === "LF" },
			{ label: CRLF, value: CRLF, checked: now === "CRLF" },
		],
		at,
	);
	const want = picked === LF ? "LF" : picked === CRLF ? "CRLF" : null;
	if (!want || want === now) return;
	doc.model.pushStackElement();
	doc.model.pushEOL(want === "LF" ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
	doc.model.pushStackElement();
	notify(`Every line of ${displayName(activePath()!)} now ends in ${want}. Save to keep it; undo takes it back.`);
}

export function StatusBar() {
	useSizeMeter();
	useLineEnds();
	useDocAudit();
	const limits = () => state.settings.limits;
	const lspLabel = () => {
		const s = state.lsp.state;
		const version = state.info?.lsp.version ? ` ${state.info.lsp.version}` : "";
		// With no folder there is nothing for it to read: it is not a fault that it is not running.
		if (!state.workspace && s === "stopped") return "Language server starts with a folder";
		return s === "running" ? `Language server${version}` : `Language server ${s}`;
	};
	const lspWaits = () => !state.workspace && state.lsp.state === "stopped" && !state.info?.lsp.message;
	/** The regions and the procedure the cursor is in, outermost first: where one is, in a long script. */
	/** A Markdown document being read (not in Live or Source editing): it has no cursor line to say a place by. */
	const rendered = () => Boolean(activePath() && /\.(md|markdown)$/i.test(activePath()!) && markdownMode(activePath()!, state.activeGroup) === "read");
	const where = () => (state.centerView === "editors" && !rendered() ? symbolPath(symbols(), state.cursor.line).filter((s) => s.kind !== monaco.languages.SymbolKind.Variable) : []);
	/** The same in a sentence, innermost first: "DueDate, in Counting days". */
	const whereWords = () => [...where()].reverse().map((s) => s.name).join(", in ");
	const lspNote = () => state.lsp.message ?? state.info?.lsp.message;
	const opencode = () => state.info?.opencode;
	const docAreas = createMemo(() => CATALOG_AREAS.filter((area) => area !== "schema" || folderParts(state.project?.schema ?? "schema").length > 0));
	const docCheckList = createMemo(() => docChecks(docs(), docAreas()));
	const docWarnings = createMemo(
		() => docCheckList().filter((c) => c.level === "warn").length + docAuditData().issues.filter((i) => i.level === "warn").length,
	);
	const docNotes = createMemo(
		() =>
			docCheckList().filter((c) => c.level === "note").length +
			docAuditData().issues.filter((i) => i.level === "note").length +
			docAuditData().unusedAttachments.length,
	);
	const hasAnyTickets = createMemo(() => docs().some((d) => d.exists && d.group === "tickets" && Boolean(d.ticket)));
	const focusedTicket = createMemo(() => state.settings.activeTicket?.trim() || "");
	// Reactive Markdown word count & task progress in StatusBar when a Markdown doc is open.
	const [mdStats, setMdStats] = createSignal<{ words: number; tasksDone: number; tasksTotal: number } | null>(null);
	createEffect(
		on(activePath, (p) => {
			const doc = activeDoc();
			if (!p || !doc || !/\.(md|markdown)$/i.test(p)) {
				setMdStats(null);
				return;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const refresh = () => setMdStats(markdownStats(doc.model.getValue()));
			refresh();
			const sub = doc.model.onDidChangeContent(() => {
				clearTimeout(timer);
				timer = setTimeout(refresh, 250);
			});
			onCleanup(() => {
				clearTimeout(timer);
				sub.dispose();
			});
		}),
	);
	// "near" and "over" are also said in words, for anyone who cannot tell them by colour.
	const part = (value: number, limit: number, text: string, near?: number, narrowHide = false) => {
		const at = level(value, limit, near);
		return (
			<span class={`${at}${narrowHide && at === "ok" ? " tier-3" : ""}`} title={at === "ok" ? undefined : `${at === "over" ? "Over" : "Near"} the limit of ${limit}`}>
				{text}
				{at === "over" ? " (over)" : at === "near" ? " (near)" : ""}
			</span>
		);
	};
	const lspVersion = () => (state.info?.lsp.version ? ` ${state.info.lsp.version}` : "");
	return (
		<footer class="statusbar">
			<span class="item tier-3" title={state.workspace?.root}>
				{state.workspace?.name ?? "No folder"}
			</span>
			<button
				class="item lsp-item"
				classList={{ warn: !lspWaits() && (state.lsp.state !== "running" || Boolean(state.info?.lsp.message)) }}
				title={`${lspNote() ? `${lspNote()}\n` : ""}Click to restart the language server.`}
				aria-label={`${lspLabel()}${lspNote() ? `: ${lspNote()}` : ""}. Restart the language server.`}
				onClick={() => (notify("Restarting the language server."), void backend.lspRestart())}
			>
				<span class="lsp-full">{lspLabel()}</span>
				<span class="lsp-short" aria-hidden="true">
					{state.lsp.state === "running" ? `LSP${lspVersion()}` : `LSP ${state.lsp.state}`}
				</span>
				<Icon name="refresh" class="restart" />
			</button>
			<Show when={gitStatus()}>
				<button
					class="item git-item"
					title={`On the branch ${branchText()}${changedCount() ? `; ${changedCount()} ${changedCount() === 1 ? "file has" : "files have"} changed since the last commit` : "; nothing has changed since the last commit"}. Show Source control.`}
					aria-label={`Branch ${gitStatus()!.branch || "none"}${gitStatus()!.ahead ? `, ${gitStatus()!.ahead} ahead` : ""}${gitStatus()!.behind ? `, ${gitStatus()!.behind} behind` : ""}, ${changedCount()} changed ${changedCount() === 1 ? "file" : "files"}. Show Source control.`}
					onClick={() => showPanel("git")}
				>
					<span class="codicon-glyph" aria-hidden="true">
						{"\uec6f"}
					</span>
					{branchText()}
					<Show when={changedCount()}>
						<span class="git-count">{changedCount()}</span>
					</Show>
				</button>
			</Show>
			<Show
				when={opencode()?.ok}
				fallback={
					<button class="item warn tier-2" title="Show why opencode is not available" onClick={() => notify(opencode()?.message ?? "opencode was not found. The Agent panel needs opencode 2.2.5 or 2.3.x on PATH.", "error")}>
						opencode not available
					</button>
				}
			>
				<span class="item tier-2" title="opencode powers the Agent panel">
					opencode {opencode()!.version}
				</span>
			</Show>
			<button
				class="item"
				title="Show Problems (Ctrl+Shift+M)"
				aria-label={`${counts().errors} errors, ${counts().warnings} warnings. Show Problems.`}
				onClick={() => {
					setState("bottomView", "problems");
					setState("settings", "layout", "bottom", true);
				}}
			>
				<span class="problem-counts" aria-hidden="true">
					<Icon name="error" /> {counts().errors} <Icon name="warning" /> {counts().warnings}
				</span>
			</button>
			<Show when={hasAnyTickets()}>
				<button
					class="item tier-2 status-ticket-focus"
					classList={{ active: Boolean(focusedTicket()) }}
					title={
						focusedTicket()
							? `Active working ticket: ${focusedTicket()} (coordinates Agent, Git, Search, Docs & Graph). Click to switch or open.`
							: "Focus workspace on a working ticket (coordinates Agent, Git, Search, Docs & Graph)"
					}
					aria-label={focusedTicket() ? `Working on ${focusedTicket()}. Switch active ticket.` : "Set active working ticket."}
					onClick={() => void pickActiveTicket()}
				>
					<Icon name="checklist" /> {focusedTicket() ? `Working on: ${focusedTicket()}` : "Focus ticket"}
				</button>
			</Show>
			<Show when={docWarnings() > 0 || docNotes() > 0}>
				<button
					class="item tier-2"
					classList={{ warn: docWarnings() > 0 }}
					title={`${docWarnings()} document ${docWarnings() === 1 ? "warning" : "warnings"}, ${docNotes()} ${docNotes() === 1 ? "note" : "notes"} in Health. Click to open Health.`}
					aria-label={`${docWarnings()} document warnings, ${docNotes()} notes. Open Health.`}
					onClick={() => showPanel("health")}
				>
					<Icon name="note" /> {docWarnings() > 0 ? (docNotes() > 0 ? `${docWarnings()} · ${docNotes()}` : docWarnings()) : docNotes()}
				</button>
			</Show>
			<Show when={where().length}>
				<button
					class="item where tier-2"
					title={`The cursor is in ${whereWords()}. Show it in Document outline.`}
					aria-label={`The cursor is in ${whereWords()}. Show Document outline.`}
					onClick={() => showPanel("objects")}
				>
					{/* Cut short from the front: the end is the procedure, the part that matters most. */}
					<bdi>{where().map((s) => s.name).join(" › ")}</bdi>
				</button>
			</Show>
			<span class="spacer" />
			<Show when={state.centerView === "editors" && !review() && size()}>
				{(s) => {
					const anyAlert = () =>
						level(s().bytes, limits().bytes) !== "ok" ||
						level(s().codeLines, limits().codeLines) !== "ok" ||
						level(s().historyEntries, limits().historyEntries, 1) !== "ok";
					return (
						<span
							class="item meter"
							classList={{ "tier-3": !anyAlert() }}
							title={`This script against the house size limits: ${limits().bytes / 1024} KB, ${limits().codeLines} lines of code, ${limits().historyEntries} entries in the banner's change list (program decision 0006)`}
						>
							{part(s().bytes, limits().bytes, `${(s().bytes / 1024).toFixed(1)} KB`, undefined, true)}
							{part(s().codeLines, limits().codeLines, `${s().codeLines} code lines`, undefined, true)}
							{part(s().historyEntries, limits().historyEntries, `${s().historyEntries} banner ${s().historyEntries === 1 ? "change" : "changes"}`, 1, true)}
						</span>
					);
				}}
			</Show>
			<Show when={state.centerView === "editors" && !review() && mdStats()}>
				{(st) => (
					<span class="item tier-2" title="Word count and Markdown task checklist progress in this document">
						{st().words} {st().words === 1 ? "word" : "words"}
						{st().tasksTotal > 0 ? ` · ${st().tasksDone}/${st().tasksTotal} tasks` : ""}
					</span>
				)}
			</Show>
			<Show when={state.centerView === "editors" && review()}>
				{(r) => <span class="item">{languageName(r().language)}</span>}
			</Show>
			<Show when={activePath() && state.centerView === "editors" && !review()}>
				{/* Where the cursor is, and the way to another line: the editor's own "go to line". */}
				<Show when={!activeDoc()?.binary}>
					<button class="item" title="Go to a line (Ctrl+G in the editor)" aria-label={`Line ${state.cursor.line}, column ${state.cursor.column}. Go to a line.`} onClick={() => void goToLine()}>
						Ln {state.cursor.line}, Col {state.cursor.column}
					</button>
				</Show>
				<Show when={!activeDoc()?.binary && activeDoc()?.encoding}>
					{(encoding) => (
						<span class="item tier-3" title={`This file is written in ${encodingName(encoding())}, and is saved in it.`}>
							{encodingName(encoding())}
						</span>
					)}
				</Show>
				<Show when={eol()}>
					<button
						class="item tier-3"
						aria-haspopup="menu"
						title={`Lines end in ${eolName(eol())}. Click to change them all.`}
						aria-label={`Line ends: ${eolName(eol())}. Change them.`}
						onClick={(e) => {
							const box = e.currentTarget.getBoundingClientRect();
							void chooseLineEnds({ x: box.left, y: box.top - 70 });
						}}
					>
						{eolName(eol())}
					</button>
				</Show>
				<span class="item">{activeDoc()?.binary ? (activeDoc()!.binary!.image ? "Picture" : "Not text") : languageName(activeDoc()?.model.getLanguageId())}</span>
			</Show>
		</footer>
	);
}
