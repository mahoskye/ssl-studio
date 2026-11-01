// The house style profile's templates and markers (program decisions 0005
// and 0006). Conventions of the team, not facts about SSL: the language
// itself stays with the language server (ADR 0003).

export const HISTORY_MARKER = /^\s*Modification\.*\s*:/;

/** Modification blocks in the file banner, given the banner's lines. */
export function countHistoryEntries(bannerLines: string[], marker = HISTORY_MARKER): number {
	return bannerLines.filter((line) => marker.test(line)).length;
}

export type SizeReport = { bytes: number; codeLines: number; historyEntries: number };
export type Limits = { bytes: number; codeLines: number; historyEntries: number };
export type Level = "ok" | "near" | "over";

/** Near means within 10% of a limit (for bytes and code lines). */
export function level(value: number, limit: number, nearShare = 0.9): Level {
	return value > limit ? "over" : value >= limit * nearShare ? "near" : "ok";
}

export function bannerTemplate(date = new Date()) {
	const day = date.toISOString().slice(0, 10);
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

export type Template = { id: string; label: string; detail: string; group: "File" | "Structure" | "Flow" | "Data"; body: () => string };

/** Palette templates. Snippet syntax ($1, ${1:default}, $0) as in VS Code. */
export const TEMPLATES: Template[] = [
	{ id: "banner", label: "File banner", detail: "Designer header (decision 0005)", group: "File", body: () => bannerTemplate() },
	{ id: "procedure", label: "Procedure", detail: "With its doc block (decision 0005)", group: "Structure", body: () => procedureTemplate() },
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
