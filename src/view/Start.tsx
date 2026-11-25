// What the editor area shows while no file is open: the project by name, and
// the ways into it, each with the keys that do the same. commands.ts imports
// the editors, so it is loaded here when it is needed, not at the top.
import { createResource, For, Show } from "solid-js";
import { baseName } from "../shared/paths";
import { state } from "./state";

/** The commands offered, in the order someone arriving would want them, each with what it is for. "setup-project" is offered only until it is done. */
const WAYS_IN: readonly (readonly [id: string, label: string, what: string])[] = [
	["quick-open", "Go to file…", "By name, ticket key, or #tag"],
	["symbols", "Go to symbol…", "A procedure, ticket, or doc anywhere in the workspace"],
	["docs", "Project docs", "Tickets, specs, decisions, schema and registries"],
	["new-ticket", "New ticket…", "Track work with specs, plans, and linked scripts"],
	["graph", "Call graph", "The scripts and the calls between them"],
	["new-plan", "New plan…", "A flow chart of what to build"],
	["new-doc", "New document…", "In the project's docs"],
	["setup-project", "Set up project", "Settings, README, AGENTS"],
	["command-palette", "All commands", ""],
];

export function Start() {
	const [loaded] = createResource(() => import("./commands"));
	const ways = () => {
		const all = loaded();
		if (!all) return [];
		return WAYS_IN.filter(([id]) => (id !== "setup-project" || !state.project?.configured) && all.commands.some((c) => c.id === id)).map(([id, label, what]) => ({ id, label, what, keys: all.keysFor(id) }));
	};
	const name = () => state.project?.name?.trim() || (state.workspace ? baseName(state.workspace.root) : "SSL Studio");
	return (
		<div class="start">
			<h2>{name()}</h2>
			<p class="hint">{state.project?.description?.trim() || state.workspace?.root}</p>
			<ul class="start-ways" aria-label="Ways in">
				<For each={ways()}>
					{(way) => (
						<li>
							<button onClick={() => loaded()?.runCommand(way.id)}>
								<span class="start-label">{way.label}</span>
								<span class="hint">{way.what}</span>
								<Show when={way.keys}>
									<kbd>{way.keys}</kbd>
								</Show>
							</button>
						</li>
					)}
				</For>
			</ul>
			<p class="hint start-foot">Or open a file from the Explorer.</p>
		</div>
	);
}
