import { describe, expect, it } from "vitest";
import {
  addressBlocked, authorizeKey, connectorPageModel, publishState, reserveBudget, toolCallGate, usageTotals, validateRecipe,
  WEBHOOK_FOLLOW_REDIRECTS, WEBHOOK_MAX_ATTEMPTS, webhookRetryDelayMs, webhookTargetAllowed, type ToolSpec,
} from "@/lib/shared/se1/external";
import { EX, GC, RSI } from "./fixtures";

describe("I2: unauthenticated or non-entitled callers cannot invoke tools; limits and schema failures are explicit", () => {
  const tools: ToolSpec[] = [
    { name: "se1_list", tier: "free", params: { family: "string" }, required: [] },
    { name: "se1_dossier", tier: "pro", params: { ticker: "string" }, required: ["ticker"] },
  ];
  const pro = { id: "u1", entitled: true, tier: "pro" as const };
  it.each([
    [null, "se1_list", {}, 0, "unauthenticated"],
    [{ ...pro, entitled: false }, "se1_list", {}, 0, "not_entitled"],
    [{ ...pro, tier: "free" as const }, "se1_dossier", { ticker: "AAPL" }, 0, "not_entitled"],
    [pro, "se1_delete", {}, 0, "unknown_tool"],
    [pro, "se1_dossier", { ticker: 5 }, 0, "schema_error"],
    [pro, "se1_dossier", { ticker: "AAPL", extra: "x" }, 0, "schema_error"],
    [pro, "se1_dossier", {}, 0, "schema_error"],
    [pro, "se1_dossier", { ticker: "AAPL" }, 100, "rate_limited"],
  ])("denied: %#", (caller, tool, args, used, code) => {
    expect(toolCallGate(caller, tool, args, tools, used, 100)).toMatchObject({ allow: false, code });
  });
  it("allowed", () => {
    expect(toolCallGate(pro, "se1_dossier", { ticker: "AAPL" }, tools, 99, 100)).toEqual({ allow: true });
  });
});

describe("I3: revoked or cross-user keys fail; read-only keys cannot write", () => {
  const key = { id: "k1", owner: "u1", revoked: false, scopes: ["read" as const] };
  it("cases", () => {
    expect(authorizeKey(key, { method: "GET", resource_owner: "u1" })).toEqual({ allow: true });
    expect(authorizeKey({ ...key, revoked: true }, { method: "GET", resource_owner: "u1" })).toEqual({ allow: false, code: "revoked" });
    expect(authorizeKey(key, { method: "GET", resource_owner: "u2" })).toEqual({ allow: false, code: "cross_user" });
    expect(authorizeKey(key, { method: "POST", resource_owner: "u1" })).toEqual({ allow: false, code: "read_only" });
    expect(authorizeKey(null, { method: "GET", resource_owner: "u1" })).toEqual({ allow: false, code: "no_key" });
  });
});

describe("I4: disabled capabilities are not advertised", () => {
  it("lists only enabled, versioned capabilities", () => {
    expect(connectorPageModel([
      { name: "se1_list", enabled: true, endpoint_version: "2026-11-01" },
      { name: "se1_dossier", enabled: false, endpoint_version: "2026-11-01" },
      { name: "se1_screen", enabled: true, endpoint_version: null },
    ])).toEqual({ listed: [{ name: "se1_list", version: "2026-11-01" }], empty_message: null });
    expect(connectorPageModel([]).empty_message).toMatch(/No connector/);
  });
});

describe("I5: invalid, cyclic or over-budget recipes fail; saving does not execute", () => {
  const known = new Set([GC, EX, RSI]);
  it("valid recipe", () => {
    expect(validateRecipe({ id: "mine", scans: [GC, EX] }, known, [])).toEqual({ ok: true, scanCount: 2 });
  });
  it("unknown scans, cycles and budget", () => {
    expect(validateRecipe({ id: "mine", scans: ["se1.trend.made_up"] }, known, [])).toMatchObject({ ok: false });
    const a = { id: "a", scans: [GC], includes: ["b"] }, b = { id: "b", scans: [EX], includes: ["a"] };
    const r = validateRecipe(a, known, [b]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("|")).toMatch(/cycle: a → b → a/);
    expect(validateRecipe({ id: "big", scans: [GC, EX, RSI] }, known, [], 2)).toMatchObject({ ok: false });
  });
});

describe("I6: unapproved recipes stay unpublished", () => {
  it("only approved publishes", () => {
    expect([publishState("approved"), publishState("pending"), publishState("rejected"), publishState(undefined)])
      .toEqual(["published", "unpublished", "unpublished", "unpublished"]);
  });
});

describe("I7: private/loopback targets and redirect/DNS-rebinding escapes are blocked; retries are bounded", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "999.1.1.1", "junk"])(
    "blocked address %s", (ip) => { expect(addressBlocked(ip)).toBe(true); });
  it("public addresses pass", () => {
    expect(addressBlocked("93.184.216.34")).toBe(false);
    expect(addressBlocked("2606:4700::1111")).toBe(false);
  });
  it("URL rules", () => {
    expect(webhookTargetAllowed("https://hooks.example.com/x", ["93.184.216.34"])).toEqual({ allow: true });
    expect(webhookTargetAllowed("http://hooks.example.com/x", ["93.184.216.34"])).toMatchObject({ allow: false, reason: "https only" });
    expect(webhookTargetAllowed("https://user:pw@hooks.example.com/x", ["93.184.216.34"])).toMatchObject({ allow: false });
    expect(webhookTargetAllowed("https://hooks.example.com:8443/x", ["93.184.216.34"])).toMatchObject({ allow: false });
    expect(webhookTargetAllowed("https://localhost/x", ["127.0.0.1"])).toMatchObject({ allow: false });
    expect(webhookTargetAllowed("https://169.254.169.254/latest", [])).toMatchObject({ allow: false });
    // DNS rebinding: a public name that resolves to any private address is refused.
    expect(webhookTargetAllowed("https://rebind.example.com/x", ["93.184.216.34", "10.0.0.5"])).toMatchObject({ allow: false });
    expect(webhookTargetAllowed("https://nxdomain.example.com/x", [])).toMatchObject({ allow: false });
  });
  it("no redirects; retries stop", () => {
    expect(WEBHOOK_FOLLOW_REDIRECTS).toBe(false);
    expect(webhookRetryDelayMs(1)).toBe(60_000);
    expect(webhookRetryDelayMs(WEBHOOK_MAX_ATTEMPTS)).toBeNull();
    expect(webhookRetryDelayMs(0)).toBeNull();
  });
});

describe("I8: concurrent requests cannot exceed the budget or reach paid tools from the free tier", () => {
  it("reservations count pending calls", () => {
    let state = { used: 8, pending: 0 };
    const results = [];
    for (let i = 0; i < 4; i++) {
      const r = reserveBudget(state, 10, "free", "free");
      results.push(r.ok);
      if (r.ok) state = r.state;
    }
    expect(results).toEqual([true, true, false, false]);
    expect(reserveBudget({ used: 0, pending: 0 }, 10, "pro", "free")).toEqual({ ok: false, code: "paid_tool" });
    expect(reserveBudget({ used: -1, pending: 0 }, 10, "free", "free")).toEqual({ ok: false, code: "invalid_input" });
  });
});

describe("I9: usage reconciles to request IDs, includes retries, and never shows another tenant", () => {
  it("totals", () => {
    const r = usageTotals([
      { tenant: "t1", request_id: "r1", attempt: 1, tool: "se1_list" },
      { tenant: "t1", request_id: "r1", attempt: 2, tool: "se1_list" },
      { tenant: "t1", request_id: "r2", attempt: 1, tool: "se1_dossier" },
      { tenant: "t2", request_id: "r9", attempt: 1, tool: "se1_list" },
    ], "t1");
    expect(r).toEqual({ tenant: "t1", requests: 2, attempts: 3, retries: 1, byTool: { se1_list: 1, se1_dossier: 1 } });
    expect(JSON.stringify(r)).not.toContain("r9");
  });
});
