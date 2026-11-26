// The code editor's keys as the user has changed them (shared/editorKeymap.ts, ADR 0039).
//
// The keys the editor comes with are read from the editor itself, once, after Sublime Text's have been put in
// (monaco.ts, `setEditorKeys`) and before any change of the user's. A change is then a rule in the editor's own
// list of keys: the old command taken off the key, the new one put on it. The editor goes on deciding what a
// press does, so a key of two presses, a command that needs a writable file and the keys shown in the command
// list (F1) all follow without being worked out here. Sublime Text's keys are not the editor's own, and a rule
// does not take them off: they are put in again without the ones that changed (`applyEditorKeys`).
import { editorHasKey, editorKeyCode, editorKeyName, editorKeyRules, editorOverrides, isEditorCommand, pressesOf, pressShown, type EditorChord, type EditorKeys } from "../../shared/editorKeymap";
import { bindable, displayKey, effectiveKeys, keysOf } from "../keys";
import { state } from "../state";
import { monaco, setEditorKeys } from "./monaco";

const onMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/** One entry of the editor's list of keys, as far as it is read here. */
type KeyItem = { command: string | null; when?: { serialize(): string } | null; resolvedKeybinding?: { getChords(): EditorChord[] } | null };
/** The editor has no public way to ask for its keys: this is the service the menu bar reads a key's label from. */
type KeyService = { getKeybindings(): readonly KeyItem[] };

/** The keys the editor came with for the listed commands, and where each command's own key works. */
let base: { keys: Record<string, string>; when: Record<string, string> } | null = null;

/**
 * Reads the keys the editor comes with. To be called once at start, after `setEditorKeys` and before
 * `applyEditorKeys`: read later, the list would hold the user's changes too, and they would be taken for keys the
 * editor came with.
 *
 * The list is an editor's to give, so where none is open yet one is made for the reading, with no file in it and
 * not on the screen, and thrown away. False where the editor would not say: the editor's keys are then as they
 * came, and Settings does not list them.
 */
export function readEditorKeys(): boolean {
	if (base) return true;
	let made: monaco.editor.IStandaloneCodeEditor | undefined;
	try {
		const open = monaco.editor.getEditors()[0];
		if (!open) made = monaco.editor.create(document.createElement("div"), { model: null });
		const service = ((open ?? made) as unknown as { _standaloneKeybindingService?: KeyService | null })._standaloneKeybindingService;
		const items = service?.getKeybindings();
		if (!items?.length) return false;
		const keys: Record<string, string> = {};
		const when: Record<string, string> = {};
		for (const item of items) {
			const command = item.command;
			if (!command || !isEditorCommand(command)) continue;
			const name = editorKeyName(item.resolvedKeybinding?.getChords() ?? [], onMac);
			// A key that could not be a shortcut (Enter in the find box, for "find next") is not one to list or change.
			if (!name || !bindable(pressesOf(name)[0]!).ok) continue;
			keys[name] = command;
			when[command] ??= item.when?.serialize() ?? "";
		}
		base = { keys, when };
		return true;
	} catch {
		return false;
	} finally {
		made?.dispose();
	}
}

/** The keys the editor came with, by key. Null until they have been read. */
export const baseEditorKeys = (): EditorKeys | null => base?.keys ?? null;

/** The user's changes to the editor's keys, as far as they mean something. */
export const editorKeyChanges = () => editorOverrides(state.settings.editorKeys);

/** The editor's keys with the user's changes. Null until the editor's own have been read. */
export const editorKeysNow = (): EditorKeys | null => (base ? effectiveKeys(base.keys, editorKeyChanges()) : null);

/** The editor's number for a key named as the shell names it, or null where it has none. */
function keybindingOf(name: string): number | null {
	const { KeyMod: M, KeyCode: K } = monaco;
	const numbers = pressesOf(name).map((press) => {
		const key = editorKeyCode(press);
		const code = key ? (K as unknown as Record<string, number | undefined>)[key.code] : undefined;
		if (!key || code === undefined) return null;
		// Off a Mac "ctrl" is the one such key. On a Mac "cmd" is Cmd and "ctrl" the Ctrl key itself.
		const first = onMac ? (key.cmd ? M.CtrlCmd : 0) | (key.ctrl ? M.WinCtrl : 0) : key.ctrl || key.cmd ? M.CtrlCmd : 0;
		return first | (key.alt ? M.Alt : 0) | (key.shift ? M.Shift : 0) | code;
	});
	if (numbers.some((n) => n === null) || numbers.length < 1 || numbers.length > 2) return null;
	return numbers.length === 2 ? M.chord(numbers[0]!, numbers[1]!) : numbers[0]!;
}

let appliedChanges = "{}";

/**
 * Makes the editor's keys what the settings say: at start, and whenever the setting changes.
 *
 * A key the editor came with itself is taken from its command by a rule. One of Sublime Text's, put in by
 * `setEditorKeys`, is not: the editor passes such a rule over. So those keys are put in again without the ones
 * the user changed, and the user's rules with them, as one set that the next change takes out whole. A change
 * undone in Settings is so undone in the editor.
 */
export function applyEditorKeys() {
	if (!base) return;
	const changes = editorKeyChanges();
	const written = JSON.stringify(changes);
	if (written === appliedChanges) return;
	/** What the user has on each key they changed, by the editor's number for the key: "" for a key let go. */
	const changed = new Map<number, string>();
	for (const [key, command] of Object.entries(changes)) {
		const keybinding = keybindingOf(key);
		if (keybinding !== null) changed.set(keybinding, command);
	}
	const rules = editorKeyRules(base.keys, base.when, changes).flatMap((rule) => {
		const keybinding = keybindingOf(rule.key);
		return keybinding === null ? [] : [{ keybinding, command: rule.command, when: rule.when || undefined }];
	});
	setEditorKeys((keybinding, command) => changed.has(keybinding) && changed.get(keybinding) !== command, rules);
	appliedChanges = written;
}

/** What the shell has on a key, as `editorHasKey` asks it: its command there, and whether the user put it there. */
export type ShellKeys = { map: Readonly<Record<string, string>>; chosen: Readonly<Record<string, string>> };

const shellOn = (name: string, shell: ShellKeys) => ({
	shell: shell.map[name],
	shellChosen: Object.entries(shell.chosen).some(([key, id]) => Boolean(id) && key.toLowerCase() === name),
});

/**
 * Whether a press in the code editor's text is the editor's to take, rather than the shell's. Undefined where the
 * editor's keys could not be read: the shell then does as it did before they could be changed.
 */
export function editorTakesKey(pressed: readonly string[], shell: ShellKeys): boolean | undefined {
	const now = editorKeysNow();
	if (!now) return undefined;
	const chosen = editorKeyChanges();
	// On a Mac a press with Cmd goes by a second name too, with "ctrl" for the shell's shared keys: not the editor's.
	return (onMac ? pressed.slice(0, 1) : pressed).some((name) => editorHasKey(name, { now, chosen, ...shellOn(name, shell), mac: onMac }));
}

/**
 * The keys that run one of the editor's commands while code is edited, in the editor's own order. A key the shell
 * has there (the user gave it to a shell command) is left out: pressed in the editor it does not run this.
 */
export function editorKeysOf(id: string, shell: ShellKeys): string[] {
	const now = editorKeysNow();
	if (!now) return [];
	const chosen = editorKeyChanges();
	return keysOf(id, now).filter((name) => editorHasKey(name, { now, chosen, ...shellOn(name, shell), mac: onMac }));
}

/** One of the editor's keys as it is shown: "Ctrl+J", and "Ctrl+K Ctrl+U" for a key of two presses. */
export const displayEditorKey = (name: string) => pressesOf(name).map((press) => displayKey(pressShown(press))).join(" ");
