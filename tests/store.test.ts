import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../lib/store.ts";

const FRONT = "/repos/tienda/frontend";
const BACK = "/repos/tienda/backend";

async function fresh(): Promise<{ store: Store; root: string; done: () => Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-"));
	const root = join(base, "multiagent");
	return { store: openStore(root), root, done: () => rm(base, { recursive: true, force: true }) };
}

async function tree(dir: string, prefix = ""): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const rel = prefix + entry.name;
		out.push(entry.isDirectory() ? rel + "/" : rel);
		if (entry.isDirectory()) out.push(...(await tree(join(dir, entry.name), rel + "/")));
	}
	return out;
}

async function withPair(): Promise<{ store: Store; root: string; done: () => Promise<void> }> {
	const ctx = await fresh();
	await ctx.store.createTeam({ name: "tienda-online", description: "Store" });
	await ctx.store.joinMember("tienda-online", { alias: "frontend", repositoryRoot: FRONT });
	await ctx.store.joinMember("tienda-online", { alias: "backend", repositoryRoot: BACK });
	return ctx;
}

const change = { from: "frontend", to: "backend", kind: "change" as const, title: "Add /api/orders", body: "Need GET /api/orders." };

async function rejects(fn: () => Promise<unknown>, code: string, message: string): Promise<void> {
	await assert.rejects(fn, { name: "TeamStoreError", code, message });
}

// S2 — teams and members

test("creates and lists a team", async () => {
	const { store, done } = await fresh();
	try {
		const ws = await store.createTeam({ name: "tienda-online", description: "Store" });
		assert.equal(ws.name, "tienda-online");
		assert.equal(ws.description, "Store");
		assert.match(ws.createdAt, /^\d{4}-\d{2}-\d{2}T/);
		assert.deepEqual(await store.listTeams(), [ws]);
		assert.deepEqual(await store.getTeam("tienda-online"), ws);
	} finally {
		await done();
	}
});

test("rejects a duplicate team name and keeps the original", async () => {
	const { store, done } = await fresh();
	try {
		const ws = await store.createTeam({ name: "tienda-online", description: "Store" });
		await rejects(() => store.createTeam({ name: "tienda-online", description: "Other" }), "team-name-taken", 'A team named "tienda-online" already exists.');
		assert.deepEqual(await store.listTeams(), [ws]);
	} finally {
		await done();
	}
});

test("concurrent creation of the same team name lets exactly one win", async () => {
	const { store, done } = await fresh();
	try {
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, (_, i) => store.createTeam({ name: "race", description: String(i) })),
		);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
		for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { code: string }).code, "team-name-taken");
		assert.equal((await store.listTeams()).length, 1);
	} finally {
		await done();
	}
});

test("rejects invalid team names without writing anything", async () => {
	const { store, root, done } = await fresh();
	try {
		for (const name of ["", "Tienda", "../x", "a/b", "-x", "x".repeat(65)]) {
			await rejects(
				() => store.createTeam({ name }),
				"invalid-name",
				`Team name "${name}" is invalid: use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit.`,
			);
		}
		assert.deepEqual(await tree(root), []);
	} finally {
		await done();
	}
});

test("unknown team is reported", async () => {
	const { store, done } = await fresh();
	try {
		await rejects(() => store.getTeam("nope"), "unknown-team", 'Team "nope" does not exist.');
		await rejects(() => store.joinMember("nope", { alias: "a", repositoryRoot: FRONT }), "unknown-team", 'Team "nope" does not exist.');
	} finally {
		await done();
	}
});

test("joins members and resumes the same alias and repository", async () => {
	const { store, done } = await withPair();
	try {
		const members = await store.listMembers("tienda-online");
		assert.deepEqual(members.map((m) => [m.alias, m.repositoryRoot]), [["backend", BACK], ["frontend", FRONT]]);
		const again = await store.joinMember("tienda-online", { alias: "backend", repositoryRoot: BACK });
		assert.equal(again.resumed, true);
		assert.equal(again.member.alias, "backend");
		assert.equal((await store.listMembers("tienda-online")).length, 2);
	} finally {
		await done();
	}
});

test("S27 legacy members without repository claims still resume, reject duplicates, and can leave", async () => {
	const { store, root, done } = await withPair();
	try {
		const dir = join(root, "teams", "tienda-online");
		for (const name of await readdir(dir)) if (name.startsWith(".claim-")) await unlink(join(dir, name));
		assert.equal((await store.joinMember("tienda-online", { alias: "backend", repositoryRoot: BACK })).resumed, true);
		await rejects(() => store.joinMember("tienda-online", { alias: "api", repositoryRoot: BACK }), "repository-already-member", `Repository ${BACK} is already member "backend" of team "tienda-online".`);
		await store.leaveMember("tienda-online", "backend");
		assert.equal((await store.joinMember("tienda-online", { alias: "api", repositoryRoot: BACK })).resumed, false);
	} finally { await done(); }
});

test("rejects an alias owned by another repository", async () => {
	const { store, done } = await withPair();
	try {
		await rejects(
			() => store.joinMember("tienda-online", { alias: "backend", repositoryRoot: "/repos/other" }),
			"alias-taken",
			`Alias "backend" already belongs to ${BACK} in team "tienda-online".`,
		);
		assert.equal((await store.listMembers("tienda-online")).length, 2);
	} finally {
		await done();
	}
});

test("rejects a repository that is already a member under another alias", async () => {
	const { store, done } = await withPair();
	try {
		await rejects(
			() => store.joinMember("tienda-online", { alias: "api", repositoryRoot: BACK }),
			"repository-already-member",
			`Repository ${BACK} is already member "backend" of team "tienda-online".`,
		);
		assert.deepEqual((await store.listMembers("tienda-online")).map((m) => m.alias), ["backend", "frontend"]);
	} finally {
		await done();
	}
});

test("concurrent joins of one alias from different repositories let exactly one win", async () => {
	const { store, done } = await fresh();
	try {
		await store.createTeam({ name: "w" });
		const results = await Promise.allSettled(
			Array.from({ length: 6 }, (_, i) => store.joinMember("w", { alias: "backend", repositoryRoot: `/repos/r${i}` })),
		);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
		const members = await store.listMembers("w");
		assert.equal(members.length, 1);
		// Losing repositories are free to join under another alias.
		const loser = results.findIndex((r) => r.status === "rejected");
		const joined = await store.joinMember("w", { alias: "other", repositoryRoot: `/repos/r${loser}` });
		assert.equal(joined.resumed, false);
	} finally {
		await done();
	}
});

test("rejects invalid aliases and relative repository roots", async () => {
	const { store, done } = await withPair();
	try {
		await rejects(
			() => store.joinMember("tienda-online", { alias: "Back End", repositoryRoot: "/repos/x" }),
			"invalid-alias",
			'Alias "Back End" is invalid: use 1-32 lowercase letters, digits, or hyphens, starting with a letter or digit.',
		);
		for (const repositoryRoot of ["repos/x", "/repos/../x", "/repos/x/"]) {
			await rejects(
				() => store.joinMember("tienda-online", { alias: "x", repositoryRoot }),
				"invalid-repository-root",
				`Repository root "${repositoryRoot}" must be an absolute, normalized path.`,
			);
		}
		assert.equal((await store.listMembers("tienda-online")).length, 2);
	} finally {
		await done();
	}
});

// S3 — leaving

test("a member without open requests can leave and its repository can rejoin", async () => {
	const { store, done } = await withPair();
	try {
		const req = await store.createRequest("tienda-online", change);
		await store.appendEvent("tienda-online", req.id, { actor: "frontend", transition: "cancel" });
		await store.leaveMember("tienda-online", "backend");
		assert.deepEqual((await store.listMembers("tienda-online")).map((m) => m.alias), ["frontend"]);
		const back = await store.joinMember("tienda-online", { alias: "api", repositoryRoot: BACK });
		assert.equal(back.resumed, false);
	} finally {
		await done();
	}
});

test("R4-002 leave succeeds when claim cleanup fails and a later join recovers", async () => {
	const { store, root, done } = await withPair();
	try {
		const dir = join(root, "teams", "tienda-online");
		const claims = (await readdir(dir)).filter((name) => name.startsWith(".claim-"));
		const claim = (await Promise.all(claims.map(async (name) => ({ name, content: JSON.parse(await readFile(join(dir, name), "utf8")) })))).find((item) => item.content.repositoryRoot === BACK)!;
		await unlink(join(dir, claim.name));
		await mkdir(join(dir, claim.name)); // unlink fails with EISDIR
		await store.leaveMember("tienda-online", "backend");
		assert.deepEqual((await store.listMembers("tienda-online")).map((m) => m.alias), ["frontend"]);
		await rm(join(dir, claim.name), { recursive: true });
		await writeFile(join(dir, claim.name), JSON.stringify(claim.content));
		assert.equal((await store.joinMember("tienda-online", { alias: "api", repositoryRoot: BACK })).resumed, false);
	} finally { await done(); }
});

test("leaving is blocked while sent or received requests are open", async () => {
	const { store, done } = await withPair();
	try {
		const a = await store.createRequest("tienda-online", change);
		const b = await store.createRequest("tienda-online", { ...change, from: "backend", to: "frontend", kind: "question", title: "Auth?" });
		await rejects(
			() => store.leaveMember("tienda-online", "backend"),
			"open-requests",
			`Member "backend" has 2 open requests (${a.id}, ${b.id}); resolve or cancel them before leaving.`,
		);
		assert.equal((await store.listMembers("tienda-online")).length, 2);
	} finally {
		await done();
	}
});

test("leave racing a request to the leaving member never leaves an open request to a non-member", async () => {
	const { store, done } = await withPair();
	try {
		for (let i = 0; i < 20; i++) {
			const alias = `c${i}`;
			await store.joinMember("tienda-online", { alias, repositoryRoot: `/repos/c${i}` });
			const [left, created] = await Promise.allSettled([
				store.leaveMember("tienda-online", alias),
				store.createRequest("tienda-online", { ...change, to: alias }),
			]);
			assert.ok(!(left.status === "fulfilled" && created.status === "fulfilled"), `round ${i}: both succeeded`);
		}
		const members = new Set((await store.listMembers("tienda-online")).map((m) => m.alias));
		for (const view of await store.listRequests("tienda-online")) {
			assert.ok(members.has(view.record.to) && members.has(view.record.from), `${view.record.id} -> ${view.record.to}`);
		}
	} finally {
		await done();
	}
});

test("concurrent double leave rejects the loser with unknown-member", async () => {
	const { store, done } = await withPair();
	try {
		const results = await Promise.allSettled([store.leaveMember("tienda-online", "backend"), store.leaveMember("tienda-online", "backend")]);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
		const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
		assert.equal(loser.reason.name, "TeamStoreError");
		assert.equal(loser.reason.code, "unknown-member");
		assert.deepEqual((await store.listMembers("tienda-online")).map((m) => m.alias), ["frontend"]);
	} finally {
		await done();
	}
});

test("leaving an unknown member is reported", async () => {
	const { store, done } = await withPair();
	try {
		await rejects(() => store.leaveMember("tienda-online", "admin"), "unknown-member", 'Member "admin" is not part of team "tienda-online".');
	} finally {
		await done();
	}
});

// S4 — requests

test("creates a request and reads it back in state requested", async () => {
	const { store, done } = await withPair();
	try {
		const req = await store.createRequest("tienda-online", change);
		assert.match(req.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
		assert.deepEqual(
			{ from: req.from, to: req.to, kind: req.kind, title: req.title, body: req.body, dependsOn: req.dependsOn, team: req.team },
			{ ...change, dependsOn: [], team: "tienda-online" },
		);
		const view = await store.readRequest("tienda-online", req.id);
		assert.deepEqual(view, { record: req, events: [], state: "requested" });
		assert.deepEqual(await store.listRequests("tienda-online"), [view]);
	} finally {
		await done();
	}
});

test("rejects invalid requests and leaves storage unchanged", async () => {
	const { store, root, done } = await withPair();
	try {
		const before = await tree(root);
		const cases: [Record<string, unknown>, string, string][] = [
			[{ to: "admin" }, "unknown-member", 'Member "admin" is not part of team "tienda-online".'],
			[{ to: "frontend" }, "self-request", "A member cannot send a request to itself."],
			[{ kind: "task" }, "invalid-kind", 'Request kind "task" is invalid: use "question" or "change".'],
			[{ title: "   " }, "invalid-title", "Request title must be 1-120 characters."],
			[{ title: "t".repeat(121) }, "invalid-title", "Request title must be 1-120 characters."],
			[{ body: "é".repeat(4097) }, "body-too-large", "Request body is 8194 bytes; the limit is 8192 bytes."],
			[{ dependsOn: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] }, "unknown-dependency", 'Dependency "01ARZ3NDEKTSV4RRFFQ69G5FAV" is not a request in team "tienda-online".'],
		];
		for (const [patch, code, message] of cases) {
			await rejects(() => store.createRequest("tienda-online", { ...change, ...patch } as typeof change), code, message);
		}
		assert.deepEqual(await tree(root), before);
	} finally {
		await done();
	}
});

test("rejects a non-string body without writing anything", async () => {
	const { store, root, done } = await withPair();
	try {
		const before = await tree(root);
		await rejects(
			() => store.createRequest("tienda-online", { ...change, body: 123 as unknown as string }),
			"invalid-body",
			"Request body must be a string.",
		);
		assert.deepEqual(await tree(root), before);
	} finally {
		await done();
	}
});

test("accepts a body of exactly 8192 bytes and existing dependencies", async () => {
	const { store, done } = await withPair();
	try {
		const first = await store.createRequest("tienda-online", { ...change, body: "a".repeat(8192) });
		const second = await store.createRequest("tienda-online", { ...change, title: "Then this", dependsOn: [first.id, first.id] });
		assert.deepEqual(second.dependsOn, [first.id]);
	} finally {
		await done();
	}
});

// S1 via the store — events

test("appends events, derives state, and records role and sequence", async () => {
	const { store, done } = await withPair();
	try {
		const req = await store.createRequest("tienda-online", change);
		await store.appendEvent("tienda-online", req.id, { actor: "backend", transition: "accept" });
		await store.appendEvent("tienda-online", req.id, { actor: "backend", transition: "start" });
		const result = await store.appendEvent("tienda-online", req.id, {
			actor: "backend",
			transition: "complete",
			summary: "Endpoint added.",
			evidence: ["commit abc123"],
		});
		assert.equal(result.state, "completed");
		assert.deepEqual(
			{ seq: result.event.seq, actor: result.event.actor, role: result.event.role, transition: result.event.transition, summary: result.event.summary, evidence: result.event.evidence },
			{ seq: 2, actor: "backend", role: "recipient", transition: "complete", summary: "Endpoint added.", evidence: ["commit abc123"] },
		);
		const view = await store.readRequest("tienda-online", req.id);
		assert.equal(view.state, "completed");
		assert.deepEqual(view.events.map((e) => e.seq), [0, 1, 2]);
	} finally {
		await done();
	}
});

test("rejected events leave stored events unchanged", async () => {
	const { store, root, done } = await withPair();
	try {
		const req = await store.createRequest("tienda-online", change);
		const before = await tree(root);
		await rejects(
			() => store.appendEvent("tienda-online", req.id, { actor: "frontend", transition: "accept" }),
			"transition-not-allowed",
			'Only the recipient can "accept" a request.',
		);
		await rejects(
			() => store.appendEvent("tienda-online", req.id, { actor: "backend", transition: "complete" }),
			"transition-not-allowed",
			'"complete" is not allowed for a change in state "requested".',
		);
		await rejects(
			() => store.appendEvent("tienda-online", req.id, { actor: "admin", transition: "comment" }),
			"not-a-party",
			`Member "admin" is not a party to request ${req.id}.`,
		);
		await rejects(
			() => store.appendEvent("tienda-online", req.id, { actor: "backend", transition: "comment", summary: "x".repeat(8193) }),
			"body-too-large",
			"Event summary is 8193 bytes; the limit is 8192 bytes.",
		);
		await rejects(
			() => store.appendEvent("tienda-online", "../../etc", { actor: "backend", transition: "comment" }),
			"unknown-request",
			'Request "../../etc" does not exist in team "tienda-online".',
		);
		assert.deepEqual(await tree(root), before);
		assert.equal((await store.readRequest("tienda-online", req.id)).events.length, 0);
	} finally {
		await done();
	}
});

test("concurrent comments are all stored with unique contiguous sequences", async () => {
	const { store, done } = await withPair();
	try {
		const req = await store.createRequest("tienda-online", change);
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				store.appendEvent("tienda-online", req.id, { actor: i % 2 ? "frontend" : "backend", transition: "comment", summary: `c${i}` }),
			),
		);
		const view = await store.readRequest("tienda-online", req.id);
		assert.deepEqual(view.events.map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i));
		assert.deepEqual(new Set(view.events.map((e) => e.summary)).size, 20);
	} finally {
		await done();
	}
});

test("concurrent accept and decline: exactly one wins", async () => {
	const { store, done } = await withPair();
	try {
		const req = await store.createRequest("tienda-online", change);
		// accept and decline exclude each other: whichever lands first makes the other invalid.
		const results = await Promise.allSettled(
			Array.from({ length: 6 }, (_, i) =>
				store.appendEvent("tienda-online", req.id, { actor: "backend", transition: i % 2 ? "accept" : "decline" }),
			),
		);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
		for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { code: string }).code, "transition-not-allowed");
		const view = await store.readRequest("tienda-online", req.id);
		assert.equal(view.events.length, 1);
		assert.ok(view.state === "accepted" || view.state === "declined");
	} finally {
		await done();
	}
});

// S5 — storage safety

test("a request.json whose id or team differs from its location is rejected and writes nothing", async () => {
	const { store, root, done } = await withPair();
	try {
		const r1 = await store.createRequest("tienda-online", change);
		const r2 = await store.createRequest("tienda-online", { ...change, title: "two" });
		const file = join(root, "teams/tienda-online/requests", r1.id, "request.json");
		const original = await readFile(file, "utf8");
		for (const patch of [{ id: r2.id }, { id: "../../../outside" }, { team: "other" }]) {
			await writeFile(file, JSON.stringify({ ...JSON.parse(original), ...patch }));
			await rejects(
				() => store.appendEvent("tienda-online", r1.id, { actor: "backend", transition: "comment" }),
				"corrupted-store",
				`Stored request ${r1.id} does not match its location.`,
			);
		}
		assert.deepEqual(await readdir(join(root, "teams/tienda-online/requests", r2.id, "events")), []);
		assert.deepEqual(await tree(join(root, "outside")), []);
		assert.deepEqual(await readdir(join(root, "teams/tienda-online/requests", r1.id, "events")), []);
	} finally {
		await done();
	}
});

test("a plain file with a team name is reported as taken", async () => {
	const { store, root, done } = await fresh();
	try {
		await store.createTeam({ name: "seed" });
		await writeFile(join(root, "teams", "blocked"), "x");
		await rejects(() => store.createTeam({ name: "blocked" }), "team-name-taken", 'A team named "blocked" already exists.');
	} finally {
		await done();
	}
});

test("directories are 0700, files are 0600, and no temporary files remain", async () => {
	const { store, root, done } = await withPair();
	try {
		const req = await store.createRequest("tienda-online", change);
		await store.appendEvent("tienda-online", req.id, { actor: "backend", transition: "accept" });
		const paths = await tree(root);
		assert.ok(paths.length > 0);
		for (const rel of [".", ...paths]) {
			const mode = (await stat(join(root, rel))).mode & 0o777;
			assert.equal(mode, rel === "." || rel.endsWith("/") ? 0o700 : 0o600, rel);
			assert.ok(!rel.split("/").some((part) => part.startsWith(".tmp")), rel);
		}
	} finally {
		await done();
	}
});
