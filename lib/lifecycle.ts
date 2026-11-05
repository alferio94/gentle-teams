/**
 * Request lifecycle: a pure state machine with one allowed actor per transition.
 * See docs/architecture.md §4.
 */

export const REQUEST_KINDS = ["question", "change"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATES = [
	"requested",
	"accepted",
	"in_progress",
	"needs_decision",
	"declined",
	"cancelled",
	"completed",
	"failed",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const TRANSITIONS = [
	"accept",
	"decline",
	"cancel",
	"start",
	"ask-human",
	"resume",
	"complete",
	"fail",
	"comment",
] as const;
export type Transition = (typeof TRANSITIONS)[number];

export type Role = "requester" | "recipient";

export type TransitionResult =
	| { ok: true; state: RequestState }
	| { ok: false; code: "transition-not-allowed"; message: string };

export class LifecycleError extends Error {
	override readonly name = "LifecycleError";
	readonly code: "transition-not-allowed";
	constructor(code: "transition-not-allowed", message: string) {
		super(message);
		this.code = code;
	}
}

const TERMINAL: ReadonlySet<RequestState> = new Set(["declined", "cancelled", "completed", "failed"]);

/** Who may apply each state-changing transition. `comment` is handled separately. */
const ACTOR: Record<Exclude<Transition, "comment">, Role> = {
	accept: "recipient",
	decline: "recipient",
	cancel: "requester",
	start: "recipient",
	"ask-human": "recipient",
	resume: "recipient",
	complete: "recipient",
	fail: "recipient",
};

type Edges = Partial<Record<RequestState, Partial<Record<Exclude<Transition, "comment">, RequestState>>>>;

const EDGES: Record<RequestKind, Edges> = {
	change: {
		requested: { accept: "accepted", decline: "declined", cancel: "cancelled" },
		accepted: { start: "in_progress", cancel: "cancelled" },
		in_progress: { "ask-human": "needs_decision", complete: "completed", fail: "failed" },
		needs_decision: { resume: "in_progress", fail: "failed" },
	},
	question: {
		requested: { complete: "completed", decline: "declined", cancel: "cancelled" },
	},
};

export function isTerminal(state: RequestState): boolean {
	return TERMINAL.has(state);
}

export function nextState(kind: RequestKind, state: RequestState, transition: Transition, role: Role): TransitionResult {
	const notAllowed = (): TransitionResult => ({
		ok: false,
		code: "transition-not-allowed",
		message: `"${transition}" is not allowed for a ${kind} in state "${state}".`,
	});

	if (transition === "comment") {
		return isTerminal(state) ? notAllowed() : { ok: true, state };
	}

	const target = EDGES[kind][state]?.[transition];
	if (target === undefined) return notAllowed();

	const actor = ACTOR[transition];
	if (role !== actor) {
		return { ok: false, code: "transition-not-allowed", message: `Only the ${actor} can "${transition}" a request.` };
	}
	return { ok: true, state: target };
}

export interface LifecycleEvent {
	transition: Transition;
	role: Role;
}

/** Replay a request's events from `requested`. Throws LifecycleError on the first invalid event. */
export function deriveState(kind: RequestKind, events: readonly LifecycleEvent[]): RequestState {
	let state: RequestState = "requested";
	events.forEach((event, index) => {
		const result = nextState(kind, state, event.transition, event.role);
		if (!result.ok) throw new LifecycleError(result.code, `Event ${index}: ${result.message}`);
		state = result.state;
	});
	return state;
}
