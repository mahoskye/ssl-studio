import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, TEXT } from "../src/shared/contrast";
import { allOklchThemes } from "../src/shared/oklchTheme";
import {
	countOutputByChannel,
	DEFAULT_OUTPUT_LEVEL_FILTER,
	filterOutputEntries,
	formatOutputForCopy,
	inferOutputChannel,
	inferOutputLevel,
	isOutputLevelFiltered,
	OUTPUT_CHANNELS,
	splitLogLines,
	stripAnsi,
	type OutputEntry,
} from "../src/shared/outputChannels";
import dark from "../src/view/themes/studio-dark.json";
import light from "../src/view/themes/studio-light.json";

const repoRead = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

function mixSrgb(fgHex: string, pct: number, bgHex: string): string {
	const parse = (h: string) => {
		const c = h.replace("#", "");
		return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)] as const;
	};
	const [r1, g1, b1] = parse(fgHex);
	const [r2, g2, b2] = parse(bgHex);
	const w = pct / 100;
	const ch = (a: number, b: number) => Math.round(a * w + b * (1 - w)).toString(16).padStart(2, "0");
	return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

describe("Output panel — channels, inference, ANSI cleanup, filtering, and copy formatting", () => {
	test("stripAnsi and splitLogLines sanitize ANSI CSI/OSC sequences and normalize line endings", () => {
		const raw = "\x1b[32mINFO\x1b[0m starlims-lsp ready\r\n\x1b]0;title\x07\x1b[33mWARN\x1b[0m slow index\r\n   \r\n";
		expect(stripAnsi("\x1b[31merror\x1b[0m")).toBe("error");
		expect(splitLogLines(raw)).toEqual(["INFO starlims-lsp ready", "WARN slow index"]);
	});

	test("inferOutputChannel and inferOutputLevel classify legacy log calls accurately", () => {
		expect(inferOutputChannel("starlims-lsp exited 1; restarting.")).toBe("lsp");
		expect(inferOutputChannel("format on save skipped: the language server did not answer in 5 s")).toBe("lsp");
		expect(inferOutputChannel("opencode did not start: ENOENT")).toBe("agent");
		expect(inferOutputChannel("MCP server docs-search skipped (untrusted)")).toBe("agent");
		expect(inferOutputChannel("git commit failed: pre-commit hook rejected")).toBe("git");
		expect(inferOutputChannel("Local history is not being kept: EACCES")).toBe("docs");
		expect(inferOutputChannel("opened /workspace/demo")).toBe("studio");

		expect(inferOutputLevel("error: Failed to write file")).toBe("error");
		expect(inferOutputLevel("uncaught: TypeError")).toBe("error");
		expect(inferOutputLevel("opencode did not start: ENOENT")).toBe("error");
		expect(inferOutputLevel("format on save skipped: timed out")).toBe("warn");
		expect(inferOutputLevel("starlims-lsp exited 1; restarting.")).toBe("warn");
		expect(inferOutputLevel("opened /workspace/demo")).toBe("info");
	});

	test("countOutputByChannel, filterOutputEntries, and formatOutputForCopy scope cleanly by channel, level, and query", () => {
		const entries: OutputEntry[] = [
			{ id: 1, time: "10:00:01", channel: "studio", level: "info", text: "opened /ws/demo" },
			{ id: 2, time: "10:00:02", channel: "lsp", level: "info", text: "Initialized starlims-lsp 0.33.1" },
			{ id: 3, time: "10:00:03", channel: "lsp", level: "warn", text: "format on save skipped: timeout" },
			{ id: 4, time: "10:00:04", channel: "agent", level: "error", text: "opencode failed to connect" },
			{ id: 5, time: "10:00:05", channel: "git", level: "info", text: "Repository ready on main" },
			{ id: 6, time: "10:00:06", channel: "docs", level: "info", text: "Document audit: 0 warnings, 9 notes" },
		];

		expect(OUTPUT_CHANNELS.map((c) => c.id)).toEqual(["studio", "lsp", "agent", "git", "docs"]);
		expect(countOutputByChannel(entries)).toEqual({ all: 6, studio: 1, lsp: 2, agent: 1, git: 1, docs: 1 });
		expect(isOutputLevelFiltered(DEFAULT_OUTPUT_LEVEL_FILTER)).toBe(false);

		// Channel dropdown scoping
		expect(
			filterOutputEntries(entries, { channel: "lsp", levels: DEFAULT_OUTPUT_LEVEL_FILTER, query: "" }).map((e) => e.id),
		).toEqual([2, 3]);

		// Severity filter across all channels
		const errorsAndWarns = { error: true, warn: true, info: false };
		expect(isOutputLevelFiltered(errorsAndWarns)).toBe(true);
		expect(
			filterOutputEntries(entries, { channel: "all", levels: errorsAndWarns, query: "" }).map((e) => e.id),
		).toEqual([3, 4]);

		// Multi-word text query matches across channel short label and message text
		expect(
			filterOutputEntries(entries, { channel: "all", levels: DEFAULT_OUTPUT_LEVEL_FILTER, query: "lsp 0.33" }).map((e) => e.id),
		).toEqual([2]);

		// Copy formatting omits channel tag when viewing a single channel, includes it on All Channels
		expect(formatOutputForCopy([entries[1]!], { showTimestamps: true, showChannelTag: true })).toBe(
			"10:00:02  [LSP]  Initialized starlims-lsp 0.33.1",
		);
		expect(formatOutputForCopy([entries[1]!], { showTimestamps: false, showChannelTag: false })).toBe(
			"Initialized starlims-lsp 0.33.1",
		);
	});
});

describe("Output panel — 27-theme WCAG AA contrast and wiring invariants", () => {
	test("all Output channel tags, warn/error lines, and channel dropdown meet WCAG AA (>= 4.5:1) across all 27 themes", () => {
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
					panelBg: t.colors["panel.background"] ?? t.colors["sideBar.background"]!,
					inputBg: t.colors["input.background"]!,
					inputFg: t.colors["input.foreground"]!,
					fg: t.colors["sideBar.foreground"]!,
					strongFg: t.colors["tab.activeForeground"]!,
					accent: t.colors["focusBorder"]!,
					info: t.colors["editorInfo.foreground"] ?? t.colors["focusBorder"]!,
					warning: t.colors["editorWarning.foreground"]!,
					error: t.colors["editorError.foreground"]!,
					ok: t.colors["testing.iconPassed"]!,
				},
			})),
		];
		expect(allThemes.length).toBe(27);

		for (const { name, s } of allThemes) {
			expect(contrast(s.inputFg, s.inputBg), `${name} Output channel dropdown`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.fg, 7, s.panelBg)), `${name} Studio channel tag`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.accent, 14, s.panelBg)), `${name} LSP channel tag`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.info, 14, s.panelBg)), `${name} Agent channel tag`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.ok, 14, s.panelBg)), `${name} Git channel tag`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.warning, 14, s.panelBg)), `${name} Docs channel tag`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.fg, mixSrgb(s.warning, 7, s.panelBg)), `${name} warn log line`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.error, 8, s.panelBg)), `${name} error log line`).toBeGreaterThanOrEqual(TEXT);
		}
	});

	test("Output panel dropdown, clear/lock controls, backend wiring, and re-exports are properly wired", () => {
		const outSrc = repoRead("src/view/panels/Output.tsx");
		expect(outSrc).toContain('data-output-channel="true"');
		expect(outSrc).toContain('class="output-channel-picker"');
		expect(outSrc).toContain('name="chevron-down"');
		expect(outSrc).not.toContain("<select");
		expect(outSrc).toContain('data-output-clear="true"');
		expect(outSrc).toContain('data-output-lock="true"');
		expect(outSrc).toContain("<FilterBox");
		// Never statically import ../commands from a panel (circular import guard)
		expect(outSrc).not.toMatch(/^\s*import\s+[^;]*from\s+["']\.\.\/commands["']/m);

		const appSrc = repoRead("src/view/App.tsx");
		expect(appSrc).toContain("<OutputHeaderActions />");

		const probSrc = repoRead("src/view/panels/Problems.tsx");
		expect(probSrc).toContain('export { endFollower, Output, OutputHeaderActions } from "./Output"');

		const backendSrc = repoRead("src/bun/backend.ts");
		expect(backendSrc).toContain('host.emit("output", { channel: "lsp", text: line })');
	});
});
