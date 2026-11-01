// Owns the starlims-lsp process for the open workspace: start, pipe
// messages, restart on crash (ARCHITECTURE, "Language features").
import type { Subprocess } from "bun";
import type { LspState } from "../shared/protocol";
import { createFrameReader, frame } from "./frames";

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

export class LspProcess {
	private proc?: Subprocess<"pipe", "pipe", "pipe">;
	private crashes: number[] = [];
	private stopping = false;

	constructor(
		private path: string,
		private onMessage: (message: string) => void,
		private onState: (state: LspState) => void,
	) {}

	start() {
		this.stopping = false;
		this.onState({ state: "starting" });
		const proc = Bun.spawn([this.path, "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.proc = proc;
		const read = createFrameReader(this.onMessage);
		(async () => {
			for await (const chunk of proc.stdout) read(chunk);
		})();
		(async () => {
			// The server logs to stderr; keep the tail for crash messages.
			for await (const chunk of proc.stderr) this.lastError = new TextDecoder().decode(chunk).slice(-500);
		})();
		proc.exited.then((code) => this.exited(proc, code));
		this.onState({ state: "running" });
	}

	private lastError = "";

	private exited(proc: Subprocess, code: number | null) {
		if (proc !== this.proc || this.stopping) return;
		const now = Date.now();
		this.crashes = [...this.crashes.filter((t) => now - t < RESTART_WINDOW_MS), now];
		if (this.crashes.length > MAX_RESTARTS) {
			this.onState({ state: "failed", message: `starlims-lsp exited ${code} ${MAX_RESTARTS + 1} times in a minute. ${this.lastError}`.trim() });
			return;
		}
		this.onState({ state: "restarting", message: `starlims-lsp exited ${code}; restarting.` });
		this.start();
	}

	send(message: string) {
		this.proc?.stdin.write(frame(message));
	}

	restart() {
		this.crashes = [];
		this.stop();
		this.start();
	}

	stop() {
		this.stopping = true;
		this.proc?.kill();
		this.proc = undefined;
		this.onState({ state: "stopped" });
	}
}
