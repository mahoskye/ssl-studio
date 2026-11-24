// The house style profile's templates and markers (program decisions 0005
// and 0006). Conventions of the team, not facts about SSL: the language
// itself stays with the language server (ADR 0003).

import { localDay } from "./dates";

export const HISTORY_MARKER = /^\s*Modification\.*\s*:/;

/** Modification blocks in the file banner, given the banner's lines. */
export function countHistoryEntries(bannerLines: string[], marker = HISTORY_MARKER): number {
	return bannerLines.filter((line) => marker.test(line)).length;
}

export type SizeReport = { bytes: number; codeLines: number; historyEntries: number };
export type Limits = { bytes: number; codeLines: number; historyEntries: number };
export type Level = "ok" | "near" | "over";

/** Near means within 10% of a limit (for bytes and code lines). A limit of 0 (or non-positive/NaN) means off. */
export function level(value: number, limit: number, nearShare = 0.9): Level {
	if (!(limit > 0)) return "ok";
	return value > limit ? "over" : value >= limit * nearShare ? "near" : "ok";
}

export function bannerTemplate(date = new Date()) {
	const day = localDay(date);
	const stars = "*".repeat(80);
	const rule = "_".repeat(79);
	return [
		`/${stars}`,
		"Description.. : ${1}",
		"Parameters... : ${2:-}",
		"Returns...... : ${3:-}",
		"Author....... : ",
		`Date......... : ${day}`,
		stars,
		rule,
		"Modification. : ",
		"Author....... : ",
		"Date......... : ",
		rule,
		`${stars}/;`,
		"",
	].join("\n");
}

export function procedureTemplate(name = "${1:Name}") {
	return [
		"/*",
		` * Procedure: ${name}`,
		" * Description: ${2}",
		" * Parameters:",
		" *   ${3:sName} - ${4:what it means}",
		" * Returns: ${5:what it returns}",
		";",
		`:PROCEDURE ${name};`,
		"\t:PARAMETERS ${3:sName};",
		"",
		"\t$0",
		"",
		"\t:RETURN;",
		":ENDPROC;",
		"",
	].join("\n");
}

/** A class file: its fields, room for its methods, and the constructor last (the form of examples/due-dates). */
export function classTemplate() {
	return [
		":CLASS ${1:Name};",
		"",
		":DECLARE ${2:sField};",
		"",
		"$0",
		"",
		"/*",
		" * Procedure: Constructor",
		" * Description: ${3:What a new one is set up with}",
		" * Parameters:",
		" *   ${2:sField} - ${4:what it means}",
		" * Returns: nothing",
		";",
		":PROCEDURE Constructor;",
		"\t:PARAMETERS ${2:sField};",
		"",
		"\tMe:${2:sField} := ${2:sField};",
		":ENDPROC;",
		"",
	].join("\n");
}

/** An SSL data source: every parameter with its default on the :PARAMETERS line, and the rows returned. */
export function dataSourceTemplate() {
	const rule = `/* ${"=".repeat(77)};`;
	return [
		rule,
		"/* DATA SOURCE: ${1:Name} (SSL);",
		"/* PURPOSE:     ${2:What it returns};",
		"/* PARAMS:      ${3:sId} - ${4:what it means};",
		"/* RETURNS:     rows {${5:COL}};",
		rule,
		':PARAMETERS ${3:sId} := ${6:""};',
		"",
		':RETURN SQLExecute("',
		"\tSELECT ${5:COL}",
		"\tFROM ${7:TABLE}",
		"\tWHERE ${8:ID} = ?${3:sId}?",
		'");',
		"",
	].join("\n");
}

/** `note` is where a template's form was decided, for a tooltip: the row itself says what the template is. */
export type Template = { id: string; label: string; detail: string; note?: string; group: "File" | "Structure" | "Flow" | "Data"; body: () => string };

/** A template's text with its tab stops taken out and their defaults left in: what a drag drops. */
export const snippetAsText = (body: string) => body.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{?\d+\}?/g, "");

/** Palette templates. Snippet syntax ($1, ${1:default}, $0) as in VS Code. */
export const TEMPLATES: Template[] = [
	{ id: "banner", label: "File banner", detail: "House file banner", note: "Program decision 0005", group: "File", body: () => bannerTemplate() },
	{ id: "class", label: "Class", detail: "A class file: fields and a constructor", group: "File", body: () => classTemplate() },
	{ id: "datasource", label: "Data source", detail: "An SSL data source: parameters and a query", group: "File", body: () => dataSourceTemplate() },
	{ id: "procedure", label: "Procedure", detail: "With its doc block", note: "Program decision 0005", group: "Structure", body: () => procedureTemplate() },
	{ id: "region", label: "Region", detail: "A comment region: a frame in blocks mode", group: "Structure", body: () => "/* region ${1:Name};\n\n$0\n\n/* endregion;\n" },
	{ id: "if", label: ":IF", detail: "Condition", group: "Flow", body: () => ":IF ${1:condition};\n\t$0\n:ENDIF;\n" },
	{ id: "ifelse", label: ":IF … :ELSE", detail: "Condition with an else branch", group: "Flow", body: () => ":IF ${1:condition};\n\t$2\n:ELSE;\n\t$0\n:ENDIF;\n" },
	{ id: "while", label: ":WHILE", detail: "Loop while a condition holds", group: "Flow", body: () => ":WHILE ${1:condition};\n\t$0\n:ENDWHILE;\n" },
	{ id: "for", label: ":FOR", detail: "Counted loop", group: "Flow", body: () => ":FOR ${1:i} := ${2:1} :TO ${3:nCount};\n\t$0\n:NEXT;\n" },
	{ id: "case", label: ":BEGINCASE", detail: "Cases, each ending in :EXITCASE", group: "Flow", body: () => ":BEGINCASE;\n:CASE ${1:condition};\n\t$2\n\t:EXITCASE;\n:OTHERWISE;\n\t$0\n\t:EXITCASE;\n:ENDCASE;\n" },
	{ id: "try", label: ":TRY", detail: "Error handling", group: "Flow", body: () => ":TRY;\n\t$1\n:CATCH;\n\t$0\n:ENDTRY;\n" },
	{ id: "lsearch", label: "LSearch", detail: "One value from SQL", group: "Data", body: () => '${1:vValue} := LSearch("${2:SELECT COL FROM TABLE WHERE ID = ?}", ${3:""}, "${4:DATABASE}", {${5:sId}});\n' },
	{ id: "sqlexecute", label: "SQLExecute", detail: "Rows from SQL", group: "Data", body: () => '${1:aRows} := SQLExecute("${2:SELECT COL FROM TABLE}", "${3:DATABASE}");\n' },
	{ id: "runsql", label: "RunSQL", detail: "Run a statement", group: "Data", body: () => 'RunSQL("${1:UPDATE TABLE SET COL = ? WHERE ID = ?}", "${2:DATABASE}", {${3:vValue}, ${4:sId}});\n' },
	{ id: "getdataset", label: "GetDataSet", detail: "A dataset from SQL", group: "Data", body: () => '${1:sDataSet} := GetDataSet("${2:SELECT COL FROM TABLE WHERE ID = ?}", {${3:sId}});\n' },
	{ id: "doproc", label: "DoProc", detail: "Call a procedure", group: "Data", body: () => '${1:vResult} := DoProc("${2:Procedure}", {${3}});\n' },
	{ id: "execfunction", label: "ExecFunction", detail: "Call another script's procedure", group: "Data", body: () => '${1:vResult} := ExecFunction("${2:Category.Script.Procedure}", {${3}});\n' },
];

/** How many columns to each side of the line length the fainter rulers stand, unless a setting says otherwise. */
export const RULER_MARGIN = 10;

/**
 * The columns the editor rules: the style's line length, and a fainter ruler
 * `margin` columns before it and after it. A margin of 0 gives the one ruler;
 * a ruler that would fall at or before the first column is left out.
 */
export function rulerColumns(on: boolean, lineLength: number, margin: number): { column: number; main: boolean }[] {
	if (!on || !(lineLength > 0)) return [];
	const side = Math.max(0, Math.round(margin) || 0);
	const columns = side ? [lineLength - side, lineLength, lineLength + side] : [lineLength];
	return columns.filter((column) => column > 1).map((column) => ({ column, main: column === lineLength }));
}
