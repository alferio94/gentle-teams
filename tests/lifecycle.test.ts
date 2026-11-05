import { test } from "node:test";
import assert from "node:assert/strict";
import {
	deriveState,
	isTerminal,
	nextState,
	REQUEST_STATES,
	TRANSITIONS,
	type RequestKind,
	type RequestState,
	type Role,
	type Transition,
} from "../lib/lifecycle.ts";

type Row = [RequestKind, RequestState, Transition, Role, RequestState];

const ALLOWED: Row[] = [
	["change", "requested", "accept", "recipient", "accepted"],
	["change", "requested", "decline", "recipient", "declined"],
	["change", "requested", "cancel", "requester", "cancelled"],
	["change", "accepted", "start", "recipient", "in_progress"],
	["change", "accepted", "cancel", "requester", "cancelled"],
	["change", "in_progress", "ask-human", "recipient", "needs_decision"],
	["change", "in_progress", "complete", "recipient", "completed"],
	["change", "in_progress", "fail", "recipient", "failed"],
	["change", "needs_decision", "resume", "recipient", "in_progress"],
	["change", "needs_decision", "fail", "recipient", "failed"],
	["question", "requested", "complete", "recipient", "completed"],
	["question", "requested", "decline", "recipient", "declined"],
	["question", "requested", "cancel", "requester", "cancelled"],
];

const OPEN: RequestState[] = ["requested", "accepted", "in_progress", "needs_decision"];

test("allowed transitions move to the expected state", () => {
	for (const [kind, state, transition, role, expected] of ALLOWED) {
		assert.deepEqual(nextState(kind, state, transition, role), { ok: true, state: expected }, `${kind} ${state} ${transition} ${role}`);
	}
});

test("comment is allowed for both roles in open states and keeps the state", () => {
	for (const kind of ["change", "question"] as const) {
		for (const state of OPEN) {
			for (const role of ["requester", "recipient"] as const) {
				assert.deepEqual(nextState(kind, state, "comment", role), { ok: true, state });
			}
		}
	}
});

test("every other combination is rejected with transition-not-allowed", () => {
	const allowed = new Set(ALLOWED.map(([k, s, t, r]) => `${k}|${s}|${t}|${r}`));
	for (const kind of ["change", "question"] as const) {
		for (const state of REQUEST_STATES) {
			for (const transition of TRANSITIONS) {
				for (const role of ["requester", "recipient"] as const) {
					const key = `${kind}|${state}|${transition}|${role}`;
					if (allowed.has(key)) continue;
					if (transition === "comment" && OPEN.includes(state)) continue;
					const result = nextState(kind, state, transition, role);
					assert.equal(result.ok, false, key);
					if (!result.ok) assert.equal(result.code, "transition-not-allowed", key);
				}
			}
		}
	}
});

test("rejection messages name the actor rule or the state rule", () => {
	assert.deepEqual(nextState("change", "requested", "accept", "requester"), {
		ok: false,
		code: "transition-not-allowed",
		message: 'Only the recipient can "accept" a request.',
	});
	assert.deepEqual(nextState("change", "requested", "cancel", "recipient"), {
		ok: false,
		code: "transition-not-allowed",
		message: 'Only the requester can "cancel" a request.',
	});
	assert.deepEqual(nextState("question", "requested", "accept", "recipient"), {
		ok: false,
		code: "transition-not-allowed",
		message: '"accept" is not allowed for a question in state "requested".',
	});
	assert.deepEqual(nextState("change", "completed", "comment", "requester"), {
		ok: false,
		code: "transition-not-allowed",
		message: '"comment" is not allowed for a change in state "completed".',
	});
});

test("terminal states are exactly declined, cancelled, completed, failed", () => {
	assert.deepEqual(
		REQUEST_STATES.filter(isTerminal),
		["declined", "cancelled", "completed", "failed"],
	);
});

test("deriveState replays events from requested", () => {
	assert.equal(deriveState("change", []), "requested");
	assert.equal(
		deriveState("change", [
			{ transition: "accept", role: "recipient" },
			{ transition: "comment", role: "requester" },
			{ transition: "start", role: "recipient" },
			{ transition: "ask-human", role: "recipient" },
			{ transition: "resume", role: "recipient" },
			{ transition: "complete", role: "recipient" },
		]),
		"completed",
	);
	assert.equal(deriveState("question", [{ transition: "complete", role: "recipient" }]), "completed");
});

test("deriveState rejects an invalid history with the failing event index", () => {
	assert.throws(
		() => deriveState("change", [
			{ transition: "accept", role: "recipient" },
			{ transition: "complete", role: "recipient" },
		]),
		{ name: "LifecycleError", code: "transition-not-allowed", message: 'Event 1: "complete" is not allowed for a change in state "accepted".' },
	);
});
