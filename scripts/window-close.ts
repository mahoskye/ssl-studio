// Presses a window's close button from outside, so that the app's own close
// handling runs, which closing the window by its API skips. Used by the close
// self-test (scripts/selftest.ts --close).
//
// - Linux with X11: sends the window the WM_DELETE_WINDOW message a window
//   manager sends for that click. Windows are found with xdotool.
// - Windows: PowerShell's CloseMainWindow, which posts the WM_CLOSE the close
//   button posts. A window is known by the id of the process that owns it.
// - macOS: not written. Nothing here could be tried on a Mac.
import { dlopen, FFIType, ptr } from "bun:ffi";

const CLIENT_MESSAGE = 33;
const WINDOWS = process.platform === "win32";

/** Why the close button cannot be pressed from outside on this machine, or "" when it can. */
export function closeUnsupported(): string {
	if (WINDOWS) return "";
	if (process.platform !== "linux") return "it is written for Linux with X11 and for Windows only";
	if (!process.env.DISPLAY) return "there is no X11 display";
	if (!Bun.which("xdotool")) return "xdotool is not installed";
	return "";
}

const powershell = (script: string) => Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", script]).stdout.toString();

export function requestClose(windowId: number): boolean {
	if (WINDOWS) return /True/.test(powershell(`(Get-Process -Id ${Number(windowId)}).CloseMainWindow()`));
	const x = dlopen("libX11.so.6", {
		XOpenDisplay: { args: [FFIType.ptr], returns: FFIType.ptr },
		XInternAtom: { args: [FFIType.ptr, FFIType.cstring, FFIType.i32], returns: FFIType.u64 },
		XSendEvent: { args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
		XFlush: { args: [FFIType.ptr], returns: FFIType.i32 },
		XCloseDisplay: { args: [FFIType.ptr], returns: FFIType.i32 },
	}).symbols;
	const display = x.XOpenDisplay(null);
	if (!display) return false;
	const atom = (name: string) => x.XInternAtom(display, Buffer.from(`${name}\0`), 0);
	// XClientMessageEvent on a 64-bit X11: type, serial, send_event, display, window, message_type, format, data.l[5].
	const event = new DataView(new ArrayBuffer(192));
	event.setInt32(0, CLIENT_MESSAGE, true);
	event.setBigUint64(32, BigInt(windowId), true);
	event.setBigUint64(40, BigInt(atom("WM_PROTOCOLS")), true);
	event.setInt32(48, 32, true);
	event.setBigUint64(56, BigInt(atom("WM_DELETE_WINDOW")), true);
	const sent = x.XSendEvent(display, BigInt(windowId), 0, 0n, ptr(event.buffer));
	x.XFlush(display);
	x.XCloseDisplay(display);
	return sent !== 0;
}

/** The ids of the windows with this exact title. */
export function windowsTitled(title: string): number[] {
	if (WINDOWS) {
		const ids = powershell(`Get-Process | Where-Object { $_.MainWindowTitle -eq '${title.replace(/'/g, "''")}' } | ForEach-Object { $_.Id }`);
		return ids.split(/\r?\n/).map(Number).filter(Boolean);
	}
	const found = Bun.spawnSync(["xdotool", "search", "--name", `^${title}$`]);
	return found.stdout.toString().split("\n").map(Number).filter(Boolean);
}
