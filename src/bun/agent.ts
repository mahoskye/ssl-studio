// The opencode adapter (ADR 0004). Filled in by milestone M4.
export class Agent {
	constructor(
		readonly emit: (type: string, data: unknown) => void,
		readonly root: () => string | null,
	) {}

	async workspaceChanged() {}

	async call(method: string, _args: unknown[]): Promise<unknown> {
		throw new Error(`agent.${method}: the Agent panel arrives in M4`);
	}

	dispose() {}
}
