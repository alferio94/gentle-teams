/**
 * Presence and binding (feature spec S7, docs/architecture.md §3 and §5).
 *
 * A bound session owns `teams/<ws>/presence/<alias>.json`:
 * `{ sessionId, pid, state, heartbeatAt, token }`; `token` identifies the claim, and
 * only the presence instance that made it may refresh or remove the file. A member is offline when that file is
 * missing or its heartbeat is older than OFFLINE_AFTER_MS.
 *
 * Every mutation of a presence file (claim, takeover, heartbeat, release) runs under
 * a per-member lock file `.lock-<alias>`, created with link(2) so only one holder
 * exists. The presence file itself is also created with link(2), so even without the
 * lock two sessions can never both create it. A lock whose holder process is dead is
 * broken; a lock held by a live process is waited for, then reported as `store-busy`.
 */

import { unlink } from "node:fs/promises";
import { withLock as withFileLock } from "./lock.ts";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
	ALIAS_PATTERN,
	fail,
	hasCode,
	json,
	mkdirPrivate,
	publishFile,
	readJson,
	replaceFile,
	teamDir,
	type Store,
} from "./store.ts";

export const HEARTBEAT_INTERVAL_MS = 5000;
export const OFFLINE_AFTER_MS = 15000;
const DEFAULT_LOCK_WAIT_MS = 2000;

export type PresenceState = "active" | "idle";

export interface PresenceRecord {
	sessionId: string;
	pid: number;
	state: PresenceState;
	heartbeatAt: string;
}

/** On disk the record also carries the token of the claim that wrote it. */
interface StoredPresence extends PresenceRecord {
	token: string;
}

export type PresenceStatus = { online: false } | { online: true; record: PresenceRecord };

export interface PresenceOptions {
	now?: () => number;
	pid?: number;
	isProcessAlive?: (pid: number) => boolean;
	/** How long to wait for a lock held by a live process before failing with `store-busy`. */
	lockWaitMs?: number;
}

export interface Presence {
	status(team: string, alias: string): Promise<PresenceStatus>;
	claim(team: string, alias: string, input: { sessionId: string; state?: PresenceState }): Promise<{ record: PresenceRecord; tookOver: boolean }>;
	/** Refresh this session's heartbeat. Returns false when the member is no longer bound to it. */
	heartbeat(team: string, alias: string, input: { sessionId: string; state: PresenceState }): Promise<boolean>;
	/** Remove the presence file if it still belongs to this session. */
	release(team: string, alias: string, sessionId: string): Promise<boolean>;
}

export function isFresh(record: PresenceRecord, nowMs: number): boolean {
	const at = Date.parse(record.heartbeatAt);
	return Number.isFinite(at) && nowMs - at <= OFFLINE_AFTER_MS;
}

export function openPresence(store: Store, options: PresenceOptions = {}): Presence {
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const isProcessAlive = options.isProcessAlive;
	const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;

	const presenceDir = (ws: string) => join(teamDir(store.root, ws), "presence");

	async function requireMember(ws: string, alias: string): Promise<void> {
		await store.getTeam(ws);
		const known = ALIAS_PATTERN.test(alias) && (await store.listMembers(ws)).some((m) => m.alias === alias);
		if (!known) fail("unknown-member", `Member "${alias}" is not part of team "${ws}".`);
	}

	async function withLock<T>(ws: string, alias: string, fn: (dir: string) => Promise<T>): Promise<T> {
		return store.withActiveTeamLock(ws, async () => {
			const dir = presenceDir(ws);
			await mkdirPrivate(dir);
			return withFileLock(dir, `.lock-${alias}`, () => fn(dir), {
				pid, isProcessAlive, waitMs: lockWaitMs,
				onTimeout: () => fail("store-busy", `Presence of member "${alias}" is locked by another session; retry.`),
			});
		});
	}

	const record = (sessionId: string, state: PresenceState): PresenceRecord => ({
		sessionId,
		pid,
		state,
		heartbeatAt: new Date(now()).toISOString(),
	});

	const fileName = (alias: string) => `${alias}.json`;

	// Ownership is the claim, not the session id: two processes resuming the same Pi
	// session (`pi --continue` twice) share a sessionId, so each claim gets a random
	// token that only this instance knows. Heartbeat and release require it.
	const held = new Map<string, string>();
	const key = (ws: string, alias: string, sessionId: string) => JSON.stringify([ws, alias, sessionId]);
	const stored = (base: PresenceRecord, token: string): StoredPresence => ({ ...base, token });
	const publicRecord = ({ token: _token, ...rest }: StoredPresence): PresenceRecord => rest;
	const owns = (current: StoredPresence | undefined, ws: string, alias: string, sessionId: string): current is StoredPresence => {
		const token = held.get(key(ws, alias, sessionId));
		return current !== undefined && token !== undefined && current.sessionId === sessionId && current.token === token;
	};

	return {
		async status(ws, alias) {
			await requireMember(ws, alias);
			const current = await readJson<StoredPresence>(join(presenceDir(ws), fileName(alias)));
			return current && isFresh(current, now()) ? { online: true, record: publicRecord(current) } : { online: false };
		},

		async claim(ws, alias, { sessionId, state = "idle" }) {
			await requireMember(ws, alias);
			return withLock(ws, alias, async (dir) => {
				await requireMember(ws, alias);
				const name = fileName(alias);
				const mine = record(sessionId, state);
				const k = key(ws, alias, sessionId);
				let current = await readJson<StoredPresence>(join(dir, name));
				if (owns(current, ws, alias, sessionId)) {
					await replaceFile(dir, name, json(stored(mine, current.token)));
					return { record: mine, tookOver: false };
				}
				const token = randomBytes(16).toString("hex");
				if (!current) {
					if (await publishFile(dir, name, json(stored(mine, token)))) {
						held.set(k, token);
						return { record: mine, tookOver: false };
					}
					current = await readJson<StoredPresence>(join(dir, name));
				}
				if (current && isFresh(current, now())) {
					return fail("member-bound", `Member "${alias}" is bound to another live session.`);
				}
				// Offline holder: take over. Creation is exclusive, so a concurrent creator wins instead.
				await unlink(join(dir, name)).catch((error) => {
					if (!hasCode(error, "ENOENT")) throw error;
				});
				if (!(await publishFile(dir, name, json(stored(mine, token))))) {
					return fail("member-bound", `Member "${alias}" is bound to another live session.`);
				}
				held.set(k, token);
				return { record: mine, tookOver: true };
			});
		},

		async heartbeat(ws, alias, { sessionId, state }) {
			if (!ALIAS_PATTERN.test(alias)) fail("unknown-member", `Member "${alias}" is not part of team "${ws}".`);
			await store.getTeam(ws);
			return withLock(ws, alias, async (dir) => {
				const current = await readJson<StoredPresence>(join(dir, fileName(alias)));
				if (!owns(current, ws, alias, sessionId)) {
					held.delete(key(ws, alias, sessionId));
					return false;
				}
				await replaceFile(dir, fileName(alias), json(stored(record(sessionId, state), current.token)));
				return true;
			});
		},

		async release(ws, alias, sessionId) {
			if (!ALIAS_PATTERN.test(alias)) fail("unknown-member", `Member "${alias}" is not part of team "${ws}".`);
			await store.getTeam(ws);
			return withLock(ws, alias, async (dir) => {
				const current = await readJson<StoredPresence>(join(dir, fileName(alias)));
				const mine = owns(current, ws, alias, sessionId);
				held.delete(key(ws, alias, sessionId));
				if (!mine) return false;
				await unlink(join(dir, fileName(alias)));
				return true;
			});
		},
	};
}
