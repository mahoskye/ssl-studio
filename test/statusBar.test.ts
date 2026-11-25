import { describe, expect, test } from "bun:test";
import { buildLanguagePickerEntries, LANGUAGES, languageFor, languageName } from "../src/shared/languages";
import { DEFAULT_SETTINGS } from "../src/shared/protocol";
import {
	agentIndicator,
	badgeText,
	lspIndicator,
	nonDefaultEncoding,
	nonDefaultEol,
	planStepSummary,
	resolveStatusSurface,
	sslSizeAlerts,
	tableGridSummary,
} from "../src/shared/statusBar";

describe("StatusBar service indicators", () => {
	test("lspIndicator maps running, warning, starting, idle, and stopped states cleanly", () => {
		expect(lspIndicator({ state: "stopped" }, { ok: true, version: "0.31.0" }, false)).toMatchObject({
			tone: "idle",
			label: "LSP",
			actionable: false,
		});
		expect(lspIndicator({ state: "starting" }, { ok: true, version: "0.31.0" }, true)).toMatchObject({
			tone: "busy",
			label: "LSP",
			actionable: true,
		});
		const running = lspIndicator({ state: "running" }, { ok: true, version: "0.31.0" }, true);
		expect(running).toMatchObject({ tone: "ok", label: "LSP", actionable: true });
		expect(running.detail).toContain("0.31.0");
		const warn = lspIndicator({ state: "running" }, { ok: true, version: "0.30.0", message: "Tested with 0.31.0" }, true);
		expect(warn.tone).toBe("warn");
		expect(warn.detail).toContain("Tested with 0.31.0");
		const down = lspIndicator({ state: "failed", message: "crashed" }, { ok: true, version: "0.31.0" }, true);
		expect(down.tone).toBe("error");
		expect(down.detail).toContain("crashed");
	});

	test("agentIndicator reflects live opencode status and availability", () => {
		expect(agentIndicator({ state: "off" }, { ok: false, message: "not on PATH" })).toMatchObject({
			tone: "warn",
			label: "Agent",
		});
		const idle = agentIndicator({ state: "off" }, { ok: true, version: "2.3.2" });
		expect(idle).toMatchObject({ tone: "idle", label: "Agent" });
		expect(idle.detail).toContain("opencode 2.3.2");
		expect(agentIndicator({ state: "starting" }, { ok: true, version: "2.3.2" }).tone).toBe("busy");
		const ready = agentIndicator({ state: "ready", version: "2.3.2" }, { ok: true, version: "2.3.2" });
		expect(ready.tone).toBe("ok");
		expect(ready.detail).toContain("opencode 2.3.2");
		expect(agentIndicator({ state: "failed", message: "stopped" }, { ok: true, version: "2.3.2" }).tone).toBe("error");
	});
});

describe("StatusBar view-aware surface resolution", () => {
	const base = {
		centerView: "editors" as const,
		inReview: false,
		path: "/ws/design/Flow.plan.json",
		languageId: "json",
		isPlan: false,
		planMode: "chart" as const,
		isMarkdown: false,
		mdMode: "live" as const,
		isTable: false,
		tableText: false,
		groupMode: "text" as const,
	};

	test("hides cursor, encoding, EOL, JSON, and language picker in Chart or Outline mode; enables them in Source mode", () => {
		expect(resolveStatusSurface({ ...base, isPlan: true, planMode: "chart" })).toEqual({
			kind: "plan-chart",
			showCursor: false,
			showTextMeta: false,
			showLanguagePicker: false,
			showWordCount: false,
			showSizeWarning: false,
			modeLabel: "Flowchart",
		});
		expect(resolveStatusSurface({ ...base, isPlan: true, planMode: "text" })).toEqual({
			kind: "plan-outline",
			showCursor: false,
			showTextMeta: false,
			showLanguagePicker: false,
			showWordCount: false,
			showSizeWarning: false,
			modeLabel: "Plan Outline",
		});
		expect(resolveStatusSurface({ ...base, isPlan: true, planMode: "source" })).toEqual({
			kind: "text",
			showCursor: true,
			showTextMeta: true,
			showLanguagePicker: true,
			showWordCount: false,
			showSizeWarning: false,
			modeLabel: null,
		});
	});

	test("keeps UTF/EOL in text & Live modes, enables Language Mode picker in code/text windows, and hides text meta in visual modes", () => {
		expect(resolveStatusSurface({ ...base, path: "/ws/docs/registries/db.csv", languageId: "plaintext", isTable: true, tableText: false })).toMatchObject({
			kind: "table-grid",
			showCursor: false,
			showTextMeta: false,
			showLanguagePicker: false,
			modeLabel: "Table",
		});
		expect(resolveStatusSurface({ ...base, path: "/ws/docs/registries/db.csv", languageId: "csv", isTable: true, tableText: true })).toMatchObject({
			kind: "text",
			showCursor: true,
			showTextMeta: true,
			showLanguagePicker: true,
		});
		expect(resolveStatusSurface({ ...base, path: "/ws/README.md", languageId: "markdown", isMarkdown: true, mdMode: "read" })).toEqual({
			kind: "markdown-read",
			showCursor: false,
			showTextMeta: false,
			showLanguagePicker: false,
			showWordCount: true,
			showSizeWarning: false,
			modeLabel: "Read",
		});
		expect(resolveStatusSurface({ ...base, path: "/ws/README.md", languageId: "markdown", isMarkdown: true, mdMode: "live" })).toEqual({
			kind: "markdown-live",
			showCursor: true,
			showTextMeta: true,
			showLanguagePicker: false,
			showWordCount: true,
			showSizeWarning: false,
			modeLabel: "Markdown",
		});
		expect(resolveStatusSurface({ ...base, path: "/ws/src/DueRule.ssl", languageId: "ssl", groupMode: "blocks" })).toEqual({
			kind: "ssl-blocks",
			showCursor: false,
			showTextMeta: false,
			showLanguagePicker: false,
			showWordCount: false,
			showSizeWarning: true,
			modeLabel: "SSL Blocks",
		});
		expect(resolveStatusSurface({ ...base, path: "/ws/src/DueRule.ssl", languageId: "ssl", groupMode: "text" })).toEqual({
			kind: "text",
			showCursor: true,
			showTextMeta: true,
			showLanguagePicker: true,
			showWordCount: false,
			showSizeWarning: true,
			modeLabel: null,
		});
		expect(resolveStatusSurface({ ...base, centerView: "graph" })).toMatchObject({
			kind: "graph",
			showCursor: false,
			showLanguagePicker: false,
			modeLabel: "Call Graph",
		});
		expect(resolveStatusSurface({ ...base, path: "/ws/img.png", binary: { size: 100, image: "image/png" } })).toMatchObject({
			kind: "binary",
			showCursor: false,
			showLanguagePicker: false,
			modeLabel: "Picture",
		});
	});

	test("surfaces near/over SSL size limits only when triggered, and formats helpers cleanly", () => {
		expect(nonDefaultEncoding("utf-8")).toBeNull();
		expect(nonDefaultEncoding("utf-8-bom")).toBe("UTF-8 with BOM");
		expect(nonDefaultEol("\n")).toBeNull();
		expect(nonDefaultEol("\r\n")).toBe("CRLF");

		const healthy = sslSizeAlerts({ bytes: 4900, codeLines: 56, historyEntries: 1 }, DEFAULT_SETTINGS.limits);
		expect(healthy.alerts).toEqual([]);

		const over = sslSizeAlerts({ bytes: 4900, codeLines: DEFAULT_SETTINGS.limits.codeLines + 20, historyEntries: 1 }, DEFAULT_SETTINGS.limits);
		expect(over.alerts).toEqual([{ text: `${DEFAULT_SETTINGS.limits.codeLines + 20} code lines (over)`, severity: "over" }]);

		expect(badgeText(0)).toBe("");
		expect(badgeText(6)).toBe("6");
		expect(badgeText(120)).toBe("99+");

		expect(planStepSummary('{"nodes":[{"id":"1"},{"id":"2"}]}')).toBe("2 steps");
		expect(planStepSummary("not json")).toBeNull();

		expect(tableGridSummary("Name,Value,Ticket\nA,1,T-1\nB,2,T-2\n")).toBe("2 rows × 3 cols");
		expect(tableGridSummary("")).toBeNull();
	});
});

describe("STARLIMS companion language catalog and Language Mode picker", () => {
	test("maps STARLIMS and common enterprise companion file types accurately", () => {
		expect(languageFor("src/DueRule.ssl")).toBe("ssl");
		expect(languageFor("src/Samples.ds")).toBe("ssl");
		expect(languageFor("forms/Panel.xfd")).toBe("xml");
		expect(languageFor("Web.config")).toBe("xml");
		expect(languageFor("Report.rdlc")).toBe("xml");
		expect(languageFor("Bridge.cs")).toBe("csharp");
		expect(languageFor("LegacyMacro.vb")).toBe("vb");
		expect(languageFor("Import.vbs")).toBe("vb");
		expect(languageFor("Portal.aspx")).toBe("razor");
		expect(languageFor("Index.cshtml")).toBe("razor");
		expect(languageFor("deploy.ps1")).toBe("powershell");
		expect(languageFor("install.bat")).toBe("bat");
		expect(languageFor("run.cmd")).toBe("bat");
		expect(languageFor("build.sh")).toBe("shell");
		expect(languageFor("query.sql")).toBe("sql");
		expect(languageFor("schema.pgsql")).toBe("pgsql");
		expect(languageFor("Dockerfile")).toBe("dockerfile");
		expect(languageFor("deploy/Dockerfile.prod")).toBe("dockerfile");
		expect(languageFor("sample.hl7")).toBe("plaintext");
		expect(languageFor("Untitled-1")).toBe("plaintext");
		expect(languageName("vb")).toBe("Visual Basic");
		expect(languageName("bat")).toBe("Batch");
		expect(languageName("razor")).toBe("Razor / ASP.NET");
		expect(languageName("plaintext")).toBe("Plain Text");
		expect(languageName(undefined)).toBe("Plain Text");
		expect(new Set(LANGUAGES.map((l) => l.id)).size).toBe(LANGUAGES.length);
	});

	test("buildLanguagePickerEntries includes Auto Detect only when overridden and marks current/detected cleanly", () => {
		const normal = buildLanguagePickerEntries("ssl", "ssl");
		expect(normal[0]?.isAutoDetect).toBeUndefined();
		expect(normal.find((e) => e.id === "ssl")).toMatchObject({ current: true, detected: true });
		expect(normal.some((e) => e.id === "plaintext")).toBe(true);

		const overridden = buildLanguagePickerEntries("sql", "plaintext");
		expect(overridden[0]).toMatchObject({
			id: "plaintext",
			label: "Auto Detect (Plain Text)",
			isAutoDetect: true,
		});
		expect(overridden.find((e) => e.id === "sql" && !e.isAutoDetect)?.current).toBe(true);
		expect(overridden.find((e) => e.id === "plaintext" && !e.isAutoDetect)?.detected).toBe(true);
	});
});
