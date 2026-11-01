// Style profile presets: values for the language server's `ssl` settings.
// The server owns what each option means (ADR 0003); these only choose.

/** The team's layout and limits (program decisions 0002, 0005, 0006). */
export const HOUSE_STYLE = {
	format: {
		indentStyle: "tab",
		blankLineBetweenBlocks: true,
		blankLinesBetweenProcs: 1,
		maxConsecutiveBlankLines: 1,
		trimTrailingWhitespace: true,
		builtinFunctionCase: "PascalCase",
		sql: { enabled: true, style: "canonicalCompact", keywordCase: "upper" },
	},
	diagnostics: {
		hungarianNotation: true,
		infoDiagnostics: true,
		maxScriptCodeLines: 400,
		maxScriptProcedures: 12,
		// The Designer banner (decision 0005) closes with `*/;` by design.
		rules: { c_style_comment_closer: "off" },
	},
	inlayHints: { enabled: true },
};

/**
 * The server's documented defaults (starlims-lsp 0.28.2,
 * docs/configuration/CONFIGURATION.md section 10.4), shown for unset fields.
 */
export const SERVER_DEFAULTS = {
	format: {
		indentStyle: "tab",
		indentSize: 4,
		maxLineLength: 90,
		operatorSpacing: true,
		commaSpacing: true,
		semicolonEnforcement: true,
		blankLinesBetweenProcs: 1,
		blankLineBetweenBlocks: true,
		blankLinesBetweenSections: true,
		trimTrailingWhitespace: true,
		maxConsecutiveBlankLines: 2,
		builtinFunctionCase: "PascalCase",
		sql: { enabled: true, style: "canonicalCompact", keywordCase: "upper", identifierCase: "preserve" },
	},
	diagnostics: {
		hungarianNotation: false,
		hungarianTypes: false,
		unusedVariables: false,
		infoDiagnostics: false,
		maxBlockDepth: 4,
		maxProcedureCodeLines: 80,
		maxScriptCodeLines: 400,
		maxScriptProcedures: 12,
	},
	inlayHints: { enabled: true, minParameterCount: 2 },
};

export type Field =
	| { path: string; label: string; kind: "boolean" }
	| { path: string; label: string; kind: "number"; min?: number; max?: number }
	| { path: string; label: string; kind: "choice"; options: string[] };

export const SECTIONS: { title: string; fields: Field[] }[] = [
	{
		title: "Layout",
		fields: [
			{ path: "format.indentStyle", label: "Indent with", kind: "choice", options: ["tab", "space"] },
			{ path: "format.indentSize", label: "Indent size (spaces)", kind: "number", min: 1, max: 8 },
			{ path: "format.maxLineLength", label: "Line length", kind: "number", min: 40, max: 240 },
			{ path: "format.operatorSpacing", label: "Spaces around operators", kind: "boolean" },
			{ path: "format.commaSpacing", label: "Space after commas", kind: "boolean" },
			{ path: "format.semicolonEnforcement", label: "Add missing semicolons", kind: "boolean" },
			{ path: "format.blankLinesBetweenProcs", label: "Blank lines between procedures", kind: "number", min: 0, max: 4 },
			{ path: "format.blankLineBetweenBlocks", label: "Blank line around blocks", kind: "boolean" },
			{ path: "format.blankLinesBetweenSections", label: "Blank line between sections", kind: "boolean" },
			{ path: "format.maxConsecutiveBlankLines", label: "Most blank lines in a row", kind: "number", min: 0, max: 5 },
			{ path: "format.trimTrailingWhitespace", label: "Trim trailing spaces", kind: "boolean" },
			{ path: "format.builtinFunctionCase", label: "Built-in function case", kind: "choice", options: ["PascalCase", "preserve"] },
		],
	},
	{
		title: "SQL",
		fields: [
			{ path: "format.sql.enabled", label: "Format SQL strings", kind: "boolean" },
			{ path: "format.sql.style", label: "SQL style", kind: "choice", options: ["canonicalCompact", "standard", "expanded"] },
			{ path: "format.sql.keywordCase", label: "SQL keyword case", kind: "choice", options: ["upper", "lower", "preserve"] },
			{ path: "format.sql.identifierCase", label: "SQL identifier case", kind: "choice", options: ["preserve", "lower", "upper"] },
		],
	},
	{
		title: "Checks",
		fields: [
			{ path: "diagnostics.hungarianNotation", label: "Hungarian notation", kind: "boolean" },
			{ path: "diagnostics.hungarianTypes", label: "Hungarian prefixes match types", kind: "boolean" },
			{ path: "diagnostics.unusedVariables", label: "Unused variables", kind: "boolean" },
			{ path: "diagnostics.infoDiagnostics", label: "Info-level findings", kind: "boolean" },
			{ path: "diagnostics.maxBlockDepth", label: "Deepest nesting", kind: "number", min: 1, max: 12 },
			{ path: "diagnostics.maxProcedureCodeLines", label: "Procedure code lines", kind: "number", min: 10, max: 2000 },
			{ path: "diagnostics.maxScriptCodeLines", label: "Script code lines", kind: "number", min: 50, max: 10000 },
			{ path: "diagnostics.maxScriptProcedures", label: "Procedures per script", kind: "number", min: 1, max: 200 },
		],
	},
	{
		title: "Hints",
		fields: [
			{ path: "inlayHints.enabled", label: "Parameter name hints", kind: "boolean" },
			{ path: "inlayHints.minParameterCount", label: "Hints from this many parameters", kind: "number", min: 1, max: 10 },
		],
	},
];

export const RULE_LEVELS = ["default", "off", "hint", "info", "warning", "error"] as const;

export function getPath(object: any, path: string): any {
	return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), object);
}

export function setPath(object: any, path: string, value: any): any {
	const keys = path.split(".");
	const copy = structuredClone(object ?? {});
	let o = copy;
	for (const k of keys.slice(0, -1)) o = o[k] = typeof o[k] === "object" && o[k] ? o[k] : {};
	if (value === undefined) delete o[keys.at(-1)!];
	else o[keys.at(-1)!] = value;
	return copy;
}
