// Owns the starlims-lsp process for the open workspace: start, pipe
// messages, restart on crash (ARCHITECTURE, "Language features").
import type { Subprocess } from "bun";
import type { LspState } from "../shared/protocol";
import { createFrameReader, frame } from "./frames";
import { lspCommand, verbatim } from "./tools";

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
/** How long a server told to stop has to go by itself. */
const STOP_GRACE_MS = 2000;

/** Servers told to stop that have not gone yet. */
const lingering = new Set<Subprocess>();
let exiting = false;

/** Whether Bun has seen the process end. Until then its id is still its own; after, the id may be another process's. */
function ended(proc: Subprocess): boolean {
	return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * The command that ends a server together with what it started, or null where ending the server's own process
 * ends all of it. On Windows a `.cmd` shim is run by cmd.exe and the server is cmd's child: the process held here
 * is cmd.exe, killing it ended cmd.exe alone, and the server lived on, one more for each restart. `taskkill /T`
 * ends the whole tree, as the agent's opencode is ended.
 */
export function treeKillCommand(command: readonly string[], pid: number | undefined, platform: string = process.platform): string[] | null {
	if (platform !== "win32" || !pid || !/^cmd(?:\.exe)?$/i.test(command[0] ?? "")) return null;
	return ["taskkill", "/T", "/F", "/PID", String(pid)];
}

/** How a server's tree is ended: as on which system, and what runs the command that does it. */
export type TreeKill = { platform: string; run: (command: string[]) => boolean };

const SYSTEM_TREE_KILL: TreeKill = {
	platform: process.platform,
	run: (command) => Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0,
};

/** What each server was started with, and how its tree is ended, until it has been. */
const trees = new WeakMap<Subprocess, { command: readonly string[]; how: TreeKill }>();

/**
 * Ends a server that has a tree (`treeKillCommand`) with its tree, and says whether that was done. The command
 * names the process by its id, so it is run only while Bun has not seen the process end: until then the id is its own.
 */
function endTree(proc: Subprocess): boolean {
	const tree = trees.get(proc);
	if (!tree || ended(proc)) return false;
	const command = treeKillCommand(tree.command, proc.pid, tree.how.platform);
	if (!command) return false;
	try {
		if (!tree.how.run(command)) return false;
	} catch {
		return false;
	}
	// Done once: asked again, a tree that is gone is only an error to wait for.
	trees.delete(proc);
	return true;
}

/**
 * Kills outright, and only while the process is still there: with its tree where it has one, else through the
 * process's own handle. Never by a process id that may be another's by now.
 */
function kill(proc: Subprocess) {
	lingering.delete(proc);
	if (ended(proc)) return;
	if (endTree(proc)) return;
	try {
		proc.kill("SIGKILL");
	} catch {
		// Process already exited.
	}
}

// No timer runs once the backend is exiting, so a server still in its grace period is killed there and then.
process.on("exit", () => {
	exiting = true;
	for (const proc of [...lingering]) kill(proc);
});

/**
 * Sees that a server told to stop does stop. One that ignores the request (a closed input and SIGTERM) was
 * forgotten and lived on, one more for each restart. It has a grace period, then it is killed. Neither the wait
 * nor the server holds the backend open: the timer and the process are both let go of.
 */
function killAfter(proc: Subprocess, graceMs: number) {
	if (ended(proc)) return;
	if (exiting) return kill(proc);
	lingering.add(proc);
	const timer = setTimeout(() => kill(proc), graceMs);
	timer.unref?.();
	proc.unref();
	void proc.exited.finally(() => {
		clearTimeout(timer);
		lingering.delete(proc);
	});
}

export class LspProcess {
	private proc?: Subprocess<"pipe", "pipe", "pipe">;
	private crashes: number[] = [];
	private stopping = false;

	constructor(
		private path: string,
		private onMessage: (message: string) => void,
		private onState: (state: LspState) => void,
		/** For tests: overrides how long a stopped server has before it is killed (2 s). */
		private stopGraceMs = STOP_GRACE_MS,
		/** For tests: stands in for Windows and its taskkill, where neither is there. */
		private treeKill: TreeKill = SYSTEM_TREE_KILL,
	) {}

	start() {
		this.stopping = false;
		this.lastError = "";
		this.onState({ state: "starting" });
		let proc: Subprocess<"pipe", "pipe", "pipe">;
		try {
			// A shim whose path needs quoting is a line written out for cmd.exe, which Windows must be given as written.
			const command = lspCommand(this.path, ["--stdio"], this.treeKill.platform);
			proc = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsVerbatimArguments: verbatim(command) });
			trees.set(proc, { command, how: this.treeKill });
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
		const stdout = proc.stdout.getReader();
		const stderr = proc.stderr.getReader();
		// A read waiting on a server that says nothing holds the backend open: stop() lets go of both.
		this.release = () => {
			void stdout.cancel().catch(() => {});
			void stderr.cancel().catch(() => {});
		};
		(async () => {
			try {
				for (;;) {
					const { value: chunk, done } = await stdout.read();
					if (done || proc !== this.proc || this.stopping) break;
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
				for (;;) {
					const { value: chunk, done } = await stderr.read();
					if (done || proc !== this.proc || this.stopping) break;
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
	private release?: () => void;

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
			const ended = proc?.stdin.end();
			if (ended && typeof (ended as any).catch === "function") (ended as Promise<unknown>).catch(() => {});
		} catch {
			// Stdin already closed.
		}
		try {
			// Behind a shim on Windows the process held here is cmd.exe: the tree is ended, not cmd.exe alone.
			if (!proc || !endTree(proc)) proc?.kill();
		} catch {
			// Process already exited.
		}
		this.release?.();
		this.release = undefined;
		if (proc) killAfter(proc, this.stopGraceMs);
		this.onState({ state: "stopped" });
	}
}
