// Atomic file replacement helpers for cross-platform safety.
import { renameSync } from "node:fs";

const WIN_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Atomically moves `temp` into place over `target`.
 * On Windows (NTFS), `rename` can transiently fail with `EPERM`, `EACCES`, or `EBUSY`
 * when a concurrent reader (or AV/indexer handle) briefly holds `target` open;
 * retry with short exponential backoff before failing.
 */
export async function renameReplacing(
	temp: string,
	target: string,
	options?: { rename?: (from: string, to: string) => void; win32?: boolean; baseDelayMs?: number },
): Promise<void> {
	const doRename = options?.rename ?? renameSync;
	const isWin = options?.win32 ?? process.platform === "win32";
	const baseDelay = options?.baseDelayMs ?? 10;
	const maxAttempts = isWin ? 6 : 1;
	for (let attempt = 0; ; attempt++) {
		try {
			doRename(temp, target);
			return;
		} catch (err: any) {
			const code = typeof err?.code === "string" ? err.code : "";
			if (attempt + 1 < maxAttempts && WIN_TRANSIENT_RENAME_CODES.has(code)) {
				await Bun.sleep(baseDelay * 2 ** attempt);
				continue;
			}
			throw err;
		}
	}
}
