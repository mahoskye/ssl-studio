import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TEXT, contrast } from "../src/shared/contrast";
import { allOklchThemes } from "../src/shared/oklchTheme";
import dark from "../src/view/themes/studio-dark.json";
import light from "../src/view/themes/studio-light.json";

const read = (rel: string) => readFileSync(resolve(import.meta.dir, "..", rel), "utf8");

const CSS_FILES = [
	"src/view/style.css",
	"src/view/editor/cmLive.css",
	"src/view/editor/markdownLive.css",
	"src/view/editor/tableViewExtra.css",
	"src/view/graph/graphExtra.css",
	"src/view/plan/planCanvas.css",
	"src/view/plan/planExtra.css",
] as const;

const styleCss = read("src/view/style.css");
const cmLiveCss = read("src/view/editor/cmLive.css");
const mdLiveCss = read("src/view/editor/markdownLive.css");
const tableExtraCss = read("src/view/editor/tableViewExtra.css");
const graphExtraCss = read("src/view/graph/graphExtra.css");
const planCanvasCss = read("src/view/plan/planCanvas.css");
const planExtraCss = read("src/view/plan/planExtra.css");
const cmThemeTs = read("src/view/editor/cmTheme.ts");
const cmCompletionTs = read("src/view/editor/cmCompletion.ts");

/** Extracts the declaration block body for the first rule matching `selectorRe`. */
function blockOf(css: string, selectorRe: RegExp): string {
	const m = selectorRe.exec(css);
	expect(m).not.toBeNull();
	const start = css.indexOf("{", m!.index);
	expect(start).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = start; i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}") {
			depth--;
			if (depth === 0) return css.slice(start + 1, i);
		}
	}
	throw new Error(`Unclosed CSS block for ${selectorRe}`);
}

/** Extracts numeric z-index from a CSS block body. */
function zIndexOf(css: string, selectorRe: RegExp): number {
	const body = blockOf(css, selectorRe);
	const m = /z-index:\s*(\d+)\s*;/.exec(body);
	expect(m).not.toBeNull();
	return Number(m![1]);
}

function parseHex(h: string): [number, number, number] {
	return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function toHex([r, g, b]: [number, number, number]): string {
	return (
		"#" +
		[r, g, b]
			.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
			.join("")
	);
}
function mixSrgb(fg: string, pct: number, bg: string): string {
	const a = parseHex(fg);
	const b = parseHex(bg);
	const p = pct / 100;
	return toHex([a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), a[2] * p + b[2] * (1 - p)]);
}

describe("R9C CSS syntax, custom properties & --accent-fg contract", () => {
	test("all 7 CSS files have balanced braces", () => {
		for (const file of CSS_FILES) {
			const src = read(file);
			let depth = 0;
			for (const ch of src) {
				if (ch === "{") depth++;
				else if (ch === "}") depth--;
				expect(depth).toBeGreaterThanOrEqual(0);
			}
			expect(depth).toBe(0);
		}
	});

	test("every var(--...) across all 7 CSS files is defined in CSS or is a known inline runtime variable", () => {
		// Element-scoped inline variables injected dynamically by TS views/decorations.
		const RUNTIME_INLINE_VARS = new Set([
			"--bottom",
			"--editor-font-size",
			"--left",
			"--md-list-hang",
			"--md-list-indent",
			"--md-live-mono",
			"--region",
			"--right",
			"--w",
		]);
		const defined = new Set<string>();
		const used = new Set<string>();
		for (const file of CSS_FILES) {
			const src = read(file);
			for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]!);
			for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) used.add(m[1]!);
		}
		const missing = [...used].filter((v) => !defined.has(v) && !RUNTIME_INLINE_VARS.has(v));
		expect(missing).toEqual([]);
	});

	test(":root defines all shared R9B/R9C theme custom properties and light-mode startup fallback", () => {
		const rootBlock = blockOf(styleCss, /^:root\s*\{/m);
		for (const token of [
			"--accent-fg:",
			"--chrome-muted:",
			"--editor-accent-fg:",
			"--editor-input-border:",
			"--editor-ok:",
			"--editor-warning:",
			"--editor-error:",
			"--editor-info:",
			"--z-editor-overlay:",
			"--z-popover:",
			"--z-lightbox:",
			"--z-menu:",
			"--z-modal:",
			"--z-toast:",
			"--z-asked:",
			"--z-row-menu:",
		]) {
			expect(rootBlock).toContain(token);
		}

		// Dark startup default --accent-fg on --accent passes WCAG AA.
		const darkAccent = /--accent:\s*(#[0-9a-f]{6})/i.exec(rootBlock)?.[1];
		const darkAccentFg = /--accent-fg:\s*(#[0-9a-f]{6})/i.exec(rootBlock)?.[1];
		expect(darkAccent).toBeTruthy();
		expect(darkAccentFg).toBeTruthy();
		expect(contrast(darkAccentFg!, darkAccent!)).toBeGreaterThanOrEqual(TEXT);

		// Light-mode startup media query fallback prevents dark startup flash and passes WCAG AA.
		const lightMedia = blockOf(styleCss, /@media\s*\(prefers-color-scheme:\s*light\)/);
		expect(lightMedia).toContain("--accent-fg: #ffffff;");
		expect(lightMedia).toContain("--editor-accent-fg: #ffffff;");
		expect(lightMedia).toContain("--editor-input-border:");
		expect(lightMedia).toContain("--chrome-muted:");
		expect(lightMedia).toContain("color-scheme: light;");
		const lightAccent = /--accent:\s*(#[0-9a-f]{6})/i.exec(lightMedia)?.[1];
		const lightAccentFg = /--accent-fg:\s*(#[0-9a-f]{6})/i.exec(lightMedia)?.[1];
		expect(contrast(lightAccentFg!, lightAccent!)).toBeGreaterThanOrEqual(TEXT);
	});

	test("accent-filled controls use var(--accent-fg) or var(--button-bg)/var(--button-fg) with no hardcoded #fff fallbacks", () => {
		expect(blockOf(styleCss, /\.quick-checkbox\.checked\s*\{/)).toContain("color: var(--accent-fg);");
		expect(blockOf(styleCss, /\.quick-checkbox\.checked\s*\{/)).not.toContain("#fff");

		const filePrimary = blockOf(styleCss, /\.file-actions button\.primary\s*\{/);
		expect(filePrimary).toContain("background: var(--button-bg);");
		expect(filePrimary).toContain("color: var(--button-fg);");
		expect(filePrimary).not.toContain("#fff");

		expect(blockOf(planCanvasCss, /\.plan-port:hover \.plan-port-plus\s*\{/)).toContain("stroke: var(--accent-fg);");
		expect(blockOf(planCanvasCss, /\.plan-port:hover \.plan-port-plus\s*\{/)).not.toContain("#fff");

		expect(blockOf(planCanvasCss, /\.plan-seg-handle:hover \.plan-seg-grip,[\s\S]*?\.plan-seg-handle\.active \.plan-seg-grip\s*\{/)).toContain(
			"stroke: var(--accent-fg);",
		);
		expect(blockOf(planCanvasCss, /\.plan-tab-badge\s*\{/)).toContain("color: var(--accent-fg);");
		expect(blockOf(planCanvasCss, /\.plan-tab-badge\s*\{/)).not.toContain("#fff");
	});
});

describe("R9C Split Warm polarity isolation", () => {
	test("Split Warm editor re-scope matches both attribute selectors, re-scopes input-border/accent-fg/semantics, and sets color-scheme: light", () => {
		const splitBlock = blockOf(styleCss, /:root:is\(\[data-theme="dark"\]\[data-editor-theme="light"\],\s*\[data-split="true"\]\)/);
		expect(splitBlock).toContain("--input-border: var(--editor-input-border);");
		expect(splitBlock).not.toContain("--input-border: var(--editor-border);");
		expect(splitBlock).toContain("--accent-fg: var(--editor-accent-fg);");
		expect(splitBlock).toContain("--ok: var(--editor-ok);");
		expect(splitBlock).toContain("--warning: var(--editor-warning);");
		expect(splitBlock).toContain("--error: var(--editor-error);");
		expect(splitBlock).toContain("--info: var(--editor-info);");
		expect(splitBlock).toContain("color-scheme: light;");
	});

	test(".plan-impl-code inside .rightbar matches chrome polarity with full-contrast line numbers", () => {
		const codeBlock = blockOf(planCanvasCss, /\.plan-impl-code\s*\{/);
		expect(codeBlock).toContain("background: var(--input-bg);");
		expect(codeBlock).not.toContain("--editor-bg");

		const preBlock = blockOf(planCanvasCss, /\.plan-impl-pre\s*\{/);
		expect(preBlock).toContain("color: var(--input-fg, var(--fg));");

		const lnBlock = blockOf(planCanvasCss, /\.plan-impl-ln\s*\{/);
		expect(lnBlock).toContain("color: var(--muted);");
		expect(lnBlock).not.toContain("72%");
	});

	test(".cm-md-callout and .md .md-callout tint from local var(--bg)/var(--fg) without editor-bg leak", () => {
		const callout = blockOf(cmLiveCss, /\.cm-md-callout,\s*\n\.md \.md-callout\s*\{/);
		expect(callout).toContain("var(--bg)");
		expect(callout).not.toContain("--editor-bg");

		const body = blockOf(cmLiveCss, /\.cm-md-callout-body,\s*\n\.md \.md-callout-body\s*\{/);
		expect(body).toContain("color: var(--fg);");
		expect(body).not.toContain("--editor-fg");

		expect(cmLiveCss).toContain(".cm-callout-pick.tone-accent { --callout-tone: var(--accent); }");
		expect(cmLiveCss).toContain(".cm-callout-pick.tone-muted { --callout-tone: var(--muted); }");
	});
});

describe("R9C strict Z-index hierarchy across all stylesheets, cmTheme.ts & cmCompletion.ts", () => {
	test("exact documented tier ordering is enforced end-to-end", () => {
		const zPlanControls = zIndexOf(planCanvasCss, /\.plan-float-controls\s*\{/);
		const zPictureMap = zIndexOf(planCanvasCss, /\.plan \.picture-map\s*\{/);
		const zPlanFloatBar = zIndexOf(planCanvasCss, /\.plan-float-bar\s*\{/);
		const zPlanHint = zIndexOf(planCanvasCss, /\.plan-hint\s*\{/);
		const zPlanPathBar = zIndexOf(planCanvasCss, /\.plan-path-bar\s*\{/);
		const zPlanKeys = zIndexOf(styleCss, /\.plan-keys\s*\{/);
		const zPlanEdit = zIndexOf(planCanvasCss, /\.plan-edit\s*\{/);
		const zTableToolbar = zIndexOf(cmLiveCss, /\.cm-md-table-toolbar-wrap\s*\{/);
		const zPlanTopbar = zIndexOf(planCanvasCss, /\.plan-topbar\s*\{/);
		const zCmPanelsTop = zIndexOf(cmLiveCss, /\.cm-md-host \.cm-panels\.cm-panels-top\s*\{/);

		const zGraphFind = zIndexOf(styleCss, /\.graph-find-list\s*\{/);
		const zTableFilterPop = zIndexOf(styleCss, /\.table-filter-pop\s*\{/);
		const zHoverCard = zIndexOf(cmLiveCss, /\.md-hover-card\s*\{/);
		const zSelBubble = zIndexOf(cmLiveCss, /\.cm-md-sel-bubble\s*\{/);
		const zWidgetAcCss = zIndexOf(cmLiveCss, /\.cm-widget-ac\s*\{/);
		const zTableCellPicker = zIndexOf(tableExtraCss, /\.table-cell-picker\s*\{/);
		const zColDragGhost = zIndexOf(styleCss, /\.table-col-drag-ghost\s*\{/);

		const zCmTooltipMatch = /"\.cm-tooltip":\s*\{[\s\S]*?zIndex:\s*"(\d+)"/.exec(cmThemeTs);
		expect(zCmTooltipMatch).not.toBeNull();
		const zCmTooltip = Number(zCmTooltipMatch![1]);

		const zWidgetAcInlineMatch = /popEl\.className\s*=\s*"cm-widget-ac"[\s\S]*?zIndex:\s*"(\d+)"/.exec(cmCompletionTs);
		expect(zWidgetAcInlineMatch).not.toBeNull();
		const zWidgetAcInline = Number(zWidgetAcInlineMatch![1]);

		const zMenuPop = zIndexOf(styleCss, /^\.menu-pop\s*\{/m);
		const zLightbox = zIndexOf(cmLiveCss, /^\.md-lightbox-modal\s*\{/m);
		const zMenuFloating = zIndexOf(styleCss, /^\.menu-pop-floating\s*\{/m);
		const zOverlay = zIndexOf(styleCss, /^\.overlay\s*\{/m);
		const zAskedShade = zIndexOf(styleCss, /^\.overlay-shade\s*\{/m);
		const zToasts = zIndexOf(styleCss, /^\.toasts\s*\{/m);
		const zAsked = zIndexOf(styleCss, /^\.overlay\.asked\s*\{/m);
		const zRowMenuShade = zIndexOf(styleCss, /^\.row-menu-shade\s*\{/m);
		const zRowMenuHost = zIndexOf(styleCss, /^\.row-menu-host\s*\{/m);

		// Tier 1-20: Editor overlays & sticky bars
		expect(zPlanControls).toBe(6);
		expect(zPictureMap).toBe(6);
		expect(zPlanFloatBar).toBe(8);
		expect(zPlanHint).toBe(9);
		expect(zPlanPathBar).toBe(9);
		expect(zPlanKeys).toBe(10);
		expect(zPlanEdit).toBe(12);
		expect(zTableToolbar).toBe(12);
		expect(zPlanTopbar).toBe(15);
		expect(zCmPanelsTop).toBe(16);

		// .plan-topbar must sit above all canvas overlays so .graph-find-list is never trapped beneath them.
		expect(zPlanTopbar).toBeGreaterThan(zPlanEdit);
		expect(zPlanTopbar).toBeGreaterThan(zPlanKeys);
		expect(zPlanTopbar).toBeGreaterThan(zPlanHint);
		expect(zPlanTopbar).toBeGreaterThan(zPlanPathBar);
		expect(zPlanTopbar).toBeGreaterThan(zPlanFloatBar);

		// CodeMirror Find bar (.cm-panels-top) must sit above sticky table toolbar (.cm-md-table-toolbar-wrap).
		expect(zCmPanelsTop).toBeGreaterThan(zTableToolbar);

		// Tier 40-58: In-workspace popovers/autocompletes/tooltips
		expect(zGraphFind).toBe(40);
		expect(zTableFilterPop).toBe(55);
		expect(zHoverCard).toBe(56);
		expect(zSelBubble).toBe(57);
		expect(zCmTooltip).toBe(58);
		expect(zWidgetAcCss).toBe(58);
		expect(zWidgetAcInline).toBe(58);
		expect(zTableCellPicker).toBe(58);
		expect(zColDragGhost).toBe(58);

		// Global stacking tiers
		expect(zMenuPop).toBe(60);
		expect(zMenuFloating).toBe(70);
		expect(zOverlay).toBe(80);
		expect(zLightbox).toBe(80);
		expect(zAskedShade).toBe(80);
		expect(zToasts).toBe(82);
		expect(zAsked).toBe(83);
		expect(zRowMenuShade).toBe(84);
		expect(zRowMenuHost).toBe(85);

		// Strictly monotonic chain across all tiers
		expect(zCmPanelsTop).toBeLessThan(zGraphFind);
		expect(zWidgetAcInline).toBeLessThan(zMenuFloating);
		expect(zCmTooltip).toBeLessThan(zMenuFloating);
		expect(zTableCellPicker).toBeLessThan(zMenuFloating);
		expect(zMenuFloating).toBeLessThan(zOverlay);
		expect(zLightbox).toBe(zOverlay);
		// The notices stand over a sheet the person works in and over the shade of what is asked; what is asked stands
		// over the notices; a menu opened in a dialog stands over them all.
		expect(zAskedShade).toBe(zOverlay);
		expect(zOverlay).toBeLessThan(zToasts);
		expect(zToasts).toBeLessThan(zAsked);
		expect(zAsked).toBeLessThan(zRowMenuShade);
		expect(zRowMenuShade).toBeLessThan(zRowMenuHost);
	});

	test("no stylesheet, cmTheme.ts, or cmCompletion.ts declares any z-index above the row menu's 85", () => {
		for (const file of CSS_FILES) {
			const src = read(file);
			for (const m of src.matchAll(/z-index:\s*(\d+)/g)) {
				expect(Number(m[1])).toBeLessThanOrEqual(85);
			}
		}
		for (const src of [cmThemeTs, cmCompletionTs]) {
			for (const m of src.matchAll(/zIndex:\s*["']?(\d+)["']?/g)) {
				expect(Number(m[1])).toBeLessThanOrEqual(85);
			}
		}
	});

	test("what is asked lets a click through beside its dialog, to a notice or to the shade that closes it", () => {
		const asked = blockOf(styleCss, /^\.overlay\.asked\s*\{/m);
		expect(asked).toContain("pointer-events: none;");
		expect(asked).toContain("background: none;");
		expect(blockOf(styleCss, /^\.overlay\.asked > \*\s*\{/m)).toContain("pointer-events: auto;");
		expect(blockOf(styleCss, /^\.overlay-shade\s*\{/m)).toContain("background: var(--overlay);");
	});

	test(".toasts positions above the scaled status bar using calc(var(--status-height) + var(--space-5))", () => {
		const toasts = blockOf(styleCss, /\.toasts\s*\{/);
		expect(toasts).toContain("bottom: calc(var(--status-height) + var(--space-5));");
		expect(toasts).not.toContain("bottom: 36px");
	});
});

describe("The set-up offer in a narrow window", () => {
	test("its two answers go under the text as a pair, rather than leave the text a word to a line", () => {
		const bar = blockOf(styleCss, /^\.setup-bar\s*\{/m);
		expect(bar).toContain("flex-wrap: wrap;");
		expect(bar).toContain("justify-content: flex-end;");
		// The text asks for a measure it can be read at; with less than that beside the answers, they wrap.
		expect(blockOf(styleCss, /^\.setup-bar span\s*\{/m)).toContain("flex: 1 1 calc(260px * var(--ui-scale));");
		expect(blockOf(styleCss, /^\.setup-actions\s*\{/m)).toContain("flex: none;");
		// One group, so "Not now" never drops to a row of its own under "Set up project".
		const app = read("src/view/App.tsx");
		const group = /<div class="setup-actions">([\s\S]*?)<\/div>/.exec(app)?.[1] ?? "";
		expect(group).toContain("Set up project");
		expect(group).toContain("Not now");
	});
});

describe("R9C WCAG AA contrast & opacity fixes across all 27 themes", () => {
	test("contrast-destroying opacity reductions are removed on muted/syntax/interactive text", () => {
		expect(blockOf(styleCss, /\.cmd-center-keys\s*\{/)).not.toContain("opacity");
		expect(blockOf(cmLiveCss, /\.cm-md-compact-btn\s*\{/)).not.toContain("opacity");
		expect(blockOf(cmLiveCss, /\.cm-editor \.cm-md-task-done\s*\{/)).not.toContain("opacity");
		expect(blockOf(cmLiveCss, /\.cm-editor \.cm-md-comment-line\s*\{/)).not.toContain("opacity");
		expect(blockOf(cmLiveCss, /\.cm-editor \.cm-md-comment\s*\{/)).not.toContain("opacity");
		expect(blockOf(cmLiveCss, /\.cm-editor \.cm-md-syntax\s*\{/)).not.toContain("opacity");
		expect(blockOf(mdLiveCss, /\.monaco-editor \.md-live-syntax\s*\{/)).not.toContain("opacity");
	});

	test("Monaco diagnostic hover pill, docs pill count, readiness badges, and primary-button pills enforce high-contrast tokens", () => {
		const hoverPill = blockOf(styleCss, /\.monaco-editor \.monaco-hover \.hover-row > \.marker\.hover-contents > \.marker-message > span:nth-child\(2\),[\s\S]*?\{/);
		expect(hoverPill).toContain("color: var(--editor-fg) !important;");
		expect(hoverPill).toContain("opacity: 1 !important;");

		const docsPill = blockOf(styleCss, /\.docs-pill-count\s*\{/);
		expect(docsPill).toContain("color: var(--strong-fg);");

		const schedOnPrimary = blockOf(planCanvasCss, /\.plan-sched-pill\.on-primary\s*\{/);
		expect(schedOnPrimary).toContain("background: transparent;");
		expect(schedOnPrimary).not.toContain("rgb(255 255 255 / 0.2)");

		expect(blockOf(cmLiveCss, /\.md-readiness-badge\.ready\s*\{/)).toContain("color: var(--editor-strong, var(--strong-fg));");
		expect(blockOf(cmLiveCss, /\.md-readiness-badge\.pending\s*\{/)).toContain("color: var(--editor-strong, var(--strong-fg));");
		expect(blockOf(styleCss, /\.md-inspector \.md-readiness-badge\.ready\s*\{/)).toContain("color: var(--strong-fg);");
		expect(blockOf(styleCss, /\.md-inspector \.md-readiness-badge\.pending\s*\{/)).toContain("color: var(--strong-fg);");

		expect(blockOf(tableExtraCss, /\.table-bar \.doc-status\.table-dupes-chip\[aria-pressed="true"\]\s*\{/)).toContain("color: var(--strong-fg);");
		expect(blockOf(tableExtraCss, /\.table-bar \.doc-status\.table-issues-toggle\[aria-pressed="true"\]\s*\{/)).toContain("color: var(--strong-fg);");
		expect(blockOf(tableExtraCss, /\.table-sort-prio\s*\{/)).toContain("color: var(--strong-fg);");
		expect(blockOf(styleCss, /\.md-diff-del\s*\{/)).toContain("color: var(--strong-fg);");
		expect(blockOf(styleCss, /\.md-diff-ins\s*\{/)).toContain("color: var(--strong-fg);");
		expect(blockOf(styleCss, /\.dialog button\.danger:hover\s*\{/)).toContain("color: var(--strong-fg);");
		expect(blockOf(styleCss, /\.md-insp-warn-pill,\s*\n\.md-insp-broken-pill\s*\{/)).toContain("color: var(--strong-fg);");
		expect(blockOf(graphExtraCss, /\.graph-list-ticket-badge\s*\{/)).toContain("10%");
		expect(blockOf(planExtraCss, /\.plan-node-doc-kind\s*\{/)).toContain("10%");
	});

	test("all updated tinted surfaces pass WCAG AA (>= 4.5:1) mathematically across all 27 built-in themes", () => {
		const allThemes = [
			...allOklchThemes().map((t) => ({ name: t.name, s: t.studio })),
			...(
				[
					["Classic Dark", dark],
					["Classic Light", light],
				] as const
			).map(([name, t]) => ({
				name,
				s: {
					sideBg: t.colors["sideBar.background"]!,
					selected: t.colors["list.activeSelectionBackground"]!,
					tabBg: t.colors["tab.inactiveBackground"]!,
					bg: t.colors["editor.background"]!,
					fg: t.colors["editor.foreground"]!,
					strongFg: t.colors["tab.activeForeground"]!,
					muted: t.colors["descriptionForeground"]!,
					accent: t.colors["focusBorder"]!,
					ok: t.colors["testing.iconPassed"]!,
					warning: t.colors["editorWarning.foreground"]!,
					error: t.colors["editorError.foreground"]!,
					info: t.colors["editorInfo.foreground"]!,
					inputBg: t.colors["input.background"]!,
					inputFg: t.colors["input.foreground"]!,
					editorBg: t.colors["editor.background"]!,
					editorFg: t.colors["editor.foreground"]!,
					editorStrong: t.colors["tab.activeForeground"]!,
					editorMuted: t.colors["descriptionForeground"]!,
					editorAccent: t.colors["focusBorder"]!,
					editorOk: t.colors["testing.iconPassed"]!,
					editorWarning: t.colors["editorWarning.foreground"]!,
					editorError: t.colors["editorError.foreground"]!,
					editorInfo: t.colors["editorInfo.foreground"]!,
				},
			})),
		];
		expect(allThemes.length).toBe(27);

		for (const { name, s } of allThemes) {
			// Monaco diagnostic hover code pill (8% over 10% tinted editorBg)
			for (const sev of [s.editorWarning, s.editorError, s.editorInfo]) {
				const rowBg = mixSrgb(sev, 10, s.editorBg);
				const pillBg = mixSrgb(sev, 8, rowBg);
				expect(contrast(s.editorFg, pillBg), `${name} monaco hover pill`).toBeGreaterThanOrEqual(TEXT);
				expect(contrast(s.editorFg, rowBg), `${name} monaco hover detail`).toBeGreaterThanOrEqual(TEXT);
			}
			// Docs warning pill count (inactive 16% over sideBg, active 20% over selected)
			expect(contrast(s.strongFg, mixSrgb(s.warning, 16, s.sideBg)), `${name} docs pill`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.warning, 20, s.selected)), `${name} docs pill active`).toBeGreaterThanOrEqual(TEXT);
			// Callout headers (4% head over 6% body over local bg — chrome & editor polarities)
			for (const [tone, baseBg] of [
				[s.info, s.bg],
				[s.ok, s.bg],
				[s.warning, s.bg],
				[s.error, s.bg],
				[s.accent, s.bg],
				[s.muted, s.bg],
				[s.editorInfo, s.editorBg],
				[s.editorOk, s.editorBg],
				[s.editorWarning, s.editorBg],
				[s.editorError, s.editorBg],
				[s.editorAccent, s.editorBg],
				[s.editorMuted, s.editorBg],
			] as const) {
				const headBg = mixSrgb(tone, 4, mixSrgb(tone, 6, baseBg));
				expect(contrast(tone, headBg), `${name} callout head`).toBeGreaterThanOrEqual(TEXT);
			}
			// Plan code drilldown inside rightbar (inputFg & muted over inputBg)
			expect(contrast(s.inputFg, s.inputBg), `${name} plan-impl-pre`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.muted, s.inputBg), `${name} plan-impl-ln`).toBeGreaterThanOrEqual(TEXT);
			// Table chips & badges
			expect(contrast(s.strongFg, mixSrgb(s.warning, 12, s.tabBg)), `${name} dupes chip`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.warning, 11, mixSrgb(s.warning, 7, s.tabBg))), `${name} issues toggle`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.accent, 12, s.sideBg)), `${name} sort prio`).toBeGreaterThanOrEqual(TEXT);
			// Dialog danger button rest & hover
			expect(contrast(s.error, mixSrgb(s.error, 10, s.sideBg)), `${name} dialog danger`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.error, 16, s.sideBg)), `${name} dialog danger hover`).toBeGreaterThanOrEqual(TEXT);
			// Readiness badges & diff highlights
			expect(contrast(s.strongFg, mixSrgb(s.ok, 12, s.sideBg)), `${name} readiness ready`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.warning, 12, s.sideBg)), `${name} readiness pending`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.editorStrong, mixSrgb(s.editorError, 12, s.editorBg)), `${name} md-diff-del`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.editorStrong, mixSrgb(s.editorOk, 12, s.editorBg)), `${name} md-diff-ins`).toBeGreaterThanOrEqual(TEXT);
		}
	});
});

describe("R9C responsive 900x800, uiScale=1.6, print/PDF & wrapping invariants", () => {
	test("MenuBar, StatusBar, Lightbox, FolioHeader, GraphFind & secondary bars truncate/wrap cleanly", () => {
		const cmdCenter = blockOf(styleCss, /\.cmd-center\s*\{/);
		expect(cmdCenter).toContain("flex: 0 4 auto;");
		expect(cmdCenter).toContain("width: min(260px, 24vw);");
		expect(cmdCenter).toContain("min-width: 0;");

		const menuPop = blockOf(styleCss, /\.menubar-menus \.menu-pop\s*\{/);
		expect(menuPop).toContain("max-width: calc(100vw - 16px);");

		const menuWhy = blockOf(styleCss, /\.menu-why\s*\{/);
		expect(menuWhy).toContain("position: sticky;");
		expect(menuWhy).toContain("bottom: 0;");
		expect(menuWhy).toContain("background: var(--side-bg);");

		const gitItem = blockOf(styleCss, /\.statusbar \.git-item\s*\{\s*flex:/);
		expect(gitItem).toContain("flex: 0 1 auto;");
		expect(gitItem).toContain("text-overflow: ellipsis;");
		expect(gitItem).toContain("max-width: 22ch;");

		const sizeAlert = blockOf(styleCss, /\.statusbar \.status-size-alert\s*\{/);
		expect(sizeAlert).toContain("flex: 0 1 auto;");
		expect(sizeAlert).toContain("text-overflow: ellipsis;");
		expect(sizeAlert).toContain("max-width: 24ch;");

		expect(blockOf(cmLiveCss, /\.md-lightbox-caption\s*\{/)).toContain("min-width: 0;");
		const lbPath = blockOf(cmLiveCss, /\.md-lightbox-path\s*\{/);
		expect(lbPath).toContain("overflow: hidden;");
		expect(lbPath).toContain("text-overflow: ellipsis;");
		expect(blockOf(cmLiveCss, /\.md-lightbox-btn\s*\{/)).toContain("flex: none;");

		expect(blockOf(styleCss, /\.folio-title-row\s*\{/)).toContain("flex-wrap: wrap;");
		const folioFn = blockOf(styleCss, /\.folio-filename\s*\{/);
		expect(folioFn).toContain("min-width: 0;");
		expect(folioFn).toContain("text-overflow: ellipsis;");

		expect(blockOf(styleCss, /\.graph-find-list\s*\{/)).toContain("max-width: min(360px, calc(100vw - 24px));");
		expect(blockOf(styleCss, /\.bottom-tabs\s*\{/)).toContain("overflow-x: auto;");
		expect(blockOf(styleCss, /\.diff-bar\s*\{/)).toContain("flex-wrap: wrap;");
		expect(blockOf(styleCss, /\.profile-head\s*\{/)).toContain("flex-wrap: wrap;");
		expect(blockOf(styleCss, /\.profile-presets\s*\{/)).toContain("flex-wrap: wrap;");
		expect(blockOf(styleCss, /\.profile-sections\s*\{/)).toContain("minmax(min(330px, 100%), 1fr)");
		const modeSwitch = blockOf(styleCss, /\.mode-switch\s*\{/);
		expect(modeSwitch).toContain("flex: none;");
		expect(modeSwitch).toContain("white-space: nowrap;");
	});

	test("scaled interactive controls use min-height with --ui-scale and height: auto instead of hard px heights", () => {
		const checks: [string, string, RegExp][] = [
			["cm-callout-action-btn", cmLiveCss, /\.cm-callout-action-btn\s*\{/],
			["cm-tbl-qbtn", cmLiveCss, /\.cm-tbl-qbtn\s*\{/],
			["md-work-btn (cmLive)", cmLiveCss, /\.md-work-btn\s*\{/],
			["cm-md-sel-btn", cmLiveCss, /\.cm-md-sel-btn\s*\{/],
			["md-insp-mini-btn", styleCss, /\.md-insp-mini-btn\s*\{/],
			["md-usage-filter", styleCss, /\.md-usage-filter\s*\{/],
			["md-insp-btn", styleCss, /\.md-insp-btn,\s*\n\.md-insp-menu > button,/],
			["md-inspector .md-work-btn", styleCss, /\.md-inspector \.md-work-btn\s*\{/],
		];
		for (const [label, src, re] of checks) {
			const body = blockOf(src, re);
			expect(body, `${label} min-height`).toMatch(/min-height:\s*calc\(\d+px\s*\*\s*var\(--ui-scale\)\);/);
			expect(body, `${label} height: auto`).toContain("height: auto;");
		}
	});

	test("@media print unclips .editors/.editor-sheet and resets dark-theme editor variables to light paper ink", () => {
		const stylePrint = blockOf(styleCss, /@media print\s*\{/);
		expect(stylePrint).toContain(".editors");
		expect(stylePrint).toContain(".editor-sheet");
		expect(stylePrint).toContain("overflow: visible !important;");
		expect(stylePrint).toContain("display: block !important;");
		expect(stylePrint).toContain("border: 0 !important;");
		expect(stylePrint).toContain("box-shadow: none !important;");
		expect(stylePrint).toContain("height: auto !important;");

		const cmPrint = blockOf(cmLiveCss, /@media print\s*\{/);
		expect(cmPrint).toMatch(/\.cm-md-host,\s*\n\s*\.md-view\s*\{/);
		for (const decl of [
			"--editor-bg: #ffffff;",
			"--editor-fg: #111111;",
			"--editor-strong: #000000;",
			"--editor-muted: #4b5563;",
			"--editor-accent: #1d4ed8;",
			"--editor-border: #d1d5db;",
			"--editor-strip-bg: #f8fafc;",
			"--bg: #ffffff;",
			"--fg: #111111;",
			"--strong-fg: #000000;",
			"--muted: #4b5563;",
			"--border: #d1d5db;",
			"color-scheme: light;",
		]) {
			expect(cmPrint).toContain(decl);
		}
	});
});

describe("R9C consolidated TABLE_POWER_CSS & accessibility", () => {
	test("tableViewExtra.css consolidates TABLE_POWER_CSS without !important conflicts on .table-group-row", () => {
		expect(tableExtraCss).toContain("width: 56px;");
		expect(tableExtraCss).toContain(".table-row-num.draggable");
		expect(tableExtraCss).toContain(".table-scroll.is-dragging-row");
		expect(tableExtraCss).toContain(".table-scroll.is-drag-selecting");
		expect(tableExtraCss).toContain(".cell-empty-key:not(.col-frozen-last)");
		expect(tableExtraCss).toContain(".cell-empty-key.col-frozen-last");
		expect(tableExtraCss).toContain(".table-status-pill[aria-pressed=\"true\"]");
		expect(tableExtraCss).toContain(".table-bar .doc-status.table-fmt-chip");

		const groupTd = blockOf(tableExtraCss, /\.table-view tbody tr\.table-group-row td\s*\{/);
		expect(groupTd).not.toContain("!important");
		const groupHover = blockOf(tableExtraCss, /\.table-view tbody tr\.table-group-row:hover td\s*\{/);
		expect(groupHover).toContain("background:");
		const groupSelCol = blockOf(tableExtraCss, /\.table-view tbody tr\.table-group-row td\.table-sel-col\s*\{/);
		expect(groupSelCol).toContain("padding: 0;");
		expect(tableExtraCss).not.toMatch(/\.table-group-row[^{]*\{[^}]*!important/);
	});

	test(":focus-visible outlines are restored and preserved on interactive surfaces", () => {
		const planFocus = blockOf(planCanvasCss, /\.plan-canvas:focus-visible\s*\{/);
		expect(planFocus).toContain("outline: 2px solid var(--accent);");
		expect(planFocus).toContain("outline-offset: -2px;");

		expect(styleCss).toMatch(/a:focus-visible,\s*summary:focus-visible,[\s\S]*?outline:\s*2px solid var\(--accent\);/);

		const findFocus = blockOf(tableExtraCss, /\.table-find-input:focus-visible\s*\{/);
		expect(findFocus).toContain("outline: 2px solid var(--accent);");

		const usageInput = blockOf(styleCss, /\.md-usage-filter input\s*\{/);
		expect(usageInput).not.toContain("outline: none;");
		const usageFocus = blockOf(styleCss, /\.md-usage-filter input:focus-visible\s*\{/);
		expect(usageFocus).toContain("outline: 2px solid var(--accent);");
	});

	test("prefers-reduced-motion suppresses plan-code-pulse animation and slide/rotation transitions", () => {
		expect(planCanvasCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.plan-node\.unit-running rect\.plan-code-dot\.blue\s*\{\s*animation:\s*none;\s*\}/);
		expect(planCanvasCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.plan-shape-dock[\s\S]*?transition:\s*none;/);
		expect(cmLiveCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.cm-md-details-summary::before[\s\S]*?transition:\s*none;/);
		expect(tableExtraCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.table-fill-handle[\s\S]*?transition:\s*none;/);
	});
});
