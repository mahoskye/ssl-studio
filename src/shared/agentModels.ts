// Which agent models are local ones: run on this machine, costing nothing. One rule for the backend, which
// refuses a turn on a model that is not local until the user has agreed to it, and for the view, which says
// beside a model's name whether it may cost money and asks for a budget before a build. The view used to know
// only what opencode's list of models said, and that list is empty until opencode has started: a local model
// was then either taken for granted (a paid one with it) or warned about as if it might cost money.

/** Providers that serve models from this machine. */
export const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llama.cpp", "llamacpp", "local"]);

/** Parses and normalizes a `"providerID/modelID"` reference, trimming whitespace and requiring both halves. */
export function parseModelRef(raw: string | undefined): { providerID: string; id: string; normalized: string } | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return null;
	const providerID = trimmed.slice(0, slash).trim();
	const id = trimmed.slice(slash + 1).trim();
	if (!providerID || !id) return null;
	return { providerID, id, normalized: `${providerID.toLowerCase()}/${id.toLowerCase()}` };
}

/** True when a `"providerID/modelID"` reference names a local provider or a user-allowlisted own model. */
export function isLocalModelRef(raw: string | undefined, ownModels?: readonly string[]): boolean {
	const parsed = parseModelRef(raw);
	if (!parsed) return false;
	if (LOCAL_PROVIDERS.has(parsed.providerID.toLowerCase())) return true;
	if (!ownModels?.length) return false;
	for (const entry of ownModels) {
		const own = parseModelRef(entry);
		if (own && own.normalized === parsed.normalized) return true;
	}
	return false;
}
