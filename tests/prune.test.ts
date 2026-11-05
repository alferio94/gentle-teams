import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type RequestRecord, type Store } from "../lib/store.ts";
import { listDeliverableRequests, readCursor, writeCursor } from "../lib/delivery.ts";
import { createApproval } from "../lib/approvals.ts";
import { DAY_MS, lastActivity, pruneCandidates, removeRequests } from "../lib/prune.ts";
import { cleanupTemporary } from "../lib/tmp-cleanup.ts";

const WS = "tienda-online";

async function setup(): Promise<{ store: Store; root: string; done: () => Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-prune-"));
	const root = join(base, "multiagent");
	const store = openStore(root);
	await store.createTeam({ name: WS });
	await store.joinMember(WS, { alias: "frontend", repositoryRoot: "/repos/front" });
	await store.joinMember(WS, { alias: "backend", repositoryRoot: "/repos/back" });
	return { store, root, done: () => rm(base, { recursive: true, force: true }) };
}

const requestsDir = (root: string) => join(root, "teams", WS, "requests");
const later = (days: number) => () => Date.now() + days * DAY_MS;
const all = async () => true;
const ids = (views: { record: RequestRecord }[]) => views.map((v) => v.record.id);

/** A question frontend → backend answered by backend, fully received by both. */
async function answered(store: Store, title = "Q"): Promise<RequestRecord> {
	const q = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title, body: "" });
	await store.appendEvent(WS, q.id, { actor: "backend", transition: "complete", summary: "A" });
	await see(store, "backend", q.id, 1); // creation; its own answer is never delivered back
	await see(store, "frontend", q.id, 2); // the answer
	return q;
}

async function see(store: Store, alias: string, id: string, position: number): Promise<void> {
	const cursor = await readCursor(store, WS, alias);
	await writeCursor(store, WS, alias, { version: 1, seen: { ...cursor.seen, [id]: position } });
}

/** Every file under the store root with content. */
async function snapshot(root: string): Promise<string> {
	const files: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else files.push(`${path.slice(root.length)}=${await readFile(path, "utf8")}`);
		}
	};
	await walk(root);
	return files.sort().join("\u0000");
}

test("S20 a closed request is a candidate only when its last activity is older than the configured days", async () => {
	const { store, done } = await setup();
	try {
		const q = await answered(store);
		const view = await store.readRequest(WS, q.id);
		assert.equal(lastActivity(view), view.events[0]!.at, "the last event's time");
		const at = Date.parse(view.events[0]!.at);
		assert.deepEqual(ids(await pruneCandidates(store, WS, { days: 7, now: () => at + 7 * DAY_MS })), [], "exactly 7 days is not older");
		assert.deepEqual(ids(await pruneCandidates(store, WS, { days: 7, now: () => at + 7 * DAY_MS + 1 })), [q.id]);
		assert.deepEqual(ids(await pruneCandidates(store, WS, { days: 30, now: later(8) })), [], "the age is configurable");

		const cancelled = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "C", body: "" });
		await store.appendEvent(WS, cancelled.id, { actor: "frontend", transition: "cancel" });
		await see(store, "frontend", cancelled.id, 0);
		const declined = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: "D", body: "" });
		await store.appendEvent(WS, declined.id, { actor: "backend", transition: "decline" });
		await see(store, "backend", declined.id, 1);
		await see(store, "frontend", declined.id, 2);
		const failed = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: "F", body: "" });
		for (const transition of ["accept", "start", "fail"] as const) await store.appendEvent(WS, failed.id, { actor: "backend", transition });
		await see(store, "backend", failed.id, 1);
		await see(store, "frontend", failed.id, 4);
		assert.deepEqual(ids(await pruneCandidates(store, WS, { days: 7, now: later(8) })), [q.id, cancelled.id, declined.id, failed.id], "declined, cancelled, completed, failed");
	} finally {
		await done();
	}
});

test("S20 a request without events counts from its creation; open requests are never candidates", async () => {
	const { store, done } = await setup();
	try {
		const open = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: "Open", body: "" });
		const accepted = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: "Accepted", body: "" });
		await store.appendEvent(WS, accepted.id, { actor: "backend", transition: "accept" });
		await see(store, "backend", open.id, 1);
		await see(store, "backend", accepted.id, 1);
		await see(store, "frontend", accepted.id, 2);
		assert.equal(lastActivity(await store.readRequest(WS, open.id)), open.createdAt);
		assert.deepEqual(await pruneCandidates(store, WS, { days: 1, now: later(400) }), []);
	} finally {
		await done();
	}
});

test("S20 a closed request an open request depends on is kept; a closed dependent does not protect it", async () => {
	const { store, done } = await setup();
	try {
		const needed = await answered(store, "needed");
		const free = await answered(store, "free");
		await store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: "Open", body: "", dependsOn: [needed.id] });
		const closedDependent = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "Closed", body: "", dependsOn: [free.id] });
		await store.appendEvent(WS, closedDependent.id, { actor: "frontend", transition: "cancel" });
		assert.deepEqual(ids(await pruneCandidates(store, WS, { days: 7, now: later(8) })), [free.id, closedDependent.id]);
	} finally {
		await done();
	}
});

test("S20 a closed request a current party has not fully received is kept until its cursor covers it", async () => {
	const { store, done } = await setup();
	try {
		const q = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "Q", body: "" });
		await store.appendEvent(WS, q.id, { actor: "backend", transition: "complete", summary: "A" });
		await see(store, "backend", q.id, 1);
		assert.deepEqual(await pruneCandidates(store, WS, { days: 7, now: later(8) }), [], "the requester has not received the answer");
		await see(store, "frontend", q.id, 2);
		assert.deepEqual(ids(await pruneCandidates(store, WS, { days: 7, now: later(8) })), [q.id]);

		// A requester's comment the recipient never received also protects it.
		const c = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "C", body: "" });
		await see(store, "backend", c.id, 1);
		await store.appendEvent(WS, c.id, { actor: "frontend", transition: "comment", summary: "more" });
		await store.appendEvent(WS, c.id, { actor: "frontend", transition: "cancel" });
		assert.deepEqual(ids(await pruneCandidates(store, WS, { days: 7, now: later(8) })), [q.id]);
		await see(store, "backend", c.id, 3);
		assert.deepEqual(ids(await pruneCandidates(store, WS, { days: 7, now: later(8) })), [q.id, c.id]);
	} finally {
		await done();
	}
});

test("S20 a party that left the team no longer protects a request", async () => {
	const { store, done } = await setup();
	try {
		await store.joinMember(WS, { alias: "admin", repositoryRoot: "/repos/admin" });
		const q = await store.createRequest(WS, { from: "admin", to: "backend", kind: "question", title: "Q", body: "" });
		await store.appendEvent(WS, q.id, { actor: "backend", transition: "complete", summary: "A" });
		await see(store, "backend", q.id, 1);
		assert.deepEqual(await pruneCandidates(store, WS, { days: 7, now: later(8) }), [], "admin has not received the answer");
		await store.leaveMember(WS, "admin");
		assert.deepEqual(ids(await pruneCandidates(store, WS, { days: 7, now: later(8) })), [q.id]);
	} finally {
		await done();
	}
});

test("S20 removal deletes the request with its events and approvals, drops it from writable cursors, and touches nothing else", async () => {
	const { store, root, done } = await setup();
	try {
		const old = await answered(store, "old");
		await createApproval(store, WS, { requestId: old.id, recipient: "backend", toolName: "bash", input: { command: "x" } });
		const keep = await answered(store, "not asked for");
		await store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "open", body: "" });
		const before = await snapshot(root);

		const removed = await removeRequests(store, WS, [old.id], { days: 7, now: later(8), canWriteCursor: async (alias) => alias === "backend" });
		assert.deepEqual(removed, [old.id]);
		assert.deepEqual((await readdir(requestsDir(root))).filter((n) => n.startsWith(".")), [], "no temporary directory is left");
		assert.equal((await readdir(requestsDir(root))).includes(old.id), false);
		await assert.rejects(store.readRequest(WS, old.id), { code: "unknown-request" });
		assert.deepEqual(await readCursor(store, WS, "backend"), { version: 1, seen: { [keep.id]: 1 } }, "dropped from a writable cursor");
		assert.deepEqual(await readCursor(store, WS, "frontend"), { version: 1, seen: { [old.id]: 2, [keep.id]: 2 } }, "a live peer's cursor is left to its own session");

		const without = (text: string) =>
			text
				.split("\u0000")
				.filter((file) => !file.includes(`/requests/${old.id}/`) && !file.startsWith("/teams/tienda-online/cursors/backend.json="))
				.join("\u0000");
		assert.equal(without(await snapshot(root)), without(before), "nothing else changed");
	} finally {
		await done();
	}
});

test("S20 removeRequests re-checks each id: an open, recent, protected, or unknown id is never removed", async () => {
	const { store, root, done } = await setup();
	try {
		const open = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "open", body: "" });
		const needed = await answered(store, "needed");
		await store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: "dep", body: "", dependsOn: [needed.id] });
		const recent = await answered(store, "recent");
		const before = await snapshot(root);
		const removed = await removeRequests(store, WS, [open.id, needed.id, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", "../x"], {
			days: 7,
			now: later(8),
			canWriteCursor: all,
		});
		assert.deepEqual(removed, []);
		assert.deepEqual(await removeRequests(store, WS, [recent.id], { days: 7, now: later(1), canWriteCursor: all }), []);
		assert.equal(await snapshot(root), before);
	} finally {
		await done();
	}
});

test("S20 a concurrent reader never sees a partial request while requests are removed", async () => {
	const { store, done } = await setup();
	try {
		for (let round = 0; round < 15; round++) {
			const made: RequestRecord[] = [];
			for (let i = 0; i < 4; i++) {
				const c = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: `r${round}-${i}`, body: "" });
				for (const transition of ["accept", "start", "complete"] as const) await store.appendEvent(WS, c.id, { actor: "backend", transition });
				await see(store, "backend", c.id, 1);
				await see(store, "frontend", c.id, 4);
				made.push(c);
			}
			let stop = false;
			const seen: string[] = [];
			const unreadable: string[] = [];
			const reader = (async () => {
				while (!stop) {
					for (const view of await store.listRequests(WS)) seen.push(`${view.state}:${view.events.length}`);
					for (const view of await listDeliverableRequests(store, WS, (id) => void unreadable.push(id))) seen.push(`${view.state}:${view.events.length}`);
					for (const c of made) {
						try {
							const view = await store.readRequest(WS, c.id);
							seen.push(`${view.state}:${view.events.length}`);
						} catch (error) {
							assert.equal((error as { code?: string }).code, "unknown-request", String(error));
						}
					}
					await new Promise((r) => setImmediate(r));
				}
			})();
			const removed = await removeRequests(store, WS, made.map((c) => c.id), { days: 7, now: later(8), canWriteCursor: all });
			stop = true;
			await reader;
			assert.deepEqual(removed.sort(), made.map((c) => c.id).sort(), `round ${round}`);
			assert.deepEqual([...new Set(seen)].filter((s) => s !== "completed:3"), [], `round ${round}: only complete views were read`);
			assert.deepEqual(unreadable, []);
		}
	} finally {
		await done();
	}
});

test("S27 a dependency restored after the post-publication check is retried", async () => {
	const { store, root, done } = await setup();
	try {
		const dep = await answered(store);
		const path = join(requestsDir(root), dep.id);
		const hidden = join(requestsDir(root), ".tmp-hidden");
		let restored: Promise<void> = Promise.resolve();
		const racing = openStore(root, { afterRequestPublished: async () => {
			await rename(path, hidden);
			restored = new Promise<void>((resolve, reject) => setTimeout(() => { void rename(hidden, path).then(resolve, reject); }, 20));
		} });
		try {
			const created = await racing.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "new", body: "", dependsOn: [dep.id] });
			assert.deepEqual(created.dependsOn, [dep.id]);
			assert.equal((await store.readRequest(WS, created.id)).state, "requested");
		} finally { await restored; }
	} finally { await done(); }
});

test("S27 a dependency hidden at the initial check and restored is retried", async () => {
	const { store, root, done } = await setup();
	try {
		const dep = await answered(store);
		const path = join(requestsDir(root), dep.id);
		const hidden = join(requestsDir(root), ".tmp-hidden");
		await rename(path, hidden);
		const restored = new Promise<void>((resolve, reject) => setTimeout(() => { void rename(hidden, path).then(resolve, reject); }, 20));
		try {
			const created = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "new", body: "", dependsOn: [dep.id] });
			assert.deepEqual(created.dependsOn, [dep.id]);
		} finally { await restored; }
	} finally { await done(); }
});

test("S27 a truly unknown dependency fails with unknown-dependency and writes nothing", async () => {
	const { store, done } = await setup();
	try {
		const before = (await store.listRequests(WS)).map((view) => view.record.id);
		const missing = "01M6KWM44BZ855D0C33VQ2ECSR";
		await assert.rejects(
			store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "new", body: "", dependsOn: [missing] }),
			{ code: "unknown-dependency", message: `Dependency "${missing}" is not a request in team "${WS}".` },
		);
		assert.deepEqual((await store.listRequests(WS)).map((view) => view.record.id), before);
	} finally { await done(); }
});

test("R4-001 bind cleanup cannot delete a request hidden by pruning", async () => {
	const { store, done } = await setup();
	try {
		const q = await answered(store);
		const before = await store.readRequest(WS, q.id);
		await assert.rejects(removeRequests(store, WS, [q.id], { days: 7, now: later(8), canWriteCursor: all, hooks: {
			whileHidden: async () => { await cleanupTemporary(store, WS, later(8)); throw new Error("restore"); },
		} }), /restore/);
		assert.deepEqual(await store.readRequest(WS, q.id), before);
	} finally { await done(); }
});

test("S20 a new open request and the removal of its dependency never both succeed", async () => {
	const { store, done } = await setup();
	try {
		let created = 0;
		let removedCount = 0;
		for (let round = 0; round < 30; round++) {
			const dep = await answered(store, `dep-${round}`);
			const [made, removed] = await Promise.all([
				store
					.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: `new-${round}`, body: "", dependsOn: [dep.id] })
					.then(
						(record) => record,
						(error: { code?: string }) => {
							assert.equal(error.code, "unknown-dependency");
							return undefined;
						},
					),
				removeRequests(store, WS, [dep.id], { days: 7, now: later(8), canWriteCursor: all }),
			]);
			assert.ok(!(made && removed.length > 0), `round ${round}: both succeeded`);
			if (made) {
				created++;
				assert.equal((await store.readRequest(WS, dep.id)).record.id, dep.id, "the dependency of an open request exists");
				await store.appendEvent(WS, made.id, { actor: "frontend", transition: "cancel" }); // keep the next rounds independent
			} else {
				removedCount += removed.length;
			}
			const open = (await store.listRequests(WS)).filter((v) => v.state === "requested" || v.state === "accepted");
			for (const v of open) for (const d of v.record.dependsOn) assert.ok((await readdir(join(store.root, "teams", WS, "requests"))).includes(d));
		}
		assert.ok(created + removedCount <= 30);
	} finally {
		await done();
	}
});
