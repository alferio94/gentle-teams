import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrateLegacyWorkspaces, migrationMessage } from "../lib/migrate.ts";
import { openStore } from "../lib/store.ts";

const NOW = Date.parse("2026-11-04T20:00:00.000Z");
const REQUEST_ID = "01M6KWM44BZ855D0C33VQ2ECSR";

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "gentle-teams-migrate-"));
}

async function put(path: string, value: unknown): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

/** A legacy tree like the one the previous version wrote (~/.pi/multiagent/workspaces/vhm). */
async function legacyTree(root: string, heartbeatAt = "2026-11-04T18:00:00.000Z"): Promise<string> {
	const ws = join(root, "workspaces", "vhm");
	await put(join(ws, "workspace.json"), { name: "vhm", description: "demo", createdAt: "2026-11-04T18:17:39.391Z" });
	for (const alias of ["frontend", "backend"]) {
		await put(join(ws, "members", `${alias}.json`), { alias, repositoryRoot: `/repos/${alias}`, joinedAt: "2026-11-04T18:18:00.000Z" });
		await put(join(ws, "presence", `${alias}.json`), { sessionId: `s-${alias}`, pid: 1, state: "idle", heartbeatAt, token: "t" });
		await put(join(ws, "cursors", `${alias}.json`), { version: 1, seen: {} });
	}
	const request = join(ws, "requests", REQUEST_ID);
	await put(join(request, "request.json"), {
		id: REQUEST_ID,
		workspace: "vhm",
		from: "frontend",
		to: "backend",
		kind: "question",
		title: "Where did we leave off?",
		body: "Summary please.",
		dependsOn: [],
		createdAt: "2026-11-04T18:20:00.000Z",
	});
	await put(join(request, "events", "000000.json"), { seq: 0, actor: "backend", role: "recipient", transition: "complete", summary: "Done.", at: "2026-11-04T18:21:00.000Z" });
	await put(join(request, "approvals", "01M6M6QQGYF5TAQZYYK2QEBEEA", "decision.json"), { decision: "deny" });
	await put(join(ws, "requests", ".pruning-01M6KWM44BZ855D0C33VQ2ECSZ", "request.json"), { hidden: true });
	return join(root, "workspaces");
}

async function snapshot(dir: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	async function walk(rel: string): Promise<void> {
		for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
			const path = join(rel, entry.name);
			if (entry.isDirectory()) await walk(path);
			else out[path] = await readFile(join(dir, path), "utf8");
		}
	}
	await walk("");
	return out;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

test("S22 nothing to migrate: no legacy directory, nothing created", async () => {
	const root = await tempRoot();
	const result = await migrateLegacyWorkspaces(root, { now: () => NOW });
	assert.deepEqual(result, { migrated: [], conflicts: [], blockedBy: [] });
	assert.deepEqual(await readdir(root), []);
});

test("S22 migrates a legacy team, renames the field, and keeps a byte-identical backup", async () => {
	const root = await tempRoot();
	const legacy = await legacyTree(root);
	const before = await snapshot(legacy);

	const result = await migrateLegacyWorkspaces(root, { now: () => NOW });

	assert.deepEqual(result.migrated, ["vhm"]);
	assert.deepEqual(result.conflicts, []);
	assert.deepEqual(result.blockedBy, []);
	assert.equal(result.backup, join(root, "workspaces.migrated-2026-11-04T20-00-00-000Z"));
	assert.equal(await exists(legacy), false);
	assert.deepEqual(await snapshot(result.backup!), before);
	assert.deepEqual((await readdir(root)).sort(), ["teams", "workspaces.migrated-2026-11-04T20-00-00-000Z"]);

	// Read back through the public store interface.
	const store = openStore(root);
	assert.equal((await store.getTeam("vhm"))?.description, "demo");
	assert.deepEqual((await store.listMembers("vhm")).map((m) => m.alias).sort(), ["backend", "frontend"]);
	const [view] = await store.listRequests("vhm");
	assert.equal(view.record.id, REQUEST_ID);
	assert.equal(view.record.team, "vhm");
	assert.equal(view.state, "completed");

	const team = join(root, "teams", "vhm");
	const request = JSON.parse(await readFile(join(team, "requests", REQUEST_ID, "request.json"), "utf8"));
	assert.deepEqual(Object.keys(request), ["id", "team", "from", "to", "kind", "title", "body", "dependsOn", "createdAt"]);
	assert.equal(await exists(join(team, "workspace.json")), false);
	assert.equal(
		await readFile(join(team, "requests", REQUEST_ID, "events", "000000.json"), "utf8"),
		before[join("vhm", "requests", REQUEST_ID, "events", "000000.json")],
	);
	assert.equal(await exists(join(team, "requests", ".pruning-01M6KWM44BZ855D0C33VQ2ECSZ")), false);
	assert.equal((await stat(join(team, "team.json"))).mode & 0o777, 0o600);
	assert.equal((await stat(join(team, "requests"))).mode & 0o777, 0o700);
	assert.equal((await stat(join(root, "teams"))).mode & 0o777, 0o700);
});

test("S22 a fresh heartbeat from the previous version blocks the migration and changes nothing", async () => {
	const root = await tempRoot();
	const legacy = await legacyTree(root, new Date(NOW - 2000).toISOString());
	const before = await snapshot(legacy);

	const result = await migrateLegacyWorkspaces(root, { now: () => NOW });

	assert.deepEqual(result, { migrated: [], conflicts: [], blockedBy: ["vhm/backend", "vhm/frontend"] });
	assert.deepEqual(await snapshot(legacy), before);
	assert.deepEqual(await readdir(root), ["workspaces"]);
});

test("S22 an existing team with the same name is never overwritten and is reported", async () => {
	const root = await tempRoot();
	const legacy = await legacyTree(root);
	const before = await snapshot(legacy);
	await openStore(root).createTeam({ name: "vhm", description: "new one" });
	const existing = await snapshot(join(root, "teams"));

	const result = await migrateLegacyWorkspaces(root, { now: () => NOW });

	assert.deepEqual(result.migrated, []);
	assert.deepEqual(result.conflicts, ["vhm"]);
	assert.deepEqual(await snapshot(join(root, "teams")), existing);
	assert.deepEqual(await snapshot(result.backup!), before);
});

test("S22 invalid JSON fails the migration and leaves the legacy tree untouched", async () => {
	const root = await tempRoot();
	const legacy = await legacyTree(root);
	await put(join(legacy, "vhm", "members", "broken.json"), "{ not json");
	const before = await snapshot(legacy);

	await assert.rejects(migrateLegacyWorkspaces(root, { now: () => NOW }), /broken\.json/);

	assert.deepEqual(await snapshot(legacy), before);
	assert.deepEqual(await readdir(root), ["workspaces"]);
});

test("S22 invalid JSON in a later team publishes no team at all", async () => {
	const root = await tempRoot();
	const legacy = await legacyTree(root);
	await put(join(legacy, "zzz", "workspace.json"), "{bad");
	const before = await snapshot(legacy);

	await assert.rejects(migrateLegacyWorkspaces(root, { now: () => NOW }), /zzz/);

	assert.deepEqual(await snapshot(legacy), before);
	assert.deepEqual(await readdir(root), ["workspaces"]);
});

test("S22 a different team with the same name and creation time is a conflict", async () => {
	const root = await tempRoot();
	const legacy = await legacyTree(root);
	await put(join(root, "teams", "vhm", "team.json"), { name: "vhm", description: "different", createdAt: "2026-11-04T18:17:39.391Z" });
	const existing = await snapshot(join(root, "teams"));

	const result = await migrateLegacyWorkspaces(root, { now: () => NOW });

	assert.deepEqual(result.conflicts, ["vhm"]);
	assert.deepEqual(result.migrated, []);
	assert.deepEqual(await snapshot(join(root, "teams")), existing);
	assert.equal(await stat(legacy).then(() => true, () => false), false);
});

test("S22 a symlink in the old tree fails the migration and changes nothing", async () => {
	const root = await tempRoot();
	const legacy = await legacyTree(root);
	await symlink(join(legacy, "vhm", "workspace.json"), join(legacy, "vhm", "members", "link.json"));

	await assert.rejects(migrateLegacyWorkspaces(root, { now: () => NOW }), /link\.json.*not a regular file/);

	assert.deepEqual(await readdir(root), ["workspaces"]);
	assert.deepEqual((await readdir(join(legacy, "vhm", "members"))).sort(), ["backend.json", "frontend.json", "link.json"]);
});

test("S22 same metadata but different member is a conflict", async (t) => {
	const root = await tempRoot(); t.after(() => rm(root, { recursive: true, force: true }));
	const legacy = await legacyTree(root);
	await put(join(root, "teams/vhm/team.json"), await readFile(join(legacy, "vhm/workspace.json"), "utf8"));
	await put(join(root, "teams/vhm/members/frontend.json"), { alias: "different" });
	const before = await snapshot(join(root, "teams"));
	const result = await migrateLegacyWorkspaces(root, { now: () => NOW });
	assert.deepEqual(result.conflicts, ["vhm"]);
	assert.deepEqual(result.migrated, []);
	assert.deepEqual(await snapshot(join(root, "teams")), before);
});

test("S22 symlink team entry aborts without changes", async (t) => {
	const root = await tempRoot(); t.after(() => rm(root, { recursive: true, force: true }));
	const legacy = await legacyTree(root);
	await symlink(join(legacy, "vhm"), join(legacy, "linked"));
	const before = await snapshot(join(legacy, "vhm"));
	await assert.rejects(migrateLegacyWorkspaces(root, { now: () => NOW }), /linked.*not a regular file or directory; nothing was changed/);
	assert.deepEqual(await readdir(root), ["workspaces"]);
	assert.deepEqual(await snapshot(join(legacy, "vhm")), before);
});

test("S22 resumes after publication before backup", async (t) => {
	const root = await tempRoot(); t.after(() => rm(root, { recursive: true, force: true }));
	const legacy = await legacyTree(root);
	const initial = await snapshot(legacy);
	const first = await migrateLegacyWorkspaces(root, { now: () => NOW });
	const { rename } = await import("node:fs/promises");
	await rename(first.backup!, legacy);
	const result = await migrateLegacyWorkspaces(root, { now: () => NOW });
	assert.deepEqual(result.migrated, []);
	assert.deepEqual(result.conflicts, []);
	assert.deepEqual(await snapshot(result.backup!), initial);
});

test("S22 multi-process migrations serialize without conflicts", async (t) => {
	const url = pathToFileURL(join(process.cwd(), "lib/migrate.ts")).href;
	const script = `import { migrateLegacyWorkspaces } from ${JSON.stringify(url)}; console.log(JSON.stringify(await migrateLegacyWorkspaces(process.argv[1])));`;
	for (let round = 0; round < 6; round++) {
		const root = await tempRoot(); t.after(() => rm(root, { recursive: true, force: true }));
		for (const name of ["alpha", "beta", "gamma"]) {
			await put(join(root, "workspaces", name, "workspace.json"), { name });
			for (let i = 0; i < 30; i++) await put(join(root, "workspaces", name, "members", `${i}.json`), { i });
		}
		const results = await Promise.all(Array.from({ length: 6 }, () => new Promise<any>((resolve, reject) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", script, root]);
			let stdout = "", stderr = "";
			child.stdout.on("data", (data) => stdout += data); child.stderr.on("data", (data) => stderr += data);
			child.on("error", reject); child.on("close", (code) => {
				if (code !== 0) reject(new Error(`child exited ${code}: ${stderr}`));
				else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
			});
		})));
		assert.deepEqual(results.flatMap((r) => r.migrated).sort(), ["alpha", "beta", "gamma"]);
		assert.deepEqual(results.flatMap((r) => r.conflicts), []);
		assert.equal(results.filter((r) => r.backup).length, 1);
		assert.equal((await readdir(root)).filter((n) => n.startsWith("workspaces.migrated-")).length, 1);
		assert.deepEqual((await readdir(root)).filter((n) => n.startsWith(".")), []);
		assert.deepEqual((await readdir(join(root, "teams"))).sort(), ["alpha", "beta", "gamma"]);
	}
});

test("S22 messages: blocked, migrated, conflict, and nothing to say", () => {
	const root = "/r";
	assert.equal(migrationMessage({ migrated: [], conflicts: [], blockedBy: [] }, root), undefined);
	assert.deepEqual(migrationMessage({ migrated: [], conflicts: [], blockedBy: ["vhm/backend"] }, root), {
		level: "warning",
		text: "teams: data from the previous version (pi-workspaces) is in /r/workspaces, but a session of that version is still running (vhm/backend). Close those sessions and restart this one to migrate it; until then those teams are not shown.",
	});
	assert.deepEqual(migrationMessage({ migrated: ["vhm"], conflicts: [], blockedBy: [], backup: "/r/workspaces.migrated-x" }, root), {
		level: "info",
		text: "teams: migrated vhm from the previous version (pi-workspaces); the original data is kept in /r/workspaces.migrated-x.",
	});
	assert.deepEqual(migrationMessage({ migrated: [], conflicts: ["vhm"], blockedBy: [], backup: "/r/b" }, root), {
		level: "warning",
		text: "teams: vhm already existed as a team and was not replaced; the original data is kept in /r/b.",
	});
});

test("S22 two migrations at once: the team is published exactly once with one backup", async () => {
	const root = await tempRoot();
	const legacy = await legacyTree(root);
	const before = await snapshot(legacy);

	const results = await Promise.all([
		migrateLegacyWorkspaces(root, { now: () => NOW }),
		migrateLegacyWorkspaces(root, { now: () => NOW + 1 }),
	]);

	assert.deepEqual(results.flatMap((r) => r.migrated), ["vhm"]);
	assert.deepEqual(results.flatMap((r) => r.conflicts), []);
	assert.equal(results.filter((r) => r.backup).length, 1);
	const entries = (await readdir(root)).sort();
	assert.equal(entries.length, 2);
	assert.equal(entries[0], "teams");
	assert.match(entries[1], /^workspaces\.migrated-/);
	assert.deepEqual(await snapshot(join(root, entries[1])), before);
	assert.deepEqual(await readdir(join(root, "teams")), ["vhm"]);
});
