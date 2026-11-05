import { randomBytes } from "node:crypto";
import { link, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hasCode, publishFile, hiddenName } from "./store.ts";

interface LockFile { pid: number; token: string }

function defaultIsProcessAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return hasCode(error, "EPERM"); }
}

/** Remove only the lock content observed by the caller. */
async function breakLock(dir: string, name: string, observed: string): Promise<void> {
	const trash = join(dir, hiddenName());
	try { await rename(join(dir, name), trash); } catch (error) {
		if (hasCode(error, "ENOENT")) return;
		throw error;
	}
	const moved = await readFile(trash, "utf8").catch(() => "");
	if (moved !== observed) await link(trash, join(dir, name)).catch(() => undefined);
	await unlink(trash).catch(() => undefined);
}

export async function withLock<T>(dir: string, name: string, fn: () => Promise<T>, options: {
	waitMs: number; pid?: number; isProcessAlive?: (pid: number) => boolean; onTimeout: () => never;
}): Promise<T> {
	const content = JSON.stringify({ pid: options.pid ?? process.pid, token: randomBytes(12).toString("hex") } satisfies LockFile);
	const deadline = Date.now() + options.waitMs;
	for (;;) {
		if (await publishFile(dir, name, content)) break;
		const observed = await readFile(join(dir, name), "utf8").catch(() => undefined);
		if (observed !== undefined) {
			let holder: LockFile | undefined;
			try { holder = JSON.parse(observed) as LockFile; } catch { holder = undefined; }
			if (!holder || typeof holder.pid !== "number" || !(options.isProcessAlive ?? defaultIsProcessAlive)(holder.pid)) {
				await breakLock(dir, name, observed);
				continue;
			}
		}
		if (Date.now() >= deadline) options.onTimeout();
		await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 8)));
	}
	try { return await fn(); } finally {
		const current = await readFile(join(dir, name), "utf8").catch(() => undefined);
		if (current === content) await unlink(join(dir, name)).catch(() => undefined);
	}
}
