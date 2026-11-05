import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.ts";
import { formatPeerMessage, pendingDeliveries, emptyCursor } from "../lib/delivery.ts";
import { createAgentTools, type ToolContext } from "../lib/tools.ts";
import {
	createQuestionMode,
	deniedReason,
	gateToolCall,
	noHumanReason,
	questionBlockReason,
	withdrawnReason,
	type ApprovalAnswer,
	type QuestionMode,
} from "../lib/question-mode.ts";
import { createTeamsExtension } from "../extensions/teams.ts";

const Q1 = "01JC000000000000000000000A";
const Q2 = "01JC000000000000000000000B";

/** A peer message as it enters the conversation (Pi adds role and timestamp). */
const peer = (requestId: string, delivery = "incoming-question", customType = "gentle-teams.peer") => ({
	role: "custom",
	customType,
	content: "Untrusted peer data ...",
	display: true,
	details: { team: "w", from: "frontend", requestId, requestKind: "question", delivery, transition: null, advanceTo: 1 },
	timestamp: 1,
});

const reason = (id: string) =>
	`Blocked: this session is answering a read-only peer question (request ${id}). Only read, grep, find, ls, multiagent_status, multiagent_request, multiagent_inbox, and multiagent_update are allowed until it is answered.`;

/** S15/S17: the extension's reason when no human can be asked (defaults: engram read tools allowed). */
const noHuman = (id: string, tool: string) =>
	`Blocked: this session is answering a read-only peer question (request ${id}). Only read, grep, find, ls, multiagent_status, multiagent_request, multiagent_inbox, multiagent_update, mem_search, mem_context, and mem_get_observation are allowed until it is answered. No human could be asked to allow ${tool}: neither this session nor the requester's session can show an approval prompt.`;

const BLOCKED = ["bash", "edit", "write", "subagent_run", "subagent_spawn", "mcp", "unknown_tool", "Read", "multiagent", "readx", "", "multiagent_future"];
const ALLOWED = ["read", "grep", "find", "ls", "multiagent_status", "multiagent_request", "multiagent_inbox", "multiagent_update"];

const active = (mode: QuestionMode, id: string) => {
	mode.messageEntered(peer(id));
	return mode;
};

test("S12 the block reason names the request and the allowed tools exactly", () => {
	assert.equal(questionBlockReason(Q1), reason(Q1));
});

test("S12 outside question mode no tool is blocked", () => {
	const mode = createQuestionMode();
	for (const name of [...BLOCKED, ...ALLOWED]) assert.equal(mode.toolCall(name), undefined, name);
	assert.deepEqual(mode.active, []);
});

test("S12 while answering, only read, grep, find, ls, and this plugin's four tools run", () => {
	const mode = active(createQuestionMode(), Q1);
	assert.deepEqual(mode.active, [Q1]);
	for (const name of BLOCKED) assert.deepEqual(mode.toolCall(name), { block: true, reason: reason(Q1) }, name);
	for (const name of ALLOWED) assert.equal(mode.toolCall(name), undefined, name);
});

test("S12 only an incoming question peer message activates the mode", () => {
	const mode = createQuestionMode();
	mode.messageEntered(peer(Q1, "reply"));
	mode.messageEntered(peer(Q1, "incoming-change"));
	mode.messageEntered(peer(Q1, "incoming-question", "other-extension"));
	mode.messageEntered({ role: "user", content: "hello", timestamp: 1 });
	mode.messageEntered({ role: "custom", customType: "gentle-teams.peer", content: "x", display: true, timestamp: 1 });
	mode.messageEntered(undefined);
	assert.deepEqual(mode.active, []);
	assert.equal(mode.toolCall("bash"), undefined);
});

test("S12 the message the session actually sends for a question activates the mode", () => {
	const record = { id: Q1, team: "w", from: "frontend", to: "backend", kind: "question" as const, title: "T", body: "B", dependsOn: [], createdAt: "" };
	const [delivery] = pendingDeliveries([{ record, events: [], state: "requested" }], emptyCursor(), "backend");
	const mode = createQuestionMode();
	mode.messageEntered({ role: "custom", ...formatPeerMessage(delivery!), timestamp: 1 });
	assert.deepEqual(mode.active, [Q1]);
});

test("S12 several active questions: the reason names the oldest; the mode ends when all are answered", () => {
	const mode = createQuestionMode();
	mode.messageEntered(peer(Q2));
	mode.messageEntered(peer(Q1));
	mode.messageEntered(peer(Q2)); // re-entry does not reorder
	assert.deepEqual(mode.active, [Q2, Q1]);
	assert.equal(mode.toolCall("bash")?.reason, reason(Q2));
	mode.answered(Q2, "complete");
	assert.equal(mode.toolCall("bash")?.reason, reason(Q1));
	mode.answered(Q1, "decline");
	assert.deepEqual(mode.active, []);
	assert.equal(mode.toolCall("bash"), undefined);
});

test("S12 complete or decline of that question ends it; a comment or another request does not", () => {
	const mode = active(createQuestionMode(), Q1);
	for (const transition of ["comment", "start", "cancel", "accept", "fail"]) {
		mode.answered(Q1, transition);
		assert.deepEqual(mode.active, [Q1], transition);
	}
	mode.answered(Q2, "complete");
	assert.deepEqual(mode.active, [Q1]);
	mode.answered(Q1, "complete");
	assert.deepEqual(mode.active, []);

	const declined = active(createQuestionMode(), Q1);
	declined.answered(Q1, "decline");
	assert.equal(declined.toolCall("edit"), undefined);
});

test("S12 Pi settling ends every active question", () => {
	const mode = active(active(createQuestionMode(), Q1), Q2);
	mode.settled();
	assert.deepEqual(mode.active, []);
	assert.equal(mode.toolCall("bash"), undefined);
});

// --- extension wiring with a fake Pi -------------------------------------------------

interface FakePi {
	handlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
	tools: Map<string, { execute: (...args: unknown[]) => Promise<{ isError?: boolean; details: unknown; content: { text: string }[] }> }>;
	emit(name: string, event?: unknown): Promise<unknown[]>;
}

/** Every loaded extension gets its own store root, so no test reads the real ~/.pi. */
const extensionRoots: string[] = [];
test.after(async () => {
	for (const base of extensionRoots) await rm(base, { recursive: true, force: true });
});

function loadExtension(): FakePi {
	const base = join(tmpdir(), `gentle-teams-ext-${process.pid}-${extensionRoots.length}`);
	extensionRoots.push(base);
	const fake: FakePi = {
		handlers: new Map(),
		tools: new Map(),
		async emit(name, event = {}) {
			const results: unknown[] = [];
			for (const handler of fake.handlers.get(name) ?? []) results.push(await handler(event, {}));
			return results;
		},
	};
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			fake.handlers.set(name, [...(fake.handlers.get(name) ?? []), handler]);
		},
		registerTool: (tool: { name: string }) => void fake.tools.set(tool.name, tool as never),
		registerCommand: () => undefined,
		sendMessage: () => undefined,
	};
	createTeamsExtension({ root: join(base, "multiagent") })(pi as never);
	return fake;
}

const toolCall = async (fake: FakePi, toolName: string) =>
	(await fake.emit("tool_call", { type: "tool_call", toolName, toolCallId: "t", input: {} })).find((r) => r !== undefined);

test("S11 the extension registers the four tools; unbound they fail with not-bound", async () => {
	const fake = loadExtension();
	assert.deepEqual([...fake.tools.keys()], ["multiagent_status", "multiagent_request", "multiagent_inbox", "multiagent_update"]);
	const ctx = { hasUI: false, ui: {} };
	for (const [name, params] of [
		["multiagent_status", {}],
		["multiagent_request", { to: "b", kind: "question", title: "T", body: "" }],
		["multiagent_inbox", {}],
		["multiagent_update", { requestId: Q1, transition: "complete" }],
	] as const) {
		const result = await fake.tools.get(name)!.execute("id", params, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.equal((result.details as { error: { code: string } }).error.code, "not-bound", name);
	}
});

test("S12 extension: a Pi auto-retry after agent_end keeps read-only mode until agent_settled", async () => {
	const fake = loadExtension();
	await fake.emit("agent_start");
	await fake.emit("message_start", { type: "message_start", message: peer(Q1) });
	await fake.emit("agent_end", { type: "agent_end", messages: [] }); // retryable provider error
	await fake.emit("agent_start"); // Pi's agent.continue() retry: no new message_start
	assert.deepEqual(await toolCall(fake, "bash"), { block: true, reason: noHuman(Q1, "bash") });
	await fake.emit("agent_end", { type: "agent_end", messages: [] });
	await fake.emit("agent_settled", { type: "agent_settled", aborted: false });
	assert.equal(await toolCall(fake, "bash"), undefined);
});

test("S12 only this plugin's own tools are allowed, not any multiagent_ prefix", () => {
	const mode = createQuestionMode();
	mode.messageEntered(peer(Q1));
	for (const name of ["multiagent_exec", "multiagent_bash", "multiagent_status ", "multiagent_\u200b", "multiagent_"]) {
		assert.deepEqual(mode.toolCall(name), { block: true, reason: reason(Q1) }, name);
	}
	for (const name of ["multiagent_status", "multiagent_request", "multiagent_inbox", "multiagent_update"]) {
		assert.equal(mode.toolCall(name), undefined, name);
	}
});

test("S12 extension: a question that starts an idle run enforces read-only until agent_settled", async () => {
	const fake = loadExtension();
	assert.equal(await toolCall(fake, "bash"), undefined);
	await fake.emit("agent_start");
	await fake.emit("message_start", { type: "message_start", message: peer(Q1) });
	assert.deepEqual(await toolCall(fake, "bash"), { block: true, reason: noHuman(Q1, "bash") });
	assert.deepEqual(await toolCall(fake, "write"), { block: true, reason: noHuman(Q1, "write") });
	assert.equal(await toolCall(fake, "read"), undefined);
	assert.equal(await toolCall(fake, "multiagent_update"), undefined);
	await fake.emit("agent_end", { type: "agent_end", messages: [] });
	await fake.emit("agent_settled", { type: "agent_settled", aborted: false });
	assert.equal(await toolCall(fake, "bash"), undefined);
});

test("S12 extension: a question delivered as followUp during a busy run applies from its delivery on", async () => {
	const fake = loadExtension();
	await fake.emit("agent_start");
	await fake.emit("message_start", { type: "message_start", message: { role: "user", content: "refactor", timestamp: 1 } });
	assert.equal(await toolCall(fake, "edit"), undefined, "work already in progress is not affected");
	// Pi delivers the queued followUp inside the same run, before agent_end.
	await fake.emit("message_start", { type: "message_start", message: peer(Q2) });
	assert.deepEqual(await toolCall(fake, "edit"), { block: true, reason: noHuman(Q2, "edit") });
	await fake.emit("agent_end", { type: "agent_end", messages: [] });
	await fake.emit("agent_settled", { type: "agent_settled", aborted: false });
	assert.equal(await toolCall(fake, "edit"), undefined);
});

test("S12 extension: a new session starts outside question mode", async () => {
	const fake = loadExtension();
	await fake.emit("message_start", { type: "message_start", message: peer(Q1) });
	await fake.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
	assert.equal(await toolCall(fake, "bash"), undefined);
});

// --- tools + question mode, as wired by the extension ----------------------------------

test("S11/S12 the model answering with multiagent_update ends question mode; a comment does not", async () => {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-qmode-"));
	try {
		const store = openStore(join(base, "multiagent"));
		await store.createTeam({ name: "w" });
		await store.joinMember("w", { alias: "frontend", repositoryRoot: "/repos/front" });
		await store.joinMember("w", { alias: "backend", repositoryRoot: "/repos/back" });
		const q = await store.createRequest("w", { from: "frontend", to: "backend", kind: "question", title: "Q", body: "" });
		const mode = createQuestionMode();
		const tools = new Map(
			createAgentTools({ store, binding: () => ({ team: "w", alias: "backend" }), onUpdated: (id, t) => mode.answered(id, t) }).map((t) => [t.name, t]),
		);
		const ctx: ToolContext = { hasUI: true, ui: { select: async () => "Send" } };
		mode.messageEntered(peer(q.id));
		assert.equal(mode.toolCall("bash")?.reason, reason(q.id));

		await tools.get("multiagent_update")!.execute("1", { requestId: q.id, transition: "comment", summary: "looking" }, undefined, undefined, ctx);
		assert.equal(mode.toolCall("bash")?.reason, reason(q.id), "a comment is not an answer");

		const answer = await tools.get("multiagent_update")!.execute("2", { requestId: q.id, transition: "complete", summary: "id, total" }, undefined, undefined, ctx);
		assert.notEqual(answer.isError, true);
		assert.equal(mode.toolCall("bash"), undefined);
		assert.equal((await store.readRequest("w", q.id)).state, "completed");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("S12 a rejected multiagent_update does not end question mode", async () => {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-qmode-"));
	try {
		const store = openStore(join(base, "multiagent"));
		await store.createTeam({ name: "w" });
		await store.joinMember("w", { alias: "frontend", repositoryRoot: "/repos/front" });
		await store.joinMember("w", { alias: "backend", repositoryRoot: "/repos/back" });
		const q = await store.createRequest("w", { from: "frontend", to: "backend", kind: "question", title: "Q", body: "" });
		await store.appendEvent("w", q.id, { actor: "frontend", transition: "cancel" });
		const mode = createQuestionMode();
		const [update] = createAgentTools({ store, binding: () => ({ team: "w", alias: "backend" }), onUpdated: (id, t) => mode.answered(id, t) }).filter(
			(t) => t.name === "multiagent_update",
		);
		mode.messageEntered(peer(q.id));
		const result = await update!.execute("1", { requestId: q.id, transition: "complete" }, undefined, undefined, { hasUI: false, ui: { select: async () => "Cancel" } });
		assert.equal(result.isError, true);
		assert.deepEqual(mode.active, [q.id]);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// --- S15-S17: ask instead of block --------------------------------------------------

const ENGRAM = ["mem_search", "mem_context", "mem_get_observation"];

test("S17 configured read-only tools run without asking, compared by exact name, and are listed in the reason", () => {
	const mode = active(createQuestionMode({ readOnlyTools: ENGRAM }), Q1);
	for (const name of [...ALLOWED, ...ENGRAM]) assert.equal(mode.blockingRequest(name), undefined, name);
	for (const name of ["mem_save", "Mem_search", "mem_search ", "mem_", "bash"]) assert.equal(mode.blockingRequest(name), Q1, name);
	assert.equal(
		mode.blockReason(Q1),
		`Blocked: this session is answering a read-only peer question (request ${Q1}). Only read, grep, find, ls, multiagent_status, multiagent_request, multiagent_inbox, multiagent_update, mem_search, mem_context, and mem_get_observation are allowed until it is answered.`,
	);
	mode.setReadOnlyTools(["context7_docs"]);
	assert.equal(mode.blockingRequest("mem_search"), Q1, "a new list replaces the old one");
	assert.equal(mode.blockingRequest("context7_docs"), undefined);
	assert.equal(createQuestionMode().blockReason(Q1), reason(Q1), "without configured tools the S12 reason is unchanged");
});

test("S16 the deny, no-human, and withdrawn reasons are exact", () => {
	assert.equal(deniedReason(Q1), `Denied by the human: this session is answering a read-only peer question (request ${Q1}).`);
	assert.equal(noHumanReason(Q1, "bash", ENGRAM), noHuman(Q1, "bash"));
	assert.equal(
		withdrawnReason(Q1, "bash", []),
		`${reason(Q1)} The approval request for bash was withdrawn before a human answered.`,
	);
});

/** A scripted approval port that records each question it was asked. */
const asker = (answers: ApprovalAnswer[]) => {
	const asked: { requestId: string; toolName: string; input: unknown; ctx: unknown }[] = [];
	return {
		asked,
		ask: async (requestId: string, call: { toolName: string; input: unknown }, ctx: unknown) => {
			asked.push({ requestId, toolName: call.toolName, input: call.input, ctx });
			const next = answers.shift();
			if (next === undefined) throw new Error("unexpected ask");
			return next;
		},
	};
};

test("S15 an allowed tool or no active question never asks", async () => {
	const { asked, ask } = asker([]);
	const idle = createQuestionMode({ readOnlyTools: ENGRAM });
	assert.equal(await gateToolCall(idle, { toolName: "bash", input: {} }, {}, ask), undefined);
	const mode = active(createQuestionMode({ readOnlyTools: ENGRAM }), Q1);
	for (const name of [...ALLOWED, ...ENGRAM]) assert.equal(await gateToolCall(mode, { toolName: name, input: {} }, {}, ask), undefined, name);
	assert.deepEqual(asked, []);
});

test("S16 allow once runs only this call: the next blocked call asks again", async () => {
	const { asked, ask } = asker(["allow-once", "deny"]);
	const mode = active(createQuestionMode(), Q1);
	const ctx = { tag: "ctx" };
	assert.equal(await gateToolCall(mode, { toolName: "bash", input: { command: "npm test" } }, ctx, ask), undefined);
	assert.deepEqual(asked, [{ requestId: Q1, toolName: "bash", input: { command: "npm test" }, ctx }]);
	assert.deepEqual(await gateToolCall(mode, { toolName: "bash", input: { command: "ls" } }, ctx, ask), { block: true, reason: deniedReason(Q1) });
	assert.equal(asked.length, 2);
	assert.deepEqual(mode.active, [Q1], "a decision never ends the question");
});

test("S16 allow for the rest of this request lifts question mode for that request until it ends", async () => {
	const { asked, ask } = asker(["allow-request", "deny"]);
	const mode = active(createQuestionMode(), Q1);
	assert.equal(await gateToolCall(mode, { toolName: "bash", input: {} }, {}, ask), undefined);
	assert.equal(await gateToolCall(mode, { toolName: "edit", input: {} }, {}, ask), undefined, "no second prompt");
	assert.equal(mode.toolCall("write"), undefined);
	assert.equal(asked.length, 1);

	// Another question still asks, naming its own request.
	mode.messageEntered(peer(Q2));
	assert.equal(mode.blockingRequest("bash"), Q2);
	assert.deepEqual(await gateToolCall(mode, { toolName: "bash", input: {} }, {}, ask), { block: true, reason: deniedReason(Q2) });
	assert.equal(asked[1]!.requestId, Q2);

	// The lift ends with the request's question: a new delivery of it asks again.
	mode.answered(Q1, "complete");
	mode.answered(Q2, "complete");
	mode.messageEntered(peer(Q1));
	assert.equal(mode.blockingRequest("bash"), Q1);
	mode.lift(Q1);
	mode.settled();
	mode.messageEntered(peer(Q1));
	assert.equal(mode.blockingRequest("bash"), Q1, "settling ends the lift too");
	mode.lift(Q2);
	mode.messageEntered(peer(Q2));
	mode.lift(Q1);
	assert.equal(mode.blockingRequest("bash"), Q2, "lifting an inactive request has no effect");
});

test("S15 no human, a withdrawn approval, or a failing ask blocks the call", async () => {
	const mode = active(createQuestionMode({ readOnlyTools: ENGRAM }), Q1);
	assert.deepEqual(await gateToolCall(mode, { toolName: "bash", input: {} }, {}, asker(["no-human"]).ask), { block: true, reason: noHuman(Q1, "bash") });
	assert.deepEqual(await gateToolCall(mode, { toolName: "write", input: {} }, {}, asker(["withdrawn"]).ask), {
		block: true,
		reason: withdrawnReason(Q1, "write", ENGRAM),
	});
	assert.deepEqual(await gateToolCall(mode, { toolName: "edit", input: {} }, {}, asker([]).ask), { block: true, reason: mode.blockReason(Q1) });
	assert.deepEqual(await gateToolCall(mode, { toolName: "edit", input: {} }, {}), { block: true, reason: mode.blockReason(Q1) }, "without an ask port the S12 block applies");
	assert.deepEqual(mode.active, [Q1]);
});

test("S17 extension: engram read tools run without asking while answering a question", async () => {
	const fake = loadExtension();
	await fake.emit("message_start", { type: "message_start", message: peer(Q1) });
	for (const name of ENGRAM) assert.equal(await toolCall(fake, name), undefined, name);
	assert.deepEqual(await toolCall(fake, "mem_save"), { block: true, reason: noHuman(Q1, "mem_save") });
});
