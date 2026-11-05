/**
 * Read-only question mode (feature spec S12, docs/architecture.md §5.1).
 *
 * While this session answers an incoming peer `question`, every tool except an
 * allowlist is blocked by a `tool_call` hook, so read-only is enforced rather than
 * only instructed.
 *
 * - Starts when a `gentle-teams.peer` message with delivery `incoming-question`
 *   enters the conversation (`message_start`). Pi emits it both when the message
 *   starts an idle run and when a queued followUp is consumed inside a busy run.
 * - A question ends when this session posts `complete` or `decline` on it (a comment
 *   is not an answer), or when Pi settles (`agent_settled`), which ends all. Not at
 *   `agent_end`: Pi may auto-retry, compact and retry, or continue after it without a
 *   new `message_start` for the question already in context.
 * - Several questions can be active at once; the mode lasts until none is left.
 * - S15-S17: besides the built-in allowlist, configured read-only tools run without
 *   asking; any other call asks the human (gateToolCall) instead of being blocked at
 *   once. "Allow for the rest of this request" lifts the mode for that request.
 */

import { PEER_MESSAGE_TYPE } from "./delivery.ts";
import { AGENT_TOOL_NAMES } from "./tools.ts";

export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
const ANSWER_TRANSITIONS: ReadonlySet<string> = new Set(["complete", "decline"]);

/** `extra` are the configured read-only tools (S17), compared by exact name. */
export function isAllowedWhileAnswering(toolName: string, extra: readonly string[] = []): boolean {
	// Exact names only: a third-party tool named multiagent_* is not this plugin's.
	return READ_ONLY_TOOLS.includes(toolName) || AGENT_TOOL_NAMES.includes(toolName) || extra.includes(toolName);
}

const list = (names: readonly string[]): string =>
	names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

export function questionBlockReason(requestId: string, extra: readonly string[] = []): string {
	const allowed = [...READ_ONLY_TOOLS, ...AGENT_TOOL_NAMES, ...extra.filter((name) => !READ_ONLY_TOOLS.includes(name) && !AGENT_TOOL_NAMES.includes(name))];
	return `Blocked: this session is answering a read-only peer question (request ${requestId}). Only ${list(allowed)} are allowed until it is answered.`;
}

/** S16: the human chose Deny (or dismissed the approval dialog). */
export function deniedReason(requestId: string): string {
	return `Denied by the human: this session is answering a read-only peer question (request ${requestId}).`;
}

/** S15: neither session could show an approval prompt. */
export function noHumanReason(requestId: string, toolName: string, extra: readonly string[] = []): string {
	return `${questionBlockReason(requestId, extra)} No human could be asked to allow ${toolName}: neither this session nor the requester's session can show an approval prompt.`;
}

/** S15: the approval was withdrawn (run aborted, session unbound) before a human answered. */
export function withdrawnReason(requestId: string, toolName: string, extra: readonly string[] = []): string {
	return `${questionBlockReason(requestId, extra)} The approval request for ${toolName} was withdrawn before a human answered.`;
}

/** Request id of an incoming question peer message, or undefined for any other message. */
export function incomingQuestionId(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const m = message as { role?: unknown; customType?: unknown; details?: { delivery?: unknown; requestId?: unknown } };
	if (m.role !== "custom" || m.customType !== PEER_MESSAGE_TYPE) return undefined;
	if (m.details?.delivery !== "incoming-question" || typeof m.details.requestId !== "string") return undefined;
	return m.details.requestId;
}

export interface QuestionModeOptions {
	/** Configured read-only tools (S17); defaults to none. */
	readOnlyTools?: readonly string[];
}

export interface QuestionMode {
	/** Active question request ids, oldest first. */
	readonly active: readonly string[];
	/** Configured read-only tools allowed besides the built-in allowlist. */
	readonly readOnlyTools: readonly string[];
	setReadOnlyTools(names: readonly string[]): void;
	messageEntered(message: unknown): void;
	/** This session posted `transition` on `requestId`. */
	answered(requestId: string, transition: string): void;
	/** Pi settled: it will not continue running automatically. */
	settled(): void;
	reset(): void;
	/**
	 * S16 "Allow for the rest of this request": tools run without asking while this
	 * request's question stays active. Ends with the question. No effect when inactive.
	 */
	lift(requestId: string): void;
	/** The oldest active, not lifted question that blocks `toolName`, or undefined. */
	blockingRequest(toolName: string): string | undefined;
	blockReason(requestId: string): string;
	/** Synchronous S12 decision: a block result, or undefined to let the call run. */
	toolCall(toolName: string): { block: true; reason: string } | undefined;
}

export function createQuestionMode(options: QuestionModeOptions = {}): QuestionMode {
	// A Set keeps insertion order, so the first entry is the oldest active question.
	const active = new Set<string>();
	const lifted = new Set<string>();
	let readOnlyTools: readonly string[] = [...(options.readOnlyTools ?? [])];
	const end = (requestId: string) => {
		active.delete(requestId);
		lifted.delete(requestId);
	};
	const mode: QuestionMode = {
		get active() {
			return [...active];
		},
		get readOnlyTools() {
			return readOnlyTools;
		},
		setReadOnlyTools(names) {
			readOnlyTools = [...names];
		},
		messageEntered(message) {
			const id = incomingQuestionId(message);
			if (id !== undefined) active.add(id);
		},
		answered(requestId, transition) {
			if (ANSWER_TRANSITIONS.has(transition)) end(requestId);
		},
		settled() {
			active.clear();
			lifted.clear();
		},
		reset() {
			active.clear();
			lifted.clear();
		},
		lift(requestId) {
			if (active.has(requestId)) lifted.add(requestId);
		},
		blockingRequest(toolName) {
			if (isAllowedWhileAnswering(toolName, readOnlyTools)) return undefined;
			for (const id of active) if (!lifted.has(id)) return id;
			return undefined;
		},
		blockReason(requestId) {
			return questionBlockReason(requestId, readOnlyTools);
		},
		toolCall(toolName) {
			const id = mode.blockingRequest(toolName);
			return id === undefined ? undefined : { block: true, reason: mode.blockReason(id) };
		},
	};
	return mode;
}

/** The human's answer to an approval request (S15, S16), as seen by the tool call. */
export type ApprovalAnswer = "allow-once" | "allow-request" | "deny" | "no-human" | "withdrawn";

/** Ask the humans (both terminals) whether a blocked call may run; see TeamSession.askApproval. */
export type AskApproval = (requestId: string, call: { toolName: string; input: unknown }, ctx: unknown) => Promise<ApprovalAnswer>;

/**
 * `tool_call` decision with approval (S15): a call question mode would block asks the
 * human instead, and waits for the answer. Without `ask`, it blocks as in S12. A
 * failing ask blocks (fail closed).
 */
export async function gateToolCall(
	mode: QuestionMode,
	call: { toolName: string; input: unknown },
	ctx: unknown,
	ask?: AskApproval,
): Promise<{ block: true; reason: string } | undefined> {
	const requestId = mode.blockingRequest(call.toolName);
	if (requestId === undefined) return undefined;
	const blocked = (reason: string) => ({ block: true, reason }) as const;
	if (!ask) return blocked(mode.blockReason(requestId));
	let answer: ApprovalAnswer;
	try {
		answer = await ask(requestId, call, ctx);
	} catch {
		return blocked(mode.blockReason(requestId));
	}
	switch (answer) {
		case "allow-once":
			return undefined;
		case "allow-request":
			mode.lift(requestId);
			return undefined;
		case "deny":
			return blocked(deniedReason(requestId));
		case "no-human":
			return blocked(noHumanReason(requestId, call.toolName, mode.readOnlyTools));
		case "withdrawn":
			return blocked(withdrawnReason(requestId, call.toolName, mode.readOnlyTools));
		default:
			return blocked(mode.blockReason(requestId));
	}
}

/** Minimal event surface of Pi's ExtensionAPI used by the adapter. */
export interface QuestionModeEvents {
	on(event: "message_start", handler: (event: { message: unknown }) => unknown): void;
	on(event: "agent_settled", handler: () => unknown): void;
	on(event: "tool_call", handler: (event: { toolName: string; input?: unknown }, ctx: unknown) => unknown): void;
}

/** Wire a question mode to Pi events; with `ask`, blocked calls ask the human first (S15). */
export function attachQuestionMode(pi: QuestionModeEvents, mode: QuestionMode, ask?: AskApproval): void {
	pi.on("message_start", (event) => mode.messageEntered(event.message));
	pi.on("agent_settled", () => mode.settled());
	pi.on("tool_call", (event, ctx) => gateToolCall(mode, { toolName: event.toolName, input: event.input }, ctx, ask));
}
