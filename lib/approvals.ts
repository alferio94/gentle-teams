/**
 * Approval requests (feature spec S15, S16; docs/architecture.md §3, §5.1).
 *
 * When question mode would block a tool call, the recipient session publishes an
 * approval request next to the peer request it is answering:
 *
 *   teams/<ws>/requests/<request-id>/approvals/<approval-id>/
 *     request.json    { approvalId, requestId, recipient, requester, toolName, summary, createdAt }
 *     decision.json   { choice, decidedBy, at }
 *
 * Both files are published like the store's own files: the approval directory is
 * built under a temporary name and renamed into place, and `decision.json` is created
 * with link(2), which fails if it exists. So the first answer wins atomically and a
 * decision is never overwritten.
 *
 * Only plugin UI paths call decideApproval (a dialog answered by the human), plus the
 * recipient's own tool call withdrawing an approval nobody can answer any more
 * (`withdrawn`, which never allows anything). No agent tool reads or writes approvals.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { oneLine } from "./delivery.ts";
import { ULID_PATTERN, ulid } from "./ids.ts";
import { fail, hasCode, json, publishDir, publishFile, readJson, teamDir, type Store } from "./store.ts";

export const APPROVAL_CHOICES = ["Allow once", "Allow for the rest of this request", "Deny"] as const;
export type ApprovalChoice = "allow-once" | "allow-request" | "deny";
/** `withdrawn`: the waiting tool call gave up (run aborted, unbound, no human left). */
export type StoredChoice = ApprovalChoice | "withdrawn";
const STORED_CHOICES: readonly string[] = ["allow-once", "allow-request", "deny", "withdrawn"];

/** At most this many visible characters of a tool input are shown (D5), as lines of SUMMARY_LINE. */
export const SUMMARY_MAX = 600;
export const SUMMARY_LINE = 100;
const TOOL_NAME_MAX = 64;

export interface ApprovalRecord {
	approvalId: string;
	requestId: string;
	/** The member whose session wants to run the tool (the request's recipient). */
	recipient: string;
	/** The member that sent the request. */
	requester: string;
	toolName: string;
	summary: string;
	createdAt: string;
}

export interface ApprovalDecision {
	choice: StoredChoice;
	/** Alias of the member whose session answered. */
	decidedBy: string;
	at: string;
}

/** Map a dialog answer to a choice. Dismissing the dialog denies the call. */
export function choiceOf(label: string | undefined): ApprovalChoice {
	if (label === APPROVAL_CHOICES[0]) return "allow-once";
	if (label === APPROVAL_CHOICES[1]) return "allow-request";
	return "deny";
}

export const shortId = (id: string): string => id.slice(-6);

// Unicode format characters (\p{Cf}: bidi controls, zero-width characters, U+061C,
// U+00AD, U+180E, U+2060-U+2064, tags U+E0000-U+E007F, ...) could hide or reorder what
// the human approves: removed. Line and paragraph separators and control characters
// (C0, DEL, C1) become spaces.
const INVISIBLE = /\p{Cf}/gu;
// eslint-disable-next-line no-control-regex
const BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** A run of the same character longer than 3 (D5): padding cannot push content out of sight. */
const RUN = /(.)\1{3,}/gsu;

export interface VisibleLineOptions {
	/** Collapse runs of the same character longer than 3 into `<char>×<count>`. */
	collapseRuns?: boolean;
}

/**
 * One visible line the human can trust (A1, D5): format characters removed, control
 * characters and separators as spaces, peer fences neutralized, whitespace runs
 * collapsed, and optionally runs of one character collapsed. Longer than `max`
 * characters, it keeps its head (60%) and its tail (30%) around ` … `, so the end of
 * a command stays visible.
 */
export function visibleLine(text: string, max: number, options: VisibleLineOptions = {}): string {
	let line = oneLine(String(text).replace(INVISIBLE, "").replace(BREAKING, " "))
		.replace(/\s+/g, " ")
		.trim();
	if (options.collapseRuns) line = line.replace(RUN, (run: string, char: string) => `${char}×${[...run].length}`);
	const chars = [...line];
	if (chars.length <= max) return line;
	const head = Math.ceil(max * 0.6);
	const tail = Math.floor(max * 0.3);
	return `${chars.slice(0, head).join("").trimEnd()} … ${chars.slice(-tail).join("").trimStart()}`;
}

const clean = (text: string, max: number): string => visibleLine(text, max, { collapseRuns: true });

/** Cut a line into pieces of at most `width` characters (code points). */
function wrap(line: string, width: number): string[] {
	const chars = [...line];
	const out: string[] = [];
	for (let i = 0; i < chars.length; i += width) out.push(chars.slice(i, i + width).join(""));
	return out.length > 0 ? out : [""];
}

/** One-line, neutralized, bounded summary of a tool input: bash command, edit/write path, else JSON. */
export function summarizeToolInput(toolName: string, input: unknown): string {
	const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	let text: string;
	if (toolName === "bash" && typeof fields.command === "string") text = fields.command;
	else if ((toolName === "edit" || toolName === "write") && typeof fields.path === "string") text = fields.path;
	else {
		try {
			text = JSON.stringify(input) ?? "";
		} catch {
			text = "";
		}
	}
	return clean(text, SUMMARY_MAX);
}

export function approvalTitle(approval: Pick<ApprovalRecord, "recipient" | "toolName" | "requestId">): string {
	return `${visibleLine(approval.recipient, TOOL_NAME_MAX)} wants to run ${visibleLine(approval.toolName, TOOL_NAME_MAX)} while answering request ${shortId(approval.requestId)}`;
}

/** The dialog title shown in both terminals: the title, then the summary wrapped on its own lines. */
export function approvalDialogTitle(approval: Pick<ApprovalRecord, "recipient" | "toolName" | "requestId" | "summary">): string {
	return [approvalTitle(approval), ...wrap(clean(approval.summary, SUMMARY_MAX), SUMMARY_LINE)].join("\n");
}

const approvalsDir = (store: Store, ws: string, requestId: string) => join(teamDir(store.root, ws), "requests", requestId, "approvals");

/** Publish an approval request for a call by the request's recipient. */
export async function createApproval(
	store: Store,
	ws: string,
	input: { requestId: string; recipient: string; toolName: string; input: unknown },
	now: () => number = Date.now,
): Promise<ApprovalRecord> {
	// readRequest validates the team name and the request id used in the path.
	const { record } = await store.readRequest(ws, input.requestId);
	if (record.to !== input.recipient) fail("not-a-party", `Member "${input.recipient}" is not the recipient of request ${record.id}.`);
	const approval: ApprovalRecord = {
		approvalId: ulid(),
		requestId: record.id,
		recipient: record.to,
		requester: record.from,
		toolName: String(input.toolName),
		summary: summarizeToolInput(String(input.toolName), input.input),
		createdAt: new Date(now()).toISOString(),
	};
	const dir = approvalsDir(store, ws, record.id);
	// Never recursive: a request removed meanwhile (S20) must not be recreated as an empty directory.
	try {
		await mkdir(dir, { mode: 0o700 });
	} catch (error) {
		if (hasCode(error, "ENOENT")) fail("unknown-request", `Request "${record.id}" does not exist in team "${ws}".`);
		if (!hasCode(error, "EEXIST")) throw error;
	}
	const created = await publishDir(dir, approval.approvalId, async (tmp) => {
		await writeFile(join(tmp, "request.json"), json(approval), { flag: "wx", mode: 0o600 });
	});
	if (!created) fail("store-busy", `Approval id ${approval.approvalId} collided; retry.`);
	return approval;
}

function approvalDir(store: Store, ws: string, requestId: string, approvalId: string): string {
	if (!ULID_PATTERN.test(requestId) || !ULID_PATTERN.test(approvalId)) {
		fail("unknown-approval", `Approval "${approvalId}" of request "${requestId}" does not exist in team "${ws}".`);
	}
	return join(approvalsDir(store, ws, requestId), approvalId);
}

/**
 * The decision, or undefined while undecided. A decision that cannot be read or used,
 * for any reason (invalid JSON, EACCES, EISDIR, ...), counts as deny (fail closed, A2).
 */
export async function readDecision(store: Store, ws: string, requestId: string, approvalId: string): Promise<ApprovalDecision | undefined> {
	const path = join(approvalDir(store, ws, requestId, approvalId), "decision.json");
	const deny: ApprovalDecision = { choice: "deny", decidedBy: "", at: "" };
	let stored: ApprovalDecision | undefined;
	try {
		stored = await readJson<ApprovalDecision>(path);
	} catch {
		return deny;
	}
	if (stored === undefined) return undefined;
	if (typeof stored !== "object" || stored === null || !STORED_CHOICES.includes(stored.choice)) return deny;
	return stored;
}

/** Record a decision unless one exists. `won` is false when another answer was first. */
export async function decideApproval(
	store: Store,
	ws: string,
	requestId: string,
	approvalId: string,
	input: { choice: StoredChoice; decidedBy: string },
	now: () => number = Date.now,
): Promise<{ won: boolean; decision: ApprovalDecision }> {
	const dir = approvalDir(store, ws, requestId, approvalId);
	if ((await readJson<ApprovalRecord>(join(dir, "request.json"))) === undefined) {
		fail("unknown-approval", `Approval "${approvalId}" of request "${requestId}" does not exist in team "${ws}".`);
	}
	const decision: ApprovalDecision = { choice: input.choice, decidedBy: input.decidedBy, at: new Date(now()).toISOString() };
	if (await publishFile(dir, "decision.json", json(decision))) return { won: true, decision };
	return { won: false, decision: (await readDecision(store, ws, requestId, approvalId))! };
}

/**
 * Undecided approvals of a request, oldest first. A record that does not match its
 * location or its request's parties is skipped.
 */
export async function listPendingApprovals(store: Store, ws: string, requestId: string): Promise<ApprovalRecord[]> {
	const { record } = await store.readRequest(ws, requestId);
	let names: string[];
	try {
		names = await readdir(approvalsDir(store, ws, record.id));
	} catch (error) {
		if (hasCode(error, "ENOENT")) return [];
		throw error;
	}
	const pending: ApprovalRecord[] = [];
	for (const id of names.filter((name) => ULID_PATTERN.test(name)).sort()) {
		const dir = join(approvalsDir(store, ws, record.id), id);
		let approval: ApprovalRecord | undefined;
		try {
			approval = await readJson<ApprovalRecord>(join(dir, "request.json"));
		} catch {
			continue;
		}
		if (!approval || approval.approvalId !== id || approval.requestId !== record.id) continue;
		if (approval.recipient !== record.to || approval.requester !== record.from) continue;
		if ((await readDecision(store, ws, record.id, id)) !== undefined) continue;
		pending.push(approval);
	}
	return pending;
}
