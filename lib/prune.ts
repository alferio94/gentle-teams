/**
 * History cleanup (feature spec S20, docs/architecture.md §3 "Cleanup").
 *
 * A closed request (declined, cancelled, completed, failed) whose last activity (its
 * last event's `at`, or `createdAt` without events) is older than
 * `pruneClosedAfterDays` days is removed with its events and approvals, unless:
 * - an open request lists it in `dependsOn`; or
 * - a current party member has not received all of it yet (its cursor still has
 *   pending deliveries on it, as computed by delivery's pendingDeliveries).
 *
 * Removal is atomic per request: the request directory is renamed to a `.hidden-*` name
 * inside `requests/` (readers skip dot names and treat a vanished request as never
 * listed), the dependents are checked again, and only then is it deleted. A request
 * that gained an open dependent meanwhile is renamed back. Terminal requests accept no
 * events, so no writer competes with the removal.
 *
 * Cursors: a member's cursor has a single writer, the session bound to it (§3). So
 * pruned ids are dropped here only from the cursors `canWriteCursor` allows (the
 * session passes only its own bound member); every other member's session drops
 * them from its own cursor once they stay missing past the grace period.
 */

import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { listDeliverableRequests, pendingDeliveries, readCursor, writeCursor, type Cursor } from "./delivery.ts";
import { isTerminal } from "./lifecycle.ts";
import { hasCode, hiddenName, teamDir, type RequestView, type Store } from "./store.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
	/** `pruneClosedAfterDays` from the config. */
	days: number;
	now?: () => number;
}

export interface RemoveOptions extends PruneOptions {
	/** Whether this caller may rewrite `alias`'s cursor (see the module comment). */
	canWriteCursor(alias: string): Promise<boolean>;
	/** Test seams to recreate concurrent steps deterministically. */
	hooks?: {
		/** After the candidates are computed, before a request is hidden. */
		beforeHide?(id: string): Promise<void>;
		/** While a request is hidden, before its dependents are checked again. */
		whileHidden?(id: string): Promise<void>;
	};
}

/** When the request last changed: its last event, or its creation. */
export const lastActivity = (view: RequestView): string => view.events.at(-1)?.at ?? view.record.createdAt;

const requestsDir = (store: Store, ws: string) => join(teamDir(store.root, ws), "requests");

/** Ids an open request depends on. */
const openDependencies = (views: readonly RequestView[]): Set<string> =>
	new Set(views.filter((v) => !isTerminal(v.state)).flatMap((v) => v.record.dependsOn));

/** Closed requests old enough to remove and not protected, oldest id first. Reads only. */
export async function pruneCandidates(store: Store, ws: string, options: PruneOptions): Promise<RequestView[]> {
	const now = (options.now ?? Date.now)();
	const views = await listDeliverableRequests(store, ws, () => undefined);
	const members = new Set((await store.listMembers(ws)).map((m) => m.alias));
	const needed = openDependencies(views);
	const cursors = new Map<string, Cursor | undefined>();
	const cursorOf = async (alias: string) => {
		if (!cursors.has(alias)) cursors.set(alias, await readCursor(store, ws, alias).catch(() => undefined));
		return cursors.get(alias);
	};
	const out: RequestView[] = [];
	for (const view of views) {
		if (!isTerminal(view.state) || needed.has(view.record.id)) continue;
		const at = Date.parse(lastActivity(view));
		if (!Number.isFinite(at) || now - at <= options.days * DAY_MS) continue;
		let received = true;
		for (const alias of new Set([view.record.from, view.record.to])) {
			if (!members.has(alias)) continue; // a party that left receives nothing any more
			const cursor = await cursorOf(alias);
			// An unreadable cursor proves nothing: keep the request.
			if (!cursor || pendingDeliveries([view], cursor, alias).length > 0) received = false;
		}
		if (received) out.push(view);
	}
	return out;
}

/**
 * Remove the given requests if they are still candidates, then drop them from the
 * cursors this caller may write. Returns the ids actually removed.
 */
export async function removeRequests(store: Store, ws: string, ids: readonly string[], options: RemoveOptions): Promise<string[]> {
	const wanted = new Set(ids);
	const candidates = (await pruneCandidates(store, ws, options)).filter((v) => wanted.has(v.record.id));
	const dir = requestsDir(store, ws);
	const removed: string[] = [];
	for (const view of candidates) {
		const id = view.record.id;
		const hidden = join(dir, hiddenName());
		await options.hooks?.beforeHide?.(id);
		try {
			await rename(join(dir, id), hidden);
		} catch (error) {
			if (hasCode(error, "ENOENT")) continue; // removed by another session meanwhile
			throw error;
		}
		// createRequest checks dependencies again after publishing; checking here after
		// hiding means a new open dependent and this removal never both succeed.
		let dependent: boolean;
		try {
			await options.hooks?.whileHidden?.(id);
			dependent = openDependencies(await listDeliverableRequests(store, ws, () => undefined)).has(id);
		} catch (error) {
			await rename(hidden, join(dir, id));
			throw error;
		}
		if (dependent) {
			await rename(hidden, join(dir, id));
			continue;
		}
		await rm(hidden, { recursive: true, force: true });
		removed.push(id);
	}
	if (removed.length > 0) await dropFromCursors(store, ws, removed, options.canWriteCursor);
	return removed;
}

async function dropFromCursors(store: Store, ws: string, ids: readonly string[], canWrite: (alias: string) => Promise<boolean>): Promise<void> {
	for (const member of await store.listMembers(ws)) {
		if (!(await canWrite(member.alias).catch(() => false))) continue;
		const cursor = await readCursor(store, ws, member.alias).catch(() => undefined);
		if (!cursor || !ids.some((id) => id in cursor.seen)) continue;
		const seen = Object.fromEntries(Object.entries(cursor.seen).filter(([id]) => !ids.includes(id)));
		await writeCursor(store, ws, member.alias, { version: 1, seen });
	}
}

/** `removed N closed requests older than D days.` wording, shared by the bind notice and the screen. */
export const countText = (n: number): string => `${n} closed request${n === 1 ? "" : "s"}`;
export const ageText = (days: number): string => `older than ${days} day${days === 1 ? "" : "s"}`;
