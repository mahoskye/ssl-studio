// VS Code-style searchable Language Mode QuickPick (ADR 0032): switches syntax
// highlighting, comment/bracket rules, formatting, and LSP tracking for the
// active code/text buffer.
import { buildLanguagePickerEntries, languageFor, languageName } from "../../shared/languages";
import { quickPick } from "../dialogs";
import { activeDoc, activePath, displayName, notify, setDocumentLanguage } from "../state";

export async function pickLanguageMode(): Promise<void> {
	const path = activePath();
	const doc = activeDoc();
	if (!path || !doc || doc.binary) {
		notify("Open a text or code file to change its language mode.");
		return;
	}
	const currentId = doc.model.getLanguageId();
	const detectedId = languageFor(path);
	const entries = buildLanguagePickerEntries(currentId, detectedId);
	const hasAuto = Boolean(entries[0]?.isAutoDetect);
	const picked = await quickPick<string>({
		title: `Select Language Mode — ${displayName(path)}`,
		placeholder: `Type a language name or extension (current: ${languageName(currentId)})…`,
		empty: "No matching language.",
		items: entries.map((e, index) => ({
			label: e.label,
			value: e.id,
			detail: e.detail,
			keywords: e.keywords,
			icon: e.isAutoDetect ? "sparkle" : "code",
			badge: e.current
				? { text: "current", tone: "active" }
				: e.detected && !e.isAutoDetect
					? { text: "detected", tone: "waiting" }
					: undefined,
			divide: hasAuto && index === 1,
		})),
	});
	if (!picked || picked === currentId) return;
	if (setDocumentLanguage(path, picked)) {
		notify(`Language mode set to ${languageName(picked)}.`);
	}
}
