/**
 * Agent-facing tools (feature spec S11, docs/architecture.md §6).
 *
 * Definitions follow Pi's `registerTool` shape. Parameters are plain JSON Schema
 * objects (Pi validates tool arguments as JSON Schema, whatever built them), so the
 * package needs no runtime dependency. `execute` validates again, because the store
 * is the authority and direct callers skip Pi's validation.
 *
 * Failures are returned as error results (`isError: true`) whose text is
 * `<code>: <message>`; store errors keep their typed code and message unchanged.
 * Every tool fails with `not-bound` while the session is not bound to a member.
 * The model can never accept or decline a change request (L14): only a human can,
 * through the S8 prompt in the recipient session, the S18 send dialog, or /teams.
 */

import { visibleLine } from "./approvals.ts";
import { ACCEPTED_ON_BEHALF, listDeliverableRequests } from "./delivery.ts";
import { isTerminal, REQUEST_KINDS, REQUEST_STATES, TRANSITIONS, type RequestState } from "./lifecycle.ts";
import { openPresence, type Presence } from "./presence.ts";
import { TeamStoreError, type RequestView, type StoreErrorCode, type Store } from "./store.ts";

export const AGENT_TOOL_NAMES = ["multiagent_status", "multiagent_request", "multiagent_inbox", "multiagent_update"];
export const NOT_BOUND_MESSAGE = "This session is not bound to a team member; bind it with /teams or at session start.";
export const CONFIRM_CHANGE_TITLE = "Send this change request to another team member?";
/** S18: the single dialog shown before a change request is sent. */
export const SEND_CHANGE_CHOICES = ["Send", "Send and accept on the recipient's behalf", "Cancel"] as const;
const PREVIEW_MAX = 200;

export type ToolErrorCode =
	| StoreErrorCode
	| "not-bound"
	| "human-confirmation-required"
	| "cancelled-by-human"
	| "human-decision-required"
	| "invalid-state";

export class ToolError extends Error {
	override readonly name = "ToolError";
	readonly code: ToolErrorCode;
	constructor(code: ToolErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export interface Binding {
	team: string;
	alias: string;
}

export interface ToolPorts {
	store: Store;
	/** The session's current binding, read at each call. */
	binding(): Binding | undefined;
	/** Defaults to openPresence(store). */
	presence?: Presence;
	now?: () => number;
	/** Called after an update event was appended by this session. */
	onUpdated?: (requestId: string, transition: string) => void;
}

/** The part of Pi's ExtensionContext the tools use. */
export interface ToolContext {
	hasUI: boolean;
	/** Pi's ctx.ui.select; dismissing resolves undefined. */
	ui: { select(title: string, options: string[]): Promise<string | undefined> };
}

export interface ToolResult {
	content: { type: "text"; text: string }[];
	details: unknown;
	isError?: true;
}

export interface AgentTool {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: Record<string, unknown>;
	execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ToolContext): Promise<ToolResult>;
}

const success = (details: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details });
const failure = (code: string, message: string): ToolResult => ({
	content: [{ type: "text", text: `${code}: ${message}` }],
	details: { error: { code, message } },
	isError: true,
});

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

/** One visible line: no control, bidi, or zero-width characters; fences neutralized (A5). */
const shown = (text: string): string => visibleLine(text, Number.MAX_SAFE_INTEGER);

const preview = (body: string): string => {
	const line = shown(body);
	return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX)} …(truncated)` : line;
};

type Params = Record<string, unknown>;

export function createAgentTools(ports: ToolPorts): AgentTool[] {
	const { store } = ports;
	const presence = ports.presence ?? openPresence(store, { now: ports.now });

	const requireBinding = (): Binding => {
		const binding = ports.binding();
		if (!binding) throw new ToolError("not-bound", NOT_BOUND_MESSAGE);
		return binding;
	};

	/** Requests of the team; an unreadable one is skipped and listed by id. */
	async function readable(team: string): Promise<{ views: RequestView[]; unreadable: string[] }> {
		const unreadable: string[] = [];
		const views = await listDeliverableRequests(store, team, (id) => void unreadable.push(id));
		return { views, unreadable };
	}

	async function status(): Promise<unknown> {
		const { team, alias } = requireBinding();
		const members = [];
		for (const member of await store.listMembers(team)) {
			const current = await presence.status(team, member.alias);
			members.push({
				alias: member.alias,
				repositoryRoot: member.repositoryRoot,
				presence: current.online ? current.record.state : "offline",
				self: member.alias === alias,
			});
		}
		const { views, unreadable } = await readable(team);
		const open = views.filter((v) => !isTerminal(v.state));
		return {
			team,
			alias,
			members,
			open: {
				sent: open.filter((v) => v.record.from === alias).length,
				received: open.filter((v) => v.record.to === alias).length,
			},
			...(unreadable.length > 0 ? { unreadable } : {}),
		};
	}

	async function request(params: Params, ctx: ToolContext): Promise<unknown> {
		const { team, alias } = requireBinding();
		const input = {
			from: alias,
			to: params.to as string,
			kind: params.kind as (typeof REQUEST_KINDS)[number],
			title: params.title as string,
			body: params.body as string,
			dependsOn: params.dependsOn as string[] | undefined,
		};
		let onBehalf = false;
		if (input.kind === "change") {
			// Fail before asking the human when the recipient cannot receive it anyway.
			const members = await store.listMembers(team);
			if (!members.some((m) => m.alias === input.to)) {
				throw new ToolError("unknown-member", `Member "${String(input.to)}" is not part of team "${team}".`);
			}
			if (input.to === alias) throw new ToolError("self-request", "A member cannot send a request to itself.");
			if (!ctx.hasUI) {
				throw new ToolError(
					"human-confirmation-required",
					"A change request needs the human's confirmation in this session, and this session has no interactive UI; nothing was sent.",
				);
			}
			const message = [
				`Team: ${team}`,
				`To: ${shown(String(input.to))}`,
				`Title: ${shown(String(input.title))}`,
				`Body: ${preview(typeof input.body === "string" ? input.body : "")}`,
			].join("\n");
			const choice = await ctx.ui.select(`${CONFIRM_CHANGE_TITLE}\n${message}`, [...SEND_CHANGE_CHOICES]);
			if (choice !== SEND_CHANGE_CHOICES[0] && choice !== SEND_CHANGE_CHOICES[1]) {
				throw new ToolError("cancelled-by-human", "The human in this session did not confirm the change request; nothing was sent.");
			}
			onBehalf = choice === SEND_CHANGE_CHOICES[1];
		}
		const record = await store.createRequest(team, input);
		let state: RequestState = "requested";
		if (onBehalf) {
			// S18: the human decided for the recipient; its session tells its model once.
			try {
				({ state } = await store.appendEvent(team, record.id, { actor: record.to, transition: "accept", summary: ACCEPTED_ON_BEHALF }));
			} catch (error) {
				// Sent, but the recipient decided first (or the request changed): report what is stored.
				if (!(error instanceof TeamStoreError)) throw error;
				state = (await store.readRequest(team, record.id)).state;
			}
		}
		return {
			id: record.id,
			team,
			from: record.from,
			to: record.to,
			kind: record.kind,
			title: record.title,
			state,
			dependsOn: record.dependsOn,
			...(onBehalf ? { acceptedOnBehalf: state === "accepted" } : {}),
		};
	}

	async function inbox(params: Params): Promise<unknown> {
		const { team, alias } = requireBinding();
		const state = params.state;
		if (state !== undefined && !(REQUEST_STATES as readonly unknown[]).includes(state)) {
			throw new ToolError("invalid-state", `Unknown request state "${String(state)}"; use one of: ${REQUEST_STATES.join(", ")}.`);
		}
		const { views, unreadable } = await readable(team);
		const requests = views
			.filter((v) => v.record.from === alias || v.record.to === alias)
			.filter((v) => state === undefined || v.state === state)
			.map(({ record, state }) => ({ id: record.id, kind: record.kind, from: record.from, to: record.to, title: record.title, state }));
		return { team, alias, requests, ...(unreadable.length > 0 ? { unreadable } : {}) };
	}

	async function update(params: Params): Promise<unknown> {
		const { team, alias } = requireBinding();
		const requestId = params.requestId as string;
		const transition = params.transition as (typeof TRANSITIONS)[number];
		const { record } = await store.readRequest(team, requestId);
		if (record.kind === "change" && (transition === "accept" || transition === "decline")) {
			throw new ToolError(
				"human-decision-required",
				`Only the human in this session can accept or decline change request ${record.id}; use the prompt shown by the teams plugin.`,
			);
		}
		const { event, state } = await store.appendEvent(team, record.id, {
			actor: alias,
			transition,
			...(params.summary !== undefined ? { summary: params.summary as string } : {}),
			...(params.evidence !== undefined ? { evidence: params.evidence as string[] } : {}),
		});
		ports.onUpdated?.(record.id, event.transition);
		return { requestId: record.id, transition: event.transition, state, seq: event.seq };
	}

	const run =
		(fn: (params: Params, ctx: ToolContext) => Promise<unknown>): AgentTool["execute"] =>
		async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				return success(await fn((params ?? {}) as Params, ctx));
			} catch (error) {
				if (error instanceof ToolError || error instanceof TeamStoreError) return failure(error.code, error.message);
				throw error;
			}
		};

	return [
		{
			name: "multiagent_status",
			label: "Team status",
			description:
				"Show this session's team binding: team, own alias, members with presence (active, idle, offline), and counts of open requests sent and received.",
			promptSnippet: "Show the team binding, members with presence, and open request counts",
			promptGuidelines: ["Use multiagent_status to see which team members exist and whether they are online before sending a request."],
			parameters: objectSchema({}),
			execute: run(() => status()),
		},
		{
			name: "multiagent_request",
			label: "Team request",
			description:
				"Send a request to another member of this session's team. kind 'question' asks for a read-only answer; kind 'change' asks the member to change its repository and needs the human's confirmation in this session first. dependsOn lists existing request ids that must complete first.",
			promptSnippet: "Send a question or change request to another team member",
			promptGuidelines: [
				"Use multiagent_request with kind 'question' for information from another repository and kind 'change' only for work in that repository; a change is sent only after the human in this session confirms it.",
			],
			parameters: objectSchema(
				{
					to: { type: "string", description: "Alias of the recipient member." },
					kind: { type: "string", enum: [...REQUEST_KINDS] },
					title: { type: "string", description: "Short title, at most 120 characters." },
					body: { type: "string", description: "Request details, at most 8192 bytes." },
					dependsOn: { type: "array", items: { type: "string" }, description: "Existing request ids this request depends on." },
				},
				["to", "kind", "title", "body"],
			),
			execute: run(request),
		},
		{
			name: "multiagent_inbox",
			label: "Team inbox",
			description: "List the requests this member sent or received, with their current state. Optionally filter by state.",
			promptSnippet: "List requests this team member sent or received, with their state",
			promptGuidelines: ["Use multiagent_inbox to find request ids before calling multiagent_update."],
			parameters: objectSchema({ state: { type: "string", enum: [...REQUEST_STATES] } }),
			execute: run(inbox),
		},
		{
			name: "multiagent_update",
			label: "Team update",
			description:
				"Post a transition on a request as this member: answer a question with 'complete' (summary = answer) or 'decline'; on an accepted change use 'start', 'ask-human', 'resume', 'complete', or 'fail'; the requester may 'cancel'; either side may 'comment'. Accepting or declining a change request is reserved to the human.",
			promptSnippet: "Answer, progress, complete, cancel, or comment on a team request",
			promptGuidelines: [
				"multiagent_update cannot accept or decline a change request; only the human decides those through the teams prompt.",
				"Answer a peer question with multiagent_update transition 'complete' and the answer as summary; a 'comment' does not answer it.",
			],
			parameters: objectSchema(
				{
					requestId: { type: "string" },
					transition: { type: "string", enum: [...TRANSITIONS] },
					summary: { type: "string", description: "Answer, result, or comment text, at most 8192 bytes." },
					evidence: { type: "array", items: { type: "string" }, description: "References such as branch, commit, PR, or file path." },
				},
				["requestId", "transition"],
			),
			execute: run(update),
		},
	];
}
