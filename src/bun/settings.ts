// User settings in ~/.config/ssl-studio, workspace overrides in
// <workspace>/.ssl-studio, merged with the workspace winning.
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_SETTINGS, type Settings, type SettingsScope, type ThemeFile } from "../shared/protocol";
import { dirs, workspaceDir } from "./paths";

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
			result[key] =
				value && typeof value === "object" && !Array.isArray(value) ? { ...result[key], ...value } : value;
		}
	}
	return result;
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
		const workspace = this.root() ? await readJson<Partial<Settings>>(this.path("workspace"), {}) : {};
		return { effective: merge(user, workspace), user, workspace };
	}

	async save(scope: SettingsScope, patch: Partial<Settings>) {
		const path = this.path(scope);
		const current = await readJson<Partial<Settings>>(path, {});
		mkdirSync(join(path, ".."), { recursive: true });
		await Bun.write(path, JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
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
