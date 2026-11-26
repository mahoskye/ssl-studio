import { describe, expect, mock, test } from "bun:test";
import { createEffect, createRoot, createSignal, flush, mapArray, onSettled, untrack } from "solid-js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KEEP, REPLACE, reviewFlow, type Reviewable } from "../src/view/editor/reviewFlow";

// Minimal headless browser & Monaco shims so hoverSeverity can be imported directly under Bun tests.
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
}
if (typeof (globalThis as any).document === "undefined") {
	(globalThis as any).document = {
		documentElement: { dataset: {}, style: {} },
		createElement: () => ({ style: {} }),
		querySelector: () => null,
	};
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

class MockUri {
	constructor(
		public readonly scheme: string,
		public readonly path: string,
	) {}
	get fsPath() {
		return this.path;
	}
	toString() {
		return this.scheme === "file" ? `file://${encodeURI(this.path)}` : `${this.scheme}:${this.path}`;
	}
	static file(p: string) {
		return new MockUri("file", p.replace(/\\/g, "/"));
	}
	static parse(raw: string) {
		if (raw.startsWith("file://")) return new MockUri("file", decodeURI(raw.slice("file://".length)));
		const idx = raw.indexOf(":");
		return idx >= 0 ? new MockUri(raw.slice(0, idx), raw.slice(idx + 1)) : new MockUri("file", raw);
	}
	static from(parts: { scheme: string; path?: string }) {
		return new MockUri(parts.scheme, parts.path ?? "/");
	}
}

const mockMarkers = new Map<string, Map<string, any[]>>();
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
	Uri: MockUri,
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: {},
	languages: noopProxy({}),
	editor: noopProxy({
		ScrollType: { Immediate: 1 },
		getEditors: () => [],
		getModels: () => [],
		getModel: () => null,
		setModelMarkers: (model: any, owner: string, markers: any[]) => {
			const key = model.uri.toString();
			let byOwner = mockMarkers.get(key);
			if (!byOwner) {
				byOwner = new Map();
				mockMarkers.set(key, byOwner);
			}
			byOwner.set(owner, markers);
		},
		getModelMarkers: (filter?: { resource?: { toString(): string } }) => {
			if (filter?.resource) {
				const byOwner = mockMarkers.get(filter.resource.toString());
				return byOwner ? [...byOwner.values()].flat() : [];
			}
			return [...mockMarkers.values()].flatMap((m) => [...m.values()].flat());
		},
	}),
}));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({ default: class {} }));

const { monaco } = await import("../src/view/editor/monaco");
const { observeMarkerHoverSeverity, resolveMarkerHoverSeverity, severityFromIcon } = await import(
	"../src/view/editor/hoverSeverity"
);

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

/** Builds a DOM fixture matching Monaco 0.58.0's `.hover-row > .marker.hover-contents` structure. */
function makeMonaco058Row(opts: {
	iconClasses: string[];
	ariaLabel?: string;
	message: string;
	detail?: string;
	related?: string;
}) {
	const row: any = { dataset: {} as Record<string, string> };
	const iconEl: any = {
		className: ["marker-severity", ...opts.iconClasses].join(" "),
		classList: {
			contains: (cls: string) => cls === "marker-severity" || opts.iconClasses.includes(cls),
		},
		getAttribute: (name: string) => (name === "aria-label" ? (opts.ariaLabel ?? null) : null),
	};
	const messageSpans: any[] = [{ innerText: opts.message, textContent: opts.message }];
	if (opts.detail !== undefined) {
		messageSpans.push({ innerText: opts.detail, textContent: opts.detail });
	}
	const messageContainer: any = {
		innerText: [opts.message, opts.detail ?? "", opts.related ?? ""].filter(Boolean).join(" "),
		textContent: [opts.message, opts.detail ?? "", opts.related ?? ""].filter(Boolean).join(" "),
		querySelectorAll: (sel: string) => (sel === ":scope > span" ? messageSpans : []),
	};
	const markerEl: any = {
		innerText: messageContainer.innerText,
		textContent: messageContainer.textContent,
		closest: (sel: string) => (sel === ".hover-row" ? row : null),
		querySelector: (sel: string) => {
			if (sel === ":scope > .marker-message") return messageContainer;
			if (sel === ":scope > .marker-severity") return iconEl;
			return null;
		},
		querySelectorAll: (sel: string) => {
			if (sel === ":scope > span") return [iconEl];
			if (sel === ":scope > span:not(.marker-severity)") return [];
			return [];
		},
	};
	return { row, markerEl, iconEl, messageContainer };
}

describe("Monaco 0.58.0 diagnostic hover severity & style.css regression", () => {
	test("resolveMarkerHoverSeverity extracts Monaco 0.58.0 .marker-message spans and matches all 4 severities", () => {
		const markers = [
			{ message: "Unknown procedure Foo", severity: 8, source: "starlims-lsp", code: "SSL001", startLineNumber: 3, endLineNumber: 3 },
			{ message: "Implicit global x", severity: 4, source: "starlims-lsp", code: "SSL002", startLineNumber: 5, endLineNumber: 5 },
			{ message: "Deprecated call", severity: 2, source: "starlims-lsp", code: "SSL003", startLineNumber: 7, endLineNumber: 7 },
			{ message: "Unused helper note", severity: 1, source: "starlims-lsp", code: "SSL004", startLineNumber: 9, endLineNumber: 9 },
		];

		const err = makeMonaco058Row({
			iconClasses: ["codicon", "codicon-error"],
			ariaLabel: "Error",
			message: "Unknown procedure Foo",
			detail: "starlims-lsp(SSL001)",
		});
		const warn = makeMonaco058Row({
			iconClasses: ["codicon", "codicon-warning"],
			ariaLabel: "Warning",
			message: "Implicit global x",
			detail: "starlims-lsp(SSL002)",
		});
		const info = makeMonaco058Row({
			iconClasses: ["codicon", "codicon-info"],
			ariaLabel: "Info",
			message: "Deprecated call",
			detail: "starlims-lsp(SSL003)",
		});
		// Hint rendered with plain codicon-info (no severity-ignore): marker match preserves "hint" vs "info".
		const hint = makeMonaco058Row({
			iconClasses: ["codicon", "codicon-info"],
			message: "Unused helper note",
			detail: "starlims-lsp(SSL004)",
		});

		expect(resolveMarkerHoverSeverity(err.markerEl, markers, 3)).toBe("error");
		expect(resolveMarkerHoverSeverity(warn.markerEl, markers, 5)).toBe("warning");
		expect(resolveMarkerHoverSeverity(info.markerEl, markers, 7)).toBe("info");
		expect(resolveMarkerHoverSeverity(hint.markerEl, markers, 9)).toBe("hint");
	});

	test("falls back to .marker-severity codicon classes when markers are empty or unmatched (errors never become warnings)", () => {
		const err = makeMonaco058Row({
			iconClasses: ["codicon", "codicon-error"],
			ariaLabel: "Error",
			message: "Syntax error near ';'",
			detail: "starlims-lsp(SSL099)",
		});
		const warn = makeMonaco058Row({
			iconClasses: ["codicon", "codicon-warning"],
			ariaLabel: "Warning",
			message: "Unreachable branch",
		});
		const info = makeMonaco058Row({
			iconClasses: ["codicon", "codicon-info"],
			ariaLabel: "Info",
			message: "Informational note",
		});
		const hintByClass = makeMonaco058Row({
			iconClasses: ["severity-ignore", "codicon", "codicon-info"],
			ariaLabel: "Hint",
			message: "Subtle suggestion",
		});
		const hintByAria = makeMonaco058Row({
			iconClasses: ["codicon", "codicon-info"],
			ariaLabel: "Hint",
			message: "Subtle suggestion 2",
		});

		expect(severityFromIcon(err.iconEl)).toBe("error");
		expect(severityFromIcon(warn.iconEl)).toBe("warning");
		expect(severityFromIcon(info.iconEl)).toBe("info");
		expect(severityFromIcon(hintByClass.iconEl)).toBe("hint");
		expect(severityFromIcon(hintByAria.iconEl)).toBe("hint");

		expect(resolveMarkerHoverSeverity(err.markerEl, [], 1)).toBe("error");
		expect(resolveMarkerHoverSeverity(warn.markerEl, [], 1)).toBe("warning");
		expect(resolveMarkerHoverSeverity(info.markerEl, [], 1)).toBe("info");
		expect(resolveMarkerHoverSeverity(hintByClass.markerEl, [], 1)).toBe("hint");
		expect(resolveMarkerHoverSeverity(hintByAria.markerEl, [], 1)).toBe("hint");
	});

	test("observeMarkerHoverSeverity stamps data-severity on Monaco 0.58.0 hover rows", () => {
		const prevMO = (globalThis as any).MutationObserver;
		let onMutate: (() => void) | null = null;
		(globalThis as any).MutationObserver = class {
			constructor(cb: () => void) {
				onMutate = cb;
			}
			observe() {}
			disconnect() {}
		};
		const uri = MockUri.parse("file:///ws/monaco58-hover.ssl");
		const fakeModel: any = { uri };
		try {
			monaco.editor.setModelMarkers(fakeModel, "starlims-lsp", [
				{ message: "Bad return type", severity: 8, source: "starlims-lsp", code: "SSL100", startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 10 },
				{ message: "Style suggestion", severity: 1, source: "starlims-lsp", code: "SSL200", startLineNumber: 6, startColumn: 1, endLineNumber: 6, endColumn: 10 },
			]);

			const errRow = makeMonaco058Row({
				iconClasses: ["codicon", "codicon-error"],
				ariaLabel: "Error",
				message: "Bad return type",
				detail: "starlims-lsp(SSL100)",
			});
			const hintRow = makeMonaco058Row({
				iconClasses: ["codicon", "codicon-info"],
				message: "Style suggestion",
				detail: "starlims-lsp(SSL200)",
			});
			const unmatchedErrRow = makeMonaco058Row({
				iconClasses: ["codicon", "codicon-error"],
				ariaLabel: "Error",
				message: "Detached error without marker",
			});

			const root: any = {
				querySelector: () => root,
				querySelectorAll: (sel: string) =>
					sel === ".monaco-hover .marker.hover-contents"
						? [errRow.markerEl, hintRow.markerEl, unmatchedErrRow.markerEl]
						: [],
			};
			const fakeEditor: any = {
				getModel: () => fakeModel,
				getDomNode: () => root,
				getPosition: () => ({ lineNumber: 4, column: 1 }),
				onMouseMove: () => ({ dispose() {} }),
				onDidChangeModel: () => ({ dispose() {} }),
			};

			const stop = observeMarkerHoverSeverity(fakeEditor);
			expect(errRow.row.dataset.severity).toBe("error");
			expect(hintRow.row.dataset.severity).toBe("hint");
			expect(unmatchedErrRow.row.dataset.severity).toBe("error");

			// Re-verify after mutation callback with markers cleared (icon fallback keeps error).
			monaco.editor.setModelMarkers(fakeModel, "starlims-lsp", []);
			onMutate!();
			expect(errRow.row.dataset.severity).toBe("error");
			expect(unmatchedErrRow.row.dataset.severity).toBe("error");
			stop();
		} finally {
			monaco.editor.setModelMarkers(fakeModel, "starlims-lsp", []);
			(globalThis as any).MutationObserver = prevMO;
		}
	});

	test("codicon-info never upgrades to error or warning even when sharing message text, while preserving hint vs info", () => {
		const sharedMsg = "Duplicate symbol";
		const markersWithErrWarn = [
			{ message: sharedMsg, severity: 8, source: "starlims-lsp", code: "SSL010", startLineNumber: 12, endLineNumber: 12 },
			{ message: sharedMsg, severity: 4, source: "starlims-lsp", code: "SSL011", startLineNumber: 12, endLineNumber: 12 },
		];
		const infoRow = makeMonaco058Row({
			iconClasses: ["codicon", "codicon-info"],
			ariaLabel: "Info",
			message: sharedMsg,
			detail: "starlims-lsp(SSL010)",
		});
		expect(resolveMarkerHoverSeverity(infoRow.markerEl, markersWithErrWarn, 12)).toBe("info");

		const markersWithHintAndErr = [
			{ message: sharedMsg, severity: 8, source: "starlims-lsp", code: "SSL010", startLineNumber: 12, endLineNumber: 12 },
			{ message: sharedMsg, severity: 1, source: "starlims-lsp", code: "SSL012", startLineNumber: 12, endLineNumber: 12 },
		];
		const hintRow = makeMonaco058Row({
			iconClasses: ["codicon", "codicon-info"],
			message: sharedMsg,
			detail: "starlims-lsp(SSL012)",
		});
		expect(resolveMarkerHoverSeverity(hintRow.markerEl, markersWithHintAndErr, 12)).toBe("hint");
	});

	test("observeMarkerHoverSeverity resets hoveredLine on onMouseLeave and onDidChangeCursorPosition and disposes subscriptions", () => {
		const prevMO = (globalThis as any).MutationObserver;
		let onMutate: (() => void) | null = null;
		(globalThis as any).MutationObserver = class {
			constructor(cb: () => void) {
				onMutate = cb;
			}
			observe() {}
			disconnect() {}
		};
		const uri = MockUri.parse("file:///ws/monaco58-stale-hover-line.ssl");
		const fakeModel: any = { uri };
		try {
			// Line 2 has an info marker and line 8 has a hint marker with identical message text.
			monaco.editor.setModelMarkers(fakeModel, "starlims-lsp", [
				{ message: "Check declaration", severity: 2, source: "starlims-lsp", startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 10 },
				{ message: "Check declaration", severity: 1, source: "starlims-lsp", startLineNumber: 8, startColumn: 1, endLineNumber: 8, endColumn: 10 },
			]);

			const sharedRow = makeMonaco058Row({
				iconClasses: ["codicon", "codicon-info"],
				message: "Check declaration",
			});

			let cursorLine = 8;
			let mouseMoveCb: ((e: any) => void) | undefined;
			let mouseLeaveCb: (() => void) | undefined;
			let cursorChangeCb: (() => void) | undefined;
			const disposed: string[] = [];

			const root: any = {
				querySelector: () => root,
				querySelectorAll: (sel: string) => (sel === ".monaco-hover .marker.hover-contents" ? [sharedRow.markerEl] : []),
			};
			const fakeEditor: any = {
				getModel: () => fakeModel,
				getDomNode: () => root,
				getPosition: () => ({ lineNumber: cursorLine, column: 1 }),
				onMouseMove: (cb: (e: any) => void) => {
					mouseMoveCb = cb;
					return { dispose: () => disposed.push("mouseMove") };
				},
				onMouseLeave: (cb: () => void) => {
					mouseLeaveCb = cb;
					return { dispose: () => disposed.push("mouseLeave") };
				},
				onDidChangeCursorPosition: (cb: () => void) => {
					cursorChangeCb = cb;
					return { dispose: () => disposed.push("cursor") };
				},
				onDidChangeModel: () => ({ dispose: () => disposed.push("model") }),
			};

			const stop = observeMarkerHoverSeverity(fakeEditor);
			// Initially cursor is on line 8 (hint).
			expect(sharedRow.row.dataset.severity).toBe("hint");

			// Mouse moves over line 2 (info).
			mouseMoveCb!({ target: { position: { lineNumber: 2 } } });
			onMutate!();
			expect(sharedRow.row.dataset.severity).toBe("info");

			// Mouse leaves editor -> hoveredLine clears so keyboard Show Hover uses cursor line 8 (hint).
			mouseLeaveCb!();
			onMutate!();
			expect(sharedRow.row.dataset.severity).toBe("hint");

			// Mouse moves over line 2 again, then keyboard moves cursor -> hoveredLine clears to cursor line 8 (hint).
			mouseMoveCb!({ target: { position: { lineNumber: 2 } } });
			onMutate!();
			expect(sharedRow.row.dataset.severity).toBe("info");

			cursorLine = 8;
			cursorChangeCb!();
			onMutate!();
			expect(sharedRow.row.dataset.severity).toBe("hint");

			stop();
			expect(disposed).toEqual(["mouseMove", "mouseLeave", "cursor", "model"]);
		} finally {
			monaco.editor.setModelMarkers(fakeModel, "starlims-lsp", []);
			(globalThis as any).MutationObserver = prevMO;
		}
	});

	test("style.css targets Monaco 0.58.0 .marker-message children, related-info spans, and .hover-row-with-copy padding", () => {
		const css = readSrc("../src/view/style.css");
		expect(css).toContain("> .marker.hover-contents > .marker-message > span:first-child");
		expect(css).toContain("> .marker.hover-contents > .marker-message > span:nth-child(2)");
		expect(css).toContain("> .marker.hover-contents > .marker-message > div");
		expect(css).toContain("> .marker.hover-contents > .marker-message > div > span");
		expect(css).toContain("> .marker.hover-contents > div:not(.marker-message) > span");
		expect(css).toContain(".monaco-editor .monaco-hover .hover-row.hover-row-with-copy > .marker.hover-contents {\n\tpadding-right: 8px !important;\n}");
		expect(css).toContain("> .marker.hover-contents > .marker-severity {\n\tdisplay: none;\n}");

		// Must NOT have the broken legacy bare child selectors that hit .marker-severity or .marker-message.
		expect(css).not.toMatch(/> \.marker\.hover-contents > span:first-child\b/);
		expect(css).not.toMatch(/> \.marker\.hover-contents > span:nth-child\(2\)\b/);
		expect(css).not.toMatch(/> \.marker\.hover-contents > div\s*\{/);

		// Ensure no rule targeting .marker-severity applies var(--ui-font).
		const severityRule = css.match(/\.marker-severity\s*\{[^}]*\}/g) ?? [];
		for (const block of severityRule) {
			expect(block).not.toContain("var(--ui-font)");
		}
	});
});

describe("Review.tsx synchronous currentReview mirror & double-accept/double-close guards", () => {
	test("synchronous currentReview mirror prevents stale deferred reads on open->close and open->open before flush", async () => {
		type TestReview = Reviewable & { compare?: { left: string; right: string } };
		const [reviewSig, setReviewSig] = createSignal<TestReview | null>(null);
		let currentReview: TestReview | null = null;
		const getCurrent = (): TestReview | null => currentReview;
		const prompts: string[] = [];
		const rejected: string[] = [];

		const flow = reviewFlow<TestReview>({
			current: getCurrent,
			show: (r) => {
				currentReview = r;
				setReviewSig(r);
			},
			choose: async (title) => {
				prompts.push(title);
				return REPLACE;
			},
			fail: () => {},
			replaceable: (r) => Boolean(r.replaceable || r.compare),
		});

		const r1: TestReview = {
			title: "Step 1",
			onAccept: () => {},
			onReject: () => void rejected.push("Step 1"),
		};
		const opened = await flow.open(r1);
		expect(opened).toBe(true);
		// Even before flush() commits reviewSig(), synchronous close() and double-close work cleanly.
		flow.close();
		flow.close();
		expect(getCurrent()).toBeNull();
		expect(rejected).toEqual(["Step 1"]);
		flush();
		expect(untrack(reviewSig)).toBeNull();

		// Open a comparison and immediately closeComparison() before flush().
		const comp: TestReview = {
			title: "Diff",
			compare: { left: "Before", right: "After" },
			onAccept: () => {},
			onReject: () => void rejected.push("Diff"),
		};
		await flow.open(comp);
		expect(getCurrent()).toBe(comp);
		// Mirrors closeComparison() reading `currentReview?.compare` synchronously.
		if (getCurrent()?.compare) flow.close();
		expect(getCurrent()).toBeNull();
		expect(rejected).toEqual(["Step 1", "Diff"]);

		// Open r1 then immediately open r2 before flush(): r1 is seen synchronously and prompts.
		await flow.open(r1);
		const r2: TestReview = { title: "Step 2", onAccept: () => {} };
		await flow.open(r2);
		expect(prompts.length).toBe(1);
		expect(prompts[0]).toContain("Step 1");
		expect(getCurrent()).toBe(r2);
		flow.close();
	});

	test("synchronous isBusy/isRejecting guard blocks rapid double-accept before Solid flush without false error", async () => {
		const [busy, setBusy] = createSignal(false);
		let isBusy = false;
		let isRejecting = false;
		let resolveAccept!: () => void;
		let acceptCalls = 0;
		const errors: string[] = [];

		let currentReview: Reviewable | null = null;
		const flow = reviewFlow<Reviewable>({
			current: () => currentReview,
			show: (r) => {
				currentReview = r;
			},
			choose: async () => KEEP,
			fail: (msg) => void errors.push(msg),
		});

		const r: Reviewable = {
			title: "Guard test",
			onAccept: () =>
				new Promise<void>((res) => {
					acceptCalls++;
					resolveAccept = res;
				}),
		};
		await flow.open(r);

		const accept = async () => {
			if (isBusy || isRejecting || untrack(busy)) return;
			isBusy = true;
			setBusy(true);
			try {
				const failed = await flow.accept(r, "next");
				if (failed !== null) errors.push(failed);
			} finally {
				isBusy = false;
				setBusy(false);
			}
		};

		// Two synchronous clicks before Solid flushes `busy()`: second click must NOT enter flow.accept!
		const p1 = accept();
		const p2 = accept();
		expect(acceptCalls).toBe(1);
		resolveAccept();
		await Promise.all([p1, p2]);
		expect(errors).toEqual([]);
		expect(currentReview).toBeNull();
	});

	test("Review.tsx wires synchronous currentReview mirror and isBusy/isRejecting guards", () => {
		const src = readSrc("../src/view/editor/Review.tsx");
		expect(src).toContain("let currentReview: Review | null = null;");
		expect(src).toContain("current: () => currentReview,");
		expect(src).toMatch(/show:\s*\(r\)\s*=>\s*\{\s*currentReview = r;\s*setReview\(r\);/);
		expect(src).toContain("export const closeComparison = () => void (currentReview?.compare && flow.close());");
		expect(src).toContain("let isBusy = false;");
		expect(src).toContain("let isRejecting = false;");
		expect(src).toContain("if (isBusy || isRejecting || busy() || rejecting() || r.blocked || !proposedModel) return;");
		expect(src).toContain("if (isBusy || isRejecting || busy() || rejecting()) return;");
	});
});

describe("CsvFormatDialog & CsvCodeCheckDialog use one-shot createSignal(untrack(...)) instead of derived writable signals", () => {
	test("Solid 2 createSignal(untrack(...)) preserves user dialog edits when upstream props change", () => {
		const ctx = createRoot((dispose) => {
			const [upstream, setUpstream] = createSignal("initial");
			// One-shot snapshot:
			const [draft, setDraft] = createSignal(untrack(() => upstream()));
			// Derived writable (the bug we eliminated):
			const [derived, setDerived] = createSignal(() => upstream());
			return { setUpstream, draft, setDraft, derived, setDerived, dispose };
		});
		try {
			ctx.setDraft("user-edit");
			ctx.setDerived("user-edit");
			flush();
			expect(ctx.draft()).toBe("user-edit");
			expect(ctx.derived()).toBe("user-edit");

			// Upstream prop changes while dialog is open:
			ctx.setUpstream("refreshed");
			flush();
			// One-shot snapshot preserves the user's edit; derived writable wipes it.
			expect(ctx.draft()).toBe("user-edit");
			expect(ctx.derived()).toBe("refreshed");
		} finally {
			ctx.dispose();
		}
	});

	test("CsvFormatDialog.tsx uses createSignal(untrack(...)) with zero derived writable signals", () => {
		const src = readSrc("../src/view/editor/CsvFormatDialog.tsx");
		expect(src).toMatch(/import\s+\{[^}]*\buntrack\b[^}]*\}\s+from\s+"solid-js"/);
		expect(src).toContain("createSignal(untrack(() => init().cfg.badgeFormatting))");
		expect(src).toContain("createSignal<DraftRule[]>(untrack(() => toDraftRules(init().cfg.rules)))");
		expect(src).not.toMatch(/createSignal(?:<[^>]+>)?\(\s*\(\)\s*=>/);
	});

	test("CsvCodeCheckDialog.tsx uses createSignal(untrack(...)) with zero derived writable signals", () => {
		const src = readSrc("../src/view/editor/CsvCodeCheckDialog.tsx");
		expect(src).toMatch(/import\s+\{[^}]*\buntrack\b[^}]*\}\s+from\s+"solid-js"/);
		expect(src).toContain("createSignal(untrack(safeInitialCol))");
		expect(src).toContain("createSignal<CodeCheckRowScope>(untrack(computeInitialScope))");
		expect(src).toContain('createSignal<CodeFileScopeId>(untrack(() => props.lastSpec?.fileScope ?? "code"))');
		expect(src).toContain('createSignal(untrack(() => props.lastSpec?.include ?? ""))');
		expect(src).toContain("createSignal(untrack(() => props.lastSpec?.exclude ?? props.defaultExclude))");
		expect(src).toContain("createSignal(untrack(() => props.lastSpec?.wholeWord ?? true))");
		expect(src).toContain("createSignal(untrack(() => props.lastSpec?.caseSensitive ?? false))");
		expect(src).toContain("createSignal(untrack(() => looksLikeListColumn(props.table.rows, safeInitialCol())))");
		expect(src).not.toMatch(/createSignal(?:<[^>]+>)?\(\s*(?:\(\)\s*=>|safeInitialCol\b|computeInitialScope\b)/);
	});
});

describe("Solid 2 strict-read and TableView flush() audit guards", () => {
	test("Solid 2 createEffect apply body cleanly reads values via compute or untrack without throwing", () => {
		const seen: number[] = [];
		const ctx = createRoot((dispose) => {
			const [a, setA] = createSignal(1);
			const [b, setB] = createSignal(10);
			createEffect(
				() => a(),
				(val) => {
					seen.push(val + untrack(b));
				},
			);
			return { setA, setB, dispose };
		});
		try {
			flush();
			ctx.setA(2);
			flush();
			ctx.setB(20);
			flush();
			expect(seen).toEqual([11, 12]);
		} finally {
			ctx.dispose();
		}
	});

	test("EditorGroup, BlocksView, MarkdownLiveEditor, and TableView guard untracked reads and flush deferred writes", () => {
		const editorGroup = readSrc("../src/view/editor/EditorGroup.tsx");
		expect(editorGroup).toContain("liveEditorAt(index)?.getPosition()");
		expect(editorGroup).toContain("untrack(() => saveSourceAnchor(path))");
		expect(editorGroup).toContain("untrack(() => applySourceAnchor(path))");

		const blocksView = readSrc("../src/view/blocks/BlocksView.tsx");
		expect(blocksView).toContain('lspRunning: state.lsp.state === "running"');
		expect(blocksView).toContain("const { path, wsRoot, allDocs } = untrack(() => ({");

		const mdLive = readSrc("../src/view/editor/MarkdownLiveEditor.tsx");
		expect(mdLive).toContain("else if (!assistFrame) assistFrame = requestAnimationFrame(applyReadAssist);");
		expect(mdLive).toContain("if (cmView) untrack(() => cmView!.dispatch({ effects: refreshLiveEffect.of(++refreshSeq) }));");

		const tableView = readSrc("../src/view/editor/TableView.tsx");
		expect(tableView).toContain("const colCount = untrack(table).header.length;");
		expect(tableView).toContain('const existingVal = ed.ghost ? "" : (untrack(table).rows[ed.row]?.[ed.column]?.text ?? "");');
		expect(tableView).toMatch(/changeCell\(row, column, value\);\s*flush\(\);/);
		expect(tableView).toMatch(/pinRowIfFiltered\(match\.row\);\s*flush\(\);\s*const entryIdx = visEntryIdxForRow\(match\.row\);/);
		expect(tableView).toMatch(/pinRowIfFiltered\(matchedRow\);\s*flush\(\);\s*const entryIdx = visEntryIdxForRow\(matchedRow\);/);
	});
});

describe("Pass-2 adversarial audit fixes (Solid 2 keyed <For>, onSettled flush deferral, CM6 ImageWidget destroy, Review math hydration)", () => {
	test("TableView.tsx defers initial revealAt(pending) out of onSettled via queueMicrotask and keys column filter <For> by o.key", async () => {
		// Runtime verification: deferring a flush() out of onSettled via queueMicrotask runs cleanly without halting reactivity
		// and respects unmount disposal before the microtask fires.
		const ran: string[] = [];
		const ctx = createRoot((dispose) => {
			const [val, setVal] = createSignal("init");
			onSettled(() => {
				let disposed = false;
				queueMicrotask(() => {
					if (disposed) return;
					setVal("revealed");
					flush();
					ran.push(untrack(val));
				});
				return () => {
					disposed = true;
				};
			});
			return { val, dispose };
		});
		try {
			flush();
			await Promise.resolve();
			expect(ran).toEqual(["revealed"]);
			expect(untrack(ctx.val)).toBe("revealed");
		} finally {
			ctx.dispose();
		}

		// Disposed before microtask: deferred reveal must be skipped.
		const skipped: string[] = [];
		const ctx2 = createRoot((dispose) => {
			onSettled(() => {
				let disposed = false;
				queueMicrotask(() => {
					if (!disposed) skipped.push("should-not-run");
				});
				return () => {
					disposed = true;
				};
			});
			return { dispose };
		});
		flush();
		ctx2.dispose();
		await Promise.resolve();
		expect(skipped).toEqual([]);

		// Source-level regression checks on TableView.tsx
		const src = readSrc("../src/view/editor/TableView.tsx");
		const settledIdx = src.indexOf("const pending = takeReveal(props.path);");
		expect(settledIdx).toBeGreaterThan(0);
		const settledBlock = src.slice(Math.max(0, settledIdx - 400), settledIdx + 450);
		expect(settledBlock).toContain("let disposed = false;");
		expect(settledBlock).toMatch(/if \(pending\)\s*\{\s*queueMicrotask\(\(\) => \{\s*if \(!disposed\) revealAt\(pending\);\s*\}\);\s*\}/);
		expect(settledBlock).toContain("disposed = true;");
		expect(settledBlock).not.toContain("if (pending) revealAt(pending);");

		const filterForIdx = src.indexOf("<For each={visibleOptions()} keyed={(o) => o.key}>");
		expect(filterForIdx).toBeGreaterThan(0);
		const filterBlock = src.slice(filterForIdx, filterForIdx + 1200);
		expect(filterBlock).toContain("badgeToneForValue(rule(), opt().label)");
		expect(filterBlock).toContain("opt().count === 0");
		expect(filterBlock).toContain("checked={isChecked(opt().key)} onChange={() => toggleKey(opt().key)}");
		expect(filterBlock).toContain("onClick={() => selectOnly(opt().key)}");
		expect(filterBlock).not.toMatch(/\bopt\.(key|label|count|total)\b/);
	});

	test("CsvFormatDialog.tsx keys both rules() and filteredEntries() <For> loops by id with lazy accessor reads", () => {
		// Runtime verification: Solid 2 keyed mapArray keeps mapped nodes alive across immutable updates.
		let created = 0;
		const ctx = createRoot((dispose) => {
			const [items, setItems] = createSignal([{ id: 1, value: "Open" }]);
			const mapped = mapArray(
				items,
				(item, idx) => {
					created++;
					return { read: () => `${idx()}:${item().value}` };
				},
				{ keyed: (x) => x.id },
			);
			return { setItems, mapped, dispose };
		});
		try {
			const first = untrack(ctx.mapped);
			expect(created).toBe(1);
			expect(first[0]!.read()).toBe("0:Open");

			ctx.setItems([{ id: 1, value: "Open!" }]);
			flush();
			const second = untrack(ctx.mapped);
			expect(created).toBe(1);
			expect(second[0]).toBe(first[0]);
			expect(second[0]!.read()).toBe("0:Open!");
		} finally {
			ctx.dispose();
		}

		// Source-level regression checks on CsvFormatDialog.tsx
		const src = readSrc("../src/view/editor/CsvFormatDialog.tsx");
		const outerIdx = src.indexOf("<For each={rules()} keyed={(r) => r.id}>");
		expect(outerIdx).toBeGreaterThan(0);
		const innerIdx = src.indexOf("<For each={filteredEntries()} keyed={(e) => e.id}>");
		expect(innerIdx).toBeGreaterThan(outerIdx);

		const outerBlock = src.slice(outerIdx, innerIdx);
		// No top-level untracked `const r = rule()` before `return (` outside memos/functions.
		expect(outerBlock).not.toMatch(/\{\(rule,\s*idx\)\s*=>\s*\{\s*const\s+\w+\s*=\s*rule\(\)/);
		expect(outerBlock).toContain("rule().columnsText");
		expect(outerBlock).toContain("rule().fallback");
		expect(outerBlock).toContain("rule().search");
		expect(outerBlock).toContain("rule().entries");
		expect(outerBlock).toContain("idx() + 1");
		expect(outerBlock).toContain("idx() === initialFocusIdx");
		expect(outerBlock).not.toMatch(/\brule\.(id|columnsText|fallback|search|entries)\b/);

		const innerBlock = src.slice(innerIdx, innerIdx + 1400);
		expect(innerBlock).not.toMatch(/\{\(entry\)\s*=>\s*\{\s*const\s+\w+\s*=\s*entry\(\)/);
		expect(innerBlock).toContain("entry().value");
		expect(innerBlock).toContain("entry().tone");
		expect(innerBlock).toContain("entry().id");
		expect(innerBlock).not.toMatch(/\bentry\.(id|value|tone|label)\b/);
	});

	test("BlocksView.tsx keys procedureGroups <For> stably by procedure or first child key", () => {
		const src = readSrc("../src/view/blocks/BlocksView.tsx");
		const idx = src.indexOf("<For each={procedureGroups(props.node.children)} keyed={(g) => (g.find((c) => c.kind === \"procedure\") ?? g[0]!).key}>");
		expect(idx).toBeGreaterThan(0);
		const block = src.slice(idx, idx + 400);
		expect(block).toContain("<Show when={group().length > 1} fallback={<Block node={group()[0]!} />}>");
		expect(block).toContain("<For each={group()}>{(child) => <Block node={child} />}</For>");
	});

	test("cmLivePlugin.ts ImageWidget cleans up active resize listeners on destroy, blur, and detached wrap", () => {
		const src = readSrc("../src/view/editor/cmLivePlugin.ts");
		const widgetStart = src.indexOf("class ImageWidget extends WidgetType");
		expect(widgetStart).toBeGreaterThan(0);
		const widgetEnd = src.indexOf("class BulletWidget extends WidgetType", widgetStart);
		expect(widgetEnd).toBeGreaterThan(widgetStart);
		const widgetSrc = src.slice(widgetStart, widgetEnd);

		expect(src).toContain("const activeImageResizeCleanup = new WeakMap<HTMLElement, () => void>();");
		expect(widgetSrc).toContain('window.addEventListener("blur", onCancel)');
		expect(widgetSrc).toContain('window.removeEventListener("blur", onCancel)');
		expect(widgetSrc).toContain("activeImageResizeCleanup.set(wrap, cleanup)");
		expect(widgetSrc).toContain("if (!wrap.isConnected)");
		expect(widgetSrc).toContain("const connected = wrap.isConnected;");
		expect(widgetSrc).toContain("destroy(dom: HTMLElement)");
		expect(widgetSrc).toContain("activeImageResizeCleanup.get(dom)?.()");
	});

	test("Review.tsx imports and invokes hydrateMathInElement on rendered Markdown diff panes", () => {
		const src = readSrc("../src/view/editor/Review.tsx");
		expect(src).toMatch(/import\s+\{[^}]*\bhydrateMathInElement\b[^}]*\}\s+from\s+"\.\/markdownHtml"/);
		const showIdx = src.indexOf('<Show when={diffLayout() === "rendered" && renderedDiff()}>');
		expect(showIdx).toBeGreaterThan(0);
		const renderedBlock = src.slice(showIdx, showIdx + 1200);
		expect(renderedBlock).toContain('diffLayout() === "rendered" ? visibleRows() : null');
		expect(renderedBlock).toContain("queueMicrotask(");
		expect(renderedBlock).toContain("if (!alive) return;");
		expect(renderedBlock).toContain("if (leftPaneEl?.isConnected) hydrateMathInElement(leftPaneEl);");
		expect(renderedBlock).toContain("if (rightPaneEl?.isConnected) hydrateMathInElement(rightPaneEl);");
	});
});
