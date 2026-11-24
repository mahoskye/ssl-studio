import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend, dispatch, type Host } from "../src/bun/backend";
import { decodePart, encode, looksBinary } from "../src/bun/encoding";
import { injectTokenMeta, isAllowedHost, isAllowedOrigin, resolveStaticPath, startWebHost, tokensMatch } from "../src/bun/web";
import { WorkspaceFiles } from "../src/bun/workspace";
import { backend as viewBackend, connect as viewConnect, on as viewOn, onConnectionLost } from "../src/view/backend";

const rootTmp = mkdtempSync(join(tmpdir(), "ssl-studio-r1a-"));
afterAll(() => rmSync(rootTmp, { recursive: true, force: true }));

function makeHost(overrides: Partial<Host> = {}): Host & { trashed: string[]; events: { event: string; payload: unknown }[]; quits: () => number } {
	const trashed: string[] = [];
	const events: { event: string; payload: unknown }[] = [];
	let quitCount = 0;
	return {
		app: "test",
		kind: "app",
		emit: (event, payload) => void events.push({ event, payload }),
		pick: async () => null,
		trash: async (path) => void trashed.push(path),
		quit: () => void quitCount++,
		...overrides,
		trashed,
		events,
		quits: () => quitCount,
	};
}

describe("web.ts pure security helpers", () => {
	test("isAllowedHost permits only loopback host on active port", () => {
		expect(isAllowedHost("127.0.0.1:5190", 5190)).toBe(true);
		expect(isAllowedHost("localhost:5190", 5190)).toBe(true);
		expect(isAllowedHost("LOCALHOST:5190", 5190)).toBe(true);
		expect(isAllowedHost("127.0.0.1:5191", 5190)).toBe(false);
		expect(isAllowedHost("evil.example:5190", 5190)).toBe(false);
		expect(isAllowedHost("localhost.evil.example:5190", 5190)).toBe(false);
		expect(isAllowedHost("127.0.0.1", 5190)).toBe(false);
		expect(isAllowedHost("[::1]:5190", 5190)).toBe(false);
		expect(isAllowedHost("", 5190)).toBe(false);
		expect(isAllowedHost(null, 5190)).toBe(false);
		expect(isAllowedHost(undefined, 5190)).toBe(false);
	});

	test("isAllowedOrigin enforces exact http/https scheme matching Host", () => {
		expect(isAllowedOrigin("http://127.0.0.1:5190", "127.0.0.1:5190")).toBe(true);
		expect(isAllowedOrigin("https://localhost:5190", "localhost:5190")).toBe(true);
		expect(isAllowedOrigin("http://localhost:5190", "127.0.0.1:5190")).toBe(false);
		expect(isAllowedOrigin("http://evil.example", "127.0.0.1:5190")).toBe(false);
		expect(isAllowedOrigin("http://127.0.0.1:5190.evil.example", "127.0.0.1:5190")).toBe(false);
		expect(isAllowedOrigin("http://127.0.0.1:5190/", "127.0.0.1:5190")).toBe(false);
		expect(isAllowedOrigin("null", "127.0.0.1:5190")).toBe(false);
		expect(isAllowedOrigin(null, "127.0.0.1:5190")).toBe(false);
		expect(isAllowedOrigin("http://127.0.0.1:5190", null)).toBe(false);
	});

	test("tokensMatch performs constant-time equality check", () => {
		const token = "11111111-2222-3333-4444-555555555555";
		expect(tokensMatch(token, token)).toBe(true);
		expect(tokensMatch("11111111-2222-3333-4444-555555555556", token)).toBe(false);
		expect(tokensMatch("short", token)).toBe(false);
		expect(tokensMatch("", token)).toBe(false);
		expect(tokensMatch(null, token)).toBe(false);
	});

	test("resolveStaticPath blocks malformed URIs, prefix collisions, and symlink escapes", () => {
		const base = join(rootTmp, "web-static");
		const dist = join(base, "dist");
		const sibling = join(base, "dist-backup");
		mkdirSync(join(dist, "assets"), { recursive: true });
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(dist, "index.html"), "<html><head><title>App</title></head><body></body></html>");
		writeFileSync(join(dist, "assets", "app.js"), "console.log(1);\n");
		writeFileSync(join(sibling, "secret.txt"), "secret");
		symlinkSync(join(sibling, "secret.txt"), join(dist, "leak.txt"));
		symlinkSync(join(sibling, "missing.txt"), join(dist, "dangling.txt"));

		const idx = resolveStaticPath(dist, "/");
		expect(idx.ok).toBe(true);
		if (idx.ok) expect(idx.isIndex).toBe(true);

		const idxExplicit = resolveStaticPath(dist, "/index.html");
		expect(idxExplicit.ok).toBe(true);
		if (idxExplicit.ok) expect(idxExplicit.isIndex).toBe(true);

		const asset = resolveStaticPath(dist, "/assets/app.js");
		expect(asset.ok).toBe(true);
		if (asset.ok) expect(asset.isIndex).toBe(false);

		// Malformed percent-encoding and NUL byte -> 400
		expect(resolveStaticPath(dist, "/%E0%A4%A")).toEqual({ ok: false, status: 400 });
		expect(resolveStaticPath(dist, "/%ZZ")).toEqual({ ok: false, status: 400 });
		expect(resolveStaticPath(dist, "/index.html%00.js")).toEqual({ ok: false, status: 400 });

		// dist vs dist-backup sibling prefix collision & encoded traversal -> 403
		expect(resolveStaticPath(dist, "/../dist-backup/secret.txt")).toEqual({ ok: false, status: 403 });
		expect(resolveStaticPath(dist, "/%2e%2e/dist-backup/secret.txt")).toEqual({ ok: false, status: 403 });
		expect(resolveStaticPath(dist, "/\\..\\dist-backup\\secret.txt")).toEqual({ ok: false, status: 403 });

		// Symlink escape and dangling symlink -> 403
		expect(resolveStaticPath(dist, "/leak.txt")).toEqual({ ok: false, status: 403 });
		expect(resolveStaticPath(dist, "/dangling.txt")).toEqual({ ok: false, status: 403 });

		// Missing file and directory -> 404
		expect(resolveStaticPath(dist, "/missing.js")).toEqual({ ok: false, status: 404 });
		expect(resolveStaticPath(dist, "/assets")).toEqual({ ok: false, status: 404 });
	});

	test("injectTokenMeta embeds token meta inside head", () => {
		const html = "<!doctype html><html><head><title>T</title></head><body></body></html>";
		const out = injectTokenMeta(html, "tok-abc");
		expect(out).toContain('<meta name="ssl-studio-token" content="tok-abc">');
		expect(out.indexOf("ssl-studio-token")).toBeGreaterThan(out.indexOf("<head>"));
		expect(out.indexOf("ssl-studio-token")).toBeLessThan(out.indexOf("</head>"));
	});
});

describe("web.ts live HTTP & WebSocket hardening", () => {
	test("enforces Host, Origin, token, no-store meta injection, static traversal, and WS payload validation", async () => {
		const base = join(rootTmp, "web-live");
		const dist = join(base, "dist");
		const backup = join(base, "dist-backup");
		const wsDir = join(base, "ws");
		mkdirSync(dist, { recursive: true });
		mkdirSync(backup, { recursive: true });
		mkdirSync(wsDir, { recursive: true });
		writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>SSL Studio</title></head><body></body></html>");
		writeFileSync(join(backup, "secret.txt"), "top-secret");
		symlinkSync(join(backup, "secret.txt"), join(dist, "escape.txt"));
		writeFileSync(join(wsDir, "hello.ssl"), ":RETURN 1;\n");

		const host = startWebHost({ port: 0, dist, folder: wsDir, quit: () => {} });
		await host.backend.ready;
		const port = host.server.port!;
		const baseUrl = `http://127.0.0.1:${port}`;
		try {
			// 1. Index serves injected token meta with Cache-Control: no-store
			const indexRes = await fetch(`${baseUrl}/`);
			expect(indexRes.status).toBe(200);
			expect(indexRes.headers.get("cache-control")).toBe("no-store");
			const html = await indexRes.text();
			expect(html).toContain(`<meta name="ssl-studio-token" content="${host.token}">`);

			// 2. Spoofed Host header (DNS rebinding) -> 403
			const badHost = await fetch(`${baseUrl}/`, { headers: { Host: `evil.example:${port}` } });
			expect(badHost.status).toBe(403);

			// 3. Malformed URI -> 400
			const badUri = await fetch(`${baseUrl}/%E0%A4%A`);
			expect(badUri.status).toBe(400);

			// 4. Static symlink escape & percent-encoded slash traversal -> 403
			const symRes = await fetch(`${baseUrl}/escape.txt`);
			expect(symRes.status).toBe(403);
			const travRes = await fetch(`${baseUrl}/%2e%2e%2fdist-backup/secret.txt`);
			expect(travRes.status).toBe(403);

			// 5. /backend upgrade without Origin or with wrong Origin or wrong token -> 403
			const noOrigin = await fetch(`${baseUrl}/backend?token=${host.token}`, {
				headers: { Connection: "Upgrade", Upgrade: "websocket" },
			});
			expect(noOrigin.status).toBe(403);

			const badOrigin = await fetch(`${baseUrl}/backend?token=${host.token}`, {
				headers: { Origin: "http://evil.example", Connection: "Upgrade", Upgrade: "websocket" },
			});
			expect(badOrigin.status).toBe(403);

			const badToken = await fetch(`${baseUrl}/backend?token=wrong-token`, {
				headers: { Origin: baseUrl, Connection: "Upgrade", Upgrade: "websocket" },
			});
			expect(badToken.status).toBe(403);

			// 6. Valid WS connection with matching Origin + token works and survives malformed messages
			const ws = new WebSocket(`ws://127.0.0.1:${port}/backend?token=${encodeURIComponent(host.token)}`, {
				headers: { Origin: baseUrl },
			} as any);
			await new Promise<void>((resolve, reject) => {
				ws.addEventListener("open", () => resolve(), { once: true });
				ws.addEventListener("error", () => reject(new Error("ws open failed")), { once: true });
			});

			const nextReply = () =>
				new Promise<any>((resolve) => {
					ws.addEventListener("message", (ev) => resolve(JSON.parse(String(ev.data))), { once: true });
				});

			// Malformed JSON is ignored without closing socket
			ws.send("{not-json");
			// Invalid RPC shape returns error reply
			const badShapePromise = nextReply();
			ws.send(JSON.stringify({ id: 1, method: "workspace", args: "not-an-array" }));
			const badShape = await badShapePromise;
			expect(badShape.id).toBe(1);
			expect(badShape.error).toContain("invalid RPC call");

			// Prototype method is rejected cleanly
			const protoPromise = nextReply();
			ws.send(JSON.stringify({ id: 2, method: "toString", args: [] }));
			const protoReply = await protoPromise;
			expect(protoReply.id).toBe(2);
			expect(protoReply.error).toContain("unknown method");

			// Valid call still succeeds on the same socket
			const okPromise = nextReply();
			ws.send(JSON.stringify({ id: 3, method: "workspace", args: [] }));
			const okReply = await okPromise;
			expect(okReply).toEqual({ id: 3, result: { root: wsDir, name: "ws" } });

			ws.close();
		} finally {
			host.stop();
		}
	});
});

describe("view/backend.ts proxy & listener safety", () => {
	test("Proxy ignores symbols, then, and toJSON, and rejects disconnected calls as a Promise", async () => {
		expect((viewBackend as any)[Symbol.toStringTag]).toBeUndefined();
		expect((viewBackend as any).then).toBeUndefined();
		expect((viewBackend as any).toJSON).toBeUndefined();
		// Promise.resolve(viewBackend) must not invoke backend.then()
		expect(await Promise.resolve(viewBackend)).toBe(viewBackend);
		// Disconnected call returns rejected promise instead of throwing synchronously
		const promise = viewBackend.workspace();
		expect(promise).toBeInstanceOf(Promise);
		await expect(promise).rejects.toThrow("backend not connected");
	});

	test("onConnectionLost and on return working unsubscribe functions", () => {
		const unsubLost = onConnectionLost(() => {});
		expect(typeof unsubLost).toBe("function");
		unsubLost();

		const unsubEvent = viewOn("fileChanged", () => {});
		expect(typeof unsubEvent).toBe("function");
		unsubEvent();
	});

	test("connect() reads meta token, derives wss:, rejects early close, closes prior socket idempotently, and isolates listener/send errors", async () => {
		const origWS = globalThis.WebSocket;
		const origLoc = (globalThis as any).location;
		const origDoc = (globalThis as any).document;
		const sockets: MockSocket[] = [];
		let closeImmediately = false;
		let throwOnSend = false;

		class MockSocket extends EventTarget {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;
			readyState = 0;
			closed = false;
			sent: string[] = [];
			constructor(public url: string) {
				super();
				sockets.push(this);
				queueMicrotask(() => {
					if (closeImmediately) {
						this.readyState = 3;
						this.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
					} else {
						this.readyState = 1;
						this.dispatchEvent(new Event("open"));
					}
				});
			}
			send(data: string) {
				if (throwOnSend) throw new Error("send boom");
				this.sent.push(data);
			}
			close() {
				this.closed = true;
				this.readyState = 3;
				this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 }));
			}
			emitMessage(data: string) {
				this.dispatchEvent(new MessageEvent("message", { data }));
			}
		}

		try {
			(globalThis as any).WebSocket = MockSocket;
			(globalThis as any).location = { protocol: "https:", host: "127.0.0.1:5190" };
			(globalThis as any).document = {
				querySelector: (sel: string) =>
					sel === 'meta[name="ssl-studio-token"]' ? { getAttribute: () => "tok-secret+1" } : null,
			};

			// 1. Early close rejects handshake with Error instead of hanging
			closeImmediately = true;
			await expect(viewConnect()).rejects.toThrow(/closed before opening/);
			expect(sockets[0]!.url).toBe("wss://127.0.0.1:5190/backend?token=tok-secret%2B1");

			// 2. Normal connect opens socket; malformed message ignored; throwing listener doesn't block sibling listener
			closeImmediately = false;
			await viewConnect();
			const s1 = sockets[1]!;
			const got: string[] = [];
			const unsubBad = viewOn("fileChanged", () => {
				throw new Error("listener boom");
			});
			const unsubGood = viewOn("fileChanged", (p) => void got.push(p.path));
			try {
				s1.emitMessage("{bad json");
				s1.emitMessage(JSON.stringify({ event: "fileChanged", payload: { path: "/a.ssl" } }));
				expect(got).toEqual(["/a.ssl"]);
			} finally {
				unsubBad();
				unsubGood();
			}

			// 3. send() error rejects call and cleans up pending map
			throwOnSend = true;
			await expect(viewBackend.workspace()).rejects.toThrow("send boom");
			throwOnSend = false;

			// 4. Calling connect() again closes previous socket cleanly without firing onConnectionLost
			let lostCount = 0;
			const unsubLost = onConnectionLost(() => void lostCount++);
			try {
				await viewConnect();
				expect(s1.closed).toBe(true);
				expect(lostCount).toBe(0);

				// Unexpected close of active socket fires onConnectionLost; unsubscribing stops future notifications
				const s2 = sockets[2]!;
				s2.close();
				expect(lostCount).toBe(1);
			} finally {
				unsubLost();
			}
		} finally {
			(globalThis as any).WebSocket = origWS;
			if (origLoc === undefined) delete (globalThis as any).location;
			else (globalThis as any).location = origLoc;
			if (origDoc === undefined) delete (globalThis as any).document;
			else (globalThis as any).document = origDoc;
		}
	});
});

describe("WorkspaceFiles security & filesystem hardening", () => {
	test("inside() blocks file symlinks, dir symlinks, dangling symlinks outside root, and symlink loops", () => {
		const outside = join(rootTmp, "ws-outside");
		const wsDir = join(rootTmp, "ws-inside");
		mkdirSync(outside, { recursive: true });
		mkdirSync(join(wsDir, "real"), { recursive: true });
		writeFileSync(join(outside, "secret.txt"), "secret");
		writeFileSync(join(wsDir, "real", "ok.ssl"), ":RETURN 1;\n");

		symlinkSync(join(outside, "secret.txt"), join(wsDir, "sym-file.txt"));
		symlinkSync(outside, join(wsDir, "sym-dir"));
		symlinkSync(join(outside, "nonexistent.txt"), join(wsDir, "dangling-abs.txt"));
		symlinkSync("../ws-outside/nonexistent.txt", join(wsDir, "dangling-rel.txt"));
		symlinkSync(join(wsDir, "loop-b"), join(wsDir, "loop-a"));
		symlinkSync(join(wsDir, "loop-a"), join(wsDir, "loop-b"));
		symlinkSync(join(wsDir, "real"), join(wsDir, "internal-link"));

		const ws = new WorkspaceFiles(wsDir);
		expect(() => ws.inside(join(wsDir, "sym-file.txt"))).toThrow(/outside/);
		expect(() => ws.inside(join(wsDir, "sym-dir", "new.txt"))).toThrow(/outside/);
		expect(() => ws.inside(join(wsDir, "dangling-abs.txt"))).toThrow(/outside/);
		expect(() => ws.inside(join(wsDir, "dangling-rel.txt"))).toThrow(/outside/);
		expect(() => ws.inside(join(wsDir, "dangling-abs.txt", "nested.txt"))).toThrow(/outside/);
		expect(() => ws.inside(join(wsDir, "loop-a"))).toThrow(/outside/);
		expect(() => ws.inside(`${wsDir}-sibling`)).toThrow(/outside/);
		// Internal symlink stays allowed
		expect(ws.inside(join(wsDir, "internal-link", "ok.ssl"))).toBe(join(wsDir, "internal-link", "ok.ssl"));
	});

	test("writeNow() blocks non-existent images, EISDIR, EACCES, symlink escapes, and cleans up temp files", async () => {
		const outside = join(rootTmp, "write-outside");
		const wsDir = join(rootTmp, "write-ws");
		mkdirSync(outside, { recursive: true });
		mkdirSync(join(wsDir, "subdir"), { recursive: true });
		writeFileSync(join(outside, "target.txt"), "untouched");
		symlinkSync(join(outside, "target.txt"), join(wsDir, "escape.ssl"));

		const ws = new WorkspaceFiles(wsDir);

		// Unconditional image guard even when file does not exist yet
		await expect(ws.write(join(wsDir, "brand-new.png"), "not an image")).rejects.toThrow(/not text/);
		expect(existsSync(join(wsDir, "brand-new.png"))).toBe(false);

		// Writing to a directory throws EISDIR rather than treating as new file
		await expect(ws.write(join(wsDir, "subdir"), "oops")).rejects.toMatchObject({ code: "EISDIR" });

		// Writing through symlink escaping root is rejected and leaves outside file intact
		await expect(ws.write(join(wsDir, "escape.ssl"), "pwned")).rejects.toThrow(/outside/);
		expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("untouched");

		// Unreadable existing file rethrows EACCES instead of overwriting as new UTF-8
		if (process.platform !== "win32" && process.getuid?.() !== 0) {
			const locked = join(wsDir, "unreadable.ssl");
			writeFileSync(locked, "keep me\n");
			chmodSync(locked, 0o000);
			try {
				await expect(ws.write(locked, "overwritten\n")).rejects.toMatchObject({ code: "EACCES" });
			} finally {
				chmodSync(locked, 0o644);
			}
			expect(readFileSync(locked, "utf8")).toBe("keep me\n");
		}

		// Atomic writeBytes writes cleanly and leaves zero temp files
		const bin = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
		const written = await ws.writeBytes(join(wsDir, "out", "file.docx"), bin);
		expect(written.size).toBe(bin.length);
		expect([...readFileSync(join(wsDir, "out", "file.docx"))]).toEqual([...bin]);
		expect(readdirSync(wsDir).filter((n) => n.endsWith(".ssl-studio-tmp"))).toEqual([]);
		expect(readdirSync(join(wsDir, "out")).filter((n) => n.endsWith(".ssl-studio-tmp"))).toEqual([]);
	});

	test("writeImage() rejects oversized base64 payloads before decoding", async () => {
		const wsDir = join(rootTmp, "img-ws");
		mkdirSync(wsDir, { recursive: true });
		const ws = new WorkspaceFiles(wsDir);
		// > 20 MB decoded (~28M base64 chars)
		const huge = "A".repeat(28 * 1024 * 1024);
		await expect(ws.writeImage(join(wsDir, "huge.png"), huge)).rejects.toThrow(/too large to save/);
		expect(existsSync(join(wsDir, "huge.png"))).toBe(false);
	});

	test("create() rejects dangling symlinks and serializes concurrent creation atomically", async () => {
		const wsDir = join(rootTmp, "create-ws");
		mkdirSync(wsDir, { recursive: true });
		symlinkSync(join(wsDir, "missing-target.ssl"), join(wsDir, "dangling.ssl"));
		const ws = new WorkspaceFiles(wsDir);

		// Dangling symlink inside root is rejected as already exists
		await expect(ws.create(join(wsDir, "dangling.ssl"), "file")).rejects.toThrow(/already exists/);

		// Concurrent create() calls: exactly one succeeds, the rest fail with already exists
		const target = join(wsDir, "race.ssl");
		const results = await Promise.allSettled([ws.create(target, "file"), ws.create(target, "file"), ws.create(target, "file")]);
		const ok = results.filter((r) => r.status === "fulfilled");
		const err = results.filter((r) => r.status === "rejected");
		expect(ok).toHaveLength(1);
		expect(err).toHaveLength(2);
		for (const r of err) expect(String((r as PromiseRejectedResult).reason?.message)).toContain("already exists");
	});

	test("copy() rejects dangling symlinks, symlinked self-copies, and preserves existing target on EEXIST", async () => {
		const wsDir = join(rootTmp, "copy-sec-ws");
		mkdirSync(join(wsDir, "dir"), { recursive: true });
		writeFileSync(join(wsDir, "dir", "a.ssl"), "a\n");
		writeFileSync(join(wsDir, "existing.ssl"), "precious\n");
		symlinkSync(join(wsDir, "dir"), join(wsDir, "dir-link"));
		symlinkSync(join(wsDir, "nowhere"), join(wsDir, "dangling-dest.ssl"));
		const ws = new WorkspaceFiles(wsDir);

		await expect(ws.copy(join(wsDir, "dir", "a.ssl"), join(wsDir, "dangling-dest.ssl"))).rejects.toThrow(/already exists/);
		await expect(ws.copy(join(wsDir, "dir"), join(wsDir, "dir-link", "nested"))).rejects.toThrow(/into itself/);
		await expect(ws.copy(join(wsDir, "dir", "a.ssl"), join(wsDir, "existing.ssl"))).rejects.toThrow(/already exists/);
		expect(readFileSync(join(wsDir, "existing.ssl"), "utf8")).toBe("precious\n");
	});

	test("rename() blocks root rename, self-move, and overwriting dangling symlinks", async () => {
		const wsDir = join(rootTmp, "rename-sec-ws");
		mkdirSync(join(wsDir, "folder"), { recursive: true });
		writeFileSync(join(wsDir, "folder", "a.ssl"), "a\n");
		symlinkSync(join(wsDir, "nowhere"), join(wsDir, "dangling.ssl"));
		const ws = new WorkspaceFiles(wsDir);

		await expect(ws.rename(wsDir, join(wsDir, "moved"))).rejects.toThrow(/workspace root/);
		await expect(ws.rename(join(wsDir, "folder"), wsDir)).rejects.toThrow(/workspace root/);
		await expect(ws.rename(join(wsDir, "folder"), join(wsDir, "folder", "sub"))).rejects.toThrow(/into itself/);
		await expect(ws.rename(join(wsDir, "folder", "a.ssl"), join(wsDir, "dangling.ssl"))).rejects.toThrow(/already exists/);
	});

	test("read(), list(), files(), and search() skip tmp/image/binary files and reject non-files", async () => {
		const wsDir = join(rootTmp, "scan-ws");
		mkdirSync(join(wsDir, "sub"), { recursive: true });
		writeFileSync(join(wsDir, "real.ssl"), "needle here\n");
		writeFileSync(join(wsDir, ".real.ssl.1.abc.ssl-studio-tmp"), "needle temp\n");
		writeFileSync(join(wsDir, "pic.png"), "needle fake png text");
		writeFileSync(join(wsDir, "utf32.txt"), Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x6e, 0x00, 0x00, 0x00]));
		const ws = new WorkspaceFiles(wsDir);

		// read() rejects directories
		await expect(ws.read(join(wsDir, "sub"))).rejects.toMatchObject({ code: "EISDIR" });
		// read() identifies UTF-32 LE as binary rather than UTF-16 LE text
		const utf32 = await ws.read(join(wsDir, "utf32.txt"));
		expect(utf32.binary).toEqual({ size: 8 });
		expect(utf32.text).toBe("");

		// list() and files() skip *.ssl-studio-tmp
		expect(ws.list(wsDir).some((e) => e.name.endsWith(".ssl-studio-tmp"))).toBe(false);
		expect([...ws.files()].some((p) => p.endsWith(".ssl-studio-tmp"))).toBe(false);

		// search() skips temp files, images, and binary files
		const hits = await ws.search("needle", {});
		expect(hits.map((h) => h.path)).toEqual([join(wsDir, "real.ssl")]);
	});

	test("watch() filters SKIP against workspace-relative path (works when parent dir is named build/)", async () => {
		const wsDir = join(rootTmp, "build", "my-project");
		mkdirSync(join(wsDir, "node_modules"), { recursive: true });
		const ws = new WorkspaceFiles(wsDir);
		const seen: string[] = [];
		ws.watch((p) => seen.push(p));
		try {
			await new Promise((r) => setTimeout(r, 80));
			// External write to workspace file under a parent `build/` folder MUST emit
			writeFileSync(join(wsDir, "hello.ssl"), ":RETURN 1;\n");
			// Write inside workspace's own `node_modules` and temp file MUST be ignored
			writeFileSync(join(wsDir, "node_modules", "ignored.js"), "x");
			writeFileSync(join(wsDir, ".x.ssl-studio-tmp"), "tmp");
			// Wait up to 800ms for watcher delivery
			const deadline = Date.now() + 800;
			while (!seen.includes(join(wsDir, "hello.ssl")) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 30));
			}
			expect(seen).toContain(join(wsDir, "hello.ssl"));
			expect(seen.some((p) => p.includes("node_modules"))).toBe(false);
			expect(seen.some((p) => p.endsWith(".ssl-studio-tmp"))).toBe(false);
		} finally {
			ws.close();
		}
	});
});

describe("backend.ts security, dispatch, imports/exports, and lifecycle hardening", () => {
	test("trash() and gitDiscard() refuse the workspace root", async () => {
		const wsDir = join(rootTmp, "root-protect-ws");
		mkdirSync(wsDir, { recursive: true });
		const host = makeHost();
		const backend = createBackend(host, wsDir);
		await backend.ready;
		try {
			await expect(backend.api.trash(wsDir)).rejects.toThrow(/workspace root/);
			await expect(backend.api.gitDiscard(wsDir)).rejects.toThrow(/workspace root/);
			expect(host.trashed).toEqual([]);
		} finally {
			backend.dispose();
		}
	});

	test("dispatch() enforces Object.hasOwn and Array.isArray(args)", async () => {
		const backend = createBackend(makeHost());
		try {
			await expect(dispatch(backend.api, "toString", [])).rejects.toThrow(/unknown method/);
			await expect(dispatch(backend.api, "constructor", [])).rejects.toThrow(/unknown method/);
			await expect(dispatch(backend.api, "hasOwnProperty", ["workspace"])).rejects.toThrow(/unknown method/);
			await expect(dispatch(backend.api, "workspace", "bad" as any)).rejects.toThrow(/invalid arguments/);
			await expect(dispatch(backend.api, "workspace", null as any)).rejects.toThrow(/invalid arguments/);
			expect(await dispatch(backend.api, "workspace", [])).toBeNull();
		} finally {
			backend.dispose();
		}
	});

	test("importDocFile, importDocxBytes, exportDocx, and readExport enforce path, extension, and size guards", async () => {
		const wsDir = join(rootTmp, "imp-sec-ws");
		const extDir = join(rootTmp, "imp-sec-ext");
		mkdirSync(join(wsDir, "docs"), { recursive: true });
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "secret.env"), "SECRET=1\n");
		writeFileSync(join(extDir, "outside.md"), "# Outside\n");
		writeFileSync(join(extDir, "export.csv"), "Key,Summary\nT-1,Ok\n");
		writeFileSync(join(wsDir, "inside.csv"), "Key,Summary\nT-2,Inside\n");
		const bigMd = join(wsDir, "big.md");
		writeFileSync(bigMd, "");
		truncateSync(bigMd, 20 * 1024 * 1024 + 10);

		const webHost = makeHost({ kind: "browser", restrictPaths: true });
		const webBackend = createBackend(webHost, wsDir);
		await webBackend.ready;
		try {
			// Browser host blocks sourcePath outside workspace
			await expect(webBackend.api.importDocFile({ sourcePath: join(extDir, "outside.md"), destDir: join(wsDir, "docs") })).rejects.toThrow(/outside/);
			// Browser host blocks readExport outside workspace
			await expect(webBackend.api.readExport(join(extDir, "export.csv"))).rejects.toThrow(/outside/);
			// Browser host allows readExport inside workspace
			expect(await webBackend.api.readExport(join(wsDir, "inside.csv"))).toContain("T-2");
			// Disallowed extension rejected
			writeFileSync(join(wsDir, "secret.env"), "SECRET=1\n");
			await expect(webBackend.api.importDocFile({ sourcePath: join(wsDir, "secret.env"), destDir: join(wsDir, "docs") })).rejects.toThrow(/Unsupported document format/);
			// Directory rejected as non-regular file
			mkdirSync(join(wsDir, "dir.md"), { recursive: true });
			await expect(webBackend.api.importDocFile({ sourcePath: join(wsDir, "dir.md"), destDir: join(wsDir, "docs") })).rejects.toThrow(/not a regular file/);
			// Oversized file (> 20 MB) rejected
			await expect(webBackend.api.importDocFile({ sourcePath: bigMd, destDir: join(wsDir, "docs") })).rejects.toThrow(/too large to import/);
			// importDocxBytes oversized (> 20 MB) rejected before decoding
			await expect(
				webBackend.api.importDocxBytes({
					fileName: "huge.docx",
					base64: "A".repeat(28 * 1024 * 1024),
					destDir: join(wsDir, "docs"),
				}),
			).rejects.toThrow(/too large to import/);
			// exportDocx validates .docx extension and does not create parent dirs on invalid path
			await expect(
				webBackend.api.exportDocx({
					path: join(wsDir, "never-created", "out.txt"),
					title: "Test",
					markdown: "# Hi\n",
				}),
			).rejects.toThrow(/\.docx/);
			expect(existsSync(join(wsDir, "never-created"))).toBe(false);
			// exportDocx writes atomically via ws.writeBytes
			const exported = await webBackend.api.exportDocx({
				path: join(wsDir, "exports", "spec.docx"),
				title: "Spec",
				markdown: "# Spec\n\nBody.\n",
			});
			expect(exported.bytes).toBeGreaterThan(0);
			expect(existsSync(join(wsDir, "exports", "spec.docx"))).toBe(true);
			expect(readdirSync(join(wsDir, "exports")).filter((n) => n.endsWith(".ssl-studio-tmp"))).toEqual([]);
		} finally {
			webBackend.dispose();
		}
	});

	test("open() preserves previous workspace on invalid path and handles concurrent open() safely", async () => {
		const wsA = join(rootTmp, "open-ws-a");
		const wsB = join(rootTmp, "open-ws-b");
		const wsC = join(rootTmp, "open-ws-c");
		mkdirSync(wsA, { recursive: true });
		mkdirSync(wsB, { recursive: true });
		mkdirSync(wsC, { recursive: true });
		writeFileSync(join(wsA, "a.ssl"), ":RETURN 'A';\n");
		writeFileSync(join(wsC, "c.ssl"), ":RETURN 'C';\n");

		const backend = createBackend(makeHost(), wsA);
		await backend.ready;
		try {
			// Failed open() leaves workspace A intact and readable
			await expect(backend.api.openFolder(join(rootTmp, "does-not-exist-xyz"))).rejects.toThrow();
			expect(await backend.api.workspace()).toEqual({ root: wsA, name: "open-ws-a" });
			expect((await backend.api.read(join(wsA, "a.ssl"))).text).toBe(":RETURN 'A';\n");

			// Concurrent open() resolves cleanly to the latest requested workspace
			await Promise.all([backend.api.openFolder(wsB), backend.api.openFolder(wsC)]);
			expect(await backend.api.workspace()).toEqual({ root: wsC, name: "open-ws-c" });
			expect((await backend.api.read(join(wsC, "c.ssl"))).text).toBe(":RETURN 'C';\n");
		} finally {
			backend.dispose();
		}
	});

	test("write() serializes disk write and history.record() atomically", async () => {
		const wsDir = join(rootTmp, "hist-ws");
		mkdirSync(wsDir, { recursive: true });
		const file = join(wsDir, "a.ssl");
		const backend = createBackend(makeHost(), wsDir);
		await backend.ready;
		try {
			await Promise.all([backend.api.write(file, "v1\n"), backend.api.write(file, "v2\n"), backend.api.write(file, "v3\n")]);
			expect((await backend.api.read(file)).text).toBe("v3\n");
			const snaps = await backend.api.history(file);
			expect(snaps.length).toBeGreaterThanOrEqual(1);
			expect(await backend.api.snapshot(file, snaps[0]!.id)).toBe("v3\n");
		} finally {
			backend.dispose();
		}
	});

	test("closeWindow() sets sticky closing guard and dispose() is idempotent", async () => {
		const host = makeHost();
		const backend = createBackend(host);
		await backend.api.unsavedChanged(2);
		expect(backend.mayClose()).toBe(false);
		await backend.api.closeWindow();
		// Late unsavedChanged after close confirmation is ignored
		await backend.api.unsavedChanged(5);
		expect(backend.mayClose()).toBe(true);
		backend.dispose();
		backend.dispose();
	});
});

describe("encoding.ts UTF-32 BOM and decodePart edge cases", () => {
	test("looksBinary rejects UTF-32 BOMs, UTF-16 with NUL pairs, and odd-length complete UTF-16 buffers", () => {
		// UTF-32 LE and BE BOMs
		expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]))).toBe(true);
		expect(looksBinary(new Uint8Array([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x41]))).toBe(true);
		expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x00, 0x00]))).toBe(true);
		expect(looksBinary(new Uint8Array([0x00, 0x00, 0xfe, 0xff]))).toBe(true);

		// UTF-16 BOM with NUL 16-bit code units (00 00)
		expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x00, 0x00]))).toBe(true);
		expect(looksBinary(new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0x00]))).toBe(true);

		// Odd-length full UTF-16 BOM buffers rejected when partial = false
		expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42]))).toBe(true);
		expect(looksBinary(new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00]))).toBe(true);

		// Valid UTF-16 LE / BE text still passes
		expect(looksBinary(encode("SELECT 1\n", "utf-16le"))).toBe(false);
		expect(looksBinary(encode("SELECT 1\n", "utf-16be"))).toBe(false);
	});

	test("decodePart preserves second BOM via ignoreBOM and strips trailing lone UTF-16 high surrogates when cut", () => {
		// UTF-8 BOM followed by literal U+FEFF + 'a'
		const doubleBom = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61]);
		expect(decodePart(doubleBom, false)).toBe("\ufeffa");
		expect(decodePart(doubleBom, true)).toBe("\ufeffa");

		// UTF-16 LE cut mid-surrogate-pair (A + U+1F600 = D83D DE00)
		const utf16leCut = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x3d, 0xd8]);
		expect(decodePart(utf16leCut, true)).toBe("A");
		expect(decodePart(utf16leCut, false)).toBe("A\ud83d");

		// UTF-16 BE cut mid-surrogate-pair (with an extra trailing odd byte too)
		const utf16beCut = new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0xd8, 0x3d, 0xde]);
		expect(decodePart(utf16beCut, true)).toBe("A");

		// Complete surrogate pair is preserved when cut = true
		const utf16leComplete = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x3d, 0xd8, 0x00, 0xde]);
		expect(decodePart(utf16leComplete, true)).toBe("A😀");

		// UTF-32 BOM yields empty string
		expect(decodePart(new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]), true)).toBe("");
		expect(decodePart(new Uint8Array([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x41]), true)).toBe("");
	});
});
