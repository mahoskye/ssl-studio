import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createEffect, createMemo, createRoot, createSignal, flush, untrack } from "solid-js";
import { setPath } from "../src/shared/styleProfile";
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

	test("Agent.tsx ensureAgentWorkspace returns boolean, runAskAbout uses snapshot(agent).chatSession and explicit flags", () => {
		const src = readSrc("../src/view/agent/Agent.tsx");
		expect(src).toContain("function ensureAgentWorkspace(): boolean");
		expect(src).toContain("const didReset = ensureAgentWorkspace();");
		expect(src).toContain("const picked = didReset ? null : pickedTicket();");
		expect(src).toContain("includeSchema: didReset ? false : withSchema(),");
		expect(src).toContain("includeRegistries: didReset ? false : withRegistries(),");
		expect(src).toContain("includeState: didReset ? false : withState(),");

		const runStart = src.indexOf("async function runAskAbout(");
		const runEnd = src.indexOf("export async function askAbout(", runStart);
		expect(runStart).toBeGreaterThan(0);
		expect(runEnd).toBeGreaterThan(runStart);
		const runSrc = src.slice(runStart, runEnd);

		expect(runSrc).toContain("const chatSession = snapshot(agent).chatSession;");
		expect(runSrc).toContain("sessionID: chatSession ?? undefined,");
		expect(runSrc).not.toContain("agent.chatSession");
		expect(runSrc).toContain("withGitDiff: didReset ? false : withGitDiff(),");
		expect(runSrc).toContain("withGoverningDocs: didReset ? false : withGoverningDocs(),");
		expect(runSrc).toContain("withRefTables: didReset ? false : withRefTables(),");

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
		expect(src).toContain("createSignal(untrack(() => props.value))");
		expect(inspSrc).toContain('onCommit={(val) => plan.setPlanField("title", val)}');
		expect(inspSrc).toContain('onCommit={(val) => plan.setPlanField("goal", val)}');
		expect(inspSrc).toContain('onCommit={(val) => plan.setPlanField("ticket", val)}');
		expect(inspSrc).toContain("onCommit={(val) => plan.setNodeText(val)}");
		expect(inspSrc).toContain("onCommit={(val) => plan.setNodeGroup(val)}");
		expect(inspSrc).toContain('onCommit={(val) => plan.setNodeField("notes", val)}');
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
		expect(src).toContain("onInput={(e) => setDraft(e.currentTarget.value)}");
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
		expect(src).toContain("onInput={(e) => setDraft(e.currentTarget.value)}");
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
