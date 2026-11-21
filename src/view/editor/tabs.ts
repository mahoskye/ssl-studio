// What a tab says: pure, so it can be tested without an editor.
import { baseName, dirName, relativeTo } from "../../shared/paths";

/**
 * Two open files with one name (README.md in the root and in docs) each add
 * the folder they are in, so the tabs can be told apart.
 */
export function tabLabels(tabs: string[], root?: string | null): Map<string, string> {
	const labels = new Map<string, string>();
	for (const path of tabs) {
		if (path.startsWith("untitled:")) {
			labels.set(path, path.slice("untitled:".length));
			continue;
		}
		if (!tabs.some((other) => other !== path && baseName(other) === baseName(path))) {
			labels.set(path, baseName(path));
			continue;
		}
		const folder = relativeTo(root, dirName(path));
		const where = root && (folder === "" || folder === ".") ? baseName(root) : folder.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
		labels.set(path, `${baseName(path)} · ${where}`);
	}
	return labels;
}
