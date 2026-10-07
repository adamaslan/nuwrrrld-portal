/**
 * Leaderboard view-model: the last-run fields must come from the latest
 * `paper_runs` row, not a constant. `lastRunStatus` was hardcoded to "unknown"
 * for every account, so a seat whose runs were all failing looked identical to
 * a healthy one.
 */
import { describe, expect, it } from "vitest";
import { buildLeaderboardView, type LatestRunSummary } from "@/lib/shared/paper-view";
import type { Account } from "@/lib/paper-db";
import type { PaperAccount } from "@/lib/shared/paper-policy";

function account(name: PaperAccount): Account {
  return {
    account: name,
    seat: null,
    label: name,
    policyVersion: "v4",
    startingCash: 10_000,
    cash: 10_000,
    seededOn: "2026-09-22",
    active: true,
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
}

describe("buildLeaderboardView — last run", () => {
  it("reports the latest run's status and start time", () => {
    const runs = new Map<PaperAccount, LatestRunSummary | null>([
      ["chair", { status: "ok", startedAt: "2026-10-07T13:30:00.000Z" }],
    ]);
    const vm = buildLeaderboardView([account("chair")], new Map(), new Map(), runs);
    expect(vm.rows[0].lastRunStatus).toBe("ok");
    expect(vm.rows[0].lastRunAt).toBe("2026-10-07T13:30:00.000Z");
  });

  it("surfaces a failing run instead of masking it", () => {
    const runs = new Map<PaperAccount, LatestRunSummary | null>([
      ["quant", { status: "failed", startedAt: "2026-10-07T13:30:00.000Z" }],
    ]);
    const vm = buildLeaderboardView([account("quant")], new Map(), new Map(), runs);
    expect(vm.rows[0].lastRunStatus).toBe("failed");
  });

  it("says unknown only when there is no run at all, falling back to the account timestamp", () => {
    const vm = buildLeaderboardView([account("t1")], new Map(), new Map(), new Map([["t1", null]]));
    expect(vm.rows[0].lastRunStatus).toBe("unknown");
    expect(vm.rows[0].lastRunAt).toBe("2026-09-22T00:00:00.000Z");
  });

  it("stays backward compatible when a caller omits the runs map", () => {
    const vm = buildLeaderboardView([account("t2")], new Map(), new Map());
    expect(vm.rows[0].lastRunStatus).toBe("unknown");
  });
});

describe("dashboard navigation", () => {
  it("links the paper portfolios page from the cockpit nav and tool grid", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/dashboard/page.tsx", "utf8");
    const links = src.match(/href="\/dashboard\/council\/portfolios"/g) ?? [];
    expect(links.length).toBeGreaterThanOrEqual(2);
  });
});
