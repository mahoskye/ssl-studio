// User settings in ~/.config/ssl-studio, then the project's own
// (.ssl-studio/project.toml), then what the IDE saved for this workspace
// (.ssl-studio/settings.json): each later one wins.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseJsonc } from "../shared/jsonc";
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch, type SettingsScope, type ThemeFile } from "../shared/protocol";
import { HOUSE_STYLE } from "../shared/styleProfile";
import { dirs, workspaceDir } from "./paths";
import { projectSettings, readProject } from "./project";
import { Serial } from "./serial";

/** Settings that control executable paths, remote servers, billing trust, or personal keybindings: never honored from workspace files. */
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

async function atomicWrite(path: string, content: string): Promise<void> {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await Bun.write(temp, content);
		renameSync(temp, path);
	} catch (err) {
		rmSync(temp, { force: true });
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

export function merge(...layers: Partial<Settings>[]): Settings {
	const result: any = structuredClone(DEFAULT_SETTINGS);
	for (const layer of layers) {
		if (!isPlainObject(layer)) continue;
		for (const [key, value] of Object.entries(layer)) {
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
		if (scope === "workspace" && !root) throw new Error("no workspace open");
		return scope === "user" ? join(dirs.config, "settings.json") : join(workspaceDir(root!), "settings.json");
	}

	async load() {
		const user = await readJson<Partial<Settings>>(this.path("user"), {}, isPlainObject);
		const root = this.root();
		const rawWorkspace = root ? await readJson<Partial<Settings>>(this.path("workspace"), {}, isPlainObject) : {};
		const workspace = stripUserOnly(rawWorkspace as Record<string, unknown>);
		const project = root ? stripUserOnly(projectSettings(await readProject(root)) as Record<string, unknown>) : {};
		return { effective: merge(user, project, workspace), user, workspace };
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
		const path = this.path(scope);
		return this.saves.run("settings", async () => {
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
			await atomicWrite(path, JSON.stringify(next, null, 2) + "\n");
			return (await this.load()).effective;
		});
	}

	/** What a settings file holds, to be changed and written back: nothing when it is not there or is empty. */
	private async held(path: string): Promise<Partial<Settings>> {
		if (!existsSync(path)) return {};
		const text = await Bun.file(path).text();
		if (!text.trim()) return {};
		let read: unknown;
		try {
			read = JSON.parse(text);
		} catch (e: any) {
			throw new Error(`${path} does not read as settings (${e?.message ?? e}), so it is not written over. Mend it by hand, or remove it, and change the setting again.`);
		}
		if (!isPlainObject(read)) throw new Error(`${path} does not hold settings (it is not a list of names and values), so it is not written over. Mend it by hand, or remove it, and change the setting again.`);
		return read as Partial<Settings>;
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
