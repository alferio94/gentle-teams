import { link, lstat, mkdir, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { hasCode, teamDir, type Store } from "./store.ts";
import { withLock } from "./lock.ts";

const MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remove abandoned temporary entries, without following symlinks or entering hidden directories.
 *
 * A `.tmp-*` entry is a candidate only when its mtime AND ctime are more than an hour old and,
 * for a directory, it holds no `request.json`. Sessions of a previous version hide stored
 * data (a request being pruned, a member being removed) by renaming it to `.tmp-*`; rename
 * keeps old mtimes but refreshes the ctime of the moved entry, and a hidden request always
 * holds its `request.json`, so data hidden by any version is never taken for an abandoned
 * build (review findings R1-001, R3-001, R4-001).
 */
export async function cleanupTemporary(store: Store, team: string, now: () => number = Date.now, hooks: { beforeIsolate?(path: string): Promise<void>; afterIsolate?(original: string, trash: string): Promise<void> } = {}): Promise<void> {
	await store.getTeam(team);
	const cutoff = now() - MAX_AGE_MS;
	async function allOld(path: string): Promise<boolean> {
		try {
			const info = await lstat(path);
			if (info.mtimeMs >= cutoff) return false;
			if (info.isDirectory()) {
				for (const name of await readdir(path)) {
					if (name.startsWith(".lock-") || !(await allOld(join(path, name)))) return false;
				}
			}
			return true;
		} catch (error) {
			if (hasCode(error, "ENOENT", "ENOTDIR")) return false;
			throw error;
		}
	}
	// Reserve the original name exclusively before restoring; never replace an entry
	// created by another writer while the candidate was isolated.
	async function restore(trash: string, original: string, directory: boolean): Promise<void> {
		if (!directory) {
			try { await link(trash, original); } catch (error) { if (hasCode(error, "EEXIST")) return; throw error; }
			await unlink(trash);
			return;
		}
		try { await mkdir(original); } catch (error) { if (hasCode(error, "EEXIST")) return; throw error; }
		try { await rename(trash, original); }
		catch (error) { await rmdir(original).catch(() => undefined); throw error; }
	}
	async function visit(dir: string): Promise<void> {
		let names: string[];
		try { names = await readdir(dir); }
		catch (error) { if (hasCode(error, "ENOENT", "ENOTDIR")) return; throw error; }
		for (const name of names) {
			const temporary = name.startsWith(".tmp-") || name.startsWith(".trash-");
			if (name.startsWith(".") && !temporary) continue;
			const path = join(dir, name);
			let info;
			try { info = await lstat(path); }
			catch (error) { if (hasCode(error, "ENOENT")) continue; throw error; }
			if (temporary) {
				if (info.mtimeMs >= cutoff || info.ctimeMs >= cutoff) continue;
				if (info.isDirectory() && (await lstat(join(path, "request.json")).then(() => true, () => false))) continue;
				if (!(await allOld(path))) continue;
				await hooks.beforeIsolate?.(path);
				const trash = join(dir, `.trash-${randomBytes(16).toString("hex")}`);
				try { await rename(path, trash); }
				catch (error) { if (hasCode(error, "ENOENT")) continue; throw error; }
				let safe = false;
				try {
					await hooks.afterIsolate?.(path, trash);
					const moved = await lstat(trash);
					safe = moved.dev === info.dev && moved.ino === info.ino && await allOld(trash);
				} finally {
					if (!safe) await restore(trash, path, info.isDirectory());
				}
				if (safe) await rm(trash, { recursive: true, force: true });
			} else if (info.isDirectory()) await visit(path);
		}
	}
	const root = teamDir(store.root, team);
	await withLock(root, ".lock-tmp-cleanup", () => visit(root), {
		waitMs: 30_000, onTimeout: () => { throw new Error("Temporary cleanup is busy; retry."); },
	});
}
