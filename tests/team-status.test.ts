import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTeamStatus } from "../lib/team-status.ts";

const base = { team: "tienda-online", self: "backend", members: [
	{ alias: "frontend", state: "active" as const }, { alias: "admin", state: "offline" as const }, { alias: "backend", state: "idle" as const },
], pendingApprovals: 0, requests: [] };

test("S23 ordered identity, presence glyphs and omitted request", () => {
	assert.deepEqual(formatTeamStatus(base), [
		["gentle-teams.1", "teams: tienda-online · ★ backend"],
		["gentle-teams.2", "○ admin  ◐ backend  ● frontend"],
		["gentle-teams.3", undefined],
	]);
});

test("S23 approvals take priority and pluralize", () => {
	const requests = [{ title: "Work", state: "requested" as const, lastActivity: "2026-01-01" }];
	assert.equal(formatTeamStatus({ ...base, requests, pendingApprovals: 1 })[2][1], "⚠ 1 approval waiting");
	assert.equal(formatTeamStatus({ ...base, requests, pendingApprovals: 2 })[2][1], "⚠ 2 approvals waiting");
});

test("S23 latest nonterminal request, neutralized and truncated", () => {
	const requests = [
		{ title: "Older", state: "accepted" as const, lastActivity: "2026-01-01" },
		{ title: "Done", state: "completed" as const, lastActivity: "2026-01-03" },
		{ title: "Fix\n\u202eboom " + "x".repeat(60), state: "in_progress" as const, lastActivity: "2026-01-02" },
	];
	assert.equal(formatTeamStatus({ ...base, requests })[2][1], `▸ Fix boom ${"x".repeat(38)}… · in_progress`);
	assert.equal(formatTeamStatus({ ...base, requests: [requests[1]!] })[2][1], undefined);
});
