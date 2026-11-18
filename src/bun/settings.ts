// User settings in ~/.config/ssl-studio, then the project's own
// (.ssl-studio/project.toml), then what the IDE saved for this workspace
// (.ssl-studio/settings.json): each later one wins.
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch, type SettingsScope, type ThemeFile } from "../shared/protocol";
import { HOUSE_STYLE } from "../shared/styleProfile";
import { dirs, workspaceDir } from "./paths";
import { projectSettings, readProject } from "./project";

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

	async save(scope: SettingsScope, patch: SettingsPatch) {
		const path = this.path(scope);
		const current = await readJson<Partial<Settings>>(path, {});
		mkdirSync(join(path, ".."), { recursive: true });
		// A value of null takes the setting out of this file, so the layer below shows through.
		// (undefined cannot say it: it does not survive the trip from the view.)
		const next: Record<string, unknown> = { ...current, ...patch };
		for (const [key, value] of Object.entries(next)) if (value === null) delete next[key];
		await Bun.write(path, JSON.stringify(next, null, 2) + "\n");
		return (await this.load()).effective;
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
