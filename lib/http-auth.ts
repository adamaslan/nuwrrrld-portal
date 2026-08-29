/**
 * Shared HTTP auth primitives for API route handlers and middleware.
 *
 * Every internal server-to-server route in this app authenticates a caller by
 * comparing an `Authorization: Bearer <secret>` header against an env var.
 * Until now each did that with a plain `===` / `!==` on the string, which is
 * timing-attack-observable: `a === b` for strings short-circuits at the first
 * differing byte, so an attacker measuring response latency can recover the
 * secret one byte at a time. These helpers move every such comparison to a
 * constant-time algorithm that always inspects the full input.
 *
 * Implemented in pure JS (no `node:crypto`) on purpose: middleware.ts imports
 * this and runs on the Edge runtime, where `node:crypto` is not available.
 *
 * Referenced by docs/todo-auth-cookies-tracking.md Phase 1.3.
 */

/**
 * Constant-time string equality.
 *
 * The loop runs for `max(len(a), len(b))` iterations regardless of where (or
 * whether) the strings diverge, XOR-accumulating every char-code difference
 * plus the length delta into one flag. Early exit, and any data-dependent
 * branch, would reintroduce the timing signal this exists to remove.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    // charCodeAt past the end returns NaN; `NaN | 0` is 0, so out-of-range
    // reads on the shorter string compare against 0 in constant time.
    const ca = a.charCodeAt(i) | 0;
    const cb = b.charCodeAt(i) | 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/**
 * True iff `header` is exactly `Bearer <secret>` under a constant-time compare.
 * `secret` being empty/undefined always returns false — an unset secret must
 * never authenticate anyone.
 */
export function bearerTokenMatches(
  header: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!secret) return false;
  if (!header) return false;
  return timingSafeEqualStr(header, `Bearer ${secret}`);
}
