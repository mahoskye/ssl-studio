// Lean, view-aware bottom status bar (VS Code precedent, ADR 0032):
// Left: the language server and the Agent, compact status dots; then the Git branch and the Problems counts (ADR 0049).
// Right: view-appropriate essentials only (hides text/JSON metadata in visual modes;
// keeps encoding, LF/CRLF, cursor, and clickable Language Mode selector in code/text views).
import { Icon } from "./Icon";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { createAsyncQuery } from "./asyncQuery";
import { placeAnchoredMenu } from "../shared/contextMenu";
import { markdownStats } from "../shared/markdownEdit";
import {
	agentIndicator,
	lspIndicator,
	planStepSummary,
	resolveStatusSurface,
	sslSizeAlerts,
	tableGridSummary,
} from "../shared/statusBar";
import { countHistoryEntries, type SizeReport } from "../shared/houseStyle";
import { encodingName, eolName } from "../shared/fileKind";
import { agent } from "./agent/store";
import { useDocAudit } from "./docAudit";
import { pickLanguageMode } from "./editor/languagePicker";
import { languageName } from "./editor/languages";
import { monaco } from "./editor/monaco";
import { review } from "./editor/Review";
import { measureKept } from "./editor/textmate";
import { branchText, changedCount, gitStatus } from "./git";
import { lspAnswering } from "./lsp/session";
import { counts } from "./panels/Problems";
import { requestHealthScope } from "./panels/healthModel";
import { showPanel } from "./panels/registry";
import { chooseFromMenu } from "./panels/RowMenu";
import { isPlanPath } from "./plan/model";
import { isMarkdown, isTable } from "./project";
import { activeDoc, activePath, displayName, markdownMode, notify, openLinePicker, planMode, restartLsp, setState, state, tableTextMode } from "./state";

const [size, setSize] = createSignal<SizeReport | null>(null);
export { size };

function useSizeMeter() {
	const active = createMemo(
		() => ({ key: `${activePath() ?? ""}\0${state.kindVersion}`, doc: activeDoc() }),
		{ equals: (a, b) => a.key === b.key },
	);
	createEffect(
		() => active(),
		({ doc }) => {
			setSize(null);
			if (!doc || doc.binary || doc.model.isDisposed() || doc.model.getLanguageId() !== "ssl") return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const update = () => {
				if (doc.model.isDisposed()) return;
				const text = doc.model.getValue();
				const { codeLines, bannerLines } = measureKept(doc.model, text);
				setSize({ bytes: new TextEncoder().encode(text).length, codeLines, historyEntries: countHistoryEntries(bannerLines) });
			};
			update();
			const sub = doc.model.onDidChangeContent(() => {
				clearTimeout(timer);
				timer = setTimeout(update, 500);
			});
			return () => {
				clearTimeout(timer);
				sub.dispose();
			};
		},
	);
}

/** Opens "go to line": the app's box at the top of the window, for every editor (ADR 0044). */
async function goToLine() {
	openLinePicker();
}

/** The open file's line ends, as the editor has them now: they change with the text, and by hand. */
const [eol, setEol] = createSignal("");
function useLineEnds() {
	const active = createMemo(
		() => ({ key: `${activePath() ?? ""}\0${state.kindVersion}`, doc: activeDoc() }),
		{ equals: (a, b) => a.key === b.key },
	);
	createEffect(
		() => active(),
		({ doc }) => {
			setEol(doc && !doc.binary && !doc.model.isDisposed() ? doc.model.getEOL() : "");
			if (!doc || doc.binary || doc.model.isDisposed()) return;
			const sub = doc.model.onDidChangeContent(() => {
				if (!doc.model.isDisposed()) setEol(doc.model.getEOL());
			});
			return () => sub.dispose();
		},
	);
}

/** How the open file is indented, as the editor has it: what Tab writes, and how wide a tab is drawn. */
const [indent, setIndent] = createSignal<{ spaces: boolean; size: number } | null>(null);
function useIndentation() {
	const active = createMemo(
		() => ({ key: `${activePath() ?? ""}\0${state.kindVersion}`, doc: activeDoc() }),
		{ equals: (a, b) => a.key === b.key },
	);
	createEffect(
		() => active(),
		({ doc }) => {
			const read = () => {
				if (!doc || doc.binary || doc.model.isDisposed()) return setIndent(null);
				const options = doc.model.getOptions();
				setIndent({ spaces: options.insertSpaces, size: options.tabSize });
			};
			read();
			if (!doc || doc.binary || doc.model.isDisposed()) return;
			const sub = doc.model.onDidChangeOptions(read);
			return () => sub.dispose();
		},
	);
}

/** "1 warning", "2 warnings": what the Problems item is read out as. */
export const problemCount = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** "Spaces: 4" or "Tab size: 4", as VS Code's status bar has it. */
export const indentName = (spaces: boolean, size: number) => (spaces ? `Spaces: ${size}` : `Tab size: ${size}`);

/**
 * Where a status bar item's menu opens: against the item, or at the top centre, where the command palette was, when
 * it is asked for from there. A narrow window leaves the item out of the bar, so the palette is the way to it then.
 */
function menuPoint(anchor: HTMLElement | undefined, height: number) {
	const scale = state.settings.uiScale ?? 1;
	const size = { width: Math.round(280 * scale), height: Math.round(height * scale) };
	if (!anchor?.isConnected || !anchor.getClientRects().length) return { x: Math.max(8, Math.round((window.innerWidth - size.width) / 2)), y: Math.round(48 * scale) };
	const box = anchor.getBoundingClientRect();
	const placed = placeAnchoredMenu({ left: box.left, right: box.right, top: box.top, bottom: box.bottom }, size, { width: window.innerWidth, height: window.innerHeight });
	return { x: placed.left, y: placed.top };
}

/** The open file's indentation: tabs or spaces, how wide, turning the one into the other, or worked out from the text. */
export async function chooseIndentation(anchor?: HTMLElement) {
	const doc = activeDoc();
	if (!doc || doc.binary || doc.model.isDisposed()) return;
	const now = doc.model.getOptions();
	const { activeEditor } = await import("./editor/EditorGroup");
	const editor = activeEditor();
	const shown = editor?.getModel() === doc.model ? editor : null;
	const at = (height: number) => menuPoint(anchor, height);
	const choices = [
		{ label: "Indent using spaces", value: "spaces", checked: now.insertSpaces },
		{ label: "Indent using tabs", value: "tabs", checked: !now.insertSpaces },
		{ label: "Change the tab size", value: "size" },
		// Turning the one into the other is an edit of the text: the code editor makes it.
		...(shown
			? [
					{ label: "Convert indentation to spaces", value: "to-spaces" },
					{ label: "Convert indentation to tabs", value: "to-tabs" },
				]
			: []),
		{ label: "Detect from the content", value: "detect" },
	];
	const picked = await chooseFromMenu(`Indentation of this file, now ${indentName(now.insertSpaces, now.tabSize).toLowerCase()}`, choices, at(36 * choices.length + 4));
	if (!picked || doc.model.isDisposed()) return;
	if (picked === "to-spaces" || picked === "to-tabs") {
		shown?.focus();
		await shown?.getAction(picked === "to-spaces" ? "editor.action.indentationToSpaces" : "editor.action.indentationToTabs")?.run();
		return;
	}
	if (picked === "detect") {
		doc.model.detectIndentation(now.insertSpaces, now.tabSize);
		const found = doc.model.getOptions();
		notify(`${displayName(doc.path)} is indented with ${found.insertSpaces ? `spaces, ${found.tabSize} to a level` : `tabs, drawn ${found.tabSize} wide`}.`);
		return;
	}
	const sizes = [1, 2, 3, 4, 5, 6, 7, 8].map((size) => ({ label: String(size), value: String(size), checked: size === now.tabSize }));
	const size = Number(await chooseFromMenu(picked === "size" ? "Tab size" : picked === "spaces" ? "Spaces to a level" : "Tab size", sizes, at(36 * sizes.length + 4)));
	if (!size || doc.model.isDisposed()) return;
	doc.model.updateOptions({ insertSpaces: picked === "size" ? now.insertSpaces : picked === "spaces", tabSize: size, indentSize: size });
}

const LF = "LF: one character, as on Linux and macOS";
const CRLF = "CRLF: two characters, as on Windows";

/** Changes every line end of the open file to the other kind. It is an edit: it can be undone, and is kept by saving. */
export async function chooseLineEnds(anchor?: HTMLElement) {
	const doc = activeDoc();
	if (!doc || doc.binary || doc.model.isDisposed()) return;
	const now = eolName(doc.model.getEOL());
	const picked = await chooseFromMenu(
		`Line ends of this file, now ${now}`,
		[
			{ label: LF, value: LF, checked: now === "LF" },
			{ label: CRLF, value: CRLF, checked: now === "CRLF" },
		],
		menuPoint(anchor, 76),
	);
	const want = picked === LF ? "LF" : picked === CRLF ? "CRLF" : null;
	if (!want || want === now || doc.model.isDisposed()) return;
	doc.model.pushStackElement();
	doc.model.pushEOL(want === "LF" ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
	doc.model.pushStackElement();
	notify(`Every line of ${displayName(doc.path)} now ends in ${want}. Save to keep it; undo takes it back.`);
}

export function StatusBar() {
	useSizeMeter();
	useLineEnds();
	useIndentation();
	useDocAudit();

	// Loaded dynamically to avoid a static import cycle (commands -> EditorGroup -> StatusBar -> commands).
	const [cmds] = createAsyncQuery(() => import("./commands").catch(() => null));
	const problemsKeys = () => cmds()?.keysFor("problems") ?? "";

	const lsp = createMemo(() => lspIndicator(state.lsp, state.info?.lsp, Boolean(state.workspace), lspAnswering()));
	const agentInfo = createMemo(() => agentIndicator(agent.status, state.info?.opencode));

	const surface = createMemo(() => {
		void state.kindVersion;
		const p = activePath();
		const doc = activeDoc();
		const group = state.groups[state.activeGroup];
		const rev = review();
		return resolveStatusSurface({
			centerView: state.centerView,
			inReview: Boolean(rev),
			reviewLanguage: rev ? languageName(rev.language) : null,
			path: p,
			binary: doc?.binary,
			languageId: doc?.model.getLanguageId(),
			isPlan: Boolean(p && isPlanPath(p)),
			planMode: p ? planMode(p, state.activeGroup) : "chart",
			isMarkdown: Boolean(p && isMarkdown(p)),
			mdMode: p ? markdownMode(p, state.activeGroup) : "live",
			isTable: Boolean(p && isTable(p)),
			tableText: p ? tableTextMode(p, state.activeGroup) : false,
			groupMode: group?.mode,
		});
	});

	// Reactive Markdown word count & task progress.
	const [mdStats, setMdStats] = createSignal<{ words: number; tasksDone: number; tasksTotal: number } | null>(null);
	// Reactive visual-view summaries for Plan Chart/Outline and CSV Table grid.
	const [planSteps, setPlanSteps] = createSignal<string | null>(null);
	const [tableStats, setTableStats] = createSignal<string | null>(null);

	const activeMeta = createMemo(
		() => ({ key: `${activePath() ?? ""}\0${state.kindVersion}`, path: activePath(), doc: activeDoc() }),
		{ equals: (a, b) => a.key === b.key },
	);
	createEffect(
		() => activeMeta(),
		({ path: p, doc }) => {
			if (!p || !doc || doc.binary || doc.model.isDisposed()) {
				setMdStats(null);
				setPlanSteps(null);
				setTableStats(null);
				return;
			}
			const md = isMarkdown(p);
			const plan = isPlanPath(p);
			const table = isTable(p);
			if (!md) setMdStats(null);
			if (!plan) setPlanSteps(null);
			if (!table) setTableStats(null);
			if (!md && !plan && !table) return;

			let timer: ReturnType<typeof setTimeout> | undefined;
			const refresh = () => {
				if (doc.model.isDisposed()) return;
				const text = doc.model.getValue();
				if (md) setMdStats(markdownStats(text));
				if (plan) setPlanSteps(planStepSummary(text));
				if (table) setTableStats(tableGridSummary(text));
			};
			refresh();
			const sub = doc.model.onDidChangeContent(() => {
				clearTimeout(timer);
				timer = setTimeout(refresh, 250);
			});
			return () => {
				clearTimeout(timer);
				sub.dispose();
			};
		},
	);

	const sizeWarning = createMemo(() => {
		const s = size();
		if (!s || !surface().showSizeWarning) return null;
		const evaluated = sslSizeAlerts(s, state.settings.limits);
		return evaluated.alerts.length ? evaluated : null;
	});

	const shownEncoding = createMemo(() => {
		void state.kindVersion;
		const doc = activeDoc();
		if (!surface().showTextMeta || !doc || doc.binary) return null;
		return doc.encoding ? encodingName(doc.encoding) : "UTF-8";
	});

	const shownEol = createMemo(() => (surface().showTextMeta && eol() ? eolName(eol()) : null));

	const rightLabel = createMemo(() => {
		void state.kindVersion;
		const s = surface();
		if (s.modeLabel) return s.modeLabel;
		if (s.kind === "text") return languageName(activeDoc()?.model.getLanguageId());
		return null;
	});

	return (
		<footer class="statusbar">
			<button
				class={["item", "status-service", { warn: lsp().tone === "warn", err: lsp().tone === "error" }]}
				disabled={!lsp().actionable}
				title={lsp().detail}
				aria-label={lsp().ariaLabel}
				onClick={() => {
					if (!lsp().actionable || !state.workspace) return;
					notify("Restarting the language server.");
					void restartLsp();
				}}
			>
				<span class={`status-dot ${lsp().tone}`} aria-hidden="true" />
				<span>{lsp().label}</span>
			</button>
			<button
				class={[
					"item",
					"status-service",
					{
						"tier-3": agentInfo().tone === "idle" || agentInfo().tone === "ok",
						warn: agentInfo().tone === "warn",
						err: agentInfo().tone === "error",
					},
				]}
				disabled={!state.workspace && (!state.info || state.info.opencode.ok)}
				title={state.workspace || (state.info && !state.info.opencode.ok) ? agentInfo().detail : "Agent: open a folder first"}
				aria-label={state.workspace || (state.info && !state.info.opencode.ok) ? agentInfo().ariaLabel : "Agent: open a folder first."}
				onClick={() => {
					if (state.info && !state.info.opencode.ok) {
						notify(state.info.opencode.message ?? "opencode was not found. The Agent panel needs opencode 2.2.5 or 2.3.x on PATH.", "error");
					}
					if (!state.workspace) return;
					showPanel("agent");
				}}
			>
				<span class={`status-dot ${agentInfo().tone}`} aria-hidden="true" />
				<span>{agentInfo().label}</span>
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
			<button
				class="item"
				disabled={!state.workspace}
				title={state.workspace ? `Show Problems${problemsKeys() ? ` (${problemsKeys()})` : ""}` : "Problems: open a folder first"}
				aria-label={state.workspace ? `${problemCount(counts().errors, "error")}, ${problemCount(counts().warnings, "warning")}. Show Problems.` : "Problems: open a folder first."}
				onClick={() => {
					if (!state.workspace) return;
					setState((s) => {
						s.bottomView = "problems";
						s.settings.layout.bottom = true;
					});
				}}
			>
				<span class="problem-counts" aria-hidden="true">
					<Icon name="error" /> {counts().errors} <Icon name="warning" /> {counts().warnings}
				</span>
			</button>
			<span class="spacer" />
			<Show when={sizeWarning()}>
				{(w) => {
					const isOver = () => w().alerts.some((a) => a.severity === "over");
					return (
						<button
							class={["item", "status-size-alert", { over: isOver(), near: !isOver() }]}
							title={w().tooltip}
							aria-label={`Script size ${isOver() ? "over" : "near"} limit. Open Health.`}
							onClick={() => {
								requestHealthScope("file");
								showPanel("health");
							}}
						>
							<Icon name="warning" />
							<span>{w().alerts.map((a) => a.text).join(" · ")}</span>
						</button>
					);
				}}
			</Show>
			<Show when={(surface().kind === "plan-chart" || surface().kind === "plan-outline") && planSteps()}>
				{(steps) => (
					<span class="item tier-2" title="Steps in this flowchart plan">
						{steps()}
					</span>
				)}
			</Show>
			<Show when={surface().kind === "table-grid" && tableStats()}>
				{(stats) => (
					<span class="item tier-2" title="Rows and columns in this table">
						{stats()}
					</span>
				)}
			</Show>
			<Show when={surface().showWordCount && mdStats()}>
				{(st) => (
					<span class="item tier-2" title="Word count and Markdown task checklist progress in this document">
						{st().words} {st().words === 1 ? "word" : "words"}
						{st().tasksTotal > 0 ? ` · ${st().tasksDone}/${st().tasksTotal} tasks` : ""}
					</span>
				)}
			</Show>
			<Show when={surface().showCursor}>
				<button
					class="item"
					title="Go to a line (Ctrl+G in the editor)"
					aria-label={`Line ${state.cursor.line}, column ${state.cursor.column}. Go to a line.`}
					onClick={() => void goToLine()}
				>
					Ln {state.cursor.line}, Col {state.cursor.column}
				</button>
			</Show>
			<Show when={shownEncoding()}>
				{(encoding) => (
					<span class="item tier-3" title={`This file is written in ${encoding()}, and is saved in it.`}>
						{encoding()}
					</span>
				)}
			</Show>
			<Show when={surface().showTextMeta && indent()}>
				{(now) => (
					<button
						class="item tier-3"
						aria-haspopup="menu"
						title={`${now().spaces ? `Indented with spaces, ${now().size} to a level` : `Indented with tabs, drawn ${now().size} wide`}. Click to change it.`}
						aria-label={`Indentation: ${indentName(now().spaces, now().size)}. Change it.`}
						onClick={(e) => {
							void chooseIndentation(e.currentTarget);
						}}
					>
						{indentName(now().spaces, now().size)}
					</button>
				)}
			</Show>
			<Show when={shownEol()}>
				{(lineEnd) => (
					<button
						class="item tier-3"
						aria-haspopup="menu"
						title={`Lines end in ${lineEnd()}. Click to change them all.`}
						aria-label={`Line ends: ${lineEnd()}. Change them.`}
						onClick={(e) => {
							void chooseLineEnds(e.currentTarget);
						}}
					>
						{lineEnd()}
					</button>
				)}
			</Show>
			<Show when={rightLabel()}>
				{(label) => (
					<Show
						when={surface().showLanguagePicker}
						fallback={<span class="item">{label()}</span>}
					>
						<button
							class="item status-lang-btn"
							aria-haspopup="dialog"
							title={`Language Mode: ${label()}. Click to select another language mode.`}
							aria-label={`Language Mode: ${label()}. Change Language Mode.`}
							onClick={() => void pickLanguageMode()}
						>
							{label()}
						</button>
					</Show>
				)}
			</Show>
		</footer>
	);
}
