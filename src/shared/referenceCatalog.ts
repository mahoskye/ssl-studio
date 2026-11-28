// Pure catalog taxonomy, GitHub Pages URL mapping, and search/grouping helpers
// for the SSL Reference panel. Maps live starlims-lsp entries (ADR 0003) onto
// the public STARLIMS SSL Reference structure (CC BY 4.0):
// https://mahoskye.github.io/starlims-ssl-reference/

export const REFERENCE_SITE_URL = "https://mahoskye.github.io/starlims-ssl-reference/";

export type ReferenceSectionId =
	| "functions"
	| "classes"
	| "returns"
	| "keywords"
	| "operators"
	| "types"
	| "literals"
	| "special-forms"
	| "globals";

export type ReferenceSectionMeta = {
	id: ReferenceSectionId;
	label: string;
	shortLabel: string;
	description: string;
	path: string;
};

export const REFERENCE_SECTIONS: readonly ReferenceSectionMeta[] = [
	{
		id: "functions",
		label: "Functions",
		shortLabel: "Functions",
		description: "Built-in SSL functions organized by domain.",
		path: "reference/functions/",
	},
	{
		id: "classes",
		label: "Classes",
		shortLabel: "Classes",
		description: "Constructable SSL object types instantiated with ClassName{}.",
		path: "reference/classes/",
	},
	{
		id: "returns",
		label: "Obtained Objects",
		shortLabel: "Obtained",
		description: "Runtime objects returned by built-in calls or endpoint ambients.",
		path: "reference/returns/",
	},
	{
		id: "keywords",
		label: "Keywords",
		shortLabel: "Keywords",
		description: "Colon-prefixed SSL language statements and block delimiters.",
		path: "reference/keywords/",
	},
	{
		id: "operators",
		label: "Operators",
		shortLabel: "Operators",
		description: "SSL operators ordered by precedence (highest to lowest).",
		path: "reference/operators/",
	},
	{
		id: "types",
		label: "Types",
		shortLabel: "Types",
		description: "Core SSL value types, coercion rules, and native members.",
		path: "reference/types/",
	},
	{
		id: "literals",
		label: "Literals",
		shortLabel: "Literals",
		description: "Built-in boolean and null literal values (.T., .F., NIL).",
		path: "reference/literals/",
	},
	{
		id: "special-forms",
		label: "Special Forms",
		shortLabel: "Special Forms",
		description: "Class infrastructure, endpoint ambients, and script-level constructs.",
		path: "reference/special-forms/",
	},
	{
		id: "globals",
		label: "Predefined Globals",
		shortLabel: "Globals",
		description: "Platform objects and base SystemInit :PUBLIC variables (verified on STARLIMS v12).",
		path: "guides/predefined-globals/",
	},
];

export const REFERENCE_SECTION_MAP: Record<ReferenceSectionId, ReferenceSectionMeta> = Object.fromEntries(
	REFERENCE_SECTIONS.map((s) => [s.id, s]),
) as Record<ReferenceSectionId, ReferenceSectionMeta>;

export type ReferenceGuide = {
	id: string;
	title: string;
	summary: string;
	path: string;
	url: string;
	keywords: readonly string[];
};

export function referenceUrl(relPath: string): string {
	return `${REFERENCE_SITE_URL}${relPath.replace(/^\/+/, "")}`;
}

export const REFERENCE_GUIDES: readonly ReferenceGuide[] = [
	{
		id: "getting-started",
		title: "Getting Started",
		summary: "Where SSL code runs, dictionary scripts, syntax basics, and .NET runtime foundations.",
		path: "getting-started/",
		url: referenceUrl("getting-started/"),
		keywords: ["intro", "basics", "overview", "dictionary", "designer", "syntax"],
	},
	{
		id: "type-system",
		title: "Type System",
		summary: "Core SSL value types, NIL, Empty(), LimsType/LimsTypeEx, and coercion behavior.",
		path: "guides/type-system/",
		url: referenceUrl("guides/type-system/"),
		keywords: ["types", "coercion", "empty", "nil", "array", "date", "number", "string", "boolean", "object"],
	},
	{
		id: "variable-scope",
		title: "Variable Scope",
		summary: "Dynamic outward call-stack lookup, :DECLARE, :PUBLIC, and avoiding accidental shadowing.",
		path: "guides/variable-scope/",
		url: referenceUrl("guides/variable-scope/"),
		keywords: ["scope", "declare", "public", "local", "session", "variables", "shadowing"],
	},
	{
		id: "predefined-globals",
		title: "Predefined Globals",
		summary: "Platform objects, base SystemInit :PUBLIC globals, installation status names, and names that are NOT predefined.",
		path: "guides/predefined-globals/",
		url: referenceUrl("guides/predefined-globals/"),
		keywords: [
			"globals", "myusername", "crlf", "dq", "session", "publicconsts", "status",
			"done", "logged", "released", "draft", "oktostart", "systeminit", "batch",
			"cr", "lf", "tab", "stab", "sdq", "ssq", "myuserid", "mylangid", "mydept", "mysite",
		],
	},
	{
		id: "error-handling",
		title: "Error Handling",
		summary: "Structured :TRY / :CATCH / :FINALLY patterns, GetLastSSLError, and legacy :ERROR / :RESUME.",
		path: "guides/error-handling/",
		url: referenceUrl("guides/error-handling/"),
		keywords: ["try", "catch", "finally", "error", "resume", "raiseerror", "exception", "sslerror"],
	},
	{
		id: "sql-queries",
		title: "Working with SQL",
		summary: "Choosing between RunSQL, LSearch, LSelect, LSelect1, SQLExecute, GetDataSet, and RunDS.",
		path: "guides/sql-queries/",
		url: referenceUrl("guides/sql-queries/"),
		keywords: ["sql", "database", "query", "select", "sqlexecute", "runsql", "lselect", "lsearch", "dataset"],
	},
	{
		id: "sql-transactions",
		title: "SQL & Transactions",
		summary: "BeginLimsTransaction, EndLimsTransaction, nested transaction counts, and safe :FINALLY rollback.",
		path: "guides/sql-transactions/",
		url: referenceUrl("guides/sql-transactions/"),
		keywords: ["transaction", "rollback", "commit", "beginlimstransaction", "endlimstransaction", "database"],
	},
	{
		id: "naming-conventions",
		title: "Naming Conventions",
		summary: "Hungarian type prefixes, camelCase variables, procedure/class naming, and house style habits.",
		path: "guides/naming-conventions/",
		url: referenceUrl("guides/naming-conventions/"),
		keywords: ["naming", "hungarian", "prefix", "style", "conventions", "camelcase"],
	},
	{
		id: "data-sources",
		title: "Data Source Files",
		summary: "STARLIMS-mode vs SQL-mode data sources, :PARAMETERS headers, and RunDS execution.",
		path: "guides/data-sources/",
		url: referenceUrl("guides/data-sources/"),
		keywords: ["datasource", "data source", "runds", "getdsparameters", "sql mode", "parameters"],
	},
	{
		id: "native-members",
		title: "Native Members",
		summary: "Calling underlying .NET methods and properties via colon syntax on SSL values (0-based indexing).",
		path: "guides/native-members/",
		url: referenceUrl("guides/native-members/"),
		keywords: ["dotnet", ".net", "native", "members", "netobject", "colon", "tostring", "length"],
	},
];

export const REFERENCE_GUIDE_MAP: Record<string, ReferenceGuide> = Object.fromEntries(
	REFERENCE_GUIDES.map((g) => [g.id, g]),
);

// --- Published taxonomy tables (1:1 with mahoskye/starlims-ssl-reference mkdocs.yml) ---

type FunctionGroupSpec = {
	category: string;
	subcategory?: string;
	names: readonly string[];
};

const FUNCTION_GROUPS: readonly FunctionGroupSpec[] = [
	{
		category: "Array",
		names: [
			"AAdd", "AEval", "AEvalA", "AFill", "ALen", "ArrayCalc", "ArrayNew", "AScan",
			"AScanExact", "BuildArray", "BuildArray2", "CompArray", "DelArray", "ExtractCol", "SortArray",
		],
	},
	{
		category: "Database",
		subcategory: "SQL Queries",
		names: [
			"GetDataSet", "GetDataSetEx", "GetNETDataSet", "GetSSLDataset", "LSearch",
			"LSelect", "LSelect1", "LSelectC", "RunDS", "RunSQL", "SQLExecute",
		],
	},
	{
		category: "Database",
		subcategory: "Transactions",
		names: ["BeginLimsTransaction", "EndLimsTransaction", "GetTransactionsCount", "IsInTransaction"],
	},
	{
		category: "Database",
		subcategory: "Connections",
		names: [
			"GetConnectionByName", "GetConnectionStrings", "GetDBMSName", "GetDBMSProviderName",
			"GetDefaultConnection", "IsDBConnected", "LimsSqlConnect", "LimsSqlDisconnect",
			"SetDefaultConnection", "SetSqlTimeout",
		],
	},
	{
		category: "Database",
		subcategory: "Schema",
		names: ["GetDSParameters", "GetTables", "IsTable", "IsTableFld", "TableFldLst"],
	},
	{
		category: "Database",
		subcategory: "SQL Utilities",
		names: [
			"AddColDelimiters", "AddNameDelimiters", "ArrayToTVP", "BuildStringForIn",
			"CreateORMSession", "DetectSqlInjections", "GetLastSQLError", "GetNoLock",
			"GetRdbmsDelimiter", "IgnoreSqlErrors", "LimsRecordsAffected", "LimsSetCounter",
			"PrepareArrayForIn", "RetrieveLong", "ReturnLastSQLError", "ShowSqlErrors",
			"SQLRemoveComments", "UpdLong", "XmlExportSql",
		],
	},
	{
		category: "Database",
		subcategory: "Dataset Builders",
		names: [
			"GetDataSetFromArray", "GetDataSetFromArrayEx", "GetDataSetWithSchemaFromSelect",
			"GetDataSetXMLFromArray", "GetDataSetXMLFromSelect",
		],
	},
	{
		category: "Date & Time",
		names: [
			"ClientEndOfDay", "ClientStartOfDay", "CMonth", "CToD", "DateAdd", "DateDiff",
			"DateDiffEx", "DateFormat", "DateFromNumbers", "DateFromString", "DateToString",
			"Day", "DOW", "DOY", "DToC", "DToS", "Hour", "IsInvariantDate", "JDay",
			"LIMSDate", "LimsGetDateFormat", "LimsTime", "MakeDateInvariant", "MakeDateLocal",
			"Minute", "Month", "NoOfDays", "Now", "Second", "Seconds", "ServerEndOfDay",
			"ServerStartOfDay", "ServerTimeZone", "StringToDate", "Time", "Today",
			"UserTimeZone", "ValidateDate", "Year",
		],
	},
	{
		category: "Documentum",
		subcategory: "Auth",
		names: ["DocEndDocumentumInterface", "DocInitDocumentumInterface", "DocLoginToDocumentum"],
	},
	{
		category: "Documentum",
		subcategory: "Documents",
		names: [
			"DocCancelCheckout", "DocCheckinDocument", "DocCheckoutDocument", "DocDelete",
			"DocExists", "DocExportDocument", "DocGetDocuments", "DocGetMetadata",
			"DocGetTypeAttributes", "DocGetTypeAttributesAsDataset", "DocImportDocument", "DocSetMetadata",
		],
	},
	{
		category: "Documentum",
		subcategory: "Folders & Cabinets",
		names: ["DocCreateCabinet", "DocCreateFolder", "DocDeleteCabinet", "DocDeleteFolder", "DocGetCabinets", "DocGetFolders"],
	},
	{
		category: "Documentum",
		subcategory: "Users & Groups",
		names: [
			"DocAddUsersToGroup", "DocCreateACL", "DocCreateGroup", "DocCreateUser",
			"DocDeleteUser", "DocExistsUser", "DocRemoveAllUsersFromGroup",
			"DocRemoveUsersFromGroup", "DocUpdateUser",
		],
	},
	{
		category: "Documentum",
		subcategory: "Workflows",
		names: [
			"DocAcquireWorkitem", "DocCompleteWorkitem", "DocDelegateWorkitem", "DocGetTasks",
			"DocGetTasksCount", "DocGetWorkflowStatus", "DocGetWorkitemProperties", "DocPauseWorkflow",
			"DocRepeatWorkitem", "DocResumeWorkflow", "DocStartWorkflow", "DocStopWorkflow",
		],
	},
	{
		category: "Documentum",
		subcategory: "Search",
		names: ["DocSearchAsDataset", "DocSearchFullText", "DocSearchUsingDql"],
	},
	{
		category: "Documentum",
		subcategory: "Documentum Errors",
		names: ["DocCommandFailed", "DocGetErrorMessage"],
	},
	{
		category: "Email",
		names: ["SendFromOutbox", "SendLimsEmail", "SendOutlookReminder", "SendToOutbox"],
	},
	{
		category: "Execution & Dynamic Dispatch",
		names: ["Branch", "DoProc", "ExecFunction", "ExecInternal", "ExecUdf", "IIf", "LCase", "LimsExec", "PrmCount", "RunApp"],
	},
	{
		category: "FTP",
		names: [
			"CheckOnFtp", "CopyToFtp", "DeleteDirOnFtp", "DeleteFromFtp", "GetDirFromFtp",
			"GetFromFtp", "MakeDirOnFtp", "MoveInFtp", "ReadFromFtp", "RenameOnFtp",
			"SendToFtp", "WriteToFtp",
		],
	},
	{
		category: "File System",
		names: [
			"CombineFiles", "Compress", "ConvertReport", "CreateZip", "Decompress", "Directory",
			"DosSupport", "ExtractZip", "FileSupport", "GetAppBaseFolder", "GetAppWorkPathFolder",
			"GetFileVersion", "GetLogsFolder", "GetWebFolder", "LDir", "ReadBytesBase64",
			"ReadText", "WriteBytesBase64", "WriteText",
		],
	},
	{
		category: "Inline Code",
		names: ["DeleteInlineCode", "Eval", "GetInlineCode", "GetRegion", "GetRegionEx"],
	},
	{
		category: "Messaging & Errors",
		names: [
			"ClearLastSSLError", "ErrorMes", "FormatErrorMessage", "FormatSqlErrorMessage",
			"GetLastSSLError", "InfoMes", "RaiseError", "UsrMes",
		],
	},
	{
		category: "Numeric & Math",
		names: [
			"_AND", "_NOT", "_OR", "_XOR", "Abs", "GetDecimalSep", "GetDecimalSeparator",
			"GetGroupSeparator", "IsNumeric", "LimsXOr", "MatFunc", "Max", "Min", "Rand",
			"Round", "RoundPoint5", "Scient", "SetDecimalSeparator", "SetGroupSeparator",
			"SigFig", "Sqrt", "StdRound", "ToScientific", "ValidateNumeric",
		],
	},
	{
		category: "Object & Interop",
		names: [
			"AddProperty", "CreateUdObject", "EndLimsOleConnect", "GetInternal", "GetInternalC",
			"HasProperty", "LimsNETConnect", "LimsOleConnect", "MakeNETObject", "SetInternal",
			"SetInternalC", "XmlDomToUdObject",
		],
	},
	{
		category: "Security",
		names: [
			"ChkNewPassword", "ChkPassword", "DecryptData", "EncryptData", "GetUserData",
			"HashData", "LDAPAuth", "LDAPAuthEX", "SearchLDAPUser", "SetUserData",
			"SetUserPassword", "VerifySignature",
		],
	},
	{
		category: "String",
		names: [
			"AllTrim", "Asc", "At", "BuildString", "BuildString2", "Chr", "CreateGUID",
			"HtmlDecode", "HtmlEncode", "IsGuid", "IsHex", "Left", "Len", "LimsAt",
			"LimsString", "LLower", "Lower", "LStr", "LToHex", "LTrim", "MimeDecode",
			"MimeEncode", "Rat", "Replace", "Replicate", "Right", "Str", "StrSrch",
			"StrTran", "StrZero", "SubStr", "Trim", "Upper", "UrlDecode", "UrlEncode",
		],
	},
	{
		category: "System & Batch",
		names: ["GetPrinters", "InBatchProcess", "IsProductionModeOn", "LWait", "SubmitToBatch", "SubmitToBatchEx"],
	},
	{
		category: "Type Conversion",
		names: [
			"Empty", "FromJson", "FromXml", "Integer", "LFromHex", "LHex2Dec", "LimsNETCast",
			"LimsNETTypeOf", "LimsType", "LimsTypeEx", "LTransform", "Nothing", "ToJson",
			"ToNumeric", "ToXml", "Val",
		],
	},
	{
		category: "Variable & Session Management",
		names: [
			"AddToSession", "ClearSession", "CreateLocal", "CreatePublic", "GetByName",
			"GetFromApplication", "GetFromSession", "GetSetting", "GetSettings", "IsDefined",
			"LKill", "SetByName",
		],
	},
];

const CLASS_GROUPS: readonly { category: string; names: readonly string[] }[] = [
	{
		category: "Tabular data & datasets",
		names: ["CDataTable", "CDataRow", "CDataColumns", "CDataColumn", "CDataField", "SSLDataset", "TablesImport"],
	},
	{
		category: "Dictionaries & dynamic objects",
		names: ["SSLBaseDictionary", "SSLStringDictionary", "SSLIntDictionary", "SSLExpando"],
	},
	{
		category: "Documents & storage",
		names: ["PdfSupport", "SDMS", "SDMSDocUploader", "AzureStorage", "EnterpriseExporter"],
	},
	{
		category: "Communication",
		names: ["Email", "FtpsClient", "WebServices"],
	},
	{
		category: "Errors & diagnostics",
		names: ["SSLError", "SSLSQLError"],
	},
	{
		category: "Text & identifiers",
		names: ["SSLRegex", "Sequence"],
	},
	{
		category: "System & platform",
		names: ["BatchSupport", "PatcherSupport", "RegSetup", "SQLConnection", "SSLCodeProvider", "HtmlConverter"],
	},
];

const OBTAINED_OBJECT_GROUPS: readonly { category: string; items: readonly { name: string; obtainedFrom: string }[] }[] = [
	{
		category: "HTTP",
		items: [
			{ name: "HttpClient", obtainedFrom: "WebServices{}:CreateHttpClient()" },
			{ name: "HttpRequest", obtainedFrom: "HttpClient:CreateHttpRequest(url)" },
			{ name: "HttpResponse", obtainedFrom: "HttpClient:GetResponse(...)" },
			{ name: "HttpException", obtainedFrom: "HttpClient:GetLastServerException()" },
		],
	},
	{
		category: "SOAP",
		items: [
			{ name: "SoapClient", obtainedFrom: "WebServices{}:CreateSoapClient()" },
			{ name: "SoapResponse", obtainedFrom: "SoapClient:CallWebService(method)" },
			{ name: "SoapParameters", obtainedFrom: "SoapClient:Parameters" },
		],
	},
	{
		category: "Endpoint runtime",
		items: [
			{ name: "SSLRequest", obtainedFrom: "Request ambient in endpoint scripts" },
			{ name: "SSLResponse", obtainedFrom: "Response ambient in endpoint scripts" },
			{ name: "SSLWsRequest", obtainedFrom: "Request ambient in web-service scripts" },
			{ name: "SSLWsResponse", obtainedFrom: "Response ambient in web-service scripts" },
			{ name: "SSLNameValueContainer", obtainedFrom: "Request:QueryString / Headers / Cookies / Forms" },
		],
	},
];

const KEYWORD_GROUPS: readonly { category: string; names: readonly string[] }[] = [
	{ category: "Declarations", names: [":DECLARE", ":DEFAULT", ":INCLUDE", ":INHERIT", ":PARAMETERS", ":PUBLIC"] },
	{ category: "Control Flow", names: [":BEGINCASE", ":CASE", ":ELSE", ":ENDCASE", ":ENDIF", ":EXITCASE", ":IF", ":OTHERWISE"] },
	{ category: "Loops", names: [":ENDWHILE", ":EXITFOR", ":EXITWHILE", ":FOR", ":LOOP", ":NEXT", ":STEP", ":TO", ":WHILE"] },
	{ category: "Procedures & Classes", names: [":CLASS", ":ENDPROC", ":PROCEDURE", ":RETURN"] },
	{ category: "Error Handling", names: [":CATCH", ":ENDTRY", ":ERROR", ":FINALLY", ":RESUME", ":TRY"] },
	{ category: "Organization", names: [":BEGININLINECODE", ":ENDINLINECODE", ":ENDREGION", ":LABEL", ":REGION"] },
];

type OperatorSpec = {
	symbol: string;
	slug: string;
	title: string;
	category: string;
};

const OPERATOR_SPECS: readonly OperatorSpec[] = [
	{ symbol: "!", slug: "bang", title: "Logical NOT (!)", category: "Unary" },
	{ symbol: "++", slug: "increment", title: "Increment", category: "Unary" },
	{ symbol: "--", slug: "decrement", title: "Decrement", category: "Unary" },
	{ symbol: ".NOT.", slug: "not", title: "Logical NOT", category: "Unary" },
	{ symbol: "^", slug: "power", title: "Exponentiation (^)", category: "Power & Arithmetic" },
	{ symbol: "**", slug: "double-star-power", title: "Exponentiation (**)", category: "Power & Arithmetic" },
	{ symbol: "*", slug: "multiply", title: "Multiply", category: "Power & Arithmetic" },
	{ symbol: "/", slug: "divide", title: "Divide", category: "Power & Arithmetic" },
	{ symbol: "%", slug: "modulo", title: "Modulo", category: "Power & Arithmetic" },
	{ symbol: "-", slug: "minus", title: "Subtract / Negate", category: "Power & Arithmetic" },
	{ symbol: "+", slug: "plus", title: "Add / Concatenate", category: "Power & Arithmetic" },
	{ symbol: "<<", slug: "shift-left", title: "Bitwise Shift Left", category: "Shift" },
	{ symbol: ">>", slug: "shift-right", title: "Bitwise Shift Right", category: "Shift" },
	{ symbol: "<", slug: "less-than", title: "Less Than", category: "Relational & Equality" },
	{ symbol: ">", slug: "greater-than", title: "Greater Than", category: "Relational & Equality" },
	{ symbol: "<=", slug: "less-than-or-equal", title: "Less Than or Equal", category: "Relational & Equality" },
	{ symbol: ">=", slug: "greater-than-or-equal", title: "Greater Than or Equal", category: "Relational & Equality" },
	{ symbol: "=", slug: "equals", title: "Equals (prefix match on strings)", category: "Relational & Equality" },
	{ symbol: "==", slug: "strict-equals", title: "Strict Equals (exact match)", category: "Relational & Equality" },
	{ symbol: "!=", slug: "not-equals", title: "Not Equals", category: "Relational & Equality" },
	{ symbol: "<>", slug: "not-equals-legacy", title: "Not Equals (legacy)", category: "Relational & Equality" },
	{ symbol: "#", slug: "hash", title: "Not Equals (#)", category: "Relational & Equality" },
	{ symbol: "$", slug: "dollar", title: "Substring Contained In ($)", category: "Relational & Equality" },
	{ symbol: ".AND.", slug: "and", title: "Logical AND", category: "Logical" },
	{ symbol: ".OR.", slug: "or", title: "Logical OR", category: "Logical" },
	{ symbol: ":=", slug: "assignment", title: "Assignment", category: "Assignment" },
	{ symbol: "+=", slug: "add-assign", title: "Add Assign", category: "Assignment" },
	{ symbol: "-=", slug: "subtract-assign", title: "Subtract Assign", category: "Assignment" },
	{ symbol: "*=", slug: "multiply-assign", title: "Multiply Assign", category: "Assignment" },
	{ symbol: "/=", slug: "divide-assign", title: "Divide Assign", category: "Assignment" },
	{ symbol: "%=", slug: "modulo-assign", title: "Modulo Assign", category: "Assignment" },
	{ symbol: "^=", slug: "power-assign", title: "Power Assign", category: "Assignment" },
];

const TYPE_SPECS: readonly { slug: string; label: string }[] = [
	{ slug: "array", label: "array" },
	{ slug: "boolean", label: "boolean" },
	{ slug: "codeblock", label: "codeblock" },
	{ slug: "date", label: "date" },
	{ slug: "netobject", label: "netobject" },
	{ slug: "number", label: "number" },
	{ slug: "object", label: "object" },
	{ slug: "string", label: "string" },
];

const LITERAL_SPECS: readonly { label: string; slug: string; hoverText: string }[] = [
	{ label: ".T.", slug: "true", hoverText: ".T." },
	{ label: ".F.", slug: "false", hoverText: ".F." },
	{ label: "NIL", slug: "nil", hoverText: "NIL" },
];

type SpecialFormSpec = {
	label: string;
	slug: string;
	category: string;
	insertText?: string;
	hoverText?: string;
	endpointContext?: boolean;
};

const SPECIAL_FORM_SPECS: readonly SpecialFormSpec[] = [
	{ label: "Me:", slug: "me", category: "Class infrastructure", insertText: "Me:", hoverText: "Me" },
	{ label: "Base:", slug: "base", category: "Class infrastructure", insertText: "Base:", hoverText: "Base" },
	{ label: "Constructor", slug: "constructor", category: "Class infrastructure", insertText: ":PROCEDURE Constructor;", hoverText: "Constructor" },
	{ label: "Request", slug: "request", category: "Endpoint ambients", insertText: "Request", hoverText: "Request", endpointContext: true },
	{ label: "Response", slug: "response", category: "Endpoint ambients", insertText: "Response", hoverText: "Response", endpointContext: true },
	{ label: "Access Modifiers", slug: "access-modifiers", category: "Other", insertText: "/*@private;" },
	{ label: "Code Block", slug: "code-block", category: "Other", insertText: "{|x| x}" },
	{ label: "Code Organization", slug: "code-organization", category: "Other", insertText: "/* region" },
];

type PredefinedGlobalSpec = {
	name: string;
	category: "Provided by the platform" | "User & session" | "Character constants" | "Environment & batch";
	secondary: string;
	detail: string;
	doc: string;
	path: string;
	endpointContext?: boolean;
};

/**
 * Predefined globals whose existence, type, and runtime value/behavior are
 * fully verified on STARLIMS v12 (2 platform objects + 9 base SystemInit :PUBLICs).
 * Installation-specific status names and globals whose backing-API or value
 * contracts still need runtime qualification are withheld until verified.
 */
const PREDEFINED_GLOBAL_SPECS: readonly PredefinedGlobalSpec[] = [
	{
		name: "Request",
		category: "Provided by the platform",
		secondary: "HTTP request (endpoint)",
		detail: 'Platform object (LimsType "UI")',
		doc: "Provided by the platform in every server script (`LimsType` reports `UI`). Holds the incoming HTTP request; meaningful inside endpoint scripts (readable in Designer without raising).",
		path: "reference/special-forms/request/",
		endpointContext: true,
	},
	{
		name: "Response",
		category: "Provided by the platform",
		secondary: "HTTP response (endpoint)",
		detail: 'Platform object (LimsType "UI")',
		doc: "Provided by the platform in every server script (`LimsType` reports `UI`). Holds the outgoing HTTP response; meaningful inside endpoint scripts (`Response:Write` does not raise in Designer).",
		path: "reference/special-forms/response/",
		endpointContext: true,
	},
	{
		name: "MYUSERNAME",
		category: "User & session",
		secondary: "string · = GetUserData()",
		detail: "Predefined global (string)",
		doc: "The current user's user name; equals `GetUserData()`, matches case-insensitively, and is preserved in `SubmitToBatch` jobs (`\"internal\"` and `\"queue\"`).\n\nDeclared as a `:PUBLIC` by base v12 `SystemInit` scripts (customized installations may differ).",
		path: "guides/predefined-globals/#user-and-session",
	},
	{
		name: "CRLF",
		category: "Character constants",
		secondary: "Chr(13) + Chr(10)",
		detail: "Predefined global · Chr(13) + Chr(10)",
		doc: "Carriage return and line feed (`Chr(13) + Chr(10)`), case-insensitive, present in Designer and `SubmitToBatch` jobs.\n\nDeclared as a `:PUBLIC` by base v12 `SystemInit` scripts. `CR`, `LF`, and `TAB` are **not** predefined on base v12 — use `Chr(13)`, `Chr(10)`, and `Chr(9)`.",
		path: "guides/predefined-globals/#character-constants",
	},
	{
		name: "sCC",
		category: "Character constants",
		secondary: "Chr(58) · ':'",
		detail: "Predefined global · Chr(58)",
		doc: "Colon character `:` (`Chr(58)`). Declared as a `:PUBLIC` by base v12 `SystemInit` scripts (customized installations may differ).",
		path: "guides/predefined-globals/#character-constants",
	},
	{
		name: "sSC",
		category: "Character constants",
		secondary: "Chr(59) · ';'",
		detail: "Predefined global · Chr(59)",
		doc: "Semicolon character `;` (`Chr(59)`). Declared as a `:PUBLIC` by base v12 `SystemInit` scripts (customized installations may differ).",
		path: "guides/predefined-globals/#character-constants",
	},
	{
		name: "sTK",
		category: "Character constants",
		secondary: "Chr(39) · single quote",
		detail: "Predefined global · Chr(39)",
		doc: "Single quote character `'` (`Chr(39)`). Declared as a `:PUBLIC` by base v12 `SystemInit` scripts (customized installations may differ).",
		path: "guides/predefined-globals/#character-constants",
	},
	{
		name: "sPK",
		category: "Character constants",
		secondary: "Chr(44) · ','",
		detail: "Predefined global · Chr(44)",
		doc: "Comma character `,` (`Chr(44)`). Declared as a `:PUBLIC` by base v12 `SystemInit` scripts (customized installations may differ).",
		path: "guides/predefined-globals/#character-constants",
	},
	{
		name: "DQ",
		category: "Character constants",
		secondary: "Chr(39) · single quote!",
		detail: "Predefined global · Chr(39) (single quote)",
		doc: "Holds `Chr(39)` — a **single quote** `'`, despite the name.\n\n**Don't** use `DQ` for a double quote; use `Chr(34)` instead. (`sDQ` is not predefined on base v12.)",
		path: "guides/predefined-globals/#character-constants",
	},
	{
		name: "PLATFORMA",
		category: "Environment & batch",
		secondary: "string · database platform",
		detail: "Predefined global (string)",
		doc: 'The database platform (`"MSSQL"` on SQL Server). Declared as a `:PUBLIC` by base v12 startup scripts (customized installations may differ).',
		path: "guides/predefined-globals/#environment",
	},
	{
		name: "glb_In_Batch",
		category: "Environment & batch",
		secondary: "boolean · queue batch flag",
		detail: "Predefined global (boolean)",
		doc: '`.T.` when running as a `"queue"` batch job, and `.F.` in Designer and `"internal"` mode batch jobs (matching `InBatchProcess()`).',
		path: "guides/predefined-globals/#in-batch-jobs",
	},
];

/**
 * Globals returned by starlims-lsp that exist in base v12 startup scripts but
 * still need runtime value/member qualification before being listed in the
 * Reference panel.
 */
const PENDING_QUALIFICATION_GLOBALS = new Set([
	"session",
	"publicconsts",
	"userlang",
	"starlimsdept",
	"starlimssitecode",
	"methoddeveloper",
	"stationname",
	"cglobalstationid",
	"transaction_id",
	"caldateformat",
	"glbdefaultworkpath",
	"glbdefaulttempdirectory",
	"glbimpexppath",
]);

const GENERIC_LSP_GLOBAL_DOC = /^Declared by a base STARLIMS installation\b/i;

const PREDEFINED_GLOBAL_LOOKUP = new Map<string, PredefinedGlobalSpec & { order: number }>();
PREDEFINED_GLOBAL_SPECS.forEach((g, idx) => {
	PREDEFINED_GLOBAL_LOOKUP.set(g.name.toLowerCase(), { ...g, order: idx });
});

// Fast O(1) lookup indexes derived from the tables above.
const FUNCTION_LOOKUP = new Map<string, { canonical: string; category: string; subcategory?: string; order: number }>();
{
	let order = 0;
	for (const g of FUNCTION_GROUPS) {
		for (const name of g.names) {
			FUNCTION_LOOKUP.set(name.toLowerCase(), { canonical: name, category: g.category, subcategory: g.subcategory, order: order++ });
		}
	}
}

const CLASS_LOOKUP = new Map<string, { canonical: string; category: string; order: number }>();
{
	let order = 0;
	for (const g of CLASS_GROUPS) {
		for (const name of g.names) {
			CLASS_LOOKUP.set(name.toLowerCase(), { canonical: name, category: g.category, order: order++ });
		}
	}
}

const KEYWORD_LOOKUP = new Map<string, { canonical: string; category: string; slug: string; order: number }>();
{
	let order = 0;
	for (const g of KEYWORD_GROUPS) {
		for (const name of g.names) {
			const bare = name.replace(/^:/, "");
			const entry = { canonical: name, category: g.category, slug: bare, order: order++ };
			KEYWORD_LOOKUP.set(name.toLowerCase(), entry);
			KEYWORD_LOOKUP.set(bare.toLowerCase(), entry);
		}
	}
}

const OPERATOR_LOOKUP = new Map<string, OperatorSpec & { order: number }>();
OPERATOR_SPECS.forEach((op, idx) => {
	OPERATOR_LOOKUP.set(op.symbol.toLowerCase(), { ...op, order: idx });
});

const LITERAL_LOOKUP = new Map<string, (typeof LITERAL_SPECS)[number]>();
for (const lit of LITERAL_SPECS) LITERAL_LOOKUP.set(lit.label.toLowerCase(), lit);

// --- Live merged entry model ---

export type LspReferenceCompletion = {
	label: string;
	kind: number;
	detail?: string;
	doc?: string;
};

export type ReferenceEntry = {
	/** Stable unique key (`section:label`). */
	key: string;
	label: string;
	/** Optional quiet secondary label shown beside symbols (e.g. "Strict Equals" for `==`). */
	secondary?: string;
	section: ReferenceSectionId;
	category: string;
	subcategory?: string;
	/** LSP CompletionItemKind when originated from completion (used for icons & backwards compatibility). */
	lspKind?: number;
	detail?: string;
	doc?: string;
	/** Text to insert at cursor (defaults to `label`; omitted when conceptual). */
	insertText?: string;
	/** Exact probe text + character offset for querying `starlims-lsp` `textDocument/hover`. */
	hoverProbe?: { text: string; line: number; character: number; endpoint?: boolean };
	/** Published GitHub Pages URL for full docs, examples, and tables. */
	docUrl: string;
	/** Canonical sort order within its category. */
	order: number;
};

export type ReferenceSubcategoryNode = {
	key: string;
	label: string;
	entries: ReferenceEntry[];
};

export type ReferenceCategoryNode = {
	key: string;
	label: string;
	entries: ReferenceEntry[];
	subcategories: ReferenceSubcategoryNode[];
	total: number;
};

export type ReferenceSectionNode = {
	meta: ReferenceSectionMeta;
	categories: ReferenceCategoryNode[];
	total: number;
};

export const LISTED_LSP_COMPLETION_KINDS = new Set([2, 3, 6, 7, 14, 21, 24]);

/**
 * Merges live `starlims-lsp` completion items with the published STARLIMS SSL Reference
 * catalog taxonomy and GitHub Pages URLs. Live LSP facts (detail, summary, hover) always win;
 * any new LSP entry not yet in the taxonomy falls cleanly into an "Other" bucket.
 */
export function buildReferenceEntries(lspItems: readonly LspReferenceCompletion[]): ReferenceEntry[] {
	const byKey = new Map<string, ReferenceEntry>();
	const lspOpBySymbol = new Map<string, LspReferenceCompletion>();
	const lspLitByLabel = new Map<string, LspReferenceCompletion>();
	let hasLiveGlobals = false;

	// Index live LSP completion entries into their categorized sections.
	for (const item of lspItems) {
		if (!LISTED_LSP_COMPLETION_KINDS.has(item.kind)) continue;
		const lower = item.label.toLowerCase();

		if (item.kind === 3 || item.kind === 2) {
			const meta = FUNCTION_LOOKUP.get(lower);
			const label = meta?.canonical ?? item.label;
			const key = `functions:${label.toLowerCase()}`;
			byKey.set(key, {
				key,
				label,
				section: "functions",
				category: meta?.category ?? "Other",
				subcategory: meta?.subcategory,
				lspKind: item.kind,
				detail: item.detail,
				doc: item.doc,
				insertText: label,
				hoverProbe: { text: label, line: 0, character: 1 },
				docUrl: meta ? referenceUrl(`reference/functions/${meta.canonical}/`) : referenceUrl("reference/functions/"),
				order: meta?.order ?? 10_000,
			});
			continue;
		}

		if (item.kind === 7) {
			const meta = CLASS_LOOKUP.get(lower);
			const label = meta?.canonical ?? item.label;
			const key = `classes:${label.toLowerCase()}`;
			byKey.set(key, {
				key,
				label,
				section: "classes",
				category: meta?.category ?? "Other",
				lspKind: 7,
				detail: item.detail,
				doc: item.doc,
				insertText: label,
				hoverProbe: { text: label, line: 0, character: 1 },
				docUrl: meta ? referenceUrl(`reference/classes/${meta.canonical}/`) : referenceUrl("reference/classes/"),
				order: meta?.order ?? 10_000,
			});
			continue;
		}

		if (item.kind === 14) {
			const meta = KEYWORD_LOOKUP.get(lower);
			const label = meta?.canonical ?? item.label;
			const bare = label.replace(/^:/, "");
			const key = `keywords:${bare.toLowerCase()}`;
			byKey.set(key, {
				key,
				label,
				section: "keywords",
				category: meta?.category ?? "Other",
				lspKind: 14,
				detail: item.detail,
				doc: item.doc,
				insertText: label,
				hoverProbe: { text: label, line: 0, character: label.startsWith(":") ? 1 : 0 },
				docUrl: meta ? referenceUrl(`reference/keywords/${meta.slug}/`) : referenceUrl("reference/keywords/"),
				order: meta?.order ?? 10_000,
			});
			continue;
		}

		if (item.kind === 24) {
			lspOpBySymbol.set(lower, item);
			continue;
		}

		if (item.kind === 21 && LITERAL_LOOKUP.has(lower)) {
			lspLitByLabel.set(lower, item);
			continue;
		}

		// Installation-specific status names (kind 21, non-literals) vary by installation and
		// their values may differ from their variable names; do not list legacy status keywords
		// as fixed constants. Only qualified predefined globals (kind 6) populate Predefined Globals.
		if (item.kind === 6) {
			hasLiveGlobals = true;
			if (PENDING_QUALIFICATION_GLOBALS.has(lower)) continue;
			const spec = PREDEFINED_GLOBAL_LOOKUP.get(lower);
			const label = spec?.name ?? item.label;
			const key = `globals:${label.toLowerCase()}`;
			const hasCustomLspDoc = Boolean(item.doc?.trim() && !GENERIC_LSP_GLOBAL_DOC.test(item.doc.trim()));
			byKey.set(key, {
				key,
				label,
				secondary: spec?.secondary,
				section: "globals",
				category: spec?.category ?? "Other",
				lspKind: 6,
				detail: hasCustomLspDoc && item.detail ? item.detail : (spec?.detail ?? item.detail),
				doc: hasCustomLspDoc ? item.doc : (spec?.doc ?? item.doc),
				insertText: label,
				hoverProbe: spec?.endpointContext
					? { text: `/* Endpoint: reference */\n${label}`, line: 1, character: 1, endpoint: true }
					: { text: label, line: 0, character: 1 },
				docUrl: referenceUrl(spec?.path ?? "guides/predefined-globals/"),
				order: spec?.order ?? 10_000,
			});
		}
	}

	// starlims-lsp omits Request and Response from non-endpoint global completions even though
	// the platform provides all four objects (Request, Response, Session, PublicConsts) in every
	// server script; include them beside Session/PublicConsts whenever the server sends globals.
	if (hasLiveGlobals) {
		for (const spec of PREDEFINED_GLOBAL_SPECS) {
			if (!spec.endpointContext) continue;
			const key = `globals:${spec.name.toLowerCase()}`;
			if (byKey.has(key)) continue;
			byKey.set(key, {
				key,
				label: spec.name,
				secondary: spec.secondary,
				section: "globals",
				category: spec.category,
				lspKind: 6,
				detail: spec.detail,
				doc: spec.doc,
				insertText: spec.name,
				hoverProbe: { text: `/* Endpoint: reference */\n${spec.name}`, line: 1, character: 1, endpoint: true },
				docUrl: referenceUrl(spec.path),
				order: PREDEFINED_GLOBAL_LOOKUP.get(spec.name.toLowerCase())!.order,
			});
		}
	}

	// Surface Obtained Objects (LSP hoverable via getReturnsObjectHover, not in empty-file completion).
	let retOrder = 0;
	for (const group of OBTAINED_OBJECT_GROUPS) {
		for (const obj of group.items) {
			const key = `returns:${obj.name.toLowerCase()}`;
			byKey.set(key, {
				key,
				label: obj.name,
				secondary: obj.obtainedFrom,
				section: "returns",
				category: group.category,
				lspKind: 7,
				detail: `Obtained from ${obj.obtainedFrom}`,
				insertText: obj.name,
				hoverProbe: { text: obj.name, line: 0, character: 1 },
				docUrl: referenceUrl(`reference/returns/${obj.name}/`),
				order: retOrder++,
			});
		}
	}

	// Surface all 32 Operators in precedence order (merging live LSP detail/doc for .AND./.OR./.NOT.).
	OPERATOR_SPECS.forEach((op, idx) => {
		const live = lspOpBySymbol.get(op.symbol.toLowerCase());
		const key = `operators:${op.slug}`;
		byKey.set(key, {
			key,
			label: op.symbol,
			secondary: op.title,
			section: "operators",
			category: op.category,
			lspKind: 24,
			detail: live?.detail ?? `${op.category} operator — ${op.title}`,
			doc: live?.doc,
			insertText: op.symbol,
			hoverProbe: op.symbol.startsWith(".") ? { text: op.symbol, line: 0, character: 1 } : undefined,
			docUrl: referenceUrl(`reference/operators/${op.slug}/`),
			order: idx,
		});
	});

	// Surface all 8 Core Types (LSP hoverable via getTypeHover).
	TYPE_SPECS.forEach((t, idx) => {
		const key = `types:${t.slug}`;
		byKey.set(key, {
			key,
			label: t.label,
			section: "types",
			category: "Core Types",
			detail: `Core SSL value type`,
			hoverProbe: { text: t.label, line: 0, character: 1 },
			docUrl: referenceUrl(`reference/types/${t.slug}/`),
			order: idx,
		});
	});

	// Surface all 3 Literals (.T., .F., NIL), enriching from live LSP completion when present.
	LITERAL_SPECS.forEach((lit, idx) => {
		const live = lspLitByLabel.get(lit.label.toLowerCase());
		const key = `literals:${lit.slug}`;
		byKey.set(key, {
			key,
			label: lit.label,
			section: "literals",
			category: "Literals",
			lspKind: 21,
			detail: live?.detail ?? "SSL Literal",
			doc: live?.doc,
			insertText: lit.label,
			hoverProbe: { text: lit.hoverText, line: 0, character: lit.hoverText.startsWith(".") ? 1 : 0 },
			docUrl: referenceUrl(`reference/literals/${lit.slug}/`),
			order: idx,
		});
	});

	// Surface all 8 Special Forms (Me, Base, Constructor, Request, Response hover via starlims-lsp).
	SPECIAL_FORM_SPECS.forEach((sf, idx) => {
		const key = `special-forms:${sf.slug}`;
		byKey.set(key, {
			key,
			label: sf.label,
			section: "special-forms",
			category: sf.category,
			detail: `${sf.category} special form`,
			insertText: sf.insertText,
			hoverProbe: sf.hoverText
				? sf.endpointContext
					? { text: `/* Endpoint: reference */\n${sf.hoverText}`, line: 1, character: 1, endpoint: true }
					: { text: sf.hoverText, line: 0, character: 1 }
				: undefined,
			docUrl: referenceUrl(`reference/special-forms/${sf.slug}/`),
			order: idx,
		});
	});

	return [...byKey.values()];
}

export function filterReferenceEntries(
	entries: readonly ReferenceEntry[],
	opts: { query: string; section: ReferenceSectionId | "all" },
): ReferenceEntry[] {
	const words = opts.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return entries.filter((e) => {
		if (opts.section !== "all" && e.section !== opts.section) return false;
		if (!words.length) return true;
		const hay = [
			e.label,
			e.secondary ?? "",
			REFERENCE_SECTION_MAP[e.section].label,
			e.category,
			e.subcategory ?? "",
			e.detail ?? "",
			e.doc ?? "",
		]
			.join(" ")
			.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

export function matchingGuides(query: string): ReferenceGuide[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [...REFERENCE_GUIDES];
	return REFERENCE_GUIDES.filter((g) => {
		const hay = `${g.title} ${g.summary} ${g.keywords.join(" ")}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

/** Maps a Reference entry to 1-2 relevant conceptual Guides on the published reference site. */
export function relatedGuidesForEntry(entry: ReferenceEntry): ReferenceGuide[] {
	const ids: string[] = [];
	const push = (id: string) => {
		if (!ids.includes(id) && REFERENCE_GUIDE_MAP[id]) ids.push(id);
	};
	if (entry.section === "functions") {
		if (entry.category === "Database") {
			if (entry.subcategory === "Transactions") push("sql-transactions");
			if (entry.label === "RunDS" || entry.label === "GetDSParameters") push("data-sources");
			push("sql-queries");
		} else if (entry.category === "Messaging & Errors") {
			push("error-handling");
		} else if (entry.category === "Variable & Session Management") {
			push("variable-scope");
		} else if (entry.category === "Type Conversion") {
			push("type-system");
		} else if (entry.category === "Object & Interop") {
			push("native-members");
		}
	} else if (entry.section === "classes") {
		if (entry.category === "Errors & diagnostics") push("error-handling");
		else if (entry.category === "Tabular data & datasets") push("sql-queries");
	} else if (entry.section === "returns") {
		if (entry.category === "Endpoint runtime") push("predefined-globals");
	} else if (entry.section === "keywords") {
		if (entry.category === "Error Handling") push("error-handling");
		else if (entry.category === "Declarations") push("variable-scope");
	} else if (entry.section === "types") {
		push("type-system");
		push("native-members");
	} else if (entry.section === "literals") {
		push("type-system");
	} else if (entry.section === "special-forms") {
		if (entry.category === "Endpoint ambients") push("predefined-globals");
	} else if (entry.section === "globals") {
		push("predefined-globals");
		push("variable-scope");
	}
	return ids.map((id) => REFERENCE_GUIDE_MAP[id]!);
}

const SECTION_CATEGORY_ORDER: Record<ReferenceSectionId, readonly string[]> = {
	functions: [...new Set(FUNCTION_GROUPS.map((g) => g.category)), "Other"],
	classes: [...CLASS_GROUPS.map((g) => g.category), "Other"],
	returns: OBTAINED_OBJECT_GROUPS.map((g) => g.category),
	keywords: [...KEYWORD_GROUPS.map((g) => g.category), "Other"],
	operators: ["Unary", "Power & Arithmetic", "Shift", "Relational & Equality", "Logical", "Assignment"],
	types: ["Core Types"],
	literals: ["Literals"],
	"special-forms": ["Class infrastructure", "Endpoint ambients", "Other"],
	globals: ["Provided by the platform", "User & session", "Character constants", "Environment & batch", "Other"],
};

const SUBCATEGORY_ORDER = new Map<string, readonly string[]>([
	["Database", ["SQL Queries", "Transactions", "Connections", "Schema", "SQL Utilities", "Dataset Builders"]],
	["Documentum", ["Auth", "Documents", "Folders & Cabinets", "Users & Groups", "Workflows", "Search", "Documentum Errors"]],
]);

function sortEntriesInGroup(section: ReferenceSectionId, list: ReferenceEntry[]): ReferenceEntry[] {
	return [...list].sort((a, b) => {
		if (
			section === "operators" ||
			section === "literals" ||
			section === "special-forms" ||
			section === "returns" ||
			section === "globals"
		) {
			return a.order - b.order || a.label.localeCompare(b.label);
		}
		return a.label.localeCompare(b.label);
	});
}

/** Organizes filtered Reference entries into the canonical collapsible Section -> Category -> Subcategory tree. */
export function groupReferenceTree(entries: readonly ReferenceEntry[]): ReferenceSectionNode[] {
	const bySection = new Map<ReferenceSectionId, ReferenceEntry[]>();
	for (const e of entries) {
		const list = bySection.get(e.section);
		if (list) list.push(e);
		else bySection.set(e.section, [e]);
	}

	const sections: ReferenceSectionNode[] = [];
	for (const meta of REFERENCE_SECTIONS) {
		const secEntries = bySection.get(meta.id);
		if (!secEntries?.length) continue;

		const byCat = new Map<string, ReferenceEntry[]>();
		for (const e of secEntries) {
			const list = byCat.get(e.category);
			if (list) list.push(e);
			else byCat.set(e.category, [e]);
		}

		const orderedCatNames = [
			...SECTION_CATEGORY_ORDER[meta.id].filter((c) => byCat.has(c)),
			...[...byCat.keys()].filter((c) => !SECTION_CATEGORY_ORDER[meta.id].includes(c)).sort(),
		];

		const categories: ReferenceCategoryNode[] = [];
		for (const catName of orderedCatNames) {
			const catEntries = byCat.get(catName)!;
			const hasSub = catEntries.some((e) => Boolean(e.subcategory));
			if (!hasSub) {
				categories.push({
					key: `${meta.id}:${catName}`,
					label: catName,
					entries: sortEntriesInGroup(meta.id, catEntries),
					subcategories: [],
					total: catEntries.length,
				});
			} else {
				const bySub = new Map<string, ReferenceEntry[]>();
				for (const e of catEntries) {
					const sub = e.subcategory ?? "General";
					const list = bySub.get(sub);
					if (list) list.push(e);
					else bySub.set(sub, [e]);
				}
				const subOrder = SUBCATEGORY_ORDER.get(catName) ?? [];
				const orderedSubs = [
					...subOrder.filter((s) => bySub.has(s)),
					...[...bySub.keys()].filter((s) => !subOrder.includes(s)).sort(),
				];
				const subcategories: ReferenceSubcategoryNode[] = orderedSubs.map((subName) => ({
					key: `${meta.id}:${catName}:${subName}`,
					label: subName,
					entries: sortEntriesInGroup(meta.id, bySub.get(subName)!),
				}));
				categories.push({
					key: `${meta.id}:${catName}`,
					label: catName,
					entries: [],
					subcategories,
					total: catEntries.length,
				});
			}
		}

		sections.push({
			meta,
			categories,
			total: secEntries.length,
		});
	}

	return sections;
}

/** Total number of cataloged elements in the public STARLIMS SSL Reference site map. */
export const CATALOG_ELEMENT_COUNTS = {
	functions: FUNCTION_GROUPS.reduce((n, g) => n + g.names.length, 0),
	classes: CLASS_GROUPS.reduce((n, g) => n + g.names.length, 0),
	returns: OBTAINED_OBJECT_GROUPS.reduce((n, g) => n + g.items.length, 0),
	keywords: KEYWORD_GROUPS.reduce((n, g) => n + g.names.length, 0),
	operators: OPERATOR_SPECS.length,
	types: TYPE_SPECS.length,
	literals: LITERAL_SPECS.length,
	specialForms: SPECIAL_FORM_SPECS.length,
	predefinedGlobals: PREDEFINED_GLOBAL_SPECS.length,
	guides: REFERENCE_GUIDES.length,
} as const;
