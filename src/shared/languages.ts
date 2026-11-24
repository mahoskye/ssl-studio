// Language catalog for SSL Studio: STARLIMS SSL + companion languages commonly
// encountered across STARLIMS, .NET/IIS, Windows, SQL, web, and lab-integration
// workspaces. Pure module (no Monaco/DOM imports) so tests and UI share one source.

export type LanguageDef = {
	id: string;
	name: string;
	extensions: RegExp;
	/** Human-readable extension hints shown in the Language Mode picker and searchable by keyword. */
	hint: string;
	/** Extra search aliases (e.g. "tsql", "vbnet", "cmd", "xfd") for instant VS Code-style filtering. */
	aliases?: readonly string[];
};

/**
 * Languages ordered with STARLIMS core & companion languages first, followed by
 * general-purpose languages and Plain Text. First matching extension wins in `languageFor()`.
 */
export const LANGUAGES: readonly LanguageDef[] = [
	{ id: "ssl", name: "SSL", extensions: /\.(ssl|srvscr|ds)$/i, hint: ".ssl, .srvscr, .ds", aliases: ["starlims", "script", "datasource"] },
	{ id: "sql", name: "SQL", extensions: /\.(sql|ddl|pks|pkb|pls)$/i, hint: ".sql, .ddl, .pks, .pkb", aliases: ["tsql", "plsql", "oracle", "mssql"] },
	{
		id: "xml",
		name: "XML",
		extensions: /\.(xml|xfd|xsd|xsl|xslt|wsdl|config|csproj|vbproj|xaml|resx|rdlc|props|targets|svg)$/i,
		hint: ".xml, .xfd, .config, .xsd, .xslt",
		aliases: ["xfd", "designer", "web.config", "app.config", "svg"],
	},
	{ id: "json", name: "JSON", extensions: /\.(json|jsonc)$/i, hint: ".json, .jsonc", aliases: ["jsonc"] },
	{ id: "javascript", name: "JavaScript", extensions: /\.(m?js|cjs|jsx)$/i, hint: ".js, .mjs, .jsx", aliases: ["js", "es", "node"] },
	{ id: "typescript", name: "TypeScript", extensions: /\.(m?ts|cts|tsx)$/i, hint: ".ts, .mts, .tsx", aliases: ["ts"] },
	{ id: "html", name: "HTML", extensions: /\.html?$/i, hint: ".html, .htm", aliases: ["web"] },
	{ id: "css", name: "CSS", extensions: /\.css$/i, hint: ".css", aliases: ["stylesheet"] },
	{ id: "scss", name: "SCSS", extensions: /\.scss$/i, hint: ".scss", aliases: ["sass"] },
	{ id: "less", name: "Less", extensions: /\.less$/i, hint: ".less" },
	{ id: "csharp", name: "C#", extensions: /\.cs$/i, hint: ".cs", aliases: ["cs", "dotnet", "c#"] },
	{ id: "vb", name: "Visual Basic", extensions: /\.(vb|vbs|bas)$/i, hint: ".vb, .vbs, .bas", aliases: ["vbnet", "vb.net", "vbscript", "vba"] },
	{ id: "razor", name: "Razor / ASP.NET", extensions: /\.(cshtml|razor|aspx|ascx|master)$/i, hint: ".cshtml, .aspx, .razor", aliases: ["aspnet", "asp.net", "aspx"] },
	{ id: "powershell", name: "PowerShell", extensions: /\.(ps1|psm1|psd1)$/i, hint: ".ps1, .psm1, .psd1", aliases: ["ps", "pwsh"] },
	{ id: "bat", name: "Batch", extensions: /\.(bat|cmd)$/i, hint: ".bat, .cmd", aliases: ["dos", "windows", "cmd"] },
	{ id: "shell", name: "Shell Script", extensions: /\.(sh|bash|zsh)$/i, hint: ".sh, .bash, .zsh", aliases: ["bash", "sh", "posix"] },
	{ id: "markdown", name: "Markdown", extensions: /\.(md|markdown)$/i, hint: ".md, .markdown", aliases: ["md", "docs"] },
	{ id: "csv", name: "CSV", extensions: /\.(csv|tsv)$/i, hint: ".csv, .tsv", aliases: ["tsv", "table"] },
	{ id: "yaml", name: "YAML", extensions: /\.(ya?ml)$/i, hint: ".yml, .yaml", aliases: ["yml"] },
	{ id: "toml", name: "TOML", extensions: /\.toml$/i, hint: ".toml" },
	{ id: "ini", name: "INI", extensions: /\.(ini|cfg|conf|properties|env)$/i, hint: ".ini, .cfg, .conf, .env", aliases: ["properties", "dotenv"] },
	{ id: "pgsql", name: "PostgreSQL", extensions: /\.pgsql$/i, hint: ".pgsql", aliases: ["postgres", "plpgsql"] },
	{ id: "mysql", name: "MySQL", extensions: /\.mysql$/i, hint: ".mysql" },
	{ id: "python", name: "Python", extensions: /\.py$/i, hint: ".py", aliases: ["py"] },
	{ id: "java", name: "Java", extensions: /\.java$/i, hint: ".java", aliases: ["mirth"] },
	{ id: "cpp", name: "C / C++", extensions: /\.(c|h|cpp|hpp|cc|cxx|hh)$/i, hint: ".c, .h, .cpp, .hpp", aliases: ["c", "c++", "cxx"] },
	{ id: "php", name: "PHP", extensions: /\.php$/i, hint: ".php" },
	{
		id: "dockerfile",
		name: "Dockerfile",
		extensions: /(?:^|[\\/])Dockerfile(?:\.[^\\/]*)?$|\.dockerfile$/i,
		hint: "Dockerfile, .dockerfile",
		aliases: ["docker"],
	},
	{ id: "graphql", name: "GraphQL", extensions: /\.(graphql|gql)$/i, hint: ".graphql, .gql", aliases: ["gql"] },
	{ id: "r", name: "R", extensions: /\.r$/i, hint: ".r", aliases: ["rlang", "stats"] },
	{ id: "perl", name: "Perl", extensions: /\.(pl|pm)$/i, hint: ".pl, .pm" },
	{ id: "ruby", name: "Ruby", extensions: /\.rb$/i, hint: ".rb", aliases: ["rb"] },
	{ id: "go", name: "Go", extensions: /\.go$/i, hint: ".go", aliases: ["golang"] },
	{ id: "rust", name: "Rust", extensions: /\.rs$/i, hint: ".rs", aliases: ["rs"] },
	{ id: "fsharp", name: "F#", extensions: /\.(fs|fsx)$/i, hint: ".fs, .fsx", aliases: ["fs", "f#"] },
	{ id: "plaintext", name: "Plain Text", extensions: /\.(txt|log|hl7)$/i, hint: ".txt, .log, .hl7", aliases: ["text", "plain", "hl7", "log"] },
];

export const languageFor = (path: string): string => LANGUAGES.find((l) => l.extensions.test(path))?.id ?? "plaintext";

/** A language by the name a person would call it: "TOML", not "toml"; unknown ids default to Plain Text. */
export const languageName = (id: string | undefined): string => LANGUAGES.find((l) => l.id === id)?.name ?? "Plain Text";

export type LanguagePickerEntry = {
	id: string;
	label: string;
	detail: string;
	keywords: string;
	current: boolean;
	detected: boolean;
	isAutoDetect?: boolean;
};

/**
 * Builds VS Code-style Language Mode picker items: Auto Detect (when overridden),
 * currently configured language badge, and searchable extensions/aliases.
 */
export function buildLanguagePickerEntries(currentId: string, detectedId: string): LanguagePickerEntry[] {
	const entries: LanguagePickerEntry[] = [];
	if (currentId !== detectedId) {
		entries.push({
			id: detectedId,
			label: `Auto Detect (${languageName(detectedId)})`,
			detail: `Restore default for this file (${detectedId})`,
			keywords: `auto detect reset default ${detectedId} ${languageName(detectedId)}`,
			current: false,
			detected: true,
			isAutoDetect: true,
		});
	}
	for (const lang of LANGUAGES) {
		const isCurrent = lang.id === currentId;
		const isDetected = lang.id === detectedId;
		const detail = `${lang.id} · ${lang.hint}`;
		const keywords = [lang.id, lang.name, lang.hint, ...(lang.aliases ?? [])].join(" ");
		entries.push({
			id: lang.id,
			label: lang.name,
			detail,
			keywords,
			current: isCurrent,
			detected: isDetected,
		});
	}
	return entries;
}
