import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PRUNE_DAYS, DEFAULT_READ_ONLY_TOOLS, loadConfig } from "../lib/config.ts";

const DEFAULTS = ["mem_search", "mem_context", "mem_get_observation"];
const warning = (path: string, why: string) =>
	`teams: ignoring ${path}: ${why}; using the default read-only tools (mem_search, mem_context, mem_get_observation).`;

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-config-"));
	try {
		await fn(join(base, "multiagent"));
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

const writeConfig = async (root: string, text: string) => {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "config.json"), text);
};

test("S17 the default read-only tools are the three engram read tools", () => {
	assert.deepEqual([...DEFAULT_READ_ONLY_TOOLS], DEFAULTS);
});

test("S17 a missing config file gives the defaults, no warning, and writes nothing", async () => {
	await withRoot(async (root) => {
		assert.deepEqual(await loadConfig(root), { readOnlyTools: DEFAULTS, pruneClosedAfterDays: 7 });
		assert.deepEqual(await readdir(join(root, "..")), [], "the root is not created");
	});
});

test("S17 a custom readOnlyTools list replaces the defaults, names kept exactly", async () => {
	await withRoot(async (root) => {
		await writeConfig(root, JSON.stringify({ readOnlyTools: ["mem_search", "Context7_Lookup", "docs search"], pruneClosedAfterDays: 7 }));
		assert.deepEqual(await loadConfig(root), { readOnlyTools: ["mem_search", "Context7_Lookup", "docs search"], pruneClosedAfterDays: 7 });
		await writeConfig(root, JSON.stringify({ readOnlyTools: [] }));
		assert.deepEqual(await loadConfig(root), { readOnlyTools: [], pruneClosedAfterDays: 7 }, "an empty list allows no extra tools");
	});
});

test("S17 a valid object without readOnlyTools gives the defaults without a warning", async () => {
	await withRoot(async (root) => {
		await writeConfig(root, JSON.stringify({ other: 1 }));
		assert.deepEqual(await loadConfig(root), { readOnlyTools: DEFAULTS, pruneClosedAfterDays: 7 });
	});
});

test("S17 an invalid config file gives the defaults plus exactly one warning", async () => {
	await withRoot(async (root) => {
		const path = join(root, "config.json");
		for (const [text, why] of [
			["{ not json", "it is not valid JSON"],
			["[1, 2]", "it must be a JSON object"],
			["null", "it must be a JSON object"],
			[JSON.stringify({ readOnlyTools: "mem_search" }), '"readOnlyTools" must be an array of tool names'],
			[JSON.stringify({ readOnlyTools: ["mem_search", 3] }), '"readOnlyTools" must be an array of tool names'],
			[JSON.stringify({ readOnlyTools: ["mem_search", ""] }), '"readOnlyTools" must be an array of tool names'],
		] as const) {
			await writeConfig(root, text);
			assert.deepEqual(await loadConfig(root), { readOnlyTools: DEFAULTS, pruneClosedAfterDays: 7, warnings: [warning(path, why)] }, text);
		}
	});
});

test("S17 an unreadable config path gives the defaults plus one warning", async () => {
	await withRoot(async (root) => {
		await mkdir(join(root, "config.json"), { recursive: true });
		assert.deepEqual(await loadConfig(root), { readOnlyTools: DEFAULTS, pruneClosedAfterDays: 7, warnings: [warning(join(root, "config.json"), "it cannot be read (EISDIR)")] });
	});
});

test("A3 readOnlyTools never allowlists bash, edit, or write: they are dropped with one exact warning", async () => {
	await withRoot(async (root) => {
		const path = join(root, "config.json");
		await writeConfig(root, JSON.stringify({ readOnlyTools: ["mem_search", "bash", "edit", "write", "docs"] }));
		assert.deepEqual(await loadConfig(root), {
			readOnlyTools: ["mem_search", "docs"],
			pruneClosedAfterDays: 7,
			warnings: [
				`teams: ${path}: "readOnlyTools" cannot list bash, edit, or write; question mode keeps asking the human before they run.`,
			],
		});
		await writeConfig(root, JSON.stringify({ readOnlyTools: ["write"] }));
		assert.deepEqual(await loadConfig(root), {
			readOnlyTools: [],
			pruneClosedAfterDays: 7,
			warnings: [`teams: ${path}: "readOnlyTools" cannot list write; question mode keeps asking the human before they run.`],
		});
	});
});

test("S20 pruneClosedAfterDays defaults to 7 and accepts a positive integer", async () => {
	await withRoot(async (root) => {
		assert.equal(DEFAULT_PRUNE_DAYS, 7);
		await writeConfig(root, JSON.stringify({ pruneClosedAfterDays: 30 }));
		assert.deepEqual(await loadConfig(root), { readOnlyTools: DEFAULTS, pruneClosedAfterDays: 30 });
		await writeConfig(root, JSON.stringify({ pruneClosedAfterDays: 1, readOnlyTools: ["x"] }));
		assert.deepEqual(await loadConfig(root), { readOnlyTools: ["x"], pruneClosedAfterDays: 1 });
	});
});

test("S20 an invalid pruneClosedAfterDays gives 7 plus one warning and keeps the other settings", async () => {
	await withRoot(async (root) => {
		const path = join(root, "config.json");
		for (const value of ["0", "-3", "1.5", '"7"', "null", "true", "[7]", "1e400"]) {
			await writeConfig(root, `{"readOnlyTools":["x"],"pruneClosedAfterDays":${value}}`);
			assert.deepEqual(
				await loadConfig(root),
				{
					readOnlyTools: ["x"],
					pruneClosedAfterDays: 7,
					warnings: [`teams: ${path}: "pruneClosedAfterDays" must be a positive whole number of days; using 7.`],
				},
				value,
			);
		}
	});
});
