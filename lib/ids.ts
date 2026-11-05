import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom = 0n;

function encode(value: bigint, length: number): string {
	let out = "";
	for (let i = 0; i < length; i++) {
		out = CROCKFORD[Number(value & 31n)] + out;
		value >>= 5n;
	}
	return out;
}

/**
 * Monotonic ULID: 48-bit millisecond time plus 80 random bits. IDs created in the
 * same millisecond by this process increment the random part, so they sort in
 * creation order.
 */
export function ulid(now: number = Date.now()): string {
	if (now <= lastTime) {
		lastRandom = (lastRandom + 1n) & ((1n << 80n) - 1n);
		now = lastTime;
	} else {
		lastTime = now;
		lastRandom = BigInt("0x" + randomBytes(10).toString("hex"));
	}
	return encode(BigInt(now), 10) + encode(lastRandom, 16);
}
