/**
 * se1/external — track I (external agents and developer surface) decision logic. Pure; no I/O.
 * Every function here is a gate that fails closed. None of it is wired to a route: activating any of
 * I2–I9 touches auth or entitlements and needs Adam's approval (T6) first.
 */
import { isScanId } from "../se1-catalog";
import { isId } from "./util";

// ── I2 ────────────────────────────────────────────────────────────────────────

export interface ToolCaller { id: string; entitled: boolean; tier: "free" | "pro" }
export interface ToolSpec { name: string; tier: "free" | "pro"; params: Readonly<Record<string, "string" | "number" | "boolean">>; required: readonly string[] }

export type ToolGate =
  | { allow: true }
  | { allow: false; code: "unauthenticated" | "not_entitled" | "unknown_tool" | "schema_error" | "rate_limited"; detail?: string };

/** I2: unauthenticated, non-entitled, unknown-tool, bad-argument and over-limit calls are denied with a code. */
export function toolCallGate(
  caller: ToolCaller | null, toolName: string, args: Readonly<Record<string, unknown>>,
  tools: readonly ToolSpec[], usedThisWindow: number, limit: number,
): ToolGate {
  if (!caller || !isId(caller.id)) return { allow: false, code: "unauthenticated" };
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) return { allow: false, code: "unknown_tool" };
  if (!caller.entitled || (tool.tier === "pro" && caller.tier !== "pro")) return { allow: false, code: "not_entitled" };
  for (const k of Object.keys(args)) {
    const want = tool.params[k];
    if (!want) return { allow: false, code: "schema_error", detail: `unknown argument ${k}` };
    if (typeof args[k] !== want) return { allow: false, code: "schema_error", detail: `${k} must be ${want}` };
  }
  const absent = tool.required.filter((k) => args[k] === undefined);
  if (absent.length) return { allow: false, code: "schema_error", detail: `missing ${absent.join(", ")}` };
  if (!Number.isFinite(usedThisWindow) || !Number.isFinite(limit) || usedThisWindow >= limit) return { allow: false, code: "rate_limited" };
  return { allow: true };
}

// ── I3 ────────────────────────────────────────────────────────────────────────

export interface ApiKey { id: string; owner: string; revoked: boolean; scopes: readonly "read"[] }

/** I3: keys are read-only and per user. Revoked keys, other users' resources and non-GET methods are denied. */
export function authorizeKey(key: ApiKey | null, req: { method: string; resource_owner: string }):
  { allow: true } | { allow: false; code: "no_key" | "revoked" | "cross_user" | "read_only" } {
  if (!key) return { allow: false, code: "no_key" };
  if (key.revoked) return { allow: false, code: "revoked" };
  if (key.owner !== req.resource_owner) return { allow: false, code: "cross_user" };
  if (!["GET", "HEAD"].includes(req.method.toUpperCase()) || !key.scopes.includes("read")) return { allow: false, code: "read_only" };
  return { allow: true };
}

// ── I4 ────────────────────────────────────────────────────────────────────────

export interface Capability { name: string; enabled: boolean; endpoint_version: string | null }

/** I4: the connector page lists only enabled capabilities with a published endpoint version. */
export function connectorPageModel(capabilities: readonly Capability[]) {
  const listed = capabilities.filter((c) => c.enabled && !!c.endpoint_version)
    .map((c) => ({ name: c.name, version: c.endpoint_version as string }));
  return { listed, empty_message: listed.length ? null : "No connector capabilities are available yet." };
}

// ── I5 ────────────────────────────────────────────────────────────────────────

export interface Recipe { id: string; scans: readonly string[]; includes?: readonly string[] }

/** I5: validation only. Unknown scans, cycles and over-budget recipes fail. Nothing here runs a recipe. */
export function validateRecipe(recipe: Recipe, knownScans: ReadonlySet<string>, savedRecipes: readonly Recipe[], maxScans = 25):
  { ok: true; scanCount: number } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isId(recipe.id, 64)) errors.push("invalid recipe id");
  const byId = new Map(savedRecipes.map((r) => [r.id, r]));
  byId.set(recipe.id, recipe);
  const all = new Set<string>();
  const visit = (r: Recipe, path: string[]): void => {
    if (path.includes(r.id)) { errors.push(`cycle: ${[...path, r.id].join(" → ")}`); return; }
    for (const s of r.scans) {
      if (!isScanId(s) || !knownScans.has(s)) errors.push(`unknown scan ${JSON.stringify(s)}`); else all.add(s);
    }
    for (const inc of r.includes ?? []) {
      const child = byId.get(inc);
      if (!child) errors.push(`unknown included recipe ${JSON.stringify(inc)}`); else visit(child, [...path, r.id]);
    }
  };
  visit(recipe, []);
  if (all.size > maxScans) errors.push(`uses ${all.size} scans, the budget is ${maxScans}`);
  if (all.size === 0 && errors.length === 0) errors.push("recipe has no scans");
  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, scanCount: all.size };
}

// ── I6 ────────────────────────────────────────────────────────────────────────

export type ModerationState = "pending" | "approved" | "rejected";

/** I6: only an approved recipe is published. Moderation treats the submission as text and runs nothing. */
export function publishState(moderation: ModerationState | undefined): "published" | "unpublished" {
  return moderation === "approved" ? "published" : "unpublished";
}

// ── I7 ────────────────────────────────────────────────────────────────────────

function ipv4Blocked(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return true;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((x) => Number(x) > 255)) return true;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

/** True for any address a webhook must never reach: private, loopback, link-local, CGNAT, multicast or unparsable. */
export function addressBlocked(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (v.includes(".") && !v.includes(":")) return ipv4Blocked(v);
  if (!v.includes(":")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Blocked(mapped[1]);
  if (v === "::" || v === "::1") return true;
  const first = parseInt(v.split(":")[0] || "0", 16);
  if (!Number.isFinite(first)) return true;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** I7: https only, no credentials, standard port, a hostname that is not local, and every resolved address public.
 *  The sender must connect to one of these checked addresses and must not follow redirects (DNS rebinding). */
export function webhookTargetAllowed(url: string, resolvedAddresses: readonly string[]): { allow: true } | { allow: false; reason: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { allow: false, reason: "invalid URL" }; }
  if (u.protocol !== "https:") return { allow: false, reason: "https only" };
  if (u.username || u.password) return { allow: false, reason: "credentials in URL" };
  if (u.port && u.port !== "443") return { allow: false, reason: "non-standard port" };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return { allow: false, reason: "local hostname" };
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (addressBlocked(host)) return { allow: false, reason: "private or reserved address" };
  }
  if (resolvedAddresses.length === 0) return { allow: false, reason: "hostname did not resolve" };
  const bad = resolvedAddresses.find(addressBlocked);
  if (bad) return { allow: false, reason: `resolves to a private or reserved address (${bad})` };
  return { allow: true };
}

export const WEBHOOK_FOLLOW_REDIRECTS = false;
export const WEBHOOK_MAX_ATTEMPTS = 5;

/** I7: delay before retry `attempt` (1-based), or null once the bounded attempts are used up. */
export function webhookRetryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt >= WEBHOOK_MAX_ATTEMPTS) return null;
  return Math.min(60_000 * 2 ** (attempt - 1), 15 * 60_000);
}

// ── I8 ────────────────────────────────────────────────────────────────────────

/** I8: reserve before calling. used + pending never exceeds the cap, and the free tier never reaches a paid tool. */
export function reserveBudget(state: { used: number; pending: number }, cap: number, toolTier: "free" | "pro", callerTier: "free" | "pro"):
  { ok: true; state: { used: number; pending: number } } | { ok: false; code: "paid_tool" | "budget_exhausted" | "invalid_input" } {
  if (![state.used, state.pending, cap].every((n) => Number.isInteger(n) && n >= 0)) return { ok: false, code: "invalid_input" };
  if (toolTier === "pro" && callerTier !== "pro") return { ok: false, code: "paid_tool" };
  if (state.used + state.pending + 1 > cap) return { ok: false, code: "budget_exhausted" };
  return { ok: true, state: { used: state.used, pending: state.pending + 1 } };
}

// ── I9 ────────────────────────────────────────────────────────────────────────

export interface UsageEvent { tenant: string; request_id: string; attempt: number; tool: string }

/** I9: one tenant's totals. Requests are counted by unique request ID; retries are counted separately.
 *  Other tenants' events never enter the result. */
export function usageTotals(events: readonly UsageEvent[], tenant: string) {
  const mine = events.filter((e) => e.tenant === tenant);
  const requests = new Set(mine.map((e) => e.request_id));
  const byTool: Record<string, number> = {};
  for (const e of mine) if (e.attempt === 1) byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
  return { tenant, requests: requests.size, attempts: mine.length, retries: mine.length - requests.size, byTool };
}
