/**
 * One Pi session's team binding (feature spec S7-S10, docs/architecture.md §5).
 *
 * All side effects go through injected ports so the logic is tested with fakes; the
 * extension (extensions/teams.ts) only wires Pi events to this object.
 *
 * - start(cwd): resolve the Git root, find member roles for it, ask the human which
 *   one to bind (never silently), claim presence, start heartbeat and watcher, and
 *   run a delivery pass.
 * - Delivery passes are serialized. Each delivery advances the persisted cursor only
 *   after it succeeded. Incoming changes are offered to the human in a separate
 *   prompt queue, so an open prompt never holds back other deliveries.
 * - shutdown(): stop heartbeat and watcher, release presence if still ours.
 * - S18: the requester's human decides a change it sent when sending it (tools.ts) or
 *   later from /teams (decide), never through a prompt here. The decision is the
 *   recipient's accept / decline event, so the first answer wins (event files are
 *   created with link(2)) and the recipient's open prompt is withdrawn when a pass
 *   sees the request decided.
 * - S20: on bind, closed requests older than the configured age are removed
 *   (lib/prune.ts) and the count is reported.
 * - A6: on bind, the recipient withdraws its own undecided approvals a previous
 *   process left behind, so no requester shows a dialog nobody waits for.
 * - S15/S16: askApproval publishes an approval request for a tool call question
 *   mode would block, shows it here and (through its watcher) in the requester's
 *   session, and resolves with the first answer (lib/approvals.ts).
 */

import { execFile } from "node:child_process";
import {
	APPROVAL_CHOICES,
	approvalDialogTitle,
	choiceOf,
	createApproval,
	decideApproval,
	listPendingApprovals,
	readDecision,
	shortId,
	type ApprovalDecision,
	type ApprovalRecord,
} from "./approvals.ts";
import {
	ACCEPTED_ON_BEHALF,
	advanceCursor,
	chooseDeliverAs,
	DECLINED_ON_BEHALF,
	deliveryId,
	formatPeerMessage,
	listDeliverableRequests,
	oneLine,
	pendingDeliveries,
	readCursor,
	writeCursor,
	type Cursor,
	type Delivery,
	type PeerMessage,
} from "./delivery.ts";
import { DEFAULT_PRUNE_DAYS } from "./config.ts";
import { cleanupTemporary } from "./tmp-cleanup.ts";
import { isTerminal } from "./lifecycle.ts";
import { HEARTBEAT_INTERVAL_MS, openPresence, type PresenceState } from "./presence.ts";
import { ageText, countText, pruneCandidates, removeRequests } from "./prune.ts";
import type { ApprovalAnswer } from "./question-mode.ts";
import { NOT_BOUND_MESSAGE } from "./tools.ts";
import { formatTeamStatus, TEAM_STATUS_KEYS, type TeamSnapshot, type StatusTheme } from "./team-status.ts";
import { plainLine } from "./ui/text.ts";
import { watchTeam } from "./watcher.ts";
import { teamDir, TeamStoreError, type RequestRecord, type RequestView, type Store } from "./store.ts";

export type { PeerMessage } from "./delivery.ts";
export { ACCEPTED_ON_BEHALF, DECLINED_ON_BEHALF } from "./delivery.ts";

export const STATUS_KEY = "gentle-teams";
/** D1: a request must stay missing this long, across passes, before it leaves the cursor. */
export const MISSING_GRACE_MS = 60_000;
export const BIND_TITLE = "This repository is a member of a team. Bind this session to it?";
export const DO_NOT_BIND = "Do not bind";
export const CHANGE_CHOICES = ["Accept", "Decline", "Later"] as const;
export const IN_USE_SUFFIX = " (in use by another live session)";
const PROMPT_BODY_MAX = 2000;

export interface SendOptions {
	deliverAs: "steer" | "followUp";
	triggerTurn: true;
}

export interface SessionUi {
	/** Pi's ctx.ui.select; aborting `signal` withdraws the dialog (it resolves undefined). */
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	notify(message: string, level: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
}

export interface SessionPorts {
	store: Store;
	sessionId: string;
	onSnapshot?: (snapshot: TeamSnapshot | undefined) => void;
	isPanelActive?: () => boolean;
	statusTheme?: () => StatusTheme | undefined;
	pid?: number;
	now?: () => number;
	/** Pi's `sendMessage`. The session never sends user messages. */
	sendMessage(message: PeerMessage, options: SendOptions): void | Promise<void>;
	/** Check the current Pi session's persisted custom messages. */
	hasDelivery?(id: string): boolean;
	/** Undefined when the session has no interactive UI: nothing is bound then. */
	ui?: SessionUi;
	resolveGitRoot(cwd: string): Promise<string | undefined>;
	/** Start watching a team directory; defaults to watchTeam. */
	watch?: (dir: string, onChange: () => Promise<void>) => { stop(): Promise<void> | void };
	/** Run `fn` every `ms`; returns a cancel function. Defaults to setInterval. */
	every?: (ms: number, fn: () => Promise<void>) => () => void;
	/** S20: age in days after which closed requests are removed at bind; default 7. */
	pruneClosedAfterDays?: number;
}

export type StartOutcome =
	| { bound: true; team: string; alias: string }
	| {
			bound: false;
			reason: "no-git" | "no-membership" | "no-ui" | "declined" | "member-bound" | "claim-failed" | "already-bound" | "shut-down";
	  };

interface Binding {
	team: string;
	alias: string;
}

export type DecideOutcome =
	| { ok: true; state: "accepted" | "declined"; onBehalfOf?: string }
	| { ok: false; code: string; message: string };

export interface TeamSession {
	readonly binding: { team: string; alias: string } | undefined;
	start(cwd: string): Promise<StartOutcome>;
	/**
	 * Bind to a member the human chose in /teams (no bind prompt). Same effects as
	 * choosing it at session start. Throws the claim's store error (e.g. `member-bound`);
	 * returns `already-bound` while bound to another member (unbind first).
	 */
	bindTo(team: string, alias: string): Promise<StartOutcome>;
	/** Stop heartbeat and watcher and release presence. Returns false when not bound. */
	unbind(): Promise<boolean>;
	/**
	 * Decide a change request that is still `requested`, with the same effects as the
	 * S8 prompt. Addressed to the bound member: the event is appended as it and, on
	 * accept, the model is told. Sent by the bound member (S18): the event is appended
	 * as the recipient on its behalf (`onBehalfOf`), and the recipient's session tells
	 * its model. Never throws for store errors: they are returned with their code.
	 */
	decide(requestId: string, choice: "Accept" | "Decline"): Promise<DecideOutcome>;
	/**
	 * S20: remove these closed requests of `team` if they are still candidates
	 * (lib/prune.ts), dropping them from this member's cursor when bound there and from
	 * offline members' cursors. Returns the ids removed.
	 */
	pruneRequests(team: string, ids: readonly string[], options?: { days?: number; now?: () => number }): Promise<string[]>;
	/**
	 * S15: ask the humans whether a tool call blocked by question mode on `requestId`
	 * may run. Publishes an approval request, shows it in this session (when it has a
	 * UI) and in the requester's live session, and resolves with the first answer.
	 * `no-human` when neither session can show it; `withdrawn` when `signal` aborts,
	 * the binding ends, or (without a UI here) the requester's session goes offline.
	 */
	askApproval(input: { requestId: string; toolName: string; input: unknown; signal?: AbortSignal }): Promise<ApprovalAnswer>;
	/** Run (or queue) a delivery pass. */
	deliverNow(): Promise<void>;
	agentStart(): Promise<void>;
	agentEnd(): Promise<void>;
	shutdown(): Promise<void>;
}

/** `git rev-parse --show-toplevel` in `cwd`; undefined outside a Git worktree. */
export function gitRoot(cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 }, (error, stdout) => {
			const root = String(stdout ?? "").trim();
			resolve(error || root === "" ? undefined : root);
		});
	});
}

const defaultWatch = (dir: string, onChange: () => Promise<void>) =>
	watchTeam(dir, onChange, {
		// Heartbeats and cursors change constantly and never carry deliveries.
		filter: (path) => !path.startsWith("presence") && !path.startsWith("cursors"),
	});

const defaultEvery = (ms: number, fn: () => Promise<void>) => {
	const handle = setInterval(() => void fn(), ms);
	handle.unref?.();
	return () => clearInterval(handle);
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Waiter {
	approval: ApprovalRecord;
	current: Binding;
	done: boolean;
	resolve(answer: ApprovalAnswer): void;
}

const answerOf = (decision: ApprovalDecision): ApprovalAnswer => (decision.choice === "withdrawn" ? "withdrawn" : decision.choice);

export function createTeamSession(ports: SessionPorts): TeamSession {
	const { store, sessionId, ui } = ports;
	const presence = openPresence(store, { now: ports.now, pid: ports.pid });
	const now = ports.now ?? Date.now;
	const watch = ports.watch ?? defaultWatch;
	const every = ports.every ?? defaultEvery;

	let binding: Binding | undefined;
	/** Set by shutdown(); this session object never binds again. */
	let disposed = false;
	let busy = false;
	let stopWatcher: (() => void) | undefined;
	let stopHeartbeat: (() => void) | undefined;
	/** Changes the human postponed with "later": not offered again until the next bind. */
	const deferred = new Set<string>();
	/** Changes with an open or queued human prompt. */
	const prompting = new Set<string>();
	/** Unreadable requests already reported in this binding. */
	const reported = new Set<string>();
	/** Tail of the human prompt queue (one dialog at a time). */
	let prompts: Promise<void> = Promise.resolve();
	/** Open or queued change prompts (both sides), by request id: aborting withdraws them. */
	const changeDialogs = new Map<string, AbortController>();
	/** Open or queued approval dialogs (both sides), by approval id. */
	const approvalDialogs = new Map<string, { controller: AbortController; requestId: string; recipient: string; toolName: string }>();
	/** This session's tool calls waiting for an approval, by approval id. */
	const waiting = new Map<string, Waiter>();

	let chain: Promise<void> = Promise.resolve();
	let queued: Promise<void> | undefined;
	const sent = new Set<string>();
	const failures = new Map<string, { count: number; retryAt: number }>();

	async function inject(item: Delivery, onBehalf = false): Promise<void> {
		const id = deliveryId(item);
		if (sent.has(id) || ports.hasDelivery?.(id)) return;
		await ports.sendMessage(formatPeerMessage(item, onBehalf ? { acceptedOnBehalf: true } : {}), {
			deliverAs: chooseDeliverAs(item, busy), triggerTurn: true,
		});
		sent.add(id);
	}

	const statusCache = new Map<string, string | undefined>();
	const publish = (key: string, text: string | undefined) => {
		if (statusCache.get(key) === text) return;
		statusCache.set(key, text);
		ui?.setStatus(key, text);
	};
	const clearStatus = () => {
		for (const key of TEAM_STATUS_KEYS) ui?.setStatus(key, undefined);
		statusCache.clear();
	};
	const presenceState = (): PresenceState => (busy ? "active" : "idle");

	/** Unbind locally; open dialogs close and waiting tool calls are withdrawn. */
	function detach(): Promise<void> {
		stopHeartbeat?.();
		stopWatcher?.();
		stopHeartbeat = undefined;
		stopWatcher = undefined;
		binding = undefined;
		ports.onSnapshot?.(undefined);
		clearStatus();
		for (const controller of changeDialogs.values()) controller.abort();
		for (const { controller } of approvalDialogs.values()) controller.abort();
		return Promise.all([...waiting.values()].map((w) => withdraw(w, "withdrawn"))).then(() => undefined);
	}

	const live = (team: string, alias: string): Promise<boolean> =>
		presence.status(team, alias).then(
			(s) => s.online,
			() => false,
		);

	/** Resolve a waiting tool call once; its local dialog (if any) is withdrawn. */
	function finish(w: Waiter, answer: ApprovalAnswer): void {
		if (w.done) return;
		w.done = true;
		waiting.delete(w.approval.approvalId);
		approvalDialogs.get(w.approval.approvalId)?.controller.abort();
		w.resolve(answer);
	}

	/** Give up waiting: record `withdrawn` unless a human answered first (then that answer counts). */
	async function withdraw(w: Waiter, answer: ApprovalAnswer): Promise<void> {
		if (w.done) return;
		const { team, alias } = w.current;
		const result = await decideApproval(store, team, w.approval.requestId, w.approval.approvalId, { choice: "withdrawn", decidedBy: alias }, now).catch(
			() => undefined,
		);
		finish(w, result && !result.won ? answerOf(result.decision) : answer);
	}

	/** Resolve a waiting tool call from a stored decision. Returns true when decided. */
	async function settleFromStore(w: Waiter): Promise<boolean> {
		const decision = await readDecision(store, w.current.team, w.approval.requestId, w.approval.approvalId).catch(() => undefined);
		if (!decision) return false;
		finish(w, answerOf(decision));
		return true;
	}

	async function beat(): Promise<void> {
		const current = binding;
		if (!current) return;
		let ok: boolean;
		try {
			ok = await presence.heartbeat(current.team, current.alias, { sessionId, state: presenceState() });
		} catch {
			return; // Lock contention or a transient error: the next beat retries.
		}
		if (binding !== current) return;
		if (ok) {
			await deliverNow();
			return;
		}
		void detach();
		ui?.notify(`teams: member "${current.alias}" was taken over by another session; this session is no longer bound.`, "warning");
	}

	const promptTitle = (delivery: Delivery): string => {
		// Peer text stays on one line, cannot imitate framing, and cannot carry escape
		// sequences or other control characters (A5), as in the /teams screen.
		let preview = plainLine(oneLine(delivery.record.body));
		if (preview.length > PROMPT_BODY_MAX) preview = preview.slice(0, PROMPT_BODY_MAX) + " …(truncated)";
		return `Change request from "${delivery.peer}" in team "${delivery.team}": ${plainLine(oneLine(delivery.record.title))}${preview ? `\n\n${preview}` : ""}`;
	};

	/** Run `fn` in the same queue as delivery passes, so cursor writes never interleave. */
	function serialized<T>(fn: () => Promise<T>): Promise<T> {
		const next = chain.then(fn);
		chain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/**
	 * Append the human's decision as the recipient, then (on accept) tell the model and
	 * advance the cursor. Returns the store error when the transition is no longer
	 * allowed (e.g. the requester cancelled meanwhile); the next pass skips the request.
	 */
	async function applyDecision(
		delivery: Delivery,
		current: Binding,
		choice: "Accept" | "Decline",
	): Promise<TeamStoreError | undefined> {
		if (binding !== current) return undefined;
		const transition = choice === "Accept" ? "accept" : "decline";
		try {
			await store.appendEvent(current.team, delivery.requestId, {
				actor: current.alias,
				transition,
				summary: `${choice === "Accept" ? "Accepted" : "Declined"} by the human in the recipient session.`,
			});
		} catch (error) {
			if (error instanceof TeamStoreError && error.code === "transition-not-allowed") return error;
			throw error;
		}
		if (transition === "accept") {
			if (binding !== current) return undefined;
			await inject({ ...delivery, state: "accepted", needsDecision: false });
		}
		if (binding !== current) return undefined;
		const cursor = await readCursor(store, current.team, current.alias);
		await writeCursor(store, current.team, current.alias, advanceCursor(cursor, delivery.requestId, delivery.advanceTo));
		return undefined;
	}

	/**
	 * Ask the human about one incoming change. Prompts run one at a time in their own
	 * queue, outside the delivery passes, so an open prompt never holds back other
	 * deliveries. Only the decision's effects join the delivery queue.
	 */
	async function decide(delivery: Delivery, current: Binding, controller: AbortController): Promise<void> {
		try {
			if (binding !== current || controller.signal.aborted) return;
			if ((await store.readRequest(current.team, delivery.requestId)).state !== "requested") return;
			const choice = await ui!.select(promptTitle(delivery), [...CHANGE_CHOICES], { signal: controller.signal });
			if (binding !== current) return;
			if (controller.signal.aborted) {
				await notifyWithdrawn(current, delivery.requestId);
				return;
			}
			if (choice !== "Accept" && choice !== "Decline") {
				deferred.add(delivery.requestId);
				return;
			}
			const refused = await serialized(() => applyDecision(delivery, current, choice));
			if (refused) await notifyRefused(current, delivery.requestId, choice, refused);
		} catch (error) {
			if (binding === current) ui?.notify(`teams: delivery failed: ${message(error)}`, "error");
		} finally {
			prompting.delete(delivery.requestId);
			if (changeDialogs.get(delivery.requestId) === controller) changeDialogs.delete(delivery.requestId);
			// Refresh the status and deliver anything the decision unlocked.
			if (binding === current) await deliverNow();
		}
	}

	/** A prompt was withdrawn because the request changed elsewhere (another terminal). */
	async function notifyWithdrawn(current: Binding, requestId: string): Promise<void> {
		const state = await store.readRequest(current.team, requestId).then(
			(view) => view.state,
			() => "unknown",
		);
		if (binding === current) ui?.notify(`teams: request ${requestId} is now "${state}"; this prompt was withdrawn.`, "info");
	}

	/** The decision lost: another terminal decided first, or the request moved on. */
	async function notifyRefused(current: Binding, requestId: string, choice: "Accept" | "Decline", refused: TeamStoreError): Promise<void> {
		const state = await store.readRequest(current.team, requestId).then(
			(view) => view.state,
			() => undefined,
		);
		if (binding !== current) return;
		if (state === "accepted" || state === "declined") {
			ui?.notify(`teams: request ${requestId} was already decided in another terminal (state "${state}"); nothing changed.`, "info");
			return;
		}
		const verb = choice === "Accept" ? "accepted" : "declined";
		ui?.notify(`teams: request ${requestId} can no longer be ${verb}: ${refused.message}`, "warning");
	}

	/** Queue an approval dialog (either side); it is skipped if decided before it opens. */
	function openApprovalDialog(approval: ApprovalRecord, current: Binding): void {
		const controller = new AbortController();
		approvalDialogs.set(approval.approvalId, { controller, requestId: approval.requestId, recipient: approval.recipient, toolName: approval.toolName });
		prompts = prompts.then(() => approvalDialog(approval, current, controller));
	}

	async function approvalDialog(approval: ApprovalRecord, current: Binding, controller: AbortController): Promise<void> {
		const { approvalId, requestId } = approval;
		const where = `the approval for ${plainLine(approval.toolName)} on request ${shortId(requestId)}`;
		const settle = (decision: ApprovalDecision) => {
			const w = waiting.get(approvalId);
			if (w) finish(w, answerOf(decision));
		};
		try {
			if (binding !== current || controller.signal.aborted) return;
			const early = await readDecision(store, current.team, requestId, approvalId);
			if (early) {
				settle(early); // decided (or unreadable, i.e. deny) before the dialog opened
				return;
			}
			const label = await ui!.select(approvalDialogTitle(approval), [...APPROVAL_CHOICES], { signal: controller.signal });
			if (binding !== current) return;
			if (controller.signal.aborted) {
				const decision = await readDecision(store, current.team, requestId, approvalId).catch(() => undefined);
				if (decision?.choice === "withdrawn") {
					// A4: nobody answered; the waiting call in the recipient's session gave up.
					if (decision.decidedBy !== current.alias) ui?.notify(`teams: ${where} was withdrawn before anyone answered; this prompt was closed.`, "info");
				} else if (decision && decision.decidedBy !== current.alias) {
					ui?.notify(`teams: ${where} was answered in another terminal; this prompt was withdrawn.`, "info");
				}
				return;
			}
			const result = await decideApproval(store, current.team, requestId, approvalId, { choice: choiceOf(label), decidedBy: current.alias }, now);
			if (!result.won) {
				const text = result.decision.choice === "withdrawn" ? "was withdrawn before your answer" : "was already answered in another terminal";
				ui?.notify(`teams: ${where} ${text}; nothing changed.`, "info");
			}
			settle(result.decision);
		} catch (error) {
			if (binding === current) ui?.notify(`teams: approval failed: ${message(error)}`, "error");
		} finally {
			if (approvalDialogs.get(approvalId)?.controller === controller) approvalDialogs.delete(approvalId);
		}
	}

	/**
	 * After the deliveries of a pass: withdraw prompts decided elsewhere, settle this
	 * session's waiting tool calls, and offer the requester side its approvals. A change
	 * this member sent is never prompted here (S18): its human decided when sending it,
	 * and may still decide from /teams.
	 */
	async function crossTerminal(views: RequestView[], current: Binding): Promise<void> {
		const { team, alias } = current;
		for (const [requestId, controller] of changeDialogs) {
			const view = views.find((v) => v.record.id === requestId);
			if (!view || view.state !== "requested") controller.abort();
		}
		for (const [approvalId, entry] of approvalDialogs) {
			if (await readDecision(store, team, entry.requestId, approvalId).catch(() => undefined)) {
				entry.controller.abort();
				continue;
			}
			// A6: on the requester's side, a recipient whose presence went stale (crashed
			// or gone) has nobody waiting for the answer: withdraw it and close the dialog.
			if (entry.recipient === alias || (await live(team, entry.recipient))) continue;
			const result = await decideApproval(store, team, entry.requestId, approvalId, { choice: "withdrawn", decidedBy: alias }, now).catch(
				() => undefined,
			);
			entry.controller.abort();
			if (result?.won && binding === current) {
				const where = `the approval for ${plainLine(entry.toolName)} on request ${shortId(entry.requestId)}`;
				ui?.notify(`teams: ${where} was withdrawn before anyone answered; this prompt was closed.`, "info");
			}
		}
		for (const w of [...waiting.values()]) {
			if (w.current !== current || (await settleFromStore(w))) continue;
			// Without a UI here only the requester can answer; once it is gone nobody can (A4).
			if (!ui && !(await live(team, w.approval.requester))) await withdraw(w, "withdrawn");
		}
		if (!ui) return;
		for (const view of views) {
			if (binding !== current) return;
			const { record } = view;
			if (record.from !== alias || isTerminal(view.state)) continue;
			for (const approval of await listPendingApprovals(store, team, record.id).catch(() => [] as ApprovalRecord[])) {
				if (approvalDialogs.has(approval.approvalId)) continue;
				// An approval whose recipient is gone has nobody waiting for it.
				if (!(await live(team, approval.recipient))) continue;
				openApprovalDialog(approval, current);
			}
		}
	}

	/** D1: when each cursor id was first seen missing in this binding. */
	const missingSince = new Map<string, number>();

	/**
	 * Drop cursor entries of requests that no longer exist (removed by cleanup, S20).
	 * Cleanup hides a request for an instant and may restore it (an open dependent
	 * appeared), so an id leaves the cursor only after it stayed missing for
	 * MISSING_GRACE_MS across later passes; one that reappears keeps its entry.
	 * Dropping it too early would redeliver everything on it (S8 at most once).
	 */
	async function forgetRemoved(cursor: Cursor, known: ReadonlySet<string>, current: Binding): Promise<Cursor> {
		const gone: string[] = [];
		const at = now();
		for (const id of Object.keys(cursor.seen)) {
			if (known.has(id)) {
				missingSince.delete(id);
				continue;
			}
			const exists = await store.readRequest(current.team, id).then(
				() => true,
				(error: unknown) => !(error instanceof TeamStoreError && error.code === "unknown-request"),
			);
			if (exists) {
				missingSince.delete(id);
				continue;
			}
			const since = missingSince.get(id);
			if (since === undefined) missingSince.set(id, at);
			else if (at - since >= MISSING_GRACE_MS) gone.push(id);
		}
		if (gone.length === 0 || binding !== current) return cursor;
		const next: Cursor = { version: 1, seen: Object.fromEntries(Object.entries(cursor.seen).filter(([id]) => !gone.includes(id))) };
		await writeCursor(store, current.team, current.alias, next);
		for (const id of gone) missingSince.delete(id);
		return next;
	}

	/** A6: approvals for this member left undecided by a previous process: nobody waits for them. */
	async function withdrawStale(current: Binding): Promise<void> {
		const views = await listDeliverableRequests(store, current.team, () => undefined);
		for (const view of views) {
			if (view.record.to !== current.alias || binding !== current) continue;
			for (const approval of await listPendingApprovals(store, current.team, view.record.id).catch(() => [] as ApprovalRecord[])) {
				if (waiting.has(approval.approvalId)) continue;
				await decideApproval(store, current.team, view.record.id, approval.approvalId, { choice: "withdrawn", decidedBy: current.alias }, now).catch(
					() => undefined,
				);
			}
		}
	}

	const pruneDays = ports.pruneClosedAfterDays ?? DEFAULT_PRUNE_DAYS;

	/** Remove requests; this member's cursor is written only inside the delivery queue. */
	function prune(team: string, ids: readonly string[], days = pruneDays, at: () => number = now): Promise<string[]> {
		const current = binding;
		const own = current?.team === team ? current.alias : undefined;
		const run = () =>
			removeRequests(store, team, ids, {
				days,
				now: at,
				// Single writer per cursor (§3): only this session's own. Other members drop
				// removed ids themselves after the missing-id grace period.
				canWriteCursor: async (alias) => alias === own && binding === current,
			});
		return own ? serialized(run) : run();
	}

	/** S20: at bind, remove old closed requests and report how many. */
	async function autoPrune(current: Binding): Promise<void> {
		const candidates = await pruneCandidates(store, current.team, { days: pruneDays, now });
		if (candidates.length === 0 || binding !== current) return;
		const removed = await prune(
			current.team,
			candidates.map((v) => v.record.id),
		);
		if (removed.length > 0 && binding === current) ui?.notify(`teams: removed ${countText(removed.length)} ${ageText(pruneDays)}.`, "info");
	}

	async function pass(): Promise<void> {
		const current = binding;
		if (!current) return;
		const { team, alias } = current;
		let awaiting = 0;
		try {
			let cursor = await readCursor(store, team, alias);
			const unreadable: string[] = [];
			const views = await listDeliverableRequests(store, team, (id, error) => {
				unreadable.push(id);
				if (reported.has(id)) return;
				reported.add(id);
				ui?.notify(`teams: skipping unreadable request ${id}: ${error.message}`, "warning");
			});
			cursor = await forgetRemoved(cursor, new Set([...views.map((v) => v.record.id), ...unreadable]), current);
			const blocked = new Set<string>();
			for (const item of pendingDeliveries(views, cursor, alias)) {
				if (binding !== current) return;
				if (blocked.has(item.requestId)) continue;
				const failure = failures.get(item.requestId);
				if (failure && now() < failure.retryAt) { blocked.add(item.requestId); continue; }
				if (item.needsDecision) {
					// pendingDeliveries yields nothing else for an undecided change.
					awaiting++;
					if (ui && !deferred.has(item.requestId) && !prompting.has(item.requestId)) {
						prompting.add(item.requestId);
						const controller = new AbortController();
						changeDialogs.set(item.requestId, controller);
						prompts = prompts.then(() => decide(item, current, controller));
					}
					continue;
				}
				// S15: a change the human accepted from the requester's terminal says so.
				const onBehalf =
					item.kind === "incoming-change" &&
					(views
						.find((v) => v.record.id === item.requestId)
						?.events.some((e) => e.transition === "accept" && e.actor === alias && e.summary === ACCEPTED_ON_BEHALF) ??
						false);
				try {
					await inject(item, onBehalf);
					if (binding !== current) return;
					const next = advanceCursor(cursor, item.requestId, item.advanceTo);
					await writeCursor(store, team, alias, next);
					cursor = next;
					failures.delete(item.requestId);
				} catch (error) {
					const count = (failure?.count ?? 0) + 1;
					failures.set(item.requestId, { count, retryAt: now() + Math.min(60_000, 1000 * 2 ** Math.min(count - 1, 6)) });
					blocked.add(item.requestId);
					ui?.notify(`teams: delivery failed: ${message(error)}`, "error");
				}
			}
			if (binding !== current) return;
			await crossTerminal(views, current);
			const members = await Promise.all((await store.listMembers(team)).map(async (member) => {
				const state = await presence.status(team, member.alias).then((s) => s.online ? s.record.state : "offline" as const, () => "offline" as const);
				return { alias: member.alias, state };
			}));
			const partyViews = views.filter(({ record }) => record.from === alias || record.to === alias);
			let approvals = 0;
			for (const view of partyViews) {
				if (isTerminal(view.state)) continue;
				approvals += (await listPendingApprovals(store, team, view.record.id).catch(() => [] as ApprovalRecord[])).length;
			}
			if (binding !== current) return;
			const requests = partyViews.map(({ record, events, state }) => ({ title: record.title, state, direction: record.from === alias ? "sent" as const : "received" as const, lastActivity: events.at(-1)?.at ?? record.createdAt })).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).slice(0, 2);
			const snapshot: TeamSnapshot = { team, self: alias, members, pendingApprovals: awaiting + approvals, recentRequests: requests };
			ports.onSnapshot?.(snapshot);
			for (const [key, text] of formatTeamStatus({ ...snapshot, requests }, ports.statusTheme?.())) publish(key, ports.isPanelActive?.() ? undefined : text);
		} catch (error) {
			ui?.notify(`teams: delivery failed: ${message(error)}`, "error");
		}
	}

	function deliverNow(): Promise<void> {
		if (queued) return queued;
		const next = chain.then(() => {
			queued = undefined;
			return pass();
		});
		queued = next;
		chain = next.then(() => undefined, () => undefined);
		return next;
	}

	/** Install a claimed binding: heartbeat, watcher, status, first delivery pass. */
	async function attach(picked: Binding): Promise<StartOutcome> {
		const shutDown = { bound: false, reason: "shut-down" } as const;
		if (disposed) {
			await presence.release(picked.team, picked.alias, sessionId).catch(() => false);
			return shutDown;
		}
		binding = picked;
		deferred.clear();
		missingSince.clear();
		reported.clear();
		failures.clear();
		stopHeartbeat = every(HEARTBEAT_INTERVAL_MS, beat);
		const watcher = watch(teamDir(store.root, picked.team), deliverNow);
		stopWatcher = () => void watcher.stop();
		ui?.setStatus(STATUS_KEY, undefined);
		for (const cleanup of [() => serialized(() => withdrawStale(picked)), () => cleanupTemporary(store, picked.team, now), () => autoPrune(picked)]) {
			try { await cleanup(); }
			catch (error) {
				if (binding === picked) ui?.notify(`teams: cleanup failed: ${message(error)}`, "warning");
			}
		}
		await deliverNow();
		// Wait for the prompts this first pass opened, so the caller sees a settled bind.
		await prompts;
		if (binding !== picked) return shutDown;
		return { bound: true, team: picked.team, alias: picked.alias };
	}

	return {
		get binding() {
			return binding ? { ...binding } : undefined;
		},

		async start(cwd) {
			// shutdown() may run while any await below is pending (e.g. the bind prompt).
			const shutDown = { bound: false, reason: "shut-down" } as const;
			if (disposed) return shutDown;
			if (binding) return { bound: false, reason: "already-bound" };
			const root = await ports.resolveGitRoot(cwd).catch(() => undefined);
			if (disposed) return shutDown;
			if (!root) {
				ui?.notify("teams: not in a Git repository", "info");
				return { bound: false, reason: "no-git" };
			}
			const candidates: { team: string; alias: string }[] = [];
			for (const ws of await store.listTeams()) {
				for (const member of await store.listMembers(ws.name)) {
					if (member.repositoryRoot === root) candidates.push({ team: ws.name, alias: member.alias });
				}
			}
			if (disposed) return shutDown;
			if (candidates.length === 0) return { bound: false, reason: "no-membership" };
			if (!ui) return { bound: false, reason: "no-ui" };

			// S14: mark members another live session holds; they stay selectable (the claim
			// reports member-bound, or takes over if the holder went offline meanwhile).
			const labels: string[] = [];
			for (const c of candidates) {
				const held = await presence.status(c.team, c.alias).then((s) => s.online, () => false);
				labels.push(`${c.team} as ${c.alias}${held ? IN_USE_SUFFIX : ""}`);
			}
			if (disposed) return shutDown;
			const choice = await ui.select(BIND_TITLE, [...labels, DO_NOT_BIND]);
			if (disposed) return shutDown;
			const picked = choice === undefined ? undefined : candidates[labels.indexOf(choice)];
			if (!picked) return { bound: false, reason: "declined" };

			try {
				await presence.claim(picked.team, picked.alias, { sessionId, state: presenceState() });
			} catch (error) {
				if (disposed) return shutDown;
				ui.notify(message(error), "error");
				const bound = error instanceof TeamStoreError && error.code === "member-bound";
				return { bound: false, reason: bound ? "member-bound" : "claim-failed" };
			}
			return attach(picked);
		},

		async bindTo(team, alias) {
			if (disposed) return { bound: false, reason: "shut-down" };
			if (binding) {
				if (binding.team === team && binding.alias === alias) return { bound: true, team, alias };
				return { bound: false, reason: "already-bound" };
			}
			await presence.claim(team, alias, { sessionId, state: presenceState() });
			if (binding) {
				// Another bind won while claiming: keep it, drop this claim.
				await presence.release(team, alias, sessionId).catch(() => false);
				return { bound: false, reason: "already-bound" };
			}
			return attach({ team, alias });
		},

		async unbind() {
			const current = binding;
			if (!current) return false;
			await detach();
			await presence.release(current.team, current.alias, sessionId).catch(() => false);
			return true;
		},

		async decide(requestId, choice) {
			const current = binding;
			if (!current) return { ok: false, code: "not-bound", message: NOT_BOUND_MESSAGE };
			try {
				const { record, state } = await store.readRequest(current.team, requestId);
				const asRecipient = record.to === current.alias;
				const asRequester = record.from === current.alias;
				if (record.kind !== "change" || (!asRecipient && !asRequester) || state !== "requested") {
					return {
						ok: false,
						code: "not-decidable",
						message: `Request ${requestId} is not a change request awaiting this member's decision (state "${state}").`,
					};
				}
				if (asRequester) {
					// S18: the human in the requester's session decides on the recipient's behalf.
					const accept = choice === "Accept";
					try {
						await store.appendEvent(current.team, requestId, {
							actor: record.to,
							transition: accept ? "accept" : "decline",
							summary: accept ? ACCEPTED_ON_BEHALF : DECLINED_ON_BEHALF,
						});
					} catch (error) {
						if (error instanceof TeamStoreError) return { ok: false, code: error.code, message: error.message };
						throw error;
					}
					await deliverNow();
					return { ok: true, state: accept ? "accepted" : "declined", onBehalfOf: record.to };
				}
				const delivery: Delivery = {
					kind: "incoming-change",
					team: current.team,
					requestId,
					peer: record.from,
					record,
					state,
					advanceTo: 1,
					needsDecision: true,
					sentByMe: false,
				};
				const refused = await serialized(() => applyDecision(delivery, current, choice));
				if (refused) return { ok: false, code: refused.code, message: refused.message };
				if (binding !== current) return { ok: false, code: "not-bound", message: NOT_BOUND_MESSAGE };
				deferred.delete(requestId);
				await deliverNow();
				return { ok: true, state: choice === "Accept" ? "accepted" : "declined" };
			} catch (error) {
				if (error instanceof TeamStoreError) return { ok: false, code: error.code, message: error.message };
				throw error;
			}
		},

		pruneRequests: (team, ids, options = {}) => prune(team, ids, options.days, options.now),

		async askApproval({ requestId, toolName, input, signal }) {
			const current = binding;
			if (!current || disposed) return "no-human";
			let record: RequestRecord;
			try {
				({ record } = await store.readRequest(current.team, requestId));
			} catch {
				return "no-human";
			}
			if (record.to !== current.alias) return "no-human";
			if (!ui && !(await live(current.team, record.from))) return "no-human";
			if (signal?.aborted || binding !== current) return "withdrawn";
			const approval = await createApproval(store, current.team, { requestId, recipient: current.alias, toolName, input }, now);
			return new Promise<ApprovalAnswer>((resolve) => {
				const w: Waiter = { approval, current, done: false, resolve };
				waiting.set(approval.approvalId, w);
				if (binding !== current) {
					void withdraw(w, "withdrawn");
					return;
				}
				signal?.addEventListener("abort", () => void withdraw(w, "withdrawn"), { once: true });
				if (ui) openApprovalDialog(approval, current);
			});
		},

		deliverNow,

		async agentStart() {
			busy = true;
			await beat();
		},

		async agentEnd() {
			busy = false;
			await beat();
		},

		async shutdown() {
			disposed = true;
			const current = binding;
			if (!current) return;
			// Unbind first so a pass waiting on a human prompt stops without delivering.
			await detach();
			await presence.release(current.team, current.alias, sessionId).catch(() => false);
		},
	};
}
