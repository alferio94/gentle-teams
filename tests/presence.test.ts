import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../lib/store.ts";
import { HEARTBEAT_INTERVAL_MS, OFFLINE_AFTER_MS, openPresence, type PresenceRecord } from "../lib/presence.ts";

const WS = "tienda-online";
const T0 = Date.parse("2026-11-03T12:00:00.000Z");

async function setup(): Promise<{ store: Store; root: string; presenceDir: string; done: () => Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-presence-"));
	const root = join(base, "multiagent");
	const store = openStore(root);
	await store.createTeam({ name: WS });
	await store.joinMember(WS, { alias: "frontend", repositoryRoot: "/repos/front" });
	await store.joinMember(WS, { alias: "backend", repositoryRoot: "/repos/back" });
	return { store, root, presenceDir: join(root, "teams", WS, "presence"), done: () => rm(base, { recursive: true, force: true }) };
}

function clock(start = T0): { now: () => number; set: (ms: number) => void } {
	let t = start;
	return { now: () => t, set: (ms) => (t = ms) };
}

/** The stored record without its per-claim token, which is asserted to be present and random-looking. */
async function readPresence(dir: string, alias: string): Promise<PresenceRecord | undefined> {
	let stored: PresenceRecord & { token?: unknown };
	try {
		stored = JSON.parse(await readFile(join(dir, `${alias}.json`), "utf8"));
	} catch {
		return undefined;
	}
	const { token, ...rest } = stored;
	assert.match(String(token), /^[0-9a-f]{32}$/, "the stored record carries a per-claim token");
	return rest;
}

const rawPresence = async (dir: string, alias: string) => readFile(join(dir, `${alias}.json`), "utf8");

const visible = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith(".")).sort();

const MEMBER_BOUND = { name: "TeamStoreError", code: "member-bound", message: 'Member "backend" is bound to another live session.' };

test("S7 constants: heartbeat every 5 s, offline after 15 s", () => {
	assert.equal(HEARTBEAT_INTERVAL_MS, 5000);
	assert.equal(OFFLINE_AFTER_MS, 15000);
});

test("S7 claim writes a private presence record with the session, pid, state and heartbeat", async () => {
	const { store, presenceDir, done } = await setup();
	try {
		const c = clock();
		const presence = openPresence(store, { now: c.now, pid: 4242 });
		const result = await presence.claim(WS, "backend", { sessionId: "s-1" });
		const expected: PresenceRecord = { sessionId: "s-1", pid: 4242, state: "idle", heartbeatAt: new Date(T0).toISOString() };
		assert.deepEqual(result, { record: expected, tookOver: false });
		assert.deepEqual(await readPresence(presenceDir, "backend"), expected);
		assert.equal((await stat(join(presenceDir, "backend.json"))).mode & 0o777, 0o600);
		assert.equal((await stat(presenceDir)).mode & 0o777, 0o700);
		assert.deepEqual(await visible(presenceDir), ["backend.json"]);
		assert.deepEqual(await readdir(presenceDir), ["backend.json"], "no temp or lock files are left behind");
	} finally {
		await done();
	}
});

test("S7 a fresh heartbeat of another session blocks the claim with member-bound and keeps the record", async () => {
	const { store, presenceDir, done } = await setup();
	try {
		const c = clock();
		const presence = openPresence(store, { now: c.now, pid: 1 });
		await presence.claim(WS, "backend", { sessionId: "s-1" });
		const before = await readPresence(presenceDir, "backend");
		c.set(T0 + OFFLINE_AFTER_MS); // exactly 15 s old: still fresh
		await assert.rejects(() => presence.claim(WS, "backend", { sessionId: "s-2" }), MEMBER_BOUND);
		assert.deepEqual(await readPresence(presenceDir, "backend"), before);
	} finally {
		await done();
	}
});

test("S7 a heartbeat older than 15 s is offline and the claim takes it over", async () => {
	const { store, presenceDir, done } = await setup();
	try {
		const c = clock();
		const presence = openPresence(store, { now: c.now, pid: 7 });
		await presence.claim(WS, "backend", { sessionId: "s-1" });
		assert.equal((await presence.status(WS, "backend")).online, true);
		c.set(T0 + OFFLINE_AFTER_MS + 1);
		assert.deepEqual(await presence.status(WS, "backend"), { online: false });
		const result = await presence.claim(WS, "backend", { sessionId: "s-2" });
		const expected: PresenceRecord = { sessionId: "s-2", pid: 7, state: "idle", heartbeatAt: new Date(T0 + OFFLINE_AFTER_MS + 1).toISOString() };
		assert.deepEqual(result, { record: expected, tookOver: true });
		assert.deepEqual(await readPresence(presenceDir, "backend"), expected);
		assert.deepEqual(await readdir(presenceDir), ["backend.json"]);
	} finally {
		await done();
	}
});

test("S7 a missing heartbeat is offline", async () => {
	const { store, done } = await setup();
	try {
		const presence = openPresence(store, { now: clock().now });
		assert.deepEqual(await presence.status(WS, "backend"), { online: false });
	} finally {
		await done();
	}
});

test("S7 the same session re-claiming refreshes its own record", async () => {
	const { store, presenceDir, done } = await setup();
	try {
		const c = clock();
		const presence = openPresence(store, { now: c.now, pid: 1 });
		await presence.claim(WS, "backend", { sessionId: "s-1" });
		c.set(T0 + 1000);
		const result = await presence.claim(WS, "backend", { sessionId: "s-1", state: "active" });
		assert.equal(result.tookOver, false);
		assert.deepEqual(await readPresence(presenceDir, "backend"), {
			sessionId: "s-1",
			pid: 1,
			state: "active",
			heartbeatAt: new Date(T0 + 1000).toISOString(),
		});
	} finally {
		await done();
	}
});

test("S7 claiming an unknown member or team fails without writing presence", async () => {
	const { store, root, presenceDir, done } = await setup();
	try {
		const presence = openPresence(store, { now: clock().now });
		await assert.rejects(() => presence.claim(WS, "admin", { sessionId: "s-1" }), {
			name: "TeamStoreError",
			code: "unknown-member",
			message: 'Member "admin" is not part of team "tienda-online".',
		});
		await assert.rejects(() => presence.claim(WS, "../x", { sessionId: "s-1" }), { code: "unknown-member" });
		await assert.rejects(() => presence.claim("nope", "backend", { sessionId: "s-1" }), {
			code: "unknown-team",
			message: 'Team "nope" does not exist.',
		});
		assert.deepEqual(await visible(presenceDir), []);
		assert.deepEqual(await readdir(join(root, "teams")), [WS]);
	} finally {
		await done();
	}
});

test("S7 heartbeat refreshes the owner's record and state, and reports a lost binding", async () => {
	const { store, presenceDir, done } = await setup();
	try {
		const c = clock();
		const presence = openPresence(store, { now: c.now, pid: 1 });
		await presence.claim(WS, "backend", { sessionId: "s-1" });
		c.set(T0 + HEARTBEAT_INTERVAL_MS);
		assert.equal(await presence.heartbeat(WS, "backend", { sessionId: "s-1", state: "active" }), true);
		assert.deepEqual(await readPresence(presenceDir, "backend"), {
			sessionId: "s-1",
			pid: 1,
			state: "active",
			heartbeatAt: new Date(T0 + HEARTBEAT_INTERVAL_MS).toISOString(),
		});

		// s-1 stalls; s-2 takes over; s-1's next heartbeat must not overwrite s-2.
		c.set(T0 + HEARTBEAT_INTERVAL_MS + OFFLINE_AFTER_MS + 1);
		await presence.claim(WS, "backend", { sessionId: "s-2" });
		const owner = await readPresence(presenceDir, "backend");
		assert.equal(await presence.heartbeat(WS, "backend", { sessionId: "s-1", state: "idle" }), false);
		assert.deepEqual(await readPresence(presenceDir, "backend"), owner);
	} finally {
		await done();
	}
});

test("S7 release removes the record only when it still belongs to this session", async () => {
	const { store, presenceDir, done } = await setup();
	try {
		const c = clock();
		const presence = openPresence(store, { now: c.now, pid: 1 });
		await presence.claim(WS, "backend", { sessionId: "s-1" });
		assert.equal(await presence.release(WS, "backend", "s-other"), false);
		assert.equal((await readPresence(presenceDir, "backend"))?.sessionId, "s-1");
		assert.equal(await presence.release(WS, "backend", "s-1"), true);
		assert.deepEqual(await readdir(presenceDir), []);
		assert.equal(await presence.release(WS, "backend", "s-1"), false);
	} finally {
		await done();
	}
});

test("S7 concurrent claims of a free member let exactly one session win", async () => {
	const { store, presenceDir, done } = await setup();
	try {
		const presence = openPresence(store, { now: clock().now });
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, (_, i) => presence.claim(WS, "backend", { sessionId: `s-${i}` })),
		);
		const winners = results.filter((r) => r.status === "fulfilled");
		assert.equal(winners.length, 1);
		for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { code: string }).code, "member-bound");
		const won = (winners[0] as PromiseFulfilledResult<{ record: PresenceRecord }>).value.record.sessionId;
		assert.equal((await readPresence(presenceDir, "backend"))?.sessionId, won);
		assert.deepEqual(await readdir(presenceDir), ["backend.json"]);
	} finally {
		await done();
	}
});

test("S7 concurrent takeovers of an offline member let exactly one session win", async () => {
	const { store, presenceDir, done } = await setup();
	try {
		const c = clock();
		const presence = openPresence(store, { now: c.now });
		await presence.claim(WS, "backend", { sessionId: "old" });
		c.set(T0 + OFFLINE_AFTER_MS + 1);
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, (_, i) => presence.claim(WS, "backend", { sessionId: `s-${i}` })),
		);
		const winners = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ record: PresenceRecord; tookOver: boolean }>[];
		assert.equal(winners.length, 1);
		assert.equal(winners[0]!.value.tookOver, true);
		for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { code: string }).code, "member-bound");
		assert.equal((await readPresence(presenceDir, "backend"))?.sessionId, winners[0]!.value.record.sessionId);
	} finally {
		await done();
	}
});

test("S7 a lock left by a dead process is broken, a lock of a live process is respected", async () => {
	const { store, presenceDir, done } = await setup();
	try {
		const c = clock();
		const presence = openPresence(store, { now: c.now, isProcessAlive: (pid) => pid !== 999_999, lockWaitMs: 50 });
		await presence.claim(WS, "frontend", { sessionId: "init" }); // creates the presence directory
		await writeFile(join(presenceDir, ".lock-backend"), JSON.stringify({ pid: 999_999, token: "dead" }), { mode: 0o600 });
		const result = await presence.claim(WS, "backend", { sessionId: "s-1" });
		assert.equal(result.record.sessionId, "s-1");
		assert.deepEqual((await readdir(presenceDir)).sort(), ["backend.json", "frontend.json"]);

		await writeFile(join(presenceDir, ".lock-frontend"), JSON.stringify({ pid: process.pid, token: "live" }), { mode: 0o600 });
		await assert.rejects(() => presence.claim(WS, "frontend", { sessionId: "s-2" }), {
			name: "TeamStoreError",
			code: "store-busy",
			message: 'Presence of member "frontend" is locked by another session; retry.',
		});
		assert.equal((await readPresence(presenceDir, "frontend"))?.sessionId, "init");
	} finally {
		await done();
	}
});

test("S7/D3 a second instance with the same sessionId (another process) cannot bind, beat, or release the member", async () => {
	const { store, presenceDir, done } = await setup();
	try {
		const c = clock();
		const first = openPresence(store, { now: c.now, pid: 1 });
		const second = openPresence(store, { now: c.now, pid: 2 });
		await first.claim(WS, "backend", { sessionId: "s-1" });
		const before = await rawPresence(presenceDir, "backend");
		await assert.rejects(() => second.claim(WS, "backend", { sessionId: "s-1" }), MEMBER_BOUND);
		assert.equal(await rawPresence(presenceDir, "backend"), before);
		assert.equal((await readPresence(presenceDir, "backend"))?.pid, 1);

		c.set(T0 + 1000);
		assert.equal(await second.heartbeat(WS, "backend", { sessionId: "s-1", state: "active" }), false);
		assert.equal(await second.release(WS, "backend", "s-1"), false);
		assert.equal(await rawPresence(presenceDir, "backend"), before, "heartbeat and release by a non-holder change nothing");

		// The holder keeps working.
		assert.equal(await first.heartbeat(WS, "backend", { sessionId: "s-1", state: "active" }), true);
		assert.equal((await readPresence(presenceDir, "backend"))?.heartbeatAt, new Date(T0 + 1000).toISOString());

		// Once the holder is offline, the other instance takes over and the old holder loses it.
		c.set(T0 + 1000 + OFFLINE_AFTER_MS + 1);
		const taken = await second.claim(WS, "backend", { sessionId: "s-1" });
		assert.equal(taken.tookOver, true);
		assert.equal((await readPresence(presenceDir, "backend"))?.pid, 2);
		const owner = await rawPresence(presenceDir, "backend");
		assert.equal(await first.heartbeat(WS, "backend", { sessionId: "s-1", state: "idle" }), false);
		assert.equal(await first.release(WS, "backend", "s-1"), false);
		assert.equal(await rawPresence(presenceDir, "backend"), owner);
		assert.equal(await second.release(WS, "backend", "s-1"), true);
		assert.deepEqual(await readdir(presenceDir), []);
	} finally {
		await done();
	}
});
