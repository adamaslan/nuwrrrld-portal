/**
 * Pure, dependency-free logic for the public council demo (lib/public-demo.ts).
 * Kept separate so it's unit-testable without pulling in `@/lib/db` (which
 * throws at import when DATABASE_URL is unset) — same rationale as
 * lib/shared/signal-policy.ts.
 */
import { createHmac } from "node:crypto";
import { ipAddress } from "@vercel/functions";

export const MAX_DEMO_PER_IP_PER_DAY = 1;

/**
 * Keyed (HMAC-SHA256) IP hash — never store or log the raw address. Plain
 * SHA-256 was reviewed and rejected: IPv4's address space (~4B) is small
 * enough to fully precompute a reversal table in minutes, so an unkeyed hash
 * is not meaningfully anonymized. `secret` must be a server-only value
 * (env `IP_HASH_SECRET`) — callers should treat a missing secret as "demo not
 * configured" rather than falling back to an unkeyed hash.
 */
export function hashIp(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(ip).digest("hex");
}

/**
 * Client IP from the platform-trusted source. `ipAddress()` (from
 * `@vercel/functions`) reads `x-real-ip`, which Vercel's edge proxy sets and
 * overwrites — a client cannot spoof it by sending its own header, unlike
 * `x-forwarded-for`, which passes through client-supplied values and would
 * let any caller rotate their apparent IP to bypass the daily quota entirely.
 * Returns "unknown" outside Vercel (e.g. local dev), where every caller
 * collapses to one quota bucket — acceptable since local dev never serves
 * real anonymous traffic.
 */
export function clientIpFromHeaders(headers: Headers): string {
  return ipAddress({ headers }) ?? "unknown";
}
