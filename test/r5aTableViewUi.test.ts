import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseClipboardGrid, parseCsv } from "../src/shared/csv";
import { badgeToneForValue, DEFAULT_CSV_TABLE_CONFIG } from "../src/shared/csvFormat";
import type { DraftRule } from "../src/view/editor/CsvFormatDialog";
import type { OffsetTextEdit } from "../src/view/editor/TableView";

// --- Minimal headless browser, CSS & Monaco shims so exported pure helpers from .tsx views can be imported directly ---
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
		getElementById: () => null,
		createElement: () => ({ style: {}, getContext: () => null }),
		querySelector: () => null,
	};
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

const makeUri = (scheme: string, fsPath: string) => {
	const normalized = fsPath.replace(/\\/g, "/");
	const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
	return { scheme, fsPath, path: normalized, toString: () => raw };
};

mock.module(`${resolve(import.meta.dir, "../src/view/editor/tableViewExtra.css")}`, () => ({}));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({
	default: class {},
}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
for (const lang of [
	"markdown",
	"sql",
	"yaml",
	"xml",
	"ini",
	"shell",
	"powershell",
	"bat",
	"javascript",
	"typescript",
	"html",
	"css",
	"scss",
	"less",
	"csharp",
	"vb",
	"razor",
	"pgsql",
	"mysql",
	"python",
	"java",
	"cpp",
	"php",
	"dockerfile",
	"graphql",
	"r",
	"perl",
	"ruby",
	"go",
	"rust",
	"fsharp",
]) {
	mock.module(`monaco-editor/languages/definitions/${lang}/register`, () => ({}));
}

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
		from: () => ({}),
		file: (p: string) => makeUri("file", p),
		parse: (raw: string) => (raw.startsWith("file://") ? makeUri("file", raw.slice("file://".length)) : makeUri("untitled", raw)),
	},
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { KeyF: 36, KeyZ: 56, KeyY: 55 },
	languages: noopProxy({
		CompletionItemKind: { File: 1, Keyword: 2, Text: 3, Snippet: 4, Field: 5, Struct: 6 },
		SymbolKind: { Function: 11, Method: 5, Constructor: 8, Namespace: 2 },
		FoldingRangeKind: { Comment: "comment", Imports: "imports", Region: "region" },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
	}),
	editor: noopProxy({
		EndOfLineSequence: { LF: 0, CRLF: 1 },
		ScrollType: { Immediate: 1 },
		getEditors: () => [],
		getModels: () => [],
		getModel: () => null,
		createModel: () => null,
		onDidCreateModel: () => ({ dispose() {} }),
		setModelMarkers() {},
		getModelMarkers: () => [],
		registerEditorOpener: () => ({ dispose() {} }),
	}),
}));

const {
	coalesceZeroWidthEdits,
	colSnapshotTransitionKey,
	countVisibleFrozenColumns,
	formatSingleCellForClipboard,
	isTicketSeparatorChunk,
	remapRowIndexOnDelete,
	remapRowIndexOnInsert,
	remapRowSetOnDelete,
	remapRowSetOnInsert,
	resolveWorkspaceFileLink,
	serializeCellInRow,
} = await import("../src/view/editor/TableView");
const { fromDraft } = await import("../src/view/editor/CsvFormatDialog");

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

/** Applies offset-based edits in descending offset order (mirroring Monaco `pushEditOperations`). */
function applyOffsetEdits(raw: string, edits: readonly OffsetTextEdit[]): string {
	let out = raw;
	const sorted = coalesceZeroWidthEdits(edits).sort((a, b) => b.start - a.start || b.end - a.end);
	for (const ed of sorted) {
		out = out.slice(0, ed.start) + ed.text + out.slice(ed.end);
	}
	return out;
}

describe("Repair 2: serializeCellInRow preserves 1-column and ragged 1-cell rows", () => {
	test("clearing a cell in a 1-column CSV writes '\"\"' so parseCsv does not drop the row", () => {
		expect(serializeCellInRow("", 1, ",")).toBe('""');
		expect(serializeCellInRow("", 1, "\t")).toBe('""');
		expect(serializeCellInRow("", 0, ",")).toBe('""');
		expect(serializeCellInRow("alpha", 1, ",")).toBe("alpha");
		expect(serializeCellInRow("a,b", 1, ",")).toBe('"a,b"');

		const raw = "item\nfirst\nsecond\n";
		const t = parseCsv(raw);
		const cell = t.rows[0]![0]!;
		const cleared = applyOffsetEdits(raw, [
			{ start: cell.start, end: cell.end, text: serializeCellInRow("", t.rows[0]!.length, t.delimiter) },
		]);
		expect(cleared).toBe('item\n""\nsecond\n');
		const reparsed = parseCsv(cleared);
		expect(reparsed.rows).toHaveLength(2);
		expect(reparsed.rows[0]![0]!.text).toBe("");
		expect(reparsed.rows[1]![0]!.text).toBe("second");
	});

	test("clearing the only cell in a ragged 1-cell row preserves the row, while multi-cell rows stay unquoted", () => {
		expect(serializeCellInRow("", 2, ",")).toBe("");
		expect(serializeCellInRow("", 3, "|")).toBe("");

		const ragged = "a,b,c\nonly_one\nx,y,z\n";
		const t = parseCsv(ragged);
		expect(t.rows[0]).toHaveLength(1);
		const cell = t.rows[0]![0]!;
		const cleared = applyOffsetEdits(ragged, [
			{ start: cell.start, end: cell.end, text: serializeCellInRow("", t.rows[0]!.length, t.delimiter) },
		]);
		const reparsed = parseCsv(cleared);
		expect(reparsed.rows).toHaveLength(2);
		expect(reparsed.rows[0]![0]!.text).toBe("");
		expect(reparsed.rows[1]!.map((c) => c.text)).toEqual(["x", "y", "z"]);
	});
});

describe("Repair 3: coalesceZeroWidthEdits prevents ragged last-row paste corruption with no EOF newline", () => {
	test("merges same-offset zero-width edits in insertion order (empty trailing cell + padding + EOF append)", () => {
		const raw = "a,b,c\n1,";
		const t = parseCsv(raw);
		expect(t.rows[0]!.map((c) => [c.text, c.start, c.end])).toEqual([
			["1", 6, 7],
			["", 8, 8],
		]);

		// Simulate pasting 2x2 grid [["B1", "C1"], ["B2", "C2"]] at (row 0, col 1)
		const edits: OffsetTextEdit[] = [
			{ start: 8, end: 8, text: "B1" }, // existing empty trailing cell at EOF
			{ start: 8, end: 8, text: ",C1" }, // ragged tail padding for col 2
			{ start: 8, end: 8, text: "\n,B2,C2\n" }, // appended EOF row
		];
		const coalesced = coalesceZeroWidthEdits(edits);
		expect(coalesced).toEqual([{ start: 8, end: 8, text: "B1,C1\n,B2,C2\n" }]);

		const next = applyOffsetEdits(raw, edits);
		expect(next).toBe("a,b,c\n1,B1,C1\n,B2,C2\n");
		const parsed = parseCsv(next);
		expect(parsed.problems).toEqual([]);
		expect(parsed.rows.map((r) => r.map((c) => c.text))).toEqual([
			["1", "B1", "C1"],
			["", "B2", "C2"],
		]);
	});

	test("keeps non-zero-width cell replacements intact alongside coalesced EOF padding + append", () => {
		const raw = "a,b,c\n1,old";
		const edits: OffsetTextEdit[] = [
			{ start: 8, end: 11, text: "B1" },
			{ start: 11, end: 11, text: ",C1" },
			{ start: 11, end: 11, text: "\n,B2,C2\n" },
		];
		const coalesced = coalesceZeroWidthEdits(edits);
		expect(coalesced).toEqual([
			{ start: 8, end: 11, text: "B1" },
			{ start: 11, end: 11, text: ",C1\n,B2,C2\n" },
		]);
		const next = applyOffsetEdits(raw, edits);
		expect(next).toBe("a,b,c\n1,B1,C1\n,B2,C2\n");
		expect(parseCsv(next).rows.map((r) => r.map((c) => c.text))).toEqual([
			["1", "B1", "C1"],
			["", "B2", "C2"],
		]);
	});
});

describe("Repair 4: row selection remapping on insert, duplicate, and delete", () => {
	test("remapRowSetOnInsert / remapRowIndexOnInsert shifts indices >= targetRow by +1", () => {
		const sel = new Set([0, 2, 4]);
		expect([...remapRowSetOnInsert(sel, 2)].sort((a, b) => a - b)).toEqual([0, 3, 5]);
		expect([...remapRowSetOnInsert(sel, 0)].sort((a, b) => a - b)).toEqual([1, 3, 5]);
		expect([...remapRowSetOnInsert(sel, 5)].sort((a, b) => a - b)).toEqual([0, 2, 4]);

		expect(remapRowIndexOnInsert(null, 2)).toBeNull();
		expect(remapRowIndexOnInsert(1, 2)).toBe(1);
		expect(remapRowIndexOnInsert(2, 2)).toBe(3);
		expect(remapRowIndexOnInsert(4, 2)).toBe(5);
	});

	test("remapRowSetOnDelete / remapRowIndexOnDelete drops deleted row and decrements rows > deletedRow", () => {
		const sel = new Set([0, 2, 4]);
		expect([...remapRowSetOnDelete(sel, 2)].sort((a, b) => a - b)).toEqual([0, 3]);
		expect([...remapRowSetOnDelete(sel, 1)].sort((a, b) => a - b)).toEqual([0, 1, 3]);
		expect([...remapRowSetOnDelete(sel, 4)].sort((a, b) => a - b)).toEqual([0, 2]);

		expect(remapRowIndexOnDelete(null, 2)).toBeNull();
		expect(remapRowIndexOnDelete(2, 2)).toBeNull();
		expect(remapRowIndexOnDelete(1, 2)).toBe(1);
		expect(remapRowIndexOnDelete(3, 2)).toBe(2);
	});
});

describe("Repair 8: ticketCell separator chunks never trigger unknown-ticket warnings", () => {
	test("isTicketSeparatorChunk matches comma, semicolon, and whitespace separators only", () => {
		expect(isTicketSeparatorChunk(", ")).toBe(true);
		expect(isTicketSeparatorChunk(",")).toBe(true);
		expect(isTicketSeparatorChunk("; ")).toBe(true);
		expect(isTicketSeparatorChunk(" , ; \t ")).toBe(true);
		expect(isTicketSeparatorChunk("   ")).toBe(true);

		expect(isTicketSeparatorChunk("")).toBe(false);
		expect(isTicketSeparatorChunk("DEMO-1")).toBe(false);
		expect(isTicketSeparatorChunk("DEMO-999")).toBe(false);
		expect(isTicketSeparatorChunk("N/A")).toBe(false);
		expect(isTicketSeparatorChunk("DEMO-1/DEMO-2")).toBe(false);
	});

	test("splitting multi-ticket cells classifies all delimiters as separator chunks", () => {
		const chunks = "DEMO-1, DEMO-2; DEMO-3".split(/([\s,;]+)/);
		const nonSeparators = chunks.filter((c) => c && !isTicketSeparatorChunk(c));
		expect(nonSeparators).toEqual(["DEMO-1", "DEMO-2", "DEMO-3"]);
	});
});

describe("Repair 9: directed colSnapshots Undo/Redo transition keys", () => {
	test("separates schema undo/redo from unrelated cell-edit undo back to the same altVersion", () => {
		const snaps = new Map<string, string>();
		// Schema delete moves model V1 -> V2
		snaps.set(colSnapshotTransitionKey(2, 1), "pre-delete");
		snaps.set(colSnapshotTransitionKey(1, 2), "post-delete");

		// Cell edit moves V2 -> V3, then Ctrl+Z moves V3 -> V2: must NOT restore post-delete snapshot!
		expect(snaps.get(colSnapshotTransitionKey(2, 3))).toBeUndefined();
		expect(snaps.get(colSnapshotTransitionKey(3, 2))).toBeUndefined();

		// Next Ctrl+Z undoes schema delete (V2 -> V1) -> restores pre-delete
		expect(snaps.get(colSnapshotTransitionKey(2, 1))).toBe("pre-delete");
		// Ctrl+Y redoes schema delete (V1 -> V2) -> restores post-delete
		expect(snaps.get(colSnapshotTransitionKey(1, 2))).toBe("post-delete");
	});
});

describe("Repair 10: single-cell clipboard quoting, visibleFrozenCount, and workspace fileLink guard", () => {
	test("formatSingleCellForClipboard TSV-quotes multiline and tab cells so paste stays in 1 cell", () => {
		const multi = "Line 1\nLine 2";
		const copiedMulti = formatSingleCellForClipboard(multi);
		expect(copiedMulti).toBe('"Line 1\nLine 2"');
		expect(parseClipboardGrid(copiedMulti)).toEqual([["Line 1\nLine 2"]]);

		const withTab = "colA\tcolB";
		const copiedTab = formatSingleCellForClipboard(withTab);
		expect(copiedTab).toBe('"colA\tcolB"');
		expect(parseClipboardGrid(copiedTab)).toEqual([["colA\tcolB"]]);

		const withQuotesAndNewline = 'say "hi"\nnext';
		expect(parseClipboardGrid(formatSingleCellForClipboard(withQuotesAndNewline))).toEqual([['say "hi"\nnext']]);

		// Ordinary single-line cells remain raw text
		expect(formatSingleCellForClipboard("ORD_SAMPLES")).toBe("ORD_SAMPLES");
		expect(formatSingleCellForClipboard('say "hi", ok')).toBe('say "hi", ok');
	});

	test("countVisibleFrozenColumns excludes hidden columns so frozen/hidden overlap never shifts freeze slot", () => {
		expect(countVisibleFrozenColumns(4, [0, 1], new Set())).toBe(2);
		expect(countVisibleFrozenColumns(4, [0, 1], new Set([0]))).toBe(1);
		expect(countVisibleFrozenColumns(4, [0, 1], new Set([0, 1]))).toBe(0);
		expect(countVisibleFrozenColumns(4, [0, 2], new Set([1, 3]))).toBe(2);
		// Out-of-range and duplicate entries are pruned
		expect(countVisibleFrozenColumns(3, [0, 0, 5, -1], new Set([0]))).toBe(0);
		// All-hidden set is pruned to keep at least 1 visible column (last column stays visible)
		expect(countVisibleFrozenColumns(2, [1], new Set([0, 1]))).toBe(1);
	});

	test("resolveWorkspaceFileLink rejects out-of-workspace absolute paths and accepts valid workspace paths", () => {
		const unixRoot = "/workspace/lims-project";
		expect(resolveWorkspaceFileLink(unixRoot, "scripts/order.ssl")).toBe("/workspace/lims-project/scripts/order.ssl");
		expect(resolveWorkspaceFileLink(unixRoot, "./docs/database.csv")).toBe("/workspace/lims-project/docs/database.csv");
		expect(resolveWorkspaceFileLink(unixRoot, "docs/../scripts/order.ssl")).toBe("/workspace/lims-project/scripts/order.ssl");
		expect(resolveWorkspaceFileLink(unixRoot, "/workspace/lims-project/scripts/order.ssl")).toBe(
			"/workspace/lims-project/scripts/order.ssl",
		);
		expect(resolveWorkspaceFileLink(unixRoot, "/workspace/lims-project/a/../scripts/order.ssl")).toBe(
			"/workspace/lims-project/scripts/order.ssl",
		);

		// Out-of-workspace POSIX, Windows drive, UNC, and traversal paths must be rejected
		expect(resolveWorkspaceFileLink(unixRoot, "/etc/passwd")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "/workspace/lims-project-other/a.ssl")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "/workspace/lims-project/../../etc/passwd")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "C:\\Windows\\win.ini")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "C:/Windows/System32/cmd.exe")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "\\\\fileserver\\share\\secret.csv")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "C:relative.ssl")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "../../etc/passwd")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "/workspace/lims-project")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "/workspace/lims-project/")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "https://example.org/file.ssl")).toBeNull();
		expect(resolveWorkspaceFileLink(unixRoot, "SAMPLES")).toBeNull();

		// Windows workspace root accepts in-workspace Windows paths and rejects other drives
		const winRoot = "C:\\work\\lims";
		expect(resolveWorkspaceFileLink(winRoot, "scripts\\test.ssl")).toBe("C:\\work\\lims\\scripts\\test.ssl");
		expect(resolveWorkspaceFileLink(winRoot, "C:\\work\\lims\\scripts\\test.ssl")).toBe("C:\\work\\lims\\scripts\\test.ssl");
		expect(resolveWorkspaceFileLink(winRoot, "C:\\Windows\\win.ini")).toBeNull();
		expect(resolveWorkspaceFileLink(winRoot, "D:\\work\\lims\\scripts\\test.ssl")).toBeNull();
	});
});

describe("Repair 11: CsvFormatDialog fromDraft case-dedup and filter visibility", () => {
	test("fromDraft case-deduplicates values last-write-wins so editing 'In Progress' is never shadowed by 'in progress'", () => {
		const draft: DraftRule[] = [
			{
				id: 1,
				columnsText: "status, state",
				fallback: "waiting",
				search: "",
				entries: [
					{ id: 10, value: "in progress", tone: "active" },
					{ id: 11, value: "verified", tone: "done" },
					{ id: 12, value: "In Progress", tone: "warn" },
				],
			},
		];
		const cfg = fromDraft(true, draft);
		expect(cfg.rules).toHaveLength(1);
		const rule = cfg.rules[0]!;
		expect(Object.keys(rule.values)).toEqual(["verified", "In Progress"]);
		expect(rule.values["In Progress"]).toBe("warn");
		expect("in progress" in rule.values).toBe(false);
		// Runtime badge lookup resolves both spellings to the edited tone!
		expect(badgeToneForValue(rule, "in progress")).toBe("warn");
		expect(badgeToneForValue(rule, "In Progress")).toBe("warn");
	});

	test("fromDraft deduplicates DEFAULT_CSV_TABLE_CONFIG cleanly when later casing is edited", () => {
		const defRule = DEFAULT_CSV_TABLE_CONFIG.rules[0]!;
		const entries = Object.entries(defRule.values).map(([value, tone], idx) => ({
			id: idx + 1,
			value,
			tone: value === "In Progress" ? ("error" as const) : tone,
		}));
		const cfg = fromDraft(true, [
			{ id: 1, columnsText: defRule.columns.join(", "), fallback: defRule.fallback ?? "waiting", entries, search: "" },
		]);
		const savedRule = cfg.rules[0]!;
		const matchingKeys = Object.keys(savedRule.values).filter((k) => k.toLowerCase() === "in progress");
		expect(matchingKeys).toEqual(["In Progress"]);
		expect(badgeToneForValue(savedRule, "in progress")).toBe("error");
		expect(badgeToneForValue(savedRule, "In Progress")).toBe("error");
	});
});

describe("Source invariants across TableView.tsx, CsvFormatDialog.tsx, and tableViewExtra.css", () => {
	const tvSrc = readSrc("../src/view/editor/TableView.tsx");
	const dlgSrc = readSrc("../src/view/editor/CsvFormatDialog.tsx");
	const cssSrc = readSrc("../src/view/editor/tableViewExtra.css");

	test("Repair 1: keyed Show for body/ghost editing and stable <For> virtualization", () => {
		expect(tvSrc).toContain("when={openEdit()}\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tkeyed");
		expect(tvSrc).toContain("when={openGhostEdit()}\n\t\t\t\t\t\t\t\t\t\t\t\t\tkeyed");
		expect(tvSrc).toContain("<For each={drawnEntryIds()}>");
		expect(tvSrc).not.toContain("<Index each={drawnEntries()}>");
	});

	test("Repair 5: virtualization beyond excludes pinnedRow and height measurement tracks editing() & hiddenCols()", () => {
		expect(tvSrc).toContain("const focusRow = ed && !ed.ghost ? ed.row : null;");
		expect(tvSrc).not.toContain("const focusRow = ed && !ed.ghost ? ed.row : pinnedRow();");
		expect(tvSrc).toMatch(/\[drawnEntries\(\),\s*colWidths\(\),\s*hiddenCols\(\),\s*editing\(\),\s*text\(\)\]/);
	});

	test("Repair 6: split-view Escape listener and clearCellSelection stay scoped to rootEl", () => {
		expect(tvSrc).toContain("if (!target || !rootEl?.contains(target)) return;");
		expect(tvSrc).toContain("rootEl?.contains(document.activeElement)");
	});

	test("Repair 7: runCodeCheck distinguishes explicit user cancellation, aborts workers in catch, and clears on workspace switch", () => {
		expect(tvSrc).toContain("let userCancelledRunId = 0;");
		expect(tvSrc).toContain("const isUserCancelled = !disposed && userCancelledRunId === runId;");
		expect(tvSrc).toMatch(/catch \(e: any\) \{\s*cancelled = true;\s*if \(runId === checkRunId\) \{\s*checkRunId\+\+;/);
		expect(tvSrc).toMatch(/\[\s*props\.path,\s*state\.workspace\?\.root[\s\S]*?clearCodeCheck\(\);/);
	});

	test("Repair 10: addColumnInteractive cancel, replaceAll via applyCellUpdates, check-cell targetRow, and headerless TSV copy", () => {
		expect(tvSrc).toContain("if (defVal === null) return;");
		expect(tvSrc).toContain("const changed = applyCellUpdates(updates);");
		expect(tvSrc).toContain("const curIdx = targetRow ?? current();");
		expect(tvSrc).toMatch(/fmt === "tsv"\s*\?\s*hasHeader\(\)\s*\?\s*tableToTsv\(headers, bodyRows\)/);
	});

	test("Repair 11: CsvFormatDialog keeps search visible while non-empty & clears on <= 6; CSS fill-handle z-index sits below frozen cols", () => {
		expect(dlgSrc).toContain("rule.entries.length > 6 || rule.search.length > 0");
		expect(dlgSrc).toContain('search: entries.length <= 6 ? "" : r.search');
		expect(cssSrc).toMatch(/\.table-view tbody tr td\.cell-has-fill-handle:not\(\.col-frozen\)\s*\{\s*position: relative;\s*z-index: 1;\s*\}/);
	});
});
