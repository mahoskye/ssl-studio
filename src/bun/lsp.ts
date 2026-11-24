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
		this.lastError = "";
		this.onState({ state: "starting" });
		let proc: Subprocess<"pipe", "pipe", "pipe">;
		try {
			proc = Bun.spawn([this.path, "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		} catch (err: any) {
			this.proc = undefined;
			const msg = String(err?.message ?? err).slice(-500);
			this.lastError = msg;
			this.onState({ state: "failed", message: `Failed to start starlims-lsp: ${msg}`.trim() });
			return;
		}
		this.proc = proc;
		const read = createFrameReader((body) => {
			if (proc !== this.proc || this.stopping) return;
			try {
				this.onMessage(body);
			} catch (err: any) {
				if (proc === this.proc && !this.stopping) this.lastError = String(err?.message ?? err).slice(-500);
			}
		});
		(async () => {
			try {
				for await (const chunk of proc.stdout) {
					if (proc !== this.proc || this.stopping) break;
					try {
						read(chunk);
					} catch (err: any) {
						if (proc === this.proc && !this.stopping) this.lastError = String(err?.message ?? err).slice(-500);
					}
				}
			} catch {
				// Stream closed on process exit/stop.
			}
		})();
		(async () => {
			try {
				// The server logs to stderr; keep the tail for crash messages.
				for await (const chunk of proc.stderr) {
					if (proc !== this.proc || this.stopping) break;
					this.lastError = new TextDecoder().decode(chunk).slice(-500);
				}
			} catch {
				// Stream closed on process exit/stop.
			}
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
			const errorTail = this.lastError;
			this.proc = undefined;
			this.onState({ state: "failed", message: `starlims-lsp exited ${code} ${MAX_RESTARTS + 1} times in a minute. ${errorTail}`.trim() });
			return;
		}
		this.onState({ state: "restarting", message: `starlims-lsp exited ${code}; restarting.` });
		this.start();
	}

	send(message: string) {
		if (!this.proc || this.stopping) return;
		try {
			const written = this.proc.stdin.write(frame(message));
			if (written && typeof (written as any).catch === "function") (written as Promise<unknown>).catch(() => {});
		} catch (err: any) {
			if (!this.stopping) this.lastError = String(err?.message ?? err).slice(-500);
		}
	}

	restart() {
		this.crashes = [];
		this.stop();
		this.start();
	}

	stop() {
		this.stopping = true;
		const proc = this.proc;
		this.proc = undefined;
		try {
			proc?.kill();
		} catch {
			// Process already exited.
		}
		this.onState({ state: "stopped" });
	}
}
