// User settings in ~/.config/ssl-studio, then the project's own
// (.ssl-studio/project.toml), then what the IDE saved for this workspace
// (.ssl-studio/settings.json): each later one wins.
import { mkdirSync, readdirSync, existsSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch, type SettingsScope, type ThemeFile } from "../shared/protocol";
import { HOUSE_STYLE } from "../shared/styleProfile";
import { dirs, workspaceDir } from "./paths";
import { projectSettings, readProject } from "./project";
import { Serial } from "./serial";

async function readJson<T>(path: string, fallback: T): Promise<T> {
	try {
		return (await Bun.file(path).json()) as T;
	} catch {
		return fallback;
	}
}

export function merge(...layers: Partial<Settings>[]): Settings {
	const result: any = structuredClone(DEFAULT_SETTINGS);
	for (const layer of layers) {
		for (const [key, value] of Object.entries(layer)) {
			if (value === undefined) continue;
			result[key] = key === "ssl" ? deepMerge(result[key], value) : value && typeof value === "object" && !Array.isArray(value) ? { ...result[key], ...value } : value;
		}
	}
	result.ssl = deepMerge(result.stylePreset === "server" ? {} : HOUSE_STYLE, result.ssl);
	return result;
}

function deepMerge(base: any, over: any): any {
	if (!over || typeof over !== "object" || Array.isArray(over)) return over;
	const out: any = { ...(base ?? {}) };
	for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
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
		const user = await readJson<Partial<Settings>>(this.path("user"), {});
		const root = this.root();
		const workspace = root ? await readJson<Partial<Settings>>(this.path("workspace"), {}) : {};
		const project = root ? projectSettings(await readProject(root)) : {};
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
			mkdirSync(join(path, ".."), { recursive: true });
			// A value of null takes the setting out of this file, so the layer below shows through.
			// (undefined cannot say it: it does not survive the trip from the view.)
			const next: Record<string, unknown> = { ...current, ...patch };
			for (const [key, value] of Object.entries(next)) if (value === null) delete next[key];
			const temp = `${path}.ssl-studio-tmp`;
			await Bun.write(temp, JSON.stringify(next, null, 2) + "\n");
			renameSync(temp, path);
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
		if (!read || typeof read !== "object" || Array.isArray(read)) throw new Error(`${path} does not hold settings (it is not a list of names and values), so it is not written over. Mend it by hand, or remove it, and change the setting again.`);
		return read as Partial<Settings>;
	}

	async themes(): Promise<ThemeFile[]> {
		const dir = join(dirs.config, "themes");
		if (!existsSync(dir)) return [];
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		return Promise.all(
			files.map(async (file) => {
				const json = await Bun.file(join(dir, file)).text();
				const name = /"name"\s*:\s*"([^"]+)"/.exec(json)?.[1] ?? basename(file, ".json");
				return { id: `custom:${basename(file, ".json")}`, name, json };
			}),
		);
	}

	async importTheme(source: string): Promise<ThemeFile> {
		const dir = join(dirs.config, "themes");
		mkdirSync(dir, { recursive: true });
		const json = await Bun.file(source).text();
		const id = basename(source).replace(/\.(json|jsonc)$/i, "").replace(/[^\w.-]+/g, "-");
		await Bun.write(join(dir, `${id}.json`), json);
		return (await this.themes()).find((t) => t.id === `custom:${id}`)!;
	}
}

/** Recently opened workspaces, newest first. */
export async function recent(add?: string): Promise<string[]> {
	const path = join(dirs.state, "recent.json");
	let list = await readJson<string[]>(path, []);
	if (add) {
		list = [add, ...list.filter((p) => p !== add)].slice(0, 10);
		mkdirSync(dirs.state, { recursive: true });
		await Bun.write(path, JSON.stringify(list, null, 2));
	}
	return list.filter((p) => existsSync(p));
}
