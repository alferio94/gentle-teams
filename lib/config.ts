/**
 * Plugin configuration (feature spec S17, S20): `<root>/config.json`, default root
 * `~/.pi/multiagent`.
 *
 * ```json
 * { "readOnlyTools": ["mem_search", "mem_context", "mem_get_observation"], "pruneClosedAfterDays": 7 }
 * ```
 *
 * - `readOnlyTools` lists extra tools question mode allows without asking the human,
 *   compared by exact name; a list replaces the defaults. `bash`, `edit`, and `write`
 *   are never allowlisted: they are dropped with one warning (they can change files).
 * - `pruneClosedAfterDays` is the age after which closed requests are removed (S20),
 *   a positive whole number of days, default 7.
 *
 * A missing file or a missing key gives the defaults. An invalid file gives the
 * defaults plus one warning; an invalid key gives that key's default plus one
 * warning and keeps the other keys. The file is only read, never written.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultRoot, hasCode } from "./store.ts";

export const CONFIG_FILE = "config.json";
export const DEFAULT_PRUNE_DAYS = 7;
export const DEFAULT_READ_ONLY_TOOLS: readonly string[] = ["mem_search", "mem_context", "mem_get_observation"];
/** Tools that change files or run commands: never read-only, whatever the config says. */
export const NEVER_READ_ONLY: readonly string[] = ["bash", "edit", "write"];

export interface LoadedConfig {
	readOnlyTools: string[];
	pruneClosedAfterDays: number;
	/** Present only when the file or one of its keys cannot be used. */
	warnings?: string[];
}

const list = (names: readonly string[]): string =>
	names.length < 3 ? names.join(" or ") : `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;

export async function loadConfig(root: string = defaultRoot()): Promise<LoadedConfig> {
	const path = join(root, CONFIG_FILE);
	const defaults = (): LoadedConfig => ({ readOnlyTools: [...DEFAULT_READ_ONLY_TOOLS], pruneClosedAfterDays: DEFAULT_PRUNE_DAYS });
	const readOnlyWarning = (why: string) =>
		`teams: ignoring ${path}: ${why}; using the default read-only tools (${DEFAULT_READ_ONLY_TOOLS.join(", ")}).`;
	const invalid = (why: string): LoadedConfig => ({ ...defaults(), warnings: [readOnlyWarning(why)] });

	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (hasCode(error, "ENOENT", "ENOTDIR")) return defaults();
		return invalid(`it cannot be read (${(error as { code?: string }).code ?? "error"})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return invalid("it is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid("it must be a JSON object");

	const config = defaults();
	const warnings: string[] = [];
	const { readOnlyTools: tools, pruneClosedAfterDays: days } = parsed as { readOnlyTools?: unknown; pruneClosedAfterDays?: unknown };
	if (tools !== undefined) {
		if (!Array.isArray(tools) || tools.some((name) => typeof name !== "string" || name.length === 0)) {
			warnings.push(readOnlyWarning('"readOnlyTools" must be an array of tool names'));
		} else {
			const refused = NEVER_READ_ONLY.filter((name) => tools.includes(name));
			config.readOnlyTools = (tools as string[]).filter((name) => !NEVER_READ_ONLY.includes(name));
			if (refused.length > 0) {
				warnings.push(`teams: ${path}: "readOnlyTools" cannot list ${list(refused)}; question mode keeps asking the human before they run.`);
			}
		}
	}
	if (days !== undefined) {
		if (typeof days === "number" && Number.isSafeInteger(days) && days > 0) config.pruneClosedAfterDays = days;
		else warnings.push(`teams: ${path}: "pruneClosedAfterDays" must be a positive whole number of days; using ${DEFAULT_PRUNE_DAYS}.`);
	}
	return warnings.length > 0 ? { ...config, warnings } : config;
}
