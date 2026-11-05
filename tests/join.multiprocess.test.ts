import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openStore } from "../lib/store.ts";

const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "lib", "store.ts")).href;
const child = `
const [root, alias] = process.argv.slice(1);
const { openStore } = await import(${JSON.stringify(moduleUrl)});
process.stdout.write("ready\\n");
await new Promise(resolve => process.stdin.once("data", resolve));
try { const r = await openStore(root).joinMember("team", { alias, repositoryRoot: "/repo/shared" }); console.log(JSON.stringify({ ok: true, resumed: r.resumed })); }
catch (e) { console.log(JSON.stringify({ ok: false, code: e.code })); }
`;

test("S27 different processes joining the same repository have exactly one winner and can rejoin after leave", { timeout: 30000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "gentle-teams-join-"));
	try {
		const store = openStore(root);
		await store.createTeam({ name: "team" });
		for (let round = 0; round < 8; round++) {
			const processes = Array.from({ length: 6 }, (_, i) => spawn(process.execPath, ["--input-type=module", "-e", child, root, `alias-${i}`], { stdio: ["pipe", "pipe", "pipe"] }));
			const results = processes.map(p => new Promise<{ok: boolean; code?: string}>((resolve, reject) => {
				let out = "", err = "";
				p.stdout.on("data", chunk => { out += chunk; if (out.includes("ready\n")) ready(); });
				p.stderr.on("data", chunk => { err += chunk; });
				p.on("error", reject);
				p.on("exit", code => { if (code !== 0) reject(new Error(err)); else resolve(JSON.parse(out.trim().split("\n").at(-1)!)); });
				let signalled = false;
				function ready() { if (!signalled) { signalled = true; arrived++; if (arrived === processes.length) for (const proc of processes) proc.stdin.end("go"); } }
			}));
			let arrived = 0;
			const outcomes = await Promise.all(results);
			assert.equal(outcomes.filter(r => r.ok).length, 1, `round ${round}`);
			for (const r of outcomes.filter(r => !r.ok)) assert.equal(r.code, "repository-already-member");
			const members = await store.listMembers("team");
			assert.equal(members.length, 1);
			assert.equal((await store.joinMember("team", { alias: members[0]!.alias, repositoryRoot: "/repo/shared" })).resumed, true);
			await store.leaveMember("team", members[0]!.alias);
			assert.equal((await store.joinMember("team", { alias: "after", repositoryRoot: "/repo/shared" })).resumed, false);
			await store.leaveMember("team", "after");
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});
