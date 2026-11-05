/**
 * Filesystem store for teams, members, requests, and request events.
 * Layout and write rules: docs/architecture.md §3.
 *
 * Every published file or directory is built under a `.tmp-*` name and then
 * moved into place, so readers never observe partial content:
 * - files are published with link(2), which fails if the target exists;
 * - directories are published with rename(2), which fails onto a non-empty target.
 */

import { createHash, randomBytes } from "node:crypto";
import { withLock } from "./lock.ts";
import { link, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ULID_PATTERN, ulid } from "./ids.ts";
import {
	deriveState,
	isTerminal,
	LifecycleError,
	nextState,
	REQUEST_KINDS,
	TRANSITIONS,
	type RequestKind,
	type RequestState,
	type Role,
	type Transition,
} from "./lifecycle.ts";

export const BODY_LIMIT_BYTES = 8192;
const TITLE_MAX = 120;
const EVIDENCE_MAX_ITEMS = 20;
const EVIDENCE_MAX_CHARS = 512;
const APPEND_ATTEMPTS = 200;

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const EVENT_FILE = /^(\d{6})\.json$/;

export type StoreErrorCode =
	| "invalid-name"
	| "team-name-taken"
	| "unknown-team"
	| "invalid-alias"
	| "invalid-repository-root"
	| "alias-taken"
	| "repository-already-member"
	| "unknown-member"
	| "open-requests"
	| "invalid-kind"
	| "invalid-title"
	| "invalid-body"
	| "body-too-large"
	| "self-request"
	| "unknown-dependency"
	| "unknown-request"
	| "not-a-party"
	| "invalid-evidence"
	| "transition-not-allowed"
	| "store-busy"
	| "corrupted-store"
	| "member-bound"
	| "unknown-approval";

export class TeamStoreError extends Error {
	override readonly name = "TeamStoreError";
	readonly code: StoreErrorCode;
	constructor(code: StoreErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export interface Team {
	name: string;
	description: string;
	createdAt: string;
}

export interface Member {
	alias: string;
	repositoryRoot: string;
	joinedAt: string;
}

export interface RequestRecord {
	id: string;
	team: string;
	from: string;
	to: string;
	kind: RequestKind;
	title: string;
	body: string;
	dependsOn: string[];
	createdAt: string;
}

export interface RequestEvent {
	seq: number;
	actor: string;
	role: Role;
	transition: Transition;
	summary?: string;
	evidence?: string[];
	at: string;
}

export interface RequestView {
	record: RequestRecord;
	events: RequestEvent[];
	state: RequestState;
}

export interface NewRequest {
	from: string;
	to: string;
	kind: RequestKind;
	title: string;
	body: string;
	dependsOn?: string[];
}

export interface NewEvent {
	actor: string;
	transition: Transition;
	summary?: string;
	evidence?: string[];
}

export interface Store {
	readonly root: string;
	createTeam(input: { name: string; description?: string }): Promise<Team>;
	listTeams(): Promise<Team[]>;
	getTeam(name: string): Promise<Team>;
	joinMember(team: string, input: { alias: string; repositoryRoot: string }): Promise<{ member: Member; resumed: boolean }>;
	listMembers(team: string): Promise<Member[]>;
	leaveMember(team: string, alias: string): Promise<void>;
	createRequest(team: string, input: NewRequest): Promise<RequestRecord>;
	readRequest(team: string, id: string): Promise<RequestView>;
	listRequests(team: string): Promise<RequestView[]>;
	appendEvent(team: string, id: string, input: NewEvent): Promise<{ event: RequestEvent; state: RequestState }>;
}

export function defaultRoot(): string {
	return join(homedir(), ".pi", "multiagent");
}

/**
 * Directory of a team under a store root. The name must already be validated
 * (for example with getTeam); this only builds the path. Used by presence and
 * delivery cursors, which live next to the store's own files (§3).
 */
export function teamDir(root: string, team: string): string {
	return join(root, "teams", team);
}

export const fail = (code: StoreErrorCode, message: string): never => {
	throw new TeamStoreError(code, message);
};

export const hasCode = (error: unknown, ...codes: string[]): boolean =>
	typeof error === "object" && error !== null && codes.includes((error as { code?: string }).code ?? "");

export const tmpName = (): string => `.tmp-${randomBytes(8).toString("hex")}`;
export const hiddenName = (): string => `.hidden-${randomBytes(8).toString("hex")}`;
export const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const visible = (names: string[]): string[] => names.filter((name) => !name.startsWith(".")).sort();

export async function mkdirPrivate(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Publish a file without ever overwriting. Returns false when the name is taken. */
export async function publishFile(dir: string, name: string, content: string): Promise<boolean> {
	const tmp = join(dir, tmpName());
	await writeFile(tmp, content, { flag: "wx", mode: 0o600 });
	try {
		await link(tmp, join(dir, name));
		return true;
	} catch (error) {
		if (hasCode(error, "EEXIST")) return false;
		throw error;
	} finally {
		await unlink(tmp).catch(() => undefined);
	}
}

/**
 * Atomically replace a file this process alone owns (its presence heartbeat or its
 * delivery cursor): write a temporary file, then rename(2) it over the target.
 * Never use it for files other writers may create; use publishFile for those.
 */
export async function replaceFile(dir: string, name: string, content: string): Promise<void> {
	const tmp = join(dir, tmpName());
	await writeFile(tmp, content, { flag: "wx", mode: 0o600 });
	try {
		await rename(tmp, join(dir, name));
	} catch (error) {
		await unlink(tmp).catch(() => undefined);
		throw error;
	}
}

/** Build a directory under a temporary name, then rename it into place. Returns false when the name is taken. */
export async function publishDir(parent: string, name: string, build: (dir: string) => Promise<void>): Promise<boolean> {
	const tmp = join(parent, tmpName());
	await mkdir(tmp, { mode: 0o700 });
	try {
		await build(tmp);
		await rename(tmp, join(parent, name));
		return true;
	} catch (error) {
		if (hasCode(error, "EEXIST", "ENOTEMPTY", "ENOTDIR")) return false;
		throw error;
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

export async function readJson<T>(path: string): Promise<T | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (hasCode(error, "ENOENT", "ENOTDIR")) return undefined;
		throw error;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		return fail("corrupted-store", `Stored file ${path} is not valid JSON.`);
	}
}

async function listDir(dir: string): Promise<string[]> {
	try {
		return visible(await readdir(dir));
	} catch (error) {
		if (hasCode(error, "ENOENT")) return [];
		throw error;
	}
}

export function openStore(root: string = defaultRoot(), options: { afterRequestPublished?: () => Promise<void> } = {}): Store {
	const teamsDir = join(root, "teams");
	const wsDir = (name: string) => join(teamsDir, name);
	const membersDir = (ws: string) => join(wsDir(ws), "members");
	const requestsDir = (ws: string) => join(wsDir(ws), "requests");
	const requestDir = (ws: string, id: string) => join(requestsDir(ws), id);
	const eventsDir = (ws: string, id: string) => join(requestDir(ws, id), "events");
	const claimName = (root: string) => `.claim-${createHash("sha256").update(root).digest("hex")}`;
	const membersLock = <T>(ws: string, fn: () => Promise<T>): Promise<T> => withLock(wsDir(ws), ".lock-members", fn, {
		waitMs: 30_000, onTimeout: () => fail("store-busy", `Team "${ws}" membership is busy; retry.`),
	});

	async function getTeam(name: string): Promise<Team> {
		const found = NAME_PATTERN.test(name) ? await readJson<Team>(join(wsDir(name), "team.json")) : undefined;
		return found ?? fail("unknown-team", `Team "${name}" does not exist.`);
	}

	async function listMembers(ws: string): Promise<Member[]> {
		await getTeam(ws);
		const members: Member[] = [];
		for (const file of await listDir(membersDir(ws))) {
			const member = await readJson<Member>(join(membersDir(ws), file));
			if (member) members.push(member);
		}
		return members.sort((a, b) => a.alias.localeCompare(b.alias));
	}

	async function getMember(ws: string, alias: string): Promise<Member> {
		const found = ALIAS_PATTERN.test(alias) ? await readJson<Member>(join(membersDir(ws), `${alias}.json`)) : undefined;
		return found ?? fail("unknown-member", `Member "${alias}" is not part of team "${ws}".`);
	}

	/**
	 * A published request always has an `events/` directory and its event files are
	 * never deleted, so a directory or file that vanishes while reading means the whole
	 * request was moved away (removed by cleanup, S20, or withdrawn by createRequest):
	 * it is reported as `unknown-request`, never as a partial or corrupt request.
	 */
	async function readEvents(ws: string, record: RequestRecord): Promise<RequestEvent[]> {
		const dir = eventsDir(ws, record.id);
		const vanished = () => fail("unknown-request", `Request "${record.id}" does not exist in team "${ws}".`);
		let names: string[];
		try {
			names = visible(await readdir(dir));
		} catch (error) {
			if (hasCode(error, "ENOENT", "ENOTDIR")) return vanished();
			throw error;
		}
		const files = names.filter((file) => EVENT_FILE.test(file));
		const events: RequestEvent[] = [];
		for (const [index, file] of files.entries()) {
			const seq = Number(EVENT_FILE.exec(file)![1]);
			const event = await readJson<RequestEvent>(join(dir, file));
			if (event === undefined) return vanished();
			if (seq !== index || event.seq !== seq) {
				fail("corrupted-store", `Request ${record.id} has a gap or mismatch in its event sequence at ${index}.`);
			}
			events.push(event);
		}
		return events;
	}

	function replay(record: RequestRecord, events: RequestEvent[]): RequestState {
		try {
			return deriveState(record.kind, events);
		} catch (error) {
			if (error instanceof LifecycleError) fail("corrupted-store", `Request ${record.id} has an invalid history: ${error.message}`);
			throw error;
		}
	}

	async function readRequest(ws: string, id: string): Promise<RequestView> {
		await getTeam(ws);
		const record = ULID_PATTERN.test(id) ? await readJson<RequestRecord>(join(requestDir(ws, id), "request.json")) : undefined;
		if (!record) return fail("unknown-request", `Request "${id}" does not exist in team "${ws}".`);
		// Paths are always built from the validated argument; a stored record that
		// disagrees with its location must never redirect them.
		if (record.id !== id || record.team !== ws) fail("corrupted-store", `Stored request ${id} does not match its location.`);
		const events = await readEvents(ws, record);
		return { record, events, state: replay(record, events) };
	}

	async function listRequests(ws: string): Promise<RequestView[]> {
		await getTeam(ws);
		const views: RequestView[] = [];
		for (const id of await listDir(requestsDir(ws))) {
			if (!ULID_PATTERN.test(id)) continue;
			try {
				views.push(await readRequest(ws, id));
			} catch (error) {
				// A request withdrawn by createRequest's rollback can vanish after readdir.
				if (error instanceof TeamStoreError && error.code === "unknown-request") continue;
				throw error;
			}
		}
		return views;
	}

	return {
		root,

		async createTeam({ name, description = "" }) {
			if (!NAME_PATTERN.test(name)) {
				fail("invalid-name", `Team name "${name}" is invalid: use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit.`);
			}
			const team: Team = { name, description, createdAt: new Date().toISOString() };
			await mkdirPrivate(teamsDir);
			const created = await publishDir(teamsDir, name, async (dir) => {
				await writeFile(join(dir, "team.json"), json(team), { flag: "wx", mode: 0o600 });
				await mkdir(join(dir, "members"), { mode: 0o700 });
				await mkdir(join(dir, "requests"), { mode: 0o700 });
			});
			if (!created) fail("team-name-taken", `A team named "${name}" already exists.`);
			return team;
		},

		async listTeams() {
			const teams: Team[] = [];
			for (const name of await listDir(teamsDir)) {
				const team = NAME_PATTERN.test(name) ? await readJson<Team>(join(wsDir(name), "team.json")) : undefined;
				if (team) teams.push(team);
			}
			return teams;
		},

		getTeam,
		listMembers,

		async joinMember(ws, { alias, repositoryRoot }) {
			if (!ALIAS_PATTERN.test(alias)) {
				fail("invalid-alias", `Alias "${alias}" is invalid: use 1-32 lowercase letters, digits, or hyphens, starting with a letter or digit.`);
			}
			if (!isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot) {
				fail("invalid-repository-root", `Repository root "${repositoryRoot}" must be an absolute, normalized path.`);
			}
			await getTeam(ws);
			return membersLock(ws, async () => {
			const members = await listMembers(ws);
			const existing = members.find((m) => m.alias === alias);
			if (existing) {
				if (existing.repositoryRoot === repositoryRoot) return { member: existing, resumed: true };
				fail("alias-taken", `Alias "${alias}" already belongs to ${existing.repositoryRoot} in team "${ws}".`);
			}
			const sameRepo = members.find((m) => m.repositoryRoot === repositoryRoot);
			if (sameRepo) {
				fail("repository-already-member", `Repository ${repositoryRoot} is already member "${sameRepo.alias}" of team "${ws}".`);
			}
			const member: Member = { alias, repositoryRoot, joinedAt: new Date().toISOString() };
			const claim = claimName(repositoryRoot);
			// Under the membership lock, a claim with no matching member is a crashed join.
			if (!(await publishFile(wsDir(ws), claim, json(member)))) {
				await unlink(join(wsDir(ws), claim));
				if (!(await publishFile(wsDir(ws), claim, json(member)))) fail("store-busy", "Repository claim is busy; retry.");
			}
			try {
				if (await publishFile(membersDir(ws), `${alias}.json`, json(member))) return { member, resumed: false };
				const winner = await getMember(ws, alias);
				if (winner.repositoryRoot === repositoryRoot) return { member: winner, resumed: true };
				return fail("alias-taken", `Alias "${alias}" already belongs to ${winner.repositoryRoot} in team "${ws}".`);
			} finally {
				const published = await readJson<Member>(join(membersDir(ws), `${alias}.json`));
				if (!published || published.joinedAt !== member.joinedAt || published.repositoryRoot !== repositoryRoot) await unlink(join(wsDir(ws), claim)).catch(() => undefined);
			}
			});
		},

		async leaveMember(ws, alias) {
			await getTeam(ws);
			const unknown = () => fail("unknown-member", `Member "${alias}" is not part of team "${ws}".`);
			if (!ALIAS_PATTERN.test(alias)) unknown();
			return membersLock(ws, async () => {
			const live = join(membersDir(ws), `${alias}.json`);
			const hidden = join(membersDir(ws), hiddenName());

			// Hide the member before checking for open requests. A concurrent createRequest
			// re-checks both members after publishing and rolls back if either is hidden,
			// so a leave and a new request to the leaving member never both succeed.
			try {
				await rename(live, hidden);
			} catch (error) {
				if (hasCode(error, "ENOENT")) unknown();
				throw error;
			}
			const restore = async () => {
				// link(2) never overwrites a member that joined with this alias meanwhile.
				await link(hidden, live).catch(() => undefined);
				await unlink(hidden).catch(() => undefined);
			};

			let open: RequestView[];
			try {
				open = (await listRequests(ws)).filter(
					(view) => (view.record.from === alias || view.record.to === alias) && !isTerminal(view.state),
				);
			} catch (error) {
				await restore();
				throw error;
			}
			if (open.length > 0) {
				await restore();
				fail(
					"open-requests",
					`Member "${alias}" has ${open.length} open request${open.length === 1 ? "" : "s"} (${open.map((v) => v.record.id).join(", ")}); resolve or cancel them before leaving.`,
				);
			}
			const member = await readJson<Member>(hidden);
			await unlink(hidden);
			// Membership is already removed; a stale claim is recovered by join under the lock.
			if (member) await unlink(join(wsDir(ws), claimName(member.repositoryRoot))).catch(() => undefined);
			});
		},

		async createRequest(ws, input) {
			await getTeam(ws);
			if (!(REQUEST_KINDS as readonly string[]).includes(input.kind)) {
				fail("invalid-kind", `Request kind "${input.kind}" is invalid: use "question" or "change".`);
			}
			if (typeof input.title !== "string" || input.title.trim().length === 0 || input.title.length > TITLE_MAX) {
				fail("invalid-title", `Request title must be 1-${TITLE_MAX} characters.`);
			}
			if (input.body !== undefined && typeof input.body !== "string") fail("invalid-body", "Request body must be a string.");
			const bodyBytes = Buffer.byteLength(input.body ?? "", "utf8");
			if (bodyBytes > BODY_LIMIT_BYTES) {
				fail("body-too-large", `Request body is ${bodyBytes} bytes; the limit is ${BODY_LIMIT_BYTES} bytes.`);
			}
			await getMember(ws, input.from);
			await getMember(ws, input.to);
			if (input.from === input.to) fail("self-request", "A member cannot send a request to itself.");

			// dependsOn may only reference existing requests and is never rewritten,
			// so the dependency graph cannot contain a cycle (feature spec S6).
			const dependsOn = [...new Set(input.dependsOn ?? [])];
			// History cleanup (S20) hides a request for an instant while it checks for open
			// dependents and may then restore it, so a missing dependency is re-read once
			// after a short wait before it counts as unknown (S27c).
			const dependencyExists = async (dep: string): Promise<boolean> => {
				if (!ULID_PATTERN.test(dep)) return false;
				const read = async () => (await readJson(join(requestDir(ws, dep), "request.json"))) !== undefined;
				if (await read()) return true;
				await new Promise((resolve) => setTimeout(resolve, 50));
				return read();
			};
			for (const dep of dependsOn) {
				if (!(await dependencyExists(dep))) fail("unknown-dependency", `Dependency "${dep}" is not a request in team "${ws}".`);
			}

			const record: RequestRecord = {
				id: ulid(),
				team: ws,
				from: input.from,
				to: input.to,
				kind: input.kind,
				title: input.title,
				body: input.body ?? "",
				dependsOn,
				createdAt: new Date().toISOString(),
			};
			const created = await publishDir(requestsDir(ws), record.id, async (dir) => {
				await writeFile(join(dir, "request.json"), json(record), { flag: "wx", mode: 0o600 });
				await mkdir(join(dir, "events"), { mode: 0o700 });
			});
			if (!created) fail("store-busy", `Request id ${record.id} collided; retry the request.`);
			await options.afterRequestPublished?.();

			const withdraw = async () => {
				// Move out of sight atomically first, then delete.
				const trash = join(requestsDir(ws), hiddenName());
				await rename(requestDir(ws, record.id), trash);
				await rm(trash, { recursive: true, force: true });
			};
			// Re-check both parties after publishing: if either left meanwhile, withdraw
			// the request so it never stays open for a non-member (see leaveMember).
			for (const alias of [record.from, record.to]) {
				if ((await readJson(join(membersDir(ws), `${alias}.json`))) === undefined) {
					await withdraw();
					fail("unknown-member", `Member "${alias}" is not part of team "${ws}".`);
				}
			}
			// Re-check dependencies after publishing too: history cleanup (S20) hides a
			// request before checking for open dependents, so a new open request and the
			// removal of one of its dependencies never both succeed (lib/prune.ts).
			for (const dep of dependsOn) {
				if (!(await dependencyExists(dep))) {
					await withdraw();
					fail("unknown-dependency", `Dependency "${dep}" is not a request in team "${ws}".`);
				}
			}
			return record;
		},

		readRequest,
		listRequests,

		async appendEvent(ws, id, input) {
			const { record } = await readRequest(ws, id);
			if (!(TRANSITIONS as readonly string[]).includes(input.transition)) {
				fail("transition-not-allowed", `Unknown transition "${input.transition}".`);
			}
			const role: Role | undefined =
				input.actor === record.from ? "requester" : input.actor === record.to ? "recipient" : undefined;
			if (!role) return fail("not-a-party", `Member "${input.actor}" is not a party to request ${record.id}.`);
			if (input.summary !== undefined) {
				const bytes = Buffer.byteLength(input.summary, "utf8");
				if (bytes > BODY_LIMIT_BYTES) fail("body-too-large", `Event summary is ${bytes} bytes; the limit is ${BODY_LIMIT_BYTES} bytes.`);
			}
			if (
				input.evidence !== undefined &&
				(!Array.isArray(input.evidence) ||
					input.evidence.length > EVIDENCE_MAX_ITEMS ||
					input.evidence.some((item) => typeof item !== "string" || item.length > EVIDENCE_MAX_CHARS))
			) {
				fail("invalid-evidence", `Evidence must be at most ${EVIDENCE_MAX_ITEMS} strings of at most ${EVIDENCE_MAX_CHARS} characters.`);
			}

			for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
				const events = await readEvents(ws, record);
				const result = nextState(record.kind, replay(record, events), input.transition, role);
				if (!result.ok) return fail(result.code, result.message);
				const event: RequestEvent = {
					seq: events.length,
					actor: input.actor,
					role,
					transition: input.transition,
					...(input.summary !== undefined ? { summary: input.summary } : {}),
					...(input.evidence !== undefined ? { evidence: [...input.evidence] } : {}),
					at: new Date().toISOString(),
				};
				const name = `${String(event.seq).padStart(6, "0")}.json`;
				if (await publishFile(eventsDir(ws, record.id), name, json(event))) return { event, state: result.state };
				// Another writer took this sequence number: re-read and re-validate.
			}
			return fail("store-busy", `Request ${record.id} is under heavy concurrent writes; retry.`);
		},
	};
}
