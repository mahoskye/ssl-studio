// The low findings of the pass 4 audit in the backend's processes and transport: the frame reader and two lengths
// that disagree, a language server behind a Windows shim that outlived its stop, the order in which the bundled
// language server and its licence files are put in place, and git's messages read in a language that is not
// English. Each test runs the code it names: real child processes, a real git in a repository made for the test.
// No Windows is run here. What is for Windows alone is tested as far as the decision goes (which command ends the
// server, in which order files move), and with stand-ins this system has: a script in the place of cmd.exe, a
// folder in the place of a program that is running and cannot be replaced.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bundleLsp, putInPlace, type PlaceOps } from "../scripts/bundle-lsp";
import { createFrameReader, frame, MAX_MESSAGE_BYTES } from "../src/bun/frames";
import { Git, gitEnv } from "../src/bun/git";
import { LspProcess, treeKillCommand } from "../src/bun/lsp";
import { LSP_PIN, lspCommand } from "../src/bun/tools";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p4l-proc-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string) => {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const posix = process.platform !== "win32";

async function until(what: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
	const end = Date.now() + ms;
	for (;;) {
		if (await what()) return true;
		if (Date.now() >= end) return false;
		await Bun.sleep(10);
	}
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Sets variables of the process for as long as the work takes, and puts them back. */
async function withEnv<T>(vars: Record<string, string>, work: () => Promise<T>): Promise<T> {
	const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
	Object.assign(process.env, vars);
	try {
		return await work();
	} finally {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// 1. The frame reader: headers that give two lengths give none
// ---------------------------------------------------------------------------------------------------------------

describe("the LSP frame reader and headers with more than one length", () => {
	const enc = new TextEncoder();
	const message = (id: number) => frame(JSON.stringify({ id }));
	const read = (chunks: (string | Uint8Array)[]) => {
		const got: string[] = [];
		const feed = createFrameReader((body) => got.push(body));
		for (const chunk of chunks) feed(typeof chunk === "string" ? enc.encode(chunk) : chunk);
		return got;
	};
	const bytewise = (text: string) => [...enc.encode(text)].map((byte) => new Uint8Array([byte]));
	const pieces = (text: string, size: number) => {
		const bytes = enc.encode(text);
		const out: Uint8Array[] = [];
		for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
		return out;
	};
	const after = [JSON.stringify({ id: 9 })];

	test("two lengths that disagree: nothing is read by either, and the frame after them is", () => {
		// Seven bytes follow, as the second line says, and five of them as the first does: neither is a message.
		const stream = "Content-Length: 5\r\nContent-Length: 7\r\n\r\n1234567" + message(9);
		expect(read([stream])).toEqual(after);
		expect(read(bytewise(stream))).toEqual(after);
		for (const size of [3, 7, 13, 16, 17, 19, 40]) expect(read(pieces(stream, size))).toEqual(after);
		// In the other order, with another header between them, in any case, and with a third that agrees with the first.
		expect(read(["Content-Length: 7\r\nContent-Length: 5\r\n\r\n1234567" + message(9)])).toEqual(after);
		expect(read(["Content-Length: 5\r\nContent-Type: application/vscode-jsonrpc\r\ncontent-length: 7\r\n\r\n1234567" + message(9)])).toEqual(after);
		expect(read(["CONTENT-LENGTH: 7\r\nContent-Length: 5\r\nContent-Length: 7\r\n\r\n1234567" + message(9)])).toEqual(after);
		// Between two good frames it costs no message but its own.
		expect(read(bytewise(message(1) + "Content-Length: 5\r\nContent-Length: 7\r\n\r\n1234567" + message(9)))).toEqual([JSON.stringify({ id: 1 }), ...after]);
	});

	test("two lengths that agree are one length", () => {
		expect(read(['Content-Length: 8\r\nContent-Length: 8\r\n\r\n{"id":1}' + message(9)])).toEqual(['{"id":1}', ...after]);
		expect(read(bytewise('Content-Length: 8\r\ncontent-length:8 \r\n\r\n{"id":1}' + message(9)))).toEqual(['{"id":1}', ...after]);
	});

	test("a length that cannot be read is not passed over for one beside it that can", () => {
		// Each of these used to be skipped as if the line were not there, and the seven bytes read by the other line.
		for (const unread of ["5, 7", "-5", "+7", "0x07", "7;", "seven", "", String(MAX_MESSAGE_BYTES + 1), "999999999999999999999"]) {
			for (const headers of [`Content-Length: ${unread}\r\nContent-Length: 7`, `Content-Length: 7\r\nContent-Length: ${unread}`]) {
				const stream = `${headers}\r\n\r\n1234567` + message(9);
				expect({ headers, read: read([stream]) }).toEqual({ headers, read: after });
				expect({ headers, read: read(pieces(stream, 5)) }).toEqual({ headers, read: after });
			}
		}
	});

	test("alone, such a length loses its own message and no other", () => {
		for (const unread of ["5, 7", "-8", "+8", "0x08", "8;", String(MAX_MESSAGE_BYTES + 1)]) {
			expect({ unread, read: read([message(1) + `Content-Length: ${unread}\r\n\r\n{"id":0}` + message(9)]) }).toEqual({ unread, read: [JSON.stringify({ id: 1 }), ...after] });
		}
		// Spaces around a number, and a number with a nought before it, are a number.
		expect(read(['Content-Length:  8 \r\n\r\n{"id":1}', 'Content-Length: 08\r\n\r\n{"id":2}'])).toEqual(['{"id":1}', '{"id":2}']);
	});

	test("a frame that begins in the middle of a line, after bytes that were none, is still found", () => {
		// What holds the resync up: only a refused block's own header lines are passed over, not every length in it.
		expect(read(['Content-Length: abcContent-Length: 8\r\n\r\n{"id":1}' + message(9)])).toEqual(['{"id":1}', ...after]);
		expect(read(['Content-Length: 5\r\nContent-Length: 7\r\n\r\n1234567Content-Length: 8\r\n\r\n{"id":1}'])).toEqual(['{"id":1}']);
		expect(read(bytewise('{"lost":1}Content-Length: 8\r\n\r\n{"id":1}'))).toEqual(['{"id":1}']);
	});

	test("streams with such headers between the frames, cut anywhere: what is read is what was sent, all of it", () => {
		let seed = 4711;
		const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
		const cut = (bytes: Uint8Array) => {
			const out: Uint8Array[] = [];
			for (let at = 0; at < bytes.length; ) {
				const size = 1 + rnd(40);
				out.push(bytes.subarray(at, at + size));
				at += size;
			}
			return out;
		};
		const damaged: ((a: number, b: number) => string)[] = [
			(a, b) => `Content-Length: ${a}\r\nContent-Length: ${b}\r\n\r\n`,
			(a, b) => `Content-Length: ${b}\r\nX-Other: 1\r\ncontent-length: ${a}\r\n\r\n`,
			(a, b) => `Content-Length: ${a}, ${b}\r\nContent-Length: ${b}\r\n\r\n`,
			(a, b) => `Content-Length: ${b}\r\nContent-Length: -${a}\r\n\r\n`,
			(a, b) => `Content-Length: ${MAX_MESSAGE_BYTES + a}\r\nCONTENT-LENGTH: ${b}\r\n\r\n`,
			(a, b) => `Content-Length: ${b}\r\nContent-Length: ${a}\r\nContent-Length: ${b}\r\n\r\n`,
		];
		let frames = 0;
		for (let round = 0; round < 400; round++) {
			const sent: string[] = [];
			let stream = "";
			for (let i = 0; i < 6; i++) {
				if (rnd(2) === 0) {
					const a = 1 + rnd(9);
					const b = a + 1 + rnd(9);
					// As many bytes after the headers as one of their lengths says: a body, by that length alone.
					stream += damaged[rnd(damaged.length)]!(a, b) + "#".repeat(rnd(2) ? a : b);
				}
				const body = JSON.stringify({ id: round * 10 + i, pad: "p".repeat(rnd(30)) });
				sent.push(body);
				stream += frame(body);
			}
			frames += sent.length;
			const got = read(cut(enc.encode(stream)));
			if (got.length !== sent.length || got.some((body, at) => body !== sent[at])) expect({ round, got }).toEqual({ round, got: sent });
		}
		expect(frames).toBe(2400);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. A language server behind a .cmd shim is ended with the cmd.exe that runs it
// ---------------------------------------------------------------------------------------------------------------

/** Says its process id in a frame and ignores SIGTERM and the end of its input. It ends by itself after half a minute. */
const STUBBORN = `
process.on("SIGTERM", () => {});
const body = JSON.stringify({ pid: process.pid });
process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 30_000);
`;

describe("a language server started through a .cmd shim", () => {
	test("the command that ends it: the whole tree on Windows, and none where the process is all there is", () => {
		const shim = lspCommand("C:\\tools\\starlims-lsp.cmd", ["--stdio"], "win32");
		expect(shim[0]).toBe("cmd.exe");
		expect(treeKillCommand(shim, 4711, "win32")).toEqual(["taskkill", "/T", "/F", "/PID", "4711"]);
		// A path that needs quotes is one line written out for cmd.exe: the same process, the same ending.
		const spaced = lspCommand("C:\\Program Files\\lsp\\starlims-lsp.bat", ["--stdio"], "win32");
		expect(spaced.slice(0, 4)).toEqual(["cmd.exe", "/d", "/s", "/c"]);
		expect(treeKillCommand(spaced, 12, "win32")).toEqual(["taskkill", "/T", "/F", "/PID", "12"]);
		expect(treeKillCommand(["CMD", "/c", "x.cmd"], 5, "win32")).toEqual(["taskkill", "/T", "/F", "/PID", "5"]);
		// The server's own program is its own process: ending that is ending all of it.
		expect(treeKillCommand(lspCommand("C:\\tools\\starlims-lsp.exe", ["--stdio"], "win32"), 4711, "win32")).toBeNull();
		// Other systems start a shim as it is, and are left as they were.
		for (const platform of ["linux", "darwin"]) {
			expect(treeKillCommand(lspCommand("/opt/lsp/starlims-lsp.cmd", ["--stdio"], platform), 4711, platform)).toBeNull();
			expect(treeKillCommand(shim, 4711, platform)).toBeNull();
		}
		// No process, no id to name.
		expect(treeKillCommand(shim, undefined, "win32")).toBeNull();
		expect(treeKillCommand(shim, 0, "win32")).toBeNull();
	});

	// What follows runs a script in the place of cmd.exe, which starts the server as its child and waits for it, as
	// cmd.exe does with a shim. It needs /bin/sh, and a path cmd.exe would be given as words of its own.
	const standIn = posix && !/[\s&|<>()^,;="]/.test(base);
	const spawned: number[] = [];
	afterAll(() => {
		for (const pid of spawned) if (alive(pid)) process.kill(pid, "SIGKILL");
	});

	/** A server behind a shim, started as on Windows: the process held is the stand-in for cmd.exe, the server its child. */
	async function shimmed(name: string, taskkill: (command: string[], server: number) => boolean) {
		const dir = fresh(name);
		const cmd = join(dir, "cmd.exe");
		// Called as cmd.exe /d /s /c <shim> <arguments>. Not `exec`: cmd.exe stays, and the server is another process.
		writeFileSync(cmd, '#!/bin/sh\nshift 3\n"$@"\nexit $?\n');
		chmodSync(cmd, 0o755);
		const script = join(dir, "server.js");
		writeFileSync(script, STUBBORN);
		const shim = join(dir, "starlims-lsp.cmd");
		writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
		chmodSync(shim, 0o755);

		const ran: string[][] = [];
		let server = 0;
		const lsp = new LspProcess(
			shim,
			(body) => (server = JSON.parse(body).pid),
			() => {},
			150,
			{
				platform: "win32",
				run: (command) => {
					ran.push(command);
					return taskkill(command, server);
				},
			},
		);
		// There is no cmd.exe to find here: the one line that starts it is pointed at the stand-in.
		const start = Bun.spawn;
		const starts = spyOn(Bun, "spawn").mockImplementation(((command: string[], options: any) => start(command[0] === "cmd.exe" ? [cmd, ...command.slice(1)] : command, options)) as any);
		const held = () => {
			const proc = (lsp as any).proc as { pid: number; kill: (signal?: string) => void; exited: Promise<number> };
			if (proc && !spawned.includes(proc.pid)) spawned.push(proc.pid);
			return proc;
		};
		const started = async (from = 0) => {
			held();
			expect(await until(() => server > 0 && server !== from)).toBe(true);
			spawned.push(server);
			return server;
		};
		return { lsp, ran, held, started, restore: () => starts.mockRestore() };
	}

	/** What taskkill /T /F does, with what this system has: the server and the process that ran it are both ended. */
	const endBoth = (command: string[], server: number) => {
		for (const pid of [server, Number(command[4])]) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		return true;
	};

	test.skipIf(!standIn)(
		"stop() and restart() end the tree, once, and send the process they hold nothing more",
		async () => {
			const { lsp, ran, held, started, restore } = await shimmed("shim-tree", endBoth);
			try {
				lsp.start();
				const first = await started();
				const cmd = held();
				// The process held is not the server: it is what ran the shim, and the server is its child.
				expect(cmd.pid).not.toBe(first);
				const signals: (string | undefined)[] = [];
				cmd.kill = (signal?: string) => void signals.push(signal);

				lsp.restart();
				expect(ran).toEqual([["taskkill", "/T", "/F", "/PID", String(cmd.pid)]]);
				expect(await until(() => !alive(first) && !alive(cmd.pid), 4000)).toBe(true);
				const second = await started(first);
				const next = held();
				expect(next.pid).not.toBe(cmd.pid);
				expect(alive(second)).toBe(true);
				next.kill = (signal?: string) => void signals.push(signal);

				lsp.stop();
				expect(ran).toEqual([
					["taskkill", "/T", "/F", "/PID", String(cmd.pid)],
					["taskkill", "/T", "/F", "/PID", String(next.pid)],
				]);
				expect(await until(() => !alive(second) && !alive(next.pid), 4000)).toBe(true);
				// Well past the grace period: a tree that was ended is not ended again, and neither process was sent a signal.
				await Bun.sleep(400);
				expect(ran.length).toBe(2);
				expect(signals).toEqual([]);
			} finally {
				restore();
			}
		},
		20_000,
	);

	test.skipIf(!standIn)(
		"where the tree cannot be ended the process held is killed as before, which is cmd.exe alone",
		async () => {
			const failures: (() => boolean)[] = [
				() => false,
				() => {
					throw new Error("taskkill is not there");
				},
			];
			for (const [at, failing] of failures.entries()) {
				const { lsp, ran, held, started, restore } = await shimmed(`shim-fallback-${at}`, failing);
				try {
					lsp.start();
					const server = await started();
					const cmd = held();
					const signals: (string | undefined)[] = [];
					const kill = cmd.kill.bind(cmd);
					cmd.kill = (signal?: string) => {
						signals.push(signal);
						return kill(signal);
					};
					lsp.stop();
					expect(ran[0]).toEqual(["taskkill", "/T", "/F", "/PID", String(cmd.pid)]);
					expect(signals[0]).toBeUndefined();
					expect(signals.length).toBeGreaterThan(0);
					await cmd.exited;
					// This is the server that lived on: the process that ran it is gone, and it is not.
					expect(alive(server)).toBe(true);
					process.kill(server, "SIGKILL");
				} finally {
					restore();
				}
			}
		},
		20_000,
	);
});

// ---------------------------------------------------------------------------------------------------------------
// 3. bundle-lsp: the binary is put in place before its licence files, and a failure puts back what was there
// ---------------------------------------------------------------------------------------------------------------

describe("bundle-lsp: the order in which the files are put in place", () => {
	const BIN = "vendor/starlims-lsp.exe";
	const LICENCE = "vendor/STARLIMS-LSP-LICENSE";
	const NOTICES = "vendor/THIRD-PARTY-NOTICES.md";
	const had = { [BIN]: "OLD BINARY", [LICENCE]: "old licence", [NOTICES]: "old notices" };
	const arrived = { [`${BIN}.new`]: "NEW BINARY", [`${LICENCE}.new`]: "licence", [`${NOTICES}.new`]: "notices" };

	/** A folder held in memory, with moves that fail where they are told to, as Windows fails one onto a running program. */
	function disk(files: Record<string, string>, refuses: (from: string, to: string) => boolean = () => false) {
		const held = new Map(Object.entries(files));
		const moves: string[] = [];
		const ops: PlaceOps = {
			exists: (path) => held.has(path),
			copy: (from, to) => void held.set(to, held.get(from)!),
			move: async (from, to) => {
				moves.push(`${from} -> ${to}`);
				if (refuses(from, to)) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM" });
				held.set(to, held.get(from)!);
				held.delete(from);
			},
			remove: (path) => void held.delete(path),
		};
		/** What is in place: the files without those written beside them. */
		const inPlace = () => Object.fromEntries([...held].filter(([path]) => !path.endsWith(".new")).sort());
		return { ops, moves, inPlace };
	}

	test("all three arrive, the binary first, and no copy is left beside them", async () => {
		const { ops, moves, inPlace } = disk({ ...had, ...arrived });
		await putInPlace([BIN, LICENCE, NOTICES], ops);
		expect(moves).toEqual([`${BIN}.new -> ${BIN}`, `${LICENCE}.new -> ${LICENCE}`, `${NOTICES}.new -> ${NOTICES}`]);
		expect(inPlace()).toEqual({ [BIN]: "NEW BINARY", [LICENCE]: "licence", [NOTICES]: "notices" });
	});

	test("a binary that is running and cannot be replaced: no licence file has moved, and the folder is as it was", async () => {
		const { ops, moves, inPlace } = disk({ ...had, ...arrived }, (_from, to) => to === BIN);
		await expect(putInPlace([BIN, LICENCE, NOTICES], ops)).rejects.toThrow(/^Could not put vendor\/starlims-lsp\.exe in place: EPERM: .*\. The folder is as it was\.$/);
		// The one move that was tried is the binary's.
		expect(moves).toEqual([`${BIN}.new -> ${BIN}`]);
		expect(inPlace()).toEqual(had);
	});

	test("a licence file that cannot be moved after the binary was: the old binary and the old licence are put back", async () => {
		for (const stuck of [LICENCE, NOTICES]) {
			const { ops, inPlace } = disk({ ...had, ...arrived }, (from, to) => to === stuck && from.endsWith(".new"));
			await expect(putInPlace([BIN, LICENCE, NOTICES], ops)).rejects.toThrow(`Could not put ${stuck} in place`);
			expect(inPlace()).toEqual(had);
		}
		// With nothing there before, nothing is there after: no binary without its licence files.
		const { ops, inPlace } = disk(arrived, (_from, to) => to === NOTICES);
		await expect(putInPlace([BIN, LICENCE, NOTICES], ops)).rejects.toThrow(/The folder is as it was\.$/);
		expect(inPlace()).toEqual({});
	});

	test("what could not be put back either is said by name, and what was there stays beside it", async () => {
		// The notices cannot be moved, and then the old binary cannot be moved back over the new one.
		const { ops, inPlace } = disk({ ...had, ...arrived }, (from, to) => to === NOTICES || from === `${BIN}.old`);
		await expect(putInPlace([BIN, LICENCE, NOTICES], ops)).rejects.toThrow(
			`Could not put ${NOTICES} in place: EPERM: operation not permitted, rename '${NOTICES}.new' -> '${NOTICES}'. Already in place and not put back: ${BIN} (what was there before is beside each, as .old).`,
		);
		expect(inPlace()).toEqual({ [BIN]: "NEW BINARY", [`${BIN}.old`]: "OLD BINARY", [LICENCE]: "old licence", [NOTICES]: "old notices" });
	});

	// On a real folder. A folder with something in it stands in for what cannot be replaced: no system moves a file
	// onto one.
	const vendorWith = (name: string, files: Record<string, string>) => {
		const dir = fresh(name);
		for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
		return dir;
	};
	const unreplaceable = (path: string) => {
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "in-use"), "in use");
	};
	const listing = (dir: string) =>
		readdirSync(dir)
			.sort()
			.map((name) => (statSync(join(dir, name)).isDirectory() ? `${name}/` : `${name}=${readFileSync(join(dir, name), "utf8")}`));
	const download = (vendorDir: string, platform: NodeJS.Platform) =>
		bundleLsp({
			vendorDir,
			download: true,
			platform,
			arch: "x64",
			fetchTo: async (url, path) => writeFileSync(path, url.endsWith("/LICENSE") ? "licence" : url.endsWith("NOTICES.md") ? "notices" : "NEW BINARY"),
		});

	/** What a bundling that cannot succeed said, kept until the folder has been looked at. */
	const failure = (work: Promise<unknown>) =>
		work.then(
			() => "no failure",
			(err: Error) => err.message,
		);

	test("a download onto a binary that cannot be replaced leaves the old licence files beside it", async () => {
		const vendorDir = vendorWith("download-in-use", { "STARLIMS-LSP-LICENSE": "old licence", "THIRD-PARTY-NOTICES.md": "old notices" });
		unreplaceable(join(vendorDir, "starlims-lsp.exe"));
		const said = await failure(download(vendorDir, "win32"));
		// The new licence files used to be here by now, beside the binary that stayed.
		expect(listing(vendorDir)).toEqual(["STARLIMS-LSP-LICENSE=old licence", "THIRD-PARTY-NOTICES.md=old notices", "starlims-lsp.exe/"]);
		expect(said).toMatch(/^Could not put .*starlims-lsp\.exe in place: .*The folder is as it was\.$/s);
	});

	test("so does a local copy", async () => {
		const vendorDir = vendorWith("local-in-use", { "STARLIMS-LSP-LICENSE": "old licence", "THIRD-PARTY-NOTICES.md": "old notices" });
		unreplaceable(join(vendorDir, "starlims-lsp"));
		const elsewhere = vendorWith("local-in-use-elsewhere", { "starlims-lsp": "PINNED BINARY" });
		const repoDir = vendorWith("local-in-use-repo", { LICENSE: "licence", "THIRD-PARTY-NOTICES.md": "notices" });
		const said = await failure(
			bundleLsp({
				vendorDir,
				repoDir,
				platform: "linux",
				findLocal: async () => ({ ok: true, version: LSP_PIN, path: join(elsewhere, "starlims-lsp") }),
				getVersion: async () => undefined,
			}),
		);
		expect(listing(vendorDir)).toEqual(["STARLIMS-LSP-LICENSE=old licence", "THIRD-PARTY-NOTICES.md=old notices", "starlims-lsp/"]);
		expect(said).toMatch(/^Could not put .*starlims-lsp in place: .*The folder is as it was\.$/s);
	});

	test("a download whose notices cannot be put in place puts the old binary and licence back, the binary as it was", async () => {
		const vendorDir = vendorWith("download-notices-stuck", { "starlims-lsp": "OLD BINARY", "STARLIMS-LSP-LICENSE": "old licence" });
		chmodSync(join(vendorDir, "starlims-lsp"), 0o755);
		unreplaceable(join(vendorDir, "THIRD-PARTY-NOTICES.md"));
		const said = await failure(download(vendorDir, "linux"));
		expect(listing(vendorDir)).toEqual(["STARLIMS-LSP-LICENSE=old licence", "THIRD-PARTY-NOTICES.md/", "starlims-lsp=OLD BINARY"]);
		if (posix) expect(statSync(join(vendorDir, "starlims-lsp")).mode & 0o111).not.toBe(0);
		expect(said).toMatch(/^Could not put .*THIRD-PARTY-NOTICES\.md in place: .*The folder is as it was\.$/s);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. git is asked in English, whatever language the user's is
// ---------------------------------------------------------------------------------------------------------------

const hasGit = (() => {
	try {
		return Bun.spawnSync(["git", "--version"]).exitCode === 0;
	} catch {
		return false;
	}
})();
// The user's own settings are kept out by an empty file of settings, and the commits carry the test's own name.
const gitSettings = join(fresh("gitconfig"), "config");
writeFileSync(gitSettings, "");
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_CONFIG_GLOBAL: gitSettings, GIT_CONFIG_NOSYSTEM: "1" };
const german = { LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8", LANGUAGE: "de" };
/** Whether this machine's git speaks German when the user's language is German: the locale and git's own translation are both there. */
const gitSpeaksGerman = hasGit && /kein Git-Befehl/.test(Bun.spawnSync(["git", "no-such-command"], { env: { ...process.env, ...german } }).stderr.toString());

function repository(name: string) {
	const top = fresh(name);
	/** git as the user's own shell runs it: in the language the process has at the time. */
	const git = (...args: string[]) => {
		const ran = Bun.spawnSync(["git", "-C", top, ...args], { env: { ...process.env, ...identity } });
		if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
		return ran.stdout.toString();
	};
	git("init", "-q");
	git("symbolic-ref", "HEAD", "refs/heads/main");
	git("config", "core.autocrlf", "false");
	git("config", "commit.gpgsign", "false");
	return { top, git };
}

describe("the environment git is run in", () => {
	test("messages in English, the rest of the locale the user's own, and the environment given left alone", () => {
		const users = { PATH: "/usr/bin", LANG: "de_DE.UTF-8", LANGUAGE: "de:en", LC_TIME: "de_AT.UTF-8", GIT_TERMINAL_PROMPT: "1" };
		expect(gitEnv(users)).toEqual({ PATH: "/usr/bin", LANG: "de_DE.UTF-8", LC_TIME: "de_AT.UTF-8", LC_MESSAGES: "C", GIT_TERMINAL_PROMPT: "0" });
		expect(users.LANGUAGE).toBe("de:en");
		// LC_MESSAGES of the user's own is replaced.
		expect(gitEnv({ LC_MESSAGES: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" })).toEqual({ LC_MESSAGES: "C", LANG: "fr_FR.UTF-8", GIT_TERMINAL_PROMPT: "0" });
		// With no locale at all there is still none but the messages'.
		expect(gitEnv({})).toEqual({ LC_MESSAGES: "C", GIT_TERMINAL_PROMPT: "0" });
	});

	test("LC_ALL, which stands above LC_MESSAGES, is taken apart: the character set it gave stays", () => {
		const env = gitEnv({ LC_ALL: "de_DE.UTF-8", LC_CTYPE: "C", LANG: "en_US.UTF-8", LANGUAGE: "de" });
		expect(env).toEqual({
			LANG: "en_US.UTF-8",
			LC_CTYPE: "de_DE.UTF-8",
			LC_COLLATE: "de_DE.UTF-8",
			LC_NUMERIC: "de_DE.UTF-8",
			LC_TIME: "de_DE.UTF-8",
			LC_MONETARY: "de_DE.UTF-8",
			LC_MESSAGES: "C",
			GIT_TERMINAL_PROMPT: "0",
		});
		expect("LC_ALL" in env).toBe(false);
		expect("LANGUAGE" in env).toBe(false);
		// An empty LC_ALL is one that is not set.
		expect(gitEnv({ LC_ALL: "", LC_CTYPE: "de_DE.UTF-8" })).toEqual({ LC_CTYPE: "de_DE.UTF-8", LC_MESSAGES: "C", GIT_TERMINAL_PROMPT: "0" });
	});
});

describe.skipIf(!hasGit)("git under a language that is not English", () => {
	const before = Object.fromEntries(Object.keys(identity).map((name) => [name, process.env[name]]));
	beforeAll(() => void Object.assign(process.env, identity));
	afterAll(() => {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	test("every git this class starts is given that environment", async () => {
		await withEnv(german, async () => {
			const { top } = repository("env-given");
			writeFileSync(join(top, "a.ssl"), ":RETURN 1;\n");
			const starts = spyOn(Bun, "spawn");
			const g = new Git(top);
			try {
				await g.status();
				await g.stage([join(top, "a.ssl")]);
				await g.commit("one");
				await g.stash("push");
				await g.stash("list");
				await g.branches();
				const calls = starts.mock.calls as unknown as [string[], { env: Record<string, string | undefined> }][];
				const envs = calls.filter(([command]) => command[0] === "git").map(([, options]) => options.env);
				expect(envs.length).toBeGreaterThan(6);
				for (const env of envs) {
					expect({ messages: env.LC_MESSAGES, all: env.LC_ALL, language: env.LANGUAGE, characters: env.LC_CTYPE, lang: env.LANG, prompt: env.GIT_TERMINAL_PROMPT }).toEqual({
						messages: "C",
						all: undefined,
						language: undefined,
						characters: "de_DE.UTF-8",
						lang: "de_DE.UTF-8",
						prompt: "0",
					});
				}
				// The process's own environment is as it was: the user's language is still theirs everywhere else.
				expect(process.env.LC_ALL).toBe("de_DE.UTF-8");
				expect(process.env.LANGUAGE).toBe("de");
			} finally {
				starts.mockRestore();
				g.dispose();
			}
		});
	});

	test.skipIf(!posix)("what git starts is told the same: a commit's check runs with the user's character set", async () => {
		await withEnv({ LC_ALL: "de_DE.UTF-8", LANG: "fr_FR.UTF-8", LANGUAGE: "de:fr" }, async () => {
			const { top } = repository("hook-env");
			const seen = join(fresh("hook-env-seen"), "seen.txt");
			mkdirSync(join(top, ".git", "hooks"), { recursive: true });
			const hook = join(top, ".git", "hooks", "pre-commit");
			writeFileSync(hook, `#!/bin/sh\nprintf '%s|%s|%s|%s|%s' "\${LC_ALL-unset}" "\${LC_CTYPE-unset}" "\${LC_MESSAGES-unset}" "\${LANGUAGE-unset}" "\${LANG-unset}" > "${seen}"\n`);
			chmodSync(hook, 0o755);
			writeFileSync(join(top, "a.ssl"), ":RETURN 1;\n");
			const g = new Git(top);
			try {
				await g.stage([join(top, "a.ssl")]);
				await g.commit("one");
				expect(readFileSync(seen, "utf8")).toBe("unset|de_DE.UTF-8|C|unset|fr_FR.UTF-8");
			} finally {
				g.dispose();
			}
		});
	});

	// Where the machine has no German locale, or git no German, this cannot be asked: the two tests above are then
	// all that holds the fix.
	test.skipIf(!gitSpeaksGerman)("a German git: a stash with nothing to save is not a stash that was made", async () => {
		await withEnv(german, async () => {
			const { top, git } = repository("german-stash");
			const ws = join(top, "app");
			const onlyNew = join(top, "only-new");
			mkdirSync(ws, { recursive: true });
			mkdirSync(onlyNew, { recursive: true });
			writeFileSync(join(ws, "a.ssl"), ":RETURN 1;\n");
			git("add", "-A");
			git("commit", "-q", "-m", "one");
			writeFileSync(join(onlyNew, "n.ssl"), ":RETURN 2;\n");
			// What the user's own git says here, in the user's language: not the words this side reads.
			expect(git("stash")).toContain("Keine lokalen Änderungen");

			const atTop = new Git(top);
			const below = new Git(ws);
			const none = new Git(onlyNew);
			try {
				expect(await atTop.stash("push")).toEqual({ ok: false, message: "No local changes to save." });
				expect(await below.stash("push")).toEqual({ ok: false, message: "No local changes to save." });
				// A folder in which git follows no file: its German error is not taken for another failure.
				expect(await none.stash("push")).toEqual({ ok: false, message: "No local changes to save." });
				expect((await atTop.stash("list")).entries).toEqual([]);

				// A change is saved, and said to be.
				writeFileSync(join(ws, "a.ssl"), ":RETURN 3;\n");
				const pushed = await below.stash("push", "work");
				expect(pushed.ok).toBe(true);
				expect(pushed.message).toMatch(/^Saved working directory and index state/);
				expect((await atTop.stash("list")).entries?.map((entry) => entry.message)).toEqual(["On main: work"]);
				expect((await below.stash("pop")).ok).toBe(true);
				expect(readFileSync(join(ws, "a.ssl"), "utf8")).toBe(":RETURN 3;\n");

				// What a switch of branch reads, to fall back on a git too old to know `switch`, is in English too.
				const unknown = await (atTop as any).run(["no-such-command"]);
				expect(unknown.err).toMatch(/not a git command/);
			} finally {
				atTop.dispose();
				below.dispose();
				none.dispose();
			}
		});
	});

	test("names and messages with letters outside ASCII come out whole, under a German locale as under none", async () => {
		for (const [at, locale] of [german, { LC_ALL: "C", LANG: "C", LANGUAGE: "" }].entries()) {
			await withEnv(locale, async () => {
				const { top, git } = repository(`names-${at}`);
				const file = join(top, "Prüfung ä.ssl");
				writeFileSync(file, ":RETURN 1;\n");
				git("add", "-A");
				git("commit", "-q", "-m", "ABC-1 Änderung an der Prüfung");
				writeFileSync(file, ":RETURN 2;\n");
				const g = new Git(top);
				try {
					expect((await g.status())?.files.map((entry) => basename(entry.path))).toEqual(["Prüfung ä.ssl"]);
					expect((await g.log(file)).map((commit) => [commit.subject, commit.path])).toEqual([["ABC-1 Änderung an der Prüfung", "Prüfung ä.ssl"]]);
					expect((await g.ticketLog("ABC-1")).map((commit) => commit.files.map((entry) => entry.path))).toEqual([["Prüfung ä.ssl"]]);
					expect(await g.diff()).toContain("+++ b/Prüfung ä.ssl");
				} finally {
					g.dispose();
				}
			});
		}
	});
});
