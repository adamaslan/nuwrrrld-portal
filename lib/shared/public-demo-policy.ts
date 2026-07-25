/**
 * Pure, dependency-free logic for the public council demo (lib/public-demo.ts).
 * Kept separate so it's unit-testable without pulling in `@/lib/db` (which
 * throws at import when DATABASE_URL is unset) — same rationale as
 * lib/shared/signal-policy.ts.
 */
import { createHash } from "node:crypto";

export const MAX_DEMO_PER_IP_PER_DAY = 1;

/** Deterministic, one-way IP hash — never store or log the raw address. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

/** Best-effort extraction of the caller's IP from standard proxy headers. */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}
