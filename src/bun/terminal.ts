// Backend integrated terminal manager: detects installed host shells, spawns real
// POSIX PTYs (via python3 pty/termios/TIOCSWINSZ) with a clean piped fallback for
// Windows or environments without python3, coalesces burst output, and guarantees
// leak-free teardown on kill, workspace switch, or backend disposal.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Subprocess } from "bun";
import {
	clampTerminalSize,
	shortShellName,
	type TerminalCreateRequest,
	type TerminalInfo,
	type TerminalProfile,
} from "../shared/terminal";

/**
 * Self-contained POSIX PTY bridge run under `python3 -u -c`.
 * - stdin: newline-delimited JSON commands from Bun:
 *     {"t":"i","b":"<base64>"}  -> raw bytes written to master PTY
 *     {"t":"r","c":cols,"r":rows} -> TIOCSWINSZ + SIGWINCH to child process group
 * - stdout: raw bytes read from master PTY (unmodified, full VT100/ANSI/truecolor)
 * - exit code: matches the child shell's exit code.
 */
const PY_PTY_BRIDGE = String.raw`
import base64, errno, fcntl, json, os, pty, select, signal, struct, sys, termios

def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass

def write_all(fd, data):
    view = memoryview(data)
    total = 0
    while total < len(view):
        try:
            n = os.write(fd, view[total:])
            if n <= 0:
                break
            total += n
        except BlockingIOError:
            select.select([], [fd], [], 0.05)
        except InterruptedError:
            continue
        except OSError:
            break

def main():
    cols = int(sys.argv[1])
    rows = int(sys.argv[2])
    shell = sys.argv[3]
    args = sys.argv[4:]

    master, slave = pty.openpty()
    set_winsize(slave, rows, cols)

    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        try:
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        except OSError:
            pass
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
        try:
            os.execvp(shell, [shell] + args)
        except OSError as exc:
            sys.stderr.write(f"Failed to launch {shell}: {exc}\n")
            os._exit(127)

    os.close(slave)
    os.set_blocking(master, False)
    stdin_fd = sys.stdin.fileno()
    os.set_blocking(stdin_fd, False)

    def forward_term(_signum, _frame):
        try:
            os.killpg(pid, signal.SIGHUP)
        except OSError:
            pass
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass

    signal.signal(signal.SIGTERM, forward_term)
    signal.signal(signal.SIGHUP, forward_term)

    in_buf = bytearray()
    stdin_open = True
    master_open = True

    while master_open:
        watch = [master]
        if stdin_open:
            watch.append(stdin_fd)
        try:
            rlist, _, _ = select.select(watch, [], [], 0.25)
        except InterruptedError:
            continue
        except OSError:
            break

        if master in rlist:
            try:
                chunk = os.read(master, 8192)
                if not chunk:
                    master_open = False
                else:
                    write_all(1, chunk)
            except BlockingIOError:
                pass
            except OSError as exc:
                if exc.errno in (errno.EIO, errno.EBADF):
                    master_open = False
                else:
                    master_open = False

        if stdin_open and stdin_fd in rlist:
            try:
                data = os.read(stdin_fd, 8192)
                if not data:
                    stdin_open = False
                    forward_term(None, None)
                else:
                    in_buf.extend(data)
                    while True:
                        nl = in_buf.find(b"\n")
                        if nl < 0:
                            break
                        line = bytes(in_buf[:nl])
                        del in_buf[:nl + 1]
                        if not line:
                            continue
                        try:
                            msg = json.loads(line.decode("utf-8"))
                        except Exception:
                            continue
                        kind = msg.get("t")
                        if kind == "i":
                            raw = base64.b64decode(msg.get("b", ""))
                            if raw:
                                write_all(master, raw)
                        elif kind == "r":
                            c = max(20, min(400, int(msg.get("c", cols))))
                            r = max(4, min(150, int(msg.get("r", rows))))
                            set_winsize(master, r, c)
                            try:
                                os.killpg(pid, signal.SIGWINCH)
                            except OSError:
                                pass
            except BlockingIOError:
                pass
            except OSError:
                stdin_open = False

        if not master_open:
            break

    try:
        os.close(master)
    except OSError:
        pass

    code = 0
    try:
        _, status = os.waitpid(pid, 0)
        if os.WIFEXITED(status):
            code = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            code = 128 + os.WTERMSIG(status)
    except OSError:
        code = 0
    sys.exit(code)

if __name__ == "__main__":
    main()
`;

let cachedPythonPath: string | null | undefined;
function findPython3(): string | null {
	if (process.platform === "win32") return null;
	if (cachedPythonPath !== undefined) return cachedPythonPath;
	cachedPythonPath = Bun.which("python3") ?? null;
	return cachedPythonPath;
}

/** Discovers installed interactive shells on the host OS, placing the user's default shell first. */
export function detectShellProfiles(): TerminalProfile[] {
	const profiles: TerminalProfile[] = [];
	const seen = new Set<string>();
	const add = (id: string, label: string, shell: string, args?: string[], isDefault = false) => {
		const key = `${id.toLowerCase()}|${shell.toLowerCase()}`;
		if (seen.has(key)) return;
		if (profiles.some((p) => p.id === id)) return;
		seen.add(key);
		profiles.push({ id, label, shell, ...(args?.length ? { args } : {}), ...(isDefault ? { isDefault: true } : {}) });
	};

	if (process.platform === "win32") {
		const pwsh = Bun.which("pwsh.exe") ?? Bun.which("pwsh");
		const powershell = Bun.which("powershell.exe") ?? Bun.which("powershell");
		const cmd = process.env.ComSpec || Bun.which("cmd.exe") || "cmd.exe";
		const gitBashPaths = [
			"C:\\Program Files\\Git\\bin\\bash.exe",
			"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
		];
		const gitBash = gitBashPaths.find((p) => existsSync(p));
		if (pwsh) add("pwsh", "PowerShell", pwsh, ["-NoLogo"], true);
		if (powershell) add("powershell", "Windows PowerShell", powershell, ["-NoLogo"], profiles.length === 0);
		if (gitBash) add("git-bash", "Git Bash", gitBash, ["--login", "-i"], profiles.length === 0);
		add("cmd", "Command Prompt", cmd, [], profiles.length === 0);
		return profiles;
	}

	const envShell = process.env.SHELL?.trim();
	if (envShell && existsSync(envShell)) {
		const name = shortShellName(envShell);
		add(name, name, envShell, name === "bash" || name === "zsh" ? ["-i"] : [], true);
	}

	const candidates: { id: string; label: string; paths: string[]; args?: string[] }[] = [
		{ id: "bash", label: "bash", paths: ["/bin/bash", "/usr/bin/bash"], args: ["-i"] },
		{ id: "zsh", label: "zsh", paths: ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"], args: ["-i"] },
		{ id: "fish", label: "fish", paths: ["/usr/bin/fish", "/usr/local/bin/fish", "/opt/homebrew/bin/fish"] },
		{ id: "sh", label: "sh", paths: ["/bin/sh", "/usr/bin/sh"] },
	];

	for (const cand of candidates) {
		const found = cand.paths.find((p) => existsSync(p)) ?? Bun.which(cand.id);
		if (found) add(cand.id, cand.label, found, cand.args, profiles.length === 0);
	}

	if (profiles.length === 0) {
		add("sh", "sh", "/bin/sh", [], true);
	}
	return profiles;
}

type ManagedSession = {
	info: TerminalInfo;
	proc: Subprocess<"pipe", "pipe", "pipe">;
	pty: boolean;
	pendingText: string;
	flushTimer: ReturnType<typeof setTimeout> | undefined;
	disposed: boolean;
};

const MAX_TERMINALS = 12;
const FLUSH_INTERVAL_MS = 6;
const FLUSH_MAX_CHARS = 16 * 1024;

export type TerminalCallbacks = {
	onData: (id: string, data: string) => void;
	onExit: (id: string, exitCode: number | null, signal?: string | null) => void;
};

export class TerminalManager {
	private sessions = new Map<string, ManagedSession>();
	private seq = 0;

	constructor(private readonly callbacks: TerminalCallbacks) {}

	profiles(): TerminalProfile[] {
		return detectShellProfiles();
	}

	list(): TerminalInfo[] {
		return [...this.sessions.values()].map((s) => ({ ...s.info }));
	}

	create(req: TerminalCreateRequest = {}, defaultCwd?: string): TerminalInfo {
		const aliveCount = [...this.sessions.values()].filter((s) => s.info.alive).length;
		if (aliveCount >= MAX_TERMINALS) {
			throw new Error(`Maximum of ${MAX_TERMINALS} active terminals reached. Close an existing terminal first.`);
		}

		const profiles = this.profiles();
		const profile = (req.profileId ? profiles.find((p) => p.id === req.profileId) : undefined) ?? profiles[0]!;
		const { cols, rows } = clampTerminalSize(req.cols ?? 80, req.rows ?? 24);
		const cwd = req.cwd && existsSync(req.cwd) ? req.cwd : defaultCwd && existsSync(defaultCwd) ? defaultCwd : homedir();
		const id = `term-${++this.seq}`;
		const title = req.title?.trim() || profile.label;

		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (typeof v === "string") env[k] = v;
		}
		env.TERM = "xterm-256color";
		env.COLORTERM = "truecolor";
		env.TERM_PROGRAM = "SSL Studio";
		if (!env.LANG && process.platform !== "win32") env.LANG = "en_US.UTF-8";

		const python = findPython3();
		const usePty = Boolean(python);
		const cmd = usePty
			? [python!, "-u", "-c", PY_PTY_BRIDGE, String(cols), String(rows), profile.shell, ...(profile.args ?? [])]
			: [profile.shell, ...(profile.args ?? [])];

		const proc = Bun.spawn(cmd, {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		const info: TerminalInfo = {
			id,
			title,
			profileId: profile.id,
			shell: profile.shell,
			cwd,
			pid: proc.pid,
			pty: usePty,
			alive: true,
			exitCode: null,
		};

		const session: ManagedSession = {
			info,
			proc,
			pty: usePty,
			pendingText: "",
			flushTimer: undefined,
			disposed: false,
		};
		this.sessions.set(id, session);

		const flush = () => {
			if (session.flushTimer !== undefined) {
				clearTimeout(session.flushTimer);
				session.flushTimer = undefined;
			}
			if (!session.pendingText) return;
			const payload = session.pendingText;
			session.pendingText = "";
			this.callbacks.onData(id, payload);
		};

		const enqueue = (text: string) => {
			if (!text || session.disposed) return;
			session.pendingText += text;
			if (session.pendingText.length >= FLUSH_MAX_CHARS) {
				flush();
			} else if (session.flushTimer === undefined) {
				session.flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
			}
		};

		const pump = async (stream: ReadableStream<Uint8Array>, normalizeLf: boolean) => {
			const decoder = new TextDecoder("utf-8");
			const reader = stream.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					let text = decoder.decode(value, { stream: true });
					if (normalizeLf) text = text.replace(/\r?\n/g, "\r\n");
					enqueue(text);
				}
				const tail = decoder.decode();
				if (tail) enqueue(normalizeLf ? tail.replace(/\r?\n/g, "\r\n") : tail);
			} catch {
				// Stream closed during teardown.
			} finally {
				reader.releaseLock();
			}
		};

		const stdoutDone = pump(proc.stdout, !usePty);
		const stderrDone = pump(proc.stderr, true);

		void Promise.allSettled([stdoutDone, stderrDone, proc.exited]).then(() => {
			flush();
			if (!session.info.alive) return;
			session.info.alive = false;
			session.info.exitCode = proc.exitCode ?? null;
			if (!session.disposed) {
				this.callbacks.onExit(id, session.info.exitCode, proc.signalCode == null ? null : String(proc.signalCode));
			}
		});

		return { ...info };
	}

	write(id: string, data: string): void {
		const session = this.sessions.get(id);
		if (!session || !session.info.alive || session.disposed) return;
		try {
			if (session.pty) {
				const encoded = Buffer.from(data, "utf8").toString("base64");
				session.proc.stdin.write(`${JSON.stringify({ t: "i", b: encoded })}\n`);
			} else {
				session.proc.stdin.write(data.replace(/\r/g, "\n"));
			}
		} catch {
			// Process stdin already closed.
		}
	}

	resize(id: string, cols: number, rows: number): void {
		const session = this.sessions.get(id);
		if (!session || !session.info.alive || session.disposed || !session.pty) return;
		const clamped = clampTerminalSize(cols, rows);
		try {
			session.proc.stdin.write(`${JSON.stringify({ t: "r", c: clamped.cols, r: clamped.rows })}\n`);
		} catch {
			// Process stdin already closed.
		}
	}

	kill(id: string): void {
		const session = this.sessions.get(id);
		if (!session) return;
		this.sessions.delete(id);
		this.terminate(session);
	}

	disposeAll(): void {
		const all = [...this.sessions.values()];
		this.sessions.clear();
		for (const session of all) this.terminate(session);
	}

	private terminate(session: ManagedSession): void {
		session.disposed = true;
		session.info.alive = false;
		if (session.flushTimer !== undefined) {
			clearTimeout(session.flushTimer);
			session.flushTimer = undefined;
		}
		session.pendingText = "";
		try {
			session.proc.stdin.end();
		} catch {
			// Already closed.
		}
		try {
			session.proc.kill("SIGTERM");
		} catch {
			// Already exited.
		}
		const proc = session.proc;
		const timer = setTimeout(() => {
			if (proc.exitCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {
					// Already exited.
				}
			}
		}, 1200);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
	}
}
