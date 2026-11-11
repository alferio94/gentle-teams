import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.ts";
import { openPresence } from "../lib/presence.ts";

test("S2: archive hides the team while preserving its files and reserving its name", async () => {
	const base = await mkdtemp(join(tmpdir(), "teams-archive-"));
	try {
		const store = openStore(base);
		const team = await store.createTeam({ name: "example", description: "preserve" });
		const file = join(base, "teams", "example", "team.json");
		const before = await readFile(file, "utf8");
		await store.archiveTeam(team.name);
		assert.deepEqual(await store.listTeams(), []);
		await assert.rejects(() => store.getTeam(team.name), { code: "unknown-team" });
		await assert.rejects(() => store.createTeam({ name: team.name }), { code: "team-name-taken" });
		assert.equal(await readFile(file, "utf8"), before);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("S3: archive rejects a working session without creating a marker", async () => {
	const base = await mkdtemp(join(tmpdir(), "teams-archive-"));
	try {
		const store = openStore(base);
		await store.createTeam({ name: "example" });
		await store.joinMember("example", { alias: "member", repositoryRoot: "/repos/example" });
		const presence = openPresence(store);
		await presence.claim("example", "member", { sessionId: "session", state: "active" });
		const before = await readFile(join(base, "teams", "example", "presence", "member.json"), "utf8");
		await assert.rejects(() => store.archiveTeam("example"), { code: "member-bound" });
		await assert.rejects(() => readFile(join(base, "teams", "example", ".archived.json")), { code: "ENOENT" });
		assert.equal(await readFile(join(base, "teams", "example", "presence", "member.json"), "utf8"), before);
		assert.equal((await store.listTeams()).length, 1);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("S3: idle live and disconnected sessions are revoked by archive", async () => {
	const base = await mkdtemp(join(tmpdir(), "teams-revoke-"));
	try {
		const store = openStore(base);
		await store.createTeam({ name: "example" });
		await store.joinMember("example", { alias: "a", repositoryRoot: "/repos/a" });
		await store.joinMember("example", { alias: "b", repositoryRoot: "/repos/b" });
		const live = openPresence(store);
		await live.claim("example", "a", { sessionId: "live", state: "idle" });
		await openPresence(store, { now: () => 0, pid: 2147483647 }).claim("example", "b", { sessionId: "gone", state: "active" });
		await store.archiveTeam("example");
		assert.deepEqual(await store.listTeams(), []);
		await assert.rejects(() => live.heartbeat("example", "a", { sessionId: "live", state: "active" }), { code: "unknown-team" });
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("S2/S3: open requests block; completed history and repository survive archive", async () => {
	const base = await mkdtemp(join(tmpdir(), "teams-archive-history-"));
	try {
		const store = openStore(join(base, "store"));
		const repo = join(base, "repo");
		await mkdir(repo);
		await writeFile(join(repo, "work.txt"), "repository contents");
		await store.createTeam({ name: "example" });
		await store.joinMember("example", { alias: "a", repositoryRoot: repo });
		await store.joinMember("example", { alias: "b", repositoryRoot: join(base, "other") });
		const request = await store.createRequest("example", { from: "a", to: "b", kind: "question", title: "Question", body: "Body" });
		await assert.rejects(() => store.archiveTeam("example"), { code: "open-requests" });
		assert.equal((await store.readRequest("example", request.id)).state, "requested");
		await assert.rejects(() => readFile(join(store.root, "teams", "example", ".archived.json")), { code: "ENOENT" });
		await store.appendEvent("example", request.id, { actor: "b", transition: "complete", summary: "Answer" });
		const dir = join(store.root, "teams", "example", "requests", request.id);
		const record = await readFile(join(dir, "request.json"), "utf8");
		const event = await readFile(join(dir, "events", "000000.json"), "utf8");
		await store.archiveTeam("example");
		assert.equal(await readFile(join(dir, "request.json"), "utf8"), record);
		assert.equal(await readFile(join(dir, "events", "000000.json"), "utf8"), event);
		assert.equal(await readFile(join(repo, "work.txt"), "utf8"), "repository contents");
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("S3: stale live presence and corrupt request or presence fail closed", async () => {
	const base = await mkdtemp(join(tmpdir(), "teams-archive-corrupt-"));
	try {
		const store = openStore(base);
		await store.createTeam({ name: "example" });
		await store.joinMember("example", { alias: "a", repositoryRoot: "/repos/a" });
		await store.joinMember("example", { alias: "b", repositoryRoot: "/repos/b" });
		const presence = openPresence(store, { now: () => 0 });
		await presence.claim("example", "a", { sessionId: "old", state: "active" });
		await assert.rejects(() => store.archiveTeam("example"), { code: "member-bound" });
		await presence.release("example", "a", "old");
		const path = join(base, "teams", "example", "presence", "a.json");
		await writeFile(path, "not json");
		await assert.rejects(() => store.archiveTeam("example"), { code: "corrupted-store" });
		assert.equal(await readFile(path, "utf8"), "not json");
		await writeFile(path, JSON.stringify({ sessionId: "old", pid: 2147483647, state: "idle", heartbeatAt: new Date(0).toISOString(), token: "t" }));
		const request = await store.createRequest("example", { from: "a", to: "b", kind: "question", title: "Q", body: "" });
		const requestPath = join(base, "teams", "example", "requests", request.id, "request.json");
		await writeFile(requestPath, "{");
		await assert.rejects(() => store.archiveTeam("example"), { code: "corrupted-store" });
		assert.equal(await readFile(requestPath, "utf8"), "{");
		await assert.rejects(() => readFile(join(base, "teams", "example", ".archived.json")), { code: "ENOENT" });
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("S3: queued claim and join cannot publish after a successful archive", async () => {
	for (const admission of ["claim", "join"] as const) {
		const base = await mkdtemp(join(tmpdir(), "teams-archive-admission-"));
		try {
			const store = openStore(base);
			await store.createTeam({ name: "example" });
			await store.joinMember("example", { alias: "a", repositoryRoot: "/repos/a" });
			let entered!: () => void;
			let resume!: () => void;
			const locked = new Promise<void>((resolve) => { entered = resolve; });
			const gate = new Promise<void>((resolve) => { resume = resolve; });
			const holder = store.withActiveTeamLock("example", async () => { entered(); await gate; });
			await locked;
			const archive = store.archiveTeam("example");
			const operation = admission === "claim"
				? openPresence(store).claim("example", "a", { sessionId: "session" })
				: store.joinMember("example", { alias: "b", repositoryRoot: "/repos/b" });
			resume();
			await holder;
			const [archived, admitted] = await Promise.allSettled([archive, operation]);
			if (archived.status === "fulfilled") {
				if (admission === "claim" && admitted.status === "fulfilled") await assert.rejects(() => store.getTeam("example"), { code: "unknown-team" });
				else if (admitted.status === "fulfilled") assert.equal((await readFile(join(base, "teams", "example", "members", "b.json"), "utf8")).includes('"b"'), true);
				await assert.rejects(() => store.getTeam("example"), { code: "unknown-team" });
			} else {
				assert.equal(admission, "claim");
				assert.equal((archived.reason as { code: string }).code, "member-bound");
				assert.equal(admitted.status, "fulfilled");
			}
		} finally { await rm(base, { recursive: true, force: true }); }
	}
});

test("S3: active heartbeat winning the lock prevents archive", async () => {
	const base = await mkdtemp(join(tmpdir(), "teams-heartbeat-first-"));
	try {
		const store = openStore(base);
		await store.createTeam({ name: "example" });
		await store.joinMember("example", { alias: "a", repositoryRoot: "/repos/a" });
		let entered!: () => void;
		let resume!: () => void;
		const inside = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { resume = resolve; });
		let pause = false;
		const wrapped: typeof store = { ...store, withActiveTeamLock: (ws, fn) => store.withActiveTeamLock(ws, async () => {
			if (pause) { entered(); await gate; }
			return fn();
		}) };
		const presence = openPresence(wrapped);
		await presence.claim("example", "a", { sessionId: "session" });
		pause = true;
		const beat = presence.heartbeat("example", "a", { sessionId: "session", state: "active" });
		await inside;
		const archive = store.archiveTeam("example");
		const rejected = assert.rejects(archive, { code: "member-bound" });
		resume();
		assert.equal(await beat, true);
		await rejected;
		assert.equal((await presence.status("example", "a")).online, true);
		await assert.rejects(() => readFile(join(base, "teams", "example", ".archived.json")), { code: "ENOENT" });
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("S3: archive winning the lock fences a queued active heartbeat", async () => {
	const base = await mkdtemp(join(tmpdir(), "teams-archive-first-"));
	try {
		let entered!: () => void;
		let resume!: () => void;
		const inside = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { resume = resolve; });
		const store = openStore(base, { beforeArchivePublished: async () => { entered(); await gate; } });
		await store.createTeam({ name: "example" });
		await store.joinMember("example", { alias: "a", repositoryRoot: "/repos/a" });
		const presence = openPresence(store);
		await presence.claim("example", "a", { sessionId: "session" });
		const archive = store.archiveTeam("example");
		await inside;
		const beat = presence.heartbeat("example", "a", { sessionId: "session", state: "active" });
		const rejected = assert.rejects(beat, { code: "unknown-team" });
		resume();
		await archive;
		await rejected;
		assert.deepEqual(await store.listTeams(), []);
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("S3: request publication in progress excludes archive until admission completes", async () => {
	const base = await mkdtemp(join(tmpdir(), "teams-archive-race-"));
	try {
		let entered!: () => void;
		let resume!: () => void;
		const published = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { resume = resolve; });
		const store = openStore(base, { afterRequestPublished: async () => { entered(); await gate; } });
		await store.createTeam({ name: "example" });
		await store.joinMember("example", { alias: "a", repositoryRoot: "/repos/a" });
		await store.joinMember("example", { alias: "b", repositoryRoot: "/repos/b" });
		const creating = store.createRequest("example", { from: "a", to: "b", kind: "question", title: "Q", body: "" });
		await published;
		const archiving = store.archiveTeam("example");
		resume();
		const request = await creating;
		await assert.rejects(() => archiving, { code: "open-requests" });
		assert.equal((await store.readRequest("example", request.id)).state, "requested");
	} finally { await rm(base, { recursive: true, force: true }); }
});
