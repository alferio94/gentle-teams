/**
 * One-time migration of data written by the previous version (pi-workspaces) into the
 * teams layout (S22, docs/architecture.md §3):
 *
 *   <root>/workspaces/<name>/workspace.json   ->  <root>/teams/<name>/team.json
 *   top-level "workspace" field of every JSON  ->  "team" (key order preserved)
 *
 * Safety rules:
 * - Nothing is migrated while a heartbeat in the old tree is fresh: a session of the previous
 *   version may still be writing there.
 * - A root lock serializes migrations. Every team is staged before publication with rename(2);
 *   existing teams are compared against the whole visible staged tree and never overwritten.
 * - A failure while copying (invalid JSON, a symlink or special file) publishes nothing and
 *   leaves the old tree untouched.
 * - The old tree is never deleted: it is renamed to `workspaces.migrated-<timestamp>`.
 * - Hidden entries (temporary or pruning directories) are not copied.
 */

import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { withLock } from "./lock.ts";
import { join } from "node:path";
import { isFresh, type PresenceRecord } from "./presence.ts";
import { hasCode, json, mkdirPrivate, NAME_PATTERN, tmpName } from "./store.ts";

export const LEGACY_DIR = "workspaces";
const LEGACY_TEAM_FILE = "workspace.json";
const TEAM_FILE = "team.json";
const LEGACY_FIELD = "workspace";
const FIELD = "team";

export interface MigrationResult {
	/** Teams published by this call. */
	migrated: string[];
	/** Legacy teams whose name already exists under teams/; they stay only in the backup. */
	conflicts: string[];
	/** `<team>/<alias>` with a fresh heartbeat in the old tree; when non-empty nothing changed. */
	blockedBy: string[];
	/** Where the old tree was moved, when this call moved it. */
	backup?: string;
}

export interface MigrationOptions {
	now?: () => number;
}

const visibleNames = async (dir: string): Promise<string[]> =>
	(await readdir(dir)).filter((name) => !name.startsWith(".")).sort();

const notFound = (error: unknown) => hasCode(error, "ENOENT", "ENOTDIR");

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if (notFound(error)) return false;
		throw error;
	}
}

async function liveMembers(legacy: string, teams: string[], nowMs: number): Promise<string[]> {
	const live: string[] = [];
	for (const team of teams) {
		let files: string[];
		try {
			files = await visibleNames(join(legacy, team, "presence"));
		} catch (error) {
			if (notFound(error)) continue;
			throw error;
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			let record: PresenceRecord;
			try {
				record = JSON.parse(await readFile(join(legacy, team, "presence", file), "utf8")) as PresenceRecord;
			} catch {
				continue; // unreadable presence is not a live session
			}
			if (record && typeof record === "object" && isFresh(record, nowMs)) live.push(`${team}/${file.slice(0, -5)}`);
		}
	}
	return live;
}

function renameField(text: string, path: string): string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`Cannot migrate ${path}: it is not valid JSON; nothing was changed.`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, LEGACY_FIELD)) return text;
	const renamed: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) renamed[key === LEGACY_FIELD ? FIELD : key] = entry;
	return json(renamed);
}

const invalidEntry = (path: string) => new Error(`Cannot migrate ${path}: it is not a regular file or directory; nothing was changed.`);

async function validateTree(path: string): Promise<void> {
	const info = await lstat(path);
	if (info.isFile()) return;
	if (!info.isDirectory()) throw invalidEntry(path);
	for (const name of await readdir(path)) await validateTree(join(path, name));
}

async function sameTree(a: string, b: string): Promise<boolean> {
	let left, right;
	try { [left, right] = await Promise.all([lstat(a), lstat(b)]); } catch (error) {
		if (notFound(error)) return false;
		throw error;
	}
	if (left.isFile() && right.isFile()) return (await readFile(a)).equals(await readFile(b));
	if (!left.isDirectory() || !right.isDirectory()) return false;
	const [an, bn] = await Promise.all([visibleNames(a), visibleNames(b)]);
	if (an.length !== bn.length || an.some((name, i) => name !== bn[i])) return false;
	for (const name of an) if (!(await sameTree(join(a, name), join(b, name)))) return false;
	return true;
}

async function copyTree(from: string, to: string): Promise<void> {
	for (const entry of await readdir(from, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const source = join(from, entry.name);
		const info = await lstat(source);
		if (info.isDirectory()) {
			const target = join(to, entry.name);
			await mkdir(target, { mode: 0o700 });
			await copyTree(source, target);
		} else if (info.isFile()) {
			const bytes = await readFile(source);
			const name = entry.name === LEGACY_TEAM_FILE ? TEAM_FILE : entry.name;
			const content = entry.name.endsWith(".json") ? renameField(bytes.toString("utf8"), source) : bytes;
			await writeFile(join(to, name), content, { flag: "wx", mode: 0o600 });
		} else {
			// The store never writes symlinks or special files; refuse rather than guess.
			throw invalidEntry(source);
		}
	}
}

/** What to tell the human after a migration attempt; undefined when there was nothing to do. */
export function migrationMessage(result: MigrationResult, root: string): { level: "info" | "warning"; text: string } | undefined {
	const legacy = join(root, LEGACY_DIR);
	if (result.blockedBy.length > 0) {
		return {
			level: "warning",
			text: `teams: data from the previous version (pi-workspaces) is in ${legacy}, but a session of that version is still running (${result.blockedBy.join(", ")}). Close those sessions and restart this one to migrate it; until then those teams are not shown.`,
		};
	}
	const parts: string[] = [];
	if (result.migrated.length > 0) parts.push(`migrated ${result.migrated.join(", ")} from the previous version (pi-workspaces)`);
	if (result.conflicts.length > 0) parts.push(`${result.conflicts.join(", ")} already existed as a team and was not replaced`);
	if (parts.length === 0) return undefined;
	const backup = result.backup ? `; the original data is kept in ${result.backup}` : "";
	return { level: result.conflicts.length > 0 ? "warning" : "info", text: `teams: ${parts.join("; ")}${backup}.` };
}

export async function migrateLegacyWorkspaces(root: string, options: MigrationOptions = {}): Promise<MigrationResult> {
	const now = options.now ?? Date.now;
	const result: MigrationResult = { migrated: [], conflicts: [], blockedBy: [] };
	const legacy = join(root, LEGACY_DIR);
	try { await lstat(legacy); } catch (error) { if (notFound(error)) return result; throw error; }
	return withLock(root, ".lock-migrate", async () => {
	try {
		const info = await lstat(legacy);
		if (!info.isDirectory()) throw invalidEntry(legacy);
	} catch (error) { if (notFound(error)) return result; throw error; }
	await validateTree(legacy);

	let names: string[];
	try {
		names = (await visibleNames(legacy)).filter((name) => NAME_PATTERN.test(name));
	} catch (error) {
		if (notFound(error)) return result; // another session moved it first
		throw error;
	}

	result.blockedBy = await liveMembers(legacy, names, now());
	if (result.blockedBy.length > 0) return result;

	const teamsDir = join(root, "teams");
	const createdTeamsDir = !(await isDirectory(teamsDir));
	await mkdirPrivate(teamsDir);

	// Phase 1: copy every team into a hidden staging directory. Any failure removes every
	// staged copy, so nothing is published unless the whole old tree copied cleanly.
	const staged: { name: string; tmp: string }[] = [];
	const discard = async () => {
		await Promise.all(staged.map(({ tmp }) => rm(tmp, { recursive: true, force: true })));
		// Leave no trace of a failed first migration (rmdir refuses a non-empty directory).
		if (createdTeamsDir) await rmdir(teamsDir).catch(() => undefined);
	};
	try {
		for (const name of names) {
			const tmp = join(teamsDir, tmpName());
			await mkdir(tmp, { mode: 0o700 });
			staged.push({ name, tmp });
			await copyTree(join(legacy, name), tmp);
		}
	} catch (error) {
		await discard();
		// The old tree moved away while copying: another session migrated it.
		if (notFound(error) && !(await isDirectory(legacy))) return { migrated: [], conflicts: [], blockedBy: [] };
		throw error;
	}

	// Phase 2: publish. rename(2) fails onto an existing team, so a team is published once
	// and never overwritten, even when several sessions migrate at the same time.
	for (const { name, tmp } of staged) {
		const target = join(teamsDir, name);
		let exists = true;
		try { await lstat(target); } catch (error) { if (notFound(error)) exists = false; else throw error; }
		if (exists) {
			if (!(await sameTree(tmp, target))) result.conflicts.push(name);
			await rm(tmp, { recursive: true, force: true });
			continue;
		}
		try {
			await rename(tmp, target);
			result.migrated.push(name);
		} catch (error) {
			if (hasCode(error, "EEXIST", "ENOTEMPTY", "ENOTDIR")) {
				if (!(await sameTree(tmp, target))) result.conflicts.push(name);
				await rm(tmp, { recursive: true, force: true });
			} else {
				await discard();
				throw error;
			}
		}
	}

	const backup = join(root, `${LEGACY_DIR}.migrated-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`);
	try {
		await rename(legacy, backup);
		result.backup = backup;
	} catch (error) {
		if (!notFound(error) && !hasCode(error, "EEXIST", "ENOTEMPTY")) throw error;
	}
	return result;
	}, { waitMs: 30_000, onTimeout: () => { throw new Error("Migration is locked by another session; retry at the next session start."); } });
}
