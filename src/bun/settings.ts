// User settings in ~/.config/ssl-studio, then the project's own
// (.ssl-studio/project.toml), then what the IDE saved for this workspace
// (.ssl-studio/settings.json): each later one wins. The agent's model alone
// goes the other way, the user's over the project's (SettingsStore.load).
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SQL_DIALECTS } from "../shared/format";
import { jsonProblem } from "../shared/jsonCheck";
import { parseJsonc } from "../shared/jsonc";
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch, type SettingsScope, type ThemeFile } from "../shared/protocol";
import { HOUSE_STYLE } from "../shared/styleProfile";
import { isLocalModelRef } from "./agent";
import { renameReplacing } from "./atomic";
import { dirs, workspaceDir } from "./paths";
import { projectSettings, readProject } from "./project";
import { Serial } from "./serial";
import { assertPathInsideRoot, resolveRealPath } from "./workspace";

/**
 * Settings that control executable paths, remote servers, billing trust, or personal keybindings: never honored from
 * workspace files. One thing is let through, and not by this list: the local model a project names (`load`).
 */
export const USER_ONLY_SETTINGS = new Set(["lspPath", "agentServerUrl", "agentServerConfig", "agentOwnModels", "agentModel", "keys"]);

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const OBJECT_KEYS = new Set(["layout", "limits", "regionColors", "keys", "ssl"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function clonePlain(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (UNSAFE_KEYS.has(k)) continue;
		out[k] = isPlainObject(v) ? clonePlain(v) : Array.isArray(v) ? structuredClone(v) : v;
	}
	return out;
}

function stripUserOnly<T extends Record<string, unknown>>(obj: T): Partial<Settings> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (UNSAFE_KEYS.has(k) || USER_ONLY_SETTINGS.has(k)) continue;
		out[k] = v;
	}
	return out as Partial<Settings>;
}

/**
 * What a setting's value has to be to be taken, one rule to each kind:
 * - `string`, `boolean`: a value of that kind.
 * - `from` and `to`: a number, held to that range (one past an end is taken as the end, as the view takes it).
 * - `oneOf`: one of those words.
 * - `strings`: a list; what is not a string in it is left out.
 * - `object`: names and values, which are for their own reader (the language server's settings, the table badges).
 * - `each`: names and values, every value by one rule; `fields`: by a rule to each name, other names as they are.
 * A value that is not what its rule says is not taken, so the layer below it shows through, or the default.
 */
type Rule = "string" | "boolean" | "strings" | "object" | { from: number; to: number } | { oneOf: readonly string[] } | { each: Rule } | { fields: Record<string, Rule> };

/** A count or a size in pixels: any number that is not below nothing. */
const AMOUNT: Rule = { from: 0, to: Number.MAX_SAFE_INTEGER };

/** The rule of each setting. A setting with none here (one this version does not know) is taken as it is written. */
const SETTING_RULES: Partial<Record<keyof Settings, Rule>> = {
	theme: "string",
	themeMaterial: "string",
	uiFont: "string",
	codeFont: "string",
	readFont: "string",
	fontSize: { from: 8, to: 40 },
	formatOnSave: "boolean",
	minimap: "boolean",
	wordWrap: "boolean",
	livePreview: "boolean",
	markdownReadingHighlight: "boolean",
	templatesFolder: "string",
	attachmentsFolder: "string",
	menuBar: "boolean",
	inlayHints: "boolean",
	rulers: "boolean",
	rulerMargin: { from: 0, to: 60 },
	uiScale: { from: 0.8, to: 1.6 },
	lspPath: "string",
	regionColors: { each: "string" },
	limits: { fields: { bytes: AMOUNT, codeLines: AMOUNT, historyEntries: AMOUNT } },
	layout: { fields: { left: "boolean", right: "boolean", bottom: "boolean", leftWidth: AMOUNT, rightWidth: AMOUNT, bottomHeight: AMOUNT, dock: { each: { oneOf: ["left", "right"] } } } },
	ssl: "object",
	stylePreset: { oneOf: ["house", "server"] },
	agentModel: "string",
	agentOwnModels: "strings",
	agentServerConfig: "string",
	agentServerUrl: "string",
	keys: { each: "string" },
	csvTable: "object",
	sqlDialect: { oneOf: SQL_DIALECTS.map((dialect) => dialect.id) },
	activeTicket: "string",
};

/** A value as its rule takes it; undefined when it is not taken. */
function taken(rule: Rule, value: unknown): unknown {
	if (rule === "string") return typeof value === "string" ? value : undefined;
	if (rule === "boolean") return typeof value === "boolean" ? value : undefined;
	if (rule === "strings") return Array.isArray(value) ? value.filter((item) => typeof item === "string") : undefined;
	if (rule === "object") return isPlainObject(value) ? value : undefined;
	if ("from" in rule) return typeof value === "number" && Number.isFinite(value) ? Math.min(rule.to, Math.max(rule.from, value)) : undefined;
	if ("oneOf" in rule) return typeof value === "string" && rule.oneOf.includes(value) ? value : undefined;
	if (!isPlainObject(value)) return undefined;
	const out: Record<string, unknown> = {};
	for (const [name, held] of Object.entries(value)) {
		if (UNSAFE_KEYS.has(name)) continue;
		const inner = "each" in rule ? rule.each : Object.hasOwn(rule.fields, name) ? rule.fields[name] : undefined;
		const got = inner ? taken(inner, held) : held;
		if (got !== undefined) out[name] = got;
	}
	return out;
}

/**
 * One file's settings as they are taken: each value by its setting's rule (`SETTING_RULES`). A settings file is
 * written by hand as well as from here, and a value of the wrong kind in it used to go on to whatever read the
 * setting: a list where a folder's name was expected stopped the Docs panel from listing anything.
 */
export function checked(layer: unknown): Partial<Settings> {
	const out: Record<string, unknown> = {};
	if (!isPlainObject(layer)) return out;
	for (const [key, value] of Object.entries(layer)) {
		if (UNSAFE_KEYS.has(key) || value === undefined || value === null) continue;
		const rule = Object.hasOwn(SETTING_RULES, key) ? SETTING_RULES[key as keyof Settings] : undefined;
		const got = rule ? taken(rule, value) : value;
		if (got !== undefined) out[key] = got;
	}
	return out as Partial<Settings>;
}

/**
 * Who a new file is for. `shared`: a workspace's own file, committed and read by everyone who has the checkout,
 * so it gets what any new file there gets. `private`: the user's own (settings, themes, recent folders).
 */
type Access = "shared" | "private";

/** The access the written file ends up with: what it had, or for a new file what `access` says. Not on Windows. */
function modeFor(path: string, access: Access): number | undefined {
	if (process.platform === "win32") return undefined;
	try {
		return statSync(path).mode & 0o777;
	} catch {
		return access === "shared" ? 0o666 & ~process.umask() : 0o600;
	}
}

/**
 * Where a write of `named` lands: the file itself, or for a link the file it leads to, there yet or not (as a
 * workspace file's does, `landing` in workspace.ts). A link that leads nowhere at all (round to itself) is written
 * over as a file is.
 */
function landing(named: string): string {
	try {
		if (lstatSync(named).isSymbolicLink()) return resolveRealPath(named);
	} catch {
		// Nothing of that name yet, or a link that cannot be followed: the name itself.
	}
	return named;
}

async function atomicWrite(named: string, content: string, access: Access = "private"): Promise<void> {
	// A settings file that is a link (kept in a repository of dotfiles and linked into place) is written where the
	// link leads. The temporary file renamed over the link's own name left a plain file in its place, and the file
	// in the repository kept the old settings.
	const path = landing(named);
	mkdirSync(dirname(path), { recursive: true });
	// Beside the file it becomes, under a short name of its own: the file's name with more after it was too long
	// a name for a theme whose own name was near the most a file system allows. Named as this program's, since
	// through a link it is made in a folder that is not.
	const temp = join(dirname(path), `.ssl-studio.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
	// Read before the temp file takes the name: the temp file is made private (it is renamed over the file, and
	// that used to leave a workspace's shared settings.json readable by its writer alone), then given this.
	const mode = modeFor(path, access);
	const flags =
		process.platform === "win32"
			? "wx"
			: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
	let created = false;
	try {
		const fd = openSync(temp, flags, 0o600);
		created = true;
		try {
			const buf = Buffer.from(content, "utf8");
			let offset = 0;
			while (offset < buf.length) {
				offset += writeSync(fd, buf, offset, buf.length - offset);
			}
			if (mode !== undefined && mode !== 0o600) fchmodSync(fd, mode);
		} finally {
			closeSync(fd);
		}
		await renameReplacing(temp, path);
		created = false;
	} catch (err) {
		if (created) {
			try {
				rmSync(temp, { force: true });
			} catch {
				// Best-effort cleanup of temp file.
			}
		}
		throw err;
	}
}

async function readJson<T>(path: string, fallback: T, check?: (value: unknown) => value is T): Promise<T> {
	try {
		const parsed: unknown = await Bun.file(path).json();
		if (check) return check(parsed) ? parsed : fallback;
		return parsed as T;
	} catch {
		return fallback;
	}
}

/**
 * A settings file as it reads: what it holds (nothing when it is not there, or is empty), and, when it is there
 * and could not be read as settings, what is wrong with it and where. JSON.parse says only that it failed; the
 * place is found by reading the text (`jsonProblem`), counted from 1 as an editor shows it.
 */
async function readSettings(path: string): Promise<{ held: Record<string, unknown>; wrong?: string }> {
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch (e: any) {
		if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return { held: {} };
		return { held: {}, wrong: `could not be read (${e?.message ?? e})` };
	}
	if (!text.trim()) return { held: {} };
	let read: unknown;
	try {
		read = JSON.parse(text);
	} catch (e: any) {
		const found = jsonProblem(text);
		if (!found) return { held: {}, wrong: `does not read as settings (${e?.message ?? e})` };
		const before = text.slice(0, found.offset);
		const line = before.split("\n").length;
		const column = found.offset - (before.lastIndexOf("\n") + 1) + 1;
		return { held: {}, wrong: `does not read as settings (line ${line}, column ${column}: ${found.message})` };
	}
	if (!isPlainObject(read)) return { held: {}, wrong: "does not hold settings (it is not a list of names and values)" };
	return { held: read };
}

/** What was last said in the log of settings files that do not read, so that it is said once and not at every reading. */
let unreadSaid = "";

export function merge(...layers: Partial<Settings>[]): Settings {
	const result: any = structuredClone(DEFAULT_SETTINGS);
	for (const layer of layers) {
		if (!isPlainObject(layer)) continue;
		for (const [key, value] of Object.entries(checked(layer))) {
			if (UNSAFE_KEYS.has(key) || value === undefined || value === null) continue;
			if (key === "theme") {
				if (typeof value === "string") result.theme = value;
				continue;
			}
			if (key === "fontSize") {
				if (typeof value === "number" && Number.isFinite(value)) result.fontSize = value;
				continue;
			}
			if (key === "formatOnSave" || key === "minimap") {
				if (typeof value === "boolean") result[key] = value;
				continue;
			}
			if (key === "stylePreset") {
				if (value === "house" || value === "server") result.stylePreset = value;
				continue;
			}
			if (OBJECT_KEYS.has(key)) {
				if (!isPlainObject(value)) continue;
				if (key === "ssl" || key === "layout") {
					result[key] = deepMerge(result[key], value);
					if (key === "layout" && "dock" in result.layout && !isPlainObject(result.layout.dock)) {
						delete result.layout.dock;
					}
				} else {
					result[key] = mergeFlatObject(result[key], value);
				}
				continue;
			}
			if (isPlainObject(value)) {
				result[key] = isPlainObject(result[key]) ? deepMerge(result[key], value) : deepMerge({}, value);
			} else {
				result[key] = Array.isArray(value) ? structuredClone(value) : value;
			}
		}
	}
	const baseStyle = result.stylePreset === "server" ? {} : structuredClone(HOUSE_STYLE);
	result.ssl = deepMerge(baseStyle, result.ssl);
	return result;
}

function mergeFlatObject(base: unknown, over: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = isPlainObject(base) ? clonePlain(base) : {};
	for (const [k, v] of Object.entries(over)) {
		if (UNSAFE_KEYS.has(k) || v === undefined || v === null) continue;
		out[k] = isPlainObject(v) ? deepMerge(out[k], v) : Array.isArray(v) ? structuredClone(v) : v;
	}
	return out;
}

function deepMerge(base: unknown, over: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = isPlainObject(base) ? clonePlain(base) : {};
	if (!isPlainObject(over)) return out;
	for (const [k, v] of Object.entries(over)) {
		if (UNSAFE_KEYS.has(k) || v === undefined || v === null) continue;
		if (isPlainObject(v)) {
			out[k] = isPlainObject(out[k]) ? deepMerge(out[k], v) : deepMerge({}, v);
		} else if (!isPlainObject(out[k])) {
			out[k] = Array.isArray(v) ? structuredClone(v) : v;
		}
	}
	return out;
}

export class SettingsStore {
	constructor(private root: () => string | null) {}

	/** The saves of the settings, one after another. */
	private saves = new Serial();

	private path(scope: SettingsScope) {
		const root = this.root();
		if (scope === "workspace") {
			if (!root) throw new Error("no workspace open");
			return assertPathInsideRoot(root, join(workspaceDir(root), "settings.json"), true);
		}
		return join(dirs.config, "settings.json");
	}

	/**
	 * The settings as they are, from every file. A file that is there and does not read as settings (a comma too
	 * many after an edit by hand) gives none, and the others are still used: it used to count as no file at all,
	 * without a word. Now it is named in `problems`, with the place in it that is wrong, and in the log once; and
	 * it is not written over until it is mended (`held`). Each value is taken by its setting's rule (`checked`).
	 */
	async load() {
		const problems: string[] = [];
		const read = async (path: string) => {
			const { held, wrong } = await readSettings(path);
			if (wrong) problems.push(`${path} ${wrong}, so none of its settings are used. It is not written over until it is mended by hand, or removed.`);
			return held;
		};
		const user = checked(await read(this.path("user")));
		const root = this.root();
		let rawWorkspace: Record<string, unknown> = {};
		if (root) {
			try {
				rawWorkspace = await read(this.path("workspace"));
			} catch {
				// Reject symlinked workspace `.ssl-studio` escaping outside `root` without blocking user settings load.
				rawWorkspace = {};
			}
		}
		const said = problems.join("\n");
		if (said && said !== unreadSaid) console.error(said);
		unreadSaid = said;
		const workspace = checked(stripUserOnly(rawWorkspace));
		const chosen: Partial<Settings> = root ? projectSettings(await readProject(root)) : {};
		const project = stripUserOnly(chosen as Record<string, unknown>);
		const effective = merge(user, project, workspace);
		// The model a project names (`[agent] model` in project.toml) is the model until the user chooses their own.
		// It was stripped with the settings a workspace may not set, so it was never applied. It is not laid over the
		// user's as the project's other settings are: the model picker saves the user's choice, and a project's model
		// on top would hide it. A folder never picks what is paid for, so only a local model is taken:
		// `projectSettings` gives no other, and it is asked once more here.
		const own = typeof user.agentModel === "string" && user.agentModel.trim() !== "";
		if (!own && isLocalModelRef(chosen.agentModel)) effective.agentModel = chosen.agentModel;
		return { effective, user, workspace, ...(problems.length ? { problems } : {}) };
	}

	/**
	 * Saves of the settings go one after another, whichever file they are for. Each reads its file, changes it and
	 * writes it: asked for at once, two used to read it before either had written, and the later one wrote the
	 * earlier one's change away. One after another for both files, so that what a save answers with (the settings
	 * as they now are, read from both) is never read while the other file is being written, and the answers come
	 * in the order the saves were asked for.
	 *
	 * The file is written beside itself and moved into place, so that it is never half there. A file that is there
	 * and does not read as settings is not written over: a patch alone would have taken its place, and with it
	 * everything the file held.
	 */
	async save(scope: SettingsScope, patch: SettingsPatch) {
		const root = scope === "workspace" ? this.root() : null;
		const path = this.path(scope);
		return this.saves.run("settings", async () => {
			if (scope === "workspace") assertPathInsideRoot(root!, path, true);
			const current = await this.held(path);
			// A value of null takes the setting out of this file, so the layer below shows through.
			// (undefined cannot say it: it does not survive the trip from the view.)
			const next: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(current)) {
				if (UNSAFE_KEYS.has(key)) continue;
				if (scope === "workspace" && USER_ONLY_SETTINGS.has(key)) continue;
				next[key] = value;
			}
			if (isPlainObject(patch)) {
				for (const [key, value] of Object.entries(patch)) {
					if (UNSAFE_KEYS.has(key) || value === undefined) continue;
					if (scope === "workspace" && USER_ONLY_SETTINGS.has(key)) continue;
					if (value === null) delete next[key];
					else next[key] = value;
				}
			}
			if (scope === "workspace") assertPathInsideRoot(root!, path, true);
			await atomicWrite(path, JSON.stringify(next, null, 2) + "\n", scope === "workspace" ? "shared" : "private");
			return (await this.load()).effective;
		});
	}

	/**
	 * What a settings file holds, to be changed and written back: nothing when it is not there or is empty. As it is
	 * written, not as `load` takes it: a value of the wrong kind is the user's text too, and stays in the file.
	 *
	 * A file that does not read is refused, and no copy of it is put aside to let the save through. The save would
	 * then start a second file from nothing while the user's own lay beside it unused, and mending theirs would no
	 * longer bring their settings back; in a workspace the copy would be one more file to commit by mistake. Refused,
	 * there is one file, it is theirs as they left it, and what is said names it and the place to mend.
	 */
	private async held(path: string): Promise<Partial<Settings>> {
		const { held, wrong } = await readSettings(path);
		if (wrong) throw new Error(`${path} ${wrong}, so it is not written over. Mend it by hand, or remove it, and change the setting again.`);
		return held as Partial<Settings>;
	}

	async themes(): Promise<ThemeFile[]> {
		const dir = join(dirs.config, "themes");
		if (!existsSync(dir)) return [];
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const loaded = await Promise.all(
			entries
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map(async (entry): Promise<ThemeFile | null> => {
					try {
						const json = await Bun.file(join(dir, entry.name)).text();
						const baseId = basename(entry.name, ".json");
						let name = baseId;
						try {
							const parsed = parseJsonc(json);
							if (isPlainObject(parsed) && typeof parsed.name === "string" && parsed.name.trim()) {
								name = parsed.name.trim();
							}
						} catch {
							const match = /"name"\s*:\s*"([^"]+)"/.exec(json);
							if (match?.[1]) name = match[1];
						}
						return { id: `custom:${baseId}`, name, json };
					} catch {
						return null;
					}
				}),
		);
		return loaded.filter((t): t is ThemeFile => t !== null);
	}

	async importTheme(source: string): Promise<ThemeFile> {
		const dir = join(dirs.config, "themes");
		const json = await Bun.file(source).text();
		let parsed: unknown;
		try {
			parsed = parseJsonc(json);
		} catch (e: any) {
			throw new Error(`Theme file ${source} is not valid JSON/JSONC: ${e?.message ?? e}`);
		}
		if (!isPlainObject(parsed)) {
			throw new Error(`Theme file ${source} must contain a JSON object.`);
		}
		const cleaned = basename(source)
			.replace(/\.(json|jsonc)$/i, "")
			.replace(/[^\w.-]+/g, "-")
			.replace(/^\.+/, "")
			.replace(/\.+$/, "");
		const id = !cleaned || cleaned === "." || cleaned === ".." || /^[-.]+$/.test(cleaned) ? "theme" : cleaned;
		await atomicWrite(join(dir, `${id}.json`), json);
		const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : id;
		return { id: `custom:${id}`, name, json };
	}
}

const recentSaves = new Serial();

/** Recently opened workspaces, newest first. */
export async function recent(add?: string): Promise<string[]> {
	return recentSaves.run("recent", async () => {
		const path = join(dirs.state, "recent.json");
		const raw = await readJson<unknown[]>(path, [], Array.isArray);
		let list = raw.filter((p): p is string => typeof p === "string" && p.length > 0);
		if (add) {
			list = [add, ...list.filter((p) => p !== add)].slice(0, 10);
			await atomicWrite(path, JSON.stringify(list, null, 2) + "\n");
		}
		return list.filter((p) => existsSync(p));
	});
}
