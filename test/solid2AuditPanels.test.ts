import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createEffect, createMemo, createRoot, createSignal, flush, onCleanup, onSettled, untrack } from "solid-js";
import { frontMatter, frontMatterInnerSpan } from "../src/shared/frontMatter";
import { getPath, HOUSE_STYLE, SERVER_DEFAULTS, setPath } from "../src/shared/styleProfile";
import { createAsyncQuery } from "../src/view/asyncQuery";
import { defaultMarkdownPanelTab } from "../src/view/panels/markdownBridge";

// Minimal headless browser & Monaco shims so view modules load cleanly under Bun.
const storage = new Map<string, string>();
if (typeof (globalThis as any).localStorage === "undefined") {
	(globalThis as any).localStorage = {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, String(v)),
		removeItem: (k: string) => void storage.delete(k),
		clear: () => storage.clear(),
	};
}
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		innerWidth: 1280,
		innerHeight: 900,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
} else {
	if (!(globalThis as any).window.Error) (globalThis as any).window.Error = Error;
	if (!(globalThis as any).window.Map) (globalThis as any).window.Map = Map;
	if (!(globalThis as any).window.Set) (globalThis as any).window.Set = Set;
}
if (typeof (globalThis as any).document === "undefined") {
	(globalThis as any).document = {
		documentElement: { dataset: {}, style: {} },
		head: { appendChild() {} },
		body: { style: {} },
		activeElement: null,
		getElementById: () => null,
		createElement: () => ({ style: {}, getContext: () => null }),
		querySelector: () => null,
		addEventListener() {},
		removeEventListener() {},
	};
} else {
	if (!(globalThis as any).document.body) (globalThis as any).document.body = { style: {} };
	else if (!(globalThis as any).document.body.style) (globalThis as any).document.body.style = {};
	if (!(globalThis as any).document.addEventListener) (globalThis as any).document.addEventListener = () => {};
	if (!(globalThis as any).document.removeEventListener) (globalThis as any).document.removeEventListener = () => {};
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

const makeUri = (scheme: string, fsPath: string) => {
	const normalized = fsPath.replace(/\\/g, "/");
	const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
	return { scheme, fsPath, path: normalized, toString: () => raw };
};

mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({
	default: class {},
}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));

const noopProxy = (base: Record<string, any> = {}): any =>
	new Proxy(base, {
		get(target, prop) {
			if (prop in target) return target[prop as any];
			return () => ({ dispose() {} });
		},
	});

mock.module("monaco-editor/editor/editor.api", () => ({
	Range: class {
		constructor(
			public startLineNumber: number,
			public startColumn: number,
			public endLineNumber: number,
			public endColumn: number,
		) {}
	},
	Emitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	Uri: {
		file: (p: string) => makeUri("file", p),
		parse: (raw: string) => {
			if (raw.startsWith("file://")) return makeUri("file", decodeURI(raw.slice("file://".length)));
			const idx = raw.indexOf(":");
			return idx >= 0 ? makeUri(raw.slice(0, idx), raw.slice(idx + 1)) : makeUri("file", raw);
		},
		from: ({ scheme, path }: { scheme: string; path?: string }) => makeUri(scheme, path ?? "/"),
	},
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: {},
	languages: noopProxy({
		CompletionItemKind: { Text: 0, Method: 1, Function: 2 },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
		FoldingRangeKind: { Comment: { value: "comment" }, Imports: { value: "imports" }, Region: { value: "region" } },
		SymbolKind: { Namespace: 2, Class: 4, Method: 5, Function: 11 },
	}),
	editor: noopProxy({
		getEditors: () => [],
		ScrollType: { Immediate: 1 },
		getModels: () => [],
		getModel: () => null,
		setModelMarkers: () => {},
		getModelMarkers: () => [],
	}),
}));

const { setState } = await import("../src/view/state");
const { attachFileToAgent, currentAgentContext } = await import("../src/view/agent/Agent");

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

describe("Solid 2.0.3 Audit — Search.tsx HitRow reactivity & toggleQueryToken", () => {
	test("HitRow uses reactive <Show> for inline replace preview and never non-null asserts after()!.get", () => {
		const src = readSrc("../src/view/panels/Search.tsx");
		const hitRowStart = src.indexOf("const HitRow =");
		const hitRowEnd = src.indexOf("return (\n\t\t<div class=\"panel-body\" data-panel=\"search\">", hitRowStart);
		expect(hitRowStart).toBeGreaterThan(0);
		expect(hitRowEnd).toBeGreaterThan(hitRowStart);
		const hitRowSrc = src.slice(hitRowStart, hitRowEnd);

		expect(hitRowSrc).toContain("<Show when={after()?.has(part.column!)} fallback={<mark>{part.text}</mark>}>");
		expect(hitRowSrc).toContain('<ins>{after()?.get(part.column!) ?? ""}</ins>');
		expect(hitRowSrc).not.toContain("after()!.get");
	});

	test("toggleQueryToken invokes run({ query: next }) even when toggling off the last filter chip clears query to empty", () => {
		const src = readSrc("../src/view/panels/Search.tsx");
		const fnStart = src.indexOf("const toggleQueryToken =");
		const fnEnd = src.indexOf("const hasQueryToken =", fnStart);
		expect(fnStart).toBeGreaterThan(0);
		expect(fnEnd).toBeGreaterThan(fnStart);
		const fnSrc = src.slice(fnStart, fnEnd);

		expect(fnSrc).toContain("void run({ query: next });");
		expect(fnSrc).not.toContain("if (next) void run()");

		// Also verify run() clears stale hits, asked, effectiveAsked, and docFilterNote on empty query.
		const runStart = src.indexOf("const run = async (overrides: RunOverrides = {}) => {");
		const runHead = src.slice(runStart, runStart + 500);
		expect(runHead).toContain("setDocFilterNote(\"\");");
		expect(runHead).toContain("if (!rawQuery) {");
		expect(runHead).toContain("setHits([]);");
		expect(runHead).toContain("setAsked(\"\");");
		expect(runHead).toContain("setEffectiveAsked(\"\");");
		expect(runHead).toContain("setStatus(\"idle\");");
	});

	test("toggling off the last filter chip clears stale hits and docFilterNote cleanly", () => {
		const [typed, setTyped] = createSignal("tag:lims");
		const [hits, setHits] = createSignal<string[]>(["docs/a.md:1"]);
		const [docFilterNote, setDocFilterNote] = createSignal("tag:lims (1 doc)");
		const [status, setStatus] = createSignal<"idle" | "done">("done");

		const run = (overrides: { query?: string } = {}) => {
			const rawQuery = overrides.query ?? typed();
			setDocFilterNote("");
			if (!rawQuery) {
				setHits([]);
				setStatus("idle");
				return;
			}
			setHits(["docs/a.md:1"]);
			setDocFilterNote(`${rawQuery} (1 doc)`);
			setStatus("done");
		};

		const toggleQueryToken = (token: string) => {
			const cur = typed();
			const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const re = new RegExp(`(?:^|\\s)${esc}(?=\\s|$)`, "i");
			const next = re.test(cur) ? cur.replace(re, " ").replace(/\s+/g, " ").trim() : `${token}${cur.trim() ? ` ${cur.trim()}` : ""}`;
			setTyped(next);
			run({ query: next });
		};

		toggleQueryToken("tag:lims");
		flush();
		expect(typed()).toBe("");
		expect(hits()).toEqual([]);
		expect(docFilterNote()).toBe("");
		expect(status()).toBe("idle");
	});
});

describe("Solid 2.0.3 Audit — Agent.tsx workspace reset & snapshot(agent).chatSession", () => {
	test("currentAgentContext returns clean reset defaults immediately on workspace switch before flush", () => {
		try {
			// 1. Open Workspace A and attach a file.
			setState((s) => {
				s.workspace = { root: "/ws-solid2-a", name: "ws-a" };
			});
			flush();
			currentAgentContext();
			flush();

			attachFileToAgent("/ws-solid2-a/docs/notes.md");
			flush();
			expect(currentAgentContext().workOptions.ticketFiles).toEqual([
				{ path: "/ws-solid2-a/docs/notes.md", rel: "docs/notes.md" },
			]);

			// 2. Switch to Workspace B and call currentAgentContext() BEFORE flush() settles reset signals.
			setState((s) => {
				s.workspace = { root: "/ws-solid2-b", name: "ws-b" };
			});
			const ctxImmediate = currentAgentContext();
			expect(ctxImmediate.workOptions.ticketFiles).toEqual([]);
			expect(ctxImmediate.workOptions.includeSchema).toBe(false);
			expect(ctxImmediate.workOptions.includeRegistries).toBe(false);
			expect(ctxImmediate.workOptions.includeState).toBe(false);

			// 3. A second same-tick call (like currentAgentContext() -> askAbout()) before flush still sees clean defaults.
			const ctxSecondSameTick = currentAgentContext();
			expect(ctxSecondSameTick.workOptions.ticketFiles).toEqual([]);
			expect(ctxSecondSameTick.workOptions.includeSchema).toBe(false);

			// 4. After flush, Workspace B accepts its own fresh attachments normally.
			flush();
			attachFileToAgent("/ws-solid2-b/docs/spec.md");
			flush();
			expect(currentAgentContext().workOptions.ticketFiles).toEqual([
				{ path: "/ws-solid2-b/docs/spec.md", rel: "docs/spec.md" },
			]);
		} finally {
			setState((s) => {
				s.workspace = null;
			});
			flush();
			currentAgentContext();
			flush();
		}
	});

	test("Agent.tsx uses agentCtx store + snapshot(agentCtx) and runAskAbout uses snapshot(agent).chatSession and explicit flags", () => {
		const src = readSrc("../src/view/agent/Agent.tsx");
		expect(src).toContain("function ensureAgentWorkspace(): boolean");
		expect(src).toContain("const ctx = snapshot(agentCtx);");
		expect(src).toContain("const picked = ctx.pickedTicket;");
		expect(src).toContain("includeSchema: ctx.withSchema,");
		expect(src).toContain("includeRegistries: ctx.withRegistries,");
		expect(src).toContain("includeState: ctx.withState,");

		const runStart = src.indexOf("async function runAskAbout(");
		const runEnd = src.indexOf("export async function askAbout(", runStart);
		expect(runStart).toBeGreaterThan(0);
		expect(runEnd).toBeGreaterThan(runStart);
		const runSrc = src.slice(runStart, runEnd);

		expect(runSrc).toContain("const chatSession = snapshot(agent).chatSession;");
		expect(runSrc).toContain("sessionID: chatSession ?? undefined,");
		expect(runSrc).not.toContain("agent.chatSession");
		expect(runSrc).toContain("withGitDiff: ctx.withGitDiff,");
		expect(runSrc).toContain("withGoverningDocs: ctx.withGoverningDocs,");
		expect(runSrc).toContain("withRefTables: ctx.withRefTables,");

		const prepStart = src.indexOf("async function prepareContextDelta(");
		const prepEnd = src.indexOf("async function runAskAbout(", prepStart);
		const prepSrc = src.slice(prepStart, prepEnd);
		expect(prepSrc).toContain("if (flags.withGitDiff)");
		expect(prepSrc).toContain("if (flags.withGoverningDocs && root)");
		expect(prepSrc).toContain("if (flags.withRefTables)");
	});
});

describe("Solid 2.0.3 Audit — Palette.tsx non-keyed <Show> & draft-backed inspector inputs", () => {
	test("Palette.tsx removes keyed from plan/selectedNode/ticketDoc <Show> blocks and uses draft-backed inspector inputs", () => {
		const src = readSrc("../src/view/panels/Palette.tsx");
		const inspStart = src.indexOf("{/* Contextual inspector: Selected object OR Plan");
		const inspEnd = src.indexOf("{/* Keep PlanAssistant mounted", inspStart);
		expect(inspStart).toBeGreaterThan(0);
		expect(inspEnd).toBeGreaterThan(inspStart);
		const inspSrc = src.slice(inspStart, inspEnd);

		// None of the contextual inspector <Show> blocks should use `keyed`.
		expect(inspSrc).not.toMatch(/<Show[\s\S]{0,120}\bkeyed\b/);
		expect(inspSrc).toContain("when={plan.selectedNode()}");
		expect(inspSrc).toContain("<Show when={p()}>");
		expect(inspSrc).toContain("<Show when={ticketDoc()}>");

		// Callback bodies read lazily through Solid 2 accessors rather than raw object fields.
		expect(inspSrc).toContain("const displayKind = () => (node().kind === \"call\" ? \"step\" : node().kind);");
		expect(inspSrc).toContain("const heading = () => `Selected ${displayKind()}`;");
		expect(inspSrc).toContain("const codeState = () => plan.codeStateOf(node().id);");
		expect(inspSrc).toContain("const actionable = () => node().kind !== \"start\" && node().kind !== \"end\";");
		expect(inspSrc).toContain("nodeDocsOf(node())");
		expect(inspSrc).toContain("plan={curPlan()}");
		expect(inspSrc).toContain("node={node()}");
		expect(inspSrc).toContain("void openFile(td().path)");

		// Draft helpers exist and back Title, Goal, Ticket, Label, Stage, Notes.
		expect(src).toContain("const DraftInput =");
		expect(src).toContain("const DraftTextarea =");
		// The draft signal is in `pendingField` (planBridge.ts), which both helpers are built on; a node's field
		// hands its text over with the id of the node it was typed for (test/pass3LowsPlan.test.ts).
		expect(src).toContain("pendingField(props, { hold: holdsPendingEdit })");
		expect(inspSrc).toContain('onCommit={(val) => plan.setPlanField("title", val)}');
		expect(inspSrc).toContain('onCommit={(val) => plan.setPlanField("goal", val)}');
		expect(inspSrc).toContain('onCommit={(val) => plan.setPlanField("ticket", val)}');
		expect(inspSrc).toContain("onCommit={(val, id) => plan.setNodeText(val, id)}");
		expect(inspSrc).toContain("onCommit={(val, id) => plan.setNodeGroup(val, id)}");
		expect(inspSrc).toContain('onCommit={(val, id) => plan.setNodeField("notes", val, id)}');
	});

	test("draft signal with structural memo preserves uncommitted typing across unrelated updates and resets on selection change", () => {
		const ctx = createRoot((dispose) => {
			const [node, setNode] = createSignal({ id: "n1", text: "Validate", extra: 0 });
			const [draft, setDraft] = createSignal(untrack(() => node().text));
			const syncVal = createMemo(
				() => ({ key: node().id, value: node().text }),
				{ equals: (a, b) => a.key === b.key && a.value === b.value },
			);
			createEffect(syncVal, ({ value }) => {
				setDraft(value);
			});
			return { setNode, draft, setDraft, dispose };
		});
		try {
			flush();

			// User starts typing without committing yet.
			ctx.setDraft("Validate sample");
			flush();
			expect(ctx.draft()).toBe("Validate sample");

			// Unrelated plan re-parse creates a new node object with the same id & committed text.
			ctx.setNode({ id: "n1", text: "Validate", extra: 1 });
			flush();
			expect(ctx.draft()).toBe("Validate sample");

			// Switching selection to another node (even with the same committed text) resets draft cleanly.
			ctx.setNode({ id: "n2", text: "Validate", extra: 1 });
			flush();
			expect(ctx.draft()).toBe("Validate");
		} finally {
			ctx.dispose();
		}
	});
});

describe("Solid 2.0.3 Audit — StyleProfile.tsx & Settings.tsx", () => {
	test("StyleProfile.tsx chains set() inside setLayers updater, backs number fields with draft signal, and avoids preview.latest", () => {
		const src = readSrc("../src/view/StyleProfile.tsx");
		const setStart = src.indexOf("const set = (path: PathKey, value: unknown) => {");
		const setEnd = src.indexOf("const preset =", setStart);
		const setSrc = src.slice(setStart, setEnd);

		expect(setSrc).toContain("setLayers((prev) => {");
		expect(setSrc).toContain("nextSsl = setPath(prev[targetScope], path, value);");
		expect(setSrc).not.toContain("layers()[targetScope]");

		expect(src).toContain("const NumberInput =");
		expect(src).toContain("const displayedText = createMemo(() => String(displayed(props.field.path) ?? \"\"));");
		expect(src).toContain("const [draft, setDraft] = createSignal(untrack(displayedText));");
		// The draft takes what the field can read: an unreadable number so far ("12e") reports "" and is not mirrored.
		expect(src).toContain("if (!e.currentTarget.validity.badInput) setDraft(e.currentTarget.value);");
		expect(src).toContain('innerHTML={preview()?.html ?? ""}');
		expect(src).not.toContain("preview.latest");

		// Verify rapid back-to-back updater chaining preserves both SSL setting paths in the same tick.
		const [layers, setLayers] = createSignal<{ user: Record<string, any> }>({ user: {} });
		const saved: Record<string, any>[] = [];
		const applySet = (path: readonly string[], value: unknown) => {
			let nextSsl: Record<string, any> = {};
			setLayers((prev) => {
				nextSsl = setPath(prev.user, path, value);
				return { ...prev, user: nextSsl };
			});
			saved.push(nextSsl);
		};
		applySet(["format", "indentSize"], 2);
		applySet(["format", "maxLineLength"], 100);
		flush();
		expect(saved[1]?.format?.indentSize).toBe(2);
		expect(saved[1]?.format?.maxLineLength).toBe(100);
		expect(layers().user.format).toEqual({ indentSize: 2, maxLineLength: 100 });
	});

	test("Settings.tsx backs all 6 onChange-only inputs with DraftInput while keeping commitOnEnter & saveRelFolder", () => {
		const src = readSrc("../src/view/Settings.tsx");
		expect(src).toContain("function DraftInput(");
		expect(src).toContain("const committed = createMemo(() => props.value);");
		expect(src).toContain("const [draft, setDraft] = createSignal(untrack(committed));");
		expect(src).toContain("setDraft(e.currentTarget.value);");
		expect(src).toContain("onKeyDown={commitOnEnter}");

		const draftUses = [...src.matchAll(/<DraftInput\b/g)].length;
		expect(draftUses).toBe(6);
		expect(src).toContain('saveRelFolder("attachmentsFolder", el)');
		expect(src).toContain('saveRelFolder("templatesFolder", el)');
	});
});

describe("Solid 2.0.3 Audit — modal.tsx focus capture inside onSettled", () => {
	test("modal.tsx captures previous activeElement inside onSettled before stack.push and target.focus", () => {
		const src = readSrc("../src/view/modal.tsx");
		const modalStart = src.indexOf("export function Modal(");
		const onSettledIdx = src.indexOf("onSettled(() => {", modalStart);
		const prevDeclIdx = src.indexOf("let previous: HTMLElement | null = null;", modalStart);
		const prevCaptureIdx = src.indexOf("previous = typeof document !== \"undefined\" && document.activeElement instanceof HTMLElement", modalStart);
		const pushIdx = src.indexOf("stack.push(entry);", onSettledIdx);
		const focusIdx = src.indexOf("target?.focus();", onSettledIdx);

		expect(prevDeclIdx).toBeGreaterThan(modalStart);
		expect(prevDeclIdx).toBeLessThan(onSettledIdx);
		expect(prevCaptureIdx).toBeGreaterThan(onSettledIdx);
		expect(prevCaptureIdx).toBeLessThan(pushIdx);
		expect(pushIdx).toBeLessThan(focusIdx);
		expect(src).not.toContain("const previous = typeof document");
	});
});

describe("Solid 2.0.3 Audit — Objects.tsx auto-default Markdown tab tracks docsLoading & docs", () => {
	test("Objects.tsx tracks docsLoading() and ticket-doc status in compute and does not latch while loading", () => {
		const src = readSrc("../src/view/panels/Objects.tsx");
		expect(src).toContain("import { docs, docsLoading, isMarkdown, isTable } from \"../project\";");

		const autoStart = src.indexOf("const mdAutoDefault = createMemo(");
		const autoEnd = src.indexOf("// Honor explicit tab-switch requests", autoStart);
		expect(autoStart).toBeGreaterThan(0);
		expect(autoEnd).toBeGreaterThan(autoStart);
		const autoSrc = src.slice(autoStart, autoEnd);

		const effectIdx = autoSrc.indexOf("createEffect(");
		const computePart = autoSrc.slice(0, effectIdx);
		const applyPart = autoSrc.slice(effectIdx);

		expect(computePart).toContain("docsLoading()");
		expect(computePart).toContain("docs().some(");
		expect(applyPart).not.toContain("docs()");
		expect(applyPart).toContain("if (!info.loading) lastAutoDefaultMdPath = info.key;");
	});

	test("ticket Markdown tab without YAML frontmatter switches to Info once docsLoading finishes", () => {
		let lastAutoDefaultMdPath = "";
		const ctx = createRoot((dispose) => {
			const [activePath, setActivePath] = createSignal<string | null>("/ws/docs/tickets/LIMS-42.md");
			const [docsLoading, setDocsLoading] = createSignal(true);
			const [docs, setDocs] = createSignal<{ group: string; ticket?: string; path: string }[]>([]);
			const [activeTab, setActiveTab] = createSignal<"info" | "outline">("outline");

			const mdAutoDefault = createMemo(
				() => {
					const p = activePath();
					if (!p || !/\.md$/i.test(p)) return null;
					const key = p.toLowerCase();
					const loading = docsLoading();
					const isTicketDoc = docs().some((f) => f.group === "tickets" && f.ticket && f.path.toLowerCase() === key);
					return { key, loading, isTicketDoc };
				},
				{
					equals: (a, b) =>
						a === b ||
						(Boolean(a && b) && a!.key === b!.key && a!.loading === b!.loading && a!.isTicketDoc === b!.isTicketDoc),
				},
			);

			createEffect(mdAutoDefault, (info) => {
				if (!info) return;
				if (info.key === lastAutoDefaultMdPath) return;
				setActiveTab(defaultMarkdownPanelTab(info.isTicketDoc, null));
				if (!info.loading) lastAutoDefaultMdPath = info.key;
			});
			return { setActivePath, setDocsLoading, setDocs, activeTab, dispose };
		});
		try {
			// Initial flush while docs are still loading: tab is outline and path is NOT latched yet.
			flush();
			expect(ctx.activeTab()).toBe("outline");
			expect(lastAutoDefaultMdPath).toBe("");

			// Docs finish loading with LIMS-42 ticket entry: effect re-runs, switches to Info, and latches.
			ctx.setDocs([{ group: "tickets", ticket: "LIMS-42", path: "/ws/docs/tickets/LIMS-42.md" }]);
			ctx.setDocsLoading(false);
			flush();
			expect(ctx.activeTab()).toBe("info");
			expect(lastAutoDefaultMdPath).toBe("/ws/docs/tickets/lims-42.md");

			// Switching to a plain non-ticket Markdown file updates to outline and latches.
			ctx.setActivePath("/ws/docs/readme.md");
			flush();
			expect(ctx.activeTab()).toBe("outline");
			expect(lastAutoDefaultMdPath).toBe("/ws/docs/readme.md");
		} finally {
			ctx.dispose();
		}
	});
});

describe("Solid 2.0.3 Audit Pass 2 — Search.tsx noReplace(true) replace/preview handoff", () => {
	test("Search.tsx separates reactive noReplace() from synchronous noReplace(true) in executeReplace and previewReplace", () => {
		const src = readSrc("../src/view/panels/Search.tsx");
		expect(src).toContain("const noReplace = (ignoreReplaceActive = false) => {");
		expect(src).toContain('if (status() === "busy" || (!ignoreReplaceActive && replaceActive())) return "The search is still running";');

		const execStart = src.indexOf("const executeReplace = async (skipConfirm: boolean) => {");
		const previewStart = src.indexOf("const previewReplace = async () => {", execStart);
		expect(execStart).toBeGreaterThan(0);
		expect(previewStart).toBeGreaterThan(execStart);

		expect(src.slice(execStart, execStart + 200)).toContain("if (replaceBusy || noReplace(true)) return;");
		expect(src.slice(previewStart, previewStart + 200)).toContain("if (replaceBusy || noReplace(true)) return;");
		// Both handoffs must exit the try block without early-returning past the post-finally handoff check.
		expect(src.slice(execStart, previewStart)).toContain("handoffToPreview = true;\n\t\t\t\t\t\tbreak replaceBody;");
		expect(src.slice(previewStart, previewStart + 4200)).not.toContain("applyAfter = true;\n\t\t\t\treturn;");
		// Reactive button guards keep noReplace() with default ignoreReplaceActive = false.
		expect(src).toContain('aria-disabled={noReplace() ? "true" : undefined}');
	});

	test("executeReplace -> previewReplace and previewReplace -> executeReplace(true) hand off cleanly without waiting for deferred setReplaceActive(false) flush", async () => {
		const ctx = createRoot((dispose) => {
			const [status, setStatus] = createSignal<"done" | "busy">("done");
			const [replaceActive, setReplaceActive] = createSignal(false);
			let replaceBusy = false;
			const events: string[] = [];

			const noReplace = (ignoreReplaceActive = false) => {
				if (status() === "busy" || (!ignoreReplaceActive && replaceActive())) return "The search is still running";
				return "";
			};

			const executeReplace = async (skipConfirm: boolean, choosePreview = false) => {
				if (replaceBusy || noReplace(true)) {
					events.push("execute:aborted");
					return;
				}
				replaceBusy = true;
				setReplaceActive(true);
				let handoffToPreview = false;
				replaceBody: try {
					if (!skipConfirm && choosePreview) {
						await Promise.resolve();
						handoffToPreview = true;
						break replaceBody;
					}
					events.push(skipConfirm ? "execute:applied-from-preview" : "execute:applied-direct");
				} finally {
					replaceBusy = false;
					setReplaceActive(false);
				}
				if (handoffToPreview) {
					// Deferred Solid 2 write: replaceActive() is still true before flush, but noReplace(true) allows handoff.
					expect(replaceActive()).toBe(true);
					await previewReplace(false);
				}
			};

			const previewReplace = async (applyOnPick: boolean) => {
				if (replaceBusy || noReplace(true)) {
					events.push("preview:aborted");
					return;
				}
				replaceBusy = true;
				setReplaceActive(true);
				let applyAfter = false;
				try {
					events.push("preview:opened");
					await Promise.resolve();
					if (applyOnPick) applyAfter = true;
				} finally {
					replaceBusy = false;
					setReplaceActive(false);
				}
				if (applyAfter) {
					expect(replaceActive()).toBe(true);
					await executeReplace(true);
				}
			};

			return { setStatus, replaceActive, noReplace, executeReplace, previewReplace, events, dispose };
		});

		try {
			flush();
			// Flow 1: Replace all -> Preview changes…
			await ctx.executeReplace(false, true);
			flush();
			expect(ctx.events).toEqual(["preview:opened"]);
			expect(ctx.replaceActive()).toBe(false);

			// Flow 2: Preview… -> Apply replace
			ctx.events.length = 0;
			await ctx.previewReplace(true);
			flush();
			expect(ctx.events).toEqual(["preview:opened", "execute:applied-from-preview"]);
			expect(ctx.replaceActive()).toBe(false);
			expect(ctx.noReplace()).toBe("");
		} finally {
			ctx.dispose();
		}
	});
});

describe("Solid 2.0.3 Audit Pass 2 — Palette.tsx DraftInput/DraftTextarea snap-back & Escape revert", () => {
	test("Palette.tsx imports onSettled and handles Escape revert & post-commit snap-back in DraftInput and DraftTextarea", () => {
		const src = readSrc("../src/view/panels/Palette.tsx");
		expect(src).toContain("onSettled");
		const draftStart = src.indexOf("const DraftInput =");
		const draftEnd = src.indexOf("const showTemplate =", draftStart);
		expect(draftStart).toBeGreaterThan(0);
		expect(draftEnd).toBeGreaterThan(draftStart);
		const draftSrc = src.slice(draftStart, draftEnd);

		expect(draftSrc.match(/let reverted = false;/g)?.length).toBe(2);
		expect(draftSrc.match(/e\.key === "Escape"/g)?.length).toBe(2);
		expect(draftSrc.match(/onSettled\(\(\) => \{/g)?.length).toBe(2);
		expect(draftSrc).toContain("if (reverted) {");
		expect(draftSrc).toContain("const cur = untrack(() => props.value);");
	});

	test("DraftInput snaps back on rejected/trimmed commits via onSettled and reverts without committing on Escape", () => {
		const committedCalls: string[] = [];
		const ctx = createRoot((dispose) => {
			const [committed, setCommitted] = createSignal("Validate");
			const [draft, setDraft] = createSignal(untrack(committed));
			let reverted = false;
			let disposed = false;
			onCleanup(() => {
				disposed = true;
			});

			const onCommit = (raw: string) => {
				committedCalls.push(raw);
				const trimmed = raw.trim();
				if (!trimmed) return; // Rejected empty label
				setCommitted(trimmed);
			};

			const syncVal = createMemo(
				() => ({ key: "n1", value: committed() }),
				{ equals: (a, b) => a.key === b.key && a.value === b.value },
			);
			createEffect(syncVal, ({ value }) => {
				setDraft(value);
			});

			const el = { value: "Validate", blurred: 0, blur() { this.blurred++; } };

			const triggerInput = (v: string) => {
				reverted = false;
				el.value = v;
				setDraft(v);
			};
			const triggerFocus = () => {
				reverted = false;
			};
			const triggerEscape = () => {
				let prevented = false;
				let stopped = false;
				reverted = true;
				prevented = true;
				stopped = true;
				const cur = untrack(committed);
				setDraft(cur);
				el.value = cur;
				el.blur();
				return { prevented, stopped };
			};
			const triggerChange = () => {
				if (reverted) {
					reverted = false;
					return;
				}
				onCommit(el.value);
				onSettled(() => {
					if (disposed) return;
					const cur = untrack(committed);
					setDraft(cur);
					if (el.value !== cur) el.value = cur;
				});
			};

			return { committed, draft, el, triggerInput, triggerFocus, triggerEscape, triggerChange, dispose };
		});

		try {
			flush();

			// 1. Rejected empty commit snaps back to committed value after flush/onSettled.
			ctx.triggerInput("");
			flush();
			expect(ctx.draft()).toBe("");
			ctx.triggerChange();
			flush();
			expect(committedCalls).toEqual([""]);
			expect(ctx.committed()).toBe("Validate");
			expect(ctx.draft()).toBe("Validate");
			expect(ctx.el.value).toBe("Validate");

			// 2. Whitespace-padded commit matching committed value trims and snaps back cleanly.
			ctx.triggerInput("  Validate  ");
			flush();
			ctx.triggerChange();
			flush();
			expect(ctx.draft()).toBe("Validate");
			expect(ctx.el.value).toBe("Validate");

			// 3. Pressing Escape reverts immediately and suppresses subsequent change commit on blur.
			ctx.triggerInput("Temporary draft");
			flush();
			expect(ctx.draft()).toBe("Temporary draft");
			const esc = ctx.triggerEscape();
			expect(esc).toEqual({ prevented: true, stopped: true });
			expect(ctx.el.blurred).toBe(1);
			expect(ctx.el.value).toBe("Validate");
			// Even if browser fires change during blur, commit must be suppressed.
			ctx.triggerChange();
			flush();
			expect(committedCalls).toEqual(["", "  Validate  "]);
			expect(ctx.committed()).toBe("Validate");
			expect(ctx.draft()).toBe("Validate");

			// 4. Subsequent focus + edit + commit works normally after Escape.
			ctx.triggerFocus();
			ctx.triggerInput("  Approve sample  ");
			flush();
			ctx.triggerChange();
			flush();
			expect(ctx.committed()).toBe("Approve sample");
			expect(ctx.draft()).toBe("Approve sample");
			expect(ctx.el.value).toBe("Approve sample");
		} finally {
			ctx.dispose();
		}
	});
});

describe("Solid 2.0.3 Audit Pass 2 — MarkdownInspector.tsx frontRaw, query memos, keyed <For>, yamlCompleter cleanup & kindVersion", () => {
	test("MarkdownInspector.tsx wires kindVersion, frontRaw, structural query memos, untrack(docs), keyed <For>, yamlOpenForEdit, and yamlCompleter onCleanup", () => {
		const src = readSrc("../src/view/panels/MarkdownInspector.tsx");

		const activeDocStart = src.indexOf("const activeMdDoc = createMemo(() => {");
		expect(activeDocStart).toBeGreaterThan(0);
		expect(src.slice(activeDocStart, activeDocStart + 180)).toContain("void state.kindVersion;");

		expect(src).toContain("const frontRaw = createMemo(() => {");
		expect(src).toContain("const front = createMemo(() => frontMatter(frontRaw()));");
		expect(src).toContain("const yamlOpenForEdit = createMemo(() => !isRead() && propsOpen() && editYaml() && Boolean(yamlSpan()));");

		expect(src).toContain("const linkedQuerySource = createMemo(");
		expect(src).toContain("const [linked] = createAsyncQuery(\n\t\tlinkedQuerySource,");
		expect(src).toContain("const files = untrack(docs);");

		expect(src).toContain("const unlinkedQuerySource = createMemo(");
		expect(src).toContain("const [unlinkedMentions] = createAsyncQuery(\n\t\tunlinkedQuerySource,");
		expect(src).toContain("for (const d of untrack(docs)) {");

		expect(src).toContain("<For each={groupedFacts().primary} keyed={(f) => f.key}>");
		expect(src).toContain("<For each={groupedFacts().governance} keyed={(f) => f.key}>");
		expect(src).toContain("{(fact) => <PropertyRow fact={fact()} />}");

		const yamlShowStart = src.indexOf("<Show when={!isRead() && editYaml() && yamlSpan()}>");
		expect(yamlShowStart).toBeGreaterThan(0);
		const yamlShowHead = src.slice(yamlShowStart, yamlShowStart + 260);
		expect(yamlShowHead).toContain("onCleanup(() => {");
		expect(yamlShowHead).toContain("yamlCompleter?.dispose();");
		expect(yamlShowHead).toContain("yamlCompleter = undefined;");
		expect(yamlShowHead).toContain("yamlInputEl = undefined;");
	});

	test("frontRaw matches frontMatter(text) on all fence/EOL variants and prevents front recomputation on body keystrokes", () => {
		const extractFrontRaw = (t: string) => {
			const span = frontMatterInnerSpan(t);
			if (!span) return "";
			const closeNl = t.indexOf("\n", span.end);
			const closeEnd = closeNl < 0 ? t.length : t[closeNl - 1] === "\r" ? closeNl - 1 : closeNl;
			return t.slice(0, closeEnd);
		};

		const samples = [
			"---\ntitle: Spec\ntags: [a, b]\n---\n# Heading\nBody",
			"---\ntitle: Spec\n---",
			"---\r\ntitle: Spec\r\nstatus: open\r\n---\r\nBody line",
			"---\n---\nBody after empty fm",
			"---\ntitle: Ellipsis\n...\nBody",
			"<!-- template: spec -->\n---\ntitle: Templated\n---\nBody",
			"\uFEFF---\ntitle: Bom\n---\nBody",
			"# Plain doc without frontmatter\nParagraph",
			"---\ntitle: Unclosed\nNo closing fence",
		];
		for (const sample of samples) {
			const expected = frontMatter(sample);
			const actual = frontMatter(extractFrontRaw(sample));
			expect(actual.values).toEqual(expected.values);
			expect(actual.lines).toBe(expected.lines);
		}

		let frontRuns = 0;
		const ctx = createRoot((dispose) => {
			const [text, setText] = createSignal("---\ntitle: Spec\nstatus: open\n---\nHello");
			const yamlSpan = createMemo(() => frontMatterInnerSpan(text()), {
				equals: (a, b) =>
					a === b ||
					(Boolean(a && b) && a!.start === b!.start && a!.end === b!.end && a!.inner === b!.inner && a!.eol === b!.eol),
			});
			const frontRaw = createMemo(() => {
				const t = text();
				const span = yamlSpan();
				if (!span) return "";
				const closeNl = t.indexOf("\n", span.end);
				const closeEnd = closeNl < 0 ? t.length : t[closeNl - 1] === "\r" ? closeNl - 1 : closeNl;
				return t.slice(0, closeEnd);
			});
			const front = createMemo(() => {
				frontRuns++;
				return frontMatter(frontRaw());
			});
			return { setText, front, dispose };
		});

		try {
			flush();
			expect(ctx.front().values.status).toBe("open");
			expect(frontRuns).toBe(1);

			// Body keystrokes must NOT re-parse frontmatter.
			ctx.setText("---\ntitle: Spec\nstatus: open\n---\nHello world");
			flush();
			ctx.setText("---\ntitle: Spec\nstatus: open\n---\nHello world\nMore prose");
			flush();
			expect(ctx.front().values.status).toBe("open");
			expect(frontRuns).toBe(1);

			// Frontmatter edit DOES re-parse frontmatter.
			ctx.setText("---\ntitle: Spec\nstatus: done\n---\nHello world\nMore prose");
			flush();
			expect(ctx.front().values.status).toBe("done");
			expect(frontRuns).toBe(2);
		} finally {
			ctx.dispose();
		}
	});

	test("structural query memos with untrack(docs) keep backlinks & unlinked mentions stable across mode toggles and identical doc snapshots", async () => {
		let linkedFetches = 0;
		let unlinkedFetches = 0;
		const ctx = createRoot((dispose) => {
			const [path, setPath] = createSignal("/ws/docs/spec.md");
			const [root] = createSignal("/ws");
			const [rev] = createSignal(0);
			const [mode, setMode] = createSignal<"live" | "read">("live");
			const [docsSig, setDocsSig] = createSignal([{ path: "/ws/docs/spec.md", title: "Spec" }, { path: "/ws/docs/ref.md", title: "Ref" }]);
			const docsFingerprint = createMemo(() => `${docsSig().length}:${docsSig().map((d) => `${d.path}|${d.title}`).join("\n")}`);

			const linkedQuerySource = createMemo(
				() => {
					const p = path();
					const r = root();
					return p && r ? { path: p, sig: docsFingerprint(), root: r, rev: rev() } : null;
				},
				{
					equals: (a, b) =>
						a === b ||
						(Boolean(a && b) && a!.path === b!.path && a!.sig === b!.sig && a!.root === b!.root && a!.rev === b!.rev),
				},
			);

			const [linked] = createAsyncQuery(linkedQuerySource, async (src) => {
				linkedFetches++;
				const files = untrack(docsSig);
				await Promise.resolve();
				return { path: src.path, root: src.root, value: files.map((f) => f.path) };
			});

			const unlinkedQuerySource = createMemo(
				() => {
					const p = path();
					const r = root();
					const back = linked();
					if (!p || !r || linked.loading || !back || back.path !== p || back.root !== r) return null;
					const linkedPaths = back.value;
					return { path: p, root: r, title: "Spec", ticket: "", stem: "spec", sig: docsFingerprint(), linkedPaths, linkedKey: linkedPaths.join("\0"), rev: rev() };
				},
				{
					equals: (a, b) =>
						a === b ||
						(Boolean(a && b) &&
							a!.path === b!.path &&
							a!.root === b!.root &&
							a!.title === b!.title &&
							a!.ticket === b!.ticket &&
							a!.stem === b!.stem &&
							a!.sig === b!.sig &&
							a!.linkedKey === b!.linkedKey &&
							a!.rev === b!.rev),
				},
			);

			const [unlinked] = createAsyncQuery(unlinkedQuerySource, async (src) => {
				unlinkedFetches++;
				const files = untrack(docsSig);
				await Promise.resolve();
				return { path: src.path, root: src.root, count: files.length };
			});

			return { setPath, setMode, setDocsSig, linked, unlinked, mode, dispose };
		});

		try {
			flush();
			await Promise.resolve();
			await Promise.resolve();
			flush();
			await Promise.resolve();
			await Promise.resolve();
			flush();

			expect(linkedFetches).toBe(1);
			expect(unlinkedFetches).toBe(1);
			expect(ctx.linked()?.value.length).toBe(2);
			expect(ctx.linked.loading).toBe(false);
			expect(ctx.unlinked()?.count).toBe(2);

			// Toggle Live -> Read and push a fresh docs array with identical fingerprint: no refetch, no drop to 0.
			ctx.setMode("read");
			ctx.setDocsSig([{ path: "/ws/docs/spec.md", title: "Spec" }, { path: "/ws/docs/ref.md", title: "Ref" }]);
			flush();
			await Promise.resolve();
			flush();
			expect(linkedFetches).toBe(1);
			expect(unlinkedFetches).toBe(1);
			expect(ctx.linked.loading).toBe(false);
			expect(ctx.linked()?.value.length).toBe(2);
		} finally {
			ctx.dispose();
		}
	});
});

describe("Solid 2.0.3 Audit Pass 2 — StyleProfile.tsx <select> snap-back, inheritedValue & scope reset", () => {
	test("StyleProfile.tsx imports onSettled, adds inheritedValue + scope reset effect, and resyncs choice <select> in onSettled", () => {
		const src = readSrc("../src/view/StyleProfile.tsx");
		expect(src).toContain("onSettled");
		expect(src).toContain('() => !state.workspace && scope() === "workspace"');
		expect(src).toContain('if (reset) setScope("user");');
		expect(src).toContain("const inheritedValue = (path: PathKey) => {");
		expect(src).toContain('return String(inheritedValue(field.path) ?? "");');
		expect(src).toContain('const next = String(untrack(() => displayed(f.path) ?? ""));');
		expect(src).toContain("if (el.value !== next) el.value = next;");
	});

	test("inheritedValue resolves fallback immediately before flush, choice <select> snaps back in onSettled, and scope resets on workspace close", () => {
		const ctx = createRoot((dispose) => {
			const [hasWorkspace, setHasWorkspace] = createSignal(true);
			const [scope, setScope] = createSignal<"user" | "workspace">("workspace");
			const [layers, setLayers] = createSignal<{ user: Record<string, any>; workspace: Record<string, any> }>({
				user: {},
				workspace: { format: { indentSize: 2 } },
			});

			createEffect(
				() => !hasWorkspace() && scope() === "workspace",
				(reset) => {
					if (reset) setScope("user");
				},
			);

			const displayed = (path: string) => {
				if (scope() === "user") {
					return getPath(layers().user, path) ?? getPath(HOUSE_STYLE, path) ?? getPath(SERVER_DEFAULTS, path);
				}
				return getPath(layers().workspace, path) ?? getPath(layers().user, path) ?? getPath(HOUSE_STYLE, path) ?? getPath(SERVER_DEFAULTS, path);
			};
			const inheritedValue = (path: string) => {
				if (scope() === "user") {
					return getPath(HOUSE_STYLE, path) ?? getPath(SERVER_DEFAULTS, path);
				}
				return getPath(layers().user, path) ?? getPath(HOUSE_STYLE, path) ?? getPath(SERVER_DEFAULTS, path);
			};
			const set = (path: string, value: unknown) => {
				const targetScope = scope();
				setLayers((prev) => ({ ...prev, [targetScope]: setPath(prev[targetScope], path, value) }));
			};

			const selectEl = { value: "tab" };
			const chooseServerDefault = () => {
				selectEl.value = "";
				set("format.indentStyle", undefined);
				onSettled(() => {
					const next = String(untrack(() => displayed("format.indentStyle") ?? ""));
					if (selectEl.value !== next) selectEl.value = next;
				});
			};

			return { setHasWorkspace, scope, setScope, displayed, inheritedValue, set, selectEl, chooseServerDefault, dispose };
		});

		try {
			flush();

			// 1. Clearing a workspace number override returns inherited server default (4) immediately before flush.
			ctx.set("format.indentSize", undefined);
			expect(String(ctx.inheritedValue("format.indentSize") ?? "")).toBe("4");
			flush();
			expect(ctx.displayed("format.indentSize")).toBe(4);

			// 2. Picking "server default" ("") on a choice <select> snaps visually back to inherited "tab" in onSettled.
			ctx.chooseServerDefault();
			expect(ctx.selectEl.value).toBe("");
			flush();
			expect(ctx.selectEl.value).toBe("tab");

			// 3. Closing workspace while scope === "workspace" resets scope to "user".
			expect(ctx.scope()).toBe("workspace");
			ctx.setHasWorkspace(false);
			flush();
			expect(ctx.scope()).toBe("user");
		} finally {
			ctx.dispose();
		}
	});
});

describe("Solid 2.0.3 Audit Pass 2 — Settings.tsx failed-save DraftInput revert & Git.tsx scope button .on guard", () => {
	test("Settings.tsx save() returns Promise<boolean> and DraftInput reverts to committed value when async commit fails", async () => {
		const src = readSrc("../src/view/Settings.tsx");
		expect(src).toContain("const save = async <K extends keyof Settings>(key: K, value: Settings[K] | null): Promise<boolean> => {");
		expect(src).toContain("return saved;");
		expect(src).toContain("onCommit: (value: string, el: HTMLInputElement) => Promise<string | false | void> | string | false | void;");
		expect(src).toContain("const next = result === false ? untrack(committed) : typeof result === \"string\" ? result : undefined;");

		let resolveFirstSave!: (ok: boolean) => void;
		const ctx = createRoot((dispose) => {
			const [committed, setCommitted] = createSignal("13");
			const [draft, setDraft] = createSignal(untrack(committed));
			let seq = 0;
			let disposed = false;
			onCleanup(() => {
				disposed = true;
			});
			createEffect(committed, (v) => {
				setDraft(v);
			});

			const el = { value: "13" };
			const onInput = (v: string) => {
				seq++;
				el.value = v;
				setDraft(v);
			};
			const onChange = (onCommit: (v: string) => Promise<string | false | void> | string | false | void) => {
				const mySeq = ++seq;
				const apply = (result: string | false | void) => {
					if (disposed || seq !== mySeq) return;
					const next = result === false ? untrack(committed) : typeof result === "string" ? result : undefined;
					if (next !== undefined) {
						setDraft(next);
						if (el.value !== next) el.value = next;
					}
				};
				const res = onCommit(el.value);
				if (res !== null && typeof res === "object") {
					void res.then(apply, () => apply(false));
				} else {
					apply(res);
				}
			};
			return { setCommitted, draft, el, onInput, onChange, dispose };
		});

		try {
			flush();

			// Failed async save reverts draft & input element back to committed "13".
			ctx.onInput("24");
			flush();
			ctx.onChange(async (): Promise<false> => false);
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(ctx.draft()).toBe("13");
			expect(ctx.el.value).toBe("13");

			// Stale failed save must not clobber newer user input typed while save was in-flight.
			ctx.onInput("20");
			flush();
			ctx.onChange(
				() =>
					new Promise<string | false>((resolve) => {
						resolveFirstSave = (ok) => resolve(ok ? "20" : false);
					}),
			);
			ctx.onInput("18");
			flush();
			resolveFirstSave(false);
			await Promise.resolve();
			await Promise.resolve();
			flush();
			expect(ctx.draft()).toBe("18");
			expect(ctx.el.value).toBe("18");
		} finally {
			ctx.dispose();
		}
	});

	test("Git.tsx guards ticket scope buttons .on class with ticket key presence so disabled buttons are never active", () => {
		const src = readSrc("../src/view/panels/Git.tsx");
		expect(src).toContain('class={{ on: Boolean(activeTicketKey()) && (commitScope() === "active" || !fileTicketKey()) }}');
		expect(src).toContain('class={{ on: Boolean(fileTicketKey()) && (commitScope() === "file" || !activeTicketKey()) }}');

		const states = (active: string, file: string, scope: "active" | "file") => ({
			activeOn: Boolean(active) && (scope === "active" || !file),
			fileOn: Boolean(file) && (scope === "file" || !active),
		});

		expect(states("", "LIMS-9", "active")).toEqual({ activeOn: false, fileOn: true });
		expect(states("", "LIMS-9", "file")).toEqual({ activeOn: false, fileOn: true });
		expect(states("LIMS-1", "", "file")).toEqual({ activeOn: true, fileOn: false });
		expect(states("LIMS-1", "", "active")).toEqual({ activeOn: true, fileOn: false });
		expect(states("LIMS-1", "LIMS-9", "active")).toEqual({ activeOn: true, fileOn: false });
		expect(states("LIMS-1", "LIMS-9", "file")).toEqual({ activeOn: false, fileOn: true });
		expect(states("", "", "active")).toEqual({ activeOn: false, fileOn: false });
	});
});
