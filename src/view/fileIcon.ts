// The mark a file goes by in the Explorer, the Docs panel and a tab: a glyph of
// the icon font and a kind for its colour, from the file's name alone. The
// kinds are the ones this IDE treats differently, not a list of every type.

export type FileKind = "folder" | "script" | "data" | "plan" | "doc" | "config" | "file";
export type FileIcon = { glyph: string; kind: FileKind; /** What the mark says, for a tooltip; the name already says it to a screen reader. */ what: string };

const ICONS: Record<FileKind, [glyph: string, what: string]> = {
	folder: ["", "Folder"],
	script: ["", "SSL script"],
	data: ["", "Data source or SQL"],
	plan: ["", "Plan"],
	doc: ["", "Document"],
	config: ["", "Settings"],
	file: ["", "File"],
};
const FOLDER_OPEN = "";

/** The longest endings first: a plan is a .json, a data source may be a .ds.txt. */
const ENDINGS: [ending: string, kind: FileKind][] = [
	[".plan.json", "plan"],
	[".plan.md", "plan"],
	[".ssl.txt", "script"],
	[".ds.txt", "data"],
	[".srvscr", "script"],
	[".ssl", "script"],
	[".ds", "data"],
	[".sql", "data"],
	[".markdown", "doc"],
	[".md", "doc"],
	[".toml", "config"],
	[".jsonc", "config"],
	[".json", "config"],
	[".yml", "config"],
	[".yaml", "config"],
	[".xml", "config"],
	[".xfd", "config"],
	[".xsd", "config"],
	[".xsl", "config"],
	[".xslt", "config"],
	[".wsdl", "config"],
	[".config", "config"],
];

export function fileKind(name: string): FileKind {
	const lower = name.toLowerCase();
	return ENDINGS.find(([ending]) => lower.endsWith(ending))?.[1] ?? "file";
}

export function fileIcon(name: string, folder?: { open: boolean }): FileIcon {
	if (folder) return { glyph: folder.open ? FOLDER_OPEN : ICONS.folder[0], kind: "folder", what: ICONS.folder[1] };
	const kind = fileKind(name);
	return { glyph: ICONS[kind][0], kind, what: ICONS[kind][1] };
}
