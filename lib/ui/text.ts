/**
 * Minimal terminal-width helpers for the /teams screen (feature spec S13).
 *
 * `@earendil-works/pi-tui` is not a dependency of this package, so the screen keeps
 * its rendering pure and measures text itself: ANSI escape sequences have no width,
 * East Asian wide and emoji code points take two columns, combining marks take none.
 */

const ANSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const ANSI_GLOBAL = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const RESET = "\x1b[0m";

export const stripAnsi = (text: string): string => text.replace(ANSI_GLOBAL, "");

function charWidth(code: number): number {
	if (code === 0) return 0;
	// Combining marks and zero-width characters.
	if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

/** Visible terminal columns of `text`, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
	let width = 0;
	for (const char of stripAnsi(text)) width += charWidth(char.codePointAt(0)!);
	return width;
}

/**
 * Cut `text` to at most `width` visible columns, ending with `ellipsis` when cut.
 * ANSI sequences are kept; a reset is appended after a cut styled line so color never
 * leaks into the next line.
 */
export function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const tail = visibleWidth(ellipsis) <= width ? ellipsis : "";
	const room = width - visibleWidth(tail);
	let out = "";
	let used = 0;
	let styled = false;
	let index = 0;
	while (index < text.length) {
		ANSI.lastIndex = index;
		const escape = ANSI.exec(text);
		if (escape) {
			out += escape[0];
			styled = true;
			index += escape[0].length;
			continue;
		}
		const char = String.fromCodePoint(text.codePointAt(index)!);
		const w = charWidth(char.codePointAt(0)!);
		if (used + w > room) break;
		out += char;
		used += w;
		index += char.length;
	}
	return out + (styled ? RESET : "") + tail;
}

/** Pad `text` with spaces to `width` visible columns (never cuts). */
export function padEnd(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? text + " ".repeat(missing) : text;
}

/**
 * Text stored by other sessions (titles, summaries, descriptions) shown on one line:
 * control characters, including ESC, and line or paragraph separators become spaces,
 * so peer text can never style the terminal or start a new line; Unicode format
 * characters (\p{Cf}: bidi controls, zero-width characters, tags, ...) are removed,
 * so it cannot reorder or hide what is shown.
 */
export const plainLine = (text: string): string =>
	text.replace(/\p{Cf}/gu, "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
